import { generateCompactId } from '@codebuff/common/util/string'
import { mapValues } from 'lodash'

import {
  validateAndGetAgentTemplate,
  validateAgentInput,
  executeSubagent,
  createAgentState,
  extractSubagentContextParams,
  buildSpawnParamsWithHandoff,
  deriveSpawnTemplateCapabilities,
  validateVersionedAgentHandoff,
  buildRuntimeAgentReceipt,
  reconcileAgentReceiptIntoParent,
} from './spawn-agent-utils'
import { appendOrchestrationEvent } from '../../../util/orchestration-ledger'
import { selectAgentAttempt } from '../../../orchestration/select-agent-attempt'
import { isContextPrunerAgentId } from '../../../util/runtime-semantic-compaction'
import {
  acquireWorkspacePathLease,
  releaseWorkspacePathLease,
} from '../../../util/workspace-path-leases'

import type { CodebuffToolHandlerFunction } from '../handler-function-type'
import type {
  CodebuffToolCall,
  CodebuffToolOutput,
} from '@codebuff/common/tools/list'
import type { AgentTemplate } from '@codebuff/common/types/agent-template'
import type { Logger } from '@codebuff/common/types/contracts/logger'
import type { ParamsExcluding } from '@codebuff/common/types/function-params'
import type { PrintModeEvent } from '@codebuff/common/types/print-mode'
import type { AgentState } from '@codebuff/common/types/session-state'
import type { ProjectFileContext } from '@codebuff/common/util/file'
import type { ToolSet } from 'ai'

