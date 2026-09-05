import { TEST_USER_ID } from '@codebuff/common/old-constants'
import { createTestAgentRuntimeParams } from '@codebuff/common/testing/fixtures/agent-runtime'
import { getInitialSessionState } from '@codebuff/common/types/session-state'
import { promptSuccess } from '@codebuff/common/util/error'
import { assistantMessage, userMessage } from '@codebuff/common/util/messages'
import { afterEach, describe, expect, it, mock } from 'bun:test'
import z from 'zod/v4'

import contextPruner from '../../../../agents/context-pruner'
import thinker from '../../../../agents/thinker/thinker'
import { loopAgentSteps } from '../run-agent-step'
import { clearAgentGeneratorCache } from '../run-programmatic-step'
import { PLACEHOLDER } from '../templates/types'
import { handleSpawnAgentInline } from '../tools/handlers/tool/spawn-agent-inline'
import { countTokens } from '../util/token-counter'
import { commitTaskMemory } from '../util/task-memory'
import { createToolCallChunk, mockFileContext } from './test-utils'

import type { AgentTemplate } from '../templates/types'
import type { StepGenerator } from '@codebuff/common/types/agent-template'
import type { AgentState } from '@codebuff/common/types/session-state'

describe('loopAgentSteps', () => {
  let runtimeParams: Omit<
    ReturnType<typeof createTestAgentRuntimeParams>,
    'agentTemplate' | 'localAgentTemplates'
  >
  let agentTemplate: AgentTemplate
  let agentState: AgentState
  let baseParams: Parameters<typeof loopAgentSteps>[0]

  afterEach(() => {
    clearAgentGeneratorCache()
    mock.restore()
  })

  const setup = () => {
    const {
      agentTemplate: _,
      localAgentTemplates: __,
      ...baseRuntimeParams
    } = createTestAgentRuntimeParams()
    runtimeParams = baseRuntimeParams
    runtimeParams.promptAiSdkStream = mock(async function* () {
      yield { type: 'text' as const, text: 'LLM response\n\n' }
      yield createToolCallChunk('end_turn', {})
      return promptSuccess('mock-message-id')
    })

    agentTemplate = {
      id: 'test-agent',
      displayName: 'Test Agent',
      spawnerPrompt: 'Testing',
      model: 'claude-3-5-sonnet-20241022',
      inputSchema: {},
      outputMode: 'structured_output',
      includeMessageHistory: true,
      inheritParentSystemPrompt: false,
      mcpServers: {},
      toolNames: ['read_files', 'write_file', 'end_turn'],
      spawnableAgents: [],
      systemPrompt: 'Test system prompt',
      instructionsPrompt: 'Test user prompt',
      stepPrompt: 'Test agent step prompt',
      handleSteps: undefined,
    } satisfies AgentTemplate as AgentTemplate

    const sessionState = getInitialSessionState(mockFileContext)
    agentState = {
      ...sessionState.mainAgentState,
      agentId: 'test-agent-id',
      messageHistory: [
        userMessage('Initial message'),
        assistantMessage('Initial response'),
      ],
      output: undefined,
      stepsRemaining: 10,
    }

    baseParams = {
      ...runtimeParams,
      agentType: 'test-agent',
      localAgentTemplates: { 'test-agent': agentTemplate },
      repoId: undefined,
      repoUrl: undefined,
      userInputId: 'test-user-input',
      agentState,
      prompt: 'Test prompt',
      spawnParams: undefined,
      fingerprintId: 'test-fingerprint',
      fileContext: mockFileContext,
      userId: TEST_USER_ID,
      clientSessionId: 'test-session',
      ancestorRunIds: [],
      onResponseChunk: () => {},
      signal: new AbortController().signal,
    }
  }

  it('routes spawned subagent model requests by stable agent type', async () => {
    setup()
    let routedAgentId: string | undefined
    runtimeParams.promptAiSdkStream = mock(async function* ({ agentId }) {
      routedAgentId = agentId
      yield { type: 'text' as const, text: 'LLM response\n\n' }
      return promptSuccess('mock-message-id')
    })

    await loopAgentSteps({
      ...baseParams,
      promptAiSdkStream: runtimeParams.promptAiSdkStream,
      agentState: { ...agentState, agentId: 'generated-runtime-agent-id' },
    })

    expect(routedAgentId).toBe('test-agent')
  })

  it('calls the LLM once after STEP', async () => {
    setup()
    let llmCallCount = 0
    runtimeParams.promptAiSdkStream = mock(async function* () {
      llmCallCount++
      yield { type: 'text' as const, text: 'LLM response\n\n' }
      yield createToolCallChunk('end_turn', {})
      return promptSuccess('mock-message-id')
    })
    agentTemplate.handleSteps = function* () {
      yield { toolName: 'read_files', input: { paths: ['file1.txt'] } }
      yield 'STEP'
    } as () => StepGenerator

    await loopAgentSteps({
      ...baseParams,
      promptAiSdkStream: runtimeParams.promptAiSdkStream,
      localAgentTemplates: { 'test-agent': agentTemplate },
    })

    expect(llmCallCount).toBe(1)
  })

  it('retries a prompt-only structured agent that ends without set_output', async () => {
    setup()
    let llmCallCount = 0
    agentTemplate.handleSteps = undefined
    agentTemplate.toolNames = ['read_files']
    agentTemplate.outputSchema = z.object({ result: z.string() })
    runtimeParams.promptAiSdkStream = mock(async function* () {
      llmCallCount++
      if (llmCallCount === 1) {
        yield { type: 'text' as const, text: 'I finished the review.' }
      } else {
        yield createToolCallChunk('set_output', { result: 'reviewed' })
      }
      return promptSuccess(`mock-message-${llmCallCount}`)
    })

    const result = await loopAgentSteps({
      ...baseParams,
      promptAiSdkStream: runtimeParams.promptAiSdkStream,
      localAgentTemplates: { 'test-agent': agentTemplate },
    })

    expect(llmCallCount).toBe(2)
    expect(result.output).toEqual({
      type: 'structuredOutput',
      value: { result: 'reviewed' },
    })
  })

  // Regression: empty harvest after a set_output-only STEP must not clobber
  // a successful prior set_output (buffbench spawn LsHOhL5cwBo).
  it('preserves set_output when thinker harvest finds no plain assistant text', async () => {
    setup()
    let llmCallCount = 0
    agentTemplate.toolNames = ['read_files', 'set_output']
    agentTemplate.outputSchema = z.object({ message: z.string() })
    agentTemplate.handleSteps =
      thinker.handleSteps as AgentTemplate['handleSteps']
    runtimeParams.promptAiSdkStream = mock(async function* () {
      llmCallCount++
      // Model publishes only via set_output — no plain text outside the call.
      yield createToolCallChunk('set_output', { message: 'Good answer' })
      return promptSuccess('mock-message-id')
    })

    const result = await loopAgentSteps({
      ...baseParams,
      promptAiSdkStream: runtimeParams.promptAiSdkStream,
      localAgentTemplates: { 'test-agent': agentTemplate },
    })

    expect(llmCallCount).toBe(1)
    expect(result.output).toEqual({
      type: 'structuredOutput',
      value: { message: 'Good answer' },
    })
  })

  it('harvests thinker plain-text final answer into structured output', async () => {
    setup()
    let llmCallCount = 0
    agentTemplate.toolNames = ['read_files', 'set_output']
    agentTemplate.outputSchema = z.object({ message: z.string() })
    agentTemplate.handleSteps =
      thinker.handleSteps as AgentTemplate['handleSteps']
    runtimeParams.promptAiSdkStream = mock(async function* () {
      llmCallCount++
      yield {
        type: 'text' as const,
        text: '<think>brief reasoning</think>\nPlain text final answer',
      }
      return promptSuccess('mock-message-id')
    })

    const result = await loopAgentSteps({
      ...baseParams,
      promptAiSdkStream: runtimeParams.promptAiSdkStream,
      localAgentTemplates: { 'test-agent': agentTemplate },
    })

    expect(llmCallCount).toBe(1)
    expect(result.output).toEqual({
      type: 'structuredOutput',
      value: { message: 'Plain text final answer' },
    })
  })

  it('reports the resolved BYOK model context window before the LLM request', async () => {
    setup()
    const events: unknown[] = []
    const resolveModelContextWindow = mock(() => 32_000)

    const result = await loopAgentSteps({
      ...baseParams,
      resolveModelContextWindow,
      onResponseChunk: (event) => events.push(event),
    })

    expect(resolveModelContextWindow).toHaveBeenCalledWith({
      agentId: 'test-agent',
      model: 'claude-3-5-sonnet-20241022',
    })
    expect(events).toContainEqual({
      type: 'context_window',
      used: expect.any(Number),
      max: 32_000,
      // Model-aware semantic-compaction budget for this window, published so
      // the CLI status chip can show where compaction will fire.
      compactionTriggerTokens: 16_800,
      compactionTargetTokens: 8_400,
    })
    expect(result.agentState.contextWindowTokens).toBe(32_000)
  })

  it('forwards a request-time SDK trim as a context_request_trim event', async () => {
    setup()
    const events: any[] = []
    // The SDK reports the trim while the request is being dispatched, so the
    // callback has to be invoked from inside the generator body — a call made
    // outside it would never run.
    const promptAiSdkStream = mock(async function* (params) {
      params.onRequestContextTrimmed({
        contextWindowTokens: 32_000,
        messageBudgetTokens: 22_400,
        beforeTokens: 30_000,
        afterTokens: 12_000,
        beforeMessages: 6,
        afterMessages: 2,
        model: 'claude-3-5-sonnet-20241022',
      })
      yield { type: 'text' as const, text: 'LLM response\n\n' }
      yield createToolCallChunk('end_turn', {})
      return promptSuccess('mock-message-id')
    })

    await loopAgentSteps({
      ...baseParams,
      promptAiSdkStream,
      localAgentTemplates: { 'test-agent': agentTemplate },
      onResponseChunk: (event) => events.push(event),
    })

    // Reaching this trim means the runtime-owned brakes were already exceeded,
    // so it is published as its own event with the measurements untouched.
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'context_request_trim',
        // Root run: empty lineage, so root-level live UI may render it.
        ancestorRunIds: [],
        resolvedContextWindowTokens: 32_000,
        messageBudgetTokens: 22_400,
        beforeTokens: 30_000,
        afterTokens: 12_000,
        beforeMessages: 6,
        afterMessages: 2,
        model: 'claude-3-5-sonnet-20241022',
      }),
    )
    // The run id is minted by the runtime during the run rather than by this
    // fixture, so pin that it is present instead of a literal value.
    const trim = events.find((event) => event.type === 'context_request_trim')
    expect(typeof trim.runId).toBe('string')
    expect(trim.runId.length).toBeGreaterThan(0)
  })

  it('stamps a nested run lineage on the context_request_trim event', async () => {
    setup()
    const events: any[] = []
    // Same nested-lineage mechanism as the compaction lineage case: a non-empty
    // `ancestorRunIds` on the agent state entering the loop.
    agentState.ancestorRunIds = ['parent-run']
    const promptAiSdkStream = mock(async function* (params) {
      params.onRequestContextTrimmed({
        contextWindowTokens: 32_000,
        messageBudgetTokens: 22_400,
        beforeTokens: 30_000,
        afterTokens: 12_000,
        beforeMessages: 6,
        afterMessages: 2,
        model: 'claude-3-5-sonnet-20241022',
      })
      yield { type: 'text' as const, text: 'LLM response\n\n' }
      yield createToolCallChunk('end_turn', {})
      return promptSuccess('mock-message-id')
    })

    await loopAgentSteps({
      ...baseParams,
      agentState,
      promptAiSdkStream,
      localAgentTemplates: { 'test-agent': agentTemplate },
      onResponseChunk: (event) => events.push(event),
    })

    // `runId` and `ancestorRunIds` — not `agentId` — are the correlation keys a
    // consumer may rely on: subagent forwarding rewrites `agentId` at nesting
    // depth >= 2, so a nested trim must be identified by its lineage.
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'context_request_trim',
        ancestorRunIds: ['parent-run'],
        resolvedContextWindowTokens: 32_000,
        messageBudgetTokens: 22_400,
        beforeTokens: 30_000,
        afterTokens: 12_000,
        beforeMessages: 6,
        afterMessages: 2,
        model: 'claude-3-5-sonnet-20241022',
      }),
    )
    const trim = events.find((event) => event.type === 'context_request_trim')
    expect(typeof trim.runId).toBe('string')
    expect(trim.runId.length).toBeGreaterThan(0)
  })

  it('publishes the same compaction budget on context_window as on the compaction event', async () => {
    setup()
    const events: any[] = []
    agentState.messageHistory = [
      userMessage('small-window evidence '.repeat(8_000)),
      userMessage('Continue from the retained goal.'),
    ]
    agentTemplate.handleSteps =
      contextPruner.handleSteps as AgentTemplate['handleSteps']

    await loopAgentSteps({
      ...baseParams,
      agentState,
      resolveModelContextWindow: mock(() => 32_000),
      localAgentTemplates: { 'test-agent': agentTemplate },
      onResponseChunk: (event) => events.push(event),
    })

    // Same fixture and the same expected numbers as the semantic-compaction
    // case for a 32k window, so the reported status-line budget and the budget
    // the compaction branches actually used cannot drift.
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'context_compaction',
        action: 'semantic_compaction',
        triggerBudgetTokens: 16_800,
        targetBudgetTokens: 8_400,
      }),
    )
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'context_window',
        max: 32_000,
        compactionTriggerTokens: 16_800,
        compactionTargetTokens: 8_400,
      }),
    )
  })

  it('keeps the window-derived compaction trigger when maxContextLength clamps max below it', async () => {
    setup()
    const events: any[] = []

    await loopAgentSteps({
      ...baseParams,
      // The explicit override clamps the reported status window...
      maxContextLength: 50_000,
      spawnParams: { maxContextLength: 50_000 },
      resolveModelContextWindow: mock(() => 200_000),
      onResponseChunk: (event) => events.push(event),
    })

    // ...while the trigger/target stay derived from the RAW 200k model window,
    // because an override does not move the window-derived trigger. So a
    // published `compactionTriggerTokens` above `max` is expected, exactly as
    // printModeContextWindowSchema documents; a consumer that renders the two
    // together must clamp or suppress it itself.
    expect(events).toContainEqual({
      type: 'context_window',
      used: expect.any(Number),
      max: 50_000,
      compactionTriggerTokens: 140_000,
      compactionTargetTokens: 72_000,
    })
  })

  it('keeps the unknown-window fallback trigger above a small configured window', async () => {
    setup()
    const events: any[] = []

    await loopAgentSteps({
      ...baseParams,
      // No resolveModelContextWindow: the window is unknown, so the budgets are
      // the conservative 140k/100k fallback rather than anything derived from
      // the configured ceiling reported as `max`.
      maxContextLength: 50_000,
      spawnParams: { maxContextLength: 50_000 },
      onResponseChunk: (event) => events.push(event),
    })

    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'context_window',
        max: 50_000,
        compactionTriggerTokens: 140_000,
        compactionTargetTokens: 100_000,
      }),
    )
  })

  it('runs semantic programmatic compaction before the mechanical brake', async () => {
    setup()
    const events: any[] = []
    const checkpoints: string[] = []
    agentState.messageHistory = [
      userMessage(
        'Initial implementation request ' + 'old evidence '.repeat(20_000),
      ),
      assistantMessage('I will inspect the relevant files.'),
      {
        role: 'assistant',
        content: [
          {
            type: 'tool-call',
            toolCallId: 'read-call',
            toolName: 'read_files',
            input: { paths: ['src/live-context.ts'] },
          },
        ],
      },
      {
        role: 'tool',
        toolCallId: 'read-call',
        toolName: 'read_files',
        content: [
          {
            type: 'json',
            value: {
              kind: 'read_files_result',
              version: 1,
              status: 'ok',
              summary: { requested: 1, ok: 1, partial: 0, failed: 0 },
              results: [
                {
                  selector: 'file',
                  requestIndex: 0,
                  path: 'src/live-context.ts',
                  status: 'ok',
                  content: 'export const liveContext = true',
                  complete: true,
                  template: false,
                },
              ],
            },
          },
        ],
      },
      userMessage('Continue with the implementation.'),
    ]
    agentTemplate.handleSteps =
      contextPruner.handleSteps as AgentTemplate['handleSteps']

    const result = await loopAgentSteps({
      ...baseParams,
      agentState,
      // Keep the explicit provider-safe ceiling above the system/tool baseline
      // so this case isolates semantic compaction rather than intentionally
      // exercising the later mechanical emergency brake.
      maxContextLength: 50_000,
      spawnParams: { maxContextLength: 50_000 },
      localAgentTemplates: { 'test-agent': agentTemplate },
      onResponseChunk: (event) => events.push(event),
      onCheckpoint: (state) =>
        checkpoints.push(JSON.stringify(state.messageHistory)),
    })

    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'context_compaction',
        action: 'semantic_compaction',
        triggerBudgetTokens: 140_000,
        targetBudgetTokens: 100_000,
        reason: expect.stringContaining('explicit maxContextLength override'),
        retainedKnowledgeMemory: true,
        // First compaction of the turn, and it reclaimed space.
        compactionCount: 1,
        consecutiveNoProgressCompactions: 0,
      }),
    )
    expect(events).not.toContainEqual(
      expect.objectContaining({
        type: 'context_compaction',
        action: 'mechanical_trim',
      }),
    )
    const compactedHistory = JSON.stringify(result.agentState.messageHistory)
    expect(compactedHistory).toContain('<knowledge_memory>')
    expect(compactedHistory).toContain('Files Inspected:')
    expect(compactedHistory).toContain('src/live-context.ts')
    expect(
      checkpoints.some((checkpoint) =>
        checkpoint.includes('<knowledge_memory>'),
      ),
    ).toBe(true)
  })

  it('does not report below-trigger semantic reductions as context compaction', async () => {
    setup()
    const events: any[] = []
    agentState.messageHistory = [userMessage('old evidence '.repeat(4_000))]
    agentTemplate.handleSteps = function* () {
      yield {
        toolName: 'set_messages',
        input: {
          messages: [
            userMessage(
              '<knowledge_memory>\nPinned structured knowledge memory.\nGoal: preserve discovery and resume\n</knowledge_memory>',
            ),
          ],
        },
        includeToolCall: false,
      }
      yield 'STEP'
    } as () => StepGenerator

    const result = await loopAgentSteps({
      ...baseParams,
      agentState,
      resolveModelContextWindow: mock(() => 1_000_000),
      localAgentTemplates: { 'test-agent': agentTemplate },
      onResponseChunk: (event) => events.push(event),
    })

    expect(events).not.toContainEqual(
      expect.objectContaining({
        type: 'context_compaction',
        action: 'semantic_compaction',
      }),
    )
    expect(JSON.stringify(result.agentState.messageHistory)).toContain(
      '<knowledge_memory>',
    )
  })

  it('uses the injected small-model semantic budget before the first request', async () => {
    setup()
    const events: any[] = []
    agentState.messageHistory = [
      userMessage('small-window evidence '.repeat(8_000)),
      userMessage('Continue from the retained goal.'),
    ]
    agentTemplate.handleSteps =
      contextPruner.handleSteps as AgentTemplate['handleSteps']

    await loopAgentSteps({
      ...baseParams,
      agentState,
      resolveModelContextWindow: mock(() => 32_000),
      localAgentTemplates: { 'test-agent': agentTemplate },
      onResponseChunk: (event) => events.push(event),
    })

    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'context_compaction',
        action: 'semantic_compaction',
        resolvedContextWindowTokens: 32_000,
        triggerBudgetTokens: 16_800,
        targetBudgetTokens: 8_400,
        retainedKnowledgeMemory: true,
        // The result carries the run correlation, so a consumer can pair it
        // with the live status card this run opened. Root run: empty lineage.
        // `agentId` is asserted as the EMITTER's id at the producer boundary;
        // subagent forwarding may rewrite it downstream, which is why `runId`
        // is the documented per-agent key.
        runId: expect.any(String),
        agentId: 'test-agent-id',
        ancestorRunIds: [],
      }),
    )
  })

  // The runtime is the producer of `context_compaction_status`. The next cases
  // pin that contract: exactly one run-correlated started/settled pair per
  // announced pass, a settle for a pass that declines to compact, exactly one
  // settle when the programmatic step throws, and a lineage that identifies
  // nested runs.
  it('emits exactly one run-correlated compaction status pair for an announced pass', async () => {
    setup()
    const events: any[] = []
    agentState.messageHistory = [
      userMessage('small-window evidence '.repeat(8_000)),
      userMessage('Continue from the retained goal.'),
    ]
    agentTemplate.handleSteps =
      contextPruner.handleSteps as AgentTemplate['handleSteps']

    await loopAgentSteps({
      ...baseParams,
      agentState,
      resolveModelContextWindow: mock(() => 32_000),
      localAgentTemplates: { 'test-agent': agentTemplate },
      onResponseChunk: (event) => events.push(event),
    })

    const statusEvents = events.filter(
      (event) => event.type === 'context_compaction_status',
    )
    const started = statusEvents.filter((event) => event.state === 'started')
    const settled = statusEvents.filter((event) => event.state === 'settled')
    expect(started).toHaveLength(1)
    expect(settled).toHaveLength(1)
    // The pass is announced before the programmatic step and settled after the
    // compaction branches, never the other way round.
    expect(events.indexOf(started[0])).toBeLessThan(events.indexOf(settled[0]))

    // Both halves of the pair share one run correlation, so a consumer can
    // clear exactly the card this run opened.
    const runId = started[0].runId
    expect(typeof runId).toBe('string')
    expect(runId.length).toBeGreaterThan(0)
    expect(started[0]).toMatchObject({
      runId,
      agentId: 'test-agent-id',
      // Root run: empty lineage, so root-level live UI may render it.
      ancestorRunIds: [],
      contextTokens: expect.any(Number),
      resolvedContextWindowTokens: 32_000,
      triggerBudgetTokens: 16_800,
      targetBudgetTokens: 8_400,
    })
    expect(settled[0]).toMatchObject({
      runId,
      agentId: 'test-agent-id',
      ancestorRunIds: [],
    })

    // The reported result is correlated to the same run as the status pair.
    expect(
      events.find(
        (event) =>
          event.type === 'context_compaction' &&
          event.action === 'semantic_compaction',
      ),
    ).toMatchObject({ runId, agentId: 'test-agent-id', ancestorRunIds: [] })
  })

  it('settles the compaction status when a pass declines to compact', async () => {
    setup()
    const events: any[] = []
    // A 64k window puts the semantic trigger at 39,200 tokens and the
    // provider-safe mechanical ceiling at 56,000. Sizing the transcript with the
    // live tokenizer lands the request inside that band, so the loop announces a
    // pass while neither the semantic branch nor the mechanical brake reports a
    // result.
    const chunk = 'old evidence '.repeat(500)
    const chunkTokens = countTokens(chunk)
    agentState.messageHistory = [
      userMessage(chunk.repeat(Math.ceil(42_000 / chunkTokens))),
    ]
    // A step that yields straight to the model never rewrites the transcript, so
    // this announced pass compacts nothing.
    agentTemplate.handleSteps = function* () {
      yield 'STEP'
    } as () => StepGenerator

    await loopAgentSteps({
      ...baseParams,
      agentState,
      resolveModelContextWindow: mock(() => 64_000),
      localAgentTemplates: { 'test-agent': agentTemplate },
      onResponseChunk: (event) => events.push(event),
    })

    // No compaction was reported at all, yet the announced pass is still
    // settled: a pending UI state can never be left stuck when the pruner
    // declines to compact.
    expect(
      events.filter((event) => event.type === 'context_compaction'),
    ).toHaveLength(0)
    const statusEvents = events.filter(
      (event) => event.type === 'context_compaction_status',
    )
    // A `yield 'STEP'` generator drives more than one loop iteration, and every
    // over-trigger iteration announces and settles its own pass. The invariant
    // is therefore one settle per announced pass rather than exactly one pass.
    const started = statusEvents.filter((event) => event.state === 'started')
    const settled = statusEvents.filter((event) => event.state === 'settled')
    expect(started.length).toBeGreaterThanOrEqual(1)
    expect(settled.length).toBe(started.length)
    // No announced pass is left dangling: the run ends on a settle.
    expect(statusEvents.at(-1)).toMatchObject({ state: 'settled' })
    expect(started[0]).toMatchObject({
      state: 'started',
      runId: expect.any(String),
      agentId: 'test-agent-id',
      ancestorRunIds: [],
      resolvedContextWindowTokens: 64_000,
      triggerBudgetTokens: 39_200,
      targetBudgetTokens: 19_600,
    })
  })

  it('settles the compaction status exactly once when the programmatic step throws', async () => {
    setup()
    const events: any[] = []
    agentState.messageHistory = [
      userMessage('small-window evidence '.repeat(8_000)),
      userMessage('Continue from the retained goal.'),
    ]
    // `started` is emitted before the programmatic step runs. The generator
    // error is caught by `runProgrammaticStep`, so which settle point wins (the
    // in-loop settle after the compaction branches, or the outer `finally`) is
    // not part of the contract; the contract is exactly one settle per
    // announced pass, and never a dangling pending pass.
    agentTemplate.handleSteps = function* () {
      throw new Error('programmatic step exploded')
    } as () => StepGenerator

    // The failure may surface as a rejection or as an error-shaped result;
    // neither is part of this contract, so assert on the emitted events only.
    await loopAgentSteps({
      ...baseParams,
      agentState,
      resolveModelContextWindow: mock(() => 32_000),
      localAgentTemplates: { 'test-agent': agentTemplate },
      onResponseChunk: (event) => events.push(event),
    }).catch(() => undefined)

    const statusEvents = events.filter(
      (event) => event.type === 'context_compaction_status',
    )
    expect(
      statusEvents.filter((event) => event.state === 'started'),
    ).toHaveLength(1)
    // Settling is idempotent, so a second settle here would be a real
    // regression rather than a harmless duplicate.
    expect(
      statusEvents.filter((event) => event.state === 'settled'),
    ).toHaveLength(1)
  })

  it('stamps a nested run lineage on compaction status and result events', async () => {
    setup()
    const events: any[] = []
    agentState.messageHistory = [
      userMessage('small-window evidence '.repeat(8_000)),
      userMessage('Continue from the retained goal.'),
    ]
    // A nested agent loop: its lineage is non-empty, so a consumer that renders
    // root-level live UI must be able to tell it apart from a root run.
    agentState.ancestorRunIds = ['parent-run']
    agentTemplate.handleSteps =
      contextPruner.handleSteps as AgentTemplate['handleSteps']

    await loopAgentSteps({
      ...baseParams,
      agentState,
      resolveModelContextWindow: mock(() => 32_000),
      localAgentTemplates: { 'test-agent': agentTemplate },
      onResponseChunk: (event) => events.push(event),
    })

    const statusEvents = events.filter(
      (event) => event.type === 'context_compaction_status',
    )
    const started = statusEvents.filter((event) => event.state === 'started')
    const settled = statusEvents.filter((event) => event.state === 'settled')
    expect(started).toHaveLength(1)
    expect(settled).toHaveLength(1)
    const runId = started[0].runId
    expect(typeof runId).toBe('string')
    expect(runId.length).toBeGreaterThan(0)
    expect(started[0]).toMatchObject({
      runId,
      agentId: 'test-agent-id',
      ancestorRunIds: ['parent-run'],
    })
    expect(settled[0]).toMatchObject({
      runId,
      agentId: 'test-agent-id',
      ancestorRunIds: ['parent-run'],
    })
    expect(
      events.find((event) => event.type === 'context_compaction'),
    ).toMatchObject({
      runId,
      agentId: 'test-agent-id',
      ancestorRunIds: ['parent-run'],
    })
  })

  // `context_compaction_progress` is best-effort telemetry emitted from
  // deterministic milestones INSIDE an announced pass. The next cases pin the
  // two invariants a consumer relies on: percents never rewind, and no emission
  // ever falls outside a started/settled pair of the same run.
  it('emits monotonic compaction progress strictly inside an announced pass', async () => {
    setup()
    const events: any[] = []
    agentState.messageHistory = [
      userMessage('small-window evidence '.repeat(8_000)),
      userMessage('Continue from the retained goal.'),
    ]
    agentTemplate.handleSteps =
      contextPruner.handleSteps as AgentTemplate['handleSteps']

    await loopAgentSteps({
      ...baseParams,
      agentState,
      resolveModelContextWindow: mock(() => 32_000),
      localAgentTemplates: { 'test-agent': agentTemplate },
      onResponseChunk: (event) => events.push(event),
    })

    const statusEvents = events.filter(
      (event) => event.type === 'context_compaction_status',
    )
    const started = statusEvents.find((event) => event.state === 'started')
    const settled = statusEvents.find((event) => event.state === 'settled')
    expect(started).toBeDefined()
    expect(settled).toBeDefined()

    const progress = events.filter(
      (event) => event.type === 'context_compaction_progress',
    )
    // Both deterministic milestones: analysis as soon as the pass is announced,
    // application once the step that owns the pruner has returned.
    expect(progress.length).toBeGreaterThanOrEqual(2)
    expect(progress[0]).toMatchObject({
      phase: 'analyzing',
      percent: 20,
      runId: started.runId,
      agentId: 'test-agent-id',
      ancestorRunIds: [],
      contextTokens: expect.any(Number),
      targetBudgetTokens: 8_400,
    })
    expect(progress.at(-1)).toMatchObject({ phase: 'applying', percent: 90 })

    const startedIndex = events.indexOf(started)
    const settledIndex = events.indexOf(settled)
    let previousPercent = 0
    for (const event of progress) {
      const index = events.indexOf(event)
      expect(index).toBeGreaterThan(startedIndex)
      expect(index).toBeLessThan(settledIndex)
      expect(event.runId).toBe(started.runId)
      expect(event.percent).toBeGreaterThanOrEqual(previousPercent)
      expect(event.percent).toBeLessThanOrEqual(100)
      previousPercent = event.percent
    }
  })

  it('emits no compaction progress for an iteration that announces no pass', async () => {
    setup()
    const events: any[] = []
    // A huge window keeps the request below the semantic trigger, so nothing is
    // announced and a consumer must see no progress for a pass that never ran.
    agentState.messageHistory = [userMessage('old evidence '.repeat(4_000))]
    agentTemplate.handleSteps = function* () {
      yield {
        toolName: 'set_messages',
        input: {
          messages: [
            userMessage(
              '<knowledge_memory>\nPinned structured knowledge memory.\n</knowledge_memory>',
            ),
          ],
        },
        includeToolCall: false,
      }
      yield 'STEP'
    } as () => StepGenerator

    await loopAgentSteps({
      ...baseParams,
      agentState,
      resolveModelContextWindow: mock(() => 1_000_000),
      localAgentTemplates: { 'test-agent': agentTemplate },
      onResponseChunk: (event) => events.push(event),
    })

    expect(
      events.filter((event) => event.type === 'context_compaction_status'),
    ).toHaveLength(0)
    expect(
      events.filter((event) => event.type === 'context_compaction_progress'),
    ).toHaveLength(0)
  })

  it('emits a recovery-rich event when emergency mechanical trim is required', async () => {
    setup()
    const events: any[] = []
    agentState.messageHistory = [
      userMessage('old constraints '.repeat(4_000)),
      assistantMessage('old implementation evidence '.repeat(4_000)),
      userMessage('latest request'),
    ]

    const result = await loopAgentSteps({
      ...baseParams,
      agentState,
      maxContextLength: 2_000,
      onResponseChunk: (event) => events.push(event),
    })

    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'context_compaction',
        action: 'mechanical_trim',
        triggerBudgetTokens: 2_000,
        targetBudgetTokens: 2_000,
        reason: expect.stringContaining('provider-safe request budget'),
        retainedKnowledgeMemory: false,
        compactionCount: 1,
        consecutiveNoProgressCompactions: 0,
        // A 2k ceiling is below the system+tools baseline, so the trimmed
        // request cannot fit: the event must say so instead of claiming a
        // clean recovery.
        fitsBudget: false,
        shortfallTokens: expect.any(Number),
        escalated: expect.any(Boolean),
        recovery: expect.stringContaining(
          'may still exceed the provider budget',
        ),
      }),
    )
    expect(JSON.stringify(result.agentState.messageHistory)).toContain(
      '<mechanical_context_recovery>',
    )
  })

  it('reports compaction thrash in the reason after two unproductive compactions', async () => {
    setup()
    const events: any[] = []
    const warn = mock((_data?: unknown, _message?: string) => {})
    agentState.messageHistory = [
      userMessage('old constraints '.repeat(2_000)),
      assistantMessage('old evidence '.repeat(2_000)),
    ]
    // Keep the loop iterating so the mechanical brake runs repeatedly on an
    // already-minimal history; each pass reclaims essentially nothing.
    agentTemplate.handleSteps = function* () {
      yield 'STEP'
      yield 'STEP'
      yield 'STEP'
      yield 'STEP'
    } as () => StepGenerator

    await loopAgentSteps({
      ...baseParams,
      agentState,
      logger: { ...baseParams.logger, warn },
      maxContextLength: 2_000,
      localAgentTemplates: { 'test-agent': agentTemplate },
      onResponseChunk: (event) => events.push(event),
    })

    const compactionEvents = events.filter(
      (event) => event.type === 'context_compaction',
    )
    expect(compactionEvents.length).toBeGreaterThanOrEqual(3)
    expect(compactionEvents[0].compactionCount).toBe(1)
    expect(compactionEvents[0].consecutiveNoProgressCompactions).toBe(0)
    expect(compactionEvents[0].reason).not.toContain(
      'Compaction is not reclaiming space',
    )

    const thrashEvent = compactionEvents.find(
      (event) => event.consecutiveNoProgressCompactions >= 2,
    )
    expect(thrashEvent).toBeDefined()
    expect(thrashEvent.reason).toContain(
      'Compaction is not reclaiming space: 2 consecutive compactions reclaimed under 5%.',
    )
    expect(
      warn.mock.calls.filter(
        (call) =>
          typeof call[1] === 'string' &&
          call[1].includes('Compaction is not reclaiming context space'),
      ),
    ).toHaveLength(1)
  })

  // Anti-thrash remediation. A 64k window puts the semantic trigger at 39,200
  // tokens and the provider-safe mechanical ceiling at 56,000, so a ~42k
  // transcript announces an over-trigger semantic pass while the mechanical
  // brake stays out of the way. The generator yields straight to the model, so
  // every announced pass returns the transcript completely unchanged — the
  // actual thrash case.
  const seedZeroReclaimAnnouncedPasses = () => {
    const chunk = 'old evidence '.repeat(500)
    const chunkTokens = countTokens(chunk)
    agentState.messageHistory = [
      userMessage(chunk.repeat(Math.ceil(42_000 / chunkTokens))),
    ]
    agentTemplate.handleSteps = function* () {
      yield 'STEP'
      yield 'STEP'
    } as () => StepGenerator
  }

  it('does not report an announced semantic pass that reclaimed nothing as a compaction', async () => {
    setup()
    const events: any[] = []
    seedZeroReclaimAnnouncedPasses()

    await loopAgentSteps({
      ...baseParams,
      agentState,
      resolveModelContextWindow: mock(() => 64_000),
      localAgentTemplates: { 'test-agent': agentTemplate },
      onResponseChunk: (event) => events.push(event),
    })

    // A `yield 'STEP'` generator drives more than one loop iteration, and every
    // over-trigger iteration announces and settles its own pass, so assert the
    // settled-equals-started invariant rather than a hard total.
    const statusEvents = events.filter(
      (event) => event.type === 'context_compaction_status',
    )
    const started = statusEvents.filter((event) => event.state === 'started')
    const settled = statusEvents.filter((event) => event.state === 'settled')
    expect(started.length).toBeGreaterThanOrEqual(2)
    expect(settled.length).toBe(started.length)

    // Nothing was compacted, so no result event may be reported...
    expect(
      events.filter((event) => event.type === 'context_compaction'),
    ).toHaveLength(0)
    // ...and the shipped `compactionCount` must not have been incremented for
    // a pass that never compacted.
    expect(
      events.some((event) => typeof event.compactionCount === 'number'),
    ).toBe(false)
  })

  it('suppresses further semantic compaction after two zero-reclaim announced passes', async () => {
    setup()
    seedZeroReclaimAnnouncedPasses()

    const result = await loopAgentSteps({
      ...baseParams,
      agentState,
      resolveModelContextWindow: mock(() => 64_000),
      localAgentTemplates: { 'test-agent': agentTemplate },
    })

    expect(result.agentState.suppressSemanticCompaction).toBe(true)
  })

  it('emits compaction progress only while an announced pass is unsettled', async () => {
    setup()
    const events: any[] = []
    // The suppression fixture drives several over-trigger iterations, only the
    // first two of which announce a pass. Every later (suppressed) iteration
    // must contribute no progress at all.
    seedZeroReclaimAnnouncedPasses()

    await loopAgentSteps({
      ...baseParams,
      agentState,
      resolveModelContextWindow: mock(() => 64_000),
      localAgentTemplates: { 'test-agent': agentTemplate },
      onResponseChunk: (event) => events.push(event),
    })

    const started = events.filter(
      (event) =>
        event.type === 'context_compaction_status' && event.state === 'started',
    )
    expect(started.length).toBeGreaterThanOrEqual(2)

    // Walk the stream: a progress event may only appear while an announced pass
    // of the SAME run is still unsettled.
    const liveRunIds = new Set<string>()
    let progressCount = 0
    for (const event of events) {
      if (event.type === 'context_compaction_status') {
        if (event.state === 'started') liveRunIds.add(event.runId)
        else liveRunIds.delete(event.runId)
        continue
      }
      if (event.type !== 'context_compaction_progress') continue
      progressCount++
      expect(liveRunIds.has(event.runId)).toBe(true)
    }
    expect(progressCount).toBeGreaterThanOrEqual(started.length)
  })

  it('leaves semantic compaction unsuppressed when a pass genuinely shrinks history', async () => {
    setup()
    const events: any[] = []
    agentState.messageHistory = [
      userMessage('small-window evidence '.repeat(8_000)),
      userMessage('Continue from the retained goal.'),
    ]
    agentTemplate.handleSteps =
      contextPruner.handleSteps as AgentTemplate['handleSteps']

    const result = await loopAgentSteps({
      ...baseParams,
      agentState,
      resolveModelContextWindow: mock(() => 32_000),
      localAgentTemplates: { 'test-agent': agentTemplate },
      onResponseChunk: (event) => events.push(event),
    })

    // A productive pass must never trip the anti-thrash brake: consecutive
    // post-compaction sizes are flat by construction in a healthy long run, so
    // gating on them would suppress compaction here.
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'context_compaction',
        action: 'semantic_compaction',
      }),
    )
    expect(result.agentState.suppressSemanticCompaction).toBeFalsy()
  })

  it('resets suppressSemanticCompaction at loop entry', async () => {
    setup()
    // No handleSteps and a small transcript: this loop announces no semantic
    // pass at all, so nothing in it could legitimately set the advisory. A
    // stale `true` persisted from an earlier turn must not survive into this
    // one and permanently disable semantic compaction.
    const result = await loopAgentSteps({
      ...baseParams,
      agentState: { ...agentState, suppressSemanticCompaction: true },
      promptAiSdkStream: runtimeParams.promptAiSdkStream,
      localAgentTemplates: { 'test-agent': agentTemplate },
    })

    expect(result.agentState.suppressSemanticCompaction).not.toBe(true)
  })

  // Runtime-driven semantic compaction: a prompt-only template (no
  // `handleSteps` generator to spawn the pruner itself) must still get a
  // semantic pass. The pruner is stubbed through `localAgentTemplates` so the
  // pass is deterministic and needs no live LLM. `id` defaults to the bare
  // `context-pruner`; pass a publisher/version-qualified id to stub a pruner a
  // consumer declared with a pin.
  const buildPrunerStub = (
    handleSteps: AgentTemplate['handleSteps'],
    maxSpawnDepth?: number,
    id = 'context-pruner',
  ): AgentTemplate =>
    ({
      id,
      displayName: 'Context Pruner',
      spawnerPrompt: 'Prune context',
      model: 'claude-3-5-sonnet-20241022',
      inputSchema: {},
      outputMode: 'last_message',
      includeMessageHistory: true,
      messageHistoryMode: 'full',
      inheritParentSystemPrompt: true,
      propagateMessageHistoryChanges: true,
      mcpServers: {},
      toolNames: ['read_files', 'write_file', 'end_turn'],
      spawnableAgents: [],
      systemPrompt: '',
      instructionsPrompt: '',
      stepPrompt: '',
      handleSteps,
      ...(maxSpawnDepth === undefined ? {} : { maxSpawnDepth }),
    }) satisfies AgentTemplate as AgentTemplate

  // A 64k window puts the semantic trigger at 39,200 tokens and the
  // provider-safe mechanical ceiling at 56,000, so a ~42k transcript announces
  // an over-trigger semantic pass while the mechanical emergency brake stays
  // out of the way — the runtime-driven pass is what these cases measure.
  const seedPromptOnlyOverTriggerRun = () => {
    agentTemplate.handleSteps = undefined
    // The runtime-driven pass honors the same spawn-permission contract as the
    // generator-driven inline pruner, so the parent template must declare
    // `context-pruner` for the pass to be paid for at all.
    agentTemplate.spawnableAgents = ['context-pruner']
    const chunk = 'old evidence '.repeat(500)
    const chunkTokens = countTokens(chunk)
    agentState.messageHistory = [
      userMessage(chunk.repeat(Math.ceil(42_000 / chunkTokens))),
    ]
  }

  const retainedMemoryTranscript = () => [
    userMessage(
      '<knowledge_memory>\nPinned structured knowledge memory.\nGoal: preserve discovery and resume\n</knowledge_memory>',
    ),
    userMessage('Continue from the retained goal.'),
  ]

  it('announces and settles a runtime-driven semantic pass for a prompt-only template', async () => {
    setup()
    const events: any[] = []
    seedPromptOnlyOverTriggerRun()
    let prunerRuns = 0
    const contextPruner = buildPrunerStub(function* () {
      prunerRuns++
      yield {
        toolName: 'set_messages',
        input: { messages: retainedMemoryTranscript() },
        includeToolCall: false,
      }
    } as () => StepGenerator)

    await loopAgentSteps({
      ...baseParams,
      agentState,
      resolveModelContextWindow: mock(() => 64_000),
      localAgentTemplates: {
        'test-agent': agentTemplate,
        'context-pruner': contextPruner,
      },
      onResponseChunk: (event) => events.push(event),
    })

    // The runtime drove the pruner even though the template has no generator.
    expect(prunerRuns).toBe(1)
    const statusEvents = events.filter(
      (event) => event.type === 'context_compaction_status',
    )
    const started = statusEvents.filter((event) => event.state === 'started')
    const settled = statusEvents.filter((event) => event.state === 'settled')
    expect(started).toHaveLength(1)
    expect(settled).toHaveLength(1)
    expect(events.indexOf(started[0])).toBeLessThan(events.indexOf(settled[0]))
    const runId = started[0].runId
    expect(typeof runId).toBe('string')
    expect(started[0]).toMatchObject({
      runId,
      agentId: 'test-agent-id',
      ancestorRunIds: [],
      resolvedContextWindowTokens: 64_000,
      triggerBudgetTokens: 39_200,
      targetBudgetTokens: 19_600,
    })
    expect(settled[0]).toMatchObject({
      runId,
      agentId: 'test-agent-id',
      ancestorRunIds: [],
    })
  })

  it('reports semantic_compaction when the runtime-driven pruner shrinks history', async () => {
    setup()
    const events: any[] = []
    seedPromptOnlyOverTriggerRun()
    const contextPruner = buildPrunerStub(function* () {
      yield {
        toolName: 'set_messages',
        input: { messages: retainedMemoryTranscript() },
        includeToolCall: false,
      }
    } as () => StepGenerator)

    const result = await loopAgentSteps({
      ...baseParams,
      agentState,
      resolveModelContextWindow: mock(() => 64_000),
      localAgentTemplates: {
        'test-agent': agentTemplate,
        'context-pruner': contextPruner,
      },
      onResponseChunk: (event) => events.push(event),
    })

    // The reporting branch needs a retained <knowledge_memory> block, which the
    // replacement transcript carries, so the pass is visible rather than silent.
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'context_compaction',
        action: 'semantic_compaction',
        resolvedContextWindowTokens: 64_000,
        retainedKnowledgeMemory: true,
        compactionCount: 1,
        consecutiveNoProgressCompactions: 0,
      }),
    )
    expect(JSON.stringify(result.agentState.messageHistory)).toContain(
      '<knowledge_memory>',
    )
  })

  it('stops invoking the runtime-driven pruner once semantic compaction is suppressed', async () => {
    setup()
    const events: any[] = []
    seedPromptOnlyOverTriggerRun()
    // A pruner that returns without rewriting the transcript reclaims nothing,
    // so the loop-owned `suppressSemanticCompaction` advisory trips after two
    // unproductive passes and no further pruner call may be paid for this turn.
    let prunerRuns = 0
    const contextPruner = buildPrunerStub(function* () {
      prunerRuns++
    } as () => StepGenerator)
    // Keep the parent loop iterating past the suppression trip without running
    // real tools: a think-only response never ends the turn, and the fourth
    // response ends it explicitly.
    let llmCalls = 0
    const promptAiSdkStream = mock(async function* () {
      llmCalls++
      if (llmCalls >= 4) {
        yield createToolCallChunk('end_turn', {})
      } else {
        yield { type: 'text' as const, text: '<think>still working</think>' }
      }
      return promptSuccess('mock-message-id')
    })

    const result = await loopAgentSteps({
      ...baseParams,
      agentState,
      promptAiSdkStream,
      resolveModelContextWindow: mock(() => 64_000),
      localAgentTemplates: {
        'test-agent': agentTemplate,
        'context-pruner': contextPruner,
      },
      onResponseChunk: (event) => events.push(event),
    })

    expect(result.agentState.suppressSemanticCompaction).toBe(true)
    expect(llmCalls).toBeGreaterThanOrEqual(3)
    // Two unproductive passes trip suppression; every later iteration skips the
    // pruner entirely.
    expect(prunerRuns).toBe(2)
    // A suppressed iteration runs no pass, so it announces none either — and
    // every announced pass is still settled.
    const statusEvents = events.filter(
      (event) => event.type === 'context_compaction_status',
    )
    const started = statusEvents.filter((event) => event.state === 'started')
    const settled = statusEvents.filter((event) => event.state === 'settled')
    expect(started).toHaveLength(2)
    expect(settled.length).toBe(started.length)
    expect(statusEvents.at(-1)).toMatchObject({ state: 'settled' })
  })

  it('skips the runtime-driven pruner when the template does not declare context-pruner', async () => {
    setup()
    const events: any[] = []
    seedPromptOnlyOverTriggerRun()
    // A consumer-authored prompt-only agent that never declared
    // `context-pruner` in `spawnableAgents` must not silently pay for an extra
    // child LLM run whose output rewrites its transcript.
    agentTemplate.spawnableAgents = []
    let prunerRuns = 0
    const contextPruner = buildPrunerStub(function* () {
      prunerRuns++
      yield {
        toolName: 'set_messages',
        input: { messages: retainedMemoryTranscript() },
        includeToolCall: false,
      }
    } as () => StepGenerator)

    const result = await loopAgentSteps({
      ...baseParams,
      agentState,
      resolveModelContextWindow: mock(() => 64_000),
      localAgentTemplates: {
        'test-agent': agentTemplate,
        'context-pruner': contextPruner,
      },
      onResponseChunk: (event) => events.push(event),
    })

    expect(prunerRuns).toBe(0)
    // The undeclared pruner never rewrote the parent transcript.
    expect(JSON.stringify(result.agentState.messageHistory)).not.toContain(
      'Pinned structured knowledge memory.',
    )
    expect(events).not.toContainEqual(
      expect.objectContaining({
        type: 'context_compaction',
        action: 'semantic_compaction',
      }),
    )
    // The announcement is gated on the trigger, so a declined pass still
    // settles rather than leaving a pending card on screen.
    const statusEvents = events.filter(
      (event) => event.type === 'context_compaction_status',
    )
    const started = statusEvents.filter((event) => event.state === 'started')
    const settled = statusEvents.filter((event) => event.state === 'settled')
    expect(started.length).toBeGreaterThanOrEqual(1)
    expect(settled.length).toBe(started.length)
    expect(statusEvents.at(-1)).toMatchObject({ state: 'settled' })
  })

  it('spawns the declared publisher/version-qualified pruner for the runtime-driven pass', async () => {
    setup()
    seedPromptOnlyOverTriggerRun()
    // The consumer declared the pruner with a publisher and a version pin.
    // Permission is granted from that declaration, so the runtime-driven pass
    // must resolve and spawn exactly the declared id — resolving the bare
    // `context-pruner` instead would silently ignore the pin for the agent that
    // rewrites this parent's transcript.
    agentTemplate.spawnableAgents = ['acme/context-pruner@1.2.3']
    let qualifiedPrunerRuns = 0
    let barePrunerRuns = 0
    const qualifiedPruner = buildPrunerStub(
      function* () {
        qualifiedPrunerRuns++
        yield {
          toolName: 'set_messages',
          input: { messages: retainedMemoryTranscript() },
          includeToolCall: false,
        }
      } as () => StepGenerator,
      undefined,
      'acme/context-pruner@1.2.3',
    )
    const barePruner = buildPrunerStub(function* () {
      barePrunerRuns++
    } as () => StepGenerator)

    const result = await loopAgentSteps({
      ...baseParams,
      agentState,
      resolveModelContextWindow: mock(() => 64_000),
      localAgentTemplates: {
        'test-agent': agentTemplate,
        'acme/context-pruner@1.2.3': qualifiedPruner,
        'context-pruner': barePruner,
      },
    })

    expect(qualifiedPrunerRuns).toBe(1)
    // The unpinned template must never be substituted for the declared pin.
    expect(barePrunerRuns).toBe(0)
    expect(JSON.stringify(result.agentState.messageHistory)).toContain(
      '<knowledge_memory>',
    )
  })

  it('injects the operative pruner contract for a publisher/version-qualified pruner', async () => {
    setup()
    seedPromptOnlyOverTriggerRun()
    agentTemplate.spawnableAgents = ['acme/context-pruner@1.2.3']
    // The normal root-agent case: the parent already holds a committed task
    // memory revision, which the spawn clones into the pruner child. A pruner
    // that received no injected `taskMemory` would fall back to its embedded
    // compatibility path and publish `expectedTaskMemoryRevision: -1`, so
    // `commitTaskMemory` would raise a revision conflict and the transactional
    // `set_messages` would reject the transcript replacement outright — the
    // announced compaction would silently not happen for exactly the spelling
    // documented as equivalent to the bare `context-pruner`.
    agentState.taskMemory = commitTaskMemory({
      draft: {
        schemaVersion: 1,
        goal: 'Preserve discovery and resume',
        requirements: [],
        decisions: [],
        filesInspected: [],
        editsMade: [],
        validationResults: [],
        reviewReceipts: [],
        blockers: [],
        nextActions: [],
        historicalSummary: '',
        evidence: [],
      },
      expectedRevision: -1,
    })
    let injectedParams: Record<string, any> | undefined
    const qualifiedPruner = buildPrunerStub(
      function* ({ params }: { params?: Record<string, any> }) {
        injectedParams = params
        yield {
          toolName: 'set_messages',
          input: {
            messages: retainedMemoryTranscript(),
            // A real pruner commits the next memory revision in the same
            // transaction as the transcript replacement, guarded by the
            // revision it was handed — or the no-memory sentinel when it was
            // handed none.
            taskMemory: {
              schemaVersion: 1,
              goal: params?.taskMemory?.goal ?? '',
              requirements: [],
              decisions: [],
              filesInspected: [],
              editsMade: [],
              validationResults: [],
              reviewReceipts: [],
              blockers: [],
              nextActions: [],
              historicalSummary: 'Compacted by the pinned pruner.',
              evidence: [],
            },
            expectedTaskMemoryRevision: params?.taskMemory?.revision ?? -1,
          },
          includeToolCall: false,
        }
      } as unknown as AgentTemplate['handleSteps'],
      undefined,
      'acme/context-pruner@1.2.3',
    )

    const result = await loopAgentSteps({
      ...baseParams,
      agentState,
      resolveModelContextWindow: mock(() => 64_000),
      localAgentTemplates: {
        'test-agent': agentTemplate,
        'acme/context-pruner@1.2.3': qualifiedPruner,
      },
    })

    // The model-aware budget policy, the parent's operational memory, and the
    // workspace state all reach the pinned pruner.
    expect(injectedParams?.semanticBudget).toMatchObject({
      triggerBudgetTokens: 39_200,
      targetBudgetTokens: 19_600,
    })
    expect(injectedParams?.taskMemory?.revision).toBe(0)
    expect(injectedParams?.workspaceState).toBeDefined()
    // Because the revision guard matched, the transactional replacement
    // committed: both the transcript and the next memory revision landed.
    expect(JSON.stringify(result.agentState.messageHistory)).toContain(
      '<knowledge_memory>',
    )
  })

  it('honors the suppression advisory for a publisher/version-qualified inline pruner spawn', async () => {
    setup()
    // Generator-driven path: `validateAndGetAgentTemplate` resolves `agentType`
    // to the declared publisher/version-qualified id, so the anti-thrash
    // advisory must be keyed off pruner identity rather than the bare literal —
    // otherwise the documented `suppressSemanticCompaction` contract silently
    // does not hold for a pinned declaration.
    agentTemplate.spawnableAgents = ['acme/context-pruner@1.2.3']
    agentTemplate.toolNames = ['spawn_agent_inline', 'end_turn']
    const chunk = 'old evidence '.repeat(500)
    const chunkTokens = countTokens(chunk)
    agentState.messageHistory = [
      userMessage(chunk.repeat(Math.ceil(42_000 / chunkTokens))),
    ]
    agentTemplate.handleSteps = function* () {
      for (let iteration = 0; iteration < 4; iteration++) {
        yield {
          toolName: 'spawn_agent_inline',
          input: { agent_type: 'acme/context-pruner@1.2.3', prompt: '' },
        }
        yield 'STEP'
      }
    } as () => StepGenerator
    // A pruner that returns without rewriting the transcript reclaims nothing,
    // so two announced passes trip the loop-owned advisory.
    let prunerRuns = 0
    const qualifiedPruner = buildPrunerStub(
      function* () {
        prunerRuns++
      } as () => StepGenerator,
      undefined,
      'acme/context-pruner@1.2.3',
    )
    // Keep the parent loop iterating past the suppression trip without running
    // real tools: a think-only response never ends the turn, and the fourth
    // response ends it explicitly.
    let llmCalls = 0
    const promptAiSdkStream = mock(async function* () {
      llmCalls++
      if (llmCalls >= 4) {
        yield createToolCallChunk('end_turn', {})
      } else {
        yield { type: 'text' as const, text: '<think>still working</think>' }
      }
      return promptSuccess('mock-message-id')
    })
    // The shared fixture's `startAgentRun` returns one constant run id, and
    // `run-programmatic-step` caches generators by `runId` alone. This is the
    // only case in this file where BOTH the parent and the inline child have a
    // `handleSteps` generator, so a shared id would make the pruner child resume
    // the parent's cached generator and never run its own body. Mint unique ids
    // the way production `startAgentRun` does.
    let runIdCounter = 0
    const startAgentRun = mock(async () => `test-run-id-${++runIdCounter}`)

    const result = await loopAgentSteps({
      ...baseParams,
      agentState,
      promptAiSdkStream,
      startAgentRun,
      resolveModelContextWindow: mock(() => 64_000),
      localAgentTemplates: {
        'test-agent': agentTemplate,
        'acme/context-pruner@1.2.3': qualifiedPruner,
      },
    })

    expect(result.agentState.suppressSemanticCompaction).toBe(true)
    expect(llmCalls).toBeGreaterThanOrEqual(3)
    // Two unproductive passes trip suppression; every later inline spawn is
    // skipped instead of paying for another thrashing pruner run.
    expect(prunerRuns).toBe(2)
  })

  it('validates a suppressed pruner spawn before returning the anti-thrash skip envelope', async () => {
    setup()
    // Handler-level ordering: the anti-thrash skip runs AFTER
    // `validateAgentInput`/`validateVersionedAgentHandoff`, so a malformed pruner
    // spawn keeps failing validation instead of being reported as a successful
    // skip while the advisory is active.
    const prunerTemplate = {
      ...buildPrunerStub(undefined),
      // Requires a param the malformed spawn below omits.
      inputSchema: { params: z.object({ budget: z.number() }) },
    } as AgentTemplate
    const parentTemplate = {
      ...agentTemplate,
      spawnableAgents: ['context-pruner'],
      toolNames: ['spawn_agent_inline', 'end_turn'],
    } as AgentTemplate
    const handlerParams = {
      ...baseParams,
      agentState: { ...agentState, suppressSemanticCompaction: true },
      agentTemplate: parentTemplate,
      localAgentTemplates: {
        'test-agent': parentTemplate,
        'context-pruner': prunerTemplate,
      },
      previousToolCallFinished: Promise.resolve(),
      system: 'Test system prompt',
      tools: {},
      writeToClient: () => {},
    } as unknown as Parameters<typeof handleSpawnAgentInline>[0]

    await expect(
      handleSpawnAgentInline({
        ...handlerParams,
        toolCall: {
          toolName: 'spawn_agent_inline',
          toolCallId: 'inline-malformed-pruner',
          input: { agent_type: 'context-pruner', prompt: '', params: {} },
        },
      }),
    ).rejects.toThrow('Invalid params for agent context-pruner')

    // A well-formed spawn under the same advisory is skipped, and returns the
    // tool's standard `{ result, agentReceipt }` envelope with the declined
    // spawn reported as `cancelled` rather than completed.
    const { output } = await handleSpawnAgentInline({
      ...handlerParams,
      toolCall: {
        toolName: 'spawn_agent_inline',
        toolCallId: 'inline-well-formed-pruner',
        input: {
          agent_type: 'context-pruner',
          prompt: '',
          params: { budget: 1 },
        },
      },
    })
    const skipValue = output[0].value as unknown as {
      result?: { message?: string }
      agentReceipt?: {
        schemaVersion?: number
        status?: string
        agentId?: string
        output?: { message?: string }
      }
    }
    expect(skipValue.result?.message).toContain('Semantic compaction skipped')
    expect(skipValue.agentReceipt).toMatchObject({
      schemaVersion: 1,
      status: 'cancelled',
    })
    expect(skipValue.agentReceipt?.output?.message).toContain(
      'Semantic compaction skipped',
    )
    // Consumers correlate receipts to spawns by `receipt.agentId`, so the skip
    // envelope must identify the declined spawn and never the parent run.
    expect(skipValue.agentReceipt?.agentId).toBeTruthy()
    expect(skipValue.agentReceipt?.agentId).not.toBe(agentState.agentId)
  })

  it('keeps the turn alive and settles when the runtime-driven pruner fails', async () => {
    setup()
    const events: any[] = []
    const warn = mock((_data?: unknown, _message?: string) => {})
    seedPromptOnlyOverTriggerRun()
    let prunerRuns = 0
    // A pruner spawn depth cap of 0 makes `executeSubagent` reject the spawn
    // before any pruner work runs, which is the failure the helper must absorb.
    const contextPruner = buildPrunerStub(
      function* () {
        prunerRuns++
        yield 'STEP'
      } as () => StepGenerator,
      0,
    )

    const result = await loopAgentSteps({
      ...baseParams,
      agentState,
      logger: { ...baseParams.logger, warn },
      resolveModelContextWindow: mock(() => 64_000),
      localAgentTemplates: {
        'test-agent': agentTemplate,
        'context-pruner': contextPruner,
      },
      onResponseChunk: (event) => events.push(event),
    })

    // The turn completed normally: a pruner failure is never fatal.
    expect(result.output).toBeDefined()
    expect(prunerRuns).toBe(0)
    expect(
      warn.mock.calls.filter(
        (call) =>
          typeof call[1] === 'string' &&
          call[1].includes('Runtime-driven semantic compaction failed'),
      ).length,
    ).toBeGreaterThanOrEqual(1)
    // Every announced pass still settles, even though each one failed.
    const statusEvents = events.filter(
      (event) => event.type === 'context_compaction_status',
    )
    const started = statusEvents.filter((event) => event.state === 'started')
    const settled = statusEvents.filter((event) => event.state === 'settled')
    expect(started.length).toBeGreaterThanOrEqual(1)
    expect(settled.length).toBe(started.length)
    expect(statusEvents.at(-1)).toMatchObject({ state: 'settled' })
  })

  it('uses the structured compaction envelope and newest pinned memory for /compact', async () => {
    setup()
    agentState.messageHistory = [
      userMessage(
        '<knowledge_memory>\nPinned structured knowledge memory.\nGoal: stale goal\n</knowledge_memory>',
      ),
      userMessage(
        '<knowledge_memory>\nPinned structured knowledge memory.\nGoal: current goal\n</knowledge_memory>',
      ),
    ]

    const result = await loopAgentSteps({
      ...baseParams,
      agentState,
      prompt: '/compact',
    })

    const compacted = JSON.stringify(result.agentState.messageHistory)
    expect(compacted).toContain('<conversation_summary>')
    expect(compacted).toContain('<historical_memory>')
    expect(compacted).toContain('Goal: current goal')
    expect(compacted).not.toContain('Goal: stale goal')
  })

  it('populates contextBudgetLedger on prompt-build turns and keeps it on cached-prompt turns', async () => {
    setup()
    // Include the placeholder builders that record into the per-turn ledger
    // while assembling the system prompt.
    agentTemplate.systemPrompt = `Test system prompt ${PLACEHOLDER.FILE_TREE_PROMPT} ${PLACEHOLDER.SYSTEM_INFO_PROMPT}`

    await loopAgentSteps({
      ...baseParams,
      promptAiSdkStream: runtimeParams.promptAiSdkStream,
      localAgentTemplates: { 'test-agent': agentTemplate },
    })

    const ledger = agentState.contextBudgetLedger
    expect(ledger).toBeDefined()
    expect(ledger!.byCategory.fileTree).toBeGreaterThan(0)
    expect(ledger!.byCategory.systemInfo).toBeGreaterThan(0)
    expect(ledger!.windowTokens).toBeGreaterThan(0)

    // A cached-prompt turn reuses the session-cached system prompt (agent
    // type matches) and must not overwrite the recorded ledger.
    agentState.systemPrompt = 'cached'
    agentState.agentType = 'test-agent'

    await loopAgentSteps({
      ...baseParams,
      promptAiSdkStream: runtimeParams.promptAiSdkStream,
      localAgentTemplates: { 'test-agent': agentTemplate },
    })

    expect(agentState.contextBudgetLedger).toBe(ledger)
  })

  it('annotates the retained contextBudgetLedger on a /compact turn', async () => {
    setup()
    // Include the placeholder builders that record into the per-turn ledger
    // while assembling the system prompt.
    agentTemplate.systemPrompt = `Test system prompt ${PLACEHOLDER.FILE_TREE_PROMPT} ${PLACEHOLDER.SYSTEM_INFO_PROMPT}`

    await loopAgentSteps({
      ...baseParams,
      promptAiSdkStream: runtimeParams.promptAiSdkStream,
      localAgentTemplates: { 'test-agent': agentTemplate },
    })

    const ledger = agentState.contextBudgetLedger
    expect(ledger).toBeDefined()

    // A cached-prompt turn (agent type matches) keeps the recorded ledger;
    // the /compact turn must annotate it rather than rebuild or discard it.
    agentState.agentType = 'test-agent'

    await loopAgentSteps({
      ...baseParams,
      prompt: '/compact',
      promptAiSdkStream: runtimeParams.promptAiSdkStream,
      localAgentTemplates: { 'test-agent': agentTemplate },
    })

    expect(agentState.contextBudgetLedger).toBeDefined()
    expect(agentState.contextBudgetLedger).not.toBe(ledger)
    expect(agentState.contextBudgetLedger!.compactedAtTurn).toBe(true)
    expect(agentState.contextBudgetLedger!.totalTokens).toBe(
      ledger!.totalTokens,
    )
    expect(agentState.contextBudgetLedger!.byCategory).toEqual(
      ledger!.byCategory,
    )
  })
})
