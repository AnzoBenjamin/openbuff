import { useCallback, useEffect, useRef } from 'react'
import stringWidth from 'string-width'

import { useChatStore } from '../state/chat-store'
import type { InputMode } from '../utils/input-modes'
import { getInputModeConfig } from '../utils/input-modes'

import type { InputValue } from '../types/store'
import type { AgentMode } from '../utils/constants'

interface UseChatInputOptions {
  setInputValue: (value: InputValue) => void
  agentMode: AgentMode
  setAgentMode: (mode: AgentMode) => void
  separatorWidth: number
  initialPrompt: string | null
  onSubmitPrompt: (content: string, mode: AgentMode) => void | Promise<unknown>
  isCompactHeight: boolean
  isNarrowWidth: boolean
  /**
   * Columns the active mode's label/icon box occupies in front of the input
   * text. The input row renders that box as a flex sibling of the text, so the
   * text wraps this many columns narrower than the raw content width; omitting
   * it made the caller's measured row count disagree with the rows the box
   * actually renders in every non-default mode.
   */
  modeWidthAdjustment: number
}

const BUILD_IT_TEXT = 'Build it!'

/**
 * The collapsed AgentModeToggle's rendered width, for the input-width
 * estimate. Pure so the mode-dependent half of the gate is testable without
 * the chat store: the gate mirrors the RENDER condition (the bar draws the
 * toggle when the mode config says so and it is full-height and non-narrow),
 * not `inputMode !== 'default'` — `help` and `homeDir` keep the toggle drawn,
 * and estimating 0 for them would make inputWidth overstate the drawable
 * columns by the toggle's width, so the box measures rows at wider columns
 * than it draws and undersizes itself.
 */
export function estimatedAgentModeToggleWidth(
  inputMode: InputMode,
  agentMode: AgentMode,
  isCompactHeight: boolean,
  isNarrowWidth: boolean,
): number {
  const modeConfig = getInputModeConfig(inputMode)
  if (!modeConfig.showAgentModeToggle || isCompactHeight || isNarrowWidth) {
    return 0
  }
  return stringWidth(`< ${agentMode}`) + 6 // 2 padding + 2 borders + 2 gap
}

export const useChatInput = ({
  setInputValue,
  agentMode,
  setAgentMode,
  separatorWidth,
  initialPrompt,
  onSubmitPrompt,
  isCompactHeight,
  isNarrowWidth,
  modeWidthAdjustment,
}: UseChatInputOptions) => {
  const hasAutoSubmittedRef = useRef(false)
  const inputMode = useChatStore((state) => state.inputMode)

  const estimatedToggleWidth = estimatedAgentModeToggleWidth(
    inputMode,
    agentMode,
    isCompactHeight,
    isNarrowWidth,
  )

  // The content box that wraps the input row has paddingLeft/paddingRight = 1
  // (see cli/src/chat.tsx). Subtract those columns so our MultilineInput width
  // matches the true drawable area between the borders.
  const contentPadding = 2 // 1 left + 1 right padding
  const availableContentWidth = Math.max(1, separatorWidth - contentPadding)
  const inputWidth = Math.max(
    1,
    availableContentWidth - estimatedToggleWidth - modeWidthAdjustment,
  )

  const handleBuildFast = useCallback(() => {
    setAgentMode('EXECUTE_PLAN')
    setInputValue({
      text: BUILD_IT_TEXT,
      cursorPosition: BUILD_IT_TEXT.length,
      lastEditDueToNav: true,
    })
    setTimeout(() => {
      onSubmitPrompt(BUILD_IT_TEXT, 'EXECUTE_PLAN')
      setInputValue({ text: '', cursorPosition: 0, lastEditDueToNav: false })
    }, 0)
  }, [setAgentMode, setInputValue, onSubmitPrompt])

  useEffect(() => {
    if (initialPrompt && !hasAutoSubmittedRef.current) {
      hasAutoSubmittedRef.current = true

      setTimeout(() => {
        onSubmitPrompt(initialPrompt, agentMode)
      }, 100)
    }
    return undefined
  }, [initialPrompt, agentMode, onSubmitPrompt])

  return {
    inputWidth,
    handleBuildFast,
  }
}
