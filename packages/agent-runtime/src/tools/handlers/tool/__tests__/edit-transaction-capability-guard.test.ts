import { describe, expect, it } from 'bun:test'

import { handleEditTransaction } from '../edit-transaction'
import { getFileProcessingValues } from '../write-file'
import {
  encodeReadCapabilityToken,
  getContentHash,
} from '@codebuff/common/util/content-hash'

import type { FileProcessingState } from '../write-file'
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

describe('edit_transaction preflight truncation reclassification (F1/F3)', () => {
  const baseHandlerParams = (params: {
    edits: unknown[]
    fileProcessingState: FileProcessingState
    requestOptionalFile?: (args: { filePath: string }) => Promise<string | null>
  }) => ({
    previousToolCallFinished: Promise.resolve(),
    toolCall: {
      toolCallId: 'preflight-truncation-test',
      toolName: 'edit_transaction',
      input: { edits: params.edits },
    },
    fileProcessingState: params.fileProcessingState,
    logger,
    requestOptionalFile: params.requestOptionalFile ?? (async () => null),
    requestClientToolCall: async () => [],
    writeToClient: () => undefined,
  })

  const freshState = () =>
    getFileProcessingValues({ strictReadBeforeEdit: false })

  it('reclassifies a transport-truncated str_replace newString as payload_truncated on the preflight-syntax path', async () => {
    // A str_replace whose newString was cut mid-body leaves the synthesized file
    // with more closers than openers. The whole-file balance corroboration
    // confirms the raw truncation signal, so the preflight syntax failure must be
    // reclassified from preflight_failed to payload_truncated on BOTH the
    // failureKind and the top-level errorCode. This is the direct
    // looksLikeTruncatedEditContent reclassification on the preflight-syntax
    // path (F3), exercised end-to-end through handleEditTransaction.
    const result = await handleEditTransaction(
      baseHandlerParams({
        edits: [
          {
            type: 'str_replace',
            path: 'src/a.ts',
            replacements: [
              {
                oldString: 'const x = rawValue',
                // Content cut mid-expression: the transport cut dropped the
                // enclosing `(` opener after a balanced head; the synthesized
                // file carries one more `)` than `(`, so Bun reports
                // `Unexpected )` and both the payload-level and whole-file raw
                // delimiter corroboration gates fire => payload_truncated.
                newString: 'const x = lookup(rawValue)\n)\n',
              },
            ],
          },
        ],
        fileProcessingState: freshState(),
        requestOptionalFile: async () => 'const x = rawValue\n',
      }) as any,
    )

    const value = result.output[0]?.value as {
      errorCode?: string
      errorMessage?: string
      failures?: Array<{ failureKind?: string; path?: string }>
    }
    expect(value.errorCode).toBe('payload_truncated')
    expect(value.failures?.[0]?.failureKind).toBe('payload_truncated')
    expect(String(value.errorMessage)).toContain(
      'the edit payload appears cut in transport',
    )
  })

  it('reclassifies a transport-truncated create edit as payload_truncated', async () => {
    // A create whose content was cut mid-body never enters processEditTransaction
    // and is validated directly by preflight; the same reclassification applies.
    const result = await handleEditTransaction(
      baseHandlerParams({
        edits: [
          {
            type: 'create',
            path: 'src/new-file.ts',
            // Cut mid-file: the tail below a balanced function carries a stray
            // `)` whose opener never arrived. Bun reports `Unexpected )` over
            // the whole file content, and the whole-file raw delimiter count
            // is negative => payload_truncated on both failureKind and
            // errorCode.
            content: 'export function run() {\n  return compute(arg)\n}\n)\n',
          },
        ],
        fileProcessingState: freshState(),
        requestOptionalFile: async () => null,
      }) as any,
    )

    const value = result.output[0]?.value as {
      errorCode?: string
      failures?: Array<{ failureKind?: string }>
    }
    expect(value.errorCode).toBe('payload_truncated')
    expect(value.failures?.[0]?.failureKind).toBe('payload_truncated')
  })

  it('keeps a genuine (whole-file-balanced) syntax error on preflight_failed, never payload_truncated', async () => {
    // The payload itself has a closer-over-opener surplus (the regex has a
    // trailing closer with no opener), yet the RAW delimiter count across the
    // whole synthesized file is balanced (not truncation-shaped). The raw-signal
    // corroboration in looksLikeTruncatedEditContent must refuse to
    // reclassify this genuine preflight syntax failure as payload_truncated —
    // it stays on preflight_failed (F1's mislabel risk is closed).
    const result = await handleEditTransaction(
      baseHandlerParams({
        edits: [
          {
            type: 'str_replace',
            path: 'src/a.ts',
            replacements: [
              {
                oldString: 'const x = rawValue',
                // Synthesized content: `const meta = /([{])([}\]])/;` — every
                // opener and closer in the regex character class is matched, so
                // the whole-file raw balance is zero. The runtime finds the
                // first unmatched closer within a balanced file, which is a
                // genuine syntax error, NOT a transport cut, so it must remain
                // preflight_failed and never payload_truncated.
                newString: 'const meta = /([{])([}\\]])/;',
                allowMultiple: false,
              },
            ],
          },
        ],
        fileProcessingState: freshState(),
        requestOptionalFile: async () => 'const x = rawValue\n',
      }) as any,
    )

    const value = result.output[0]?.value as {
      errorCode?: string
      errorMessage?: string
      failures?: Array<{ failureKind?: string }>
    }
    expect(value.errorCode).not.toBe('payload_truncated')
    expect(value.failures?.[0]?.failureKind).not.toBe('payload_truncated')
    expect(String(value.errorMessage ?? '')).not.toContain(
      'the edit payload appears cut in transport',
    )
  })
})

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
