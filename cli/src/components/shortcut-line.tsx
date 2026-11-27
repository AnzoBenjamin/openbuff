import { useTheme } from '../hooks/use-theme'
import { sliceTextCells } from '../utils/text-boundaries'

/** Keys and actions have distinct contrast instead of one dense help sentence. */
export function ShortcutLine({ text, width }: { text: string; width: number }) {
  const theme = useTheme()
  const parts = sliceTextCells(text, 0, width).split(' · ')
  return (
    <text height={1} flexShrink={0} wrapMode="none" fg={theme.muted}>
      {parts.map((part, index) => {
        const space = part.indexOf(' ')
        return (
          <span key={index}>
            {index > 0 && <span fg={theme.border}> · </span>}
            {space > 0 ? (
              <>
                <span fg={theme.primary}>{part.slice(0, space)}</span>
                <span> {part.slice(space + 1)}</span>
              </>
            ) : (
              part
            )}
          </span>
        )
      })}
    </text>
  )
}
