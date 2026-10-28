import { describe, expect, it } from 'bun:test'

import {
  describeTruncationRecovery,
  detectTransportTruncation,
  MAX_TRUNCATION_RECOVERY_BYTES,
  PAYLOAD_TRUNCATED_ERROR_CODE,
  tryRecoverTruncatedToolArguments,
} from '../utils'

describe('transport-truncation helpers (F1/F3)', () => {
  describe('tryRecoverTruncatedToolArguments', () => {
    it('recovers a payload truncated at a clean edit-entry boundary', () => {
      const recovered = tryRecoverTruncatedToolArguments(
        '{"edits":[{"type":"str_replace","path":"a.ts","replacements":[{"oldString":"x","newString":"y"}]}',
      )
      expect(recovered).toBeDefined()
      expect(recovered).not.toBeNull()
      expect(Array.isArray((recovered as Record<string, unknown>).edits)).toBe(
        true,
      )
    })

    it('NEVER recovers a payload cut mid-string (a partial value must not be applied)', () => {
      expect(
        tryRecoverTruncatedToolArguments(
          '{"edits":[{"type":"str_replace","path":"a.ts","replacements":[{"oldString":"x","newString":"yyy',
        ),
      ).toBeUndefined()
    })

    it('returns undefined for a complete (balanced) payload', () => {
      expect(
        tryRecoverTruncatedToolArguments(
          '{"edits":[{"type":"delete","path":"a.ts"}]}',
        ),
      ).toBeUndefined()
    })

    it('returns undefined for non-object input', () => {
      expect(tryRecoverTruncatedToolArguments('')).toBeUndefined()
      expect(tryRecoverTruncatedToolArguments('[1,2')).toBeUndefined()
    })
  })

  describe('detectTransportTruncation', () => {
    it('flags open/unbalanced structures', () => {
      expect(detectTransportTruncation('{"a":1')).toBe(true)
      expect(detectTransportTruncation('{"edits":[{"oldString":"a"}')).toBe(
        true,
      )
      expect(
        detectTransportTruncation('{"a":1', 'Unexpected end of JSON input'),
      ).toBe(true)
    })

    it('does NOT flag a fully closed payload as truncated (malformed stays malformed)', () => {
      expect(detectTransportTruncation('{"a":1}')).toBe(false)
    })

    it('rejects non-string input', () => {
      expect(detectTransportTruncation(123 as unknown as string)).toBe(false)
    })
  })

  it('exposes the payload_truncated machine code', () => {
    expect(PAYLOAD_TRUNCATED_ERROR_CODE).toBe('payload_truncated')
  })
})

describe('describeTruncationRecovery (F2)', () => {
  it('returns undefined when there is no recovery candidate', () => {
    expect(describeTruncationRecovery(undefined)).toBeUndefined()
  })

  it('reports the recovered byte count with a structural preview, never payload contents', () => {
    // A recovered truncation candidate whose edits carry path/oldString/newString
    // content that must NOT leak into the model-visible/logged error preview. The
    // preview is structural (keys + edit path fields only), so a payload secret
    // embedded in oldString/newString can never survive into the error string.
    const recovered = {
      edits: [
        {
          type: 'str_replace',
          path: 'src/a.ts',
          replacements: [
            {
              oldString: 'super-secret-old-value',
              newString: 'super-secret-new-value',
            },
          ],
        },
      ],
    }

    const summary = describeTruncationRecovery(recovered)
    expect(summary).toBeDefined()
    expect(summary!.recoveredBytes).toBe(JSON.stringify(recovered).length)
    // Structural preview: reports the edit path and type, but no secret values.
    expect(summary!.recoveredPreview).toContain('keys: [edits]')
    expect(summary!.recoveredPreview).toContain('str_replace src/a.ts')
    expect(summary!.recoveredPreview).not.toContain('super-secret-old-value')
    expect(summary!.recoveredPreview).not.toContain('super-secret-new-value')
    expect(summary!.recoveredPreview).not.toContain('oldString')
    expect(summary!.recoveredPreview).not.toContain('newString')
  })

  it('caps the structural preview at a bounded length', () => {
    const recovered = {
      edits: Array.from({ length: 40 }, (_, index) => ({
        type: 'write_file',
        path: `src/file-${index}-with-a-long-name.ts`,
        content: `secret-content-${index}`,
      })),
    }
    const summary = describeTruncationRecovery(recovered)
    expect(summary).toBeDefined()
    expect(summary!.recoveredPreview.length).toBeLessThanOrEqual(200)
    // No content field value ever appears in the capped preview.
    expect(summary!.recoveredPreview).not.toContain('secret-content-')
  })
})

