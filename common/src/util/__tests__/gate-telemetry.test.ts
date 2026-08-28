import fs from 'fs'
import path from 'path'

import { describe, expect, test } from 'bun:test'

import {
  SKIP_EACCES_CASES,
  SKIP_POSIX_MODE_CASES,
  SKIP_SYMLINK_CASES,
  makeGateTelemetryProjectRoot as makeProjectRoot,
  readGateTelemetrySinkLines as readLines,
  readGateTelemetrySinkRaw as readRaw,
} from '../../testing/gate-telemetry-fixtures'
import { createMockLoggerWithCapture } from '../../testing/mocks/logger'
import {
  GATE_TELEMETRY_MAX_ARRAY_ITEMS,
  GATE_TELEMETRY_MAX_BYTES,
  GATE_TELEMETRY_MAX_CAPPED_FIELDS,
  GATE_TELEMETRY_MAX_FIELD_BYTES,
  GATE_TELEMETRY_MAX_LINE_BYTES,
  GATE_TELEMETRY_MAX_MARKER_EVENT_BYTES,
  GATE_TELEMETRY_MAX_NAMED_TRUNCATED_FIELDS,
  GATE_TELEMETRY_RELATIVE,
  GATE_TELEMETRY_STAT_INTERVAL_APPENDS,
  appendGateTelemetryEvent,
  createGateTelemetryPreflight,
} from '../gate-telemetry'

import type { Logger } from '../../types/contracts/logger'

/** One astral character, i.e. a surrogate PAIR of UTF-16 code units. */
const ASTRAL_CHAR = '\u{1F600}'

/**
 * Over the per-field cap, so the capping pass caps it too. ASCII everywhere it
 * is used, so its byte size equals its length.
 */
const OVER_FIELD_CAP_BYTES = GATE_TELEMETRY_MAX_FIELD_BYTES * 2

/**
 * Owner-only means "no group and no other bits". Exact-mode assertions would be
 * environment-dependent: creation modes are masked by the process umask.
 */
function expectOwnerOnly(targetPath: string): void {
  // Windows does not honor POSIX modes; assert only where it is meaningful. The
  // predicate is fixture-owned so this suite and the runtime one cannot drift.
  if (SKIP_POSIX_MODE_CASES) return
  expect(fs.statSync(targetPath).mode & 0o077).toBe(0)
}

describe('appendGateTelemetryEvent sink writes and permissions', () => {
  test('GATE_TELEMETRY_RELATIVE points at the .openbuff telemetry JSONL file', () => {
    expect(GATE_TELEMETRY_RELATIVE).toBe(
      path.join('.openbuff', 'telemetry', 'base2-gate.jsonl'),
    )
  })

  test('appends one JSONL line per event, creating the telemetry directory', () => {
    const projectRoot = makeProjectRoot()
    try {
      appendGateTelemetryEvent({
        projectRoot,
        payload: { event: 'base2.gate', findingCount: 2 },
      })
      appendGateTelemetryEvent({
        projectRoot,
        payload: { event: 'base2.gate', findingCount: 0 },
      })

      const lines = readLines(projectRoot)
      expect(lines).toHaveLength(2)
      const first = JSON.parse(lines[0]) as Record<string, unknown>
      expect(first).toMatchObject({ event: 'base2.gate', findingCount: 2 })
      expect(typeof first.recordedAt).toBe('string')
      expect(Number.isNaN(Date.parse(String(first.recordedAt)))).toBe(false)
      // A faithful copy of the payload carries NO truncation signal at all, so a
      // consumer can key on the single `truncated` flag.
      expect(first.truncated).toBeUndefined()
      expect(first.truncatedFields).toBeUndefined()
      expect(first.truncatedFieldsOmittedCount).toBeUndefined()
      expect(first.droppedPayloadKeys).toBeUndefined()
      expect(JSON.parse(lines[1])).toMatchObject({ findingCount: 0 })
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true })
    }
  })

  test('writes the sink with owner-only permissions', () => {
    const projectRoot = makeProjectRoot()
    try {
      appendGateTelemetryEvent({
        projectRoot,
        payload: { event: 'base2.gate' },
      })
      expectOwnerOnly(path.join(projectRoot, GATE_TELEMETRY_RELATIVE))
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true })
    }
  })

  test('narrows a sink file that already exists with wider permissions', () => {
    const projectRoot = makeProjectRoot()
    try {
      const filePath = path.join(projectRoot, GATE_TELEMETRY_RELATIVE)
      fs.mkdirSync(path.dirname(filePath), { recursive: true })
      fs.writeFileSync(filePath, '')
      fs.chmodSync(filePath, 0o666)

      appendGateTelemetryEvent({
        projectRoot,
        payload: { event: 'base2.gate', round: 1 },
      })

      // The append still happened, and the pre-existing mode was repaired.
      expect(readLines(projectRoot)).toHaveLength(1)
      expectOwnerOnly(filePath)
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true })
    }
  })

  test('keeps an appended line successful when the mode repair itself fails', () => {
    // The repair is skipped entirely where POSIX modes are not honored.
    if (SKIP_POSIX_MODE_CASES) return
    const projectRoot = makeProjectRoot()
    const originalFchmodSync = fs.fchmodSync
    try {
      // A POSIX `fchmod` can fail on an already-written sink (`EPERM` for
      // another uid's file, `ENOTSUP` on some network mounts). The line is
      // already on disk, so that must stay a successful append.
      fs.fchmodSync = () => {
        throw Object.assign(new Error('operation not permitted'), {
          code: 'EPERM',
        })
      }
      const { logger, getByLevel } = createMockLoggerWithCapture()
      const preflight = createGateTelemetryPreflight()

      const appended = appendGateTelemetryEvent({
        projectRoot,
        payload: { event: 'base2.gate', round: 1 },
        logger,
        preflight,
      })

      expect(appended).toBe(true)
      expect(readLines(projectRoot)).toHaveLength(1)
      // The pre-flight is NOT re-armed, so the next event does not re-pay the
      // mkdir/stat syscalls or re-warn.
      expect(preflight.verified).toBe(true)
      const warnings = getByLevel('warn')
      expect(warnings).toHaveLength(1)
      expect(warnings[0].message).toContain('permissions')
      expect(
        (warnings[0].meta?.err as { code?: unknown } | undefined)?.code,
      ).toBe('EPERM')
    } finally {
      fs.fchmodSync = originalFchmodSync
      fs.rmSync(projectRoot, { recursive: true, force: true })
    }
  })

  test('keeps an appended line successful when the mode-repair warn itself throws', () => {
    // The repair, and therefore its warn, is skipped where POSIX modes are not
    // honored.
    if (SKIP_POSIX_MODE_CASES) return
    const projectRoot = makeProjectRoot()
    const originalFchmodSync = fs.fchmodSync
    try {
      fs.fchmodSync = () => {
        throw Object.assign(new Error('operation not permitted'), {
          code: 'EPERM',
        })
      }
      // A logger that throws on the MID-append warn must not unwind past the
      // already-written line: that would fail the append and re-arm the
      // pre-flight even though the event is on disk.
      const throwingLogger: Logger = {
        debug: () => {},
        info: () => {},
        warn: () => {
          throw new Error('logger exploded')
        },
        error: () => {},
      }
      const preflight = createGateTelemetryPreflight()

      let appended: boolean | undefined
      expect(() => {
        appended = appendGateTelemetryEvent({
          projectRoot,
          payload: { event: 'base2.gate', round: 1 },
          logger: throwingLogger,
          preflight,
        })
      }).not.toThrow()

      expect(appended).toBe(true)
      expect(readLines(projectRoot)).toHaveLength(1)
      expect(preflight.verified).toBe(true)
      expect(preflight.sinkBytes).toBeGreaterThan(0)
    } finally {
      fs.fchmodSync = originalFchmodSync
      fs.rmSync(projectRoot, { recursive: true, force: true })
    }
  })

  test('returns early for a missing or blank project root without throwing', () => {
    const { logger, getByLevel } = createMockLoggerWithCapture()
    expect(() =>
      appendGateTelemetryEvent({
        projectRoot: '',
        payload: { event: 'base2.gate' },
        logger,
      }),
    ).not.toThrow()
    expect(() =>
      appendGateTelemetryEvent({
        projectRoot: undefined as unknown as string,
        payload: { event: 'base2.gate' },
        logger,
      }),
    ).not.toThrow()
    // A missing root is not an error condition, so nothing is logged either.
    expect(getByLevel('warn')).toEqual([])
  })

  test('never throws when the logger it reports the failure through throws', () => {
    const projectRoot = makeProjectRoot()
    try {
      // A regular file where the first sink segment belongs makes the
      // per-segment lstat fail with ENOTDIR, so the append takes its reporting
      // path.
      fs.writeFileSync(
        path.join(projectRoot, GATE_TELEMETRY_RELATIVE.split(path.sep)[0]),
        'not-a-directory',
      )
      // A logger that throws on `warn` (a pino serializer on an exotic payload,
      // or a wrapping logger's delegate) must not escape the never-throws
      // contract, and the failure is still reported through the return value.
      const throwingLogger: Logger = {
        debug: () => {},
        info: () => {},
        warn: () => {
          throw new Error('logger exploded')
        },
        error: () => {},
      }
      let appended: boolean | undefined
      expect(() => {
        appended = appendGateTelemetryEvent({
          projectRoot,
          payload: { event: 'base2.gate' },
          logger: throwingLogger,
        })
      }).not.toThrow()
      expect(appended).toBe(false)
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true })
    }
  })

  test('the sink owns recordedAt and a payload key cannot override it', () => {
    const projectRoot = makeProjectRoot()
    try {
      appendGateTelemetryEvent({
        projectRoot,
        payload: { event: 'base2.gate', recordedAt: 'attacker-supplied' },
      })
      const entry = JSON.parse(readLines(projectRoot)[0]) as Record<
        string,
        unknown
      >
      expect(entry.recordedAt).not.toBe('attacker-supplied')
      expect(Number.isNaN(Date.parse(String(entry.recordedAt)))).toBe(false)
      // The discard is OBSERVABLE: the dropped key is named under a sink-owned
      // field, so a consumer can tell the payload carried one that was ignored.
      expect(entry.droppedPayloadKeys).toEqual(['recordedAt'])
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true })
    }
  })

  test('creates the telemetry directory owner-only', () => {
    const projectRoot = makeProjectRoot()
    try {
      appendGateTelemetryEvent({
        projectRoot,
        payload: { event: 'base2.gate' },
      })
      expectOwnerOnly(path.join(projectRoot, '.openbuff', 'telemetry'))
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true })
    }
  })
})

