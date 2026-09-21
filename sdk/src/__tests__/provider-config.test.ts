import fs from 'fs'
import os from 'os'
import path from 'path'

import { describe, expect, test, beforeEach, afterEach } from 'bun:test'

import {
  PROVIDER_CONFIG_ENV_VAR,
  clearProviderConfigCacheForTest,
  loadProviderConfigSync,
  providerConfigFileSchema,
  resolveContextWindowTokens,
  writeProviderConfigFile,
} from '../provider-config'

const originalEnv = { ...process.env }
const originalCwd = process.cwd()

function resetEnv() {
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) {
      delete process.env[key]
    }
  }
  Object.assign(process.env, originalEnv)
}

const tempDirs: string[] = []

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

beforeEach(() => {
  resetEnv()
  delete process.env[PROVIDER_CONFIG_ENV_VAR]
  clearProviderConfigCacheForTest()
})

afterEach(() => {
  process.chdir(originalCwd)
  resetEnv()
  clearProviderConfigCacheForTest()
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

// Regression (provider-config-list-cache-stale / RF-6-579cb6a4): the resolved
// dependency-path LIST must NOT be memoized on configPaths identity alone.
// A file added or removed inside a fragment directory (openbuff.d) is absent
// from a cached list, so its mtime never reaches the provider-config cache
// key and the process would serve stale provider config until restart.
describe('provider-config fragment reactivity', () => {
  // The fragment DIRECTORY mtime is pinned to a fixed timestamp so a naive
  // fix that only stats fragment directories would still fail these tests:
  // only re-discovering the directory contents per call makes the new/removed
  // file's own mtime reach the cache key.
  const pinnedDirTime = new Date(1_700_000_000_000)

  function setupFragmentConfig(): {
    configPath: string
    fragmentDir: string
  } {
    const tempDir = makeTempDir('openbuff-provider-config-')
    const configPath = path.join(tempDir, 'openbuff.json')
    const fragmentDir = path.join(tempDir, 'openbuff.d')
    fs.mkdirSync(fragmentDir, { recursive: true })
    fs.writeFileSync(configPath, JSON.stringify({}))
    // Pin the fragment directory mtime: adding/removing files inside a
    // directory does not reliably change the directory's own mtime in a
    // way tests can observe, and we want the cache key to change via the
    // file's mtime regardless.
    fs.utimesSync(fragmentDir, pinnedDirTime, pinnedDirTime)
    process.env[PROVIDER_CONFIG_ENV_VAR] = configPath
    return { configPath, fragmentDir }
  }

  test('re-resolves provider config when a fragment file is added at runtime', () => {
    setupFragmentConfig()

    const first = loadProviderConfigSync()
    expect(first.config.defaultModel).toBeUndefined()
    expect(first.sourceFilePaths.some((p) => p.endsWith('late.json'))).toBe(
      false,
    )

    // Add a new fragment file after the first resolve.
    const latePath = path.join(
      path.dirname(process.env[PROVIDER_CONFIG_ENV_VAR]!),
      'openbuff.d',
      'late.json',
    )
    fs.writeFileSync(
      latePath,
      JSON.stringify({ defaultModel: 'local/late' }),
    )

    const second = loadProviderConfigSync()
    expect(second.config.defaultModel).toBe('local/late')
    expect(second.sourceFilePaths).toContain(latePath)
  })

  test('re-resolves provider config when a fragment file is removed at runtime', () => {
    const { fragmentDir } = setupFragmentConfig()
    const removablePath = path.join(fragmentDir, 'removable.json')
    fs.writeFileSync(
      removablePath,
      JSON.stringify({ defaultModel: 'local/initial' }),
    )

    const first = loadProviderConfigSync()
    expect(first.config.defaultModel).toBe('local/initial')

    // Remove the fragment file after the first resolve.
    fs.unlinkSync(removablePath)

    const second = loadProviderConfigSync()
    expect(second.config.defaultModel).toBeUndefined()
    expect(second.sourceFilePaths).not.toContain(removablePath)
  })
})

// Regression (compatibility-reviewer:lexical-chunk-weight-missing-from-config-
// schema): packages/indexer LexicalWeights documents `chunk` as tunable via
// openbuff.json, so the SDK schema must declare it or zod silently strips the
// user's setting before it reaches the indexer.
describe('provider config schema contracts', () => {
  test('preserves indexing.weights.lexical.chunk through schema parsing', () => {
    const config = providerConfigFileSchema.parse({
      indexing: {
        weights: {
          lexical: { chunk: 3.5 },
        },
      },
    })

    expect(config.indexing.weights?.lexical?.chunk).toBe(3.5)
  })

  test('preserves fileChangeHooks.runPerFile through schema parsing', () => {
    const config = providerConfigFileSchema.parse({
      fileChangeHooks: [
        {
          name: 'php syntax',
          command: 'php -l',
          filePattern: '**/*.php',
          runPerFile: true,
        },
      ],
    })

    expect(config.fileChangeHooks).toEqual([
      {
        name: 'php syntax',
        command: 'php -l',
        filePattern: '**/*.php',
        runPerFile: true,
      },
    ])
  })
})

// Regression (compatibility-reviewer:legacy-context-window-fields-dead-without-
// migration): resolveContextWindowTokens honors the deprecated provider-level
// contextWindowTokens / modelContextWindowTokens fields as a fallback so
// existing configs do not silently lose context-window resolution. Explicit
// capability metadata still wins.
describe('resolveContextWindowTokens legacy field mapping', () => {
  function makeConfig(provider: Record<string, unknown>) {
    return providerConfigFileSchema.parse({
      providers: { custom: provider },
    })
  }

  const baseProvider = {
    type: 'openai-compatible',
    baseURL: 'https://api.example.com/v1',
    models: ['my-model'],
  }

  test('falls back to legacy provider-level contextWindowTokens', () => {
    const config = makeConfig({
      ...baseProvider,
      contextWindowTokens: 32_000,
    })

    expect(
      resolveContextWindowTokens({
        model: 'my-model',
        loadedConfig: { sourceFilePaths: [], config },
      }),
    ).toBe(32_000)
  })

  test('honors per-model legacy modelContextWindowTokens over the provider default', () => {
    const config = makeConfig({
      ...baseProvider,
      contextWindowTokens: 32_000,
      modelContextWindowTokens: { 'my-model': 64_000 },
    })

    expect(
      resolveContextWindowTokens({
        model: 'my-model',
        loadedConfig: { sourceFilePaths: [], config },
      }),
    ).toBe(64_000)
  })

  test('explicit modelCapabilities.context.windowTokens wins over legacy fields', () => {
    const config = makeConfig({
      ...baseProvider,
      contextWindowTokens: 32_000,
      modelContextWindowTokens: { 'my-model': 64_000 },
      modelCapabilities: {
        'my-model': { context: { windowTokens: 128_000 } },
      },
    })

    expect(
      resolveContextWindowTokens({
        model: 'my-model',
        loadedConfig: { sourceFilePaths: [], config },
      }),
    ).toBe(128_000)
  })

  test('returns undefined when neither explicit nor legacy fields are set', () => {
    const config = makeConfig({ ...baseProvider })

    expect(
      resolveContextWindowTokens({
        model: 'my-model',
        loadedConfig: { sourceFilePaths: [], config },
      }),
    ).toBeUndefined()
  })
})

// Regression (migration-reviewer:destructive_or_irreversible_operations:
// backup-deleted-after-failed-rollback / unlink-before-rename-fallback):
// the provider-config write paths must never destroy the only surviving copy
// of the user's openbuff.json. writeJsonFilesTransaction's finally block
// previously unlinked .bak backups even when rollback failed to restore
// them, and writeJsonFileAtomic's EEXIST/EPERM fallback unlinked the
// existing config before renaming the temp file into place.
describe('provider config atomic write crash safety', () => {
  const makeErrnoError = (code: string): NodeJS.ErrnoException => {
    const error: NodeJS.ErrnoException = new Error(`simulated ${code}`)
    error.code = code
    return error
  }

  // Fail specific 1-indexed fs.renameSync call numbers so tests can
  // deterministically exercise each commit/rollback branch.
  const stubRenameFailures = (failingCalls: number[], code = 'EEXIST') => {
    const originalRenameSync = fs.renameSync
    const failing = new Set(failingCalls)
    let call = 0
    ;(fs as any).renameSync = (...args: unknown[]) => {
      call++
      if (failing.has(call)) {
        throw makeErrnoError(code)
      }
      return (originalRenameSync as (...renameArgs: unknown[]) => void)(
        ...(args as [string, string]),
      )
    }
    return () => {
      fs.renameSync = originalRenameSync
    }
  }

  const testProvider = {
    type: 'openai-compatible' as const,
    baseURL: 'https://api.example.com/v1',
    models: ['my-model'],
  }

  test(
    'writeJsonFileAtomic EEXIST fallback swaps via a backup without ever ' +
      'unlinking the existing config',
    () => {
      const dir = makeTempDir('openbuff-atomic-eexist-')
      const configPath = path.join(dir, 'openbuff.json')
      fs.writeFileSync(configPath, JSON.stringify({}))

      // Call 1: temp -> target rename fails, forcing the backup swap path.
      const restoreRename = stubRenameFailures([1])

      try {
        writeProviderConfigFile({
          cwd: dir,
          config: { providers: {}, defaultModel: 'local/new' },
          force: true,
        })

        // The new config is in place and the target was never missing.
        expect(fs.existsSync(configPath)).toBe(true)
        const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'))
        expect(parsed.defaultModel).toBe('local/new')

        // Backup and temp files were cleaned up after the successful swap.
        const leftovers = fs
          .readdirSync(dir)
          .filter((name) => /\.bak\.|\.tmp\./.test(name))
        expect(leftovers).toEqual([])
      } finally {
        restoreRename()
      }
    },
  )

  test(
    'writeJsonFileAtomic restores the original config when the ' +
      'post-backup rename fails — the config file is never left missing',
    () => {
      const dir = makeTempDir('openbuff-atomic-restore-')
      const configPath = path.join(dir, 'openbuff.json')
      const oldContent = JSON.stringify({ defaultModel: 'local/old' })
      fs.writeFileSync(configPath, oldContent)

      // Call 1: temp -> target fails (EEXIST). Call 2: target -> backup
      // succeeds. Call 3: temp -> target fails again, forcing the restore
      // rename (call 4) that puts the original content back.
      const restoreRename = stubRenameFailures([1, 3], 'EPERM')

      try {
        expect(() =>
          writeProviderConfigFile({
            cwd: dir,
            config: { providers: {}, defaultModel: 'local/new' },
            force: true,
          }),
        ).toThrow()

        // The original config survived at the target path.
        expect(fs.existsSync(configPath)).toBe(true)
        expect(fs.readFileSync(configPath, 'utf8')).toBe(oldContent)

        // The backup was restored to the target, so no .bak files remain.
        const bakLeftovers = fs
          .readdirSync(dir)
          .filter((name) => /\.bak\./.test(name))
        expect(bakLeftovers).toEqual([])
      } finally {
        restoreRename()
      }
    },
  )

  test(
    'writeJsonFilesTransaction preserves .bak backups when rollback ' +
      'fails to restore them',
    () => {
      const dir = makeTempDir('openbuff-txn-rollback-')
      const configPath = path.join(dir, 'openbuff.json')
      const fragmentDir = path.join(dir, 'openbuff.d')
      fs.mkdirSync(fragmentDir)
      const originalRoot = JSON.stringify({ extends: 'openbuff.d' })
      fs.writeFileSync(configPath, originalRoot)
      const originalFragment = JSON.stringify({
        providers: { custom: testProvider },
      })
      const fragmentPath = path.join(fragmentDir, 'providers.json')
      fs.writeFileSync(fragmentPath, originalFragment)

      // Staged order: index 0 = fragment, index 1 = root. Calls 1-2 install
      // the fragment; call 3 moves the root to its backup; call 4 fails
      // installing the root, and call 5 fails restoring the root backup
      // during rollback, so the backup is the only surviving copy.
      const restoreRename = stubRenameFailures([4, 5], 'EPERM')

      const originalConsoleError = console.error
      const logged: string[] = []
      console.error = (...args: unknown[]) => {
        logged.push(args.map((a) => String(a)).join(' '))
      }

      try {
        expect(() =>
          writeProviderConfigFile({
            cwd: dir,
            config: { providers: { extra: testProvider } },
            force: true,
          }),
        ).toThrow()

        // The fragment file was rolled back to its original content.
        expect(fs.existsSync(fragmentPath)).toBe(true)
        expect(fs.readFileSync(fragmentPath, 'utf8')).toBe(originalFragment)

        // The root target itself is gone (rollback failed), but the .bak
        // backup holding the original root config MUST survive.
        expect(fs.existsSync(configPath)).toBe(false)
        const backupNames = fs
          .readdirSync(dir)
          .filter((name) => name.startsWith('openbuff.json.bak.'))
        expect(backupNames.length).toBe(1)
        expect(fs.readFileSync(path.join(dir, backupNames[0]), 'utf8')).toBe(
          originalRoot,
        )

        // The surviving backup was reported so the user can recover it.
        expect(
          logged.some((line) => line.includes('preserving backup')),
        ).toBe(true)
      } finally {
        console.error = originalConsoleError
        restoreRename()
      }
    },
  )

  test(
    'fragmented transactional write succeeds and leaves no temp or ' +
      'backup files behind',
    () => {
      const dir = makeTempDir('openbuff-txn-success-')
      const configPath = path.join(dir, 'openbuff.json')
      const fragmentDir = path.join(dir, 'openbuff.d')
      fs.mkdirSync(fragmentDir)
      fs.writeFileSync(configPath, JSON.stringify({ extends: 'openbuff.d' }))
      const fragmentPath = path.join(fragmentDir, 'providers.json')
      fs.writeFileSync(
        fragmentPath,
        JSON.stringify({ providers: { custom: testProvider } }),
      )

      writeProviderConfigFile({
        cwd: dir,
        config: { providers: { extra: testProvider } },
        force: true,
      })

      const parsedFragment = JSON.parse(fs.readFileSync(fragmentPath, 'utf8'))
      expect(Object.keys(parsedFragment.providers)).toEqual(['extra'])

      const leftovers = fs
        .readdirSync(dir, { recursive: true })
        .filter(
          (name) =>
            /\.bak\.|\.tmp\./.test(name as string) &&
            !fs.statSync(path.join(dir, name as string)).isDirectory(),
        )
      expect(leftovers).toEqual([])
    },
  )
})
