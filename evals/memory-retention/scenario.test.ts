/**
 * Deterministic cross-session memory retention scenarios (no LLM calls).
 *
 * Proves the Phase 0+1 promise end to end against the store and runtime APIs:
 *  - S1 cold start: no persisted memory means nothing to recall.
 *  - S2 warm unchanged: persisted fresh memory survives the session boundary.
 *  - S3 mutated file: affected evidence is marked stale (never trusted).
 *  - S4 rename: evidence rebinds when the workspace journal knows the move,
 *    and degrades to stale-not-deleted otherwise.
 *  - S5 paired cold/warm: compiled context recalls reusable relevant evidence,
 *    excludes stale evidence, and uses the rebound path for a known rename.
 */
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { compileTaskMemoryContext } from '@codebuff/agent-runtime/util/task-memory'
import {
  compileMemoryV2Context,
  MEMORY_V2_CONTEXT_MAX_CHARS,
} from '@codebuff/agent-runtime/util/memory-v2-context'
import { MemoryTurnContextV2Schema } from '@codebuff/common/types/memory-v2'
import {
  loadPersistedTaskMemory,
  reconcileTaskMemoryEvidence,
  saveMergedTaskMemory,
} from '@openbuff/sdk/services/task-memory-store'

import type {
  TaskMemoryEvidenceV1,
  TaskMemoryV1,
} from '@codebuff/common/types/task-memory'

type CompiledEvidence = {
  id: string
  path?: string
  stale?: boolean
}

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

