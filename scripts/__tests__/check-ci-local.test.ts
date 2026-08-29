import { describe, expect, test, beforeEach, afterEach, spyOn } from 'bun:test'
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
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

import {
  TOOL_DEF_TRACKED_PATHS,
  acquireCiLocalLock,
  ciLocalLockPath,
  ciLocalStepTimeoutMs,
  runCiLocalChecks,
  runInherited,
  formatGenerateFailedMessage,
  formatSuccessMessage,
  formatSuiteFailedMessage,
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
  resolveGitHooksDir,
  shouldOverwritePrePushHook,
  writeTempFileExclusive,
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

/** Silence step banners/errors emitted by runCiLocalChecks during tests. */
function withQuietConsole(run: () => void): void {
  const logSpy = spyOn(console, 'log').mockImplementation(() => {})
  const errorSpy = spyOn(console, 'error').mockImplementation(() => {})
  try {
    run()
  } finally {
    logSpy.mockRestore()
    errorSpy.mockRestore()
  }
}

type RecordedStep = { command: string; args: string[]; cwd: string }

function recordingStepRunner(status: number): {
  calls: RecordedStep[]
  run: (
    command: string,
    args: string[],
    cwd: string,
  ) => { status: number | null }
} {
  const calls: RecordedStep[] = []
  return {
    calls,
    run: (command, args, cwd) => {
      calls.push({ command, args, cwd })
      return { status }
    },
  }
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
    expect(formatGenerateFailedMessage(2)).toContain(
      'generate-tool-definitions',
    )
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
    expect(formatSuccessMessage()).toContain('full agents + common suites')
  })

  test('formatSuiteFailedMessage names the failing suite', () => {
    expect(formatSuiteFailedMessage('agents', 1)).toContain(
      'agents test suite failed',
    )
  })

  test('projectRootFromMeta resolves parent of scripts package', () => {
    const root = ciProjectRootFromMeta()
    expect(existsSync(join(root, 'scripts'))).toBe(true)
  })

  test('ciLocalStepTimeoutMs parses positive overrides, else disables', () => {
    const name = 'OPENBUFF_CI_LOCAL_STEP_TIMEOUT_MS'
    const original = process.env[name]
    delete process.env[name]
    try {
      expect(ciLocalStepTimeoutMs()).toBe(0)
      process.env[name] = '45000'
      expect(ciLocalStepTimeoutMs()).toBe(45000)
      process.env[name] = '1500.9'
      expect(ciLocalStepTimeoutMs()).toBe(1500)
      process.env[name] = 'not-a-number'
      expect(ciLocalStepTimeoutMs()).toBe(0)
      process.env[name] = '-1'
      expect(ciLocalStepTimeoutMs()).toBe(0)
      process.env[name] = '0'
      expect(ciLocalStepTimeoutMs()).toBe(0)
    } finally {
      if (original === undefined) {
        delete process.env[name]
      } else {
        process.env[name] = original
      }
    }
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

  test('removes its own lock when the PID write fails after the create', () => {
    const failed = acquireCiLocalLock(tmpRoot, () => {
      throw Object.assign(new Error('simulated ENOSPC'), { code: 'ENOSPC' })
    })
    expect(failed.acquired).toBe(false)
    expect(failed.message).toContain('Failed to acquire check:ci-local lock')
    expect(failed.message).toContain('simulated ENOSPC')
    // Regression: the leaked empty lock made every later run report busy.
    expect(existsSync(ciLocalLockPath(tmpRoot))).toBe(false)

    // Without the leak, the very next run acquires normally.
    const retry = acquireCiLocalLock(tmpRoot)
    expect(retry.acquired).toBe(true)
    releaseCiLocalLock(tmpRoot)
  })

  test('lock records holder PID and busy message surfaces it', () => {
    const first = acquireCiLocalLock(tmpRoot)
    expect(first.acquired).toBe(true)
    expect(readFileSync(first.lockPath, 'utf8')).toContain(`${process.pid}`)

    const second = acquireCiLocalLock(tmpRoot)
    expect(second.acquired).toBe(false)
    expect(second.holderPid).toBe(process.pid)
    expect(second.message).toContain(`holder PID ${process.pid}`)
    releaseCiLocalLock(tmpRoot)
  })

  test('busy message tolerates unreadable or corrupt lock content', () => {
    const lockPath = ciLocalLockPath(tmpRoot)
    mkdirSync(join(tmpRoot, '.openbuff'), { recursive: true })
    writeFileSync(lockPath, 'not-a-pid', 'utf8')

    const second = acquireCiLocalLock(tmpRoot)
    expect(second.acquired).toBe(false)
    expect(second.holderPid).toBeUndefined()
    expect(second.message).toContain('Another check:ci-local holds the lock')
    expect(second.message).not.toContain('holder PID')
  })

  test('acquiring the lock gitignores .openbuff so stale locks stay untracked', () => {
    acquireCiLocalLock(tmpRoot)
    const ignorePath = join(tmpRoot, '.openbuff', '.gitignore')
    expect(readFileSync(ignorePath, 'utf8')).toBe('*\n')
    releaseCiLocalLock(tmpRoot)
  })

  test('releaseCiLocalLock leaves a lock re-acquired by another holder alone', () => {
    acquireCiLocalLock(tmpRoot)
    // Simulate: this run's lock was externally removed and re-acquired by
    // another process recording its own PID.
    rmSync(ciLocalLockPath(tmpRoot))
    writeFileSync(ciLocalLockPath(tmpRoot), '999999999\n', 'utf8')

    releaseCiLocalLock(tmpRoot)

    expect(existsSync(ciLocalLockPath(tmpRoot))).toBe(true)
    expect(readFileSync(ciLocalLockPath(tmpRoot), 'utf8')).toContain(
      '999999999',
    )
  })
})

