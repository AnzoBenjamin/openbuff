import type { CodebuffToolHandlerFunction } from '../handler-function-type'
import type {
  ClientToolCall,
  CodebuffToolCall,
  CodebuffToolOutput,
} from '@codebuff/common/tools/list'

type ToolName = 'go_to_definition'

export const handleGoToDefinition = (async ({
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
      toolName: 'go_to_definition',
      toolCallId: toolCall.toolCallId,
      input: {
        path: toolCall.input.path,
        line: toolCall.input.line,
        character: toolCall.input.character,
      },
    }),
  }
}) satisfies CodebuffToolHandlerFunction<ToolName>
