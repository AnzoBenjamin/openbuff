import { describe, expect, it } from 'bun:test'
import { getExactContentHash } from '@codebuff/common/util/content-hash'

import { mockFileContext } from '../../../../__tests__/test-utils'
import { handleStrReplace } from '../str-replace'
import { getFileProcessingValues } from '../write-file'
import {
  encodeReadCapabilityToken,
  getContentHash,
} from '../../../../process-str-replace'

import type { CodebuffToolCall } from '@codebuff/common/tools/list'
import type { CodebuffToolOutput } from '@codebuff/common/tools/list'
import type { Logger } from '@codebuff/common/types/contracts/logger'

const silentLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
}

function makeStrReplaceCall(
  input: CodebuffToolCall<'str_replace'>['input'],
): CodebuffToolCall<'str_replace'> {
  return {
    toolName: 'str_replace',
    toolCallId: 'circuit-breaker-call',
    input,
  } as unknown as CodebuffToolCall<'str_replace'>
}

const applicationScope = { projectId: '/project', runId: 'circuit-breaker-run' }
const handlerAuthority = {
  fileContext: {
    ...mockFileContext,
    projectRoot: applicationScope.projectId,
  },
  runId: applicationScope.runId,
}

const noopWriteToClient = (_chunk: string) => {}
const confirmedRequestClientToolCall =
  (expectedFinalContentByPath: Record<string, string>) =>
  async (toolCall: any) => {
    const requestedChanges = Array.isArray(toolCall.input.changes)
      ? toolCall.input.changes
      : [toolCall.input]
    const actions = requestedChanges.map(
      (change: { path: string; content: string }, index: number) => {
        const finalContent = expectedFinalContentByPath[change.path] ?? ''
        const afterHash = getExactContentHash(finalContent)
        const editAnchor = {
          startLine: 1,
          endLine: finalContent.split('\n').length,
          contentHash: getContentHash(finalContent),
          readCapability: encodeReadCapabilityToken({
            startLine: 1,
            endLine: finalContent.split('\n').length,
            hash: getContentHash(finalContent),
            scope: { ...applicationScope, path: change.path },
          }),
        }

        return {
          actionId: `circuit-breaker-action-${index}`,
          index,
          action: 'update' as const,
          path: change.path,
          outcome: 'applied' as const,
          beforeHash: 'before',
          afterHash,
          afterContent: finalContent,
          editAnchor,
        }
      },
    )
    const receipt = {
      kind: 'commit_receipt' as const,
      version: 1 as const,
      receiptId: 'circuit-breaker-receipt',
      operationId: 'circuit-breaker-operation',
      callId: toolCall.toolCallId,
      authorityTier: 'portable_path' as const,
      status: 'committed' as const,
      actions: actions.map((action: (typeof actions)[number]) => ({
        actionId: action.actionId,
        index: action.index,
        action: action.action,
        path: action.path,
        status: 'committed' as const,
        beforeHash: action.beforeHash,
        afterHash: action.afterHash,
        afterContent: action.afterContent,
        editAnchor: action.editAnchor,
      })),
      finalHashes: Object.fromEntries(
        actions.map((action: (typeof actions)[number]) => [
          action.path,
          action.afterHash,
        ]),
      ),
    }

    return [
      {
        type: 'json' as const,
        value: {
          kind: 'file_mutation_result' as const,
          version: 1 as const,
          operationId: 'circuit-breaker-operation',
          outcome: 'applied' as const,
          actions,
          authorityTier: 'portable_path' as const,
          receiptId: 'circuit-breaker-receipt',
          authorityReceipt: receipt,
          message: 'client confirmed edit',
          errors: [],
          freshCapabilities: [],
        },
      },
    ] as CodebuffToolOutput<'str_replace'>
  }

const unreachableRequestClientToolCall = confirmedRequestClientToolCall({})

