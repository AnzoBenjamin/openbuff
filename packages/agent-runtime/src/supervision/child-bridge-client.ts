/**
 * P2-T8b: child-side RPC bridge client.
 *
 * Connects to the parent bridge server's Unix socket (node:net — cross-runtime
 * safe in Bun, see parent-bridge-server.ts) and exposes
 * {@link buildBridgedChildDeps}: a deps object implementing the SAME dep names
 * as the parent via RPC. Request/response methods await the reply;
 * fire-and-forget methods (sendAction, handleStepsLogChunk, sendSubagentChunk,
 * trackEvent) send without awaiting an ack beyond socket write acceptance, and
 * their failure replies (e.g. 'bridge_notify_overflow' at the parent's bounded
 * notify budget) are logged loudly on stderr — never silently dropped.
 *
 * Params sanitation (the wire is JSON): AbortSignal instances, logger-like
 * objects, and live Date instances are replaced with nonce-stamped wire
 * markers (see
 * bridge-protocol.ts's collision-proof sentinel) that the parent rehydrates
 * ONLY on an exact nonce match; the nonce reaches the child through the
 * request envelope (`rpcBridgeNonce`) and is supplied to
 * {@link buildBridgedChildDeps}. Function-valued members are dropped.
 * Child-side cancellation is LOCAL: when the child's own
 * signal aborts or the socket closes, the pending RPC rejects promptly
 * (fail-closed — the loop settles a failed receipt instead of hanging to the
 * supervisor deadline).
 *
 * NOTE(P2-T1): request ids are a monotonic counter (see bridge-protocol.ts).
 */
import * as net from 'node:net'

import z from 'zod/v4'

import type { ConsumeCreditsWithFallbackFn } from '@codebuff/common/types/contracts/billing'
import type { FetchAgentFromDatabaseFn } from '@codebuff/common/types/contracts/database'
import type { SendActionFn } from '@codebuff/common/types/contracts/client'
import type { TrackEventFn } from '@codebuff/common/types/contracts/analytics'

import {
  BRIDGE_CLOSE_ID,
  BRIDGE_LOGGER_MARKER,
  BRIDGE_SIGNAL_MARKER,
  BridgeClosedError,
  BridgeProtocolError,
  createBridgeDateWireMarker,
  createBridgeStderrLogger,
  createBridgeWireMarker,
  createNdjsonLineReader,
  encodeBridgeMessage,
  isBridgeMarkerShaped,
  isBridgeReply,
  type BridgedFetchParams,
  type BridgedFetchResult,
  type BridgedPromptStreamResult,
  type BridgeMethod,
  type PromptAiSdkFn,
  type PromptAiSdkParams,
  type PromptAiSdkStreamFn,
  type PromptAiSdkStreamParams,
  type PromptAiSdkStructuredFn,
  type PromptAiSdkStructuredParams,
} from './bridge-protocol'

/** Connect timeout: a live socket accepts immediately; anything longer means
 * the parent is gone — fail closed instead of hanging. */
const CONNECT_TIMEOUT_MS = 10_000

export type ChildBridgeClient = {
  /** Request/response RPC: awaits the parent's reply. */
  call: (method: BridgeMethod, params: unknown) => Promise<unknown>
  /** Fire-and-forget: resolves once the write is accepted by the socket. */
  notify: (method: BridgeMethod, params: unknown) => void
  /** Idempotent; closes the socket and rejects pending calls. */
  close: () => void
  /** Invoked once when the socket closes/errors (fail-closed signal). */
  onClose: (callback: () => void) => void
}

/**
 * Connects to the parent bridge socket. Rejects on connect failure/timeout.
 */
export function connectChildBridge(socketPath: string): Promise<ChildBridgeClient> {
  return new Promise<ChildBridgeClient>((resolve, reject) => {
    const socket = net.connect({ path: socketPath })
    let settled = false
    const timeout = setTimeout(() => {
      if (settled) return
      settled = true
      socket.destroy()
      reject(new BridgeClosedError(`bridge connect timed out after ${CONNECT_TIMEOUT_MS}ms`))
    }, CONNECT_TIMEOUT_MS)
    socket.once('connect', () => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      resolve(createChildBridgeClient(socket))
    })
    socket.once('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      socket.destroy()
      reject(
        error instanceof Error
          ? error
          : new BridgeClosedError(`bridge connect failed: ${String(error)}`),
      )
    })
  })
}

