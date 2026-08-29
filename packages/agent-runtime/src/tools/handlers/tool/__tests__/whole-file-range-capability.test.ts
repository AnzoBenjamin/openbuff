import {
  encodeReadCapabilityToken,
  getContentHash,
} from '@codebuff/common/util/content-hash'
import { describe, expect, it } from 'bun:test'

import { handleEditTransaction } from '../edit-transaction'
import { getFileProcessingValues, handleWriteFile } from '../write-file'

import type { Logger } from '@codebuff/common/types/contracts/logger'

const logger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
}

const projectId = '/test'
const runId = 'whole-file-range-capability-run'
const fileContext = { projectRoot: projectId }
const path = 'src/two-lines.ts'
// Newline-terminated: visibleLineCount 2, maxCapabilityLine 3.
const diskContent = 'a\nb\n'
const newContent = 'A\nB\n'

function capability(params: {
  startLine: number
  endLine: number
  hashedContent: string
}): string {
  return encodeReadCapabilityToken({
    startLine: params.startLine,
    endLine: params.endLine,
    hash: getContentHash(params.hashedContent),
    scope: { projectId, path, runId },
  })
}

/**
 * What read_files mints for a complete FULL-FILE RANGE read: visible-space
 * bounds hashed over the slice without the trailing newline.
 */
const fullFileRangeCapability = capability({
  startLine: 1,
  endLine: 2,
  hashedContent: 'a\nb',
})

async function runWriteFile(basedOnRead: string): Promise<{
  applied: boolean
  errorMessage: string
}> {
  let applied = false
  const result = await handleWriteFile({
    previousToolCallFinished: Promise.resolve(),
    toolCall: {
      toolCallId: 'write-file-whole-file-range',
      toolName: 'write_file',
      input: { path, content: newContent, basedOnRead },
    },
    agentState: { messageHistory: [] },
    clientSessionId: 'test-session',
    fileContext,
    runId,
    fileProcessingState: getFileProcessingValues({
      strictReadBeforeEdit: true,
    }),
    fingerprintId: 'test-fingerprint',
    logger,
    prompt: undefined,
    userId: undefined,
    userInputId: 'test-input',
    requestOptionalFile: async () => diskContent,
    requestClientToolCall: async () => {
      applied = true
      return []
    },
    writeToClient: () => {},
  } as any)

  const output = result.output[0]
  return {
    applied,
    errorMessage:
      output?.type === 'json'
        ? String((output.value as { errorMessage?: string }).errorMessage)
        : '',
  }
}

async function runEditTransactionWriteFile(basedOnRead: string): Promise<{
  applied: boolean
  errorMessage: string
  failureMessages: string
}> {
  let applied = false
  const result = await handleEditTransaction({
    previousToolCallFinished: Promise.resolve(),
    toolCall: {
      toolCallId: 'edit-transaction-whole-file-range',
      toolName: 'edit_transaction',
      input: {
        edits: [{ type: 'write_file', path, content: newContent, basedOnRead }],
      },
    },
    fileContext,
    runId,
    fileProcessingState: getFileProcessingValues({
      strictReadBeforeEdit: true,
    }),
    logger,
    requestOptionalFile: async () => diskContent,
    requestClientToolCall: async () => {
      applied = true
      return []
    },
    writeToClient: () => {},
  } as any)

  const output = result.output[0]
  const value =
    output?.type === 'json'
      ? (output.value as {
          errorMessage?: string
          failures?: { errorMessage?: string }[]
        })
      : undefined
  return {
    applied,
    errorMessage: value ? String(value.errorMessage) : '',
    // handleEditTransaction reports per-edit causes in failures[] and only a
    // generic summary in the top-level errorMessage.
    failureMessages: (value?.failures ?? [])
      .map((failure) => String(failure.errorMessage))
      .join('\n'),
  }
}

describe('write_file basedOnRead whole-file coverage', () => {
  it('accepts a full-file range capability for a newline-terminated file', async () => {
    const { applied, errorMessage } = await runWriteFile(
      fullFileRangeCapability,
    )

    expect(applied).toBe(true)
    expect(errorMessage).not.toContain(
      'a range capability cannot authorize a whole-file overwrite',
    )
    expect(errorMessage).not.toContain('stale hash')
  })

  it('still rejects a proper-subset range capability', async () => {
    const { applied, errorMessage } = await runWriteFile(
      capability({ startLine: 1, endLine: 1, hashedContent: 'a' }),
    )

    expect(applied).toBe(false)
    expect(errorMessage).toContain(
      'a range capability cannot authorize a whole-file overwrite',
    )
    expect(errorMessage).toContain('the file has 2 visible line(s)')
    expect(errorMessage).toContain(`read_files with paths: ["${path}"]`)
  })

  it('still rejects a whole-file-covering capability whose hash is stale', async () => {
    const { applied, errorMessage } = await runWriteFile(
      capability({ startLine: 1, endLine: 2, hashedContent: 'x\ny' }),
    )

    expect(applied).toBe(false)
    expect(errorMessage).toContain(
      'basedOnRead did not match the current file content (stale hash)',
    )
  })
})

describe('edit_transaction write_file basedOnRead whole-file coverage', () => {
  it('accepts a full-file range capability for a newline-terminated file', async () => {
    const { applied, errorMessage, failureMessages } =
      await runEditTransactionWriteFile(fullFileRangeCapability)

    expect(applied).toBe(true)
    expect(failureMessages).toBe('')
    expect(errorMessage).not.toContain(
      'a range capability cannot authorize a whole-file overwrite',
    )
  })

  it('still rejects a proper-subset range capability', async () => {
    const { applied, failureMessages } = await runEditTransactionWriteFile(
      capability({ startLine: 1, endLine: 1, hashedContent: 'a' }),
    )

    expect(applied).toBe(false)
    expect(failureMessages).toContain(
      `a range capability cannot authorize a whole-file overwrite for ${path}`,
    )
    expect(failureMessages).toContain('the file has 2 visible line(s)')
  })
})
