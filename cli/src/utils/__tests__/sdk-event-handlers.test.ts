import { describe, expect, test } from 'bun:test'

import { createMessageUpdater } from '../message-updater'
import {
  createEventHandler,
  createStreamChunkHandler,
} from '../sdk-event-handlers'

import type { ChatMessage } from '../../types/chat'
import type { EventHandlerState } from '../sdk-event-handlers'
import type { Logger } from '@codebuff/common/types/contracts/logger'

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

  test('background agent cards remain running until polling reports settlement', () => {
    const { ctx, getMessages } = createTestContext()
    const handleEvent = createEventHandler(ctx)
    handleEvent({
      type: 'subagent_start',
      agentId: 'child-1',
      agentType: 'researcher-web',
      displayName: 'Researcher',
      parentAgentId: 'main-agent',
      spawnToolCallId: 'spawn-bg',
      spawnIndex: 0,
      prompt: 'research',
      onlyChild: true,
    } as any)
    handleEvent({
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
    } as any)
    expect(getMessages()[0].blocks?.[0]).toMatchObject({
      type: 'agent',
      status: 'running',
      backgroundJobId: 'bg-agent-1',
    })

    handleEvent({
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
    } as any)
    expect(getMessages()[0].blocks?.[0]).toMatchObject({
      type: 'agent',
      status: 'complete',
      backgroundJobId: 'bg-agent-1',
    })
  })

  test('[ERR-H01] terminal cancellation is immutable when a late result arrives', () => {
    const { ctx, getMessages } = createTestContext()
    const handleEvent = createEventHandler(ctx)
    handleEvent({
      type: 'tool_call',
      toolCallId: 'tool-1',
      toolName: 'read_files',
      input: { paths: ['a.ts'] },
    } as any)
    ctx.message.updater.updateAiMessageBlocks((blocks) =>
      blocks.map((block) =>
        block.type === 'tool'
          ? { ...block, lifecycle: 'cancelled' as const }
          : block,
      ),
    )
    handleEvent({
      type: 'tool_result',
      toolCallId: 'tool-1',
      toolName: 'read_files',
      output: [{ type: 'json', value: { ok: true } }],
    } as any)
    expect(getMessages()[0].blocks?.[0]).toMatchObject({
      type: 'tool',
      lifecycle: 'cancelled',
    })
  })

  test('[COR-H03] any error part makes the terminal tool lifecycle failed', () => {
    const { ctx, getMessages } = createTestContext()
    const handleEvent = createEventHandler(ctx)
    handleEvent({
      type: 'tool_call',
      toolCallId: 'tool-2',
      toolName: 'apply_patch',
      input: {},
    } as any)
    handleEvent({
      type: 'tool_result',
      toolCallId: 'tool-2',
      toolName: 'apply_patch',
      output: [
        { type: 'json', value: { applied: true } },
        { type: 'json', value: { errorMessage: 'post-commit report failed' } },
      ],
    } as any)
    expect(getMessages()[0].blocks?.[0]).toMatchObject({ lifecycle: 'failed' })
  })

  test('late canonical mutation result replaces cancellation with authoritative state', () => {
    const { ctx, getMessages } = createTestContext()
    const handleEvent = createEventHandler(ctx)
    handleEvent({
      type: 'tool_call',
      toolCallId: 'tool-late',
      toolName: 'write_file',
      input: { path: 'a.ts' },
    } as any)
    ctx.message.updater.updateAiMessageBlocks((blocks) =>
      blocks.map((block) =>
        block.type === 'tool'
          ? { ...block, lifecycle: 'cancelled' as const }
          : block,
      ),
    )
    handleEvent({
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
    } as any)
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
    handleEvent({
      type: 'tool_call',
      toolCallId: 'nested-tool-1',
      toolName: 'edit_transaction',
      input: { edits: [] },
      agentId: 'agent-1',
      parentAgentId: 'agent-1',
    } as any)
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
    handleEvent({
      type: 'tool_call',
      toolCallId: 'root-running-tool',
      toolName: 'read_files',
      input: { paths: ['a.ts'] },
    } as any)
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
    handleEvent({
      type: 'tool_call',
      toolCallId: 'term-bg',
      toolName: 'run_terminal_command',
      input: { command: 'npm run dev', process_type: 'BACKGROUND' },
    } as any)

    expect(getMessages()[0].blocks?.[0]).toMatchObject({
      type: 'tool',
      lifecycle: 'running',
    })
    expect(
      (getMessages()[0].blocks?.[0] as any).backgroundJobId,
    ).toBeUndefined()

    handleEvent({
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
    } as any)

    // Successful BACKGROUND start keeps the card running (not succeeded).
    expect(getMessages()[0].blocks?.[0]).toMatchObject({
      type: 'tool',
      backgroundJobId: 'job-bg',
      lifecycle: 'running',
    })

    handleEvent({
      type: 'job_update',
      jobId: 'job-bg',
      kind: 'process',
      state: 'running',
      sequence: 1,
      outputDelta: 'listening\n',
    } as any)
    handleEvent({
      type: 'job_update',
      jobId: 'job-bg',
      kind: 'process',
      state: 'completed',
      sequence: 2,
      exitCode: 0,
    } as any)

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
    handleEvent({
      type: 'tool_call',
      toolCallId: 'write-queued',
      toolName: 'write_file',
      input: { path: 'src/a.ts' },
      queued: true,
    } as any)

    expect(getMessages()[0].blocks?.[0]).toMatchObject({
      type: 'tool',
      queued: true,
      lifecycle: 'queued',
    })

    handleEvent({ type: 'tool_start', toolCallId: 'write-queued' })

    expect(getMessages()[0].blocks?.[0]).toMatchObject({
      type: 'tool',
      queued: false,
      lifecycle: 'running',
    })
  })

  test('job_update updates a correlated tool block lifecycle and appends bounded output', () => {
    const { ctx, getMessages } = createTestContext()
    const handleEvent = createEventHandler(ctx)
    handleEvent({
      type: 'tool_call',
      toolCallId: 'term-1',
      toolName: 'run_terminal_command',
      input: { command: 'npm test' },
    } as any)
    // Correlate the run_terminal_command card with a background job id.
    ctx.message.updater.updateAiMessageBlocks((blocks) =>
      blocks.map((block) =>
        block.type === 'tool' && block.toolCallId === 'term-1'
          ? { ...block, backgroundJobId: 'job-1' }
          : block,
      ),
    )

    handleEvent({
      type: 'job_update',
      jobId: 'job-1',
      kind: 'process',
      state: 'running',
      sequence: 1,
      outputDelta: 'first line\n',
    } as any)
    handleEvent({
      type: 'job_update',
      jobId: 'job-1',
      kind: 'process',
      state: 'running',
      sequence: 2,
      outputDelta: 'second line\n',
    } as any)

    let block = getMessages()[0].blocks?.[0] as any
    expect(block).toMatchObject({
      type: 'tool',
      lifecycle: 'running',
      output: 'first line\nsecond line\n',
    })

    handleEvent({
      type: 'job_update',
      jobId: 'job-1',
      kind: 'process',
      state: 'completed',
      sequence: 3,
      exitCode: 0,
    } as any)
    block = getMessages()[0].blocks?.[0] as any
    expect(block).toMatchObject({ lifecycle: 'succeeded' })
  })

  test('job_update caps the accumulated tool output at the tail ceiling', () => {
    const { ctx, getMessages } = createTestContext()
    const handleEvent = createEventHandler(ctx)
    handleEvent({
      type: 'tool_call',
      toolCallId: 'term-cap',
      toolName: 'run_terminal_command',
      input: { command: 'noisy' },
    } as any)
    ctx.message.updater.updateAiMessageBlocks((blocks) =>
      blocks.map((block) =>
        block.type === 'tool' && block.toolCallId === 'term-cap'
          ? { ...block, backgroundJobId: 'job-cap' }
          : block,
      ),
    )

    handleEvent({
      type: 'job_update',
      jobId: 'job-cap',
      kind: 'process',
      state: 'running',
      sequence: 1,
      outputDelta: 'A'.repeat(60_000),
    } as any)
    handleEvent({
      type: 'job_update',
      jobId: 'job-cap',
      kind: 'process',
      state: 'running',
      sequence: 2,
      outputDelta: 'B'.repeat(5_000),
    } as any)

    const block = getMessages()[0].blocks?.[0] as any
    expect(block.output.length).toBe(50_000)
    // The tail (most recent output) is retained.
    expect(block.output.endsWith('B'.repeat(5_000))).toBe(true)
  })

  test('job_update updates a correlated agent block status', () => {
    const { ctx, getMessages } = createTestContext()
    const handleEvent = createEventHandler(ctx)
    handleEvent({
      type: 'subagent_start',
      agentId: 'agent-1',
      agentType: 'researcher-web',
      displayName: 'Researcher',
      onlyChild: true,
    } as any)
    ctx.message.updater.updateAiMessageBlocks((blocks) =>
      blocks.map((block) =>
        block.type === 'agent' && block.agentId === 'agent-1'
          ? { ...block, backgroundJobId: 'job-agent' }
          : block,
      ),
    )

    handleEvent({
      type: 'job_update',
      jobId: 'job-agent',
      kind: 'agent',
      state: 'completed',
      sequence: 1,
    } as any)

    expect(getMessages()[0].blocks?.[0]).toMatchObject({
      type: 'agent',
      status: 'complete',
      backgroundJobId: 'job-agent',
    })
  })

  test('job_update is a no-op when no block correlates to the jobId', () => {
    const { ctx, getMessages } = createTestContext()
    const handleEvent = createEventHandler(ctx)
    handleEvent({
      type: 'tool_call',
      toolCallId: 'term-x',
      toolName: 'run_terminal_command',
      input: { command: 'ls' },
    } as any)
    const before = JSON.stringify(getMessages())

    handleEvent({
      type: 'job_update',
      jobId: 'unknown-job',
      kind: 'process',
      state: 'running',
      sequence: 1,
      outputDelta: 'foreign output',
    } as any)

    expect(JSON.stringify(getMessages())).toBe(before)
  })

  test('job_update surfaces a failed tool job error in the card output', () => {
    const { ctx, getMessages } = createTestContext()
    const handleEvent = createEventHandler(ctx)
    handleEvent({
      type: 'tool_call',
      toolCallId: 'term-err',
      toolName: 'run_terminal_command',
      input: { command: 'boom' },
    } as any)
    ctx.message.updater.updateAiMessageBlocks((blocks) =>
      blocks.map((block) =>
        block.type === 'tool' && block.toolCallId === 'term-err'
          ? { ...block, backgroundJobId: 'job-err' }
          : block,
      ),
    )

    handleEvent({
      type: 'job_update',
      jobId: 'job-err',
      kind: 'process',
      state: 'error',
      sequence: 1,
      outputDelta: 'partial output\n',
      error: 'command failed with exit code 1',
    } as any)

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
    handleEvent({
      type: 'tool_call',
      toolCallId: 'term-err-dup',
      toolName: 'run_terminal_command',
      input: { command: 'npm test' },
      backgroundJobId: 'job-err',
    } as any)

    handleEvent({
      type: 'job_update',
      jobId: 'job-err',
      kind: 'process',
      state: 'error',
      sequence: 1,
      error: 'boom',
    } as any)
    handleEvent({
      type: 'job_update',
      jobId: 'job-err',
      kind: 'process',
      state: 'error',
      sequence: 2,
      error: 'boom',
    } as any)

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
    handleEvent({
      type: 'tool_call',
      toolCallId: 'term-coincidental',
      toolName: 'run_terminal_command',
      input: { command: 'npm test' },
      backgroundJobId: 'job-coincidental',
    } as any)

    // Streamed output that coincidentally ends with the exact error text.
    handleEvent({
      type: 'job_update',
      jobId: 'job-coincidental',
      kind: 'process',
      state: 'running',
      sequence: 1,
      outputDelta: 'boom',
    } as any)
    // A genuinely new error carrying the same text; it must still be appended.
    handleEvent({
      type: 'job_update',
      jobId: 'job-coincidental',
      kind: 'process',
      state: 'error',
      sequence: 2,
      error: 'boom',
    } as any)

    const block = getMessages()[0].blocks?.[0] as any
    expect(block).toMatchObject({ type: 'tool', lifecycle: 'failed' })
    // Once from the streamed output, once from the appended error.
    expect((block.output.match(/boom/g) ?? []).length).toBe(2)
  })

  test('job_update appends a single error block to a failed agent job without duplicating', () => {
    const { ctx, getMessages } = createTestContext()
    const handleEvent = createEventHandler(ctx)
    handleEvent({
      type: 'subagent_start',
      agentId: 'agent-err',
      agentType: 'researcher-web',
      displayName: 'Researcher',
      onlyChild: true,
    } as any)
    ctx.message.updater.updateAiMessageBlocks((blocks) =>
      blocks.map((block) =>
        block.type === 'agent' && block.agentId === 'agent-err'
          ? { ...block, backgroundJobId: 'job-agent-err' }
          : block,
      ),
    )

    const errorEvent = {
      type: 'job_update',
      jobId: 'job-agent-err',
      kind: 'agent',
      state: 'error',
      sequence: 1,
      error: 'agent crashed',
    }
    handleEvent(errorEvent as any)
    handleEvent(errorEvent as any)

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
    handleEvent({
      type: 'subagent_start',
      agentId: 'agent-coincidental',
      agentType: 'researcher-web',
      displayName: 'Researcher',
      onlyChild: true,
    } as any)
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
    handleEvent({
      type: 'job_update',
      jobId: 'job-agent-coincidental',
      kind: 'agent',
      state: 'error',
      sequence: 1,
      error: 'agent crashed',
    } as any)

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
