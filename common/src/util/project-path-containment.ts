import fs from 'fs'
import os from 'os'
import path from 'path'

import { isMandatorySensitiveReadPath } from './sensitive-paths'

import type { CodebuffFileSystem } from '../types/filesystem'

/**
 * Result of resolving a caller-supplied path against a project root.
 *
 * - `fullPath` is the absolute, OS-native path to use for actual filesystem
 *   operations. For a symlinked path inside the project this is the original
 *   lexical path; `realFullPath` carries the symlink-dereferenced form.
 * - `relativePath` is the project-relative form of the path, with OS-native
 *   separators (i.e. whatever `path.relative` produces). Callers can use it
 *   as a lookup key into a project file tree built with the same
 *   convention. For the owned-temp exception — and, identically, for the
 *   read-only `external-read` exception — it is the ABSOLUTE resolved path
 *   instead, because a project-relative form for a path outside the project
 *   would be a meaningless traversal string. Consumers must branch on `scope`
 *   rather than inferring from absoluteness.
 */
export type ContainedProjectPath = {
  fullPath: string
  realFullPath: string
  relativePath: string
  /**
   * 'project' for in-project paths; 'owned-temp' for the openbuff-owned OS
   * temp namespace exception; 'external-read' for a path inside an explicitly
   * allowlisted read-only root outside the project (reachable only through
   * `resolveProjectPathForRead` / `resolveProjectPathForFileSystemRead`).
   */
  scope: 'project' | 'owned-temp' | 'external-read'
}

/**
 * THE escape predicate: true when `target` is neither `root` itself nor a
 * descendant of it.
 *
 * Every containment decision in this module routes through this one helper —
 * sync and async, lexical and symlink-dereferenced — so the variants cannot
 * drift apart.
 *
 * An exact `..` or a `..` immediately followed by a separator is required so
 * file names that merely start with two dots (e.g. `..config`) stay allowed.
 * The trailing segment scan is belt-and-braces for inputs where a `..`
 * survives in the middle of the relative form.
 */
function escapesRoot(root: string, target: string): boolean {
  const relative = path.relative(root, target)
  return (
    relative === '..' ||
    relative.startsWith('..' + path.sep) ||
    path.isAbsolute(relative) ||
    relative.split(path.sep).includes('..')
  )
}

/**
 * Contract for the owned-temp exception (see `isOwnedTempPath`): the RAW
 * caller input must be free of `..` segments.
 *
 * Traversal through an openbuff-owned temp namespace is never a legitimate
 * access pattern, so it is refused BEFORE any collapsing happens — even when
 * the collapsed path would land back inside the namespace. This check lives at
 * the entry points (`isOwnedTempPath`, `resolveProjectPath`,
 * `resolveProjectPathForFileSystem`) rather than inside the owned-temp
 * resolver: the resolvers call `path.resolve` first, so a check further down
 * would never see the `..` and the boolean predicate would disagree with the
 * resolvers on the same input.
 *
 * In-project resolution is unaffected: `..` there is collapsed and then
 * containment-checked, as `isPathInsideProject` documents.
 */
function hasTraversalSegment(input: string): boolean {
  return input.split(/[\\/]+/).includes('..')
}

/**
 * Walk up from `fsPath` to the nearest existing ancestor, realpath that,
 * then reconstruct the non-existent tail. When nothing on the chain exists
 * (e.g. a synthetic test root like `/repo`), fall back to the lexical path
 * so callers can keep using the helper in unit tests with non-existent
 * roots.
 */
function realpathOrLexical(fsPath: string): string {
  try {
    return fs.realpathSync(fsPath)
  } catch {
    const tail: string[] = []
    let current = fsPath
    while (true) {
      try {
        const realAncestor = fs.realpathSync(current)
        return tail.length === 0
          ? realAncestor
          : path.join(realAncestor, ...tail.reverse())
      } catch {
        if (current === path.dirname(current)) {
          // Reached the filesystem root without finding anything existing.
          return fsPath
        }
        tail.push(path.basename(current))
        current = path.dirname(current)
      }
    }
  }
}

// Caches of ROOT lexical path -> realpath (project roots and owned temp
// roots). Roots are realpathed on every containment check, so memoizing them
// avoids a realpath syscall per tool invocation. Individual target paths are
// deliberately NOT cached: they must be dereferenced fresh on every call.
//
// Stated assumption: a root's symlink target does not change while the
// process runs. A root retargeted mid-run keeps its cached realpath until the
// entry is evicted. Insertion-order eviction past
// REALPATH_CACHE_MAX_ENTRIES bounds the memory a long-lived process resolving
// many distinct roots can retain.
const REALPATH_CACHE_MAX_ENTRIES = 256
const projectRootRealpathCache = new Map<string, string>()
const projectRootFileSystemRealpathCache = new WeakMap<
  CodebuffFileSystem,
  Map<string, string>
