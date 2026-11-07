/**
 * Ask User Tool - Multiple choice form with accordion-style FAQ layout
 *
 * Shows all questions at once, each expandable to reveal options.
 */

import { TextAttributes } from '@opentui/core'
import { useKeyboard } from '@opentui/react'
import React, { useState, useCallback, useEffect, useRef } from 'react'

import {
  AccordionQuestion,
  type AccordionAnswer,
} from './components/accordion-question'
import {
  getOptionLabel,
  KEYBOARD_HINTS,
  CUSTOM_OPTION_INDEX,
} from './constants'
import { useTheme } from '../../hooks/use-theme'
import { useChatStore } from '../../state/chat-store'
import { isPlainEnterKey } from '../../utils/terminal-enter-detection'
import { BORDER_CHARS } from '../../utils/ui-constants'
import { Button } from '../button'
import {
  formatStructuredAnswer,
  type StructuredFormAnswer,
} from './utils/structured-answer'
import { validateOtherText } from './utils/validation'
import { useOutputReaderStore } from '../../state/output-reader-store'
import { createJsonDocument } from '../../utils/output-document'
import { useTerminalDimensions } from '../../hooks/use-terminal-dimensions'

import type { AskUserQuestion } from '../../types/store'
import type { KeyEvent } from '@opentui/core'
import { countInProgressDraftAnswers } from './skip-guard'

export interface MultipleChoiceFormProps {
  questions: AskUserQuestion[]
  onSubmit: (answers: StructuredFormAnswer[]) => void
  onSkip: () => void
  onStop?: () => void
}

