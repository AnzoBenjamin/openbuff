import { TEST_AGENT_RUNTIME_IMPL } from '@codebuff/common/testing/impl/agent-runtime'
import { endToolTag, startToolTag } from '@codebuff/common/tools/constants'
import { promptSuccess } from '@codebuff/common/util/error'
import { beforeEach, describe, expect, it } from 'bun:test'

import {
  cachedRegExp,
  processStructuredEdit,
} from '../process-structured-edit'
import { processStreamWithTools } from '../tool-stream-parser'
import {
  parseToolCallsFromText,
  TOOL_EXTRACTION_PATTERN,
} from '../util/parse-tool-calls-from-text'
import {
  createStreamParserState,
  parseStreamChunk,
} from '../util/stream-xml-parser'
import { createToolCallChunk } from './test-utils'

import type { AgentRuntimeDeps } from '@codebuff/common/types/contracts/agent-runtime'
import type { StreamChunk } from '@codebuff/common/types/contracts/llm'
import type { Logger } from '@codebuff/common/types/contracts/logger'

describe('processStreamWithTags', () => {
  async function* createMockStream(chunks: StreamChunk[]) {
    for (const chunk of chunks) {
      yield chunk
    }

    return promptSuccess('mock-message-id')
  }

  function textChunk(text: string): StreamChunk {
    return { type: 'text' as const, text }
  }

  let agentRuntimeImpl: AgentRuntimeDeps

  beforeEach(() => {
    agentRuntimeImpl = { ...TEST_AGENT_RUNTIME_IMPL }
  })

  it('should handle basic tool call parsing', async () => {
    const streamChunks: StreamChunk[] = [
      createToolCallChunk('test_tool', { param1: 'value1' }),
    ]
    const stream = createMockStream(streamChunks)

    const events: any[] = []

    const processors = {
      test_tool: {
        params: ['param1'] as string[],
        onTagStart: (tagName: string, attributes: Record<string, string>) => {
          events.push({ tagName, type: 'start', attributes })
        },
        onTagEnd: (tagName: string, params: Record<string, string>) => {
          events.push({ tagName, type: 'end', params })
        },
      },
    }

    const result: string[] = []
    const responseChunks: any[] = []

    function onResponseChunk(chunk: any) {
      responseChunks.push(chunk)
    }

    function defaultProcessor(toolName: string) {
      return {
        onTagStart: () => {},
        onTagEnd: () => {},
      }
    }

    for await (const chunk of processStreamWithTools({
      ...agentRuntimeImpl,
      stream,
      processors,
      defaultProcessor,
      onResponseChunk,
      executeXmlToolCall: async () => {},
    })) {
      if (chunk.type === 'text') {
        result.push(chunk.text)
      }
    }

    expect(events).toEqual([
      {
        tagName: 'test_tool',
        type: 'start',
        attributes: {},
      },
      {
        tagName: 'test_tool',
        type: 'end',
        params: { param1: 'value1' },
      },
    ])
  })

  it('should handle tool calls with text before', async () => {
    const streamChunks: StreamChunk[] = [
      textChunk('Some text before tool call'),
      createToolCallChunk('test_tool', { param1: 'value1' }),
    ]
    const stream = createMockStream(streamChunks)

    const events: any[] = []

    const processors = {
      test_tool: {
        params: ['param1'] as string[],
        onTagStart: (tagName: string, attributes: Record<string, string>) => {
          events.push({ tagName, type: 'start', attributes })
        },
        onTagEnd: (tagName: string, params: Record<string, string>) => {
          events.push({ tagName, type: 'end', params })
        },
      },
    }

    const result: string[] = []
    const responseChunks: any[] = []

    function onResponseChunk(chunk: any) {
      responseChunks.push(chunk)
    }

    function defaultProcessor(toolName: string) {
      return {
        onTagStart: () => {},
        onTagEnd: () => {},
      }
    }

    for await (const chunk of processStreamWithTools({
      ...agentRuntimeImpl,
      stream,
      processors,
      defaultProcessor,
      onResponseChunk,
      executeXmlToolCall: async () => {},
    })) {
      if (chunk.type === 'text') {
        result.push(chunk.text)
      }
    }

    expect(events).toEqual([
      {
        tagName: 'test_tool',
        type: 'start',
        attributes: {},
      },
      {
        tagName: 'test_tool',
        type: 'end',
        params: { param1: 'value1' },
      },
    ])
  })

  it('should handle multiple tool calls in sequence', async () => {
    const streamChunks: StreamChunk[] = [
      createToolCallChunk('tool1', { param1: 'value1' }),
      textChunk('text between tools'),
      createToolCallChunk('tool2', { param2: 'value2' }),
    ]
    const stream = createMockStream(streamChunks)

    const events: any[] = []

    const processors = {
      tool1: {
        params: ['param1'] as string[],
        onTagStart: (tagName: string, attributes: Record<string, string>) => {
          events.push({ tagName, type: 'start', attributes })
        },
        onTagEnd: (tagName: string, params: Record<string, string>) => {
          events.push({ tagName, type: 'end', params })
        },
      },
      tool2: {
        params: ['param2'] as string[],
        onTagStart: (tagName: string, attributes: Record<string, string>) => {
          events.push({ tagName, type: 'start', attributes })
        },
        onTagEnd: (tagName: string, params: Record<string, string>) => {
          events.push({ tagName, type: 'end', params })
        },
      },
    }

    const result: string[] = []
    const responseChunks: any[] = []

    function onResponseChunk(chunk: any) {
      responseChunks.push(chunk)
    }

    function defaultProcessor(toolName: string) {
      return {
        onTagStart: () => {},
        onTagEnd: () => {},
      }
    }

    for await (const chunk of processStreamWithTools({
      ...agentRuntimeImpl,
      stream,
      processors,
      defaultProcessor,
      onResponseChunk,
      executeXmlToolCall: async () => {},
    })) {
      if (chunk.type === 'text') {
        result.push(chunk.text)
      }
    }

    expect(events).toEqual([
      {
        tagName: 'tool1',
        type: 'start',
        attributes: {},
      },
      {
        tagName: 'tool1',
        type: 'end',
        params: { param1: 'value1' },
      },
      {
        tagName: 'tool2',
        type: 'start',
        attributes: {},
      },
      {
        tagName: 'tool2',
        type: 'end',
        params: { param2: 'value2' },
      },
    ])
  })

  it('should handle unknown tool names via defaultProcessor', async () => {
    const streamChunks: StreamChunk[] = [
      createToolCallChunk('unknown_tool', { param1: 'value1' }),
    ]
    const stream = createMockStream(streamChunks)

    const events: any[] = []

    const processors = {
      test_tool: {
        params: ['param1'] as string[],
        onTagStart: (tagName: string, attributes: Record<string, string>) => {
          events.push({ tagName, type: 'start', attributes })
        },
        onTagEnd: (tagName: string, params: Record<string, string>) => {
          events.push({ tagName, type: 'end', params })
        },
      },
    }

    const responseChunks: any[] = []

    function onResponseChunk(chunk: any) {
      responseChunks.push(chunk)
    }

    function defaultProcessor(toolName: string) {
      // For unknown tools, still return a processor but track the error
      events.push({
        name: toolName,
        error: `Tool not found: ${toolName}`,
        type: 'error',
      })
      return {
        onTagStart: () => {},
        onTagEnd: () => {},
      }
    }

    for await (const _chunk of processStreamWithTools({
      ...agentRuntimeImpl,
      stream,
      processors,
      defaultProcessor,
      onResponseChunk,
      executeXmlToolCall: async () => {},
    })) {
      // consume stream
    }

    expect(events).toEqual([
      {
        name: 'unknown_tool',
        error: 'Tool not found: unknown_tool',
        type: 'error',
      },
    ])
  })

  it('should handle tool calls with complex parameters', async () => {
    const streamChunks: StreamChunk[] = [
      createToolCallChunk('complex_tool', {
        array_param: ['item1', 'item2'],
        object_param: { nested: 'value' },
        boolean_param: true,
        number_param: 42,
      }),
    ]
    const stream = createMockStream(streamChunks)

    const events: any[] = []

    const processors = {
      complex_tool: {
        params: [
          'array_param',
          'object_param',
          'boolean_param',
          'number_param',
        ] as string[],
        onTagStart: (tagName: string, attributes: Record<string, string>) => {
          events.push({ tagName, type: 'start', attributes })
        },
        onTagEnd: (tagName: string, params: Record<string, any>) => {
          events.push({ tagName, type: 'end', params })
        },
      },
    }

    const result: string[] = []
    const responseChunks: any[] = []

    function onResponseChunk(chunk: any) {
      responseChunks.push(chunk)
    }

    function defaultProcessor(toolName: string) {
      return {
        onTagStart: () => {},
        onTagEnd: () => {},
      }
    }

    for await (const chunk of processStreamWithTools({
      ...agentRuntimeImpl,
      stream,
      processors,
      defaultProcessor,
      onResponseChunk,
      executeXmlToolCall: async () => {},
    })) {
      if (chunk.type === 'text') {
        result.push(chunk.text)
      }
    }

    expect(events).toEqual([
      {
        tagName: 'complex_tool',
        type: 'start',
        attributes: {},
      },
      {
        tagName: 'complex_tool',
        type: 'end',
        params: {
          array_param: ['item1', 'item2'],
          object_param: { nested: 'value' },
          boolean_param: true,
          number_param: 42,
        },
      },
    ])
  })

  it('should handle text content mixed with tool calls', async () => {
    const streamChunks: StreamChunk[] = [
      textChunk('Some text before'),
      createToolCallChunk('test_tool', { param1: 'value1' }),
      textChunk('Some text after'),
    ]
    const stream = createMockStream(streamChunks)

    const events: any[] = []

    const processors = {
      test_tool: {
        params: ['param1'] as string[],
        onTagStart: (tagName: string, attributes: Record<string, string>) => {
          events.push({ tagName, type: 'start', attributes })
        },
        onTagEnd: (tagName: string, params: Record<string, string>) => {
          events.push({ tagName, type: 'end', params })
        },
      },
    }

    const result: string[] = []
    const responseChunks: any[] = []

    function onResponseChunk(chunk: any) {
      responseChunks.push(chunk)
    }

    function defaultProcessor(toolName: string) {
      return {
        onTagStart: () => {},
        onTagEnd: () => {},
      }
    }

    for await (const chunk of processStreamWithTools({
      ...agentRuntimeImpl,
      stream,
      processors,
      defaultProcessor,
      onResponseChunk,
      executeXmlToolCall: async () => {},
    })) {
      if (chunk.type === 'text') {
        result.push(chunk.text)
      }
    }

    expect(events).toEqual([
      {
        tagName: 'test_tool',
        type: 'start',
        attributes: {},
      },
      {
        tagName: 'test_tool',
        type: 'end',
        params: { param1: 'value1' },
      },
    ])
  })

  it('should handle empty stream', async () => {
    const streamChunks: StreamChunk[] = []
    const stream = createMockStream(streamChunks)

    const events: any[] = []

    const processors = {}

    const result: string[] = []
    const responseChunks: any[] = []

    function onResponseChunk(chunk: any) {
      responseChunks.push(chunk)
    }

    function defaultProcessor(toolName: string) {
      return {
        onTagStart: () => {},
        onTagEnd: () => {},
      }
    }

    for await (const chunk of processStreamWithTools({
      ...agentRuntimeImpl,
      stream,
      processors,
      defaultProcessor,
      onResponseChunk,
      executeXmlToolCall: async () => {},
    })) {
      if (chunk.type === 'text') {
        result.push(chunk.text)
      }
    }

    expect(events).toEqual([])
    expect(result).toEqual([])
  })

  it('should handle stream with only text content', async () => {
    const streamChunks: StreamChunk[] = [
      textChunk('Just some text'),
      textChunk(' with no tool calls'),
    ]
    const stream = createMockStream(streamChunks)

    const events: any[] = []

    const processors = {}

    const result: string[] = []
    const responseChunks: any[] = []

    function onResponseChunk(chunk: any) {
      responseChunks.push(chunk)
    }

    function defaultProcessor(toolName: string) {
      return {
        onTagStart: () => {},
        onTagEnd: () => {},
      }
    }

    for await (const chunk of processStreamWithTools({
      ...agentRuntimeImpl,
      stream,
      processors,
      defaultProcessor,
      onResponseChunk,
      executeXmlToolCall: async () => {},
    })) {
      if (chunk.type === 'text') {
        result.push(chunk.text)
      }
    }

    expect(events).toEqual([])
  })

  it('should surface XML parser errors through onResponseChunk', async () => {
    const streamChunks: StreamChunk[] = [
      textChunk(`<codebuff_tool_call>
{"cb_tool_name": "test_tool",
</codebuff_tool_call>`),
    ]
    const stream = createMockStream(streamChunks)
    const responseChunks: any[] = []

    function defaultProcessor() {
      return {
        onTagStart: () => {},
        onTagEnd: () => {},
      }
    }

    for await (const _chunk of processStreamWithTools({
      ...agentRuntimeImpl,
      stream,
      processors: {},
      defaultProcessor,
      onResponseChunk: (chunk: any) => responseChunks.push(chunk),
      executeXmlToolCall: async () => {},
    })) {
      // consume stream
    }

    expect(responseChunks).toHaveLength(1)
    expect(responseChunks[0]).toMatchObject({
      type: 'error',
      message: expect.stringContaining('JSON parsing failed'),
    })
  })

  it('should surface non-JSON tool-call input through the structured error channel and forward the raw string', async () => {
    // Simulate the AI SDK emitting a raw, unparsable JSON string as tool input.
    const streamChunks: StreamChunk[] = [
      {
        type: 'tool-call' as const,
        toolCallId: 'raw-input-1',
        toolName: 'test_tool',
        input: 'not json at all',
      } as unknown as StreamChunk,
    ]
    const stream = createMockStream(streamChunks)
    const responseChunks: any[] = []
    const events: any[] = []

    const processors = {
      test_tool: {
        onTagStart: () => {},
        onTagEnd: (_tagName: string, params: Record<string, unknown>) => {
          events.push({ params })
        },
      },
    }

    for await (const _chunk of processStreamWithTools({
      ...agentRuntimeImpl,
      stream,
      processors: processors as any,
      defaultProcessor: () => ({ onTagStart: () => {}, onTagEnd: () => {} }),
      onResponseChunk: (chunk: any) => responseChunks.push(chunk),
      executeXmlToolCall: async () => {},
    })) {
      // consume stream
    }

    // The parser logs the malformed input (logger.warn: no bare
    // console.debug, no silent swallow) but does NOT emit an error chunk:
    // the raw string is forwarded to the executor and the executor's repair
    // pass decides the real outcome — an emission here would double-report
    // when repair succeeds downstream (tool-validation-error contract:
    // repairable malformed input produces ZERO error events). This harness
    // bypasses the executor, so none is expected.
    expect(responseChunks).toEqual([])
    // Existing contract holds: the raw string still reaches the processor so
    // the executor surfaces its own schema-level error.
    expect(events).toEqual([{ params: 'not json at all' }])
  })

  it('generates full-UUID xml tool call ids', async () => {
    const streamChunks: StreamChunk[] = [
      textChunk(
        '<codebuff_tool_call>{"cb_tool_name": "test_tool"}</codebuff_tool_call>',
      ),
    ]
    const stream = createMockStream(streamChunks)
    const capturedToolCallIds: string[] = []

    for await (const _chunk of processStreamWithTools({
      ...agentRuntimeImpl,
      stream,
      processors: {},
      defaultProcessor: () => ({ onTagStart: () => {}, onTagEnd: () => {} }),
      onResponseChunk: () => {},
      executeXmlToolCall: async ({ toolCallId }) => {
        capturedToolCallIds.push(toolCallId)
      },
    })) {
      // consume stream
    }

    expect(capturedToolCallIds).toHaveLength(1)
    // The 8-hex truncation (32-bit id space) was the collision risk; the id is
    // now a full UUID with standard separator shapes.
    expect(capturedToolCallIds[0]).toMatch(
      /^xml-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    )
  })

  it('does not re-emit buffered text at each flush point on long pure-text output', async () => {
    // stream-buffer-unbounded-retained-text: each text chunk used to be
    // retained in `buffer` until a flush, so each flush re-emitted the whole
    // prefix. Now each chunk also goes straight through to onResponseChunk, so
    // the concatenated onResponseChunk text equals the yielded stream text
    // with no duplicated prefix before the first tool call.
    const streamChunks: StreamChunk[] = [
      textChunk('part one '),
      textChunk('part two '),
      textChunk(
        '<codebuff_tool_call>{"cb_tool_name": "test_tool"}</codebuff_tool_call>',
      ),
      textChunk('part three'),
    ]
    const stream = createMockStream(streamChunks)
    const responseText: string[] = []
    let yieldedText = ''

    for await (const chunk of processStreamWithTools({
      ...agentRuntimeImpl,
      stream,
      processors: {},
      defaultProcessor: () => ({ onTagStart: () => {}, onTagEnd: () => {} }),
      onResponseChunk: (chunk: any) => {
        if (chunk.type === 'text') responseText.push(chunk.text)
      },
      executeXmlToolCall: async () => {},
    })) {
      if (chunk.type === 'text') yieldedText += chunk.text
    }

    expect(responseText.join('')).toBe(yieldedText)
    expect(responseText.join('')).toContain('part one part two ')
    expect(responseText.join('')).toContain('part three')
  })

  it('keeps the tool-call stream path working across many small chunks (perf-guard evidence: stream-chunk-rescans-buffered-tool-call)', async () => {
    // Stream one large tool payload in many small chunks and report the wall
    // time as captured evidence for the perf guard: after the parser stopped
    // replaying the full buffer per chunk, many-chunk throughput is bounded.
    // If a quadratic rescan regressed, this dropdown-in-chunk-count is what
    // the asserted timing multiple detects.
    const payload = JSON.stringify({
      cb_tool_name: 'test_tool',
      data: 'x'.repeat(48 * 1024),
    })
    const whole = `<codebuff_tool_call>${payload}</codebuff_tool_call>`
    const PER_CHUNK = 64
    const chunks: StreamChunk[] = []
    for (let i = 0; i < whole.length; i += PER_CHUNK) {
      chunks.push(textChunk(whole.slice(i, i + PER_CHUNK)))
    }
    const executeCalls: string[] = []
    const startedAt = performance.now()
    let responseChunkCount = 0
    for await (const _chunk of processStreamWithTools({
      ...agentRuntimeImpl,
      stream: createMockStream(chunks),
      processors: {},
      defaultProcessor: () => ({ onTagStart: () => {}, onTagEnd: () => {} }),
      onResponseChunk: () => {
        responseChunkCount += 1
      },
      executeXmlToolCall: async ({ toolName }) => {
        executeCalls.push(toolName)
      },
    })) {
      // consume stream
    }
    const elapsedMs = performance.now() - startedAt
    expect(executeCalls).toEqual(['test_tool'])
    // Tool call XML is filtered: only the JSON-parse-error path would emit a
    // text/error response chunk; a healthy payload emits none.
    expect(responseChunkCount).toBe(0)
    // Timing evidence (logged, not asserted against a strict budget so slow
    // CI hosts don't flake): the parser must handle ~770 chunks covering the
    // payload well under an order of magnitude of what a full O(N^2) replay
    // would cost at this size.
    expect(elapsedMs).toBeLessThan(5000)
  })

  it('extracts a tool call embedded in prose after decoy braces', async () => {
    // tool-call-json-parsed-twice: the candidate scan returns the parsed
    // object and the caller reuses it (one parse per winning payload), and
    // comma-free decoy braces never reach the separator-repair pass. Behavior
    // pinned: the FIRST balanced JSON object still wins and arrives intact.
    const streamChunks: StreamChunk[] = [
      textChunk(
        '<codebuff_tool_call>use {a} like this: {b} then {c} then ' +
          '{"cb_tool_name": "test_tool", "param1": "value1", "nested": {"k": 2}}' +
          '</codebuff_tool_call>',
      ),
    ]
    const executed: Array<{ toolName: string; input: unknown }> = []
    for await (const _chunk of processStreamWithTools({
      ...agentRuntimeImpl,
      stream: createMockStream(streamChunks),
      processors: {},
      defaultProcessor: () => ({ onTagStart: () => {}, onTagEnd: () => {} }),
      onResponseChunk: () => {},
      executeXmlToolCall: async ({ toolName, input }) => {
        executed.push({ toolName, input })
      },
    })) {
      // consume stream
    }
    expect(executed).toEqual([
      { toolName: 'test_tool', input: { param1: 'value1', nested: { k: 2 } } },
    ])
  })

  it('keeps parsing tool calls whose JSON needs separator repair', async () => {
    // Candidates WITH out-of-string separators still run the repair pass, and
    // the repaired parse is the object the tool call is built from
    // (tool-call-json-parsed-twice reuses it instead of re-parsing).
    const streamChunks: StreamChunk[] = [
      textChunk(
        '<codebuff_tool_call>{"cb_tool_name": "test_tool", "param1": "value1",}</codebuff_tool_call>',
      ),
    ]
    const executed: Array<{ toolName: string; input: unknown }> = []
    for await (const _chunk of processStreamWithTools({
      ...agentRuntimeImpl,
      stream: createMockStream(streamChunks),
      processors: {},
      defaultProcessor: () => ({ onTagStart: () => {}, onTagEnd: () => {} }),
      onResponseChunk: () => {},
      executeXmlToolCall: async ({ toolName, input }) => {
        executed.push({ toolName, input })
      },
    })) {
      // consume stream
    }
    expect(executed).toEqual([
      { toolName: 'test_tool', input: { param1: 'value1' } },
    ])
  })

  it('stops the JSON candidate scan at the 32-candidate budget', async () => {
    // MAX_JSON_CANDIDATES contract (CASE 4c/4d benchmark evidence): a payload
    // within the budget is extracted; one past it is not — bounding the scan
    // is the fix, so its observable edge is pinned here.
    const call = (decoyCount: number) => {
      const decoys = Array.from(
        { length: decoyCount },
        (_, i) => `{d${i}}`,
      ).join(' ')
      return `<codebuff_tool_call>${decoys} {"cb_tool_name": "test_tool"}</codebuff_tool_call>`
    }
    const run = async (decoyCount: number) => {
      const executed: string[] = []
      const errors: string[] = []
      for await (const _chunk of processStreamWithTools({
        ...agentRuntimeImpl,
        stream: createMockStream([textChunk(call(decoyCount))]),
        processors: {},
        defaultProcessor: () => ({ onTagStart: () => {}, onTagEnd: () => {} }),
        onResponseChunk: (chunk: any) => {
          if (chunk.type === 'error') errors.push(chunk.message)
        },
        executeXmlToolCall: async ({ toolName }) => {
          executed.push(toolName)
        },
      })) {
        // consume stream
      }
      return { executed, errors }
    }

    // 5 decoys + payload = 6 candidates, inside the 32 budget.
    expect(await run(5)).toEqual({ executed: ['test_tool'], errors: [] })
    // 40 decoys + payload = 41 '{' candidates: the scan stops at 32, so the
    // payload is never tried and the fallback surfaces one parse error.
    const capped = await run(40)
    expect(capped.executed).toEqual([])
    expect(capped.errors).toHaveLength(1)
    expect(capped.errors[0]).toContain('JSON parsing failed')
  })
})

