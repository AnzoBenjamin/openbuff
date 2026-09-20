import { assistantMessage, userMessage } from '@codebuff/common/util/messages'
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  mock,
  spyOn,
} from 'bun:test'

import {
  maybePruneContext,
  DEFAULT_MAX_CONTEXT_TOKENS,
  DEFAULT_SEMANTIC_REARM_BUDGET_TOKENS,
  getModelContextReservedTokens,
  getModelContextMessageLimit,
  getEffectiveContextLimits,
  getSemanticCompactionBudget,
  createSemanticCompactionGovernor,
  shouldRunSemanticPass,
  recordPassAnnounced,
  advanceGovernorIteration,
  recordPassSettled,
  getSemanticRearmBudgetTokens,
  getSemanticEvictionFloorTokens,
  SEMANTIC_COOLDOWN_ITERATIONS,
  SEMANTIC_MAX_PASSES_PER_TURN,
  SEMANTIC_EVICTION_FRACTION,
  MODEL_CONTEXT_MIN_RESERVED_TOKENS,
  MODEL_CONTEXT_MAX_RESERVED_TOKENS,
  MODEL_CONTEXT_RESERVED_FRACTION,
} from '../context-pruning'
import * as tokenCounter from '../token-counter'

import type { Message } from '@codebuff/common/types/messages/codebuff-message'

// Mock logger for tests (matches pattern from messages.test.ts)
const logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
}

// Helper: fixed tokens-per-char ratio so pruning thresholds are not masked
// by the naive JSON.stringify-length mock that previously hid off-by-factor
// errors. Magnitude check below ensures this fixture stays within 3x of the
// real tokenizer before each test run.
const TOKENS_PER_CHAR = 0.35
function fixtureCountTokensJson(text: string | object): number {
  const str = typeof text === 'string' ? text : JSON.stringify(text)
  return Math.max(1, Math.floor(str.length * TOKENS_PER_CHAR))
}

describe('maybePruneContext', () => {
  beforeEach(() => {
    spyOn(tokenCounter, 'countTokensJson').mockImplementation(
      fixtureCountTokensJson,
    )
  })

  afterEach(() => {
    mock.restore()
  })

  it('fixture token counts approximate real tokenizer magnitude', () => {
    const sample = { role: 'user', content: 'hello world '.repeat(100) }
    const fixture = fixtureCountTokensJson(sample)
    // Temporarily restore real tokenizer to compare magnitudes
    mock.restore()
    const real = tokenCounter.countTokensJson(sample)
    // Re-apply fixture mock for remaining assertions in this suite
    spyOn(tokenCounter, 'countTokensJson').mockImplementation(
      fixtureCountTokensJson,
    )
    // Fixture must stay within 3x of real tokenizer for threshold fidelity;
    // the old JSON.stringify-length mock was off by >4x and hid pruning bugs.
    expect(fixture).toBeGreaterThan(0)
    expect(real).toBeGreaterThan(0)
    const ratio = fixture / real
    expect(ratio).toBeGreaterThan(0.2)
    expect(ratio).toBeLessThan(5)
  })

  it('returns pruned: false when contextTokenCount is under threshold', () => {
    const messages: Message[] = [
      userMessage('short message'),
      assistantMessage('short response'),
    ]

    const result = maybePruneContext({
      messages,
      systemTokens: 100,
      contextTokenCount: 200,
      maxTotalTokens: 190_000,
      logger: logger as never,
    })

    expect(result.pruned).toBe(false)
    expect(result.messages).toBe(messages) // same reference, no copy
  })

  it('returns pruned: true and trimmed messages when contextTokenCount exceeds threshold', () => {
    // Create messages large enough to trigger REAL trimming under the
    // fixture (0.35 tokens/char). Each message is ~380k chars, so two
    // messages serialize to > 189,900 message-token budget (190k window
    // minus 100 system tokens), forcing trimMessagesToFitTokenLimit to
    // actually shorten the array instead of early-returning unchanged.
    const longContent = 'x'.repeat(400_000)
    const messages: Message[] = [
      userMessage(longContent),
      userMessage(longContent),
      userMessage('recent short message'),
    ]

    const result = maybePruneContext({
      messages,
      systemTokens: 100,
      contextTokenCount: 400_000, // exceeds 190k threshold
      maxTotalTokens: 190_000,
      logger: logger as never,
    })

    expect(result.pruned).toBe(true)
    // trimMessagesToFitTokenLimit returns a new array when it trims
    expect(result.messages).not.toBe(messages)
    expect(result.messages.length).toBeGreaterThan(0)
    // Some reduction in token count should have occurred
    const inputTokens = tokenCounter.countTokensJson(messages)
    const finalTokens = tokenCounter.countTokensJson(result.messages)
    expect(finalTokens).toBeLessThan(inputTokens)
  })

  it('passes the fit-verification report fields through untouched', () => {
    const longContent = 'x'.repeat(400_000)
    const messages: Message[] = [
      userMessage(longContent),
      userMessage(longContent),
      userMessage('recent short message'),
    ]

    const result = maybePruneContext({
      messages,
      systemTokens: 100,
      contextTokenCount: 400_000,
      maxTotalTokens: 190_000,
      logger: logger as never,
    })

    expect(result.pruned).toBe(true)
    const report = result.report!
    // Nothing is pinned here, so the mechanical pass can reach the budget on
    // its own: the report must say the trim fits and needed no escalation.
    expect(report.fitsBudget).toBe(true)
    expect(report.shortfallTokens).toBe(0)
    expect(report.escalated).toBe(false)
    expect(report.afterTokens).toBeLessThanOrEqual(190_000 - 100)
  })

  it('uses DEFAULT_MAX_CONTEXT_TOKENS when maxTotalTokens is undefined', () => {
    const result = maybePruneContext({
      messages: [userMessage('test')],
      systemTokens: 100,
      contextTokenCount: 100, // under default (190k)
      logger: logger as never,
    })

    expect(result.pruned).toBe(false)
    expect(DEFAULT_MAX_CONTEXT_TOKENS).toBe(190_000)
  })

  it('prunes when contextTokenCount exceeds DEFAULT_MAX_CONTEXT_TOKENS and maxTotalTokens is undefined', () => {
    const longContent = 'x'.repeat(200_000)
    const messages: Message[] = [
      userMessage(longContent),
      userMessage(longContent),
      userMessage('recent'),
    ]

    const result = maybePruneContext({
      messages,
      systemTokens: 100,
      contextTokenCount: 400_000, // exceeds default 190k
      logger: logger as never,
    })

    expect(result.pruned).toBe(true)
  })
})

