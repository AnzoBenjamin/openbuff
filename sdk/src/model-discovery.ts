import { createHash } from 'node:crypto'
import fs from 'fs'
import os from 'os'
import path from 'path'

import { z } from 'zod/v4'

import {
  loadProviderConfigSync,
  modelCapabilitiesSchema,
  providerConfigFileSchema,
  writeProviderConfigFile,
} from './provider-config'
import { getSystemProcessEnv } from './env'

import type {
  LoadedProviderConfig,
  ModelCapabilities,
  ProviderConfig,
} from './provider-config'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Supported discovery strategies. */
export type ModelDiscoveryStrategy =
  | 'openai-compatible'
  | 'ollama'
  | 'openrouter'
  | 'custom'

/** Per-provider discovery settings (may be absent – auto-detected). */
export type ModelDiscoveryAuth = 'auto' | 'provider' | 'none'

export type ModelDiscoveryConfig = {
  strategy?: ModelDiscoveryStrategy
  endpoint?: string
  auth?: ModelDiscoveryAuth
  arrayPath?: string
  idPath?: string
}

/** A single model returned by a provider discovery endpoint. */
export type DiscoveredModel = {
  id: string
  name?: string
  created?: number
  capabilities?: ModelCapabilities
  raw?: unknown
}

/** Cached discovery result for one provider endpoint identity. */
export type ProviderModelDiscoveryResult = {
  providerId: string
  fetchedAt: string
  models: DiscoveredModel[]
  /** Additive provenance for newly written caches; legacy cache rows may omit it. */
  schemaVersion?: 1
  strategy?: ModelDiscoveryStrategy
  endpoint?: string
  /** Resolved extraction paths are identity-bearing for custom discovery. */
  arrayPath?: string
  idPath?: string
  /** Digest of the exact bounded response bytes observed from the endpoint. */
  responseSha256?: string
  /** Digest of the normalized cached model payload; verified on every read. */
  modelsSha256?: string
  /** True when malformed/duplicate/empty input was returned and not cached. */
  partial?: boolean
  /** Whether this exact result replaced this endpoint identity's last-known-good cache. */
  cacheUpdated?: boolean
  skippedRows?: number
  duplicateModelIds?: string[]
}

/** Injectable fetch — avoids real network in tests. */
export type ModelDiscoveryFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>

export type DiscoverProviderModelsParams = {
  providerId: string
  loadedConfig?: LoadedProviderConfig
  env?: NodeJS.ProcessEnv
  fetch: ModelDiscoveryFetch
  signal?: AbortSignal
  timeoutMs?: number
}

const MODEL_DISCOVERY_CACHE_FILE = 'model-discovery-cache.json'
const MODEL_DISCOVERY_CACHE_SCHEMA_VERSION = 2
const MAX_MODEL_DISCOVERY_CACHE_ENTRIES = 128
const DEFAULT_MODEL_DISCOVERY_TIMEOUT_MS = 30_000
const MAX_MODEL_DISCOVERY_RESPONSE_BYTES = 8 * 1024 * 1024
const MAX_MODEL_DISCOVERY_ROWS = 20_000
const MAX_MODEL_DISCOVERY_ID_CHARS = 512
const MAX_MODEL_DISCOVERY_NAME_CHARS = 512
const MODEL_DISCOVERY_CACHE_LOCK_TIMEOUT_MS = 5_000
const MODEL_DISCOVERY_CACHE_LOCK_STALE_MS = 30_000
const MODEL_DISCOVERY_CACHE_LOCK_WAIT_MS = 10
const cacheLockWaitArray = new Int32Array(new SharedArrayBuffer(4))
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/

const discoveredModelCacheSchema = z
  .object({
    id: z.string().min(1).max(MAX_MODEL_DISCOVERY_ID_CHARS),
    name: z.string().max(MAX_MODEL_DISCOVERY_NAME_CHARS).optional(),
    created: z.number().finite().optional(),
    capabilities: modelCapabilitiesSchema.optional(),
    // Accepted only for migration from earlier caches; never retained.
    raw: z.unknown().optional(),
  })
  .strict()

const discoveryResultCacheSchema = z
  .object({
    providerId: z.string().min(1).max(256),
    fetchedAt: z.string().min(1).max(128),
    models: z.array(z.unknown()).max(MAX_MODEL_DISCOVERY_ROWS),
    schemaVersion: z.literal(1).optional(),
    strategy: z
      .enum(['openai-compatible', 'ollama', 'openrouter', 'custom'])
      .optional(),
    endpoint: z.string().url().max(4096).optional(),
    arrayPath: z.string().min(1).max(512).optional(),
    idPath: z.string().min(1).max(512).optional(),
    responseSha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    modelsSha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    partial: z.boolean().optional(),
    cacheUpdated: z.boolean().optional(),
    skippedRows: z.number().int().nonnegative().optional(),
    duplicateModelIds: z
      .array(z.string().min(1).max(MAX_MODEL_DISCOVERY_ID_CHARS))
      .max(MAX_MODEL_DISCOVERY_ROWS)
      .optional(),
  })
  .strict()

function getCachePath(): string {
  return path.join(
    os.homedir(),
    '.config',
    'openbuff',
    MODEL_DISCOVERY_CACHE_FILE,
  )
}

