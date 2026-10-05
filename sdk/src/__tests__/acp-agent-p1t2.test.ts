import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import {
  AgentSideConnection,
  ClientSideConnection,
  PROTOCOL_VERSION,
  RequestError,
} from '@agentclientprotocol/sdk'
import type {
  AnyMessage,
  Client,
  SessionNotification,
  Stream,
} from '@agentclientprotocol/sdk'

import {
  createAcpAgent,
  limitNdJsonLineBytes,
  resolveAcpServeOptions,
} from '../services/acp/acp-agent'
import type {
  AcpAgentOptions,
  AcpPromptHandler,
  AcpReplayMessage,
  AcpSessionUpdateSink,
} from '../services/acp/acp-agent'
import { AcpSessionData } from '../services/acp/session-data'

function makeRecordingConnection(): {
  connection: AcpSessionUpdateSink
  updates: SessionNotification[]
} {
  const updates: SessionNotification[] = []
  const connection: AcpSessionUpdateSink = {
    sessionUpdate: async (params) => {
      updates.push(params)
    },
  }
  return { connection, updates }
}

/** The GV-01 client ext negotiation payload (§3.2). */
const GV01_OPENBUFF_META = {
  extVersion: 1,
  extensions: ['capabilities', 'receipts', 'lanes', 'gate', 'events'],
  events: 'acp',
} as const

describe('P1-T2 extVersion negotiation (§3.2/§3.3, GV-01/02/03)', () => {
  test('GV-02: an Openbuff-aware client gets the ext _meta intersection and §3.3 capabilities', async () => {
    const { connection } = makeRecordingConnection()
    const agent = createAcpAgent({
      promptHandler: async () => ({ stopReason: 'end_turn' }),
      connection,
    })

    const response = await agent.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: true },
        terminal: true,
        _meta: { 'openbuff.dev': GV01_OPENBUFF_META },
      },
      clientInfo: { name: 'openbuff-vscode', version: '0.1.0' },
    })

    expect(response.protocolVersion).toBe(PROTOCOL_VERSION)
    // §3.3 capability advertisement.
    expect(response.agentCapabilities?.loadSession).toBe(true)
    expect(response.agentCapabilities?.promptCapabilities).toEqual({
      image: false,
      audio: false,
      embeddedContext: false,
    })
    expect(response.agentCapabilities?.mcpCapabilities).toEqual({
      http: true,
      sse: true,
    })
    // Nothing is advertised that the agent does not implement: session/list
    // and session/close are not implemented, so sessionCapabilities is absent.
    expect(response.agentCapabilities?.sessionCapabilities).toBeUndefined()
    // §3.2: extVersion is echoed, the extension set is the full intersection,
    // and a CapabilityMapV1 rides under the openbuff.dev _meta key.
    const openbuff = response.agentCapabilities?._meta?.['openbuff.dev'] as {
      extVersion: number
      extensions: string[]
      capabilities: { kind: string; gate: { enabled: boolean } }
    }
    expect(openbuff.extVersion).toBe(1)
    expect(openbuff.extensions).toEqual([
      'capabilities',
      'receipts',
      'lanes',
      'gate',
      'events',
    ])
    expect(openbuff.capabilities.kind).toBe('openbuff.capabilities')
    expect(openbuff.capabilities.gate.enabled).toBe(true)
  })

  test('the intersection drops extensions the client did not request and extVersion is min(client, agent)', async () => {
    const { connection } = makeRecordingConnection()
    const agent = createAcpAgent({
      promptHandler: async () => ({ stopReason: 'end_turn' }),
      connection,
    })

    const response = await agent.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {
        _meta: {
          'openbuff.dev': {
            extVersion: 5,
            extensions: ['capabilities', 'gate', 'not-a-real-extension'],
          },
        },
      },
    })

    const openbuff = response.agentCapabilities?._meta?.['openbuff.dev'] as {
      extVersion: number
      extensions: string[]
    }
    // Unknown extension dropped (intersection); extVersion clamped to the
    // agent maximum of 1.
    expect(openbuff.extensions).toEqual(['capabilities', 'gate'])
    expect(openbuff.extVersion).toBe(1)
  })

  test('GV-03: a plain ACP client (no _meta) gets pure ACP with NO ext echo', async () => {
    const { connection } = makeRecordingConnection()
    const agent = createAcpAgent({
      promptHandler: async () => ({ stopReason: 'end_turn' }),
      connection,
    })

    const response = await agent.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: true },
        terminal: true,
      },
    })

    expect(response.agentCapabilities?._meta).toBeUndefined()
    expect(response.authMethods).toEqual([])
  })

  test('the chatgpt-oauth auth method is advertised ONLY when clientCapabilities.auth.terminal is true', async () => {
    const { connection } = makeRecordingConnection()
    const withTerminal = createAcpAgent({
      promptHandler: async () => ({ stopReason: 'end_turn' }),
      connection,
    })
    const advertised = await withTerminal.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: { auth: { terminal: true } },
    })
    expect(advertised.authMethods).toEqual([
      {
        id: 'chatgpt-oauth',
        name: 'Sign in with ChatGPT',
        type: 'terminal',
        args: ['login', 'chatgpt'],
      },
    ])

    const withoutTerminal = createAcpAgent({
      promptHandler: async () => ({ stopReason: 'end_turn' }),
      connection,
    })
    const notAdvertised = await withoutTerminal.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: { auth: { terminal: false } },
    })
    expect(notAdvertised.authMethods).toEqual([])
  })

  test('an unknown _openbuff.dev/* extension method is ignored as method-not-found', async () => {
    const { connection } = makeRecordingConnection()
    const agent = createAcpAgent({
      promptHandler: async () => ({ stopReason: 'end_turn' }),
      connection,
    })
    let failure: unknown
    try {
      await agent.extMethod('_openbuff.dev/unknown_thing', {})
    } catch (error) {
      failure = error
    }
    expect(failure).toBeInstanceOf(RequestError)
    expect((failure as RequestError).code).toBe(-32601)
  })
})

