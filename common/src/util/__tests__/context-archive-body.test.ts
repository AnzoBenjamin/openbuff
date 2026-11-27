import { describe, expect, it } from 'bun:test'
import {
  createContextArchiveBody,
  isContextArchiveBody,
  pageContextArchiveBody,
  rehashContextArchiveBodies,
} from '../context-archive-body'

describe('immutable archive text bodies', () => {
  it('binds exact UTF-8 text rather than JSON-encoded content', () => {
    const body = createContextArchiveBody('A🙂€B')
    expect(body.utf8Bytes).toBe(9)
    expect(isContextArchiveBody(body)).toBe(true)
    expect(isContextArchiveBody({ ...body, text: 'different' })).toBe(false)
    expect(isContextArchiveBody(createContextArchiveBody('\ud800'))).toBe(false)
  })
  it('pages at real complete-code-point byte boundaries', () => {
    const body = createContextArchiveBody('A🙂€B')
    expect(pageContextArchiveBody(body, { maxBytes: 5 })).toEqual({
      text: 'A🙂',
      startByte: 0,
      endByte: 5,
      nextOffset: 5,
    })
    expect(
      pageContextArchiveBody(body, { offsetBytes: 5, maxBytes: 3 }),
    ).toEqual({ text: '€', startByte: 5, endByte: 8, nextOffset: 8 })
    expect(
      pageContextArchiveBody(body, { offsetBytes: 9, maxBytes: 1 }),
    ).toEqual({ text: '', startByte: 9, endByte: 9, nextOffset: null })
    expect(pageContextArchiveBody(body, { offsetBytes: 2 })).toHaveProperty(
      'status',
      'invalid-cursor',
    )
    expect(
      pageContextArchiveBody(body, { offsetBytes: 1, maxBytes: 1 }),
    ).toHaveProperty('status', 'invalid-cursor')
    expect(
      pageContextArchiveBody(body, { expectedSha256: '0'.repeat(64) }),
    ).toHaveProperty('status', 'corrupt')
  })
  it('rehashes sanitized bytes and consistently rebinds every reference', () => {
    const original = createContextArchiveBody('secret')
    const state = {
      contextArchiveBodies: {
        [original.bodyId]: { ...original, text: '[REDACTED]' },
      },
      compactionArchive: [
        {
          archivedAt: 100,
          snapshotId: 'old-manifest',
          action: 'mechanical_trim' as const,
          keepRecentSteps: 0,
          messages: [],
          provenance: [{ kind: 'original' as const, step: 0, body: original }],
        },
      ],
    }
    rehashContextArchiveBodies(state)
    const rebound = Object.values(state.contextArchiveBodies)[0]
    expect(isContextArchiveBody(rebound)).toBe(true)
    expect(rebound.text).toBe('[REDACTED]')
    expect(rebound.bodyId).not.toBe(original.bodyId)
    expect(state.compactionArchive[0].provenance[0].body.bodyId).toBe(
      rebound.bodyId,
    )
    expect(state.compactionArchive[0].snapshotId).toBeUndefined()
  })
})
