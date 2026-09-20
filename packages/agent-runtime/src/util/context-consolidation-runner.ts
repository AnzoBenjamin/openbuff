import {
  CONSOLIDATOR_AGENT_ID,
  CONSOLIDATOR_SYSTEM_PROMPT,
  buildConsolidationPrompt,
  extractLastText,
  recordConsolidation,
  selectUnconsolidatedSnapshots,
} from './context-consolidation'

import type { ContextConsolidation } from '@codebuff/common/types/context-consolidation'
import type { executeSubagent } from '../tools/handlers/tool/spawn-agent-utils'
import type { AgentTemplate } from '@codebuff/common/types/agent-template'
import type { ParamsExcluding } from '@codebuff/common/types/function-params'
import type { AgentState } from '@codebuff/common/types/session-state'

/** One consolidation per parent state at a time (in-process guard). */
const activeConsolidations = new WeakSet<object>()

/** Synthetic prompt-only consolidator child: no tools, no history, no write-back. */
const buildConsolidatorTemplate = (): AgentTemplate => ({
  id: CONSOLIDATOR_AGENT_ID,
  displayName: 'Context Consolidator',
  mcpServers: {},
  toolNames: [],
  spawnableAgents: [],
  systemPrompt: CONSOLIDATOR_SYSTEM_PROMPT,
  instructionsPrompt: '',
  stepPrompt: '',
  inputSchema: {},
  includeMessageHistory: false,
  inheritParentSystemPrompt: false,
  outputMode: 'last_message',
})

/**
 * Fire-and-forget background consolidation of unconsolidated archive
 * snapshots. The caller does NOT await: the child LLM run must never delay
 * the agent step. Canary-gated OFF by default — only a template whose
 * `programmaticConfig.backgroundSnapshotConsolidation === true` pays for the
 * background child. The child is a synthetic prompt-only template with NO
 * tools and NO transcript write-back, so its only product is the summary
 * string recorded on the parent state. Spawn permission is intentionally NOT
 * consulted: the child is runtime infrastructure with its own synthetic
 * template, not a consumer-visible agent.
 */
/**
 * The spawn-context fields the runner does NOT build itself; the caller
 * forwards them (run-agent-step spreads its loop params, exactly like
 * `runRuntimeSemanticCompaction` receives them). Type-only import: erased at
 * runtime, so the spawn-agent-utils -> run-agent-step module cycle stays
 * broken.
 */
type ConsolidationSpawnContext = ParamsExcluding<
  typeof executeSubagent,
  | 'agentState'
  | 'agentTemplate'
  | 'ancestorRunIds'
  | 'clearUserPromptMessagesAfterResponse'
  | 'onResponseChunk'
  | 'parentAgentState'
  | 'parentSystemPrompt'
  | 'parentTools'
  | 'prompt'
  | 'spawnParams'
  | 'userInputId'
>

export function maybeRunBackgroundConsolidation(
  params: {
    agentState: AgentState
    agentTemplate: Pick<AgentTemplate, 'id' | 'programmaticConfig'>
    userInputId: string
  } & ConsolidationSpawnContext,
): void {
  const { agentState, agentTemplate, logger, userInputId } = params
  try {
    if (agentTemplate.programmaticConfig?.backgroundSnapshotConsolidation !== true) return
    if (activeConsolidations.has(agentState)) return
    const snapshots = selectUnconsolidatedSnapshots(
      agentState.compactionArchive,
      agentState.contextConsolidations,
    )
    if (snapshots.length === 0) return
    activeConsolidations.add(agentState)

    const runId = agentState.runId ?? agentState.agentId
    // Fire-and-forget by design: the promise is deliberately not returned.
    void (async () => {
      try {
        // Dynamic import on purpose: spawn-agent-utils -> run-agent-step is a
        // module cycle (same reason runtime-semantic-compaction defers it).
        const { createAgentState, executeSubagent, extractSubagentContextParams } =
          await import('../tools/handlers/tool/spawn-agent-utils')
        const template = buildConsolidatorTemplate()
        const childAgentState = createAgentState(
          CONSOLIDATOR_AGENT_ID,
          template,
          agentState,
          {},
        )
        const result = await executeSubagent({
          ...extractSubagentContextParams(params),
          agentState: childAgentState,
          agentTemplate: template,
          parentAgentState: agentState,
          ancestorRunIds: agentState.ancestorRunIds,
          userInputId: `${userInputId}-consolidate`,
          prompt: buildConsolidationPrompt(snapshots),
          spawnParams: undefined,
          fingerprintId: params.fingerprintId,
          parentSystemPrompt: '',
          parentTools: {},
          onResponseChunk: () => {},
          clearUserPromptMessagesAfterResponse: false,
        })
        const summary = extractLastText(result.agentState.messageHistory)
        if (summary.length > 0) {
          const consolidation: ContextConsolidation = {
            consolidatedAt: Date.now(),
            sourceArchivedAts: snapshots.map((s) => s.archivedAt),
            action: snapshots[0].action,
            summary,
            coveredMessages: snapshots.reduce((n, s) => n + s.messages.length, 0),
          }
          recordConsolidation(agentState, consolidation)
        }
      } catch (error) {
        // Non-fatal by design: a background consolidation failure must never
        // surface to the agent turn; the verbatim archive remains the source
        // of truth.
        logger.warn(
          { error, agentType: CONSOLIDATOR_AGENT_ID, runId },
          'Background snapshot consolidation failed (non-fatal)',
        )
      } finally {
        activeConsolidations.delete(agentState)
      }
    })()
  } catch (error) {
    logger.debug(
      { error, agentType: agentTemplate.id },
      'Failed to start background consolidation',
    )
  }
}