describe('P1-T2 SEC-7 path containment (§12.5)', () => {
  const tempDirs: string[] = []

  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop()
      if (dir) rmSync(dir, { recursive: true, force: true })
    }
  })

  /** A real on-disk project root so realpath-based containment runs. */
  function makeProjectRoot(): string {
    const dir = mkdtempSync(join(tmpdir(), 'acp-contain-'))
    tempDirs.push(dir)
    return dir
  }

  function makeContainedAgent(
    projectRoot: string,
    extra?: Partial<AcpAgentOptions>,
  ) {
    const { connection, updates } = makeRecordingConnection()
    const agent = createAcpAgent({
      promptHandler: async () => ({ stopReason: 'end_turn' }),
      connection,
      projectRoot,
      ...extra,
    })
    return { agent, updates }
  }

  async function expectInvalidParams(promise: unknown): Promise<void> {
    let failure: unknown
    try {
      await promise
    } catch (error) {
      failure = error
    }
    expect(failure).toBeInstanceOf(RequestError)
    expect((failure as RequestError).code).toBe(-32602)
  }

  test('accepts a cwd equal to or strictly inside the project root', async () => {
    const projectRoot = makeProjectRoot()
    mkdirSync(join(projectRoot, 'sub'))
    const { agent } = makeContainedAgent(projectRoot)

    const atRoot = await agent.newSession({ cwd: projectRoot, mcpServers: [] })
    expect(typeof atRoot.sessionId).toBe('string')
    const inside = await agent.newSession({
      cwd: join(projectRoot, 'sub'),
      mcpServers: [],
    })
    expect(typeof inside.sessionId).toBe('string')
  })

  test('rejects a cwd that escapes the root and a sibling-prefix cwd', async () => {
    const projectRoot = makeProjectRoot()
    const { agent } = makeContainedAgent(projectRoot)

    await expectInvalidParams(
      agent.newSession({ cwd: resolve(projectRoot, '..'), mcpServers: [] }),
    )
    await expectInvalidParams(
      agent.newSession({ cwd: `${projectRoot}-evil`, mcpServers: [] }),
    )
    // A relative cwd is rejected, never silently normalized against the root.
    await expectInvalidParams(
      agent.newSession({ cwd: 'relative/path', mcpServers: [] }),
    )
  })

  test('rejects a symlink cwd that escapes the root (symlink escape)', async () => {
    const projectRoot = makeProjectRoot()
    const escapeTarget = makeProjectRoot() // a second, unrelated directory
    const linkPath = join(projectRoot, 'escape-link')
    symlinkSync(escapeTarget, linkPath)
    const { agent } = makeContainedAgent(projectRoot)

    // Lexically inside the root, but realpath escapes it → reject.
    await expectInvalidParams(
      agent.newSession({ cwd: linkPath, mcpServers: [] }),
    )
  })

  test('rejects a percent-encoded traversal cwd', async () => {
    const projectRoot = makeProjectRoot()
    const { agent } = makeContainedAgent(projectRoot)

    // `%2e%2e/` decodes to `../`, which then escapes the root.
    await expectInvalidParams(
      agent.newSession({
        cwd: `${projectRoot}/%2e%2e/%2e%2e`,
        mcpServers: [],
      }),
    )
    // Residual encoded separator after one decode (double-encoding) → reject.
    await expectInvalidParams(
      agent.newSession({
        cwd: `${projectRoot}/%252e%252e`,
        mcpServers: [],
      }),
    )
  })

  test('rejects a file:// URI whose authority is not empty or localhost', async () => {
    const projectRoot = makeProjectRoot()
    const { agent } = makeContainedAgent(projectRoot)

    await expectInvalidParams(
      agent.newSession({ cwd: 'file://host/share', mcpServers: [] }),
    )
    // `file://localhost/...` and `file:///...` unwrap to the path; one inside
    // the root is accepted, one outside is not.
    const ok = await agent.newSession({
      cwd: `file://localhost${projectRoot}`,
      mcpServers: [],
    })
    expect(typeof ok.sessionId).toBe('string')
    await expectInvalidParams(
      agent.newSession({ cwd: 'file:///etc', mcpServers: [] }),
    )
  })

  test('rejects additionalDirectories not in the allowed list (additionalDirectories:[/])', async () => {
    const projectRoot = makeProjectRoot()
    const { agent } = makeContainedAgent(projectRoot, {
      allowedAdditionalDirectories: [],
    })

    await expectInvalidParams(
      agent.newSession({
        cwd: projectRoot,
        mcpServers: [],
        additionalDirectories: ['/'],
      }),
    )
  })

  test('accepts an additionalDirectory that appears in the allowed list', async () => {
    const projectRoot = makeProjectRoot()
    const extra = makeProjectRoot()
    const { agent } = makeContainedAgent(projectRoot, {
      allowedAdditionalDirectories: [extra],
    })

    const session = await agent.newSession({
      cwd: projectRoot,
      mcpServers: [],
      additionalDirectories: [extra],
    })
    expect(typeof session.sessionId).toBe('string')
  })

  test('session/load rejects a cwd that differs from the recorded project root', async () => {
    const projectRoot = makeProjectRoot()
    const other = makeProjectRoot()
    const { agent } = makeContainedAgent(projectRoot, {
      loadHandler: async () => {},
    })
    const { sessionId } = await agent.newSession({
      cwd: projectRoot,
      mcpServers: [],
    })

    await expectInvalidParams(
      agent.loadSession({
        cwd: other,
        mcpServers: [],
        sessionId,
      }),
    )
    // Matching cwd loads cleanly.
    await agent.loadSession({ cwd: projectRoot, mcpServers: [], sessionId })
  })
})

