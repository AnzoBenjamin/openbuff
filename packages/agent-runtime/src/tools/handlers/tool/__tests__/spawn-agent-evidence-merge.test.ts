/**
 * Child-gating evidence merge: mergeChildEvidenceIntoParent unit tests.
 *
 * Closes the basher-delegation blind spot for IN-PROCESS children: a child
 * that ran a gated command (e.g. `npm run check:ci-local`) records the
 * success on its OWN additive sessionEvidenceLog, which otherwise dies with
 * the child state — so a parent-level rule ("CI ran before spawn") never sees
 * work the parent delegated. The settle merge folds those entries into the
 * parent's ledger. (Supervised children close the same gap through the
 * RECEIPT transport — the child serializes its ledger into the receipt's
 * `sessionEvidence` and mergeSupervisedEvidenceIntoParent folds that
 * snapshot into the parent at the supervised acceptance point, covered
 * below.)
 */
import { describe, expect, it } from 'bun:test'

import {
  mergeChildEvidenceIntoParent,
  mergeSupervisedEvidenceIntoParent,
} from '../spawn-agent-utils'
import {
  createSessionEvidenceLog,
  recordSessionEvidence,
  SESSION_EVIDENCE_LOG_MAX_ENTRIES,
} from '../../../../memory/session-evidence-log'

import type { AgentReceipt } from '@codebuff/common/types/agent-handoff'
import type { AgentState } from '@codebuff/common/types/session-state'
import type { SessionEvidenceLog } from '../../../../memory/session-evidence-log'

/** Minimal AgentState stand-ins (the helper only touches the additive ledger). */
function makeState(overrides: Record<string, unknown> = {}): AgentState {
  return {
    agentId: 'merge-parent-1',
    agentType: 'parent',
    ancestorRunIds: [],
    childRunIds: [],
    messageHistory: [],
    ...overrides,
  } as unknown as AgentState
}

/** A ledger pre-filled with one recorded entry per command, in order. */
function makeLedger(commands: string[]): SessionEvidenceLog {
  const log = createSessionEvidenceLog()
  commands.forEach((commandText, index) => {
    recordSessionEvidence(log, {
      toolName: 'run_terminal_command',
      commandText,
      atMs: 1_000 + index,
    })
  })
  return log
}

/** Reads the additive ledger off a state (the same cast the helper uses). */
function ledgerOf(state: AgentState): SessionEvidenceLog | undefined {
  return (state as AgentState & { sessionEvidenceLog?: SessionEvidenceLog })
    .sessionEvidenceLog
}