// Overridable for testing via setModelDiscoveryCachePath.
let _discoveryCachePathOverride: string | undefined

function resolveCachePath(): string {
  return _discoveryCachePathOverride ?? getCachePath()
}

/** Test-only helper to override the discovery cache path. Restores default on undefined. */
export function setModelDiscoveryCachePath(path: string | undefined): void {
  _discoveryCachePathOverride = path
}

/** Semver-safe alias for setModelDiscoveryCachePath — use in tests. */
export const setModelDiscoveryCachePathForTest = setModelDiscoveryCachePath

export type ModelDiscoveryCacheWriteDeps = {
  /** Injectable only for deterministic filesystem-failure controls. */
  renameSync?: (from: string, to: string) => void
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonicalize(child)]),
  )
}

function cacheableModels(
  models: readonly DiscoveredModel[],
): DiscoveredModel[] {
  return models.map((model) => ({
    id: model.id,
    ...(model.name === undefined ? {} : { name: model.name }),
    ...(model.created === undefined ? {} : { created: model.created }),
    ...(model.capabilities === undefined
      ? {}
      : { capabilities: model.capabilities }),
  }))
}

function hashNormalizedModels(models: readonly DiscoveredModel[]): string {
  return createHash('sha256')
    .update(JSON.stringify(canonicalize(cacheableModels(models))))
    .digest('hex')
}

function resolvedDiscoveryPaths(params: {
  strategy: ModelDiscoveryStrategy
  arrayPath?: string
  idPath?: string
}): { arrayPath: string; idPath: string } {
  return {
    arrayPath:
      params.arrayPath ?? (params.strategy === 'ollama' ? 'models' : 'data'),
    idPath: params.idPath ?? (params.strategy === 'ollama' ? 'name' : 'id'),
  }
}

function cacheEntryIdentity(
  result: ProviderModelDiscoveryResult,
): string | undefined {
  if (result.schemaVersion !== 1 || !result.strategy || !result.endpoint)
    return undefined
  const endpoint = normalizeDiscoveryEndpointIdentity(result.endpoint)
  if (!endpoint) return undefined
  const paths = resolvedDiscoveryPaths({
    strategy: result.strategy,
    arrayPath: result.arrayPath,
    idPath: result.idPath,
  })
  return JSON.stringify([
    result.providerId,
    result.strategy,
    endpoint,
    paths.arrayPath,
    paths.idPath,
  ])
}

function cacheModelHasExplicitCurrency(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  const capabilities = (value as Record<string, unknown>).capabilities
  if (!capabilities || typeof capabilities !== 'object') return true
  const pricing = (capabilities as Record<string, unknown>).pricing
  if (pricing === undefined) return true
  return (
    !!pricing &&
    typeof pricing === 'object' &&
    typeof (pricing as Record<string, unknown>).currency === 'string'
  )
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function getByPath(value: unknown, dottedPath: string | undefined): unknown {
  if (!dottedPath) return value
  return dottedPath.split('.').reduce<unknown>((current, segment) => {
    if (current == null) return undefined
    if (Array.isArray(current) && /^\d+$/.test(segment)) {
      return current[Number(segment)]
    }
    if (typeof current === 'object') {
      return (current as Record<string, unknown>)[segment]
    }
    return undefined
  }, value)
}

function normalizeEndpoint(
  provider: ProviderConfig,
  discovery: NonNullable<ModelDiscoveryConfig>,
): string {
  if (discovery.endpoint) return discovery.endpoint
  if (provider.type !== 'openai-compatible') {
    throw new Error(
      'Only OpenAI-compatible providers can infer discovery endpoints.',
    )
  }
  if (discovery.strategy === 'ollama') {
    const url = new URL(provider.baseURL)
    url.pathname = '/api/tags'
    url.search = ''
    return url.toString()
  }
  return `${provider.baseURL.replace(/\/$/, '')}/models`
}

function shouldSendAuthorizationHeader(params: {
  provider: ProviderConfig
  discovery: NonNullable<ModelDiscoveryConfig>
  endpoint: string
}): boolean {
  const auth = params.discovery.auth ?? 'auto'
  if (auth === 'none') return false
  if (auth === 'provider') return true
  if (!params.discovery.endpoint) return true
  if (params.provider.type !== 'openai-compatible') return false

  const providerOrigin = new URL(params.provider.baseURL).origin
  const endpointOrigin = new URL(params.endpoint).origin
  return endpointOrigin === providerOrigin
}

function authorizationHeaders(
  provider: ProviderConfig,
  env: NodeJS.ProcessEnv,
): Record<string, string> {
  if (provider.type !== 'openai-compatible' || !provider.apiKeyEnv) return {}
  const apiKey = env[provider.apiKeyEnv]
  if (!apiKey) {
    throw new Error(
      `Missing environment variable '${provider.apiKeyEnv}' required to discover provider models.`,
    )
  }
  return { Authorization: `Bearer ${apiKey}` }
}

function createDiscoveryAbortSignal(params: {
  parent?: AbortSignal
  timeoutMs: number
}): { signal?: AbortSignal; cleanup: () => void } {
  const { parent, timeoutMs } = params
  if (timeoutMs <= 0) {
    return { signal: parent, cleanup: () => {} }
  }

  const controller = new AbortController()
  let timeout: ReturnType<typeof setTimeout> | undefined
  const abort = (reason: unknown) => {
    if (!controller.signal.aborted) controller.abort(reason)
  }
  const onParentAbort = () => abort(parent?.reason)

  if (parent?.aborted) {
    abort(parent.reason)
  } else {
    parent?.addEventListener('abort', onParentAbort, { once: true })
    timeout = setTimeout(() => {
      abort(new Error(`Model discovery timed out after ${timeoutMs}ms.`))
    }, timeoutMs)
  }

  return {
    signal: controller.signal,
    cleanup: () => {
      if (timeout) clearTimeout(timeout)
      parent?.removeEventListener('abort', onParentAbort)
    },
  }
}

// ---------------------------------------------------------------------------
// OpenRouter capability mapping
// ---------------------------------------------------------------------------

function perMillionTokens(value: unknown): number | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined
  if (typeof value === 'string' && value.trim() === '') return undefined
  const parsed = Number(value)
  const perMillion = parsed * 1_000_000
  return Number.isFinite(perMillion) && perMillion >= 0 ? perMillion : undefined
}

