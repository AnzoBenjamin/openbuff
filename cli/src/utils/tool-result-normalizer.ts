import type { ToolContentBlock } from '../types/chat'

export type ToolResultRecord = Record<string, unknown>

export const TERMINAL_TOOL_LIFECYCLES = new Set([
  'succeeded',
  'failed',
  'cancelled',
] as const)

export function getToolOutputValues(outputRaw: unknown): unknown[] {
  const parts = Array.isArray(outputRaw) ? outputRaw : [outputRaw]
  return parts
    .filter((part) => part !== undefined)
    .map((part) =>
      part && typeof part === 'object' && 'value' in part
        ? (part as { value: unknown }).value
        : part,
    )
}

export function getToolOutputRecords(outputRaw: unknown): ToolResultRecord[] {
  return getToolOutputValues(outputRaw).filter(
    (value): value is ToolResultRecord =>
      value !== null && typeof value === 'object' && !Array.isArray(value),
  )
}

export function findToolResultByKind(
  outputRaw: unknown,
  kind: string,
): ToolResultRecord | null {
  return (
    getToolOutputRecords(outputRaw).find((value) => value.kind === kind) ?? null
  )
}

function asMessage(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

export function getStructuredErrorMessages(outputRaw: unknown): string[] {
  const messages: string[] = []
  // Only the tool-result ENVELOPE (top-level output records) is scanned for
  // error fields. Recursing into arbitrary payload DATA produced
  // shard-cli-tui's false-positive failure mode: nested result data carrying
  // its own `error` / `errorMessage` field flipped a successful tool to
  // lifecycle 'failed' (MEDIUM correctness finding, tool-result-normalizer
  // false positives on nested payload data).
  const visit = (value: unknown): void => {
    if (value === null || value === undefined) return
    if (typeof value === 'string') return
    if (Array.isArray(value)) {
      value.forEach((entry) => visit(entry))
      return
    }
    if (typeof value !== 'object') return

    const record = value as ToolResultRecord
    const error = record.error
    if (typeof error === 'string') messages.push(error.trim())
    else if (
      error &&
      typeof error === 'object' &&
      typeof (error as ToolResultRecord).message === 'string'
    ) {
      messages.push((error as ToolResultRecord).message as string)
    }
    const direct = asMessage(record.errorMessage)
    if (direct) messages.push(direct)
  }
  getToolOutputValues(outputRaw).forEach((value) => visit(value))
  return [...new Set(messages.filter(Boolean))]
}

export function hasMultipartError(outputRaw: unknown): boolean {
  return getStructuredErrorMessages(outputRaw).length > 0
}

export function getCanonicalMutationResult(
  outputRaw: unknown,
): ToolResultRecord | null {
  return findToolResultByKind(outputRaw, 'file_mutation_result')
}

export function getCanonicalMutationActions(
  outputRaw: unknown,
): ToolResultRecord[] {
  const result = getCanonicalMutationResult(outputRaw)
  return result && Array.isArray(result.actions)
    ? result.actions.filter(
        (action): action is ToolResultRecord =>
          action !== null &&
          typeof action === 'object' &&
          !Array.isArray(action),
      )
    : []
}

export function getCanonicalMutationPrimaryAction(
  outputRaw: unknown,
): ToolResultRecord | null {
  return getCanonicalMutationActions(outputRaw)[0] ?? null
}

export function isTerminalToolBlock(block: ToolContentBlock): boolean {
  return Boolean(
    block.lifecycle && TERMINAL_TOOL_LIFECYCLES.has(block.lifecycle as never),
  )
}

export function getConfirmedMutationActions(
  block: ToolContentBlock,
): ToolResultRecord[] {
  const result = getCanonicalMutationResult(block.outputRaw)
  if (!result || !Array.isArray(result.actions)) return []
  return result.actions.filter(
    (action): action is ToolResultRecord =>
      Boolean(action) &&
      typeof action === 'object' &&
      (action as ToolResultRecord).outcome === 'applied',
  )
}