export const MultipleChoiceForm: React.FC<MultipleChoiceFormProps> = ({
  questions,
  onSubmit,
  onSkip,
  onStop,
}) => {
  const theme = useTheme()
  const { terminalHeight } = useTerminalDimensions()
  const inspecting = useOutputReaderStore((state) => state.request !== null)
  const [isValidating, setIsValidating] = useState(false)
  const mountedRef = useRef(true)
  const settledRef = useRef(false)
  const questionsRef = useRef(questions)
  questionsRef.current = questions
  const submissionRef = useRef<{
    controller: AbortController
    questions: AskUserQuestion[]
    answers: Map<number, AccordionAnswer>
  } | null>(null)
  const cancelValidation = useCallback(() => {
    submissionRef.current?.controller.abort()
    submissionRef.current = null
    if (mountedRef.current) setIsValidating(false)
  }, [])
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      cancelValidation()
    }
  }, [cancelValidation])
  useEffect(() => {
    cancelValidation()
    settledRef.current = false
  }, [questions, cancelValidation])
  const inspectQuestions = () => {
    cancelValidation()
    useOutputReaderStore.getState().open({
      document: createJsonDocument(
        'questions',
        'Questions and choices',
        questions.map((question, index) => ({
          question: question.inspectionText ?? question.question,
          options: question.options,
          answer: formatStructuredAnswer(
            question,
            answersRef.current.get(index),
            index,
          ),
        })),
      ),
    })
  }
  const [validationError, setValidationError] = useState('')
  const terminalFocused = useChatStore((state) => state.inputFocused)
  const suppressNextHoverFocusRef = useRef(false)

  // Track which question is currently expanded (null = none)
  const [expandedIndex, setExpandedIndex] = useState<number | null>(
    questions.length > 0 ? 0 : null,
  )

  // Track answers for each question
  const [answers, setAnswers] = useState<Map<number, AccordionAnswer>>(
    new Map(),
  )
  const answersRef = useRef(answers)
  answersRef.current = answers

  // Track focused option within expanded question
  const [focusedOptionIndex, setFocusedOptionIndex] = useState<number | null>(
    questions.length > 0 ? 0 : null,
  )

  // Track which question has keyboard focus
  const [focusedQuestionIndex, setFocusedQuestionIndex] = useState<number>(0)

  // Track if submit button has focus (Tab navigation)
  const [submitFocused, setSubmitFocused] = useState<boolean>(false)

  const [submitHovered, setSubmitHovered] = useState<boolean>(false)

  const [showFocusHighlight, setShowFocusHighlight] = useState<boolean>(true)

  const [lastFocusBeforeSubmit, setLastFocusBeforeSubmit] = useState<{
    questionIndex: number
    optionIndex: number
  } | null>(null)

  // Esc/Skip confirmation (shard-cli-tui finding: ask-user Esc data-loss).
  // When any question already holds user input, the first Esc (or Ctrl+C)
  // only warns; a second press confirms the skip so a stray keypress can no
  // longer silently discard the whole form.
  const [confirmingSkip, setConfirmingSkip] = useState<boolean>(false)
  const [confirmAction, setConfirmAction] = useState<'skip' | 'stop'>('skip')
  const requestDiscard = (action: 'skip' | 'stop') => {
    cancelValidation()
    if (settledRef.current) return
    if (
      countInProgressDraftAnswers(answers) &&
      (!confirmingSkip || confirmAction !== action)
    ) {
      setConfirmAction(action)
      setConfirmingSkip(true)
      return
    }
    settledRef.current = true
    if (action === 'stop' && onStop) onStop()
    else onSkip()
  }

  // Track if user is typing in "Custom" text input
  const [isTypingCustom, setIsTypingCustom] = useState<boolean>(false)

  // Track cursor position for "Custom" text input (per question)
  const [customCursorPositions, setCustomCursorPositions] = useState<
    Map<number, number>
  >(new Map())

  const setAnswerForQuestion = useCallback(
    (
      questionIndex: number,
      updater: (previous: AccordionAnswer | undefined) => AccordionAnswer,
    ) => {
      cancelValidation()
      const nextAnswers = new Map(answersRef.current)
      const previousAnswer = nextAnswers.get(questionIndex) ?? {}
      nextAnswers.set(questionIndex, updater(previousAnswer))
      answersRef.current = nextAnswers
      setAnswers(nextAnswers)
    },
    [cancelValidation],
  )

  const openQuestion = useCallback(
    (questionIndex: number, optionIndex: number) => {
      setExpandedIndex(questionIndex)
      setFocusedQuestionIndex(questionIndex)
      setFocusedOptionIndex(optionIndex)
      setSubmitFocused(false)
      setIsTypingCustom(false)
      setConfirmingSkip(false)
    },
    [],
  )

  const focusSubmit = useCallback(
    (from?: { questionIndex: number; optionIndex: number }) => {
      const optionIndex = from?.optionIndex ?? focusedOptionIndex ?? 0
      const questionIndex = from?.questionIndex ?? focusedQuestionIndex
      setLastFocusBeforeSubmit({ questionIndex, optionIndex })
      setSubmitFocused(true)
      setIsTypingCustom(false)
    },
    [focusedOptionIndex, focusedQuestionIndex],
  )

  // Handle setting "Custom" text (with cursor position)
  const handleSetCustomText = useCallback(
    (questionIndex: number, text: string, cursorPosition: number) => {
      setAnswerForQuestion(questionIndex, (currentAnswer) => ({
        ...currentAnswer,
        isCustom: true,
        customText: text,
      }))
      setCustomCursorPositions((prev) => {
        const newPositions = new Map(prev)
        newPositions.set(questionIndex, cursorPosition)
        return newPositions
      })
    },
    [setAnswerForQuestion],
  )

  // Handle "Custom" text submit (Enter key)
  const handleCustomSubmit = useCallback(
    (questionIndex: number) => {
      setIsTypingCustom(false)
      setSubmitFocused(false)

      if (questions[questionIndex]?.multiSelect) {
        return
      }

      if (questionIndex < questions.length - 1) {
        openQuestion(questionIndex + 1, 0)
        return
      }

      focusSubmit({
        questionIndex,
        optionIndex: questions[questionIndex]?.options.length ?? 0,
      })
    },
    [questions, openQuestion, focusSubmit],
  )

  // Handle selecting an option (single-select)
  const handleSelectOption = useCallback(
    (
      questionIndex: number,
      optionIndex: number,
      source: 'keyboard' | 'mouse' = 'keyboard',
    ) => {
      setSubmitFocused(false)
      const isCustomOption = optionIndex === CUSTOM_OPTION_INDEX

      if (source === 'mouse' && !isCustomOption) {
        setShowFocusHighlight(false)
        suppressNextHoverFocusRef.current = true
      }

      setAnswerForQuestion(questionIndex, (currentAnswer) =>
        isCustomOption
          ? {
              // Selecting "Custom" should clear any single-select choice
              selectedIndex: undefined,
              selectedIndices: undefined,
              isCustom: true,
              customText: currentAnswer?.customText || '',
            }
          : {
              selectedIndex: optionIndex,
              selectedIndices: undefined,
              isCustom: false,
              customText: currentAnswer?.customText, // Preserve custom text when switching away
            },
      )

      // For "Custom" option, enter typing mode
      if (isCustomOption) {
        setFocusedQuestionIndex(questionIndex)
        setFocusedOptionIndex(questions[questionIndex]?.options.length ?? 0)
        setIsTypingCustom(true)
        return
      }

      if (questionIndex < questions.length - 1) {
        openQuestion(questionIndex + 1, 0)
        return
      }

      // For last/only question, collapse to show answer summary
      setExpandedIndex(null)
      focusSubmit({ questionIndex, optionIndex })
    },
    [
      questions,
      openQuestion,
      focusSubmit,
      setAnswerForQuestion,
      isTypingCustom,
    ],
  )

  // Handle toggling an option (multi-select)
  const handleToggleOption = useCallback(
    (questionIndex: number, optionIndex: number) => {
      setSubmitFocused(false)
      setConfirmingSkip(false)
      cancelValidation()
      let toggledCustomOn = false
      const newAnswers = new Map(answersRef.current)
      const currentAnswer: AccordionAnswer = newAnswers.get(questionIndex) ?? {}

      if (optionIndex === CUSTOM_OPTION_INDEX) {
        toggledCustomOn = !(currentAnswer?.isCustom ?? false)
        newAnswers.set(questionIndex, {
          ...currentAnswer,
          selectedIndices: new Set(currentAnswer?.selectedIndices ?? []),
          isCustom: !currentAnswer?.isCustom,
          customText: currentAnswer?.customText || '',
        })
      } else {
        const newIndices = new Set(currentAnswer?.selectedIndices ?? [])
        if (newIndices.has(optionIndex)) {
          newIndices.delete(optionIndex)
        } else {
          newIndices.add(optionIndex)
        }
        newAnswers.set(questionIndex, {
          ...currentAnswer,
          selectedIndices: newIndices,
          isCustom: currentAnswer?.isCustom ?? false,
        })
      }
      answersRef.current = newAnswers
      setAnswers(newAnswers)

      // For "Custom" option in multi-select, also enter typing mode
      if (optionIndex === CUSTOM_OPTION_INDEX) {
        setIsTypingCustom(toggledCustomOn)
      }
    },
    [cancelValidation],
  )

  const draftAnswerCount = countInProgressDraftAnswers(answers)

  // Handle submit
  const handleSubmit = useCallback(async () => {
    if (settledRef.current || submissionRef.current) return
    const submission = {
      controller: new AbortController(),
      questions,
      answers: answersRef.current,
    }
    // Install the owner before awaiting worker validation or accepting another Enter.
    submissionRef.current = submission
    setIsValidating(true)
    const ownsSubmission = () =>
      mountedRef.current &&
      !submission.controller.signal.aborted &&
      submissionRef.current === submission &&
      questionsRef.current === submission.questions &&
      answersRef.current === submission.answers
    try {
      for (let index = 0; index < submission.questions.length; index++) {
        const answer = submission.answers.get(index)
        if (answer?.isCustom) {
          const result = await validateOtherText(
            answer.customText ?? '',
            submission.questions[index].validation,
            500,
            submission.controller.signal,
          )
          if (!ownsSubmission()) return
          if (!result.isValid) {
            setValidationError(`Question ${index + 1}: ${result.error}`)
            openQuestion(index, questions[index]?.options.length ?? 0)
            setIsTypingCustom(true)
            return
          }
        }
      }
      if (!ownsSubmission() || useOutputReaderStore.getState().request !== null)
        return
      setValidationError('')
      const formattedAnswers = submission.questions.map((question, index) =>
        formatStructuredAnswer(question, submission.answers.get(index), index),
      )
      settledRef.current = true
      onSubmit(formattedAnswers)
    } finally {
      if (submissionRef.current === submission) {
        submissionRef.current = null
        if (mountedRef.current) setIsValidating(false)
      }
    }
  }, [questions, onSubmit, openQuestion])

  // Keyboard navigation using OpenTUI's useKeyboard hook
  useKeyboard(
    useCallback(
      (key: KeyEvent) => {
        if (inspecting) return
        if (key.ctrl && key.name === 'c' && onStop) {
          key.preventDefault()
          requestDiscard('stop')
          return
        }
        if (!isTypingCustom && key.name === 'i') {
          key.preventDefault()
          inspectQuestions()
          return
        }
        // Helper to prevent default behavior
        const preventDefault = () => {
          if (
            'preventDefault' in key &&
            typeof key.preventDefault === 'function'
          ) {
            key.preventDefault()
          }
        }

        // Escape or Ctrl+C to skip/close the form. An in-progress draft
        // makes the first press show a confirmation instead of an immediate
        // discard (shard-cli-tui finding: ask-user Esc data-loss).
        if (key.name === 'escape' || (key.ctrl && key.name === 'c')) {
          preventDefault()
          requestDiscard(confirmingSkip ? confirmAction : 'skip')
          return
        }

        if (confirmingSkip && key.name === 'n') {
          key.preventDefault()
          setConfirmingSkip(false)
          return
        }

        if (!showFocusHighlight) {
          setShowFocusHighlight(true)
        }

        // Handle submit button focus
        if (submitFocused) {
          if (key.name === 'up' || (key.name === 'tab' && key.shift)) {
            preventDefault()
            setIsTypingCustom(false)
            setSubmitFocused(false)
            if (questions.length === 0) return
            if (lastFocusBeforeSubmit) {
              openQuestion(
                lastFocusBeforeSubmit.questionIndex,
                lastFocusBeforeSubmit.optionIndex,
              )
            } else {
              openQuestion(questions.length - 1, 0)
            }
            return
          }
          if (isPlainEnterKey(key) || key.name === 'space') {
            preventDefault()
            handleSubmit()
            return
          }
          return
        }

        if (key.name === 'tab' && !key.shift) {
          preventDefault()
          focusSubmit()
          return
        }

        // When typing in "Custom" input, let MultilineInput handle all keyboard input
        if (isTypingCustom) {
          return
        }

        if (questions.length === 0) {
          return
        }

        const currentQuestionIndex = Math.min(
          Math.max(focusedQuestionIndex, 0),
          questions.length - 1,
        )
        const currentQuestion = questions[currentQuestionIndex]
        const optionCount = currentQuestion.options.length + 1
        const lastOptionIndex = optionCount - 1
        const currentOptionIndex = Math.min(
          Math.max(focusedOptionIndex ?? 0, 0),
          lastOptionIndex,
        )

        if (key.name === 'right') {
          preventDefault()
          if (expandedIndex !== currentQuestionIndex) {
            openQuestion(currentQuestionIndex, 0)
          }
          return
        }

        if (key.name === 'left') {
          preventDefault()
          if (expandedIndex !== null) {
            setExpandedIndex(null)
            setFocusedOptionIndex(null)
          }
          return
        }

        if (key.name === 'down') {
          preventDefault()

          if (expandedIndex === null) {
            openQuestion(currentQuestionIndex, 0)
            return
          }

          if (currentOptionIndex < lastOptionIndex) {
            setFocusedOptionIndex(currentOptionIndex + 1)
            return
          }

          if (currentQuestionIndex < questions.length - 1) {
            openQuestion(currentQuestionIndex + 1, 0)
            return
          }

          focusSubmit({
            questionIndex: currentQuestionIndex,
            optionIndex: currentOptionIndex,
          })
          return
        }

        if (key.name === 'up') {
          preventDefault()

          if (expandedIndex === null) {
            if (currentQuestionIndex > 0) {
              const previousQuestionIndex = currentQuestionIndex - 1
              const previousOptionCount =
                (questions[previousQuestionIndex]?.options.length ?? 0) + 1
              openQuestion(previousQuestionIndex, previousOptionCount - 1)
            }
            return
          }

          if (currentOptionIndex > 0) {
            setFocusedOptionIndex(currentOptionIndex - 1)
            return
          }

          if (currentQuestionIndex > 0) {
            const previousQuestionIndex = currentQuestionIndex - 1
            const previousOptionCount =
              (questions[previousQuestionIndex]?.options.length ?? 0) + 1
            openQuestion(previousQuestionIndex, previousOptionCount - 1)
          }
          return
        }

        if (isPlainEnterKey(key) || key.name === 'space') {
          preventDefault()

          if (expandedIndex === null) {
            openQuestion(currentQuestionIndex, 0)
            return
          }

          const optionIdx =
            currentOptionIndex === lastOptionIndex
              ? CUSTOM_OPTION_INDEX
              : currentOptionIndex
          if (currentQuestion.multiSelect) {
            handleToggleOption(currentQuestionIndex, optionIdx)
          } else {
            handleSelectOption(currentQuestionIndex, optionIdx, 'keyboard')
          }
          return
        }
      },
      [
        questions,
        expandedIndex,
        focusedQuestionIndex,
        focusedOptionIndex,
        submitFocused,
        lastFocusBeforeSubmit,
        isTypingCustom,
        showFocusHighlight,
        answers,
        inspecting,
        confirmingSkip,
        confirmAction,
        handleSelectOption,
        handleToggleOption,
        handleSubmit,
        onSkip,
        onStop,
        openQuestion,
        focusSubmit,
      ],
    ),
  )

  // Sync focusedQuestionIndex when expandedIndex changes
  useEffect(() => {
    if (expandedIndex !== null) {
      setFocusedQuestionIndex(expandedIndex)
    }
  }, [expandedIndex])

  useEffect(() => {
    if (!terminalFocused) {
      setSubmitHovered(false)
    }
  }, [terminalFocused])

  return (
    <box style={{ flexDirection: 'column', padding: 0, width: '100%' }}>
      {/* Close button in top-right */}
      <box
        style={{
          flexDirection: 'row',
          justifyContent: 'flex-end',
          marginBottom: 0,
          width: '100%',
        }}
      >
        <Button
          onClick={() => requestDiscard('skip')}
          style={{
            padding: 0,
          }}
        >
          <text style={{ fg: theme.muted }}>Skip questions</text>
        </Button>
        <Button onClick={() => inspectQuestions()}>
          <text fg={theme.primary}>Inspect (I)</text>
        </Button>
        {onStop && (
          <Button onClick={() => requestDiscard('stop')}>
            <text fg={theme.error}>Stop run</text>
          </Button>
        )}
      </box>

      {/* All questions in accordion style */}
      <scrollbox
        scrollX={false}
        style={{ maxHeight: Math.max(3, terminalHeight - 8) }}
      >
        {questions
          .slice(focusedQuestionIndex, focusedQuestionIndex + 1)
          .map((question, visibleIndex) => {
            const index = focusedQuestionIndex + visibleIndex
            return (
              <AccordionQuestion
                key={index}
                question={question}
                questionIndex={index}
                totalQuestions={questions.length}
                answer={answers.get(index)}
                isExpanded={expandedIndex === index}
                isTypingCustom={
                  isTypingCustom && expandedIndex === index && !inspecting
                }
                onToggleExpand={() => {
                  const nextExpandedIndex =
                    expandedIndex === index ? null : index
                  setExpandedIndex(nextExpandedIndex)
                  setFocusedQuestionIndex(index)
                  setSubmitFocused(false)
                  setIsTypingCustom(false)
                  setFocusedOptionIndex(nextExpandedIndex === null ? null : 0)
                }}
                onSelectOption={(optionIndex) =>
                  handleSelectOption(index, optionIndex, 'mouse')
                }
                onToggleOption={(optionIndex) =>
                  handleToggleOption(index, optionIndex)
                }
                onSetCustomText={(text, cursorPos) =>
                  handleSetCustomText(index, text, cursorPos)
                }
                onCustomSubmit={() => handleCustomSubmit(index)}
                customCursorPosition={customCursorPositions.get(index) ?? 0}
                focusedOptionIndex={
                  expandedIndex === index &&
                  !submitFocused &&
                  showFocusHighlight
                    ? focusedOptionIndex
                    : null
                }
                onFocusOption={(optionIndex) => {
                  if (!terminalFocused || isTypingCustom) return
                  if (suppressNextHoverFocusRef.current) {
                    suppressNextHoverFocusRef.current = false
                    return
                  }
                  setShowFocusHighlight(true)
                  setSubmitFocused(false)
                  setFocusedQuestionIndex(index)
                  if (expandedIndex !== index) {
                    setExpandedIndex(index)
                  }
                  setFocusedOptionIndex(optionIndex)
                }}
              />
            )
          })}
      </scrollbox>
      {validationError && <text fg={theme.error}>{validationError}</text>}

      {/* Skip confirmation (shard-cli-tui finding: ask-user Esc data-loss): */}
      {confirmingSkip ? (
        <text style={{ wrapMode: 'word', fg: theme.primary, marginRight: 1 }}>
          {`${confirmAction === 'stop' ? 'Stop current run and discard' : 'Skip questions and discard'} ${draftAnswerCount} draft answer${draftAnswerCount === 1 ? '' : 's'}? ${confirmAction === 'stop' ? 'Queued work stays paused.' : 'Run resumes without answers.'} Esc confirms · N keeps editing`}
        </text>
      ) : null}

      {/* Footer: submit + keyboard hints */}
      <box
        style={{
          flexDirection: 'row',
          justifyContent: 'flex-start',
          alignItems: 'center',
          width: '100%',
          gap: 1,
        }}
      >
        <box style={{ flexShrink: 0 }}>
          <Button
            onClick={handleSubmit}
            onMouseOver={() => {
              if (!terminalFocused) return
              setSubmitHovered(true)
            }}
            onMouseOut={() => {
              setSubmitHovered(false)
            }}
            style={{
              borderStyle: 'single',
              borderColor:
                submitFocused || (submitHovered && terminalFocused)
                  ? theme.primary
                  : theme.muted,
              customBorderChars: BORDER_CHARS,
              paddingLeft: 2,
              paddingRight: 2,
            }}
          >
            <text
              style={{
                fg:
                  submitFocused || (submitHovered && terminalFocused)
                    ? theme.primary
                    : theme.muted,
                attributes:
                  submitFocused || (submitHovered && terminalFocused)
                    ? TextAttributes.BOLD
                    : undefined,
              }}
            >
              {isValidating ? 'Checking answers…' : 'Submit'}
            </text>
          </Button>
        </box>

        <box
          style={{
            flexDirection: 'row',
            flexWrap: 'wrap',
            alignItems: 'center',
            flexShrink: 1,
            minWidth: 0,
          }}
        >
          {(terminalHeight < 25
            ? ['↑↓ choices', 'Tab submit', 'I inspect']
            : KEYBOARD_HINTS
          ).map((hint, idx) => (
            <text
              key={hint}
              wrapMode="none"
              style={{
                fg: theme.muted,
                marginRight: idx === KEYBOARD_HINTS.length - 1 ? 0 : 1,
              }}
            >
              {hint}
            </text>
          ))}
        </box>
      </box>
    </box>
  )
}
