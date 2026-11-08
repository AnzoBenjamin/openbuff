import { describe, expect, test } from 'bun:test'
import { TEST_AGENT_RUNTIME_IMPL } from '@codebuff/common/testing/impl/agent-runtime'
import { getInitialSessionState } from '@codebuff/common/types/session-state'
import { hashActionInput } from '@codebuff/common/util/action-outcomes'
import type { AgentTemplate } from '@codebuff/common/types/agent-template'
import type { SupervisedSpawnRequest } from '@codebuff/common/types/contracts/agent-runtime'
import type { ExecutionHostOperationOrigin, ToolExecutionIdentity } from '@codebuff/common/types/contracts/client'
import type { StartAgentRunFn } from '@codebuff/common/types/contracts/database'
import { runRuntimeSemanticCompaction } from '../util/runtime-semantic-compaction'
import { maybeRunBackgroundConsolidation } from '../util/context-consolidation-runner'
import { mockFileContext } from './test-utils'

const template = (id: string): AgentTemplate => ({ id, displayName: id, mcpServers: {}, toolNames: [], spawnableAgents: ['context-pruner'],
  systemPrompt: '', instructionsPrompt: '', stepPrompt: '', inputSchema: {}, outputMode: 'last_message',
  includeMessageHistory: true, inheritParentSystemPrompt: false })
function fixture() {
  const state = getInitialSessionState(mockFileContext).mainAgentState
  state.agentId = 'registered-parent-agent'
  state.runId = 'registered-parent-run'
  state.ancestorRunIds = ['registered-root-run']
  const basis = { inputHash: hashActionInput('spawn_agents', { agents: [] }) }
  const stale: ToolExecutionIdentity = { runId: 'old-ancestor-run', rootRunId: 'registered-root-run', agentId: 'old-ancestor-agent',
    actionId: 'old-action', attemptId: 'old-attempt', basis,
    basisId: hashActionInput('openbuff.execution-b02-basis.v1', { basis, workspaceSnapshotId: null }) }
  const params = { ...TEST_AGENT_RUNTIME_IMPL, agentState: state, agentTemplate: template('parent'),
    localAgentTemplates: { 'context-pruner': template('context-pruner') }, fileContext: mockFileContext,
    clientSessionId: 'session', fingerprintId: 'fingerprint', userId: undefined, userInputId: 'input',
    repoId: undefined, repoUrl: undefined, signal: new AbortController().signal,
    system: '', tools: {}, executionIdentity: stale }
  const actor = { runId: state.runId, rootRunId: state.ancestorRunIds[0], agentId: state.agentId }
  return { state, params, actor }
}

describe('runtime infrastructure child origins', () => {
  test('semantic compaction clears inherited B02 identity before in-process registration', async () => {
    const f = fixture()
    let captured: (Parameters<StartAgentRunFn>[0] & { executionIdentity?: ToolExecutionIdentity; executionHostOperation?: ExecutionHostOperationOrigin }) | undefined
    await runRuntimeSemanticCompaction({ ...f.params, startAgentRun: async input => {
      captured = input
      throw new Error('fixture stops before provider work')
    } } as Parameters<typeof runRuntimeSemanticCompaction>[0])
    expect(captured).toBeDefined()
    expect(captured?.executionIdentity).toBeUndefined()
    expect(captured?.executionHostOperation).toEqual({ actor: f.actor, purpose: 'semantic-compaction' })
    expect(captured?.ancestorRunIds).toEqual(['registered-root-run', 'registered-parent-run'])
  })

  test('snapshot consolidation carries explicit host operation across the supervised request boundary', async () => {
    const f = fixture()
    f.state.compactionArchive = [{ archivedAt: 1, action: 'semantic_compaction', keepRecentSteps: 1,
      messages: [{ role: 'assistant', content: [{ type: 'text', text: 'archived fixture' }] }] }]
    let complete!: (request: SupervisedSpawnRequest) => void
    const captured = new Promise<SupervisedSpawnRequest>(resolve => { complete = resolve })
    maybeRunBackgroundConsolidation({ ...f.params, processSupervision: true,
      agentTemplate: { ...f.params.agentTemplate, programmaticConfig: { backgroundSnapshotConsolidation: true } },
      spawnSupervised: async request => {
        complete(request)
        return { outcome: 'crashed', crashReason: 'fixture-no-process', exitCode: 1, durationMs: 0,
          stdoutBytes: 0, killed: false, stderrTail: '' }
      },
    } as Parameters<typeof maybeRunBackgroundConsolidation>[0])
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const request = await Promise.race([captured, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('No supervised request')), 1000) })])
      expect(request.executionIdentity).toBeUndefined()
      expect(request.executionHostOperation).toEqual({ actor: f.actor, purpose: 'snapshot-consolidation' })
      expect(request.agentType).toBe('context-consolidator')
      expect(request.ancestorRunIds).toEqual(['registered-root-run', 'registered-parent-run'])
      expect(JSON.stringify(request)).not.toContain('old-action')
    } finally { if (timer) clearTimeout(timer) }
  })
})
