import {
  decodePasteBytes,
  stripAnsiSequences,
  TextAttributes,
} from '@opentui/core'
import { useAppContext, useKeyboard, useRenderer } from '@opentui/react'
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from 'react'

import { InputCursor } from './input-cursor'
import { useTheme } from '../hooks/use-theme'
import { useChatStore } from '../state/chat-store'
import { getKeypadPrintableSequence, isKeypadEnter } from '../utils/keypad-keys'
import { clamp } from '../utils/math'
import {
  isLinefeedActingAsEnter,
  markReturnKeySeenForKey,
} from '../utils/terminal-enter-detection'
import { LONG_TEXT_THRESHOLD } from '../utils/strings'
import {
  computeMultilineInputHeight,
  createPlaceholderLineMemo,
  inputWrapColumns,
  multilineInputMeasurementKey,
} from '../utils/text-layout'
import { supportsTruecolor } from '../utils/theme-system'
import { calculateNewCursorPosition } from '../utils/word-wrap-utils'

import type { InputValue } from '../types/store'
import type {
  KeyEvent,
  MouseEvent,
  PasteEvent,
  ScrollBoxRenderable,
  TextBufferView,
  TextRenderable,
} from '@opentui/core'

function getPasteText(event: PasteEvent): string {
  return stripAnsiSequences(decodePasteBytes(event.bytes))
}

// Helper functions for text manipulation
function findLineStart(text: string, cursor: number): number {
  let pos = Math.max(0, Math.min(cursor, text.length))
  while (pos > 0 && text[pos - 1] !== '\n') {
    pos--
  }
  return pos
}

function findLineEnd(text: string, cursor: number): number {
  let pos = Math.max(0, Math.min(cursor, text.length))
  while (pos < text.length && text[pos] !== '\n') {
    pos++
  }
  return pos
}

function findPreviousWordBoundary(text: string, cursor: number): number {
  let pos = Math.max(0, Math.min(cursor, text.length))

  // Skip whitespace backwards
  while (pos > 0 && /\s/.test(text[pos - 1])) {
    pos--
  }

  // Skip word characters backwards
  while (pos > 0 && !/\s/.test(text[pos - 1])) {
    pos--
  }

  return pos
}

function findNextWordBoundary(text: string, cursor: number): number {
  let pos = Math.max(0, Math.min(cursor, text.length))

  // Skip non-whitespace forwards
  while (pos < text.length && !/\s/.test(text[pos])) {
    pos++
  }

  // Skip whitespace forwards
  while (pos < text.length && /\s/.test(text[pos])) {
    pos++
  }

  return pos
}

export const CURSOR_CHAR = '▍'

/**
 * The `placeholder` argument MultilineInput hands to
 * `computeMultilineInputHeight`.
 *
 * The box draws the placeholder only while the input is empty, so this is the
 * exact string whose row count the height has to cover — and it is `undefined`,
 * NOT `''`, when no placeholder is being drawn. That distinction is what makes
 * the memo key the real drawn string: keying the idle frame on `''` (or on the
 * unstripped placeholder) would leave the memo permanently cold for the state
 * the input sits in between submits, re-wrapping the placeholder on every
 * render.
 *
 * Exported as a test seam so the wiring can be pinned without rendering the
 * component under the OpenTUI app context; the component calls it, so a test
 * that exercises it covers the shipped expression.
 */
export function multilineInputPlaceholderArg(
  isPlaceholder: boolean,
  displayValue: string,
): string | undefined {
  return isPlaceholder ? displayValue : undefined
}

/**
 * The string the box actually draws: the value (or the placeholder) with every
 * tab expanded to TAB_WIDTH spaces.
 *
 * Fast-pathed, not always-expanding, because this runs on EVERY render-body
 * evaluation and the idle input is the state the box sits in between submits.
 * `String.prototype.replace` without a tab match still allocates a fresh string,
 * so the idle frame paid an O(placeholder) copy per render even when the memo
 * had made its row count free — and that fresh identity also re-ran the
 * scroll effect, which keys on the rendered text. Returning `text` itself when
 * there is no tab makes the idle frame allocate nothing and keeps the reference
 * stable across renders, so the effect that keys on the DRAWN rows does not fire
 * for a frame that changed nothing.
 *
 * Exported as a test seam so the fast path can be pinned without rendering the
 * component under the OpenTUI app context; the component calls it.
 */
export function expandTabsForRendering(text: string): string {
  if (text.indexOf('\t') === -1) return text
  return text.replace(/\t/g, ' '.repeat(TAB_WIDTH))
}

/**
 * The columns MultilineInput wraps the drawn text at, from the width its caller
 * reserved. `undefined` when no width was reserved, which is how the height
 * computation knows to fall back to the rendered row count.
 *
 * Delegates the padding subtraction to `inputWrapColumns` rather than deriving
 * it again: this is the third of the three sites that must agree on the columns
 * (the chat screen, `computeMultilineInputHeight`, and here), and a local copy
 * that drifted by a single column would silently turn the caller-measurement
 * reuse path off and restore a wrap pass on every render.
 */
export function multilineInputWrapColumns(
  wrapWidth: number | undefined,
): number | undefined {
  return wrapWidth === undefined ? undefined : inputWrapColumns(wrapWidth)
}

const CONTROL_CHAR_REGEX = /[\u0000-\u0008\u000b-\u000c\u000e-\u001f\u007f]/
const TAB_WIDTH = 4

/**
 * Check if a key event represents printable character input (not a special key).
 * Uses a positive heuristic based on key.name length rather than a brittle deny-list.
 *
 * The key insight is that OpenTUI's parser assigns descriptive multi-character names
 * to special keys (like 'backspace', 'up', 'f1') while regular printable characters
 * either have no name (multi-byte input like Chinese) or a single-character name.
 */
function isPrintableCharacterKey(key: KeyEvent): boolean {
  const name = key.name

  // No name = likely multi-byte input (Chinese, Japanese, Korean, etc.) - treat as printable
  if (!name) return true

  // Single character name = regular ASCII printable (a, b, 1, $, etc.)
  if (name.length === 1) return true

  // Special case: space key has name 'space' but is printable
  if (name === 'space') return true

  // Multi-char name = special key (up, f1, backspace, etc.)
  return false
}

