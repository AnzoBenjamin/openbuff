export const PROMPT_PREFIX =
  'Fix the following issue. Keep going until you have completely fixed the ' +
  'issue. Do not ask me any follow-up questions, just do your best to ' +
  'interpret the intent of the issue.\n\n-----\n\n'

/**
 * Pinned judge-model ids per judge agent (M5-T7-R1b). Providers occasionally
 * update model snapshots under the same id; pinning them here (instead of
 * ambient literals in judge.ts) keeps judge severity comparable between runs
 * and gives a single config key to bump deliberately.
 */
export const JUDGE_MODEL_CONFIG = {
  'judge-gpt': 'openai/gpt-5.4',
  'judge-gemini': 'google/gemini-3.1-pro-preview',
  'judge-claude': 'anthropic/claude-sonnet-4.6',
} as const

export type JudgeId = keyof typeof JUDGE_MODEL_CONFIG

/**
 * Resolve the model for a judge agent id, allowing a per-judge env override:
 * `BUFFBENCH_JUDGE_MODEL_<NORMALIZED_ID>` (non-alphanumeric characters in the
 * judge id become '_', then uppercase — 'judge-gpt' →
 * `BUFFBENCH_JUDGE_MODEL_JUDGE_GPT`). Falls back to the pinned config value.
 */
export function getJudgeModel(judgeId: JudgeId): string {
  const envKey =
    'BUFFBENCH_JUDGE_MODEL_' +
    judgeId.replace(/[^a-zA-Z0-9]/g, '_').toUpperCase()
  // `||` (not `??`) so an exported-but-empty variable falls back to the pinned
  // default instead of producing an empty model id.
  return process.env[envKey] || JUDGE_MODEL_CONFIG[judgeId]
}
