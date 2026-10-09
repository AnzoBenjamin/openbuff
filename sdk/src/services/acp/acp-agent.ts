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
  AgentCapabilities,
  AuthMethod,
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
  TerminalHandle,
  WriteTextFileRequest,
  WriteTextFileResponse,
} from '@agentclientprotocol/sdk'

import {
  OPENBUFF_ACP_EXT_VERSION,
  OPENBUFF_ACP_NS,
  receiptEnvelopeV1Schema,
} from '@codebuff/common/protocol/acp-ext-v1'
import type { CapabilityMapV1 } from '@codebuff/common/protocol/acp-ext-v1'
import { resolveProjectPath } from '@codebuff/common/util/project-path-containment'

import { sanitizeOutbound } from '../../serve/outbound-filter'
import { sanitizeOutboundStream } from '../../serve/outbound'
import {
  OPENBUFF_EXT_METHOD_PREFIX,
  OPENBUFF_EXT_METHODS,
  OPENBUFF_SUPPORTED_EXTENSIONS,
  defaultCapabilityMapV1,
  openbuffExtMethodSchemas,
} from './ext-methods'
import type { OpenbuffExtMethod } from './ext-methods'
import { ACP_EXTENSION_METHODS, acpExtensionSchemas } from './extensions'
import type { AcpExtensionMethod } from './extensions'
import type { AcpSessionData } from './session-data'

/** §12.6 limits, in bytes. */
const MAX_INBOUND_FRAME_BYTES = 16 * 1024 * 1024
const MAX_PROMPT_TOTAL_BYTES = 8 * 1024 * 1024
const MAX_IMAGE_BYTES = 5 * 1024 * 1024
const MAX_LIVE_SESSIONS = 16

/**
 * The resolved shape of one prompt turn: the handler reports its own terminal
 * state so a cancelled turn (via the abort signal) and a naturally finished
 * turn are both explicit.
 */
export type AcpPromptTurnResult = { stopReason: 'end_turn' | 'cancelled' }

