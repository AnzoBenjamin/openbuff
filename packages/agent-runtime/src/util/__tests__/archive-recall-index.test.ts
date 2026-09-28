import { describe, expect, it } from 'bun:test'

import {
  RECALL_MAX_RESULTS,
  RECALL_SNIPPET_CHARS,
  archiveEvictedToolResults,
  archivePreCompaction,
  recallFromArchive,
} from '../context-archive'
import {
  buildArchiveRecallRows,
  recallEmptyResultMessage,
  recallFromArchiveIndexed,
} from '../archive-recall-index'
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

const toolCall = (callId: string, path = 'src/file.ts'): Message => ({
  role: 'assistant',
  content: [
    {
      type: 'tool-call',
      toolCallId: callId,
      toolName: 'read_files',
      input: { paths: [path] },
    } as never,
  ],
})

const buildTranscript = (steps: number): Message[] => {
  const messages: Message[] = [
    { role: 'user', content: [{ type: 'text', text: 'go' }] } as Message,
  ]
  for (let i = 0; i < steps; i++) {
    messages.push(toolCall(`call-${i}`, `src/file-${i}.ts`))
    messages.push(toolResult(`call-${i}`, { output: `body-${i} keystone-fact-${i}` }))
  }
  return messages
}

/** The sanctioned deterministic index-failure seam (D27 fail-open). */
const throwingCreateDatabase = (message = 'fts5 unavailable in this build') => (
  _path: string,
) => {
  void _path
  throw new Error(message)
}

describe('buildArchiveRecallRows', () => {
  it('flattens tool messages across snapshots in archive order', () => {
    const state = archive(buildTranscript(3))
    const rows = buildArchiveRecallRows(state.compactionArchive)
    expect(rows).toHaveLength(3)
    expect(rows.map((r) => r.toolCallId)).toEqual(['call-0', 'call-1', 'call-2'])
    expect(rows[2].text).toContain('keystone-fact-2')
    expect(rows[2].archivedAt).toBe(state.compactionArchive![0].archivedAt)
    // Scanner-contract provenance (context-archive.ts `stepProvenance`, as
    // used by `recallFromArchive`): step = message index within its OWN
    // snapshot.messages (counting non-tool messages) + stepBase. The archived
    // tool results sit at slice-local indices 2, 4, 6 — the user message and
    // each assistant tool-call precede them — so [2, 4, 6] IS the scanner's
    // numbering. The former [0, 1, 2] expectation was a tool-message ordinal,
    // which contradicts the scanner for the same fixture.
    expect(rows.map((r) => r.step)).toEqual([2, 4, 6])
    // Parity with the scanner for the same archive+query: the indexed row step
    // must equal what `recallFromArchive` reports for the same message.
    const scanned = recallFromArchive(state.compactionArchive, 'keystone-fact-1')
    expect(scanned.matches).toHaveLength(1)
    expect(scanned.matches[0].toolCallId).toBe('call-1')
    expect(scanned.matches[0].step).toBe(rows[1].step)
  })

  it('includes eviction snapshots and honors their steps provenance', () => {
    const state: { compactionArchive?: ContextArchiveSnapshot[] } = {}
    archivePreCompaction(state, buildTranscript(2), 'semantic_compaction', 6)
    archiveEvictedToolResults(state, [
      {
        toolCallId: 'evict-a',
        toolName: 'read_files',
        content: [{ type: 'json', value: { output: 'evicted-fact' } } as never],
        stepIndex: 9,
      },
    ])
    const rows = buildArchiveRecallRows(state.compactionArchive)
    expect(rows).toHaveLength(3)
    const evictedRow = rows[2]
    expect(evictedRow.toolCallId).toBe('evict-a')
    // NOT the slice-local index (0 within the eviction snapshot): the D26
    // `steps` array carries the original-transcript step.
    expect(evictedRow.step).toBe(9)
    expect(evictedRow.text).toContain('evicted-fact')
  })

  it('is empty for a missing archive and skips non-tool messages', () => {
    expect(buildArchiveRecallRows(undefined)).toEqual([])
    expect(buildArchiveRecallRows([])).toEqual([])
    const rows = buildArchiveRecallRows([
      {
        archivedAt: 1,
        action: 'semantic_compaction',
        keepRecentSteps: 0,
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'noise' }] } as Message,
          toolResult('c1', { output: 'kept' }),
        ],
      },
    ])
    expect(rows).toHaveLength(1)
    expect(rows[0].toolCallId).toBe('c1')
  })
})

