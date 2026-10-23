import fs from 'fs'
import { readdir, readFile, stat } from 'node:fs/promises'
import path from 'path'

import micromatch from 'micromatch'

import {
  loadProviderConfigSync,
  mergeFileChangeHooks,
} from '../provider-config'
import {
  mapWithConcurrency,
  raceAbort,
  throwIfAborted,
  withFilesystemSlot,
} from './concurrency'
import { parseLanguageDiagnostics } from './language-diagnostics'
import { runTerminalCommand } from './run-terminal-command'

import type { CodebuffToolOutput } from '@codebuff/common/tools/list'
import type { CodebuffFileSystem } from '@codebuff/common/types/filesystem'
import {
  supportedDiagnosticFiles,
  type DiagnosticDeltaPreflightResult,
} from '../services/diagnostic-delta'
import { getSystemProcessEnv } from '../env'

export type FileChangeHook = {
  name?: string
  command: string
  /** Optional glob; the hook runs only when a changed file matches it. */
  filePattern?: string
  /** Optional per-hook wall-clock bound in seconds. Omitted means no timeout. */
  timeoutSeconds?: number
  /** Run the command once per matching changed file instead of project-wide. */
  runPerFile?: boolean
}

// Hooks default to a bounded 300s wall-clock timeout so a hung typecheck/lint
// command cannot stall the agent forever. An explicit -1 in a hook's config is
// a deliberate opt-out (unbounded), and any positive `timeoutSeconds` still
// takes precedence.
const HOOK_DEFAULT_TIMEOUT_SECONDS = 300
const MAX_HOOK_OUTPUT_CHARS = 6000
const MAX_MANIFEST_BYTES = 512_000
const MAX_PROJECT_SCAN_ENTRIES = 2_000
const MAX_PROJECT_SCAN_DEPTH = 5
const MAX_PER_FILE_HOOK_FILES = 50
// Concurrent manifest probes, dotnet-walk directory listings, and dotnet-walk
// entry stats. Same width the module's other async walks use, for the same
// reason: libuv's default thread pool is four threads and it also serves the
// render loop's own fs work.
const HOOK_SNAPSHOT_PROBE_CONCURRENCY = 8

let snapshotProbesInFlight = 0
let snapshotMaxProbesInFlight = 0

/**
 * Test seam: the widest snapshot fan-out (manifest probes plus dotnet-walk
 * listing and stat calls) reached since the last reset.
 *
 * The adapter path used to queue all 36 manifest probes at once and then walk
 * the tree one serial `stat` at a time, so its cost was unobservable from
 * outside. The bound and the cache are pinned separately on purpose: a change
 * that kept the cache but restored the unbounded fan-out would leave every
 * snapshot/walk count identical.
 */
export function __getSnapshotMaxProbesInFlightForTest(): number {
  return snapshotMaxProbesInFlight
}

export function __resetSnapshotMaxProbesInFlightForTest(): void {
  snapshotMaxProbesInFlight = 0
}

/**
 * Runs one snapshot filesystem call under the process-wide fan-out gate, with
 * per-module in-flight bookkeeping.
 *
 * The count rises only after a gate slot is granted, so the high-water mark
 * reports the fan-out the snapshot had actually ISSUED. It is bounded by
 * FILESYSTEM_FANOUT_CONCURRENCY rather than by this module's own width on
 * purpose: `collectManifestSnapshotAsync` starts the dotnet walk alongside the
 * manifest probes, so those two phases overlap by design and a per-phase width
 * of 8 let the pair reach 16 on libuv's four-thread pool — the pool the render
 * loop's own fs work is served from. A per-observable counter alone cannot see
 * that aggregate, which is why the bound moved into the shared gate.
 */
async function trackSnapshotProbe<T>(
  probe: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  return withFilesystemSlot(async () => {
    snapshotProbesInFlight += 1
    if (snapshotProbesInFlight > snapshotMaxProbesInFlight) {
      snapshotMaxProbesInFlight = snapshotProbesInFlight
    }
    try {
      return await probe()
    } finally {
      snapshotProbesInFlight -= 1
    }
  }, signal)
}

const PROJECT_SCAN_EXCLUDED_DIRS = new Set([
  '.git',
  '.gradle',
  '.godot',
  '.idea',
  '.openbuff',
  '.venv',
  'bin',
  'node_modules',
  'build',
  'dist',
  'obj',
  'target',
  'vendor',
])

type PackageJson = {
  scripts?: Record<string, unknown>
  dependencies?: Record<string, unknown>
  devDependencies?: Record<string, unknown>
  packageManager?: unknown
}

type ComposerJson = {
  scripts?: Record<string, unknown>
  require?: Record<string, unknown>
  'require-dev'?: Record<string, unknown>
}

type ManifestSnapshot = {
  existing: Set<string>
  contents: Map<string, string>
  dotnetTarget?: string
}

const KNOWN_PROJECT_PATHS = [
  '.rubocop.yml',
  '.swift-format',
  'bun.lock',
  'bun.lockb',
  'build.gradle',
  'build.gradle.kts',
  'build/CMakeCache.txt',
  'build/meson-private/coredata.dat',
  'build.ninja',
  'Cargo.toml',
  'CMakeLists.txt',
  'CMakePresets.json',
  'composer.json',
  'Gemfile',
  'go.mod',
  'gradlew',
  'gradlew.bat',
  'Makefile',
  'mvnw',
  'mvnw.cmd',
  'package-lock.json',
  'package.json',
  'Package.swift',
  'phpstan.neon',
  'phpstan.neon.dist',
  'pnpm-lock.yaml',
  'pom.xml',
  'project.godot',
  'pyproject.toml',
  'pyrightconfig.json',
  'requirements-dev.txt',
  'requirements.txt',
  'settings.gradle',
  'settings.gradle.kts',
  'tox.ini',
  'yarn.lock',
] as const

/**
 * Hooks that should run for this set of changed files: those with no
 * filePattern (always run) or whose glob matches at least one changed file.
 */
export function selectMatchingHooks(
  hooks: FileChangeHook[],
  files: string[],
): FileChangeHook[] {
  return hooks.filter((hook) => {
    if (!hook.filePattern) return true
    if (files.length === 0) return false
    return micromatch.some(files, hook.filePattern)
  })
}

export function inferFileChangeHooks(cwd: string): FileChangeHook[] {
  return inferHooksFromSnapshot(collectManifestSnapshot(cwd))
}

/**
 * Hook-inference cache, shared by BOTH inference entry points. A snapshot stats
 * ~40 manifest paths and then walks the project tree for `.sln`/`.csproj`
 * targets (up to MAX_PROJECT_SCAN_ENTRIES entries), and the CLI TUI renders on
 * the same event loop as the SDK, so an uncached snapshot on every Enter press
 * is a visible freeze. `runFileChangeHooks` takes the ADAPTER path in
 * production (`sdk/src/run.ts` always passes the run filesystem), so caching
 * only the adapter-less path left the per-Enter cost on the path that ships.
 * Manifests change far more slowly than source files, so a short TTL keeps the
 * edit/validate loop cheap while still picking up a newly added manifest; the
 * bounded Map caps memory for long sessions that visit many working
 * directories.
 *
 * An entry is either the in-flight snapshot (`pending`) or its resolved hooks.
 * The pending form is what makes the cache cover the case the TTL exists for: a
 * burst of overlapping Enter presses used to find no entry at all and each take
 * a full snapshot, so the cache only removed repeated sequential cost. Entries
 * are kept in least-recently-used order (a hit re-inserts), so a hot project
 * root cannot be evicted by a run of one-off cwds.
 */
