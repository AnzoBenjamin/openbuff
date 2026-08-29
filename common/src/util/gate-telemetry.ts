/**
 * Durable append-only sink for base2 gate telemetry: `console.info` is the
 * pre-existing channel of base2's `emitGateTelemetry`, and this module appends
 * the same payloads as JSONL under
 * `<projectRoot>/.openbuff/telemetry/base2-gate.jsonl`.
 *
 * Best-effort: never throws (including when `logger.warn` itself throws),
 * reports failures through the boolean return value, and keeps owner-only modes
 * (`0o700` directory, `0o600` file) like `sdk/src/services/task-memory-store.ts`.
 */

import fs from 'fs'
import path from 'path'

import { errorCode } from './error'

import type { Logger } from '../types/contracts/logger'

/** Project-relative path of the append-only gate-telemetry sink. */
export const GATE_TELEMETRY_RELATIVE = path.join(
  '.openbuff',
  'telemetry',
  'base2-gate.jsonl',
)

/**
 * THE authoritative rotation note; everything else refers here. An append that
 * finds the live sink over this many bytes first renames it to `<sink>.1` — ONE
 * kept generation, overwriting the previous one — so the current event lands in a
 * fresh file. Two approximations are accepted for best-effort telemetry:
 * check-then-rename is unlocked, so a concurrent append sharing one
 * `projectRoot` may land in the just-rotated `.1` file; and a pre-flight tracks
 * only its OWN appended bytes, so `GATE_TELEMETRY_STAT_INTERVAL_APPENDS` is what
 * keeps N recorders from each staying under the bound while the live file grows
 * to roughly N x it.
 */
export const GATE_TELEMETRY_MAX_BYTES = 2_000_000

/** Re-stat the live sink after this many appends; see `GATE_TELEMETRY_MAX_BYTES`. */
export const GATE_TELEMETRY_STAT_INTERVAL_APPENDS = 20

/** Keep at most this many entries of any array-valued payload field. */
export const GATE_TELEMETRY_MAX_ARRAY_ITEMS = 50

/** Hard cap on one serialized JSONL line, including its trailing newline. */
export const GATE_TELEMETRY_MAX_LINE_BYTES = 32_000

/**
 * Per-field cap on top-level strings of an already-oversized line, in BYTES —
 * the same unit as `GATE_TELEMETRY_MAX_LINE_BYTES`.
 */
export const GATE_TELEMETRY_MAX_FIELD_BYTES = 2_000

/**
 * Work bound of the step-2 capping pass; a wider payload stays bounded through
 * the whole-line marker instead.
 */
export const GATE_TELEMETRY_MAX_CAPPED_FIELDS = 64

/**
 * Element cap on the `truncatedFields` name list; clipped fields past it are
 * counted under `truncatedFieldsOmittedCount`, so the list is never read as
 * exhaustive when it is not.
 */
export const GATE_TELEMETRY_MAX_NAMED_TRUNCATED_FIELDS = 64

/** `O_NOFOLLOW` is POSIX-only, so `0` doubles as "no POSIX file semantics here". */
const GATE_TELEMETRY_NOFOLLOW_FLAG =
  process.platform === 'win32' ? 0 : fs.constants.O_NOFOLLOW

/**
 * Cap in BYTES on the `event` name copied into the oversized-line marker, so an
 * `event` that is ITSELF the huge field cannot make the marker oversized.
 */
export const GATE_TELEMETRY_MAX_MARKER_EVENT_BYTES = 200

/**
 * Per-recorder memo of the one-time path pre-flight (mkdir + owner-only mode
 * repair) plus the live sink size the rotation check reads, so base2's dozens of
 * gate sites do not each pay those synchronous syscalls. A failed append re-arms
 * both; the symlink scan is never memoized.
 */
export type GateTelemetryPreflight = {
  verified: boolean
  /**
   * Best-known byte size of the live sink file, kept current by adding each
   * appended line. `undefined` forces a `statSync`; so does a value past
   * `GATE_TELEMETRY_MAX_BYTES`, where the real size decides whether to rotate.
   */
  sinkBytes?: number
  /** Appends made since `sinkBytes` was last read from the filesystem. */
  appendsSinceStat?: number
  /**
   * Set when the pre-append rotation failed, so the retry backs off to the
   * periodic re-stat instead of re-paying the rotation syscalls per append.
   */
  rotationFailed?: boolean
}

