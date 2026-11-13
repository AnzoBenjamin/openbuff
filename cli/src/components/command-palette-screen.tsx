/**
 * CommandPaletteScreen - Full-screen command palette overlay (Ctrl+P)
 *
 * Features:
 * - Unified searchable list of slash commands + project files
 * - Fuzzy subsequence matching with scoring (reuses fuzzyMatch logic)
 * - Enter executes the selected command (`/<id>`) or opens the selected file
 * - Escape closes the palette
 * - Empty query shows all commands + a capped set of files
 */

import { TextAttributes } from '@opentui/core'
import React, { useCallback, useMemo, useRef, useState } from 'react'

import { MultilineInput } from './multiline-input'
import { SelectableList } from './selectable-list'
import { useTerminalLayout } from '../hooks/use-terminal-layout'
import { useTheme } from '../hooks/use-theme'
import { createTextPasteHandler } from '../utils/strings'
import { isPlainEnterKey } from '../utils/terminal-enter-detection'
import { BORDER_CHARS } from '../utils/ui-constants'
import { fuzzyMatch } from '../utils/fuzzy-match'
import { getRecentCommandIds, recordCommandUse } from '../utils/command-mru'
import stringWidth from 'string-width'

import { getAllPathsWithDirectories } from '@codebuff/common/project-file-tree'

import type { SelectableListItem } from './selectable-list'
import type { SlashCommand } from '../data/slash-commands'
import type { FileTreeNode } from '@codebuff/common/util/file'

const LAYOUT = {
  CONTENT_PADDING: 1,
  INPUT_HEIGHT: 1,
  MAX_LIST_HEIGHT: 20,
  /** Cap on files shown when the query is empty (commands are always all shown). */
  MAX_EMPTY_FILE_ITEMS: 50,
  /** Cap on total items rendered for performance. */
  MAX_RENDERED_ITEMS: 200,
} as const

/** Discriminated palette entry: a slash command or a file path. */
export type PaletteEntry =
  | { kind: 'command'; command: SlashCommand }
  | { kind: 'action'; action: PaletteAction }
  | { kind: 'file'; filePath: string; isDirectory: boolean }

interface CommandPaletteScreenProps {
  actions?: PaletteAction[]
  /** Slash commands (already merged with skills by the caller). */
  slashCommands: SlashCommand[]
  /** Project file tree (may be empty if not yet loaded). */
  fileTree: FileTreeNode[]
  /** Called when the user closes the palette without selecting. */
  onClose: () => void
  /** Called when the user selects a slash command; receives `/<id>`. */
  onExecuteCommand: (commandString: string) => void
  /** Replaces the draft deliberately; insertText commands never execute. */
  onInsertText?: (text: string) => void
  fileInventoryState?: 'loading' | 'loaded' | 'unavailable'
  /** Called when the user selects a file path. */
  onSelectFile: (filePath: string, isDirectory: boolean) => void
}
export interface PaletteAction {
  id: string
  label: string
  description: string
  onSelect: () => void
}

/**
 * Build palette entries from commands + flattened file tree.
 * Commands always come first; files follow.
 */
export function buildEntries(
  slashCommands: SlashCommand[],
  fileTree: FileTreeNode[],
  maxFileItems: number,
): PaletteEntry[] {
  const commandEntries: PaletteEntry[] = slashCommands.map((command) => ({
    kind: 'command',
    command,
  }))

  const allFiles = getAllPathsWithDirectories(fileTree)
  const fileEntries: PaletteEntry[] = allFiles
    .slice(0, maxFileItems)
    .map((info) => ({
      kind: 'file',
      filePath: info.path,
      isDirectory: info.isDirectory,
    }))

  return [...commandEntries, ...fileEntries]
}

/**
 * Score an entry against a query. Lower is better. Returns null if no match.
 */
