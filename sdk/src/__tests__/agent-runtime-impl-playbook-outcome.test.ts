/**
 * Memory-overhaul P4 build-order item 2: SDK wiring-seam tests for the
 * playbook-gate outcome producer (design record
 * .agents/sessions/memory-overhaul-2026-10/design-phase2-4-rederived.md
 * §P4 build order).
 *
 * Two seams are pinned:
 *
 * 1. getAgentRuntimeImpl (sdk/src/impl/agent-runtime.ts) threads the
 *    additive-optional `onPlaybookGateOutcome` dep following the file's
 *    conditional-spread key convention: present — with the SAME function
 *    identity — exactly when the caller wires one, and entirely ABSENT (the
 *    key is not present, not merely undefined) otherwise, so an unwired
 *    run's deps object stays byte-identical.
 *
 * 2. buildPlaybookGateOutcomeReporter (sdk/src/run.ts) gates on this run's
 *    Memory V2 repository and its optional `recordPlaybookGateOutcome`
 *    member, forwards the STORE signature `(playbookId, outcome)` — never
 *    the whole event — and satisfies the AgentRuntimeDeps contract: it
 *    never throws and never rejects. A synchronous store throw is caught
 *    and a rejected store promise gets a `.catch()`, both surfacing as one
 *    debug log; a store throw like 'The playbook was not found.'
 *    (mid-session retirement) no-ops.
 */
import { describe, expect, it, mock } from 'bun:test'

import type { PlaybookGateOutcomeEvent } from '@codebuff/common/types/memory-playbook'
import type { Logger } from '@codebuff/common/types/contracts/logger'

import { getAgentRuntimeImpl } from '../impl/agent-runtime'
import { buildPlaybookGateOutcomeReporter } from '../run'
import type { MemoryV2ClientConfig } from '../services/memory-v2/types'

type Repository = NonNullable<MemoryV2ClientConfig['repository']>
type RecordPlaybookGateOutcomeFn = NonNullable<
  Repository['recordPlaybookGateOutcome']
>

/** The canonical gate-outcome event every forwarding assertion uses. */
const event: PlaybookGateOutcomeEvent = {
  playbookId: 'pb-1',
  triggerSignature: 'sig',
  outcome: 'warned',
}

// Minimal getAgentRuntimeImpl invocation, modeled on the established shape
// in agent-runtime-restart.test.ts (noop scoped deps; the cast carries the
// stub function shapes). processSupervision is pinned to false so the
// default supervised-spawn resolution (env + launchability) is never
// consulted and the returned deps object is deterministic — this suite
// asserts only the onPlaybookGateOutcome key.
const noop = () => {}
const baseImplParams = {
  apiKey: 'test-key',
  processSupervision: false,
  handleStepsLogChunk: noop,
  requestToolCall: noop,
  requestMcpToolData: noop,
  requestFiles: noop,
  requestOptionalFile: noop,
  sendAction: noop,
  sendSubagentChunk: noop,
} as unknown as Parameters<typeof getAgentRuntimeImpl>[0]

describe('getAgentRuntimeImpl onPlaybookGateOutcome wiring', () => {
  it('includes the wired producer under the same function identity', () => {
    const onPlaybookGateOutcome = () => {}
    const deps = getAgentRuntimeImpl({
      ...baseImplParams,
      onPlaybookGateOutcome,
    })
    expect('onPlaybookGateOutcome' in deps).toBe(true)
    expect(deps.onPlaybookGateOutcome).toBe(onPlaybookGateOutcome)
  })

  it('omits the key entirely when no producer is wired', () => {
    const deps = getAgentRuntimeImpl({ ...baseImplParams })
    // The key must be ABSENT, not present-with-undefined: the conditional
    // spread is what keeps an unwired run's deps byte-identical.
    expect('onPlaybookGateOutcome' in deps).toBe(false)
    expect(deps.onPlaybookGateOutcome).toBeUndefined()
  })
})

// A repository fixture whose required store surface is never touched by this
// seam: every stub throws, so a test fails loudly if the reporter ever calls
// one. Only the optional playbook member matters to the wiring decision.
const unusedStoreMember = async (): Promise<never> => {
  throw new Error('unexpected call: this seam only probes the playbook surface')
}