/** Fresh pre-flight memo; one per recorder, i.e. per run's sink. */
export function createGateTelemetryPreflight(): GateTelemetryPreflight {
  return { verified: false }
}

/**
 * True only when `targetPath` exists AND is a symbolic link. `ENOENT` is the
 * normal first-write case; any other lstat failure rethrows.
 */
function isSymbolicLink(targetPath: string): boolean {
  try {
    return fs.lstatSync(targetPath).isSymbolicLink()
  } catch (err) {
    if (errorCode(err) === 'ENOENT') return false
    throw err
  }
}

/** First symlinked segment of the sink path, else `undefined`. */
function findSymlinkedSegment(projectRoot: string): string | undefined {
  let current = projectRoot
  for (const segment of GATE_TELEMETRY_RELATIVE.split(path.sep)) {
    current = path.join(current, segment)
    if (isSymbolicLink(current)) return current
  }
  return undefined
}

/**
 * Whether `value` is over `maxBytes` UTF-8 BYTES, answered from the code unit
 * count whenever that already decides it (a unit costs at least one byte), which
 * keeps the O(n) measure off pathological multi-MB payloads.
 */
function exceedsByteCap(value: string, maxBytes: number): boolean {
  if (value.length > maxBytes) return true
  return Buffer.byteLength(value, 'utf8') > maxBytes
}

/**
 * Truncate `value` to at most `maxBytes` UTF-8 BYTES, cutting on a code-point
 * boundary so a multi-byte character is kept whole or dropped whole and no
 * replacement character is introduced. Only the first `maxBytes` code units can
 * survive the cap, so the copy stays bounded however long `value` is.
 *
 * Returns `value` ITSELF when it is already within the cap, which makes this the
 * SOLE cap test: a caller detects a clipped field by identity rather than
 * measuring the same (possibly multi-MB) string a second time.
 */
function truncateBytes(value: string, maxBytes: number): string {
  if (!exceedsByteCap(value, maxBytes)) return value
  const buffer = Buffer.from(value.slice(0, maxBytes), 'utf8')
  // Landing on EXACTLY `maxBytes` means every surviving code unit was
  // single-byte, i.e. the cut is already on a code-point boundary. Returning
  // here is what keeps the walk below from reading the out-of-range
  // `buffer[maxBytes]`.
  if (buffer.length <= maxBytes) return buffer.toString('utf8')
  // Cut at `maxBytes`, then walk back over the continuation bytes
  // (`0b10xxxxxx`) of the sequence the cut landed inside.
  let end = maxBytes
  while (end > 0 && (buffer[end] & 0xc0) === 0x80) end -= 1
  return buffer.subarray(0, end).toString('utf8')
}

/**
 * Keys the bounded line writes ITSELF. A payload field of any of these names is
 * DROPPED rather than merged, so the payload cannot forge the truncation signal;
 * the dropped names are reported SORTED under `droppedPayloadKeys`.
 * `originalLineBytes` is included even though only the MARKER line writes it, so
 * a forged size can never sit next to the genuine `truncated: true`.
 */
const GATE_TELEMETRY_OVERRIDDEN_KEYS = new Set([
  'truncated',
  'truncatedFields',
  'truncatedFieldsOmittedCount',
  'droppedPayloadKeys',
  'originalLineBytes',
  'recordedAt',
])

/** Records a top-level field the bounding changed; see `serializeBoundedLine`. */
type NoteTruncatedField = (key: string) => void

/**
 * Step 1: copy `payload` minus the keys the line writes ITSELF (returned for the
 * `droppedPayloadKeys` report), clipping overlong arrays to
 * `GATE_TELEMETRY_MAX_ARRAY_ITEMS` entries plus a derived `<key>OmittedCount`.
 */
