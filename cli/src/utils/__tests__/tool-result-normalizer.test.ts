import { describe, expect, test } from 'bun:test'
import { buildFileMutationResultFromReceiptV1 } from '@codebuff/common/tools/results/filesystem'
import type { CommitReceiptV1 } from '@codebuff/common/tools/results/filesystem'
import type { ToolContentBlock } from '../../types/chat'
import { computeCompletionSummary } from '../completion-summary'
import { outcomeForTool } from '../output-outcome'

import {
  getStructuredErrorMessages,
  getToolOutputValues,
  getCanonicalMutationResult,
  hasMultipartError,
  isTerminalToolBlock,
  TERMINAL_TOOL_LIFECYCLES,
  getConfirmedMutationActions,
} from '../tool-result-normalizer'

/**
 * First failing-mode / malformed-shape coverage for tool-result-normalizer
 * (shard-cli-tui test-coverage finding: no test file referenced this module).
 * The nested-`error` payload case below is also the false-positive regression
 * the envelope-only scan fix exists for: result DATA carrying its own `error`
 * field must not flip a successful tool to lifecycle 'failed'.
 */

describe('getStructuredErrorMessages / hasMultipartError', () => {
  test('detects a string `error` on an envelope record', () => {
    const output = [{ error: 'permission denied for /etc/passwd' }]

    expect(getStructuredErrorMessages(output)).toEqual([
      'permission denied for /etc/passwd',
    ])
    expect(hasMultipartError(output)).toBe(true)
  })

  test('detects an `error` object with a message and an errorMessage field', () => {
    expect(
      getStructuredErrorMessages([{ error: { message: 'index is empty' } }]),
    ).toEqual(['index is empty'])
    expect(
      getStructuredErrorMessages([{ errorMessage: 'provider timeout' }]),
    ).toEqual(['provider timeout'])
    expect(hasMultipartError([{ errorMessage: 'provider timeout' }])).toBe(true)
  })

  test('malformed / partial shapes never throw or invent errors', () => {
    expect(getStructuredErrorMessages(undefined)).toEqual([])
    expect(getStructuredErrorMessages(null)).toEqual([])
    expect(getStructuredErrorMessages('raw string output')).toEqual([])
    expect(getStructuredErrorMessages(42)).toEqual([])
    expect(getStructuredErrorMessages([undefined, null, 'text'])).toEqual([])
    expect(getStructuredErrorMessages([{ error: null }, { error: 5 }])).toEqual(
      [],
    )
    expect(getStructuredErrorMessages([{ error: { message: '' } }])).toEqual([])
    expect(hasMultipartError({})).toBe(false)
    expect(hasMultipartError([{ error: { message: 17 } }])).toBe(false)
  })

  test('nested payload DATA error fields are NOT failures (false-positive regression)', () => {
    const output = [
      {
        kind: 'file_scan_result',
        value: {
          files: [
            {
              path: 'config.json',
              error: 'schema mismatch inside scanned file',
            },
          ],
          note: { errorMessage: 'nested note payload' },
        },
      },
    ]

    expect(getStructuredErrorMessages(output)).toEqual([])
    expect(hasMultipartError(output)).toBe(false)
  })
})

