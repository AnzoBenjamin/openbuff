/**
 * P2-T8b: parent-side RPC bridge server.
 *
 * Listens on a Unix socket INSIDE the spawn's 0700 mkdtemp sandbox and
 * dispatches each child request to the matching handler.
 *
 * Socket auth model: NO extra token is needed — the socket file lives in the
 * per-spawn mkdtemp directory created with mode 0700 (owner-only), so only
 * processes of the owning user (the parent and its own child) can reach it,
 * and the directory is ephemeral: it is removed with the sandbox right after
 * settle. The path itself is passed to the child via the request file, which
 * is likewise 0600 inside the same sandbox.
 *
 * Transport: node:net Unix sockets for BOTH server and client (preferred over
 * Bun.listen/Bun.connect per the design risk note — identical API in Bun and
 * Node, cross-runtime safe, no new dependency).
 *
 * Fail-closed: a malformed line or an oversized message destroys the
 * connection; an unknown/unbridged method or a busy server gets a structured
 * error reply (never a crash), a saturated fire-and-forget notify budget gets
 * 'bridge_notify_overflow', and a handler throw becomes `{ ok: false, error }`.
 * `close()` cancels any in-flight `promptAiSdkStream` iterator the handler
 * table registered for teardown (see
 * {@link SupervisedBridgeHandlerTable.cancelInFlightStreams}), kills in-flight
 * handler promises with a typed {@link BridgeClosedError} and unlinks the
 * socket file.
 *
 * P2-T8c INCREMENTAL streams: `promptAiSdkStreamStart` / `promptAiSdkStreamNext`
 * / `promptAiSdkStreamStop` bridge the prompt stream chunk-by-chunk (one chunk
 * per reply — no aggregation, none of the legacy full-collection truncation
 * budget) through a per-server registry bounded by
 * {@link MAX_CONCURRENT_BRIDGE_STREAMS}; every entry registers its teardown in
 * the SAME activeStreamCancels set, so close()'s existing
 * cancelInFlightStreams probe drains unfinished incremental streams alongside
 * the legacy collectors (no second kill path). The legacy full-collection
 * `promptAiSdkStream` handler is UNCHANGED.
 */
import { unlinkSync } from 'node:fs'
import * as net from 'node:net'

import { convertJsonSchemaToZod } from 'zod-from-json-schema'
import { z } from 'zod/v4'

import { realIdGen } from '@codebuff/common/deps/real-runtime-deps'

import {
  coerceJsonSchemaMember,
  ensureAgentTemplateZodSchemas,
} from '@codebuff/common/templates/agent-validation'

import {
  BRIDGE_CLOSE_ID,
  BRIDGE_MAX_STREAM_CHUNKS_BYTES,
  BRIDGE_MAX_STREAM_NEXT_REPLY_BYTES,
  BridgeClosedError,
  createBridgeStderrLogger,
  createNdjsonLineReader,
  createStreamTruncationErrorResult,
  encodeBridgeMessage,
  findNonRoundTripSafeResultPaths,
  isBridgeDateWireMarker,
  isBridgeMethod,
  isBridgeRequest,
  isBridgeWireMarker,
  type BridgedFetchParams,
  type BridgedPromptStreamResult,
  type BridgeReply,
  type BridgeMethod,
  type Logger,
  type PromptAiSdkFn,
  type PromptAiSdkStreamFn,
  type PromptAiSdkStreamNextParams,
  type PromptAiSdkStreamNextResult,
  type PromptAiSdkStreamParams,
  type PromptAiSdkStreamStartParams,
  type PromptAiSdkStreamStartResult,
  type PromptAiSdkStreamStopParams,
  type PromptAiSdkStructuredFn,
  type SendActionFn,
  type TrackEventFn,
} from './bridge-protocol'
import type { AgentTemplate } from '@codebuff/common/types/agent-template'
import type { ConsumeCreditsWithFallbackFn } from '@codebuff/common/types/contracts/billing'
import type { HandleStepsLogChunkFn, RequestFilesFn, RequestMcpToolDataFn, RequestOptionalFileFn, RequestToolCallFn, SendSubagentChunkFn } from '@codebuff/common/types/contracts/client'
import type { AddAgentStepFn, FetchAgentFromDatabaseFn, FinishAgentRunFn, StartAgentRunFn } from '@codebuff/common/types/contracts/database'
import type { StreamChunk } from '@codebuff/common/types/contracts/llm'
import type { PromptResult as PromptResultType } from '@codebuff/common/util/error'

/** Bound on concurrently in-flight REQUEST handler invocations; beyond it
 * requests get a structured 'bridge_busy' error reply (fail-closed, no
 * unbounded fan-out). */
export const MAX_CONCURRENT_BRIDGE_REQUESTS = 64

/**
 * Separate bound for fire-and-forget notifications (child ids prefixed
 * `notify-`: sendAction, handleStepsLogChunk, sendSubagentChunk, trackEvent).
 * Notifications get their OWN budget so display-stream chunks can neither be
 * starved by long prompt handlers nor crowd real requests out of the shared
 * dispatcher. Beyond it a notification gets a structured
 * 'bridge_notify_overflow' error reply, which the child client logs loudly on
 * stderr — saturation is never a silent drop of the display stream.
 */
export const MAX_CONCURRENT_BRIDGE_NOTIFIES = 128

/**
 * Bounded cap on the per-server incremental stream registry
 * (`promptAiSdkStreamStart`, P2-T8c). A child that keeps starting streams
 * without consuming or stopping them cannot grow the registry past this bound:
 * an overflow start request gets the structured 'too many concurrent streams'
 * error reply (the child wrapper throws it through the generator). Registry
 * entries are removed when a stream finishes (`next` → done, which includes
 * the final PromptResult), on an explicit `promptAiSdkStreamStop` (which tears
 * the provider iterator down exactly like the legacy cancelStream), or when
 * the server's close() runs (close() drains this registry through
 * cancelInFlightStreams-style teardown). A child that never calls stop and
 * whose stream never ends must still be bounded: the cap above + forced
 * close() (the supervisor's crash/deadline path) is that bound.
 */
export const MAX_CONCURRENT_BRIDGE_STREAMS = 256

/** One entry of the incremental-stream registry (see
 * MAX_CONCURRENT_BRIDGE_STREAMS). Fields are NEVER serialized. */