>()

function setBoundedCacheEntry(
  cache: Map<string, string>,
  key: string,
  value: string,
): void {
  cache.set(key, value)
  while (cache.size > REALPATH_CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next()
    if (oldest.done) break
    cache.delete(oldest.value)
  }
}

/** Memoized realpath for a stable root on the host filesystem. */
function realpathCachedForRoot(root: string): string {
  const cached = projectRootRealpathCache.get(root)
  if (cached !== undefined) return cached
  const real = realpathOrLexical(root)
  setBoundedCacheEntry(projectRootRealpathCache, root, real)
  return real
}

async function realpathOrLexicalForFileSystem(
  fsPath: string,
  fileSystem: CodebuffFileSystem,
): Promise<string> {
  try {
    return String(await fileSystem.realpath(fsPath))
  } catch {
    const tail: string[] = []
    let current = fsPath
    while (true) {
      try {
        const realAncestor = String(await fileSystem.realpath(current))
        return tail.length === 0
          ? realAncestor
          : path.join(realAncestor, ...tail.reverse())
      } catch {
        if (current === path.dirname(current)) return fsPath
        tail.push(path.basename(current))
        current = path.dirname(current)
      }
    }
  }
}

/** Memoized realpath for a stable root, scoped to one injected filesystem. */
async function realpathCachedForFileSystemRoot(
  root: string,
  fileSystem: CodebuffFileSystem,
): Promise<string> {
  let cache = projectRootFileSystemRealpathCache.get(fileSystem)
  if (!cache) {
    cache = new Map<string, string>()
    projectRootFileSystemRealpathCache.set(fileSystem, cache)
  }
  const cached = cache.get(root)
  if (cached !== undefined) return cached
  const real = await realpathOrLexicalForFileSystem(root, fileSystem)
  setBoundedCacheEntry(cache, root, real)
  return real
}

// First-segment patterns for temp namespaces openbuff itself creates and
// writes into. Writers: `sdk/src/tools/background-jobs.ts`
// (`openbuff-<jobId>.log` / `.json`, `openbuff-job-*`),
// `agents/basher.ts` (`openbuff-basher-<uuid>.log`) and `agents/tmux-cli.ts`
// (`tmux-captures-<session>/`).
//
// The executable tmux helper script (`tmux-helper-<session>.sh`) is
// DELIBERATELY EXCLUDED: it is chmod +x'd and then executed by
// run_terminal_command, whose policy also exempts `/tmp/...` tokens. Granting
// write access there would turn a plain file write into arbitrary command
// execution, i.e. a terminal-policy bypass.
//
// These are ANCHORED FULL-SEGMENT patterns, so an attacker-chosen suffix on an
// otherwise owned-looking name does not qualify: `openbuff-x/../y` never
// reaches here (raw `..` is refused up front) and `openbuff-evil.sh` matches
// neither the `.log|.json` file pattern nor the extension-free directory
// pattern.
export const OWNED_TEMP_SEGMENT_PATTERNS: RegExp[] = [
  // Background-job log/metadata + basher full logs: `openbuff-<id>.log|.json`.
  /^openbuff-[A-Za-z0-9._-]+\.(?:log|json)$/,
  // Openbuff-created temp directories (mkdtemp prefixes), no dot-extension.
  /^openbuff-[A-Za-z0-9_-]+$/,
  // tmux-cli capture directories.
  /^tmux-captures-[A-Za-z0-9._-]+$/,
]

let ownedTempRootsCache: string[] | undefined
let ownedTempComparisonRootsCache: string[] | undefined

/**
 * Temp roots openbuff itself writes into.
 *
 * INJECTED-FILESYSTEM CAVEAT: these root NAMES always come from the host
 * process (`os.tmpdir()` and, on POSIX, `/tmp`), including when containment is
 * checked against an injected `CodebuffFileSystem`. Only the dereferencing of
 * those names is done through the adapter (see
 * `resolveProjectPathForFileSystem`). For a virtual or sandboxed filesystem in
 * which those names denote something other than the host temp dir, the
 * owned-temp exception therefore grants reach to whatever the adapter maps
 * them to. Adapters that must not expose host-named temp paths have to refuse
 * them themselves; this module cannot discover an adapter's temp root.
 */
export function getOwnedTempRoots(): string[] {
  if (!ownedTempRootsCache) {
    // `/tmp` is only a real temp root on POSIX. On win32 `path.resolve('/tmp')`
    // yields a current-drive path like `C:\tmp` that is unrelated to the OS
    // temp dir, so adding it there would invent an owned root that openbuff
    // never writes to.
    ownedTempRootsCache = [
      ...new Set([
        path.resolve(os.tmpdir()),
        ...(process.platform !== 'win32' ? [path.resolve('/tmp')] : []),
      ]),
    ]
  }
  return ownedTempRootsCache
}

