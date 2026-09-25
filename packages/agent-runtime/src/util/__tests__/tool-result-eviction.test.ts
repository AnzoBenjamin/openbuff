import { describe, expect, it } from 'bun:test'

import {
  commitReceiptV1Schema,
  fileMutationResultV1Schema,
  getConfirmedAppliedActionsV1,
} from '@codebuff/common/tools/results/filesystem'
import {
  getContentHash,
  getExactContentHash,
} from '@codebuff/common/util/content-hash'

import {
  EVICTION_KEEP_RECENT_STEPS,
  EVICTION_MIN_SAVINGS_TOKENS,
  deriveProtectedEvictionPaths,
  evictStaleToolResults,
} from '../tool-result-eviction'

import type { TaskMemoryV1 } from '@codebuff/common/types/task-memory'
import type {
  AssistantMessage,
  Message,
  ToolMessage,
} from '@codebuff/common/types/messages/codebuff-message'

const bigToolResult = (toolName: string, callId: string): ToolMessage => ({
  role: 'tool',
  toolCallId: callId,
  toolName,
  content: [{ type: 'json', value: { output: 'x'.repeat(40_000) } }],
})

const assistantStep = (id: string): AssistantMessage => ({
  role: 'assistant',
  content: [
    {
      type: 'tool-call',
      toolCallId: id,
      toolName: 'read_files',
      input: {},
    },
  ],
})

/** N steps, each an assistant message followed by one large tool result. */
const buildHistory = (steps: number, override?: Partial<ToolMessage>) => {
  const messages: Message[] = [{ role: 'user', content: [{ type: 'text', text: 'go' }] }]
  for (let i = 0; i < steps; i++) {
    messages.push(assistantStep(`call-${i}`))
    messages.push({
      ...bigToolResult('read_files', `call-${i}`),
      ...override,
    })
  }
  return messages
}

