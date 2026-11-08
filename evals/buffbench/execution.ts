import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import type { ChildProcess, SpawnOptions } from 'node:child_process'
import type { ExecutionAdapterContext } from '@codebuff/common/types/contracts/execution-context'
import { createDirectHostExecution } from '../../sdk/src/host-execution'

export type EvaluationCommandOptions = SpawnOptions & {
  execution?: ExecutionAdapterContext
  /** Supplemental evaluator identity; never counted as a primary B19 branch. */
  branchId: string
  shellExecutable?: string
}

/** The evaluator host expressly selects its benchmark commands and workspace. */
export function createEvaluationExecution(options: {
  cwd: string
  env?: Readonly<Record<string, string | undefined>>
  inheritEnv?: boolean
  signal?: AbortSignal
  durationMs?: number
}): ExecutionAdapterContext {
  const captured = createDirectHostExecution({
    ...options,
    limit:
      options.durationMs === undefined
        ? { kind: 'unbounded' }
        : { kind: 'finite', durationMs: options.durationMs },
    profile: {
      policy: 'full-access',
      preferredBackend: 'portable-ts',
      required: ['exact-env'],
      allowBackendFallback: false,
    },
    approvalMode: 'allow-all',
  })
  if (!captured.ok) throw refusal(captured)
  return captured.value.executionContext
}

/**
 * Await admission first, then return a synchronous, single-use dispatch. The
 * caller attaches output/close listeners in the same stack as actual spawn.
 */
export async function prepareEvaluationCommand(
  command: string,
  args: readonly string[],
  options: EvaluationCommandOptions,
): Promise<() => ChildProcess> {
  const { execution, branchId, shellExecutable, ...spawnOptions } = options
  if (!execution) return () => spawn(command, args, spawnOptions)
  const shell = options.shell
    ? (shellExecutable ??
      (process.platform === 'win32' ? undefined : '/bin/sh'))
    : undefined
  if (options.shell && !shell)
    throw new Error(
      'Evaluator shell execution requires a captured shell executable on this platform',
    )
  const executable = shell ?? command
  if (shell && args.length)
    throw new Error(
      'Evaluator shell commands must provide exact raw command bytes',
    )
  const argv = shell
    ? process.platform === 'win32'
      ? ['/d', '/s', '/c', command]
      : ['-c', command]
    : [...args]
  const rawStdio = spawnOptions.stdio ?? 'pipe'
  if (
    Array.isArray(rawStdio) &&
    rawStdio.some((entry) => entry !== null && typeof entry === 'object')
  )
    throw new Error(
      'Evaluator mediation requires explicit stdio modes or file descriptors',
    )
  const stdio = Array.isArray(rawStdio) ? [...rawStdio] : rawStdio
  const detached = options.detached === true
  const windowsHide = options.windowsHide === true
  const prepared = execution.execution.prepareTarget({
    target: {
      executable,
      argv,
      ...(shell ? { shellCommandBytes: command } : {}),
      cwd:
        typeof options.cwd === 'string' ? options.cwd : execution.projectRoot,
      projectRoot: execution.projectRoot,
      allowedPaths: execution.allowedPaths,
      mode: execution.mode,
      processType: 'SYNC',
      profile: execution.profile,
      family: 'sync-shell',
      branchId,
      environmentOverlay: options.env,
      adapterOptions: {
        runtime: 'node',
        shell: false,
        stdio: JSON.stringify(stdio),
        detached,
        windowsHide,
      },
    },
  })
  if (!prepared.ok) throw refusal(prepared)
  const admitted = await prepared.value.admit()
  if (!admitted.ok) throw refusal(admitted)
  return () => {
    const dispatched = prepared.value.dispatchNow(
      admitted.value.permit,
      (input, observer) => {
        const child = (execution.spawn ?? spawn)(input.executable, input.argv, {
          cwd: input.cwd,
          env: input.env,
          signal: input.resourceSignal,
          stdio,
          shell: false,
          detached,
          windowsHide,
        })
        child.once('spawn', () => {
          let failure: string | undefined
          if (
            typeof child.pid === 'number' &&
            Number.isInteger(child.pid) &&
            child.pid > 0
          ) {
            const observed = observer.spawnObserved({
              source: 'node-spawn-event',
              pid: child.pid,
            })
            if (!observed.ok) failure = observed.cause
          } else {
            observer.failure({
              source: 'adapter-observation-error',
              cause: 'Evaluator child has no valid runtime PID',
            })
            failure = 'Evaluator child has no valid runtime PID'
          }
          if (failure) {
            child.emit(
              'error',
              Object.assign(new Error(failure), {
                name: 'ExecutionObservationError',
              }),
            )
            try {
              child.kill('SIGTERM')
            } catch {
              /* termination request only */
            }
          }
        })
        child.on('error', (error: NodeJS.ErrnoException) =>
          observer.failure({
            source: 'node-error-event',
            errorCode: error.code,
            cause: error.message,
          }),
        )
        return child
      },
    )
    if (!dispatched.ok) throw refusal(dispatched)
    return dispatched.value.handle
  }
}