function openRouterCapabilities(
  model: Record<string, unknown>,
): ModelCapabilities | undefined {
  const contextLength =
    typeof model.context_length === 'number' &&
    Number.isSafeInteger(model.context_length) &&
    model.context_length > 0
      ? model.context_length
      : undefined
  const topProvider =
    typeof model.top_provider === 'object' && model.top_provider
      ? (model.top_provider as Record<string, unknown>)
      : undefined
  const outputTokens =
    typeof topProvider?.max_completion_tokens === 'number' &&
    Number.isSafeInteger(topProvider.max_completion_tokens) &&
    topProvider.max_completion_tokens > 0
      ? topProvider.max_completion_tokens
      : undefined
  const pricing =
    typeof model.pricing === 'object' && model.pricing
      ? (model.pricing as Record<string, unknown>)
      : undefined
  const prompt = perMillionTokens(pricing?.prompt)
  const completion = perMillionTokens(pricing?.completion)
  const cacheRead = perMillionTokens(pricing?.input_cache_read)
  const cacheWrite = perMillionTokens(pricing?.input_cache_write)
  const supportedParameters = Array.isArray(model.supported_parameters)
    ? model.supported_parameters
    : []
  const reasoningSupported = supportedParameters.some(
    (parameter) =>
      parameter === 'reasoning' || parameter === 'reasoning_effort',
  )
  return {
    ...(contextLength || outputTokens
      ? {
          context: {
            ...(contextLength ? { windowTokens: contextLength } : {}),
            ...(outputTokens ? { outputTokens } : {}),
          },
        }
      : {}),
    ...(reasoningSupported ? { reasoning: { supported: true } } : {}),
    ...(prompt !== undefined && completion !== undefined
      ? {
          pricing: {
            inputPerMillionTokens: prompt,
            outputPerMillionTokens: completion,
            ...(cacheRead === undefined
              ? {}
              : { cachedInputPerMillionTokens: cacheRead }),
            ...(cacheWrite === undefined
              ? {}
              : { cacheWriteInputPerMillionTokens: cacheWrite }),
            currency: 'USD',
          },
        }
      : {}),
  }
}

// ---------------------------------------------------------------------------
// Normalise response
// ---------------------------------------------------------------------------

type NormalizedDiscoveryModels = {
  models: DiscoveredModel[]
  totalRows: number
  skippedRows: number
  duplicateModelIds: string[]
}

function normalizeModelsFromResponse(params: {
  json: unknown
  strategy: ModelDiscoveryStrategy
  arrayPath?: string
  idPath?: string
}): NormalizedDiscoveryModels {
  const arrayPath =
    params.arrayPath ?? (params.strategy === 'ollama' ? 'models' : 'data')
  const idPath = params.idPath ?? (params.strategy === 'ollama' ? 'name' : 'id')
  const array = getByPath(params.json, arrayPath)
  if (!Array.isArray(array)) {
    throw new Error(
      `Discovery response did not contain an array at '${arrayPath}'.`,
    )
  }
  if (array.length > MAX_MODEL_DISCOVERY_ROWS) {
    throw new Error(
      `Model discovery response contains ${array.length} rows; maximum is ${MAX_MODEL_DISCOVERY_ROWS}.`,
    )
  }

  const models: DiscoveredModel[] = []
  const seen = new Set<string>()
  const duplicates = new Set<string>()
  let skippedRows = 0
  for (const item of array) {
    const id = getByPath(item, idPath)
    if (
      typeof id !== 'string' ||
      !id ||
      id !== id.trim() ||
      id.length > MAX_MODEL_DISCOVERY_ID_CHARS ||
      CONTROL_CHARACTERS.test(id)
    ) {
      skippedRows++
      continue
    }
    if (seen.has(id)) {
      duplicates.add(id)
      continue
    }
    seen.add(id)
    const model =
      typeof item === 'object' && item ? (item as Record<string, unknown>) : {}
    const name =
      typeof model.name === 'string' &&
      model.name.length <= MAX_MODEL_DISCOVERY_NAME_CHARS &&
      !CONTROL_CHARACTERS.test(model.name)
        ? model.name
        : undefined
    models.push({
      id,
      ...(name === undefined ? {} : { name }),
      created: typeof model.created === 'number' ? model.created : undefined,
      capabilities:
        params.strategy === 'openrouter'
          ? openRouterCapabilities(model)
          : undefined,
    })
  }
  models.sort((left, right) => left.id.localeCompare(right.id))
  return {
    models,
    totalRows: array.length,
    skippedRows,
    duplicateModelIds: [...duplicates].sort(),
  }
}

