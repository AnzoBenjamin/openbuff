import { describe, expect, test } from 'bun:test'

import type { PrintModeEvent } from '@codebuff/common/types/print-mode'

import {
  printModeErrorToRpcError,
  printModeToSessionUpdates,
  UnhandledPrintModeVariantError,
} from '../event-bridge'
import type { EventBridgeContext } from '../event-bridge'

function makeCtx(overrides?: Partial<EventBridgeContext>): EventBridgeContext {
  return {
    sessionId: 's1',
    runId: 'run-1',
    eventsMode: 'acp',
    projectRoot: '/proj',
    toolKind: (toolName) => (toolName === 'write_file' ? 'edit' : 'other'),
    ...overrides,
  }
}

describe('printModeToSessionUpdates', () => {
  test('text maps to agent_message_chunk with messageId = ctx.runId', () => {
    const updates = printModeToSessionUpdates(
      { type: 'text', text: 'hello world' },
      makeCtx(),
    )
    expect(updates).toEqual([
      {
        sessionUpdate: 'agent_message_chunk',
        messageId: 'run-1',
        content: { type: 'text', text: 'hello world' },
      },
    ])
  })

  test('subagent text is dropped in acp mode and carries _meta.agentId in full mode', () => {
    // The real `text` variant carries `agentId` only (no parentAgentId), so
    // only agentId appears in _meta.
    const event: PrintModeEvent = {
      type: 'text',
      text: 'child text',
      agentId: 'agent-2',
    }
    expect(printModeToSessionUpdates(event, makeCtx())).toEqual([])
    expect(
      printModeToSessionUpdates(event, makeCtx({ eventsMode: 'full' })),
    ).toEqual([
      {
        sessionUpdate: 'agent_message_chunk',
        messageId: 'run-1',
        content: { type: 'text', text: 'child text' },
        _meta: { 'openbuff.dev': { agentId: 'agent-2' } },
      },
    ])
  })

  test('reasoning_delta maps root-only in acp mode and everywhere in full mode', () => {
    const root: PrintModeEvent = {
      type: 'reasoning_delta',
      text: 'thinking',
      ancestorRunIds: [],
      runId: 'r1',
    }
    expect(printModeToSessionUpdates(root, makeCtx())).toEqual([
      {
        sessionUpdate: 'agent_thought_chunk',
        messageId: 'run-1',
        content: { type: 'text', text: 'thinking' },
      },
    ])

    const nested: PrintModeEvent = {
      type: 'reasoning_delta',
      text: 'child thinking',
      ancestorRunIds: ['r1'],
      runId: 'r2',
    }
    expect(printModeToSessionUpdates(nested, makeCtx())).toEqual([])
    expect(
      printModeToSessionUpdates(nested, makeCtx({ eventsMode: 'full' })),
    ).toEqual([
      {
        sessionUpdate: 'agent_thought_chunk',
        messageId: 'run-1',
        content: { type: 'text', text: 'child thinking' },
      },
    ])
  })

  test('tool_call maps kind via ctx.toolKind and makes path params absolute', () => {
    const updates = printModeToSessionUpdates(
      {
        type: 'tool_call',
        toolCallId: 't1',
        toolName: 'write_file',
        input: { path: 'src/a.ts', content: 'x' },
      },
      makeCtx(),
    )
    expect(updates).toEqual([
      {
        sessionUpdate: 'tool_call',
        toolCallId: 't1',
        title: 'write_file',
        kind: 'edit',
        status: 'pending',
        locations: [{ path: '/proj/src/a.ts' }],
      },
    ])
  })

  test('tool_call without path params omits locations', () => {
    const updates = printModeToSessionUpdates(
      {
        type: 'tool_call',
        toolCallId: 't2',
        toolName: 'code_search',
        input: { query: 'x' },
      },
      makeCtx(),
    )
    expect(updates).toEqual([
      {
        sessionUpdate: 'tool_call',
        toolCallId: 't2',
        title: 'code_search',
        kind: 'other',
        status: 'pending',
      },
    ])
  })

  test('tool_start maps to tool_call_update in_progress', () => {
    expect(
      printModeToSessionUpdates(
        { type: 'tool_start', toolCallId: 't1' },
        makeCtx(),
      ),
    ).toEqual([
      {
        sessionUpdate: 'tool_call_update',
        toolCallId: 't1',
        status: 'in_progress',
      },
    ])
  })

  test('tool_result maps to completed with json content and never rawOutput', () => {
    const updates = printModeToSessionUpdates(
      {
        type: 'tool_result',
        toolCallId: 't1',
        toolName: 'read_files',
        output: [{ type: 'json', value: { files: ['a.ts'] } }],
      },
      makeCtx(),
    )
    expect(updates).toEqual([
      {
        sessionUpdate: 'tool_call_update',
        toolCallId: 't1',
        status: 'completed',
        content: [{ type: 'text', text: '{"files":["a.ts"]}' }],
      },
    ])
  })

  test('media-only tool_result output emits no content and never rawOutput', () => {
    const updates = printModeToSessionUpdates(
      {
        type: 'tool_result',
        toolCallId: 't3',
        toolName: 'read_image',
        output: [{ type: 'media', data: 'AAAA', mediaType: 'image/png' }],
      },
      makeCtx(),
    )
    expect(updates).toEqual([
      {
        sessionUpdate: 'tool_call_update',
        toolCallId: 't3',
        status: 'completed',
      },
    ])
  })

  test('tool_result with an errorMessage in its output maps to failed', () => {
    const updates = printModeToSessionUpdates(
      {
        type: 'tool_result',
        toolCallId: 't1',
        toolName: 'run_terminal_command',
        output: [{ type: 'json', value: { errorMessage: 'boom' } }],
      },
      makeCtx(),
    )
    expect(updates).toEqual([
      {
        sessionUpdate: 'tool_call_update',
        toolCallId: 't1',
        status: 'failed',
        content: [{ type: 'text', text: '{"errorMessage":"boom"}' }],
      },
    ])
  })

  test('a mutation outcome outside applied maps tool_result to failed', () => {
    const updates = printModeToSessionUpdates(
      {
        type: 'tool_result',
        toolCallId: 't1',
        toolName: 'edit_transaction',
        output: [
          {
            type: 'json',
            value: {
              kind: 'file_mutation_result',
              outcome: 'partial',
              actions: [],
            },
          },
        ],
      },
      makeCtx(),
    )
    expect(updates).toHaveLength(1)
    expect(updates[0]).toMatchObject({
      sessionUpdate: 'tool_call_update',
      toolCallId: 't1',
      status: 'failed',
    })
  })

  test('an applied mutation with afterContent adds diff content blocks', () => {
    const mutationValue = {
      kind: 'file_mutation_result',
      outcome: 'applied',
      actions: [
        { outcome: 'applied', path: 'src/a.ts', afterContent: 'new text' },
      ],
    }
    const updates = printModeToSessionUpdates(
      {
        type: 'tool_result',
        toolCallId: 't1',
        toolName: 'write_file',
        output: [{ type: 'json', value: mutationValue }],
      },
      makeCtx(),
    )
    expect(updates).toEqual([
      {
        sessionUpdate: 'tool_call_update',
        toolCallId: 't1',
        status: 'completed',
        content: [
          { type: 'text', text: JSON.stringify(mutationValue) },
          { type: 'diff', path: 'src/a.ts', newText: 'new text' },
        ],
      },
    ])
  })

  test('oversized tool_result content is capped with a truncation marker', () => {
    const updates = printModeToSessionUpdates(
      {
        type: 'tool_result',
        toolCallId: 't1',
        toolName: 'read_files',
        output: [
          { type: 'json', value: { blob: 'x'.repeat(80 * 1024) } },
        ],
      },
      makeCtx(),
    )
    expect(updates).toHaveLength(1)
    const payload = updates[0] as {
      content?: Array<{ type: string; text: string }>
    }
    const text = payload.content?.[0]?.text ?? ''
    expect(text.endsWith('\n[truncated]')).toBe(true)
    expect(new TextEncoder().encode(text).byteLength).toBeLessThanOrEqual(
      64 * 1024 + Buffer.byteLength('\n[truncated]') + 2,
    )
  })

  test('write_todos result maps to plan entries with the first incomplete in_progress', () => {
    const updates = printModeToSessionUpdates(
      {
        type: 'tool_result',
        toolCallId: 't5',
        toolName: 'write_todos',
        output: [
          {
            type: 'json',
            value: {
              currentTodos: [
                { task: 'done task', completed: true },
                { task: 'active task', completed: false },
                { task: 'later task', completed: false },
              ],
            },
          },
        ],
      },
      makeCtx(),
    )
    expect(updates).toEqual([
      {
        sessionUpdate: 'plan',
        entries: [
          { content: 'done task', priority: 'medium', status: 'completed' },
          { content: 'active task', priority: 'medium', status: 'in_progress' },
          { content: 'later task', priority: 'medium', status: 'pending' },
        ],
      },
    ])
  })

  test('a fully completed todo list yields no in_progress entry', () => {
    const updates = printModeToSessionUpdates(
      {
        type: 'tool_result',
        toolCallId: 't5',
        toolName: 'write_todos',
        output: [
          {
            type: 'json',
            value: { currentTodos: [{ task: 'only', completed: true }] },
          },
        ],
      },
      makeCtx(),
    )
    expect(updates).toEqual([
      {
        sessionUpdate: 'plan',
        entries: [{ content: 'only', priority: 'medium', status: 'completed' }],
      },
    ])
  })

  test('subagent_start/finish map onto the parent spawn toolCallId with _meta.agent', () => {
    const start: PrintModeEvent = {
      type: 'subagent_start',
      agentId: 'agent-2',
      agentType: 'reviewer',
      displayName: 'Reviewer',
      onlyChild: false,
      spawnToolCallId: 'spawn-1',
    }
    const agentMeta = {
      'openbuff.dev': {
        agent: {
          agentId: 'agent-2',
          agentType: 'reviewer',
          displayName: 'Reviewer',
        },
      },
    }
    expect(printModeToSessionUpdates(start, makeCtx())).toEqual([
      {
        sessionUpdate: 'tool_call',
        toolCallId: 'spawn-1',
        title: 'Reviewer',
        kind: 'other',
        status: 'pending',
        _meta: agentMeta,
      },
    ])

    const finish: PrintModeEvent = {
      type: 'subagent_finish',
      agentId: 'agent-2',
      agentType: 'reviewer',
      displayName: 'Reviewer',
      onlyChild: false,
      spawnToolCallId: 'spawn-1',
    }
    expect(printModeToSessionUpdates(finish, makeCtx())).toEqual([
      {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'spawn-1',
        status: 'completed',
        _meta: agentMeta,
      },
    ])

    const failedFinish: PrintModeEvent = { ...finish, error: 'blew up' }
    expect(printModeToSessionUpdates(failedFinish, makeCtx())).toEqual([
      {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'spawn-1',
        status: 'failed',
        _meta: agentMeta,
      },
    ])
  })

  test('subagent events without a spawn toolCallId emit nothing', () => {
    const event: PrintModeEvent = {
      type: 'subagent_start',
      agentId: 'agent-2',
      agentType: 'reviewer',
      displayName: 'Reviewer',
      onlyChild: true,
    }
    expect(
      printModeToSessionUpdates(event, makeCtx({ eventsMode: 'full' })),
    ).toEqual([])
  })

  test('context_window maps used/size and finish maps cost only', () => {
    expect(
      printModeToSessionUpdates(
        { type: 'context_window', used: 100, max: 200 },
        makeCtx(),
      ),
    ).toEqual([{ sessionUpdate: 'usage_update', used: 100, size: 200 }])
    expect(
      printModeToSessionUpdates(
        { type: 'finish', totalCost: 0.25 },
        makeCtx(),
      ),
    ).toEqual([
      {
        sessionUpdate: 'usage_update',
        cost: { amount: 0.25, currency: 'USD' },
      },
    ])
  })

  test('autoRecovering errors are not emitted; terminal errors map via printModeErrorToRpcError', () => {
    const autoRecovering: PrintModeEvent = {
      type: 'error',
      message: 'detailed retry context',
      autoRecovering: true,
    }
    expect(printModeToSessionUpdates(autoRecovering, makeCtx())).toEqual([])

    const terminal: PrintModeEvent = {
      type: 'error',
      message: 'detailed failure',
      userMessage: 'calm summary',
    }
    expect(printModeToSessionUpdates(terminal, makeCtx())).toEqual([])
    expect(printModeErrorToRpcError(terminal)).toEqual({
      code: -32603,
      data: { 'openbuff.dev': { message: 'calm summary' } },
    })
    expect(
      printModeErrorToRpcError({ type: 'error', message: 'detailed failure' }),
    ).toEqual({
      code: -32603,
      data: { 'openbuff.dev': { message: 'detailed failure' } },
    })
  })

  test('telemetry variants emit the _openbuff.dev/event ext notification only in full mode', () => {
    const events: PrintModeEvent[] = [
      {
        type: 'job_update',
        jobId: 'j1',
        kind: 'process',
        state: 'running',
        sequence: 0,
      },
      { type: 'provider_status', status: 'retrying' },
      { type: 'phase', phase: 'planning' },
      {
        type: 'context_request_trim',
        messageBudgetTokens: 1000,
        beforeTokens: 2000,
        afterTokens: 1500,
        beforeMessages: 20,
        afterMessages: 15,
      },
      {
        type: 'context_compaction_status',
        state: 'started',
        runId: 'r1',
        ancestorRunIds: [],
      },
      {
        type: 'memory_reuse',
        receipt: {
          schemaVersion: 1,
          turnId: 'turn-1',
          skip: 1,
          narrow: 0,
          full: 0,
          recordsServed: 2,
          gapsRemaining: 0,
          recordedDecisions: 1,
          conceptExpanded: 0,
        },
      },
      { type: 'download', version: '1.2.3', status: 'complete' },
    ]
    for (const event of events) {
      expect(printModeToSessionUpdates(event, makeCtx())).toEqual([])
      expect(
        printModeToSessionUpdates(event, makeCtx({ eventsMode: 'full' })),
      ).toEqual([
        { method: '_openbuff.dev/event', params: { sessionId: 's1', event } },
      ])
    }
  })

  test('GV-16: an internal tool_result emits nothing even with events=full', () => {
    const event: PrintModeEvent = {
      type: 'tool_result',
      toolCallId: 't9',
      toolName: 'read_files',
      output: [],
      parentAgentId: 'agent-1',
    }
    expect(
      printModeToSessionUpdates(event, makeCtx({ eventsMode: 'full' })),
    ).toEqual([])
  })

  test("the unmapped 'start' variant emits nothing", () => {
    expect(
      printModeToSessionUpdates(
        { type: 'start', messageHistoryLength: 3 },
        makeCtx(),
      ),
    ).toEqual([])
  })

  test('an unknown variant throws UnhandledPrintModeVariantError naming it', () => {
    const event = { type: 'mystery' } as unknown as PrintModeEvent
    expect(() => printModeToSessionUpdates(event, makeCtx())).toThrow(
      UnhandledPrintModeVariantError,
    )
    expect(() => printModeToSessionUpdates(event, makeCtx())).toThrow(
      /'mystery'/,
    )
  })
})
