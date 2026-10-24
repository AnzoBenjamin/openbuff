import React from 'react'

import { useTheme } from '../../hooks/use-theme'
import { defineToolComponent } from './types'
import { wrapTextPreservingNewlines } from '../../utils/text-layout'

import type { ToolRenderConfig, ToolBlock } from './types'
import type { ChatTheme } from '../../types/theme-system'

/**
 * The human summary of a spawned agent's structured `set_output` receipt.
 *
 * Receipts are machine envelopes (`schemaVersion`, `snapshotFingerprint`,
 * `requirementCoverage`, …) carrying a small human core: a verdict/status, a
 * message or summary, and possibly findings. Before this renderer the whole
 * envelope reached the user as fenced raw JSON through the generic fallback;
 * this renders the core and demotes the envelope to a dim footer at most.
 */
type ReceiptCore = {
  /** LOOKS_GOOD / BLOCKED / success / partial / failed / cancelled / ... */
  outcome?: string
  outcomeKind: 'good' | 'warn' | 'bad' | 'neutral'
  message?: string
  findings: string[]
  coverage?: { satisfied: number; total: number }
  reviewedFileCount?: number
  footer?: string
}

const GOOD_OUTCOMES = new Set([
  'success',
  'succeeded',
  'looks_good',
  'pass',
  'passed',
  'completed',
  'ok',
])
const WARN_OUTCOMES = new Set(['partial', 'warning', 'needs_changes', 'retry'])
const BAD_OUTCOMES = new Set([
  'failed',
  'failure',
  'blocked',
  'error',
  'invalid',
  'cancelled',
  'unsupported',
])

function classifyOutcome(outcome: string | undefined): ReceiptCore['outcomeKind'] {
  if (!outcome) return 'neutral'
  const normalized = outcome.trim().toLowerCase().replace(/[\s-]+/g, '_')
  if (GOOD_OUTCOMES.has(normalized)) return 'good'
  if (WARN_OUTCOMES.has(normalized)) return 'warn'
  if (BAD_OUTCOMES.has(normalized)) return 'bad'
  return 'neutral'
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return undefined
}

function findingTitles(findings: unknown): string[] {
  if (!Array.isArray(findings)) return []
  const titles: string[] = []
  for (const finding of findings) {
    if (typeof finding === 'string') {
      if (finding.trim()) titles.push(finding.trim())
    } else if (finding && typeof finding === 'object') {
      const record = finding as Record<string, unknown>
      const title = firstString(
        record.title,
        record.summary,
        record.message,
        record.detail,
        record.description,
      )
      if (title) titles.push(title)
    }
    if (titles.length >= 5) break
  }
  return titles
}

/**
 * Distill the receipt envelope into the human core. Tolerant by design:
 * receipts vary per agent family (reviewer `verdict`/`dimensions`, dependency
 * manager `status`/`message`, generic `summary`), and anything unrecognized
 * still renders as a neutral one-liner rather than raw JSON.
 */
export function extractReceiptCore(input: unknown): ReceiptCore {
  let receipt: unknown = input
  // The tool input carries `{ data: <receipt> }`; `data` may be a JSON string
  // (models often emit it stringified) or the object itself. Also tolerate the
  // receipt handed to us directly.
  if (receipt && typeof receipt === 'object' && !Array.isArray(receipt)) {
    const data = (receipt as Record<string, unknown>).data
    if (typeof data === 'string') {
      try {
        receipt = JSON.parse(data)
      } catch {
        receipt = data
      }
    } else if (data !== undefined) {
      receipt = data
    }
  } else if (typeof receipt === 'string') {
    try {
      receipt = JSON.parse(receipt)
    } catch {
      // keep the raw string as the message
    }
  }

  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) {
    return {
      outcomeKind: 'neutral',
      message: typeof receipt === 'string' ? receipt : undefined,
      findings: [],
    }
  }

  const record = receipt as Record<string, unknown>
  const outcome = firstString(record.verdict, record.status, record.result)
  const message = firstString(
    record.message,
    record.summary,
    record.headline,
    record.detail,
  )
  const findings = findingTitles(record.findings)

  const coverageRaw = record.requirementCoverage
  let coverage: ReceiptCore['coverage']
  if (Array.isArray(coverageRaw)) {
    const satisfied = coverageRaw.filter(
      (entry) =>
        entry &&
        typeof entry === 'object' &&
        (entry as Record<string, unknown>).status === 'satisfied',
    ).length
    coverage = { satisfied, total: coverageRaw.length }
  }

  const reviewedFiles = record.reviewedFiles
  const reviewedFileCount = Array.isArray(reviewedFiles)
    ? reviewedFiles.length
    : undefined

  const footerParts: string[] = []
  if (typeof record.schemaVersion === 'number') {
    footerParts.push(`schema v${record.schemaVersion}`)
  }
  if (typeof record.snapshotFingerprint === 'string') {
    footerParts.push(`fp ${record.snapshotFingerprint.replace(/^v\d+:/, '').slice(0, 12)}`)
  }
  if (footerParts.length === 0 && typeof record.manager === 'string') {
    footerParts.push(record.manager)
  }

  return {
    outcome,
    outcomeKind: classifyOutcome(outcome),
    message,
    findings,
    coverage,
    reviewedFileCount,
    footer: footerParts.length > 0 ? footerParts.join(' · ') : undefined,
  }
}

