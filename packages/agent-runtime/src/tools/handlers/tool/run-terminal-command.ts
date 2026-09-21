import { resolveRuntimeJobOwner } from '../../../util/runtime-job-owner'

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
  const clientToolCall: ClientToolCall<ToolName> = {
    toolName: 'run_terminal_command',
    toolCallId: toolCall.toolCallId,
    input: {
      command: toolCall.input.command,
      mode: 'assistant',
      // Forward the terminal permission profile the agent's template declares
      // (terminalPermissionProfile); templates that do not declare one keep
      // the permissive 'full-access' default. The value is always taken from
      // the template, never from model/tool input, so a narrower profile
      // cannot be widened at call time. High-impact action approval (e.g.
      // force push) is a separate gate and still applies.
      permission_profile:
        agentTemplate?.terminalPermissionProfile ?? 'full-access',
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
  } as ClientToolCall<ToolName>
  await previousToolCallFinished
  return { output: await requestClientToolCall(clientToolCall) }
}) satisfies CodebuffToolHandlerFunction<ToolName>
