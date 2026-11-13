import { useTheme } from '../../hooks/use-theme'
import { createStructuredPreview } from '../../utils/structured-preview'

/** Grouped labels and values, without treating arbitrary payloads as Markdown. */
export function StructuredResult({ value }: { value: unknown }) {
  const theme = useTheme()
  const rows = createStructuredPreview(value)
  return (
    <box style={{ flexDirection: 'column', width: '100%', minWidth: 0 }}>
      {rows.map((row, index) => (
        <box key={index} style={{ paddingLeft: row.depth * 2, minWidth: 0 }}>
          <text style={{ wrapMode: 'word' }}>
            {row.label ? (
              <span fg={row.heading ? theme.foreground : theme.muted}>
                {`${row.label}${row.label.endsWith('.') ? (row.heading ? '' : ' ') : row.heading ? ':' : ': '}`}
              </span>
            ) : null}
            <span fg={theme.foreground}>{row.value ?? ''}</span>
          </text>
        </box>
      ))}
    </box>
  )
}
