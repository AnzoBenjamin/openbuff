import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { connect } from 'node:net'
import type { Socket } from 'node:net'
import { Readable, Writable } from 'node:stream'

import {
  ClientSideConnection,
  PROTOCOL_VERSION,
  ndJsonStream,
} from '@agentclientprotocol/sdk'
import type {
  Client,
  SessionNotification,
  SessionUpdate,
  StopReason,
} from '@agentclientprotocol/sdk'

import type { ClientBackend } from './backend'
import type { OpenbuffClientOptions, RunOptions } from '../run'
import type { RunState } from '../run-state'
import type { ToolResultOutput } from '@codebuff/common/types/messages/content-part'
import type { JSONValue } from '@codebuff/common/types/json'
import type { PrintModeEvent } from '@codebuff/common/types/print-mode'

/** Handle the host calls {@link AcpRemoteBackend.run} with; kept alive across detach/reattach. Exported for tests. */
export type ActiveRun = {
  options: RunOptions & OpenbuffClientOptions
  /** Text deltas accumulated for the turn's `lastMessage` output fallback. */
  text: string
  /** Aggregate cost observed from `usage_update` payloads for the finish event. */
  totalCost: number
  /** toolCallId → toolName, so tool_call_update can recover a tool result's name. */
  toolNames: Map<string, string>
  /** toolCallId → last observed status, so a pending card becomes tool_start first. */
  statuses: Map<string, string>
}

