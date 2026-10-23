import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import { readdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { spawn } from 'node:child_process'

import {
  resolveProjectPath,
  resolveProjectPathForFileSystem,
} from '@codebuff/common/util/project-path-containment'

import {
  abortReason,
  mapWithConcurrency,
  raceAbort,
  throwIfAborted,
  withFilesystemSlot,
} from '../tools/concurrency'
import { createNodeFileSystem } from '../tools/node-filesystem'
import { LocalHarnessStore } from './local-harness-store'

import type { LocalHarnessRecord } from './local-harness-store'

export type EnvironmentInspection = {
  cwd: string
  packageManager?: string
  manifests: string[]
  lockfiles: string[]
  workspaces: Array<{
    root: string
    ecosystem: string
    manager: string
    manifest: string
    lockfile?: string
    confidence: 'confirmed' | 'inferred' | 'unknown'
  }>
  tools: Record<string, { available: boolean; version?: string }>
}

const manifestNames = [
  'package.json',
  'pyproject.toml',
  'Cargo.toml',
  'go.mod',
  'pom.xml',
  'build.gradle',
  'build.gradle.kts',
  'Package.swift',
  'requirements.txt',
  'setup.py',
  'setup.cfg',
]
const discoveryMarkerNames = ['gradlew', 'mvnw']
const lockfileNames = [
  'bun.lock',
  'bun.lockb',
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'uv.lock',
  'poetry.lock',
  'Cargo.lock',
  'go.sum',
  'Pipfile.lock',
  'packages.lock.json',
]

const ignoredDiscoveryDirectories = new Set([
  '.git',
  '.hg',
  '.svn',
  'node_modules',
  'target',
  'dist',
  'build',
  'out',
  '.next',
  '.turbo',
  '.cache',
  '.venv',
  'venv',
  '__pycache__',
])

function discoverNamedFiles(root: string): string[] {
  // Iterative walk with hard caps on depth and visited directories, ported
  // from build-graph's discoverBuildGraphFiles (security review F3): the old
  // unbounded recursion could stack-overflow or stall the main thread on a
  // pathological/deep tree. Symlinks are skipped, so hard-linked loops are
  // the remaining risk, bounded by the visit cap.
  const MAX_WALK_DEPTH = 12
  // Above this cap the two walks diverge: this one visits in DFS stack order
  // and the async twin in level-batched BFS order, so on a tree with more than
  // 2,000 visited directories they trim DIFFERENT subsets. The async BFS order
  // is canonical going forward (see discoverNamedFilesAsync).
  const MAX_VISITED_DIRS = 2_000
  const wanted = new Set([
    ...manifestNames,
    ...lockfileNames,
    ...discoveryMarkerNames,
  ])
  const found: string[] = []
  const stack: Array<{ directory: string; depth: number }> = [
    { directory: root, depth: 0 },
  ]
  let visited = 0
  while (stack.length > 0) {
    const current = stack.pop()
    if (!current) break
    if (visited++ >= MAX_VISITED_DIRS) break
    if (current.depth > MAX_WALK_DEPTH) continue
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(current.directory, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue
      const absolute = path.join(current.directory, entry.name)
      if (entry.isDirectory()) {
        if (!ignoredDiscoveryDirectories.has(entry.name)) {
          stack.push({ directory: absolute, depth: current.depth + 1 })
        }
      } else if (
        wanted.has(entry.name) ||
        entry.name.endsWith('.csproj') ||
        entry.name.endsWith('.sln')
      ) {
        found.push(path.relative(root, absolute).replace(/\\/g, '/'))
      }
    }
  }
  return found.sort()
}

/**
 * Concurrent readdir calls allowed in flight per batch of the async walk.
 * libuv's default thread pool is four threads and it also serves the render
 * loop's own fs work, so an unbounded level fan-out would saturate the very
 * pool it is meant to yield to.
 *
 * This is the PHASE width, not the process cap: `withFilesystemSlot` aggregates
 * every phase behind one shared budget, so a phase that entered at 8 could still
 * hold every one of the process's 8 slots while an overlapping interactive phase
 * waited. Each phase therefore names itself and passes this width as its own
 * limit, which the gate reduces by the reserved interactive headroom.
 */
const discoveryWalkReadDirConcurrency = 8

/** Phase label for the directory walk's readdir probes. */
const DISCOVERY_WALK_FS_PHASE = 'workspaceDiscoveryWalk'

/** Phase label for the manifest pre-read that follows the walk. */
const MANIFEST_PRE_READ_FS_PHASE = 'manifestPreRead'

/**
 * Async twin of `discoverNamedFiles`: same ignored-directory set, same symlink
 * skip, same depth and visited-directory caps, same output form and final sort.
 * The sync walk blocks the event loop for the whole traversal, and the aux gate
 * calls inspect_environment on every iteration, so a cache miss froze the TUI.
 */
async function discoverNamedFilesAsync(
  root: string,
  signal?: AbortSignal,
): Promise<string[]> {
  const MAX_WALK_DEPTH = 12
  // Canonical visit order: below this cap both walks visit the identical set
  // (output is sorted), but above it the level batching here and the sync
  // walk's DFS stack order truncate different subsets of an oversized tree, so
  // the sync and async twins can report different manifests exactly at the
  // cap. The async BFS order is the canonical subset going forward.
  const MAX_VISITED_DIRS = 2_000
  const wanted = new Set([
    ...manifestNames,
    ...lockfileNames,
    ...discoveryMarkerNames,
  ])
  const found: string[] = []
  let visited = 0
  let level: Array<{ directory: string; depth: number }> = [
    { directory: root, depth: 0 },
  ]
  while (level.length > 0 && visited < MAX_VISITED_DIRS) {
    // The remaining visit budget is trimmed BEFORE dispatch: the shared helper
    // bounds in-flight readdir calls, not total work, so without the trim a
    // whole level past the cap would still be read. The old manual batches
    // short-circuited the same way by stopping once the cap was reached.
    const batch = level.slice(0, MAX_VISITED_DIRS - visited)
    const listings = await mapWithConcurrency(
      batch,
      discoveryWalkReadDirConcurrency,
      ({ directory }) =>
        withFilesystemSlot(
          () => readdir(directory, { withFileTypes: true }).catch(() => null),
          signal,
          DISCOVERY_WALK_FS_PHASE,
          discoveryWalkReadDirConcurrency,
        ),
      signal,
    )
    const next: Array<{ directory: string; depth: number }> = []
    for (const [index, { directory, depth }] of batch.entries()) {
      visited += 1
      const entries = listings[index]
      if (!entries) continue
      for (const entry of entries) {
        if (entry.isSymbolicLink()) continue
        const absolute = path.join(directory, entry.name)
        if (entry.isDirectory()) {
          if (
            !ignoredDiscoveryDirectories.has(entry.name) &&
            depth < MAX_WALK_DEPTH
          ) {
            next.push({ directory: absolute, depth: depth + 1 })
          }
        } else if (
          wanted.has(entry.name) ||
          entry.name.endsWith('.csproj') ||
          entry.name.endsWith('.sln')
        ) {
          found.push(path.relative(root, absolute).replace(/\\/g, '/'))
        }
      }
    }
    level = next
  }
  return found.sort()
}

/**
 * Javascript dependency managers in resolution priority order, paired with the
 * lockfile that identifies them. Shared by `inferWorkspace`'s lockfile scan and
 * by the async manifest pre-read gate, so the two can never disagree about
 * whether a `package.json` already has a manager in scope.
 */
const javascriptManagerLockfiles: ReadonlyArray<readonly [string, string]> = [
  ['bun.lock', 'bun'],
  ['bun.lockb', 'bun'],
  ['pnpm-lock.yaml', 'pnpm'],
  ['yarn.lock', 'yarn'],
  ['package-lock.json', 'npm'],
]
const javascriptManagerLockfileNames = javascriptManagerLockfiles.map(
  ([name]) => name,
)

/**
 * Closest discovered file among `names`, searching `directory` and then its
 * ancestors inside the project. Extracted from `inferWorkspace`'s local helper
 * so the async manifest pre-read can ask the same question without duplicating
 * the walk-up logic.
 */
function closestDiscoveredFile(
  allFiles: Set<string>,
  directory: string,
  names: readonly string[],
): string | undefined {
  let current = directory
  while (true) {
    for (const name of names) {
      const candidate = current === '.' ? name : `${current}/${name}`
      if (allFiles.has(candidate)) return candidate
    }
    if (current === '.') return undefined
    const parent = path.posix.dirname(current)
    current = parent === current ? '.' : parent
  }
}

/**
 * How `inferWorkspace` may obtain a javascript manifest's text.
 *
 * `sync` is the original behaviour: read the file on demand with
 * `readFileSync`. `provided` means the caller has already supplied the text and
 * the blocking fallback is UNREACHABLE — a missing (`undefined`) or failed ('')
 * read resolves through the existing unknown-confidence path instead. The async
 * discovery walk uses `provided` for every manifest, so "no blocking read on the
 * async path" is a property of the read site rather than of which call site
 * happened to pre-read, which is what left a stray index able to block.
 */
type ManifestTextMode = 'sync' | 'provided'

/**
 * One workspace's inference. `onSyncRead` fires immediately before any blocking
 * manifest read, which is what lets the async discovery path prove — rather than
 * assume — that it never reaches one.
 */
function inferWorkspace(
  root: string,
  manifest: string,
  allFiles: Set<string>,
  manifestContent: string | undefined,
  manifestTextMode: ManifestTextMode,
  onSyncRead?: () => void,
) {
  const directory =
    path.posix.dirname(manifest) === '.' ? '.' : path.posix.dirname(manifest)
  const at = (name: string) =>
    directory === '.' ? name : `${directory}/${name}`
  const closest = (names: readonly string[]): string | undefined =>
    closestDiscoveredFile(allFiles, directory, names)
  const base = path.posix.basename(manifest)
  let ecosystem = 'unknown'
  let manager = 'unknown'
  let lockfile: string | undefined
  let confidence: 'confirmed' | 'inferred' | 'unknown' = 'inferred'
  if (base === 'package.json') {
    ecosystem = 'javascript'
    for (const [candidate, value] of javascriptManagerLockfiles) {
      const discoveredLockfile = closest([candidate])
      if (discoveredLockfile) {
        lockfile = discoveredLockfile
        manager = value
        confidence = 'confirmed'
        break
      }
    }
    if (manager === 'unknown') {
      try {
        // `provided` makes the blocking read STRUCTURALLY unreachable: the
        // async discovery path always takes that branch, so no manifest index it
        // left unread can reach `readFileSync`. An absent or failed ('') text
        // fails the parse below, which is the same unknown-confidence answer an
        // unreadable sync read gave — and no second, blocking read is attempted.
        if (manifestTextMode === 'sync' && manifestContent === undefined) {
          onSyncRead?.()
          manifestContent = fs.readFileSync(path.join(root, manifest), 'utf8')
        }
        const parsed = JSON.parse(manifestContent ?? '') as {
          packageManager?: string
        }
        if (parsed.packageManager) {
          manager = parsed.packageManager.split('@')[0]
          confidence = 'confirmed'
        } else {
          manager = 'npm'
          confidence = 'inferred'
        }
      } catch {
        confidence = 'unknown'
      }
    }
  } else if (base === 'Cargo.toml') {
    ecosystem = 'rust'
    manager = 'cargo'
    lockfile = allFiles.has(at('Cargo.lock')) ? at('Cargo.lock') : undefined
    confidence = 'confirmed'
  } else if (base === 'go.mod') {
    ecosystem = 'go'
    manager = 'go'
    lockfile = allFiles.has(at('go.sum')) ? at('go.sum') : undefined
    confidence = 'confirmed'
  } else if (base === 'pom.xml') {
    ecosystem = 'java'
    manager = closest(['mvnw']) ? 'maven-wrapper' : 'maven'
    confidence = 'confirmed'
  } else if (base === 'build.gradle' || base === 'build.gradle.kts') {
    ecosystem = 'jvm'
    manager = closest(['gradlew']) ? 'gradle-wrapper' : 'gradle'
    confidence = 'confirmed'
  } else if (
    base === 'pyproject.toml' ||
    base === 'requirements.txt' ||
    base === 'setup.py' ||
    base === 'setup.cfg'
  ) {
    ecosystem = 'python'
    const pythonLockfile = closest(['uv.lock', 'poetry.lock', 'Pipfile.lock'])
    if (pythonLockfile?.endsWith('uv.lock')) {
      manager = 'uv'
      lockfile = pythonLockfile
      confidence = 'confirmed'
    } else if (pythonLockfile?.endsWith('poetry.lock')) {
      manager = 'poetry'
      lockfile = pythonLockfile
      confidence = 'confirmed'
    } else if (pythonLockfile?.endsWith('Pipfile.lock')) {
      manager = 'pipenv'
      lockfile = pythonLockfile
      confidence = 'confirmed'
    } else {
      manager = 'python'
      confidence = 'inferred'
    }
  } else if (base.endsWith('.csproj') || base.endsWith('.sln')) {
    ecosystem = 'dotnet'
    manager = 'dotnet'
    lockfile = allFiles.has(at('packages.lock.json'))
      ? at('packages.lock.json')
      : undefined
    confidence = 'confirmed'
  } else if (base === 'Package.swift') {
    ecosystem = 'swift'
    manager = 'swift'
    confidence = 'confirmed'
  }
  return {
    root: directory,
    ecosystem,
    manager,
    manifest,
    ...(lockfile ? { lockfile } : {}),
    confidence,
  }
}

/**
 * Async workspace inference. `inferWorkspace`'s only blocking work is the
 * fallback `readFileSync` of a javascript manifest, so those texts are read
 * concurrently up front and handed in — and this path passes `provided` for
 * EVERY manifest, not just the ones it managed to read, so the blocking branch
 * cannot be reached whatever the pre-read did. Output order and every field
 * (including the `unknown` fallback on read/parse failure) are unchanged.
 *
 * Two bounds keep that pre-read honest. The text is consumed ONLY by the
 * fallback below — `inferWorkspace` reads it after its lockfile scan has
 * already failed to resolve a manager — so a `package.json` whose scope already
 * contains bun.lock / pnpm-lock.yaml / yarn.lock / package-lock.json is never
 * read at all, which is the common case in a real repository. The reads that do
 * happen are batched at `discoveryWalkReadDirConcurrency`, the same width the
 * walks use: one `readFile` per manifest at once would queue a monorepo's
 * hundreds of manifests onto the very libuv thread pool those walks are capped
 * to leave to the render loop, and every one of them would be discarded.
 */
async function inferWorkspacesAsync(
  root: string,
  manifests: string[],
  allFiles: Set<string>,
  signal?: AbortSignal,
): Promise<ReturnType<typeof inferWorkspace>[]> {
  const contents = new Map<number, string>()
  const pendingReads: Array<{ manifest: string; index: number }> = []
  for (const [index, manifest] of manifests.entries()) {
    if (path.posix.basename(manifest) !== 'package.json') continue
    // A recognised lockfile anywhere in the manifest's scope decides the
    // manager, so the manifest text can never be consulted.
    if (
      closestDiscoveredFile(
        allFiles,
        path.posix.dirname(manifest),
        javascriptManagerLockfileNames,
      )
    ) {
      continue
    }
    pendingReads.push({ manifest, index })
  }
  const reads = await mapWithConcurrency(
    pendingReads,
    discoveryWalkReadDirConcurrency,
    // A failed read resolves '', which fails the JSON parse in inferWorkspace
    // and lands on its existing unknown-confidence path — never a second,
    // blocking read attempt. An unreadable sync read answered the same way.
    ({ manifest }) =>
      withFilesystemSlot(
        () => readFile(path.join(root, manifest), 'utf8').catch(() => ''),
        signal,
        MANIFEST_PRE_READ_FS_PHASE,
        discoveryWalkReadDirConcurrency,
      ),
    signal,
  )
  for (const [readIndex, { index }] of pendingReads.entries()) {
    contents.set(index, reads[readIndex])
  }
  // `provided` unconditionally: a manifest this pre-read skipped has its text
  // decided by its lockfile, and one it could not read answers via the
  // unknown-confidence parse failure. Neither may fall back to a blocking read,
  // so the mode is what makes the guarantee structural rather than per-index.
  return manifests.map((manifest, index) =>
    inferWorkspace(
      root,
      manifest,
      allFiles,
      contents.get(index),
      'provided',
      noteAsyncDiscoveryBlockingRead,
    ),
  )
}

let asyncDiscoveryBlockingReads = 0

/**
 * Records a blocking manifest read reached from the async discovery path. The
 * `'provided'` mode is supposed to make that unreachable, so anything counted
 * here is the regression the test seam below exists to catch.
 */
function noteAsyncDiscoveryBlockingRead(): void {
  asyncDiscoveryBlockingReads += 1
}

/**
 * Test seam: blocking `readFileSync` calls attributed to async discovery. The
 * async twin exists so the event loop never absorbs a blocking manifest read,
 * and that has to be a property of the READ SITE rather than of which manifests
 * happened to be pre-read. This counter must stay 0.
 */
export function __getAsyncDiscoverySyncReadsForTest(): number {
  return asyncDiscoveryBlockingReads
}

export function __resetAsyncDiscoverySyncReadsForTest(): void {
  asyncDiscoveryBlockingReads = 0
}

/**
 * The child handle the `--version` probe seam is allowed to touch.
 *
 * Only these three members are used — kill on timeout/abort, the two output
 * pipes, and the error/close notifications — so the seam's contract stays far
 * narrower than Node's `ChildProcess`. A fake only has to honour these, which
 * is what makes the concurrency assertion below writable without a real spawn.
 */
type ToolProbeChild = {
  stdout?: {
    on: (event: 'data', listener: (chunk: Buffer) => void) => unknown
  } | null
  stderr?: {
    on: (event: 'data', listener: (chunk: Buffer) => void) => unknown
  } | null
  onError: (listener: () => void) => unknown
  onClose: (listener: (code: number | null) => void) => unknown
  kill: (signal?: NodeJS.Signals) => unknown
}


/**
 * Injectable spawn for the `--version` probe: takes the argv pair and returns
 * the narrowed child handle above.
 */
type ToolProbeSpawn = (command: string, args: string[]) => ToolProbeChild

/**
 * Upper bound on how long one `--version` probe may run before it is killed.
 * Matches the sync spawnSync contract's timeout exactly.
 */
const toolVersionTimeoutMs = 3_000

/** Upper bound on bytes retained from one probe's stdout/stderr. */
const toolVersionMaxBytes = 64 * 1_024

/**
 * Production spawn for the `--version` probe.
 *
 * Node's `ChildProcess` is structurally wider than `ToolProbeChild`, so the
 * handle is narrowed rather than cast: a missing `kill` or a pipe absent from
 * the narrowed shape degrades to a no-op instead of throwing at the seam.
 */
const defaultToolProbeSpawn: ToolProbeSpawn = (command, args) => {
  const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] })
  return {
    stdout: child.stdout ?? undefined,
    stderr: child.stderr ?? undefined,
    onError: (listener) => child.on('error', listener),
    onClose: (listener) => child.on('close', listener),
    kill: (signal) => child.kill(signal),
  }
}

