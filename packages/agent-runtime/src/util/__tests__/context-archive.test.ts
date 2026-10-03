import { describe, expect, it } from 'bun:test'

import {
  MAX_ARCHIVE_MESSAGES,
  MAX_ARCHIVE_MESSAGE_CHARS,
  MAX_ARCHIVE_SNAPSHOTS,
  archiveEvictedToolResults,
  archivePreCompaction,
  recallFromArchive,
} from '../context-archive'
import { evictStaleToolResults } from '../tool-result-eviction'

import type { ContextArchiveSnapshot } from '@codebuff/common/types/context-archive'
import type { Message, ToolMessage } from '@codebuff/common/types/messages/codebuff-message'

/** Archive a transcript through the real entry point; returns the state. */
const archive = (
  messages: Message[],
  action: ContextArchiveSnapshot['action'] = 'semantic_compaction',
  keepRecentSteps = 6,
): { compactionArchive?: ContextArchiveSnapshot[] } => {
  const state: { compactionArchive?: ContextArchiveSnapshot[] } = {}
  archivePreCompaction(state, messages, action, keepRecentSteps)
  return state
}

const toolResult = (
  callId: string,
  value: unknown,
  toolName = 'read_files',
): ToolMessage => ({
  role: 'tool',
  toolCallId: callId,
  toolName,
  content: [{ type: 'json', value } as never],
})

const buildTranscript = (steps: number): Message[] => {
  const messages: Message[] = [
    { role: 'user', content: [{ type: 'text', text: 'go' }] },
  ]
  for (let i = 0; i < steps; i++) {
    messages.push({
      role: 'assistant',
      content: [
        {
          type: 'tool-call',
          toolCallId: `call-${i}`,
          toolName: 'read_files',
          input: { paths: [`src/file-${i}.ts`] },
        },
      ],
    })
    messages.push(toolResult(`call-${i}`, { output: `body-${i} keystone-fact-${i}` }))
  }
  return messages
}

describe('archivePreCompaction', () => {
  it('archives a snapshot with provenance and caps message count', () => {
    const state = archive(buildTranscript(10))
    expect(state.compactionArchive).toHaveLength(1)
    const snapshot = state.compactionArchive![0]
    expect(snapshot.action).toBe('semantic_compaction')
    expect(snapshot.keepRecentSteps).toBe(6)
    expect(typeof snapshot.archivedAt).toBe('number')
  })

  it('is identity-keyed: re-archiving the same array is a no-op', () => {
    const messages = buildTranscript(4)
    const state = archive(messages)
    const count = state.compactionArchive!.length
    archivePreCompaction(state, messages, 'semantic_compaction', 6)
    expect(state.compactionArchive!.length).toBe(count)
  })

  it('evicts the oldest snapshot beyond MAX_ARCHIVE_SNAPSHOTS', () => {
    // ONE state across iterations, so the snapshot list actually accumulates
    // and the oldest-evicted cap is exercised.
    const state: { compactionArchive?: ContextArchiveSnapshot[] } = {}
    for (let i = 0; i < MAX_ARCHIVE_SNAPSHOTS + 2; i++) {
      archivePreCompaction(state, buildTranscript(2 + i), 'mechanical_trim', 1)
    }
    expect(state.compactionArchive!.length).toBe(MAX_ARCHIVE_SNAPSHOTS)
    // Oldest snapshots were dropped: the first retained is not the first written.
    expect(state.compactionArchive![0].messages.length).toBe(
      buildTranscript(4).length,
    )
  })

  it('truncates oversized tool bodies instead of storing them whole', () => {
    const messages = buildTranscript(1)
    messages.push(toolResult('huge', { output: 'x'.repeat(50_000) }))
    const state = archive(messages, 'semantic_compaction', 0)
    const serialized = JSON.stringify(state.compactionArchive![0].messages)
    expect(serialized.length).toBeLessThan(50_000)
    expect(serialized).toContain('truncated in archive')
  })
})

