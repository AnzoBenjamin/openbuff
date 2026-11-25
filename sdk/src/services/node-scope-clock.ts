import { randomUUID } from 'node:crypto'
import { processScopeClock } from '@codebuff/common/util/owned-process-scope'

import type { AbsoluteDeadline, ActionExecutionPort, Clock, PreparedLaunch } from '@codebuff/common/types/contracts/execution-context'

const portClocks = new WeakMap<ActionExecutionPort, Clock>()
const launchClocks = new WeakMap<PreparedLaunch, Clock>()

export function bindNodeScopeClock(port: ActionExecutionPort, clock: Clock): void {
  portClocks.set(port, clock)
}

export function inheritNodeScopeClock(parent: ActionExecutionPort, child: ActionExecutionPort): void {
  const clock = portClocks.get(parent)
  if (clock) portClocks.set(child, clock)
}

export function registerNodeLaunchClock(port: ActionExecutionPort, launch: PreparedLaunch): void {
  const clock = portClocks.get(port)
  if (clock) launchClocks.set(launch, clock)
}

export function bindNodeLaunchClock(launch: PreparedLaunch, clock: Clock): void {
  launchClocks.set(launch, clock)
}

export function nodeLaunchClock(launch: PreparedLaunch, deadline: AbsoluteDeadline): Clock {
  const clock = launchClocks.get(launch)
  if (clock) return clock
  if (deadline.kind === 'unbounded') return processScopeClock
  // An unregistered launch's serialized deadline is not proof of its clock.
  const candidate = `sdk-unregistered:${randomUUID()}`
  const domainId = deadline.domainId === candidate ? `${candidate}:unrelated` : candidate
  return { domainId, nowMs: () => performance.now() }
}