// ---------------------------------------------------------------------------
// Discovery configuration resolution
// ---------------------------------------------------------------------------

function matchesExactEndpoint(
  baseURL: string,
  expected: {
    hostname: string
    pathname: string
    protocol?: string
    port?: string
  },
): boolean {
  try {
    const url = new URL(baseURL)
    return (
      (!expected.protocol || url.protocol === expected.protocol) &&
      url.hostname === expected.hostname &&
      url.port === (expected.port ?? '') &&
      url.pathname.replace(/\/+$/, '') === expected.pathname &&
      !url.search &&
      !url.hash &&
      !url.username &&
      !url.password
    )
  } catch {
    return false
  }
}

function isExactOpenRouterEndpoint(baseURL: string): boolean {
  return matchesExactEndpoint(baseURL, {
    protocol: 'https:',
    hostname: 'openrouter.ai',
    pathname: '/api/v1',
  })
}

function isExactOllamaEndpoint(baseURL: string): boolean {
  try {
    const url = new URL(baseURL)
    return (
      ['localhost', '127.0.0.1', '[::1]'].includes(
        url.hostname.toLowerCase(),
      ) &&
      url.port === '11434' &&
      url.pathname.replace(/\/+$/, '') === '/v1'
    )
  } catch {
    return false
  }
}

export function getProviderDiscoveryConfig(
  providerId: string,
  provider: ProviderConfig,
): ModelDiscoveryConfig | undefined {
  if (provider.type !== 'openai-compatible') return undefined
  const providerDiscovery = provider.discovery
  if (providerDiscovery) return providerDiscovery
  if (isExactOpenRouterEndpoint(provider.baseURL))
    return { strategy: 'openrouter' }
  if (isExactOllamaEndpoint(provider.baseURL)) return { strategy: 'ollama' }
  return { strategy: 'openai-compatible' }
}

async function readDiscoveryChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal | undefined,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (!signal) return reader.read()
  if (signal.aborted) throw signal.reason
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason)
    signal.addEventListener('abort', onAbort, { once: true })
    reader.read().then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error) => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      },
    )
  })
}

async function readBoundedDiscoveryResponse(
  response: Response,
  signal?: AbortSignal,
): Promise<string> {
  const declaredLength = response.headers.get('content-length')
  if (declaredLength && /^\d+$/.test(declaredLength)) {
    const bytes = Number(declaredLength)
    if (
      !Number.isSafeInteger(bytes) ||
      bytes > MAX_MODEL_DISCOVERY_RESPONSE_BYTES
    )
      throw new Error(
        `Model discovery response exceeds ${MAX_MODEL_DISCOVERY_RESPONSE_BYTES} bytes.`,
      )
  }
  if (!response.body) return ''

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let totalBytes = 0
  try {
    while (true) {
      const { done, value } = await readDiscoveryChunk(reader, signal)
      if (done) break
      totalBytes += value.byteLength
      if (totalBytes > MAX_MODEL_DISCOVERY_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined)
        throw new Error(
          `Model discovery response exceeds ${MAX_MODEL_DISCOVERY_RESPONSE_BYTES} bytes.`,
        )
      }
      chunks.push(value)
    }
  } finally {
    if (signal?.aborted)
      await reader.cancel(signal.reason).catch(() => undefined)
    try {
      reader.releaseLock()
    } catch {
      // A hostile stream may keep a read pending after cancellation. The
      // request still fails by its selected timeout; no further bytes are used.
    }
  }

  const bytes = new Uint8Array(totalBytes)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw new Error('Model discovery response is not valid UTF-8.')
  }
}

// ---------------------------------------------------------------------------
// Core discovery routine
// ---------------------------------------------------------------------------