describe('mergeChildEvidenceIntoParent (child-gating settle merge)', () => {
  it('merges the child ledger entries into the parent ledger in order', () => {
    const parent = makeState()
    const child = makeState({
      agentId: 'merge-child-1',
      sessionEvidenceLog: makeLedger(['cmd-a', 'cmd-b', 'cmd-c']),
    })

    mergeChildEvidenceIntoParent({
      parentAgentState: parent,
      childAgentState: child,
    })

    const parentLog = ledgerOf(parent)
    expect(parentLog).toBeDefined()
    expect(parentLog?.entries.map((entry) => entry.commandText)).toEqual([
      'cmd-a',
      'cmd-b',
      'cmd-c',
    ])
  })

  it('a child without a ledger leaves the parent ledger untouched and lazily uncreated', () => {
    const parent = makeState()
    const child = makeState({ agentId: 'merge-child-1' })

    mergeChildEvidenceIntoParent({
      parentAgentState: parent,
      childAgentState: child,
    })

    // Lazy: the parent ledger is NOT allocated when there is nothing to merge
    // (this is also the supervised-settle no-op — the parent-built child state
    // carries no ledger, so an unconditional call is safe).
    expect(ledgerOf(parent)).toBeUndefined()
  })

  it('a child ledger with zero entries also leaves the parent ledger lazily uncreated', () => {
    const parent = makeState()
    const child = makeState({
      agentId: 'merge-child-1',
      sessionEvidenceLog: makeLedger([]),
    })

    mergeChildEvidenceIntoParent({
      parentAgentState: parent,
      childAgentState: child,
    })

    expect(ledgerOf(parent)).toBeUndefined()
  })

  it('respects the session evidence cap when the parent ledger is near full', () => {
    const parent = makeState({
      sessionEvidenceLog: makeLedger(
        Array.from(
          { length: SESSION_EVIDENCE_LOG_MAX_ENTRIES - 1 },
          (_, index) => `parent-${index}`,
        ),
      ),
    })
    const child = makeState({
      agentId: 'merge-child-1',
      sessionEvidenceLog: makeLedger(['child-0', 'child-1', 'child-2']),
    })

    mergeChildEvidenceIntoParent({
      parentAgentState: parent,
      childAgentState: child,
    })

    // recordSessionEvidence enforces SESSION_EVIDENCE_LOG_MAX_ENTRIES: the
    // merged entries land and the OLDEST parent entries are evicted.
    const parentLog = ledgerOf(parent)
    expect(parentLog?.entries).toHaveLength(SESSION_EVIDENCE_LOG_MAX_ENTRIES)
    expect(parentLog?.entries[0]?.commandText).toBe('parent-2')
    expect(parentLog?.entries.at(-1)?.commandText).toBe('child-2')
  })

  it('mutating the child ledger after the merge does not affect the parent', () => {
    const parent = makeState()
    const child = makeState({
      agentId: 'merge-child-1',
      sessionEvidenceLog: makeLedger(['cmd-a', 'cmd-b', 'cmd-c']),
    })

    mergeChildEvidenceIntoParent({
      parentAgentState: parent,
      childAgentState: child,
    })

    // Entries are re-recorded as copies, so later child-ledger mutation
    // (appends and row edits alike) can never reach the parent's ledger.
    const childLog = ledgerOf(child)
    expect(childLog).toBeDefined()
    if (childLog) {
      childLog.entries.push({
        toolName: 'run_terminal_command',
        commandText: 'late entry',
        atMs: 9_999,
      })
      if (childLog.entries[0]) {
        childLog.entries[0].commandText = 'tampered'
      }
    }
    expect(ledgerOf(parent)?.entries.map((entry) => entry.commandText)).toEqual(
      ['cmd-a', 'cmd-b', 'cmd-c'],
    )
  })
})

/**
 * A minimal schema-shaped supervised receipt stand-in: the fold reads only
 * `sessionEvidence`, so the base carries the required receipt fields and
 * nothing else (the same stand-in style as makeState above).
 */
function makeSupervisedReceipt(
  overrides: Record<string, unknown> = {},
): AgentReceipt {
  return {
    schemaVersion: 1,
    receiptId: 'sup-evidence-receipt-1',
    taskId: 'sup-evidence-task-1',
    role: 'specialist',
    agentId: 'sup-evidence-child-1',
    status: 'completed',
    changedFiles: [],
    requirementsAddressed: [],
    acceptanceCriteriaAddressed: [],
    findingsAddressed: [],
    evidence: [],
    assumptions: [],
    unresolved: [],
    requestedValidation: [],
    artifacts: [],
    errors: [],
    ...overrides,
  } as unknown as AgentReceipt
}

