import { spawn as nodeSpawn, spawnSync } from 'node:child_process'

import type { ExecutionAdapterContext, ExactLaunchInput, LaunchObserver, PreparedLaunch } from '@codebuff/common/types/contracts/execution-context'
import { raceAbort } from '../tools/concurrency'
import { refusalForSignal } from './execution-launch'
import type { CodebuffSpawn } from '@codebuff/common/types/spawn'

/** Captured host inputs, supplied by SDK composition rather than tool JSON. */
export type ToolchainExecutionContext = ExecutionAdapterContext

export class ToolchainExecutionError extends Error {
  constructor(readonly refusal: { ok: false; reason: string; cause: string }) {
    super(refusal.cause)
    this.name = 'ToolchainExecutionError'
  }
}

export function requireToolchainContext(context?: ToolchainExecutionContext): ToolchainExecutionContext {
  if (!context) throw new ToolchainExecutionError({ ok: false, reason: 'unavailable', cause: 'Toolchain execution context is unavailable.' })
  return context
}

export function prepareToolchainLaunch(p: {
  context?: ToolchainExecutionContext
  branchId: string
  argv: readonly string[]
  cwd: string
  timeoutMs: number
  sync?: boolean
  maxBufferBytes?: number
}): PreparedLaunch {
  const context = requireToolchainContext(p.context)
  if (context.signal?.aborted) throw new ToolchainExecutionError(refusalForSignal(context.signal))
  const derived = context.execution.derive({ memoKey: p.branchId, limit: { kind: 'finite', durationMs: p.timeoutMs } })
  if (!derived.ok) throw new ToolchainExecutionError(derived)
  const prepared = derived.value.prepareTarget({ target: {
    executable: p.argv[0], argv: p.argv.slice(1), cwd: p.cwd,
    projectRoot: context.projectRoot, allowedPaths: context.allowedPaths,
    mode: context.mode, processType: 'SYNC', profile: context.profile,
    family: 'diagnostic-build-version-scip', branchId: p.branchId,
    adapterOptions: { runtime: p.sync ? 'spawn-sync' : 'node', stdio: 'ignore,pipe,pipe', maxBufferBytes: p.maxBufferBytes ?? null },
  } })
  if (!prepared.ok) throw new ToolchainExecutionError(prepared)
  return prepared.value
}

export function observeNodeChild(child: ReturnType<CodebuffSpawn>, observer: LaunchObserver): void {
  child.once('spawn', () => {
    if (Number.isInteger(child.pid) && (child.pid ?? 0) > 0) {
      observer.spawnObserved({ source: 'node-spawn-event', pid: child.pid! })
    } else {
      observer.failure({ source: 'adapter-observation-error', cause: 'Node spawn event has no valid process PID.' })
    }
  })
  child.on('error', (error: NodeJS.ErrnoException) => {
    observer.failure({ source: 'node-error-event', errorCode: error.code, cause: error.message })
  })
}

