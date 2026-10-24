#!/usr/bin/env bun

/**
 * CLI test runner: CI's exact discovery + invocation, without a shell.
 *
 * A bare `bun test` in this package discovers every `*.test.ts(x)` under the
 * tree, including `*.integration.test.ts` — live suites that drive a real tmux
 * server. Run that way the CLI suite both diverges from CI's schedule and can
 * appear to hang: with no tmux server running the integration suites throw
 * mid-run instead of skipping, and the leaked handles keep the process alive.
 *
 * This script reproduces `.github/workflows/ci.yml`'s discovery (every
 * `*.test.ts` and `*.test.tsx`, excluding `*.integration.test.ts`) and runs
 * `bun test --isolate` over exactly that list, so the package `test` script and
 * CI are the same invocation.
 *
 * Discovery runs in-process through `node:fs` instead of a `find | sort | tr`
 * pipeline on purpose: this package's `engines` field declares bun only, so its
 * test entry point must not silently require an undeclared POSIX userland that
 * nothing pins or locks. An empty or failed discovery exits non-zero rather
 * than degenerating into bare `bun test` (the known-hanging invocation); CI
 * treats an empty glob as a truth failure and so does this script.
 */

import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

/**
 * Directories never descended into, mirroring CI's `find` prunes. Kept as an
 * explicit set so a new build-output directory must be added deliberately
 * rather than being picked up as a test source tree.
 */
const PRUNED_DIRECTORY_NAMES: ReadonlySet<string> = new Set([
  'node_modules',
  '.git',
  'dist',
])

/**
 * Test-file suffixes CI's discovery excludes. `*.integration.test.ts` suites
 * (`rerender-perf`, `integration-tmux`) drive a real tmux server and are run
 * separately, never as part of the default suite.
 */
const EXCLUDED_TEST_SUFFIXES: readonly string[] = ['.integration.test.ts']

/**
 * Whether `fileName` is a suite the default CLI test run should execute: a
 * `*.test.ts`/`*.test.tsx` file that is not an excluded live-integration suite.
 * Pure and exported so the exclusion contract is unit-tested without touching
 * the filesystem.
 */
export function isCliTestFileName(fileName: string): boolean {
  if (EXCLUDED_TEST_SUFFIXES.some((suffix) => fileName.endsWith(suffix))) {
    return false
  }
  return fileName.endsWith('.test.ts') || fileName.endsWith('.test.tsx')
}

/**
 * Recursively collect the package's test files, returned as sorted
 * POSIX-separated paths relative to `root` (the form `bun test` accepts on
 * every platform). Throws instead of returning a partial list when a directory
 * cannot be read: a silently truncated list would report a vacuous green, which
 * is exactly the failure mode this script exists to prevent.
 */
export function discoverCliTestFiles(root: string): string[] {
  const discovered: string[] = []

  const walk = (directory: string): void => {
    let entries
    try {
      entries = readdirSync(directory, { withFileTypes: true })
    } catch (error) {
      throw new Error(
        `Could not read ${directory} while discovering CLI test files: ${
          error instanceof Error ? error.message : String(error)
        }`,
      )
    }
    for (const entry of entries) {
      const absolutePath = join(directory, entry.name)
      if (entry.isDirectory()) {
        if (PRUNED_DIRECTORY_NAMES.has(entry.name)) continue
        walk(absolutePath)
        continue
      }
      if (!entry.isFile()) continue
      if (!isCliTestFileName(entry.name)) continue
      discovered.push(relative(root, absolutePath).split(sep).join('/'))
    }
  }

  walk(root)
  // Explicit sort: `bun test` schedules files in argv order, so a stable order
  // keeps local runs comparable run-to-run and against CI's sorted glob.
  return discovered.sort()
}

/**
 * Fail closed on an empty discovery. CI has the same guard
 * (`No tests found in <package> ...`), so an empty tree can never be mistaken
 * for a passing suite here either.
 */
export function requireDiscoveredTestFiles(files: readonly string[]): void {
  if (files.length === 0) {
    throw new Error(
      'No test files found in cli (expected *.test.ts / *.test.tsx excluding ' +
        '*.integration.test.ts; the test tree or the checkout is broken)',
    )
  }
}

/**
 * argv for the `bun test` child: isolation always, the discovered files, then
 * any caller-supplied flags (so `bun run test -- --bail=1` still works). Pure
 * and exported so the invocation contract is pinned by a unit test.
 */
export function buildBunTestArgs(
  files: readonly string[],
  extraArgs: readonly string[] = [],
): string[] {
  return ['test', '--isolate', ...files, ...extraArgs]
}

function main(): void {
  const cliRoot = join(import.meta.dir, '..')
  const files = discoverCliTestFiles(cliRoot)
  requireDiscoveredTestFiles(files)

  console.log(
    `Running ${files.length} CLI test files with \`bun test --isolate\` (CI parity).`,
  )

  // NODE_ENV=production matches the previous script's env so the suites still
  // exercise the production React/JSX paths.
  const result = spawnSync(
    process.execPath,
    buildBunTestArgs(files, process.argv.slice(2)),
    {
      cwd: cliRoot,
      stdio: 'inherit',
      env: { ...process.env, NODE_ENV: 'production' },
    },
  )

  if (result.error) {
    throw new Error(
      `Could not run bun test: ${result.error.message}`,
    )
  }
  process.exit(result.status ?? 1)
}

// Guarded so the unit tests can import the pure helpers without spawning the
// suite (same pattern as scripts/build-binary.ts).
if (import.meta.main) {
  try {
    main()
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  }
}