/** JSON-RPC error surface we read the `openbuff.dev` message out of. */
type RpcErrorLike = {
  code?: unknown
  message?: unknown
  data?: unknown
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isRpcErrorLike(error: unknown): error is RpcErrorLike {
  return (
    typeof error === 'object' &&
    error !== null &&
    typeof (error as RpcErrorLike).code === 'number'
  )
}

/**
 * Extracts the terminal error message the serve bridge attaches at
 * `data["openbuff.dev"].message` (printModeErrorToRpcError, §4.2), falling
 * back to the generic JSON-RPC message.
 */
function rpcErrorMessage(error: unknown): string {
  if (isRpcErrorLike(error)) {
    const data = error.data
    if (isRecord(data)) {
      const scoped = data['openbuff.dev']
      if (isRecord(scoped) && typeof scoped.message === 'string') {
        return scoped.message
      }
    }
    if (typeof error.message === 'string') return error.message
  }
  return error instanceof Error ? error.message : String(error)
}

/** The `content[]` texts of a tool_call_update, joined into one result blob. */
function toolCallUpdateContentText(update: Record<string, unknown>): string {
  const content = update.content
  if (!Array.isArray(content)) return ''
  const texts: string[] = []
  for (const part of content) {
    // ACP `tool_call_update` content items are wrapped ToolCallContent:
    // `{ type: 'content', content: <ContentBlock> }` — the ContentBlock
    // carries the actual `{ type: 'text', text }`. (The unwrapped
    // `{ type: 'text' }` form is not a valid tool_call_update item.)
    if (isRecord(part) && part.type === 'content') {
      const inner = part.content
      if (
        isRecord(inner) &&
        inner.type === 'text' &&
        typeof inner.text === 'string'
      ) {
        texts.push(inner.text)
      }
    }
  }
  return texts.join('\n')
}

/**
 * Maps one ACP `session/update` payload back onto zero or more
 * `PrintModeEvent`-shaped events (the inverse of the serve bridge's §4.2
 * printModeToSessionUpdates). Covers every variant the TUI consumes: text
 * chunks (`agent_message_chunk`), reasoning (`agent_thought_chunk`), tool
 * cards (`tool_call`/`tool_call_update`), errors (surfaced as prompt
 * rejections, not updates), and `usage_update` cost → `finish`.
 *
 * The mapping is best-effort: payloads that carry no forwardable state (plan,
 * current_mode_update, other sessions' notifications) emit nothing.
 */
export function acpSessionUpdateToPrintModeEvents(
  update: SessionUpdate,
  run: ActiveRun,
): PrintModeEvent[] {
  if (!isRecord(update)) return []
  const events: PrintModeEvent[] = []
  switch (update.sessionUpdate) {
    case 'agent_message_chunk': {
      const content = (update as { content?: unknown }).content
      if (
        isRecord(content) &&
        content.type === 'text' &&
        typeof content.text === 'string'
      ) {
        run.text += content.text
        events.push({ type: 'text', text: content.text })
      }
      break
    }
    case 'agent_thought_chunk': {
      const content = (update as { content?: unknown }).content
      if (
        isRecord(content) &&
        content.type === 'text' &&
        typeof content.text === 'string'
      ) {
        events.push({
          type: 'reasoning_delta',
          text: content.text,
          runId: '',
          ancestorRunIds: [],
        })
      }
      break
    }
    case 'tool_call': {
      const toolCallId = (update as { toolCallId?: unknown }).toolCallId
      if (typeof toolCallId !== 'string') break
      const title = (update as { title?: unknown }).title
      const rawInput = (update as { rawInput?: unknown }).rawInput
      // The serve bridge maps toolName onto the ACP `title` field (the
      // schema's `name` is optional and the bridge does not set it), so the
      // reverse mapping recovers the tool name from `title`.
      const toolName = typeof title === 'string' ? title : 'unknown'
      run.toolNames.set(toolCallId, toolName)
      run.statuses.set(toolCallId, 'pending')
      events.push({
        type: 'tool_call',
        toolCallId,
        toolName,
        input: isRecord(rawInput) ? rawInput : {},
      })
      break
    }
    case 'tool_call_update': {
      const toolCallId = (update as { toolCallId?: unknown }).toolCallId
      if (typeof toolCallId !== 'string') break
      const status = (update as { status?: unknown }).status
      const toolName = run.toolNames.get(toolCallId) ?? 'unknown'
      if (status === 'in_progress') {
        // A pending card now running maps to the tool_start edge.
        if (run.statuses.get(toolCallId) === 'pending') {
          events.push({ type: 'tool_start', toolCallId })
        }
        run.statuses.set(toolCallId, 'in_progress')
        break
      }
      if (status === 'completed' || status === 'failed') {
        run.statuses.set(toolCallId, status)
        const text = toolCallUpdateContentText(
          update as Record<string, unknown>,
        )
        const value =
          status === 'failed' ? { errorMessage: text } : { message: text }
        const output: ToolResultOutput[] = [
          { type: 'json', value: value as unknown as JSONValue },
        ]
        events.push({
          type: 'tool_result',
          toolCallId,
          toolName,
          output,
        })
      }
      break
    }
    case 'usage_update': {
      const cost = (update as { cost?: unknown }).cost
      if (isRecord(cost) && typeof cost.amount === 'number') {
        run.totalCost += cost.amount
      }
      break
    }
    default:
      // plan / current_mode_update / available_commands_update / ... carry no
      // PrintModeEvent the TUI consumes from a remote turn.
      break
  }
  return events
}

/** Opens the unix socket and writes the SEC-4 auth line as its FIRST bytes. */
function connectSocketWithAuth(
  socketPath: string,
  token: string,
  timeoutMs: number,
): Promise<Socket> {
  return new Promise((resolvePromise, rejectPromise) => {
    let settled = false
    const socket = connect(socketPath)
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      socket.destroy()
      rejectPromise(
        new Error(`Timed out connecting to openbuff serve at ${socketPath}`),
      )
    }, timeoutMs)
    // Never let the connect timeout keep the process alive on its own.
    timer.unref?.()
    socket.once('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      rejectPromise(error)
    })
    socket.once('connect', () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      // SEC-4: exactly one auth line, then ACP ndJson framing on the same
      // socket (mirrors serveAcpOverSocket's documented client contract).
      socket.write(
        `${JSON.stringify({ type: 'openbuff.serve.auth', token })}\n`,
        () => resolvePromise(socket),
      )
    })
  })
}

/**
 * The ACP-remote client backend (P1-T3): drives a running `openbuff serve`
 * agent over ACP instead of the in-process runtime.
 *
 * Transport (unix-socket ONLY, or a spawned stdio child — never TCP):
 * - `{ kind: 'socket', socketPath, token }` connects to the SEC-4 listener
 *   and presents the token as its first line, exactly as
 *   `serveAcpOverSocket` expects.
 * - `{ kind: 'stdio', command, args? }` spawns `openbuff serve --stdio` and
 *   speaks ACP over the child's stdin/stdout.
 * - Tests may inject `{ kind: 'stream', stream }` to skip transport setup.
 *
 * Event surface: the host's `handleEvent` receives the SAME `PrintModeEvent`
 * shapes the in-process client emits — the backend maps ACP `session/update`
 * notifications back (text chunks, tool_call/tool_start/tool_result,
 * reasoning, finish, error), so a host sees an identical event stream.
 *
 * Detach/reattach: {@link detach} releases the connection WITHOUT cancelling
 * the session (the agent keeps working) and returns the live session id;
 * {@link attach} reconnects and `session/load`s it. {@link close} is
 * idempotent and releases the transport so no socket leaks.
 */
