import { spawnSync } from 'node:child_process'
import {
  closeSync,
  mkdirSync,
  openSync,
  unlinkSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Tracked generated files that CI asserts after `generate-tool-definitions`. */
export const TOOL_DEF_TRACKED_PATHS = [
  'agents/types/tools.ts',
  'common/src/templates/initial-agents-dir/types/tools.ts',
  'cli/src/data/initial-agent-type-sources.generated.ts',
] as const

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

export function formatSuccessMessage(): string {
  return '✅ CI-local early gates passed (tool defs, memory-drift, sync-agent-config).'
}

export function ciLocalLockPath(root: string): string {
  return join(root, '.openbuff', 'ci-local.lock')
}

/**
 * Acquire an exclusive lock for check:ci-local via O_EXCL create.
 * Fail closed if another process already holds the lock.
 */
export function acquireCiLocalLock(root: string): {
  acquired: boolean
  lockPath: string
  message?: string
} {
  const lockPath = ciLocalLockPath(root)
  mkdirSync(dirname(lockPath), { recursive: true })
  try {
    const fd = openSync(lockPath, 'wx')
    closeSync(fd)
    return { acquired: true, lockPath }
  } catch (err) {
    const code =
      err && typeof err === 'object' && 'code' in err
        ? String((err as { code: unknown }).code)
        : undefined
    if (code === 'EEXIST') {
      return {
        acquired: false,
        lockPath,
        message:
          '❌ Another check:ci-local holds the lock. Wait for it to finish or remove a stale lock at ' +
          lockPath,
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

export function releaseCiLocalLock(root: string): void {
  const lockPath = ciLocalLockPath(root)
  try {
    unlinkSync(lockPath)
  } catch {
    // best-effort; lock may already be gone
  }
}

function runInherited(
  command: string,
  args: string[],
  cwd: string,
): { status: number | null } {
  const result = spawnSync(command, args, {
    cwd,
    stdio: 'inherit',
    env: process.env,
  })
  if (result.error) {
    console.error(result.error.message)
    return { status: 1 }
  }
  return { status: result.status }
}

export function runCiLocalChecks(root = projectRootFromMeta()): number {
  const lock = acquireCiLocalLock(root)
  if (!lock.acquired) {
    console.error(lock.message ?? '❌ Failed to acquire check:ci-local lock.')
    return 1
  }

  try {
    console.log('→ Step A: bun run generate-tool-definitions')
    const generate = runInherited(
      'bun',
      ['run', 'generate-tool-definitions'],
      root,
    )
    if (generate.status !== 0) {
      console.error(formatGenerateFailedMessage(generate.status))
      return 1
    }

    console.log('→ Step B: git diff --exit-code (tracked tool definition files)')
    const diff = runInherited(
      'git',
      ['diff', '--exit-code', '--', ...TOOL_DEF_TRACKED_PATHS],
      root,
    )
    if (diff.status !== 0) {
      console.error(formatToolDefDriftMessage(TOOL_DEF_TRACKED_PATHS))
      return 1
    }

    console.log('→ Step C: bun --cwd=scripts run guard:memory-drift')
    const memoryDrift = runInherited(
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
    const syncConfig = runInherited(
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

    console.log(formatSuccessMessage())
    return 0
  } finally {
    releaseCiLocalLock(root)
  }
}

if (import.meta.main) {
  process.exit(runCiLocalChecks())
}
