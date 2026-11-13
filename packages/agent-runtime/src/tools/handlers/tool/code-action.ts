import type { CodebuffToolHandlerFunction } from '../handler-function-type'
import type {
  ClientToolCall,
  CodebuffToolCall,
  CodebuffToolOutput,
} from '@codebuff/common/tools/list'

type ToolName = 'code_action'

export const handleCodeAction = (async ({
  previousToolCallFinished,
  toolCall,
  requestClientToolCall,
}: {
  previousToolCallFinished: Promise<void>
  toolCall: CodebuffToolCall<ToolName>
  requestClientToolCall: (
    toolCall: ClientToolCall<ToolName>,
  ) => Promise<CodebuffToolOutput<ToolName>>
}) => {
  await previousToolCallFinished
  return {
    output: await requestClientToolCall({
      toolName: 'code_action',
      toolCallId: toolCall.toolCallId,
      input: {
        path: toolCall.input.path,
        line: toolCall.input.line,
        character: toolCall.input.character,
        kind: toolCall.input.kind,
      },
    }),
  }
}) satisfies CodebuffToolHandlerFunction<ToolName>
