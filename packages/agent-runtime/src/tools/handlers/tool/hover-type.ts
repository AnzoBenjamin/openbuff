import type { CodebuffToolHandlerFunction } from '../handler-function-type'
import type {
  ClientToolCall,
  CodebuffToolCall,
  CodebuffToolOutput,
} from '@codebuff/common/tools/list'

type ToolName = 'hover_type'

export const handleHoverType = (async ({
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
      toolName: 'hover_type',
      toolCallId: toolCall.toolCallId,
      input: {
        path: toolCall.input.path,
        line: toolCall.input.line,
        character: toolCall.input.character,
      },
    }),
  }
}) satisfies CodebuffToolHandlerFunction<ToolName>
