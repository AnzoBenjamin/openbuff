import { createHash } from 'node:crypto'

import { SIGTERM_GRACE_MS } from '../services/semgrep-baseline'
import { prepareHarnessGitReadArgv } from '../services/harness-enforcement'
import {
  admitNodeLaunch,
  deriveExecutionContext,
  dispatchNodeLaunch,
  executionLimitMs,
  executionRefusal,
  prepareNodeLaunch,
  refusalForSignal,
  scheduleNodeDeadline,
  trustedNodeSpawn,
} from '../services/execution-launch'

import { resolveFilePathWithinProject } from './path-utils'

import type { CodebuffToolOutput } from '../../../common/src/tools/list'
import type { ExecutionAdapterContext, Refusal } from '@codebuff/common/types/contracts/execution-context'

const DEFAULT_MAX_CHARS = 40_000

/**
 * Hashes every raw byte while retaining only a bounded presentation prefix.
 */
class BoundedOutputCollector {
  private chunks: Buffer[] = []
  private retained = 0
  total = 0
  private hash = createHash('sha256')

  constructor(private readonly cap: number) {}

  push(chunk: Buffer): void {
    this.total += chunk.length
    this.hash.update(chunk)
    const remaining = this.cap - this.retained
    if (remaining <= 0) return
    const take = Math.min(remaining, chunk.length)
    // Copy a partial chunk so its unseen tail cannot stay retained by a view.
    this.chunks.push(Buffer.from(chunk.subarray(0, take)))
    this.retained += take
  }

  text(): string {
    return Buffer.concat(this.chunks).toString('utf8')
  }

  digest(): string {
    return this.hash.digest('hex')
  }
}

export type GitExecutionOptions = {
  executionContext?: ExecutionAdapterContext
  branchId?: string
  /** Trusted phase keeps retries memoized without conflating before/after. */
  phase?: string
  environmentOverlay?: Readonly<Record<string, string | undefined>>
  timeoutMs?: number
  sigtermGraceMs?: number
}

export type GitBoundedResult = {
  stdout: string
  stderr: string
  exitCode: number
  stdoutTotalBytes: number
  stdoutSha256: string
  stdoutComplete: boolean
  stdoutTruncated: boolean
  executionRefusal?: Refusal
}

function refusedGit(refusal: Refusal): GitBoundedResult {
  return {
    stdout: '', stderr: refusal.cause, exitCode: -1,
    stdoutTotalBytes: 0,
    stdoutSha256: createHash('sha256').digest('hex'),
    stdoutComplete: false, stdoutTruncated: false,
    executionRefusal: refusal,
  }
}

