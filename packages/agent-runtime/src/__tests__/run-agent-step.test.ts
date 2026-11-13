import { TEST_USER_ID } from '@codebuff/common/old-constants'
import { createTestAgentRuntimeParams } from '@codebuff/common/testing/fixtures/agent-runtime'
import { TEST_AGENT_RUNTIME_IMPL } from '@codebuff/common/testing/impl/agent-runtime'
import { getInitialSessionState } from '@codebuff/common/types/session-state'
import { promptSuccess } from '@codebuff/common/util/error'
import { assistantMessage, userMessage } from '@codebuff/common/util/messages'
import { afterEach, describe, expect, it, mock } from 'bun:test'

import { createBase2 } from '../../../../agents/base2/base2'
import { loopAgentSteps } from '../run-agent-step'
import { clearAgentGeneratorCache } from '../run-programmatic-step'
import {
  getAdditionalSystemPrompt,
  parseCompactCommand,
} from '../system-prompt/prompts'
import { getAgentPrompt } from '../templates/strings'
import { PLACEHOLDER } from '../templates/types'
import { createBudgetLedger } from '../util/context-budget'
import { classifyContextOverflowError } from '../util/context-overflow'
import { NESTED_INSTRUCTION_FILES_TAG } from '../util/nested-instruction-files'
import { createToolCallChunk, mockFileContext } from './test-utils'

import type { AgentTemplate } from '../templates/types'
import type { AgentState } from '@codebuff/common/types/session-state'
import type { ProjectFileContext } from '@codebuff/common/util/file'

// N08: /compact [focus], instruction files in the prompt, nested
// instruction-file injection, and provider overflow recovery.

const OVERFLOW_WORDINGS: Array<[string, () => unknown]> = [
  [
    'OpenAI context_length_exceeded code',
    () =>
      Object.assign(new Error('Bad request'), {
        statusCode: 400,
        data: { error: { code: 'context_length_exceeded' } },
      }),
  ],
  [
    'Gemini',
    () =>
      new Error(
        'The input token count (1050000) exceeds the maximum number of tokens allowed (1048576).',
      ),
  ],
  [
    'Ollama',
    () =>
      Object.assign(new Error('Bad Request'), {
        statusCode: 400,
        responseBody:
          '{"error":"the input length exceeds the context length"}',
      }),
  ],
  [
    'LM Studio',
    () =>
      new Error(
        'Trying to keep the first 5000 tokens when context the overflows. However, the model is loaded with context length of only 4096 tokens, which is not enough.',
      ),
  ],
  [
    'vLLM',
    () =>
      new Error(
        'The decoder prompt (length 5000) is longer than the maximum model length of 4096. Make sure that `max_model_len` is no smaller than the number of text tokens.',
      ),
  ],
]

describe('classifyContextOverflowError', () => {
  it.each(OVERFLOW_WORDINGS)('recognises %s', (_name, makeError) => {
    expect(classifyContextOverflowError(makeError())).toBeDefined()
  })

  it('reads the reported limit when present', () => {
    expect(
      classifyContextOverflowError(OVERFLOW_WORDINGS[1][1]())
        ?.providerLimitTokens,
    ).toBe(1_048_576)
    expect(
      classifyContextOverflowError(OVERFLOW_WORDINGS[3][1]())
        ?.providerLimitTokens,
    ).toBe(4096)
    expect(
      classifyContextOverflowError(OVERFLOW_WORDINGS[4][1]())
        ?.providerLimitTokens,
    ).toBe(4096)
  })

  it('ignores rate limits and unrelated errors', () => {
    expect(
      classifyContextOverflowError(
        Object.assign(new Error('Too many tokens per minute: rate limit'), {
          statusCode: 429,
        }),
      ),
    ).toBeUndefined()
    expect(
      classifyContextOverflowError(new Error('socket hang up')),
    ).toBeUndefined()
  })
})

describe('parseCompactCommand', () => {
  it('parses the focus and rejects slashless prose', () => {
    expect(parseCompactCommand('/compact')).toEqual({})
    expect(parseCompactCommand('compact')).toEqual({})
    expect(parseCompactCommand('/compact keep the API notes')).toEqual({
      focus: 'keep the API notes',
    })
    expect(parseCompactCommand('compact the JSON file')).toBeUndefined()
    expect(getAdditionalSystemPrompt('/compact keep the API notes')).toContain(
      'keep the API notes',
    )
  })
})

