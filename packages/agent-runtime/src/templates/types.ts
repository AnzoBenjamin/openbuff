import { AgentTemplateTypes } from '@codebuff/common/types/session-state'

import type { ToolName } from '@codebuff/common/tools/constants'
import type {
  AgentTemplate,
  StepGenerator,
  StepHandler,
} from '@codebuff/common/types/agent-template'
import type { AgentTemplateType } from '@codebuff/common/types/session-state'

// Re-export for backward compatibility
export type { AgentTemplate, StepGenerator, StepHandler }

const placeholderNames = [
  'AGENT_NAME',
  'CURRENT_DATE',
  'FILE_TREE_PROMPT_SMALL',
  'FRONTEND_SECTION',
  'FILE_TREE_PROMPT',
  'FILE_TREE_PROMPT_LARGE',
  'LANGUAGE_PROFILE',
  'GIT_CHANGES_PROMPT',
  'INITIAL_AGENT_PROMPT',
  'KNOWLEDGE_FILES_CONTENTS',
  // T1.4d guide recovery: ONE placeholder per relocated guide, so a mode that
  // deliberately omits a pointer (plan mode omits git-discipline) omits its
  // recovery too. The broad-audit body is clause-parameterized, so it has one
  // placeholder per finalize clause; base2 emits the one whose clause it
  // actually disclosed.
  'ON_DEMAND_GUIDE_FALLBACK_CODE_CRAFTSMANSHIP',
  'ON_DEMAND_GUIDE_FALLBACK_PRE_REVIEW_SELF_CHECK',
  'ON_DEMAND_GUIDE_FALLBACK_GIT_DISCIPLINE',
  'ON_DEMAND_GUIDE_FALLBACK_SECURITY_REVIEW',
  'ON_DEMAND_GUIDE_FALLBACK_SPECIALIST_ROUTING',
  'ON_DEMAND_GUIDE_FALLBACK_BROAD_AUDIT',
  'ON_DEMAND_GUIDE_FALLBACK_BROAD_AUDIT_PLAN',
  'PROJECT_ROOT',
  'ROUTED_KNOWLEDGE_FILES',
  'PATTERNS_INDEX',
  'REMAINING_STEPS',
  'SYSTEM_INFO_PROMPT',
  'USER_CWD',
  'USER_INPUT_PROMPT',
] as const

type PlaceholderType<T extends typeof placeholderNames> = {
  [K in T[number]]: `{CODEBUFF_${K}}`
}

export const PLACEHOLDER = Object.fromEntries(
  placeholderNames.map((name) => [name, `{CODEBUFF_${name}}` as const]),
) as PlaceholderType<typeof placeholderNames>
export type PlaceholderValue = (typeof PLACEHOLDER)[keyof typeof PLACEHOLDER]

export const placeholderValues = Object.values(PLACEHOLDER)

export const baseAgentToolNames: ToolName[] = [
  'create_plan',
  'run_terminal_command',
  'str_replace',
  'write_file',
  'spawn_agents',
  'add_subgoal',
  'browser_logs',
  'code_search',
  'end_turn',
  'read_files',
  'read_image',
  'think_deeply',
  'update_subgoal',
] as const

export const baseAgentSubagents: AgentTemplateType[] = [
  AgentTemplateTypes.file_picker,
  AgentTemplateTypes.researcher,
  AgentTemplateTypes.thinker,
  AgentTemplateTypes.reviewer,
] as const
