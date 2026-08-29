import { editTransactionParams } from '@codebuff/common/tools/params/tool/edit-transaction'
import { decodeReadCapabilityToken } from '@codebuff/common/util/content-hash'
import { describe, expect, it } from 'bun:test'

import { handleEditTransaction } from '../tools/handlers/tool/edit-transaction'
import { handleReadFiles } from '../tools/handlers/tool/read-files'
import { handleReplaceRange } from '../tools/handlers/tool/replace-range'
import { handleStrReplace } from '../tools/handlers/tool/str-replace'
import {
  handleWriteFile,
  hasWholeFileReadAuthorization,
} from '../tools/handlers/tool/write-file'
import {
  encodeReadCapabilityToken,
  getContentHash,
} from '../process-str-replace'
import { remintConfirmedPostEditAnchors } from '../util/read-authorization'
import {
  buildWholeFileReadResultV1,
  confirmedMutationOutput,
  createFileProcessingState,
  defaultTestHandlerAuthority,
  logger,
  mockFileContext,
} from './read-files-edit-state-fixtures'

describe('read_files edit-state recovery', () => {
  it('blocks a capability-bearing edit when the authoritative scope is empty', async () => {
    const path = 'src/scoped.ts'
    const diskContent = 'export const value = 1\n'
    const fileProcessingState = createFileProcessingState()
    let ioCalls = 0

    const result = await handleEditTransaction({
      previousToolCallFinished: Promise.resolve(),
      toolCall: {
        toolCallId: 'empty-scope-transaction',
        toolName: 'edit_transaction',
        input: {
          edits: [
            {
              type: 'str_replace' as const,
              path,
              replacements: [
                {
                  oldString: 'export const value = 1',
                  newString: 'export const value = 2',
                  basedOnRead: 'cap.v3.test-scope-token',
                },
              ],
            },
          ],
        },
      },
      // No fileContext/runId: projectId and runId both resolve to ''.
      fileProcessingState,
      logger,
      requestOptionalFile: async ({ filePath }: { filePath: string }) => {
        ioCalls += 1
        return filePath === path ? diskContent : null
      },
      requestClientToolCall: async () => {
        ioCalls += 1
        return []
      },
    } as any)

    expect(result.output[0]?.type).toBe('json')
    if (result.output[0]?.type === 'json') {
      const value = result.output[0].value as {
        errorMessage?: string
        failures?: Array<{
          editIndex: number
          path: string
          errorMessage: string
        }>
      }
      expect(value.errorMessage).toContain(
        'capability-bearing edits require a nonempty authoritative projectId and runId',
      )
      // Only the capability-bearing edit is reported, at its own index.
      expect(value.failures).toEqual([
        {
          editIndex: 0,
          path,
          errorMessage: expect.stringContaining(
            'Authenticated capability scope is unavailable',
          ),
        },
      ])
    }
    // The strict-gate failure must not reach the client apply path.
    expect(ioCalls).toBe(0)
  })

  it('blocks a rewrite_symbol edit when the authoritative scope is empty', async () => {
    const path = 'src/scoped-symbol.ts'
    const fileProcessingState = createFileProcessingState()
    let ioCalls = 0

    const result = await handleEditTransaction({
      previousToolCallFinished: Promise.resolve(),
      toolCall: {
        toolCallId: 'empty-scope-rewrite-symbol',
        toolName: 'edit_transaction',
        input: {
          edits: [
            {
              type: 'rewrite_symbol' as const,
              path,
              symbol: 'value',
              newContent: 'export const value = 2',
              readCapability: 'cap.v3.test-symbol-token',
            },
          ],
        },
      },
      // No fileContext/runId: projectId and runId both resolve to ''.
      fileProcessingState,
      logger,
      requestOptionalFile: async () => {
        ioCalls += 1
        return null
      },
      requestClientToolCall: async () => {
        ioCalls += 1
        return []
      },
    } as any)

    expect(result.output[0]?.type).toBe('json')
    if (result.output[0]?.type === 'json') {
      const value = result.output[0].value as {
        errorMessage?: string
        failures?: Array<{ editIndex: number; path: string }>
      }
      expect(value.errorMessage).toContain(
        'capability-bearing edits require a nonempty authoritative projectId and runId',
      )
      expect(value.failures).toEqual([
        expect.objectContaining({ editIndex: 0, path }),
      ])
    }
    // The strict-gate failure must not reach the client apply path.
    expect(ioCalls).toBe(0)
  })

  it('blocks only the capability-bearing edit indexes when scope is empty', async () => {
    const plainPath = 'src/plain.ts'
    const scopedPath = 'src/scoped.ts'
    const diskContent = 'export const value = 1\n'
    const fileProcessingState = createFileProcessingState()

    const result = await handleEditTransaction({
      previousToolCallFinished: Promise.resolve(),
      toolCall: {
        toolCallId: 'mixed-scope-transaction',
        toolName: 'edit_transaction',
        input: {
          edits: [
            {
              type: 'str_replace' as const,
              path: plainPath,
              replacements: [
                {
                  oldString: 'export const value = 1',
                  newString: 'export const value = 2',
                },
              ],
            },
            {
              type: 'replace_range' as const,
              path: scopedPath,
              startLine: 1,
              endLine: 1,
              newContent: 'export const value = 2',
              readCapability: 'cap.v3.test-range-token',
            },
          ],
        },
      },
      // No fileContext/runId: projectId and runId both resolve to ''.
      fileProcessingState,
      logger,
      requestOptionalFile: async () => diskContent,
      requestClientToolCall: async () => [],
    } as any)

    expect(result.output[0]?.type).toBe('json')
    if (result.output[0]?.type === 'json') {
      const value = result.output[0].value as {
        errorMessage?: string
        failures?: Array<{ editIndex: number; path: string }>
      }
      expect(value.errorMessage).toContain(
        'capability-bearing edits require a nonempty authoritative projectId and runId',
      )
      // The non-capability edit at index 0 must not appear in failures.
      expect(value.failures).toEqual([
        expect.objectContaining({ editIndex: 1, path: scopedPath }),
      ])
    }
  })

  it('does not block capability-free edits when the authoritative scope is empty', async () => {
    const path = 'src/no-capability.ts'
    const diskContent = 'export const value = 1\n'
    const fileProcessingState = createFileProcessingState()
    let clientCalls = 0

    const result = await handleEditTransaction({
      previousToolCallFinished: Promise.resolve(),
      toolCall: {
        toolCallId: 'non-capability-transaction',
        toolName: 'edit_transaction',
        input: {
          edits: [
            {
              type: 'str_replace' as const,
              path,
              replacements: [
                {
                  oldString: 'export const value = 1',
                  newString: 'export const value = 2',
                },
              ],
            },
          ],
        },
      },
      // No fileContext/runId: empty scope must not gate capability-free edits.
      fileProcessingState,
      logger,
      requestOptionalFile: async ({ filePath }: { filePath: string }) =>
        filePath === path ? diskContent : null,
      requestClientToolCall: async () => {
        clientCalls += 1
        return [
          {
            type: 'json' as const,
            value: { message: 'applied transaction batch', files: [] },
          },
        ]
      },
    } as any)

    expect(clientCalls).toBe(1)
    expect(result.output[0]?.type).toBe('json')
    if (result.output[0]?.type === 'json') {
      const value = result.output[0].value as { errorMessage?: string }
      expect(value.errorMessage ?? '').not.toContain(
        'capability-bearing edits require a nonempty authoritative projectId and runId',
      )
    }
  })

  describe('strict read-before-edit (Milestone 2 staged)', () => {
    it('exposes a whole-file readCapability that directly authorizes the next strict edit', async () => {
      const path = 'client/src/routes/dashboard.ip.tsx'
      const diskContent = 'export const value = 1\n'
      const runId = 'strict-capability-run'
      const fileProcessingState = createFileProcessingState()
      fileProcessingState.strictReadBeforeEdit = true

      const readResult = await handleReadFiles({
        ...defaultTestHandlerAuthority,
        previousToolCallFinished: Promise.resolve(),
        toolCall: {
          toolCallId: 'strict-capability-read',
          toolName: 'read_files',
          input: { paths: [path] },
        },
        fileContext: mockFileContext,
        fileProcessingState,
        requestFiles: async () =>
          buildWholeFileReadResultV1([path], () => diskContent),
        logger,
        runId,
      } as any)
      const readOutput = readResult.output[0]
      expect(readOutput.type).toBe('json')
      if (readOutput.type !== 'json') return
      const readCapability = (readOutput.value as any).results[0].editAnchor
        .readCapability as string
      expect(readCapability).toMatch(/^cap\.v3\./)

      // Prove that the visible capability is independently sufficient rather
      // than accidentally relying on the handler's hidden per-path state.
      delete fileProcessingState.readAuthorizationsByPath?.[path]
      delete fileProcessingState.readAuthorizationHashesByPath?.[path]
      let applied = false
      const editResult = await handleStrReplace({
        ...defaultTestHandlerAuthority,
        previousToolCallFinished: Promise.resolve(),
        toolCall: {
          toolCallId: 'strict-capability-edit',
          toolName: 'str_replace',
          input: {
            path,
            replacements: [
              {
                oldString: 'export const value = 1',
                newString: 'export const value = 2',
                allowMultiple: false,
                basedOnRead: readCapability,
              },
            ],
          },
        },
        fileProcessingState,
        fileContext: mockFileContext,
        runId,
        logger,
        requestOptionalFile: async () => diskContent,
        requestClientToolCall: async (toolCall: any) => {
          applied = true
          return confirmedMutationOutput(
            toolCall,
            { [path]: 'export const value = 2\n' },
            { projectId: mockFileContext.projectRoot, runId },
          )
        },
        writeToClient: () => {},
      } as any)

      expect(applied).toBe(true)
      expect(editResult.output[0]?.type).toBe('json')
      if (editResult.output[0]?.type === 'json') {
        expect(editResult.output[0].value).not.toHaveProperty('errorMessage')
      }
    })

    it('allows a fresh scoped capability to recover and refreshes whole-file auth after the confirmed edit', async () => {
      const path = 'src/scoped-recovery.ts'
      const readContent = 'export const value = 1\n'
      const diskContent = 'export const value = 2\n'
      const currentLine = 'export const value = 2'
      const runId = 'scoped-recovery-run'
      const fileProcessingState = createFileProcessingState()
      fileProcessingState.strictReadBeforeEdit = true
      fileProcessingState.readAuthorizationsByPath = { [path]: true }
      fileProcessingState.readAuthorizationHashesByPath = {
        [path]: getContentHash(readContent),
      }
      let applied = false

      const result = await handleStrReplace({
        ...defaultTestHandlerAuthority,
        previousToolCallFinished: Promise.resolve(),
        toolCall: {
          toolCallId: 'stale-auth-scoped-recovery',
          toolName: 'str_replace',
          input: {
            path,
            replacements: [
              {
                oldString: currentLine,
                newString: 'export const value = 3',
                allowMultiple: false,
                basedOnRead: encodeReadCapabilityToken({
                  startLine: 1,
                  endLine: 1,
                  hash: getContentHash(currentLine),
                  scope: {
                    projectId: mockFileContext.projectRoot,
                    path,
                    runId,
                  },
                }),
              },
            ],
          },
        },
        fileProcessingState,
        fileContext: mockFileContext,
        runId,
        logger,
        requestOptionalFile: async () => diskContent,
        requestClientToolCall: async (toolCall: any) => {
          applied = true
          return confirmedMutationOutput(
            toolCall,
            { [path]: 'export const value = 3\n' },
            { projectId: mockFileContext.projectRoot, runId },
          )
        },
        writeToClient: () => {},
      } as any)

      expect(applied).toBe(true)
      expect(result.output[0]?.type).toBe('json')
      if (result.output[0]?.type === 'json') {
        expect(result.output[0].value).not.toHaveProperty('errorMessage')
      }
      expect(fileProcessingState.readAuthorizationsByPath?.[path]).toBe(true)
      expect(fileProcessingState.readAuthorizationHashesByPath?.[path]).toBe(
        getContentHash('export const value = 3\n'),
      )
    })

    it('strict write_file with valid whole-file basedOnRead applies overwrite without prior sticky', async () => {
      const path = 'src/basedonread-write.ts'
      const diskContent = 'export const value = 1\n'
      const runId = 'write-whole-file-cap-run'
      const fileProcessingState = createFileProcessingState()
      fileProcessingState.strictReadBeforeEdit = true
      const basedOnRead = encodeReadCapabilityToken({
        startLine: 1,
        endLine: diskContent.split('\n').length,
        hash: getContentHash(diskContent),
        scope: {
          projectId: mockFileContext.projectRoot,
          path,
          runId,
        },
      })

      let applied = false
      const result = await handleWriteFile({
        ...defaultTestHandlerAuthority,
        previousToolCallFinished: Promise.resolve(),
        toolCall: {
          toolCallId: 'write-with-whole-file-cap',
          toolName: 'write_file',
          input: {
            path,
            content: 'export const value = 2\n',
            basedOnRead,
          },
        },
        agentState: { messageHistory: [] },
        clientSessionId: 'test-session',
        fileContext: mockFileContext,
        runId,
        fileProcessingState,
        fingerprintId: 'test-fingerprint',
        logger,
        prompt: undefined,
        userId: undefined,
        userInputId: 'test-input',
        requestOptionalFile: async () => diskContent,
        requestClientToolCall: async (toolCall: any) => {
          applied = true
          return confirmedMutationOutput(
            toolCall,
            { [path]: 'export const value = 2\n' },
            { projectId: mockFileContext.projectRoot, runId },
          )
        },
        writeToClient: () => {},
      } as any)

      expect(applied).toBe(true)
      expect(result.output[0]?.type).toBe('json')
      if (result.output[0]?.type === 'json') {
        expect(result.output[0].value).not.toHaveProperty('errorMessage')
      }
      expect(fileProcessingState.readAuthorizationsByPath?.[path]).toBe(true)
    })

    it('strict write_file rejects stale-hash basedOnRead', async () => {
      const path = 'src/stale-hash-write.ts'
      const diskContent = 'export const value = 1\n'
      const runId = 'write-stale-hash-run'
      const fileProcessingState = createFileProcessingState()
      fileProcessingState.strictReadBeforeEdit = true
      const basedOnRead = encodeReadCapabilityToken({
        startLine: 1,
        endLine: diskContent.split('\n').length,
        hash: getContentHash('export const value = 0\n'),
        scope: {
          projectId: mockFileContext.projectRoot,
          path,
          runId,
        },
      })

      let applied = false
      const result = await handleWriteFile({
        ...defaultTestHandlerAuthority,
        previousToolCallFinished: Promise.resolve(),
        toolCall: {
          toolCallId: 'write-stale-hash-cap',
          toolName: 'write_file',
          input: {
            path,
            content: 'export const value = 2\n',
            basedOnRead,
          },
        },
        agentState: { messageHistory: [] },
        clientSessionId: 'test-session',
        fileContext: mockFileContext,
        runId,
        fileProcessingState,
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

      expect(applied).toBe(false)
      expect(result.output[0]?.type).toBe('json')
      if (result.output[0]?.type === 'json') {
        expect(String((result.output[0].value as any).errorMessage)).toMatch(
          /stale hash|did not match the current file content/i,
        )
      }
    })

    it('strict edit_transaction write_file with valid whole-file basedOnRead applies', async () => {
      const path = 'src/tx-write-cap.ts'
      const diskContent = 'export const value = 1\n'
      const runId = 'tx-write-whole-file-cap-run'
      const fileProcessingState = createFileProcessingState()
      fileProcessingState.strictReadBeforeEdit = true
      const basedOnRead = encodeReadCapabilityToken({
        startLine: 1,
        endLine: diskContent.split('\n').length,
        hash: getContentHash(diskContent),
        scope: {
          projectId: mockFileContext.projectRoot,
          path,
          runId,
        },
      })

      let applied = false
      const result = await handleEditTransaction({
        ...defaultTestHandlerAuthority,
        previousToolCallFinished: Promise.resolve(),
        toolCall: {
          toolCallId: 'tx-write-with-cap',
          toolName: 'edit_transaction',
          input: {
            edits: [
              {
                type: 'write_file',
                path,
                content: 'export const value = 2\n',
                basedOnRead,
              },
            ],
          },
        },
        fileProcessingState,
        fileContext: mockFileContext,
        runId,
        logger,
        requestOptionalFile: async () => diskContent,
        requestClientToolCall: async (toolCall: any) => {
          applied = true
          return confirmedMutationOutput(
            toolCall,
            { [path]: 'export const value = 2\n' },
            { projectId: mockFileContext.projectRoot, runId },
          )
        },
      } as any)

      expect(applied).toBe(true)
      expect(result.output[0]?.type).toBe('json')
      if (result.output[0]?.type === 'json') {
        expect(result.output[0].value).not.toHaveProperty('errorMessage')
      }
    })

    it('strict edit_transaction allows a path when its str_replace replacement has basedOnRead even without registry authorization', async () => {
      const path = 'src/helper.ts'
      const diskContent = 'export const value = 1\n'
      const rangeContent = 'export const value = 1'
      const runId = 'strict-transaction-run'
      const readCapability = encodeReadCapabilityToken({
        startLine: 1,
        endLine: 1,
        hash: getContentHash(rangeContent),
        scope: { projectId: mockFileContext.projectRoot, path, runId },
      })
      const fileProcessingState = createFileProcessingState()
      fileProcessingState.strictReadBeforeEdit = true

      let applied = false
      const result = await handleEditTransaction({
        ...defaultTestHandlerAuthority,
        previousToolCallFinished: Promise.resolve(),
        toolCall: {
          toolCallId: 'strict-transaction-anchored',
          toolName: 'edit_transaction',
          input: {
            edits: [
              {
                type: 'str_replace',
                path,
                replacements: [
                  {
                    oldString: 'export const value = 1',
                    newString: 'export const value = 2',
                    allowMultiple: false,
                    basedOnRead: readCapability,
                  },
                ],
              },
            ],
          },
        },
        fileProcessingState,
        fileContext: mockFileContext,
        runId,
        logger,
        requestOptionalFile: async ({ filePath }: { filePath: string }) =>
          filePath === path ? diskContent : null,
        requestClientToolCall: async (toolCall: any) => {
          applied = true
          return confirmedMutationOutput(
            toolCall,
            { [path]: 'export const value = 2\n' },
            { projectId: mockFileContext.projectRoot, runId },
          )
        },
      } as any)

      expect(applied).toBe(true)
      const output = result.output[0]
      expect(output.type).toBe('json')
      if (output.type === 'json') {
        expect(output.value).not.toHaveProperty('errorMessage')
      }
    })

    it('strict edit_transaction accepts a scoped replace_range capability without whole-file authorization', async () => {
      const path = 'src/range.ts'
      const diskContent = 'export const value = 1\n'
      const rangeContent = 'export const value = 1'
      const runId = 'strict-transaction-range-run'
      const readCapability = encodeReadCapabilityToken({
        startLine: 1,
        endLine: 1,
        hash: getContentHash(rangeContent),
        scope: { projectId: mockFileContext.projectRoot, path, runId },
      })
      const fileProcessingState = createFileProcessingState()
      fileProcessingState.strictReadBeforeEdit = true
      const input = editTransactionParams.inputSchema.parse({
        edits: [
          {
            type: 'replace_range',
            path,
            readCapability,
            newContent: 'export const value = 2',
          },
        ],
      })

      let applied = false
      const result = await handleEditTransaction({
        ...defaultTestHandlerAuthority,
        previousToolCallFinished: Promise.resolve(),
        toolCall: {
          toolCallId: 'strict-transaction-range-anchored',
          toolName: 'edit_transaction',
          input,
        },
        fileProcessingState,
        fileContext: mockFileContext,
        runId,
        logger,
        requestOptionalFile: async ({ filePath }: { filePath: string }) =>
          filePath === path ? diskContent : null,
        requestClientToolCall: async (toolCall: any) => {
          applied = true
          return confirmedMutationOutput(
            toolCall,
            { [path]: 'export const value = 2\n' },
            { projectId: mockFileContext.projectRoot, runId },
          )
        },
      } as any)

      expect(applied).toBe(true)
      expect(result.output[0]).toMatchObject({ type: 'json' })
      if (result.output[0]?.type === 'json') {
        expect(result.output[0].value).not.toHaveProperty('errorMessage')
      }
    })

    it('strict str_replace rejects a stale range capability even when oldString is unique', async () => {
      const path = 'src/stale-anchor.ts'
      const diskContent = 'export const value = 1\n'
      const fileProcessingState = createFileProcessingState()
      fileProcessingState.strictReadBeforeEdit = true
      const runId = 'strict-stale-anchor-run'
      let applied = false

      const result = await handleStrReplace({
        ...defaultTestHandlerAuthority,
        previousToolCallFinished: Promise.resolve(),
        toolCall: {
          toolCallId: 'strict-stale-anchor',
          toolName: 'str_replace',
          input: {
            path,
            replacements: [
              {
                oldString: 'export const value = 1',
                newString: 'export const value = 2',
                allowMultiple: false,
                basedOnRead: encodeReadCapabilityToken({
                  startLine: 1,
                  endLine: 1,
                  hash: getContentHash('export const value = 0'),
                  scope: {
                    projectId: mockFileContext.projectRoot,
                    path,
                    runId,
                  },
                }),
              },
            ],
          },
        },
        fileProcessingState,
        fileContext: mockFileContext,
        runId,
        logger,
        requestOptionalFile: async () => diskContent,
        requestClientToolCall: async () => {
          applied = true
          return []
        },
        writeToClient: () => {},
      } as any)

      expect(applied).toBe(false)
      expect(result.output[0]?.type).toBe('json')
      if (result.output[0]?.type === 'json') {
        const value = result.output[0].value as { errorMessage?: string }
        expect(String(value.errorMessage)).toContain(
          'basedOnRead did not match the current file content',
        )
      }
    })

    it('failed-edit recovery requires a fresh capability on every replacement even when stale path authorization remains', async () => {
      const path = 'src/helper.ts'
      const diskContent = 'export const value = 1\nexport const other = 1\n'
      const firstLine = 'export const value = 1'
      const runId = 'strict-multi-anchor-run'
      const fileProcessingState = createFileProcessingState()
      fileProcessingState.strictReadBeforeEdit = true
      fileProcessingState.failedEditRequiresReadByPath[path] = true
      fileProcessingState.readAuthorizationsByPath = { [path]: true }

      let clientApplyCount = 0
      const result = await handleStrReplace({
        ...defaultTestHandlerAuthority,
        previousToolCallFinished: Promise.resolve(),
        toolCall: {
          toolCallId: 'strict-failed-edit-partial-capabilities',
          toolName: 'str_replace',
          input: {
            path,
            atomic: true,
            replacements: [
              {
                oldString: firstLine,
                newString: 'export const value = 2',
                allowMultiple: false,
                basedOnRead: encodeReadCapabilityToken({
                  startLine: 1,
                  endLine: 1,
                  hash: getContentHash(firstLine),
                  scope: {
                    projectId: mockFileContext.projectRoot,
                    path,
                    runId,
                  },
                }),
              },
              {
                oldString: 'export const other = 1',
                newString: 'export const other = 2',
                allowMultiple: false,
              },
            ],
          },
        },
        fileProcessingState,
        fileContext: mockFileContext,
        runId,
        logger,
        requestOptionalFile: async () => diskContent,
        requestClientToolCall: async () => {
          clientApplyCount += 1
          return []
        },
        writeToClient: () => {},
      } as any)

      expect(clientApplyCount).toBe(0)
      const output = result.output[0]
      expect(output?.type).toBe('json')
      if (output?.type === 'json') {
        expect(String((output.value as any).errorMessage)).toContain(
          'replacement 2/2',
        )
      }
      expect(fileProcessingState.failedEditRequiresReadByPath[path]).toBe(true)
    })

    it('strict edit_transaction rejects a stale basedOnRead capability', async () => {
      const path = 'src/stale-transaction.ts'
      const diskContent = 'export const value = 1\n'
      const fileProcessingState = createFileProcessingState()
      fileProcessingState.strictReadBeforeEdit = true
      const runId = 'strict-stale-transaction-run'
      let applied = false

      const result = await handleEditTransaction({
        ...defaultTestHandlerAuthority,
        previousToolCallFinished: Promise.resolve(),
        toolCall: {
          toolCallId: 'strict-stale-transaction',
          toolName: 'edit_transaction',
          input: {
            edits: [
              {
                type: 'str_replace',
                path,
                replacements: [
                  {
                    oldString: 'export const value = 1',
                    newString: 'export const value = 2',
                    allowMultiple: false,
                    basedOnRead: encodeReadCapabilityToken({
                      startLine: 1,
                      endLine: 1,
                      hash: getContentHash('export const value = 0'),
                      scope: {
                        projectId: mockFileContext.projectRoot,
                        path,
                        runId,
                      },
                    }),
                  },
                ],
              },
            ],
          },
        },
        fileProcessingState,
        fileContext: mockFileContext,
        runId,
        logger,
        requestOptionalFile: async () => diskContent,
        requestClientToolCall: async () => {
          applied = true
          return []
        },
      } as any)

      expect(applied).toBe(false)
      expect(result.output[0]?.type).toBe('json')
      if (result.output[0]?.type === 'json') {
        const value = result.output[0].value as {
          errorMessage?: string
          failures?: Array<{ errorMessage?: string }>
        }
        expect(String(value.errorMessage)).toContain(
          'edit_transaction aborted during preflight at edit 1 of 1',
        )
        expect(String(value.failures?.[0]?.errorMessage)).toContain(
          'basedOnRead did not match the current file content',
        )
      }
    })

    it('stale rewrite_symbol capability requires a fresh read only for the failing path', async () => {
      const symbolPath = 'src/stale-symbol.ts'
      const otherPath = 'src/atomic-peer.ts'
      const symbolContent = 'export function target() {\n  return 1\n}\n'
      const otherContent = 'export const peer = 1\n'
      const runId = 'stale-symbol-atomic-recovery-run'
      const fileProcessingState = createFileProcessingState()
      fileProcessingState.strictReadBeforeEdit = true
      fileProcessingState.readAuthorizationsByPath = {
        [symbolPath]: true,
        [otherPath]: true,
      }
      fileProcessingState.readAuthorizationHashesByPath = {
        [symbolPath]: getContentHash(symbolContent),
        [otherPath]: getContentHash(otherContent),
      }
      const staleSymbolCapability = encodeReadCapabilityToken({
        startLine: 1,
        endLine: 3,
        hash: getContentHash('export function target() {\n  return 0\n}'),
        scope: {
          projectId: mockFileContext.projectRoot,
          path: symbolPath,
          runId,
        },
      })
      let clientMutationCalls = 0

      const result = await handleEditTransaction({
        ...defaultTestHandlerAuthority,
        previousToolCallFinished: Promise.resolve(),
        toolCall: {
          toolCallId: 'stale-symbol-atomic-recovery',
          toolName: 'edit_transaction',
          input: {
            edits: [
              {
                type: 'rewrite_symbol',
                path: symbolPath,
                symbol: 'target',
                content: 'export function target() {\n  return 2\n}',
                readCapability: staleSymbolCapability,
              },
              {
                type: 'str_replace',
                path: otherPath,
                replacements: [
                  {
                    oldString: 'export const peer = 1',
                    newString: 'export const peer = 2',
                    allowMultiple: false,
                  },
                ],
              },
            ],
          },
        },
        fileProcessingState,
        fileContext: mockFileContext,
        runId,
        logger,
        requestOptionalFile: async ({ filePath }: { filePath: string }) =>
          filePath === symbolPath ? symbolContent : otherContent,
        requestClientToolCall: async () => {
          clientMutationCalls += 1
          return []
        },
      } as any)

      expect(clientMutationCalls).toBe(0)
      // Only the stale-capability path loses its read state.
      expect(fileProcessingState.failedEditRequiresReadByPath[symbolPath]).toBe(
        true,
      )
      expect(
        fileProcessingState.editRereadRequirementsByPath?.[symbolPath],
      ).toMatchObject({
        reason: 'stale_capability',
        sourceTool: 'edit_transaction',
      })
      expect(
        fileProcessingState.readAuthorizationsByPath?.[symbolPath],
      ).toBeUndefined()
      expect(
        fileProcessingState.readAuthorizationHashesByPath?.[symbolPath],
      ).toBeUndefined()
      // The co-target never failed and nothing was written, so it keeps auth.
      expect(
        fileProcessingState.failedEditRequiresReadByPath[otherPath],
      ).toBeFalsy()
      expect(hasWholeFileReadAuthorization(fileProcessingState, otherPath)).toBe(
        true,
      )
      expect(result.output[0]?.type).toBe('json')
      if (result.output[0]?.type === 'json') {
        const value = result.output[0].value as {
          errorMessage?: string
          recovery?: { paths?: string[] }
          failures?: Array<{ errorMessage?: string }>
        }
        expect(String(value.failures?.[0]?.errorMessage)).toContain(
          'readCapability-covered symbol content is stale',
        )
        expect(String(value.errorMessage)).toContain('lost read authorization')
        expect(String(value.errorMessage)).toContain(
          'every other transaction target retains valid read state',
        )
        expect(String(value.errorMessage)).not.toContain(
          'Atomic recovery requires fresh read state for every transaction target',
        )
        expect(String(value.errorMessage)).toContain(symbolPath)
        expect(value.recovery?.paths).toEqual([symbolPath])
      }
    })

    it('strict replace_range blocks without prior read or freshness anchor and does not call client apply', async () => {
      const path = 'src/helper.ts'
      const fileProcessingState = createFileProcessingState()
      fileProcessingState.strictReadBeforeEdit = true

      const result = await handleReplaceRange({
        ...defaultTestHandlerAuthority,
        previousToolCallFinished: Promise.resolve(),
        toolCall: {
          toolCallId: 'replace-range-blocked',
          toolName: 'replace_range',
          input: {
            path,
            startLine: 1,
            endLine: 1,
            newContent: 'export const value = 2',
          },
        },
        fileProcessingState,
        requestClientToolCall: async () => {
          throw new Error(
            'client apply must not be called for blocked replace_range',
          )
        },
      } as any)

      const output = result.output[0]
      expect(output.type).toBe('json')
      if (output.type === 'json') {
        const value = output.value as { file?: string; errorMessage?: string }
        expect(value.file).toBe(path)
        expect(String(value.errorMessage)).toContain('replace_range blocked')
        expect(String(value.errorMessage)).toContain('read_files')
      }
      expect(fileProcessingState.failedEditRequiresReadByPath[path]).toBe(true)
    })

    it('replace_range preserves authorization on success but revokes it for stale client snapshots', async () => {
      const path = 'src/helper.ts'
      let diskContent = 'export const value = 1\n'
      const fileProcessingState = createFileProcessingState()
      fileProcessingState.strictReadBeforeEdit = true
      fileProcessingState.readAuthorizationsByPath = { [path]: true }
      fileProcessingState.readAuthorizationHashesByPath = {
        [path]: getContentHash(diskContent),
      }

      const successResult = await handleReplaceRange({
        ...defaultTestHandlerAuthority,
        previousToolCallFinished: Promise.resolve(),
        toolCall: {
          toolCallId: 'replace-range-success',
          toolName: 'replace_range',
          input: {
            path,
            startLine: 1,
            endLine: 1,
            expectedHash: 'sha256:current',
            newContent: 'export const value = 2',
          },
        },
        fileProcessingState,
        requestOptionalFile: async () => diskContent,
        requestClientToolCall: async (toolCall: any) => {
          diskContent = 'export const value = 2\n'
          return confirmedMutationOutput(toolCall, { [path]: diskContent })
        },
      } as any)

      expect(successResult.output[0]?.type).toBe('json')
      // Sticky auth: a successful replace_range does NOT consume the auth.
      expect(fileProcessingState.readAuthorizationsByPath?.[path]).toBe(true)
      expect(
        fileProcessingState.failedEditRequiresReadByPath[path],
      ).toBeUndefined()

      const errorResult = await handleReplaceRange({
        ...defaultTestHandlerAuthority,
        previousToolCallFinished: Promise.resolve(),
        toolCall: {
          toolCallId: 'replace-range-error',
          toolName: 'replace_range',
          input: {
            path,
            startLine: 1,
            endLine: 1,
            expectedHash: 'sha256:stale',
            newContent: 'export const value = 3',
          },
        },
        fileProcessingState,
        requestOptionalFile: async () => diskContent,
        requestClientToolCall: async (toolCall: any) => [
          {
            type: 'json' as const,
            value: {
              file: toolCall.input.path,
              errorCode: 'stale_snapshot',
              errorMessage: 'replace_range rejected: stale range',
            },
          },
        ],
      } as any)

      expect(errorResult.output[0]?.type).toBe('json')
      expect(fileProcessingState.failedEditRequiresReadByPath[path]).toBe(true)
      expect(
        fileProcessingState.editRereadRequirementsByPath?.[path],
      ).toMatchObject({ reason: 'stale_snapshot' })
      expect(
        fileProcessingState.readAuthorizationsByPath?.[path],
      ).toBeUndefined()
    })

    it('strict replace_range rejects a legacy pathless expectedHash as authorization', async () => {
      const path = 'src/helper.ts'
      const fileProcessingState = createFileProcessingState()
      fileProcessingState.strictReadBeforeEdit = true
      // No read authorization registered — only expectedHash as anchor.

      let applied = false
      const result = await handleReplaceRange({
        ...defaultTestHandlerAuthority,
        previousToolCallFinished: Promise.resolve(),
        toolCall: {
          toolCallId: 'replace-range-anchor',
          toolName: 'replace_range',
          input: {
            path,
            startLine: 1,
            endLine: 1,
            expectedHash: 'sha256:fresh',
            newContent: 'export const value = 2',
          },
        },
        fileProcessingState,
        requestClientToolCall: async (toolCall: any) => {
          applied = true
          return confirmedMutationOutput(toolCall, {
            [path]: 'export const value = 2\n',
          })
        },
      } as any)

      expect(applied).toBe(false)
      const output = result.output[0]
      expect(output.type).toBe('json')
      if (output.type === 'json') {
        expect(String((output.value as any).errorMessage)).toContain(
          'no fresh path-bound read authorization exists',
        )
        expect(String((output.value as any).errorMessage)).toContain(
          'cap.v3 readCapability plus newContent',
        )
      }
    })

    it('strict replace_range accepts a cap.v3 token bound to the target and run', async () => {
      const path = 'src/helper.ts'
      const fileProcessingState = createFileProcessingState()
      fileProcessingState.strictReadBeforeEdit = true
      const scope = {
        projectId: mockFileContext.projectRoot,
        path,
        runId: 'replace-range-run',
      }
      const readCapability = encodeReadCapabilityToken({
        startLine: 1,
        endLine: 1,
        hash: getContentHash('export const value = 1'),
        scope,
      })
      let applied = false
      const result = await handleReplaceRange({
        ...defaultTestHandlerAuthority,
        previousToolCallFinished: Promise.resolve(),
        toolCall: {
          toolCallId: 'replace-range-bound-anchor',
          toolName: 'replace_range',
          input: {
            path,
            startLine: 1,
            endLine: 1,
            expectedHash: getContentHash('export const value = 1'),
            readCapability,
            newContent: 'export const value = 2',
          },
        },
        fileContext: mockFileContext,
        runId: scope.runId,
        fileProcessingState,
        requestOptionalFile: async () => 'export const value = 1\n',
        requestClientToolCall: async (toolCall: any) => {
          applied = true
          return confirmedMutationOutput(
            toolCall,
            { [path]: 'export const value = 2\n' },
            { projectId: mockFileContext.projectRoot, runId: scope.runId },
          )
        },
      } as any)

      expect(applied).toBe(true)
      expect(result.output[0]).toMatchObject({ type: 'json' })
    })

    it('does not let a range basedOnRead capability authorize a whole-file overwrite', async () => {
      const path = 'src/helper.ts'
      // Newline-terminated multi-line fixture: visibleLineCount 2,
      // maxCapabilityLine 3, so a `1..1` capability is a genuine PROPER
      // SUBSET of the file rather than a complete full-file range read.
      const diskContent = 'export const a = 1\nexport const b = 2\n'
      const runId = 'range-write-floor-run'
      const fileProcessingState = createFileProcessingState()
      fileProcessingState.strictReadBeforeEdit = true
      const rangeCapability = encodeReadCapabilityToken({
        startLine: 1,
        endLine: 1,
        // Exactly the slice a `1..1` range read hashes: the first line's text
        // with no trailing newline.
        hash: getContentHash('export const a = 1'),
        scope: {
          projectId: mockFileContext.projectRoot,
          path,
          runId,
        },
      })

      // A proper-subset range capability is not sufficient proof for replacing
      // the whole file. Strict mode requires whole-file read authorization.
      const writeResult = await handleWriteFile({
        ...defaultTestHandlerAuthority,
        previousToolCallFinished: Promise.resolve(),
        toolCall: {
          toolCallId: 'e-bypass-write',
          toolName: 'write_file',
          input: {
            path,
            instructions: 'Update helper value',
            content: 'export const a = 2\nexport const b = 3\n',
            basedOnRead: rangeCapability,
          },
        },
        agentState: { messageHistory: [] },
        clientSessionId: 'test-session',
        fileContext: mockFileContext,
        runId,
        fileProcessingState,
        fingerprintId: 'test-fingerprint',
        logger,
        prompt: undefined,
        userId: undefined,
        userInputId: 'test-input',
        requestOptionalFile: async ({ filePath }: { filePath: string }) =>
          filePath === path ? diskContent : null,
        requestClientToolCall: async (toolCall: any) => [
          {
            type: 'json' as const,
            value: { file: toolCall.input.path, message: 'applied' },
          },
        ],
        writeToClient: () => {},
      } as any)

      const writeOutput = writeResult.output[0]
      expect(writeOutput.type).toBe('json')
      if (writeOutput.type === 'json') {
        const value = writeOutput.value as { errorMessage?: string }
        expect(String(value.errorMessage)).toContain(
          'range capability cannot authorize a whole-file overwrite',
        )
      }
    })

    it('create then delete in a later step without an intervening read succeeds in strict mode', async () => {
      const path = 'src/scratch.ts'
      const createdContent = 'export const temp = 1\n'
      const runId = 'create-then-delete-strict-run'
      const fileProcessingState = createFileProcessingState()
      fileProcessingState.strictReadBeforeEdit = true

      const createResult = await handleEditTransaction({
        ...defaultTestHandlerAuthority,
        previousToolCallFinished: Promise.resolve(),
        toolCall: {
          toolCallId: 'create-scratch',
          toolName: 'edit_transaction',
          input: {
            edits: [
              {
                type: 'create',
                path,
                content: createdContent,
              },
            ],
          },
        },
        fileProcessingState,
        fileContext: mockFileContext,
        runId,
        logger,
        requestOptionalFile: async () => null,
        requestClientToolCall: async (toolCall: any) =>
          confirmedMutationOutput(
            toolCall,
            { [path]: createdContent },
            { projectId: mockFileContext.projectRoot, runId },
          ),
      } as any)

      const createOutput = createResult.output[0]
      expect(createOutput.type).toBe('json')
      if (createOutput.type === 'json') {
        expect(createOutput.value).not.toHaveProperty('errorMessage')
      }
      // The confirmed create grants sticky auth from the runtime-known created
      // bytes, plus a confirmed post-edit anchor a later delete can rely on.
      expect(fileProcessingState.readAuthorizationsByPath?.[path]).toBe(true)
      expect(fileProcessingState.readAuthorizationHashesByPath?.[path]).toBe(
        getContentHash(createdContent),
      )
      expect(
        fileProcessingState.confirmedPostEditAnchorsByPath?.[path],
      ).toBeDefined()

      // WITHOUT any read_files, a later delete must be authorized by the
      // confirmed post-edit anchor matching the snapshotted current content.
      let applied = false
      const deleteResult = await handleEditTransaction({
        ...defaultTestHandlerAuthority,
        previousToolCallFinished: Promise.resolve(),
        toolCall: {
          toolCallId: 'delete-scratch',
          toolName: 'edit_transaction',
          input: {
            edits: [
              {
                type: 'delete',
                path,
              },
            ],
          },
        },
        fileProcessingState,
        fileContext: mockFileContext,
        runId,
        logger,
        requestOptionalFile: async ({ filePath }: { filePath: string }) =>
          filePath === path ? createdContent : null,
        requestClientToolCall: async (toolCall: any) => {
          applied = true
          return confirmedMutationOutput(
            toolCall,
            {},
            { projectId: mockFileContext.projectRoot, runId },
          )
        },
      } as any)

      expect(applied).toBe(true)
      const deleteOutput = deleteResult.output[0]
      expect(deleteOutput.type).toBe('json')
      if (deleteOutput.type === 'json') {
        expect(deleteOutput.value).not.toHaveProperty('errorMessage')
      }
    })

    it('delete on an externally-modified created file still fails closed', async () => {
      const path = 'src/scratch.ts'
      const createdContent = 'export const temp = 1\n'
      const runId = 'create-then-delete-stale-strict-run'
      const fileProcessingState = createFileProcessingState()
      fileProcessingState.strictReadBeforeEdit = true

      const createResult = await handleEditTransaction({
        ...defaultTestHandlerAuthority,
        previousToolCallFinished: Promise.resolve(),
        toolCall: {
          toolCallId: 'create-scratch',
          toolName: 'edit_transaction',
          input: {
            edits: [
              {
                type: 'create',
                path,
                content: createdContent,
              },
            ],
          },
        },
        fileProcessingState,
        fileContext: mockFileContext,
        runId,
        logger,
        requestOptionalFile: async () => null,
        requestClientToolCall: async (toolCall: any) =>
          confirmedMutationOutput(
            toolCall,
            { [path]: createdContent },
            { projectId: mockFileContext.projectRoot, runId },
          ),
      } as any)

      const createOutput = createResult.output[0]
      expect(createOutput.type).toBe('json')
      if (createOutput.type === 'json') {
        expect(createOutput.value).not.toHaveProperty('errorMessage')
      }
      expect(
        fileProcessingState.confirmedPostEditAnchorsByPath?.[path],
      ).toBeDefined()

      // The file was modified externally after the create, so the confirmed
      // anchor's contentHash no longer matches the snapshotted current
      // content: the delete must fail closed and the client must not apply.
      let applied = false
      const deleteResult = await handleEditTransaction({
        ...defaultTestHandlerAuthority,
        previousToolCallFinished: Promise.resolve(),
        toolCall: {
          toolCallId: 'delete-scratch-stale',
          toolName: 'edit_transaction',
          input: {
            edits: [
              {
                type: 'delete',
                path,
              },
            ],
          },
        },
        fileProcessingState,
        fileContext: mockFileContext,
        runId,
        logger,
        requestOptionalFile: async ({ filePath }: { filePath: string }) =>
          filePath === path ? 'export const temp = 999\n' : null,
        requestClientToolCall: async (toolCall: any) => {
          applied = true
          return confirmedMutationOutput(
            toolCall,
            {},
            { projectId: mockFileContext.projectRoot, runId },
          )
        },
      } as any)

      expect(applied).toBe(false)
      const deleteOutput = deleteResult.output[0]
      expect(deleteOutput.type).toBe('json')
      if (deleteOutput.type === 'json') {
        expect(deleteOutput.value).toHaveProperty('errorMessage')
      }
    })

    it('a capability-bearing edit is blocked when the authoritative run scope is empty', async () => {
      // The hasCapabilityBearingEdit && (!projectId || !runId) guard: a
      // capability-bearing edit (here a write_file carrying basedOnRead) must
      // fail closed BEFORE any authorization or client apply when the runtime
      // has no authoritative project/run scope. Every other test spreads
      // defaultTestHandlerAuthority (which sets fileContext + runId), so this
      // omits them to exercise the empty-scope branch.
      const path = 'src/empty-scope.ts'
      const fileProcessingState = createFileProcessingState()
      fileProcessingState.strictReadBeforeEdit = true

      let applied = false
      const result = await handleEditTransaction({
        // Deliberately NO defaultTestHandlerAuthority spread: no fileContext,
        // no runId.
        previousToolCallFinished: Promise.resolve(),
        toolCall: {
          toolCallId: 'empty-scope-capability-tx',
          toolName: 'edit_transaction',
          input: {
            edits: [
              {
                type: 'write_file',
                path,
                content: 'export const v = 1\n',
                basedOnRead: 'cap.v3.some-token',
              },
            ],
          },
        },
        fileProcessingState,
        logger,
        requestOptionalFile: async () => null,
        requestClientToolCall: async () => {
          applied = true
          return []
        },
      } as any)

      // Fail closed: the client is never asked to apply, and the output names
      // the missing authoritative scope for the capability-bearing edit.
      expect(applied).toBe(false)
      const output = result.output[0]
      expect(output.type).toBe('json')
      if (output.type === 'json') {
        expect(String((output.value as any).errorMessage)).toContain(
          'capability-bearing edits require a nonempty authoritative projectId and runId',
        )
      }
    })

    it('a partial (scoped) post-edit anchor does not authorize a delete of the whole file', async () => {
      const path = 'src/partial-anchor.ts'
      const diskContent = 'line1\nline2\nline3\n'
      const runId = 'partial-anchor-delete-strict-run'
      const fileProcessingState = createFileProcessingState()
      fileProcessingState.strictReadBeforeEdit = true
      // Partial/scoped anchor: startLine is 3 (NOT 1) but the contentHash DOES
      // match the snapshot, so ONLY the whole-file startLine guard can block
      // the delete. No readAuthorizationsByPath is seeded, so the delete has
      // no other authorization source and must rely on the (partial) anchor.
      fileProcessingState.confirmedPostEditAnchorsByPath = {
        [path]: {
          startLine: 3,
          endLine: 10,
          contentHash: getContentHash(diskContent),
          readCapability: 'cap.v3.partial',
        },
      }

      let applied = false
      const deleteResult = await handleEditTransaction({
        ...defaultTestHandlerAuthority,
        previousToolCallFinished: Promise.resolve(),
        toolCall: {
          toolCallId: 'delete-partial-anchor',
          toolName: 'edit_transaction',
          input: {
            edits: [
              {
                type: 'delete',
                path,
              },
            ],
          },
        },
        fileProcessingState,
        fileContext: mockFileContext,
        runId,
        logger,
        requestOptionalFile: async ({ filePath }: { filePath: string }) =>
          filePath === path ? diskContent : null,
        requestClientToolCall: async (toolCall: any) => {
          applied = true
          return confirmedMutationOutput(
            toolCall,
            {},
            { projectId: mockFileContext.projectRoot, runId },
          )
        },
      } as any)

      // A partial anchor must fail closed to the generic block: the client is
      // never asked to apply the destructive whole-file delete.
      expect(applied).toBe(false)
      const deleteOutput = deleteResult.output[0]
      expect(deleteOutput.type).toBe('json')
      if (deleteOutput.type === 'json') {
        expect(deleteOutput.value).toHaveProperty('errorMessage')
      }
    })

    it('a whole-file (startLine 1) post-edit anchor with a matching hash authorizes a delete', async () => {
      // Contrast: the SAME anchor as the partial case above with only
      // startLine flipped to 1 (same contentHash, same readCapability string,
      // still no sticky readAuthorizationsByPath). The delete is now
      // authorized, proving the guard keys on startLine specifically.
      const path = 'src/partial-anchor.ts'
      const diskContent = 'line1\nline2\nline3\n'
      const runId = 'whole-anchor-delete-strict-run'
      const fileProcessingState = createFileProcessingState()
      fileProcessingState.strictReadBeforeEdit = true
      fileProcessingState.confirmedPostEditAnchorsByPath = {
        [path]: {
          startLine: 1,
          endLine: 10,
          contentHash: getContentHash(diskContent),
          readCapability: 'cap.v3.whole',
        },
      }

      let applied = false
      const deleteResult = await handleEditTransaction({
        ...defaultTestHandlerAuthority,
        previousToolCallFinished: Promise.resolve(),
        toolCall: {
          toolCallId: 'delete-whole-anchor',
          toolName: 'edit_transaction',
          input: {
            edits: [
              {
                type: 'delete',
                path,
              },
            ],
          },
        },
        fileProcessingState,
        fileContext: mockFileContext,
        runId,
        logger,
        requestOptionalFile: async ({ filePath }: { filePath: string }) =>
          filePath === path ? diskContent : null,
        requestClientToolCall: async (toolCall: any) => {
          applied = true
          return confirmedMutationOutput(
            toolCall,
            {},
            { projectId: mockFileContext.projectRoot, runId },
          )
        },
      } as any)

      expect(applied).toBe(true)
      const deleteOutput = deleteResult.output[0]
      expect(deleteOutput.type).toBe('json')
      if (deleteOutput.type === 'json') {
        expect(deleteOutput.value).not.toHaveProperty('errorMessage')
      }
    })

    it('create then move in a later step without an intervening read succeeds in strict mode', async () => {
      const path = 'src/scratch.ts'
      const destinationPath = 'src/scratch-moved.ts'
      const createdContent = 'export const temp = 1\n'
      const runId = 'create-then-move-strict-run'
      const fileProcessingState = createFileProcessingState()
      fileProcessingState.strictReadBeforeEdit = true

      const createResult = await handleEditTransaction({
        ...defaultTestHandlerAuthority,
        previousToolCallFinished: Promise.resolve(),
        toolCall: {
          toolCallId: 'create-scratch',
          toolName: 'edit_transaction',
          input: {
            edits: [
              {
                type: 'create',
                path,
                content: createdContent,
              },
            ],
          },
        },
        fileProcessingState,
        fileContext: mockFileContext,
        runId,
        logger,
        requestOptionalFile: async () => null,
        requestClientToolCall: async (toolCall: any) =>
          confirmedMutationOutput(
            toolCall,
            { [path]: createdContent },
            { projectId: mockFileContext.projectRoot, runId },
          ),
      } as any)

      const createOutput = createResult.output[0]
      expect(createOutput.type).toBe('json')
      if (createOutput.type === 'json') {
        expect(createOutput.value).not.toHaveProperty('errorMessage')
      }
      expect(
        fileProcessingState.confirmedPostEditAnchorsByPath?.[path],
      ).toBeDefined()

      // WITHOUT any read_files, a later move must be authorized by the
      // confirmed post-edit anchor on the SOURCE path matching the
      // snapshotted current source content. The destination does not exist.
      let applied = false
      const moveResult = await handleEditTransaction({
        ...defaultTestHandlerAuthority,
        previousToolCallFinished: Promise.resolve(),
        toolCall: {
          toolCallId: 'move-scratch',
          toolName: 'edit_transaction',
          input: {
            edits: [
              {
                type: 'move',
                path,
                destinationPath,
              },
            ],
          },
        },
        fileProcessingState,
        fileContext: mockFileContext,
        runId,
        logger,
        requestOptionalFile: async ({ filePath }: { filePath: string }) =>
          filePath === path
            ? createdContent
            : filePath === destinationPath
              ? null
              : null,
        requestClientToolCall: async (toolCall: any) => {
          applied = true
          return confirmedMutationOutput(
            toolCall,
            { [destinationPath]: createdContent },
            { projectId: mockFileContext.projectRoot, runId },
          )
        },
      } as any)

      expect(applied).toBe(true)
      const moveOutput = moveResult.output[0]
      expect(moveOutput.type).toBe('json')
      if (moveOutput.type === 'json') {
        expect(moveOutput.value).not.toHaveProperty('errorMessage')
      }
    })

    it('confirmed move grants sticky auth and a post-edit anchor on the destination path', async () => {
      const path = 'src/move-anchor-src.ts'
      const destinationPath = 'src/move-anchor-dest.ts'
      const createdContent = 'export const v = 1\n'
      const runId = 'move-anchor-rekey-strict-run'
      const fileProcessingState = createFileProcessingState()
      fileProcessingState.strictReadBeforeEdit = true

      const createResult = await handleEditTransaction({
        ...defaultTestHandlerAuthority,
        previousToolCallFinished: Promise.resolve(),
        toolCall: {
          toolCallId: 'create-move-anchor-src',
          toolName: 'edit_transaction',
          input: {
            edits: [
              {
                type: 'create',
                path,
                content: createdContent,
              },
            ],
          },
        },
        fileProcessingState,
        fileContext: mockFileContext,
        runId,
        logger,
        requestOptionalFile: async () => null,
        requestClientToolCall: async (toolCall: any) =>
          confirmedMutationOutput(
            toolCall,
            { [path]: createdContent },
            { projectId: mockFileContext.projectRoot, runId },
          ),
      } as any)

      const createOutput = createResult.output[0]
      expect(createOutput.type).toBe('json')
      if (createOutput.type === 'json') {
        expect(createOutput.value).not.toHaveProperty('errorMessage')
      }

      // A confirmed move populates wholeFileContentByPath[destinationPath] from
      // the runtime-known source bytes and confirmationPaths includes the
      // destination, so commitAppliedEditPaths must re-key BOTH the sticky
      // whole-file authorization AND the confirmed post-edit anchor onto the
      // destination path (getPositiveApplicationEvidence uses
      // action.destinationPath ?? action.path as the anchor target).
      let applied = false
      const moveResult = await handleEditTransaction({
        ...defaultTestHandlerAuthority,
        previousToolCallFinished: Promise.resolve(),
        toolCall: {
          toolCallId: 'move-anchor-rekey',
          toolName: 'edit_transaction',
          input: {
            edits: [
              {
                type: 'move',
                path,
                destinationPath,
              },
            ],
          },
        },
        fileProcessingState,
        fileContext: mockFileContext,
        runId,
        logger,
        requestOptionalFile: async ({ filePath }: { filePath: string }) =>
          filePath === path
            ? createdContent
            : filePath === destinationPath
              ? null
              : null,
        requestClientToolCall: async (toolCall: any) => {
          applied = true
          return confirmedMutationOutput(
            toolCall,
            { [destinationPath]: createdContent },
            { projectId: mockFileContext.projectRoot, runId },
          )
        },
      } as any)

      expect(applied).toBe(true)
      const moveOutput = moveResult.output[0]
      expect(moveOutput.type).toBe('json')
      if (moveOutput.type === 'json') {
        expect(moveOutput.value).not.toHaveProperty('errorMessage')
      }

      // The confirmed post-edit anchor is re-keyed to the DESTINATION (not the
      // now-deleted source), minted from the runtime-known source bytes.
      const destinationAnchor =
        fileProcessingState.confirmedPostEditAnchorsByPath?.[destinationPath]
      expect(destinationAnchor).toBeDefined()
      expect(destinationAnchor?.contentHash).toBe(
        getContentHash(createdContent),
      )
      expect(destinationAnchor?.readCapability).toMatch(/^cap\.v3\./)

      // Sticky whole-file authorization + hash are also granted on the
      // destination path.
      expect(
        fileProcessingState.readAuthorizationsByPath?.[destinationPath],
      ).toBe(true)
      expect(
        fileProcessingState.readAuthorizationHashesByPath?.[destinationPath],
      ).toBe(getContentHash(createdContent))
    })

    it('cross-turn hydration remints the confirmed post-edit anchor with sticky auth', async () => {
      const path = 'src/cross-turn.ts'
      const createdContent = 'export const c = 1\n'
      const runId = 'cross-turn-hydration-strict-run'
      const fileProcessingState = createFileProcessingState()
      fileProcessingState.strictReadBeforeEdit = true

      const createResult = await handleEditTransaction({
        ...defaultTestHandlerAuthority,
        previousToolCallFinished: Promise.resolve(),
        toolCall: {
          toolCallId: 'create-cross-turn',
          toolName: 'edit_transaction',
          input: {
            edits: [
              {
                type: 'create',
                path,
                content: createdContent,
              },
            ],
          },
        },
        fileProcessingState,
        fileContext: mockFileContext,
        runId,
        logger,
        requestOptionalFile: async () => null,
        requestClientToolCall: async (toolCall: any) =>
          confirmedMutationOutput(
            toolCall,
            { [path]: createdContent },
            { projectId: mockFileContext.projectRoot, runId },
          ),
      } as any)

      const createOutput = createResult.output[0]
      expect(createOutput.type).toBe('json')
      if (createOutput.type === 'json') {
        expect(createOutput.value).not.toHaveProperty('errorMessage')
      }
      expect(fileProcessingState.readAuthorizationsByPath?.[path]).toBe(true)
      expect(fileProcessingState.readAuthorizationHashesByPath?.[path]).toBe(
        getContentHash(createdContent),
      )
      const storedAnchor =
        fileProcessingState.confirmedPostEditAnchorsByPath?.[path]
      expect(storedAnchor).toBeDefined()

      const nextTurnState = createFileProcessingState()
      nextTurnState.strictReadBeforeEdit = true
      nextTurnState.readAuthorizationsByPath = {
        ...(fileProcessingState.readAuthorizationsByPath ?? {}),
      }
      nextTurnState.readAuthorizationHashesByPath = {
        ...(fileProcessingState.readAuthorizationHashesByPath ?? {}),
      }
      nextTurnState.editRereadRequirementsByPath = {
        ...(fileProcessingState.editRereadRequirementsByPath ?? {}),
      }
      nextTurnState.confirmedPostEditAnchorsByPath =
        remintConfirmedPostEditAnchors({
          anchors: fileProcessingState.confirmedPostEditAnchorsByPath,
          projectId: mockFileContext.projectRoot,
          runId,
        })

      expect(nextTurnState.readAuthorizationsByPath?.[path]).toBe(true)
      expect(nextTurnState.readAuthorizationHashesByPath?.[path]).toBe(
        getContentHash(createdContent),
      )
      const reminted = nextTurnState.confirmedPostEditAnchorsByPath?.[path]
      expect(reminted).toBeDefined()
      expect(storedAnchor).toBeDefined()
      if (!reminted || !storedAnchor) return
      expect(reminted.contentHash).toBe(storedAnchor.contentHash)
      expect(reminted.startLine).toBe(storedAnchor.startLine)
      expect(reminted.endLine).toBe(storedAnchor.endLine)
      const decoded = decodeReadCapabilityToken(reminted.readCapability)
      expect(typeof decoded).not.toBe('string')
      if (typeof decoded !== 'string') {
        expect(decoded.hash).toBe(storedAnchor.contentHash)
        expect(decoded.startLine).toBe(storedAnchor.startLine)
        expect(decoded.endLine).toBe(storedAnchor.endLine)
      }
    })

    it('move on an externally-modified created file still fails closed', async () => {
      const path = 'src/scratch.ts'
      const destinationPath = 'src/scratch-moved.ts'
      const createdContent = 'export const temp = 1\n'
      const runId = 'create-then-move-stale-strict-run'
      const fileProcessingState = createFileProcessingState()
      fileProcessingState.strictReadBeforeEdit = true

      const createResult = await handleEditTransaction({
        ...defaultTestHandlerAuthority,
        previousToolCallFinished: Promise.resolve(),
        toolCall: {
          toolCallId: 'create-scratch',
          toolName: 'edit_transaction',
          input: {
            edits: [
              {
                type: 'create',
                path,
                content: createdContent,
              },
            ],
          },
        },
        fileProcessingState,
        fileContext: mockFileContext,
        runId,
        logger,
        requestOptionalFile: async () => null,
        requestClientToolCall: async (toolCall: any) =>
          confirmedMutationOutput(
            toolCall,
            { [path]: createdContent },
            { projectId: mockFileContext.projectRoot, runId },
          ),
      } as any)

      const createOutput = createResult.output[0]
      expect(createOutput.type).toBe('json')
      if (createOutput.type === 'json') {
        expect(createOutput.value).not.toHaveProperty('errorMessage')
      }
      expect(
        fileProcessingState.confirmedPostEditAnchorsByPath?.[path],
      ).toBeDefined()

      // The source was modified externally after the create, so the confirmed
      // anchor's contentHash no longer matches the snapshotted current source
      // content: the move must fail closed and the client must not apply.
      let applied = false
      const moveResult = await handleEditTransaction({
        ...defaultTestHandlerAuthority,
        previousToolCallFinished: Promise.resolve(),
        toolCall: {
          toolCallId: 'move-scratch-stale',
          toolName: 'edit_transaction',
          input: {
            edits: [
              {
                type: 'move',
                path,
                destinationPath,
              },
            ],
          },
        },
        fileProcessingState,
        fileContext: mockFileContext,
        runId,
        logger,
        requestOptionalFile: async ({ filePath }: { filePath: string }) =>
          filePath === path
            ? 'export const temp = 999\n'
            : filePath === destinationPath
              ? null
              : null,
        requestClientToolCall: async (toolCall: any) => {
          applied = true
          return confirmedMutationOutput(
            toolCall,
            { [destinationPath]: createdContent },
            { projectId: mockFileContext.projectRoot, runId },
          )
        },
      } as any)

      expect(applied).toBe(false)
      const moveOutput = moveResult.output[0]
      expect(moveOutput.type).toBe('json')
      if (moveOutput.type === 'json') {
        expect(moveOutput.value).toHaveProperty('errorMessage')
      }
    })

    it('move to an existing destination fails closed even when the source is authorized', async () => {
      const path = 'src/scratch.ts'
      const destinationPath = 'src/scratch-moved.ts'
      const createdContent = 'export const temp = 1\n'
      const runId = 'create-then-move-existing-destination-strict-run'
      const fileProcessingState = createFileProcessingState()
      fileProcessingState.strictReadBeforeEdit = true

      const createResult = await handleEditTransaction({
        ...defaultTestHandlerAuthority,
        previousToolCallFinished: Promise.resolve(),
        toolCall: {
          toolCallId: 'create-scratch',
          toolName: 'edit_transaction',
          input: {
            edits: [
              {
                type: 'create',
                path,
                content: createdContent,
              },
            ],
          },
        },
        fileProcessingState,
        fileContext: mockFileContext,
        runId,
        logger,
        requestOptionalFile: async () => null,
        requestClientToolCall: async (toolCall: any) =>
          confirmedMutationOutput(
            toolCall,
            { [path]: createdContent },
            { projectId: mockFileContext.projectRoot, runId },
          ),
      } as any)

      const createOutput = createResult.output[0]
      expect(createOutput.type).toBe('json')
      if (createOutput.type === 'json') {
        expect(createOutput.value).not.toHaveProperty('errorMessage')
      }
      // The source has a confirmed post-edit anchor (source is authorized).
      expect(
        fileProcessingState.confirmedPostEditAnchorsByPath?.[path],
      ).toBeDefined()

      // The source is fresh/authorized, but the destination already exists.
      // Destination safety is enforced separately by the lifecycle preflight,
      // which must block the move with `Move destination already exists`
      // independent of the source authorization.
      let applied = false
      const moveResult = await handleEditTransaction({
        ...defaultTestHandlerAuthority,
        previousToolCallFinished: Promise.resolve(),
        toolCall: {
          toolCallId: 'move-scratch-existing-destination',
          toolName: 'edit_transaction',
          input: {
            edits: [
              {
                type: 'move',
                path,
                destinationPath,
              },
            ],
          },
        },
        fileProcessingState,
        fileContext: mockFileContext,
        runId,
        logger,
        requestOptionalFile: async ({ filePath }: { filePath: string }) =>
          filePath === path
            ? createdContent
            : filePath === destinationPath
              ? 'export const existing = 1\n'
              : null,
        requestClientToolCall: async (toolCall: any) => {
          applied = true
          return confirmedMutationOutput(
            toolCall,
            { [destinationPath]: createdContent },
            { projectId: mockFileContext.projectRoot, runId },
          )
        },
      } as any)

      expect(applied).toBe(false)
      const moveOutput = moveResult.output[0]
      expect(moveOutput.type).toBe('json')
      if (moveOutput.type === 'json') {
        const value = moveOutput.value as {
          errorMessage?: string
          failures?: Array<{ errorMessage?: string }>
        }
        const errorText = [
          value.errorMessage,
          ...(value.failures?.map((failure) => failure.errorMessage) ?? []),
        ]
          .map(String)
          .join('\n')
        expect(value).toHaveProperty('errorMessage')
        expect(errorText).toContain('Move destination already exists')
      }
    })

    it('capability-kind preflight failure revokes authorization even when the message would not need regex (structured kind)', async () => {
      // The structured failureKind classifier: a replace_range whose readCapability
      // is scoped to a DIFFERENT run fails processEditTransaction preflight with
      // failureKind 'capability_scope'. That capability-kind tag forces
      // requiresFreshCapability true, so the handler revokes the path's whole-file
      // authorization and records a stale_capability reread requirement — even
      // though the seed authorization hash itself matched disk.
      const path = 'src/structured-capability-scope.ts'
      const diskContent = 'export const value = 1\n'
      const firstLine = 'export const value = 1'
      const runId = 'structured-capability-scope-run'
      const fileProcessingState = createFileProcessingState()
      fileProcessingState.strictReadBeforeEdit = true
      // Seed a fresh whole-file authorization whose hash matches current disk.
      fileProcessingState.readAuthorizationsByPath = { [path]: true }
      fileProcessingState.readAuthorizationHashesByPath = {
        [path]: getContentHash(diskContent),
      }
      // Mint a capability bound to a DIFFERENT run (and the authoritative
      // project/path) so the scope check fails with capability_scope.
      const wrongRunCapability = encodeReadCapabilityToken({
        startLine: 1,
        endLine: 1,
        hash: getContentHash(firstLine),
        scope: {
          projectId: mockFileContext.projectRoot,
          path,
          runId: 'a-different-run-id',
        },
      })

      const result = await handleEditTransaction({
        ...defaultTestHandlerAuthority,
        previousToolCallFinished: Promise.resolve(),
        toolCall: {
          toolCallId: 'structured-capability-scope-tx',
          toolName: 'edit_transaction',
          input: {
            edits: [
              {
                type: 'replace_range',
                path,
                readCapability: wrongRunCapability,
                newContent: 'export const value = 2',
              },
            ],
          },
        },
        fileProcessingState,
        fileContext: mockFileContext,
        runId,
        logger,
        requestOptionalFile: async ({ filePath }: { filePath: string }) =>
          filePath === path ? diskContent : null,
        requestClientToolCall: async () => {
          throw new Error('must not apply a capability_scope preflight failure')
        },
      } as any)

      const output = result.output[0]
      expect(output.type).toBe('json')
      if (output.type === 'json') {
        expect(output.value).toHaveProperty('errorMessage')
      }
      // Capability-kind failure: authorization is revoked and a stale_capability
      // reread requirement is recorded for the transaction path.
      expect(
        fileProcessingState.readAuthorizationsByPath?.[path],
      ).toBeUndefined()
      expect(
        fileProcessingState.readAuthorizationHashesByPath?.[path],
      ).toBeUndefined()
      expect(
        fileProcessingState.editRereadRequirementsByPath?.[path]?.reason,
      ).toBe('stale_capability')
    })

    it('match/no-match preflight failure requires fresh read only on the failing transaction path', async () => {
      // A preflight abort writes no bytes, so only the path that actually failed
      // loses read authorization. The non-failing target keeps its (still
      // hash-verified) read state, but the whole transaction must be resent.
      const pathA = 'src/match-a.ts'
      const pathB = 'src/match-b.ts'
      const contentA = 'export const value = 1\n'
      const contentB = 'export const peer = 1\n'
      const runId = 'match-preflight-fresh-read-run'
      const fileProcessingState = createFileProcessingState()
      fileProcessingState.strictReadBeforeEdit = true
      fileProcessingState.readAuthorizationsByPath = {
        [pathA]: true,
        [pathB]: true,
      }
      fileProcessingState.readAuthorizationHashesByPath = {
        [pathA]: getContentHash(contentA),
        [pathB]: getContentHash(contentB),
      }

      let clientCalls = 0
      const result = await handleEditTransaction({
        ...defaultTestHandlerAuthority,
        previousToolCallFinished: Promise.resolve(),
        toolCall: {
          toolCallId: 'match-preflight-fresh-read-tx',
          toolName: 'edit_transaction',
          input: {
            edits: [
              {
                type: 'str_replace',
                path: pathA,
                replacements: [
                  {
                    oldString: 'export const value = 1',
                    newString: 'export const value = 2',
                    allowMultiple: false,
                  },
                ],
              },
              {
                type: 'str_replace',
                path: pathB,
                replacements: [
                  {
                    oldString: 'export const peer = 999',
                    newString: 'export const peer = 2',
                    allowMultiple: false,
                  },
                ],
              },
            ],
          },
        },
        fileProcessingState,
        fileContext: mockFileContext,
        runId,
        logger,
        requestOptionalFile: async ({ filePath }: { filePath: string }) => {
          if (filePath === pathA) return contentA
          if (filePath === pathB) return contentB
          return null
        },
        requestClientToolCall: async () => {
          clientCalls += 1
          throw new Error('must not apply multi-file match abort')
        },
      } as any)

      expect(clientCalls).toBe(0)
      // Only pathB's oldString failed to match, so only pathB is marked.
      expect(fileProcessingState.failedEditRequiresReadByPath[pathB]).toBe(true)
      expect(
        fileProcessingState.editRereadRequirementsByPath?.[pathB],
      ).toMatchObject({
        reason: 'preflight_failed',
        sourceTool: 'edit_transaction',
      })
      // pathA never failed and no bytes were written, so it keeps its read
      // authorization and must not be re-read.
      expect(
        fileProcessingState.failedEditRequiresReadByPath[pathA],
      ).toBeFalsy()
      expect(hasWholeFileReadAuthorization(fileProcessingState, pathA)).toBe(
        true,
      )

      const output = result.output[0]
      expect(output.type).toBe('json')
      if (output.type === 'json') {
        const value = output.value as {
          errorMessage?: string
          requiresFreshRead?: boolean
          errorCode?: string
          recovery?: {
            paths?: string[]
            requiresFreshRead?: boolean
            action?: string
          }
        }
        expect(value.requiresFreshRead).toBe(true)
        expect(value.errorCode).toBe('no_match')
        expect(value.recovery?.action).toBe('rebuild_whole_transaction')
        expect(value.recovery?.requiresFreshRead).toBe(true)
        // The narrowed recovery target must agree with the prose: pathB only.
        expect(value.recovery?.paths).toEqual([pathB])
        expect(String(value.errorMessage)).toContain(pathB)
        expect(String(value.errorMessage)).toContain(
          'every other transaction target retains valid read state',
        )
        expect(String(value.errorMessage)).not.toContain(
          'Atomic recovery requires fresh read state for every transaction target',
        )
      }
    })

    it('anchored scope mismatch narrows invalidation to the failing path only', async () => {
      // A fresh-but-wrong-window basedOnRead is a per-path targeting mistake:
      // no file changed and only the offending path's read scope is wrong, so
      // the peer target must keep its read authorization and the prose must not
      // demand fresh reads for every transaction target.
      const pathA = 'src/anchor-scope-a.ts'
      const pathB = 'src/anchor-scope-b.ts'
      const contentA =
        [
          'export const first = 1',
          'export const second = 2',
          'export const target = 3',
        ].join('\n') + '\n'
      const contentB = 'export const peer = 1\n'
      const runId = 'anchor-scope-mismatch-narrow-run'
      const fileProcessingState = createFileProcessingState()
      fileProcessingState.strictReadBeforeEdit = true
      fileProcessingState.readAuthorizationsByPath = {
        [pathA]: true,
        [pathB]: true,
      }
      fileProcessingState.readAuthorizationHashesByPath = {
        [pathA]: getContentHash(contentA),
        [pathB]: getContentHash(contentB),
      }
      // Fresh capability covering ONLY line 1 of pathA, while the oldString
      // lives on line 3.
      const wrongWindowCapability = encodeReadCapabilityToken({
        startLine: 1,
        endLine: 1,
        hash: getContentHash('export const first = 1'),
        scope: { projectId: mockFileContext.projectRoot, path: pathA, runId },
      })
      const wholeFileCapabilityB = encodeReadCapabilityToken({
        startLine: 1,
        endLine: contentB.split('\n').length,
        hash: getContentHash(contentB),
        scope: { projectId: mockFileContext.projectRoot, path: pathB, runId },
      })

      let clientCalls = 0
      const result = await handleEditTransaction({
        ...defaultTestHandlerAuthority,
        previousToolCallFinished: Promise.resolve(),
        toolCall: {
          toolCallId: 'anchor-scope-mismatch-narrow-tx',
          toolName: 'edit_transaction',
          input: {
            edits: [
              {
                type: 'str_replace',
                path: pathA,
                replacements: [
                  {
                    oldString: 'export const target = 3',
                    newString: 'export const target = 4',
                    allowMultiple: false,
                    basedOnRead: wrongWindowCapability,
                  },
                ],
              },
              {
                type: 'str_replace',
                path: pathB,
                replacements: [
                  {
                    oldString: 'export const peer = 1',
                    newString: 'export const peer = 2',
                    allowMultiple: false,
                    basedOnRead: wholeFileCapabilityB,
                  },
                ],
              },
            ],
          },
        },
        fileProcessingState,
        fileContext: mockFileContext,
        runId,
        logger,
        requestOptionalFile: async ({ filePath }: { filePath: string }) => {
          if (filePath === pathA) return contentA
          if (filePath === pathB) return contentB
          return null
        },
        requestClientToolCall: async () => {
          clientCalls += 1
          throw new Error('must not apply an anchored scope mismatch')
        },
      } as any)

      expect(clientCalls).toBe(0)
      expect(fileProcessingState.failedEditRequiresReadByPath[pathA]).toBe(true)
      // The peer target keeps valid read state: no blast-radius revocation.
      expect(
        fileProcessingState.failedEditRequiresReadByPath[pathB],
      ).toBeFalsy()
      expect(
        fileProcessingState.readAuthorizationsByPath?.[pathB],
      ).toBeDefined()

      const output = result.output[0]
      expect(output.type).toBe('json')
      if (output.type === 'json') {
        const value = output.value as {
          errorMessage?: string
          errorCode?: string
          recovery?: { paths?: string[]; preferredStrategy?: string }
          failures?: Array<{ failureKind?: string }>
        }
        expect(String(value.errorMessage)).toContain('lost read authorization')
        expect(String(value.errorMessage)).toContain(
          'every other transaction target retains valid read state',
        )
        expect(String(value.errorMessage)).not.toContain(
          'Atomic recovery requires fresh read state for every transaction target',
        )
        expect(value.errorCode).toBe('no_match')
        expect(value.recovery?.preferredStrategy).toBe('replace_range')
        expect(value.recovery?.paths).toEqual([pathA])
        expect(value.failures?.[0]?.failureKind).toBe('anchor_scope_mismatch')
      }
    })
  })
})
