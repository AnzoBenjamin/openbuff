import path from 'path'

import {
  getOwnedTempRoots,
  isOwnedTempPath,
  OWNED_TEMP_SEGMENT_PATTERNS,
  resolveProjectPath,
  resolveProjectPathForFileSystem,
  type ContainedProjectPath,
} from '@codebuff/common/util/project-path-containment'

import type { CodebuffFileSystem } from '@codebuff/common/types/filesystem'

/**
 * Prompt-supplied filesystem paths. Reject ambiguous platform-specific absolute
 * forms (Windows drive/UNC), NUL bytes, and `..` traversal before any I/O.
 * Absolute POSIX paths are allowed through; containment is enforced by
 * resolveProjectPath*.
 */
export function isSafeProjectRelativePath(input: string): boolean {
  if (!input || input.includes('\0')) return false
  // Reject Windows drive / UNC forms (ambiguous for portable project-relative policy).
  if (
    /^[a-zA-Z]:[\\/]/.test(input) ||
    input.startsWith('\\\\') ||
    input.startsWith('//')
  ) {
    return false
  }
  // Allow absolute POSIX paths; containment is enforced by resolveProjectPath*.
  // Still reject path segments that are '..'.
  return !input.split(/[\\/]+/).includes('..')
}

/**
 * SDK-side re-export of the canonical project-path containment helpers
 * living in `common/`. The real implementation (lexical + realpath/symlink
 * containment, per-project-root realpath cache, synthetic-root fallback) is
 * in `common/src/util/project-path-containment.ts`. Keeping the SDK names
 * stable here preserves the existing public SDK surface for callers in
 * this package (`change-file`, `git-status`, `glob`,
 * `list-directory`, `read-files`, `read-image`, `replace-range`, and
 * `run.ts`).
 */
export {
  resolveProjectPath as resolveFilePathWithinProject,
  getProjectPathLookupKeys,
  isPathInsideProject,
  type ContainedProjectPath as ResolvedProjectPath,
} from '@codebuff/common/util/project-path-containment'

export type ResolvedOperationPath = ContainedProjectPath & {
  operationPath: string
}

/**
 * Shared owned-temp fallback for unlink-style operations (followFinalSymlink: false).
 *
 * A top-level owned-temp entry (e.g. an `openbuff-<mkdtemp>` scratch directory
 * directly under the OS temp root) has the bare temp root as its parent, and
 * the temp root is deliberately never itself owned-temp (strictly-inside rule),
 * so the parent lookup legitimately fails there. The parent lookup also fails
 * when the parent is only lexically owned but its realpath escapes the owned
 * roots — in that case the synthesized candidate would land outside the owned
 * namespace and must be refused.
 *
 * This helper centralizes the candidate synthesis + isOwnedTempPath re-validation
 * so sync and async resolveFilePathFor*Operation cannot drift.
 */
function getUnlinkOperationPath(
  resolved: ContainedProjectPath,
  parent: ContainedProjectPath | null,
): string | null {
  if (!parent) {
    const candidate = path.join(
      path.dirname(resolved.realFullPath),
      path.basename(resolved.fullPath),
    )
    if (resolved.scope !== 'owned-temp' || !isOwnedTempPath(candidate)) {
      return null
    }
    return candidate
  }

  return path.join(parent.realFullPath, path.basename(resolved.fullPath))
}

// --- FS-aware owned-temp helpers for virtual adapters (RF-2) ---
// Re-uses the canonical pattern list from common so the two cannot drift.
export const OWNED_TEMP_SEGMENT_PATTERNS_FS_AWARE: RegExp[] =
  OWNED_TEMP_SEGMENT_PATTERNS

function escapesRootFsAware(root: string, target: string): boolean {
  const relative = path.relative(root, target)
  return (
    relative === '..' ||
    relative.startsWith('..' + path.sep) ||
    path.isAbsolute(relative) ||
    relative.split(path.sep).includes('..')
  )
}

function isInsideOwnedTempNamespaceFsAware(
  target: string,
  roots: string[],
): boolean {
  return roots.some((root) => {
    const relative = path.relative(root, target)
    if (relative === '' || escapesRootFsAware(root, target)) return false
    const firstSegment = relative.split(path.sep)[0]
    return OWNED_TEMP_SEGMENT_PATTERNS_FS_AWARE.some((pattern) =>
      pattern.test(firstSegment),
    )
  })
}

