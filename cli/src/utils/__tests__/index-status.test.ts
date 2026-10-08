import { afterEach, describe, expect, test } from 'bun:test'

import type { loadProviderConfigSync } from '@openbuff/sdk'

import {
  _resetIndexStatusTestState,
  _setIndexStatusTestOverrides,
  formatIndexStatusChip,
  peekIndexStatus,
  shouldForceStatusLineForIndex,
} from '../index-status'
import {
  autoCollapseBlocks,
  createAgentBlock,
  dropTransientCompactionBlocks,
  extractSpawnAgentResultContent,
  markPendingCompactionInterrupted,
  moveSpawnAgentBlock,
  nestBlockUnderParent,
  updateBlocksRecursively,
  updateToolBlockWithOutput,
} from '../message-block-helpers'
import type { ContentBlock, ToolContentBlock } from '../../types/chat'

describe('formatIndexStatusChip', () => {
  test('hides the chip when status is missing, disabled, or empty', () => {
    expect(formatIndexStatusChip(null)).toBeNull()
    expect(
      formatIndexStatusChip({ state: 'disabled', refreshing: false }),
    ).toBeNull()
    expect(
      formatIndexStatusChip({ state: 'empty', refreshing: false }),
    ).toBeNull()
  })

  test('shows building even when a refresh is also in flight', () => {
    expect(
      formatIndexStatusChip({ state: 'building', refreshing: true }),
    ).toEqual({
      label: 'idx building',
      tone: 'warning',
    })
    expect(
      formatIndexStatusChip({ state: 'building', refreshing: false }),
    ).toEqual({
      label: 'idx building',
      tone: 'warning',
    })
  })

  test('shows refreshing when a snapshot exists and a refresh is running', () => {
    expect(formatIndexStatusChip({ state: 'ready', refreshing: true })).toEqual(
      {
        label: 'idx refreshing',
        tone: 'warning',
      },
    )
    expect(
      formatIndexStatusChip({ state: 'degraded', refreshing: true }),
    ).toEqual({
      label: 'idx refreshing',
      tone: 'warning',
    })
  })

  test('shows stale, failed, and degraded chips, hides ready', () => {
    expect(
      formatIndexStatusChip({ state: 'stale', refreshing: false }),
    ).toEqual({
      label: 'idx stale',
      tone: 'warning',
    })
    expect(
      formatIndexStatusChip({ state: 'failed', refreshing: false }),
    ).toEqual({
      label: 'idx failed',
      tone: 'error',
    })
    expect(
      formatIndexStatusChip({ state: 'ready', refreshing: false }),
    ).toBeNull()
    expect(
      formatIndexStatusChip({ state: 'degraded', refreshing: false }),
    ).toEqual({
      label: 'idx degraded',
      tone: 'warning',
    })
  })
})

describe('shouldForceStatusLineForIndex', () => {
  test('keeps the status line open for building, refreshing, and failed', () => {
    expect(
      shouldForceStatusLineForIndex({ state: 'building', refreshing: false }),
    ).toBe(true)
    expect(
      shouldForceStatusLineForIndex({ state: 'ready', refreshing: true }),
    ).toBe(true)
    expect(
      shouldForceStatusLineForIndex({ state: 'failed', refreshing: false }),
    ).toBe(true)
  })

  test('does not force the status line for a quiet ready chip', () => {
    expect(shouldForceStatusLineForIndex(null)).toBe(false)
    expect(
      shouldForceStatusLineForIndex({ state: 'ready', refreshing: false }),
    ).toBe(false)
    expect(
      shouldForceStatusLineForIndex({ state: 'stale', refreshing: false }),
    ).toBe(false)
  })
})

// Builder for the traversal-guard regression tests below. These cover the
// performance-specialist findings against message-block-helpers (the guards
// live there); this is the only test file writable in this repair gate.
const nestedChain = (depth: number, leaf: Record<string, unknown>) => {
  let node: Record<string, unknown> = leaf
  for (let i = 0; i < depth; i += 1) {
    node = { nested: node }
  }
  return node
}