function boundArrayItems(
  payload: Record<string, unknown>,
  noteTruncatedField: NoteTruncatedField,
): { bounded: Record<string, unknown>; droppedPayloadKeys: string[] } {
  const bounded: Record<string, unknown> = {}
  const droppedPayloadKeys: string[] = []
  for (const [key, value] of Object.entries(payload)) {
    if (GATE_TELEMETRY_OVERRIDDEN_KEYS.has(key)) {
      droppedPayloadKeys.push(key)
      continue
    }
    if (Array.isArray(value) && value.length > GATE_TELEMETRY_MAX_ARRAY_ITEMS) {
      bounded[key] = value.slice(0, GATE_TELEMETRY_MAX_ARRAY_ITEMS)
      noteTruncatedField(key)
      const omittedKey = `${key}OmittedCount`
      // A payload field of that exact name stays authoritative, and a derived
      // name colliding with a sink-owned key is dropped. OWN keys only, like the
      // `Object.entries` walk above.
      if (
        !Object.prototype.hasOwnProperty.call(payload, omittedKey) &&
        !GATE_TELEMETRY_OVERRIDDEN_KEYS.has(omittedKey)
      ) {
        bounded[omittedKey] = value.length - GATE_TELEMETRY_MAX_ARRAY_ITEMS
      }
      continue
    }
    bounded[key] = value
  }
  return { bounded, droppedPayloadKeys }
}

/**
 * Step 2, mutating `bounded` in place: cap every top-level string and top-level
 * array string ELEMENT over `GATE_TELEMETRY_MAX_FIELD_BYTES` in ONE pass, up to
 * `GATE_TELEMETRY_MAX_CAPPED_FIELDS` fields. Returns how many fields it capped;
 * an array counts as one however many of its elements were cut.
 */
function capOversizedFields(
  bounded: Record<string, unknown>,
  noteTruncatedField: NoteTruncatedField,
): number {
  let cappedFields = 0
  for (const [key, value] of Object.entries(bounded)) {
    if (cappedFields >= GATE_TELEMETRY_MAX_CAPPED_FIELDS) break
    if (typeof value === 'string') {
      // `truncateBytes` is the sole cap test (see its note): it hands back
      // `value` itself for an in-cap field, so the identity check below replaces
      // a second measure of the same hot wide payload.
      const capped = truncateBytes(value, GATE_TELEMETRY_MAX_FIELD_BYTES)
      if (capped === value) continue
      bounded[key] = capped
      cappedFields += 1
      noteTruncatedField(key)
      continue
    }
    if (!Array.isArray(value)) continue
    // Step 1 bounded the item count, so this walks at most
    // `GATE_TELEMETRY_MAX_ARRAY_ITEMS` elements.
    let cappedElement = false
    const cappedItems = value.map((item) => {
      if (typeof item !== 'string') return item
      const cappedItem = truncateBytes(item, GATE_TELEMETRY_MAX_FIELD_BYTES)
      if (cappedItem !== item) cappedElement = true
      return cappedItem
    })
    if (!cappedElement) continue
    bounded[key] = cappedItems
    cappedFields += 1
    noteTruncatedField(key)
  }
  return cappedFields
}

/**
 * Serialize one event as a size-bounded JSONL line, in three escalating steps:
 * `boundArrayItems` (item counts), `capOversizedFields` (per-field bytes), then a
 * marker line keeping just the event name. `truncated: true` is written whenever
 * ANY bounding occurred and OMITTED for a faithful copy; the first two steps also
 * name the changed top-level fields in `truncatedFields`. Both steps reach
 * TOP-LEVEL fields only — a nested object is bounded solely by the marker, which
 * every base2 gate payload being flat makes acceptable.
 */
