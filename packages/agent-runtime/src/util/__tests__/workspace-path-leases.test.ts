import path from 'node:path'

import { describe, expect, test } from 'bun:test'

import { getInitialAgentState } from '@codebuff/common/types/session-state'

import {
  acquireWorkspacePathLease,
  afterSubagentCleanup,
  extendWorkspacePathLease,
  holdForSubagentCleanup,
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

  test('an unresolved child cleanup retains the lease until the owner provides confirmation', async () => {
    const state = getInitialAgentState()
    const child = getInitialAgentState()
    const projectRoot = '/tmp/lease-cleanup-confirmation'
    const lease = { state, projectRoot, ownerAgentId: 'editor-1', paths: ['src/a.ts'] }
    const leaseId = acquireWorkspacePathLease(lease)
    const confirmation = Promise.withResolvers<void>()
    holdForSubagentCleanup(child, confirmation.promise)
    afterSubagentCleanup(child, () => releaseWorkspacePathLease(state, leaseId))
    expect(() => acquireWorkspacePathLease(lease)).toThrow('Workspace path lease conflict')
    expect(state.workspacePathLeases?.[0]?.status).toBe('active')
    confirmation.resolve()
    await confirmation.promise
    expect(state.workspacePathLeases?.[0]?.status).toBe('released')
    const successor = acquireWorkspacePathLease(lease)
    expect(successor).toBeDefined()
    releaseWorkspacePathLease(state, successor)
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
    releaseWorkspacePathLease(state, leaseId)
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

  test.each([0, Date.now() + 60_000])('extension fails closed when runtime memory lost the active lease (expiry %s)', (expiresAt) => {
    const state = getInitialAgentState()
    state.workspacePathLeases = [
      {
        leaseId: 'orphaned-active',
        ownerAgentId: 'editor-1',
        paths: ['src/a.ts'],
        status: 'active',
        acquiredAt: Date.now(),
        expiresAt,
      },
    ]
    // Only a current runtime generation can renew; the recovered receipt is
    // not authority whether or not its recorded deadline has passed.
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

  test('keeps a pending scope past its deadline and across clock domains', () => {
    let now = 10
    const clock = { now: () => now }
    const state = getInitialAgentState()
    const contender = getInitialAgentState()
    const projectRoot = '/tmp/b16-pending-lease'
    const held = acquireWorkspacePathLease({
      state,
      projectRoot,
      ownerAgentId: 'editor-1',
      paths: ['src/fi*.ts'],
      leaseMs: 9,
      clock,
    })!
    const acquire = (paths: string[], ownerAgentId = 'editor-2') =>
      acquireWorkspacePathLease({ state: contender, projectRoot, ownerAgentId, paths })
    try {
      expect(state.workspacePathLeases?.[0]?.expiresAt).toBe(19)
      now = 100
      expect(() => acquire(['src/file.ts'])).toThrow('Workspace path lease conflict')
      expect(() => acquire(['src/file.ts'], 'editor-1')).toThrow('Workspace path lease conflict')
      const independent = acquire(['src/other.ts'])
      expect(independent).toBeDefined()
      releaseWorkspacePathLease(contender, independent)
      reconcileInterruptedPathLeases(state, now)
      expect(state.workspacePathLeases?.[0]?.status).toBe('active')
    } finally {
      releaseWorkspacePathLease(state, held)
    }
    expect(state.workspacePathLeases?.[0]).toMatchObject({
      status: 'released',
      releasedAt: 100,
    })
    const replacement = acquire(['src/file.ts'])
    expect(replacement).toBeDefined()
    releaseWorkspacePathLease(contender, replacement)
  })

  test('normalizes project path aliases before comparing scopes', () => {
    const state = getInitialAgentState()
    const projectRoot = '/tmp/b16-alias-lease'
    const held = acquireWorkspacePathLease({
      state,
      projectRoot,
      ownerAgentId: 'editor-1',
      paths: [`${projectRoot}/src/**`],
    })
    try {
      expect(() => acquireWorkspacePathLease({
        state,
        projectRoot,
        ownerAgentId: 'editor-2',
        paths: ['./src/sub/../file.ts'],
      })).toThrow('Workspace path lease conflict')
    } finally {
      releaseWorkspacePathLease(state, held)
    }
  })

  test('a restored copy cannot renew or release a live generation', () => {
    const state = getInitialAgentState()
    const projectRoot = '/tmp/b16-restored-lease'
    let now = 1_000
    const clock = { now: () => now }
    const acquire = () => acquireWorkspacePathLease({
      state,
      projectRoot,
      ownerAgentId: 'editor-1',
      paths: ['src/a.ts'],
      leaseMs: 10,
      clock,
    })!
    const held = acquire()
    const copy = getInitialAgentState()
    copy.workspacePathLeases = structuredClone(state.workspacePathLeases)
    try {
      now = 1_005
      expect(() => extendWorkspacePathLease({
        state: copy,
        leaseId: held,
        ownerAgentId: 'editor-1',
      })).toThrow()
      releaseWorkspacePathLease(copy, held)
      expect(copy.workspacePathLeases?.[0]?.status).toBe('active')
      expect(() => acquire()).toThrow('Workspace path lease conflict')
      expect(extendWorkspacePathLease({
        state,
        leaseId: held,
        ownerAgentId: 'editor-1',
      }).expiresAt).toBe(1_015)
    } finally {
      releaseWorkspacePathLease(state, held)
    }
    const replacement = acquire()
    try {
      expect(replacement).not.toBe(held)
      releaseWorkspacePathLease(state, held)
      expect(() => extendWorkspacePathLease({
        state,
        leaseId: held,
        ownerAgentId: 'editor-1',
      })).toThrow()
      expect(() => acquire()).toThrow('Workspace path lease conflict')
    } finally {
      releaseWorkspacePathLease(state, replacement)
    }
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
