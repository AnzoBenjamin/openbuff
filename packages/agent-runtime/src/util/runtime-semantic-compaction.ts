import {
  normalizeAgentIdForLookup,
  parseAgentId,
} from '@codebuff/common/util/agent-id-parsing'
import { mapValues } from 'lodash'

import { getAgentTemplate } from '../templates/agent-registry'

import type { executeSubagent } from '../tools/handlers/tool/spawn-agent-utils'
import type { AgentTemplate } from '@codebuff/common/types/agent-template'
import type { Logger } from '@codebuff/common/types/contracts/logger'
import type { ParamsExcluding } from '@codebuff/common/types/function-params'
import type { AgentState } from '@codebuff/common/types/session-state'
import type { ToolSet } from 'ai'

const CONTEXT_PRUNER_AGENT_ID = 'context-pruner'

/**
 * Canonical pruner-identity check, shared by both pruner spawn paths.
 *
 * A consumer may declare the pruner bare (`context-pruner`),
 * publisher-qualified (`acme/context-pruner`), or version-pinned
 * (`acme/context-pruner@1.2.3`), and the spawn-permission contract resolves the
 * agent type to whatever was declared. Every pruner-specific decision — the
 * recursion guard here, and the anti-thrash advisory, transcript write-back and
 * silent-output contract on the `spawn_agent_inline` path — must compare agent
 * IDs through this helper instead of string-equality against the bare literal,
 * otherwise a declared publisher/version pin silently changes behavior.
 */
export function isContextPrunerAgentId(
  agentId: string | null | undefined,
): boolean {
  if (!agentId) {
    return false
  }
  const { agentId: bareAgentId } = parseAgentId(
    normalizeAgentIdForLookup(agentId),
  )
  return bareAgentId === CONTEXT_PRUNER_AGENT_ID
}

/**
 * Runtime-driven semantic context compaction for prompt-only agent templates.
 *
 * Invariant owned by this module: a template with no `handleSteps` generator
 * still gets a semantic pruner pass, built exactly the way `spawn_agent_inline`
 * builds the inline pruner (full parent transcript, inherited system prompt and
 * tool baseline, suppressed child output, transcript written back to the
 * parent) — including the same spawn-permission contract, so a template that
 * never declared `context-pruner` in `spawnableAgents` never pays for the pass.
 * The pass is strictly best-effort — it may never abort the agent turn,
 * because the mechanical emergency brake downstream is the real guarantee.
 */
