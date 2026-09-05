import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { createMessageUpdater } from '../message-updater'
import {
  createEventHandler,
  createStreamChunkHandler,
} from '../sdk-event-handlers'

import type {
  ChatMessage,
  CompactionContentBlock,
  CompactionNotice,
} from '../../types/chat'
import { CLI_LIVE_SESSION_ID } from '../../types/chat'
import type { EventHandlerState } from '../sdk-event-handlers'
import type { StatusBarContextUsage } from '../status-bar-chips'

import {
  printModeContextRequestTrimSchema,
  printModeEventSchema,
} from '@codebuff/common/types/print-mode'
import type { Logger } from '@codebuff/common/types/contracts/logger'
import type {
  PrintModeContextCompaction,
  PrintModeContextCompactionProgress,
  PrintModeEvent,
  PrintModeJobUpdate,
} from '@codebuff/common/types/print-mode'
// Named through the PUBLISHED entry point rather than the internal common
// module: `dist/index.d.ts` is generated from `sdk/src/index.ts` alone, so this
// is the exact resolution path a consumer of the bundled types takes.
import type { RequestContextTrimInfo } from '@openbuff/sdk'

const createTestContext = () => {
  let messages: ChatMessage[] = [
    {
      id: 'ai-1',
      variant: 'ai',
      content: '',
      blocks: [],
      timestamp: 'now',
    },
  ]
  const updater = createMessageUpdater(
    'ai-1',
    (fn: (msgs: ChatMessage[]) => ChatMessage[]) => {
      messages = fn(messages)
    },
  )

  const loggerCalls: { level: string; message: unknown }[] = []

  const ctx: EventHandlerState = {
    streaming: {
      streamRefs: {
        state: {
          rootStreamBuffer: '',
          agentStreamAccumulators: new Map(),
          rootStreamSeen: false,
          planExtracted: false,
          wasAbortedByUser: false,
          spawnAgentsMap: new Map(),
          phase: null,
        },
        reset: () => {},
        setters: {
          setRootStreamBuffer: () => {},
          appendRootStreamBuffer: () => {},
          setAgentAccumulator: () => {},
          removeAgentAccumulator: () => {},
          setRootStreamSeen: () => {},
          setPlanExtracted: () => {},
          setWasAbortedByUser: () => {},
          setSpawnAgentInfo: () => {},
          removeSpawnAgentInfo: () => {},
          setPhase: () => {},
        },
      },
      setStreamingAgents: () => {},
      setStreamStatus: () => {},
      setContextWindowUsage: () => {},
      setCompactionNotice: () => {},
    },
    message: {
      aiMessageId: 'ai-1',
      updater,
      hasReceivedContentRef: { current: false },
    },
    subagents: {
      addActiveSubagent: () => {},
      removeActiveSubagent: () => {},
    },
    mode: {
      agentMode: 'PLAN',
      setHasReceivedPlanResponse: () => {},
    },
    logger: {
      info: (_obj: unknown, message?: unknown) =>
        loggerCalls.push({ level: 'info', message }),
      warn: (_obj: unknown, message?: unknown) =>
        loggerCalls.push({ level: 'warn', message }),
      error: (_obj: unknown, message?: unknown) =>
        loggerCalls.push({ level: 'error', message }),
      debug: (_obj: unknown, message?: unknown) =>
        loggerCalls.push({ level: 'debug', message }),
    } as Logger,
    setIsRetrying: () => {},
  }

  return {
    ctx,
    getMessages: () => messages,
    getLoggerCalls: () => loggerCalls,
  }
}

// Typed event dispatch helper for the job_update/tool_call/tool_result event
// family (RF-2). Validates the payload against `printModeEventSchema` before
// forwarding, so a payload that stops satisfying the discriminated-union
// contract (schema drift) fails the test loudly instead of passing via an
// `as any` escape hatch. Returns the parser-narrowed `PrintModeEvent`. Only
// events in scope for RF-2 go through this helper; the unknown-state forward-
// compat test (RF-1) intentionally bypasses it, since an unlisted state is by
// definition not a valid `PrintModeJobUpdate`.
const dispatchValidEvent = (
  handle: ReturnType<typeof createEventHandler>,
  payload: unknown,
): PrintModeEvent => {
  const parsed = printModeEventSchema.parse(payload)
  handle(parsed)
  return parsed
}

