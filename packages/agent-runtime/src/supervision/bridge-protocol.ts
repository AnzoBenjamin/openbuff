/**
 * P2-T8b: shared parent↔child RPC bridge protocol.
 *
 * Transport: a Unix socket INSIDE the spawn's 0700 mkdtemp sandbox. Both
 * directions frame newline-delimited JSON (ndjson), mirroring the SDK ACP
 * ndJsonStream framing patterns. The supervisor's stdout settle contract is
 * UNTOUCHED: the child's stdout still carries EXACTLY ONE newline-terminated
 * `agentReceiptSchema` envelope, and the RPC never rides stdout/stderr.
 *
 * Wire messages:
 *  - child→parent request: { id: string, method: string, params: unknown }
 *  - parent reply (ok):    { id, ok: true, result: unknown }
 *  - parent reply (error): { id, ok: false, error: { message: string } }
 * Parent→child fire-and-forget notifications are NOT needed in slice 1: the
 * only parent→child data (prompt results) arrives as request replies.
 *
 * STREAMING LIMITATION (slice 1): `promptAiSdkStream` is bridged by the
 * parent handler collecting the chunk sequence and returning
 * `{ chunks: [...], result: <PromptResult> }`; the child reconstructs an
 * AsyncGenerator from the array. The collected sequence is BOUNDED by
 * BRIDGE_MAX_STREAM_CHUNKS_BYTES (strictly under the 16 MiB per-message cap
 * so the single stream reply ALWAYS encodes): chunk bytes beyond the budget
 * are dropped and the reply carries `truncated: true`, which the child logs
 * LOUDLY on stderr — a valid long stream truncates loudly instead of
 * overflowing the reply cap and settling a 'crashed' receipt the in-process
 * path could never produce. Child→parent DISPLAY streaming still flows
 * incrementally via the fire-and-forget `sendSubagentChunk` /
 * `handleStepsLogChunk` RPCs. Those notifications carry a dedicated bounded
 * budget on the parent (MAX_CONCURRENT_BRIDGE_NOTIFIES, separate from
 * request/response traffic): at saturation the parent replies with a
 * structured 'bridge_notify_overflow' error, which the child client logs
 * LOUDLY on stderr — a saturated bridge is never a silent drop.
 *
 * STREAM TEARDOWN PARITY: the parent's built handler table
 * (buildSupervisedBridgeHandlers) exposes `cancelInFlightStreams`, which the
 * bridge server's close() invokes BEFORE killing the pending handlers: the
 * killed promptAiSdkStream collector cancels the underlying provider
 * iterator (abort the rehydrated signal + `iterator.return()`) exactly like
 * the consumer's early return on the in-process path, instead of buffering
 * chunks into an unbounded array with no consumer (continued provider spend
 * + memory growth).
 *
 * CAPABILITY FORWARDING: `requestFiles`' `capabilityIssuer`
 * ({ projectId, runId }) is JSON-serializable and CROSSES the bridge; the
 * parent's real dep mints cap.v3 editAnchors (contentHash + line range) for
 * complete reads, and the child's read_files handler RE-MINTS that anchor
 * with the child's own in-process HMAC key — a cap.v3 token is verifiable
 * only in the process that minted it, so capability-bearing edits
 * (str_replace / replace_range / rewrite_symbol / edit_transaction) work in
 * a flag-on supervised child without replaying a parent-signed token.
 *
 * ErrorOr discipline: a handler failure NEVER throws across the bridge — it
 * is encoded as `{ ok: false, error: { message } }`. A malformed line or an
 * oversized message closes the socket (fail-closed).
 *
 * NOTE(P2-T1): request ids are a monotonic counter (`rpc-<n>`), not
 * crypto.randomUUID — the bridge needs correlation, not unguessability, and
 * socket authority comes from the owner-only sandbox directory, not id
 * secrecy. No Date.now/randomUUID in this module.
 */
