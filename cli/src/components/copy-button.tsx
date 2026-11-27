import React, { useEffect, useRef, useState } from 'react'

import { Button } from './button'
import { useTheme } from '../hooks/use-theme'
import { copyTextToClipboard } from '../utils/clipboard'

import type { ReactNode } from 'react'

// ============================================================================
// Exported constants and utilities for testing
// ============================================================================

/** Time in ms before the "copied" state resets */
export const COPIED_RESET_DELAY_MS = 2000

/** Icon shown in collapsed state */
export const COPY_ICON_COLLAPSED = '⎘'
/** Text shown when hovering */
export const COPY_ICON_EXPANDED = '[⎘ copy]'
/** Text shown after copying */
export const COPY_ICON_COPIED = '[✔ copied]'

/**
 * Get the text to display for the copy icon based on state.
 * Exported for testing.
 */
export const getCopyIconText = (
  isCopied: boolean,
  isHovered: boolean,
  leadingSpace: boolean,
): string => {
  const space = leadingSpace ? ' ' : ''
  if (isCopied) return `${space}${COPY_ICON_COPIED}`
  if (isHovered) return `${space}${COPY_ICON_EXPANDED}`
  return `${space}${COPY_ICON_COLLAPSED}`
}

/**
 * State transition handlers for the copy button.
 * Exported for testing - these are the pure logic functions
 * that determine how state changes in response to user actions.
 */
export const copyButtonHandlers = {
  /** Handle mouse entering the button */
  handleMouseOver: (isCopied: boolean): boolean => {
    // Don't show hover state while showing "copied" feedback
    return !isCopied
  },

  /** Handle mouse leaving the button - always clears hover */
  handleMouseOut: (): boolean => {
    return false
  },

  /** Handle copy action - returns new state */
  handleCopy: (): { isCopied: boolean; isHovered: boolean } => {
    return { isCopied: true, isHovered: false }
  },
}

interface CopyButtonProps {
  /** Source is materialized only on deliberate activation. */
  textToCopy: string | (() => string)
  children?: ReactNode
  leadingSpace?: boolean
  style?: Record<string, unknown>
  label?: string
  copy?: typeof copyTextToClipboard
}

/** Prose stays selectable; only the named button performs a complete source copy. */
export const CopyButton: React.FC<CopyButtonProps> = ({
  textToCopy,
  children,
  leadingSpace = true,
  style,
  label = 'Copy',
  copy = copyTextToClipboard,
}) => {
  const theme = useTheme()
  const [state, setState] = useState<'idle' | 'copying' | 'copied' | 'failed'>(
    'idle',
  )
  const [failure, setFailure] = useState('')
  const pending = useRef(false)
  const mounted = useRef(true)
  const sourceRef = useRef(textToCopy)
  sourceRef.current = textToCopy
  const timer = useRef<ReturnType<typeof globalThis.setTimeout> | null>(null)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      if (timer.current) clearTimeout(timer.current)
    }
  }, [])
  useEffect(() => {
    setState((current) => (current === 'failed' ? 'failed' : 'idle'))
  }, [textToCopy])
  const activate = async () => {
    if (pending.current) return
    pending.current = true
    const source = textToCopy
    if (timer.current) clearTimeout(timer.current)
    setState('copying')
    setFailure('')
    try {
      const text = typeof source === 'function' ? source() : source
      if (!text.length) throw new Error('No captured text is available')
      await copy(text, { suppressGlobalMessage: true })
      if (!mounted.current || sourceRef.current !== source) return
      setState('copied')
      timer.current = globalThis.setTimeout(() => {
        if (mounted.current)
          setState((current) => (current === 'copied' ? 'idle' : current))
      }, COPIED_RESET_DELAY_MS)
    } catch (error) {
      if (mounted.current && sourceRef.current === source) {
        setState('failed')
        setFailure(error instanceof Error ? error.message : String(error))
      }
    } finally {
      pending.current = false
    }
  }
  const scope = label.replace(/^copy\s*/i, '')
  return (
    <box style={{ flexDirection: 'column', ...style }}>
      {children !== undefined && (
        <text selectable={true} style={style}>
          {children}
        </text>
      )}
      <Button
        onClick={activate}
        style={{ alignSelf: children === undefined ? undefined : 'flex-end' }}
      >
        <text
          fg={
            state === 'failed'
              ? theme.error
              : state === 'copied'
                ? theme.success
                : theme.muted
          }
          wrapMode="none"
        >
          {leadingSpace ? ' ' : ''}
          {state === 'copied'
            ? `Copied${scope ? ` ${scope}` : ''}`
            : state === 'copying'
              ? `Copying${scope ? ` ${scope}` : ''}…`
              : state === 'failed'
                ? `Retry copy${scope ? ` ${scope}` : ''}`
                : label}
        </text>
      </Button>
      {state === 'failed' && (
        <text fg={theme.error} style={{ wrapMode: 'word' }}>
          Copy failed: {failure}. Select text and copy manually, or activate
          again to retry.
        </text>
      )}
    </box>
  )
}
