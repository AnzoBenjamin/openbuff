import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'

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
 * - `observedCalibrationFactor(model)` returns undefined (use the STATIC
 *   factor) until enough CREDIBLE observations exist (>= MIN_OBSERVATIONS),
 *   then the trimmed median-of-medians of the observed ratios clamped to a
 *   narrow CORRECTION band around the static family factor. Conservative by
 *   design: non-credible pairs never record, outliers beyond the band are
 *   dropped, the window is small, and the clamp keeps a steered run from
 *   swinging budgets across runs (SEC-TC-CALIBRATION-BAND-1).
 * - `tokenCalibrationStatusForTest` exposes the state for assertions.
 */

export const TOKEN_CALIBRATION_MIN_OBSERVATIONS = 8
export const TOKEN_CALIBRATION_WINDOW = 40
/**
 * Legacy absolute clamp band, kept for API compatibility. The EFFECTIVE bound
 * on a converged factor is the per-family correction band below
 * (SEC-TC-CALIBRATION-BAND-1), which is far tighter.
 */
export const TOKEN_CALIBRATION_MIN_FACTOR = 0.5
export const TOKEN_CALIBRATION_MAX_FACTOR = 3.0
/**
 * SEC-TC-CALIBRATION-BAND-1: the calibration loop is a CORRECTION bounded
 * around the static per-family factor, never a free-running replacement for
 * it.
 *
 * The observation pair is untrusted: `estimated` is THIS harness' estimate
 * while `actual` is provider-reported usage, and transcript-steerable content
 * can inflate the provider's count. A tool result the model authored may carry
 * a literal tokenizer special-token sequence (`<|endoftext|>`), which
 * collapses to a single special token provider-side while the LOCAL estimator
 * deliberately escapes `<|` — one step then records a ratio orders of
 * magnitude above 1.0. Eight such steps inside one turn (the loop records one
 * per step, no operator confirmation) previously converged a family factor up
 * to TOKEN_CALIBRATION_MAX_FACTOR and PERSISTED it, which shrank the agent's
 * effective context budget by that factor for every agent on the family: an
 * inflated factor makes context pruning / tool-result eviction delete the
 * transcript at ~1/3 of the real budget (OWASP A08/A04-shaped).
 *
 * The static table already encodes the family gap, so an empirical
 * correction only has to absorb the residual: a converged factor is clamped to
 * [0.8x, 1.25x] of the static family factor, and individual observation pairs
 * whose ratio falls outside that band are non-credible and record nothing.
 */
export const TOKEN_CALIBRATION_BAND_MIN = 0.8
export const TOKEN_CALIBRATION_BAND_MAX = 1.25
/**
 * sec-tc-calibration-denominator-bypass: the band is ASYMMETRIC, because the
 * two drift directions do not carry the same evidence.
 *
 * A ratio of actual/estimated reaches the band from either side, and only one
 * of those inputs is provider-authoritative. Pushing the ratio DOWN only
 * requires inflating the DENOMINATOR — this harness' own estimate — which
 * workspace-controlled content does cheaply: a crafted `openbuff.json`/tool
 * config adds large read-only tool schemas with verbose descriptions, the
 * provider charges almost nothing extra for schemas an OpenAI-routed request
 * serializes anyway, the estimate grows to ~1.25x the provider count, every
 * observation lands inside the symmetric band, and the persisted family factor
 * pins to the band FLOOR (openai: 0.8x), shrinking the effective budget so
 * tool-result eviction deletes ~20% more transcript per step for every agent
 * on that family, across runs.
 *
 * So a DOWNWARD correction (a ratio below `staticFactor * BAND_MIN`) is only
 * credible when it clears a much stricter threshold: the provider would have
 * to report at least 95% of the estimate to under-correct the factor at all.
 * Downward corrections are therefore accepted only inside
 * [0.95x, 1.25x] of the static factor; the [0.8x, 0.95x) slice of the legacy
 * clamp band is now unreachable from observation data (it is still a hard floor
 * on whatever value is applied, so nothing above/below it can ever leak).
 */
