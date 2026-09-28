import { describe, expect, test } from 'bun:test'

import { runAcpServeCommand } from '../serve-command'

import type { RunAcpServeDeps, ServeCommandArgs } from '../serve-command'

/**
 * Fully hermetic: every dependency of runAcpServeCommand is injected, so no
 * real client, socket, or filesystem is touched. Each helper below builds a
 * capturing set of deps and the recorded calls for assertions.
 */
function makeHarness(overrides?: Partial<RunAcpServeDeps>) {
  const stderrLines: string[] = []
  const close = async () => {}

  const clientStub = { run: async () => ({}) }
  const sessionDataStub = { __kind: 'session-data-stub' }
  const journalDirsSeen: Array<{ journalDir: string }> = []

  const runServeCalls: Array<Record<string, unknown>> = []
  const runServeImpl = ((options: Record<string, unknown>) => {
    runServeCalls.push(options)
    return { close }
  }) as unknown as RunAcpServeDeps['runServeImpl']

  let generateTokenCalls = 0
  const generateToken = () => {
    generateTokenCalls++
    return 'gen-tok'
  }

  const deps: RunAcpServeDeps = {
    getClient: async () => clientStub as never,
    makeSessionData: (opts) => {
      journalDirsSeen.push(opts)
      return sessionDataStub as never
    },
    runServeImpl,
    generateToken,
    writeStderr: (line) => stderrLines.push(line),
    journalDir: '/injected/journal',
    ...overrides,
  }

  return {
    deps,
    stderrLines,
    close,
    clientStub,
    sessionDataStub,
    journalDirsSeen,
    runServeCalls,
    getGenerateTokenCalls: () => generateTokenCalls,
  }
}

describe('runAcpServeCommand', () => {
  test('stdio: wires client/sessionData to a stdio transport and logs to stderr', async () => {
    const h = makeHarness()
    const args: ServeCommandArgs = { transport: 'stdio' }

    const result = await runAcpServeCommand(args, h.deps)

    expect(h.runServeCalls).toHaveLength(1)
    const call = h.runServeCalls[0] as {
      client: unknown
      sessionData: unknown
      transport: { kind: string }
    }
    expect((call.transport as { kind: string }).kind).toBe('stdio')
    expect(call.client).toBe(h.clientStub)
    expect(call.sessionData).toBe(h.sessionDataStub)
    // Human output goes to stderr; nothing to stdout.
    expect(h.stderrLines.length).toBeGreaterThan(0)
    expect(h.stderrLines.some((l) => l.includes('stdio'))).toBe(true)
    // Returned close is the fake's.
    expect(result.close).toBe(h.close)
  })

  test('socket with explicit token: threads the token and does not generate one', async () => {
    const h = makeHarness()
    const args: ServeCommandArgs = {
      transport: 'socket',
      socketPath: '/tmp/x.sock',
      token: 'abc',
    }

    await runAcpServeCommand(args, h.deps)

    expect(h.runServeCalls).toHaveLength(1)
    const call = h.runServeCalls[0] as {
      transport: { kind: string; socketPath: string; token: string }
    }
    expect(call.transport).toEqual({
      kind: 'socket',
      socketPath: '/tmp/x.sock',
      token: 'abc',
    })
    expect(h.getGenerateTokenCalls()).toBe(0)
    expect(h.stderrLines.some((l) => l.includes('/tmp/x.sock'))).toBe(true)
    expect(h.stderrLines.some((l) => l.includes('abc'))).toBe(true)
  })

  test('socket without token: generates one and prints it to stderr', async () => {
    const h = makeHarness()
    const args: ServeCommandArgs = {
      transport: 'socket',
      socketPath: '/tmp/x.sock',
    }

    await runAcpServeCommand(args, h.deps)

    expect(h.getGenerateTokenCalls()).toBe(1)
    const call = h.runServeCalls[0] as {
      transport: { token: string }
    }
    expect(call.transport.token).toBe('gen-tok')
    expect(h.stderrLines.some((l) => l.includes('gen-tok'))).toBe(true)
  })

  test('threads the injected journalDir into makeSessionData', async () => {
    const h = makeHarness({ journalDir: '/custom/acp-journal' })
    const args: ServeCommandArgs = { transport: 'stdio' }

    await runAcpServeCommand(args, h.deps)

    expect(h.journalDirsSeen).toEqual([{ journalDir: '/custom/acp-journal' }])
  })

  test('threads agentId into the runServeImpl call', async () => {
    const h = makeHarness()
    const args: ServeCommandArgs = { transport: 'stdio', agentId: 'my-agent' }

    await runAcpServeCommand(args, h.deps)

    expect(h.runServeCalls).toHaveLength(1)
    expect((h.runServeCalls[0] as { agentId?: string }).agentId).toBe(
      'my-agent',
    )
  })
})
