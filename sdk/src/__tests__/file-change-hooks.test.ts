import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'

import { describe, expect, test } from 'bun:test'

import { __getFilesystemSlotsInUseForTest } from '../tools/concurrency'
import {
  __getDotnetWalkCountForTest,
  __getManifestSnapshotCountForTest,
  __getManifestSnapshotPhaseEventsForTest,
  __getSnapshotMaxProbesInFlightForTest,
  __resetManifestSnapshotPhaseEventsForTest,
  __resetSnapshotMaxProbesInFlightForTest,
  clearFileChangeHooksCache,
  inferFileChangeHooks,
  inferFileChangeHooksAsync,
  inferFileChangeHooksFromFileSystem,
  runFileChangeHooks,
  selectMatchingHooks,
  type FileChangeHook,
} from '../tools/file-change-hooks'
import { createNodeFileSystem } from '../tools/node-filesystem'
import {
  PROVIDER_CONFIG_ENV_VAR,
  clearProviderConfigCacheForTest,
  mergeFileChangeHooks,
} from '../provider-config'
import { runFileChangeHooksParams } from '@codebuff/common/tools/params/tool/run-file-change-hooks'
import type { CodebuffToolOutput } from '@codebuff/common/tools/list'
import type { CodebuffFileSystem } from '@codebuff/common/types/filesystem'

// The width the hook snapshot caps every filesystem fan-out at, and how many
// independent phases (manifest probes, dotnet-walk listings, dotnet-walk stats)
// can be in flight at the same time by design.
const SNAPSHOT_FAN_OUT_WIDTH = 8
const SNAPSHOT_PHASE_COUNT = 2

// Mirrors MAX_PROJECT_SCAN_ENTRIES in file-change-hooks.ts: the shared entry
// budget both dotnet walks charge. The bound in the walk test is expressed
// against it, so a test that kept its own shrinking numbers would stop pinning
// the real budget.
const MAX_PROJECT_SCAN_ENTRIES = 2_000
// A level wider than the budget left after charging the root, which is the only
// shape where trimming the listing batch changes how many readdirs the walk
// issues. 1,200 root directories leave 800 of the 2,000 entries for the level
// below, so a correct walk lists 801 directories instead of 1,201.
const SYNTHETIC_PACKAGE_COUNT = 1_200
const SYNTHETIC_ENTRIES_PER_PACKAGE = 2

