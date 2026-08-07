/**
 * Thinker empty-harvest clobber signals.
 *
 * Advisory, pure detection of the pattern where a thinker subagent emits a
 * non-empty `set_output` and a later empty harvest `set_output` clobbers it
 * (real case: buffbench spawn LsHOhL5cwBo). Mirrors the design of
 * `plan-sharding-signals.ts` / `retrieval-flow-metrics.ts`: no I/O, defensive
 * typing for slightly drifted eval payloads, unit-tested only for now.
 *
 * Detection strategy:
 *  - `subagent_start` with `agentType === 'thinker'` discovers thinker ids.
 *  - Per thinker, ordered `tool_call` events with `toolName === 'set_output'`
 *    and matching `agentId` are classified non-empty / empty via
 *    `extractMessageFromSetOutputInput` (supports both top-level `message`
 *    and nested `data.message`).
 *  - **emptyHarvestClobber**: a non-empty set_output is followed later by an
 *    empty set_output (includeToolCall: false is a strong harvest signal but
 *    not required).
 *  - **preservedNonEmpty**: the thinker's final set_output is non-empty.
 *  - **plainTextOnly**: thinker with no set_output tool_calls (skip path).
 */

import type { PrintModeEvent } from '@codebuff/common/types/print-mode'

/** One thinker `set_output` tool_call, in trace order. */
export interface ThinkerSetOutputCall {
  toolCallId: string
  /** Extracted non-empty message, if any. */
  message: string | undefined
  isNonEmpty: boolean
  /** Present on real harvest events; optional for drifted payloads. */
  includeToolCall?: boolean
}

/** Per-thinker harvest classification. */
export interface ThinkerHarvestAgentSignal {
  agentId: string
  setOutputCalls: ThinkerSetOutputCall[]
  setOutputCount: number
  nonEmptySetOutputCount: number
  emptySetOutputCount: number
  /** True when this thinker never called set_output. */
  plainTextOnly: boolean
  /**
   * True when a non-empty set_output was followed by a later empty set_output
   * (the harvest clobber path).
   */
  emptyHarvestClobber: boolean
  /**
   * True when the final set_output for this thinker is non-empty (no later
   * empty clobber).
   */
  preservedNonEmpty: boolean
  /** Final extracted non-empty message, if the last set_output was non-empty. */
  finalNonEmptyMessage?: string
}

/** Aggregate harvest signals derived from a PrintModeEvent trace. */
export interface ThinkerHarvestSignals {
  /** Thinker agentIds discovered from subagent_start (trace order, unique). */
  thinkerAgentIds: string[]
  /** Per-agent classifications in the same order as thinkerAgentIds. */
  agents: ThinkerHarvestAgentSignal[]
  anyEmptyHarvestClobber: boolean
  anyPreservedNonEmpty: boolean
  /** True when every thinker had zero set_output calls (or no thinkers). */
  allPlainTextOnly: boolean
}

export type ThinkerHarvestVerdict = 'pass' | 'fail' | 'skip'

export interface ThinkerHarvestEvaluation {
  verdict: ThinkerHarvestVerdict
  reasons: string[]
  signals: ThinkerHarvestSignals
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  return value.trim() === '' ? undefined : value
}

/**
 * Recover a non-empty message from set_output input shapes used by models
 * and harvest paths. Supports top-level `message` and nested `data.message`
 * (LsHOhL5cwBo used the latter). Returns undefined for missing/empty.
 */
export function extractMessageFromSetOutputInput(
  input: unknown,
): string | undefined {
  if (!isRecord(input)) return undefined

  const topLevel = nonEmptyString(input.message)
  if (topLevel !== undefined) return topLevel

  if (isRecord(input.data)) {
    const nested = nonEmptyString(input.data.message)
    if (nested !== undefined) return nested
  }

  return undefined
}

function classifyThinkerAgent(params: {
  agentId: string
  setOutputCalls: ThinkerSetOutputCall[]
}): ThinkerHarvestAgentSignal {
  const { agentId, setOutputCalls } = params
  const nonEmptySetOutputCount = setOutputCalls.filter((c) => c.isNonEmpty).length
  const emptySetOutputCount = setOutputCalls.length - nonEmptySetOutputCount
  const plainTextOnly = setOutputCalls.length === 0

  let sawNonEmpty = false
  let emptyHarvestClobber = false
  for (const call of setOutputCalls) {
    if (call.isNonEmpty) {
      sawNonEmpty = true
      continue
    }
    if (sawNonEmpty) {
      emptyHarvestClobber = true
      break
    }
  }

  const last = setOutputCalls[setOutputCalls.length - 1]
  const preservedNonEmpty =
    last !== undefined && last.isNonEmpty && !emptyHarvestClobber

  return {
    agentId,
    setOutputCalls,
    setOutputCount: setOutputCalls.length,
    nonEmptySetOutputCount,
    emptySetOutputCount,
    plainTextOnly,
    emptyHarvestClobber,
    preservedNonEmpty,
    finalNonEmptyMessage:
      preservedNonEmpty && last?.message !== undefined
        ? last.message
        : undefined,
  }
}

