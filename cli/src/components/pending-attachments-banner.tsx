import { Button } from './button'
import { useTerminalDimensions } from '../hooks/use-terminal-dimensions'
import { useTheme } from '../hooks/use-theme'
import { useChatStore } from '../state/chat-store'
import { useOutputReaderStore } from '../state/output-reader-store'
import { createJsonDocument } from '../utils/output-document'
import { sliceTextCells } from '../utils/text-boundaries'

export const PendingAttachmentsBanner = ({
  onManageAttachments,
}: { onManageAttachments?: () => void } = {}) => {
  const theme = useTheme()
  const { terminalWidth } = useTerminalDimensions()
  const attachments = useChatStore((state) => state.pendingAttachments)
  if (!attachments.length) return null
  const reading = attachments.filter(
    (attachment) =>
      attachment.kind !== 'text' && attachment.status === 'processing',
  ).length
  const failed = attachments.filter(
    (attachment) => attachment.kind !== 'text' && attachment.status === 'error',
  ).length
  const manage = () => {
    if (onManageAttachments) onManageAttachments()
    else
      useOutputReaderStore.getState().open({
        document: createJsonDocument(
          'composer-attachment-list',
          'Composer attachments',
          attachments.map((attachment) =>
            attachment.kind === 'text'
              ? { type: 'Text', content: attachment.content }
              : {
                  type: attachment.kind,
                  filename: attachment.filename,
                  path: attachment.path,
                  status: attachment.status,
                  note: attachment.note,
                  ...(attachment.kind === 'file'
                    ? { content: attachment.content }
                    : {
                        imageBytesCaptured: Boolean(attachment.processedImage),
                      }),
                },
          ),
        ),
      })
  }
  return (
    <box style={{ flexDirection: 'column', flexShrink: 0 }}>
      <Button onClick={manage}>
        <text fg={failed ? theme.error : theme.muted} wrapMode="none">
          {sliceTextCells(
            `${attachments.length} attachments${reading ? ` · ${reading} reading` : ''}${failed ? ` · ${failed} failed` : ''} · Manage attachments`,
            0,
            terminalWidth - 4,
          )}
        </text>
      </Button>
    </box>
  )
}
