/**
 * Accordion-style question component that can expand/collapse
 */

import React, { useCallback } from 'react'

import { CustomAnswerInput } from './custom-answer-input'
import { OptionsList } from './options-list'
import { QuestionHeader } from './question-header'
import {
  answerDisplayLines,
  formatStructuredAnswer,
} from '../utils/structured-answer'

import type { AskUserQuestion } from '../../../types/store'

/** Answer state for a single question */
export interface AccordionAnswer {
  selectedIndex?: number
  selectedIndices?: Set<number>
  isCustom?: boolean
  customText?: string
}

export interface AccordionQuestionProps {
  question: AskUserQuestion
  questionIndex: number
  totalQuestions: number
  answer: AccordionAnswer | undefined
  isExpanded: boolean
  isTypingCustom: boolean
  onToggleExpand: () => void
  onSelectOption: (optionIndex: number) => void
  onToggleOption: (optionIndex: number) => void
  onSetCustomText: (text: string, cursorPosition: number) => void
  onCustomSubmit: () => void
  customCursorPosition: number
  focusedOptionIndex: number | null
  onFocusOption: (index: number | null) => void
}

export const AccordionQuestion: React.FC<AccordionQuestionProps> = ({
  question,
  questionIndex,
  totalQuestions,
  answer,
  isExpanded,
  isTypingCustom,
  onToggleExpand,
  onSelectOption,
  onToggleOption,
  onSetCustomText,
  onCustomSubmit,
  customCursorPosition,
  focusedOptionIndex,
  onFocusOption,
}) => {
  const isMultiSelect = question.multiSelect
  const showQuestionNumber = totalQuestions > 1
  const questionNumber = questionIndex + 1
  const questionPrefix = showQuestionNumber ? `${questionNumber}. ` : ''
  const optionIndent = 2 + questionPrefix.length

  // Check if question has a valid answer
  const isAnswered =
    !!answer &&
    ((answer.isCustom && !!answer.customText?.trim()) ||
      (isMultiSelect && (answer.selectedIndices?.size ?? 0) > 0) ||
      answer.selectedIndex !== undefined)

  const getAnswerDisplay = (): string => {
    if (!answer) return '(click to answer)'
    const structured = formatStructuredAnswer(question, answer, questionIndex)
    const count =
      (structured.selectedOptions?.length ??
        (structured.selectedOption === undefined ? 0 : 1)) +
      (structured.otherText === undefined ? 0 : 1)
    if (!count) return '(click to answer)'
    const parts = answerDisplayLines({
      ...structured,
      selectedOptions: structured.selectedOptions?.slice(0, 2),
    }).map((part) => part.replace(/\s+/g, ' ').trim())
    return `${count} choice${count === 1 ? '' : 's'} · ${parts.join(' · ')}${parts.length < count ? ' …' : ''}`
  }

  const isCustomSelected = answer?.isCustom ?? false

  const handlePaste = useCallback(
    (text: string) => {
      const currentText = answer?.customText || ''
      const newText =
        currentText.slice(0, customCursorPosition) +
        text +
        currentText.slice(customCursorPosition)
      onSetCustomText(newText, customCursorPosition + text.length)
    },
    [answer?.customText, customCursorPosition, onSetCustomText],
  )

  return (
    <box style={{ flexDirection: 'column', marginBottom: 1, width: '100%' }}>
      {/* Question header - always visible */}
      <QuestionHeader
        questionText={question.question}
        questionPrefix={questionPrefix}
        isExpanded={isExpanded}
        isAnswered={isAnswered}
        answerDisplay={getAnswerDisplay()}
        onToggleExpand={onToggleExpand}
      />

      {/* Expanded content - options */}
      {isExpanded && (
        <box style={{ flexDirection: 'column', width: '100%' }}>
          <OptionsList
            question={question}
            answer={answer}
            optionIndent={optionIndent}
            focusedOptionIndex={focusedOptionIndex}
            isTypingCustom={isTypingCustom}
            onSelectOption={onSelectOption}
            onToggleOption={onToggleOption}
            onFocusOption={onFocusOption}
          />

          {/* Text input area when Custom is selected */}
          {isCustomSelected && (
            <CustomAnswerInput
              value={answer?.customText || ''}
              cursorPosition={customCursorPosition}
              focused={isTypingCustom}
              optionIndent={optionIndent}
              onChange={onSetCustomText}
              onSubmit={onCustomSubmit}
              onPaste={handlePaste}
            />
          )}
        </box>
      )}
    </box>
  )
}
