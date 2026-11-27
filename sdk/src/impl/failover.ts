/**
 * Provider failover helpers.
 *
 * Pure functions for resolving the configured failover model list and
 * classifying errors as failover-eligible. Kept separate from
 * `promptAiSdkStream` so they can be unit-tested without streaming or LLM
 * round-trips (mirrors the `error-utils.ts` / `preflight-syntax-validation.ts`
 * pure-helper precedent).
 */

import { createHmac, randomBytes } from 'node:crypto'
import { NoOutputGeneratedError } from 'ai'

import {
  getErrorStatusCode,
  isProviderAbortError,
  normalizeProviderContentPolicyError,
  providerErrorChain,
} from '../error-utils'

import type { LoadedProviderConfig } from '../provider-config'

/**
 * HTTP status codes that should trigger failover to the next configured
 * backup provider (after the inner retry loop has exhausted its retries for
 * retryable 5xx codes).
 *
 * This is `(RETRYABLE_STATUS_CODES ∪ {401, 403}) − {408, 429}`:
 * - 401/403 (auth): retrying won't help; failover immediately after the retry
 *   loop throws (the retry loop does NOT retry auth errors since they're not
 *   in RETRYABLE_STATUS_CODES, so the outer failover loop sees them right
 *   away).
 * - 500/502/503/504 (server) and 529 (Anthropic overloaded, including the
 *   SSE `overloaded_error` event): retryable, so the inner loop retries
 *   first; if retries exhaust, the outer loop failovers.
 * - 429 (rate limit): retry-only. Failover on 429 risks cascading load across
 *   providers; backoff is the proven response.
 * - 408 (timeout): retry-only. Network-level; failover unlikely to help.
 */
export const FAILOVER_ELIGIBLE_STATUS_CODES = new Set([
  401, 403, 500, 502, 503, 504, 529,
])

/**
 * Resolve the ordered list of models to attempt for a request, starting with
 * the primary requested model followed by the configured failover models.
 *
 * The primary model is always first. The failover list is deduped both against
 * the primary AND within itself (preserving first-seen order), so a
 * misconfigured `failoverModels` that repeats the primary or lists a backup
 * multiple times does not cause a redundant same-model attempt. If no failover
 * models are configured, returns a single-element list containing only the
 * primary (or an empty list when `primaryModel` is undefined).
 */
export function resolveModelsToTry(
  primaryModel: string | undefined,
  loadedConfig: LoadedProviderConfig | undefined,
): string[] {
  const failoverModels = loadedConfig?.config?.failoverModels ?? []
  const primary = primaryModel ? [primaryModel] : []
  // Dedupe against the primary AND within failoverModels itself, preserving
  // first-seen order. A misconfigured list with duplicate backups must not
  // cause the loop to wastefully retry the same backup model twice.
  const seen = new Set<string>(primary)
  const dedupedFailovers: string[] = []
  for (const model of failoverModels) {
    if (seen.has(model)) continue
    seen.add(model)
    dedupedFailovers.push(model)
  }
  return [...primary, ...dedupedFailovers]
}

/**
 * Classify whether an error is eligible to trigger failover to the next
 * configured backup provider.
 *
 * Per the documented `failoverModels` contract (provider-config.ts): failover
 * fires on errors carrying a failover-eligible HTTP status code
 * (401/403/500/502/503/504/529). Provider content-policy errors are NOT
 * failover-eligible (M3-T4): a policy refusal is deterministic, so retrying
 * the same prompt against the next configured model/provider is a
 * documented-contract violation and a policy-evasion path — the policy error
 * fails fast instead. Other non-HTTP errors (network blips, aborts, etc.) are
 * handled by the inner retry loop's transient-error path.
 */
export function isFailoverEligibleError(error: unknown): boolean {
  // Content-policy refusals are never failover-eligible regardless of any
  // preserved status code: normalizeProviderContentPolicyError keeps the
  // original statusCode (e.g. a 503 whose body mentions policy normalizes to
  // statusCode 503), so the status check alone would fail over a
  // deterministic refusal — the exact policy-evasion path the M3-T4 contract
  // closes (reliability finding
  // content-policy-status-preserved-through-normalization).
  if (isProviderAbortError(error) || normalizeProviderContentPolicyError(error))
    return false
  if (
    [...providerErrorChain(error)].some(
      (value) =>
        value.code === 'provider_configuration' ||
        value.code === 'provider_route_excluded',
    )
  )
    return false
  // An empty stream (NoOutputGeneratedError from the AI SDK) means the
  // provider accepted the connection but produced zero chunks before a clean
  // close, so the primary model failed without emitting anything. A backup
  // model attempt is worthwhile; the failover loop's `anyContentYielded`
  // guard already protects against duplicating output.
  if (NoOutputGeneratedError.isInstance(error)) return true
  const statusCode = getErrorStatusCode(error)
  if (statusCode === undefined) return false
  return FAILOVER_ELIGIBLE_STATUS_CODES.has(statusCode)
}

