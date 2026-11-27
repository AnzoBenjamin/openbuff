import {
  getStructuredErrorMessages,
  getToolOutputRecords,
} from '../../utils/tool-result-normalizer'
import { defineToolComponent } from './types'
import { InlineResults } from './inline-results'
import type { ToolName } from '@openbuff/sdk'

export function describeJobEvent(event: unknown): string {
  const record =
    event && typeof event === 'object'
      ? (event as Record<string, unknown>)
      : undefined
  const payload =
    record?.payload && typeof record.payload === 'object'
      ? (record.payload as Record<string, unknown>)
      : record
  const type = typeof payload?.type === 'string' ? payload.type : 'event'
  const text =
    typeof payload?.data === 'string'
      ? payload.data
      : typeof payload?.text === 'string'
        ? payload.text
        : typeof payload?.message === 'string'
          ? payload.message
          : ''
  const label =
    type === 'agent_chunk' && typeof payload?.chunkType === 'string'
      ? payload.chunkType
      : type
  return `${label}${text ? `: ${text.slice(0, 200).replace(/\s+/g, ' ')}${text.length > 200 ? '…' : ''}` : ''}`
}

function makeBackgroundJobComponent(
  toolName: Extract<ToolName, 'check_job' | 'read_logs' | 'kill_job'>,
  action: string,
) {
  return defineToolComponent({
    toolName,
    render(toolBlock, theme) {
      const input = toolBlock.input as Record<string, unknown> | undefined
      const record = getToolOutputRecords(toolBlock.outputRaw)[0]
      const error = getStructuredErrorMessages(
        toolBlock.outputRaw ?? toolBlock.output,
      )[0]
      const jobId = String(record?.jobId ?? input?.jobId ?? '')
      const status = String(
        record?.state ??
          record?.status ??
          (error
            ? 'failed'
            : toolBlock.lifecycle === 'queued' ||
                toolBlock.lifecycle === 'running'
              ? toolBlock.lifecycle
              : toolBlock.lifecycle === 'cancelled' ||
                  toolBlock.lifecycle === 'failed'
                ? toolBlock.lifecycle
                : 'output unavailable'),
      )
      const events = Array.isArray(record?.events) ? record.events : []
      const body =
        typeof record?.newOutput === 'string'
          ? record.newOutput
          : typeof record?.content === 'string'
            ? record.content
            : typeof record?.output === 'string'
              ? record.output
              : error
      const notices = [
        toolBlock.lifecycle === 'cancelled' && record?.state !== 'cancelled'
          ? 'observation cancelled; job state shown separately'
          : '',
        record?.timedOut === true
          ? 'wait timed out; job state shown separately'
          : '',
        record?.matched === true ? 'wait condition matched' : '',
        record?.truncated === true
          ? 'event capture truncated; more may exist'
          : '',
        typeof record?.dropped === 'number' && record.dropped > 0
          ? `${record.dropped} events dropped`
          : '',
      ].filter(Boolean)
      const summary = `${action}${jobId ? ` ${jobId}` : ''} · ${status}${record?.exitCode !== undefined ? ` · exit ${String(record.exitCode)}` : ''}${notices.length ? ` · ${notices.join(' · ')}` : ''}`
      return {
        collapsedPreview: summary,
        content: (
          <box style={{ flexDirection: 'column', gap: 0, width: '100%' }}>
            <text fg={error ? theme.error : theme.foreground}>{summary}</text>
            <InlineResults
              items={events}
              previewCount={4}
              noun="event"
              fromEnd
              renderItem={(event, index) => (
                <text key={index} fg={theme.muted}>
                  {describeJobEvent(event)}
                </text>
              )}
            />
            {body ? (
              <text fg={theme.muted}>
                {body.slice(0, 2000)}
                {body.length > 2000
                  ? '\nPreview limited · Inspect for full captured output'
                  : ''}
              </text>
            ) : null}
          </box>
        ),
      }
    },
  })
}
export const CheckJobComponent = makeBackgroundJobComponent(
  'check_job',
  'Check job',
)
export const ReadLogsComponent = makeBackgroundJobComponent(
  'read_logs',
  'Read logs',
)
export const KillJobComponent = makeBackgroundJobComponent(
  'kill_job',
  'Stop job',
)