export async function discoverProviderModels(
  params: DiscoverProviderModelsParams,
): Promise<ProviderModelDiscoveryResult> {
  const env = params.env ?? getSystemProcessEnv()
  const loadedConfig = params.loadedConfig ?? loadProviderConfigSync({ env })
  const provider = loadedConfig.config.providers[params.providerId]
  if (!provider)
    throw new Error(`Provider '${params.providerId}' is not configured.`)
  const discovery = getProviderDiscoveryConfig(params.providerId, provider)
  if (!discovery)
    throw new Error(
      `Provider '${params.providerId}' does not support live model discovery.`,
    )
  const strategy = discovery.strategy ?? 'openai-compatible'
  const endpoint = normalizeEndpoint(provider, discovery)
  const timeoutMs = params.timeoutMs ?? DEFAULT_MODEL_DISCOVERY_TIMEOUT_MS
  const { signal, cleanup } = createDiscoveryAbortSignal({
    parent: params.signal,
    timeoutMs,
  })

  try {
    const response = await params.fetch(endpoint, {
      signal,
      headers: {
        Accept: 'application/json',
        ...(shouldSendAuthorizationHeader({ provider, discovery, endpoint })
          ? authorizationHeaders(provider, env)
          : {}),
      },
    })
    if (!response.ok) {
      throw new Error(
        `Model discovery failed for '${params.providerId}' (${response.status} ${response.statusText}).`,
      )
    }
    const responseText = await readBoundedDiscoveryResponse(response, signal)
    const json = JSON.parse(responseText) as unknown
    const paths = resolvedDiscoveryPaths({
      strategy,
      arrayPath: discovery.arrayPath,
      idPath: discovery.idPath,
    })
    const normalized = normalizeModelsFromResponse({
      json,
      strategy,
      arrayPath: paths.arrayPath,
      idPath: paths.idPath,
    })
    const partial =
      normalized.totalRows === 0 ||
      normalized.skippedRows > 0 ||
      normalized.duplicateModelIds.length > 0
    const result: ProviderModelDiscoveryResult = {
      providerId: params.providerId,
      fetchedAt: new Date().toISOString(),
      schemaVersion: 1,
      strategy,
      endpoint,
      arrayPath: paths.arrayPath,
      idPath: paths.idPath,
      responseSha256: createHash('sha256').update(responseText).digest('hex'),
      modelsSha256: hashNormalizedModels(normalized.models),
      models: normalized.models,
      partial,
      cacheUpdated: !partial,
      ...(normalized.skippedRows
        ? { skippedRows: normalized.skippedRows }
        : {}),
      ...(normalized.duplicateModelIds.length
        ? { duplicateModelIds: normalized.duplicateModelIds }
        : {}),
    }
    if (!partial) writeModelDiscoveryCache(result)
    return result
  } catch (error) {
    if (signal?.aborted && signal.reason instanceof Error) throw signal.reason
    throw error
  } finally {
    cleanup()
  }
}

// ---------------------------------------------------------------------------
// Cache read / write
// ---------------------------------------------------------------------------

function parseDiscoveryCacheEntry(
  candidate: unknown,
): ProviderModelDiscoveryResult | undefined {
  const parsed = discoveryResultCacheSchema.safeParse(candidate)
  if (!parsed.success) return undefined
  const models: DiscoveredModel[] = []
  let skippedRows = parsed.data.skippedRows ?? 0
  for (const model of parsed.data.models) {
    if (!cacheModelHasExplicitCurrency(model)) {
      skippedRows++
      continue
    }
    const parsedModel = discoveredModelCacheSchema.safeParse(model)
    if (!parsedModel.success || CONTROL_CHARACTERS.test(parsedModel.data.id)) {
      skippedRows++
      continue
    }
    const { raw: _legacyRaw, ...cacheable } = parsedModel.data
    if (cacheable.name && CONTROL_CHARACTERS.test(cacheable.name)) {
      skippedRows++
      continue
    }
    models.push(cacheable)
  }

  const actualModelsSha256 = hashNormalizedModels(models)
  if (
    parsed.data.modelsSha256 !== undefined &&
    parsed.data.modelsSha256 !== actualModelsSha256
  )
    return undefined
  const boundPayload = parsed.data.modelsSha256 === actualModelsSha256
  const provenanceComplete =
    parsed.data.schemaVersion === 1 &&
    parsed.data.strategy !== undefined &&
    parsed.data.endpoint !== undefined &&
    parsed.data.responseSha256 !== undefined &&
    boundPayload
  return {
    ...parsed.data,
    models,
    modelsSha256: parsed.data.modelsSha256,
    partial:
      parsed.data.partial === true || skippedRows > 0 || !provenanceComplete,
    cacheUpdated:
      parsed.data.cacheUpdated === true &&
      parsed.data.partial !== true &&
      skippedRows === 0 &&
      provenanceComplete,
    ...(skippedRows ? { skippedRows } : {}),
  }
}

function readAllDiscoveryCacheEntries(): ProviderModelDiscoveryResult[] {
  const cachePath = resolveCachePath()
  if (!fs.existsSync(cachePath)) return []
  try {
    const stat = fs.statSync(cachePath)
    if (!stat.isFile() || stat.size > MAX_MODEL_DISCOVERY_RESPONSE_BYTES * 2)
      return []
    const raw = JSON.parse(fs.readFileSync(cachePath, 'utf8')) as unknown
    let candidates: unknown[]
    if (
      raw &&
      typeof raw === 'object' &&
      !Array.isArray(raw) &&
      (raw as Record<string, unknown>).schemaVersion ===
        MODEL_DISCOVERY_CACHE_SCHEMA_VERSION &&
      Array.isArray((raw as Record<string, unknown>).entries)
    ) {
      candidates = (raw as { entries: unknown[] }).entries.slice(
        -MAX_MODEL_DISCOVERY_CACHE_ENTRIES,
      )
    } else if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      // Legacy provider-id map. Rows without a normalized payload digest are
      // parsed only as inactive migration candidates and never become LKG.
      candidates = Object.values(raw as Record<string, unknown>)
    } else return []
    return candidates
      .map(parseDiscoveryCacheEntry)
      .filter(
        (entry): entry is ProviderModelDiscoveryResult => entry !== undefined,
      )
  } catch {
    // Corrupt or unreadable cache — treat as empty so discovery can re-populate.
    return []
  }
}