export async function runRuntimeSemanticCompaction(
  params: {
    /** Parent state to compact. Its `messageHistory` is replaced in place. */
    agentState: AgentState
    /** Parent's resolved template, used only for the recursion guard. */
    agentTemplate: AgentTemplate
    localAgentTemplates: Record<string, AgentTemplate>
    logger: Logger
    /** Parent system prompt, inherited by the pruner child. */
    system: string
    /** Parent tool surface, inherited by the pruner child. */
    tools: ToolSet
    userInputId: string
  } & ParamsExcluding<
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
  >,
): Promise<{ ran: boolean }> {
  const {
    agentState: parentAgentState,
    agentTemplate,
    localAgentTemplates,
    logger,
    system,
    tools,
    userInputId,
  } = params
  const runId = parentAgentState.runId ?? parentAgentState.agentId

  // Recursion guard: the pruner's own run evaluates this same semantic trigger,
  // so a run that IS the pruner must never drive a nested runtime pass. Matched
  // by pruner identity rather than string equality so a publisher-qualified or
  // version-pinned pruner still recognizes itself.
  if (
    isContextPrunerAgentId(agentTemplate.id) ||
    isContextPrunerAgentId(parentAgentState.agentType)
  ) {
    return { ran: false }
  }

  // Same transient, loop-owned anti-thrash advisory the inline pruner spawn
  // honors: consecutive semantic passes measurably reclaimed no space, so stop
  // paying for another one this turn. Never authoritative across turns.
  if (parentAgentState.suppressSemanticCompaction === true) {
    logger.debug(
      { agentType: CONTEXT_PRUNER_AGENT_ID, runId },
      'Skipped runtime semantic compaction: semantic compaction is suppressed for this turn',
    )
    return { ran: false }
  }

  try {
    // Loaded at call time on purpose. `spawn-agent-utils` imports
    // `loopAgentSteps` from `run-agent-step`, and `run-agent-step` imports this
    // module, so a static import here closes a module cycle whose symptom is an
    // `undefined` binding at module init rather than a clean error. Do not
    // "clean this up" into a static import.
    const {
      createAgentState,
      executeSubagent,
      extractSubagentContextParams,
      getMatchingSpawn,
      isBaseAgent,
    } = await import('../tools/handlers/tool/spawn-agent-utils')

    // Same spawn-permission contract `validateAndGetAgentTemplate` applies to
    // the generator-driven `spawn_agent_inline` pruner: base agents may spawn
    // anything, every other template must declare `context-pruner` in
    // `spawnableAgents`. A consumer-authored agent that never declared it must
    // not silently pay for a child LLM run whose output rewrites this parent's
    // transcript.
    const parentIsBaseAgent = isBaseAgent(agentTemplate.id)
    const declaredPrunerSpawn = parentIsBaseAgent
      ? undefined
      : getMatchingSpawn(
          agentTemplate.spawnableAgents ?? [],
          CONTEXT_PRUNER_AGENT_ID,
        )
    if (!parentIsBaseAgent && !declaredPrunerSpawn) {
      logger.debug(
        {
          agentType: CONTEXT_PRUNER_AGENT_ID,
          parentAgentType: agentTemplate.id,
          runId,
        },
        'Skipped runtime semantic compaction: context-pruner is not declared in the parent template spawnableAgents',
      )
      return { ran: false }
    }

    // Spawn exactly what the consumer declared. `getMatchingSpawn` grants
    // permission from the declaration, so the declared entry — including any
    // publisher and version pin — is the id that must be resolved and run;
    // resolving the bare `context-pruner` instead would silently ignore that pin
    // for the agent that rewrites this parent's transcript. Base agents have no
    // declaration to honor and keep the canonical bare id.
    const prunerAgentId = declaredPrunerSpawn ?? CONTEXT_PRUNER_AGENT_ID
    const prunerTemplate =
      localAgentTemplates[prunerAgentId] ??
      (await getAgentTemplate({ ...params, agentId: prunerAgentId }))
    if (!prunerTemplate) {
      logger.debug(
        { agentType: prunerAgentId, runId },
        'Skipped runtime semantic compaction: context-pruner template could not be resolved',
      )
      return { ran: false }
    }

    // Mirrors the pruner-specific inline setup: the context editor needs the
    // full parent transcript and the parent's system/tool baseline, otherwise it
    // cannot faithfully rewrite what the parent will send next.
    const prunerChildTemplate: AgentTemplate = {
      ...prunerTemplate,
      includeMessageHistory: true,
      messageHistoryMode: 'full',
      inheritParentSystemPrompt: true,
    }
    const childAgentState: AgentState = {
      ...createAgentState(
        prunerAgentId,
        prunerChildTemplate,
        parentAgentState,
        {},
      ),
      systemPrompt: system,
      toolDefinitions: mapValues(tools, (tool) => ({
        description: tool.description,
        inputSchema: tool.inputSchema as {},
      })),
    }

    const result = await executeSubagent({
      ...extractSubagentContextParams(params),

      ancestorRunIds: parentAgentState.ancestorRunIds,
      userInputId: `${userInputId}-inline-${prunerAgentId}${childAgentState.agentId}`,
      prompt: '',
      spawnParams: undefined,
      agentTemplate: prunerChildTemplate,
      parentAgentState,
      agentState: childAgentState,
      fingerprintId: params.fingerprintId,
      parentSystemPrompt: system,
      parentTools: tools,
      // The pruner is infrastructure, not conversation: its output stays
      // invisible, matching the inline path's pruner-identity suppression.
      onResponseChunk: () => {},
      clearUserPromptMessagesAfterResponse: false,
    })

    // Only the transcript propagates back, exactly like the inline path's
    // `editsParentMessageHistory` branch.
    parentAgentState.messageHistory = result.agentState.messageHistory
    return { ran: true }
  } catch (error) {
    // Non-fatal by design: a pruner failure must never abort the agent turn.
    // The deterministic mechanical brake still runs downstream.
    logger.warn(
      { error, agentType: CONTEXT_PRUNER_AGENT_ID, runId },
      'Runtime-driven semantic compaction failed (non-fatal)',
    )
    return { ran: false }
  }
}