/**
 * Owned temp roots in both lexical and symlink-dereferenced form. On macOS
 * `os.tmpdir()` is a symlinked `/var/folders/...` path, so an owned file's
 * realpath only lands under the dereferenced root.
 */
function getOwnedTempComparisonRoots(): string[] {
  if (!ownedTempComparisonRootsCache) {
    const roots = getOwnedTempRoots()
    ownedTempComparisonRootsCache = [
      ...new Set([...roots, ...roots.map(realpathCachedForRoot)]),
    ]
  }
  return ownedTempComparisonRootsCache
}

/**
 * Async counterpart of `getOwnedTempComparisonRoots`. The dereferenced form is
 * produced by the injected filesystem, and memoized per filesystem in
 * `projectRootFileSystemRealpathCache` so the async path does not re-realpath
 * the owned roots on every call (matching the sync memoization).
 */
async function getOwnedTempComparisonRootsForFileSystem(
  fileSystem: CodebuffFileSystem,
): Promise<string[]> {
  const roots = getOwnedTempRoots()
  const realRoots = await Promise.all(
    roots.map((root) => realpathCachedForFileSystemRoot(root, fileSystem)),
  )
  return [...new Set([...roots, ...realRoots])]
}

/**
 * True when `target` is strictly inside one of `roots` and its first segment
 * below that root matches an openbuff-owned namespace pattern. The temp root
 * itself never qualifies.
 */
function isInsideOwnedTempNamespace(target: string, roots: string[]): boolean {
  return roots.some((root) => {
    const relative = path.relative(root, target)
    if (relative === '' || escapesRoot(root, target)) return false
    const firstSegment = relative.split(path.sep)[0]
    return OWNED_TEMP_SEGMENT_PATTERNS.some((pattern) =>
      pattern.test(firstSegment),
    )
  })
}

/**
 * Resolve the ALREADY-RESOLVED absolute `fullPath` to the ONE real path that
 * is both validated here and used by callers for the actual filesystem
 * operation. Returns `null` when the path is not inside an openbuff-owned temp
 * namespace.
 *
 * The raw-input `..` policy is enforced by the entry points (see
 * `hasTraversalSegment`), never here: this function only ever sees collapsed
 * paths.
 *
 * The real path is dereferenced EXACTLY ONCE: validating one realpath and
 * then handing callers a second, independently resolved one leaves a TOCTOU
 * window where a symlink swapped in between the two resolutions redirects the
 * operation to an arbitrary target.
 */
function resolveOwnedTempRealPath(fullPath: string): string | null {
  const roots = getOwnedTempComparisonRoots()
  if (!isInsideOwnedTempNamespace(fullPath, roots)) return null

  // Critical guard: a symlink like `/tmp/openbuff-evil.log -> /etc/passwd`
  // passes the lexical checks, so the dereferenced path must satisfy both
  // root containment and the owned-namespace prefix as well.
  const realFullPath = realpathOrLexical(fullPath)
  if (!isInsideOwnedTempNamespace(realFullPath, roots)) return null

  return realFullPath
}

/**
 * True when `input` resolves inside an openbuff-owned temp namespace.
 *
 * Contract: a raw input containing a `..` segment is refused outright, even
 * when it would collapse back into the namespace. `resolveProjectPath` and
 * `resolveProjectPathForFileSystem` apply the same rule to their owned-temp
 * fallback, so all three agree on any given input.
 */
export function isOwnedTempPath(input: string): boolean {
  if (!input || hasTraversalSegment(input)) return false
  return resolveOwnedTempRealPath(path.resolve(input)) !== null
}

/** Async counterpart of `resolveOwnedTempRealPath` for injected filesystems. */
async function resolveOwnedTempRealPathForFileSystem(
  fullPath: string,
  fileSystem: CodebuffFileSystem,
): Promise<string | null> {
  const roots = await getOwnedTempComparisonRootsForFileSystem(fileSystem)
  if (!isInsideOwnedTempNamespace(fullPath, roots)) return null

  // Resolved once, exactly like the sync helper: the validated string is the
  // string callers operate on.
  const realFullPath = await realpathOrLexicalForFileSystem(
    fullPath,
    fileSystem,
  )
  if (!isInsideOwnedTempNamespace(realFullPath, roots)) return null

  return realFullPath
}

/**
 * Build the containment result for an owned temp path. `relativePath` is the
 * absolute resolved path: owned temp paths live outside the project, so a
 * project-relative form would be meaningless (and would look like a traversal
 * escape). Returning the absolute path keeps display and lookup honest.
 *
 * Takes the ALREADY-RESOLVED absolute path from the caller: re-resolving the
 * raw input here would resolve a relative input against `process.cwd()`
 * instead of the caller's project root.
 *
 * `realFullPath` is the exact string that `resolveOwnedTempRealPath`
 * validated — never a second, independently resolved realpath.
 */
