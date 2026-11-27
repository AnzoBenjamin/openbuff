import { createHmac } from 'node:crypto'
import { types } from 'node:util'
import { readFile, readlink } from 'node:fs/promises'
import path from 'node:path'

import { requirePrivateReplayJournalPath } from './private-replay-journal'
import {
  initialProgramSeal,
  openProgramStore,
  type EventKind,
  type RawProgramEvent,
} from './replay-program-store'
import {
  type Attempt,
  type ProgramOrigin,
  type Reply,
  type ReplayProgramRequest,
  type ReplayProgramResult,
  freshId,
  isRecord,
  plainMember,
  programIterator,
  sha,
  validateModel,
  validateProgram,
  validateReply,
} from './immutable-replay-program'

const protocol = 'openbuff-immutable-program-v1/openai-compatible-json-v1'
const modelResponseLimit = 128 * 1024
const maxAttemptMs = 60_000
// Only the SDK build can attest the finite closure it actually loaded.
// A raw checkout cannot verify an earlier loader cache or hot-updated imports.
const embeddedReplayBuildIdentity = undefined
const moduleIdentity: string | undefined = embeddedReplayBuildIdentity
const abortedGetter = Object.getOwnPropertyDescriptor(
  AbortSignal.prototype,
  'aborted',
)!.get!
const assertNotAborted = (signal: AbortSignal) => {
  if (abortedGetter.call(signal))
    throw new DOMException('Replay was cancelled', 'AbortError')
}
let executableDigest: Promise<string> | undefined

async function runtimeHash() {
  if (!moduleIdentity)
    throw new Error(
      'Immutable replay requires a built SDK with a verified build identity',
    )
  // Bind the loaded code as well as its build closure, so swapping underlying
  // source files cannot make the old iterator match a new suffix implementation.
  const loaded = [
    programIterator,
    reconstruct,
    execute,
    validateProgram,
    validateModel,
    validateReply,
    openProgramStore,
    requirePrivateReplayJournalPath,
    runReplayableProgram,
  ].map((fn) => Function.prototype.toString.call(fn))
  executableDigest ??= readFile('/proc/self/exe').then(sha)
  return sha(
    JSON.stringify({
      protocol,
      moduleIdentity,
      loaded,
      exe: await executableDigest,
      engine: process.versions.bun,
      arch: process.arch,
      pidNamespace: await readlink('/proc/self/ns/pid'),
      boot: (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim(),
    }),
  )
}

type Driver = ReturnType<typeof programIterator>
function reconstruct(
  driver: Driver,
  rows: RawProgramEvent[],
  origin: ProgramOrigin,
) {
  let next = driver.next()
  for (let i = 0; i < rows.length; i += 2) {
    const request = rows[i]
    const reply = rows[i + 1]
    if (request?.kind !== 'request' || reply?.kind !== 'reply' || next.done)
      throw new Error(
        'The retained program has an unconfirmed, terminal, or unexpected attempt',
      )
    const attemptId = `${origin.runId}:${i / 2}`
    if (request.payload !== JSON.stringify({ attemptId, attempt: next.value }))
      throw new Error('The immutable program diverged at a retained yield')
    const payload = JSON.parse(reply.payload)
    if (
      !isRecord(payload) ||
      Object.keys(payload).length !== 2 ||
      payload.attemptId !== attemptId ||
      !Object.hasOwn(payload, 'reply')
    )
      throw new Error('A retained reply does not match its exact attempt')
    next = driver.next(validateReply(next.value, payload.reply))
  }
  return next
}

async function readModelBody(response: Response) {
  const reader = response.body?.getReader()
  if (!reader) throw new Error('The model response did not include a body')
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let result = ''
  let bytes = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) return JSON.parse(result + decoder.decode()) as unknown
      bytes += value.byteLength
      if (bytes > modelResponseLimit)
        throw new Error('The model response exceeds the replay byte bound')
      result += decoder.decode(value, { stream: true })
    }
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}
async function execute(
  attempt: Attempt,
  model: ReturnType<typeof validateModel>,
  signal: AbortSignal,
): Promise<Reply> {
  assertNotAborted(signal)
  if (attempt.kind === 'clock') return new Date().getTime()
  if (attempt.kind === 'random') return freshId()
  if (attempt.kind === 'sha256') return sha(attempt.value)
  if (attempt.kind !== 'model') throw new Error('Unsupported replay effect')
  // One request per durable intent. No SDK retry, redirect, model tools, or
  // fallback can cause an unrecorded second dispatch. The embedder explicitly
  // selected this route and its optional BYOK credential.
  const response = await fetch(model.endpoint, {
    method: 'POST',
    redirect: 'error',
    signal: AbortSignal.any([signal, AbortSignal.timeout(maxAttemptMs)]),
    headers: {
      'content-type': 'application/json',
      ...(model.apiKey ? { authorization: `Bearer ${model.apiKey}` } : {}),
    },
    body: JSON.stringify(attempt.body),
  })
  if (!response.ok) {
    await response.body?.cancel().catch(() => {})
    throw new Error(
      `Model request ended with HTTP ${response.status}; the attempt remains unconfirmed`,
    )
  }
  const wire = await readModelBody(response)
  if (
    !isRecord(wire) ||
    !Array.isArray(wire.choices) ||
    wire.choices.length !== attempt.body.n
  )
    throw new Error('The model did not return the selected number of replies')
  const choices = new Map<number, { text: string; finish: 'stop' | 'length' }>()
  for (const choice of wire.choices as unknown[]) {
    if (
      !isRecord(choice) ||
      typeof choice.index !== 'number' ||
      !Number.isSafeInteger(choice.index) ||
      choice.index < 0 ||
      choice.index >= attempt.body.n ||
      choices.has(choice.index) ||
      !isRecord(choice.message) ||
      choice.message.role !== 'assistant' ||
      typeof choice.message.content !== 'string' ||
      choice.message.tool_calls != null ||
      choice.message.function_call != null ||
      (choice.finish_reason !== 'stop' && choice.finish_reason !== 'length')
    )
      throw new Error(
        'The model response is not a complete text-only choice set',
      )
    choices.set(choice.index, {
      text: choice.message.content,
      finish: choice.finish_reason,
    })
  }
  return validateReply(
    attempt,
    Array.from({ length: attempt.body.n }, (_, i) => choices.get(i)),
  )
}

