import { quarantinedToolNames, toolNames, type ToolName } from './constants'

export type ToolBehaviorKind = 'read' | 'mutation' | 'control' | 'other'
export type ToolSchedulingScope = 'read_only' | 'named_path' | 'global'
export type ToolResultContract = 'legacy_v0' | 'read_v1' | 'mutation_v1'
export type ToolRendererIntent = 'custom' | 'fallback' | 'hidden'
export type ToolReachability =
  | 'active'
  | 'quarantined'
  | 'internal'
  /** Removed from the registry; only reachable through persisted artifacts. */
  | 'removed'
  /**
   * Not a native tool name at all: a live custom tool, an MCP tool, or any
   * other unrecognized string. Such a tool is neither registered here nor
   * deprecated; its own definition owns its behavior and prompt exposure.
   */
  | 'unknown'

export type ToolMetadata = {
  kind: ToolBehaviorKind
  scheduling: ToolSchedulingScope
  pathInputs: readonly string[]
  resultContract: ToolResultContract
  renderer: ToolRendererIntent
  includeInMutationSummary: boolean
  reachability: ToolReachability
  promptVisible: boolean
  deprecated: boolean
}

const READ_TOOLS = new Set<ToolName>([
  'check_job',
  'code_search',
  'find_files',
  'find_files_matching_content',
  'git_status',
  'get_task',
  'get_change_review_bundle',
  'inspect_workspace',
  'inspect_environment',
  'inspect_3d_asset',
  'get_affected_tests',
  'get_build_targets',
  'inspect_codebase_structure',
  'inspect_feature_completeness',
  'evaluate_audit_coverage',
  'glob',
  'list_directory',
  'list_jobs',
  'query_index',
  'read_docs',
  'read_files',
  'read_image',
  'render_3d_preview',
  'read_logs',
  'read_outline',
  'read_subtree',
])
const MUTATION_TOOLS = new Set<ToolName>([
  'create_plan',
  'edit_transaction',
  'edit_3d_asset',
  'replace_range',
  'rewrite_symbol',
  'str_replace',
  'update_plan_status',
  'write_file',
  'write_audit_findings',
])
const EFFECTFUL_VALIDATION_TOOLS = new Set<ToolName>([
  'run_file_change_hooks',
  'run_targeted_validation',
])
const HIDDEN_TOOLS = new Set<ToolName>([
  'add_message',
  'add_subgoal',
  'end_turn',
  'set_messages',
  'set_output',
  'spawn_agent_inline',
  'task_completed',
  'think_deeply',
  'update_subgoal',
])
const CUSTOM_RENDERERS = new Set<ToolName>([
  'edit_transaction',
  'query_index',
  'read_files',
  'read_subtree',
  'run_file_change_hooks',
  'run_terminal_command',
  'skill',
  'str_replace',
  'suggest_followups',
  'write_todos',
])
const NAMED_PATH_TOOLS = new Set<ToolName>([
  'create_plan',
  'replace_range',
  'rewrite_symbol',
  'str_replace',
  'update_plan_status',
  'write_file',
  'write_audit_findings',
  'inspect_3d_asset',
  'render_3d_preview',
])
const PATH_INPUTS: Partial<Record<ToolName, readonly string[]>> = {
  create_plan: ['path'],
  edit_transaction: ['edits[].path'],
  edit_3d_asset: ['path'],
  inspect_3d_asset: ['path'],
  render_3d_preview: ['path'],
  read_files: [
    'paths[]',
    'ranges[].path',
    'windows[].path',
    'around[].path',
    'symbol[].path',
    'symbols[].path',
  ],
  read_outline: ['path'],
  read_subtree: ['paths[]'],
  replace_range: ['path'],
  rewrite_symbol: ['path'],
  str_replace: ['path'],
  update_plan_status: ['path'],
  write_file: ['path'],
  write_audit_findings: ['sessionSlug', 'shardId'],
}

const quarantined = new Set<ToolName>(quarantinedToolNames)
const nonCanonicalMutationResultTools = new Set<ToolName>([
  'update_plan_status',
  // Dedicated artifact sink returns its own compact receipt rather than a
  // project-file mutation envelope.
  'write_audit_findings',
])

function metadataFor(toolName: ToolName): ToolMetadata {
  const kind: ToolBehaviorKind = READ_TOOLS.has(toolName)
    ? 'read'
    : EFFECTFUL_VALIDATION_TOOLS.has(toolName)
      ? 'other'
      : MUTATION_TOOLS.has(toolName)
        ? 'mutation'
        : HIDDEN_TOOLS.has(toolName)
          ? 'control'
          : 'other'
  const reachability: ToolReachability = quarantined.has(toolName)
    ? 'quarantined'
    : HIDDEN_TOOLS.has(toolName)
      ? 'internal'
      : 'active'

  return {
    kind,
    scheduling:
      kind === 'read'
        ? 'read_only'
        : NAMED_PATH_TOOLS.has(toolName)
          ? 'named_path'
          : 'global',
    pathInputs: PATH_INPUTS[toolName] ?? [],
    resultContract:
      toolName === 'read_files'
        ? 'read_v1'
        : kind === 'mutation'
          ? nonCanonicalMutationResultTools.has(toolName)
            ? 'legacy_v0'
            : 'mutation_v1'
          : 'legacy_v0',
    renderer: HIDDEN_TOOLS.has(toolName)
      ? 'hidden'
      : CUSTOM_RENDERERS.has(toolName)
        ? 'custom'
        : 'fallback',
    includeInMutationSummary: kind === 'mutation',
    reachability,
    promptVisible: reachability === 'active',
    deprecated: false,
  }
}

