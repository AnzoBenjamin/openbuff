import { useKeyboard } from '@opentui/react'
import React, { useCallback, useRef, useState } from 'react'

import { Button } from './button'

import {
  buildReviewPrompt,
  REVIEW_BASE_PROMPT,
} from '../commands/prompt-builders'
import { useTheme } from '../hooks/use-theme'
import { isPlainEnterKey } from '../utils/terminal-enter-detection'

import type { KeyEvent } from '@opentui/core'

interface ReviewOption {
  id: string
  label: string
}

const REVIEW_OPTIONS: ReviewOption[] = [
  { id: 'conversation', label: 'Changes this conversation' },
  { id: 'uncommitted', label: 'Uncommitted changes' },
  { id: 'branch', label: 'This branch vs main' },
  { id: 'custom', label: 'Custom scope…' },
]

// Re-export for backward compatibility
export { REVIEW_BASE_PROMPT }

interface ReviewScreenProps {
  onSelectOption: (reviewText: string) => void
  onCustom: () => void
  onCancel: () => void
}

export const ReviewScreen: React.FC<ReviewScreenProps> = ({
  onSelectOption,
  onCustom,
  onCancel,
}) => {
  const theme = useTheme()
  const [selectedIndex, setSelectedIndex] = useState(0)
  const selectedIndexRef = useRef(selectedIndex)
  const selectIndex = (index: number) => {
    selectedIndexRef.current = index
    setSelectedIndex(index)
  }

  const handleSelect = useCallback(
    (option: ReviewOption) => {
      if (option.id === 'custom') {
        onCustom()
        return
      }

      const scope = option.id as 'conversation' | 'uncommitted' | 'branch'
      const reviewText = buildReviewPrompt(scope)
      onSelectOption(reviewText)
    },
    [onSelectOption, onCustom],
  )

  useKeyboard(
    useCallback(
      (key: KeyEvent) => {
        if (key.name === 'up') {
          key.preventDefault()
          key.stopPropagation()
          selectIndex(Math.max(0, selectedIndexRef.current - 1))
          return
        }
        if (key.name === 'down') {
          key.preventDefault()
          key.stopPropagation()
          selectIndex(
            Math.min(REVIEW_OPTIONS.length - 1, selectedIndexRef.current + 1),
          )
          return
        }
        if (isPlainEnterKey(key)) {
          key.preventDefault()
          key.stopPropagation()
          const option = REVIEW_OPTIONS[selectedIndexRef.current]
          if (option) {
            handleSelect(option)
          }
          return
        }
        if (key.name === 'escape') {
          key.preventDefault()
          key.stopPropagation()
          onCancel()
          return
        }
      },
      [handleSelect, onCancel],
    ),
  )

  return (
    <box
      style={{
        width: '100%',
        paddingLeft: 1,
        paddingRight: 1,
        flexDirection: 'column',
      }}
    >
      <text fg={theme.foreground}>
        <b>Review changes</b>
      </text>
      <text fg={theme.muted} style={{ marginBottom: 1 }}>
        Choose what to review.
      </text>
      {REVIEW_OPTIONS.map((option, index) => {
        const isSelected = index === selectedIndex
        return (
          <Button
            key={option.id}
            focusable={false}
            onMouseOver={() => selectIndex(index)}
            onClick={() => handleSelect(option)}
            style={{
              backgroundColor: isSelected ? theme.surface : undefined,
            }}
          >
            <text fg={isSelected ? theme.primary : theme.foreground}>
              {isSelected ? '› ' : '  '}
              {option.label}
            </text>
          </Button>
        )
      })}
      <text style={{ fg: theme.muted, marginTop: 1 }}>
        ↑↓ navigate · Enter select · Esc cancel
      </text>
    </box>
  )
}