describe('evictStaleToolResults', () => {
  it('keeps the most recent steps full and evicts older tool results', () => {
    const messages = buildHistory(EVICTION_KEEP_RECENT_STEPS + 2)
    const result = evictStaleToolResults(messages)

    expect(result.messages).not.toBe(messages)
    expect(result.evictedCount).toBe(2)
    expect(result.tokensSaved).toBeGreaterThanOrEqual(EVICTION_MIN_SAVINGS_TOKENS)

    const toolResults = result.messages.filter(
      (m): m is ToolMessage => m.role === 'tool',
    )
    // Oldest two steps evicted; the recent window keeps full bodies.
    expect(
      (toolResults[0].content[0] as { type: string; value: string }).value,
    ).toContain('[tool result evicted to free context')
    expect(
      (toolResults[1].content[0] as { type: string; value: string }).value,
    ).toContain('[tool result evicted to free context')
    for (let i = 2; i < toolResults.length; i++) {
      // Recent results keep their full JSON body (an object), not a tombstone.
      const part = toolResults[i].content[0]
      expect(part.type).toBe('json')
      if (part.type === 'json') {
        expect(typeof part.value).toBe('object')
      }
      expect(JSON.stringify(toolResults[i])).not.toContain(
        '[tool result evicted to free context',
      )
    }
  })

  it('never evicts protected results (keepDuringTruncation / pinned tags)', () => {
    const messages = buildHistory(EVICTION_KEEP_RECENT_STEPS + 2, {
      keepDuringTruncation: true,
    })
    const result = evictStaleToolResults(messages)
    expect(result.messages).toBe(messages)
    expect(result.evictedCount).toBe(0)

    const pinned = buildHistory(EVICTION_KEEP_RECENT_STEPS + 2, {
      tags: ['pinned'],
    })
    expect(evictStaleToolResults(pinned).messages).toBe(pinned)
  })

  it('is a no-op (same reference) when savings are below the floor', () => {
    const small: Message[] = []
    for (let i = 0; i < EVICTION_KEEP_RECENT_STEPS + 2; i++) {
      small.push(assistantStep(`call-${i}`))
      small.push({
        role: 'tool',
        toolCallId: `call-${i}`,
        toolName: 'read_files',
        content: [{ type: 'json', value: { output: 'tiny' } }],
      })
    }
    const result = evictStaleToolResults(small)
    expect(result.messages).toBe(small)
    expect(result.tokensSaved).toBe(0)
    expect(result.evictedCount).toBe(0)
  })

  it('is idempotent: already-evicted results are skipped', () => {
    const messages = buildHistory(EVICTION_KEEP_RECENT_STEPS + 2)
    const first = evictStaleToolResults(messages)
    expect(first.evictedCount).toBe(2)

    const second = evictStaleToolResults(first.messages)
    expect(second.messages).toBe(first.messages)
    expect(second.evictedCount).toBe(0)
  })

  it('honors custom keepRecentSteps and minSavingsTokens overrides', () => {
    const messages = buildHistory(EVICTION_KEEP_RECENT_STEPS + 2)
    // keepRecentSteps large enough that nothing is stale.
    const nothing = evictStaleToolResults(messages, {
      keepRecentSteps: EVICTION_KEEP_RECENT_STEPS + 5,
    })
    expect(nothing.messages).toBe(messages)

    // Tiny floor so even a small saving evicts.
    const everything = evictStaleToolResults(
      buildHistory(EVICTION_KEEP_RECENT_STEPS + 2),
      { minSavingsTokens: 1 },
    )
    expect(everything.evictedCount).toBe(2)
  })

  it('never mutates the input array or its untouched messages', () => {
    const messages = buildHistory(EVICTION_KEEP_RECENT_STEPS + 2)
    const snapshot = JSON.stringify(messages)
    evictStaleToolResults(messages)
    expect(JSON.stringify(messages)).toBe(snapshot)
  })

  it('keeps stale tool results whose content references a task-memory path', () => {
    const messages = buildHistory(EVICTION_KEEP_RECENT_STEPS + 2)
    // Step 0's result embeds the file a task-memory decision cites.
    const protectedResult = messages[2] as ToolMessage
    protectedResult.content = [
      { type: 'json', value: { output: 'export const KEY = 1 // src/keystone.ts' } },
    ]
    const taskMemory = {
      evidence: [
        { path: 'src/keystone.ts', source: 'src/keystone.ts' },
      ],
    } as unknown as TaskMemoryV1

    const result = evictStaleToolResults(messages, {
      protectedPaths: deriveProtectedEvictionPaths(taskMemory),
    })
    expect(result.evictedCount).toBe(1)
    const toolResults = result.messages.filter(
      (m): m is ToolMessage => m.role === 'tool',
    )
    // The cited result keeps its full body; the other stale one is evicted.
    expect(JSON.stringify(toolResults[0])).not.toContain(
      '[tool result evicted to free context',
    )
    expect(
      (toolResults[1].content[0] as { type: string; value: string }).value,
    ).toContain('[tool result evicted to free context')
  })

  it('derives protection paths from kind-prefixed list entries and drops unsafe ones', () => {
    const taskMemory = {
      filesInspected: ['read:src/a.ts', '/etc/passwd', '../escape.ts'],
      editsMade: ['edit:packages/x/y.ts', 'not a path at all'],
      evidence: [
        { path: 'docs/guide.md' },
        { source: 'deeply/nested/fixture.json' },
      ],
    } as unknown as TaskMemoryV1
    const paths = deriveProtectedEvictionPaths(taskMemory)

    expect(paths.has('src/a.ts')).toBe(true)
    expect(paths.has('packages/x/y.ts')).toBe(true)
    expect(paths.has('docs/guide.md')).toBe(true)
    expect(paths.has('deeply/nested/fixture.json')).toBe(true)
    // Absolute, traversal, and non-path entries never enter the set.
    expect(paths.has('/etc/passwd')).toBe(false)
    expect(paths.has('../escape.ts')).toBe(false)
    expect(paths.has('not a path at all')).toBe(false)
  })

  it('derives an empty set for missing memory (recency-only behavior)', () => {
    expect(deriveProtectedEvictionPaths(undefined).size).toBe(0)
    const messages = buildHistory(EVICTION_KEEP_RECENT_STEPS + 2)
    const before = evictStaleToolResults(messages)
    const after = evictStaleToolResults(messages, {
      protectedPaths: new Set(),
    })
    expect(after.evictedCount).toBe(before.evictedCount)
  })
})

