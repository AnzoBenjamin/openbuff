import { useTheme } from '../../hooks/use-theme'
import {
  getStructuredErrorMessages,
  getToolOutputRecords,
} from '../../utils/tool-result-normalizer'
import { defineToolComponent } from './types'

const MAX_MATCHES = 6
const SNIPPET_CHARS = 160

/** Collapse whitespace and bound a snippet so the detail box stays compact. */
function trimSnippet(value: unknown): string {
  if (typeof value !== 'string') return ''
  const collapsed = value.replace(/\s+/g, ' ').trim()
  return collapsed.length > SNIPPET_CHARS
    ? collapsed.slice(0, SNIPPET_CHARS) + '…'
    : collapsed
}

/**
 * Human-readable renderer for `recall_context`. Summarizes the archived-match
 * count, lists a bounded set of `step N · toolName` lines with trimmed
 * snippets, surfaces the empty-archive `message`, and notes the
 * `consolidations` count when present. Guards every field access so an
 * unexpected shape degrades to a minimal summary instead of throwing.
 */
export const RecallContextComponent = defineToolComponent({
  toolName: 'recall_context',
  render(toolBlock) {
    const theme = useTheme()
    const record = getToolOutputRecords(toolBlock.outputRaw)[0]
    const error = getStructuredErrorMessages(
      toolBlock.outputRaw ?? toolBlock.output,
    )[0]

    const matchesRaw = record?.matches
    const matches: unknown[] = Array.isArray(matchesRaw) ? matchesRaw : []
    const message =
      typeof record?.message === 'string' ? record.message : undefined
    const consolidationsRaw = record?.consolidations
    const consolidations = Array.isArray(consolidationsRaw)
      ? consolidationsRaw.length
      : undefined

    const summary = error
      ? `Recall failed · ${error}`
      : `Recall · ${matches.length} match${matches.length === 1 ? '' : 'es'}`
    const shown = matches.slice(0, MAX_MATCHES)
    const moreCount = matches.length - shown.length

    return {
      collapsedPreview: summary,
      content: (
        <box style={{ flexDirection: 'column', gap: 0, width: '100%' }}>
          <text fg={error ? theme.error : theme.foreground}>{summary}</text>
          {message ? <text fg={theme.muted}>{message}</text> : null}
          {shown.map((match, index) => {
            const entry = match as Record<string, unknown>
            const step =
              typeof entry?.step === 'number' ? entry.step : '?'
            const name =
              typeof entry?.toolName === 'string' ? entry.toolName : 'unknown'
            const snippet = trimSnippet(entry?.snippet)
            return (
              <box
                key={index}
                style={{ flexDirection: 'column', gap: 0, width: '100%' }}
              >
                <text fg={theme.muted}>{`step ${step} · ${name}`}</text>
                {snippet ? <text fg={theme.muted}>{snippet}</text> : null}
              </box>
            )
          })}
          {moreCount > 0 ? (
            <text fg={theme.muted}>{`…${moreCount} more`}</text>
          ) : null}
          {consolidations !== undefined ? (
            <text fg={theme.muted}>
              {`${consolidations} consolidation${consolidations === 1 ? '' : 's'}`}
            </text>
          ) : null}
        </box>
      ),
    }
  },
})
