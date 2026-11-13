/**
 * Active-playbooks prompt band (memory playbook Phase 2).
 *
 * Compiles the session's installed playbooks into one bounded, deterministic
 * block of trusted instruction text injected ahead of each model request —
 * the injection channel of the playbook system, and the ONLY channel an
 * `inject-only` playbook has. Invariants:
 *
 *  - Pure: no clock, no I/O, no Date.now. Expiry is deliberately never
 *    re-checked here; the deterministic gate (./playbook-gate.ts) is the sole
 *    expiry authority, and this band mirrors its status filter exactly
 *    ('active' only).
 *  - Security boundary: every entry is validated with MemoryPlaybookSchema and
 *    schema-invalid entries are DROPPED, never repaired. The band vouches for
 *    its content as operator-authored instruction, so nothing that fails the
 *    schema may be vouched.
 *  - Determinism: entries are ordered by code-point comparison over
 *    (triggerSignature, playbookId), so any permutation of the same set
 *    compiles byte-identical text.
 *  - Bounded: the compiled text never exceeds maxChars (default 1_500) and
 *    never renders more than maxPlaybooks (default 8) entries; a clipped
 *    entry always carries an explicit ...[truncated] marker.
 *  - Trusted framing: this band is the deliberate opposite of the memory-v2
 *    retrieval banner — operator-authored rules to FOLLOW, not evidence to
 *    weigh.
 */
import { MemoryPlaybookSchema } from '@codebuff/common/types/memory-playbook'

import {
  describePlaybookTrigger,
  describeRequiredEvidence,
} from './playbook-gate'

import type { MemoryPlaybook } from '@codebuff/common/types/memory-playbook'

export const ACTIVE_PLAYBOOKS_CONTEXT_MAX_CHARS = 1_500
export const ACTIVE_PLAYBOOKS_CONTEXT_MAX_PLAYBOOKS = 8
export const ACTIVE_PLAYBOOKS_HEADER_MAX_CHARS = 400

export type CompileActivePlaybooksContextOptions = {
  maxChars?: number
  maxPlaybooks?: number
}

const ACTIVE_PLAYBOOKS_WRAPPER_OPEN = '<active_playbooks>'
const ACTIVE_PLAYBOOKS_WRAPPER_CLOSE = '</active_playbooks>'
const ACTIVE_PLAYBOOKS_ENTRY_SEPARATOR = '\n---\n'

// Code-point comparison (mirroring memory-v2-context.ts, kept local so this
// module never imports across util boundaries): a plain < / > string compare
// would make the sort locale- and code-unit-dependent.
const compareCodePoints = (left: string, right: string): number => {
  const leftPoints = Array.from(left, (character) => character.codePointAt(0)!)
  const rightPoints = Array.from(
    right,
    (character) => character.codePointAt(0)!,
  )
  const length = Math.min(leftPoints.length, rightPoints.length)
  for (let index = 0; index < length; index++) {
    if (leftPoints[index] !== rightPoints[index]) {
      return leftPoints[index]! - rightPoints[index]!
    }
  }
  return leftPoints.length - rightPoints.length
}

// Explicit clip marker (the task-memory.ts boundText convention): a clipped
// value is always visibly clipped, never silently cut mid-word.
const clipped = (value: string, maxChars: number): string => {
  if (value.length <= maxChars) return value
  if (maxChars <= 24) return value.slice(0, maxChars)
  return `${value.slice(0, maxChars - 15)}...[truncated]`
}

/**
 * Frozen header semantics. These rules are trusted, operator-authored
 * procedure (the coordinator vouches for them), so they are instructions to
 * follow — never evidence to weigh. The header names the enforcement surface
 * (the deterministic gate), tells the model to pre-satisfy each requirement
 * with a real tool call of its own BEFORE the gated call, and closes the
 * subagent loophole: a subagent's tool runs are invisible to the gate's
 * session evidence ledger, so the required call must be run by this agent.
 */
const ACTIVE_PLAYBOOKS_HEADER = [
  'Active operator playbooks: trusted, operator-authored rules to follow, not evidence to weigh.',
  'A deterministic gate enforces them on spawn_agents, spawn_agent_inline, and run_terminal_command.',
  "Satisfy each rule's requirement FIRST with a real tool call of your own before the gated call; a subagent's runs are not visible to this gate, so run it yourself, not via a subagent.",
].join(' ')