describe('MAX_PROTECTED_CONTENT_SCAN_CHARS scan cap', () => {
  const PROTECTED_PATH = '/protected/deep/asset.ts'

  /** One stale step whose tool output embeds the protected path at a
   *  configurable offset, padded to a multi-megabyte serialized size so the
   *  scan-cap slice in contentReferencesProtectedPath actually engages. */
  const historyWithHugeToolResult = (
    prefixChars: number,
    suffixChars: number,
  ): Message[] => {
    const messages: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'go' }] },
    ]
    messages.push(assistantStep('call-0'))
    messages.push({
      role: 'tool',
      toolCallId: 'call-0',
      toolName: 'read_files',
      content: [
        {
          type: 'json',
          value: {
            output: 'x'.repeat(prefixChars) + PROTECTED_PATH + 'x'.repeat(suffixChars),
          },
        },
      ],
    })
    return messages
  }

  it('evicts a stale result whose protected path lies beyond the 5M-char scan region', () => {
    // The serialized content envelope is ~35 chars, so the path starts at
    // ~5_100_035 — comfortably past the 5_000_000-char scan cap, so the
    // bounded scan cannot see it and eviction fail-opens.
    const messages = historyWithHugeToolResult(5_100_000, 50_000)
    expect(JSON.stringify(messages[2]).length).toBeGreaterThan(5_000_000)

    const result = evictStaleToolResults(messages, {
      keepRecentSteps: 0,
      minSavingsTokens: 1,
      protectedPaths: new Set([PROTECTED_PATH]),
    })

    expect(result.evictedCount).toBe(1)
    const toolResult = result.messages[2] as ToolMessage
    const part = toolResult.content[0]
    expect(part.type).toBe('json')
    if (part.type === 'json') {
      expect(typeof part.value).toBe('string')
      expect(part.value).toContain('[tool result evicted to free context')
    }
  })

  it('keeps a stale result whose protected path lies within the 5M-char scan region', () => {
    // Same oversized shape, but the path sits ~1k chars into the serialized
    // content — inside the 5M scan region — so protection still applies.
    const messages = historyWithHugeToolResult(1_000, 5_100_000)
    expect(JSON.stringify(messages[2]).length).toBeGreaterThan(5_000_000)

    const result = evictStaleToolResults(messages, {
      keepRecentSteps: 0,
      minSavingsTokens: 1,
      protectedPaths: new Set([PROTECTED_PATH]),
    })

    // No candidates: the input array is returned untouched by reference.
    expect(result.evictedCount).toBe(0)
    expect(result.messages).toBe(messages)
    const part = (result.messages[2] as ToolMessage).content[0]
    expect(part.type).toBe('json')
    if (part.type === 'json') {
      expect(typeof part.value).toBe('object')
    }
  })
})

/**
 * R4 receipt-preserving eviction: an authority-backed edit_transaction
 * `file_mutation_result` is the only evidence `buildRuntimeAgentReceipt` can
 * use to credit a child's changed-file claims at settle time, so it must be
 * slimmed to a parseable receipt-bearing copy instead of tombstoned, and
 * small `commit_receipt` results must survive untouched.
 */
