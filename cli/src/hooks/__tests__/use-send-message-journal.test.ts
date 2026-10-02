import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { tmpdir } from 'node:os'
import path from 'node:path'
import React from 'react'

// Ensure required env vars exist so logger/env parsing succeeds in tests
// (same preamble as send-message.test.ts).
process.env.NEXT_PUBLIC_CB_ENVIRONMENT =
  process.env.NEXT_PUBLIC_CB_ENVIRONMENT || 'test'
process.env.NEXT_PUBLIC_CODEBUFF_APP_URL =
  process.env.NEXT_PUBLIC_CODEBUFF_APP_URL || 'https://app.codebuff.test'
process.env.NEXT_PUBLIC_SUPPORT_EMAIL =
  process.env.NEXT_PUBLIC_SUPPORT_EMAIL || 'support@codebuff.test'
process.env.NEXT_PUBLIC_POSTHOG_API_KEY =
  process.env.NEXT_PUBLIC_POSTHOG_API_KEY || 'phc_test_key'
process.env.NEXT_PUBLIC_POSTHOG_HOST_URL =
  process.env.NEXT_PUBLIC_POSTHOG_HOST_URL || 'https://posthog.codebuff.test'

// Finding compatibility-reviewer:cli_config_and_environment_contracts:journal-created-on-non-run-send:
// the run journal must open ONLY after the provider-readiness gate inside
// the run try-block — a send that never starts a run (a providerReadiness
// failure early-return) must not create the journal db. The journal opener
// is the only thing that creates that db file, so spying on it asserts the
// lazy-open contract directly.

const openRunJournalCalls: unknown[] = []

// bun's mock.module is registry-wide for the whole test process and cannot be
// unregistered, so every override below is an ARMED/DELEGATING stub: when
// `journalHooksArmed` is false — i.e. for every sibling suite sharing this
// process — the override delegates verbatim to the real captured module
// function (all args in, real result out, promises included), and only the
// journal suite's beforeEach/afterEach arms/disarms the flag to install the
// test-controlled behavior. Recording into openRunJournalCalls happens only
// while armed, so sibling suites always observe real behavior.
let journalHooksArmed = false

// Capture the REAL modules through the ESM registry (top-level await import),
// NOT createRequire — a createRequire capture loads a second, distinct CJS
// module instance, and a delegating override that closes over that copy
// bridges the mock registry to the CJS instance and busy-spins a sibling
// suite's real call at ~98% CPU (the test-cli hang). Top-level await import
// resolves the SAME ESM instance the SUT and sibling suites use.
// SNAPSHOT the real exports into a plain object BEFORE mock.module: an ESM
// namespace is a live binding that bun's mock.module patches in place, so a
// delegating stub reading `ns.fn` after registration would call ITSELF
// (the sibling-suite spin). `{ ...ns }` freezes the original references.
const realRunJournalPath = { ...(await import('../../utils/run-journal-path')) }
mock.module('../../utils/run-journal-path', () => ({
  ...realRunJournalPath,
  openRunJournalForRun: (
    ...args: Parameters<typeof realRunJournalPath.openRunJournalForRun>
  ) => {
    if (!journalHooksArmed) {
      return realRunJournalPath.openRunJournalForRun(...args)
    }
    openRunJournalCalls.push(args[0])
    return {
      append: () => {},
      events: () => [],
      lastEvent: () => undefined,
      toolResultFor: () => undefined,
      toolResultForInput: () => undefined,
      runIds: () => [],
      close: () => Promise.resolve(),
    }
  },
  resolveRunJournalPath: (
    ...args: Parameters<typeof realRunJournalPath.resolveRunJournalPath>
  ) =>
    journalHooksArmed
      ? path.join(tmpdir(), 'use-send-message-journal-test.db')
      : realRunJournalPath.resolveRunJournalPath(...args),
}))

let readinessResult: { ok: boolean; message?: string } = {
  ok: false,
  message: 'provider not ready (test fixture)',
}
// bun's mock.module is registry-wide for the whole test process and cannot
// be unregistered, so capture the REAL module before registering and spread
// its exports (real keys first, the readiness override wins) — a stub with
// only one export would otherwise drop every other export of the module
// (e.g. setupOpenbuffProviderFromArgs) for sibling suites running in the
// same batched process. The override itself is armed/delegating (see the
// run-journal-path block above): unless the journal suite armed the flag, it
// delegates to the real getOpenbuffProviderReadiness so sibling suites never
// see the fixture.
const realOpenbuffProvider = {
  ...(await import('../../utils/openbuff-provider')),
}
mock.module('../../utils/openbuff-provider', () => ({
  ...realOpenbuffProvider,
  getOpenbuffProviderReadiness: (
    ...args: Parameters<typeof realOpenbuffProvider.getOpenbuffProviderReadiness>
  ) =>
    journalHooksArmed
      ? readinessResult
      : realOpenbuffProvider.getOpenbuffProviderReadiness(...args),
}))

