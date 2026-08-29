import { describe, expect, it } from 'bun:test'

import {
  describeTruncationRecovery,
  detectTransportTruncation,
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