export type IncrementalStreamEntry = {
  /** Provider iterator started by the start handler. */
  iterator: AsyncGenerator<StreamChunk, PromptResultType<string | null>, void>
  /** Per-stream AbortController, aborted when the stream is torn down. */
  abort: AbortController
  /** Cancel bookkeeping for the close() drain (see cancelInFlightStreams). */
  cancel: () => void
  /** Reserved-bytes slot from the design's registry shape ({ id, iterator,
   * reservedBytes }): the incremental path aggregates NOTHING (each reply is
   * one chunk, capped by BRIDGE_MAX_STREAM_NEXT_REPLY_BYTES), so this stays 0
   * — the legacy full-collection budget never applies to these entries. */
  readonly reservedBytes: number
}

/**
 * Handler table: a partial record keyed by the bridged method names, with
 * param shapes derived from the real dep signatures (the dispatch boundary
 * casts the JSON-parsed params once — that parse is the trust boundary).
 * The `never` param keeps RAW dep functions assignable (their specific
 * params accept never) while still allowing unknown-param wrappers.
 */
export type ParentBridgeHandlers = Partial<
  Record<BridgeMethod, (params: never) => unknown>
>

/**
 * The handler table built by {@link buildSupervisedBridgeHandlers}: the
 * bridge methods plus the per-table marker nonce (see bridge-protocol.ts's
 * collision-proof sentinel) that the supervised-spawn seam stamps into the
 * request envelope (`rpcBridgeNonce`) for the child side. Assignable to
 * {@link ParentBridgeHandlers} everywhere the plain table is accepted.
 */
export type SupervisedBridgeHandlerTable = ParentBridgeHandlers & {
  readonly bridgeNonce: string
  /**
   * Cancels every in-flight `promptAiSdkStream` iterator this table is
   * currently collecting: it aborts the rehydrated per-collection
   * AbortSignal (so a provider stream blocked mid-chunk stops producing
   * promptly) and invokes `iterator.return()`, which runs the generator's
   * finally blocks exactly like the consumer's early return on the
   * in-process path. `startParentBridgeServer.close()` probes for this hook
   * STRUCTURALLY and calls it BEFORE killing pending handlers — a killed
   * stream collector must not keep consuming the provider stream into an
   * unbounded array with no consumer (continued provider spend + memory
   * growth). Raw handler tables without the hook are unaffected (the probe
   * skips them).
   */
  readonly cancelInFlightStreams: () => void
}

export type ParentBridgeServer = {
  /** Resolves once the socket is listening (before the child is spawned). */
  ready: Promise<void>
  /** Idempotent. Cancels in-flight bridged promptAiSdkStream iterators (see
   * SupervisedBridgeHandlerTable.cancelInFlightStreams), kills pending
   * handlers with BridgeClosedError, destroys connections, closes + unlinks
   * the socket. */
  close: () => Promise<void>
}

/**
 * Starts the parent bridge server on `socketPath`. Dispatches each child
 * request to the matching handler; every reply is newline-delimited JSON
 * within the 16 MiB per-message cap.
 */
export function startParentBridgeServer(
  handlers: ParentBridgeHandlers,
  socketPath: string,
  onRequestActivity?: () => void,
): ParentBridgeServer {
  const logger = createBridgeStderrLogger('parent-bridge')
  const sockets = new Set<net.Socket>()
  const closedRejects = new Set<(error: BridgeClosedError) => void>()
  let inFlightCount = 0
  let inFlightNotifyCount = 0
  let closed = false
  let closePromise: Promise<void> | undefined

  const server = net.createServer((socket) => {
    sockets.add(socket)
    const readLine = createNdjsonLineReader({
      onLine: (line) => {
        handleLine(socket, line)
      },
      // Malformed/oversized framing: fail closed (destroy the connection).
      onProtocolError: (error) => {
        logger.warn({ error: error.message }, 'bridge protocol error; closing socket')
        socket.destroy()
      },
    })
    socket.on('data', (chunk) => {
      readLine(new Uint8Array(chunk))
    })
    socket.on('error', () => {
      sockets.delete(socket)
    })
    socket.on('close', () => {
      sockets.delete(socket)
    })
  })

  const reply = (socket: net.Socket, message: BridgeReply): void => {
    try {
      socket.write(encodeBridgeMessage(message))
    } catch {
      // Unencodable reply (e.g. oversized result): fail closed.
      socket.destroy()
    }
  }

  const handleLine = (socket: net.Socket, line: string): void => {
    if (closed) return
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      // Malformed line: fail closed.
      socket.destroy()
      return
    }
    if (!isBridgeRequest(parsed)) {
      socket.destroy()
      return
    }
    // Every well-formed request/notification is an activity signal for the
    // supervisor's idle deadline (counted before method/budget checks so a
    // busy or unknown-method request still proves the child is alive).
    onRequestActivity?.()
    const failureReply = (message: string): void => {
      reply(socket, { id: parsed.id, ok: false, error: { message } })
    }
    if (!isBridgeMethod(parsed.method)) {
      failureReply(`unknown bridge method: ${parsed.method}`)
      return
    }
    const handler = handlers[parsed.method]
    if (!handler) {
      failureReply(`bridge method not supplied by the parent: ${parsed.method}`)
      return
    }
    // Fire-and-forget notifications (child ids prefixed `notify-`) get their
    // OWN bounded budget, separate from request/response traffic: at saturation
    // the notification gets a structured 'bridge_notify_overflow' error reply
    // (the child logs it loudly) instead of silently dropping the chunk.
    const isNotify = parsed.id.startsWith('notify-')
    if (isNotify) {
      if (inFlightNotifyCount >= MAX_CONCURRENT_BRIDGE_NOTIFIES) {
        failureReply(
          `bridge_notify_overflow: more than ${MAX_CONCURRENT_BRIDGE_NOTIFIES} concurrent fire-and-forget notifications`,
        )
        return
      }
      inFlightNotifyCount += 1
    } else if (inFlightCount >= MAX_CONCURRENT_BRIDGE_REQUESTS) {
      failureReply(
        `bridge_busy: more than ${MAX_CONCURRENT_BRIDGE_REQUESTS} concurrent bridge requests`,
      )
      return
    } else {
      inFlightCount += 1
    }
    let killPending: ((error: BridgeClosedError) => void) | undefined
    const killed = new Promise<never>((_, reject) => {
      killPending = reject
      closedRejects.add(reject)
    })
    killed.catch(() => {}) // avoid unhandled rejection when not raced
    // Invoke the handler INSIDE a try/catch: a SYNCHRONOUS throw (e.g.
    // promptAiSdkStructured's convertJsonSchemaToZod rejecting a
    // child-supplied JSON Schema before any promise exists) must become a
    // structured error reply like any async rejection — never an uncaught
    // exception escaping handleLine → the socket 'data' listener → the
    // parent (supervisor) process.
    let handlerOutcome: unknown
    try {
      handlerOutcome = handler(parsed.params as never)
    } catch (error) {
      handlerOutcome = Promise.reject(error)
    }
    void Promise.race([Promise.resolve(handlerOutcome), killed])
      .then((result) => {
        reply(socket, { id: parsed.id, ok: true, result })
      })
      .catch((error) => {
        reply(socket, {
          id: parsed.id,
          ok: false,
          error: {
            message: error instanceof Error ? error.message : String(error),
          },
        })
      })
      .finally(() => {
        if (isNotify) inFlightNotifyCount -= 1
        else inFlightCount -= 1
        if (killPending) closedRejects.delete(killPending)
      })
  }

  const ready = new Promise<void>((resolve, reject) => {
    server.once('error', (error) => {
      reject(
        error instanceof Error
          ? error
          : new Error(`parent bridge server failed: ${String(error)}`),
      )
    })
    server.once('listening', () => {
      resolve()
    })
    server.listen(socketPath)
  })

  const close = (): Promise<void> => {
    if (closePromise) return closePromise
    closed = true
    // Cancel in-flight promptAiSdkStream iterators BEFORE killing the pending
    // handler promises (compatibility-reviewer:
    // stream-iterator-not-cancelled-on-bridge-close): the killed collector
    // must stop consuming the provider stream instead of buffering chunks
    // with no consumer. Raw handler tables without the hook skip this no-op.
    const cancelInFlightStreams = (
      handlers as Partial<SupervisedBridgeHandlerTable>
    ).cancelInFlightStreams
    if (typeof cancelInFlightStreams === 'function') cancelInFlightStreams()
    const closeError = new BridgeClosedError('parent bridge server closed')
    for (const reject of closedRejects) reject(closeError)
    closedRejects.clear()
    // Fail the child side closed deterministically: this final close-notification
    // reply lets a connected client settle its pending (and subsequent) calls
    // with a typed BridgeClosedError even where the idle socket's 'close' event
    // is slow to propagate. Sent ONLY here in close(), never on handler errors
    // (those get their own per-request error replies).
    const closeNotification = encodeBridgeMessage({
      id: BRIDGE_CLOSE_ID,
      ok: false,
      error: { message: 'bridge closed by parent' },
    })
    for (const socket of sockets) {
      try {
        socket.write(closeNotification)
      } catch {
        // Already-dead socket: the destroy below is the fail-closed path.
      }
      socket.destroy()
    }
    sockets.clear()
    try {
      unlinkSync(socketPath)
    } catch {
      // Socket file already gone (or never created).
    }
    closePromise = new Promise<void>((resolve) => {
      try {
        // Destroyed sockets end promptly; the callback fires once all do.
        server.close(() => {
          resolve()
        })
      } catch {
        // Server was never listening (ready already rejected).
        resolve()
      }
    })
    return closePromise
  }

  return { ready, close }
}