let toolProbeSpawn: ToolProbeSpawn = defaultToolProbeSpawn

/**
 * Test seam for the `--version` probe spawn. It exists to pin the concurrency
 * baseline the async probe path is justified by: the docblock on
 * `probeToolsAsync` claims the 14 probes overlap, and without an injectable
 * spawn that claim is unfalsifiable — a future revert to serial spawns would
 * keep the suite green while restoring the TUI freeze.
 */
export function __setToolProbeSpawnForTest(spawnImpl?: ToolProbeSpawn): void {
  toolProbeSpawn = spawnImpl ?? defaultToolProbeSpawn
}

/**
 * Async twin of `toolVersion`, used by the live inspect_environment path.
 *
 * WHY this exists: `spawnSync` blocks the event loop for the whole duration of
 * every `--version` probe, so the 14 probes blocked it for the SUM of their
 * runtimes, and the aux gate calls inspect_environment on every spawn
 * iteration. The CLI TUI renders on that same event loop, so the sync probe
 * froze the UI on every call. This variant keeps the same timeout and the same
 * `{ available: false }` on failure — but resolves off the event loop.
 *
 * One deliberate contract difference from `spawnSync`, documented here so the
 * claims and the behaviour cannot drift apart again: output is TRUNCATED at
 * `toolVersionMaxBytes` (64KB) and the tool still reports `available` with its
 * first output line, where `spawnSync`'s 1MB `maxBuffer` failure used to report
 * an over-chatty tool as unavailable. A probe is advisory, so degrading to the
 * bounded first line matches this module's never-fail error handling better
 * than flipping the availability verdict on output volume.
 *
 * The correctness claim pinned by the suite is structural, not a wall-clock
 * measurement: all TOOL_PROBE_COUNT probes are in flight simultaneously, so the
 * group's wall clock is bounded by one probe timeout instead of the sum of 14
 * runtime durations. See `__setToolProbeSpawnForTest` for the seam that keeps
 * that assertion checkable.
 *
 * Never rejects: a probe is advisory, and ENOENT (a missing tool) arrives as an
 * 'error' event rather than a non-zero status, so it must degrade to
 * `{ available: false }` instead of crashing the inspection.
 */