/** Auth statuses that mark a route degraded for the rest of the session. */
export const ROUTE_DEGRADING_STATUS_CODES: ReadonlySet<number> = new Set([
  401, 403,
])

export type DegradedRoute = Readonly<{
  model: string
  statusCode: number
  /** The model the request failed over to when the route was marked. */
  replacementModel?: string
  markedAtMs: number
}>

/**
 * Session record of routes that failed authentication (N07). A revoked or
 * expired key will keep failing, so later requests skip the route instead of
 * paying a 401 round trip every time. Cleared on restart or by
 * {@link clearDegradedProviderRoutes} (the CLI calls it from `/provider`).
 */
export type RouteHealthRegistry = {
  markDegraded(route: Omit<DegradedRoute, 'markedAtMs'>): void
  get(model: string): DegradedRoute | undefined
  clear(): void
}

export function createRouteHealthRegistry(
  now: () => number = Date.now,
): RouteHealthRegistry {
  const degraded = new Map<string, DegradedRoute>()
  return {
    markDegraded(route) {
      degraded.set(route.model, Object.freeze({ ...route, markedAtMs: now() }))
    },
    get: (model) => degraded.get(model),
    clear: () => degraded.clear(),
  }
}

/** Process-wide registry used when the caller does not inject one. */
export const sessionRouteHealth: RouteHealthRegistry =
  createRouteHealthRegistry()

const routeScopeKey = randomBytes(32)
const MAX_ROUTE_HEALTH_SCOPES = 64
const scopedRouteHealth = new Map<string, RouteHealthRegistry>()

/**
 * Default health belongs to a captured route configuration and environment
 * credential selection, not just a model ID shared by unrelated SDK hosts.
 * Custom credential ports are separated by their host-owned source identity;
 * stored OAuth metadata revisions can be supplied without resolving secrets.
 * A host that rotates credentials in place inside one custom port must clear
 * health (or inject a separate registry); there is no new public version API.
 * Keyed HMACs retain neither keys nor configuration text in this registry.
 */
export function getScopedSessionRouteHealth(params: {
  loadedConfig: LoadedProviderConfig
  configurationIdentity?: string
  credentialSourceIdentity?: string | ((model: string) => string)
  environment: Readonly<Record<string, string | undefined>>
  apiKey?: string
}): RouteHealthRegistry {
  if (typeof params.credentialSourceIdentity === 'function') {
    const identityForModel = params.credentialSourceIdentity
    const visited = new Set<RouteHealthRegistry>()
    const forModel = (model: string) => {
      const health = getScopedSessionRouteHealth({
        ...params,
        credentialSourceIdentity: identityForModel(model),
      })
      visited.add(health)
      return health
    }
    return {
      markDegraded: (route) => forModel(route.model).markDegraded(route),
      get: (model) => forModel(model).get(model),
      clear: () => {
        for (const health of visited) health.clear()
      },
    }
  }
  const names = new Set([
    'OPENBUFF_CHATGPT_OAUTH_TOKEN',
    'CODEBUFF_CHATGPT_OAUTH_TOKEN',
  ])
  for (const provider of Object.values(params.loadedConfig.config.providers))
    if ('apiKeyEnv' in provider && provider.apiKeyEnv)
      names.add(provider.apiKeyEnv)
  const key = createHmac('sha256', routeScopeKey)
    .update(
      JSON.stringify([
        'openbuff.route-health.v1',
        params.configurationIdentity ??
          params.loadedConfig.sourceFilePaths ??
          [],
        params.loadedConfig.config,
        params.credentialSourceIdentity ?? null,
        [...names]
          .sort()
          .map((name) => [name, params.environment[name] ?? null]),
        params.apiKey ?? null,
      ]),
    )
    .digest('hex')
  let health = scopedRouteHealth.get(key)
  if (health) scopedRouteHealth.delete(key)
  else {
    health = createRouteHealthRegistry()
    if (scopedRouteHealth.size >= MAX_ROUTE_HEALTH_SCOPES)
      scopedRouteHealth.delete(scopedRouteHealth.keys().next().value!)
  }
  scopedRouteHealth.set(key, health)
  return health
}

export function clearDegradedProviderRoutes(): void {
  sessionRouteHealth.clear()
  for (const health of scopedRouteHealth.values()) health.clear()
  scopedRouteHealth.clear()
}

/**
 * Move degraded routes behind the healthy ones, keeping relative order. A
 * degraded route stays in the list as a last resort, so a request still has a
 * route to try when every route is degraded (or the key has been fixed).
 */
export function orderModelsByRouteHealth(
  models: readonly string[],
  health: Pick<RouteHealthRegistry, 'get'>,
): string[] {
  const healthy = models.filter((model) => health.get(model) === undefined)
  if (healthy.length === 0 || healthy.length === models.length)
    return [...models]
  return [
    ...healthy,
    ...models.filter((model) => health.get(model) !== undefined),
  ]
}
