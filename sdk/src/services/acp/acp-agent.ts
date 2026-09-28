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
  CreateTerminalRequest,
  CreateTerminalResponse,
  InitializeRequest,
  InitializeResponse,
  LoadSessionRequest,
  LoadSessionResponse,
  McpServer,
  NewSessionRequest,
  NewSessionResponse,
  PromptRequest,
  PromptResponse,
  ReadTextFileRequest,
  ReadTextFileResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionNotification,
  WriteTextFileRequest,
} from '@agentclientprotocol/sdk'

import { ACP_EXTENSION_METHODS, acpExtensionSchemas } from './extensions'
import type { AcpExtensionMethod } from './extensions'
import type { AcpSessionData } from './session-data'

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
  /**
   * The client-advertised MCP servers for this session (from
   * newSession/loadSession), forwarded so the P1-T2 bridge can mark them
   * untrusted ('client' origin) at ingest before any run attaches them.
   */
  mcpServers?: McpServer[]
  /**
   * Optional client-side reverse-request seam (P1-T2 binds it to the
   * connection): lets a turn request permission, read/write files in the
   * client's workspace, or create a terminal mid-prompt.
   */
  reverseRequests?: AcpReverseRequests
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

/**
 * The client-side reverse-request surface a prompt turn may need. The P1-T2
 * bridge binds these to the SDK's `AgentSideConnection` methods so a prompt
 * handler can request permission, touch the client filesystem, or spawn a
 * terminal while the turn is in flight. Optional everywhere so tests can
 * omit it.
 */
export type AcpReverseRequests = {
  requestPermission(
    params: RequestPermissionRequest,
  ): Promise<RequestPermissionResponse>
  readTextFile(params: ReadTextFileRequest): Promise<ReadTextFileResponse>
  writeTextFile(params: WriteTextFileRequest): Promise<void>
  createTerminal(
    params: CreateTerminalRequest,
  ): Promise<CreateTerminalResponse>
}

export type AcpAgentOptions = {
  /** Required by design: there is no default prompt handler to hide behind. */
  promptHandler: AcpPromptHandler
  /** Where streamed agent message chunks are delivered (the client side). */
  connection: AcpSessionUpdateSink
  /** Human-readable name for P1-T2 logging; consumed by the serve bridge. */
  clientNameForLogging?: string
  /**
   * Optional resume path for `session/load`: restores external state for a
   * previously created session id. Absent means `session/load` fails closed
   * with a JSON-RPC method-not-found error.
   */
  loadHandler?: (input: { sessionId: string }) => Promise<void>
  /**
   * Optional reverse-request seam forwarded into the prompt handler's input;
   * the P1-T2 bridge binds it to AgentSideConnection's requestPermission,
   * readTextFile, writeTextFile, and createTerminal.
   */
  reverseRequests?: AcpReverseRequests
  /**
   * Optional dispatcher for Openbuff ACP extension methods (see
   * ACP_EXTENSION_METHODS in ./extensions). Absent means every extension
   * request fails with a JSON-RPC method-not-found error.
   */
  extensionHandler?: (input: {
    method: string
    params: unknown
  }) => Promise<unknown>
  /**
   * Optional bounded per-session live-data store backing the read-only
   * Openbuff extension methods ('openbuff/getReceipts' and
   * 'openbuff/gateState') when no extensionHandler is injected. The P1-T2
   * run loop records real receipts and published gate-state blocks here.
   * An explicitly injected extensionHandler still wins (back-compat), and
   * methods with no store fallback (askUser) still fail closed.
   */
  sessionData?: AcpSessionData
}

/** Per-session state kept for later phases (P1-T2 core-run wiring). */
type AcpSessionState = {
  cwd: string
  mcpServers: McpServer[]
  abortController: AbortController | null
}

/**
 * The concrete agent surface returned by createAcpAgent: the SDK Agent
 * interface with the optional methods this skeleton actually implements
 * (session/load and legacy extMethod) pinned as required, so callers and
 * tests can invoke them directly while staying assignable to `Agent`.
 */
