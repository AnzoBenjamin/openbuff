import type { OutputDocument, OutputLocation } from './output-document'
import { sliceTextCells, takeTextRow } from './text-boundaries'

export type ReadingRow = {
  text: string
  location: OutputLocation
  next: OutputLocation
}
/** Materialize only visible rows. Wrapping never changes the logical anchor. */
export function readDocumentRows(
  document: OutputDocument,
  location: OutputLocation,
  width: number,
  height: number,
  wrap: boolean,
  horizontal = 0,
): ReadingRow[] {
  const rows: ReadingRow[] = []
  let line = Math.max(0, Math.min(location.line, document.lineCount - 1))
  let character = wrap ? Math.max(0, location.character) : 0
  while (rows.length < height && line < document.lineCount) {
    const source = document.line(line)
    const content = wrap
      ? takeTextRow(source, character, width)
      : { text: sliceTextCells(source, horizontal, width), end: source.length }
    const next =
      content.end < source.length && wrap
        ? { line, character: content.end }
        : { line: line + 1, character: 0 }
    rows.push({ text: content.text, location: { line, character }, next })
    line = next.line
    character = next.character
  }
  return rows
}