// ── Handler-table builder (rehydration of sanitized wire params) ──────────

/**
 * The deps the SDK impl seam supplies for the supervised-child bridge. The
 * builder wraps each raw dep so the JSON-sanitized wire params are rehydrated
 * into the live shapes the real deps expect.
 */
export type SupervisedBridgeHandlerDeps = {
  promptAiSdkStream: PromptAiSdkStreamFn
  promptAiSdk: PromptAiSdkFn
  promptAiSdkStructured: PromptAiSdkStructuredFn
  sendAction: SendActionFn
  requestToolCall: RequestToolCallFn
  requestFiles: RequestFilesFn
  requestOptionalFile: RequestOptionalFileFn
  requestMcpToolData: RequestMcpToolDataFn
  handleStepsLogChunk: HandleStepsLogChunkFn
  sendSubagentChunk: SendSubagentChunkFn
  trackEvent: TrackEventFn
  fetch: typeof globalThis.fetch
  startAgentRun: StartAgentRunFn
  finishAgentRun: FinishAgentRunFn
  addAgentStep: AddAgentStepFn
  fetchAgentFromDatabase: FetchAgentFromDatabaseFn
  consumeCreditsWithFallback: ConsumeCreditsWithFallbackFn
  /** The PARENT's own credential, stamped into every bridged request whose
   * real dep takes an `apiKey` — the child's copied value is a fallback
   * only (the child reads its allowlisted OPENBUFF_API_KEY, which matches
   * for Openbuff-key runs but not for BYOK runs). */
  apiKey: string
  /** Parent-side logger rehydrated into sanitized params. */
  logger?: Logger
}

/**
 * Rehydrates nonce-stamped wire markers (see bridge-protocol.ts's
 * collision-proof sentinel) into live values. ONLY a marker whose `nonce`
 * equals the per-table `bridgeNonce` is substituted — a `__openbuffBridge`-
 * keyed object with a mismatching or absent nonce (the legacy content-only
 * shape, or agent-authored data) crosses verbatim.
 */
function rehydrateParams(
  params: unknown,
  logger: Logger,
  bridgeNonce: string,
): unknown {
  const walk = (value: unknown, depth: number): unknown => {
    if (value === null || typeof value !== 'object') return value
    if (depth > 12) return undefined // bounded: drop runaway structures
    if (Array.isArray(value)) {
      return value.map((item) => walk(item, depth + 1))
    }
    if (isBridgeWireMarker(value, 'logger', bridgeNonce)) return logger
    if (isBridgeWireMarker(value, 'signal', bridgeNonce)) {
      return new AbortController().signal
    }
    // Nonce-stamped date markers (e.g. AddAgentStepFn's `startTime: Date`)
    // rehydrate into a live `new Date(iso)` — the real dep receives the same
    // typed shape the in-process path supplies, never the `{}` a Date would
    // collapse to across a plain-object JSON walk.
    if (isBridgeDateWireMarker(value, bridgeNonce)) {
      return new Date(value.iso)
    }
    const record = value as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(record)) {
      out[key] = walk(item, depth + 1)
    }
    return out
  }
  return walk(params, 0)
}

/**
 * Whether a value is a LIVE zod schema — the exact passthrough predicate
 * coerceJsonSchemaMember applies (v4 `_zod` internals present, or a
 * `safeParse` function), so a stashed member can never bypass coercion that
 * the coercion step itself would have applied.
 */
function isLiveZodSchemaValue(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }
  const record = value as { _zod?: unknown; safeParse?: unknown }
  return record._zod !== undefined || typeof record.safeParse === 'function'
}

