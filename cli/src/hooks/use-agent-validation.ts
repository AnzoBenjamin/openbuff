import { validateAgents } from '@openbuff/sdk'
import { useCallback, useRef, useState } from 'react'

import { whenRegistriesReady } from '../services/deferred-registries'
import {
  getAgentRegistryDiagnostics,
  getAgentRegistryEpoch,
  loadAgentDefinitions,
} from '../utils/local-agent-registry'
import { logger } from '../utils/logger'
import { filterNetworkErrors } from '../utils/validation-error-helpers'

export type ValidationError = {
  id: string
  message: string
}

export type ValidationCheckResult = {
  success: boolean
  errors: ValidationError[]
}

type UseAgentValidationResult = {
  validationErrors: ValidationError[]
  isValidating: boolean
  validate: () => Promise<ValidationCheckResult>
}

/**
 * Pure per-registry-epoch cache for the full local agent validation result
 * (exported pure for tests, mirroring use-input-history.ts): validation of
 * every bundled agent definition costs ~40ms per send, and the registry only
 * changes on reload, so the result is cached under getAgentRegistryEpoch()
 * and reused until the epoch advances (initializeAgentRegistry and
 * __resetLocalAgentRegistryForTests bump it). The cache holds ONE slot: a
 * set under a new epoch evicts the previous epoch's result, so a hit is
 * only ever served for the registry generation that is still current. The
 * catch-path failure result is NEVER cached (see validate).
 *
 * IN-FLIGHT DEDUP (getOrJoin): the cache also holds ONE in-flight pass
 * slot, keyed by the same epoch. Concurrent same-epoch misses — e.g. two
 * overlapping sends before the first validation pass completes — JOIN the
 * single in-flight pass through getOrJoin instead of each re-running the
 * full (whenRegistriesReady + loadAgentDefinitions + ~40ms Zod
 * validateAgents) pass, so an unchanged registry costs one full validation
 * per epoch even under concurrent sends. getOrJoin NEVER writes the
 * completed-result slot: the pass body owns its set() calls (preserving
 * the catch-path-never-cached contract), and the in-flight slot is
 * transient — cleared when the pass settles, either way, so a settled
 * (fulfilled or rejected) pass is never joined by a later caller.
 */
export const createValidationCache = (): {
  get: (epoch: number) => ValidationCheckResult | null
  set: (epoch: number, result: ValidationCheckResult) => void
  getOrJoin: (
    epoch: number,
    run: () => Promise<ValidationCheckResult>,
  ) => Promise<ValidationCheckResult>
} => {
  let cachedEpoch: number | null = null
  let cachedResult: ValidationCheckResult | null = null
  let inFlightEpoch: number | null = null
  let inFlightPass: Promise<ValidationCheckResult> | null = null
  return {
    get: (epoch: number): ValidationCheckResult | null =>
      cachedEpoch === epoch ? cachedResult : null,
    set: (epoch: number, result: ValidationCheckResult): void => {
      cachedEpoch = epoch
      cachedResult = result
    },
    getOrJoin: (
      epoch: number,
      run: () => Promise<ValidationCheckResult>,
    ): Promise<ValidationCheckResult> => {
      if (inFlightEpoch === epoch && inFlightPass) {
        return inFlightPass
      }
      const pass = run().finally(() => {
        // Clear ONLY this pass's slot: a newer pass that already replaced
        // it (a mid-flight epoch bump) must survive, and the next
        // same-epoch caller after settle starts a fresh pass — a settled
        // pass is never joined.
        if (inFlightEpoch === epoch && inFlightPass === pass) {
          inFlightEpoch = null
          inFlightPass = null
        }
      })
      inFlightEpoch = epoch
      inFlightPass = pass
      return pass
    },
  }
}

/**
 * Hook that provides agent validation functionality.
 * Call validate() manually to trigger validation (e.g., on message send).
 */