import type { TrackEventFn } from '@codebuff/common/types/contracts/analytics'
import type { ConsumeCreditsWithFallbackFn } from '@codebuff/common/types/contracts/billing'
import type {
  HandleStepsLogChunkFn,
  RequestFilesFn,
  RequestMcpToolDataFn,
  RequestOptionalFileFn,
  RequestToolCallFn,
  SendActionFn,
  SendSubagentChunkFn,
} from '@codebuff/common/types/contracts/client'
import type {
  AddAgentStepFn,
  FetchAgentFromDatabaseFn,
  FinishAgentRunFn,
  StartAgentRunFn,
} from '@codebuff/common/types/contracts/database'
import type {
  PromptAiSdkFn,
  PromptAiSdkStreamFn,
  PromptAiSdkStructuredFn,
  StreamChunk,
} from '@codebuff/common/types/contracts/llm'
import type { Logger } from '@codebuff/common/types/contracts/logger'
import type { PromptResult } from '@codebuff/common/util/error'

/**
 * Every bridged method name. A handler-table key outside this list fails
 * closed at dispatch (error reply, never a crash).
 *
 * Slice-1 additions beyond the design's enumerated 15:
 *  - `fetchAgentFromDatabase` — REQUIRED for the child loop to resolve the
 *    spawned agent's template when it is not in `localAgentTemplates`
 *    (getAgentTemplate is the loop's first await). Its result is validated
 *    ROUND-TRIP-SAFE fail-closed before it crosses the JSON wire (see
 *    {@link findNonRoundTripSafeResultPaths}): a template carrying a live
 *    z.ZodSchema inputSchema.prompt/params or outputSchema member, or a
 *    programmatic `handleSteps` function, is REJECTED with a structured
 *    error naming the offending members — the child never receives a
 *    structurally damaged AgentTemplate silently diverging from the
 *    FetchAgentFromDatabaseFn contract the in-process path satisfies;
 *  - `consumeCreditsWithFallback` — bridging it keeps child-side paid-tool
 *    gating honest instead of silently free.
 *
 * Typed dep fields that are not JSON-native cross the bridge as
 * nonce-stamped wire markers and rehydrate parent-side (the per-dep
 * serializability rule holds modulo the marker protocol): notably
 * `addAgentStep`'s required `startTime: Date` — a live Date crosses as a
 * date marker and the parent's real dep receives a live `new Date(iso)`,
 * never the `{}` the plain-object sanitize walk alone would produce.
 *
 * Deliberately NOT bridged:
 *  - `databaseAgentCache` — a stateful Map handle with SYNCHRONOUS
 *    has/get/set, which cannot cross an async RPC boundary; the child
 *    reconstructs a fresh per-run Map (see child-entry.ts);
 *  - `getUserInfoFromApiKey` — its result carries a non-serializable Date
 *    column; the child fails closed to `null`.
 */
export const BRIDGE_METHODS = [
  'promptAiSdkStream',
  'promptAiSdk',
  'promptAiSdkStructured',
  'sendAction',
  'requestToolCall',
  'requestFiles',
  'requestOptionalFile',
  'requestMcpToolData',
  'handleStepsLogChunk',
  'sendSubagentChunk',
  'trackEvent',
  'fetch',
  'startAgentRun',
  'finishAgentRun',
  'addAgentStep',
  'fetchAgentFromDatabase',
  'consumeCreditsWithFallback',
] as const

export type BridgeMethod = (typeof BRIDGE_METHODS)[number]

const BRIDGE_METHOD_SET: ReadonlySet<string> = new Set(BRIDGE_METHODS)

export function isBridgeMethod(value: unknown): value is BridgeMethod {
  return typeof value === 'string' && BRIDGE_METHOD_SET.has(value)
}

/** Per-message size cap: 16 MiB, both directions. */
export const BRIDGE_MAX_MESSAGE_BYTES = 16 * 1024 * 1024

/**
 * Byte budget for the parent-side collected `promptAiSdkStream` chunk
 * sequence, kept strictly under {@link BRIDGE_MAX_MESSAGE_BYTES} so the
 * single stream reply (chunks + the final PromptResult envelope) always
 * encodes: a valid long stream TRUNCATES (the reply carries `truncated: true`,
 * logged loudly child-side) instead of overflowing the per-message cap in the
 * reply path — an `encodeBridgeMessage` throw there destroys the socket and
 * settles a valid run as 'crashed', a failure the in-process path cannot
 * exhibit.
 */
