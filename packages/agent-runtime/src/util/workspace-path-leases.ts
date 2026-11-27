import path from 'node:path'

import { realClock, realIdGen } from '@codebuff/common/deps/real-runtime-deps'

import { normalizeScopedToolPath } from './filesystem-scope'

import type { Clock } from '@codebuff/common/types/contracts/agent-runtime'
import type { AgentState } from '@codebuff/common/types/session-state'

type LeaseReceipt = NonNullable<AgentState['workspacePathLeases']>[number]
type LeaseAcquisition = {
  state: AgentState
  projectRoot: string
  ownerAgentId: string
  taskId?: string
  paths: string[]
  leaseMs?: number
  clock?: Clock
}
type ActiveLease = {
  // The unique leaseId is the generation, not the reusable agent id or the
  // durable row. Only the issuing process can hold the live reservation.
  leaseId: string
  ownerAgentId: string
  projectRoot: string
  paths: string[]
  state: AgentState
  receipt: LeaseReceipt
  clock: Clock
  leaseMs: number
  renewing: boolean
}

type ScheduleHeartbeat = (tick: () => void, intervalMs: number) => () => void

export type WorkspacePathLeaseOptions = {
  leaseMs?: number
  scheduleHeartbeat?: ScheduleHeartbeat
}

// Entries represent observed pending/running/settling work. A missed
// heartbeat is not proof of settlement, so no deadline can evict an entry.
const activeLeases = new Map<string, ActiveLease>()
const incompleteCleanup = new WeakMap<AgentState, Promise<void> | null>()

/** A bounded failure is not a release receipt. Only an owned cleanup successor can release. */
export function holdForSubagentCleanup(state: AgentState, confirmed?: Promise<void>): void {
  incompleteCleanup.set(state, confirmed ?? null)
}

export function afterSubagentCleanup(state: AgentState, release: () => void): void {
  if (!incompleteCleanup.has(state)) { release(); return }
  const confirmed = incompleteCleanup.get(state)
  if (confirmed) void confirmed.then(release).catch(() => {})
}
const DEFAULT_LEASE_MS = 30 * 60_000

