/**
 * PromptHistorySearchScreen - Full-screen fuzzy search over past user prompts
 * (Ctrl+R or `/prompts`).
 *
 * - History is read from a mount effect via `loadSessionMessageHistory()`, so
 *   rendering stays pure. `PromptHistoryLoadState` keeps a not-yet-read or
 *   unreadable history from being reported as a genuinely empty one.
 * - An 'unavailable' read is retried while the overlay stays open, on the
 *   process-wide retry budget in message-history: a transient busy lock
 *   recovers without a reopen, and a persistently unreadable history costs a
 *   bounded number of blocking lock acquisitions per process.
 * - A reload can grow or shift the list, so the focus cursor follows the prompt
 *   the user focused (`reanchorFocusForReload`) instead of being clamped onto a
 *   different prompt that Enter would then select.
 * - Empty query shows the most recent ~200 prompts; typing fuzzy-filters them
 *   (`fuzzyMatch`). Enter selects, Escape / Ctrl-C closes.
 *
 * Note: Ctrl+R is the standard reverse-i-search binding in shells. Openbuff runs
 * in its own TUI, so the binding is safe to repurpose here.
 */

import { TextAttributes } from '@opentui/core'
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { MultilineInput } from './multiline-input'
import { SelectableList } from './selectable-list'
import { useTerminalLayout } from '../hooks/use-terminal-layout'
import { useTheme } from '../hooks/use-theme'
import {
  MESSAGE_HISTORY_RETRY_COOLDOWN_MS,
  getSessionHistoryRetry,
  historyRetryNowMs,
  loadSessionMessageHistory,
  reconcileHistoryIndex,
  recordSessionHistoryRetryAttempt,
  shouldRetryUnavailableHistory,
} from '../utils/message-history'
import { createTextPasteHandler } from '../utils/strings'
import { isPlainEnterKey } from '../utils/terminal-enter-detection'
import { hashString } from '../utils/hash'
import { fuzzyMatch } from '../utils/fuzzy-match'

import type { SelectableListItem } from './selectable-list'
import type { InputValue } from '../types/store'
import type { MessageHistoryLoadOutcome } from '../utils/message-history'

const LAYOUT = {
  CONTENT_PADDING: 4,
  MAX_CONTENT_WIDTH: 100,
  PREFERRED_CONTENT_WIDTH: 80,
  INPUT_HEIGHT: 1,
  HEADER_HEIGHT: 1,
  MAX_LIST_HEIGHT: 20,
  /** Cap on total items rendered for performance. */
  MAX_RENDERED_ITEMS: 200,
} as const

interface PromptHistorySearchScreenProps {
  /** Called when the user closes the overlay without selecting. */
  onClose: () => void
  /** Called when the user selects a prompt; receives the prompt text. */
  onSelectPrompt: (text: string) => void
}

/**
 * Pure helper that filters and scores prompts against a query.
 * - Empty query returns the prompts as-is, capped at `limit` (most-recent-first
 *   is expected from the caller).
 * - Non-empty query runs `fuzzyMatch` (subsequence scoring) on each prompt,
 *   keeps matches, sorts by score ascending (best/best-scored first, matching
 *   the command-palette-screen convention where lower fuzzyMatch scores are
 *   better), and caps at `limit`.
 *
 * Exported so tests can exercise the scoring logic without rendering React.
 */
export function filterAndScorePrompts(
  prompts: string[],
  query: string,
  limit: number,
): string[] {
  const trimmed = query.trim()
  if (!trimmed) {
    return prompts.slice(0, limit)
  }

  const scored: { prompt: string; score: number }[] = []
  for (const prompt of prompts) {
    const result = fuzzyMatch(prompt, trimmed)
    if (result) {
      scored.push({ prompt, score: result.score })
    }
  }
  // Lower fuzzyMatch score = better match; sort ascending so best matches first.
  scored.sort((a, b) => a.score - b.score)
  return scored.slice(0, limit).map((s) => s.prompt)
}

/**
 * Load lifecycle of the prompt history this screen searches. The history is read
 * from an effect, so 'loading' is a state the results list genuinely renders in
 * and must be modelled explicitly: collapsing it into 'loaded' reported a
 * not-yet-read history as a genuinely empty one.
 */
export type PromptHistoryLoadState = 'loading' | 'loaded' | 'unavailable'

/**
 * Empty-results message for a history that could not be read. Exported so the
 * tests assert against this exact string instead of a copy that can go stale.
 */
export const HISTORY_UNAVAILABLE_MESSAGE =
  'History unavailable — locked by another Openbuff process or unreadable'

