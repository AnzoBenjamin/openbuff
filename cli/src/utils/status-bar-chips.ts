import stringWidth from 'string-width'

import { formatElapsedTime } from './format-elapsed-time'

export type StatusBarChipId =
  | 'context'
  | 'index'
  | 'git'
  | 'model'
  | 'cost'
  | 'timer'

export type StatusBarChipTone = 'muted' | 'secondary' | 'warning' | 'error'

export type StatusBarChip = {
  id: StatusBarChipId
  label: string
  tone: StatusBarChipTone
}

export type StatusBarWidthSize = 'xs' | 'sm' | 'md' | 'lg'

export type SelectStatusBarChipsInput = {
  widthSize: StatusBarWidthSize
  terminalWidth: number
  contextWindowUsage?: { used: number; max: number } | null
  sessionCostCents?: number | null
  modelName?: string | null
  diffStats?: { modified: number; added: number; deleted: number } | null
  indexChip?: { label: string; tone: 'secondary' | 'warning' | 'error' } | null
  elapsedSeconds: number
  showTimer: boolean
  showStop: boolean
  isActive: boolean // waiting or streaming
}

const CHIP_ORDER: StatusBarChipId[] = [
  'context',
  'index',
  'git',
  'model',
  'cost',
  'timer',
]

const PROVIDER_PREFIX = /^(openai|anthropic|google|openrouter)\//

export function formatStatusTokenCount(tokens: number): string {
  if (tokens < 1_000) return Math.round(tokens).toString()
  if (tokens < 1_000_000) {
    const value = tokens / 1_000
    return `${value >= 100 ? Math.round(value) : value.toFixed(1).replace(/\.0$/, '')}k`
  }
  return `${(tokens / 1_000_000).toFixed(1).replace(/\.0$/, '')}m`
}

export function shortenStatusModelName(
  modelName: string,
  maxChars: number,
): string {
  const stripped = modelName.replace(PROVIDER_PREFIX, '')
  if (stripped.length <= maxChars) return stripped
  return `${stripped.slice(0, Math.max(0, maxChars - 1))}…`
}

const contextTone = (pct: number): StatusBarChipTone => {
  if (pct >= 90) return 'error'
  if (pct >= 70) return 'warning'
  return 'secondary'
}

const buildUsageBar = (pct: number, length: number): string => {
  const filled = Math.min(
    length,
    Math.max(0, Math.round((pct / 100) * length)),
  )
  return `${'█'.repeat(filled)}${'░'.repeat(length - filled)}`
}

const buildContextLabel = (
  widthSize: StatusBarWidthSize,
  used: number,
  max: number,
  pct: number,
): string => {
  if (widthSize === 'sm' || widthSize === 'xs') {
    return `${pct}%`
  }

  const barLength = widthSize === 'lg' ? 10 : 6
  const bar = buildUsageBar(pct, barLength)
  const percent = `${pct}%`

  if (widthSize === 'lg' && pct >= 70) {
    return `${formatStatusTokenCount(used)}/${formatStatusTokenCount(max)} ${bar} ${percent}`
  }

  return `${bar} ${percent}`
}

const formatCostLabel = (sessionCostCents: number): string => {
  const dollars = sessionCostCents / 100
  return dollars < 0.01
    ? `$${(sessionCostCents / 100).toFixed(4)}`
    : `$${dollars.toFixed(2)}`
}

const formatGitLabel = (diffStats: {
  modified: number
  added: number
  deleted: number
}): string | null => {
  const { modified, added, deleted } = diffStats
  if (modified + added + deleted <= 0) return null
  const parts: string[] = []
  if (modified > 0) parts.push(`~${modified}`)
  if (added > 0) parts.push(`+${added}`)
  if (deleted > 0) parts.push(`-${deleted}`)
  return parts.join(' ')
}

const modelMaxChars = (widthSize: StatusBarWidthSize): number => {
  if (widthSize === 'lg') return 16
  if (widthSize === 'md') return 12
  return 10
}

