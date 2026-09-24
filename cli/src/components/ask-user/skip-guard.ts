/**
 * Pure skip-guard decision helpers extracted from MultipleChoiceForm so the
 * Esc/Ctrl+C confirmation behavior (shard-cli-tui finding: ask-user Esc
 * data-loss) is directly unit-testable without an OpenTUI render.
 */

import type { AccordionAnswer } from './components/accordion-question'

export type SkipGuardAction = 'skip' | 'warn'

/**
 * Counts questions that already hold user input (an in-progress draft that
 * would be discarded by an unconfirmed skip).
 */
export const countInProgressDraftAnswers = (
  answers: ReadonlyMap<number, AccordionAnswer>,
): number => {
  let count = 0
  for (const answer of answers.values()) {
    const hasCustomText =
      answer.isCustom && !!answer.customText && answer.customText.trim() !== ''
    const hasSingle = answer.selectedIndex !== undefined
    const hasMulti = (answer.selectedIndices?.size ?? 0) > 0
    if (hasCustomText || hasSingle || hasMulti) count++
  }
  return count
}

/**
 * Esc/Ctrl+C routing: with no draft present, skip immediately (the close
 * button keeps its no-confirmation path). With a draft and no prior warning,
 * the first press only warns; a second press confirms the skip.
 */
export const nextEscapeAction = (
  draftCount: number,
  confirmingSkip: boolean,
): SkipGuardAction => {
  if (draftCount === 0) return 'skip'
  return confirmingSkip ? 'skip' : 'warn'
}
