import { realpathSync } from 'fs'
import os from 'os'
import path from 'path'
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Button } from './button'
import { MultilineInput } from './multiline-input'
import { SelectableList } from './selectable-list'
import { OutputReaderScreen } from './output-reader-screen'
import {
  useDirectoryBrowser,
  type UseDirectoryBrowserOptions,
} from '../hooks/use-directory-browser'
import { usePathTabCompletion } from '../hooks/use-path-tab-completion'
import { useTerminalLayout } from '../hooks/use-terminal-layout'
import { useTheme } from '../hooks/use-theme'
import { isDirectoryPathQuery } from '../utils/directory-browser'
import { createTextDocument } from '../utils/output-document'
import { formatCwd } from '../utils/path-helpers'
import { loadRecentProjects } from '../utils/recent-projects'
import { createTextPasteHandler } from '../utils/strings'
import { sliceTextCells } from '../utils/text-boundaries'

interface ProjectPickerScreenProps {
  onSelectProject: (projectPath: string) => void | Promise<void>
  error?: string
  busy?: boolean
  initialPath?: string
  initialQuery?: string
  browserDependencies?: UseDirectoryBrowserOptions['dependencies']
  recentProjects?: ReturnType<typeof loadRecentProjects>
}

export const ProjectPickerScreen: React.FC<ProjectPickerScreenProps> = ({
  onSelectProject,
  initialPath,
  initialQuery = '',
  error,
  busy = false,
  browserDependencies,
  recentProjects: suppliedRecents,
}) => {
  const theme = useTheme()
  const { terminalWidth, terminalHeight } = useTerminalLayout()
  const width = Math.max(1, terminalWidth - 2)
  const [query, setQuery] = useState(initialQuery)
  const [cursor, setCursor] = useState(initialQuery.length)
  const [focus, setFocus] = useState(0)
  const [view, setView] = useState<'directories' | 'recents'>('directories')
  const [localError, setLocalError] = useState<string>()
  const [selecting, setSelecting] = useState(false)
  const selectingRef = useRef(false)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const [inspectedText, setInspectedText] = useState<string | null>(null)
  const browser = useDirectoryBrowser({
    initialPath,
    dependencies: browserDependencies,
  })
  const {
    currentPath,
    setCurrentPath,
    expandPath,
    tryNavigateToPath,
    navigateToDirectory,
  } = browser
  const recents = useMemo(
    () =>
      (suppliedRecents ?? loadRecentProjects()).filter(
        (project) => project.path !== os.homedir(),
      ),
    [suppliedRecents],
  )
  const selectProject = useCallback(
    async (projectPath: string) => {
      if (busy || selectingRef.current) return
      selectingRef.current = true
      setSelecting(true)
      setLocalError(undefined)
      try {
        await onSelectProject(realpathSync(projectPath))
      } catch (cause) {
        if (mounted.current)
          setLocalError(
            `Could not open ${projectPath}: ${cause instanceof Error ? cause.message : String(cause)}`,
          )
      } finally {
        selectingRef.current = false
        if (mounted.current) setSelecting(false)
      }
    },
    [busy, onSelectProject],
  )
  const items = useMemo(() => {
    if (view === 'recents')
      return recents
        .filter((entry) =>
          `${entry.path}`.toLowerCase().includes(query.toLowerCase()),
        )
        .map((entry) => ({ id: entry.path, label: formatCwd(entry.path) }))
    const text = query.trim().toLowerCase()
    return browser.directories
      .filter(
        (entry) =>
          !text ||
          isDirectoryPathQuery(query) ||
          (!entry.isParent && entry.name.toLowerCase().includes(text)),
      )
      .map((entry) => ({
        id: entry.path,
        label: `${entry.name}${entry.isGitRepo ? ' · git' : ''}${entry.isSymlink ? ' · link' : ''}`,
      }))
  }, [browser.directories, query, recents, view])
  const safeFocus = Math.min(Math.max(0, focus), Math.max(0, items.length - 1))
  const size = Math.max(
    1,
    terminalHeight - (error || localError || browser.error ? 7 : 6),
  )
  const start = Math.max(
    0,
    Math.min(safeFocus - Math.floor(size / 2), items.length - size),
  )
  const setQueryAndCursor = (text: string) => {
    setQuery(text)
    setCursor(text.length)
    setFocus(0)
  }
  const { handleTabCompletion } = usePathTabCompletion({
    searchQuery: query,
    setSearchQuery: setQueryAndCursor,
    currentPath,
    setCurrentPath,
    expandPath,
  })
  const enter = (submittedQuery = query, itemId = items[safeFocus]?.id) => {
    if (busy || selecting) return
    setLocalError(undefined)
    if (view === 'recents') {
      if (itemId) void selectProject(itemId)
      return
    }
    if (isDirectoryPathQuery(submittedQuery)) {
      if (tryNavigateToPath(submittedQuery)) setQueryAndCursor('')
      return
    }
    if (browser.loadState === 'loading' || browser.loadState === 'error') return
    const candidates = browser.directories.filter(
      (entry) =>
        !submittedQuery.trim() ||
        (!entry.isParent &&
          entry.name
            .toLowerCase()
            .includes(submittedQuery.trim().toLowerCase())),
    )
    const entry =
      candidates.find((entry) => entry.path === itemId) ??
      (submittedQuery !== query ? candidates[0] : undefined)
    if (entry) {
      navigateToDirectory(entry)
      setQueryAndCursor('')
    }
  }
  const intercept = (key: {
    name?: string
    ctrl?: boolean
    shift?: boolean
  }) => {
    if (key.name === 'escape') {
      if (view === 'recents') setView('directories')
      setQueryAndCursor('')
      setLocalError(undefined)
      browser.clearError()
      return true
    }
    if (key.ctrl && key.name === 'o') {
      setInspectedText(
        view === 'recents'
          ? (items[safeFocus]?.id ?? currentPath)
          : currentPath,
      )
      return true
    }
    if (key.ctrl && key.name === 'p') {
      setView((value) => (value === 'directories' ? 'recents' : 'directories'))
      setQueryAndCursor('')
      return true
    }
    if (key.ctrl && key.name === 'r') {
      browser.retry()
      setLocalError(undefined)
      return true
    }
    if (key.ctrl && key.name === 'u') {
      setCurrentPath(path.dirname(currentPath))
      setQueryAndCursor('')
      return true
    }
    if (key.name === 'tab') return handleTabCompletion()
    if ((key.name === 'return' || key.name === 'enter') && key.ctrl) {
      void selectProject(currentPath)
      return true
    }
    if (key.name === 'up') {
      setFocus((value) => Math.max(0, value - 1))
      return true
    }
    if (key.name === 'down') {
      setFocus((value) => Math.min(Math.max(0, items.length - 1), value + 1))
      return true
    }
    return false
  }
  if (inspectedText !== null)
    return (
      <OutputReaderScreen
        messages={[]}
        initialDocument={createTextDocument({
          id: 'project-path',
          title: 'Project folder',
          text: inspectedText,
        })}
        onClose={() => setInspectedText(null)}
      />
    )
  const shownPath = formatCwd(currentPath)
  const clippedPath =
    sliceTextCells(shownPath, 0, width) === shownPath
      ? shownPath
      : `…${sliceTextCells(path.basename(currentPath), 0, width - 1)}`
  return (
    <box
      style={{
        width: '100%',
        height: '100%',
        backgroundColor: theme.surface,
        paddingLeft: 1,
        paddingRight: 1,
        flexDirection: 'column',
      }}
    >
      <text fg={theme.foreground} style={{ flexShrink: 0 }} wrapMode="none">
        Openbuff · {view === 'recents' ? 'Recent projects' : 'Choose project'}
      </text>
      <MultilineInput
        value={query}
        onChange={({ text, cursorPosition }) => {
          setQuery(text)
          setCursor(cursorPosition)
          setFocus(0)
        }}
        onSubmit={(input) => enter(input?.text)}
        onPaste={createTextPasteHandler(
          query,
          cursor,
          ({ text, cursorPosition }) => {
            setQuery(text)
            setCursor(cursorPosition)
            setFocus(0)
          },
        )}
        onKeyIntercept={intercept}
        placeholder={
          view === 'recents'
            ? 'Search recent projects…'
            : 'Search folders or enter a path…'
        }
        focused
        cursorPosition={cursor}
        minHeight={1}
        maxHeight={1}
      />
      <text
        fg={browser.loadState === 'error' ? theme.error : theme.muted}
        wrapMode="none"
        style={{ flexShrink: 0 }}
      >
        {sliceTextCells(
          view === 'recents'
            ? `${items.length} recent projects`
            : browser.loadState === 'loading'
              ? `Loading ${currentPath}`
              : browser.loadState === 'error'
                ? 'Folder unavailable · Ctrl+R retry'
                : `${items.length} folders · ${browser.loadState === 'partial' ? 'Partial results / checking git' : 'Ready'}`,
          0,
          width,
        )}
      </text>
      <box style={{ flexGrow: 1, flexShrink: 1, overflow: 'hidden' }}>
        <SelectableList
          items={items.slice(start, start + size)}
          focusedIndex={safeFocus - start}
          onSelect={(item) => enter(query, item.id)}
          onFocusChange={(index) => setFocus(index + start)}
          emptyMessage={
            browser.loadState === 'loading'
              ? 'Loading folders…'
              : browser.loadState === 'error'
                ? 'Folder unavailable · Ctrl+R retry · Ctrl+U up'
                : query
                  ? 'No matching directories'
                  : view === 'recents'
                    ? 'No recent projects'
                    : 'No child folders'
          }
        />
      </box>
      {(error || localError || browser.error || busy || selecting) && (
        <text
          fg={error || localError || browser.error ? theme.error : theme.muted}
          style={{ flexShrink: 0 }}
          wrapMode="none"
        >
          {sliceTextCells(
            error || localError || browser.error || 'Opening project…',
            0,
            width,
          )}
        </text>
      )}
      <text fg={theme.muted} wrapMode="none" style={{ flexShrink: 0 }}>
        {clippedPath}
      </text>
      <box
        style={{
          flexDirection: 'row',
          flexShrink: 0,
          justifyContent: 'space-between',
        }}
      >
        <Button onClick={() => void selectProject(currentPath)}>
          <text fg={theme.primary}>Open (Ctrl+Enter)</text>
        </Button>
        {terminalWidth >= 50 && (
          <Button
            onClick={() => {
              setView((value) =>
                value === 'directories' ? 'recents' : 'directories',
              )
              setQueryAndCursor('')
            }}
          >
            <text fg={theme.primary}>Recent (Ctrl+P)</text>
          </Button>
        )}
      </box>
      <text fg={theme.muted} wrapMode="none" style={{ flexShrink: 0 }}>
        {terminalWidth < 45
          ? 'Enter browse · Ctrl+P recents'
          : 'Enter browses folders · Open uses current folder · Ctrl+O full path'}
      </text>
    </box>
  )
}
