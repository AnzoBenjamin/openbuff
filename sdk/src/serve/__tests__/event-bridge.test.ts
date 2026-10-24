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
        // NEW-6: rawInput rides every tool card; src/a.ts is not a sensitive
        // path, so the content-bearing field passes through unredacted.
        rawInput: { content: 'x', path: 'src/a.ts' },
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
        // NEW-6: rawInput rides every tool card.
        rawInput: { query: 'x' },
      },
    ])
  })

  test('NEW-3: tool_call rawInput redacts configured credential values', () => {
    const secret = 'sk-live-credential-value-9876543210'
    const updates = printModeToSessionUpdates(
      {
        type: 'tool_call',
        toolCallId: 't3',
        toolName: 'run_terminal_command',
        input: {
          command: `curl -H "Authorization: Bearer ${secret}" https://example.com`,
        },
      },
      makeCtx({ credentialValues: [secret] }),
    )
    const rawInput = (updates[0] as { rawInput: Record<string, unknown> })
      .rawInput
    expect(rawInput.command).toBe(
      'curl -H "Authorization: Bearer [REDACTED_SECRET]" https://example.com',
    )
    expect(JSON.stringify(rawInput)).not.toContain(secret)
  })

  test('NEW-3: credential redaction reaches nested rawInput fields', () => {
    const secret = 'sk-deep-credential-value-42'
    const updates = printModeToSessionUpdates(
      {
        type: 'tool_call',
        toolCallId: 't4',
        toolName: 'edit_transaction',
        input: {
          path: 'src/config.ts',
          edits: [{ oldString: `const key = '${secret}'`, newString: 'x' }],
        },
      },
      makeCtx({ credentialValues: [secret] }),
    )
    const rawInput = (updates[0] as { rawInput: Record<string, unknown> })
      .rawInput
    const edits = rawInput.edits as Array<Record<string, unknown>>
    expect(edits[0]!.oldString).toBe("const key = '[REDACTED_SECRET]'")
  })

  test('NEW-3 composes with NEW-6: non-content fields of a sensitive-path card still redact credentials', () => {
    const secret = 'sk-compose-credential-value-777'
    const updates = printModeToSessionUpdates(
      {
        type: 'tool_call',
        toolCallId: 't5',
        toolName: 'write_file',
        input: {
          path: '.env',
          content: `TOKEN=${secret}`,
          note: `rotate ${secret} soon`,
        },
      },
      makeCtx({ credentialValues: [secret] }),
    )
    const rawInput = (updates[0] as { rawInput: Record<string, unknown> })
      .rawInput
    // NEW-6: content-bearing fields of a sensitive path become [sensitive].
    expect(rawInput.content).toBe('[sensitive]')
    // NEW-3: every other string field still has the credential value replaced.
    expect(rawInput.note).toBe('rotate [REDACTED_SECRET] soon')
  })

  test('NEW-6: a sensitive-path replace_range tool_call redacts the top-level newContent field', () => {
    const updates = printModeToSessionUpdates(
      {
        type: 'tool_call',
        toolCallId: 't-env',
        toolName: 'replace_range',
        input: {
          path: '.env',
          newContent: 'OPENROUTER_API_KEY=sk-live-abc123\n',
          oldString: 'OPENROUTER_API_KEY=sk-live-old\n',
        },
      },
      makeCtx(),
    )
    expect(updates).toEqual([
      {
        sessionUpdate: 'tool_call',
        toolCallId: 't-env',
        title: 'replace_range',
        kind: 'other',
        status: 'pending',
        locations: [{ path: '/proj/.env' }],
        // NEW-6/GV-25: `newContent` is a content-bearing rawInput field, so a
        // card touching a sensitive path must never leak the replacement text.
        rawInput: {
          path: '.env',
          newContent: '[sensitive]',
          oldString: '[sensitive]',
        },
      },
    ])
  })

  test('NEW-6: a non-sensitive-path replace_range keeps newContent unredacted', () => {
    const updates = printModeToSessionUpdates(
      {
        type: 'tool_call',
        toolCallId: 't-src',
        toolName: 'replace_range',
        input: {
          path: 'src/a.ts',
          newContent: 'export const answer = 42\n',
          oldString: 'export const answer = 41\n',
        },
      },
      makeCtx(),
    )
    expect(updates).toEqual([
      {
        sessionUpdate: 'tool_call',
        toolCallId: 't-src',
        title: 'replace_range',
        kind: 'other',
        status: 'pending',
        locations: [{ path: '/proj/src/a.ts' }],
        rawInput: {
          path: 'src/a.ts',
          newContent: 'export const answer = 42\n',
          oldString: 'export const answer = 41\n',
        },
      },
    ])
  })

  test('NEW-6: a sensitive-path edit_transaction redacts nested structured-edit operation text', () => {
    const updates = printModeToSessionUpdates(
      {
        type: 'tool_call',
        toolCallId: 't-structured',
        toolName: 'edit_transaction',
        input: {
          path: '.env',
          edits: [
            {
              id: 'insert-secret',
              type: 'structured',
              path: '.env',
              operation: {
                kind: 'insert_text',
                position: { line: 1, column: 1 },
                text: 'OPENROUTER_API_KEY=sk-live-secret',
              },
            },
            {
              id: 'add-import',
              type: 'structured',
              path: '.env',
              operation: {
                kind: 'insert_import',
                importStatement: 'import { apiKey } from "./secrets"',
              },
            },
          ],
        },
      },
      makeCtx(),
    )
    expect(updates).toEqual([
      {
        sessionUpdate: 'tool_call',
        toolCallId: 't-structured',
        title: 'edit_transaction',
        kind: 'other',
        status: 'pending',
        locations: [{ path: '/proj/.env' }],
        // NEW-6/GV-25: the nested content positions of structured edits
        // (`operation.text` / `operation.importStatement`) are file content a
        // flat field list cannot see, so the element rule is deep: every
        // string at every depth inside an edit element is redacted while
        // numeric/structural fields (position) survive.
        rawInput: {
          path: '.env',
          edits: [
            {
              id: '[sensitive]',
              type: '[sensitive]',
              path: '[sensitive]',
              operation: {
                kind: '[sensitive]',
                position: { line: 1, column: 1 },
                text: '[sensitive]',
              },
            },
            {
              id: '[sensitive]',
              type: '[sensitive]',
              path: '[sensitive]',
              operation: {
                kind: '[sensitive]',
                importStatement: '[sensitive]',
              },
            },
          ],
        },
      },
    ])
  })

  test('NEW-6: a sensitive-path edit_transaction redacts occurrence-targeted replace_range edits', () => {
    const updates = printModeToSessionUpdates(
      {
        type: 'tool_call',
        toolCallId: 't-occurrence',
        toolName: 'edit_transaction',
        input: {
          path: 'secrets.keys',
          edits: [
            {
              type: 'replace_range',
              path: 'secrets.keys',
              readCapability: 'cap.v3.1.436.AAAA.BBBB',
              occurrence: { match: 'private key material line' },
              newContent: 'replacement private key material',
            },
          ],
        },
      },
      makeCtx(),
    )
    expect(updates).toEqual([
      {
        sessionUpdate: 'tool_call',
        toolCallId: 't-occurrence',
        title: 'edit_transaction',
        kind: 'other',
        status: 'pending',
        locations: [{ path: '/proj/secrets.keys' }],
        // NEW-6/GV-25: `occurrence.match` names the exact file text being
        // replaced, and the edit's readCapability is a cap.v3 token — both
        // must never cross the wire for a sensitive-path card.
        rawInput: {
          path: 'secrets.keys',
          edits: [
            {
              type: '[sensitive]',
              path: '[sensitive]',
              readCapability: '[sensitive]',
              occurrence: { match: '[sensitive]' },
              newContent: '[sensitive]',
            },
          ],
        },
      },
    ])
  })

  test('NEW-6: a non-sensitive-path edit_transaction keeps nested edit content unredacted', () => {
    const input = {
      path: 'src/a.ts',
      edits: [
        {
          type: 'structured',
          path: 'src/a.ts',
          operation: {
            kind: 'insert_text',
            position: { line: 3, column: 1 },
            text: 'export const answer = 42',
          },
        },
      ],
    }
    const updates = printModeToSessionUpdates(
      {
        type: 'tool_call',
        toolCallId: 't-src-structured',
        toolName: 'edit_transaction',
        input,
      },
      makeCtx(),
    )
    expect((updates[0] as { rawInput: unknown }).rawInput).toEqual(input)
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

  test('EV-1: a sensitive-path mutation redacts content fields from the raw-JSON text block', () => {
    const mutationValue = {
      kind: 'file_mutation_result',
      outcome: 'applied',
      actions: [
        {
          outcome: 'applied',
          path: '.env',
          afterContent: 'OPENROUTER_API_KEY=sk-live-echo-secret\n',
          patch: '--- a/.env\n+++ b/.env\n@@ -1 +1 @@\n',
          content: 'raw post-edit content',
          beforeContent: 'raw pre-edit content',
        },
      ],
    }
    const updates = printModeToSessionUpdates(
      {
        type: 'tool_result',
        toolCallId: 't-ev1',
        toolName: 'write_file',
        output: [{ type: 'json', value: mutationValue }],
      },
      makeCtx(),
    )
    const payload = updates[0] as {
      content?: Array<{ type: string; text?: string }>
    }
    const textBlock = payload.content?.find((block) => block.type === 'text')
    expect(typeof textBlock?.text).toBe('string')
    // Each text block line stays JSON.parse-able for downstream consumers.
    const parsed = JSON.parse(textBlock!.text!) as {
      actions: Array<Record<string, unknown>>
    }
    expect(parsed.actions[0]!.path).toBe('.env')
    expect(parsed.actions[0]!.afterContent).toBe('[sensitive]')
    expect(parsed.actions[0]!.patch).toBe('[sensitive]')
    expect(parsed.actions[0]!.content).toBe('[sensitive]')
    expect(parsed.actions[0]!.beforeContent).toBe('[sensitive]')
    expect(textBlock!.text!).not.toContain('sk-live-echo-secret')
    // The separate diff block is still the sensitive placeholder.
    expect(payload.content).toContainEqual({
      type: 'text',
      text: '[sensitive file changed: .env]',
    })
  })

  test('EV-1: non-sensitive actions in a mixed mutation keep their afterContent verbatim', () => {
    const mutationValue = {
      kind: 'file_mutation_result',
      outcome: 'applied',
      actions: [
        {
          outcome: 'applied',
          path: '.env',
          afterContent: 'SECRET_ENV_CONTENT',
        },
        {
          outcome: 'applied',
          path: 'src/a.ts',
          afterContent: 'export const answer = 42',
        },
      ],
    }
    const updates = printModeToSessionUpdates(
      {
        type: 'tool_result',
        toolCallId: 't-ev1b',
        toolName: 'edit_transaction',
        output: [{ type: 'json', value: mutationValue }],
      },
      makeCtx(),
    )
    const payload = updates[0] as {
      content?: Array<{
        type: string
        text?: string
        path?: string
        newText?: string
      }>
    }
    const textBlock = payload.content?.find((block) => block.type === 'text')
    const parsed = JSON.parse(textBlock!.text!) as {
      actions: Array<Record<string, unknown>>
    }
    expect(parsed.actions[0]!.afterContent).toBe('[sensitive]')
    expect(parsed.actions[1]!.afterContent).toBe('export const answer = 42')
    // The non-sensitive action still emits its diff block.
    expect(payload.content).toContainEqual({
      type: 'diff',
      path: 'src/a.ts',
      newText: 'export const answer = 42',
    })
  })

  test('EV-2: credential redaction past the walk depth cap is fail-closed', () => {
    const secret = 'sk-capped-credential-value-31337'
    let deep: unknown = { leaf: `token=${secret}` }
    for (let i = 0; i < 64; i += 1) deep = { nested: deep }
    const updates = printModeToSessionUpdates(
      {
        type: 'tool_call',
        toolCallId: 't-ev2',
        toolName: 'code_search',
        input: { query: 'x', payload: deep },
      },
      makeCtx({ credentialValues: [secret] }),
    )
    const rawInput = (updates[0] as { rawInput: Record<string, unknown> })
      .rawInput
    const serialized = JSON.stringify(rawInput)
    // The capped tail must NOT pass through unredacted.
    expect(serialized).not.toContain(secret)
    expect(serialized).toContain('[REDACTED_SECRET]')
  })

  test('EV-2: subtrees shallower than the walk depth cap keep their structure', () => {
    const secret = 'sk-shallow-credential-value-8'
    let deep: unknown = { leaf: `token=${secret}` }
    for (let i = 0; i < 20; i += 1) deep = { nested: deep }
    const updates = printModeToSessionUpdates(
      {
        type: 'tool_call',
        toolCallId: 't-ev2b',
        toolName: 'code_search',
        input: { query: 'x', payload: deep },
      },
      makeCtx({ credentialValues: [secret] }),
    )
    const rawInput = (updates[0] as { rawInput: Record<string, unknown> })
      .rawInput
    let node = rawInput.payload as Record<string, unknown>
    for (let i = 0; i < 20; i += 1) {
      expect(Array.isArray(node)).toBe(false)
      node = node.nested as Record<string, unknown>
    }
    expect(node.leaf).toBe('token=[REDACTED_SECRET]')
  })

  test('EV-3: pathologically nested sensitive-path rawInput is depth-bounded, not stack-bound', () => {
    const secret = 'sk-deep-sensitive-echo-999'
    let deepElement: Record<string, unknown> = {
      tail: `OPENROUTER_API_KEY=${secret}`,
    }
    for (let i = 0; i < 50_000; i += 1) deepElement = { nested: deepElement }
    const updates = printModeToSessionUpdates(
      {
        type: 'tool_call',
        toolCallId: 't-ev3',
        toolName: 'edit_transaction',
        input: {
          path: '.env',
          edits: [deepElement],
        },
      },
      makeCtx(),
    )
    const rawInput = (updates[0] as { rawInput: Record<string, unknown> })
      .rawInput
    // Walk the nested chain iteratively: the capped tail collapses to the
    // sensitive marker within the depth bound instead of recursing to the
    // 50_000-deep leaf.
    let node: unknown = (rawInput.edits as unknown[])[0]
    let found = false
    for (let i = 0; i <= 50 && !found; i += 1) {
      if (typeof node === 'string') {
        expect(node).toBe('[sensitive]')
        found = true
        break
      }
      node = (node as Record<string, unknown>).nested
    }
    expect(found).toBe(true)
    expect(JSON.stringify(rawInput)).not.toContain('sk-deep-sensitive-echo')
  })
})