describe('resolveGitHooksDir', () => {
  function initTmpRepo(): void {
    const init = spawnSync('git', ['init', tmpRoot], { stdio: 'ignore' })
    expect(init.status).toBe(0)
  }

  test('resolves the hooks dir of a freshly initialized repo relative to root', () => {
    initTmpRepo()

    const hooksDir = resolveGitHooksDir(tmpRoot)
    expect(hooksDir).not.toBeNull()
    if (!hooksDir) {
      throw new Error('expected resolveGitHooksDir to succeed in a git repo')
    }
    // `git rev-parse --git-path hooks` returns a repo-relative path
    // (`.git/hooks`); the resolver must anchor it to the repo root.
    expect(resolve(hooksDir)).toBe(join(resolve(tmpRoot), '.git', 'hooks'))
    expect(existsSync(hooksDir)).toBe(true)
  })

  test('installPrePushHook installs through the git-resolved hooks dir', () => {
    initTmpRepo()

    const result = installPrePushHook({ root: tmpRoot, force: false })
    expect(result.installed).toBe(true)
    expect(result.hookPath).toBe(join(tmpRoot, '.git', 'hooks', 'pre-push'))
    expect(isManagedPrePushHook(readFileSync(result.hookPath, 'utf8'))).toBe(
      true,
    )
  })
})

