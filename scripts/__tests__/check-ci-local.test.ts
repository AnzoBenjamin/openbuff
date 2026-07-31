import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  statSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  TOOL_DEF_TRACKED_PATHS,
  acquireCiLocalLock,
  ciLocalLockPath,
  formatGenerateFailedMessage,
  formatSuccessMessage,
  formatToolDefDriftMessage,
  formatStepFailedMessage,
  projectRootFromMeta as ciProjectRootFromMeta,
  releaseCiLocalLock,
} from '../check-ci-local'
import {
  MANAGED_PRE_PUSH_MARKER,
  buildPrePushHookScript,
  installPrePushHook,
  isManagedPrePushHook,
  parseForceFlag,
  projectRootFromMeta as hookProjectRootFromMeta,
  shouldOverwritePrePushHook,
} from '../install-pre-push-hook'

let tmpRoot: string

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'ci-local-'))
})

afterEach(() => {
  if (existsSync(tmpRoot)) {
    rmSync(tmpRoot, { recursive: true, force: true })
  }
})

function hooksDirFor(root: string): string {
  return join(root, '.git', 'hooks')
}

describe('check-ci-local helpers', () => {
  test('TOOL_DEF_TRACKED_PATHS matches CI git diff file list', () => {
    expect([...TOOL_DEF_TRACKED_PATHS]).toEqual([
      'agents/types/tools.ts',
      'common/src/templates/initial-agents-dir/types/tools.ts',
      'cli/src/data/initial-agent-type-sources.generated.ts',
    ])
  })

  test('formatGenerateFailedMessage mentions generate-tool-definitions', () => {
    expect(formatGenerateFailedMessage(2)).toContain('generate-tool-definitions')
    expect(formatGenerateFailedMessage(2)).toContain('2')
  })

  test('formatGenerateFailedMessage handles null exit code', () => {
    expect(formatGenerateFailedMessage(null)).toContain('unknown')
  })

  test('formatToolDefDriftMessage lists tracked paths and regenerate guidance', () => {
    const msg = formatToolDefDriftMessage(TOOL_DEF_TRACKED_PATHS)
    expect(msg).toContain('bun run generate-tool-definitions')
    for (const path of TOOL_DEF_TRACKED_PATHS) {
      expect(msg).toContain(path)
    }
  })

  test('formatStepFailedMessage and success message are stable', () => {
    expect(formatStepFailedMessage('guard:memory-drift', 1)).toContain(
      'guard:memory-drift',
    )
    expect(formatStepFailedMessage('guard:sync-agent-config', null)).toContain(
      'unknown',
    )
    expect(formatSuccessMessage()).toContain('CI-local early gates passed')
    expect(formatSuccessMessage()).toContain('memory-drift')
    expect(formatSuccessMessage()).toContain('sync-agent-config')
  })

  test('projectRootFromMeta resolves parent of scripts package', () => {
    const root = ciProjectRootFromMeta()
    expect(existsSync(join(root, 'scripts'))).toBe(true)
  })
})

describe('ci-local lock', () => {
  test('ciLocalLockPath is under .openbuff', () => {
    expect(ciLocalLockPath(tmpRoot)).toBe(
      join(tmpRoot, '.openbuff', 'ci-local.lock'),
    )
  })

  test('acquireCiLocalLock twice fails second; release allows re-acquire', () => {
    const first = acquireCiLocalLock(tmpRoot)
    expect(first.acquired).toBe(true)
    expect(existsSync(first.lockPath)).toBe(true)

    const second = acquireCiLocalLock(tmpRoot)
    expect(second.acquired).toBe(false)
    expect(second.message).toContain('Another check:ci-local holds the lock')

    releaseCiLocalLock(tmpRoot)
    expect(existsSync(ciLocalLockPath(tmpRoot))).toBe(false)

    const third = acquireCiLocalLock(tmpRoot)
    expect(third.acquired).toBe(true)
    releaseCiLocalLock(tmpRoot)
  })
})

describe('install-pre-push-hook helpers', () => {
  test('buildPrePushHookScript includes managed marker and check:ci-local', () => {
    const script = buildPrePushHookScript()
    expect(script.startsWith('#!/bin/sh')).toBe(true)
    expect(script).toContain(MANAGED_PRE_PUSH_MARKER)
    expect(script).toContain('git rev-parse --show-toplevel')
    expect(script).toContain('bun run check:ci-local')
    expect(isManagedPrePushHook(script)).toBe(true)
  })

  test('isManagedPrePushHook detects marker only', () => {
    expect(isManagedPrePushHook('#!/bin/sh\necho hi\n')).toBe(false)
    expect(
      isManagedPrePushHook(`#!/bin/sh\n${MANAGED_PRE_PUSH_MARKER}\n`),
    ).toBe(true)
  })

  test('shouldOverwritePrePushHook allows missing or managed hooks', () => {
    expect(
      shouldOverwritePrePushHook({ existingContent: null, force: false }),
    ).toEqual({ overwrite: true })

    expect(
      shouldOverwritePrePushHook({
        existingContent: buildPrePushHookScript(),
        force: false,
      }),
    ).toEqual({ overwrite: true })
  })

  test('shouldOverwritePrePushHook refuses foreign hooks without force', () => {
    const decision = shouldOverwritePrePushHook({
      existingContent: '#!/bin/sh\necho custom\n',
      force: false,
    })
    expect(decision.overwrite).toBe(false)
    expect(decision.reason).toContain('--force')
  })

  test('shouldOverwritePrePushHook allows foreign hooks with force', () => {
    expect(
      shouldOverwritePrePushHook({
        existingContent: '#!/bin/sh\necho custom\n',
        force: true,
      }),
    ).toEqual({ overwrite: true })
  })

  test('parseForceFlag accepts --force and -f', () => {
    expect(parseForceFlag([])).toBe(false)
    expect(parseForceFlag(['--force'])).toBe(true)
    expect(parseForceFlag(['-f'])).toBe(true)
    expect(parseForceFlag(['--other'])).toBe(false)
  })

  test('projectRootFromMeta resolves parent of scripts package', () => {
    const root = hookProjectRootFromMeta()
    expect(existsSync(join(root, 'scripts'))).toBe(true)
  })
})

