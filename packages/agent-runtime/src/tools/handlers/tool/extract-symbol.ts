import type { CodebuffToolHandlerFunction } from '../handler-function-type'
import type {
  ClientToolCall,
  CodebuffToolCall,
  CodebuffToolOutput,
} from '@codebuff/common/tools/list'

type ToolName = 'extract_symbol'

export const handleExtractSymbol = (async ({
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
      toolName: 'extract_symbol',
      toolCallId: toolCall.toolCallId,
      input: {
        path: toolCall.input.path,
        line: toolCall.input.line,
        character: toolCall.input.character,
        destination_path: toolCall.input.destination_path,
        symbol_name: toolCall.input.symbol_name,
      },
    }),
  }
}) satisfies CodebuffToolHandlerFunction<ToolName>