/** Live zod schema members stashed from the RAW wire params before
 * rehydrateParams' plain-object walk (see rehydratePromptParamsForBridge
 * for why the stash exists). */
type LivePromptSchemaStash = {
  toolSchemas: Map<string, { inputSchema?: unknown; outputSchema?: unknown }>
  templateSchemas: Map<
    string,
    { prompt?: unknown; params?: unknown; outputSchema?: unknown }
  >
}

/** Stashes every LIVE zod schema member from the raw wire params:
 * tools[name].inputSchema / .outputSchema and each localAgentTemplates
 * value's inputSchema.prompt / .params / outputSchema. Non-object entries
 * are skipped defensively, never thrown on. */
function stashLivePromptSchemaMembers(params: unknown): LivePromptSchemaStash {
  const stash: LivePromptSchemaStash = {
    toolSchemas: new Map(),
    templateSchemas: new Map(),
  }
  const record = (params ?? {}) as Record<string, unknown>
  const tools = record.tools
  if (tools && typeof tools === 'object' && !Array.isArray(tools)) {
    const toolMap = tools as Record<string, unknown>
    for (const [name, tool] of Object.entries(toolMap)) {
      if (!tool || typeof tool !== 'object' || Array.isArray(tool)) continue
      const toolRecord = tool as Record<string, unknown>
      const entry: { inputSchema?: unknown; outputSchema?: unknown } = {}
      if (isLiveZodSchemaValue(toolRecord.inputSchema)) {
        entry.inputSchema = toolRecord.inputSchema
      }
      if (isLiveZodSchemaValue(toolRecord.outputSchema)) {
        entry.outputSchema = toolRecord.outputSchema
      }
      if (entry.inputSchema !== undefined || entry.outputSchema !== undefined) {
        stash.toolSchemas.set(name, entry)
      }
    }
  }
  const localAgentTemplates = record.localAgentTemplates
  if (
    localAgentTemplates &&
    typeof localAgentTemplates === 'object' &&
    !Array.isArray(localAgentTemplates)
  ) {
    const templateMap = localAgentTemplates as Record<string, unknown>
    for (const [id, template] of Object.entries(templateMap)) {
      if (!template || typeof template !== 'object' || Array.isArray(template)) {
        continue
      }
      const templateRecord = template as Record<string, unknown>
      const inputSchema = templateRecord.inputSchema as
        | Record<string, unknown>
        | undefined
      const entry: {
        prompt?: unknown
        params?: unknown
        outputSchema?: unknown
      } = {}
      if (isLiveZodSchemaValue(inputSchema?.prompt)) {
        entry.prompt = inputSchema?.prompt
      }
      if (isLiveZodSchemaValue(inputSchema?.params)) {
        entry.params = inputSchema?.params
      }
      if (isLiveZodSchemaValue(templateRecord.outputSchema)) {
        entry.outputSchema = templateRecord.outputSchema
      }
      if (
        entry.prompt !== undefined ||
        entry.params !== undefined ||
        entry.outputSchema !== undefined
      ) {
        stash.templateSchemas.set(id, entry)
      }
    }
  }
  return stash
}

/** Splices the stashed live members back into the rehydrated params so
 * their identity survives the walk (coerceJsonSchemaMember's by-reference
 * contract — never double-convert a live schema). */
function spliceLivePromptSchemaMembers(
  rehydrated: Record<string, unknown>,
  stash: LivePromptSchemaStash,
): void {
  if (stash.toolSchemas.size === 0 && stash.templateSchemas.size === 0) {
    return
  }
  const tools = rehydrated.tools
  if (tools && typeof tools === 'object' && !Array.isArray(tools)) {
    const toolMap = tools as Record<string, unknown>
    for (const [name, entry] of stash.toolSchemas) {
      const tool = toolMap[name]
      if (!tool || typeof tool !== 'object' || Array.isArray(tool)) continue
      const toolRecord = tool as Record<string, unknown>
      if (entry.inputSchema !== undefined) {
        toolRecord.inputSchema = entry.inputSchema
      }
      if (entry.outputSchema !== undefined) {
        toolRecord.outputSchema = entry.outputSchema
      }
    }
  }
  const templates = rehydrated.localAgentTemplates
  if (templates && typeof templates === 'object' && !Array.isArray(templates)) {
    const templateMap = templates as Record<string, unknown>
    for (const [id, entry] of stash.templateSchemas) {
      const template = templateMap[id]
      if (!template || typeof template !== 'object' || Array.isArray(template)) {
        continue
      }
      const templateRecord = template as Record<string, unknown>
      const rawInputSchema = templateRecord.inputSchema
      const inputSchema: Record<string, unknown> =
        rawInputSchema &&
        typeof rawInputSchema === 'object' &&
        !Array.isArray(rawInputSchema)
          ? { ...(rawInputSchema as Record<string, unknown>) }
          : {}
      if (entry.prompt !== undefined) inputSchema.prompt = entry.prompt
      if (entry.params !== undefined) inputSchema.params = entry.params
      templateRecord.inputSchema = inputSchema
      if (entry.outputSchema !== undefined) {
        templateRecord.outputSchema = entry.outputSchema
      }
    }
  }
}

/** Coerces ONE schema member for the bridged prompt params. A failing
 * coercion degrades to a NATIVE permissive loose-object zod schema — the
 * same "a working agent beats a crashed one" policy
 * serializeSchemaMemberForTransport applies — instead of crashing the
 * handler. The fallback MUST be native: convertJsonSchemaToZod's output for
 * degenerate shapes carries a z.custom(...) base-union branch that
 * z.toJSONSchema rejects ("Custom types cannot be represented in JSON
 * Schema"), so a poisoned conversion can never serve as the fallback. */
function coerceBridgeSchemaMember(value: unknown): unknown {
  try {
    return coerceJsonSchemaMember(value)
  } catch {
    return z.object({}).loose()
  }
}

/** Coerces ONE localAgentTemplates value through the established template
 * coercion (ensureAgentTemplateZodSchemas); on failure the template is
 * rebuilt with per-member coercion so one malformed member can never crash
 * the handler. */