const repositoryWithoutPlaybookSurface: Repository = {
  append: unusedStoreMember,
  query: unusedStoreMember,
  verify: unusedStoreMember,
  rebuild: unusedStoreMember,
  health: unusedStoreMember,
  export: unusedStoreMember,
}

const repositoryWithOutcomeMember = (
  recordPlaybookGateOutcome: RecordPlaybookGateOutcomeFn,
): Repository => ({
  ...repositoryWithoutPlaybookSurface,
  recordPlaybookGateOutcome,
})

/** Logger that records only debug calls, so tests can pin the debug sink. */
const makeDebugLogger = () => {
  const debugEntries: Array<{ data: unknown; message?: string }> = []
  const logger: Logger = {
    debug: (data, message) => {
      debugEntries.push({ data, message })
    },
    info: () => {},
    warn: () => {},
    error: () => {},
  }
  return { logger, debugEntries }
}

/**
 * Narrows the helper result to the closure the wiring site passes on; throws
 * (failing the test) when the helper returned undefined.
 */
const requireReporter = (
  repository: Repository | undefined,
  logger?: Logger,
) => {
  const reporter = buildPlaybookGateOutcomeReporter(repository, logger)
  if (typeof reporter !== 'function') {
    throw new Error('buildPlaybookGateOutcomeReporter returned no closure')
  }
  return reporter
}

describe('buildPlaybookGateOutcomeReporter', () => {
  it('returns undefined without a repository', () => {
    expect(buildPlaybookGateOutcomeReporter(undefined)).toBeUndefined()
  })

  it('returns undefined when the repository lacks the optional member', () => {
    expect(
      buildPlaybookGateOutcomeReporter(repositoryWithoutPlaybookSurface),
    ).toBeUndefined()
  })

  it('returns a closure when the repository carries the optional member', () => {
    const repository = repositoryWithOutcomeMember(async () => {})
    const reporter = buildPlaybookGateOutcomeReporter(repository)
    expect(typeof reporter).toBe('function')
  })

  it('forwards the store signature, not the whole event', () => {
    const recordPlaybookGateOutcome = mock(async () => {})
    const repository = repositoryWithOutcomeMember(recordPlaybookGateOutcome)
    const reporter = requireReporter(repository)
    reporter(event)
    expect(recordPlaybookGateOutcome).toHaveBeenCalledTimes(1)
    expect(recordPlaybookGateOutcome).toHaveBeenCalledWith('pb-1', 'warned')
    // Exact-arity pin: the store signature is (playbookId, outcome), so the
    // event (and its triggerSignature) is never forwarded as an argument —
    // the call carries exactly the store's two parameters (the values are
    // already pinned by toHaveBeenCalledWith above).
    expect(recordPlaybookGateOutcome.mock.calls[0]).toHaveLength(2)
  })

  it('does not throw when the store call throws synchronously', () => {
    const { logger, debugEntries } = makeDebugLogger()
    // Mid-session retirement: the store can throw 'The playbook was not
    // found.' — the reporter must no-op, never propagate.
    const boom = new Error('The playbook was not found.')
    const repository = repositoryWithOutcomeMember(() => {
      throw boom
    })
    const reporter = requireReporter(repository, logger)
    expect(() => reporter(event)).not.toThrow()
    expect(debugEntries).toHaveLength(1)
    expect(debugEntries[0]?.data).toEqual({ error: boom })
  })

  it('attaches .catch to a rejected store promise', async () => {
    const { logger, debugEntries } = makeDebugLogger()
    const boom = new Error('store write failed')
    const repository = repositoryWithOutcomeMember(() => Promise.reject(boom))
    const reporter = requireReporter(repository, logger)
    expect(() => reporter(event)).not.toThrow()
    // Microtask tick so the rejected promise reaches the attached .catch:
    // a missing .catch would surface as an unhandled rejection AND leave
    // no debug entry here.
    await Promise.resolve()
    expect(debugEntries).toHaveLength(1)
    expect(debugEntries[0]?.data).toEqual({ error: boom })
  })
})
