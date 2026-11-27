import { connect, createServer, type Socket } from 'node:net'
import { constants, closeSync, fstatSync, lstatSync, openSync, readSync, unlinkSync, writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { randomBytes } from 'node:crypto'

import { spawnSettledSubagent } from '@codebuff/agent-runtime/supervision/process-supervisor'
import { agentReceiptSchema, type AgentReceipt } from '@codebuff/common/types/agent-handoff'
import type { CleanupResult } from '@codebuff/common/types/contracts/process-scope'

import { freshId, isRecord, type ReplayProgram } from './immutable-replay-program'
import {
  isCompiledReplayHost,
  runSupervisedReplayAttempt,
  SUPERVISED_REPLAY_FLAG,
  SUPERVISED_REPLAY_TAPE,
  validatePureRecipe,
  validateReplayBinding,
  type SupervisedReplayBinding,
  type SupervisedReplayValue,
} from './supervised-replay-core'

const maxLineBytes = 256 * 1024
const ticketName = 'worker.json'
const socketName = 'control.sock'
type Generation = 'initial' | 'resume'
type Recipe = ReturnType<typeof validatePureRecipe>
type Identity = Omit<SupervisedReplayBinding, 'parentPid' | 'nonce'>
export type SupervisedReplayBoundary = Readonly<{
  generation: Generation
  pid: number
  confirmedAttempts: number
  runId: string
  jobId: string
}>
export type SupervisedProgramOptions = Readonly<{
  program: ReplayProgram
  inputs: Record<string, string>
  parentRunId: string
  rootRunId: string
  signal?: AbortSignal
  /** Total time for this job, including the first launch and one successor. */
  timeoutMs?: number
  /** Trusted host acknowledgement. Not serialized or visible inside the immutable program. */
  onBoundary?: (boundary: SupervisedReplayBoundary) => void | Promise<void>
}>
export type SupervisedProgramResult =
  | { status: 'completed'; job: Identity; tapePath: string; value: SupervisedReplayValue; cleanup: readonly CleanupResult[] }
  | { status: 'failed' | 'cancelled' | 'replay_unavailable' | 'recovery_required'; reason: string; job?: Identity; tapePath?: string; cleanup: readonly CleanupResult[] }

function channel(socket: Socket) {
  // Awaitable reads do not allow a disconnected peer to leave a silent wait.
  const rows = (async function* () {
    let pending = Buffer.alloc(0)
    for await (const raw of socket) {
      const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw)
      if (pending.length + chunk.length > maxLineBytes) throw new Error('Invalid replay worker frame')
      pending = Buffer.concat([pending, chunk])
      for (let index = pending.indexOf(0x0a); index >= 0; index = pending.indexOf(0x0a)) {
        const line = pending.subarray(0, index)
        pending = pending.subarray(index + 1)
        yield JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(line)) as unknown
      }
    }
  })()
  return {
    async receive(): Promise<Record<string, unknown>> {
      const row = await rows.next()
      if (row.done || !isRecord(row.value)) throw new Error('The replay control channel is closed or invalid')
      return row.value
    },
    async send(value: unknown) {
      const text = JSON.stringify(value) + '\n'
      if (Buffer.byteLength(text) > maxLineBytes || socket.destroyed) throw new Error('Invalid replay worker frame')
      await new Promise<void>((resolve, reject) => socket.write(text, (error) => error ? reject(error) : resolve()))
    },
  }
}

function publicBinding(binding: SupervisedReplayBinding): Identity {
  const { nonce: _nonce, parentPid: _parent, ...identity } = binding
  return identity
}

function makeReceipt(binding: SupervisedReplayBinding, generation: Generation, value?: SupervisedReplayValue): AgentReceipt {
  return agentReceiptSchema.parse({
    schemaVersion: 1,
    receiptId: `${binding.runId}:${generation}`,
    taskId: binding.jobId,
    role: 'general',
    agentId: binding.agentId,
    status: value ? 'completed' : 'failed',
    runOutcome: value ? { termination: 'completed' } : { termination: 'failed', cause: { code: 'replay_unavailable', message: 'The immutable child could not safely continue.' } },
    changedFiles: [], requirementsAddressed: [], acceptanceCriteriaAddressed: [], findingsAddressed: [],
    evidence: [], assumptions: [], unresolved: [], requestedValidation: [], artifacts: [], errors: [],
    ...(value ? { output: value } : {}),
  })
}

