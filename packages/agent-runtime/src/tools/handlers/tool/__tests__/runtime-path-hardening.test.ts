import { describe, expect, it } from 'bun:test'

import { handleEditTransaction } from '../edit-transaction'
import { handleReadFiles } from '../read-files'
import { handleReplaceRange } from '../replace-range'
import { handleRewriteSymbol } from '../rewrite-symbol'
import { handleStrReplace } from '../str-replace'
import {
  getFileProcessingValues,
  handleWriteFile,
  normalizeToolPath,
} from '../write-file'
import { executeToolCall } from '../../../tool-executor'

import type { Logger } from '@codebuff/common/types/contracts/logger'

const logger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
}

const unsafePaths = [
  '',
  '.',
  './',
  '   ',
  '../secret.txt',
  'src/../../secret.txt',
  '..\\secret.txt',
  '/etc/passwd',
  'C:/Windows/System32/config',
  'C:\\Windows\\System32\\config',
  'C:Windows\\System32\\config',
  '\\\\server\\share\\secret.txt',
  '\\\\?\\C:\\secret.txt',
  'src/evil\0name.ts',
]

function expectUnsafePathError(result: { output: any[] }, inputPath: string) {
  expect(result.output[0]?.type).toBe('json')
  expect(result.output[0]?.value).toMatchObject({
    file: inputPath,
  })
  expect(String(result.output[0]?.value?.errorMessage)).toContain(
    'path traversal blocked',
  )
}

