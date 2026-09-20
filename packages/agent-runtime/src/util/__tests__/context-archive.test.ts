import { describe, expect, it } from 'bun:test'

import {
  MAX_ARCHIVE_MESSAGES,
  MAX_ARCHIVE_SNAPSHOTS,
  archivePreCompaction,
  recallFromArchive,
} from '../context-archive'

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
