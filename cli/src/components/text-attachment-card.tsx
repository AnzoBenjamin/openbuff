import { AttachmentCard } from './attachment-card'
import { useTheme } from '../hooks/use-theme'
import { useTerminalDimensions } from '../hooks/use-terminal-dimensions'
import { sliceTextCells } from '../utils/text-boundaries'
import stringWidth from 'string-width'
import { useOutputReaderStore } from '../state/output-reader-store'
import { createAttachmentDocument } from '../utils/attachment-document'
import { createTextDocument } from '../utils/output-document'

import type { PendingTextAttachment } from '../types/store'

const TEXT_CARD_WIDTH = 24
const MAX_PREVIEW_LINES = 2
// Available width for text: card width - 2 (border) - 2 (padding) = 20 chars per line
const TEXT_CONTENT_WIDTH = TEXT_CARD_WIDTH - 4

interface TextAttachmentCardProps {
  attachment: PendingTextAttachment | { preview: string; charCount: number }
  onRemove?: () => void
  showRemoveButton?: boolean
  onInspect?: () => void
}

export const TextAttachmentCard = ({
  attachment,
  onRemove,
  showRemoveButton = true,
  onInspect,
}: TextAttachmentCardProps) => {
  const theme = useTheme()
  const { terminalWidth } = useTerminalDimensions()
  const width = Math.max(4, Math.min(TEXT_CARD_WIDTH, terminalWidth - 10))

  // Preview is already processed (newlines replaced with spaces)
  // Show as much as fits in the available space (width × lines)
  const maxPreviewChars =
    Math.min(TEXT_CONTENT_WIDTH, width - 4) * MAX_PREVIEW_LINES
  const displayPreview =
    stringWidth(attachment.preview) > maxPreviewChars
      ? sliceTextCells(attachment.preview, 0, maxPreviewChars - 1) + '…'
      : attachment.preview

  return (
    <AttachmentCard
      width={width}
      onRemove={onRemove}
      showRemoveButton={showRemoveButton}
      onInspect={
        onInspect ??
        (() =>
          useOutputReaderStore
            .getState()
            .open({
              document:
                'content' in attachment
                  ? createAttachmentDocument(attachment)
                  : createTextDocument({
                      id: `text-preview:${attachment.preview.slice(0, 80)}`,
                      title: 'Captured text preview',
                      text: attachment.preview,
                      availability: 'limited',
                      notice:
                        'Only the preview was retained; complete pasted text is unavailable in this capture.',
                    }),
            }))
      }
    >
      {/* Preview area */}
      <box
        style={{
          paddingLeft: 1,
          paddingRight: 1,
          height: 3,
          justifyContent: 'center',
        }}
      >
        <text
          style={{
            fg: theme.foreground,
            wrapMode: 'word',
          }}
        >
          {displayPreview || '(empty)'}
        </text>
      </box>

      {/* Footer with icon and char count */}
      <box
        style={{
          paddingLeft: 1,
          paddingRight: 1,
          flexDirection: 'row',
          gap: 1,
        }}
      >
        <text style={{ fg: theme.muted }}>text</text>
        <text
          style={{
            fg: theme.muted,
            wrapMode: 'none',
          }}
        >
          {attachment.charCount.toLocaleString()} chars
        </text>
      </box>
    </AttachmentCard>
  )
}