function readWorkerTicket(
  file: string,
  uid: number,
): { directory: string; mode: Generation; nonce: string } {
  if (!path.isAbsolute(file) || path.basename(file) !== ticketName)
    throw new Error('Expected a private replay ticket')
  const directory = path.dirname(file)
  const owner = lstatSync(directory)
  if (!owner.isDirectory() || owner.uid !== uid || (owner.mode & 0o077) !== 0)
    throw new Error('Expected an owner-private replay directory')
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const info = fstatSync(fd)
    if (!info.isFile() || info.uid !== uid || info.nlink !== 1 || info.size > 4096 || (info.mode & 0o077) !== 0)
      throw new Error('Expected an owner-private replay ticket')
    const bytes = Buffer.alloc(4097)
    const size = readSync(fd, bytes)
    if (size !== info.size) throw new Error('The replay ticket changed')
    const value: unknown = JSON.parse(bytes.subarray(0, size).toString('utf8'))
    if (!isRecord(value) || Object.keys(value).length !== 3 || value.parentPid !== process.ppid ||
        (value.mode !== 'initial' && value.mode !== 'resume') || typeof value.nonce !== 'string' || !/^[a-f0-9]{64}$/.test(value.nonce))
      throw new Error('Invalid replay ticket')
    return { directory, mode: value.mode, nonce: value.nonce }
  } finally { closeSync(fd) }
}

/** Embedder/CLI self-exec hook. Handles only the reserved first-argument worker mode. */
export async function handleSupervisedReplayWorker(argv: readonly string[]): Promise<number | undefined> {
  if (argv[2] !== SUPERVISED_REPLAY_FLAG) return undefined
  const uid = process.geteuid?.()
  if (argv.length !== 4 || !isCompiledReplayHost() || uid === undefined) return 1
  let socket: Socket | undefined
  try {
    const ticket = readWorkerTicket(argv[3]!, uid)
    const abort = new AbortController()
    socket = connect(path.join(ticket.directory, socketName))
    socket.on('error', () => abort.abort())
    socket.once('close', () => abort.abort())
    const ipc = channel(socket)
    await ipc.send({ kind: 'ready', nonce: ticket.nonce, pid: process.pid, mode: ticket.mode })
    const begin = await ipc.receive()
    const binding = validateReplayBinding(begin.binding)
    if (begin.kind !== 'begin' || binding.parentPid !== process.ppid || binding.nonce !== ticket.nonce) return 1
    let value: SupervisedReplayValue | undefined
    try {
      value = await runSupervisedReplayAttempt({
        journalPath: path.join(ticket.directory, SUPERVISED_REPLAY_TAPE),
        ...validatePureRecipe(begin.program, begin.inputs),
        binding,
        mode: ticket.mode,
        signal: abort.signal,
        async afterConfirmed(confirmed) {
          await ipc.send({ kind: 'confirmed', confirmed })
          const response = await ipc.receive()
          if (response.kind !== 'ack' || response.confirmed !== confirmed) throw new Error('The live parent did not acknowledge the replay boundary')
        },
      })
    } catch {
      // Failure receipts never echo program inputs, tape contents or credentials.
    }
    console.log(JSON.stringify(makeReceipt(binding, ticket.mode, value)))
    return 0
  } catch {
    return 1
  } finally { socket?.destroy() }
}

function verifyFinal(
  receipt: AgentReceipt | undefined,
  binding: SupervisedReplayBinding,
  generation: Generation,
  recipe: Recipe,
  confirmed: number,
): SupervisedReplayValue | undefined {
  const v = receipt?.output
  if (!isRecord(v) || receipt?.status !== 'completed' || receipt.runOutcome?.termination !== 'completed' ||
      receipt.agentId !== binding.agentId || receipt.taskId !== binding.jobId || receipt.receiptId !== `${binding.runId}:${generation}` ||
      v.runId !== binding.runId || v.agentId !== binding.agentId || v.userInputId !== binding.userInputId || v.jobId !== binding.jobId ||
      !isRecord(v.outputs) || !Number.isSafeInteger(v.retainedAttempts) || !Number.isSafeInteger(v.newAttempts)) return undefined
  const retained = v.retainedAttempts as number
  const fresh = v.newAttempts as number
  const ops = recipe.program.operations
  if (retained < 0 || fresh < 1 || retained + fresh !== ops.length || confirmed !== ops.length ||
      (generation === 'initial' ? retained !== 0 : retained === 0) || Object.keys(v.outputs).length !== ops.length ||
      !ops.every(({ id, kind }) => Object.hasOwn(v.outputs as object, id) && (kind === 'clock' ?
        typeof (v.outputs as Record<string, unknown>)[id] === 'number' : typeof (v.outputs as Record<string, unknown>)[id] === 'string'))) return undefined
  return v as unknown as SupervisedReplayValue
}

