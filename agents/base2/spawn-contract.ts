import basher from '../basher'
import browserUse from '../browser-use/browser-use'
import contextPruner from '../context-pruner'
import debuggerAgent from '../debugger/debugger'
import dependencyManager from '../dependency-manager/dependency-manager'
import docWriter from '../doc-writer/doc-writer'
import editor from '../editor/editor'
import repairEditor from '../editor/repair-editor'
import filePicker from '../file-explorer/file-picker'
import generalAgent from '../general-agent/general-agent'
import researcherDocs from '../researcher/researcher-docs'
import researcherWeb from '../researcher/researcher-web'
import codeReviewer from '../reviewer/code-reviewer'
import securityReviewer from '../security-reviewer/security-reviewer'
import synthesizer from '../synthesizer/synthesizer'
import testWriter from '../test-writer/test-writer'
import thinker from '../thinker/thinker'
import tmuxCli from '../tmux-cli'
import type { AllToolNames } from '../types/secret-agent-definition'

/**
 * D17: base2's programmatic-tool list and per-agent spawn-params clause are
 * emitted from descriptor surfaces (this tool contract and the shipped agent
 * definitions' `inputSchema`s) instead of hand-maintained prose, retiring the
 * roster-drift family's prose-sync role.
 *
 * This module imports ONLY leaf definition files — never `base2.ts` itself —
 * so it cannot create an import cycle with its consumer.
 *
 * BYTE-COMPAT CONTRACT: `buildSpawnContractClauses()` must emit exactly the
 * paragraph the retired hand-written prose produced, so every clause the prose
 * pinned carries its wording verbatim in `SPAWN_CONTRACT_CLAUSES`. That legacy
 * fallback exists ONLY for wording schema derivation cannot reproduce
 * byte-for-byte (hand-tuned phrasing like "a shell string", and family clauses
 * for definitions this module does not import). New agents never need a legacy
 * entry: any registry agent that is not covered by a legacy clause and whose
 * `inputSchema.params.required` is non-empty automatically gets a derived
 * `<agentId> needs <required-params summary>` clause, and an agent that gains
 * a required param drops out of the param-less coverage set — the
 * roster-coverage tests then fail until a real clause exists, so the contract
 * cannot silently drift from the schemas.
 */

/**
 * Tools callable only from base2's serialized handleSteps (hidden from the
 * model). One why-comment per entry, in emission order: the array base2
 * publishes must stay byte-identical to the inline literal this constant
 * replaced.
 *
 * Typed against `AllToolNames` — the union re-exported through
 * agents/types/secret-agent-definition — because `spawn_agent_inline` exists
 * only in that wider union: the narrower `Tools.ToolName` union lacks it.
 */
export const BASE2_PROGRAMMATIC_TOOL_NAMES: readonly AllToolNames[] = [
  // base2's own generator loop drives every gate/aux spawn (context-pruner,
  // test-writer/doc-writer/security-reviewer, routed specialists,
  // repair-editor) through inline yields the model never authors.
  'spawn_agent_inline',
  // Turn-start and post-step dirty-scope snapshots feed the gate's pending
  // file ledger, the P0 re-arm, and the git-committer unvalidated set.
  'git_status',
  // Runs the configured validation hooks whose summary gates finalization.
  'run_file_change_hooks',
  // Audit-shard snapshot ids the broad-audit coverage receipts bind to.
  'inspect_codebase_structure',
  // Read-only diff/bundle evidence included in reviewer spawn prompts.
  'get_change_review_bundle',
  // Package-manager/manifest evidence summarized for the writer gates.
  'inspect_environment',
  // Maps pending gate files to candidate tests for the test-writer gate.
  'get_affected_tests',
  // Maps pending gate files to build targets/commands for the same gate.
  'get_build_targets',
]