const HOOK_INFERENCE_CACHE_TTL_MS = 5_000
const HOOK_INFERENCE_CACHE_MAX_ENTRIES = 32
/**
 * One snapshot in flight, tagged with its own identity object.
 *
 * Both write paths compare `snapshot` against the entry the map still holds, so
 * a clear (or an eviction, or a newer snapshot for the same key) that lands
 * while this one runs wins: the pre-invalidation hooks can never be published
 * over the slot a caller asked to have refreshed, and a rejected snapshot can
 * never delete a replacement entry it no longer owns.
 */
type PendingHookInferenceCacheEntry = {
  pending: Promise<FileChangeHook[]>
  snapshot: object
  /**
   * The group's OWN controller, never linked to any caller's signal: binding
   * the starting caller's signal rejected the shared snapshot the moment that
   * one originator aborted, so every deduped joiner's run failed with a
   * foreign AbortError it did not cause. The controller fires only from
   * `awaitHookInferenceGroup`, once the last caller waiting on the group has
   * stopped waiting — the harness tools cache's `awaitToolProbeGroup` pattern,
   * so an unwanted snapshot stops issuing filesystem work instead of running
   * to completion for callers that are gone.
   */
  controller: AbortController
  /** Callers currently awaiting `pending`; the last one out aborts the group. */
  waiters: number
}
type HookInferenceCacheEntry =
  | PendingHookInferenceCacheEntry
  | { expiresAt: number; result: FileChangeHook[] }
const hookInferenceCache = new Map<string, HookInferenceCacheEntry>()

/**
 * Identity for a caller-supplied filesystem adapter, so entries can be keyed by
 * resolved cwd AND adapter. The run filesystem is a long-lived object reused
 * across a session, so a WeakMap id names it without retaining it.
 */
const fileSystemCacheIds = new WeakMap<CodebuffFileSystem, number>()
let nextFileSystemCacheId = 1

/**
 * Cache key for one inference request. Both entry points resolve to the same
 * helper below, and their keys never collide: a snapshot taken through one
 * adapter must not be served to another, or an adapter with a different view of
 * the project would inherit someone else's hooks.
 */
function hookInferenceCacheKey(
  root: string,
  fileSystem?: CodebuffFileSystem,
): string {
  if (!fileSystem) return `node\0${root}`
  let id = fileSystemCacheIds.get(fileSystem)
  if (id === undefined) {
    id = nextFileSystemCacheId++
    fileSystemCacheIds.set(fileSystem, id)
  }
  return `fs${id}\0${root}`
}

/**
 * Drop every cached inference result. For tests, and for callers that just
 * scaffolded project manifests and want the next run to see them.
 */
export function clearFileChangeHooksCache(): void {
  // Snapshots already in flight publish through the identity check below, so
  // dropping the map here also drops their claim on the slot: a caller that
  // just scaffolded manifests gets fresh hooks on the next run instead of the
  // pre-clear answer with a brand-new TTL.
  hookInferenceCache.clear()
}

/**
 * Async default inference path for run_file_change_hooks. Reads manifests
 * through `node:fs/promises` so inference never blocks the event loop the TUI
 * renders on. The inferred hook list depends only on manifest presence/content,
 * which is exactly the staleness HOOK_INFERENCE_CACHE_TTL_MS bounds.
 */
export async function inferFileChangeHooksAsync(
  cwd: string,
  signal?: AbortSignal,
): Promise<FileChangeHook[]> {
  return inferFileChangeHooksCached(cwd, undefined, signal)
}

/**
 * The one cached implementation behind BOTH entry points, memoized per resolved
 * cwd plus adapter identity.
 *
 * `runFileChangeHooks` selects `inferFileChangeHooksFromFileSystem` whenever the
 * caller supplies a filesystem, and the SDK's single production dispatch of that
 * tool always does (`sdk/src/run.ts` passes `fileSystem: fs`). Caching only the
 * adapter-less call therefore certified a cost the shipped path did not pay
 * down, and every Enter press re-took the whole snapshot. Both shapes share this
 * memo, so the per-Enter cost is one snapshot per TTL window on the live path.
 */
async function inferFileChangeHooksCached(
  cwd: string,
  fileSystem?: CodebuffFileSystem,
  signal?: AbortSignal,
): Promise<FileChangeHook[]> {
  const root = path.resolve(cwd)
  const key = hookInferenceCacheKey(root, fileSystem)
  const cached = hookInferenceCache.get(key)
  if (cached) {
    // Overlapping callers share the snapshot already being taken instead of
    // each starting their own. The shared group is never cancellable on one
    // caller's behalf — another run may still want it — so every caller, the
    // one that started the group included, registers as a waiter through
    // `awaitHookInferenceGroup` and races only its OWN signal.
    if ('pending' in cached) return awaitHookInferenceGroup(key, cached, signal)
    if (cached.expiresAt > Date.now()) {
      // Re-insert on hit so eviction drops the least-recently-used key.
      hookInferenceCache.delete(key)
      hookInferenceCache.set(key, cached)
      return cached.result
    }
  }
  // An already-aborted caller never starts a snapshot whose filesystem work it
  // could not own.
  throwIfAborted(signal)
  // Stored synchronously, before the first await, so a concurrent caller sees
  // the pending entry rather than an empty slot. The snapshot token is this
  // snapshot's identity inside that slot.
  const snapshot = {}
  // The group's own detached controller is the ONLY signal the snapshot sees.
  // It is never linked to a caller's signal, so no single caller's abort can
  // reject the shared snapshot out from under the callers still deduping onto
  // it; it fires solely from the last-waiter release in
  // `awaitHookInferenceGroup`, and the aborted-signal guard inside
  // `collectAndCacheHookInference` keeps an abort-settled group out of the TTL
  // cache.
  const controller = new AbortController()
  const entry: PendingHookInferenceCacheEntry = {
    pending: collectAndCacheHookInference(
      key,
      root,
      snapshot,
      fileSystem,
      controller.signal,
    ),
    snapshot,
    controller,
    waiters: 0,
  }
  storeHookInferenceEntry(key, entry)
  return awaitHookInferenceGroup(key, entry, signal)
}

/**
 * True when `key`'s slot still holds the pending entry belonging to `snapshot`.
 * Both write paths are gated on it so a clear, an eviction, or a newer snapshot
 * that landed mid-flight cannot be overwritten or deleted by this one.
 */
function ownsHookInferenceSnapshot(
  key: string,
  snapshot: object,
): boolean {
  const current = hookInferenceCache.get(key)
  return current !== undefined && 'pending' in current && current.snapshot === snapshot
}

/**
 * Awaits the shared snapshot on behalf of one caller. The caller registers as a
 * waiter: a cancelling caller stops waiting (`raceAbort` rejects with its OWN
 * reason) without rejecting the shared snapshot anyone else is still deduping
 * onto, and once the LAST waiter is gone the group's own controller aborts so
 * the snapshot stops issuing filesystem work for callers that no longer exist.
 * Mirrors the harness tools cache's `awaitToolProbeGroup` waiter accounting.
 */
async function awaitHookInferenceGroup(
  key: string,
  entry: PendingHookInferenceCacheEntry,
  signal?: AbortSignal,
): Promise<FileChangeHook[]> {
  throwIfAborted(signal)
  entry.waiters += 1
  let released = false
  const release = (): void => {
    if (released) return
    released = true
    entry.waiters -= 1
    if (entry.waiters === 0) {
      entry.controller.abort()
      // Retire the pending entry: the group now settles under cancellation
      // and must not be adopted by a later caller as a dead shared promise —
      // the next caller misses the cache and starts a live snapshot instead.
      // Identity-checked, so a resolved entry the group already published (or
      // a replacement another caller stored) is never dropped.
      if (ownsHookInferenceSnapshot(key, entry.snapshot)) {
        hookInferenceCache.delete(key)
      }
    }
  }
  try {
    return await raceAbort(entry.pending, signal)
  } finally {
    release()
  }
}

