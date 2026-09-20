/**
 * Compaction fidelity eval (deterministic, no LLM calls).
 *
 * Scores the fidelity of the compaction pipeline — how much task-relevant
 * information survives a compaction — by planting verbatim facts in a
 * realistic long transcript and pushing that transcript through the REAL
 * pipeline modules (deterministic eviction, the archive/recall leg, the
 * post-compaction extraction verifier). Companion to
 * evals/memory-retention: that suite scores cross-session memory retention;
 * this one scores within-session compaction fidelity.
 *
 * Metrics (F1–F4):
 *  - F1 eviction safety: tool results whose content a task-memory decision
 *    cites are never evicted (importance-aware protection).
 *  - F2 verification sensitivity: the extraction verifier reports every
 *    planted fact a destructive rewrite dropped (and stays silent when the
 *    extraction retained them).
 *  - F3 recall recovery: every evicted fact stays recoverable verbatim via
 *    the pre-compaction archive (`recall_context`).
 *  - F4 aggregate fidelity score: retained + recallable planted facts over
 *    all planted facts, asserted >= 1.0 for the fixture (the recall leg makes
 *    the pipeline information-lossless in principle for evicted content).
 */
import { describe, expect, test } from 'bun:test'

import { archivePreCompaction, recallFromArchive } from '@codebuff/agent-runtime/util/context-archive'
import {
  deriveProtectedEvictionPaths,
  evictStaleToolResults,
  EVICTION_KEEP_RECENT_STEPS,
} from '@codebuff/agent-runtime/util/tool-result-eviction'
import {
  verifyExtractionCoverage,
} from '@codebuff/agent-runtime/util/compaction-verification'

import type { ContextArchiveSnapshot } from '@codebuff/common/types/context-archive'
import type { Message, ToolMessage } from '@codebuff/common/types/messages/codebuff-message'
import type { TaskMemoryV1 } from '@codebuff/common/types/task-memory'

const PLANTED_PATHS = [
  'src/services/keystone-config.ts',
  'src/services/session-store.ts',
  'src/services/token-refresh.ts',
  'src/services/retry-policy.ts',
]
/** Verbatim fact planted inside each path's tool-result body. */
const plantedFact = (path: string): string =>
  `FACT[${path}]=retry-backoff-base-1500ms`

const buildLongTranscript = (): Message[] => {
  const messages: Message[] = [
    { role: 'user', content: [{ type: 'text', text: 'Harden the session stack.' }] },
  ]
  for (let i = 0; i < 24; i++) {
    const path = PLANTED_PATHS[i % PLANTED_PATHS.length]
    messages.push({
      role: 'assistant',
      content: [
        {
          type: 'tool-call',
          toolCallId: `call-${i}`,
          toolName: 'read_files',
          input: { paths: [path] },
        },
      ],
    })
    const result: ToolMessage = {
      role: 'tool',
      toolCallId: `call-${i}`,
      toolName: 'read_files',
      content: [
        {
          type: 'json',
          value: {
            output: `// ${path}\n${plantedFact(path)}\nexport const config_${i} = ${i}`,
          },
        },
      ],
    }
    messages.push(result)
  }
  return messages
}

/**
 * Destructive rewrite, worst case for extraction: a mechanical-trim-style
 * pass that DROPS whole messages older than the newest three steps (not just
 * tombstoning bodies), so the assistant tool-call inputs carrying the planted
 * paths are gone from the post-compaction transcript. This is the shape the
 * verifier exists to detect; a tombstone-only rewrite correctly reports
 * nothing missing (the tool-call facts survive) — covered by F1/F3 instead.
 */
const compactWorstCase = (messages: Message[]): Message[] => {
  const keepFrom = Math.max(1, messages.length - 6)
  return messages.slice(0, 1).concat(messages.slice(keepFrom))
}