/**
 * Pure helper for the results list's empty message. Neither a history that has
 * not been read yet nor an unavailable one — a "busy" lock held by another
 * Openbuff process, or persisted history that could not be read — may be
 * reported as genuinely empty history, and both outrank the no-matches message
 * because nothing was ever searched.
 *
 * Exported so tests can exercise the message choice without rendering React.
 */
export function getEmptyResultsMessage(
  query: string,
  loadState: PromptHistoryLoadState,
): string {
  if (loadState === 'loading') return 'Loading prompt history...'
  if (loadState === 'unavailable') return HISTORY_UNAVAILABLE_MESSAGE
  const trimmed = query.trim()
  return trimmed ? `No prompts matching "${trimmed}"` : 'No prompt history yet'
}

/**
 * The screen state one history read — a mount load or a retry of an unavailable
 * one — resolves to. The retry budget spent is not part of it: that lives in the
 * process-wide store every consumer shares, instead of being handed back to one
 * component instance.
 */
export type RetriedPromptHistory = {
  prompts: string[]
  loadState: PromptHistoryLoadState
}

/**
 * Pure mapping of one history read onto the state this screen renders:
 * most-recent-first prompts plus the load state the results list reports.
 *
 * `loadSessionMessageHistory()` returns most-recent-last, so the list is
 * reversed here rather than at render time. A copy is reversed because the
 * loaded array is the caller's, and an unavailable read is reported as such
 * instead of being collapsed into a genuinely-empty 'loaded'.
 *
 * Exported so tests can exercise the mount effect's mapping without rendering
 * React (renderHook/render is unreliable under React 19 + Bun here).
 */
export function deriveLoadedPrompts(
  history: string[],
  unavailable: boolean,
): RetriedPromptHistory {
  return {
    prompts: [...history].reverse(),
    loadState: unavailable ? 'unavailable' : 'loaded',
  }
}

/**
 * Read the history this overlay searches, through the shared session load.
 *
 * `displayedPrompts` is the list currently on screen (most-recent-first);
 * loadSessionMessageHistory works in persisted (most-recent-last) order, so it
 * is reversed on the way in. Going through the shared load is what keeps this
 * screen consistent with up/down navigation: a still-degraded read may only
 * grow the view it is given, and this session's memory-only prompts (appends
 * that never reached disk) are folded in for both consumers instead of only for
 * the navigation hook.
 *
 * Exported so tests exercise the real read without rendering React
 * (render/renderHook is unreliable under React 19 + Bun here).
 */
export function readPromptHistoryForDisplay(
  displayedPrompts: string[],
): MessageHistoryLoadOutcome {
  return loadSessionMessageHistory([...displayedPrompts].reverse())
}

/**
 * Retry a previously unavailable history read while the overlay is open.
 *
 * Without this the mount-only read left the screen pinned to
 * HISTORY_UNAVAILABLE_MESSAGE for as long as the overlay stayed open, even
 * though the busy lock that caused it is typically held for milliseconds by
 * another Openbuff process. The rules are the ones use-input-history already
 * applies, so both consumers of the same load recover identically:
 *
 * - `load` is not called at all unless the last read was unavailable *and* the
 *   process-wide retry budget allows another attempt (cooldown, attempt cap,
 *   idle refund), so a persistently unreadable history pays a bounded number of
 *   blocking lock acquisitions rather than one per poll.
 * - That budget is read from and spent in message-history's session store, not
 *   passed in and returned: a budget owned by this component bounded only one
 *   mount, so navigation, each reopen of the overlay and every remount could
 *   each pay MESSAGE_HISTORY_MAX_RETRY_ATTEMPTS blocking acquisitions of their
 *   own. Sharing one budget is what makes the documented bound hold, and a
 *   trustworthy read here clears it for the navigation hook too.
 * - `load` is the shared session read (readPromptHistoryForDisplay), which
 *   already resolves a still-degraded read against the view the screen holds —
 *   so a partial read can never drop prompts already on screen — and folds in
 *   this session's memory-only prompts.
 *
 * `nowMs` must come from historyRetryNowMs. Returns undefined when no retry is
 * due: nothing was read and no state changes.
 *
 * Exported so tests exercise the real recovery step without rendering React
 * (render/renderHook is unreliable under React 19 + Bun here).
 */