function coerceBridgeAgentTemplate(template: unknown): unknown {
  if (!template || typeof template !== 'object' || Array.isArray(template)) {
    return template
  }
  const record = template as Record<string, unknown>
  try {
    return ensureAgentTemplateZodSchemas(record as unknown as AgentTemplate)
  } catch {
    const rawInputSchema = record.inputSchema
    const inputSchema =
      rawInputSchema &&
      typeof rawInputSchema === 'object' &&
      !Array.isArray(rawInputSchema)
        ? (rawInputSchema as Record<string, unknown>)
        : {}
    return {
      ...record,
      inputSchema: {
        ...(inputSchema.prompt !== undefined
          ? { prompt: coerceBridgeSchemaMember(inputSchema.prompt) }
          : {}),
        ...(inputSchema.params !== undefined
          ? { params: coerceBridgeSchemaMember(inputSchema.params) }
          : {}),
      },
      ...(record.outputSchema !== undefined
        ? { outputSchema: coerceBridgeSchemaMember(record.outputSchema) }
        : {}),
    }
  }
}

/** Applies the schema coercion to the rehydrated params IN PLACE. ONLY the
 * schema-bearing members are touched — messages, providerOptions and every
 * other member cross verbatim. */
function coerceBridgePromptSchemaMembers(
  rehydrated: Record<string, unknown>,
): void {
  const tools = rehydrated.tools
  if (tools && typeof tools === 'object' && !Array.isArray(tools)) {
    const toolMap = tools as Record<string, unknown>
    for (const tool of Object.values(toolMap)) {
      if (!tool || typeof tool !== 'object' || Array.isArray(tool)) continue
      const toolRecord = tool as Record<string, unknown>
      if (toolRecord.inputSchema !== undefined) {
        toolRecord.inputSchema = coerceBridgeSchemaMember(toolRecord.inputSchema)
      }
      if (toolRecord.outputSchema !== undefined) {
        toolRecord.outputSchema = coerceBridgeSchemaMember(
          toolRecord.outputSchema,
        )
      }
    }
  }
  const templates = rehydrated.localAgentTemplates
  if (templates && typeof templates === 'object' && !Array.isArray(templates)) {
    const templateMap = templates as Record<string, unknown>
    for (const [id, template] of Object.entries(templateMap)) {
      if (!template || typeof template !== 'object' || Array.isArray(template)) {
        continue
      }
      templateMap[id] = coerceBridgeAgentTemplate(template)
    }
  }
}

/**
 * Rehydrates bridged prompt params and re-coerces the schema-bearing
 * members into live zod before the REAL prompt deps run. Shared by the
 * three prompt handlers (the legacy collectPromptStream, the incremental
 * buildStreamParams path, and promptAiSdk). promptAiSdkStructured is
 * deliberately NOT routed through this helper: its schema crosses the
 * bridge as JSON Schema by design and is converted back explicitly.
 *
 * WHY (the H.typeName crash): the child's loopAgentSteps builds a live-zod
 * ToolSet and streams it through the bridge, but the child-side sanitize
 * walk degrades every zod schema into a husk that retains zod v4's
 * own-enumerable `~standard` marker while losing the prototype methods and
 * non-enumerable internals (`_zod`, `safeParse`). rehydrateParams restores
 * only the logger/signal/date markers, so a husk reaches
 * deps.promptAiSdkStream — whose streamText runs every
 * tools[name].inputSchema through the AI SDK's asSchema, routing the husk
 * to the zod-v3 converter, which reads `_def.typeName` on undefined and
 * crashes the spawn with "undefined is not an object (evaluating
 * 'H.typeName')". Every child LLM step passes at least the end_turn tool
 * through the bridge, so every spawn crashed.
 *
 * Coercion contract (coerceJsonSchemaMember): degraded husks and plain
 * JSON-Schema members are re-converted to live zod; already-live members
 * pass through BY REFERENCE (the request-file rehydrate path relies on the
 * by-reference contract — never double-convert); a member that cannot be
 * coerced degrades to a permissive `{ type: 'object' }` zod schema instead
 * of crashing the handler.
 *
 * Live members are stashed from the RAW wire params BEFORE rehydrateParams'
 * plain-object walk and spliced back in afterwards: the walk rebuilds every
 * object entry-by-entry, which would destroy a live schema's identity (and
 * with it the by-reference contract).
 */
function rehydratePromptParamsForBridge(
  params: unknown,
  logger: Logger,
  bridgeNonce: string,
): Record<string, unknown> {
  const stash = stashLivePromptSchemaMembers(params)
  const rehydrated = {
    ...(rehydrateParams(params, logger, bridgeNonce) as Record<
      string,
      unknown
    >),
  }
  spliceLivePromptSchemaMembers(rehydrated, stash)
  coerceBridgePromptSchemaMembers(rehydrated)
  return rehydrated
}

/**
 * Builds the full parent-side handler table for the bridged dep set.
 *
 * Rehydration rules (see child-bridge-client.ts for the sanitize side):
 *  - nonce-stamped wire markers (see bridge-protocol.ts's collision-proof
 *    sentinel) are rehydrated into live values ONLY on an exact `bridgeNonce`
 *    match; `__openbuffBridge`-keyed objects without that nonce are
 *    agent-authored DATA and cross verbatim. When `options.bridgeNonce` is
 *    omitted, a fresh per-table nonce is minted — the supervised-spawn seam
 *    reads it off the returned table ({@link SupervisedBridgeHandlerTable})
 *    and stamps it into the request envelope as `rpcBridgeNonce`;
 *  - prompt methods: nested `sendAction` / `trackEvent` / `logger` / `signal`
 *    are re-injected from the parent's own live deps (the child dropped them
 *    before sending); a fresh never-aborted AbortSignal is supplied — child
 *    cancellation flows as a bridge-level failure instead;
 *  - `promptAiSdkStructured`: the zod schema travels as JSON Schema and is
 *    converted back with `convertJsonSchemaToZod` (the same converter the
 *    tool-surface builder uses); wire params WITHOUT a schema fail closed
 *    (structured error reply) instead of widening to `{ type: 'object' }`;
 *  - `fetch`: the Response is flattened to status/headers/bodyText and
 *    reconstructed child-side;
 *  - `promptAiSdkStream` teardown: every in-flight collection registers a
 *    cancel hook and the built table exposes it as
 *    {@link SupervisedBridgeHandlerTable.cancelInFlightStreams} so the bridge
 *    server's close() cancels the underlying provider iterator (abort the
 *    rehydrated signal + `iterator.return()`), matching the in-process
 *    consumer-early-return teardown;
 *  - every method whose real dep takes an `apiKey` gets the PARENT's own
 *    apiKey stamped in (see {@link SupervisedBridgeHandlerDeps.apiKey});
 *  - `fetchAgentFromDatabase` / `consumeCreditsWithFallback` are bridged in
 *    addition to the design's enumerated 15. `fetchAgentFromDatabase`'s
 *    result is validated ROUND-TRIP-SAFE before it crosses the JSON wire
 *    ({@link findNonRoundTripSafeResultPaths}): a template carrying a
 *    programmatic `handleSteps` function or live `z.ZodSchema`
 *    inputSchema.prompt/params / outputSchema members is REJECTED with a
 *    structured error naming the offending paths (the child settles a
 *    failed receipt) instead of silently delivering a structurally damaged
 *    AgentTemplate — the in-process FetchAgentFromDatabaseFn contract is
 *    never silently diverged from;
 *  - every other method: markers are rehydrated, the dep is called directly.
 */
