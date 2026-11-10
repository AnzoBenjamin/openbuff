import { TextAttributes } from '@opentui/core'
import { useTheme } from '../hooks/use-theme'
import type { OutputKind } from '../utils/output-document'

/** Lightweight highlighting of visible rows, without reparsing the entire capture. */
export function ReaderLine({
  text,
  kind,
  heading,
}: {
  text: string
  kind?: OutputKind
  heading?: boolean
}) {
  const theme = useTheme()
  if (kind === 'json') {
    const field = /^(\s*[^:]+)(: | · )(.*)$/.exec(text)
    if (field)
      return (
        <>
          <span
            fg={field[2] === ' · ' ? theme.primary : theme.secondary}
            attributes={field[2] === ' · ' ? TextAttributes.BOLD : 0}
          >
            {field[1]}
          </span>
          <span fg={theme.muted}>{field[2]}</span>
          <span fg={theme.foreground}>{field[3]}</span>
        </>
      )
  }
  const color =
    kind === 'diff'
      ? text.startsWith('+')
        ? theme.success
        : text.startsWith('-')
          ? theme.error
          : text.startsWith('@@')
            ? theme.link
            : theme.foreground
      : heading
        ? theme.primary
        : theme.foreground
  return (
    <span fg={color} attributes={heading ? TextAttributes.BOLD : 0}>
      {text}
    </span>
  )
}
