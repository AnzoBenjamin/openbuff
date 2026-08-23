/**
 * Deterministic cross-session memory retention scenario (no LLM calls).
 *
 * Proves the Phase 0+1 promise end to end against the store API:
 *  - S1 cold start: no persisted memory means nothing to recall.
 *  - S2 warm unchanged: persisted fresh memory survives the session boundary.
 *  - S3 mutated file: affected evidence is marked stale (never trusted).
 *  - S4 rename: evidence rebinds when the workspace journal knows the move,
 *    and degrades to stale-not-deleted otherwise.
 *
 * Compiled-context exclusion of stale evidence is covered separately by
 * packages/agent-runtime/src/util/__tests__/task-memory.test.ts.
 */
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import {
  loadPersistedTaskMemory,
  reconcileTaskMemoryEvidence,
  saveMergedTaskMemory,
} from '@openbuff/sdk/services/task-memory-store'

import type { TaskMemoryEvidenceV1, TaskMemoryV1 } from '@codebuff/common/types/task-memory'

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}

function makeMemory(overrides: Partial<TaskMemoryV1>): TaskMemoryV1 {
  return {
    schemaVersion: 1,
    goal: 'Ship retention feature',
    requirements: ['Keep memory honest'],
    decisions: ['Use content hashes for staleness'],
    filesInspected: [],
    editsMade: [],
    validationResults: [],
    reviewReceipts: [],
    blockers: [],
    nextActions: [],
    historicalSummary: '',
    evidence: [],
    revision: 0,
    updatedAt: 1_000,
    checksum: 'deadbeef',
    ...overrides,
  }
}

const metrics: Record<string, unknown>[] = []

function evidenceFor(id: string, file: string, content: string): TaskMemoryEvidenceV1 {
  return {
    id,
    kind: 'read',
    summary: `Read ${file}`,
    path: file,
    freshnessHash: sha256(content),
  }
}

describe('memory retention scenario', () => {
  let rootDir: string

  beforeEach(async () => {
    rootDir = await mkdtemp(path.join(tmpdir(), 'memory-retention-'))
  })

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true })
    if (metrics.length >= 4) metrics.length = 0
  })

  test('S1 cold start recalls nothing', async () => {
    const cold = await loadPersistedTaskMemory({ rootDir })
    expect(cold).toBeUndefined()
    metrics.push({ scenario: 'S1-cold', recalledMemories: 0 })
  })

  test('S2 warm unchanged session retains decisions and fresh evidence', async () => {
    const fileContent = 'export const rateLimit = 10'
    await writeFile(path.join(rootDir, 'limits.ts'), fileContent)
    const sessionOne = makeMemory({
      evidence: [evidenceFor('ev-limits', 'limits.ts', fileContent)],
    })
    await saveMergedTaskMemory({ rootDir, runMemory: sessionOne })

    const hydrated = await loadPersistedTaskMemory({ rootDir })
    const reconciled = await reconcileTaskMemoryEvidence({
      memory: hydrated!,
      rootDir,
    })
    expect(reconciled.decisions).toContain('Use content hashes for staleness')
    expect(reconciled.evidence[0]!.stale).toBe(false)
    metrics.push({
      scenario: 'S2-warm',
      decisionsRetained: reconciled.decisions.length,
      freshEvidence: 1,
      staleEvidence: 0,
    })
  })

  test('S3 mutated file flips only affected evidence to stale', async () => {
    await writeFile(path.join(rootDir, 'keep.ts'), 'kept')
    await writeFile(path.join(rootDir, 'change.ts'), 'original')
    const seeded = makeMemory({
      evidence: [
        evidenceFor('ev-keep', 'keep.ts', 'kept'),
        evidenceFor('ev-change', 'change.ts', 'original'),
      ],
    })
    await saveMergedTaskMemory({ rootDir, runMemory: seeded })

    await writeFile(path.join(rootDir, 'change.ts'), 'mutated')
    const reconciled = await reconcileTaskMemoryEvidence({
      memory: (await loadPersistedTaskMemory({ rootDir }))!,
      rootDir,
    })
    const byId = new Map(reconciled.evidence.map((item) => [item.id, item]))
    expect(byId.get('ev-keep')!.stale).toBe(false)
    expect(byId.get('ev-change')!.stale).toBe(true)
    metrics.push({
      scenario: 'S3-staleness',
      wrongTrustDecisions: 0,
      staleEvidence: 1,
    })
  })

  test('S4 rename rebinds with journal knowledge, degrades without', async () => {
    const content = 'export function movedHelper() {}'
    await mkdir(path.join(rootDir, 'lib'), { recursive: true })
    await writeFile(path.join(rootDir, 'helper.ts'), content)
    const seeded = makeMemory({
      evidence: [evidenceFor('ev-helper', 'helper.ts', content)],
    })
    await saveMergedTaskMemory({ rootDir, runMemory: seeded })
    await rm(path.join(rootDir, 'helper.ts'))
    await writeFile(path.join(rootDir, 'lib', 'helper.ts'), content)

    const degraded = await reconcileTaskMemoryEvidence({
      memory: (await loadPersistedTaskMemory({ rootDir }))!,
      rootDir,
    })
    expect(degraded.evidence[0]!.stale).toBe(true)
    expect(degraded.evidence).toHaveLength(1)

    const rebound = await reconcileTaskMemoryEvidence({
      memory: (await loadPersistedTaskMemory({ rootDir }))!,
      rootDir,
      workspaceMoves: [{ from: 'helper.ts', to: 'lib/helper.ts' }],
    })
    expect(rebound.evidence[0]!.stale).toBe(false)
    expect(rebound.evidence[0]!.path).toBe('lib/helper.ts')
    metrics.push({ scenario: 'S4-rename', rebound: 1, orphanedWithoutJournal: 1 })
  })
})
