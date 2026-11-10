import { useKeyboard } from '@opentui/react'
import { TextAttributes } from '@opentui/core'
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { MultilineInput } from './multiline-input'
import { Button } from './button'
import { ReaderLine } from './reader-line'
import { ShortcutLine } from './shortcut-line'
import { readableOutput } from '../utils/readable-output'
import { useTheme } from '../hooks/use-theme'
import { useTerminalDimensions } from '../hooks/use-terminal-dimensions'
import { copyTextToClipboard } from '../utils/clipboard'
import {
  collectOutputEntries,
  filterOutputEntries,
} from '../utils/output-catalog'
import { sliceTextCells } from '../utils/text-boundaries'
import { previousTextRowStart } from '../utils/text-boundaries'
import { readDocumentRows } from '../utils/reading-state'
import stringWidth from 'string-width'
import { createTextPasteHandler } from '../utils/strings'
import type {
  OutputDocument,
  OutputLocation,
  OutputKind,
} from '../utils/output-document'
import type { ChatMessage } from '../types/chat'
import type { InputValue } from '../types/store'
import { useOutputReaderStore } from '../state/output-reader-store'
import { exportOutputDocument } from '../utils/output-export'
import {
  createJsonDocument,
  createTextDocument,
} from '../utils/output-document'

type ReaderMode = 'browse' | 'read' | 'find' | 'goto' | 'outline'
function sourceStartLine(document?: OutputDocument | null): number | undefined {
  const start = document?.provenance?.startLine
  return start !== undefined &&
    Number.isSafeInteger(start) &&
    start >= 1 &&
    Number.isSafeInteger(start + (document?.lineCount ?? 1) - 1)
    ? start
    : undefined
}
function displayLine(document: OutputDocument, line: number): number {
  return line + (sourceStartLine(document) ?? 1)
}
export interface OutputReaderScreenProps {
  messages: readonly ChatMessage[]
  documentId?: string
  initialDocument?: OutputDocument
  findConversation?: boolean
  kindFilter?: readonly OutputKind[]
  onClose: () => void
  onReturnToMessage?: (messageId: string, toolCallId?: string) => void
}

