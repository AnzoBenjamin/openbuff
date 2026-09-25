import { afterEach, describe, expect, test } from 'bun:test'

import { JUDGE_MODEL_CONFIG, getJudgeModel } from './constants'

const ENV_KEYS = Object.keys(JUDGE_MODEL_CONFIG).map(
  (judgeId) =>
    'BUFFBENCH_JUDGE_MODEL_' +
    judgeId.replace(/[^a-zA-Z0-9]/g, '_').toUpperCase(),
)

function clearEnvOverrides(): void {
  for (const envKey of ENV_KEYS) {
    delete process.env[envKey]
  }
}

describe('JUDGE_MODEL_CONFIG / getJudgeModel (M5-T7-R1b)', () => {
  afterEach(clearEnvOverrides)

  test('pins a model for every judge id, keyed by the allowlisted roster id', () => {
    // agents/__tests__/roster-drift.test.ts allowlists judge-gpt,
    // judge-gemini, and judge-claude — the registry keys must match exactly
    // (the old 'judge-sonnet' key vs 'judge-claude' id mismatch is fixed).
    expect(Object.keys(JUDGE_MODEL_CONFIG).sort()).toEqual([
      'judge-claude',
      'judge-gemini',
      'judge-gpt',
    ])
    expect(JUDGE_MODEL_CONFIG['judge-gpt']).toMatch(/^openai\//)
    expect(JUDGE_MODEL_CONFIG['judge-gemini']).toMatch(/^google\//)
    expect(JUDGE_MODEL_CONFIG['judge-claude']).toMatch(/^anthropic\//)
  })

  test('returns the pinned model when no env override is set', () => {
    clearEnvOverrides()
    expect(getJudgeModel('judge-gpt')).toBe(JUDGE_MODEL_CONFIG['judge-gpt'])
    expect(getJudgeModel('judge-claude')).toBe(
      JUDGE_MODEL_CONFIG['judge-claude'],
    )
  })

  test('env override BUFFBENCH_JUDGE_MODEL_JUDGE_GPT takes precedence', () => {
    process.env.BUFFBENCH_JUDGE_MODEL_JUDGE_GPT = 'openai/gpt-override'
    expect(getJudgeModel('judge-gpt')).toBe('openai/gpt-override')
    // Untouched judges keep their pinned defaults.
    expect(getJudgeModel('judge-gemini')).toBe(
      JUDGE_MODEL_CONFIG['judge-gemini'],
    )
  })

  test('an empty env override does not shadow the pinned default', () => {
    // An unset/empty variable must not produce an empty model id.
    process.env.BUFFBENCH_JUDGE_MODEL_JUDGE_CLAUDE = ''
    expect(getJudgeModel('judge-claude')).toBe(
      JUDGE_MODEL_CONFIG['judge-claude'],
    )
  })
})
