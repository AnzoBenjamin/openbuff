import fs from 'fs'
import os from 'os'
import path from 'path'

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
 *   convention.
 */
export type ContainedProjectPath = {
  fullPath: string
  realFullPath: string
  relativePath: string
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
const OWNED_TEMP_SEGMENT_PATTERNS: RegExp[] = [
  /^openbuff-/,
  /^tmux-captures-/,
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
function ownedTempContainedPath(
  fullPath: string,
): ContainedProjectPath | null {
  const realFullPath = resolveOwnedTempRealPath(fullPath)
  if (realFullPath === null) return null
  return {
    fullPath,
    realFullPath,
    relativePath: fullPath,
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
 * captures. Such results carry an absolute `relativePath`. That exception
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
  }
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
