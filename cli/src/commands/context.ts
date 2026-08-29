import { formatLedgerForCli } from '@codebuff/common/util/context-budget'
import { formatGateRepairBudgetsForCli } from '@codebuff/common/util/gate-repair-budgets'

import { useChatStore } from '../state/chat-store'
import { getSystemMessage } from '../utils/message-history'

import type { ContextContentBlock } from '../types/chat'
import type { PostUserMessageFn } from '../types/contracts/send-message'

export function buildContextContentBlock(): ContextContentBlock {
  const ledger =
    useChatStore.getState().runState?.sessionState?.mainAgentState
      .contextBudgetLedger

  const gateBudgetsText = formatGateRepairBudgetsForCli()
  const ledgerText = ledger ? formatLedgerForCli(ledger) : null

  return {
    type: 'context',
    ledgerText,
    gateBudgetsText,
  }
}

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
  const block = buildContextContentBlock()
  const gateBudgets = block.gateBudgetsText
  const content = block.ledgerText
    ? `${block.ledgerText}\n\n${gateBudgets}`
    : gateBudgets

  const postUserMessage: PostUserMessageFn = (prev) => {
    const msg = getSystemMessage([block], content)
    return [...prev, msg]
  }

  return { postUserMessage }
}
