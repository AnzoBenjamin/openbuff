import {
  afterAll,
  afterEach,
  describe,
  expect,
  it,
  mock,
  test,
} from 'bun:test'

import {
  MAX_CONSOLIDATIONS,
  MAX_SNAPSHOTS_PER_RUN,
  buildConsolidationPrompt,
  extractLastText,
  recordConsolidation,
  searchConsolidations,
  selectUnconsolidatedSnapshots,
} from '../context-consolidation'
import { archivePreCompaction } from '../context-archive'
import { maybeRunBackgroundConsolidation } from '../context-consolidation-runner'
import { handleRecallContext } from '../../tools/handlers/tool/recall-context'

import type { ContextArchiveSnapshot } from '@codebuff/common/types/context-archive'
import type { ContextConsolidation } from '@codebuff/common/types/context-consolidation'
import type { CodebuffToolCall } from '@codebuff/common/tools/list'
import type { AgentState } from '@codebuff/common/types/session-state'
import type { Message, ToolMessage } from '@codebuff/common/types/messages/codebuff-message'

const snapshot = (archivedAt: number, steps = 1): ContextArchiveSnapshot => ({
  archivedAt,
  action: 'semantic_compaction',
  keepRecentSteps: 6,
  stepBase: 0,
  messages: [
    {
      role: 'assistant',
      content: [{ type: 'tool-call', toolCallId: `c-${archivedAt}`, toolName: 'read_files', input: { paths: [`src/f-${archivedAt}.ts`] } }],
    } as Message,
    {
      role: 'tool',
      toolCallId: `c-${archivedAt}`,
      toolName: 'read_files',
      content: [{ type: 'json', value: { output: `body keystone-${archivedAt}` } }],
    } as ToolMessage,
  ].slice(0, steps * 2),
})

describe('selectUnconsolidatedSnapshots', () => {
  it('picks uncovered snapshots oldest-first, capped per run', () => {
    const archive = [11, 12, 13, 14, 15].map((t) => snapshot(t))
    const picked = selectUnconsolidatedSnapshots(archive, [])
    expect(picked.map((s) => s.archivedAt)).toEqual([11, 12, 13])
    expect(picked.length).toBeLessThanOrEqual(MAX_SNAPSHOTS_PER_RUN)
  })
  it('skips snapshots a stored consolidation already covers', () => {
    const archive = [11, 12, 13].map((t) => snapshot(t))
    const consolidations = [{ consolidatedAt: 99, sourceArchivedAts: [11], action: 'semantic_compaction', summary: 's', coveredMessages: 2 } as ContextConsolidation]
    expect(selectUnconsolidatedSnapshots(archive, consolidations).map((s) => s.archivedAt)).toEqual([12, 13])
  })
  it('is empty for missing/empty archives', () => {
    expect(selectUnconsolidatedSnapshots(undefined, undefined)).toEqual([])
    expect(selectUnconsolidatedSnapshots([], [])).toEqual([])
  })
  it('tracks coverage per occurrence, not per timestamp', () => {
    // Two snapshots archived in the same millisecond share archivedAt.
    const archive = [50, 50, 51].map((t) => snapshot(t))
    const consolidations = [
      { consolidatedAt: 99, sourceArchivedAts: [50], action: 'semantic_compaction', summary: 's', coveredMessages: 2 } as ContextConsolidation,
    ]
    // Only ONE of the two same-timestamp snapshots is covered; the other
    // must still be picked so it eventually gets consolidated.
    const picked = selectUnconsolidatedSnapshots(archive, consolidations)
    expect(picked.map((s) => s.archivedAt)).toEqual([50, 51])
  })
  it('marks all same-timestamp snapshots covered only after enough occurrences', () => {
    const archive = [50, 50].map((t) => snapshot(t))
    const consolidations = [
      { consolidatedAt: 99, sourceArchivedAts: [50, 50], action: 'semantic_compaction', summary: 's', coveredMessages: 4 } as ContextConsolidation,
    ]
    expect(selectUnconsolidatedSnapshots(archive, consolidations)).toEqual([])
  })
})

