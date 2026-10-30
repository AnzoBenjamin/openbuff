import { spawn } from 'child_process'

import { SIGTERM_GRACE_MS } from '../services/semgrep-baseline'

import { resolveFilePathWithinProject } from './path-utils'

import type { CodebuffToolOutput } from '../../../common/src/tools/list'

const DEFAULT_MAX_CHARS = 40_000

/**
 * Retains at most `cap` bytes across 'data' chunks while still counting every
 * byte received, so a caller can hash a bounded prefix while mixing the
 * UNtruncated size into its digest. Used by runGitBounded to bound the
 * snapshot-identity path's diff capture
 * (perf: snapshot-identity-diff-capture-unbounded).
 */
class BoundedOutputCollector {
  private chunks: Buffer[] = []
  private retained = 0
  total = 0

  constructor(private readonly cap: number) {}

  push(chunk: Buffer): void {
    this.total += chunk.length
    const remaining = this.cap - this.retained
    if (remaining <= 0) return
    const take = Math.min(remaining, chunk.length)
    this.chunks.push(chunk.subarray(0, take))
    this.retained += take
  }

  text(): string {
    return Buffer.concat(this.chunks).toString('utf8')
  }
}

/**
 * Bounded git spawn for the snapshot-identity path
 * (perf: snapshot-identity-diff-capture-unbounded,
 * identity-git-spawns-no-deadline). Moved here from
 * get-change-review-bundle.ts (reliability: bundle-rev-parse-head-unbounded)
 * so gitStatus can thread an opt-in wall-clock deadline without an import
 * cycle. Unlike runGit, this never buffers more than `maxOutputBytes` bytes
 * per stream — git may emit arbitrarily more, but only the first cap bytes
 * are retained while every byte is still counted (surfaced as
 * stdoutTotalBytes so the hash can mix in the untruncated size) — and a
 * wall-clock deadline kills a wedged git instead of hanging the caller. The
 * AbortSignal path mirrors the semgrep and diagnostic runners' escalation
 * shape (perf: run-git-bounded-abort-no-sigkill-escalation): a bare SIGTERM
 * is followed by a SIGKILL after the shorter of the shared grace period and
 * the remaining deadline, so a git child that ignores SIGTERM is reaped with
 * its piped stdio instead of leaking past the caller's cancellation.
 */
