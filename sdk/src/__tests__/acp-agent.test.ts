import { describe, expect, test } from 'bun:test'

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

import { createAcpAgent } from '../services/acp/acp-agent'
import type {
  AcpPromptHandler,
  AcpSessionUpdateSink,
} from '../services/acp/acp-agent'

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

function makeAgentWithDefaultHandler(connection: AcpSessionUpdateSink) {
  return createAcpAgent({
    promptHandler: async () => ({ stopReason: 'end_turn' }),
    connection,
  })
}

describe('acp agent skeleton', () => {
  test('initialize reports the SDK protocol version and honest capabilities', async () => {
    const { connection } = makeRecordingConnection()
    const agent = makeAgentWithDefaultHandler(connection)

    const response = await agent.initialize({
      protocolVersion: PROTOCOL_VERSION,
    })

    expect(response.protocolVersion).toBe(PROTOCOL_VERSION)
    expect(response.agentCapabilities).toEqual({ loadSession: false })
    expect(response.authMethods).toEqual([])
  })

  test('newSession mints a fresh unique id per call', async () => {
    const { connection } = makeRecordingConnection()
    const agent = makeAgentWithDefaultHandler(connection)

    const first = await agent.newSession({
      cwd: '/tmp/openbuff-a',
      mcpServers: [],
    })
    const second = await agent.newSession({
      cwd: '/tmp/openbuff-b',
      mcpServers: [],
    })

    expect(typeof first.sessionId).toBe('string')
    expect(first.sessionId).not.toBe(second.sessionId)
  })

  test('prompt forwards text blocks and streams chunks through sessionUpdate', async () => {
    const { connection, updates } = makeRecordingConnection()
    const receivedText: string[] = []
    const promptHandler: AcpPromptHandler = async (input) => {
      receivedText.push(input.promptText)
      await input.update('chunk-1')
      await input.update('chunk-2')
      return { stopReason: 'end_turn' }
    }
    const agent = createAcpAgent({ promptHandler, connection })

    const { sessionId } = await agent.newSession({
      cwd: '/tmp/openbuff-c',
      mcpServers: [],
    })
    const response = await agent.prompt({
      sessionId,
      prompt: [
        { type: 'text', text: 'hello' },
        { type: 'audio', data: 'aGVsbG8=', mimeType: 'audio/wav' },
        { type: 'text', text: ' world' },
      ],
    })

    expect(receivedText).toEqual(['hello world'])
    expect(response).toEqual({ stopReason: 'end_turn' })
    expect(updates.map((update) => update.sessionId)).toEqual([
      sessionId,
      sessionId,
    ])
    expect(updates.map((update) => update.update)).toEqual([
      {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'chunk-1' },
      },
      {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'chunk-2' },
      },
    ])

    // A prompt with no text blocks at all forwards an empty string rather
    // than crashing or inventing content.
    await agent.prompt({
      sessionId,
      prompt: [{ type: 'audio', data: 'aGVsbG8=', mimeType: 'audio/wav' }],
    })
    expect(receivedText).toEqual(['hello world', ''])
  })

  test('prompt rejects with a JSON-RPC invalid-params error for an unknown session id', async () => {
    const { connection } = makeRecordingConnection()
    const agent = makeAgentWithDefaultHandler(connection)

    let failure: unknown
    try {
      await agent.prompt({
        sessionId: 'no-such-session',
        prompt: [{ type: 'text', text: 'hi' }],
      })
    } catch (error) {
      failure = error
    }

    expect(failure).toBeInstanceOf(RequestError)
    expect((failure as RequestError).code).toBe(-32602)
    // cancel for an unknown session is a silent no-op (notifications carry
    // no response), never a thrown error.
    expect(agent.cancel({ sessionId: 'no-such-session' })).toBeUndefined()
  })

  test('cancel aborts the in-flight prompt turn and resolves cancelled', async () => {
    const { connection } = makeRecordingConnection()
    const signals: AbortSignal[] = []
    const promptHandler: AcpPromptHandler = (input) => {
      signals.push(input.signal)
      return new Promise((resolve) => {
        input.signal.addEventListener('abort', () =>
          resolve({ stopReason: 'cancelled' }),
        )
      })
    }
    const agent = createAcpAgent({ promptHandler, connection })

    const { sessionId } = await agent.newSession({
      cwd: '/tmp/openbuff-cancel',
      mcpServers: [],
    })
    const pending = agent.prompt({
      sessionId,
      prompt: [{ type: 'text', text: 'long running turn' }],
    })
    agent.cancel({ sessionId })

    expect(await pending).toEqual({ stopReason: 'cancelled' })
    expect(signals.at(0)?.aborted).toBe(true)
  })

  test('serves a real ClientSideConnection over paired in-memory streams', async () => {
    // Two cross-wired TransformStreams form a full-duplex in-memory Stream
    // pair: whatever the agent side writes lands in the client side's
    // readable and vice versa, so the SDK's own wire framing is exercised
    // without stdio.
    const agentToClient = new TransformStream<AnyMessage, AnyMessage>()
    const clientToAgent = new TransformStream<AnyMessage, AnyMessage>()
    const agentStream: Stream = {
      writable: agentToClient.writable,
      readable: clientToAgent.readable,
    }
    const clientStream: Stream = {
      writable: clientToAgent.writable,
      readable: agentToClient.readable,
    }

    const updates: SessionNotification[] = []
    const fakeClient: Client = {
      requestPermission: async () => {
        throw new Error('requestPermission must not be called by the skeleton')
      },
      sessionUpdate: async (params) => {
        updates.push(params)
      },
    }
    const promptHandler: AcpPromptHandler = async (input) => {
      await input.update('wire-chunk')
      return { stopReason: 'end_turn' }
    }

    void new AgentSideConnection(
      (conn) => createAcpAgent({ promptHandler, connection: conn }),
      agentStream,
    )
    const client = new ClientSideConnection(() => fakeClient, clientStream)

    const initialized = await client.initialize({
      protocolVersion: PROTOCOL_VERSION,
    })
    expect(initialized.protocolVersion).toBe(PROTOCOL_VERSION)
    expect(initialized.agentCapabilities).toEqual({ loadSession: false })

    const session = await client.newSession({
      cwd: '/tmp/openbuff-wire',
      mcpServers: [],
    })
    const response = await client.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: 'text', text: 'hello over the wire' }],
    })

    expect(response).toEqual({ stopReason: 'end_turn' })
    await waitFor(() => updates.length > 0)
    expect(updates.at(0)?.sessionId).toBe(session.sessionId)
    expect(updates.at(0)?.update).toEqual({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'wire-chunk' },
    })
  })
})
