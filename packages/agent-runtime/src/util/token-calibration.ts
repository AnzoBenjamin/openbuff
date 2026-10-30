import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { getTokenizerForModel } from './token-counter'

/**
 * P3-T10 (design-review re-spec): usage-feedback calibration loop.
 *
 * The estimator counts with the gpt-4o BPE and corrects per model family with
 * STATIC fudge factors (1.35/1.0/1.1) that were hand-derived from audits. The
 * original plan chased per-provider tokenizer kernels; the design review
 * re-spec'd the primary mechanism as a CALIBRATION LOOP instead: every
 * provider already reports actual usage (`usage.inputTokens`) on each
 * response, so recording estimator-vs-actual pairs and converging the
 * correction factor empirically covers every provider uniformly — including
 * Anthropic/Gemini, which the kernel path explicitly could not.
 *
 * This module is the store + the math. It is deliberately self-contained and
 * side-effect-light:
 * - `recordTokenObservation(model, estimatedTokens, actualTokens)` appends to
 *   a bounded rolling window per model family (the same family rules as
 *   `getTokenizerForModel`), persisted as a tiny JSON next to the CLI's other
 *   per-project state. ALL persistence is fail-open: an unreadable/unwritable
 *   store degrades to in-memory calibration, never to a thrown error in the
 *   request path.
 * - `calibratedFudgeFactor(model)` returns the STATIC factor until enough
 *   observations exist (>= MIN_OBSERVATIONS), then the trimmed median of the
 *   observed ratios clamped to a sane band. Conservative by design: outliers
 *   beyond the band are dropped, the window is small, and the clamp keeps a
 *   pathological run from swinging budgets wildly.
 * - `tokenCalibrationStatusForTest` exposes the state for assertions.
 */

export const TOKEN_CALIBRATION_MIN_OBSERVATIONS = 8
export const TOKEN_CALIBRATION_WINDOW = 40
/** Clamp band for the converged factor: a corrected estimate may never be
 * more pessimistic than 0.5x or optimistic beyond 3x the static estimate. */
export const TOKEN_CALIBRATION_MIN_FACTOR = 0.5
export const TOKEN_CALIBRATION_MAX_FACTOR = 3.0
/** Ratios outside this band relative to the window median are dropped as
 * outliers before convergence (trim guard against one-off provider
 * misreports, e.g. a retry that double-counted a prompt). */
const OUTLIER_BAND = 2.0

type Observation = { estimated: number; actual: number }

type CalibrationStore = {
  schemaVersion: 1
  /** model-family -> newest-last bounded observation window */
  families: Record<string, Observation[]>
}

let store: CalibrationStore | null = null
let storePath: string | undefined

function emptyStore(): CalibrationStore {
  return { schemaVersion: 1, families: {} }
}

/**
 * Family key mirrors `getTokenizerForModel`'s substring rules so calibration
 * and the static factors divide the model space identically.
 */
export function calibrationFamilyForModel(model: string | undefined): string {
  return getTokenizerForModel(model)
}

function loadStore(): CalibrationStore {
  if (store !== null) return store
  if (storePath === undefined) return emptyStore()
  try {
    const parsed = JSON.parse(readFileSync(storePath, 'utf8')) as unknown
    store =
      parsed &&
      typeof parsed === 'object' &&
      !Array.isArray(parsed) &&
      (parsed as { schemaVersion?: unknown }).schemaVersion === 1 &&
      typeof (parsed as { families?: unknown }).families === 'object'
        ? (parsed as CalibrationStore)
        : emptyStore()
  } catch {
    store = emptyStore()
  }
  return store!
}

function persistStore(next: CalibrationStore): void {
  store = next
  if (storePath === undefined) return
  try {
    mkdirSync(path.dirname(storePath), { recursive: true })
    writeFileSync(storePath, JSON.stringify(next), 'utf8')
  } catch {
    // Fail-open: calibration stays session-only.
  }
}

/** Test/integration seam: point the store at a file (or detach with undefined). */
export function setTokenCalibrationStorePath(next: string | undefined): void {
  storePath = next
  store = null
}

/** Reset the in-memory store (tests). Does not delete the file. */
export function resetTokenCalibrationForTest(): void {
  store = null
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1
    ? sorted[mid]!
    : (sorted[mid - 1]! + sorted[mid]!) / 2
}

/**
 * Record one estimator-vs-actual pair. Invalid inputs (non-positive counts)
 * are ignored — a provider that reports 0 tokens carries no information and a
 * 0 estimate cannot form a ratio.
 */
export function recordTokenObservation(
  model: string | undefined,
  estimatedTokens: number,
  actualTokens: number,
): void {
  if (
    !Number.isFinite(estimatedTokens) ||
    !Number.isFinite(actualTokens) ||
    estimatedTokens <= 0 ||
    actualTokens <= 0
  ) {
    return
  }
  const family = calibrationFamilyForModel(model)
  const current = loadStore()
  const window = current.families[family]
    ? [...current.families[family]!]
    : []
  window.push({ estimated: estimatedTokens, actual: actualTokens })
  persistStore({
    ...current,
    families: {
      ...current.families,
      [family]: window.slice(-TOKEN_CALIBRATION_WINDOW),
    },
  })
}

/**
 * The observed correction factor for a model's family, or undefined until
 * convergence. Computed as the median of per-observation ratios AFTER
 * dropping band-outliers around the raw median, clamped to the sane band.
 * Median (not mean) so a single huge transcript cannot dominate.
 */
export function observedCalibrationFactor(
  model: string | undefined,
): number | undefined {
  const family = calibrationFamilyForModel(model)
  const window = loadStore().families[family]
  if (!window || window.length < TOKEN_CALIBRATION_MIN_OBSERVATIONS) {
    return undefined
  }
  const ratios = window.map((obs) => obs.actual / obs.estimated)
  const rawMedian = median(ratios)
  const kept = ratios.filter(
    (ratio) =>
      ratio >= rawMedian / OUTLIER_BAND && ratio <= rawMedian * OUTLIER_BAND,
  )
  const converged = median(kept.length > 0 ? kept : ratios)
  return Math.min(
    TOKEN_CALIBRATION_MAX_FACTOR,
    Math.max(TOKEN_CALIBRATION_MIN_FACTOR, converged),
  )
}

/** Observability: per-family observation counts + converged factors. */
export function tokenCalibrationStatus(): Record<
  string,
  { observations: number; factor: number | undefined }
> {
  const current = loadStore()
  const out: Record<string, { observations: number; factor: number | undefined }> =
    {}
  for (const [family, window] of Object.entries(current.families)) {
    out[family] = {
      observations: window.length,
      factor: observedCalibrationFactor(family),
    }
  }
  return out
}

/** File-existence probe kept for callers deciding whether to attach the store. */
export function tokenCalibrationStoreExists(): boolean {
  return storePath !== undefined && existsSync(storePath)
}