function createChildBridgeClient(socket: net.Socket): ChildBridgeClient {
  const logger = createBridgeStderrLogger('child-bridge')
  const pending = new Map<
    string,
    { resolve: (value: unknown) => void; reject: (error: unknown) => void }
  >()
  const closeCallbacks = new Set<() => void>()
  let nextRequestId = 0
  let nextNotifyId = 0
  let closed = false

  const failClosed = (error: unknown): void => {
    if (closed) return
    closed = true
    for (const entry of pending.values()) {
      entry.reject(
        error instanceof Error
          ? error
          : new BridgeClosedError('bridge socket closed'),
      )
    }
    pending.clear()
    for (const callback of closeCallbacks) {
      try {
        callback()
      } catch {
        // A close callback must never break fail-closed teardown.
      }
    }
  }

  const readLine = createNdjsonLineReader({
    onLine: (line) => {
      let parsed: unknown
      try {
        parsed = JSON.parse(line)
      } catch {
        failClosed(new BridgeProtocolError('malformed', 'parent sent a malformed bridge line'))
        socket.destroy()
        return
      }
      if (!isBridgeReply(parsed)) {
        failClosed(new BridgeProtocolError('malformed', 'parent sent a non-reply bridge line'))
        socket.destroy()
        return
      }
      if (parsed.id === BRIDGE_CLOSE_ID) {
        // The parent's close() notification: fail closed with the typed error
        // instead of routing through the pending-request lookup (it is not a
        // reply to any child request).
        failClosed(new BridgeClosedError('bridge closed by parent'))
        return
      }
      const entry = pending.get(parsed.id)
      if (!entry) {
        // Replies to fire-and-forget notifications have no pending entry by
        // design — but a FAILURE reply (e.g. 'bridge_notify_overflow' at the
        // parent's bounded notify budget) must be LOUD, never silently
        // swallowed: a dropped display-stream chunk is a data-loss divergence
        // from the in-process path, where every chunk is delivered.
        if (!parsed.ok) {
          logger.warn(
            { id: parsed.id, error: parsed.error.message },
            'bridge notify failure: the parent refused/dropped a fire-and-forget notification',
          )
        }
        return
      }
      pending.delete(parsed.id)
      if (parsed.ok) {
        entry.resolve(parsed.result)
      } else {
        entry.reject(new Error(parsed.error.message))
      }
    },
    onProtocolError: (error) => {
      failClosed(error)
      socket.destroy()
    },
  })

  socket.on('data', (chunk) => {
    readLine(new Uint8Array(chunk))
  })
  socket.on('error', (error) => {
    logger.warn({ error: error.message }, 'bridge socket error; failing closed')
    failClosed(error)
  })
  socket.on('close', () => {
    failClosed(new BridgeClosedError('bridge socket closed'))
  })

  const writeMessage = (method: BridgeMethod, id: string | null, params: unknown): boolean => {
    if (closed) return false
    try {
      socket.write(
        encodeBridgeMessage(
          id === null
            ? { id: `notify-${method}`, method, params }
            : { id, method, params },
        ),
      )
      return true
    } catch (error) {
      failClosed(error)
      return false
    }
  }

  return {
    call: (method, params) => {
      // Liveness check: after the parent server closed, Bun's node:net
      // emulation may not propagate the idle socket's 'close' event promptly,
      // so the `closed` flag alone is not enough — a destroyed socket must
      // reject instead of registering a pending request that never settles.
      if (closed || socket.destroyed) {
        return Promise.reject(new BridgeClosedError('bridge socket closed'))
      }
      nextRequestId += 1
      const id = `rpc-${nextRequestId}`
      return new Promise<unknown>((resolve, reject) => {
        pending.set(id, { resolve, reject })
        if (!writeMessage(method, id, params)) {
          pending.delete(id)
          reject(new BridgeClosedError('bridge socket closed before write'))
        }
      })
    },
    notify: (method, params) => {
      // Fire-and-forget: no ack beyond socket write acceptance. A UNIQUE
      // per-notification id (distinct from call ids) lets the parent's
      // failure replies be recognized and logged child-side (never silently
      // swallowed) and keeps them outside the parent's request budget: the
      // parent gives notifications their own bounded budget
      // ('bridge_notify_overflow' at saturation — see parent-bridge-server.ts
      // MAX_CONCURRENT_BRIDGE_NOTIFIES).
      nextNotifyId += 1
      writeMessage(method, `notify-${method}-${nextNotifyId}`, params)
    },
    close: () => {
      if (closed) return
      socket.destroy()
      failClosed(new BridgeClosedError('child bridge client closed'))
    },
    onClose: (callback) => {
      closeCallbacks.add(callback)
    },
  }
}

