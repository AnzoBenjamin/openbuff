/** All rates are explicit USD per million tokens; no hosted price inference. */
export interface ModelPricing {
  inputPerMillionTokens?: number
  outputPerMillionTokens?: number
  cachedInputPerMillionTokens?: number
  currency?: string
}
export interface UsageTokenCounts {
  /** Total input includes the cache-hit portion, per AI SDK usage semantics. */
  inputTokens?: number
  outputTokens?: number
  cachedInputTokens?: number
}
const count = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
const rate = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0

/** Complete known-cost telemetry, not a reservation or an exact remote billing guarantee. */
export function computeCostCentsFromUsage({
  usage,
  pricing,
}: {
  usage: UsageTokenCounts
  pricing: ModelPricing | undefined
}): number | undefined {
  if (
    !pricing ||
    (pricing.currency !== undefined && pricing.currency !== 'USD') ||
    !count(usage.inputTokens) ||
    !count(usage.outputTokens)
  )
    return undefined
  if (
    Object.values({
      input: pricing.inputPerMillionTokens,
      output: pricing.outputPerMillionTokens,
      cached: pricing.cachedInputPerMillionTokens,
    }).some((value) => value !== undefined && !rate(value))
  )
    return undefined
  const cached = usage.cachedInputTokens ?? 0
  if (!count(cached) || cached > usage.inputTokens) return undefined
  const input = usage.inputTokens - cached,
    output = usage.outputTokens
  const cachedRate =
    pricing.cachedInputPerMillionTokens ?? pricing.inputPerMillionTokens
  if (
    (input > 0 && pricing.inputPerMillionTokens === undefined) ||
    (output > 0 && pricing.outputPerMillionTokens === undefined) ||
    (cached > 0 && cachedRate === undefined) ||
    (pricing.inputPerMillionTokens === undefined &&
      pricing.outputPerMillionTokens === undefined)
  )
    return undefined
  const cents =
    (input * (pricing.inputPerMillionTokens ?? 0) +
      cached * (cachedRate ?? 0) +
      output * (pricing.outputPerMillionTokens ?? 0)) /
    10_000
  return Number.isFinite(cents) && cents >= 0 ? cents : undefined
}

export function calculateProviderCostCents(
  costDollars: unknown,
): number | undefined {
  if (!rate(costDollars)) return undefined
  const cents = costDollars * 100
  return Number.isFinite(cents) ? cents : undefined
}

/** Null/absent metadata is unknown, not a zero-price request. */
export function providerCostDollars(metadata: unknown): number | undefined {
  if (!metadata || typeof metadata !== 'object') return undefined
  const codebuff = (
    metadata as {
      codebuff?: {
        usage?: {
          cost?: unknown
          costDetails?: { upstreamInferenceCost?: unknown }
        }
      }
    }
  ).codebuff
  const usage = codebuff?.usage
  if (!usage || typeof usage !== 'object') return undefined
  const cost = usage.cost,
    upstream = usage.costDetails?.upstreamInferenceCost
  if (
    (cost != null && !rate(cost)) ||
    (upstream != null && !rate(upstream)) ||
    (cost == null && upstream == null)
  )
    return undefined
  const sum =
    (typeof cost === 'number' ? cost : 0) +
    (typeof upstream === 'number' ? upstream : 0)
  return Number.isFinite(sum) ? sum : undefined
}
