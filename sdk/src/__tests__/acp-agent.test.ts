import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  AgentSideConnection,
  ClientSideConnection,
  PROTOCOL_VERSION,
  RequestError,
} from '@agentclientprotocol/sdk'
import type {
  AnyMessage,
  Client,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionNotification,
  Stream,
} from '@agentclientprotocol/sdk'

import type {
  FileMutationResultV1,
} from '@codebuff/common/tools/results/filesystem'
import {
  getContentHash,
  getExactContentHash,
} from '@codebuff/common/util/content-hash'

import {
  createAcpAgent,
  resolveAcpServeOptions,
} from '../services/acp/acp-agent'
import type {
  AcpAgentOptions,
  AcpPromptHandler,
  AcpReverseRequests,
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
    // A plain ACP client (no clientCapabilities._meta["openbuff.dev"]) gets
    // pure ACP: the §3.3 capabilities are advertised, but NO ext `_meta` is
    // echoed and `authMethods` stays empty (no terminal auth was offered).
    // Honest advertisement: nothing is listed that the agent does not
    // implement, so sessionCapabilities (session/list, session/close) is
    // absent entirely.
    expect(response.agentCapabilities).toEqual({
      loadSession: true,
      promptCapabilities: {
        image: false,
        audio: false,
        embeddedContext: false,
      },
      mcpCapabilities: { http: true, sse: true },
    })
    expect(response.agentCapabilities?._meta).toBeUndefined()
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
      (conn) =>
        createAcpAgent({
          promptHandler,
          connection: conn,
          extensionHandler: async () => ({
            phase: 'wire-phase',
            currentTask: null,
          }),
        }),
      agentStream,
    )
    const client = new ClientSideConnection(() => fakeClient, clientStream)

    const initialized = await client.initialize({
      protocolVersion: PROTOCOL_VERSION,
    })
    expect(initialized.protocolVersion).toBe(PROTOCOL_VERSION)
    // The wire path exercises a plain ACP client: no ext `_meta` is echoed.
    // sessionCapabilities is deliberately NOT advertised: this agent
    // implements neither session/list nor session/close, and a compliant
    // client that saw them advertised would call methods the wire layer
    // rejects with -32601.
    expect(initialized.agentCapabilities).toEqual({
      loadSession: true,
      promptCapabilities: {
        image: false,
        audio: false,
        embeddedContext: false,
      },
      mcpCapabilities: { http: true, sse: true },
    })

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

    // Extension methods ride the same JSON-RPC wire: params are validated
    // agent-side against the Zod contract before dispatch.
    const gate = await client.extMethod('openbuff/gateState', {
      sessionId: session.sessionId,
    })
    expect(gate).toEqual({ phase: 'wire-phase', currentTask: null })
  })

  test('loadSession fails closed with method-not-found when no loadHandler is injected', async () => {
    const { connection } = makeRecordingConnection()
    const agent = makeAgentWithDefaultHandler(connection)

    let failure: unknown
    try {
      await agent.loadSession({
        cwd: '/tmp/openbuff-a',
        mcpServers: [],
        sessionId: 'missing-session',
      })
    } catch (error) {
      failure = error
    }

    expect(failure).toBeInstanceOf(RequestError)
    expect((failure as RequestError).code).toBe(-32601)
  })

  test('loadSession registers the session so prompt/cancel work and replies with the declared shape', async () => {
    const { connection, updates } = makeRecordingConnection()
    const loadedSessions: string[] = []
    const promptHandler: AcpPromptHandler = async (input) => {
      await input.update('resumed')
      return { stopReason: 'end_turn' }
    }
    const agent = createAcpAgent({
      promptHandler,
      connection,
      loadHandler: async (input) => {
        loadedSessions.push(input.sessionId)
      },
    })

    const response = await agent.loadSession({
      cwd: '/tmp/openbuff-resume',
      mcpServers: [],
      sessionId: 'existing-session-id',
    })

    expect(loadedSessions).toEqual(['existing-session-id'])
    // LoadSessionResponse's fields are all optional per the SDK
    // declarations; the skeleton restores no mode state, so the exact empty
    // response shape is the honest reply.
    expect(response).toEqual({})

    // The loaded id now lives in the same private session map as
    // newSession: prompt streams through it and cancel is safe.
    const promptResult = await agent.prompt({
      sessionId: 'existing-session-id',
      prompt: [{ type: 'text', text: 'continue' }],
    })
    expect(promptResult).toEqual({ stopReason: 'end_turn' })
    expect(updates.at(0)?.sessionId).toBe('existing-session-id')
    expect(agent.cancel({ sessionId: 'existing-session-id' })).toBeUndefined()
  })

  test('extMethod validates params against the Zod contract and dispatches the injected handler', async () => {
    const { connection } = makeRecordingConnection()
    const dispatched: Array<{ method: string; params: unknown }> = []
    const agent = createAcpAgent({
      promptHandler: async () => ({ stopReason: 'end_turn' }),
      connection,
      extensionHandler: async (input) => {
        dispatched.push(input)
        if (input.method === 'openbuff/gateState') {
          return { phase: 'gated', currentTask: null }
        }
        return { answer: 'yes' }
      },
    })

    const gate = await agent.extMethod('openbuff/gateState', {
      sessionId: 's-1',
    })
    expect(gate).toEqual({ phase: 'gated', currentTask: null })

    const ask = await agent.extMethod('openbuff/askUser', {
      sessionId: 's-1',
      question: 'Proceed?',
      choices: ['yes', 'no'],
    })
    expect(ask).toEqual({ answer: 'yes' })

    expect(dispatched).toEqual([
      { method: 'openbuff/gateState', params: { sessionId: 's-1' } },
      {
        method: 'openbuff/askUser',
        params: {
          sessionId: 's-1',
          question: 'Proceed?',
          choices: ['yes', 'no'],
        },
      },
    ])

    // Invalid params fail closed as JSON-RPC invalid-params carrying the
    // Zod issue list.
    let invalidFailure: unknown
    try {
      await agent.extMethod('openbuff/askUser', { sessionId: 's-1' })
    } catch (error) {
      invalidFailure = error
    }
    expect(invalidFailure).toBeInstanceOf(RequestError)
    expect((invalidFailure as RequestError).code).toBe(-32602)
    expect((invalidFailure as RequestError).message).toContain(
      'openbuff/askUser',
    )

    // Unknown extension methods fail closed as method-not-found even with
    // a handler injected.
    let unknownFailure: unknown
    try {
      await agent.extMethod('other/unknown', {})
    } catch (error) {
      unknownFailure = error
    }
    expect(unknownFailure).toBeInstanceOf(RequestError)
    expect((unknownFailure as RequestError).code).toBe(-32601)
  })

  test('extMethod fails with method-not-found when no extension handler is injected', async () => {
    const { connection } = makeRecordingConnection()
    const agent = makeAgentWithDefaultHandler(connection)

    let failure: unknown
    try {
      await agent.extMethod('openbuff/getReceipts', { sessionId: 's-1' })
    } catch (error) {
      failure = error
    }
    expect(failure).toBeInstanceOf(RequestError)
    expect((failure as RequestError).code).toBe(-32601)
  })

  test('prompt threads the optional reverseRequests seam into the handler input', async () => {
    const { connection } = makeRecordingConnection()
    const seen: Array<unknown> = []
    const reverseRequests: AcpReverseRequests = {
      requestPermission: async () => {
        throw new Error('not exercised here')
      },
      readTextFile: async () => {
        throw new Error('not exercised here')
      },
      writeTextFile: async () => {
        throw new Error('not exercised here')
      },
      createTerminal: async () => {
        throw new Error('not exercised here')
      },
    }
    const promptHandler: AcpPromptHandler = async (input) => {
      seen.push(input.reverseRequests)
      return { stopReason: 'end_turn' }
    }
    const agent = createAcpAgent({
      promptHandler,
      connection,
      reverseRequests,
    })

    const { sessionId } = await agent.newSession({
      cwd: '/tmp/openbuff-rr',
      mcpServers: [],
    })
    await agent.prompt({
      sessionId,
      prompt: [{ type: 'text', text: 'hi' }],
    })

    expect(seen).toEqual([reverseRequests])
  })

  test('§5 production wiring: the connection client-method surface is derived into the per-turn reverseRequests seam', async () => {
    // Mirrors the real serve transports: the SDK AgentSideConnection passed
    // as `connection` exposes requestPermission/readTextFile/writeTextFile/
    // createTerminal, and createAcpAgent must derive the reverseRequests
    // seam from it when no explicit seam was injected (the `openbuff serve`
    // path — no host ever passes options.reverseRequests there).
    const permissionParams: RequestPermissionRequest[] = []
    const connection = {
      sessionUpdate: async () => {},
      requestPermission: async (params: RequestPermissionRequest) => {
        permissionParams.push(params)
        return {
          outcome: { outcome: 'selected', optionId: 'allow_once' },
        } as RequestPermissionResponse
      },
      readTextFile: async () => {
        throw new Error('not exercised here')
      },
      writeTextFile: async () => {
        throw new Error('not exercised here')
      },
      createTerminal: async () => {
        throw new Error('not exercised here')
      },
      request: async () => {
        throw new Error('not exercised here')
      },
      notify: async () => {},
    }
    const seen: Array<Parameters<AcpPromptHandler>[0]> = []
    const promptHandler: AcpPromptHandler = async (input) => {
      seen.push(input)
      return { stopReason: 'end_turn' }
    }
    const agent = createAcpAgent({ promptHandler, connection })

    const { sessionId } = await agent.newSession({
      cwd: '/tmp/openbuff-derive',
      mcpServers: [],
    })
    await agent.prompt({
      sessionId,
      prompt: [{ type: 'text', text: 'hi' }],
    })

    expect(seen).toHaveLength(1)
    const derived = seen[0]?.reverseRequests
    expect(derived).toBeDefined()
    // The derived seam is usable: it forwards onto the owning connection.
    const response = await derived!.requestPermission({
      sessionId,
      toolCall: { toolCallId: 't1', title: 'x', kind: 'execute' },
      options: [],
    })
    expect(response.outcome).toEqual({
      outcome: 'selected',
      optionId: 'allow_once',
    })
    expect(permissionParams).toHaveLength(1)
  })

  test('§5 fail-closed: a bare session-update sink derives NO reverseRequests seam', async () => {
    // The in-process/test-fake connection shape (no client-method surface)
    // must keep the pre-existing fail-closed posture: no seam is fabricated.
    const { connection } = makeRecordingConnection()
    const seen: Array<Parameters<AcpPromptHandler>[0]> = []
    const promptHandler: AcpPromptHandler = async (input) => {
      seen.push(input)
      return { stopReason: 'end_turn' }
    }
    const agent = createAcpAgent({ promptHandler, connection })

    const { sessionId } = await agent.newSession({
      cwd: '/tmp/openbuff-bare',
      mcpServers: [],
    })
    await agent.prompt({
      sessionId,
      prompt: [{ type: 'text', text: 'hi' }],
    })

    expect(seen).toHaveLength(1)
    expect(seen[0]?.reverseRequests).toBeUndefined()
  })

  test('§4.2: initialize captures the client elicitation.form capability and prompt forwards it', async () => {
    const connection = {
      sessionUpdate: async () => {},
      request: async () => {
        throw new Error('not exercised here')
      },
      notify: async () => {},
    }
    const seen: Array<Parameters<AcpPromptHandler>[0]> = []
    const promptHandler: AcpPromptHandler = async (input) => {
      seen.push(input)
      return { stopReason: 'end_turn' }
    }
    const agent = createAcpAgent({ promptHandler, connection })

    await agent.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {
        elicitation: { form: {} },
        _meta: {
          'openbuff.dev': {
            extVersion: 1,
            extensions: ['events'],
          },
        },
      },
    })

    const { sessionId } = await agent.newSession({
      cwd: '/tmp/openbuff-caps',
      mcpServers: [],
    })
    await agent.prompt({
      sessionId,
      prompt: [{ type: 'text', text: 'hi' }],
    })

    expect(seen).toHaveLength(1)
    expect(seen[0]?.clientCapabilities).toEqual({
      elicitation: { form: {} },
    })
    // The negotiated `events` extension gates the _openbuff.dev/ask_user path.
    expect(seen[0]?.eventsExtensionEnabled).toBe(true)
  })

  test('§4.2 fail-closed: no negotiated elicitation capability forwards no clientCapabilities', async () => {
    const { connection } = makeRecordingConnection()
    const seen: Array<Parameters<AcpPromptHandler>[0]> = []
    const promptHandler: AcpPromptHandler = async (input) => {
      seen.push(input)
      return { stopReason: 'end_turn' }
    }
    const agent = createAcpAgent({ promptHandler, connection })

    await agent.initialize({
      protocolVersion: PROTOCOL_VERSION,
    })

    const { sessionId } = await agent.newSession({
      cwd: '/tmp/openbuff-nocaps',
      mcpServers: [],
    })
    await agent.prompt({
      sessionId,
      prompt: [{ type: 'text', text: 'hi' }],
    })

    expect(seen).toHaveLength(1)
    expect(seen[0]?.clientCapabilities).toBeUndefined()
    expect(seen[0]?.eventsExtensionEnabled).toBeUndefined()
  })
})