describe('archivePreCompaction archivedAt collision safety (M3-T4)', () => {
  it('mints distinct archivedAt values when multiple snapshots archive in the same tick', () => {
    // Two DIFFERENT transcripts archived back-to-back within the same
    // millisecond (as when a semantic pass and a mechanical trim run in one
    // iteration). Coverage/provenance are keyed per archivedAt, so duplicate
    // timestamps would mark both snapshots covered off one consolidation.
    const state: { compactionArchive?: ContextArchiveSnapshot[] } = {}
    const first: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'first' }] },
    ]
    const second: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'second' }] },
    ]
    archivePreCompaction(state, first, 'semantic_compaction', 6)
    archivePreCompaction(state, second, 'mechanical_trim', 6)

    const archive = state.compactionArchive!
    expect(archive).toHaveLength(2)
    const ids = archive.map((s) => s.archivedAt)
    expect(new Set(ids).size).toBe(2)
    // Monotonic: the second mint is strictly after the first.
    expect(ids[1]).toBeGreaterThan(ids[0])
  })

  it('keeps every stored snapshot unique even across MAX_ARCHIVE_SNAPSHOTS same-tick archives', () => {
    const state: { compactionArchive?: ContextArchiveSnapshot[] } = {}
    for (let i = 0; i < 12; i++) {
      archivePreCompaction(
        state,
        [{ role: 'user', content: [{ type: 'text', text: `m-${i}` }] } as Message],
        'mechanical_trim',
        6,
      )
    }
    const archive = state.compactionArchive!
    expect(archive).toHaveLength(8) // capped at MAX_ARCHIVE_SNAPSHOTS
    expect(new Set(archive.map((s) => s.archivedAt)).size).toBe(8)
  })
})

describe('buildConsolidationPrompt', () => {
  it('wraps newest-first transcript content between markers', () => {
    const prompt = buildConsolidationPrompt([snapshot(11), snapshot(12)])
    expect(prompt.startsWith('Summarize the following removed transcript content')).toBe(true)
    expect(prompt).toContain('<removed-transcript>')
    expect(prompt).toContain('keystone-11')
    expect(prompt).toContain('keystone-12')
  })
})

describe('extractLastText', () => {
  it('returns the last assistant text and empty for none', () => {
    const messages: Message[] = [
      { role: 'assistant', content: [{ type: 'text', text: 'draft' }] },
      { role: 'tool', toolCallId: 'x', toolName: 'read_files', content: [{ type: 'json', value: {} }] },
      { role: 'assistant', content: [{ type: 'text', text: 'final summary' }] },
    ]
    expect(extractLastText(messages)).toBe('final summary')
    expect(extractLastText([])).toBe('')
  })
})

describe('recordConsolidation', () => {
  it('appends capped by count and summary length', () => {
    const state: { contextConsolidations?: ContextConsolidation[] } = {}
    for (let i = 0; i < MAX_CONSOLIDATIONS + 2; i++) {
      recordConsolidation(state, { consolidatedAt: i, sourceArchivedAts: [i], action: 'semantic_compaction', summary: 'x'.repeat(9_000), coveredMessages: 2 })
    }
    expect(state.contextConsolidations!.length).toBe(MAX_CONSOLIDATIONS)
    expect(state.contextConsolidations![0].consolidatedAt).toBe(2)
  })
})

describe('searchConsolidations', () => {
  const consolidations: ContextConsolidation[] = [
    { consolidatedAt: 1, sourceArchivedAts: [11], action: 'semantic_compaction', summary: 'Refactored the eviction floor in src/a.ts; kept retries.', coveredMessages: 4 },
    { consolidatedAt: 2, sourceArchivedAts: [12], action: 'mechanical_trim', summary: 'Discussed token refresh cadence for the scheduler.', coveredMessages: 2 },
  ]
  it('OR-ranks by matched terms; ties stay newest-first', () => {
    // Unambiguous winner: two terms beat one.
    const hits = searchConsolidations(consolidations, 'eviction kept')
    expect(hits).toHaveLength(1)
    expect(hits[0].consolidatedAt).toBe(1)
    expect(hits[0].action).toBe('semantic_compaction')
    expect(hits[0].sourceArchivedAts).toEqual([11])
    expect(hits[0].coveredMessages).toBe(4)
    // One term matching both = a tie: insertion order (newest first) wins.
    const tied = searchConsolidations(consolidations, 'the')
    expect(tied.map((h) => h.consolidatedAt)).toEqual([2, 1])
  })
  it('is empty for no archive, no terms, and no matches', () => {
    expect(searchConsolidations(undefined, 'anything')).toEqual([])
    expect(searchConsolidations(consolidations, '   ')).toEqual([])
    expect(searchConsolidations(consolidations, 'zzz-nothing')).toEqual([])
  })
})

const silentLogger = {
  debug: mock(() => {}),
  info: mock(() => {}),
  warn: mock(() => {}),
  error: mock(() => {}),
}

