import type { ToolContentBlock } from '../types/chat'
import {
  getCanonicalMutationResult,
  getStructuredErrorMessages,
  getToolOutputRecords,
} from './tool-result-normalizer'

export type OutputOutcomeTone = 'good' | 'warn' | 'bad' | 'neutral'

const good = new Set([
  'success',
  'succeeded',
  'looks_good',
  'approved',
  'pass',
  'passed',
  'completed',
  'complete',
  'ok',
  'applied',
  'ready',
  'diagnostic_delta_passed',
])
const warning = new Set([
  'partial',
  'warning',
  'needs_changes',
  'retry',
  'skipped',
  'stale',
  'unavailable',
  'unchanged',
  'empty',
  'no_matches',
  'non_blocking',
  'reduced_assurance',
  'degraded',
  'rolled_back',
  'rollback_incomplete',
  'unconfirmed',
  'lost',
])
const bad = new Set([
  'failed',
  'failure',
  'blocked',
  'blocking',
  'needs_work',
  'error',
  'invalid',
  'cancelled',
  'unsupported',
  'rejected',
  'refused',
  'not_applied',
  'timed_out',
  'timeout',
  'diagnostic_delta_rejected',
])

export function normalizeOutcomeKey(
  outcome: string | undefined,
): string | undefined {
  if (typeof outcome !== 'string') return undefined
  return (
    outcome
      .trim()
      .toLowerCase()
      .replace(/[\s-]+/g, '_') || undefined
  )
}

export interface OutputOutcome {
  label: string
  tone: OutputOutcomeTone
  source: 'producer' | 'lifecycle' | 'unknown'
}

/** Transport completion never attests that an opaque custom result passed. */
export function outcomeForTool(
  block: Pick<
    ToolContentBlock,
    'toolName' | 'lifecycle' | 'outputRaw' | 'output'
  >,
): OutputOutcome {
  const records = getToolOutputRecords(block.outputRaw)
  const mutation = getCanonicalMutationResult(block.outputRaw)
  const result = mutation ?? records[0]
  const producer = (label: string): OutputOutcome => ({
    label: label.replaceAll('_', ' '),
    tone: classifyOutputOutcome(label),
    source: 'producer',
  })
  // A confirmed disk result remains authoritative after interruption.
  if (mutation && typeof mutation.status === 'string')
    return producer(mutation.status)
  if (mutation && typeof mutation.outcome === 'string')
    return producer(mutation.outcome)
  if (block.lifecycle === 'queued' || block.lifecycle === 'running')
    return { label: block.lifecycle, tone: 'neutral', source: 'lifecycle' }
  if (
    block.lifecycle === 'cancelled' &&
    ['check_job', 'check_background_agent', 'read_logs'].includes(
      block.toolName,
    ) &&
    result?.state !== 'cancelled'
  )
    return {
      label: `observation cancelled${typeof result?.state === 'string' ? ` · captured job ${result.state}` : ' · job state unavailable'}`,
      tone: 'warn',
      source: 'lifecycle',
    }
  if (block.lifecycle === 'cancelled')
    return { label: 'cancelled', tone: 'bad', source: 'lifecycle' }
  if (getStructuredErrorMessages(block.outputRaw).length)
    return producer('failed')
  if (
    block.toolName === 'query_index' &&
    result?.status &&
    typeof result.status === 'object' &&
    typeof (result.status as Record<string, unknown>).state === 'string'
  )
    return producer((result.status as Record<string, unknown>).state as string)
  if (
    block.toolName === 'evaluate_audit_coverage' &&
    typeof result?.complete === 'boolean'
  )
    return producer(result.complete ? 'complete' : 'partial')
  if (
    block.toolName === 'inspect_feature_completeness' &&
    (result?.evidenceKind === 'heuristic' ||
      result?.evidence_kind === 'heuristic')
  )
    return producer('reduced_assurance')
  if (result?.timedOut === true)
    return { label: 'wait timed out', tone: 'warn', source: 'producer' }
  if (typeof result?.exitCode === 'number' && Number.isFinite(result.exitCode))
    return {
      label: `exit ${result.exitCode}`,
      tone: result.exitCode === 0 ? 'good' : 'bad',
      source: 'producer',
    }
  if (
    ['rename_symbol', 'code_action', 'extract_symbol'].includes(
      block.toolName,
    ) &&
    Array.isArray(result?.results) &&
    result.results.some(
      (row) => row && typeof row === 'object' && row.applied === true,
    ) &&
    (result.applied === false ||
      result.results.some(
        (row) => row && typeof row === 'object' && row.applied !== true,
      ))
  )
    return producer('partial')
  if (result?.success === false || result?.applied === false)
    return producer('not_applied')
  for (const key of [
    'validationStatus',
    'outcome',
    'state',
    'status',
    'verdict',
  ]) {
    if (typeof result?.[key] === 'string')
      return producer(result[key] as string)
  }
  if (result?.success === true || result?.applied === true)
    return producer('success')
  if (block.lifecycle === 'failed')
    return { label: 'failed', tone: 'bad', source: 'lifecycle' }
  return {
    label:
      block.outputRaw === undefined && block.output === undefined
        ? 'output unavailable'
        : 'captured · outcome unknown',
    tone: 'neutral',
    source: 'unknown',
  }
}

export function classifyValidationResult(
  result: Record<string, unknown>,
): 'passed' | 'failed' | 'skipped' | 'unknown' {
  if (
    result.validationStatus === 'diagnostic_delta_rejected' ||
    (typeof result.errorMessage === 'string' &&
      Boolean(result.errorMessage.trim())) ||
    (typeof result.exitCode === 'number' && result.exitCode !== 0)
  )
    return 'failed'
  if (
    result.validationStatus === 'hooks_skipped' ||
    result.validationStatus === 'no_hooks_configured'
  )
    return 'skipped'
  if (
    result.validationStatus === 'diagnostic_delta_passed' ||
    result.exitCode === 0
  )
    return 'passed'
  return 'unknown'
}
export function classifyOutputOutcome(
  outcome: string | undefined,
): OutputOutcomeTone {
  const key = normalizeOutcomeKey(outcome)
  if (!key) return 'neutral'
  if (good.has(key)) return 'good'
  if (warning.has(key)) return 'warn'
  if (bad.has(key)) return 'bad'
  return 'neutral'
}