export function buildSupervisedBridgeHandlers(
  deps: SupervisedBridgeHandlerDeps,
  options?: {
    /**
     * Explicit per-table bridge marker nonce. When omitted, a fresh
     * `randomUUID` nonce is minted for this table.
     */
    bridgeNonce?: string
  },
): SupervisedBridgeHandlerTable {
  const logger = deps.logger ?? createBridgeStderrLogger('parent-bridge')
  const bridgeNonce = options?.bridgeNonce ?? realIdGen.uuid()

  // In-flight promptAiSdkStream cancellations (registered by
  // collectPromptStream below): close() drains this set so a killed stream
  // collector stops consuming the provider stream with no consumer.
  const activeStreamCancels = new Set<() => void>()

  const collectPromptStream = async (
    params: PromptAiSdkStreamParams,
  ): Promise<BridgedPromptStreamResult> => {
    // The rehydrated signal is OWNED by this collection: cancelling the
    // collection aborts it, so the real provider stream stops producing
    // (provider spend stops) even though no consumer will read the tail.
    const streamAbort = new AbortController()
    const rehydrated = {
      ...(rehydratePromptParamsForBridge(params, logger, bridgeNonce) as Record<
        string,
        unknown
      >),
      apiKey: deps.apiKey,
      sendAction: deps.sendAction,
      trackEvent: deps.trackEvent,
      logger,
      signal: streamAbort.signal,
    } as unknown as PromptAiSdkStreamParams
    const iterator = deps
      .promptAiSdkStream(rehydrated)
      [Symbol.asyncIterator]()
    // Teardown parity with the in-process path (compatibility-reviewer:
    // stream-iterator-not-cancelled-on-bridge-close): when the bridge closes
    // and the server kills this handler, the collector must ALSO cancel the
    // underlying iterator — `return()` runs the generator's finally blocks
    // exactly like the consumer's early return in-process — and abort the
    // rehydrated signal so a provider stream blocked mid-chunk stops
    // producing promptly. Without this, a killed handler kept consuming the
    // provider stream into an unbounded array with no consumer (continued
    // provider spend + memory growth).
    const cancelStream = (): void => {
      streamAbort.abort()
      // `return()` runs the generator's finally blocks exactly like the
      // consumer's early return in-process; a rejection during that teardown
      // (e.g. a provider throwing in its finally) must never surface as an
      // unhandled rejection — the handler reply is already settled by the
      // close-time killed race.
      const returned = iterator.return?.(undefined as never)
      if (returned) returned.catch(() => {})
    }
    activeStreamCancels.add(cancelStream)
    const chunks: BridgedPromptStreamResult['chunks'] = []
    try {
      // Bounded collection (see bridge-protocol.ts
      // BRIDGE_MAX_STREAM_CHUNKS_BYTES):
      // the reply is ONE message under the 16 MiB per-message cap, so an
      // aggregate chunk payload past the budget TRUNCATES (truncated: true,
      // logged loudly child-side) instead of making encodeBridgeMessage throw
      // in the reply path — which would destroy the socket and settle a valid
      // run as 'crashed', a failure the in-process path cannot exhibit.
      let collectedBytes = 0
      let truncated = false
      for (;;) {
        const next = await iterator.next()
        if (next.done) {
          return truncated ? { chunks, result: next.value, truncated } : { chunks, result: next.value }
        }
        if (!truncated) {
          collectedBytes += Buffer.byteLength(JSON.stringify(next.value) ?? '', 'utf8')
          if (collectedBytes > BRIDGE_MAX_STREAM_CHUNKS_BYTES) {
            truncated = true
            logger.warn(
              {
                collectedChunks: chunks.length,
                budgetBytes: BRIDGE_MAX_STREAM_CHUNKS_BYTES,
              },
              'promptAiSdkStream reply truncated at the stream-chunk byte budget (kept under the 16 MiB per-message cap)',
            )
            continue
          }
          chunks.push(next.value)
        }
      }
    } finally {
      activeStreamCancels.delete(cancelStream)
    }
  }

  // ── Incremental promptAiSdkStream bridging (P2-T8c) ──────────────────────
  // Per-server registry of started-but-unfinished incremental streams:
  // BOUNDED by MAX_CONCURRENT_BRIDGE_STREAMS (a child that keeps starting
  // streams without consuming/stopping them cannot grow it past that bound —
  // overflow starts get the structured 'too many concurrent streams' error
  // reply), and drained ON close() by the shared cancelInFlightStreams hook
  // below. Entries are NEVER serialized; ids come from realIdGen.uuid()
  // (P2-T1: already the bridgeNonce source — monotonic-enough correlation ids,
  // authority comes from the owner-only sandbox socket, not id secrecy).
  const incrementalStreams = new Map<string, IncrementalStreamEntry>()

  const tearStreamDown = (entry: IncrementalStreamEntry): void => {
    // Exactly the legacy cancelStream teardown: abort the per-stream signal
    // so a provider blocked mid-chunk stops producing (spend stops), and
    // `return()` runs the generator's finally blocks exactly like the
    // consumer's early return on the in-process path. Teardown rejections
    // (e.g. a provider throwing in its finally) are dropped silently: the
    // caller's reply is already settled and a bridge must never crash on
    // teardown.
    entry.abort.abort()
    const returned = entry.iterator.return?.(undefined as never)
    if (returned) returned.catch(() => {})
  }

  const buildStreamParams = (
    params: PromptAiSdkStreamStartParams,
    streamAbort: AbortController,
  ): PromptAiSdkStreamStartParams =>
    ({
      ...(rehydratePromptParamsForBridge(params, logger, bridgeNonce) as Record<
        string,
        unknown
      >),
      apiKey: deps.apiKey,
      sendAction: deps.sendAction,
      trackEvent: deps.trackEvent,
      logger,
      signal: streamAbort.signal,
    } as unknown as PromptAiSdkStreamStartParams)

  const handleIncrementalStreamStart = async (
    params: PromptAiSdkStreamStartParams,
  ): Promise<PromptAiSdkStreamStartResult> => {
    if (incrementalStreams.size >= MAX_CONCURRENT_BRIDGE_STREAMS) {
      throw new Error(
        `too many concurrent streams: the parent bridge's incremental-stream registry is capped at ${MAX_CONCURRENT_BRIDGE_STREAMS} entries`,
      )
    }
    const streamAbort = new AbortController()
    const iterator = deps
      .promptAiSdkStream(buildStreamParams(params, streamAbort))
      [Symbol.asyncIterator]()
    const streamId = realIdGen.uuid()
    const cancel = (): void => {
      incrementalStreams.delete(streamId)
      activeStreamCancels.delete(cancel)
      tearStreamDown({ iterator, abort: streamAbort, cancel, reservedBytes: 0 })
    }
    incrementalStreams.set(streamId, {
      iterator,
      abort: streamAbort,
      cancel,
      reservedBytes: 0,
    })
    activeStreamCancels.add(cancel)
    return { streamId }
  }

  const handleIncrementalStreamNext = async (
    params: PromptAiSdkStreamNextParams,
  ): Promise<PromptAiSdkStreamNextResult> => {
    const entry = incrementalStreams.get(params.streamId)
    if (!entry) {
      // Unknown stream: stale id (already finished/consumed) or a stop was
      // already honored. A stream-finished semantic is the least surprising
      // structured answer for a wrapper that polled once past the end.
      return { done: true }
    }
    let next: IteratorResult<StreamChunk, PromptResultType<string | null>>
    try {
      next = await entry.iterator.next()
    } catch (error) {
      // The provider iterator threw: remove the entry (nothing left to
      // consume or stop) and surface the failure as a structured error reply
      // (never a crash, never a silent drop).
      incrementalStreams.delete(params.streamId)
      activeStreamCancels.delete(entry.cancel)
      throw error instanceof Error ? error : new Error(String(error))
    }
    if (next.done) {
      // The stream finished: the final reply CARRIES the PromptResult (the
      // loop's final result flows back exactly like today — see the Risks
      // note: never return undefined for an aborted/prompt result) and the
      // registry entry is removed (nothing left to stop or consume).
      incrementalStreams.delete(params.streamId)
      activeStreamCancels.delete(entry.cancel)
      // NOTE: unlike the legacy collectPromptStream, the incremental path
      // never needs a truncation budget: each reply is ONE chunk.
      return { done: true, result: next.value }
    }
    // Per-reply cap contract (reviewer-facing; see
    // bridge-protocol.ts BRIDGE_MAX_STREAM_NEXT_REPLY_BYTES): the reply is a
    // ONE-chunk message whose FULL line is the `{ id, ok, result:{ done:false,
    // chunk } }` envelope plus a newline. The per-reply cap is the hard
    // BRIDGE_MAX_MESSAGE_BYTES MINUS the envelope reserve, so a chunk this
    // probe admits always leaves room for the wrapper and the reply-path
    // encodeBridgeMessage can never throw 'oversized'. The pre-encode probe
    // below is the backstop: for a chunk whose JSON serialization provably
    // exceeds the per-reply cap (practically impossible for AI SDK
    // StreamChunks) we must NOT let encodeBridgeMessage throw in the reply
    // path (that destroys the socket and settles a valid run as 'crashed').
    // Instead: remove the registry entry (nothing left to consume) and answer
    // with a structured StreamTruncatedError-styled failure reply — the
    // socket stays usable and the degraded stream is LOUD, never a silent
    // drop.
    const chunk = next.value
    let chunkBytes: number
    try {
      chunkBytes = Buffer.byteLength(JSON.stringify(chunk) ?? '', 'utf8')
    } catch {
      chunkBytes = Number.POSITIVE_INFINITY
    }
    if (!Number.isFinite(chunkBytes) || chunkBytes > BRIDGE_MAX_STREAM_NEXT_REPLY_BYTES) {
      incrementalStreams.delete(params.streamId)
      activeStreamCancels.delete(entry.cancel)
      // Registry hygiene: the truncated stream is ENDED from the child's
      // perspective, so tear the provider iterator down (abort + return) —
      // never leave a suspended generator buffering with no consumer.
      tearStreamDown(entry)
      return {
        done: true,
        result: createStreamTruncationErrorResult(
          params.streamId,
          Number.isFinite(chunkBytes) ? chunkBytes : -1,
        ),
      }
    }
    return { done: false, chunk }
  }

  const handleIncrementalStreamStop = (
    params: PromptAiSdkStreamStopParams,
  ): { stopped: boolean } => {
    const entry = incrementalStreams.get(params.streamId)
    if (!entry) return { stopped: false }
    incrementalStreams.delete(params.streamId)
    activeStreamCancels.delete(entry.cancel)
    // Registry hygiene: STOP tears the provider stream down exactly like the
    // legacy cancelStream (iterator.return(undefined as never) + abort) so a
    // caller's early break/return stops provider spend like the in-process
    // consumer-early-return teardown.
    tearStreamDown(entry)
    return { stopped: true }
  }

  const handlers: ParentBridgeHandlers = {
    promptAiSdkStream: (params) =>
      collectPromptStream(params as PromptAiSdkStreamParams),
    promptAiSdkStreamStart: (params) =>
      handleIncrementalStreamStart(params as PromptAiSdkStreamStartParams),
    promptAiSdkStreamNext: (params) =>
      handleIncrementalStreamNext(params as PromptAiSdkStreamNextParams),
    promptAiSdkStreamStop: (params) =>
      handleIncrementalStreamStop(params as PromptAiSdkStreamStopParams),
    promptAiSdk: (params) =>
      deps.promptAiSdk({
        ...(rehydratePromptParamsForBridge(
          params,
          logger,
          bridgeNonce,
        ) as Record<string, unknown>),
        apiKey: deps.apiKey,
        sendAction: deps.sendAction,
        trackEvent: deps.trackEvent,
        logger,
        signal: new AbortController().signal,
      } as unknown as Parameters<PromptAiSdkFn>[0]),
    promptAiSdkStructured: (params) => {
      const record = (params ?? {}) as Record<string, unknown>
      const { schema } = record as {
        schema?: Record<string, unknown>
      }
      if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
        // FAIL-CLOSED: the child's zod schema is authoritative for the
        // in-process PromptAiSdkStructuredFn contract. A missing/unusable wire
        // schema must NOT silently widen to a permissive `{ type: 'object' }`
        // (the parent would validate against a schema the child never
        // authored); the throw is encoded as a structured error reply (the
        // socket stays usable) and the child settles a failed receipt.
        throw new Error(
          'bridged promptAiSdkStructured: wire params carry no JSON Schema — refusing to widen to { type: "object" }',
        )
      }
      return deps.promptAiSdkStructured({
        ...(rehydrateParams(record, logger, bridgeNonce) as Record<string, unknown>),
        apiKey: deps.apiKey,
        sendAction: deps.sendAction,
        trackEvent: deps.trackEvent,
        logger,
        signal: new AbortController().signal,
        // The zod schema crossed the bridge as JSON Schema; convert it back
        // so the real structured-prompt dep keeps its contract.
        schema: convertJsonSchemaToZod(schema),
      } as unknown as Parameters<PromptAiSdkStructuredFn>[0])
    },
    // sendAction is rehydrated like every other method: the child sanitizer
    // replaces nested logger-like objects / AbortSignals with wire markers,
    // and delivering those raw markers to the REAL sendAction dep would leak
    // marker garbage across the exported dep boundary.
    sendAction: (params) => deps.sendAction(rehydrateParams(params, logger, bridgeNonce) as never),
    requestToolCall: (params) =>
      deps.requestToolCall(
        rehydrateParams(params, logger, bridgeNonce) as never,
      ),
    // `capabilityIssuer` ({ projectId, runId }) crosses verbatim (it is
    // JSON-serializable): the real dep mints cap.v3 editAnchors —
    // contentHash + line range — for complete reads, and the CHILD re-mints
    // the token with its own in-process HMAC key (a cap.v3 token is
    // verifiable only in the process that minted it), so the parent-signed
    // token never needs to be replayable across the bridge.
    requestFiles: (params) => deps.requestFiles(rehydrateParams(params, logger, bridgeNonce) as never),
    requestOptionalFile: (params) =>
      deps.requestOptionalFile(
        rehydrateParams(params, logger, bridgeNonce) as never,
      ),
    requestMcpToolData: (params) =>
      deps.requestMcpToolData(rehydrateParams(params, logger, bridgeNonce) as never),
    handleStepsLogChunk: (params) =>
      deps.handleStepsLogChunk(rehydrateParams(params, logger, bridgeNonce) as never),
    sendSubagentChunk: (params) =>
      deps.sendSubagentChunk(rehydrateParams(params, logger, bridgeNonce) as never),
    trackEvent: (params) => deps.trackEvent(rehydrateParams(params, logger, bridgeNonce) as never),
    fetch: async (params) => {
      const { input, init } = (params ?? {}) as BridgedFetchParams
      const response = await deps.fetch(input, init)
      const headers: Record<string, string> = {}
      response.headers.forEach((value, key) => {
        headers[key] = value
      })
      return {
        status: response.status,
        statusText: response.statusText,
        headers,
        bodyText: await response.text(),
      }
    },
    startAgentRun: (params) =>
      deps.startAgentRun({
        ...(rehydrateParams(params, logger, bridgeNonce) as Record<string, unknown>),
        apiKey: deps.apiKey,
      } as unknown as Parameters<StartAgentRunFn>[0]),
    finishAgentRun: (params) =>
      deps.finishAgentRun({
        ...(rehydrateParams(params, logger, bridgeNonce) as Record<string, unknown>),
        apiKey: deps.apiKey,
      } as unknown as Parameters<FinishAgentRunFn>[0]),
    addAgentStep: (params) =>
      deps.addAgentStep({
        ...(rehydrateParams(params, logger, bridgeNonce) as Record<string, unknown>),
        apiKey: deps.apiKey,
      } as unknown as Parameters<AddAgentStepFn>[0]),
    fetchAgentFromDatabase: async (params) => {
      const template = await deps.fetchAgentFromDatabase({
        ...(rehydrateParams(params, logger, bridgeNonce) as Record<string, unknown>),
        apiKey: deps.apiKey,
      } as unknown as Parameters<FetchAgentFromDatabaseFn>[0])
      if (template === null) return null
      // Fail-closed round-trip-safety validation
      // (compatibility-reviewer:
      // bridged-agent-template-not-json-roundtrip-safe): the result crosses
      // the JSON wire, so a live z.ZodSchema inputSchema.prompt/params or
      // outputSchema member and a programmatic `handleSteps` function would
      // be silently dropped/degraded — the child would run with a
      // structurally damaged AgentTemplate diverging from the
      // FetchAgentFromDatabaseFn contract the in-process path satisfies.
      // Instead: a structured error reply (the socket stays usable) naming
      // the offending members; the child settles a failed receipt, exactly
      // like the loop failing on the same template in-process.
      const offenses = findNonRoundTripSafeResultPaths(template)
      if (offenses.length > 0) {
        throw new Error(
          `bridged fetchAgentFromDatabase: the resolved AgentTemplate is not JSON-round-trip-safe and cannot cross the bridge without silent damage (${offenses.join('; ')})`,
        )
      }
      return template
    },
    consumeCreditsWithFallback: (params) =>
      deps.consumeCreditsWithFallback(
        rehydrateParams(params, logger, bridgeNonce) as unknown as Parameters<ConsumeCreditsWithFallbackFn>[0],
      ),
  }
  // The per-table marker nonce rides on the returned table so the
  // supervised-spawn seam can stamp it into the request envelope
  // (`rpcBridgeNonce`) for the child side (see bridge-protocol.ts's
  // collision-proof sentinel), and the in-flight stream cancel hook rides
  // alongside it so the bridge server's close() can tear down the provider
  // iterators a killed collector would otherwise keep consuming.
  //
  // INCREMENTAL streams (P2-T8c) drain through the SAME hook: every
  // incrementalStreams entry registers its cancel in activeStreamCancels, so
  // close()'s existing cancelInFlightStreams probe (a structural check on the
  // returned table — no NEW kill path) tears down every unfinished incremental
  // stream (abort + iterator.return) alongside the legacy collectors, and
  // removes them from the registry. A pending in-flight promptAiSdkStreamNext
  // request is a normal handler invocation: close()'s existing
  // BridgeClosedError kill path settles its reply — no second kill path here.
  return {
    ...handlers,
    bridgeNonce,
    cancelInFlightStreams: () => {
      for (const cancel of activeStreamCancels) {
        try {
          cancel()
        } catch {
          // Teardown must never throw past close().
        }
      }
      activeStreamCancels.clear()
    },
  }
}
