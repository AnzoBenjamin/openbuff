import { describe, expect, it } from 'bun:test'

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