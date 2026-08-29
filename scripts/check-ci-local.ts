import { spawnSync } from 'node:child_process'
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Tracked generated files that CI asserts after `generate-tool-definitions`. */
export const TOOL_DEF_TRACKED_PATHS = [
  'agents/types/tools.ts',
  'common/src/templates/initial-agents-dir/types/tools.ts',
  'cli/src/data/initial-agent-type-sources.generated.ts',
] as const

/** Packages whose full test suites run as Step E of check:ci-local. */
export const FULL_SUITE_STEPS = [
  { label: 'agents', cwd: 'agents' },
  { label: 'common', cwd: 'common' },
] as const

/**
 * NOTE: duplicated verbatim in install-pre-push-hook.ts on purpose: each script
 * stays a standalone single-file program, and the test suite aliases both copies
 * so drift is caught. If you change one, change both.
 */
export function projectRootFromMeta(metaUrl = import.meta.url): string {
  return resolve(dirname(fileURLToPath(metaUrl)), '..')
}

export function formatGenerateFailedMessage(exitCode: number | null): string {
  return `❌ generate-tool-definitions failed (exit ${exitCode ?? 'unknown'}). Fix generator errors before pushing.`
}

export function formatToolDefDriftMessage(paths: readonly string[]): string {
  return [
    '❌ Generated tool definition files drifted from git HEAD after regenerate.',
    'Run `bun run generate-tool-definitions`, review the diffs, and commit:',
    ...paths.map((p) => `  - ${p}`),
  ].join('\n')
}

export function formatStepFailedMessage(
  stepLabel: string,
  exitCode: number | null,
): string {
  return `❌ ${stepLabel} failed (exit ${exitCode ?? 'unknown'}).`
}

export function formatSuiteFailedMessage(
  label: string,
  exitCode: number | null,
): string {
  return `❌ ${label} test suite failed (exit ${exitCode ?? 'unknown'}). Fix failures before pushing.`
}

export function formatSuccessMessage(): string {
  return '✅ CI-local early gates passed (tool defs, memory-drift, sync-agent-config, full agents + common suites).'
}

export function ciLocalLockPath(root: string): string {
  return join(root, '.openbuff', 'ci-local.lock')
}

/**
 * Best-effort: a crashed run can leave ci-local.lock behind, so keep the whole
 * `.openbuff/` dir out of `git status` with a local .gitignore, independent of
 * the repo's root .gitignore.
 */
function ensureLockDirIgnored(lockPath: string): void {
  const ignorePath = join(dirname(lockPath), '.gitignore')
  let fd: number | undefined
  try {
    fd = openSync(ignorePath, 'wx')
    writeSync(fd, '*\n')
  } catch {
    // best-effort: ignore file already exists or cannot be written
  } finally {
    if (fd !== undefined) {
      closeSync(fd)
    }
  }
}

function readLockHolderPid(lockPath: string): number | undefined {
  try {
    const pid = Number(readFileSync(lockPath, 'utf8').trim())
    return Number.isInteger(pid) && pid > 0 ? pid : undefined
  } catch {
    // best-effort: lock vanished or holds unexpected content
    return undefined
  }
}

/**
 * Acquire an exclusive lock for check:ci-local via O_EXCL create.
 * Fail closed if another process already holds the lock.
 * The holder PID is recorded in the lock so stale locks are identifiable.
 * A failed PID write removes its own just-created lock so the next run is
 * not blocked by an empty stale lock.
 */
export function acquireCiLocalLock(
  root: string,
  /** Test-only seam: replace the PID write to inject write failures. */
  writePid: (fd: number, contents: string) => void = (fd, contents) => {
    writeSync(fd, contents)
  },
): {
  acquired: boolean
  lockPath: string
  holderPid?: number
  message?: string
} {
  const lockPath = ciLocalLockPath(root)
  mkdirSync(dirname(lockPath), { recursive: true })
  ensureLockDirIgnored(lockPath)
  let created = false
  try {
    const fd = openSync(lockPath, 'wx')
    created = true
    try {
      writePid(fd, `${process.pid}\n`)
    } finally {
      closeSync(fd)
    }
    return { acquired: true, lockPath }
  } catch (err) {
    const code =
      err && typeof err === 'object' && 'code' in err
        ? String((err as { code: unknown }).code)
        : undefined
    if (code === 'EEXIST') {
      const holderPid = readLockHolderPid(lockPath)
      const holderNote =
        holderPid !== undefined
          ? ` (holder PID ${holderPid}; verify with \`ps -p ${holderPid}\`)`
          : ''
      return {
        acquired: false,
        lockPath,
        holderPid,
        message:
          '❌ Another check:ci-local holds the lock' +
          holderNote +
          '. Wait for it to finish or remove a stale lock at ' +
          lockPath,
      }
    }
    if (created) {
      // We exclusively created this lock ourselves, so a failed PID write
      // must not leave it behind: every subsequent run would otherwise
      // report busy until manual deletion.
      try {
        unlinkSync(lockPath)
      } catch {
        // best-effort cleanup; nothing more we can do
      }
    }
    const detail = err instanceof Error ? err.message : String(err)
    return {
      acquired: false,
      lockPath,
      message: `❌ Failed to acquire check:ci-local lock at ${lockPath}: ${detail}`,
    }
  }
}

/**
 * Release the lock only when this process still owns it: if our lock file was
 * externally removed and re-acquired by another run, blind unlinking would
 * delete their lock. Corrupt or foreign lock content is left untouched.
 */