export const TOKEN_CALIBRATION_DOWNWARD_BAND_MIN = 1.0
/**
 * sec-tc-calibration-denominator-bypass (hard bound): the band guards the
 * RATIO, and the ratio can be pushed toward 1.0 from EITHER side. Requiring
 * `actual >= estimated` only blocks denominators inflated ABOVE the provider
 * count; a workspace that makes the harness UNDER-estimate (a compact tool
 * schema the provider still charges for) produces `actual > estimated` and
 * walks the converged factor toward the same floor. So the denominator is not
 * what bounds this attack at all — the persisted factor is.
 *
 * The converged factor is therefore only ever allowed to move the correction
 * UPWARD from the static family factor. A downward correction has no safe
 * evidence story (both inputs are steerable from the workspace, and its whole
 * effect is to SHRINK the agent's budget, the availability property this
 * module exists to protect), so the effective floor is the static factor
 * itself: the band's lower edge is unreachable from observation data, and
 * convergence is clamped to [static, static * TOKEN_CALIBRATION_BAND_MAX].
 */
export const TOKEN_CALIBRATION_DOWNWARD_CORRECTION_ALLOWED = false
/** Ratios outside this band relative to the window median are dropped as
 * outliers before convergence (trim guard against one-off provider
 * misreports, e.g. a retry that double-counted a prompt). */
const OUTLIER_BAND = 2.0

type Observation = { estimated: number; actual: number }

/**
 * The static per-family factors the estimator applies when no calibration has
 * converged. Mirrored from token-counter.ts's fudge table (the two are kept in
 * sync by the family-parity test in token-counter.test.ts), because
 * token-counter.ts imports THIS module to read the converged factor and
 * importing it back would close a module cycle (SEC-TC-CYCLE-1).
 */
const STATIC_FAMILY_FACTORS: Record<CalibrationFamily, number> = {
  anthropic: 1.35,
  openai: 1.0,
  gemini: 1.1,
  unknown: 1.0,
}

function staticFactorForFamily(family: CalibrationFamily): number {
  return STATIC_FAMILY_FACTORS[family]
}

/**
 * SEC-TC-CALIBRATION-KEY-1: family keys reach this record from TWO untrusted
 * directions — the on-disk `.openbuff/token-calibration.json` (project-local
 * state that a task/model can be steered into writing) and, transitively, a
 * caller-supplied model id. On a plain `{}` a key named `__proto__` hits the
 * Object.prototype SETTER instead of creating an own entry, so a crafted store
 * entry or model string could mutate the process-wide prototype — and because
 * `persistStore` re-serializes the store, the poisoned entry would round-trip
 * across runs. The map is therefore ALWAYS a null-prototype object (the same
 * discipline as SEC-TC-KEY-1 in token-counter.ts) and proto-ish keys are
 * rejected on both load and write.
 */
type Families = Record<string, Observation[]>

type CalibrationStore = {
  schemaVersion: 1
  /** model-family -> newest-last bounded observation window */
  families: Families
}

let store: CalibrationStore | null = null
let storePath: string | undefined

/**
 * SEC-TC-CALIBRATION-ALLOWLIST-1: the ONLY keys that may ever name a family.
 * The previous guard was a BLOCKLIST ('__proto__'/'constructor'/'prototype'),
 * which is the wrong default for a file any task can write: every other name
 * JSON can carry — 'toString', 'valueOf', 'hasOwnProperty', … — survives it,
 * so JSON-authored keys still reached `Object.entries` and `persistStore` and
 * were re-serialized back into the store file. An allow-list of the four
 * constant family names makes any JSON-authored key unreachable by
 * construction, independent of how `JSON.stringify` walks the object.
 */
const CALIBRATION_FAMILIES = [
  'anthropic',
  'openai',
  'gemini',
  'unknown',
] as const