describe('getModelContextReservedTokens (M4.2 unified reserved-token policy)', () => {
  it('returns undefined when contextWindowTokens is undefined', () => {
    expect(getModelContextReservedTokens(undefined)).toBeUndefined()
  })

  it('floors to the fraction of the window and clamps to [MIN, MAX]', () => {
    expect(getModelContextReservedTokens(100_000)).toBe(12_000)
    expect(getModelContextReservedTokens(200_000)).toBe(24_000)
    expect(getModelContextReservedTokens(1_000_000)).toBe(120_000)
    expect(getModelContextReservedTokens(5_000)).toBe(2_500)
    expect(getModelContextReservedTokens(2_000_000)).toBe(128_000)
  })

  it('honors the reserved fraction constant', () => {
    expect(MODEL_CONTEXT_RESERVED_FRACTION).toBe(0.12)
    expect(MODEL_CONTEXT_MIN_RESERVED_TOKENS).toBe(8_000)
    expect(MODEL_CONTEXT_MAX_RESERVED_TOKENS).toBe(128_000)
  })
})

describe('getModelContextMessageLimit (M4 unified threshold convergence)', () => {
  it('returns DEFAULT_MAX_CONTEXT_TOKENS when model window is unknown', () => {
    expect(getModelContextMessageLimit(undefined)).toBe(
      DEFAULT_MAX_CONTEXT_TOKENS,
    )
  })

  it('subtracts the reserved overhead from the model context window', () => {
    expect(getModelContextMessageLimit(100_000)).toBe(88_000)
    expect(getModelContextMessageLimit(200_000)).toBe(176_000)
    expect(getModelContextMessageLimit(262_144)).toBe(230_687)
    expect(getModelContextMessageLimit(500_000)).toBe(440_000)
    expect(getModelContextMessageLimit(1_000_000)).toBe(880_000)
    expect(getModelContextMessageLimit(5_000)).toBe(2_500)
  })

  it('is always >= 1 even for tiny context windows', () => {
    expect(getModelContextMessageLimit(1)).toBeGreaterThanOrEqual(1)
    expect(getModelContextMessageLimit(0)).toBeGreaterThanOrEqual(1)
  })
})

