import { useState } from 'react'

import { Button } from '../button'
import { SimpleToolCallItem } from './tool-call-item'
import { defineToolComponent } from './types'
import { useTheme } from '../../hooks/use-theme'
import {
  findToolResultByKind,
  getStructuredErrorMessages,
} from '../../utils/tool-result-normalizer'

import type { ToolRenderConfig } from './types'

type BlockSelector = { path: string; label: string }

const READ_BLOCKS_DIAGNOSTIC_MAX_ROWS = 20
const READ_BLOCKS_DIAGNOSTIC_MAX_MESSAGE_LINES = 6

function ReadBlocksDiagnostics({ outputRaw }: { outputRaw: unknown }) {
  const theme = useTheme()
  const [expanded, setExpanded] = useState(false)
  const result = findToolResultByKind(outputRaw, 'read_blocks_result')
  if (!result || !Array.isArray(result.results)) return null
  const rows = result.results as Array<Record<string, unknown>>
  const summary =
    result.summary && typeof result.summary === 'object'
      ? (result.summary as Record<string, unknown>)
      : null
  const visible = expanded
    ? rows
    : rows.slice(0, READ_BLOCKS_DIAGNOSTIC_MAX_ROWS)

  return (
    <box style={{ flexDirection: 'column', paddingLeft: 2, width: '100%' }}>
      {summary ? (
        <text fg={theme.muted}>
          {`${String(summary.ok ?? 0)}/${String(summary.requested ?? rows.length)} complete · ${String(summary.partial ?? 0)} partial · ${String(summary.failed ?? 0)} failed`}
        </text>
      ) : null}
      {visible.map((row, index) => {
        const error =
          row.error && typeof row.error === 'object'
            ? (row.error as Record<string, unknown>)
            : null
        const details = [
          row.status === 'error' ? error?.code : row.status,
          row.selector,
          row.selector === 'window'
            ? `win ${row.window ?? '?'} (${row.startLine ?? '?'}-${row.endLine ?? '?'})`
            : null,
          row.selector === 'around'
            ? `${row.startLine ?? '?'}-${row.endLine ?? '?'}`
            : null,
          row.selector === 'symbol' ? row.symbol : null,
          error?.retryable === true ? 'retryable' : null,
        ].filter(Boolean)
        const message = typeof error?.message === 'string' ? error.message : ''
        const messageLines = message.split('\n')
        const shownMessage = expanded
          ? message
          : messageLines
              .slice(0, READ_BLOCKS_DIAGNOSTIC_MAX_MESSAGE_LINES)
              .join('\n')
        return (
          <box
            key={`${String(row.path)}-${index}`}
            style={{ flexDirection: 'column' }}
          >
            <text fg={row.status === 'error' ? theme.error : theme.muted}>
              {`${row.status === 'error' ? '✗' : row.status === 'partial' ? '◐' : '✓'} ${String(row.path)} • ${details.join(' • ')}`}
            </text>
            {shownMessage ? (
              <text fg={theme.muted}>{shownMessage}</text>
            ) : null}
          </box>
        )
      })}
      {!expanded && rows.length > READ_BLOCKS_DIAGNOSTIC_MAX_ROWS ? (
        <text
          fg={theme.muted}
        >{`… ${rows.length - READ_BLOCKS_DIAGNOSTIC_MAX_ROWS} selector results hidden`}</text>
      ) : null}
      {rows.length > READ_BLOCKS_DIAGNOSTIC_MAX_ROWS ||
      getStructuredErrorMessages(outputRaw).some(
        (message) =>
          message.split('\n').length > READ_BLOCKS_DIAGNOSTIC_MAX_MESSAGE_LINES,
      ) ? (
        <Button onClick={() => setExpanded((value) => !value)}>
          <text fg={theme.muted}>
            {expanded ? 'Show less' : 'Show details'}
          </text>
        </Button>
      ) : null}
    </box>
  )
}