const buildRunnerState = (overrides: Partial<AgentState> = {}): AgentState =>
  ({
    agentId: 'parent-agent',
    ancestorRunIds: [],
    runId: 'parent-run',
    compactionArchive: [snapshot(11), snapshot(12)],
    contextConsolidations: undefined,
    ...overrides,
  }) as AgentState

const invokeRunner = (
  agentState: AgentState,
  programmaticConfig?: Record<string, unknown>,
): void =>
  maybeRunBackgroundConsolidation({
    agentState,
    agentTemplate: { id: 'base', programmaticConfig },
    userInputId: 'u-1',
    logger: silentLogger,
  } as unknown as Parameters<typeof maybeRunBackgroundConsolidation>[0])

// Two macrotask turns: one for the runner's dynamic import + promise chain,
// one for the record/finally continuation after the child promise settles.
const flush = async (): Promise<void> => {
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
}

const deferred = <T,>() => {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const summaryHistory = (text: string) => [
  { role: 'assistant', content: [{ type: 'text', text }] },
]

// The runner's spawn dependency is loaded via a dynamic import (module-cycle
// break), so mocking the module with Bun's mock.module (the documented way to
// intercept module imports) proves that gated paths never reach
// createAgentState/executeSubagent and that the success path flows through
// the mocked child.
type ChildRun = { agentState: { messageHistory: unknown[] } }
let pendingChild: {
  promise: Promise<ChildRun>
  resolve: (value: ChildRun) => void
  reject: (error: unknown) => void
} | undefined

const executeSubagentSpy = mock((..._args: unknown[]) => {
  if (!pendingChild) throw new Error('test bug: no pending child configured')
  return pendingChild.promise
})
const createAgentStateSpy = mock(() => ({}))
const extractSubagentContextParamsSpy = mock(() => ({}))

mock.module('../../tools/handlers/tool/spawn-agent-utils', () => ({
  createAgentState: createAgentStateSpy,
  executeSubagent: executeSubagentSpy,
  extractSubagentContextParams: extractSubagentContextParamsSpy,
}))

describe('maybeRunBackgroundConsolidation', () => {
  afterEach(() => {
    pendingChild = undefined
    executeSubagentSpy.mockClear()
    createAgentStateSpy.mockClear()
    extractSubagentContextParamsSpy.mockClear()
  })

  afterAll(() => {
    mock.restore()
  })
  test('canary-off: no import/spawn and no record when the gate is not exactly true', () => {
    for (const programmaticConfig of [undefined, {}, { backgroundSnapshotConsolidation: false }]) {
      const agentState = buildRunnerState()
      invokeRunner(agentState, programmaticConfig)
      expect(createAgentStateSpy).not.toHaveBeenCalled()
      expect(executeSubagentSpy).not.toHaveBeenCalled()
      expect(agentState.contextConsolidations).toBeUndefined()
    }
  })

  test('empty-snapshot no-op: nothing to consolidate means no spawn', () => {
    const covered = [
      { consolidatedAt: 1, sourceArchivedAts: [11, 12], action: 'semantic_compaction', summary: 'already covered', coveredMessages: 4 },
    ] as ContextConsolidation[]
    const agentState = buildRunnerState({ contextConsolidations: covered })
    invokeRunner(agentState, { backgroundSnapshotConsolidation: true })
    expect(executeSubagentSpy).not.toHaveBeenCalled()
  })

  test('re-entrancy guard: a second call while one run is active is a no-op', async () => {
    pendingChild = deferred()
    const agentState = buildRunnerState()
    invokeRunner(agentState, { backgroundSnapshotConsolidation: true })
    invokeRunner(agentState, { backgroundSnapshotConsolidation: true })
    // The spawn lands after the runner's dynamic import resolves, so settle
    // before counting; the unresolved deferred keeps the guard held here.
    await flush()
    expect(executeSubagentSpy).toHaveBeenCalledTimes(1)
    pendingChild.resolve({ agentState: { messageHistory: summaryHistory('done') } })
    await flush()
  })

  test('record-on-success: stores the child summary with snapshot provenance', async () => {
    pendingChild = deferred()
    const agentState = buildRunnerState()
    invokeRunner(agentState, { backgroundSnapshotConsolidation: true })
    pendingChild.resolve({ agentState: { messageHistory: summaryHistory('keystone summary') } })
    await flush()
    expect(agentState.contextConsolidations).toHaveLength(1)
    const recorded = agentState.contextConsolidations![0]
    expect(recorded.summary).toBe('keystone summary')
    expect(recorded.sourceArchivedAts).toEqual([11, 12])
    expect(recorded.action).toBe('semantic_compaction')
    expect(recorded.coveredMessages).toBe(4)
  })

  test('no record and released guard when the child produces no text', async () => {
    pendingChild = deferred()
    const agentState = buildRunnerState()
    invokeRunner(agentState, { backgroundSnapshotConsolidation: true })
    pendingChild.resolve({ agentState: { messageHistory: [] } })
    await flush()
    expect(agentState.contextConsolidations).toBeUndefined()
    // Guard released: a later call may spawn again.
    pendingChild = deferred<ChildRun>()
    invokeRunner(agentState, { backgroundSnapshotConsolidation: true })
    await flush()
    expect(executeSubagentSpy).toHaveBeenCalledTimes(2)
    pendingChild.resolve({ agentState: { messageHistory: summaryHistory('later') } })
    await flush()
  })

  test('failure is non-fatal: warns, records nothing, releases the guard', async () => {
    pendingChild = deferred()
    const agentState = buildRunnerState()
    invokeRunner(agentState, { backgroundSnapshotConsolidation: true })
    pendingChild.reject(new Error('child failed'))
    await flush()
    expect(silentLogger.warn).toHaveBeenCalled()
    expect(agentState.contextConsolidations).toBeUndefined()
    pendingChild = deferred<ChildRun>()
    invokeRunner(agentState, { backgroundSnapshotConsolidation: true })
    await flush()
    expect(executeSubagentSpy).toHaveBeenCalledTimes(2)
    pendingChild.resolve({ agentState: { messageHistory: summaryHistory('retry ok') } })
    await flush()
  })
})

const invokeRecall = async (agentState: AgentState, query: string) => {
  const { output } = await handleRecallContext({
    previousToolCallFinished: Promise.resolve(),
    toolCall: {
      toolName: 'recall_context',
      toolCallId: 'recall-1',
      input: { query },
    } as CodebuffToolCall<'recall_context'>,
    agentState,
  })
  return (output as Array<{ type: string; value: Record<string, unknown> }>)[0]
    .value as {
    matches: Array<{ toolCallId: string; snippet: string }>
    snapshotsSearched: number
    archivedAt: number[]
    consolidations?: Array<{ summary: string }>
    message?: string
  }
}

describe('handleRecallContext consolidation merge', () => {
  const consolidation = (summary: string): ContextConsolidation => ({
    consolidatedAt: 99,
    sourceArchivedAts: [11],
    action: 'semantic_compaction',
    summary,
    coveredMessages: 2,
  })

  test('includes consolidation hits when searchConsolidations matches', async () => {
    // 'eviction' appears in no verbatim archived message, only in the summary.
    const agentState = buildRunnerState({
      contextConsolidations: [consolidation('We raised the eviction floor to 4.')],
    })
    const value = await invokeRecall(agentState, 'eviction')
    expect(value.matches).toEqual([])
    expect(value.consolidations).toHaveLength(1)
    expect(value.consolidations![0].summary).toContain('eviction floor')
    // Hits exist, so the empty-result guidance message must NOT appear.
    expect(value.message).toBeUndefined()
  })

  test('omits the consolidations field entirely when there are no hits', async () => {
    const agentState = buildRunnerState({
      contextConsolidations: [consolidation('Unrelated scheduler notes.')],
    })
    const value = await invokeRecall(agentState, 'eviction')
    expect(value.consolidations).toBeUndefined()
    // Both result sets empty: the guidance message IS shown.
    expect(value.message).toContain('No archived pre-compaction content matched')
  })

  test('shows the guidance message only when both matches and consolidations are empty', async () => {
    // Verbatim match exists, consolidation search misses: no message.
    const withVerbatim = buildRunnerState({
      contextConsolidations: [consolidation('Unrelated scheduler notes.')],
    })
    const verbatim = await invokeRecall(withVerbatim, 'keystone-11')
    expect(verbatim.matches.length).toBeGreaterThan(0)
    expect(verbatim.message).toBeUndefined()

    // Consolidation hit exists, verbatim search misses: no message either.
    const withConsolidation = buildRunnerState({
      contextConsolidations: [consolidation('We raised the eviction floor to 4.')],
    })
    const consolidationOnly = await invokeRecall(withConsolidation, 'eviction')
    expect(consolidationOnly.consolidations).toHaveLength(1)
    expect(consolidationOnly.message).toBeUndefined()
  })
})
