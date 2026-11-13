import { describeJobEvent } from './background-job-tools'
import { useTheme } from '../../hooks/use-theme'
import { formatFallbackValue } from '../../utils/fallback-input-summary'
import {
  getStructuredErrorMessages,
  getToolOutputRecords,
} from '../../utils/tool-result-normalizer'
import { defineToolComponent } from './types'
import { InlineResults } from './inline-results'

const MAX_EVENTS = 4
/**
 * Human-readable renderer for `check_background_agent`. Summarizes the agent
 * jobId and state, shows a short tail of the most recent events plus a resolved
 * result when present, and surfaces the error for the error variant. Guards
 * every field access so an unexpected shape degrades to a minimal summary.
 */
export const CheckBackgroundAgentComponent = defineToolComponent({
  toolName: 'check_background_agent',
  render(toolBlock) {
    const theme = useTheme()
    const input = toolBlock.input as Record<string, unknown> | undefined
    const record = getToolOutputRecords(toolBlock.outputRaw)[0]
    const error = getStructuredErrorMessages(
      toolBlock.outputRaw ?? toolBlock.output,
    )[0]

    const jobId = String(record?.jobId ?? input?.jobId ?? '')
    const state =
      typeof record?.state === 'string'
        ? record.state
        : error
          ? 'error'
          : toolBlock.lifecycle === 'running' ||
              toolBlock.lifecycle === 'queued' ||
              toolBlock.lifecycle === 'failed' ||
              toolBlock.lifecycle === 'cancelled'
            ? `observation ${toolBlock.lifecycle}`
            : 'job state unavailable'
    const notices = [
      toolBlock.lifecycle === 'cancelled' && record?.state !== 'cancelled'
        ? 'observation cancelled; job state shown separately'
        : '',
      record?.timedOut === true
        ? 'wait timed out; agent state shown separately'
        : '',
      record?.cancelled === true ? 'cancelled' : '',
      record?.truncated === true
        ? 'event capture truncated; more may exist'
        : '',
      typeof record?.dropped === 'number' && record.dropped > 0
        ? `${record.dropped} events dropped`
        : '',
    ].filter(Boolean)
    const summary = `Agent${jobId ? ` ${jobId}` : ''} · ${state}${notices.length ? ` · ${notices.join(' · ')}` : ''}`

    const eventsRaw = record?.events
    const events: unknown[] = Array.isArray(eventsRaw) ? eventsRaw : []

    const result = record?.result
    let resultText: string | undefined
    if (result !== undefined && result !== null) {
      try {
        resultText = formatFallbackValue(result)
      } catch {
        resultText = '[result could not be displayed]'
      }
    }

    return {
      collapsedPreview: summary,
      content: (
        <box style={{ flexDirection: 'column', gap: 0, width: '100%' }}>
          <text fg={error ? theme.error : theme.foreground}>{summary}</text>
          {error ? <text fg={theme.error}>{error}</text> : null}
          <InlineResults
            items={events}
            previewCount={MAX_EVENTS}
            noun="event"
            fromEnd
            renderItem={(event, index) => (
              <text key={index} fg={theme.muted}>
                {describeJobEvent(event)}
              </text>
            )}
          />
          {resultText ? (
            <text fg={theme.muted}>{`result: ${resultText}`}</text>
          ) : null}
        </box>
      ),
    }
  },
})