/**
 * Scan a PrintModeEvent trace for thinker empty-harvest clobber signals.
 * Pure: no I/O. Defensive against missing optional fields on drifted events.
 */
export function computeThinkerHarvestSignals(params: {
  events: readonly PrintModeEvent[]
}): ThinkerHarvestSignals {
  const { events } = params

  const thinkerAgentIds: string[] = []
  const seenThinkers = new Set<string>()
  const setOutputsByAgent = new Map<string, ThinkerSetOutputCall[]>()

  for (const event of events) {
    if (event.type === 'subagent_start') {
      const agentType =
        typeof event.agentType === 'string' ? event.agentType : ''
      const agentId = typeof event.agentId === 'string' ? event.agentId : ''
      if (agentType === 'thinker' && agentId && !seenThinkers.has(agentId)) {
        seenThinkers.add(agentId)
        thinkerAgentIds.push(agentId)
        if (!setOutputsByAgent.has(agentId)) {
          setOutputsByAgent.set(agentId, [])
        }
      }
      continue
    }

    if (event.type !== 'tool_call') continue
    if (event.toolName !== 'set_output') continue

    const agentId = typeof event.agentId === 'string' ? event.agentId : ''
    if (!agentId || !seenThinkers.has(agentId)) continue

    const message = extractMessageFromSetOutputInput(event.input)
    const call: ThinkerSetOutputCall = {
      toolCallId:
        typeof event.toolCallId === 'string' ? event.toolCallId : '',
      message,
      isNonEmpty: message !== undefined,
      includeToolCall:
        typeof event.includeToolCall === 'boolean'
          ? event.includeToolCall
          : undefined,
    }

    const list = setOutputsByAgent.get(agentId)
    if (list) {
      list.push(call)
    } else {
      setOutputsByAgent.set(agentId, [call])
    }
  }

  const agents = thinkerAgentIds.map((agentId) =>
    classifyThinkerAgent({
      agentId,
      setOutputCalls: setOutputsByAgent.get(agentId) ?? [],
    }),
  )

  const anyEmptyHarvestClobber = agents.some((a) => a.emptyHarvestClobber)
  const anyPreservedNonEmpty = agents.some((a) => a.preservedNonEmpty)
  const allPlainTextOnly =
    agents.length === 0 || agents.every((a) => a.plainTextOnly)

  return {
    thinkerAgentIds,
    agents,
    anyEmptyHarvestClobber,
    anyPreservedNonEmpty,
    allPlainTextOnly,
  }
}

/**
 * Aggregate per-thinker harvest signals into a pass/fail/skip verdict.
 *
 * - skip: no thinker subagents, or every thinker is plain-text-only (no
 *   set_output at all — nothing to clobber or preserve).
 * - fail: any thinker has emptyHarvestClobber, or set_output was used but no
 *   thinker preserved a non-empty final output.
 * - pass: no clobbers, and every thinker either preserved non-empty final
 *   output or was plain-text-only (mixed with at least one preserved case).
 */
export function evaluateThinkerHarvest(params: {
  signals: ThinkerHarvestSignals
}): ThinkerHarvestEvaluation {
  const { signals } = params
  const reasons: string[] = []

  if (signals.thinkerAgentIds.length === 0) {
    return {
      verdict: 'skip',
      reasons: ['No thinker subagents in trace.'],
      signals,
    }
  }

  if (signals.allPlainTextOnly) {
    return {
      verdict: 'skip',
      reasons: [
        `All ${signals.thinkerAgentIds.length} thinker(s) used plain text only (no set_output); harvest clobber not applicable.`,
      ],
      signals,
    }
  }

  const clobberAgents = signals.agents.filter((a) => a.emptyHarvestClobber)
  if (clobberAgents.length > 0) {
    for (const agent of clobberAgents) {
      reasons.push(
        `Thinker ${agent.agentId}: empty harvest set_output clobbered a prior non-empty set_output (${agent.nonEmptySetOutputCount} non-empty, ${agent.emptySetOutputCount} empty).`,
      )
    }
    return {
      verdict: 'fail',
      reasons,
      signals,
    }
  }

  const unresolved = signals.agents.filter(
    (a) => !a.plainTextOnly && !a.preservedNonEmpty,
  )
  if (unresolved.length > 0) {
    for (const agent of unresolved) {
      reasons.push(
        `Thinker ${agent.agentId}: set_output used but final output was not a preserved non-empty message (${agent.setOutputCount} call(s), ${agent.nonEmptySetOutputCount} non-empty).`,
      )
    }
    return {
      verdict: 'fail',
      reasons,
      signals,
    }
  }

  const preserved = signals.agents.filter((a) => a.preservedNonEmpty)
  const plain = signals.agents.filter((a) => a.plainTextOnly)
  reasons.push(
    `No empty-harvest clobber; ${preserved.length} thinker(s) preserved non-empty final set_output` +
      (plain.length > 0
        ? `, ${plain.length} plain-text-only.`
        : '.'),
  )

  return {
    verdict: 'pass',
    reasons,
    signals,
  }
}