const RESTORE_CONTENT = 'export const answer = 42\n'
const RESTORE_CAP_TOKEN =
  'cap.v3.1.2.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA.BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB'

/**
 * A real, schema-valid fully-applied mutation carrying the content-bearing
 * fields the wire projection drops, so the journal round-trip exercises the
 * same redaction path the store uses in production.
 */
function buildAppliedMutation(): FileMutationResultV1 {
  const afterHash = getExactContentHash(RESTORE_CONTENT)
  const lineCount = RESTORE_CONTENT.split('\n').length
  return {
    kind: 'file_mutation_result',
    version: 1,
    operationId: 'op-restore',
    outcome: 'applied',
    actions: [
      {
        actionId: 'act-restore',
        index: 0,
        action: 'create',
        path: 'src/restored.ts',
        outcome: 'applied',
        beforeHash: null,
        afterHash,
        afterContent: RESTORE_CONTENT,
        editAnchor: {
          startLine: 1,
          endLine: lineCount,
          contentHash: getContentHash(RESTORE_CONTENT),
          readCapability: RESTORE_CAP_TOKEN,
        },
      },
    ],
    authorityTier: 'conditional_commit',
    receiptId: 'r-restore',
    workspaceRevision: 3,
    workspaceSnapshotId: 'ws-1',
    authorityReceipt: {
      kind: 'commit_receipt',
      version: 1,
      receiptId: 'r-restore',
      operationId: 'op-restore',
      callId: 'call-1',
      authorityTier: 'conditional_commit',
      status: 'committed',
      actions: [
        {
          actionId: 'act-restore',
          index: 0,
          action: 'create',
          path: 'src/restored.ts',
          status: 'committed',
          beforeHash: null,
          afterHash,
        },
      ],
      finalHashes: { 'src/restored.ts': afterHash },
      workspaceRevision: 3,
      workspaceSnapshotId: 'ws-1',
    },
    errors: [],
    freshCapabilities: [
      {
        kind: 'whole_file',
        version: 1,
        token: RESTORE_CAP_TOKEN,
        snapshot: {
          kind: 'file_snapshot',
          version: 1,
          canonicalPath: 'src/restored.ts',
          contentHash: getContentHash(RESTORE_CONTENT),
          sizeBytes: new TextEncoder().encode(RESTORE_CONTENT).byteLength,
          encoding: 'utf8',
          readGeneration: 0,
        },
      },
    ],
  }
}

