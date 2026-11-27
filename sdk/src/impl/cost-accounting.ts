/** All rates are explicit USD per million tokens; no hosted price inference. */
export interface ModelPricing {
  inputPerMillionTokens?: number
  outputPerMillionTokens?: number
  cacheWriteInputPerMillionTokens?: number
  cachedInputPerMillionTokens?: number
  currency?: string
}
export interface UsageTokenCounts {
  /** Canonical total input includes disjoint uncached, cache-read and cache-write buckets. */
  inputTokens?: number
  outputTokens?: number
  cachedInputTokens?: number
  cacheWriteInputTokens?: number
  totalTokens?: number
  accountingComplete?: boolean
}
const count = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
const rate = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0
const safeSum = (...values: number[]): number | undefined => {
  const sum = values.reduce((total, value) => total + value, 0)
  return Number.isSafeInteger(sum) ? sum : undefined
}

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
    usage.accountingComplete === false ||
    pricing.currency !== 'USD' ||
    !count(usage.inputTokens) ||
    !count(usage.outputTokens)
  )
    return undefined

  const total = safeSum(usage.inputTokens, usage.outputTokens)
  if (
    total === undefined ||
    (usage.totalTokens !== undefined &&
      (!count(usage.totalTokens) || usage.totalTokens !== total))
  )
    return undefined

  const rates = [
    pricing.inputPerMillionTokens,
    pricing.outputPerMillionTokens,
    pricing.cacheWriteInputPerMillionTokens,
    pricing.cachedInputPerMillionTokens,
  ]
  if (
    !rates.some((value) => value !== undefined) ||
    rates.some((value) => value !== undefined && !rate(value))
  )
    return undefined

  const cached = usage.cachedInputTokens ?? 0
  const written = usage.cacheWriteInputTokens ?? 0
  const cacheInput = safeSum(cached, written)
  if (
    !count(cached) ||
    !count(written) ||
    cacheInput === undefined ||
    cacheInput > usage.inputTokens
  )
    return undefined

  const uncached = usage.inputTokens - cacheInput
  const output = usage.outputTokens
  const cachedRate =
    pricing.cachedInputPerMillionTokens ?? pricing.inputPerMillionTokens
  if (
    (uncached > 0 && pricing.inputPerMillionTokens === undefined) ||
    (output > 0 && pricing.outputPerMillionTokens === undefined) ||
    (written > 0 && pricing.cacheWriteInputPerMillionTokens === undefined) ||
    (cached > 0 && cachedRate === undefined)
  )
    return undefined

  const cents =
    (uncached * (pricing.inputPerMillionTokens ?? 0) +
      written * (pricing.cacheWriteInputPerMillionTokens ?? 0) +
      cached * (cachedRate ?? 0) +
      output * (pricing.outputPerMillionTokens ?? 0)) /
    10_000
  return Number.isFinite(cents) && cents >= 0 ? cents : undefined
}

/**
 * Normalize adapter-specific counts into disjoint cache buckets. The pinned
 * Anthropic adapter exposes raw usage metadata because its normalized
 * `inputTokens` excludes cache reads and writes; compatible `prompt_tokens`
 * already includes its cache-read portion.
 */
export function normalizeProviderUsage(
  usage: UsageTokenCounts | undefined,
  metadata: unknown,
  format: 'anthropic' | 'compatible' = 'compatible',
): UsageTokenCounts & { accountingComplete: boolean } {
  const source = usage ?? {}
  if (format === 'compatible') {
    const input = count(source.inputTokens) ? source.inputTokens : undefined
    const output = count(source.outputTokens) ? source.outputTokens : undefined
    const cached = count(source.cachedInputTokens)
      ? source.cachedInputTokens
      : undefined
    const written = count(source.cacheWriteInputTokens)
      ? source.cacheWriteInputTokens
      : undefined
    const cacheInput = safeSum(cached ?? 0, written ?? 0)
    const total =
      input !== undefined && output !== undefined
        ? safeSum(input, output)
        : undefined
    const reportedTotalValid =
      source.totalTokens === undefined ||
      (count(source.totalTokens) && source.totalTokens === total)
    const cacheBucketsValid =
      (source.cachedInputTokens === undefined || cached !== undefined) &&
      (source.cacheWriteInputTokens === undefined || written !== undefined) &&
      cacheInput !== undefined &&
      (input === undefined || cacheInput <= input)
    return {
      ...source,
      inputTokens: input,
      outputTokens: output,
      cachedInputTokens: cached,
      cacheWriteInputTokens: written,
      totalTokens: total,
      accountingComplete:
        source.accountingComplete !== false &&
        total !== undefined &&
        reportedTotalValid &&
        cacheBucketsValid,
    }
  }

  const anthropic =
    metadata && typeof metadata === 'object'
      ? (
          metadata as {
            anthropic?: {
              usage?: Record<string, unknown>
              cacheCreationInputTokens?: unknown
            }
          }
        ).anthropic
      : undefined
  const raw = anthropic?.usage
  const uncached = raw?.input_tokens
  const cached = raw?.cache_read_input_tokens
  const written = raw?.cache_creation_input_tokens
  const output = raw?.output_tokens ?? source.outputTokens
  const cacheCreationMatches =
    anthropic?.cacheCreationInputTokens == null ||
    anthropic.cacheCreationInputTokens === written
  const canonicalInput =
    count(uncached) && count(cached) && count(written) && cacheCreationMatches
      ? safeSum(uncached, cached, written)
      : undefined
  const total =
    canonicalInput !== undefined && count(output)
      ? safeSum(canonicalInput, output)
      : undefined
  return {
    inputTokens: canonicalInput,
    outputTokens: count(output) ? output : undefined,
    cachedInputTokens: count(cached) ? cached : undefined,
    cacheWriteInputTokens: count(written) ? written : undefined,
    totalTokens: total,
    accountingComplete:
      source.accountingComplete !== false && total !== undefined,
  }
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
