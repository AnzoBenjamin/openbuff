import { describe, expect, test } from 'bun:test'

import {
  buildDiscoveryQuestion,
  claimDiscoveryShard,
  completeDiscoveryShard,
  evaluateMemoryCover,
  planDiscoveryBatch,
  reconcileInterruptedDiscoveryShards,
  recordDiscoveryResult,
  recordMemoryReuse,
  tryClaimDiscoveryShard,
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

  test('completed shard with different workspaceSnapshotId allows re-claim', () => {
    const first = claimDiscoveryShard({
      agentType: 'file-picker',
      question: 'find tests',
      workspaceRevision: 1,
      taskId: 'task-1',
      workspaceSnapshotId: 'snap-1',
    })
    const completed = completeDiscoveryShard({
      existing: first.state,
      shardKey: first.shardKey,
      status: 'completed',
    })!
    // Same task, different workspace snapshot → should allow re-claim
    expect(() =>
      claimDiscoveryShard({
        existing: completed,
        agentType: 'file-picker',
        question: 'find tests',
        workspaceRevision: 1,
        taskId: 'task-1',
        workspaceSnapshotId: 'snap-2',
      }),
    ).not.toThrow()
  })

  test('completed shard with same identity still suppresses re-claim', () => {
    const first = claimDiscoveryShard({
      agentType: 'file-picker',
      question: 'find tests',
      workspaceRevision: 1,
      taskId: 'task-1',
      workspaceSnapshotId: 'snap-1',
    })
    const completed = completeDiscoveryShard({
      existing: first.state,
      shardKey: first.shardKey,
      status: 'completed',
    })!
    // Same task, same workspace snapshot → should throw
    expect(() =>
      claimDiscoveryShard({
        existing: completed,
        agentType: 'file-picker',
        question: 'find tests',
        workspaceRevision: 1,
        taskId: 'task-1',
        workspaceSnapshotId: 'snap-1',
      }),
    ).toThrow(/Duplicate discovery shard/)
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

  test('evaluateMemoryCover skips on full cover', () => {
    const evaluation = evaluateMemoryCover({
      excerpts: [{ path: 'src/auth/login.ts', excerpt: 'login' }],
      pathPrefixes: ['src/auth'],
      query: 'authentication',
    })

    expect(evaluation.decision).toBe('skip')
    expect(evaluation.remainingGaps).toEqual([])
    expect(evaluation.coveringExcerpts.map((entry) => entry.path)).toContain(
      'src/auth/login.ts',
    )
  })

  test('evaluateMemoryCover narrows on partial cover', () => {
    const evaluation = evaluateMemoryCover({
      excerpts: [{ path: 'src/auth/login.ts', excerpt: 'login' }],
      pathPrefixes: ['src/auth', 'src/other'],
      query: 'authentication',
    })

    expect(evaluation.decision).toBe('narrow')
    expect(evaluation.remainingGaps).toEqual(['src/other'])
    expect(evaluation.coveringExcerpts).toHaveLength(1)
  })

  test('evaluateMemoryCover goes full on stale revision', () => {
    const evaluation = evaluateMemoryCover({
      excerpts: [
        { path: 'src/auth/login.ts', excerpt: 'login', workspaceRevision: 1 },
      ],
      pathPrefixes: ['src/auth'],
      query: 'authentication',
      workspaceRevision: 2,
    })

    expect(evaluation.decision).toBe('full')
    expect(evaluation.coveringExcerpts).toEqual([])
  })

  test('evaluateMemoryCover goes full on stale index snapshot', () => {
    const evaluation = evaluateMemoryCover({
      excerpts: [{ path: 'src/auth/login.ts', excerpt: 'login' }],
      pathPrefixes: ['src/auth'],
      query: 'authentication',
      indexSnapshotId: 'index-new',
      existingIndexSnapshotId: 'index-old',
    })

    expect(evaluation.decision).toBe('full')
    expect(evaluation.reason).toBe('stale-index-snapshot')
  })

  test('evaluateMemoryCover goes full without cover', () => {
    expect(
      evaluateMemoryCover({ pathPrefixes: ['src/auth'], query: 'auth' })
        .decision,
    ).toBe('full')
    expect(
      evaluateMemoryCover({
        excerpts: [{ path: 'src/auth/login.ts' }],
      }).decision,
    ).toBe('full')
  })

  test('tryClaimDiscoveryShard returns duplicate receipt instead of throwing', () => {
    const first = tryClaimDiscoveryShard({
      agentType: 'query_index',
      question: 'find auth files',
      workspaceRevision: 1,
      taskId: 'task-1',
    })
    expect(first.duplicate).toBe(false)
    expect(first.shardKey).toHaveLength(24)

    const second = tryClaimDiscoveryShard({
      existing: first.state,
      agentType: 'query_index',
      question: 'find auth files',
      workspaceRevision: 1,
      taskId: 'task-1',
    })
    expect(second.duplicate).toBe(true)
    expect(second.shardKey).toBe(first.shardKey)
    expect(second.state).toBe(first.state)
  })

  test('claimDiscoveryShard throw semantics unchanged', () => {
    const claimed = claimDiscoveryShard({
      agentType: 'file-picker',
      question: 'throw check',
      workspaceRevision: 9,
    })
    expect(() =>
      claimDiscoveryShard({
        existing: claimed.state,
        agentType: 'file-picker',
        question: 'check throw',
        workspaceRevision: 9,
      }),
    ).toThrow(/Duplicate discovery shard/)
  })
})

describe('recordMemoryReuse', () => {
  test('lazily initializes a zeroed receipt on first call', () => {
    const state: Parameters<typeof recordMemoryReuse>[0] = {}

    recordMemoryReuse(state, {
      tool: 'code_search',
      decision: 'full',
      served: 0,
      gaps: 0,
    })

    expect(state.memoryReuse).toEqual({
      schemaVersion: 1,
      turnId: '',
      skip: 0,
      narrow: 0,
      full: 1,
      recordsServed: 0,
      gapsRemaining: 0,
      recordedDecisions: 0,
      conceptExpanded: 0,
      byTool: [{ tool: 'code_search', decision: 'full', served: 0, gaps: 0 }],
    })
  })

  test('skip increments skip and adds served to recordsServed', () => {
    const state: Parameters<typeof recordMemoryReuse>[0] = {}

    recordMemoryReuse(state, {
      tool: 'query_index',
      decision: 'skip',
      served: 5,
      gaps: 0,
    })

    expect(state.memoryReuse!.skip).toBe(1)
    expect(state.memoryReuse!.recordsServed).toBe(5)
  })

  test('narrow increments narrow and adds served to recordsServed', () => {
    const state: Parameters<typeof recordMemoryReuse>[0] = {}

    recordMemoryReuse(state, {
      tool: 'query_index',
      decision: 'narrow',
      served: 3,
      gaps: 0,
    })

    expect(state.memoryReuse!.narrow).toBe(1)
    expect(state.memoryReuse!.recordsServed).toBe(3)
  })

  test('full increments full and does NOT add served to recordsServed', () => {
    const state: Parameters<typeof recordMemoryReuse>[0] = {}

    recordMemoryReuse(state, {
      tool: 'glob',
      decision: 'full',
      served: 7,
      gaps: 0,
    })

    expect(state.memoryReuse!.full).toBe(1)
    expect(state.memoryReuse!.recordsServed).toBe(0)
  })

  test('gaps accumulate into gapsRemaining for every decision', () => {
    const state: Parameters<typeof recordMemoryReuse>[0] = {}

    recordMemoryReuse(state, {
      tool: 'a',
      decision: 'skip',
      served: 0,
      gaps: 2,
    })
    recordMemoryReuse(state, {
      tool: 'b',
      decision: 'narrow',
      served: 0,
      gaps: 3,
    })
    recordMemoryReuse(state, {
      tool: 'c',
      decision: 'full',
      served: 0,
      gaps: 4,
    })

    expect(state.memoryReuse!.gapsRemaining).toBe(9)
  })

  test('recordedDecisions accumulate and default to 0 when omitted', () => {
    const state: Parameters<typeof recordMemoryReuse>[0] = {}

    recordMemoryReuse(state, {
      tool: 'a',
      decision: 'skip',
      served: 0,
      gaps: 0,
      recordedDecisions: 4,
    })
    recordMemoryReuse(state, {
      tool: 'b',
      decision: 'skip',
      served: 0,
      gaps: 0,
    })
    recordMemoryReuse(state, {
      tool: 'c',
      decision: 'skip',
      served: 0,
      gaps: 0,
      recordedDecisions: 6,
    })

    expect(state.memoryReuse!.recordedDecisions).toBe(10)
  })

  test('each call appends one byTool entry with the tool sliced to 64 chars', () => {
    const state: Parameters<typeof recordMemoryReuse>[0] = {}
    const longTool = 'x'.repeat(100)

    recordMemoryReuse(state, {
      tool: longTool,
      decision: 'narrow',
      served: 2,
      gaps: 1,
    })

    expect(state.memoryReuse!.byTool).toHaveLength(1)
    expect(state.memoryReuse!.byTool![0]).toEqual({
      tool: 'x'.repeat(64),
      decision: 'narrow',
      served: 2,
      gaps: 1,
    })
  })

  test('byTool is capped at 32 while top-level counters keep incrementing', () => {
    const state: Parameters<typeof recordMemoryReuse>[0] = {}

    for (let i = 0; i < 33; i++) {
      recordMemoryReuse(state, {
        tool: `tool-${i}`,
        decision: 'skip',
        served: 1,
        gaps: 0,
      })
    }

    expect(state.memoryReuse!.byTool).toHaveLength(32)
    expect(state.memoryReuse!.skip).toBe(33)
    expect(state.memoryReuse!.recordsServed).toBe(33)
  })

  test('is deterministic across independent states for the same ordered sequence', () => {
    const entries: Parameters<typeof recordMemoryReuse>[1][] = [
      { tool: 'code_search', decision: 'skip', served: 5, gaps: 1, recordedDecisions: 2 },
      { tool: 'glob', decision: 'narrow', served: 3, gaps: 2 },
      { tool: 'query_index', decision: 'full', served: 9, gaps: 4, recordedDecisions: 1 },
    ]

    const stateA: Parameters<typeof recordMemoryReuse>[0] = {}
    const stateB: Parameters<typeof recordMemoryReuse>[0] = {}
    for (const entry of entries) {
      recordMemoryReuse(stateA, entry)
      recordMemoryReuse(stateB, entry)
    }

    expect(stateA.memoryReuse).toEqual(stateB.memoryReuse)
  })

  test('floors negative and fractional served/gaps to non-negative integers', () => {
    const state: Parameters<typeof recordMemoryReuse>[0] = {}

    recordMemoryReuse(state, {
      tool: 'code_search',
      decision: 'skip',
      served: 4.9,
      gaps: -3,
    })

    expect(state.memoryReuse!.recordsServed).toBe(4)
    expect(state.memoryReuse!.gapsRemaining).toBe(0)
    expect(state.memoryReuse!.byTool![0]).toEqual({
      tool: 'code_search',
      decision: 'skip',
      served: 4,
      gaps: 0,
    })
  })
})
