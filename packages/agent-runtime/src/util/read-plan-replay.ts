import type { JournalEventRow } from '@codebuff/common/types/contracts/agent-runtime'
import { readFilesResultV1Schema } from '@codebuff/common/tools/results/filesystem'
import type { ToolResultOutput } from '@codebuff/common/types/messages/content-part'
import { captureValueSha256, type ReplayBasis } from './recorded-replay-prefix'

export const READ_PLAN_TEMPLATE_ID = 'openbuff-replayable-reads-v1'
export const MAX_READ_PLAN_REPLAY_ROWS = 96
export const MAX_READ_PLAN_REPLAY_BYTES = 2 * 1024 * 1024

export type ReadPlanOrigin = {
  version: 1
  basis: ReplayBasis
  ownerPid: number
  agentId: string
  userInputId: string
}

export type VerifiedReadPlanPrefix = {
  origin: ReadPlanOrigin
  results: ToolResultOutput[][]
}

const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)
const identifier = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 256

/** Verify only the serial built-in recipe, against the entire retained run. */
export function verifyReadPlanPrefix(
  rows: JournalEventRow[],
  basis: ReplayBasis,
  batches: readonly (readonly string[])[],
): VerifiedReadPlanPrefix {
  const first = rows[0]
  const header = first?.payload
  if (
    first?.eventType !== 'read_plan_basis' ||
    !record(header) ||
    header.version !== 1 ||
    !identifier(header.agentId) ||
    !identifier(header.userInputId) ||
    typeof header.ownerPid !== 'number' ||
    !Number.isSafeInteger(header.ownerPid) ||
    header.ownerPid < 1 ||
    rows.length > MAX_READ_PLAN_REPLAY_ROWS ||
    rows.some((row, index) => row.seq !== index)
  ) {
    throw new Error(
      'The original read-plan journal is missing a complete, contiguous prefix.',
    )
  }
  if (captureValueSha256(header.basis) !== captureValueSha256(basis)) {
    throw new Error('The read plan, runtime identity, or workspace changed.')
  }
  const origin: ReadPlanOrigin = {
    version: 1,
    basis,
    ownerPid: header.ownerPid,
    agentId: header.agentId,
    userInputId: header.userInputId,
  }
  const results: ToolResultOutput[][] = []
  const seenAttempts = new Set<string>()
  const seenCalls = new Set<string>()
  let pending:
    | { callId: string; attemptId: string; basisSha256: string }
    | undefined
  let lastBoundary = 0
  for (const row of rows.slice(1)) {
    const payload = row.payload
    if (
      row.eventType === 'step_boundary' &&
      !pending &&
      row.stepNumber === results.length &&
      row.stepNumber > lastBoundary &&
      record(payload) &&
      payload.terminal === false &&
      payload.status === 'completed' &&
      Array.isArray(payload.childRunIds) &&
      payload.childRunIds.length === 0
    ) {
      lastBoundary = row.stepNumber
      continue
    }
    if (
      row.eventType === 'tool_call' &&
      !pending &&
      row.stepNumber === results.length + 1 &&
      results.length < batches.length &&
      record(payload) &&
      record(payload.basis) &&
      payload.toolName === 'read_files' &&
      identifier(row.correlation) &&
      identifier(payload.attemptId) &&
      !seenAttempts.has(payload.attemptId) &&
      !seenCalls.has(row.correlation) &&
      captureValueSha256(payload.input) ===
        captureValueSha256({ paths: batches[results.length] })
    ) {
      pending = {
        callId: row.correlation,
        attemptId: payload.attemptId,
        basisSha256: captureValueSha256(payload.basis),
      }
      seenAttempts.add(pending.attemptId)
      seenCalls.add(pending.callId)
      continue
    }
    if (
      row.eventType === 'tool_result' &&
      pending &&
      row.correlation === pending.callId &&
      row.stepNumber === results.length + 1 &&
      record(payload) &&
      payload.attemptId === pending.attemptId &&
      payload.toolName === 'read_files' &&
      payload.outcome === 'succeeded' &&
      captureValueSha256(payload.basis) === pending.basisSha256
    ) {
      const output = payload.result
      const part =
        Array.isArray(output) && output.length === 1 ? output[0] : undefined
      const parsed = readFilesResultV1Schema.safeParse(
        part?.type === 'json' ? part.value : undefined,
      )
      if (
        !parsed.success ||
        parsed.data.status !== 'ok' ||
        captureValueSha256(parsed.data.results.map((item) => item.path)) !==
          captureValueSha256(batches[results.length])
      ) {
        throw new Error(
          'A retained read is not a complete result for the selected batch.',
        )
      }
      results.push([{ type: 'json', value: parsed.data }])
      pending = undefined
      continue
    }
    throw new Error(
      'The retained journal includes an unexpected, failed, or terminal action.',
    )
  }
  if (pending)
    throw new Error('The previous read attempt has no confirmed result.')
  if (results.length === 0 || results.length >= batches.length) {
    throw new Error(
      'Live re-entry requires at least one confirmed read and one remaining batch.',
    )
  }
  return { origin, results }
}