/** Run a versioned immutable recipe or spend a one-shot claim to resume its exact retained prefix. */
export async function runReplayableProgram(
  options: ReplayProgramRequest,
): Promise<ReplayProgramResult> {
  let runId: string | undefined
  let signal: AbortSignal | undefined
  let soughtResume = false
  let admitted = false
  let store: ReturnType<typeof openProgramStore> | undefined
  try {
    const uid = process.geteuid?.()
    if (
      process.platform !== 'linux' ||
      !process.versions.bun ||
      uid === undefined
    )
      throw new Error(
        'Immutable replay requires Linux/Bun and private persistent storage',
      )
    if (!isRecord(options))
      throw new Error('Immutable replay requires a plain request')
    soughtResume = Object.hasOwn(options, 'resumeRunId')
    const names = [
      'journalPath',
      'program',
      'inputs',
      'model',
      'resumeRunId',
      'pauseAfter',
      'signal',
    ]
    const provided = Object.fromEntries(
      Reflect.ownKeys(options).map((key) => {
        if (typeof key !== 'string' || !names.includes(key))
          throw new Error('Unsupported live module or replay dependency')
        return [key, plainMember(options, key)]
      }),
    )
    if (
      soughtResume &&
      (typeof provided.resumeRunId !== 'string' ||
        !/^local-program-[a-f0-9]{32}$/.test(provided.resumeRunId))
    )
      throw new Error('Invalid original program run ID')
    runId = provided.resumeRunId as string | undefined
    const { program, inputs } = validateProgram(
      provided.program,
      provided.inputs,
    )
    const model = validateModel(provided.model)
    if (provided.signal !== undefined) {
      // Intrinsic brand check; caller-owned getters, methods, and prototype
      // traps cannot establish that the signal is a platform instance.
      if (types.isProxy(provided.signal))
        throw new Error('Expected an AbortSignal')
      try {
        abortedGetter.call(provided.signal)
      } catch {
        throw new Error('Expected an AbortSignal')
      }
    }
    signal =
      (provided.signal as AbortSignal | undefined) ??
      new AbortController().signal
    const { pauseAfter } = provided
    if (
      pauseAfter !== undefined &&
      (!program.operations.some(({ id }) => id === pauseAfter) ||
        pauseAfter === program.operations.at(-1)?.id)
    )
      throw new Error('Select a non-final operation for a pause')
    if (
      typeof provided.journalPath !== 'string' ||
      !path.isAbsolute(provided.journalPath)
    )
      throw new Error('Use an absolute private program journal path')
    assertNotAborted(signal)
    const runtime = await runtimeHash()
    const basisInput = JSON.stringify({
      protocol,
      program,
      inputs: Object.fromEntries(
        Object.entries(inputs).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
      ),
      endpoint: model.endpoint,
      model: model.name,
    })
    // The credential is not serialized or placed in the journal. Keyed basis
    // also prevents redispatch under a different account via a caller override.
    const basis = model.apiKey
      ? createHmac('sha256', model.apiKey).update(basisInput).digest('hex')
      : sha(basisInput)
    assertNotAborted(signal)
    const journalPath = path.resolve(provided.journalPath)
    requirePrivateReplayJournalPath(journalPath, uid)
    store = openProgramStore(journalPath)
    const driver = programIterator(program, inputs, model.name)
    let origin: ProgramOrigin
    let seq: number
    let tail: string
    let next: ReturnType<Driver['next']>
    if (runId) {
      const wantedRun = runId
      const claim = store.claim(
        wantedRun,
        basis,
        runtime,
        (rows, originalOrigin) => reconstruct(driver, rows, originalOrigin),
      )
      ;({ origin, eventCount: seq, tail, verified: next } = claim)
    } else {
      runId = `local-program-${freshId()}`
      origin = {
        runId,
        agentId: `program-actor-${freshId()}`,
        userInputId: `program-input-${freshId()}`,
        ownerPid: process.pid,
        basis,
      }
      store.begin(origin, runtime)
      seq = 0
      tail = initialProgramSeal(origin, runtime)
      next = driver.next()
    }
    admitted = true
    const retainedAttempts = seq / 2
    const append = (kind: EventKind, value: unknown) => {
      tail = store!.append(origin, soughtResume, seq, tail, kind, value)
      seq++
    }
    const identities = {
      runId,
      agentId: origin.agentId,
      userInputId: origin.userInputId,
    }
    while (!next.done) {
      assertNotAborted(signal)
      const effect = next.value
      const attemptId = `${runId}:${seq / 2}`
      append('request', { attemptId, attempt: effect })
      const reply = validateReply(effect, await execute(effect, model, signal))
      assertNotAborted(signal)
      append('reply', { attemptId, reply })
      next = driver.next(reply)
      if (!next.done && effect.id === pauseAfter && next.value.id !== effect.id)
        return {
          status: 'paused',
          ...identities,
          outputs: {},
          retainedAttempts,
          newAttempts: seq / 2 - retainedAttempts,
        }
    }
    // Outputs can be reconstructed from the reply rows; don't duplicate a
    // potentially large output in the bounded terminal acknowledgement.
    append('terminal', {
      status: 'completed',
      outputSha256: sha(JSON.stringify(next.value)),
    })
    return {
      status: 'completed',
      ...identities,
      outputs: next.value,
      retainedAttempts,
      newAttempts: (seq - 1) / 2 - retainedAttempts,
    }
  } catch (error) {
    const reason =
      error instanceof Error ? error.message : 'Immutable replay failed'
    return {
      status:
        signal && abortedGetter.call(signal)
          ? 'cancelled'
          : soughtResume && !admitted
            ? 'replay_unavailable'
            : 'failed',
      reason,
      ...(runId ? { runId } : {}),
    }
  } finally {
    store?.close()
  }
}
