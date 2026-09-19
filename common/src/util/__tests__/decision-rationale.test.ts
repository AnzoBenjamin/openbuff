import { describe, expect, test } from 'bun:test'

import {
  DECISION_RATIONALE_MIN_LENGTH,
  hasDecisionRationale,
} from '../decision-rationale'

describe('hasDecisionRationale', () => {
  test('returns false for short text (<24) even with a marker', () => {
    expect(hasDecisionRationale('short because')).toBe(false)
    expect('short because'.length < DECISION_RATIONALE_MIN_LENGTH).toBe(true)
  })

  test('returns false for long text with no rationale marker', () => {
    expect(
      hasDecisionRationale('Updated the config file today for the release'),
    ).toBe(false)
  })

  test('returns true for long text containing a marker', () => {
    expect(
      hasDecisionRationale(
        'Chose Postgres because sessions must survive restarts',
      ),
    ).toBe(true)
    expect(
      hasDecisionRationale('Used a queue instead of a cron loop for throughput'),
    ).toBe(true)
    expect(
      hasDecisionRationale('Sessions must survive restarts across deployments'),
    ).toBe(true)
  })

  test('is case-insensitive', () => {
    expect(
      hasDecisionRationale('BECAUSE the system needs to persist state reliably'),
    ).toBe(true)
  })
})