// Fixed per-entry line order: index header, the rule itself, the trigger it
// applies to, and the evidence the gate requires first. The trigger and
// evidence lines reuse the gate's own describe helpers so the band and the
// verdict message describe the same rule in the same words.
const renderEntry = (
  playbook: MemoryPlaybook,
  index: number,
  total: number,
): string =>
  [
    `[${index}/${total}] "${playbook.title}"`,
    `Rule: ${playbook.instruction}`,
    `Applies to: ${describePlaybookTrigger(playbook)}`,
    `Required first: ${playbook.trigger.requireEvidence
      .map((evidence) =>
        describeRequiredEvidence({ evidence, trigger: playbook.trigger }),
      )
      .join('; ')}`,
  ].join('\n')

/**
 * Compile the active playbooks into the bounded <active_playbooks> band.
 * Returns '' when nothing renders (no valid active playbooks, an empty set,
 * or a zero budget) so callers can skip the message entirely.
 */
export function compileActivePlaybooksContext(
  playbooks: readonly unknown[],
  options: CompileActivePlaybooksContextOptions = {},
): string {
  const maxChars = Math.max(
    0,
    Math.floor(options.maxChars ?? ACTIVE_PLAYBOOKS_CONTEXT_MAX_CHARS),
  )
  const maxPlaybooks = Math.max(
    0,
    Math.floor(options.maxPlaybooks ?? ACTIVE_PLAYBOOKS_CONTEXT_MAX_PLAYBOOKS),
  )

  // (a)+(b) Schema-validate every entry and keep only ACTIVE rules. The band
  // vouches for its content as operator-authored, so nothing schema-invalid
  // may be vouched — invalid entries are dropped. Expiry is deliberately NOT
  // re-checked here: this function is pure (no clock) and the gate is the
  // sole expiry authority.
  const active: MemoryPlaybook[] = []
  for (const candidate of playbooks) {
    const parsed = MemoryPlaybookSchema.safeParse(candidate)
    if (!parsed.success) continue
    if (parsed.data.status !== 'active') continue
    active.push(parsed.data)
  }

  // (c) Deterministic order: code-point sort by triggerSignature, then
  // playbookId as the tie-break, so any permutation of the same set compiles
  // byte-identical text.
  active.sort(
    (left, right) =>
      compareCodePoints(left.triggerSignature, right.triggerSignature) ||
      compareCodePoints(left.playbookId, right.playbookId),
  )

  // (d) Bounded selection: the lowest-signature rules win the slots.
  const selected = active.slice(0, maxPlaybooks)
  if (selected.length === 0 || maxChars <= 0) return ''

  const header = clipped(
    ACTIVE_PLAYBOOKS_HEADER,
    ACTIVE_PLAYBOOKS_HEADER_MAX_CHARS,
  )
  // (e) Equal shares: after the wrapper, the header, and the inter-entry
  // separators are reserved, every selected playbook gets the same
  // floor-sized slice of what remains. Math.max(1, ...) keeps degenerate
  // budgets (tiny maxChars options) from producing zero or negative slice
  // math; the final clip below still holds the cap.
  const entryCount = selected.length
  const overhead =
    ACTIVE_PLAYBOOKS_WRAPPER_OPEN.length +
    1 + // newline after the open tag
    header.length +
    1 + // newline between the header and the first entry
    (entryCount - 1) * ACTIVE_PLAYBOOKS_ENTRY_SEPARATOR.length +
    1 + // newline before the close tag
    ACTIVE_PLAYBOOKS_WRAPPER_CLOSE.length
  const entryShare = Math.max(1, Math.floor((maxChars - overhead) / entryCount))

  const body = selected
    .map((playbook, index) =>
      clipped(renderEntry(playbook, index + 1, entryCount), entryShare),
    )
    .join(ACTIVE_PLAYBOOKS_ENTRY_SEPARATOR)

  // (f) Belt-and-braces: the share math already holds the cap by construction;
  // this final clip guarantees it even for degenerate option values.
  return clipped(
    [
      ACTIVE_PLAYBOOKS_WRAPPER_OPEN,
      header,
      body,
      ACTIVE_PLAYBOOKS_WRAPPER_CLOSE,
    ].join('\n'),
    maxChars,
  )
}
