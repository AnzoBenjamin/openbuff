import { TEST_USER_ID } from '@codebuff/common/old-constants'
import { TEST_AGENT_RUNTIME_IMPL } from '@codebuff/common/testing/impl/agent-runtime'
import { getInitialSessionState } from '@codebuff/common/types/session-state'
import {
  assistantMessage,
  systemMessage,
  userMessage,
} from '@codebuff/common/util/messages'
import {
  describe,
  expect,
  it,
  beforeEach,
  afterEach,
  mock,
  spyOn,
} from 'bun:test'

import { mockFileContext } from './test-utils'
import {
  createSessionEvidenceLog,
  recordSessionEvidence,
} from '../memory/session-evidence-log'
import * as runAgentStep from '../run-agent-step'
import { handleSpawnAgents } from '../tools/handlers/tool/spawn-agents'
import { handleSpawnAgentInline } from '../tools/handlers/tool/spawn-agent-inline'
import { commitTaskMemory } from '../util/task-memory'
import { createInitialWorkspaceState } from '@codebuff/common/types/workspace-state'
import { MemoryPlaybookSchema } from '@codebuff/common/types/memory-playbook'

import type { CodebuffToolCall } from '@codebuff/common/tools/list'
import type { AgentTemplate } from '@codebuff/common/types/agent-template'
import type { AgentState } from '@codebuff/common/types/session-state'
import type { MemoryPlaybook } from '@codebuff/common/types/memory-playbook'
import type { ParamsExcluding } from '@codebuff/common/types/function-params'
import type {
  SessionEvidenceEntry,
  SessionEvidenceLog,
} from '../memory/session-evidence-log'

/**
 * Schema-valid playbook fixture (shape copied from
 * memory/__tests__/playbook-gate.test.ts's makePlaybook/seededCommitterPlaybook
 * helpers). Parsing through MemoryPlaybookSchema keeps the fixture honest about
 * the canonical types instead of hand-rolling a shape that could drift.
 */
const makePlaybook = (playbookId = 'pb-1'): MemoryPlaybook =>
  MemoryPlaybookSchema.parse({
    schemaVersion: 1,
    playbookId,
    workspaceId: 'ws-1',
    title: 'Run local CI before spawning the git committer',
    instruction: 'Run `npm run check:ci-local` and fix failures.',
    trigger: {
      tool: 'spawn_agents',
      spawnAgentType: 'git-committer',
      requireEvidence: [
        {
          kind: 'toolSucceeded',
          tool: 'run_terminal_command',
          commandPattern: '*check:ci-local*',
          withinMs: 30 * 60 * 1_000,
        },
      ],
    },
    scope: { repos: [] },
    status: 'active',
    enforcement: 'block',
    counters: {
      fired: 0,
      blocked: 0,
      compliedAfterBlock: 0,
      falsePositives: 0,
      bypassed: 0,
    },
    provenance: {
      origin: 'derived',
      recordedBy: 'test',
      sourceEventIds: [],
      metadata: {},
    },
    triggerSignature: `sig-${playbookId}`,
    createdAt: 1,
    updatedAt: 2,
  })