describe('message-block-helpers: cappedJsonStringify traversal guards', () => {
  test('deeply nested agent result values degrade to a depth marker instead of a stack overflow', () => {
    const result = extractSpawnAgentResultContent(
      nestedChain(20_000, { done: true }),
    )
    expect(result.hasError).toBe(false)
    expect(result.content).toContain('nested deeper than 32 levels')
  })

  test('self-referential agent result values degrade to a cycle marker instead of a stack overflow', () => {
    const cyclic: Record<string, unknown> = { note: 'loop' }
    cyclic.self = cyclic
    const result = extractSpawnAgentResultContent(cyclic)
    expect(result.hasError).toBe(false)
    expect(result.content).toContain('[Circular]')
  })

  test('wide non-string payloads stop enumerating once the budget is spent', () => {
    const COUNT = 100_000
    let reads = 0
    const target: Record<string, number> = {}
    for (let i = 0; i < COUNT; i += 1) target[`k${i}`] = i
    // Count property reads so the test observes the traversal work bound
    // directly: the trim budget must be charged for non-string leaves too,
    // otherwise every one of the COUNT entries is visited and stringified
    // before the final slice caps the output.
    const proxy: Record<string, number> = new Proxy(target, {
      get: (t, prop) => {
        reads += 1
        return Reflect.get(t, prop)
      },
    })
    const result = extractSpawnAgentResultContent({
      type: 'structuredOutput',
      value: proxy,
    })
    expect(result.hasError).toBe(false)
    expect(result.content).toContain('[truncated]')
    // O(cap) work bound: 100_000 entries exist but the budget only admits a
    // few hundred numeric leaves before it is spent.
    expect(reads).toBeLessThan(5_000)
  })

  test('large primitive arrays are trimmed by the budget instead of fully serialized', () => {
    const bigArray = Array.from({ length: 200_000 }, (_, i) => i)
    const result = extractSpawnAgentResultContent({
      type: 'structuredOutput',
      value: bigArray,
    })
    expect(result.hasError).toBe(false)
    expect(result.content).toContain('[truncated]')
    expect(result.content.length).toBeLessThanOrEqual(4_100)
  })
})

describe('message-block-helpers: deep media payload sanitization', () => {
  const toolBlockWithOutput = (toolOutput: unknown[]): ToolContentBlock => {
    const blocks: ContentBlock[] = [
      {
        type: 'tool',
        toolCallId: 'tool-deep-media',
        toolName: 'read_image',
        input: { paths: ['deep.png'] },
      },
    ]
    const result = updateToolBlockWithOutput(blocks, {
      toolCallId: 'tool-deep-media',
      toolOutput,
    })
    return result[0] as ToolContentBlock
  }

  test('sanitizes media payloads nested below the previous detection cap', () => {
    const data = 'a'.repeat(10_000)
    const toolBlock = toolBlockWithOutput([
      {
        value: nestedChain(12, {
          type: 'media',
          data,
          mediaType: 'image/png',
        }),
      },
    ])
    expect(toolBlock.output).toContain('mediaRedacted')
    expect(toolBlock.output).not.toContain(data)
    expect(JSON.stringify(toolBlock.outputRaw)).not.toContain(data)
  })

  test('never leaks raw media data to UI state regardless of nesting depth', () => {
    const data = 'b'.repeat(10_000)
    const toolBlock = toolBlockWithOutput([
      {
        value: nestedChain(48, {
          type: 'media',
          data,
          mediaType: 'image/png',
        }),
      },
    ])
    expect(toolBlock.output).not.toContain(data)
    expect(JSON.stringify(toolBlock.outputRaw)).not.toContain(data)
  })

  test('a pathologically deep tool output without media does not overflow the stack', () => {
    const toolBlock = toolBlockWithOutput([
      { value: nestedChain(20_000, { done: true }) },
    ])
    expect(toolBlock.output).toBeTruthy()
    // The depth-capped pre-check conservatively reports media-possible past
    // the cap, so the (independently depth-capped) sanitizer runs and bounds
    // the walk instead of the pre-check recursing to the bottom.
    expect(toolBlock.output).toContain('nested deeper than 32 levels')
  })

  test('a shared object referenced at several depths still routes media below the cap to the sanitizer', () => {
    // Encodes the reviewed scenario: one object is reachable at multiple
    // depths (shallow and deeper root entries share the same reference) and
    // the media payload sits at absolute depth ~33, below MAX_HAS_MEDIA_DEPTH.
    // Whatever memoization the traversal uses, a shared reference must never
    // cause the walk to report media-free when media is reachable below the
    // cap — the depth cap's conservative "media possibly present" result must
    // keep sanitizeMediaForUiState in the loop so outputRaw stays clean.
    const data = 'c'.repeat(10_000)
    let shared: Record<string, unknown> = {
      type: 'media',
      data,
      mediaType: 'image/png',
    }
    for (let i = 0; i < 31; i += 1) shared = { nested: shared }
    const toolBlock = toolBlockWithOutput([
      { value: shared },
      { value: { again: shared } },
    ])
    expect(toolBlock.output).not.toContain(data)
    expect(JSON.stringify(toolBlock.outputRaw)).not.toContain(data)
  })
})