describe('recallFromArchive', () => {
  const archiveState = archive(buildTranscript(8))
  const snapshots = archiveState.compactionArchive

  it('finds a planted fact across snapshots (AND semantics)', () => {
    const result = recallFromArchive(snapshots, 'keystone-fact-3')
    expect(result.matches).toHaveLength(1)
    expect(result.matches[0].toolName).toBe('read_files')
    expect(result.matches[0].snippet).toContain('keystone-fact-3')
    expect(result.snapshotsSearched).toBe(1)
  })

  it('requires every term to match', () => {
    expect(recallFromArchive(snapshots, 'keystone-fact-2 body-2').matches).toHaveLength(1)
    expect(recallFromArchive(snapshots, 'keystone-fact-2 body-99').matches).toHaveLength(0)
  })

  it('is case-insensitive and returns bounded results', () => {
    const state = archive(buildTranscript(12), 'semantic_compaction', 0)
    const result = recallFromArchive(state.compactionArchive, 'KEYSTONE-FACT')
    expect(result.matches.length).toBeGreaterThan(0)
    expect(result.matches.length).toBeLessThanOrEqual(6)
  })

  it('handles an empty or missing archive without throwing', () => {
    expect(recallFromArchive(undefined, 'anything').matches).toEqual([])
    expect(recallFromArchive([], 'anything').snapshotsSearched).toBe(0)
    expect(recallFromArchive(snapshots, '   ').matches).toEqual([])
  })
})

/**
 * D26: evicted tool-result segments become retrievable archive records
 * (content + provenance + eviction reason, bounded per run). The gate case is
 * the round-trip: a fact carried by a stale tool result stays recallable via
 * `recallFromArchive` after the deterministic evictor tombstones it.
 */
