import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { Readable, Writable } from 'node:stream'

import {
  AgentSideConnection,
  ndJsonStream,
} from '@agentclientprotocol/sdk'

import {
  AcpRemoteBackend,
  acpSessionUpdateToPrintModeEvents,
} from '../client/acp-client'
import type { ActiveRun } from '../client/acp-client'
import { OpenbuffClient } from '../client'
import { serveAcpOverSocket } from '../serve/socket-listener'
import type { AcpPromptHandler } from '../services/acp/acp-agent'

import type { ClientBackend } from '../client/backend'
import type { PrintModeEvent } from '@codebuff/common/types/print-mode'
import type { SessionUpdate } from '@agentclientprotocol/sdk'
import type { RunState } from '../run-state'
import type { AgentOutput } from '@codebuff/common/types/session-state'

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting.')
    await new Promise<void>((resolve) => setTimeout(resolve, 5))
  }
}

/** Builds an in-memory duplex ACP stream pair linking backend<->agent. */
function inMemoryAcpPair(): {
  backend: AcpRemoteBackend
} {
  const clientToAgent = new PassThrough()
  const agentToClient = new PassThrough()
  const agentStream = ndJsonStream(
    Writable.toWeb(clientToAgent) as unknown as WritableStream<Uint8Array>,
    Readable.toWeb(agentToClient) as unknown as ReadableStream<Uint8Array>,
  )
  const clientStream = ndJsonStream(
    Writable.toWeb(agentToClient) as unknown as WritableStream<Uint8Array>,
    Readable.toWeb(clientToAgent) as unknown as ReadableStream<Uint8Array>,
  )
  // A real agent side: emits text + tool_call + tool_call_update + cost updates.
  void new AgentSideConnection(
    (conn) => ({
      initialize: () => ({
        protocolVersion: 1,
        agentCapabilities: { loadSession: true },
        authMethods: [],
      }),
      newSession: () => ({ sessionId: 'session-1' }),
      authenticate: () => {
        throw new Error('no auth')
      },
      loadSession: async () => ({}),
      prompt: async (params: { sessionId: string; prompt: unknown[] }) => {
        const sid = params.sessionId
        await conn.sessionUpdate({
          sessionId: sid,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'hello ' },
          },
        })
        await conn.sessionUpdate({
          sessionId: sid,
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: 't1',
            title: 'read_files',
            status: 'pending',
            rawInput: { path: 'a.ts' },
          },
        })
        await conn.sessionUpdate({
          sessionId: sid,
          update: {
            sessionUpdate: 'tool_call_update',
            toolCallId: 't1',
            status: 'in_progress',
          },
        })
        await conn.sessionUpdate({
          sessionId: sid,
          update: {
            sessionUpdate: 'tool_call_update',
            toolCallId: 't1',
            status: 'completed',
            // ToolCallContent text blocks are wrapped: { type: 'content',
            // content: <ContentBlock> } (the raw { type:'text' } arm is not a
            // valid tool_call_update content item).
            content: [
              { type: 'content', content: { type: 'text', text: 'read ok' } },
            ],
          },
        })
        await conn.sessionUpdate({
          sessionId: sid,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'world' },
          },
        })
        // usage_update's `used`/`size` are REQUIRED by the SDK's zod schema
        // (the notification is dropped on parse failure); `cost` is optional.
        // The backend accumulates cost.amount onto the finish event's totalCost.
        await conn.sessionUpdate({
          sessionId: sid,
          update: {
            sessionUpdate: 'usage_update',
            used: 100,
            size: 1000,
            cost: { amount: 0.5, currency: 'USD' },
          } as SessionUpdate,
        })
        return { stopReason: 'end_turn' }
      },
      cancel: async () => {},
    }),
    agentStream,
  )
  const backend = new AcpRemoteBackend({ kind: 'stream', stream: clientStream })
  return { backend }
}