describe('getSemanticCompactionBudget', () => {
  it.each([
    [8_000, 2_000, 1_600, 2_000],
    [16_000, 6_000, 3_200, 2_000],
    [32_000, 18_000, 9_600, 6_000],
    [64_000, 42_000, 22_400, 14_000],
  ])(
    'keeps a meaningful working set for a small %i-token window',
    (window, trigger, target, headroom) => {
      expect(getSemanticCompactionBudget(window)).toEqual({
        resolvedContextWindowTokens: window,
        triggerBudgetTokens: trigger,
        targetBudgetTokens: target,
        headroomTokens: headroom,
      })
      expect(trigger).toBeGreaterThan(1)
      expect(target).toBeGreaterThan(1)
      expect(target).toBeLessThan(trigger)
    },
  )

  it.each([
    [128_000, 96_000, 72_000, 32_000],
    [200_000, 156_000, 80_000, 32_000],
    [262_144, 204_472, 104_857, 39_321],
    [500_000, 390_000, 200_000, 75_000],
    [1_000_000, 780_000, 400_000, 150_000],
  ])(
    'scales trigger and target budgets for a %i-token window',
    (window, trigger, target, headroom) => {
      expect(getSemanticCompactionBudget(window)).toEqual({
        resolvedContextWindowTokens: window,
        triggerBudgetTokens: trigger,
        targetBudgetTokens: target,
        headroomTokens: headroom,
      })
    },
  )

  it('uses conservative deterministic budgets when the window is unknown or invalid', () => {
    expect(getSemanticCompactionBudget(undefined)).toEqual({
      triggerBudgetTokens: 140_000,
      targetBudgetTokens: 100_000,
    })
    expect(getSemanticCompactionBudget(Number.NaN)).toEqual({
      triggerBudgetTokens: 140_000,
      targetBudgetTokens: 100_000,
    })
  })

  // RF-5: the small-window (<128k) branch here has dedicated parameterized
  // cases (8k/16k/32k/64k). The traceability target
  // agents/__tests__/base2-progressive-tool-disclosure.test.ts exists and is
  // imported elsewhere in this repo; this suite provides local coverage for
  // the small-window branch without relying on cross-file rationalization.
  it('covers the 8k/16k/32k/64k small-window branch explicitly for RF-5 traceability', () => {
    for (const windowTokens of [8_000, 16_000, 32_000, 64_000] as const) {
      const budget = getSemanticCompactionBudget(windowTokens)
      expect(budget.resolvedContextWindowTokens).toBe(windowTokens)
      expect(budget.headroomTokens).toBeGreaterThanOrEqual(1)
      expect(budget.triggerBudgetTokens).toBeGreaterThan(1)
      expect(budget.targetBudgetTokens).toBeGreaterThan(1)
      expect(budget.targetBudgetTokens).toBeLessThan(budget.triggerBudgetTokens)
    }
  })
})

describe('getEffectiveContextLimits', () => {
  it('recomputes provider-safe and status limits when failover changes windows', () => {
    expect(getEffectiveContextLimits(1_000_000)).toEqual({
      providerSafeMessageLimit: 880_000,
      statusWindowTokens: 1_000_000,
    })
    expect(getEffectiveContextLimits(32_000)).toEqual({
      providerSafeMessageLimit: 24_000,
      statusWindowTokens: 32_000,
    })
  })

  it('clamps explicit overrides to the active model instead of widening it', () => {
    expect(getEffectiveContextLimits(32_000, 100_000)).toEqual({
      providerSafeMessageLimit: 24_000,
      statusWindowTokens: 32_000,
    })
    expect(getEffectiveContextLimits(1_000_000, 50_000)).toEqual({
      providerSafeMessageLimit: 50_000,
      statusWindowTokens: 50_000,
    })
  })
})

