import { pluralize } from '@codebuff/common/util/string'
import { TextAttributes } from '@opentui/core'
import React from 'react'

import { useTheme } from '../../hooks/use-theme'
import { BORDER_CHARS } from '../../utils/ui-constants'
import { answerDisplayLines } from '../ask-user/utils/structured-answer'
import { clipEvidenceLine } from '../../utils/bounded-evidence'
import { createJsonDocument } from '../../utils/output-document'
import { useOutputReaderStore } from '../../state/output-reader-store'
import { Button } from '../button'

import type { AskUserContentBlock } from '../../types/chat'

interface AskUserBranchProps {
  block: AskUserContentBlock
  availableWidth: number
}

export const AskUserBranch = ({
  block,
  availableWidth,
}: AskUserBranchProps) => {
  const theme = useTheme()

  return (
    <box
      style={{
        flexDirection: 'column',
        gap: 0,
        width: Math.max(10, availableWidth - 2),
        borderStyle: 'single',
        borderColor: theme.secondary,
        customBorderChars: BORDER_CHARS,
        padding: 1,
        marginTop: 1,
        marginBottom: 1,
      }}
    >
      {block.skipped ? (
        <text style={{ fg: theme.muted, attributes: TextAttributes.ITALIC }}>
          You skipped the{' '}
          {pluralize(block.questions.length, 'question', {
            includeCount: false,
          })}
          .
        </text>
      ) : (
        <box style={{ flexDirection: 'column', gap: 1 }}>
          <text
            style={{ fg: theme.secondary, attributes: TextAttributes.BOLD }}
          >
            Your{' '}
            {pluralize(block.questions.length, 'answer', {
              includeCount: false,
            })}
            :
          </text>
          {block.questions.slice(0, 1).map((q, idx) => {
            const answer = block.answers?.find((a) => a.questionIndex === idx)

            const count =
              (answer?.selectedOptions?.length ??
                (answer?.selectedOption === undefined ? 0 : 1)) +
              (answer?.otherText === undefined ? 0 : 1)
            const parts = answerDisplayLines({
              ...answer,
              selectedOptions: answer?.selectedOptions?.slice(0, 3),
            }).slice(0, 3)

            return (
              <box key={idx} style={{ flexDirection: 'column', gap: 0 }}>
                <text style={{ fg: theme.foreground }}>
                  {idx + 1}.{' '}
                  {clipEvidenceLine(
                    q.question.replace(/\s+/g, ' '),
                    Math.max(1, availableWidth - 8),
                  )}
                </text>
                {(parts.length ? parts : ['No answer']).map((part, index) => (
                  <text
                    key={index}
                    style={{
                      fg: theme.primary,
                      marginLeft: 2,
                      attributes: part.startsWith('Custom: ')
                        ? TextAttributes.ITALIC
                        : undefined,
                    }}
                  >
                    ↳{' '}
                    {clipEvidenceLine(
                      part.replace(/\s+/g, ' '),
                      Math.max(1, availableWidth - 8),
                    )}
                  </text>
                ))}
                {count > parts.length && (
                  <text
                    fg={theme.muted}
                  >{`Showing ${parts.length} of ${count} captured answer values`}</text>
                )}
              </box>
            )
          })}
          {block.questions.length > 1 && (
            <text
              fg={theme.muted}
            >{`Showing 1 of ${block.questions.length} captured questions`}</text>
          )}
          <Button
            onClick={() =>
              useOutputReaderStore
                .getState()
                .open({
                  document: createJsonDocument(
                    `ask-user:${block.toolCallId}`,
                    'Captured questions and answers',
                    block,
                  ),
                })
            }
          >
            <text fg={theme.secondary}>Inspect all answers</text>
          </Button>
        </box>
      )}
    </box>
  )
}
