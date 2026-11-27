import { getOptionLabel } from '../constants'
import type { AccordionAnswer } from '../components/accordion-question'
import type { AskUserQuestion } from '../../../types/store'

export interface StructuredFormAnswer {
  questionIndex: number
  selectedOption?: string
  selectedOptions?: string[]
  otherText?: string
}

/** Display each selected value separately; custom text never replaces choices. */
export function answerDisplayLines(
  answer: Partial<StructuredFormAnswer>,
): string[] {
  const selected =
    answer.selectedOptions ??
    (answer.selectedOption === undefined ? [] : [answer.selectedOption])
  return [
    ...selected.map((label) => `Selected: ${label}`),
    ...(answer.otherText === undefined ? [] : [`Custom: ${answer.otherText}`]),
  ]
}
export function formatStructuredAnswer(
  question: AskUserQuestion,
  answer: AccordionAnswer | undefined,
  questionIndex: number,
): StructuredFormAnswer {
  const selected = question.multiSelect
    ? [...(answer?.selectedIndices ?? [])].sort((a, b) => a - b)
    : answer?.isCustom
      ? []
      : answer?.selectedIndex === undefined
        ? []
        : [answer.selectedIndex]
  const labels = selected
    .filter((index) => index >= 0 && index < question.options.length)
    .map((index) => getOptionLabel(question.options[index]))
  return {
    questionIndex,
    ...(question.multiSelect && labels.length
      ? { selectedOptions: labels }
      : !question.multiSelect && labels.length
        ? { selectedOption: labels[0] }
        : {}),
    ...(answer?.isCustom && answer.customText?.trim()
      ? { otherText: answer.customText.trim() }
      : {}),
  }
}
