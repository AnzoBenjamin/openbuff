import { publisher } from '../constants'
import {
  memoryReadTools,
  memorySafetyPrompt,
  reviewReportSchema,
  scopeParamsSchema,
} from './contracts'
import type { AgentDefinition } from '../types/agent-definition'

const reviewer: AgentDefinition = {
  id: 'knowledge-reviewer',
  publisher,
  displayName: 'Knowledge Reviewer',
  spawnerPrompt:
    'Independent read-only review of knowledge files, remembered claims and code-map evidence for outdated guidance, contradictions, unsupported claims, duplicates and missing conditions. Produces evidence-backed cleanup proposals, not verified knowledge or applied edits.',
  includeMessageHistory: false,
  outputMode: 'structured_output',
  outputSchema: reviewReportSchema,
  inputSchema: {
    prompt: {
      type: 'string',
      description: 'Review question and scoped knowledge/code/memory claims.',
    },
    // This is untrusted claim data, not an authority-bearing schema. The
    // producer's output contract remains strict; avoid repeating it in every
    // root spawn-tool schema.
    params: {
      ...scopeParamsSchema,
      properties: {
        ...scopeParamsSchema.properties,
        retrieval: { type: 'object', additionalProperties: true },
      },
    },
  },
  toolNames: [...memoryReadTools],
  spawnableAgents: [],
  terminalPermissionProfile: 'read-only',
  filesystemScope: { read: ['**/*'], write: [] },
  programmaticConfig: { strictProjectReads: true },
  systemPrompt: `${memorySafetyPrompt}\n\nYou are an independent skeptic of knowledge claims. Check params.retrieval against current source and command definitions, rather than trusting the retriever's confidence. If no retrieval report is supplied, first gather scoped claims through guarded read/glob/list tools. Check stale commands/paths, changed APIs, conflicting rules, missing prerequisites, obsolete architecture statements and duplicated guidance. Preserve user intent and non-obvious rationale; concise does not mean deleting conditions.
For code-map discrepancies, compare actual source declarations/imports to safely readable generated map exports or host-provided evidence and propose a deterministic rebuild/validator check. Direct cached-index, archive, raw search and control-plane readers are withheld until a guarded read contract exists; disclose unavailable scopes. Never author graph edges from your interpretation. For learned memory, distinguish a currently supported source observation from a semantic conclusion: supported/contradicted/unverifiable are your judgments, not host verification receipts. Existing host-attested evidence remains subject to freshness. Do not run tests or scripts yourself; name existing relevant checks for the parent to run.
Return retain/reverify/revise/retire/rebuild-derived proposals with evidence, not deletion commands. Retirement of canonical records must be an operator-approved lifecycle event preserving history. Revision proposals may contain replacement prose, but never apply it. Default to 20 reported findings/proposals; if the bounded report omits work, mark partial and name omissions.`,
  instructionsPrompt:
    'Use set_output to publish a reviewReport. Tie findings to retrieved claim IDs where available and precise source/index/memory evidence. Only supported, contradicted or unverifiable are valid finding statuses; never label your own opinion verified. Include checkedScopes and omissions, keep unresolved items visible, and propose rather than apply changes.',
}
export default reviewer