describe('oversized payload classification (post-256KB coverage)', () => {
  const OVER_CAP = 256_000 + 1

  it('classifies an oversized payload cut mid-string as transport truncation', () => {
    const oversized = `{"edits":[{"type":"str_replace","path":"a.ts","newString":"${'y'.repeat(OVER_CAP)}`
    expect(oversized.length).toBeGreaterThan(256_000)
    expect(detectTransportTruncation(oversized)).toBe(true)
  })

  it('does NOT classify an oversized but complete payload as truncated', () => {
    const oversizedComplete = `{"edits":[{"type":"write_file","path":"a.ts","content":"${'y'.repeat(OVER_CAP)}"}]}`
    expect(oversizedComplete.length).toBeGreaterThan(256_000)
    expect(detectTransportTruncation(oversizedComplete)).toBe(false)
    expect(tryRecoverTruncatedToolArguments(oversizedComplete)).toBeUndefined()
  })

  it('recovers an oversized payload cut at a clean edit boundary', () => {
    const edit = `{"type":"write_file","path":"a.ts","content":"${'y'.repeat(OVER_CAP)}"}`
    const truncated = `{"edits":[${edit}`
    const recovered = tryRecoverTruncatedToolArguments(truncated)
    expect(recovered).toBeDefined()
    const edits = (recovered as Record<string, unknown>).edits
    expect(Array.isArray(edits)).toBe(true)
    expect((edits as unknown[]).length).toBe(1)
  })

  it('stays bounded and correct on an oversized payload with many closers', () => {
    // 100 closed edit objects push the payload past the legacy bound with
    // 100 candidate closers; recovery must still succeed via the latest
    // boundary without scanning unboundedly.
    const edits = Array.from(
      { length: 100 },
      (_, index) =>
        `{"type":"write_file","path":"f${index}.ts","content":"${'y'.repeat(3000)}"}`,
    ).join(',')
    const truncated = `{"edits":[${edits}`
    expect(truncated.length).toBeGreaterThan(256_000)
    const recovered = tryRecoverTruncatedToolArguments(truncated)
    expect(recovered).toBeDefined()
    const recoveredEdits = (recovered as Record<string, unknown>).edits
    expect((recoveredEdits as unknown[]).length).toBe(100)
  })
})

describe('oversized beyond the 1 MiB detection band', () => {
  // ~1.1 MiB: past the 1 MiB recovery/repair bound, well under the 8 MiB
  // detection ceiling. Before the detection band was split from the recovery
  // bound, a cut this size was invisible to the classifier —
  // detectTransportTruncation returned false — so the executor reported a
  // plain parse error with no payload_truncated code and the model could not
  // tell a transport cut from malformed input.
  const OVERSIZED = MAX_TRUNCATION_RECOVERY_BYTES + 105_000

  it('classifies an oversized payload cut mid-string as transport truncation', () => {
    const truncated = `{"edits":[{"type":"str_replace","path":"a.ts","replacements":[{"oldString":"x","newString":"${'y'.repeat(OVERSIZED)}`
    expect(truncated.length).toBeGreaterThan(MAX_TRUNCATION_RECOVERY_BYTES)
    expect(detectTransportTruncation(truncated)).toBe(true)
  })

  it('does NOT classify an oversized but complete payload as truncated', () => {
    const complete = `{"edits":[{"type":"write_file","path":"a.ts","content":"${'y'.repeat(OVERSIZED)}"}]}`
    expect(complete.length).toBeGreaterThan(MAX_TRUNCATION_RECOVERY_BYTES)
    expect(detectTransportTruncation(complete)).toBe(false)
  })

  it('keeps tryRecoverTruncatedToolArguments undefined past the 1 MiB recovery bound', () => {
    // The same clean-boundary shape that recovers just above the legacy
    // 256KB band (see above), but past 1 MiB: recovery stays deliberately
    // bounded (each candidate prefix re-parses), so an oversized cut is
    // classified but never recovered.
    const truncated = `{"edits":[{"type":"write_file","path":"a.ts","content":"${'y'.repeat(OVERSIZED)}"}`
    expect(truncated.length).toBeGreaterThan(MAX_TRUNCATION_RECOVERY_BYTES)
    expect(tryRecoverTruncatedToolArguments(truncated)).toBeUndefined()
  })
})

describe('bracket-flood payloads keep candidate recording memory-linear', () => {
  // Reviewer finding truncation-candidate-stack-memory: a <=1 MiB
  // bracket-flood payload (~500k '[' then ~260k ']') passes
  // scanTruncationState as unbalanced (depth > 0), so it reaches recovery.
  // The array form of the candidate pass copied the residual open stack for
  // EVERY closer (O(closers x depth) memory — ~10^11 array slots here),
  // OOM-killing the process; the persistent linked stack records each
  // candidate in O(1) (one node per opener, structural sharing), so this
  // payload classifies and recovers-or-degrades in bounded memory.
  const FLOOD = '['.repeat(500_000) + ']'.repeat(260_000)

  it('classifies the bracket flood as transport truncation (unbalanced depth)', () => {
    expect(FLOOD.length).toBeLessThanOrEqual(MAX_TRUNCATION_RECOVERY_BYTES)
    expect(detectTransportTruncation(FLOOD)).toBe(true)
  })

  it('returns undefined on the bracket flood without a memory blow-up (every candidate parses to an array, never a plain object)', () => {
    // >256KB, so the candidate budget caps parse attempts at the latest 64
    // closers; deep-nest JSON.parse failures (engine stack limits) are
    // caught per-candidate exactly like any other parse miss.
    expect(tryRecoverTruncatedToolArguments(FLOOD)).toBeUndefined()
  })
})