function withTempDir(run: (dir: string) => void): void {
  const dir = mkdtempSync(path.join(tmpdir(), 'openbuff-hooks-'))
  try {
    run(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

async function withTempDirAsync(
  run: (dir: string) => Promise<void>,
): Promise<void> {
  const dir = mkdtempSync(path.join(tmpdir(), 'openbuff-hooks-'))
  // Inference only runs when the loaded provider config does not opt out via
  // `autoFileChangeHooks: false`. Pin an explicit config so these fixtures are
  // decided by the test, not by whatever config the developer's environment
  // happens to resolve (which would make the assertions meaningless).
  const previousConfigPath = process.env[PROVIDER_CONFIG_ENV_VAR]
  const configPath = path.join(dir, 'provider-config.json')
  writeFileSync(
    configPath,
    JSON.stringify({ autoFileChangeHooks: true, fileChangeHooks: [] }),
  )
  process.env[PROVIDER_CONFIG_ENV_VAR] = configPath
  clearProviderConfigCacheForTest()
  try {
    await run(dir)
  } finally {
    if (previousConfigPath === undefined) {
      delete process.env[PROVIDER_CONFIG_ENV_VAR]
    } else {
      process.env[PROVIDER_CONFIG_ENV_VAR] = previousConfigPath
    }
    clearProviderConfigCacheForTest()
    rmSync(dir, { recursive: true, force: true })
    // The per-cwd inference cache is module scope, so a temp dir reused by a
    // later test must never inherit this one's snapshot.
    clearFileChangeHooksCache()
  }
}

function fakeRunner(
  exitByCommand: Record<
    string,
    { exitCode: number; stdout?: string; stderr?: string }
  >,
) {
  const calls: string[] = []
  const paramsList: Array<Record<string, unknown>> = []
  const run = (async (params: Record<string, unknown>) => {
    calls.push(params.command as string)
    paramsList.push(params)
    const r = exitByCommand[params.command as string] ?? { exitCode: 0 }
    return [
      {
        type: 'json' as const,
        value: {
          exitCode: r.exitCode,
          stdout: r.stdout ?? '',
          stderr: r.stderr ?? '',
        },
      },
    ] as CodebuffToolOutput<'run_terminal_command'>
  }) as any
  return { run, calls, paramsList }
}

const hooks: FileChangeHook[] = [
  { name: 'typecheck', command: 'tsc --noEmit' },
  { name: 'test-ts', command: 'bun test', filePattern: '**/*.ts' },
  { name: 'test-py', command: 'pytest', filePattern: '**/*.py' },
]

describe('selectMatchingHooks', () => {
  test('no filePattern always runs; glob matches a changed file', () => {
    const m = selectMatchingHooks(hooks, ['src/a.ts'])
    expect(m.map((h) => h.name)).toEqual(['typecheck', 'test-ts'])
  })
  test('non-matching glob is excluded', () => {
    const m = selectMatchingHooks(hooks, ['src/a.py'])
    expect(m.map((h) => h.name)).toEqual(['typecheck', 'test-py'])
  })
  test('empty files runs only pattern-less hooks', () => {
    const m = selectMatchingHooks(hooks, [])
    expect(m.map((h) => h.name)).toEqual(['typecheck'])
  })
})

function jsonValue(
  out: CodebuffToolOutput<'run_file_change_hooks'>,
): Record<string, unknown>[] | undefined {
  const first = Array.isArray(out) ? out[0] : undefined
  return first && first.type === 'json'
    ? (first.value as Record<string, unknown>[])
    : undefined
}

describe('runFileChangeHooks', () => {
  test('reports when no hooks are configured without invoking a runner', async () => {
    const { run, calls } = fakeRunner({})
    const out = await runFileChangeHooks({
      files: ['src/a.ts'],
      cwd: '/repo',
      hooks: [],
      runCommand: run,
    })

    expect(calls).toEqual([])
    expect(jsonValue(out)).toEqual([
      {
        validationStatus: 'no_hooks_configured',
        message: 'No configured file-change hooks ran.',
        changedFiles: ['src/a.ts'],
      },
    ])
  })

  test('runs matching hooks and reports per-hook exit codes', async () => {
    const { run, calls } = fakeRunner({
      'tsc --noEmit': { exitCode: 0 },
      'bun test': { exitCode: 1, stderr: '1 test failed' },
    })
    const out = await runFileChangeHooks({
      files: ['src/a.ts'],
      cwd: '/repo',
      hooks,
      runCommand: run,
    })
    expect(calls).toEqual(['tsc --noEmit', 'bun test']) // py hook not matched
    const results = jsonValue(out)
    expect(results).toBeDefined()
    expect(results).toHaveLength(2)
    expect(results![0]).toMatchObject({ hookName: 'typecheck', exitCode: 0 })
    expect(results![1]).toMatchObject({ hookName: 'test-ts', exitCode: 1 })
    // A consumer (the gate) can detect failure via exitCode !== 0.
    expect(results!.some((r) => r.exitCode !== 0)).toBe(true)
  })

  test('reports successful matching hooks', async () => {
    const { run, calls } = fakeRunner({
      'tsc --noEmit': { exitCode: 0, stdout: 'ok' },
    })
    const out = await runFileChangeHooks({
      files: ['README.md'],
      cwd: '/repo',
      hooks,
      runCommand: run,
    })

    expect(calls).toEqual(['tsc --noEmit'])
    expect(jsonValue(out)).toEqual([
      { hookName: 'typecheck', exitCode: 0, stdout: 'ok', stderr: '' },
    ])
  })

  test('normalizes missing hook stdout and stderr to JSON-safe strings', async () => {
    const run = (async () => [
      {
        type: 'json' as const,
        value: { exitCode: 0, stdout: undefined, stderr: undefined },
      },
    ]) as any

    const out = await runFileChangeHooks({
      files: ['README.md'],
      cwd: '/repo',
      hooks: [{ name: 'typecheck', command: 'tsc --noEmit' }],
      runCommand: run,
    })

    expect(jsonValue(out)).toEqual([
      { hookName: 'typecheck', exitCode: 0, stdout: '', stderr: '' },
    ])
  })

  test('reports when configured hooks are skipped because none match', async () => {
    const { run, calls } = fakeRunner({})
    const out = await runFileChangeHooks({
      files: ['README.md'],
      cwd: '/repo',
      hooks: [{ command: 'tsc', filePattern: '**/*.ts' }],
      runCommand: run,
    })
    expect(calls).toEqual([])
    expect(jsonValue(out)).toEqual([
      {
        validationStatus: 'hooks_skipped',
        message:
          'Configured file-change hooks were skipped because none matched the changed files.',
        configuredHookCount: 1,
        changedFiles: ['README.md'],
      },
    ])
  })

  test('runs matching hooks in parallel and preserves result order', async () => {
    // The first matching hook (typecheck) is intentionally slower so it
    // completes after the second (test-ts). This exercises out-of-order
    // completion while asserting results stay in `matching` order.
    const completionOrder: string[] = []
    const run = (async (params: { command: string }) => {
      if (params.command === 'tsc --noEmit') {
        await new Promise((resolve) => setTimeout(resolve, 50))
        completionOrder.push('typecheck')
      } else {
        completionOrder.push('test-ts')
      }
      return [
        {
          type: 'json' as const,
          value: { exitCode: 0, stdout: '', stderr: '' },
        },
      ] as CodebuffToolOutput<'run_terminal_command'>
    }) as any
    const out = await runFileChangeHooks({
      files: ['src/a.ts'],
      cwd: '/repo',
      hooks,
      runCommand: run,
    })
    const results = jsonValue(out)
    expect(results).toBeDefined()
    expect(results).toHaveLength(2)
    // Completion happened out of order: test-ts finished before typecheck.
    expect(completionOrder).toEqual(['test-ts', 'typecheck'])
    // ...but results are in `matching` order regardless of completion order.
    expect(results![0]).toMatchObject({ hookName: 'typecheck', exitCode: 0 })
    expect(results![1]).toMatchObject({ hookName: 'test-ts', exitCode: 0 })
  })

  test('forwards per-hook timeoutSeconds to runCommand', async () => {
    const { run, paramsList } = fakeRunner({
      tsc: { exitCode: 0 },
    })
    const out = await runFileChangeHooks({
      files: ['src/a.ts'],
      cwd: '/repo',
      hooks: [{ name: 'slow', command: 'tsc', timeoutSeconds: 30 }],
      runCommand: run,
    })
    const results = jsonValue(out)
    expect(results).toBeDefined()
    expect(results).toHaveLength(1)
    expect(results![0]).toMatchObject({ hookName: 'slow', exitCode: 0 })
    // The configured 30s bound is forwarded instead of the unbounded default.
    expect(paramsList).toHaveLength(1)
    expect(paramsList[0]).toMatchObject({
      command: 'tsc',
      timeout_seconds: 30,
    })
  })

  test('forwards the default 300s bound when a hook omits timeoutSeconds', async () => {
    const { run, paramsList } = fakeRunner({
      tsc: { exitCode: 0 },
    })
    const out = await runFileChangeHooks({
      files: ['src/a.ts'],
      cwd: '/repo',
      hooks: [{ name: 'typecheck', command: 'tsc' }],
      runCommand: run,
    })
    const results = jsonValue(out)
    expect(results).toBeDefined()
    expect(results).toHaveLength(1)
    expect(results![0]).toMatchObject({ hookName: 'typecheck', exitCode: 0 })
    // No per-hook bound configured: the deliberate 300s default is forwarded.
    expect(paramsList).toHaveLength(1)
    expect(paramsList[0]).toMatchObject({
      command: 'tsc',
      timeout_seconds: 300,
    })
  })

  test('treats an explicit timeoutSeconds of -1 as an unbounded opt-out', async () => {
    const { run, paramsList } = fakeRunner({
      tsc: { exitCode: 0 },
    })
    await runFileChangeHooks({
      files: ['src/a.ts'],
      cwd: '/repo',
      hooks: [{ name: 'typecheck', command: 'tsc', timeoutSeconds: -1 }],
      runCommand: run,
    })
    // The explicit -1 is honored instead of being replaced by the default.
    expect(paramsList[0]).toMatchObject({
      command: 'tsc',
      timeout_seconds: -1,
    })
  })

  test('rethrows the signal reason instead of reporting cancelled hooks as failures', async () => {
    // Every hook runs with `params.signal`, so a cancelled validation rejects
    // them all. Mapping those rejections into ordinary `errorMessage` entries
    // reported an abort as a set of failing hooks, which the caller could not
    // distinguish from a genuine failure. The signal's own reason must surface.
    const controller = new AbortController()
    const abortReason = new Error('run cancelled by the user')
    const run = (async () => {
      controller.abort(abortReason)
      throw abortReason
    }) as any

    const outcome = runFileChangeHooks({
      files: ['src/a.ts'],
      cwd: '/repo',
      hooks: [{ name: 'typecheck', command: 'tsc --noEmit' }],
      runCommand: run,
      signal: controller.signal,
    })

    await expect(outcome).rejects.toBe(abortReason)
  })

  test('keeps mapping genuine hook rejections when the run is not cancelled', async () => {
    // The mirror case: a hook that fails on its own still reports a per-hook
    // errorMessage rather than rejecting the whole tool call.
    const controller = new AbortController()
    const run = (async () => {
      throw new Error('hook blew up')
    }) as any

    const out = await runFileChangeHooks({
      files: ['src/a.ts'],
      cwd: '/repo',
      hooks: [{ name: 'typecheck', command: 'tsc --noEmit' }],
      runCommand: run,
      signal: controller.signal,
    })

    expect(jsonValue(out)).toEqual([
      { errorMessage: 'Hook "typecheck" failed to run: hook blew up' },
    ])
  })

  test('runs per-file syntax hooks only for safe matching changed files', async () => {
    const { run, calls } = fakeRunner({
      "php -l 'src/a.php' && php -l 'src/space file.php'": { exitCode: 0 },
    })
    await runFileChangeHooks({
      files: ['src/a.php', 'src/space file.php', '../outside.php', 'README.md'],
      cwd: '/repo',
      hooks: [
        {
          name: 'php syntax',
          command: 'php -l',
          filePattern: '**/*.php',
          runPerFile: true,
        },
      ],
      runCommand: run,
    })

    expect(calls).toEqual(["php -l 'src/a.php' && php -l 'src/space file.php'"])
  })

  test('reports a per-file hook whose only matching changed files escape the cwd without running a command', async () => {
    const { run, calls } = fakeRunner({})
    const out = await runFileChangeHooks({
      files: ['src/../outside.php'],
      cwd: '/repo',
      hooks: [
        {
          name: 'php syntax',
          command: 'php -l',
          filePattern: '**/*.php',
          runPerFile: true,
        },
      ],
      runCommand: run,
    })

    expect(calls).toEqual([])
    // A hook whose only matching changed files are unsafe matches nothing, so
    // the run-level envelope reports hooks_skipped (the shape runFileChangeHooks
    // actually produces when no hook has a safe file to run).
    expect(jsonValue(out)).toEqual([
      {
        configuredHookCount: 1,
        changedFiles: ['src/../outside.php'],
        message:
          'Configured file-change hooks were skipped because none matched the changed files.',
        validationStatus: 'hooks_skipped',
      },
    ])
  })

  test('truncates hook output at the bounded character cap', async () => {
    const longStdout = 'x'.repeat(7000)
    const { run } = fakeRunner({
      'tsc --noEmit': { exitCode: 0, stdout: longStdout },
    })
    const out = await runFileChangeHooks({
      files: ['src/a.ts'],
      cwd: '/repo',
      hooks: [{ name: 'typecheck', command: 'tsc --noEmit' }],
      runCommand: run,
    })

    expect(jsonValue(out)).toEqual([
      {
        hookName: 'typecheck',
        exitCode: 0,
        stdout: 'x'.repeat(6000) + '\n…[truncated]',
        stderr: '',
      },
    ])
  })

  test('adds structured diagnostics without discarding native output', async () => {
    const { run } = fakeRunner({
      'npx --no-install tsc --noEmit': {
        exitCode: 2,
        stderr: '/repo/src/a.ts(2,4): error TS2322: Type mismatch',
      },
    })
    const out = await runFileChangeHooks({
      files: ['src/a.ts'],
      cwd: '/repo',
      hooks: [{ name: 'typecheck', command: 'npx --no-install tsc --noEmit' }],
      runCommand: run,
    })

    expect(jsonValue(out)?.[0]).toMatchObject({
      hookName: 'typecheck',
      exitCode: 2,
      diagnostics: [
        {
          file: 'src/a.ts',
          severity: 'error',
          code: 'TS2322',
          message: 'Type mismatch',
          command: 'npx --no-install tsc --noEmit',
        },
      ],
    })
  })

  test('infers hooks from project manifests when none are supplied', async () => {
    // The default path (no `hooks`, no `fileSystem`) runs the async snapshot,
    // so manifests on disk drive the hooks that actually execute.
    await withTempDirAsync(async (dir) => {
      writeFileSync(
        path.join(dir, 'package.json'),
        JSON.stringify({ scripts: { lint: 'custom-lint' } }),
      )
      const { run, calls } = fakeRunner({ "npm run 'lint'": { exitCode: 0 } })

      const out = await runFileChangeHooks({
        files: ['src/a.ts'],
        cwd: dir,
        runCommand: run,
      })

      expect(calls).toEqual(["npm run 'lint'"])
      expect(jsonValue(out)?.[0]).toMatchObject({
        hookName: 'script:lint',
        exitCode: 0,
      })
    })
  })
})

describe('inferFileChangeHooks', () => {
  test('prefers explicit package scripts and the declared package manager', () => {
    withTempDir((dir) => {
      writeFileSync(
        path.join(dir, 'package.json'),
        JSON.stringify({
          packageManager: 'pnpm@10.0.0',
          scripts: { lint: 'custom-lint', typecheck: 'custom-typecheck' },
          devDependencies: { eslint: '^9.0.0', typescript: '^5.0.0' },
        }),
      )

      expect(inferFileChangeHooks(dir)).toEqual([
        {
          name: 'script:lint',
          command: "pnpm run 'lint'",
          filePattern: '**/*.{js,jsx,mjs,cjs,ts,tsx,mts,cts}',
        },
        {
          name: 'script:typecheck',
          command: "pnpm run 'typecheck'",
          filePattern: '**/*.{ts,tsx,mts,cts}',
        },
      ])
    })
  })

  test.each([
    ['npm', undefined, 'npx --no-install'],
    ['bun', 'bun@1.3.14', 'bunx --no-install'],
    ['pnpm', 'pnpm@10.0.0', 'pnpm exec'],
    ['yarn', 'yarn@4.0.0', 'yarn exec'],
  ])(
    'uses %s local dependency executables without allowing package downloads',
    (_manager, packageManager, executablePrefix) => {
      withTempDir((dir) => {
        writeFileSync(
          path.join(dir, 'package.json'),
          JSON.stringify({
            ...(packageManager ? { packageManager } : {}),
            devDependencies: { eslint: '^9.0.0', typescript: '^5.0.0' },
          }),
        )

        expect(inferFileChangeHooks(dir)).toEqual([
          {
            name: 'lint',
            command: `${executablePrefix} eslint .`,
            filePattern: '**/*.{js,jsx,mjs,cjs,ts,tsx,mts,cts}',
          },
          {
            name: 'typecheck',
            command: `${executablePrefix} tsc --noEmit`,
            filePattern: '**/*.{ts,tsx,mts,cts}',
          },
        ])
      })
    },
  )

  test('a cache clear during an in-flight snapshot is not resurrected', async () => {
    // `clearFileChangeHooksCache()` is the documented escape hatch for a caller
    // that just scaffolded manifests and wants the next run to see them. A
    // snapshot already in flight used to republish its pre-clear hooks with a
    // fresh 5s TTL, so the caller got the old answer for another full window.
    await withTempDirAsync(async (dir) => {
      writeFileSync(
        path.join(dir, 'package.json'),
        JSON.stringify({ scripts: { lint: 'custom-lint' } }),
      )
      clearFileChangeHooksCache()

      const before = __getManifestSnapshotCountForTest()
      // Started, not awaited: the pending entry is stored synchronously.
      const inFlight = inferFileChangeHooksAsync(dir)
      clearFileChangeHooksCache()
      await inFlight

      // The pre-clear snapshot did not write its result back, so the next call
      // has to take a NO snapshot-free cache hit: it must re-snapshot.
      const second = await inferFileChangeHooksAsync(dir)
      expect(second).toEqual([
        {
          name: 'script:lint',
          command: "npm run 'lint'",
          filePattern: '**/*.{js,jsx,mjs,cjs,ts,tsx,mts,cts}',
        },
      ])
      expect(__getManifestSnapshotCountForTest() - before).toBe(2)

      // ...and that second snapshot IS cached, so the TTL still works.
      await inferFileChangeHooksAsync(dir)
      expect(__getManifestSnapshotCountForTest() - before).toBe(2)
    })
  })

  test('ignores malformed package.json while preserving other inferred hooks', () => {
    withTempDir((dir) => {
      writeFileSync(path.join(dir, 'package.json'), '{bad json')
      writeFileSync(path.join(dir, 'go.mod'), 'module demo\n')

      expect(inferFileChangeHooks(dir)).toEqual([
        {
          name: 'gofmt',
          command: `gofmt -l . | awk 'NF { found=1 } END { exit found ? 1 : 0 }'`,
          filePattern: '**/*.go',
        },
        { name: 'go vet', command: 'go vet ./...', filePattern: '**/*.go' },
        { name: 'go test', command: 'go test ./...', filePattern: '**/*.go' },
      ])
    })
  })

  test('infers non-mutating default linter hooks from language manifests', () => {
    withTempDir((dir) => {
      writeFileSync(path.join(dir, 'Cargo.toml'), '[package]\nname = "demo"\n')
      writeFileSync(path.join(dir, 'requirements.txt'), 'ruff\n')
      writeFileSync(path.join(dir, 'go.mod'), 'module demo\n')
      writeFileSync(
        path.join(dir, 'Gemfile'),
        'source "https://rubygems.org"\ngem "rubocop"\n',
      )
      writeFileSync(
        path.join(dir, 'Package.swift'),
        '// swift-tools-version: 5.9\n',
      )
      mkdirSync(path.join(dir, 'app'))
      writeFileSync(path.join(dir, 'app', 'Demo.csproj'), '<Project />\n')

      expect(inferFileChangeHooks(dir)).toEqual([
        {
          name: 'gofmt',
          command: `gofmt -l . | awk 'NF { found=1 } END { exit found ? 1 : 0 }'`,
          filePattern: '**/*.go',
        },
        { name: 'go vet', command: 'go vet ./...', filePattern: '**/*.go' },
        { name: 'go test', command: 'go test ./...', filePattern: '**/*.go' },
        {
          name: 'dotnet format',
          command:
            "dotnet format 'app/Demo.csproj' --verify-no-changes --no-restore",
          filePattern: '**/*.{cs,csproj,sln}',
        },
        {
          name: 'dotnet build',
          command: "dotnet build 'app/Demo.csproj' --nologo --no-restore",
          filePattern: '**/*.{cs,csproj,sln}',
        },
        {
          name: 'dotnet test',
          command: "dotnet test 'app/Demo.csproj' --nologo --no-restore",
          filePattern: '**/*.{cs,csproj,sln}',
        },
        {
          name: 'cargo fmt',
          command: 'cargo fmt --check',
          filePattern: '**/*.rs',
        },
        {
          name: 'cargo clippy',
          command: 'cargo clippy --all-targets --all-features -- -D warnings',
          filePattern: '**/*.rs',
        },
        {
          name: 'cargo test',
          command: 'cargo test --workspace --all-targets',
          filePattern: '**/*.rs',
        },
        { name: 'ruff', command: 'ruff check .', filePattern: '**/*.py' },
        {
          name: 'rubocop',
          command: 'bundle exec rubocop',
          filePattern: '**/*.rb',
        },
        {
          name: 'swift build',
          command: 'swift build --jobs 2',
          filePattern: '**/*.{swift,xcodeproj}',
        },
        {
          name: 'swift test',
          command: 'swift test --parallel',
          filePattern: '**/*.{swift,xcodeproj}',
        },
      ])
    })
  })

  test('infers bounded JVM, PHP, CMake, and Godot validation', () => {
    withTempDir((dir) => {
      writeFileSync(path.join(dir, 'build.gradle.kts'), 'plugins { java }\n')
      writeFileSync(path.join(dir, 'gradlew'), '#!/bin/sh\n')
      writeFileSync(
        path.join(dir, 'composer.json'),
        JSON.stringify({
          scripts: { analyse: 'phpstan analyse' },
          'require-dev': { 'phpstan/phpstan': '^2' },
        }),
      )
      writeFileSync(
        path.join(dir, 'CMakePresets.json'),
        JSON.stringify({
          buildPresets: [{ name: 'debug', configurePreset: 'debug' }],
        }),
      )
      writeFileSync(path.join(dir, 'project.godot'), '[application]\n')

      expect(inferFileChangeHooks(dir)).toEqual([
        {
          name: 'gradle check',
          command:
            './gradlew --no-daemon --console=plain --max-workers=2 check',
          filePattern: '**/*.{java,kt,kts,gradle}',
        },
        {
          name: 'composer validate',
          command: 'composer validate --no-check-publish --no-interaction',
          filePattern: '**/composer.{json,lock}',
        },
        {
          name: 'composer:analyse',
          command: "composer run-script --no-interaction 'analyse'",
          filePattern: '**/*.php',
        },
        {
          name: 'cmake build',
          command: "cmake --build --preset 'debug' --parallel 2",
          filePattern: '**/*.{c,cc,cpp,cxx,h,hh,hpp,hxx}',
        },
        {
          name: 'godot validation',
          command: 'godot --headless --editor --quit --path .',
          filePattern: '**/*.{gd,gdshader,tscn,tres,godot}',
        },
      ])
    })
  })

  test('falls back to changed-file PHP syntax checks when no analyzer is configured', () => {
    withTempDir((dir) => {
      writeFileSync(path.join(dir, 'composer.json'), JSON.stringify({}))

      expect(inferFileChangeHooks(dir)).toEqual([
        {
          name: 'composer validate',
          command: 'composer validate --no-check-publish --no-interaction',
          filePattern: '**/composer.{json,lock}',
        },
        {
          name: 'php syntax',
          command: 'php -l',
          filePattern: '**/*.php',
          runPerFile: true,
        },
      ])
    })
  })
})

describe('inferFileChangeHooksAsync', () => {
  test('matches the synchronous reference implementation for a package.json fixture', async () => {
    await withTempDirAsync(async (dir) => {
      writeFileSync(
        path.join(dir, 'package.json'),
        JSON.stringify({
          packageManager: 'bun@1.3.14',
          scripts: { lint: 'custom-lint' },
          devDependencies: { typescript: '^5.0.0' },
        }),
      )
      writeFileSync(path.join(dir, 'go.mod'), 'module demo\n')
      // A nested .csproj exercises the recursive project walk, so the async
      // dotnet target search is compared against the sync one too.
      mkdirSync(path.join(dir, 'app'))
      writeFileSync(path.join(dir, 'app', 'Demo.csproj'), '<Project />\n')

      const expected = inferFileChangeHooks(dir)
      expect(expected.map((hook) => hook.name)).toContain('dotnet format')
      expect(await inferFileChangeHooksAsync(dir)).toEqual(expected)
    })
  })

  test('takes one snapshot per cwd across consecutive runs until the cache is cleared', async () => {
    await withTempDirAsync(async (dir) => {
      writeFileSync(
        path.join(dir, 'package.json'),
        JSON.stringify({ scripts: { lint: 'custom-lint' } }),
      )
      const { run, calls } = fakeRunner({})

      const first = await runFileChangeHooks({
        files: ['src/a.ts'],
        cwd: dir,
        runCommand: run,
      })
      expect(calls).toEqual(["npm run 'lint'"])

      // A manifest added inside the TTL window is deliberately unseen: the
      // second invocation serves the cached hooks instead of re-walking the
      // tree, which is exactly the per-Enter cost this cache removes.
      writeFileSync(path.join(dir, 'go.mod'), 'module demo\n')
      const second = await runFileChangeHooks({
        files: ['src/a.ts'],
        cwd: dir,
        runCommand: run,
      })
      expect(second).toEqual(first)
      expect(calls).toEqual(["npm run 'lint'", "npm run 'lint'"])

      // Clearing forces a fresh snapshot, which now sees go.mod's Go hooks.
      // The Go hooks carry a `**/*.go` filePattern, so this call must pass a
      // Go file for selectMatchingHooks to run them — a `.ts` input would
      // correctly match nothing and run no hooks at all.
      clearFileChangeHooksCache()
      await runFileChangeHooks({
        files: ['src/a.go'],
        cwd: dir,
        runCommand: run,
      })
      expect(calls).toContain('go vet ./...')
    })
  })

  test('the production adapter call shape takes one snapshot and one walk across consecutive runs', async () => {
    // Production never takes the adapter-LESS branch: sdk/src/run.ts dispatches
    // run_file_change_hooks with `fileSystem: fs` on every call, so a cache that
    // only covered `inferFileChangeHooksAsync` was dead on the live path and the
    // Enter/lint-gate cost stayed at one full snapshot per call. This pins the
    // shape that actually ships: two consecutive adapter-backed runs cost one
    // manifest snapshot AND one dotnet walk, not one of each per call.
    await withTempDirAsync(async (dir) => {
      writeFileSync(
        path.join(dir, 'package.json'),
        JSON.stringify({ scripts: { lint: 'custom-lint' } }),
      )
      mkdirSync(path.join(dir, 'app'))
      writeFileSync(path.join(dir, 'app', 'Demo.csproj'), '<Project />\n')
      const fileSystem = createNodeFileSystem()
      const { run } = fakeRunner({})
      const snapshotsBefore = __getManifestSnapshotCountForTest()
      const walksBefore = __getDotnetWalkCountForTest()

      const first = await runFileChangeHooks({
        files: ['src/a.cs'],
        cwd: dir,
        fileSystem,
        runCommand: run,
      })
      const second = await runFileChangeHooks({
        files: ['src/a.cs'],
        cwd: dir,
        fileSystem,
        runCommand: run,
      })

      expect(__getManifestSnapshotCountForTest() - snapshotsBefore).toBe(1)
      expect(__getDotnetWalkCountForTest() - walksBefore).toBe(1)
      expect(second).toEqual(first)
      // The cached answer is the same one the sync reference infers, so the
      // cache cannot change which hooks run.
      expect(jsonValue(first)?.map((entry) => entry.hookName)).toEqual([
        'dotnet format',
        'dotnet build',
        'dotnet test',
      ])
      expect(inferFileChangeHooks(dir).map((hook) => hook.name)).toEqual([
        'script:lint',
        'dotnet format',
        'dotnet build',
        'dotnet test',
      ])

      // Clearing costs exactly one more of each phase: the TTL window is the
      // whole saving, never a batch per caller.
      clearFileChangeHooksCache()
      await runFileChangeHooks({
        files: ['src/a.cs'],
        cwd: dir,
        fileSystem,
        runCommand: run,
      })
      expect(__getManifestSnapshotCountForTest() - snapshotsBefore).toBe(2)
      expect(__getDotnetWalkCountForTest() - walksBefore).toBe(2)
    })
  })

  test('overlapping adapter-backed runs share one snapshot', async () => {
    await withTempDirAsync(async (dir) => {
      writeFileSync(
        path.join(dir, 'package.json'),
        JSON.stringify({ scripts: { lint: 'custom-lint' } }),
      )
      const fileSystem = createNodeFileSystem()
      const { run } = fakeRunner({})
      const snapshotsBefore = __getManifestSnapshotCountForTest()

      // A burst of Enter presses starts every caller before the first snapshot
      // resolves, so a missing in-flight entry would take one snapshot per
      // caller on the production path.
      await Promise.all([
        runFileChangeHooks({ files: ['src/a.ts'], cwd: dir, fileSystem, runCommand: run }),
        runFileChangeHooks({ files: ['src/a.ts'], cwd: dir, fileSystem, runCommand: run }),
        runFileChangeHooks({ files: ['src/a.ts'], cwd: dir, fileSystem, runCommand: run }),
      ])

      expect(__getManifestSnapshotCountForTest() - snapshotsBefore).toBe(1)
    })
  })

  test('the adapter snapshot bounds its fan-out instead of queueing every probe', async () => {
    // The adapter path used to queue all 36 manifest probes as one
    // `Promise.all` and then walk the tree one serial `stat` per entry, so on
    // the production path a cache miss was both unbounded and fully serial. The
    // cache and this bound are separate regressions: a change that kept the
    // cache but restored the unbounded fan-out would leave every snapshot and
    // walk count in the baselines above identical.
    await withTempDirAsync(async (dir) => {
      writeFileSync(
        path.join(dir, 'package.json'),
        JSON.stringify({ scripts: { lint: 'custom-lint' } }),
      )
      // A wide tree so the walk's listing and stat passes have plenty to queue.
      for (let index = 0; index < 24; index++) {
        mkdirSync(path.join(dir, `pkg-${index}`))
        writeFileSync(path.join(dir, `pkg-${index}`, 'Zeta.csproj'), '<Project />\n')
      }
      const { run } = fakeRunner({})
      __resetSnapshotMaxProbesInFlightForTest()

      await runFileChangeHooks({
        files: ['src/a.cs'],
        cwd: dir,
        fileSystem: createNodeFileSystem(),
        runCommand: run,
      })

      const inFlight = __getSnapshotMaxProbesInFlightForTest()
      // 36 manifest probes plus 25 walked entries were never all queued at once.
      expect(inFlight).toBeLessThanOrEqual(
        SNAPSHOT_FAN_OUT_WIDTH * SNAPSHOT_PHASE_COUNT,
      )
      // ...and the bound is a batch, not a serial loop.
      expect(inFlight).toBeGreaterThan(1)
    })
  })

  test('the adapter-less snapshot bounds its fan-out through the same observable', async () => {
    // `inferFileChangeHooksAsync` runs `collectManifestSnapshotAsync`, and that
    // path used to issue all 36 manifest probes through one unbounded
    // `Promise.all` with no `trackSnapshotProbe` wiring — so a regression here
    // kept every snapshot/walk counter and the adapter-only assertion above
    // green while restoring the full probe wash on the shared libuv pool. This
    // drives the shipped default path and holds it to the same high-water mark.
    await withTempDirAsync(async (dir) => {
      writeFileSync(
        path.join(dir, 'package.json'),
        JSON.stringify({ scripts: { lint: 'custom-lint' } }),
      )
      mkdirSync(path.join(dir, 'app'))
      writeFileSync(path.join(dir, 'app', 'Demo.csproj'), '<Project />\n')
      __resetSnapshotMaxProbesInFlightForTest()

      await inferFileChangeHooksAsync(dir)

      const inFlight = __getSnapshotMaxProbesInFlightForTest()
      expect(inFlight).toBeLessThanOrEqual(
        SNAPSHOT_FAN_OUT_WIDTH * SNAPSHOT_PHASE_COUNT,
      )
      // ...and the bound is a batch, not a serial loop.
      expect(inFlight).toBeGreaterThan(1)
    })
  })

  test('the adapter dotnet walk never lists directories its entry budget would discard', async () => {
    // Both walks spend ONE shared entry budget (MAX_PROJECT_SCAN_ENTRIES). Once
    // the root level has charged its directories, the level below is wider than
    // what the budget still has room for — the shape a monorepo produces. The
    // adapter walk used to list that whole level and only then charge its
    // entries, so it readdir'ed and materialised a name list per directory and
    // discarded nearly all of them; the node twin stops at the budget and
    // discoverNamedFilesAsync trims its batch before dispatch for the same
    // reason. A synthetic adapter keeps this exact and cheap: the tree is
    // described in memory, so the only cost is the walk itself.
    await withTempDirAsync(async (dir) => {
      const packageNames = Array.from(
        { length: SYNTHETIC_PACKAGE_COUNT },
        (_, index) => `pkg-${String(index).padStart(4, '0')}`,
      )
      const packagePaths = new Set(
        packageNames.map((name) => path.join(dir, name)),
      )
      const readdirPaths: string[] = []
      const directoryStats = {
        isFile: () => false,
        isDirectory: () => true,
        size: 0,
      }
      const fileStats = { isFile: () => true, isDirectory: () => false, size: 1 }

      const syntheticFileSystem = {
        // Every manifest probe misses, so the hook list is the dotnet walk's.
        stat: async (filePath: string) => {
          if (filePath === dir) return directoryStats
          if (packagePaths.has(filePath)) return directoryStats
          const { dir: parent, base } = path.parse(filePath)
          if (packagePaths.has(parent) && base !== 'package.json') {
            return fileStats
          }
          throw new Error('missing')
        },
        readFile: async () => {
          throw new Error('missing')
        },
        readdir: async (filePath: string) => {
          readdirPaths.push(filePath)
          if (filePath === dir) return packageNames
          const name = path.basename(filePath)
          const files = Array.from(
            { length: SYNTHETIC_ENTRIES_PER_PACKAGE },
            (_, index) => `f${index}.txt`,
          )
          // The lowest-sorting package carries the target, so the trimmed walk
          // must still reach it and select it.
          return name === packageNames[0] ? [...files, 'Alpha.csproj'] : files
        },
      } as unknown as CodebuffFileSystem

      const inferred = await inferFileChangeHooksFromFileSystem(
        dir,
        syntheticFileSystem,
      )

      // Target selection is unchanged: entries are still consumed in sorted
      // directory-then-name order, so the same workspace target is chosen.
      expect(
        inferred.find((hook) => hook.name === 'dotnet build')?.command,
      ).toContain("'pkg-0000/Alpha.csproj'")
      // One listing for the root, then only as many as the remaining budget can
      // charge — never one per directory in the level.
      const budgetAfterRoot = MAX_PROJECT_SCAN_ENTRIES - SYNTHETIC_PACKAGE_COUNT
      expect(readdirPaths.length).toBe(1 + budgetAfterRoot)
      expect(readdirPaths.length).toBeLessThan(SYNTHETIC_PACKAGE_COUNT)
      // ...which is also under the budget divided by the entries one listed
      // directory yields: the bound the untrimmed walk broke.
      expect(readdirPaths.length).toBeLessThanOrEqual(
        Math.ceil(MAX_PROJECT_SCAN_ENTRIES / SYNTHETIC_ENTRIES_PER_PACKAGE),
      )
    })
  }, 60_000)

  test('a different adapter does not inherit another adapter\'s cached hooks', async () => {
    await withTempDirAsync(async (dir) => {
      writeFileSync(
        path.join(dir, 'package.json'),
        JSON.stringify({ scripts: { lint: 'custom-lint' } }),
      )
      const { run } = fakeRunner({})

      await runFileChangeHooks({
        files: ['src/a.ts'],
        cwd: dir,
        fileSystem: createNodeFileSystem(),
        runCommand: run,
      })

      // An adapter with an opaque view of the project answers every probe with
      // a miss. Keying the cache by cwd alone would serve it the first
      // adapter's hooks, so the second adapter infers nothing.
      const emptyAdapter = {
        stat: async () => {
          throw new Error('missing')
        },
        readFile: async () => {
          throw new Error('missing')
        },
        readdir: async () => [] as string[],
      } as unknown as CodebuffFileSystem
      const out = await runFileChangeHooks({
        files: ['src/a.ts'],
        cwd: dir,
        fileSystem: emptyAdapter,
        runCommand: run,
      })

      expect(jsonValue(out)).toEqual([
        {
          validationStatus: 'no_hooks_configured',
          message: 'No configured file-change hooks ran.',
          changedFiles: ['src/a.ts'],
        },
      ])
    })
  })

  test('takes exactly one manifest snapshot per TTL window', async () => {
    await withTempDirAsync(async (dir) => {
      writeFileSync(
        path.join(dir, 'package.json'),
        JSON.stringify({ scripts: { lint: 'custom-lint' } }),
      )
      const before = __getManifestSnapshotCountForTest()

      await inferFileChangeHooksAsync(dir)
      await inferFileChangeHooksAsync(dir)
      await inferFileChangeHooksAsync(dir)
      expect(__getManifestSnapshotCountForTest() - before).toBe(1)

      // Dropping the cache costs exactly one more snapshot, never a batch per
      // caller: the snapshot is the whole per-Enter walk this cache removes.
      clearFileChangeHooksCache()
      await inferFileChangeHooksAsync(dir)
      expect(__getManifestSnapshotCountForTest() - before).toBe(2)
    })
  })

  test('shares one snapshot across overlapping callers', async () => {
    await withTempDirAsync(async (dir) => {
      writeFileSync(
        path.join(dir, 'package.json'),
        JSON.stringify({ scripts: { lint: 'custom-lint' } }),
      )
      const before = __getManifestSnapshotCountForTest()

      // A burst of Enter presses (an Enter press plus a gate/aux call)
      // overlaps: every caller starts before the first snapshot resolves.
      // Awaiting each call in turn cannot detect a missing in-flight entry,
      // because the resolved entry is in the cache by then, so this starts them
      // all first.
      const results = await Promise.all([
        inferFileChangeHooksAsync(dir),
        inferFileChangeHooksAsync(dir),
        inferFileChangeHooksAsync(dir),
      ])

      expect(__getManifestSnapshotCountForTest() - before).toBe(1)
      // Every caller sees the same inferred hooks, not a divergent partial list.
      expect(results[1]).toEqual(results[0])
      expect(results[2]).toEqual(results[0])
    })
  })

  test('the settled snapshot replaces the in-flight entry for later callers', async () => {
    await withTempDirAsync(async (dir) => {
      writeFileSync(
        path.join(dir, 'package.json'),
        JSON.stringify({ scripts: { lint: 'custom-lint' } }),
      )
      const before = __getManifestSnapshotCountForTest()

      const joined = await Promise.all([
        inferFileChangeHooksAsync(dir),
        inferFileChangeHooksAsync(dir),
      ])
      expect(__getManifestSnapshotCountForTest() - before).toBe(1)

      // The pending form must have been replaced by the resolved one, otherwise
      // this caller would still be joining a group that already finished and
      // the TTL would never be consulted.
      const afterResolve = await inferFileChangeHooksAsync(dir)
      expect(afterResolve).toEqual(joined[0])
      expect(__getManifestSnapshotCountForTest() - before).toBe(1)
    })
  })

  test('concurrent manifest probes keep the inferred hooks identical to the sync walk', async () => {
    await withTempDirAsync(async (dir) => {
      // Several ecosystems at once: the async path stats/reads every known
      // manifest concurrently and then rebuilds existing/contents in
      // KNOWN_PROJECT_PATHS order, so the hook list must still match the sync
      // reference implementation entry for entry.
      writeFileSync(
        path.join(dir, 'package.json'),
        JSON.stringify({ scripts: { lint: 'custom-lint' } }),
      )
      writeFileSync(path.join(dir, 'go.mod'), 'module demo\n')
      writeFileSync(path.join(dir, 'Cargo.toml'), '[package]\nname = "demo"\n')
      writeFileSync(path.join(dir, 'requirements.txt'), 'ruff\n')

      const expected = inferFileChangeHooks(dir)
      expect(expected.length).toBeGreaterThan(1)
      expect(await inferFileChangeHooksAsync(dir)).toEqual(expected)
    })
  })

  test('starts the dotnet walk before awaiting the manifest probes', async () => {
    await withTempDirAsync(async (dir) => {
      writeFileSync(
        path.join(dir, 'package.json'),
        JSON.stringify({ scripts: { lint: 'custom-lint' } }),
      )
      mkdirSync(path.join(dir, 'app'))
      writeFileSync(path.join(dir, 'app', 'Demo.csproj'), '<Project />\n')
      __resetManifestSnapshotPhaseEventsForTest()

      await inferFileChangeHooksAsync(dir)

      // The docblock claims a cache miss costs the slower of the two phases
      // instead of their sum, so both phases must START before either SETTLES.
      // Awaiting the probes first would keep the inferred hooks identical — and
      // every other test green — while restoring the summed latency.
      const events = __getManifestSnapshotPhaseEventsForTest()
      const firstSettle = events.findIndex((entry) => entry.event === 'settle')
      const startedBeforeFirstSettle = events
        .slice(0, firstSettle === -1 ? events.length : firstSettle)
        .filter((entry) => entry.event === 'start')
        .map((entry) => entry.phase)

      expect(startedBeforeFirstSettle).toEqual(['dotnetWalk', 'manifestProbes'])
      expect(events.map((entry) => `${entry.phase}:${entry.event}`)).toEqual(
        expect.arrayContaining([
          'dotnetWalk:start',
          'manifestProbes:start',
          'dotnetWalk:settle',
          'manifestProbes:settle',
        ]),
      )
    })
  })

  test('keeps the phase log bounded instead of retaining every snapshot', async () => {
    await withTempDirAsync(async (dir) => {
      writeFileSync(
        path.join(dir, 'package.json'),
        JSON.stringify({ scripts: { lint: 'custom-lint' } }),
      )
      __resetManifestSnapshotPhaseEventsForTest()

      // The log is test observability that stays wired into the shipped
      // snapshot, and a long session takes a cache miss per TTL window: it has
      // to keep a bounded window rather than one entry set per snapshot ever
      // taken. Each iteration clears the cache to force a real miss.
      const snapshots = 8
      for (let index = 0; index < snapshots; index += 1) {
        clearFileChangeHooksCache()
        await inferFileChangeHooksAsync(dir)
      }

      const events = __getManifestSnapshotPhaseEventsForTest()
      const limit = 16
      // A snapshot logs four entries (a start and a settle per phase), so the
      // retained window is always a whole number of snapshots and the ordering
      // assertion above still sees one complete set.
      expect(events).toHaveLength(limit)
      const lastSnapshot = events.slice(-4)
      const firstSettle = lastSnapshot.findIndex(
        (entry) => entry.event === 'settle',
      )
      expect(
        lastSnapshot.slice(0, firstSettle).map((entry) => entry.phase),
      ).toEqual(['dotnetWalk', 'manifestProbes'])
      // Retention is per retained snapshot, not per snapshot ever taken.
      expect(
        events.filter(
          (entry) => entry.phase === 'dotnetWalk' && entry.event === 'start',
        ),
      ).toHaveLength(limit / 4)
    })
  })

  test('an aborted snapshot stops queueing probes and releases every slot', async () => {
    await withTempDirAsync(async (dir) => {
      writeFileSync(path.join(dir, 'requirements.txt'), 'ruff\n')
      // A level of sibling projects the walk would have to list: with the signal
      // threaded, the walk stops at the first batch boundary instead of
      // readdir'ing them all for a caller that is already gone.
      for (let index = 0; index < 8; index += 1) {
        mkdirSync(path.join(dir, `svc-${index}`))
        writeFileSync(path.join(dir, `svc-${index}`, `Svc${index}.csproj`), '')
      }
      const controller = new AbortController()
      const reason = new Error('cancelled between Enter presses')
      controller.abort(reason)

      await expect(
        inferFileChangeHooksAsync(dir, controller.signal),
      ).rejects.toBe(reason)
      // The gate is process-wide shared state: a cancelled snapshot must leave
      // no slot held, or live work queues behind a caller that no longer exists.
      expect(__getFilesystemSlotsInUseForTest()).toBe(0)
    })
  })

  test('an aborted originator does not reject the joiners sharing its snapshot', async () => {
    // The pending entry used to carry the ORIGINATOR's signal, so one
    // cancelling run rejected the shared snapshot mid-flight and every deduped
    // joiner's run failed with a foreign AbortError it did not cause. The
    // shared snapshot now runs on its own detached controller and every caller
    // — the originator included — registers as a waiter that races only its
    // OWN signal, so an aborting originator stops waiting without taking the
    // completed hooks away from anyone else.
    await withTempDirAsync(async (dir) => {
      writeFileSync(
        path.join(dir, 'package.json'),
        JSON.stringify({ scripts: { lint: 'custom-lint' } }),
      )
      let releaseProbes: () => void = () => {}
      const probeGate = new Promise<void>((resolve) => {
        releaseProbes = resolve
      })
      const fileStats = { isFile: () => true, isDirectory: () => false, size: 1 }
      const fileSystem = {
        stat: async (filePath: string) => {
          await probeGate
          if (filePath.endsWith('package.json')) return fileStats
          throw new Error('missing')
        },
        readFile: async (filePath: string) => {
          if (filePath.endsWith('package.json')) {
            return JSON.stringify({ scripts: { lint: 'custom-lint' } })
          }
          throw new Error('missing')
        },
        // The walk's listing queues behind the gated probes, so the snapshot is
        // still mid-flight when the joiner arrives and the originator aborts.
        readdir: async () => {
          await probeGate
          return [] as string[]
        },
      } as unknown as CodebuffFileSystem
      const snapshotsBefore = __getManifestSnapshotCountForTest()

      const originatorController = new AbortController()
      const originReason = new Error('originator cancelled between Enter presses')
      const originator = inferFileChangeHooksFromFileSystem(
        dir,
        fileSystem,
        originatorController.signal,
      )
      // Same adapter object, so the joiner dedupes onto the originator's
      // in-flight snapshot instead of starting one of its own.
      const joiner = inferFileChangeHooksFromFileSystem(
        dir,
        fileSystem,
        new AbortController().signal,
      )
      originatorController.abort(originReason)

      await expect(originator).rejects.toBe(originReason)
      // Fail-before: the joiner rejected with the ORIGINATOR's reason. The
      // shared snapshot was never the joiner's to lose, so it must complete —
      // and it must be the one shared snapshot, not a private re-run.
      releaseProbes()
      const joined = await joiner
      expect(joined).toEqual([
        {
          name: 'script:lint',
          command: "npm run 'lint'",
          filePattern: '**/*.{js,jsx,mjs,cjs,ts,tsx,mts,cts}',
        },
      ])
      expect(__getManifestSnapshotCountForTest() - snapshotsBefore).toBe(1)
      expect(__getFilesystemSlotsInUseForTest()).toBe(0)
    })
  })

  test('a snapshot whose dotnet walk settles via cancellation is not cached', async () => {
    // The walk's failure catch used to swallow CANCELLATION too: when the run
    // aborted after the manifest probes settled but while the walk was still
    // mid-flight, the snapshot resolved with `dotnetTarget: undefined` and the
    // truncated hook list was published into the TTL cache — later callers were
    // served hooks missing every dotnet entry for up to 5s. A walk settled by
    // cancellation must be treated as a miss: nothing is published, and the
    // next caller re-runs the snapshot instead of inheriting the truncation.
    await withTempDirAsync(async (dir) => {
      let releaseWalk: () => void = () => {}
      const walkGate = new Promise<void>((resolve) => {
        releaseWalk = resolve
      })
      const directoryStats = {
        isFile: () => false,
        isDirectory: () => true,
        size: 0,
      }
      const fileStats = { isFile: () => true, isDirectory: () => false, size: 1 }
      // The walk stats the root, then the `app` directory readdir returns, so
      // both must present as directories for the fresh walk to descend to the
      // .csproj the gated listing hands back.
      const knownDirs = new Set([dir, path.join(dir, 'app')])
      const fileSystem = {
        // Every manifest probe misses immediately, so the probes phase settles
        // long before the gated walk does.
        stat: async (filePath: string) => {
          if (knownDirs.has(filePath)) return directoryStats
          if (/\.csproj$/.test(filePath)) return fileStats
          throw new Error('missing')
        },
        readFile: async () => {
          throw new Error('missing')
        },
        readdir: async (filePath: string) => {
          await walkGate
          return filePath === dir ? ['app'] : ['Alpha.csproj']
        },
      } as unknown as CodebuffFileSystem
      const controller = new AbortController()
      const reason = new Error('cancelled while the walk was in flight')
      const walksBefore = __getDotnetWalkCountForTest()

      const aborted = inferFileChangeHooksFromFileSystem(
        dir,
        fileSystem,
        controller.signal,
      )
      // Let the probes settle so the abort lands in the window the old catch
      // swallowed: probes done, walk still pending on the gate.
      await new Promise((resolve) => setTimeout(resolve, 10))
      controller.abort(reason)
      releaseWalk()
      // Fail-before: this RESOLVED with the truncated (empty) hook list.
      await expect(aborted).rejects.toBe(reason)

      // The truncated snapshot was not published: the next caller pays for a
      // fresh walk and gets the COMPLETE hook list, not the cached miss.
      const after = await inferFileChangeHooksFromFileSystem(dir, fileSystem)
      expect(after.map((hook) => hook.name)).toEqual([
        'dotnet format',
        'dotnet build',
        'dotnet test',
      ])
      expect(__getDotnetWalkCountForTest() - walksBefore).toBe(2)
      expect(__getFilesystemSlotsInUseForTest()).toBe(0)
    })
  })

  test('the level-parallel dotnet walk matches the sync walk for sibling projects', async () => {
    await withTempDirAsync(async (dir) => {
      writeFileSync(path.join(dir, 'requirements.txt'), 'ruff\n')
      // Two sibling projects at one depth whose sorted order is the opposite
      // of their creation order: the level-parallel walk must still select the
      // same target as the depth-first sync walk.
      mkdirSync(path.join(dir, 'svc-b'))
      mkdirSync(path.join(dir, 'svc-a'))
      writeFileSync(path.join(dir, 'svc-b', 'Zeta.csproj'), '<Project />\n')
      writeFileSync(path.join(dir, 'svc-a', 'Alpha.csproj'), '<Project />\n')

      const expected = inferFileChangeHooks(dir)
      expect(
        expected.find((hook) => hook.name === 'dotnet build')?.command,
      ).toContain("'svc-a/Alpha.csproj'")
      expect(await inferFileChangeHooksAsync(dir)).toEqual(expected)
    })
  })
})

describe('mergeFileChangeHooks — concat-with-dedup (R3c)', () => {
  test('returns [] when both base and override are empty', () => {
    expect(mergeFileChangeHooks([], [])).toEqual([])
    expect(mergeFileChangeHooks(undefined, undefined)).toEqual([])
  })

  test('appends override-only entries after base entries (base-first ordering)', () => {
    const base: FileChangeHook[] = [
      { name: 'typecheck', command: 'tsc --noEmit' },
    ]
    const override: FileChangeHook[] = [
      { name: 'lint', command: 'eslint .', filePattern: 'src/**' },
    ]
    const merged = mergeFileChangeHooks(base, override)
    expect(merged.map((h) => h.name)).toEqual(['typecheck', 'lint'])
  })

  test('override entry wins on conflict and keeps the base entry position', () => {
    const base: FileChangeHook[] = [
      {
        name: 'typecheck',
        command: 'tsc --noEmit',
        filePattern: 'src/**/*.ts',
      },
    ]
    const override: FileChangeHook[] = [
      {
        name: 'typecheck',
        command: 'tsc --noEmit',
        filePattern: 'src/**/*.ts',
        timeoutSeconds: 60,
      },
    ]
    const merged = mergeFileChangeHooks(base, override)
    expect(merged).toHaveLength(1)
    // Override wins: the per-hook timeout from the override entry is preserved
    // in the base entry's slot (project tunes a global hook without reordering).
    expect(merged[0]).toEqual({
      name: 'typecheck',
      command: 'tsc --noEmit',
      filePattern: 'src/**/*.ts',
      timeoutSeconds: 60,
    })
  })

  test('dedups by command + filePattern + name across base and override', () => {
    const base: FileChangeHook[] = [
      { name: 'typecheck', command: 'tsc --noEmit' },
      { name: 'typecheck', command: 'tsc --noEmit' }, // exact dup within base
      { name: 'lint', command: 'eslint .' },
    ]
    const override: FileChangeHook[] = [
      { name: 'typecheck', command: 'tsc --noEmit', timeoutSeconds: 90 },
      { name: 'test', command: 'bun test' },
    ]
    const merged = mergeFileChangeHooks(base, override)
    // base typecheck (first slot, overridden → override entry), base lint, override test
    expect(merged.map((h) => h.name)).toEqual(['typecheck', 'lint', 'test'])
    expect(merged[0]).toMatchObject({ timeoutSeconds: 90 })
  })
})

describe('run_file_change_hooks outputSchema covers the diagnostic-delta shapes', () => {
  // Schema-faithful runner: real runTerminalCommand output carries `command`,
  // which the terminalCommandOutputSchema arm of the output schema requires.
  const schemaRunner = (async () =>
    [
      {
        type: 'json' as const,
        value: {
          command: 'tsc --noEmit',
          exitCode: 0,
          stdout: '',
          stderr: '',
        },
      },
    ]) as any

  test('a diagnostic_delta_rejected result parses against the declared outputSchema', async () => {
    const out = await runFileChangeHooks({
      files: ['src/a.ts'],
      cwd: '/repo',
      env: { OPENBUFF_DIAGNOSTIC_PREFLIGHT: '1' },
      hooks: [{ name: 'typecheck', command: 'tsc --noEmit' }],
      runCommand: schemaRunner,
      diagnosticDelta: async () => ({
        rejected: true,
        newDiagnostics: [
          {
            file: 'src/a.ts',
            range: {
              start: { line: 2, column: 4 },
              end: { line: 2, column: 10 },
            },
            severity: 'error' as const,
            code: 'TS2322',
            message: 'Type mismatch',
            command: 'tsc --noEmit',
            source: 'tsc',
          },
        ],
        fixIts: [
          {
            file: 'src/a.ts',
            newText: 'const x = 1',
            range: {
              start: { line: 2, column: 4 },
              end: { line: 2, column: 10 },
            },
            applicability: 'machineApplicable' as const,
          },
        ],
      }),
    })

    const results = jsonValue(out)
    const deltaResult = results?.find(
      (result) => result.hookName === 'diagnostic-delta',
    )
    expect(deltaResult).toMatchObject({
      validationStatus: 'diagnostic_delta_rejected',
    })
    // The emitted delta shape must fit the declared outputSchema —
    // schema-parsing consumers previously rejected this arm entirely.
    expect(() =>
      runFileChangeHooksParams.outputSchema.parse(out),
    ).not.toThrow()
  })

  test('a diagnostic_delta_passed result parses against the declared outputSchema', async () => {
    const out = await runFileChangeHooks({
      files: ['src/a.ts'],
      cwd: '/repo',
      env: { OPENBUFF_DIAGNOSTIC_PREFLIGHT: 'true' },
      hooks: [{ name: 'typecheck', command: 'tsc --noEmit' }],
      runCommand: schemaRunner,
      diagnosticDelta: async () => ({ rejected: false }),
    })

    const results = jsonValue(out)
    const deltaResult = results?.find(
      (result) => result.hookName === 'diagnostic-delta',
    )
    expect(deltaResult).toMatchObject({
      validationStatus: 'diagnostic_delta_passed',
    })
    expect(() =>
      runFileChangeHooksParams.outputSchema.parse(out),
    ).not.toThrow()
  })
})