function expectedCacheIdentity(
  providerId: string,
  provider: ProviderConfig,
): string | undefined {
  const discovery = getProviderDiscoveryConfig(providerId, provider)
  if (!discovery) return undefined
  const strategy = discovery.strategy ?? 'openai-compatible'
  return cacheEntryIdentity({
    providerId,
    fetchedAt: '',
    models: [],
    schemaVersion: 1,
    strategy,
    endpoint: normalizeEndpoint(provider, discovery),
    ...resolvedDiscoveryPaths({
      strategy,
      arrayPath: discovery.arrayPath,
      idPath: discovery.idPath,
    }),
  })
}

export function readModelDiscoveryCache(
  loadedConfig?: LoadedProviderConfig,
): Record<string, ProviderModelDiscoveryResult> {
  let config: LoadedProviderConfig
  try {
    config = loadedConfig ?? loadProviderConfigSync()
  } catch {
    return {}
  }
  const entries = readAllDiscoveryCacheEntries()
  const cache: Record<string, ProviderModelDiscoveryResult> = {}
  for (const [providerId, provider] of Object.entries(
    config.config.providers,
  )) {
    const identity = expectedCacheIdentity(providerId, provider)
    if (!identity) continue
    const matching = entries
      .filter(
        (entry) =>
          entry.cacheUpdated === true &&
          entry.partial !== true &&
          cacheEntryIdentity(entry) === identity,
      )
      .sort((left, right) => right.fetchedAt.localeCompare(left.fetchedAt))
    if (matching[0]) cache[providerId] = matching[0]
  }
  return cache
}

let cacheTempSequence = 0

function cacheLockOwnerIsDead(raw: string): boolean {
  try {
    const owner = JSON.parse(raw) as { pid?: unknown }
    if (
      typeof owner.pid !== 'number' ||
      !Number.isSafeInteger(owner.pid) ||
      owner.pid <= 0
    )
      return false
    try {
      process.kill(owner.pid, 0)
      return false
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ESRCH'
    }
  } catch {
    return false
  }
}

function tryReclaimDeadCacheLock(lockPath: string): boolean {
  let observed: string
  try {
    observed = fs.readFileSync(lockPath, 'utf8')
    if (!cacheLockOwnerIsDead(observed)) return false
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
  }

  const displaced = `${lockPath}.reclaim-${process.pid}-${cacheTempSequence++}`
  try {
    fs.renameSync(lockPath, displaced)
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
  }
  try {
    const displacedOwner = fs.readFileSync(displaced, 'utf8')
    if (displacedOwner === observed && cacheLockOwnerIsDead(displacedOwner)) {
      fs.unlinkSync(displaced)
      return true
    }
    try {
      fs.renameSync(displaced, lockPath)
    } catch {
      // A newer holder acquired the shared name. Leave the displaced live or
      // uncertain record intact rather than deleting another process's lock.
    }
    return false
  } catch {
    // The displaced file vanished or became unreadable. Never guess ownership.
    return false
  }
}

function withDiscoveryCacheLock<T>(cachePath: string, operation: () => T): T {
  const lockPath = `${cachePath}.lock`
  fs.mkdirSync(path.dirname(cachePath), { recursive: true, mode: 0o700 })
  const startedAt = new Date().getTime()
  const owner = `${JSON.stringify({
    pid: process.pid,
    token: `${process.pid}-${startedAt}-${cacheTempSequence++}`,
  })}\n`

  while (true) {
    let fd: number | undefined
    try {
      fd = fs.openSync(lockPath, 'wx', 0o600)
      fs.writeFileSync(fd, owner, 'utf8')
      fs.fsyncSync(fd)
      fs.closeSync(fd)
      fd = undefined
      break
    } catch (error) {
      if (fd !== undefined) {
        try {
          fs.closeSync(fd)
        } catch {}
        try {
          fs.unlinkSync(lockPath)
        } catch {}
      }
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      try {
        const age = new Date().getTime() - fs.statSync(lockPath).mtimeMs
        if (
          age > MODEL_DISCOVERY_CACHE_LOCK_STALE_MS &&
          tryReclaimDeadCacheLock(lockPath)
        )
          continue
      } catch (statError) {
        if ((statError as NodeJS.ErrnoException).code === 'ENOENT') continue
        throw statError
      }
      if (
        new Date().getTime() - startedAt >=
        MODEL_DISCOVERY_CACHE_LOCK_TIMEOUT_MS
      )
        throw new Error(
          `Timed out acquiring model discovery cache lock '${lockPath}'.`,
        )
      Atomics.wait(cacheLockWaitArray, 0, 0, MODEL_DISCOVERY_CACHE_LOCK_WAIT_MS)
    }
  }

  try {
    return operation()
  } finally {
    try {
      if (fs.readFileSync(lockPath, 'utf8') === owner) fs.unlinkSync(lockPath)
    } catch {
      // Missing/replaced lock is not ours to remove.
    }
  }
}