describe('installPrePushHook', () => {
  test('refuses when .git missing and no hooksDir override', () => {
    const result = installPrePushHook({ root: tmpRoot, force: false })
    expect(result.installed).toBe(false)
    expect(result.message).toMatch(/Could not resolve git hooks|No \.git/)
    expect(existsSync(join(tmpRoot, '.git', 'hooks', 'pre-push'))).toBe(false)
  })

  test('installs managed pre-push hook with hooksDir override', () => {
    const hooksDir = hooksDirFor(tmpRoot)
    mkdirSync(hooksDir, { recursive: true })
    const result = installPrePushHook({
      root: tmpRoot,
      force: false,
      hooksDir,
    })
    expect(result.installed).toBe(true)
    expect(result.hookPath).toBe(join(hooksDir, 'pre-push'))
    expect(existsSync(result.hookPath)).toBe(true)
    const content = readFileSync(result.hookPath, 'utf8')
    expect(isManagedPrePushHook(content)).toBe(true)
    expect(content).toContain('bun run check:ci-local')
    expect(result.message).toContain('Installed Openbuff managed pre-push hook')
    // Executable bit should be set for the owner (0o100 = user execute).
    expect(statSync(result.hookPath).mode & 0o100).toBeTruthy()
  })

  test('install with hooksDir override writes only there; no temp leftovers', () => {
    const hooksDir = hooksDirFor(tmpRoot)
    mkdirSync(hooksDir, { recursive: true })
    const otherDir = join(tmpRoot, 'other-hooks')
    mkdirSync(otherDir, { recursive: true })

    const result = installPrePushHook({
      root: tmpRoot,
      force: false,
      hooksDir,
    })
    expect(result.installed).toBe(true)
    expect(existsSync(join(hooksDir, 'pre-push'))).toBe(true)
    expect(existsSync(join(otherDir, 'pre-push'))).toBe(false)

    const leftovers = readdirSync(hooksDir).filter((name) =>
      name.startsWith('pre-push.openbuff.tmp'),
    )
    expect(leftovers).toEqual([])
  })

  test('reinstalls over an existing managed hook without force', () => {
    const hooksDir = hooksDirFor(tmpRoot)
    mkdirSync(hooksDir, { recursive: true })
    const hookPath = join(hooksDir, 'pre-push')
    writeFileSync(hookPath, buildPrePushHookScript(), 'utf8')
    chmodSync(hookPath, 0o644)

    const result = installPrePushHook({
      root: tmpRoot,
      force: false,
      hooksDir,
    })
    expect(result.installed).toBe(true)
    expect(readFileSync(hookPath, 'utf8')).toBe(buildPrePushHookScript())
    expect(statSync(hookPath).mode & 0o100).toBeTruthy()
  })

  test('refuses foreign hook without force and leaves it unchanged', () => {
    const hooksDir = hooksDirFor(tmpRoot)
    mkdirSync(hooksDir, { recursive: true })
    const hookPath = join(hooksDir, 'pre-push')
    const foreign = '#!/bin/sh\necho custom-foreign\n'
    writeFileSync(hookPath, foreign, 'utf8')

    const result = installPrePushHook({
      root: tmpRoot,
      force: false,
      hooksDir,
    })
    expect(result.installed).toBe(false)
    expect(result.message).toContain('--force')
    expect(readFileSync(hookPath, 'utf8')).toBe(foreign)
  })

  test('overwrites foreign hook when force is true', () => {
    const hooksDir = hooksDirFor(tmpRoot)
    mkdirSync(hooksDir, { recursive: true })
    const hookPath = join(hooksDir, 'pre-push')
    writeFileSync(hookPath, '#!/bin/sh\necho custom-foreign\n', 'utf8')

    const result = installPrePushHook({
      root: tmpRoot,
      force: true,
      hooksDir,
    })
    expect(result.installed).toBe(true)
    const content = readFileSync(hookPath, 'utf8')
    expect(isManagedPrePushHook(content)).toBe(true)
    expect(content).not.toContain('custom-foreign')
  })
})