export class AcpRemoteBackend implements ClientBackend {
  private connection: ClientSideConnection | undefined
  private sessionId: string | undefined
  private cwd: string | undefined
  private initialized = false
  private activeRun: ActiveRun | undefined
  private closed = false
  /** Held across detach so reattach() can resume the same live session. */
  private detachedSessionId: string | undefined
  /** Owned stdio child (spawned by this backend), killed on close. */
  private ownedChild: ChildProcess | undefined
  /** Owned unix socket, destroyed on close. */
  private ownedSocket: Socket | undefined

  constructor(
    private readonly transport:
      | { kind: 'socket'; socketPath: string; token: string; timeoutMs?: number }
      | { kind: 'stdio'; command: string; args?: string[] }
      | { kind: 'stream'; stream: import('@agentclientprotocol/sdk').Stream },
  ) {}

  private async ensureConnection(): Promise<ClientSideConnection> {
    if (this.connection) return this.connection
    const stream = await this.openStream()
    const client: Client = {
      sessionUpdate: async (params: SessionNotification) => {
        this.onSessionUpdate(params)
      },
      // The serve bridge never issues these for a remote run; fail closed and
      // cheaply rather than pretending the client can service them.
      requestPermission: async () => {
        throw new Error(
          'requestPermission is not supported by the ACP-remote backend',
        )
      },
    }
    this.connection = new ClientSideConnection(() => client, stream)
    return this.connection
  }

  private async openStream(): Promise<
    import('@agentclientprotocol/sdk').Stream
  > {
    const transport = this.transport
    if (transport.kind === 'stream') {
      return transport.stream
    }
    if (transport.kind === 'socket') {
      const socket = await connectSocketWithAuth(
        transport.socketPath,
        transport.token,
        transport.timeoutMs ?? 5_000,
      )
      this.ownedSocket = socket
      return ndJsonStream(
        Writable.toWeb(socket) as unknown as WritableStream<Uint8Array>,
        Readable.toWeb(socket) as unknown as ReadableStream<Uint8Array>,
      )
    }
    const child = spawn(transport.command, transport.args ?? [], {
      stdio: ['pipe', 'pipe', 'inherit'],
    })
    this.ownedChild = child
    // stdio:['pipe','pipe','inherit'] pipes stdin/stdout (the ACP wire) while
    // inheriting the parent's stderr, so a spawned `openbuff serve --stdio`
    // child's diagnostics never pollute the parent's stdout.
    if (!child.stdin || !child.stdout) {
      throw new Error(
        'Failed to open stdio pipes to the spawned openbuff serve child process.',
      )
    }
    return ndJsonStream(
      Writable.toWeb(child.stdin) as unknown as WritableStream<Uint8Array>,
      Readable.toWeb(child.stdout) as unknown as ReadableStream<Uint8Array>,
    )
  }

  private onSessionUpdate(params: SessionNotification): void {
    const run = this.activeRun
    if (!run) return
    // Only consume updates for the session this run is bound to.
    if (params.sessionId !== this.sessionId) return
    const events = acpSessionUpdateToPrintModeEvents(params.update, run)
    for (const event of events) {
      void run.options.handleEvent?.(event)
    }
  }

  private buildErrorRunState(message: string): RunState {
    return {
      sessionState: undefined,
      output: { type: 'error', message },
    }
  }