export const BRIDGE_MAX_STREAM_CHUNKS_BYTES = 12 * 1024 * 1024

/**
 * Id of the parent→child close-notification reply the parent bridge server's
 * `close()` writes before destroying its sockets. The child client fails
 * closed with a typed BridgeClosedError on this id instead of routing it
 * through the pending-request lookup.
 */
export const BRIDGE_CLOSE_ID = 'bridge-close'

/** Child→parent request. */
export type BridgeRequest = {
  id: string
  method: string
  params: unknown
}

/** Parent reply — success. */
export type BridgeSuccess = {
  id: string
  ok: true
  result: unknown
}

/** Parent reply — failure (never throws across the bridge). */
export type BridgeFailure = {
  id: string
  ok: false
  error: { message: string }
}

export type BridgeReply = BridgeSuccess | BridgeFailure

export function isBridgeRequest(value: unknown): value is BridgeRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return (
    typeof record.id === 'string' &&
    record.id.length > 0 &&
    typeof record.method === 'string' &&
    record.method.length > 0
  )
}

export function isBridgeReply(value: unknown): value is BridgeReply {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  if (typeof record.id !== 'string' || record.id.length === 0) return false
  if (record.ok === true) return true
  if (record.ok === false) {
    const error = record.error
    return (
      !!error &&
      typeof error === 'object' &&
      !Array.isArray(error) &&
      typeof (error as Record<string, unknown>).message === 'string'
    )
  }
  return false
}

/** Protocol-level failure: the socket must close (fail-closed). */
export class BridgeProtocolError extends Error {
  readonly kind: 'malformed' | 'oversized'

  constructor(kind: 'malformed' | 'oversized', message: string) {
    super(message)
    this.name = 'BridgeProtocolError'
    this.kind = kind
  }
}

/** Typed error used to kill pending requests when the bridge closes. */
export class BridgeClosedError extends Error {
  constructor(message = 'bridge socket closed') {
    super(message)
    this.name = 'BridgeClosedError'
  }
}

/**
 * Encodes one ndjson message as a newline-terminated line, enforcing the
 * per-message cap. Throws {@link BridgeProtocolError} for non-serializable
 * values (malformed) or oversized payloads — callers close the socket.
 */