describe('Spawn Agents Message History', () => {
  let mockSendSubagentChunk: any
  let mockLoopAgentSteps: any
  let capturedLoopOptions: any
  let capturedSubAgentState: any

  let handleSpawnAgentsBaseParams: ParamsExcluding<
    typeof handleSpawnAgents,
    'agentState' | 'agentTemplate' | 'localAgentTemplates' | 'toolCall'
  >

  beforeEach(() => {
    // Mock sendSubagentChunk
    mockSendSubagentChunk = mock(() => {})

    // Mock loopAgentSteps to capture the subAgentState
    mockLoopAgentSteps = spyOn(
      runAgentStep,
      'loopAgentSteps',
    ).mockImplementation(async (options) => {
      capturedLoopOptions = options
      capturedSubAgentState = options.agentState
      return {
        agentState: {
          ...options.agentState,
          messageHistory: [
            ...options.agentState.messageHistory,
            assistantMessage('Mock agent response'),
          ],
        },
        output: {
          type: 'lastMessage',
          value: [assistantMessage('Mock agent response')],
        },
      }
    })

    handleSpawnAgentsBaseParams = {
      ...TEST_AGENT_RUNTIME_IMPL,
      ancestorRunIds: [],
      clientSessionId: 'test-session',
      fingerprintId: 'test-fingerprint',
      fileContext: mockFileContext,
      repoId: undefined,
      repoUrl: undefined,
      previousToolCallFinished: Promise.resolve(),
      sendSubagentChunk: mockSendSubagentChunk,
      signal: new AbortController().signal,
      system: 'Test system prompt',
      tools: {},
      userId: TEST_USER_ID,
      userInputId: 'test-input',
      writeToClient: () => {},
    }
  })

  afterEach(() => {
    mock.restore()
    capturedLoopOptions = undefined
    capturedSubAgentState = undefined
  })

  const createMockAgent = (
    id: string,
    includeMessageHistory = true,
  ): AgentTemplate => ({
    id,
    displayName: `Mock ${id}`,
    outputMode: 'last_message' as const,
    inputSchema: {
      prompt: {
        safeParse: () => ({ success: true }),
      } as unknown as AgentTemplate['inputSchema']['prompt'],
    },
    spawnerPrompt: '',
    model: '',
    includeMessageHistory,
    inheritParentSystemPrompt: false,
    mcpServers: {},
    toolNames: [],
    spawnableAgents: ['child-agent'],
    systemPrompt: '',
    instructionsPrompt: '',
    stepPrompt: '',
  })

  const createSpawnToolCall = (
    agentType: string,
    prompt = 'test prompt',
  ): CodebuffToolCall<'spawn_agents'> => ({
    toolName: 'spawn_agents' as const,
    toolCallId: 'test-tool-call-id',
    input: {
      agents: [{ agent_type: agentType, prompt }],
    },
  })

  // Fixed wall-clock ms for recorded gate evidence: the settle merge copies
  // entries verbatim with no freshness filtering, so a constant keeps the
  // parent-ledger assertions exact.
  const CI_EVIDENCE_AT_MS = 1_735_689_600_000
  const makeCiEvidenceEntry = (): SessionEvidenceEntry => ({
    toolName: 'run_terminal_command',
    commandText: 'bun run check:ci-local',
    atMs: CI_EVIDENCE_AT_MS,
  })

  /**
   * The session evidence ledger is an additive AgentState field (see the
   * intersection cast inside mergeChildEvidenceIntoParent), so the parent
   * ledger is read through the same cast here.
   */
  const parentSessionEvidenceEntries = (
    state: AgentState,
  ): SessionEvidenceEntry[] =>
    (state as AgentState & { sessionEvidenceLog?: SessionEvidenceLog })
      .sessionEvidenceLog?.entries ?? []

  it('should include all messages from conversation history when includeMessageHistory is true', async () => {
    const parentAgent = createMockAgent('parent', true)
    const childAgent = createMockAgent('child-agent', true)
    const sessionState = getInitialSessionState(mockFileContext)
    const toolCall = createSpawnToolCall('child-agent')

    // Create mock messages including system message
    sessionState.mainAgentState.messageHistory = [
      systemMessage('This is the parent system prompt that should be excluded'),
      userMessage('Hello'),
      assistantMessage('Hi there!'),
      userMessage('How are you?'),
    ]

    await handleSpawnAgents({
      ...handleSpawnAgentsBaseParams,
      agentState: sessionState.mainAgentState,
      agentTemplate: parentAgent,
      localAgentTemplates: { 'child-agent': childAgent },
      toolCall,
    })

    // Verify that the spawned agent was called
    expect(mockLoopAgentSteps).toHaveBeenCalledTimes(1)

    // Verify that the subagent's message history contains the filtered messages
    // expireMessages filters based on timeToLive property, not role
    // Since the system message doesn't have timeToLive, it will be included
    // System + user + assistant messages + spawn message
    expect(capturedSubAgentState.messageHistory).toHaveLength(5)

    // Verify system message is included (because it has no timeToLive property)
    const systemMessages = capturedSubAgentState.messageHistory.filter(
      (msg: any) => msg.role === 'system',
    )
    expect(systemMessages).toHaveLength(1)
    expect(systemMessages[0].content).toEqual([
      {
        type: 'text',
        text: 'This is the parent system prompt that should be excluded',
      },
    ])

    // Verify user and assistant messages are included
    expect(
      capturedSubAgentState.messageHistory.find(
        (msg: any) => msg.content[0]?.text === 'Hello',
      ),
    ).toBeTruthy()
    expect(
      capturedSubAgentState.messageHistory.find(
        (msg: any) => msg.content[0]?.text === 'Hi there!',
      ),
    ).toBeTruthy()
    expect(
      capturedSubAgentState.messageHistory.find(
        (msg: any) => msg.content[0]?.text === 'How are you?',
      ),
    ).toBeTruthy()

    // Verify the subagent spawn message is included with proper structure
    const spawnMessage = capturedSubAgentState.messageHistory.find((msg: any) =>
      msg.tags?.includes('SUBAGENT_SPAWN'),
    )
    expect(spawnMessage).toBeTruthy()
    expect(spawnMessage.role).toBe('user')
    expect(spawnMessage.content[0]?.text).toContain(
      'Subagent child-agent has been spawned',
    )
  })

  it('should not include conversation history when includeMessageHistory is false', async () => {
    const parentAgent = createMockAgent('parent', true)
    const childAgent = createMockAgent('child-agent', false) // includeMessageHistory = false
    const sessionState = getInitialSessionState(mockFileContext)
    const toolCall = createSpawnToolCall('child-agent')

    sessionState.mainAgentState.messageHistory = [
      systemMessage('System prompt'),
      userMessage('Hello'),
      assistantMessage('Hi there!'),
    ]

    await handleSpawnAgents({
      ...handleSpawnAgentsBaseParams,
      agentState: sessionState.mainAgentState,
      agentTemplate: parentAgent,
      localAgentTemplates: { 'child-agent': childAgent },
      toolCall,
    })

    // Verify that the subagent's message history is empty when includeMessageHistory is false
    expect(capturedSubAgentState.messageHistory).toHaveLength(0)
  })

  it('transfers only pinned operational memory in pinned mode', async () => {
    const parentAgent = createMockAgent('parent', true)
    const childAgent = {
      ...createMockAgent('child-agent', false),
      messageHistoryMode: 'pinned' as const,
    }
    const sessionState = getInitialSessionState(mockFileContext)
    const toolCall = createSpawnToolCall('child-agent')
    sessionState.mainAgentState.messageHistory = [
      systemMessage('large parent system prompt'),
      userMessage('raw conversation detail that must not transfer'),
      userMessage({
        content: [
          {
            type: 'text',
            text: [
              '<conversation_summary>',
              '<historical_memory>',
              '<knowledge_memory>',
              'Pinned structured knowledge memory.',
              'Goal: preserve only this bounded task state',
              '</knowledge_memory>',
              '</historical_memory>',
              '</conversation_summary>',
            ].join('\n'),
          },
        ],
        keepDuringTruncation: true,
      }),
    ]

    await handleSpawnAgents({
      ...handleSpawnAgentsBaseParams,
      agentState: sessionState.mainAgentState,
      agentTemplate: parentAgent,
      localAgentTemplates: { 'child-agent': childAgent },
      toolCall,
    })

    const transferred = JSON.stringify(capturedSubAgentState.messageHistory)
    expect(transferred).toContain('<knowledge_memory>')
    expect(transferred).toContain('preserve only this bounded task state')
    expect(transferred).not.toContain('raw conversation detail')
    expect(transferred).not.toContain('large parent system prompt')
  })

  it('clones typed operational memory for bounded children without inheriting the parent model window', async () => {
    const parentAgent = createMockAgent('parent', true)
    const childAgent = {
      ...createMockAgent('child-agent', false),
      messageHistoryMode: 'pinned' as const,
    }
    const sessionState = getInitialSessionState(mockFileContext)
    const toolCall = createSpawnToolCall('child-agent')
    sessionState.mainAgentState.contextWindowTokens = 1_000_000
    sessionState.mainAgentState.taskMemory = commitTaskMemory({
      expectedRevision: -1,
      draft: {
        schemaVersion: 1,
        goal: 'Preserve the parent goal without copying private transcript',
        requirements: ['Keep agent histories isolated'],
        decisions: ['Use bounded typed memory'],
        filesInspected: [],
        editsMade: [],
        validationResults: [],
        reviewReceipts: [],
        blockers: [],
        nextActions: ['Resolve the child model window independently'],
        historicalSummary: '',
        evidence: [],
      },
    })
    sessionState.mainAgentState.workspaceState = createInitialWorkspaceState()
    const parentTaskMemoryBeforeSpawn = sessionState.mainAgentState.taskMemory

    await handleSpawnAgents({
      ...handleSpawnAgentsBaseParams,
      agentState: sessionState.mainAgentState,
      agentTemplate: parentAgent,
      localAgentTemplates: { 'child-agent': childAgent },
      toolCall,
    })

    expect(capturedSubAgentState.contextWindowTokens).toBeUndefined()
    expect(capturedSubAgentState.taskMemory).toEqual(
      parentTaskMemoryBeforeSpawn,
    )
    expect(capturedSubAgentState.taskMemory).not.toBe(
      parentTaskMemoryBeforeSpawn,
    )
    expect(capturedSubAgentState.workspaceState).not.toBe(
      sessionState.mainAgentState.workspaceState,
    )
  })

  it('does not transfer typed task memory to transcript-isolated children', async () => {
    const parentAgent = createMockAgent('parent', true)
    const childAgent = createMockAgent('child-agent', false)
    const sessionState = getInitialSessionState(mockFileContext)
    const toolCall = createSpawnToolCall('child-agent')
    sessionState.mainAgentState.taskMemory = commitTaskMemory({
      expectedRevision: -1,
      draft: {
        schemaVersion: 1,
        goal: 'Private parent task',
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
    })

    await handleSpawnAgents({
      ...handleSpawnAgentsBaseParams,
      agentState: sessionState.mainAgentState,
      agentTemplate: parentAgent,
      localAgentTemplates: { 'child-agent': childAgent },
      toolCall,
    })

    expect(capturedSubAgentState.taskMemory).toBeUndefined()
  })

  it('threads a clone of the parent playbook rules to a transcript-isolated child (child gating)', async () => {
    // includeMessageHistory: false is the deliberate contrast case: typed
    // task memory is dropped for transcript-isolated children, but the
    // parent's enforcement rules must NOT be — a git-committer child is
    // precisely the case the rules must reach, so its own
    // run_terminal_command git calls stay gated and the band renders (the
    // band module has no parentId guard by design).
    const parentAgent = createMockAgent('parent', true)
    const childAgent = createMockAgent('child-agent', false)
    const sessionState = getInitialSessionState(mockFileContext)
    const toolCall = createSpawnToolCall('child-agent')
    const playbooks = [makePlaybook('pb-1'), makePlaybook('pb-2')]
    sessionState.mainAgentState.playbookContext = playbooks

    await handleSpawnAgents({
      ...handleSpawnAgentsBaseParams,
      agentState: sessionState.mainAgentState,
      agentTemplate: parentAgent,
      localAgentTemplates: { 'child-agent': childAgent },
      toolCall,
    })

    // Different reference, deep-equal rows: the child owns a clone so it can
    // never mutate the parent's rule source of truth.
    expect(capturedSubAgentState.playbookContext).toEqual(playbooks)
    expect(capturedSubAgentState.playbookContext).not.toBe(playbooks)
    expect(capturedSubAgentState.playbookContext[0]).not.toBe(playbooks[0])
    // The shared spawn-batch clone is deep-frozen (dev/test guard,
    // createAgentState's memoizedStructuredClone → deepFreezeSharedClone): a
    // violating in-place write on the child's copy throws and can never reach
    // the parent — sibling isolation holds strictly.
    let frozenWriteThrew = false
    try {
      capturedSubAgentState.playbookContext[0].title = 'mutated by child'
      capturedSubAgentState.playbookContext.push(makePlaybook('pb-3'))
    } catch {
      frozenWriteThrew = true
    }
    expect(frozenWriteThrew).toBe(true)
    expect(sessionState.mainAgentState.playbookContext).toHaveLength(2)
    expect(sessionState.mainAgentState.playbookContext[0].title).toBe(
      'Run local CI before spawning the git committer',
    )
    // The messageHistoryMode contrast holds for the same child: task memory
    // stays transcript-gated while playbook rules transfer.
    expect(capturedSubAgentState.taskMemory).toBeUndefined()
  })

  it('leaves the child playbook context undefined when the parent has no active playbooks', async () => {
    const parentAgent = createMockAgent('parent', true)
    const childAgent = createMockAgent('child-agent', true)
    const sessionState = getInitialSessionState(mockFileContext)
    const toolCall = createSpawnToolCall('child-agent')
    // Precondition: the fresh parent carries no active playbooks (additive
    // contract — no rules means no transfer, byte-identical to today).
    expect(sessionState.mainAgentState.playbookContext).toBeUndefined()

    await handleSpawnAgents({
      ...handleSpawnAgentsBaseParams,
      agentState: sessionState.mainAgentState,
      agentTemplate: parentAgent,
      localAgentTemplates: { 'child-agent': childAgent },
      toolCall,
    })

    expect(capturedSubAgentState.playbookContext).toBeUndefined()
  })

  it('should handle empty message history gracefully', async () => {
    const parentAgent = createMockAgent('parent', true)
    const childAgent = createMockAgent('child-agent', true)
    const sessionState = getInitialSessionState(mockFileContext)
    const toolCall = createSpawnToolCall('child-agent')

    sessionState.mainAgentState.messageHistory = [] // Empty message history

    await handleSpawnAgents({
      ...handleSpawnAgentsBaseParams,
      agentState: sessionState.mainAgentState,
      agentTemplate: parentAgent,
      localAgentTemplates: { 'child-agent': childAgent },
      toolCall,
    })

    // Verify that the subagent's message history contains only the spawn message
    // when includeMessageHistory is true (even with empty parent history)
    expect(capturedSubAgentState.messageHistory).toHaveLength(1)

    // Verify the spawn message structure
    const spawnMessage = capturedSubAgentState.messageHistory[0]
    expect(spawnMessage.role).toBe('user')
    expect(spawnMessage.tags).toContain('SUBAGENT_SPAWN')
    expect(spawnMessage.content[0]?.text).toContain(
      'Subagent child-agent has been spawned',
    )
  })

  it('propagates top-level handoff into the child spawn params payload', async () => {
    const parentAgent = createMockAgent('parent', true)
    const childAgent = createMockAgent('child-agent', true)
    const sessionState = getInitialSessionState(mockFileContext)
    const handoff = {
      schemaVersion: 1 as const,
      taskId: 'handoff-task',
      role: 'specialist' as const,
      objective: 'Continue the implementation',
      requirements: [],
      acceptanceCriteria: [],
      context: {},
      invariants: [],
      nonGoals: [],
      risks: [],
      unknowns: [],
      findings: [],
      permissions: {
        readablePaths: [],
        writablePaths: [],
        allowedTools: [],
      },
      summary: 'Continue the implementation',
      artifacts: ['.agents/sessions/example/STATUS.md'],
      successCriteria: [],
      constraints: ['Do not edit unrelated files'],
    }
    const toolCall: CodebuffToolCall<'spawn_agents'> = {
      toolName: 'spawn_agents' as const,
      toolCallId: 'test-tool-call-id',
      input: {
        agents: [
          {
            agent_type: 'child-agent',
            prompt: 'test prompt',
            params: { existing: 'value' },
            handoff,
          },
        ],
      },
    }

    await handleSpawnAgents({
      ...handleSpawnAgentsBaseParams,
      agentState: sessionState.mainAgentState,
      agentTemplate: parentAgent,
      localAgentTemplates: { 'child-agent': childAgent },
      toolCall,
    })

    expect(capturedLoopOptions.spawnParams).toEqual({
      existing: 'value',
      handoff,
    })
  })

  it('propagates top-level handoff into inline child spawn params payload', async () => {
    const parentAgent = createMockAgent('parent', true)
    const childAgent = createMockAgent('child-agent', true)
    const sessionState = getInitialSessionState(mockFileContext)
    const handoff = {
      schemaVersion: 1 as const,
      taskId: 'inline-handoff-task',
      role: 'specialist' as const,
      objective: 'Continue inline',
      requirements: [],
      acceptanceCriteria: [],
      context: {},
      invariants: [],
      nonGoals: ['Do not fork context'],
      risks: [],
      unknowns: [],
      findings: [],
      permissions: {
        readablePaths: [],
        writablePaths: [],
        allowedTools: [],
      },
      artifacts: [],
      successCriteria: [],
      constraints: [],
      summary: 'Continue inline',
    }
    const toolCall: CodebuffToolCall<'spawn_agent_inline'> = {
      toolName: 'spawn_agent_inline' as const,
      toolCallId: 'test-tool-call-id',
      input: {
        agent_type: 'child-agent',
        prompt: 'test prompt',
        params: { existing: 'inline-value' },
        handoff,
      },
    }

    await handleSpawnAgentInline({
      ...handleSpawnAgentsBaseParams,
      tools: {},
      agentState: sessionState.mainAgentState,
      agentTemplate: parentAgent,
      localAgentTemplates: { 'child-agent': childAgent },
      toolCall,
    })

    expect(capturedLoopOptions.spawnParams).toEqual({
      existing: 'inline-value',
      handoff,
    })
  })

  it('threads archive pointers and compacted task memory through an inline pruner', async () => {
    const parentAgent = createMockAgent('parent', true)
    parentAgent.spawnableAgents = ['context-pruner']
    const prunerAgent = createMockAgent('context-pruner', true)
    const sessionState = getInitialSessionState(mockFileContext)
    const compactedMemory = commitTaskMemory({
      expectedRevision: -1,
      draft: {
        schemaVersion: 1,
        goal: 'Compacted operational goal',
        requirements: [],
        decisions: [],
        filesInspected: [],
        editsMade: [],
        validationResults: [],
        reviewReceipts: [],
        blockers: [],
        nextActions: [],
        historicalSummary: 'Bounded summary',
        evidence: [],
      },
    })
    sessionState.mainAgentState.compactionArchive = [
      {
        archivedAt: 1,
        action: 'semantic_compaction',
        keepRecentSteps: 0,
        stepBase: 0,
        messages: [userMessage('archived context')],
      },
    ]
    mockLoopAgentSteps.mockImplementationOnce(async (options: any) => {
      capturedLoopOptions = options
      capturedSubAgentState = options.agentState
      return {
        agentState: {
          ...options.agentState,
          messageHistory: [userMessage('compacted transcript')],
          taskMemory: compactedMemory,
        },
        output: { type: 'lastMessage', value: [] },
      }
    })
    const toolCall: CodebuffToolCall<'spawn_agent_inline'> = {
      toolName: 'spawn_agent_inline',
      toolCallId: 'pruner-tool-call',
      input: { agent_type: 'context-pruner', prompt: '' },
    }

    await handleSpawnAgentInline({
      ...handleSpawnAgentsBaseParams,
      tools: {},
      agentState: sessionState.mainAgentState,
      agentTemplate: parentAgent,
      localAgentTemplates: { 'context-pruner': prunerAgent },
      toolCall,
    })

    expect(capturedLoopOptions.spawnParams?.archivePointers).toEqual([
      '[action=semantic_compaction steps=0-0 msgs=1] 1 archived messages',
    ])
    expect(sessionState.mainAgentState.messageHistory).toEqual([
      expect.objectContaining({
        role: 'user',
        content: [{ type: 'text', text: 'compacted transcript' }],
      }),
    ])
    expect(sessionState.mainAgentState.taskMemory).toMatchObject({
      goal: 'Compacted operational goal',
      historicalSummary: 'Bounded summary',
    })
  })

  it('folds a foreground child evidence ledger into the parent on settle', async () => {
    // Pins the spawn-agents foreground merge call site end-to-end: a child
    // (e.g. basher) records gate evidence on its own additive ledger, and
    // deleting the settle merge would drop it from the parent's ledger.
    const parentAgent = createMockAgent('parent', true)
    const childAgent = createMockAgent('child-agent', true)
    const sessionState = getInitialSessionState(mockFileContext)
    const toolCall = createSpawnToolCall('child-agent')
    const childLog = createSessionEvidenceLog()
    recordSessionEvidence(childLog, makeCiEvidenceEntry())
    mockLoopAgentSteps.mockImplementationOnce(async (options: any) => {
      capturedLoopOptions = options
      capturedSubAgentState = options.agentState
      return {
        agentState: {
          ...options.agentState,
          messageHistory: [
            ...options.agentState.messageHistory,
            assistantMessage('Mock agent response'),
          ],
          sessionEvidenceLog: childLog,
        },
        output: {
          type: 'lastMessage',
          value: [assistantMessage('Mock agent response')],
        },
      }
    })

    await handleSpawnAgents({
      ...handleSpawnAgentsBaseParams,
      agentState: sessionState.mainAgentState,
      agentTemplate: parentAgent,
      localAgentTemplates: { 'child-agent': childAgent },
      toolCall,
    })

    expect(
      parentSessionEvidenceEntries(sessionState.mainAgentState),
    ).toEqual([makeCiEvidenceEntry()])
  })

  it('folds an inline child evidence ledger into the parent on success settle', async () => {
    // Pins the inline success-path merge: it reads result.agentState, so the
    // ledger a settled child carries must reach the parent's ledger.
    const parentAgent = createMockAgent('parent', true)
    const childAgent = createMockAgent('child-agent', true)
    const sessionState = getInitialSessionState(mockFileContext)
    const childLog = createSessionEvidenceLog()
    recordSessionEvidence(childLog, makeCiEvidenceEntry())
    mockLoopAgentSteps.mockImplementationOnce(async (options: any) => {
      capturedLoopOptions = options
      capturedSubAgentState = options.agentState
      return {
        agentState: {
          ...options.agentState,
          messageHistory: [
            ...options.agentState.messageHistory,
            assistantMessage('Mock agent response'),
          ],
          sessionEvidenceLog: childLog,
        },
        output: {
          type: 'lastMessage',
          value: [assistantMessage('Mock agent response')],
        },
      }
    })
    const toolCall: CodebuffToolCall<'spawn_agent_inline'> = {
      toolName: 'spawn_agent_inline',
      toolCallId: 'evidence-merge-inline-tool-call',
      input: { agent_type: 'child-agent', prompt: 'test prompt' },
    }

    await handleSpawnAgentInline({
      ...handleSpawnAgentsBaseParams,
      tools: {},
      agentState: sessionState.mainAgentState,
      agentTemplate: parentAgent,
      localAgentTemplates: { 'child-agent': childAgent },
      toolCall,
    })

    expect(
      parentSessionEvidenceEntries(sessionState.mainAgentState),
    ).toEqual([makeCiEvidenceEntry()])
  })

  it('folds an inline child evidence ledger into the parent even when the child throws', async () => {
    // Pins the inline catch-path merge. executeSubagent re-throws a child
    // failure only when the parent signal is already aborted (otherwise it
    // degrades to a structured error output and the handler settles through
    // the success path), so the aborted signal routes this throw into the
    // handler's catch — where the catch merge is the only one that runs. The
    // mock records evidence on options.agentState, which loopAgentSteps
    // receives as the same handler-local childAgentState reference, so
    // deleting the catch merge drops the entry while the rejection survives.
    const parentAgent = createMockAgent('parent', true)
    const childAgent = createMockAgent('child-agent', true)
    const sessionState = getInitialSessionState(mockFileContext)
    const abortController = new AbortController()
    abortController.abort()
    mockLoopAgentSteps.mockImplementationOnce(async (options: any) => {
      capturedLoopOptions = options
      capturedSubAgentState = options.agentState
      options.agentState.sessionEvidenceLog ??= createSessionEvidenceLog()
      recordSessionEvidence(
        options.agentState.sessionEvidenceLog,
        makeCiEvidenceEntry(),
      )
      throw new Error('inline child threw after recording gate evidence')
    })
    const toolCall: CodebuffToolCall<'spawn_agent_inline'> = {
      toolName: 'spawn_agent_inline',
      toolCallId: 'evidence-merge-throw-tool-call',
      input: { agent_type: 'child-agent', prompt: 'test prompt' },
    }

    await expect(
      handleSpawnAgentInline({
        ...handleSpawnAgentsBaseParams,
        signal: abortController.signal,
        tools: {},
        agentState: sessionState.mainAgentState,
        agentTemplate: parentAgent,
        localAgentTemplates: { 'child-agent': childAgent },
        toolCall,
      }),
    ).rejects.toThrow('inline child threw after recording gate evidence')

    expect(
      parentSessionEvidenceEntries(sessionState.mainAgentState),
    ).toEqual([makeCiEvidenceEntry()])
  })

  it('should handle message history with only system messages', async () => {
    const parentAgent = createMockAgent('parent', true)
    const childAgent = createMockAgent('child-agent', true)
    const sessionState = getInitialSessionState(mockFileContext)
    const toolCall = createSpawnToolCall('child-agent')

    sessionState.mainAgentState.messageHistory = [
      systemMessage('System prompt 1'),
      systemMessage('System prompt 2'),
    ]

    await handleSpawnAgents({
      ...handleSpawnAgentsBaseParams,
      agentState: sessionState.mainAgentState,
      agentTemplate: parentAgent,
      localAgentTemplates: { 'child-agent': childAgent },
      toolCall,
    })

    // Verify that system messages without timeToLive are included
    // expireMessages only filters messages with timeToLive='userPrompt'
    // Plus 1 for the subagent spawn message
    expect(capturedSubAgentState.messageHistory).toHaveLength(3)
    const systemMessages = capturedSubAgentState.messageHistory.filter(
      (msg: any) => msg.role === 'system',
    )
    expect(systemMessages).toHaveLength(2)

    // Verify spawn message is present
    const spawnMessage = capturedSubAgentState.messageHistory.find((msg: any) =>
      msg.tags?.includes('SUBAGENT_SPAWN'),
    )
    expect(spawnMessage).toBeTruthy()
  })
})
