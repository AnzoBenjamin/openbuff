/**
 * Plan mode is read-only. One source for which native tools a plan-mode
 * lineage (the root plan agent and every agent it spawns) may not call.
 *
 * Consumers:
 * - packages/agent-runtime/src/tools/plan-mode-guard.ts refuses these at
 *   dispatch with a `plan_mode_read_only` error;
 * - agents/base2/tool-tiers.ts withholds them from the plan-mode surface;
 * - cli/src/utils/local-agent-registry.ts drops spawnable agents that declare
 *   any of them from plan-mode templates.
 *
 * Not listed, and handled elsewhere:
 * - `run_terminal_command`: allowed, but the runtime clamps plan lineage to the
 *   `read-only` terminal profile and the SDK enforces that profile.
 * - `kill_job`: allowed only for jobs the plan lineage started itself.
 * - `browser_logs`: its handler already allows only read-only actions in plan
 *   lineage.
 */
export const PLAN_MODE_READ_ONLY_ERROR_CODE = 'plan_mode_read_only' as const
export type PlanModeReadOnlyErrorCode = typeof PLAN_MODE_READ_ONLY_ERROR_CODE

/**
 * Plan artifacts a plan lineage must still be able to write. All three write
 * only runtime-owned paths under `.agents/sessions/`, never project source.
 * `write_audit_findings` is included because plan mode runs broad audits:
 * base2-plan's audit flow has general-agent shards persist findings with it
 * (agents/guides/broad-audit.md) and then plans from them.
 */
export const PLAN_MODE_ALLOWED_ARTIFACT_TOOL_NAMES = [
  'create_plan',
  'update_plan_status',
  'write_audit_findings',
] as const

/**
 * Tools that change the workspace, git state or run project hooks/validation.
 * Every metadata `kind: 'mutation'` tool except the plan artifacts must be
 * listed here; agents/tool-reachability.test.ts checks it.
 */
export const PLAN_MODE_REFUSED_TOOL_NAMES = [
  'write_file',
  'str_replace',
  'replace_range',
  'edit_transaction',
  'rewrite_symbol',
  'rename_symbol',
  'extract_symbol',
  'code_action',
  'edit_3d_asset',
  'git_branch',
  'run_file_change_hooks',
  'run_targeted_validation',
] as const

const REFUSED: ReadonlySet<string> = new Set(PLAN_MODE_REFUSED_TOOL_NAMES)

/** True when a plan-mode lineage may never call `toolName`. */
export function isPlanModeRefusedTool(toolName: string): boolean {
  return REFUSED.has(toolName)
}

/**
 * True when an agent declaring these tools can mutate the workspace even
 * under plan-mode clamping, so plan-mode templates must not spawn it.
 */
export function agentHasPlanModeRefusedTools(
  toolNames: readonly string[] | undefined,
): boolean {
  return (toolNames ?? []).some(isPlanModeRefusedTool)
}