describe('message-block-helpers: reviewer structured output cap', () => {
  // formatReviewerStructuredOutput is reached through the structuredOutput
  // dispatch chain in extractSpawnAgentResultContent.
  const reviewerValue = (extra: Record<string, unknown>) => ({
    family: 'reviewer',
    verdict: 'PASS',
    ...extra,
  })

  test('small reviewer payloads render every section without a truncation marker', () => {
    const result = extractSpawnAgentResultContent({
      type: 'structuredOutput',
      value: reviewerValue({
        reviewedFiles: ['a.ts', 'b.ts'],
        dimensions: { correctness: 'ok' },
        findings: [{ severity: 'MINOR', summary: 'nit', correction: 'fix it' }],
        requirementCoverage: [{ requirement: 'req-1', status: 'satisfied' }],
        advisories: ['note'],
      }),
    })
    expect(result.hasError).toBe(false)
    expect(result.content).toContain('Verdict: PASS')
    expect(result.content).toContain('Reviewed files:')
    expect(result.content).toContain('- a.ts')
    expect(result.content).toContain('- correctness: ok')
    expect(result.content).toContain('[MINOR] nit')
    expect(result.content).toContain('  Fix: fix it')
    expect(result.content).toContain('- satisfied: req-1')
    expect(result.content).toContain('Advisories:')
    expect(result.content).toContain('- note')
    expect(result.content).not.toContain('[truncated]')
  })

  test('very large reviewedFiles/findings/advisories arrays cap the display string', () => {
    const longEntry = 'x'.repeat(200)
    const result = extractSpawnAgentResultContent({
      type: 'structuredOutput',
      value: reviewerValue({
        reviewedFiles: Array.from(
          { length: 500 },
          (_, i) => `${i}-${longEntry}`,
        ),
        findings: Array.from({ length: 500 }, (_, i) => ({
          severity: 'MAJOR',
          summary: `finding ${i} ${longEntry}`,
        })),
        advisories: Array.from(
          { length: 500 },
          (_, i) => `advisory ${i} ${longEntry}`,
        ),
        dimensions: { correctness: longEntry },
      }),
    })
    expect(result.hasError).toBe(false)
    // Same display bound as the sibling formatters in the dispatch chain
    // (formatEditorNestedOutput / cappedJsonStringify): the renderer never
    // receives an unbounded content string.
    expect(result.content.length).toBeLessThanOrEqual(4_100)
    expect(result.content).toContain('…[truncated]')
  })

  test('an oversized first field is sliced at the cap instead of allocating unbounded output', () => {
    const result = extractSpawnAgentResultContent({
      type: 'structuredOutput',
      value: { family: 'reviewer', verdict: 'z'.repeat(10_000) },
    })
    expect(result.hasError).toBe(false)
    expect(result.content.startsWith('Verdict: ')).toBe(true)
    expect(result.content.length).toBeLessThanOrEqual(4_100)
    expect(result.content).toContain('…[truncated]')
  })
})

describe('message-block-helpers: allocation-avoiding block rewrites', () => {
  test('rewrites return the original array reference when nothing changed', () => {
    // The block rewrites return the input reference when no block was updated
    // so React skips a re-render; pin that contract so an accidental
    // always-clone regression is caught.
    const blocks: ContentBlock[] = [
      { type: 'text', content: 'hello' },
      createAgentBlock({ agentId: 'agent-1', agentType: 'reviewer' }),
      {
        type: 'tool',
        toolCallId: 'tool-1',
        toolName: 'read_image',
        input: { paths: [] },
        userOpened: true,
      },
    ]
    expect(autoCollapseBlocks(blocks)).toBe(blocks)
    expect(dropTransientCompactionBlocks(blocks)).toBe(blocks)
    expect(markPendingCompactionInterrupted(blocks)).toBe(blocks)
    expect(updateBlocksRecursively(blocks, 'missing-id', (b) => b)).toBe(blocks)
    expect(
      updateToolBlockWithOutput(blocks, { toolCallId: 'nope', toolOutput: [] }),
    ).toBe(blocks)
  })
})