describe('handleStrReplace circuit breaker (Fix C)', () => {
  it('does not mint reusable authority when strict internal auto-reread fails', async () => {
    const path = 'strict-auto-reread-failure.ts'
    const fileContent = 'const x = 1\n'
    const fileProcessingState = getFileProcessingValues({
      strictReadBeforeEdit: true,
    })

    const result = await handleStrReplace({
      previousToolCallFinished: Promise.resolve(),
      ...handlerAuthority,
      toolCall: makeStrReplaceCall({
        path,
        atomic: false,
        replacements: [
          {
            oldString: 'const missing = 1',
            newString: 'const missing = 2',
            allowMultiple: false,
          },
        ],
      }),
      fileProcessingState,
      logger: silentLogger,
      requestClientToolCall: unreachableRequestClientToolCall,
      requestOptionalFile: async () => fileContent,
      writeToClient: noopWriteToClient,
    })

    const value = result.output[0]?.value as
      | {
          basedOnRead?: string
          errorMessage?: string
          recovery?: { basedOnRead?: string; tool?: string }
        }
      | undefined
    const serializedResult = JSON.stringify(result.output)
    expect(value?.errorMessage).toContain('complete read')
    expect(value?.errorMessage).toContain('read_files')
    expect(value).not.toHaveProperty('basedOnRead')
    expect(value?.recovery).not.toHaveProperty('basedOnRead')
    expect(serializedResult).not.toContain('cap.v3.')
    expect(serializedResult).not.toContain('basedOnRead')
  })

  it('returns a circuit-breaker errorMessage when the per-path failure budget reaches the limit', async () => {
    const path = 'blocked.ts'
    // STR_REPLACE_MAX_CONSECUTIVE_FAILURES is 5 in source. Pre-set the counter
    // to the limit so the next call is the one that trips the breaker. The
    // breaker fires before any file processing, so the requestOptionalFile stub
    // is never reached.
    const fileProcessingState = getFileProcessingValues({
      consecutiveStrReplaceFailuresByPath: { [path]: 5 },
    })

    const result = await handleStrReplace({
      previousToolCallFinished: Promise.resolve(),
      ...handlerAuthority,
      toolCall: makeStrReplaceCall({
        path,
        atomic: false,
        replacements: [
          {
            oldString: 'const x = 1',
            newString: 'const x = 2',
            allowMultiple: false,
          },
        ],
      }),
      fileProcessingState,
      logger: silentLogger,
      requestClientToolCall: unreachableRequestClientToolCall,
      // Never reached because the breaker short-circuits first.
      requestOptionalFile: async () => null,
      writeToClient: noopWriteToClient,
    })

    const value = result.output[0]?.value as
      | { errorMessage?: string }
      | undefined
    expect(value).toBeDefined()
    expect(value?.errorMessage).toMatch(/^str_replace circuit breaker:/)
    expect(value?.errorMessage).toContain('failed or auto-corrected')
  })

  it('does NOT trip the breaker when the counter is below the limit', async () => {
    const path = 'allowed.ts'
    const fileProcessingState = getFileProcessingValues({
      consecutiveStrReplaceFailuresByPath: { [path]: 2 },
      // Disable strict read-before-edit so the handler reaches processStrReplace
      // (the breaker is the focus of this test, not the read gate).
      strictReadBeforeEdit: false,
    })

    const result = await handleStrReplace({
      previousToolCallFinished: Promise.resolve(),
      ...handlerAuthority,
      toolCall: makeStrReplaceCall({
        path,
        atomic: false,
        replacements: [
          {
            oldString: 'const x = 1',
            newString: 'const x = 2',
            allowMultiple: false,
          },
        ],
      }),
      fileProcessingState,
      logger: silentLogger,
      requestClientToolCall: unreachableRequestClientToolCall,
      // No file on disk -> processStrReplace reports "does not exist", which is
      // NOT the circuit-breaker message.
      requestOptionalFile: async () => null,
      writeToClient: noopWriteToClient,
    })

    const value = result.output[0]?.value as
      | { errorMessage?: string; message?: string }
      | undefined
    expect(value).toBeDefined()
    expect(value?.errorMessage).not.toMatch(/^str_replace circuit breaker:/)
  })

  it('does NOT reset the failure counter when a fresh basedOnRead is supplied — the breaker still trips at the limit', async () => {
    const path = 'not-cleared.ts'
    const fileContent = 'const x = 1\nconst y = 2\n'
    const fileProcessingState = getFileProcessingValues({
      consecutiveStrReplaceFailuresByPath: { [path]: 5 },
      strictReadBeforeEdit: false,
    })

    // Before the fix, a fresh basedOnRead cleared the consecutive-failure
    // counter, so a re-read-and-retry loop that kept failing never tripped the
    // breaker. After the fix, a fresh basedOnRead only clears
    // failedEditRequiresReadByPath (unblocking the edit); the counter is left
    // untouched, so it still trips at the limit and forces the agent to switch
    // tools. The token is a real minted capability so decode + hash validation
    // would succeed and the handler would reach processStrReplace — but the
    // breaker fires first.
    const freshReadToken = encodeReadCapabilityToken({
      startLine: 1,
      endLine: 2,
      hash: getContentHash(fileContent),
      scope: { ...applicationScope, path },
    })
    const result = await handleStrReplace({
      previousToolCallFinished: Promise.resolve(),
      ...handlerAuthority,
      toolCall: makeStrReplaceCall({
        path,
        atomic: false,
        replacements: [
          {
            oldString: 'const x = 1',
            newString: 'const x = 2',
            allowMultiple: false,
            basedOnRead: freshReadToken,
          },
        ],
      }),
      fileProcessingState,
      logger: silentLogger,
      requestClientToolCall: unreachableRequestClientToolCall,
      requestOptionalFile: async () => fileContent,
      writeToClient: noopWriteToClient,
    })

    const value = result.output[0]?.value as
      | { errorMessage?: string; message?: string }
      | undefined
    expect(value).toBeDefined()
    // The counter is pre-set to the limit and a fresh basedOnRead no longer
    // resets it, so the breaker must trip before any file processing.
    expect(value?.errorMessage).toMatch(/^str_replace circuit breaker:/)
    expect(value?.errorMessage).toContain('failed or auto-corrected')
    // The counter is NOT cleared by the fresh basedOnRead; it stays at the
    // limit.
    expect(fileProcessingState.consecutiveStrReplaceFailuresByPath[path]).toBe(
      5,
    )
  })

  it('trips the breaker after a re-read-and-retry loop of repeated failures even when each retry carries a fresh basedOnRead', async () => {
    // Reproduces the real-world failure mode the fix targets: the agent fails,
    // re-reads (minting a fresh basedOnRead), retries with the SAME broken
    // payload, fails again, re-reads, retries again... Before the fix each
    // fresh basedOnRead reset the counter so this loop never tripped the
    // breaker. After the fix the counter accumulates across re-reads and the
    // breaker fires once the counter is already at the limit at call start.
    const path = 'retry-loop.ts'
    const fileContent = 'const x = 1\nconst y = 2\n'
    const fileProcessingState = getFileProcessingValues({
      consecutiveStrReplaceFailuresByPath: { [path]: 4 },
      strictReadBeforeEdit: false,
    })

    const freshReadToken = encodeReadCapabilityToken({
      startLine: 1,
      endLine: 2,
      hash: getContentHash(fileContent),
      scope: { ...applicationScope, path },
    })
    // An oldString that does NOT exist in the file forces processStrReplace to
    // return a hard error, which increments the counter. The basedOnRead is
    // valid (fresh read) but cannot rescue a wrong oldString.
    const result = await handleStrReplace({
      previousToolCallFinished: Promise.resolve(),
      ...handlerAuthority,
      toolCall: makeStrReplaceCall({
        path,
        atomic: false,
        replacements: [
          {
            oldString: 'const NOT_PRESENT = 999',
            newString: 'const NOT_PRESENT = 1000',
            allowMultiple: false,
            basedOnRead: freshReadToken,
          },
        ],
      }),
      fileProcessingState,
      logger: silentLogger,
      requestClientToolCall: unreachableRequestClientToolCall,
      requestOptionalFile: async () => fileContent,
      writeToClient: noopWriteToClient,
    })

    const value = result.output[0]?.value as
      | { errorMessage?: string; message?: string }
      | undefined
    expect(value).toBeDefined()
    // This is the 5th consecutive failure (counter was 4, this failure makes
    // it 5). The breaker does NOT trip on this call (it trips when the counter
    // is ALREADY >= 5 at the START of the call), but the counter must now be 5
    // so the NEXT attempt — even with a fresh basedOnRead — will trip it.
    expect(value?.errorMessage ?? '').not.toMatch(
      /^str_replace circuit breaker:/,
    )
    expect(value?.errorMessage).toContain('str_replace retry limit reached')
    expect(fileProcessingState.consecutiveStrReplaceFailuresByPath[path]).toBe(
      5,
    )

    // Second attempt: a fresh basedOnRead re-read, same broken payload. Before
    // the fix the counter would reset to 0 here and the loop would continue
    // forever. After the fix the counter stays at 5 and the breaker trips.
    const freshReadToken2 = encodeReadCapabilityToken({
      startLine: 1,
      endLine: 2,
      hash: getContentHash(fileContent),
      scope: { ...applicationScope, path },
    })
    const result2 = await handleStrReplace({
      previousToolCallFinished: Promise.resolve(),
      ...handlerAuthority,
      toolCall: makeStrReplaceCall({
        path,
        atomic: false,
        replacements: [
          {
            oldString: 'const NOT_PRESENT = 999',
            newString: 'const NOT_PRESENT = 1000',
            allowMultiple: false,
            basedOnRead: freshReadToken2,
          },
        ],
      }),
      fileProcessingState,
      logger: silentLogger,
      requestClientToolCall: unreachableRequestClientToolCall,
      requestOptionalFile: async () => fileContent,
      writeToClient: noopWriteToClient,
    })

    const value2 = result2.output[0]?.value as
      | { errorMessage?: string; message?: string }
      | undefined
    expect(value2).toBeDefined()
    expect(value2?.errorMessage).toMatch(/^str_replace circuit breaker:/)
    // The breaker message must direct the agent to switch tools, which is the
    // whole point of breaking the loop.
    expect(value2?.errorMessage).toContain('rewrite_symbol')
    // Counter is unchanged by the tripped attempt (the breaker returns before
    // any processing that would increment it).
    expect(fileProcessingState.consecutiveStrReplaceFailuresByPath[path]).toBe(
      5,
    )
  })

  it('does not erase prior failures after an exact-match success', async () => {
    const path = 'alternating-loop.ts'
    const fileContent = 'const x = 1\nconst y = 2\n'
    const fileProcessingState = getFileProcessingValues({
      consecutiveStrReplaceFailuresByPath: { [path]: 3 },
      strictReadBeforeEdit: false,
    })

    const result = await handleStrReplace({
      previousToolCallFinished: Promise.resolve(),
      ...handlerAuthority,
      toolCall: makeStrReplaceCall({
        path,
        atomic: false,
        replacements: [
          {
            oldString: 'const x = 1',
            newString: 'const x = 2',
            allowMultiple: false,
          },
        ],
      }),
      fileProcessingState,
      logger: silentLogger,
      requestClientToolCall: confirmedRequestClientToolCall({
        [path]: 'const x = 2\nconst y = 2\n',
      }),
      requestOptionalFile: async () => fileContent,
      writeToClient: noopWriteToClient,
    })

    const value = result.output[0]?.value as
      | { errorMessage?: string; message?: string }
      | undefined
    expect(value?.errorMessage).toBeUndefined()
    // Clean success leaves the counter unchanged (3 → 3); no drain-by-1 and no
    // full erase to 0, so fail↔success oscillation still climbs to the limit.
    expect(fileProcessingState.consecutiveStrReplaceFailuresByPath[path]).toBe(
      3,
    )
  })

  it('charges the failure budget for a non-atomic partial success', async () => {
    const path = 'partial-loop.ts'
    const fileContent = 'const x = 1\nconst y = 2\n'
    const fileProcessingState = getFileProcessingValues({
      strictReadBeforeEdit: false,
    })

    const result = await handleStrReplace({
      previousToolCallFinished: Promise.resolve(),
      ...handlerAuthority,
      toolCall: makeStrReplaceCall({
        path,
        atomic: false,
        replacements: [
          {
            oldString: 'const x = 1',
            newString: 'const x = 2',
            allowMultiple: false,
          },
          {
            oldString: 'const missing = 1',
            newString: 'const missing = 2',
            allowMultiple: false,
          },
        ],
      }),
      fileProcessingState,
      logger: silentLogger,
      requestClientToolCall: confirmedRequestClientToolCall({
        [path]: 'const x = 2\nconst y = 2\n',
      }),
      requestOptionalFile: async () => fileContent,
      writeToClient: noopWriteToClient,
    })

    const value = result.output[0]?.value as
      | { errorMessage?: string; message?: string }
      | undefined
    expect(value?.errorMessage).toBeUndefined()
    expect(value?.message).toContain('Partial str_replace applied')
    expect(fileProcessingState.consecutiveStrReplaceFailuresByPath[path]).toBe(
      1,
    )
  })

  it('charges failure budget for autocorrected near-match and surfaces symmetric limit warning', async () => {
    const path = 'autocorrect-budget.ts'
    const initialContent = [
      'export function calculateTotal(items: Item[]) {',
      '  const subtotal = items.reduce((sum, item) => sum + item.price, 0)',
      '  return subtotal',
      '}',
    ].join('\n')
    const driftedOldString = [
      'export function calculateTotal(items: Item[]) {',
      '  const subTotal = items.reduce((sum, item) => sum + item.price, 0)',
      '  return subtotal',
      '}',
    ].join('\n')
    const newString = [
      'export function calculateTotal(items: Item[]) {',
      '  const subtotal = items.reduce((sum, item) => sum + item.price, 0)',
      '  return subtotal * 1.0825',
      '}',
    ].join('\n')
    const fileProcessingState = getFileProcessingValues({
      consecutiveStrReplaceFailuresByPath: { [path]: 4 },
      strictReadBeforeEdit: false,
    })
    const result = await handleStrReplace({
      previousToolCallFinished: Promise.resolve(),
      ...handlerAuthority,
      toolCall: makeStrReplaceCall({
        path,
        atomic: false,
        replacements: [
          { oldString: driftedOldString, newString, allowMultiple: false },
        ],
      }),
      fileProcessingState,
      logger: silentLogger,
      requestClientToolCall: confirmedRequestClientToolCall({
        [path]: newString,
      }),
      requestOptionalFile: async () => initialContent,
      writeToClient: noopWriteToClient,
    })
    const value = result.output[0]?.value as { message?: string; errorMessage?: string } | undefined
    expect(value?.errorMessage).toBeUndefined()
    expect(value?.message).toContain('auto-corrected a near-match edit')
    expect(value?.message).toContain('str_replace retry limit reached')
    expect(fileProcessingState.consecutiveStrReplaceFailuresByPath[path]).toBe(5)
  })

  it('does not increment failure budget on preflight syntax error (bypass)', async () => {
    const path = 'syntax-bypass.ts'
    const fileContent = 'export const value = 1\n'
    const fileProcessingState = getFileProcessingValues({
      consecutiveStrReplaceFailuresByPath: { [path]: 2 },
      strictReadBeforeEdit: false,
    })
    const result = await handleStrReplace({
      previousToolCallFinished: Promise.resolve(),
      ...handlerAuthority,
      toolCall: makeStrReplaceCall({
        path,
        atomic: false,
        replacements: [
          {
            oldString: 'export const value = 1',
            newString: 'export const value = {',
            allowMultiple: false,
          },
        ],
      }),
      fileProcessingState,
      logger: silentLogger,
      requestClientToolCall: unreachableRequestClientToolCall,
      requestOptionalFile: async () => fileContent,
      writeToClient: noopWriteToClient,
    })
    const value = result.output[0]?.value as { errorMessage?: string } | undefined
    expect(value?.errorMessage).toContain('Preflight')
    expect(fileProcessingState.consecutiveStrReplaceFailuresByPath[path]).toBe(2)
  })

  it('unique-only auto-reread: allowMultiple:true must fail closed under strictReadBeforeEdit', async () => {
    const path = 'unique-only-autoreread.ts'
    const fileContent = 'export const value = 1\nexport const value = 1\n'
    const fileProcessingState = getFileProcessingValues({
      strictReadBeforeEdit: true,
    })
    let applied = false
    const result = await handleStrReplace({
      previousToolCallFinished: Promise.resolve(),
      ...handlerAuthority,
      toolCall: makeStrReplaceCall({
        path,
        atomic: false,
        replacements: [
          {
            oldString: 'export const value = 1',
            newString: 'export const value = 2',
            allowMultiple: true,
          },
        ],
      }),
      fileProcessingState,
      logger: silentLogger,
      requestClientToolCall: async () => {
        applied = true
        return [] as any
      },
      requestOptionalFile: async () => fileContent,
      writeToClient: noopWriteToClient,
    })
    expect(applied).toBe(false)
    const value = result.output[0]?.value as { errorMessage?: string; errorCode?: string } | undefined
    expect(value?.errorCode).toBe('fresh_read_required')
    expect(String(value?.errorMessage)).toMatch(/read_files|basedOnRead|fresh/i)
    expect(fileProcessingState.consecutiveStrReplaceFailuresByPath[path]).toBeUndefined()
  })

  it('structuralRecovery bypasses circuit breaker on clean success and clears budget', async () => {
    const path = 'recovery-bypass.ts'
    const fileContent = 'export const value = 1\n'
    const fileProcessingState = getFileProcessingValues({
      consecutiveStrReplaceFailuresByPath: { [path]: 5 },
      strictReadBeforeEdit: false,
    })
    const result = await handleStrReplace({
      previousToolCallFinished: Promise.resolve(),
      ...handlerAuthority,
      toolCall: makeStrReplaceCall({
        path,
        atomic: false,
        replacements: [
          { oldString: 'export const value = 1', newString: 'export const value = 2', allowMultiple: false },
        ],
      }),
      fileProcessingState,
      logger: silentLogger,
      structuralRecovery: true,
      requestClientToolCall: confirmedRequestClientToolCall({
        [path]: 'export const value = 2\n',
      }),
      requestOptionalFile: async () => fileContent,
      writeToClient: noopWriteToClient,
    })
    const value = result.output[0]?.value as { errorMessage?: string } | undefined
    expect(value?.errorMessage).toBeUndefined()
    expect(fileProcessingState.consecutiveStrReplaceFailuresByPath[path]).toBeUndefined()
  })
})
