import { formatLedgerForCli } from '@codebuff/common/util/context-budget'

import { useChatStore } from '../state/chat-store'
import { getSystemMessage } from '../utils/message-history'

import type { PostUserMessageFn } from '../types/contracts/send-message'

/**
 * Handles the /context command — displays the per-turn context token budget
 * breakdown recorded while assembling the current system prompt.
 * Also accessible via the /ctx alias.
 *
 * On cached-prompt turns the breakdown reflects the turn that last rebuilt
 * the prompt.
 */
export function handleContextCommand(): {
  postUserMessage: PostUserMessageFn
} {
  const ledger =
    useChatStore.getState().runState?.sessionState?.mainAgentState
      .contextBudgetLedger

  const content = ledger
    ? formatLedgerForCli(ledger)
    : 'No context budget data yet — send a message first.'

  const postUserMessage: PostUserMessageFn = (prev) => [
    ...prev,
    getSystemMessage(content),
  ]

  return { postUserMessage }
}