function ownedTempContainedPath(fullPath: string): ContainedProjectPath | null {
  const realFullPath = resolveOwnedTempRealPath(fullPath)
  if (realFullPath === null) return null
  return {
    fullPath,
    realFullPath,
    relativePath: fullPath,
    scope: 'owned-temp',
  }
}

/**
 * Async counterpart of `ownedTempContainedPath`. Also takes the
 * already-resolved absolute path; `relativePath` is absolute for the same
 * reason: owned temp paths are never part of the project tree. Like the sync
 * variant, `realFullPath` is the single validated resolution.
 */
async function ownedTempContainedPathForFileSystem(
  fullPath: string,
  fileSystem: CodebuffFileSystem,
): Promise<ContainedProjectPath | null> {
  const realFullPath = await resolveOwnedTempRealPathForFileSystem(
    fullPath,
    fileSystem,
  )
  if (realFullPath === null) return null
  return {
    fullPath,
    realFullPath,
    relativePath: fullPath,
    scope: 'owned-temp',
  }
}

// Read-only allowlist of roots outside the project that path-taking READ tools
// may reach. Deliberately module-level and configure-once: the agent runtime
// backstop and the SDK read handlers must agree on one identical set, and a
// mutable per-call parameter threaded through every read handler would let one
// caller widen the boundary the other enforces.
let externalReadRoots: string[] | undefined
let externalReadComparisonRoots: string[] | undefined
// The project root the stored boundary belongs to, when the configuring caller
// supplied one. WHY it is tracked: the registry is process-global, so without
// an owner a second project configured in the same process (e.g. after
// `switchProjectContext`) is indistinguishable from a mid-run attempt to
// re-point the boundary — the strict primitive would refuse it and project A's
// roots would stay in force while project B's never applied.
let externalReadRootsOwner: string | undefined

/**
 * Canonical normalization for external read root entries: `path.resolve`,
 * empty/whitespace-only entries dropped, deduped and sorted so the stored value
 * is order-independent.
 *
 * Two entry shapes are REFUSED (skipped, not thrown):
 * - a filesystem root (`path.dirname(resolved) === resolved`): allowlisting
 *   `/` or `C:\` would make the entire filesystem readable, which is the exact
 *   opposite of an allowlist;
 * - an entry containing a raw `..` segment: the same rule the owned-temp
 *   exception applies to inputs, applied to the boundary definition itself.
 *
 * Shared by `configureExternalReadRoots` and
 * `ensureExternalReadRootsConfigured` so the `attempted` set the wrapper
 * reports can never describe a different boundary than the one the strict
 * primitive evaluated.
 */
function normalizeExternalReadRoots(roots: readonly string[]): string[] {
  return [
    ...new Set(
      roots
        .filter((root) => root.trim() !== '')
        .filter((root) => !hasTraversalSegment(root))
        .map((root) => path.resolve(root))
        .filter((resolved) => path.dirname(resolved) !== resolved),
    ),
  ].sort()
}

/**
 * Configure the read-only external root allowlist.
 *
 * Entries are normalized by `normalizeExternalReadRoots` (see there for the
 * refused entry shapes).
 *
 * Idempotent for an equivalent set. Calling it with a DIFFERENT set for the
 * SAME (or an unknown) owning project THROWS: silently re-pointing a security
 * boundary mid-run is precisely the failure mode this registry exists to
 * prevent, and a late widening would apply to reads already validated against
 * the earlier set.
 *
 * `projectRoot` is the project the boundary belongs to. Supplying a DIFFERENT
 * project root than the stored owner REPLACES the boundary instead of refusing
 * it: that is a legitimate project switch, and replacing is strictly safer than
 * keeping a boundary that belongs to another project (which would leave project
 * A's roots readable while project B's own allowlist never applied). Omitting
 * `projectRoot` keeps the historical configure-once-per-process behavior, so
 * existing callers and tests are unaffected.
 *
 * Callers that run on EVERY run (rather than exactly once) must use
 * `ensureExternalReadRootsConfigured` instead of catching this throw
 * themselves.
 */
