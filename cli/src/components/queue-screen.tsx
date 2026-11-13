import { useKeyboard } from '@opentui/react'
import { pluralize } from '@codebuff/common/util/string'
import React, { useEffect, useRef, useState } from 'react'
import { Button } from './button'
import { createAttachmentDocument } from '../utils/attachment-document'
import { getPendingAttachmentId } from '../utils/pending-attachments'
import type { PendingAttachment } from '../types/store'
import { MultilineInput } from './multiline-input'
import { OutputReaderScreen } from './output-reader-screen'
import { useTheme } from '../hooks/use-theme'
import { useTerminalDimensions } from '../hooks/use-terminal-dimensions'
import { sliceTextCells } from '../utils/text-boundaries'
import { createTextPasteHandler } from '../utils/strings'
import {
  createJsonDocument,
  createTextDocument,
} from '../utils/output-document'
import type { OutputDocument } from '../utils/output-document'
import { AGENT_MODES } from '../utils/constants'
import type { AgentMode } from '../utils/constants'
import type { QueuedMessage } from '../hooks/use-message-queue'
import type { UseChatStreamingReturn } from '../hooks/use-chat-streaming'
import type { InputValue } from '../types/store'

export interface QueueScreenProps extends Pick<
  UseChatStreamingReturn,
  | 'queuedMessages'
  | 'queuePaused'
  | 'queueError'
  | 'updateQueuedMessage'
  | 'removeQueuedMessage'
  | 'moveQueuedMessage'
  | 'undoQueueRemoval'
  | 'queueRemovalCount'
  | 'cancelQueuedMessages'
  | 'pauseQueue'
  | 'resumeQueue'
