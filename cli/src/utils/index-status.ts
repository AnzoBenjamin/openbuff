import { IndexManager } from '@codebuff/indexer'
import { loadProviderConfigSync } from '@openbuff/sdk'

import { getProjectRoot } from '../project-files'

export type IndexStatusChip = {
  label: string
  tone: 'secondary' | 'warning' | 'error'
} | null

export type IndexStatusPeek = {
  state: string
  refreshing: boolean
  // Optional, additive: the number of parse diagnostics reported by
  // getStatus(). Threaded through so formatIndexStatusChip can surface a
  // concise reason on the 'idx degraded' chip. Existing callers that omit it
  // keep the backward-compatible plain label.
  diagnosticsCount?: number
} | null

// Track the project root used when the IndexManager singleton was first
// initialized. If getProjectRoot() changes, the singleton silently keeps its
// original root; we return null instead of reporting status for the wrong root.
let _indexManagerRoot: string | null = null
// Cache the provider config to avoid repeated synchronous file I/O on every call.
// undefined = not yet loaded; null = loaded but no usable indexing config (negative cache).
// The cache is revalidated on a TTL (PROVIDER_CONFIG_REVALIDATE_MS below) so
// mid-session config changes are picked up without a process restart.
let _cachedProviderConfig: ReturnType<typeof loadProviderConfigSync> | null | undefined = undefined
// A loadProviderConfigSync() throw is typically transient (e.g. the config file
// being rewritten mid-read), so it must NOT be latched into the null negative
// cache: that would permanently disable the index status chip for the rest of
// the process with no retry path. Instead the cache stays undefined so a later
// peek can retry, and _providerConfigLoadFailedAt bounds those retries with a
// backoff so a persistent failure does not degenerate into per-tick
// synchronous file I/O.
const PROVIDER_CONFIG_RETRY_MS = 5_000
let _providerConfigLoadFailedAt = 0
// TTL after which the (positive or negative) provider config cache expires
// and the next peek reloads the config. Without this, a config change during
// the session (indexing enabled<->disabled, or a provider config appearing
// after startup) would never be reflected in the index chip until process
// restart. The TTL keeps the synchronous reload rare (amortized over the
// 200ms peek cache) while preserving the pre-cache recovery behavior.
const PROVIDER_CONFIG_REVALIDATE_MS = 30_000
let _providerConfigCachedAt = 0

// _lastPeekResult and _lastPeekAt provide a short-duration result cache so
// that callers on a render/polling tick (which may fire many times per second)
// do not pay the cost of getProjectRoot() + IndexManager.getInstance().getStatus()
// on every invocation when nothing has changed.
const PEEK_CACHE_TTL_MS = 200
let _lastPeekResult: IndexStatusPeek = null
let _lastPeekAt = 0

// ---- Test seams -------------------------------------------------------------
// peekIndexStatus() caches state in module-level variables and calls
// Date.now(), loadProviderConfigSync(), getProjectRoot() and the IndexManager
// singleton directly, which makes the layered caching unobservable from a test
// without module mocks — and bun test runs every suite in one process, where
// module mocks would leak into unrelated suites. These indirections default to
// the real operations; _setIndexStatusTestOverrides replaces the whole set, so
// production behavior is unchanged.

type GetStatusFn = (
  root: string,
  indexing: Parameters<typeof IndexManager.getInstance>[1],
) => { state: string; refreshing: boolean; diagnosticsCount: number }

const _defaultGetIndexStatus: GetStatusFn = (root, indexing) => {
  const status = IndexManager.getInstance(root, indexing).getStatus()
  return {
    state: status.state,
    refreshing: status.refreshing,
    diagnosticsCount: status.diagnostics.length,
  }
}

type IndexStatusTestOverrides = {
  /** Virtual clock replacing Date.now() on the peek path. */
  now?: () => number
  /** Test double for the synchronous provider-config load. */
  loadProviderConfig?: () => ReturnType<typeof loadProviderConfigSync>
  /** Test double for getProjectRoot(). */
  getRoot?: () => string
  /** Test double for the IndexManager.getInstance(...).getStatus() tail. */
  getStatus?: GetStatusFn
}

const _testOverrides: IndexStatusTestOverrides = {}

/**
 * Install test doubles for the peek collaborators. Replaces the whole override
 * set; any collaborator not listed falls back to the real implementation. Pair
 * with {@link _resetIndexStatusTestState} in an afterEach so cached module
 * state cannot leak between suites.
 */
export const _setIndexStatusTestOverrides = (
  overrides: IndexStatusTestOverrides,
): void => {
  _testOverrides.now = overrides.now
  _testOverrides.loadProviderConfig = overrides.loadProviderConfig
  _testOverrides.getRoot = overrides.getRoot
  _testOverrides.getStatus = overrides.getStatus
}

/** Clear test doubles and restore the module's cached state to first use. */
export const _resetIndexStatusTestState = (): void => {
  _setIndexStatusTestOverrides({})
  _indexManagerRoot = null
  _cachedProviderConfig = undefined
  _providerConfigLoadFailedAt = 0
  _providerConfigCachedAt = 0
  _lastPeekResult = null
  _lastPeekAt = 0
}

