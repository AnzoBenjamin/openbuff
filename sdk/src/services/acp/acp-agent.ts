import { randomUUID } from 'node:crypto'
import { Readable, Writable } from 'node:stream'

import {
  AgentSideConnection,
  PROTOCOL_VERSION,
  RequestError,
  ndJsonStream,
} from '@agentclientprotocol/sdk'
import type {
  Agent,
  CancelNotification,
  InitializeRequest,
  InitializeResponse,
  McpServer,
  NewSessionRequest,
  NewSessionResponse,
  PromptRequest,
  PromptResponse,
  SessionNotification,
} from '@agentclientprotocol/sdk'

/**
 * The injectable seam P1-T2 binds to the real core run: the ACP skeleton owns
 * the protocol surface while the handler owns turn execution and streaming.
 * The handler reports its own terminal state so a cancelled turn (via the
 * abort signal) and a naturally finished turn are both explicit.
 */
export type AcpPromptHandler = (input: {
  sessionId: string
  promptText: string
  update: (chunkText: string) => Promise<void>
  signal: AbortSignal
}) => Promise<{ stopReason: 'end_turn' | 'cancelled' }>

/**
 * The slice of the ACP connection the agent needs: pushing `session/update`
 * notifications to the client. Structurally satisfied by the SDK's
 * `AgentSideConnection` and trivially fakeable in tests, so prompt streaming
 * stays testable without a transport.
 */
export type AcpSessionUpdateSink = {
  sessionUpdate(params: SessionNotification): Promise<void>
}

export type AcpAgentOptions = {
  /** Required by design: there is no default prompt handler to hide behind. */
  promptHandler: AcpPromptHandler
  /** Where streamed agent message chunks are delivered (the client side). */
  connection: AcpSessionUpdateSink
  /** Human-readable name for P1-T2 logging; consumed by the serve bridge. */
  clientNameForLogging?: string
}

/** Per-session state kept for later phases (P1-T2 core-run wiring). */
type AcpSessionState = {
  cwd: string
  mcpServers: McpServer[]
  abortController: AbortController | null
}

/**
 * Builds the agent-side ACP v1 skeleton: initialize/newSession/prompt/cancel
 * over a private session map. The prompt handler and update sink are injected
 * so the real core run (P1-T2) stays out of the protocol layer.
 */
export function createAcpAgent(options: AcpAgentOptions): Agent {
  const sessions = new Map<string, AcpSessionState>()

  return {
    initialize(_params: InitializeRequest): InitializeResponse {
      // Mirror the declared InitializeResponse exactly: the version comes from
      // the SDK constant (never hardcoded), and loadSession is honestly false
      // because this skeleton does not implement session/load.
      return {
        protocolVersion: PROTOCOL_VERSION,
        agentCapabilities: { loadSession: false },
        authMethods: [],
      }
    },

    newSession(params: NewSessionRequest): NewSessionResponse {
      const sessionId = randomUUID()
      sessions.set(sessionId, {
        cwd: params.cwd,
        mcpServers: params.mcpServers,
        abortController: null,
      })
      return { sessionId }
    },

    async prompt(params: PromptRequest): Promise<PromptResponse> {
      const session = sessions.get(params.sessionId)
      if (!session) {
        // A real JSON-RPC invalid-params error (not a bare Error) so clients
        // see a protocol-appropriate failure for an unknown session id.
        throw RequestError.invalidParams(
          { sessionId: params.sessionId },
          `Unknown ACP session id '${params.sessionId}'.`,
        )
      }
      // One AbortController per prompt turn: `cancel` aborts the turn in
      // flight, and the next prompt replaces the controller.
      const abortController = new AbortController()
      session.abortController = abortController
      // The baseline contract here only needs text: concatenate the
      // `type === 'text'` blocks and let the injected handler decide what to
      // do with richer blocks (images, resources) in later phases.
      const promptText = params.prompt
        .flatMap((block) => (block.type === 'text' ? [block.text] : []))
        .join('')
      const result = await options.promptHandler({
        sessionId: params.sessionId,
        promptText,
        update: async (chunkText) => {
          await options.connection.sessionUpdate({
            sessionId: params.sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: chunkText },
            },
          })
        },
        signal: abortController.signal,
      })
      return { stopReason: result.stopReason }
    },

    cancel(params: CancelNotification): void {
      // Notifications carry no response, so an unknown session id is a no-op
      // here rather than an error surface.
      sessions.get(params.sessionId)?.abortController?.abort()
    },

    // The Agent interface requires authenticate even though this skeleton
    // advertises no auth methods; a client that calls it anyway gets a clear
    // protocol error instead of a silent success.
    authenticate(): never {
      throw RequestError.invalidParams(
        {},
        'ACP authentication is not supported by this agent.',
      )
    },
  }
}

/**
 * Serves the agent over line-delimited JSON on stdio. Only call from a real
 * CLI entry (P1-T2 owns `openbuff serve`); it stays importable so the wiring
 * remains reviewable while the Agent object above stays testable.
 */
export function serveAcpOverStdio(
  options: Omit<AcpAgentOptions, 'connection'>,
): void {
  // ndJsonStream(output, input): the agent's stdout is the output wire and its
  // stdin is the input wire. Node/Bun streams are converted to their web
  // counterparts because the SDK's Stream type is defined over web streams;
  // the cast bridges the node-vs-DOM WritableStream typing duality.
  const stream = ndJsonStream(
    Writable.toWeb(process.stdout) as unknown as WritableStream<Uint8Array>,
    Readable.toWeb(process.stdin) as unknown as ReadableStream<Uint8Array>,
  )
  // AgentSideConnection is marked @deprecated in favor of the `agent()` app
  // builder, but it is the canonical direct wire surface and stable for this
  // skeleton. The connection lives for the lifetime of the process; the CLI
  // entry keeps running until the underlying stream closes.
  void new AgentSideConnection(
    (conn) => createAcpAgent({ ...options, connection: conn }),
    stream,
  )
}
