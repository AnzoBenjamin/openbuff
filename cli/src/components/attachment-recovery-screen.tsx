import React, { useEffect, useRef, useState } from 'react'
import { useKeyboard } from '@opentui/react'
import { Button } from './button'
import { OutputReaderScreen } from './output-reader-screen'
import { useTheme } from '../hooks/use-theme'
import { useTerminalDimensions } from '../hooks/use-terminal-dimensions'
import { useChatStore } from '../state/chat-store'
import { getProjectRoot } from '../project-files'
import { createAttachmentDocument } from '../utils/attachment-document'
import {
  getPendingAttachmentId,
  retryPendingAttachment,
} from '../utils/pending-attachments'
import { sliceTextCells } from '../utils/text-boundaries'
import type { PendingAttachment } from '../types/store'
import type { OutputDocument } from '../utils/output-document'

interface AttachmentRecoveryScreenProps {
  onClose: () => void
  loadAttachment?: typeof retryPendingAttachment
}
type ReadOperation = {
  controller: AbortController
  original: PendingAttachment
  processing: PendingAttachment
  owner: symbol
}

/** Composer attachment operations never touch the conversation draft or queued removal history. */
export function AttachmentRecoveryScreen({
  onClose,
  loadAttachment = retryPendingAttachment,
}: AttachmentRecoveryScreenProps) {
  const theme = useTheme()
  const { terminalWidth, terminalHeight } = useTerminalDimensions()
  const attachments = useChatStore((state) => state.pendingAttachments)
  const [selectedIndex, setSelectedIndex] = useState(0)
  const selectedRef = useRef(0)
  selectedRef.current = selectedIndex
  const [inspection, setInspection] = useState<OutputDocument | null>(null)
  const [notice, setNotice] = useState('')
  const [removedCount, setRemovedCount] = useState(0)
  const removed = useRef<{
    index: number
    attachment: PendingAttachment
  } | null>(null)
  const active = useRef(new Map<string, ReadOperation>())
  const interrupted = useRef(new Map<string, ReadOperation>())
  const mounted = useRef(true)
  const update = (
    expected: PendingAttachment,
    replacement: PendingAttachment,
  ) => {
    const state = useChatStore.getState()
    if (!state.pendingAttachments.includes(expected)) return false
    useChatStore.setState({
      pendingAttachments: state.pendingAttachments.map((item) =>
        item === expected ? replacement : item,
      ),
    })
    return true
  }
  const cancel = (attachment: PendingAttachment) => {
    const id = getPendingAttachmentId(attachment)
    const operation = active.current.get(id)
    if (!operation) return attachment
    active.current.delete(id)
    operation.controller.abort()
    update(operation.processing, operation.original)
    return operation.original
  }
  useEffect(() => {
    mounted.current = true
    const unsubscribe = useChatStore.subscribe((state) => {
      // Observe disappearance immediately, including external Remove/Clear followed by Undo.
      for (const [id, operation] of active.current) {
        if (!state.pendingAttachments.includes(operation.processing)) {
          active.current.delete(id)
          interrupted.current.set(id, operation)
          operation.controller.abort()
        }
      }
      for (const [id, operation] of interrupted.current) {
        if (state.pendingAttachments.includes(operation.processing)) {
          interrupted.current.delete(id)
          update(operation.processing, operation.original)
        }
      }
    })
    return () => {
      mounted.current = false
      unsubscribe()
      for (const operation of active.current.values()) {
        operation.controller.abort()
        update(operation.processing, operation.original)
      }
      active.current.clear()
      interrupted.current.clear()
    }
  }, [])
  const retry = async (attachment: PendingAttachment) => {
    if (attachment.kind === 'text') {
      setNotice(
        'Text is already captured; inspect it to read the exact source.',
      )
      return
    }
    const id = getPendingAttachmentId(attachment)
    if (active.current.has(id)) return
    const processing: PendingAttachment = {
      ...attachment,
      status: 'processing',
      note: 'Reading fresh source · previous capture retained',
    }
    const operation = {
      controller: new AbortController(),
      original: attachment,
      processing,
      owner: Symbol('composer-attachment-read'),
    }
    active.current.set(id, operation)
    if (!update(attachment, processing)) {
      active.current.delete(id)
      return
    }
    setNotice('Reading fresh source · previous capture retained')
    try {
      const result = await loadAttachment(
        attachment,
        attachment.sourceRoot ?? getProjectRoot(),
        operation.controller.signal,
      )
      if (
        !mounted.current ||
        active.current.get(id)?.owner !== operation.owner ||
        operation.controller.signal.aborted
      )
        return
      active.current.delete(id)
      const saved = update(processing, result)
      if (saved)
        setNotice(
          result.kind !== 'text' && result.status === 'error'
            ? 'Retry failed · previous capture retained'
            : 'Fresh attachment snapshot ready',
        )
    } catch (error) {
      if (
        !mounted.current ||
        active.current.get(id)?.owner !== operation.owner ||
        operation.controller.signal.aborted
      )
        return
      active.current.delete(id)
      update(processing, {
        ...attachment,
        status: 'error',
        note: `Retry failed: ${error instanceof Error ? error.message : String(error)} · previous capture retained`,
      })
      setNotice('Retry failed · previous capture retained')
    }
  }
  const remove = (attachment: PendingAttachment, index: number) => {
    const captured = cancel(attachment)
    removed.current = { index, attachment: captured }
    setRemovedCount(1)
    useChatStore
      .getState()
      .removePendingAttachment(
        captured.kind === 'text' ? captured.id : captured.path,
      )
    setNotice('Attachment removed · U restores its original capture')
  }
  const undo = () => {
    const snapshot = removed.current
    if (!snapshot) {
      setNotice('Nothing to restore')
      return
    }
    const id = getPendingAttachmentId(snapshot.attachment)
    const current = useChatStore.getState().pendingAttachments
    if (!current.some((item) => getPendingAttachmentId(item) === id)) {
      const next = [...current]
      next.splice(Math.min(snapshot.index, next.length), 0, snapshot.attachment)
      useChatStore.setState({ pendingAttachments: next })
    }
    removed.current = null
    setRemovedCount(0)
    setNotice('Attachment restored · original capture and source retained')
  }
  useKeyboard((key) => {
    if (inspection) return
    const index = Math.min(
      selectedRef.current,
      Math.max(0, attachments.length - 1),
    )
    const attachment = attachments[index]
    if (key.name === 'escape') onClose()
    else if (key.name === 'up' || key.name === 'down') {
      const next = Math.max(
        0,
        Math.min(attachments.length - 1, index + (key.name === 'up' ? -1 : 1)),
      )
      selectedRef.current = next
      setSelectedIndex(next)
    } else if (
      (key.name === 'i' || key.name === 'return' || key.name === 'enter') &&
      attachment
    )
      setInspection(createAttachmentDocument(attachment))
    else if (key.name === 'r' && attachment) void retry(attachment)
    else if (key.name === 'c' && attachment) {
      cancel(attachment)
      setNotice('Attachment retry cancelled · previous capture retained')
    } else if (key.name === 'x' && attachment) remove(attachment, index)
    else if (key.name === 'u') undo()
    else return
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
  const index = Math.min(selectedIndex, Math.max(0, attachments.length - 1))
  const selected = attachments[index]
  const height = Math.max(1, terminalHeight - 6)
  const start = Math.max(
    0,
    Math.min(index - Math.floor(height / 2), attachments.length - height),
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
        Composer attachments · {selected ? index + 1 : 0}/{attachments.length}
      </text>
      <text fg={theme.muted} style={{ flexShrink: 0 }}>
        Draft text stays unchanged.
      </text>
      <box style={{ flexGrow: 1, overflow: 'hidden', flexDirection: 'column' }}>
        {attachments
          .slice(start, start + height)
          .map((attachment, position) => (
            <Button
              key={getPendingAttachmentId(attachment)}
              onClick={() => {
                setSelectedIndex(start + position)
                setInspection(createAttachmentDocument(attachment))
              }}
              onMouseOver={() => {
                selectedRef.current = start + position
                setSelectedIndex(start + position)
              }}
            >
              <text
                fg={
                  start + position === index
                    ? theme.foreground
                    : attachment.kind !== 'text' &&
                        attachment.status === 'error'
                      ? theme.error
                      : theme.muted
                }
                wrapMode="none"
              >
                {sliceTextCells(
                  `${start + position === index ? '›' : ' '} ${attachment.kind === 'text' ? `Text · ${attachment.preview}` : `${attachment.status} · ${attachment.filename}`}`,
                  0,
                  terminalWidth - 2,
                )}
              </text>
            </Button>
          ))}
        {!attachments.length && (
          <text fg={theme.muted}>
            No composer attachments · U restores the last removed item
          </text>
        )}
      </box>
      {selected && (
        <text
          fg={
            selected.kind !== 'text' && selected.status === 'error'
              ? theme.error
              : theme.muted
          }
          style={{ flexShrink: 0 }}
          wrapMode="none"
        >
          {sliceTextCells(
            selected.kind === 'text'
              ? `${selected.charCount} captured characters`
              : `${selected.path} · ${selected.note ?? selected.status}`,
            0,
            terminalWidth - 2,
          )}
        </text>
      )}
      <text fg={theme.muted} style={{ flexShrink: 0 }} wrapMode="none">
        {sliceTextCells(
          notice ||
            (removedCount
              ? 'Undo attachment removal available · U restores'
              : ''),
          0,
          terminalWidth - 2,
        )}
      </text>
      <text fg={theme.muted} style={{ flexShrink: 0 }} wrapMode="none">
        ↑↓ select · I inspect · R fresh retry · C cancel
      </text>
      <text fg={theme.muted} style={{ flexShrink: 0 }} wrapMode="none">
        X remove · U undo attachment · Esc back
      </text>
    </box>
  )
}