function serializeBoundedLine(payload: Record<string, unknown>): string {
  // Every top-level field the bounding CHANGED, plus the changed ones
  // `truncatedFields` had no room to NAME (only its SIZE is ever written).
  const truncatedFields = new Set<string>()
  const truncatedFieldsOmitted = new Set<string>()
  const noteTruncatedField: NoteTruncatedField = (key) => {
    if (truncatedFields.has(key)) return
    if (truncatedFields.size < GATE_TELEMETRY_MAX_NAMED_TRUNCATED_FIELDS) {
      truncatedFields.add(key)
      return
    }
    truncatedFieldsOmitted.add(key)
  }
  const { bounded, droppedPayloadKeys } = boundArrayItems(
    payload,
    noteTruncatedField,
  )
  // The sink-owned tail of EVERY line, marker included; the drop report is sorted
  // so it is independent of payload key order.
  const ownedFields = {
    ...(droppedPayloadKeys.length > 0
      ? { droppedPayloadKeys: droppedPayloadKeys.sort() }
      : {}),
    recordedAt: new Date().toISOString(),
  }
  // ONE builder for every non-marker line, so the flag cannot drift between the
  // untruncated and the capped shapes.
  const buildLine = (): string =>
    `${JSON.stringify({
      ...bounded,
      ...(truncatedFields.size > 0
        ? {
            truncated: true,
            truncatedFields: [...truncatedFields],
            ...(truncatedFieldsOmitted.size > 0
              ? { truncatedFieldsOmittedCount: truncatedFieldsOmitted.size }
              : {}),
          }
        : {}),
      ...ownedFields,
    })}\n`
  const line = buildLine()
  // The size of the LAST line the bounding attempted, so the marker reports the
  // line that actually could not be written.
  let attemptedLineBytes = Buffer.byteLength(line)
  if (attemptedLineBytes <= GATE_TELEMETRY_MAX_LINE_BYTES) return line

  // Step 2, then one re-serialization of the capped shape.
  if (capOversizedFields(bounded, noteTruncatedField) > 0) {
    const cappedLine = buildLine()
    attemptedLineBytes = Buffer.byteLength(cappedLine)
    if (attemptedLineBytes <= GATE_TELEMETRY_MAX_LINE_BYTES) return cappedLine
  }
  return `${JSON.stringify({
    event:
      typeof payload.event === 'string'
        ? truncateBytes(payload.event, GATE_TELEMETRY_MAX_MARKER_EVENT_BYTES)
        : 'unknown',
    truncated: true,
    // The FULL size of the LAST line the bounding attempted, not the delta:
    // named so consumers do not read it as "bytes dropped".
    originalLineBytes: attemptedLineBytes,
    ...ownedFields,
  })}\n`
}

/**
 * Append one gate-telemetry event as a JSONL line under
 * `<projectRoot>/.openbuff/telemetry/base2-gate.jsonl`.
 *
 * Never throws — including when `logger.warn` itself throws. Returns true when
 * the line was appended; a blank project root, a symlinked path segment and any
 * filesystem failure return false (the latter two also warn).
 *
 * Passing `preflight` memoizes the mkdir, the rotation `statSync` and the
 * owner-only mode repair for that recorder.
 */
