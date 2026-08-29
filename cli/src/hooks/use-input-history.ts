import { useRef, useCallback, useEffect } from 'react'

import {
  appendMessageHistory,
  getSessionHistoryRetry,
  getUnpersistedMessageHistory,
  historyRetryNowMs,
  loadSessionMessageHistory,
  recordSessionHistoryRetryAttempt,
  reloadMessageHistoryAfterAppend,
  resolveNavigationDraftText,
  retryUnavailableHistoryNavigation,
  setUnpersistedMessageHistory,
} from '../utils/message-history'

import type { InputValue } from '../types/store'
import type { InputMode } from '../utils/input-modes'
import type { MessageHistoryLoadOutcome } from '../utils/message-history'

/**
 * Determine the appropriate input mode and display text for a history item.
 * Bash commands are stored with '!' prefix, so we detect that and return
 * the appropriate mode and text to display.
 *
 * Exported so tests validate the hook's real implementation instead of a
 * duplicated mock copy that can silently drift.
 */
export function parseHistoryItem(item: string): {
  mode: InputMode
  displayText: string
} {
  if (item.startsWith('!') && item.length > 1) {
    // It's a bash command - strip the '!' prefix for display
    return { mode: 'bash', displayText: item.slice(1) }
  }
  // Regular prompt
  return { mode: 'default', displayText: item }
}

/**
 * The navigation state a keypress must adopt before it reads history, plus
 * whether the caller has to put its saved draft back into the input.
 */
export type RetriedNavigationState = {
  history: string[]
  index: number
  unavailable: boolean
  restoreDraft: boolean
}

/**
 * Retry a previously unavailable history load for one navigation keypress.
 *
 * `load` is not called at all when the last load was trustworthy or the retry
 * budget refuses the attempt, and the state is returned unchanged — that is what
 * keeps a contended history from paying a blocking lock acquisition per
 * keypress. `restoreDraft` is set when the reload ended navigation, so the input
 * does not keep showing a history entry the cursor can no longer reach.
 *
 * The budget is read from and folded back into message-history's process-wide
 * session store through recordSessionHistoryRetryAttempt, its single writer, so
 * every blocking lock acquisition a retry pays — here or in the Ctrl+R overlay —
 * comes out of one bounded per-process allowance.
 *
 * Exported so tests exercise the hook's real retry/apply step instead of a
 * mirrored copy (rendering the hook is unreliable under React 19 + Bun).
 */
export function applyRetriedNavigation(state: {
  history: string[]
  index: number
  unavailable: boolean
  nowMs: number
  load: () => MessageHistoryLoadOutcome
}): RetriedNavigationState {
  const { history, index, unavailable, nowMs, load } = state
  const unchanged = { history, index, unavailable, restoreDraft: false }
  if (!unavailable) return unchanged
  const retried = retryUnavailableHistoryNavigation({
    history,
    index,
    retry: getSessionHistoryRetry(),
    nowMs,
    load,
  })
  if (!retried) return unchanged
  // Fold the outcome into the shared budget instead of persisting
  // `retried.retry`, which was computed from the snapshot taken before `load()`:
  // one writer means a load that records an attempt itself is never clobbered.
  recordSessionHistoryRetryAttempt(nowMs, retried.unavailable)
  return {
    history: retried.history,
    index: retried.index,
    unavailable: retried.unavailable,
    restoreDraft: retried.restoreDraft,
  }
}

