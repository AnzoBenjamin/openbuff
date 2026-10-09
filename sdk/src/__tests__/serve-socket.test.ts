import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdtempSync, rmSync, statSync } from 'node:fs'
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
import {
  createOutboundQueueWritable,
  type OutboundQueueWritableTarget,
} from '../serve/socket-listener'
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
    // The honest §3.3 advertisement: no sessionCapabilities (session/list
    // and session/close are not implemented) and no `_meta` for a plain ACP
    // client that sent no openbuff.dev ext negotiation.
    expect(initialized.agentCapabilities).toEqual({
      loadSession: true,
      promptCapabilities: {
        image: false,
        audio: false,
        embeddedContext: false,
      },
      mcpCapabilities: { http: true, sse: true },
    })
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

    // NEW-3 (§12.8) OutboundHoldback: short back-to-back text events are
    // HELD and coalesce into one window, released at turn end (the bridge's
    // flush in `finally`) or by the idle flusher — so the client receives
    // the two texts as one coalesced chunk (or, at the window boundary, as
    // separate pieces). Assert on the JOINED stream, not a chunk count.
    await waitFor(() => chunks.length >= 1)

    const joinedChunks = chunks.join('\n')

    // (a) The plain assistant text reached the client verbatim.
    expect(joinedChunks).toContain('hello from agent')

    // (b) The cap.v3 token arrived REDACTED: no chunk carries the raw token,
    // and the redaction marker proves sanitizeOutbound ran on the socket path.
    expect(joinedChunks.includes('cap.v3.')).toBe(false)
    expect(joinedChunks.includes('[REDACTED_CAPABILITY]')).toBe(true)

    // (c) The tool_call event was structurally dropped: no chunk carries its
    // payload marker.
    expect(joinedChunks.includes(toolCallMarker)).toBe(false)
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

  test('the socket inode is already 0o600 when serveAcpOverSocket returns (no bind→chmod window)', () => {
    const socketPath = join(dir, 'early-perm.sock')
    startServer({ socketPath, token: 'token' })
    // serveAcpOverSocket binds synchronously inside listen() and chmods
    // BEFORE returning, so no same-uid peer can observe a connectable socket
    // with a looser mode in the bind→chmod window.
    expect(statSync(socketPath).mode & 0o777).toBe(0o600)
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

/**
 * A bounded fake writable standing in for the authenticated net Socket (no
 * real sockets needed): `stalled` makes `write()` report a full buffer, so
 * the queue wiring must pause and only resume when the test fires 'drain'.
 */
function makeFakeWritableTarget(): {
  target: OutboundQueueWritableTarget
  written: string[]
  setStalled: (stalled: boolean) => void
  fireDrain: () => void
  destroyCalls: () => number
} {
  const written: string[] = []
  const drainListeners: Array<() => void> = []
  let stalled = false
  let destroyed = 0
  const target: OutboundQueueWritableTarget = {
    write: (chunk) => {
      // Node semantics: a stalled writable still ACCEPTS (buffers) the chunk
      // whose write() returned false; only the boolean reports backpressure.
      written.push(new TextDecoder().decode(chunk))
      return !stalled
    },
    once: (event, listener) => {
      if (event === 'drain') drainListeners.push(listener)
      return target
    },
    destroy: () => {
      destroyed += 1
    },
  }
  return {
    target,
    written,
    setStalled: (value) => {
      stalled = value
    },
    fireDrain: () => {
      while (drainListeners.length > 0) drainListeners.shift()!()
    },
    destroyCalls: () => destroyed,
  }
}

/** Writes one NDJSON line into the queue-wrapped writable. */
async function writeFrame(
  writer: WritableStreamDefaultWriter<Uint8Array>,
  frame: Record<string, unknown>,
): Promise<void> {
  await writer.write(
    new TextEncoder().encode(`${JSON.stringify(frame)}\n`),
  )
}

describe('createOutboundQueueWritable (§12.6 OutboundQueue wiring)', () => {
  test('a stalled writable accumulates queued frames and drain flushes them in order', async () => {
    const fake = makeFakeWritableTarget()
    fake.setStalled(true)
    const writable = createOutboundQueueWritable(fake.target)
    const writer = writable.getWriter()

    // Three distinct (non-coalesceable) frames while the fake socket is
    // stalled: the FIRST frame is accepted-and-buffered (write() returned
    // false, which is exactly the backpressure signal), and everything after
    // it must stay QUEUED, not handed to the socket.
    await writeFrame(writer, { msg: 'one' })
    await writeFrame(writer, { msg: 'two' })
    await writeFrame(writer, { msg: 'three' })
    expect(fake.written).toEqual(['{"msg":"one"}\n'])

    // The client keeps up again: 'drain' resumes the drain and the queued
    // frames flush IN ORDER.
    fake.setStalled(false)
    fake.fireDrain()
    expect(fake.written).toEqual([
      '{"msg":"one"}\n',
      '{"msg":"two"}\n',
      '{"msg":"three"}\n',
    ])
  })

  test('a client that keeps up takes the immediate-write fast path (no queueing)', async () => {
    const fake = makeFakeWritableTarget()
    const writable = createOutboundQueueWritable(fake.target)
    const writer = writable.getWriter()

    await writeFrame(writer, { msg: 'a' })
    await writeFrame(writer, { msg: 'b' })
    // No drain was ever needed: every frame was written synchronously.
    expect(fake.written).toEqual([
      '{"msg":"a"}\n',
      '{"msg":"b"}\n',
    ])
  })

  test('coalescing merges consecutive chunk frames for one messageId before the drain', async () => {
    const fake = makeFakeWritableTarget()
    const writable = createOutboundQueueWritable(fake.target)
    const writer = writable.getWriter()

    const chunk = (text: string): Record<string, unknown> => ({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: 's1',
        update: {
          sessionUpdate: 'agent_message_chunk',
          messageId: 'm1',
          content: { type: 'text', text },
        },
      },
    })
    // The socket is stalled from the start: the first frame still takes the
    // fast path — it is handed to the (stalled) socket, accepted and
    // buffered, write() returning false — and leaves the queue. The NEXT two
    // frames of the same chunk stream enqueue while the queue is stalled and
    // COALESCE into one queued frame.
    fake.setStalled(true)
    await writeFrame(writer, chunk('hello '))
    expect(fake.written).toHaveLength(1)
    await writeFrame(writer, chunk('world'))
    await writeFrame(writer, chunk('again'))

    fake.fireDrain()
    expect(fake.written).toHaveLength(2)
    const coalesced = JSON.parse(
      fake.written[1]!.trim(),
    ) as {
      params: { update: { content: { text: string } } }
    }
    expect(coalesced.params.update.content.text).toBe('worldagain')
  })

  test('an overflow abort destroys the connection (fail closed)', async () => {
    // maxBytes: 1 → any non-coalesceable frame overflows immediately; the
    // queue returns the abort decision and the wiring must destroy the
    // connection instead of growing without bound.
    const fake = makeFakeWritableTarget()
    const writable = createOutboundQueueWritable(fake.target, { maxBytes: 1 })
    const writer = writable.getWriter()

    let writeError: unknown
    try {
      await writeFrame(writer, { jsonrpc: '2.0', method: 'session/update', params: {} })
    } catch (error) {
      writeError = error
    }
    expect(writeError).toBeInstanceOf(Error)
    expect((writeError as Error).message).toContain('overflow')
    // Fail closed: the connection was destroyed BEFORE anything was written.
    expect(fake.destroyCalls()).toBe(1)
    expect(fake.written).toEqual([])
  })
})
