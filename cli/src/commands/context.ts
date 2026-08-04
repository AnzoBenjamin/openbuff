import { formatLedgerForCli } from '@codebuff/common/util/context-budget'
import { formatGateRepairBudgetsForCli } from '@codebuff/common/util/gate-repair-budgets'

import { useChatStore } from '../state/chat-store'
import { getSystemMessage } from '../utils/message-history'

import type { PostUserMessageFn } from '../types/contracts/send-message'

/**
 * Handles the /context command — displays the per-turn context token budget
 * breakdown recorded while assembling the current system prompt, then the
 * effective gate repair budgets (validation / reviewer / specialist).
 * Also accessible via the /ctx alias.
 *
 * On cached-prompt turns the breakdown reflects the turn that last rebuilt
 * the prompt. Gate repair budgets always resolve from env/defaults even when
 * no ledger exists yet.
 */
export function handleContextCommand(): {
  postUserMessage: PostUserMessageFn
} {
  const ledger =
    useChatStore.getState().runState?.sessionState?.mainAgentState
      .contextBudgetLedger

  const gateBudgets = formatGateRepairBudgetsForCli()
  const content = ledger
    ? `${formatLedgerForCli(ledger)}\n\n${gateBudgets}`
    : gateBudgets

  const postUserMessage: PostUserMessageFn = (prev) => [
    ...prev,
    getSystemMessage(content),
  ]

  return { postUserMessage }
}
