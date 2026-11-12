import { formatLedgerForCli } from '@codebuff/common/util/context-budget'
import { formatGateRepairBudgetsForCli } from '@codebuff/common/util/gate-repair-budgets'
import {
  NESTED_INSTRUCTION_FILES_TAG,
  formatInstructionFilesForCli,
} from '@codebuff/common/util/instruction-files'

import { useChatStore } from '../state/chat-store'
import { getSystemMessage } from '../utils/message-history'

import type { ContextContentBlock } from '../types/chat'
import type { PostUserMessageFn } from '../types/contracts/send-message'

const INJECTED_MARKER = /<instruction_file path="([^"]+)">/g

function nestedInjectedPaths(
  messages: ReadonlyArray<{ tags?: string[]; content: unknown }>,
): Set<string> {
  const injected = new Set<string>()
  for (const message of messages) {
    if (!message.tags?.includes(NESTED_INSTRUCTION_FILES_TAG)) continue
    const parts = Array.isArray(message.content) ? message.content : []
    for (const part of parts) {
      if (part?.type !== 'text' || typeof part.text !== 'string') continue
      for (const match of part.text.matchAll(INJECTED_MARKER)) {
        injected.add(match[1])
      }
    }
  }
  return injected
}

export function buildContextContentBlock(): ContextContentBlock {
  const sessionState = useChatStore.getState().runState?.sessionState
  const ledger = sessionState?.mainAgentState.contextBudgetLedger

  const gateBudgetsText = formatGateRepairBudgetsForCli()
  const ledgerText = ledger ? formatLedgerForCli(ledger) : null
  // N08: the instruction files in effect, from the session's load records,
  // the ledger lines recorded while building the prompt, and the nested
  // files the runtime already injected.
  const fileContext = sessionState?.fileContext
  const instructionFilesText = fileContext
    ? formatInstructionFilesForCli({
        instructionFiles: fileContext.instructionFiles,
        knowledgeFiles: fileContext.knowledgeFiles,
        userKnowledgeFiles: fileContext.userKnowledgeFiles,
        ledgerLabels: ledger
          ? new Set(
              (Array.isArray(ledger.lines) ? ledger.lines : [])
                .map((line) => line?.label)
                .filter((label): label is string => typeof label === 'string'),
            )
          : undefined,
        injectedNested: nestedInjectedPaths(
          sessionState?.mainAgentState.messageHistory ?? [],
        ),
      })
    : ''

  return {
    type: 'context',
    ledgerText,
    gateBudgetsText,
    ...(instructionFilesText ? { instructionFilesText } : {}),
  }
}

/**
 * Handles the /context command — displays the per-turn context token budget
 * breakdown recorded while assembling the current system prompt, then the
 * effective gate repair budgets (validation / reviewer / specialist), then
 * the instruction files in effect (N08).
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
  const budgetContent = block.ledgerText
    ? `${block.ledgerText}\n\n${gateBudgets}`
    : gateBudgets
  const content = block.instructionFilesText
    ? `${budgetContent}\n\n${block.instructionFilesText}`
    : budgetContent

  const postUserMessage: PostUserMessageFn = (prev) => {
    const msg = getSystemMessage([block], content)
    return [...prev, msg]
  }

  return { postUserMessage }
}