describe('loopAgentSteps (N08)', () => {
  afterEach(() => {
    clearAgentGeneratorCache()
    mock.restore()
  })

  const setup = (fileContext: ProjectFileContext = mockFileContext) => {
    const {
      agentTemplate: _,
      localAgentTemplates: __,
      ...runtimeParams
    } = createTestAgentRuntimeParams()
    const agentTemplate = {
      id: 'test-agent',
      displayName: 'Test Agent',
      spawnerPrompt: 'Testing',
      model: 'claude-3-5-sonnet-20241022',
      inputSchema: {},
      outputMode: 'last_message',
      includeMessageHistory: true,
      inheritParentSystemPrompt: false,
      mcpServers: {},
      toolNames: ['read_files', 'end_turn'],
      spawnableAgents: [],
      systemPrompt: `Test system prompt\n${PLACEHOLDER.ROUTED_KNOWLEDGE_FILES}`,
      instructionsPrompt: '',
      stepPrompt: '',
      handleSteps: undefined,
    } satisfies AgentTemplate as AgentTemplate
    const sessionState = getInitialSessionState(fileContext)
    const agentState: AgentState = {
      ...sessionState.mainAgentState,
      agentId: 'test-agent-id',
      messageHistory: [
        userMessage('Look at the API module'),
        assistantMessage('The API module exposes three endpoints.'),
      ],
      output: undefined,
      stepsRemaining: 10,
    }
    const baseParams: Parameters<typeof loopAgentSteps>[0] = {
      ...runtimeParams,
      agentType: 'test-agent',
      localAgentTemplates: { 'test-agent': agentTemplate },
      repoId: undefined,
      repoUrl: undefined,
      userInputId: 'test-user-input',
      agentState,
      prompt: 'Continue',
      spawnParams: undefined,
      fingerprintId: 'test-fingerprint',
      fileContext,
      userId: TEST_USER_ID,
      clientSessionId: 'test-session',
      ancestorRunIds: [],
      onResponseChunk: () => {},
      signal: new AbortController().signal,
    }
    return { baseParams }
  }

  it.each(OVERFLOW_WORDINGS)(
    '%s overflow triggers one compaction and one retry',
    async (_name, makeError) => {
      const { baseParams } = setup()
      let llmCalls = 0
      const events: any[] = []
      const promptAiSdkStream = mock(async function* () {
        llmCalls++
        if (llmCalls === 1) throw makeError()
        yield { type: 'text' as const, text: 'Recovered\n' }
        yield createToolCallChunk('end_turn', {})
        return promptSuccess('overflow-retry')
      })
      const result = await loopAgentSteps({
        ...baseParams,
        promptAiSdkStream,
        onResponseChunk: (event) => events.push(event),
      })
      expect(llmCalls).toBe(2)
      expect(result.output).not.toMatchObject({ type: 'error' })
      const compactions = events.filter(
        (event) => event?.type === 'context_compaction',
      )
      expect(compactions).toHaveLength(1)
      expect(compactions[0].reason).toContain('over its context window')
      expect(
        events.filter(
          (event) =>
            event?.type === 'provider_status' && event.status === 'retrying',
        ),
      ).toHaveLength(1)
    },
  )

  it('retries an overflow only once', async () => {
    const { baseParams } = setup()
    let llmCalls = 0
    const events: any[] = []
    const promptAiSdkStream = mock(async function* () {
      llmCalls++
      throw OVERFLOW_WORDINGS[1][1]()
    })
    const result = await loopAgentSteps({
      ...baseParams,
      promptAiSdkStream,
      onResponseChunk: (event) => events.push(event),
    })
    expect(llmCalls).toBe(2)
    expect(result.output.type).toBe('error')
    expect(
      events.filter((event) => event?.type === 'context_compaction'),
    ).toHaveLength(1)
  })

  it('/compact keep the API notes compacts and keeps that focus', async () => {
    const { baseParams } = setup()
    let sentMessages: any[] = []
    const promptAiSdkStream = mock(async function* (params: any) {
      sentMessages = params.messages
      yield {
        type: 'text' as const,
        text: 'Goal: API work\nDecisions: None\nNext Action: continue',
      }
      return promptSuccess('compact')
    })
    const result = await loopAgentSteps({
      ...baseParams,
      prompt: '/compact keep the API notes',
      promptAiSdkStream,
    })
    // The model was told to keep the focus.
    expect(JSON.stringify(sentMessages)).toContain(
      'focus on: \\"keep the API notes\\"',
    )
    // History was replaced by one summary that carries the focus.
    const history = result.agentState.messageHistory
    const summary = JSON.stringify(history[0])
    expect(summary).toContain('<conversation_summary>')
    expect(summary).toContain('<compaction_focus>')
    expect(summary).toContain('keep the API notes')
    expect(JSON.stringify(history)).not.toContain(
      'The API module exposes three endpoints.',
    )
  })

  it('injects a nested instruction file once after the agent touches its directory', async () => {
    const fileContext: ProjectFileContext = {
      ...mockFileContext,
      knowledgeFiles: {
        'AGENTS.md': 'root rules',
        'pkg/AGENTS.md': 'pkg rules: keep the API stable',
      },
      instructionFiles: [
        { path: 'AGENTS.md', scope: 'project', chars: 10 },
        { path: 'pkg/AGENTS.md', scope: 'nested', chars: 30 },
      ],
    }
    const { baseParams } = setup(fileContext)
    const batches: any[][] = []
    let llmCalls = 0
    const promptAiSdkStream = mock(async function* (params: any) {
      batches.push(params.messages)
      llmCalls++
      if (llmCalls <= 2) {
        yield createToolCallChunk('read_files', {
          paths: [llmCalls === 1 ? 'README.md' : 'pkg/src/index.ts'],
        })
        return promptSuccess(`read-${llmCalls}`)
      }
      if (llmCalls === 3) {
        yield createToolCallChunk('read_files', { paths: ['pkg/other.ts'] })
        return promptSuccess('read-3')
      }
      yield createToolCallChunk('end_turn', {})
      return promptSuccess('done')
    })
    await loopAgentSteps({ ...baseParams, promptAiSdkStream })
    const count = (messages: any[]) =>
      messages.filter((message) =>
        message.tags?.includes(NESTED_INSTRUCTION_FILES_TAG),
      ).length
    // Not before pkg/ is touched; once afterwards, never twice.
    expect(count(batches[0])).toBe(0)
    expect(count(batches[1])).toBe(0)
    expect(count(batches[2])).toBe(1)
    expect(count(batches[3])).toBe(1)
    expect(JSON.stringify(batches[2])).toContain('pkg rules: keep the API stable')
  })
})

