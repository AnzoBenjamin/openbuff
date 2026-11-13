import React from 'react'
import { classifyOutputOutcome } from '../../utils/output-outcome'
import { TextAttributes } from '@opentui/core'
import { ContentWithMarkdown } from '../blocks/content-with-markdown'
import { createMarkdownPalette } from '../../utils/theme-system'

import { useTheme } from '../../hooks/use-theme'
import { defineToolComponent } from './types'
import { extractReceiptCore } from './set-output'
import {
  getToolOutputValues,
  getStructuredErrorMessages,
} from '../../utils/tool-result-normalizer'
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

  const childValue =
    record.value &&
    typeof record.value === 'object' &&
    !Array.isArray(record.value)
      ? (record.value as Record<string, unknown>)
      : undefined
  if (childValue?.background === true) {
    return {
      name,
      glyph: '•',
      color: 'muted',
      detail: `launched${typeof childValue.jobId === 'string' ? ` · job ${childValue.jobId}` : ''} · completion available from job status`,
    }
  }

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
    record.value ??
      record.output ??
      record.result ??
      record.summary ??
      undefined,
  )
  const outcome =
    core.outcome ??
    (typeof receiptRecord?.status === 'string'
      ? receiptRecord.status
      : undefined)

  const errorMessage =
    receiptErrorMessage ?? getStructuredErrorMessages(record.value)[0]
  if (errorMessage) {
    return {
      name,
      glyph: '✗',
      color: 'error',
      detail: errorMessage,
    }
  }

  const kind = extractOutcomeKind(outcome)
  const message =
    core.message ??
    (typeof record.value === 'string'
      ? record.value
      : core.fields
          .map((field) => `${field.label}: ${field.value}`)
          .join(' · ') || undefined)
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
  const colors = {
    good: 'success',
    warn: 'warning',
    bad: 'error',
    neutral: 'muted',
  } as const
  return colors[classifyOutputOutcome(outcome)]
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

    const results = getToolOutputValues(toolBlock.outputRaw).flatMap((value) =>
      Array.isArray(value) ? value : [value],
    )
    const backgroundCount = results.filter((result) => {
      if (!result || typeof result !== 'object') return false
      const value = (result as Record<string, unknown>).value
      return (
        value &&
        typeof value === 'object' &&
        (value as Record<string, unknown>).background === true
      )
    }).length
    const count = agents.length
    const header =
      toolBlock.lifecycle === 'failed'
        ? `Agent spawn failed (${count})`
        : toolBlock.lifecycle === 'cancelled'
          ? `Agent spawn cancelled (${count})`
          : toolBlock.lifecycle === 'succeeded'
            ? backgroundCount === results.length && backgroundCount > 0
              ? `Agents launched (${count})`
              : backgroundCount > 0
                ? `Agent results (${count}) · ${backgroundCount} launched in background`
                : `Agents completed (${count})`
            : `Agents running (${count})`

    // Per-child verdict lines once results exist: the spawn result is an
    // array of per-agent records (agentType + receipt JSON), so the user can
    // see WHAT each child concluded without expanding every child branch.
    const summaries = results.map(summarizeSpawnResult)
    const width = Math.max(20, options.availableWidth - 4)

    const lines: React.ReactNode[] = []
    if (summaries.length > 0) {
      summaries.forEach((summary, index) => {
        const label = summary.detail
          ? `${summary.name} — ${wrapTextPreservingNewlines(summary.detail, width - 4).split('\n')[0] ?? ''}`
          : summary.name
        lines.push(
          summary.detail &&
            /(?:^#{1,6}\s|\*[^*\n]+\*|`[^`]+`|^[*+-]\s|^\d+\.\s|\[[^\]]+\]\()/m.test(
              summary.detail,
            ) ? (
            <box key={`child-${index}`} flexDirection="column" width="100%">
              <text>
                <span fg={theme[summary.color]}>{summary.glyph}</span>
                <span fg={theme.foreground} attributes={TextAttributes.BOLD}>
                  {' '}
                  {summary.name}
                </span>
              </text>
              <box
                paddingLeft={2}
                maxHeight={3}
                overflow="hidden"
                flexDirection="column"
              >
                <ContentWithMarkdown
                  content={summary.detail.slice(0, 2000)}
                  isStreaming={false}
                  eagerProse
                  codeBlockWidth={width - 2}
                  palette={createMarkdownPalette(theme)}
                />
              </box>
            </box>
          ) : (
            <text key={`child-${index}`} style={{ wrapMode: 'word' }}>
              <span fg={theme[summary.color]}>{summary.glyph}</span>
              <span fg={theme.foreground}> {label}</span>
            </text>
          ),
        )
        // Runtime reports retain the original requested-entry order. Keep
        // holes in that order and bind reasons to this child, including when
        // the same type was requested more than once.
        const result = results[index]
        const reasons =
          result && typeof result === 'object'
            ? (result as Record<string, unknown>).schedulingReasons
            : undefined
        if (Array.isArray(reasons)) {
          const schedulingReasons = reasons.filter(
            (reason): reason is string =>
              typeof reason === 'string' && reason.trim().length > 0,
          )
          if (schedulingReasons.length > 0) {
            const requested = agents[index]?.agent_type
            const identity = `request ${index + 1} · ${typeof requested === 'string' ? requested : summary.name}`
            lines.push(
              <text key={`scheduling-${index}`} style={{ wrapMode: 'word' }}>
                <span fg={theme.muted}>
                  {wrapTextPreservingNewlines(
                    `${identity}: ${schedulingReasons.join(' · ')}`,
                    width,
                  )}
                </span>
              </text>,
            )
          }
        }
      })
    } else {
      const names = agents
        .map((agent) => agent?.agent_type)
        .filter((name): name is string => typeof name === 'string')
        .map(shortAgentName)
      for (const [index, name] of names.slice(0, 6).entries()) {
        lines.push(
          <text key={`agent-${index}`} wrapMode="word">
            <span fg={theme.primary}>• </span>
            <span fg={theme.foreground}>{name}</span>
          </text>,
        )
      }
      if (names.length > 6)
        lines.push(
          <text key="remaining" fg={theme.muted}>
            {names.length - 6} more agents · expand their branches to follow
          </text>,
        )
      if (!names.length)
        lines.push(
          <text key="agent-list" fg={theme.muted}>
            Waiting for agent details
          </text>,
        )
    }

    const content = (
      <box style={{ flexDirection: 'column', gap: 0, width: '100%' }}>
        <text style={{ wrapMode: 'word' }}>
          <span
            fg={toolBlock.lifecycle === 'failed' ? theme.error : theme.primary}
            attributes={TextAttributes.BOLD}
          >
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