const OUTCOME_GLYPH: Record<ReceiptCore['outcomeKind'], string> = {
  good: '✓',
  warn: '▲',
  bad: '✗',
  neutral: '•',
}

function outcomeColor(kind: ReceiptCore['outcomeKind'], theme: ChatTheme): string {
  switch (kind) {
    case 'good':
      return theme.success
    case 'warn':
      return theme.warning
    case 'bad':
      return theme.error
    default:
      return theme.muted
  }
}

/**
 * UI component for `set_output`: renders the receipt's human core (outcome,
 * message, findings, coverage) and never the raw envelope JSON.
 */
export const SetOutputComponent = defineToolComponent({
  toolName: 'set_output',

  render(
    toolBlock: ToolBlock & { toolName: 'set_output' },
    _theme: ChatTheme,
    options,
  ): ToolRenderConfig {
    const liveTheme = useTheme()
    const width = Math.max(20, options.availableWidth - 4)
    const core = extractReceiptCore(toolBlock.input)

    const headerParts = [
      OUTCOME_GLYPH[core.outcomeKind],
      core.outcome ? core.outcome : 'output set',
    ]
    const header = headerParts.join(' ')
    const color = outcomeColor(core.outcomeKind, liveTheme)

    const lines: React.ReactNode[] = []
    if (core.message) {
      lines.push(
        <text key="message" style={{ wrapMode: 'word' }}>
          <span fg={liveTheme.foreground}>
            {wrapTextPreservingNewlines(core.message, width)}
          </span>
        </text>,
      )
    }
    if (core.findings.length > 0) {
      lines.push(
        <text key="findings-count" style={{ wrapMode: 'word' }}>
          <span fg={liveTheme.muted}>
            {core.findings.length === 1
              ? '1 finding:'
              : `${core.findings.length} findings:`}
          </span>
        </text>,
      )
      core.findings.slice(0, 3).forEach((title, index) => {
        lines.push(
          <text key={`finding-${index}`} style={{ wrapMode: 'word' }}>
            <span fg={liveTheme.muted}>
              {wrapTextPreservingNewlines(`  ${title}`, width)}
            </span>
          </text>,
        )
      })
      if (core.findings.length > 3) {
        lines.push(
          <text key="findings-more" style={{ wrapMode: 'word' }}>
            <span fg={liveTheme.muted}>
              {`  … ${core.findings.length - 3} more`}
            </span>
          </text>,
        )
      }
    }
    const metaBits: string[] = []
    if (core.coverage) {
      metaBits.push(`requirements ${core.coverage.satisfied}/${core.coverage.total}`)
    }
    if (core.reviewedFileCount !== undefined) {
      metaBits.push(`${core.reviewedFileCount} file${core.reviewedFileCount === 1 ? '' : 's'} reviewed`)
    }
    if (core.footer) {
      metaBits.push(core.footer)
    }
    if (metaBits.length > 0) {
      lines.push(
        <text key="meta" style={{ wrapMode: 'word' }}>
          <span fg={liveTheme.muted}>{metaBits.join(' · ')}</span>
        </text>,
      )
    }

    const content =
      lines.length > 0 ? (
        <box style={{ flexDirection: 'column', gap: 0, width: '100%' }}>
          <text style={{ wrapMode: 'word' }}>
            <span fg={color}>{header}</span>
          </text>
          {lines}
        </box>
      ) : (
        <text style={{ wrapMode: 'word' }}>
          <span fg={color}>{header}</span>
        </text>
      )

    const previewMessage = core.message
      ? wrapTextPreservingNewlines(core.message, Math.max(20, width - 4))
        .split('\n')
        .filter((line) => line.trim())[0] ?? ''
      : ''
    return {
      content,
      collapsedPreview: previewMessage
        ? `${header} — ${previewMessage}`
        : header,
    }
  },
})
