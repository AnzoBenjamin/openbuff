import { TEST_AGENT_RUNTIME_IMPL } from '@codebuff/common/testing/impl/agent-runtime'
import { editTransactionParams } from '@codebuff/common/tools/params/tool/edit-transaction'
import { buildReadFilesResultV1 } from '@codebuff/common/tools/results/filesystem'
import { getInitialSessionState } from '@codebuff/common/types/session-state'
import { getExactContentHash } from '@codebuff/common/util/content-hash'
import { describe, expect, it } from 'bun:test'

import { handleEditTransaction } from '../tools/handlers/tool/edit-transaction'
import { strictEditAuthorizationError } from '../tools/handlers/tool/edit-read-state'
import { handleReadFiles } from '../tools/handlers/tool/read-files'
import { handleReplaceRange } from '../tools/handlers/tool/replace-range'
import { handleStrReplace } from '../tools/handlers/tool/str-replace'
import {
  handleWriteFile,
  normalizeToolPath,
} from '../tools/handlers/tool/write-file'
import {
  encodeReadCapabilityToken,
  getContentHash,
} from '../process-str-replace'
import { processStream } from '../tools/stream-parser'
import { createMockStreamWithToolCalls, mockFileContext } from './test-utils'

import type { FileProcessingState } from '../tools/handlers/tool/write-file'
import type { CommitReceiptV1 } from '@codebuff/common/tools/results/filesystem'
import type {
  AgentRuntimeDeps,
  AgentRuntimeScopedDeps,
} from '@codebuff/common/types/contracts/agent-runtime'
import type { Logger } from '@codebuff/common/types/contracts/logger'
import type { AgentTemplate } from '../templates/types'

const logger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
}

const defaultTestAuthorityScope = {
  projectId: mockFileContext.projectRoot,
  runId: 'read-files-edit-state-test-run',
}

const defaultTestHandlerAuthority = {
  fileContext: mockFileContext,
  runId: defaultTestAuthorityScope.runId,
}

function createFileProcessingState(): FileProcessingState {
  return {
    promisesByPath: {},
    allPromises: [],
    fileChangeErrors: [],
    fileChanges: [],
    firstFileProcessed: false,
    failedEditRequiresReadByPath: {},
    consecutiveStrReplaceFailuresByPath: {},
  }
}

function buildWholeFileReadResultV1(
  filePaths: string[],
  getContent: (path: string) => string | null,
) {
  return buildReadFilesResultV1(
    filePaths.map((path, requestIndex) => {
      const content = getContent(path)
      return content === null
        ? {
            selector: 'file' as const,
            requestIndex,
            path,
            status: 'error' as const,
            error: {
              code: 'not_found' as const,
              message: '[FILE_DOES_NOT_EXIST]',
              retryable: true,
              recovery: 'discover_path' as const,
            },
          }
        : {
            selector: 'file' as const,
            requestIndex,
            path,
            status: 'ok' as const,
            content,
            complete: true,
            template: false,
          }
    }),
  )
}

