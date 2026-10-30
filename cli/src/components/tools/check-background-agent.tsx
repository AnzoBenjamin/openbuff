import { useTheme } from '../../hooks/use-theme'
import {
  getStructuredErrorMessages,
  getToolOutputRecords,
} from '../../utils/tool-result-normalizer'
import { defineToolComponent } from './types'

const MAX_EVENTS = 4
const TEXT_CHARS = 160

/** Collapse whitespace and bound a value for a single compact detail line. */
function trimText(value: string): string {
  const collapsed = value.replace(/\s+/g, ' ').trim()
  return collapsed.length > TEXT_CHARS
    ? collapsed.slice(0, TEXT_CHARS) + '…'
    : collapsed
}

/** One-line description of a buffered background-agent event. */
function describeEvent(event: unknown): string {
  const entry = event as Record<string, unknown>
  const payload = entry?.payload as Record<string, unknown> | undefined
  const type = typeof payload?.type === 'string' ? payload.type : 'event'
  if (type === 'output') {
    const data = typeof payload?.data === 'string' ? trimText(payload.data) : ''
    return data ? `output: ${data}` : 'output'
  }
  if (type === 'agent_chunk') {
    const chunkType =
      typeof payload?.chunkType === 'string' ? payload.chunkType : 'chunk'
    return `chunk: ${chunkType}`
  }
  if (type === 'lifecycle') {
    const state = typeof payload?.state === 'string' ? payload.state : ''
    return state ? `lifecycle: ${state}` : 'lifecycle'
  }
  if (type === 'status') {
    const message = typeof payload?.message === 'string' ? payload.message : ''
    return message ? `status: ${trimText(message)}` : 'status'
  }
  return type
}

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
          : 'pending'
    const summary = `Agent${jobId ? ` ${jobId}` : ''} · ${state}`

    const eventsRaw = record?.events
    const events: unknown[] = Array.isArray(eventsRaw) ? eventsRaw : []
    const tail = events.slice(-MAX_EVENTS)

    const result = record?.result
    const resultText =
      result !== undefined && result !== null
        ? trimText(typeof result === 'string' ? result : JSON.stringify(result))
        : undefined

    return {
      collapsedPreview: summary,
      content: (
        <box style={{ flexDirection: 'column', gap: 0, width: '100%' }}>
          <text fg={error ? theme.error : theme.foreground}>{summary}</text>
          {error ? <text fg={theme.error}>{error}</text> : null}
          {tail.map((event, index) => (
            <text key={index} fg={theme.muted}>
              {describeEvent(event)}
            </text>
          ))}
          {resultText ? (
            <text fg={theme.muted}>{`result: ${resultText}`}</text>
          ) : null}
        </box>
      ),
    }
  },
})