describe('runCiLocalChecks orchestration', () => {
  const expectedSteps = [
    { command: 'bun', args: ['run', 'generate-tool-definitions'], cwdDir: '' },
    {
      command: 'git',
      args: ['diff', '--exit-code', 'HEAD', '--', ...TOOL_DEF_TRACKED_PATHS],
      cwdDir: '',
    },
    {
      command: 'bun',
      args: ['--cwd=scripts', 'run', 'guard:memory-drift'],
      cwdDir: '',
    },
    {
      command: 'bun',
      args: ['--cwd=scripts', 'run', 'guard:sync-agent-config'],
      cwdDir: '',
    },
    { command: 'bun', args: ['test'], cwdDir: 'agents' },
    { command: 'bun', args: ['test'], cwdDir: 'common' },
  ]

  test('runs steps A-E in order and exits 0 when all pass', () => {
    withQuietConsole(() => {
      const { calls, run } = recordingStepRunner(0)
      expect(runCiLocalChecks(tmpRoot, run)).toBe(0)
      expect(calls).toHaveLength(expectedSteps.length)
      calls.forEach((call, i) => {
        const expected = expectedSteps[i]
        expect(call.command).toBe(expected.command)
        expect(call.args.slice(0, expected.args.length)).toEqual(expected.args)
        // Steps A-D run at the repo root; Step E cds into each package dir.
        const expectedCwd = expected.cwdDir
          ? join(tmpRoot, expected.cwdDir)
          : tmpRoot
        expect(call.cwd).toBe(expectedCwd)
      })
      // Step B diffs tracked files against git HEAD (staged drift included).
      expect(calls[1].args[2]).toBe('HEAD')
      // Lock is released after success.
      expect(existsSync(ciLocalLockPath(tmpRoot))).toBe(false)
    })
  })

  test('stops at first failing step and releases the lock', () => {
    withQuietConsole(() => {
      const { calls, run } = recordingStepRunner(1)
      expect(runCiLocalChecks(tmpRoot, run)).toBe(1)
      // Only Step A ran; later steps were skipped.
      expect(calls).toHaveLength(1)
      expect(calls[0].command).toBe('bun')
      // Lock released despite the early failure.
      expect(existsSync(ciLocalLockPath(tmpRoot))).toBe(false)
    })
  })

  test('fails closed with exit 1 and runs no steps when lock is held', () => {
    const acquired = acquireCiLocalLock(tmpRoot)
    expect(acquired.acquired).toBe(true)

    withQuietConsole(() => {
      const { calls, run } = recordingStepRunner(0)
      expect(runCiLocalChecks(tmpRoot, run)).toBe(1)
      expect(calls).toEqual([])
    })
    // A busy run must not delete another holder's lock.
    expect(existsSync(acquired.lockPath)).toBe(true)
    releaseCiLocalLock(tmpRoot)
  })
})