/** Run an explicit immutable child in a compiled SDK host. Only a verified prefix can start a successor. */
export async function runSupervisedReplayableProgram(options: SupervisedProgramOptions): Promise<SupervisedProgramResult> {
  const cleanup: CleanupResult[] = []
  let job: Identity | undefined
  let tapePath: string | undefined
  let signal = options.signal
  const fail = (status: Exclude<SupervisedProgramResult['status'], 'completed'>, reason: string): SupervisedProgramResult =>
    ({ status, reason, ...(job ? { job } : {}), ...(tapePath ? { tapePath } : {}), cleanup })
  if (!isCompiledReplayHost()) return fail('replay_unavailable', 'A compiled Linux/Bun self-exec host is required.')
  try {
    options.signal?.throwIfAborted()
    const recipe = validatePureRecipe(options.program, options.inputs)
    const binding = validateReplayBinding({
      runId: `local-supervised-replay-${freshId()}`, agentId: `program-actor-${freshId()}`,
      userInputId: `program-input-${freshId()}`, jobId: `program-job-${freshId()}`,
      parentRunId: options.parentRunId, rootRunId: options.rootRunId, parentPid: process.pid,
      nonce: randomBytes(32).toString('hex'),
    })
    const timeout = options.timeoutMs ?? 30_000
    if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 120_000) return fail('failed', 'Invalid total replay deadline.')
    const timeoutSignal = AbortSignal.timeout(timeout)
    signal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal
    const ownerSignal = signal
    job = publicBinding(binding)
    const dir = mkdtempSync(path.join(tmpdir(), 'ob-replay-'))
    tapePath = path.join(dir, SUPERVISED_REPLAY_TAPE)
    const ticket = path.join(dir, ticketName)
    const socketPath = path.join(dir, socketName)
    let confirmed = 0
    for (const generation of ['initial', 'resume'] as const) {
      if (signal.aborted) return fail('cancelled', 'The replay owner cancelled or reached its deadline.')
      writeFileSync(ticket, JSON.stringify({ nonce: binding.nonce, parentPid: process.pid, mode: generation }), { mode: 0o600, flag: 'wx' })
      let current: Socket | undefined
      let controlFailure = false
      const server = createServer((socket) => {
        socket.on('error', () => {}) // the connection task owns protocol error handling
        if (current) { socket.destroy(); return }
        current = socket
        const ipc = channel(socket)
        void (async () => {
          const hello = await ipc.receive()
          if (hello.kind !== 'ready' || hello.nonce !== binding.nonce || hello.mode !== generation ||
              typeof hello.pid !== 'number' || !Number.isSafeInteger(hello.pid) || hello.pid < 2)
            throw new Error('Replay worker authentication failed')
          const pid = hello.pid
          await ipc.send({ kind: 'begin', binding, ...recipe })
          while (!ownerSignal.aborted && confirmed < recipe.program.operations.length) {
            const row = await ipc.receive()
            if (row.kind !== 'confirmed' || typeof row.confirmed !== 'number' || !Number.isSafeInteger(row.confirmed) ||
                row.confirmed <= confirmed || row.confirmed > recipe.program.operations.length)
              throw new Error('Unexpected replay worker confirmation')
            confirmed = row.confirmed
            try {
              await options.onBoundary?.(Object.freeze({ generation, pid, confirmedAttempts: confirmed, runId: binding.runId, jobId: binding.jobId }))
            } catch { controlFailure = true; socket.destroy(); return }
            if (ownerSignal.aborted) return
            await ipc.send({ kind: 'ack', confirmed })
          }
        })().catch(() => socket.destroy())
      })
      let result: Awaited<ReturnType<typeof spawnSettledSubagent>>
      try {
        await new Promise<void>((resolve, reject) => {
          server.once('error', reject)
          server.listen(socketPath, resolve)
        })
        signal.throwIfAborted()
        result = await spawnSettledSubagent({
          childModulePath: process.execPath,
          cmdOverride: [process.execPath, SUPERVISED_REPLAY_FLAG, ticket],
          cwd: dir, env: {}, signal,
        })
      } finally {
        current?.destroy()
        await new Promise<void>((resolve) => server.close(() => resolve()))
        unlinkSync(ticket)
      }
      if (result.cleanup) cleanup.push(result.cleanup)
      if (result.cleanup && result.cleanup.status !== 'complete')
        return fail('recovery_required', 'The previous child’s physical cleanup was not verified.')
      if (signal.aborted) return fail('cancelled', 'The replay owner cancelled or reached its deadline.')
      if (controlFailure) return fail('failed', 'The host did not acknowledge a durable child boundary.')
      if (result.outcome === 'ok' && result.cleanup?.status === 'complete') {
        const value = verifyFinal(result.receipt, binding, generation, recipe, confirmed)
        if (value) return { status: 'completed', job, tapePath, value, cleanup }
        return fail(generation === 'resume' ? 'replay_unavailable' : 'failed', 'The child returned no confirmed final state.')
      }
      // A missing/uncertain receipt is not a reason to rerun the initial work.
      // Only a reaped first child that reported a durable cut can enter the
      // successor, which independently verifies and consumes its tape claim.
      if (generation === 'resume' || result.cleanup?.status !== 'complete' ||
          result.cleanup.finalObservation.leader !== 'exited-reaped' || result.crashReason !== 'nonzero_exit' || confirmed === 0)
        return fail('replay_unavailable', 'No verified previous child and durable prefix are available.')
    }
    return fail('replay_unavailable', 'The one-shot child continuation is no longer available.')
  } catch {
    return signal?.aborted
      ? fail('cancelled', 'The replay owner cancelled or reached its deadline.')
      : fail('failed', 'The supervised replay job could not be admitted or joined.')
  }
}
