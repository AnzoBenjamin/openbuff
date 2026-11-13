import { useKeyboard } from '@opentui/react'
import { useRef, useState } from 'react'
import type { Renderable, ScrollBoxRenderable } from '@opentui/core'

export function useConversationControls(options: {
  scrollRef: React.RefObject<ScrollBoxRenderable | null>
  enabled: () => boolean
  onEnter: () => void
  onLeave: () => void
  onCommands: () => void
  composerHasFocus?: () => boolean
}) {
  const activeRef = useRef(false)
  const [active, setActive] = useState(false)
  const leave = (restoreFocus = true) => {
    activeRef.current = false
    setActive(false)
    if (restoreFocus) options.onLeave()
  }
  const controls = (): Renderable[] => {
    const box = options.scrollRef.current
    if (!box) return []
    const found: Renderable[] = []
    const pending: Renderable[] = box.content.getChildren()
    let examined = 0
    while (pending.length && examined++ < 5000) {
      const node = pending.pop()!
      if (
        node.visible &&
        node.focusable &&
        node.y + node.height > box.viewport.y &&
        node.y < box.viewport.y + box.viewport.height
      )
        found.push(node)
      for (const child of node.getChildren()) {
        if (pending.length >= 5000) break
        pending.push(child)
      }
    }
    for (const id of ['chat-latest', 'chat-stop']) {
      const node = box.parent?.findDescendantById(id)
      if (node?.visible && node.focusable) found.push(node)
    }
    return found.sort((a, b) => a.y - b.y || a.x - b.x)
  }
  useKeyboard((key) => {
    if (!options.enabled()) return
    if (
      !activeRef.current &&
      options.composerHasFocus?.() === false &&
      options.scrollRef.current?.parent?.hasFocusedDescendant
    ) {
      activeRef.current = true
      setActive(true)
      options.onEnter()
    }
    if (key.name === 'f6') {
      if (activeRef.current) leave()
      else {
        const first = controls()[0]
        if (first) {
          activeRef.current = true
          setActive(true)
          options.onEnter()
          first.focus()
        } else options.onCommands()
      }
    } else if (activeRef.current && key.name === 'escape') leave()
    else if (activeRef.current && key.name === 'tab') {
      const items = controls()
      const current = items.findIndex((item) => item.focused)
      if (items.length)
        items[
          (current + (key.shift ? -1 : 1) + items.length) % items.length
        ].focus()
    } else if (activeRef.current && key.ctrl && key.name === 'p') {
      leave()
      options.onCommands()
    } else return
    key.preventDefault()
    key.stopPropagation()
  })
  return { active, activeRef, leave }
}