describe('P1-T2 limits (§12.6)', () => {
  test('the 17th live session is rejected with limit_exceeded', async () => {
    const { connection } = makeRecordingConnection()
    // Every turn stays in flight until aborted (safety timeout guards hangs),
    // so all 16 sessions are ACTIVE and §12.6 LRU eviction has no idle victim.
    const promptHandler: AcpPromptHandler = (input) =>
      new Promise((resolve) => {
        input.signal.addEventListener('abort', () =>
          resolve({ stopReason: 'cancelled' }),
        )
        setTimeout(() => resolve({ stopReason: 'end_turn' }), 2_000)
      })
    const agent = createAcpAgent({ promptHandler, connection })
    // No projectRoot → cwd validation skipped; only the session-count cap
    // applies. Create the full complement of 16 sessions, each with a turn in
    // flight (started WITHOUT awaiting) so none of them is an idle eviction
    // victim.
    const ids: string[] = []
    const inFlight: Promise<unknown>[] = []
    try {
      for (let i = 0; i < 16; i += 1) {
        const { sessionId } = await agent.newSession({
          cwd: `/tmp/acp-cap-${i}`,
          mcpServers: [],
        })
        ids.push(sessionId)
        inFlight.push(
          Promise.resolve(
            agent.prompt({ sessionId, prompt: [{ type: 'text', text: 'x' }] }),
          ).catch(() => {}),
        )
      }

      let failure: unknown
      try {
        await agent.newSession({ cwd: '/tmp/acp-cap-overflow', mcpServers: [] })
      } catch (error) {
        failure = error
      }
      expect(failure).toBeInstanceOf(RequestError)
      expect((failure as RequestError).code).toBe(-32602)
      expect(
        (
          (failure as RequestError).data as
            | Record<string, Record<string, unknown>>
            | undefined
        )?.['openbuff.dev']?.code,
      ).toBe('limit_exceeded')
    } finally {
      // Tear down the in-flight turns so the test cannot hang or leak.
      for (const sessionId of ids) {
        agent.cancel({ sessionId })
      }
      await Promise.allSettled(inFlight)
    }
  })

  test('a prompt over the 8 MiB total limit is rejected with limit_exceeded', async () => {
    const { connection } = makeRecordingConnection()
    let ran = false
    const agent = createAcpAgent({
      promptHandler: async () => {
        ran = true
        return { stopReason: 'end_turn' }
      },
      connection,
    })
    const { sessionId } = await agent.newSession({
      cwd: '/tmp/acp-limit',
      mcpServers: [],
    })

    const oversized = 'x'.repeat(8 * 1024 * 1024 + 1)
    let failure: unknown
    try {
      await agent.prompt({
        sessionId,
        prompt: [{ type: 'text', text: oversized }],
      })
    } catch (error) {
      failure = error
    }
    expect(failure).toBeInstanceOf(RequestError)
    expect((failure as RequestError).code).toBe(-32602)
    expect(
      (
        (failure as RequestError).data as
          | Record<string, Record<string, unknown>>
          | undefined
      )?.['openbuff.dev']?.code,
    ).toBe('limit_exceeded')
    // The handler never ran on an over-limit prompt.
    expect(ran).toBe(false)
  })

  test('a decoded image over the 5 MiB per-image limit is rejected with limit_exceeded', async () => {
    const { connection } = makeRecordingConnection()
    const agent = createAcpAgent({
      promptHandler: async () => ({ stopReason: 'end_turn' }),
      connection,
    })
    const { sessionId } = await agent.newSession({
      cwd: '/tmp/acp-img-limit',
      mcpServers: [],
    })

    // base64 whose decoded size exceeds 5 MiB (6 MiB of bytes → ~8 MiB base64).
    const oversizedImage = Buffer.alloc(6 * 1024 * 1024).toString('base64')
    let failure: unknown
    try {
      await agent.prompt({
        sessionId,
        prompt: [{ type: 'image', data: oversizedImage, mimeType: 'image/png' }],
      })
    } catch (error) {
      failure = error
    }
    expect(failure).toBeInstanceOf(RequestError)
    expect((failure as RequestError).code).toBe(-32602)
    expect(
      (
        (failure as RequestError).data as
          | Record<string, Record<string, unknown>>
          | undefined
      )?.['openbuff.dev']?.code,
    ).toBe('limit_exceeded')
  })

  test('an inbound NDJSON frame over 16 MiB errors the connection readable (frame closes)', async () => {
    // Drive the real wire: a ClientSideConnection against an AgentSideConnection
    // over paired in-memory streams, with the SAME 16 MiB input guard that
    // serveAcpOverStdio applies. A single oversized initialize frame must error
    // the agent's readable rather than be parsed.
    const agentToClient = new TransformStream<AnyMessage, AnyMessage>()
    const clientToAgent = new TransformStream<Uint8Array, Uint8Array>()

    // Agent reads through the REAL exported byte guard serveAcpOverStdio
    // installs (§12.6) — not a copy that can drift from production. The
    // breach callback tears down the agent→client direction (the stdio serve
    // ends stdout), so a client with a request in flight observes the
    // connection close instead of hanging on the pending request.
    const limitedReadable = limitNdJsonLineBytes(
      clientToAgent.readable,
      16 * 1024 * 1024,
      () => {
        void agentToClient.writable.abort(new Error('frame too large'))
      },
    )

    // Decode NDJSON → JSON-RPC messages for the AgentSideConnection.
    const decoded = new ReadableStream<AnyMessage>({
      async start(controller) {
        const reader = limitedReadable.getReader()
        const decoder = new TextDecoder()
        let buffer = ''
        try {
          for (;;) {
            const { value, done } = await reader.read()
            if (done) break
            buffer += decoder.decode(value, { stream: true })
            let idx
            while ((idx = buffer.indexOf('\n')) !== -1) {
              const line = buffer.slice(0, idx).trim()
              buffer = buffer.slice(idx + 1)
              if (line) controller.enqueue(JSON.parse(line) as AnyMessage)
            }
          }
          controller.close()
        } catch {
          controller.error(new Error('agent readable closed on oversized frame'))
        }
      },
    })
    const agentStream: Stream = {
      writable: agentToClient.writable,
      readable: decoded,
    }

    const encode = new TextEncoder()
    const clientRaw = new ReadableStream<AnyMessage>({
      async start(controller) {
        const reader = agentToClient.readable.getReader()
        for (;;) {
          const { value, done } = await reader.read()
          if (done) break
          controller.enqueue(value)
        }
        controller.close()
      },
    })
    const clientWritable = new WritableStream<AnyMessage>({
      write(message) {
        const writer = clientToAgent.writable.getWriter()
        return writer
          .write(encode.encode(`${JSON.stringify(message)}\n`))
          .finally(() => writer.releaseLock())
      },
    })
    const clientStream: Stream = {
      writable: clientWritable,
      readable: clientRaw,
    }

    const fakeClient: Client = {
      requestPermission: async () => {
        throw new Error('not called')
      },
      sessionUpdate: async () => {},
    }
    void new AgentSideConnection(
      (conn) =>
        createAcpAgent({
          promptHandler: async () => ({ stopReason: 'end_turn' }),
          connection: conn,
        }),
      agentStream,
    )
    const client = new ClientSideConnection(() => fakeClient, clientStream)

    // A single initialize frame padded past 16 MiB. The agent's byte guard
    // errors the readable, so the request never completes.
    const hugePadding = 'p'.repeat(17 * 1024 * 1024)
    let settled = false
    let failed = false
    client
      .initialize({
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: {},
        clientInfo: { name: hugePadding, version: '0' },
      })
      .then(() => {
        settled = true
      })
      .catch(() => {
        failed = true
      })
    // Give the wire a moment; the oversized frame must NOT produce a result.
    await new Promise((r) => setTimeout(r, 200))
    expect(settled).toBe(false)
    expect(failed).toBe(true)
  })
})

