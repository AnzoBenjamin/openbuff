import { logger } from '../utils/logger'
import { initializeAgentRegistry } from '../utils/local-agent-registry'
import { initializeSkillRegistry } from '../utils/skill-registry'

/**
 * Deferred agent/skill registry loading (P1-T9 startup latency).
 *
 * The agent and skill registries scan `.agents` / `.agents/skills` via the
 * SDK, which is not needed to paint the first TUI frame. Loading them
 * synchronously at startup serialized that disk work ahead of the first
 * render. Instead the loads are kicked off post-first-frame (non-blocking)
 * and consumers that need the registries gate on `whenRegistriesReady()`.
 *
 * The underlying initializers are themselves fail-safe: each catches its own
 * errors, logs a warning, and keeps a last-known-good (or empty) cache. The
 * outer `.catch` here is belt-and-suspenders so a rejected deferred load can
 * never surface as an unhandledRejection and crash the CLI; the promise never
 * rejects.
 */

let registriesPromise: Promise<void> | null = null
// The options the current (possibly in-flight) load was started with; kept so
// `awaitRegistriesReady` can warn when a caller's options would otherwise be
// silently dropped, and so `resetDeferredRegistryLoads` can clear them.
let pendingLoadOptions: {
  shouldLoadAgents: boolean
  effectiveTrust: boolean
} | null = null

export function startDeferredRegistryLoads(options: {
  shouldLoadAgents: boolean
  effectiveTrust: boolean
}): void {
  if (registriesPromise) {
    return
  }
  const { shouldLoadAgents, effectiveTrust } = options
  pendingLoadOptions = { shouldLoadAgents, effectiveTrust }
  registriesPromise = (async () => {
    // When --agent is provided, skip local .agents to avoid overrides.
    if (shouldLoadAgents) {
      await initializeAgentRegistry({ trustProjectAgents: effectiveTrust })
    }
    await initializeSkillRegistry({ trustProjectSkills: effectiveTrust })
  })().catch((error) => {
    logger.warn({ error }, 'Deferred agent/skill registry load failed')
  })
}

/**
 * Drops the deferred registry loads (completed or in flight) so the next
 * `startDeferredRegistryLoads` / `awaitRegistriesReady` starts a fresh load.
 * Called when the project context switches: an in-flight load was kicked off
 * with the PREVIOUS project's trust decision, so letting it satisfy later
 * `whenRegistriesReady()` consumers would resolve stale/foreign trust
 * decisions for the new project. The in-flight promise itself is not
 * cancelled — the underlying initializers are fail-safe (see the module
 * docstring above) — it simply no longer gates consumers.
 */
export function resetDeferredRegistryLoads(): void {
  registriesPromise = null
  pendingLoadOptions = null
}

/**
 * Resolves once the deferred agent/skill registry loads have settled
 * (successfully or not). Resolves immediately when no deferred load was
 * started — e.g. before `startDeferredRegistryLoads` has been called on a
 * non-renderer command path — so those consumers keep their previous
 * behavior of an un-gated (or command-managed) registry.
 */
export const whenRegistriesReady = (): Promise<void> =>
  registriesPromise ?? Promise.resolve()

/**
 * Awaits the deferred agent/skill registry loads on the non-renderer command
 * paths (serve / mcp / run / replay), restoring the pre-P1-T9 contract that
 * those paths had fully initialized registries before any consumer reads
 * them. When `startDeferredRegistryLoads` has not been called yet (the
 * command dispatches before the renderer path starts the loads), this starts
 * the loads and awaits them; otherwise it awaits the already-running loads.
 * When a load is already running with different options, those options are
 * dropped with a warning (use `resetDeferredRegistryLoads` — e.g. on a
 * project switch — to make re-initialization with the new options possible).
 * The returned promise never rejects (the loads are fail-safe; see the
 * module docstring above).
 */
export async function awaitRegistriesReady(options: {
  shouldLoadAgents: boolean
  effectiveTrust: boolean
}): Promise<void> {
  if (!registriesPromise) {
    startDeferredRegistryLoads(options)
  } else if (
    pendingLoadOptions &&
    (pendingLoadOptions.shouldLoadAgents !== options.shouldLoadAgents ||
      pendingLoadOptions.effectiveTrust !== options.effectiveTrust)
  ) {
    // An in-flight load was started with different options (e.g. a different
    // trust decision, or a different shouldLoadAgents override). The caller's
    // options cannot apply to it — warn instead of silently dropping them.
    logger.warn(
      { droppedOptions: options, inFlightOptions: pendingLoadOptions },
      'Deferred registry load already in flight with different options; the new options are dropped',
    )
  }
  await registriesPromise
}
