import { describe, expect, it } from 'bun:test'

import {
  EVICTION_ARCHIVE_MESSAGE_CHARS,
  MAX_ARCHIVE_MESSAGES,
  MAX_ARCHIVE_MESSAGE_CHARS,
  MAX_ARCHIVE_SNAPSHOTS,
  MAX_EVICTION_ARCHIVE_SNAPSHOTS,
  RECALL_SNIPPET_CHARS,
  archiveEvictedToolResults,
  archivePreCompaction,
  recallFromArchive,
  recallFromArchiveByToolCallId,
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

  it('caps oversized conversation text too', () => {
    const marker = 'ARCHIVED-CONVERSATION-MARKER'
    const state = archive([
      {
        role: 'user',
        content: [{ type: 'text', text: `${marker} ${'x'.repeat(50_000)}` }],
      },
    ])
    const serialized = JSON.stringify(state.compactionArchive![0].messages)

    expect(serialized.length).toBeLessThan(10_000)
    expect(serialized).toContain(marker)
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

  it('recalls archived conversation in addition to tool bodies', () => {
    const marker = 'CONVERSATION-RECOVERY-MARKER-41d'
    const state = archive([
      {
        role: 'user',
        content: [{ type: 'text', text: `Please preserve ${marker}` }],
      },
      {
        role: 'assistant',
        content: [{ type: 'text', text: `Decision recorded: ${marker}` }],
      },
    ])

    const result = recallFromArchive(state.compactionArchive, marker)
    expect(result.matches).toHaveLength(2)
    expect(result.matches.every((match) => match.toolName === 'conversation')).toBe(
      true,
    )
    expect(result.matches[0].snippet).toContain(marker)
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

  it('reports the snapshots ACTUALLY searched when the result cap ends the scan early', () => {
    // Three snapshots, each holding more matches than RECALL_MAX_RESULTS:
    // the scan stops inside the NEWEST snapshot, so only ONE snapshot was
    // searched — not archive.length (the early return used to over-report).
    const state: { compactionArchive?: ContextArchiveSnapshot[] } = {}
    for (let i = 0; i < 3; i++) {
      const messages: Message[] = []
      for (let j = 0; j < 10; j++) {
        messages.push(toolResult(`early-${i}-${j}`, { output: 'shared-fact' }))
      }
      archivePreCompaction(state, messages, 'mechanical_trim', 0, i + 1)
    }
    expect(state.compactionArchive).toHaveLength(3)

    const result = recallFromArchive(state.compactionArchive, 'shared-fact')
    expect(result.matches).toHaveLength(6) // RECALL_MAX_RESULTS
    expect(result.snapshotsSearched).toBe(1)
    expect(result.archivedAt).toHaveLength(3)
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

  it('caps eviction snapshots at the DEDICATED MAX_EVICTION_ARCHIVE_SNAPSHOTS cap', () => {
    const state: { compactionArchive?: ContextArchiveSnapshot[] } = {}
    for (let i = 0; i < MAX_EVICTION_ARCHIVE_SNAPSHOTS + 2; i++) {
      archiveEvictedToolResults(state, [evictionEntry(`evict-${i}`, i)])
    }
    expect(state.compactionArchive).toHaveLength(MAX_EVICTION_ARCHIVE_SNAPSHOTS)
    const callIds = state.compactionArchive!.flatMap((snapshot) =>
      snapshot.messages.map((message) =>
        message.role === 'tool' ? message.toolCallId : '',
      ),
    )
    // Newest kept, oldest two shifted out — never the reverse.
    expect(callIds).toContain(
      `evict-${MAX_EVICTION_ARCHIVE_SNAPSHOTS + 1}`,
    )
    expect(callIds).not.toContain('evict-0')
    expect(callIds).not.toContain('evict-1')
  })

  it('does not count eviction snapshots against the semantic snapshot cap (D26 dedicated cap)', () => {
    const state: { compactionArchive?: ContextArchiveSnapshot[] } = {}
    // More eviction snapshots than the SEMANTIC cap allows: previously they
    // shared the 8-snapshot cap and evicted each other (and semantic
    // snapshots) prematurely.
    for (let i = 0; i < MAX_EVICTION_ARCHIVE_SNAPSHOTS; i++) {
      archiveEvictedToolResults(state, [evictionEntry(`dedicated-${i}`, i)])
    }
    // A semantic pass archives alongside them without dropping any eviction
    // snapshot: the kinds are capped independently.
    archivePreCompaction(state, buildTranscript(2), 'semantic_compaction', 1)
    expect(state.compactionArchive).toHaveLength(
      MAX_EVICTION_ARCHIVE_SNAPSHOTS + 1,
    )
    expect(
      state.compactionArchive!.filter(
        (snapshot) => snapshot.action === 'tool_result_eviction',
      ),
    ).toHaveLength(MAX_EVICTION_ARCHIVE_SNAPSHOTS)
    // And the semantic snapshot itself still caps at MAX_ARCHIVE_SNAPSHOTS
    // (oldest-dropped-first) independently of the eviction snapshots.
    for (let i = 0; i < MAX_ARCHIVE_SNAPSHOTS + 2; i++) {
      archivePreCompaction(state, buildTranscript(2 + i), 'mechanical_trim', 1)
    }
    const semanticCount = state.compactionArchive!.filter(
      (snapshot) => snapshot.action !== 'tool_result_eviction',
    ).length
    expect(semanticCount).toBe(MAX_ARCHIVE_SNAPSHOTS)
    // The eviction records all survived the semantic-cap churn.
    expect(
      state.compactionArchive!.filter(
        (snapshot) => snapshot.action === 'tool_result_eviction',
      ).length,
    ).toBe(MAX_EVICTION_ARCHIVE_SNAPSHOTS)
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

  it('bounds eviction snapshots to the persisted size contract with the dedicated 64k body bound', () => {
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
    // Per-message char cap honored on every archived body — at the DEDICATED
    // EVICTION_ARCHIVE_MESSAGE_CHARS bound, so a ~41k-char body survives WHOLE
    // (the old 4k bound destroyed most of the recallable content).
    for (const message of snapshot.messages) {
      expect(JSON.stringify(message).length).toBeLessThanOrEqual(
        EVICTION_ARCHIVE_MESSAGE_CHARS + 300,
      )
      expect(JSON.stringify(message).length).toBeGreaterThan(40_000)
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

  // D26 recall honesty: the archive's full-content recall claim only holds if
  // the per-body truncation bound is larger than the historical 4k clip. A
  // body between the two bounds must survive VERBATIM, and recall must return
  // the full body up to the snippet bound.
  describe('eviction body retention (D26 64k bound)', () => {
    it('round-trips a >4k evicted body whole (the old 4k clip would have destroyed it)', () => {
      const MARKER = 'D26-FULL-BODY-MARKER-7e1'
      const body = `${'y'.repeat(30_000)} ${MARKER} ${'z'.repeat(30_000)}`
      const state: { compactionArchive?: ContextArchiveSnapshot[] } = {}
      archiveEvictedToolResults(state, [
        evictionEntry('big-body-call', 2, { output: body }),
      ])
      const snapshot = state.compactionArchive![0]
      expect(snapshot.messages).toHaveLength(1)
      const part = (snapshot.messages[0] as ToolMessage).content[0]
      expect(part.type).toBe('json')
      if (part.type === 'json') {
        // Non-string json values persist in their SERIALIZED form (the same
        // shape every snapshot stores, the 4k semantic path included), so
        // verbatim retention is asserted on the serialized body: no
        // truncation marker, full 30k head and 30k tail, marker preserved.
        expect(part.value).toEqual(JSON.stringify({ output: body }))
        expect(JSON.stringify(part.value)).not.toContain('truncated in archive')
        expect(JSON.stringify(part.value).length).toBeGreaterThan(60_000)
      }
      // Recallable through the scanner like any other archived fact.
      const recalled = recallFromArchive(state.compactionArchive, MARKER)
      expect(recalled.matches).toHaveLength(1)
      expect(recalled.matches[0].snippet).toContain(MARKER)
    })

    it('still truncates a body beyond the 64k eviction bound (bounded persisted size)', () => {
      const TAIL = 'D26-BEYOND-BOUND-TAIL-3a9'
      const body = `${'w'.repeat(70_000)} ${TAIL}`
      const state: { compactionArchive?: ContextArchiveSnapshot[] } = {}
      archiveEvictedToolResults(state, [
        evictionEntry('over-bound-call', 1, { output: body }),
      ])
      const serialized = JSON.stringify(state.compactionArchive![0].messages)
      // Bounded: well under the raw 70k body size.
      expect(serialized.length).toBeLessThan(70_000)
      expect(serialized).toContain('truncated in archive')
      // The head of the body is still recoverable.
      const recalled = recallFromArchive(
        state.compactionArchive,
        'wwwwwwwwww',
      )
      expect(recalled.matches).toHaveLength(1)
    })

    it('keeps semantic-snapshot truncation at the 4k bound unchanged', () => {
      const state: { compactionArchive?: ContextArchiveSnapshot[] } = {}
      const messages = buildTranscript(1)
      messages.push(toolResult('big-semantic', { output: 'x'.repeat(50_000) }))
      archivePreCompaction(state, messages, 'semantic_compaction', 0)
      const serialized = JSON.stringify(state.compactionArchive![0].messages)
      expect(serialized.length).toBeLessThan(50_000)
      expect(serialized).toContain('truncated in archive')
    })
  })
})

/**
 * D26 exact-ID retrieval: the eviction tombstone names `toolCallId=<id>` and
 * promises recall_context as the recovery path, but the text surfaces match
 * only archived BODY text — an id appearing in no body (the usual case) was
 * unrecoverable. The by-ID scanner matches the entry identity instead.
 */
describe('recallFromArchiveByToolCallId (D26 exact-ID retrieval)', () => {
  // Hand-built eviction snapshots rather than `archiveEvictedToolResults`:
  // the archive's own id-dedupe prevents the real entry point from recording
  // the same call twice, so the scanner's newest-wins contract is exercised
  // on the persisted-legacy shape where duplicate ids CAN coexist.
  const evictionSnapshot = (
    archivedAt: number,
    entries: Array<{ toolCallId: string; stepIndex: number; body: string }>,
  ): ContextArchiveSnapshot => ({
    archivedAt,
    action: 'tool_result_eviction',
    keepRecentSteps: 0,
    steps: entries.map((entry) => entry.stepIndex),
    reason: 'deterministic tool-result eviction (stale recency)',
    messages: entries.map((entry) =>
      toolResult(entry.toolCallId, { output: entry.body }),
    ),
  })

  it('newest copy wins: the FULL newer body is returned, not a snippet cap', () => {
    // Bodies longer than RECALL_SNIPPET_CHARS make the full-body contract
    // distinguishable from the text path's snippet cap — and neither body
    // CONTAINS the id string, the exact case text search cannot resolve.
    const olderBody = `older-copy-start ${'a'.repeat(1_000)} older-copy-end`
    const newerBody = `newer-copy-start ${'b'.repeat(1_000)} newer-copy-end`
    const archiveSnapshots = [
      evictionSnapshot(10, [
        { toolCallId: 'dup-call', stepIndex: 4, body: olderBody },
      ]),
      evictionSnapshot(20, [
        { toolCallId: 'dup-call', stepIndex: 9, body: newerBody },
      ]),
    ]

    const result = recallFromArchiveByToolCallId(archiveSnapshots, 'dup-call')
    expect(result.matches).toHaveLength(1)
    expect(result.matches[0].toolCallId).toBe('dup-call')
    expect(result.matches[0].toolName).toBe('read_files')
    // The NEWEST snapshot's copy wins — the older body is never returned.
    expect(result.matches[0].snippet).toContain('newer-copy-start')
    expect(result.matches[0].snippet).not.toContain('older-copy')
    // FULL archived body, deliberately NOT capped at RECALL_SNIPPET_CHARS:
    // body recovery is the whole point (the tombstone left no other copy),
    // and the end marker survives well past the snippet bound.
    expect(result.matches[0].snippet.length).toBeGreaterThan(
      RECALL_SNIPPET_CHARS,
    )
    expect(result.matches[0].snippet).toContain('newer-copy-end')
    // Hit in the NEWEST snapshot: only that snapshot was visited.
    expect(result.snapshotsSearched).toBe(1)
    expect(result.archivedAt).toEqual([20, 10])
  })

  it('miss returns empty matches with snapshotsSearched = archive length', () => {
    const archiveSnapshots = [
      evictionSnapshot(10, [
        { toolCallId: 'call-a', stepIndex: 1, body: 'body-a' },
      ]),
      evictionSnapshot(20, [
        { toolCallId: 'call-b', stepIndex: 2, body: 'body-b' },
      ]),
    ]
    const result = recallFromArchiveByToolCallId(
      archiveSnapshots,
      'no-such-call',
    )
    expect(result.matches).toEqual([])
    // A miss means the WHOLE archive was searched.
    expect(result.snapshotsSearched).toBe(2)
    expect(result.archivedAt).toEqual([20, 10])
  })

  it('returns the empty result for a missing or empty archive', () => {
    expect(recallFromArchiveByToolCallId(undefined, 'any-call')).toEqual({
      matches: [],
      snapshotsSearched: 0,
      archivedAt: [],
    })
    expect(recallFromArchiveByToolCallId([], 'any-call')).toEqual({
      matches: [],
      snapshotsSearched: 0,
      archivedAt: [],
    })
  })

  it('reports the ORIGINAL-transcript step from the D26 steps provenance array', () => {
    const state: { compactionArchive?: ContextArchiveSnapshot[] } = {}
    archiveEvictedToolResults(
      state,
      [
        {
          toolCallId: 'prov-call',
          toolName: 'read_files',
          content: [
            { type: 'json', value: { output: 'provenance-body' } } as never,
          ],
          stepIndex: 7,
        },
      ],
      42,
    )
    const result = recallFromArchiveByToolCallId(
      state.compactionArchive,
      'prov-call',
    )
    expect(result.matches).toHaveLength(1)
    // NOT the slice-local index (0): the snapshot's steps[0] is 7 —
    // original-transcript numbering, exactly like the text path reports.
    expect(result.matches[0].step).toBe(7)
  })

  it('returns the stored body VERBATIM — never double-encoded (real-path regression)', () => {
    // archiveMessageWithCap normalizes object json values to their serialized
    // STRING at write time, so real-path archived bodies are strings; the FTS
    // projection (getArchiveRecallEntry.text) stringifies them a SECOND
    // time. The by-ID snippet must be the stored body byte-identical — the
    // tombstone promises the full ORIGINAL output, not a quote-escaped copy.
    const state: { compactionArchive?: ContextArchiveSnapshot[] } = {}
    archiveEvictedToolResults(
      state,
      [
        {
          toolCallId: 'verbatim-call',
          toolName: 'read_files',
          // Real-path shape: the archived body is the serialized json value.
          content: [
            {
              type: 'json',
              value: JSON.stringify({ output: 'verbatim-fact' }),
            } as never,
          ],
          stepIndex: 3,
        },
        {
          toolCallId: 'object-call',
          toolName: 'read_files',
          // Legacy/hand-built shape: an object value predating the
          // write-time normalization.
          content: [{ type: 'json', value: { output: 'object-fact' } } as never],
          stepIndex: 4,
        },
      ],
      42,
    )
    const verbatim = recallFromArchiveByToolCallId(
      state.compactionArchive,
      'verbatim-call',
    )
    expect(verbatim.matches).toHaveLength(1)
    expect(verbatim.matches[0].snippet).toBe(
      JSON.stringify({ output: 'verbatim-fact' }),
    )
    const object = recallFromArchiveByToolCallId(
      state.compactionArchive,
      'object-call',
    )
    expect(object.matches).toHaveLength(1)
    // Object values serialize exactly once — NOT the double-encoded FTS text.
    expect(object.matches[0].snippet).toBe(
      JSON.stringify({ output: 'object-fact' }),
    )
  })
})