type CalibrationFamily = (typeof CALIBRATION_FAMILIES)[number]

function isCalibrationFamily(key: string): key is CalibrationFamily {
  return (CALIBRATION_FAMILIES as readonly string[]).includes(key)
}

/**
 * Null-prototype map: a family key named `__proto__` can never reach a
 * prototype setter, because there is no prototype to set.
 */
function createFamilies(): Families {
  return Object.create(null) as Families
}

/** Own data property write — never a computed-key assignment (see above). */
function setFamily(families: Families, family: string, window: Observation[]) {
  Object.defineProperty(families, family, {
    value: window,
    enumerable: true,
    writable: true,
    configurable: true,
  })
}

function emptyStore(): CalibrationStore {
  return { schemaVersion: 1, families: createFamilies() }
}

/**
 * One family's window, without trusting the key or the stored value's shape:
 * a rejected key or a non-array value reads as "no observations" rather than
 * as `Object.prototype` (the old code spread whatever the key resolved to and
 * then threw on `[...window]`).
 */
function familyWindow(families: Families, family: string): Observation[] {
  if (!isCalibrationFamily(family)) return []
  const window = families[family]
  return Array.isArray(window) ? window : []
}

/**
 * Family key mirrors `getTokenizerForModel`'s substring rules so calibration
 * and the static factors divide the model space identically.
 *
 * SEC-TC-CYCLE-1: the rules are duplicated HERE instead of importing
 * `getTokenizerForModel`, because token-counter.ts imports THIS module to read
 * the converged factor — importing back closed a module cycle between the
 * tokenizer cache and the calibration store. The duplicate is kept honest by
 * the family-parity test in token-counter.test.ts, and only these four constant
 * names can come out of it, which is what keeps a model id from ever becoming
 * a store key like `__proto__`.
 */
export function calibrationFamilyForModel(
  model: string | undefined,
): CalibrationFamily {
  if (typeof model !== 'string' || model.length === 0) {
    return 'unknown'
  }
  const normalized = model.toLowerCase()
  if (normalized.includes('claude') || normalized.includes('anthropic')) {
    return 'anthropic'
  }
  if (normalized.includes('gemini') || normalized.includes('google')) {
    return 'gemini'
  }
  if (normalized.includes('gpt-') || normalized.includes('openai')) {
    return 'openai'
  }
  return 'unknown'
}

function loadStore(): CalibrationStore {
  if (store !== null) return store
  if (storePath === undefined) return emptyStore()
  try {
    const parsed = JSON.parse(readFileSync(storePath, 'utf8')) as unknown
    store = sanitizeStore(parsed)
  } catch {
    store = emptyStore()
  }
  return store
}

/**
 * SEC-TC-CALIBRATION-KEY-1: the store file is UNTRUSTED input. The old loader
 * cast any `families` object straight to CalibrationStore, so whatever keys the
 * file carried (including a JSON `__proto__`, which JSON.parse defines as an
 * own property) flowed into a plain-object spread and were re-persisted. Rebuild
 * the record field-by-field instead: proto-ish keys are dropped, non-array
 * family values are dropped, and every window is normalized to bounded numeric
 * observations so a hand-edited file cannot inject non-numbers into the median
 * math.
 */