export const toolMetadata = Object.fromEntries(
  toolNames.map((toolName) => [toolName, metadataFor(toolName)]),
) as Record<ToolName, ToolMetadata>

/**
 * Tool names that were removed from the registry but still appear verbatim in
 * persisted artifacts (CLI chat blocks, tool-call histories). Restored sessions
 * are rendered and summarized by looking metadata up from the persisted string,
 * so the lookup must stay total for these names instead of resolving to
 * `undefined` and throwing on the first property access.
 */
export const removedToolNames = [
  'apply_patch',
  'apply_smart_patch',
  'read_slices',
] as const
export type RemovedToolName = (typeof removedToolNames)[number]

/**
 * Removed edit tools keep mutation classification so restored histories still
 * count them in mutation summaries and render their recorded diffs. That claim
 * only holds while a surviving consumer can read the persisted legacy call
 * envelope (`{ operation: { path, diff } }` or `{ input: [{ path, diff }] }`),
 * which the generic `input.path` / `input.content` helpers cannot: the CLI tool
 * registry therefore requires a dedicated renderer
 * (cli/src/components/tools/apply-patch.tsx) for every removed mutation-kind
 * name and fails at load when one is missing.
 */
const REMOVED_MUTATION_TOOLS = new Set<string>([
  'apply_patch',
  'apply_smart_patch',
])

function removedMetadataFor(toolName: string): ToolMetadata {
  const kind: ToolBehaviorKind = REMOVED_MUTATION_TOOLS.has(toolName)
    ? 'mutation'
    : 'read'
  return {
    kind,
    scheduling: kind === 'read' ? 'read_only' : 'named_path',
    // A removed tool is never executed again, so it scopes no live path input.
    pathInputs: [],
    resultContract: 'legacy_v0',
    renderer: 'fallback',
    includeInMutationSummary: kind === 'mutation',
    reachability: 'removed',
    promptVisible: false,
    deprecated: true,
  }
}

export const removedToolMetadata = Object.fromEntries(
  removedToolNames.map((toolName) => [toolName, removedMetadataFor(toolName)]),
) as Record<RemovedToolName, ToolMetadata>

/**
 * Fallback record for a name that is neither native nor removed: custom tools,
 * MCP tools, and any other unrecognized string. Deliberately NOT the
 * removed-tool record, so a live custom/MCP tool is never reported as removed
 * or deprecated through the public metadata contract. Unknown behavior gets the
 * most conservative scheduling scope and no mutation-summary participation.
 */
const UNKNOWN_TOOL_METADATA: ToolMetadata = {
  kind: 'other',
  scheduling: 'global',
  pathInputs: [],
  resultContract: 'legacy_v0',
  renderer: 'fallback',
  includeInMutationSummary: false,
  reachability: 'unknown',
  promptVisible: false,
  deprecated: false,
}

// A name that is both registered and listed as removed is a registry bug: the
// two exported surfaces (`toolMetadata` / `getToolMetadata`) would disagree.
// Fail loudly at module load instead of resolving the name two different ways.
const reregisteredRemovedToolNames = removedToolNames.filter((toolName) =>
  (toolNames as readonly string[]).includes(toolName),
)
if (reregisteredRemovedToolNames.length > 0) {
  throw new Error(
    `Tool names cannot be both registered and removed: ${reregisteredRemovedToolNames.join(', ')}`,
  )
}

// Native metadata is spread last so it always wins: `getToolMetadata(name)` can
// never contradict the exported `toolMetadata[name]` for a registered tool.
const metadataByToolName: Record<string, ToolMetadata> = {
  ...removedToolMetadata,
  ...toolMetadata,
}

/**
 * Total metadata lookup. Native tool names resolve to their registered
 * metadata; removed/legacy names resolve to a deprecated compatibility record;
 * any other string (custom tool, MCP tool, unrecognized persisted name)
 * resolves to the neutral `unknown` record, so rendering a restored session can
 * never dereference `undefined` and a live tool is never mislabeled as removed.
 */
export function getToolMetadata(
  toolName: ToolName | RemovedToolName | (string & {}),
): ToolMetadata {
  return metadataByToolName[toolName] ?? UNKNOWN_TOOL_METADATA
}