/** Serializes a gate payload exactly the way formatGateStateBlock does. */
function formatGateStateBlock(payload: Record<string, unknown>): string {
  return `<gate-state>${JSON.stringify(payload).replace(/<\//g, '<\\/')}</gate-state>`
}

describe('resolveAcpServeOptions', () => {
  test('returns the input unchanged when no sessionData is injected', () => {
    const options: Omit<AcpAgentOptions, 'connection'> = {
      promptHandler: async () => ({ stopReason: 'end_turn' }),
    }
    // No sessionData → no derivation, identity is fine.
    expect(resolveAcpServeOptions(options)).toBe(options)
    expect(resolveAcpServeOptions(options).loadHandler).toBeUndefined()
  })

  test('returns the input unchanged when a caller loadHandler is already set', () => {
    const callerLoadHandler = async () => {}
    const options: Omit<AcpAgentOptions, 'connection'> = {
      promptHandler: async () => ({ stopReason: 'end_turn' }),
      sessionData: new AcpSessionData(),
      loadHandler: callerLoadHandler,
    }
    // Caller-provided loadHandler always wins: never overwritten.
    const resolved = resolveAcpServeOptions(options)
    expect(resolved).toBe(options)
    expect(resolved.loadHandler).toBe(callerLoadHandler)
  })

  test('derives a loadHandler that replays the journal when only sessionData is set', async () => {
    const restored: string[] = []
    const sessionData = new AcpSessionData()
    // Observe the derived handler calls restoreFromJournal for the session id.
    ;(sessionData as { restoreFromJournal: (id: string) => Promise<boolean> }).restoreFromJournal =
      async (id: string) => {
        restored.push(id)
        return true
      }
    const options: Omit<AcpAgentOptions, 'connection'> = {
      promptHandler: async () => ({ stopReason: 'end_turn' }),
      sessionData,
    }

    const resolved = resolveAcpServeOptions(options)
    // A new object is built; the input is not mutated.
    expect(resolved).not.toBe(options)
    expect(options.loadHandler).toBeUndefined()
    expect(resolved.loadHandler).toBeInstanceOf(Function)
    expect(resolved.sessionData).toBe(sessionData)

    await resolved.loadHandler!({ sessionId: 's-derived' })
    expect(restored).toEqual(['s-derived'])
  })
})