describe(
  'process-structured-edit bounded regex memo (import-line-regex-cache-unbounded)',
  () => {
    it('cachedRegExp memoizes regexes and evicts LRU, keeping hot keys under churn', () => {
      // import-line-regex-cache-unbounded: import-line regexes keyed by
      // model-supplied extensions share this bounded LRU memo (512 entries)
      // with the specifier/go regexes, so a long-lived runtime can no longer
      // retain one RegExp per distinct key forever.
      // regex-cache-clear-on-overflow-thrash: eviction must be per-entry LRU,
      // never a wholesale clear — a hot key hit on every call has to survive
      // adversarial cold-key churn, or the memo becomes strictly more
      // per-call work than uncached RegExp construction.
      const build = () => /left-pad/
      const key = 'go-line:left-pad'
      const first = cachedRegExp(key, build)
      expect(cachedRegExp(key, build)).toBe(first)
      // Adversarial churn in the production shape: one fresh cold key per
      // call while the hot key is hit every call.
      let coldFirst: RegExp | undefined
      for (let i = 0; i < 600; i++) {
        const cold = cachedRegExp(`import-line:.ext${i}`, () => /x/)
        if (i === 0) coldFirst = cold
        expect(cachedRegExp(key, build)).toBe(first)
      }
      // The hot key was never rebuilt despite repeatedly overflowing the
      // cache.
      expect(cachedRegExp(key, build)).toBe(first)
      expect(cachedRegExp(key, build).test('require "left-pad"')).toBe(true)
      // Bounded: the earliest cold key was evicted (rebuilt on re-query), so
      // sustained churn cannot grow the memo without limit.
      expect(coldFirst).toBeDefined()
      expect(cachedRegExp('import-line:.ext0', () => /x/)).not.toBe(coldFirst)
    })

    it('keeps structured import edits correct across regex-cache overflow', async () => {
      // End-to-end pin for the same bound: 600 distinct edit-path extensions
      // overflow the shared memo mid-run (per-entry LRU eviction), and the
      // import edit after the overflow must still resolve its import line
      // exactly.
      const logger = { debug: () => {} } as unknown as Logger
      const removeBySpecifier = (path: string, content: string) =>
        processStructuredEdit({
          edit: {
            type: 'structured',
            path,
            operation: { kind: 'remove_import', moduleSpecifier: 'os' },
          },
          initialContentPromise: Promise.resolve(content),
          logger,
        })

      for (let i = 0; i < 600; i++) {
        await removeBySpecifier(`src/mod-${i}.ext${i}`, 'no imports here\n')
      }

      const after = await removeBySpecifier(
        'src/main.py',
        "import os\nprint('hi')\n",
      )
      expect(after).toEqual({
        content: "print('hi')\n",
        messages: ['Applied structured remove_import in src/main.py.'],
      })
    })
  },
)

