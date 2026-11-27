import {
  cloneElement,
  isValidElement,
  memo,
  useCallback,
  useRef,
  useState,
} from 'react'
import { TextAttributes } from '@opentui/core'

import { makeTextUnselectable } from './clickable'

import type { ReactElement, ReactNode, Ref } from 'react'
import type { BoxRenderable, KeyEvent, MouseEvent } from '@opentui/core'

interface ButtonProps {
  onClick?: (e?: unknown) => void | Promise<unknown>
  onMouseOver?: () => void
  onMouseOut?: () => void
  onKeyDown?: (event: KeyEvent) => void
  focusable?: boolean
  ref?: Ref<BoxRenderable>
  onFocused?: () => void
  onBlurred?: () => void
  style?: Record<string, unknown>
  children?: ReactNode
  // pass-through for box host props
  [key: string]: unknown
}

export const isButtonActivationKey = (event: Pick<KeyEvent, 'name'>) =>
  event.name === 'return' || event.name === 'enter' || event.name === 'space'

/** Attribute-only focus does not change row width or create nested host boxes. */
function underlineFocusedText(node: ReactNode): ReactNode {
  if (Array.isArray(node)) return node.map(underlineFocusedText)
  if (!isValidElement(node)) return node
  const element = node as ReactElement<{
    children?: ReactNode
    attributes?: number
    style?: Record<string, unknown>
  }>
  const text = element.type === 'text' || element.type === 'span'
  const attributes =
    (element.props.attributes ?? Number(element.props.style?.attributes ?? 0)) |
    TextAttributes.UNDERLINE
  return cloneElement(
    element,
    text ? { attributes, style: { ...element.props.style, attributes } } : {},
    element.props.children === undefined
      ? undefined
      : underlineFocusedText(element.props.children),
  )
}

/**
 * A button component with proper click detection and non-selectable text.
 *
 * Key behavior:
 * - All nested `<text>`/`<span>` children are made `selectable={false}` via `makeTextUnselectable`
 * - Uses mouseDown/mouseUp tracking so hover or stray mouse events don't trigger clicks
 *
 * When to use:
 * - Use `Button` for standard button-like interactions (primary choice for clickable controls)
 * - Use {@link Clickable} when you need direct control over mouse events but still want
 *   non-selectable text for an interactive region.
 */
export const Button = memo(function Button({
  onClick,
  onMouseOver,
  onMouseOut,
  onKeyDown,
  focusable = onClick != null,
  ref,
  onFocused,
  onBlurred,
  style,
  children,
  ...rest
}: ButtonProps) {
  const [focused, setFocused] = useState(false)
  const processedChildren = makeTextUnselectable(
    focused ? underlineFocusedText(children) : children,
  )
  const nodeRef = useRef<BoxRenderable | null>(null)
  const refCleanup = useRef<(() => void) | null>(null)
  const callbacks = useRef({ onFocused, onBlurred })
  callbacks.current = { onFocused, onBlurred }
  const handleFocused = useCallback(() => {
    setFocused(true)
    callbacks.current.onFocused?.()
  }, [])
  const handleBlurred = useCallback(() => {
    setFocused(false)
    callbacks.current.onBlurred?.()
  }, [])
  const attachRef = useCallback(
    (node: BoxRenderable | null) => {
      const hadCleanup = refCleanup.current !== null
      refCleanup.current?.()
      refCleanup.current = null
      nodeRef.current?.off('focused', handleFocused)
      nodeRef.current?.off('blurred', handleBlurred)
      nodeRef.current = node
      if (node) {
        node.on('focused', handleFocused)
        node.on('blurred', handleBlurred)
        setFocused(node.focused)
      }
      if (typeof ref === 'function') {
        if (node || !hadCleanup) {
          const cleanup = ref(node)
          if (typeof cleanup === 'function') refCleanup.current = cleanup
        }
      } else if (ref) ref.current = node
    },
    [ref, handleFocused, handleBlurred],
  )

  // Track whether mouse down occurred on this element to implement proper click detection
  // This prevents hover from triggering clicks in some terminals
  const mouseDownRef = useRef(false)

  const handleMouseDown = () => {
    if (focusable) nodeRef.current?.focus()
    mouseDownRef.current = true
  }

  const handleMouseUp = (e?: unknown) => {
    // Only trigger click if mouse down happened on this element
    if (mouseDownRef.current && onClick) {
      onClick(e)
    }
    mouseDownRef.current = false
  }

  const handleMouseOut = (event?: MouseEvent) => {
    const node = nodeRef.current
    // Native child/focus updates can emit an out event while the pointer
    // still sits inside this control. Keep its press and hover intact.
    if (
      event &&
      node &&
      !node.isDestroyed &&
      event.x >= node.x &&
      event.x < node.x + node.width &&
      event.y >= node.y &&
      event.y < node.y + node.height
    )
      return
    // Reset mouse down state when leaving the element
    mouseDownRef.current = false
    onMouseOut?.()
  }

  const handleKeyDown = (event: KeyEvent) => {
    onKeyDown?.(event)
    if (!event.defaultPrevented && onClick && isButtonActivationKey(event)) {
      event.preventDefault()
      void onClick(event)
    }
  }

  return (
    <box
      {...rest}
      ref={attachRef}
      focusable={focusable}
      style={style}
      onKeyDown={handleKeyDown}
      onMouseDown={handleMouseDown}
      onMouseUp={handleMouseUp}
      onMouseOver={onMouseOver}
      onMouseOut={handleMouseOut}
    >
      {processedChildren}
    </box>
  )
})