async function collectAndCacheHookInference(
  key: string,
  root: string,
  snapshot: object,
  fileSystem?: CodebuffFileSystem,
  signal?: AbortSignal,
): Promise<FileChangeHook[]> {
  try {
    const result = inferHooksFromSnapshot(
      fileSystem
        ? await collectManifestSnapshotFromFileSystem(root, fileSystem, signal)
        : await collectManifestSnapshotAsync(root, signal),
    )
    // Belt-and-braces: a group whose own controller fired (every waiter left)
    // settled for callers that are gone, and an abort-truncated snapshot must
    // never be published — the slot is dropped instead so the next caller
    // re-runs it. The walks re-throw cancellation, so reaching here settled
    // means the snapshot completed; this guard covers any settle path that
    // might someday grow another swallow.
    if (signal?.aborted) {
      if (ownsHookInferenceSnapshot(key, snapshot)) {
        hookInferenceCache.delete(key)
      }
      return result
    }
    // TTL anchored to completion, so a slow snapshot does not eat into the
    // window it just refreshed. Published only while this snapshot still owns
    // the slot: a clear that landed during the snapshot asked for fresh hooks,
    // and republishing the pre-clear answer for another 5s is exactly what it
    // was trying to avoid.
    if (ownsHookInferenceSnapshot(key, snapshot)) {
      storeHookInferenceEntry(key, {
        expiresAt: Date.now() + HOOK_INFERENCE_CACHE_TTL_MS,
        result,
      })
    }
    return result
  } catch (error) {
    // A rejected snapshot must not wedge the slot with a dead promise — but
    // only while it still owns that slot, so it cannot delete a replacement
    // entry another caller stored after this one was evicted.
    if (ownsHookInferenceSnapshot(key, snapshot)) hookInferenceCache.delete(key)
    throw error
  }
}

function storeHookInferenceEntry(
  key: string,
  entry: HookInferenceCacheEntry,
): void {
  hookInferenceCache.delete(key)
  if (hookInferenceCache.size >= HOOK_INFERENCE_CACHE_MAX_ENTRIES) {
    // Pending entries are skipped: one is an in-flight snapshot that other
    // callers are deduping onto, so evicting it would both orphan their slot
    // and let a second snapshot start for the same key. Only resolved entries
    // are cold enough to drop, and when every entry is in flight the bound is
    // briefly exceeded by work that is already running and about to settle.
    for (const [candidate, candidateEntry] of hookInferenceCache) {
      if ('pending' in candidateEntry) continue
      hookInferenceCache.delete(candidate)
      break
    }
  }
  hookInferenceCache.set(key, entry)
}

/**
 * Inference through a caller-supplied filesystem adapter — the shape
 * `run_file_change_hooks` actually dispatches with in production. Shares the
 * same TTL cache and in-flight promise as `inferFileChangeHooksAsync`, keyed by
 * resolved cwd plus adapter identity.
 */
export async function inferFileChangeHooksFromFileSystem(
  cwd: string,
  fileSystem: CodebuffFileSystem,
  signal?: AbortSignal,
): Promise<FileChangeHook[]> {
  return inferFileChangeHooksCached(cwd, fileSystem, signal)
}

function inferHooksFromSnapshot(snapshot: ManifestSnapshot): FileChangeHook[] {
  const hooks: FileChangeHook[] = []
  const packageJson = parseJson<PackageJson>(
    snapshot.contents.get('package.json'),
  )
  if (packageJson) {
    hooks.push(
      ...inferPackageJsonHooks(packageJson, detectPackageRunner(snapshot)),
    )
  }

  if (snapshot.existing.has('go.mod')) {
    hooks.push(
      {
        name: 'gofmt',
        command: `gofmt -l . | awk 'NF { found=1 } END { exit found ? 1 : 0 }'`,
        filePattern: '**/*.go',
      },
      { name: 'go vet', command: 'go vet ./...', filePattern: '**/*.go' },
      { name: 'go test', command: 'go test ./...', filePattern: '**/*.go' },
    )
  }

  if (snapshot.dotnetTarget) {
    const target = shellQuote(snapshot.dotnetTarget)
    hooks.push(
      {
        name: 'dotnet format',
        command: `dotnet format ${target} --verify-no-changes --no-restore`,
        filePattern: '**/*.{cs,csproj,sln}',
      },
      {
        name: 'dotnet build',
        command: `dotnet build ${target} --nologo --no-restore`,
        filePattern: '**/*.{cs,csproj,sln}',
      },
      {
        name: 'dotnet test',
        command: `dotnet test ${target} --nologo --no-restore`,
        filePattern: '**/*.{cs,csproj,sln}',
      },
    )
  }

  if (snapshot.existing.has('Cargo.toml')) {
    hooks.push(
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
    )
  }

  hooks.push(...inferPythonHooks(snapshot))
  hooks.push(...inferRubyHooks(snapshot))

  if (snapshot.existing.has('Package.swift')) {
    if (snapshot.existing.has('.swift-format')) {
      hooks.push({
        name: 'swift-format',
        command: 'swift-format lint --recursive .',
        filePattern: '**/*.swift',
      })
    }
    hooks.push({
      name: 'swift build',
      command: 'swift build --jobs 2',
      filePattern: '**/*.{swift,xcodeproj}',
    })
    hooks.push({
      name: 'swift test',
      command: 'swift test --parallel',
      filePattern: '**/*.{swift,xcodeproj}',
    })
  }

  hooks.push(...inferJvmHooks(snapshot))
  hooks.push(...inferPhpHooks(snapshot))
  hooks.push(...inferCppHooks(snapshot))

  if (snapshot.existing.has('project.godot')) {
    hooks.push({
      name: 'godot validation',
      command: 'godot --headless --editor --quit --path .',
      filePattern: '**/*.{gd,gdshader,tscn,tres,godot}',
    })
  }

  return hooks
}

function inferPackageJsonHooks(
  packageJson: PackageJson,
  packageRunner: string,
): FileChangeHook[] {
  const hooks: FileChangeHook[] = []
  const dependencies = {
    ...(packageJson.dependencies ?? {}),
    ...(packageJson.devDependencies ?? {}),
  }
  const lintScript = findScript(packageJson.scripts, ['lint'])
  const typecheckScript = findScript(packageJson.scripts, [
    'typecheck',
    'type-check',
    'check:types',
  ])

  if (lintScript) {
    hooks.push({
      name: `script:${lintScript}`,
      command: `${packageRunner} run ${shellQuote(lintScript)}`,
      filePattern: '**/*.{js,jsx,mjs,cjs,ts,tsx,mts,cts}',
    })
  } else if ('eslint' in dependencies) {
    hooks.push({
      name: 'lint',
      command: localPackageExecutableCommand(packageRunner, 'eslint', '.'),
      filePattern: '**/*.{js,jsx,mjs,cjs,ts,tsx,mts,cts}',
    })
  }

  if (typecheckScript) {
    hooks.push({
      name: `script:${typecheckScript}`,
      command: `${packageRunner} run ${shellQuote(typecheckScript)}`,
      filePattern: '**/*.{ts,tsx,mts,cts}',
    })
  } else if ('typescript' in dependencies) {
    hooks.push({
      name: 'typecheck',
      command: localPackageExecutableCommand(packageRunner, 'tsc', '--noEmit'),
      filePattern: '**/*.{ts,tsx,mts,cts}',
    })
  }

  return hooks
}

function localPackageExecutableCommand(
  packageRunner: string,
  executable: string,
  args: string,
): string {
  switch (packageRunner) {
    case 'bun':
      return `bunx --no-install ${executable} ${args}`
    case 'pnpm':
      return `pnpm exec ${executable} ${args}`
    case 'yarn':
      return `yarn exec ${executable} ${args}`
    default:
      return `npx --no-install ${executable} ${args}`
  }
}

