import {
  MODELS_DEV_CAPABILITY_CATALOG,
  MODELS_DEV_CATALOG_PROVENANCE,
  MODELS_DEV_UPSTREAM_LICENSE_NOTICE,
} from './generated/models-dev-capabilities.generated'

export { MODELS_DEV_CATALOG_PROVENANCE, MODELS_DEV_UPSTREAM_LICENSE_NOTICE }

export type ModelsDevCatalogProvider = 'anthropic' | 'openai' | 'openrouter'
export type CatalogRouteProviderType =
  | 'openai-compatible'
  | 'anthropic-compatible'
  | 'chatgpt-oauth'

export type ModelsDevResolvedCapabilities = {
  context?: {
    windowTokens?: number
    outputTokens?: number
  }
  reasoning?: {
    supported?: boolean
  }
  pricing?: {
    inputPerMillionTokens?: number
    outputPerMillionTokens?: number
    cachedInputPerMillionTokens?: number
    cacheWriteInputPerMillionTokens?: number
    currency: 'USD'
  }
}

type CatalogRecord = {
  contextWindowTokens: number
  outputTokens: number
  reasoning?: boolean
  pricing?: {
    inputPerMillionTokens: number
    outputPerMillionTokens: number
    cachedInputPerMillionTokens?: number
    cacheWriteInputPerMillionTokens?: number
    currency: 'USD'
  }
  pricingOmittedReason?: 'conditional-tiers'
  canonicalModelId?: string
  sourceLastUpdated?: string
}

const catalog = MODELS_DEV_CAPABILITY_CATALOG as unknown as Record<
  ModelsDevCatalogProvider,
  Record<string, CatalogRecord>
>

function normalizePathname(pathname: string): string {
  return pathname.replace(/\/+$/, '')
}

/**
 * Resolve only endpoints whose billing identity is unambiguous. Provider IDs
 * and model-name substrings are intentionally ignored: a gateway named
 * "openai" must not inherit direct OpenAI prices.
 */
export function identifyModelsDevCatalogProvider(params: {
  providerType: CatalogRouteProviderType
  baseURL?: string
}): ModelsDevCatalogProvider | undefined {
  if (!params.baseURL || params.providerType === 'chatgpt-oauth')
    return undefined
  let url: URL
  try {
    url = new URL(params.baseURL)
  } catch {
    return undefined
  }
  if (
    url.protocol !== 'https:' ||
    url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    return undefined
  const pathname = normalizePathname(url.pathname)

  if (params.providerType === 'anthropic-compatible') {
    if (
      url.hostname === 'api.anthropic.com' &&
      (pathname === '' || pathname === '/v1')
    )
      return 'anthropic'
    return undefined
  }

  if (url.hostname === 'api.openai.com' && pathname === '/v1') return 'openai'
  if (url.hostname === 'openrouter.ai' && pathname === '/api/v1')
    return 'openrouter'
  return undefined
}

export function shouldDefaultIncludeUsage(params: {
  providerType: CatalogRouteProviderType
  baseURL?: string
}): boolean {
  const provider = identifyModelsDevCatalogProvider(params)
  return provider === 'openai' || provider === 'openrouter'
}

/**
 * Return a fresh, value-only capability object for one exact upstream route.
 * Conditional/tiered upstream prices are deliberately absent from generated
 * records until request accounting can select those tiers truthfully.
 */
export function resolveModelsDevModelCapabilities(params: {
  providerType: CatalogRouteProviderType
  baseURL?: string
  model: string
}): ModelsDevResolvedCapabilities | undefined {
  const provider = identifyModelsDevCatalogProvider(params)
  if (!provider) return undefined
  const record = catalog[provider]?.[params.model]
  if (!record) return undefined

  return {
    context: {
      windowTokens: record.contextWindowTokens,
      outputTokens: record.outputTokens,
    },
    ...(record.reasoning === undefined
      ? {}
      : { reasoning: { supported: record.reasoning } }),
    ...(record.pricing
      ? {
          pricing: {
            inputPerMillionTokens: record.pricing.inputPerMillionTokens,
            outputPerMillionTokens: record.pricing.outputPerMillionTokens,
            ...(record.pricing.cachedInputPerMillionTokens === undefined
              ? {}
              : {
                  cachedInputPerMillionTokens:
                    record.pricing.cachedInputPerMillionTokens,
                }),
            ...(record.pricing.cacheWriteInputPerMillionTokens === undefined
              ? {}
              : {
                  cacheWriteInputPerMillionTokens:
                    record.pricing.cacheWriteInputPerMillionTokens,
                }),
            currency: record.pricing.currency,
          },
        }
      : {}),
  }
}

export type ModelsDevCatalogProvenance = typeof MODELS_DEV_CATALOG_PROVENANCE
