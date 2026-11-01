import {
  getStructuredErrorMessages,
  getToolOutputRecords,
} from '../../utils/tool-result-normalizer'
import {
  DetailRow,
  ErrorRow,
  formatCount,
  OverflowNote,
  previewWithGlyph,
  readNumber,
  readRecordArray,
  ResultBody,
  ResultHeader,
  ResultShell,
  rowWidth,
  statusGlyphFor,
  truncateText,
} from './human-result'
import { defineToolComponent } from './types'

import type { ToolRenderConfig, ToolRenderOptions } from './types'

/**
 * Human-facing renderer for `recall_context`.
 *
 * Recalled archive matches are evidence the agent resurrected from a
 * compacted transcript, so they read as one discovery card: a header naming
 * the archive pointer recall, a match-count summary, and a bounded list of
 * `step N · toolName` entries with trimmed snippets. An empty archive, a
 * failure, and an over-long match list each degrade to a short human line
 * instead of the raw envelope JSON.
 */

const MAX_MATCHES = 6
const SNIPPET_CHARS = 160

/** Collapse whitespace and bound a snippet so the detail box stays compact. */
function trimSnippet(value: unknown): string {
  if (typeof value !== 'string') return ''
  const collapsed = value.replace(/\s+/g, ' ').trim()
  return collapsed.length > SNIPPET_CHARS
    ? `${collapsed.slice(0, SNIPPET_CHARS - 1)}…`
    : collapsed
}

export const RecallContextComponent = defineToolComponent({
  toolName: 'recall_context',
  render(toolBlock, theme, options): ToolRenderConfig {
    const record = getToolOutputRecords(toolBlock.outputRaw)[0]
    const error = getStructuredErrorMessages(
      toolBlock.outputRaw ?? toolBlock.output,
    )[0]
    const width = rowWidth(options.availableWidth)

    const matches = readRecordArray(record?.matches)
    const message =
      typeof record?.message === 'string' ? record.message : undefined
    const consolidations = readNumber(record?.consolidations)

    const statuses = statusGlyphFor(
      error ? 'failed' : matches.length === 0 ? 'empty' : 'ready',
      theme,
    )
    const summary = error
      ? `Recall failed · ${error}`
      : `Recall · ${formatCount(matches.length, 'match', 'matches')}`
    const shown = matches.slice(0, MAX_MATCHES)
    const hiddenCount = matches.length - shown.length

    return {
      collapsedPreview: previewWithGlyph(summary, statuses.glyph),
      content: (
        <ResultShell>
          <ResultHeader
            name="Recall"
            summary={truncateText(summary, 60)}
            glyph={statuses.glyph}
            glyphColor={statuses.color}
          />
          <ResultBody>
            {error ? <ErrorRow message={error} width={width} /> : null}
            {message && !error ? (
              <DetailRow
                value={message}
                width={width}
                valueColor={theme.muted}
              />
            ) : null}
            {shown.map((entry, index) => {
              const step =
                typeof entry.step === 'number' ? entry.step : undefined
              const name =
                typeof entry.toolName === 'string' && entry.toolName.trim()
                  ? entry.toolName
                  : 'unknown tool'
              const snippet = trimSnippet(entry.snippet)
              return (
                <DetailRow
                  key={`${name}-${index}`}
                  label={
                    step === undefined ? name : `step ${step} · ${name}`
                  }
                  value={snippet || '(no snippet recorded)'}
                  width={width}
                  valueColor={theme.muted}
                />
              )
            })}
            <OverflowNote hiddenCount={hiddenCount} noun="match" />
            {consolidations !== undefined && consolidations > 0 ? (
              <DetailRow
                value={formatCount(consolidations, 'consolidation')}
                width={width}
                valueColor={theme.muted}
              />
            ) : null}
          </ResultBody>
        </ResultShell>
      ),
    }
  },
})
