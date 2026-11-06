import {
  fileMutationResultV1Schema,
  getConfirmedAppliedActionsV1,
  mutationResultExceedsCheapBoundsV1,
} from '@codebuff/common/tools/results/filesystem'

import type { ToolContentBlock } from '../types/chat'

export type ToolResultRecord = Record<string, unknown>
export const TOOL_RESULT_METADATA_LIMIT = 4096

export const TERMINAL_TOOL_LIFECYCLES = new Set([
  'succeeded',
  'failed',
  'cancelled',
] as const)

export function getToolOutputValues(outputRaw: unknown): unknown[] {
  if (Array.isArray(outputRaw) && outputRaw.length > TOOL_RESULT_METADATA_LIMIT)
    return [outputRaw]
  // Bare array payloads are already retained; do not clone a large collection
  // merely to inspect its envelope. Actual transport tuples are tiny.
  if (
    Array.isArray(outputRaw) &&
    !outputRaw
      .slice(0, 32)
      .some(
        (part) =>
          part &&
          typeof part === 'object' &&
          part.type === 'json' &&
          'value' in part,
      )
  )
    return outputRaw
  const parts = Array.isArray(outputRaw) ? outputRaw : [outputRaw]
  return parts
    .filter((part) => part !== undefined)
    .map((part) =>
      part &&
      typeof part === 'object' &&
      (part as { type?: unknown }).type === 'json' &&
      'value' in part
        ? (part as { value: unknown }).value
        : part,
    )
}

export function getToolOutputRecords(outputRaw: unknown): ToolResultRecord[] {
  const values = getToolOutputValues(outputRaw)
  const records: ToolResultRecord[] = []
  for (
    let index = 0;
    index < Math.min(values.length, TOOL_RESULT_METADATA_LIMIT);
    index++
  ) {
    const value = values[index]
    if (value !== null && typeof value === 'object' && !Array.isArray(value))
      records.push(value as ToolResultRecord)
  }
  return records
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
      // Only one producer array level is an envelope collection. Arbitrary
      // nested/circular arrays remain payload data.
      for (
        let index = 0;
        index < Math.min(value.length, TOOL_RESULT_METADATA_LIMIT);
        index++
      ) {
        const entry = value[index]
        if (entry && typeof entry === 'object' && !Array.isArray(entry))
          visit(entry)
      }
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
  const values = getToolOutputValues(outputRaw)
  for (
    let index = 0;
    index < Math.min(values.length, TOOL_RESULT_METADATA_LIMIT);
    index++
  )
    visit(values[index])
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
  return getConfirmedMutationActionsFromOutput(block.outputRaw)
}

export function getConfirmedMutationActionsFromOutput(
  outputRaw: unknown,
): ToolResultRecord[] {
  const result = getCanonicalMutationResult(outputRaw)
  if (!result || mutationResultExceedsCheapBoundsV1(result)) return []
  const parsed = fileMutationResultV1Schema.safeParse(result)
  return parsed.success ? getConfirmedAppliedActionsV1(parsed.data) : []
}

/** Reported application without correlated authority remains unconfirmed. */
export function getMutationOutcome(outputRaw: unknown): string | undefined {
  const result = getCanonicalMutationResult(outputRaw)
  if (!result) return undefined
  if (mutationResultExceedsCheapBoundsV1(result)) return 'unconfirmed'
  const parsed = fileMutationResultV1Schema.safeParse(result)
  if (!parsed.success) return 'unconfirmed'
  if (parsed.data.outcome !== 'applied') return parsed.data.outcome
  const confirmed = getConfirmedAppliedActionsV1(parsed.data)
  return confirmed.length === parsed.data.actions.length && confirmed.length > 0
    ? 'applied'
    : confirmed.length > 0
      ? 'partial'
      : 'unconfirmed'
}
