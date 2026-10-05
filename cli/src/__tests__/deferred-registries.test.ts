import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'

/**
 * The registry initializers and the logger are mocked so the deferred
 * registry STATE MACHINE is what is under test: which initializer runs, with
 * which trust decision, and when a caller's options are dropped with a
 * warning. The mocks are registered BEFORE the dynamic import below (bun
 * mock.module applies to subsequent imports of the mocked specifiers).
 */
const agentCalls: Array<{ trustProjectAgents: boolean }> = []
const skillCalls: Array<{ trustProjectSkills: boolean }> = []
const warnings: unknown[][] = []

// Armed only while THIS suite's own tests run (the beforeEach below arms, the
// afterEach below disarms). bun's mock.module is registry-wide and persists for
// every test file sharing the worker, so the initializer overrides below must
// record ONLY while armed and otherwise delegate to the REAL initializers —
// a sibling suite (e.g. local-agents.test.ts) needs the real agent loader,
// not these call-recorders. The DEFAULT is disarmed so a sibling file is safe
// regardless of file order.
let registriesArmed = false

// Gate so a test can hold the agent load in flight across calls (a reset
// happens while the load is still running).
let agentGate: { hold: boolean; resolvers: Array<() => void> } = {
  hold: false,
  resolvers: [],
}

/** Releases every pending gate waiter and stops gating new calls, so a
 * started load can settle without the test itself deadlocking on it. */
function releaseAgentGate(): void {
  agentGate.hold = false
  for (const resolve of agentGate.resolvers) resolve()
  agentGate.resolvers = []
}

// Snapshot the real module BEFORE the mock.module registration so the real
// exports can be spread in the factory (a bare full replacement would drop
// every un-overridden export for sibling suites in the same worker).
const realLocalAgentRegistryModule = {
  ...(await import('../utils/local-agent-registry')),
}
const realSkillRegistryModule = {
  ...(await import('../utils/skill-registry')),
}
const realLoggerModule = {
  ...(await import('../utils/logger')),
}

mock.module('../utils/local-agent-registry', () => ({
  ...realLocalAgentRegistryModule,
  initializeAgentRegistry: async (opts: { trustProjectAgents: boolean }) => {
    // Disarmed (the DEFAULT): delegate to the REAL initializer frozen in the
    // pre-mock snapshot above — reading the live namespace here would recurse
    // into this mock. Sibling suites need the real agent loading to happen.
    if (!registriesArmed) {
      return realLocalAgentRegistryModule.initializeAgentRegistry(opts)
    }
    agentCalls.push(opts)
    if (agentGate.hold) {
      await new Promise<void>((resolve) => {
        agentGate.resolvers.push(resolve)
      })
    }
    // Explicit so noImplicitReturns stays satisfied alongside the disarmed
    // path's return (same pattern as the @opentui/core stub in
    // utils/__tests__/tree-sitter-client.test.ts).
    return undefined
  },
}))
mock.module('../utils/skill-registry', () => ({
  ...realSkillRegistryModule,
  initializeSkillRegistry: async (opts: { trustProjectSkills: boolean }) => {
    // Disarmed (the DEFAULT): delegate to the REAL initializer frozen in the
    // pre-mock snapshot above (never the live namespace — that would recurse
    // into this mock).
    if (!registriesArmed) {
      return realSkillRegistryModule.initializeSkillRegistry(opts)
    }
    skillCalls.push(opts)
    // Explicit so noImplicitReturns stays satisfied alongside the disarmed
    // path's return.
    return undefined
  },
}))
mock.module('../utils/logger', () => ({
  ...realLoggerModule,
  logger: {
    ...realLoggerModule.logger,
    warn: (...args: unknown[]) => {
      // Disarmed (the DEFAULT): delegate to the REAL warn frozen in the
      // pre-mock snapshot (never the live namespace — that would recurse into
      // this mock). Sibling suites need the real warn output.
      if (!registriesArmed) {
        return Reflect.apply(
          realLoggerModule.logger.warn,
          realLoggerModule.logger,
          args,
        )
      }
      warnings.push(args)
      // Explicit so noImplicitReturns stays satisfied alongside the disarmed
      // path's return.
      return undefined
    },
    error: (...args: unknown[]) => {
      // Disarmed (the DEFAULT): delegate to the REAL error frozen in the
      // pre-mock snapshot. Sibling suites need the real error output.
      if (!registriesArmed) {
        return Reflect.apply(
          realLoggerModule.logger.error,
          realLoggerModule.logger,
          args,
        )
      }
      // Armed: this suite silences errors (it only asserts on warnings).
      return undefined
    },
  },
}))

