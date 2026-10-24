import React from 'react'
import { TextAttributes } from '@opentui/core'

import { useTheme } from '../../hooks/use-theme'
import { defineToolComponent } from './types'
import { extractReceiptCore } from './set-output'
import { wrapTextPreservingNewlines } from '../../utils/text-layout'

import type { ToolRenderConfig, ToolBlock } from './types'
import type { ChatTheme } from '../../types/theme-system'

/** One spawned child, distilled from its spawn result record for display. */
type ChildSummary = {
  name: string
  glyph: string
  color: 'success' | 'warning' | 'error' | 'muted'
  detail?: string
}

function shortAgentName(agentType: string): string {
  const withoutVersion = agentType.split('@')[0] ?? agentType
  const parts = withoutVersion.split('/')
  return parts[parts.length - 1] ?? agentType
}

const CHILD_GLYPHS: Record<ChildSummary['color'], string> = {
  success: '✓',
  warning: '▲',
  error: '✗',
  muted: '•',
}

/**
 * Distill one spawn result record into a display line. The records are
 * free-form per agent family (`agentType` plus arbitrary receipt JSON), so
 * every field read is optional and anything unrecognized degrades to a
 * neutral `name — completed` line rather than raw JSON.
 */
export function summarizeSpawnResult(result: unknown): ChildSummary {
  const base: ChildSummary = { name: 'agent', glyph: '•', color: 'muted' }
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    return base
  }
  const record = result as Record<string, unknown>
  const name =
    typeof record.agentType === 'string' && record.agentType.trim()
      ? shortAgentName(record.agentType)
      : 'agent'

  const receipt = record.agentReceipt
  const receiptRecord =
    receipt && typeof receipt === 'object' && !Array.isArray(receipt)
      ? (receipt as Record<string, unknown>)
      : undefined
  const receiptErrors = receiptRecord?.errors
  const receiptError = Array.isArray(receiptErrors)
    ? receiptErrors.find(
        (entry) =>
          entry &&
          typeof entry === 'object' &&
          typeof (entry as Record<string, unknown>).message === 'string',
      )
    : undefined
  const receiptErrorMessage =
    receiptError &&
    typeof (receiptError as Record<string, unknown>).message === 'string'
      ? ((receiptError as Record<string, unknown>).message as string)
      : undefined

  // The child's own set_output receipt (the human core) rides on the record
  // for structured-output children; verdict/status/message can sit at either
  // level.
  const core = extractReceiptCore(
    record.output ?? record.result ?? record.summary ?? undefined,
  )
  const outcome =
    core.outcome ??
    (typeof receiptRecord?.status === 'string'
      ? receiptRecord.status
      : undefined)

  if (receiptErrorMessage) {
    return {
      name,
      glyph: '✗',
      color: 'error',
      detail: receiptErrorMessage,
    }
  }

  const kind = extractOutcomeKind(outcome)
  const message = core.message
  return {
    name,
    glyph: CHILD_GLYPHS[kind],
    color: kind,
    detail: message,
  }
}

function extractOutcomeKind(
  outcome: string | undefined,
): ChildSummary['color'] {
  if (!outcome) return 'muted'
  const normalized = outcome.trim().toLowerCase().replace(/[\s-]+/g, '_')
  if (['success', 'succeeded', 'looks_good', 'pass', 'passed', 'completed', 'ok'].includes(normalized)) {
    return 'success'
  }
  if (['partial', 'warning', 'needs_changes', 'retry'].includes(normalized)) {
    return 'warning'
  }
  if (['failed', 'blocked', 'error', 'invalid', 'cancelled', 'unsupported'].includes(normalized)) {
    return 'error'
  }
  return 'muted'
}

/** UI component for any spawn_agents call, regardless of agent role. */
export const SpawnAgentsComponent = defineToolComponent({
  toolName: 'spawn_agents',

  render(
    toolBlock: ToolBlock & { toolName: 'spawn_agents' },
    _theme: ChatTheme,
    options,
  ): ToolRenderConfig {
    const theme = useTheme()
    const input = toolBlock.input as
      | { agents?: Array<{ agent_type?: string; prompt?: string }> }
      | undefined
    const agents = Array.isArray(input?.agents) ? input!.agents : []

    const count = agents.length
    const header =
      toolBlock.lifecycle === 'failed'
        ? `Agent spawn failed (${count})`
        : toolBlock.lifecycle === 'cancelled'
          ? `Agent spawn cancelled (${count})`
          : toolBlock.lifecycle === 'succeeded'
            ? `Agents completed (${count})`
            : `Agents running (${count})`

    // Per-child verdict lines once results exist: the spawn result is an
    // array of per-agent records (agentType + receipt JSON), so the user can
    // see WHAT each child concluded without expanding every child branch.
    const results = Array.isArray(toolBlock.outputRaw)
      ? (toolBlock.outputRaw as unknown[])
      : []
    const summaries = results.map(summarizeSpawnResult)
    const width = Math.max(20, options.availableWidth - 4)

    const lines: React.ReactNode[] = []
    if (summaries.length > 0) {
      summaries.forEach((summary, index) => {
        const label = summary.detail
          ? `${summary.name} — ${wrapTextPreservingNewlines(summary.detail, width - 4).split('\n')[0] ?? ''}`
          : summary.name
        lines.push(
          <text key={`child-${index}`} style={{ wrapMode: 'word' }}>
            <span fg={theme[summary.color]}>{summary.glyph}</span>
            <span fg={theme.foreground}> {label}</span>
          </text>,
        )
      })
    } else {
      const body =
        agents
          .map((a) => a?.agent_type)
          .filter((t): t is string => typeof t === 'string')
          .map(shortAgentName)
          .join(', ') || 'agents'
      lines.push(
        <text key="agent-list" style={{ wrapMode: 'word' }}>
          <span fg={theme.muted}>{body}</span>
        </text>,
      )
    }

    const content = (
      <box style={{ flexDirection: 'column', gap: 0, width: '100%' }}>
        <text style={{ wrapMode: 'word' }}>
          <span fg={theme.foreground} attributes={TextAttributes.BOLD}>
            {header}
          </span>
        </text>
        {lines}
      </box>
    )

    return {
      content,
      collapsedPreview:
        summaries.length > 0
          ? `${header} — ${summaries.map((s) => s.glyph).join(' ')}`
          : header,
    }
  },
})
