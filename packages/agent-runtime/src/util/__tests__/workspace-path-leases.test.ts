import path from 'node:path'

import { describe, expect, test } from 'bun:test'

import { getInitialAgentState } from '@codebuff/common/types/session-state'

import {
  acquireWorkspacePathLease,
  extendWorkspacePathLease,
  reconcileInterruptedPathLeases,
  releaseWorkspacePathLease,
} from '../workspace-path-leases'

describe('workspace path leases', () => {
  test('rejects overlapping paths held by a different child', () => {
    const state = getInitialAgentState()
    const projectRoot = path.join('/tmp', 'lease-overlap-test')
    const leaseId = acquireWorkspacePathLease({
      state,
      projectRoot,
      ownerAgentId: 'editor-1',
      paths: ['src/**'],
    })

    expect(() =>
      acquireWorkspacePathLease({
        state,
        projectRoot,
        ownerAgentId: 'editor-2',
        paths: ['src/features/a.ts'],
      }),
    ).toThrow('Workspace path lease conflict')
    releaseWorkspacePathLease(state, leaseId)
  })

  test('allows non-overlapping paths and releases ownership durably', () => {
    const state = getInitialAgentState()
    const projectRoot = path.join('/tmp', 'lease-release-test')
    const first = acquireWorkspacePathLease({
      state,
      projectRoot,
      ownerAgentId: 'editor-1',
      paths: ['src/**'],
    })
    const second = acquireWorkspacePathLease({
      state,
      projectRoot,
      ownerAgentId: 'editor-2',
      paths: ['docs/**'],
    })

    releaseWorkspacePathLease(state, first)
    expect(
      state.workspacePathLeases?.find((lease) => lease.leaseId === first),
    ).toMatchObject({
      status: 'released',
    })
    expect(() =>
      acquireWorkspacePathLease({
        state,
        projectRoot,
        ownerAgentId: 'editor-3',
        paths: ['src/new.ts'],
      }),
    ).not.toThrow()
    releaseWorkspacePathLease(state, second)
    for (const lease of state.workspacePathLeases ?? []) {
      releaseWorkspacePathLease(state, lease.leaseId)
    }
  })

  test('marks durable active leases as interrupted after process recovery', () => {
    const state = getInitialAgentState()
    state.workspacePathLeases = [
      {
        leaseId: 'missing-runtime-lease',
        ownerAgentId: 'editor-1',
        paths: ['src/a.ts'],
        status: 'active',
        acquiredAt: 1,
        expiresAt: Date.now() + 10_000,
      },
    ]

    reconcileInterruptedPathLeases(state)

    expect(state.workspacePathLeases[0]).toMatchObject({
      status: 'interrupted',
    })
    expect(state.workspacePathLeases[0].releasedAt).toBeNumber()
  })

  test('extends owned leases and reports the new expiry', () => {
    const state = getInitialAgentState()
    const leaseId = acquireWorkspacePathLease({
      state,
      projectRoot: '/tmp/lease-extend-test',
      ownerAgentId: 'editor-1',
      paths: ['src/**'],
      leaseMs: 60_000,
    })
    const extended = extendWorkspacePathLease({
      state,
      leaseId: leaseId!,
      ownerAgentId: 'editor-1',
      leaseMs: 120_000,
    })
    expect(extended.expiresAt).toBeGreaterThan(Date.now() + 100_000)
    expect(
      state.workspacePathLeases?.find((lease) => lease.leaseId === leaseId)
        ?.expiresAt,
    ).toBe(extended.expiresAt)
  })

  test('extension failure paths are structured (unknown, foreign owner, non-active)', () => {
    const state = getInitialAgentState()
    const leaseId = acquireWorkspacePathLease({
      state,
      projectRoot: '/tmp/lease-extend-fail',
      ownerAgentId: 'editor-1',
      paths: ['src/**'],
    }) as string

    expect(() =>
      extendWorkspacePathLease({
        state,
        leaseId: 'no-such-lease',
        ownerAgentId: 'editor-1',
      }),
    ).toThrow('unknown leaseId')

    expect(() =>
      extendWorkspacePathLease({
        state,
        leaseId,
        ownerAgentId: 'editor-2',
      }),
    ).toThrow('does not own')

    releaseWorkspacePathLease(state, leaseId)
    expect(() =>
      extendWorkspacePathLease({
        state,
        leaseId,
        ownerAgentId: 'editor-1',
      }),
    ).toThrow('not active')
  })

  test('extension fails closed when runtime memory lost the active lease', () => {
    const state = getInitialAgentState()
    state.workspacePathLeases = [
      {
        leaseId: 'orphaned-active',
        ownerAgentId: 'editor-1',
        paths: ['src/a.ts'],
        status: 'active',
        acquiredAt: Date.now(),
        expiresAt: Date.now() + 60_000,
      },
    ]
    // Durable says active and unexpired, but the runtime map never recorded
    // it (crash-recovery boundary): extension must fail rather than fabricate
    // a runtime clock the reconciler cannot see.
    expect(() =>
      extendWorkspacePathLease({
        state,
        leaseId: 'orphaned-active',
        ownerAgentId: 'editor-1',
      }),
    ).toThrow('no longer held in runtime memory')
  })

  test('double-release and unknown-id release are safe no-ops (release race)', () => {
    const state = getInitialAgentState()
    const leaseId = acquireWorkspacePathLease({
      state,
      projectRoot: '/tmp/lease-race-test',
      ownerAgentId: 'editor-1',
      paths: ['src/**'],
    })
    releaseWorkspacePathLease(state, leaseId)
    const releasedAt = state.workspacePathLeases?.find(
      (lease) => lease.leaseId === leaseId,
    )?.releasedAt
    // A raced/retried release must not throw or resurrect the lease.
    expect(() => releaseWorkspacePathLease(state, leaseId)).not.toThrow()
    expect(
      state.workspacePathLeases?.find((lease) => lease.leaseId === leaseId)
        ?.releasedAt,
    ).toBe(releasedAt)
    expect(() => releaseWorkspacePathLease(state, 'no-such-lease')).not.toThrow()
  })

  test('does not allocate a lease for an empty writable scope', () => {
    const state = getInitialAgentState()
    expect(
      acquireWorkspacePathLease({
        state,
        projectRoot: '/tmp/lease-empty-test',
        ownerAgentId: 'reviewer-1',
        paths: [],
      }),
    ).toBeUndefined()
    expect(state.workspacePathLeases).toBeUndefined()
  })
})