function getPrintableKeySequence(key: KeyEvent): string | null {
  if (!key.sequence || key.sequence.length < 1) return null
  if (key.ctrl || key.meta || key.option) return null

  const keypadValue = getKeypadPrintableSequence(key)
  if (keypadValue !== null) return keypadValue

  if (!CONTROL_CHAR_REGEX.test(key.sequence) && isPrintableCharacterKey(key)) {
    return key.sequence
  }

  return null
}

// Helper to convert render position (in tab-expanded string) to original text position
function renderPositionToOriginal(text: string, renderPos: number): number {
  let originalPos = 0
  let currentRenderPos = 0

  while (originalPos < text.length && currentRenderPos < renderPos) {
    if (text[originalPos] === '\t') {
      currentRenderPos += TAB_WIDTH
    } else {
      currentRenderPos += 1
    }
    originalPos++
  }

  return Math.min(originalPos, text.length)
}

type KeyWithPreventDefault =
  | {
      preventDefault?: () => void
    }
  | null
  | undefined

function preventKeyDefault(key: KeyWithPreventDefault) {
  key?.preventDefault?.()
}

// Helper to check for alt-like modifier keys
function isAltModifier(key: KeyEvent): boolean {
  const ESC = '\x1b'
  return Boolean(
    key.option ||
    (key.sequence?.length === 2 &&
      key.sequence[0] === ESC &&
      key.sequence[1] !== '['),
  )
}

// Helper type for scrollbox with focus/blur methods (not exposed in OpenTUI types but available at runtime)
interface FocusableScrollBox {
  focus?: () => void
  blur?: () => void
}

interface MultilineInputProps {
  value: string
  onChange: (value: InputValue) => void
  onSubmit: () => void
  onKeyIntercept?: (key: KeyEvent) => boolean
  onPaste: (fallbackText?: string) => void
  placeholder?: string
  focused?: boolean
  shouldBlinkCursor?: boolean
  maxHeight?: number
  minHeight?: number
  /**
   * Columns the caller reserved for this component, wrapper padding included.
   * Supplying it makes the wrapped row count (and therefore the box height)
   * measurable on the very first render, instead of depending on the text
   * renderable's lineInfo which does not exist yet at that point.
   */
  wrapWidth?: number
  /**
   * Wrapped row count the caller already measured for `value` at the columns
   * implied by `wrapWidth`. When supplied, the render body uses it directly and
   * performs no wrap measurement of its own, so a keystroke costs one wrap pass
   * for the whole input row instead of one per consumer of the same value.
   */
  measuredTotalLines?: number
  /**
   * Whether that same caller measurement decided to render the trailing gutter
   * row. Forwarded so the gutter term of the height comes from the one fixed
   * measurement as well: recomputing it here from the cursor row makes the box
   * depend on the text renderable's lineInfo, which is null before the first
   * commit, so two-row content rendered at height 2 and then grew to 3.
   */
  measuredGutterEnabled?: boolean
  /**
   * The caller's own effective cap on the forwarded row count. The forwarded
   * count is a PRE-CLAMP row fact shared by every mount (one measurement serves
   * both a compact and a full-height box), so scrollability must be decided from
   * the same basis the caller's layout used: comparing the row count against
   * only this box's `maxHeight` lets the box report content as fitting while the
   * caller's layout has already clamped it to scroll. Omitted means this mount is
   * the only authority and its own `maxHeight` is the cap.
   */
  callerHeightCap?: number
  /**
   * Identity of the forwarded `measuredTotalLines`, produced by the CALLER via
   * `multilineInputMeasurementKey` over the same raw value and columns the
   * count was measured at. When present it is authoritative: the count is
   * trusted only while this key equals the one the box derives from the value
   * and wrap columns it actually draws at, so a stale or wrong-width count
   * degrades to one local wrap pass. Without it the box fabricates the key
   * from its own props (legacy behavior — that check can only ever agree with
   * itself, so callers able to measure should always supply the key).
   */
  measurementKey?: string
  cursorPosition: number
  showScrollbar?: boolean
}

export type MultilineInputHandle = {
  focus: () => void
  blur: () => void
}

export const MultilineInput = forwardRef<
  MultilineInputHandle,
  MultilineInputProps