> {
  onClose: () => void
  onRestore: (message: QueuedMessage) => boolean
  attachmentRemovalCount?: number
  queueAttachmentNotice?: string | null
  hasQueuedAttachmentReads?: UseChatStreamingReturn['hasQueuedAttachmentReads']
  getQueuedAttachmentRevision?: UseChatStreamingReturn['getQueuedAttachmentRevision']
  updateQueuedAttachment?: UseChatStreamingReturn['updateQueuedAttachment']
  cancelQueuedAttachmentRetry?: UseChatStreamingReturn['cancelQueuedAttachmentRetry']
  removeQueuedAttachment?: UseChatStreamingReturn['removeQueuedAttachment']
  undoQueuedAttachmentRemoval?: UseChatStreamingReturn['undoQueuedAttachmentRemoval']
  retryAttachment?: (
    messageId: string,
    attachment: PendingAttachment,
    signal?: AbortSignal,
  ) => Promise<PendingAttachment>
}
export function QueueScreen(props: QueueScreenProps) {
  const theme = useTheme()
  const { terminalWidth, terminalHeight } = useTerminalDimensions()
  const [selectedId, setSelectedId] = useState(props.queuedMessages[0]?.id)
  const selectedIdRef = useRef(selectedId)
  selectedIdRef.current = selectedId
  const selectedIndex = Math.max(
    0,
    props.queuedMessages.findIndex((message) => message.id === selectedId),
  )
  const selected = props.queuedMessages[selectedIndex]
  const [editing, setEditing] = useState<QueuedMessage | null>(null)
  const [modeTarget, setModeTarget] = useState<QueuedMessage | null>(null)
  const [modeIndex, setModeIndex] = useState(0)
  const modeIndexRef = useRef(modeIndex)
  modeIndexRef.current = modeIndex
  const [clearPreview, setClearPreview] = useState<QueuedMessage[] | null>(null)
  const [inspection, setInspection] = useState<OutputDocument | null>(null)
  const [text, setText] = useState('')
  const [cursor, setCursor] = useState(0)
  const [notice, setNotice] = useState('')
  const [attachmentTarget, setAttachmentTarget] = useState<string | null>(null)
  const [attachmentIndex, setAttachmentIndex] = useState(0)
  const attachmentIndexRef = useRef(0)
  attachmentIndexRef.current = attachmentIndex
  const operations = useRef(
    new Map<
      string,
      {
        controller: AbortController
        messageId: string
        attachmentId: string
        revision: number
      }
    >(),
  )
  const propsRef = useRef(props)
  propsRef.current = props
  useEffect(() => {
    for (const [key, operation] of operations.current) {
      if (
        props.getQueuedAttachmentRevision?.(
          operation.messageId,
          operation.attachmentId,
        ) !== operation.revision
      ) {
        operation.controller.abort()
        operations.current.delete(key)
        setNotice(
          'Attachment retry cancelled by queue change · capture retained',
        )
      }
    }
  }, [props.queuedMessages, props.getQueuedAttachmentRevision])
  useEffect(
    () => () => {
      for (const operation of operations.current.values()) {
        operation.controller.abort()
        propsRef.current.cancelQueuedAttachmentRetry?.(
          operation.messageId,
          operation.attachmentId,
          operation.revision,
        )
      }
      operations.current.clear()
    },
    [],
  )
  const retryAttachment = async (
    messageId: string,
    attachment: PendingAttachment,
  ) => {
    if (attachment.kind === 'text') {
      setNotice(
        'Text attachment is captured already; inspect it to read the source.',
      )
      return
    }
    if (
      !props.retryAttachment ||
      !props.updateQueuedAttachment ||
      !props.getQueuedAttachmentRevision
    ) {
      setNotice(
        'Attachment retry is unavailable here. Inspect retained content or remove this item.',
      )
      return
    }
    const attachmentId = getPendingAttachmentId(attachment)
    const key = `${messageId}\0${attachmentId}`
    const previous = operations.current.get(key)
    if (
      previous &&
      previous.revision ===
        props.getQueuedAttachmentRevision(messageId, attachmentId)
    )
      return
    if (previous) {
      previous.controller.abort()
      operations.current.delete(key)
    }
    props.pauseQueue()
    const processing: PendingAttachment = {
      ...attachment,
      status: 'processing',
      note: 'Reading attachment again · previous capture retained',
    }
    if (
      !props.updateQueuedAttachment(
        messageId,
        attachmentId,
        processing,
        attachment,
      )
    ) {
      setNotice('Attachment changed before retry; inspect the current item.')
      return
    }
    const operation = {
      controller: new AbortController(),
      messageId,
      attachmentId,
      revision: props.getQueuedAttachmentRevision(messageId, attachmentId),
    }
    operations.current.set(key, operation)
    setNotice('Reading a fresh attachment snapshot · queue paused')
    try {
      const result = await props.retryAttachment(
        messageId,
        attachment,
        operation.controller.signal,
      )
      if (
        operations.current.get(key) !== operation ||
        operation.controller.signal.aborted
      )
        return
      const saved = props.updateQueuedAttachment(
        messageId,
        attachmentId,
        result,
        processing,
        operation.revision,
      )
      setNotice(
        !saved
          ? 'Attachment changed during retry · late result ignored'
          : result.kind !== 'text' && result.status === 'error'
            ? 'Retry failed · previous capture retained'
            : 'Fresh attachment snapshot saved · queue remains paused',
      )
    } catch (error) {
      if (
        operations.current.get(key) !== operation ||
        operation.controller.signal.aborted
      )
        return
      const failed: PendingAttachment = {
        ...attachment,
        status: 'error',
        note: `Retry failed: ${error instanceof Error ? error.message : String(error)} · previous capture retained`,
      }
      if (
        props.updateQueuedAttachment(
          messageId,
          attachmentId,
          failed,
          processing,
          operation.revision,
        )
      )
        setNotice('Retry failed · previous capture retained')
    } finally {
      if (operations.current.get(key) === operation)
        operations.current.delete(key)
    }
  }
  const cancelAttachmentRetry = (
    messageId: string,
    attachment: PendingAttachment,
  ) => {
    const key = `${messageId}\0${getPendingAttachmentId(attachment)}`
    const operation = operations.current.get(key)
    if (operation) {
      operation.controller.abort()
      props.cancelQueuedAttachmentRetry?.(
        messageId,
        operation.attachmentId,
        operation.revision,
      )
      operations.current.delete(key)
      setNotice('Attachment retry cancelled · previous capture retained')
    }
  }
  const bodyHeight = Math.max(1, terminalHeight - 8)
  const startIndex = Math.max(0, selectedIndex - bodyHeight + 1)
  const beginEdit = (message: QueuedMessage) => {
    if (!message.id) return
    props.pauseQueue()
    setText(message.content)
    setCursor(message.content.length)
    setEditing(message)
  }
  const save = (latest?: InputValue) => {
    const savedText = latest?.text ?? text
    if (!editing?.id) return
    if (!savedText.trim() && !editing.attachments.length) {
      setNotice('Enter a prompt or keep an attachment before saving')
      return
    }
    if (props.updateQueuedMessage(editing.id, { content: savedText })) {
      setEditing(null)
      setNotice('Queued prompt saved · mode and attachments retained')
    } else {
      setNotice('Prompt is no longer queued · edit retained here for copying')
    }
  }
  useKeyboard((key) => {
    if (editing || inspection) return
    if (attachmentTarget) {
      const message = props.queuedMessages.find(
        (item) => item.id === attachmentTarget,
      )
      const index = Math.min(
        attachmentIndexRef.current,
        Math.max(0, (message?.attachments.length ?? 0) - 1),
      )
      const attachment = message?.attachments[index]
      if (key.name === 'escape') setAttachmentTarget(null)
      else if (key.name === 'up' || key.name === 'down') {
        const next = Math.max(
          0,
          Math.min(
            (message?.attachments.length ?? 0) - 1,
            index + (key.name === 'up' ? -1 : 1),
          ),
        )
        attachmentIndexRef.current = next
        setAttachmentIndex(next)
      } else if (
        (key.name === 'i' || key.name === 'return' || key.name === 'enter') &&
        attachment
      )
        setInspection(createAttachmentDocument(attachment))
      else if (key.name === 'r' && message?.id && attachment)
        void retryAttachment(message.id, attachment)
      else if (key.name === 'c' && message?.id && attachment)
        cancelAttachmentRetry(message.id, attachment)
      else if (key.name === 'x' && message?.id && attachment) {
        cancelAttachmentRetry(message.id, attachment)
        const removed = props.removeQueuedAttachment?.(
          message.id,
          getPendingAttachmentId(attachment),
        )
        setNotice(
          removed
            ? 'Attachment removed · U restores it with its original context'
            : 'Attachment removal unavailable',
        )
      } else if (key.name === 'u') {
        const restored = props.undoQueuedAttachmentRemoval?.()
        setNotice(
          restored
            ? 'Attachment restored · queue paused'
            : 'No attachment can be restored here',
        )
      } else return
      key.preventDefault()
      return
    }
    if (clearPreview) {
      if (key.name === 'escape') setClearPreview(null)
      else if (key.name === 'y') {
        const removed = props.cancelQueuedMessages(
          clearPreview.flatMap((message) => (message.id ? [message.id] : [])),
        )
        setClearPreview(null)
        setNotice(
          removed.length
            ? `${removed.length} prompts removed · U restores them paused`
            : 'Previewed prompts are no longer queued',
        )
      } else if (key.name === 'i') {
        setInspection(
          createJsonDocument(
            'queue-clear-preview',
            'Prompts to clear',
            clearPreview.map((message) => ({
              prompt: message.content,
              mode: modeLabel(message.agentMode),
              attachments: message.attachments.map((attachment) =>
                attachment.kind === 'text'
                  ? { type: 'Text', content: attachment.content }
                  : {
                      type:
                        attachment.kind === 'image'
                          ? 'Image'
                          : attachment.isDirectory
                            ? 'Folder'
                            : 'File',
                      path: attachment.path,
                      status: attachment.status,
                      note: attachment.note,
                      ...(attachment.kind === 'file'
                        ? { content: attachment.content }
                        : {}),
                    },
              ),
            })),
          ),
        )
      } else return
      key.preventDefault()
      return
    }
    if (modeTarget) {
      if (key.name === 'escape') setModeTarget(null)
      else if (key.name === 'up' || key.name === 'down') {
        const next = Math.max(
          0,
          Math.min(
            AGENT_MODES.length - 1,
            modeIndexRef.current + (key.name === 'up' ? -1 : 1),
          ),
        )
        modeIndexRef.current = next
        setModeIndex(next)
      } else if (key.name === 'return' && modeTarget.id) {
        const mode = AGENT_MODES[modeIndexRef.current]!
        const saved = props.updateQueuedMessage(modeTarget.id, {
          agentMode: mode,
        })
        setModeTarget(null)
        setNotice(
          saved
            ? `Queued mode saved · ${modeLabel(mode)} · other prompts retained`
            : 'Prompt is no longer queued · mode was not changed',
        )
      } else return
      key.preventDefault()
      return
    }
    // Terminal input can contain several arrows and Enter before a React
    // commit. Resolve each event against the synchronous selection.
    const index = Math.max(
      0,
      props.queuedMessages.findIndex(
        (message) => message.id === selectedIdRef.current,
      ),
    )
    const selected = props.queuedMessages[index]
    if (key.name === 'escape') props.onClose()
    else if (key.name === 'up' || key.name === 'down') {
      const nextIndex = Math.max(
        0,
        Math.min(
          props.queuedMessages.length - 1,
          index + (key.name === 'up' ? -1 : 1),
        ),
      )
      selectedIdRef.current = props.queuedMessages[nextIndex]?.id
      setSelectedId(selectedIdRef.current)
    } else if (key.name === 'return' && selected) {
      setInspection(
        createTextDocument({
          id: `queue:${selected.id}`,
          title: `Queued prompt · ${modeLabel(selected.agentMode)}`,
          text: selected.content,
        }),
      )
    } else if (key.name === 'a' && selected?.id) {
      props.pauseQueue()
      setAttachmentTarget(selected.id)
      attachmentIndexRef.current = 0
      setAttachmentIndex(0)
    } else if (key.name === 'e' && selected) beginEdit(selected)
    else if (key.name === 'm' && selected?.id) {
      props.pauseQueue()
      setModeTarget(selected)
      modeIndexRef.current = AGENT_MODES.indexOf(selected.agentMode)
      setModeIndex(modeIndexRef.current)
    } else if (key.name === 'c' && props.queuedMessages.length) {
      props.pauseQueue()
      setClearPreview([...props.queuedMessages])
    } else if (key.name === 'x' && selected?.id) {
      props.removeQueuedMessage(selected.id)
      setNotice('Prompt removed · U restores it')
    } else if (key.name === 'u') {
      const count = props.undoQueueRemoval()
      setNotice(
        count
          ? `${count} prompts restored · queue paused`
          : 'Nothing to restore',
      )
    } else if (key.name === '[' && selected?.id)
      props.moveQueuedMessage(selected.id, -1)
    else if (key.name === ']' && selected?.id)
      props.moveQueuedMessage(selected.id, 1)
    else if (key.name === 'p') {
      const next = props.queuedMessages[0]
      if (
        props.queuePaused &&
        next &&
        !next.content.trim() &&
        !next.attachments.length
      )
        setNotice(
          'Next queued item needs text or an attachment · edit, Undo or remove it',
        )
      else if (props.queuePaused && props.hasQueuedAttachmentReads?.())
        setNotice(
          'Attachment retry is pending · wait or cancel before resuming',
        )
      else {
        props.queuePaused ? props.resumeQueue() : props.pauseQueue()
        setNotice(props.queuePaused ? 'Queue resumed' : 'Queue paused')
      }
    } else if (key.name === 'r' && selected?.id) {
      if (props.onRestore(selected)) {
        props.removeQueuedMessage(selected.id)
        props.onClose()
      } else
        setNotice(
          'Composer already has a draft · clear it before restoring, or inspect and copy this prompt',
        )
    } else return
    key.preventDefault()
  })
  if (inspection)
    return (
      <OutputReaderScreen
        messages={[]}
        initialDocument={inspection}
        onClose={() => setInspection(null)}
      />
    )
  if (attachmentTarget) {
    const message = props.queuedMessages.find(
      (item) => item.id === attachmentTarget,
    )
    const index = Math.min(
      attachmentIndex,
      Math.max(0, (message?.attachments.length ?? 0) - 1),
    )
    const attachment = message?.attachments[index]
    const height = Math.max(1, terminalHeight - 6)
    const start = Math.max(
      0,
      Math.min(
        index - Math.floor(height / 2),
        (message?.attachments.length ?? 0) - height,
      ),
    )
    return (
      <box
        style={{
          width: '100%',
          height: '100%',
          flexDirection: 'column',
          paddingLeft: 1,
          paddingRight: 1,
          backgroundColor: theme.surface,
        }}
      >
        <text fg={theme.primary} style={{ flexShrink: 0 }}>
          Queued attachments · {attachment ? index + 1 : 0}/
          {message?.attachments.length ?? 0}
        </text>
        <text fg={theme.muted} wrapMode="none" style={{ flexShrink: 0 }}>
          {sliceTextCells(
            message
              ? `${modeLabel(message.agentMode)} · ${message.content || 'Attachment-only prompt'}`
              : 'Original queued prompt is no longer available',
            0,
            terminalWidth - 2,
          )}
        </text>
        <box
          style={{ flexGrow: 1, overflow: 'hidden', flexDirection: 'column' }}
        >
          {message?.attachments
            .slice(start, start + height)
            .map((item, visibleIndex) => (
              <Button
                key={getPendingAttachmentId(item)}
                onClick={() => {
                  setAttachmentIndex(start + visibleIndex)
                  setInspection(createAttachmentDocument(item))
                }}
                onMouseOver={() => {
                  attachmentIndexRef.current = start + visibleIndex
                  setAttachmentIndex(start + visibleIndex)
                }}
              >
                <text
                  fg={
                    start + visibleIndex === index
                      ? theme.foreground
                      : item.kind !== 'text' && item.status === 'error'
                        ? theme.error
                        : theme.muted
                  }
                  wrapMode="none"
                >
                  {sliceTextCells(
                    `${start + visibleIndex === index ? '›' : ' '} ${item.kind === 'text' ? `ready · Text · ${item.preview}` : `${item.status} · ${item.filename}`}`,
                    0,
                    terminalWidth - 2,
                  )}
                </text>
              </Button>
            ))}
          {!message?.attachments.length && (
            <text fg={theme.muted}>
              No attachments · U restores the last removed attachment
            </text>
          )}
        </box>
        {attachment && (
          <text
            fg={
              attachment.kind !== 'text' && attachment.status === 'error'
                ? theme.error
                : theme.muted
            }
            wrapMode="none"
            style={{ flexShrink: 0 }}
          >
            {sliceTextCells(
              attachment.kind === 'text'
                ? `${attachment.charCount} captured characters`
                : `${attachment.path} · ${attachment.note ?? attachment.status}`,
              0,
              terminalWidth - 2,
            )}
          </text>
        )}
        <text fg={theme.muted} wrapMode="none" style={{ flexShrink: 0 }}>
          {sliceTextCells(
            notice || props.queueAttachmentNotice || '',
            0,
            terminalWidth - 2,
          )}
        </text>
        <text fg={theme.muted} wrapMode="none" style={{ flexShrink: 0 }}>
          ↑↓ select · I inspect · R fresh retry · C cancel
        </text>
        <text fg={theme.muted} wrapMode="none" style={{ flexShrink: 0 }}>
          X remove · U attachment undo · Esc back
        </text>
      </box>
    )
  }
  return (
    <box
      style={{
        width: '100%',
        height: '100%',
        flexDirection: 'column',
        backgroundColor: theme.surface,
        paddingLeft: 1,
        paddingRight: 1,
      }}
    >
      <text fg={theme.primary} wrapMode="none">
        {sliceTextCells(
          `Work queue · ${props.queuedMessages.length} prompts · ${props.queuePaused ? 'Paused' : 'Ready'} · Esc Back`,
          0,
          terminalWidth - 2,
        )}
      </text>
      <text fg={theme.error} wrapMode="none">
        {props.queueError
          ? sliceTextCells(
              `Send failed · ${props.queueError}`,
              0,
              terminalWidth - 2,
            )
          : ''}
      </text>
      <text fg={theme.muted}>
        {sliceTextCells(
          notice || props.queueAttachmentNotice || '',
          0,
          terminalWidth - 2,
        )}
      </text>
      {clearPreview ? (
        <box style={{ height: bodyHeight, flexDirection: 'column' }}>
          <text fg={theme.foreground}>
            Clear {clearPreview.length} queued prompts?
          </text>
          <text fg={theme.muted}>
            The current run continues. New queued work stays.
          </text>
          <text fg={theme.muted}>
            U can restore this batch until the next removal.
          </text>
          <text fg={theme.muted}>
            Preview ·{' '}
            {Math.min(clearPreview.length, Math.max(0, bodyHeight - 4))} of{' '}
            {clearPreview.length} prompts · I inspect all
          </text>
          {clearPreview.slice(0, Math.max(0, bodyHeight - 4)).map((message) => (
            <text key={message.id} fg={theme.foreground} wrapMode="none">
              {sliceTextCells(
                `${modeLabel(message.agentMode)} · ${pluralize(message.attachments.length, 'attachment')} · ${message.content.replaceAll('\n', ' ')}`,
                0,
                terminalWidth - 2,
              )}
            </text>
          ))}
        </box>
      ) : modeTarget ? (
        <box style={{ height: bodyHeight, flexDirection: 'column' }}>
          <text fg={theme.foreground}>Mode for this queued prompt</text>
          <text fg={theme.muted} wrapMode="none">
            {sliceTextCells(
              modeTarget.content.replaceAll('\n', ' '),
              0,
              terminalWidth - 2,
            )}
          </text>
          {AGENT_MODES.map((mode, index) => (
            <text
              key={mode}
              fg={index === modeIndex ? theme.foreground : theme.muted}
            >
              {index === modeIndex ? '›' : ' '} {modeLabel(mode)}
              {mode === modeTarget.agentMode ? ' · current' : ''}
            </text>
          ))}
          <text fg={theme.muted}>
            Prompt and attachments stay with this item.
          </text>
        </box>
      ) : editing ? (
        <MultilineInput
          value={text}
          cursorPosition={cursor}
          focused={true}
          minHeight={3}
          maxHeight={Math.max(3, bodyHeight)}
          onChange={({ text, cursorPosition }) => {
            setText(text)
            setCursor(cursorPosition)
          }}
          onPaste={createTextPasteHandler(
            text,
            cursor,
            ({ text, cursorPosition }) => {
              setText(text)
              setCursor(cursorPosition)
            },
          )}
          onSubmit={save}
          onKeyIntercept={(key) => {
            if (key.name === 'escape') {
              setEditing(null)
              return true
            }
            return false
          }}
        />
      ) : (
        <box
          style={{
            height: bodyHeight,
            flexDirection: 'column',
          }}
        >
          {props.queuedMessages
            .slice(startIndex, startIndex + bodyHeight)
            .map((message) => (
              <text
                key={message.id}
                fg={
                  message.id === selected?.id ? theme.foreground : theme.muted
                }
              >
                {sliceTextCells(
                  `${message.id === selected?.id ? '›' : ' '} ${modeLabel(message.agentMode)} · ${pluralize(message.attachments.length, 'attachment')} · ${message.content.replaceAll('\n', ' ')}`,
                  0,
                  terminalWidth - 2,
                )}
              </text>
            ))}
          {!props.queuedMessages.length && (
            <text fg={theme.muted}>
              Queue is empty · Esc returns to your draft
            </text>
          )}
        </box>
      )}
      <text fg={theme.foreground}>
        {sliceTextCells(
          props.queueRemovalCount && !editing && !modeTarget && !clearPreview
            ? `Undo available · ${props.queueRemovalCount} prompts · U restores paused`
            : selected
              ? `Selected · ${modeLabel(selected.agentMode)} · ${pluralize(selected.attachments.length, 'attachment')}`
              : '',
          0,
          terminalWidth - 2,
        )}
      </text>
      <text fg={theme.muted}>
        {clearPreview
          ? 'Y clears · I inspect all · Esc cancels'
          : modeTarget
            ? '↑↓ choose · Enter saves · Esc cancels'
            : editing
              ? 'Enter saves · Shift+Enter newline · Esc cancels'
              : 'Enter inspect · E edit · M mode · [ ] reorder'}
      </text>
      <text fg={theme.muted}>
        {!editing && !modeTarget && !clearPreview
          ? 'X remove · C clear queue · U undo · R restore'
          : ''}
      </text>
      <text fg={theme.muted}>
        {!editing && !modeTarget && !clearPreview
          ? 'A attachments · P pause/resume · Esc Back'
          : ''}
      </text>
    </box>
  )
}

function modeLabel(mode: AgentMode): string {
  return mode === 'DEFAULT'
    ? 'Default'
    : mode === 'PLAN'
      ? 'Plan'
      : 'Execute Plan'
}