const {
  awaitRegistriesReady,
  resetDeferredRegistryLoads,
  startDeferredRegistryLoads,
  whenRegistriesReady,
} = await import('../services/deferred-registries')

beforeEach(() => {
  // Arm the recording overrides for THIS suite's tests only.
  registriesArmed = true
  resetDeferredRegistryLoads()
  agentCalls.length = 0
  skillCalls.length = 0
  warnings.length = 0
  agentGate = { hold: false, resolvers: [] }
})

afterEach(() => {
  // Disarm after every test (not afterAll): scoped to this file's own tests
  // and always runs, so the armed behavior can never outlive the suite and
  // reach a sibling file sharing the worker.
  registriesArmed = false
})

describe('deferred registries project-switch reset', () => {
  test('a reset makes the next awaitRegistriesReady re-initialize with the CURRENT trust', async () => {
    // First load binds the PREVIOUS project's trust decision.
    startDeferredRegistryLoads({ shouldLoadAgents: true, effectiveTrust: false })
    await whenRegistriesReady()
    expect(agentCalls).toEqual([{ trustProjectAgents: false }])

    // Without the reset, the in-flight/completed promise would satisfy every
    // later consumer, silently resolving the STALE trust decision. The reset
    // drops it so the next load re-initializes with the new project's trust.
    resetDeferredRegistryLoads()
    await awaitRegistriesReady({
      shouldLoadAgents: true,
      effectiveTrust: true,
    })

    expect(agentCalls).toEqual([
      { trustProjectAgents: false },
      { trustProjectAgents: true },
    ])
    expect(skillCalls[skillCalls.length - 1]).toEqual({
      trustProjectSkills: true,
    })
  })

  test('after a reset, whenRegistriesReady resolves immediately until a load (re)starts', async () => {
    startDeferredRegistryLoads({ shouldLoadAgents: true, effectiveTrust: true })
    await whenRegistriesReady()

    resetDeferredRegistryLoads()
    // No new load has been started yet, so consumers are not gated.
    await whenRegistriesReady()
    expect(agentCalls).toHaveLength(1)

    // The next explicit await (re)starts the loads with the CURRENT options.
    await awaitRegistriesReady({
      shouldLoadAgents: true,
      effectiveTrust: false,
    })
    expect(agentCalls).toEqual([
      { trustProjectAgents: true },
      { trustProjectAgents: false },
    ])
  })

  test('awaitRegistriesReady warns instead of silently dropping options on an in-flight load', async () => {
    agentGate.hold = true
    startDeferredRegistryLoads({
      shouldLoadAgents: true,
      effectiveTrust: false,
    })

    // The load is still in flight (the agent initializer is gated). Capture
    // the pending await FIRST — the dropped-options warning fires
    // synchronously at call time — then release the gate so the in-flight
    // load can settle and the await can resolve. Previously the options
    // were silently dropped with no warning at all.
    const ready = awaitRegistriesReady({
      shouldLoadAgents: true,
      effectiveTrust: true,
    })
    releaseAgentGate()
    await ready

    expect(warnings).toHaveLength(1)
    // No second load was started for the dropped options.
    expect(agentCalls).toEqual([{ trustProjectAgents: false }])
    expect(skillCalls).toEqual([{ trustProjectSkills: false }])
  })

  test('awaitRegistriesReady with matching options does not warn', async () => {
    agentGate.hold = true
    startDeferredRegistryLoads({
      shouldLoadAgents: true,
      effectiveTrust: true,
    })

    const ready = awaitRegistriesReady({
      shouldLoadAgents: true,
      effectiveTrust: true,
    })
    releaseAgentGate()
    await ready

    expect(warnings).toHaveLength(0)
    expect(agentCalls).toEqual([{ trustProjectAgents: true }])
  })

  test('a reset clears the pending options, so a later differing call does not warn', async () => {
    agentGate.hold = true
    startDeferredRegistryLoads({
      shouldLoadAgents: true,
      effectiveTrust: false,
    })

    resetDeferredRegistryLoads()
    releaseAgentGate()
    await awaitRegistriesReady({ shouldLoadAgents: true, effectiveTrust: true })

    expect(warnings).toHaveLength(0)
    // The reset started a genuinely NEW load with the new options.
    expect(agentCalls).toEqual([
      { trustProjectAgents: false },
      { trustProjectAgents: true },
    ])
  })
})
