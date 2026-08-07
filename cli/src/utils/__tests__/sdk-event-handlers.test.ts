import { describe, expect, test } from 'bun:test'

import { createMessageUpdater } from '../message-updater'
import {
  createEventHandler,
  createStreamChunkHandler,
} from '../sdk-event-handlers'

import type { ChatMessage } from '../../types/chat'
import type { EventHandlerState } from '../sdk-event-handlers'

import { printModeEventSchema } from '@codebuff/common/types/print-mode'
import type { Logger } from '@codebuff/common/types/contracts/logger'
import type {
  PrintModeEvent,
  PrintModeJobUpdate,
} from '@codebuff/common/types/print-mode'

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
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
    } as Logger,
    setIsRetrying: () => {},
  }

  return {
    ctx,
    getMessages: () => messages,
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
      toolName: 'apply_patch',
      input: {},
    })
    dispatchValidEvent(handleEvent, {
      type: 'tool_result',
      toolCallId: 'tool-2',
      toolName: 'apply_patch',
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
    const captured: { usage: { used: number; max: number } | null } = {
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

  test('keeps the last context usage after finish', () => {
    const captured: Array<{ used: number; max: number } | null> = []
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
    // Pins RF-1: the `queued === true` branch in `executeCustomToolCall` that
    // emits `tool_start` for a custom/MCP tool is genuinely reachable, not dead
    // defensive code. The CLI handler treats any queued tool_call identically
    // regardless of whether it was produced by the native (`executeToolCall`) or
    // custom (`executeCustomToolCall`) path, so a custom/unknown-path tool name
    // that lands queued must flip from 'queued' to 'running' on tool_start
    // exactly like a native write_file.
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
      before: { tokens: 190000, messages: 20, categories },
      after: { tokens: 120000, messages: 12, categories },
      removedCategories: ['toolResults', 'fileReads'],
      retainedKnowledgeMemory: false,
      recovery: 'Re-read exact files before editing.',
    })

    const text = getMessages()[0].blocks?.find(
      (block) => block.type === 'text' && block.content.includes('context'),
    )
    const content = String(text?.type === 'text' ? text.content : '')
    expect(text?.type).toBe('text')
    expect(content).toContain('190,000 → 120,000 tokens')
    expect(content).toContain('Resolved window: 200,000 tokens')
    expect(content).toContain('trigger budget: 176,000')
    expect(content).toContain('target budget: 176,000')
    expect(content).toContain(
      'Reason: Semantic compaction did not leave enough provider headroom.',
    )
    expect(content).toContain('Removed: toolResults, fileReads')
    expect(content).toContain('Retained knowledge memory: no')
  })
})