describe('AcpRemoteBackend (in-memory ACP roundtrip)', () => {
  test('maps session/update notifications to PrintModeEvents and finishes', async () => {
    const { backend } = inMemoryAcpPair()
    const events: PrintModeEvent[] = []
    let streamed = ''
    const result = await backend.run({
      agent: 'base',
      prompt: 'hi',
      handleEvent: (e) => {
        events.push(e)
        if (e.type === 'text') streamed += e.text
      },
    })
    // session/update notifications race the prompt resolution on the wire, so
    // wait for the streamed text before asserting on it.
    await waitFor(() => streamed.includes('world'))
    expect(result.output.type).toBe('lastMessage')
    if (result.output.type === 'lastMessage') {
      expect(result.output.value).toEqual([
        { type: 'text', text: 'hello world' },
      ])
    }
    const types = events.map((e) => e.type)
    expect(types).toContain('text')
    expect(types).toContain('tool_call')
    expect(types).toContain('tool_start')
    expect(types).toContain('tool_result')
    expect(types).toContain('finish')
    const toolResult = events.find((e) => e.type === 'tool_result')
    expect(toolResult && 'toolName' in toolResult && toolResult.toolName).toBe(
      'read_files',
    )
    // The usage_update notification races the prompt resolution: finish is
    // emitted when prompt() returns, so wait for the cost to land first.
    await waitFor(
      () =>
        events.some(
          (e) => e.type === 'finish' && (e as { totalCost?: number }).totalCost === 0.5,
        ),
    )
    const finish = events.find((e) => e.type === 'finish')
    expect(
      finish && 'totalCost' in finish && finish.totalCost,
    ).toBeCloseTo(0.5)
  })
})

describe('OpenbuffClient backend seam', () => {
  test('dispatches to an injected backend (not the in-process run)', async () => {
    const seen: Array<unknown> = []
    const backend: ClientBackend = {
      run: async (options) => {
        seen.push(options)
        await options.handleEvent?.({ type: 'text', text: 'remote' })
        // The backend seam resolves a RunState; sessionState is optional.
        return {
          output: { type: 'lastMessage', value: 'remote' },
        } as unknown as RunState
      },
    }
    const events: PrintModeEvent[] = []
    const client = new OpenbuffClient({
      backend,
      handleEvent: (e) => {
        events.push(e)
      },
    })
    const result: RunState = await client.run({ agent: 'base', prompt: 'x' })
    expect(seen).toHaveLength(1)
    expect(result.output).toMatchObject({
      type: 'lastMessage',
      value: 'remote',
    })
    expect(events.map((e) => e.type)).toContain('text')
  })

  test('exposes the backend via the `backend` getter', () => {
    const backend: ClientBackend = {
      run: async () =>
        ({
          output: { type: 'lastMessage', value: '' },
        }) as unknown as RunState,
    }
    const client = new OpenbuffClient({ backend })
    expect(client.backend).toBe(backend)
  })
})

describe('acpSessionUpdateToPrintModeEvents (pure mapper)', () => {
  const freshRun = (): ActiveRun => ({
    options: { agent: 'base', prompt: '' },
    text: '',
    totalCost: 0,
    toolNames: new Map<string, string>(),
    statuses: new Map<string, string>(),
  })

  test('maps a text chunk', () => {
    const run = freshRun()
    const events = acpSessionUpdateToPrintModeEvents(
      {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'abc' },
      },
      run,
    )
    expect(events).toEqual([{ type: 'text', text: 'abc' }])
    expect(run.text).toBe('abc')
  })

  test('maps a thought chunk to reasoning_delta', () => {
    const run = freshRun()
    const events = acpSessionUpdateToPrintModeEvents(
      {
        sessionUpdate: 'agent_thought_chunk',
        content: { type: 'text', text: 'thinking' },
      },
      run,
    )
    expect(events).toEqual([
      {
        type: 'reasoning_delta',
        text: 'thinking',
        runId: '',
        ancestorRunIds: [],
      },
    ])
  })

  test('maps tool_call then failed tool_call_update to an error tool_result', () => {
    const run = freshRun()
    acpSessionUpdateToPrintModeEvents(
      {
        sessionUpdate: 'tool_call',
        toolCallId: 't9',
        title: 'write_file',
        status: 'pending',
        rawInput: { path: 'b.ts' },
      },
      run,
    )
    const events = acpSessionUpdateToPrintModeEvents(
      {
        sessionUpdate: 'tool_call_update',
        toolCallId: 't9',
        status: 'failed',
        content: [
          { type: 'content', content: { type: 'text', text: 'boom' } },
        ],
      },
      run,
    )
    expect(events).toEqual([
      {
        type: 'tool_result',
        toolCallId: 't9',
        toolName: 'write_file',
        output: [{ type: 'json', value: { errorMessage: 'boom' } }],
      },
    ])
  })

  test('ignores unknown update kinds', () => {
    const run = freshRun()
    const events = acpSessionUpdateToPrintModeEvents(
      { sessionUpdate: 'plan', entries: [] } as never,
      run,
    )
    expect(events).toEqual([])
  })
})