function getBlockSelectors(input: unknown): BlockSelector[] {
  if (!input || typeof input !== 'object') return []
  const record = input as Record<string, unknown>
  const selectors: BlockSelector[] = []

  for (const win of Array.isArray(record.windows) ? record.windows : []) {
    if (!win || typeof win !== 'object') continue
    const value = win as Record<string, unknown>
    if (typeof value.path !== 'string' || !value.path.trim()) continue
    const windowIndex = typeof value.window === 'number' ? value.window : 1
    selectors.push({
      path: value.path.trim(),
      label: `${value.path.trim()}:win ${windowIndex}`,
    })
  }
  for (const around of Array.isArray(record.around) ? record.around : []) {
    if (!around || typeof around !== 'object') continue
    const value = around as Record<string, unknown>
    if (typeof value.path !== 'string' || !value.path.trim()) continue
    const match = typeof value.match === 'string' ? value.match : ''
    selectors.push({
      path: value.path.trim(),
      label: `${value.path.trim()}@"${match}"`,
    })
  }
  for (const symbol of Array.isArray(record.symbols) ? record.symbols : []) {
    if (!symbol || typeof symbol !== 'object') continue
    const value = symbol as Record<string, unknown>
    if (typeof value.path !== 'string' || !value.path.trim()) continue
    const name = typeof value.name === 'string' ? value.name : ''
    selectors.push({
      path: value.path.trim(),
      label: `${value.path.trim()}#${name}`,
    })
  }
  return selectors.filter(
    (selector, index) =>
      selectors.findIndex((candidate) => candidate.label === selector.label) ===
      index,
  )
}

function getReadBlocksStatus(toolBlock: {
  outputRaw?: unknown
  output?: unknown
  queued?: boolean
  lifecycle?: string
}): 'queued' | 'pending' | 'read' | 'partial' | 'failed' {
  if (toolBlock.lifecycle === 'cancelled') return 'failed'
  if (toolBlock.lifecycle === 'failed') return 'failed'
  const hasOutput =
    toolBlock.outputRaw !== undefined ||
    (typeof toolBlock.output === 'string' && toolBlock.output.trim().length > 0)
  if (!hasOutput) return toolBlock.queued === true ? 'queued' : 'pending'

  const rawValues =
    toolBlock.outputRaw === undefined
      ? [toolBlock.output]
      : Array.isArray(toolBlock.outputRaw)
        ? toolBlock.outputRaw.map((part) =>
            part && typeof part === 'object' && 'value' in part
              ? (part as { value?: unknown }).value
              : part,
          )
        : [toolBlock.outputRaw]

  for (const value of rawValues) {
    if (
      value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      (value as Record<string, unknown>).kind === 'read_blocks_result'
    ) {
      const canonical = value as Record<string, unknown>
      if (canonical.version !== 1) return 'failed'
      if (canonical.status === 'ok') return 'read'
      if (canonical.status === 'partial') return 'partial'
      return 'failed'
    }
  }
  return 'pending'
}

/**
 * UI component for read_blocks tool.
 * Displays selector labels for windowed, content-anchored, and symbol reads.
 */
export const ReadBlocksComponent = defineToolComponent({
  toolName: 'read_blocks',

  render(toolBlock): ToolRenderConfig {
    const selectors = getBlockSelectors(toolBlock.input)

    if (selectors.length === 0) {
      return { content: null }
    }
    const status = getReadBlocksStatus(toolBlock)

    return {
      content: (
        <box style={{ flexDirection: 'column', width: '100%' }}>
          <SimpleToolCallItem
            name={
              toolBlock.lifecycle === 'cancelled'
                ? 'Read cancelled'
                : status === 'read'
                  ? 'Read'
                  : `Read ${status}`
            }
            description={selectors.map(({ label }) => label).join(', ')}
          />
          <ReadBlocksDiagnostics outputRaw={toolBlock.outputRaw} />
        </box>
      ),
    }
  },
})
