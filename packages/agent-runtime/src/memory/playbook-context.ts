/** Pure, bounded rendering of complete applicable procedure records. */
import { MemoryPlaybookSchema } from '@codebuff/common/types/memory-playbook'
import {
  describePlaybookScope,
  isPlaybookApplicable,
} from '@codebuff/common/util/playbook-applicability'

import {
  describePlaybookTrigger,
  describeRequiredEvidence,
} from './playbook-gate'

import type { MemoryPlaybook } from '@codebuff/common/types/memory-playbook'
import type { PlaybookApplicabilityContext } from '@codebuff/common/util/playbook-applicability'

export const ACTIVE_PLAYBOOKS_CONTEXT_MAX_CHARS = 1_500
export const ACTIVE_PLAYBOOKS_CONTEXT_MAX_PLAYBOOKS = 8
export const ACTIVE_PLAYBOOKS_HEADER_MAX_CHARS = 400

export type CompileActivePlaybooksContextOptions = {
  maxChars?: number
  maxPlaybooks?: number
  applicability?: PlaybookApplicabilityContext
}

const WRAPPER_OPEN = '<active_playbooks>'
const WRAPPER_CLOSE = '</active_playbooks>'
const ENTRY_SEPARATOR = '\n---\n'
const HEADER = [
  'Enabled procedures for the acting agent. Required validation uses host-verified receipts, reusable across agents in the same task while dependencies are unchanged.',
  'Applicability, prerequisites and enforcement are complete below. Rule details or entries may be omitted for budget; the deterministic gate remains authoritative.',
].join(' ')

const compareCodePoints = (left: string, right: string): number => {
  const leftPoints = Array.from(left, (character) => character.codePointAt(0)!)
  const rightPoints = Array.from(
    right,
    (character) => character.codePointAt(0)!,
  )
  for (
    let index = 0;
    index < Math.min(leftPoints.length, rightPoints.length);
    index++
  ) {
    if (leftPoints[index] !== rightPoints[index])
      return leftPoints[index]! - rightPoints[index]!
  }
  return leftPoints.length - rightPoints.length
}

const boundedOption = (value: number | undefined, fallback: number): number =>
  value !== undefined && Number.isFinite(value)
    ? Math.max(0, Math.floor(value))
    : fallback

/** These lines form one indivisible record; none may be clipped. */
const renderConditions = (
  playbook: MemoryPlaybook,
  index: number,
  total: number,
): string =>
  [
    `[${index}/${total}] ${JSON.stringify(playbook.title)} (id=${playbook.playbookId})`,
    `Applies to: ${describePlaybookTrigger(playbook)}; ${describePlaybookScope(playbook)}`,
    `Enforcement: ${playbook.enforcement}; quality=${playbook.status}${playbook.expiresAt !== undefined ? `; expiresAt=${playbook.expiresAt}` : ''}`,
    `Required first: ${playbook.trigger.requireEvidence.length ? playbook.trigger.requireEvidence.map((evidence) => describeRequiredEvidence({ evidence, trigger: playbook.trigger })).join('; ') : 'none'}`,
  ].join('\n')

/**
 * Complete conditions get budget first. Instruction prose is included in full
 * or omitted in full: truncating an imperative could lose an exception embedded
 * in that prose. Entries too large for even their conditions are omitted whole.
 */
export function compileActivePlaybooksContext(
  playbooks: readonly unknown[],
  options: CompileActivePlaybooksContextOptions = {},
): string {
  const maxChars = boundedOption(
    options.maxChars,
    ACTIVE_PLAYBOOKS_CONTEXT_MAX_CHARS,
  )
  const maxPlaybooks = boundedOption(
    options.maxPlaybooks,
    ACTIVE_PLAYBOOKS_CONTEXT_MAX_PLAYBOOKS,
  )
  if (maxChars === 0 || maxPlaybooks === 0) return ''

  const applicable: MemoryPlaybook[] = []
  for (const candidate of playbooks) {
    const parsed = MemoryPlaybookSchema.safeParse(candidate)
    if (
      parsed.success &&
      isPlaybookApplicable(parsed.data, options.applicability)
    ) {
      applicable.push(parsed.data)
    }
  }
  const enforcementRank = { block: 0, warn: 1, 'inject-only': 2 }
  applicable.sort(
    (left, right) =>
      enforcementRank[left.enforcement] - enforcementRank[right.enforcement] ||
      Number(right.status === 'verified') -
        Number(left.status === 'verified') ||
      compareCodePoints(left.triggerSignature, right.triggerSignature) ||
      compareCodePoints(left.playbookId, right.playbookId),
  )

  const overhead =
    WRAPPER_OPEN.length + WRAPPER_CLOSE.length + HEADER.length + 3
  let remaining = maxChars - overhead
  const selected: MemoryPlaybook[] = []
  for (const playbook of applicable) {
    if (selected.length >= maxPlaybooks) break
    const conditions = renderConditions(
      playbook,
      selected.length + 1,
      maxPlaybooks,
    )
    const cost =
      conditions.length + (selected.length ? ENTRY_SEPARATOR.length : 0)
    if (cost > remaining) continue
    selected.push(playbook)
    remaining -= cost
  }
  if (selected.length === 0) return ''

  const entries = selected.map((playbook, index) =>
    renderConditions(playbook, index + 1, selected.length),
  )
  remaining = maxChars - overhead - entries.join(ENTRY_SEPARATOR).length
  for (let index = 0; index < selected.length; index++) {
    const fullDetail = `\nRule: ${selected[index]!.instruction}`
    const share = Math.floor(remaining / (selected.length - index))
    const detail =
      fullDetail.length <= share
        ? fullDetail
        : '\nRule detail omitted (context budget).'
    if (detail.length <= share) {
      entries[index] += detail
      remaining -= detail.length
    }
  }
  return [
    WRAPPER_OPEN,
    HEADER,
    entries.join(ENTRY_SEPARATOR),
    WRAPPER_CLOSE,
  ].join('\n')
}