export function retryUnavailablePromptHistory(params: {
  loadState: PromptHistoryLoadState
  nowMs: number
  load: () => MessageHistoryLoadOutcome
}): RetriedPromptHistory | undefined {
  const { loadState, nowMs, load } = params
  if (loadState !== 'unavailable') return undefined
  if (!shouldRetryUnavailableHistory(getSessionHistoryRetry(), nowMs))
    return undefined
  const loaded = load()
  recordSessionHistoryRetryAttempt(nowMs, loaded.unavailable)
  return deriveLoadedPrompts(loaded.history, loaded.unavailable)
}

/**
 * Re-anchor the results list's focus cursor onto a list a background reload
 * replaced.
 *
 * The retry above can grow or shift the prompt list while the user is looking
 * at it (a busy lock cleared and the full history came back, or another
 * terminal appended prompts). A stationary numeric cursor then points at a
 * different prompt than the one the user focused, and Enter selects that other
 * prompt — clamping only keeps the index in range, it does not keep it on the
 * same entry. So the entry itself wins when it still exists, exactly as
 * up/down navigation does.
 *
 * `reconcileHistoryIndex` is the shared implementation of that rule, but it
 * works in persisted (most-recent-last) order — its lastIndexOf tie-break
 * picks the *newest* occurrence of a verbatim repeat — while this screen lists
 * most-recent-first. Both lists and the cursor are therefore mapped into that
 * order and back instead of duplicating the rule here.
 *
 * Unlike navigation there is no draft to return to: an empty reload or a
 * vanished prompt focuses the newest entry / clamps into range rather than
 * leaving the cursor unusable at -1.
 *
 * Exported so tests can exercise the re-anchoring without rendering React
 * (render/renderHook is unreliable under React 19 + Bun here).
 */
export function reanchorFocusedPrompt(params: {
  focusedIndex: number
  displayedPrompts: string[]
  reloadedPrompts: string[]
}): number {
  const { focusedIndex, displayedPrompts, reloadedPrompts } = params
  const toPersisted = (index: number, length: number): number =>
    length - 1 - index
  // Re-anchor from the cursor the list actually rendered: the raw state can sit
  // past the end after the query shrank the list, and mapping that into
  // persisted order would produce a negative index and drop the anchor.
  const rendered = Math.min(
    Math.max(focusedIndex, 0),
    Math.max(0, displayedPrompts.length - 1),
  )
  // The empty lists need no guards of their own: an empty displayed list maps to
  // toPersisted(0, 0) === -1, and an empty reload makes reconcileHistoryIndex
  // return -1 by itself, so both fall through the trailing branch and focus the
  // newest entry.
  const reconciled = reconcileHistoryIndex(
    toPersisted(rendered, displayedPrompts.length),
    [...displayedPrompts].reverse(),
    [...reloadedPrompts].reverse(),
  )
  return reconciled === -1 ? 0 : toPersisted(reconciled, reloadedPrompts.length)
}

/**
 * Focus cursor a reload must adopt, derived from the raw prompt lists and the
 * query that is live *now*.
 *
 * The overlay renders `filterAndScorePrompts(allPrompts, searchQuery)` and the
 * focus cursor addresses that filtered list, so re-anchoring needs the exact
 * filtered list the cursor was pointing into. Mirroring the rendered list into
 * a ref from a post-render effect made that mirror lag: a retry tick that fired
 * before the effect flushed re-anchored against a stale query/result list and
 * could move the highlight onto an unrelated prompt. Deriving both lists here,
 * from the raw prompts and the synchronously published query, removes the
 * second copy entirely — the same inputs the render uses produce the same
 * filtered lists whenever the retry lands.
 *
 * Exported so tests can exercise the derivation without rendering React
 * (render/renderHook is unreliable under React 19 + Bun here).
 */
export function reanchorFocusForReload(params: {
  focusedIndex: number
  query: string
  displayedAllPrompts: string[]
  reloadedAllPrompts: string[]
  limit: number
}): number {
  const {
    focusedIndex,
    query,
    displayedAllPrompts,
    reloadedAllPrompts,
    limit,
  } = params
  return reanchorFocusedPrompt({
    focusedIndex,
    displayedPrompts: filterAndScorePrompts(displayedAllPrompts, query, limit),
    reloadedPrompts: filterAndScorePrompts(reloadedAllPrompts, query, limit),
  })
}

export const PromptHistorySearchScreen: React.FC<
  PromptHistorySearchScreenProps
