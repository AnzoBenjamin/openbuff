/**
 * Pure file-extraction helpers shared between base agents (base2) and the
 * editor agent. These walk tool-call/tool-result shapes and collect changed
 * file paths so downstream agents can reuse a durable gate pass.
 *
 * NOTE: `agents/base2/base2.ts` and `agents/editor/editor.ts` both keep
 * parallel inline copies of these helpers inside their `handleSteps`
 * generators because those functions are serialized via
 * `handleSteps.toString()` and reconstructed with `new Function(...)`.
 * Reconstructed functions lose their module closure, so they cannot
 * reference imports from this file. Keep all three implementations in
 * sync; `agents/__tests__/gate-files-parity.test.ts` asserts their parity.
 */

import {
  fileMutationResultV1Schema,
  getConfirmedAppliedActionsV1,
} from '@codebuff/common/tools/results/filesystem'

/**
 * Returns true for tool names that mutate files on disk and therefore
 * count as a "changed file" source for the gate.
 */
export function isFileChangingTool(toolName: string): boolean {
  return (
    toolName === 'apply_patch' ||
    toolName === 'apply_smart_patch' ||
    toolName === 'edit_transaction' ||
    toolName === 'replace_range' ||
    toolName === 'rewrite_symbol' ||
    toolName === 'str_replace' ||
    toolName === 'write_file'
  )
}

/**
 * Returns true for tool-result records that represent a successful edit.
 *
 * Only canonical authority-backed mutation results with at least one applied
 * action count. Legacy diffs, prose, attempted inputs, and changedFiles arrays
 * are deliberately unconfirmed.
 */
export function hasEditArtifact(record: Record<string, unknown>): boolean {
  const parsed = fileMutationResultV1Schema.safeParse(record)
  return parsed.success && getConfirmedAppliedActionsV1(parsed.data).length > 0
}

/**
 * Walks a tool-call `input` payload and adds every file path it finds to
 * `out`. Handles the three edit-tool shapes used in this repo:
 *   - a top-level `path` (str_replace / replace_range / rewrite_symbol)
 *   - an `operation: { path }` wrapper (apply_patch / apply_smart_patch)
 *   - an `edits: [{ path }, ...]` array (edit_transaction)
 */
export function collectToolInputFiles(input: unknown, out: Set<string>): void {
  if (!input || typeof input !== 'object') return
  const record = input as Record<string, unknown>
  if (typeof record.path === 'string') out.add(record.path)
  const operation = record.operation
  if (
    operation &&
    typeof operation === 'object' &&
    typeof (operation as Record<string, unknown>).path === 'string'
  ) {
    out.add((operation as Record<string, string>).path)
  }
  const edits = record.edits
  if (Array.isArray(edits)) {
    for (const edit of edits) {
      if (
        edit &&
        typeof edit === 'object' &&
        typeof (edit as Record<string, unknown>).path === 'string'
      ) {
        out.add((edit as Record<string, string>).path)
      }
    }
  }
}

/**
 * Collect paths from a schemaVersion=1 agent receipt or a runtime envelope
 * with `agentReceipt`. Paths may be strings or `{ path: string }`.
 *
 * Mirrors the inline base2 P1 helper so multi-file editor spawn batches that
 * only surface `agentReceipt.changedFiles` (without a file_mutation_result)
 * still contribute to the gate file set.
 */
export function collectAgentReceiptChangedFiles(
  record: Record<string, unknown>,
  out: Set<string>,
): void {
  const collectFromChangedFiles = (changedFiles: unknown): void => {
    if (!Array.isArray(changedFiles)) return
    for (const item of changedFiles) {
      if (typeof item === 'string' && item.trim()) {
        out.add(item)
        continue
      }
      if (item && typeof item === 'object') {
        const path = (item as Record<string, unknown>).path
        if (typeof path === 'string' && path.trim()) out.add(path)
      }
    }
  }
  const isAgentReceipt = (candidate: Record<string, unknown>): boolean =>
    candidate.schemaVersion === 1 &&
    typeof candidate.receiptId === 'string' &&
    Array.isArray(candidate.changedFiles)
  if (isAgentReceipt(record)) {
    collectFromChangedFiles(record.changedFiles)
  }
  if (
    record.agentReceipt &&
    typeof record.agentReceipt === 'object' &&
    !Array.isArray(record.agentReceipt)
  ) {
    const receipt = record.agentReceipt as Record<string, unknown>
    if (isAgentReceipt(receipt)) {
      collectFromChangedFiles(receipt.changedFiles)
    } else if (Array.isArray(receipt.changedFiles)) {
      // Runtime envelopes may omit schemaVersion on a nested receipt;
      // still adopt changedFiles when present.
      collectFromChangedFiles(receipt.changedFiles)
    }
  }
}

/**
 * Recursively visits any value (typically a tool-result or message-history
 * fragment) and adds every changed file path it finds to `out`.
 *
 * Recognized shapes:
 *   - file-changing tool calls with a structured `input`
 *   - canonical file_mutation_result actions whose outcome is `applied`
 *   - schemaVersion=1 agent receipts / nested `agentReceipt.changedFiles`
 *   - `type: 'json'` envelope parts where the inner `value` recurses
 * Legacy mutation-shaped fields are traversed but never counted.
 */
export function visitToolValue(value: unknown, out: Set<string>): void {
  if (!value) return
  if (Array.isArray(value)) {
    for (const item of value) visitToolValue(item, out)
    return
  }
  if (typeof value !== 'object') return

  const record = value as Record<string, unknown>
  if (record.type === 'json' && 'value' in record) {
    visitToolValue(record.value, out)
  }
  if (hasEditArtifact(record)) {
    for (const action of record.actions as Array<Record<string, unknown>>) {
      if (action.outcome !== 'applied') continue
      if (typeof action.path === 'string') out.add(action.path)
      if (
        action.action === 'move' &&
        typeof action.destinationPath === 'string'
      ) {
        out.add(action.destinationPath)
      }
    }
  }
  // P1: adopt agent receipt changedFiles (multi-file editor spawn batches
  // that only surface agentReceipt.changedFiles, without a file_mutation_result).
  collectAgentReceiptChangedFiles(record, out)
  for (const nested of Object.values(record)) {
    visitToolValue(nested, out)
  }
}
