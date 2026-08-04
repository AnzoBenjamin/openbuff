export const DEFAULT_MAX_REPAIR_ROUNDS = 3
export const DEFAULT_MAX_SPECIALIST_REPAIR_ROUNDS = 3
export const DEFAULT_MAX_REVIEWER_REPAIR_ROUNDS = 6
/** Shared cap for validation / specialist / reviewer gate repair budgets. */
export const MAX_MAX_GATE_REPAIR_ROUNDS = 20
/** @deprecated Prefer MAX_MAX_GATE_REPAIR_ROUNDS; kept for back-compat exports. */
export const MAX_MAX_REVIEWER_REPAIR_ROUNDS = MAX_MAX_GATE_REPAIR_ROUNDS

/** Shared clamp for gate repair budgets (finite integer ≥ 1, floor, cap). */
export function resolvePositiveIntBudget(
  raw: unknown,
  fallback: number,
  max: number = MAX_MAX_GATE_REPAIR_ROUNDS,
): number {
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

/** Parse option/env for reviewer→repair→re-review budget. Invalid → default. */
export function resolveMaxReviewerRepairRounds(
  raw: unknown,
  fallback: number = DEFAULT_MAX_REVIEWER_REPAIR_ROUNDS,
): number {
  return resolvePositiveIntBudget(raw, fallback)
}

/** Parse option/env for validation-hook repair budget. Invalid → default. */
export function resolveMaxRepairRounds(
  raw: unknown,
  fallback: number = DEFAULT_MAX_REPAIR_ROUNDS,
): number {
  return resolvePositiveIntBudget(raw, fallback)
}

/** Parse option/env for specialist→repair→re-review budget. Invalid → default. */
export function resolveMaxSpecialistRepairRounds(
  raw: unknown,
  fallback: number = DEFAULT_MAX_SPECIALIST_REPAIR_ROUNDS,
): number {
  return resolvePositiveIntBudget(raw, fallback)
}

export type EffectiveGateRepairBudgets = {
  maxRepairRounds: number
  maxReviewerRepairRounds: number
  maxSpecialistRepairRounds: number
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

/**
 * Formats effective gate repair budgets for terminal display.
 * Byte-stable multi-line output for the CLI `/context` command and tests.
 */
export function formatGateRepairBudgetsForCli(
  budgets: EffectiveGateRepairBudgets = resolveEffectiveGateRepairBudgets(),
): string {
  const rows: Array<[string, number]> = [
    ['validation (hooks)', budgets.maxRepairRounds],
    ['reviewer (code-review)', budgets.maxReviewerRepairRounds],
    ['specialist (aux)', budgets.maxSpecialistRepairRounds],
  ]
  let labelWidth = 0
  let valueWidth = 1
  for (const [label, value] of rows) {
    if (label.length > labelWidth) labelWidth = label.length
    const valueText = String(value)
    if (valueText.length > valueWidth) valueWidth = valueText.length
  }

  const lines: string[] = [
    'Gate repair budgets',
    '-------------------',
  ]
  for (const [label, value] of rows) {
    lines.push(
      `${label.padEnd(labelWidth)}  ${String(value).padStart(valueWidth)}`,
    )
  }
  lines.push(
    '(env: OPENBUFF_MAX_REPAIR_ROUNDS / OPENBUFF_MAX_REVIEWER_REPAIR_ROUNDS / OPENBUFF_MAX_SPECIALIST_REPAIR_ROUNDS; createBase2 options win at agent load)',
  )
  return lines.join('\n')
}