// ── Params sanitation ──────────────────────────────────────────────────────

const SANITIZE_MAX_DEPTH = 12

/**
 * Converts live params into JSON-safe wire params:
 *  - AbortSignal → a nonce-stamped signal marker (the parent rehydrates a
 *    fresh never-aborted signal ONLY on an exact nonce match; child-side
 *    cancellation is local);
 *  - logger-like objects → a nonce-stamped logger marker;
 *  - Date → a nonce-stamped date marker (the three-key shape carries the ISO
 *    payload; the parent rehydrates a live `new Date(iso)` ONLY on an exact
 *    nonce match — e.g. AddAgentStepFn's required `startTime: Date`, which a
 *    plain-object walk would otherwise collapse to `{}`); without a nonce
 *    the ISO string JSON.stringify renders natively crosses as data;
 *  - when `bridgeNonce` is undefined (raw handler tables, which never
 *    rehydrated), the LEGACY content-only marker shapes are emitted — they
 *    cross the bridge as data, exactly as before;
 *  - functions → dropped (optional callback hooks are invoked with `?.`);
 *  - depth-bounded so runaway structures cannot balloon a message past the
 *    16 MiB cap unnoticed (the cap itself is the backstop).
 */
export function sanitizeBridgeParams(params: unknown, bridgeNonce?: string): unknown {
  const signalMarker = (): unknown =>
    bridgeNonce === undefined
      ? BRIDGE_SIGNAL_MARKER
      : createBridgeWireMarker('signal', bridgeNonce)
  const loggerMarker = (): unknown =>
    bridgeNonce === undefined
      ? BRIDGE_LOGGER_MARKER
      : createBridgeWireMarker('logger', bridgeNonce)
  const walk = (value: unknown, depth: number): unknown => {
    if (value === null || typeof value !== 'object') {
      // Functions (and primitives) pass through; JSON.stringify drops functions.
      return value
    }
    if (depth > SANITIZE_MAX_DEPTH) return undefined
    if (value instanceof AbortSignal) return signalMarker()
    // Live Date params (e.g. AddAgentStepFn's required `startTime: Date`):
    // Object.entries of a Date has no own enumerable properties, so the
    // plain-object walk below would deliver `{}` where the in-process path
    // delivers a Date. Emit the nonce-stamped date marker instead (the
    // parent rehydrates a live `new Date(iso)` on an exact nonce match);
    // without a nonce the ISO string JSON.stringify renders natively
    // crosses as data.
    if (value instanceof Date) {
      return bridgeNonce === undefined
        ? value.toISOString()
        : createBridgeDateWireMarker(value, bridgeNonce)
    }
    if (isBridgeMarkerShaped(value)) return value
    if (isLoggerLike(value)) return loggerMarker()
    if (Array.isArray(value)) {
      return value.map((item) => walk(item, depth + 1))
    }
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value)) {
      out[key] = walk(item, depth + 1)
    }
    return out
  }
  return walk(params, 0)
}

function isLoggerLike(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return (
    typeof record.debug === 'function' &&
    typeof record.info === 'function' &&
    typeof record.warn === 'function' &&
    typeof record.error === 'function'
  )
}

/**
 * Converts a child-side zod schema to JSON Schema for the wire.
 *
 * FAIL-CLOSED: `z.toJSONSchema` throws for schemas it cannot represent
 * (e.g. `z.date()`, `z.bigint()`). Silently widening to a permissive
 * `{ type: 'object' }` would diverge from the in-process
 * PromptAiSdkStructuredFn contract — the parent would validate against a
 * schema the child never authored — so the error PROPAGATES instead: the
 * bridged promise rejects (and the loop settles a structured failed
 * receipt), exactly like the in-process dep failing on the same schema.
 */