async function executeGit(
  args: readonly string[],
  cwd: string,
  signal: AbortSignal | undefined,
  options: GitExecutionOptions & { maxOutputBytes: number },
): Promise<GitBoundedResult> {
  const argv = prepareHarnessGitReadArgv(args)
  const captured = {
    ...options,
    environmentOverlay: options.environmentOverlay ? { ...options.environmentOverlay } : undefined,
  }
  if (signal?.aborted) return refusedGit(refusalForSignal(signal))
  const limit = executionLimitMs(captured.timeoutMs)
  if (!limit.ok) return refusedGit(limit)
  if (!Number.isSafeInteger(captured.maxOutputBytes) || captured.maxOutputBytes < 0) {
    return refusedGit(executionRefusal('invalid-context', 'Git output bound is invalid'))
  }
  const graceMs = captured.sigtermGraceMs ?? SIGTERM_GRACE_MS
  if (!Number.isSafeInteger(graceMs) || graceMs < 0) {
    return refusedGit(executionRefusal('invalid-context', 'Git termination grace is invalid'))
  }
  const context = deriveExecutionContext(captured.executionContext, `git:${captured.branchId ?? ''}:${captured.phase ?? 'direct'}`, limit.value)
  if (!context.ok) return refusedGit(context)
  const launch = prepareNodeLaunch({
    executionContext: context.value,
    executable: 'git', argv, cwd,
    branchId: captured.branchId ?? '',
    environmentOverlay: captured.environmentOverlay,
    adapterOptions: {
      stdio: 'ignore-pipe-pipe', shell: false, detached: false,
      windowsHide: false, sigtermGraceMs: graceMs,
      phase: captured.phase ?? 'direct',
    },
  })
  if (!launch.ok) return refusedGit(launch)
  const admitted = await admitNodeLaunch(launch.value, context.value.signal ?? signal)
  if (!admitted.ok) return refusedGit(admitted)
  const spawn = trustedNodeSpawn(context.value)
  const dispatched = dispatchNodeLaunch(admitted.value, (input) => spawn(
    input.executable, input.argv, {
      cwd: input.cwd, env: input.env, signal: input.resourceSignal,
      stdio: ['ignore', 'pipe', 'pipe'], shell: false,
      detached: false, windowsHide: false,
    },
  ), { sigtermGraceMs: graceMs })
  if (!dispatched.ok) return refusedGit(dispatched)
  const node = dispatched.value
  const child = node.child
  const resourceSignal = node.input.resourceSignal
  return await new Promise((resolve) => {
    const stdoutCollector = new BoundedOutputCollector(captured.maxOutputBytes)
    const stderrCollector = new BoundedOutputCollector(captured.maxOutputBytes)
    let settled = false
    let cancelDeadline: (() => void) | undefined
    const settle = (result: { exitCode: number; stderrNote?: string; refusal?: Refusal }) => {
      if (settled) return
      settled = true
      cancelDeadline?.()
      resourceSignal.removeEventListener('abort', onAbort)
      const observed = node.observation()
      const refusal = result.refusal ?? node.resourceRefusal() ?? (!observed.ok ? observed : undefined)
      const exitCode = refusal ? -1 : result.exitCode
      resolve({
        stdout: stdoutCollector.text(),
        stderr: stderrCollector.text() + (refusal?.cause ?? result.stderrNote ?? ''),
        exitCode,
        stdoutTotalBytes: stdoutCollector.total,
        stdoutSha256: stdoutCollector.digest(),
        stdoutComplete: !refusal && (exitCode === 0 || exitCode === 1),
        stdoutTruncated: stdoutCollector.total > captured.maxOutputBytes,
        ...(refusal ? { executionRefusal: refusal } : {}),
      })
    }
    const onAbort = () => {
      if (settled) return
      const refusal = refusalForSignal(resourceSignal)
      settle({ exitCode: -1, refusal })
    }
    if (node.input.resourceRemainingMs !== null) {
      cancelDeadline = scheduleNodeDeadline(node.remainingResourceMs, () => {
        settle({ exitCode: -1, refusal: node.resourceRefusal() ?? (resourceSignal.aborted
          ? refusalForSignal(resourceSignal) : executionRefusal('deadline-exhausted', 'Git resource deadline exhausted')) })
      })
    }
    child.stdout?.on('data', (chunk: Buffer) => { if (!settled) stdoutCollector.push(chunk) })
    child.stderr?.on('data', (chunk: Buffer) => { if (!settled) stderrCollector.push(chunk) })
    child.on('error', (error) => {
      const observed = node.observation()
      settle({ exitCode: -1, stderrNote: error.message, refusal: !observed.ok ? observed : undefined })
    })
    child.on('close', (code) => {
      settle({ exitCode: code ?? -1 })
    })
    resourceSignal.addEventListener('abort', onAbort, { once: true })
    if (resourceSignal.aborted) onAbort()
  })
}

/** Complete byte hashing with bounded retained output and captured lifetime. */
export async function runGitBounded(
  args: readonly string[],
  cwd: string,
  signal: AbortSignal | undefined,
  options: GitExecutionOptions & { timeoutMs: number; maxOutputBytes: number },
): Promise<GitBoundedResult> {
  return executeGit(args, cwd, signal, options)
}

/** Compatibility result shape; an omitted local limit retains the parent cap. */
export async function runGit(
  args: readonly string[],
  cwd: string,
  signal?: AbortSignal,
  options: GitExecutionOptions = {},
): Promise<{ stdout: string; stderr: string; exitCode: number; executionRefusal?: Refusal }> {
  const result = await executeGit(args, cwd, signal, { ...options, maxOutputBytes: Number.MAX_SAFE_INTEGER })
  return {
    stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode,
    ...(result.executionRefusal ? { executionRefusal: result.executionRefusal } : {}),
  }
}