export async function runGitBounded(
  args: string[],
  cwd: string,
  signal: AbortSignal | undefined,
  options: {
    timeoutMs: number
    maxOutputBytes: number
    /**
     * Grace between the abort-path SIGTERM and the SIGKILL escalation
     * (perf: run-git-bounded-abort-no-sigkill-escalation). Defaults to the
     * shared SIGTERM_GRACE_MS the semgrep and diagnostic runners mirror.
     */
    sigtermGraceMs?: number
  },
): Promise<{
  stdout: string
  stderr: string
  exitCode: number
  /** Total stdout bytes emitted by git, retained or not. */
  stdoutTotalBytes: number
}> {
  if (signal?.aborted) {
    const reason = signal.reason
    return {
      stdout: '',
      stderr: reason instanceof Error ? reason.message : 'Aborted',
      exitCode: -1,
      stdoutTotalBytes: 0,
    }
  }
  return await new Promise((resolve) => {
    let child: ReturnType<typeof spawn>
    try {
      child = spawn('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (error) {
      resolve({
        stdout: '',
        stderr: error instanceof Error ? error.message : String(error),
        exitCode: -1,
        stdoutTotalBytes: 0,
      })
      return
    }
    const stdoutCollector = new BoundedOutputCollector(options.maxOutputBytes)
    const stderrCollector = new BoundedOutputCollector(options.maxOutputBytes)
    let settled = false
    let removeAbortListener = () => {}
    let deadline: ReturnType<typeof setTimeout> | undefined
    let escalate: ReturnType<typeof setTimeout> | undefined
    const startedAt = Date.now()
    const graceMs = options.sigtermGraceMs ?? SIGTERM_GRACE_MS

    const settle = (result: { stderrNote?: string; exitCode: number }) => {
      if (settled) return
      settled = true
      if (deadline !== undefined) clearTimeout(deadline)
      if (escalate !== undefined) clearTimeout(escalate)
      removeAbortListener()
      const stderrNote = result.stderrNote ?? ''
      resolve({
        stdout: stdoutCollector.text(),
        stderr: stderrCollector.text() + stderrNote,
        exitCode: result.exitCode,
        stdoutTotalBytes: stdoutCollector.total,
      })
    }

    deadline = setTimeout(() => {
      settle({
        stderrNote: `git timed out after ${options.timeoutMs}ms`,
        exitCode: -1,
      })
      try {
        child.kill('SIGKILL')
      } catch {}
    }, options.timeoutMs)

    child.stdout?.on('data', (chunk: Buffer) => {
      if (settled) return
      stdoutCollector.push(chunk)
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      if (settled) return
      stderrCollector.push(chunk)
    })
    child.on('error', (error) => {
      settle({ stderrNote: error.message, exitCode: -1 })
    })
    child.on('close', (code) => {
      // The abort path settles BEFORE the escalation is armed — settle runs
      // inside onAbort, ahead of the `escalate` assignment in the same abort
      // handler — so when this handler runs after an abort, the settle below
      // hits its `if (settled) return` early-exit and can never clear the
      // armed timer. A child that exits on the abort-path SIGTERM alone must
      // not leave the escalation firing kill('SIGKILL') on its reaped pid —
      // disarm unconditionally here, the same close-driven settle shape the
      // sibling diagnostic-delta runner's finish() enforces.
      if (escalate !== undefined) clearTimeout(escalate)
      settle({ exitCode: code ?? -1 })
    })

    if (signal) {
      const onAbort = () => {
        if (settled) return
        const reason = signal.reason
        settle({
          stderrNote: reason instanceof Error ? reason.message : 'Aborted',
          exitCode: -1,
        })
        try {
          child.kill('SIGTERM')
        } catch {}
        // SIGTERM → SIGKILL escalation (perf:
        // run-git-bounded-abort-no-sigkill-escalation): a git child that
        // ignores SIGTERM must not keep running with live piped stdio after
        // the caller cancelled. The escalation fires after the shorter of the
        // shared grace period and the remaining deadline, so the child is
        // reaped no later than the original wall-clock deadline. Unref'd (a
        // timer must never hold the process open on its own) and disarmed by
        // the close handler when the child exits on the SIGTERM alone —
        // settle has already run by then, so only the close handler can
        // clear the armed escalation.
        const remainingMs = Math.max(
          0,
          options.timeoutMs - (Date.now() - startedAt),
        )
        const escalateDelayMs = Math.min(graceMs, remainingMs)
        if (escalateDelayMs <= 0) {
          try {
            child.kill('SIGKILL')
          } catch {}
          return
        }
        escalate = setTimeout(() => {
          // Dead-child guard: under Bun kill-after-reap is a silent no-op, but
          // under Node the handle signals the raw pid — a reaped-and-recycled
          // pid must never receive our SIGKILL.
          if (child.exitCode !== null || child.signalCode !== null) return
          try {
            child.kill('SIGKILL')
          } catch {}
        }, escalateDelayMs)
        escalate.unref()
      }
      signal.addEventListener('abort', onAbort, { once: true })
      removeAbortListener = () => {
        signal.removeEventListener('abort', onAbort)
      }
    }
  })
}

export function runGit(
  args: string[],
  cwd: string,
  signal?: AbortSignal,
): Promise<{
  stdout: string
  stderr: string
  exitCode: number
}> {
  if (signal?.aborted) {
    const reason = signal.reason
    return Promise.resolve({
      stdout: '',
      stderr: reason instanceof Error ? reason.message : 'Aborted',
      exitCode: -1,
    })
  }

  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>
    try {
      child = spawn('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (error) {
      resolve({
        stdout: '',
        stderr: error instanceof Error ? error.message : String(error),
        exitCode: -1,
      })
      return
    }

    let stdout = ''
    let stderr = ''
    let settled = false
    let removeAbortListener = () => {}

    const settle = (result: {
      stdout: string
      stderr: string
      exitCode: number
    }) => {
      if (settled) return
      settled = true
      removeAbortListener()
      resolve(result)
    }

    child.stdout?.on('data', (chunk: Buffer) => {
      if (settled) return
      stdout += chunk.toString('utf8')
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      if (settled) return
      stderr += chunk.toString('utf8')
    })
    child.on('error', (error) => {
      settle({ stdout, stderr: stderr + error.message, exitCode: -1 })
    })
    child.on('close', (code) => {
      settle({ stdout, stderr, exitCode: code ?? -1 })
    })

    if (signal) {
      const onAbort = () => {
        if (settled) return
        const reason = signal.reason
        settle({
          stdout,
          stderr: reason instanceof Error ? reason.message : 'Aborted',
          exitCode: -1,
        })
        try {
          child.kill('SIGTERM')
        } catch {}
      }
      signal.addEventListener('abort', onAbort, { once: true })
      removeAbortListener = () => {
        signal.removeEventListener('abort', onAbort)
      }
    }
  })
}

export async function gitStatus(params: {
  cwd: string
  include_diff?: boolean
  staged?: boolean
  path?: string
  max_chars?: number
  signal?: AbortSignal
  /**
   * Optional wall-clock deadline for both the status and (when requested)
   * diff spawns (reliability: bundle-rev-parse-head-unbounded): when set,
   * both route through runGitBounded so a wedged git fails closed instead
   * of hanging the caller. Unset callers keep the historical unbounded
   * behavior byte-for-byte.
   */
  timeoutMs?: number
}): Promise<CodebuffToolOutput<'git_status'>> {
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
  const status =
    boundedOptions !== undefined
      ? await runGitBounded(
          statusArgs,
          params.cwd,
          params.signal,
          boundedOptions,
        )
      : await runGit(statusArgs, params.cwd, params.signal)
  if (status.exitCode !== 0) {
    return [
      {
        type: 'json',
        value: {
          errorMessage:
            status.stderr.trim() ||
            `git status exited with code ${status.exitCode}.`,
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
            boundedOptions,
          )
        : await runGit(diffArgs, params.cwd, params.signal)
    if (diffResult.exitCode !== 0 && diffResult.exitCode !== 1) {
      return [
        {
          type: 'json',
          value: {
            errorMessage:
              diffResult.stderr.trim() ||
              `git diff exited with code ${diffResult.exitCode}.`,
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
