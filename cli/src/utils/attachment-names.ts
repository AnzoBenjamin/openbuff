import stringWidth from 'string-width'
import { sliceTextCells } from './text-boundaries'

/** Keep a short extension where possible, always reserve the ellipsis cell. */
export function fitAttachmentName(filename: string, width: number): string {
  if (stringWidth(filename) <= width) return filename
  if (width <= 1) return width ? '…' : ''
  const dot = filename.lastIndexOf('.')
  const extension = dot > 0 ? filename.slice(dot) : ''
  const extensionWidth = Math.min(stringWidth(extension), Math.floor(width / 2))
  const suffix = extensionWidth
    ? sliceTextCells(extension, 0, extensionWidth)
    : ''
  return (
    sliceTextCells(
      dot > 0 ? filename.slice(0, dot) : filename,
      0,
      width - stringWidth(suffix) - 1,
    ) +
    '…' +
    suffix
  )
}
