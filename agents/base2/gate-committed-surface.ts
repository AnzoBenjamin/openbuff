/**
 * Pure committed-surface snapshot helpers for the base2 reviewer gate.
 *
 * NOTE: the inline copy is **generated** into the base2 `handleSteps`
 * `<gate-helpers-generated>` region via `scripts/generate-gate-helpers.ts`
 * (same as gate-paths/reviewer/repair/concurrency/fingerprint).
 * `handleSteps` is serialized via `toString()` / `new Function(...)` and
 * loses module closure, so it cannot import this file — edit this module
 * and regenerate rather than hand-maintaining the inline copy.
 */

// Hard bound on a derived committed-surface fileset. A stale or adversarial
// runtime-observed file list must never explode the gate fingerprint or the
// spawned specialist review; overflow is a mandatory rejection, never a
// truncation. The inline base2 branch re-declares this bound as a local
// literal because the generator splices only function/type declarations, so
// the spliced copies cannot reference this const (keep the literal in sync).
export const MAX_COMMITTED_SURFACE_FILES = 40

/** `ok` carries the sorted, reviewable, byte-verifiable file list. */
export type CommittedSurfaceFileSetOk = {
  status: 'ok'
  files: string[]
}
/** Mandatory rejection: the derived fileset was empty (a constant fingerprint). */
export type CommittedSurfaceFileSetEmpty = {
  status: 'empty'
}
/** Mandatory rejection: the derived fileset exceeded the cap (`total` files). */
export type CommittedSurfaceFileSetOverflow = {
  status: 'overflow'
  total: number
}
export type CommittedSurfaceFileSetResult =
  | CommittedSurfaceFileSetOk
  | CommittedSurfaceFileSetEmpty
  | CommittedSurfaceFileSetOverflow

/**
 * A committed-surface receipt must cover only files with verifiable bytes, so
 * the content marker must be a 64-hex sha256 marker: `sha256:<hex>:<length>`
 * for regular files or `symlink-sha256:<hex>:<length>` for safe in-project
 * symlinks. `missing`, `unreadable:*`, and every other sentinel are dropped.
 * Same shape as base2's canonical isAttestableContentMarker; duplicated as a
 * pure local so this module stays import-free.
 */
function isAttestableCommittedSurfaceMarker(value: string): boolean {
  return /^(?:symlink-)?sha256:[a-f0-9]{64}:\d+$/.test(value)
}

/**
 * Derive the bounded committed-surface fileset from the runtime-observed task
 * files. `runtimeFiles` is normalized, deduped (first-seen order), optionally
 * narrowed to `narrowingHint` ∩ runtimeFiles, filtered through `isReviewable`,
 * and stripped of every path whose `markerFor` is not a 64-hex sha256 content
 * marker. The survivor list is sorted; a result above `cap` overflows and an
 * empty survivor list is empty — both must be rejected by the caller (never
 * minted over). `cap` defaults to MAX_COMMITTED_SURFACE_FILES (40).
 */
export function deriveCommittedSurfaceFileSet(input: {
  runtimeFiles: string[]
  narrowingHint?: string[]
  isReviewable: (path: string) => boolean
  markerFor: (path: string) => string
  cap?: number
}): CommittedSurfaceFileSetResult {
  const cap =
    typeof input.cap === 'number' && input.cap >= 1
      ? Math.floor(input.cap)
      : 40
  const runtimeFiles =
    Array.isArray(input.runtimeFiles) ? input.runtimeFiles : []
  const seen = new Set<string>()
  const normalizedRuntime: string[] = []
  for (const rawFile of runtimeFiles) {
    if (typeof rawFile !== 'string') {
      continue
    }
    const normalized = rawFile.trim().replace(/\\/g, '/')
    if (!normalized) {
      continue
    }
    if (seen.has(normalized)) {
      continue
    }
    seen.add(normalized)
    normalizedRuntime.push(normalized)
  }
  let candidates = normalizedRuntime
  if (Array.isArray(input.narrowingHint) && input.narrowingHint.length > 0) {
    const hintSet = new Set<string>()
    for (const rawHint of input.narrowingHint) {
      if (typeof rawHint !== 'string') {
        continue
      }
      const normalized = rawHint.trim().replace(/\\/g, '/')
      if (!normalized) {
        continue
      }
      hintSet.add(normalized)
    }
    candidates = normalizedRuntime.filter((file) => hintSet.has(file))
  }
  const kept: string[] = []
  for (const file of candidates) {
    if (!input.isReviewable(file)) {
      continue
    }
    if (!isAttestableCommittedSurfaceMarker(input.markerFor(file))) {
      continue
    }
    kept.push(file)
  }
  kept.sort((a, b) => a.localeCompare(b))
  if (kept.length > cap) {
    return { status: 'overflow', total: kept.length }
  }
  if (kept.length === 0) {
    return { status: 'empty' }
  }
  return { status: 'ok', files: kept }
}

/**
 * Gate-computed receipt id for a committed-surface mint. The kind is part of
 * the id so a committed-surface receipt can never be mistaken for a
 * different-evidence receipt carrying the same fingerprint prefix.
 */
export function committedSurfaceReceiptId(
  taskId: string,
  fingerprint: string,
): string {
  return `plan-gate:${taskId}:committed-surface:${fingerprint.slice(0, 16)}`
}
