import { useTheme } from '../../hooks/use-theme'
import {
  getStructuredErrorMessages,
  getToolOutputRecords,
} from '../../utils/tool-result-normalizer'
import { defineToolComponent } from './types'

const MAX_JOBS = 6

/**
 * Human-readable renderer for `list_jobs`. Handles both result shapes: the
 * full digest (`{ jobs, note, truncatedCount? }`) rendered as one
 * `jobId · status` line per job (plus pending/exit when present), and the
 * suppressed-digest shape (`{ unchanged: true, note }`) rendered as its note.
 * Guards every field access so an unexpected shape degrades gracefully.
 */
export const ListJobsComponent = defineToolComponent({
  toolName: 'list_jobs',
  render(toolBlock) {
    const theme = useTheme()
    const record = getToolOutputRecords(toolBlock.outputRaw)[0]
    const error = getStructuredErrorMessages(
      toolBlock.outputRaw ?? toolBlock.output,
    )[0]

    const jobsRaw = record?.jobs
    const jobs: unknown[] | undefined = Array.isArray(jobsRaw)
      ? jobsRaw
      : undefined
    const note = typeof record?.note === 'string' ? record.note : undefined

    // Suppressed-digest variant (or unexpected shape): no `jobs` array. Show
    // the suppression note (or error) as the whole summary.
    if (jobs === undefined) {
      const summary = error
        ? `Jobs failed · ${error}`
        : (note ?? 'No job digest')
      return {
        collapsedPreview: summary,
        content: (
          <box style={{ flexDirection: 'column', gap: 0, width: '100%' }}>
            <text fg={error ? theme.error : theme.muted}>{summary}</text>
          </box>
        ),
      }
    }

    const summary = `Jobs · ${jobs.length} captured${jobs.length > MAX_JOBS ? ` · showing ${MAX_JOBS} · Inspect for all rows` : ''}${typeof record?.truncatedCount === 'number' && record.truncatedCount > 0 ? ` · ${record.truncatedCount} producer entries omitted` : ''}${note ? ` · ${note}` : ''}`
    const shown = jobs.slice(0, MAX_JOBS)
    const moreCount = jobs.length - shown.length
    const truncatedCount =
      typeof record?.truncatedCount === 'number'
        ? record.truncatedCount
        : undefined

    return {
      collapsedPreview: summary,
      content: (
        <box style={{ flexDirection: 'column', gap: 0, width: '100%' }}>
          <text fg={theme.foreground}>{summary}</text>
          {shown.map((job, index) => {
            const entry = job as Record<string, unknown>
            const jobId = typeof entry?.jobId === 'string' ? entry.jobId : '?'
            const status =
              typeof entry?.status === 'string' ? entry.status : '?'
            const parts = [`${jobId} · ${status}`]
            if (typeof entry?.command === 'string')
              parts.push(entry.command.slice(0, 160))
            else if (typeof entry?.kind === 'string') parts.push(entry.kind)
            if (typeof entry?.error === 'string')
              parts.push(entry.error.slice(0, 160))
            if (typeof entry?.progress === 'string')
              parts.push(entry.progress.slice(0, 160))
            if (
              typeof entry?.pending === 'string' &&
              entry.pending !== 'none'
            ) {
              parts.push(`pending ${entry.pending}`)
            }
            if (entry?.exitCode !== undefined && entry.exitCode !== null) {
              parts.push(`exit ${String(entry.exitCode)}`)
            }
            return (
              <text key={index} fg={theme.muted}>
                {parts.join(' · ')}
              </text>
            )
          })}
          {moreCount > 0 ? (
            <text fg={theme.muted}>{`…${moreCount} more`}</text>
          ) : null}
          {truncatedCount ? (
            <text fg={theme.muted}>{`${truncatedCount} truncated`}</text>
          ) : null}
        </box>
      ),
    }
  },
})
