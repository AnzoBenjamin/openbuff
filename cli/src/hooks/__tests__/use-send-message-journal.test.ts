import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  mock,
  spyOn,
} from 'bun:test'
import { tmpdir } from 'node:os'
import path from 'node:path'
import React from 'react'
import * as runJournalPathModule from '../../utils/run-journal-path'
import * as openbuffProviderModule from '../../utils/openbuff-provider'
import * as codebuffClientModule from '../../utils/codebuff-client'
import * as localAgentRegistryModule from '../../utils/local-agent-registry'
import * as deferredRegistriesModule from '../../services/deferred-registries'
import * as createRunConfigModule from '../../utils/create-run-config'

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

// Per-suite spyOn + mock.restore per the bash-command.test.ts pattern: no
// registry-wide mock.module — sibling suites keep real behavior by
// construction (CONTRIBUTING prefers spyOn over mock.module).
let readinessResult: { ok: boolean; message?: string } = {
  ok: false,
  message: 'provider not ready (test fixture)',
}

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

    spyOn(runJournalPathModule, 'openRunJournalForRun').mockImplementation(
      ((params: unknown) => {
        openRunJournalCalls.push(params)
        return {
          append: () => {},
          events: () => [],
          lastEvent: () => undefined,
          toolResultFor: () => undefined,
          toolResultForInput: () => undefined,
          runIds: () => [],
          runSummaries: () => [],
          flush: () => Promise.resolve(),
          pruneRuns: () => {},
          close: () => Promise.resolve(),
          // CreatedRunJournal hardening members (slice 4): no-op stubs so the
          // fake satisfies the full structural shape the opener returns.
          forceFlush: () => Promise.resolve(),
          recentEvents: () => [],
          eventsOfType: () => [],
        }
      }) as typeof runJournalPathModule.openRunJournalForRun,
    )
    spyOn(runJournalPathModule, 'resolveRunJournalPath').mockImplementation(
      (() =>
        path.join(
          tmpdir(),
          'use-send-message-journal-test.db',
        )) as typeof runJournalPathModule.resolveRunJournalPath,
    )
    spyOn(
      openbuffProviderModule,
      'getOpenbuffProviderReadiness',
    ).mockImplementation(
      (() =>
        readinessResult) as typeof openbuffProviderModule.getOpenbuffProviderReadiness,
    )
    // The run-throwing stub intentionally does not implement the full
    // OpenbuffClient shape (the test must never reach client.run), so the
    // minimal stub is cast through unknown.
    spyOn(codebuffClientModule, 'getCodebuffClient').mockImplementation(
      (async () => ({
        run: () => {
          throw new Error('client.run must not be reached in this test')
        },
      })) as unknown as typeof codebuffClientModule.getCodebuffClient,
    )
    spyOn(localAgentRegistryModule, 'loadAgentDefinitions').mockImplementation(
      (() => []) as typeof localAgentRegistryModule.loadAgentDefinitions,
    )
    spyOn(deferredRegistriesModule, 'whenRegistriesReady').mockImplementation(
      (() =>
        Promise.resolve()) as typeof deferredRegistriesModule.whenRegistriesReady,
    )
    spyOn(createRunConfigModule, 'createRunConfig').mockImplementation(
      (() => {
        throw new Error('createRunConfig must not be reached in this test')
      }) as typeof createRunConfigModule.createRunConfig,
    )

    openRunJournalCalls.length = 0
    setProjectRoot(tmpdir())
  })

  afterEach(() => {
    reactInternals.H = originalDispatcher!
    // Restores every bun:test spy (the six above) — must run last.
    mock.restore()
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