export function releaseCiLocalLock(root: string): void {
  const lockPath = ciLocalLockPath(root)
  if (readLockHolderPid(lockPath) !== process.pid) {
    return
  }
  try {
    unlinkSync(lockPath)
  } catch {
    // best-effort; lock may already be gone
  }
}

/**
 * Optional per-step timeout in milliseconds for check:ci-local steps, so a hung
 * suite cannot block the pre-push hook forever. 0 (the default, and the value
 * for unset or invalid overrides) disables the timeout.
 */
export function ciLocalStepTimeoutMs(): number {
  const raw = process.env.OPENBUFF_CI_LOCAL_STEP_TIMEOUT_MS
  if (!raw) {
    return 0
  }
  const parsed = Number(raw)
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0
}

export type CiLocalStepRunner = (
  command: string,
  args: string[],
  cwd: string,
) => { status: number | null }

/** Minimal structural view of the part of a `spawnSync` result we consume. */
export type CiLocalSpawnResult = {
  status: number | null
  signal?: NodeJS.Signals | null
  error?: Error
}

/** Injectable `spawnSync` seam so tests can assert option propagation. */
export type CiLocalSpawnSync = (
  command: string,
  args: readonly string[],
  options: {
    cwd: string
    stdio: 'inherit'
    env: NodeJS.ProcessEnv
    timeout?: number
  },
) => CiLocalSpawnResult

/**
 * True when the child died in the shape spawnSync uses for a step-timeout
 * kill: via `signal` (or an ETIMEDOUT error) instead of a normal exit code,
 * which would otherwise surface as "exit unknown". External kills (e.g. an
 * OOM SIGKILL) look identical, so callers must also confirm the timeout was
 * actually enabled before blaming the cap.
 */
function stepWasKilledByTimeout(result: CiLocalSpawnResult): boolean {
  const code =
    result.error && typeof result.error === 'object' && 'code' in result.error
      ? String((result.error as { code: unknown }).code)
      : undefined
  return (
    code === 'ETIMEDOUT' || (result.status === null && result.signal != null)
  )
}

/**
 * Hint for a confirmed step-timeout kill. Callers must invoke it only after
 * verifying `timeoutMs > 0`: with the cap disabled there is no cap to have
 * been hit.
 */
function timeoutKillHint(
  timeoutMs: number,
  signal: NodeJS.Signals | null,
): string {
  const via = signal ? ` (killed by ${signal})` : ''
  return `⏱️ Step hit the OPENBUFF_CI_LOCAL_STEP_TIMEOUT_MS cap (${timeoutMs} ms)${via}. Raise or unset it if this step genuinely needs longer.`
}

export function runInherited(
  command: string,
  args: string[],
  cwd: string,
  spawn: CiLocalSpawnSync = spawnSync,
): { status: number | null } {
  const timeoutMs = ciLocalStepTimeoutMs()
  const result = spawn(command, args, {
    cwd,
    stdio: 'inherit',
    env: process.env,
    timeout: timeoutMs > 0 ? timeoutMs : undefined,
  })
  if (result.error) {
    console.error(result.error.message)
  }
  // Only blame the cap when one is armed: an externally killed child (e.g.
  // OOM SIGKILL) with the timeout unset must not get a misleading hint.
  if (timeoutMs > 0 && stepWasKilledByTimeout(result)) {
    console.error(timeoutKillHint(timeoutMs, result.signal ?? null))
  }
  return { status: result.error ? 1 : result.status }
}

export function runCiLocalChecks(
  root: string = projectRootFromMeta(),
  runStep: CiLocalStepRunner = runInherited,
): number {
  const lock = acquireCiLocalLock(root)
  if (!lock.acquired) {
    console.error(lock.message ?? '❌ Failed to acquire check:ci-local lock.')
    return 1
  }

  try {
    console.log('→ Step A: bun run generate-tool-definitions')
    const generate = runStep('bun', ['run', 'generate-tool-definitions'], root)
    if (generate.status !== 0) {
      console.error(formatGenerateFailedMessage(generate.status))
      return 1
    }

    console.log(
      '→ Step B: git diff --exit-code HEAD (tracked tool definition files)',
    )
    const diff = runStep(
      'git',
      ['diff', '--exit-code', 'HEAD', '--', ...TOOL_DEF_TRACKED_PATHS],
      root,
    )
    if (diff.status !== 0) {
      console.error(formatToolDefDriftMessage(TOOL_DEF_TRACKED_PATHS))
      return 1
    }

    console.log('→ Step C: bun --cwd=scripts run guard:memory-drift')
    const memoryDrift = runStep(
      'bun',
      ['--cwd=scripts', 'run', 'guard:memory-drift'],
      root,
    )
    if (memoryDrift.status !== 0) {
      console.error(
        formatStepFailedMessage('guard:memory-drift', memoryDrift.status),
      )
      return 1
    }

    console.log('→ Step D: bun --cwd=scripts run guard:sync-agent-config')
    const syncConfig = runStep(
      'bun',
      ['--cwd=scripts', 'run', 'guard:sync-agent-config'],
      root,
    )
    if (syncConfig.status !== 0) {
      console.error(
        formatStepFailedMessage('guard:sync-agent-config', syncConfig.status),
      )
      return 1
    }

    console.log('→ Step E: full agents + common test suites')
    for (const step of FULL_SUITE_STEPS) {
      const suite = runStep('bun', ['test'], join(root, step.cwd))
      if (suite.status !== 0) {
        console.error(formatSuiteFailedMessage(step.label, suite.status))
        return 1
      }
    }

    console.log(formatSuccessMessage())
    return 0
  } finally {
    releaseCiLocalLock(root)
  }
}

if (import.meta.main) {
  process.exit(runCiLocalChecks())
}