function sanitizeStore(parsed: unknown): CalibrationStore {
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    Array.isArray(parsed) ||
    (parsed as { schemaVersion?: unknown }).schemaVersion !== 1
  ) {
    return emptyStore()
  }
  const rawFamilies = (parsed as { families?: unknown }).families
  if (
    !rawFamilies ||
    typeof rawFamilies !== 'object' ||
    Array.isArray(rawFamilies)
  ) {
    return emptyStore()
  }
  const families = createFamilies()
  for (const [family, rawWindow] of Object.entries(
    rawFamilies as Record<string, unknown>,
  )) {
    if (!isCalibrationFamily(family) || !Array.isArray(rawWindow)) continue
    const window: Observation[] = []
    // Bounded read: keep only the newest TOKEN_CALIBRATION_WINDOW entries, so a
    // crafted oversized array is neither carried in memory nor re-persisted.
    for (const entry of rawWindow.slice(-TOKEN_CALIBRATION_WINDOW)) {
      if (!entry || typeof entry !== 'object') continue
      const estimated = (entry as { estimated?: unknown }).estimated
      const actual = (entry as { actual?: unknown }).actual
      if (
        typeof estimated !== 'number' ||
        typeof actual !== 'number' ||
        !Number.isFinite(estimated) ||
        !Number.isFinite(actual) ||
        estimated <= 0 ||
        actual <= 0
      ) {
        continue
      }
      const observation: Observation = { estimated, actual }
      // SEC-TC-CALIBRATION-BAND-1(c): a store whose observation pairs cannot
      // be explained by the family gap plus the correction band is UNTRUSTED —
      // it is exactly the shape the persisted-inflation attack produces (or a
      // store written by an earlier free-running version). Drop those entries
      // on load so they can neither converge a factor nor round-trip back into
      // the file.
      if (!isCredibleObservation(family, observation)) continue
      window.push(observation)
    }
    if (window.length === 0) continue
    setFamily(families, family, window)
  }
  return { schemaVersion: 1, families }
}

/**
 * Re-read the on-disk windows and append the new observation, avoiding
 * duplicated cached history while retaining already-completed writes from
 * other processes. Simultaneous read-modify-write operations can still race.
 *
 * The on-disk side goes through the SAME sanitizer as a cold load, so a
 * crafted file still cannot merge in non-credible pairs, proto-ish keys, or an
 * oversized window. Windows remain bounded by TOKEN_CALIBRATION_WINDOW.
 */
function mergeWithOnDisk(
  next: CalibrationStore,
  updatedFamily: CalibrationFamily,
  observation: Observation,
): CalibrationStore {
  let onDisk: CalibrationStore
  try {
    onDisk = sanitizeStore(JSON.parse(readFileSync(storePath!, 'utf8')))
  } catch {
    // Absent, unreadable, or unexpectedly torn: our window is the whole story.
    return next
  }
  const merged = createFamilies()
  // SEC-TC-CALIBRATION-ALLOWLIST-1 (merge path): iterate the CONSTANT family
  // list, never the store's own keys. `sanitizeStore` already allow-lists, but
  // driving the union from `CALIBRATION_FAMILIES` means a JSON-authored key
  // (including a `__proto__` own property) has no way to reach this loop even
  // if a future refactor loosened the sanitizer, and the merged map is built
  // by `defineProperty` alone.
  for (const family of CALIBRATION_FAMILIES) {
    const theirs = familyWindow(onDisk.families, family)
    const ours = familyWindow(next.families, family)
    if (theirs.length === 0 && ours.length === 0) continue
    // The cached window already includes the disk observations read earlier.
    // Append only this call's new observation to the latest disk window;
    // concatenating whole windows duplicates the shared history on every write.
    const union = theirs.length === 0
      ? ours
      : family === updatedFamily
        ? [...theirs, observation].slice(-TOKEN_CALIBRATION_WINDOW)
        : theirs
    setFamily(merged, family, union)
  }
  return { schemaVersion: 1, families: merged }
}

