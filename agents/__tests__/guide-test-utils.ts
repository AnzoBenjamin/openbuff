import { existsSync } from 'fs'
import path from 'path'

/**
 * Shared repo-root/guide-existence helpers for the guide-pointer tests.
 *
 * `agents/guides/*.md` paths appear in prompts and in `GUIDE_POINTERS` as
 * workspace-relative POSIX paths, so several tests need the same
 * `agents/__tests__ -> repo root` derivation plus the same labelled existence
 * probe. Both live here so a future guides-dir (or test-dir) move only changes
 * one place.
 */

/** agents/__tests__ -> repo root. */
export const REPO_ROOT = path.join(__dirname, '..', '..')

/** Absolute path for a workspace-relative repo path such as a guide file. */
export function resolveRepoPath(relativePath: string): string {
  return path.join(REPO_ROOT, relativePath)
}

/**
 * Labelled existence probe: returns `'exists'` or a message naming the missing
 * path, so `expect(describeRepoFileExistence(x)).toBe('exists')` reports the
 * offending file instead of `expected false to be true`. Pass `label` when the
 * caller wants to name the reference (e.g. a pointer) rather than the raw path.
 */
export function describeRepoFileExistence(
  relativePath: string,
  label: string = relativePath,
): string {
  return existsSync(resolveRepoPath(relativePath))
    ? 'exists'
    : `${label} is missing`
}