export function OutputReaderScreen({
  messages,
  documentId,
  initialDocument,
  findConversation,
  kindFilter,
  onClose,
  onReturnToMessage,
}: OutputReaderScreenProps) {
  const theme = useTheme()
  const { terminalWidth, terminalHeight } = useTerminalDimensions()
  const catalog = useMemo(() => {
    const entries = collectOutputEntries(messages)
    return kindFilter ? filterOutputEntries(entries, kindFilter) : entries
  }, [messages, kindFilter])
  const [selectedId, setSelectedId] = useState<string | null>(
    documentId ?? initialDocument?.id ?? null,
  )
  const [mode, setMode] = useState<ReaderMode>(selectedId ? 'read' : 'browse')
  const initialCapture =
    catalog.find((item) => item.id === selectedId)?.read() ?? initialDocument
  const initialView = selectedId
    ? useOutputReaderStore.getState().views[selectedId]
    : undefined
  const restoredView =
    initialView?.revision === initialCapture?.revision ? initialView : undefined
  const [input, setInputState] = useState('')
  const inputRef = useRef(input)
  inputRef.current = input
  const browseGeneration = useRef(0)
  const setInput = useCallback((text: string) => {
    if (inputRef.current !== text) browseGeneration.current++
    inputRef.current = text
    setInputState(text)
  }, [])
  const [cursor, setCursor] = useState(0)
  const [selected, setSelectedState] = useState(0)
  const selectedRef = useRef(selected)
  selectedRef.current = selected
  const setSelected = useCallback(
    (value: number | ((previous: number) => number)) => {
      const next = Math.max(
        0,
        typeof value === 'function' ? value(selectedRef.current) : value,
      )
      selectedRef.current = next
      setSelectedState(next)
    },
    [],
  )
  const [location, setLocation] = useState<OutputLocation>(
    restoredView?.location ?? {
      line: 0,
      character: 0,
    },
  )
  const [horizontal, setHorizontal] = useState(restoredView?.horizontal ?? 0)
  const [query, setQuery] = useState(restoredView?.query ?? '')
  const [rawView, setRawView] = useState(false)
  const [notice, setNotice] = useState('')
  const [exportPath, setExportPath] = useState<string | null>(null)
  const [following, setFollowing] = useState(false)
  const [wrapOverride, setWrapOverride] = useState<boolean | null>(
    restoredView?.wrap ?? null,
  )
  const [openedDocuments, setOpenedDocuments] = useState(
    new Map<string, OutputDocument>(),
  )
  const [detailParents, setDetailParents] = useState<
    Array<{
      id: string
      document: OutputDocument
      location: OutputLocation
      horizontal: number
      wrap: boolean | null
      query: string
    }>
  >([])
  const [recovering, setRecovering] = useState(false)
  const recoveryGeneration = useRef(0)
  const anchors = useRef(new Map<string, OutputLocation>())
  const [hits, setHits] = useState<
    Array<{ id: string; line: number; title: string }>
  >([])
  const [searching, setSearching] = useState(false)
  const [hitsQuery, setHitsQuery] = useState('')
  const modeRef = useRef(mode)
  modeRef.current = mode
  const entry = catalog.find((item) => item.id === selectedId)
  const originEntry =
    entry ?? catalog.find((item) => item.id === detailParents[0]?.id)
  const capturedDocument =
    (selectedId ? openedDocuments.get(selectedId) : undefined) ??
    entry?.read() ??
    (initialDocument?.id === selectedId ? initialDocument : null)
  const document = useMemo(
    () =>
      capturedDocument && !rawView
        ? readableOutput(capturedDocument)
        : capturedDocument,
    [capturedDocument?.revision, rawView],
  )
  const bodyHeight = Math.max(1, terminalHeight - 6)
  const firstLine = sourceStartLine(document)
  const lastLine = (firstLine ?? 1) + (document?.lineCount ?? 1) - 1
  const lineNumberWidth = document ? String(lastLine).length + 2 : 0
  const showOutline =
    mode === 'read' &&
    terminalWidth >= 120 &&
    terminalHeight >= 24 &&
    Boolean(document?.landmarks.length)
  const outlineWidth = showOutline ? 28 : 0
  const availableBodyWidth = Math.max(
    1,
    terminalWidth - lineNumberWidth - 2 - (showOutline ? outlineWidth + 1 : 0),
  )
  const bodyWidth =
    document?.kind === 'markdown'
      ? Math.min(100, availableBodyWidth)
      : availableBodyWidth
  const wrap =
    wrapOverride ??
    (document?.kind === 'markdown' ||
      (!rawView && (document?.kind === 'text' || document?.kind === 'json')))
  useEffect(() => {
    if (!document) return
    setLocation((previous) => {
      const line = Math.max(0, Math.min(previous.line, document.lineCount - 1))
      const character = Math.max(
        0,
        Math.min(previous.character, document.line(line).length),
      )
      return line === previous.line && character === previous.character
        ? previous
        : { line, character }
    })
  }, [document?.revision])
  useEffect(() => {
    if (!document || !selectedId) return
    useOutputReaderStore.getState().remember(selectedId, {
      revision: document.revision,
      location,
      horizontal,
      wrap: wrapOverride,
      query,
    })
  }, [
    document?.revision,
    selectedId,
    location,
    horizontal,
    wrapOverride,
    query,
  ])
  useEffect(
    () => () => {
      recoveryGeneration.current++
      browseGeneration.current++
    },
    [],
  )
  const recoverArtifact = useCallback(async () => {
    if (!entry?.recover || recovering) return
    const id = entry.id
    const generation = ++recoveryGeneration.current
    setRecovering(true)
    setNotice('Reading the saved captured artifact…')
    try {
      const recovered = await entry.recover()
      if (generation !== recoveryGeneration.current) return
      setOpenedDocuments((previous) => {
        const next = new Map(previous)
        next.set(id, recovered)
        if (next.size > 4) next.delete(next.keys().next().value!)
        return next
      })
      setLocation({ line: 0, character: 0 })
      setNotice(recovered.notice)
    } catch (error) {
      if (generation === recoveryGeneration.current)
        setNotice(
          error instanceof Error
            ? error.message
            : 'Captured artifact could not be read',
        )
    } finally {
      if (generation === recoveryGeneration.current) setRecovering(false)
    }
  }, [entry, recovering])
  const visibleRows = document
    ? readDocumentRows(
        document,
        location,
        bodyWidth,
        bodyHeight,
        wrap,
        horizontal,
      )
    : []
  const browsingSearch =
    mode === 'browse' && (findConversation || input.trim().length > 0)

  // Conversation search yields between documents, and cancellation owns the
  // query generation. Collapsed/offscreen retained blocks share this catalog.
  useEffect(() => {
    if (!browsingSearch || !input.trim()) {
      setHits([])
      setSearching(false)
      return
    }
    let cancelled = false
    setSearching(true)
    void (async () => {
      const result: typeof hits = []
      let yieldedAt = performance.now()
      for (const item of catalog) {
        if (cancelled) return
        const candidate = item.read()
        const match = candidate.find(input, { line: 0, character: 0 }, 1)
        if (match)
          result.push({
            id: item.id,
            line: match.line,
            title: `${item.title} · line ${displayLine(candidate, match.line)}`,
          })
        if (result.length >= 200) break
        if (performance.now() - yieldedAt > 8) {
          await new Promise((resolve) => setTimeout(resolve, 0))
          yieldedAt = performance.now()
        }
      }
      if (!cancelled) {
        setHits(result)
        setHitsQuery(input)
        setSearching(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [catalog, input, browsingSearch])

  useEffect(() => {
    if (following && document)
      setLocation({
        line: Math.max(0, document.lineCount - bodyHeight),
        character: 0,
      })
  }, [following, document, bodyHeight])

  const browseRows = useMemo(
    () =>
      browsingSearch && input.trim()
        ? hits
        : [...catalog]
            .reverse()
            .map((item) => ({ id: item.id, line: 0, title: item.title })),
    [catalog, hits, browsingSearch, input],
  )
  const landmarks = document?.landmarks ?? []
  const currentLandmark = Math.max(
    0,
    landmarks.findLastIndex((item) => item.line <= location.line),
  )
  const outlineStart = Math.max(0, currentLandmark - bodyHeight + 2)
  const selectDocument = useCallback(
    (id: string, line?: number) => {
      if (selectedId) anchors.current.set(selectedId, location)
      recoveryGeneration.current++
      browseGeneration.current++
      setRecovering(false)
      setDetailParents([])
      setSelectedId(id)
      const nextDocument =
        openedDocuments.get(id) ??
        catalog.find((item) => item.id === id)?.read()
      const remembered = useOutputReaderStore.getState().views[id]
      const view =
        remembered?.revision === nextDocument?.revision ? remembered : undefined
      setLocation(
        line === undefined
          ? (view?.location ??
              anchors.current.get(id) ?? { line: 0, character: 0 })
          : { line, character: 0 },
      )
      setMode('read')
      setInput('')
      setCursor(0)
      setHorizontal(view?.horizontal ?? 0)
      setWrapOverride(view?.wrap ?? null)
      setQuery(view?.query ?? '')
      setFollowing(false)
      setNotice('')
      setExportPath(null)
    },
    [selectedId, location, catalog, openedDocuments],
  )
  const openDetailDocument = useCallback(
    (detail: OutputDocument) => {
      if (!document || !selectedId) return
      if (detailParents.length >= 32) {
        setNotice(
          'Detail depth limit reached · Back returns to the retained parent',
        )
        return
      }
      setDetailParents((previous) => [
        ...previous,
        {
          id: selectedId,
          document: capturedDocument ?? document,
          location,
          horizontal,
          wrap: wrapOverride,
          query,
        },
      ])
      setOpenedDocuments((previous) => {
        const next = new Map(previous).set(detail.id, detail)
        if (next.size > 4) {
          const victim = [...next.keys()].find(
            (id) => id !== selectedId && id !== detail.id,
          )
          if (victim) next.delete(victim)
        }
        return next
      })
      setSelectedId(detail.id)
      setLocation({ line: 0, character: 0 })
      setHorizontal(0)
      setWrapOverride(null)
      setQuery('')
      setMode('read')
      setNotice('')
    },
    [
      document,
      capturedDocument,
      selectedId,
      detailParents.length,
      location,
      horizontal,
      wrapOverride,
      query,
    ],
  )
  const jumpMatch = useCallback(
    (direction: 1 | -1, newQuery = query) => {
      if (!document || !newQuery) return
      const from = {
        line: location.line,
        character: Math.max(0, location.character + direction),
      }
      const found =
        document.find(newQuery, from, direction) ??
        document.find(
          newQuery,
          direction === 1
            ? { line: 0, character: 0 }
            : {
                line: document.lineCount - 1,
                character: document.line(document.lineCount - 1).length,
              },
          direction,
        )
      if (found) {
        setLocation(found)
        setHorizontal(
          wrap
            ? 0
            : stringWidth(document.line(found.line).slice(0, found.character)),
        )
        setFollowing(false)
        setNotice(`Match · line ${displayLine(document, found.line)}`)
      } else setNotice('No matches in this captured output')
    },
    [document, query, location, wrap],
  )
  const submitInput = useCallback(
    (latest?: InputValue) => {
      const submittedText = latest?.text ?? input
      if (mode === 'find') {
        setQuery(submittedText)
        const found = document?.find(
          submittedText,
          { line: 0, character: 0 },
          1,
        )
        if (found && document) {
          setLocation(found)
          setFollowing(false)
          setHorizontal(
            wrap
              ? 0
              : stringWidth(
                  document.line(found.line).slice(0, found.character),
                ),
          )
          setNotice(`Match · line ${displayLine(document, found.line)}`)
        } else setNotice('No matches in this captured output')
        setMode('read')
      } else if (mode === 'goto') {
        if (/^row\b/i.test(submittedText.trim())) {
          const rowNumber = Number(submittedText.trim().slice(3).trim())
          if (
            !document?.detail ||
            !Number.isInteger(rowNumber) ||
            rowNumber < 1 ||
            rowNumber > (document.rowCount ?? 0)
          ) {
            setNotice(
              `Enter row followed by a number from 1 to ${document?.rowCount ?? 0}`,
            )
            return
          }
          const detail = document.detail(rowNumber - 1)
          if (detail) openDetailDocument(detail)
          else setNotice('That row has no retained detail')
          return
        }
        const number = Number(submittedText)
        const startLine = sourceStartLine(document) ?? 1
        const endLine = startLine + (document?.lineCount ?? 0) - 1
        if (
          !Number.isInteger(number) ||
          number < startLine ||
          number > endLine
        ) {
          setNotice(`Enter a line from ${startLine} to ${endLine}`)
          return
        }
        setLocation({ line: number - startLine, character: 0 })
        setFollowing(false)
        setMode('read')
        setNotice('')
      } else if (mode === 'browse') {
        if (
          submittedText.trim() &&
          (submittedText !== hitsQuery || searching)
        ) {
          const generation = ++browseGeneration.current
          setSearching(true)
          void (async () => {
            let yieldedAt = performance.now()
            for (const item of catalog) {
              if (
                generation !== browseGeneration.current ||
                modeRef.current !== 'browse' ||
                inputRef.current !== submittedText
              )
                return
              const match = item
                .read()
                .find(submittedText, { line: 0, character: 0 }, 1)
              if (match) {
                selectDocument(item.id, match.line)
                setSearching(false)
                return
              }
              if (performance.now() - yieldedAt > 8) {
                await new Promise((resolve) => setTimeout(resolve, 0))
                yieldedAt = performance.now()
              }
            }
            if (generation === browseGeneration.current) {
              setNotice('No matches in loaded messages')
              setSearching(false)
            }
          })()
        } else {
          const row =
            browseRows[Math.min(selectedRef.current, browseRows.length - 1)]
          if (row)
            selectDocument(row.id, submittedText.trim() ? row.line : undefined)
        }
      }
    },
    [
      mode,
      input,
      document,
      openDetailDocument,
      browseRows,
      selected,
      selectDocument,
      browsingSearch,
      wrap,
      hitsQuery,
      searching,
      catalog,
    ],
  )
  const closeScope = useCallback(() => {
    if (mode === 'find' || mode === 'goto' || mode === 'outline') {
      setMode('read')
      return
    }
    const parent = detailParents.at(-1)
    if (parent) {
      setOpenedDocuments((previous) =>
        new Map(previous).set(parent.id, parent.document),
      )
      setSelectedId(parent.id)
      setLocation(parent.location)
      setHorizontal(parent.horizontal)
      setWrapOverride(parent.wrap)
      setQuery(parent.query)
      setDetailParents((previous) => previous.slice(0, -1))
      return
    }
    onClose()
  }, [mode, onClose, detailParents])
  const inputOwnsKeys = mode === 'find' || mode === 'goto' || mode === 'browse'
  useKeyboard((key) => {
    if (inputOwnsKeys) return
    if (key.name === 'escape' || (key.ctrl && key.name === 'c')) {
      key.preventDefault()
      closeScope()
      return
    }
    if (mode === 'outline') {
      if (key.name === 'up') setSelected((value) => Math.max(0, value - 1))
      if (key.name === 'down')
        setSelected((value) => Math.min(landmarks.length - 1, value + 1))
      if (key.name === 'return') {
        const item = landmarks[selectedRef.current]
        if (item) setLocation({ line: item.line, character: 0 })
        setFollowing(false)
        setMode('read')
      }
      key.preventDefault()
      return
    }
    const move = (amount: number) => {
      setLocation((value) => ({
        line: Math.max(
          0,
          Math.min((document?.lineCount ?? 1) - 1, value.line + amount),
        ),
        character: 0,
      }))
      setFollowing(false)
    }
    if (key.name === 'l' && entry?.recover) {
      void recoverArtifact()
    } else if (
      key.name === 't' &&
      originEntry?.messageId &&
      onReturnToMessage
    ) {
      onReturnToMessage(originEntry.messageId, originEntry.toolCallId)
    } else if (key.name === 'return' && document?.detail && document.rowCount) {
      let low = 0,
        high = document.rowCount - 1
      while (low < high) {
        const middle = Math.ceil((low + high) / 2)
        if ((document.row?.(middle)?.line ?? Infinity) <= location.line)
          low = middle
        else high = middle - 1
      }
      const rowIndex =
        (document.row?.(low)?.line ?? Infinity) <= location.line
          ? low
          : undefined
      const detail =
        rowIndex === undefined ? undefined : document.detail(rowIndex)
      if (detail) openDetailDocument(detail)
    } else if (key.name === 'up' || key.name === 'k') {
      if (wrap && document && location.character > 0)
        setLocation({
          line: location.line,
          character: previousTextRowStart(
            document.line(location.line),
            location.character,
            bodyWidth,
          ),
        })
      else move(-1)
      setFollowing(false)
    } else if (key.name === 'down' || key.name === 'j') {
      const next = visibleRows[0]?.next
      if (wrap && next && next.line < (document?.lineCount ?? 0))
        setLocation(next)
      else move(1)
      setFollowing(false)
    } else if (key.name === 'pageup') {
      if (wrap && document && location.character > 0)
        setLocation({
          line: location.line,
          character: previousTextRowStart(
            document.line(location.line),
            location.character,
            bodyWidth * bodyHeight,
          ),
        })
      else move(-bodyHeight)
      setFollowing(false)
    } else if (key.name === 'pagedown' || key.name === 'space') {
      const next = visibleRows.at(-1)?.next
      if (wrap && next && next.line < (document?.lineCount ?? 0))
        setLocation(next)
      else move(bodyHeight)
      setFollowing(false)
    } else if (key.name === 'home') {
      setLocation({ line: 0, character: 0 })
      setFollowing(false)
    } else if (key.name === 'end') {
      setLocation({
        line: Math.max(0, (document?.lineCount ?? 1) - bodyHeight),
        character: 0,
      })
      setFollowing(false)
    } else if (key.name === 'left')
      setHorizontal((value) =>
        Math.max(0, value - Math.max(1, Math.floor(bodyWidth / 2))),
      )
    else if (key.name === 'right')
      setHorizontal((value) => value + Math.max(1, Math.floor(bodyWidth / 2)))
    else if (key.name === '/' || (key.ctrl && key.name === 'f')) {
      setMode('find')
      setInput(query)
      setCursor(query.length)
    } else if (key.name === 'g') {
      setMode('goto')
      setInput('')
      setCursor(0)
    } else if (key.sequence === '?' || key.name === '?') {
      openDetailDocument(
        createTextDocument({
          id: `${document?.id}:keys`,
          title: 'Reader keyboard commands',
          text: 'MOVE\n↑ ↓ / J K     Previous / next visual row\nPgUp PgDn    Previous / next page\nHome End     First / last page\n← →          Move across columns\n\nFIND & OPEN\n/ or Ctrl+F  Find exact captured text\nN / Shift+N  Next / previous match\nG            Go to line; row <number> opens a row\nEnter        Open the selected complete value\nO            Open outline\nB            Browse captured outputs\nEsc          Back; close find before leaving reader\n\nVIEW & COPY\nW            Toggle wrapping\nV            Toggle readable fields / raw paths\nC            Copy selected exact line or value\nS            Copy section\nE            Export captured document\nX            Copy exported path\nF            Follow live log output\nD            Source and availability details\nL            Load saved artifact, when available\nT            Return to source message, when available',
        }),
      )
    } else if (key.name === 'd' && document) {
      openDetailDocument(
        createJsonDocument(
          `${document.id}:source-details`,
          'Output source and availability',
          {
            captureId: capturedDocument?.id,
            capturedTitle: capturedDocument?.title,
            availability: document.availability,
            notice: document.notice,
            provenance: document.provenance,
            coverage: document.coverage,
            outcome: document.outcome,
            capturedRows: document.rowCount,
            readableLines: document.lineCount,
          },
        ),
      )
    } else if (key.name === 'o') {
      setMode('outline')
      setSelected(
        Math.max(
          0,
          landmarks.findLastIndex((item) => item.line <= location.line),
        ),
      )
    } else if (key.name === 'b') {
      setMode('browse')
      setInput('')
      setCursor(0)
      setSelected(0)
    } else if (key.name === 'n') jumpMatch(key.shift ? -1 : 1)
    else if (key.name === 'f' && document?.kind === 'log')
      setFollowing((value) => !value)
    else if (key.name === 'v') {
      setRawView((value) => !value)
      setLocation((value) => ({ line: value.line, character: 0 }))
      setHorizontal(0)
    } else if (key.name === 'w') {
      setWrapOverride(!wrap)
      setHorizontal(0)
    } else if (key.name === 's' && document?.copySection && landmarks.length) {
      const landmark = document.landmarks.findLast(
        (item) => item.line <= location.line,
      )
      const text = landmark ? document.copySection(landmark.id) : undefined
      if (text !== undefined)
        void copyTextToClipboard(text, { suppressGlobalMessage: true })
          .then(() => setNotice('Captured section copied'))
          .catch(() =>
            setNotice(
              'Copy failed · export the captured view to read it as plain text',
            ),
          )
      else
        setNotice(
          'No section at this location · use the outline to choose a heading',
        )
    } else if (key.name === 'x' && exportPath) {
      void copyTextToClipboard(exportPath, { suppressGlobalMessage: true })
        .then(() => setNotice('Export path copied'))
        .catch(() => setNotice(`Copy failed · saved at ${exportPath}`))
    } else if (key.name === 'e' && document) {
      void exportOutputDocument(document)
        .then((destination) => {
          setExportPath(destination)
          setNotice('Captured view saved · X copies the file path')
        })
        .catch((error) =>
          setNotice(error instanceof Error ? error.message : 'Export failed'),
        )
    } else if (key.name === 'c' && document) {
      const text = document.copyLine(location.line)
      void copyTextToClipboard(text, { suppressGlobalMessage: true })
        .then(() => setNotice('Selected line/value copied'))
        .catch(() =>
          setNotice('Copy failed · select the text in your terminal to copy'),
        )
    }
    key.preventDefault()
  })
  const top = Math.max(
    0,
    Math.min(location.line, (document?.lineCount ?? 1) - 1),
  )
  const list =
    mode === 'outline'
      ? landmarks.map((item) => ({
          id: item.id,
          title: `${'  '.repeat(Math.min(3, item.level - 1))}${item.label}`,
          line: item.line,
        }))
      : browseRows
  const listStart = Math.max(0, selected - bodyHeight + 1)

  return (
    <box
      style={{
        flexDirection: 'column',
        width: '100%',
        height: '100%',
        backgroundColor: theme.background,
        paddingLeft: 1,
        paddingRight: 1,
      }}
    >
      <box
        style={{
          height: 1,
          flexDirection: 'row',
          flexShrink: 0,
          gap: 2,
          backgroundColor: theme.surface,
        }}
      >
        <Button onClick={closeScope}>
          <text fg={theme.primary}>Back (Esc)</text>
        </Button>
        <text fg={theme.foreground} attributes={TextAttributes.BOLD}>
          {sliceTextCells(
            mode === 'browse'
              ? 'Browse captured output'
              : (document?.title ?? 'Output unavailable'),
            0,
            Math.max(1, terminalWidth - 16),
          )}
        </text>
      </box>
      <text fg={theme.muted} style={{ height: 1, flexShrink: 0 }}>
        {sliceTextCells(
          mode === 'browse'
            ? `${catalog.length} outputs in ${messages.length} loaded messages · collapsed content included`
            : [
                document?.availability === 'limited'
                  ? 'Limited'
                  : document?.availability === 'pending'
                    ? 'Pending'
                    : document?.availability === 'unavailable'
                      ? 'Unavailable'
                      : 'Retained',
                document?.provenance?.freshness === 'stale'
                  ? 'Stale source'
                  : document?.provenance?.freshness === 'cached'
                    ? 'Cached source'
                    : '',
                document?.outcome?.label,
                document?.notice ?? 'This output is no longer retained',
                document?.provenance?.identity,
              ]
                .filter(Boolean)
                .join(' · '),
          0,
          terminalWidth - 2,
        )}
      </text>
      {inputOwnsKeys ? (
        <MultilineInput
          value={input}
          cursorPosition={cursor}
          focused={true}
          minHeight={1}
          maxHeight={1}
          onPaste={createTextPasteHandler(
            input,
            cursor,
            ({ text, cursorPosition }) => {
              setInput(text)
              setCursor(cursorPosition)
              setSelected(0)
            },
          )}
          onChange={({ text, cursorPosition }) => {
            setInput(text)
            setCursor(cursorPosition)
            setSelected(0)
          }}
          onSubmit={submitInput}
          placeholder={
            mode === 'goto'
              ? document?.detail
                ? 'Line number or row <number>…'
                : 'Go to line…'
              : mode === 'find'
                ? 'Find exact text in output…'
                : 'Find exact text in loaded conversation…'
          }
          onKeyIntercept={(key) => {
            if (key.name === 'escape' || (key.ctrl && key.name === 'c')) {
              closeScope()
              return true
            }
            if (mode === 'browse' && key.name === 'up') {
              setSelected((value) => Math.max(0, value - 1))
              return true
            }
            if (mode === 'browse' && key.name === 'down') {
              setSelected((value) => Math.min(browseRows.length - 1, value + 1))
              return true
            }
            return false
          }}
        />
      ) : (
        <text fg={theme.muted} style={{ height: 1 }}>
          {mode === 'outline'
            ? 'Outline · ↑↓ select · Enter jump'
            : `${firstLine === undefined ? `Line ${top + 1}/${document?.lineCount ?? 0}` : `Source line ${top + firstLine} · captured ${firstLine}–${lastLine}`} · column ${horizontal + 1}${document?.kind === 'log' ? (following ? ' · Following' : ' · Frozen') : ''}`}
        </text>
      )}
      <box
        style={{
          flexDirection: showOutline ? 'row' : 'column',
          height: bodyHeight,
          gap: showOutline ? 1 : 0,
          flexShrink: 0,
          overflow: 'hidden',
        }}
      >
        <box
          style={{
            flexDirection: 'column',
            width: showOutline ? bodyWidth + lineNumberWidth : '100%',
            height: bodyHeight,
          }}
        >
          {mode === 'browse' || mode === 'outline'
            ? list
                .slice(listStart, listStart + bodyHeight)
                .map((row, index) => (
                  <text
                    key={row.id}
                    fg={
                      listStart + index === selected
                        ? theme.foreground
                        : theme.muted
                    }
                    bg={
                      listStart + index === selected
                        ? theme.surfaceHover
                        : undefined
                    }
                    style={{ height: 1 }}
                  >
                    {sliceTextCells(
                      `${listStart + index === selected ? '› ' : '  '}${row.title}`,
                      0,
                      terminalWidth - 2,
                    )}
                  </text>
                ))
            : visibleRows.map((row, index) => (
                <text
                  key={`${document?.id}:${row.location.line}:${row.location.character}`}
                  style={{ height: 1 }}
                >
                  <span fg={theme.muted}>
                    {(index > 0 &&
                    visibleRows[index - 1].location.line === row.location.line
                      ? ''
                      : `${document ? displayLine(document, row.location.line) : row.location.line + 1}`
                    ).padStart(lineNumberWidth - 2)}
                    {index === 0 ? '› ' : '  '}
                  </span>
                  <ReaderLine
                    text={row.text}
                    kind={document?.kind}
                    heading={document?.landmarks.some(
                      (item) => item.line === row.location.line,
                    )}
                  />
                </text>
              ))}
          {mode === 'browse' && list.length === 0 && (
            <text fg={theme.muted}>
              {searching
                ? 'Searching captured output…'
                : input
                  ? 'No matches in loaded messages'
                  : 'No output captured yet'}
            </text>
          )}
          {mode === 'outline' && list.length === 0 && (
            <text fg={theme.muted}>
              No headings in this output · use Find or Go to line
            </text>
          )}
        </box>
        {showOutline && (
          <box
            style={{
              flexDirection: 'column',
              width: outlineWidth,
              height: bodyHeight,
            }}
          >
            <text fg={theme.primary}>Outline</text>
            {landmarks
              .slice(outlineStart, outlineStart + bodyHeight - 1)
              .map((item, index) => (
                <Button
                  key={item.id}
                  onClick={() => {
                    setLocation({ line: item.line, character: 0 })
                    setFollowing(false)
                  }}
                >
                  <text
                    fg={
                      outlineStart + index === currentLandmark
                        ? theme.foreground
                        : theme.muted
                    }
                    wrapMode="none"
                  >
                    {sliceTextCells(
                      `${outlineStart + index === currentLandmark ? '›' : ' '} ${' '.repeat(Math.min(3, item.level - 1))}${item.label}`,
                      0,
                      outlineWidth,
                    )}
                  </text>
                </Button>
              ))}
          </box>
        )}
      </box>
      <ShortcutLine
        width={terminalWidth - 2}
        text={
          notice ||
          (searching
            ? 'Searching…'
            : mode === 'browse'
              ? '↑↓ Select · Enter Inspect · Esc Conversation'
              : '↑↓ Scroll · PgUp/PgDn Page · ←→ Columns')
        }
      />
      <ShortcutLine
        width={terminalWidth - 2}
        text={
          mode === 'browse'
            ? 'Search loaded content · at most 200 matching outputs'
            : '/ Find · C Copy · E Export · B Browse · ? Keys'
        }
      />
      <ShortcutLine
        width={terminalWidth - 2}
        text={[
          !inputOwnsKeys
            ? `G Line · W Wrap · V ${rawView ? 'Readable' : 'Raw'}`
            : '',
          document?.detail ? 'Enter Open value' : 'O Outline',
          entry?.recover
            ? recovering
              ? 'Loading artifact…'
              : 'L Load artifact'
            : '',
          originEntry?.messageId && onReturnToMessage ? 'T Conversation' : '',
        ]
          .filter(Boolean)
          .join(' · ')}
      />
    </box>
  )
}
