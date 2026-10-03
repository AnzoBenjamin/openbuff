import type { CodebuffToolHandlerFunction } from '../handler-function-type'
import type {
  ClientToolCall,
  CodebuffToolCall,
  CodebuffToolOutput,
} from '@codebuff/common/tools/list'

type ToolName = 'find_references'

export const handleFindReferences = (async ({
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
      toolName: 'find_references',
      toolCallId: toolCall.toolCallId,
      input: {
        path: toolCall.input.path,
        line: toolCall.input.line,
        character: toolCall.input.character,
      },
    }),
  }
}) satisfies CodebuffToolHandlerFunction<ToolName>
