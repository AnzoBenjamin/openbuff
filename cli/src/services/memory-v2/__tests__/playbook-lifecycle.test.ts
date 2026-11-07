import { describe, expect, test } from 'bun:test'

import {
  computeTriggerSignature,
  MemoryPlaybookSchema,
  type MemoryPlaybook,
  type PlaybookCounters,
  type PlaybookScope,
  type PlaybookTrigger,
} from '../../../../../common/src/types/memory-playbook'

import { evaluatePlaybookLifecycle } from '../playbook-lifecycle'

const DAY_MS = 24 * 60 * 60 * 1000
/** Injected evaluation clock; the evaluator itself must never read one. */
const NOW = 1_800_000_000_000

const TRIGGER: PlaybookTrigger = {
  tool: 'run_terminal_command',
  requireEvidence: [],
}
const SCOPE: PlaybookScope = { repos: [] }
const TRIGGER_SIGNATURE = computeTriggerSignature(TRIGGER, SCOPE)

/** Zeroed counters with per-case overrides (mirrors the schema defaults). */
function counters(
  overrides: Partial<PlaybookCounters> = {},
): PlaybookCounters {
  return {
    fired: 0,
    blocked: 0,
    compliedAfterBlock: 0,
    falsePositives: 0,
    bypassed: 0,
    ...overrides,
  }
}

type PlaybookFixtureOverrides = Partial<Omit<MemoryPlaybook, 'counters'>> & {
  playbookId: string
  counters?: PlaybookCounters
}

function makePlaybook(overrides: PlaybookFixtureOverrides): MemoryPlaybook {
  const { playbookId } = overrides
  return MemoryPlaybookSchema.parse({
    schemaVersion: 1,
    // playbookId is required in PlaybookFixtureOverrides and arrives via
    // the overrides spread below, so restating it here would be overwritten.
    workspaceId: 'workspace-1',
    title: `Rule ${playbookId}`,
    instruction: 'Run the repository CI check before continuing.',
    trigger: TRIGGER,
    scope: SCOPE,
    status: 'active',
    enforcement: 'warn',
    counters: counters(),
    provenance: {
      origin: 'repository',
      recordedBy: 'test',
      sourceEventIds: [],
      metadata: {},
    },
    triggerSignature: TRIGGER_SIGNATURE,
    createdAt: NOW - DAY_MS,
    updatedAt: NOW - DAY_MS,
    ...overrides,
  })
}

function evaluate(playbook: MemoryPlaybook) {
  return evaluatePlaybookLifecycle([playbook], { nowMs: NOW })
}

