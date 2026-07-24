import type { AgentState } from '@codebuff/common/types/session-state'

/**
 * After context compaction removes exact read bodies from model-visible context,
 * record a typed reread reason for telemetry/guidance — but keep sticky whole-file
 * authorizations and hashes. Edit-time `isWholeFileReadAuthorizationFresh` still
 * fails closed when disk content has drifted from the stored hash.
 */
export function revokeImplicitReadAuthorizationsAfterCompaction(
  agentState: AgentState,
): void {
  const paths = new Set([
    ...Object.keys(agentState.readAuthorizationsByPath ?? {}),
    ...Object.keys(agentState.readAuthorizationHashesByPath ?? {}),
  ])
  if (paths.size === 0) return

  agentState.editRereadRequirementsByPath ??= {}
  for (const path of paths) {
    agentState.editRereadRequirementsByPath[path] = {
      reason: 'context_compacted',
      sourceTool: 'context compaction',
    }
  }
  // Sticky maps intentionally preserved: hash freshness is enforced at edit time.
}
