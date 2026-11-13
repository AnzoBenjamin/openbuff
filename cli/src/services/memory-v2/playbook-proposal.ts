import { z } from 'zod/v4'

import {
  PlaybookScopeSchema,
  PlaybookTriggerSchema,
} from '../../../../common/src/types/memory-playbook'

/**
 * Length limits copied EXACTLY from MemoryPlaybookSchema
 * (common/src/types/memory-playbook.ts): the store re-validates the
 * assembled playbook row through that schema before every write, so a
 * proposal parsed at looser limits would die inside the store with a raw
 * zod error instead of this module's clean, bounded validation errors.
 */
export const PROPOSAL_TITLE_MAX_CHARS = 200
export const PROPOSAL_INSTRUCTION_MAX_CHARS = 4_096

/** Bounded issue render: at most this many zod issue messages are listed. */
const PROPOSAL_ISSUES_SHOWN = 3
/** Per-message cap: zod messages are short; this bounds adversarial input. */
const PROPOSAL_ISSUE_MESSAGE_MAX_CHARS = 160

/**
 * A contained JSON proposal file for `/memory playbooks propose` — the
 * operator-authored input for a Phase-4 shadow candidate. Strict on
 * purpose: an unknown key is rejected rather than ignored, so the file can
 * never smuggle the fields the command itself owns (status, enforcement,
 * counters, provenance). The trigger and scope reuse the store's own
 * schemas, so every proposal that parses here assembles a store-valid
 * upsert, and a non-evaluable trigger fails here with a clean error
 * instead of at the store.
 */
export const PlaybookProposalSchema = z.strictObject({
  title: z.string().min(1).max(PROPOSAL_TITLE_MAX_CHARS),
  instruction: z.string().min(1).max(PROPOSAL_INSTRUCTION_MAX_CHARS),
  trigger: PlaybookTriggerSchema,
  scope: PlaybookScopeSchema.default({ repos: [] }),
  expiresAt: z.number().int().positive().optional(),
})
export type PlaybookProposal = z.infer<typeof PlaybookProposalSchema>

/**
 * Clean, bounded validation failure for a schema-invalid proposal: the
 * message lists the issue count and the first few zod issue messages
 * (truncated) — never zod's raw multi-line dump, which grows with the
 * input, and never the proposal's field values.
 */
export class PlaybookProposalError extends Error {
  readonly issues: readonly string[]
  constructor(issues: readonly string[]) {
    super(renderProposalIssues(issues))
    this.name = 'PlaybookProposalError'
    this.issues = issues
  }
}

function renderProposalIssues(issues: readonly string[]): string {
  const shown = issues
    .slice(0, PROPOSAL_ISSUES_SHOWN)
    .map((message) => message.slice(0, PROPOSAL_ISSUE_MESSAGE_MAX_CHARS))
    .join('; ')
  const hidden = issues.length - PROPOSAL_ISSUES_SHOWN
  return `The proposal failed validation with ${issues.length} issue(s): ${shown}${hidden > 0 ? ` (+${hidden} more)` : ''}`
}

/**
 * Parse an untrusted proposal body, throwing a clean, bounded
 * {@link PlaybookProposalError} on schema failure.
 */
export function parsePlaybookProposal(raw: unknown): PlaybookProposal {
  const parsed = PlaybookProposalSchema.safeParse(raw)
  if (parsed.success) return parsed.data
  throw new PlaybookProposalError(
    parsed.error.issues.map((issue) => issue.message),
  )
}

/**
 * The canonical proposal-state render for `/memory playbooks propose` — the
 * exact preview lines the command shows, kept beside the schema so what is
 * rendered can never drift from what is validated: one render, beside the
 * schema, used by the command. The command owns only the framing lines
 * around these (signature, would-create-or-update, preview-only note) and
 * never rebuilds these lines inline. `expiresAt` here is the EFFECTIVE
 * expiry the apply write would persist — the proposal's own expiry, or the
 * existing same-signature row's preserved expiry when the proposal omits
 * one — so the preview always shows the state a write would produce, never
 * a proposal-only view.
 */
export function renderPlaybookProposalLines(
  proposal: PlaybookProposal,
): string[] {
  const { title, instruction, trigger, scope, expiresAt } = proposal
  return [
    `Proposal: ${title}.`,
    `Instruction: ${instruction}.`,
    `Trigger: ${trigger.tool}${trigger.spawnAgentType ? ` ${trigger.spawnAgentType}` : ''}${trigger.terminalAction ? ` ${trigger.terminalAction}` : ''}.`,
    `Scope: repos ${scope.repos.length}${scope.glob ? `, globs ${scope.glob.length}` : ''}${scope.agentTypes ? `, agent types ${scope.agentTypes.length}` : ''}.`,
    `Expires at: ${expiresAt !== undefined ? `${expiresAt} epoch ms` : '(none)'}.`,
  ]
}
