import { classifyMemoryArtifactPath } from '@codebuff/common/util/memory-artifact-policy'
import { jsonToolResult } from '@codebuff/common/util/messages'
import { TASK_MEMORY_LIST_CAPS } from '@codebuff/common/types/task-memory'

import type { CodebuffToolHandlerFunction } from '../handler-function-type'
import type { CodebuffToolCall, CodebuffToolOutput } from '@codebuff/common/tools/list'
import type { Logger } from '@codebuff/common/types/contracts/logger'
import type { AgentState } from '@codebuff/common/types/session-state'
import { hasDecisionRationale } from '@codebuff/common/util/decision-rationale'
import { realClock } from '@codebuff/common/deps/real-runtime-deps'
import type { Clock } from '@codebuff/common/types/contracts/agent-runtime'

type ToolName = 'record_decision'

function errorOutput(message: string): { output: CodebuffToolOutput<ToolName> } {
  return { output: jsonToolResult({ errorMessage: message }) }
}

const SUPERSEDES_ERROR =
  'record_decision: supersedes must contain 1..16 observation id strings of at most 128 characters.'

export const handleRecordDecision = (async (params: {
  previousToolCallFinished: Promise<void>
  toolCall: CodebuffToolCall<ToolName>
  agentState: AgentState
  logger?: Logger
  clock?: Clock
}): Promise<{ output: CodebuffToolOutput<ToolName> }> => {
  const { previousToolCallFinished, toolCall, agentState, logger } = params
  await previousToolCallFinished
  // P2-T1b: timestamps use the injected clock (realClock default).
  const evidenceTimestamp = (params.clock ?? realClock).now()
  try {
    const input = toolCall.input as {
      text?: unknown
      kind?: unknown
      evidenceSelectors?: unknown
      excerpt?: unknown
      supersedes?: unknown
    }
    const rawText = typeof input.text === 'string' ? input.text.trim() : ''
    const kind = input.kind === 'decision' || input.kind === 'fact' || input.kind === 'constraint' ? input.kind : 'decision'
    const rawSelectors = Array.isArray(input.evidenceSelectors) ? (input.evidenceSelectors as unknown[]) : []
    const excerpt = typeof input.excerpt === 'string' && input.excerpt.trim().length > 0 ? input.excerpt.trim() : undefined
    if (rawText.length === 0) {
      return errorOutput('record_decision: text must be non-empty.')
    }
    if (rawText.length > 1024) {
      return errorOutput('record_decision: text must be at most 1024 characters.')
    }
    if ((kind === 'decision' || kind === 'constraint') && !hasDecisionRationale(rawText)) {
      return errorOutput('record_decision: a decision/constraint must state a rationale (>=24 chars and include one of: because, so that, instead of, to avoid, rather than, chose, rejected, trade, prefer, must, require).')
    }
    if (rawSelectors.length < 1 || rawSelectors.length > 32) {
      return errorOutput('record_decision: evidenceSelectors must contain 1..32 entries.')
    }
    if (excerpt !== undefined && excerpt.length > 1024) {
      return errorOutput('record_decision: excerpt must be at most 1024 characters.')
    }
    let supersedes: string[] | undefined
    if (input.supersedes !== undefined) {
      const rawSupersedes = Array.isArray(input.supersedes) ? (input.supersedes as unknown[]) : []
      if (rawSupersedes.length < 1 || rawSupersedes.length > 16) {
        return errorOutput(SUPERSEDES_ERROR)
      }
      const normalizedSupersedes: string[] = []
      const seen = new Set<string>()
      for (const target of rawSupersedes) {
        if (typeof target !== 'string') {
          return errorOutput(SUPERSEDES_ERROR)
        }
        const trimmed = target.trim()
        if (trimmed.length === 0 || trimmed.length > 128) {
          return errorOutput(SUPERSEDES_ERROR)
        }
        if (!seen.has(trimmed)) {
          seen.add(trimmed)
          normalizedSupersedes.push(trimmed)
        }
      }
      supersedes = normalizedSupersedes
    }
    const normalizedPaths: string[] = []
    for (const selector of rawSelectors) {
      if (typeof selector !== 'string') {
        return errorOutput('record_decision: every evidenceSelector must be a project-relative path string.')
      }
      const trimmed = selector.trim()
      if (trimmed.length === 0 || trimmed.length > 1024) {
        return errorOutput('record_decision: evidence path must be 1..1024 characters.')
      }
      const decision = classifyMemoryArtifactPath(trimmed)
      if (!decision.allowed || !decision.normalizedPath) {
        return errorOutput('record_decision: rejected evidence path: ' + (decision.reason ?? 'not allowed') + '.')
      }
      normalizedPaths.push(decision.normalizedPath)
    }
    if (!agentState.taskMemory) {
      agentState.taskMemory = {
        schemaVersion: 1,
        goal: '',
        requirements: [],
        decisions: [],
        filesInspected: [],
        editsMade: [],
        validationResults: [],
        reviewReceipts: [],
        blockers: [],
        nextActions: [],
        historicalSummary: '',
        evidence: [],
        revision: 0,
        updatedAt: evidenceTimestamp,
        checksum: 'record-decision-init',
      }
    }
    const memory = agentState.taskMemory
    if (!Array.isArray(memory.decisions)) {
      memory.decisions = []
    }
    if (!Array.isArray(memory.evidence)) {
      memory.evidence = []
    }
    const record = '[' + kind + '] ' + rawText
    memory.decisions.push(record)
    while (memory.decisions.length > TASK_MEMORY_LIST_CAPS.decisions) {
      memory.decisions.shift()
    }
    // Evidence ids must be unique even when several decisions land in the same
    // millisecond after an eviction: `decisions.length` resets once the list cap
    // shifts entries out, so two same-millisecond records after a shift would
    // collide and `normalizeEvidence`'s newest-wins dedupe would silently drop
    // one. Sequence numbers are instead continued from the highest suffix
    // already stored for this timestamp, so they only ever increase.
    const idPrefix = 'decision:' + evidenceTimestamp.toString() + ':'
    let idSequence = 0
    for (const item of memory.evidence) {
      if (!item.id.startsWith(idPrefix)) continue
      const suffix = Number.parseInt(item.id.slice(idPrefix.length), 10)
      if (Number.isInteger(suffix) && suffix >= idSequence) {
        idSequence = suffix + 1
      }
    }
    const evidenceId = (idPrefix + String(idSequence)).slice(0, 160)
    const lines = ['[' + kind + '] ' + rawText, 'Evidence: ' + normalizedPaths.join(', ')]
    if (excerpt !== undefined) {
      lines.push('Excerpt: ' + excerpt)
    }
    const summary = lines.join('\n').slice(0, 2000)
    const evidenceKind = kind === 'constraint' ? 'requirement' : kind === 'fact' ? 'note' : 'decision'
    memory.evidence.push({
      id: evidenceId,
      kind: evidenceKind,
      summary,
      source: normalizedPaths[0],
      path: normalizedPaths[0],
      // P2-T1b: verifiedAt uses the injected clock (matches realClock default),
      // keeping this record on the same ordering basis as derived evidence.
      verifiedAt: evidenceTimestamp,
      // Persisting `supersedes` lets `normalizeEvidence` mark the superseded
      // observations stale; echoing it in the output alone was never persisted.
      ...(supersedes !== undefined ? { supersedes } : {}),
    })
    while (memory.evidence.length > TASK_MEMORY_LIST_CAPS.evidence) {
      memory.evidence.shift()
    }
    if (logger) {
      logger.debug({ kind, evidenceCount: normalizedPaths.length }, 'Recorded decision')
    }
    return {
      output: jsonToolResult({
        message: 'Recorded ' + kind + ' with ' + String(normalizedPaths.length) + ' evidence path(s).',
        kind,
        evidenceCount: normalizedPaths.length,
        text: rawText,
        evidenceSelectors: normalizedPaths,
        ...(excerpt !== undefined ? { excerpt } : {}),
        ...(supersedes !== undefined ? { supersedes } : {}),
      }),
    }
  } catch (error) {
    if (logger) {
      logger.debug({ error: error instanceof Error ? error.message : String(error) }, 'record_decision failed best-effort')
    }
    return errorOutput('record_decision: failed to record decision.')
  }
}) satisfies CodebuffToolHandlerFunction<ToolName>