/** Attach consumer listeners in the dispatch turn, before Node can emit error. */
export async function withToolchainChild<T>(p: Parameters<typeof prepareToolchainLaunch>[0], consume: (child: ReturnType<CodebuffSpawn>, input: ExactLaunchInput) => T): Promise<Awaited<T>> {
  const spawn = p.context?.spawn ?? ((command, args, options) => nodeSpawn(command, args ?? [], options ?? {})) as CodebuffSpawn
  const signal = p.context?.signal
  if (signal?.aborted) throw new ToolchainExecutionError(refusalForSignal(signal))
  try {
    const launch = prepareToolchainLaunch(p)
    const admission = await raceAbort(launch.admit(), signal)
    if (!admission.ok) throw new ToolchainExecutionError(admission)
    if (signal?.aborted) throw new ToolchainExecutionError(refusalForSignal(signal))
    const dispatched = launch.dispatchNow(admission.value.permit, (input, observer) => {
      const child = spawn(input.executable, input.argv, {
        cwd: input.cwd, env: input.env, signal: input.resourceSignal,
        ...(input.resourceRemainingMs === null ? {} : { timeout: Math.max(1, Math.ceil(input.resourceRemainingMs)) }),
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      observeNodeChild(child, observer)
      return { result: consume(child, input) }
    })
    if (!dispatched.ok) throw new ToolchainExecutionError(dispatched)
    return await raceAbort(Promise.resolve(dispatched.value.handle.result), signal)
  } catch (error) {
    if (signal?.aborted && !(error instanceof ToolchainExecutionError)) {
      throw new ToolchainExecutionError(refusalForSignal(signal))
    }
    throw error
  }
}

export function runToolchainSync(p: Parameters<typeof prepareToolchainLaunch>[0]): {
  exitCode: number; stdout: string; stderr: string
} {
  const launch = prepareToolchainLaunch({ ...p, sync: true })
  const admission = launch.admitSync()
  if (!admission.ok) throw new ToolchainExecutionError(admission)
  const dispatched = launch.dispatchNow(admission.value.permit, (input, observer) => {
    const result = spawnSync(input.executable, input.argv, {
      cwd: input.cwd, env: input.env, encoding: 'utf8',
      ...(input.resourceRemainingMs === null ? {} : { timeout: Math.max(1, Math.ceil(input.resourceRemainingMs)) }),
      maxBuffer: typeof input.adapterOptions.maxBufferBytes === 'number' ? input.adapterOptions.maxBufferBytes : undefined, stdio: ['ignore', 'pipe', 'pipe'],
    })
    if (Number.isInteger(result.pid) && result.pid > 0) observer.spawnObserved({ source: 'spawn-sync-result', pid: result.pid })
    if (result.error) observer.failure({ source: 'spawn-sync-error', errorCode: (result.error as NodeJS.ErrnoException).code, cause: result.error.message })
    return result
  })
  if (!dispatched.ok) throw new ToolchainExecutionError(dispatched)
  const result = dispatched.value.handle
  return { exitCode: typeof result.status === 'number' ? result.status : 1,
    stdout: result.stdout ?? '', stderr: result.error ? `${result.stderr ?? ''}${result.error.message}` : result.stderr ?? '' }
}

export async function runToolchainNode(p: Parameters<typeof prepareToolchainLaunch>[0] & { maxBufferBytes: number }): Promise<{
  exitCode: number; stdout: string; stderr: string
}> {
  return withToolchainChild(p, (child, input) => new Promise<{ exitCode: number; stdout: string; stderr: string }>((resolve) => {
    let settled = false
    const stdout: Buffer[] = [], stderr: Buffer[] = []
    let retained = 0
    const maxBufferBytes = input.adapterOptions.maxBufferBytes as number
    const collect = (target: Buffer[], chunk: Buffer | string) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      const take = Math.min(bytes.length, maxBufferBytes - retained)
      if (take > 0) { target.push(Buffer.from(bytes.subarray(0, take))); retained += take }
    }
    const finish = (exitCode: number, error?: string) => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      input.resourceSignal.removeEventListener('abort', onAbort)
      resolve({ exitCode, stdout: Buffer.concat(stdout).toString(), stderr: error ?? Buffer.concat(stderr).toString() })
    }
    const onAbort = () => finish(-1, 'Toolchain resource cancelled.')
    const timer = input.resourceRemainingMs === null ? undefined : setTimeout(() => finish(-1, 'Toolchain resource deadline exhausted.'), Math.max(1, Math.ceil(input.resourceRemainingMs)))
    input.resourceSignal.addEventListener('abort', onAbort, { once: true })
    child.stdout?.on('data', (chunk) => collect(stdout, chunk))
    child.stderr?.on('data', (chunk) => collect(stderr, chunk))
    child.on('error', (error) => finish(-1, error.message))
    child.on('close', (code) => finish(code ?? -1))
    if (input.resourceSignal.aborted) onAbort()
  }))
}