describe('runInherited step runner', () => {
  const TIMEOUT_ENV = 'OPENBUFF_CI_LOCAL_STEP_TIMEOUT_MS'

  /** Swap the step-timeout override in/out around `run`. */
  function withTimeoutEnv(value: string | undefined, run: () => void): void {
    const original = process.env[TIMEOUT_ENV]
    try {
      if (value === undefined) {
        delete process.env[TIMEOUT_ENV]
      } else {
        process.env[TIMEOUT_ENV] = value
      }
      run()
    } finally {
      if (original === undefined) {
        delete process.env[TIMEOUT_ENV]
      } else {
        process.env[TIMEOUT_ENV] = original
      }
    }
  }

  test('propagates the parsed timeout to spawnSync options', () => {
    withTimeoutEnv('45000', () => {
      const calls: Array<{
        command: string
        args: readonly string[]
        cwd: string
        stdio: 'inherit'
        timeout?: number
      }> = []
      const result = runInherited(
        'bun',
        ['test'],
        tmpRoot,
        (command, args, options) => {
          calls.push({
            command,
            args,
            cwd: options.cwd,
            stdio: options.stdio,
            timeout: options.timeout,
          })
          return { status: 0, signal: null }
        },
      )

      expect(result).toEqual({ status: 0 })
      expect(calls).toEqual([
        {
          command: 'bun',
          args: ['test'],
          cwd: tmpRoot,
          stdio: 'inherit',
          timeout: 45000,
        },
      ])
    })
  })

  test('omits the timeout when the override is unset or invalid', () => {
    const timeouts: Array<number | undefined> = []
    const record = (
      _command: string,
      _args: readonly string[],
      options: { timeout?: number },
    ) => {
      timeouts.push(options.timeout)
      return { status: 0, signal: null }
    }

    withTimeoutEnv(undefined, () => {
      expect(runInherited('bun', ['test'], tmpRoot, record)).toEqual({
        status: 0,
      })
    })
    withTimeoutEnv('not-a-number', () => {
      expect(runInherited('bun', ['test'], tmpRoot, record)).toEqual({
        status: 0,
      })
    })

    expect(timeouts).toEqual([undefined, undefined])
  })

  test('appends a timeout hint when the child dies by signal', () => {
    withTimeoutEnv('2000', () => {
      const errorSpy = spyOn(console, 'error').mockImplementation(() => {})
      try {
        const result = runInherited('bun', ['test'], tmpRoot, () => ({
          status: null,
          signal: 'SIGTERM',
        }))
        expect(result).toEqual({ status: null })
        const logged = errorSpy.mock.calls.map((c) => c.join(' ')).join('\n')
        expect(logged).toContain('OPENBUFF_CI_LOCAL_STEP_TIMEOUT_MS')
        expect(logged).toContain('2000 ms')
        expect(logged).toContain('SIGTERM')
      } finally {
        errorSpy.mockRestore()
      }
    })
  })

  test('logs no cap hint when an externally killed child runs without a timeout', () => {
    withTimeoutEnv(undefined, () => {
      const errorSpy = spyOn(console, 'error').mockImplementation(() => {})
      try {
        // External kills (e.g. OOM SIGKILL) look like timeout kills to
        // spawnSync, but with no cap armed there must be no cap hint.
        const result = runInherited('bun', ['test'], tmpRoot, () => ({
          status: null,
          signal: 'SIGKILL',
        }))
        expect(result).toEqual({ status: null })
        const logged = errorSpy.mock.calls.map((c) => c.join(' ')).join('\n')
        expect(logged).not.toContain('OPENBUFF_CI_LOCAL_STEP_TIMEOUT_MS')
      } finally {
        errorSpy.mockRestore()
      }
    })
  })

  test('hints on the same external kill when the timeout is enabled', () => {
    withTimeoutEnv('4000', () => {
      const errorSpy = spyOn(console, 'error').mockImplementation(() => {})
      try {
        const result = runInherited('bun', ['test'], tmpRoot, () => ({
          status: null,
          signal: 'SIGKILL',
        }))
        expect(result).toEqual({ status: null })
        const logged = errorSpy.mock.calls.map((c) => c.join(' ')).join('\n')
        expect(logged).toContain('OPENBUFF_CI_LOCAL_STEP_TIMEOUT_MS')
        expect(logged).toContain('4000 ms')
        expect(logged).toContain('SIGKILL')
      } finally {
        errorSpy.mockRestore()
      }
    })
  })

  test('hints on ETIMEDOUT errors but leaves other spawn errors bare', () => {
    withTimeoutEnv('3000', () => {
      const errorSpy = spyOn(console, 'error').mockImplementation(() => {})
      try {
        const etimedout = runInherited('bun', ['test'], tmpRoot, () => ({
          status: null,
          signal: null,
          error: Object.assign(new Error('spawn bun ETIMEDOUT'), {
            code: 'ETIMEDOUT',
          }),
        }))
        expect(etimedout).toEqual({ status: 1 })
        let logged = errorSpy.mock.calls.map((c) => c.join(' ')).join('\n')
        expect(logged).toContain('spawn bun ETIMEDOUT')
        expect(logged).toContain('OPENBUFF_CI_LOCAL_STEP_TIMEOUT_MS')
        expect(logged).toContain('3000 ms')

        errorSpy.mockClear()
        const enoent = runInherited('missing-binary', [], tmpRoot, () => ({
          status: null,
          signal: null,
          error: Object.assign(new Error('spawn missing-binary ENOENT'), {
            code: 'ENOENT',
          }),
        }))
        expect(enoent).toEqual({ status: 1 })
        logged = errorSpy.mock.calls.map((c) => c.join(' ')).join('\n')
        expect(logged).toContain('spawn missing-binary ENOENT')
        expect(logged).not.toContain('OPENBUFF_CI_LOCAL_STEP_TIMEOUT_MS')
      } finally {
        errorSpy.mockRestore()
      }
    })
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

  test('writeTempFileExclusive creates new files but never clobbers existing ones', () => {
    const target = join(tmpRoot, 'pre-push.openbuff.tmp.exclusive')
    writeTempFileExclusive(target, 'first\n')
    expect(readFileSync(target, 'utf8')).toBe('first\n')

    expect(() => writeTempFileExclusive(target, 'second\n')).toThrow()
    // Pre-planted content survives untouched.
    expect(readFileSync(target, 'utf8')).toBe('first\n')
  })

  test('refuses to follow a pre-planted temp path in a shared hooks dir', () => {
    const hooksDir = hooksDirFor(tmpRoot)
    mkdirSync(hooksDir, { recursive: true })
    writeFileSync(
      join(hooksDir, `pre-push.openbuff.tmp.${process.pid}`),
      'pre-planted\n',
      'utf8',
    )

    const result = installPrePushHook({
      root: tmpRoot,
      force: false,
      hooksDir,
    })
    expect(result.installed).toBe(false)
    expect(result.message).toContain(
      'Failed to install pre-push hook atomically',
    )
    // Nothing was written through the planted path, and the stale temp is gone.
    expect(existsSync(join(hooksDir, 'pre-push'))).toBe(false)
    expect(
      readdirSync(hooksDir).filter((name) => name.startsWith('pre-push')),
    ).toEqual([])
  })

  test('leaves no hook or temp leftovers when the temp write fails', () => {
    const hooksDir = hooksDirFor(tmpRoot)
    mkdirSync(hooksDir, { recursive: true })

    const result = installPrePushHook({
      root: tmpRoot,
      force: false,
      hooksDir,
      writeTempFile: () => {
        throw new Error('simulated ENOSPC')
      },
    })
    expect(result.installed).toBe(false)
    expect(result.message).toContain(
      'Failed to install pre-push hook atomically',
    )
    expect(result.message).toContain('simulated ENOSPC')
    expect(existsSync(join(hooksDir, 'pre-push'))).toBe(false)
    const leftovers = readdirSync(hooksDir).filter((name) =>
      name.startsWith('pre-push.openbuff.tmp'),
    )
    expect(leftovers).toEqual([])
  })

  test('leaves an existing hook byte-identical and mtime-identical after a write failure', () => {
    const hooksDir = hooksDirFor(tmpRoot)
    mkdirSync(hooksDir, { recursive: true })
    const hookPath = join(hooksDir, 'pre-push')
    const foreign = '#!/bin/sh\necho custom-foreign\n'
    writeFileSync(hookPath, foreign, 'utf8')
    const mtimeBefore = statSync(hookPath).mtimeMs

    const result = installPrePushHook({
      root: tmpRoot,
      force: true,
      hooksDir,
      writeTempFile: () => {
        throw new Error('simulated EIO')
      },
    })
    expect(result.installed).toBe(false)
    // The hook was never replaced, so the stale snapshot must not be restored
    // over it: content stays byte-identical and the mtime does not move.
    expect(readFileSync(hookPath, 'utf8')).toBe(foreign)
    expect(statSync(hookPath).mtimeMs).toBe(mtimeBefore)
    const leftovers = readdirSync(hooksDir).filter((name) =>
      name.startsWith('pre-push.openbuff.tmp'),
    )
    expect(leftovers).toEqual([])
  })

  test('fails friendly when the existing hook cannot be inspected', () => {
    const hooksDir = hooksDirFor(tmpRoot)
    // Make the hook path itself a directory so readFileSync/statSync throw
    // (EISDIR/ENOTDIR) regardless of uid — unlike chmod 0o000 tricks, which
    // root ignores.
    const hookPath = join(hooksDir, 'pre-push')
    mkdirSync(hookPath, { recursive: true })

    const result = installPrePushHook({
      root: tmpRoot,
      force: true,
      hooksDir,
    })
    expect(result.installed).toBe(false)
    expect(result.message).toContain('Could not inspect')
    expect(result.message).toContain(hookPath)

    rmSync(hookPath, { recursive: true, force: true })
  })
})
