import { describe, expect, test } from 'bun:test'

import {
  buildDiscoveryQuestion,
  claimDiscoveryShard,
  completeDiscoveryShard,
  planDiscoveryBatch,
  reconcileInterruptedDiscoveryShards,
  recordDiscoveryResult,
} from '../discovery-coordinator'

describe('discovery coordinator', () => {
  test('derives a stable non-empty question for params-only discovery agents', () => {
    const first = buildDiscoveryQuestion({
      agentType: 'file-picker',
      spawnParams: {
        searchQueries: [
          { cwd: 'server/src', flags: '-g *.test.ts', pattern: 'worker' },
        ],
      },
    })
    const reordered = buildDiscoveryQuestion({
      agentType: 'file-picker',
      spawnParams: {
        searchQueries: [
          { pattern: 'worker', flags: '-g *.test.ts', cwd: 'server/src' },
        ],
      },
    })

    expect(first).toBe(reordered)
    expect(first).toContain('worker')
    expect(first.length).toBeGreaterThan(0)
  })

  test('never records an empty shard question', () => {
    const claimed = claimDiscoveryShard({
      agentType: 'file-picker',
      question: '   ',
      workspaceRevision: 1,
    })

    expect(claimed.state.shards[0].question).toBe('file-picker discovery')
  })

  test('deduplicates candidates and merges evidence reasons', () => {
    const state = planDiscoveryBatch({
      query: 'find parser files',
      workspaceRevision: 1,
      result: {
        relatedFiles: ['src/parser.ts', './src/parser.ts:42'],
        matchedSnippets: [{ path: 'src/parser.ts' }, { file: 'src/token.ts' }],
        ignored: 'not a path',
      },
    })

    expect(state.candidates.map((candidate) => candidate.path)).toEqual([
      'src/parser.ts',
      'src/token.ts',
    ])
    expect(state.candidates[0].reasons).toEqual(['relatedFiles', 'path'])
    expect(state.unresolvedGaps).toEqual(['src/parser.ts', 'src/token.ts'])
  })

  test('marks omitted candidates stale after a workspace revision change', () => {
    const initial = planDiscoveryBatch({
      query: 'parser',
      workspaceRevision: 1,
      result: ['src/parser.ts', 'src/token.ts'],
    })
    initial.candidates = initial.candidates.map((candidate) => ({
      ...candidate,
      verified: true,
    }))

    const refreshed = planDiscoveryBatch({
      existing: initial,
      query: 'parser',
      workspaceRevision: 2,
      result: ['src/parser.ts'],
    })

    expect(
      refreshed.candidates.find((item) => item.path === 'src/parser.ts'),
    ).toMatchObject({
      stale: false,
      workspaceRevision: 2,
    })
    expect(
      refreshed.candidates.find((item) => item.path === 'src/token.ts'),
    ).toMatchObject({
      stale: true,
      workspaceRevision: 1,
    })
    expect(refreshed.unresolvedGaps).toEqual(['src/token.ts'])
  })

  test('stales unattested candidates when the workspace revision becomes known', () => {
    const initial = planDiscoveryBatch({
      query: 'parser',
      result: ['src/legacy.ts'],
    })
    initial.candidates[0].verified = true

    const refreshed = planDiscoveryBatch({
      existing: initial,
      query: 'parser',
      workspaceRevision: 1,
      result: [],
    })

    expect(refreshed.candidates[0]).toMatchObject({
      path: 'src/legacy.ts',
      stale: true,
      workspaceRevision: undefined,
    })
    expect(refreshed.unresolvedGaps).toEqual(['src/legacy.ts'])
  })

  test('rejects semantically duplicate active and completed shards', () => {
    const claimed = claimDiscoveryShard({
      agentType: 'file-picker',
      question: 'auth parser',
      workspaceRevision: 3,
    })

    expect(() =>
      claimDiscoveryShard({
        existing: claimed.state,
        agentType: 'file-picker',
        question: 'parser auth',
        workspaceRevision: 3,
      }),
    ).toThrow('Duplicate discovery shard')

    const completed = completeDiscoveryShard({
      existing: claimed.state,
      shardKey: claimed.shardKey,
      status: 'completed',
    })
    expect(() =>
      claimDiscoveryShard({
        existing: completed,
        agentType: 'file-picker',
        question: 'parser auth',
        workspaceRevision: 3,
      }),
    ).toThrow('already completed')
  })

  test('allows a failed shard to be retried and records completion', () => {
    const claimed = claimDiscoveryShard({
      agentType: 'file-picker',
      question: 'mutation broker',
      workspaceRevision: 4,
    })
    const failed = completeDiscoveryShard({
      existing: claimed.state,
      shardKey: claimed.shardKey,
      status: 'failed',
    })
    const retried = claimDiscoveryShard({
      existing: failed,
      agentType: 'file-picker',
      question: 'broker mutation',
      workspaceRevision: 4,
    })

    expect(failed?.shards[0]).toMatchObject({ status: 'failed' })
    expect(failed?.shards[0].completedAt).toBeNumber()
    expect(retried.shardKey).toBe(claimed.shardKey)
    expect(retried.state.shards).toHaveLength(2)
  })

  test('reconciles a shard left active by an interrupted spawn so it can be reclaimed', () => {
    const claimed = claimDiscoveryShard({
      agentType: 'file-picker',
      question: 'interrupted question',
      workspaceRevision: 5,
    })
    // Without reconciliation the still-active claim makes every later claim for
    // this question throw, which fails the whole spawn batch.
    expect(() =>
      claimDiscoveryShard({
        existing: claimed.state,
        agentType: 'file-picker',
        question: 'question interrupted',
        workspaceRevision: 5,
      }),
    ).toThrow('Duplicate discovery shard')

    const reconciled = reconcileInterruptedDiscoveryShards(claimed.state)!

    expect(reconciled.shards[0]).toMatchObject({ status: 'interrupted' })
    expect(reconciled.shards[0].completedAt).toBeNumber()
    expect(reconciled.revision).toBe(claimed.state.revision + 1)
    expect(() =>
      claimDiscoveryShard({
        existing: reconciled,
        agentType: 'file-picker',
        question: 'question interrupted',
        workspaceRevision: 5,
      }),
    ).not.toThrow()
  })

  test('taskId and workspaceSnapshotId appear in the shard record after claim', () => {
    const claimed = claimDiscoveryShard({
      agentType: 'file-picker',
      question: 'identity fields',
      workspaceRevision: 10,
      taskId: 'task-abc-123',
      workspaceSnapshotId: 'snap-xyz-789',
    })

    expect(claimed.state.shards[0].taskId).toBe('task-abc-123')
    expect(claimed.state.workspaceSnapshotId).toBe('snap-xyz-789')
  })

  test('different taskIds produce different shard keys for the same question', () => {
    const claimA = claimDiscoveryShard({
      agentType: 'file-picker',
      question: 'same question',
      workspaceRevision: 1,
      taskId: 'task-a',
    })
    const claimB = claimDiscoveryShard({
      agentType: 'file-picker',
      question: 'same question',
      workspaceRevision: 1,
      taskId: 'task-b',
    })

    expect(claimA.shardKey).not.toBe(claimB.shardKey)
  })

  test('workspaceSnapshotId is carried through planDiscoveryBatch', () => {
    const state = planDiscoveryBatch({
      query: 'snapshot batch',
      result: ['src/file.ts'],
      workspaceRevision: 1,
      workspaceSnapshotId: 'snap-batch-001',
    })

    expect(state.workspaceSnapshotId).toBe('snap-batch-001')
  })

  test('leaves settled shards and missing coverage untouched', () => {
    const claimed = claimDiscoveryShard({
      agentType: 'file-picker',
      question: 'settled question',
      workspaceRevision: 6,
    })
    const completed = completeDiscoveryShard({
      existing: claimed.state,
      shardKey: claimed.shardKey,
      status: 'completed',
    })!

    // Idempotent: nothing is active, so the same state comes back without
    // revision churn (and an absent coverage state stays absent).
    expect(reconcileInterruptedDiscoveryShards(completed)).toBe(completed)
    expect(reconcileInterruptedDiscoveryShards(undefined)).toBeUndefined()

    const reconciledOnce = reconcileInterruptedDiscoveryShards(claimed.state)!
    expect(reconcileInterruptedDiscoveryShards(reconciledOnce)).toBe(
      reconciledOnce,
    )
  })

  test('recordDiscoveryResult delegates to planDiscoveryBatch and returns updated coverage', () => {
    const initial = planDiscoveryBatch({
      query: 'initial search',
      workspaceRevision: 1,
      result: ['src/existing.ts'],
    })

    const updated = recordDiscoveryResult({
      existing: initial,
      agentType: 'file-picker',
      question: 'find auth files',
      result: { files: ['src/auth.ts', 'src/login.ts'] },
      workspaceRevision: 2,
      workspaceSnapshotId: 'snap-001',
    })

    expect(updated.candidates.map((c) => c.path)).toContain('src/auth.ts')
    expect(updated.candidates.map((c) => c.path)).toContain('src/login.ts')
    expect(updated.workspaceRevision).toBe(2)
    expect(updated.workspaceSnapshotId).toBe('snap-001')
    expect(updated.revision).toBeGreaterThan(initial.revision)
  })

  test('recordDiscoveryResult works without existing coverage', () => {
    const result = recordDiscoveryResult({
      agentType: 'file-lister',
      question: 'list test files',
      result: ['tests/auth.test.ts'],
      workspaceRevision: 1,
    })

    expect(result.candidates).toHaveLength(1)
    expect(result.candidates[0].path).toBe('tests/auth.test.ts')
  })
})
