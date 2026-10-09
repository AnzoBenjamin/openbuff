import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { describe, expect, test } from 'bun:test'

import { assertSocketPathIsNotSymlink, runAcpServeCommand } from '../serve-command'

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
    projectRoot: '/injected/project',
    // SEC: hermetic no-op so the default lstat gate never touches a real
    // filesystem in these tests; the gate itself is exercised below.
    assertSocketPathSafe: () => {},
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

  test('reports the effective project-agent trust decision on stderr', async () => {
    const trusted = makeHarness()
    await runAcpServeCommand(
      { transport: 'stdio', trustProjectAgents: true },
      trusted.deps,
    )
    expect(trusted.stderrLines).toContain(
      'openbuff serve: project agents trusted',
    )

    const hintPath = '/custom/config/trusted-roots.json'
    const untrusted = makeHarness({ trustedRootsPath: hintPath })
    await runAcpServeCommand(
      { transport: 'stdio', trustProjectAgents: false },
      untrusted.deps,
    )
    expect(untrusted.stderrLines).toContain(
      `openbuff serve: project agents untrusted (use --trust-project-agents or add the project root to ${hintPath})`,
    )
  })

  test('reports the socket transport as untrusted by default too', async () => {
    const h = makeHarness()
    await runAcpServeCommand(
      { transport: 'socket', socketPath: '/tmp/x.sock' },
      h.deps,
    )
    expect(
      h.stderrLines.some((l) =>
        l.startsWith('openbuff serve: project agents untrusted'),
      ),
    ).toBe(true)
    expect(h.stderrLines).not.toContain(
      'openbuff serve: project agents trusted',
    )
  })

  test('builds credentialEnv from the credential allowlist, not the full env (NEW-3)', async () => {
    const originalOpenAiKey = process.env.OPENAI_API_KEY
    const originalUserVar = process.env.SOME_USER_VAR
    process.env.OPENAI_API_KEY = 'openai-secret'
    process.env.SOME_USER_VAR = 'keep-me-out'
    try {
      const h = makeHarness()
      await runAcpServeCommand({ transport: 'stdio' }, h.deps)

      const call = h.runServeCalls[0] as {
        credentialEnv?: Record<string, string | undefined>
      }
      // The CLI hands runServe ONLY the credential-bearing env keys so the
      // SDK can collect the configured credential VALUES for the streaming
      // holdback; the rest of the host environment is never shared.
      expect(call.credentialEnv?.OPENAI_API_KEY).toBe('openai-secret')
      expect(call.credentialEnv?.SOME_USER_VAR).toBeUndefined()
    } finally {
      if (originalOpenAiKey === undefined) {
        delete process.env.OPENAI_API_KEY
      } else {
        process.env.OPENAI_API_KEY = originalOpenAiKey
      }
      if (originalUserVar === undefined) {
        delete process.env.SOME_USER_VAR
      } else {
        process.env.SOME_USER_VAR = originalUserVar
      }
    }
  })

  test('threads the project root into runServeImpl for both transports (SEC-7)', async () => {
    const stdio = makeHarness()
    await runAcpServeCommand({ transport: 'stdio' }, stdio.deps)
    expect(
      (stdio.runServeCalls[0] as { projectRoot?: string }).projectRoot,
    ).toBe('/injected/project')

    const socket = makeHarness()
    await runAcpServeCommand(
      { transport: 'socket', socketPath: '/tmp/x.sock' },
      socket.deps,
    )
    expect(
      (socket.runServeCalls[0] as { projectRoot?: string }).projectRoot,
    ).toBe('/injected/project')
  })

  test('socket: fails closed when the socket path is a symlink (SEC)', async () => {
    const h = makeHarness({
      assertSocketPathSafe: () => {
        throw new Error('socket path is a symlink')
      },
    })
    const args: ServeCommandArgs = {
      transport: 'socket',
      socketPath: '/tmp/evil-link.sock',
    }

    await expect(runAcpServeCommand(args, h.deps)).rejects.toThrow(/symlink/)
    // The gate runs BEFORE bind: runServe is never reached.
    expect(h.runServeCalls).toHaveLength(0)
  })

  test('the default socket-path gate rejects a symlink and passes regular/absent paths', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'serve-socket-gate-'))
    try {
      const target = path.join(dir, 'real.sock')
      writeFileSync(target, '')
      const link = path.join(dir, 'linked.sock')
      symlinkSync(target, link)

      expect(() => assertSocketPathIsNotSymlink(link)).toThrow(/symlink/)
      expect(() => assertSocketPathIsNotSymlink(target)).not.toThrow()
      // An absent path is the normal bind case (runServe creates the socket).
      expect(() =>
        assertSocketPathIsNotSymlink(path.join(dir, 'absent.sock')),
      ).not.toThrow()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