function inferPythonHooks(snapshot: ManifestSnapshot): FileChangeHook[] {
  const projectConfig = [
    snapshot.contents.get('pyproject.toml') ?? '',
    snapshot.contents.get('requirements.txt') ?? '',
    snapshot.contents.get('requirements-dev.txt') ?? '',
    snapshot.contents.get('tox.ini') ?? '',
  ]
    .join('\n')
    .toLowerCase()
  if (!projectConfig && !snapshot.existing.has('pyrightconfig.json')) return []

  const hooks: FileChangeHook[] = []
  if (/\bruff\b|\[tool\.ruff\]/.test(projectConfig)) {
    hooks.push({
      name: 'ruff',
      command: 'ruff check .',
      filePattern: '**/*.py',
    })
  }
  if (
    snapshot.existing.has('pyrightconfig.json') ||
    /\bpyright\b/.test(projectConfig)
  ) {
    hooks.push({ name: 'pyright', command: 'pyright', filePattern: '**/*.py' })
  } else if (/\bmypy\b|\[tool\.mypy\]/.test(projectConfig)) {
    hooks.push({ name: 'mypy', command: 'mypy .', filePattern: '**/*.py' })
  }
  if (/\bpytest\b|\[tool\.pytest/.test(projectConfig)) {
    hooks.push({
      name: 'pytest',
      command: 'python -m pytest',
      filePattern: '**/*.py',
    })
  }
  return hooks
}

function inferRubyHooks(snapshot: ManifestSnapshot): FileChangeHook[] {
  const gemfile = snapshot.contents.get('Gemfile')?.toLowerCase() ?? ''
  const hooks: FileChangeHook[] = []
  if (snapshot.existing.has('.rubocop.yml') || /\brubocop\b/.test(gemfile)) {
    hooks.push({
      name: 'rubocop',
      command: snapshot.existing.has('Gemfile')
        ? 'bundle exec rubocop'
        : 'rubocop',
      filePattern: '**/*.rb',
    })
  }
  if (/\brspec\b/.test(gemfile)) {
    hooks.push({
      name: 'rspec',
      command: 'bundle exec rspec',
      filePattern: '**/*.rb',
    })
  }
  return hooks
}

function inferJvmHooks(snapshot: ManifestSnapshot): FileChangeHook[] {
  const hasGradle =
    snapshot.existing.has('build.gradle') ||
    snapshot.existing.has('build.gradle.kts') ||
    snapshot.existing.has('settings.gradle') ||
    snapshot.existing.has('settings.gradle.kts')
  if (hasGradle) {
    const gradle = snapshot.existing.has('gradlew')
      ? './gradlew'
      : snapshot.existing.has('gradlew.bat')
        ? './gradlew.bat'
        : 'gradle'
    return [
      {
        name: 'gradle check',
        command: `${gradle} --no-daemon --console=plain --max-workers=2 check`,
        filePattern: '**/*.{java,kt,kts,gradle}',
      },
    ]
  }
  if (!snapshot.existing.has('pom.xml')) return []
  const maven = snapshot.existing.has('mvnw')
    ? './mvnw'
    : snapshot.existing.has('mvnw.cmd')
      ? './mvnw.cmd'
      : 'mvn'
  return [
    {
      name: 'maven test',
      command: `${maven} -q test`,
      filePattern: '**/*.{java,kt,kts,xml}',
    },
  ]
}

function inferPhpHooks(snapshot: ManifestSnapshot): FileChangeHook[] {
  const composer = parseJson<ComposerJson>(
    snapshot.contents.get('composer.json'),
  )
  if (!composer) return []
  const hooks: FileChangeHook[] = [
    {
      name: 'composer validate',
      command: 'composer validate --no-check-publish --no-interaction',
      filePattern: '**/composer.{json,lock}',
    },
  ]
  const script = findScript(composer.scripts, [
    'check',
    'lint',
    'analyse',
    'analyze',
    'static-analysis',
    'test',
  ])
  if (script) {
    hooks.push({
      name: `composer:${script}`,
      command: `composer run-script --no-interaction ${shellQuote(script)}`,
      filePattern: '**/*.php',
    })
    return hooks
  }

  const dependencies = {
    ...(composer.require ?? {}),
    ...(composer['require-dev'] ?? {}),
  }
  if (
    'phpstan/phpstan' in dependencies ||
    snapshot.existing.has('phpstan.neon') ||
    snapshot.existing.has('phpstan.neon.dist')
  ) {
    hooks.push({
      name: 'phpstan',
      command:
        'vendor/bin/phpstan analyse --error-format=raw --no-progress --memory-limit=1G',
      filePattern: '**/*.php',
    })
  } else if ('vimeo/psalm' in dependencies) {
    hooks.push({
      name: 'psalm',
      command: 'vendor/bin/psalm --no-progress --threads=2',
      filePattern: '**/*.php',
    })
  } else {
    hooks.push({
      name: 'php syntax',
      command: 'php -l',
      filePattern: '**/*.php',
      runPerFile: true,
    })
  }
  return hooks
}

function inferCppHooks(snapshot: ManifestSnapshot): FileChangeHook[] {
  const pattern = '**/*.{c,cc,cpp,cxx,h,hh,hpp,hxx}'
  const presets = parseJson<{
    buildPresets?: Array<{ name?: unknown; hidden?: unknown }>
  }>(snapshot.contents.get('CMakePresets.json'))
  const preset = presets?.buildPresets?.find(
    (item) =>
      item.hidden !== true &&
      typeof item.name === 'string' &&
      /^[A-Za-z0-9_.-]+$/.test(item.name),
  )?.name
  if (typeof preset === 'string') {
    return [
      {
        name: 'cmake build',
        command: `cmake --build --preset ${shellQuote(preset)} --parallel 2`,
        filePattern: pattern,
      },
    ]
  }
  if (snapshot.existing.has('build/CMakeCache.txt')) {
    return [
      {
        name: 'cmake build',
        command: 'cmake --build build --parallel 2',
        filePattern: pattern,
      },
      {
        name: 'ctest',
        command: 'ctest --test-dir build --output-on-failure -j 2',
        filePattern: pattern,
      },
    ]
  }
  if (snapshot.existing.has('build/meson-private/coredata.dat')) {
    return [
      {
        name: 'meson compile',
        command: 'meson compile -C build -j 2',
        filePattern: pattern,
      },
    ]
  }
  if (snapshot.existing.has('build.ninja')) {
    return [{ name: 'ninja', command: 'ninja -j 2', filePattern: pattern }]
  }
  const makefile = snapshot.contents.get('Makefile') ?? ''
  const target = ['check', 'test', 'lint'].find((name) =>
    new RegExp(`^${name}\\s*:`, 'm').test(makefile),
  )
  return target
    ? [
        {
          name: `make ${target}`,
          command: `make -j 2 ${target}`,
          filePattern: pattern,
        },
      ]
    : []
}

// Sync reference implementation, so it deliberately takes no signal: a
// `readdirSync` walk cannot observe one, and an accepted-but-ignored parameter
// would imply cancellability this path cannot deliver.
function collectManifestSnapshot(cwd: string): ManifestSnapshot {
  const existing = new Set<string>()
  const contents = new Map<string, string>()
  for (const relativePath of KNOWN_PROJECT_PATHS) {
    const filePath = path.join(cwd, relativePath)
    try {
      const stats = fs.statSync(filePath)
      existing.add(relativePath)
      if (stats.isFile() && stats.size <= MAX_MANIFEST_BYTES) {
        contents.set(relativePath, fs.readFileSync(filePath, 'utf8'))
      }
    } catch {
      // Missing or unreadable project metadata is not an inference failure.
    }
  }
  return {
    existing,
    contents,
    dotnetTarget: findDotnetTarget(cwd),
  }
}

/**
 * Async snapshot through a caller-supplied adapter — the shape the SDK's
 * production dispatch of run_file_change_hooks uses.
 *
 * The probes are batched at HOOK_SNAPSHOT_PROBE_CONCURRENCY instead of queued as
 * one unbounded `Promise.all`: the adapter's reads are served from the same
 * libuv pool the render loop's own fs work uses, which is the reason both walks
 * in this module cap their fan-out. Results come back index-aligned and are
 * folded over KNOWN_PROJECT_PATHS in order, so `existing`/`contents` keep the
 * insertion order the sync reference implementation produces. The walk starts
 * before the probes are awaited, so a cache miss costs the slower phase rather
 * than their sum.
 */
async function collectManifestSnapshotFromFileSystem(
  cwd: string,
  fileSystem: CodebuffFileSystem,
  signal?: AbortSignal,
): Promise<ManifestSnapshot> {
  manifestSnapshotCount += 1
  const dotnetTarget = trackManifestSnapshotPhase(
    'dotnetWalk',
    findDotnetTargetInFileSystem(cwd, fileSystem, signal).catch(
      (error: unknown) => {
        // A walk FAILURE degrades to "no dotnet target", but CANCELLATION must
        // not: a walk settled by an abort has walked only a truncated prefix
        // of the tree, and resolving the snapshot normally would publish that
        // truncation into the TTL cache. Re-throw so the run observes its own
        // cancellation and the next caller re-runs the walk.
        if (signal?.aborted) throw error
        return undefined
      },
    ),
  )
  const probes = await trackManifestSnapshotPhase(
    'manifestProbes',
    mapWithConcurrency(
      KNOWN_PROJECT_PATHS,
      HOOK_SNAPSHOT_PROBE_CONCURRENCY,
      async (relativePath): Promise<ManifestProbe> => {
        const filePath = path.join(cwd, relativePath)
        try {
          const stats = await trackSnapshotProbe(
            () => fileSystem.stat(filePath),
            signal,
          )
          if (stats.isFile() && stats.size <= MAX_MANIFEST_BYTES) {
            return {
              found: true,
              contents: String(
                await trackSnapshotProbe(
                  () => fileSystem.readFile(filePath, 'utf8'),
                  signal,
                ),
              ),
            }
          }
          return { found: true }
        } catch {
          // Missing or unreadable project metadata is not an inference failure.
          // Cancellation is NOT a probe failure though: it must propagate so the
          // caller stops queueing probes and the slot counters unwind.
          throwIfAborted(signal)
          return { found: false }
        }
      },
      signal,
    ),
  )
  const existing = new Set<string>()
  const contents = new Map<string, string>()
  for (let index = 0; index < KNOWN_PROJECT_PATHS.length; index++) {
    const probe = probes[index]
    if (!probe?.found) continue
    const relativePath = KNOWN_PROJECT_PATHS[index]
    existing.add(relativePath)
    if (probe.contents !== undefined) {
      contents.set(relativePath, probe.contents)
    }
  }
  return {
    existing,
    contents,
    dotnetTarget: await dotnetTarget,
  }
}

let manifestSnapshotCount = 0
let dotnetWalkCount = 0

/**
 * Test seam: how many async manifest snapshots this module has taken. Pins the
 * hook-inference cache's "one snapshot per TTL window" baseline so a change that
 * silently re-walks on every call fails loudly instead of just getting slower.
 */
export function __getManifestSnapshotCountForTest(): number {
  return manifestSnapshotCount
}

/**
 * Test seam: how many project-tree dotnet walks this module has run. Pairs with
 * `__getManifestSnapshotCountForTest` so the cache baseline pins that a cached
 * run pays for NEITHER phase, on the adapter path the SDK's production dispatch
 * actually takes as well as the adapter-less one.
 */
export function __getDotnetWalkCountForTest(): number {
  return dotnetWalkCount
}

type ManifestProbe = { found: boolean; contents?: string }

type ManifestSnapshotPhase = 'manifestProbes' | 'dotnetWalk'
type ManifestSnapshotPhaseEvent = {
  phase: ManifestSnapshotPhase
  event: 'start' | 'settle'
}

/**
 * Retention bound for the phase log below, in events.
 *
 * The log is test observability that stays wired into the shipped snapshot, so
 * it must not keep every entry forever: one cache miss pushes a start and a
 * settle per phase, and a long CLI session takes a miss per TTL window per
 * working directory. Accumulating those for the process lifetime was pure
 * production retention for a reader that truncates the log before it reads. A
 * snapshot contributes four entries and each test resets the log before the
 * snapshot it attributes, so sixteen entries always hold a complete snapshot's
 * events in order while production retention stays O(1).
 */
const MANIFEST_SNAPSHOT_PHASE_EVENT_LIMIT = 16

const manifestSnapshotPhaseEvents: ManifestSnapshotPhaseEvent[] = []

/** Records one event, dropping the oldest once the retention bound is reached. */
function recordManifestSnapshotPhaseEvent(
  event: ManifestSnapshotPhaseEvent,
): void {
  manifestSnapshotPhaseEvents.push(event)
  if (
    manifestSnapshotPhaseEvents.length > MANIFEST_SNAPSHOT_PHASE_EVENT_LIMIT
  ) {
    manifestSnapshotPhaseEvents.shift()
  }
}

/**
 * Test seam: the manifest-probe and dotnet-walk phase start/settle log, in
 * event order, bounded to the most recent MANIFEST_SNAPSHOT_PHASE_EVENT_LIMIT
 * entries so the getter copies a fixed-size window instead of the whole session.
 * `collectManifestSnapshotAsync` documents that the walk and the probes overlap —
 * "a cache miss then costs the slower of the two phases instead of their sum" —
 * and every sibling claim in this change is pinned by an observable counter.
 * Without this log a change that re-serialised the pair would keep every
 * inferred hook list identical while silently restoring the summed latency.
 */
export function __getManifestSnapshotPhaseEventsForTest(): ManifestSnapshotPhaseEvent[] {
  return manifestSnapshotPhaseEvents.map((entry) => ({ ...entry }))
}

/**
 * Reset the phase log so a test attributes one snapshot's overlap to it, and so
 * the retained window starts at that test's own snapshot.
 */
export function __resetManifestSnapshotPhaseEventsForTest(): void {
  manifestSnapshotPhaseEvents.length = 0
}

function trackManifestSnapshotPhase<T>(
  phase: ManifestSnapshotPhase,
  work: Promise<T>,
): Promise<T> {
  recordManifestSnapshotPhaseEvent({ phase, event: 'start' })
  const settle = () => {
    recordManifestSnapshotPhaseEvent({ phase, event: 'settle' })
  }
  return work.then(
    (value) => {
      settle()
      return value
    },
    (error: unknown) => {
      settle()
      throw error
    },
  )
}

/**
 * Async twin of collectManifestSnapshot for the default run_file_change_hooks
 * path.
 *
 * The probes are batched at HOOK_SNAPSHOT_PROBE_CONCURRENCY, exactly like the
 * adapter twin above, and each stat/read is wrapped in `trackSnapshotProbe`.
 * Both inference entry points therefore share ONE fan-out bound and ONE
 * observable: an unbounded `Promise.all` here kept every result identical while
 * queueing all 36 probes (plus up to 512 KB of manifest reads) onto the libuv
 * pool the render loop's own fs work is served from, and the high-water-mark
 * baseline could not see it because the counter was wired only into the adapter
 * path. Only the COLLECTION is re-serialised: `existing`/`contents` are rebuilt
 * by walking KNOWN_PROJECT_PATHS a second time over the index-aligned results,
 * so their insertion order — the only observable they expose — still matches
 * the sync reference implementation byte for byte.
 */
async function collectManifestSnapshotAsync(
  cwd: string,
  signal?: AbortSignal,
): Promise<ManifestSnapshot> {
  manifestSnapshotCount += 1
  // The manifest probes and the dotnet walk are independent reads of the same
  // cwd, so start the walk before awaiting the probes: a cache miss then costs
  // the slower of the two phases instead of their sum. The catch keeps a walk
  // failure from surfacing as an unhandled rejection while the probes run, and
  // both phases are logged so that overlap is regression-checked rather than
  // only asserted in prose.
  //
  // `signal` is threaded into BOTH phases. Hook inference is driven by an agent
  // run that can be aborted between Enter presses, so a cancelled snapshot must
  // stop issuing readdir/stat/read calls against the shared pool instead of
  // holding the processes' filesystem slots for a caller that is gone. The
  // `.catch` absorbs a walk FAILURE only; cancellation is re-thrown inside it,
  // so an abort landing mid-walk can never resolve the snapshot with a
  // truncated target list that the caller-side cache would then serve.
  const dotnetTarget = trackManifestSnapshotPhase(
    'dotnetWalk',
    findDotnetTargetAsync(cwd, signal).catch((error: unknown) => {
      // See the adapter twin above: a walk failure degrades to "no dotnet
      // target", but a walk settled by CANCELLATION has only a truncated
      // prefix of the candidate list and must not be mistaken for one.
      if (signal?.aborted) throw error
      return undefined
    }),
  )
  const probes = await trackManifestSnapshotPhase(
    'manifestProbes',
    mapWithConcurrency(
      KNOWN_PROJECT_PATHS,
      HOOK_SNAPSHOT_PROBE_CONCURRENCY,
      async (relativePath): Promise<ManifestProbe> => {
        const filePath = path.join(cwd, relativePath)
        try {
          const stats = await trackSnapshotProbe(() => stat(filePath), signal)
          if (stats.isFile() && stats.size <= MAX_MANIFEST_BYTES) {
            return {
              found: true,
              contents: await trackSnapshotProbe(
                () => readFile(filePath, 'utf8'),
                signal,
              ),
            }
          }
          return { found: true }
        } catch {
          // Missing or unreadable project metadata is not an inference failure.
          // Cancellation is NOT a probe failure though: it must propagate so the
          // caller stops queueing probes and the slot counters unwind.
          throwIfAborted(signal)
          return { found: false }
        }
      },
      signal,
    ),
  )
  const existing = new Set<string>()
  const contents = new Map<string, string>()
  for (let index = 0; index < KNOWN_PROJECT_PATHS.length; index++) {
    const probe = probes[index]
    if (!probe?.found) continue
    const relativePath = KNOWN_PROJECT_PATHS[index]
    existing.add(relativePath)
    if (probe.contents !== undefined) {
      contents.set(relativePath, probe.contents)
    }
  }
  return {
    existing,
    contents,
    dotnetTarget: await dotnetTarget,
  }
}

// Sync twin: like `collectManifestSnapshot` above, no signal — a
// `readdirSync` loop runs to completion on the calling thread and cannot
// observe one.
function findDotnetTarget(cwd: string): string | undefined {
  const candidates: string[] = []
  const budget = { remaining: MAX_PROJECT_SCAN_ENTRIES }
  const visit = (directory: string, depth: number): void => {
    if (depth > MAX_PROJECT_SCAN_DEPTH || budget.remaining <= 0) return
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true })
    } catch {
      return
    }
    entries.sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) {
      if (--budget.remaining < 0) return
      const entryPath = path.join(directory, entry.name)
      if (entry.isFile() && /\.(?:sln|csproj)$/.test(entry.name)) {
        candidates.push(toPosixPath(path.relative(cwd, entryPath)))
      } else if (
        entry.isDirectory() &&
        !PROJECT_SCAN_EXCLUDED_DIRS.has(entry.name)
      ) {
        visit(entryPath, depth + 1)
      }
    }
  }
  visit(cwd, 0)
  return preferDotnetTarget(candidates)
}

