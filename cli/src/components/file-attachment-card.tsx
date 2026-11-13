import { AttachmentCard } from './attachment-card'
import { useTheme } from '../hooks/use-theme'
import { getFileAttachmentContextMetadata } from '../utils/pending-attachments'
import { useTerminalDimensions } from '../hooks/use-terminal-dimensions'
import { fitAttachmentName } from '../utils/attachment-names'
import { createAttachmentDocument } from '../utils/attachment-document'
import { createTextDocument } from '../utils/output-document'
import { useOutputReaderStore } from '../state/output-reader-store'

import type { FileAttachment } from '../types/chat'
import type { PendingFileAttachment } from '../types/store'

const FILE_CARD_WIDTH = 20
const MAX_FILENAME_LENGTH = 16

const FILE_ICON_LINES = ['   ┌───╮', '   │ ≡ │', '   └───╯']

const FOLDER_ICON_LINES = ['  ╭──╮   ', '  │  ╰──╮', '  ╰─────╯']

interface FileAttachmentCardProps {
  attachment: PendingFileAttachment | FileAttachment
  onRemove?: () => void
  showRemoveButton?: boolean
  onInspect?: () => void
  onRetry?: () => void
}

export const FileAttachmentCard = ({
  attachment,
  onRemove,
  showRemoveButton = true,
  onInspect,
  onRetry,
}: FileAttachmentCardProps) => {
  const theme = useTheme()
  const { terminalWidth } = useTerminalDimensions()
  const width = Math.max(4, Math.min(FILE_CARD_WIDTH, terminalWidth - 10))
  const iconLines = attachment.isDirectory ? FOLDER_ICON_LINES : FILE_ICON_LINES
  const truncatedName = fitAttachmentName(
    attachment.filename,
    Math.min(MAX_FILENAME_LENGTH, width - 4),
  )
  const status = 'status' in attachment ? attachment.status : undefined
  const context = getFileAttachmentContextMetadata(attachment)
  const isIncomplete = context.completeness !== 'full'

  return (
    <AttachmentCard
      width={width}
      onRemove={onRemove}
      showRemoveButton={showRemoveButton}
      onRetry={onRetry}
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
                      id: `file-attachment:${attachment.path}`,
                      title: attachment.filename,
                      text: `File: ${attachment.filename}\nPath: ${attachment.path}\n${attachment.note ?? ''}`,
                      availability: 'limited',
                      notice:
                        'Only attachment metadata was retained; file contents are unavailable in this capture.',
                    }),
            }))
      }
    >
      {/* ASCII art icon area */}
      <box
        style={{
          height: 3,
          justifyContent: 'center',
          alignItems: 'center',
        }}
      >
        <text style={{ fg: theme.info }}>{iconLines.join('\n')}</text>
      </box>

      {/* Filename and note */}
      <box
        style={{
          paddingLeft: 1,
          paddingRight: 1,
          flexDirection: 'column',
        }}
      >
        <text
          style={{
            fg: theme.foreground,
            wrapMode: 'none',
          }}
        >
          {truncatedName}
        </text>
        {(status === 'processing' || attachment.note) && (
          <text
            style={{
              fg:
                status === 'error'
                  ? theme.error
                  : isIncomplete
                    ? theme.warning
                    : theme.muted,
              wrapMode: 'none',
            }}
          >
            {status === 'processing' ? 'reading…' : attachment.note}
          </text>
        )}
      </box>
    </AttachmentCard>
  )
}
