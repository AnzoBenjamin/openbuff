import { TextAttributes } from '@opentui/core'
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import stringWidth from 'string-width'
import { sliceTextCells } from '../utils/text-boundaries'
import { OutputReaderScreen } from './output-reader-screen'
import {
  createTextDocument,
  type OutputDocument,
} from '../utils/output-document'
import { readSavedTranscriptInspection } from '../utils/saved-transcript-inspection'

import { Button } from './button'
import { MultilineInput } from './multiline-input'
import { SelectableList } from './selectable-list'
import { useSearchableList } from '../hooks/use-searchable-list'
import { useTerminalLayout } from '../hooks/use-terminal-layout'
import { useTheme } from '../hooks/use-theme'
import {
  deleteChatSession,
  formatRelativeTime,
  getAllChatsAsync,
} from '../utils/chat-history'
import { createTextPasteHandler } from '../utils/strings'
import { isPlainEnterKey } from '../utils/terminal-enter-detection'

import type { SelectableListItem } from './selectable-list'

const LAYOUT = {
  CONTENT_PADDING: 4,
  COMPACT_MODE_THRESHOLD: 20, // Reduce spacing in short terminals
  NARROW_WIDTH_THRESHOLD: 70, // Hide buttons when terminal width is below this
  MAIN_CONTENT_PADDING: 2,
  INITIAL_CHATS: 25, // Load this many immediately for fast display
  BACKGROUND_CHATS: 475, // Load this many more in the background for search
  MAX_RENDERED_CHATS: 100, // Only render this many in the list
  TIME_COL_WIDTH: 12, // e.g., "2 hours ago"
  MSGS_COL_WIDTH: 8, // e.g., "99 msgs"
  DELETE_COL_WIDTH: 6, // e.g., "[×]" + marginRight
  GAP_WIDTH: 3, // gap between columns
} as const

interface ChatHistoryScreenProps {
  onSelectChat: (chatId: string) => void
  onCancel: () => void
  onNewChat: () => void
  dependencies?: {
    load: typeof getAllChatsAsync
    delete: typeof deleteChatSession
    inspect?: typeof readSavedTranscriptInspection
  }
}

export const filterOutDeletedChats = <T extends { chatId: string }>(
  loaded: T[],
  deletedIds: ReadonlySet<string>,
): T[] =>
  deletedIds.size === 0
    ? loaded
    : loaded.filter((c) => !deletedIds.has(c.chatId))