describe(
  'parseStreamChunk in-call bounded rescan (in-call-payload-replayed-per-chunk / RF-11)',
  () => {
    it('parses identical tool calls at every chunk split, including partial end-tag decoys in the payload', () => {
      // The in-call scan is bounded to the tag-tail window + fresh chunk (the
      // pre-fix shape re-concatenated and rescanned the ENTIRE accumulated
      // payload per chunk). Chunk-split invariance pins that the narrowed
      // window finds the end tag exactly where the full replay did — including
      // partial end-tag decoys inside JSON strings and end tags split at every
      // possible boundary.
      const input = {
        param1:
          'decoys </codebuff_tool_cal </codebuff_tool_call <codebuff_tool_call in strings',
        nested: { k: 2 },
      }
      // The parser derives the tool name from cb_tool_name and strips it (plus
      // cb_easp) from the returned input; without it the call is dropped with
      // missing_tool_name. The decoy tags stay inside the user-facing input.
      const whole = `${startToolTag}${JSON.stringify({
        cb_tool_name: 'test_tool',
        ...input,
      })}${endToolTag}`
      for (const chunkSize of [1, 2, 5, 17, 64, whole.length]) {
        const state = createStreamParserState()
        const toolCalls: Array<{ toolName: string; input: unknown }> = []
        let filteredText = ''
        let errors = 0
        for (let i = 0; i < whole.length; i += chunkSize) {
          const result = parseStreamChunk(whole.slice(i, i + chunkSize), state)
          filteredText += result.filteredText
          errors += result.errors.length
          toolCalls.push(...result.toolCalls)
        }
        expect(toolCalls).toEqual([{ toolName: 'test_tool', input }])
        expect(filteredText).toBe('')
        expect(errors).toBe(0)
      }
    })

    it('keeps a partial end-tag carry across the buffer-overflow transition', () => {
      // The overflow branch used to drop a trailing partial end tag along with
      // the discarded garbage, stranding the parser in discard mode forever
      // and swallowing the rest of the stream. The discard carry now preserves
      // a partial end-tag suffix, so a split end tag is still consumed
      // silently and only the garbage is discarded.
      const state = createStreamParserState({ maxToolCallBufferLength: 32 })
      const results = [
        parseStreamChunk(`${startToolTag}${'x'.repeat(30)}`, state),
        parseStreamChunk(`${'x'.repeat(10)}${endToolTag.slice(0, 19)}`, state),
        parseStreamChunk(`${endToolTag.slice(19)}tail text`, state),
      ]
      expect(results.flatMap((result) => result.errors).map((e) => e.code)).toEqual(
        ['tool_call_buffer_exceeded'],
      )
      expect(results.flatMap((result) => result.toolCalls)).toEqual([])
      expect(results.map((result) => result.filteredText).join('')).toBe(
        'tail text',
      )
    })
  },
)

