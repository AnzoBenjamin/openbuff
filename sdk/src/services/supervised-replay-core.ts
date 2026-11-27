import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readFile, readlink } from 'node:fs/promises'
import path from 'node:path'

import {
  freshId,
  isRecord,
  programIterator,
  sha,
  validateProgram,
  validateReply,
  type Attempt,
  type ProgramOrigin,
  type ReplayProgram,
  type ReplayProgramOutput,
  type Reply,
} from './immutable-replay-program'
import { requirePrivateReplayJournalPath } from './private-replay-journal'
import { initialProgramSeal, openProgramStore, type RawProgramEvent } from './replay-program-store'

export const SUPERVISED_REPLAY_SCOPE = 'openbuff-compiled-pure-child-v1'
export const SUPERVISED_REPLAY_FLAG = '--internal-replayable-child'
export const SUPERVISED_REPLAY_TAPE = 'supervised-replay.sqlite'

export type SupervisedReplayBinding = Readonly<{
  runId: string
  agentId: string
  userInputId: string
  jobId: string
  parentRunId: string
  rootRunId: string
  parentPid: number
  nonce: string
}>
export type SupervisedReplayAttempt = {
  journalPath: string
  program: ReplayProgram
  inputs: Record<string, string>
  binding: SupervisedReplayBinding
  mode: 'initial' | 'resume'
  signal?: AbortSignal
  afterConfirmed: (attemptCount: number) => Promise<void>
}
export type SupervisedReplayValue = Readonly<{
  runId: string
  agentId: string
  userInputId: string
  jobId: string
  outputs: Record<string, ReplayProgramOutput>
  retainedAttempts: number
  newAttempts: number
}>

/** Restrict this lane to the attested compiled executable, never a source import. */
export const isCompiledReplayHost = () =>
  process.platform === 'linux' &&
  typeof process.versions.bun === 'string' &&
  typeof import.meta.url === 'string' &&
  (import.meta.url.includes('$bunfs') || import.meta.url.includes('%24bunfs')) &&
  !/^bun(?:-[\w-]+)?$/.test(path.basename(process.execPath))

export function validatePureRecipe(program: unknown, inputs: unknown) {
  const captured = validateProgram(program, inputs)
  if (captured.program.operations.some(({ kind }) => kind !== 'clock' && kind !== 'random' && kind !== 'sha256')) {
    throw new Error('The supervised replay lane only admits clock, random and SHA-256 observations')
  }
  return captured
}

const bindingFields = ['runId', 'agentId', 'userInputId', 'jobId', 'parentRunId', 'rootRunId', 'parentPid', 'nonce'] as const
export function validateReplayBinding(raw: unknown): SupervisedReplayBinding {
  if (!isRecord(raw) || Object.keys(raw).length !== bindingFields.length || !bindingFields.every((key) => Object.hasOwn(raw, key)))
    throw new Error('Invalid supervised replay owner binding')
  const read = (key: typeof bindingFields[number]) => {
    const value = Object.getOwnPropertyDescriptor(raw, key)
    if (!value?.enumerable || !('value' in value)) throw new Error('A replay owner binding must contain plain data')
    return value.value as unknown
  }
  const stringId = (key: typeof bindingFields[number]) => {
    const value = read(key)
    if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_:-]{0,199}$/.test(value)) throw new Error('Invalid supervised replay owner ID')
    return value
  }
  const parentPid = read('parentPid')
  const nonce = stringId('nonce')
  const runId = stringId('runId')
  if (typeof parentPid !== 'number' || !Number.isSafeInteger(parentPid) || parentPid < 2 || !/^[a-f0-9]{64}$/.test(nonce) || !/^local-supervised-replay-[a-f0-9]{32}$/.test(runId))
    throw new Error('Invalid supervised replay origin')
  return Object.freeze({ runId, agentId: stringId('agentId'), userInputId: stringId('userInputId'), jobId: stringId('jobId'), parentRunId: stringId('parentRunId'), rootRunId: stringId('rootRunId'), parentPid, nonce })
}

