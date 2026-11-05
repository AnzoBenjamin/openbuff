import React from 'react'
import { classifyOutputOutcome } from '../../utils/output-outcome'

import { useTheme } from '../../hooks/use-theme'
import { defineToolComponent } from './types'
import { wrapTextPreservingNewlines } from '../../utils/text-layout'
import { capturedArtifacts } from '../../utils/output-artifact'
import { useOutputReaderStore } from '../../state/output-reader-store'
import { Button } from '../button'
import {
  getStructuredErrorMessages,
  getToolOutputRecords,
} from '../../utils/tool-result-normalizer'

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
  advisories: string[]
  coverage?: { satisfied: number; total: number }
  reviewedFileCount?: number
  footer?: string
  /**
   * Remaining human-meaningful scalar fields from the receipt, in emission
   * order. A generic agent's receipt often carries its actual result in
   * fields this renderer has no dedicated slot for (changed files, an id, a
   * duration). Without these rows the card degraded to a bare "output set"
   * glyph and dropped the content the caller returned.
   */
  fields: Array<{ label: string; value: string }>
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return undefined
}

function findingTitles(findings: unknown): string[] {
  if (typeof findings === 'string') {
    if (findings.length <= 500_000 && findings.trim().startsWith('[')) {
      try {
        const parsed = JSON.parse(findings)
        if (Array.isArray(parsed)) return findingTitles(parsed)
      } catch {
        // Show malformed or plain text as received.
      }
    }
    return findings.trim() ? [findings.trim()] : []
  }
  if (!Array.isArray(findings)) return []
  const titles: string[] = []
  for (const finding of findings) {
    if (typeof finding === 'string') {
      if (finding.trim()) titles.push(finding.trim())
    } else if (finding && typeof finding === 'object') {
      const record = finding as Record<string, unknown>
      const title = firstString(
        record.title,
        record.text,
        record.summary,
        record.message,
        record.detail,
        record.description,
      )
      if (title) {
        const severity = firstString(record.severity)
        const correction = firstString(record.correction)
        const evidence = Array.isArray(record.evidence)
          ? record.evidence.filter(
              (item): item is string =>
                typeof item === 'string' && !!item.trim(),
            )
          : []
        titles.push(
          [
            severity ? `${severity.toUpperCase()}: ${title}` : title,
            ...evidence.map((item) => `Evidence: ${item}`),
            ...(correction ? [`Fix: ${correction}`] : []),
          ].join('\n'),
        )
      }
    }
  }
  return titles
}

function receiptArray(value: unknown): unknown {
  if (
    typeof value !== 'string' ||
    value.length > 500_000 ||
    !value.trim().startsWith('[')
  )
    return value
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed : value
  } catch {
    return value
  }
}

function advisoryLines(value: unknown): string[] {
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value)
      if (Array.isArray(parsed)) return advisoryLines(parsed)
    } catch {
      // Keep ordinary advisory prose intact.
    }
    return value.trim() ? [value.trim()] : []
  }
  return Array.isArray(value)
    ? value
        .filter(
          (item): item is string => typeof item === 'string' && !!item.trim(),
        )
        .map((item) => item.trim())
    : []
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
      advisories: [],
      fields: [],
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

  const coverageRaw = receiptArray(record.requirementCoverage)
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

  const reviewedFiles = receiptArray(record.reviewedFiles)
  const reviewedFileCount = Array.isArray(reviewedFiles)
    ? reviewedFiles.length
    : undefined

  const footerParts: string[] = []
  if (typeof record.schemaVersion === 'number') {
    footerParts.push(`schema v${record.schemaVersion}`)
  }
  if (typeof record.snapshotFingerprint === 'string') {
    footerParts.push(
      `fp ${record.snapshotFingerprint.replace(/^v\d+:/, '').slice(0, 12)}`,
    )
  }
  if (footerParts.length === 0 && typeof record.manager === 'string') {
    footerParts.push(record.manager)
  }

  const consumed = new Set([
    'findings',
    'advisories',
    'reviewedFiles',
    'schemaVersion',
    'snapshotFingerprint',
    'manager',
  ])
  for (const key of ['verdict', 'status', 'result']) {
    if (typeof record[key] === 'string' && record[key] === outcome)
      consumed.add(key)
  }
  for (const key of ['message', 'summary', 'headline', 'detail']) {
    if (typeof record[key] === 'string' && record[key].trim() === message)
      consumed.add(key)
  }
  if (
    Array.isArray(coverageRaw) &&
    coverageRaw.every(
      (entry) =>
        entry &&
        typeof entry === 'object' &&
        (entry as Record<string, unknown>).status === 'satisfied',
    )
  )
    consumed.add('requirementCoverage')

  return {
    outcome,
    outcomeKind: classifyOutputOutcome(outcome),
    message,
    findings,
    advisories: advisoryLines(record.advisories),
    coverage,
    reviewedFileCount,
    footer: footerParts.length > 0 ? footerParts.join(' · ') : undefined,
    fields: receiptFields(record, consumed),
  }
}