>(function MultilineInput(
  {
    value,
    onChange,
    onSubmit,
    onPaste,
    placeholder = '',
    focused = true,
    shouldBlinkCursor,
    maxHeight = 5,
    minHeight = 1,
    wrapWidth,
    measuredTotalLines,
    measuredGutterEnabled,
    callerHeightCap,
    measurementKey,
    onKeyIntercept,
    cursorPosition,
    showScrollbar = false,
  }: MultilineInputProps,
  forwardedRef,
) {
  const theme = useTheme()
  const renderer = useRenderer()
  const appContext = useAppContext()
  const { keyHandler } = appContext
  const hookBlinkValue = useChatStore((state) => state.isFocusSupported)
  const effectiveShouldBlinkCursor = shouldBlinkCursor ?? hookBlinkValue

  const scrollBoxRef = useRef<ScrollBoxRenderable | null>(null)
  const [lastActivity, setLastActivity] = useState(Date.now())

  // Per-INSTANCE placeholder memo. Two MultilineInputs are mounted in one frame
  // by chat-input-bar's compact and full-height branches (and a dialog can mount
  // a third at another width), so the memo cannot be module state: a shared slot
  // would let one box read a row count measured at the other box's columns. This
  // ref belongs to this mounted box, and computeMultilineInputHeight stays a pure
  // function of the memo it is handed.
  const placeholderMemoRef = useRef(createPlaceholderLineMemo())

  const stickyColumnRef = useRef<number | null>(null)

  // Refs to track latest value and cursor position synchronously for IME input handling.
  // When IME sends multiple character events rapidly (e.g., Chinese input), React batches
  // state updates, causing subsequent events to see stale closure values. These refs are
  // updated synchronously to ensure each keystroke builds on the previous one.
  const valueRef = useRef(value)
  const cursorPositionRef = useRef(cursorPosition)

  // Keep refs current on every render (synchronous assignment avoids useEffect timing issues)
  valueRef.current = value
  cursorPositionRef.current = cursorPosition

  // Helper to get or set the sticky column for vertical navigation.
  // When stickyColumnRef.current is set, we return it (preserving column across
  // multiple up/down presses). When null, we calculate from current cursor position.
  const getOrSetStickyColumn = useCallback(
    (lineStarts: number[], cursorIsChar: boolean): number => {
      if (stickyColumnRef.current != null) {
        return stickyColumnRef.current
      }
      const lineIndex = lineStarts.findLastIndex(
        (lineStart) => lineStart <= cursorPosition,
      )
      const column =
        lineIndex === -1
          ? 0
          : cursorPosition - lineStarts[lineIndex] + (cursorIsChar ? -1 : 0)
      stickyColumnRef.current = Math.max(0, column)
      return stickyColumnRef.current
    },
    [cursorPosition],
  )

  // Update last activity on value or cursor changes
  useEffect(() => {
    setLastActivity(Date.now())
  }, [value, cursorPosition])

  const textRef = useRef<TextRenderable | null>(null)

  const lineInfo = textRef.current
    ? (
        (textRef.current satisfies TextRenderable as any)
          .textBufferView as TextBufferView
      ).lineInfo
    : null

  // Focus/blur scrollbox when focused prop changes
  const prevFocusedRef = useRef(false)
  useEffect(() => {
    if (focused && !prevFocusedRef.current) {
      ;(scrollBoxRef.current as FocusableScrollBox | null)?.focus?.()
    } else if (!focused && prevFocusedRef.current) {
      ;(scrollBoxRef.current as FocusableScrollBox | null)?.blur?.()
    }
    prevFocusedRef.current = focused
  }, [focused])

  // Expose focus/blur for imperative use cases
  useImperativeHandle(
    forwardedRef,
    () => ({
      focus: () => {
        ;(scrollBoxRef.current as FocusableScrollBox | null)?.focus?.()
      },
      blur: () => {
        ;(scrollBoxRef.current as FocusableScrollBox | null)?.blur?.()
      },
    }),
    [],
  )

  const cursorRow = lineInfo
    ? Math.max(
        0,
        lineInfo.lineStartCols.findLastIndex(
          (lineStart) => lineStart <= cursorPosition,
        ),
      )
    : 0

  // The wrap columns this box derives from the width its caller reserved. Kept
  // as `inputWrapColumns` rather than a local subtraction so it cannot drift from
  // the columns chat.tsx measured the forwarded row count at: a one-column
  // disagreement turns the reuse path off for that frame and silently restores a
  // wrap pass on every render.
  const wrapColumns =
    wrapWidth === undefined ? undefined : inputWrapColumns(wrapWidth)

  // Helper to get current selection in original text coordinates
  const getSelectionRange = useCallback((): {
    start: number
    end: number
  } | null => {
    const textBufferView = (textRef.current as any)?.textBufferView
    if (!textBufferView?.hasSelection?.() || !textBufferView?.getSelection) {
      return null
    }
    const selection = textBufferView.getSelection()
    if (!selection) return null

    // Convert from render positions to original text positions
    const start = renderPositionToOriginal(
      value,
      Math.min(selection.start, selection.end),
    )
    const end = renderPositionToOriginal(
      value,
      Math.max(selection.start, selection.end),
    )

    if (start === end) return null
    return { start, end }
  }, [value])

  // Helper to clear the current selection
  const clearSelection = useCallback(() => {
    // Use renderer's clearSelection for proper visual clearing
    ;(renderer as any)?.clearSelection?.()
  }, [renderer])

  // Helper to delete selected text and return new value and cursor position
  const deleteSelection = useCallback((): {
    newValue: string
    newCursor: number
  } | null => {
    const selection = getSelectionRange()
    if (!selection) return null

    const newValue =
      value.slice(0, selection.start) + value.slice(selection.end)
    clearSelection()
    return { newValue, newCursor: selection.start }
  }, [value, getSelectionRange, clearSelection])

  // Helper to handle selection deletion and call onChange if selection existed
  // Returns true if selection was deleted, false otherwise
  const handleSelectionDeletion = useCallback((): boolean => {
    const deleted = deleteSelection()
    if (deleted) {
      onChange({
        text: deleted.newValue,
        cursorPosition: deleted.newCursor,
        lastEditDueToNav: false,
      })
      return true
    }
    return false
  }, [deleteSelection, onChange])

  const insertTextAtCursor = useCallback(
    (textToInsert: string) => {
      if (!textToInsert) return

      // Check if there's a selection to replace
      const selection = getSelectionRange()
      if (selection) {
        // Replace selected text with the new text
        clearSelection()
        // Read from refs which have the latest values (updated synchronously below)
        const currentValue = valueRef.current
        const newValue =
          currentValue.slice(0, selection.start) +
          textToInsert +
          currentValue.slice(selection.end)
        const newCursor = selection.start + textToInsert.length

        // Update refs synchronously BEFORE calling onChange - critical for IME input
        // where multiple characters may arrive before React processes state updates
        valueRef.current = newValue
        cursorPositionRef.current = newCursor

        onChange({
          text: newValue,
          cursorPosition: newCursor,
          lastEditDueToNav: false,
        })
        return
      }

      // No selection, insert at cursor
      // Read from refs to get latest state (handles rapid IME input)
      const currentValue = valueRef.current
      const currentCursor = cursorPositionRef.current
      const newValue =
        currentValue.slice(0, currentCursor) +
        textToInsert +
        currentValue.slice(currentCursor)
      const newCursor = currentCursor + textToInsert.length

      // Update refs synchronously BEFORE calling onChange - critical for IME input
      // where multiple characters may arrive before React processes state updates
      valueRef.current = newValue
      cursorPositionRef.current = newCursor

      onChange({
        text: newValue,
        cursorPosition: newCursor,
        lastEditDueToNav: false,
      })
    },
    [onChange, getSelectionRange, clearSelection],
  )

  const moveCursor = useCallback(
    (nextPosition: number) => {
      const clamped = Math.max(0, Math.min(value.length, nextPosition))
      if (clamped === cursorPosition) return
      onChange({
        text: value,
        cursorPosition: clamped,
        lastEditDueToNav: false,
      })
    },
    [cursorPosition, onChange, value],
  )

  // Handle mouse clicks to position cursor
  const handleMouseDown = useCallback(
    (event: MouseEvent) => {
      if (!focused) return

      // Clear sticky column since this is not up/down navigation
      stickyColumnRef.current = null

      const scrollBox = scrollBoxRef.current
      if (!scrollBox) return

      const lineStarts = lineInfo?.lineStartCols ?? [0]

      const viewport = (scrollBox as any).viewport
      const viewportTop = Number(viewport?.y ?? 0)
      const viewportLeft = Number(viewport?.x ?? 0)

      // Get click position, accounting for scroll
      const scrollPosition = scrollBox.verticalScrollBar?.scrollPosition ?? 0
      const clickRowInViewport = Math.floor(event.y - viewportTop)
      const clickRow = clickRowInViewport + scrollPosition

      // Find which visual line was clicked
      const lineIndex = Math.min(Math.max(0, clickRow), lineStarts.length - 1)

      // Get the character range for this line
      const lineStartChar = lineStarts[lineIndex]
      const lineEndChar = lineStarts[lineIndex + 1] ?? value.length

      // Convert click x to character position, accounting for tabs
      const clickCol = Math.max(0, Math.floor(event.x - viewportLeft))

      let visualCol = 0
      let charIndex = lineStartChar

      while (charIndex < lineEndChar && visualCol < clickCol) {
        const char = value[charIndex]
        if (char === '\t') {
          visualCol += TAB_WIDTH
        } else if (char === '\n') {
          break
        } else {
          visualCol += 1
        }
        charIndex++
      }

      // Clamp to valid range
      const newCursorPosition = Math.min(charIndex, value.length)

      // Update cursor position if changed
      if (newCursorPosition !== cursorPosition) {
        onChange({
          text: value,
          cursorPosition: newCursorPosition,
          lastEditDueToNav: false,
        })
      }
    },
    [focused, lineInfo, value, cursorPosition, onChange],
  )

  const isPlaceholder = value.length === 0 && placeholder.length > 0
  const displayValue = isPlaceholder ? placeholder : value
  const showCursor = focused

  // Expand tabs for proper rendering. Fast-pathed on "is there a tab at all":
  // the idle frame (an unbroken placeholder, no tabs) then keeps ONE string
  // reference across renders instead of re-allocating the drawn text per render.
  const displayValueForRendering = expandTabsForRendering(displayValue)

  // Calculate cursor position in the expanded string (accounting for tabs)
  let renderCursorPosition = 0
  for (let i = 0; i < cursorPosition && i < displayValue.length; i++) {
    renderCursorPosition += displayValue[i] === '\t' ? TAB_WIDTH : 1
  }

  const { beforeCursor, afterCursor, activeChar, shouldHighlight } = (() => {
    if (!showCursor) {
      return {
        beforeCursor: '',
        afterCursor: '',
        activeChar: ' ',
        shouldHighlight: false,
      }
    }

    const beforeCursor = displayValueForRendering.slice(0, renderCursorPosition)
    const afterCursor = displayValueForRendering.slice(renderCursorPosition)
    const activeChar = afterCursor.charAt(0) || ' '
    const shouldHighlight =
      !isPlaceholder &&
      renderCursorPosition < displayValueForRendering.length &&
      displayValue[cursorPosition] !== '\n' &&
      displayValue[cursorPosition] !== '\t'

    return {
      beforeCursor,
      afterCursor,
      activeChar,
      shouldHighlight,
    }
  })()

  // --- Keyboard Handler Helpers ---

  // Handle enter/newline keys
  const handleEnterKeys = useCallback(
    (key: KeyEvent): boolean => {
      const lowerKeyName = (key.name ?? '').toLowerCase()
      const keypadEnter = isKeypadEnter(key)
      const isReturnOrEnter =
        key.name === 'return' || key.name === 'enter' || keypadEnter

      markReturnKeySeenForKey(key)

      const linefeedIsEnter =
        lowerKeyName === 'linefeed' && isLinefeedActingAsEnter()
      const isEnterKey = isReturnOrEnter || linefeedIsEnter

      const isCtrlJ =
        (lowerKeyName === 'linefeed' && !linefeedIsEnter) ||
        (key.ctrl && !key.meta && !key.option && lowerKeyName === 'j')

      // Only handle Enter and Ctrl+J here
      if (!isEnterKey && !isCtrlJ) return false

      const isAltLikeModifier = isAltModifier(key)
      const hasEscapePrefix =
        typeof key.sequence === 'string' &&
        key.sequence.length > 0 &&
        key.sequence.charCodeAt(0) === 0x1b
      const hasBackslashBeforeCursor =
        cursorPosition > 0 && value[cursorPosition - 1] === '\\'

      // Plain Enter: no modifiers, sequence is '\r' (macOS) or '\n' (Linux)
      const isPlainEnter =
        isEnterKey &&
        !key.shift &&
        !key.ctrl &&
        !key.meta &&
        !key.option &&
        !isAltLikeModifier &&
        (!hasEscapePrefix || keypadEnter) &&
        (key.sequence === '\r' || key.sequence === '\n' || keypadEnter) &&
        !hasBackslashBeforeCursor
      const isShiftEnter = isEnterKey && Boolean(key.shift)
      const isOptionEnter =
        isEnterKey && !keypadEnter && (isAltLikeModifier || hasEscapePrefix)
      const isBackslashEnter = isEnterKey && hasBackslashBeforeCursor

      const shouldInsertNewline =
        isCtrlJ || isShiftEnter || isOptionEnter || isBackslashEnter

      if (shouldInsertNewline) {
        preventKeyDefault(key)

        // For backslash+Enter, remove the backslash and insert newline
        if (isBackslashEnter) {
          const newValue =
            value.slice(0, cursorPosition - 1) +
            '\n' +
            value.slice(cursorPosition)
          onChange({
            text: newValue,
            cursorPosition,
            lastEditDueToNav: false,
          })
          return true
        }

        // For other newline shortcuts (Shift+Enter, Option+Enter, Ctrl+J), just insert newline
        const newValue =
          value.slice(0, cursorPosition) + '\n' + value.slice(cursorPosition)
        onChange({
          text: newValue,
          cursorPosition: cursorPosition + 1,
          lastEditDueToNav: false,
        })
        return true
      }

      if (isPlainEnter) {
        preventKeyDefault(key)
        onSubmit()
        return true
      }

      return false
    },
    [value, cursorPosition, onChange, onSubmit],
  )

  // Handle deletion keys (backspace, delete, ctrl+h, ctrl+d, word/line deletion)
  const handleDeletionKeys = useCallback(
    (key: KeyEvent): boolean => {
      const lowerKeyName = (key.name ?? '').toLowerCase()
      const isAltLikeModifier = isAltModifier(key)
      const lineStart = findLineStart(value, cursorPosition)
      const lineEnd = findLineEnd(value, cursorPosition)
      const wordStart = findPreviousWordBoundary(value, cursorPosition)
      const wordEnd = findNextWordBoundary(value, cursorPosition)

      // Ctrl+U: Delete from cursor to beginning of current VISUAL line
      if (key.ctrl && lowerKeyName === 'u' && !key.meta && !key.option) {
        preventKeyDefault(key)
        if (handleSelectionDeletion()) return true
        const visualLineStart =
          lineInfo?.lineStartCols?.[cursorRow] ?? lineStart

        if (cursorPosition > visualLineStart) {
          const newValue =
            value.slice(0, visualLineStart) + value.slice(cursorPosition)
          onChange({
            text: newValue,
            cursorPosition: visualLineStart,
            lastEditDueToNav: false,
          })
        } else if (cursorPosition > 0) {
          const newValue =
            value.slice(0, cursorPosition - 1) + value.slice(cursorPosition)
          onChange({
            text: newValue,
            cursorPosition: cursorPosition - 1,
            lastEditDueToNav: false,
          })
        }
        return true
      }

      // Alt+Backspace or Ctrl+W: Delete word backward
      if (
        (key.name === 'backspace' && isAltLikeModifier) ||
        (key.ctrl && lowerKeyName === 'w')
      ) {
        preventKeyDefault(key)
        if (handleSelectionDeletion()) return true
        const newValue = value.slice(0, wordStart) + value.slice(cursorPosition)
        onChange({
          text: newValue,
          cursorPosition: wordStart,
          lastEditDueToNav: false,
        })
        return true
      }

      // Cmd+Delete: Delete to line start
      if (key.name === 'delete' && key.meta && !isAltLikeModifier) {
        preventKeyDefault(key)
        if (handleSelectionDeletion()) return true
        const originalValue = value
        let newValue = originalValue
        let nextCursor = cursorPosition

        if (cursorPosition > 0) {
          if (
            cursorPosition === lineStart &&
            value[cursorPosition - 1] === '\n'
          ) {
            newValue =
              value.slice(0, cursorPosition - 1) + value.slice(cursorPosition)
            nextCursor = cursorPosition - 1
          } else {
            newValue = value.slice(0, lineStart) + value.slice(cursorPosition)
            nextCursor = lineStart
          }
        }

        if (newValue === originalValue && cursorPosition > 0) {
          newValue =
            value.slice(0, cursorPosition - 1) + value.slice(cursorPosition)
          nextCursor = cursorPosition - 1
        }

        if (newValue !== originalValue) {
          onChange({
            text: newValue,
            cursorPosition: nextCursor,
            lastEditDueToNav: false,
          })
        }
        return true
      }

      // Alt+Delete: Delete word forward
      if (key.name === 'delete' && isAltLikeModifier) {
        preventKeyDefault(key)
        if (handleSelectionDeletion()) return true
        const newValue = value.slice(0, cursorPosition) + value.slice(wordEnd)
        onChange({
          text: newValue,
          cursorPosition,
          lastEditDueToNav: false,
        })
        return true
      }

      // Ctrl+K: Delete to line end
      if (key.ctrl && lowerKeyName === 'k' && !key.meta && !key.option) {
        preventKeyDefault(key)
        if (handleSelectionDeletion()) return true
        const newValue = value.slice(0, cursorPosition) + value.slice(lineEnd)
        onChange({ text: newValue, cursorPosition, lastEditDueToNav: false })
        return true
      }

      // Ctrl+H: Delete char backward (Emacs)
      if (key.ctrl && lowerKeyName === 'h' && !key.meta && !key.option) {
        preventKeyDefault(key)
        if (handleSelectionDeletion()) return true
        if (cursorPosition > 0) {
          const newValue =
            value.slice(0, cursorPosition - 1) + value.slice(cursorPosition)
          onChange({
            text: newValue,
            cursorPosition: cursorPosition - 1,
            lastEditDueToNav: false,
          })
        }
        return true
      }

      // Ctrl+D: Delete char forward (Emacs)
      if (key.ctrl && lowerKeyName === 'd' && !key.meta && !key.option) {
        preventKeyDefault(key)
        if (handleSelectionDeletion()) return true
        if (cursorPosition < value.length) {
          const newValue =
            value.slice(0, cursorPosition) + value.slice(cursorPosition + 1)
          onChange({
            text: newValue,
            cursorPosition,
            lastEditDueToNav: false,
          })
        }
        return true
      }

      // Basic Backspace (no modifiers)
      if (key.name === 'backspace' && !key.ctrl && !key.meta && !key.option) {
        preventKeyDefault(key)
        if (handleSelectionDeletion()) return true
        if (cursorPosition > 0) {
          const newValue =
            value.slice(0, cursorPosition - 1) + value.slice(cursorPosition)
          onChange({
            text: newValue,
            cursorPosition: cursorPosition - 1,
            lastEditDueToNav: false,
          })
        }
        return true
      }

      // Basic Delete (no modifiers)
      if (key.name === 'delete' && !key.ctrl && !key.meta && !key.option) {
        preventKeyDefault(key)
        if (handleSelectionDeletion()) return true
        if (cursorPosition < value.length) {
          const newValue =
            value.slice(0, cursorPosition) + value.slice(cursorPosition + 1)
          onChange({
            text: newValue,
            cursorPosition,
            lastEditDueToNav: false,
          })
        }
        return true
      }

      return false
    },
    [
      value,
      cursorPosition,
      onChange,
      lineInfo,
      cursorRow,
      handleSelectionDeletion,
    ],
  )

  // Handle navigation keys (arrows, home, end, word navigation, emacs bindings)
  const handleNavigationKeys = useCallback(
    (key: KeyEvent): boolean => {
      const lowerKeyName = (key.name ?? '').toLowerCase()
      const isAltLikeModifier = isAltModifier(key)
      const logicalLineStart = findLineStart(value, cursorPosition)
      const logicalLineEnd = findLineEnd(value, cursorPosition)
      const wordStart = findPreviousWordBoundary(value, cursorPosition)
      const wordEnd = findNextWordBoundary(value, cursorPosition)

      // Read lineInfo inside the callback to get current value (not stale from closure)
      const currentLineInfo = textRef.current
        ? ((textRef.current as any).textBufferView as TextBufferView)?.lineInfo
        : null

      // Calculate visual line boundaries from lineInfo (accounts for word wrap)
      // Fall back to logical line boundaries if visual info is unavailable
      const lineStarts = currentLineInfo?.lineStartCols ?? []
      const visualLineIndex = lineStarts.findLastIndex(
        (start) => start <= cursorPosition,
      )
      const visualLineStart =
        visualLineIndex >= 0 ? lineStarts[visualLineIndex] : logicalLineStart
      const visualLineEnd =
        lineStarts[visualLineIndex + 1] !== undefined
          ? lineStarts[visualLineIndex + 1] - 1
          : logicalLineEnd

      // Alt+Left/B: Word left
      if (isAltLikeModifier && (key.name === 'left' || lowerKeyName === 'b')) {
        preventKeyDefault(key)
        onChange({
          text: value,
          cursorPosition: wordStart,
          lastEditDueToNav: false,
        })
        return true
      }

      // Alt+Right/F: Word right
      if (isAltLikeModifier && (key.name === 'right' || lowerKeyName === 'f')) {
        preventKeyDefault(key)
        onChange({
          text: value,
          cursorPosition: wordEnd,
          lastEditDueToNav: false,
        })
        return true
      }

      // Cmd+Left, Ctrl+A, or Home: Line start
      if (
        (key.meta && key.name === 'left' && !isAltLikeModifier) ||
        (key.ctrl && lowerKeyName === 'a' && !key.meta && !key.option) ||
        (key.name === 'home' && !key.ctrl && !key.meta)
      ) {
        preventKeyDefault(key)
        onChange({
          text: value,
          cursorPosition: visualLineStart,
          lastEditDueToNav: false,
        })
        return true
      }

      // Cmd+Right, Ctrl+E, or End: Line end
      if (
        (key.meta && key.name === 'right' && !isAltLikeModifier) ||
        (key.ctrl && lowerKeyName === 'e' && !key.meta && !key.option) ||
        (key.name === 'end' && !key.ctrl && !key.meta)
      ) {
        preventKeyDefault(key)
        onChange({
          text: value,
          cursorPosition: visualLineEnd,
          lastEditDueToNav: false,
        })
        return true
      }

      // Cmd+Up or Ctrl+Home: Document start
      if (
        (key.meta && key.name === 'up') ||
        (key.ctrl && key.name === 'home')
      ) {
        preventKeyDefault(key)
        onChange({ text: value, cursorPosition: 0, lastEditDueToNav: false })
        return true
      }

      // Cmd+Down or Ctrl+End: Document end
      if (
        (key.meta && key.name === 'down') ||
        (key.ctrl && key.name === 'end')
      ) {
        preventKeyDefault(key)
        onChange({
          text: value,
          cursorPosition: value.length,
          lastEditDueToNav: false,
        })
        return true
      }

      // Ctrl+B: Backward char (Emacs)
      if (key.ctrl && lowerKeyName === 'b' && !key.meta && !key.option) {
        preventKeyDefault(key)
        onChange({
          text: value,
          cursorPosition: Math.max(0, cursorPosition - 1),
          lastEditDueToNav: false,
        })
        return true
      }

      // Ctrl+F: Forward char (Emacs)
      if (key.ctrl && lowerKeyName === 'f' && !key.meta && !key.option) {
        preventKeyDefault(key)
        onChange({
          text: value,
          cursorPosition: Math.min(value.length, cursorPosition + 1),
          lastEditDueToNav: false,
        })
        return true
      }

      // Left arrow (no modifiers)
      if (key.name === 'left' && !key.ctrl && !key.meta && !key.option) {
        preventKeyDefault(key)
        moveCursor(cursorPosition - 1)
        return true
      }

      // Right arrow (no modifiers)
      if (key.name === 'right' && !key.ctrl && !key.meta && !key.option) {
        preventKeyDefault(key)
        moveCursor(cursorPosition + 1)
        return true
      }

      // Up arrow (no modifiers)
      if (key.name === 'up' && !key.ctrl && !key.meta && !key.option) {
        preventKeyDefault(key)
        const desiredIndex = getOrSetStickyColumn(lineStarts, !shouldHighlight)
        onChange({
          text: value,
          cursorPosition: calculateNewCursorPosition({
            cursorPosition,
            lineStarts,
            cursorIsChar: !shouldHighlight,
            direction: 'up',
            desiredIndex,
          }),
          lastEditDueToNav: false,
        })
        return true
      }

      // Down arrow (no modifiers)
      if (key.name === 'down' && !key.ctrl && !key.meta && !key.option) {
        preventKeyDefault(key)
        const desiredIndex = getOrSetStickyColumn(lineStarts, !shouldHighlight)
        onChange({
          text: value,
          cursorPosition: calculateNewCursorPosition({
            cursorPosition,
            lineStarts,
            cursorIsChar: !shouldHighlight,
            direction: 'down',
            desiredIndex,
          }),
          lastEditDueToNav: false,
        })
        return true
      }

      return false
    },
    [
      value,
      cursorPosition,
      onChange,
      moveCursor,
      shouldHighlight,
      getOrSetStickyColumn,
    ],
  )

  // Handle character input (regular chars, tab, and IME/multi-byte input)
  const handleCharacterInput = useCallback(
    (key: KeyEvent): boolean => {
      // Tab: let higher-level keyboard handlers (like chat keyboard shortcuts) handle it
      if (
        key.name === 'tab' &&
        key.sequence &&
        !key.shift &&
        !key.ctrl &&
        !key.meta &&
        !key.option
      ) {
        // Don't insert a literal tab character here; allow global keyboard handlers to process it
        return false
      }

      // Character input (including multi-byte characters from IME like Chinese, Japanese, Korean)
      const textToInsert = getPrintableKeySequence(key)
      if (textToInsert !== null) {
        preventKeyDefault(key)

        if (textToInsert.length > LONG_TEXT_THRESHOLD) {
          onPaste(textToInsert)
          return true
        }

        insertTextAtCursor(textToInsert)
        return true
      }

      return false
    },
    [insertTextAtCursor, onPaste],
  )

  // Increase StdinParser timeout from default 10ms to 100ms.
  // Some terminals (Ghostty, iTerm2, VS Code) split bracketed paste sequences
  // across multiple stdin reads when drag-dropping files. The default 10ms
  // timeout causes the parser to flush partial escape sequences as keypresses,
  // corrupting paste detection. 100ms is still fast for keyboard input but
  // gives enough time for split paste sequences to arrive.
  useEffect(() => {
    const cliRenderer = appContext.renderer as Record<string, unknown> | null
    const stdinBuffer = cliRenderer?._stdinBuffer as
      | Record<string, unknown>
      | undefined
    if (stdinBuffer && typeof stdinBuffer.timeoutMs === 'number') {
      stdinBuffer.timeoutMs = 100
    }
  }, [appContext])

  // Global paste event listener — catches paste events (e.g. from drag-and-drop)
  // at the global level, plus a scrollbox-level backup. Some terminals may not
  // deliver paste events reliably via one mechanism alone, so we use both with
  // dedup to prevent double-handling.
  const onPasteRef = useRef(onPaste)
  onPasteRef.current = onPaste
  const pasteHandledRef = useRef(false)

  // Always listen for paste events regardless of terminal focus state.
  // Drag-and-drop inherently causes the terminal to lose focus (the file
  // manager has focus during the drag), so the paste listener must stay
  // active even when `focused` is false.
  useEffect(() => {
    if (!keyHandler) return

    const handlePaste = (event: PasteEvent) => {
      pasteHandledRef.current = true
      onPasteRef.current(getPasteText(event))
      // Reset dedup flag after microtask so scrollbox handler (which fires
      // synchronously after global listeners) sees it as handled, but future
      // paste events are not blocked.
      queueMicrotask(() => {
        pasteHandledRef.current = false
      })
    }

    keyHandler.on('paste', handlePaste)
    return () => {
      keyHandler.off('paste', handlePaste)
    }
  }, [keyHandler])

  // Main keyboard handler - delegates to specialized handlers
  useKeyboard(
    useCallback(
      (key: KeyEvent) => {
        if (!focused) return

        if (onKeyIntercept) {
          const handled = onKeyIntercept(key)
          if (handled) return
        }

        // Clear sticky column for non-vertical navigation
        const isVerticalNavKey = key.name === 'up' || key.name === 'down'
        if (!isVerticalNavKey) {
          stickyColumnRef.current = null
        }

        // Delegate to specialized handlers
        if (handleEnterKeys(key)) return
        if (handleDeletionKeys(key)) return
        if (handleNavigationKeys(key)) return
        if (handleCharacterInput(key)) return
      },
      [
        focused,
        onKeyIntercept,
        handleEnterKeys,
        handleDeletionKeys,
        handleNavigationKeys,
        handleCharacterInput,
      ],
    ),
  )

  // Height comes from the value wrapped at the width the caller reserved, not
  // from lineInfo: lineInfo is null on the first render and is only re-read
  // when this component re-renders, so using it alone sized the box shorter
  // than its wrapped content and the excess rows were painted above the box.
  // lineInfo stays the source for cursor row / visual-line navigation only.
  const layoutMetrics = computeMultilineInputHeight({
    value,
    // The placeholder is drawn through the same wrapped text renderable, so the
    // height has to cover it too. The caller's measurement covers only the value
    // it was given (chat.tsx measures a single space for an empty input), so a
    // two-row placeholder in a one-row box would paint its excess rows outside
    // the scrollbox — the very overflow this height exists to prevent. When no
    // placeholder is drawn the argument is `undefined` (never `''`), so the
    // memo namespace is keyed on the real drawn string.
    placeholder: multilineInputPlaceholderArg(
      isPlaceholder,
      displayValueForRendering,
    ),
    wrapWidth,
    lineInfoLines: lineInfo?.lineStartCols.length,
    // The forwarded count is accepted together with the identity it was
    // measured under, so a stale measurement (the caller's value prop has
    // already moved on, or the count was taken at other columns) fails the key
    // comparison in computeMultilineInputHeight and falls back to a local wrap
    // instead of sizing the box for text it is not drawing.
    //
    // The producer-supplied key is the real check: it is derived from what the
    // CALLER measured, not from this component's own props, so it can actually
    // disagree. The fallback fabrication (the value this call hands over) only
    // serves callers that forward a count without a key — a key derived here
    // can only ever agree with itself, which is why the shipped caller always
    // supplies one.
    //
    // Both sides key on the raw `value` with no empty-input substitution: the
    // producer measures a single space for an empty input but derives its key
    // from the raw text it forwards, so the identities agree on the idle empty
    // frame. `multilineInputWrapColumns` keeps the `undefined` wrapWidth case
    // explicit (the helper encodes it as 'unwrapped') instead of asserting it
    // away.
    measuredTotalLines,
    measurementKey:
      measuredTotalLines === undefined
        ? undefined
        : (measurementKey ??
          multilineInputMeasurementKey(
            value,
            multilineInputWrapColumns(wrapWidth),
          )),
    measuredGutterEnabled,
    callerHeightCap,
    placeholderMemo: placeholderMemoRef.current,
    maxHeight,
    minHeight,
    cursorRow,
  })

  // Auto-scroll to cursor when content changes. This effect is the single
  // writer of the box's scroll offset: the scrollbox itself must not use
  // sticky-bottom, because when the real wrapped content is taller than the
  // height the box was given, sticky-bottom pins the view to the end and the
  // overflow rows paint upward past the box.
  //
  // The dependency list names the FACTS that can change the legal range of the
  // offset — the wrapped row count, the reserved wrap width, the height the box
  // was given, and the caret's row — rather than the text identities. Keying it
  // on `value`/`displayValueForRendering` made the list depend on full-length
  // string comparisons that React performs per render (and on a fresh identity
  // whenever the drawn text was re-derived), so a render that moved neither the
  // row count nor the viewport still read `viewport.height`/`scrollHeight` and
  // re-clamped. `totalLines` is already computed for the box height; a keystroke
  // that changes the text but not the row count cannot move maxTop, so it must
  // not re-clamp. It is not a blank value: the drawn rows of '""' and of"x""
  // both count one row, while every edit that can move the range changes it.
  // `scrollBoxRef.current` is deliberately absent: its cell identity never
  // changes without a remount. `scrollHeight` and `viewport.height` (what maxTop
  // is derived from) are read inside the effect body for the same reason: they
  // only change when the wrapped content or the viewport does, so a reflow that
  // moves no cursor (a terminal resize changing the wrap width, or a height
  // change from the forwarded measurement) still re-clamps instead of leaving
  // the stored offset above the new maxTop and showing rows that no longer exist.
  useEffect(() => {
    const scrollBox = scrollBoxRef.current
    if (scrollBox) {
      const viewportHeight = scrollBox.viewport.height
      // Max reachable offset: the last full viewport of content. clamp() is
      // Math.min(Math.max(v, min), max), so the requested offset must land in
      // [0, maxTop]; anything outside bounds is clamped, never escaped.
      const maxTop = Math.max(0, scrollBox.scrollHeight - viewportHeight)
      const currentTop = scrollBox.verticalScrollBar.scrollPosition
      if (!focused) {
        // Focus-independent RE-CLAMP. Without stickyScroll the offset is only
        // recovered by this effect, so gating the whole body on `focused` left an
        // unfocused box whose content shrank or reflowed holding a stale offset
        // above the new maxTop — rows that no longer exist — until the next
        // focus. Keep the user's offset, just make it legal.
        const clampedTop = clamp(currentTop, 0, maxTop)
        if (clampedTop !== currentTop) {
          scrollBox.verticalScrollBar.scrollPosition = clampedTop
        }
        return
      }
      // The caret's own row is a TARGET, not a lower bound on the offset: the
      // reachable offsets are [0, maxTop], so the caret row is put into view by
      // scrolling to the offset that shows it, capped at maxTop. Using the raw
      // row as the clamp floor instead left the final viewport-height of rows
      // unreachable, so a caret on the last rows never came into view.
      const cursorTop = Math.max(0, cursorRow - viewportHeight + 1)
      const targetTop = Math.min(cursorTop, maxTop)
      // Only pull the view to the caret when the caret is actually outside it;
      // otherwise keep the user's own scroll position and just keep the offset
      // legal after a reflow.
      const scrollPosition =
        cursorRow < currentTop || cursorRow >= currentTop + viewportHeight
          ? targetTop
          : clamp(currentTop, 0, maxTop)

      scrollBox.verticalScrollBar.scrollPosition = scrollPosition
    }
  }, [
    layoutMetrics.totalLines,
    layoutMetrics.heightLines,
    wrapWidth,
    cursorRow,
    focused,
  ])

  const inputColor = isPlaceholder
    ? theme.muted
    : focused
      ? theme.inputFocusedFg
      : theme.inputFg

  // Use theme's info color for selection highlight background
  const highlightBg = theme.info

  return (
    <scrollbox
      ref={scrollBoxRef}
      scrollX={false}
      stickyScroll={false}
      scrollbarOptions={{ visible: false }}
      verticalScrollbarOptions={{
        visible: showScrollbar && layoutMetrics.isScrollable,
        trackOptions: { width: 1 },
      }}
      onPaste={(event) => {
        // Backup paste handler: fires if the global keyHandler listener
        // didn't catch this event (dedup prevents double-handling)
        if (pasteHandledRef.current) return
        onPasteRef.current(getPasteText(event))
      }}
      onMouseDown={handleMouseDown}
      style={{
        flexGrow: 0,
        flexShrink: 0,
        rootOptions: {
          width: '100%',
          height: layoutMetrics.heightLines,
          backgroundColor: 'transparent',
          flexGrow: 0,
          flexShrink: 0,
        },
        wrapperOptions: {
          paddingLeft: 1,
          paddingRight: 1,
          border: false,
        },
        contentOptions: {
          justifyContent: 'flex-start',
        },
      }}
    >
      <text
        ref={textRef}
        style={{ bg: 'transparent', fg: inputColor, wrapMode: 'char' }}
      >
        {showCursor ? (
          <>
            {beforeCursor}
            {shouldHighlight ? (
              <span
                bg={highlightBg}
                fg={theme.background}
                attributes={TextAttributes.BOLD}
              >
                {activeChar === ' ' ? '\u00a0' : activeChar}
              </span>
            ) : (
              <InputCursor
                visible={true}
                focused={focused}
                shouldBlink={effectiveShouldBlinkCursor}
                color={supportsTruecolor() ? theme.info : 'lime'}
                key={lastActivity}
              />
            )}
            {shouldHighlight
              ? afterCursor.length > 0
                ? afterCursor.slice(1)
                : ''
              : afterCursor}
            {layoutMetrics.gutterEnabled ? '\n' : ''}
          </>
        ) : (
          <>
            {displayValueForRendering}
            {layoutMetrics.gutterEnabled ? '\n' : ''}
          </>
        )}
      </text>
    </scrollbox>
  )
})