function confirmedMutationOutput(
  toolCall: any,
  expectedContentByPath: Record<string, string>,
  scope: { projectId: string; runId: string } = defaultTestAuthorityScope,
) {
  const changes = Array.isArray(toolCall.input)
    ? toolCall.input
    : [toolCall.input]
  const operationId = toolCall.toolCallId
  const receiptId = `${operationId}-receipt`
  type SyntheticAction = {
    actionId: string
    index: number
    action: 'create' | 'update' | 'delete' | 'move'
    path: string
    destinationPath?: string
    beforeHash: string | null
  } & (
    | { afterHash: null }
    | {
        afterHash: string
        afterContent: string
        editAnchor: {
          startLine: number
          endLine: number
          contentHash: string
          readCapability: string
        }
      }
  )
  const actions: SyntheticAction[] = changes.map((change: any, index: number) => {
    const action =
      change.type === 'delete' || change.type === 'move'
        ? change.type
        : change.expectedHash === null
          ? 'create'
          : 'update'
    const finalPath = change.destinationPath ?? change.path
    const finalContent =
      action === 'delete' ? undefined : expectedContentByPath[finalPath]
    if (action !== 'delete' && finalContent === undefined) {
      throw new Error(`Missing expected post-edit content for ${finalPath}`)
    }
    const endLine = finalContent
      ?.replace(/\r\n?/g, '\n')
      .split('\n').length
    const editAnchor =
      finalContent === undefined
        ? undefined
        : {
            startLine: 1,
            endLine: endLine!,
            contentHash: getContentHash(finalContent),
            readCapability: encodeReadCapabilityToken({
              startLine: 1,
              endLine: endLine!,
              hash: getContentHash(finalContent),
              scope: {
                projectId: scope.projectId,
                path: finalPath,
                runId: scope.runId,
              },
            }),
          }
    return {
      actionId: `${operationId}:${index}`,
      index,
      action,
      path: change.path,
      ...(change.destinationPath
        ? { destinationPath: change.destinationPath }
        : {}),
      beforeHash: change.expectedHash ?? null,
      afterHash:
        action === 'delete' ? null : getExactContentHash(finalContent!),
      ...(finalContent === undefined
        ? {}
        : { afterContent: finalContent, editAnchor }),
    } as SyntheticAction
  })
  const receipt = {
    kind: 'commit_receipt' as const,
    version: 1 as const,
    receiptId,
    operationId,
    callId: operationId,
    authorityTier: 'portable_path' as const,
    status: 'committed' as const,
    actions: actions.map((action) => ({
      actionId: action.actionId,
      index: action.index,
      action: action.action,
      path: action.path,
      ...('destinationPath' in action
        ? { destinationPath: action.destinationPath }
        : {}),
      status: 'committed' as const,
      beforeHash: action.beforeHash,
      afterHash: action.afterHash,
    })),
    finalHashes: Object.fromEntries(
      actions.map((action) => [
        'destinationPath' in action ? action.destinationPath : action.path,
        action.afterHash,
      ]),
    ),
  }
  const canonicalProject = mockFileContext.projectRoot
    .replaceAll('\\', '/')
    .replace(/\/+$/, '')
  const freshCapabilities = actions.flatMap((action) => {
    if (action.afterHash === null || !('editAnchor' in action)) return []
    const finalPath = action.destinationPath ?? action.path
    return [
      {
        kind: 'whole_file' as const,
        version: 1 as const,
        token: action.editAnchor.readCapability,
        snapshot: {
          kind: 'file_snapshot' as const,
          version: 1 as const,
          canonicalPath: `${canonicalProject}/${finalPath
            .replaceAll('\\', '/')
            .replace(/^\.\//, '')}`,
          contentHash: action.afterHash,
          sizeBytes: Buffer.byteLength(action.afterContent),
          encoding: 'utf8' as const,
          readGeneration: Date.now(),
        },
      },
    ]
  })
  return [
    {
      type: 'json' as const,
      value: {
        kind: 'file_mutation_result',
        version: 1,
        operationId,
        outcome: 'applied',
        actions: actions.map((action) => ({
          ...action,
          outcome: 'applied' as const,
        })),
        authorityTier: 'portable_path',
        receiptId,
        authorityReceipt: receipt,
        errors: [],
        freshCapabilities,
      },
    },
  ]
}

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

  it('auto-reread authorizes a fresh-path str_replace exactly once per transaction', async () => {
    const path = 'src/auto-reread.ts'
    const diskContent = 'export const value = 1\n'
    const fileProcessingState = createFileProcessingState()
    fileProcessingState.strictReadBeforeEdit = true
    let optionalFileReads = 0
    let clientCalls = 0

    const result = await handleEditTransaction({ ...defaultTestHandlerAuthority,
      previousToolCallFinished: Promise.resolve(),
      toolCall: {
        toolCallId: 'auto-reread-transaction',
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
                  allowMultiple: false,
                },
              ],
            },
          ],
        },
      },
      fileProcessingState,
      logger,
      requestOptionalFile: async ({ filePath }: { filePath: string }) => {
        optionalFileReads += 1
        return filePath === path ? diskContent : null
      },
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

    // Snapshot loads the file exactly once; the auto-reread loop must not
    // perform a second fresh-path read for the same transaction.
    expect(optionalFileReads).toBe(1)
    expect(clientCalls).toBe(1)
    expect(result.output[0]?.type).toBe('json')
    if (result.output[0]?.type === 'json') {
      const value = result.output[0].value as { errorMessage?: string }
      expect(value.errorMessage ?? '').not.toContain(
        'strict read-before-edit',
      )
    }
    // Auto-reread is transaction-local: it must not mint durable sticky auth.
    expect(fileProcessingState.readAuthorizationsByPath?.[path]).toBeUndefined()
  })

  it('canonicalizes separators without accepting whitespace path aliases', () => {
    expect(normalizeToolPath('./src//value.ts')).toBe('src/value.ts')
    expect(normalizeToolPath('src\\value.ts')).toBe('src/value.ts')
    expect(normalizeToolPath(' src/value.ts')).toBe('')
    expect(normalizeToolPath('src/value.ts ')).toBe('')
    expect(normalizeToolPath('src/other.ts')).toBe('src/other.ts')
  })

  it('[PERF-L05] caps transaction snapshot reads at eight concurrent paths', async () => {
    const paths = Array.from(
      { length: 10 },
      (_, index) => `src/file-${index}.ts`,
    )
    const fileProcessingState = createFileProcessingState()
    let releaseSnapshots!: () => void
    const snapshotGate = new Promise<void>((resolve) => {
      releaseSnapshots = resolve
    })
    let active = 0
    let maxActive = 0
    let started = 0

    const transactionPromise = handleEditTransaction({ ...defaultTestHandlerAuthority,
      previousToolCallFinished: Promise.resolve(),
      toolCall: {
        toolCallId: 'bounded-snapshots',
        toolName: 'edit_transaction',
        input: {
          edits: paths.map((path) => ({
            type: 'str_replace' as const,
            path,
            replacements: [
              {
                oldString: 'export const value = 1',
                newString: 'export const value = 2',
                allowMultiple: false,
              },
            ],
          })),
        },
      },
      fileProcessingState,
      logger,
      requestOptionalFile: async () => {
        started += 1
        active += 1
        maxActive = Math.max(maxActive, active)
        await snapshotGate
        active -= 1
        return 'export const value = 1\n'
      },
      requestClientToolCall: async () => [
        {
          type: 'json' as const,
          value: { message: 'applied transaction batch', files: [] },
        },
      ],
    } as any)

    // TRANSACTION_SNAPSHOT_CONCURRENCY is 8 (internal to edit-transaction.ts).
    // Bounded wait: fail fast with a diagnosable message instead of spinning
    // forever if concurrency ever regresses below 8.
    const deadline = Date.now() + 5000
    while (started < 8 && Date.now() < deadline) await Promise.resolve()
    expect(started).toBe(8)
    expect(maxActive).toBe(8)
    releaseSnapshots()

    await transactionPromise
    expect(started).toBe(10)
    expect(maxActive).toBe(8)
  })

  it('normalizes leading dot-slash paths before rendering read results', async () => {
    const path = 'scripts/check-tool-registration.ts'
    const diskContent = '#!/usr/bin/env bun\n'
    const fileProcessingState = createFileProcessingState()
    fileProcessingState.failedEditRequiresReadByPath[path] = true
    fileProcessingState.promisesByPath[path] = [
      Promise.resolve({
        tool: 'write_file' as const,
        path,
        toolCallId: 'stale-write',
        content: diskContent,
        messages: [],
      }),
    ]

    const result = await handleReadFiles({ ...defaultTestHandlerAuthority,
      previousToolCallFinished: Promise.resolve(),
      toolCall: {
        toolCallId: 'read-dot-slash',
        toolName: 'read_files',
        input: {
          paths: [`./${path}`],
        },
      },
      fileContext: mockFileContext,
      fileProcessingState,
      requestFiles: async ({ filePaths }: { filePaths: string[] }) =>
        buildWholeFileReadResultV1(filePaths, (filePath) =>
          filePath === path ? diskContent : null,
        ),
      logger,
    } as any)

    expect(
      fileProcessingState.failedEditRequiresReadByPath[path],
    ).toBeUndefined()
    expect(fileProcessingState.promisesByPath[path]).toBeUndefined()

    expect(result.output[0]?.type).toBe('json')
    if (result.output[0]?.type === 'json') {
      const value = result.output[0].value as any
      expect(value.summary).toEqual({
        ok: 1,
        partial: 0,
        failed: 0,
        requested: 1,
        uniquePaths: 1,
      })
      // Empty referencedBy is omitted from the rendered file entry now (M7c).
      // The file content carries the M4 "changed since last read" prefix
      // because there was a stale promisesByPath entry simulating a prior edit.
      expect(value.results[0]).toMatchObject({ path, selector: 'file' })
      expect(value.results[0].editAnchor).toMatchObject({
        startLine: 1,
        contentHash: getContentHash(diskContent),
        readCapability: expect.stringMatching(/^cap\.v3\./),
      })
      expect(value.results[0].readCapability).toBeUndefined()
      const duplicated = {
        ...value.results[0],
        readCapability: value.results[0].editAnchor.readCapability,
      }
      expect(JSON.stringify(value.results[0]).length).toBeLessThan(
        JSON.stringify(duplicated).length,
      )
      expect(value.results[0].referencedBy).toBeUndefined()
      expect(value.results[0].content).toContain('changed since last read')
      expect(value.results[0].content).toContain(diskContent)
    }
  })

  it('logs reuse-eligible telemetry for an immediate confirmed post-edit reread', async () => {
    const path = 'src/confirmed.ts'
    const diskContent = 'export const value = 2\n'
    const contentHash = getContentHash(diskContent)
    const debugCalls: unknown[][] = []
    const telemetryLogger = {
      ...logger,
      debug: (...args: unknown[]) => debugCalls.push(args),
    } as Logger
    const fileProcessingState = createFileProcessingState()
    fileProcessingState.strictReadBeforeEdit = true
    fileProcessingState.readAuthorizationsByPath = { [path]: true }
    fileProcessingState.readAuthorizationHashesByPath = { [path]: contentHash }
    fileProcessingState.confirmedPostEditAnchorsByPath = {
      [path]: {
        startLine: 1,
        endLine: 2,
        contentHash,
        readCapability: 'redacted-test-capability',
      },
    }
    fileProcessingState.promisesByPath[path] = []

    await handleReadFiles({ ...defaultTestHandlerAuthority,
      previousToolCallFinished: Promise.resolve(),
      toolCall: {
        toolCallId: 'redundant-confirmed-reread',
        toolName: 'read_files',
        input: { paths: [path] },
      },
      fileContext: mockFileContext,
      fileProcessingState,
      requestFiles: async ({ filePaths }: { filePaths: string[] }) =>
        buildWholeFileReadResultV1(filePaths, () => diskContent),
      logger: telemetryLogger,
    } as any)

    expect(debugCalls).toContainEqual([
      {
        path,
        reason: 'immediate_post_edit_reread',
        category: 'reuse_eligible',
      },
      expect.any(String),
    ])
    expect(fileProcessingState.confirmedPostEditAnchorsByPath[path]).toBeUndefined()
  })

  it('does not clear failed-edit gate or grant authorization when read_files cannot load the file', async () => {
    const path = 'src/missing.ts'
    const fileProcessingState = createFileProcessingState()
    fileProcessingState.strictReadBeforeEdit = true
    fileProcessingState.failedEditRequiresReadByPath[path] = true
    fileProcessingState.promisesByPath[path] = [
      Promise.resolve({
        tool: 'str_replace' as const,
        path,
        toolCallId: 'failed-edit',
        error: 'previous failed edit',
      }),
    ]

    const result = await handleReadFiles({ ...defaultTestHandlerAuthority,
      previousToolCallFinished: Promise.resolve(),
      toolCall: {
        toolCallId: 'read-missing-file',
        toolName: 'read_files',
        input: { paths: [path] },
      },
      fileContext: mockFileContext,
      fileProcessingState,
      requestFiles: async ({ filePaths }: { filePaths: string[] }) =>
        buildWholeFileReadResultV1(filePaths, () => null),
      logger,
    } as any)

    expect(result.output[0]?.type).toBe('json')
    expect(fileProcessingState.failedEditRequiresReadByPath[path]).toBe(true)
    expect(fileProcessingState.promisesByPath[path]).toHaveLength(1)
    expect(fileProcessingState.readAuthorizationsByPath?.[path]).toBeUndefined()
  })

  it('does not treat an SDK file-read failure marker as a successful read', async () => {
    const path = 'src/blocked.ts'
    const fileProcessingState = createFileProcessingState()
    fileProcessingState.strictReadBeforeEdit = true
    fileProcessingState.failedEditRequiresReadByPath[path] = true
    fileProcessingState.promisesByPath[path] = [
      Promise.resolve({
        tool: 'str_replace' as const,
        path,
        toolCallId: 'failed-edit',
        error: 'previous failed edit',
      }),
    ]

    const result = await handleReadFiles({ ...defaultTestHandlerAuthority,
      previousToolCallFinished: Promise.resolve(),
      toolCall: {
        toolCallId: 'read-blocked-file',
        toolName: 'read_files',
        input: { paths: [path] },
      },
      fileContext: mockFileContext,
      fileProcessingState,
      requestFiles: async () =>
        buildReadFilesResultV1([
          {
            selector: 'file',
            requestIndex: 0,
            path,
            status: 'error',
            error: {
              code: 'blocked',
              message: '[FILE_IGNORED]',
              retryable: false,
            },
          },
        ]),
      logger,
    } as any)

    expect(fileProcessingState.failedEditRequiresReadByPath[path]).toBe(true)
    expect(fileProcessingState.promisesByPath[path]).toHaveLength(1)
    expect(fileProcessingState.readAuthorizationsByPath?.[path]).toBeUndefined()
    expect(result.output[0]?.type).toBe('json')
    if (result.output[0]?.type === 'json') {
      const value = result.output[0].value as any
      expect(value.summary).toEqual({
        ok: 0,
        partial: 0,
        failed: 1,
        requested: 1,
        uniquePaths: 1,
      })
      expect(value.results[0]).toMatchObject({
        path,
        status: 'error',
        error: { code: 'blocked' },
      })
    }
  })

  it('symbol-only read clears the failed-edit gate without granting whole-file authorization', async () => {
    const path = 'src/symbols.ts'
    const diskContent = 'export function target() {\n  return 1\n}\n'
    const fileProcessingState = createFileProcessingState()
    fileProcessingState.strictReadBeforeEdit = true
    fileProcessingState.failedEditRequiresReadByPath[path] = true
    fileProcessingState.promisesByPath[path] = [
      Promise.resolve({
        tool: 'str_replace' as const,
        path,
        toolCallId: 'failed-edit',
        error: 'previous failed edit',
      }),
    ]

    const result = await handleReadFiles({ ...defaultTestHandlerAuthority,
      previousToolCallFinished: Promise.resolve(),
      toolCall: {
        toolCallId: 'read-symbol-only',
        toolName: 'read_files',
        input: { symbols: [{ path, names: ['target'] }] },
      },
      fileContext: mockFileContext,
      fileProcessingState,
      requestFiles: async ({ filePaths }: { filePaths: string[] }) =>
        buildWholeFileReadResultV1(filePaths, () => null),
      requestOptionalFile: async ({ filePath }: { filePath: string }) =>
        filePath === path ? diskContent : null,
      logger,
    } as any)

    expect(result.output[0]?.type).toBe('json')
    if (result.output[0]?.type === 'json') {
      expect(result.output[0].value).toMatchObject({
        results: [expect.objectContaining({ selector: 'symbols', path })],
      })
    }
    expect(
      fileProcessingState.failedEditRequiresReadByPath[path],
    ).toBeUndefined()
    expect(fileProcessingState.promisesByPath[path]).toBeUndefined()
    expect(fileProcessingState.readAuthorizationsByPath?.[path]).toBeUndefined()
  })

  it('does not authorize a file when a symbol-only read finds no requested symbol', async () => {
    const path = 'src/symbols.ts'
    const diskContent = 'export function other() {\n  return 1\n}\n'
    const fileProcessingState = createFileProcessingState()
    fileProcessingState.strictReadBeforeEdit = true
    fileProcessingState.failedEditRequiresReadByPath[path] = true

    const result = await handleReadFiles({ ...defaultTestHandlerAuthority,
      previousToolCallFinished: Promise.resolve(),
      toolCall: {
        toolCallId: 'read-missing-symbol',
        toolName: 'read_files',
        input: { symbols: [{ path, names: ['target'] }] },
      },
      fileContext: mockFileContext,
      fileProcessingState,
      requestFiles: async () => buildReadFilesResultV1([]),
      requestOptionalFile: async () => diskContent,
      logger,
    } as any)

    expect(fileProcessingState.failedEditRequiresReadByPath[path]).toBe(true)
    expect(fileProcessingState.readAuthorizationsByPath?.[path]).toBeUndefined()
    expect(result.output[0]?.type).toBe('json')
    if (result.output[0]?.type === 'json') {
      const value = result.output[0].value as any
      expect(value.results).toContainEqual(
        expect.objectContaining({
          path,
          selector: 'symbols',
          status: 'error',
          error: expect.objectContaining({
            code: 'no_match',
            message: expect.stringContaining(
              'None of the requested symbols were found',
            ),
          }),
        }),
      )
      expect(value.summary).toEqual({
        requested: 1,
        ok: 0,
        partial: 0,
        failed: 1,
        uniquePaths: 1,
      })
    }
  })

  it('does not grant whole-file authorization from a canonical truncated read', async () => {
    const path = 'src/large.ts'
    const fileProcessingState = createFileProcessingState()
    fileProcessingState.strictReadBeforeEdit = true

    const result = await handleReadFiles({ ...defaultTestHandlerAuthority,
      previousToolCallFinished: Promise.resolve(),
      toolCall: {
        toolCallId: 'read-truncated-canonical',
        toolName: 'read_files',
        input: { paths: [path] },
      },
      fileContext: mockFileContext,
      fileProcessingState,
      requestFiles: async () =>
        buildReadFilesResultV1([
          {
            selector: 'file',
            requestIndex: 0,
            path,
            status: 'partial',
            content: 'visible excerpt',
            complete: false,
            template: false,
            truncation: { reason: 'character_limit' },
          },
        ]),
      logger,
    } as any)

    expect(result.output[0]?.type).toBe('json')
    expect(fileProcessingState.readAuthorizationsByPath?.[path]).toBeUndefined()
    expect(
      fileProcessingState.readAuthorizationHashesByPath?.[path],
    ).toBeUndefined()
  })

  it('rejects a canonical result whose selector path does not match the request', async () => {
    const requestedPath = 'src/requested.ts'
    const fileProcessingState = createFileProcessingState()
    fileProcessingState.strictReadBeforeEdit = true

    const result = await handleReadFiles({ ...defaultTestHandlerAuthority,
      previousToolCallFinished: Promise.resolve(),
      toolCall: {
        toolCallId: 'read-mismatched-canonical',
        toolName: 'read_files',
        input: { paths: [requestedPath] },
      },
      fileContext: mockFileContext,
      fileProcessingState,
      requestFiles: async () =>
        buildReadFilesResultV1([
          {
            selector: 'file',
            requestIndex: 0,
            path: 'src/unrequested.ts',
            status: 'ok',
            content: 'secret',
            complete: true,
            template: false,
          },
        ]),
      logger,
    } as any)

    expect(fileProcessingState.readAuthorizationsByPath).toBeUndefined()
    expect(result.output[0]?.type).toBe('json')
    if (result.output[0]?.type === 'json') {
      expect(result.output[0].value).toMatchObject({
        status: 'error',
        results: [
          {
            path: requestedPath,
            status: 'error',
            error: { code: 'invalid_request' },
          },
        ],
      })
    }
  })

  it('does not turn a proper-subset range read into whole-file authorization', async () => {
    const path = 'src/ranged.ts'
    const sourceContent = 'line 1'
    const rangeHash = getContentHash(sourceContent)
    const fileProcessingState = createFileProcessingState()
    fileProcessingState.strictReadBeforeEdit = true

    const result = await handleReadFiles({ ...defaultTestHandlerAuthority,
      previousToolCallFinished: Promise.resolve(),
      toolCall: {
        toolCallId: 'read-range-only',
        toolName: 'read_files',
        // Proper subset: lines 1..1 of a 2-line file — must stay scoped-only.
        input: { ranges: [{ path, startLine: 1, endLine: 1 }] },
      },
      fileContext: mockFileContext,
      fileProcessingState,
      requestFiles: async () =>
        buildReadFilesResultV1([
          {
            selector: 'range',
            requestIndex: 0,
            path,
            status: 'ok',
            content: '1\tline 1',
            sourceContent,
            startLine: 1,
            endLine: 1,
            totalLines: 2,
            complete: true,
            editAnchor: {
              startLine: 1,
              endLine: 1,
              contentHash: rangeHash,
              readCapability: 'cap.v3.test',
            },
          },
        ]),
      logger,
    } as any)

    expect(fileProcessingState.readAuthorizationsByPath?.[path]).toBeUndefined()
    expect(result.output[0]?.type).toBe('json')
    if (result.output[0]?.type === 'json') {
      const value = result.output[0].value as any
      expect(value.results[0].content).not.toContain('[RANGE_BLOCK')
      expect(value.results[0].editAnchor).toMatchObject({
        startLine: 1,
        endLine: 1,
        contentHash: rangeHash,
        readCapability: expect.stringMatching(/^cap\.v3\./),
      })
      expect(value.results[0].rangeHash).toBeUndefined()
      expect(value.results[0].readCapability).toBeUndefined()
    }
  })

  it('promotes a complete full-file range read (1..totalLines) to sticky whole-file auth', async () => {
    const path = 'src/full-range.ts'
    const sourceContent = 'line 1\nline 2'
    const rangeHash = getContentHash(sourceContent)
    const fileProcessingState = createFileProcessingState()
    fileProcessingState.strictReadBeforeEdit = true

    await handleReadFiles({ ...defaultTestHandlerAuthority,
      previousToolCallFinished: Promise.resolve(),
      toolCall: {
        toolCallId: 'read-full-file-range',
        toolName: 'read_files',
        input: { ranges: [{ path, startLine: 1, endLine: 2 }] },
      },
      fileContext: mockFileContext,
      fileProcessingState,
      requestFiles: async () =>
        buildReadFilesResultV1([
          {
            selector: 'range',
            requestIndex: 0,
            path,
            status: 'ok',
            content: '1\tline 1\n2\tline 2',
            sourceContent,
            startLine: 1,
            endLine: 2,
            totalLines: 2,
            complete: true,
            editAnchor: {
              startLine: 1,
              endLine: 2,
              contentHash: rangeHash,
              readCapability: 'cap.v3.test',
            },
          },
        ]),
      logger,
    } as any)

    expect(fileProcessingState.readAuthorizationsByPath?.[path]).toBe(true)
    expect(fileProcessingState.readAuthorizationHashesByPath?.[path]).toBe(
      getContentHash(sourceContent),
    )
  })

  it('rejects str_replace when the client returns no application result', async () => {
    const path = 'src/helper.ts'
    const diskContent = 'export const value = 1\n'
    const fileProcessingState = createFileProcessingState()
    const appliedPatches: string[] = []

    const result = await handleStrReplace({ ...defaultTestHandlerAuthority,
      previousToolCallFinished: Promise.resolve(),
      toolCall: {
        toolCallId: 'empty-client-result-replace',
        toolName: 'str_replace',
        input: {
          path,
          replacements: [
            {
              oldString: 'export const value = 1',
              newString: 'export const value = 2',
              allowMultiple: false,
            },
          ],
        },
      },
      fileProcessingState,
      logger,
      requestOptionalFile: async ({ filePath }: { filePath: string }) =>
        filePath === path ? diskContent : null,
      requestClientToolCall: async (toolCall: any) => {
        appliedPatches.push(toolCall.input.content)
        return []
      },
      writeToClient: () => {},
    } as any)

    expect(appliedPatches).toHaveLength(1)
    expect(result.output[0]?.type).toBe('json')
    if (result.output[0]?.type === 'json') {
      const value = result.output[0].value as {
        file?: string
        errorMessage?: string
      }
      expect(value.file).toBe(path)
      expect(value.errorMessage).toContain('could not confirm')
    }
    expect(fileProcessingState.failedEditRequiresReadByPath[path]).toBe(true)
    expect(fileProcessingState.promisesByPath[path]).toBeUndefined()
  })

  it('preserves authorization when the client explicitly rejects str_replace without applying', async () => {
    const path = 'src/rejected.ts'
    const diskContent = 'export const value = 1\n'
    const fileProcessingState = createFileProcessingState()
    fileProcessingState.strictReadBeforeEdit = true
    fileProcessingState.readAuthorizationsByPath = { [path]: true }
    fileProcessingState.readAuthorizationHashesByPath = {
      [path]: getContentHash(diskContent),
    }

    const result = await handleStrReplace({ ...defaultTestHandlerAuthority,
      previousToolCallFinished: Promise.resolve(),
      toolCall: {
        toolCallId: 'rejected-client-replace',
        toolName: 'str_replace',
        input: {
          path,
          replacements: [
            {
              oldString: 'export const value = 1',
              newString: 'export const value = 2',
              allowMultiple: false,
            },
          ],
        },
      },
      fileProcessingState,
      logger,
      requestOptionalFile: async () => diskContent,
      requestClientToolCall: async () => [
        {
          type: 'json' as const,
          value: { file: path, errorMessage: 'client rejected patch' },
        },
      ],
      writeToClient: () => {},
    } as any)

    expect(result.output[0]?.type).toBe('json')
    if (result.output[0]?.type === 'json') {
      expect(result.output[0].value).toMatchObject({
        file: path,
        errorMessage: 'client rejected patch',
      })
    }
    expect(
      fileProcessingState.failedEditRequiresReadByPath[path],
    ).toBeUndefined()
    expect(fileProcessingState.promisesByPath[path]).toBeUndefined()
    expect(fileProcessingState.readAuthorizationsByPath?.[path]).toBe(true)
  })

  it('[ABI-M05] sends exact whole-file bytes and rejects an unconfirmed client result', async () => {
    const path = 'notes/exact-write.txt'
    const diskContent = 'old\n'
    const newContent = '\n```text\r\nfirst\nsecond\r\n```'
    const fileProcessingState = createFileProcessingState()
    const clientInputs: Array<{
      type: string
      path: string
      content: string
      expectedHash?: string | null
    }> = []

    const result = await handleWriteFile({ ...defaultTestHandlerAuthority,
      previousToolCallFinished: Promise.resolve(),
      toolCall: {
        toolCallId: 'empty-client-result-write',
        toolName: 'write_file',
        input: {
          path,
          content: newContent,
        },
      },
      agentState: { messageHistory: [] },
      clientSessionId: 'test-session',
      fileProcessingState,
      fingerprintId: 'test-fingerprint',
      logger,
      prompt: undefined,
      userId: undefined,
      userInputId: 'test-input',
      requestOptionalFile: async ({ filePath }: { filePath: string }) =>
        filePath === path ? diskContent : null,
      requestClientToolCall: async (toolCall: any) => {
        clientInputs.push(toolCall.input)
        return []
      },
      writeToClient: () => {},
    } as any)

    expect(clientInputs).toEqual([
      {
        type: 'file',
        path,
        content: newContent,
        expectedHash: getContentHash(diskContent),
      },
    ])
    expect(result.output[0]?.type).toBe('json')
    if (result.output[0]?.type === 'json') {
      const value = result.output[0].value as {
        file?: string
        errorMessage?: string
      }
      expect(value.file).toBe(path)
      expect(value.errorMessage).toContain('could not confirm')
    }
    expect(fileProcessingState.failedEditRequiresReadByPath[path]).toBe(true)
    expect(fileProcessingState.promisesByPath[path]).toBeUndefined()
  })

  it('preserves existing write authorization when the client explicitly rejects write_file', async () => {
    const path = 'src/rejected-write.ts'
    const diskContent = 'export const value = 1\n'
    const fileProcessingState = createFileProcessingState()
    fileProcessingState.strictReadBeforeEdit = true
    fileProcessingState.readAuthorizationsByPath = { [path]: true }
    fileProcessingState.readAuthorizationHashesByPath = {
      [path]: getContentHash(diskContent),
    }

    const result = await handleWriteFile({ ...defaultTestHandlerAuthority,
      previousToolCallFinished: Promise.resolve(),
      toolCall: {
        toolCallId: 'rejected-client-write',
        toolName: 'write_file',
        input: {
          path,
          content: 'export const value = 2\n',
        },
      },
      agentState: { messageHistory: [] },
      clientSessionId: 'test-session',
      fileProcessingState,
      fingerprintId: 'test-fingerprint',
      logger,
      prompt: undefined,
      userId: undefined,
      userInputId: 'test-input',
      requestOptionalFile: async () => diskContent,
      requestClientToolCall: async () => [
        {
          type: 'json' as const,
          value: { file: path, errorMessage: 'client rejected write' },
        },
      ],
      writeToClient: () => {},
    } as any)

    expect(result.output[0]?.type).toBe('json')
    if (result.output[0]?.type === 'json') {
      expect(result.output[0].value).toMatchObject({
        file: path,
        errorMessage: 'client rejected write',
      })
    }
    expect(
      fileProcessingState.failedEditRequiresReadByPath[path],
    ).toBeUndefined()
    expect(fileProcessingState.promisesByPath[path]).toBeUndefined()
    expect(fileProcessingState.readAuthorizationsByPath?.[path]).toBe(true)
    expect(fileProcessingState.readAuthorizationHashesByPath?.[path]).toBe(
      getContentHash(diskContent),
    )
  })

  it('detects a late explicit write_file rejection and preserves authorization', async () => {
    const path = 'src/rejected-late-write.ts'
    const fileProcessingState = createFileProcessingState()
    fileProcessingState.strictReadBeforeEdit = true
    fileProcessingState.readAuthorizationsByPath = { [path]: true }

    const result = await handleWriteFile({ ...defaultTestHandlerAuthority,
      previousToolCallFinished: Promise.resolve(),
      toolCall: {
        toolCallId: 'late-client-error-write',
        toolName: 'write_file',
        input: { path, content: 'export const value = 2\n' },
      },
      agentState: { messageHistory: [] },
      clientSessionId: 'test-session',
      fileProcessingState,
      fingerprintId: 'test-fingerprint',
      logger,
      prompt: undefined,
      userId: undefined,
      userInputId: 'test-input',
      requestOptionalFile: async () => null,
      requestClientToolCall: async () => [
        {
          type: 'json' as const,
          value: { file: path, message: 'prepared' },
        },
        {
          type: 'json' as const,
          value: { file: path, errorMessage: 'late client rejection' },
        },
      ],
      writeToClient: () => {},
    } as any)

    expect(result.output).toHaveLength(2)
    expect(
      fileProcessingState.failedEditRequiresReadByPath[path],
    ).toBeUndefined()
    expect(fileProcessingState.promisesByPath[path]).toBeUndefined()
    expect(fileProcessingState.readAuthorizationsByPath?.[path]).toBe(true)
  })

  it('registers write_file processing before waiting for previous tool completion', async () => {
    const path = 'packages/agent-runtime/src/util/render-read-files-result.ts'
    const diskContent = 'export const value = 1\n'
    const newContent = 'export const value = 2\n'
    const fileProcessingState = createFileProcessingState()
    const appliedPatches: string[] = []
    let optionalFileReadCount = 0
    let releasePreviousTool!: () => void
    const previousToolCallFinished = new Promise<void>((resolve) => {
      releasePreviousTool = resolve
    })

    const resultPromise = handleWriteFile({ ...defaultTestHandlerAuthority,
      previousToolCallFinished,
      toolCall: {
        toolCallId: 'queued-write-before-previous-finished',
        toolName: 'write_file',
        input: {
          path,
          content: newContent,
        },
      },
      agentState: { messageHistory: [] },
      clientSessionId: 'test-session',
      fileProcessingState,
      fingerprintId: 'test-fingerprint',
      logger,
      prompt: undefined,
      userId: undefined,
      userInputId: 'test-input',
      requestOptionalFile: async ({ filePath }: { filePath: string }) => {
        optionalFileReadCount += 1
        return filePath === path ? diskContent : null
      },
      requestClientToolCall: async (toolCall: any) => {
        appliedPatches.push(toolCall.input.content)
        return [
          {
            type: 'json' as const,
            value: { file: path, message: 'write confirmed' },
          },
        ]
      },
      writeToClient: () => {},
    } as any)

    expect(fileProcessingState.allPromises).toHaveLength(1)
    expect(fileProcessingState.promisesByPath[path]).toHaveLength(1)
    expect(appliedPatches).toHaveLength(0)
    expect(optionalFileReadCount).toBe(0)

    releasePreviousTool()
    const result = await resultPromise

    expect(appliedPatches).toHaveLength(1)
    expect(optionalFileReadCount).toBe(1)
    expect(result.output[0]?.type).toBe('json')
    if (result.output[0]?.type === 'json') {
      const value = result.output[0].value as {
        file?: string
        message?: string
      }
      expect(value.file).toBe(path)
      expect(value.message).toBe('write confirmed')
    }
  })

  it('does not deadlock when two same-path write_file calls are queued before the first finishes', async () => {
    const path = 'packages/agent-runtime/src/util/render-read-files-result.ts'
    const diskContent = 'export const value = 1\n'
    const firstContent = 'export const value = 2\n'
    const secondContent = 'export const value = 3\n'
    const fileProcessingState = createFileProcessingState()
    const appliedPatches: string[] = []
    let optionalFileReadCount = 0

    const firstResultPromise = handleWriteFile({ ...defaultTestHandlerAuthority,
      previousToolCallFinished: Promise.resolve(),
      toolCall: {
        toolCallId: 'same-path-first-write',
        toolName: 'write_file',
        input: {
          path,
          content: firstContent,
        },
      },
      agentState: { messageHistory: [] },
      clientSessionId: 'test-session',
      fileProcessingState,
      fingerprintId: 'test-fingerprint',
      logger,
      prompt: undefined,
      userId: undefined,
      userInputId: 'test-input',
      requestOptionalFile: async ({ filePath }: { filePath: string }) => {
        optionalFileReadCount += 1
        return filePath === path ? diskContent : null
      },
      requestClientToolCall: async (toolCall: any) => {
        appliedPatches.push(toolCall.input.content)
        return [
          {
            type: 'json' as const,
            value: { file: path, message: 'first write confirmed' },
          },
        ]
      },
      writeToClient: () => {},
    } as any)

    const secondResultPromise = handleWriteFile({ ...defaultTestHandlerAuthority,
      previousToolCallFinished: firstResultPromise.then(() => {}),
      toolCall: {
        toolCallId: 'same-path-second-write',
        toolName: 'write_file',
        input: {
          path,
          content: secondContent,
        },
      },
      agentState: { messageHistory: [] },
      clientSessionId: 'test-session',
      fileProcessingState,
      fingerprintId: 'test-fingerprint',
      logger,
      prompt: undefined,
      userId: undefined,
      userInputId: 'test-input',
      requestOptionalFile: async () => {
        optionalFileReadCount += 1
        throw new Error(
          'second same-path write_file must reuse prior edit content',
        )
      },
      requestClientToolCall: async (toolCall: any) => {
        appliedPatches.push(toolCall.input.content)
        return [
          {
            type: 'json' as const,
            value: { file: path, message: 'second write confirmed' },
          },
        ]
      },
      writeToClient: () => {},
    } as any)

    expect(fileProcessingState.allPromises).toHaveLength(2)
    expect(fileProcessingState.promisesByPath[path]).toHaveLength(2)

    const timeout = new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error('same-path write_file deadlocked')),
        100,
      ),
    )
    const [firstResult, secondResult] = await Promise.race([
      Promise.all([firstResultPromise, secondResultPromise]),
      timeout,
    ])

    expect(optionalFileReadCount).toBe(1)
    expect(appliedPatches).toHaveLength(2)
    expect(firstResult.output[0]?.type).toBe('json')
    expect(secondResult.output[0]?.type).toBe('json')
    if (firstResult.output[0]?.type === 'json') {
      expect(firstResult.output[0].value).toMatchObject({ file: path })
    }
    if (secondResult.output[0]?.type === 'json') {
      expect(secondResult.output[0].value).toMatchObject({ file: path })
    }
  })

  it('chains edit_transaction from prior same-step str_replace in-memory content', async () => {
    const path = 'src/helper.ts'
    const diskContent = 'export const value = 1\nexport const other = 1\n'
    const fileProcessingState = createFileProcessingState()
    const appliedPatches: string[] = []

    const strReplaceResult = await handleStrReplace({ ...defaultTestHandlerAuthority,
      previousToolCallFinished: Promise.resolve(),
      toolCall: {
        toolCallId: 'replace-before-transaction',
        toolName: 'str_replace',
        input: {
          path,
          replacements: [
            {
              oldString: 'export const value = 1',
              newString: 'export const value = 2',
              allowMultiple: false,
            },
          ],
        },
      },
      fileProcessingState,
      logger,
      requestOptionalFile: async ({ filePath }: { filePath: string }) =>
        filePath === path ? diskContent : null,
      requestClientToolCall: async (toolCall: any) => {
        appliedPatches.push(toolCall.input.content)
        return confirmedMutationOutput(toolCall, {
          [path]: 'export const value = 2\nexport const other = 1\n',
        })
      },
      writeToClient: () => {},
    } as any)

    expect(strReplaceResult.output[0]?.type).toBe('json')

    const transactionResult = await handleEditTransaction({ ...defaultTestHandlerAuthority,
      previousToolCallFinished: Promise.resolve(),
      toolCall: {
        toolCallId: 'transaction-after-replace',
        toolName: 'edit_transaction',
        input: {
          edits: [
            {
              id: 'update-value-again',
              type: 'str_replace',
              path,
              replacements: [
                {
                  oldString: 'export const value = 2',
                  newString: 'export const value = 3',
                  allowMultiple: false,
                },
              ],
            },
          ],
        },
      },
      fileProcessingState,
      logger,
      requestOptionalFile: async ({ filePath }: { filePath: string }) =>
        filePath === path ? diskContent : null,
      requestClientToolCall: async (toolCall: any) => {
        appliedPatches.push(toolCall.input[0].content)
        return confirmedMutationOutput(toolCall, {
          [path]: 'export const value = 3\nexport const other = 1\n',
        })
      },
    } as any)

    const output = transactionResult.output[0]
    expect(output.type).toBe('json')
    if (output.type === 'json') {
      expect(output.value).not.toHaveProperty('errorMessage')
      expect(appliedPatches[0]).toContain('+export const value = 2')
      expect(appliedPatches[1]).toContain('-export const value = 2')
      expect(appliedPatches[1]).toContain('+export const value = 3')
    }
  })

  it('chains later str_replace calls from edit_transaction in-memory content', async () => {
    const path = 'src/helper.ts'
    const diskContent = 'export const value = 1\nexport const other = 1\n'
    const fileProcessingState = createFileProcessingState()
    const appliedPatches: string[] = []

    const transactionResult = await handleEditTransaction({ ...defaultTestHandlerAuthority,
      previousToolCallFinished: Promise.resolve(),
      toolCall: {
        toolCallId: 'transaction-1',
        toolName: 'edit_transaction',
        input: {
          edits: [
            {
              id: 'update-value',
              type: 'str_replace',
              path,
              replacements: [
                {
                  oldString: 'export const value = 1',
                  newString: 'export const value = 2',
                  allowMultiple: false,
                },
              ],
            },
          ],
        },
      },
      fileProcessingState,
      logger,
      requestOptionalFile: async ({ filePath }: { filePath: string }) =>
        filePath === path ? diskContent : null,
      requestClientToolCall: async (toolCall: any) => {
        appliedPatches.push(toolCall.input[0].content)
        return confirmedMutationOutput(toolCall, {
          [path]: 'export const value = 2\nexport const other = 1\n',
        })
      },
    } as any)

    expect(transactionResult.output[0]?.type).toBe('json')
    expect(fileProcessingState.promisesByPath[path]).toHaveLength(1)

    const strReplaceResult = await handleStrReplace({ ...defaultTestHandlerAuthority,
      previousToolCallFinished: Promise.resolve(),
      toolCall: {
        toolCallId: 'replace-after-transaction',
        toolName: 'str_replace',
        input: {
          path,
          replacements: [
            {
              oldString: 'export const value = 2',
              newString: 'export const value = 3',
              allowMultiple: false,
            },
          ],
        },
      },
      fileProcessingState,
      logger,
      requestOptionalFile: async ({ filePath }: { filePath: string }) =>
        filePath === path ? diskContent : null,
      requestClientToolCall: async (toolCall: any) => {
        appliedPatches.push(toolCall.input.content)
        return [
          {
            type: 'json' as const,
            value: {
              file: toolCall.input.path,
              message: 'applied str_replace patch',
            },
          },
        ]
      },
      writeToClient: () => {},
    } as any)

    const output = strReplaceResult.output[0]
    expect(output.type).toBe('json')
    if (output.type === 'json') {
      expect(output.value).not.toHaveProperty('errorMessage')
      expect(appliedPatches[0]).toContain('+export const value = 2')
      expect(appliedPatches[1]).toContain('-export const value = 2')
      expect(appliedPatches[1]).toContain('+export const value = 3')
    }
  })

  it('preserves valid read authorization after edit_transaction preflight fails', async () => {
    const path = 'src/helper.ts'
    const diskContent = 'export const value = 1\n'
    const fileProcessingState = createFileProcessingState()
    fileProcessingState.strictReadBeforeEdit = true
    fileProcessingState.readAuthorizationsByPath = { [path]: true }
    fileProcessingState.readAuthorizationHashesByPath = {
      [path]: getContentHash(diskContent),
    }

    const transactionResult = await handleEditTransaction({ ...defaultTestHandlerAuthority,
      previousToolCallFinished: Promise.resolve(),
      toolCall: {
        toolCallId: 'transaction-preflight-failed',
        toolName: 'edit_transaction',
        input: {
          edits: [
            {
              type: 'str_replace',
              path,
              replacements: [
                {
                  oldString: 'export const missing = 1',
                  newString: 'export const missing = 2',
                  allowMultiple: false,
                },
              ],
            },
          ],
        },
      },
      fileProcessingState,
      logger,
      requestOptionalFile: async ({ filePath }: { filePath: string }) =>
        filePath === path ? diskContent : null,
      requestClientToolCall: async () => {
        throw new Error('should not apply failed preflight')
      },
    } as any)

    const output = transactionResult.output[0]
    expect(output.type).toBe('json')
    if (output.type === 'json') {
      expect(output.value).toHaveProperty('errorMessage')
    }
    expect(
      fileProcessingState.failedEditRequiresReadByPath[path],
    ).toBeUndefined()
    expect(fileProcessingState.readAuthorizationsByPath?.[path]).toBe(true)

    let followUpApplied = false
    const strReplaceResult = await handleStrReplace({ ...defaultTestHandlerAuthority,
      previousToolCallFinished: Promise.resolve(),
      toolCall: {
        toolCallId: 'replace-after-failed-preflight',
        toolName: 'str_replace',
        input: {
          path,
          replacements: [
            {
              oldString: 'export const value = 1',
              newString: 'export const value = 2',
              allowMultiple: false,
            },
          ],
        },
      },
      fileProcessingState,
      logger,
      requestOptionalFile: async ({ filePath }: { filePath: string }) =>
        filePath === path ? diskContent : null,
      requestClientToolCall: async (clientToolCall: any) => {
        followUpApplied = true
        return confirmedMutationOutput(clientToolCall, {
          [path]: 'export const value = 2\n',
        })
      },
      writeToClient: () => {},
    } as any)

    expect(followUpApplied).toBe(true)
    const replaceOutput = strReplaceResult.output[0]
    expect(fileProcessingState.editRereadRequirementsByPath?.[path]).toBeUndefined()
    expect(replaceOutput.type).toBe('json')
    if (replaceOutput.type === 'json') {
      expect(replaceOutput.value).not.toHaveProperty('errorMessage')
    }
  })

  it('preserves valid authorization for all transaction paths when the client explicitly rejects without applying', async () => {
    const path = 'src/helper.ts'
    const otherPath = 'src/other.ts'
    const diskContentByPath: Record<string, string> = {
      [path]: 'export const value = 1\n',
      [otherPath]: 'export const other = 1\n',
    }
    const fileProcessingState = createFileProcessingState()
    fileProcessingState.strictReadBeforeEdit = true
    fileProcessingState.readAuthorizationsByPath = {
      [path]: true,
      [otherPath]: true,
    }
    fileProcessingState.readAuthorizationHashesByPath = {
      [path]: getContentHash(diskContentByPath[path]),
      [otherPath]: getContentHash(diskContentByPath[otherPath]),
    }

    const transactionResult = await handleEditTransaction({ ...defaultTestHandlerAuthority,
      previousToolCallFinished: Promise.resolve(),
      toolCall: {
        toolCallId: 'transaction-rejected',
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
                },
              ],
            },
            {
              type: 'str_replace',
              path: otherPath,
              replacements: [
                {
                  oldString: 'export const other = 1',
                  newString: 'export const other = 2',
                  allowMultiple: false,
                },
              ],
            },
          ],
        },
      },
      fileProcessingState,
      logger,
      requestOptionalFile: async ({ filePath }: { filePath: string }) =>
        diskContentByPath[filePath] ?? null,
      requestClientToolCall: async (toolCall: any) => [
        {
          type: 'json' as const,
          value: {
            errorMessage: 'client rejected transaction',
            failures: toolCall.input.map((change: { path: string }) => ({
              editIndex: -1,
              path: change.path,
              errorMessage: 'client rejected patch',
            })),
          },
        },
      ],
    } as any)

    const output = transactionResult.output[0]
    expect(output.type).toBe('json')
    if (output.type === 'json') {
      expect(output.value).toHaveProperty('errorMessage')
    }
    expect(fileProcessingState.promisesByPath[path]).toBeUndefined()
    expect(fileProcessingState.promisesByPath[otherPath]).toBeUndefined()
    expect(
      fileProcessingState.failedEditRequiresReadByPath[path],
    ).toBeUndefined()
    expect(
      fileProcessingState.failedEditRequiresReadByPath[otherPath],
    ).toBeUndefined()
    expect(fileProcessingState.readAuthorizationsByPath?.[path]).toBe(true)
    expect(fileProcessingState.readAuthorizationsByPath?.[otherPath]).toBe(true)

    let followUpApplied = false
    const strReplaceResult = await handleStrReplace({ ...defaultTestHandlerAuthority,
      previousToolCallFinished: Promise.resolve(),
      toolCall: {
        toolCallId: 'replace-after-rejected-transaction',
        toolName: 'str_replace',
        input: {
          path,
          replacements: [
            {
              oldString: 'export const value = 1',
              newString: 'export const value = 3',
              allowMultiple: false,
            },
          ],
        },
      },
      fileProcessingState,
      logger,
      requestOptionalFile: async ({ filePath }: { filePath: string }) =>
        diskContentByPath[filePath] ?? null,
      requestClientToolCall: async (clientToolCall: any) => {
        followUpApplied = true
        return confirmedMutationOutput(clientToolCall, {
          [path]: 'export const value = 3\n',
        })
      },
      writeToClient: () => {},
    } as any)

    expect(followUpApplied).toBe(true)
    const replaceOutput = strReplaceResult.output[0]
    expect(fileProcessingState.editRereadRequirementsByPath?.[path]).toBeUndefined()
    expect(replaceOutput.type).toBe('json')
    if (replaceOutput.type === 'json') {
      expect(replaceOutput.value).not.toHaveProperty('errorMessage')
    }
  })

  it('passes preflight for TSX content with import type statements', async () => {
    // Regression: edit_transaction preflight must transpile .tsx files with the
    // 'tsx' loader. With the wrong loader, valid `import type { X } from '...'`
    // syntax (and JSX) was rejected as `Expected "from" but found "{"`.
    const path = 'cli/src/components/example.tsx'
    const diskContent = [
      "import React from 'react'",
      '',
      'export function Example() {',
      '  return <div>hello</div>',
      '}',
      '',
    ].join('\n')
    const fileProcessingState = createFileProcessingState()
    let appliedPatch = ''

    const transactionResult = await handleEditTransaction({ ...defaultTestHandlerAuthority,
      previousToolCallFinished: Promise.resolve(),
      toolCall: {
        toolCallId: 'tsx-import-type-transaction',
        toolName: 'edit_transaction',
        input: {
          edits: [
            {
              type: 'str_replace',
              path,
              replacements: [
                {
                  oldString: "import React from 'react'\n",
                  newString:
                    "import React from 'react'\nimport type { KeyEvent } from '@opentui/core'\n",
                  allowMultiple: false,
                },
              ],
            },
          ],
        },
      },
      fileProcessingState,
      logger,
      requestOptionalFile: async ({ filePath }: { filePath: string }) =>
        filePath === path ? diskContent : null,
      requestClientToolCall: async (toolCall: any) => {
        appliedPatch = toolCall.input[0].content
        return confirmedMutationOutput(toolCall, {
          [path]: diskContent.replace(
            "import React from 'react'\n",
            "import React from 'react'\nimport type { KeyEvent } from '@opentui/core'\n",
          ),
        })
      },
    } as any)

    const output = transactionResult.output[0]
    expect(output.type).toBe('json')
    if (output.type === 'json') {
      expect(output.value).not.toHaveProperty('errorMessage')
    }
    expect(appliedPatch).toContain(
      "import type { KeyEvent } from '@opentui/core'",
    )
    expect(
      fileProcessingState.failedEditRequiresReadByPath[path],
    ).toBeUndefined()
  })

  it('fails preflight and gives actionable guidance for malformed TSX imports', async () => {
    // The malformed-import class of failure (an `import { ... }` left without a
    // valid `from '...'`) must be rejected atomically AND the error must steer
    // recovery toward structured import operations instead of a re-submit loop.
    const path = 'cli/src/components/broken.tsx'
    const diskContent = [
      "import React from 'react'",
      '',
      'export const value = 1',
      '',
    ].join('\n')
    const fileProcessingState = createFileProcessingState()

    const transactionResult = await handleEditTransaction({ ...defaultTestHandlerAuthority,
      previousToolCallFinished: Promise.resolve(),
      toolCall: {
        toolCallId: 'tsx-malformed-import-transaction',
        toolName: 'edit_transaction',
        input: {
          edits: [
            {
              type: 'str_replace',
              path,
              replacements: [
                {
                  oldString: "import React from 'react'\n",
                  newString:
                    "import React from 'react'\nimport { Broken } { Extra } from 'mod'\n",
                  allowMultiple: false,
                },
              ],
            },
          ],
        },
      },
      fileProcessingState,
      logger,
      requestOptionalFile: async ({ filePath }: { filePath: string }) =>
        filePath === path ? diskContent : null,
      requestClientToolCall: async () => {
        throw new Error('should not apply syntactically-invalid transaction')
      },
    } as any)

    const output = transactionResult.output[0]
    expect(output.type).toBe('json')
    if (output.type === 'json') {
      const value = output.value as { errorMessage?: string }
      expect(value.errorMessage).toContain('Preflight Syntax Validation Failed')
      expect(value.errorMessage).toContain(
        'Do NOT resubmit the same edit_transaction',
      )
      expect(value.errorMessage).toContain('insert_import/remove_import')
    }
    // A preflight syntax failure is semantically distinct from a stale-anchor
    // failure: the edits applied structurally and the disk content is unchanged,
    // so the agent does NOT need to re-read the file before retrying — it only
    // needs to fix the syntax. failedEditRequiresReadByPath must stay unset so
    // the strict read-before-edit gate does not spuriously block the retry.
    expect(
      fileProcessingState.failedEditRequiresReadByPath[path],
    ).toBeUndefined()
  })

  it('marks all transaction paths as requiring re-read when client apply throws', async () => {
    const path = 'src/helper.ts'
    const otherPath = 'src/other.ts'
    const diskContentByPath: Record<string, string> = {
      [path]: 'export const value = 1\n',
      [otherPath]: 'export const other = 1\n',
    }
    const fileProcessingState = createFileProcessingState()

    const transactionResult = await handleEditTransaction({ ...defaultTestHandlerAuthority,
      previousToolCallFinished: Promise.resolve(),
      toolCall: {
        toolCallId: 'transaction-throws',
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
                },
              ],
            },
            {
              type: 'str_replace',
              path: otherPath,
              replacements: [
                {
                  oldString: 'export const other = 1',
                  newString: 'export const other = 2',
                  allowMultiple: false,
                },
              ],
            },
          ],
        },
      },
      fileProcessingState,
      logger,
      requestOptionalFile: async ({ filePath }: { filePath: string }) =>
        diskContentByPath[filePath] ?? null,
      requestClientToolCall: async () => {
        throw new Error('client apply threw')
      },
    } as any)

    const output = transactionResult.output[0]
    expect(output.type).toBe('json')
    if (output.type === 'json') {
      expect(output.value).toHaveProperty('errorMessage')
      expect(
        String((output.value as { errorMessage?: string }).errorMessage),
      ).toContain('client apply threw')
    }
    expect(fileProcessingState.promisesByPath[path]).toBeUndefined()
    expect(fileProcessingState.promisesByPath[otherPath]).toBeUndefined()
    expect(fileProcessingState.failedEditRequiresReadByPath[path]).toBe(true)
    expect(fileProcessingState.failedEditRequiresReadByPath[otherPath]).toBe(
      true,
    )
  })

  it('uses current disk content for basedOnRead even when stale per-path edit content remains', async () => {
    const path = 'agents/editor/editor.ts'
    const staleContent = Array.from(
      { length: 2_889 },
      (_, index) => `const stale${index} = ${index};`,
    ).join('\n')
    const diskLines = Array.from({ length: 4_499 }, (_, index) =>
      index === 3_359
        ? 'const target = 1;'
        : `const current${index} = ${index};`,
    )
    const diskContent = diskLines.join('\n')
    const rangeContent = diskLines.slice(3_359, 3_360).join('\n')
    const readCapability = encodeReadCapabilityToken({
      startLine: 3_360,
      endLine: 3_360,
      hash: getContentHash(rangeContent),
      scope: {
        projectId: mockFileContext.projectRoot,
        path,
        runId: 'test-run-id',
      },
    })

    const fileProcessingState = createFileProcessingState()
    fileProcessingState.promisesByPath[path] = [
      Promise.resolve({
        tool: 'str_replace' as const,
        path,
        toolCallId: 'stale-edit',
        content: staleContent,
        patch: '',
        messages: [],
      }),
    ]

    let appliedPatchContent = ''
    let requestOptionalFileLineCount = 0
    const strReplaceResult = await handleStrReplace({ ...defaultTestHandlerAuthority,
      previousToolCallFinished: Promise.resolve(),
      toolCall: {
        toolCallId: 'replace-anchored',
        toolName: 'str_replace',
        input: {
          path,
          replacements: [
            {
              oldString: 'const target = 1;',
              newString: 'const target = 2;',
              allowMultiple: false,
              basedOnRead: readCapability,
            },
          ],
        },
      },
      fileProcessingState,
      fileContext: mockFileContext,
      runId: 'test-run-id',
      logger,
      requestOptionalFile: async ({ filePath }: { filePath: string }) => {
        if (filePath !== path) return null
        requestOptionalFileLineCount = diskContent.split('\n').length
        return diskContent
      },
      requestClientToolCall: async (toolCall: any) => {
        appliedPatchContent = toolCall.input.content
        return confirmedMutationOutput(
          toolCall,
          {
            [path]: diskContent.replace(
              'const target = 1;',
              'const target = 2;',
            ),
          },
          { projectId: mockFileContext.projectRoot, runId: 'test-run-id' },
        )
      },
      writeToClient: () => {},
    } as any)

    const output = strReplaceResult.output[0]
    expect(output.type).toBe('json')
    if (output.type === 'json') {
      expect(output.value).not.toHaveProperty('errorMessage')
      expect(requestOptionalFileLineCount).toBe(4_499)
      expect(appliedPatchContent).toContain('-const target = 1;')
      expect(appliedPatchContent).toContain('+const target = 2;')
    }
    expect(
      fileProcessingState.failedEditRequiresReadByPath[path],
    ).toBeUndefined()
  })

  it('clears stale per-path edit content so readCapability validation uses current disk content', async () => {
    const path = 'src/large.ts'
    const staleContent = Array.from({ length: 1_001 }, (_, index) =>
      index === 500 ? 'const target = 0;' : `const stale${index} = ${index};`,
    ).join('\n')
    const diskLines = Array.from({ length: 1_501 }, (_, index) =>
      index === 1_200
        ? 'const target = 1;'
        : `const current${index} = ${index};`,
    )
    const diskContent = diskLines.join('\n')
    const rangeContent = diskLines.slice(1_200, 1_201).join('\n')
    const readCapability = encodeReadCapabilityToken({
      startLine: 1_201,
      endLine: 1_201,
      hash: getContentHash(rangeContent),
      scope: {
        projectId: mockFileContext.projectRoot,
        path,
        runId: 'test-run-id',
      },
    })

    const fileProcessingState = createFileProcessingState()
    fileProcessingState.failedEditRequiresReadByPath[path] = true
    fileProcessingState.promisesByPath[path] = [
      Promise.resolve({
        tool: 'str_replace' as const,
        path,
        toolCallId: 'stale-edit',
        content: staleContent,
        patch: '',
        messages: [],
      }),
    ]

    let appliedPatchContent = ''
    const requestOptionalFile = async ({ filePath }: { filePath: string }) =>
      filePath === path ? diskContent : null
    const requestFiles = async () =>
      buildReadFilesResultV1([
        {
          selector: 'range',
          requestIndex: 0,
          path,
          status: 'ok',
          content: rangeContent,
          sourceContent: rangeContent,
          startLine: 1_201,
          endLine: 1_201,
          totalLines: 1_501,
          complete: true,
          editAnchor: {
            startLine: 1_201,
            endLine: 1_201,
            contentHash: getContentHash(rangeContent),
            readCapability,
          },
        },
      ])

    await handleReadFiles({ ...defaultTestHandlerAuthority,
      previousToolCallFinished: Promise.resolve(),
      toolCall: {
        toolCallId: 'read-1',
        toolName: 'read_files',
        input: {
          paths: [],
          ranges: [{ path, startLine: 1_201, endLine: 1_201 }],
        },
      },
      fileContext: mockFileContext,
      fileProcessingState,
      requestFiles,
      logger,
    } as any)

    expect(
      fileProcessingState.failedEditRequiresReadByPath[path],
    ).toBeUndefined()
    expect(fileProcessingState.promisesByPath[path]).toBeUndefined()

    const strReplaceResult = await handleStrReplace({ ...defaultTestHandlerAuthority,
      previousToolCallFinished: Promise.resolve(),
      toolCall: {
        toolCallId: 'replace-1',
        toolName: 'str_replace',
        input: {
          path,
          replacements: [
            {
              oldString: 'const target = 1;',
              newString: 'const target = 2;',
              allowMultiple: false,
              basedOnRead: readCapability,
            },
          ],
        },
      },
      fileProcessingState,
      fileContext: mockFileContext,
      runId: 'test-run-id',
      logger,
      requestOptionalFile,
      requestClientToolCall: async (toolCall: any) => {
        appliedPatchContent = toolCall.input.content
        return confirmedMutationOutput(
          toolCall,
          {
            [path]: diskContent.replace(
              'const target = 1;',
              'const target = 2;',
            ),
          },
          { projectId: mockFileContext.projectRoot, runId: 'test-run-id' },
        )
      },
      writeToClient: () => {},
    } as any)

    const output = strReplaceResult.output[0]
    expect(output.type).toBe('json')
    if (output.type === 'json') {
      expect(output.value).not.toHaveProperty('errorMessage')
      expect(output.value).toMatchObject({
        kind: 'file_mutation_result',
        outcome: 'applied',
        actions: [expect.objectContaining({ path })],
      })
      expect(appliedPatchContent).toContain('-const target = 1;')
      expect(appliedPatchContent).toContain('+const target = 2;')
    }
    expect(
      fileProcessingState.failedEditRequiresReadByPath[path],
    ).toBeUndefined()
  })

  it('waits for an in-flight read_files recovery before choosing edit base content', async () => {
    const path = 'src/streamed-large.ts'
    const staleContent = Array.from({ length: 1_001 }, (_, index) =>
      index === 500 ? 'const target = 0;' : `const stale${index} = ${index};`,
    ).join('\n')
    const diskLines = Array.from({ length: 1_501 }, (_, index) =>
      index === 1_200
        ? 'const target = 1;'
        : `const current${index} = ${index};`,
    )
    const diskContent = diskLines.join('\n')
    const rangeContent = diskLines.slice(1_200, 1_201).join('\n')
    const readCapability = encodeReadCapabilityToken({
      startLine: 1_201,
      endLine: 1_201,
      hash: getContentHash(rangeContent),
      scope: {
        projectId: mockFileContext.projectRoot,
        path,
        runId: 'test-run-id',
      },
    })

    const fileProcessingState = createFileProcessingState()
    fileProcessingState.failedEditRequiresReadByPath[path] = true
    fileProcessingState.promisesByPath[path] = [
      Promise.resolve({
        tool: 'str_replace' as const,
        path,
        toolCallId: 'stale-edit',
        content: staleContent,
        patch: '',
        messages: [],
      }),
    ]

    let releaseRead!: () => void
    const readFinished = new Promise<void>((resolve) => {
      releaseRead = resolve
    })
    let appliedPatchContent = ''

    const readPromise = handleReadFiles({ ...defaultTestHandlerAuthority,
      previousToolCallFinished: Promise.resolve(),
      toolCall: {
        toolCallId: 'read-1',
        toolName: 'read_files',
        input: {
          paths: [],
          ranges: [{ path, startLine: 1_201, endLine: 1_201 }],
        },
      },
      fileContext: mockFileContext,
      fileProcessingState,
      requestFiles: async () => {
        await readFinished
        return buildReadFilesResultV1([
          {
            selector: 'range',
            requestIndex: 0,
            path,
            status: 'ok',
            content: rangeContent,
            sourceContent: rangeContent,
            startLine: 1_201,
            endLine: 1_201,
            totalLines: 1_501,
            complete: true,
            editAnchor: {
              startLine: 1_201,
              endLine: 1_201,
              contentHash: getContentHash(rangeContent),
              readCapability,
            },
          },
        ])
      },
      logger,
    } as any)

    const strReplacePromise = handleStrReplace({ ...defaultTestHandlerAuthority,
      previousToolCallFinished: readPromise.then(() => undefined),
      toolCall: {
        toolCallId: 'replace-1',
        toolName: 'str_replace',
        input: {
          path,
          replacements: [
            {
              oldString: 'const target = 1;',
              newString: 'const target = 2;',
              allowMultiple: false,
              basedOnRead: readCapability,
            },
          ],
        },
      },
      fileProcessingState,
      fileContext: mockFileContext,
      runId: 'test-run-id',
      logger,
      requestOptionalFile: async ({ filePath }: { filePath: string }) =>
        filePath === path ? diskContent : null,
      requestClientToolCall: async (toolCall: any) => {
        appliedPatchContent = toolCall.input.content
        return [
          {
            type: 'json' as const,
            value: {
              file: toolCall.input.path,
              message: 'applied',
            },
          },
        ]
      },
      writeToClient: () => {},
    } as any)

    expect(fileProcessingState.failedEditRequiresReadByPath[path]).toBe(true)
    expect(fileProcessingState.promisesByPath[path]).toHaveLength(1)

    releaseRead()
    await readPromise
    const strReplaceResult = await strReplacePromise

    const output = strReplaceResult.output[0]
    expect(output.type).toBe('json')
    if (output.type === 'json') {
      expect(output.value).not.toHaveProperty('errorMessage')
      expect(output.value).toMatchObject({ file: path })
      expect(appliedPatchContent).toContain('-const target = 1;')
      expect(appliedPatchContent).toContain('+const target = 2;')
    }
  })

  describe('strict read-before-edit (Milestone 2 staged)', () => {
    it('default strict=false allows str_replace without a prior read', async () => {
      const path = 'src/helper.ts'
      const diskContent = 'export const value = 1\n'
      const fileProcessingState = createFileProcessingState()
      let applied = false

      const result = await handleStrReplace({ ...defaultTestHandlerAuthority,
        previousToolCallFinished: Promise.resolve(),
        toolCall: {
          toolCallId: 'default-non-strict',
          toolName: 'str_replace',
          input: {
            path,
            replacements: [
              {
                oldString: 'export const value = 1',
                newString: 'export const value = 2',
                allowMultiple: false,
              },
            ],
          },
        },
        fileProcessingState,
        logger,
        requestOptionalFile: async ({ filePath }: { filePath: string }) =>
          filePath === path ? diskContent : null,
        requestClientToolCall: async (toolCall: any) => {
          applied = true
          return [
            {
              type: 'json' as const,
              value: { file: toolCall.input.path, message: 'applied' },
            },
          ]
        },
        writeToClient: () => {},
      } as any)

      expect(applied).toBe(true)
      const output = result.output[0]
      expect(output.type).toBe('json')
      if (output.type === 'json') {
        expect(output.value).not.toHaveProperty('errorMessage')
      }
    })

    it('strict str_replace auto-rereads once and applies a unique replacement without prior sticky auth', async () => {
      const path = 'src/helper.ts'
      const diskContent = 'export const value = 1\n'
      const fileProcessingState = createFileProcessingState()
      fileProcessingState.strictReadBeforeEdit = true
      let applied = false

      const result = await handleStrReplace({ ...defaultTestHandlerAuthority,
        previousToolCallFinished: Promise.resolve(),
        toolCall: {
          toolCallId: 'strict-auto-reread',
          toolName: 'str_replace',
          input: {
            path,
            replacements: [
              {
                oldString: 'export const value = 1',
                newString: 'export const value = 2',
                allowMultiple: false,
              },
            ],
          },
        },
        fileProcessingState,
        logger,
        requestOptionalFile: async ({ filePath }: { filePath: string }) =>
          filePath === path ? diskContent : null,
        requestClientToolCall: async (toolCall: any) => {
          applied = true
          return confirmedMutationOutput(toolCall, {
            [path]: 'export const value = 2\n',
          })
        },
        writeToClient: () => {},
      } as any)

      expect(applied).toBe(true)
      const output = result.output[0]
      expect(output.type).toBe('json')
      if (output.type === 'json') {
        expect(output.value).not.toHaveProperty('errorMessage')
      }
      // Post-apply grant of observed post-edit content may mint sticky; auto-reread
      // alone must not mint durable sticky before apply.
      expect(fileProcessingState.readAuthorizationsByPath?.[path]).toBe(true)
      expect(fileProcessingState.readAuthorizationHashesByPath?.[path]).toBe(
        getContentHash('export const value = 2\n'),
      )
    })

    it('auto-reread str_replace does not leave durable sticky that write_file can use without a real read', async () => {
      // Security (AUTOREREAD-STICKY-WRITE-CHAIN): auto-reread must not mint
      // durable sticky of pre-edit bytes for a later whole-file overwrite.
      // After a successful unique apply, sticky may refresh from post-edit
      // content (observed bytes). A write_file without a model-visible complete
      // read still requires that sticky to match current disk; if we wipe sticky
      // after auto-reread-only apply semantics prefer no pre-edit grant.
      const path = 'src/chain-overwrite.ts'
      const diskContent = 'export const value = 1\n'
      const fileProcessingState = createFileProcessingState()
      fileProcessingState.strictReadBeforeEdit = true

      // Fail auto-reread apply path: ambiguous/missing match leaves no sticky.
      const failResult = await handleStrReplace({ ...defaultTestHandlerAuthority,
        previousToolCallFinished: Promise.resolve(),
        toolCall: {
          toolCallId: 'auto-reread-fail-no-sticky',
          toolName: 'str_replace',
          input: {
            path,
            replacements: [
              {
                oldString: 'export const missing = 99',
                newString: 'export const missing = 100',
                allowMultiple: false,
              },
            ],
          },
        },
        fileProcessingState,
        logger,
        requestOptionalFile: async () => diskContent,
        requestClientToolCall: async () => {
          throw new Error('must not apply failed auto-reread')
        },
        writeToClient: () => {},
      } as any)

      expect(failResult.output[0]?.type).toBe('json')
      expect(
        fileProcessingState.readAuthorizationsByPath?.[path],
      ).toBeUndefined()

      let writeApplied = false
      const writeResult = await handleWriteFile({ ...defaultTestHandlerAuthority,
        previousToolCallFinished: Promise.resolve(),
        toolCall: {
          toolCallId: 'write-after-failed-auto-reread',
          toolName: 'write_file',
          input: { path, content: 'export const value = 999\n' },
        },
        agentState: { messageHistory: [] },
        clientSessionId: 'test-session',
        fileProcessingState,
        fingerprintId: 'test-fingerprint',
        logger,
        prompt: undefined,
        userId: undefined,
        userInputId: 'test-input',
        requestOptionalFile: async () => diskContent,
        requestClientToolCall: async () => {
          writeApplied = true
          return []
        },
        writeToClient: () => {},
      } as any)

      expect(writeApplied).toBe(false)
      expect(writeResult.output[0]?.type).toBe('json')
      if (writeResult.output[0]?.type === 'json') {
        const value = writeResult.output[0].value as {
          basedOnRead?: string
          errorMessage?: string
        }
        expect(String(value.errorMessage)).toContain('write_file blocked')
        expect(String(value.errorMessage)).toContain('read_files')
        expect(String(value.errorMessage)).not.toContain('cap.v3.')
        expect(value).not.toHaveProperty('basedOnRead')
      }
    })

    it('strict str_replace fails closed when auto-reread finds the file missing', async () => {
      const path = 'src/missing-helper.ts'
      const fileProcessingState = createFileProcessingState()
      fileProcessingState.strictReadBeforeEdit = true

      const result = await handleStrReplace({ ...defaultTestHandlerAuthority,
        previousToolCallFinished: Promise.resolve(),
        toolCall: {
          toolCallId: 'strict-auto-reread-missing',
          toolName: 'str_replace',
          input: {
            path,
            replacements: [
              {
                oldString: 'export const value = 1',
                newString: 'export const value = 2',
                allowMultiple: false,
              },
            ],
          },
        },
        fileProcessingState,
        logger,
        requestOptionalFile: async () => null,
        requestClientToolCall: async () => {
          throw new Error(
            'client apply must not be called when the file is missing',
          )
        },
        writeToClient: () => {},
      } as any)

      const output = result.output[0]
      expect(output.type).toBe('json')
      if (output.type === 'json') {
        const value = output.value as { file?: string; errorMessage?: string }
        expect(value.file).toBe(path)
        expect(String(value.errorMessage)).toContain('read_files')
      }
    })

    it('strict str_replace with allowMultiple:true does not auto-reread-apply without sticky/basedOnRead', async () => {
      // AUTOREREAD-ALLOWMULTIPLE-NOT-FAIL-CLOSED: multi-match must fail closed.
      const path = 'src/multi-match.ts'
      const diskContent =
        'export const value = 1\nexport const value = 1\n'
      const fileProcessingState = createFileProcessingState()
      fileProcessingState.strictReadBeforeEdit = true
      let applied = false

      const result = await handleStrReplace({ ...defaultTestHandlerAuthority,
        previousToolCallFinished: Promise.resolve(),
        toolCall: {
          toolCallId: 'strict-allow-multiple-no-auto-reread',
          toolName: 'str_replace',
          input: {
            path,
            replacements: [
              {
                oldString: 'export const value = 1',
                newString: 'export const value = 2',
                allowMultiple: true,
              },
            ],
          },
        },
        fileProcessingState,
        logger,
        requestOptionalFile: async () => diskContent,
        requestClientToolCall: async () => {
          applied = true
          return []
        },
        writeToClient: () => {},
      } as any)

      expect(applied).toBe(false)
      const output = result.output[0]
      expect(output.type).toBe('json')
      if (output.type === 'json') {
        const value = output.value as { file?: string; errorMessage?: string }
        expect(value.file).toBe(path)
        expect(String(value.errorMessage)).toMatch(/read_files|basedOnRead|blocked/i)
      }
      // Auto-reread must not mint sticky for allowMultiple multi-match.
      expect(
        fileProcessingState.readAuthorizationsByPath?.[path],
      ).toBeUndefined()
    })

    it('exposes a whole-file readCapability that directly authorizes the next strict edit', async () => {
      const path = 'client/src/routes/dashboard.ip.tsx'
      const diskContent = 'export const value = 1\n'
      const runId = 'strict-capability-run'
      const fileProcessingState = createFileProcessingState()
      fileProcessingState.strictReadBeforeEdit = true

      const readResult = await handleReadFiles({ ...defaultTestHandlerAuthority,
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
      const editResult = await handleStrReplace({ ...defaultTestHandlerAuthority,
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

    it('revokes and blocks a cross-turn whole-file authorization when the file changed externally', async () => {
      const path = 'src/stale-auth.ts'
      const readContent = 'export const value = 1\n'
      const diskContent = 'export const value = 2\n'
      const fileProcessingState = createFileProcessingState()
      fileProcessingState.strictReadBeforeEdit = true
      fileProcessingState.readAuthorizationsByPath = { [path]: true }
      fileProcessingState.readAuthorizationHashesByPath = {
        [path]: getContentHash(readContent),
      }
      let applied = false

      const result = await handleStrReplace({ ...defaultTestHandlerAuthority,
        previousToolCallFinished: Promise.resolve(),
        toolCall: {
          toolCallId: 'stale-whole-file-auth',
          toolName: 'str_replace',
          input: {
            path,
            replacements: [
              {
                oldString: 'export const value = 1',
                newString: 'export const value = 3',
                allowMultiple: false,
              },
            ],
          },
        },
        fileProcessingState,
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
        expect(String((result.output[0].value as any).errorMessage)).toContain(
          'changed after its last whole-file read',
        )
      }
      expect(
        fileProcessingState.readAuthorizationsByPath?.[path],
      ).toBeUndefined()
      expect(
        fileProcessingState.readAuthorizationHashesByPath?.[path],
      ).toBeUndefined()
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

      const result = await handleStrReplace({ ...defaultTestHandlerAuthority,
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

    it('auto-rereads once for legacy Boolean-only whole-file authorization and applies unique edit', async () => {
      const path = 'src/legacy-auth.ts'
      const diskContent = 'export const value = 1\n'
      const fileProcessingState = createFileProcessingState()
      fileProcessingState.strictReadBeforeEdit = true
      // Boolean-only sticky without a content hash is not usable; auto-reread
      // recovers in-process and post-apply grants sticky from post-edit content.
      fileProcessingState.readAuthorizationsByPath = { [path]: true }
      let applied = false

      const result = await handleStrReplace({ ...defaultTestHandlerAuthority,
        previousToolCallFinished: Promise.resolve(),
        toolCall: {
          toolCallId: 'legacy-boolean-only-auth',
          toolName: 'str_replace',
          input: {
            path,
            replacements: [
              {
                oldString: 'export const value = 1',
                newString: 'export const value = 2',
                allowMultiple: false,
              },
            ],
          },
        },
        fileProcessingState,
        logger,
        requestOptionalFile: async () => diskContent,
        requestClientToolCall: async (toolCall: any) => {
          applied = true
          return confirmedMutationOutput(toolCall, {
            [path]: 'export const value = 2\n',
          })
        },
        writeToClient: () => {},
      } as any)

      expect(applied).toBe(true)
      expect(result.output[0]?.type).toBe('json')
      if (result.output[0]?.type === 'json') {
        expect(result.output[0].value).not.toHaveProperty('errorMessage')
      }
      // Sticky is from post-edit observed content, not from auto-reread alone.
      expect(fileProcessingState.readAuthorizationsByPath?.[path]).toBe(true)
      expect(fileProcessingState.readAuthorizationHashesByPath?.[path]).toBe(
        getContentHash('export const value = 2\n'),
      )
    })

    it('strict read_files authorizes consecutive str_replaces via sticky read authorization', async () => {
      const path = 'src/helper.ts'
      const diskContent = 'export const value = 1\n'
      const fileProcessingState = createFileProcessingState()
      fileProcessingState.strictReadBeforeEdit = true

      await handleReadFiles({ ...defaultTestHandlerAuthority,
        previousToolCallFinished: Promise.resolve(),
        toolCall: {
          toolCallId: 'strict-read',
          toolName: 'read_files',
          input: { paths: [path] },
        },
        fileContext: mockFileContext,
        fileProcessingState,
        requestFiles: async ({ filePaths }: { filePaths: string[] }) =>
          buildWholeFileReadResultV1(filePaths, (filePath) =>
            filePath === path ? diskContent : null,
          ),
        logger,
      } as any)

      expect(fileProcessingState.readAuthorizationsByPath?.[path]).toBe(true)
      expect(fileProcessingState.readAuthorizationHashesByPath?.[path]).toBe(
        getContentHash(diskContent),
      )

      let firstApplyCount = 0
      const firstResult = await handleStrReplace({ ...defaultTestHandlerAuthority,
        previousToolCallFinished: Promise.resolve(),
        toolCall: {
          toolCallId: 'strict-first-edit',
          toolName: 'str_replace',
          input: {
            path,
            replacements: [
              {
                oldString: 'export const value = 1',
                newString: 'export const value = 2',
                allowMultiple: false,
              },
            ],
          },
        },
        fileProcessingState,
        logger,
        requestOptionalFile: async ({ filePath }: { filePath: string }) =>
          filePath === path ? diskContent : null,
        requestClientToolCall: async (toolCall: any) => {
          firstApplyCount += 1
          return confirmedMutationOutput(toolCall, {
            [path]: 'export const value = 2\n',
          })
        },
        writeToClient: () => {},
      } as any)

      expect(firstApplyCount).toBe(1)
      const firstOutput = firstResult.output[0]
      expect(firstOutput.type).toBe('json')
      if (firstOutput.type === 'json') {
        expect(firstOutput.value).not.toHaveProperty('errorMessage')
      }
      // Sticky auth: a successful str_replace does NOT consume the per-path
      // read authorization, so back-to-back edits on the same path do not
      // force redundant read round-trips. Only a failed edit (which sets
      // failedEditRequiresReadByPath) or an externally-changed file
      // (anchored with a fresh basedOnRead capability) re-enables the gate.
      expect(fileProcessingState.readAuthorizationsByPath?.[path]).toBe(true)
      expect(fileProcessingState.readAuthorizationHashesByPath?.[path]).toBe(
        getContentHash('export const value = 2\n'),
      )

      // A second str_replace without re-reading must now SUCCEED using the
      // sticky auth granted by the original read_files call.
      let secondApplyCount = 0
      const secondResult = await handleStrReplace({ ...defaultTestHandlerAuthority,
        previousToolCallFinished: Promise.resolve(),
        toolCall: {
          toolCallId: 'strict-second-edit-sticky',
          toolName: 'str_replace',
          input: {
            path,
            replacements: [
              {
                oldString: 'export const value = 2',
                newString: 'export const value = 3',
                allowMultiple: false,
              },
            ],
          },
        },
        fileProcessingState,
        logger,
        requestOptionalFile: async ({ filePath }: { filePath: string }) =>
          filePath === path ? diskContent : null,
        requestClientToolCall: async (toolCall: any) => {
          secondApplyCount += 1
          return confirmedMutationOutput(toolCall, {
            [path]: 'export const value = 3\n',
          })
        },
        writeToClient: () => {},
      } as any)

      // Second str_replace applied via sticky auth (no re-read required).
      expect(secondApplyCount).toBe(1)
      const secondOutput = secondResult.output[0]
      expect(secondOutput.type).toBe('json')
      if (secondOutput.type === 'json') {
        expect(secondOutput.value).not.toHaveProperty('errorMessage')
      }
      // Auth still persists after the second successful edit.
      expect(fileProcessingState.readAuthorizationsByPath?.[path]).toBe(true)
      expect(fileProcessingState.readAuthorizationHashesByPath?.[path]).toBe(
        getContentHash('export const value = 3\n'),
      )
    })

    it('strict read_files grants sticky read authorization that survives four consecutive str_replaces (read -> edit -> edit -> edit)', async () => {
      const path = 'src/helper.ts'
      const diskContent = 'export const value = 1\n'
      const fileProcessingState = createFileProcessingState()
      fileProcessingState.strictReadBeforeEdit = true

      // Single read_files call grants the initial per-path authorization.
      await handleReadFiles({ ...defaultTestHandlerAuthority,
        previousToolCallFinished: Promise.resolve(),
        toolCall: {
          toolCallId: 'sticky-read-init',
          toolName: 'read_files',
          input: { paths: [path] },
        },
        fileContext: mockFileContext,
        fileProcessingState,
        requestFiles: async ({ filePaths }: { filePaths: string[] }) =>
          buildWholeFileReadResultV1(filePaths, (filePath) =>
            filePath === path ? diskContent : null,
          ),
        logger,
      } as any)

      expect(fileProcessingState.readAuthorizationsByPath?.[path]).toBe(true)

      // Four back-to-back edits with no intervening read_files calls. Each
      // edit increments its own apply counter via requestClientToolCall. If
      // any of them were blocked, the client would never be invoked and the
      // counter would stay at zero for that edit.
      const edits: Array<{ from: number; to: number }> = [
        { from: 1, to: 2 },
        { from: 2, to: 3 },
        { from: 3, to: 4 },
        { from: 4, to: 5 },
      ]
      let totalApplies = 0

      for (const [i, step] of edits.entries()) {
        const result = await handleStrReplace({ ...defaultTestHandlerAuthority,
          previousToolCallFinished: Promise.resolve(),
          toolCall: {
            toolCallId: `sticky-edit-${i}`,
            toolName: 'str_replace',
            input: {
              path,
              replacements: [
                {
                  oldString: `export const value = ${step.from}`,
                  newString: `export const value = ${step.to}`,
                  allowMultiple: false,
                },
              ],
            },
          },
          fileProcessingState,
          logger,
          requestOptionalFile: async ({ filePath }: { filePath: string }) =>
            filePath === path ? diskContent : null,
          requestClientToolCall: async (toolCall: any) => {
            totalApplies += 1
            return confirmedMutationOutput(toolCall, {
              [path]: `export const value = ${step.to}\n`,
            })
          },
          writeToClient: () => {},
        } as any)

        // Every edit must apply successfully via the sticky auth and must
        // NOT carry an errorMessage.
        const output = result.output[0]
        expect(output.type).toBe('json')
        if (output.type === 'json') {
          expect(output.value).not.toHaveProperty('errorMessage')
        }
      }

      // All four edits applied via the original read_files authorization.
      expect(totalApplies).toBe(4)
      // Auth is still active after the entire read -> edit x4 chain.
      expect(fileProcessingState.readAuthorizationsByPath?.[path]).toBe(true)
      // No failure flag was raised on any of the four edits.
      expect(
        fileProcessingState.failedEditRequiresReadByPath?.[path],
      ).toBeUndefined()
    })

    it('strict read_files authorizes str_replace with equivalent normalized path spellings', async () => {
      const path = 'src/helper.ts'
      const diskContent = 'export const value = 1\n'
      const fileProcessingState = createFileProcessingState()
      fileProcessingState.strictReadBeforeEdit = true

      await handleReadFiles({ ...defaultTestHandlerAuthority,
        previousToolCallFinished: Promise.resolve(),
        toolCall: {
          toolCallId: 'strict-read-dot-slash',
          toolName: 'read_files',
          input: { paths: [`./${path}`] },
        },
        fileContext: mockFileContext,
        fileProcessingState,
        requestFiles: async ({ filePaths }: { filePaths: string[] }) =>
          buildWholeFileReadResultV1(filePaths, (filePath) =>
            filePath === path ? diskContent : null,
          ),
        logger,
      } as any)

      expect(fileProcessingState.readAuthorizationsByPath?.[path]).toBe(true)
      expect(
        fileProcessingState.readAuthorizationsByPath?.[`./${path}`],
      ).toBeUndefined()

      let applied = false
      const result = await handleStrReplace({ ...defaultTestHandlerAuthority,
        previousToolCallFinished: Promise.resolve(),
        toolCall: {
          toolCallId: 'strict-edit-normalized-path',
          toolName: 'str_replace',
          input: {
            path: `./${path}`,
            replacements: [
              {
                oldString: 'export const value = 1',
                newString: 'export const value = 2',
                allowMultiple: false,
              },
            ],
          },
        },
        fileProcessingState,
        logger,
        requestOptionalFile: async ({ filePath }: { filePath: string }) =>
          filePath === path ? diskContent : null,
        requestClientToolCall: async (toolCall: any) => {
          applied = true
          return confirmedMutationOutput(toolCall, {
            [path]: 'export const value = 2\n',
          })
        },
        writeToClient: () => {},
      } as any)

      expect(applied).toBe(true)
      const output = result.output[0]
      expect(output.type).toBe('json')
      if (output.type === 'json') {
        expect(output.value).toMatchObject({
          kind: 'file_mutation_result',
          outcome: 'applied',
          actions: [expect.objectContaining({ path })],
        })
        expect(output.value).not.toHaveProperty('errorMessage')
      }
      // Sticky auth: the str_replace success keeps the per-path authorization
      // alive so subsequent edits on `path` (and equivalent spellings such
      // as `./path`) do not require a re-read.
      expect(fileProcessingState.readAuthorizationsByPath?.[path]).toBe(true)
    })

    it('strict edit_transaction accepts multi-file reads and edits with equivalent normalized path spellings', async () => {
      const path = 'src/helper.ts'
      const otherPath = 'src/other.ts'
      const diskContentByPath: Record<string, string> = {
        [path]: 'export const value = 1\n',
        [otherPath]: 'export const other = 1\n',
      }
      const fileProcessingState = createFileProcessingState()
      fileProcessingState.strictReadBeforeEdit = true

      await handleReadFiles({ ...defaultTestHandlerAuthority,
        previousToolCallFinished: Promise.resolve(),
        toolCall: {
          toolCallId: 'strict-transaction-read-normalized',
          toolName: 'read_files',
          input: { paths: [`./${path}`, otherPath] },
        },
        fileContext: mockFileContext,
        fileProcessingState,
        requestFiles: async ({ filePaths }: { filePaths: string[] }) =>
          buildWholeFileReadResultV1(
            filePaths,
            (filePath) => diskContentByPath[filePath] ?? null,
          ),
        logger,
      } as any)

      expect(fileProcessingState.readAuthorizationsByPath?.[path]).toBe(true)
      expect(fileProcessingState.readAuthorizationsByPath?.[otherPath]).toBe(
        true,
      )

      let applied = false
      const result = await handleEditTransaction({ ...defaultTestHandlerAuthority,
        previousToolCallFinished: Promise.resolve(),
        toolCall: {
          toolCallId: 'strict-transaction-normalized',
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
                  },
                ],
              },
              {
                type: 'str_replace',
                path: `./${otherPath}`,
                replacements: [
                  {
                    oldString: 'export const other = 1',
                    newString: 'export const other = 2',
                    allowMultiple: false,
                  },
                ],
              },
            ],
          },
        },
        fileProcessingState,
        logger,
        requestOptionalFile: async ({ filePath }: { filePath: string }) =>
          diskContentByPath[filePath] ?? null,
        requestClientToolCall: async (toolCall: any) => {
          applied = true
          return confirmedMutationOutput(toolCall, {
            [path]: 'export const value = 2\n',
            [otherPath]: 'export const other = 2\n',
          })
        },
      } as any)

      expect(applied).toBe(true)
      const output = result.output[0]
      expect(output.type).toBe('json')
      if (output.type === 'json') {
        expect(output.value).not.toHaveProperty('errorMessage')
      }
      // Sticky auth: edit_transaction success does NOT consume the per-path
      // authorization, so subsequent single-file edits on those paths
      // remain authorized without a re-read.
      expect(fileProcessingState.readAuthorizationsByPath?.[path]).toBe(true)
      expect(fileProcessingState.readAuthorizationsByPath?.[otherPath]).toBe(
        true,
      )
      expect(fileProcessingState.readAuthorizationHashesByPath?.[path]).toBe(
        getContentHash('export const value = 2\n'),
      )
      expect(
        fileProcessingState.readAuthorizationHashesByPath?.[otherPath],
      ).toBe(getContentHash('export const other = 2\n'))
    })

    it('strict edit_transaction auto-rereads once for unread str_replace paths and applies', async () => {
      const path = 'src/helper.ts'
      const otherPath = 'src/other.ts'
      const diskContentByPath: Record<string, string> = {
        [path]: 'export const value = 1\n',
        [otherPath]: 'export const other = 1\n',
      }
      const fileProcessingState = createFileProcessingState()
      fileProcessingState.strictReadBeforeEdit = true
      let applied = false

      const result = await handleEditTransaction({ ...defaultTestHandlerAuthority,
        previousToolCallFinished: Promise.resolve(),
        toolCall: {
          toolCallId: 'strict-transaction-auto-reread',
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
                  },
                ],
              },
              {
                type: 'str_replace',
                path: otherPath,
                replacements: [
                  {
                    oldString: 'export const other = 1',
                    newString: 'export const other = 2',
                    allowMultiple: false,
                  },
                ],
              },
            ],
          },
        },
        fileProcessingState,
        logger,
        requestOptionalFile: async ({ filePath }: { filePath: string }) =>
          diskContentByPath[filePath] ?? null,
        requestClientToolCall: async (toolCall: any) => {
          applied = true
          return confirmedMutationOutput(toolCall, {
            [path]: 'export const value = 2\n',
            [otherPath]: 'export const other = 2\n',
          })
        },
      } as any)

      expect(applied).toBe(true)
      const output = result.output[0]
      expect(output.type).toBe('json')
      if (output.type === 'json') {
        expect(output.value).not.toHaveProperty('errorMessage')
      }
      // Post-apply sticky from observed post-edit content is allowed.
      expect(fileProcessingState.readAuthorizationsByPath?.[path]).toBe(true)
      expect(fileProcessingState.readAuthorizationsByPath?.[otherPath]).toBe(
        true,
      )
    })

    it('strict edit_transaction str_replace with allowMultiple:true does not get auto-reread authorization', async () => {
      const path = 'src/tx-multi-match.ts'
      const diskContent =
        'export const value = 1\nexport const value = 1\n'
      const fileProcessingState = createFileProcessingState()
      fileProcessingState.strictReadBeforeEdit = true
      let applied = false

      const result = await handleEditTransaction({ ...defaultTestHandlerAuthority,
        previousToolCallFinished: Promise.resolve(),
        toolCall: {
          toolCallId: 'strict-tx-allow-multiple-no-auto-reread',
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
                    allowMultiple: true,
                  },
                ],
              },
            ],
          },
        },
        fileProcessingState,
        fileContext: mockFileContext,
        runId: 'tx-allow-multiple-no-auto-reread-run',
        logger,
        requestOptionalFile: async () => diskContent,
        requestClientToolCall: async () => {
          applied = true
          return confirmedMutationOutput(
            {
              toolCallId: 'must-not-apply-allow-multiple',
              input: {},
            } as any,
            {},
            {
              projectId: mockFileContext.projectRoot,
              runId: 'tx-allow-multiple-no-auto-reread-run',
            },
          )
        },
      } as any)

      expect(applied).toBe(false)
      const output = result.output[0]
      expect(output.type).toBe('json')
      if (output.type === 'json') {
        const value = output.value as {
          basedOnRead?: string
          errorMessage?: string
          failures?: Array<{ errorMessage?: string; basedOnRead?: string }>
        }
        const errorText = [
          value.errorMessage,
          ...(value.failures?.map((failure) => failure.errorMessage) ?? []),
        ]
          .map(String)
          .join('\n')
        expect(errorText).toContain('no read authorization')
        expect(errorText).toContain(path)
        expect(errorText).toContain('read_files')
        expect(errorText).not.toContain('cap.v3.')
        expect(value).not.toHaveProperty('basedOnRead')
        for (const failure of value.failures ?? []) {
          expect(failure).not.toHaveProperty('basedOnRead')
        }
      }
      expect(
        fileProcessingState.readAuthorizationsByPath?.[path],
      ).toBeUndefined()
    })

    it('create-on-existing lifecycle error requires write_file recovery after read_files', async () => {
      const path = 'src/exists.ts'
      const diskContent = 'export const value = 1\n'
      const fileProcessingState = createFileProcessingState()

      const result = await handleEditTransaction({ ...defaultTestHandlerAuthority,
        previousToolCallFinished: Promise.resolve(),
        toolCall: {
          toolCallId: 'create-exists',
          toolName: 'edit_transaction',
          input: {
            edits: [
              {
                type: 'create',
                path,
                content: 'export const value = 2\n',
              },
            ],
          },
        },
        fileProcessingState,
        fileContext: mockFileContext,
        runId: 'create-exists-run',
        logger,
        requestOptionalFile: async () => diskContent,
        requestClientToolCall: async () => {
          throw new Error('must not apply create-on-existing')
        },
      } as any)

      const output = result.output[0]
      expect(output.type).toBe('json')
      if (output.type === 'json') {
        const value = output.value as {
          basedOnRead?: string
          errorMessage?: string
          failures?: Array<{ errorMessage?: string; basedOnRead?: string }>
        }
        const errorText = [
          value.errorMessage,
          ...(value.failures?.map((failure) => failure.errorMessage) ?? []),
        ]
          .map(String)
          .join('\n')
        expect(String(value.errorMessage)).toContain('lifecycle preflight')
        expect(errorText).toContain('write_file')
        expect(errorText).toContain('read_files')
        expect(errorText).toMatch(/read_files.*retry(?:ing)? with type "write_file"/is)
        expect(errorText).not.toContain('cap.v3.')
        expect(errorText).not.toContain('basedOnRead=')
        expect(errorText).not.toContain('Do not exploratory re-read first')
        expect(value).not.toHaveProperty('basedOnRead')
        for (const failure of value.failures ?? []) {
          expect(failure).not.toHaveProperty('basedOnRead')
        }
      }
    })

    it('create-on-existing cannot authorize overwrite before a complete read_files read', async () => {
      const path = 'src/exists-overwrite.ts'
      const diskContent = 'export const value = 1\n'
      const runId = 'create-exists-write-run'
      const fileProcessingState = createFileProcessingState()
      fileProcessingState.strictReadBeforeEdit = true

      const createResult = await handleEditTransaction({ ...defaultTestHandlerAuthority,
        previousToolCallFinished: Promise.resolve(),
        toolCall: {
          toolCallId: 'create-exists-for-write',
          toolName: 'edit_transaction',
          input: {
            edits: [
              {
                type: 'create',
                path,
                content: 'export const value = 2\n',
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
          throw new Error('must not apply create-on-existing')
        },
      } as any)

      const createOutput = createResult.output[0]
      expect(createOutput.type).toBe('json')
      if (createOutput.type !== 'json') return
      expect(fileProcessingState.readAuthorizationsByPath?.[path]).toBeUndefined()

      let writeApplied = false
      const blockedWriteResult = await handleWriteFile({ ...defaultTestHandlerAuthority,
        previousToolCallFinished: Promise.resolve(),
        toolCall: {
          toolCallId: 'write-after-create-exists-without-read',
          toolName: 'write_file',
          input: {
            path,
            content: 'export const value = 3\n',
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
          writeApplied = true
          throw new Error('must not apply write without read authority')
        },
        writeToClient: () => {},
      } as any)

      expect(writeApplied).toBe(false)
      expect(blockedWriteResult.output[0]?.type).toBe('json')
      if (blockedWriteResult.output[0]?.type === 'json') {
        const value = blockedWriteResult.output[0].value as {
          basedOnRead?: string
          errorMessage?: string
        }
        expect(String(value.errorMessage)).toContain('read_files')
        expect(String(value.errorMessage)).not.toContain('cap.v3.')
        expect(value).not.toHaveProperty('basedOnRead')
      }

      const readResult = await handleReadFiles({ ...defaultTestHandlerAuthority,
        previousToolCallFinished: Promise.resolve(),
        toolCall: {
          toolCallId: 'read-before-write-after-create-exists',
          toolName: 'read_files',
          input: { paths: [path] },
        },
        fileContext: mockFileContext,
        runId,
        fileProcessingState,
        requestFiles: async () =>
          buildWholeFileReadResultV1([path], () => diskContent),
        logger,
      } as any)

      expect(readResult.output[0]?.type).toBe('json')
      expect(fileProcessingState.readAuthorizationsByPath?.[path]).toBe(true)

      const writeResult = await handleWriteFile({ ...defaultTestHandlerAuthority,
        previousToolCallFinished: Promise.resolve(),
        toolCall: {
          toolCallId: 'write-after-create-exists-and-read',
          toolName: 'write_file',
          input: {
            path,
            content: 'export const value = 3\n',
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
          writeApplied = true
          return confirmedMutationOutput(
            toolCall,
            { [path]: 'export const value = 3\n' },
            { projectId: mockFileContext.projectRoot, runId },
          )
        },
        writeToClient: () => {},
      } as any)

      expect(writeApplied).toBe(true)
      expect(writeResult.output[0]?.type).toBe('json')
      if (writeResult.output[0]?.type === 'json') {
        expect(writeResult.output[0].value).not.toHaveProperty('errorMessage')
      }
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
      const result = await handleWriteFile({ ...defaultTestHandlerAuthority,
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
      const result = await handleWriteFile({ ...defaultTestHandlerAuthority,
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
      const result = await handleEditTransaction({ ...defaultTestHandlerAuthority,
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

    it('strict edit_transaction write_file without prior sticky auth fails closed (no auto-reread)', async () => {
      // Security: whole-file overwrite must not inherit str_replace auto-reread.
      const path = 'src/overwrite.ts'
      const diskContent = 'export const value = 1\n'
      const fileProcessingState = createFileProcessingState()
      fileProcessingState.strictReadBeforeEdit = true
      let applied = false

      const result = await handleEditTransaction({ ...defaultTestHandlerAuthority,
        previousToolCallFinished: Promise.resolve(),
        toolCall: {
          toolCallId: 'strict-transaction-write-no-auth',
          toolName: 'edit_transaction',
          input: {
            edits: [
              {
                type: 'write_file',
                path,
                content: 'export const value = 2\n',
              },
            ],
          },
        },
        fileProcessingState,
        fileContext: mockFileContext,
        runId: 'write-no-auth-run',
        logger,
        requestOptionalFile: async () => diskContent,
        requestClientToolCall: async () => {
          applied = true
          return confirmedMutationOutput(
            {
              toolCallId: 'must-not-apply',
              input: {},
            } as any,
            {},
            {
              projectId: mockFileContext.projectRoot,
              runId: 'write-no-auth-run',
            },
          )
        },
      } as any)

      expect(applied).toBe(false)
      const output = result.output[0]
      expect(output.type).toBe('json')
      if (output.type === 'json') {
        const value = output.value as {
          basedOnRead?: string
          errorMessage?: string
          failures?: Array<{ errorMessage?: string; basedOnRead?: string }>
        }
        const errorText = [
          value.errorMessage,
          ...(value.failures?.map((failure) => failure.errorMessage) ?? []),
        ]
          .map(String)
          .join('\n')
        expect(errorText).toContain('no read authorization')
        expect(errorText).toContain(path)
        expect(errorText).toContain('read_files')
        expect(errorText).not.toContain('cap.v3.')
        expect(value).not.toHaveProperty('basedOnRead')
        for (const failure of value.failures ?? []) {
          expect(failure).not.toHaveProperty('basedOnRead')
        }
      }
      // Auto-reread must not mint sticky auth for write_file auth misses.
      expect(
        fileProcessingState.readAuthorizationsByPath?.[path],
      ).toBeUndefined()
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
      const result = await handleEditTransaction({ ...defaultTestHandlerAuthority,
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
      const result = await handleEditTransaction({ ...defaultTestHandlerAuthority,
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

      const result = await handleStrReplace({ ...defaultTestHandlerAuthority,
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
      const result = await handleStrReplace({ ...defaultTestHandlerAuthority,
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

      const result = await handleEditTransaction({ ...defaultTestHandlerAuthority,
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

    it('stale rewrite_symbol capability requires fresh reads for every transaction target', async () => {
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

      const result = await handleEditTransaction({ ...defaultTestHandlerAuthority,
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
      for (const path of [symbolPath, otherPath]) {
        expect(fileProcessingState.failedEditRequiresReadByPath[path]).toBe(true)
        expect(
          fileProcessingState.editRereadRequirementsByPath?.[path],
        ).toMatchObject({
          reason: 'stale_capability',
          sourceTool: 'edit_transaction',
        })
        expect(fileProcessingState.readAuthorizationsByPath?.[path]).toBeUndefined()
        expect(
          fileProcessingState.readAuthorizationHashesByPath?.[path],
        ).toBeUndefined()
      }
      expect(result.output[0]?.type).toBe('json')
      if (result.output[0]?.type === 'json') {
        const value = result.output[0].value as {
          errorMessage?: string
          failures?: Array<{ errorMessage?: string }>
        }
        expect(String(value.failures?.[0]?.errorMessage)).toContain(
          'readCapability-covered symbol content is stale',
        )
        expect(String(value.errorMessage)).toContain(
          'Atomic recovery requires fresh read state for every transaction target',
        )
        expect(String(value.errorMessage)).toContain(
          'Re-read all targets and rebuild the complete transaction',
        )
        expect(String(value.errorMessage)).toContain(symbolPath)
        expect(String(value.errorMessage)).toContain(otherPath)
      }
    })

    it('write_file blocks traversal paths before reading or applying', async () => {
      const fileProcessingState = createFileProcessingState()

      const result = await handleWriteFile({ ...defaultTestHandlerAuthority,
        previousToolCallFinished: Promise.resolve(),
        toolCall: {
          toolCallId: 'write-traversal-blocked',
          toolName: 'write_file',
          input: {
            path: '../outside.ts',
            instructions: 'Attempt outside write',
            content: 'export const value = 1\n',
          },
        },
        agentState: { messageHistory: [] },
        clientSessionId: 'test-session',
        fileProcessingState,
        fingerprintId: 'test-fingerprint',
        logger,
        prompt: undefined,
        userId: undefined,
        userInputId: 'test-input',
        requestOptionalFile: async () => {
          throw new Error(
            'requestOptionalFile must not be called for blocked traversal',
          )
        },
        requestClientToolCall: async () => {
          throw new Error(
            'client apply must not be called for blocked traversal',
          )
        },
        writeToClient: () => {},
      } as any)

      const output = result.output[0]
      expect(output.type).toBe('json')
      if (output.type === 'json') {
        const value = output.value as { file?: string; errorMessage?: string }
        expect(value.file).toBe('../outside.ts')
        expect(String(value.errorMessage)).toContain('path traversal blocked')
      }
      expect(fileProcessingState.promisesByPath['']).toBeUndefined()
      expect(fileProcessingState.allPromises).toHaveLength(0)
    })

    it('strict write_file blocks existing-file overwrites without prior read and does not call client apply', async () => {
      const path = 'src/helper.ts'
      const diskContent = 'export const value = 1\n'
      const fileProcessingState = createFileProcessingState()
      fileProcessingState.strictReadBeforeEdit = true

      const result = await handleWriteFile({ ...defaultTestHandlerAuthority,
        previousToolCallFinished: Promise.resolve(),
        toolCall: {
          toolCallId: 'strict-write-blocked',
          toolName: 'write_file',
          input: {
            path,
            instructions: 'Update helper value',
            content: 'export const value = 2\n',
          },
        },
        agentState: { messageHistory: [] },
        clientSessionId: 'test-session',
        fileProcessingState,
        fingerprintId: 'test-fingerprint',
        logger,
        prompt: undefined,
        userId: undefined,
        userInputId: 'test-input',
        requestOptionalFile: async ({ filePath }: { filePath: string }) =>
          filePath === path ? diskContent : null,
        requestClientToolCall: async () => {
          throw new Error(
            'client apply must not be called for blocked write_file',
          )
        },
        writeToClient: () => {},
      } as any)

      const output = result.output[0]
      expect(output.type).toBe('json')
      if (output.type === 'json') {
        const value = output.value as { file?: string; errorMessage?: string }
        expect(value.file).toBe(path)
        expect(String(value.errorMessage)).toContain('write_file blocked')
        // When a whole-file capability can be echoed, primary recovery is basedOnRead
        // retry (no exploratory re-read); read_files remains only if no capability.
        expect(String(value.errorMessage)).toMatch(
          /basedOnRead|read_files/,
        )
      }
    })

    it('strict write_file blocks a whole-file overwrite after only a prior range-anchored edit', async () => {
      const path = 'src/range-edited.ts'
      const diskContent = 'export const value = 1\n'
      const fileProcessingState = createFileProcessingState()
      fileProcessingState.strictReadBeforeEdit = true
      fileProcessingState.promisesByPath[path] = [
        Promise.resolve({
          tool: 'str_replace' as const,
          path,
          toolCallId: 'range-edit',
          content: 'export const value = 2\n',
          messages: [],
        }),
      ]

      let clientApplyCount = 0
      const result = await handleWriteFile({ ...defaultTestHandlerAuthority,
        previousToolCallFinished: Promise.resolve(),
        toolCall: {
          toolCallId: 'whole-write-after-range-edit',
          toolName: 'write_file',
          input: { path, content: 'export const value = 3\n' },
        },
        agentState: { messageHistory: [] },
        clientSessionId: 'test-session',
        fileProcessingState,
        fingerprintId: 'test-fingerprint',
        logger,
        prompt: undefined,
        userId: undefined,
        userInputId: 'test-input',
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
          'prior range-anchored edit',
        )
      }
    })

    it('write_file failed-edit gate blocks an existing file even when stale whole-file authorization remains', async () => {
      const path = 'src/failed-write.ts'
      const diskContent = 'export const value = 1\n'
      const fileProcessingState = createFileProcessingState()
      fileProcessingState.strictReadBeforeEdit = true
      fileProcessingState.failedEditRequiresReadByPath[path] = true
      fileProcessingState.readAuthorizationsByPath = { [path]: true }

      let clientApplyCount = 0
      const result = await handleWriteFile({ ...defaultTestHandlerAuthority,
        previousToolCallFinished: Promise.resolve(),
        toolCall: {
          toolCallId: 'blocked-after-failed-write',
          toolName: 'write_file',
          input: { path, content: 'export const value = 2\n' },
        },
        agentState: { messageHistory: [] },
        clientSessionId: 'test-session',
        fileProcessingState,
        fingerprintId: 'test-fingerprint',
        logger,
        prompt: undefined,
        userId: undefined,
        userInputId: 'test-input',
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
          'previous edit failed',
        )
      }
    })

    it('strict write_file allows new-file creation without prior read', async () => {
      const path = 'src/new-helper.ts'
      const fileProcessingState = createFileProcessingState()
      fileProcessingState.strictReadBeforeEdit = true

      let applied = false
      const result = await handleWriteFile({ ...defaultTestHandlerAuthority,
        previousToolCallFinished: Promise.resolve(),
        toolCall: {
          toolCallId: 'strict-write-new-file',
          toolName: 'write_file',
          input: {
            path,
            instructions: 'Create helper value',
            content: 'export const value = 1\n',
          },
        },
        agentState: { messageHistory: [] },
        clientSessionId: 'test-session',
        fileProcessingState,
        fingerprintId: 'test-fingerprint',
        logger,
        prompt: undefined,
        userId: undefined,
        userInputId: 'test-input',
        requestOptionalFile: async () => null,
        requestClientToolCall: async (toolCall: any) => {
          applied = true
          return [
            {
              type: 'json' as const,
              value: { file: toolCall.input.path, message: 'created' },
            },
          ]
        },
        writeToClient: () => {},
      } as any)

      expect(applied).toBe(true)
      const output = result.output[0]
      expect(output.type).toBe('json')
      if (output.type === 'json') {
        expect(output.value).not.toHaveProperty('errorMessage')
      }
    })

    it('strict write_file new-file creation grants read auth so a follow-up str_replace can edit without re-reading', async () => {
      const path = 'src/newly-written-helper.ts'
      const writtenContent = 'export const value = 1\n'
      const fileProcessingState = createFileProcessingState()
      fileProcessingState.strictReadBeforeEdit = true

      let writeApplied = false
      const writeResult = await handleWriteFile({ ...defaultTestHandlerAuthority,
        previousToolCallFinished: Promise.resolve(),
        toolCall: {
          toolCallId: 'strict-write-new-file-grants-auth',
          toolName: 'write_file',
          input: {
            path,
            instructions: 'Create helper value',
            content: writtenContent,
          },
        },
        agentState: { messageHistory: [] },
        clientSessionId: 'test-session',
        fileProcessingState,
        fingerprintId: 'test-fingerprint',
        logger,
        prompt: undefined,
        userId: undefined,
        userInputId: 'test-input',
        requestOptionalFile: async () => null,
        requestClientToolCall: async (toolCall: any) => {
          writeApplied = true
          return confirmedMutationOutput(toolCall, {
            [path]: writtenContent,
          })
        },
        writeToClient: () => {},
      } as any)

      expect(writeApplied).toBe(true)
      const writeOutput = writeResult.output[0]
      expect(writeOutput.type).toBe('json')
      if (writeOutput.type === 'json') {
        expect(writeOutput.value).not.toHaveProperty('errorMessage')
      }

      // The fix: a successful write_file (even on a brand-new file with no prior
      // read) must grant a one-shot read authorization so the very common
      // write-then-edit flow does not need a redundant read round-trip.
      expect(fileProcessingState.readAuthorizationsByPath?.[path]).toBe(true)

      // A follow-up str_replace must succeed using the just-granted auth
      // without the agent having to call read_files separately.
      let strReplaceApplied = false
      const strReplaceResult = await handleStrReplace({ ...defaultTestHandlerAuthority,
        previousToolCallFinished: Promise.resolve(),
        toolCall: {
          toolCallId: 'strict-edit-after-new-write',
          toolName: 'str_replace',
          input: {
            path,
            replacements: [
              {
                oldString: 'export const value = 1',
                newString: 'export const value = 2',
                allowMultiple: false,
              },
            ],
          },
        },
        fileProcessingState,
        logger,
        requestOptionalFile: async ({ filePath }: { filePath: string }) =>
          filePath === path ? writtenContent : null,
        requestClientToolCall: async (toolCall: any) => {
          strReplaceApplied = true
          return confirmedMutationOutput(toolCall, {
            [path]: 'export const value = 2\n',
          })
        },
        writeToClient: () => {},
      } as any)

      expect(strReplaceApplied).toBe(true)
      const strReplaceOutput = strReplaceResult.output[0]
      expect(strReplaceOutput.type).toBe('json')
      if (strReplaceOutput.type === 'json') {
        expect(strReplaceOutput.value).not.toHaveProperty('errorMessage')
      }

      // Sticky auth: the write_file grant (and the follow-up str_replace)
      // remain in force across subsequent edits on the same path. A third
      // str_replace without re-reading must SUCCEED and keep auth alive,
      // because the strict gate only re-enables after a failed edit or an
      // externally-changed file (anchored with a fresh basedOnRead capability).
      let thirdApplyCount = 0
      const thirdResult = await handleStrReplace({ ...defaultTestHandlerAuthority,
        previousToolCallFinished: Promise.resolve(),
        toolCall: {
          toolCallId: 'strict-edit-sticky-after-write',
          toolName: 'str_replace',
          input: {
            path,
            replacements: [
              {
                oldString: 'export const value = 2',
                newString: 'export const value = 3',
                allowMultiple: false,
              },
            ],
          },
        },
        fileProcessingState,
        logger,
        requestOptionalFile: async ({ filePath }: { filePath: string }) =>
          filePath === path ? writtenContent : null,
        requestClientToolCall: async (toolCall: any) => {
          thirdApplyCount += 1
          return confirmedMutationOutput(toolCall, {
            [path]: 'export const value = 3\n',
          })
        },
        writeToClient: () => {},
      } as any)

      // Third str_replace applied via sticky auth (no re-read required).
      expect(thirdApplyCount).toBe(1)
      const thirdOutput = thirdResult.output[0]
      expect(thirdOutput.type).toBe('json')
      if (thirdOutput.type === 'json') {
        expect(thirdOutput.value).not.toHaveProperty('errorMessage')
      }
      // Auth remains true across the entire write -> edit -> edit -> edit
      // chain with no intervening read_files calls.
      expect(fileProcessingState.readAuthorizationsByPath?.[path]).toBe(true)
    })

    it('strict read_files authorizes one write_file overwrite and the authorization is preserved after success', async () => {
      const path = 'src/helper.ts'
      const diskContent = 'export const value = 1\n'
      const fileProcessingState = createFileProcessingState()
      fileProcessingState.strictReadBeforeEdit = true

      await handleReadFiles({ ...defaultTestHandlerAuthority,
        previousToolCallFinished: Promise.resolve(),
        toolCall: {
          toolCallId: 'strict-write-read',
          toolName: 'read_files',
          input: { paths: [path] },
        },
        fileContext: mockFileContext,
        fileProcessingState,
        requestFiles: async ({ filePaths }: { filePaths: string[] }) =>
          buildWholeFileReadResultV1(filePaths, (filePath) =>
            filePath === path ? diskContent : null,
          ),
        logger,
      } as any)

      expect(fileProcessingState.readAuthorizationsByPath?.[path]).toBe(true)

      let applied = false
      const result = await handleWriteFile({ ...defaultTestHandlerAuthority,
        previousToolCallFinished: Promise.resolve(),
        toolCall: {
          toolCallId: 'strict-write-authorized',
          toolName: 'write_file',
          input: {
            path,
            instructions: 'Update helper value',
            content: 'export const value = 2\n',
          },
        },
        agentState: { messageHistory: [] },
        clientSessionId: 'test-session',
        fileProcessingState,
        fingerprintId: 'test-fingerprint',
        logger,
        prompt: undefined,
        userId: undefined,
        userInputId: 'test-input',
        requestOptionalFile: async ({ filePath }: { filePath: string }) =>
          filePath === path ? diskContent : null,
        requestClientToolCall: async (toolCall: any) => {
          applied = true
          return confirmedMutationOutput(toolCall, {
            [path]: 'export const value = 2\n',
          })
        },
        writeToClient: () => {},
      } as any)

      expect(applied).toBe(true)
      const output = result.output[0]
      expect(output.type).toBe('json')
      if (output.type === 'json') {
        expect(output.value).not.toHaveProperty('errorMessage')
      }
      expect(fileProcessingState.readAuthorizationsByPath?.[path]).toBe(true)
      expect(fileProcessingState.readAuthorizationHashesByPath?.[path]).toBe(
        getContentHash('export const value = 2\n'),
      )
    })

    it('strict replace_range blocks without prior read or freshness anchor and does not call client apply', async () => {
      const path = 'src/helper.ts'
      const fileProcessingState = createFileProcessingState()
      fileProcessingState.strictReadBeforeEdit = true

      const result = await handleReplaceRange({ ...defaultTestHandlerAuthority,
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

      const successResult = await handleReplaceRange({ ...defaultTestHandlerAuthority,
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

      const errorResult = await handleReplaceRange({ ...defaultTestHandlerAuthority,
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
      expect(fileProcessingState.readAuthorizationsByPath?.[path]).toBeUndefined()
    })

    it('strict replace_range rejects a legacy pathless expectedHash as authorization', async () => {
      const path = 'src/helper.ts'
      const fileProcessingState = createFileProcessingState()
      fileProcessingState.strictReadBeforeEdit = true
      // No read authorization registered — only expectedHash as anchor.

      let applied = false
      const result = await handleReplaceRange({ ...defaultTestHandlerAuthority,
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
      const result = await handleReplaceRange({ ...defaultTestHandlerAuthority,
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

    it('Reduction D: strict str_replace error message omits "in this turn" and "Recovery required:"', async () => {
      const path = 'src/helper.ts'
      const fileProcessingState = createFileProcessingState()
      fileProcessingState.strictReadBeforeEdit = true

      // File missing so auto-reread fails closed and surfaces the auth error.
      const result = await handleStrReplace({ ...defaultTestHandlerAuthority,
        previousToolCallFinished: Promise.resolve(),
        toolCall: {
          toolCallId: 'strict-msg-check',
          toolName: 'str_replace',
          input: {
            path,
            replacements: [
              {
                oldString: 'export const value = 1',
                newString: 'export const value = 2',
                allowMultiple: false,
              },
            ],
          },
        },
        fileProcessingState,
        requestOptionalFile: async () => null,
        requestClientToolCall: async () => {
          throw new Error(
            'client apply must not be called for blocked str_replace',
          )
        },
        writeToClient: () => {},
      } as any)

      const output = result.output[0]
      expect(output.type).toBe('json')
      if (output.type === 'json') {
        const value = output.value as { errorMessage?: string }
        expect(String(value.errorMessage)).not.toContain('in this turn')
        expect(String(value.errorMessage)).not.toContain('Recovery required:')
        // Should still mention the actionable next step.
        expect(String(value.errorMessage)).toContain('read_files')
      }
    })

    it('does not let a range basedOnRead capability authorize a whole-file overwrite', async () => {
      const path = 'src/helper.ts'
      const diskContent = 'export const value = 1\n'
      const runId = 'range-write-floor-run'
      const fileProcessingState = createFileProcessingState()
      fileProcessingState.strictReadBeforeEdit = true
      const rangeCapability = encodeReadCapabilityToken({
        startLine: 1,
        endLine: 1,
        hash: getContentHash(diskContent.trimEnd()),
        scope: {
          projectId: mockFileContext.projectRoot,
          path,
          runId,
        },
      })

      // A range capability is not sufficient proof for replacing the whole
      // file. Strict mode requires a successful whole-file read authorization.
      const writeResult = await handleWriteFile({ ...defaultTestHandlerAuthority,
        previousToolCallFinished: Promise.resolve(),
        toolCall: {
          toolCallId: 'e-bypass-write',
          toolName: 'write_file',
          input: {
            path,
            instructions: 'Update helper value',
            content: 'export const value = 2\n',
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

    it('strict read_files auth survives across separate fileProcessingState instances (cross-turn state isolation)', async () => {
      // available, otherwise the strict gate blocks the edit on the first
      // attempt and forces a redundant read round-trip.
      //
      // The fix: readAuthorizationsByPath must be persisted on agentState
      // (which survives across turns) and hydrated into the per-turn
      // fileProcessingState at the start of each invocation. The test below
      // mirrors that hydration: after read_files populates state A, the
      // authorization set is copied into state B (the next turn's state).
      const path = 'src/helper.ts'
      const diskContent = 'export const value = 1\n'
      const strictReadBeforeEdit = true

      // --- Turn 1: read_files populates auth on state A ---
      const stateA = createFileProcessingState()
      stateA.strictReadBeforeEdit = strictReadBeforeEdit

      await handleReadFiles({ ...defaultTestHandlerAuthority,
        previousToolCallFinished: Promise.resolve(),
        toolCall: {
          toolCallId: 'cross-turn-read',
          toolName: 'read_files',
          input: { paths: [path] },
        },
        fileContext: mockFileContext,
        fileProcessingState: stateA,
        requestFiles: async ({ filePaths }: { filePaths: string[] }) =>
          buildWholeFileReadResultV1(filePaths, (filePath) =>
            filePath === path ? diskContent : null,
          ),
        logger,
      } as any)

      expect(stateA.readAuthorizationsByPath?.[path]).toBe(true)

      // --- Turn boundary: persist auth from state A to agentState, then
      // hydrate a fresh state B (simulating what processStream must do). ---
      const persistedAuth = { ...(stateA.readAuthorizationsByPath ?? {}) }
      const persistedHashes = {
        ...(stateA.readAuthorizationHashesByPath ?? {}),
      }
      expect(persistedAuth[path]).toBe(true)
      expect(persistedHashes[path]).toBe(getContentHash(diskContent))

      const stateB = createFileProcessingState()
      stateB.strictReadBeforeEdit = strictReadBeforeEdit
      stateB.readAuthorizationsByPath = { ...persistedAuth }
      stateB.readAuthorizationHashesByPath = { ...persistedHashes }

      // --- Turn 2: str_replace on the fresh state B must succeed without
      // requiring the agent to re-read the file. ---
      let applyCount = 0
      const result = await handleStrReplace({ ...defaultTestHandlerAuthority,
        previousToolCallFinished: Promise.resolve(),
        toolCall: {
          toolCallId: 'cross-turn-edit',
          toolName: 'str_replace',
          input: {
            path,
            replacements: [
              {
                oldString: 'export const value = 1',
                newString: 'export const value = 2',
                allowMultiple: false,
              },
            ],
          },
        },
        fileProcessingState: stateB,
        logger,
        requestOptionalFile: async ({ filePath }: { filePath: string }) =>
          filePath === path ? diskContent : null,
        requestClientToolCall: async (toolCall: any) => {
          applyCount += 1
          return confirmedMutationOutput(toolCall, {
            [path]: 'export const value = 2\n',
          })
        },
        writeToClient: () => {},
      } as any)

      expect(applyCount).toBe(1)
      const output = result.output[0]
      expect(output.type).toBe('json')
      if (output.type === 'json') {
        expect(output.value).not.toHaveProperty('errorMessage')
      }
      // The fix must keep the auth alive after the cross-turn edit so a
      // third turn's edit (or a follow-up edit_transaction) also succeeds
      // without re-reading.
      expect(stateB.readAuthorizationsByPath?.[path]).toBe(true)
    })

    it('strict str_replace on a fresh fileProcessingState without hydrated auth auto-rereads once and applies', async () => {
      // Without cross-turn hydration, auto-reread-once still recovers for a
      // unique str_replace in-process; sticky may refresh after successful apply.
      const path = 'src/helper.ts'
      const diskContent = 'export const value = 1\n'

      const stateA = createFileProcessingState()
      stateA.strictReadBeforeEdit = true
      await handleReadFiles({ ...defaultTestHandlerAuthority,
        previousToolCallFinished: Promise.resolve(),
        toolCall: {
          toolCallId: 'bug-demo-read',
          toolName: 'read_files',
          input: { paths: [path] },
        },
        fileContext: mockFileContext,
        fileProcessingState: stateA,
        requestFiles: async ({ filePaths }: { filePaths: string[] }) =>
          buildWholeFileReadResultV1(filePaths, (filePath) =>
            filePath === path ? diskContent : null,
          ),
        logger,
      } as any)
      expect(stateA.readAuthorizationsByPath?.[path]).toBe(true)

      const stateB = createFileProcessingState()
      stateB.strictReadBeforeEdit = true
      expect(stateB.readAuthorizationsByPath?.[path]).toBeUndefined()

      let applyCount = 0
      const result = await handleStrReplace({ ...defaultTestHandlerAuthority,
        previousToolCallFinished: Promise.resolve(),
        toolCall: {
          toolCallId: 'bug-demo-edit-auto-reread',
          toolName: 'str_replace',
          input: {
            path,
            replacements: [
              {
                oldString: 'export const value = 1',
                newString: 'export const value = 2',
                allowMultiple: false,
              },
            ],
          },
        },
        fileProcessingState: stateB,
        logger,
        requestOptionalFile: async ({ filePath }: { filePath: string }) =>
          filePath === path ? diskContent : null,
        requestClientToolCall: async (toolCall: any) => {
          applyCount += 1
          return confirmedMutationOutput(toolCall, {
            [path]: 'export const value = 2\n',
          })
        },
        writeToClient: () => {},
      } as any)

      expect(applyCount).toBe(1)
      const output = result.output[0]
      expect(output.type).toBe('json')
      if (output.type === 'json') {
        expect(output.value).not.toHaveProperty('errorMessage')
      }
      // Post-apply sticky from observed post-edit content.
      expect(stateB.readAuthorizationsByPath?.[path]).toBe(true)
      expect(stateB.readAuthorizationHashesByPath?.[path]).toBe(
        getContentHash('export const value = 2\n'),
      )
    })

    it('write_file fails closed under context_compacted even when sticky hash matches disk', async () => {
      // COMPACTION-STICKY-BLIND-WRITE: hash-fresh alone must not authorize overwrite.
      const path = 'src/compacted-write.ts'
      const diskContent = 'export const value = 1\n'
      const fileProcessingState = createFileProcessingState()
      fileProcessingState.strictReadBeforeEdit = true
      fileProcessingState.readAuthorizationsByPath = { [path]: true }
      fileProcessingState.readAuthorizationHashesByPath = {
        [path]: getContentHash(diskContent),
      }
      fileProcessingState.editRereadRequirementsByPath = {
        [path]: { reason: 'context_compacted', sourceTool: 'compaction' },
      }
      fileProcessingState.failedEditRequiresReadByPath[path] = true

      let writeApplied = false
      const writeResult = await handleWriteFile({ ...defaultTestHandlerAuthority,
        previousToolCallFinished: Promise.resolve(),
        toolCall: {
          toolCallId: 'write-after-compaction',
          toolName: 'write_file',
          input: { path, content: 'export const value = 2\n' },
        },
        agentState: { messageHistory: [] },
        clientSessionId: 'test-session',
        fileProcessingState,
        fingerprintId: 'test-fingerprint',
        logger,
        prompt: undefined,
        userId: undefined,
        userInputId: 'test-input',
        requestOptionalFile: async () => diskContent,
        requestClientToolCall: async () => {
          writeApplied = true
          return []
        },
        writeToClient: () => {},
      } as any)

      expect(writeApplied).toBe(false)
      expect(writeResult.output[0]?.type).toBe('json')
      if (writeResult.output[0]?.type === 'json') {
        const msg = String((writeResult.output[0].value as any).errorMessage)
        expect(msg).toMatch(/context compaction|read_files/i)
        expect(msg).not.toContain('cap.v3.')
        expect(msg).not.toContain('basedOnRead=')
      }
      // Marker must remain until a real whole-file re-read or valid basedOnRead.
      expect(
        fileProcessingState.editRereadRequirementsByPath?.[path]?.reason,
      ).toBe('context_compacted')

      // str_replace unique may still apply on hash-fresh and clear the marker.
      let replaceApplied = false
      const replaceResult = await handleStrReplace({ ...defaultTestHandlerAuthority,
        previousToolCallFinished: Promise.resolve(),
        toolCall: {
          toolCallId: 'str-replace-after-compaction',
          toolName: 'str_replace',
          input: {
            path,
            replacements: [
              {
                oldString: 'export const value = 1',
                newString: 'export const value = 3',
                allowMultiple: false,
              },
            ],
          },
        },
        fileProcessingState,
        logger,
        requestOptionalFile: async () => diskContent,
        requestClientToolCall: async (toolCall: any) => {
          replaceApplied = true
          return confirmedMutationOutput(toolCall, {
            [path]: 'export const value = 3\n',
          })
        },
        writeToClient: () => {},
      } as any)

      expect(replaceApplied).toBe(true)
      expect(replaceResult.output[0]?.type).toBe('json')
      if (replaceResult.output[0]?.type === 'json') {
        expect(replaceResult.output[0].value).not.toHaveProperty('errorMessage')
      }
      expect(
        fileProcessingState.editRereadRequirementsByPath?.[path],
      ).toBeUndefined()
    })

    it('failed str_replace after compaction revokes authorization so write_file stays blocked', async () => {
      // A failed no-match may strengthen context_compacted to stale_capability,
      // but it must revoke authority and keep whole-file overwrite blocked.
      const path = 'src/compacted-failed-replace.ts'
      const diskContent = 'export const value = 1\n'
      const fileProcessingState = createFileProcessingState()
      fileProcessingState.strictReadBeforeEdit = true
      fileProcessingState.readAuthorizationsByPath = { [path]: true }
      fileProcessingState.readAuthorizationHashesByPath = {
        [path]: getContentHash(diskContent),
      }
      fileProcessingState.editRereadRequirementsByPath = {
        [path]: { reason: 'context_compacted', sourceTool: 'compaction' },
      }
      fileProcessingState.failedEditRequiresReadByPath[path] = true

      const failResult = await handleStrReplace({ ...defaultTestHandlerAuthority,
        previousToolCallFinished: Promise.resolve(),
        toolCall: {
          toolCallId: 'failed-replace-after-compaction',
          toolName: 'str_replace',
          input: {
            path,
            replacements: [
              {
                oldString: 'export const missing = 99',
                newString: 'export const missing = 100',
                allowMultiple: false,
              },
            ],
          },
        },
        fileProcessingState,
        logger,
        requestOptionalFile: async () => diskContent,
        requestClientToolCall: async () => {
          throw new Error('must not apply failed str_replace')
        },
        writeToClient: () => {},
      } as any)

      expect(failResult.output[0]?.type).toBe('json')
      expect(
        fileProcessingState.editRereadRequirementsByPath?.[path]?.reason,
      ).toBe('stale_capability')
      expect(fileProcessingState.readAuthorizationsByPath?.[path]).toBeUndefined()
      expect(
        fileProcessingState.readAuthorizationHashesByPath?.[path],
      ).toBeUndefined()

      let writeApplied = false
      const writeResult = await handleWriteFile({ ...defaultTestHandlerAuthority,
        previousToolCallFinished: Promise.resolve(),
        toolCall: {
          toolCallId: 'write-after-failed-compacted-replace',
          toolName: 'write_file',
          input: { path, content: 'export const value = 999\n' },
        },
        agentState: { messageHistory: [] },
        clientSessionId: 'test-session',
        fileProcessingState,
        fingerprintId: 'test-fingerprint',
        logger,
        prompt: undefined,
        userId: undefined,
        userInputId: 'test-input',
        requestOptionalFile: async () => diskContent,
        requestClientToolCall: async () => {
          writeApplied = true
          return []
        },
        writeToClient: () => {},
      } as any)

      expect(writeApplied).toBe(false)
      expect(writeResult.output[0]?.type).toBe('json')
      if (writeResult.output[0]?.type === 'json') {
        expect(
          String((writeResult.output[0].value as any).errorMessage),
        ).toMatch(/context compaction|read_files|basedOnRead/i)
      }
      expect(
        fileProcessingState.editRereadRequirementsByPath?.[path]?.reason,
      ).toBe('stale_capability')
    })

    it('allowMultiple str_replace apply does not clear context_compacted so write_file stays blocked', async () => {
      // COMPACTION-ALLOWMULTIPLE-NO-CLEAR: a blind replace-all apply is not
      // evidence the model knows the file content, so it must NOT clear the
      // context_compacted marker. A subsequent whole-file overwrite stays
      // blocked (a unique str_replace apply WOULD have cleared it).
      const path = 'src/compacted.ts'
      const initialContent = 'const x = 1\nconst y = 2\n'
      const replacedContent = 'const x = 10\nconst y = 2\n'
      const runId = 'compacted-allow-multiple-run'
      const fileProcessingState = createFileProcessingState()
      fileProcessingState.strictReadBeforeEdit = true
      fileProcessingState.readAuthorizationsByPath = { [path]: true }
      fileProcessingState.readAuthorizationHashesByPath = {
        [path]: getContentHash(initialContent),
      }
      fileProcessingState.editRereadRequirementsByPath = {
        [path]: { reason: 'context_compacted', sourceTool: 'compaction' },
      }
      fileProcessingState.failedEditRequiresReadByPath[path] = true

      let applied = false
      const replaceResult = await handleEditTransaction({ ...defaultTestHandlerAuthority,
        previousToolCallFinished: Promise.resolve(),
        toolCall: {
          toolCallId: 'allow-multiple-replace-after-compaction',
          toolName: 'edit_transaction',
          input: {
            edits: [
              {
                type: 'str_replace',
                path,
                replacements: [
                  {
                    oldString: 'const x = 1',
                    newString: 'const x = 10',
                    allowMultiple: true,
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
        requestOptionalFile: async () => initialContent,
        requestClientToolCall: async (toolCall: any) => {
          applied = true
          return confirmedMutationOutput(
            toolCall,
            { [path]: replacedContent },
            { projectId: mockFileContext.projectRoot, runId },
          )
        },
      } as any)

      expect(applied).toBe(true)
      expect(replaceResult.output[0]?.type).toBe('json')
      if (replaceResult.output[0]?.type === 'json') {
        expect(replaceResult.output[0].value).not.toHaveProperty('errorMessage')
      }
      // The blind replace-all apply must NOT clear the marker.
      expect(
        fileProcessingState.editRereadRequirementsByPath?.[path]?.reason,
      ).toBe('context_compacted')

      let writeApplied = false
      const writeResult = await handleWriteFile({ ...defaultTestHandlerAuthority,
        previousToolCallFinished: Promise.resolve(),
        toolCall: {
          toolCallId: 'write-after-allow-multiple-compaction',
          toolName: 'write_file',
          input: { path, content: 'const x = 100\nconst y = 2\n' },
        },
        agentState: { messageHistory: [] },
        clientSessionId: 'test-session',
        fileProcessingState,
        fingerprintId: 'test-fingerprint',
        logger,
        prompt: undefined,
        userId: undefined,
        userInputId: 'test-input',
        requestOptionalFile: async () => replacedContent,
        requestClientToolCall: async () => {
          writeApplied = true
          return []
        },
        writeToClient: () => {},
      } as any)

      expect(writeApplied).toBe(false)
      expect(writeResult.output[0]?.type).toBe('json')
      if (writeResult.output[0]?.type === 'json') {
        // The block is attributed to the context_compacted reread requirement;
        // the exact recovery wording (read_files vs basedOnRead-echo) may vary.
        expect(
          String((writeResult.output[0].value as any).errorMessage),
        ).toMatch(/compaction|read_files|basedOnRead/i)
      }
      expect(
        fileProcessingState.editRereadRequirementsByPath?.[path]?.reason,
      ).toBe('context_compacted')
    })

    it('unique str_replace apply clears context_compacted so write_file can proceed', async () => {
      // Contrast: a unique-anchor str_replace apply IS evidence the model knows
      // the file content, so it clears the context_compacted marker and a later
      // whole-file overwrite is authorized.
      const path = 'src/compacted.ts'
      const initialContent = 'const x = 1\nconst y = 2\n'
      const replacedContent = 'const x = 10\nconst y = 2\n'
      const runId = 'compacted-unique-replace-run'
      const fileProcessingState = createFileProcessingState()
      fileProcessingState.strictReadBeforeEdit = true
      fileProcessingState.readAuthorizationsByPath = { [path]: true }
      fileProcessingState.readAuthorizationHashesByPath = {
        [path]: getContentHash(initialContent),
      }
      fileProcessingState.editRereadRequirementsByPath = {
        [path]: { reason: 'context_compacted', sourceTool: 'compaction' },
      }
      fileProcessingState.failedEditRequiresReadByPath[path] = true

      let applied = false
      const replaceResult = await handleEditTransaction({ ...defaultTestHandlerAuthority,
        previousToolCallFinished: Promise.resolve(),
        toolCall: {
          toolCallId: 'unique-replace-after-compaction',
          toolName: 'edit_transaction',
          input: {
            edits: [
              {
                type: 'str_replace',
                path,
                replacements: [
                  {
                    oldString: 'const x = 1',
                    newString: 'const x = 10',
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
        requestOptionalFile: async () => initialContent,
        requestClientToolCall: async (toolCall: any) => {
          applied = true
          return confirmedMutationOutput(
            toolCall,
            { [path]: replacedContent },
            { projectId: mockFileContext.projectRoot, runId },
          )
        },
      } as any)

      expect(applied).toBe(true)
      expect(replaceResult.output[0]?.type).toBe('json')
      if (replaceResult.output[0]?.type === 'json') {
        expect(replaceResult.output[0].value).not.toHaveProperty('errorMessage')
      }
      // The unique-anchor apply clears the marker.
      expect(
        fileProcessingState.editRereadRequirementsByPath?.[path],
      ).toBeUndefined()

      let writeApplied = false
      const writeResult = await handleWriteFile({ ...defaultTestHandlerAuthority,
        previousToolCallFinished: Promise.resolve(),
        toolCall: {
          toolCallId: 'write-after-unique-compaction',
          toolName: 'write_file',
          input: { path, content: 'const x = 100\nconst y = 2\n' },
        },
        agentState: { messageHistory: [] },
        clientSessionId: 'test-session',
        fileProcessingState,
        fingerprintId: 'test-fingerprint',
        logger,
        prompt: undefined,
        userId: undefined,
        userInputId: 'test-input',
        requestOptionalFile: async () => replacedContent,
        requestClientToolCall: async (toolCall: any) => {
          writeApplied = true
          return confirmedMutationOutput(
            toolCall,
            { [path]: 'const x = 100\nconst y = 2\n' },
            { projectId: mockFileContext.projectRoot, runId },
          )
        },
        writeToClient: () => {},
      } as any)

      expect(writeApplied).toBe(true)
      expect(writeResult.output[0]?.type).toBe('json')
      if (writeResult.output[0]?.type === 'json') {
        expect(writeResult.output[0].value).not.toHaveProperty('errorMessage')
      }
    })

    it('proper-subset range read after compaction does not clear context_compacted', async () => {
      // COMPACTION-MARKER-CLEARED-BY-PARTIAL-OR-SCOPED-READ
      const path = 'src/compacted-range.ts'
      const diskContent = 'export const value = 1\nexport const other = 2\n'
      const sourceContent = 'export const value = 1'
      const rangeHash = getContentHash(sourceContent)
      const fileProcessingState = createFileProcessingState()
      fileProcessingState.strictReadBeforeEdit = true
      fileProcessingState.readAuthorizationsByPath = { [path]: true }
      fileProcessingState.readAuthorizationHashesByPath = {
        [path]: getContentHash(diskContent),
      }
      fileProcessingState.editRereadRequirementsByPath = {
        [path]: { reason: 'context_compacted', sourceTool: 'compaction' },
      }
      fileProcessingState.failedEditRequiresReadByPath[path] = true

      await handleReadFiles({ ...defaultTestHandlerAuthority,
        previousToolCallFinished: Promise.resolve(),
        toolCall: {
          toolCallId: 'range-after-compaction',
          toolName: 'read_files',
          input: { ranges: [{ path, startLine: 1, endLine: 1 }] },
        },
        fileContext: mockFileContext,
        fileProcessingState,
        requestFiles: async () =>
          buildReadFilesResultV1([
            {
              selector: 'range',
              requestIndex: 0,
              path,
              status: 'ok',
              content: '1\texport const value = 1',
              sourceContent,
              startLine: 1,
              endLine: 1,
              totalLines: 2,
              complete: true,
              editAnchor: {
                startLine: 1,
                endLine: 1,
                contentHash: rangeHash,
                readCapability: 'cap.v3.test',
              },
            },
          ]),
        logger,
      } as any)

      expect(
        fileProcessingState.editRereadRequirementsByPath?.[path]?.reason,
      ).toBe('context_compacted')

      let writeApplied = false
      const writeResult = await handleWriteFile({ ...defaultTestHandlerAuthority,
        previousToolCallFinished: Promise.resolve(),
        toolCall: {
          toolCallId: 'write-after-compacted-range',
          toolName: 'write_file',
          input: { path, content: 'export const value = 9\n' },
        },
        agentState: { messageHistory: [] },
        clientSessionId: 'test-session',
        fileProcessingState,
        fingerprintId: 'test-fingerprint',
        logger,
        prompt: undefined,
        userId: undefined,
        userInputId: 'test-input',
        requestOptionalFile: async () => diskContent,
        requestClientToolCall: async () => {
          writeApplied = true
          return []
        },
        writeToClient: () => {},
      } as any)

      expect(writeApplied).toBe(false)
      expect(writeResult.output[0]?.type).toBe('json')
      expect(
        fileProcessingState.editRereadRequirementsByPath?.[path]?.reason,
      ).toBe('context_compacted')
    })

    it('complete whole-file read_files after compaction clears marker so write_file can proceed', async () => {
      const path = 'src/compacted-whole-read.ts'
      const diskContent = 'export const value = 1\n'
      const fileProcessingState = createFileProcessingState()
      fileProcessingState.strictReadBeforeEdit = true
      fileProcessingState.readAuthorizationsByPath = { [path]: true }
      fileProcessingState.readAuthorizationHashesByPath = {
        [path]: getContentHash(diskContent),
      }
      fileProcessingState.editRereadRequirementsByPath = {
        [path]: { reason: 'context_compacted', sourceTool: 'compaction' },
      }
      fileProcessingState.failedEditRequiresReadByPath[path] = true

      await handleReadFiles({ ...defaultTestHandlerAuthority,
        previousToolCallFinished: Promise.resolve(),
        toolCall: {
          toolCallId: 'whole-read-after-compaction',
          toolName: 'read_files',
          input: { paths: [path] },
        },
        fileContext: mockFileContext,
        fileProcessingState,
        requestFiles: async ({ filePaths }: { filePaths: string[] }) =>
          buildWholeFileReadResultV1(filePaths, (filePath) =>
            filePath === path ? diskContent : null,
          ),
        logger,
      } as any)

      expect(
        fileProcessingState.editRereadRequirementsByPath?.[path],
      ).toBeUndefined()
      expect(fileProcessingState.readAuthorizationsByPath?.[path]).toBe(true)

      let writeApplied = false
      const writeResult = await handleWriteFile({ ...defaultTestHandlerAuthority,
        previousToolCallFinished: Promise.resolve(),
        toolCall: {
          toolCallId: 'write-after-compacted-whole-read',
          toolName: 'write_file',
          input: { path, content: 'export const value = 2\n' },
        },
        agentState: { messageHistory: [] },
        clientSessionId: 'test-session',
        fileProcessingState,
        fingerprintId: 'test-fingerprint',
        logger,
        prompt: undefined,
        userId: undefined,
        userInputId: 'test-input',
        requestOptionalFile: async () => diskContent,
        requestClientToolCall: async (toolCall: any) => {
          writeApplied = true
          return confirmedMutationOutput(toolCall, {
            [path]: 'export const value = 2\n',
          })
        },
        writeToClient: () => {},
      } as any)

      expect(writeApplied).toBe(true)
      expect(writeResult.output[0]?.type).toBe('json')
      if (writeResult.output[0]?.type === 'json') {
        expect(writeResult.output[0].value).not.toHaveProperty('errorMessage')
      }
    })

    it('write_file with valid whole-file basedOnRead clears context_compacted and applies', async () => {
      const path = 'src/compacted-basedonread-write.ts'
      const diskContent = 'export const value = 1\n'
      const runId = 'compacted-basedonread-run'
      const fileProcessingState = createFileProcessingState()
      fileProcessingState.strictReadBeforeEdit = true
      fileProcessingState.readAuthorizationsByPath = { [path]: true }
      fileProcessingState.readAuthorizationHashesByPath = {
        [path]: getContentHash(diskContent),
      }
      fileProcessingState.editRereadRequirementsByPath = {
        [path]: { reason: 'context_compacted', sourceTool: 'compaction' },
      }
      fileProcessingState.failedEditRequiresReadByPath[path] = true
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

      let writeApplied = false
      const writeResult = await handleWriteFile({ ...defaultTestHandlerAuthority,
        previousToolCallFinished: Promise.resolve(),
        toolCall: {
          toolCallId: 'write-compacted-with-basedonread',
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
          writeApplied = true
          return confirmedMutationOutput(
            toolCall,
            { [path]: 'export const value = 2\n' },
            { projectId: mockFileContext.projectRoot, runId },
          )
        },
        writeToClient: () => {},
      } as any)

      expect(writeApplied).toBe(true)
      expect(writeResult.output[0]?.type).toBe('json')
      if (writeResult.output[0]?.type === 'json') {
        expect(writeResult.output[0].value).not.toHaveProperty('errorMessage')
      }
      expect(
        fileProcessingState.editRereadRequirementsByPath?.[path],
      ).toBeUndefined()
    })

    it('strictEditAuthorizationError prefers basedOnRead retry when capability is present', () => {
      const path = 'src/auth-miss.ts'
      const fileProcessingState = createFileProcessingState()
      fileProcessingState.strictReadBeforeEdit = true
      const capability =
        'cap.v3.1.1.test-whole-file-capability-token-for-recovery-message'

      const withCap = strictEditAuthorizationError({
        fileProcessingState,
        path,
        toolName: 'write_file',
        hasFreshWholeFileAuthorization: false,
        freshReadCapability: capability,
      })
      expect(withCap).toBeDefined()
      expect(String(withCap?.errorMessage)).toContain(
        'Next: retry with basedOnRead',
      )
      expect(String(withCap?.errorMessage)).toContain(`basedOnRead="${capability}"`)
      expect(String(withCap?.errorMessage)).not.toMatch(
        /Next: call read_files/,
      )
      // Structured recovery may still name read_files as fallback tool.
      expect(withCap?.recovery.tool).toBe('read_files')
      expect(withCap?.recovery.basedOnRead).toBe(capability)

      const withoutCap = strictEditAuthorizationError({
        fileProcessingState,
        path,
        toolName: 'write_file',
        hasFreshWholeFileAuthorization: false,
      })
      expect(String(withoutCap?.errorMessage)).toContain(
        'Next: call read_files',
      )
    })

    it('strictEditAuthorizationError names the confirmed post-edit anchor for a file created or edited earlier in this session', () => {
      const path = 'src/created-earlier.ts'
      const fileProcessingState = createFileProcessingState()
      fileProcessingState.strictReadBeforeEdit = true
      fileProcessingState.confirmedPostEditAnchorsByPath = {
        [path]: {
          startLine: 1,
          endLine: 2,
          contentHash: 'sha256:x',
          readCapability: 'cap.v3.test',
        },
      }

      const result = strictEditAuthorizationError({
        fileProcessingState,
        path,
        toolName: 'write_file',
        hasFreshWholeFileAuthorization: false,
        authorizationWasStale: false,
      })

      expect(result).toBeDefined()
      expect(String(result?.errorMessage)).toContain(
        'was created or edited earlier in this session',
      )
      expect(String(result?.errorMessage)).toContain(
        'Retry the edit with basedOnRead set to the readCapability from that create/edit result',
      )
      // The confirmed anchor's capability is echoed for recovery (no caller
      // freshReadCapability), so the next line points at basedOnRead retry.
      expect(String(result?.errorMessage)).toContain(
        'Next: retry with basedOnRead',
      )
      expect(String(result?.errorMessage)).toContain(
        'basedOnRead="cap.v3.test"',
      )
      expect(result?.recovery.basedOnRead).toBe('cap.v3.test')
    })

    it('strictEditAuthorizationError uses the generic no-fresh-read message without a confirmed post-edit anchor', () => {
      const path = 'src/never-created.ts'
      const fileProcessingState = createFileProcessingState()
      fileProcessingState.strictReadBeforeEdit = true

      const result = strictEditAuthorizationError({
        fileProcessingState,
        path,
        toolName: 'write_file',
        hasFreshWholeFileAuthorization: false,
        authorizationWasStale: false,
      })

      expect(result).toBeDefined()
      expect(String(result?.errorMessage)).toContain(
        'strict read-before-edit is enabled and no fresh read authorization exists',
      )
      expect(String(result?.errorMessage)).toContain('Next: call read_files')
      expect(result?.recovery.basedOnRead).toBeUndefined()
    })

    it('strict edit_transaction blind write returns no capability and requires complete read_files', async () => {
      const path = 'src/write-auth-miss-msg.ts'
      const diskContent = 'export const value = 1\n'
      const fileProcessingState = createFileProcessingState()
      fileProcessingState.strictReadBeforeEdit = true

      const result = await handleEditTransaction({ ...defaultTestHandlerAuthority,
        previousToolCallFinished: Promise.resolve(),
        toolCall: {
          toolCallId: 'write-auth-miss-msg',
          toolName: 'edit_transaction',
          input: {
            edits: [
              {
                type: 'write_file',
                path,
                content: 'export const value = 2\n',
              },
            ],
          },
        },
        fileProcessingState,
        fileContext: mockFileContext,
        runId: 'write-auth-miss-msg-run',
        logger,
        requestOptionalFile: async () => diskContent,
        requestClientToolCall: async () => {
          throw new Error('must not apply write auth miss')
        },
      } as any)

      const output = result.output[0]
      expect(output.type).toBe('json')
      if (output.type === 'json') {
        const value = output.value as {
          errorMessage?: string
          failures?: Array<{ errorMessage?: string; basedOnRead?: string }>
        }
        const failureMsg = String(value.failures?.[0]?.errorMessage)
        expect(failureMsg).toContain('Call read_files with paths:')
        expect(failureMsg).not.toContain('cap.v3.')
        expect(failureMsg).not.toContain('basedOnRead=')
        expect(String(value.errorMessage)).toContain(
          'Complete a model-visible read_files refresh',
        )
        expect(value.failures?.[0]).not.toHaveProperty('basedOnRead')
      }
    })

    it('auto-reread does not clear context_compacted before apply; failed tx leaves marker so write_file stays blocked', async () => {
      const path = 'src/tx-autoreread-compacted.ts'
      const diskContent = 'export const value = 1\n'
      const fileProcessingState = createFileProcessingState()
      fileProcessingState.strictReadBeforeEdit = true
      fileProcessingState.readAuthorizationsByPath = { [path]: true }
      fileProcessingState.readAuthorizationHashesByPath = {
        [path]: getContentHash(diskContent),
      }
      fileProcessingState.editRereadRequirementsByPath = {
        [path]: { reason: 'context_compacted', sourceTool: 'compaction' },
      }
      fileProcessingState.failedEditRequiresReadByPath[path] = true

      const failResult = await handleEditTransaction({ ...defaultTestHandlerAuthority,
        previousToolCallFinished: Promise.resolve(),
        toolCall: {
          toolCallId: 'tx-autoreread-fail-compacted',
          toolName: 'edit_transaction',
          input: {
            edits: [
              {
                type: 'str_replace',
                path,
                replacements: [
                  {
                    oldString: 'export const missing = 99',
                    newString: 'export const missing = 100',
                    allowMultiple: false,
                  },
                ],
              },
            ],
          },
        },
        fileProcessingState,
        fileContext: mockFileContext,
        runId: 'tx-autoreread-compacted-run',
        logger,
        requestOptionalFile: async () => diskContent,
        requestClientToolCall: async () => {
          throw new Error('must not apply failed unique match')
        },
      } as any)

      expect(failResult.output[0]?.type).toBe('json')
      if (failResult.output[0]?.type === 'json') {
        const value = failResult.output[0].value as {
          basedOnRead?: string
          errorMessage?: string
          failures?: Array<{ basedOnRead?: string; errorMessage?: string }>
        }
        const errorText = [
          value.errorMessage,
          ...(value.failures?.map((failure) => failure.errorMessage) ?? []),
        ]
          .map(String)
          .join('\n')
        expect(value).toHaveProperty('errorMessage')
        expect(errorText).toContain('Candidate 1: lines')
        expect(errorText).toContain('read_files ranges')
        expect(errorText).toContain(diskContent.trim())
        expect(errorText).not.toContain('cap.v3.')
        expect(errorText).not.toContain('readCapability=')
        expect(errorText).not.toContain('basedOnRead=')
        expect(value).not.toHaveProperty('basedOnRead')
        for (const failure of value.failures ?? []) {
          expect(failure).not.toHaveProperty('basedOnRead')
        }
      }
      // Marker must survive failed auto-reread preflight (no pre-apply clear).
      expect(
        fileProcessingState.editRereadRequirementsByPath?.[path]?.reason,
      ).toBe('context_compacted')

      let writeApplied = false
      const writeResult = await handleWriteFile({ ...defaultTestHandlerAuthority,
        previousToolCallFinished: Promise.resolve(),
        toolCall: {
          toolCallId: 'write-after-failed-tx-autoreread',
          toolName: 'write_file',
          input: { path, content: 'export const value = 999\n' },
        },
        agentState: { messageHistory: [] },
        clientSessionId: 'test-session',
        fileProcessingState,
        fingerprintId: 'test-fingerprint',
        logger,
        prompt: undefined,
        userId: undefined,
        userInputId: 'test-input',
        requestOptionalFile: async () => diskContent,
        requestClientToolCall: async () => {
          writeApplied = true
          return []
        },
        writeToClient: () => {},
      } as any)

      expect(writeApplied).toBe(false)
      expect(writeResult.output[0]?.type).toBe('json')
      if (writeResult.output[0]?.type === 'json') {
        expect(
          String((writeResult.output[0].value as any).errorMessage),
        ).toMatch(/context compaction|read_files|basedOnRead/i)
      }
      expect(
        fileProcessingState.editRereadRequirementsByPath?.[path]?.reason,
      ).toBe('context_compacted')
    })

    it('process residual failure path does not mint basedOnRead from snapshot content', async () => {
      const path = 'src/process-residual-basedonread.ts'
      const diskContent = 'export const value = 1\n'
      const fileProcessingState = createFileProcessingState()
      fileProcessingState.strictReadBeforeEdit = true
      fileProcessingState.readAuthorizationsByPath = { [path]: true }
      fileProcessingState.readAuthorizationHashesByPath = {
        [path]: getContentHash(diskContent),
      }

      const result = await handleEditTransaction({ ...defaultTestHandlerAuthority,
        previousToolCallFinished: Promise.resolve(),
        toolCall: {
          toolCallId: 'process-residual-basedonread',
          toolName: 'edit_transaction',
          input: {
            edits: [
              {
                type: 'str_replace',
                path,
                replacements: [
                  {
                    oldString: 'export const missing = 1',
                    newString: 'export const missing = 2',
                    allowMultiple: false,
                  },
                ],
              },
            ],
          },
        },
        fileProcessingState,
        fileContext: mockFileContext,
        runId: 'process-residual-basedonread-run',
        logger,
        requestOptionalFile: async () => diskContent,
        requestClientToolCall: async () => {
          throw new Error('must not apply residual no-match')
        },
      } as any)

      const output = result.output[0]
      expect(output.type).toBe('json')
      if (output.type === 'json') {
        const value = output.value as {
          basedOnRead?: string
          errorMessage?: string
          failures?: Array<{ basedOnRead?: string; errorMessage?: string }>
        }
        const errorText = [
          value.errorMessage,
          ...(value.failures?.map((failure) => failure.errorMessage) ?? []),
        ]
          .map(String)
          .join('\n')
        expect(value).toHaveProperty('errorMessage')
        expect(errorText).toContain('Candidate 1: lines')
        expect(errorText).toContain('read_files ranges')
        expect(errorText).toContain(diskContent.trim())
        expect(errorText).not.toContain('cap.v3.')
        expect(errorText).not.toContain('readCapability=')
        expect(errorText).not.toContain('basedOnRead=')
        expect(value).not.toHaveProperty('basedOnRead')
        for (const failure of value.failures ?? []) {
          expect(failure).not.toHaveProperty('basedOnRead')
        }
      }
    })

    it('create then delete in a later step without an intervening read succeeds in strict mode', async () => {
      const path = 'src/scratch.ts'
      const createdContent = 'export const temp = 1\n'
      const runId = 'create-then-delete-strict-run'
      const fileProcessingState = createFileProcessingState()
      fileProcessingState.strictReadBeforeEdit = true

      const createResult = await handleEditTransaction({ ...defaultTestHandlerAuthority,
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
      const deleteResult = await handleEditTransaction({ ...defaultTestHandlerAuthority,
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

    it('create then str_replace in a later step without an intervening read succeeds in strict mode', async () => {
      const path = 'src/scratch.ts'
      const createdContent = 'export const temp = 1\n'
      const runId = 'create-then-edit-strict-run'
      const fileProcessingState = createFileProcessingState()
      fileProcessingState.strictReadBeforeEdit = true

      const createResult = await handleEditTransaction({ ...defaultTestHandlerAuthority,
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
      expect(fileProcessingState.readAuthorizationsByPath?.[path]).toBe(true)
      expect(fileProcessingState.readAuthorizationHashesByPath?.[path]).toBe(
        getContentHash(createdContent),
      )
      expect(
        fileProcessingState.confirmedPostEditAnchorsByPath?.[path],
      ).toBeDefined()

      // WITHOUT any read_files, a later str_replace must succeed via the
      // sticky auth granted by the confirmed create.
      let applied = false
      const editResult = await handleEditTransaction({ ...defaultTestHandlerAuthority,
        previousToolCallFinished: Promise.resolve(),
        toolCall: {
          toolCallId: 'edit-scratch',
          toolName: 'edit_transaction',
          input: {
            edits: [
              {
                type: 'str_replace',
                path,
                replacements: [
                  {
                    oldString: 'export const temp = 1',
                    newString: 'export const temp = 2',
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
          filePath === path ? createdContent : null,
        requestClientToolCall: async (toolCall: any) => {
          applied = true
          return confirmedMutationOutput(
            toolCall,
            { [path]: 'export const temp = 2\n' },
            { projectId: mockFileContext.projectRoot, runId },
          )
        },
      } as any)

      expect(applied).toBe(true)
      const editOutput = editResult.output[0]
      expect(editOutput.type).toBe('json')
      if (editOutput.type === 'json') {
        expect(editOutput.value).not.toHaveProperty('errorMessage')
      }
    })

    it('delete on an externally-modified created file still fails closed', async () => {
      const path = 'src/scratch.ts'
      const createdContent = 'export const temp = 1\n'
      const runId = 'create-then-delete-stale-strict-run'
      const fileProcessingState = createFileProcessingState()
      fileProcessingState.strictReadBeforeEdit = true

      const createResult = await handleEditTransaction({ ...defaultTestHandlerAuthority,
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
      const deleteResult = await handleEditTransaction({ ...defaultTestHandlerAuthority,
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
      const deleteResult = await handleEditTransaction({ ...defaultTestHandlerAuthority,
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
      const deleteResult = await handleEditTransaction({ ...defaultTestHandlerAuthority,
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

      const createResult = await handleEditTransaction({ ...defaultTestHandlerAuthority,
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
      const moveResult = await handleEditTransaction({ ...defaultTestHandlerAuthority,
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

      const createResult = await handleEditTransaction({ ...defaultTestHandlerAuthority,
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
      const moveResult = await handleEditTransaction({ ...defaultTestHandlerAuthority,
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
      expect(destinationAnchor?.contentHash).toBe(getContentHash(createdContent))
      expect(destinationAnchor?.readCapability).toMatch(/^cap\.v3\./)

      // Sticky whole-file authorization + hash are also granted on the
      // destination path.
      expect(fileProcessingState.readAuthorizationsByPath?.[destinationPath]).toBe(
        true,
      )
      expect(
        fileProcessingState.readAuthorizationHashesByPath?.[destinationPath],
      ).toBe(getContentHash(createdContent))
    })

    it('cross-turn hydration keeps sticky read authorization but not the confirmed post-edit anchor', async () => {
      const path = 'src/cross-turn.ts'
      const createdContent = 'export const c = 1\n'
      const runId = 'cross-turn-hydration-strict-run'
      const fileProcessingState = createFileProcessingState()
      fileProcessingState.strictReadBeforeEdit = true

      const createResult = await handleEditTransaction({ ...defaultTestHandlerAuthority,
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
      // After the confirmed create, state holds BOTH a sticky authorization and
      // a confirmed post-edit anchor for the path.
      expect(fileProcessingState.readAuthorizationsByPath?.[path]).toBe(true)
      expect(fileProcessingState.readAuthorizationHashesByPath?.[path]).toBe(
        getContentHash(createdContent),
      )
      expect(
        fileProcessingState.confirmedPostEditAnchorsByPath?.[path],
      ).toBeDefined()

      // Simulate the per-turn hydration exactly as stream-parser.ts:222-250
      // does: build a FRESH fileProcessingState copying ONLY the durable
      // registry fields (readAuthorizationsByPath /
      // readAuthorizationHashesByPath / editRereadRequirementsByPath). The
      // confirmed post-edit anchor is turn-local and is intentionally NOT
      // hydrated.
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

      // Sticky auth + hash survive the turn boundary.
      expect(nextTurnState.readAuthorizationsByPath?.[path]).toBe(true)
      expect(nextTurnState.readAuthorizationHashesByPath?.[path]).toBe(
        getContentHash(createdContent),
      )
      // The confirmed post-edit anchor does NOT survive: it is turn-local and
      // the durable hydration set omits it.
      expect(
        nextTurnState.confirmedPostEditAnchorsByPath?.[path],
      ).toBeUndefined()
    })

    it('move on an externally-modified created file still fails closed', async () => {
      const path = 'src/scratch.ts'
      const destinationPath = 'src/scratch-moved.ts'
      const createdContent = 'export const temp = 1\n'
      const runId = 'create-then-move-stale-strict-run'
      const fileProcessingState = createFileProcessingState()
      fileProcessingState.strictReadBeforeEdit = true

      const createResult = await handleEditTransaction({ ...defaultTestHandlerAuthority,
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
      const moveResult = await handleEditTransaction({ ...defaultTestHandlerAuthority,
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

      const createResult = await handleEditTransaction({ ...defaultTestHandlerAuthority,
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
      const moveResult = await handleEditTransaction({ ...defaultTestHandlerAuthority,
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

      const result = await handleEditTransaction({ ...defaultTestHandlerAuthority,
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

    it('generic (untagged) preflight failure preserves authorization', async () => {
      // Contrast: a str_replace whose per-replacement basedOnRead is valid
      // (correct scope/run, fresh hash) but whose oldString does not match the
      // current content fails preflight with NO failureKind (untagged /
      // generic). Its message does not match the capability regex either, so
      // requiresFreshCapability stays false and the existing authorization is
      // preserved with no stale_capability requirement.
      const path = 'src/generic-preflight-preserved.ts'
      // Snapshot content and the seeded authorization hash must match so the
      // freshness pre-scan keeps the authorization (isolating the classifier's
      // preserve behavior from the separate stale-revocation path).
      const diskContent = 'export const value = 1\n'
      const runId = 'generic-preflight-preserved-run'
      const fileProcessingState = createFileProcessingState()
      fileProcessingState.strictReadBeforeEdit = true
      fileProcessingState.readAuthorizationsByPath = { [path]: true }
      fileProcessingState.readAuthorizationHashesByPath = {
        [path]: getContentHash(diskContent),
      }
      // Valid capability: correct scope (this run) and a hash matching the
      // snapshot content (the whole 1-line file).
      const freshCapability = encodeReadCapabilityToken({
        startLine: 1,
        endLine: 1,
        hash: getContentHash(diskContent),
        scope: {
          projectId: mockFileContext.projectRoot,
          path,
          runId,
        },
      })

      const result = await handleEditTransaction({ ...defaultTestHandlerAuthority,
        previousToolCallFinished: Promise.resolve(),
        toolCall: {
          toolCallId: 'generic-preflight-preserved-tx',
          toolName: 'edit_transaction',
          input: {
            edits: [
              {
                type: 'str_replace',
                path,
                replacements: [
                  {
                    // oldString does not match current content: a generic
                    // no-match preflight failure, not a capability failure.
                    oldString: 'export const value = 999',
                    newString: 'export const value = 2',
                    allowMultiple: false,
                    basedOnRead: freshCapability,
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
        requestClientToolCall: async () => {
          throw new Error('must not apply a generic no-match preflight failure')
        },
      } as any)

      const output = result.output[0]
      expect(output.type).toBe('json')
      if (output.type === 'json') {
        expect(output.value).toHaveProperty('errorMessage')
      }
      // Non-capability failure: authorization is preserved and no stale_capability
      // reread requirement is recorded for the transaction path.
      expect(fileProcessingState.readAuthorizationsByPath?.[path]).toBe(true)
      expect(fileProcessingState.readAuthorizationHashesByPath?.[path]).toBe(
        getContentHash(diskContent),
      )
      expect(
        fileProcessingState.editRereadRequirementsByPath?.[path]?.reason,
      ).not.toBe('stale_capability')
      expect(
        fileProcessingState.editRereadRequirementsByPath?.[path],
      ).toBeUndefined()
    })
  })
})

describe('read_files unified five-selector surface (M2)', () => {
  it('one call with all five selector kinds returns one ordered read_files_result', async () => {
    const fileProcessingState = createFileProcessingState()
    const fileContent = 'export const value = 1\n'
    const largeContent = ['l1', 'l2', 'l3', 'l4', 'l5', 'l6', 'l7'].join('\n')
    const aroundContent = [
      'const a = 1',
      'const marker = true',
      'const b = 2',
    ].join('\n')
    const symbolContent = 'export function run() {\n  return 1\n}\n'

    const result = await handleReadFiles({ ...defaultTestHandlerAuthority,
      previousToolCallFinished: Promise.resolve(),
      toolCall: {
        toolCallId: 'read-five-selectors',
        toolName: 'read_files',
        input: {
          paths: ['src/file.ts'],
          ranges: [{ path: 'src/file.ts', startLine: 1, endLine: 1 }],
          windows: [{ path: 'src/large.ts', windowSize: 3, window: 2 }],
          around: [{ path: 'src/around.ts', match: 'const marker = true' }],
          symbols: [{ path: 'src/symbol.ts', names: ['run'] }],
        },
      },
      fileContext: mockFileContext,
      fileProcessingState,
      requestFiles: async () =>
        buildReadFilesResultV1([
          {
            selector: 'file',
            requestIndex: 0,
            path: 'src/file.ts',
            status: 'ok',
            content: fileContent,
            complete: true,
            template: false,
          },
          {
            selector: 'range',
            requestIndex: 1,
            path: 'src/file.ts',
            status: 'ok',
            content: '1\texport const value = 1',
            sourceContent: 'export const value = 1',
            startLine: 1,
            endLine: 1,
            totalLines: 1,
            complete: true,
            editAnchor: {
              startLine: 1,
              endLine: 1,
              contentHash: getContentHash('export const value = 1'),
              readCapability: 'cap.v3.range',
            },
          },
        ]),
      requestOptionalFile: async ({ filePath }: { filePath: string }) => {
        if (filePath === 'src/large.ts') return largeContent
        if (filePath === 'src/around.ts') return aroundContent
        if (filePath === 'src/symbol.ts') return symbolContent
        return null
      },
      logger,
    } as any)

    expect(result.output[0]?.type).toBe('json')
    if (result.output[0]?.type !== 'json') return
    const value = result.output[0].value as any

    expect(value.kind).toBe('read_files_result')
    expect(value.summary).toEqual({
      requested: 5,
      ok: 5,
      partial: 0,
      failed: 0,
      uniquePaths: 4,
    })
    expect(value.results.map((item: any) => item.selector)).toEqual([
      'file',
      'range',
      'window',
      'around',
      'symbols',
    ])
    expect(value.results.map((item: any) => item.requestIndex)).toEqual([
      0, 1, 2, 3, 4,
    ])

    const [file, range, window, around, symbols] = value.results
    expect(file).toMatchObject({
      selector: 'file',
      path: 'src/file.ts',
      status: 'ok',
      complete: true,
    })
    expect(range).toMatchObject({
      selector: 'range',
      path: 'src/file.ts',
      status: 'ok',
      startLine: 1,
      endLine: 1,
    })
    expect(window).toMatchObject({
      selector: 'window',
      path: 'src/large.ts',
      status: 'ok',
      startLine: 4,
      endLine: 6,
      totalLines: 7,
      windowSize: 3,
      windowCount: 3,
      window: 2,
      complete: true,
    })
    expect(window.content).toBe('l4\nl5\nl6')
    expect(window.editAnchor).toMatchObject({ startLine: 4, endLine: 6 })
    expect(around).toMatchObject({
      selector: 'around',
      path: 'src/around.ts',
      status: 'ok',
      match: 'const marker = true',
      complete: true,
    })
    expect(around.content).toContain('const marker = true')
    expect(symbols).toMatchObject({
      selector: 'symbols',
      path: 'src/symbol.ts',
      status: 'ok',
      requestedSymbols: ['run'],
      missingSymbols: [],
    })
  })

  it('emits a window manifest plus first window for an oversized whole-file read', async () => {
    const fileProcessingState = createFileProcessingState()
    const largeContent = Array.from(
      { length: 450 },
      (_, index) => `line ${index + 1}`,
    ).join('\n')

    const result = await handleReadFiles({ ...defaultTestHandlerAuthority,
      previousToolCallFinished: Promise.resolve(),
      toolCall: {
        toolCallId: 'read-oversized',
        toolName: 'read_files',
        input: { paths: ['src/big.ts'] },
      },
      fileContext: mockFileContext,
      fileProcessingState,
      requestFiles: async () =>
        buildReadFilesResultV1([
          {
            selector: 'file',
            requestIndex: 0,
            path: 'src/big.ts',
            status: 'partial',
            content: 'line 1\nline 2',
            complete: false,
            template: false,
            truncation: { reason: 'character_limit' },
          },
        ]),
      requestOptionalFile: async ({ filePath }: { filePath: string }) =>
        filePath === 'src/big.ts' ? largeContent : null,
      logger,
    } as any)

    expect(result.output[0]?.type).toBe('json')
    if (result.output[0]?.type !== 'json') return
    const value = result.output[0].value as any

    // The truncated file item stays partial; a window manifest item follows it.
    expect(value.results[0]).toMatchObject({
      selector: 'file',
      path: 'src/big.ts',
      status: 'partial',
      complete: false,
    })
    const manifest = value.results.find(
      (item: any) => item.selector === 'window',
    )
    expect(manifest).toBeDefined()
    expect(manifest).toMatchObject({
      selector: 'window',
      path: 'src/big.ts',
      status: 'ok',
      window: 1,
      totalLines: 450,
      complete: true,
    })
    expect(manifest.windowCount).toBeGreaterThan(1)
    // The first window is a strict sub-file window, so it earns a scoped
    // anchor (never a whole-file grant from a truncated read).
    expect(manifest.editAnchor).toMatchObject({ startLine: 1, endLine: 400 })
    // requestIndex stays contiguous after the manifest splice.
    expect(
      value.results.map((item: any) => item.requestIndex),
    ).toEqual(value.results.map((_: any, index: number) => index))
    // Summary counts the extra manifest item.
    expect(value.summary.requested).toBe(value.results.length)
    // No whole-file authorization was granted for the truncated path.
    expect(
      fileProcessingState.readAuthorizationsByPath?.['src/big.ts'],
    ).toBeUndefined()
  })
})

// === End-to-end cross-turn test for processStream → read_files → str_replace ===
// Reproduces the user-reported failure mode: reading in turn N does not
// grant authorization for editing in turn N+1, because each processStream
// invocation used to create a fresh fileProcessingState. The fix persists
// readAuthorizationsByPath on agentState across LLM turns.

describe('processStream cross-turn read-before-edit', () => {
  const testAgentTemplate: AgentTemplate = {
    id: 'test-agent',
    displayName: 'Test Agent',
    spawnerPrompt: 'Test agent',
    model: 'claude-3-5-sonnet-20241022',
    inputSchema: {},
    outputMode: 'structured_output',
    includeMessageHistory: true,
    inheritParentSystemPrompt: false,
    mcpServers: {},
    toolNames: ['read_files', 'str_replace', 'end_turn'],
    spawnableAgents: [],
    systemPrompt: 'Test system prompt',
    instructionsPrompt: 'Test instructions',
    stepPrompt: 'Test step prompt',
  }

  it('auto-rereads once so a same-response unique str_replace can apply without model-visible sticky auth', async () => {
    const sessionState = getInitialSessionState(mockFileContext)
    const agentState = sessionState.mainAgentState
    const targetPath = 'src/example.ts'
    const diskContent = 'export const value = 1\n'

    let appliedPatches: string[] = []

    const agentRuntimeImpl = {
      ...TEST_AGENT_RUNTIME_IMPL,
      sendAction: () => {},
      requestFiles: async () => {
        await new Promise((resolve) => setTimeout(resolve, 10))
        return buildWholeFileReadResultV1([targetPath], () => diskContent)
      },
      requestOptionalFile: async ({ filePath }: { filePath: string }) =>
        filePath === targetPath ? diskContent : null,
      // requestClientToolCall is intentionally not mocked: the
      // executeToolCall wrapper in tool-executor.ts installs its own
      // requestClientToolCall closure that delegates to requestToolCall,
      // so mocking only requestToolCall exercises the real cross-turn path
      // without intercepting the wrapper.
      requestToolCall: async (params: any) => {
        if (
          params.toolName === 'str_replace' ||
          params.toolName === 'write_file'
        ) {
          await new Promise((resolve) => setTimeout(resolve, 10))
          appliedPatches.push(params.input?.content ?? '')
          const output = confirmedMutationOutput(
            {
              toolCallId: params.callId,
              input: params.input,
            },
            { [targetPath]: 'export const value = 2\n' },
            {
              projectId: mockFileContext.projectRoot,
              runId: 'test-run-id',
            },
          )
          const canonicalReceipt: CommitReceiptV1 =
            output[0].value.authorityReceipt
          return { output, canonicalReceipt }
        }
        return { output: [] }
      },
    } as AgentRuntimeDeps & AgentRuntimeScopedDeps

    // Same-response read does not mint model-visible sticky auth for the edit,
    // but server auto-reread-once still recovers unique str_replace safely.
    const stream1 = createMockStreamWithToolCalls([
      'Reading the file now.',
      { toolName: 'read_files', input: { paths: [targetPath] } },
      {
        toolName: 'str_replace',
        input: {
          path: targetPath,
          replacements: [
            {
              oldString: 'export const value = 1',
              newString: 'export const value = 2',
              allowMultiple: false,
            },
          ],
        },
      },
      { toolName: 'end_turn', input: {} },
    ])

    await processStream({
      ...agentRuntimeImpl,
      agentContext: {},
      agentState,
      agentStepId: 'turn-1',
      agentTemplate: testAgentTemplate,
      ancestorRunIds: [],
      clientSessionId: 'test-session',
      fileContext: mockFileContext,
      fingerprintId: 'test-fingerprint',
      fullResponse: '',
      localAgentTemplates: { 'test-agent': testAgentTemplate },
      messages: [],
      prompt: 'test prompt',
      repoId: undefined,
      repoUrl: undefined,
      runId: 'test-run-id',
      signal: new AbortController().signal,
      stream: stream1,
      system: 'test system',
      tools: {},
      userId: 'test-user',
      userInputId: 'test-input-id',
      onCostCalculated: async () => {},
      onResponseChunk: () => {},
    })

    expect(appliedPatches).toHaveLength(1)
    expect(appliedPatches[0]).toContain('export const value = 2')
    // Sticky after success is from post-edit observed content (and/or same-response
    // read write-back), not from auto-reread pre-edit grant alone.
    expect(agentState.readAuthorizationsByPath?.[targetPath]).toBe(true)
    expect(agentState.readAuthorizationHashesByPath?.[targetPath]).toBe(
      getContentHash('export const value = 2\n'),
    )
  })

  it('removes stale durable authorization during cross-turn writeback', async () => {
    const sessionState = getInitialSessionState(mockFileContext)
    const agentState = sessionState.mainAgentState
    const targetPath = 'src/externally-changed.ts'
    const previouslyReadContent = 'export const value = 1\n'
    const diskContent = 'export const value = 2\n'
    agentState.readAuthorizationsByPath = { [targetPath]: true }
    agentState.readAuthorizationHashesByPath = {
      [targetPath]: getContentHash(previouslyReadContent),
    }
    let applyCount = 0

    const agentRuntimeImpl = {
      ...TEST_AGENT_RUNTIME_IMPL,
      sendAction: () => {},
      requestFiles: async () =>
        buildWholeFileReadResultV1([targetPath], () => diskContent),
      requestOptionalFile: async ({ filePath }: { filePath: string }) =>
        filePath === targetPath ? diskContent : null,
      requestToolCall: async () => {
        applyCount += 1
        return { output: [] }
      },
    } as AgentRuntimeDeps & AgentRuntimeScopedDeps

    const stream = createMockStreamWithToolCalls([
      {
        toolName: 'str_replace',
        input: {
          path: targetPath,
          replacements: [
            {
              oldString: 'export const value = 1',
              newString: 'export const value = 3',
              allowMultiple: false,
            },
          ],
        },
      },
      { toolName: 'end_turn', input: {} },
    ])

    await processStream({
      ...agentRuntimeImpl,
      agentContext: {},
      agentState,
      agentStepId: 'stale-turn',
      agentTemplate: testAgentTemplate,
      ancestorRunIds: [],
      clientSessionId: 'test-session',
      fileContext: mockFileContext,
      fingerprintId: 'test-fingerprint',
      fullResponse: '',
      localAgentTemplates: { 'test-agent': testAgentTemplate },
      messages: [],
      prompt: 'test prompt',
      repoId: undefined,
      repoUrl: undefined,
      runId: 'test-run-id',
      signal: new AbortController().signal,
      stream,
      system: 'test system',
      tools: {},
      userId: 'test-user',
      userInputId: 'test-input-id',
      onCostCalculated: async () => {},
      onResponseChunk: () => {},
    })

    expect(applyCount).toBe(0)
    expect(agentState.readAuthorizationsByPath?.[targetPath]).toBeUndefined()
    expect(
      agentState.readAuthorizationHashesByPath?.[targetPath],
    ).toBeUndefined()
  })
})