/** File-backed capture retains the evaluator's Bun-compatible output behavior. */
export async function captureEvaluationCommand(
  command: string,
  args: readonly string[],
  options: EvaluationCommandOptions,
): Promise<{ stdout: string; stderr: string }> {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'buffbench-command-output-'),
  )
  const stdoutPath = path.join(root, 'stdout')
  const stderrPath = path.join(root, 'stderr')
  const stdoutFd = fs.openSync(stdoutPath, 'wx')
  const stderrFd = fs.openSync(stderrPath, 'wx')
  try {
    const dispatch = await prepareEvaluationCommand(command, args, {
      ...options,
      stdio: ['ignore', stdoutFd, stderrFd],
    })
    const result = await new Promise<{ code: number | null; error?: Error }>(
      (resolve) => {
        let launchError: Error | undefined
        const child = dispatch()
        child.once('error', (error) => {
          launchError = error
        })
        child.once('close', (code) => resolve({ code, error: launchError }))
      },
    )
    const stdout = fs.readFileSync(stdoutPath, 'utf8')
    const stderr = fs.readFileSync(stderrPath, 'utf8')
    if (stdout.length + stderr.length > 10 * 1024 * 1024)
      throw new Error('Evaluation command output exceeds capture limit')
    if (result.error || result.code !== 0)
      throw Object.assign(
        result.error ?? new Error(`Command exited ${result.code}`),
        {
          code: result.error
            ? (result.error as NodeJS.ErrnoException).code
            : result.code,
          stdout,
          stderr,
        },
      )
    return { stdout, stderr }
  } finally {
    fs.closeSync(stdoutFd)
    fs.closeSync(stderrFd)
    fs.rmSync(root, { recursive: true, force: true })
  }
}

export function deriveEvaluationExecution(
  context: ExecutionAdapterContext | undefined,
  memoKey: string,
  durationMs?: number,
): ExecutionAdapterContext | undefined {
  if (!context) return undefined
  const derived = context.execution.derive({
    memoKey,
    limit:
      durationMs === undefined
        ? { kind: 'unbounded' }
        : { kind: 'finite', durationMs },
  })
  if (!derived.ok) throw refusal(derived)
  return {
    ...context,
    execution: derived.value,
    signal: derived.value.signal ?? context.signal,
  }
}

export function isExecutionRefusal(error: unknown): boolean {
  return error instanceof Error && error.name === 'ExecutionAdmissionError'
}

function refusal(result: { reason: string; cause: string }): Error {
  return Object.assign(new Error(`${result.reason}: ${result.cause}`), {
    name: 'ExecutionAdmissionError',
    executionRefusal: result,
  })
}