/**
 * Render remaining receipt data as bounded, readable paths and values. Nested
 * records are common in reviewer dimensions and generic agent outputs.
 */
const MAX_RECEIPT_FIELDS = 24
function receiptFields(
  record: Record<string, unknown>,
  consumed: ReadonlySet<string>,
): Array<{ label: string; value: string }> {
  const fields: Array<{ label: string; value: string }> = []
  let omitted = 0
  const seen = new Set<object>()
  const visit = (label: string, value: unknown, depth: number): void => {
    if (fields.length >= MAX_RECEIPT_FIELDS) {
      omitted++
      return
    }
    if (value === null || value === undefined) return
    if (typeof value === 'string') {
      const trimmed = value.trim()
      if (!trimmed) return
      if (trimmed.length <= 500_000 && /^[\[{]/.test(trimmed)) {
        try {
          const parsed = JSON.parse(trimmed)
          if (parsed && typeof parsed === 'object') {
            visit(label, parsed, depth)
            return
          }
        } catch {
          // It is ordinary prose, not a complete serialized container.
        }
      }
      fields.push({ label, value: truncated(trimmed, 2000) })
      return
    }
    if (typeof value === 'boolean' || typeof value === 'number') {
      fields.push({
        label,
        value:
          typeof value === 'boolean' ? (value ? 'yes' : 'no') : String(value),
      })
      return
    }
    if (typeof value !== 'object') return
    if (seen.has(value)) {
      fields.push({ label, value: '[circular reference]' })
      return
    }
    if (depth >= 4) {
      fields.push({ label, value: '[nested details omitted]' })
      return
    }
    seen.add(value)
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index++) {
        if (fields.length >= MAX_RECEIPT_FIELDS) {
          omitted += value.length - index
          break
        }
        visit(`${label} ${index + 1}`, value[index], depth + 1)
      }
    } else {
      const entries = Object.entries(value)
      for (let index = 0; index < entries.length; index++) {
        if (fields.length >= MAX_RECEIPT_FIELDS) {
          omitted += entries.length - index
          break
        }
        const [key, item] = entries[index]
        visit(`${label} · ${humanLabel(key)}`, item, depth + 1)
      }
    }
    seen.delete(value)
  }
  for (const [key, value] of Object.entries(record)) {
    if (!consumed.has(key)) visit(humanLabel(key), value, 0)
  }
  if (omitted > 0)
    fields.push({
      label: 'more',
      value: `${omitted} additional entries omitted`,
    })
  return fields
}

function humanLabel(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/_/g, ' ')
    .toLowerCase()
}