/**
 * D27: `recall_context` queries an FTS5 index over the compaction archive
 * instead of brute-force substring scans, and an empty result from a healthy
 * index is distinguishable from one produced by a failed index. The gate case
 * is the round-trip: facts archived before compaction (including D26 eviction
 * snapshots) are recallable through the index with the same provenance and
 * snippet shape as `recallFromArchive`.
 */
describe('recallFromArchiveIndexed (D27)', () => {
  it('D27 gate: seeded facts round-trip through the FTS5 index with provenance', async () => {
    const EVICTED_FACT = 'D27-EVICTED-FACT-2b9'
    const LIVE_FACT = 'D27-INDEXED-FACT-7c4'
    const state: { compactionArchive?: ContextArchiveSnapshot[] } = {}
    archivePreCompaction(
      state,
      [toolCall('live-call'), toolResult('live-call', { output: `${LIVE_FACT} trailing context` })],
      'semantic_compaction',
      6,
    )
    archiveEvictedToolResults(state, [
      {
        toolCallId: 'stale-call',
        toolName: 'read_files',
        content: [
          { type: 'json', value: { output: `${EVICTED_FACT} ${'x'.repeat(40_000)}` } as never },
        ],
        stepIndex: 5,
      },
    ])

    const evicted = await recallFromArchiveIndexed(
      state.compactionArchive,
      'D27-EVICTED-FACT',
    )
    expect(evicted.indexState).toBe('indexed')
    expect(evicted.indexError).toBeUndefined()
    expect(evicted.matches).toHaveLength(1)
    // Original-transcript step from the D26 `steps` array, not slice-local.
    expect(evicted.matches[0].step).toBe(5)
    expect(evicted.matches[0].toolCallId).toBe('stale-call')
    expect(evicted.matches[0].toolName).toBe('read_files')
    expect(evicted.matches[0].snippet).toContain(EVICTED_FACT)
    expect(evicted.matches[0].snippet.length).toBeLessThanOrEqual(RECALL_SNIPPET_CHARS)

    const live = await recallFromArchiveIndexed(state.compactionArchive, 'D27-INDEXED-FACT')
    expect(live.indexState).toBe('indexed')
    expect(live.matches).toHaveLength(1)
    expect(live.matches[0].toolCallId).toBe('live-call')
    // Scanner-contract provenance (context-archive.ts `stepProvenance`, the
    // same call `recallFromArchive` makes): the archived tool result sits at
    // within-snapshot index 1 (the assistant tool-call precedes it) with
    // stepBase 0, so the original-transcript step is 1. The former `toBe(0)`
    // expected a tool-message ordinal, contradicting the scanner for the same
    // fixture — asserted below as direct parity with `recallFromArchive`.
    expect(live.matches[0].step).toBe(1)
    expect(live.matches[0].step).toBe(
      recallFromArchive(state.compactionArchive, 'D27-INDEXED-FACT').matches[0]
        .step,
    )

    // Provenance: newest-snapshot-first timestamps, same as the scanner.
    expect(live.snapshotsSearched).toBe(state.compactionArchive!.length)
    expect(live.archivedAt).toEqual(
      [...state.compactionArchive!].reverse().map((s) => s.archivedAt),
    )
  })

  it('an empty result from a HEALTHY index carries no indexError (D27 distinction)', async () => {
    const state = archive([toolCall('c1'), toolResult('c1', { output: 'unrelated alpha content' })])
    const result = await recallFromArchiveIndexed(state.compactionArchive, 'zzz-nothing')
    expect(result.matches).toEqual([])
    expect(result.indexState).toBe('indexed')
    expect(result.indexError).toBeUndefined()
    // The guidance message has NO fallback note for a healthy empty index.
    expect(recallEmptyResultMessage(result)).not.toContain('substring scan')
  })

  it('a FAILED index falls back with a bounded indexError and scanner-identical matches', async () => {
    const state = archive([toolCall('c1'), toolResult('c1', { output: 'fallback-fact-body' })])
    const result = await recallFromArchiveIndexed(state.compactionArchive, 'fallback-fact', {
      createDatabase: throwingCreateDatabase(),
    })
    expect(result.indexState).toBe('fallback')
    expect(result.indexError).toBe('fts5 unavailable in this build')
    // Fallback results are byte-identical to the substring scanner's own.
    const scanner = recallFromArchive(state.compactionArchive, 'fallback-fact')
    expect(result.matches).toEqual(scanner.matches)
    expect(result.snapshotsSearched).toBe(scanner.snapshotsSearched)
    expect(result.archivedAt).toEqual(scanner.archivedAt)
    // The fallback note distinguishes this empty-ish outcome from a healthy
    // indexed empty result — THE D27 requirement.
    expect(recallEmptyResultMessage(result)).toContain(
      '(archive index unavailable, fell back to substring scan)',
    )
  })

  it('bounds indexError to 300 chars with no stack', async () => {
    const state = archive([toolCall('c1'), toolResult('c1', { output: 'fact' })])
    const result = await recallFromArchiveIndexed(state.compactionArchive, 'fact', {
      createDatabase: throwingCreateDatabase(`${'boom '.repeat(200)}\n    at stack frame`),
    })
    expect(result.indexState).toBe('fallback')
    expect(result.indexError!.length).toBeLessThanOrEqual(300)
    expect(result.indexError).not.toContain('at stack frame')
  })

  it('creates the index in memory only (createDatabase seam sees :memory:)', async () => {
    const paths: string[] = []
    const state = archive([toolCall('c1'), toolResult('c1', { output: 'fact' })])
    await recallFromArchiveIndexed(state.compactionArchive, 'fact', {
      createDatabase: (path) => {
        paths.push(path)
        throw new Error('stop after observing the path')
      },
    })
    expect(paths).toEqual([':memory:'])
  })

  it('falls back instead of building an index over an oversized row set', async () => {
    const huge: ContextArchiveSnapshot = {
      archivedAt: 1,
      action: 'semantic_compaction',
      keepRecentSteps: 0,
      messages: [toolResult('huge', { output: 'x'.repeat(17_000_000) })],
    }
    const result = await recallFromArchiveIndexed([huge], 'fact')
    expect(result.indexState).toBe('fallback')
    expect(result.indexError).toContain('exceeds')
    expect(result.indexError!.length).toBeLessThanOrEqual(300)
  })
})