describe('archiveEvictedToolResults (D26)', () => {
  const evictionEntry = (
    callId: string,
    stepIndex: number,
    value: unknown = { output: 'x'.repeat(40_000) },
  ) => ({
    toolCallId: callId,
    toolName: 'read_files',
    content: [{ type: 'json', value } as never],
    stepIndex,
  })

  it('round-trips an evicted fact back through recallFromArchive', () => {
    const FACT = 'DE26-RECALLABLE-FACT-9f2'
    const messages: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'go' }] },
      {
        role: 'assistant',
        content: [
          {
            type: 'tool-call',
            toolCallId: 'stale-call',
            toolName: 'read_files',
            input: {},
          },
        ],
      },
      toolResult('stale-call', {
        output: `${FACT} ${'x'.repeat(40_000)}`,
      }),
    ]

    const result = evictStaleToolResults(messages, { keepRecentSteps: 0 })
    expect(result.evicted).toHaveLength(1)
    // The returned history is tombstoned...
    expect(JSON.stringify(result.messages)).toContain(
      '[tool result evicted to free context',
    )

    const state: { compactionArchive?: ContextArchiveSnapshot[] } = {}
    archiveEvictedToolResults(state, result.evicted!)
    const snapshot = state.compactionArchive![0]
    expect(snapshot.action).toBe('tool_result_eviction')
    expect(snapshot.reason).toBe(
      'deterministic tool-result eviction (stale recency)',
    )
    // Provenance: the ORIGINAL-transcript step of the archived tool message.
    expect(snapshot.steps).toEqual([0])
    // ...but the archive carries the original (pre-tombstone) content —
    // bounded to the per-message persisted cap — not the tombstone.
    expect(JSON.stringify(snapshot.messages)).toContain(FACT)
    expect(JSON.stringify(snapshot.messages)).not.toContain(
      '[tool result evicted to free context',
    )

    // THE D26 GATE: the fact is recallable after eviction.
    const recalled = recallFromArchive(
      state.compactionArchive,
      'DE26-RECALLABLE-FACT',
    )
    expect(recalled.matches).toHaveLength(1)
    expect(recalled.matches[0].snippet).toContain(FACT)
  })

  it('is identity-keyed: the same toolCallId never duplicates a record', () => {
    const state: { compactionArchive?: ContextArchiveSnapshot[] } = {}
    archiveEvictedToolResults(state, [evictionEntry('call-a', 0)])
    archiveEvictedToolResults(state, [evictionEntry('call-a', 0)])
    expect(state.compactionArchive).toHaveLength(1)
    expect(state.compactionArchive![0].messages).toHaveLength(1)
  })

  it('drops the OLDEST eviction snapshot when the cap overflows', () => {
    const state: { compactionArchive?: ContextArchiveSnapshot[] } = {}
    for (let i = 0; i < MAX_ARCHIVE_SNAPSHOTS + 2; i++) {
      archiveEvictedToolResults(state, [evictionEntry(`evict-${i}`, i)])
    }
    expect(state.compactionArchive).toHaveLength(MAX_ARCHIVE_SNAPSHOTS)
    const callIds = state.compactionArchive!.flatMap((snapshot) =>
      snapshot.messages.map((message) =>
        message.role === 'tool' ? message.toolCallId : '',
      ),
    )
    // Newest kept, oldest two shifted out — never the reverse.
    expect(callIds).toContain(`evict-${MAX_ARCHIVE_SNAPSHOTS + 1}`)
    expect(callIds).not.toContain('evict-0')
    expect(callIds).not.toContain('evict-1')
  })

  it('tolerates legacy snapshots without the D26 fields (additive contract)', () => {
    const legacy: ContextArchiveSnapshot = {
      archivedAt: 1,
      action: 'semantic_compaction',
      keepRecentSteps: 0,
      messages: [toolResult('legacy-call', { output: 'legacy-fact-body' })],
    }
    const state: { compactionArchive?: ContextArchiveSnapshot[] } = {
      compactionArchive: [legacy],
    }
    archiveEvictedToolResults(state, [
      evictionEntry('new-call', 3, { output: 'd26-fresh-fact' }),
    ])
    expect(state.compactionArchive).toHaveLength(2)
    // The legacy snapshot (no `steps`/`reason`) still parses and recalls...
    expect(
      recallFromArchive(state.compactionArchive, 'legacy-fact-body').matches,
    ).toHaveLength(1)
    // ...and the new eviction snapshot recalls alongside it.
    expect(
      recallFromArchive(state.compactionArchive, 'd26-fresh-fact').matches,
    ).toHaveLength(1)
  })

  it('bounds eviction snapshots to the persisted 8x200x4k size contract', () => {
    const state: { compactionArchive?: ContextArchiveSnapshot[] } = {}
    const evicted = Array.from({ length: MAX_ARCHIVE_MESSAGES + 5 }, (_, i) =>
      evictionEntry(`huge-${i}`, i, {
        output: `bulk-fact-${i} ${'x'.repeat(40_000)}`,
      }),
    )
    archiveEvictedToolResults(state, evicted)

    expect(state.compactionArchive).toHaveLength(1)
    const snapshot = state.compactionArchive![0]
    // Per-snapshot message cap honored (oldest entries shifted out).
    expect(snapshot.messages.length).toBe(MAX_ARCHIVE_MESSAGES)
    // Per-message char cap honored on every archived body (an unbounded
    // original body serializes to ~41k chars).
    for (const message of snapshot.messages) {
      expect(JSON.stringify(message).length).toBeLessThanOrEqual(
        MAX_ARCHIVE_MESSAGE_CHARS + 300,
      )
    }
    // Newest kept, oldest dropped.
    const callIds = snapshot.messages.map(
      (message) => (message as ToolMessage).toolCallId,
    )
    expect(callIds).toContain(`huge-${MAX_ARCHIVE_MESSAGES + 4}`)
    expect(callIds).not.toContain('huge-0')
    // `steps` stays parallel to the bounded `messages`.
    expect(snapshot.steps).toHaveLength(MAX_ARCHIVE_MESSAGES)

    // Recall still works on the bounded snapshot and reports the ORIGINAL
    // transcript step from `steps`, not the slice-local index.
    const recalled = recallFromArchive(state.compactionArchive, 'bulk-fact-204')
    expect(recalled.matches).toHaveLength(1)
    expect(recalled.matches[0].step).toBe(MAX_ARCHIVE_MESSAGES + 4)
    expect(recalled.matches[0].step).not.toBe(MAX_ARCHIVE_MESSAGES - 1)
  })

  it('reports original-transcript steps from the steps provenance array', () => {
    const state: { compactionArchive?: ContextArchiveSnapshot[] } = {}
    archiveEvictedToolResults(state, [
      evictionEntry('call-a', 3, { output: 'alpha-fact' }),
      evictionEntry('call-b', 7, { output: 'beta-fact' }),
    ])

    const second = recallFromArchive(state.compactionArchive, 'beta-fact')
    expect(second.matches).toHaveLength(1)
    // NOT the slice-local index (1): the snapshot's `steps[1]` is 7.
    expect(second.matches[0].step).toBe(7)
    const first = recallFromArchive(state.compactionArchive, 'alpha-fact')
    expect(first.matches).toHaveLength(1)
    expect(first.matches[0].step).toBe(3)
  })

  it('falls back to stepBase numbering for legacy eviction snapshots without steps', () => {
    const legacyEviction: ContextArchiveSnapshot = {
      archivedAt: 1,
      action: 'tool_result_eviction',
      keepRecentSteps: 0,
      stepBase: 40,
      messages: [toolResult('legacy-evict', { output: 'legacy-evict-fact' })],
    }
    const result = recallFromArchive([legacyEviction], 'legacy-evict-fact')
    expect(result.matches).toHaveLength(1)
    expect(result.matches[0].step).toBe(40)
  })

  it('is a no-op on empty input', () => {
    const state: { compactionArchive?: ContextArchiveSnapshot[] } = {}
    archiveEvictedToolResults(state, [])
    expect(state.compactionArchive).toBeUndefined()
  })
})
