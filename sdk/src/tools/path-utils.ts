import path from 'path'

import {
  isOwnedTempPath,
  isOwnedTempPathForFileSystem,
  resolveProjectPath,
  resolveProjectPathForFileSystem,
  resolveProjectPathForFileSystemRead,
  resolveProjectPathForRead,
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
 * Extra host-policy alias keys for a read path resolved under a non-'project'
 * scope.
 *
 * WHY: an 'owned-temp' or 'external-read' resolution carries an ABSOLUTE
 * `relativePath`, so a host `fileFilter` written against project-relative globs
 * never matches it and would silently fail OPEN. The basename and the stable
 * `<scope>/<basename>` key (`owned-temp/job.log`, `external-read/notes.png`)
 * are what a host policy can actually target for those paths — the same alias
 * shape `read-files.ts` builds in `authorizeReadTarget`.
 *
 * Returns an empty list for `scope === 'project'`, where the project-relative
 * path is already the key a host policy targets.
 */
export function getScopedReadPolicyAliases(
  scope: ContainedProjectPath['scope'],
  pathOrName: string,
): string[] {
  if (scope === 'project') return []
  const basename = path.posix.basename(pathOrName.replace(/\\/g, '/'))
  return [...new Set([basename, `${scope}/${basename}`])]
}

/**
 * Shared owned-temp fallback for unlink-style operations (followFinalSymlink: false).
 *
 * A top-level owned-temp entry (e.g. a scratch directory directly under the OS
 * temp root) has the bare temp root as its parent, and the temp root is
 * deliberately never itself owned-temp (strictly-inside rule), so the parent
 * lookup legitimately fails there. The parent lookup also fails when the parent
 * is only lexically inside a temp root but its realpath escapes every temp root
 * — in that case the synthesized candidate would land outside containment and
 * must be refused.
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

/**
 * Async twin of `getUnlinkOperationPath`, kept structurally identical so the
 * pair cannot drift.
 *
 * WHY the FS-aware predicate: the synthesized top-level candidate must be
 * re-validated through the INJECTED filesystem rather than the host sync
 * predicate, so a virtual adapter cannot be spoofed by a host-named path and a
 * virtual temp root is honoured. `isOwnedTempPathForFileSystem` in common does
 * exactly that (adapter `realpath` plus fs-aware comparison roots), so reusing
 * it preserves the RF-2 property while removing a private duplicate that would
 * now have to be widened in lockstep with the shared containment rule.
 */
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

/**
 * READ-ONLY twin of `resolveFilePathForOperation`.
 *
 * Delegates to `resolveProjectPathForRead`, so in addition to project and
 * temp-root paths it also resolves a path strictly inside an explicitly
 * allowlisted external read root (`scope: 'external-read'`, with an ABSOLUTE
 * `relativePath` — consumers must branch on `scope`).
 *
 * ANY caller of this function MUST be a read-only operation. The write path
 * (`change-file.ts`, `replace-range.ts`, `filesystem-authority.ts`,
 * `3d-assets.ts`) keeps calling `resolveFilePathForOperation`, which is blind
 * to the external read allowlist — so reaching an allowlisted root from a write
 * would require someone to edit a write handler to call this differently-named
 * read-only resolver.
 *
 * This is the FOLLOW-SYMLINK read shape ONLY: there is deliberately no
 * `followFinalSymlink: false` option. That option exists for unlink-style
 * operations (deleting the link rather than its target), which are mutations
 * and must never reach an external root.
 */
export function resolveFilePathForReadOperation(
  projectRoot: string,
  input: string,
): ResolvedOperationPath | null {
  const resolved = resolveProjectPathForRead(projectRoot, input)
  if (!resolved) return null
  return { ...resolved, operationPath: resolved.realFullPath }
}

/**
 * Filesystem-aware counterpart of `resolveFilePathForReadOperation`, used
 * whenever the read itself runs through an injected CodebuffFileSystem.
 *
 * Same read-only contract, and the same deliberate omission of
 * `followFinalSymlink: false`: unlink-style resolution is for mutations, which
 * must never reach an allowlisted external root.
 */
export async function resolveFilePathForFileSystemReadOperation(
  projectRoot: string,
  input: string,
  fileSystem: CodebuffFileSystem,
): Promise<ResolvedOperationPath | null> {
  const resolved = await resolveProjectPathForFileSystemRead(
    projectRoot,
    input,
    fileSystem,
  )
  if (!resolved) return null
  return { ...resolved, operationPath: resolved.realFullPath }
}