> = ({ onClose, onSelectPrompt }) => {
  const theme = useTheme()
  const { terminalWidth, terminalHeight } = useTerminalLayout()

  const [searchQuery, setSearchQuery] = useState('')
  const [searchCursor, setSearchCursor] = useState(0)
  const [focusedIndex, setFocusedIndex] = useState(0)
  const [allPrompts, setAllPrompts] = useState<string[]>([])
  const [loadState, setLoadState] = useState<PromptHistoryLoadState>('loading')
  // Mirrors allPrompts for the retry poll below, which runs from a timer and
  // must not re-subscribe (and restart its cooldown) on every state change.
  const promptsRef = useRef<string[]>([])
  // Mirrors searchQuery, written in the query change handler together with
  // setSearchQuery so a retry tick landing between a keystroke and the next
  // render re-anchors against the query the user actually typed. The rendered
  // result list is derived from these two, never mirrored separately.
  const searchQueryRef = useRef<string>('')
  // Mirrors focusedIndex so the next cursor is computed exactly once per reload:
  // reanchorFocusForReload is not idempotent (it follows the focused prompt to
  // its new position), and React may invoke a state updater twice.
  const focusedIndexRef = useRef<number>(0)

  // Every focus change goes through here, so the ref stays the authoritative
  // pre-reload cursor the re-anchoring in applyLoad reads.
  const publishFocusedIndex = useCallback((next: number) => {
    focusedIndexRef.current = next
    setFocusedIndex(next)
  }, [])

  const applyLoad = useCallback(
    (next: RetriedPromptHistory) => {
      // Keep the cursor on the prompt the user focused: this load may have
      // grown or shifted the list, and Enter selects whatever the cursor points
      // at. Both filtered lists are derived from the live query here, because
      // the focus index addresses the filtered list, not the raw history.
      // Computed exactly once, before promptsRef is advanced, so a re-run of
      // this callback (or a double-invoked state updater) re-anchors between two
      // identical lists and leaves the highlight where it is.
      publishFocusedIndex(
        reanchorFocusForReload({
          focusedIndex: focusedIndexRef.current,
          query: searchQueryRef.current,
          displayedAllPrompts: promptsRef.current,
          reloadedAllPrompts: next.prompts,
          limit: LAYOUT.MAX_RENDERED_ITEMS,
        }),
      )
      promptsRef.current = next.prompts
      setAllPrompts(next.prompts)
      setLoadState(next.loadState)
    },
    [publishFocusedIndex],
  )

  // The shared session read never throws, uses the short interactive lock budget
  // and degrades to whatever could be read, so neither the mount pass nor a
  // retry tick can throw or stall the event loop; every form of unavailability
  // (busy lock, unreadable snapshot, failed journal read) is reported back.
  const readPromptHistory = useCallback(
    (): MessageHistoryLoadOutcome =>
      readPromptHistoryForDisplay(promptsRef.current),
    [],
  )

  // Load the full prompt history on mount, from an effect instead of the render
  // body so rendering stays pure (no synchronous disk I/O mid-render). Until
  // this effect runs the state stays 'loading', so the first render does not
  // claim the history is empty. The mapping itself lives in deriveLoadedPrompts
  // so it is testable without rendering.
  useEffect(() => {
    const loaded = readPromptHistory()
    recordSessionHistoryRetryAttempt(historyRetryNowMs(), loaded.unavailable)
    applyLoad(deriveLoadedPrompts(loaded.history, loaded.unavailable))
  }, [readPromptHistory, applyLoad])

  // Recover from an unavailable load while the overlay stays open: a busy lock
  // held by another Openbuff process is usually transient.
  // retryUnavailablePromptHistory owns the rule set, so this stays a state
  // assignment, and the timer exists only while the history is unavailable.
  // Ticks past the spent attempt cap are cheap (one predicate, no I/O) and are
  // what pick the retry back up once the idle refund applies.
  useEffect(() => {
    if (loadState !== 'unavailable') return
    const timer = setInterval(() => {
      const retried = retryUnavailablePromptHistory({
        // The live load state from this effect's closure, not a hardcoded
        // 'unavailable': the guard inside the retry stays the one authority on
        // whether a read is due, in production as well as in tests.
        loadState,
        nowMs: historyRetryNowMs(),
        load: readPromptHistory,
      })
      if (!retried) return
      applyLoad(retried)
    }, MESSAGE_HISTORY_RETRY_COOLDOWN_MS)
    return () => clearInterval(timer)
  }, [loadState, readPromptHistory, applyLoad])

  const filteredPrompts = useMemo(
    () =>
      filterAndScorePrompts(allPrompts, searchQuery, LAYOUT.MAX_RENDERED_ITEMS),
    [allPrompts, searchQuery],
  )

  const items = useMemo<SelectableListItem[]>(() => {
    const seen = new Map<string, number>()
    return filteredPrompts.map((prompt) => {
      const h = hashString(prompt)
      const n = seen.get(h) ?? 0
      seen.set(h, n + 1)
      // Content hash, not positional index: filterAndScorePrompts reorders by
      // score, so a `prompt:${index}` key + findIndex lookup was fragile and
      // O(n). The hash keeps React keys stable across reorder while the dedup
      // suffix keeps duplicate prompts unique without embedding unbounded text.
      const id = n === 0 ? `prompt:${h}` : `prompt:${h}-${n}`
      return { id, label: prompt.replace(/\n/g, ' '), icon: '▸' }
    })
  }, [filteredPrompts])

  // Clamp focused index when the filtered list shrinks
  const clampedFocusedIndex = Math.min(
    focusedIndex,
    Math.max(0, items.length - 1),
  )

  // Publish the query synchronously with its state update so the retry poll's
  // re-anchoring can never see a query the user has already replaced.
  const handleQueryChange = useCallback(
    ({ text, cursorPosition }: InputValue) => {
      searchQueryRef.current = text
      setSearchQuery(text)
      setSearchCursor(cursorPosition)
      publishFocusedIndex(0)
    },
    [publishFocusedIndex],
  )

  const handleSelect = useCallback(
    (item: SelectableListItem, index: number) => {
      const prompt = filteredPrompts[index]
      if (!prompt) return
      // Close the overlay BEFORE updating the input so the keyboard hook does
      // not re-interpret the keypress while the overlay is unmounting.
      onClose()
      onSelectPrompt(prompt)
    },
    [filteredPrompts, onClose, onSelectPrompt],
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
      if (key.name === 'escape') {
        onClose()
        return true
      }
      if (key.name === 'up') {
        publishFocusedIndex(Math.max(0, focusedIndexRef.current - 1))
        return true
      }
      if (key.name === 'down') {
        // Math.max like the up branch: an empty results list (unavailable or
        // no-match) would otherwise publish an invalid -1 cursor.
        publishFocusedIndex(
          Math.max(0, Math.min(items.length - 1, focusedIndexRef.current + 1)),
        )
        return true
      }
      if (isPlainEnterKey(key)) {
        const focused = items[clampedFocusedIndex]
        if (focused) {
          handleSelect(focused, clampedFocusedIndex)
        }
        return true
      }
      if (key.name === 'c' && key.ctrl) {
        onClose()
        return true
      }
      // Let printable keys through to the input
      return false
    },
    [items, clampedFocusedIndex, handleSelect, onClose, publishFocusedIndex],
  )

  const contentMaxWidth = Math.min(
    terminalWidth - LAYOUT.CONTENT_PADDING,
    LAYOUT.MAX_CONTENT_WIDTH,
  )
  const contentWidth = Math.min(LAYOUT.PREFERRED_CONTENT_WIDTH, contentMaxWidth)
  const availableListHeight = Math.max(
    3,
    terminalHeight - LAYOUT.HEADER_HEIGHT - LAYOUT.INPUT_HEIGHT - 2,
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
        <box style={{ height: LAYOUT.HEADER_HEIGHT, flexShrink: 0 }}>
          <text
            style={{
              fg: theme.primary,
              attributes: TextAttributes.BOLD,
            }}
          >
            Prompt History Search
          </text>
          <text style={{ fg: theme.muted }}>
            {'  '}Type to fuzzy-search past prompts · Enter to use · Esc to
            close · Ctrl+R toggles
          </text>
        </box>

        {/* Search input */}
        <box style={{ flexShrink: 0, marginBottom: 0, marginTop: 0 }}>
          <MultilineInput
            value={searchQuery}
            onChange={handleQueryChange}
            onSubmit={() => {}}
            onPaste={createTextPasteHandler(
              searchQuery,
              Math.min(searchCursor, searchQuery.length),
              handleQueryChange,
            )}
            onKeyIntercept={handleKeyIntercept}
            placeholder="Search past prompts..."
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
            width: contentWidth,
            borderStyle: 'single',
            borderColor: theme.muted,
            flexGrow: 1,
            flexShrink: 1,
            overflow: 'hidden',
          }}
          border={['top', 'bottom', 'left', 'right']}
        >
          <SelectableList
            items={items}
            focusedIndex={clampedFocusedIndex}
            onFocusChange={publishFocusedIndex}
            onSelect={handleSelect}
            maxHeight={listHeight}
            emptyMessage={getEmptyResultsMessage(searchQuery, loadState)}
          />
        </box>
      </box>
    </box>
  )
}