export type AcpAgent = Agent & {
  loadSession(params: LoadSessionRequest): Promise<LoadSessionResponse>
  extMethod(
    method: string,
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>>
}

/**
 * Builds the agent-side ACP v1 skeleton:
 * initialize/newSession/loadSession/prompt/cancel over a private session
 * map, plus the Openbuff extension surface (extMethod) and the
 * reverse-request seam for prompt turns. The prompt handler and update sink
 * are injected so the real core run (P1-T2) stays out of the protocol layer.
 */
export function createAcpAgent(options: AcpAgentOptions): AcpAgent {
  const sessions = new Map<string, AcpSessionState>()

  return {
    initialize(_params: InitializeRequest): InitializeResponse {
      // Mirror the declared InitializeResponse exactly: the version comes from
      // the SDK constant (never hardcoded), and loadSession is honestly true
      // now that session/load is implemented below.
      return {
        protocolVersion: PROTOCOL_VERSION,
        agentCapabilities: { loadSession: true },
        authMethods: [],
      }
    },

    async loadSession(
      params: LoadSessionRequest,
    ): Promise<LoadSessionResponse> {
      if (!options.loadHandler) {
        // session/load is advertised, but no resume path was injected: fail
        // closed with a JSON-RPC method-not-found error rather than silently
        // half-loading the session.
        throw RequestError.methodNotFound('session/load')
      }
      // Register in the same private map newSession uses so subsequent
      // prompt/cancel calls work against the loaded session id.
      sessions.set(params.sessionId, {
        cwd: params.cwd,
        mcpServers: params.mcpServers,
        abortController: null,
      })
      await options.loadHandler({ sessionId: params.sessionId })
      // LoadSessionResponse's fields (modes/configOptions/_meta) are all
      // optional per the SDK declarations; this skeleton restores no mode
      // state, so the exact empty response shape is the honest reply.
      return {}
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
        mcpServers: session.mcpServers,
        reverseRequests: options.reverseRequests,
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

    async extMethod(
      method: string,
      params: Record<string, unknown>,
    ): Promise<Record<string, unknown>> {
      if (!ACP_EXTENSION_METHODS.includes(method as AcpExtensionMethod)) {
        // Unknown extension methods fail closed as JSON-RPC method-not-found.
        throw RequestError.methodNotFound(method)
      }
      const { params: paramsSchema } =
        acpExtensionSchemas[method as AcpExtensionMethod]
      const parsed = paramsSchema.safeParse(params)
      if (!parsed.success) {
        throw RequestError.invalidParams(
          params,
          `Invalid params for ACP extension '${method}': ${parsed.error.issues
            .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
            .join('; ')}`,
        )
      }
      // An explicitly injected handler wins for every method (back-compat
      // with the static-data seam tests rely on).
      if (options.extensionHandler) {
        const result = await options.extensionHandler({
          method,
          params: parsed.data,
        })
        if (
          result === null ||
          typeof result !== 'object' ||
          Array.isArray(result)
        ) {
          // The Agent.extMethod contract returns a JSON object response; a
          // non-object handler result would corrupt the wire, so fail closed.
          throw RequestError.internalError(
            { method },
            `ACP extension handler for '${method}' returned a non-object response.`,
          )
        }
        return result as Record<string, unknown>
      }
      // Without an injected handler, the two read-only extension methods
      // read the live per-session store. The params schema above already
      // guaranteed sessionId (and the optional limit), so the narrowing
      // below is schema-backed.
      if (options.sessionData && method === 'openbuff/getReceipts') {
        const { sessionId, limit } = parsed.data as {
          sessionId: string
          limit?: number
        }
        return options.sessionData.getReceipts(sessionId, limit)
      }
      if (options.sessionData && method === 'openbuff/gateState') {
        const { sessionId } = parsed.data as { sessionId: string }
        return options.sessionData.getGateState(sessionId)
      }
      // 'openbuff/askUser' (and any other method with no store fallback)
      // has nothing to answer it: fail closed as method-not-found.
      throw RequestError.methodNotFound(method)
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
 * Derives the serve-time agent options, auto-wiring `session/load` restore
 * from an injected journal-backed store. When `sessionData` is present and no
 * `loadHandler` was supplied, the returned options carry a derived
 * loadHandler that replays the durable journal
 * (`AcpSessionData.restoreFromJournal`) so a restored session recovers its
 * receipt history and last gate-state snapshot. A bridge that wants no
 * restore simply omits `sessionData` or supplies its own `loadHandler` (a
 * caller-provided loadHandler always wins). The input object is never
 * mutated: a new object is built only in the derive branch, otherwise the
 * input is returned unchanged.
 */
export function resolveAcpServeOptions(
  options: Omit<AcpAgentOptions, 'connection'>,
): Omit<AcpAgentOptions, 'connection'> {
  if (!options.sessionData || options.loadHandler) {
    return options
  }
  // Capture the store in a local const so the derived handler closes over the
  // value observed here, not a later-cleared field on `options`.
  const sessionData = options.sessionData
  return {
    ...options,
    loadHandler: async ({ sessionId }) => {
      // restoreFromJournal is best-effort and returns a boolean we ignore:
      // loadSession's own success is independent of whether a journal existed.
      await sessionData.restoreFromJournal(sessionId)
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
  // Auto-derive the session/load restore handler from an injected journal-
  // backed store once, then reuse it for every connection's agent.
  const resolvedOptions = resolveAcpServeOptions(options)
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
    (conn) => createAcpAgent({ ...resolvedOptions, connection: conn }),
    stream,
  )
}