export function configureExternalReadRoots(
  roots: readonly string[],
  projectRoot?: string,
): void {
  const normalized = normalizeExternalReadRoots(roots)
  const owner =
    projectRoot === undefined ? undefined : path.resolve(projectRoot)

  if (externalReadRoots) {
    // A different KNOWN owner means a project switch, which replaces the
    // boundary below. Anything else keeps the strict configure-once semantics.
    const projectSwitched =
      owner !== undefined &&
      externalReadRootsOwner !== undefined &&
      owner !== externalReadRootsOwner
    if (!projectSwitched) {
      const unchanged =
        externalReadRoots.length === normalized.length &&
        externalReadRoots.every((root, index) => root === normalized[index])
      if (unchanged) {
        // Adopt an owner the first caller did not supply, so a later genuine
        // project switch is still detectable.
        externalReadRootsOwner ??= owner
        return
      }
      throw new Error(
        `External read roots are already configured with ${externalReadRoots.length} root(s); ` +
          `refusing to reconfigure with a different set of ${normalized.length} root(s). ` +
          'The external read boundary is configure-once per process.',
      )
    }
  }

  externalReadRoots = normalized
  externalReadRootsOwner = owner ?? externalReadRootsOwner
  // The comparison roots memoize a realpath-dereferenced view of the value
  // being replaced here, so they must be invalidated whenever it changes —
  // otherwise the first configuration wins for the life of the process.
  externalReadComparisonRoots = undefined
}

/**
 * The configured external read roots, as a defensive copy. An empty array when
 * unconfigured: the default posture is closed, so every external-read helper
 * behaves as if the feature does not exist until someone configures it.
 */
export function getExternalReadRoots(): string[] {
  return [...(externalReadRoots ?? [])]
}

/**
 * Outcome of `ensureExternalReadRootsConfigured`.
 *
 * - `'configured'`: this call performed the one configuration for the process,
 *   OR it replaced the boundary because `projectRoot` named a different project
 *   than the stored owner (a legitimate project switch — see
 *   `configureExternalReadRoots`).
 * - `'unchanged'`: the registry was already set to an equivalent value.
 * - `'refused-changed'`: the strict primitive rejected a DIFFERENT set. `roots`
 *   is the still-effective boundary; `attempted` is the normalized set that was
 *   refused. Callers MUST NOT treat this as success.
 */
export type ExternalReadConfigurationResult =
  | { status: 'configured'; roots: string[] }
  | { status: 'unchanged'; roots: string[] }
  | { status: 'refused-changed'; roots: string[]; attempted: string[] }

/**
 * Non-throwing wrapper around `configureExternalReadRoots` for wiring that runs
 * on EVERY run rather than exactly once (see `sdk/src/run.ts`).
 *
 * WHY this exists: the boundary stays configure-once per process, but the
 * caller does not. A user who edits `openbuff.json` mid-session to add a
 * `readableRoots` entry would make the next run call the strict primitive with
 * a different set, and the raw throw would crash that turn. So a mid-session
 * change is deliberately NOT applied: keeping the earlier (narrower or equal)
 * boundary is the fail-safe choice, because reads already validated in this
 * process were validated against that earlier boundary, and widening it
 * retroactively would mean earlier decisions no longer describe the boundary in
 * force. Callers surface a "restart to apply" warning instead.
 *
 * `'refused-changed'` is NOT success: nothing was applied, and the returned
 * `roots` are the pre-existing boundary.
 */
export function ensureExternalReadRootsConfigured(
  roots: readonly string[],
  projectRoot?: string,
): ExternalReadConfigurationResult {
  // Read the registry's own "has it been configured?" state rather than
  // comparing before/after snapshots: a first configuration whose entries are
  // all skipped (e.g. only a filesystem root) stores `[]`, which is
  // indistinguishable from the unconfigured snapshot and would be misreported
  // as `'unchanged'`.
  const alreadyConfigured = externalReadRoots !== undefined
  // Captured BEFORE configuring: a project switch replaces the boundary, so it
  // is reported as `'configured'` rather than `'unchanged'`.
  const owner =
    projectRoot === undefined ? undefined : path.resolve(projectRoot)
  const projectSwitched =
    owner !== undefined &&
    externalReadRootsOwner !== undefined &&
    owner !== externalReadRootsOwner
  try {
    configureExternalReadRoots(roots, projectRoot)
  } catch {
    // The strict primitive only throws for a differing set, and it throws
    // BEFORE mutating anything, so the earlier boundary is still in force.
    return {
      status: 'refused-changed',
      roots: getExternalReadRoots(),
      attempted: normalizeExternalReadRoots(roots),
    }
  }
  return {
    status: alreadyConfigured && !projectSwitched ? 'unchanged' : 'configured',
    roots: getExternalReadRoots(),
  }
}

/**
 * Clear the external read registry. Exists ONLY for test isolation — the
 * registry is module state, so a test that configures it would otherwise leave
 * an open boundary for every later test importing this module. Must not be
 * called from production code paths; the configure-once throw is the intended
 * production behavior.
 */
export function resetExternalReadRootsForTesting(): void {
  externalReadRoots = undefined
  externalReadComparisonRoots = undefined
  // The owner must be cleared too, or a later suite configuring for a different
  // project would be treated as a project switch against a stale owner.
  externalReadRootsOwner = undefined
}

/**
 * Configured external read roots in both lexical and symlink-dereferenced
 * form, mirroring `getOwnedTempComparisonRoots`: a configured root may itself
 * be a symlink (e.g. a home directory on macOS), so a file's realpath only
 * lands under the dereferenced root.
 */
