import { useCallback, useEffect, useRef, useState } from 'react'

import { getCurrentChatId } from '../project-files'
import { flushAnalytics } from '../utils/analytics'
import { withTimeout } from '../utils/terminal-color-detection'
import { cancelAllBashCommands } from '../utils/bash-command-controller'

import type { InputValue } from '../types/store'

// Timeout for analytics flush during exit - don't block exit for too long
const EXIT_FLUSH_TIMEOUT_MS = 1000

interface UseExitHandlerOptions {
  inputValue: string
  setInputValue: (value: InputValue) => void
}

let exitHandlerRegistered = false
// Guards against a double-exit race: if handleCtrlC triggers exitCli() (which
// awaits an analytics flush with a 1s timeout) and a second SIGINT arrives
// before process.exit(0) fires, the SIGINT handler would call exitCli() again,
// starting a second concurrent flush+exit cycle. This flag makes exitCli()
// idempotent.
let exiting = false

// Registered by the chat host (chat.tsx): drains the guarded-submit queue
// into persisted history before exitCli tears the process down. The /exit
// command drains inline; the Ctrl-C/SIGINT path exits here, where the queue
// is otherwise unreachable — without this, prompts queued during an active
// stream are dropped on that path too (reliability finding
// exit-handler-drops-queued-prompts).
let queuedPromptDrain: (() => void) | undefined
export function setQueuedPromptDrain(
  drain: (() => void) | undefined,
): void {
  queuedPromptDrain = drain
}

// Registered by the chat host (chat.tsx): returns the active stream's abort
// signal so an abort racing the analytics flush is bounded by withTimeout
// (reliability finding exit-flush-not-tied-to-timeout) instead of landing in
// an unobserved window between stopStreaming() and the flush's
// .finally(process.exit). withTimeout only honors aborts that fire while the
// window is open: the stream controller is typically already aborted by the
// time exitCli runs, and that pre-aborted signal never collapses the
// documented EXIT_FLUSH_TIMEOUT_MS flush bound (reliability finding
// exit-flush-window-collapsed-by-pre-aborted-signal).
let getExitStreamSignal: (() => AbortSignal | undefined) | undefined
export function setExitStreamSignal(
  getter: (() => AbortSignal | undefined) | undefined,
): void {
  getExitStreamSignal = getter
}

function setupExitMessageHandler() {
  if (exitHandlerRegistered) return
  exitHandlerRegistered = true

  process.on('exit', () => {
    try {
      const chatId = getCurrentChatId()
      if (chatId) {
        // This runs synchronously during the exit phase
        // OpenTUI has already cleaned up by this point
        const cliName = 'openbuff'
        process.stdout.write(
          `\nTo continue this session later, run:\n${cliName} --continue ${chatId}\n`,
        )
      }
    } catch {
      // Silent fail - don't block exit
    }
  })
}

function exitCli(): void {
  if (exiting) {
    return
  }
  exiting = true
  // Persist queued prompts before teardown (the same drain the /exit command
  // runs); a drain failure must never block the exit.
  try {
    queuedPromptDrain?.()
  } catch {
    // Ignore — exit proceeds.
  }
  withTimeout(
    flushAnalytics(),
    EXIT_FLUSH_TIMEOUT_MS,
    undefined,
    getExitStreamSignal?.(),
  ).finally(() => {
    process.exit(0)
  })
}

export const useExitHandler = ({
  inputValue,
  setInputValue,
}: UseExitHandlerOptions) => {
  const [nextCtrlCWillExit, setNextCtrlCWillExit] = useState(false)
  const exitWarningTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  )

  useEffect(() => {
    setupExitMessageHandler()
  }, [])

  const handleCtrlC = useCallback(() => {
    if (!inputValue && cancelAllBashCommands() > 0) {
      return true
    }
    if (inputValue) {
      setInputValue({ text: '', cursorPosition: 0, lastEditDueToNav: false })
      return true
    }

    if (!nextCtrlCWillExit) {
      setNextCtrlCWillExit(true)
      setTimeout(() => {
        setNextCtrlCWillExit(false)
      }, 2000)
      return true
    }

    if (exitWarningTimeoutRef.current) {
      clearTimeout(exitWarningTimeoutRef.current)
      exitWarningTimeoutRef.current = null
    }

    exitCli()
    return true
  }, [inputValue, setInputValue, nextCtrlCWillExit])

  useEffect(() => {
    const handleSigint = () => {
      if (exitWarningTimeoutRef.current) {
        clearTimeout(exitWarningTimeoutRef.current)
        exitWarningTimeoutRef.current = null
      }

      exitCli()
    }

    process.on('SIGINT', handleSigint)
    return () => {
      process.off('SIGINT', handleSigint)
    }
  }, [])

  return { handleCtrlC, nextCtrlCWillExit }
}