describe('mergeSupervisedEvidenceIntoParent (supervised receipt evidence fold)', () => {
  it('merges the receipt entries into the parent ledger in order, as copies', () => {
    const parent = makeState()
    const receipt = makeSupervisedReceipt({
      sessionEvidence: [
        { toolName: 'run_terminal_command', commandText: 'cmd-a', atMs: 1_000 },
        { toolName: 'run_terminal_command', commandText: 'cmd-b', atMs: 1_001 },
      ],
    })

    mergeSupervisedEvidenceIntoParent({ parentAgentState: parent, receipt })

    const parentLog = ledgerOf(parent)
    expect(parentLog).toBeDefined()
    expect(parentLog?.entries.map((entry) => entry.commandText)).toEqual([
      'cmd-a',
      'cmd-b',
    ])
    // Entries are re-recorded as copies, so later receipt mutation (appends
    // and row edits alike) can never reach the parent's ledger.
    const receiptEntries = receipt.sessionEvidence
    expect(receiptEntries).toBeDefined()
    if (receiptEntries) {
      receiptEntries.push({
        toolName: 'run_terminal_command',
        commandText: 'late entry',
        atMs: 9_999,
      })
      if (receiptEntries[0]) {
        receiptEntries[0].commandText = 'tampered'
      }
    }
    expect(parentLog?.entries.map((entry) => entry.commandText)).toEqual([
      'cmd-a',
      'cmd-b',
    ])
  })

  it('a receipt without sessionEvidence leaves the parent ledger lazily uncreated', () => {
    const parent = makeState()

    mergeSupervisedEvidenceIntoParent({
      parentAgentState: parent,
      receipt: makeSupervisedReceipt(),
    })

    // Lazy: nothing to merge means no ledger allocation — also the exact
    // legacy shape, so every pre-evidence receipt stays a no-op.
    expect(ledgerOf(parent)).toBeUndefined()
  })

  it('an empty sessionEvidence array also leaves the parent ledger lazily uncreated', () => {
    const parent = makeState()

    mergeSupervisedEvidenceIntoParent({
      parentAgentState: parent,
      receipt: makeSupervisedReceipt({ sessionEvidence: [] }),
    })

    expect(ledgerOf(parent)).toBeUndefined()
  })

  it('respects the session evidence cap when the parent ledger is near full', () => {
    const parent = makeState({
      sessionEvidenceLog: makeLedger(
        Array.from(
          { length: SESSION_EVIDENCE_LOG_MAX_ENTRIES - 1 },
          (_, index) => `parent-${index}`,
        ),
      ),
    })
    const receipt = makeSupervisedReceipt({
      sessionEvidence: [
        {
          toolName: 'run_terminal_command',
          commandText: 'child-0',
          atMs: 5_000,
        },
        {
          toolName: 'run_terminal_command',
          commandText: 'child-1',
          atMs: 5_001,
        },
        {
          toolName: 'run_terminal_command',
          commandText: 'child-2',
          atMs: 5_002,
        },
      ],
    })

    mergeSupervisedEvidenceIntoParent({ parentAgentState: parent, receipt })

    // recordSessionEvidence enforces SESSION_EVIDENCE_LOG_MAX_ENTRIES: the
    // receipt entries land and the OLDEST parent entries are evicted.
    const parentLog = ledgerOf(parent)
    expect(parentLog?.entries).toHaveLength(SESSION_EVIDENCE_LOG_MAX_ENTRIES)
    expect(parentLog?.entries[0]?.commandText).toBe('parent-2')
    expect(parentLog?.entries.at(-1)?.commandText).toBe('child-2')
  })

  it('a malformed sessionEvidence payload (impossible post-safeParse) still never throws', () => {
    // Schema-invalid entries cannot survive agentReceiptSchema.safeParse at
    // the acceptance point; the hand-built receipt pins the never-throw
    // contract anyway — settle bookkeeping must never fail the settle chain.
    const parent = makeState()
    expect(() =>
      mergeSupervisedEvidenceIntoParent({
        parentAgentState: parent,
        receipt: makeSupervisedReceipt({
          sessionEvidence: [{ toolName: '', atMs: -1 }],
        }),
      }),
    ).not.toThrow()
    // Worst-case hand-built shape: a non-iterable sessionEvidence throws
    // INSIDE the fold and must be swallowed by the never-throw catch.
    expect(() =>
      mergeSupervisedEvidenceIntoParent({
        parentAgentState: makeState(),
        receipt: makeSupervisedReceipt({ sessionEvidence: 42 }),
      }),
    ).not.toThrow()
  })
})
