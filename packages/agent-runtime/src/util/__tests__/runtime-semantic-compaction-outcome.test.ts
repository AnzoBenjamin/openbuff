import { describe, expect, test } from 'bun:test'
import { TEST_AGENT_RUNTIME_IMPL } from '@codebuff/common/testing/impl/agent-runtime'
import { getInitialSessionState } from '@codebuff/common/types/session-state'

import { mockFileContext } from '../../__tests__/test-utils'
import { runRuntimeSemanticCompaction } from '../runtime-semantic-compaction'

import type { AgentTemplate } from '@codebuff/common/types/agent-template'

// memory-context-06: a skipped or failed runtime pass is reported to the
// caller (and from there on the compaction card), never only logged.

const template = (id: string, spawnableAgents: string[]): AgentTemplate => ({
  id,
  displayName: id,
  mcpServers: {},
  toolNames: [],
  spawnableAgents,
  systemPrompt: '',
  instructionsPrompt: '',
  stepPrompt: '',
  inputSchema: {},
  outputMode: 'last_message',
  includeMessageHistory: true,
  inheritParentSystemPrompt: false,
})

function params(parent: AgentTemplate, startAgentRun?: () => Promise<never>) {
  const state = getInitialSessionState(mockFileContext).mainAgentState
  state.agentId = 'parent-agent'
  state.runId = 'parent-run'
  state.ancestorRunIds = ['root-run']
  const messageHistory = state.messageHistory
  return {
    state,
    messageHistory,
    input: {
      ...TEST_AGENT_RUNTIME_IMPL,
      ...(startAgentRun ? { startAgentRun } : {}),
      agentState: state,
      agentTemplate: parent,
      localAgentTemplates: {
        'context-pruner': template('context-pruner', []),
      },
      fileContext: mockFileContext,
      clientSessionId: 'session',
      fingerprintId: 'fingerprint',
      userId: undefined,
      userInputId: 'input',
      repoId: undefined,
      repoUrl: undefined,
      signal: new AbortController().signal,
      system: '',
      tools: {},
    } as unknown as Parameters<typeof runRuntimeSemanticCompaction>[0],
  }
}

describe('runRuntimeSemanticCompaction outcome', () => {
  test('a custom agent without context-pruner in spawnableAgents is reported skipped with a reason', async () => {
    const f = params(template('my-custom-agent', []))
    const outcome = await runRuntimeSemanticCompaction(f.input)
    expect(outcome.outcome).toBe('skipped')
    if (outcome.outcome === 'completed') throw new Error('unreachable')
    expect(outcome.reason).toContain('spawnableAgents')
    expect(outcome.reason).toContain('my-custom-agent')
    // The transcript is untouched.
    expect(f.state.messageHistory).toBe(f.messageHistory)
  })

  test('a pruner that throws is reported failed with the error', async () => {
    const f = params(template('my-custom-agent', ['context-pruner']), async () => {
      throw new Error('pruner exploded')
    })
    const outcome = await runRuntimeSemanticCompaction(f.input)
    expect(outcome.outcome).toBe('failed')
    if (outcome.outcome === 'completed') throw new Error('unreachable')
    expect(outcome.reason).toContain('pruner exploded')
  })
})