describe('peekIndexStatus caching', () => {
  afterEach(() => {
    _resetIndexStatusTestState()
  })

  const T0 = 1_000_000
  const ROOT = '/virtual/project/root'

  const fakeLoadedConfig = (
    indexingEnabled: boolean,
  ): ReturnType<typeof loadProviderConfigSync> =>
    // Minimal test double: the peek path reads only `config.indexing` (and on
    // it only `enabled`), so the full ProviderConfigFile shape is irrelevant
    // to this seam.
    ({
      config: { indexing: { enabled: indexingEnabled } },
      sourceFilePaths: [],
    }) as unknown as ReturnType<typeof loadProviderConfigSync>

  test('the 200ms peek cache short-circuits getInstance/getStatus on every tick inside the TTL', () => {
    let now = T0
    let providerConfigLoads = 0
    let getStatusCalls = 0
    _setIndexStatusTestOverrides({
      now: () => now,
      loadProviderConfig: () => {
        providerConfigLoads += 1
        return fakeLoadedConfig(true)
      },
      getRoot: () => ROOT,
      getStatus: () => {
        getStatusCalls += 1
        return { state: 'ready', refreshing: false }
      },
    })

    // The first peek pays the expensive path exactly once...
    expect(peekIndexStatus()).toEqual({ state: 'ready', refreshing: false })
    expect(getStatusCalls).toBe(1)
    expect(providerConfigLoads).toBe(1)

    // ...and render ticks inside the 200ms window are served from the peek
    // cache without touching getInstance/getStatus (or the config load) again.
    for (let tick = 1; tick <= 50; tick += 1) {
      now = T0 + tick * 3
      expect(peekIndexStatus()).toEqual({ state: 'ready', refreshing: false })
    }
    expect(getStatusCalls).toBe(1)
    expect(providerConfigLoads).toBe(1)
  })

  test('the peek cache expires at the TTL boundary and re-consults getStatus', () => {
    let now = T0
    let getStatusCalls = 0
    _setIndexStatusTestOverrides({
      now: () => now,
      loadProviderConfig: () => fakeLoadedConfig(true),
      getRoot: () => ROOT,
      getStatus: () => {
        getStatusCalls += 1
        return { state: 'ready', refreshing: false }
      },
    })

    expect(peekIndexStatus()).toEqual({ state: 'ready', refreshing: false })
    now = T0 + 100
    expect(peekIndexStatus()).toEqual({ state: 'ready', refreshing: false })
    expect(getStatusCalls).toBe(1)
    now = T0 + 200
    expect(peekIndexStatus()).toEqual({ state: 'ready', refreshing: false })
    expect(getStatusCalls).toBe(2)
  })

  test('cached peeks are an order of magnitude cheaper than recomputing the status path', () => {
    // In-process A/B evidence for the peek cache: the same number of peeks,
    // first with every peek forced past the TTL (the pre-cache per-tick cost:
    // getInstance + getStatus on every render tick), then served from the
    // cache. The getStatus double burns ~0.1ms of real CPU per call so the
    // wall-clock gap is attributable to the cache short-circuit, not to the
    // double being free.
    const PEEKS = 200
    let getStatusCalls = 0
    const getStatus = () => {
      getStatusCalls += 1
      const end = performance.now() + 0.1
      while (performance.now() < end) {
        // Busy-wait ~0.1ms per call to stand in for the real singleton
        // lookup + status computation.
      }
      return { state: 'ready' as const, refreshing: false }
    }

    // "before" arm: the clock jumps 1s per peek, so every peek is past the
    // 200ms TTL and recomputes the full path.
    let beforeNow = T0
    _setIndexStatusTestOverrides({
      now: () => (beforeNow += 1_000),
      loadProviderConfig: () => fakeLoadedConfig(true),
      getRoot: () => ROOT,
      getStatus,
    })
    const beforeStart = performance.now()
    for (let i = 0; i < PEEKS; i += 1) peekIndexStatus()
    const beforeMs = performance.now() - beforeStart
    expect(getStatusCalls).toBe(PEEKS)

    _resetIndexStatusTestState()

    // "after" arm: same peek count with the clock parked inside the TTL, so
    // every peek after the priming one is served from the peek cache.
    getStatusCalls = 0
    _setIndexStatusTestOverrides({
      now: () => T0,
      loadProviderConfig: () => fakeLoadedConfig(true),
      getRoot: () => ROOT,
      getStatus,
    })
    peekIndexStatus()
    const afterStart = performance.now()
    for (let i = 0; i < PEEKS; i += 1) peekIndexStatus()
    const afterMs = performance.now() - afterStart
    expect(getStatusCalls).toBe(1)

    // The cached path must be dramatically cheaper — the short-circuit is the
    // whole point of the 200ms peek cache.
    expect(afterMs).toBeLessThan(Math.max(beforeMs / 10, 1))
  })

  test('a failed provider-config load backs off instead of reloading every peek', () => {
    let now = T0
    let loadAttempts = 0
    let getStatusCalls = 0
    _setIndexStatusTestOverrides({
      now: () => now,
      loadProviderConfig: () => {
        loadAttempts += 1
        throw new Error('config rewritten mid-read')
      },
      getRoot: () => ROOT,
      getStatus: () => {
        getStatusCalls += 1
        return { state: 'ready', refreshing: false }
      },
    })

    // First peek attempts the synchronous load and fails.
    expect(peekIndexStatus()).toBeNull()
    expect(loadAttempts).toBe(1)
    expect(getStatusCalls).toBe(0)

    // A repeat peek inside the 200ms window is served from the (null) peek
    // cache without another attempt.
    expect(peekIndexStatus()).toBeNull()
    expect(loadAttempts).toBe(1)

    // Once the peek cache expires, the 5s failure backoff — not the load —
    // keeps the synchronous file I/O off the render path.
    now = T0 + 250
    expect(peekIndexStatus()).toBeNull()
    expect(loadAttempts).toBe(1)

    // After the backoff window the load is retried, so a transient failure
    // recovers instead of being latched in permanently.
    now = T0 + 6_000
    expect(peekIndexStatus()).toBeNull()
    expect(loadAttempts).toBe(2)
    expect(getStatusCalls).toBe(0)
  })

  test('a disabled indexing config never reaches the singleton and reloads after the 30s config TTL', () => {
    let now = T0
    let indexingEnabled = false
    let providerConfigLoads = 0
    let getStatusCalls = 0
    _setIndexStatusTestOverrides({
      now: () => now,
      loadProviderConfig: () => {
        providerConfigLoads += 1
        return fakeLoadedConfig(indexingEnabled)
      },
      getRoot: () => ROOT,
      getStatus: () => {
        getStatusCalls += 1
        return { state: 'ready', refreshing: false }
      },
    })

    // Disabled indexing: null without ever constructing/consulting the
    // IndexManager singleton.
    expect(peekIndexStatus()).toBeNull()
    expect(getStatusCalls).toBe(0)
    expect(providerConfigLoads).toBe(1)

    // The negative config cache holds inside the 30s provider-config TTL: no
    // reload and no getStatus even as render ticks keep arriving.
    now = T0 + 1_000
    expect(peekIndexStatus()).toBeNull()
    expect(providerConfigLoads).toBe(1)
    expect(getStatusCalls).toBe(0)

    // A mid-session re-enable is picked up once the config TTL expires.
    indexingEnabled = true
    now = T0 + 30_000
    expect(peekIndexStatus()).toEqual({ state: 'ready', refreshing: false })
    expect(providerConfigLoads).toBe(2)
    expect(getStatusCalls).toBe(1)
  })
})