describe('compaction fidelity (F1–F4)', () => {
  const transcript = buildLongTranscript()
  // A task-memory decision cites one planted path: eviction must spare it.
  const citedPath = PLANTED_PATHS[0]
  const taskMemory = {
    decisions: ['Chose 1500ms backoff because the retry tests demand it'],
    evidence: [{ path: citedPath, source: citedPath }],
    filesInspected: [`read:${PLANTED_PATHS[1]}`],
  } as unknown as TaskMemoryV1
  const protectedPaths = deriveProtectedEvictionPaths(taskMemory)

  test('F1: eviction keeps cited-content results full', () => {
    const result = evictStaleToolResults(transcript, {
      keepRecentSteps: 0,
      minSavingsTokens: 1,
      protectedPaths,
    })
    expect(result.evictedCount).toBeGreaterThan(0)
    const toolResults = result.messages.filter(
      (m): m is ToolMessage => m.role === 'tool',
    )
    const cited = toolResults.filter((m) =>
      JSON.stringify(m.content).includes(citedPath),
    )
    expect(cited.length).toBeGreaterThan(0)
    for (const message of cited) {
      expect(JSON.stringify(message)).toContain(plantedFact(citedPath))
    }
  })

  test('F2: the verifier reports every fact a destructive rewrite dropped', () => {
    const compacted = compactWorstCase(transcript)
    const verification = verifyExtractionCoverage({
      preMessages: transcript,
      postMessages: compacted,
      taskMemory,
    })
    // The worst-case rewrite drops the planted facts: the verifier must see
    // the gaps (it is the completeness signal the knowledge memory lacks).
    expect(verification.expected).toBeGreaterThanOrEqual(PLANTED_PATHS.length)
    expect(verification.missing.length).toBeGreaterThan(0)
    // And a faithful extraction (knowledge memory carrying every path) is
    // reported as fully covered.
    const faithfulMemory = {
      filesInspected: PLANTED_PATHS.map((p) => `read:${p}`),
    } as unknown as TaskMemoryV1
    const covered = verifyExtractionCoverage({
      preMessages: transcript,
      postMessages: compacted,
      taskMemory: faithfulMemory,
    })
    expect(covered.missing).toEqual([])
  })

  test('F3: recall_context recovers evicted facts verbatim from the archive', () => {
    const archiveState: { compactionArchive?: ContextArchiveSnapshot[] } = {}
    archivePreCompaction(
      archiveState,
      transcript,
      'semantic_compaction',
      EVICTION_KEEP_RECENT_STEPS,
    )
    for (const path of PLANTED_PATHS) {
      const result = recallFromArchive(archiveState.compactionArchive, path)
      expect(result.matches.length).toBeGreaterThan(0)
      expect(
        result.matches.some((match) => match.snippet.includes(plantedFact(path))),
      ).toBe(true)
    }
  })

  test('F4: aggregate fidelity score is 1.0 for the fixture (retained + recallable)', () => {
    // Fresh transcript: archivePreCompaction dedupes by array identity (a
    // module-level WeakSet), so re-archiving the shared fixture array would
    // be a silent no-op and this test would score a phantom archive.
    const transcriptF4 = buildLongTranscript()
    const archiveState: { compactionArchive?: ContextArchiveSnapshot[] } = {}
    archivePreCompaction(
      archiveState,
      transcriptF4,
      'semantic_compaction',
      EVICTION_KEEP_RECENT_STEPS,
    )
    const compacted = compactWorstCase(transcriptF4)
    const verification = verifyExtractionCoverage({
      preMessages: transcriptF4,
      postMessages: compacted,
      taskMemory,
    })
    const allPlanted = [...new Set(PLANTED_PATHS)]
    const retained = allPlanted.filter(
      (path) => !verification.missing.some((fact) => fact.includes(path)),
    )
    const recallable = allPlanted.filter(
      (path) =>
        recallFromArchive(archiveState.compactionArchive, path).matches.length > 0,
    )
    const recovered = new Set([...retained, ...recallable])
    const fidelityScore = recovered.size / allPlanted.length
    expect(fidelityScore).toBe(1)
  })
})