/**
 * The injectable seam P1-T2 binds to the real core run: the ACP skeleton owns
 * the protocol surface while the handler owns turn execution and streaming.
 *
 * The returned promise models BOTH §4.2 turn exits: it RESOLVES with
 * {@link AcpPromptTurnResult} for a finished turn, and it may REJECT with a
 * JSON-RPC `RequestError` when the turn ends in a terminal error — the serve
 * bridge throws the -32603 `PrintModeRpcError` shape after the handler body
 * completes (as a REAL `RequestError` instance, so the ACP wire layer maps it
 * directly onto the `session/prompt` error response). Consumers must not
 * assume the promise always resolves: type-asserting the resolved shape or
 * wrapping the handler with a non-throwing default silently converts the
 * terminal-error contract into a generic failure.
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
  /**
   * §4.2: the client capabilities snapshot negotiated at initialize,
   * projected onto the slice the serve bridge consults (`elicitation.form`
   * gates the ask_user → elicitation/create mapping). Omitted when the
   * client advertised no elicitation capability.
   */
  clientCapabilities?: { elicitation?: { form?: unknown } }
  /**
   * §3.2: whether the `events` Openbuff extension was negotiated. Omitted
   * when it was not, so the bridge's ext-gated ask_user path stays closed.
   */
  eventsExtensionEnabled?: boolean
  /**
   * §4.2: the generic reverse-request channel bound to the owning
   * connection, carrying `elicitation/create` and `_openbuff.dev/ask_user`.
   */
  onReverseRequest?: (method: string, params: unknown) => Promise<unknown>
  /**
   * §12.4: sends `$/cancel_request` for an outstanding reverse-request id on
   * the owning connection, so the client can tear down pending UI on timeout.
   */
  onCancelRequest?: (requestId: string) => void | Promise<void>
}) => Promise<AcpPromptTurnResult>

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
 * The per-connection surface the serve transports hand to
 * {@link createAcpAgent}: at minimum the session-update sink; the real wire
 * connections (the SDK's `AgentSideConnection`) additionally expose the
 * client-method reverse-request surface, from which the agent derives the
 * §5/§4.2 bridge seams when the host injected no explicit
 * `reverseRequests`. Every extra is optional so test fakes only need
 * `sessionUpdate`.
 */
export type AcpAgentConnection = AcpSessionUpdateSink & {
  requestPermission?(
    params: RequestPermissionRequest,
  ): Promise<RequestPermissionResponse>
  readTextFile?(params: ReadTextFileRequest): Promise<ReadTextFileResponse>
  writeTextFile?(params: WriteTextFileRequest): Promise<WriteTextFileResponse>
  /** The SDK returns a `TerminalHandle`; the agent adapts it onto the plain
   * `CreateTerminalResponse` shape `AcpReverseRequests` models. */
  createTerminal?(params: CreateTerminalRequest): Promise<TerminalHandle>
  /** Generic client-method request channel (elicitation/create, ext methods). */
  request?(method: string, params?: unknown): Promise<unknown>
  /** Generic client-method notification channel (`$/cancel_request`). */
  notify?(method: string, params?: unknown): Promise<void>
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

/**
 * One already-persisted chat-history message replayed to the client on
 * `session/load` (§4.1). The shape is deliberately minimal and structural so
 * the CLI's chat-history store (and tests) can feed it without the protocol
 * layer importing the CLI's concrete ChatMessage type. Reasoning content is
 * dropped at projection time and the tool `rawInput`/`rawOutput` are never
 * emitted (GV-26).
 */
export type AcpReplayMessage = {
  variant: 'user' | 'agent' | 'tool'
  text?: string
  toolCallId?: string
  toolName?: string
  paths?: string[]
}

export type AcpAgentOptions = {
  /** Required by design: there is no default prompt handler to hide behind. */
  promptHandler: AcpPromptHandler
  /** Where streamed agent message chunks are delivered (the client side).
   * The real transports pass the SDK `AgentSideConnection`, whose extra
   * client-method surface (see {@link AcpAgentConnection}) is what binds the
   * §5 approval / §4.2 ask_user seams on the `openbuff serve` path. */
  connection: AcpAgentConnection
  /** Human-readable name for P1-T2 logging; consumed by the serve bridge. */
  clientNameForLogging?: string
  /**
   * Optional resume path for `session/load`: restores external state for a
   * previously created session id. Absent means `session/load` fails closed
   * with a JSON-RPC method-not-found error.
   */
  loadHandler?: (input: { sessionId: string }) => Promise<void>
  /**
   * Optional chat-history replay seam for `session/load` (§4.1): returns the
   * persisted conversation as ordered replay messages. The agent replays them
   * as `user_message_chunk`/`agent_message_chunk`/`tool_call` (final status)
   * session/update notifications BEFORE the `session/load` result. Absent
   * means no history is replayed. The protocol layer sanitizes every replayed
   * text and drops reasoning/tool raw IO, so no receipts, capabilities, or
   * `cap.v3.` tokens cross the wire on replay (GV-26).
   */
  historyLoader?: (input: {
    sessionId: string
  }) => Promise<AcpReplayMessage[]>
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
  /**
   * SEC-7 (§12.5) containment anchor: the serve process's project root. When
   * set, `newSession`/`loadSession` validate that `cwd` is absolute and equal
   * to or inside this root (after symlink dereference) and reject
   * `additionalDirectories` entries that are not in
   * `allowedAdditionalDirectories`. When unset, cwd validation is skipped
   * entirely (preserving the pre-P1-T2 permissive behavior for in-process
   * embeddings that have no fixed root).
   */
  projectRoot?: string
  /**
   * The directories a client may legitimately add via `additionalDirectories`
   * — the union of `openbuff.json` `serve.additionalDirectories` and
   * `--add-dir`, resolved to absolute form by the host. An entry not in this
   * list is rejected (-32602), never silently admitted.
   */
  allowedAdditionalDirectories?: string[]
  /**
   * GV-18 (§12.3 transport gating): whether client-supplied `mcpServers`
   * are accepted at `session/new`. Unset/true is PERMISSIVE (in-process
   * embeddings and the stdio transport keep today's behavior); the socket
   * transport passes `false` so a same-uid peer cannot make the serve
   * process spawn client-directed MCP server processes. When `false` and
   * the request carries any `mcpServers` entry, `newSession` fails closed
   * with -32602 and `data['openbuff.dev'].code = 'client_mcp_disabled'`
   * BEFORE any session record is created or process spawned (GV-18).
   */
  allowClientMcpServers?: boolean
}

/** Per-session state kept for later phases (P1-T2 core-run wiring). */
type AcpSessionState = {
  /** The VALIDATED project-root cwd recorded at session/new or session/load. */
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

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The negotiated Openbuff extension set for one connection (§3.2). */
type NegotiatedExt = { extVersion: number; extensions: string[] }

/**
 * Reads `clientCapabilities._meta["openbuff.dev"]` and computes the negotiated
 * extension set. Returns undefined for a plain ACP client (no `_meta`) so the
 * no-ext-echo rule holds: the agent then emits pure ACP and never sends an
 * extension notification. Unknown extensions are dropped (intersection with
 * the supported set); `extVersion` is min(client, agent) — independent of the
 * ACP protocolVersion.
 */
function negotiateOpenbuffExt(
  params: InitializeRequest,
): NegotiatedExt | undefined {
  const meta = params.clientCapabilities?._meta
  if (!isPlainRecord(meta)) return undefined
  const openbuff = meta[OPENBUFF_ACP_NS]
  if (!isPlainRecord(openbuff)) return undefined
  const requested = Array.isArray(openbuff.extensions)
    ? openbuff.extensions.filter(
        (entry): entry is string => typeof entry === 'string',
      )
    : []
  const supported = new Set<string>(OPENBUFF_SUPPORTED_EXTENSIONS)
  const extensions = requested.filter((entry) => supported.has(entry))
  const clientVersion =
    typeof openbuff.extVersion === 'number' ? openbuff.extVersion : 0
  const extVersion = Math.min(clientVersion, OPENBUFF_ACP_EXT_VERSION)
  return { extVersion, extensions }
}

/**
 * SEC-7 (§12.5): percent-decodes a client-supplied path/URI exactly once and
 * rejects the residual-encoding and authority escape shapes. Returns the
 * decoded path, or null when the value is rejected (never silently
 * normalized). `cwd`/`additionalDirectories` arrive as plain absolute paths;
 * a `file://` URI is unwrapped to its path, rejecting any authority that is
 * not empty or `localhost`.
 */
function decodeContainedPathInput(input: string): string | null {
  let value = input
  if (value.startsWith('file://')) {
    const rest = value.slice('file://'.length)
    const slashIndex = rest.indexOf('/')
    const authority = slashIndex === -1 ? rest : rest.slice(0, slashIndex)
    if (authority !== '' && authority !== 'localhost') {
      return null
    }
    value = slashIndex === -1 ? '' : rest.slice(slashIndex)
  }
  let decoded: string
  try {
    decoded = decodeURIComponent(value)
  } catch {
    // A malformed percent-escape is not a usable path: reject, never guess.
    return null
  }
  // Residual encoded traversal/separator after ONE decode = double-encoding
  // attack (the first decode yields `%2e`/`%2f`/`%5c`, which a second decode
  // would turn into `.`/`/`/`\`). Reject rather than decode again.
  if (/%2e|%2f|%5c/i.test(decoded)) {
    return null
  }
  return decoded
}

/**
 * Builds the §12.5 containment validator bound to one project root. Returns
 * null when the input must be rejected (-32602): a path that fails
 * percent-decode/authority, is not absolute, contains traversal segments, or
 * escapes the root after symlink dereference. `resolveProjectPath` does the
 * root-relative resolution, lexical root check, and realpath symlink check;
 * this wrapper adds the SEC-7-specific absolute + reject (never normalize)
 * rules on top.
 */
function resolveContainedProjectDir(
  projectRoot: string,
  input: string,
): string | null {
  const decoded = decodeContainedPathInput(input)
  if (decoded === null) return null
  // SEC-7 requires an absolute path; `resolveProjectPath` would resolve a
  // relative input against the root and silently admit it, which is exactly
  // the normalization the contract forbids.
  if (isWindowsAbsolutePath(decoded) || decoded.startsWith('/')) {
    const contained = resolveProjectPath(projectRoot, decoded)
    if (contained === null || contained.scope !== 'project') return null
    return contained.fullPath
  }
  return null
}

function isWindowsAbsolutePath(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\')
}

/** Builds the -32602 `limit_exceeded` error body. */
function makeLimitExceeded(message: string): RequestError {
  return RequestError.invalidParams(
    { [OPENBUFF_ACP_NS]: { code: 'limit_exceeded' } },
    message,
  )
}

/**
 * GV-18/GV-20 (§12.3): the -32602 error bodies the golden vectors pin. Built
 * with the RAW RequestError constructor because the SDK's `invalidParams`
 * static prepends "Invalid params: " to the message — the fixtures require
 * the message field EXACTLY ('Client-supplied MCP servers are disabled on
 * this transport' / 'MCP server URL host is a private/loopback address').
 */
function makeMcpGateError(
  code: 'client_mcp_disabled' | 'mcp_url_blocked',
  message: string,
): RequestError {
  return new RequestError(-32602, message, {
    [OPENBUFF_ACP_NS]: { code },
  })
}

/**
 * GV-20 (§12.3 SSRF): the literal private/loopback/link-local IPv4 ranges a
 * client-supplied MCP URL host is refused for (CIDR network + mask).
 */
const PRIVATE_IPV4_RANGES: ReadonlyArray<{ network: number; mask: number }> = [
  { network: 0x7f000000, mask: 0xff000000 }, // 127.0.0.0/8 (loopback)
  { network: 0x0a000000, mask: 0xff000000 }, // 10.0.0.0/8 (private)
  { network: 0xac100000, mask: 0xfff00000 }, // 172.16.0.0/12 (private)
  { network: 0xc0a80000, mask: 0xffff0000 }, // 192.168.0.0/16 (private)
  { network: 0xa9fe0000, mask: 0xffff0000 }, // 169.254.0.0/16 (link-local)
]

/** Parses a dotted-quad IPv4 literal into its 32-bit value, else null. */
function parseIpv4Literal(host: string): number | null {
  const parts = host.split('.')
  if (parts.length !== 4) return null
  let value = 0
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null
    const octet = Number(part)
    if (octet > 255) return null
    value = (value << 8) | octet
  }
  return value >>> 0
}

/**
 * Expands an IPv6 literal (no brackets, no zone id) to its eight 16-bit
 * groups, handling one `::` compression. Returns null for anything that is
 * not a plain hex-group IPv6 literal (including IPv4-embedded forms, which
 * stay the connect-time DNS pinning layer's job).
 */
function expandIpv6Groups(host: string): number[] | null {
  const doubleColon = host.indexOf('::')
  let parts: string[]
  if (doubleColon !== -1) {
    if (host.indexOf('::', doubleColon + 1) !== -1) return null
    const head = doubleColon > 0 ? host.slice(0, doubleColon).split(':') : []
    const tail =
      doubleColon + 2 < host.length
        ? host.slice(doubleColon + 2).split(':')
        : []
    const fill = 8 - head.length - tail.length
    if (fill < 1) return null
    parts = [
      ...head,
      ...Array<string>(fill).fill('0'),
      ...tail,
    ]
  } else {
    parts = host.split(':')
    if (parts.length !== 8) return null
  }
  const groups: number[] = []
  for (const part of parts) {
    if (part.includes('.')) return null
    if (!/^[0-9a-fA-F]{1,4}$/.test(part)) return null
    groups.push(parseInt(part, 16))
  }
  return groups
}

/**
 * GV-20: true for a URL hostname that is the literal `localhost` or a
 * literal private/loopback/link-local IP address. Non-literal hostnames
 * (names that are neither dotted-quad IPv4 nor IPv6 literals) pass through —
 * the connect-time DNS pinning (`common/src/mcp/dns-pinning.ts`) stays the
 * second layer.
 */
function isPrivateOrLoopbackHost(hostname: string): boolean {
  // A zone id (`fe80::1%eth0`) never reaches this gate through WHATWG URL
  // parsing, but stripping keeps the predicate honest if a raw host arrives.
  const host = hostname.toLowerCase().replace(/%[0-9a-z]+$/, '')
  const unbracketed =
    host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host
  if (unbracketed === 'localhost') return true
  const ipv4 = parseIpv4Literal(unbracketed)
  if (ipv4 !== null) {
    // `>>> 0` is REQUIRED on the whole comparison: `&` coerces to signed
    // int32, so for hosts >= 2^31 (172.16/12, 192.168/16, 169.254/16) the
    // masked left side goes negative while `range.network` stays a positive
    // double and the ranges would never match. Do not drop the unsigned
    // conversion in a refactor.
    return PRIVATE_IPV4_RANGES.some(
      (range) => ((ipv4 & range.mask) >>> 0) === range.network,
    )
  }
  const groups = expandIpv6Groups(unbracketed)
  if (groups === null) return false
  // ::1 (loopback).
  if (groups.slice(0, 7).every((group) => group === 0) && groups[7] === 1) {
    return true
  }
  // fe80::/10 (link-local) and fc00::/7 (unique local).
  if ((groups[0]! & 0xffc0) === 0xfe80) return true
  if ((groups[0]! & 0xfe00) === 0xfc00) return true
  return false
}

/**
 * §12.6: enforces the prompt-total (8 MiB) and per-decoded-image (5 MiB)
 * limits over the already-parsed content blocks. `prompt` is text-only for
 * the handler, but the byte accounting covers every block so a large image or
 * embedded resource cannot smuggle an oversized turn past the wire limit.
 * A breach throws -32602 `limit_exceeded` before any handler runs.
 */
function enforcePromptLimits(prompt: PromptRequest['prompt']): void {
  let total = 0
  for (const block of prompt) {
    if (block.type === 'text') {
      total += Buffer.byteLength(block.text, 'utf8')
    } else if (block.type === 'image') {
      // The wire carries base64; the limit is on the DECODED size (~3/4).
      const decodedBytes = Math.floor(block.data.length * 0.75)
      if (decodedBytes > MAX_IMAGE_BYTES) {
        throw makeLimitExceeded(
          `ACP prompt image exceeds the ${MAX_IMAGE_BYTES}-byte per-image limit.`,
        )
      }
      total += decodedBytes
    } else if (block.type === 'audio') {
      total += Buffer.byteLength(block.data, 'utf8')
    } else if (block.type === 'resource') {
      const resource = block.resource
      if ('text' in resource && typeof resource.text === 'string') {
        total += Buffer.byteLength(resource.text, 'utf8')
      } else if ('blob' in resource && typeof resource.blob === 'string') {
        total += Math.floor(resource.blob.length * 0.75)
      }
    } else {
      // resource_link and any future block: count a bounded proxy.
      total += Buffer.byteLength(JSON.stringify(block), 'utf8')
    }
  }
  if (total > MAX_PROMPT_TOTAL_BYTES) {
    throw makeLimitExceeded(
      `ACP prompt exceeds the ${MAX_PROMPT_TOTAL_BYTES}-byte total limit.`,
    )
  }
}

/**
 * Builds the replay `session/update` notifications for one persisted history
 * message (§4.1). Reasoning is dropped; tool calls are emitted with a final
 * status and NO `rawInput`/`rawOutput`/receipts/capabilities (GV-26). Every
 * replayed text passes through `sanitizeOutbound` so a stored `cap.v3.` token
 * or credential can never reach the wire on replay.
 */
function replayMessagesToUpdates(
  sessionId: string,
  messages: AcpReplayMessage[],
): SessionNotification[] {
  const updates: SessionNotification[] = []
  for (const message of messages) {
    if (message.variant === 'user' || message.variant === 'agent') {
      const text = message.text
      if (typeof text !== 'string' || text.length === 0) continue
      updates.push({
        sessionId,
        update: {
          sessionUpdate:
            message.variant === 'user'
              ? 'user_message_chunk'
              : 'agent_message_chunk',
          content: { type: 'text', text: sanitizeOutbound(text) },
        },
      })
      continue
    }
    if (message.variant === 'tool') {
      const toolCallId = message.toolCallId
      if (typeof toolCallId !== 'string' || toolCallId.length === 0) continue
      const title =
        typeof message.toolName === 'string' && message.toolName.length > 0
          ? message.toolName
          : 'tool'
      const locations = (message.paths ?? [])
        .filter((path): path is string => typeof path === 'string')
        .map((path) => ({ path: sanitizeOutbound(path) }))
      // Final status, and deliberately NO rawInput/rawOutput/_meta: replayed
      // tool calls carry no receipts or capabilities (§4.1, GV-26).
      updates.push({
        sessionId,
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: sanitizeOutbound(toolCallId),
          title: sanitizeOutbound(title),
          status: 'completed',
          ...(locations.length > 0 ? { locations } : {}),
        },
      })
    }
  }
  return updates
}

/**
 * Derives the §5 `AcpReverseRequests` seam from the per-connection surface
 * when the host injected none. The SDK `AgentSideConnection` the serve
 * transports pass implements the full client-method surface; `createTerminal`
 * is adapted from the SDK's `TerminalHandle` onto the plain
 * `CreateTerminalResponse` shape `AcpReverseRequests` models. Returns
 * `undefined` for a bare session-update sink (test fakes, in-process
 * embeddings) so the bridge's fail-closed behavior is unchanged there.
 */
function reverseRequestsFromConnection(
  connection: AcpAgentConnection,
): AcpReverseRequests | undefined {
  const { requestPermission, readTextFile, writeTextFile, createTerminal } =
    connection
  if (
    typeof requestPermission !== 'function' ||
    typeof readTextFile !== 'function' ||
    typeof writeTextFile !== 'function' ||
    typeof createTerminal !== 'function'
  ) {
    return undefined
  }
  return {
    requestPermission: (params) => requestPermission.call(connection, params),
    readTextFile: (params) => readTextFile.call(connection, params),
    writeTextFile: async (params) => {
      await writeTextFile.call(connection, params)
    },
    createTerminal: async (params) => {
      const handle = await createTerminal.call(connection, params)
      return { terminalId: handle.id }
    },
  }
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
  // §3.2: the negotiated extension set is per-connection, established at
  // initialize and consulted to gate every extension notification.
  let negotiatedExt: NegotiatedExt | undefined
  // §4.2: the client capabilities snapshot projected for the serve bridge,
  // captured at initialize (always before the first prompt of the session).
  let clientCapabilities: { elicitation?: { form?: unknown } } | undefined
  // §5/§4.2 production wiring: the per-connection reverse-request seams.
  // An explicitly injected seam wins (back-compat); otherwise it is derived
  // from the connection's own client-method surface when it has one.
  const { connection } = options
  const reverseRequests =
    options.reverseRequests ?? reverseRequestsFromConnection(connection)
  const { request: connectionRequest, notify: connectionNotify } = connection
  const onReverseRequest =
    typeof connectionRequest === 'function'
      ? (method: string, params: unknown): Promise<unknown> =>
          connectionRequest.call(connection, method, params)
      : undefined
  const onCancelRequest =
    typeof connectionNotify === 'function'
      ? (requestId: string): Promise<void> =>
          connectionNotify.call(connection, '$/cancel_request', { requestId })
      : undefined

  /** SEC-7 containment helpers bound to the injected project root. */
  const resolveSessionCwd = (input: string): string | null =>
    options.projectRoot === undefined
      ? input
      : resolveContainedProjectDir(options.projectRoot, input)

  const rejectUncontainedCwd = (cwd: string): string => {
    const resolved = resolveSessionCwd(cwd)
    if (resolved === null) {
      throw RequestError.invalidParams(
        { cwd },
        `ACP session cwd must be absolute and inside the server project root.`,
      )
    }
    return resolved
  }

  const rejectUnallowedAdditionalDirectories = (
    additionalDirectories: string[] | undefined,
  ): void => {
    if (options.projectRoot === undefined) return
    if (!additionalDirectories || additionalDirectories.length === 0) return
    const allowed = new Set(options.allowedAdditionalDirectories ?? [])
    for (const directory of additionalDirectories) {
      const decoded = decodeContainedPathInput(directory)
      // Allowlist membership is the whole gate (SEC-7): an additional
      // directory legitimately lives OUTSIDE the project root (--add-dir), so
      // project containment is not demanded here — only the one-shot
      // percent-decode/authority check above plus membership in the
      // host-resolved allowlist.
      if (decoded === null || !allowed.has(decoded)) {
        throw RequestError.invalidParams(
          { additionalDirectories },
          `ACP additionalDirectories entry '${directory}' is not in the server's allowed additional directories.`,
        )
      }
    }
  }

  /**
   * §12.6 LRU session tracking: `sessions` is a plain Map whose insertion
   * order IS the recency order. Re-inserting a session id on every access
   * (delete + set) moves it to the most-recently-used end, so the FIRST key
   * is always the least-recently-used session.
   */
  const touchSession = (sessionId: string): AcpSessionState | undefined => {
    const state = sessions.get(sessionId)
    if (state === undefined) return undefined
    sessions.delete(sessionId)
    sessions.set(sessionId, state)
    return state
  }

  /**
   * §12.6 live-session cap with LRU eviction: the cap bounds per-connection
   * memory, so inserting beyond 16 evicts the least-recently-used session
   * (the first Map key) instead of rejecting the insert. Eviction is
   * best-effort cleanup consistent with the existing teardown: the victim's
   * in-flight AbortController — if any — is aborted, exactly what `cancel`
   * does, and the session record is dropped.
   *
   * An ACTIVE session (one with a prompt turn in flight) is never chosen as
   * the victim: recency is touched on every access (prompt/cancel/load),
   * and eviction additionally skips any session whose AbortController is
   * still live. When EVERY live session has a turn in flight there is
   * nothing safe to evict and the insert fails closed with the same
   * limit_exceeded error the cap has always produced.
   */
  const insertSessionBounded = (
    sessionId: string,
    state: AcpSessionState,
  ): void => {
    if (!sessions.has(sessionId) && sessions.size >= MAX_LIVE_SESSIONS) {
      let victimId: string | undefined
      for (const candidateId of sessions.keys()) {
        if (sessions.get(candidateId)?.abortController === null) {
          victimId = candidateId
          break
        }
      }
      if (victimId === undefined) {
        throw makeLimitExceeded(
          `ACP server holds at most ${MAX_LIVE_SESSIONS} live sessions and every one has a turn in flight.`,
        )
      }
      // Best-effort teardown of the evicted session, consistent with what
      // `cancel` does for an in-flight turn.
      sessions.get(victimId)?.abortController?.abort()
      sessions.delete(victimId)
    }
    // Re-inserting (delete + set) refreshes LRU recency for re-loads.
    sessions.delete(sessionId)
    sessions.set(sessionId, state)
  }

  // SEC: ext methods carry a client-supplied sessionId, so the store-serving
  // paths must only answer for sessions THIS connection created
  // (newSession) or restored (loadSession). The private `sessions` map is
  // per-connection by construction and IS the per-connection session-id
  // registry the ext dispatcher checks against.
  const assertOwnedSession = (sessionId: string): void => {
    if (!sessions.has(sessionId)) {
      throw RequestError.invalidParams(
        { sessionId },
        `Unknown ACP session id '${sessionId}' for this connection.`,
      )
    }
  }
  const sessionIdOf = (data: unknown): string => {
    const sessionId = (data as { sessionId?: unknown } | null)?.sessionId
    return typeof sessionId === 'string' ? sessionId : ''
  }

  return {
    initialize(params: InitializeRequest): InitializeResponse {
      negotiatedExt = negotiateOpenbuffExt(params)
      // §4.2: project the negotiated client capabilities onto the slice the
      // serve bridge consults. `form: null` means "not advertised" per the
      // ACP schema, so it is treated exactly like an omitted form capability.
      const elicitationForm = params.clientCapabilities?.elicitation?.form
      clientCapabilities =
        elicitationForm != null
          ? { elicitation: { form: elicitationForm } }
          : undefined
      // §3.3: the honest P1 capability advertisement. `loadSession` is true
      // (session/load is implemented below). `promptCapabilities` claims ONLY
      // what the prompt path actually consumes: `prompt()` forwards just the
      // `type === 'text'` blocks to the handler, so image and embedded-context
      // (resource) blocks are silently dropped — advertising `image: true` or
      // `embeddedContext: true` would promise input the wire path discards,
      // and a compliant client sending that content would lose it without any
      // error. `sessionCapabilities` is deliberately NOT advertised:
      // this agent implements neither session/list nor session/close, and a
      // compliant client that saw them advertised would call methods the wire
      // layer rejects with -32601. The `chatgpt-oauth` auth method is
      // advertised ONLY when the client can run a terminal
      // (`clientCapabilities.auth.terminal`).
      const agentCapabilities: AgentCapabilities = {
        loadSession: true,
        promptCapabilities: {
          image: false,
          audio: false,
          embeddedContext: false,
        },
        mcpCapabilities: { http: true, sse: true },
      }
      if (negotiatedExt !== undefined) {
        // §3.2: respond with the ext intersection and the live capability map.
        const capabilities: CapabilityMapV1 = defaultCapabilityMapV1({
          journalAvailable: options.sessionData?.hasJournal() ?? false,
        })
        agentCapabilities._meta = {
          [OPENBUFF_ACP_NS]: {
            extVersion: negotiatedExt.extVersion,
            extensions: negotiatedExt.extensions,
            capabilities,
          },
        }
      }
      const authMethods: AuthMethod[] = []
      if (params.clientCapabilities?.auth?.terminal === true) {
        authMethods.push({
          id: 'chatgpt-oauth',
          name: 'Sign in with ChatGPT',
          type: 'terminal',
          args: ['login', 'chatgpt'],
        })
      }
      return {
        protocolVersion: PROTOCOL_VERSION,
        agentCapabilities,
        authMethods,
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
      // SEC-7 (§12.5 Reload): the client-supplied cwd must resolve inside the
      // project root AND match the session's recorded project root — a loaded
      // session must never silently re-point to a different root.
      const resolvedCwd = rejectUncontainedCwd(params.cwd)
      const existing = sessions.get(params.sessionId)
      if (existing !== undefined && existing.cwd !== resolvedCwd) {
        throw RequestError.invalidParams(
          { cwd: params.cwd },
          `ACP session/load cwd does not match the session's recorded project root.`,
        )
      }
      // Register in the same private map newSession uses so subsequent
      // prompt/cancel calls work against the loaded session id. The bounded
      // insert also refreshes the §12.6 LRU recency of the reloaded session,
      // and a still-live in-flight turn keeps its controller so the
      // concurrent-prompt guard in `prompt` stays honest.
      insertSessionBounded(params.sessionId, {
        cwd: resolvedCwd,
        mcpServers: params.mcpServers,
        abortController: existing?.abortController ?? null,
      })
      await options.loadHandler({ sessionId: params.sessionId })
      // §4.1 (GV-26): replay the persisted chat history as sanitized
      // user/agent message chunks and final-status tool calls — reasoning
      // dropped, no receipts/capabilities — BEFORE the load result.
      if (options.historyLoader) {
        const history = await options.historyLoader({
          sessionId: params.sessionId,
        })
        for (const update of replayMessagesToUpdates(params.sessionId, history)) {
          await options.connection.sessionUpdate(update)
        }
      }
      // §6.1: a restored session also never answers capabilities/get with
      // -32601. Journal replay stores an honest re-derived map only when the
      // journal carried a capabilities line, so a restored session whose
      // journal predates the §6.1 store still gets the baseline here.
      const sessionData = options.sessionData
      if (
        sessionData &&
        sessionData.getCapabilities(params.sessionId) === undefined
      ) {
        sessionData.setCapabilities(
          params.sessionId,
          defaultCapabilityMapV1({
            journalAvailable: sessionData.hasJournal(),
          }),
        )
      }
      // LoadSessionResponse's fields (modes/configOptions/_meta) are all
      // optional per the SDK declarations; this skeleton restores no mode
      // state, so the exact empty response shape is the honest reply.
      return {}
    },

    // Async so a containment/limit rejection is a rejected promise, never a
    // synchronous throw: callers (and the wire layer) await this method and
    // expect the JSON-RPC error to surface through the awaited result. The
    // SDK's Agent interface allows MaybePromise<NewSessionResponse>.
    async newSession(
      params: NewSessionRequest,
    ): Promise<NewSessionResponse> {
      // SEC-7 (§12.5): validate cwd containment and the additionalDirectories
      // allowlist BEFORE any session record is created.
      const resolvedCwd = rejectUncontainedCwd(params.cwd)
      rejectUnallowedAdditionalDirectories(params.additionalDirectories)
      // GV-18 (§12.3 transport gating): a transport that disabled client MCP
      // refuses any request carrying mcpServers BEFORE any session record is
      // created or process spawned (the GV-18 fixture expects exactly
      // -32602 + 'client_mcp_disabled' + zero spawned processes).
      if (
        options.allowClientMcpServers === false &&
        params.mcpServers.length > 0
      ) {
        throw makeMcpGateError(
          'client_mcp_disabled',
          'Client-supplied MCP servers are disabled on this transport',
        )
      }
      // GV-20 (§12.3 SSRF): every client-supplied MCP server entry carrying
      // an http/sse URL has its literal host checked BEFORE any connection
      // is attempted. Literal private/loopback/link-local hosts are refused;
      // non-literal hostnames pass through (connect-time DNS pinning in
      // common/src/mcp/dns-pinning.ts stays the second layer).
      for (const server of params.mcpServers) {
        if (!('url' in server) || typeof server.url !== 'string') continue
        let hostname: string
        try {
          hostname = new URL(server.url).hostname
        } catch {
          // An unparseable URL carries no literal host to reject here; the
          // connect-time DNS pinning stays the second layer.
          continue
        }
        if (isPrivateOrLoopbackHost(hostname)) {
          throw makeMcpGateError(
            'mcp_url_blocked',
            'MCP server URL host is a private/loopback address',
          )
        }
      }
      const sessionId = randomUUID()
      insertSessionBounded(sessionId, {
        cwd: resolvedCwd,
        mcpServers: params.mcpServers,
        abortController: null,
      })
      // §6.1: seed the honest baseline capability map at session creation so
      // `_openbuff.dev/capabilities/get` never fails for an open session —
      // not even between session/new and the first prompt. The journal flags
      // reflect the injected store's real posture (a purely in-memory store
      // advertises no resume/replay), and the map is always derived locally.
      const sessionData = options.sessionData
      if (
        sessionData &&
        sessionData.getCapabilities(sessionId) === undefined
      ) {
        sessionData.setCapabilities(
          sessionId,
          defaultCapabilityMapV1({
            journalAvailable: sessionData.hasJournal(),
          }),
        )
      }
      return { sessionId }
    },

    async prompt(params: PromptRequest): Promise<PromptResponse> {
      // Touch LRU recency first: an actively-prompted session is the
      // most-recently-used one and can never be the §12.6 eviction victim.
      const session = touchSession(params.sessionId)
      if (!session) {
        // A real JSON-RPC invalid-params error (not a bare Error) so clients
        // see a protocol-appropriate failure for an unknown session id.
        throw RequestError.invalidParams(
          { sessionId: params.sessionId },
          `Unknown ACP session id '${params.sessionId}'.`,
        )
      }
      // One prompt turn per session at a time: the previous behavior silently
      // REPLACED the in-flight AbortController here, which left the first
      // turn uncancellable (its cancel signal was dropped on the floor).
      // Fail closed instead: a concurrent prompt on the same session is
      // rejected and may be retried once the in-flight turn settles. The
      // wire shape is pinned BYTE-FOR-BYTE by the GV-14 golden fixture:
      // JSON-RPC -32600, message 'A prompt is already running for this
      // session', data { 'openbuff.dev': { code: 'prompt_in_flight' } }.
      if (session.abortController !== null) {
        throw new RequestError(
          -32600,
          'A prompt is already running for this session',
          { [OPENBUFF_ACP_NS]: { code: 'prompt_in_flight' } },
        )
      }
      // §12.6: prompt-total and per-image limits, enforced before any handler
      // runs so an oversized turn never reaches the core.
      enforcePromptLimits(params.prompt)
      // One AbortController per prompt turn: `cancel` aborts the turn in
      // flight, and the controller is released when the turn settles so a
      // subsequent prompt is accepted again.
      const abortController = new AbortController()
      session.abortController = abortController
      // The baseline contract here only needs text: concatenate the
      // `type === 'text'` blocks and let the injected handler decide what to
      // do with richer blocks (images, resources) in later phases.
      const promptText = params.prompt
        .flatMap((block) => (block.type === 'text' ? [block.text] : []))
        .join('')
      try {
        const result = await options.promptHandler({
          sessionId: params.sessionId,
          promptText,
          mcpServers: session.mcpServers,
          reverseRequests,
          clientCapabilities,
          eventsExtensionEnabled: negotiatedExt?.extensions.includes('events')
            ? true
            : undefined,
          onReverseRequest,
          onCancelRequest,
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
      } finally {
        // The turn settled (finished, errored, or was cancelled): release the
        // controller so the session accepts its next prompt. Only this
        // turn's own controller is cleared.
        if (session.abortController === abortController) {
          session.abortController = null
        }
      }
    },

    cancel(params: CancelNotification): void {
      // Notifications carry no response, so an unknown session id is a no-op
      // here rather than an error surface. Recency is touched on cancel too,
      // so an actively-driven session never looks stale to §12.6 LRU
      // eviction.
      touchSession(params.sessionId)?.abortController?.abort()
    },

    async extMethod(
      method: string,
      params: Record<string, unknown>,
    ): Promise<Record<string, unknown>> {
      // Ext-v1 namespaced methods (§6) dispatch first: the legacy `openbuff/*`
      // names below never overlap the `_openbuff.dev/` prefix. Params are
      // validated with the ext-v1 schemas, an injected extensionHandler keeps
      // winning (back-compat), and otherwise the live store serves the method.
      if (method.startsWith(OPENBUFF_EXT_METHOD_PREFIX)) {
        const known = OPENBUFF_EXT_METHODS.find(
          (candidate) => candidate === method,
        )
        if (!known) {
          // Unknown ext-v1 methods follow the ACP rule for unknown extension
          // methods: -32601.
          throw RequestError.methodNotFound(method)
        }
        const { params: paramsSchema } = openbuffExtMethodSchemas[known]
        const parsed = paramsSchema.safeParse(params)
        if (!parsed.success) {
          throw RequestError.invalidParams(
            params,
            `Invalid params for ACP extension '${method}': ${parsed.error.issues
              .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
              .join('; ')}`,
          )
        }
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
            throw RequestError.internalError(
              { method },
              `ACP extension handler for '${method}' returned a non-object response.`,
            )
          }
          return result as Record<string, unknown>
        }
        // The live store serves per-session data, so the requested sessionId
        // must belong to THIS connection (an injected extensionHandler above
        // is a bridge/test seam and stays ungated).
        if (options.sessionData) {
          assertOwnedSession(sessionIdOf(parsed.data))
        }
        return dispatchExtV1Method(
          known,
          parsed.data as Record<string, unknown>,
          options.sessionData,
        )
      }
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
        assertOwnedSession(sessionId)
        return options.sessionData.getReceipts(sessionId, limit)
      }
      if (options.sessionData && method === 'openbuff/gateState') {
        const { sessionId } = parsed.data as { sessionId: string }
        assertOwnedSession(sessionId)
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
 * Dispatches one KNOWN ext-v1 `_openbuff.dev/*` method (§6) against the live
 * store. Wire shapes pinned by the golden vectors: `lanes/create` and
 * `lanes/land` are -32601 with `data["openbuff.dev"] = {code:
 * 'capability_disabled', capability: 'lanes'}` while lanes are unsupported
 * (GV-10), and an unknown receipt id is -32002 with `code:
 * 'receipt_not_found'` (§6.2).
 */
async function dispatchExtV1Method(
  method: OpenbuffExtMethod,
  params: Record<string, unknown>,
  sessionData: AcpSessionData | undefined,
): Promise<Record<string, unknown>> {
  if (!sessionData) {
    // Without the live store there is nothing to serve ext-v1 methods from:
    // fail closed (mirrors the legacy askUser path).
    throw RequestError.methodNotFound(method)
  }
  const data = params as { sessionId?: unknown; receiptId?: unknown }
  const sessionId = typeof data.sessionId === 'string' ? data.sessionId : ''
  switch (method) {
    case '_openbuff.dev/capabilities/get': {
      const capabilities = sessionData.getCapabilities(sessionId)
      if (capabilities === undefined) {
        // The ext surface was never negotiated/stored for this session.
        throw RequestError.methodNotFound(method)
      }
      return capabilities
    }
    case '_openbuff.dev/receipts/get': {
      const receiptId = typeof data.receiptId === 'string' ? data.receiptId : ''
      const envelope = sessionData.getReceipt(sessionId, receiptId)
      if (envelope === undefined) {
        throw new RequestError(
          -32002,
          `Unknown receipt id '${receiptId}'.`,
          { 'openbuff.dev': { code: 'receipt_not_found', receiptId } },
        )
      }
      // GV-07: the redaction-enforcing ext-v1 wire contract is validated on
      // EVERY serve path — including journal-restored sessions — so a tampered
      // journal (or any future internal regression) can never publish
      // content-bearing mutation fields (`afterContent`/`patch`/`editAnchor`)
      // or fresh cap.v3 tokens across the wire. Envelopes the store records
      // are built with the §6.2 wire projection (toWireMutation), so every
      // legitimately recorded receipt conforms to this strict shape and is
      // served; only a non-conforming envelope has no wire representation and
      // is unaddressable (receipt_not_found).
      const parsedEnvelope = receiptEnvelopeV1Schema.safeParse(envelope)
      if (!parsedEnvelope.success) {
        throw new RequestError(
          -32002,
          `Unknown receipt id '${receiptId}'.`,
          { 'openbuff.dev': { code: 'receipt_not_found', receiptId } },
        )
      }
      return {
        receipt: parsedEnvelope.data,
      } as Record<string, unknown>
    }
    case '_openbuff.dev/lanes/list':
      return {
        lanes: [sessionData.getMainLane(sessionId)],
      }
    case '_openbuff.dev/lanes/create':
    case '_openbuff.dev/lanes/land':
      throw new RequestError(-32601, 'Method not found', {
        'openbuff.dev': { code: 'capability_disabled', capability: 'lanes' },
      })
    case '_openbuff.dev/gate_state/get':
      return sessionData.getGateStateV1(sessionId)
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
 *
 * §12.6 inbound limit: the installed `@agentclientprotocol/sdk` (1.5.0)
 * `ndJsonStream` has NO `maxMessageBytes` option — its `LineBuffer` accumulates
 * a single newline-delimited line without any byte cap (the design doc's 32
 * MiB default describes a newer SDK). The 16 MiB cap is therefore enforced at
 * the ONLY seam this layer owns: the input `ReadableStream` is byte-counted
 * per NDJSON line and the connection's readable is errored (closing the
 * connection) when a line exceeds 16 MiB, before the SDK ever parses it. This
 * is the tighten-16-MiB behavior the contract requires, implemented at the
 * correct layer; the installed SDK exposes no `maxMessageBytes` knob, so the
 * guard is the only enforcement point. On a breach the outbound side is ended
 * too (see `limitNdJsonLineBytes`), so a peer observes the connection close
 * instead of hanging on a pending request.
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
  // NEW-4 chokepoint (§12.8): every serialized frame — including
  // SDK-generated JSON-RPC errors and agent→client requests — passes through
  // sanitizeOutbound before the wire. Clean frames stay byte-identical.
  const stream = ndJsonStream(
    sanitizeOutboundStream(
      Writable.toWeb(process.stdout) as unknown as WritableStream<Uint8Array>,
    ),
    limitNdJsonLineBytes(
      Readable.toWeb(process.stdin) as unknown as ReadableStream<Uint8Array>,
      MAX_INBOUND_FRAME_BYTES,
      // §12.6: an oversized inbound frame closes the connection in BOTH
      // directions — ending stdout makes the peer observe the close instead
      // of hanging on a pending request forever.
      () => process.stdout.end(),
    ),
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

/**
 * §12.6 inbound guard: wraps the NDJSON byte stream so a single line longer
 * than `maxBytes` errors the readable (which the SDK surfaces as a connection
 * close) instead of letting the SDK's uncapped `LineBuffer` accumulate it.
 * The limit applies per LINE: the byte counter accumulates non-newline bytes
 * and resets at every newline, so one chunk carrying several sub-limit lines
 * can never close a legitimate connection by chunk+line accumulation. On a
 * breach the underlying input is cancelled (no further bytes are read) and
 * `onLimitExceeded` fires BEFORE the readable errors, so the host can tear
 * down the outbound direction too and a peer with a request in flight
 * observes the connection close instead of hanging forever. Exported so the
 * wire-limit test pins the exact guard `serveAcpOverStdio` installs.
 */
export function limitNdJsonLineBytes(
  input: ReadableStream<Uint8Array>,
  maxBytes: number,
  onLimitExceeded?: () => void,
): ReadableStream<Uint8Array> {
  const reader = input.getReader()
  let currentLineBytes = 0
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) {
          controller.close()
          return
        }
        if (!value) continue
        // The limit applies per LINE, not per chunk: the counter accumulates
        // non-newline bytes and resets at EVERY newline, so a chunk that
        // carries several lines is accounted line-by-line and legitimate
        // sub-limit lines can never trip the guard by accumulation.
        for (const byte of value) {
          if (byte === 0x0a) {
            currentLineBytes = 0
            continue
          }
          currentLineBytes += 1
          if (currentLineBytes > maxBytes) {
            // Tear down BOTH directions: the readable error closes the agent
            // side, and the callback lets the host end the outbound side.
            onLimitExceeded?.()
            void reader.cancel().catch(() => {})
            controller.error(
              new Error(
                `ACP inbound NDJSON line exceeds the ${maxBytes}-byte limit; closing connection.`,
              ),
            )
            return
          }
        }
        controller.enqueue(value)
        return
      }
    },
    cancel(reason) {
      return reader.cancel(reason)
    },
  })
}
