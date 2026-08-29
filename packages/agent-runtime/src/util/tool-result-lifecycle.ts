/**
 * Pure policy for when summarizable tool results stay full vs compress to a
 * receipt during context trim. Tags are applied at tool-result creation;
 * decisions use only tags / keepDuringTruncation / keep-slot age (no clock).
 */

export const TOOL_RESULT_LIFECYCLE_TAG = 'tool-result-lifecycle'
export const TOOL_RESULT_IMPORTANCE_HIGH_TAG = 'tool-result-importance:high'
export const TOOL_RESULT_IMPORTANCE_NORMAL_TAG = 'tool-result-importance:normal'
export const DEFAULT_FULL_TOOL_RESULTS_TO_KEEP = 1

const VERBOSE_LIFECYCLE_TOOLS = new Set([
  'query_index',
  'read_files',
  'read_blocks',
  'read_outline',
  'read_subtree',
  'code_search',
  'run_terminal_command',
  'web_search',
  'spawn_agents',
  'spawn_agent_inline',
])

const HIGH_IMPORTANCE_TOOLS = new Set(['spawn_agents', 'spawn_agent_inline'])

const PROTECTED_TAGS = new Set([
  TOOL_RESULT_IMPORTANCE_HIGH_TAG,
  'pinned',
  'pinned_active_work',
])

export function isVerboseLifecycleTool(toolName: string): boolean {
  return VERBOSE_LIFECYCLE_TOOLS.has(toolName)
}

/** Lifecycle tags for a new tool result; empty if the tool is not verbose. */
export function lifecycleTagsForToolResult(toolName: string): string[] {
  if (!isVerboseLifecycleTool(toolName)) {
    return []
  }
  return [
    TOOL_RESULT_LIFECYCLE_TAG,
    HIGH_IMPORTANCE_TOOLS.has(toolName)
      ? TOOL_RESULT_IMPORTANCE_HIGH_TAG
      : TOOL_RESULT_IMPORTANCE_NORMAL_TAG,
  ]
}

export function isProtectedToolResult(params: {
  keepDuringTruncation?: boolean
  tags?: string[]
}): boolean {
  if (params.keepDuringTruncation === true) {
    return true
  }
  const tags = params.tags
  if (!tags || tags.length === 0) {
    return false
  }
  return tags.some((tag) => PROTECTED_TAGS.has(tag))
}

/**
 * Whether a summarizable tool result should keep its full body while walking
 * newest→oldest.
 *
 * Protected results (keepDuringTruncation, high importance, or pinned tags)
 * always stay full and do **not** consume the keep-N budget, so the N newest
 * unprotected summarizable results still get full slots.
 */
export function shouldKeepFullToolResult(params: {
  toolName: string
  keepDuringTruncation?: boolean
  tags?: string[]
  /** How many *other* newer summarizable results were already kept full (0 = newest). */
  numFullKeptSoFar: number
  maxFullToKeep?: number
}): boolean {
  void params.toolName
  if (
    isProtectedToolResult({
      keepDuringTruncation: params.keepDuringTruncation,
      tags: params.tags,
    })
  ) {
    return true
  }
  const maxFullToKeep =
    params.maxFullToKeep ?? DEFAULT_FULL_TOOL_RESULTS_TO_KEEP
  return params.numFullKeptSoFar < maxFullToKeep
}
