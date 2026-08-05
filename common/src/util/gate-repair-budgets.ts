/**
 * Gate repair budgets: default is unlimited (progress-gated).
 * A positive integer is an optional hard cap (max 20).
 * `null` means unlimited in programmaticConfig (JSON-safe; Infinity does not survive JSON).
 */

/** Shared hard-cap ceiling when an optional positive budget is set. */
export const MAX_MAX_GATE_REPAIR_ROUNDS = 20
/** @deprecated Prefer MAX_MAX_GATE_REPAIR_ROUNDS; kept for back-compat exports. */
export const MAX_MAX_REVIEWER_REPAIR_ROUNDS = MAX_MAX_GATE_REPAIR_ROUNDS

/**
 * Historical numeric defaults (pre-unlimited). Kept only for tests/docs that
 * still reference the old hard caps; resolved defaults are now `null`.
 * @deprecated Omitted option/env means unlimited, not these values.
 */
export const DEFAULT_MAX_REPAIR_ROUNDS = null
export const DEFAULT_MAX_SPECIALIST_REPAIR_ROUNDS = null
export const DEFAULT_MAX_REVIEWER_REPAIR_ROUNDS = null

/** Resolved gate repair budget: positive int cap, or null = unlimited. */
export type GateRepairBudget = number | null

/**
 * Shared clamp for optional gate repair budgets.
 * Missing / invalid / non-positive → `null` (unlimited).
 * Positive finite → floor + cap at max.
 */
export function resolvePositiveIntBudget(
  raw: unknown,
  fallback: GateRepairBudget = null,
  max: number = MAX_MAX_GATE_REPAIR_ROUNDS,
): GateRepairBudget {
  let n: number | undefined
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    n = raw
  } else if (typeof raw === 'string') {
    const trimmed = raw.trim()
    if (trimmed !== '') {
      const parsed = Number(trimmed)
      if (Number.isFinite(parsed)) n = parsed
    }
  }
  if (n === undefined) return fallback
  const floored = Math.floor(n)
  if (floored < 1) return fallback
  return Math.min(floored, max)
}

/** Parse option/env for reviewer→repair→re-review budget. Missing/invalid → unlimited. */
export function resolveMaxReviewerRepairRounds(
  raw: unknown,
  fallback: GateRepairBudget = null,
): GateRepairBudget {
  return resolvePositiveIntBudget(raw, fallback)
}

/** Parse option/env for validation-hook repair budget. Missing/invalid → unlimited. */
export function resolveMaxRepairRounds(
  raw: unknown,
  fallback: GateRepairBudget = null,
): GateRepairBudget {
  return resolvePositiveIntBudget(raw, fallback)
}

/** Parse option/env for specialist→repair→re-review budget. Missing/invalid → unlimited. */
export function resolveMaxSpecialistRepairRounds(
  raw: unknown,
  fallback: GateRepairBudget = null,
): GateRepairBudget {
  return resolvePositiveIntBudget(raw, fallback)
}

export type EffectiveGateRepairBudgets = {
  maxRepairRounds: GateRepairBudget
  maxReviewerRepairRounds: GateRepairBudget
  maxSpecialistRepairRounds: GateRepairBudget
}

type GateRepairBudgetEnvBag = {
  maxRepairRounds?: unknown
  maxReviewerRepairRounds?: unknown
  maxSpecialistRepairRounds?: unknown
}

type GateRepairBudgetEnvSource =
  | GateRepairBudgetEnvBag
  | NodeJS.ProcessEnv
  | Record<string, string | undefined>

function readEnvSource(
  env?: GateRepairBudgetEnvSource,
): Record<string, unknown> {
  if (env !== undefined && env !== null && typeof env === 'object') {
    return env as Record<string, unknown>
  }
  if (typeof process === 'object' && process !== null && process.env) {
    return process.env as Record<string, unknown>
  }
  return {}
}

/**
 * Resolve the three gate repair budgets from an optional bag or env map.
 * Prefer camelCase bag fields when present; otherwise read OPENBUFF_* env
 * keys. When `env` is omitted, uses `process.env` when available.
 * Unset / invalid → unlimited (`null`). Positive ints still apply optional caps.
 */
export function resolveEffectiveGateRepairBudgets(
  env?: GateRepairBudgetEnvSource,
): EffectiveGateRepairBudgets {
  const source = readEnvSource(env)
  return {
    maxRepairRounds: resolveMaxRepairRounds(
      source.maxRepairRounds ?? source.OPENBUFF_MAX_REPAIR_ROUNDS,
    ),
    maxReviewerRepairRounds: resolveMaxReviewerRepairRounds(
      source.maxReviewerRepairRounds ??
        source.OPENBUFF_MAX_REVIEWER_REPAIR_ROUNDS,
    ),
    maxSpecialistRepairRounds: resolveMaxSpecialistRepairRounds(
      source.maxSpecialistRepairRounds ??
        source.OPENBUFF_MAX_SPECIALIST_REPAIR_ROUNDS,
    ),
  }
}

function formatBudgetValue(value: GateRepairBudget): string {
  return value === null || value === undefined ? 'unlimited' : String(value)
}

/**
 * Formats effective gate repair budgets for terminal display.
 * Byte-stable multi-line output for the CLI `/context` command and tests.
 * Unlimited budgets print as `unlimited`; progress guards terminate loops.
 */
export function formatGateRepairBudgetsForCli(
  budgets: EffectiveGateRepairBudgets = resolveEffectiveGateRepairBudgets(),
): string {
  const rows: Array<[string, GateRepairBudget]> = [
    ['validation (hooks)', budgets.maxRepairRounds],
    ['reviewer (code-review)', budgets.maxReviewerRepairRounds],
    ['specialist (aux)', budgets.maxSpecialistRepairRounds],
  ]
  let labelWidth = 0
  let valueWidth = 1
  for (const [label, value] of rows) {
    if (label.length > labelWidth) labelWidth = label.length
    const valueText = formatBudgetValue(value)
    if (valueText.length > valueWidth) valueWidth = valueText.length
  }

  const lines: string[] = [
    'Gate repair budgets',
    '-------------------',
  ]
  for (const [label, value] of rows) {
    lines.push(
      `${label.padEnd(labelWidth)}  ${formatBudgetValue(value).padStart(valueWidth)}`,
    )
  }
  lines.push(
    '(default unlimited / progress-gated; set OPENBUFF_MAX_REPAIR_ROUNDS / OPENBUFF_MAX_REVIEWER_REPAIR_ROUNDS / OPENBUFF_MAX_SPECIALIST_REPAIR_ROUNDS or createBase2 options to a positive int to cap; createBase2 options win at agent load)',
  )
  return lines.join('\n')
}
