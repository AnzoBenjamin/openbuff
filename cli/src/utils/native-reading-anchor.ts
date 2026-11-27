import type { Renderable, TextBufferRenderable } from '@opentui/core'

export interface NativeReadingAnchor {
  node: TextBufferRenderable
  messageId: string
  sourceLine: number
  sourceColumn: number
  viewportOffset: number
  rowWithinMessage: number
}

/** Resolve the visible source line/cell from mounted native text, before reflow. */
export function captureNativeReadingAnchor(
  root: Pick<Renderable, 'getChildren'>,
  viewportY: number,
  viewportHeight: number,
): NativeReadingAnchor | null {
  // ScrollBox.content is a geometry facade in OpenTUI 0.8. Its children
  // remain renderables, with the same message ancestry and screen positions.
  const pending = root.getChildren()
  let candidate: NativeReadingAnchor | null = null
  let visited = 0
  while (pending.length && visited++ < 5000) {
    const node = pending.pop()!
    for (const child of node.getChildren()) {
      if (pending.length >= 5000) break
      pending.push(child)
    }
    if (
      node.y + node.height <= viewportY ||
      node.y >= viewportY + viewportHeight
    )
      continue
    const text = node as TextBufferRenderable
    if (!('plainText' in text) || !('lineInfo' in text)) continue
    let parent: Renderable | null = node
    while (parent && !parent.id.startsWith('transcript-message-'))
      parent = parent.parent
    if (!parent) continue
    const info = text.lineInfo
    const row = Math.max(
      0,
      Math.min(info.lineSources.length - 1, Math.floor(viewportY - node.y)),
    )
    const sourceLine = info.lineSources[row]
    if (sourceLine === undefined) continue
    const sourceStart = info.lineSources.indexOf(sourceLine)
    const viewportOffset = node.y + row - viewportY
    if (candidate && candidate.viewportOffset <= viewportOffset) continue
    candidate = {
      node: text,
      messageId: parent.id.slice('transcript-message-'.length),
      sourceLine,
      sourceColumn: info.lineStartCols[row] - info.lineStartCols[sourceStart],
      viewportOffset,
      rowWithinMessage: node.y + row - parent.y,
    }
  }
  return candidate
}

/** Translate a saved logical line/cell back to its post-reflow viewport row. */
export function nativeReadingAnchorDelta(
  anchor: NativeReadingAnchor,
  viewportY: number,
): number | null {
  if (!anchor.node.parent || anchor.node.isDestroyed) return null
  const info = anchor.node.lineInfo
  const first = info.lineSources.indexOf(anchor.sourceLine)
  if (first < 0) return null
  const desiredColumn = info.lineStartCols[first] + anchor.sourceColumn
  let row = first
  while (
    row + 1 < info.lineSources.length &&
    info.lineSources[row + 1] === anchor.sourceLine &&
    info.lineStartCols[row + 1] <= desiredColumn
  )
    row++
  return anchor.node.y + row - viewportY - anchor.viewportOffset
}
