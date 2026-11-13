import { useRenderer } from '@opentui/react'
import { useMemo, useSyncExternalStore } from 'react'

type Renderer = ReturnType<typeof useRenderer>

// Share one native resize subscription per renderer, regardless of how many
// chat blocks need dimensions. Weak keys also release destroyed renderers.
const dimensionStores = new WeakMap<
  Renderer,
  ReturnType<typeof createDimensionStore>
>()

function createDimensionStore(renderer: Renderer) {
  let snapshot = { width: renderer.width, height: renderer.height }
  const listeners = new Set<() => void>()
  const getSnapshot = () => {
    if (
      snapshot.width !== renderer.width ||
      snapshot.height !== renderer.height
    ) {
      snapshot = { width: renderer.width, height: renderer.height }
    }
    return snapshot
  }
  const onResize = () => {
    const previous = snapshot
    if (getSnapshot() === previous) return
    for (const listener of listeners) listener()
  }
  return {
    getSnapshot,
    subscribe(listener: () => void) {
      if (listeners.size === 0) renderer.on('resize', onResize)
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
        if (listeners.size === 0) renderer.off('resize', onResize)
      }
    },
  }
}

export const useTerminalDimensions = () => {
  const renderer = useRenderer()
  let store = dimensionStores.get(renderer)
  if (!store) {
    store = createDimensionStore(renderer)
    dimensionStores.set(renderer, store)
  }
  const { width: measuredWidth, height: measuredHeight } = useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getSnapshot,
  )

  const sanitizeDimension = (
    value: number | null | undefined,
  ): number | null => {
    if (typeof value !== 'number') return null
    if (!Number.isFinite(value) || value <= 0) return null
    return value
  }

  const resolvedTerminalWidth = useMemo(
    () =>
      sanitizeDimension(measuredWidth) ??
      sanitizeDimension(renderer?.width) ??
      80,
    [measuredWidth, renderer?.width],
  )

  const resolvedTerminalHeight = useMemo(
    () =>
      sanitizeDimension(measuredHeight) ??
      sanitizeDimension(renderer?.height) ??
      24,
    [measuredHeight, renderer?.height],
  )

  const terminalWidth = resolvedTerminalWidth
  const terminalHeight = resolvedTerminalHeight
  const separatorWidth = useMemo(
    () => Math.max(1, Math.floor(terminalWidth) - 2),
    [terminalWidth],
  )

  const contentMaxWidth = useMemo(
    () => Math.max(10, Math.min(terminalWidth - 4, 80)),
    [terminalWidth],
  )

  return {
    terminalWidth,
    terminalHeight,
    separatorWidth,
    contentMaxWidth,
  }
}