export function scoreEntry(entry: PaletteEntry, query: string): number | null {
  if (!query) return 0
  const normalized = query.toLowerCase()
  if (entry.kind === 'action') {
    if (entry.action.label.toLowerCase().includes(normalized)) return -990
    if (entry.action.description.toLowerCase().includes(normalized)) return -700
    return fuzzyMatch(entry.action.label, normalized)?.score ?? null
  }

  if (entry.kind === 'command') {
    const idLower = entry.command.id.toLowerCase()
    const labelLower = entry.command.label.toLowerCase()
    const descLower = entry.command.description.toLowerCase()

    // Exact / prefix matches rank highest
    if (idLower === normalized) return -1000
    if (labelLower === normalized) return -990
    if (idLower.startsWith(normalized)) return -900
    if (labelLower.startsWith(normalized)) return -890

    // Substring in id/label
    if (idLower.includes(normalized)) return -800 + idLower.indexOf(normalized)
    if (labelLower.includes(normalized))
      return -790 + labelLower.indexOf(normalized)
    if (descLower.includes(normalized))
      return -700 + descLower.indexOf(normalized)

    // Fuzzy fallback on the label
    const fuzzy = fuzzyMatch(entry.command.label, normalized)
    return fuzzy ? fuzzy.score - 500 : null
  }

  // File entry
  const pathLower = entry.filePath.toLowerCase()
  const fileName = entry.filePath.slice(entry.filePath.lastIndexOf('/') + 1)
  const fileNameLower = fileName.toLowerCase()

  if (pathLower === normalized) return -1000
  if (fileNameLower === normalized) return -990
  if (fileNameLower.startsWith(normalized)) return -950
  if (pathLower.startsWith(normalized)) return -900
  if (fileNameLower.includes(normalized))
    return -800 + fileNameLower.indexOf(normalized)
  if (pathLower.includes(normalized))
    return -700 + pathLower.indexOf(normalized)

  const fuzzy = fuzzyMatch(entry.filePath, normalized)
  return fuzzy ? fuzzy.score - 500 : null
}

/**
 * Convert a palette entry to a SelectableListItem for rendering.
 */
export function entryToListItem(entry: PaletteEntry): SelectableListItem {
  if (entry.kind === 'action')
    return {
      id: `action:${entry.action.id}`,
      label: entry.action.label,
      secondary: entry.action.description,
      accent: true,
    }
  if (entry.kind === 'command') {
    return {
      id: `cmd:${entry.command.id}`,
      label: entry.command.id,
      icon: '▸',
      secondary: entry.command.description,
      accent: true,
    }
  }
  return {
    id: `file:${entry.filePath}`,
    label: entry.filePath,
    icon: entry.isDirectory ? '📁' : '📄',
    secondary: entry.isDirectory ? 'dir' : undefined,
  }
}