function getExternalReadComparisonRoots(): string[] {
  if (!externalReadComparisonRoots) {
    const roots = getExternalReadRoots()
    externalReadComparisonRoots = [
      ...new Set([...roots, ...roots.map(realpathCachedForRoot)]),
    ]
  }
  return externalReadComparisonRoots
}

/**
 * Async counterpart of `getExternalReadComparisonRoots`. The dereferenced form
 * comes from the injected filesystem and is memoized per filesystem in
 * `projectRootFileSystemRealpathCache`, matching
 * `getOwnedTempComparisonRootsForFileSystem`.
 */
async function getExternalReadComparisonRootsForFileSystem(
  fileSystem: CodebuffFileSystem,
): Promise<string[]> {
  const roots = getExternalReadRoots()
  const realRoots = await Promise.all(
    roots.map((root) => realpathCachedForFileSystemRoot(root, fileSystem)),
  )
  return [...new Set([...roots, ...realRoots])]
}

/**
 * True when `target` is STRICTLY inside one of `roots`. The root itself is
 * refused: it is not a readable file, and admitting it would silently widen
 * later directory-listing consumers to the root entry itself.
 *
 * Containment goes through `escapesRoot`, which is `path.relative`-based, so a
 * sibling-prefix directory like `<root>-evil` is correctly refused where a
 * naive `startsWith` check would admit it.
 */
function isInsideExternalReadRoot(target: string, roots: string[]): boolean {
  return roots.some((root) => {
    const relative = path.relative(root, target)
    return relative !== '' && !escapesRoot(root, target)
  })
}

/**
 * Resolve the ALREADY-RESOLVED absolute `fullPath` to the ONE real path that
 * is both validated here and used by callers for the actual read. Returns
 * `null` when the path is not strictly inside a configured external read root
 * — including whenever the registry is unconfigured, since the comparison root
 * list is then empty.
 *
 * The raw-input `..` policy is enforced by the entry points (see
 * `hasTraversalSegment`), never here: this function only ever sees collapsed
 * paths.
 *
 * The real path is dereferenced EXACTLY ONCE: validating one realpath and then
 * handing callers a second, independently resolved one leaves a TOCTOU window
 * where a symlink swapped in between the two resolutions redirects the read to
 * an arbitrary target. Requiring the dereferenced path to satisfy containment
 * too closes the symlink escape — a file inside an allowlisted root that
 * points at `/etc/shadow`.
 */
function resolveExternalReadRealPath(fullPath: string): string | null {
  const roots = getExternalReadComparisonRoots()
  if (!isInsideExternalReadRoot(fullPath, roots)) return null

  const realFullPath = realpathOrLexical(fullPath)
  if (!isInsideExternalReadRoot(realFullPath, roots)) return null

  // Fail-closed sensitive refusal, checked on BOTH the lexical and the
  // dereferenced basename (a benign-looking name may link to `credentials.json`
  // and vice versa).
  //
  // This lives in the resolver rather than in individual read handlers so every
  // current and future external-read consumer inherits it: the primary thing an
  // allowlisted config root would otherwise expose is
  // `<configDir>/credentials.json`, and a handler that forgot the check would
  // leak provider OAuth tokens and the default API key. This is why
  // `credentials.json` had to be added to the sensitive basenames first.
  //
  // The FULL paths are passed (not just the basenames) so the path-aware
  // credential carriers `isMandatorySensitiveReadPath` recognizes —
  // `.kube/config`, `.docker/config.json`, `gh/hosts.yml`, `.aws/config` —
  // are refused too. Those basenames are far too generic to block on their own,
  // so a basename-only call would silently expose them inside an allowlisted
  // home-directory root.
  if (
    isMandatorySensitiveReadPath(fullPath) ||
    isMandatorySensitiveReadPath(realFullPath)
  ) {
    return null
  }

  return realFullPath
}

/** Async counterpart of `resolveExternalReadRealPath` for injected filesystems. */
async function resolveExternalReadRealPathForFileSystem(
  fullPath: string,
  fileSystem: CodebuffFileSystem,
): Promise<string | null> {
  const roots = await getExternalReadComparisonRootsForFileSystem(fileSystem)
  if (!isInsideExternalReadRoot(fullPath, roots)) return null

  // Resolved once, exactly like the sync helper: the validated string is the
  // string callers read from.
  const realFullPath = await realpathOrLexicalForFileSystem(
    fullPath,
    fileSystem,
  )
  if (!isInsideExternalReadRoot(realFullPath, roots)) return null

  // Identical fail-closed sensitive refusal as the sync resolver, on the same
  // FULL paths; the two must never disagree about `credentials.json` or about a
  // path-aware carrier like `.docker/config.json`.
  if (
    isMandatorySensitiveReadPath(fullPath) ||
    isMandatorySensitiveReadPath(realFullPath)
  ) {
    return null
  }

  return realFullPath
}

