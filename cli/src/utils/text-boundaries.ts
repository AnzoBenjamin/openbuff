import stringWidth from 'string-width'

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
let cachedText = ''
let cachedBoundaries = [0]
let cachedCells = [0]
function boundaries(text: string): number[] {
  if (text !== cachedText) {
    cachedText = text
    cachedBoundaries = []
    cachedCells = []
    let cells = 0
    for (const part of segmenter.segment(text)) {
      cachedBoundaries.push(part.index)
      cachedCells.push(cells)
      cells += part.segment === '\t' ? 4 : part.segment === '\n' ? 1 : stringWidth(part.segment)
    }
    cachedBoundaries.push(text.length)
    cachedCells.push(cells)
  }
  return cachedBoundaries
}

/** OpenTUI's line/selection coordinates count display cells, including newlines. */
export function textDisplayOffset(text: string, cursor: number): number {
  const points = boundaries(text)
  let low = 0, high = points.length - 1
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (points[middle] <= cursor) low = middle
    else high = middle - 1
  }
  return cachedCells[low]
}

export function textOffsetAtDisplay(text: string, column: number): number {
  const points = boundaries(text)
  let low = 0, high = cachedCells.length - 1
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (cachedCells[middle] <= column) low = middle
    else high = middle - 1
  }
  return points[low]
}
export function previousGrapheme(text: string, cursor: number): number {
  const points = boundaries(text)
  let low = 0,
    high = points.length - 1
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (points[middle] < cursor) low = middle
    else high = middle - 1
  }
  return points[low]
}
export function nextGrapheme(text: string, cursor: number): number {
  const points = boundaries(text)
  let low = 0,
    high = points.length - 1
  while (low < high) {
    const middle = Math.floor((low + high) / 2)
    if (points[middle] <= cursor) low = middle + 1
    else high = middle
  }
  return points[low]
}
/** Clip by terminal cells; never expose half of an emoji or combining cluster. */
export function sliceTextCells(
  text: string,
  offset: number,
  width: number,
): string {
  let cells = 0,
    used = 0,
    result = ''
  if (width <= 0) return result
  for (const { segment } of segmenter.segment(text)) {
    const size = segment === '\t' ? 4 : stringWidth(segment)
    if (cells + size <= offset) {
      cells += size
      continue
    }
    if (cells < offset) {
      cells += size
      continue
    }
    if (used + size > width) break
    result += segment === '\t' ? '    ' : segment
    used += size
  }
  return result
}

export function takeTextRow(
  text: string,
  start: number,
  width: number,
): { text: string; end: number } {
  let used = 0,
    shown = '',
    end = start
  for (const { segment, index } of segmenter.segment(text.slice(start))) {
    const size = segment === '\t' ? 4 : stringWidth(segment)
    if (used + size > Math.max(1, width)) {
      // A viewport narrower than a wide glyph still advances the anchor.
      if (end === start) end = start + index + segment.length
      break
    }
    shown += segment === '\t' ? '    ' : segment
    used += size
    end = start + index + segment.length
  }
  return { text: shown, end }
}
export function previousTextRowStart(
  text: string,
  end: number,
  width: number,
): number {
  let position = Math.min(end, text.length),
    used = 0
  while (position > 0) {
    const previous = previousGrapheme(text, position)
    const segment = text.slice(previous, position)
    const size = segment === '\t' ? 4 : stringWidth(segment)
    if (used + size > width) break
    used += size
    position = previous
  }
  return position
}