function persistStore(
  next: CalibrationStore,
  updatedFamily: CalibrationFamily,
  observation: Observation,
): void {
  store = next
  if (storePath === undefined) return
  // sec-tc-calibration-non-atomic-persist: the store is written on EVERY
  // recorded observation, so an in-place writeFileSync exposes a window in
  // which a concurrent reader sees truncated/partial JSON and fail-opens to an
  // EMPTY store, and two processes sharing a project root can interleave
  // partial writes. Serialize first, then write a sibling temp file in the
  // SAME directory and rename() it into place: rename(2) within one filesystem
  // is atomic, so readers observe either the previous complete file or the new
  // complete file, never a mix and never a truncated prefix.
  //
  // Re-read before writing to preserve completed external writes; atomic
  // rename protects readers from partial files but does not serialize writers.
  const merged = mergeWithOnDisk(next, updatedFamily, observation)
  store = merged
  // SEC-TC-CALIBRATION-ALLOWLIST-1: build the serialized payload key-by-key
  // from the CONSTANT allow-list instead of handing the store's own keys to
  // JSON.stringify. Even if an unexpected key ever survived sanitization, it
  // cannot reach the serializer's key walk and be re-persisted.
  const families = createFamilies()
  for (const family of CALIBRATION_FAMILIES) {
    const window = familyWindow(merged.families, family)
    if (window.length > 0) setFamily(families, family, window)
  }
  let serialized: string
  try {
    serialized = JSON.stringify({ schemaVersion: 1, families })
  } catch {
    // Fail-open: calibration stays session-only.
    return
  }
  // The temp name is dot-prefixed and pid-suffixed so a directory scan does not
  // mistake it for the store and two processes never collide on the same temp
  // file. It lives in the store's own directory so rename() stays on the same
  // filesystem (a rename across filesystems is not atomic and throws).
  const tempPath = `${storePath}.${process.pid}.tmp`
  try {
    mkdirSync(path.dirname(storePath), { recursive: true })
    writeFileSync(tempPath, serialized, 'utf8')
    renameSync(tempPath, storePath)
  } catch {
    // Fail-open: calibration stays session-only. A half-written temp file is
    // removed so repeated failures cannot accumulate siblings; the store file
    // itself is untouched by the failed write.
    try {
      rmSync(tempPath, { force: true })
    } catch {
      // Best-effort cleanup only.
    }
  }
}

/** Test/integration seam: point the store at a file (or detach with undefined). */
export function setTokenCalibrationStorePath(next: string | undefined): void {
  // sec-tc-calibration-non-atomic-persist: key the in-memory window by the
  // RESOLVED path, so re-attaching the same file (a nested run, a test that
  // re-attaches between assertions) keeps its loaded window instead of
  // silently reloading from disk on every attach, while attaching a DIFFERENT
  // file always drops the previously cached window. Without this, a stale
  // window from one project root could be reused for another.
  const resolved = next === undefined ? undefined : path.resolve(next)
  if (resolved === storePath) return
  storePath = resolved
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
 *
 * SEC-TC-CALIBRATION-BAND-1(b): the pair must also be SELF-CONSISTENT. The
 * provider's count may legitimately differ from the local estimate by the
 * family gap (the static factor) and the small correction band, so a pair
 * outside that range is a misreport or model-steered inflation and records
 * nothing at all — one steered step can therefore never enter the window.
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
  // `calibrationFamilyForModel` only ever returns a constant family name, so
  // this is defense-in-depth; a rejected key writes nothing at all.
  if (!isCalibrationFamily(family)) return
  if (
    !isCredibleObservation(family, {
      estimated: estimatedTokens,
      actual: actualTokens,
    })
  ) {
    return
  }
  const current = loadStore()
  const window = [...familyWindow(current.families, family)]
  window.push({ estimated: estimatedTokens, actual: actualTokens })
  // SEC-TC-CALIBRATION-KEY-1: rebuild the map explicitly instead of
  // `{...families, [family]: window}` — a computed-key assignment routes
  // `__proto__` through the prototype setter, and spread copies any poisoned
  // own key forward. defineProperty on a null-prototype map can only ever
  // create/overwrite an own data property.
  const families = createFamilies()
  for (const [key, value] of Object.entries(current.families)) {
    if (!isCalibrationFamily(key) || key === family) continue
    setFamily(families, key, value)
  }
  setFamily(families, family, window.slice(-TOKEN_CALIBRATION_WINDOW))
  persistStore({ schemaVersion: 1, families }, family, {
    estimated: estimatedTokens,
    actual: actualTokens,
  })
}