describe('[B03] confirmed mutation projection', () => {
  const receipt: CommitReceiptV1 = {
    kind: 'commit_receipt',
    version: 1,
    receiptId: 'receipt-b03',
    operationId: 'operation-b03',
    callId: 'call-b03',
    authorityTier: 'conditional_commit',
    status: 'committed',
    actions: [
      {
        actionId: 'action-b03',
        index: 0,
        action: 'update',
        path: 'a.txt',
        status: 'committed',
        beforeHash: 'before',
        afterHash: 'after',
      },
    ],
    finalHashes: { 'a.txt': 'after' },
  }
  const block = (outputRaw: unknown): ToolContentBlock =>
    ({
      type: 'tool',
      toolCallId: 'call-b03',
      toolName: 'edit_transaction',
      input: {},
      outputRaw,
      lifecycle: 'succeeded',
    }) as ToolContentBlock

  test('confirms a valid committed receipt and refuses a missing authority receipt', () => {
    const mutation = buildFileMutationResultFromReceiptV1(receipt)
    expect(
      getConfirmedMutationActions(block([{ type: 'json', value: mutation }])),
    ).toHaveLength(1)
    expect(
      getConfirmedMutationActions(
        block({ ...mutation, authorityReceipt: undefined }),
      ),
    ).toEqual([])
  })

  test('does not promote historical rollback_failed into an applied edit', () => {
    const mutation = buildFileMutationResultFromReceiptV1({
      ...receipt,
      status: 'rollback_incomplete',
      actions: receipt.actions.map((action) => ({
        ...action,
        status: 'rollback_failed',
      })),
    })
    const historical = {
      ...mutation,
      actions: mutation.actions.map((action) => ({
        ...action,
        outcome: 'applied',
      })),
    }
    expect(getConfirmedMutationActions(block(historical))).toEqual([])
    expect(getCanonicalMutationResult(historical)?.actions).toHaveLength(1)
    expect(computeCompletionSummary([block(historical)])?.filesEdited).toBe(0)
  })

  test('CLI summary and status preserve refused and uncertain actions', () => {
    const refused = buildFileMutationResultFromReceiptV1({
      ...receipt,
      status: 'failed',
      actions: receipt.actions.map((action) => ({
        ...action,
        status: 'failed',
        forward: {
          outcome: 'not_applied',
          afterHashes: { 'a.txt': 'foreign' },
        },
        afterHash: 'foreign',
      })),
      finalHashes: { 'a.txt': 'foreign' },
    })
    const uncertain = buildFileMutationResultFromReceiptV1({
      ...receipt,
      status: 'rollback_incomplete',
      actions: receipt.actions.map((action) => ({
        ...action,
        status: 'rollback_failed',
        forward: {
          outcome: 'unconfirmed',
          afterHashes: { 'a.txt': 'partial' },
        },
        afterHash: 'partial',
      })),
      finalHashes: { 'a.txt': 'partial' },
    })
    expect(computeCompletionSummary([block(refused)])?.filesEdited).toBe(0)
    expect(
      computeCompletionSummary([block(uncertain)])?.rollbackIncomplete,
    ).toBe(1)
    expect(outcomeForTool(block(refused)).label).toBe('not applied')
    expect(outcomeForTool(block(uncertain)).label).toBe('rollback incomplete')
    expect(getCanonicalMutationResult(uncertain)?.actions).toHaveLength(1)
  })
})

describe('getToolOutputValues', () => {
  test('unwraps typed JSON parts and skips undefined parts', () => {
    expect(
      getToolOutputValues([{ type: 'json', value: 'a' }, undefined, 'b']),
    ).toEqual(['a', 'b'])
  })
  test('retains data records with their own value field', () => {
    const record = { kind: 'measurement', value: 42, unit: 'ms' }
    expect(getToolOutputValues(record)).toEqual([record])
  })
})

describe('getCanonicalMutationResult', () => {
  test('locates the canonical file_mutation_result by kind', () => {
    const output = [
      {
        kind: 'file_mutation_result',
        actions: [{ path: 'src/a.ts', outcome: 'applied' }],
      },
    ]
    const result = getCanonicalMutationResult(output)

    expect(result).not.toBeNull()
    expect(Array.isArray(result?.actions)).toBe(true)
  })

  test('a missing or malformed canonical mutation result yields null', () => {
    expect(getCanonicalMutationResult([{ kind: 'read_result' }])).toBeNull()
    expect(getCanonicalMutationResult(undefined)).toBeNull()
    expect(getCanonicalMutationResult([{ kind: null }])).toBeNull()
  })
})

describe('isTerminalToolBlock', () => {
  test('every declared terminal lifecycle is recognized', () => {
    for (const lifecycle of TERMINAL_TOOL_LIFECYCLES) {
      expect(
        isTerminalToolBlock({
          type: 'tool',
          toolCallId: 'call-1',
          toolName: 'read_files',
          input: {},
          lifecycle: lifecycle as never,
        } as never),
      ).toBe(true)
    }
  })

  test('running / queued blocks are not terminal', () => {
    expect(
      isTerminalToolBlock({ type: 'tool', lifecycle: 'running' } as never),
    ).toBe(false)
    expect(
      isTerminalToolBlock({ type: 'tool', lifecycle: 'queued' } as never),
    ).toBe(false)
  })
})