/**
 * Resolve a caller input to an absolute path the same way the containment
 * resolvers do: absolute inputs as given, relative inputs against the project
 * root (never `process.cwd()`).
 */
function resolveAgainstRoot(projectRoot: string, input: string): string {
  return path.isAbsolute(input)
    ? path.resolve(input)
    : path.resolve(path.resolve(projectRoot), input)
}

/**
 * True when `input` resolves strictly inside a configured external read root
 * and is not a mandatory-sensitive file. Returns `false` whenever the registry
 * is unconfigured.
 *
 * Contract: a raw input containing a `..` segment is refused outright, even
 * when it would collapse back inside an allowlisted root — the check must live
 * here, above `path.resolve`. `resolveProjectPathForRead` and
 * `resolveProjectPathForFileSystemRead` apply the same rule, so all three
 * agree on any given input.
 */
export function isExternalReadPath(input: string): boolean {
  if (!input || hasTraversalSegment(input)) return false
  return resolveExternalReadRealPath(path.resolve(input)) !== null
}

/**
 * Build the containment result for an external read path. `relativePath` is the
 * absolute resolved path: allowlisted roots live outside the project, so a
 * project-relative form would be meaningless (and would look like a traversal
 * escape).
 *
 * Takes the ALREADY-RESOLVED absolute path from the caller: re-resolving the
 * raw input here would resolve a relative input against `process.cwd()`
 * instead of the caller's project root.
 *
 * `realFullPath` is the exact string that `resolveExternalReadRealPath`
 * validated — never a second, independently resolved realpath.
 */
function externalReadContainedPath(
  fullPath: string,
): ContainedProjectPath | null {
  const realFullPath = resolveExternalReadRealPath(fullPath)
  if (realFullPath === null) return null
  return {
    fullPath,
    realFullPath,
    relativePath: fullPath,
    scope: 'external-read',
  }
}

/**
 * Async counterpart of `externalReadContainedPath`. Also takes the
 * already-resolved absolute path, and like the sync variant uses the single
 * validated resolution as `realFullPath`.
 */
async function externalReadContainedPathForFileSystem(
  fullPath: string,
  fileSystem: CodebuffFileSystem,
): Promise<ContainedProjectPath | null> {
  const realFullPath = await resolveExternalReadRealPathForFileSystem(
    fullPath,
    fileSystem,
  )
  if (realFullPath === null) return null
  return {
    fullPath,
    realFullPath,
    relativePath: fullPath,
    scope: 'external-read',
  }
}

/**
 * Resolve `input` against `projectRoot` and verify it stays inside the
 * project. Returns `null` when:
 *
 * - the input is empty;
 * - the path lexically escapes the project (`..` at the root, an absolute
 *   path outside the root, or a sibling prefix like `/repo-evil` when the
 *   project root is `/repo`);
 * - the symlink-dereferenced path resolves to a location outside the real
 *   project root (e.g. an in-project symlink that points outside the repo).
 *
 * Exception: paths inside an openbuff-owned OS temp namespace (see
 * `isOwnedTempPath` — `openbuff-*` or `tmux-captures-*` directly under the
 * temp root) are allowed even though they are outside the project, so
 * path-taking tools can reach background-job logs, basher full logs and tmux
 * captures. Such results carry `scope: 'owned-temp'` and an absolute
 * `relativePath`; consumers must branch on `scope`. That exception
 * additionally requires a traversal-free raw input, exactly like
 * `isOwnedTempPath`.
 *
 * This is the canonical, package-boundary-safe containment check. The SDK
 * (`sdk/src/tools/path-utils.ts`) and the agent runtime
 * (`packages/agent-runtime`) both call this helper instead of
 * re-implementing the same logic.
 */
export function resolveProjectPath(
  projectRoot: string,
  input: string,
): ContainedProjectPath | null {
  if (!input) return null

  const resolvedRoot = path.resolve(projectRoot)
  const fullPath = path.isAbsolute(input)
    ? path.resolve(input)
    : path.resolve(resolvedRoot, input)
  const ownedTempFallback = (): ContainedProjectPath | null =>
    hasTraversalSegment(input) ? null : ownedTempContainedPath(fullPath)

  // Fast lexical check: the path landing outside the root lexically is an
  // immediate reject.
  if (escapesRoot(resolvedRoot, fullPath)) {
    return ownedTempFallback()
  }

  // Symlink containment: verify the real path is still inside the real root.
  const realRoot = realpathCachedForRoot(resolvedRoot)
  const realFullPath = realpathOrLexical(fullPath)
  if (escapesRoot(realRoot, realFullPath)) {
    return ownedTempFallback()
  }

  return {
    fullPath,
    realFullPath,
    relativePath: path.relative(resolvedRoot, fullPath),
    scope: 'project',
  }
}