describe('P1-T2 session/load chat-history replay (§4.1, GV-26)', () => {
  const CAP_TOKEN = 'cap.v3.1.2.AAA.BBB.CCC'

  test('replays user/agent/tool history as sanitized chunks and final-status tool calls', async () => {
    const { connection, updates } = makeRecordingConnection()
    const history: AcpReplayMessage[] = [
      { variant: 'user', text: 'Rename foo to bar' },
      { variant: 'agent', text: 'Updating src/a.ts.' },
      {
        variant: 'tool',
        toolCallId: 'call_7',
        toolName: 'Edit transaction',
        paths: ['src/a.ts'],
      },
    ]
    const agent = createAcpAgent({
      promptHandler: async () => ({ stopReason: 'end_turn' }),
      connection,
      loadHandler: async () => {},
      historyLoader: async () => history,
    })

    await agent.loadSession({
      cwd: '/tmp/acp-replay',
      mcpServers: [],
      sessionId: 'replay-session',
    })

    expect(updates.map((u) => u.update)).toEqual([
      {
        sessionUpdate: 'user_message_chunk',
        content: { type: 'text', text: 'Rename foo to bar' },
      },
      {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Updating src/a.ts.' },
      },
      {
        sessionUpdate: 'tool_call',
        toolCallId: 'call_7',
        title: 'Edit transaction',
        status: 'completed',
        locations: [{ path: 'src/a.ts' }],
      },
    ])
    // Replayed tool_call carries NO rawInput/rawOutput (GV-26).
    const toolUpdate = updates[2].update
    expect('rawInput' in toolUpdate).toBe(false)
    expect('rawOutput' in toolUpdate).toBe(false)
  })

  test('GV-26: a history containing a cap.v3 token emits NO frame containing cap.v3.', async () => {
    const { connection, updates } = makeRecordingConnection()
    const history: AcpReplayMessage[] = [
      { variant: 'user', text: 'read the file' },
      // A read_files-style tool result whose captured text carries a token.
      { variant: 'agent', text: `token was ${CAP_TOKEN} done` },
      { variant: 'tool', toolCallId: 'call_9', toolName: CAP_TOKEN },
    ]
    const agent = createAcpAgent({
      promptHandler: async () => ({ stopReason: 'end_turn' }),
      connection,
      loadHandler: async () => {},
      historyLoader: async () => history,
    })

    await agent.loadSession({
      cwd: '/tmp/acp-gv26',
      mcpServers: [],
      sessionId: 'gv26-session',
    })

    const serialized = JSON.stringify(updates)
    expect(serialized).not.toContain('cap.v3.')
    expect(serialized).toContain('[REDACTED_CAPABILITY]')
  })

  test('replay drops reasoning and emits no receipts/capabilities', async () => {
    const { connection, updates } = makeRecordingConnection()
    const history: AcpReplayMessage[] = [
      { variant: 'user', text: 'hi' },
      // A reasoning-shaped entry is simply not one of the replayable variants.
      { variant: 'agent', text: 'answer' },
    ]
    const agent = createAcpAgent({
      promptHandler: async () => ({ stopReason: 'end_turn' }),
      connection,
      loadHandler: async () => {},
      historyLoader: async () => history,
    })
    await agent.loadSession({
      cwd: '/tmp/acp-replay-2',
      mcpServers: [],
      sessionId: 'replay-2',
    })
    for (const update of updates) {
      const u = update.update as Record<string, unknown>
      expect(u.sessionUpdate).not.toBe('agent_thought_chunk')
      expect(u._meta).toBeUndefined()
    }
  })

  test('replay runs through the same store-restore seam the bridge uses (resolveAcpServeOptions)', async () => {
    const { connection, updates } = makeRecordingConnection()
    const sessionData = new AcpSessionData()
    const resolved = resolveAcpServeOptions({
      promptHandler: async () => ({ stopReason: 'end_turn' }),
      sessionData,
      historyLoader: async () => [
        { variant: 'user', text: 'earlier turn' },
        { variant: 'agent', text: 'earlier answer' },
      ],
    })
    const agent = createAcpAgent({ ...resolved, connection })

    await agent.loadSession({
      cwd: '/tmp/acp-bridge-replay',
      mcpServers: [],
      sessionId: 'bridge-replay',
    })
    expect(updates.map((u) => u.update.sessionUpdate)).toEqual([
      'user_message_chunk',
      'agent_message_chunk',
    ])
  })
})