function writeCacheFileAtomic(
  cachePath: string,
  content: string,
  deps: ModelDiscoveryCacheWriteDeps,
): void {
  fs.mkdirSync(path.dirname(cachePath), { recursive: true, mode: 0o700 })
  const tempPath = `${cachePath}.tmp-${process.pid}-${cacheTempSequence++}`
  let fd: number | undefined
  try {
    fd = fs.openSync(tempPath, 'wx', 0o600)
    fs.writeFileSync(fd, content, 'utf8')
    fs.fsyncSync(fd)
    fs.closeSync(fd)
    fd = undefined
    ;(deps.renameSync ?? fs.renameSync)(tempPath, cachePath)
    try {
      const directoryFd = fs.openSync(path.dirname(cachePath), 'r')
      try {
        fs.fsyncSync(directoryFd)
      } finally {
        fs.closeSync(directoryFd)
      }
    } catch {
      // Some virtual filesystems cannot fsync directories. The atomic rename
      // has still completed; the cache is an optimization, not authority.
    }
    try {
      fs.chmodSync(cachePath, 0o600)
    } catch {
      // Discovery metadata is non-secret; retain the successful atomic write.
    }
  } catch (error) {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd)
      } catch {}
    }
    try {
      fs.unlinkSync(tempPath)
    } catch {}
    throw error
  }
}

export function writeModelDiscoveryCache(
  result: ProviderModelDiscoveryResult,
  deps: ModelDiscoveryCacheWriteDeps = {},
): void {
  const cachePath = resolveCachePath()
  withDiscoveryCacheLock(cachePath, () => {
    const models = cacheableModels(result.models)
    const strategy = result.strategy
    const paths = strategy
      ? resolvedDiscoveryPaths({
          strategy,
          arrayPath: result.arrayPath,
          idPath: result.idPath,
        })
      : undefined
    const prepared: ProviderModelDiscoveryResult = {
      ...result,
      models,
      ...(paths ?? {}),
      modelsSha256: hashNormalizedModels(models),
      partial: result.partial ?? false,
      cacheUpdated: result.cacheUpdated ?? true,
    }
    const identity = cacheEntryIdentity(prepared)
    const prior = readAllDiscoveryCacheEntries()
    const retained = identity
      ? prior.filter((entry) => cacheEntryIdentity(entry) !== identity)
      : prior
    const entries = [...retained, prepared].slice(
      -MAX_MODEL_DISCOVERY_CACHE_ENTRIES,
    )
    writeCacheFileAtomic(
      cachePath,
      `${JSON.stringify(
        { schemaVersion: MODEL_DISCOVERY_CACHE_SCHEMA_VERSION, entries },
        null,
        2,
      )}\n`,
      deps,
    )
  })
}

export function getCachedProviderModels(
  providerId: string,
  loadedConfig?: LoadedProviderConfig,
): DiscoveredModel[] {
  return readModelDiscoveryCache(loadedConfig)[providerId]?.models ?? []
}

// ---------------------------------------------------------------------------
// Merged view: configured + cached
// ---------------------------------------------------------------------------

