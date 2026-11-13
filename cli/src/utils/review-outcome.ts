import {
  getStructuredErrorMessages,
  getToolOutputRecords,
  getToolOutputValues,
} from './tool-result-normalizer'
import type { ToolContentBlock } from '../types/chat'

const verdicts = new Set([
  'BLOCKING',
  'NON_BLOCKING',
  'LOOKS_GOOD',
  'NEEDS_WORK',
  'APPROVED',
])
/** The actual set_output parameter is { data }; direct records are legacy. */
const decodedReceipts = new WeakMap<object, { data: string; value: unknown }>()
export function submittedReceiptValue(input: unknown): unknown {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return input
  const record = input as Record<string, unknown>
  const value = Object.prototype.hasOwnProperty.call(record, 'data')
    ? record.data
    : input
  if (
    typeof value !== 'string' ||
    value.length > 8_000_000 ||
    !value.trimStart().startsWith('{')
  )
    return value
  const cached = decodedReceipts.get(input)
  if (cached?.data === value) return cached.value
  try {
    const decoded: unknown = JSON.parse(value)
    decodedReceipts.set(input, { data: value, value: decoded })
    return decoded
  } catch {
    return value
  }
}

export function hasOutputAcknowledgment(block: ToolContentBlock): boolean {
  return (
    getToolOutputRecords(block.outputRaw).some(
      (record) =>
        record.message === 'Output set' ||
        record.success === true ||
        explicitReviewVerdict(record) !== null ||
        explicitReviewVerdict(record.value) !== null,
    ) ||
    getToolOutputValues(block.outputRaw).some((value) => value === 'Output set')
  )
}

export function explicitReviewVerdict(value: unknown): string | null {
  if (typeof value === 'string') {
    // Only a leading declared verdict is legacy evidence; quotes, examples,
    // fenced snippets and incidental prose cannot attest a review outcome.
    const match =
      /^\s*(?:verdict\s*:\s*)?(NON_BLOCKING|BLOCKING|LOOKS_GOOD|NEEDS_WORK|APPROVED)(?:\s*[:—-]\s*|\s*$)/i.exec(
        value,
      )
    return match?.[1].toUpperCase() ?? null
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  for (const field of ['verdict', 'status', 'outcome']) {
    const verdict =
      typeof record[field] === 'string'
        ? record[field]
            .trim()
            .toUpperCase()
            .replace(/[\s-]+/g, '_')
        : ''
    if (verdicts.has(verdict)) return verdict
  }
  return null
}

export function acceptedReceiptVerdict(block: ToolContentBlock): string | null {
  if (
    block.toolName !== 'set_output' ||
    block.lifecycle === 'queued' ||
    block.lifecycle === 'running' ||
    block.lifecycle === 'failed' ||
    block.lifecycle === 'cancelled' ||
    block.outputRaw === undefined ||
    getStructuredErrorMessages(block.outputRaw).length
  )
    return null
  const records = getToolOutputRecords(block.outputRaw)
  if (
    records.some(
      (record) => record.salvaged === true || record.status === 'ignored',
    )
  )
    return null
  if (!hasOutputAcknowledgment(block)) return null
  const submitted = explicitReviewVerdict(submittedReceiptValue(block.input))
  if (submitted) return submitted
  for (const record of records) {
    const verdict =
      explicitReviewVerdict(record) ?? explicitReviewVerdict(record.value)
    if (verdict) return verdict
  }
  return null
}