export function appendGateTelemetryEvent(params: {
  projectRoot: string
  payload: Record<string, unknown>
  logger?: Logger
  /** Omit for the per-event-syscall mode described above. */
  preflight?: GateTelemetryPreflight
}): boolean {
  const { projectRoot, payload, logger, preflight } = params
  if (!projectRoot) return false
  const filePath = path.join(projectRoot, GATE_TELEMETRY_RELATIVE)
  const verified = preflight?.verified === true
  // EVERY report goes through here: a logger that throws must neither escape the
  // never-throws contract nor turn an already-written line into a failed append
  // by unwinding into the outer catch, which would re-arm the pre-flight.
  const safeWarn = (data: Record<string, unknown>, msg: string): void => {
    try {
      logger?.warn(data, msg)
    } catch {
      // The contract outranks reporting the failure; the return value still does.
    }
  }
  // Per-append and never memoized, inside the try so any lstat failure other
  // than `ENOENT` fails the append CLOSED: `O_NOFOLLOW` refuses a symlink only in
  // the FINAL component, and `mkdirSync({ recursive: true })` accepts a symlink
  // resolving to a directory. Still check-then-use, so a symlink planted at an
  // INTERMEDIATE segment after the scan is followed; closing that would need an
  // `openat`-style walk Node does not expose.
  try {
    const symlinkedSegment = findSymlinkedSegment(projectRoot)
    if (symlinkedSegment) {
      safeWarn(
        { filePath, symlinkedSegment },
        '[gate-telemetry] A telemetry path segment is a symlink; refusing to write base2 gate telemetry through it.',
      )
      return false
    }
    if (!verified) {
      // `mode` applies only to the directories this call actually creates.
      fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 })
    }
    const line = serializeBoundedLine(payload)
    // Rotation runs BEFORE the append; its semantics and the races it accepts
    // are documented on `GATE_TELEMETRY_MAX_BYTES`.
    let liveBytes = verified ? preflight?.sinkBytes : undefined
    const statIntervalReached =
      (preflight?.appendsSinceStat ?? 0) >= GATE_TELEMETRY_STAT_INTERVAL_APPENDS
    if (statIntervalReached) {
      liveBytes = undefined
    }
    // A rotation that just failed usually keeps failing, so trust the tracked
    // size until the periodic re-stat is due.
    const rotationBackoff =
      preflight?.rotationFailed === true &&
      liveBytes !== undefined &&
      !statIntervalReached
    if (
      !rotationBackoff &&
      (liveBytes === undefined || liveBytes > GATE_TELEMETRY_MAX_BYTES)
    ) {
      // `throwIfNoEntry: false` reports the normal first-write case as
      // `undefined` instead of throwing.
      const sinkStat = fs.statSync(filePath, { throwIfNoEntry: false })
      liveBytes = sinkStat?.size ?? 0
      if (preflight) preflight.appendsSinceStat = 0
      if (liveBytes <= GATE_TELEMETRY_MAX_BYTES) {
        // The live sink is under the bound, so there is no failing rotation left
        // to back off from (another recorder may have rotated it, or it was
        // truncated). Clearing here keeps a stale flag from deferring the NEXT
        // genuinely needed rotation to the following periodic re-stat.
        if (preflight) preflight.rotationFailed = false
      } else {
        const rotatedPath = `${filePath}.1`
        // Its OWN try/catch: the rename can fail where a plain append would still
        // succeed, so this warns and appends to the over-bound file instead of
        // failing the append. `rmSync(force)` keeps the rename cross-platform and
        // caps history at one generation.
        try {
          fs.rmSync(rotatedPath, { force: true })
          fs.renameSync(filePath, rotatedPath)
          liveBytes = 0
          if (preflight) preflight.rotationFailed = false
        } catch (err) {
          if (preflight) preflight.rotationFailed = true
          safeWarn(
            { err, filePath, rotatedPath },
            '[gate-telemetry] Failed to rotate the base2 gate telemetry sink; appending to the over-bound file.',
          )
        }
      }
    }
    const fd = fs.openSync(
      filePath,
      fs.constants.O_APPEND |
        fs.constants.O_CREAT |
        fs.constants.O_WRONLY |
        GATE_TELEMETRY_NOFOLLOW_FLAG,
      0o600,
    )
    try {
      fs.appendFileSync(fd, line)
      // The creation `mode` is honored only on creation, so a sink pre-created (or
      // later widened) keeps its mode. Narrowed through the open `O_NOFOLLOW` fd
      // rather than a post-close `chmodSync`, which could chmod a symlink's
      // target. Its OWN try/catch like the rotation: the line is already written,
      // and failing the append would re-arm the pre-flight. Skipped where
      // `O_NOFOLLOW` is unavailable.
      if (!verified && GATE_TELEMETRY_NOFOLLOW_FLAG !== 0) {
        try {
          fs.fchmodSync(fd, 0o600)
        } catch (err) {
          safeWarn(
            { err, filePath },
            '[gate-telemetry] Failed to narrow base2 gate telemetry sink permissions; the event was still appended.',
          )
        }
      }
    } finally {
      fs.closeSync(fd)
    }
    if (preflight) {
      preflight.verified = true
      preflight.sinkBytes = (liveBytes ?? 0) + Buffer.byteLength(line)
      preflight.appendsSinceStat = (preflight.appendsSinceStat ?? 0) + 1
    }
    return true
  } catch (err) {
    // Re-arm the pre-flight so the next event scans, mkdirs and stats again.
    if (preflight) {
      preflight.verified = false
      preflight.sinkBytes = undefined
      preflight.appendsSinceStat = 0
      preflight.rotationFailed = false
    }
    safeWarn(
      { err, filePath },
      '[gate-telemetry] Failed to append a base2 gate telemetry event; continuing.',
    )
    return false
  }
}