export function toBridgeJsonSchema(
  schema: PromptAiSdkStructuredParams['schema'],
): Record<string, unknown> {
  return z.toJSONSchema(schema, { io: 'input' }) as Record<string, unknown>
}

// ── Bridged child deps ─────────────────────────────────────────────────────

/**
 * The child's deps object implementing the SAME dep names as the parent via
 * RPC. Shapes match the real contracts; params are sanitized at the wire
 * boundary (documented per-method below).
 */
export type BridgedChildDeps = {
  promptAiSdkStream: PromptAiSdkStreamFn
  promptAiSdk: PromptAiSdkFn
  promptAiSdkStructured: PromptAiSdkStructuredFn
  sendAction: SendActionFn
  requestToolCall: import('@codebuff/common/types/contracts/client').RequestToolCallFn
  requestFiles: import('@codebuff/common/types/contracts/client').RequestFilesFn
  requestOptionalFile: import('@codebuff/common/types/contracts/client').RequestOptionalFileFn
  requestMcpToolData: import('@codebuff/common/types/contracts/client').RequestMcpToolDataFn
  handleStepsLogChunk: import('@codebuff/common/types/contracts/client').HandleStepsLogChunkFn
  sendSubagentChunk: import('@codebuff/common/types/contracts/client').SendSubagentChunkFn
  trackEvent: TrackEventFn
  fetch: typeof globalThis.fetch
  startAgentRun: import('@codebuff/common/types/contracts/database').StartAgentRunFn
  finishAgentRun: import('@codebuff/common/types/contracts/database').FinishAgentRunFn
  addAgentStep: import('@codebuff/common/types/contracts/database').AddAgentStepFn
  fetchAgentFromDatabase: FetchAgentFromDatabaseFn
  consumeCreditsWithFallback: ConsumeCreditsWithFallbackFn
}

/**
 * Builds the bridged deps from a connected client.
 *
 * Per-method notes:
 *  - prompt methods: nested `sendAction` / `trackEvent` / `logger` / `signal`
 *    are DROPPED — the parent re-injects its own live values (so provider
 *    status chunks and cost accounting flow through the real parent channel);
 *  - `promptAiSdkStream`: the parent collects the FULL chunk sequence
 *    (streaming limitation, see bridge-protocol.ts) and this wrapper
 *    reconstructs an AsyncGenerator yielding the chunks and returning the
 *    PromptResult;
 *  - `promptAiSdkStructured`: the zod schema travels as JSON Schema; an
 *    unrepresentable schema fails CLOSED child-side (the promise rejects)
 *    instead of silently widening to `{ type: 'object' }`, and the reply is
 *    RE-VALIDATED against the authored schema (the JSON-Schema round trip
 *    drops refinements/transforms — a violating reply is a fail-closed
 *    rejection);
 *  - `requestFiles`: `capabilityIssuer` ({ projectId, runId }) is
 *    JSON-serializable and CROSSES the bridge; see the member comment below
 *    for the child-side cap.v3 re-mint contract (a token is verifiable only
 *    in the process that minted it, so the child re-mints from the parent's
 *    returned contentHash instead of replaying a parent-signed token);
 *  - `fetch`: string/URL inputs only; the Response is reconstructed from the
 *    flattened status/headers/bodyText (init body must be a string);
 *  - fire-and-forget methods resolve on write acceptance, not on an ack.
 */