// ---------------------------------------------------------------------------
// inputSchema derivation
// ---------------------------------------------------------------------------

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * Derives the required-params summary for one shipped definition directly
 * from its `inputSchema`: `params.<key> (<type>)` per required key, in schema
 * declaration order. Returns '' when the schema declares no required params,
 * so param-less agents contribute no clause. Deterministic by construction.
 */
export function deriveSpawnParamSummary(definition: unknown): string {
  if (!isRecord(definition)) return ''
  const inputSchema = definition.inputSchema
  if (!isRecord(inputSchema)) return ''
  const params = inputSchema.params
  if (!isRecord(params)) return ''
  const required = Array.isArray(params.required)
    ? params.required.filter((key): key is string => typeof key === 'string')
    : []
  if (required.length === 0) return ''
  const properties = isRecord(params.properties) ? params.properties : undefined
  return required
    .map((key) => {
      const property = properties?.[key]
      const type =
        isRecord(property) && typeof property.type === 'string'
          ? property.type
          : 'value'
      return `params.${key} (${type})`
    })
    .join(', ')
}

/**
 * Shipped spawnable definitions the spawn contract reasons about, imported
 * from their leaf modules. Values are the plain definition objects; the spawn
 * contract reads only `inputSchema`.
 *
 * `git-committer` and `librarian` are deliberately ABSENT: their required
 * params are documented on dedicated surfaces (see
 * `SPAWN_CONTRACT_DELEGATED_PARAMS`), and a derived clause for them would
 * change the byte-compat emission.
 */
const SPAWN_CONTRACT_DEFINITIONS = {
  basher,
  'browser-use': browserUse,
  'code-reviewer': codeReviewer,
  'context-pruner': contextPruner,
  'dependency-manager': dependencyManager,
  debugger: debuggerAgent,
  'doc-writer': docWriter,
  editor,
  'file-picker': filePicker,
  'general-agent': generalAgent,
  'repair-editor': repairEditor,
  'researcher-docs': researcherDocs,
  'researcher-web': researcherWeb,
  'security-reviewer': securityReviewer,
  synthesizer,
  'test-writer': testWriter,
  thinker,
  'tmux-cli': tmuxCli,
}

type SpawnContractClause = {
  /**
   * LEGACY wording pinned byte-for-byte to the retired hand-written paragraph
   * in base2's system prompt. See the module docblock: this fallback exists
   * only for wording derivation cannot reproduce; new agents never need one.
   */
  legacyText: string
  /**
   * Roster agent ids the clause documents. Family clauses enumerate their
   * member ids so roster coverage stays checkable even though the emitted
   * text names the family ("architect/advisory", "reviewer-family"), not
   * each id.
   */
  agentIds: readonly string[]
}

/**
 * The retired hand-written clause list, segment by segment. Joined with
 * '; ' these reproduce today's emission byte-identically; each agent the
 * prose named (or grouped under a family) is accounted for in `agentIds`.
 */
const SPAWN_CONTRACT_CLAUSES: readonly SpawnContractClause[] = [
  {
    legacyText: 'basher needs `params.command` (a shell string)',
    agentIds: ['basher'],
  },
  {
    legacyText:
      'general-agent needs prompt + params.filePaths/directoryPaths (not files)',
    agentIds: ['general-agent'],
  },
  {
    legacyText:
      'thinker needs prompt packet (params only depth/outputSchemaHint)',
    agentIds: ['thinker'],
  },
  {
    legacyText:
      'dependency-manager needs params.manager+params.operation from manifest evidence',
    agentIds: ['dependency-manager'],
  },
  {
    // Family clause: the prose groups architect and the routed advisory /
    // specialist reviewers under one contract (prompt + scoped files;
    // runtime-owned spawns carry the gate-assigned snapshot token, manual
    // spawns omit it).
    legacyText: 'architect/advisory needs prompt+files (snapshot_id optional)',
    agentIds: [
      'architect',
      'product-reviewer',
      'integration-agent',
      'performance-specialist',
      'reliability-reviewer',
      'migration-reviewer',
      'accessibility-reviewer',
      'ux-visual-reviewer',
      'compatibility-reviewer',
      'dependency-reviewer',
      'incident-coordinator',
      'release-manager',
      'docs-architect',
      'evaluator',
    ],
  },
  {
    // Family clause: reviewer-family manual spawns omit the gate-assigned
    // snapshot token, while security-reviewer pins its own required pair.
    legacyText:
      'reviewer-family manual spawns omit params.snapshot_id (security-reviewer needs changed_files+snapshot_fingerprint)',
    agentIds: ['code-reviewer', 'security-reviewer'],
  },
]