/**
 * Async containment resolver for operations executed through an injected
 * filesystem. Realpath checks and the eventual I/O must use the same
 * filesystem instance; otherwise a virtual or wrapped filesystem could expose
 * symlinks that the host filesystem cannot see.
 *
 * The owned-temp exception behaves exactly as in `resolveProjectPath`, with
 * the host-derived root names caveat documented on `getOwnedTempRoots`.
 */
export async function resolveProjectPathForFileSystem(
  projectRoot: string,
  input: string,
  fileSystem: CodebuffFileSystem,
): Promise<ContainedProjectPath | null> {
  if (!input) return null

  const resolvedRoot = path.resolve(projectRoot)
  const fullPath = path.isAbsolute(input)
    ? path.resolve(input)
    : path.resolve(resolvedRoot, input)
  const ownedTempFallback = (): Promise<ContainedProjectPath | null> =>
    hasTraversalSegment(input)
      ? Promise.resolve(null)
      : ownedTempContainedPathForFileSystem(fullPath, fileSystem)

  if (escapesRoot(resolvedRoot, fullPath)) {
    return ownedTempFallback()
  }

  const realRoot = await realpathCachedForFileSystemRoot(
    resolvedRoot,
    fileSystem,
  )
  const realFullPath = await realpathOrLexicalForFileSystem(
    fullPath,
    fileSystem,
  )
  if (escapesRoot(realRoot, realFullPath)) {
    return ownedTempFallback()
  }

  return {
    fullPath,
    realFullPath,
    relativePath: path.relative(resolvedRoot, fullPath),
    scope: 'project',
  }
}

/**
 * READ-ONLY containment resolver: `resolveProjectPath` first, then the
 * configured external read allowlist as a fallback.
 *
 * `resolveProjectPath` and `resolveProjectPathForFileSystem` are DELIBERATELY
 * LEFT UNCHANGED. They are the resolvers the write path uses
 * (`sdk/src/tools/change-file.ts`, `sdk/src/tools/replace-range.ts`,
 * `sdk/src/tools/filesystem-authority.ts`), so keeping the external-read
 * widening in separate, differently-named read-only entry points means a write
 * cannot reach an allowlisted root even by mistake — a write handler would have
 * to be edited to call this function instead. Any future caller of this
 * resolver MUST be a read-only operation.
 *
 * All existing project and owned-temp behavior is identical by construction:
 * a non-null delegate result is returned unchanged, and the external-read
 * branch is only consulted when the delegate returns `null`. That branch
 * refuses a raw `..` first, exactly like the owned-temp fallback, so
 * `isExternalReadPath` and this resolver agree on every input.
 */
export function resolveProjectPathForRead(
  projectRoot: string,
  input: string,
): ContainedProjectPath | null {
  const contained = resolveProjectPath(projectRoot, input)
  if (contained !== null) return contained
  if (!input || hasTraversalSegment(input)) return null
  // Anchored on the project root exactly like the owned-temp fallback, so a
  // relative input never depends on `process.cwd()`.
  return externalReadContainedPath(resolveAgainstRoot(projectRoot, input))
}

/**
 * Async counterpart of `resolveProjectPathForRead`, for operations executed
 * through an injected filesystem. Same read-only contract, and the same reason
 * `resolveProjectPathForFileSystem` is left unchanged: it is the write path's
 * resolver.
 */
export async function resolveProjectPathForFileSystemRead(
  projectRoot: string,
  input: string,
  fileSystem: CodebuffFileSystem,
): Promise<ContainedProjectPath | null> {
  const contained = await resolveProjectPathForFileSystem(
    projectRoot,
    input,
    fileSystem,
  )
  if (contained !== null) return contained
  if (!input || hasTraversalSegment(input)) return null
  return externalReadContainedPathForFileSystem(
    resolveAgainstRoot(projectRoot, input),
    fileSystem,
  )
}

/**
 * Boolean convenience wrapper for tools that only need to know "is this path
 * inside the project root?" without the resolved metadata.
 */
export function isPathInsideProject(
  projectRoot: string,
  input: string,
): boolean {
  return resolveProjectPath(projectRoot, input) !== null
}

/**
 * Build a deduped list of lookup keys for indexing a path into a project
 * file tree. The first key is the project-relative form; the second is the
 * original input (absolute or relative as given). The result is suitable
 * for `Array.includes` / `Set.has` lookups in code that doesn't know
 * whether the caller will pass an absolute or project-relative path.
 */
export function getProjectPathLookupKeys(
  projectRoot: string,
  input: string,
): string[] {
  const resolvedPath = resolveProjectPath(projectRoot, input)
  const keys = resolvedPath ? [resolvedPath.relativePath, input] : [input]
  return [...new Set(keys)]
}