export const useAgentValidation = (): UseAgentValidationResult => {
  const [validationErrors, setValidationErrors] = useState<ValidationError[]>(
    [],
  )
  const [isValidating, setIsValidating] = useState(false)
  // In-flight pass COUNTER: a boolean flips false the moment ANY pass
  // settles, so if an epoch bump mid-validation starts a newer pass that is
  // still running when the older one finishes, isValidating would read
  // false while the newer pass is in flight. The counter only reaches zero
  // when the LAST pass settles, so the flag tracks the true in-flight set.
  // It is a ref (no re-render); the state write remains the render signal.
  const inFlightPassesRef = useRef(0)

  // Lazy-init ref (mirroring streamRefsRef in use-send-message.ts): the
  // epoch-keyed validation cache survives re-renders with a stable identity
  // so a cached result is reusable across the component's lifetime.
  const validationCacheRef = useRef<ReturnType<
    typeof createValidationCache
  > | null>(null)
  if (!validationCacheRef.current) {
    validationCacheRef.current = createValidationCache()
  }

  // The FULL validation pass (the cache-miss body): kept as its own callback
  // so validate() can route it through the cache's getOrJoin — concurrent
  // same-epoch misses JOIN this single in-flight pass instead of each
  // re-running whenRegistriesReady + loadAgentDefinitions + the ~40ms Zod
  // validateAgents (validation-cache-no-inflight-dedup), so an unchanged
  // registry costs ONE full validation per epoch even under concurrent
  // sends. Only the pass body toggles isValidating; joiners await the same
  // promise without re-entering it. registryEpoch is read ONCE by validate()
  // and passed in, so it keys both the getOrJoin slot and every set() below:
  // a reload landing mid-validation can only invalidate the cache — it can
  // never serve a pre-reload result for a post-reload send. The catch-path
  // result is still never cached.
  const runValidationPass = useCallback(
    async (registryEpoch: number): Promise<ValidationCheckResult> => {
      inFlightPassesRef.current += 1
      setIsValidating(true)

      try {
        // P1-T9 gating: this hook reads the agent registry via
        // loadAgentDefinitions, so the deferred registry loads must have
        // settled BEFORE it runs — otherwise a mid-startup validation
        // observes an empty/partial registry. Resolves immediately once
        // ready (or when no deferred load ran, e.g. on the
        // serve/mcp/run/replay paths).
        await whenRegistriesReady()
        const agentDefinitions = loadAgentDefinitions()

        const validationResult = await validateAgents(agentDefinitions, {
          remote: false,
        })
        const loadDiagnostics = getAgentRegistryDiagnostics().map(
          (diagnostic, index) => ({
            id: `${diagnostic.agentId || 'local-agent'}_load_${index}`,
            message: diagnostic.filePath
              ? `${diagnostic.message} (${diagnostic.filePath})`
              : diagnostic.message,
          }),
        )

        if (validationResult.success && loadDiagnostics.length === 0) {
          setValidationErrors([])
          const result: ValidationCheckResult = { success: true, errors: [] }
          validationCacheRef.current?.set(registryEpoch, result)
          return result
        } else {
          const filteredValidationErrors = [
            ...filterNetworkErrors(validationResult.validationErrors),
            ...loadDiagnostics,
          ]

          if (filteredValidationErrors.length === 0) {
            setValidationErrors([])
            const result: ValidationCheckResult = { success: true, errors: [] }
            validationCacheRef.current?.set(registryEpoch, result)
            return result
          }

          setValidationErrors(filteredValidationErrors)
          const result: ValidationCheckResult = {
            success: false,
            errors: filteredValidationErrors,
          }
          validationCacheRef.current?.set(registryEpoch, result)
          return result
        }
      } catch (error) {
        logger.error({ error }, 'Agent validation failed with exception')
        // Don't update validation errors on exception - keep previous state
        // Return failure to block message sending on validation errors
        return { success: false, errors: [] }
      } finally {
        inFlightPassesRef.current -= 1
        // Only the LAST in-flight pass clears the flag: a newer-epoch pass
        // started while this one was still running (an epoch bump
        // mid-validation) keeps the UI validating until it settles too.
        if (inFlightPassesRef.current === 0) {
          setIsValidating(false)
        }
      }
    },
    [],
  )

  // Validate agents and update state
  // Returns validation result with success status and any errors
  const validate = useCallback(async (): Promise<ValidationCheckResult> => {
    // Cache probe BEFORE any state writes: on a hit the cached result is
    // returned without toggling isValidating, so an unchanged registry costs
    // one epoch lookup per send instead of a full Zod pass over every
    // bundled agent definition. On a miss the full pass runs through the
    // cache's getOrJoin: concurrent same-epoch sends (e.g. two overlapping
    // sends before the first pass completes) JOIN the single in-flight pass
    // instead of each re-running it, so the costing above holds under
    // concurrent sends too. The epoch is read ONCE and keys this probe, the
    // getOrJoin slot, and the pass's cache writes below, so a reload that
    // lands mid-validation can only invalidate the cache — it can never
    // serve a pre-reload result for a post-reload send. The catch-path
    // result below is never cached: an exception is transient and must
    // re-validate on the next send.
    const registryEpoch = getAgentRegistryEpoch()
    const cachedResult = validationCacheRef.current?.get(registryEpoch)
    if (cachedResult) {
      return cachedResult
    }

    const cache = validationCacheRef.current
    if (cache) {
      return cache.getOrJoin(registryEpoch, () =>
        runValidationPass(registryEpoch),
      )
    }
    // No cache instance (never in practice — the ref is lazily initialized
    // above): run the pass directly rather than skipping validation.
    return runValidationPass(registryEpoch)
  }, [runValidationPass])

  return {
    validationErrors,
    isValidating,
    validate,
  }
}
