import { getSystemMessage, getUserMessage } from '../utils/message-history'
import type { ContentBlock } from '../types/chat'
import type { RouterParams } from './command-registry'

/** Consume the submitted command before awaiting; update only its own operation row. */
export async function runLocalCommandOperation(
  params: RouterParams,
  input: string,
  label: string,
  operation: () => Promise<
    ContentBlock | string | { blocks: ContentBlock[]; content: string }
  >,
): Promise<void> {
  params.saveToHistory(input)
  if (!params.preserveInputValue)
    params.setInputValue({
      text: '',
      cursorPosition: 0,
      lastEditDueToNav: false,
    })
  const pending = {
    ...getSystemMessage(
      `${label}: running local operation. Your new draft is preserved while this completes.`,
    ),
    isComplete: false,
  }
  params.setMessages((messages) => [
    ...messages,
    getUserMessage(input),
    pending,
  ])
  let completed
  try {
    const result = await operation()
    completed =
      typeof result === 'string'
        ? getSystemMessage(result)
        : 'type' in result
          ? getSystemMessage([result])
          : getSystemMessage(result.blocks, result.content)
  } catch (error) {
    completed = getSystemMessage(
      `${label} failed: ${error instanceof Error ? error.message : String(error)}. Retry the command when ready.`,
    )
  }
  params.setMessages((messages) =>
    messages.map((message) =>
      message.id === pending.id ? { ...completed, id: pending.id } : message,
    ),
  )
}