export const ChatHistoryScreen: React.FC<ChatHistoryScreenProps> = ({
  onSelectChat,
  onCancel,
  onNewChat,
  dependencies = { load: getAllChatsAsync, delete: deleteChatSession },
}) => {
  const theme = useTheme()
  const { terminalWidth, terminalHeight } = useTerminalLayout()

  // Layout calculations - use full width
  const contentWidth = Math.max(1, terminalWidth - LAYOUT.CONTENT_PADDING)

  // Two-phase loading: load initial chats immediately, then more in background
  const [chats, setChats] = useState<
    Awaited<ReturnType<typeof getAllChatsAsync>>
  >([])
  const [statusMessage, setStatusMessage] = useState<string | null>(null)
  const [loadState, setLoadState] = useState<
    'loading' | 'partial' | 'loaded' | 'unavailable'
  >('loading')
  const [loadRevision, setLoadRevision] = useState(0)
  const [inspectedId, setInspectedId] = useState<string | null>(null)
  const [pendingDelete, setPendingDelete] = useState<string | null>(null)

  // Chat ids deleted since this mount. The background getAllChatsAsync
  // snapshot is taken before any delete can happen, so without filtering it
  // the terminal .then(all) write would resurrect chats the user deleted
  // while the load was still in flight.
  const deletedIdsRef = useRef<ReadonlySet<string>>(new Set())

  // Load more chats in the background after initial render
  useEffect(() => {
    let cancelled = false
    const controller = new AbortController()
    let settledState: 'loaded' | 'partial' | 'unavailable' | undefined
    setLoadState('loading')
    void dependencies
      .load(
        LAYOUT.INITIAL_CHATS + LAYOUT.BACKGROUND_CHATS,
        controller.signal,
        (initial) => {
          if (!cancelled) {
            setChats(filterOutDeletedChats(initial, deletedIdsRef.current))
            setLoadState('partial')
          }
        },
        LAYOUT.INITIAL_CHATS,
        (state) => {
          settledState = state.state
          if (!cancelled) {
            setLoadState(
              state.state === 'unavailable'
                ? 'unavailable'
                : state.state === 'partial'
                  ? 'partial'
                  : 'loaded',
            )
            if (state.omitted)
              setStatusMessage(
                `${state.omitted} saved sessions could not be read`,
              )
          }
        },
      )
      .then((all) => {
        if (!cancelled) {
          setChats(filterOutDeletedChats(all, deletedIdsRef.current))
          setLoadState(settledState ?? 'loaded')
        }
      })
      .catch(() => {
        if (!cancelled) setLoadState('unavailable')
      })
    return () => {
      cancelled = true
      controller.abort()
    }
  }, [loadRevision])

  const handleDeleteChat = useCallback(
    (chatId: string) => {
      if (pendingDelete !== chatId) {
        setPendingDelete(chatId)
        setStatusMessage(
          'Delete this saved session? Enter confirms · Esc cancels. This cannot be undone.',
        )
        return
      }
      setPendingDelete(null)
      let deleted = false
      try {
        deleted = dependencies.delete(chatId)
      } catch (error) {
        setStatusMessage(
          `Could not delete saved session: ${error instanceof Error ? error.message : String(error)}`,
        )
        return
      }
      if (deleted) {
        deletedIdsRef.current = new Set(deletedIdsRef.current).add(chatId)
        setChats((prev) => prev.filter((chat) => chat.chatId !== chatId))
        setStatusMessage(
          `Deleted saved session: ${chats.find((chat) => chat.chatId === chatId)?.lastPrompt || chatId}`,
        )
        return
      }

      setStatusMessage('Could not delete saved session')
    },
    [pendingDelete, chats, dependencies.delete],
  )

  // Calculate available width for the prompt text (last column, variable width)
  // Format: "[time]   [msgs]   [prompt...] [×]"
  // reservedWidth accounts for: time col, msgs col, delete button area,
  // 2 gaps between columns, scrollbar (1), and button padding (2)
  const reservedWidth =
    LAYOUT.TIME_COL_WIDTH +
    LAYOUT.MSGS_COL_WIDTH +
    LAYOUT.DELETE_COL_WIDTH +
    LAYOUT.GAP_WIDTH * 2 +
    3 // scrollbar + button padding
  const maxPromptWidth = Math.max(1, contentWidth - reservedWidth)

  const truncateText = (text: string, width: number) => {
    const line = text.replace(/\s+/g, ' ').trim()
    return stringWidth(line) <= width
      ? line
      : sliceTextCells(line, 0, Math.max(0, width - 1)) + '…'
  }
  const padRight = (text: string, width: number) =>
    text + ' '.repeat(Math.max(0, width - stringWidth(text)))

  // Convert chats to SelectableListItem format with aligned columns
  // Order: time | message count | prompt
  const chatItems: SelectableListItem[] = useMemo(
    () =>
      chats.map((chat) => {
        const time = padRight(
          formatRelativeTime(chat.timestamp),
          LAYOUT.TIME_COL_WIDTH,
        )
        const msgs = padRight(
          chat.messageCountKnown === false
            ? 'unknown'
            : `${chat.messageCount} msgs`,
          LAYOUT.MSGS_COL_WIDTH,
        )
        const prompt = padRight(
          truncateText(chat.lastPrompt, maxPromptWidth),
          maxPromptWidth,
        )

        return {
          id: chat.chatId,
          // Combine all columns into label for correct display order: time | msgs | prompt
          // The full prompt is kept in secondary for search filtering
          label:
            terminalWidth < 100
              ? truncateText(
                  chat.lastPrompt || chat.chatId,
                  Math.max(1, contentWidth - 10),
                )
              : `${time}${' '.repeat(LAYOUT.GAP_WIDTH)}${msgs}${' '.repeat(LAYOUT.GAP_WIDTH)}${prompt}`,
          icon: undefined,
          secondary: chat.lastPrompt, // Keep original prompt for search
          hideSecondary: true, // Don't display secondary, only use for filtering
        }
      }),
    [chats, maxPromptWidth, terminalWidth],
  )

  // Custom filter function that searches the original prompt (stored in secondary)
  const filterByPrompt = useCallback(
    (item: SelectableListItem, query: string) =>
      (item.secondary ?? '').toLowerCase().includes(query.toLowerCase()),
    [],
  )

  // Search filtering and focus management
  const {
    searchQuery,
    setSearchQuery,
    focusedIndex,
    setFocusedIndex,
    filteredItems,
    handleFocusChange,
  } = useSearchableList({
    items: chatItems,
    filterFn: filterByPrompt,
  })

  // Track the input cursor so paste inserts at the cursor (not always the end).
  const [searchCursor, setSearchCursor] = useState(0)

  const isCompactMode = terminalHeight < LAYOUT.COMPACT_MODE_THRESHOLD
  const isNarrowWidth = terminalWidth < LAYOUT.NARROW_WIDTH_THRESHOLD

  // No need to calculate listHeight - let flexbox handle it naturally

  // Handle chat selection
  const handleChatSelect = useCallback(
    (item: SelectableListItem) => {
      if (pendingDelete) return
      onSelectChat(item.id)
    },
    [onSelectChat, pendingDelete],
  )

  const handleChatDelete = useCallback(
    (item: SelectableListItem) => {
      handleDeleteChat(item.id)
    },
    [handleDeleteChat],
  )

  // Handle keyboard input
  const handleKeyIntercept = useCallback(
    (key: {
      name?: string
      sequence?: string
      shift?: boolean
      ctrl?: boolean
      meta?: boolean
      option?: boolean
    }) => {
      if (pendingDelete) {
        if (key.name === 'escape') {
          setPendingDelete(null)
          setStatusMessage(null)
          return true
        }
        if (isPlainEnterKey(key)) {
          handleDeleteChat(pendingDelete)
          return true
        }
        return true
      }
      if (key.ctrl && key.name === 'r') {
        setStatusMessage(null)
        setLoadRevision((revision) => revision + 1)
        return true
      }
      if (key.ctrl && key.name === 'o') {
        const item = filteredItems[focusedIndex]
        if (item) setInspectedId(item.id)
        return true
      }
      if (key.ctrl && key.name === 'n') {
        onNewChat()
        return true
      }
      if (key.ctrl && key.name === 'd') {
        const item = filteredItems[focusedIndex]
        if (item) handleDeleteChat(item.id)
        return true
      }
      if (key.name === 'escape') {
        if (searchQuery.length > 0) {
          setSearchQuery('')
        } else {
          onCancel()
        }
        return true
      }
      if (key.name === 'up') {
        setFocusedIndex((prev) => Math.max(0, prev - 1))
        return true
      }
      if (key.name === 'down') {
        const maxIndex = filteredItems.length - 1
        setFocusedIndex((prev) => Math.max(0, Math.min(maxIndex, prev + 1)))
        return true
      }
      if (isPlainEnterKey(key)) {
        const focused = filteredItems[focusedIndex]
        if (focused) {
          onSelectChat(focused.id)
        }
        return true
      }
      if (key.name === 'c' && key.ctrl) {
        onCancel()
        return true
      }
      return false
    },
    [
      searchQuery,
      setSearchQuery,
      setFocusedIndex,
      filteredItems,
      focusedIndex,
      onSelectChat,
      onCancel,
      onNewChat,
      pendingDelete,
      handleDeleteChat,
    ],
  )

  const selectedChat = chats.find(
    (chat) => chat.chatId === filteredItems[focusedIndex]?.id,
  )
  if (inspectedId) {
    const chat = chats.find((chat) => chat.chatId === inspectedId)
    return (
      <SavedTranscriptInspector
        chatId={inspectedId}
        metadata={`Session: ${inspectedId}\nSaved: ${chat?.timestamp ?? 'unknown'}\nMessages: ${chat?.messageCountKnown === false ? 'unknown' : (chat?.messageCount ?? 'unknown')}\n\n${chat?.lastPrompt ?? 'Prompt unavailable'}`}
        inspect={dependencies.inspect ?? readSavedTranscriptInspection}
        onClose={() => setInspectedId(null)}
      />
    )
  }

  return (
    <box
      style={{
        width: '100%',
        height: '100%',
        backgroundColor: theme.surface,
        padding: 0,
        flexDirection: 'column',
      }}
    >
      {/* Main content area */}
      <box
        style={{
          flexDirection: 'column',
          alignItems: 'stretch',
          justifyContent: 'flex-start',
          width: '100%',
          paddingLeft: 2,
          paddingRight: 2,
          paddingTop: 0,
          paddingBottom: 0,
          gap: 0,
          flexGrow: 1,
          flexShrink: 1,
        }}
      >
        {/* Title */}
        <text
          style={{
            fg: theme.foreground,
            attributes: TextAttributes.BOLD,
            marginBottom: isCompactMode ? 0 : 1,
            flexShrink: 0,
          }}
        >
          Saved sessions
        </text>

        {/* Search input */}
        <box
          style={{
            width: contentWidth,
            flexShrink: 0,
            marginBottom: 0,
          }}
        >
          <MultilineInput
            value={searchQuery}
            onChange={({ text, cursorPosition }) => {
              setSearchQuery(text)
              setSearchCursor(cursorPosition)
            }}
            onSubmit={() => {}}
            onPaste={createTextPasteHandler(
              searchQuery,
              Math.min(searchCursor, searchQuery.length),
              ({ text, cursorPosition }) => {
                setSearchQuery(text)
                setSearchCursor(cursorPosition)
              },
            )}
            onKeyIntercept={handleKeyIntercept}
            placeholder="Search sessions…"
            focused={true}
            maxHeight={1}
            minHeight={1}
            cursorPosition={Math.min(searchCursor, searchQuery.length)}
          />
        </box>

        <text
          id="saved-history-status"
          fg={loadState === 'unavailable' ? theme.error : theme.muted}
          wrapMode="none"
        >
          {loadState === 'loading'
            ? 'Loading saved sessions…'
            : loadState === 'partial'
              ? `Loaded ${chats.length} sessions · more may be loading or unavailable`
              : loadState === 'unavailable'
                ? 'Saved sessions unavailable · Ctrl+R retry'
                : filteredItems.length < chats.length
                  ? `${filteredItems.length} of ${chats.length} saved sessions`
                  : `${chats.length} saved sessions`}
        </text>
        {/* Chat list - grows to fill remaining space */}
        <box
          style={{
            flexDirection: 'column',
            width: contentWidth,
            flexGrow: 1,
            flexShrink: 1,
            overflow: 'hidden',
          }}
        >
          {filteredItems.length === 0 && loadState !== 'loaded' ? null : (
            <SelectableList
              items={filteredItems}
              focusedIndex={focusedIndex}
              onSelect={handleChatSelect}
              actionLabel="[×]"
              onAction={handleChatDelete}
              onFocusChange={handleFocusChange}
              emptyMessage={
                chats.length === 0
                  ? 'No saved sessions yet'
                  : searchQuery
                    ? 'No matching sessions'
                    : 'No saved sessions found'
              }
            />
          )}
        </box>
      </box>

      {selectedChat && (
        <text
          fg={theme.muted}
          style={{ flexShrink: 0, paddingLeft: 2, paddingRight: 2 }}
          wrapMode="none"
        >
          {sliceTextCells(
            `${formatRelativeTime(selectedChat.timestamp)} · ${selectedChat.messageCountKnown === false ? 'message count unknown' : `${selectedChat.messageCount} messages`}`,
            0,
            contentWidth,
          )}
        </text>
      )}
      {statusMessage && (
        <text
          fg={pendingDelete ? theme.warning : theme.foreground}
          style={{ flexShrink: 0, paddingLeft: 2, paddingRight: 2 }}
        >
          {statusMessage}
        </text>
      )}
      {/* Bottom bar */}
      <box
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'center',
          width: '100%',
          paddingTop: 0,
          paddingBottom: 0,
          borderStyle: 'single',
          borderColor: theme.border,
          flexShrink: 0,
          backgroundColor: theme.surface,
        }}
        border={['top']}
      >
        <box
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
            width: contentWidth,
          }}
        >
          {/* Help text */}
          <box style={{ flexGrow: 1, flexShrink: 1 }}>
            <text style={{ fg: theme.muted }}>
              ↑↓ · Enter open · Ctrl+N new · Ctrl+D delete · Ctrl+O inspect ·
              Ctrl+R retry · Esc back
            </text>
          </box>

          {/* Buttons - hidden on narrow screens */}
          {!isNarrowWidth && (
            <box style={{ flexDirection: 'row', gap: 1 }}>
              <Button
                onClick={onNewChat}
                style={{
                  paddingLeft: 1,
                  paddingRight: 1,
                  paddingTop: 0,
                  paddingBottom: 0,
                  flexShrink: 0,
                }}
              >
                <text style={{ fg: theme.primary }}>New session</text>
              </Button>
              <Button
                onClick={onCancel}
                style={{
                  paddingLeft: 1,
                  paddingRight: 1,
                  paddingTop: 0,
                  paddingBottom: 0,
                  flexShrink: 0,
                }}
              >
                <text style={{ fg: theme.muted }}>Back</text>
              </Button>
            </box>
          )}
        </box>
      </box>
    </box>
  )
}

function SavedTranscriptInspector({
  chatId,
  metadata,
  inspect,
  onClose,
}: {
  chatId: string
  metadata: string
  inspect: typeof readSavedTranscriptInspection
  onClose: () => void
}) {
  const [document, setDocument] = useState<OutputDocument>(() =>
    createTextDocument({
      id: `saved-inspection:${chatId}`,
      title: 'Saved session details',
      text: metadata,
      availability: 'pending',
      notice: 'Loading saved capture for inspection · no session restore',
    }),
  )
  useEffect(() => {
    const controller = new AbortController()
    void inspect(chatId, metadata, controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) setDocument(result)
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setDocument(
            createTextDocument({
              id: `saved-inspection:${chatId}`,
              title: 'Saved session details',
              text: metadata,
              availability: 'unavailable',
              notice: 'Saved capture unavailable · metadata only',
            }),
          )
      })
    return () => controller.abort()
  }, [chatId, metadata, inspect])
  return (
    <OutputReaderScreen
      messages={[]}
      initialDocument={document}
      onClose={onClose}
    />
  )
}
