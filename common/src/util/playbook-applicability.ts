import { matchScopeGlob, expandScopeGlob } from './playbook-scope-glob'
import { normalizeAgentIdForLookup, parseAgentId } from './agent-id-parsing'

import type { MemoryPlaybook, PlaybookStatus } from '../types/memory-playbook'

/** All values come from the host's repository and authenticated acting agent. */
export type PlaybookApplicabilityContext = {
  repoIds?: readonly string[]
  actorAgentType?: string
  /** Repository-relative paths. Undefined or empty means the focus is unknown. */
  affectedPaths?: readonly string[]
  /** Injected clock value; absent means expiry was checked by the loader. */
  nowMs?: number
}

/** Verification records quality; it does not disable an enabled procedure. */
export const isEffectivePlaybookStatus = (status: PlaybookStatus): boolean =>
  status === 'active' || status === 'verified'

/** A bare role covers aliases and qualified versions of that acting role. */
export const playbookAgentTypeMatches = (
  actorAgentType: string,
  declaredAgentType: string,
): boolean => {
  const actor = parseAgentId(normalizeAgentIdForLookup(actorAgentType))
  const declared = parseAgentId(normalizeAgentIdForLookup(declaredAgentType))
  return Boolean(
    actor.agentId &&
    declared.agentId &&
    actor.agentId === declared.agentId &&
    (!declared.publisherId || declared.publisherId === actor.publisherId) &&
    (!declared.version || declared.version === actor.version),
  )
}

const normalizePath = (value: string): string =>
  value
    .replace(/\\/g, '/')
    .replace(/^(?:\.\/)+/, '')
    .replace(/\/+$/, '')

/**
 * Shared rendering/gating decision. Positive known mismatches exclude a rule;
 * unavailable path/actor/repository facts retain potentially applicable rules.
 * The acting role is independent of a spawn trigger's target child role.
 */
export const isPlaybookApplicable = (
  playbook: MemoryPlaybook,
  context: PlaybookApplicabilityContext = {},
): boolean => {
  if (!isEffectivePlaybookStatus(playbook.status)) return false
  if (unsupportedPlaybookScope(playbook)) return false
  if (
    context.nowMs !== undefined &&
    playbook.expiresAt !== undefined &&
    playbook.expiresAt <= context.nowMs
  )
    return false
  const { repos, agentTypes, glob } = playbook.scope
  if (
    repos.length > 0 &&
    context.repoIds &&
    context.repoIds.length > 0 &&
    !repos.some((repo) =>
      context.repoIds!.some((id) => normalizePath(id) === normalizePath(repo)),
    )
  )
    return false
  if (
    agentTypes &&
    agentTypes.length > 0 &&
    context.actorAgentType &&
    !agentTypes.some((agentType) =>
      playbookAgentTypeMatches(context.actorAgentType!, agentType),
    )
  )
    return false
  if (
    glob &&
    glob.length > 0 &&
    context.affectedPaths &&
    context.affectedPaths.length > 0 &&
    !context.affectedPaths.some((path) =>
      glob.some((pattern) => matchScopeGlob(path, pattern)),
    )
  )
    return false
  return true
}

/** Full declared conditions for an indivisible rendered procedure record. */
export const describePlaybookScope = (playbook: MemoryPlaybook): string => {
  const { repos, agentTypes, glob } = playbook.scope
  return [
    `repos=${JSON.stringify(repos.length ? repos : ['*'])}`,
    `actor=${JSON.stringify(agentTypes?.length ? agentTypes : ['*'])}`,
    `paths=${JSON.stringify(glob?.length ? glob : ['*'])}`,
  ].join('; ')
}

/** Explicitly reported by the host compiler; unsupported scope is never interpreted as global. */
export const unsupportedPlaybookScope = (playbook: MemoryPlaybook): boolean =>
  Boolean(
    playbook.scope.glob?.some(
      (pattern) => expandScopeGlob(pattern) === undefined,
    ),
  )