const clusterWidth = (chips: StatusBarChip[]): number => {
  if (chips.length === 0) return 0
  const labelsWidth = chips.reduce(
    (sum, chip) => sum + stringWidth(chip.label),
    0,
  )
  return labelsWidth + 3 * (chips.length - 1)
}

const removeChip = (
  chips: StatusBarChip[],
  id: StatusBarChipId,
): boolean => {
  const index = chips.findIndex((chip) => chip.id === id)
  if (index === -1) return false
  chips.splice(index, 1)
  return true
}

const sortChips = (chips: StatusBarChip[]): StatusBarChip[] =>
  [...chips].sort(
    (a, b) => CHIP_ORDER.indexOf(a.id) - CHIP_ORDER.indexOf(b.id),
  )

export function selectStatusBarChips(
  input: SelectStatusBarChipsInput,
): { chips: StatusBarChip[] } {
  const {
    widthSize,
    terminalWidth,
    contextWindowUsage,
    sessionCostCents,
    modelName,
    diffStats,
    indexChip,
    elapsedSeconds,
    showTimer,
    showStop,
    isActive,
  } = input

  const chips: StatusBarChip[] = []
  let contextPct: number | null = null

  const hasIndexError = indexChip?.tone === 'error'
  const omitContextForIndexError = widthSize === 'xs' && hasIndexError

  if (
    contextWindowUsage &&
    contextWindowUsage.max > 0 &&
    !omitContextForIndexError
  ) {
    contextPct = Math.round(
      (contextWindowUsage.used / contextWindowUsage.max) * 100,
    )
    chips.push({
      id: 'context',
      label: buildContextLabel(
        widthSize,
        contextWindowUsage.used,
        contextWindowUsage.max,
        contextPct,
      ),
      tone: contextTone(contextPct),
    })
  }

  if (indexChip) {
    chips.push({
      id: 'index',
      label: widthSize === 'xs' && hasIndexError ? 'idx!' : indexChip.label,
      tone: indexChip.tone,
    })
  }

  const gitLabel = diffStats ? formatGitLabel(diffStats) : null
  const allowGit =
    gitLabel != null &&
    widthSize !== 'xs' &&
    !(widthSize === 'sm' && indexChip != null)
  if (allowGit && gitLabel) {
    chips.push({ id: 'git', label: gitLabel, tone: 'secondary' })
  }

  if (modelName && (widthSize === 'lg' || widthSize === 'md')) {
    chips.push({
      id: 'model',
      label: shortenStatusModelName(modelName, modelMaxChars(widthSize)),
      tone: 'muted',
    })
  }

  if (
    widthSize === 'lg' &&
    sessionCostCents != null &&
    sessionCostCents !== 0
  ) {
    chips.push({
      id: 'cost',
      label: formatCostLabel(sessionCostCents),
      tone: 'muted',
    })
  }

  const allowTimer =
    showTimer &&
    elapsedSeconds > 0 &&
    !(widthSize === 'xs' && showStop)
  if (allowTimer) {
    chips.push({
      id: 'timer',
      label: formatElapsedTime(elapsedSeconds),
      tone: 'secondary',
    })
  }

  const budget = Math.max(8, Math.floor(terminalWidth * 0.4))
  const remaining = budget - (showStop ? 7 : 0)

  while (clusterWidth(chips) > remaining) {
    if (removeChip(chips, 'cost')) continue
    if (removeChip(chips, 'model')) continue
    if (removeChip(chips, 'git')) continue

    const contextChip = chips.find((chip) => chip.id === 'context')
    if (
      contextChip &&
      (contextChip.label.includes('█') || contextChip.label.includes('░')) &&
      contextPct != null
    ) {
      contextChip.label = `${contextPct}%`
      continue
    }

    if (!isActive && removeChip(chips, 'timer')) continue

    const hasIndexChip = chips.some((chip) => chip.id === 'index')
    if (contextChip && (hasIndexChip || showStop)) {
      removeChip(chips, 'context')
      continue
    }

    break
  }

  return { chips: sortChips(chips) }
}