describe('message-block-helpers: editor nested output truncation marker', () => {
  const assistantMessage = (text: string) => ({
    role: 'assistant',
    content: [{ type: 'text', text }],
  })

  test('a multi-fragment report beyond the cap keeps the tail and marks the dropped head', () => {
    // Eight fragments of 449 chars collect to 3592 <= the 4000 display cap,
    // and the 9th would overflow — exactly the shape where the backward
    // walk's early exit drops the head while the collected total never
    // exceeds DISPLAY_CAP, so only the explicit head-dropped marker can
    // signal that the report is a tail excerpt rather than a complete one.
    const fragment = (tag: string) => `${tag}-${'x'.repeat(440)}\n`
    const messages = Array.from({ length: 12 }, (_, i) =>
      assistantMessage(fragment(`frag-${String(i).padStart(2, '0')}`)),
    )
    const result = extractSpawnAgentResultContent({
      type: 'structuredOutput',
      value: {
        status: 'complete',
        changedFiles: ['a.ts'],
        output: { messages },
      },
    })
    expect(result.hasError).toBe(false)
    // Same truncation marker as the single-message path.
    expect(result.content).toContain('…[truncated]')
    expect(result.content.length).toBeLessThanOrEqual(4_100)
    // The oldest fragments are dropped; the newest survive.
    expect(result.content).not.toContain('frag-00')
    expect(result.content).toContain('frag-11')
  })

  test('a multi-fragment report within the cap renders in full with no marker', () => {
    const messages = Array.from({ length: 4 }, (_, i) =>
      assistantMessage(`part ${i} of the report\n`),
    )
    const result = extractSpawnAgentResultContent({
      type: 'structuredOutput',
      value: {
        status: 'complete',
        changedFiles: [],
        output: { messages },
      },
    })
    expect(result.hasError).toBe(false)
    expect(result.content).toContain('part 0 of the report')
    expect(result.content).toContain('part 3 of the report')
    expect(result.content).not.toContain('…[truncated]')
  })
})