/**
 * Adapter twin of `findDotnetTargetAsync`: same entry budget, depth ceiling,
 * excluded directories, candidate ordering, and level-parallel traversal, so it
 * selects the same target.
 *
 * This used to be a depth-first walk that awaited one `stat` per directory entry
 * in turn, so a cache miss could cost up to MAX_PROJECT_SCAN_ENTRIES serial
 * syscall round trips on the libuv pool the render loop's own fs work shares.
 * Directories at the current depth are now listed in one bounded batch and then
 * their entries are stat'd in one bounded batch (an adapter's `readdir` returns
 * names, so the stat is a separate call the node walk gets from
 * `withFileTypes`). Both passes run at HOOK_SNAPSHOT_PROBE_CONCURRENCY, and
 * entries are consumed in sorted directory-then-name order so the shared entry
 * budget is spent deterministically. The listing batch is ALSO trimmed to the
 * entries the budget can still charge before it is dispatched, so a level
 * larger than the remaining budget never readdir's directories whose names the
 * budget would immediately discard — the same rule the node twin below applies.
 */
async function findDotnetTargetInFileSystem(
  cwd: string,
  fileSystem: CodebuffFileSystem,
  signal?: AbortSignal,
): Promise<string | undefined> {
  dotnetWalkCount += 1
  const candidates: string[] = []
  let remaining = MAX_PROJECT_SCAN_ENTRIES
  let level: string[] = [cwd]
  for (let depth = 0; depth <= MAX_PROJECT_SCAN_DEPTH; depth++) {
    // Same batch-boundary cancellation rule as the node twin: a cancelled
    // snapshot stops issuing readdirs and stats instead of walking the budget.
    throwIfAborted(signal)
    if (level.length === 0 || remaining <= 0) break
    // Charge before fetching. Every directory this level lists was itself an
    // entry charged against the budget, so a level can never need more listings
    // than the budget still has room for; a monorepo level of thousands of
    // directories therefore stops being readdir'ed at the budget instead of
    // materialising a name list per directory and discarding nearly all of
    // them. `remaining` is re-checked by the loop condition above for the next
    // level, so a level whose entries the budget would discard is never
    // fetched at all.
    const batch = level.length > remaining ? level.slice(0, remaining) : level
    const listings = await mapWithConcurrency(
      batch,
      HOOK_SNAPSHOT_PROBE_CONCURRENCY,
      async (directory) => {
        try {
          const names = (
            (await trackSnapshotProbe(
              () => fileSystem.readdir(directory),
              signal,
            )) as string[]
          ).slice()
          names.sort((left, right) => left.localeCompare(right))
          return { directory, names }
        } catch {
          // A cancelled listing is not a missing directory: propagate.
          throwIfAborted(signal)
          return { directory, names: [] as string[] }
        }
      },
      signal,
    )
    // One flat pass over this level's entries, not a batch per directory: a
    // per-directory stat batch nested inside the listing batch would multiply
    // the fan-out past the stated width.
    const entryPaths: string[] = []
    for (const { directory, names } of listings) {
      for (const name of names) {
        if (remaining <= 0) break
        remaining -= 1
        entryPaths.push(path.join(directory, name))
      }
      if (remaining <= 0) break
    }
    const stats = await mapWithConcurrency(
      entryPaths,
      HOOK_SNAPSHOT_PROBE_CONCURRENCY,
      async (entryPath) => {
        try {
          const value = await trackSnapshotProbe(
            () => fileSystem.stat(entryPath),
            signal,
          )
          return {
            entryPath,
            isFile: value.isFile(),
            isDirectory: value.isDirectory(),
          }
        } catch {
          // A cancelled stat is not an unusable entry: propagate.
          throwIfAborted(signal)
          return undefined
        }
      },
      signal,
    )
    const nextLevel: string[] = []
    for (const entry of stats) {
      if (!entry) continue
      const name = path.basename(entry.entryPath)
      if (entry.isFile && /\.(?:sln|csproj)$/.test(name)) {
        candidates.push(toPosixPath(path.relative(cwd, entry.entryPath)))
      } else if (entry.isDirectory && !PROJECT_SCAN_EXCLUDED_DIRS.has(name)) {
        nextLevel.push(entry.entryPath)
      }
    }
    level = nextLevel
  }
  return preferDotnetTarget(candidates)
}

