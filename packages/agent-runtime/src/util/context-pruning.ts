import { trimMessagesToFitTokenLimitWithReport } from './messages'

import type { Message } from '@codebuff/common/types/messages/codebuff-message'
import type { Logger } from '@codebuff/common/types/contracts/logger'
import type { ContextTrimReport } from './messages'

/**
 * Default maximum context tokens before auto-pruning triggers. Matches the
 * default in `trimMessagesToFitTokenLimit` (190k), which is a safe threshold
 * for most models' context windows.
 *
 * This is the single source of truth for the unified pruning threshold (M4,
 * SPEC R4). It is imported by:
 * - `packages/agent-runtime/src/run-agent-step.ts` (runtime fallback via
 *   `maybePruneContext` and the context-window status emission)
 * - `sdk/src/impl/llm.ts` (request-time emergency-brake fallback limit)
 *
 * The LLM-based context-pruner agent (`agents/context-pruner.ts`) uses the
 * model-aware semantic policy below. Its serialized `handleSteps` body mirrors
 * these constants inline and uses the conservative 140k trigger only when the
 * provider/model window is unknown.
 */
export const DEFAULT_MAX_CONTEXT_TOKENS = 190_000

/**
 * Minimum tokens reserved for model output + non-message request overhead
 * (tool schemas, step prompt) when computing the effective message-token
 * budget from a model's context window. Mirrors the policy previously inlined
 * in `sdk/src/impl/llm.ts`; centralized here (M4.2) so the runtime fallback
 * and SDK request-time trim share one reserved-token policy.
 */
export const MODEL_CONTEXT_MIN_RESERVED_TOKENS = 8_000
export const MODEL_CONTEXT_MAX_RESERVED_TOKENS = 128_000
export const MODEL_CONTEXT_RESERVED_FRACTION = 0.12
export const MODEL_CONTEXT_MAX_RESERVED_FRACTION = 0.5

/**
 * Semantic compaction runs before the provider-safe emergency limit. The
 * trigger intentionally leaves materially more room than the mechanical
 * reserve for tool schemas, system prompts, output, and provider-side
 * accounting differences. The target is a history budget, not a hard final
 * request size: pinned control-plane memory and the fixed request baseline sit
 * outside it.
 *
 * SINGLE SOURCE OF TRUTH: the SEMANTIC_* / MODEL_CONTEXT_* literals below
 * are canonical. `agents/context-pruner.ts` inlines a literal copy inside
 * its serialized `handleSteps` (cannot import this module at runtime).
 * @generated — inline block in agents/context-pruner.ts is derived from here;
 * update constants here and re-copy to the pruner. Sync is guarded by RF-3
 * test (agents/__tests__/base2-progressive-tool-disclosure.test.ts) until
 * codegen/shared literal source is implemented.
 */
export const SEMANTIC_COMPACTION_TRIGGER_FRACTION = 0.78
export const SEMANTIC_COMPACTION_TARGET_FRACTION = 0.4
export const SEMANTIC_COMPACTION_HEADROOM_FRACTION = 0.15
export const SEMANTIC_COMPACTION_MIN_HEADROOM_TOKENS = 32_000
export const SEMANTIC_COMPACTION_MAX_HEADROOM_TOKENS = 160_000
export const SEMANTIC_COMPACTION_MIN_TARGET_TOKENS = 72_000
export const SEMANTIC_COMPACTION_MAX_TARGET_TOKENS = 420_000
export const SEMANTIC_COMPACTION_SMALL_WINDOW_THRESHOLD_TOKENS = 128_000
export const SEMANTIC_COMPACTION_SMALL_WINDOW_MIN_HEADROOM_TOKENS = 2_000
export const DEFAULT_SEMANTIC_COMPACTION_TRIGGER_TOKENS = 140_000
export const DEFAULT_SEMANTIC_COMPACTION_TARGET_TOKENS = 100_000
/**
 * Rearm budget for the governor when the model window is unknown. Must sit
 * strictly below the fallback semantic trigger (140k) — with enough margin to
 * absorb the `+1_000` trigger hysteresis in `shouldRunSemanticPass` — and
 * safely above the fallback target (100k), so an observation that re-arms the
 * governor can never itself satisfy the trigger check and announce a pass.
 */
