import { beforeEach, describe, expect, mock, test } from 'bun:test'

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

mock.module('../utils/local-agent-registry', () => ({
  initializeAgentRegistry: async (opts: { trustProjectAgents: boolean }) => {
    agentCalls.push(opts)
    if (agentGate.hold) {
      await new Promise<void>((resolve) => {
        agentGate.resolvers.push(resolve)
      })
    }
  },
}))
mock.module('../utils/skill-registry', () => ({
  initializeSkillRegistry: async (opts: { trustProjectSkills: boolean }) => {
    skillCalls.push(opts)
  },
}))
mock.module('../utils/logger', () => ({
  logger: {
    warn: (...args: unknown[]) => {
      warnings.push(args)
    },
    error: () => {},
  },
}))

const {
  awaitRegistriesReady,
  resetDeferredRegistryLoads,
  startDeferredRegistryLoads,
  whenRegistriesReady,
} = await import('../services/deferred-registries')

beforeEach(() => {
  resetDeferredRegistryLoads()
  agentCalls.length = 0
  skillCalls.length = 0
  warnings.length = 0
  agentGate = { hold: false, resolvers: [] }
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