describe('message-block-helpers: structural rewrites reach deep targets', () => {
  const agentBlock = (agentId: string): Extract<ContentBlock, { type: 'agent' }> => ({
    type: 'agent',
    agentId,
    agentName: 'Agent',
    agentType: 'worker',
    content: '',
    status: 'running',
    blocks: [],
    initialPrompt: '',
  })

  const deepAgentChain = (depth: number, leaf: ContentBlock): ContentBlock => {
    let node: ContentBlock = leaf
    for (let i = 0; i < depth; i += 1) {
      node = { ...agentBlock(`chain-${i}`), blocks: [node] }
    }
    return node
  }

  const findAgentBlock = (
    blocks: ContentBlock[],
    agentId: string,
  ): ContentBlock | undefined => {
    for (const block of blocks) {
      if (block.type !== 'agent') continue
      if (block.agentId === agentId) return block
      const nested = block.blocks
        ? findAgentBlock(block.blocks, agentId)
        : undefined
      if (nested) return nested
    }
    return undefined
  }

  test('moveSpawnAgentBlock migrates tempId to realId beyond the auto-collapse depth cap', () => {
    // MAX_AUTO_COLLAPSE_DEPTH is 20; the temp-id block sits deeper than that,
    // where a render-time depth cap would silently strand it in its temp-id
    // state so later events matched by the real id never find it.
    const blocks: ContentBlock[] = [deepAgentChain(25, agentBlock('temp-1'))]
    const moved = moveSpawnAgentBlock(blocks, 'temp-1', 'real-1')
    expect(findAgentBlock(moved, 'temp-1')).toBeUndefined()
    expect(findAgentBlock(moved, 'real-1')).toBeDefined()
  })

  test('moveSpawnAgentBlock re-parents under a parent beyond the auto-collapse depth cap', () => {
    // The temp-id block sits at top level (as spawn blocks do) and the target
    // parent is nested deeper than MAX_AUTO_COLLAPSE_DEPTH: the extract +
    // nest passes must both reach it so the migration completes.
    const blocks: ContentBlock[] = [
      deepAgentChain(25, agentBlock('parent-deep')),
      agentBlock('temp-1'),
    ]
    const moved = moveSpawnAgentBlock(
      blocks,
      'temp-1',
      'real-1',
      'parent-deep',
    )
    const parent = findAgentBlock(moved, 'parent-deep')
    expect(
      parent?.type === 'agent' &&
        parent.blocks?.some(
          (b) => b.type === 'agent' && b.agentId === 'real-1',
        ),
    ).toBe(true)
    expect(findAgentBlock(moved, 'temp-1')).toBeUndefined()
  })

  test('nestBlockUnderParent reaches a parent beyond the auto-collapse depth cap', () => {
    const blocks: ContentBlock[] = [deepAgentChain(25, agentBlock('parent-deep'))]
    const { blocks: nested, parentFound } = nestBlockUnderParent(
      blocks,
      'parent-deep',
      agentBlock('child-1'),
    )
    expect(parentFound).toBe(true)
    const parent = findAgentBlock(nested, 'parent-deep')
    expect(
      parent?.type === 'agent' &&
        parent.blocks?.some(
          (b) => b.type === 'agent' && b.agentId === 'child-1',
        ),
    ).toBe(true)
  })
})
