import { TextAttributes } from '@opentui/core'
import React, { useCallback, useEffect, useMemo, useState } from 'react'

import stringWidth from 'string-width'
import { sliceTextCells } from '../utils/text-boundaries'
import { OutputReaderScreen } from './output-reader-screen'
import { createTextDocument } from '../utils/output-document'

import { MultilineInput } from './multiline-input'
import { SelectableList } from './selectable-list'
import { listPlanSessionsAsync } from '../commands/plan-artifacts'
import { useSearchableList } from '../hooks/use-searchable-list'
import { useTerminalLayout } from '../hooks/use-terminal-layout'
import { useTheme } from '../hooks/use-theme'
import { createTextPasteHandler } from '../utils/strings'
import { isPlainEnterKey } from '../utils/terminal-enter-detection'
import { BORDER_CHARS } from '../utils/ui-constants'

import type { SelectableListItem } from './selectable-list'

const LAYOUT = {
  CONTENT_PADDING: 4,
  COMPACT_MODE_THRESHOLD: 14,
  NARROW_WIDTH_THRESHOLD: 80,
  MAX_RENDERED_SESSIONS: 500,
  SLUG_COL_WIDTH: 32,
  ARTIFACTS_COL_WIDTH: 32,
  GAP_WIDTH: 3,
} as const

export function getNextPlanSessionFocusIndex(
  currentIndex: number,
  filteredItemCount: number,
): number {
  const maxIndex = Math.max(0, filteredItemCount - 1)
  return Math.min(maxIndex, currentIndex + 1)
}

interface PlanSessionPickerScreenProps {
  command: string
  onSelectSession: (sessionDir: string) => void
  onCancel: () => void
  loadSessions?: typeof listPlanSessionsAsync
}

export const PlanSessionPickerScreen: React.FC<
  PlanSessionPickerScreenProps
