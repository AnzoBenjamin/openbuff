import { describe, expect, it } from 'bun:test'

import { handleEditTransaction } from '../edit-transaction'
import { getFileProcessingValues } from '../write-file'
import {
  encodeReadCapabilityToken,
  getContentHash,
} from '@codebuff/common/util/content-hash'

import type { Logger } from '@codebuff/common/types/contracts/logger'

const logger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
}

function buildScopedReadCapability(path: string): string {
  return encodeReadCapabilityToken({
    startLine: 1,
    endLine: 1,
    hash: getContentHash('const target = 1\n'),
    scope: { projectId: '/project', path, runId: 'run' },
  })
}

describe('edit_transaction capability-bearing edit guard', () => {
  it('does not throw or treat a str_replace edit with non-array replacements as capability-bearing', async () => {
    let clientCalls = 0
    const result = await handleEditTransaction({
      previousToolCallFinished: Promise.resolve(),
      toolCall: {
        toolCallId: 'non-array-replacements',
        toolName: 'edit_transaction',
        input: {
          edits: [
            {
              type: 'str_replace',
              path: 'src/a.ts',
              // Missing entirely: isCapabilityBearingEdit must guard with
              // Array.isArray before touching `.some` on replacements.
              replacements: undefined,
            },
            {
              type: 'create',
              path: 'src/existing.ts',
              content: 'new content',
            },
          ],
        },
      },
      fileProcessingState: getFileProcessingValues({
        strictReadBeforeEdit: false,
      }),
      logger,
      requestOptionalFile: async () => 'existing content\n',
      requestClientToolCall: async () => {
        clientCalls += 1
        return []
      },
      writeToClient: () => undefined,
    } as any)

    // Without the Array.isArray guard this call rejects with a TypeError.
    // With it, the edit is not capability-bearing, so the empty runtime scope
    // must not trigger the capability block; the transaction instead reaches
    // the deterministic lifecycle preflight failure for the create edit.
    const value = result.output[0]?.value as {
      errorMessage?: string
      failures?: Array<{ editIndex: number; path: string }>
    }
    expect(String(value?.errorMessage)).not.toContain(
      'capability-bearing edits require',
    )
    expect(String(value?.errorMessage)).toContain('lifecycle preflight failed')
    expect(value?.failures?.[0]?.editIndex).toBe(1)
    expect(clientCalls).toBe(0)
  })

  it('treats a str_replace edit with basedOnRead replacements as capability-bearing when scope is empty', async () => {
    let ioCalls = 0
    const result = await handleEditTransaction({
      previousToolCallFinished: Promise.resolve(),
      toolCall: {
        toolCallId: 'capability-str-replace-empty-scope',
        toolName: 'edit_transaction',
        input: {
          edits: [
            {
              type: 'str_replace',
              path: 'src/a.ts',
              replacements: [
                {
                  oldString: 'old',
                  newString: 'new',
                  allowMultiple: false,
                  basedOnRead: buildScopedReadCapability('src/a.ts'),
                },
              ],
            },
          ],
        },
      },
      fileProcessingState: getFileProcessingValues({
        strictReadBeforeEdit: false,
      }),
      logger,
      requestOptionalFile: async () => {
        ioCalls += 1
        return 'old\n'
      },
      requestClientToolCall: async () => {
        ioCalls += 1
        return []
      },
      writeToClient: () => undefined,
    } as any)

    const value = result.output[0]?.value as {
      errorMessage?: string
      failures?: Array<{ editIndex: number; path: string }>
    }
    expect(String(value?.errorMessage)).toContain(
      'capability-bearing edits require a nonempty authoritative projectId and runId',
    )
    expect(value?.failures).toHaveLength(1)
    expect(value?.failures?.[0]).toMatchObject({
      editIndex: 0,
      path: 'src/a.ts',
    })
    expect(ioCalls).toBe(0)
  })

  it('blocks a rewrite_symbol edit with readCapability when the authoritative scope is empty', async () => {
    const emptyScopeVariants: Array<Record<string, unknown>> = [
      {},
      { runId: '' },
      { fileContext: { projectRoot: '/project' } },
      { fileContext: { projectRoot: '/project' }, runId: '' },
      { fileContext: { projectRoot: '' }, runId: 'run' },
    ]

    for (const scopeVariant of emptyScopeVariants) {
      let ioCalls = 0
      const result = await handleEditTransaction({
        previousToolCallFinished: Promise.resolve(),
        toolCall: {
          toolCallId: 'capability-rewrite-symbol-empty-scope',
          toolName: 'edit_transaction',
          input: {
            edits: [
              {
                type: 'rewrite_symbol',
                path: 'src/b.ts',
                symbol: 'target',
                content: 'function target() { return 2 }',
                readCapability: buildScopedReadCapability('src/b.ts'),
              },
            ],
          },
        },
        ...scopeVariant,
        fileProcessingState: getFileProcessingValues({
          strictReadBeforeEdit: false,
        }),
        logger,
        requestOptionalFile: async () => {
          ioCalls += 1
          return 'function target() { return 1 }\n'
        },
        requestClientToolCall: async () => {
          ioCalls += 1
          return []
        },
        writeToClient: () => undefined,
      } as any)

      const value = result.output[0]?.value as {
        errorMessage?: string
        failures?: Array<{
          editIndex: number
          path: string
          errorMessage?: string
        }>
      }
      expect(String(value?.errorMessage)).toContain(
        'capability-bearing edits require a nonempty authoritative projectId and runId',
      )
      expect(value?.failures).toHaveLength(1)
      expect(value?.failures?.[0]).toMatchObject({
        editIndex: 0,
        path: 'src/b.ts',
      })
      expect(String(value?.failures?.[0]?.errorMessage)).toContain(
        'Authenticated capability scope is unavailable',
      )
      expect(ioCalls).toBe(0)
    }
  })

  it('does not block a rewrite_symbol edit without readCapability on the empty-scope guard', async () => {
    let clientCalls = 0
    const result = await handleEditTransaction({
      previousToolCallFinished: Promise.resolve(),
      toolCall: {
        toolCallId: 'plain-rewrite-symbol-empty-scope',
        toolName: 'edit_transaction',
        input: {
          edits: [
            {
              type: 'rewrite_symbol',
              path: 'src/b.ts',
              symbol: 'target',
              content: 'function target() { return 2 }',
            },
            {
              type: 'create',
              path: 'src/existing.ts',
              content: 'x',
            },
          ],
        },
      },
      // No fileContext and no runId: empty authoritative scope.
      fileProcessingState: getFileProcessingValues({
        strictReadBeforeEdit: false,
      }),
      logger,
      requestOptionalFile: async () => 'existing content\n',
      requestClientToolCall: async () => {
        clientCalls += 1
        return []
      },
      writeToClient: () => undefined,
    } as any)

    // A rewrite_symbol without a capability is not capability-bearing, so the
    // empty scope must not block it; the transaction proceeds to the
    // deterministic lifecycle preflight failure for the create edit.
    const value = result.output[0]?.value as {
      errorMessage?: string
      failures?: Array<{ editIndex: number; path: string }>
    }
    expect(String(value?.errorMessage)).not.toContain(
      'capability-bearing edits require',
    )
    expect(String(value?.errorMessage)).toContain('lifecycle preflight failed')
    expect(value?.failures?.[0]?.editIndex).toBe(1)
    expect(clientCalls).toBe(0)
  })
})