describe('receipt-preserving eviction (mutation receipts survive)', () => {
  const afterContent = 'export const fixed = true'

  /** A schema-valid applied mutation result WITH post-edit payloads, exactly
   *  the heavy shape a real edit_transaction success carries. */
  const appliedMutationResult = (path: string, callId: string) => {
    const afterHash = getExactContentHash(afterContent)
    const receiptId = `receipt-${callId}`
    const operationId = `operation-${callId}`
    const action = {
      actionId: `action-${callId}`,
      index: 0,
      action: 'update' as const,
      path,
      outcome: 'applied' as const,
      beforeHash: `before-${callId}`,
      afterHash,
      afterContent,
      editAnchor: {
        startLine: 1,
        endLine: 1,
        contentHash: getContentHash(afterContent),
        readCapability: 'cap-test-token',
      },
    }
    return {
      kind: 'file_mutation_result' as const,
      version: 1 as const,
      operationId,
      outcome: 'applied' as const,
      actions: [action],
      authorityTier: 'conditional_commit' as const,
      receiptId,
      authorityReceipt: {
        kind: 'commit_receipt' as const,
        version: 1 as const,
        receiptId,
        operationId,
        callId,
        authorityTier: 'conditional_commit' as const,
        status: 'committed' as const,
        actions: [
          {
            actionId: action.actionId,
            index: 0,
            action: 'update' as const,
            path,
            status: 'committed' as const,
            beforeHash: action.beforeHash,
            afterHash: action.afterHash,
          },
        ],
        finalHashes: { [path]: action.afterHash },
      },
      errors: [],
      freshCapabilities: [
        {
          kind: 'whole_file' as const,
          version: 1 as const,
          token: 'cap-test-token',
          snapshot: {
            kind: 'file_snapshot' as const,
            version: 1 as const,
            canonicalPath: path,
            contentHash: afterHash,
            sizeBytes: afterContent.length,
            encoding: 'utf8' as const,
            readGeneration: 1,
          },
        },
      ],
    }
  }

  const mutationToolResult = (callId: string, path: string): ToolMessage => ({
    role: 'tool',
    toolCallId: callId,
    toolName: 'edit_transaction',
    content: [
      { type: 'json', value: appliedMutationResult(path, callId) },
    ],
  })

  it('slims a stale file_mutation_result instead of tombstoning it', () => {
    const messages: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'go' }] },
      assistantStep('call-mut'),
      mutationToolResult('call-mut', 'src/fixed.ts'),
    ]

    const result = evictStaleToolResults(messages, {
      keepRecentSteps: 0,
      minSavingsTokens: 1,
    })

    expect(result.messages).not.toBe(messages)
    const toolResult = result.messages[2] as ToolMessage
    const part = toolResult.content[0]
    expect(part.type).toBe('json')
    expect(JSON.stringify(toolResult)).not.toContain(
      '[tool result evicted to free context',
    )
    if (part.type === 'json' && typeof part.value !== 'string') {
      const parsed = fileMutationResultV1Schema.safeParse(part.value)
      expect(parsed.success).toBe(true)
      const slimmed = parsed.data!
      // The slimmed receipt still attests the applied path for the
      // receipt builder's mutation-attestation extractor.
      expect(
        getConfirmedAppliedActionsV1(slimmed).map((action) => action.path),
      ).toEqual(['src/fixed.ts'])
      expect(slimmed.authorityReceipt?.status).toBe('committed')
      for (const action of slimmed.actions) {
        expect(action.afterContent).toBeUndefined()
        expect(action.editAnchor).toBeUndefined()
        expect(action.patch).toBeUndefined()
      }
      expect(slimmed.freshCapabilities).toEqual([])
    }
  })

  it('skips already-slimmed mutation results on a second pass (idempotent)', () => {
    const messages: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'go' }] },
      assistantStep('call-mut'),
      mutationToolResult('call-mut', 'src/fixed.ts'),
    ]

    const first = evictStaleToolResults(messages, {
      keepRecentSteps: 0,
      minSavingsTokens: 1,
    })
    expect(first.messages).not.toBe(messages)

    const second = evictStaleToolResults(first.messages, {
      keepRecentSteps: 0,
      minSavingsTokens: 1,
    })
    expect(second.messages).toBe(first.messages)
    expect(second.evictedCount).toBe(0)
  })

  it('leaves commit_receipt tool results untouched', () => {
    const commitReceipt = {
      kind: 'commit_receipt' as const,
      version: 1 as const,
      receiptId: 'receipt-commit',
      operationId: 'operation-commit',
      callId: 'call-commit',
      authorityTier: 'conditional_commit' as const,
      status: 'committed' as const,
      actions: [
        {
          actionId: 'action-commit',
          index: 0,
          action: 'update' as const,
          path: 'src/fixed.ts',
          status: 'committed' as const,
          beforeHash: 'before-commit',
          afterHash: 'after-commit',
        },
      ],
      finalHashes: { 'src/fixed.ts': 'after-commit' },
    }
    expect(commitReceiptV1Schema.safeParse(commitReceipt).success).toBe(true)
    const messages: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'go' }] },
      assistantStep('call-commit'),
      {
        role: 'tool',
        toolCallId: 'call-commit',
        toolName: 'edit_transaction',
        content: [{ type: 'json', value: commitReceipt }],
      },
    ]

    const result = evictStaleToolResults(messages, {
      keepRecentSteps: 0,
      minSavingsTokens: 1,
    })

    // Small control-plane evidence: never evicted, never rewritten.
    expect(result.messages).toBe(messages)
    expect(result.evictedCount).toBe(0)
    expect(JSON.stringify(result.messages)).toContain('commit_receipt')
  })

  it('still tombstones ordinary tool results', () => {
    const messages: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'go' }] },
      assistantStep('call-plain'),
      bigToolResult('read_files', 'call-plain'),
    ]

    const result = evictStaleToolResults(messages, {
      keepRecentSteps: 0,
      minSavingsTokens: 1,
    })

    expect(result.evictedCount).toBe(1)
    const part = (result.messages[2] as ToolMessage).content[0]
    expect(part.type).toBe('json')
    if (part.type === 'json') {
      expect(typeof part.value).toBe('string')
      expect(part.value).toContain('[tool result evicted to free context')
    }
  })
})