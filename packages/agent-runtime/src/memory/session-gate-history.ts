import type { AgentState } from '@codebuff/common/types/session-state'

/**
 * Deterministic playbook-gate verdict history (memory playbook Phase 4).
 *
 * An in-memory, per-agent-state record of the gate verdicts one session has
 * produced, kept so comply detection can answer "was this trigger signature
 * BLOCKED earlier in this same session and is the call now satisfied?"
 * without any model call, store round-trip, or prose parsing. The history is
 * append-only, bounded, and holds nothing beyond identity, outcome, and a
 * caller-supplied timestamp, so it can ride on agent state without
 * meaningfully growing a serialized session.
 *
 * Scope is deliberately per-agent-state: the evidence ledger MERGES at settle
 * (mergeChildEvidenceIntoParent folds a child's ledger into its parent), but
 * gate history does NOT — a blocked-then-allowed arc belongs to the agent that
 * lived it, so no entry is ever folded across agents and each agent's
 * correlation stays its own.
 */
export type SessionGateHistoryEntry = {
  playbookId: string
  triggerSignature: string
  outcome: 'warned' | 'blocked' | 'allowed' | 'compliedAfterBlock'
  atMs: number
  /**
   * Present once this blocked entry's post-block compliance has been reported,
   * so the same block can never earn a second 'compliedAfterBlock'. Only
   * correlateCompliedAfterBlock ever sets it — never the recording caller.
   */
  compensated?: true
}

/** Hard cap: only the most-recent entries are ever retained. */
export const SESSION_GATE_HISTORY_MAX_ENTRIES = 50

export const createSessionGateHistory = () => ({
  entries: [] as SessionGateHistoryEntry[],
})

export type SessionGateHistory = ReturnType<typeof createSessionGateHistory>

/**
 * Append one gate verdict, dropping the oldest entries once the cap is
 * exceeded. Mutates in place (splice, not reassignment) so the history identity
 * stays stable for the whole session — agent state may hold the same object
 * across steps.
 */
export const recordSessionGateOutcome = (
  history: SessionGateHistory,
  entry: SessionGateHistoryEntry,
): void => {
  history.entries.push(entry)
  const overflow = history.entries.length - SESSION_GATE_HISTORY_MAX_ENTRIES
  if (overflow > 0) {
    history.entries.splice(0, overflow)
  }
}

/**
 * Correlate one satisfied evaluation back to a prior in-session block of the
 * SAME trigger signature. Finds the most recent 'blocked' entry for the
 * signature that is not yet compensated, marks it compensated, and returns
 * true; returns false when there is none. Each blocked entry can therefore be
 * compensated at most once — 'compliedAfterBlock' is reported exactly once
 * per prior block.
 *
 * 'blocked' is the ONLY correlatable outcome: a heeded 'warned' never counts.
 * compliedAfterBlock means specifically after-block compliance — correlating a
 * warned-then-allowed arc would pollute the one strong effectiveness signal
 * the counters carry.
 *
 * Pure-ish: the only mutation is the compensated marker on the matched entry.
 * No clock — the caller supplied every atMs.
 */
export const correlateCompliedAfterBlock = (
  history: SessionGateHistory,
  query: { triggerSignature: string },
): boolean => {
  for (let index = history.entries.length - 1; index >= 0; index -= 1) {
    const entry = history.entries[index]
    if (!entry || entry.outcome !== 'blocked') continue
    if (entry.triggerSignature !== query.triggerSignature) continue
    if (entry.compensated === true) continue
    entry.compensated = true
    return true
  }
  return false
}

/**
 * The playbook gate's per-agent-state verdict history, held additively on
 * agent state. Created on first use so a session that never sees a playbook
 * never allocates one. The history identity is stable for the session, which
 * is what lets a later satisfied call correlate back to an earlier block.
 * Mirrors sessionEvidenceLogFor in ../tools/tool-executor.ts.
 */
export function sessionGateHistoryFor(
  agentState: AgentState,
): SessionGateHistory {
  const state = agentState as AgentState & {
    sessionGateHistory?: SessionGateHistory
  }
  state.sessionGateHistory ??= createSessionGateHistory()
  return state.sessionGateHistory
}