describe('recallFromArchiveIndexed query sanitization', () => {
  const state = archive([
    toolCall('c1'),
    toolResult('c1', { output: 'keystone-fact-3 alpha (beta) --flagged' }),
  ])

  it('hostile-but-matchable queries still find their facts, indexed', async () => {
    for (const query of [
      'keystone-fact-3 (alpha)',
      'keystone-fact-3',
      'keystone "fact" 3',
      'keystone-fact-3 --flagged',
    ]) {
      const result = await recallFromArchiveIndexed(state.compactionArchive, query)
      expect(result.indexState).toBe('indexed')
      expect(result.matches).toHaveLength(1)
      expect(result.matches[0].snippet).toContain('keystone-fact-3')
    }
  })

  it('FTS5 operators and syntax never crash and never fall back on syntax', async () => {
    for (const query of ['AND', 'OR NOT', 'NEAR', '"quoted (phrase)"', '--flag', 'a-b', 'col:filter', '^x']) {
      const result = await recallFromArchiveIndexed(state.compactionArchive, query)
      // Sanitization prevents syntax errors: either a clean indexed result
      // (empty here — the terms do not appear in the archived text) or, for a
      // query with no FTS-expressible terms at all, an explicit fail-open.
      expect(['indexed', 'fallback']).toContain(result.indexState)
      expect(result.matches.length).toBeLessThanOrEqual(RECALL_MAX_RESULTS)
    }
    // AND semantics survive sanitization: both terms must match.
    const both = await recallFromArchiveIndexed(state.compactionArchive, 'alpha (beta)')
    expect(both.indexState).toBe('indexed')
    expect(both.matches).toHaveLength(1)
    const missingTerm = await recallFromArchiveIndexed(state.compactionArchive, 'alpha zzz')
    expect(missingTerm.indexState).toBe('indexed')
    expect(missingTerm.matches).toEqual([])
    expect(missingTerm.indexError).toBeUndefined()
  })

  it('is case-insensitive like the scanner and bounds results', async () => {
    const big = archive(buildTranscript(12), 'semantic_compaction', 0)
    const result = await recallFromArchiveIndexed(big.compactionArchive, 'KEYSTONE-FACT')
    expect(result.indexState).toBe('indexed')
    expect(result.matches.length).toBeGreaterThan(0)
    expect(result.matches.length).toBeLessThanOrEqual(RECALL_MAX_RESULTS)
  })
})