// process.geteuid is undefined on Windows: the socket roundtrip is unix-only.
const describeUnix =
  typeof process.geteuid === 'function' ? describe : describe.skip

describeUnix('AcpRemoteBackend over a real SEC-4 socket', () => {
  let dir: string
  const servers: Array<{ close: () => Promise<void> }> = []

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'acp-client-'))
    chmodSync(dir, 0o700)
  })

  afterEach(async () => {
    for (const server of servers.splice(0)) await server.close()
    rmSync(dir, { recursive: true, force: true })
  })

  test('runs a prompt against serveAcpOverSocket and streams text back', async () => {
    const socketPath = join(dir, 'x.sock')
    const token = 'secret'
    const promptHandler: AcpPromptHandler = async (input) => {
      // Fire-and-forget the chunks: awaiting each `update` would deadlock the
      // prompt against the real bridge (the agent's sessionUpdate notification
      // can't flush until the client's prompt request resolves). The client
      // accumulates them asynchronously and the test waits on the stream.
      void input.update('chunk-one ')
      void input.update('chunk-two')
      return { stopReason: 'end_turn' }
    }
    let listening = false
    servers.push(
      serveAcpOverSocket({
        promptHandler,
        socketPath,
        token,
        onListening: () => {
          listening = true
        },
      }),
    )
    await waitFor(() => listening)

    const backend = new AcpRemoteBackend({
      kind: 'socket',
      socketPath,
      token,
    })
    const events: PrintModeEvent[] = []
    let streamed = ''
    const result = await backend.run({
      agent: 'base',
      prompt: 'hi',
      cwd: dir,
      handleEvent: (e) => {
        events.push(e)
        if (e.type === 'text') streamed += e.text
      },
    })
    // session/update notifications race the prompt resolution on the wire, so
    // wait for the streamed text before asserting on it.
    await waitFor(() => streamed.includes('chunk-two'))
    expect(result.output.type).toBe('lastMessage')
    if (result.output.type === 'lastMessage') {
      expect(result.output.value).toEqual([
        { type: 'text', text: 'chunk-one chunk-two' },
      ])
    }
    expect(streamed).toContain('chunk-one')
    expect(streamed).toContain('chunk-two')

    // Give the final session/update notification a turn to flush through
    // handleEvent before detach() releases the connection (the prompt
    // resolves before the last text frame is necessarily processed).
    await new Promise<void>((resolve) => setTimeout(resolve, 10))
    // detach() returns the live session id and releases the connection.
    const sessionId = await backend.detach()
    expect(typeof sessionId).toBe('string')
    // close() is idempotent and never throws.
    await backend.close()
    await backend.close()
  })

  test('rejects a run after close()', async () => {
    const backend = new AcpRemoteBackend({
      kind: 'socket',
      socketPath: join(dir, 'none.sock'),
      token: 't',
    })
    await backend.close()
    const result = await backend.run({ agent: 'base', prompt: 'x' })
    expect(result.output.type).toBe('error')
  })
})
