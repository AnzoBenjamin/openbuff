import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  buildMemoryContentBlock,
  formatAge,
  GOAL_PREVIEW_CHARS,
  handleMemoryCommand,
  handleMemoryCommandBlocks,
  PRUNE_FAILURE_CAUSES,
  STALE_PATHS_SHOWN,
} from '../memory-command'

import type { MemoryCommandDeps } from '../memory-command'
import { MemoryEventEnvelopeSchema } from '@openbuff/sdk'
import type { TaskMemoryPruneOutcome, WorkspaceMoveRecord } from '@openbuff/sdk'
import type {
  TaskMemoryEvidenceV1,
  TaskMemoryV1,
} from '@codebuff/common/types/task-memory'

function makeEvidence(
  overrides: Partial<TaskMemoryEvidenceV1> = {},
): TaskMemoryEvidenceV1 {
  return {
    id: 'ev-1',
    kind: 'read',
    summary: 'Read a file',
    ...overrides,
  } as TaskMemoryEvidenceV1
}

function makeMemory(overrides: Partial<TaskMemoryV1> = {}): TaskMemoryV1 {
  return {
    schemaVersion: 1,
    goal: 'Ship cross-session memory',
    requirements: ['req-1'],
    decisions: ['decision-1', 'decision-2'],
    filesInspected: ['a.ts'],
    editsMade: ['b.ts'],
    validationResults: ['typecheck ok'],
    reviewReceipts: [],
    blockers: [],
    nextActions: ['next-1'],
    historicalSummary: '',
    evidence: [],
    revision: 3,
    updatedAt: Date.now(),
    checksum: 'deadbeef',
    ...overrides,
  } as TaskMemoryV1
}

/**
 * Build injected deps. `memory` is what load returns (undefined = no record);
 * `reconciled` is what reconciliation reports back (defaults to `memory`);
 * `pruneOutcome` is the store's prune verdict (defaults to `no-record`).
 * `workspaceMoves` is what the journal reports; both subcommands must forward
 * it so moved-file evidence rebinds instead of reconciling stale.
 */
function createDeps(options: {
  memory?: TaskMemoryV1
  reconciled?: TaskMemoryV1
  pruneOutcome?: TaskMemoryPruneOutcome
  workspaceMoves?: WorkspaceMoveRecord[]
  loadThrows?: boolean
  pruneThrows?: boolean
  movesThrow?: boolean
}): {
  deps: MemoryCommandDeps
  calls: {
    prune: number
    moves: number
    reconcileMoves: (WorkspaceMoveRecord[] | undefined)[]
    pruneMoves: (WorkspaceMoveRecord[] | undefined)[]
  }
} {
  const calls = {
    prune: 0,
    moves: 0,
    reconcileMoves: [] as (WorkspaceMoveRecord[] | undefined)[],
    pruneMoves: [] as (WorkspaceMoveRecord[] | undefined)[],
  }
  const deps = {
    getRootDir: () => '/fake/project',
    loadPersistedTaskMemory: async () => {
      if (options.loadThrows) throw new Error('load exploded')
      return options.memory
    },
    reconcileTaskMemoryEvidence: async (params: {
      workspaceMoves?: WorkspaceMoveRecord[]
    }) => {
      calls.reconcileMoves.push(params.workspaceMoves)
      return options.reconciled ?? options.memory!
    },
    pruneStaleTaskMemoryEvidence: async (params: {
      workspaceMoves?: WorkspaceMoveRecord[]
    }) => {
      calls.prune += 1
      calls.pruneMoves.push(params.workspaceMoves)
      if (options.pruneThrows) throw new Error('prune exploded')
      return options.pruneOutcome ?? { status: 'no-record' as const }
    },
    getWorkspaceMoves: async () => {
      calls.moves += 1
      if (options.movesThrow) throw new Error('journal exploded')
      return options.workspaceMoves ?? []
    },
  } as unknown as MemoryCommandDeps
  return { deps, calls }
}

