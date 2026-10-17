/**
 * P2-T8c: SDK restart-wiring seam test. Proves the SDK flag-on
 * supervised-spawn seam (getAgentRuntimeImpl) passes a BOUNDED restart
 * policy through to buildDefaultSpawnSupervised when process supervision is
 * on — WITHOUT spawning a real child (the real restart loop is covered by
 * packages/agent-runtime .../supervised-restart.test.ts). The default seam
 * module is mocked so the test only asserts the option the SDK rides into
 * the flag-on branch.
 */
import { afterAll, describe, expect, it, mock } from 'bun:test'

// The REAL module is loaded (and its exports copied to a plain const) BEFORE
// mock.module registers: after registration bun resolves reads on the
// imported namespace through the mock registry, so referencing the namespace
// inside the factory would re-enter the mock (self-recursion). The
// registry-wide mock (mock.restore() does NOT undo it) must keep the other
// real exports working for sibling test files co-scheduled in this worker —
// the same leak class documented in
// packages/agent-runtime/src/util/__tests__/context-consolidation.test.ts.
import * as supervisedSpawnReal from '@codebuff/agent-runtime/supervision/supervised-spawn'

const realSupervisedSpawn = { ...supervisedSpawnReal }

describe('getAgentRuntimeImpl supervised-spawn restart wiring', () => {
  afterAll(() => {
    mock.restore()
    // Re-register the untouched real module: mock.module registrations are
    // process-wide and survive mock.restore(), so sibling suites co-scheduled
    // in this worker keep resolving the real supervised-spawn module instead
    // of this test's stub (which overrides only the seam builder and the
    // launchability predicate).
    mock.module(
      '@codebuff/agent-runtime/supervision/supervised-spawn',
      () => ({ ...realSupervisedSpawn }),
    )
  })

  it('passes a bounded restart policy to buildDefaultSpawnSupervised when process supervision is on', async () => {
    const calls: unknown[][] = []
    mock.module(
      '@codebuff/agent-runtime/supervision/supervised-spawn',
      () => ({
        ...realSupervisedSpawn,
        buildDefaultSpawnSupervised: (...args: unknown[]) => {
          calls.push(args)
          return async () => ({
            outcome: 'ok' as const,
          })
        },
        // The impl statically imports this predicate too; the flag-on branch
        // under test passes processSupervision explicitly so it is never
        // called, but the import must still resolve.
        isSupervisedSpawnSupported: () => true,
      }),
    )

    const { getAgentRuntimeImpl } = await import('../impl/agent-runtime')

    const noop = () => {}
    const deps = getAgentRuntimeImpl({
      apiKey: 'test-key',
      processSupervision: true,
      handleStepsLogChunk: noop,
      requestToolCall: noop,
      requestMcpToolData: noop,
      requestFiles: noop,
      requestOptionalFile: noop,
      fileSystem: {},
      fileFilter: {},
      sendAction: noop,
      sendSubagentChunk: noop,
    } as unknown as Parameters<typeof getAgentRuntimeImpl>[0])

    // Flag-on branch was taken and the default seam was built exactly once.
    expect(deps.processSupervision).toBe(true)
    expect(calls).toHaveLength(1)

    // The restart option rides in the THIRD arg (SupervisedSpawnOptions) and
    // must be BOUNDED: an explicit, finite maxAttempts (never unbounded).
    const options = calls[0][2] as
      | { restart?: { maxAttempts?: number } }
      | undefined
    const maxAttempts = options?.restart?.maxAttempts
    expect(typeof maxAttempts).toBe('number')
    expect(Number.isFinite(maxAttempts)).toBe(true)
    // Exact pin (not just >= 2): the impl passes `restart: { maxAttempts: 3 }`
    // explicitly (sdk/src/impl/agent-runtime.ts, flag-on branch), so the
    // production default is tracked 1:1 instead of only being bounded from
    // below. If the impl's bounded budget changes, this pin fails with the
    // diff naming the change; if the budget ever became unbounded, the
    // typeof/finite assertions above fail first.
    expect(maxAttempts).toBe(3)
  })
})