function _computePeekIndexStatus(): IndexStatusPeek {
  // Resolve each collaborator once per compute: with no overrides installed
  // these are the real operations, so production behavior is unchanged; with
  // overrides installed the identical logic below runs against the doubles.
  const now = _testOverrides.now ?? Date.now
  const loadProviderConfig =
    _testOverrides.loadProviderConfig ?? loadProviderConfigSync
  const getRoot = _testOverrides.getRoot ?? getProjectRoot
  const getStatus = _testOverrides.getStatus ?? _defaultGetIndexStatus
  try {
    if (
      _cachedProviderConfig !== undefined &&
      now() - _providerConfigCachedAt >= PROVIDER_CONFIG_REVALIDATE_MS
    ) {
      // Expire the cached config (positive or negative) so the load below
      // re-reads the provider config and picks up mid-session changes.
      _cachedProviderConfig = undefined
    }
    if (_cachedProviderConfig === undefined) {
      // Backoff gate: while a recent load failure is still within the retry
      // window, a peek must not re-run the synchronous load on every render
      // tick. After the window elapses the load is attempted again, so a
      // transient failure recovers instead of being latched in permanently.
      if (
        _providerConfigLoadFailedAt !== 0 &&
        now() - _providerConfigLoadFailedAt < PROVIDER_CONFIG_RETRY_MS
      ) {
        return null
      }
      const loaded = loadProviderConfig()
      _providerConfigLoadFailedAt = 0
      // Normalize to null (negative cache) when there is no usable indexing
      // config. This establishes the invariant that null means "no usable
      // indexing config", so subsequent calls hit the null guard below
      // directly instead of reaching `config.indexing` with an undefined
      // value and throwing TypeError.
      _cachedProviderConfig = loaded?.config?.indexing != null ? loaded : null
      _providerConfigCachedAt = now()
    }
    if (_cachedProviderConfig === null) return null
    const indexing = _cachedProviderConfig.config.indexing
    if (indexing.enabled === false) return null
    const currentRoot = getRoot()
    // If the singleton was already initialized with a different root, getInstance
    // silently ignores the new root. Return null rather than reporting stale
    // status for the original root.
    if (_indexManagerRoot !== null && _indexManagerRoot !== currentRoot) {
      // Do NOT reset _cachedProviderConfig here: the provider config is loaded
      // independently of the project root, and clearing it would cause
      // loadProviderConfigSync() to re-run on every subsequent call after a
      // root change, producing perpetual synchronous I/O with no stable state.
      // Do NOT update _indexManagerRoot here. The singleton retains the root it
      // was first initialized with; keeping _indexManagerRoot at that original
      // value ensures the guard fires on every subsequent call after a root
      // change, so we never return the stale singleton's status.
      return null
    }
    const status = getStatus(currentRoot, indexing)
    // Assign only after getInstance() succeeds. If getInstance() throws
    // (caught by the outer try/catch), _indexManagerRoot stays null so a
    // subsequent call with any root can retry rather than being silently
    // suppressed by the stale-root guard above.
    _indexManagerRoot = currentRoot
    if (status.state === 'disabled') return null
    // diagnosticsCount is an optional, additive field consumed only by
    // formatIndexStatusChip for the 'degraded' chip reason. Omit it when there
    // are no diagnostics so a healthy peek result stays the minimal
    // { state, refreshing } shape and the field remains truly optional for
    // callers (and comparisons) that never surface a parse-diagnostic count.
    return status.diagnosticsCount > 0
      ? {
          state: status.state,
          refreshing: status.refreshing,
          diagnosticsCount: status.diagnosticsCount,
        }
      : {
          state: status.state,
          refreshing: status.refreshing,
        }
  } catch {
    // While the cache is still undefined, the only throwing operation on this
    // path is loadProviderConfigSync() above (the normalization and the
    // loaded-config path below are non-throwing), so record the failure for
    // the backoff and leave _cachedProviderConfig undefined: the next peek
    // after the backoff retries instead of the throw being latched in as a
    // permanent null negative cache. A throw later in the function (e.g. from
    // getInstance/getStatus) bumps this timestamp too, but it has no effect
    // there because the retry gate is only consulted while the cache is
    // still undefined.
    _providerConfigLoadFailedAt = now()
    return null
  }
}

/** Peek the CLI index singleton without constructing an embedder. */
export function peekIndexStatus(): IndexStatusPeek {
  const now = (_testOverrides.now ?? Date.now)()
  if (now - _lastPeekAt < PEEK_CACHE_TTL_MS) {
    return _lastPeekResult
  }
  const result = _computePeekIndexStatus()
  _lastPeekResult = result
  _lastPeekAt = now
  return result
}

export function formatIndexStatusChip(
  status: {
    state: string
    refreshing: boolean
    diagnosticsCount?: number
  } | null,
): IndexStatusChip {
  if (!status) return null
  if (status.state === 'disabled' || status.state === 'empty') return null
  if (status.state === 'failed') {
    return { label: 'idx failed', tone: 'error' }
  }
  if (status.state === 'building') {
    return { label: 'idx building', tone: 'warning' }
  }
  if (status.refreshing) {
    return { label: 'idx refreshing', tone: 'warning' }
  }
  if (status.state === 'stale') {
    return { label: 'idx stale', tone: 'warning' }
  }
  if (status.state === 'degraded') {
    const { diagnosticsCount } = status
    const label =
      diagnosticsCount && diagnosticsCount > 0
        ? `idx degraded · ${diagnosticsCount} parse err`
        : 'idx degraded'
    return { label, tone: 'warning' }
  }
  // Healthy snapshots are silent; only building / refreshing / stale / failed / degraded show.
  return null
}

export function shouldForceStatusLineForIndex(
  status: { state: string; refreshing: boolean } | null,
): boolean {
  if (!status) return false
  // 'degraded' renders an 'idx degraded' warning chip in formatIndexStatusChip,
  // so like building/failed it must force the status line to render, otherwise
  // the chip stays invisible until an unrelated re-render.
  return (
    status.state === 'building' ||
    status.state === 'degraded' ||
    status.state === 'failed' ||
    status.refreshing
  )
}
