import {
  normalizeAgentIdForLookup,
  parseAgentId,
} from '@codebuff/common/util/agent-id-parsing'

export const CONTEXT_PRUNER_AGENT_ID = 'context-pruner'

/**
 * Canonical pruner-identity check, shared by both pruner spawn paths.
 *
 * A consumer may declare the pruner bare (`context-pruner`),
 * publisher-qualified (`acme/context-pruner`), or version-pinned
 * (`acme/context-pruner@1.2.3`), and the spawn-permission contract resolves the
 * agent type to whatever was declared. Every pruner-specific decision — the
 * recursion guard in `runtime-semantic-compaction`, and the anti-thrash
 * advisory, transcript write-back and silent-output contract on the
 * `spawn_agent_inline` path — must compare agent IDs through this helper
 * instead of string-equality against the bare literal, otherwise a declared
 * publisher/version pin silently changes behavior.
 *
 * This lives in its own leaf module, depending only on agent-id parsing, so the
 * unrelated consumers of the identity check never have to import the semantic
 * compaction module (and its spawn-path dependencies) just to answer an
 * identity question.
 */
export function isContextPrunerAgentId(
  agentId: string | null | undefined,
): boolean {
  if (!agentId) {
    return false
  }
  const { agentId: bareAgentId } = parseAgentId(
    normalizeAgentIdForLookup(agentId),
  )
  return bareAgentId === CONTEXT_PRUNER_AGENT_ID
}
