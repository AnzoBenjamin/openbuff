import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const MANAGED_PRE_PUSH_MARKER = '# openbuff-managed-pre-push-hook'

export function projectRootFromMeta(metaUrl = import.meta.url): string {
  return resolve(dirname(fileURLToPath(metaUrl)), '..')
}

export function isManagedPrePushHook(content: string): boolean {
  return content.includes(MANAGED_PRE_PUSH_MARKER)
}

export function buildPrePushHookScript(): string {
  return `#!/bin/sh
${MANAGED_PRE_PUSH_MARKER}
# Optional local pre-push gate mirroring early GitHub CI checks.
# Installed via: bun run install:pre-push
set -e
ROOT=$(git rev-parse --show-toplevel)
cd "$ROOT"
exec bun run check:ci-local
`
}

export function shouldOverwritePrePushHook(options: {
  existingContent: string | null
  force: boolean
}): { overwrite: boolean; reason?: string } {
  const { existingContent, force } = options
  if (existingContent === null) {
    return { overwrite: true }
  }
  if (isManagedPrePushHook(existingContent)) {
    return { overwrite: true }
  }
  if (force) {
    return { overwrite: true }
  }
  return {
    overwrite: false,
    reason:
      'Existing pre-push hook is not the Openbuff-managed hook. Re-run with --force to overwrite.',
  }
}

export function parseForceFlag(argv: string[]): boolean {
  return argv.includes('--force') || argv.includes('-f')
}

/**
 * Resolve the Git hooks directory for `root` via
 * `git rev-parse --git-path hooks` (respects worktrees and core.hooksPath).
 * Returns null when git is unavailable or the path cannot be resolved.
 */
export function resolveGitHooksDir(root: string): string | null {
  const result = spawnSync(
    'git',
    ['-C', root, 'rev-parse', '--git-path', 'hooks'],
    {
      encoding: 'utf8',
      env: process.env,
    },
  )
  if (result.status !== 0 || result.error) {
    return null
  }
  const raw = (result.stdout ?? '').trim()
  if (!raw) {
    return null
  }
  return isAbsolute(raw) ? raw : resolve(root, raw)
}

function snapshotExistingHook(hookPath: string): {
  content: string | null
  mode: number | null
} {
  if (!existsSync(hookPath)) {
    return { content: null, mode: null }
  }
  return {
    content: readFileSync(hookPath, 'utf8'),
    mode: statSync(hookPath).mode,
  }
}

function bestEffortRestoreHook(
  hookPath: string,
  previous: { content: string | null; mode: number | null },
): void {
  try {
    if (previous.content === null) {
      if (existsSync(hookPath)) {
        unlinkSync(hookPath)
      }
      return
    }
    writeFileSync(hookPath, previous.content, 'utf8')
    if (previous.mode !== null) {
      chmodSync(hookPath, previous.mode)
    }
  } catch {
    // best-effort only
  }
}

function bestEffortUnlink(path: string): void {
  try {
    if (existsSync(path)) {
      unlinkSync(path)
    }
  } catch {
    // best-effort only
  }
}

export function installPrePushHook(options?: {
  root?: string
  force?: boolean
  /** Optional hooks dir override for tests / offline install targets. */
  hooksDir?: string
}): { installed: boolean; hookPath: string; message: string } {
  const root = options?.root ?? projectRootFromMeta()
  const force = options?.force ?? false

  let hooksDir = options?.hooksDir
  if (!hooksDir) {
    // Always go through git for non-test installs so worktrees and core.hooksPath
    // resolve correctly. Never invent `<root>/.git/hooks` (breaks gitfile worktrees).
    const resolved = resolveGitHooksDir(root)
    if (!resolved) {
      const hookPath = join(root, '.git', 'hooks', 'pre-push')
      return {
        installed: false,
        hookPath,
        message: `❌ Could not resolve git hooks directory at ${root} (git rev-parse --git-path hooks failed). Run this from a git checkout with git on PATH, or pass hooksDir for offline tests.`,
      }
    }
    hooksDir = resolved
  }

  const hookPath = join(hooksDir, 'pre-push')

  let existingContent: string | null = null
  if (existsSync(hookPath)) {
    existingContent = readFileSync(hookPath, 'utf8')
  }

  const decision = shouldOverwritePrePushHook({ existingContent, force })
  if (!decision.overwrite) {
    return {
      installed: false,
      hookPath,
      message: `❌ ${decision.reason}\n   Hook path: ${hookPath}`,
    }
  }

  mkdirSync(hooksDir, { recursive: true })

  const previous = snapshotExistingHook(hookPath)
  const script = buildPrePushHookScript()
  const tempPath = join(hooksDir, `pre-push.openbuff.tmp.${process.pid}`)

  try {
    writeFileSync(tempPath, script, 'utf8')
    chmodSync(tempPath, 0o755)
    renameSync(tempPath, hookPath)
  } catch (err) {
    bestEffortUnlink(tempPath)
    bestEffortRestoreHook(hookPath, previous)
    const detail = err instanceof Error ? err.message : String(err)
    return {
      installed: false,
      hookPath,
      message: `❌ Failed to install pre-push hook atomically: ${detail}\n   Hook path: ${hookPath}`,
    }
  }

  return {
    installed: true,
    hookPath,
    message: [
      '✅ Installed Openbuff managed pre-push hook.',
      `   ${hookPath}`,
      '   It runs `bun run check:ci-local` (tool defs + memory-drift + sync-agent-config).',
      '   The hook is local-only (not committed).',
      '   To reinstall over a foreign hook: bun run install:pre-push -- --force',
    ].join('\n'),
  }
}

if (import.meta.main) {
  const result = installPrePushHook({
    force: parseForceFlag(process.argv.slice(2)),
  })
  if (result.installed) {
    console.log(result.message)
    process.exit(0)
  }
  console.error(result.message)
  process.exit(1)
}