describe('appendGateTelemetryEvent payload bounding', () => {
  test('truncates overlong array fields instead of writing them whole', () => {
    const projectRoot = makeProjectRoot()
    try {
      const pendingFiles = Array.from(
        { length: GATE_TELEMETRY_MAX_ARRAY_ITEMS + 70 },
        (_, i) => `src/file-${i}.ts`,
      )
      appendGateTelemetryEvent({
        projectRoot,
        payload: {
          event: 'base2.gate',
          pendingFileCount: pendingFiles.length,
          pendingFiles,
        },
      })

      const entry = JSON.parse(readLines(projectRoot)[0]) as Record<
        string,
        unknown
      >
      expect(entry.pendingFiles).toHaveLength(GATE_TELEMETRY_MAX_ARRAY_ITEMS)
      expect((entry.pendingFiles as string[])[0]).toBe('src/file-0.ts')
      expect(entry.pendingFilesOmittedCount).toBe(70)
      // Item-bounding IS bounding, so it raises the same single flag a capped
      // string field does and names the clipped field.
      expect(entry.truncated).toBe(true)
      expect(entry.truncatedFields).toEqual(['pendingFiles'])
      // The true size is still recoverable from the untouched scalar field.
      expect(entry.pendingFileCount).toBe(pendingFiles.length)
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true })
    }
  })

  test('keeps a payload-supplied `<key>OmittedCount` instead of clobbering it', () => {
    const projectRoot = makeProjectRoot()
    try {
      const pendingFiles = Array.from(
        { length: GATE_TELEMETRY_MAX_ARRAY_ITEMS + 5 },
        (_, i) => `src/file-${i}.ts`,
      )
      appendGateTelemetryEvent({
        projectRoot,
        payload: {
          event: 'base2.gate',
          pendingFiles,
          // An explicit payload field of the derived name stays authoritative.
          pendingFilesOmittedCount: 1234,
        },
      })

      const entry = JSON.parse(readLines(projectRoot)[0]) as Record<
        string,
        unknown
      >
      expect(entry.pendingFiles).toHaveLength(GATE_TELEMETRY_MAX_ARRAY_ITEMS)
      expect(entry.pendingFilesOmittedCount).toBe(1234)
      expect(entry.truncated).toBe(true)
      expect(entry.truncatedFields).toEqual(['pendingFiles'])
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true })
    }
  })

  test('writes the derived omitted count when the colliding name is only inherited', () => {
    const projectRoot = makeProjectRoot()
    try {
      const pendingFiles = Array.from(
        { length: GATE_TELEMETRY_MAX_ARRAY_ITEMS + 5 },
        (_, i) => `src/file-${i}.ts`,
      )
      // Only the PROTOTYPE carries the derived name, so the own-keys payload
      // walk never saw such a field and the derived count must still be
      // written: the collision guard and that walk share one view of the
      // payload.
      const payload: Record<string, unknown> = Object.create({
        pendingFilesOmittedCount: 1234,
      })
      payload.event = 'base2.gate'
      payload.pendingFiles = pendingFiles

      appendGateTelemetryEvent({ projectRoot, payload })

      const entry = JSON.parse(readLines(projectRoot)[0]) as Record<
        string,
        unknown
      >
      expect(entry.pendingFiles).toHaveLength(GATE_TELEMETRY_MAX_ARRAY_ITEMS)
      expect(entry.pendingFilesOmittedCount).toBe(5)
      expect(entry.truncated).toBe(true)
      expect(entry.truncatedFields).toEqual(['pendingFiles'])
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true })
    }
  })

  test('drops a derived omitted count that would collide with a sink-owned key', () => {
    const projectRoot = makeProjectRoot()
    try {
      // `truncatedFieldsOmitted` derives `truncatedFieldsOmittedCount`, which
      // the line writes ITSELF: the derived count must be dropped rather than
      // sat beside (or in place of) the genuine sink-owned one.
      appendGateTelemetryEvent({
        projectRoot,
        payload: {
          event: 'base2.gate',
          truncatedFieldsOmitted: Array.from(
            { length: GATE_TELEMETRY_MAX_ARRAY_ITEMS + 3 },
            () => 'a',
          ),
        },
      })

      const entry = JSON.parse(readLines(projectRoot)[0]) as Record<
        string,
        unknown
      >
      // The array itself is an ordinary payload field, so it is still
      // item-bounded and named.
      expect(entry.truncatedFieldsOmitted).toHaveLength(
        GATE_TELEMETRY_MAX_ARRAY_ITEMS,
      )
      expect(entry.truncatedFields).toEqual(['truncatedFieldsOmitted'])
      // Only 1 clipped field, and the name list had room for it, so no
      // sink-owned omitted count is written and the derived one is not forged in
      // its place.
      expect(entry.truncatedFieldsOmittedCount).toBeUndefined()
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true })
    }
  })

  test('caps the element count of `truncatedFields` itself', () => {
    const projectRoot = makeProjectRoot()
    try {
      // More clipped fields than `truncatedFields` may name, while every value
      // is small enough that the line still FITS: without an explicit element
      // cap the report itself would grow with the payload's width instead of
      // being bounded only indirectly by the line falling back to the marker.
      const clippedFieldCount = GATE_TELEMETRY_MAX_NAMED_TRUNCATED_FIELDS + 6
      const wide: Record<string, unknown> = {}
      for (let i = 0; i < clippedFieldCount; i += 1) {
        wide[`arr${i}`] = Array.from(
          { length: GATE_TELEMETRY_MAX_ARRAY_ITEMS + 1 },
          () => 'a',
        )
      }
      appendGateTelemetryEvent({
        projectRoot,
        payload: { event: 'base2.gate', ...wide },
      })

      const lines = readLines(projectRoot)
      expect(lines).toHaveLength(1)
      expect(Buffer.byteLength(`${lines[0]}\n`)).toBeLessThanOrEqual(
        GATE_TELEMETRY_MAX_LINE_BYTES,
      )
      const entry = JSON.parse(lines[0]) as Record<string, unknown>
      // NOT the marker shape: the fields are all still there, item-bounded.
      expect(entry.event).toBe('base2.gate')
      expect(entry.truncated).toBe(true)
      expect(entry.truncatedFields).toHaveLength(
        GATE_TELEMETRY_MAX_NAMED_TRUNCATED_FIELDS,
      )
      // The name list says so when it is NOT exhaustive, so a consumer cannot
      // read the capped list as the complete set of clipped fields.
      expect(entry.truncatedFieldsOmittedCount).toBe(
        clippedFieldCount - GATE_TELEMETRY_MAX_NAMED_TRUNCATED_FIELDS,
      )
      // A field past the naming cap is still CLIPPED, just no longer named: the
      // bound is on the report, not on the bounding.
      expect(entry[`arr${clippedFieldCount - 1}`]).toHaveLength(
        GATE_TELEMETRY_MAX_ARRAY_ITEMS,
      )
      expect(entry[`arr${clippedFieldCount - 1}OmittedCount`]).toBe(1)
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true })
    }
  })

  test('caps one oversized string field so the useful scalars survive', () => {
    const projectRoot = makeProjectRoot()
    try {
      appendGateTelemetryEvent({
        projectRoot,
        payload: {
          event: 'base2.gate',
          gate: 'review',
          status: 'blocked',
          repairRound: 3,
          pendingFileCount: 4,
          details: 'x'.repeat(GATE_TELEMETRY_MAX_LINE_BYTES + 1),
        },
      })

      const lines = readLines(projectRoot)
      expect(lines).toHaveLength(1)
      expect(Buffer.byteLength(`${lines[0]}\n`)).toBeLessThanOrEqual(
        GATE_TELEMETRY_MAX_LINE_BYTES,
      )
      const entry = JSON.parse(lines[0]) as Record<string, unknown>
      // The scalars a consumer actually reads are NOT dropped by the bounding.
      expect(entry).toMatchObject({
        event: 'base2.gate',
        gate: 'review',
        status: 'blocked',
        repairRound: 3,
        pendingFileCount: 4,
        truncated: true,
      })
      expect(entry.truncatedFields).toEqual(['details'])
      expect(entry.details).toBe('x'.repeat(GATE_TELEMETRY_MAX_FIELD_BYTES))
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true })
    }
  })

  test('caps every over-length string field in one pass, leaving the rest intact', () => {
    const projectRoot = makeProjectRoot()
    try {
      // The capping pass is order-independent: every top-level string over the
      // per-field cap is capped, and a field already within it is untouched.
      appendGateTelemetryEvent({
        projectRoot,
        payload: {
          event: 'base2.gate',
          gate: 'review',
          biggest: 'x'.repeat(GATE_TELEMETRY_MAX_LINE_BYTES),
          mid: 'y'.repeat(OVER_FIELD_CAP_BYTES),
          short: 'z'.repeat(10),
        },
      })

      const lines = readLines(projectRoot)
      expect(lines).toHaveLength(1)
      expect(Buffer.byteLength(`${lines[0]}\n`)).toBeLessThanOrEqual(
        GATE_TELEMETRY_MAX_LINE_BYTES,
      )
      const entry = JSON.parse(lines[0]) as Record<string, unknown>
      expect(entry.truncatedFields).toEqual(['biggest', 'mid'])
      // Every clipped field is NAMED here, so the omitted-count field is absent
      // rather than reporting a zero a consumer would have to interpret.
      expect(entry.truncatedFieldsOmittedCount).toBeUndefined()
      expect(entry.biggest).toBe('x'.repeat(GATE_TELEMETRY_MAX_FIELD_BYTES))
      expect(entry.mid).toBe('y'.repeat(GATE_TELEMETRY_MAX_FIELD_BYTES))
      // Under the per-field cap already, so neither capped nor named.
      expect(entry.short).toBe('z'.repeat(10))
      expect(entry.gate).toBe('review')
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true })
    }
  })

  test('measures multi-byte capped fields in BYTES, not code units', () => {
    const projectRoot = makeProjectRoot()
    try {
      // The per-field cap is in BYTES. A two-byte-per-character field is where a
      // code-unit view would drift: `biggest` costs twice its length in bytes,
      // so a code-unit cap would leave 4 KB where the byte cap leaves 2 KB.
      appendGateTelemetryEvent({
        projectRoot,
        payload: {
          event: 'base2.gate',
          gate: 'review',
          biggest: '\u00e9'.repeat(GATE_TELEMETRY_MAX_LINE_BYTES),
          mid: 'y'.repeat(OVER_FIELD_CAP_BYTES),
        },
      })

      const lines = readLines(projectRoot)
      expect(lines).toHaveLength(1)
      expect(Buffer.byteLength(`${lines[0]}\n`)).toBeLessThanOrEqual(
        GATE_TELEMETRY_MAX_LINE_BYTES,
      )
      const entry = JSON.parse(lines[0]) as Record<string, unknown>
      expect(entry.truncatedFields).toEqual(['biggest', 'mid'])
      // Half as many CHARACTERS as the cap, because each costs two bytes.
      expect(entry.biggest).toBe(
        '\u00e9'.repeat(GATE_TELEMETRY_MAX_FIELD_BYTES / 2),
      )
      expect(Buffer.byteLength(entry.biggest as string)).toBe(
        GATE_TELEMETRY_MAX_FIELD_BYTES,
      )
      // ASCII, so the same byte cap leaves that many characters.
      expect(entry.mid).toBe('y'.repeat(GATE_TELEMETRY_MAX_FIELD_BYTES))
      expect(entry.gate).toBe('review')
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true })
    }
  })

  test('a wide 4-byte-per-character payload is capped in bytes instead of falling back to the marker', () => {
    const projectRoot = makeProjectRoot()
    try {
      // Ten fields of ASTRAL (4-byte) characters, each 8 KB. A cap in UTF-16
      // CODE UNITS would leave every capped field at ~4 KB (2,000 code units =
      // 1,000 astral characters), i.e. ~40 KB in total — STILL over the line
      // bound, so the whole-line marker would drop every scalar. The byte-aware
      // cap leaves 2 KB per field, the line fits, and the scalars survive.
      const wide: Record<string, string> = {}
      for (let i = 0; i < 10; i += 1) {
        wide[`detail${i}`] = ASTRAL_CHAR.repeat(GATE_TELEMETRY_MAX_FIELD_BYTES)
      }
      appendGateTelemetryEvent({
        projectRoot,
        payload: { event: 'base2.gate', gate: 'review', ...wide },
      })

      const lines = readLines(projectRoot)
      expect(lines).toHaveLength(1)
      expect(Buffer.byteLength(`${lines[0]}\n`)).toBeLessThanOrEqual(
        GATE_TELEMETRY_MAX_LINE_BYTES,
      )
      const entry = JSON.parse(lines[0]) as Record<string, unknown>
      // NOT the marker shape: the scalars a consumer reads are still there.
      expect(entry).toMatchObject({
        event: 'base2.gate',
        gate: 'review',
        truncated: true,
      })
      expect(entry.originalLineBytes).toBeUndefined()
      const cappedKeys = entry.truncatedFields as string[]
      expect(cappedKeys.length).toBeGreaterThan(0)
      for (const key of cappedKeys) {
        const value = entry[key] as string
        expect(Buffer.byteLength(value)).toBe(GATE_TELEMETRY_MAX_FIELD_BYTES)
        // Cut on a code-point boundary: whole astral characters only.
        expect(value).toBe(ASTRAL_CHAR.repeat(value.length / 2))
      }
      // No lone surrogate half (`\udXXX`) and no replacement character.
      expect(readRaw(projectRoot)).not.toContain('\\ud')
      expect(readRaw(projectRoot)).not.toContain('\ufffd')
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true })
    }
  })

  test('the per-field byte cap is inclusive at its exact boundary', () => {
    const projectRoot = makeProjectRoot()
    try {
      // Per-field capping only runs for a line that is ALREADY over the line
      // bound, so drive one: ten ASCII fields of twice the field cap. Each gets
      // sliced to a prefix encoding to EXACTLY the cap, which is where the
      // byte-cut walk would index one past the encoded prefix. `atCap` sits
      // exactly AT the cap, so the descending walk stops before reaching it.
      const over: Record<string, string> = {}
      for (let i = 0; i < 10; i += 1) {
        over[`over${i}`] = 'b'.repeat(GATE_TELEMETRY_MAX_FIELD_BYTES * 2)
      }
      appendGateTelemetryEvent({
        projectRoot,
        payload: {
          event: 'base2.gate',
          gate: 'review',
          atCap: 'a'.repeat(GATE_TELEMETRY_MAX_FIELD_BYTES),
          ...over,
        },
      })

      const lines = readLines(projectRoot)
      expect(lines).toHaveLength(1)
      expect(Buffer.byteLength(`${lines[0]}\n`)).toBeLessThanOrEqual(
        GATE_TELEMETRY_MAX_LINE_BYTES,
      )
      const entry = JSON.parse(lines[0]) as Record<string, unknown>
      // Capped, NOT collapsed to the marker: the scalars still survive.
      expect(entry).toMatchObject({ event: 'base2.gate', gate: 'review' })
      expect(entry.originalLineBytes).toBeUndefined()
      const cappedKeys = entry.truncatedFields as string[]
      expect(cappedKeys.length).toBeGreaterThan(0)
      for (const key of cappedKeys) {
        // Exactly the cap, cut on the boundary the walk must not read past.
        expect(entry[key]).toBe('b'.repeat(GATE_TELEMETRY_MAX_FIELD_BYTES))
      }
      // Exactly AT the cap is not OVER it: untouched and unreported.
      expect(cappedKeys).not.toContain('atCap')
      expect(entry.atCap).toBe('a'.repeat(GATE_TELEMETRY_MAX_FIELD_BYTES))
      expect(readRaw(projectRoot)).not.toContain('\ufffd')
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true })
    }
  })

  test('drops a payload field the line overrides instead of mis-signaling truncation', () => {
    const projectRoot = makeProjectRoot()
    try {
      // `truncated` is one of the keys the sink writes ITSELF, so a payload
      // field of that name is dropped while bounding rather than merged.
      // Dropping it is already enough to bound the line, so nothing that reaches
      // the output was truncated — and the flag must therefore be absent rather
      // than claiming a truncation with an empty `truncatedFields`.
      appendGateTelemetryEvent({
        projectRoot,
        payload: {
          event: 'base2.gate',
          gate: 'review',
          truncated: 'x'.repeat(GATE_TELEMETRY_MAX_LINE_BYTES + 1),
        },
      })

      const lines = readLines(projectRoot)
      expect(lines).toHaveLength(1)
      expect(Buffer.byteLength(`${lines[0]}\n`)).toBeLessThanOrEqual(
        GATE_TELEMETRY_MAX_LINE_BYTES,
      )
      const entry = JSON.parse(lines[0]) as Record<string, unknown>
      // The payload's forged value never reaches the line, and the scalars
      // survive.
      expect(entry.truncated).toBeUndefined()
      expect(entry.truncatedFields).toBeUndefined()
      // The drop is still observable, under a sink-owned field the payload
      // cannot forge either: a consumer sees WHICH key was discarded without
      // reading it as a truncation of the data that WAS written.
      expect(entry.droppedPayloadKeys).toEqual(['truncated'])
      expect(entry.gate).toBe('review')
      expect(entry.originalLineBytes).toBeUndefined()
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true })
    }
  })

  test('reports every dropped override key, marker line included', () => {
    const projectRoot = makeProjectRoot()
    try {
      // Every sink-owned name at once, plus a nested (hence unbounded) field
      // that forces the marker path: the drop report rides on the marker too, so
      // the most lossy shape is not also the least diagnosable one.
      appendGateTelemetryEvent({
        projectRoot,
        payload: {
          event: 'base2.gate',
          truncated: 'forged',
          truncatedFields: ['forged'],
          truncatedFieldsOmittedCount: 99,
          droppedPayloadKeys: ['forged'],
          originalLineBytes: 12,
          recordedAt: 'attacker-supplied',
          findings: {
            items: Array.from({ length: 10_000 }, (_, i) => `finding-${i}`),
          },
        },
      })

      const lines = readLines(projectRoot)
      expect(lines).toHaveLength(1)
      expect(Buffer.byteLength(`${lines[0]}\n`)).toBeLessThanOrEqual(
        GATE_TELEMETRY_MAX_LINE_BYTES,
      )
      const entry = JSON.parse(lines[0]) as Record<string, unknown>
      // Sorted by the sink, so a reordered payload cannot fail this for a
      // non-behavioral reason.
      expect(entry.droppedPayloadKeys).toEqual([
        'droppedPayloadKeys',
        'originalLineBytes',
        'recordedAt',
        'truncated',
        'truncatedFields',
        'truncatedFieldsOmittedCount',
      ])
      // Sink-owned like the rest of the report, so the forged count never
      // reaches the marker line either.
      expect(entry.truncatedFieldsOmittedCount).toBeUndefined()
      // Sink-owned values throughout, not the forged ones.
      expect(entry.truncated).toBe(true)
      expect(entry.event).toBe('base2.gate')
      expect(Number.isNaN(Date.parse(String(entry.recordedAt)))).toBe(false)
      expect(entry.originalLineBytes).toBeGreaterThan(
        GATE_TELEMETRY_MAX_LINE_BYTES,
      )
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true })
    }
  })

  test('caps at most GATE_TELEMETRY_MAX_CAPPED_FIELDS string fields but stays bounded', () => {
    const projectRoot = makeProjectRoot()
    try {
      // A pathologically WIDE payload: more string fields than the pass caps,
      // each over the per-field cap, and sized so the fields left BEYOND the cap
      // still exceed the line bound on their own. The pass therefore cannot
      // rescue this line, which is what makes falling back to the marker safe.
      const uncappedCount = 50
      const fieldChars = GATE_TELEMETRY_MAX_FIELD_BYTES + 500
      const fieldCount = GATE_TELEMETRY_MAX_CAPPED_FIELDS + uncappedCount
      // The real intent of the pass cap, expressed against the sizes this
      // payload supplies rather than restating the constant: the payload is
      // wider than the pass, and what the pass leaves untouched is over the line
      // bound by itself.
      expect(GATE_TELEMETRY_MAX_CAPPED_FIELDS).toBeLessThan(fieldCount)
      expect(uncappedCount * fieldChars).toBeGreaterThan(
        GATE_TELEMETRY_MAX_LINE_BYTES,
      )
      const wide: Record<string, unknown> = {}
      for (let i = 0; i < fieldCount; i += 1) {
        wide[`detail${i}`] = 'x'.repeat(fieldChars)
      }
      appendGateTelemetryEvent({
        projectRoot,
        payload: { event: 'base2.gate', ...wide },
      })

      const lines = readLines(projectRoot)
      expect(lines).toHaveLength(1)
      // The hard line bound still holds; the un-capped fields are dropped by the
      // whole-line marker rather than left unbounded.
      expect(Buffer.byteLength(`${lines[0]}\n`)).toBeLessThanOrEqual(
        GATE_TELEMETRY_MAX_LINE_BYTES,
      )
      const entry = JSON.parse(lines[0]) as Record<string, unknown>
      expect(entry).toMatchObject({ event: 'base2.gate', truncated: true })
      expect(entry.originalLineBytes).toBeGreaterThan(
        GATE_TELEMETRY_MAX_LINE_BYTES,
      )
      // `originalLineBytes` describes the LAST line the bounding attempted, not
      // the pre-cap one: the pass had already capped
      // GATE_TELEMETRY_MAX_CAPPED_FIELDS fields when it gave up, so the reported
      // size is below even the raw field bytes of the payload.
      expect(entry.originalLineBytes).toBeLessThan(fieldCount * fieldChars)
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true })
    }
  })

  test('capping a field never leaves a lone surrogate half in the JSONL', () => {
    const projectRoot = makeProjectRoot()
    try {
      // The leading ASCII character puts every astral character at an offset
      // where the byte cap lands INSIDE its 4-byte sequence, so a plain byte
      // slice would emit a broken sequence (and a code-unit slice a lone high
      // surrogate).
      const details = `x${ASTRAL_CHAR.repeat(GATE_TELEMETRY_MAX_LINE_BYTES)}`
      appendGateTelemetryEvent({
        projectRoot,
        payload: { event: 'base2.gate', details },
      })

      // A lone surrogate is serialized as an escape (`\udXXX`); a well-formed
      // pair is written as the character itself. A byte cut inside a sequence
      // would decode to the replacement character instead.
      expect(readRaw(projectRoot)).not.toContain('\\ud')
      expect(readRaw(projectRoot)).not.toContain('\ufffd')
      const entry = JSON.parse(readLines(projectRoot)[0]) as Record<
        string,
        unknown
      >
      expect(entry.truncatedFields).toEqual(['details'])
      const capped = entry.details as string
      // A PREFIX of the original, cut on a code-point boundary: the straddling
      // astral character is dropped whole rather than half-written.
      expect(capped).toBe(details.slice(0, capped.length))
      expect(capped.endsWith(ASTRAL_CHAR)).toBe(true)
      // Under the byte cap, and within one astral character of it.
      expect(Buffer.byteLength(capped)).toBeLessThanOrEqual(
        GATE_TELEMETRY_MAX_FIELD_BYTES,
      )
      expect(Buffer.byteLength(capped)).toBeGreaterThan(
        GATE_TELEMETRY_MAX_FIELD_BYTES - 4,
      )
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true })
    }
  })

  test('bounds the marker line even when `event` itself is the oversized field', () => {
    const projectRoot = makeProjectRoot()
    try {
      appendGateTelemetryEvent({
        projectRoot,
        payload: {
          event: 'e'.repeat(GATE_TELEMETRY_MAX_LINE_BYTES + 1),
          // A nested (hence unbounded) field keeps the per-field cap from
          // rescuing this line, so the marker path is what runs.
          findings: {
            items: Array.from({ length: 10_000 }, (_, i) => `finding-${i}`),
          },
        },
      })

      const lines = readLines(projectRoot)
      expect(lines).toHaveLength(1)
      // The marker interpolates `event`, so an unbounded copy would itself be
      // over the cap.
      expect(Buffer.byteLength(`${lines[0]}\n`)).toBeLessThanOrEqual(
        GATE_TELEMETRY_MAX_LINE_BYTES,
      )
      const entry = JSON.parse(lines[0]) as Record<string, unknown>
      expect(entry.truncated).toBe(true)
      // The marker `event` is cut in BYTES, the unit every other bound uses.
      expect(Buffer.byteLength(entry.event as string)).toBeLessThanOrEqual(
        GATE_TELEMETRY_MAX_MARKER_EVENT_BYTES,
      )
      expect(entry.event).toBe(
        'e'.repeat(GATE_TELEMETRY_MAX_MARKER_EVENT_BYTES),
      )
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true })
    }
  })

  test('the marker `event` is also cut on a code-point boundary', () => {
    const projectRoot = makeProjectRoot()
    try {
      // The leading ASCII character puts every astral character at an offset
      // where the byte cap lands INSIDE its 4-byte sequence, so a plain byte
      // slice would emit a broken sequence.
      const event = `e${ASTRAL_CHAR.repeat(5_000)}`
      appendGateTelemetryEvent({
        projectRoot,
        payload: {
          event,
          findings: {
            items: Array.from({ length: 10_000 }, (_, i) => `finding-${i}`),
          },
        },
      })

      expect(readRaw(projectRoot)).not.toContain('\\ud')
      expect(readRaw(projectRoot)).not.toContain('\ufffd')
      const entry = JSON.parse(readLines(projectRoot)[0]) as Record<
        string,
        unknown
      >
      expect(entry.truncated).toBe(true)
      expect(entry.findings).toBeUndefined()
      const marker = entry.event as string
      // A PREFIX of the original, cut on a code-point boundary: the straddling
      // astral character is dropped whole rather than half-written.
      expect(marker).toBe(event.slice(0, marker.length))
      expect(marker.endsWith(ASTRAL_CHAR)).toBe(true)
      // Under the byte cap, and within one astral character of it.
      expect(Buffer.byteLength(marker)).toBeLessThanOrEqual(
        GATE_TELEMETRY_MAX_MARKER_EVENT_BYTES,
      )
      expect(Buffer.byteLength(marker)).toBeGreaterThan(
        GATE_TELEMETRY_MAX_MARKER_EVENT_BYTES - 4,
      )
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true })
    }
  })

  test('drops a payload `originalLineBytes` on a line that is not a marker', () => {
    const projectRoot = makeProjectRoot()
    try {
      // `originalLineBytes` is sink-owned on the marker line, so a payload field
      // of that name must not survive on a CAPPED line either: it would sit a
      // forged size next to the genuine sink-written `truncated: true`.
      appendGateTelemetryEvent({
        projectRoot,
        payload: {
          event: 'base2.gate',
          gate: 'review',
          originalLineBytes: 12,
          details: 'x'.repeat(GATE_TELEMETRY_MAX_LINE_BYTES + 1),
        },
      })

      const lines = readLines(projectRoot)
      expect(lines).toHaveLength(1)
      expect(Buffer.byteLength(`${lines[0]}\n`)).toBeLessThanOrEqual(
        GATE_TELEMETRY_MAX_LINE_BYTES,
      )
      const entry = JSON.parse(lines[0]) as Record<string, unknown>
      // The capped line reports the cap it applied, and no payload-supplied size
      // beside it.
      expect(entry.truncated).toBe(true)
      expect(entry.truncatedFields).toEqual(['details'])
      expect(entry.originalLineBytes).toBeUndefined()
      expect(entry.droppedPayloadKeys).toEqual(['originalLineBytes'])
      expect(entry.gate).toBe('review')
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true })
    }
  })

  test('a non-string `event` becomes `unknown` on the marker line', () => {
    const projectRoot = makeProjectRoot()
    try {
      appendGateTelemetryEvent({
        projectRoot,
        payload: {
          // Not a string, so the marker cannot copy (or truncate) it.
          event: 42,
          // A nested (hence unbounded) field keeps the per-field cap from
          // rescuing this line, so the marker path is what runs.
          findings: {
            items: Array.from({ length: 10_000 }, (_, i) => `finding-${i}`),
          },
        },
      })

      const lines = readLines(projectRoot)
      expect(lines).toHaveLength(1)
      expect(Buffer.byteLength(`${lines[0]}\n`)).toBeLessThanOrEqual(
        GATE_TELEMETRY_MAX_LINE_BYTES,
      )
      const entry = JSON.parse(lines[0]) as Record<string, unknown>
      expect(entry.event).toBe('unknown')
      expect(entry.truncated).toBe(true)
      expect(entry.findings).toBeUndefined()
      expect(entry.originalLineBytes).toBeGreaterThan(
        GATE_TELEMETRY_MAX_LINE_BYTES,
      )
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true })
    }
  })

  test('a nested array field is not item-bounded and falls back to the marker line', () => {
    const projectRoot = makeProjectRoot()
    try {
      // Documents the intentional top-level-only scope of the array bounding:
      // base2 gate payloads are flat, so a nested array is only size-bounded by
      // the whole-line marker, which keeps the event name and drops the fields.
      const items = Array.from({ length: 10_000 }, (_, i) => `finding-${i}`)
      appendGateTelemetryEvent({
        projectRoot,
        payload: {
          event: 'base2.gate',
          findings: { items },
        },
      })

      const lines = readLines(projectRoot)
      expect(lines).toHaveLength(1)
      expect(Buffer.byteLength(`${lines[0]}\n`)).toBeLessThanOrEqual(
        GATE_TELEMETRY_MAX_LINE_BYTES,
      )
      const entry = JSON.parse(lines[0]) as Record<string, unknown>
      expect(entry).toMatchObject({ event: 'base2.gate', truncated: true })
      expect(entry.findings).toBeUndefined()
      // `originalLineBytes` is the FULL size of the line that could not be
      // written, not the delta the old `droppedBytes` name suggested.
      expect(entry.originalLineBytes).toBeGreaterThanOrEqual(
        Buffer.byteLength(JSON.stringify(items)),
      )
      expect(entry.originalLineBytes).toBeGreaterThan(
        Buffer.byteLength(`${lines[0]}\n`),
      )
      expect(entry.droppedBytes).toBeUndefined()
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true })
    }
  })

  test('caps the string ELEMENTS of a top-level array instead of dropping the line', () => {
    const projectRoot = makeProjectRoot()
    try {
      // A realistic `pendingFiles` shape: long paths, under the ITEM cap so step
      // 1 leaves the array alone. Sized so the RAW line is over the line bound
      // while the element-capped line fits, which is exactly what the element cap
      // buys over falling through to the whole-line marker.
      const itemCount = 14
      const pendingFiles = Array.from(
        { length: itemCount },
        (_, i) => `src/${'deep-dir/'.repeat(450)}file-${i}.ts`,
      )
      expect(itemCount).toBeLessThanOrEqual(GATE_TELEMETRY_MAX_ARRAY_ITEMS)
      expect(Buffer.byteLength(JSON.stringify(pendingFiles))).toBeGreaterThan(
        GATE_TELEMETRY_MAX_LINE_BYTES,
      )
      expect(itemCount * GATE_TELEMETRY_MAX_FIELD_BYTES).toBeLessThan(
        GATE_TELEMETRY_MAX_LINE_BYTES,
      )
      appendGateTelemetryEvent({
        projectRoot,
        payload: {
          event: 'base2.gate',
          gate: 'review',
          // Short and non-string elements are left exactly as they are, so the
          // pass reports only the array it actually changed.
          roundCounts: [1, 2, 3],
          pendingFiles,
        },
      })

      const lines = readLines(projectRoot)
      expect(lines).toHaveLength(1)
      expect(Buffer.byteLength(`${lines[0]}\n`)).toBeLessThanOrEqual(
        GATE_TELEMETRY_MAX_LINE_BYTES,
      )
      const entry = JSON.parse(lines[0]) as Record<string, unknown>
      // The scalars the capping pass exists to preserve survive, and the array
      // is named ONCE however many of its elements were cut.
      expect(entry).toMatchObject({
        event: 'base2.gate',
        gate: 'review',
        truncated: true,
      })
      expect(entry.truncatedFields).toEqual(['pendingFiles'])
      expect(entry.roundCounts).toEqual([1, 2, 3])
      // Not a marker line: `originalLineBytes` belongs to the marker alone.
      expect(entry.originalLineBytes).toBeUndefined()
      // Item bounding did NOT run, so no derived omitted count either.
      expect(entry.pendingFilesOmittedCount).toBeUndefined()
      const capped = entry.pendingFiles as string[]
      expect(capped).toHaveLength(itemCount)
      capped.forEach((element, i) => {
        // A byte-capped PREFIX of the original path, not a dropped element.
        expect(Buffer.byteLength(element)).toBeLessThanOrEqual(
          GATE_TELEMETRY_MAX_FIELD_BYTES,
        )
        expect(Buffer.byteLength(element)).toBeGreaterThan(
          GATE_TELEMETRY_MAX_FIELD_BYTES - 4,
        )
        expect(pendingFiles[i].startsWith(element)).toBe(true)
      })
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true })
    }
  })

  test('an array whose capped elements still exceed the line bound falls back to the marker', () => {
    const projectRoot = makeProjectRoot()
    try {
      // The pathological end of the element cap: GATE_TELEMETRY_MAX_ARRAY_ITEMS
      // elements at the per-field cap are far over the line bound, so even a
      // fully element-capped line cannot be written and the marker still drops
      // the scalars along with the array.
      const pendingFiles = Array.from(
        { length: GATE_TELEMETRY_MAX_ARRAY_ITEMS },
        (_, i) => `src/${'d'.repeat(OVER_FIELD_CAP_BYTES)}/file-${i}.ts`,
      )
      expect(
        GATE_TELEMETRY_MAX_ARRAY_ITEMS * GATE_TELEMETRY_MAX_FIELD_BYTES,
      ).toBeGreaterThan(GATE_TELEMETRY_MAX_LINE_BYTES)
      appendGateTelemetryEvent({
        projectRoot,
        payload: { event: 'base2.gate', gate: 'review', pendingFiles },
      })

      const lines = readLines(projectRoot)
      expect(lines).toHaveLength(1)
      expect(Buffer.byteLength(`${lines[0]}\n`)).toBeLessThanOrEqual(
        GATE_TELEMETRY_MAX_LINE_BYTES,
      )
      const entry = JSON.parse(lines[0]) as Record<string, unknown>
      expect(entry).toMatchObject({ event: 'base2.gate', truncated: true })
      expect(entry.gate).toBeUndefined()
      expect(entry.pendingFiles).toBeUndefined()
      // `originalLineBytes` is the LAST line the bounding attempted, i.e. the
      // element-capped one, so it sits between the line bound and the raw size.
      expect(entry.originalLineBytes).toBeGreaterThan(
        GATE_TELEMETRY_MAX_LINE_BYTES,
      )
      expect(entry.originalLineBytes).toBeLessThan(
        Buffer.byteLength(JSON.stringify(pendingFiles)),
      )
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true })
    }
  })

  test('fails the append and re-arms the preflight for a payload JSON.stringify rejects', () => {
    const projectRoot = makeProjectRoot()
    try {
      const preflight = createGateTelemetryPreflight()
      expect(
        appendGateTelemetryEvent({
          projectRoot,
          payload: { event: 'base2.gate', round: 1 },
          preflight,
        }),
      ).toBe(true)
      expect(preflight.verified).toBe(true)

      // `JSON.stringify` THROWS on a BigInt value, inside the bounding pass, so
      // the failure lands in the OUTER catch rather than writing a partial line:
      // that must stay a reported, non-throwing failed append.
      const { logger, getByLevel } = createMockLoggerWithCapture()
      let appended: boolean | undefined
      expect(() => {
        appended = appendGateTelemetryEvent({
          projectRoot,
          payload: { event: 'base2.gate', round: 2, total: BigInt(3) },
          logger,
          preflight,
        })
      }).not.toThrow()

      expect(appended).toBe(false)
      const warnings = getByLevel('warn')
      expect(warnings).toHaveLength(1)
      expect(warnings[0].message).toContain('Failed to append')
      // Re-armed, so the next event scans, mkdirs and stats again.
      expect(preflight.verified).toBe(false)
      expect(preflight.sinkBytes).toBeUndefined()
      expect(preflight.appendsSinceStat).toBe(0)
      // Nothing was written for the rejected payload.
      const lines = readLines(projectRoot)
      expect(lines).toHaveLength(1)
      expect(JSON.parse(lines[0])).toMatchObject({ round: 1 })

      // A circular reference is the same failure mode, and a serializable
      // payload still appends afterwards.
      const circular: Record<string, unknown> = { event: 'base2.gate' }
      circular.self = circular
      expect(
        appendGateTelemetryEvent({
          projectRoot,
          payload: circular,
          logger,
          preflight,
        }),
      ).toBe(false)
      expect(getByLevel('warn')).toHaveLength(2)
      expect(preflight.verified).toBe(false)

      expect(
        appendGateTelemetryEvent({
          projectRoot,
          payload: { event: 'base2.gate', round: 3 },
          logger,
          preflight,
        }),
      ).toBe(true)
      expect(getByLevel('warn')).toHaveLength(2)
      const recovered = readLines(projectRoot)
      expect(recovered).toHaveLength(2)
      expect(JSON.parse(recovered[1])).toMatchObject({ round: 3 })
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true })
    }
  })
})