export async function gitStatus(params: {
  cwd: string
  include_diff?: boolean
  staged?: boolean
  path?: string
  max_chars?: number
  signal?: AbortSignal
  executionContext?: ExecutionAdapterContext
  phase?: string
  /**
   * Optional wall-clock deadline for both the status and (when requested)
   * diff spawns (reliability: bundle-rev-parse-head-unbounded): when set,
   * both route through runGitBounded so a wedged git fails closed instead
   * of hanging the caller. An omitted local cap still respects the captured
   * parent budget and never restores ambient execution authority.
   */
  timeoutMs?: number
}): Promise<CodebuffToolOutput<'git_status'>> {
  params = { ...params }
  const maxChars = Math.min(
    200_000,
    Math.max(500, params.max_chars ?? DEFAULT_MAX_CHARS),
  )
  const statusArgs = ['status', '--short', '--branch']
  if (params.path) {
    const resolvedPath = resolveFilePathWithinProject(params.cwd, params.path)
    if (!resolvedPath) {
      return [
        {
          type: 'json',
          value: {
            errorMessage: `git_status path traversal blocked: "${params.path}" resolves outside the project root.`,
          },
        },
      ]
    }
    statusArgs.push('--', resolvedPath.relativePath)
  }

  // Deadline-threaded spawn (reliability: bundle-rev-parse-head-unbounded):
  // the generous retention cap keeps status parsing intact — the deadline is
  // the bound.
  const boundedOptions =
    params.timeoutMs !== undefined
      ? { timeoutMs: params.timeoutMs, maxOutputBytes: 8 * 1024 * 1024 }
      : undefined
  const membership = params.path ? 'filtered' : 'all'
  const statusBranchId = `git-status.${boundedOptions ? 'bounded' : 'legacy'}.status.${membership}`
  const status =
    boundedOptions !== undefined
      ? await runGitBounded(
          statusArgs,
          params.cwd,
          params.signal,
          { ...boundedOptions, executionContext: params.executionContext, branchId: statusBranchId, phase: params.phase },
        )
      : await runGit(statusArgs, params.cwd, params.signal, {
          executionContext: params.executionContext,
          branchId: statusBranchId,
          phase: params.phase,
        })
  if (status.exitCode !== 0) {
    return [
      {
        type: 'json',
        value: {
          errorMessage:
            status.stderr.trim() ||
            `git status exited with code ${status.exitCode}.`,
          ...(status.executionRefusal ? { executionRefusal: status.executionRefusal } : {}),
        },
      },
    ]
  }
  if ('stdoutTruncated' in status && status.stdoutTruncated) {
    return [
      {
        type: 'json',
        value: {
          errorMessage:
            'Git status exceeds output limit; complete path membership is unavailable.',
        },
      },
    ]
  }

  const lines = status.stdout.split('\n')
  const branchLine = lines.find((line) => line.startsWith('## '))
  const branch = branchLine ? branchLine.replace(/^## /, '').trim() : undefined
  const statusBody = lines
    .filter((line) => !line.startsWith('## '))
    .join('\n')
    // Porcelain status uses the first two columns for index/worktree state;
    // trimming the leading space corrupts the first changed path.
    .trimEnd()

  let diff: string | undefined
  let truncated = false
  if (params.include_diff) {
    const diffArgs = ['diff', '--no-color']
    if (params.staged) diffArgs.splice(1, 0, '--staged')
    if (params.path) {
      const resolvedDiffPath = resolveFilePathWithinProject(
        params.cwd,
        params.path,
      )
      if (!resolvedDiffPath) {
        return [
          {
            type: 'json',
            value: {
              errorMessage: `git_status path traversal blocked: "${params.path}" resolves outside the project root.`,
            },
          },
        ]
      }
      diffArgs.push('--', resolvedDiffPath.relativePath)
    }
    const diffResult =
      boundedOptions !== undefined
        ? await runGitBounded(
            diffArgs,
            params.cwd,
            params.signal,
            {
              ...boundedOptions,
              executionContext: params.executionContext,
              branchId: `git-status.bounded.diff-${params.staged ? 'staged' : 'unstaged'}.${membership}`,
              phase: params.phase,
            },
          )
        : await runGit(diffArgs, params.cwd, params.signal, {
            executionContext: params.executionContext,
            branchId: `git-status.legacy.diff-${params.staged ? 'staged' : 'unstaged'}.${membership}`,
            phase: params.phase,
          })
    if (diffResult.exitCode !== 0 && diffResult.exitCode !== 1) {
      return [
        {
          type: 'json',
          value: {
            errorMessage:
              diffResult.stderr.trim() ||
              `git diff exited with code ${diffResult.exitCode}.`,
            ...(diffResult.executionRefusal ? { executionRefusal: diffResult.executionRefusal } : {}),
          },
        },
      ]
    }
    diff = diffResult.stdout
    if (diff.length > maxChars) {
      // Self-describing elision (truncation-recovery): the marker used to say
      // only HOW MUCH was dropped, so an orchestrator had no way to ask for
      // the remainder and reviewers silently reviewed a fragment. State the
      // resume offset and the untruncated total, plus the two concrete
      // recovery paths (a larger max_chars, or reading the individual files).
      // The leading `[...truncated ` prefix is preserved so existing substring
      // assertions and consumers keep matching it.
      const omitted = diff.length - maxChars
      const total = diff.length
      diff =
        diff.slice(0, maxChars) +
        `\n[...truncated ${omitted} chars at offset ${maxChars} of ${total}; re-call with a larger max_chars or read individual files with read_files]`
      truncated = true
    }
  }

  return [
    {
      type: 'json',
      value: {
        ...(branch ? { branch } : {}),
        status: statusBody,
        ...(diff !== undefined ? { diff } : {}),
        ...(truncated ? { truncated: true } : {}),
      },
    },
  ]
}