export function buildBridgedChildDeps(
  client: ChildBridgeClient,
  options?: {
    /**
     * Per-table bridge marker nonce (see bridge-protocol.ts's collision-proof
     * sentinel), carried to the child through the request envelope
     * (`rpcBridgeNonce` in SupervisedSpawnRequest). When omitted, the
     * sanitizer emits the LEGACY content-only marker shapes, which no parent
     * recognizes anymore — they cross the bridge as data.
     */
    bridgeNonce?: string
  },
): BridgedChildDeps {
  const bridgeNonce = options?.bridgeNonce
  const callParams = (params: unknown): unknown =>
    sanitizeBridgeParams(params, bridgeNonce)

  const dropPromptChannelKeys = (
    params: PromptAiSdkStreamParams | PromptAiSdkParams | PromptAiSdkStructuredParams,
  ): Record<string, unknown> => {
    const { sendAction: _sendAction, trackEvent: _trackEvent, logger: _logger, signal: _signal, ...rest } = params as Record<string, unknown>
    return rest
  }

  const bridgedPromptAiSdkStream = (
    params: PromptAiSdkStreamParams,
  ): ReturnType<PromptAiSdkStreamFn> => {
    const wirePromise = client.call(
      'promptAiSdkStream',
      callParams(dropPromptChannelKeys(params)),
    )
    return (async function* () {
      const wire = (await wirePromise) as BridgedPromptStreamResult
      // A truncated reply means the parent DROPPED chunk bytes to keep the
      // single stream reply under the 16 MiB per-message cap (see
      // bridge-protocol.ts BRIDGE_MAX_STREAM_CHUNKS_BYTES). Loud on stderr —
      // a bounded bridge is never a silent drop.
      if (wire.truncated) {
        createBridgeStderrLogger('child-bridge').warn(
          { deliveredChunks: wire.chunks.length },
          'bridge stream reply was truncated: the parent dropped chunk bytes past BRIDGE_MAX_STREAM_CHUNKS_BYTES to stay under the 16 MiB per-message cap',
        )
      }
      for (const chunk of wire.chunks) {
        yield chunk
      }
      return wire.result
    })() as ReturnType<PromptAiSdkStreamFn>
  }

  const bridgedFetch = async (
    input: Parameters<typeof globalThis.fetch>[0],
    init?: Parameters<typeof globalThis.fetch>[1],
  ): Promise<Response> => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input instanceof Request
            ? input.url
            : String(input)
    // Fail-closed body handling (compatibility-reviewer:
    // bridged-fetch-body-silent-drop): a non-string init.body (binary/
    // FormData/ReadableStream/URLSearchParams/ArrayBuffer...) cannot cross
    // the JSON wire. Silently omitting it — the old behavior — would send a
    // BODYLESS request, a worse divergence than an explicit failure, so the
    // bridged fetch rejects BEFORE any parent-side network call.
    if (
      init !== undefined &&
      init.body !== undefined &&
      init.body !== null &&
      typeof init.body !== 'string'
    ) {
      throw new Error(
        'bridged fetch: non-string init.body cannot cross the supervision bridge (binary/FormData/stream bodies are unsupported) — refusing to send a bodyless request',
      )
    }
    // NOTE: init.signal (a live AbortSignal) and other non-JSON-native init
    // members are intentionally NOT forwarded — child-side cancellation is
    // local (see sanitizeBridgeParams), and the flattened wire init below is
    // the only shape the parent's fetch handler accepts.
    const wireInit: BridgedFetchParams['init'] = init
      ? {
          ...(init.method ? { method: init.method } : {}),
          ...(init.headers
            ? {
                headers: (() => {
                  // Mirror parent-bridge-server.ts's fetch handler: Headers has
                  // no .entries() in this TS lib target, so collect via forEach
                  // into a Record<string, string> (same runtime result).
                  const headers: Record<string, string> = {}
                  new Headers(init.headers as HeadersInit).forEach(
                    (value, key) => {
                      headers[key] = value
                    },
                  )
                  return headers
                })(),
              }
            : {}),
          ...(typeof init.body === 'string' ? { body: init.body } : {}),
        }
      : undefined
    const wire = (await client.call(
      'fetch',
      callParams({ input: url, ...(wireInit ? { init: wireInit } : {}) } satisfies BridgedFetchParams),
    )) as BridgedFetchResult
    return new Response(wire.bodyText, {
      status: wire.status,
      statusText: wire.statusText,
      headers: wire.headers,
    })
  }

  return {
    promptAiSdkStream: bridgedPromptAiSdkStream,
    promptAiSdk: (params: PromptAiSdkParams) =>
      client
        .call('promptAiSdk', callParams(dropPromptChannelKeys(params)))
        .then((result) => result as Awaited<ReturnType<PromptAiSdkFn>>),
    // `promptAiSdkStructured`: the zod schema is serialized to JSON Schema
    // BEFORE the request is sent; a schema `z.toJSONSchema` cannot represent
    // fails CLOSED here (the promise rejects) instead of silently widening to
    // a permissive `{ type: 'object' }` the parent would validate against.
    // The REPLY is RE-VALIDATED against the authored schema: the parent
    // validates against a zod schema rebuilt from JSON Schema, which drops
    // refinements/transforms, so a result violating the schema the child
    // AUTHORED is a fail-closed rejection — never a silent divergence from
    // the in-process contract. Aborted replies and non-PromptResult shapes
    // pass through verbatim.
    promptAiSdkStructured: (async (params: PromptAiSdkStructuredParams) => {
      const { schema, ...rest } = params
      const reply = (await client.call(
        'promptAiSdkStructured',
        callParams({ ...rest, schema: toBridgeJsonSchema(schema) }),
      )) as { aborted?: unknown; value?: unknown }
      if (
        reply !== null &&
        typeof reply === 'object' &&
        reply.aborted === false &&
        reply.value !== undefined
      ) {
        const parsed = schema.safeParse(reply.value as unknown)
        if (parsed.success) {
          return { ...reply, value: parsed.data } as Awaited<
            ReturnType<PromptAiSdkStructuredFn>
          >
        }
        throw new Error(
          'bridged promptAiSdkStructured: parent result violates the authored schema (JSON-Schema round trip drops refinements/transforms): ' +
            JSON.stringify(parsed.error.issues),
        )
      }
      return reply as Awaited<ReturnType<PromptAiSdkStructuredFn>>
    }) as PromptAiSdkStructuredFn,
    sendAction: (params) => {
      client.notify('sendAction', callParams(params))
    },
    requestToolCall: (params) =>
      client.call('requestToolCall', callParams(params)) as ReturnType<
        import('@codebuff/common/types/contracts/client').RequestToolCallFn
      >,
    requestFiles: (params) => {
      // `capabilityIssuer` ({ projectId, runId }) is JSON-serializable and
      // CROSSES the bridge (compatibility-reviewer:
      // child-minted-cap-v3-unverifiable-parent-side): the parent's real
      // requestFiles mints cap.v3 editAnchors — contentHash + line range over
      // the content it actually read — for every COMPLETE read, and the
      // child's read_files handler re-mints that anchor into a child-local
      // token with the CHILD's own in-process HMAC key. A cap.v3 token is
      // verifiable only in the process that minted it, so this forwarding —
      // not a replayable parent-signed token — is what makes
      // capability-bearing edits (str_replace / replace_range /
      // rewrite_symbol / edit_transaction) work in a flag-on supervised
      // child instead of looping on 'fresh_read_required' despite fresh
      // reads. (The parent-signed token itself never reaches a child
      // consumer: the read_files handler overwrites editAnchor with its own
      // re-mint, or strips it entirely for incomplete reads.)
      return client.call('requestFiles', callParams(params)) as ReturnType<
        import('@codebuff/common/types/contracts/client').RequestFilesFn
      >
    },
    requestOptionalFile: (params) =>
      client.call('requestOptionalFile', callParams(params)) as ReturnType<
        import('@codebuff/common/types/contracts/client').RequestOptionalFileFn
      >,
    requestMcpToolData: (params) =>
      client.call('requestMcpToolData', callParams(params)) as ReturnType<
        import('@codebuff/common/types/contracts/client').RequestMcpToolDataFn
      >,
    handleStepsLogChunk: (params) => {
      client.notify('handleStepsLogChunk', callParams(params))
    },
    sendSubagentChunk: (params) => {
      client.notify('sendSubagentChunk', callParams(params))
    },
    trackEvent: (params) => {
      client.notify('trackEvent', callParams(params))
    },
    fetch: bridgedFetch as typeof globalThis.fetch,
    startAgentRun: (params) =>
      client.call('startAgentRun', callParams(params)) as ReturnType<
        import('@codebuff/common/types/contracts/database').StartAgentRunFn
      >,
    finishAgentRun: (params) =>
      client
        .call('finishAgentRun', callParams(params))
        .then(() => undefined),
    addAgentStep: (params) =>
      client.call('addAgentStep', callParams(params)) as ReturnType<
        import('@codebuff/common/types/contracts/database').AddAgentStepFn
      >,
    fetchAgentFromDatabase: (params) =>
      client.call('fetchAgentFromDatabase', callParams(params)) as ReturnType<
        FetchAgentFromDatabaseFn
      >,
    consumeCreditsWithFallback: (params) =>
      client.call('consumeCreditsWithFallback', callParams(params)) as ReturnType<
        ConsumeCreditsWithFallbackFn
      >,
  }
}