export const useInputHistory = (
  inputValue: string,
  setInputValue: (value: InputValue) => void,
  options?: {
    inputMode?: InputMode
    setInputMode?: (mode: InputMode) => void
  },
) => {
  const { inputMode, setInputMode } = options ?? {}
  const messageHistoryRef = useRef<string[]>([])
  const historyIndexRef = useRef<number>(-1)
  const currentDraftRef = useRef<string>('')
  const currentDraftModeRef = useRef<InputMode>('default')
  const isInitializedRef = useRef<boolean>(false)
  const isNavigatingRef = useRef<boolean>(false)
  // Set when the last load could not read the persisted history: an unavailable
  // history is not an empty one, so navigation retries it rather than leaving
  // the session history-less. The retry budget for those attempts and this
  // session's memory-only prompts live in message-history's process-wide store,
  // shared with the Ctrl+R overlay.
  const isHistoryUnavailableRef = useRef<boolean>(false)

  // Record the outcome of a load/reload attempt: a successful one clears the
  // unavailable flag and refunds the shared retry budget, a failed one spends
  // it. historyRetryNowMs is monotonic, so a backwards clock adjustment cannot
  // strand the session on an unavailable history.
  const recordHistoryAttempt = useCallback((unavailable: boolean) => {
    isHistoryUnavailableRef.current = unavailable
    recordSessionHistoryRetryAttempt(historyRetryNowMs(), unavailable)
  }, [])

  // Read the persisted history and resolve the view to keep, without touching
  // navigation or retry state. It is the same shared session load the Ctrl+R
  // overlay performs, so a degraded read never shrinks either view; it never
  // throws and uses the short interactive lock budget.
  const readHistory = useCallback(
    (): MessageHistoryLoadOutcome =>
      loadSessionMessageHistory(messageHistoryRef.current),
    [],
  )

  const loadHistory = useCallback(() => {
    const { history, unavailable } = readHistory()
    messageHistoryRef.current = history
    recordHistoryAttempt(unavailable)
  }, [readHistory, recordHistoryAttempt])

  const resetHistoryNavigation = useCallback(() => {
    historyIndexRef.current = -1
    currentDraftRef.current = ''
    currentDraftModeRef.current = 'default'
  }, [])

  // Put the draft saved at the start of a navigation sequence back into the
  // input, in the mode it was typed in. Used when a mid-sequence reload ends
  // navigation: the input would otherwise keep showing a history entry the
  // cursor can no longer reach, leaving the draft unrecoverable.
  const restoreDraft = useCallback(() => {
    const draft = currentDraftRef.current
    const draftMode = currentDraftModeRef.current
    resetHistoryNavigation()
    if (setInputMode && draftMode !== inputMode) {
      setInputMode(draftMode)
    }
    // A bash-mode draft is stored with its '!' prefix, which is not displayed.
    const textToShow = resolveNavigationDraftText(draft, draftMode === 'bash')
    setInputValue({
      text: textToShow,
      cursorPosition: textToShow.length,
      lastEditDueToNav: true,
    })
  }, [inputMode, setInputMode, setInputValue, resetHistoryNavigation])

  // Retry a previously unavailable load before treating history as empty.
  // applyRetriedNavigation owns the whole rule set — cooldown/attempt budget,
  // re-anchoring the cursor onto the reloaded list, and reporting an ended
  // navigation — so this stays a state assignment.
  const retryHistoryIfUnavailable = useCallback(() => {
    const applied = applyRetriedNavigation({
      history: messageHistoryRef.current,
      index: historyIndexRef.current,
      unavailable: isHistoryUnavailableRef.current,
      nowMs: historyRetryNowMs(),
      load: readHistory,
    })
    messageHistoryRef.current = applied.history
    isHistoryUnavailableRef.current = applied.unavailable
    historyIndexRef.current = applied.index
    // Navigation ended (the trustworthy reload is empty): the input still shows
    // a history entry, so the draft has to come back or it is unreachable.
    if (applied.restoreDraft) restoreDraft()
  }, [readHistory, restoreDraft])

  // Load history from disk on mount
  useEffect(() => {
    if (!isInitializedRef.current) {
      isInitializedRef.current = true
      loadHistory()
    }
  }, [loadHistory])

  useEffect(() => {
    if (!isNavigatingRef.current) {
      resetHistoryNavigation()
    }
  }, [inputMode, resetHistoryNavigation])

  const saveToHistory = useCallback(
    (message: string) => {
      // Re-read from disk to pick up messages from other terminals. The append
      // reports whether it actually persisted: a failed append paired with a
      // successful reload would otherwise drop the prompt from up/down
      // navigation, since the reloaded disk state never contained it.
      const appendPersisted = appendMessageHistory(message)
      // An unavailable re-read is resolved by the same shared rule the Ctrl+R
      // overlay's degraded read uses (resolveDegradedMessageHistory over this
      // session's last good history plus the new entry), so a single busy lock
      // can neither wipe up/down navigation nor leave the two views disagreeing
      // about what a degraded read means.
      let unavailable = false
      const folded = reloadMessageHistoryAfterAppend({
        lastGood: messageHistoryRef.current,
        appended: message,
        onUnavailable: () => {
          unavailable = true
        },
        appendPersisted,
        unpersisted: getUnpersistedMessageHistory(),
      })
      messageHistoryRef.current = folded.history
      setUnpersistedMessageHistory(folded.unpersisted)
      recordHistoryAttempt(unavailable)
      historyIndexRef.current = -1
      currentDraftRef.current = ''
      currentDraftModeRef.current = 'default'
    },
    [recordHistoryAttempt],
  )

  const navigateUp = useCallback(() => {
    retryHistoryIfUnavailable()
    const history = messageHistoryRef.current
    if (history.length === 0) return

    isNavigatingRef.current = true

    if (historyIndexRef.current === -1) {
      // Save current draft and mode before navigating
      currentDraftRef.current =
        inputMode === 'bash' ? '!' + inputValue : inputValue
      currentDraftModeRef.current = inputMode ?? 'default'
      historyIndexRef.current = history.length - 1
    } else if (historyIndexRef.current > 0) {
      historyIndexRef.current -= 1
    }

    const historyMessage = history[historyIndexRef.current]
    if (historyMessage === undefined) {
      isNavigatingRef.current = false
      return
    }

    const { mode, displayText } = parseHistoryItem(historyMessage)

    // Switch mode if needed
    if (setInputMode && mode !== inputMode) {
      setInputMode(mode)
    }

    setInputValue({
      text: displayText,
      cursorPosition: displayText.length,
      lastEditDueToNav: true,
    })

    setTimeout(() => {
      isNavigatingRef.current = false
    }, 0)
  }, [
    inputValue,
    inputMode,
    setInputValue,
    setInputMode,
    retryHistoryIfUnavailable,
  ])

  const navigateDown = useCallback(() => {
    retryHistoryIfUnavailable()
    const history = messageHistoryRef.current
    if (history.length === 0) return
    if (historyIndexRef.current === -1) return

    isNavigatingRef.current = true

    if (historyIndexRef.current < history.length - 1) {
      historyIndexRef.current += 1
      const historyMessage = history[historyIndexRef.current]
      if (historyMessage === undefined) {
        isNavigatingRef.current = false
        return
      }

      const { mode, displayText } = parseHistoryItem(historyMessage)

      // Switch mode if needed
      if (setInputMode && mode !== inputMode) {
        setInputMode(mode)
      }

      setInputValue({
        text: displayText,
        cursorPosition: displayText.length,
        lastEditDueToNav: true,
      })
    } else {
      // Return to draft
      historyIndexRef.current = -1
      const draft = currentDraftRef.current
      const draftMode = currentDraftModeRef.current

      // Restore the mode we were in when we started navigating
      if (setInputMode && draftMode !== inputMode) {
        setInputMode(draftMode)
      }

      // If draft was in bash mode, it was stored with '!' prefix, so strip it
      const textToShow = resolveNavigationDraftText(draft, draftMode === 'bash')

      setInputValue({
        text: textToShow,
        cursorPosition: textToShow.length,
        lastEditDueToNav: true,
      })
    }

    setTimeout(() => {
      isNavigatingRef.current = false
    }, 0)
  }, [inputMode, setInputValue, setInputMode, retryHistoryIfUnavailable])

  return { saveToHistory, navigateUp, navigateDown, resetHistoryNavigation }
}