describe('/memory command', () => {
  test('status reports absence when no record has been persisted yet', async () => {
    const { deps } = createDeps({ memory: undefined })

    const result = await handleMemoryCommand('', deps)

    expect(result).toContain('No persisted task memory')
    expect(result).toContain('first successful run')
  })

  test('status summarizes counts and lists stale evidence paths', async () => {
    const memory = makeMemory({
      updatedAt: Date.now() - 2 * 60 * 60 * 1_000,
      evidence: [
        makeEvidence({ id: 'ev-fresh', path: 'fresh.ts', stale: false }),
        makeEvidence({ id: 'ev-stale-1', path: 'gone-1.ts', stale: true }),
        makeEvidence({ id: 'ev-stale-2', path: 'gone-2.ts', stale: true }),
      ],
    })
    const { deps } = createDeps({ memory, reconciled: memory })

    const result = await handleMemoryCommand('status', deps)

    expect(result).toContain('revision 3')
    expect(result).toContain('2h 0m ago')
    expect(result).toContain('Ship cross-session memory')
    expect(result).toContain('Decisions: 2')
    expect(result).toContain('Requirements: 1')
    expect(result).toContain('Evidence: 1 fresh, 2 stale (of 3).')
    expect(result).toContain('- gone-1.ts')
    expect(result).toContain('- gone-2.ts')
    expect(result).toContain('/memory prune')
  })

  test('status omits the prune hint when every entry is fresh', async () => {
    const memory = makeMemory({
      goal: '',
      updatedAt: Date.now(),
      evidence: [makeEvidence({ id: 'ev-ok', path: 'ok.ts', stale: false })],
    })
    const { deps } = createDeps({ memory, reconciled: memory })

    const result = await handleMemoryCommand('status', deps)

    expect(result).toContain('Evidence: 1 fresh, 0 stale (of 1).')
    expect(result).toContain('Goal: (none recorded)')
    expect(result).not.toContain('/memory prune')
    expect(result).not.toContain('Stale evidence paths:')
  })

  test('status caps the stale path list at five entries', async () => {
    const memory = makeMemory({
      evidence: Array.from({ length: 8 }, (_, index) =>
        makeEvidence({
          id: `ev-${index}`,
          path: `stale-${index}.ts`,
          stale: true,
        }),
      ),
    })
    const { deps } = createDeps({ memory, reconciled: memory })

    const result = await handleMemoryCommand('status', deps)

    expect(result).toContain('- stale-4.ts')
    expect(result).not.toContain('- stale-5.ts')
  })

  test('status degrades to a message instead of throwing', async () => {
    const { deps } = createDeps({ loadThrows: true })

    const result = await handleMemoryCommand('status', deps)

    expect(result).toContain('Memory status failed')
    expect(result).not.toContain('load exploded')
  })

  test('status forwards journal moves so moved-file evidence rebinds', async () => {
    const memory = makeMemory({
      evidence: [makeEvidence({ id: 'ev-moved', path: 'old.ts' })],
    })
    const moves: WorkspaceMoveRecord[] = [
      { from: 'old.ts', to: 'nested/new.ts' },
    ]
    const { deps, calls } = createDeps({
      memory,
      reconciled: memory,
      workspaceMoves: moves,
    })

    await handleMemoryCommand('status', deps)

    expect(calls.moves).toBe(1)
    expect(calls.reconcileMoves).toEqual([moves])
  })

  test('prune forwards journal moves so a rename does not delete valid evidence', async () => {
    const moves: WorkspaceMoveRecord[] = [
      { from: 'old.ts', to: 'nested/new.ts' },
    ]
    const { deps, calls } = createDeps({
      pruneOutcome: { status: 'pruned', removed: 0, remaining: 1 },
      workspaceMoves: moves,
    })

    const result = await handleMemoryCommand('prune', deps)

    expect(calls.pruneMoves).toEqual([moves])
    expect(result).toContain('Nothing to prune')
  })

  test('an unreadable move journal fails the command instead of pruning blind', async () => {
    // Pruning with an unknown move set would delete evidence that hydration
    // would have rebound, so the failure must surface rather than proceed.
    const { deps, calls } = createDeps({
      pruneOutcome: { status: 'pruned', removed: 3, remaining: 0 },
      movesThrow: true,
    })

    const result = await handleMemoryCommand('prune', deps)

    expect(result).toContain('Memory prune failed')
    expect(result).not.toContain('journal exploded')
    expect(calls.prune).toBe(0)
  })

  test('prune reports removal and remaining counts', async () => {
    const { deps, calls } = createDeps({
      pruneOutcome: { status: 'pruned', removed: 2, remaining: 5 },
    })

    const result = await handleMemoryCommand('prune', deps)

    expect(calls.prune).toBe(1)
    expect(result).toBe('Pruned 2 stale evidence entries; 5 remain.')
  })

  test('prune singularizes a single removal', async () => {
    const { deps } = createDeps({
      pruneOutcome: { status: 'pruned', removed: 1, remaining: 0 },
    })

    expect(await handleMemoryCommand('prune', deps)).toBe(
      'Pruned 1 stale evidence entry; 0 remain.',
    )
  })

  test('prune reports nothing to do for a fully fresh record', async () => {
    const { deps } = createDeps({
      pruneOutcome: { status: 'pruned', removed: 0, remaining: 4 },
    })

    const result = await handleMemoryCommand('prune', deps)

    expect(result).toContain('Nothing to prune')
    expect(result).toContain('all 4 evidence entries are fresh')
  })

  test('prune reports a missing record', async () => {
    const { deps } = createDeps({ pruneOutcome: { status: 'no-record' } })

    expect(await handleMemoryCommand('prune', deps)).toBe(
      'No persisted task memory to prune for this project.',
    )
  })

  test('a failed prune is reported as a failure, never as a missing record', async () => {
    // Each failure reason must name its own cause, must NOT claim there is
    // nothing to prune, and must say the stale entries are still present.
    const cases: Array<
      [Extract<TaskMemoryPruneOutcome, { status: 'failed' }>['reason'], string]
    > = [
      ['write-failed', 'atomic renames'],
      ['concurrent-write', 'changed while pruning'],
      ['invalid-record', 'schema validation'],
    ]
    for (const [reason, expectedCause] of cases) {
      const { deps } = createDeps({
        pruneOutcome: { status: 'failed', reason, removed: 3, remaining: 2 },
      })

      const result = await handleMemoryCommand('prune', deps)

      expect(result).toContain('Memory prune failed')
      expect(result).toContain(expectedCause)
      expect(result).toContain('The record is unchanged')
      expect(result).toContain('3 stale evidence entries still present')
      expect(result).toContain('(2 fresh)')
      expect(result).not.toContain('No persisted task memory')
      expect(result).not.toContain('Nothing to prune')
    }
  })

  test('a failed prune singularizes a single remaining stale entry', async () => {
    const { deps } = createDeps({
      pruneOutcome: {
        status: 'failed',
        reason: 'write-failed',
        removed: 1,
        remaining: 0,
      },
    })

    expect(await handleMemoryCommand('prune', deps)).toContain(
      '1 stale evidence entry still present',
    )
  })

  test('prune degrades to a message instead of throwing', async () => {
    const { deps } = createDeps({ pruneThrows: true })

    const result = await handleMemoryCommand('prune', deps)

    expect(result).toContain('Memory prune failed')
    expect(result).not.toContain('prune exploded')
  })

  test('unknown subcommands return expanded V2 usage without touching the V1 store', async () => {
    const { deps, calls } = createDeps({ memory: makeMemory() })

    expect(await handleMemoryCommand('wat', deps)).toContain(
      'Usage: /memory [status|authority|diagnose|audit-migration|query <text>',
    )
    expect(await handleMemoryCommand('PRUNE-ish', deps)).toContain(
      'Usage: /memory [status|authority|diagnose|audit-migration|query <text>',
    )
    expect(calls.prune).toBe(0)
  })

  test('authority reports valid values and current selection without mutation', async () => {
    const { deps } = createDeps({ memory: makeMemory() })
    deps.getMemoryV2 = async () => ({
      status: 'unavailable', requestedAuthority: 'sqlite-v2-opt-in',
      effectiveAuthority: 'json-v1', degradation: 'fallback', retryable: true,
    })
    const result = await handleMemoryCommand('authority', deps)
    expect(result).toContain('json-v1, shadow-v2, sqlite-v2-opt-in')
    expect(result).toContain('Requested: sqlite-v2-opt-in; effective: json-v1')
    expect(result).toContain('Release N')
    expect(result).toContain('json-v1 and shadow-v2 remain supported but are deprecated')
    expect(result).toContain('sqlite-v2-opt-in is the default and replacement')
    expect(result).toContain('reset/restart')
  })

  test('subcommands are case-insensitive and tolerate extra whitespace', async () => {
    const { deps } = createDeps({
      pruneOutcome: { status: 'pruned', removed: 0, remaining: 1 },
    })

    expect(await handleMemoryCommand('  PRUNE  ', deps)).toContain(
      'Nothing to prune',
    )
  })

  test('age formatting spans seconds, minutes, hours, and days', async () => {
    const cases: Array<[number, string]> = [
      [500, '<1s'],
      [30 * 1_000, '30s'],
      [5 * 60 * 1_000, '5m'],
      [3 * 60 * 60 * 1_000 + 7 * 60 * 1_000, '3h 7m'],
      [2 * 24 * 60 * 60 * 1_000 + 5 * 60 * 60 * 1_000, '2d 5h'],
    ]
    for (const [ageMs, expected] of cases) {
      const memory = makeMemory({ updatedAt: Date.now() - ageMs })
      const { deps } = createDeps({ memory, reconciled: memory })
      expect(await handleMemoryCommand('status', deps)).toContain(
        `updated ${expected} ago`,
      )
    }
  })
})

