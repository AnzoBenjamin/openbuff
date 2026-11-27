/**
 * Provider-backed embedder factory for semantic indexing (BYOK).
 *
 * Resolves the configured `indexing.semantic.model` through the same
 * openbuff.json provider routing used for chat, then exposes a batch embed
 * function the indexer consumes. Returns null when the model can't be routed to
 * an OpenAI-compatible embeddings endpoint, so semantic indexing simply stays
 * off rather than erroring.
 *
 * NOTE: This path issues real embedding API calls; it is exercised only when a
 * user opts in via `indexing.semantic.enabled` + a routable `model`.
 */
import { OpenAICompatibleEmbeddingModel } from '@codebuff/internal/openai-compatible/index'
import { embedMany } from 'ai'

import { resolveConfiguredProviderModel } from '../provider-config'
import { getSystemProcessEnv } from '../env'

/** Batch embedder shape shared with the indexer's semantic engine. */
export type EmbedFn = ((texts: string[]) => Promise<number[][]>) & {
  cacheKey?: string
  maxBatchSize?: number
}

export function createConfiguredEmbedder(
  modelString: string,
  env: NodeJS.ProcessEnv = getSystemProcessEnv(),
): EmbedFn | null {
  let resolved
  try {
    resolved = resolveConfiguredProviderModel({ model: modelString, env })
  } catch {
    return null
  }
  if (!resolved || resolved.provider.type !== 'openai-compatible') {
    // Embeddings require an OpenAI-compatible /embeddings endpoint.
    return null
  }

  const { providerId, provider, providerModel, apiKey } = resolved
  const baseURL = provider.baseURL.replace(/\/$/, '')
  const hostname = new URL(baseURL).hostname
  const local =
    hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]'

  const model = new OpenAICompatibleEmbeddingModel(providerModel, {
    provider: providerId,
    // CPU-backed local endpoints can exceed the HTTP timeout on large
    // batches. Keep their requests small and serial; cloud defaults stay fast.
    ...(local ? { maxEmbeddingsPerCall: 8, supportsParallelCalls: false } : {}),
    url: ({ path }: { path: string }) => `${baseURL}${path}`,
    headers: () => (apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
  })

  const embed: EmbedFn = async (texts: string[]) => {
    if (texts.length === 0) return []
    const { embeddings } = await embedMany({ model, values: texts })
    return embeddings
  }
  // Deliberately excludes credentials. These fields fully identify the
  // resolved endpoint/model whose vector space determines cache compatibility.
  embed.cacheKey = JSON.stringify({ providerId, baseURL, providerModel })
  if (local) embed.maxBatchSize = 8
  return embed
}