/**
 * Roster agents whose required params are documented on a dedicated surface
 * instead of the base2 spawn-contract clause. The emitted paragraph must stay
 * byte-identical to the retired hand-written text, so these agents are
 * excluded from the derivation registry and accounted for here; the
 * roster-coverage tests verify the owning surface actually names the param.
 */
export const SPAWN_CONTRACT_DELEGATED_PARAMS: Readonly<Record<string, string>> = {
  'git-committer':
    'params.owned_paths is REQUIRED; guidance lives in gitDisciplineSection (agents/base2/quality-prompt-section.ts and the git-discipline guide)',
  librarian:
    'params.repoUrl is REQUIRED; guidance lives on the librarian definition spawnerPrompt (spawn catalog line)',
}

type SpawnContractSegment = {
  /** Exact text this segment contributes ('' emits nothing). */
  text: string
  /** Roster agent ids the segment accounts for. */
  agentIds: readonly string[]
}

/**
 * Builds the ordered clause segments: the legacy clauses, then a param-less
 * coverage segment (registry agents whose schema declares no required params
 * — derived from the schemas, never hand-listed), then derived clauses for
 * any uncovered registry agent that gained required params.
 */
function buildSpawnContractSegments(): SpawnContractSegment[] {
  const segments: SpawnContractSegment[] = SPAWN_CONTRACT_CLAUSES.map(
    (clause) => ({ text: clause.legacyText, agentIds: clause.agentIds }),
  )
  const covered = new Set(
    SPAWN_CONTRACT_CLAUSES.flatMap((clause) => clause.agentIds),
  )
  const paramLessAgentIds: string[] = []
  const derivedSegments: SpawnContractSegment[] = []
  // Object.entries iterates in insertion order, so both outputs are stable.
  for (const [id, definition] of Object.entries(SPAWN_CONTRACT_DEFINITIONS)) {
    if (covered.has(id)) continue
    const summary = deriveSpawnParamSummary(definition)
    if (summary === '') {
      paramLessAgentIds.push(id)
      continue
    }
    // New agents get derived clauses automatically; the legacy fallback map
    // exists only for the wording the retired hand-written prose pinned.
    derivedSegments.push({ text: `${id} needs ${summary}`, agentIds: [id] })
  }
  segments.push({ text: '', agentIds: paramLessAgentIds })
  segments.push(...derivedSegments)
  return segments
}

/**
 * The per-agent spawn-params clause list emitted into base2's system prompt
 * at the position the hand-written paragraph occupied. Deterministic, and
 * byte-identical to the retired prose (see the module docblock).
 */
export function buildSpawnContractClauses(): string {
  return buildSpawnContractSegments()
    .map((segment) => segment.text)
    .filter((text) => text.length > 0)
    .join('; ')
}

export type SpawnContractClauseCoverage = {
  /** Exact text this segment contributes to the emission ('' = nothing). */
  clause: string
  /** Roster agent ids the segment accounts for. */
  agentIds: readonly string[]
}

/**
 * The same segment list `buildSpawnContractClauses()` emits, paired with the
 * roster agent ids each segment accounts for — the checkable surface the
 * roster-coverage tests assert against base2's live spawnable roster.
 */
export function getSpawnContractClauseCoverage(): readonly SpawnContractClauseCoverage[] {
  return buildSpawnContractSegments().map((segment) => ({
    clause: segment.text,
    agentIds: segment.agentIds,
  }))
}