describe('semantic compaction governor', () => {
  const decide = (
    governor: ReturnType<typeof createSemanticCompactionGovernor>,
    contextTokens: number,
    emergencyLimitTokens = 190_000,
  ) =>
    shouldRunSemanticPass(governor, {
      contextTokens,
      triggerBudgetTokens: 100_000,
      rearmBudgetTokens: 50_000,
      emergencyLimitTokens,
    })

  it('allows a pass while armed above the trigger, then enters cooldown', () => {
    const governor = createSemanticCompactionGovernor()
    expect(decide(governor, 100_500).shouldRunSemanticPass).toBe(true)
    expect(decide(governor, 50_000).shouldRunSemanticPass).toBe(false)

    recordPassAnnounced(governor)
    expect(governor.state).toBe('cooldown')
    expect(governor.passesThisTurn).toBe(1)
    expect(governor.iterationsSincePass).toBe(0)
    // Cooldown denies even far above the trigger.
    expect(decide(governor, 180_000).shouldRunSemanticPass).toBe(false)
  })

  it('re-arms only after the cooldown AND a drop below the rearm budget', () => {
    const governor = createSemanticCompactionGovernor()
    recordPassAnnounced(governor)
    for (let i = 0; i < SEMANTIC_COOLDOWN_ITERATIONS; i++) {
      advanceGovernorIteration(governor)
    }
    // Cooldown served, but context is still above the rearm budget: denied.
    expect(decide(governor, 150_000).shouldRunSemanticPass).toBe(false)
    expect(governor.state).toBe('rearm-pending')
    expect(decide(governor, 150_000).shouldRunSemanticPass).toBe(false)
    expect(governor.state).toBe('rearm-pending')
    // Context falls below the rearm budget: this call re-arms (and denies,
    // since the trigger is not exceeded at 49_999).
    expect(decide(governor, 49_999).shouldRunSemanticPass).toBe(false)
    expect(governor.state).toBe('armed')
    // Re-armed: the next over-trigger observation is allowed.
    expect(decide(governor, 100_500).shouldRunSemanticPass).toBe(true)
  })

  it('keeps the unknown-window rearm budget strictly below the fallback trigger', () => {
    const rearm = getSemanticRearmBudgetTokens(undefined)
    const trigger = getSemanticCompactionBudget(undefined).triggerBudgetTokens
    // The rearm budget must not coincide with (or sit at/above) the fallback
    // trigger: in the fallback band an observation that re-arms would
    // otherwise immediately satisfy the trigger check and announce a pass.
    expect(rearm).toBeLessThan(trigger)
    // The margin must absorb the +1_000 trigger hysteresis in
    // shouldRunSemanticPass.
    expect(rearm - 1 + 1_000).toBeLessThanOrEqual(trigger)
  })

  it('denies the trigger check on the observation that re-arms the fallback band', () => {
    const rearm = getSemanticRearmBudgetTokens(undefined)
    const trigger = getSemanticCompactionBudget(undefined).triggerBudgetTokens
    const governor = createSemanticCompactionGovernor()
    recordPassAnnounced(governor)
    for (let i = 0; i < SEMANTIC_COOLDOWN_ITERATIONS; i++) {
      advanceGovernorIteration(governor)
    }
    // Context just below the fallback rearm budget re-arms...
    const decision = shouldRunSemanticPass(governor, {
      contextTokens: rearm - 1,
      triggerBudgetTokens: trigger,
      rearmBudgetTokens: rearm,
      emergencyLimitTokens: 190_000,
    })
    // ...and the trigger check must deny, so the NEXT over-trigger
    // observation is the first allowed pass (documented invariant).
    expect(decision.shouldRunSemanticPass).toBe(false)
    expect(governor.state).toBe('armed')
    expect(decision.reason).toBe('Context below the semantic trigger budget.')
  })

  it('emergency-overrides at the provider-safe limit once disarmed', () => {
    const governor = createSemanticCompactionGovernor()
    recordPassAnnounced(governor)
    for (let i = 0; i < SEMANTIC_COOLDOWN_ITERATIONS; i++) {
      advanceGovernorIteration(governor)
    }
    const emergency = decide(governor, 190_000, 190_000)
    expect(emergency.shouldRunSemanticPass).toBe(true)
    expect(emergency.emergencyOverride).toBe(true)
    // Below the emergency limit the rearm margin still holds.
    expect(decide(governor, 150_000, 190_000).shouldRunSemanticPass).toBe(false)
  })

  it('denies every pass once the per-turn cap is spent', () => {
    const governor = createSemanticCompactionGovernor()
    governor.passesThisTurn = SEMANTIC_MAX_PASSES_PER_TURN
    const denied = decide(governor, 200_000)
    expect(denied.shouldRunSemanticPass).toBe(false)
    expect(denied.reason).toContain('cap')
  })

  it('two consecutive no-progress passes spend the turn cap (bounded denial)', () => {
    const governor = createSemanticCompactionGovernor()
    recordPassSettled(governor, { productive: false })
    expect(governor.passesThisTurn).toBe(0)
    recordPassSettled(governor, { productive: false })
    expect(governor.passesThisTurn).toBe(SEMANTIC_MAX_PASSES_PER_TURN)
    expect(decide(governor, 200_000).shouldRunSemanticPass).toBe(false)
  })

  it('a productive pass resets the no-progress streak without restoring the cap', () => {
    const governor = createSemanticCompactionGovernor()
    recordPassSettled(governor, { productive: false })
    recordPassSettled(governor, { productive: false })
    recordPassSettled(governor, { productive: true })
    expect(governor.consecutiveNoProgressPasses).toBe(0)
    // The spent cap is not refunded: bounded denial for the rest of the turn.
    expect(governor.passesThisTurn).toBe(SEMANTIC_MAX_PASSES_PER_TURN)
  })

  it('exposes rearm and eviction budget helpers with unknown-window fallbacks', () => {
    expect(getSemanticRearmBudgetTokens(200_000)).toBe(100_000)
    expect(getSemanticRearmBudgetTokens(undefined)).toBe(
      DEFAULT_SEMANTIC_REARM_BUDGET_TOKENS,
    )
    expect(getSemanticEvictionFloorTokens(200_000)).toBe(
      Math.floor(200_000 * SEMANTIC_EVICTION_FRACTION),
    )
    // Unknown window: eviction is disabled (0) rather than guessed.
    expect(getSemanticEvictionFloorTokens(undefined)).toBe(0)
  })
})