describe('sdk-event-handlers', () => {
  test('renders provider retry/failover recovery as an ordered resilience timeline', () => {
    const { ctx, getMessages } = createTestContext()
    const retryStates: boolean[] = []
    ctx.setIsRetrying = (retrying) => retryStates.push(retrying)
    const handleEvent = createEventHandler(ctx)

    handleEvent({
      type: 'provider_status',
      status: 'retrying',
      model: 'primary',
      attempt: 2,
      maxAttempts: 4,
      delayMs: 500,
    })
    handleEvent({
      type: 'provider_status',
      status: 'failover',
      model: 'primary',
      nextModel: 'backup',
    })
    handleEvent({
      type: 'provider_status',
      status: 'recovered',
      model: 'backup',
    })

    expect(retryStates).toEqual([true, true, false])
    const text = getMessages()[0]
      .blocks?.map((block) => ('content' in block ? block.content : ''))
      .join('\n')
    expect(text).toContain('retrying (attempt 2/4)')
    expect(text).toContain('primary → backup')
    expect(text).toContain('recovered on backup')
  })

  test('surfaces runtime errors without stack-frame lines', () => {
    const { ctx, getMessages } = createTestContext()
    createEventHandler(ctx)({
      type: 'error',
      message: 'Provider failed\n    at secret/path.ts:1:2',
    })
    expect(getMessages()[0].userError).toBe('Provider failed')
  })

  test('prefers the concise userMessage over the detailed message when present', () => {
    const { ctx, getMessages } = createTestContext()
    createEventHandler(ctx)({
      type: 'error',
      message: 'detailed wall\n    at x.ts:1:2',
      userMessage: 'Calm summary',
    })
    expect(getMessages()[0].userError).toBe('Calm summary')
  })

  test('falls back to the stack-stripped message when userMessage is whitespace-only', () => {
    const { ctx, getMessages } = createTestContext()
    createEventHandler(ctx)({
      type: 'error',
      message: 'Provider failed\n    at secret/path.ts:1:2',
      userMessage: '   ',
    })
    expect(getMessages()[0].userError).toBe('Provider failed')
  })

  test('does not render an error banner for auto-recovering errors', () => {
    const { ctx, getMessages } = createTestContext()
    createEventHandler(ctx)({
      type: 'error',
      message: 'malformed tool call detail\n    at x.ts:1:2',
      userMessage: 'The model is correcting it automatically.',
      autoRecovering: true,
    })
    expect(getMessages()[0].userError).toBeUndefined()
  })

  test('does not render an error banner for suggest_followups ordering rejections', () => {
    const { ctx, getMessages } = createTestContext()
    createEventHandler(ctx)({
      type: 'error',
      message:
        'Tool `suggest_followups` is not available yet. GATE: PENDING (or final summary not written).',
      userMessage:
        'The model called suggest_followups out of order and is correcting the ordering automatically. No action is needed.',
      autoRecovering: true,
    })
    expect(getMessages()[0].userError).toBeUndefined()
  })

  test('logs auto-recovering runtime errors at debug rather than error', () => {
    const { ctx, getLoggerCalls } = createTestContext()
    createEventHandler(ctx)({
      type: 'error',
      message:
        'Tool `suggest_followups` is not available yet. GATE: PENDING (or final summary not written).',
      userMessage:
        'The model called suggest_followups out of order and is correcting the ordering automatically. No action is needed.',
      autoRecovering: true,
    })
    const calls = getLoggerCalls()
    expect(calls).toContainEqual({
      level: 'debug',
      message: 'SDK auto-recovering runtime notice',
    })
    expect(calls.some((call) => call.level === 'error')).toBe(false)
  })

  test('logs genuine runtime errors at error level', () => {
    const { ctx, getLoggerCalls } = createTestContext()
    createEventHandler(ctx)({
      type: 'error',
      message: 'Provider failed\n    at secret/path.ts:1:2',
    })
    const calls = getLoggerCalls()
    expect(calls).toContainEqual({
      level: 'error',
      message: 'SDK runtime error event',
    })
    expect(calls.some((call) => call.level === 'debug')).toBe(false)
  })

  test('background agent cards remain running until polling reports settlement', () => {
    const { ctx, getMessages } = createTestContext()
    const handleEvent = createEventHandler(ctx)
    dispatchValidEvent(handleEvent, {
      type: 'subagent_start',
      agentId: 'child-1',
      agentType: 'researcher-web',
      displayName: 'Researcher',
      parentAgentId: 'main-agent',
      spawnToolCallId: 'spawn-bg',
      spawnIndex: 0,
      prompt: 'research',
      onlyChild: true,
    })
    dispatchValidEvent(handleEvent, {
      type: 'tool_result',
      toolCallId: 'spawn-bg',
      toolName: 'spawn_agents',
      output: [
        {
          type: 'json',
          value: [
            {
              agentId: 'child-1',
              agentName: 'Researcher',
              agentType: 'researcher-web',
              value: {
                background: true,
                jobId: 'bg-agent-1',
                message: 'launched',
              },
            },
          ],
        },
      ],
    })
    expect(getMessages()[0].blocks?.[0]).toMatchObject({
      type: 'agent',
      status: 'running',
      backgroundJobId: 'bg-agent-1',
    })

    dispatchValidEvent(handleEvent, {
      type: 'tool_result',
      toolCallId: 'check-bg',
      toolName: 'check_background_agent',
      output: [
        {
          type: 'json',
          value: {
            jobId: 'bg-agent-1',
            status: 'completed',
            newChunks: [],
            result: {
              type: 'lastMessage',
              value: [
                {
                  role: 'assistant',
                  content: [{ type: 'text', text: 'done' }],
                },
              ],
            },
          },
        },
      ],
    })
    expect(getMessages()[0].blocks?.[0]).toMatchObject({
      type: 'agent',
      status: 'complete',
      backgroundJobId: 'bg-agent-1',
    })
  })

  test('[ERR-H01] terminal cancellation is immutable when a late result arrives', () => {
    const { ctx, getMessages } = createTestContext()
    const handleEvent = createEventHandler(ctx)
    dispatchValidEvent(handleEvent, {
      type: 'tool_call',
      toolCallId: 'tool-1',
      toolName: 'read_files',
      input: { paths: ['a.ts'] },
    })
    ctx.message.updater.updateAiMessageBlocks((blocks) =>
      blocks.map((block) =>
        block.type === 'tool'
          ? { ...block, lifecycle: 'cancelled' as const }
          : block,
      ),
    )
    dispatchValidEvent(handleEvent, {
      type: 'tool_result',
      toolCallId: 'tool-1',
      toolName: 'read_files',
      output: [{ type: 'json', value: { ok: true } }],
    })
    expect(getMessages()[0].blocks?.[0]).toMatchObject({
      type: 'tool',
      lifecycle: 'cancelled',
    })
  })

  test('[COR-H03] any error part makes the terminal tool lifecycle failed', () => {
    const { ctx, getMessages } = createTestContext()
    const handleEvent = createEventHandler(ctx)
    dispatchValidEvent(handleEvent, {
      type: 'tool_call',
      toolCallId: 'tool-2',
      toolName: 'write_file',
      input: {},
    })
    dispatchValidEvent(handleEvent, {
      type: 'tool_result',
      toolCallId: 'tool-2',
      toolName: 'write_file',
      output: [
        { type: 'json', value: { applied: true } },
        { type: 'json', value: { errorMessage: 'post-commit report failed' } },
      ],
    })
    expect(getMessages()[0].blocks?.[0]).toMatchObject({ lifecycle: 'failed' })
  })

  test('late canonical mutation result replaces cancellation with authoritative state', () => {
    const { ctx, getMessages } = createTestContext()
    const handleEvent = createEventHandler(ctx)
    dispatchValidEvent(handleEvent, {
      type: 'tool_call',
      toolCallId: 'tool-late',
      toolName: 'write_file',
      input: { path: 'a.ts' },
    })
    ctx.message.updater.updateAiMessageBlocks((blocks) =>
      blocks.map((block) =>
        block.type === 'tool'
          ? { ...block, lifecycle: 'cancelled' as const }
          : block,
      ),
    )
    dispatchValidEvent(handleEvent, {
      type: 'tool_result',
      toolCallId: 'tool-late',
      toolName: 'write_file',
      output: [
        {
          type: 'json',
          value: {
            kind: 'file_mutation_result',
            version: 1,
            operationId: 'op',
            outcome: 'applied',
            authorityTier: 'portable_path',
            actions: [
              {
                actionId: 'a',
                index: 0,
                action: 'create',
                path: 'a.ts',
                outcome: 'applied',
                beforeHash: null,
                afterHash: 'sha256:x',
              },
            ],
            errors: [],
            freshCapabilities: [],
          },
        },
      ],
    })
    expect(getMessages()[0].blocks?.[0]).toMatchObject({
      lifecycle: 'succeeded',
      interrupted: true,
    })
  })

  test('spawn_agents tool_result with agentReceipt.status partial marks agent block partial', () => {
    const { ctx, getMessages } = createTestContext()
    const handleEvent = createEventHandler(ctx)
    dispatchValidEvent(handleEvent, {
      type: 'subagent_start',
      agentId: 'general-1',
      agentType: 'general-agent',
      displayName: 'General',
      parentAgentId: 'main-agent',
      spawnToolCallId: 'spawn-partial',
      spawnIndex: 0,
      prompt: 'do work',
      onlyChild: true,
    })

    // subagent_finish without error currently marks complete; receipt must be able to
    // downgrade complete → partial when spawn_agents tool_result arrives.
    handleEvent({
      type: 'subagent_finish',
      agentId: 'general-1',
      agentType: 'general-agent',
      displayName: 'General',
      onlyChild: true,
    } as any)
    expect(getMessages()[0].blocks?.[0]).toMatchObject({
      type: 'agent',
      status: 'complete',
    })

    dispatchValidEvent(handleEvent, {
      type: 'tool_result',
      toolCallId: 'spawn-partial',
      toolName: 'spawn_agents',
      output: [
        {
          type: 'json',
          value: [
            {
              agentId: 'general-1',
              agentName: 'General',
              agentType: 'general-agent',
              value: {
                type: 'lastMessage',
                value: [
                  {
                    role: 'assistant',
                    content: [{ type: 'text', text: 'partial work done' }],
                  },
                ],
              },
              agentReceipt: {
                status: 'partial',
                errors: [
                  {
                    message: 'ended without calling task_completed',
                    retryable: true,
                  },
                ],
              },
            },
          ],
        },
      ],
    })

    const agentBlock = getMessages()[0].blocks?.[0] as any
    expect(agentBlock).toMatchObject({
      type: 'agent',
      agentId: 'general-1',
      status: 'partial',
    })
    const textContents = (agentBlock.blocks ?? [])
      .filter((b: any) => b.type === 'text')
      .map((b: any) => b.content)
      .join('\n')
    expect(textContents).toContain('ended without calling task_completed')
  })

  test('spawn_agents agentReceipt-only partial still updates status without value content', () => {
    const { ctx, getMessages } = createTestContext()
    const handleEvent = createEventHandler(ctx)
    dispatchValidEvent(handleEvent, {
      type: 'subagent_start',
      agentId: 'general-2',
      agentType: 'general-agent',
      displayName: 'General',
      spawnToolCallId: 'spawn-receipt-only',
      spawnIndex: 0,
      prompt: 'do work',
      onlyChild: true,
    })

    dispatchValidEvent(handleEvent, {
      type: 'tool_result',
      toolCallId: 'spawn-receipt-only',
      toolName: 'spawn_agents',
      output: [
        {
          type: 'json',
          value: [
            {
              agentId: 'general-2',
              agentName: 'General',
              agentType: 'general-agent',
              agentReceipt: {
                status: 'partial',
                errors: [
                  {
                    message: 'ended without calling task_completed',
                    retryable: true,
                  },
                ],
              },
            },
          ],
        },
      ],
    })

    expect(getMessages()[0].blocks?.[0]).toMatchObject({
      type: 'agent',
      agentId: 'general-2',
      status: 'partial',
    })
  })

  test('[ERR-H01] subagent error finishes persist failed status', () => {
    const { ctx, getMessages } = createTestContext()
    let streaming = new Set<string>()
    ctx.streaming.setStreamingAgents = (updater) => {
      streaming = updater(streaming)
    }
    const handleEvent = createEventHandler(ctx)
    handleEvent({
      type: 'subagent_start',
      agentId: 'agent-1',
      agentType: 'editor',
      displayName: 'Editor',
      onlyChild: false,
    } as any)
    dispatchValidEvent(handleEvent, {
      type: 'tool_call',
      toolCallId: 'nested-tool-1',
      toolName: 'edit_transaction',
      input: { edits: [] },
      agentId: 'agent-1',
      parentAgentId: 'agent-1',
    })
    expect(streaming.has('nested-tool-1')).toBe(true)
    handleEvent({
      type: 'subagent_finish',
      agentId: 'agent-1',
      agentType: 'editor',
      displayName: 'Editor',
      onlyChild: false,
      error: 'timed out',
    } as any)
    expect(getMessages()[0].blocks?.[0]).toMatchObject({ status: 'failed' })
    expect((getMessages()[0].blocks?.[0] as any).blocks?.[0]).toMatchObject({
      type: 'tool',
      lifecycle: 'failed',
    })
    expect(streaming.has('agent-1')).toBe(false)
    expect(streaming.has('nested-tool-1')).toBe(false)
  })

  test('root finish settles orphaned foreground agent cards', () => {
    const { ctx, getMessages } = createTestContext()
    const handleEvent = createEventHandler(ctx)
    handleEvent({
      type: 'subagent_start',
      agentId: 'orphan-editor',
      agentType: 'editor',
      displayName: 'Editor',
      onlyChild: true,
    } as any)

    expect(getMessages()[0].blocks?.[0]).toMatchObject({ status: 'running' })

    handleEvent({ type: 'finish', totalCost: 0 } as any)

    expect(getMessages()[0].blocks?.[0]).toMatchObject({ status: 'failed' })
  })

  test('root finish fails unresolved foreground tools but preserves live background tools', () => {
    const { ctx, getMessages } = createTestContext()
    const handleEvent = createEventHandler(ctx)
    dispatchValidEvent(handleEvent, {
      type: 'tool_call',
      toolCallId: 'root-running-tool',
      toolName: 'read_files',
      input: { paths: ['a.ts'] },
    })
    handleEvent({
      type: 'subagent_start',
      agentId: 'background-agent',
      agentType: 'researcher-web',
      displayName: 'Researcher',
      onlyChild: false,
    } as any)
    ctx.message.updater.updateAiMessageBlocks((blocks) =>
      blocks.map((block) =>
        block.type === 'agent' && block.agentId === 'background-agent'
          ? {
              ...block,
              backgroundJobId: 'bg-1',
              blocks: [
                {
                  type: 'tool' as const,
                  toolCallId: 'background-running-tool',
                  toolName: 'web_search' as any,
                  input: {},
                  lifecycle: 'running' as const,
                },
              ],
            }
          : block,
      ),
    )

    handleEvent({ type: 'finish', totalCost: 0 } as any)

    const blocks = getMessages()[0].blocks ?? []
    expect(blocks.find((block) => block.type === 'tool')).toMatchObject({
      toolCallId: 'root-running-tool',
      lifecycle: 'failed',
    })
    const background = blocks.find(
      (block) => block.type === 'agent' && block.agentId === 'background-agent',
    ) as any
    expect(background).toMatchObject({
      status: 'running',
      backgroundJobId: 'bg-1',
    })
    expect(background.blocks[0]).toMatchObject({ lifecycle: 'running' })
  })

  test('extracts plan content from root stream', () => {
    const { ctx, getMessages } = createTestContext()
    const handleChunk = createStreamChunkHandler(ctx)

    handleChunk('<PLAN>Build plan</PLAN>')

    const blocks = getMessages()[0].blocks ?? []
    expect(blocks.find((block) => block.type === 'plan')).toMatchObject({
      content: 'Build plan',
    })
  })

  test('handles context_window event by calling setContextWindowUsage', () => {
    const captured: { usage: StatusBarContextUsage | null } = {
      usage: null,
    }
    const { ctx } = createTestContext()
    ctx.streaming.setContextWindowUsage = (usage) => {
      captured.usage = usage
    }
    const handleEvent = createEventHandler(ctx)

    handleEvent({ type: 'context_window', used: 50000, max: 200000 })

    expect(captured.usage).toEqual({ used: 50000, max: 200000 })
  })

  test('forwards the compaction trigger on context_window only when the event supplies it', () => {
    // The canonical status-bar shape rather than a restated structural copy, so
    // this pins the forwarded payload to the type the chip selector consumes.
    const captured: Array<StatusBarContextUsage | null> = []
    const { ctx } = createTestContext()
    ctx.streaming.setContextWindowUsage = (usage) => captured.push(usage)
    const handleEvent = createEventHandler(ctx)

    handleEvent({
      type: 'context_window',
      used: 150_000,
      max: 200_000,
      compactionTriggerTokens: 140_000,
      compactionTargetTokens: 100_000,
    })
    // A persisted/replayed event emitted before the fields existed.
    handleEvent({ type: 'context_window', used: 10_000, max: 200_000 })

    expect(captured[0]).toEqual({
      used: 150_000,
      max: 200_000,
      compactionTriggerTokens: 140_000,
    })
    // The post-compaction target is not user-actionable at a glance, so it is
    // deliberately not forwarded to the chip; it stays on the event for other
    // consumers.
    expect(captured[0]).not.toHaveProperty('compactionTargetTokens')
    // Absent on the event: the key is omitted entirely rather than set to
    // undefined, so older CLI state keeps working unchanged.
    expect(captured[1]).toEqual({ used: 10_000, max: 200_000 })
    expect(Object.keys(captured[1] ?? {})).toEqual(['used', 'max'])
  })

  test('keeps the last context usage after finish', () => {
    const captured: Array<StatusBarContextUsage | null> = []
    const { ctx } = createTestContext()
    ctx.streaming.setContextWindowUsage = (usage) => captured.push(usage)
    const handleEvent = createEventHandler(ctx)

    handleEvent({ type: 'context_window', used: 150000, max: 200000 })
    handleEvent({ type: 'finish', totalCost: 0 } as any)

    expect(captured).toEqual([{ used: 150000, max: 200000 }])
  })

  test('BACKGROUND tool_result wires backgroundJobId so job_update settles without check_job', () => {
    const { ctx, getMessages } = createTestContext()
    const handleEvent = createEventHandler(ctx)
    // Production path: job id is only known after the SDK starts the process,
    // so it arrives on tool_result — not on tool_call. No manual mutation.
    dispatchValidEvent(handleEvent, {
      type: 'tool_call',
      toolCallId: 'term-bg',
      toolName: 'run_terminal_command',
      input: { command: 'npm run dev', process_type: 'BACKGROUND' },
    })

    expect(getMessages()[0].blocks?.[0]).toMatchObject({
      type: 'tool',
      lifecycle: 'running',
    })
    expect(
      (getMessages()[0].blocks?.[0] as any).backgroundJobId,
    ).toBeUndefined()

    dispatchValidEvent(handleEvent, {
      type: 'tool_result',
      toolCallId: 'term-bg',
      toolName: 'run_terminal_command',
      output: [
        {
          type: 'json',
          value: {
            command: 'npm run dev',
            processId: 1234,
            backgroundProcessStatus: 'running',
            jobId: 'job-bg',
            logFile: '/tmp/job-bg.log',
            startingCwd: '/project',
          },
        },
      ],
    })

    // Successful BACKGROUND start keeps the card running (not succeeded).
    expect(getMessages()[0].blocks?.[0]).toMatchObject({
      type: 'tool',
      backgroundJobId: 'job-bg',
      lifecycle: 'running',
    })

    dispatchValidEvent(handleEvent, {
      type: 'job_update',
      jobId: 'job-bg',
      kind: 'process',
      state: 'running',
      sequence: 1,
      outputDelta: 'listening\n',
    })
    dispatchValidEvent(handleEvent, {
      type: 'job_update',
      jobId: 'job-bg',
      kind: 'process',
      state: 'completed',
      sequence: 2,
      exitCode: 0,
    })

    expect(getMessages()[0].blocks?.[0]).toMatchObject({
      type: 'tool',
      backgroundJobId: 'job-bg',
      lifecycle: 'succeeded',
      output: expect.stringContaining('listening\n'),
    })
  })

  test('tool_start flips a queued tool block back to running', () => {
    const { ctx, getMessages } = createTestContext()
    const handleEvent = createEventHandler(ctx)
    // A write queued behind a prior same-path write is emitted with queued:true
    // and lifecycle 'queued'; the runtime later emits tool_start once the
    // per-path barrier resolves, which flips the card to running.
    dispatchValidEvent(handleEvent, {
      type: 'tool_call',
      toolCallId: 'write-queued',
      toolName: 'write_file',
      input: { path: 'src/a.ts' },
      queued: true,
    })

    expect(getMessages()[0].blocks?.[0]).toMatchObject({
      type: 'tool',
      queued: true,
      lifecycle: 'queued',
    })

    dispatchValidEvent(handleEvent, {
      type: 'tool_start',
      toolCallId: 'write-queued',
    })

    expect(getMessages()[0].blocks?.[0]).toMatchObject({
      type: 'tool',
      queued: false,
      lifecycle: 'running',
    })
  })

  test('tool_start flips a queued tool block nested inside an agent block back to running', () => {
    const { ctx, getMessages } = createTestContext()
    const handleEvent = createEventHandler(ctx)
    // Covers the recursive branch of handleToolStart.flipQueued: a queued
    // tool_call that lands INSIDE a nested agent block (parentAgentId set) is
    // only reachable by recursing into the agent's children. The matching
    // tool_start must flip that nested tool back from 'queued' to 'running'
    // without disturbing the sibling/root blocks.
    dispatchValidEvent(handleEvent, {
      type: 'subagent_start',
      agentId: 'parent-agent',
      agentType: 'editor',
      displayName: 'Editor',
      onlyChild: true,
    })
    dispatchValidEvent(handleEvent, {
      type: 'tool_call',
      toolCallId: 'nested-write-queued',
      toolName: 'write_file',
      input: { path: 'src/b.ts' },
      agentId: 'parent-agent',
      parentAgentId: 'parent-agent',
      queued: true,
    })

    // The queued tool is appended inside the agent block, not at the root.
    const agentBlock = getMessages()[0].blocks?.[0] as any
    expect(agentBlock).toMatchObject({ type: 'agent', agentId: 'parent-agent' })
    const nestedTool = agentBlock.blocks?.find(
      (b: any) => b.type === 'tool' && b.toolCallId === 'nested-write-queued',
    )
    expect(nestedTool).toMatchObject({
      type: 'tool',
      queued: true,
      lifecycle: 'queued',
    })

    dispatchValidEvent(handleEvent, {
      type: 'tool_start',
      toolCallId: 'nested-write-queued',
    })

    const settledAgent = getMessages()[0].blocks?.[0] as any
    const settledNested = settledAgent.blocks?.find(
      (b: any) => b.type === 'tool' && b.toolCallId === 'nested-write-queued',
    )
    expect(settledNested).toMatchObject({
      type: 'tool',
      queued: false,
      lifecycle: 'running',
    })
  })

  test('tool_start flips a queued custom/unknown-path tool block back to running', () => {
    const { ctx, getMessages } = createTestContext()
    const handleEvent = createEventHandler(ctx)
    // CLI-side coverage only: the queued→running flip is tool-name agnostic, so
    // a custom/MCP tool name that lands queued must flip from 'queued' to
    // 'running' on tool_start exactly like a native write_file. This does NOT
    // exercise the runtime `queued === true` branch in `executeCustomToolCall`;
    // that branch's reachability is pinned at the runtime level by 'emits
    // tool_start for a custom/MCP tool queued behind an in-flight write (RF-1)'
    // in packages/agent-runtime/src/__tests__/run-agent-step-tools.test.ts.
    dispatchValidEvent(handleEvent, {
      type: 'tool_call',
      toolCallId: 'custom-write-queued',
      toolName: 'mcp_server__custom_write',
      input: { target: 'custom-resource' },
      queued: true,
    })

    expect(getMessages()[0].blocks?.[0]).toMatchObject({
      type: 'tool',
      queued: true,
      lifecycle: 'queued',
    })

    dispatchValidEvent(handleEvent, {
      type: 'tool_start',
      toolCallId: 'custom-write-queued',
    })

    expect(getMessages()[0].blocks?.[0]).toMatchObject({
      type: 'tool',
      queued: false,
      lifecycle: 'running',
    })
  })

  test('job_update updates a correlated tool block lifecycle and appends bounded output', () => {
    const { ctx, getMessages } = createTestContext()
    const handleEvent = createEventHandler(ctx)
    dispatchValidEvent(handleEvent, {
      type: 'tool_call',
      toolCallId: 'term-1',
      toolName: 'run_terminal_command',
      input: { command: 'npm test' },
    })
    // Correlate the run_terminal_command card with a background job id.
    ctx.message.updater.updateAiMessageBlocks((blocks) =>
      blocks.map((block) =>
        block.type === 'tool' && block.toolCallId === 'term-1'
          ? { ...block, backgroundJobId: 'job-1' }
          : block,
      ),
    )

    dispatchValidEvent(handleEvent, {
      type: 'job_update',
      jobId: 'job-1',
      kind: 'process',
      state: 'running',
      sequence: 1,
      outputDelta: 'first line\n',
    })
    dispatchValidEvent(handleEvent, {
      type: 'job_update',
      jobId: 'job-1',
      kind: 'process',
      state: 'running',
      sequence: 2,
      outputDelta: 'second line\n',
    })

    let block = getMessages()[0].blocks?.[0] as any
    expect(block).toMatchObject({
      type: 'tool',
      lifecycle: 'running',
      output: 'first line\nsecond line\n',
    })

    dispatchValidEvent(handleEvent, {
      type: 'job_update',
      jobId: 'job-1',
      kind: 'process',
      state: 'completed',
      sequence: 3,
      exitCode: 0,
    })
    block = getMessages()[0].blocks?.[0] as any
    expect(block).toMatchObject({ lifecycle: 'succeeded' })
  })

  test('job_update caps the accumulated tool output at the tail ceiling', () => {
    const { ctx, getMessages } = createTestContext()
    const handleEvent = createEventHandler(ctx)
    dispatchValidEvent(handleEvent, {
      type: 'tool_call',
      toolCallId: 'term-cap',
      toolName: 'run_terminal_command',
      input: { command: 'noisy' },
    })
    ctx.message.updater.updateAiMessageBlocks((blocks) =>
      blocks.map((block) =>
        block.type === 'tool' && block.toolCallId === 'term-cap'
          ? { ...block, backgroundJobId: 'job-cap' }
          : block,
      ),
    )

    dispatchValidEvent(handleEvent, {
      type: 'job_update',
      jobId: 'job-cap',
      kind: 'process',
      state: 'running',
      sequence: 1,
      outputDelta: 'A'.repeat(60_000),
    })
    dispatchValidEvent(handleEvent, {
      type: 'job_update',
      jobId: 'job-cap',
      kind: 'process',
      state: 'running',
      sequence: 2,
      outputDelta: 'B'.repeat(5_000),
    })

    const block = getMessages()[0].blocks?.[0] as any
    expect(block.output.length).toBe(50_000)
    // The tail (most recent output) is retained.
    expect(block.output.endsWith('B'.repeat(5_000))).toBe(true)
  })

  test('job_update updates a correlated agent block status', () => {
    const { ctx, getMessages } = createTestContext()
    const handleEvent = createEventHandler(ctx)
    dispatchValidEvent(handleEvent, {
      type: 'subagent_start',
      agentId: 'agent-1',
      agentType: 'researcher-web',
      displayName: 'Researcher',
      onlyChild: true,
    })
    ctx.message.updater.updateAiMessageBlocks((blocks) =>
      blocks.map((block) =>
        block.type === 'agent' && block.agentId === 'agent-1'
          ? { ...block, backgroundJobId: 'job-agent' }
          : block,
      ),
    )

    dispatchValidEvent(handleEvent, {
      type: 'job_update',
      jobId: 'job-agent',
      kind: 'agent',
      state: 'completed',
      sequence: 1,
    })

    expect(getMessages()[0].blocks?.[0]).toMatchObject({
      type: 'agent',
      status: 'complete',
      backgroundJobId: 'job-agent',
    })
  })

  test('job_update is a no-op when no block correlates to the jobId', () => {
    const { ctx, getMessages } = createTestContext()
    const handleEvent = createEventHandler(ctx)
    dispatchValidEvent(handleEvent, {
      type: 'tool_call',
      toolCallId: 'term-x',
      toolName: 'run_terminal_command',
      input: { command: 'ls' },
    })
    const before = JSON.stringify(getMessages())

    dispatchValidEvent(handleEvent, {
      type: 'job_update',
      jobId: 'unknown-job',
      kind: 'process',
      state: 'running',
      sequence: 1,
      outputDelta: 'foreign output',
    })

    expect(JSON.stringify(getMessages())).toBe(before)
  })

  test('job_update maps an unknown state to running (fail-safe) instead of throwing', () => {
    // Pins the RF-1 forward-compat contract: the printModeJobUpdateSchema JSDoc
    // says consumers should treat unknown variants as no-ops, and handleJobUpdate
    // runs in the streaming UI render path. A newer runtime emitting an
    // unlisted state must NOT throw and abort the event handler; it should map
    // to the least-surprising non-terminal lifecycle ('running') and log a
    // warning. An unknown state is by definition not a valid PrintModeJobUpdate,
    // so this test bypasses the schema-validating dispatchValidEvent helper and
    // casts only the `state` field (not the whole object) to model the scenario
    // a future runtime would produce before the schema is widened.
    const { ctx, getMessages } = createTestContext()
    const warnCalls: Array<{ jobState?: unknown }> = []
    ctx.logger = {
      info: () => {},
      warn: (fields?: { jobState?: unknown }) => warnCalls.push(fields ?? {}),
      error: () => {},
      debug: () => {},
    } as Logger
    const handleEvent = createEventHandler(ctx)
    dispatchValidEvent(handleEvent, {
      type: 'tool_call',
      toolCallId: 'term-unknown',
      toolName: 'run_terminal_command',
      input: { command: 'some-server' },
    })
    ctx.message.updater.updateAiMessageBlocks((blocks) =>
      blocks.map((block) =>
        block.type === 'tool' && block.toolCallId === 'term-unknown'
          ? { ...block, backgroundJobId: 'job-unknown' }
          : block,
      ),
    )

    expect(() =>
      handleEvent({
        type: 'job_update',
        jobId: 'job-unknown',
        kind: 'process',
        state: 'paused' as PrintModeJobUpdate['state'],
        sequence: 1,
      }),
    ).not.toThrow()

    expect(getMessages()[0].blocks?.[0]).toMatchObject({
      type: 'tool',
      lifecycle: 'running',
    })
    expect(warnCalls.some((c) => c.jobState === 'paused')).toBe(true)
  })

  test('job_update surfaces a failed tool job error in the card output', () => {
    const { ctx, getMessages } = createTestContext()
    const handleEvent = createEventHandler(ctx)
    dispatchValidEvent(handleEvent, {
      type: 'tool_call',
      toolCallId: 'term-err',
      toolName: 'run_terminal_command',
      input: { command: 'boom' },
    })
    ctx.message.updater.updateAiMessageBlocks((blocks) =>
      blocks.map((block) =>
        block.type === 'tool' && block.toolCallId === 'term-err'
          ? { ...block, backgroundJobId: 'job-err' }
          : block,
      ),
    )

    dispatchValidEvent(handleEvent, {
      type: 'job_update',
      jobId: 'job-err',
      kind: 'process',
      state: 'error',
      sequence: 1,
      outputDelta: 'partial output\n',
      error: 'command failed with exit code 1',
    })

    const block = getMessages()[0].blocks?.[0] as any
    expect(block).toMatchObject({ type: 'tool', lifecycle: 'failed' })
    expect(block.output).toContain('partial output')
    expect(block.output).toContain('command failed with exit code 1')
  })

  test('job_update does not duplicate a repeated tool job error in the card output', () => {
    const { ctx, getMessages } = createTestContext()
    const handleEvent = createEventHandler(ctx)
    // Pins the tool-block error dedup that mirrors the agent-block path: an
    // error/lost job_update delivered more than once without new output must
    // not append the same error text repeatedly.
    dispatchValidEvent(handleEvent, {
      type: 'tool_call',
      toolCallId: 'term-err-dup',
      toolName: 'run_terminal_command',
      input: { command: 'npm test' },
      backgroundJobId: 'job-err',
    })

    dispatchValidEvent(handleEvent, {
      type: 'job_update',
      jobId: 'job-err',
      kind: 'process',
      state: 'error',
      sequence: 1,
      error: 'boom',
    })
    dispatchValidEvent(handleEvent, {
      type: 'job_update',
      jobId: 'job-err',
      kind: 'process',
      state: 'error',
      sequence: 2,
      error: 'boom',
    })

    const block = getMessages()[0].blocks?.[0] as any
    expect(block).toMatchObject({ type: 'tool', lifecycle: 'failed' })
    expect((block.output.match(/boom/g) ?? []).length).toBe(1)
  })

  test('job_update still appends an error whose text coincidentally matches trailing streamed output', () => {
    const { ctx, getMessages } = createTestContext()
    const handleEvent = createEventHandler(ctx)
    // Pins the flag-based dedup's advantage over string-suffix matching: when
    // legitimate streamed output happens to end with the exact error text, a
    // genuinely new error append must NOT be suppressed. The explicit
    // jobErrorAppended flag (unset until the first error) distinguishes
    // "already appended this error" from "output coincidentally ends this way".
    dispatchValidEvent(handleEvent, {
      type: 'tool_call',
      toolCallId: 'term-coincidental',
      toolName: 'run_terminal_command',
      input: { command: 'npm test' },
      backgroundJobId: 'job-coincidental',
    })

    // Streamed output that coincidentally ends with the exact error text.
    dispatchValidEvent(handleEvent, {
      type: 'job_update',
      jobId: 'job-coincidental',
      kind: 'process',
      state: 'running',
      sequence: 1,
      outputDelta: 'boom',
    })
    // A genuinely new error carrying the same text; it must still be appended.
    dispatchValidEvent(handleEvent, {
      type: 'job_update',
      jobId: 'job-coincidental',
      kind: 'process',
      state: 'error',
      sequence: 2,
      error: 'boom',
    })

    const block = getMessages()[0].blocks?.[0] as any
    expect(block).toMatchObject({ type: 'tool', lifecycle: 'failed' })
    // Once from the streamed output, once from the appended error.
    expect((block.output.match(/boom/g) ?? []).length).toBe(2)
  })

  test('job_update appends a tool job error wired via tool_result output without duplicating', () => {
    const { ctx, getMessages } = createTestContext()
    const handleEvent = createEventHandler(ctx)
    // Pins error-path parity with the BACKGROUND happy-path test (RF-2): in
    // production the runtime emits tool_call WITHOUT backgroundJobId and the
    // job id arrives only on tool_result via
    // getBackgroundShellJobIdFromToolOutput, then a job_update lands. This
    // mirrors that realistic flow (no manual backgroundJobId mutation) with a
    // coincidental trailing output equal to the error text, so the
    // flag-based dedup still appends a genuinely new error rather than
    // suppressing it as a duplicate.
    dispatchValidEvent(handleEvent, {
      type: 'tool_call',
      toolCallId: 'term-bg-err',
      toolName: 'run_terminal_command',
      input: { command: 'npm test', process_type: 'BACKGROUND' },
    })

    expect(
      (getMessages()[0].blocks?.[0] as any).backgroundJobId,
    ).toBeUndefined()

    // tool_result wires backgroundJobId from the BACKGROUND start output; the
    // card stays running (a successful BACKGROUND start is not terminal).
    dispatchValidEvent(handleEvent, {
      type: 'tool_result',
      toolCallId: 'term-bg-err',
      toolName: 'run_terminal_command',
      output: [
        {
          type: 'json',
          value: {
            command: 'npm test',
            processId: 4321,
            backgroundProcessStatus: 'running',
            jobId: 'job-bg-err',
            logFile: '/tmp/job-bg-err.log',
            startingCwd: '/project',
          },
        },
      ],
    })

    expect(getMessages()[0].blocks?.[0]).toMatchObject({
      type: 'tool',
      backgroundJobId: 'job-bg-err',
      lifecycle: 'running',
    })

    // Live streamed output happens to end with the error text (coincidental).
    dispatchValidEvent(handleEvent, {
      type: 'job_update',
      jobId: 'job-bg-err',
      kind: 'process',
      state: 'running',
      sequence: 1,
      outputDelta: 'boom',
    })
    // A genuinely new error carrying the same text must still be appended.
    dispatchValidEvent(handleEvent, {
      type: 'job_update',
      jobId: 'job-bg-err',
      kind: 'process',
      state: 'error',
      sequence: 2,
      error: 'boom',
    })

    const block = getMessages()[0].blocks?.[0] as any
    expect(block).toMatchObject({ type: 'tool', lifecycle: 'failed' })
    // Once from the streamed output, once from the appended error.
    expect((block.output.match(/boom/g) ?? []).length).toBe(2)
  })

  test('job_update re-appends a tool job error after a running recovery resets the append flag', () => {
    const { ctx, getMessages } = createTestContext()
    const handleEvent = createEventHandler(ctx)
    // Pins RF-3: after an error append sets `jobErrorAppended`, a non-terminal
    // `running` transition must reset the flag so a genuinely new error reported
    // after recovery is still surfaced (rather than permanently suppressed by
    // the first error). The realistic lifecycle is terminal-once for error/lost,
    // but a restart that recovers and then fails again is the documented edge.
    dispatchValidEvent(handleEvent, {
      type: 'tool_call',
      toolCallId: 'term-recover',
      toolName: 'run_terminal_command',
      input: { command: 'flaky-server' },
    })
    ctx.message.updater.updateAiMessageBlocks((blocks) =>
      blocks.map((block) =>
        block.type === 'tool' && block.toolCallId === 'term-recover'
          ? { ...block, backgroundJobId: 'job-recover' }
          : block,
      ),
    )

    // First failure: appends the error and sets jobErrorAppended.
    dispatchValidEvent(handleEvent, {
      type: 'job_update',
      jobId: 'job-recover',
      kind: 'process',
      state: 'error',
      sequence: 1,
      error: 'first failure',
    })
    let block = getMessages()[0].blocks?.[0] as any
    expect(block).toMatchObject({ type: 'tool', lifecycle: 'failed' })
    expect(block.output).toContain('first failure')

    // Recovery back to running (e.g. a restart) resets the append flag.
    dispatchValidEvent(handleEvent, {
      type: 'job_update',
      jobId: 'job-recover',
      kind: 'process',
      state: 'running',
      sequence: 2,
      outputDelta: 'recovered\n',
    })
    block = getMessages()[0].blocks?.[0] as any
    expect(block).toMatchObject({ type: 'tool', lifecycle: 'running' })

    // A new genuine error after recovery must be appended again.
    dispatchValidEvent(handleEvent, {
      type: 'job_update',
      jobId: 'job-recover',
      kind: 'process',
      state: 'error',
      sequence: 3,
      error: 'second failure',
    })
    block = getMessages()[0].blocks?.[0] as any
    expect(block).toMatchObject({ type: 'tool', lifecycle: 'failed' })
    expect(block.output).toContain('recovered')
    expect(block.output).toContain('first failure')
    expect(block.output).toContain('second failure')
    // The second error text is appended exactly once.
    expect((block.output.match(/second failure/g) ?? []).length).toBe(1)
  })

  test('job_update does not clear tool jobErrorAppended on repeated running+error updates', () => {
    const { ctx, getMessages } = createTestContext()
    const handleEvent = createEventHandler(ctx)
    // Pins RF-1: while event.error is present, a running/queued lifecycle must
    // not clear jobErrorAppended. The old ternary fell through to isRecovery
    // after the first append, which reset the flag and re-appended on the next
    // identical running+error event. Agent path never clears while errorText is set.
    dispatchValidEvent(handleEvent, {
      type: 'tool_call',
      toolCallId: 'term-running-err',
      toolName: 'run_terminal_command',
      input: { command: 'flaky-server' },
      backgroundJobId: 'job-running-err',
    })

    dispatchValidEvent(handleEvent, {
      type: 'job_update',
      jobId: 'job-running-err',
      kind: 'process',
      state: 'running',
      sequence: 1,
      error: 'still failing',
    })
    dispatchValidEvent(handleEvent, {
      type: 'job_update',
      jobId: 'job-running-err',
      kind: 'process',
      state: 'running',
      sequence: 2,
      error: 'still failing',
    })
    dispatchValidEvent(handleEvent, {
      type: 'job_update',
      jobId: 'job-running-err',
      kind: 'process',
      state: 'running',
      sequence: 3,
      error: 'still failing',
    })

    const block = getMessages()[0].blocks?.[0] as any
    expect(block).toMatchObject({
      type: 'tool',
      lifecycle: 'running',
      jobErrorAppended: true,
    })
    expect((block.output.match(/still failing/g) ?? []).length).toBe(1)
  })

  test('job_update re-appends an agent job error after a running recovery resets the append flag', () => {
    const { ctx, getMessages } = createTestContext()
    const handleEvent = createEventHandler(ctx)
    // Agent-parity with the tool recovery re-append test (RF-3): error →
    // running resets jobErrorAppended → second error appends once.
    dispatchValidEvent(handleEvent, {
      type: 'subagent_start',
      agentId: 'agent-recover',
      agentType: 'researcher-web',
      displayName: 'Researcher',
      onlyChild: true,
    })
    ctx.message.updater.updateAiMessageBlocks((blocks) =>
      blocks.map((block) =>
        block.type === 'agent' && block.agentId === 'agent-recover'
          ? { ...block, backgroundJobId: 'job-agent-recover' }
          : block,
      ),
    )

    // First failure: appends the error and sets jobErrorAppended.
    dispatchValidEvent(handleEvent, {
      type: 'job_update',
      jobId: 'job-agent-recover',
      kind: 'agent',
      state: 'error',
      sequence: 1,
      error: 'first agent failure',
    })
    let agentBlock = getMessages()[0].blocks?.[0] as any
    expect(agentBlock).toMatchObject({ type: 'agent', status: 'failed' })
    expect(
      (agentBlock.blocks ?? []).filter(
        (b: any) => b.type === 'text' && b.content === 'first agent failure',
      ).length,
    ).toBe(1)

    // Recovery back to running resets the append flag.
    dispatchValidEvent(handleEvent, {
      type: 'job_update',
      jobId: 'job-agent-recover',
      kind: 'agent',
      state: 'running',
      sequence: 2,
    })
    agentBlock = getMessages()[0].blocks?.[0] as any
    expect(agentBlock).toMatchObject({ type: 'agent', status: 'running' })

    // A new genuine error after recovery must be appended again (once).
    dispatchValidEvent(handleEvent, {
      type: 'job_update',
      jobId: 'job-agent-recover',
      kind: 'agent',
      state: 'error',
      sequence: 3,
      error: 'second agent failure',
    })
    // Identical second error must not duplicate.
    dispatchValidEvent(handleEvent, {
      type: 'job_update',
      jobId: 'job-agent-recover',
      kind: 'agent',
      state: 'error',
      sequence: 4,
      error: 'second agent failure',
    })
    agentBlock = getMessages()[0].blocks?.[0] as any
    expect(agentBlock).toMatchObject({ type: 'agent', status: 'failed' })
    const textBlocks = (agentBlock.blocks ?? []).filter(
      (b: any) => b.type === 'text',
    )
    expect(
      textBlocks.filter((b: any) => b.content === 'first agent failure').length,
    ).toBe(1)
    expect(
      textBlocks.filter((b: any) => b.content === 'second agent failure')
        .length,
    ).toBe(1)
  })

  test('job_update appends a single error block to a failed agent job without duplicating', () => {
    const { ctx, getMessages } = createTestContext()
    const handleEvent = createEventHandler(ctx)
    dispatchValidEvent(handleEvent, {
      type: 'subagent_start',
      agentId: 'agent-err',
      agentType: 'researcher-web',
      displayName: 'Researcher',
      onlyChild: true,
    })
    ctx.message.updater.updateAiMessageBlocks((blocks) =>
      blocks.map((block) =>
        block.type === 'agent' && block.agentId === 'agent-err'
          ? { ...block, backgroundJobId: 'job-agent-err' }
          : block,
      ),
    )

    // RF-4: dispatch two fresh PrintModeEvent objects rather than reusing one
    // reference, so the dedup test stays resilient if the handler ever mutates
    // the event in place. Matches the tool-block dedup test, which dispatches
    // two distinct events (here the two updates differ in `sequence`).
    const errorJobUpdate = (sequence: number): PrintModeEvent => ({
      type: 'job_update',
      jobId: 'job-agent-err',
      kind: 'agent',
      state: 'error',
      sequence,
      error: 'agent crashed',
    })
    dispatchValidEvent(handleEvent, errorJobUpdate(1))
    dispatchValidEvent(handleEvent, errorJobUpdate(2))

    const agentBlock = getMessages()[0].blocks?.[0] as any
    expect(agentBlock).toMatchObject({ type: 'agent', status: 'failed' })
    const errorTextBlocks = (agentBlock.blocks ?? []).filter(
      (b: any) => b.type === 'text' && b.content === 'agent crashed',
    )
    expect(errorTextBlocks.length).toBe(1)
  })

  test('job_update still appends an agent job error whose text coincidentally matches trailing streamed output', () => {
    const { ctx, getMessages } = createTestContext()
    const handleEvent = createEventHandler(ctx)
    const handleChunk = createStreamChunkHandler(ctx)
    // Pins the agent-block flag dedup's advantage over comparing the last text
    // block's content: when the agent's own streamed output happens to equal
    // the error text, a genuinely new error must still be appended. The old
    // string comparison would see the trailing text block match the truncated
    // error and suppress the append.
    dispatchValidEvent(handleEvent, {
      type: 'subagent_start',
      agentId: 'agent-coincidental',
      agentType: 'researcher-web',
      displayName: 'Researcher',
      onlyChild: true,
    })
    ctx.message.updater.updateAiMessageBlocks((blocks) =>
      blocks.map((block) =>
        block.type === 'agent' && block.agentId === 'agent-coincidental'
          ? { ...block, backgroundJobId: 'job-agent-coincidental' }
          : block,
      ),
    )

    // Streamed agent output whose text coincidentally equals the error text.
    handleChunk({
      type: 'subagent_chunk',
      agentId: 'agent-coincidental',
      agentType: 'researcher-web',
      chunk: 'agent crashed',
    })
    // A genuinely new error carrying the same text; it must still be appended.
    dispatchValidEvent(handleEvent, {
      type: 'job_update',
      jobId: 'job-agent-coincidental',
      kind: 'agent',
      state: 'error',
      sequence: 1,
      error: 'agent crashed',
    })

    const agentBlock = getMessages()[0].blocks?.[0] as any
    expect(agentBlock).toMatchObject({ type: 'agent', status: 'failed' })
    const errorTextBlocks = (agentBlock.blocks ?? []).filter(
      (b: any) => b.type === 'text' && b.content === 'agent crashed',
    )
    // Once from the streamed output, once from the appended error.
    expect(errorTextBlocks.length).toBe(2)
    expect(agentBlock.blocks?.[agentBlock.blocks.length - 1]).toMatchObject({
      type: 'text',
      content: 'agent crashed',
    })
  })

  test('persists context compaction details in the assistant message', () => {
    const { ctx, getMessages } = createTestContext()
    const notices: Array<CompactionNotice | null> = []
    let notice: CompactionNotice | null = null
    ctx.streaming.setCompactionNotice = (update) => {
      notice = update(notice)
      notices.push(notice)
    }
    const handleEvent = createEventHandler(ctx)
    const categories = {
      toolResults: { tokens: 10, percent: 10, messages: 1 },
      todos: { tokens: 10, percent: 10, messages: 1 },
      fileReads: { tokens: 20, percent: 20, messages: 2 },
      subagents: { tokens: 20, percent: 20, messages: 2 },
      userAssistantMessages: { tokens: 40, percent: 40, messages: 4 },
    }

    handleEvent({
      type: 'context_compaction',
      action: 'mechanical_trim',
      resolvedContextWindowTokens: 200000,
      triggerBudgetTokens: 176000,
      targetBudgetTokens: 176000,
      reason: 'Semantic compaction did not leave enough provider headroom.',
      before: {
        tokens: 190000,
        messages: 20,
        categories,
      },
      after: {
        tokens: 120000,
        messages: 12,
        categories: {
          ...categories,
          toolResults: { tokens: 4, percent: 4, messages: 1 },
          fileReads: { tokens: 6, percent: 6, messages: 1 },
        },
      },
      removedCategories: ['toolResults', 'fileReads'],
      retainedKnowledgeMemory: false,
      recovery: 'Re-read exact files before editing.',
    })

    const block = getMessages()[0].blocks?.find(
      (candidate) => candidate.type === 'compaction',
    )
    // Deliberate contract change: compaction details are now a structured
    // 'compaction' block instead of one concatenated text block.
    expect(block).toMatchObject({
      type: 'compaction',
      action: 'mechanical_trim',
      beforeTokens: 190000,
      afterTokens: 120000,
      beforeMessages: 20,
      afterMessages: 12,
      // (190000 - 120000) / 190000 = 36.8% -> 37
      reductionPercent: 37,
      retainedKnowledgeMemory: false,
      recovery: 'Re-read exact files before editing.',
      resolvedContextWindowTokens: 200000,
      triggerBudgetTokens: 176000,
      targetBudgetTokens: 176000,
      reason: 'Semantic compaction did not leave enough provider headroom.',
      categoryDeltas: [
        { category: 'toolResults', beforeTokens: 10, afterTokens: 4 },
        { category: 'fileReads', beforeTokens: 20, afterTokens: 6 },
      ],
    })
    // No concatenated text block is emitted any more.
    expect(
      getMessages()[0].blocks?.some((candidate) => candidate.type === 'text'),
    ).toBe(false)
    expect(notices).toEqual([
      { count: 1, action: 'mechanical_trim', degraded: false },
    ])
  })

  test('degrades a compaction event whose category map omits a removed category', () => {
    const { ctx, getMessages } = createTestContext()
    const handleEvent = createEventHandler(ctx)
    // Cross-version / replayed payload: `fileReads` is reported as removed but
    // neither category map carries an entry for it. The handler must record 0
    // tokens for the missing entry instead of throwing a TypeError on the
    // dynamic index inside the SDK event handler.
    const partialCategories = {
      toolResults: { tokens: 10, percent: 10, messages: 1 },
      todos: { tokens: 10, percent: 10, messages: 1 },
      subagents: { tokens: 20, percent: 20, messages: 2 },
      userAssistantMessages: { tokens: 40, percent: 40, messages: 4 },
    }
    const event = {
      type: 'context_compaction',
      action: 'semantic_compaction',
      before: { tokens: 100, messages: 10, categories: partialCategories },
      after: { tokens: 60, messages: 6, categories: partialCategories },
      removedCategories: ['toolResults', 'fileReads'],
      retainedKnowledgeMemory: true,
      recovery: 'Re-read exact files before editing.',
    } as unknown as PrintModeContextCompaction

    expect(() => handleEvent(event)).not.toThrow()
    expect(
      getMessages()[0].blocks?.find(
        (candidate) => candidate.type === 'compaction',
      ),
    ).toMatchObject({
      type: 'compaction',
      reductionPercent: 40,
      categoryDeltas: [
        { category: 'toolResults', beforeTokens: 10, afterTokens: 10 },
        { category: 'fileReads', beforeTokens: 0, afterTokens: 0 },
      ],
    })
  })

  test('degrades a compaction event that omits removedCategories entirely', () => {
    const { ctx, getMessages } = createTestContext()
    const handleEvent = createEventHandler(ctx)
    // Cross-version / replayed payload emitted before `removedCategories`
    // existed. The handler must record an empty delta list instead of throwing
    // a TypeError while mapping an absent array.
    const categories = {
      toolResults: { tokens: 10, percent: 10, messages: 1 },
      todos: { tokens: 10, percent: 10, messages: 1 },
      fileReads: { tokens: 20, percent: 20, messages: 2 },
      subagents: { tokens: 20, percent: 20, messages: 2 },
      userAssistantMessages: { tokens: 40, percent: 40, messages: 4 },
    }
    const event = {
      type: 'context_compaction',
      action: 'semantic_compaction',
      before: { tokens: 100, messages: 10, categories },
      after: { tokens: 60, messages: 6, categories },
      retainedKnowledgeMemory: true,
      recovery: 'Re-read exact files before editing.',
    } as unknown as PrintModeContextCompaction

    expect(() => handleEvent(event)).not.toThrow()
    expect(
      getMessages()[0].blocks?.find(
        (candidate) => candidate.type === 'compaction',
      ),
    ).toMatchObject({
      type: 'compaction',
      action: 'semantic_compaction',
      reductionPercent: 40,
      categoryDeltas: [],
    })
  })

  test('accumulates the compaction notice and flags a degraded pass', () => {
    const { ctx } = createTestContext()
    // Collected instead of read from a single mutable binding so the
    // assertions below are not control-flow narrowed to `null`.
    const notices: Array<CompactionNotice | null> = []
    let notice: CompactionNotice | null = null
    ctx.streaming.setCompactionNotice = (update) => {
      notice = update(notice)
      notices.push(notice)
    }
    const handleEvent = createEventHandler(ctx)
    const categories = {
      toolResults: { tokens: 10, percent: 10, messages: 1 },
      todos: { tokens: 10, percent: 10, messages: 1 },
      fileReads: { tokens: 20, percent: 20, messages: 2 },
      subagents: { tokens: 20, percent: 20, messages: 2 },
      userAssistantMessages: { tokens: 40, percent: 40, messages: 4 },
    }
    const baseEvent = {
      type: 'context_compaction' as const,
      before: { tokens: 100, messages: 10, categories },
      after: { tokens: 90, messages: 9, categories },
      removedCategories: [],
      retainedKnowledgeMemory: true,
      recovery: 'Re-read exact files before editing.',
    }

    // No compactionCount reported: the notice counts locally.
    handleEvent({ ...baseEvent, action: 'semantic_compaction' })
    expect(notices.at(-1)).toEqual({
      count: 1,
      action: 'semantic_compaction',
      degraded: false,
    })

    // A low-yield streak degrades the notice even when the trim fits.
    handleEvent({
      ...baseEvent,
      action: 'mechanical_trim',
      consecutiveNoProgressCompactions: 2,
    })
    expect(notices.at(-1)).toEqual({
      count: 2,
      action: 'mechanical_trim',
      degraded: true,
    })

    // The runtime's own count wins, and fitsBudget: false also degrades.
    handleEvent({
      ...baseEvent,
      action: 'mechanical_trim',
      compactionCount: 7,
      fitsBudget: false,
      shortfallTokens: 1234,
    })
    expect(notices.at(-1)).toEqual({
      count: 7,
      action: 'mechanical_trim',
      degraded: true,
    })
  })

  test('context_compaction_status started appends a pending compaction block and marks the chip live', () => {
    const { ctx, getMessages } = createTestContext()
    const notices: Array<CompactionNotice | null> = []
    let notice: CompactionNotice | null = null
    ctx.streaming.setCompactionNotice = (update) => {
      notice = update(notice)
      notices.push(notice)
    }
    const handleEvent = createEventHandler(ctx)

    dispatchValidEvent(handleEvent, {
      type: 'context_compaction_status',
      state: 'started',
      // Root turn: empty lineage. Every agent loop emits this event, so the
      // correlation is what tells the CLI it may render root-level live state.
      runId: 'root-run',
      ancestorRunIds: [],
      contextTokens: 152_000,
      resolvedContextWindowTokens: 200_000,
      triggerBudgetTokens: 150_000,
      targetBudgetTokens: 70_000,
    })

    const blocks = getMessages()[0].blocks ?? []
    expect(blocks.filter((block) => block.type === 'compaction')).toHaveLength(
      1,
    )
    expect(blocks[0]).toMatchObject({
      type: 'compaction',
      status: 'pending',
      // Stamped with this process's id so a persisted/replayed copy of the
      // transient block cannot come back as a permanently live card.
      liveSessionId: CLI_LIVE_SESSION_ID,
      // Correlated to the producing run so only its own settle/result consumes it.
      runId: 'root-run',
      action: 'semantic_compaction',
      beforeTokens: 152_000,
      afterTokens: 0,
      beforeMessages: 0,
      afterMessages: 0,
      reductionPercent: 0,
      retainedKnowledgeMemory: false,
      recovery: '',
      categoryDeltas: [],
      resolvedContextWindowTokens: 200_000,
      triggerBudgetTokens: 150_000,
      targetBudgetTokens: 70_000,
    })
    expect(notices.at(-1)).toEqual({
      count: 0,
      action: 'semantic_compaction',
      degraded: false,
      pending: true,
      pendingRunIds: ['root-run'],
    })
  })

  test('a compaction result settles the pending block in place instead of duplicating it', () => {
    const { ctx, getMessages } = createTestContext()
    const notices: Array<CompactionNotice | null> = []
    let notice: CompactionNotice | null = null
    ctx.streaming.setCompactionNotice = (update) => {
      notice = update(notice)
      notices.push(notice)
    }
    const handleEvent = createEventHandler(ctx)
    const categories = {
      toolResults: { tokens: 10, percent: 10, messages: 1 },
      todos: { tokens: 10, percent: 10, messages: 1 },
      fileReads: { tokens: 20, percent: 20, messages: 2 },
      subagents: { tokens: 20, percent: 20, messages: 2 },
      userAssistantMessages: { tokens: 40, percent: 40, messages: 4 },
    }

    dispatchValidEvent(handleEvent, {
      type: 'context_compaction_status',
      state: 'started',
      runId: 'root-run',
      ancestorRunIds: [],
      contextTokens: 152_000,
    })
    dispatchValidEvent(handleEvent, {
      type: 'context_compaction',
      action: 'semantic_compaction',
      runId: 'root-run',
      ancestorRunIds: [],
      before: { tokens: 152_000, messages: 20, categories },
      after: { tokens: 60_000, messages: 8, categories },
      removedCategories: [],
      retainedKnowledgeMemory: true,
      recovery: 'Resume from <knowledge_memory>.',
    })

    let compactionBlocks = (getMessages()[0].blocks ?? []).filter(
      (block) => block.type === 'compaction',
    )
    // The live card settled in place: one block, now complete.
    expect(compactionBlocks).toHaveLength(1)
    expect(compactionBlocks[0]).toMatchObject({
      type: 'compaction',
      status: 'complete',
      action: 'semantic_compaction',
      beforeTokens: 152_000,
      afterTokens: 60_000,
      beforeMessages: 20,
      afterMessages: 8,
    })
    // A settled result is no longer live, so it carries no session stamp and
    // persists as a plain completed pass.
    expect(compactionBlocks[0]).not.toHaveProperty('liveSessionId')
    expect(notices.at(-1)).toEqual({
      count: 1,
      action: 'semantic_compaction',
      degraded: false,
    })

    // A second result in the same iteration (semantic then mechanical) has no
    // pending block left to consume, so it appends instead of overwriting.
    dispatchValidEvent(handleEvent, {
      type: 'context_compaction',
      action: 'mechanical_trim',
      runId: 'root-run',
      ancestorRunIds: [],
      before: { tokens: 60_000, messages: 8, categories },
      after: { tokens: 40_000, messages: 5, categories },
      removedCategories: [],
      retainedKnowledgeMemory: false,
      recovery: 'Re-gather exact constraints.',
    })

    compactionBlocks = (getMessages()[0].blocks ?? []).filter(
      (block) => block.type === 'compaction',
    )
    expect(compactionBlocks).toHaveLength(2)
    expect(compactionBlocks.map((block) => block.action)).toEqual([
      'semantic_compaction',
      'mechanical_trim',
    ])

    // Settling after a real result leaves the completed cards untouched.
    dispatchValidEvent(handleEvent, {
      type: 'context_compaction_status',
      state: 'settled',
      runId: 'root-run',
      ancestorRunIds: [],
    })
    expect(
      (getMessages()[0].blocks ?? []).filter(
        (block) => block.type === 'compaction',
      ),
    ).toHaveLength(2)
    expect(notices.at(-1)).toEqual({
      count: 2,
      action: 'mechanical_trim',
      degraded: false,
    })
  })

  test('settled with no result rewrites the pending block as a declined pass and clears the notice', () => {
    const { ctx, getMessages } = createTestContext()
    const notices: Array<CompactionNotice | null> = []
    let notice: CompactionNotice | null = null
    ctx.streaming.setCompactionNotice = (update) => {
      notice = update(notice)
      notices.push(notice)
    }
    const handleEvent = createEventHandler(ctx)

    dispatchValidEvent(handleEvent, {
      type: 'context_compaction_status',
      state: 'started',
      runId: 'root-run',
      ancestorRunIds: [],
      contextTokens: 152_000,
    })
    dispatchValidEvent(handleEvent, {
      type: 'context_compaction_status',
      state: 'settled',
      runId: 'root-run',
      ancestorRunIds: [],
    })

    // The pass RAN and reclaimed nothing, so the transcript keeps an honest
    // terminal trace of it instead of deleting the card.
    const compactionBlocks = (getMessages()[0].blocks ?? []).filter(
      (block) => block.type === 'compaction',
    )
    expect(compactionBlocks).toHaveLength(1)
    expect(compactionBlocks[0]).toMatchObject({
      type: 'compaction',
      status: 'declined',
      runId: 'root-run',
      beforeTokens: 152_000,
    })
    // The live stamp is meaningless once the pass is terminal.
    expect(compactionBlocks[0]).not.toHaveProperty('liveSessionId')
    // The declined pass is reported by the transcript card above. The chip
    // selector renders nothing for a settled notice at count 0, so the notice
    // is cleared instead of being retained as unobservable state.
    expect(notices.at(-1)).toBeNull()
  })

  test('consecutive declined passes on the same run collapse into a single card', () => {
    const { ctx, getMessages } = createTestContext()
    const handleEvent = createEventHandler(ctx)

    for (const contextTokens of [152_000, 153_000]) {
      dispatchValidEvent(handleEvent, {
        type: 'context_compaction_status',
        state: 'started',
        runId: 'root-run',
        ancestorRunIds: [],
        contextTokens,
      })
      dispatchValidEvent(handleEvent, {
        type: 'context_compaction_status',
        state: 'settled',
        runId: 'root-run',
        ancestorRunIds: [],
      })
    }

    // Over-trigger iterations that each decline must not accumulate a column of
    // identical cards.
    const compactionBlocks = (getMessages()[0].blocks ?? []).filter(
      (block) => block.type === 'compaction',
    )
    expect(compactionBlocks).toHaveLength(1)
    expect(compactionBlocks[0]).toMatchObject({
      status: 'declined',
      runId: 'root-run',
      beforeTokens: 153_000,
    })
  })

  test('the widened persisted compaction block stays plain JSON and round-trips prior sessions', () => {
    const { ctx, getMessages } = createTestContext()
    const handleEvent = createEventHandler(ctx)

    // A block written by an OLDER CLI: no status, no subagent, no trimSource.
    // Replaying it must not rewrite or enrich it, so prior sessions round-trip.
    const legacyBlock: CompactionContentBlock = {
      type: 'compaction',
      action: 'semantic_compaction',
      beforeTokens: 190_000,
      afterTokens: 120_000,
      beforeMessages: 20,
      afterMessages: 12,
      reductionPercent: 37,
      retainedKnowledgeMemory: true,
      recovery: 'Re-read exact files before editing.',
      categoryDeltas: [],
    }
    ctx.message.updater.updateAiMessageBlocks((blocks) => [
      ...blocks,
      legacyBlock,
    ])

    // Both new terminal/label fields are produced by live events: a declined
    // root pass and a nested request-time trim.
    dispatchValidEvent(handleEvent, {
      type: 'context_compaction_status',
      state: 'started',
      runId: 'root-run',
      ancestorRunIds: [],
      contextTokens: 152_000,
    })
    dispatchValidEvent(handleEvent, {
      type: 'context_compaction_status',
      state: 'settled',
      runId: 'root-run',
      ancestorRunIds: [],
    })
    dispatchValidEvent(handleEvent, {
      type: 'context_request_trim',
      runId: 'child-run',
      ancestorRunIds: ['root-run'],
      messageBudgetTokens: 90_000,
      beforeTokens: 100_000,
      afterTokens: 80_000,
      beforeMessages: 12,
      afterMessages: 9,
    })

    const blocks = (getMessages()[0].blocks ?? []).filter(
      (block) => block.type === 'compaction',
    ) as CompactionContentBlock[]
    expect(blocks).toHaveLength(3)

    // The legacy block is byte-identical after replay: no status was invented
    // for it, so an older session keeps rendering as a completed pass.
    expect(blocks[0]).toEqual(legacyBlock)
    expect(blocks[0]).not.toHaveProperty('status')
    expect(blocks[0]).not.toHaveProperty('subagent')
    expect(blocks[0]).not.toHaveProperty('trimSource')

    // The widened fields are the documented terminal value plus the two optional
    // labels, and nothing else was added to the persisted shape.
    expect(blocks[1]).toMatchObject({ status: 'declined', runId: 'root-run' })
    expect(blocks[2]).toMatchObject({
      status: 'complete',
      trimSource: 'request',
      subagent: true,
    })

    // Persistence is JSON: every block survives a chat-messages.json round trip
    // unchanged, so no field is a function, class instance, or undefined hole.
    expect(JSON.parse(JSON.stringify(blocks))).toEqual(blocks)
  })

  test('context_request_trim renders a request-time card and degrades the notice', () => {
    const { ctx, getMessages } = createTestContext()
    const notices: Array<CompactionNotice | null> = []
    let notice: CompactionNotice | null = null
    ctx.streaming.setCompactionNotice = (update) => {
      notice = update(notice)
      notices.push(notice)
    }
    const handleEvent = createEventHandler(ctx)

    dispatchValidEvent(handleEvent, {
      type: 'context_compaction_status',
      state: 'started',
      runId: 'root-run',
      ancestorRunIds: [],
      contextTokens: 152_000,
    })
    dispatchValidEvent(handleEvent, {
      type: 'context_request_trim',
      runId: 'root-run',
      ancestorRunIds: [],
      resolvedContextWindowTokens: 200_000,
      messageBudgetTokens: 150_000,
      beforeTokens: 180_000,
      afterTokens: 140_000,
      beforeMessages: 30,
      afterMessages: 22,
      model: 'anthropic/claude',
    })

    const compactionBlocks = (getMessages()[0].blocks ?? []).filter(
      (block) => block.type === 'compaction',
    )
    // The request-time trim is an ADDITIONAL pass, so it appends rather than
    // consuming the root run's still-live card.
    expect(compactionBlocks).toHaveLength(2)
    expect(compactionBlocks[0]).toMatchObject({
      status: 'pending',
      runId: 'root-run',
    })
    expect(compactionBlocks[1]).toMatchObject({
      type: 'compaction',
      status: 'complete',
      action: 'mechanical_trim',
      trimSource: 'request',
      runId: 'root-run',
      beforeTokens: 180_000,
      afterTokens: 140_000,
      beforeMessages: 30,
      afterMessages: 22,
      // (180000 - 140000) / 180000 = 22.2% -> 22
      reductionPercent: 22,
      retainedKnowledgeMemory: false,
      triggerBudgetTokens: 150_000,
      targetBudgetTokens: 150_000,
      resolvedContextWindowTokens: 200_000,
      categoryDeltas: [],
    })
    expect(compactionBlocks[1]).not.toHaveProperty('subagent')
    // Reaching the request-time brake means the runtime brakes failed.
    expect(notices.at(-1)).toEqual({
      count: 1,
      action: 'mechanical_trim',
      degraded: true,
      pending: true,
      pendingRunIds: ['root-run'],
    })
  })

  test('a nested context_request_trim is marked as a subagent pass', () => {
    const { ctx, getMessages } = createTestContext()
    const handleEvent = createEventHandler(ctx)

    dispatchValidEvent(handleEvent, {
      type: 'context_request_trim',
      runId: 'child-run',
      ancestorRunIds: ['root-run'],
      agentId: 'child-agent',
      messageBudgetTokens: 90_000,
      beforeTokens: 100_000,
      afterTokens: 80_000,
      beforeMessages: 12,
      afterMessages: 9,
    })

    expect(
      (getMessages()[0].blocks ?? []).find(
        (block) => block.type === 'compaction',
      ),
    ).toMatchObject({
      status: 'complete',
      trimSource: 'request',
      runId: 'child-run',
      subagent: true,
    })
  })

  test('printModeContextRequestTrimSchema parses a minimal payload and requires messageBudgetTokens', () => {
    const minimal = {
      type: 'context_request_trim' as const,
      messageBudgetTokens: 150_000,
      beforeTokens: 180_000,
      afterTokens: 140_000,
      beforeMessages: 30,
      afterMessages: 22,
    }
    expect(printModeContextRequestTrimSchema.parse(minimal)).toEqual(minimal)
    // The correlation fields are optional, so the minimal payload above also
    // parses through the discriminated union.
    expect(printModeEventSchema.parse(minimal)).toMatchObject({
      type: 'context_request_trim',
    })

    const { messageBudgetTokens: _omitted, ...withoutBudget } = minimal
    expect(
      printModeContextRequestTrimSchema.safeParse(withoutBudget).success,
    ).toBe(false)
  })

  test('RequestContextTrimInfo is nameable from the published SDK type surface', () => {
    // `RequestContextTrimInfo` is the payload type of the `promptAiSdk*`
    // `onRequestContextTrimmed` callback. The type-only import above names it
    // through `@openbuff/sdk`, so this file fails to compile if the published
    // entry point stops exporting it.
    const info: RequestContextTrimInfo = {
      contextWindowTokens: 200_000,
      messageBudgetTokens: 150_000,
      beforeTokens: 180_000,
      afterTokens: 140_000,
      beforeMessages: 30,
      afterMessages: 22,
      model: 'anthropic/claude',
    }

    // Runtime evidence for the BUNDLED surface, which a type-only import cannot
    // give on its own: `sdk/scripts/build.ts` generates `dist/index.d.ts` from
    // `sdk/src/index.ts` with `exportReferencedTypes: false`, so a type only
    // survives bundling if the entry point publishes the module that DECLARES
    // it. Assert both halves of that chain in the live sources: the entry point
    // re-exports `print-mode` wholesale, and `print-mode` declares the type
    // itself instead of forwarding it out of the unpublished contracts module.
    const repoRoot = join(import.meta.dir, '..', '..', '..', '..')
    const sdkEntryPoint = readFileSync(
      join(repoRoot, 'sdk', 'src', 'index.ts'),
      'utf8',
    )
    const printModeSource = readFileSync(
      join(repoRoot, 'common', 'src', 'types', 'print-mode.ts'),
      'utf8',
    )
    expect(sdkEntryPoint).toContain(
      "export type * from '@codebuff/common/types/print-mode'",
    )
    expect(printModeSource).toContain('export type RequestContextTrimInfo = {')
    expect(printModeSource).not.toContain(
      "export type { RequestContextTrimInfo } from './contracts/llm'",
    )

    // The callback payload maps field-for-field onto the published event, so a
    // consumer that names the type can forward it as `context_request_trim`.
    const { contextWindowTokens, ...trimMeasurements } = info
    expect(
      printModeContextRequestTrimSchema.parse({
        type: 'context_request_trim',
        resolvedContextWindowTokens: contextWindowTokens,
        ...trimMeasurements,
      }),
    ).toEqual({
      type: 'context_request_trim',
      resolvedContextWindowTokens: 200_000,
      messageBudgetTokens: 150_000,
      beforeTokens: 180_000,
      afterTokens: 140_000,
      beforeMessages: 30,
      afterMessages: 22,
      model: 'anthropic/claude',
    })
  })

  test('a legacy notice with pending but no pendingRunIds keeps its live flag until a settling event', () => {
    const { ctx } = createTestContext()
    const notices: Array<CompactionNotice | null> = []
    // The tolerated pre-per-run shape documented on
    // `CompactionNotice.pendingRunIds`: a live pass with no recorded run.
    let notice: CompactionNotice | null = {
      count: 1,
      action: 'semantic_compaction',
      degraded: false,
      pending: true,
    }
    ctx.streaming.setCompactionNotice = (update) => {
      notice = update(notice)
      notices.push(notice)
    }
    const handleEvent = createEventHandler(ctx)
    const categories = {
      toolResults: { tokens: 10, percent: 10, messages: 1 },
      todos: { tokens: 10, percent: 10, messages: 1 },
      fileReads: { tokens: 20, percent: 20, messages: 2 },
      subagents: { tokens: 20, percent: 20, messages: 2 },
      userAssistantMessages: { tokens: 40, percent: 40, messages: 4 },
    }

    // A request-time trim settles no announced pass, so the uncorrelated live
    // flag survives it instead of being silently recomputed away.
    dispatchValidEvent(handleEvent, {
      type: 'context_request_trim',
      runId: 'root-run',
      ancestorRunIds: [],
      messageBudgetTokens: 150_000,
      beforeTokens: 180_000,
      afterTokens: 140_000,
      beforeMessages: 30,
      afterMessages: 22,
    })
    expect(notices.at(-1)).toEqual({
      count: 2,
      action: 'mechanical_trim',
      degraded: true,
      pending: true,
    })

    // A NESTED compaction result changes no live state either.
    dispatchValidEvent(handleEvent, {
      type: 'context_compaction',
      action: 'semantic_compaction',
      runId: 'child-run',
      ancestorRunIds: ['root-run'],
      before: { tokens: 100_000, messages: 20, categories },
      after: { tokens: 60_000, messages: 8, categories },
      removedCategories: [],
      retainedKnowledgeMemory: true,
      recovery: 'Resume from <knowledge_memory>.',
    })
    expect(notices.at(-1)).toEqual({
      count: 3,
      action: 'semantic_compaction',
      degraded: false,
      pending: true,
    })

    // A `settled` is the only signal that can clear a live flag whose run is
    // unknown, so it does — the chip must not stay live for the rest of the turn.
    dispatchValidEvent(handleEvent, {
      type: 'context_compaction_status',
      state: 'settled',
      runId: 'root-run',
      ancestorRunIds: [],
    })
    expect(notices.at(-1)).toEqual({
      count: 3,
      action: 'semantic_compaction',
      degraded: false,
    })
  })

  test('a legacy pending flag is consumed by the root compaction result it stands for', () => {
    const { ctx } = createTestContext()
    const notices: Array<CompactionNotice | null> = []
    let notice: CompactionNotice | null = {
      count: 0,
      action: 'semantic_compaction',
      degraded: false,
      pending: true,
    }
    ctx.streaming.setCompactionNotice = (update) => {
      notice = update(notice)
      notices.push(notice)
    }
    const handleEvent = createEventHandler(ctx)
    const categories = {
      toolResults: { tokens: 10, percent: 10, messages: 1 },
      todos: { tokens: 10, percent: 10, messages: 1 },
      fileReads: { tokens: 20, percent: 20, messages: 2 },
      subagents: { tokens: 20, percent: 20, messages: 2 },
      userAssistantMessages: { tokens: 40, percent: 40, messages: 4 },
    }

    dispatchValidEvent(handleEvent, {
      type: 'context_compaction',
      action: 'semantic_compaction',
      runId: 'root-run',
      ancestorRunIds: [],
      before: { tokens: 152_000, messages: 20, categories },
      after: { tokens: 60_000, messages: 8, categories },
      removedCategories: [],
      retainedKnowledgeMemory: true,
      recovery: 'Resume from <knowledge_memory>.',
    })

    // The root run reported its result, so the pass the uncorrelated flag stood
    // for is over and the notice settles.
    expect(notices.at(-1)).toEqual({
      count: 1,
      action: 'semantic_compaction',
      degraded: false,
    })
  })

  test('a started pass keeps the completed action so an aborted turn labels the chip by what finished', () => {
    const { ctx } = createTestContext()
    const notices: Array<CompactionNotice | null> = []
    let notice: CompactionNotice | null = null
    ctx.streaming.setCompactionNotice = (update) => {
      notice = update(notice)
      notices.push(notice)
    }
    const handleEvent = createEventHandler(ctx)
    const categories = {
      toolResults: { tokens: 10, percent: 10, messages: 1 },
      todos: { tokens: 10, percent: 10, messages: 1 },
      fileReads: { tokens: 20, percent: 20, messages: 2 },
      subagents: { tokens: 20, percent: 20, messages: 2 },
      userAssistantMessages: { tokens: 40, percent: 40, messages: 4 },
    }

    // The turn's only completed pass is an emergency mechanical trim.
    dispatchValidEvent(handleEvent, {
      type: 'context_compaction',
      action: 'mechanical_trim',
      runId: 'root-run',
      ancestorRunIds: [],
      before: { tokens: 152_000, messages: 20, categories },
      after: { tokens: 120_000, messages: 15, categories },
      removedCategories: [],
      retainedKnowledgeMemory: false,
      recovery: 'Re-gather exact constraints.',
    })
    expect(notices.at(-1)).toEqual({
      count: 1,
      action: 'mechanical_trim',
      degraded: false,
    })

    // A next pass starts and the user aborts before it reports anything. The
    // live label ignores `action`, so the completed pass's action must survive:
    // otherwise the settled chip would claim '⇲ compacted ×1'.
    dispatchValidEvent(handleEvent, {
      type: 'context_compaction_status',
      state: 'started',
      runId: 'root-run',
      ancestorRunIds: [],
      contextTokens: 120_000,
    })
    expect(notices.at(-1)).toEqual({
      count: 1,
      action: 'mechanical_trim',
      degraded: false,
      pending: true,
      pendingRunIds: ['root-run'],
    })
  })

  test('a subagent compaction status renders no card but still reports a live pass', () => {
    const { ctx, getMessages } = createTestContext()
    const notices: Array<CompactionNotice | null> = []
    let notice: CompactionNotice | null = null
    ctx.streaming.setCompactionNotice = (update) => {
      notice = update(notice)
      notices.push(notice)
    }
    const handleEvent = createEventHandler(ctx)

    dispatchValidEvent(handleEvent, {
      type: 'context_compaction_status',
      state: 'started',
      runId: 'root-run',
      ancestorRunIds: [],
      contextTokens: 152_000,
    })
    // A foreground subagent / inline agent loop compacts its own context. Its
    // lineage is non-empty, so it must not add a second root-level card, but
    // the chip still reports that a pass is live.
    dispatchValidEvent(handleEvent, {
      type: 'context_compaction_status',
      state: 'started',
      runId: 'child-run',
      ancestorRunIds: ['root-run'],
      agentId: 'child-agent',
      contextTokens: 90_000,
    })
    expect(
      (getMessages()[0].blocks ?? []).filter(
        (block) => block.type === 'compaction',
      ),
    ).toHaveLength(1)
    expect(notices.at(-1)).toEqual({
      count: 0,
      action: 'semantic_compaction',
      degraded: false,
      pending: true,
      pendingRunIds: ['root-run', 'child-run'],
    })
    // Nor may its settle clear the root run's still-live card.
    dispatchValidEvent(handleEvent, {
      type: 'context_compaction_status',
      state: 'settled',
      runId: 'child-run',
      ancestorRunIds: ['root-run'],
      agentId: 'child-agent',
    })

    const pending = (getMessages()[0].blocks ?? []).filter(
      (block) => block.type === 'compaction',
    )
    expect(pending).toHaveLength(1)
    expect(pending[0]).toMatchObject({ status: 'pending', runId: 'root-run' })
    expect(notices.at(-1)).toEqual({
      count: 0,
      action: 'semantic_compaction',
      degraded: false,
      pending: true,
      pendingRunIds: ['root-run'],
    })

    // Only the root run's own settle ends the live state, and it terminates the
    // card as a declined pass rather than deleting it.
    dispatchValidEvent(handleEvent, {
      type: 'context_compaction_status',
      state: 'settled',
      runId: 'root-run',
      ancestorRunIds: [],
    })
    const settled = (getMessages()[0].blocks ?? []).filter(
      (block) => block.type === 'compaction',
    )
    expect(settled).toHaveLength(1)
    expect(settled[0]).toMatchObject({ status: 'declined', runId: 'root-run' })
    // No pass completed in the turn, so the settled notice is cleared: the chip
    // renders nothing for a notice that is neither pending nor count > 0.
    expect(notices.at(-1)).toBeNull()
  })

  test("a subagent compaction result cannot overwrite the root turn's count or settle its live card", () => {
    const { ctx, getMessages } = createTestContext()
    const notices: Array<CompactionNotice | null> = []
    let notice: CompactionNotice | null = null
    ctx.streaming.setCompactionNotice = (update) => {
      notice = update(notice)
      notices.push(notice)
    }
    const handleEvent = createEventHandler(ctx)
    const categories = {
      toolResults: { tokens: 10, percent: 10, messages: 1 },
      todos: { tokens: 10, percent: 10, messages: 1 },
      fileReads: { tokens: 20, percent: 20, messages: 2 },
      subagents: { tokens: 20, percent: 20, messages: 2 },
      userAssistantMessages: { tokens: 40, percent: 40, messages: 4 },
    }

    dispatchValidEvent(handleEvent, {
      type: 'context_compaction_status',
      state: 'started',
      runId: 'root-run',
      ancestorRunIds: [],
      contextTokens: 152_000,
    })
    // `compactionCount` counts the emitting run's own passes, so a subagent's
    // 9 must not become the root turn's total, and its result must not consume
    // the root run's pending card or clear the live chip.
    dispatchValidEvent(handleEvent, {
      type: 'context_compaction',
      action: 'semantic_compaction',
      runId: 'child-run',
      ancestorRunIds: ['root-run'],
      agentId: 'child-agent',
      compactionCount: 9,
      before: { tokens: 90_000, messages: 12, categories },
      after: { tokens: 40_000, messages: 6, categories },
      removedCategories: [],
      retainedKnowledgeMemory: true,
      recovery: 'Resume from <knowledge_memory>.',
    })

    let blocks = (getMessages()[0].blocks ?? []).filter(
      (block) => block.type === 'compaction',
    )
    expect(blocks).toHaveLength(2)
    expect(blocks[0]).toMatchObject({ status: 'pending', runId: 'root-run' })
    expect(blocks[1]).toMatchObject({
      status: 'complete',
      runId: 'child-run',
      // A nested run's result is labelled as a subagent pass.
      subagent: true,
    })
    expect(notices.at(-1)).toEqual({
      count: 1,
      action: 'semantic_compaction',
      degraded: false,
      pending: true,
      pendingRunIds: ['root-run'],
    })

    // The root run's own result adopts its reported count and clears the live
    // state, settling the root card in place.
    dispatchValidEvent(handleEvent, {
      type: 'context_compaction',
      action: 'mechanical_trim',
      runId: 'root-run',
      ancestorRunIds: [],
      compactionCount: 2,
      before: { tokens: 152_000, messages: 20, categories },
      after: { tokens: 60_000, messages: 8, categories },
      removedCategories: [],
      retainedKnowledgeMemory: false,
      recovery: 'Re-gather exact constraints.',
    })

    blocks = (getMessages()[0].blocks ?? []).filter(
      (block) => block.type === 'compaction',
    )
    expect(blocks).toHaveLength(2)
    expect(blocks[0]).toMatchObject({
      status: 'complete',
      runId: 'root-run',
      action: 'mechanical_trim',
    })
    expect(notices.at(-1)).toEqual({
      count: 2,
      action: 'mechanical_trim',
      degraded: false,
    })
  })

  test('a forwarding-rewritten agentId does not affect run correlation for a deeply nested compaction', () => {
    const { ctx, getMessages } = createTestContext()
    const notices: Array<CompactionNotice | null> = []
    let notice: CompactionNotice | null = null
    ctx.streaming.setCompactionNotice = (update) => {
      notice = update(notice)
      notices.push(notice)
    }
    const handleEvent = createEventHandler(ctx)
    const categories = {
      toolResults: { tokens: 10, percent: 10, messages: 1 },
      todos: { tokens: 10, percent: 10, messages: 1 },
      fileReads: { tokens: 20, percent: 20, messages: 2 },
      subagents: { tokens: 20, percent: 20, messages: 2 },
      userAssistantMessages: { tokens: 40, percent: 40, messages: 4 },
    }

    dispatchValidEvent(handleEvent, {
      type: 'context_compaction_status',
      state: 'started',
      runId: 'root-run',
      ancestorRunIds: [],
      contextTokens: 152_000,
    })
    // Depth-2 emission as the CLI actually receives it: the spawn_agents
    // forwarding path rewrote `agentId` to the DIRECT child's agent id, so the
    // delivered value names the forwarding child rather than the grandchild
    // that compacted. `runId`/`ancestorRunIds` survive every hop, so they -- not
    // `agentId` -- decide what is root-level and what settles which card.
    dispatchValidEvent(handleEvent, {
      type: 'context_compaction_status',
      state: 'started',
      runId: 'grandchild-run',
      ancestorRunIds: ['root-run', 'child-run'],
      agentId: 'direct-child-agent',
      contextTokens: 70_000,
    })
    dispatchValidEvent(handleEvent, {
      type: 'context_compaction_status',
      state: 'settled',
      runId: 'grandchild-run',
      ancestorRunIds: ['root-run', 'child-run'],
      agentId: 'direct-child-agent',
    })

    // The nested pass never rendered root-level live state, and its settle left
    // the root run's live card and chip alone.
    let blocks = (getMessages()[0].blocks ?? []).filter(
      (block) => block.type === 'compaction',
    )
    expect(blocks).toHaveLength(1)
    expect(blocks[0]).toMatchObject({ status: 'pending', runId: 'root-run' })
    expect(notices.at(-1)).toEqual({
      count: 0,
      action: 'semantic_compaction',
      degraded: false,
      pending: true,
      pendingRunIds: ['root-run'],
    })

    // Its result is recorded under its own emitting run, even though the
    // delivered `agentId` matches the forwarding child rather than the emitter.
    dispatchValidEvent(handleEvent, {
      type: 'context_compaction',
      action: 'semantic_compaction',
      runId: 'grandchild-run',
      ancestorRunIds: ['root-run', 'child-run'],
      agentId: 'direct-child-agent',
      compactionCount: 4,
      before: { tokens: 70_000, messages: 10, categories },
      after: { tokens: 30_000, messages: 5, categories },
      removedCategories: [],
      retainedKnowledgeMemory: true,
      recovery: 'Resume from <knowledge_memory>.',
    })

    blocks = (getMessages()[0].blocks ?? []).filter(
      (block) => block.type === 'compaction',
    )
    expect(blocks).toHaveLength(2)
    expect(blocks[0]).toMatchObject({ status: 'pending', runId: 'root-run' })
    expect(blocks[1]).toMatchObject({
      status: 'complete',
      runId: 'grandchild-run',
      // Rendered as its own nested pass rather than being card-suppressed.
      subagent: true,
    })
    // The nested run's own count never becomes the root turn's total, and the
    // root run's live pass is still live.
    expect(notices.at(-1)).toEqual({
      count: 1,
      action: 'semantic_compaction',
      degraded: false,
      pending: true,
      pendingRunIds: ['root-run'],
    })
  })

  test('handleFinish rewrites a stray pending compaction block as interrupted', () => {
    const { ctx, getMessages } = createTestContext()
    const handleEvent = createEventHandler(ctx)

    dispatchValidEvent(handleEvent, {
      type: 'context_compaction_status',
      state: 'started',
      runId: 'root-run',
      ancestorRunIds: [],
      contextTokens: 152_000,
    })
    // No `settled` arrives (an abnormal turn end between the two): the turn
    // boundary must terminate the live card rather than silently deleting it,
    // so the transcript keeps an honest record of the unfinished pass.
    dispatchValidEvent(handleEvent, { type: 'finish', totalCost: 0 })

    const compactionBlocks = (getMessages()[0].blocks ?? []).filter(
      (block) => block.type === 'compaction',
    )
    expect(compactionBlocks).toHaveLength(1)
    expect(compactionBlocks[0]).toMatchObject({
      type: 'compaction',
      status: 'interrupted',
      runId: 'root-run',
      beforeTokens: 152_000,
    })
    // The live stamp is meaningless once the run is over, so it does not
    // persist alongside the terminal state.
    expect(compactionBlocks[0]).not.toHaveProperty('liveSessionId')
  })

  // Payload fixtures for the live-progress cases below. They build the same
  // shapes the compaction tests above dispatch inline; only the fields under
  // test vary per case.
  const compactionCategories = {
    toolResults: { tokens: 10, percent: 10, messages: 1 },
    todos: { tokens: 10, percent: 10, messages: 1 },
    fileReads: { tokens: 20, percent: 20, messages: 2 },
    subagents: { tokens: 20, percent: 20, messages: 2 },
    userAssistantMessages: { tokens: 40, percent: 40, messages: 4 },
  }

  const startedEvent = (runId = 'root-run', contextTokens = 152_000) => ({
    type: 'context_compaction_status' as const,
    state: 'started' as const,
    runId,
    ancestorRunIds: [],
    contextTokens,
  })

  const progressEvent = (
    overrides: Partial<PrintModeContextCompactionProgress> = {},
  ): PrintModeContextCompactionProgress => ({
    type: 'context_compaction_progress',
    // Root turn by default: empty lineage is what allows root-level card state.
    runId: 'root-run',
    ancestorRunIds: [],
    percent: 40,
    phase: 'summarizing',
    ...overrides,
  })

  const compactionResultEvent = (
    overrides: Partial<PrintModeContextCompaction> = {},
  ): PrintModeContextCompaction => ({
    type: 'context_compaction',
    action: 'semantic_compaction',
    runId: 'root-run',
    ancestorRunIds: [],
    before: { tokens: 152_000, messages: 20, categories: compactionCategories },
    after: { tokens: 60_000, messages: 8, categories: compactionCategories },
    removedCategories: [],
    retainedKnowledgeMemory: true,
    recovery: 'Resume from <knowledge_memory>.',
    ...overrides,
  })

  const compactionCards = (
    messages: ChatMessage[],
  ): CompactionContentBlock[] =>
    (messages[0].blocks ?? []).filter(
      (block): block is CompactionContentBlock => block.type === 'compaction',
    )

  /**
   * The single card left behind by one announced root pass that reported
   * `overrides` as its result. Each call gets a fresh handler context, so the
   * transient gate below is asserted per outcome rather than across accumulated
   * state.
   */
  const settledCardFor = (
    overrides: Partial<PrintModeContextCompaction> = {},
  ): CompactionContentBlock => {
    const { ctx, getMessages } = createTestContext()
    const handleEvent = createEventHandler(ctx)
    dispatchValidEvent(handleEvent, startedEvent())
    dispatchValidEvent(handleEvent, progressEvent({ percent: 60 }))
    dispatchValidEvent(handleEvent, compactionResultEvent(overrides))
    const cards = compactionCards(getMessages())
    expect(cards).toHaveLength(1)
    return cards[0]
  }

  test('context_compaction_progress raises the pending card progress for the root run', () => {
    const { ctx, getMessages } = createTestContext()
    const handleEvent = createEventHandler(ctx)

    dispatchValidEvent(handleEvent, startedEvent())
    // A freshly announced pass starts its bar at 0; only progress moves it.
    expect(compactionCards(getMessages())[0]).toMatchObject({
      status: 'pending',
      runId: 'root-run',
      progressPercent: 0,
    })

    dispatchValidEvent(handleEvent, progressEvent({ percent: 45 }))

    const cards = compactionCards(getMessages())
    // The live card advances in place rather than gaining a sibling.
    expect(cards).toHaveLength(1)
    expect(cards[0]).toMatchObject({
      status: 'pending',
      runId: 'root-run',
      progressPercent: 45,
    })
  })

  test('a lower progress percent never rewinds the pending card', () => {
    const { ctx, getMessages } = createTestContext()
    const notices: Array<CompactionNotice | null> = []
    let notice: CompactionNotice | null = null
    ctx.streaming.setCompactionNotice = (update) => {
      notice = update(notice)
      notices.push(notice)
    }
    const handleEvent = createEventHandler(ctx)

    dispatchValidEvent(handleEvent, startedEvent())
    dispatchValidEvent(handleEvent, progressEvent({ percent: 60 }))
    // Two producers report for one pass, so an out-of-order or duplicated
    // percent is expected: every write takes the maximum already recorded.
    dispatchValidEvent(
      handleEvent,
      progressEvent({ percent: 25, phase: 'applying' }),
    )

    expect(compactionCards(getMessages())[0]).toMatchObject({
      progressPercent: 60,
    })
    expect(notices.at(-1)).toEqual({
      count: 0,
      action: 'semantic_compaction',
      degraded: false,
      pending: true,
      pendingRunIds: ['root-run'],
      progressPercent: 60,
    })
  })

  test('a non-finite or out-of-range progress percent is clamped instead of thrown on', () => {
    const { ctx, getMessages } = createTestContext()
    const handleEvent = createEventHandler(ctx)

    dispatchValidEvent(handleEvent, startedEvent())

    // Garbage percents are dispatched without the schema on purpose: a replayed
    // or cross-version payload can carry them, and the percent is documented as
    // best-effort telemetry, so they must degrade to a renderable number.
    for (const percent of [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      -20,
    ]) {
      expect(() => handleEvent(progressEvent({ percent }))).not.toThrow()
    }
    // Still the announced 0 rather than NaN or a negative bar width.
    expect(compactionCards(getMessages())[0]).toMatchObject({
      progressPercent: 0,
    })

    dispatchValidEvent(
      handleEvent,
      progressEvent({ percent: 150, phase: 'applying' }),
    )
    // An over-range estimate reads as a finished bar, never as 150%.
    expect(compactionCards(getMessages())[0]).toMatchObject({
      progressPercent: 100,
    })
  })

  test('a nested progress event advances the shared chip without touching the root card', () => {
    const { ctx, getMessages } = createTestContext()
    const notices: Array<CompactionNotice | null> = []
    let notice: CompactionNotice | null = null
    ctx.streaming.setCompactionNotice = (update) => {
      notice = update(notice)
      notices.push(notice)
    }
    const handleEvent = createEventHandler(ctx)

    dispatchValidEvent(handleEvent, startedEvent())
    // A foreground subagent / inline agent loop renders no root-level card, so
    // its progress has none to advance -- but the status chip is shared, so it
    // still reports movement while a pass is live.
    dispatchValidEvent(
      handleEvent,
      progressEvent({
        runId: 'child-run',
        ancestorRunIds: ['root-run'],
        agentId: 'child-agent',
        percent: 55,
        phase: 'analyzing',
      }),
    )

    const cards = compactionCards(getMessages())
    expect(cards).toHaveLength(1)
    expect(cards[0]).toMatchObject({
      status: 'pending',
      runId: 'root-run',
      progressPercent: 0,
    })
    expect(notices.at(-1)).toEqual({
      count: 0,
      action: 'semantic_compaction',
      degraded: false,
      pending: true,
      pendingRunIds: ['root-run'],
      progressPercent: 55,
    })
  })

  test('a progress event with no pass pending neither creates a notice nor revives a settled one', () => {
    const { ctx, getMessages } = createTestContext()
    const notices: Array<CompactionNotice | null> = []
    let notice: CompactionNotice | null = null
    ctx.streaming.setCompactionNotice = (update) => {
      notice = update(notice)
      notices.push(notice)
    }
    const handleEvent = createEventHandler(ctx)

    // Nothing was announced: progress is telemetry, so it must not invent a
    // live chip or a card of its own. The notice is consulted and left null
    // rather than being created as a pending one.
    dispatchValidEvent(
      handleEvent,
      progressEvent({ percent: 30, phase: 'analyzing' }),
    )
    expect(notices).toEqual([null])
    expect(compactionCards(getMessages())).toHaveLength(0)

    // A completed pass settles the notice, and its healthy card holds at 100%.
    dispatchValidEvent(handleEvent, compactionResultEvent())
    const settledNotice: CompactionNotice = {
      count: 1,
      action: 'semantic_compaction',
      degraded: false,
    }
    expect(notices.at(-1)).toEqual(settledNotice)
    expect(compactionCards(getMessages())[0]).toMatchObject({
      status: 'complete',
      progressPercent: 100,
      transient: true,
    })

    // A late progress event must not reopen the notice as live, and has no
    // pending card left to move.
    dispatchValidEvent(
      handleEvent,
      progressEvent({ percent: 70, phase: 'applying' }),
    )
    expect(notices.at(-1)).toEqual(settledNotice)
    const cards = compactionCards(getMessages())
    expect(cards).toHaveLength(1)
    expect(cards[0]).toMatchObject({
      status: 'complete',
      progressPercent: 100,
      transient: true,
    })
  })

  test('a healthy compaction result settles the card at 100% and marks it transient', () => {
    // Nothing here needs the user's attention: the bar visibly finishes and the
    // card is marked for self-dismissal so it never reaches the transcript.
    expect(
      settledCardFor({ compactionCount: 1, fitsBudget: true }),
    ).toMatchObject({
      status: 'complete',
      action: 'semantic_compaction',
      progressPercent: 100,
      transient: true,
    })
  })

  test('an emergency mechanical trim result is never marked transient', () => {
    const trimmed = settledCardFor({
      action: 'mechanical_trim',
      retainedKnowledgeMemory: false,
      recovery: 'Re-gather exact constraints.',
    })

    expect(trimmed).toMatchObject({
      status: 'complete',
      action: 'mechanical_trim',
    })
    // A degraded outcome stays in scrollback as a permanent warning card, so it
    // gets neither the self-dismissal flag nor a completed bar.
    expect(trimmed).not.toHaveProperty('transient')
    expect(trimmed).not.toHaveProperty('progressPercent')
    // Control: the same path with a healthy result does mark the card, so the
    // absence above is the degradation gate rather than a missing feature.
    expect(settledCardFor()).toMatchObject({
      progressPercent: 100,
      transient: true,
    })
  })

  test('a compaction result that does not fit the budget is never marked transient', () => {
    const overBudget = settledCardFor({
      fitsBudget: false,
      shortfallTokens: 12_400,
    })

    expect(overBudget).toMatchObject({
      status: 'complete',
      action: 'semantic_compaction',
      fitsBudget: false,
      shortfallTokens: 12_400,
    })
    // Still over budget is exactly what the user must act on.
    expect(overBudget).not.toHaveProperty('transient')
    expect(overBudget).not.toHaveProperty('progressPercent')
    expect(settledCardFor({ fitsBudget: true })).toMatchObject({
      progressPercent: 100,
      transient: true,
    })
  })

  test('a low-yield compaction streak is never marked transient', () => {
    const thrashing = settledCardFor({ consecutiveNoProgressCompactions: 2 })

    expect(thrashing).toMatchObject({
      status: 'complete',
      action: 'semantic_compaction',
      consecutiveNoProgressCompactions: 2,
    })
    // Compaction that stopped reclaiming space keeps its warning card.
    expect(thrashing).not.toHaveProperty('transient')
    expect(thrashing).not.toHaveProperty('progressPercent')
    // One low-yield pass is still below the streak threshold, so it settles as a
    // healthy transient card.
    expect(
      settledCardFor({ consecutiveNoProgressCompactions: 1 }),
    ).toMatchObject({
      progressPercent: 100,
      transient: true,
    })
  })

  test('handleFinish drops a transient compaction card and terminates a still-pending one', () => {
    const { ctx, getMessages } = createTestContext()
    const handleEvent = createEventHandler(ctx)

    // Two root passes in one turn: the first is still live, the second
    // completed healthily and is therefore transient.
    dispatchValidEvent(handleEvent, startedEvent('run-live'))
    dispatchValidEvent(handleEvent, startedEvent('run-done', 120_000))
    dispatchValidEvent(
      handleEvent,
      compactionResultEvent({ runId: 'run-done' }),
    )
    expect(
      compactionCards(getMessages()).map((card) => card.transient === true),
    ).toEqual([false, true])

    dispatchValidEvent(handleEvent, { type: 'finish', totalCost: 0 })

    const cards = compactionCards(getMessages())
    // The renderer only HIDES a self-dismissing card; the turn boundary is what
    // keeps it out of the persisted blocks, while the unfinished pass is
    // terminated rather than deleted.
    expect(cards).toHaveLength(1)
    expect(cards[0]).toMatchObject({
      status: 'interrupted',
      runId: 'run-live',
      beforeTokens: 152_000,
    })
    expect(cards[0]).not.toHaveProperty('liveSessionId')
  })

  test('a newly announced pass drops the previous transient card instead of stacking cards', () => {
    const { ctx, getMessages } = createTestContext()
    const handleEvent = createEventHandler(ctx)

    dispatchValidEvent(handleEvent, startedEvent('run-1'))
    dispatchValidEvent(handleEvent, compactionResultEvent({ runId: 'run-1' }))
    expect(compactionCards(getMessages())[0]).toMatchObject({
      status: 'complete',
      transient: true,
    })

    // The previous pass's card may still be inside its render hold, so the next
    // announced pass drops it rather than leaving it stacked underneath.
    dispatchValidEvent(handleEvent, startedEvent('run-2', 120_000))

    const cards = compactionCards(getMessages())
    expect(cards).toHaveLength(1)
    expect(cards[0]).toMatchObject({
      status: 'pending',
      runId: 'run-2',
      beforeTokens: 120_000,
      progressPercent: 0,
    })
  })
})
