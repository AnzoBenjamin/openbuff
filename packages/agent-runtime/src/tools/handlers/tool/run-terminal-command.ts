import { resolveRuntimeJobOwner } from '../../../util/runtime-job-owner'
import {
  PLAN_MODE_READ_ONLY_ERROR_CODE,
  isPlanLineage,
  recordPlanLineageJob,
} from '../../plan-mode-guard'

import type { CodebuffToolHandlerFunction } from '../handler-function-type'
import type {
  ClientToolCall,
  CodebuffToolCall,
  CodebuffToolOutput,
} from '@codebuff/common/tools/list'
import type { AgentTemplate } from '@codebuff/common/types/agent-template'
import type { AgentState } from '@codebuff/common/types/session-state'

type ToolName = 'run_terminal_command'
export const handleRunTerminalCommand = (async ({
  previousToolCallFinished,
  toolCall,
  agentTemplate,
  spawnParams,
  agentState,
  clientSessionId,
  requestClientToolCall,
}: {
  previousToolCallFinished: Promise<void>
  toolCall: CodebuffToolCall<ToolName>
  agentTemplate: AgentTemplate
  spawnParams?: Record<string, unknown>
  agentState: AgentState
  clientSessionId: string
  requestClientToolCall: (
    toolCall: ClientToolCall<ToolName>,
  ) => Promise<CodebuffToolOutput<ToolName>>
}): Promise<{ output: CodebuffToolOutput<ToolName> }> => {
  const planLineage = isPlanLineage(agentTemplate)
  const permissionProfile = resolveTerminalPermissionProfile(agentTemplate)
  const clientToolCall: ClientToolCall<ToolName> = {
    toolName: 'run_terminal_command',
    toolCallId: toolCall.toolCallId,
    input: {
      command: toolCall.input.command,
      mode: 'assistant',
      // The agent's declared profile, never model input. Plan lineage is
      // clamped to read-only (N03). The SDK enforces read-only and
      // workspace-write declarations as an upper bound on the host profile;
      // see sdk/src/tools/terminal-profile-bound.ts for which profiles bind.
      permission_profile: permissionProfile,
      allowed_paths: Array.isArray(spawnParams?.owned_paths)
        ? spawnParams.owned_paths.filter(
            (value): value is string => typeof value === 'string',
          )
        : undefined,
      process_type: toolCall.input.process_type,
      detach: toolCall.input.detach,
      timeout_seconds: toolCall.input.timeout_seconds,
      cwd: toolCall.input.cwd,
      owner: resolveRuntimeJobOwner({ clientSessionId, agentState }),
      approval_receipt_id:
        typeof spawnParams?.approval_receipt_id === 'string'
          ? spawnParams.approval_receipt_id
          : typeof spawnParams?.approvalReceiptId === 'string'
            ? spawnParams.approvalReceiptId
            : undefined,
    },
  }
  await previousToolCallFinished
  const output = await requestClientToolCall(clientToolCall)
  if (!planLineage) return { output }
  return {
    output: annotatePlanLineageOutput({
      output,
      clientSessionId,
      agentState,
    }),
  }
}) satisfies CodebuffToolHandlerFunction<ToolName>

type TerminalPermissionProfile = NonNullable<
  ClientToolCall<ToolName>['input']['permission_profile']
>

/**
 * The profile forwarded to the host: `read-only` in plan lineage, otherwise
 * the template's declared profile. Agents that declare none keep the previous
 * `full-access` default, so default execute-mode behaviour is unchanged.
 */
export function resolveTerminalPermissionProfile(
  agentTemplate: Pick<
    AgentTemplate,
    'programmaticConfig' | 'terminalPermissionProfile'
  >,
): TerminalPermissionProfile {
  if (isPlanLineage(agentTemplate)) return 'read-only'
  return agentTemplate.terminalPermissionProfile ?? 'full-access'
}

/**
 * Plan-lineage post-processing: a policy denial gets the typed
 * `plan_mode_read_only` code, and a started background job is recorded so the
 * lineage may later kill it.
 */
function annotatePlanLineageOutput(params: {
  output: CodebuffToolOutput<ToolName>
  clientSessionId: string
  agentState: AgentState
}): CodebuffToolOutput<ToolName> {
  const { output, clientSessionId, agentState } = params
  return output.map((part) => {
    if (part.type !== 'json' || !part.value || typeof part.value !== 'object')
      return part
    const value = part.value as Record<string, unknown>
    if (typeof value.jobId === 'string') {
      recordPlanLineageJob({ clientSessionId, agentState, jobId: value.jobId })
    }
    if (value.permissionDenied !== true) return part
    const message =
      typeof value.errorMessage === 'string' ? value.errorMessage : ''
    return {
      ...part,
      value: {
        ...value,
        errorCode: PLAN_MODE_READ_ONLY_ERROR_CODE,
        errorMessage: `${PLAN_MODE_READ_ONLY_ERROR_CODE}: plan mode runs terminal commands read-only. ${message}`.trim(),
      },
    }
  }) as CodebuffToolOutput<ToolName>
}
