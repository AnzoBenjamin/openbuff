import {
  computeValidationDependencyFingerprint,
  ValidationReceiptSchema,
} from '@codebuff/common/types/memory-playbook'

import type {
  ValidationEvidenceContext,
  ValidationReceipt,
} from '@codebuff/common/types/memory-playbook'

/** Legacy tool successes are observations, not validation attestations. */
export type SessionToolEvidenceEntry = {
  kind?: 'toolSucceeded'
  toolName: string
  commandText?: string
  atMs: number
}

export type SessionValidationEvidenceEntry = {
  kind: 'validationSucceeded'
  toolName: string
  commandText?: string
  atMs: number
  receipt: ValidationReceipt
}

export type SessionEvidenceEntry =
  | SessionToolEvidenceEntry
  | SessionValidationEvidenceEntry

/** Hard cap: only the most-recent entries are ever retained. */
export const SESSION_EVIDENCE_LOG_MAX_ENTRIES = 200

export const createSessionEvidenceLog = () => ({
  entries: [] as SessionEvidenceEntry[],
})

export type SessionEvidenceLog = ReturnType<typeof createSessionEvidenceLog>

/**
 * Append one successful tool invocation, dropping the oldest entries once the
 * cap is exceeded. Mutates in place (splice, not reassignment) so the ledger
 * identity stays stable for the whole session — agent state may hold the same
 * object across steps.
 */
export const recordSessionEvidence = (
  log: SessionEvidenceLog,
  entry: SessionEvidenceEntry,
): void => {
  log.entries.push(entry)
  const overflow = log.entries.length - SESSION_EVIDENCE_LOG_MAX_ENTRIES
  if (overflow > 0) {
    log.entries.splice(0, overflow)
  }
}

/** Called only with host-attested registry receipts, never tool-output JSON. */
export const recordSessionValidationEvidence = (
  log: SessionEvidenceLog,
  receipt: ValidationReceipt,
): void => {
  const parsed = ValidationReceiptSchema.safeParse(receipt)
  if (!parsed.success) return
  recordSessionEvidence(log, {
    kind: 'validationSucceeded',
    toolName: 'run_terminal_command',
    commandText: parsed.data.command,
    atMs: parsed.data.completedAt,
    receipt: parsed.data,
  })
}

/**
 * Playbook command patterns are literal substrings wrapped in `*` wildcards
 * (`*check:ci-local*`). Trim the surrounding wildcard runs so only the literal
 * needle survives — a wildcard inside the needle is never a regex operator, so
 * no regex is ever compiled from a playbook-supplied pattern.
 */
const stripSurroundingWildcards = (pattern: string): string =>
  pattern.trim().replace(/^\*+/, '').replace(/\*+$/, '')

export type SessionEvidenceQuery = {
  tool: string
  commandPattern?: string
  withinMs?: number
  nowMs: number
}

/**
 * True when SOME recorded entry satisfies the query. All comparisons are
 * deterministic and cheap:
 *  - `toolName` must match exactly;
 *  - the command pattern (when present) is a case-insensitive LITERAL substring
 *    test against the recorded command text; a pattern made only of wildcards
 *    constrains nothing;
 *  - `withinMs` (when present) requires the entry to be at most that old, so a
 *    stale success never satisfies a freshness-bound requirement.
 */
export const sessionEvidenceMatches = (
  log: SessionEvidenceLog,
  query: SessionEvidenceQuery,
): boolean => {
  const needle = query.commandPattern
    ? stripSurroundingWildcards(query.commandPattern).toLowerCase()
    : ''
  return log.entries.some(
    (entry) =>
      entry.kind !== 'validationSucceeded' &&
      entry.toolName === query.tool &&
      (needle.length === 0 ||
        (typeof entry.commandText === 'string' &&
          entry.commandText.toLowerCase().includes(needle))) &&
      entry.atMs <= query.nowMs &&
      (query.withinMs === undefined ||
        query.nowMs - entry.atMs <= query.withinMs),
  )
}

export type ValidationEvidenceQuery = {
  validationKinds?: readonly string[]
  withinMs?: number
  nowMs: number
}

/**
 * A receipt is reusable across actors only within the host-authenticated root
 * run/workspace and while EVERY declared dependency is present and unchanged.
 * Hashes for unrelated inputs in the current snapshot do not invalidate it.
 * The caller must supply a trusted registry snapshot: an arbitrary model/tool
 * output cannot provide current dependency hashes or attest successful checks.
 */
export const validationEvidenceMatches = (
  context: ValidationEvidenceContext | undefined,
  query: ValidationEvidenceQuery,
): boolean => {
  if (
    !context ||
    !Array.isArray(context.receipts) ||
    !context.currentDependencyHashes
  )
    return false
  return context.receipts.some((candidate) => {
    const parsed = ValidationReceiptSchema.safeParse(candidate)
    if (!parsed.success) return false
    const receipt = parsed.data
    if (
      receipt.workspaceId !== context.workspaceId ||
      receipt.rootRunId !== context.rootRunId ||
      receipt.completedAt > query.nowMs ||
      (query.withinMs !== undefined &&
        query.nowMs - receipt.completedAt > query.withinMs) ||
      (query.validationKinds &&
        !query.validationKinds.includes(receipt.checkKind))
    )
      return false

    const dependencies = Object.entries(receipt.dependencyHashes)
    if (dependencies.length === 0) return false
    if (
      computeValidationDependencyFingerprint(receipt.dependencyHashes) !==
      receipt.dependencyFingerprint
    ) {
      return false
    }
    const currentHashes: Record<string, string> = Object.create(null)
    for (const [key] of dependencies) {
      if (!Object.hasOwn(context.currentDependencyHashes, key)) return false
      const hash = context.currentDependencyHashes[key]
      if (typeof hash !== 'string' || hash.length === 0) return false
      currentHashes[key] = hash
    }
    return (
      computeValidationDependencyFingerprint(currentHashes) ===
      receipt.dependencyFingerprint
    )
  })
}