function toolVersionAsync(
  command: string,
  args: string[] = ['--version'],
  signal?: AbortSignal,
): Promise<{ available: boolean; version?: string }> {
  return new Promise((resolve) => {
    let settled = false
    let output = ''
    let outputBytes = 0
    let child: ToolProbeChild | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    const onAbort = (): void => {
      // A cancelled inspection must not keep 14 children alive until the probe
      // timeout: kill the child and settle immediately, mirroring the timeout
      // path so the caller's Promise.all drains at once instead of after the
      // full probe window.
      child?.kill('SIGKILL')
      settle({ available: false })
    }
    const settle = (result: { available: boolean; version?: string }): void => {
      // Single settle gate: timeout, 'error', and 'close' can race, and the
      // timer must be cleared on EVERY path so no probe leaks a live timer.
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      resolve(result)
    }
    // Registered before the spawn so a signal that is already aborted never
    // leaves a child running with no listener to kill it.
    if (signal?.aborted) {
      resolve({ available: false })
      return
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    timer = setTimeout(() => {
      // A probe that never exits would otherwise leave one hung child per tool
      // (14 per inspection, on every aux-gate iteration), so kill it and report
      // the tool as unavailable. spawnSync's `timeout` did this implicitly.
      child?.kill('SIGKILL')
      settle({ available: false })
    }, toolVersionTimeoutMs)
    try {
      child = toolProbeSpawn(command, args)
    } catch {
      // Defensive only: spawn reports synchronous failures via 'error' too.
      settle({ available: false })
      return
    }
    const collect = (chunk: Buffer): void => {
      if (outputBytes >= toolVersionMaxBytes) return
      outputBytes += chunk.byteLength
      output += chunk.toString()
      if (outputBytes > toolVersionMaxBytes) {
        output = output.slice(0, toolVersionMaxBytes)
      }
    }
    // Both pipes MUST be drained: an undrained stream fills its OS buffer and
    // blocks the child indefinitely, which would only end at the timeout.
    child.stdout?.on('data', collect)
    child.stderr?.on('data', collect)
    child.onError(() => settle({ available: false }))
    child.onClose((code) => {
      if (code !== 0) {
        settle({ available: false })
        return
      }
      const version = output.trim().split('\n')[0]
      settle({ available: true, ...(version ? { version } : {}) })
    })
  })
}

/**
 * Module-level TTL cache for the tool-version probes (perf): every
 * inspect_environment call used to spawn all 14 `--version` probes serially,
 * even though installed tool versions change far more slowly than any single
 * run. The cache is a single slot keyed by the fixed, cwd-independent probe
 * list (tool availability is a property of PATH, not of the workspace),
 * invalidated by TTL or clearHarnessToolsCache. Statuses stay honest: each
 * entry records exactly what its probe returned at cache time; no availability
 * is ever fabricated for a tool that was absent.
 */
const toolsCacheTtlMs = 60_000
/**
 * Either the probe group currently in flight or its resolved record. The
 * pending form is what keeps N concurrent inspect_environment callers from each
 * spawning 14 children: the cache slot is written BEFORE the first await, so a
 * caller that arrives mid-group shares that group instead of missing the cache.
 */
type PendingToolProbeCacheEntry = {
  pending: Promise<EnvironmentInspection['tools']>
  /**
   * Identity of the snapshot that owns `pending`. Publishing compares this
   * against the slot that is live when the probes settle, so a snapshot
   * invalidated mid-flight cannot write its pre-clear result back.
   */
  snapshot: object
  /**
   * The group's OWN controller, never linked to any caller's signal: binding
   * the starting caller's signal settled every probe `{ available: false }`
   * when that one caller aborted, and the resolved group published the
   * fabricated all-unavailable record into this 60s slot for everyone. The
   * controller fires only from `awaitToolProbeGroup`, once the last caller
   * waiting on the group has stopped waiting — the discovery cache's
   * `registerDiscoveryWaiter` pattern, so unwanted children are killed instead
   * of running to the probe timeout.
   */
  controller: AbortController
  /** Callers currently awaiting `pending`; the last one out aborts the group. */
  waiters: number
}
type ToolProbeCacheEntry =
  | PendingToolProbeCacheEntry
  | { expiresAt: number; result: EnvironmentInspection['tools'] }
let toolsCache: ToolProbeCacheEntry | undefined

/** Drop the cached tool-probe record (tests; toolchain installs in long runs). */
export function clearHarnessToolsCache(): void {
  toolsCache = undefined
}

/**
 * True when the slot still holds the pending entry belonging to `snapshot`.
 * Both write paths below are gated on it: a clear (or a replacement group
 * started after this one was dropped) must win over a snapshot that is still
 * in flight, otherwise the caller who asked for fresh data is served the old
 * answer for another full window.
 */
function ownsToolProbeSlot(snapshot: object): boolean {
  const current = toolsCache
  return current !== undefined && 'pending' in current && current.snapshot === snapshot
}

/**
 * The 14 probes run concurrently via Promise.all, so their wall-clock cost is
 * one probe timeout instead of the sum of 14 serial spawns. `expiresAt` is
 * anchored after the group settles (see `refreshToolProbes`) so a slow miss
 * does not shorten its own cache window. Sharing the SAME module-level cache
 * slot and `clearHarnessToolsCache()` escape hatch keeps caching semantics
 * identical for every caller.
 *
 * The in-flight group is memoized in the slot itself. Without that, every
 * concurrent caller inside the probe window missed a cache that is only written
 * after all 14 probes settle, so N overlapping inspections became 14xN spawned
 * children — and because the sync version it replaces serialised callers on the
 * event loop, the single cache slot used to be a de facto mutex that the async
 * rewrite removed. Sharing the pending promise restores one group per window.
 */
async function probeToolsAsync(
  signal?: AbortSignal,
): Promise<EnvironmentInspection['tools']> {
  throwIfAborted(signal)
  const cached = toolsCache
  if (cached) {
    // The shared group is never cancellable on one caller's behalf — another
    // inspection may still want it — so every caller, the one that started the
    // group included, races its own signal against the shared promise instead
    // of contributing to a shared abort.
    if ('pending' in cached) return awaitToolProbeGroup(cached, signal)
    if (cached.expiresAt > Date.now()) return cached.result
  }
  // The snapshot token identifies `pending` inside the slot, so the publish
  // below can tell "my entry is still the live one" from "someone cleared or
  // replaced it while my 14 probes were running".
  const snapshot = {}
  // The group's own detached controller is the ONLY signal the probes see. It
  // is never linked to a caller's signal, so no single caller's abort can
  // settle the shared probes; it fires solely from the last-waiter release in
  // `awaitToolProbeGroup`, and `groupAborted` is what lets the publish below
  // refuse to cache the all-unavailable record such a kill produces.
  const controller = new AbortController()
  let groupAborted = false
  controller.signal.addEventListener(
    'abort',
    () => {
      groupAborted = true
    },
    { once: true },
  )
  const entry: PendingToolProbeCacheEntry = {
    pending: refreshToolProbes(controller.signal).then(
      (result) => {
        // Belt-and-braces: a group settled by its own cancellation fabricated
        // `{ available: false }` for every tool, so it must never be published
        // — the pending entry is dropped instead and the next caller pays for
        // a fresh group rather than being served the poisoned record.
        if (groupAborted) {
          if (ownsToolProbeSlot(snapshot)) toolsCache = undefined
          return result
        }
        if (ownsToolProbeSlot(snapshot)) {
          toolsCache = { expiresAt: Date.now() + toolsCacheTtlMs, result }
        }
        return result
      },
      (error: unknown) => {
        // A failed group must never wedge the slot on a dead promise: the next
        // caller gets a fresh one instead of the previous rejection — but only
        // when this snapshot still owns the slot, so a rejection cannot drop a
        // replacement group stored by another caller.
        if (ownsToolProbeSlot(snapshot)) toolsCache = undefined
        throw error
      },
    ),
    snapshot,
    controller,
    waiters: 0,
  }
  toolsCache = entry
  return awaitToolProbeGroup(entry, signal)
}

/**
 * Awaits the shared probe group on behalf of one caller. The caller registers
 * as a waiter: a cancelling caller stops waiting (its own race rejects with its
 * own reason) without settling the shared group for anyone else, and once the
 * LAST waiter is gone the group's own controller kills the children nobody is
 * left wanting instead of letting them run to the probe timeout. Mirrors the
 * discovery cache's `awaitDiscovery` waiter accounting.
 */
async function awaitToolProbeGroup(
  entry: PendingToolProbeCacheEntry,
  signal?: AbortSignal,
): Promise<EnvironmentInspection['tools']> {
  throwIfAborted(signal)
  entry.waiters += 1
  let released = false
  const release = (): void => {
    if (released) return
    released = true
    entry.waiters -= 1
    if (entry.waiters === 0) {
      entry.controller.abort()
      // Retire the pending entry: the abort-settled group resolves (it never
      // rejects) with fabricated unavailability, and the publish path above
      // refuses to cache it — so the next caller must miss the cache and start
      // a live group rather than adopt a dead promise. Identity-checked so a
      // resolved record the group already published is never dropped.
      if (ownsToolProbeSlot(entry.snapshot)) toolsCache = undefined
    }
  }
  try {
    return await raceAbort(entry.pending, signal)
  } finally {
    release()
  }
}

/**
 * Runs the 14 probes and returns their frozen record. It deliberately does NOT
 * write the cache slot itself: publishing is identity-checked in
 * `probeToolsAsync`, which is the only place that knows which snapshot owns
 * the slot. `expiresAt` is anchored AFTER the group settles: anchoring it
 * before the await made the effective window TTL minus the miss cost, so the
 * slowest miss produced the soonest expiry.
 */
async function refreshToolProbes(
  signal?: AbortSignal,
): Promise<EnvironmentInspection['tools']> {
  const [
    git,
    bun,
    node,
    python,
    rust,
    go,
    k6,
    cargo,
    uv,
    poetry,
    maven,
    gradle,
    dotnet,
    blender,
  ] = await Promise.all([
    toolVersionAsync('git', undefined, signal),
    toolVersionAsync('bun', undefined, signal),
    toolVersionAsync('node', undefined, signal),
    toolVersionAsync('python3', undefined, signal),
    toolVersionAsync('rustc', undefined, signal),
    toolVersionAsync('go', ['version'], signal),
    toolVersionAsync('k6', undefined, signal),
    toolVersionAsync('cargo', undefined, signal),
    toolVersionAsync('uv', undefined, signal),
    toolVersionAsync('poetry', undefined, signal),
    toolVersionAsync('mvn', undefined, signal),
    toolVersionAsync('gradle', undefined, signal),
    toolVersionAsync('dotnet', undefined, signal),
    toolVersionAsync('blender', undefined, signal),
  ])
  const result: EnvironmentInspection['tools'] = {
    git,
    bun,
    node,
    python,
    rust,
    go,
    k6,
    cargo,
    uv,
    poetry,
    maven,
    gradle,
    dotnet,
    blender,
  }
  // Frozen so a caller mutating the returned record cannot poison the cache.
  for (const probe of Object.values(result)) Object.freeze(probe)
  return Object.freeze(result)
}

type WorkspaceDiscovery = {
  root: string
  manifests: string[]
  lockfiles: string[]
  workspaces: ReturnType<typeof inferWorkspace>[]
}

/**
 * Per-cwd discovery cache. `discoverNamedFiles` walks the whole project tree,
 * and the aux gate calls inspect_environment + get_affected_tests +
 * get_build_targets on every iteration, so the uncached cost is three full
 * walks per iteration. Manifests/lockfiles change far more slowly than source
 * files, so a short TTL keeps the hot path cheap while still picking up a newly
 * added workspace. Test-file freshness is unaffected: getAffectedTestTargets
 * still stats candidate test paths on every call.
 */
const discoveryCacheTtlMs = 5_000
const discoveryCacheMaxEntries = 32
/**
 * Either the traversal currently in flight or its resolved record. The pending
 * form is what covers overlapping callers (an Enter press plus a gate/aux
 * call): a resolved-only entry only helped a caller arriving AFTER the walk
 * finished, which is not when the freeze happens.
 */
/**
 * One traversal in flight plus the callers waiting on it.
 *
 * `snapshot` is that traversal's identity: both write paths below compare it
 * against the entry the map holds when they run, so a clear, an LRU eviction or
 * a newer traversal that lands mid-walk wins instead of being overwritten by
 * the pre-invalidation workspace view.
 *
 * `waiters` counts the callers currently awaiting the result. The traversal is
 * deduped through the cache, so it is cancelled only once NO caller is waiting
 * any more — one caller's abort must never reject another caller's await.
 *
 * `cancelled` makes that count a two-way latch instead of a one-way one. Without
 * it a walk could be aborted by the last waiter leaving while the entry stayed
 * published, so every later caller was handed an already-aborted promise and a
 * permanent zero waiter count meant no future release could ever cancel it
 * again. A cancelled traversal is dropped from the slot at the moment it is
 * aborted (see `registerDiscoveryWaiter`), so the next caller starts a live one.
 */
type PendingDiscoveryCacheEntry = {
  pending: Promise<WorkspaceDiscovery>
  snapshot: object
  controller: AbortController
  waiters: number
  cancelled: boolean
}
type DiscoveryCacheEntry =
  | PendingDiscoveryCacheEntry
  | { expiresAt: number; result: WorkspaceDiscovery }

const discoveryCache = new Map<string, DiscoveryCacheEntry>()

/** Drop every cached discovery result (tests, and callers that just scaffolded a workspace). */
export function clearHarnessDiscoveryCache(): void {
  // In-flight traversals are dropped along with the resolved records: they
  // publish through the identity check below, so a walk that is still running
  // can never write the pre-clear view back into the slot its caller asked to
  // have invalidated.
  discoveryCache.clear()
}

/**
 * Test seam: how many entries the discovery cache currently holds. The cache is
 * documented as bounded, and the in-flight (pending) form is one of the three
 * writers, so the bound needs an observable that covers pending insertions too:
 * a regression that inserted pending entries with a raw `set` would leave every
 * lookup result identical while letting the map grow without limit.
 */
export function __getDiscoveryCacheSizeForTest(): number {
  return discoveryCache.size
}

/**
 * Insert-or-refresh an entry. Re-inserting on write keeps the Map ordered
 * least-recently-used first, so the bound drops a cold root rather than a hot
 * one.
 */
function storeDiscoveryEntry(
  root: string,
  entry: DiscoveryCacheEntry,
): void {
  discoveryCache.delete(root)
  if (discoveryCache.size >= discoveryCacheMaxEntries) {
    const oldest = discoveryCache.keys().next()
    if (!oldest.done) discoveryCache.delete(oldest.value)
  }
  discoveryCache.set(root, entry)
}

/**
 * True when `root`'s slot still holds the pending entry belonging to
 * `snapshot`. Every async publish and cleanup path is gated on it, so a clear,
 * an eviction, or a newer traversal that landed mid-walk cannot be clobbered by
 * the result of a walk that has already been invalidated.
 */
function ownsDiscoverySnapshot(root: string, snapshot: object): boolean {
  const current = discoveryCache.get(root)
  return (
    current !== undefined && 'pending' in current && current.snapshot === snapshot
  )
}

/**
 * Registers one caller as waiting on the shared traversal and returns the
 * matching deregistration. Deregistering the LAST waiter cancels the walk, so a
 * cancelled tool stops queueing readdir/stat probes behind the filesystem gate;
 * while any caller is still waiting the walk keeps running, because the
 * traversal is shared and one caller's abort must not reject another's result.
 */
function registerDiscoveryWaiter(
  entry: PendingDiscoveryCacheEntry,
  signal: AbortSignal | undefined,
  onAbort: () => void,
): () => void {
  entry.waiters += 1
  let released = false
  function release(): void {
    if (released) return
    released = true
    signal?.removeEventListener('abort', onAbort)
    entry.waiters -= 1
    if (entry.waiters === 0 && !entry.cancelled) {
      entry.cancelled = true
      entry.controller.abort(signal?.reason)
      // Retire the aborted traversal from the slot. Leaving it published is what
      // made the candidate a permanent trap: a still-pending entry that is
      // already aborted gets served to every later caller, and a waiter count
      // stuck at 0 means no later release can cancel it either. Dropping it
      // here means the next caller starts a fresh, live traversal instead of
      // adopting a dead promise. Identity-checked so a replacement entry stored
      // meanwhile is never dropped.
      releaseDiscoverySlot(entry.snapshot)
    }
  }
  if (signal?.aborted) {
    // Never park an already-cancelled caller as a waiter: its `abort` listener
    // would not fire again, so the release would run only via the race below.
    queueMicrotask(release)
    return release
  }
  signal?.addEventListener('abort', onAbort, { once: true })
  return release
}

/**
 * Drops `root`'s slot iff it still holds the pending entry belonging to
 * `snapshot`. Used by the two cancellation paths so an aborted traversal is
 * retired without ever dropping a replacement entry another caller stored.
 */
function releaseDiscoverySlot(snapshot: object): void {
  for (const [root, entry] of discoveryCache) {
    if ('pending' in entry && entry.snapshot === snapshot) {
      discoveryCache.delete(root)
      return
    }
  }
}

/**
 * Awaits the shared traversal on behalf of one caller. A caller that cancels
 * rejects immediately with its own reason instead of waiting for the walk to
 * unwind, and it stops counting as a waiter so the walk is cancelled once the
 * last interested caller is gone.
 */
async function awaitDiscovery(
  entry: PendingDiscoveryCacheEntry,
  signal?: AbortSignal,
): Promise<WorkspaceDiscovery> {
  throwIfAborted(signal)
  if (!signal) {
    const release = registerDiscoveryWaiter(entry, undefined, () => {})
    try {
      return await entry.pending
    } finally {
      release()
    }
  }
  const activeSignal = signal
  let rejectCancelled: (error: Error) => void = () => {}
  const cancelled = new Promise<never>((_resolve, reject) => {
    rejectCancelled = reject
  })
  const release = registerDiscoveryWaiter(entry, activeSignal, () => {
    rejectCancelled(abortReason(activeSignal))
  })
  try {
    return await Promise.race([entry.pending, cancelled])
  } finally {
    release()
  }
}

/**
 * Shared filtering/inference step for both the sync and async discovery paths,
 * so the two can never disagree about what a discovered file list means.
 */
function buildDiscovery(
  root: string,
  discovered: string[],
  workspaces: ReturnType<typeof inferWorkspace>[],
): WorkspaceDiscovery {
  const manifests = discovered.filter((file) => {
    const base = path.posix.basename(file)
    return (
      manifestNames.includes(base) ||
      base.endsWith('.csproj') ||
      base.endsWith('.sln')
    )
  })
  const lockfiles = discovered.filter((file) =>
    lockfileNames.includes(path.posix.basename(file)),
  )
  return { root, manifests, lockfiles, workspaces }
}

/**
 * Synchronous discovery, retained for hosts and callers that work in a
 * synchronous context. It publishes its own resolved record so those callers
 * keep a populated cache, and the async twin adopts that record if it lands
 * while its own walk is still pending (see collectWorkspaceDiscoveryAsync),
 * so the two paths can never clobber each other or cost two walks.
 */
function discoverWorkspaces(cwd: string): WorkspaceDiscovery {
  const root = path.resolve(cwd)
  const cached = discoveryCache.get(root)
  if (cached && 'result' in cached && cached.expiresAt > Date.now()) {
    return cached.result
  }
  const discovered = discoverNamedFiles(root)
  // One shared lookup set for every manifest: `inferWorkspace` only ever calls
  // `has` on it, so rebuilding the set per manifest was pure
  // O(manifests x discovered files) allocation on a path the aux gate hits
  // three times per iteration. The async twin hoists it the same way.
  const discoveredSet = new Set(discovered)
  const workspaces = discovered
    .filter((file) => manifestNames.includes(path.posix.basename(file)))
    // The SYNC path legitimately blocks on a manifest read, so it must NOT
    // tick `noteAsyncDiscoveryBlockingRead`: that counter pins the async
    // path's read site — the guarantee `provided` makes — and a sync tick
    // would report every legitimate sync read as an async regression.
    .map((manifest) =>
      inferWorkspace(root, manifest, discoveredSet, undefined, 'sync'),
    )
  const result = buildDiscovery(root, discovered, workspaces)
  storeDiscoveryEntry(root, {
    expiresAt: Date.now() + discoveryCacheTtlMs,
    result,
  })
  return result
}

/**
 * Async discovery for `inspect_environment`. The walk and the manifest reads
 * run off the event loop, and the in-flight promise is memoized BEFORE the
 * first await so two overlapping callers (an Enter press plus the aux gate)
 * share one traversal instead of each paying a full walk.
 */
async function discoverWorkspacesAsync(
  cwd: string,
  signal?: AbortSignal,
): Promise<WorkspaceDiscovery> {
  throwIfAborted(signal)
  const root = path.resolve(cwd)
  const cached = discoveryCache.get(root)
  if (cached) {
    // An already-cancelled traversal is never handed to a new caller: its
    // promise can only reject, so the slot is treated as absent and a fresh,
    // live walk replaces it below.
    if ('pending' in cached) {
      if (!cached.cancelled) return awaitDiscovery(cached, signal)
      discoveryCache.delete(root)
    } else if (cached.expiresAt > Date.now()) {
      storeDiscoveryEntry(root, cached)
      return cached.result
    }
  }
  // The snapshot token is this traversal's identity inside the slot, and the
  // controller is what lets the walk stop queueing filesystem probes once the
  // last caller waiting on it has gone away.
  const snapshot = {}
  const controller = new AbortController()
  const pending = collectWorkspaceDiscoveryAsync(
    root,
    snapshot,
    controller.signal,
  )
  // A cancelled traversal rejects with nobody left awaiting it, which would
  // otherwise surface as an unhandled rejection. Handled here; every real
  // consumer still observes the rejection through `entry.pending`.
  pending.catch(() => {})
  const entry: PendingDiscoveryCacheEntry = {
    pending,
    snapshot,
    controller,
    waiters: 0,
    cancelled: false,
  }
  // Stored through the shared helper, not a raw `set`: the pending form is a
  // write to the same bounded Map, so in-flight entries have to honour
  // `discoveryCacheMaxEntries` and least-recently-used ordering exactly like the
  // resolved publish and the cache-hit refresh do. A raw `set` let concurrent
  // lookups over many distinct roots (the aux gate issues three tools per
  // iteration and each resolves its own root) grow the map past the bound its
  // docblock promises.
  storeDiscoveryEntry(root, entry)
  return awaitDiscovery(entry, signal)
}

/**
 * Runs the async walk and publishes its record over the pending entry.
 * `expiresAt` is anchored AFTER the work resolves: anchoring it before the
 * await made the effective window TTL minus the miss cost, so the slowest miss
 * expired soonest.
 */
async function collectWorkspaceDiscoveryAsync(
  root: string,
  snapshot: object,
  signal: AbortSignal,
): Promise<WorkspaceDiscovery> {
  try {
    // Yield once before walking. A sync caller (getAffectedTestTargets /
    // analyzeTestImpact / getBuildTargets via discoverWorkspaces) can publish a
    // resolved record for this root while this traversal is still pending, and
    // adopting it makes one TTL miss cost ONE tree walk instead of two while
    // leaving that caller's entry in place instead of clobbering it.
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    throwIfAborted(signal)
    const published = discoveryCache.get(root)
    if (
      published &&
      'result' in published &&
      published.expiresAt > Date.now()
    ) {
      return published.result
    }
    const discovered = await discoverNamedFilesAsync(root, signal)
    const workspaces = await inferWorkspacesAsync(
      root,
      discovered.filter((file) =>
        manifestNames.includes(path.posix.basename(file)),
      ),
      new Set(discovered),
      signal,
    )
    throwIfAborted(signal)
    const result = buildDiscovery(root, discovered, workspaces)
    // Identity-checked publish: a clear, an eviction, or a newer traversal that
    // landed while this walk ran must win, so the pre-invalidation workspace
    // view cannot be written back over the slot the caller invalidated.
    if (ownsDiscoverySnapshot(root, snapshot)) {
      storeDiscoveryEntry(root, {
        expiresAt: Date.now() + discoveryCacheTtlMs,
        result,
      })
    }
    return result
  } catch (error) {
    // A rejected (or cancelled) walk must never wedge the slot on a dead
    // promise — but only while this traversal still owns the slot, so it cannot
    // drop a replacement entry stored by another caller.
    if (ownsDiscoverySnapshot(root, snapshot)) discoveryCache.delete(root)
    throw error
  }
}

/**
 * Phase-overlap bookkeeping for the two independent reads
 * `inspectHarnessEnvironment` starts together. Discovery and the tool probes are
 * documented as overlapping — "a cache miss costs the max of the two instead of
 * their sum" — and every sibling claim in this module is pinned by an
 * observable counter, so this one is too: a change that re-serialised the pair
 * would keep every result identical (and every existing test green) while
 * restoring the summed latency.
 */
type InspectPhaseEvent = {
  phase: 'discovery' | 'toolProbes'
  event: 'start' | 'settle'
}

/**
 * Retention bound for the phase log below, in events.
 *
 * The log is test observability that stays wired into the shipped
 * `inspectHarnessEnvironment`, and the aux gate calls that tool on every
 * iteration, so append-only retention grew for the lifetime of the process even
 * though every reader truncates the log before reading it. One call records
 * exactly four events (a start and a settle per phase), so sixteen entries
 * always hold a whole call's events in order while production retention stays
 * O(1).
 */
const INSPECT_PHASE_EVENT_LIMIT = 16

const inspectPhaseEvents: InspectPhaseEvent[] = []

/** Records one event, dropping the oldest once the retention bound is reached. */
function recordInspectPhaseEvent(event: InspectPhaseEvent): void {
  inspectPhaseEvents.push(event)
  if (inspectPhaseEvents.length > INSPECT_PHASE_EVENT_LIMIT) {
    inspectPhaseEvents.shift()
  }
}

/**
 * The phase-start/settle log for `inspectHarnessEnvironment`, in event order,
 * bounded to the most recent INSPECT_PHASE_EVENT_LIMIT entries so the getter
 * copies a fixed-size window instead of everything the process has recorded.
 */
export function __getInspectPhaseEventsForTest(): Array<{
  phase: 'discovery' | 'toolProbes'
  event: 'start' | 'settle'
}> {
  return inspectPhaseEvents.map((entry) => ({ ...entry }))
}

/**
 * Reset the phase log so a test attributes one call's overlap to it, and so the
 * retained window starts at that call's events.
 */
export function __resetInspectPhaseEventsForTest(): void {
  inspectPhaseEvents.length = 0
}

function trackInspectPhase<T>(
  phase: InspectPhaseEvent['phase'],
  work: Promise<T>,
): Promise<T> {
  recordInspectPhaseEvent({ phase, event: 'start' })
  return work.then(
    (value) => {
      recordInspectPhaseEvent({ phase, event: 'settle' })
      return value
    },
    (error: unknown) => {
      recordInspectPhaseEvent({ phase, event: 'settle' })
      throw error
    },
  )
}

export async function inspectHarnessEnvironment(
  cwd: string,
  signal?: AbortSignal,
): Promise<EnvironmentInspection> {
  throwIfAborted(signal)
  // Discovery and the tool probes are independent, so they run together: a
  // cache miss costs the max of the two instead of their sum. Both are started
  // (and logged) before either is awaited, so a serialising regression shows up
  // in the phase log instead of only as summed latency.
  const [discovery, tools] = await Promise.all([
    trackInspectPhase('discovery', discoverWorkspacesAsync(cwd, signal)),
    trackInspectPhase('toolProbes', probeToolsAsync(signal)),
  ])
  const { root, manifests, lockfiles, workspaces } = discovery
  const packageManager = workspaces.find(
    (workspace) =>
      workspace.root === '.' && workspace.ecosystem === 'javascript',
  )?.manager
  return {
    cwd: root,
    ...(packageManager ? { packageManager } : {}),
    manifests,
    lockfiles,
    workspaces,
    tools,
  }
}

/**
 * Project-relative, POSIX-separator forms of `files`, dropping anything that is
 * not an in-project path. `resolveProjectPath` also accepts the openbuff-owned
 * OS temp namespace, whose result carries `scope: 'owned-temp'` and an ABSOLUTE
 * `relativePath` that belongs to no workspace, so gate on the scope
 * discriminator rather than treating every non-null result as project-relative.
 */
function toProjectRelativeFiles(cwd: string, files: string[]): string[] {
  return files.flatMap((file) => {
    const resolved = resolveProjectPath(cwd, file)
    return resolved && resolved.scope === 'project'
      ? [resolved.relativePath.replace(/\\/g, '/')]
      : []
  })
}

/**
 * Lazily-created host filesystem view for the off-loop containment resolver.
 * Created once so its per-root realpath memo is reused across calls, and kept
 * broker-less because containment only needs to READ path identity.
 */
let harnessNodeFileSystem: ReturnType<typeof createNodeFileSystem> | undefined

/**
 * Off-loop twin of `toProjectRelativeFiles`. `resolveProjectPath` dereferences
 * each path with a blocking realpath; the async tool paths hand the canonical
 * async resolver the same job through `fs.promises`, so the containment rules
 * and the `scope === 'project'` filter are identical while the syscall runs off
 * the event loop the CLI TUI renders on.
 *
 * The realpaths are batched at `discoveryWalkReadDirConcurrency`, the same width
 * both walks in this module use: the file list is caller-supplied (its
 * `inputSchema` has no upper bound), so issuing one realpath per input at once
 * would queue thousands of tasks onto the very pool the render loop shares.
 */
async function toProjectRelativeFilesAsync(
  cwd: string,
  files: string[],
  signal?: AbortSignal,
): Promise<string[]> {
  const fileSystem = (harnessNodeFileSystem ??= createNodeFileSystem())
  const resolved = await mapWithConcurrency(
    files,
    discoveryWalkReadDirConcurrency,
    (file) =>
      withFilesystemSlot(
        () => resolveProjectPathForFileSystem(cwd, file, fileSystem),
        signal,
      ),
    signal,
  )
  return resolved.flatMap((contained) =>
    contained && contained.scope === 'project'
      ? [contained.relativePath.replace(/\\/g, '/')]
      : [],
  )
}

let offLoopFilesystemProbeCount = 0
let offLoopFilesystemProbesInFlight = 0
let offLoopFilesystemMaxProbesInFlight = 0

/**
 * Test seam: how many collector filesystem probes went through the off-loop
 * helpers below. The async tool paths (`get_affected_tests`,
 * `get_build_targets`) run on the same event loop the CLI TUI renders on, so
 * they must route EVERY existence check and manifest read through these
 * helpers; a regression that reuses a blocking collector for an async caller
 * shows up here as a lower probe count instead of only as a TUI freeze.
 */
export function __getOffLoopFilesystemProbeCountForTest(): number {
  return offLoopFilesystemProbeCount
}

/**
 * Test seam: the widest fan-out the off-loop probes have reached since the last
 * reset. Those probes are bounded by `discoveryWalkReadDirConcurrency` for the
 * same stated reason both walks in this module bound theirs (libuv's four
 * threads also serve the render loop's fs work), and the file list is
 * caller-supplied, so the bound needs an observable: an unbounded `Promise.all`
 * over N input files keeps every result identical — and every existing
 * assertion green — while queueing 4N stats onto that shared pool.
 */
export function __getOffLoopFilesystemMaxProbesInFlightForTest(): number {
  return offLoopFilesystemMaxProbesInFlight
}

/** Reset the high-water mark so a test can attribute it to one call. */
export function __resetOffLoopFilesystemMaxProbesInFlightForTest(): void {
  offLoopFilesystemMaxProbesInFlight = 0
}

/**
 * Runs one off-loop probe under the process-wide fan-out gate, with per-module
 * in-flight bookkeeping.
 *
 * The count rises only after a gate slot is granted, so the high-water mark
 * reports the fan-out the collector had actually ISSUED, and it is now bounded
 * by FILESYSTEM_FANOUT_CONCURRENCY rather than by this module's own width. That
 * distinction is the whole point of the gate: the aux gate issues this module's
 * discovery walk, its manifest pre-reads and its collector probes in the SAME
 * iteration, so three per-phase widths of 8 could each look correct while the
 * iteration together put 24 requests on libuv's four-thread pool.
 */
async function trackOffLoopProbe<T>(
  probe: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  offLoopFilesystemProbeCount += 1
  // The signal reaches the gate itself, so a cancelled collector neither waits
  // behind work nobody wants nor runs the probe once a slot is handed over.
  return withFilesystemSlot(async () => {
    offLoopFilesystemProbesInFlight += 1
    if (offLoopFilesystemProbesInFlight > offLoopFilesystemMaxProbesInFlight) {
      offLoopFilesystemMaxProbesInFlight = offLoopFilesystemProbesInFlight
    }
    try {
      return await probe()
    } finally {
      offLoopFilesystemProbesInFlight -= 1
    }
  }, signal)
}

/**
 * Off-loop existence check. `fs.existsSync` blocks the event loop, and a failed
 * stat IS the not-found answer it reported, so this resolves exactly what the
 * sync collector asks without blocking.
 */
async function probePathExists(
  filePath: string,
  signal?: AbortSignal,
): Promise<boolean> {
  const stats = await trackOffLoopProbe(
    () => stat(filePath).catch(() => undefined),
    signal,
  )
  return stats !== undefined
}

/**
 * Off-loop twin of `fs.readFileSync(path, 'utf8')`. `undefined` mirrors a
 * failed read, which the manifest parsers already answer as "nothing usable".
 */
async function probeReadTextFile(
  filePath: string,
  signal?: AbortSignal,
): Promise<string | undefined> {
  return trackOffLoopProbe(
    () => readFile(filePath, 'utf8').catch(() => undefined),
    signal,
  )
}

export type AffectedTestTarget = {
  source: string
  candidates: string[]
  packageRoot: string
}

/**
 * The four convention test paths for a source file, in reporting order. Shared
 * by both collectors so the sync and async paths can never propose different
 * candidate spellings.
 */
function testFileCandidates(normalized: string): string[] {
  const extension = path.extname(normalized)
  const stem = normalized.slice(0, -extension.length)
  const directory = path.posix.dirname(normalized)
  const basename = path.posix.basename(stem)
  return [
    `${stem}.test${extension}`,
    `${stem}.spec${extension}`,
    `${directory}/__tests__/${basename}.test${extension}`,
    `${directory}/__tests__/${basename}.spec${extension}`,
  ]
}

let workspaceOwnershipResolutionCount = 0

/**
 * Test seam: how many per-file workspace-ownership resolutions have run. Every
 * collector answers the ownership question exactly ONCE per normalized path, so
 * this is the observable that pins that invariant against a regression which
 * re-resolves the same path (the affected-tests collector used to ask through
 * `owningPackageRoot` and then ask again for itself).
 */
export function __getWorkspaceOwnershipResolutionCountForTest(): number {
  return workspaceOwnershipResolutionCount
}

/** Reset the counter so a test can attribute the resolutions to one call. */
export function __resetWorkspaceOwnershipResolutionCountForTest(): void {
  workspaceOwnershipResolutionCount = 0
}

/**
 * Deepest workspace whose root contains `normalized`, or undefined when no
 * workspace owns it. Shared by every collector so they cannot disagree about
 * ownership.
 *
 * One O(workspaces) pass that tracks the best match by `root.length` in a plain
 * loop, with no intermediate arrays. The `.filter(...).sort(...)` shape this
 * replaces allocated a filtered array AND a second array to sort on every call,
 * and all three callers run it once per file on the aux-gate path, where the
 * file list is caller-supplied with no upper bound. Equal-length roots keep the
 * first workspace seen, which is the order a stable sort of them produced.
 */
function owningWorkspace(
  normalized: string,
  workspaces: ReturnType<typeof inferWorkspace>[],
): ReturnType<typeof inferWorkspace> | undefined {
  workspaceOwnershipResolutionCount += 1
  let owner: ReturnType<typeof inferWorkspace> | undefined
  for (const workspace of workspaces) {
    if (
      workspace.root !== '.' &&
      normalized !== workspace.root &&
      !normalized.startsWith(`${workspace.root}/`)
    ) {
      continue
    }
    if (!owner || workspace.root.length > owner.root.length) owner = workspace
  }
  return owner
}

/**
 * Sync builder for affected test targets: maps project-relative `files` onto the
 * test files that exist on disk plus their owning workspace root, given an
 * already-resolved `workspaces` list.
 */
function collectAffectedTestTargets(
  cwd: string,
  files: string[],
  workspaces: ReturnType<typeof inferWorkspace>[],
): AffectedTestTarget[] {
  return toProjectRelativeFiles(cwd, files).map((normalized) => {
    const owner = owningWorkspace(normalized, workspaces)
    return {
      source: normalized,
      candidates: testFileCandidates(normalized).filter((candidate) =>
        fs.existsSync(path.join(cwd, candidate)),
      ),
      // Read off the owner resolved once for this path, not by re-running the
      // workspace scan through a second ownership helper.
      packageRoot: owner?.root ?? '.',
    }
  })
}

/**
 * Off-loop twin of `collectAffectedTestTargets`, used by the `get_affected_tests`
 * tool. Same candidates in the same order and the same packageRoot; the only
 * difference is that path containment and each existence check are awaited, so
 * neither the realpath nor the stat blocks the event loop the CLI TUI renders
 * on.
 */
async function collectAffectedTestTargetsAsync(
  cwd: string,
  files: string[],
  workspaces: ReturnType<typeof inferWorkspace>[],
  signal?: AbortSignal,
): Promise<AffectedTestTarget[]> {
  const normalizedFiles = await toProjectRelativeFilesAsync(cwd, files, signal)
  // ONE ownership resolution per normalized path, reused for the reported
  // packageRoot. Resolving it a second time for the same path doubled the
  // per-file workspace scan on a collector whose file list has no upper bound.
  const owners = normalizedFiles.map((normalized) =>
    owningWorkspace(normalized, workspaces),
  )
  // Every convention probe is flattened into ONE bounded list. The file list is
  // caller-supplied and each file probes four candidates, so an unbounded nested
  // fan-out would queue 4N stats onto the libuv pool the render loop's own fs
  // work shares — the fan-out both walks in this module cap for that reason.
  const probes = normalizedFiles.flatMap((normalized, fileIndex) =>
    testFileCandidates(normalized).map((candidate) => ({
      fileIndex,
      candidate,
    })),
  )
  const exists = await mapWithConcurrency(
    probes,
    discoveryWalkReadDirConcurrency,
    ({ candidate }) => probePathExists(path.join(cwd, candidate), signal),
    signal,
  )
  const candidatesByFile = new Map<number, string[]>()
  for (const [index, probe] of probes.entries()) {
    if (!exists[index]) continue
    const found = candidatesByFile.get(probe.fileIndex)
    if (found) found.push(probe.candidate)
    else candidatesByFile.set(probe.fileIndex, [probe.candidate])
  }
  return normalizedFiles.map((normalized, fileIndex) => ({
    source: normalized,
    candidates: candidatesByFile.get(fileIndex) ?? [],
    packageRoot: owners[fileIndex]?.root ?? '.',
  }))
}

export function getAffectedTestTargets(
  cwd: string,
  files: string[],
): AffectedTestTarget[] {
  const { workspaces } = discoverWorkspaces(cwd)
  return collectAffectedTestTargets(cwd, files, workspaces)
}

/**
 * Async twin used by the `get_affected_tests` tool. Discovery is the only
 * expensive step, and `discoverWorkspacesAsync` shares one cache entry — and so
 * one traversal — with `inspect_environment`, which the aux gate issues in the
 * same iteration. Routing the tool here makes that iteration pay for one tree
 * walk, off the render loop, instead of also running the blocking sync walk.
 */
export async function getAffectedTestTargetsAsync(
  cwd: string,
  files: string[],
  signal?: AbortSignal,
): Promise<AffectedTestTarget[]> {
  const { workspaces } = await discoverWorkspacesAsync(cwd, signal)
  return collectAffectedTestTargetsAsync(cwd, files, workspaces, signal)
}

export type TestImpactTier =
  | 'convention'
  | 'graph'
  | 'build-tool'
  | 'coverage'

export type TestImpactConfidence = 'high' | 'medium' | 'low'

export type TestImpactCandidate = {
  path: string
  tier: TestImpactTier
  confidence: TestImpactConfidence
}

export type TestImpactAnalysis = {
  source: string
  packageRoot: string
  tiers: {
    convention: string[]
    graph: string[]
    buildTool: string[]
    coverage: string[]
  }
  /** Flattened `tiers`, deduped by path keeping the highest-confidence tier. */
  candidates: TestImpactCandidate[]
}

export type TestImpactOptions = {
  /**
   * Reverse-dependency seam for the graph tier: given a project-relative
   * source path, return project-relative paths of files that import it. The
   * sdk has no direct accessor for the indexer reference graph
   * (packages/indexer's `queryReferences` is internal to its query engine),
   * so the default is a hermetic no-op and callers that can reach a live
   * index inject the seam here.
   */
  reverseDeps?: (file: string) => string[]
}

const testImpactConfidenceRank: Record<TestImpactConfidence, number> = {
  high: 3,
  medium: 2,
  low: 1,
}

function isTestLikePath(file: string): boolean {
  const name = path.posix.basename(file)
  return (
    /[._-](test|spec)\.[^.]+$/.test(name) ||
    file.split('/').includes('__tests__')
  )
}

/**
 * Package-relative test scripts from an ALREADY-READ javascript manifest. Both
 * the blocking and the off-loop caller hand this parser their text, so an
 * unreadable manifest (undefined) and unparseable text yield the same empty
 * list on either path.
 */
function parsePackageTestScripts(raw: string | undefined): string[] {
  if (raw === undefined) return []
  try {
    const parsed = JSON.parse(raw) as { scripts?: Record<string, string> }
    return Object.keys(parsed.scripts ?? {}).filter((name) =>
      /(^|:)test(:|$)/.test(name),
    )
  } catch {
    return []
  }
}

/**
 * Package name from an ALREADY-READ Cargo.toml, via a bounded line-oriented
 * scan (no TOML dependency): comments are stripped per line, the current
 * section is tracked, and the first `name = ...` inside `[package]` wins.
 * Returns undefined when the text is unavailable (undefined) or has no
 * parseable package name, so callers can omit `-p` instead of guessing a bogus
 * package id (the directory basename is NOT the package id).
 */
function parseCargoPackageName(
  content: string | undefined,
): string | undefined {
  if (content === undefined) return undefined
  let inPackageSection = false
  for (const rawLine of content.split('\n')) {
    // Naive comment strip: a '#' inside a quoted string truncates that line
    // only, which at worst misses the name (callers then omit -p) — it can
    // never manufacture a wrong name.
    const line = rawLine.split('#')[0].trim()
    if (line.startsWith('[')) {
      inPackageSection = line === '[package]'
      continue
    }
    if (!inPackageSection) continue
    const match =
      /^name\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s"']+))\s*$/.exec(line)
    if (match) return match[1] ?? match[2] ?? match[3]
  }
  return undefined
}

/**
 * Sync read of a workspace's own manifest. `undefined` on any failure, which
 * every consumer already answers as "nothing usable".
 */
function readWorkspaceManifestText(
  cwd: string,
  workspace: ReturnType<typeof inferWorkspace>,
): string | undefined {
  try {
    return fs.readFileSync(path.join(cwd, workspace.manifest), 'utf8')
  } catch {
    return undefined
  }
}

/**
 * Whether `buildToolTestCommands` consults the workspace manifest text at all.
 * Checked BEFORE reading, so a Go/Python/dotnet workspace never pays for a read
 * whose result nothing would look at.
 */
function needsWorkspaceManifestText(
  workspace: ReturnType<typeof inferWorkspace> | undefined,
): boolean {
  if (!workspace) return false
  if (workspace.manager === 'cargo') return true
  return workspace.ecosystem === 'javascript' && workspace.manager !== 'unknown'
}

/**
 * Test commands for the package owning a source file, derived from workspace
 * manifests already discovered by `discoverWorkspaces`. When the owning
 * workspace is nested (root !== '.'), the package is confirmed: it declared
 * its own manifest under the file. When only the repo-root workspace matches,
 * ownership is implicit and the command is reported with low confidence.
 *
 * Takes the manifest text rather than reading it, so the blocking caller and
 * the off-loop caller cannot drift: both hand this assembler their own text and
 * get the same answer.
 */
function buildToolTestCommands(
  workspace: ReturnType<typeof inferWorkspace> | undefined,
  directory: string,
  manifestText: string | undefined,
): { commands: string[]; confirmed: boolean } {
  if (!workspace) return { commands: [], confirmed: false }
  if (workspace.manager === 'cargo') {
    // `-p` needs the crate's real package name from Cargo.toml; the directory
    // basename produces a bogus query when they differ. When the name is
    // unparseable (or unsafe to interpolate into a command), omit `-p`.
    const packageName = parseCargoPackageName(manifestText)
    const packageFlag =
      packageName && /^[A-Za-z0-9._-]+$/.test(packageName)
        ? ` -p ${packageName}`
        : ''
    return {
      commands: [`cargo test${packageFlag}`],
      confirmed: true,
    }
  }
  if (workspace.manager === 'go')
    return {
      commands: [`go test ./${directory === '.' ? '...' : directory}`],
      confirmed: true,
    }
  if (workspace.ecosystem === 'javascript') {
    // A workspace whose manager could not be identified (e.g. an unparseable
    // package.json) has no runnable package-manager command; emitting
    // `unknown run <script>` would be a junk command, so omit the build-tool
    // query entirely instead.
    if (workspace.manager === 'unknown') {
      return { commands: [], confirmed: false }
    }
    const scripts = parsePackageTestScripts(manifestText)
    return {
      commands: scripts.map((script) => `${workspace.manager} run ${script}`),
      confirmed: workspace.root !== '.',
    }
  }
  return { commands: [], confirmed: false }
}

/** Test-like reverse dependents of `normalized`, deduped and sorted. */
function graphTestCandidates(
  reverseDeps: (file: string) => string[],
  normalized: string,
): string[] {
  return [
    ...new Set(
      reverseDeps(normalized)
        .map((dependent) => dependent.replace(/\\/g, '/'))
        .filter((dependent) => isTestLikePath(dependent)),
    ),
  ].sort()
}

/**
 * Pure assembler for one file's tiered impact:
 *  - tier 1 `convention`: the existing `<stem>.test.<ext>` / `__tests__`/
 *    naming candidates, confidence 'high' (they exist on disk).
 *  - tier 2 `graph`: test-like files that import the changed file, discovered
 *    through the injected `reverseDeps` seam; confidence 'medium'.
 *  - tier 3 `build-tool`: test commands of the owning workspace package;
 *    confidence 'medium' when the owning package is confirmed (nested
 *    workspace or a compiled-ecosystem manifest), else 'low'.
 *  - tier 4 `coverage`: honest placeholder, always []. Historical-coverage
 *    impact maps land in a later task; nothing is fabricated here.
 *
 * Every filesystem answer arrives as an argument, so the blocking and off-loop
 * collectors differ only in HOW they probe and can never disagree about the
 * reported tiers or confidences.
 */
function assembleTestImpact(
  normalized: string,
  convention: string[],
  graph: string[],
  owning: ReturnType<typeof inferWorkspace> | undefined,
  directory: string,
  manifestText: string | undefined,
): TestImpactAnalysis {
  const { commands: buildToolCommands, confirmed } = buildToolTestCommands(
    owning,
    directory,
    manifestText,
  )
  const tiers = { convention, graph, buildTool: buildToolCommands, coverage: [] }
  const byPath = new Map<string, TestImpactCandidate>()
  const offer = (
    paths: string[],
    tier: TestImpactTier,
    confidence: TestImpactConfidence,
  ): void => {
    for (const candidatePath of paths) {
      const existing = byPath.get(candidatePath)
      if (
        !existing ||
        testImpactConfidenceRank[confidence] >
          testImpactConfidenceRank[existing.confidence]
      ) {
        byPath.set(candidatePath, { path: candidatePath, tier, confidence })
      }
    }
  }
  offer(tiers.convention, 'convention', 'high')
  offer(tiers.graph, 'graph', 'medium')
  offer(tiers.buildTool, 'build-tool', confirmed ? 'medium' : 'low')
  return {
    source: normalized,
    packageRoot: owning?.root ?? '.',
    tiers,
    candidates: [...byPath.values()],
  }
}

/** Sync collector for `analyzeTestImpact`; blocks on each candidate stat. */
function collectTestImpact(
  cwd: string,
  files: string[],
  options: TestImpactOptions,
  workspaces: ReturnType<typeof inferWorkspace>[],
): TestImpactAnalysis[] {
  const reverseDeps = options.reverseDeps ?? (() => [])
  return toProjectRelativeFiles(cwd, files).map((normalized) => {
    const owning = owningWorkspace(normalized, workspaces)
    return assembleTestImpact(
      normalized,
      testFileCandidates(normalized).filter((candidate) =>
        fs.existsSync(path.join(cwd, candidate)),
      ),
      graphTestCandidates(reverseDeps, normalized),
      owning,
      path.posix.dirname(normalized),
      owning && needsWorkspaceManifestText(owning)
        ? readWorkspaceManifestText(cwd, owning)
        : undefined,
    )
  })
}

/**
 * Off-loop twin of `collectTestImpact`: same candidates, tiers, and
 * confidences, with every existence check and manifest read awaited so no
 * blocking syscall runs on the event loop the CLI TUI renders on.
 */
async function collectTestImpactAsync(
  cwd: string,
  files: string[],
  options: TestImpactOptions,
  workspaces: ReturnType<typeof inferWorkspace>[],
  signal?: AbortSignal,
): Promise<TestImpactAnalysis[]> {
  const reverseDeps = options.reverseDeps ?? (() => [])
  const normalizedFiles = await toProjectRelativeFilesAsync(cwd, files, signal)
  const owners = normalizedFiles.map((normalized) =>
    owningWorkspace(normalized, workspaces),
  )
  const candidates = normalizedFiles.map((normalized) =>
    testFileCandidates(normalized),
  )
  // Four convention probes per file, flattened into one bounded list: at an
  // unbounded width a 500-file request queues 2,000 stats onto the pool the
  // render loop's own fs work is served from.
  const probes = candidates.flatMap((perFile, fileIndex) =>
    perFile.map((candidate, candidateIndex) => ({
      fileIndex,
      candidateIndex,
      candidate,
    })),
  )
  const exists = await mapWithConcurrency(
    probes,
    discoveryWalkReadDirConcurrency,
    ({ candidate }) => probePathExists(path.join(cwd, candidate), signal),
    signal,
  )
  const existsByFile = candidates.map((perFile) => perFile.map(() => false))
  for (const [index, probe] of probes.entries()) {
    const flags = existsByFile[probe.fileIndex]
    if (flags) flags[probe.candidateIndex] = exists[index] === true
  }
  // Manifest texts are read only for the files whose owner consults them, at the
  // same shared width — and once per MANIFEST, not once per file. The file list
  // is caller-supplied with no upper bound, so a 500-file request against a
  // single-package repo would otherwise issue 500 identical reads of the same
  // package.json and re-parse each one. The text is a pure function of the
  // manifest path, so deduping by path cannot change any answer.
  const filesByManifest = new Map<string, number[]>()
  for (const [fileIndex, owning] of owners.entries()) {
    if (!owning || !needsWorkspaceManifestText(owning)) continue
    const manifestFiles = filesByManifest.get(owning.manifest)
    if (manifestFiles) manifestFiles.push(fileIndex)
    else filesByManifest.set(owning.manifest, [fileIndex])
  }
  const manifestTexts = await mapWithConcurrency(
    [...filesByManifest.keys()],
    discoveryWalkReadDirConcurrency,
    (manifest) => probeReadTextFile(path.join(cwd, manifest), signal),
    signal,
  )
  const manifestByFile = new Map<number, string | undefined>()
  for (const [position, manifestFiles] of [
    ...filesByManifest.values(),
  ].entries()) {
    for (const fileIndex of manifestFiles) {
      manifestByFile.set(fileIndex, manifestTexts[position])
    }
  }
  return normalizedFiles.map((normalized, fileIndex) => {
    const perFile = candidates[fileIndex] ?? []
    const flags = existsByFile[fileIndex] ?? []
    return assembleTestImpact(
      normalized,
      perFile.filter((_, candidateIndex) => flags[candidateIndex]),
      graphTestCandidates(reverseDeps, normalized),
      owners[fileIndex],
      path.posix.dirname(normalized),
      manifestByFile.get(fileIndex),
    )
  })
}

export function analyzeTestImpact(
  cwd: string,
  files: string[],
  options: TestImpactOptions = {},
): TestImpactAnalysis[] {
  const { workspaces } = discoverWorkspaces(cwd)
  return collectTestImpact(cwd, files, options, workspaces)
}

/** Async twin of `analyzeTestImpact`, sharing the same traversal as
 * `inspect_environment` and `get_affected_tests` within one gate iteration. */
export async function analyzeTestImpactAsync(
  cwd: string,
  files: string[],
  options: TestImpactOptions = {},
  signal?: AbortSignal,
): Promise<TestImpactAnalysis[]> {
  const { workspaces } = await discoverWorkspacesAsync(cwd, signal)
  return collectTestImpactAsync(cwd, files, options, workspaces, signal)
}

export type BuildTarget = {
  packageRoot: string
  scripts: string[]
  manifest: string
  manager: string
  commands: string[]
  confidence: 'confirmed' | 'inferred' | 'unknown'
}

/**
 * Workspaces owning the changed files: for each project-relative file, the
 * deepest workspace containing it, deduped by manifest in first-seen order.
 * The off-loop twin below applies the same selection.
 */
function selectBuildTargetWorkspaces(
  cwd: string,
  files: string[],
  workspaces: ReturnType<typeof inferWorkspace>[],
): Array<ReturnType<typeof inferWorkspace>> {
  const selected = new Map<string, ReturnType<typeof inferWorkspace>>()
  for (const file of toProjectRelativeFiles(cwd, files)) {
    const owner = owningWorkspace(file, workspaces)
    if (owner) selected.set(owner.manifest, owner)
  }
  return [...selected.values()]
}

/**
 * Off-loop twin of `selectBuildTargetWorkspaces`: same selection and ordering,
 * with the path containment resolved through the awaited resolver so the
 * `get_build_targets` tool neither realpaths nor stats on the render loop.
 */
async function selectBuildTargetWorkspacesAsync(
  cwd: string,
  files: string[],
  workspaces: ReturnType<typeof inferWorkspace>[],
  signal?: AbortSignal,
): Promise<Array<ReturnType<typeof inferWorkspace>>> {
  const selected = new Map<string, ReturnType<typeof inferWorkspace>>()
  for (const file of await toProjectRelativeFilesAsync(cwd, files, signal)) {
    const owner = owningWorkspace(file, workspaces)
    if (owner) selected.set(owner.manifest, owner)
  }
  return [...selected.values()]
}

/**
 * Scripts this module reports from an ALREADY-READ javascript manifest, in
 * fixed order. An unreadable (undefined) or unparseable manifest yields an
 * empty list, which the caller reports as unknown confidence — exactly what the
 * previous in-line read-and-parse did.
 */
function parseBuildScripts(raw: string | undefined): string[] {
  if (raw === undefined) return []
  try {
    const parsed = JSON.parse(raw) as { scripts?: Record<string, string> }
    return ['typecheck', 'test', 'lint', 'build'].filter(
      (script) => parsed.scripts?.[script],
    )
  } catch {
    return []
  }
}

/**
 * Build-target assembler. The javascript manifest text arrives as an argument,
 * so the blocking and off-loop collectors differ only in HOW they read it and
 * can never disagree about scripts, commands, or confidence.
 */
function assembleBuildTarget(
  workspace: ReturnType<typeof inferWorkspace>,
  manifestText: string | undefined,
): BuildTarget {
  let scripts: string[] = []
  let commands: string[] = []
  if (workspace.ecosystem === 'javascript') {
    scripts = parseBuildScripts(manifestText)
    commands = scripts.map((script) => `${workspace.manager} run ${script}`)
  } else if (workspace.manager === 'cargo')
    commands = ['cargo check', 'cargo test', 'cargo clippy', 'cargo build']
  else if (workspace.manager === 'go')
    commands = ['go test ./...', 'go vet ./...', 'go build ./...']
  else if (workspace.manager === 'uv')
    commands = ['uv run pytest', 'uv run ruff check .', 'uv build']
  else if (workspace.manager === 'poetry')
    commands = [
      'poetry run pytest',
      'poetry run ruff check .',
      'poetry build',
    ]
  else if (workspace.ecosystem === 'python') commands = ['python -m pytest']
  else if (workspace.manager === 'maven-wrapper')
    commands = ['./mvnw test', './mvnw package']
  else if (workspace.manager === 'maven')
    commands = ['mvn test', 'mvn package']
  else if (workspace.manager === 'gradle-wrapper')
    commands = ['./gradlew test', './gradlew build']
  else if (workspace.manager === 'gradle')
    commands = ['gradle test', 'gradle build']
  else if (workspace.manager === 'dotnet')
    commands = [
      `dotnet test ${path.posix.basename(workspace.manifest)}`,
      `dotnet build ${path.posix.basename(workspace.manifest)}`,
    ]
  else if (workspace.manager === 'swift')
    commands = ['swift test', 'swift build']
  return {
    packageRoot: workspace.root,
    scripts,
    manifest: workspace.manifest,
    manager: workspace.manager,
    commands,
    confidence:
      commands.length === 0
        ? 'unknown'
        : workspace.ecosystem === 'javascript'
          ? workspace.confidence
          : 'inferred',
  }
}

/** Sync collector for `getBuildTargets`; blocks on each manifest read. */
function collectBuildTargets(
  cwd: string,
  files: string[],
  workspaces: ReturnType<typeof inferWorkspace>[],
): BuildTarget[] {
  return selectBuildTargetWorkspaces(cwd, files, workspaces).map((workspace) =>
    assembleBuildTarget(
      workspace,
      workspace.ecosystem === 'javascript'
        ? readWorkspaceManifestText(cwd, workspace)
        : undefined,
    ),
  )
}

/**
 * Off-loop twin of `collectBuildTargets`, used by the `get_build_targets` tool.
 * Identical selection, scripts, commands, and confidence; the path containment
 * and the javascript manifest text are both awaited instead of blocking on the
 * event loop the CLI TUI renders on.
 */
async function collectBuildTargetsAsync(
  cwd: string,
  files: string[],
  workspaces: ReturnType<typeof inferWorkspace>[],
  signal?: AbortSignal,
): Promise<BuildTarget[]> {
  const selected = await selectBuildTargetWorkspacesAsync(
    cwd,
    files,
    workspaces,
    signal,
  )
  // One read per selected workspace, bounded at the same width the rest of this
  // module uses: the selection is derived from the caller-supplied file list.
  const manifestTexts = await mapWithConcurrency(
    selected,
    discoveryWalkReadDirConcurrency,
    (workspace) =>
      workspace.ecosystem === 'javascript'
        ? probeReadTextFile(path.join(cwd, workspace.manifest), signal)
        : Promise.resolve(undefined),
    signal,
  )
  return selected.map((workspace, index) =>
    assembleBuildTarget(workspace, manifestTexts[index]),
  )
}

export function getBuildTargets(cwd: string, files: string[]): BuildTarget[] {
  const { workspaces } = discoverWorkspaces(cwd)
  return collectBuildTargets(cwd, files, workspaces)
}

/** Async twin of `getBuildTargets`, sharing the same traversal as
 * `inspect_environment` and `get_affected_tests` within one gate iteration. */
export async function getBuildTargetsAsync(
  cwd: string,
  files: string[],
  signal?: AbortSignal,
): Promise<BuildTarget[]> {
  const { workspaces } = await discoverWorkspacesAsync(cwd, signal)
  return collectBuildTargetsAsync(cwd, files, workspaces, signal)
}

export type ContextPacketItem = {
  path: string
  symbols: string[]
  reason: string
  confidence: 'confirmed' | 'inferred' | 'unknown'
  freshnessHash?: string
}

export function createContextPacket(params: {
  objective: string
  acceptanceCriteria: string[]
  items: ContextPacketItem[]
  excluded: string[]
}): {
  id: string
  objective: string
  acceptanceCriteria: string[]
  items: ContextPacketItem[]
  excluded: string[]
} {
  const canonical = JSON.stringify(params)
  return {
    id: createHash('sha256').update(canonical).digest('hex'),
    ...params,
  }
}

export type KnowledgeRecord = LocalHarnessRecord & {
  statement: string
  source: string
  sourceHash: string
  verifiedAt: string
  expiresAt?: string
}

export class VerifiedKnowledgeService {
  constructor(private readonly store: LocalHarnessStore) {}

  record(params: {
    repositoryId: string
    workspaceId: string
    runId: string
    snapshotId: string
    statement: string
    source: string
    sourceHash: string
    verifiedAt: string
    expiresAt?: string
  }): KnowledgeRecord {
    const timestamp = new Date().toISOString()
    return this.store.put('artifacts', {
      schemaVersion: 1,
      id: `knowledge-${randomUUID()}`,
      revision: 0,
      repositoryId: params.repositoryId,
      workspaceId: params.workspaceId,
      runId: params.runId,
      snapshotId: params.snapshotId,
      createdAt: timestamp,
      updatedAt: timestamp,
      statement: params.statement,
      source: params.source,
      sourceHash: params.sourceHash,
      verifiedAt: params.verifiedAt,
      ...(params.expiresAt ? { expiresAt: params.expiresAt } : {}),
    }) as KnowledgeRecord
  }

  listFresh(repositoryId: string, at = Date.now()): KnowledgeRecord[] {
    return this.store
      .list(repositoryId, 'artifacts')
      .filter((record) => record.id.startsWith('knowledge-'))
      .filter(
        (record) =>
          typeof record.expiresAt !== 'string' ||
          Date.parse(record.expiresAt) > at,
      ) as KnowledgeRecord[]
  }
}

export type WorkspaceLeaseRecord = LocalHarnessRecord & {
  taskId: string
  path: string
  branch?: string
  generation: number
  ownershipToken: string
  acquiredAt: string
  heartbeatAt: string
  expiresAt: string
  status: 'active' | 'released' | 'abandoned'
}

export class WorkspaceLeaseService {
  private readonly now: () => number
  private readonly leaseDurationMs: number

  constructor(
    private readonly store: LocalHarnessStore,
    options: { now?: () => number; leaseDurationMs?: number } = {},
  ) {
    this.now = options.now ?? Date.now
    this.leaseDurationMs = Math.max(1, options.leaseDurationMs ?? 60_000)
  }

  private isExpired(record: WorkspaceLeaseRecord, at: number): boolean {
    const expiresAt = Date.parse(record.expiresAt)
    return !Number.isFinite(expiresAt) || expiresAt <= at
  }

  private abandonExpiredUnlocked(
    repositoryId: string,
    at: number,
  ): WorkspaceLeaseRecord[] {
    const abandoned: WorkspaceLeaseRecord[] = []
    for (const record of this.store.list(
      repositoryId,
      'workspaces',
    ) as WorkspaceLeaseRecord[]) {
      if (record.status !== 'active' || !this.isExpired(record, at)) continue
      const timestamp = new Date(at).toISOString()
      abandoned.push(
        this.store.put(
          'workspaces',
          {
            ...record,
            revision: record.revision + 1,
            updatedAt: timestamp,
            heartbeatAt: timestamp,
            status: 'abandoned',
          },
          record.revision,
        ) as WorkspaceLeaseRecord,
      )
    }
    return abandoned
  }

  acquire(params: {
    repositoryId: string
    workspaceId: string
    runId: string
    snapshotId: string
    taskId: string
    path: string
    branch?: string
  }): WorkspaceLeaseRecord {
    return this.store.withKindLock(params.repositoryId, 'workspaces', () => {
      const now = this.now()
      this.abandonExpiredUnlocked(params.repositoryId, now)
      const records = this.store.list(
        params.repositoryId,
        'workspaces',
      ) as WorkspaceLeaseRecord[]
      const active = records.find(
        (record) =>
          record.status === 'active' &&
          (record.workspaceId === params.workspaceId ||
            record.path === params.path),
      )
      if (active) {
        throw new Error(`Workspace is already leased by run '${active.runId}'.`)
      }

      const id = `workspace-${params.workspaceId}`
      const existing = records.find((record) => record.id === id)
      const timestamp = new Date(now).toISOString()
      const lease: WorkspaceLeaseRecord = {
        schemaVersion: 1,
        id,
        revision: existing ? existing.revision + 1 : 0,
        ...params,
        createdAt: existing?.createdAt ?? timestamp,
        updatedAt: timestamp,
        generation: (existing?.generation ?? 0) + 1,
        ownershipToken: randomUUID(),
        acquiredAt: timestamp,
        heartbeatAt: timestamp,
        expiresAt: new Date(now + this.leaseDurationMs).toISOString(),
        status: 'active',
      }
      return this.store.put(
        'workspaces',
        lease,
        existing?.revision,
      ) as WorkspaceLeaseRecord
    })
  }

  renew(
    repositoryId: string,
    id: string,
    ownershipToken: string,
  ): WorkspaceLeaseRecord {
    return this.store.withKindLock(repositoryId, 'workspaces', () => {
      const existing = this.store.read(repositoryId, 'workspaces', id) as
        | WorkspaceLeaseRecord
        | undefined
      if (!existing) throw new Error('Workspace lease not found.')
      if (existing.ownershipToken !== ownershipToken) {
        throw new Error('Workspace ownership token does not match.')
      }
      if (existing.status !== 'active') {
        throw new Error(
          `Workspace lease is not active (status: ${existing.status}).`,
        )
      }
      const now = this.now()
      if (this.isExpired(existing, now)) {
        throw new Error('Workspace lease has expired and must be reacquired.')
      }
      const timestamp = new Date(now).toISOString()
      return this.store.put(
        'workspaces',
        {
          ...existing,
          revision: existing.revision + 1,
          updatedAt: timestamp,
          heartbeatAt: timestamp,
          expiresAt: new Date(now + this.leaseDurationMs).toISOString(),
        },
        existing.revision,
      ) as WorkspaceLeaseRecord
    })
  }

  heartbeat(
    repositoryId: string,
    id: string,
    ownershipToken: string,
  ): WorkspaceLeaseRecord {
    return this.renew(repositoryId, id, ownershipToken)
  }

  reclaimExpired(repositoryId: string): WorkspaceLeaseRecord[] {
    return this.store.withKindLock(repositoryId, 'workspaces', () =>
      this.abandonExpiredUnlocked(repositoryId, this.now()),
    )
  }

  release(
    repositoryId: string,
    id: string,
    ownershipToken: string,
  ): WorkspaceLeaseRecord {
    return this.store.withKindLock(repositoryId, 'workspaces', () => {
      const existing = this.store.read(repositoryId, 'workspaces', id) as
        | WorkspaceLeaseRecord
        | undefined
      if (!existing) throw new Error('Workspace lease not found.')
      if (existing.ownershipToken !== ownershipToken) {
        throw new Error('Workspace ownership token does not match.')
      }
      if (existing.status !== 'active') {
        throw new Error(
          `Workspace lease is not active (status: ${existing.status}).`,
        )
      }
      const timestamp = new Date(this.now()).toISOString()
      return this.store.put(
        'workspaces',
        {
          ...existing,
          revision: existing.revision + 1,
          updatedAt: timestamp,
          heartbeatAt: timestamp,
          expiresAt: timestamp,
          status: 'released',
        },
        existing.revision,
      ) as WorkspaceLeaseRecord
    })
  }
}

export type ConnectorOperation = 'read' | 'mutation'

export function classifyConnectorOperation(params: {
  connector: string
  operation: string
}): { kind: ConnectorOperation; approvalRequired: boolean } {
  const mutationPattern =
    /create|update|delete|send|post|push|merge|deploy|release|publish|trigger|cancel/i
  const kind: ConnectorOperation = mutationPattern.test(params.operation)
    ? 'mutation'
    : 'read'
  return { kind, approvalRequired: kind === 'mutation' }
}

