/**
 * Shared filesystem fixtures for suites that exercise paths OUTSIDE the
 * project root and every OS temp root.
 *
 * Containment suites cannot anchor escape fixtures under an OS temp root: the
 * widened temp exception legitimately admits anything strictly inside one, so
 * a refusal there would be unattributable. `makeOutsideRoot` therefore anchors
 * scratch directories under `<cwd>/.containment-test-scratch/`, which sits
 * outside BOTH boundaries. Suites either clean the fixtures themselves or
 * delegate to `cleanupOutsideRoots()` (which drains the module-level tracker)
 * followed by `removeScratchParentIfEmpty()`.
 */

import fs from 'node:fs'
import path from 'node:path'

import { getOwnedTempRoots } from '../../util/project-path-containment'

/** Fixture roots created by `makeOutsideRoot`, for `cleanupOutsideRoots`. */
const trackedOutsideRoots: string[] = []

/**
 * Fixture root that is outside BOTH the project root and every OS temp root, so
 * a containment refusal here is attributable to the escape itself rather than
 * to a path the widened temp exception now legitimately admits.
 */
export function makeOutsideRoot(prefix: string): string {
  // The scratch parent is created lazily at call time — never at module load —
  // so importing this module has no filesystem side effects.
  const parent = path.join(process.cwd(), '.containment-test-scratch')
  fs.mkdirSync(parent, { recursive: true })
  const dir = fs.mkdtempSync(path.join(parent, prefix))
  trackedOutsideRoots.push(dir)
  return dir
}

/**
 * True when this checkout itself sits outside every OS temp root. A checkout
 * under a temp root would make `makeOutsideRoot` produce an owned-temp path
 * where an escape refusal is unattributable — affected tests skip in that
 * case instead of asserting a refusal that cannot hold there.
 */
export function outsideRootsUsable(): boolean {
  const repoRoot = fs.realpathSync(process.cwd())
  return getOwnedTempRoots().every((root) => {
    const relative = path.relative(fs.realpathSync(root), repoRoot)
    return (
      relative === '..' ||
      relative.startsWith('..' + path.sep) ||
      path.isAbsolute(relative)
    )
  })
}

/** Removes every fixture root still tracked from `makeOutsideRoot`. */
export function cleanupOutsideRoots(): void {
  for (const dir of trackedOutsideRoots.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

/** Removes the scratch parent when empty; see `makeOutsideRoot`. */
export function removeScratchParentIfEmpty(): void {
  try {
    fs.rmdirSync(path.join(process.cwd(), '.containment-test-scratch'))
  } catch {
    // Children from this or another suite remain; leave the parent in place.
  }
}
