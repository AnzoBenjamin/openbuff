import { describe, expect, it } from 'bun:test'
import { getInitialAgentState } from '@codebuff/common/types/session-state'
import type {
  Message,
  ToolMessage,
} from '@codebuff/common/types/messages/codebuff-message'
import {
  archiveEvictedToolResults,
  archivePreCompaction,
  recallFromArchiveByToolCallId,
} from '../context-archive'
import { evictStaleToolResults } from '../tool-result-eviction'

const result = (id: string, text: string): ToolMessage => ({
  role: 'tool',
  toolCallId: id,
  toolName: 'read_files',
  content: [{ type: 'json', value: text }],
})
const stateFor = (runId = 'original-run') => ({
  ...getInitialAgentState(),
  runId,
})
const optionsFor = (state: ReturnType<typeof stateFor>, extra = {}) => ({
  bodies: state.contextArchiveBodies,
  maxBytes: 65_536,
  ...extra,
})

describe('B13 original result provenance and bounded byte recall', () => {
  it('a later real eviction pointer cannot shadow the original 32 KiB body', () => {
    const text = `RESULT-000\n${'x'.repeat(32_748)}\nTAIL-000`
    expect(Buffer.byteLength(text)).toBe(32_768)
    const state = stateFor()
    const messages: Message[] = [
      {
        role: 'assistant',
        content: [
          {
            type: 'tool-call',
            toolCallId: 'result-000',
            toolName: 'read_files',
            input: {},
          },
        ],
      },
      result('result-000', text),
    ]
    const evicted = evictStaleToolResults(messages, {
      keepRecentSteps: 0,
      minSavingsTokens: 1,
    })
    expect(evicted.evictedCount).toBe(1)
    archiveEvictedToolResults(state, evicted.evicted!, 100)
    for (let pass = 0; pass < 3; pass++) {
      archivePreCompaction(
        state,
        structuredClone(evicted.messages),
        'semantic_compaction',
        0,
        101 + pass,
      )
    }
    const recalled = recallFromArchiveByToolCallId(
      state.compactionArchive,
      'result-000',
      optionsFor(state),
    )
    expect(recalled.matches[0]?.snippet).toBe(text)
    expect(recalled.matches[0]?.provenance?.kind).toBe('original')
    expect(recalled.matches[0]?.body?.utf8Bytes).toBe(32_768)
    expect(Object.keys(state.contextArchiveBodies ?? {})).toHaveLength(1)
  })

  it('captures the immutable original before either archive excerpt limit', () => {
    const text = `${'begin\n'}${'y'.repeat(100_000)}\nORIGINAL-TAIL`
    const state = stateFor()
    archivePreCompaction(
      state,
      [result('large', text)],
      'mechanical_trim',
      0,
      100,
    )
    expect(JSON.stringify(state.compactionArchive![0].messages)).toContain(
      'truncated in archive',
    )
    let offsetBytes = 0
    const pages: string[] = []
    do {
      const recalled = recallFromArchiveByToolCallId(
        state.compactionArchive,
        'large',
        optionsFor(state, { offsetBytes, maxBytes: 4_096 }),
      )
      const match = recalled.matches[0]
      expect(match).toBeDefined()
      expect(Buffer.byteLength(match.snippet)).toBeLessThanOrEqual(4_096)
      pages.push(match.snippet)
      if (match.page?.nextOffset === null) break
      expect(match.page?.nextOffset).toBeGreaterThan(offsetBytes)
      offsetBytes = match.page!.nextOffset!
    } while (pages.length < 30)
    expect(pages.join('')).toBe(text)
  })

  it('uses UTF-8 byte cursors without cutting a code point or accepting an interior cursor', () => {
    const state = stateFor()
    archiveEvictedToolResults(
      state,
      [
        {
          toolCallId: 'unicode',
          toolName: 'read_files',
          content: result('unicode', 'A🙂€B').content,
          stepIndex: 7,
        },
      ],
      100,
    )
    const first = recallFromArchiveByToolCallId(
      state.compactionArchive,
      'unicode',
      optionsFor(state, { maxBytes: 5 }),
    )
    expect(first.matches[0]?.snippet).toBe('A🙂')
    expect(first.matches[0]?.page?.nextOffset).toBe(5)
    const second = recallFromArchiveByToolCallId(
      state.compactionArchive,
      'unicode',
      optionsFor(state, { offsetBytes: 5, maxBytes: 3 }),
    )
    expect(second.matches[0]?.snippet).toBe('€')
    expect(second.matches[0]?.page?.nextOffset).toBe(8)
    const invalid = recallFromArchiveByToolCallId(
      state.compactionArchive,
      'unicode',
      optionsFor(state, { offsetBytes: 2 }),
    )
    expect(invalid.status).toBe('invalid-cursor')
    expect(invalid.matches).toEqual([])
  })

  it('rejects conflicting originals and cannot overwrite an earlier immutable body', () => {
    const state = stateFor()
    archivePreCompaction(
      state,
      [result('same', 'first original')],
      'semantic_compaction',
      0,
      100,
    )
    archivePreCompaction(
      state,
      [result('same', 'different original')],
      'mechanical_trim',
      0,
      101,
    )
    const recalled = recallFromArchiveByToolCallId(
      state.compactionArchive,
      'same',
      optionsFor(state),
    )
    expect(recalled.status).toBe('corrupt')
    expect(recalled.matches).toEqual([])
    expect(
      Object.values(state.contextArchiveBodies ?? {}).map((body) => body.text),
    ).not.toContain('different original')
  })

  it('requires source-run disambiguation and an expected body hash when supplied', () => {
    const one = stateFor('run-one'),
      two = stateFor('run-two')
    archivePreCompaction(
      one,
      [result('shared-id', 'one')],
      'semantic_compaction',
      0,
      100,
    )
    archivePreCompaction(
      two,
      [result('shared-id', 'two')],
      'semantic_compaction',
      0,
      101,
    )
    const archive = [...one.compactionArchive!, ...two.compactionArchive!]
    const bodies = { ...one.contextArchiveBodies, ...two.contextArchiveBodies }
    expect(
      recallFromArchiveByToolCallId(archive, 'shared-id', { bodies }).status,
    ).toBe('ambiguous')
    const selected = recallFromArchiveByToolCallId(archive, 'shared-id', {
      bodies,
      sourceRunId: 'run-one',
    })
    expect(selected.matches[0]?.snippet).toBe('one')
    const wrongHash = recallFromArchiveByToolCallId(archive, 'shared-id', {
      bodies,
      sourceRunId: 'run-one',
      expectedSha256: '0'.repeat(64),
    })
    expect(wrongHash.status).toBe('corrupt')
    expect(wrongHash.matches).toEqual([])
  })
})