describe('resolveAcpServeOptions load→restore integration', () => {
  const tempDirs: string[] = []

  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop()
      if (dir) rmSync(dir, { recursive: true, force: true })
    }
  })

  function makeJournalDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'acp-journal-'))
    tempDirs.push(dir)
    return dir
  }

  test('loadSession replays the durable journal so getReceipts/gateState recover', async () => {
    const journalDir = makeJournalDir()
    const sessionId = 'session-to-restore'

    // First store writes the durable journal for the session.
    const first = new AcpSessionData({ journalDir })
    first.recordReceipt(sessionId, buildAppliedMutation(), 'tool-1')
    first.updateGateStateFromBlock(
      sessionId,
      formatGateStateBlock({
        gate: 'validation/reviewer',
        status: 'passed',
        details: 'All gates passed.',
      }),
    )

    // The first store's journal writes are fire-and-forget; settle them by
    // polling the on-disk file directly (both the receipt and gate-state
    // lines) before the load path reads them back.
    const journalFile = join(journalDir, `${sessionId}.jsonl`)
    for (let attempt = 0; attempt < 200; attempt++) {
      const text = existsSync(journalFile) ? readFileSync(journalFile, 'utf8') : ''
      if (text.includes('"receipt_envelope"') && text.includes('"gate_state"')) {
        break
      }
      await new Promise((r) => setTimeout(r, 10))
    }
    // A fresh store starts empty; the derived loadHandler must replay the
    // settled journal it finds on disk.
    const loadStore = new AcpSessionData({ journalDir })

    const { connection } = makeRecordingConnection()
    const resolved = resolveAcpServeOptions({
      promptHandler: async () => ({ stopReason: 'end_turn' }),
      sessionData: loadStore,
    })
    const agent = createAcpAgent({ ...resolved, connection })

    // Empty before load.
    expect(
      (await agent.extMethod('openbuff/getReceipts', { sessionId }))
        .receipts,
    ).toEqual([])

    // session/load drives the derived loadHandler → restoreFromJournal.
    const response = await agent.loadSession({
      cwd: '/tmp/openbuff-restore',
      mcpServers: [],
      sessionId,
    })
    expect(response).toEqual({})

    const receipts = await agent.extMethod('openbuff/getReceipts', {
      sessionId,
    })
    expect(receipts).toEqual({
      receipts: [
        {
          operationId: 'op-restore',
          receiptId: 'r-restore',
          paths: ['src/restored.ts'],
          actionIds: ['act-restore'],
        },
      ],
    })

    const gate = await agent.extMethod('openbuff/gateState', { sessionId })
    expect(gate).toEqual({
      phase: 'final_response_allowed',
      currentTask: null,
    })
  })
})