function evidenceFor(
  id: string,
  file: string,
  content: string,
): TaskMemoryEvidenceV1 {
  return {
    id,
    kind: 'read',
    summary: `Read ${file}`,
    path: file,
    freshnessHash: sha256(content),
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function findCompiledEvidence(value: unknown): CompiledEvidence[] | undefined {
  if (!isRecord(value)) return undefined

  if (Array.isArray(value.evidence)) {
    const evidence = value.evidence.filter(
      (item): item is Record<string, unknown> => isRecord(item),
    )
    if (evidence.every((item) => typeof item.id === 'string')) {
      return evidence.map((item) => ({
        id: item.id as string,
        ...(typeof item.path === 'string' ? { path: item.path } : {}),
        ...(typeof item.stale === 'boolean' ? { stale: item.stale } : {}),
      }))
    }
  }

  for (const child of Object.values(value)) {
    const evidence = findCompiledEvidence(child)
    if (evidence) return evidence
  }
  return undefined
}

function parseCompiledTaskMemory(context: string): {
  json: unknown
  evidence: CompiledEvidence[]
} {
  const jsonStart = context.indexOf('{')
  const jsonEnd = context.lastIndexOf('}')
  if (jsonStart < 0 || jsonEnd < jsonStart) {
    throw new Error('Compiled task-memory context did not contain JSON')
  }

  const json: unknown = JSON.parse(context.slice(jsonStart, jsonEnd + 1))
  const evidence = findCompiledEvidence(json)
  if (!evidence) {
    throw new Error('Compiled task-memory JSON did not contain evidence')
  }
  return { json, evidence }
}

function compilePersistedMemory(memory: TaskMemoryV1 | undefined): string {
  return memory ? compileTaskMemoryContext({ memory }) : ''
}

function countIds(
  evidence: CompiledEvidence[],
  expectedIds: ReadonlySet<string>,
): number {
  return evidence.filter((item) => expectedIds.has(item.id)).length
}

describe('memory retention scenario', () => {
  let rootDir: string

  beforeEach(async () => {
    rootDir = await mkdtemp(path.join(tmpdir(), 'memory-retention-'))
  })

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true })
  })

  test('S1 cold start recalls nothing', async () => {
    const cold = await loadPersistedTaskMemory({ rootDir })
    expect(cold).toBeUndefined()
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
  })

  test('S5 paired cold and warm contexts calculate deterministic retention metrics', async () => {
    const unchangedContent = 'export const stableLimit = 10'
    const changedOriginal = 'export const rollout = false'
    const changedCurrent = 'export const rollout = true'
    const renamedContent = 'export function retainedHelper() {}'
    const oldRenamePath = 'helper.ts'
    const newRenamePath = 'lib/helper.ts'

    await mkdir(path.join(rootDir, 'lib'), { recursive: true })
    await writeFile(path.join(rootDir, 'unchanged.ts'), unchangedContent)
    await writeFile(path.join(rootDir, 'changed.ts'), changedOriginal)
    await writeFile(path.join(rootDir, oldRenamePath), renamedContent)
    await saveMergedTaskMemory({
      rootDir,
      runMemory: makeMemory({
        evidence: [
          evidenceFor('ev-unchanged', 'unchanged.ts', unchangedContent),
          evidenceFor('ev-changed-stale', 'changed.ts', changedOriginal),
          evidenceFor('ev-renamed', oldRenamePath, renamedContent),
        ],
      }),
    })

    await writeFile(path.join(rootDir, 'changed.ts'), changedCurrent)
    await rm(path.join(rootDir, oldRenamePath))
    await writeFile(path.join(rootDir, newRenamePath), renamedContent)

    // Both arms observe the same workspace. The only difference is whether the
    // persisted memory is supplied to the compiler after reconciliation.
    const coldMemory = undefined
    const warmMemory = await reconcileTaskMemoryEvidence({
      memory: (await loadPersistedTaskMemory({ rootDir }))!,
      rootDir,
      workspaceMoves: [{ from: oldRenamePath, to: newRenamePath }],
    })
    const coldContext = compilePersistedMemory(coldMemory)
    const warmContext = compilePersistedMemory(warmMemory)
    const coldEvidence: CompiledEvidence[] = []
    const warmCompiled = parseCompiledTaskMemory(warmContext)
    const warmEvidence = warmCompiled.evidence

    const reusableRelevantIds = new Set(['ev-unchanged', 'ev-renamed'])
    const invalidEvidenceIds = new Set(['ev-changed-stale'])
    const eligibleRelevantFacts = reusableRelevantIds.size
    const coldRelevantRecall = countIds(coldEvidence, reusableRelevantIds)
    const warmRelevantRecall = countIds(warmEvidence, reusableRelevantIds)
    const incrementalRelevantRecall = warmRelevantRecall - coldRelevantRecall
    const coldIncorrectRecall = countIds(coldEvidence, invalidEvidenceIds)
    const warmIncorrectRecall = countIds(warmEvidence, invalidEvidenceIds)
    const incrementalIncorrectRecall =
      warmIncorrectRecall - coldIncorrectRecall
    const staleEvidenceExposed = countIds(warmEvidence, invalidEvidenceIds)
    const staleTrustViolations = warmEvidence.filter(
      (item) => item.stale === true || invalidEvidenceIds.has(item.id),
    ).length
    const rebound = warmMemory.evidence.find((item) => item.id === 'ev-renamed')
    const knownRenameRecovery = Number(
      rebound?.stale === false &&
        rebound.path === newRenamePath &&
        warmEvidence.some(
          (item) => item.id === 'ev-renamed' && item.path === newRenamePath,
        ) &&
        !warmEvidence.some((item) => item.path === oldRenamePath),
    )
    const coldContextBytes = Buffer.byteLength(coldContext, 'utf8')
    const warmContextBytes = Buffer.byteLength(warmContext, 'utf8')

    const metrics = {
      eligibleRelevantFacts,
      coldRelevantRecall,
      warmRelevantRecall,
      incrementalRelevantRecall,
      coldIncorrectRecall,
      warmIncorrectRecall,
      incrementalIncorrectRecall,
      staleEvidenceExposed,
      staleTrustViolations,
      knownRenameRecovery,
      coldContextBytes,
      warmContextBytes,
    }

    expect(metrics.eligibleRelevantFacts).toBe(2)
    expect(metrics.coldRelevantRecall).toBe(0)
    expect(metrics.warmRelevantRecall).toBe(metrics.eligibleRelevantFacts)
    expect(metrics.incrementalRelevantRecall).toBe(2)
    expect(metrics.coldIncorrectRecall).toBe(0)
    expect(metrics.warmIncorrectRecall).toBe(0)
    expect(metrics.incrementalIncorrectRecall).toBe(0)
    expect(metrics.staleEvidenceExposed).toBe(0)
    expect(metrics.staleTrustViolations).toBe(0)
    expect(metrics.knownRenameRecovery).toBe(1)
    expect(metrics.coldContextBytes).toBe(0)
    expect(metrics.warmContextBytes).toBeGreaterThan(metrics.coldContextBytes)

    // The unchanged artifact remains reusable, while changed evidence does not
    // become reusable merely because it was retained in persisted memory.
    expect(warmEvidence.some((item) => item.id === 'ev-unchanged')).toBe(true)
    expect(warmEvidence.some((item) => item.id === 'ev-changed-stale')).toBe(
      false,
    )

    // A fresh read of the changed artifact creates new evidence that the
    // compiler may expose; this is the deterministic reread requirement.
    await saveMergedTaskMemory({
      rootDir,
      runMemory: makeMemory({
        evidence: [
          evidenceFor('ev-changed-reread', 'changed.ts', changedCurrent),
        ],
        revision: warmMemory.revision,
        updatedAt: warmMemory.updatedAt + 1,
      }),
    })
    const afterReread = await reconcileTaskMemoryEvidence({
      memory: (await loadPersistedTaskMemory({ rootDir }))!,
      rootDir,
      workspaceMoves: [{ from: oldRenamePath, to: newRenamePath }],
    })
    const rereadEvidence = parseCompiledTaskMemory(
      compileTaskMemoryContext({ memory: afterReread }),
    ).evidence
    expect(
      rereadEvidence.some((item) => item.id === 'ev-changed-reread'),
    ).toBe(true)
    expect(rereadEvidence.some((item) => item.id === 'ev-changed-stale')).toBe(
      false,
    )
  })

  test('S6 V2 compiler isolates stale facts and deterministically avoids duplicate exploration', () => {
    const originalFetch = globalThis.fetch
    let networkCalls = 0
    globalThis.fetch = ((..._args: Parameters<typeof fetch>) => {
      networkCalls++
      return Promise.reject(new Error('Network access is forbidden in the V2 retention eval'))
    }) as typeof fetch

    try {
      const reason = {
        code: 'verified-evidence' as const,
        contribution: 1,
        detail: 'Fresh digest verified locally',
      }
      const sourceFacts = {
        stable: 'STABLE_SENTINEL rate limit is 10',
        unrelated: 'UNRELATED_TASK_SENTINEL billing uses a separate service',
        stale: 'STALE_SENTINEL rollout is disabled',
        replacement: 'REPLACEMENT_SENTINEL rollout is enabled',
      }
      const makeObservation = (id: string, summary: string) => ({
        observationId: id,
        taskId: 'task:v2',
        kind: 'fact' as const,
        summary,
        detail: summary,
        confidence: 1,
        evidence: [],
        tags: ['v2-eval'],
        observedAt: '2026-09-10T19:41:53.753Z',
      })
      const makeEvidence = (file: string) => ({
        artifact: {
          artifactId: `artifact:${file}`,
          location: file,
          digest: 'sha256:0123456789abcdef',
          classification: {
            kind: 'source' as const,
            generated: false,
            sensitivity: 'internal' as const,
            labels: ['v2-eval'],
          },
        },
        selector: { kind: 'file' as const, path: file },
        provenance: {
          origin: 'tool' as const,
          recordedBy: 'v2-retention-eval',
          sourceEventIds: [],
          toolName: 'read_files',
          metadata: {},
        },
        capturedAt: '2026-09-10T19:41:53.753Z',
        contentDigest: 'sha256:fedcba9876543210',
      })
      const buildContext = (freshReplacement: boolean) =>
        MemoryTurnContextV2Schema.parse({
          schemaVersion: 2,
          userInputId: 'input:v2-eval',
          queryId: freshReplacement ? 'query:v2-after-reread' : 'query:v2-before-reread',
          taskId: 'task:v2',
          result: {
            schemaVersion: 2,
            queryId: freshReplacement ? 'query:v2-after-reread' : 'query:v2-before-reread',
            projectId: 'project:v2-eval',
            generatedAt: '2026-09-10T19:41:53.753Z',
            matchedTasks: [],
            verifiedKnowledge: [
              {
                observation: makeObservation(
                  'observation:stable',
                  sourceFacts.stable,
                ),
                verifiedEvidence: [makeEvidence('stable.ts')],
                verifiedAt: '2026-09-10T19:41:53.753Z',
                score: 1,
                reasons: [reason],
              },
              {
                observation: makeObservation(
                  'observation:known-rename',
                  'Known helper moved to lib/helper.ts',
                ),
                verifiedEvidence: [makeEvidence('lib/helper.ts')],
                verifiedAt: '2026-09-10T19:41:53.753Z',
                score: 0.9,
                reasons: [reason],
              },
              ...(freshReplacement
                ? [{
                    observation: makeObservation(
                      'observation:replacement',
                      sourceFacts.replacement,
                    ),
                    verifiedEvidence: [makeEvidence('changed.ts')],
                    verifiedAt: '2026-09-10T19:41:53.753Z',
                    score: 1,
                    reasons: [reason],
                  }]
                : []),
            ],
            reusableDiscovery: [],
            rereadRequired: [
              ...(!freshReplacement
                ? [{
                    observationId: 'observation:stale',
                    selector: { kind: 'symbol' as const, path: 'changed.ts', symbol: 'rollout', occurrence: 1 },
                    reason: 'changed' as const,
                    detail: 'Live symbol must be reread before use',
                    score: 1,
                    reasons: [{ ...reason, code: 'stale-evidence' as const }],
                  }]
                : []),
              {
                observationId: 'observation:unknown-rename',
                selector: { kind: 'file' as const, path: 'unknown-old.ts' },
                reason: 'missing' as const,
                detail: 'No trusted move journal entry exists',
                score: 0.8,
                reasons: [{ ...reason, code: 'stale-evidence' as const }],
              },
            ],
            historicalContext: [],
            degradation: { state: 'none' },
            rankingReasons: [],
          },
        })

      const beforeReread = buildContext(false)
      const beforePrompt = compileMemoryV2Context(beforeReread)
      expect(beforePrompt).toContain('STABLE_SENTINEL')
      expect(beforePrompt).not.toContain(sourceFacts.unrelated)
      expect(beforePrompt).not.toContain(sourceFacts.stale)
      expect(beforePrompt).not.toContain(sourceFacts.replacement)
      expect(beforePrompt).toContain('"kind":"symbol"')
      expect(beforePrompt).toContain('changed.ts')
      expect(beforePrompt).toContain('lib/helper.ts')
      expect(beforePrompt).not.toContain('"path":"helper.ts"')
      expect(beforePrompt).toContain('unknown-old.ts')

      const afterReread = buildContext(true)
      const afterPrompt = compileMemoryV2Context(afterReread)
      expect(afterPrompt).toContain(sourceFacts.replacement)
      expect(afterPrompt).not.toContain(sourceFacts.stale)

      const workspaceTargets = ['stable.ts', 'changed.ts', 'lib/helper.ts', 'unknown-old.ts']
      const explore = (context: ReturnType<typeof buildContext> | undefined) => {
        let readAttempts = 0
        const reusablePaths = new Set(
          context?.result.verifiedKnowledge.flatMap((item) =>
            item.verifiedEvidence.flatMap((itemEvidence) =>
              'path' in itemEvidence.selector ? [itemEvidence.selector.path] : [],
            ),
          ) ?? [],
        )
        for (const target of workspaceTargets) {
          if (!reusablePaths.has(target)) readAttempts++
        }
        return readAttempts
      }
      const coldReadAttempts = explore(undefined)
      const warmReadAttempts = explore(beforeReread)
      const promptBytes = Buffer.byteLength(beforePrompt, 'utf8')
      const metrics = {
        coldReadAttempts,
        warmReadAttempts,
        duplicateReadsAvoided: coldReadAttempts - warmReadAttempts,
        promptBytes,
        compilerMaxChars: MEMORY_V2_CONTEXT_MAX_CHARS,
        networkCalls,
        modelCalls: 0,
      }

      expect(metrics).toEqual({
        coldReadAttempts: 4,
        warmReadAttempts: 2,
        duplicateReadsAvoided: 2,
        promptBytes,
        compilerMaxChars: 12_000,
        networkCalls: 0,
        modelCalls: 0,
      })
      expect(beforePrompt.length).toBeLessThanOrEqual(MEMORY_V2_CONTEXT_MAX_CHARS)
      expect(metrics.promptBytes).toBeGreaterThan(0)
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