describe('recallFromArchiveIndexed ordering contract', () => {
  it('newest-snapshot-first: the same fact in a newer snapshot sorts first', async () => {
    const state: { compactionArchive?: ContextArchiveSnapshot[] } = {}
    archivePreCompaction(
      state,
      [toolCall('old-call'), toolResult('old-call', { output: 'twin-fact older copy' })],
      'semantic_compaction',
      6,
    )
    archivePreCompaction(
      state,
      [toolCall('new-call'), toolResult('new-call', { output: 'twin-fact newer copy' })],
      'mechanical_trim',
      6,
    )
    const result = await recallFromArchiveIndexed(state.compactionArchive, 'twin-fact')
    expect(result.indexState).toBe('indexed')
    expect(result.matches).toHaveLength(2)
    expect(result.matches[0].toolCallId).toBe('new-call')
    expect(result.matches[1].toolCallId).toBe('old-call')
    expect(result.archivedAt).toEqual([
      state.compactionArchive![1].archivedAt,
      state.compactionArchive![0].archivedAt,
    ])
  })

  it('newest-message-first within a snapshot', async () => {
    const state = archive([
      toolCall('early-call'),
      toolResult('early-call', { output: 'dupe-fact early' }),
      toolCall('late-call'),
      toolResult('late-call', { output: 'dupe-fact late' }),
    ])
    const result = await recallFromArchiveIndexed(state.compactionArchive, 'dupe-fact')
    expect(result.matches.map((m) => m.toolCallId)).toEqual(['late-call', 'early-call'])
  })
})