export const DEFAULT_SEMANTIC_REARM_BUDGET_TOKENS = 120_000

/** Reduction below this share of the previous post-compaction size counts as no progress. */
export const COMPACTION_NO_PROGRESS_FRACTION = 0.05

/**
 * Governor budgets for the semantic (LLM) compaction pass.
 *
 * WHY: the previous design announced — and paid for — a full-transcript LLM
 * pruner pass on EVERY loop iteration above the trigger until a
 * `suppressSemanticCompaction` streak advisory tripped. That made compaction
 * feel thrashy and expensive: a productive pass that landed at the target
 * re-armed immediately, so context regrowing past the trigger bought another
 * paid pass. The governor makes the expensive pass rare by construction:
 *
 *  - REARM: after a settled pass the governor stays disarmed until context
 *    falls below `SEMANTIC_REARM_FRACTION` of the window, so a pass must buy
 *    real headroom before another one can be announced.
 *  - COOLDOWN: at least `SEMANTIC_COOLDOWN_ITERATIONS` agent steps must pass
 *    between announced passes, even in pathological fast-growth turns.
 *  - TURN CAP: at most `SEMANTIC_MAX_PASSES_PER_TURN` paid passes per turn;
 *    beyond that only the free deterministic eviction layer and the mechanical
 *    emergency trim respond to pressure.
 *
 * The deterministic tool-result evictor arms below the LLM trigger
 * (`SEMANTIC_EVICTION_FRACTION` of the window) at zero token cost, so the LLM
 * pass becomes a last resort rather than the first response — the same
 * "continuous light consolidation" shape as background-compaction designs like
 * cortexkit/magic-context, without background LLM calls.
 */
/**
 * Base share of the window the governor's rearm budget tracks. The EFFECTIVE
 * budget is computed in `getSemanticRearmBudgetTokens`, which clamps it above
 * the window's achievable post-pass target where trigger headroom allows and
 * caps it strictly below the trigger (see its invariant doc): on 128k–180k
 * windows the 72k min-target floor pins the target above a bare 50% share, so
 * an unclamped rearm budget could never be reached by the pass's own reclaim
 * and the governor would only ever re-arm via the emergency override.
 */
export const SEMANTIC_REARM_FRACTION = 0.5
export const SEMANTIC_COOLDOWN_ITERATIONS = 3
export const SEMANTIC_MAX_PASSES_PER_TURN = 3
export const SEMANTIC_EVICTION_FRACTION = 0.55

export type SemanticCompactionBudget = {
  resolvedContextWindowTokens?: number
  triggerBudgetTokens: number
  targetBudgetTokens: number
  headroomTokens?: number
}

export type EffectiveContextLimits = {
  providerSafeMessageLimit?: number
  statusWindowTokens: number
}

/**
 * Resolve the live per-model limits used by runtime trimming and telemetry.
 * Call this whenever the active routed model changes; do not cache the result
 * for the whole run because provider failover may select a different window.
 */
export function getEffectiveContextLimits(
  contextWindowTokens: number | undefined,
  maxContextLength?: number,
): EffectiveContextLimits {
  const modelMessageLimit =
    contextWindowTokens === undefined
      ? undefined
      : getModelContextMessageLimit(contextWindowTokens)
  const providerSafeMessageLimit =
    maxContextLength === undefined
      ? modelMessageLimit
      : modelMessageLimit === undefined
        ? maxContextLength
        : Math.min(maxContextLength, modelMessageLimit)
  const statusWindowTokens =
    maxContextLength === undefined
      ? (contextWindowTokens ?? DEFAULT_MAX_CONTEXT_TOKENS)
      : contextWindowTokens === undefined
        ? maxContextLength
        : Math.min(maxContextLength, contextWindowTokens)

  return { providerSafeMessageLimit, statusWindowTokens }
}