  /**
   * Runs one prompt turn against the remote session. Lazily performs the ACP
   * handshake (initialize → session/new or session/load on reattach) and maps
   * the streamed session/update notifications onto the host's handleEvent.
   */
  async run(options: RunOptions & OpenbuffClientOptions): Promise<RunState> {
    if (this.closed) {
      return this.buildErrorRunState('The ACP-remote backend is closed.')
    }
    const cwd = options.cwd ?? this.cwd ?? process.cwd()
    this.cwd = cwd
    const connection = await this.ensureConnection()
    try {
      if (!this.initialized) {
        await connection.initialize({ protocolVersion: PROTOCOL_VERSION })
        this.initialized = true
      }
      if (!this.sessionId) {
        if (this.detachedSessionId) {
          await connection.loadSession({
            sessionId: this.detachedSessionId,
            cwd,
            mcpServers: [],
          })
          this.sessionId = this.detachedSessionId
          this.detachedSessionId = undefined
        } else {
          const created = await connection.newSession({ cwd, mcpServers: [] })
          this.sessionId = created.sessionId
        }
      }

      // Captured as a narrowed const so the prompt/cancel calls below are
      // bound to THIS turn's session regardless of any concurrent detach().
      const sessionId = this.sessionId
      const runState: ActiveRun = {
        options,
        text: '',
        totalCost: 0,
        toolNames: new Map(),
        statuses: new Map(),
      }
      this.activeRun = runState
      // Map the host's AbortSignal onto ACP `session/cancel` so a cancelled
      // run stops the remote turn (the serve bridge resolves it with the
      // 'cancelled' stop reason).
      const signal = options.signal
      const onAbort = (): void => {
        void connection.cancel({ sessionId }).catch(() => {})
      }
      if (signal?.aborted) {
        onAbort()
      } else {
        signal?.addEventListener('abort', onAbort, { once: true })
      }
      try {
        const response = await connection.prompt({
          sessionId,
          prompt: [{ type: 'text', text: options.prompt }],
        })
        const stopReason: StopReason = response.stopReason
        if (stopReason === 'cancelled') {
          return this.buildErrorRunState('Run cancelled by user.')
        }
        await options.handleEvent?.({
          type: 'finish',
          totalCost: runState.totalCost,
        })
        return {
          sessionState: undefined,
          // `lastMessage.value` is an array of assistant/tool messages (AgentOutput).
          // The accumulated assistant text is delivered as a single text part.
          output: {
            type: 'lastMessage',
            value: runState.text ? [{ type: 'text', text: runState.text }] : [],
          },
        }
      } finally {
        signal?.removeEventListener('abort', onAbort)
        this.activeRun = undefined
      }
    } catch (error) {
      const message = rpcErrorMessage(error)
      await options.handleEvent?.({ type: 'error', message })
      return this.buildErrorRunState(message)
    }
  }

  /** The live (or last detached) ACP session id, if one exists. */
  get currentSessionId(): string | undefined {
    return this.sessionId ?? this.detachedSessionId
  }

  /**
   * Detaches from the live session WITHOUT cancelling it: the connection is
   * released (no socket leak) while the remote agent keeps working, and the
   * session id is returned so a later attach() can resume it.
   */
  async detach(): Promise<string | undefined> {
    const sessionId = this.sessionId
    if (!sessionId) return undefined
    this.detachedSessionId = sessionId
    this.sessionId = undefined
    this.initialized = false
    await this.closeConnection()
    return sessionId
  }

  /** Reattaches to a previously detached session via `session/load`. */
  async attach(sessionId: string): Promise<void> {
    if (this.closed) {
      throw new Error('The ACP-remote backend is closed.')
    }
    this.detachedSessionId = sessionId
    const connection = await this.ensureConnection()
    await connection.initialize({ protocolVersion: PROTOCOL_VERSION })
    this.initialized = true
    await connection.loadSession({
      sessionId,
      cwd: this.cwd ?? process.cwd(),
      mcpServers: [],
    })
    this.sessionId = sessionId
    this.detachedSessionId = undefined
  }

  /** Idempotently releases the live connection (socket/stdio), never the session. */
  private async closeConnection(): Promise<void> {
    const connection = this.connection
    this.connection = undefined
    const socket = this.ownedSocket
    this.ownedSocket = undefined
    // ClientSideConnection's public surface is `closed: Promise<void>` (no
    // public close()); destroying the owned transport is what tears the
    // connection down and settles `closed`, so it must happen BEFORE the
    // await (awaiting `closed` before teardown would deadlock — nothing else
    // closes the connection).
    socket?.destroy()
    if (connection) {
      await Promise.resolve(connection.closed).catch(() => {})
    }
  }

  /** Releases the transport AND any owned child process. Idempotent. */
  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    await this.closeConnection()
    const child = this.ownedChild
    this.ownedChild = undefined
    child?.kill()
  }
}
