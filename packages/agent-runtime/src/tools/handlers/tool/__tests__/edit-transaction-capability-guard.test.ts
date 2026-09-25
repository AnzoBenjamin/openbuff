import { describe, expect, it } from 'bun:test'

import {
  handleEditTransaction,
  substituteConfirmedPostEditCapabilities,
} from '../edit-transaction'
import { getFileProcessingValues } from '../write-file'
import {
  encodeReadCapabilityToken,
  getContentHash,
} from '@codebuff/common/util/content-hash'
import {
  getLineCoordinates,
  getRangeSlice,
} from '@codebuff/common/util/line-coordinates'

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

describe('edit_transaction confirmed-post-edit substitution span guard', () => {
  const content = 'line1\nline2\nline3\n'
  const coordinates = getLineCoordinates(content)
  const anchorToken = (path: string): string =>
    encodeReadCapabilityToken({
      startLine: 1,
      endLine: coordinates.maxCapabilityLine,
      hash: getContentHash(
        getRangeSlice(coordinates, 1, coordinates.maxCapabilityLine),
      ),
      scope: { projectId: '/project', path, runId: 'run' },
    })
  const scopedStaleToken = (path: string): string =>
    encodeReadCapabilityToken({
      startLine: 2,
      endLine: 2,
      hash: getContentHash('STALE-SLICE'),
      scope: { projectId: '/project', path, runId: 'run' },
    })
  const wholeFileStaleToken = (path: string): string =>
    encodeReadCapabilityToken({
      startLine: 1,
      endLine: coordinates.maxCapabilityLine,
      hash: getContentHash('STALE-WHOLE'),
      scope: { projectId: '/project', path, runId: 'run' },
    })
  const scopedWholeFileToken = (scope: {
    projectId: string
    path: string
    runId: string
  }): string =>
    encodeReadCapabilityToken({
      startLine: 1,
      endLine: coordinates.maxCapabilityLine,
      hash: getContentHash('STALE-WHOLE'),
      scope,
    })

  const substitutionParams = (params: {
    edits: unknown[]
    onClientCall: () => void
  }) => ({
    previousToolCallFinished: Promise.resolve(),
    toolCall: {
      toolCallId: 'substitution-span-guard',
      toolName: 'edit_transaction',
      input: { edits: params.edits },
    },
    fileProcessingState: getFileProcessingValues({
      strictReadBeforeEdit: true,
    }),
    logger,
    requestOptionalFile: async () => content,
    requestClientToolCall: async () => {
      params.onClientCall()
      return []
    },
    writeToClient: () => undefined,
    fileContext: { projectRoot: '/project' },
    runId: 'run',
  })

  const freshAnchorState = (path: string): FileProcessingState => {
    const state = getFileProcessingValues({ strictReadBeforeEdit: true })
    ;(state as any).confirmedPostEditAnchorsByPath = {
      [path]: {
        startLine: 1,
        endLine: coordinates.visibleLineCount,
        contentHash: getContentHash(content),
        readCapability: anchorToken(path),
      },
    }
    return state
  }

  it('does not substitute a scoped replace_range capability with the whole-file anchor when target lines are omitted', async () => {
    // Regression for the span-widening clobber: pre-fix, the scoped token was
    // silently replaced by the fresh whole-file anchor, and with omitted
    // startLine/endLine the transaction defaulted the target span from the
    // SUBSTITUTED capability (1..N) — a whole-file clobber authorized by a
    // scoped read. Fail closed: the edit keeps its own token and fails on the
    // strict path without being forwarded for application.
    let forwarded = 0
    const state = freshAnchorState('src/a.ts')
    const result = await handleEditTransaction({
      ...substitutionParams({
        edits: [
          {
            type: 'replace_range',
            path: 'src/a.ts',
            readCapability: scopedStaleToken('src/a.ts'),
            newContent: 'line1\nreplaced\nline3\n',
          },
        ],
        onClientCall: () => {
          forwarded += 1
        },
      }),
      fileProcessingState: state,
    } as any)
    const value = result.output[0]?.value as {
      errorMessage?: string
      failures?: unknown[]
    }
    expect(forwarded).toBe(0)
    expect(String(value?.errorMessage ?? '')).not.toBe('')
  })

  // The substitution feeds ONLY processEditTransaction — the strict gate above
  // still evaluates the ORIGINAL edits — so substitution outcomes are observed
  // with direct unit tests of the exported function rather than through the
  // handler (whose strict gate blocks stale originals before substitution runs).

  it('still substitutes a whole-file-covering capability with a fresh whole-file anchor (unit)', () => {
    // The legitimate feature preserved: a whole-file capability that went
    // stale only because an earlier edit in this run changed the file takes
    // the fresh anchor — it grants nothing the caller did not already hold.
    const path = 'src/a.ts'
    const [out] = substituteConfirmedPostEditCapabilities(
      [
        {
          type: 'replace_range',
          path,
          readCapability: wholeFileStaleToken(path),
          newContent: 'fully replaced file\n',
        },
      ] as any,
      new Map([[path, content as string | null]]),
      freshAnchorState(path),
      '/project',
      'run',
      logger,
    )
    expect((out as { readCapability?: string }).readCapability).toBe(
      anchorToken(path),
    )
    expect((out as { readCapability?: string }).readCapability).not.toBe(
      wholeFileStaleToken(path),
    )
  })

  it('does not substitute a scoped replace_range capability with the whole-file anchor (unit)', () => {
    // Span guard: a scoped capability keeps its own token; substituting it
    // with the whole-file anchor would let an omitted startLine/endLine
    // default to the anchor's 1..N span — a whole-file clobber.
    const path = 'src/a.ts'
    const [out] = substituteConfirmedPostEditCapabilities(
      [
        {
          type: 'replace_range',
          path,
          readCapability: scopedStaleToken(path),
          newContent: 'line1\nreplaced\nline3\n',
        },
      ] as any,
      new Map([[path, content as string | null]]),
      freshAnchorState(path),
      '/project',
      'run',
      logger,
    )
    expect((out as { readCapability?: string }).readCapability).toBe(
      scopedStaleToken(path),
    )
  })

  it('does not substitute a scoped write_file basedOnRead with the whole-file anchor (unit)', () => {
    // write_file authorization semantics are whole-file; a scoped basedOnRead
    // must never be smuggled past the whole-file check via anchor substitution.
    const path = 'src/a.ts'
    const [out] = substituteConfirmedPostEditCapabilities(
      [
        {
          type: 'write_file',
          path,
          content,
          basedOnRead: scopedStaleToken(path),
        },
      ] as any,
      new Map([[path, content as string | null]]),
      freshAnchorState(path),
      '/project',
      'run',
      logger,
    )
    expect((out as { basedOnRead?: string }).basedOnRead).toBe(
      scopedStaleToken(path),
    )
  })

  it('does not substitute a foreign-scope whole-file capability with the anchor (unit)', () => {
    // Cross-scope anti-replay on the PROVIDED token: a decodable
    // whole-file-covering cap.v3 minted for a different path, run, or project
    // proves nothing about this file in this scope. Substituting it for the
    // fresh anchor would grant edit authority for a file the caller never
    // read in this run/path scope, so the token must be kept unchanged.
    const path = 'src/a.ts'
    const foreignScopes = [
      { projectId: '/project', path: 'src/other.ts', runId: 'run' },
      { projectId: '/project', path, runId: 'other-run' },
      { projectId: '/other-project', path, runId: 'run' },
    ]
    for (const scope of foreignScopes) {
      const foreignToken = scopedWholeFileToken(scope)
      const [out] = substituteConfirmedPostEditCapabilities(
        [
          {
            type: 'replace_range',
            path,
            readCapability: foreignToken,
            newContent: 'fully replaced file\n',
          },
        ] as any,
        new Map([[path, content as string | null]]),
        freshAnchorState(path),
        '/project',
        'run',
        logger,
      )
      expect((out as { readCapability?: string }).readCapability).toBe(
        foreignToken,
      )
    }
  })

  it('does not substitute a foreign-run whole-file write_file basedOnRead with the anchor (unit)', () => {
    // write_file authorization is whole-file: a foreign-run token that
    // happens to be whole-file covering must never take this run's anchor.
    const path = 'src/a.ts'
    const foreignToken = scopedWholeFileToken({
      projectId: '/project',
      path,
      runId: 'other-run',
    })
    const [out] = substituteConfirmedPostEditCapabilities(
      [
        {
          type: 'write_file',
          path,
          content,
          basedOnRead: foreignToken,
        },
      ] as any,
      new Map([[path, content as string | null]]),
      freshAnchorState(path),
      '/project',
      'run',
      logger,
    )
    expect((out as { basedOnRead?: string }).basedOnRead).toBe(foreignToken)
  })
})