function isUsableContextWindow(value: number | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

/**
 * Return deterministic, context-window-aware semantic compaction budgets.
 * Unknown or invalid provider windows use the conservative legacy fallback.
 */
export function getSemanticCompactionBudget(
  contextWindowTokens: number | undefined,
): SemanticCompactionBudget {
  if (!isUsableContextWindow(contextWindowTokens)) {
    return {
      triggerBudgetTokens: DEFAULT_SEMANTIC_COMPACTION_TRIGGER_TOKENS,
      targetBudgetTokens: DEFAULT_SEMANTIC_COMPACTION_TARGET_TOKENS,
    }
  }

  // Fixed 32k/72k minima are useful for large context windows but collapse the
  // old formula for small BYOK models: a 32k window produced a one-token
  // trigger and target because the minimum headroom equalled the whole window.
  // Below 128k, scale against the provider-safe message limit instead so 8k,
  // 16k, 32k, and 64k models retain a meaningful working set.
  if (contextWindowTokens < SEMANTIC_COMPACTION_SMALL_WINDOW_THRESHOLD_TOKENS) {
    const providerSafeMessageLimit =
      getModelContextMessageLimit(contextWindowTokens)
    const headroomTokens = Math.max(
      1,
      Math.min(
        SEMANTIC_COMPACTION_MIN_HEADROOM_TOKENS,
        Math.max(
          SEMANTIC_COMPACTION_SMALL_WINDOW_MIN_HEADROOM_TOKENS,
          Math.floor(providerSafeMessageLimit * 0.25),
        ),
      ),
    )
    const triggerBudgetTokens = Math.max(
      1,
      Math.min(
        Math.floor(
          providerSafeMessageLimit * SEMANTIC_COMPACTION_TRIGGER_FRACTION,
        ),
        providerSafeMessageLimit - headroomTokens,
      ),
    )
    const scaledTargetTokens = Math.max(
      1,
      Math.floor(
        providerSafeMessageLimit * SEMANTIC_COMPACTION_TARGET_FRACTION,
      ),
    )

    return {
      resolvedContextWindowTokens: contextWindowTokens,
      triggerBudgetTokens,
      targetBudgetTokens: Math.max(
        1,
        Math.min(scaledTargetTokens, triggerBudgetTokens - 1),
      ),
      headroomTokens,
    }
  }

  const headroomTokens = Math.min(
    SEMANTIC_COMPACTION_MAX_HEADROOM_TOKENS,
    Math.max(
      SEMANTIC_COMPACTION_MIN_HEADROOM_TOKENS,
      Math.floor(contextWindowTokens * SEMANTIC_COMPACTION_HEADROOM_FRACTION),
    ),
  )
  const triggerBudgetTokens = Math.max(
    1,
    Math.min(
      Math.floor(contextWindowTokens * SEMANTIC_COMPACTION_TRIGGER_FRACTION),
      contextWindowTokens - headroomTokens,
    ),
  )
  const scaledTargetTokens = Math.min(
    SEMANTIC_COMPACTION_MAX_TARGET_TOKENS,
    Math.max(
      SEMANTIC_COMPACTION_MIN_TARGET_TOKENS,
      Math.floor(contextWindowTokens * SEMANTIC_COMPACTION_TARGET_FRACTION),
    ),
  )

  return {
    resolvedContextWindowTokens: contextWindowTokens,
    triggerBudgetTokens,
    targetBudgetTokens: Math.max(
      1,
      Math.min(scaledTargetTokens, triggerBudgetTokens - 1),
    ),
    headroomTokens,
  }
}

/**
 * Compute the number of tokens to reserve (output + overhead) for a given
 * model context window. Clamped to [MIN, MAX] and floored to a fraction of
 * the window. Returns `undefined` when `contextWindowTokens` is undefined
 * (unknown model window) so callers can fall back to the flat
 * `DEFAULT_MAX_CONTEXT_TOKENS` default.
 */
export function getModelContextReservedTokens(
  contextWindowTokens: number | undefined,
): number | undefined {
  if (contextWindowTokens === undefined) {
    return undefined
  }
  const reservedByFraction = Math.floor(
    contextWindowTokens * MODEL_CONTEXT_RESERVED_FRACTION,
  )
  const clampedReserve = Math.max(
    MODEL_CONTEXT_MIN_RESERVED_TOKENS,
    reservedByFraction,
  )
  const cappedReserve = Math.min(
    MODEL_CONTEXT_MAX_RESERVED_TOKENS,
    clampedReserve,
  )
  const maxAllowedByFraction = Math.max(
    1,
    Math.floor(contextWindowTokens * MODEL_CONTEXT_MAX_RESERVED_FRACTION),
  )
  return Math.min(maxAllowedByFraction, cappedReserve)
}

/**
 * Compute the effective message-token limit for a given model context window,
 * subtracting the reserved overhead. Returns `DEFAULT_MAX_CONTEXT_TOKENS`
 * (the unified flat threshold) when the model window is unknown, so the SDK
 * request-time trim and runtime fallback converge on the same limit.
 */
export function getModelContextMessageLimit(
  contextWindowTokens: number | undefined,
): number {
  if (contextWindowTokens === undefined) {
    return DEFAULT_MAX_CONTEXT_TOKENS
  }
  // The non-null assertion is safe: we already returned when
  // contextWindowTokens was undefined, and getModelContextReservedTokens
  // only returns undefined when its input is undefined. TS cannot infer
  // this correlation through the `number | undefined` return type, so the
  // assertion keeps a single computation site (no duplicated formula).
  const reserved = getModelContextReservedTokens(contextWindowTokens)!
  return Math.max(1, contextWindowTokens - reserved)
}

/**
 * Proactively prune message history when the total context token count
 * exceeds the model threshold. This is a runtime-level safety net called from
 * `loopAgentSteps` after `contextTokenCount` is computed.
 *
 * Orchestrators' `handleSteps` may still spawn the LLM-based context-pruner
 * agent for smarter summarization — this helper is a deterministic,
 * fast-acting fallback that trims via `trimMessagesToFitTokenLimit`.
 *
 * @param messages - The agent's message history (without step prompt)
 * @param systemTokens - Token count of system prompt + tools
 * @param contextTokenCount - Pre-computed total context tokens (messages + system + tools)
 * @param maxTotalTokens - Threshold; defaults to DEFAULT_MAX_CONTEXT_TOKENS
 * @param logger - Logger for telemetry inside trimMessagesToFitTokenLimit
 * @returns Pruned messages + a `pruned` flag indicating whether trimming occurred
 */
export function maybePruneContext(params: {
  messages: Message[]
  systemTokens: number
  contextTokenCount: number
  maxTotalTokens?: number
  logger: Logger
}): { messages: Message[]; pruned: boolean; report?: ContextTrimReport } {
  const {
    messages,
    systemTokens,
    contextTokenCount,
    maxTotalTokens = DEFAULT_MAX_CONTEXT_TOKENS,
    logger,
  } = params

  if (contextTokenCount <= maxTotalTokens) {
    return { messages, pruned: false }
  }

  const report = trimMessagesToFitTokenLimitWithReport({
    messages,
    systemTokens,
    maxTotalTokens,
    logger,
  })

  return { messages: report.messages, pruned: true, report }
}

export type SemanticCompactionGovernorState =
  | 'armed'
  | 'cooldown'
  | 'rearm-pending'

/**
 * Loop-local state machine deciding when the expensive semantic (LLM)
 * compaction pass may run. One instance per `loopAgentSteps` invocation; it
 * deliberately does NOT persist to `AgentState` — a settled pass bought
 * headroom that is visible in the token counts themselves, so surviving across
 * turns would only delay a genuinely needed pass next turn.
 */
export type SemanticCompactionGovernor = {
  state: SemanticCompactionGovernorState
  /** Agent-loop iterations since the last announced pass (cooldown counter). */
  iterationsSincePass: number
  /** Announced passes this turn; bounded by SEMANTIC_MAX_PASSES_PER_TURN. */
  passesThisTurn: number
  /** Consecutive passes that settled without reclaiming meaningful space. */
  consecutiveNoProgressPasses: number
}

export type GovernorDecision = {
  shouldRunSemanticPass: boolean
  /** Human-readable reason, for debug logs and telemetry. */
  reason: string
  /** True when allowed only because context reached the emergency region. */
  emergencyOverride?: boolean
}

export function createSemanticCompactionGovernor(): SemanticCompactionGovernor {
  return {
    state: 'armed',
    iterationsSincePass: 0,
    passesThisTurn: 0,
    consecutiveNoProgressPasses: 0,
  }
}

/**
 * Decide whether THIS iteration may announce a semantic pass. Advances the
 * cooldown → rearm-pending → armed transitions as a side effect, so callers
 * call it exactly once per iteration.
 *
 * The emergency override exists so the governor can never deadlock a growing
 * context: if regrowth outruns the rearm margin, the pass is allowed at the
 * provider-safe limit rather than leaving only the mechanical trim (which
 * destroys content wholesale) to respond.
 */
export function shouldRunSemanticPass(
  governor: SemanticCompactionGovernor,
  params: {
    contextTokens: number
    triggerBudgetTokens: number
    rearmBudgetTokens: number
    emergencyLimitTokens: number
  },
): GovernorDecision {
  const {
    contextTokens,
    triggerBudgetTokens,
    rearmBudgetTokens,
    emergencyLimitTokens,
  } = params

  if (governor.passesThisTurn >= SEMANTIC_MAX_PASSES_PER_TURN) {
    return {
      shouldRunSemanticPass: false,
      reason: `Turn cap reached (${governor.passesThisTurn}/${SEMANTIC_MAX_PASSES_PER_TURN} passes): eviction and the mechanical trim own further pressure this turn.`,
    }
  }

  if (governor.state === 'cooldown') {
    if (governor.iterationsSincePass < SEMANTIC_COOLDOWN_ITERATIONS) {
      return {
        shouldRunSemanticPass: false,
        reason: `Cooldown: ${governor.iterationsSincePass}/${SEMANTIC_COOLDOWN_ITERATIONS} iterations since the last pass.`,
      }
    }
    governor.state = 'rearm-pending'
  }

  if (governor.state === 'rearm-pending') {
    if (contextTokens >= emergencyLimitTokens) {
      return {
        shouldRunSemanticPass: true,
        reason:
          'Emergency override: context reached the provider-safe limit while disarmed.',
        emergencyOverride: true,
      }
    }
    if (contextTokens < rearmBudgetTokens) {
      // Real headroom was bought: re-arm. The trigger check below still runs —
      // and will deny, since the rearm budget sits below the trigger — so the
      // NEXT over-trigger observation is the first allowed pass.
      governor.state = 'armed'
    } else {
      return {
        shouldRunSemanticPass: false,
        reason:
          'Rearm-pending: context has not fallen below the rearm budget since the last pass.',
      }
    }
  }

  if (contextTokens + 1_000 > triggerBudgetTokens) {
    return {
      shouldRunSemanticPass: true,
      reason: 'Context exceeded the semantic trigger budget while armed.',
    }
  }
  return {
    shouldRunSemanticPass: false,
    reason: 'Context below the semantic trigger budget.',
  }
}

/** Call once when a pass is actually announced (mirrors the status event). */
export function recordPassAnnounced(
  governor: SemanticCompactionGovernor,
): void {
  governor.state = 'cooldown'
  governor.iterationsSincePass = 0
  governor.passesThisTurn += 1
}

/** Call once per iteration after the pass/no-pass outcome is known. */
export function advanceGovernorIteration(
  governor: SemanticCompactionGovernor,
): void {
  if (governor.state === 'cooldown') {
    governor.iterationsSincePass += 1
  }
}

/**
 * Record a settled pass. A productive pass resets the no-progress streak; an
 * unproductive one increments it, and TWO consecutive no-progress passes cap
 * the turn at its already-spent pass budget. Unlike the old permanent
 * `suppressSemanticCompaction` advisory this stays bounded (no further paid
 * passes this turn, but eviction + the mechanical trim still respond) and the
 * state resets naturally next turn because the governor is loop-local.
 */
export function recordPassSettled(
  governor: SemanticCompactionGovernor,
  params: { productive: boolean },
): void {
  const { productive } = params
  if (productive) {
    governor.consecutiveNoProgressPasses = 0
    return
  }
  governor.consecutiveNoProgressPasses += 1
  if (governor.consecutiveNoProgressPasses >= 2) {
    governor.passesThisTurn = SEMANTIC_MAX_PASSES_PER_TURN
  }
}

/**
 * Token budget below which the governor re-arms after a settled pass.
 * Unknown windows fall back to DEFAULT_SEMANTIC_REARM_BUDGET_TOKENS, which
 * sits strictly below the fallback semantic trigger (see its doc) with enough
 * margin to absorb the `+1_000` trigger hysteresis in `shouldRunSemanticPass`,
 * so a re-arming observation can never itself announce a pass.
 *
 * Known windows clamp the bare `SEMANTIC_REARM_FRACTION` share ABOVE the
 * window's achievable `targetBudgetTokens` where trigger headroom allows: a
 * settled pass lands at (or just above) the target, so a rearm budget at or
 * below it would strand the governor in rearm-pending forever — every later
 * pass would wait for the emergency override instead of being re-armed by the
 * pass's own reclaim.
 *
 * INVARIANT (every window class): the highest re-arming observation sits at
 * `rearm − 1`, and it must fail the `contextTokens + 1_000 > trigger` check,
 * so the rearm budget is capped at `triggerBudgetTokens − 1_000`. On small
 * windows the trigger can sit WITHIN the hysteresis margin of the target
 * (e.g. an 8k window: trigger 2_000, target 1_600 — a bare
 * `Math.max(0.5 * window, target + 1_000)` yields 4_000 > trigger), so there
 * the cap wins over the target floor: a settled pass re-arms only through
 * further reclaim (deterministic eviction, the mechanical trim) or the
 * emergency override, never by announcing an immediate paid pass.
 */
export function getSemanticRearmBudgetTokens(
  contextWindowTokens: number | undefined,
): number {
  if (!isUsableContextWindow(contextWindowTokens)) {
    return DEFAULT_SEMANTIC_REARM_BUDGET_TOKENS
  }
  const base = Math.floor(contextWindowTokens * SEMANTIC_REARM_FRACTION)
  const budget = getSemanticCompactionBudget(contextWindowTokens)
  const targetFloor = budget.targetBudgetTokens + 1_000
  const triggerCap = budget.triggerBudgetTokens - 1_000
  return Math.max(1, Math.min(Math.max(base, targetFloor), triggerCap))
}

/**
 * Token floor at which the free deterministic tool-result evictor runs.
 * Returns 0 for an unknown window: eviction is skipped rather than guessed,
 * because its whole value is being strictly cheaper than the alternatives.
 */
export function getSemanticEvictionFloorTokens(
  contextWindowTokens: number | undefined,
): number {
  if (!isUsableContextWindow(contextWindowTokens)) {
    return 0
  }
  return Math.floor(contextWindowTokens * SEMANTIC_EVICTION_FRACTION)
}