/**
 * SEC-TC-CALIBRATION-BAND-1(b) / sec-tc-calibration-denominator-bypass: a
 * single estimator-vs-provider pair is only credible when the provider's count
 * is explainable by the family gap (the static factor) plus the correction
 * band. Anything outside is a provider misreport, model-steered inflation of
 * the provider's own count, or inflation of this harness' ESTIMATE.
 *
 * The lower edge is the stricter TOKEN_CALIBRATION_DOWNWARD_BAND_MIN because a
 * ratio below 1.0 can be manufactured from the denominator alone, while a
 * ratio above 1.0 requires the provider to actually report more tokens. See
 * the constant's doc comment for the full attack.
 */
function isCredibleObservation(
  family: CalibrationFamily,
  observation: Observation,
): boolean {
  const ratio = observation.actual / observation.estimated
  const staticFactor = staticFactorForFamily(family)
  // sec-tc-calibration-denominator-bypass: the lower edge is the STATIC factor
  // itself, not a fraction of it. A downward correction is only reachable by
  // inflating this harness' own estimate (the denominator) — neither band edge
  // proves anything about which side was inflated, so the one direction that
  // actually SHRINKS the agent's budget is simply not reachable from
  // observation data any more. Upward corrections still work: a provider that
  // genuinely charges more per token is authoritative for its own count.
  const effectiveLowerBound =
    staticFactor * TOKEN_CALIBRATION_DOWNWARD_BAND_MIN
  return (
    Number.isFinite(ratio) &&
    ratio >= effectiveLowerBound &&
    ratio <= staticFactor * TOKEN_CALIBRATION_BAND_MAX
  )
}

function dropOutliersAroundMedian(ratios: number[]): number[] {
  const rawMedian = median(ratios)
  const kept = ratios.filter(
    (ratio) =>
      ratio >= rawMedian / OUTLIER_BAND && ratio <= rawMedian * OUTLIER_BAND,
  )
  return kept.length > 0 ? kept : ratios
}

function clampToCorrectionBand(value: number, staticFactor: number): number {
  // sec-tc-calibration-denominator-bypass: the clamp floor is the static factor
  // (no downward correction is reachable), the ceiling stays the band max.
  const floor = TOKEN_CALIBRATION_DOWNWARD_CORRECTION_ALLOWED
    ? staticFactor * TOKEN_CALIBRATION_BAND_MIN
    : staticFactor
  return Math.min(
    staticFactor * TOKEN_CALIBRATION_BAND_MAX,
    Math.max(floor, value),
  )
}

/**
 * SEC-TC-CALIBRATION-BAND-1: the converged factor as a BOUNDED CORRECTION of
 * the static family factor. Undefined unless the window holds at least
 * TOKEN_CALIBRATION_MIN_OBSERVATIONS credible pairs AND the window agrees with
 * itself: the median-of-medians over consecutive chunks must sit within
 * OUTLIER_BAND of the trimmed whole-window median, so one stretch of steps
 * (e.g. a single turn's worth of steered observations) cannot establish a
 * correction on its own.
 */
function convergedCorrectionFactor(
  family: CalibrationFamily,
  window: Observation[],
): number | undefined {
  const staticFactor = staticFactorForFamily(family)
  const credible = window.filter((observation) =>
    isCredibleObservation(family, observation),
  )
  if (credible.length < TOKEN_CALIBRATION_MIN_OBSERVATIONS) {
    return undefined
  }
  const ratios = credible.map(
    (observation) => observation.actual / observation.estimated,
  )
  const windowMedian = median(dropOutliersAroundMedian(ratios))
  const chunkSize = Math.max(1, Math.floor(credible.length / 2))
  const chunkMedians: number[] = []
  for (let i = 0; i < ratios.length; i += chunkSize) {
    chunkMedians.push(median(ratios.slice(i, i + chunkSize)))
  }
  const agrees = chunkMedians.every(
    (chunkMedian) =>
      chunkMedian >= windowMedian / OUTLIER_BAND &&
      chunkMedian <= windowMedian * OUTLIER_BAND,
  )
  if (!agrees) return undefined
  return clampToCorrectionBand(median(chunkMedians), staticFactor)
}

