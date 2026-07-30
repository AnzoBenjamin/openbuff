import path from 'path'

import {
  isOwnedTempPath,
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
 * this package (`apply-patch`, `change-file`, `git-status`, `glob`,
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
 *
 * A top-level owned-temp entry (e.g. an `openbuff-<mkdtemp>` scratch directory
 * directly under the OS temp root) has the bare temp root as its parent, and
 * the temp root is deliberately never itself owned-temp, so the parent lookup
 * fails. In that case the fallback below synthesizes the operation path from
 * the already-dereferenced `realFullPath` and then re-validates that synthesized
 * path against the owned-temp patterns. Containment is never inferred from the
 * child's scope: a lexically-owned parent whose realpath escapes the owned
 * roots also fails the parent lookup, and the synthesized candidate would then
 * land outside the owned namespace, so it must be refused.
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
  if (!parent) {
    // An owned-temp entry directly under the temp root has the bare temp root as
    // its parent, and the temp root is deliberately never itself owned-temp
    // (strictly-inside rule), so the parent lookup legitimately fails there.
    // The parent lookup also fails when the parent is only lexically owned but
    // its realpath escapes the owned roots, so the synthesized candidate is
    // re-validated against the owned patterns rather than trusted.
    const candidate = path.join(
      path.dirname(resolved.realFullPath),
      path.basename(resolved.fullPath),
    )
    if (resolved.scope !== 'owned-temp' || !isOwnedTempPath(candidate)) {
      return null
    }
    return { ...resolved, operationPath: candidate }
  }

  return {
    ...resolved,
    operationPath: path.join(
      parent.realFullPath,
      path.basename(resolved.fullPath),
    ),
  }
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
  if (!parent) {
    // Same re-validation as the sync helper: the synthesized candidate is
    // checked against the owned-temp patterns instead of inferring containment
    // from the child's scope.
    //
    // KNOWN FAIL-OPEN DIRECTION: `isOwnedTempPath` is the SYNC host predicate.
    // For an injected/virtual filesystem whose candidate does not exist on the
    // host, the underlying `realpathOrLexical` falls back to the lexical path,
    // so this re-check degrades to a pure pattern match against HOST-named
    // owned temp roots. A virtual path that merely looks like a host owned-temp
    // path therefore passes, and a legitimate virtual owned-temp root that does
    // not match the host naming is refused (fail-closed in that direction).
    // This only widens the top-level owned-temp entry case: `resolved.scope`
    // was already decided by the adapter-backed resolution above, and every
    // project-scoped path still goes through the adapter parent lookup.
    const candidate = path.join(
      path.dirname(resolved.realFullPath),
      path.basename(resolved.fullPath),
    )
    if (resolved.scope !== 'owned-temp' || !isOwnedTempPath(candidate)) {
      return null
    }
    return { ...resolved, operationPath: candidate }
  }
  return {
    ...resolved,
    operationPath: path.join(
      parent.realFullPath,
      path.basename(resolved.fullPath),
    ),
  }
}