type ToolName = 'spawn_agent_inline'
export const handleSpawnAgentInline = (async (
  params: {
    previousToolCallFinished: Promise<void>
    toolCall: CodebuffToolCall<ToolName>

    agentState: AgentState
    agentTemplate: AgentTemplate
    clientSessionId: string
    fileContext: ProjectFileContext
    fingerprintId: string
    localAgentTemplates: Record<string, AgentTemplate>
    logger: Logger
    system: string
    tools: ToolSet
    userId: string | undefined
    userInputId: string
    writeToClient: (chunk: string | PrintModeEvent) => void
  } & ParamsExcluding<
    typeof executeSubagent,
    | 'userInputId'
    | 'prompt'
    | 'spawnParams'
    | 'agentTemplate'
    | 'parentAgentState'
    | 'agentState'
    | 'parentSystemPrompt'
    | 'parentTools'
    | 'onResponseChunk'
    | 'clearUserPromptMessagesAfterResponse'
    | 'fingerprintId'
  >,
): Promise<{ output: CodebuffToolOutput<ToolName> }> => {
  const {
    previousToolCallFinished,
    toolCall,

    agentState: parentAgentState,
    agentTemplate: parentAgentTemplate,
    fingerprintId,
    system,
    tools: parentTools,
    userInputId,
    writeToClient,
    logger,
  } = params
  const {
    agent_type: agentTypeStr,
    prompt,
    params: spawnParams,
    handoff,
  } = toolCall.input

  await previousToolCallFinished

  const { agentTemplate, agentType } = await validateAndGetAgentTemplate({
    agentTypeStr,
    parentAgentTemplate,
    localAgentTemplates: params.localAgentTemplates,
    logger,
    fetchAgentFromDatabase: params.fetchAgentFromDatabase,
    databaseAgentCache: params.databaseAgentCache,
    apiKey: params.apiKey,
  })

  // Pruner identity is an agent-id question, not a string-equality one: the
  // parent may declare the pruner bare, publisher-qualified, or version-pinned,
  // and `validateAndGetAgentTemplate` resolves `agentType` to whatever was
  // declared. Every pruner-specific decision below keys off this single check so
  // the anti-thrash advisory, the parent-transcript write-back and the
  // silent-output contract hold identically for all three spellings.
  const isContextPruner = isContextPrunerAgentId(agentType)

  validateAgentInput(agentTemplate, agentType, prompt, spawnParams)
  validateVersionedAgentHandoff({ agentType, handoff })

  // Anti-thrash advisory published by `loopAgentSteps` for the current turn:
  // consecutive semantic passes measurably reclaimed no context space, so skip
  // this pruner spawn instead of paying for another thrashing pass.
  // Transient/loop-owned — never authoritative across turns. The trip itself is
  // warned once by the loop, so this per-skip path only logs at debug.
  //
  // Deliberately placed AFTER both validators — which are pure input checks
  // with no side effect this skip path depends on — so a malformed pruner spawn
  // keeps reporting its validation error while suppression is active instead of
  // silently reporting success.
  if (isContextPruner && parentAgentState.suppressSemanticCompaction === true) {
    logger.debug(
      {
        agentType,
        runId: parentAgentState.runId ?? parentAgentState.agentId,
      },
      'Skipped context-pruner spawn: semantic compaction is suppressed for this turn',
    )
    // Uniform envelope: every other return path of this handler returns
    // `{ result, agentReceipt }`. The receipt is built through the single
    // construction site because `agentReceiptSchema` is `.strict()`. A spawn the
    // runtime declined to execute is a cancellation, not a completion, and the
    // skip message travels in the receipt output so the reason survives.
    const skipMessage =
      'Semantic compaction skipped: consecutive compaction passes reclaimed no context space this turn. Continue without compacting, or reduce pinned state / start a fresh turn.'
    // `receipt.agentId` names the spawn, never the parent: a parent agentId here
    // makes the receipt read as if it described the parent run. Unlike the
    // executed path below, this id correlates with nothing persisted — the skip
    // returns before any `appendOrchestrationEvent` call and never reaches
    // `reconcileAgentReceiptIntoParent`, so no `spawn_started`/`spawn_finished`
    // ledger pair and no task-memory receipt record ever mention it. It exists
    // only so this envelope is shaped like the others; treat it as an opaque
    // per-skip marker, not a spawn id that can be looked up.
    const receipt = buildRuntimeAgentReceipt({
      agentType,
      agentId: generateCompactId(),
      handoff,
      spawnParams,
      output: { message: skipMessage },
      status: 'cancelled',
    })
    return {
      output: [
        {
          type: 'json',
          value: {
            result: receipt.output ?? { message: skipMessage },
            agentReceipt: receipt,
          },
        },
      ],
    }
  }

  const effectiveAgentTemplate = deriveSpawnTemplateCapabilities({
    agentTemplate,
    parentAgentTemplate,
    handoff,
    projectRoot: params.fileContext.projectRoot,
  })
  const contextWindowTokens = params.resolveModelContextWindow?.({
    agentId: effectiveAgentTemplate.id,
    model: effectiveAgentTemplate.model,
  })
  const selection = selectAgentAttempt({
    candidates: [
      {
        template: effectiveAgentTemplate,
        contextWindowTokens,
        explicitRoute: true,
      },
    ],
    requiredTools: handoff?.permissions.allowedTools ?? [],
    requiredWritablePaths: handoff?.permissions.writablePaths ?? [],
    minimumContextTokens:
      contextWindowTokens === undefined
        ? undefined
        : Math.max(
            2_048,
            Math.ceil(
              ((handoff ? JSON.stringify(handoff).length : 0) +
                (prompt?.length ?? 0)) /
                2,
            ),
          ),
    // Inline work is foreground and does not consume a background-agent slot.
    runningForRoot: 0,
    maxRunningForRoot: 8,
  })
  const runtimeSpawnParams = buildSpawnParamsWithHandoff({
    agentType,
    handoff,
    spawnParams,
  })

  // Inline context editors need the full parent transcript, but ordinary inline
  // specialists receive only bounded pinned operational memory by default.
  // This keeps each child's model window independent and avoids duplicating the
  // parent's system/tool baseline unless the child explicitly opts in.
  const editsParentMessageHistory =
    isContextPruner ||
    effectiveAgentTemplate.propagateMessageHistoryChanges === true
  const inlineMessageHistoryMode = editsParentMessageHistory
    ? 'full'
    : (effectiveAgentTemplate.messageHistoryMode ?? 'pinned')
  const inlineTemplate = {
    ...selection.candidate.template,
    includeMessageHistory: inlineMessageHistoryMode !== 'none',
    messageHistoryMode: inlineMessageHistoryMode,
    inheritParentSystemPrompt: isContextPruner
      ? true
      : effectiveAgentTemplate.inheritParentSystemPrompt,
  }

  // Create an isolated child state with the selected bounded transfer mode.
  const childAgentState: AgentState = {
    ...createAgentState(agentType, inlineTemplate, parentAgentState, {}),
    ...(inlineTemplate.inheritParentSystemPrompt
      ? {
          systemPrompt: system,
          toolDefinitions: mapValues(parentTools, (tool) => ({
            description: tool.description,
            inputSchema: tool.inputSchema as {},
          })),
        }
      : {}),
  }
  appendOrchestrationEvent({
    state: parentAgentState,
    event: {
      type: 'spawn_started',
      runId: parentAgentState.runId ?? parentAgentState.agentId,
      spawnId: childAgentState.agentId,
      taskId: handoff?.taskId,
      agentType,
      parentRunId: parentAgentState.runId ?? parentAgentState.agentId,
      capabilityId: selection.capabilityId,
      workspaceRevision: parentAgentState.workspaceState?.revision,
      workspaceSnapshotId: parentAgentState.workspaceState?.snapshotId,
    },
  })
  const leaseId = acquireWorkspacePathLease({
    state: parentAgentState,
    projectRoot: params.fileContext.projectRoot,
    ownerAgentId: childAgentState.agentId,
    taskId: handoff?.taskId,
    paths: handoff?.permissions.writablePaths ?? [],
  })
  // Extract common context params to avoid bugs from spreading all params
  const contextParams = extractSubagentContextParams(params)

  let result: Awaited<ReturnType<typeof executeSubagent>>
  try {
    result = await executeSubagent({
      ...contextParams,

      // Spawn-specific params
      ancestorRunIds: parentAgentState.ancestorRunIds,
      userInputId: `${userInputId}-inline-${agentType}${childAgentState.agentId}`,
      prompt: prompt || '',
      spawnParams: runtimeSpawnParams,
      agentTemplate: inlineTemplate,
      parentAgentState,
      agentState: childAgentState,
      fingerprintId,
      spawnToolCallId: toolCall.toolCallId,
      spawnIndex: 0,
      parentSystemPrompt: system,
      parentTools,
      onResponseChunk: (chunk: string | PrintModeEvent) => {
        // Inherits parent's onResponseChunk, except for context-pruner (TODO: add an option for it to be silent?)
        if (!isContextPruner) {
          if (typeof chunk === 'string') {
            writeToClient(chunk)
            return
          }

          // Tag child text events with the child's agentId so prose attributes to
          // the child block in the TUI (matches spawn_agents' text branch).
          // Preserve a pre-existing agentId (set by run-programmatic-step for
          // grandchild spawns) so deep inline nesting keeps correct text
          // attribution; fall back to the child's agentId for direct inline children.
          if (chunk.type === 'text') {
            if (chunk.text) {
              writeToClient({
                type: 'text',
                agentId: chunk.agentId ?? childAgentState.agentId,
                text: chunk.text,
              })
            }
            return
          }

          // Add parentAgentId for proper nesting in UI
          const ensureParentAgentId = (): string | undefined => {
            if (
              chunk.type === 'subagent_start' ||
              chunk.type === 'subagent_finish'
            ) {
              return chunk.parentAgentId ?? parentAgentState.agentId
            }
            if (chunk.type === 'tool_call' || chunk.type === 'tool_result') {
              // Tool events nest inside the child's own agent block. Preserve a
              // pre-existing parentAgentId (set by run-programmatic-step for
              // grandchild spawns) so deep inline nesting keeps correct lineage;
              // fall back to the child's agentId for direct inline children.
              return chunk.parentAgentId ?? childAgentState.agentId
            }
            return undefined
          }

          const parentAgentId = ensureParentAgentId()
          if (
            parentAgentId !== undefined &&
            (chunk.type === 'subagent_start' ||
              chunk.type === 'subagent_finish' ||
              chunk.type === 'tool_call' ||
              chunk.type === 'tool_result')
          ) {
            writeToClient({ ...chunk, parentAgentId })
            return
          }

          writeToClient(chunk)
        }
      },
      clearUserPromptMessagesAfterResponse: false,
    })
  } catch (error) {
    releaseWorkspacePathLease(parentAgentState, leaseId)
    throw error
  }

  // Ordinary inline agents never write their private transcript back into the
  // parent. Only explicit history-editor templates may propagate replacements.
  if (editsParentMessageHistory) {
    parentAgentState.messageHistory = result.agentState.messageHistory
  }
  const receipt = buildRuntimeAgentReceipt({
    agentType,
    agentId: result.agentState.agentId,
    handoff,
    spawnParams: runtimeSpawnParams,
    output: result.output,
    agentState: result.agentState,
  })
  reconcileAgentReceiptIntoParent({
    parentAgentState,
    receipt,
    agentType,
    objective: handoff?.objective,
  })
  releaseWorkspacePathLease(parentAgentState, leaseId)

  return {
    output: [
      {
        type: 'json',
        value: {
          result: receipt.output ?? {
            message: 'Agent completed without structured output.',
          },
          agentReceipt: receipt,
        },
      },
    ],
  }
}) satisfies CodebuffToolHandlerFunction<ToolName>