export const CommandPaletteScreen: React.FC<CommandPaletteScreenProps> = ({
  slashCommands,
  fileTree,
  onClose,
  onExecuteCommand,
  onInsertText,
  fileInventoryState = 'loaded',
  onSelectFile,
  actions = [],
}) => {
  const theme = useTheme()
  const { terminalWidth, terminalHeight } = useTerminalLayout()

  const [searchQuery, setSearchQuery] = useState('')
  const [searchCursor, setSearchCursor] = useState(0)
  const [focusedIndex, setFocusedIndex] = useState(0)
  const [focusedId, setFocusedId] = useState<string>()
  const queryRef = useRef('')
  const focusRef = useRef<{ index: number; id?: string }>({ index: 0 })
  const activatedRef = useRef(false)
  const pendingMatchesRef = useRef<{
    source: PaletteEntry[]
    query: string
    entries: PaletteEntry[]
  } | null>(null)

  // Keep the complete searchable corpus. Only the empty-query presentation is
  // capped; otherwise files after the first 50 could never be discovered.
  const allEntries = useMemo(
    () => [
      ...actions.map((action): PaletteEntry => ({ kind: 'action', action })),
      ...buildEntries(slashCommands, fileTree, Number.MAX_SAFE_INTEGER),
    ],
    [slashCommands, fileTree, actions],
  )

  // Filter + sort entries by fuzzy score
  const matchEntries = useCallback(
    (query: string) => {
      const trimmed = query.trim()
      if (!trimmed) {
        // fzf-style history merge: recently-used commands float to the top of
        // the empty-query view, so repeat workflows are one Enter away. MRU
        // order is read once per keystroke-batch (tiny fail-open JSON).
        const recent = new Set(getRecentCommandIds())
        const commandEntries = allEntries.filter(
          (entry) => entry.kind === 'command',
        )
        const ranked = [
          ...commandEntries.filter((entry) => recent.has(entry.command.id)),
          ...commandEntries.filter((entry) => !recent.has(entry.command.id)),
        ]
        const fileEntries = allEntries
          .filter((entry) => entry.kind === 'file')
          .slice(0, LAYOUT.MAX_EMPTY_FILE_ITEMS)
        return [
          ...allEntries.filter((entry) => entry.kind === 'action'),
          ...ranked,
          ...fileEntries,
        ]
      }

      const scored: { entry: PaletteEntry; score: number }[] = []
      for (const entry of allEntries) {
        const score = scoreEntry(entry, trimmed)
        if (score !== null) {
          scored.push({ entry, score })
        }
      }
      scored.sort((a, b) => a.score - b.score)
      return scored.map((s) => s.entry)
    },
    [allEntries],
  )
  const matchedEntries = useMemo(
    () => matchEntries(searchQuery),
    [matchEntries, searchQuery],
  )
  const filteredEntries = useMemo(
    () => matchedEntries.slice(0, LAYOUT.MAX_RENDERED_ITEMS),
    [matchedEntries],
  )
  // Input events can arrive before React renders the new query or selection.
  const currentEntries = useCallback(() => {
    const query = queryRef.current
    if (query === searchQuery) return filteredEntries
    const cached = pendingMatchesRef.current
    if (cached?.source === allEntries && cached.query === query)
      return cached.entries
    const entries = matchEntries(query).slice(0, LAYOUT.MAX_RENDERED_ITEMS)
    pendingMatchesRef.current = { source: allEntries, query, entries }
    return entries
  }, [allEntries, searchQuery, filteredEntries, matchEntries])
  const currentFocus = useCallback((entries: PaletteEntry[]) => {
    const { index, id } = focusRef.current
    const anchored =
      id === undefined
        ? -1
        : entries.findIndex((entry) => entryToListItem(entry).id === id)
    return {
      index:
        anchored >= 0
          ? anchored
          : Math.max(0, Math.min(index, entries.length - 1)),
      removed: id !== undefined && anchored === -1,
    }
  }, [])
  const handleQueryChange = useCallback(
    ({ text, cursorPosition }: { text: string; cursorPosition: number }) => {
      queryRef.current = text
      focusRef.current = { index: 0 }
      setSearchQuery(text)
      setSearchCursor(cursorPosition)
      setFocusedIndex(0)
      setFocusedId(undefined)
    },
    [],
  )

  const items = useMemo(() => {
    const trimmed = searchQuery.trim()
    const listItems = filteredEntries.map(entryToListItem)
    if (!trimmed) return listItems
    // fzf-style emphasis: bold the matched subsequence in each visible row.
    // Re-running the matcher on displayed rows only is bounded by list height
    // and keeps the scoring pipeline untouched.
    return listItems.map((item, index) => {
      const entry = filteredEntries[index]
      const text =
        entry?.kind === 'command'
          ? entry.command.label
          : entry?.kind === 'action'
            ? entry.action.label
            : entry?.filePath
      if (!text) return item
      const fuzzy = fuzzyMatch(text, trimmed)
      if (!fuzzy) return item
      // Map indices from the scored text onto the displayed label: file rows
      // display the same path; command rows display the id, which the label
      // contains, so only in-range indices carry over.
      const offset = text.indexOf(item.label)
      if (offset === -1) return item
      const labelIndices = fuzzy.indices
        .filter((idx) => idx >= offset && idx < offset + item.label.length)
        .map((idx) => idx - offset)
      return labelIndices.length > 0 ? { ...item, labelIndices } : item
    })
  }, [filteredEntries, searchQuery])

  // Clamp focused index when the filtered list shrinks
  const anchoredIndex = focusedId
    ? items.findIndex((item) => item.id === focusedId)
    : -1
  const selectionRemoved = focusedId !== undefined && anchoredIndex === -1
  const clampedFocusedIndex =
    anchoredIndex >= 0
      ? anchoredIndex
      : Math.max(0, Math.min(focusedIndex, Math.max(0, items.length - 1)))
  const selectIndex = useCallback(
    (index: number) => {
      const entries = currentEntries()
      const clamped = Math.max(
        0,
        Math.min(index, Math.max(0, entries.length - 1)),
      )
      const id = entries[clamped]
        ? entryToListItem(entries[clamped]).id
        : undefined
      focusRef.current = { index: clamped, id }
      setFocusedIndex(clamped)
      setFocusedId(id)
    },
    [currentEntries],
  )

  const activateEntry = useCallback(
    (entry: PaletteEntry | undefined) => {
      if (!entry || activatedRef.current) return
      if (entry.kind === 'command') {
        if (entry.command.insertText !== undefined) {
          if (onInsertText) {
            activatedRef.current = true
            recordCommandUse(entry.command.id)
            onClose()
            onInsertText(entry.command.insertText)
          }
          return
        }
        activatedRef.current = true
        recordCommandUse(entry.command.id)
        onExecuteCommand(`/${entry.command.id}`)
      } else if (entry.kind === 'action') {
        activatedRef.current = true
        entry.action.onSelect()
      } else {
        activatedRef.current = true
        onSelectFile(entry.filePath, entry.isDirectory)
      }
    },
    [onExecuteCommand, onSelectFile, onInsertText, onClose],
  )
  const handleSelect = useCallback(
    (item: SelectableListItem) => {
      activateEntry(
        currentEntries().find((entry) => entryToListItem(entry).id === item.id),
      )
    },
    [activateEntry, currentEntries],
  )
  const handleSubmit = useCallback(() => {
    const entries = currentEntries()
    const focused = currentFocus(entries)
    if (!focused.removed) activateEntry(entries[focused.index])
  }, [activateEntry, currentEntries, currentFocus])

  const handleKeyIntercept = useCallback(
    (key: {
      name?: string
      sequence?: string
      shift?: boolean
      ctrl?: boolean
      meta?: boolean
      option?: boolean
    }) => {
      if (key.name === 'escape') {
        onClose()
        return true
      }
      if (key.name === 'up') {
        selectIndex(currentFocus(currentEntries()).index - 1)
        return true
      }
      if (key.name === 'down') {
        selectIndex(currentFocus(currentEntries()).index + 1)
        return true
      }
      if (isPlainEnterKey(key)) {
        return false
      }
      if (key.name === 'c' && key.ctrl) {
        onClose()
        return true
      }
      // Let printable keys through to the input
      return false
    },
    [onClose, selectIndex, currentFocus, currentEntries],
  )

  const contentWidth = Math.max(1, terminalWidth)
  const innerWidth = Math.max(1, contentWidth - LAYOUT.CONTENT_PADDING * 2)
  const selectedEntry = filteredEntries[clampedFocusedIndex]
  const insertionSelected =
    selectedEntry?.kind === 'command' &&
    selectedEntry.command.insertText !== undefined
  const actionHint = insertionSelected
    ? onInsertText
      ? 'Enter: Insert draft · Esc close'
      : 'Insertion unavailable · Esc close'
    : 'Enter: Run / open · Esc close'
  const fileCount = allEntries.filter((entry) => entry.kind === 'file').length
  const shownFiles = filteredEntries.filter(
    (entry) => entry.kind === 'file',
  ).length
  const resultHint = searchQuery.trim()
    ? `${filteredEntries.length} of ${matchedEntries.length} matches${innerWidth < 60 ? '' : ' shown'}${matchedEntries.length > filteredEntries.length ? ' · Refine search' : ''}`
    : `First ${shownFiles} of ${fileCount} files · ${innerWidth < 60 ? 'Search all' : 'Type to search all'}${matchedEntries.length > filteredEntries.length ? ' · More commands/actions; refine search' : ''}`
  const inventoryHint =
    fileInventoryState === 'loaded'
      ? 'File inventory loaded'
      : fileInventoryState === 'loading'
        ? 'Files loading · Retained paths only'
        : 'Files unavailable · Retained paths only'
  const selectionHint = 'Selection unavailable · Use arrows'
  const headerHeight = [
    'Command Palette',
    actionHint,
    resultHint,
    inventoryHint,
    ...(selectionRemoved ? [selectionHint] : []),
  ].reduce(
    (rows, text) =>
      rows + Math.max(1, Math.ceil(stringWidth(text) / innerWidth)),
    0,
  )
  const availableListHeight = Math.max(
    1,
    terminalHeight - headerHeight - LAYOUT.INPUT_HEIGHT - 4,
  )
  const listHeight = Math.min(
    LAYOUT.MAX_LIST_HEIGHT,
    availableListHeight,
    Math.max(items.length, 1),
  )

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
          width: contentWidth,
          paddingLeft: LAYOUT.CONTENT_PADDING,
          paddingRight: LAYOUT.CONTENT_PADDING,
          paddingTop: 1,
          paddingBottom: 1,
          flexGrow: 1,
          flexShrink: 1,
        }}
      >
        {/* Header */}
        <box style={{ flexDirection: 'column', flexShrink: 0 }}>
          <text
            style={{
              fg: theme.primary,
              attributes: TextAttributes.BOLD,
            }}
          >
            Command Palette
          </text>
          <text style={{ fg: theme.muted }}>{actionHint}</text>
        </box>
        <text style={{ fg: theme.muted, flexShrink: 0 }}>{resultHint}</text>
        <text
          style={{
            fg:
              fileInventoryState === 'unavailable'
                ? theme.warning
                : theme.muted,
            flexShrink: 0,
          }}
        >
          {inventoryHint}
        </text>
        {selectionRemoved && (
          <text style={{ fg: theme.warning, flexShrink: 0 }}>
            {selectionHint}
          </text>
        )}

        {/* Search input */}
        <box style={{ flexShrink: 0, marginBottom: 0, marginTop: 0 }}>
          <MultilineInput
            value={searchQuery}
            onChange={handleQueryChange}
            onSubmit={handleSubmit}
            onPaste={createTextPasteHandler(
              searchQuery,
              Math.min(searchCursor, searchQuery.length),
              handleQueryChange,
            )}
            onKeyIntercept={handleKeyIntercept}
            placeholder="Search commands or files..."
            focused={true}
            maxHeight={1}
            minHeight={1}
            cursorPosition={Math.min(searchCursor, searchQuery.length)}
          />
        </box>

        {/* Results list */}
        <box
          style={{
            flexDirection: 'column',
            width: '100%',
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
            items={items}
            focusedIndex={clampedFocusedIndex}
            onFocusChange={selectIndex}
            onSelect={handleSelect}
            maxHeight={listHeight}
            emptyMessage={
              searchQuery.trim()
                ? `No matches for "${searchQuery.trim()}"`
                : 'No commands or files available'
            }
          />
        </box>
      </box>
    </box>
  )
}