/**
 * Async twin of findDotnetTarget: same entry budget, depth ceiling, excluded
 * directories, and name ordering, so the chosen target matches the sync walk.
 *
 * The walk is breadth-first BY LEVEL: directories at the current depth are read
 * in concurrent batches, so the cache-miss cost is a fraction of one syscall
 * round trip per directory (up to MAX_PROJECT_SCAN_ENTRIES serial round trips
 * issued from the same pool that serves the render loop).
 *
 * The fan-out is capped at DOTNET_WALK_READDIR_CONCURRENCY listings in flight
 * because a level can hold thousands of directories: queueing them all at once
 * saturates libuv's 4-thread pool (starving the render loop's own fs work) and
 * materialises a Dirent array per directory. A batch's listings are consumed
 * before the next batch is issued, and no further readdir starts once the entry
 * budget is spent, so a listing the budget would discard is never fetched.
 * Entries and directories are visited in sorted, level order and the shared
 * budget is consumed in that same order, so the walk stays deterministic.
 */
const DOTNET_WALK_READDIR_CONCURRENCY = 8

async function findDotnetTargetAsync(
  cwd: string,
  signal?: AbortSignal,
): Promise<string | undefined> {
  dotnetWalkCount += 1
  const candidates: string[] = []
  let remaining = MAX_PROJECT_SCAN_ENTRIES
  let level: string[] = [cwd]
  for (let depth = 0; depth <= MAX_PROJECT_SCAN_DEPTH; depth++) {
    // Cancellation is checked at the batch boundary, before any readdir for this
    // level is issued: a snapshot whose run was aborted must stop queueing
    // filesystem work instead of walking up to MAX_PROJECT_SCAN_ENTRIES
    // directories for a caller that no longer exists.
    throwIfAborted(signal)
    if (level.length === 0 || remaining <= 0) break
    const nextLevel: string[] = []
    for (
      let offset = 0;
      offset < level.length;
      offset += DOTNET_WALK_READDIR_CONCURRENCY
    ) {
      // Budget spent on an earlier batch: skip the remaining readdirs.
      if (remaining <= 0) return preferDotnetTarget(candidates)
      throwIfAborted(signal)
      const batch = level.slice(offset, offset + DOTNET_WALK_READDIR_CONCURRENCY)
      const listings = await Promise.all(
        batch.map(async (directory) => {
          try {
            const entries = await withFilesystemSlot(
              () => readdir(directory, { withFileTypes: true }),
              signal,
            )
            entries.sort((left, right) => left.name.localeCompare(right.name))
            return { directory, entries }
          } catch {
            // A cancelled listing is not a missing directory: propagate so the
            // batch stops instead of returning an empty listing and continuing.
            throwIfAborted(signal)
            return { directory, entries: [] as fs.Dirent[] }
          }
        }),
      )
      for (const { directory, entries } of listings) {
        for (const entry of entries) {
          if (remaining <= 0) return preferDotnetTarget(candidates)
          remaining -= 1
          const entryPath = path.join(directory, entry.name)
          if (entry.isFile() && /\.(?:sln|csproj)$/.test(entry.name)) {
            candidates.push(toPosixPath(path.relative(cwd, entryPath)))
          } else if (
            entry.isDirectory() &&
            !PROJECT_SCAN_EXCLUDED_DIRS.has(entry.name)
          ) {
            nextLevel.push(entryPath)
          }
        }
      }
    }
    level = nextLevel
  }
  return preferDotnetTarget(candidates)
}

