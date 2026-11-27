import { processCleanupSchema } from '@codebuff/common/tools/params/process-cleanup'
import {
  admitNodeLaunch,
  deriveExecutionContext,
  dispatchNodeLaunch,
  executionLimitSeconds,
  prepareNodeLaunch,
  refusalForSignal,
  trustedNodeSpawn,
} from '../services/execution-launch'
import type {
  ExecutionAdapterContext,
  Refusal,
} from '@codebuff/common/types/contracts/execution-context'
import type { CleanupResult } from '@codebuff/common/types/contracts/process-scope'
import type { JSONValue } from '@codebuff/common/types/json'
import type {
  NodeDispatchHandle,
  NodeTargetInput,
} from '../services/execution-launch'
import type { NativeFinalResult } from '../services/native-exec'

type SearchExecutionFields = {
  errorMessage?: string
  processCleanup?: Omit<CleanupResult, 'launchFacts'> & {
    launchFacts?: JSONValue
  }
  executionRefusal?: Refusal
  executionWaitStatusSource?: NativeFinalResult['waitStatusSource']
  executionUsage?: NativeFinalResult['usage']
  executionSignal?: number
  exitCode?: number
  nativeWrapperExitCode?: number
  nativeWrapperSignal?: number
}

/** Searches share the host's captured authority and original resource deadline. */
export async function launchSearchProcess(input: {
  executionContext?: ExecutionAdapterContext
  callerSignal?: AbortSignal
  executable: string
  argv: readonly string[]
  cwd: string
  branchId: string
  timeoutSeconds: number
}) {
  if (input.callerSignal?.aborted) return refusalForSignal(input.callerSignal)
  const limit = executionLimitSeconds(input.timeoutSeconds)
  if (!limit.ok) return limit
  const context = deriveExecutionContext(
    input.executionContext,
    `search:${input.branchId}`,
    limit.value,
  )
  if (!context.ok) return context
  const target: NodeTargetInput = {
    executionContext: context.value,
    executable: input.executable,
    argv: input.argv,
    cwd: input.cwd,
    branchId: input.branchId,
    adapterOptions: {
      stdio: 'ignore-pipe-pipe',
      shell: false,
      detached: true,
      windowsHide: false,
      sigtermGraceMs: 1000,
    },
  }
  const prepared = prepareNodeLaunch(target)
  if (!prepared.ok) return prepared
  const admitted = await admitNodeLaunch(prepared.value, context.value.signal)
  if (!admitted.ok) return admitted
  if (input.callerSignal?.aborted) return refusalForSignal(input.callerSignal)
  const spawn = trustedNodeSpawn(context.value)
  return dispatchNodeLaunch(
    admitted.value,
    (launch) =>
      spawn(launch.executable, launch.argv, {
        cwd: launch.cwd,
        env: launch.env,
        signal: launch.resourceSignal,
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: false,
        detached: true,
        windowsHide: false,
      }),
    { sigtermGraceMs: 1000 },
  )
}

/** The native monitor status is separate from the actual search target wait. */
export async function searchExitStatus(
  node: NodeDispatchHandle,
  exitCode: number | null,
  signal: NodeJS.Signals | null,
) {
  const native = await node.nativeResult
  return native?.ok
    ? { exitCode: native.value.exitCode, signal: native.value.signal }
    : { exitCode, signal }
}

export function searchExitError(
  status: { exitCode: number | null; signal: number | NodeJS.Signals | null },
  stderr: string,
): string | undefined {
  const diagnostic = stderr.trim() ? `: ${stderr.trim()}` : ''
  if (status.signal !== null)
    return `ripgrep terminated by signal ${status.signal}${diagnostic}`
  if (
    status.exitCode !== null &&
    status.exitCode !== 0 &&
    status.exitCode !== 1
  )
    return `ripgrep exited with code ${status.exitCode}${diagnostic}`
  if (status.exitCode === null)
    return `ripgrep exit status was not observed${diagnostic}`
  return undefined
}

/** Presentation caps never remove physical observers or release a live scope. */
export async function finishSearchProcess<T extends Record<string, unknown>>(
  node: NodeDispatchHandle,
  payload: T,
  partial?: () => Record<string, unknown>,
): Promise<T & SearchExecutionFields> {
  try {
    const native = await node.nativeResult
    const cleanup = processCleanupSchema.parse(
      await node.scope.requestStop('normal-leader-exit'),
    )
    const observed = node.observation()
    const refusal =
      node.resourceRefusal() ??
      (native && !native.ok ? native : !observed.ok ? observed : undefined)
    const usage = native?.ok
      ? (native.value.targetUsage ?? native.value.usage)
      : undefined
    const nativeFields = native?.ok
      ? {
          exitCode: native.value.exitCode ?? undefined,
          executionWaitStatusSource: native.value.waitStatusSource,
          ...(native.value.wrapperExitCode !== null
            ? { nativeWrapperExitCode: native.value.wrapperExitCode }
            : {}),
          ...(native.value.wrapperSignal !== null
            ? { nativeWrapperSignal: native.value.wrapperSignal }
            : {}),
          ...(usage ? { executionUsage: usage } : {}),
          ...(native.value.signal !== null
            ? { executionSignal: native.value.signal }
            : {}),
        }
      : {}
    return {
      ...(refusal || cleanup.status !== 'complete' ? partial?.() : {}),
      ...payload,
      ...nativeFields,
      processCleanup: cleanup,
      ...(refusal
        ? {
            errorMessage:
              typeof payload.errorMessage === 'string'
                ? payload.errorMessage
                : refusal.cause,
            executionRefusal: refusal,
          }
        : cleanup.status !== 'complete'
          ? {
              errorMessage: `Search cleanup ${cleanup.status}: ${cleanup.cause ?? 'scope remains unverified'}`,
            }
          : {}),
    }
  } catch (error) {
    return {
      ...partial?.(),
      ...payload,
      errorMessage: `Search cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
}