> = ({
  command,
  onSelectSession,
  onCancel,
  loadSessions = listPlanSessionsAsync,
}) => {
  const theme = useTheme()
  const { terminalWidth, terminalHeight } = useTerminalLayout()
  const contentWidth = Math.max(1, terminalWidth - LAYOUT.CONTENT_PADDING)
  const isCompactMode = terminalHeight < LAYOUT.COMPACT_MODE_THRESHOLD
  const isNarrowWidth = terminalWidth < LAYOUT.NARROW_WIDTH_THRESHOLD

  const [sessions, setSessions] = useState<
    Awaited<ReturnType<typeof listPlanSessionsAsync>>
  >([])
  const [loadState, setLoadState] = useState<'loading' | 'loaded' | 'failed'>(
    'loading',
  )
  const [loadError, setLoadError] = useState('')
  const [loadRevision, setLoadRevision] = useState(0)
  const [inspectedId, setInspectedId] = useState<string | null>(null)
  useEffect(() => {
    const controller = new AbortController()
    setLoadState('loading')
    setLoadError('')
    void loadSessions({ signal: controller.signal })
      .then((rows) => {
        if (!controller.signal.aborted) {
          setSessions(rows)
          setLoadState('loaded')
        }
      })
      .catch((error) => {
        if (!controller.signal.aborted) {
          setLoadState('failed')
          setLoadError(error instanceof Error ? error.message : String(error))
        }
      })
    return () => controller.abort()
  }, [loadRevision, loadSessions])
  const truncateText = (text: string, width: number) =>
    stringWidth(text) <= width
      ? text
      : sliceTextCells(text, 0, Math.max(0, width - 1)) + '…'
  const padRight = (text: string, width: number) =>
    text + ' '.repeat(Math.max(0, width - stringWidth(text)))

  const sessionItems: SelectableListItem[] = useMemo(() => {
    const reservedWidth =
      LAYOUT.SLUG_COL_WIDTH +
      LAYOUT.ARTIFACTS_COL_WIDTH +
      LAYOUT.GAP_WIDTH * 2 +
      5
    const maxPathWidth = Math.max(1, contentWidth - reservedWidth)

    return sessions.map((session) => {
      const slug = padRight(
        truncateText(session.slug, LAYOUT.SLUG_COL_WIDTH),
        LAYOUT.SLUG_COL_WIDTH,
      )
      const artifacts = padRight(
        truncateText(session.artifacts.join(', '), LAYOUT.ARTIFACTS_COL_WIDTH),
        LAYOUT.ARTIFACTS_COL_WIDTH,
      )
      const path = padRight(
        truncateText(session.sessionDir, maxPathWidth),
        maxPathWidth,
      )

      return {
        id: session.sessionDir,
        label:
          terminalWidth < 120
            ? truncateText(
                `${session.slug} · ${session.status}`,
                Math.max(1, contentWidth - 5),
              )
            : `${slug}${' '.repeat(LAYOUT.GAP_WIDTH)}${artifacts}${' '.repeat(LAYOUT.GAP_WIDTH)}${path}`,
        secondary: `${session.slug} ${session.sessionDir} ${session.artifacts.join(' ')}`,
        hideSecondary: true,
      }
    })
  }, [contentWidth, sessions, terminalWidth])

  const filterSessions = useCallback(
    (item: SelectableListItem, query: string) => {
      const haystack = `${item.label} ${item.secondary ?? ''}`.toLowerCase()
      return haystack.includes(query.toLowerCase())
    },
    [],
  )

  const {
    searchQuery,
    setSearchQuery,
    focusedIndex,
    setFocusedIndex,
    filteredItems,
    handleFocusChange,
  } = useSearchableList({
    items: sessionItems,
    filterFn: filterSessions,
  })

  const [searchCursor, setSearchCursor] = useState(0)

  const handleSessionSelect = useCallback(
    (item: SelectableListItem) => {
      onSelectSession(item.id)
    },
    [onSelectSession],
  )

  const handleKeyIntercept = useCallback(
    (key: {
      name?: string
      sequence?: string
      shift?: boolean
      ctrl?: boolean
      meta?: boolean
      option?: boolean
    }) => {
      if (key.ctrl && key.name === 'r') {
        setLoadRevision((revision) => revision + 1)
        return true
      }
      if (key.ctrl && key.name === 'o') {
        const selected = filteredItems[focusedIndex]
        if (selected) setInspectedId(selected.id)
        return true
      }
      if (key.name === 'escape') {
        if (searchQuery.length > 0) {
          setSearchQuery('')
          setSearchCursor(0)
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
        setFocusedIndex((prev) =>
          getNextPlanSessionFocusIndex(prev, filteredItems.length),
        )
        return true
      }
      if (isPlainEnterKey(key)) {
        const focused = filteredItems[focusedIndex]
        if (focused) {
          onSelectSession(focused.id)
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
      onSelectSession,
      onCancel,
    ],
  )

  const selectedSession = sessions.find(
    (session) => session.sessionDir === filteredItems[focusedIndex]?.id,
  )
  if (inspectedId) {
    const session = sessions.find(
      (session) => session.sessionDir === inspectedId,
    )
    return (
      <OutputReaderScreen
        messages={[]}
        initialDocument={createTextDocument({
          id: inspectedId,
          title: 'Plan session details',
          text: `Session: ${session?.slug ?? inspectedId}\nPath: ${inspectedId}\nState: ${session?.status ?? 'unknown'}\nUpdated: ${session?.updatedAt ?? 'unknown'}\nArtifacts: ${session?.artifacts.join(', ') ?? 'unavailable'}\nCurrent task: ${session?.currentTask ?? 'unknown'}`,
        })}
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
      <box
        style={{
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'flex-start',
          width: '100%',
          paddingLeft: 2,
          paddingRight: 2,
          paddingTop: isCompactMode ? 0 : 1,
          paddingBottom: 0,
          gap: 0,
          flexGrow: 1,
          flexShrink: 1,
        }}
      >
        {!isCompactMode && (
          <box
            style={{
              flexDirection: 'column',
              alignItems: 'center',
              marginBottom: 1,
              marginTop: 1,
              flexShrink: 0,
            }}
          >
            <text
              style={{ fg: theme.foreground, attributes: TextAttributes.BOLD }}
            >
              Select a plan session for /{command}
            </text>
          </box>
        )}

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
            placeholder="Search plan sessions..."
            focused={true}
            maxHeight={1}
            minHeight={1}
            cursorPosition={Math.min(searchCursor, searchQuery.length)}
          />
        </box>

        <box
          style={{
            flexDirection: 'column',
            width: contentWidth,
            borderStyle: 'single',
            borderColor: theme.muted,
            customBorderChars: BORDER_CHARS,
            flexGrow: 1,
            flexShrink: 1,
            overflow: 'hidden',
          }}
          border={['top', 'bottom', 'left', 'right']}
        >
          <SelectableList
            items={filteredItems}
            focusedIndex={focusedIndex}
            onSelect={handleSessionSelect}
            onFocusChange={handleFocusChange}
            emptyMessage={
              loadState === 'loading'
                ? 'Loading plan sessions…'
                : loadState === 'failed'
                  ? `Plan sessions unavailable: ${loadError} · Ctrl+R retry`
                  : sessions.length === 0
                    ? 'No plan sessions found under .agents/sessions'
                    : searchQuery
                      ? 'No matching plan sessions'
                      : 'No plan sessions found'
            }
          />
        </box>
      </box>

      {selectedSession && (
        <text fg={theme.muted} style={{ flexShrink: 0 }} wrapMode="none">
          {sliceTextCells(
            `${selectedSession.artifacts.join(', ')} · ${selectedSession.sessionDir}`,
            0,
            contentWidth,
          )}
        </text>
      )}
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
          <box style={{ flexGrow: 1, flexShrink: 1 }}>
            <text style={{ fg: theme.muted }}>
              ↑↓ · Enter select · Ctrl+O details · Ctrl+R retry · Esc{' '}
              {searchQuery ? 'clear search' : 'cancel'} · Ctrl+C cancel
            </text>
          </box>

          {!isNarrowWidth && (
            <box style={{ flexShrink: 0 }}>
              <text style={{ fg: theme.muted }}>
                {filteredItems.length} session
                {filteredItems.length === 1 ? '' : 's'}
              </text>
            </box>
          )}
        </box>
      </box>
    </box>
  )
}