function preferDotnetTarget(candidates: string[]): string | undefined {
  // Path-sorted so selection is deterministic no matter which walk order
  // produced the candidates (depth-first sync walk vs level-parallel async
  // walk), keeping both implementations in agreement.
  const sorted = [...candidates].sort((left, right) =>
    left.localeCompare(right),
  )
  return (
    sorted.find((candidate) => candidate.endsWith('.sln')) ??
    sorted.find((candidate) => candidate.endsWith('.csproj'))
  )
}

function detectPackageRunner(snapshot: ManifestSnapshot): string {
  const packageJson = parseJson<PackageJson>(
    snapshot.contents.get('package.json'),
  )
  if (typeof packageJson?.packageManager === 'string') {
    const manager = packageJson.packageManager.split('@')[0]
    if (['bun', 'npm', 'pnpm', 'yarn'].includes(manager)) return manager
  }
  if (snapshot.existing.has('bun.lock') || snapshot.existing.has('bun.lockb')) {
    return 'bun'
  }
  if (snapshot.existing.has('pnpm-lock.yaml')) return 'pnpm'
  if (snapshot.existing.has('yarn.lock')) return 'yarn'
  return 'npm'
}

function findScript(
  scripts: Record<string, unknown> | undefined,
  candidates: string[],
): string | undefined {
  return candidates.find(
    (candidate) =>
      typeof scripts?.[candidate] === 'string' &&
      (scripts[candidate] as string).trim().length > 0,
  )
}