describe('evaluatePlaybookLifecycle', () => {
  test('returns no actions for an empty store', () => {
    expect(evaluatePlaybookLifecycle([], { nowMs: NOW })).toEqual([])
  })

  test('promotes an inject-only rule with 8 clean fires, including the 14-day recency boundary', () => {
    const [action] = evaluate(
      makePlaybook({
        playbookId: 'pb-promote',
        enforcement: 'inject-only',
        counters: counters({
          fired: 8,
          lastFiredAt: NOW - 14 * DAY_MS,
        }),
      }),
    )
    expect(action?.kind).toBe('promote')
    expect(action?.from).toBe('active')
    expect(action?.to).toBe('active')
    expect(action?.flipEnforcement).toBe('warn')
    expect(action?.title).toBe('Rule pb-promote')
    expect(action?.reason).toContain('zero false positives')
  })

  test('does not promote when a promote condition fails', () => {
    const cases: PlaybookCounters[] = [
      // fired below 8
      counters({ fired: 7, lastFiredAt: NOW - DAY_MS }),
      // any false positive disqualifies
      counters({ fired: 8, falsePositives: 1, lastFiredAt: NOW - DAY_MS }),
      // last fire 15 days old (outside the 14-day window)
      counters({ fired: 8, lastFiredAt: NOW - 15 * DAY_MS }),
      // never fired: lastFiredAt unset
      counters({ fired: 8 }),
    ]
    for (const fixture of cases) {
      expect(
        evaluate(
          makePlaybook({
            playbookId: 'pb-no-promote',
            enforcement: 'inject-only',
            counters: fixture,
          }),
        ),
      ).toEqual([])
    }
    // A non-inject-only row never promotes, however clean its counters.
    expect(
      evaluate(
        makePlaybook({
          playbookId: 'pb-warn-rule',
          enforcement: 'warn',
          counters: counters({ fired: 8, lastFiredAt: NOW - DAY_MS }),
        }),
      ),
    ).toEqual([])
  })

  test('verifies an enforced rule with strong gate counters', () => {
    const [action] = evaluate(
      makePlaybook({
        playbookId: 'pb-verify',
        counters: counters({
          fired: 10,
          blocked: 3,
          compliedAfterBlock: 3,
        }),
      }),
    )
    expect(action?.kind).toBe('verify')
    expect(action?.from).toBe('active')
    expect(action?.to).toBe('verified')
    expect(action?.flipEnforcement).toBeUndefined()
  })

  test('verifies warn- and block-enforced rules alike', () => {
    for (const enforcement of ['warn', 'block'] as const) {
      const [action] = evaluate(
        makePlaybook({
          playbookId: `pb-verify-${enforcement}`,
          enforcement,
          counters: counters({
            fired: 10,
            blocked: 3,
            compliedAfterBlock: 3,
          }),
        }),
      )
      expect(action?.kind).toBe('verify')
    }
  })

  test('verifies a rule with one false positive at the 10% ratio boundary', () => {
    const [action] = evaluate(
      makePlaybook({
        playbookId: 'pb-verify-fp1',
        counters: counters({
          fired: 10,
          blocked: 3,
          compliedAfterBlock: 3,
          falsePositives: 1,
        }),
      }),
    )
    expect(action?.kind).toBe('verify')
  })

  test('does not verify when a verify condition fails', () => {
    const cases: PlaybookCounters[] = [
      // fired below 10
      counters({ fired: 9, blocked: 3, compliedAfterBlock: 3 }),
      // blocked below 3
      counters({ fired: 10, blocked: 2, compliedAfterBlock: 3 }),
      // compliedAfterBlock below 3
      counters({ fired: 10, blocked: 3, compliedAfterBlock: 2 }),
      // more than one false positive
      counters({
        fired: 10,
        blocked: 3,
        compliedAfterBlock: 3,
        falsePositives: 2,
      }),
      // false positives at 11% of fires (above the 10% ratio)
      counters({
        fired: 100,
        blocked: 3,
        compliedAfterBlock: 3,
        falsePositives: 11,
      }),
      // one false positive among 9 fires: the count condition passes (≤ 1)
      // while the ratio (11.1%) independently exceeds the 10% cap
      counters({
        fired: 9,
        blocked: 3,
        compliedAfterBlock: 3,
        falsePositives: 1,
      }),
      // bypassed above 1
      counters({
        fired: 10,
        blocked: 3,
        compliedAfterBlock: 3,
        bypassed: 2,
      }),
    ]
    for (const fixture of cases) {
      expect(
        evaluate(
          makePlaybook({ playbookId: 'pb-no-verify', counters: fixture }),
        ),
      ).toEqual([])
    }
  })

  test('an inject-only row never verifies; its clean counters promote instead', () => {
    const actions = evaluate(
      makePlaybook({
        playbookId: 'pb-shadow',
        enforcement: 'inject-only',
        counters: counters({
          fired: 10,
          blocked: 3,
          compliedAfterBlock: 3,
          lastFiredAt: NOW - DAY_MS,
        }),
      }),
    )
    expect(actions).toHaveLength(1)
    expect(actions[0]?.kind).toBe('promote')
    expect(actions[0]?.to).toBe('active')
  })

  test('retires a noisy rule at the false-positive ratio boundary', () => {
    const [action] = evaluate(
      makePlaybook({
        playbookId: 'pb-noise',
        counters: counters({ fired: 4, falsePositives: 2 }),
      }),
    )
    expect(action?.kind).toBe('retire-noise')
    expect(action?.from).toBe('active')
    expect(action?.to).toBe('retired')
    expect(action?.reason).toContain('false positives')
  })

  test('retires on the bypass ratio boundary', () => {
    const [action] = evaluate(
      makePlaybook({
        playbookId: 'pb-bypassed',
        counters: counters({ fired: 10, bypassed: 3 }),
      }),
    )
    expect(action?.kind).toBe('retire-noise')
    expect(action?.reason).toContain('bypassed')
  })

  test('does not retire noise below the fired floor or the ratios', () => {
    const cases: PlaybookCounters[] = [
      // below the fired >= 4 floor, even at 66% false positives
      counters({ fired: 3, falsePositives: 2 }),
      // 40% false positives (below the 50% ratio)
      counters({ fired: 5, falsePositives: 2 }),
      // 29% bypassed (below the 30% ratio)
      counters({ fired: 100, bypassed: 29 }),
    ]
    for (const fixture of cases) {
      expect(
        evaluate(
          makePlaybook({ playbookId: 'pb-quiet', counters: fixture }),
        ),
      ).toEqual([])
    }
  })

  test('noise retires any non-retired row, including a verified one', () => {
    const [action] = evaluate(
      makePlaybook({
        playbookId: 'pb-verified-noise',
        status: 'verified',
        counters: counters({ fired: 10, falsePositives: 5 }),
      }),
    )
    expect(action?.kind).toBe('retire-noise')
    expect(action?.from).toBe('verified')
    expect(action?.to).toBe('retired')
  })

  test('retires a stale inject-only rule that never earned its keep', () => {
    const [action] = evaluate(
      makePlaybook({
        playbookId: 'pb-dud',
        enforcement: 'inject-only',
        createdAt: NOW - 31 * DAY_MS,
        counters: counters({ fired: 1 }),
      }),
    )
    expect(action?.kind).toBe('retire-dud')
    expect(action?.from).toBe('active')
    expect(action?.to).toBe('retired')
    expect(action?.reason).toContain('dud')
  })

  test('does not retire a dud at the age boundary, with two fires, or when enforced', () => {
    const stale = { enforcement: 'inject-only' as const }
    // Exactly 30 days old is not yet a dud (strictly greater-than).
    expect(
      evaluate(
        makePlaybook({
          playbookId: 'pb-dud-30d',
          ...stale,
          createdAt: NOW - 30 * DAY_MS,
          counters: counters({ fired: 1 }),
        }),
      ),
    ).toEqual([])
    // Two fires disqualify the dud path.
    expect(
      evaluate(
        makePlaybook({
          playbookId: 'pb-dud-2-fires',
          ...stale,
          createdAt: NOW - 31 * DAY_MS,
          counters: counters({ fired: 2 }),
        }),
      ),
    ).toEqual([])
    // An enforced rule is never retired on staleness alone.
    expect(
      evaluate(
        makePlaybook({
          playbookId: 'pb-old-warn',
          enforcement: 'warn',
          createdAt: NOW - 31 * DAY_MS,
          counters: counters({ fired: 1 }),
        }),
      ),
    ).toEqual([])
  })

  test('retire-noise beats promote on a row satisfying both', () => {
    const actions = evaluate(
      makePlaybook({
        playbookId: 'pb-noise-beats-promote',
        enforcement: 'inject-only',
        counters: counters({
          fired: 8,
          falsePositives: 4,
          lastFiredAt: NOW - DAY_MS,
        }),
      }),
    )
    expect(actions).toHaveLength(1)
    expect(actions[0]?.kind).toBe('retire-noise')
    expect(actions[0]?.to).toBe('retired')
  })

  test('retire-noise beats verify on a row satisfying both', () => {
    const actions = evaluate(
      makePlaybook({
        playbookId: 'pb-noise-beats-verify',
        counters: counters({
          fired: 10,
          blocked: 3,
          compliedAfterBlock: 3,
          falsePositives: 5,
        }),
      }),
    )
    expect(actions).toHaveLength(1)
    expect(actions[0]?.kind).toBe('retire-noise')
  })

  test('sorts actions by playbookId and yields at most one action per row', () => {
    const actions = evaluatePlaybookLifecycle(
      [
        makePlaybook({
          playbookId: 'pb-c',
          enforcement: 'inject-only',
          createdAt: NOW - 31 * DAY_MS,
          counters: counters({ fired: 1 }),
        }),
        makePlaybook({
          playbookId: 'pb-b',
          enforcement: 'inject-only',
          counters: counters({ fired: 8, lastFiredAt: NOW - DAY_MS }),
        }),
        makePlaybook({
          playbookId: 'pb-a',
          counters: counters({ fired: 10, blocked: 3, compliedAfterBlock: 3 }),
        }),
      ],
      { nowMs: NOW },
    )
    expect(actions.map(({ playbookId }) => playbookId)).toEqual([
      'pb-a',
      'pb-b',
      'pb-c',
    ])
    expect(actions.map(({ kind }) => kind)).toEqual([
      'verify',
      'promote',
      'retire-dud',
    ])
  })

  test('retired rows yield nothing', () => {
    const actions = evaluatePlaybookLifecycle(
      [
        makePlaybook({
          playbookId: 'pb-retired-noise',
          status: 'retired',
          counters: counters({ fired: 10, falsePositives: 9 }),
        }),
        makePlaybook({
          playbookId: 'pb-retired-dud',
          status: 'retired',
          enforcement: 'inject-only',
          createdAt: NOW - 31 * DAY_MS,
          counters: counters({ fired: 1 }),
        }),
      ],
      { nowMs: NOW },
    )
    expect(actions).toEqual([])
  })
})
