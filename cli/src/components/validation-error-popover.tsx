import { pluralize } from '@codebuff/common/util/string'
import React, { useState } from 'react'

import { Button } from './button'
import { TerminalLink } from './terminal-link'
import { useTheme } from '../hooks/use-theme'
import { getLoadedAgentsData } from '../utils/local-agent-registry'
import { openFileAtPath } from '../utils/open-file'
import { formatValidationError } from '../utils/validation-error-formatting'
import { NETWORK_ERROR_ID } from '../utils/validation-error-helpers'
import { createJsonDocument } from '../utils/output-document'
import { capturedDiagnosticDocument } from '../utils/captured-diagnostic-document'
import { useOutputReaderStore } from '../state/output-reader-store'
import { clipEvidenceLine } from '../utils/bounded-evidence'

import type { LocalAgentInfo } from '../utils/local-agent-registry'
import type { FeedbackCategory } from '@codebuff/common/constants/feedback'

interface ValidationErrorPopoverProps {
  errors: Array<{ id: string; message: string }>
  agentEntries?: LocalAgentInfo[]
  onOpenFeedback?: (options: {
    category: FeedbackCategory
    footerMessage: string
    errors: Array<{ id: string; message: string }>
  }) => void
  onClose?: () => void
}

export const ValidationErrorPopover: React.FC<ValidationErrorPopoverProps> = ({
  errors,
  agentEntries,
  onOpenFeedback,
  onClose,
}) => {
  const theme = useTheme()
  const [isReportHovered, setIsReportHovered] = useState(false)
  const [isCloseHovered, setIsCloseHovered] = useState(false)
  const loadedAgents = agentEntries ?? getLoadedAgentsData()?.agents ?? []

  const errorCount = errors.length

  return (
    <box
      style={{
        flexDirection: 'column',
        padding: 1,
        border: true,
        borderStyle: 'single',
        borderColor: theme.warning,
        backgroundColor: theme.surface,
        width: '100%',
      }}
    >
      <box style={{ flexDirection: 'column', gap: 0 }}>
        <box
          style={{
            flexDirection: 'row',
            justifyContent: 'space-between',
            alignItems: 'center',
          }}
        >
          <text style={{ fg: theme.warning, wrapMode: 'word' }}>
            {`${pluralize(errorCount, 'Error')} · showing ${Math.min(3, errorCount)} of ${errorCount} captured entries`}
          </text>
          {onClose && (
            <Button
              style={{ paddingRight: 1 }}
              onClick={onClose}
              onMouseOver={() => setIsCloseHovered(true)}
              onMouseOut={() => setIsCloseHovered(false)}
            >
              <text
                style={{
                  fg: isCloseHovered ? theme.foreground : theme.secondary,
                  wrapMode: 'none',
                }}
              >
                [x]
              </text>
            </Button>
          )}
        </box>

        <box style={{ flexDirection: 'column', paddingTop: 1, gap: 0 }}>
          {errors.slice(0, 3).map((error, index) => {
            const errorId = error.id ?? ''
            const agentId = errorId.replace(/_\d+$/, '')
            const isNetworkError = errorId === NETWORK_ERROR_ID
            const agentInfo = loadedAgents.find((a) => a.id === agentId) as
              | LocalAgentInfo
              | undefined

            const { fieldName, message } = formatValidationError(error.message)
            const errorMsg = clipEvidenceLine(
              fieldName ? `${fieldName}: ${message}` : message,
              120,
            )

            // Special handling for network errors - show message only without ID
            if (isNetworkError) {
              return (
                <box
                  key={errorId || `error-${index}`}
                  style={{ flexDirection: 'column', paddingTop: 0.5 }}
                >
                  <text style={{ fg: theme.muted, wrapMode: 'word' }}>
                    {`• ${errorMsg}`}
                  </text>
                </box>
              )
            }

            if (agentInfo?.filePath) {
              return (
                <box
                  key={errorId || `error-${index}`}
                  style={{ flexDirection: 'column', paddingTop: 0.5 }}
                >
                  <text style={{ fg: theme.muted, wrapMode: 'word' }}>
                    {'• '}
                    <TerminalLink
                      text={agentId}
                      color={theme.info}
                      inline={true}
                      onActivate={() => openFileAtPath(agentInfo.filePath)}
                    />
                  </text>
                  <text
                    style={{
                      fg: theme.muted,
                      wrapMode: 'word',
                      paddingLeft: 2,
                    }}
                  >
                    {errorMsg}
                  </text>
                </box>
              )
            }

            return (
              <box
                key={errorId || `error-${index}`}
                style={{ flexDirection: 'column', paddingTop: 0.5 }}
              >
                <text style={{ fg: theme.muted, wrapMode: 'word' }}>
                  {`• ${agentId || 'Unknown'}`}
                </text>
                <text
                  style={{
                    fg: theme.muted,
                    wrapMode: 'word',
                    paddingLeft: 2,
                  }}
                >
                  {errorMsg}
                </text>
              </box>
            )
          })}

          {errorCount > 3 && (
            <text
              style={{ fg: theme.muted, wrapMode: 'word', paddingTop: 0.5 }}
            >
              {`+ ${errorCount - 3} more`}
            </text>
          )}
        </box>
        <Button
          onClick={() =>
            useOutputReaderStore
              .getState()
              .open({
                document: capturedDiagnosticDocument(
                  'captured-validation-errors',
                  'Captured validation errors',
                  errors,
                ),
              })
          }
        >
          <text fg={theme.secondary}>Inspect all captured errors</text>
        </Button>

        {onOpenFeedback && (
          <box style={{ paddingTop: 1, justifyContent: 'flex-end' }}>
            <Button
              onClick={() =>
                useOutputReaderStore
                  .getState()
                  .open({
                    document: createJsonDocument(
                      'validation-report-evidence',
                      'Local validation report · remote submission unavailable',
                      {
                        support:
                          'https://github.com/AnzoBenjamin/openbuff/issues',
                        notice:
                          'Review and copy captured evidence before sharing it. Remote feedback submission is unavailable in this local build.',
                        errors,
                      },
                    ),
                  })
              }
              onMouseOver={() => setIsReportHovered(true)}
              onMouseOut={() => setIsReportHovered(false)}
            >
              <text style={{ wrapMode: 'none' }}>
                {isReportHovered ? (
                  <u>
                    <span fg={theme.info}>Report issue</span>
                  </u>
                ) : (
                  <span fg={theme.info}>Report issue</span>
                )}
              </text>
            </Button>
          </box>
        )}
      </box>
    </box>
  )
}
