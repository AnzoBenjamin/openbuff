/**
 * Question option component (radio button or checkbox)
 */

import { TextAttributes } from '@opentui/core'
import React, { memo } from 'react'

import { useTheme } from '../../../hooks/use-theme'
import { useTerminalDimensions } from '../../../hooks/use-terminal-dimensions'
import { clipEvidenceLine } from '../../../utils/bounded-evidence'
import { wrapTextPreservingNewlines } from '../../../utils/text-layout'
import { Button } from '../../button'
import { SYMBOLS } from '../constants'

export interface QuestionOptionProps {
  option: string | { label: string; description?: string }
  indent: number
  isSelected: boolean
  isFocused: boolean
  isMultiSelect?: boolean
  onSelect: () => void
  onMouseOver: () => void
}

export const QuestionOption: React.FC<QuestionOptionProps> = memo(
  ({
    option,
    indent,
    isSelected,
    isFocused,
    isMultiSelect = false,
    onSelect,
    onMouseOver,
  }) => {
    const theme = useTheme()
    const { terminalWidth } = useTerminalDimensions()

    // Extract label and description
    const label = typeof option === 'string' ? option : option.label
    const description =
      typeof option === 'object' ? option.description : undefined

    const labelWidth = Math.max(1, terminalWidth - 8 - indent)
    const descriptionLines = description
      ? wrapTextPreservingNewlines(
          description.replace(/\s+/g, ' '),
          Math.max(1, labelWidth - 2),
        ).split('\n')
      : []
    const descriptionPreview = descriptionLines
      .slice(0, 2)
      .map((line, index) =>
        index === 1 && descriptionLines.length > 2
          ? clipEvidenceLine(`${line} …`, Math.max(1, labelWidth - 2))
          : line,
      )
      .join('\n')
    const selectedFg = theme.name === 'dark' ? '#ffffff' : '#000000'
    const symbol = isMultiSelect
      ? isSelected
        ? SYMBOLS.CHECKBOX_CHECKED
        : SYMBOLS.CHECKBOX_UNCHECKED
      : isSelected
        ? SYMBOLS.SELECTED
        : SYMBOLS.UNSELECTED
    const fg = isFocused ? theme.primary : isSelected ? selectedFg : theme.muted
    const attributes = isFocused || isSelected ? TextAttributes.BOLD : undefined

    return (
      <Button
        onClick={onSelect}
        onMouseOver={onMouseOver}
        style={{
          flexDirection: 'column',
          gap: 0,
          width: '100%',
          backgroundColor: isFocused ? theme.surfaceHover : undefined,
          flexShrink: 0,
          marginBottom: 0,
          paddingTop: 0,
          paddingBottom: 0,
          paddingLeft: indent,
        }}
      >
        <text wrapMode="none" style={{ fg, attributes }}>
          {clipEvidenceLine(
            `${symbol} ${label.replace(/\s+/g, ' ')}`,
            labelWidth,
          )}
        </text>
        {/* Show description on focus */}
        {isFocused && description && (
          <text
            wrapMode="none"
            style={{
              fg: theme.muted,
              marginLeft: 2,
            }}
          >
            {descriptionPreview}
          </text>
        )}
      </Button>
    )
  },
  // Memo comparison: only re-render if these props change
  (prev, next) => {
    return (
      prev.isSelected === next.isSelected &&
      prev.isFocused === next.isFocused &&
      prev.option === next.option &&
      prev.indent === next.indent &&
      prev.isMultiSelect === next.isMultiSelect &&
      prev.onSelect === next.onSelect &&
      prev.onMouseOver === next.onMouseOver
    )
  },
)

QuestionOption.displayName = 'QuestionOption'