describe('/memory blocks', () => {
  test('all state-changing V2 commands preview by default and only apply explicitly', async () => {
    const { deps } = createDeps({ memory: makeMemory() })
    const calls: Array<{ method: string; request: unknown }> = []
    const invoke = (method: string) => async (request: unknown) => {
      calls.push({ method, request })
      return { outcome: 'preview', plannedEvents: [] }
    }
    const observation = {
      observationId: 'observation-1', taskId: 'task-1', kind: 'discovery', summary: 'old', detail: 'old',
      confidence: 1, selectors: [], evidence: [], tags: [], observedAt: '2025-01-01T00:00:00.000Z',
    }
    const observationEvent = MemoryEventEnvelopeSchema.parse({
      schemaVersion: 2, eventSchemaVersion: 1, eventType: 'observation.recorded',
      eventId: 'observation-event-1', projectId: 'project-1', sessionId: 'session-1', sequence: 1,
      occurredAt: '2025-01-01T00:00:00.000Z', payload: { payloadSchemaVersion: 1, observation },
    })
    const operator = {
      consolidate: invoke('consolidate'),
      repair: invoke('repair'),
      revalidate: invoke('revalidate'),
      correct: invoke('correct'),
    }
    deps.getMemoryV2 = async () => ({
      status: 'available', requestedAuthority: 'shadow-v2', effectiveAuthority: 'shadow-v2', projectId: 'project-1', operator,
      repository: { export: async () => ({ outcome: 'page', events: [observationEvent], nextAfterEventId: null }) },
      release: async () => {},
    }) as unknown as Awaited<ReturnType<NonNullable<MemoryCommandDeps['getMemoryV2']>>>

    const commands = [
      'consolidate',
      'repair',
      'correct observation-1 replacement',
      'forget observation-1',
      'pin observation-1',
    ]
    for (const command of commands) {
      const preview = await handleMemoryCommandBlocks(command, deps)
      const applied = await handleMemoryCommandBlocks(`${command} --apply`, deps)
      expect(preview.state).toBe('report')
      expect(applied.state).toBe('report')
      const previewCall = calls.at(-2)?.request as { mode?: string }
      const applyCall = calls.at(-1)?.request as { mode?: string }
      expect(previewCall.mode).toBe('preview')
      expect(applyCall.mode).toBe('apply')
      if (preview.state === 'report') expect(preview.insertCommands?.[0]?.command).toContain('--apply')
    }
  })

  test('failed rejected and busy mutators render error tone with sanitized retryability', async () => {
    const { deps } = createDeps({ memory: makeMemory() })
    const outcomes = [
      { outcome: 'failed', error: { message: '/secret/store.sqlite locked', retryable: true } },
      { outcome: 'rejected', error: { message: 'Request was rejected.', retryable: false } },
      { outcome: 'busy', error: { message: 'Try again shortly.', retryable: true } },
    ]
    let index = 0
    const observationEvent = MemoryEventEnvelopeSchema.parse({
      schemaVersion: 2,
      eventSchemaVersion: 1,
      eventType: 'observation.recorded',
      eventId: 'observation-one',
      projectId: 'project-1',
      sessionId: 'session-1',
      sequence: 1,
      occurredAt: '2025-01-01T00:00:00.000Z',
      payload: {
        payloadSchemaVersion: 1,
        observation: {
          observationId: 'one',
          taskId: 'task-1',
          kind: 'discovery',
          summary: 'Canonical observation',
          detail: 'Canonical observation detail',
          confidence: 1,
          selectors: [],
          evidence: [],
          tags: [],
          observedAt: '2025-01-01T00:00:00.000Z',
        },
      },
    })
    deps.getMemoryV2 = async () => ({
      status: 'available', requestedAuthority: 'shadow-v2', effectiveAuthority: 'shadow-v2', projectId: 'project-1',
      operator: { correct: async () => outcomes[index++]! },
      repository: {
        export: async () => ({
          outcome: 'page',
          events: [observationEvent],
          nextAfterEventId: null,
        }),
      },
      release: async () => {},
    }) as unknown as Awaited<ReturnType<NonNullable<MemoryCommandDeps['getMemoryV2']>>>

    for (const command of ['pin one', 'pin one', 'pin one']) {
      const block = await handleMemoryCommandBlocks(command, deps)
      if (block.state !== 'report') throw new Error('expected report')
      expect(block.tone).toBe('error')
      expect(block.lines.join('\n')).toContain('Retryable:')
      expect(block.lines.join('\n')).not.toContain('/secret')
      expect(block.lines.join('\n')).not.toContain('sqlite')
    }
  })

  test('audit-migration renders an exact lossless SDK outcome with success tone', async () => {
    const memory = makeMemory()
    const { deps, calls } = createDeps({ memory })
    const repository = { append: async () => { throw new Error('must not append') } }
    let request: unknown
    let releases = 0
    deps.auditTaskMemoryV1Migration = async (value) => {
      request = value
      return {
        outcome: 'exact', revision: 3, checksum: 'full-source-checksum', identity: 'v1:3:id',
        markerEventId: 'marker', repositoryLastEventId: 'tail', importedTaskId: 'task',
        importedObservationIds: ['observation-1', 'observation-2'], omittedFields: 0, warnings: [],
      } as unknown as Awaited<ReturnType<MemoryCommandDeps['auditTaskMemoryV1Migration']>>
    }
    deps.getMemoryV2 = async () => ({
      status: 'available', requestedAuthority: 'sqlite-v2-opt-in', effectiveAuthority: 'sqlite-v2-opt-in',
      projectId: 'project-1', operator: {}, repository, release: async () => { releases++ },
    }) as unknown as Awaited<ReturnType<NonNullable<MemoryCommandDeps['getMemoryV2']>>>

    const block = await handleMemoryCommandBlocks('audit-migration', deps)

    if (block.state !== 'report') throw new Error('expected report')
    expect(block.tone).toBe('success')
    expect(block.lines.join('\n')).toContain('Outcome: exact')
    expect(block.lines.join('\n')).toContain('Source revision: 3')
    expect(block.lines.join('\n')).toContain('Source checksum: full-source-checksum')
    expect(block.lines.join('\n')).toContain('Marker verification: exact; imported body/provenance verification: exact')
    expect(block.lines.join('\n')).toContain('Imported observations: 2')
    expect(block.lines.join('\n')).toContain('Omitted fields: 0')
    expect(block.lines.join('\n')).toContain('Truncated fields: 0')
    expect(block.lines.join('\n')).toContain('Warnings: 0 (none)')
    expect(block.lines.join('\n')).toContain('Lossless migration evidence: yes')
    expect(block.lines.join('\n')).toContain('No writes were performed')
    expect(request).toEqual({ memory, projectId: 'project-1', repository })
    expect(calls.prune).toBe(0)
    expect(releases).toBe(1)
  })

  test('audit-migration warns when an exact outcome documents loss', async () => {
    const { deps } = createDeps({ memory: makeMemory() })
    deps.auditTaskMemoryV1Migration = async () => ({
      outcome: 'exact', revision: 3, checksum: 'checksum', identity: 'v1:3:id',
      markerEventId: 'marker', repositoryLastEventId: 'tail', importedTaskId: 'task',
      importedObservationIds: [], omittedFields: 2, truncatedFields: 1,
      warnings: ['text-truncated', 'goal-excluded'],
    }) as unknown as Awaited<ReturnType<MemoryCommandDeps['auditTaskMemoryV1Migration']>>
    deps.getMemoryV2 = async () => ({
      status: 'available', requestedAuthority: 'shadow-v2', effectiveAuthority: 'shadow-v2',
      projectId: 'project-1', operator: {}, repository: {}, release: async () => {},
    }) as unknown as Awaited<ReturnType<NonNullable<MemoryCommandDeps['getMemoryV2']>>>

    const block = await handleMemoryCommandBlocks('audit-migration', deps)

    if (block.state !== 'report') throw new Error('expected report')
    expect(block.tone).toBe('warning')
    expect(block.lines.join('\n')).toContain('Omitted fields: 2')
    expect(block.lines.join('\n')).toContain('Truncated fields: 1')
    expect(block.lines.join('\n')).toContain('Warnings: 2 (text-truncated, goal-excluded)')
    expect(block.lines.join('\n')).toContain('Lossless migration evidence: no')
  })

  test('audit-migration renders every non-exact outcome distinctly and sanitizes failures', async () => {
    const { deps } = createDeps({ memory: makeMemory() })
    const outcomes = [
      { outcome: 'no-record' },
      { outcome: 'not-migrated', revision: 3, checksum: 'checksum' },
      { outcome: 'incomplete', reason: 'reservation-only', revision: 3, checksum: 'checksum' },
      { outcome: 'mismatch', reason: 'imported-body-mismatch', revision: 3, checksum: 'checksum' },
      { outcome: 'rejected', reason: 'repository-rejected' },
      { outcome: 'failed', reason: 'repository-failed' },
    ] as const
    let index = 0
    let releases = 0
    deps.auditTaskMemoryV1Migration = async () => outcomes[index++] as unknown as Awaited<ReturnType<MemoryCommandDeps['auditTaskMemoryV1Migration']>>
    deps.getMemoryV2 = async () => ({
      status: 'available', requestedAuthority: 'shadow-v2', effectiveAuthority: 'shadow-v2',
      projectId: 'project-1', operator: {}, repository: {}, release: async () => { releases++ },
    }) as unknown as Awaited<ReturnType<NonNullable<MemoryCommandDeps['getMemoryV2']>>>

    const rendered = []
    for (let i = 0; i < outcomes.length; i++) {
      const block = await handleMemoryCommandBlocks('audit-migration', deps)
      if (block.state !== 'report') throw new Error('expected report')
      rendered.push(block.lines.join('\n'))
    }
    expect(rendered[0]).toContain('Outcome: no-record')
    expect(rendered[0]).toContain('No currently loaded V1')
    expect(rendered[1]).toContain('Outcome: not-migrated')
    expect(rendered[2]).toContain('Outcome: incomplete')
    expect(rendered[3]).toContain('Outcome: mismatch')
    expect(rendered[4]).toContain('Outcome: rejected')
    expect(rendered[5]).toContain('Outcome: failed')
    expect(rendered.join('\n')).not.toMatch(/\.sqlite|SELECT|\/secret/i)
    expect(releases).toBe(outcomes.length)
  })

  test('audit-migration releases the provider lease once when the injected audit throws', async () => {
    const { deps } = createDeps({ memory: makeMemory() })
    let releases = 0
    deps.auditTaskMemoryV1Migration = async () => { throw new Error('/secret/store.sqlite SELECT token') }
    deps.getMemoryV2 = async () => ({
      status: 'available', requestedAuthority: 'shadow-v2', effectiveAuthority: 'shadow-v2',
      projectId: 'project-1', operator: {}, repository: {}, release: async () => { releases++ },
    }) as unknown as Awaited<ReturnType<NonNullable<MemoryCommandDeps['getMemoryV2']>>>

    const block = await handleMemoryCommandBlocks('audit-migration', deps)

    expect(releases).toBe(1)
    if (block.state !== 'report') throw new Error('expected report')
    expect(block.tone).toBe('error')
    expect(block.lines.join('\n')).not.toMatch(/secret|sqlite|SELECT|token/i)
  })

  test('query and diagnose render bounded generic reports', async () => {
    const { deps } = createDeps({ memory: makeMemory() })
    deps.getMemoryV2 = async () => ({
      status: 'available', projectId: 'project-1', operator: {},
      repository: {
        query: async () => ({ outcome: 'result', result: { matchedTasks: [], verifiedKnowledge: [], reusableDiscovery: [], rereadRequired: [], historicalContext: [], degradation: { state: 'none' } } }),
        health: async () => ({ status: 'healthy', authority: { kind: 'authoritative' }, backend: { backendId: 'bun-sqlite-memory-v2', capabilities: ['query'] }, issues: [] }),
        kernelHealth: async () => ({ status: 'healthy', schemaVersion: 2, projectionCursor: 0 }),
        getCapabilities: async () => ({ status: 'ok', capabilities: [{ name: 'query', available: true }] }),
        export: async () => ({ outcome: 'page', events: [], nextAfterEventId: null }),
      },
      release: async () => {},
    }) as unknown as Awaited<ReturnType<NonNullable<MemoryCommandDeps['getMemoryV2']>>>
    const query = await handleMemoryCommandBlocks('query deterministic lookup', deps)
    const diagnose = await handleMemoryCommandBlocks('diagnose', deps)
    expect(query.state).toBe('report')
    expect(diagnose.state).toBe('report')
    if (query.state === 'report') expect(query.lines[0]).toContain('Tasks: 0')
    if (diagnose.state === 'report') {
      expect(diagnose.lines.join('\n')).toContain('Kernel: healthy')
      expect(diagnose.lines.join('\n')).toContain('Release N')
      expect(diagnose.lines.join('\n')).toContain('json-v1 and shadow-v2 remain supported but are deprecated')
    }
  })

  test('inspect and diagnose use project-scoped canonical export inventories', async () => {
    const { deps } = createDeps({ memory: makeMemory() })
    let exports = 0
    let lowLevelLists = 0
    deps.getMemoryV2 = async () => ({
      status: 'available', requestedAuthority: 'shadow-v2', effectiveAuthority: 'shadow-v2', projectId: 'project-1', operator: {},
      repository: {
        export: async () => { exports++; return { outcome: 'page', events: [], nextAfterEventId: null } },
        listEvents: async () => { lowLevelLists++; return { status: 'ok', events: [] } },
        health: async () => ({ status: 'healthy', authority: { kind: 'authoritative' }, backend: { backendId: 'bun-sqlite-memory-v2', capabilities: [] }, issues: [] }),
        kernelHealth: async () => ({ status: 'healthy', schemaVersion: 2, projectionCursor: 0 }),
        getCapabilities: async () => ({ status: 'ok', capabilities: [] }),
      },
      release: async () => {},
    }) as unknown as Awaited<ReturnType<NonNullable<MemoryCommandDeps['getMemoryV2']>>>
    await handleMemoryCommandBlocks('inspect', deps)
    await handleMemoryCommandBlocks('diagnose', deps)
    expect(exports).toBe(2)
    expect(lowLevelLists).toBe(0)
  })

  test('export rejects symlinked output ancestors and reports bounded safe failure', async () => {
    const root = mkdtempSync(join(tmpdir(), 'memory-command-export-'))
    const outside = mkdtempSync(join(tmpdir(), 'memory-command-outside-'))
    mkdirSync(join(root, '.openbuff'), { mode: 0o700 })
    symlinkSync(outside, join(root, '.openbuff', 'memory'))
    const { deps } = createDeps({ memory: makeMemory() })
    deps.getRootDir = () => root
    deps.getMemoryV2 = async () => ({
      status: 'available', requestedAuthority: 'shadow-v2', effectiveAuthority: 'shadow-v2', projectId: 'project-1',
      operator: { exportManifest: async () => ({ outcome: 'exported', manifest: { checksum: 'sha256:1234567890abcdef', canonicalEventCount: 0, events: [], warnings: [] } }) },
      repository: {},
      release: async () => {},
    }) as unknown as Awaited<ReturnType<NonNullable<MemoryCommandDeps['getMemoryV2']>>>
    const block = await handleMemoryCommandBlocks('export', deps)
    if (block.state !== 'report') throw new Error('expected report')
    expect(block.tone).toBe('error')
    expect(block.lines.join('\n')).not.toContain(outside)
  })

  test('import rejects absolute traversal symlink oversize malformed and nonempty inputs without mutation', async () => {
    const root = mkdtempSync(join(tmpdir(), 'memory-command-import-'))
    const validDir = join(root, 'imports')
    mkdirSync(validDir)
    const malformed = join(validDir, 'malformed.json')
    writeFileSync(malformed, '{')
    const oversized = join(validDir, 'oversized.json')
    writeFileSync(oversized, Buffer.alloc(8 * 1024 * 1024 + 1))
    const link = join(validDir, 'link.json')
    symlinkSync(malformed, link)
    const { deps } = createDeps({ memory: makeMemory() })
    deps.getRootDir = () => root
    let imports = 0
    deps.getMemoryV2 = async () => ({
      status: 'available', requestedAuthority: 'shadow-v2', effectiveAuthority: 'shadow-v2', projectId: 'project-1',
      operator: { importManifest: async () => { imports++; return { outcome: 'imported' } } },
      repository: { export: async () => ({ outcome: 'page', events: [{ eventId: 'existing' }], nextAfterEventId: null }) },
      release: async () => {},
    }) as unknown as Awaited<ReturnType<NonNullable<MemoryCommandDeps['getMemoryV2']>>>
    for (const path of ['/absolute.json', '../escape.json', 'imports/link.json', 'imports/oversized.json', 'imports/malformed.json']) {
      const block = await handleMemoryCommandBlocks(`import ${path}`, deps)
      if (block.state !== 'report') throw new Error('expected report')
      expect(block.tone).toBe('error')
    }
    expect(imports).toBe(0)
  })

  test('available command leases release exactly once on success and throw', async () => {
    const { deps } = createDeps({ memory: makeMemory() })
    let releases = 0
    deps.getMemoryV2 = async () => ({
      status: 'available', requestedAuthority: 'shadow-v2', effectiveAuthority: 'shadow-v2', projectId: 'project-1',
      operator: {},
      repository: {
        query: async () => ({ outcome: 'result', result: { matchedTasks: [], verifiedKnowledge: [], reusableDiscovery: [], rereadRequired: [], historicalContext: [], degradation: { state: 'none' } } }),
      },
      release: async () => { releases++ },
    }) as unknown as Awaited<ReturnType<NonNullable<MemoryCommandDeps['getMemoryV2']>>>
    expect((await handleMemoryCommandBlocks('query safe', deps)).state).toBe('report')
    expect(releases).toBe(1)
    deps.getMemoryV2 = async () => ({
      status: 'available', requestedAuthority: 'shadow-v2', effectiveAuthority: 'shadow-v2', projectId: 'project-1', operator: {},
      repository: { query: async () => { throw new Error('/secret/store.sqlite SELECT token') } },
      release: async () => { releases++ },
    }) as unknown as Awaited<ReturnType<NonNullable<MemoryCommandDeps['getMemoryV2']>>>
    const failed = await handleMemoryCommandBlocks('query safe', deps)
    expect(releases).toBe(2)
    if (failed.state !== 'report') throw new Error('expected report')
    expect(failed.lines.join('\n')).not.toMatch(/secret|sqlite|SELECT|token/i)
  })

  test('pagination rejects repeated and empty cursors without leaking details', async () => {
    const { deps } = createDeps({ memory: makeMemory() })
    let calls = 0
    deps.getMemoryV2 = async () => ({
      status: 'available', requestedAuthority: 'shadow-v2', effectiveAuthority: 'shadow-v2', projectId: 'project-1', operator: {},
      repository: { export: async () => { calls++; return { outcome: 'page', events: [], nextAfterEventId: 'same' } } },
      release: async () => {},
    }) as unknown as Awaited<ReturnType<NonNullable<MemoryCommandDeps['getMemoryV2']>>>
    const block = await handleMemoryCommandBlocks('inspect target', deps)
    if (block.state !== 'report') throw new Error('expected report')
    expect(block.tone).toBe('error')
    expect(calls).toBe(1)
    expect(block.lines.join('\n')).toContain('operation could not be completed safely')
  })

  test('sanitized boundary hides arbitrary provider failures', async () => {
    const { deps } = createDeps({ memory: makeMemory() })
    deps.getMemoryV2 = async () => { throw new Error('/home/private/store.sqlite SELECT api_key=secret') }
    const block = await handleMemoryCommandBlocks('diagnose', deps)
    if (block.state !== 'report') throw new Error('expected report')
    const output = block.lines.join('\n')
    expect(output).toContain('Please retry')
    expect(output).not.toMatch(/home|sqlite|SELECT|api_key|secret/i)
  })

  test('STALE_PATHS_SHOWN is 5 and PRUNE_FAILURE_CAUSES covers all reasons', () => {
    expect(STALE_PATHS_SHOWN).toBe(5)
    expect(PRUNE_FAILURE_CAUSES['invalid-record']).toContain(
      'schema validation',
    )
    expect(PRUNE_FAILURE_CAUSES['concurrent-write']).toContain(
      'changed while pruning',
    )
    expect(PRUNE_FAILURE_CAUSES['write-failed']).toContain('atomic renames')
    expect(Object.keys(PRUNE_FAILURE_CAUSES).sort()).toEqual([
      'concurrent-write',
      'invalid-record',
      'write-failed',
    ])
  })

  test('formatAge covers boundary buckets directly', () => {
    expect(formatAge(500)).toBe('<1s')
    expect(formatAge(30 * 1_000)).toBe('30s')
    expect(formatAge(5 * 60 * 1_000)).toBe('5m')
    expect(formatAge(3 * 60 * 60 * 1_000 + 7 * 60 * 1_000)).toBe('3h 7m')
    expect(formatAge(2 * 24 * 60 * 60 * 1_000 + 5 * 60 * 60 * 1_000)).toBe(
      '2d 5h',
    )
  })

  test('empty state block when no record has been persisted yet', async () => {
    const { deps } = createDeps({ memory: undefined })

    const block = await handleMemoryCommandBlocks('', deps)

    expect(block).toEqual({ type: 'memory', state: 'empty' })
  })

  test('empty state via buildMemoryContentBlock alias', async () => {
    const { deps } = createDeps({ memory: undefined })

    const block = await buildMemoryContentBlock('status', deps)

    expect(block.type).toBe('memory')
    expect(block.state).toBe('empty')
  })

  test('status block reports stale/fresh split and counts', async () => {
    const memory = makeMemory({
      goal: 'Ship cross-session memory',
      decisions: ['d1', 'd2'],
      requirements: ['r1'],
      editsMade: ['e1', 'e2', 'e3'],
      validationResults: ['v1'],
      blockers: ['b1', 'b2'],
      nextActions: ['n1'],
      revision: 7,
      updatedAt: Date.now() - 1_000,
      evidence: [
        makeEvidence({ id: 'ev-fresh-1', path: 'fresh-1.ts', stale: false }),
        makeEvidence({ id: 'ev-fresh-2', path: 'fresh-2.ts', stale: false }),
        makeEvidence({ id: 'ev-stale-1', path: 'gone-1.ts', stale: true }),
        makeEvidence({ id: 'ev-stale-2', path: 'gone-2.ts', stale: true }),
      ],
    })
    const { deps } = createDeps({ memory, reconciled: memory })

    const block = await handleMemoryCommandBlocks('status', deps)

    expect(block.type).toBe('memory')
    if (block.state !== 'status') throw new Error('expected status block')
    expect(block.revision).toBe(7)
    expect(block.goal).toBe('Ship cross-session memory')
    expect(block.isGoalTruncated).toBe(false)
    expect(block.counts).toEqual({
      decisions: 2,
      requirements: 1,
      editsMade: 3,
      validationResults: 1,
      blockers: 2,
      nextActions: 1,
    })
    expect(block.evidence).toEqual({ fresh: 2, stale: 2, total: 4 })
    expect(block.stalePaths).toEqual(['gone-1.ts', 'gone-2.ts'])
    expect(block.totalStaleCount).toBe(2)
  })

  test('status block caps stalePaths at STALE_PATHS_SHOWN but preserves totalStaleCount', async () => {
    const memory = makeMemory({
      evidence: Array.from({ length: 8 }, (_, index) =>
        makeEvidence({
          id: `ev-${index}`,
          path: `stale-${index}.ts`,
          stale: true,
        }),
      ),
    })
    const { deps } = createDeps({ memory, reconciled: memory })

    const block = await handleMemoryCommandBlocks('status', deps)

    if (block.state !== 'status') throw new Error('expected status block')
    expect(block.stalePaths).toHaveLength(STALE_PATHS_SHOWN)
    expect(block.stalePaths).toEqual([
      'stale-0.ts',
      'stale-1.ts',
      'stale-2.ts',
      'stale-3.ts',
      'stale-4.ts',
    ])
    expect(block.evidence.stale).toBe(8)
    expect(block.totalStaleCount).toBe(8)
    expect(block.stalePaths).not.toContain('stale-5.ts')
  })

  test('status block omits stalePaths when every entry is fresh', async () => {
    const memory = makeMemory({
      goal: '',
      evidence: [makeEvidence({ id: 'ev-ok', path: 'ok.ts', stale: false })],
    })
    const { deps } = createDeps({ memory, reconciled: memory })

    const block = await handleMemoryCommandBlocks('status', deps)

    if (block.state !== 'status') throw new Error('expected status block')
    expect(block.evidence).toEqual({ fresh: 1, stale: 0, total: 1 })
    expect(block.stalePaths).toEqual([])
    expect(block.totalStaleCount).toBe(0)
  })

  test('goal truncation sets isGoalTruncated and caps goalPreview at GOAL_PREVIEW_CHARS', async () => {
    const longGoal = 'g'.repeat(GOAL_PREVIEW_CHARS + 40)
    const memory = makeMemory({ goal: longGoal })
    const { deps } = createDeps({ memory, reconciled: memory })

    const block = await handleMemoryCommandBlocks('status', deps)

    if (block.state !== 'status') throw new Error('expected status block')
    expect(block.goal).toBe(longGoal)
    expect(block.isGoalTruncated).toBe(true)
    expect(block.goalPreview).toBe(longGoal.slice(0, GOAL_PREVIEW_CHARS))
    expect(block.goalPreview).toHaveLength(GOAL_PREVIEW_CHARS)
  })

  test('short goal is not truncated', async () => {
    const memory = makeMemory({ goal: 'short goal' })
    const { deps } = createDeps({ memory, reconciled: memory })

    const block = await handleMemoryCommandBlocks('status', deps)

    if (block.state !== 'status') throw new Error('expected status block')
    expect(block.goal).toBe('short goal')
    expect(block.goalPreview).toBe('short goal')
    expect(block.isGoalTruncated).toBe(false)
  })

  test('empty goal yields null goal and placeholder preview', async () => {
    const memory = makeMemory({ goal: '' })
    const { deps } = createDeps({ memory, reconciled: memory })

    const block = await handleMemoryCommandBlocks('status', deps)

    if (block.state !== 'status') throw new Error('expected status block')
    expect(block.goal).toBeNull()
    expect(block.goalPreview).toBe('(none recorded)')
    expect(block.isGoalTruncated).toBe(false)
  })

  test('goal exactly at GOAL_PREVIEW_CHARS is not truncated', async () => {
    const exactGoal = 'x'.repeat(GOAL_PREVIEW_CHARS)
    const memory = makeMemory({ goal: exactGoal })
    const { deps } = createDeps({ memory, reconciled: memory })

    const block = await handleMemoryCommandBlocks('status', deps)

    if (block.state !== 'status') throw new Error('expected status block')
    expect(block.isGoalTruncated).toBe(false)
    expect(block.goalPreview).toBe(exactGoal)
  })

  test('pruned block carries removed and remaining counts', async () => {
    const { deps } = createDeps({
      pruneOutcome: { status: 'pruned', removed: 2, remaining: 5 },
    })

    const block = await handleMemoryCommandBlocks('prune', deps)

    expect(block).toEqual({
      type: 'memory',
      state: 'pruned',
      removed: 2,
      remaining: 5,
    })
  })

  test('pruned block via buildMemoryContentBlock alias', async () => {
    const { deps } = createDeps({
      pruneOutcome: { status: 'pruned', removed: 1, remaining: 0 },
    })

    const block = await buildMemoryContentBlock('prune', deps)

    expect(block).toEqual({
      type: 'memory',
      state: 'pruned',
      removed: 1,
      remaining: 0,
    })
  })

  test('nothing-to-prune block when removed is zero', async () => {
    const { deps } = createDeps({
      pruneOutcome: { status: 'pruned', removed: 0, remaining: 4 },
    })

    const block = await handleMemoryCommandBlocks('prune', deps)

    expect(block).toEqual({
      type: 'memory',
      state: 'nothing-to-prune',
      remaining: 4,
    })
  })

  test('no-record block when store has no persisted memory', async () => {
    const { deps } = createDeps({ pruneOutcome: { status: 'no-record' } })

    const block = await handleMemoryCommandBlocks('prune', deps)

    expect(block).toEqual({ type: 'memory', state: 'no-record' })
  })

  test('failed block for invalid-record carries cause and unchanged counts', async () => {
    const { deps } = createDeps({
      pruneOutcome: {
        status: 'failed',
        reason: 'invalid-record',
        removed: 3,
        remaining: 2,
      },
    })

    const block = await handleMemoryCommandBlocks('prune', deps)

    expect(block.type).toBe('memory')
    if (block.state !== 'failed') throw new Error('expected failed block')
    expect(block.reason).toBe('invalid-record')
    expect(block.cause).toBe(PRUNE_FAILURE_CAUSES['invalid-record'])
    expect(block.cause).toContain('schema validation')
    expect(block.removed).toBe(3)
    expect(block.remaining).toBe(2)
  })

  test('failed block for concurrent-write carries cause and unchanged counts', async () => {
    const { deps } = createDeps({
      pruneOutcome: {
        status: 'failed',
        reason: 'concurrent-write',
        removed: 1,
        remaining: 0,
      },
    })

    const block = await handleMemoryCommandBlocks('prune', deps)

    if (block.state !== 'failed') throw new Error('expected failed block')
    expect(block.reason).toBe('concurrent-write')
    expect(block.cause).toBe(PRUNE_FAILURE_CAUSES['concurrent-write'])
    expect(block.cause).toContain('changed while pruning')
    expect(block.removed).toBe(1)
    expect(block.remaining).toBe(0)
  })

  test('failed block for write-failed carries cause and unchanged counts', async () => {
    const { deps } = createDeps({
      pruneOutcome: {
        status: 'failed',
        reason: 'write-failed',
        removed: 5,
        remaining: 1,
      },
    })

    const block = await handleMemoryCommandBlocks('prune', deps)

    if (block.state !== 'failed') throw new Error('expected failed block')
    expect(block.reason).toBe('write-failed')
    expect(block.cause).toBe(PRUNE_FAILURE_CAUSES['write-failed'])
    expect(block.cause).toContain('atomic renames')
    expect(block.removed).toBe(5)
    expect(block.remaining).toBe(1)
  })

  test('failed blocks never collapse to no-record or nothing-to-prune', async () => {
    const reasons: Array<
      'invalid-record' | 'concurrent-write' | 'write-failed'
    > = ['invalid-record', 'concurrent-write', 'write-failed']
    for (const reason of reasons) {
      const { deps } = createDeps({
        pruneOutcome: { status: 'failed', reason, removed: 2, remaining: 1 },
      })
      const block = await handleMemoryCommandBlocks('prune', deps)
      expect(block.state).toBe('failed')
      expect(block.state).not.toBe('no-record')
      expect(block.state).not.toBe('nothing-to-prune')
    }
  })

  test('error state block for status when load throws', async () => {
    const { deps } = createDeps({ loadThrows: true })

    const block = await handleMemoryCommandBlocks('status', deps)

    expect(block.type).toBe('memory')
    expect(block.state).toBe('error')
    if (block.state !== 'error') throw new Error('expected error block')
    expect(block.message).toContain('Memory status failed')
    expect(block.message).not.toContain('load exploded')
  })

  test('error state block for status when journal moves throw', async () => {
    const memory = makeMemory()
    const { deps } = createDeps({
      memory,
      reconciled: memory,
      movesThrow: true,
    })

    const block = await handleMemoryCommandBlocks('status', deps)

    if (block.state !== 'error') throw new Error('expected error block')
    expect(block.message).toContain('Memory status failed')
    expect(block.message).not.toContain('journal exploded')
  })

  test('error state block for prune when prune throws', async () => {
    const { deps } = createDeps({ pruneThrows: true })

    const block = await handleMemoryCommandBlocks('prune', deps)

    if (block.state !== 'error') throw new Error('expected error block')
    expect(block.message).toContain('Memory prune failed')
    expect(block.message).not.toContain('prune exploded')
  })

  test('error state block for prune when journal moves throw before prune', async () => {
    const { deps, calls } = createDeps({
      pruneOutcome: { status: 'pruned', removed: 3, remaining: 0 },
      movesThrow: true,
    })

    const block = await handleMemoryCommandBlocks('prune', deps)

    if (block.state !== 'error') throw new Error('expected error block')
    expect(block.message).toContain('Memory prune failed')
    expect(block.message).not.toContain('journal exploded')
    expect(calls.prune).toBe(0)
  })

  test('unknown subcommand returns report block with expanded usage', async () => {
    const { deps, calls } = createDeps({ memory: makeMemory() })

    const block = await handleMemoryCommandBlocks('wat', deps)

    expect(block.type).toBe('memory')
    expect(block.state).toBe('report')
    if (block.state === 'report') expect(block.lines.join('\n')).toContain('Usage: /memory [status|authority|diagnose|audit-migration|query <text>')
    expect(calls.prune).toBe(0)
    expect(calls.moves).toBe(0)
  })

  test('V2 status lines include Release N authority deprecation guidance', async () => {
    const memory = makeMemory()
    const { deps } = createDeps({ memory, reconciled: memory })
    deps.getMemoryV2 = async () => ({
      status: 'unavailable', requestedAuthority: 'shadow-v2', effectiveAuthority: 'json-v1',
      degradation: 'V1 JSON memory is authoritative; SQLite was not opened.', retryable: false,
    })

    const output = await handleMemoryCommand('status', deps)

    expect(output).toContain('Release N')
    expect(output).toContain('json-v1 and shadow-v2 remain supported but are deprecated')
    expect(output).toContain('sqlite-v2-opt-in is the default and replacement')
  })

  test('status forwards journal moves so evidence rebinds', async () => {
    const memory = makeMemory({
      evidence: [makeEvidence({ id: 'ev-moved', path: 'old.ts' })],
    })
    const moves = [{ from: 'old.ts', to: 'nested/new.ts' }] as any
    const { deps, calls } = createDeps({
      memory,
      reconciled: memory,
      workspaceMoves: moves,
    })

    await handleMemoryCommandBlocks('status', deps)

    expect(calls.reconcileMoves).toEqual([moves])
  })

  test('prune forwards journal moves', async () => {
    const moves = [{ from: 'old.ts', to: 'nested/new.ts' }] as any
    const { deps, calls } = createDeps({
      pruneOutcome: { status: 'pruned', removed: 0, remaining: 1 },
      workspaceMoves: moves,
    })

    await handleMemoryCommandBlocks('prune', deps)

    expect(calls.pruneMoves).toEqual([moves])
  })
})