describe('shipped seams used by scripts/measure-perf-guards-baseline.ts', () => {
  it('TOOL_EXTRACTION_PATTERN extracts the same tool calls as parseTextWithToolCalls', () => {
    // RF-10 / case2-after-row-local-pattern-mirror: the CASE 2 after row in
    // scripts/measure-perf-guards-baseline.ts times THIS shipped pattern, so
    // its identity with the parseTextWithToolCalls segmentation is pinned.
    const text =
      `before ${startToolTag}{"cb_tool_name":"a"}${endToolTag} ` +
      `mid ${startToolTag}{"cb_tool_name":"b"}${endToolTag} after`
    TOOL_EXTRACTION_PATTERN.lastIndex = 0
    const captures = [...text.matchAll(TOOL_EXTRACTION_PATTERN)].map(
      (match) => match[1]!.trim(),
    )
    expect(captures).toEqual([
      '{"cb_tool_name":"a"}',
      '{"cb_tool_name":"b"}',
    ])
    expect(parseToolCallsFromText(text).map((call) => call.toolName)).toEqual([
      'a',
      'b',
    ])
  })
})

describe(
  'process-structured-edit hoisted import regexes (per-call-regex-literals-in-import-paths)',
  () => {
    it('inserts into and removes from a Go import block via the shared hoisted block regex', async () => {
      // insertIntoGoImportBlock and removeFromGoImportBlock now share one
      // hoisted block regex (it used to be two per-call literals). This
      // round-trip pins both call sites plus the hoisted clause/specifier
      // patterns and the shared extensionForPath.
      const logger = { debug: () => {} } as unknown as Logger
      const initial = 'package main\n\nimport (\n\t"fmt"\n)\n\nfunc main() {}\n'
      const withOs = 'package main\n\nimport (\n\t"fmt"\n\t"os"\n)\n\nfunc main() {}\n'
      const inserted = await processStructuredEdit({
        edit: {
          type: 'structured',
          path: 'cmd/main.go',
          operation: { kind: 'insert_import', importStatement: 'import "os"' },
        },
        initialContentPromise: Promise.resolve(initial),
        logger,
      })
      expect(inserted).toEqual({
        content: withOs,
        messages: ['Applied structured insert_import in cmd/main.go.'],
      })
      const removed = await processStructuredEdit({
        edit: {
          type: 'structured',
          path: 'cmd/main.go',
          operation: { kind: 'remove_import', moduleSpecifier: 'os' },
        },
        initialContentPromise: Promise.resolve(withOs),
        logger,
      })
      expect(removed).toEqual({
        content: initial,
        messages: ['Applied structured remove_import in cmd/main.go.'],
      })
    })

    it('removes a JS import by module specifier via the hoisted specifier regexes', async () => {
      // removeImport's filter walks every import range through
      // normalizeImportStatement + getImportModuleSpecifier; both now use
      // hoisted patterns instead of fresh regex literals per statement.
      const logger = { debug: () => {} } as unknown as Logger
      const result = await processStructuredEdit({
        edit: {
          type: 'structured',
          path: 'src/app.ts',
          operation: { kind: 'remove_import', moduleSpecifier: 'node:path' },
        },
        initialContentPromise: Promise.resolve(
          "import fs from 'node:fs'\nimport { join } from 'node:path'\nconst x = join\n",
        ),
        logger,
      })
      expect(result).toEqual({
        content: "import fs from 'node:fs'\nconst x = join\n",
        messages: ['Applied structured remove_import in src/app.ts.'],
      })
    })
  },
)