export function getAvailableProviderModels(
  loadedConfig = loadProviderConfigSync(),
): Array<DiscoveredModel & { providerId: string; configured: boolean }> {
  const cache = readModelDiscoveryCache(loadedConfig)
  const out: Array<
    DiscoveredModel & { providerId: string; configured: boolean }
  > = []
  for (const [providerId, provider] of Object.entries(
    loadedConfig.config.providers,
  )) {
    const configured = new Set(
      Array.isArray(provider.models)
        ? provider.models
        : Object.keys(provider.models),
    )
    for (const model of cache[providerId]?.models ?? []) {
      out.push({
        ...model,
        providerId,
        configured:
          configured.has(model.id) ||
          configured.has(`${providerId}/${model.id}`),
      })
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// Persist a discovered model to provider config
// ---------------------------------------------------------------------------

function normalizeDiscoveryEndpointIdentity(value: string): string | undefined {
  try {
    return new URL(value).toString()
  } catch {
    return undefined
  }
}

function discoveryCacheMatchesProvider(params: {
  providerId: string
  provider: ProviderConfig
  cached: ProviderModelDiscoveryResult | undefined
}): boolean {
  if (!params.cached) return false
  return (
    params.cached.cacheUpdated === true &&
    params.cached.partial !== true &&
    params.cached.modelsSha256 === hashNormalizedModels(params.cached.models) &&
    cacheEntryIdentity(params.cached) ===
      expectedCacheIdentity(params.providerId, params.provider)
  )
}

function mergeDiscoveredCapabilities(
  discovered: ModelCapabilities,
  providerDefault: ModelCapabilities | undefined,
  existing: ModelCapabilities | undefined,
): ModelCapabilities {
  const mergeFields = <T extends Record<string, unknown>>(
    discoveredFields: T | undefined,
    defaultFields: T | undefined,
    existingFields: T | undefined,
  ): T | undefined => {
    const available = { ...(discoveredFields ?? {}) } as T
    for (const key of Object.keys(defaultFields ?? {}))
      delete (available as Record<string, unknown>)[key]
    return Object.keys({ ...available, ...(existingFields ?? {}) }).length
      ? ({ ...available, ...(existingFields ?? {}) } as T)
      : undefined
  }

  return {
    input: mergeFields(
      discovered.input,
      providerDefault?.input,
      existing?.input,
    ),
    context: mergeFields(
      discovered.context,
      providerDefault?.context,
      existing?.context,
    ),
    reasoning: mergeFields(
      discovered.reasoning,
      providerDefault?.reasoning,
      existing?.reasoning,
    ),
    tools: mergeFields(
      discovered.tools,
      providerDefault?.tools,
      existing?.tools,
    ),
    promptCaching: mergeFields(
      discovered.promptCaching,
      providerDefault?.promptCaching,
      existing?.promptCaching,
    ),
    pricing:
      existing?.pricing ??
      (providerDefault?.pricing === undefined ? discovered.pricing : undefined),
    quality: mergeFields(
      discovered.quality,
      providerDefault?.quality,
      existing?.quality,
    ),
    maxOutputBytes:
      existing?.maxOutputBytes ??
      (providerDefault?.maxOutputBytes === undefined
        ? discovered.maxOutputBytes
        : undefined),
  }
}

function hasCapabilities(capabilities: ModelCapabilities): boolean {
  return Object.values(capabilities).some((value) => value !== undefined)
}

export function addDiscoveredModelToProviderConfig(params: {
  providerId: string
  modelId: string
  cwd?: string
  loadedConfig?: LoadedProviderConfig
}): string {
  const loadedConfig = params.loadedConfig ?? loadProviderConfigSync()
  const provider = loadedConfig.config.providers[params.providerId]
  if (!provider)
    throw new Error(`Provider '${params.providerId}' is not configured.`)

  // Strip provider prefix if the caller passed a full routable ID like
  // "ollama/llama3" so we store "llama3" rather than "ollama/llama3" inside
  // the provider's models array (which would produce double-prefixed routes).
  const prefix = `${params.providerId}/`
  const modelId = params.modelId.startsWith(prefix)
    ? params.modelId.slice(prefix.length)
    : params.modelId

  const config = structuredClone(loadedConfig.config)
  const editableProvider = config.providers?.[params.providerId]
  if (!editableProvider)
    throw new Error(`Provider '${params.providerId}' is not editable.`)
  if (Array.isArray(editableProvider.models)) {
    editableProvider.models = Array.from(
      new Set([...editableProvider.models, modelId]),
    ).sort()
  } else {
    editableProvider.models = {
      ...editableProvider.models,
      [modelId]: modelId,
    }
  }

  const cachedDiscovery =
    readModelDiscoveryCache(loadedConfig)[params.providerId]
  const matchingDiscoveryRecords = discoveryCacheMatchesProvider({
    providerId: params.providerId,
    provider,
    cached: cachedDiscovery,
  })
    ? cachedDiscovery!.models.filter((model) => model.id === modelId)
    : []
  if (
    matchingDiscoveryRecords.length === 1 &&
    matchingDiscoveryRecords[0]!.capabilities
  ) {
    const existing = editableProvider.modelCapabilities?.[modelId]
    const merged = mergeDiscoveredCapabilities(
      matchingDiscoveryRecords[0]!.capabilities!,
      editableProvider.defaultCapabilities,
      existing,
    )
    if (hasCapabilities(merged)) {
      editableProvider.modelCapabilities = {
        ...(editableProvider.modelCapabilities ?? {}),
        [modelId]: merged,
      }
    }
  }
  const parseResult = providerConfigFileSchema.safeParse(config)
  if (!parseResult.success)
    throw new Error(
      `Invalid provider config after adding model: ${parseResult.error.message}`,
    )
  const sourceConfigPath = loadedConfig.sourceFilePaths.at(-1)
  return writeProviderConfigFile({
    cwd:
      params.cwd ??
      (sourceConfigPath ? path.dirname(sourceConfigPath) : undefined),
    config,
  })
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

export function formatDiscoveredModels(
  providerId: string,
  result: ProviderModelDiscoveryResult,
  loadedConfig = loadProviderConfigSync(),
): string {
  const lines: string[] = []
  const provider = loadedConfig.config.providers[providerId]
  const configured = new Set(
    provider && Array.isArray(provider.models)
      ? provider.models
      : Object.keys(provider?.models ?? {}),
  )
  lines.push(
    `Discovered ${result.models.length} model(s) for ${providerId} (fetched ${result.fetchedAt}):`,
  )
  if (result.partial || result.cacheUpdated === false) {
    const details = [
      result.skippedRows ? `${result.skippedRows} malformed row(s)` : undefined,
      result.duplicateModelIds?.length
        ? `duplicate id(s): ${result.duplicateModelIds.join(', ')}`
        : undefined,
    ].filter(Boolean)
    lines.push(
      `Warning: partial/empty discovery was not cached${details.length ? ` (${details.join('; ')})` : ''}; the prior cache remains active.`,
    )
  }
  lines.push('')
  for (const model of result.models) {
    const isConfigured =
      configured.has(model.id) || configured.has(`${providerId}/${model.id}`)
    const suffix = isConfigured ? ' (configured)' : ' (discovered)'
    lines.push(`  ${model.id}${suffix}`)
  }
  lines.push('')
  lines.push(
    `Use /provider models ${providerId} add <model-id> to add a discovered model to your config.`,
  )
  lines.push(
    `Use /provider models ${providerId} --refresh to update discovered models.`,
  )
  return lines.join('\n')
}
