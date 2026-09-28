import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { connect } from 'node:net'
import type { Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable, Writable } from 'node:stream'

import {
  ClientSideConnection,
  PROTOCOL_VERSION,
  ndJsonStream,
} from '@agentclientprotocol/sdk'
import type { Client, Stream } from '@agentclientprotocol/sdk'

import { serveAcpOverSocket } from '../serve/socket-listener'
import type { ServeAcpOverSocketOptions } from '../serve/socket-listener'
import { createServeBridge } from '../serve/bridge'
import type { ServeBridgeClient } from '../serve/bridge'
import { AcpSessionData } from '../services/acp/session-data'
import type { RunState } from '../run-state'
import type { PrintModeEvent } from '@codebuff/common/types/print-mode'

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error('Timed out waiting for condition.')
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 5))
  }
}

// process.geteuid is undefined on Windows: the whole suite is unix-only.
const describeUnix =
  typeof process.geteuid === 'function' ? describe : describe.skip

describeUnix('serveAcpOverSocket (SEC-4 unix socket transport)', () => {
  let dir: string
  const tempDirs: string[] = []
  const servers: Array<{ close: () => Promise<void> }> = []
  const sockets: Socket[] = []

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'acp-sock-'))
    tempDirs.push(dir)
  })

  afterEach(async () => {
    for (const socket of sockets.splice(0)) {
      socket.destroy()
    }
    for (const server of servers.splice(0)) {
      await server.close()
    }
    while (tempDirs.length > 0) {
      const d = tempDirs.pop()
      if (d) rmSync(d, { recursive: true, force: true })
    }
  })

  function startServer(
    overrides: Partial<ServeAcpOverSocketOptions> & {
      socketPath: string
      token: string
    },
  ): { close: () => Promise<void> } {
    const server = serveAcpOverSocket({
      promptHandler: async () => ({ stopReason: 'end_turn' }),
      ...overrides,
    })
    servers.push(server)
    return server
  }

  function connectAuthedClient(
    socketPath: string,
    token: string,
    onSessionUpdate?: (params: Parameters<Client['sessionUpdate']>[0]) => void,
  ): { client: ClientSideConnection; socket: Socket } {
    const socket = connect(socketPath)
    sockets.push(socket)
    // Auth line first, then ACP framing on the same socket (server unshifts the
    // remainder after consuming the auth line).
    socket.write(`${JSON.stringify({ type: 'openbuff.serve.auth', token })}\n`)
    const stream: Stream = ndJsonStream(
      Writable.toWeb(socket) as unknown as WritableStream<Uint8Array>,
      Readable.toWeb(socket) as unknown as ReadableStream<Uint8Array>,
    )
    const fakeClient: Client = {
      requestPermission: async () => {
        throw new Error('requestPermission must not be called by the skeleton')
      },
      // A no-op by default; when a sink is passed, session/update notifications
      // (e.g. agent_message_chunk) are surfaced to the test.
      sessionUpdate: async (params) => {
        onSessionUpdate?.(params)
      },
    }
    const client = new ClientSideConnection(() => fakeClient, stream)
    return { client, socket }
  }

  test('happy path: listens then answers initialize after a valid auth line', async () => {
    const socketPath = join(dir, 'happy.sock')
    const listenInfos: Array<{ socketPath: string }> = []
    startServer({
      socketPath,
      token: 'secret-token',
      onListening: (info) => listenInfos.push(info),
    })

    await waitFor(() => listenInfos.length > 0)
    expect(listenInfos[0]?.socketPath).toBe(socketPath)
    expect(existsSync(socketPath)).toBe(true)

    const { client } = connectAuthedClient(socketPath, 'secret-token')
    const initialized = await client.initialize({
      protocolVersion: PROTOCOL_VERSION,
    })
    expect(initialized.protocolVersion).toBe(PROTOCOL_VERSION)
    expect(initialized.agentCapabilities).toEqual({ loadSession: true })
  })

  test('e2e: a full prompt turn through the serve bridge carries only sanitized JSON-RPC on the wire', async () => {
    const socketPath = join(dir, 'e2e.sock')
    const token = 'e2e-token'

    // The tool_call payload string that MUST NOT reach the client: the bridge
    // structurally drops tool_call events, so no chunk should contain it.
    const toolCallMarker = 'read_files-tool-call-should-be-dropped'

    // FAKE client: its `.run` drives handleEvent with the scripted PrintMode
    // events (text -> forwarded, cap.v3 text -> forwarded redacted, tool_call
    // -> dropped), then resolves a minimal RunState-ish object. No process
    // spawning; mirrors serve-bridge.test.ts's makeFakeClient RunState shape.
    const fakeRunClient: ServeBridgeClient = {
      async run(runOptions) {
        const events: PrintModeEvent[] = [
          { type: 'text', text: 'hello from agent' },
          { type: 'text', text: 'token cap.v3.AAAA.BBBB.CCCC leak' },
          {
            type: 'tool_call',
            toolCallId: 't1',
            toolName: 'read_files',
            input: { marker: toolCallMarker },
          },
        ]
        for (const event of events) {
          await runOptions.handleEvent?.(event)
        }
        return { output: { type: 'error', message: 'done' } } as RunState
      },
    }

    const { promptHandler } = createServeBridge({
      client: fakeRunClient,
      sessionData: new AcpSessionData(),
    })

    // startServer spreads overrides over its default promptHandler, so passing
    // promptHandler here replaces the stub with the real bridge handler.
    let listening = false
    startServer({
      socketPath,
      token,
      promptHandler,
      onListening: () => {
        listening = true
      },
    })
    await waitFor(() => listening)

    // Capture every agent_message_chunk text delivered via session/update.
    const chunks: string[] = []
    const { client } = connectAuthedClient(socketPath, token, (params) => {
      const update = params.update
      if (
        update.sessionUpdate === 'agent_message_chunk' &&
        update.content.type === 'text'
      ) {
        chunks.push(update.content.text)
      }
    })

    await client.initialize({ protocolVersion: PROTOCOL_VERSION })
    const session = await client.newSession({ cwd: dir, mcpServers: [] })
    const response = await client.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: 'text', text: 'do it' }],
    })

    expect(response.stopReason).toBe('end_turn')

    // The two text events forward as chunks; the tool_call event is dropped.
    await waitFor(() => chunks.length >= 2)

    // (a) The plain assistant text reached the client verbatim.
    expect(chunks).toContain('hello from agent')

    // (b) The cap.v3 token arrived REDACTED: no chunk carries the raw token,
    // and the redaction marker proves sanitizeOutbound ran on the socket path.
    expect(chunks.some((chunk) => chunk.includes('cap.v3.'))).toBe(false)
    expect(chunks.some((chunk) => chunk.includes('[REDACTED_CAPABILITY]'))).toBe(
      true,
    )

    // (c) The tool_call event was structurally dropped: no chunk carries its
    // payload marker.
    expect(chunks.some((chunk) => chunk.includes(toolCallMarker))).toBe(false)
  })

  test('bad token destroys the connection and reports onAuthFailure', async () => {
    const socketPath = join(dir, 'bad.sock')
    const failures: string[] = []
    let listening = false
    startServer({
      socketPath,
      token: 'right-token',
      onAuthFailure: (reason) => failures.push(reason),
      onListening: () => {
        listening = true
      },
    })
    await waitFor(() => listening)

    const socket = connect(socketPath)
    sockets.push(socket)
    let closed = false
    socket.on('close', () => {
      closed = true
    })
    socket.write(
      `${JSON.stringify({ type: 'openbuff.serve.auth', token: 'wrong-token' })}\n`,
    )

    await waitFor(() => failures.includes('bad-token'))
    await waitFor(() => closed)
    expect(failures).toEqual(['bad-token'])
  })

  test('no auth line within the timeout destroys the connection', async () => {
    const socketPath = join(dir, 'timeout.sock')
    const failures: string[] = []
    let listening = false
    startServer({
      socketPath,
      token: 'right-token',
      authTimeoutMs: 100,
      onAuthFailure: (reason) => failures.push(reason),
      onListening: () => {
        listening = true
      },
    })
    await waitFor(() => listening)

    const socket = connect(socketPath)
    sockets.push(socket)
    let closed = false
    socket.on('close', () => {
      closed = true
    })
    // Send nothing: the grace window must elapse and destroy the connection.

    await waitFor(() => failures.includes('timeout'), 2_000)
    await waitFor(() => closed, 2_000)
    expect(failures).toEqual(['timeout'])
  })

  test('an oversized auth line (no newline) is rejected', async () => {
    const socketPath = join(dir, 'oversize.sock')
    const failures: string[] = []
    let listening = false
    startServer({
      socketPath,
      token: 'right-token',
      onAuthFailure: (reason) => failures.push(reason),
      onListening: () => {
        listening = true
      },
    })
    await waitFor(() => listening)

    const socket = connect(socketPath)
    sockets.push(socket)
    let closed = false
    socket.on('close', () => {
      closed = true
    })
    // 128 KiB with no newline overflows the auth-line buffer cap (64 KiB).
    socket.write('a'.repeat(128 * 1024))

    await waitFor(() => failures.includes('auth-line-too-long'), 2_000)
    await waitFor(() => closed, 2_000)
    expect(failures).toEqual(['auth-line-too-long'])
  })

  test('assertSocketDirSafe rejects a group/other-writable parent dir', () => {
    const badDir = mkdtempSync(join(tmpdir(), 'acp-sock-bad-'))
    tempDirs.push(badDir)
    chmodSync(badDir, 0o777)
    expect(() =>
      serveAcpOverSocket({
        promptHandler: async () => ({ stopReason: 'end_turn' }),
        socketPath: join(badDir, 'x.sock'),
        token: 'token',
      }),
    ).toThrow(/group\/other-writable/)
  })

  test('close() is idempotent and unlinks the socket + lock', async () => {
    const socketPath = join(dir, 'close.sock')
    const lockPath = `${socketPath}.lock`
    let listening = false
    const server = startServer({
      socketPath,
      token: 'token',
      onListening: () => {
        listening = true
      },
    })
    await waitFor(() => listening)
    expect(existsSync(socketPath)).toBe(true)
    expect(existsSync(lockPath)).toBe(true)

    await server.close()
    expect(existsSync(socketPath)).toBe(false)
    expect(existsSync(lockPath)).toBe(false)

    // Idempotent: a second close is a no-op and never throws.
    await server.close()
  })
})