describe('appendGateTelemetryEvent path refusals, rotation and preflight memo', () => {
  test('bails with a warn when the sink path is a symlink, writing nothing through it', () => {
    if (SKIP_SYMLINK_CASES) return
    const projectRoot = makeProjectRoot()
    try {
      const decoyPath = path.join(projectRoot, 'decoy.jsonl')
      fs.writeFileSync(decoyPath, '')
      fs.mkdirSync(path.join(projectRoot, '.openbuff', 'telemetry'), {
        recursive: true,
      })
      fs.symlinkSync(decoyPath, path.join(projectRoot, GATE_TELEMETRY_RELATIVE))

      const { logger, getByLevel } = createMockLoggerWithCapture()
      expect(() =>
        appendGateTelemetryEvent({
          projectRoot,
          payload: { event: 'base2.gate' },
          logger,
        }),
      ).not.toThrow()
      expect(fs.readFileSync(decoyPath, 'utf8')).toBe('')
      expect(getByLevel('warn')).toHaveLength(1)
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true })
    }
  })

  test('fails closed when a path segment cannot be lstat-ed at all', () => {
    // POSIX modes only, and root ignores a missing execute bit entirely, so the
    // EACCES this test depends on would not happen there. Fixture-owned, like
    // every other skip policy this suite shares with the runtime one.
    if (SKIP_EACCES_CASES) return
    const projectRoot = makeProjectRoot()
    const openbuffDir = path.join(projectRoot, '.openbuff')
    try {
      // Without the execute bit on `.openbuff`, lstat of the segment BELOW it
      // fails with EACCES rather than the ENOENT of a first write. That is not
      // "the segment is real": the scan must refuse instead of falling through.
      fs.mkdirSync(openbuffDir)
      fs.chmodSync(openbuffDir, 0o000)

      const { logger, getByLevel } = createMockLoggerWithCapture()
      expect(
        appendGateTelemetryEvent({
          projectRoot,
          payload: { event: 'base2.gate' },
          logger,
        }),
      ).toBe(false)
      const warnings = getByLevel('warn')
      expect(warnings).toHaveLength(1)
      expect(
        (warnings[0].meta?.err as { code?: unknown } | undefined)?.code,
      ).toBe('EACCES')
    } finally {
      // Restore the traversal bit so the temp tree can be removed.
      fs.chmodSync(openbuffDir, 0o700)
      fs.rmSync(projectRoot, { recursive: true, force: true })
    }
  })

  test('bails when the telemetry directory itself is a symlink', () => {
    if (SKIP_SYMLINK_CASES) return
    const projectRoot = makeProjectRoot()
    try {
      const decoyDir = path.join(projectRoot, 'decoy-dir')
      fs.mkdirSync(decoyDir, { recursive: true })
      fs.mkdirSync(path.join(projectRoot, '.openbuff'), { recursive: true })
      fs.symlinkSync(decoyDir, path.join(projectRoot, '.openbuff', 'telemetry'))

      const { logger, getByLevel } = createMockLoggerWithCapture()
      expect(() =>
        appendGateTelemetryEvent({
          projectRoot,
          payload: { event: 'base2.gate' },
          logger,
        }),
      ).not.toThrow()
      expect(fs.existsSync(path.join(decoyDir, 'base2-gate.jsonl'))).toBe(false)
      expect(getByLevel('warn')).toHaveLength(1)
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true })
    }
  })

  test('bails when the .openbuff parent is a symlink to a decoy directory', () => {
    if (SKIP_SYMLINK_CASES) return
    const projectRoot = makeProjectRoot()
    try {
      // `<decoy>/telemetry` is a REAL directory, so only a per-segment check
      // catches this: lstat of `<root>/.openbuff/telemetry` reports a directory.
      const decoyDir = path.join(projectRoot, 'decoy-openbuff')
      fs.mkdirSync(path.join(decoyDir, 'telemetry'), { recursive: true })
      fs.symlinkSync(decoyDir, path.join(projectRoot, '.openbuff'))

      const { logger, getByLevel } = createMockLoggerWithCapture()
      expect(() =>
        appendGateTelemetryEvent({
          projectRoot,
          payload: { event: 'base2.gate' },
          logger,
        }),
      ).not.toThrow()
      expect(
        fs.existsSync(path.join(decoyDir, 'telemetry', 'base2-gate.jsonl')),
      ).toBe(false)
      expect(getByLevel('warn')).toHaveLength(1)
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true })
    }
  })

  test('rotates to a single .1 generation before appending, overwriting old history', () => {
    const projectRoot = makeProjectRoot()
    try {
      const filePath = path.join(projectRoot, GATE_TELEMETRY_RELATIVE)
      fs.mkdirSync(path.join(projectRoot, '.openbuff', 'telemetry'), {
        recursive: true,
      })
      // Stale history that must be overwritten by the rotation.
      fs.writeFileSync(`${filePath}.1`, 'stale-history\n')
      fs.writeFileSync(
        filePath,
        `${'x'.repeat(GATE_TELEMETRY_MAX_BYTES + 1)}\n`,
      )

      appendGateTelemetryEvent({
        projectRoot,
        payload: { event: 'base2.gate', repairRound: 7 },
      })

      // The rotated append lands in a FRESH file: exactly the new event.
      const lines = readLines(projectRoot)
      expect(lines).toHaveLength(1)
      expect(JSON.parse(lines[0])).toMatchObject({ repairRound: 7 })
      // Exactly one generation of history, carrying the oversized former live
      // file rather than the stale `.1` content.
      const rotated = fs.readFileSync(`${filePath}.1`, 'utf8')
      expect(rotated.startsWith('xxx')).toBe(true)
      expect(rotated).not.toContain('stale-history')
      expect(fs.existsSync(`${filePath}.2`)).toBe(false)
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true })
    }
  })

  test('warns but still appends when the rotation itself fails', () => {
    const projectRoot = makeProjectRoot()
    const originalRenameSync = fs.renameSync
    try {
      const filePath = path.join(projectRoot, GATE_TELEMETRY_RELATIVE)
      const preflight = createGateTelemetryPreflight()
      expect(
        appendGateTelemetryEvent({
          projectRoot,
          payload: { event: 'base2.gate', round: 1 },
          preflight,
        }),
      ).toBe(true)

      // Push the live file past the bound and force the re-stat that rotates.
      fs.appendFileSync(filePath, `${'x'.repeat(GATE_TELEMETRY_MAX_BYTES)}\n`)
      preflight.sinkBytes = GATE_TELEMETRY_MAX_BYTES + 1
      // A rename can fail while a plain append would still succeed: Windows
      // EPERM/EACCES while a second process holds the live file open, or the file
      // vanishing between the stat and the rename.
      fs.renameSync = () => {
        throw Object.assign(new Error('operation not permitted'), {
          code: 'EPERM',
        })
      }

      const { logger, getByLevel } = createMockLoggerWithCapture()
      expect(
        appendGateTelemetryEvent({
          projectRoot,
          payload: { event: 'base2.gate', round: 2 },
          logger,
          preflight,
        }),
      ).toBe(true)

      // The event still landed, in the un-rotated (over-bound) live file, and no
      // history generation was created.
      expect(fs.existsSync(`${filePath}.1`)).toBe(false)
      const lines = readLines(projectRoot)
      expect(JSON.parse(lines[0])).toMatchObject({ round: 1 })
      expect(JSON.parse(lines[lines.length - 1])).toMatchObject({ round: 2 })
      // NOT re-armed: a failed rotation is not a failed append, so the next event
      // neither re-pays the mkdir/scan nor retries the same rotation blindly, and
      // the tracked total stays the stat'ed size of the real file.
      expect(preflight.verified).toBe(true)
      expect(preflight.sinkBytes).toBe(fs.statSync(filePath).size)
      const warnings = getByLevel('warn')
      expect(warnings).toHaveLength(1)
      expect(warnings[0].message).toContain('rotate')
      expect(
        (warnings[0].meta?.err as { code?: unknown } | undefined)?.code,
      ).toBe('EPERM')
    } finally {
      fs.renameSync = originalRenameSync
      fs.rmSync(projectRoot, { recursive: true, force: true })
    }
  })

  test('backs a repeatedly failing rotation off to the periodic re-stat', () => {
    const projectRoot = makeProjectRoot()
    const originalRenameSync = fs.renameSync
    let renameAttempts = 0
    try {
      const filePath = path.join(projectRoot, GATE_TELEMETRY_RELATIVE)
      const preflight = createGateTelemetryPreflight()
      appendGateTelemetryEvent({
        projectRoot,
        payload: { event: 'base2.gate', round: 1 },
        preflight,
      })

      // Push the live file past the bound and force the re-stat that rotates.
      fs.appendFileSync(filePath, `${'x'.repeat(GATE_TELEMETRY_MAX_BYTES)}\n`)
      preflight.sinkBytes = GATE_TELEMETRY_MAX_BYTES + 1
      // A PERSISTENTLY failing rename, e.g. a live file another process holds
      // open on Windows for the rest of the run.
      fs.renameSync = () => {
        renameAttempts += 1
        throw Object.assign(new Error('operation not permitted'), {
          code: 'EPERM',
        })
      }
      const { logger, getByLevel } = createMockLoggerWithCapture()
      const append = (round: number): boolean =>
        appendGateTelemetryEvent({
          projectRoot,
          payload: { event: 'base2.gate', round },
          logger,
          preflight,
        })

      expect(append(2)).toBe(true)
      expect(renameAttempts).toBe(1)
      expect(preflight.rotationFailed).toBe(true)
      // Two CONSECUTIVE appends both land, and the second does not re-pay the
      // stat/rm/rename of a rotation that just failed: the tracked size stays
      // over the bound, so retrying per event would cost three syscalls and a
      // warn on every later event for the rest of the run.
      expect(append(3)).toBe(true)
      expect(renameAttempts).toBe(1)
      expect(getByLevel('warn')).toHaveLength(1)
      expect(preflight.appendsSinceStat).toBe(2)

      // Every append up to the stat interval keeps backing off.
      for (let i = 0; i < GATE_TELEMETRY_STAT_INTERVAL_APPENDS - 2; i += 1) {
        expect(append(10 + i)).toBe(true)
      }
      expect(renameAttempts).toBe(1)
      expect(preflight.appendsSinceStat).toBe(
        GATE_TELEMETRY_STAT_INTERVAL_APPENDS,
      )

      // The periodic re-stat is the ONE place the rotation is retried, so the
      // retry cost is bounded to once per GATE_TELEMETRY_STAT_INTERVAL_APPENDS
      // instead of once per event.
      expect(append(99)).toBe(true)
      expect(renameAttempts).toBe(2)
      expect(getByLevel('warn')).toHaveLength(2)
      expect(preflight.appendsSinceStat).toBe(1)
      expect(preflight.rotationFailed).toBe(true)

      // Nothing was lost to the failing rotation: every event landed in the
      // un-rotated (over-bound) live file, and no history generation exists.
      expect(fs.existsSync(`${filePath}.1`)).toBe(false)
      const rounds = readLines(projectRoot)
        // The oversized filler line above is not JSONL.
        .filter((line) => line.startsWith('{'))
        .map((line) => (JSON.parse(line) as { round: number }).round)
      expect(rounds).toEqual([
        1,
        2,
        3,
        ...Array.from(
          { length: GATE_TELEMETRY_STAT_INTERVAL_APPENDS - 2 },
          (_, i) => 10 + i,
        ),
        99,
      ])

      // The backoff is not sticky: once the rename can succeed again the next
      // re-stat rotates, so a transient lock does not leave the sink over the
      // bound for the rest of the run.
      fs.renameSync = originalRenameSync
      preflight.appendsSinceStat = GATE_TELEMETRY_STAT_INTERVAL_APPENDS
      expect(append(100)).toBe(true)
      expect(preflight.rotationFailed).toBe(false)
      expect(fs.existsSync(`${filePath}.1`)).toBe(true)
      const rotatedLines = readLines(projectRoot)
      expect(rotatedLines).toHaveLength(1)
      expect(JSON.parse(rotatedLines[0])).toMatchObject({ round: 100 })
      expect(preflight.sinkBytes).toBe(fs.statSync(filePath).size)
    } finally {
      fs.renameSync = originalRenameSync
      fs.rmSync(projectRoot, { recursive: true, force: true })
    }
  })

  test('clears the rotation backoff when a re-stat finds the sink under the bound', () => {
    const projectRoot = makeProjectRoot()
    const originalRenameSync = fs.renameSync
    let renameAttempts = 0
    try {
      const filePath = path.join(projectRoot, GATE_TELEMETRY_RELATIVE)
      const preflight = createGateTelemetryPreflight()
      const { logger } = createMockLoggerWithCapture()
      const append = (round: number): boolean =>
        appendGateTelemetryEvent({
          projectRoot,
          payload: { event: 'base2.gate', round },
          logger,
          preflight,
        })
      expect(append(1)).toBe(true)

      // One failed rotation arms the backoff.
      fs.appendFileSync(filePath, `${'x'.repeat(GATE_TELEMETRY_MAX_BYTES)}\n`)
      preflight.sinkBytes = GATE_TELEMETRY_MAX_BYTES + 1
      fs.renameSync = () => {
        renameAttempts += 1
        throw Object.assign(new Error('operation not permitted'), {
          code: 'EPERM',
        })
      }
      expect(append(2)).toBe(true)
      expect(renameAttempts).toBe(1)
      expect(preflight.rotationFailed).toBe(true)

      // Someone else leaves the live sink well UNDER the bound — a concurrent
      // recorder sharing the project root rotated it, or it was truncated — and
      // the periodic re-stat sees that.
      fs.renameSync = originalRenameSync
      fs.writeFileSync(filePath, '')
      preflight.appendsSinceStat = GATE_TELEMETRY_STAT_INTERVAL_APPENDS
      expect(append(3)).toBe(true)
      // Nothing left to back off from, so the flag is cleared by THIS stat: left
      // set, it would defer the next genuinely needed rotation by up to another
      // GATE_TELEMETRY_STAT_INTERVAL_APPENDS appends.
      expect(preflight.rotationFailed).toBe(false)
      expect(renameAttempts).toBe(1)

      // So the very next append whose tracked size crosses the bound rotates
      // straight away instead of waiting for another re-stat.
      fs.appendFileSync(filePath, `${'x'.repeat(GATE_TELEMETRY_MAX_BYTES)}\n`)
      preflight.sinkBytes = GATE_TELEMETRY_MAX_BYTES + 1
      expect(append(4)).toBe(true)
      expect(fs.existsSync(`${filePath}.1`)).toBe(true)
      const lines = readLines(projectRoot)
      expect(lines).toHaveLength(1)
      expect(JSON.parse(lines[0])).toMatchObject({ round: 4 })
      expect(preflight.sinkBytes).toBe(fs.statSync(filePath).size)
    } finally {
      fs.renameSync = originalRenameSync
      fs.rmSync(projectRoot, { recursive: true, force: true })
    }
  })

  test('does not rotate while the sink is under the byte bound', () => {
    const projectRoot = makeProjectRoot()
    try {
      const filePath = path.join(projectRoot, GATE_TELEMETRY_RELATIVE)
      appendGateTelemetryEvent({
        projectRoot,
        payload: { event: 'base2.gate', round: 1 },
      })
      appendGateTelemetryEvent({
        projectRoot,
        payload: { event: 'base2.gate', round: 2 },
      })
      expect(readLines(projectRoot)).toHaveLength(2)
      expect(fs.existsSync(`${filePath}.1`)).toBe(false)
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true })
    }
  })

  test('warns instead of throwing when the sink path cannot be created', () => {
    const projectRoot = makeProjectRoot()
    try {
      // A regular file where the `.openbuff` directory belongs makes the
      // per-segment lstat fail with ENOTDIR, before mkdir is ever reached.
      fs.writeFileSync(path.join(projectRoot, '.openbuff'), 'not-a-directory')
      const { logger, getByLevel } = createMockLoggerWithCapture()
      expect(() =>
        appendGateTelemetryEvent({
          projectRoot,
          payload: { event: 'base2.gate' },
          logger,
        }),
      ).not.toThrow()
      expect(getByLevel('warn')).toHaveLength(1)
      // The single warning is diagnostic on its own: the logged error carries
      // the fs code the warn latch keys off.
      expect(
        typeof (
          getByLevel('warn')[0].meta?.err as { code?: unknown } | undefined
        )?.code,
      ).toBe('string')
      // A missing logger must be tolerated on the same failure path.
      expect(() =>
        appendGateTelemetryEvent({
          projectRoot,
          payload: { event: 'base2.gate' },
        }),
      ).not.toThrow()
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true })
    }
  })

  test('reports success as true and every non-append outcome as false', () => {
    const projectRoot = makeProjectRoot()
    try {
      expect(
        appendGateTelemetryEvent({
          projectRoot,
          payload: { event: 'base2.gate' },
        }),
      ).toBe(true)
      expect(
        appendGateTelemetryEvent({
          projectRoot: '',
          payload: { event: 'base2.gate' },
        }),
      ).toBe(false)

      const blocked = makeProjectRoot()
      try {
        // A regular file at `.openbuff` makes the per-segment lstat fail with
        // ENOTDIR, so the append fails closed before mkdir is ever reached.
        fs.writeFileSync(path.join(blocked, '.openbuff'), 'not-a-directory')
        expect(
          appendGateTelemetryEvent({
            projectRoot: blocked,
            payload: { event: 'base2.gate' },
          }),
        ).toBe(false)
      } finally {
        fs.rmSync(blocked, { recursive: true, force: true })
      }
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true })
    }
  })

  test('a verified preflight skips mkdir but never the symlink scan, and re-arms on failure', () => {
    const projectRoot = makeProjectRoot()
    try {
      const preflight = createGateTelemetryPreflight()
      expect(preflight.verified).toBe(false)
      expect(
        appendGateTelemetryEvent({
          projectRoot,
          payload: { event: 'base2.gate', round: 1 },
          preflight,
        }),
      ).toBe(true)
      expect(preflight.verified).toBe(true)

      // Because mkdir is now memoized away, a telemetry directory removed
      // mid-run makes exactly one append fail instead of being recreated.
      fs.rmSync(path.join(projectRoot, '.openbuff'), {
        recursive: true,
        force: true,
      })
      const { logger, getByLevel } = createMockLoggerWithCapture()
      expect(
        appendGateTelemetryEvent({
          projectRoot,
          payload: { event: 'base2.gate', round: 2 },
          logger,
          preflight,
        }),
      ).toBe(false)
      expect(getByLevel('warn')).toHaveLength(1)
      expect(preflight.verified).toBe(false)
      // The tracked sink size is dropped too, so the next append re-stats.
      expect(preflight.sinkBytes).toBeUndefined()

      // The failure re-armed the memo, so the next event scans and mkdirs again.
      expect(
        appendGateTelemetryEvent({
          projectRoot,
          payload: { event: 'base2.gate', round: 3 },
          logger,
          preflight,
        }),
      ).toBe(true)
      expect(getByLevel('warn')).toHaveLength(1)
      const lines = readLines(projectRoot)
      expect(lines).toHaveLength(1)
      expect(JSON.parse(lines[0])).toMatchObject({ round: 3 })
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true })
    }
  })

  test('a verified preflight tracks appended bytes and stats only near the bound', () => {
    const projectRoot = makeProjectRoot()
    try {
      const filePath = path.join(projectRoot, GATE_TELEMETRY_RELATIVE)
      const preflight = createGateTelemetryPreflight()
      expect(preflight.sinkBytes).toBeUndefined()

      appendGateTelemetryEvent({
        projectRoot,
        payload: { event: 'base2.gate', round: 1 },
        preflight,
      })
      // The memo now carries the live size, so the next append needs no stat.
      expect(preflight.sinkBytes).toBe(fs.statSync(filePath).size)

      appendGateTelemetryEvent({
        projectRoot,
        payload: { event: 'base2.gate', round: 2 },
        preflight,
      })
      expect(preflight.sinkBytes).toBe(fs.statSync(filePath).size)
      expect(readLines(projectRoot)).toHaveLength(2)
      expect(fs.existsSync(`${filePath}.1`)).toBe(false)

      // Once the tracked total crosses the bound the real size is re-stat'ed and
      // the rotation happens, resetting the tracked total to the fresh file.
      fs.appendFileSync(filePath, `${'x'.repeat(GATE_TELEMETRY_MAX_BYTES)}\n`)
      preflight.sinkBytes = GATE_TELEMETRY_MAX_BYTES + 1
      expect(
        appendGateTelemetryEvent({
          projectRoot,
          payload: { event: 'base2.gate', round: 3 },
          preflight,
        }),
      ).toBe(true)
      const lines = readLines(projectRoot)
      expect(lines).toHaveLength(1)
      expect(JSON.parse(lines[0])).toMatchObject({ round: 3 })
      expect(fs.readFileSync(`${filePath}.1`, 'utf8')).toContain('"round":1')
      expect(preflight.sinkBytes).toBe(fs.statSync(filePath).size)
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true })
    }
  })

  test('re-stats periodically so bytes appended by another recorder still rotate', () => {
    const projectRoot = makeProjectRoot()
    try {
      const filePath = path.join(projectRoot, GATE_TELEMETRY_RELATIVE)
      const preflight = createGateTelemetryPreflight()
      appendGateTelemetryEvent({
        projectRoot,
        payload: { event: 'base2.gate', round: 1 },
        preflight,
      })
      expect(preflight.appendsSinceStat).toBe(1)

      // A SECOND recorder sharing this `projectRoot` pushes the live file past
      // the bound. This pre-flight tracks only its OWN appended bytes, so
      // without a periodic re-stat the bound would hold per recorder instead of
      // per project and the file would grow unboundedly with the recorder count.
      fs.appendFileSync(filePath, `${'x'.repeat(GATE_TELEMETRY_MAX_BYTES)}\n`)

      // The stat is PERIODIC, not per-append: the very next append still trusts
      // the tracked total, which is what keeps the syscall cost off every event.
      appendGateTelemetryEvent({
        projectRoot,
        payload: { event: 'base2.gate', round: 2 },
        preflight,
      })
      expect(fs.existsSync(`${filePath}.1`)).toBe(false)

      // Two appends have already happened, so this many more reaches the
      // interval and forces the re-stat that sees the other recorder's bytes.
      for (let i = 0; i < GATE_TELEMETRY_STAT_INTERVAL_APPENDS - 1; i += 1) {
        appendGateTelemetryEvent({
          projectRoot,
          payload: { event: 'base2.gate', round: 10 + i },
          preflight,
        })
      }

      // The re-stat rotated the oversized live file, so the newest append is
      // alone in a fresh one and the tracked total describes that fresh file.
      const lines = readLines(projectRoot)
      expect(lines).toHaveLength(1)
      expect(JSON.parse(lines[0])).toMatchObject({
        round: 10 + GATE_TELEMETRY_STAT_INTERVAL_APPENDS - 2,
      })
      const rotated = fs.readFileSync(`${filePath}.1`, 'utf8')
      expect(rotated).toContain('"round":1')
      expect(preflight.appendsSinceStat).toBe(1)
      expect(preflight.sinkBytes).toBe(fs.statSync(filePath).size)
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true })
    }
  })

  test('a verified preflight skips the per-append mode repair until it re-arms', () => {
    // Windows does not honor POSIX modes, so the repair is only observable here.
    if (SKIP_POSIX_MODE_CASES) return
    const projectRoot = makeProjectRoot()
    try {
      const filePath = path.join(projectRoot, GATE_TELEMETRY_RELATIVE)
      const preflight = createGateTelemetryPreflight()
      appendGateTelemetryEvent({
        projectRoot,
        payload: { event: 'base2.gate', round: 1 },
        preflight,
      })
      // The first append of a run is unverified, so it repairs the mode.
      expectOwnerOnly(filePath)

      // Widened from outside this recorder: a verified pre-flight does not pay an
      // `fchmod` syscall per gate event, so the wider mode survives.
      fs.chmodSync(filePath, 0o666)
      appendGateTelemetryEvent({
        projectRoot,
        payload: { event: 'base2.gate', round: 2 },
        preflight,
      })
      expect(fs.statSync(filePath).mode & 0o077).toBe(0o066)

      // A failure re-arms the memo, so the next append repairs the mode again.
      preflight.verified = false
      appendGateTelemetryEvent({
        projectRoot,
        payload: { event: 'base2.gate', round: 3 },
        preflight,
      })
      expectOwnerOnly(filePath)
      expect(readLines(projectRoot)).toHaveLength(3)
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true })
    }
  })

  test('a symlink planted after a verified preflight is still refused', () => {
    if (SKIP_SYMLINK_CASES) return
    const projectRoot = makeProjectRoot()
    try {
      const preflight = createGateTelemetryPreflight()
      appendGateTelemetryEvent({
        projectRoot,
        payload: { event: 'base2.gate', round: 1 },
        preflight,
      })
      expect(preflight.verified).toBe(true)

      const decoyPath = path.join(projectRoot, 'decoy.jsonl')
      fs.writeFileSync(decoyPath, '')
      const filePath = path.join(projectRoot, GATE_TELEMETRY_RELATIVE)
      fs.rmSync(filePath)
      fs.symlinkSync(decoyPath, filePath)

      // The per-append segment scan is what refuses this on every platform;
      // `O_NOFOLLOW` would also catch this particular case, because the symlink
      // sits in the FINAL path component. The pre-flight being verified does not
      // skip the scan.
      const { logger, getByLevel } = createMockLoggerWithCapture()
      expect(
        appendGateTelemetryEvent({
          projectRoot,
          payload: { event: 'base2.gate', round: 2 },
          logger,
          preflight,
        }),
      ).toBe(false)
      expect(fs.readFileSync(decoyPath, 'utf8')).toBe('')
      expect(getByLevel('warn')).toHaveLength(1)
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true })
    }
  })

  test('a symlinked telemetry directory planted after a verified preflight is refused', () => {
    if (SKIP_SYMLINK_CASES) return
    const projectRoot = makeProjectRoot()
    try {
      const preflight = createGateTelemetryPreflight()
      expect(
        appendGateTelemetryEvent({
          projectRoot,
          payload: { event: 'base2.gate', round: 1 },
          preflight,
        }),
      ).toBe(true)
      expect(preflight.verified).toBe(true)

      // `<root>/.openbuff/telemetry` is an INTERMEDIATE segment of the sink
      // path, which `O_NOFOLLOW` never covers: only the per-append segment scan
      // refuses this, so skipping the scan once verified would append into the
      // decoy.
      const decoyDir = path.join(projectRoot, 'decoy-telemetry')
      fs.mkdirSync(decoyDir, { recursive: true })
      const telemetryDir = path.join(projectRoot, '.openbuff', 'telemetry')
      fs.rmSync(telemetryDir, { recursive: true, force: true })
      fs.symlinkSync(decoyDir, telemetryDir)

      const { logger, getByLevel } = createMockLoggerWithCapture()
      expect(
        appendGateTelemetryEvent({
          projectRoot,
          payload: { event: 'base2.gate', round: 2 },
          logger,
          preflight,
        }),
      ).toBe(false)
      expect(getByLevel('warn')).toHaveLength(1)
      expect(getByLevel('warn')[0].message).toContain('symlink')
      expect(getByLevel('warn')[0].meta).toMatchObject({
        symlinkedSegment: telemetryDir,
      })
      // Nothing was created inside the attacker-chosen directory.
      expect(fs.readdirSync(decoyDir)).toEqual([])
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true })
    }
  })

  test('a symlinked .openbuff parent planted after a verified preflight is refused', () => {
    if (SKIP_SYMLINK_CASES) return
    const projectRoot = makeProjectRoot()
    try {
      const preflight = createGateTelemetryPreflight()
      expect(
        appendGateTelemetryEvent({
          projectRoot,
          payload: { event: 'base2.gate', round: 1 },
          preflight,
        }),
      ).toBe(true)
      expect(preflight.verified).toBe(true)

      // Same regression one segment higher, with a REAL `telemetry` directory
      // inside the decoy so the leaf lstat reports an ordinary directory.
      const decoyDir = path.join(projectRoot, 'decoy-openbuff')
      fs.mkdirSync(path.join(decoyDir, 'telemetry'), { recursive: true })
      const openbuffDir = path.join(projectRoot, '.openbuff')
      fs.rmSync(openbuffDir, { recursive: true, force: true })
      fs.symlinkSync(decoyDir, openbuffDir)

      const { logger, getByLevel } = createMockLoggerWithCapture()
      expect(
        appendGateTelemetryEvent({
          projectRoot,
          payload: { event: 'base2.gate', round: 2 },
          logger,
          preflight,
        }),
      ).toBe(false)
      expect(getByLevel('warn')).toHaveLength(1)
      expect(getByLevel('warn')[0].meta).toMatchObject({
        symlinkedSegment: openbuffDir,
      })
      expect(fs.readdirSync(path.join(decoyDir, 'telemetry'))).toEqual([])
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true })
    }
  })
})