describe('runtime tool path hardening', () => {
  it('normalizes safe project-relative paths and rejects unsafe forms', () => {
    expect(normalizeToolPath('./src\\nested/./file.ts')).toBe(
      'src/nested/file.ts',
    )
    expect(normalizeToolPath('src//nested///file.ts')).toBe(
      'src/nested/file.ts',
    )

    for (const inputPath of unsafePaths) {
      expect(normalizeToolPath(inputPath)).toBe('')
    }
  })

  it('blocks write_file and str_replace before any file or client I/O', async () => {
    for (const inputPath of unsafePaths) {
      let ioCalls = 0
      const common = {
        previousToolCallFinished: Promise.resolve(),
        fileProcessingState: getFileProcessingValues({
          strictReadBeforeEdit: false,
        }),
        logger,
        requestOptionalFile: async () => {
          ioCalls += 1
          return 'secret'
        },
        requestClientToolCall: async () => {
          ioCalls += 1
          return []
        },
        writeToClient: () => undefined,
      }

      const writeResult = await handleWriteFile({
        ...common,
        toolCall: {
          toolCallId: 'unsafe-write',
          toolName: 'write_file',
          input: { path: inputPath, content: 'replacement' },
        },
      } as any)
      expectUnsafePathError(writeResult, inputPath)

      const replaceResult = await handleStrReplace({
        ...common,
        toolCall: {
          toolCallId: 'unsafe-replace',
          toolName: 'str_replace',
          input: {
            path: inputPath,
            replacements: [
              {
                oldString: 'secret',
                newString: 'replacement',
                allowMultiple: false,
              },
            ],
          },
        },
      } as any)
      expectUnsafePathError(replaceResult, inputPath)
      expect(ioCalls).toBe(0)
    }
  })

  it('blocks rewrite_symbol before requestOptionalFile', async () => {
    for (const inputPath of unsafePaths) {
      let ioCalls = 0
      const result = await handleRewriteSymbol({
        previousToolCallFinished: Promise.resolve(),
        toolCall: {
          toolCallId: 'unsafe-rewrite-symbol',
          toolName: 'rewrite_symbol',
          input: {
            path: inputPath,
            symbol: 'target',
            content: 'function target() {}',
          },
        },
        fileProcessingState: getFileProcessingValues({
          strictReadBeforeEdit: false,
        }),
        logger,
        requestOptionalFile: async () => {
          ioCalls += 1
          return 'function target() {}'
        },
        requestClientToolCall: async () => {
          ioCalls += 1
          return []
        },
        writeToClient: () => undefined,
      } as any)

      expectUnsafePathError(result, inputPath)
      expect(ioCalls).toBe(0)
    }
  })

  it('blocks replace_range and edit_transaction before client or file I/O', async () => {
    for (const inputPath of unsafePaths) {
      let ioCalls = 0
      const fileProcessingState = getFileProcessingValues({
        strictReadBeforeEdit: false,
      })
      const requestClientToolCall = async () => {
        ioCalls += 1
        return []
      }

      const rangeResult = await handleReplaceRange({
        previousToolCallFinished: Promise.resolve(),
        toolCall: {
          toolCallId: 'unsafe-range',
          toolName: 'replace_range',
          input: {
            path: inputPath,
            startLine: 1,
            endLine: 1,
            newContent: 'replacement',
          },
        },
        fileProcessingState,
        requestClientToolCall,
      } as any)
      expectUnsafePathError(rangeResult, inputPath)

      const transactionResult = await handleEditTransaction({
        previousToolCallFinished: Promise.resolve(),
        toolCall: {
          toolCallId: 'unsafe-transaction',
          toolName: 'edit_transaction',
          input: {
            edits: [
              {
                type: 'str_replace',
                path: inputPath,
                replacements: [
                  {
                    oldString: 'secret',
                    newString: 'replacement',
                    allowMultiple: false,
                  },
                ],
              },
            ],
          },
        },
        fileProcessingState,
        logger,
        requestOptionalFile: async () => {
          ioCalls += 1
          return 'secret'
        },
        requestClientToolCall,
      } as any)
      expect(transactionResult.output[0]?.value).toMatchObject({
        failures: [{ editIndex: 0, path: inputPath }],
      })
      const transactionValue = transactionResult.output[0]?.value as {
        errorMessage?: string
      }
      expect(String(transactionValue.errorMessage)).toContain(
        'path traversal blocked',
      )
      expect(ioCalls).toBe(0)
    }
  })

  it('blocks a mixed read_files request rather than forwarding an empty path', async () => {
    for (const inputPath of unsafePaths) {
      let ioCalls = 0
      const result = await handleReadFiles({
        previousToolCallFinished: Promise.resolve(),
        toolCall: {
          toolCallId: 'unsafe-read',
          toolName: 'read_files',
          input: {
            paths: ['src/safe.ts'],
            ranges: [{ path: inputPath, startLine: 1, endLine: 1 }],
          },
        },
        fileContext: { tokenCallers: {} },
        fileProcessingState: getFileProcessingValues({}),
        requestFiles: async () => {
          ioCalls += 1
          return {}
        },
        requestOptionalFile: async () => {
          ioCalls += 1
          return null
        },
      } as any)

      expect(result.output[0]?.type).toBe('json')
      const readValue = result.output[0]?.value as {
        status: string
        results: Array<{
          path: string
          status: string
          error?: { message?: string }
        }>
      }
      expect(readValue.status).toBe('error')
      expect(readValue.results[1]?.path).toBe(inputPath)
      expect(readValue.results[1]?.error?.message).toContain(
        'path traversal blocked',
      )
      expect(ioCalls).toBe(0)
    }
  })
})

describe('removed tool names on the programmatic path', () => {
  it('returns documented removed-tool guidance instead of dereferencing absent tool params', async () => {
    const chunks: Array<Record<string, unknown>> = []

    // An external custom agent that still declares the removed name and yields
    // it from handleSteps. That path skips the model-facing availability filter,
    // so the guard must run before the tool input is parsed.
    await executeToolCall({
      toolName: 'apply_patch',
      input: { operation: { path: 'src/a.ts', diff: 'patch body' } },
      fromHandleSteps: true,
      agentState: { agentId: 'agent-1' },
      agentTemplate: {
        id: 'external-custom-agent',
        toolNames: ['apply_patch', 'edit_transaction'],
        programmaticToolNames: ['apply_patch'],
      },
      logger,
      previousToolCallFinished: Promise.resolve(),
      signal: new AbortController().signal,
      toolCalls: [],
      toolCallsToAddToMessageHistory: [],
      toolResults: [],
      toolResultsToAddToMessageHistory: [],
      onResponseChunk: (chunk: unknown) => {
        chunks.push(chunk as Record<string, unknown>)
      },
    } as any)

    expect(chunks).toHaveLength(1)
    expect(chunks[0]?.type).toBe('error')
    const message = String(chunks[0]?.message)
    expect(message).toContain('`apply_patch` was removed')
    expect(message).toContain('use `edit_transaction` instead')
    expect(message).toContain('Persisted history entries')
  })
})