// Every mock.module here spreads the REAL module's exports first (captured
// before registration) — bun's mock.module is registry-wide for the whole
// test process and cannot be unregistered, so a stub with only one export
// drops every other export of that module for sibling suites running in the
// same batched process (the setupOpenbuffProviderFromArgs/getLoadedMCPServers
// leak class). Every overriding export is also armed/delegating (see the
// run-journal-path block above): the registry-wide override is replaced by
// delegate-unless-armed, so sibling suites always see real behavior.
const realCodebuffClient = {
  ...(await import('../../utils/codebuff-client')),
}
mock.module('../../utils/codebuff-client', () => ({
  ...realCodebuffClient,
  getCodebuffClient: async (
    ...args: Parameters<typeof realCodebuffClient.getCodebuffClient>
  ) => {
    if (journalHooksArmed) {
      return {
        run: () => {
          throw new Error('client.run must not be reached in this test')
        },
      }
    }
    return realCodebuffClient.getCodebuffClient(...args)
  },
}))

const realLocalAgentRegistry = {
  ...(await import('../../utils/local-agent-registry')),
}
mock.module('../../utils/local-agent-registry', () => ({
  ...realLocalAgentRegistry,
  loadAgentDefinitions: (
    ...args: Parameters<typeof realLocalAgentRegistry.loadAgentDefinitions>
  ) =>
    journalHooksArmed
      ? []
      : realLocalAgentRegistry.loadAgentDefinitions(...args),
}))

const realDeferredRegistries = {
  ...(await import('../../services/deferred-registries')),
}
mock.module('../../services/deferred-registries', () => ({
  ...realDeferredRegistries,
  whenRegistriesReady: (
    ...args: Parameters<typeof realDeferredRegistries.whenRegistriesReady>
  ) =>
    journalHooksArmed
      ? Promise.resolve()
      : realDeferredRegistries.whenRegistriesReady(...args),
}))

const realCreateRunConfig = {
  ...(await import('../../utils/create-run-config')),
}
mock.module('../../utils/create-run-config', () => ({
  ...realCreateRunConfig,
  createRunConfig: (
    ...args: Parameters<typeof realCreateRunConfig.createRunConfig>
  ) => {
    if (journalHooksArmed) {
      throw new Error('createRunConfig must not be reached in this test')
    }
    return realCreateRunConfig.createRunConfig(...args)
  },
}))

const { setProjectRoot } = await import('../../project-files')
const { useSendMessage } = await import('../use-send-message')

// Minimal React dispatcher so the hook runs without a renderer (same pattern
// as use-timeout.test.ts). The restore-path effect early-returns because
// continueChat is false, so a no-op useEffect is sufficient.
type ReactInternals = {
  H: {
    useRef: <T>(value: T) => { current: T }
    useCallback: <T>(callback: T) => T
    useEffect: (effect: () => void) => void
  }
}
const reactInternals = (
  React as unknown as {
    __CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE: ReactInternals
  }
).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE
let originalDispatcher: ReactInternals['H'] | undefined

const noop = () => {}

const buildHookOptions = () => ({
  inputRef: { current: null },
  activeSubagentsRef: { current: new Set<string>() },
  isChainInProgressRef: { current: false },
  setStreamStatus: noop,
  setContextWindowUsage: noop,
  setCompactionNotice: noop,
  setCanProcessQueue: noop,
  abortControllerRef: { current: null as AbortController | null },
  onBeforeMessageSend: async () => ({ success: true, errors: [] }),
  // Full ElapsedTimeTracker shape (elapsedSeconds/startTime/isPaused are
  // required members of the interface the hook consumes).
  mainAgentTimer: {
    start: noop,
    stop: noop,
    pause: noop,
    resume: noop,
    elapsedSeconds: 0,
    startTime: null,
    isPaused: false,
  },
  scrollToLatest: noop,
  continueChat: false as const,
})

describe('useSendMessage journal lazy-open ordering', () => {
  beforeEach(() => {
    originalDispatcher = reactInternals.H
    reactInternals.H = {
      useRef: <T,>(value: T) => ({ current: value }),
      useCallback: <T,>(callback: T) => callback,
      useEffect: () => {},
    }
    openRunJournalCalls.length = 0
    setProjectRoot(tmpdir())
    journalHooksArmed = true
  })

  afterEach(() => {
    reactInternals.H = originalDispatcher!
    journalHooksArmed = false
  })

  it('a providerReadiness failure early-return never opens the run journal', async () => {
    readinessResult = {
      ok: false,
      message: 'provider not ready (test fixture)',
    }

    const { sendMessage } = useSendMessage(buildHookOptions())
    await sendMessage({ content: 'hello', agentMode: 'DEFAULT' as never })

    // The journal opener is the only thing that creates the journal db file:
    // it must not have run for a send that never started a run.
    expect(openRunJournalCalls).toHaveLength(0)
  })

  it('opens the run journal only after the readiness gate passes (control)', async () => {
    readinessResult = { ok: true }

    const { sendMessage } = useSendMessage(buildHookOptions())
    await sendMessage({ content: 'hello', agentMode: 'DEFAULT' as never })

    // Control: the opener IS reachable — it ran exactly once, after the gate
    // passed and before the (throwing) run-config build. Without this the
    // first test could pass vacuously via an unwired spy.
    expect(openRunJournalCalls).toHaveLength(1)
  })
})