export function encodeBridgeMessage(value: unknown): string {
  let line: string
  try {
    line = JSON.stringify(value)
  } catch (error) {
    throw new BridgeProtocolError(
      'malformed',
      `bridge message is not JSON-serializable: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  if (line === undefined) {
    throw new BridgeProtocolError('malformed', 'bridge message serialized to undefined')
  }
  if (Buffer.byteLength(line, 'utf8') > BRIDGE_MAX_MESSAGE_BYTES) {
    throw new BridgeProtocolError(
      'oversized',
      `bridge message exceeds the ${BRIDGE_MAX_MESSAGE_BYTES}-byte cap`,
    )
  }
  return `${line}\n`
}

/**
 * Incremental ndjson line reader over a byte stream (Bun.Socket-ish or
 * node:net socket). Emits complete newline-terminated lines; a line beyond
 * the cap (or a partial buffer growing past it) raises a protocol error so
 * the caller can fail closed. Malformed JSON is the CALLER's concern: the
 * reader delivers raw lines.
 */
export function createNdjsonLineReader(options: {
  onLine: (line: string) => void
  onProtocolError: (error: BridgeProtocolError) => void
}): (chunk: Uint8Array) => void {
  const { onLine, onProtocolError } = options
  const decoder = new TextDecoder()
  let buffer = ''
  return (chunk) => {
    buffer += decoder.decode(chunk, { stream: true })
    for (;;) {
      const newlineIndex = buffer.indexOf('\n')
      if (newlineIndex === -1) {
        if (Buffer.byteLength(buffer, 'utf8') > BRIDGE_MAX_MESSAGE_BYTES) {
          const error = new BridgeProtocolError(
            'oversized',
            `bridge message exceeds the ${BRIDGE_MAX_MESSAGE_BYTES}-byte cap`,
          )
          buffer = ''
          onProtocolError(error)
        }
        return
      }
      const line = buffer.slice(0, newlineIndex)
      buffer = buffer.slice(newlineIndex + 1)
      if (Buffer.byteLength(line, 'utf8') > BRIDGE_MAX_MESSAGE_BYTES) {
        onProtocolError(
          new BridgeProtocolError(
            'oversized',
            `bridge message exceeds the ${BRIDGE_MAX_MESSAGE_BYTES}-byte cap`,
          ),
        )
        continue
      }
      onLine(line)
    }
  }
}

// ── Wire markers for non-serializable param members ────────────────────────
// The child replaces non-serializable param members (AbortSignal instances,
// logger objects, live Date instances) with nonce-stamped markers before
// sending; the parent
// rehydrates them with its own live values (see child-bridge-client.ts /
// parent-bridge-server.ts). Remaining function-valued members (optional
// callback hooks such as onCostCalculated) are dropped by the sanitizer.
//
// COLLISION-PROOF SENTINEL: a marker is recognized parent-side ONLY when it
// carries the exact per-table `nonce` minted alongside the handler table
// (buildSupervisedBridgeHandlers) and shared with the child through the
// request envelope (`rpcBridgeNonce`, stamped by the supervised-spawn seam).
// Agent-authored param data that happens to carry the `__openbuffBridge` key
// — with a different nonce, or none at all (e.g. the legacy content-only
// `{ __openbuffBridge: 'logger' }` shape below) — is DATA: it crosses the
// bridge verbatim and is never substituted parent-side with a live Logger, a
// fresh AbortSignal, or a live Date.
export const BRIDGE_MARKER_KEY = '__openbuffBridge'

export type BridgeMarkerKind = 'logger' | 'signal' | 'date'

/** A nonce-stamped wire marker (see the collision-proof sentinel note above). */
export type BridgeWireMarker = {
  __openbuffBridge: BridgeMarkerKind
  nonce: string
}

/** Mints a nonce-stamped wire marker for `kind` (child-side sanitizer).
 * Date markers use {@link createBridgeDateWireMarker} (three-key shape). */
export function createBridgeWireMarker(
  kind: Exclude<BridgeMarkerKind, 'date'>,
  nonce: string,
): BridgeWireMarker {
  return { [BRIDGE_MARKER_KEY]: kind, nonce }
}

/**
 * True ONLY when `value` is an EXACT pure wire marker of `kind` stamped with
 * EXACTLY `nonce` — i.e. precisely the two-key object
 * `{ __openbuffBridge: kind, nonce }` that {@link createBridgeWireMarker}
 * emits. A mismatching or absent nonce, or extra agent-authored members
 * riding alongside a correct nonce, means the value is DATA and must cross
 * the bridge verbatim — this exact-shape/exact-nonce gate is the
 * collision-proof sentinel.
 */
export function isBridgeWireMarker(
  value: unknown,
  kind: Exclude<BridgeMarkerKind, 'date'>,
  nonce: string,
): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  const keys = Object.keys(record)
  if (keys.length !== 2) return false
  return record[BRIDGE_MARKER_KEY] === kind && record.nonce === nonce
}

/**
 * True for ANY `__openbuffBridge`-keyed marker-shaped object (any marker
 * kind, any nonce). NOT a recognition predicate: the child sanitizer uses it to
 * pass already-marked values through untouched instead of re-processing
 * them; only {@link isBridgeWireMarker} with the exact nonce authorizes
 * parent-side substitution.
 */
export function isBridgeMarkerShaped(
  value: unknown,
): value is { __openbuffBridge: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const kind = (value as Record<string, unknown>)[BRIDGE_MARKER_KEY]
  return kind === 'logger' || kind === 'signal' || kind === 'date'
}

/**
 * Legacy content-only markers (the pre-nonce wire shape). They are NEVER
 * recognized parent-side: a `__openbuffBridge`-keyed object without the
 * exact per-table nonce crosses the bridge as data. The child sanitizer
 * emits them only when the request carries no `rpcBridgeNonce` (raw handler
 * tables, which never rehydrated), preserving that historical wire shape.
 */
export const BRIDGE_LOGGER_MARKER = { __openbuffBridge: 'logger' } as const
export const BRIDGE_SIGNAL_MARKER = { __openbuffBridge: 'signal' } as const

// ── Date wire marker ───────────────────────────────────────────────
// A live Date param (e.g. AddAgentStepFn's required `startTime: Date`) cannot
// survive the plain-object sanitize walk: Object.entries of a Date has no own
// enumerable properties, so the child would deliver `{}` where the in-process
// path delivers a Date. Instead the child emits this THREE-key nonce-stamped
// marker and the parent rehydrates a live `new Date(iso)` on an exact nonce
// match — the same collision-proof sentinel as logger/signal, extended with
// the ISO payload. An `__openbuffBridge: 'date'` object with a mismatching
// nonce, a non-string `iso`, or extra agent-authored members is DATA and
// crosses verbatim.

/** A nonce-stamped Date wire marker (child-side sanitizer emission). */
export type BridgeDateWireMarker = {
  __openbuffBridge: 'date'
  nonce: string
  iso: string
}

/** Mints a nonce-stamped Date wire marker for a live `Date` param. */
export function createBridgeDateWireMarker(
  date: Date,
  nonce: string,
): BridgeDateWireMarker {
  return { [BRIDGE_MARKER_KEY]: 'date', nonce, iso: date.toISOString() }
}

/**
 * True ONLY for the EXACT three-key pure date marker
 * `{ __openbuffBridge: 'date', nonce, iso }` stamped with EXACTLY `nonce`
 * (see {@link createBridgeDateWireMarker}). A mismatching or absent nonce, a
 * non-string `iso`, or extra agent-authored members means DATA: it crosses
 * the bridge verbatim and is never rehydrated into a live Date.
 */
export function isBridgeDateWireMarker(
  value: unknown,
  nonce: string,
): value is BridgeDateWireMarker {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  if (Object.keys(record).length !== 3) return false
  return (
    record[BRIDGE_MARKER_KEY] === 'date' &&
    record.nonce === nonce &&
    typeof record.iso === 'string'
  )
}

/**
 * Bounded stderr diagnostic logger shared by both bridge sides. Diagnostics
 * go to stderr ONLY (never parsed into receipts / bridge messages) and are
 * size-capped per line so a logging loop cannot balloon the 64 KiB stderr
 * capture cap into silence.
 */
export function createBridgeStderrLogger(scope: string): Logger {
  const write = (
    level: 'debug' | 'info' | 'warn' | 'error',
    data: unknown,
    msg?: string,
  ): void => {
    let detail = ''
    try {
      detail = JSON.stringify(data) ?? ''
    } catch {
      detail = '[unserializable]'
    }
    if (detail.length > 2_000) detail = `${detail.slice(0, 2_000)}…`
    process.stderr.write(
      `[${scope}] ${level}${msg ? `: ${msg}` : ''}${detail ? ` ${detail}` : ''}\n`,
    )
  }
  return {
    debug: (data, msg) => {
      write('debug', data, msg)
    },
    info: (data, msg) => {
      write('info', data, msg)
    },
    warn: (data, msg) => {
      write('warn', data, msg)
    },
    error: (data, msg) => {
      write('error', data, msg)
    },
  }
}

// ── Result round-trip-safety validation (fail-closed) ──────────────

/** Bounded walk depth for {@link findNonRoundTripSafeResultPaths}. */
const RESULT_SAFETY_WALK_MAX_DEPTH = 12

/** Bounded number of reported offending paths per validation. */
const RESULT_SAFETY_MAX_OFFENSES = 8

function isZodSchemaLike(record: Record<string, unknown>): boolean {
  return (
    typeof record.parse === 'function' &&
    typeof record.safeParse === 'function'
  )
}

/**
 * Paths of members of a parent-side handler RESULT that cannot survive the
 * JSON round trip intact. Used to fail closed BEFORE a structurally damaged
 * value crosses the wire (the bridged `fetchAgentFromDatabase` result: a
 * template carrying a programmatic `handleSteps` function or live
 * `z.ZodSchema` inputSchema.prompt/params / outputSchema instances would
 * otherwise reach the child with those members dropped/degraded — a silent
 * divergence from the contract the in-process path satisfies):
 *  - function-valued members are DROPPED by JSON.stringify;
 *  - live zod schema instances degrade to partial plain objects (their
 *    runtime internals are not own enumerable properties);
 *  - live Date instances degrade to ISO strings.
 * Bounded: the walk stops at a fixed depth and reports at most
 * {@link RESULT_SAFETY_MAX_OFFENSES} paths — a diagnostic, not an audit.
 */
export function findNonRoundTripSafeResultPaths(value: unknown): string[] {
  const offenses: string[] = []
  const walk = (node: unknown, path: string, depth: number): void => {
    if (offenses.length >= RESULT_SAFETY_MAX_OFFENSES) return
    if (typeof node === 'function') {
      offenses.push(
        `${path || '<result>'}: function-valued member (dropped by JSON.stringify)`,
      )
      return
    }
    if (node === null || typeof node !== 'object') return
    if (depth > RESULT_SAFETY_WALK_MAX_DEPTH) return
    if (node instanceof Date) {
      offenses.push(
        `${path || '<result>'}: live Date instance (degrades to an ISO string across the JSON wire)`,
      )
      return
    }
    if (Array.isArray(node)) {
      node.forEach((item, index) => walk(item, `${path}[${index}]`, depth + 1))
      return
    }
    const record = node as Record<string, unknown>
    if (isZodSchemaLike(record)) {
      offenses.push(
        `${path || '<result>'}: live zod schema instance (degrades to a partial plain object across the JSON wire)`,
      )
      return
    }
    for (const [key, item] of Object.entries(record)) {
      walk(item, path ? `${path}.${key}` : key, depth + 1)
    }
  }
  walk(value, '', 0)
  return offenses
}

// ── Per-method wire shapes derived from the real dep signatures ───────────

/** Wire result of the bridged `promptAiSdkStream` (streaming limitation). */
export type BridgedPromptStreamResult = {
  chunks: StreamChunk[]
  result: PromptResult<string | null>
  /**
   * Set when aggregate chunk bytes exceeded
   * {@link BRIDGE_MAX_STREAM_CHUNKS_BYTES}: the dropped tail kept the reply
   * under the per-message cap. The child logs this LOUDLY on stderr — a
   * bounded bridge is never a silent drop.
   */
  truncated?: boolean
}

/** Wire params/result of the bridged `fetch` (Response reconstructed child-side). */
export type BridgedFetchParams = {
  input: string
  init?: {
    method?: string
    headers?: Record<string, string>
    body?: string
  }
}

export type BridgedFetchResult = {
  status: number
  statusText: string
  headers: Record<string, string>
  bodyText: string
}

export type PromptAiSdkStreamParams = Parameters<PromptAiSdkStreamFn>[0]
export type PromptAiSdkParams = Parameters<PromptAiSdkFn>[0]
export type PromptAiSdkStructuredParams = Parameters<PromptAiSdkStructuredFn>[0]
export type {
  PromptAiSdkFn,
  PromptAiSdkStreamFn,
  PromptAiSdkStructuredFn,
  TrackEventFn,
  SendActionFn,
  RequestToolCallFn,
  RequestFilesFn,
  RequestOptionalFileFn,
  RequestMcpToolDataFn,
  HandleStepsLogChunkFn,
  SendSubagentChunkFn,
  StartAgentRunFn,
  FinishAgentRunFn,
  AddAgentStepFn,
  FetchAgentFromDatabaseFn,
  ConsumeCreditsWithFallbackFn,
  Logger,
}