function truncated(text: string, maxLength: number): string {
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 1)}…`
}

const OUTCOME_GLYPH: Record<ReceiptCore['outcomeKind'], string> = {
  good: '✓',
  warn: '▲',
  bad: '✗',
  neutral: '•',
}

function outcomeColor(
  kind: ReceiptCore['outcomeKind'],
  theme: ChatTheme,
): string {
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
    const errors = getStructuredErrorMessages(toolBlock.outputRaw)
    const ignored = getToolOutputRecords(toolBlock.outputRaw).find(
      (record) => record.status === 'ignored',
    )
    const salvage = getToolOutputRecords(toolBlock.outputRaw).find(
      (record) => record.salvaged === true,
    )
    const pending =
      toolBlock.lifecycle === 'queued' ||
      toolBlock.lifecycle === 'running' ||
      toolBlock.outputRaw === undefined
    const failed =
      toolBlock.lifecycle === 'failed' ||
      toolBlock.lifecycle === 'cancelled' ||
      errors.length > 0
    const failureMessage =
      errors.join('\n') || (failed ? toolBlock.output : undefined)
    const outcomeKind = failed
      ? 'bad'
      : ignored || salvage
        ? 'warn'
        : pending
          ? 'neutral'
          : core.outcomeKind

    const headerParts = [
      OUTCOME_GLYPH[outcomeKind],
      failed
        ? `output ${toolBlock.lifecycle === 'cancelled' ? 'cancelled' : 'failed'}`
        : ignored
          ? 'output ignored'
          : salvage
            ? 'output retained with limits'
            : pending
              ? 'output pending'
              : core.outcome
                ? core.outcome
                : 'output set',
    ]
    const header = headerParts.join(' ')
    const color = outcomeColor(outcomeKind, liveTheme)

    const lines: React.ReactNode[] = []
    if (salvage && typeof salvage.message === 'string' && !ignored) {
      lines.push(
        <text key="salvage" fg={liveTheme.warning} style={{ wrapMode: 'word' }}>
          {wrapTextPreservingNewlines(salvage.message, width)}
        </text>,
      )
    }
    if (salvage) {
      const artifacts = capturedArtifacts(toolBlock.outputRaw)
      artifacts.forEach((artifact, index) => {
        lines.push(
          <text key={`salvage-path-${index}`} fg={liveTheme.muted} style={{ wrapMode: 'word' }}>
            {`Recovery artifact: ${artifact.path}`}
          </text>,
          <Button id={`salvage-recovery-${toolBlock.toolCallId}-${index}`} key={`salvage-open-${index}`} onClick={() => useOutputReaderStore.getState().open({ documentId: `tool:${toolBlock.toolCallId}:artifact:${index}` })}>
            <text fg={liveTheme.primary}>Open recovery artifact</text>
          </Button>,
        )
      })
    }
    if (ignored && typeof ignored.message === 'string') {
      lines.push(
        <text key="ignored" style={{ wrapMode: 'word' }}>
          <span fg={liveTheme.muted}>
            {wrapTextPreservingNewlines(ignored.message, width)}
          </span>
        </text>,
      )
    }
    if (failureMessage) {
      lines.push(
        <text key="error" style={{ wrapMode: 'word' }}>
          <span fg={liveTheme.error}>
            {wrapTextPreservingNewlines(failureMessage, width)}
          </span>
        </text>,
      )
    }
    if (core.message && !ignored) {
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
      core.findings.slice(0, 12).forEach((title, index) => {
        lines.push(
          <text key={`finding-${index}`} style={{ wrapMode: 'word' }}>
            <span fg={liveTheme.muted}>
              {wrapTextPreservingNewlines(`  ${title}`, width)}
            </span>
          </text>,
        )
      })
      if (core.findings.length > 12) {
        lines.push(
          <text key="findings-more" style={{ wrapMode: 'word' }}>
            <span fg={liveTheme.muted}>
              {`  … ${core.findings.length - 12} more`}
            </span>
          </text>,
        )
      }
    }
    if (core.advisories.length > 0) {
      lines.push(
        <text key="advisories-label">
          <span fg={liveTheme.muted}>Advisories:</span>
        </text>,
      )
      core.advisories.slice(0, 12).forEach((advisory, index) => {
        lines.push(
          <text key={`advisory-${index}`} style={{ wrapMode: 'word' }}>
            <span fg={liveTheme.foreground}>
              {wrapTextPreservingNewlines(`  ${advisory}`, width)}
            </span>
          </text>,
        )
      })
      if (core.advisories.length > 12)
        lines.push(
          <text key="advisories-more">
            <span
              fg={liveTheme.muted}
            >{`  … ${core.advisories.length - 12} more`}</span>
          </text>,
        )
    }
    for (const field of core.fields) {
      lines.push(
        <text key={`field-${field.label}`} style={{ wrapMode: 'word' }}>
          <span fg={liveTheme.muted}>{`${field.label}: `}</span>
          <span fg={liveTheme.foreground}>
            {wrapTextPreservingNewlines(field.value, width)}
          </span>
        </text>,
      )
    }
    const metaBits: string[] = []
    if (core.coverage) {
      metaBits.push(
        `requirements ${core.coverage.satisfied}/${core.coverage.total}`,
      )
    }
    if (core.reviewedFileCount !== undefined) {
      metaBits.push(
        `${core.reviewedFileCount} file${core.reviewedFileCount === 1 ? '' : 's'} reviewed`,
      )
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

    const previewText = failureMessage || core.message
    const previewMessage = previewText
      ? (wrapTextPreservingNewlines(previewText, Math.max(20, width - 4))
          .split('\n')
          .filter((line) => line.trim())[0] ?? '')
      : ''
    return {
      content,
      collapsedPreview: previewMessage
        ? `${header} — ${previewMessage}`
        : header,
    }
  },
})
