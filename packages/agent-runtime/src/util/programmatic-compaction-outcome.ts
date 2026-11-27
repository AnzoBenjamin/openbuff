import type { ToolResultOutput } from '@codebuff/common/types/messages/content-part'
import type { RuntimeSemanticCompactionOutcome } from './runtime-semantic-compaction'

const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined

/** Classify only the host inline-spawn receipt, never a pruner's claimed prose. */
export function inlineCompactionOutcome(
  output: ToolResultOutput[] | undefined,
): RuntimeSemanticCompactionOutcome {
  for (const part of output ?? []) {
    if (part.type !== 'json') continue
    const value = record(part.value)
    const receipt = record(value?.agentReceipt)
    if (!receipt) continue
    const result = record(receipt.output)
    const message =
      typeof result?.message === 'string' ? result.message : undefined
    if (
      receipt.status === 'cancelled' &&
      message?.startsWith('Semantic compaction skipped:')
    )
      return { outcome: 'skipped', reason: message.slice(0, 400) }
    if (receipt.status === 'completed') return { outcome: 'completed' }
    const outcome = record(receipt.runOutcome)
    const cause = record(outcome?.cause)
    const reason =
      typeof cause?.message === 'string' && cause.message
        ? cause.message
        : typeof result?.error === 'string' && result.error
          ? result.error
          : message ||
            `Inline context pruner ended with ${String(receipt.status ?? 'unknown')} status.`
    return { outcome: 'failed', reason: reason.slice(0, 400) }
  }
  return {
    outcome: 'failed',
    reason:
      'Inline context pruner returned no host completion receipt; compaction is unconfirmed.',
  }
}
