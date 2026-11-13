import React from 'react'

import { useTheme } from '../hooks/use-theme'
import { BORDER_CHARS } from '../utils/ui-constants'
import { Button } from './button'
import { useOutputReaderStore } from '../state/output-reader-store'
import { createTextDocument } from '../utils/output-document'
import { useTerminalDimensions } from '../hooks/use-terminal-dimensions'
import { wrapTextToVisualLines } from '../utils/text-layout'

interface UserErrorBannerProps {
  error: string
  title?: string
}

/** Displays runtime errors in the UI (not sent to LLM). */
export const UserErrorBanner = React.memo(function UserErrorBanner({
  error,
  title,
}: UserErrorBannerProps) {
  const theme = useTheme()
  const { separatorWidth } = useTerminalDimensions()

  // Handle empty and whitespace-only errors
  const trimmedError = error.trim()
  if (!trimmedError) {
    return null
  }
  const preview = wrapTextToVisualLines(error, Math.max(10, separatorWidth - 6))
    .slice(0, 4)
    .join('\n')

  return (
    <box
      style={{
        width: '100%',
        borderStyle: 'single',
        borderColor: theme.error,
        customBorderChars: BORDER_CHARS,
        paddingLeft: 1,
        paddingRight: 1,
        paddingTop: 0,
        paddingBottom: 0,
        flexDirection: 'column',
        gap: 0,
        marginTop: 1,
      }}
    >
      <box
        style={{
          flexDirection: 'column',
          justifyContent: 'center',
          gap: 0,
        }}
      >
        <text style={{ fg: theme.error, wrapMode: 'word' }}>
          {title ?? 'Error'}
        </text>
        <text style={{ fg: theme.foreground, wrapMode: 'word' }}>
          {preview}
        </text>
        <Button
          onClick={() =>
            useOutputReaderStore
              .getState()
              .open({
                document: createTextDocument({
                  id: 'captured-runtime-error',
                  title: title ?? 'Captured runtime error',
                  text: error,
                  kind: 'log',
                  notice:
                    'Retained failure details; opening this view does not retry or change the run.',
                }),
              })
          }
        >
          <text fg={theme.secondary}>Inspect captured error</text>
        </Button>
      </box>
    </box>
  )
})
