import { describe, expect, test } from 'bun:test'

import { committedMutationFixture } from '@codebuff/common/testing/fixtures/file-mutation'
import { advanceWorkspaceState, createInitialWorkspaceState } from '@codebuff/common/types/workspace-state'

import { createActionWorkspaceBasis } from '../services/action-workspace-basis'

import type { ToolExecutionIdentity } from '@codebuff/common/types/contracts/client'

function fixture() {
  const before = createInitialWorkspaceState(1)
  const identity: ToolExecutionIdentity = { actionId: 'fixture-call', attemptId: 'attempt', runId: 'run', rootRunId: 'run', agentId: 'agent',
    basisId: 'original-basis', basis: { inputHash: 'input', workspaceRevision: before.revision }, workspaceSnapshotId: before.snapshotId }
  const mutation = committedMutationFixture([{ path: 'file.ts', content: 'after' }])
  const canonicalReceipt = mutation.authorityReceipt!
  const actions = canonicalReceipt.actions.map(action => ({ action: action.action, path: action.path,
    beforeHash: action.beforeHash, afterHash: action.afterHash }))
  const change = { source: 'sdk:write_file', operationId: canonicalReceipt.operationId, receiptId: canonicalReceipt.receiptId, actions }
  const after = advanceWorkspaceState(before, change)
  const basis = createActionWorkspaceBasis(identity, before)
  return { identity, before, after, basis, transition: { before, after, ...change, canonicalReceipt } }
}

describe('same-action workspace effects retain original B02 authority', () => {
  test('recognizes only the canonical causal transition without replacing the attempted basis', () => {
    const f = fixture(), original = JSON.stringify(f.identity)
    expect(f.basis.isCurrent(f.identity.basisId, f.before)).toBe(true)
    expect(f.basis.isCurrent(f.identity.basisId, f.after)).toBe(false)
    expect(f.basis.confirmTransition(f.transition)).toBe(true)
    expect(f.basis.isCurrent(f.identity.basisId, f.after)).toBe(true)
    expect(f.basis.isCurrent('replacement-basis', f.after)).toBe(false)
    expect(f.basis.isCurrent(f.identity.basisId, f.before)).toBe(false)
    expect(JSON.stringify(f.identity)).toBe(original)
  })

  test('missing, foreign, or changed action/hash receipts cannot renew authority', () => {
    const f = fixture()
    expect(f.basis.confirmTransition({ ...f.transition, canonicalReceipt: undefined })).toBe(false)
    expect(f.basis.confirmTransition({ ...f.transition, canonicalReceipt: { ...f.transition.canonicalReceipt, callId: 'other-action' } })).toBe(false)
    expect(f.basis.confirmTransition({ ...f.transition, operationId: 'other-operation' })).toBe(false)
    expect(f.basis.confirmTransition({ ...f.transition, actions: [{ ...f.transition.actions[0], afterHash: 'changed' }] })).toBe(false)
    expect(f.basis.isCurrent(f.identity.basisId, f.before)).toBe(true)
  })

  test('intervening foreign mutation remains stale even when the later action has a valid receipt', () => {
    const f = fixture()
    const foreign = advanceWorkspaceState(f.before, { source: 'foreign-editor', actions: [{ action: 'unknown', path: 'other.ts' }] })
    const after = advanceWorkspaceState(foreign, f.transition)
    expect(f.basis.confirmTransition({ ...f.transition, before: foreign, after })).toBe(false)
    expect(f.basis.isCurrent(f.identity.basisId, foreign)).toBe(false)
    expect(f.basis.isCurrent(f.identity.basisId, after)).toBe(false)
  })

  test('journal jumps and malformed receipt envelopes cannot renew authority', () => {
    const f = fixture()
    expect(f.basis.confirmTransition({ ...f.transition, after: { ...f.after, revision: f.after.revision + 1 } })).toBe(false)
    expect(f.basis.confirmTransition({ ...f.transition, after: { ...f.after, snapshotId: 'unrelated-snapshot' } })).toBe(false)
    expect(f.basis.confirmTransition({ ...f.transition, canonicalReceipt: { ...f.transition.canonicalReceipt, status: 'not_started' } })).toBe(false)
    expect(f.basis.isCurrent(f.identity.basisId, f.before)).toBe(true)
  })

  test('an original stale workspace snapshot or revision is never repaired by a receipt', () => {
    const f = fixture()
    for (const identity of [ { ...f.identity, workspaceSnapshotId: 'stale' },
      { ...f.identity, basis: { ...f.identity.basis, workspaceRevision: 999 } } ]) {
      const basis = createActionWorkspaceBasis(identity, f.before)
      expect(basis.isCurrent(identity.basisId, f.before)).toBe(false)
      expect(basis.confirmTransition(f.transition)).toBe(false)
    }
  })
})
