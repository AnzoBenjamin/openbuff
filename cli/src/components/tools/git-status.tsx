import { TextAttributes } from '@opentui/core'

import { useTheme } from '../../hooks/use-theme'
import { getToolOutputValues } from '../../utils/tool-result-normalizer'
import { DiffViewer } from './diff-viewer'
import { defineToolComponent } from './types'

import type { ToolRenderConfig } from './types'

type GitStatusOutput = {
  branch?: string
  status?: string
  diff?: string
  truncated?: boolean
  errorMessage?: string
}

export const GitStatusComponent = defineToolComponent({
  toolName: 'git_status',

  render(toolBlock, _theme, options): ToolRenderConfig {
    const theme = useTheme()
    const output = getToolOutputValues(toolBlock.outputRaw).find(
      (value): value is GitStatusOutput =>
        Boolean(value) && typeof value === 'object' && !Array.isArray(value),
    )
    const statusLines = output?.status
      ?.split('\n')
      .map((line) => line.trimEnd())
      .filter((line) => Boolean(line) && !line.startsWith('##'))
    const fileCount = statusLines?.length ?? 0
    const state =
      toolBlock.lifecycle === 'queued' ||
      toolBlock.lifecycle === 'running' ||
      toolBlock.lifecycle === 'cancelled' ||
      toolBlock.lifecycle === 'failed'
        ? toolBlock.lifecycle
        : output?.status !== undefined && !output.errorMessage
          ? fileCount === 0
            ? 'clean captured tree'
            : 'captured changes'
          : 'status unavailable'
    const diffFiles = output?.diff?.match(/^diff --git /gm)?.length ?? 0
    const title = output?.diff
      ? `Change review (${fileCount} file${fileCount === 1 ? '' : 's'})`
      : `Working tree (${fileCount} file${fileCount === 1 ? '' : 's'})`

    const summary = `${title} · ${state}${output?.diff ? ` · patches for ${diffFiles} files` : ''}${output?.truncated ? ' · diff truncated; more may exist' : ''}`
    return {
      collapsedPreview: output?.errorMessage ?? summary,
      content: (
        <box style={{ flexDirection: 'column', width: '100%' }}>
          <text>
            <span fg={theme.foreground} attributes={TextAttributes.BOLD}>
              {summary}
            </span>
            {output?.truncated ? (
              <span fg={theme.warning}> — diff truncated</span>
            ) : null}
          </text>
          {output?.branch ? (
            <text fg={theme.muted}>{`Branch: ${output.branch}`}</text>
          ) : null}
          {output?.diff && statusLines?.length ? (
            <text fg={theme.muted}>{statusLines.join('\n')}</text>
          ) : null}
          {output?.errorMessage ? (
            <text fg={theme.error}>{output.errorMessage}</text>
          ) : output?.diff ? (
            <DiffViewer
              diffText={output.diff}
              availableWidth={options.availableWidth}
              collapsible
              showLineNumbers
            />
          ) : (
            <text fg={theme.muted} style={{ wrapMode: 'word' }}>
              {statusLines?.join('\n') || state}
            </text>
          )}
        </box>
      ),
    }
  },
})