/**
 * The factor actually returned to callers.
 *
 * sec-tc-calibration-denominator-bypass: `convergedCorrectionFactor` only
 * accepts observations inside the asymmetric credibility band, but that band
 * still has a [0.8x, 0.95x) floor slice that a denominator inflation can drive
 * into. Rather than trusting the window alone, the RETURNED factor is held at
 * the static factor unless the correction is genuinely EVIDENCED: a downward
 * result must also satisfy the stricter downward band, i.e. it can only be
 * reported when the provider reported at least
 * TOKEN_CALIBRATION_DOWNWARD_BAND_MIN x the static expectation. Any converged
 * value below that is floored to the static factor, so steering the estimate
 * upward cannot shrink the persisted budget factor below today's behavior.
 */
function evidencedCorrectionFactor(
  family: CalibrationFamily,
  window: Observation[],
): number | undefined {
  const converged = convergedCorrectionFactor(family, window)
  if (converged === undefined) return undefined
  const staticFactor = staticFactorForFamily(family)
  const downwardFloor = staticFactor * TOKEN_CALIBRATION_DOWNWARD_BAND_MIN
  // A downward correction is only applied when every credible observation in
  // the window clears the stricter threshold on its own; one steered stretch
  // of steps therefore cannot pin the floor even if it lands inside the legacy
  // band. Upward corrections (the provider really did count more) pass
  // untouched — they already require provider-authoritative evidence.
  const supportedBelowStatic = window
    .filter((observation) => isCredibleObservation(family, observation))
    .map((observation) => observation.actual / observation.estimated)
    .every((ratio) => ratio >= downwardFloor)
  if (!supportedBelowStatic) {
    return Math.max(converged, staticFactor)
  }
  return converged
}

/**
 * The observed correction factor for a model's family, or undefined until
 * convergence. It is a CORRECTION clamped to
 * [0.8x, 1.25x] of the static family factor (SEC-TC-CALIBRATION-BAND-1) — the
 * static table already encodes the family gap, so the loop only ever refines
 * it. Median-of-medians (not mean) so a single huge transcript cannot
 * dominate.
 */
export function observedCalibrationFactor(
  model: string | undefined,
): number | undefined {
  const family = calibrationFamilyForModel(model)
  // familyWindow never dereferences a proto-ish key, so a `__proto__` model id
  // or store entry yields "no data" instead of Object.prototype.
  return evidencedCorrectionFactor(
    family,
    familyWindow(loadStore().families, family),
  )
}

/** Observability: per-family observation counts + converged factors. */
export function tokenCalibrationStatus(): Record<
  string,
  { observations: number; factor: number | undefined }
> {
  const current = loadStore()
  // SEC-TC-CALIBRATION-KEY-1: same null-prototype discipline on the way out,
  // so a summary key can never be a prototype write either.
  const out: Record<string, { observations: number; factor: number | undefined }> =
    Object.create(null)
  // SEC-TC-CALIBRATION-ALLOWLIST-1: iterate the CONSTANT family names, never
  // the store's own keys, so a JSON-authored key can neither become a summary
  // key nor be forwarded back into observedCalibrationFactor.
  for (const family of CALIBRATION_FAMILIES) {
    const window = familyWindow(current.families, family)
    if (window.length === 0) continue
    Object.defineProperty(out, family, {
      value: {
        observations: window.length,
        factor: observedCalibrationFactor(family),
      },
      enumerable: true,
      writable: true,
      configurable: true,
    })
  }
  return out
}

/** File-existence probe kept for callers deciding whether to attach the store. */
export function tokenCalibrationStoreExists(): boolean {
  return storePath !== undefined && existsSync(storePath)
}
