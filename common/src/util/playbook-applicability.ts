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
 * Small, bounded glob matcher for repository-relative scope paths. Supports
 * segment wildcards (*, ?), recursive ** and literal characters; unsupported
 * bracket/brace patterns remain potentially applicable rather than excluding
 * a procedure whose scope this runtime cannot prove disjoint.
 */
const pathMayMatch = (path: string, glob: string): boolean => {
  if (/[\[\]{}]/.test(glob)) return true
  const pathParts = normalizePath(path).split('/')
  const globParts = normalizePath(glob).split('/')
  const memo = new Map<string, boolean>()
  const segmentMatches = (value: string, pattern: string): boolean => {
    let valueIndex = 0
    let patternIndex = 0
    let wildcardIndex = -1
    let wildcardValueIndex = 0
    while (valueIndex < value.length) {
      if (
        pattern[patternIndex] === '?' ||
        pattern[patternIndex] === value[valueIndex]
      ) {
        valueIndex++
        patternIndex++
      } else if (pattern[patternIndex] === '*') {
        wildcardIndex = patternIndex++
        wildcardValueIndex = valueIndex
      } else if (wildcardIndex >= 0) {
        patternIndex = wildcardIndex + 1
        valueIndex = ++wildcardValueIndex
      } else {
        return false
      }
    }
    while (pattern[patternIndex] === '*') patternIndex++
    return patternIndex === pattern.length
  }
  const matches = (pathIndex: number, globIndex: number): boolean => {
    const key = `${pathIndex}:${globIndex}`
    const cached = memo.get(key)
    if (cached !== undefined) return cached
    const pattern = globParts[globIndex]
    const result =
      pattern === undefined
        ? pathIndex === pathParts.length
        : pattern === '**'
          ? matches(pathIndex, globIndex + 1) ||
            (pathIndex < pathParts.length && matches(pathIndex + 1, globIndex))
          : pathIndex < pathParts.length &&
            segmentMatches(pathParts[pathIndex]!, pattern) &&
            matches(pathIndex + 1, globIndex + 1)
    memo.set(key, result)
    return result
  }
  return matches(0, 0)
}

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
      glob.some((pattern) => pathMayMatch(path, pattern)),
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