function stablePrefix(pattern: string) {
  const wildcard = pattern.search(/[?*{[]/)
  const literal = wildcard < 0 ? pattern : pattern.slice(0, wildcard)
  return {
    path: literal === '.' ? '' : literal.replace(/\/+$/, ''),
    partialSegment: wildcard >= 0 && !literal.endsWith('/'),
  }
}

function overlaps(left: string, right: string): boolean {
  const a = stablePrefix(left)
  const b = stablePrefix(right)
  const covers = (prefix: typeof a, candidate: typeof b) =>
    !prefix.path ||
    prefix.path === candidate.path ||
    candidate.path.startsWith(
      prefix.partialSegment ? prefix.path : `${prefix.path}/`,
    )
  return covers(a, b) || covers(b, a)
}

function leaseDuration(leaseMs = DEFAULT_LEASE_MS): number {
  if (!Number.isFinite(leaseMs)) {
    throw new Error('Workspace path lease duration must be finite.')
  }
  return Math.max(1, leaseMs)
}

function acquire(params: LeaseAcquisition, renewing: boolean): ActiveLease | undefined {
  const projectRoot = path.resolve(params.projectRoot)
  const requested = [
    ...new Set(
      params.paths.filter(Boolean).map((pattern) =>
        normalizeScopedToolPath(pattern.replace(/\\/g, '/'), projectRoot),
      ),
    ),
  ]
  if (requested.length === 0) return undefined
  for (const lease of activeLeases.values()) {
    if (
      lease.projectRoot === projectRoot &&
      requested.some((candidate) =>
        lease.paths.some((existing) => overlaps(candidate, existing)),
      )
    ) {
      throw new Error(
        `Workspace path lease conflict: ${params.ownerAgentId} overlaps active owner ${lease.ownerAgentId} on ${lease.paths.join(', ')}.`,
      )
    }
  }
  const leaseId = realIdGen.uuid()
  const clock = params.clock ?? realClock
  const leaseMs = leaseDuration(params.leaseMs)
  const acquiredAt = clock.now()
  const receipt: LeaseReceipt = {
    leaseId,
    ownerAgentId: params.ownerAgentId,
    taskId: params.taskId,
    paths: [...requested],
    status: 'active',
    acquiredAt,
    expiresAt: acquiredAt + leaseMs,
  }
  const lease: ActiveLease = {
    leaseId,
    ownerAgentId: params.ownerAgentId,
    projectRoot,
    paths: requested,
    state: params.state,
    receipt,
    clock,
    leaseMs,
    renewing,
  }
  params.state.workspacePathLeases ??= []
  params.state.workspacePathLeases.push(receipt)
  activeLeases.set(leaseId, lease)
  return lease
}

function currentReceipt(lease: ActiveLease): LeaseReceipt | undefined {
  const { receipt } = lease
  return receipt.leaseId === lease.leaseId &&
    receipt.ownerAgentId === lease.ownerAgentId &&
    receipt.status === 'active' &&
    lease.state.workspacePathLeases?.includes(receipt)
    ? receipt
    : undefined
}

function renew(lease: ActiveLease, leaseMs = lease.leaseMs): number {
  const receipt = currentReceipt(lease)
  if (activeLeases.get(lease.leaseId) !== lease || !receipt) {
    throw new Error(`Workspace path lease ${lease.leaseId} lost its active generation.`)
  }
  // This is a heartbeat deadline, not an ownership deadline. A delayed tick
  // can only refresh the very same locally observed generation.
  receipt.expiresAt = Math.max(receipt.expiresAt, lease.clock.now() + leaseMs)
  return receipt.expiresAt
}

function release(lease: ActiveLease, now?: number): void {
  if (activeLeases.get(lease.leaseId) !== lease) return
  activeLeases.delete(lease.leaseId)
  const receipt = currentReceipt(lease)
  if (receipt) {
    receipt.releasedAt = now ?? lease.clock.now()
    receipt.status = 'released'
  }
}

const scheduleInterval: ScheduleHeartbeat = (tick, intervalMs) => {
  const timer = setInterval(tick, intervalMs)
  timer.unref()
  return () => clearInterval(timer)
}

/** Reserve a batch child scope and return its process-local settlement capability. */
export function acquireRenewingWorkspacePathLease(
  params: LeaseAcquisition & WorkspacePathLeaseOptions & {
    onHeartbeatError: (error: unknown) => void
  },
): (() => void) | undefined {
  const lease = acquire(params, true)
  if (!lease) return undefined
  let stop: () => void
  try {
    stop = (params.scheduleHeartbeat ?? scheduleInterval)(() => {
      if (activeLeases.get(lease.leaseId) !== lease) return
      try {
        renew(lease)
      } catch (error) {
        params.onHeartbeatError(error)
      }
    }, Math.min(2_147_483_647, Math.max(1, Math.floor(lease.leaseMs / 3))))
  } catch (error) {
    // The scope was reserved but launch has not happened yet.
    release(lease)
    throw error
  }
  return () => {
    if (activeLeases.get(lease.leaseId) !== lease) return
    try {
      release(lease)
    } finally {
      stop()
    }
  }
}

/** Compatibility entry point for inline spawns: no timer, same retained scope. */
export function acquireWorkspacePathLease(params: LeaseAcquisition): string | undefined {
  return acquire(params, false)?.leaseId
}

export function releaseWorkspacePathLease(
  state: AgentState,
  leaseId: string | undefined,
  now?: number,
): void {
  if (!leaseId) return
  const lease = activeLeases.get(leaseId)
  if (lease?.state === state && !lease.renewing) release(lease, now)
}

export function extendWorkspacePathLease(params: {
  state: AgentState
  leaseId: string
  ownerAgentId: string
  leaseMs?: number
  clock?: Clock
}): { leaseId: string; expiresAt: number } {
  const { state, leaseId, ownerAgentId } = params
  const receipt = state.workspacePathLeases?.find((candidate) => candidate.leaseId === leaseId)
  if (!receipt) {
    throw new Error(`Workspace path lease extension failed: unknown leaseId ${leaseId}.`)
  }
  if (receipt.ownerAgentId !== ownerAgentId) {
    throw new Error(`Workspace path lease extension denied: ${ownerAgentId} does not own ${leaseId} (owner ${receipt.ownerAgentId}).`)
  }
  if (receipt.status !== 'active') {
    throw new Error(`Workspace path lease extension failed: lease ${leaseId} is ${receipt.status}, not active.`)
  }
  const lease = activeLeases.get(leaseId)
  if (!lease || lease.state !== state || lease.ownerAgentId !== ownerAgentId) {
    throw new Error(`Workspace path lease extension failed: lease ${leaseId} is no longer held in runtime memory by this owner.`)
  }
  if (lease.renewing || (params.clock !== undefined && params.clock !== lease.clock)) {
    throw new Error(`Workspace path lease extension denied: lease ${leaseId} requires its captured owner and clock.`)
  }
  const expiresAt = renew(lease, leaseDuration(params.leaseMs ?? lease.leaseMs))
  return { leaseId, expiresAt }
}

export function reconcileInterruptedPathLeases(
  state: AgentState,
  now?: number,
): void {
  for (const lease of state.workspacePathLeases ?? []) {
    if (lease.status !== 'active') continue
    if (activeLeases.get(lease.leaseId)?.ownerAgentId !== lease.ownerAgentId) {
      lease.status = 'interrupted'
      lease.releasedAt = now ?? realClock.now()
    }
  }
}