let cachedExecutable: Promise<string> | undefined
async function compiledRuntimeBasis() {
  cachedExecutable ??= (async () => {
    const digest = createHash('sha256')
    for await (const chunk of createReadStream('/proc/self/exe')) digest.update(chunk)
    return digest.digest('hex')
  })()
  return sha(JSON.stringify({
    scope: SUPERVISED_REPLAY_SCOPE,
    executable: await cachedExecutable,
    bun: process.versions.bun,
    arch: process.arch,
    pidNamespace: await readlink('/proc/self/ns/pid'),
    boot: (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim(),
  }))
}

const observe = (attempt: Attempt): Reply => {
  switch (attempt.kind) {
    case 'clock': return new Date().getTime()
    case 'random': return freshId()
    case 'sha256': return sha(attempt.value)
    default: throw new Error('An undeclared effect cannot run in the supervised replay lane')
  }
}

function checkPrefix(driver: ReturnType<typeof programIterator>, rows: RawProgramEvent[], origin: ProgramOrigin) {
  let next = driver.next()
  for (let i = 0; i < rows.length; i += 2) {
    const request = rows[i]
    const reply = rows[i + 1]
    if (request?.kind !== 'request' || reply?.kind !== 'reply' || next.done)
      throw new Error('Supervised replay has an unconfirmed, terminal or unexpected attempt')
    const attemptId = `${origin.runId}:${i / 2}`
    if (request.payload !== JSON.stringify({ attemptId, attempt: next.value })) throw new Error('Supervised replay diverged at a retained yield')
    const data: unknown = JSON.parse(reply.payload)
    if (!isRecord(data) || Object.keys(data).length !== 2 || data.attemptId !== attemptId || !Object.hasOwn(data, 'reply'))
      throw new Error('A supervised replay reply does not belong to the original attempt')
    next = driver.next(validateReply(next.value, data.reply))
  }
  if (next.done) throw new Error('The supervised replay prefix already exhausted its iterator')
  return next
}

/** Internal worker entry. The caller first proves its live parent connection. */
export async function runSupervisedReplayAttempt(options: SupervisedReplayAttempt): Promise<SupervisedReplayValue> {
  const uid = process.geteuid?.()
  if (!isCompiledReplayHost() || uid === undefined) throw new Error('Supervised immutable replay requires a compiled Linux Bun executable')
  const binding = validateReplayBinding(options.binding)
  if (binding.parentPid !== process.ppid) throw new Error('The original replay parent is not this worker’s live parent')
  if (options.mode !== 'initial' && options.mode !== 'resume') throw new Error('Invalid supervised replay mode')
  if (!path.isAbsolute(options.journalPath) || path.basename(options.journalPath) !== SUPERVISED_REPLAY_TAPE)
    throw new Error('Supervised replay requires a private absolute tape path')
  const { program, inputs } = validatePureRecipe(options.program, options.inputs)
  const runtime = await compiledRuntimeBasis()
  options.signal?.throwIfAborted()
  const basis = sha(JSON.stringify({ scope: SUPERVISED_REPLAY_SCOPE, binding, program, inputs: Object.fromEntries(Object.entries(inputs).sort()) }))
  requirePrivateReplayJournalPath(options.journalPath, uid)
  const store = openProgramStore(options.journalPath)
  const driver = programIterator(program, inputs, 'no-model')
  let origin: ProgramOrigin = { runId: binding.runId, agentId: binding.agentId, userInputId: binding.userInputId, ownerPid: process.pid, basis }
  const resuming = options.mode === 'resume'
  let sequence = 0
  let seal = initialProgramSeal(origin, runtime)
  try {
    let next: ReturnType<typeof driver.next>
    if (resuming) {
      const claim = store.claim(binding.runId, basis, runtime, (rows, old) => {
        if (old.agentId !== binding.agentId || old.userInputId !== binding.userInputId) throw new Error('Supervised replay actor changed')
        return checkPrefix(driver, rows, old)
      })
      origin = claim.origin
      sequence = claim.eventCount
      seal = claim.tail
      next = claim.verified
    } else {
      store.begin(origin, runtime)
      next = driver.next()
    }
    const retainedAttempts = sequence / 2
    while (!next.done) {
      options.signal?.throwIfAborted()
      const attempt = next.value
      const attemptId = `${origin.runId}:${sequence / 2}`
      seal = store.append(origin, resuming, sequence++, seal, 'request', { attemptId, attempt })
      const reply = validateReply(attempt, observe(attempt))
      seal = store.append(origin, resuming, sequence++, seal, 'reply', { attemptId, reply })
      next = driver.next(reply)
      // A live parent must acknowledge this clean cut before the next effect.
      await options.afterConfirmed(sequence / 2)
    }
    options.signal?.throwIfAborted()
    store.append(origin, resuming, sequence, seal, 'terminal', { status: 'completed', outputSha256: sha(JSON.stringify(next.value)) })
    return { runId: origin.runId, agentId: origin.agentId, userInputId: origin.userInputId, jobId: binding.jobId, outputs: next.value, retainedAttempts, newAttempts: sequence / 2 - retainedAttempts }
  } finally {
    store.close()
  }
}