function parseJson<T>(value: string | undefined): T | undefined {
  if (!value) return undefined
  try {
    const parsed = JSON.parse(value)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return undefined
    }
    return parsed as T
  } catch {
    return undefined
  }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`
}

function toPosixPath(value: string): string {
  return value.split(path.sep).join('/')
}

type RunCommand = typeof runTerminalCommand

/**
 * Opt-in diagnostic-delta preflight flag. Unset/empty/'0'/'false'/'no'/'off'
 * means OFF; any other value enables it. When OFF the delta block inside
 * runFileChangeHooks is skipped entirely, leaving the default hook behavior
 * byte-identical. Truthy-set semantics match the repo's other OPENBUFF_* flags.
 */
export const DIAGNOSTIC_PREFLIGHT_FLAG = 'OPENBUFF_DIAGNOSTIC_PREFLIGHT'

export function isDiagnosticPreflightEnabled(
  env: Record<string, string | undefined> = getSystemProcessEnv(),
): boolean {
  const raw = env[DIAGNOSTIC_PREFLIGHT_FLAG]
  if (raw === undefined) return false
  const normalized = raw.trim().toLowerCase()
  return (
    normalized !== '' &&
    normalized !== '0' &&
    normalized !== 'false' &&
    normalized !== 'no' &&
    normalized !== 'off'
  )
}

/**
 * Injected delta-preflight seam. Hooks observe already-changed files, so they
 * cannot reconstruct the pre-edit baseline themselves; the caller that owns
 * before/after (the mutation-broker path) supplies this. Kept injected so the
 * default hook path stays byte-identical and the broker is never touched here.
 */
export type DiagnosticDeltaHook = (params: {
  files: string[]
  cwd: string
  env?: Record<string, string | undefined>
  signal?: AbortSignal
}) => Promise<DiagnosticDeltaPreflightResult | undefined>

/**
 * Run the configured file-change hooks (typecheck/lint/test) for a set of
 * changed files — the verification gate's executor. Returns one result per
 * hook (the terminal output plus a hookName), matching run_file_change_hooks'
 * output schema. `hooks` and `runCommand` are injectable for testing.
 */
export async function runFileChangeHooks(params: {
  files: string[]
  cwd: string
  env?: Record<string, string | undefined>
  hooks?: FileChangeHook[]
  runCommand?: RunCommand
  signal?: AbortSignal
  fileSystem?: CodebuffFileSystem
  /**
   * Opt-in diagnostic-delta preflight (requires OPENBUFF_DIAGNOSTIC_PREFLIGHT).
   * Injected so the caller owns the pre/post-edit baseline; omitted by default.
   */
  diagnosticDelta?: DiagnosticDeltaHook
}): Promise<CodebuffToolOutput<'run_file_change_hooks'>> {
  const { files, cwd, env } = params
  const hooks =
    params.hooks ??
    (await (async () => {
      const config = loadProviderConfigSync().config
      // Inference uses fixed validation commands selected from manifests; it
      // never executes repository package scripts unless explicitly configured.
      if (config.autoFileChangeHooks === false) return config.fileChangeHooks
      // Inference threads the caller's signal: hook inference is driven by an
      // agent run that can be aborted, and a cancelled run must stop issuing
      // snapshot filesystem probes instead of holding the shared pool's slots.
      return mergeFileChangeHooks(
        params.fileSystem
          ? await inferFileChangeHooksFromFileSystem(
              cwd,
              params.fileSystem,
              params.signal,
            )
          : await inferFileChangeHooksAsync(cwd, params.signal),
        config.fileChangeHooks,
      )
    })())
  const matching = selectMatchingHooks(hooks, files)
  if (hooks.length === 0) {
    return [
      {
        type: 'json',
        value: [
          {
            validationStatus: 'no_hooks_configured',
            message: 'No configured file-change hooks ran.',
            changedFiles: files,
          },
        ],
      },
    ] as CodebuffToolOutput<'run_file_change_hooks'>
  }
  if (matching.length === 0) {
    return [
      {
        type: 'json',
        value: [
          {
            validationStatus: 'hooks_skipped',
            message:
              'Configured file-change hooks were skipped because none matched the changed files.',
            configuredHookCount: hooks.length,
            changedFiles: files,
          },
        ],
      },
    ] as CodebuffToolOutput<'run_file_change_hooks'>
  }

  const run = params.runCommand ?? runTerminalCommand

  // Run matching hooks concurrently. `Promise.allSettled` guarantees every
  // hook runs regardless of others' rejections; results are mapped back into
  // `matching` order so callers see deterministic ordering.
  const settled = await Promise.allSettled(
    matching.map((hook) => {
      const hookName = hook.name ?? hook.command
      const hookCommand = buildHookCommand(hook, files, cwd)
      if ('errorMessage' in hookCommand) {
        return Promise.resolve({
          errorMessage: `Hook "${hookName}" was not run: ${hookCommand.errorMessage}`,
          hookName,
        })
      }
      return run({
        command: hookCommand.command,
        process_type: 'SYNC',
        cwd,
        projectRoot: cwd,
        timeout_seconds: hook.timeoutSeconds ?? HOOK_DEFAULT_TIMEOUT_SECONDS,
        env,
        signal: params.signal,
      })
        .then((out) => {
          const first = Array.isArray(out) ? out[0] : undefined
          if (
            first &&
            first.type === 'json' &&
            first.value &&
            typeof first.value === 'object'
          ) {
            const value = first.value as Record<string, unknown>
            const stdout = typeof value.stdout === 'string' ? value.stdout : ''
            const stderr = typeof value.stderr === 'string' ? value.stderr : ''
            const diagnostics = parseLanguageDiagnostics({
              command: hookCommand.command,
              cwd,
              stdout,
              stderr,
            })
            return {
              ...value,
              stdout: truncateOutput(stdout),
              stderr: truncateOutput(stderr),
              hookName,
              ...(diagnostics.length > 0 && { diagnostics }),
            }
          }
          return { errorMessage: `Hook "${hookName}" produced no output.` }
        })
        .catch((err: unknown) => ({
          errorMessage: `Hook "${hookName}" failed to run: ${
            err instanceof Error ? err.message : String(err)
          }`,
        }))
    }),
  )

  // Cancellation is NOT a hook failure. Every hook runs with `params.signal`,
  // so a cancelled run rejects them all, and mapping those rejections into
  // ordinary `errorMessage` entries would report an abort as a set of failing
  // hooks — the caller could not tell the two apart. The signal's own reason is
  // rethrown instead, matching the contract `mapWithConcurrency` states and
  // honours; the per-hook `errorMessage` mapping below stays for the genuine
  // failures that happen whether or not the run was cancelled.
  throwIfAborted(params.signal)

  const results: Array<Record<string, unknown>> = settled.map((s) =>
    s.status === 'fulfilled'
      ? (s.value as Record<string, unknown>)
      : {
          errorMessage: `Hook failed to run: ${
            s.reason instanceof Error ? s.reason.message : String(s.reason)
          }`,
        },
  )

  // Opt-in diagnostic-delta preflight. When the flag is unset/empty this block
  // is skipped entirely, and when no injector is supplied it is also a no-op,
  // so the default hook behavior is byte-identical. Hooks observe
  // already-changed files, so the injected `diagnosticDelta` owns the
  // before/after baseline (the mutation-broker path); the broker is untouched.
  //
  // P3 audit note — this delta block sits AFTER the early returns for
  // `hooks.length === 0` and `matching.length === 0`, so the preflight only
  // runs when at least one hook matches the changed files: it is part of the
  // hook gate, not an independent check. A repository with no matching hooks
  // (or none configured) gets NO preflight result — no
  // diagnostic_delta_passed/rejected entry — even when the flag is on.
  if (isDiagnosticPreflightEnabled(env) && params.diagnosticDelta) {
    const supportedFiles = supportedDiagnosticFiles(files)
    if (supportedFiles.length > 0) {
      const preflight = await params.diagnosticDelta({
        files: supportedFiles,
        cwd,
        env,
        signal: params.signal,
      })
      if (preflight?.rejected) {
        results.push({
          hookName: 'diagnostic-delta',
          validationStatus: 'diagnostic_delta_rejected',
          newDiagnostics: preflight.newDiagnostics,
          fixIts: preflight.fixIts,
        })
      } else if (preflight) {
        results.push({
          hookName: 'diagnostic-delta',
          validationStatus: 'diagnostic_delta_passed',
        })
      }
    }
  }

  return [
    { type: 'json', value: results },
  ] as CodebuffToolOutput<'run_file_change_hooks'>
}

function buildHookCommand(
  hook: FileChangeHook,
  files: string[],
  cwd: string,
): { command: string } | { errorMessage: string } {
  if (!hook.runPerFile) return { command: hook.command }
  const matchingFiles = hook.filePattern
    ? micromatch(files, hook.filePattern)
    : files
  const safeFiles = matchingFiles.flatMap((file) => {
    const absolute = path.resolve(cwd, file)
    const relative = path.relative(cwd, absolute)
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
      return []
    }
    return [toPosixPath(relative)]
  })
  if (safeFiles.length === 0) return { errorMessage: 'no safe files matched' }
  if (safeFiles.length > MAX_PER_FILE_HOOK_FILES) {
    return {
      errorMessage: `matched ${safeFiles.length} files, exceeding the ${MAX_PER_FILE_HOOK_FILES}-file safety limit`,
    }
  }
  return {
    command: safeFiles
      .map((file) => `${hook.command} ${shellQuote(file)}`)
      .join(' && '),
  }
}

function truncateOutput(value: unknown): string {
  if (typeof value !== 'string') return ''
  return value.length > MAX_HOOK_OUTPUT_CHARS
    ? value.slice(0, MAX_HOOK_OUTPUT_CHARS) + '\n…[truncated]'
    : value
}
