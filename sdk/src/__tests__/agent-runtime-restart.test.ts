/**
 * P2-T8c: SDK restart-wiring seam test. Proves the SDK flag-on
 * supervised-spawn seam (getAgentRuntimeImpl) passes a BOUNDED restart
 * policy through to buildDefaultSpawnSupervised when process supervision is
 * on — WITHOUT spawning a real child (the real restart loop is covered by
 * packages/agent-runtime .../supervised-restart.test.ts). The default seam
 * module is mocked so the test only asserts the option the SDK rides into
 * the flag-on branch.
 */
import { describe, expect, it, mock } from 'bun:test'

describe('getAgentRuntimeImpl supervised-spawn restart wiring', () => {
  it('passes a bounded restart policy to buildDefaultSpawnSupervised when process supervision is on', async () => {
    const calls: unknown[][] = []
    mock.module(
      '@codebuff/agent-runtime/supervision/supervised-spawn',
      () => ({
        buildDefaultSpawnSupervised: (...args: unknown[]) => {
          calls.push(args)
          return async () => ({ outcome: 'ok' })
        },
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
    expect(maxAttempts as number).toBeGreaterThanOrEqual(2)
  })
})