async function realpathOrLexicalForFileSystemFsAware(
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

async function getOwnedTempComparisonRootsForFileSystemFsAware(
  fileSystem: CodebuffFileSystem,
): Promise<string[]> {
  const roots = getOwnedTempRoots()
  const realRoots = await Promise.all(
    roots.map((root) => realpathOrLexicalForFileSystemFsAware(root, fileSystem)),
  )
  return [...new Set([...roots, ...realRoots])]
}

async function isOwnedTempPathForFileSystem(
  input: string,
  fileSystem: CodebuffFileSystem,
): Promise<boolean> {
  if (!input || input.split(/[\\/]+/).includes('..')) return false
  const fullPath = path.resolve(input)
  const roots =
    await getOwnedTempComparisonRootsForFileSystemFsAware(fileSystem)
  if (!isInsideOwnedTempNamespaceFsAware(fullPath, roots)) return false
  const realFullPath = await realpathOrLexicalForFileSystemFsAware(
    fullPath,
    fileSystem,
  )
  if (!isInsideOwnedTempNamespaceFsAware(realFullPath, roots)) return false
  return true
}

async function getUnlinkOperationPathForFileSystem(
  resolved: ContainedProjectPath,
  parent: ContainedProjectPath | null,
  fileSystem: CodebuffFileSystem,
): Promise<string | null> {
  if (!parent) {
    const candidate = path.join(
      path.dirname(resolved.realFullPath),
      path.basename(resolved.fullPath),
    )
    if (
      resolved.scope !== 'owned-temp' ||
      !(await isOwnedTempPathForFileSystem(candidate, fileSystem))
    ) {
      return null
    }
    return candidate
  }
  return path.join(parent.realFullPath, path.basename(resolved.fullPath))
}

/**
 * Resolve a project path for immediate filesystem/process use.
 *
 * The public `resolveFilePathWithinProject` helper preserves the caller's
 * lexical path for lookup/display compatibility. Filesystem operations should
 * instead use `operationPath`, which pins the already-dereferenced in-project
 * target so swapping the caller-supplied symlink path cannot redirect the
 * operation outside the project.
 *
 * Unlink-style operations set `followFinalSymlink: false`: parent-directory
 * symlinks are still dereferenced and contained, while the final path component
 * remains the link itself so deleting an allowed in-project symlink does not
 * delete its target.
 */
export function resolveFilePathForOperation(
  projectRoot: string,
  input: string,
  options: { followFinalSymlink?: boolean } = {},
): ResolvedOperationPath | null {
  const resolved = resolveProjectPath(projectRoot, input)
  if (!resolved) return null

  if (options.followFinalSymlink !== false) {
    return { ...resolved, operationPath: resolved.realFullPath }
  }

  const parent = resolveProjectPath(
    projectRoot,
    path.dirname(resolved.fullPath),
  )
  const operationPath = getUnlinkOperationPath(resolved, parent)
  if (!operationPath) return null
  return { ...resolved, operationPath }
}

/** Filesystem-aware counterpart used whenever the operation itself runs
 * through an injected CodebuffFileSystem. */
export async function resolveFilePathForFileSystemOperation(
  projectRoot: string,
  input: string,
  fileSystem: CodebuffFileSystem,
  options: { followFinalSymlink?: boolean } = {},
): Promise<ResolvedOperationPath | null> {
  const resolved = await resolveProjectPathForFileSystem(
    projectRoot,
    input,
    fileSystem,
  )
  if (!resolved) return null

  if (options.followFinalSymlink !== false) {
    return { ...resolved, operationPath: resolved.realFullPath }
  }

  const parent = await resolveProjectPathForFileSystem(
    projectRoot,
    path.dirname(resolved.fullPath),
    fileSystem,
  )
  // FS-aware re-validation: the synthesized top-level owned-temp candidate
  // is checked through the injected filesystem's realpath/roots, not the
  // host sync predicate, so a virtual adapter cannot be spoofed by a
  // host-named pattern and a virtual owned-temp root is honoured.
  const operationPath = await getUnlinkOperationPathForFileSystem(
    resolved,
    parent,
    fileSystem,
  )
  if (!operationPath) return null
  return { ...resolved, operationPath }
}