describe('recallFromArchiveIndexed RecallContextResult shape compatibility', () => {
  // Mirrors every assertion pattern from the `recallFromArchive` suite so the
  // indexed result is provably a drop-in for the existing contract.
  const archiveState = archive(buildTranscript(8))
  const snapshots = archiveState.compactionArchive

  it('finds a planted fact across snapshots (AND semantics)', async () => {
    const result = await recallFromArchiveIndexed(snapshots, 'keystone-fact-3')
    expect(result.matches).toHaveLength(1)
    expect(result.matches[0].toolName).toBe('read_files')
    expect(result.matches[0].snippet).toContain('keystone-fact-3')
    expect(result.snapshotsSearched).toBe(1)
  })

  it('requires every term to match', async () => {
    expect(
      (await recallFromArchiveIndexed(snapshots, 'keystone-fact-2 body-2')).matches,
    ).toHaveLength(1)
    expect(
      (await recallFromArchiveIndexed(snapshots, 'keystone-fact-2 body-99')).matches,
    ).toHaveLength(0)
  })

  it('handles an empty or missing archive without throwing', async () => {
    const missing = await recallFromArchiveIndexed(undefined, 'anything')
    expect(missing.matches).toEqual([])
    expect(missing.snapshotsSearched).toBe(0)
    expect(missing.archivedAt).toEqual([])
    expect(missing.indexState).toBe('indexed')
    const none = await recallFromArchiveIndexed([], 'anything')
    expect(none.snapshotsSearched).toBe(0)
    const blank = await recallFromArchiveIndexed(snapshots, '   ')
    expect(blank.matches).toEqual([])
    expect(blank.indexState).toBe('indexed')
  })

  it('reports original-transcript steps for eviction snapshots', async () => {
    const state: { compactionArchive?: ContextArchiveSnapshot[] } = {}
    archiveEvictedToolResults(state, [
      {
        toolCallId: 'call-a',
        toolName: 'read_files',
        content: [{ type: 'json', value: { output: 'alpha-fact' } } as never],
        stepIndex: 3,
      },
      {
        toolCallId: 'call-b',
        toolName: 'read_files',
        content: [{ type: 'json', value: { output: 'beta-fact' } } as never],
        stepIndex: 7,
      },
    ])
    const result = await recallFromArchiveIndexed(state.compactionArchive, 'beta-fact')
    expect(result.indexState).toBe('indexed')
    expect(result.matches).toHaveLength(1)
    // NOT the slice-local index (1): the snapshot's `steps[1]` is 7.
    expect(result.matches[0].step).toBe(7)
    expect(result.matches[0].toolCallId).toBe('call-b')
  })

  it('round-trips an evicted fact exactly like the scanner (D26 parity)', async () => {
    const FACT = 'DE26-RECALLABLE-FACT-9f2'
    const messages: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'go' }] } as Message,
      toolCall('stale-call'),
      toolResult('stale-call', { output: `${FACT} ${'x'.repeat(40_000)}` }),
    ]
    const result = evictStaleToolResults(messages, { keepRecentSteps: 0 })
    expect(result.evicted).toHaveLength(1)
    const state: { compactionArchive?: ContextArchiveSnapshot[] } = {}
    archiveEvictedToolResults(state, result.evicted!)

    const indexed = await recallFromArchiveIndexed(state.compactionArchive, 'DE26-RECALLABLE-FACT')
    const scanner = recallFromArchive(state.compactionArchive, 'DE26-RECALLABLE-FACT')
    expect(indexed.indexState).toBe('indexed')
    expect(indexed.matches).toEqual(scanner.matches)
    expect(indexed.matches[0].snippet).toContain(FACT)
  })

  it('fails open identically when bun:sqlite is unavailable (sanctioned seam)', async () => {
    const state = archive(buildTranscript(8))
    // A blank query short-circuits BEFORE the index is built, so it is not a
    // fallback case — covered in the shape-compat suite above.
    const queries = ['keystone-fact-3', 'keystone-fact-2 body-99']
    for (const query of queries) {
      const result = await recallFromArchiveIndexed(state.compactionArchive, query, {
        createDatabase: throwingCreateDatabase('no sqlite in this runtime'),
      })
      const scanner = recallFromArchive(state.compactionArchive, query)
      expect(result.indexState).toBe('fallback')
      expect(result.matches).toEqual(scanner.matches)
      expect(result.snapshotsSearched).toBe(scanner.snapshotsSearched)
      expect(result.archivedAt).toEqual(scanner.archivedAt)
    }
  })
})

describe('recallEmptyResultMessage (D27)', () => {
  it('appends the fallback note ONLY when the index fell back', () => {
    const indexed = recallEmptyResultMessage({ indexState: 'indexed' })
    expect(indexed).toContain('No archived pre-compaction content matched')
    expect(indexed).not.toContain('substring scan')

    const fallback = recallEmptyResultMessage({ indexState: 'fallback' })
    expect(fallback).toContain('No archived pre-compaction content matched')
    expect(fallback).toContain('(archive index unavailable, fell back to substring scan)')
  })
})