describe('instruction files in the system prompt', () => {
  const fileContext: ProjectFileContext = {
    ...mockFileContext,
    projectRoot: '/nonexistent-n08-project',
    cwd: '/nonexistent-n08-project',
    knowledgeFiles: {
      '../AGENTS.md': 'ROOT-AGENTS rules',
      '../CLAUDE.md': 'ROOT-CLAUDE rules',
      'AGENTS.md': 'PKG-AGENTS rules, see @docs/x.md',
      'docs/x.md': 'IMPORTED-X notes',
      'sub/AGENTS.md': 'NESTED-SUB rules',
    },
    instructionFiles: [
      { path: '../AGENTS.md', scope: 'ancestor', chars: 17 },
      { path: '../CLAUDE.md', scope: 'ancestor', chars: 17 },
      { path: 'AGENTS.md', scope: 'project', chars: 31 },
      { path: 'docs/x.md', scope: 'import', importedBy: 'AGENTS.md', chars: 16 },
      { path: 'sub/AGENTS.md', scope: 'nested', chars: 16 },
    ],
    userKnowledgeFiles: { '~/.knowledge.md': 'USER-NOTES' },
  }

  const render = async (systemPrompt: string) => {
    const agentTemplate = {
      id: 'n08-agent',
      displayName: 'N08',
      model: 'gpt-4o-mini',
      inputSchema: {},
      outputMode: 'last_message',
      includeMessageHistory: false,
      inheritParentSystemPrompt: false,
      mcpServers: {},
      toolNames: [],
      spawnableAgents: [],
      systemPrompt,
      instructionsPrompt: '',
      stepPrompt: '',
    } satisfies AgentTemplate as AgentTemplate
    const ledger = createBudgetLedger({ windowTokens: 200_000 })
    const prompt = await getAgentPrompt({
      agentTemplate,
      promptType: { type: 'systemPrompt' },
      fileContext,
      agentState: {
        ...getInitialSessionState(fileContext).mainAgentState,
        agentType: 'n08-agent',
      },
      agentTemplates: { 'n08-agent': agentTemplate },
      additionalToolDefinitions: async () => ({}),
      logger: { debug() {}, info() {}, warn() {}, error() {} },
      apiKey: TEST_AGENT_RUNTIME_IMPL.apiKey,
      databaseAgentCache: TEST_AGENT_RUNTIME_IMPL.databaseAgentCache,
      fetchAgentFromDatabase: TEST_AGENT_RUNTIME_IMPL.fetchAgentFromDatabase,
      ledger,
    } as Parameters<typeof getAgentPrompt>[0])
    return { prompt: prompt ?? '', ledger }
  }

  const occurrences = (text: string, needle: string) =>
    text.split(needle).length - 1

  it('renders ancestor, project and imported files once each, and nested files not at all', async () => {
    const { prompt, ledger } = await render(
      `${PLACEHOLDER.ROUTED_KNOWLEDGE_FILES}`,
    )
    for (const marker of [
      'ROOT-AGENTS',
      'ROOT-CLAUDE',
      'PKG-AGENTS',
      'IMPORTED-X',
      'USER-NOTES',
    ]) {
      expect(occurrences(prompt, marker)).toBe(1)
    }
    expect(prompt).not.toContain('NESTED-SUB')
    expect(
      ledger.lines
        .map((line) => line.label)
        .filter((label) => label.startsWith('instruction:')),
    ).toEqual([
      'instruction:../AGENTS.md',
      'instruction:../CLAUDE.md',
      'instruction:AGENTS.md',
      'instruction:docs/x.md',
      'instruction:~/.knowledge.md',
    ])
  })

  it('base2 carries one instruction-file placeholder', () => {
    const base2 = createBase2('default')
    const systemPrompt = String(base2.systemPrompt ?? '')
    expect(systemPrompt).toContain(PLACEHOLDER.ROUTED_KNOWLEDGE_FILES)
    expect(systemPrompt).not.toContain(PLACEHOLDER.KNOWLEDGE_FILES_CONTENTS)
  })
})
