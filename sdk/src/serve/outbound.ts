/**
 * Outbound streaming guards for the ACP wire (P1-T1-DESIGN §12.8 NEW-3/NEW-4).
 *
 * NEW-3 (streaming holdback): a per-`(sessionId, messageId)` holdback buffer
 * for `agent_message_chunk`/`agent_thought_chunk` text. It retains the
 * trailing `max(longest configured credential length, 256)` RAW characters
 * un-emitted, runs `sanitizeOutbound` over every emitted piece, and pulls the
 * cut back ahead of any occurrence that would otherwise straddle the cut — so
 * no single frame, and no per-messageId concatenation of frames, ever
 * contains a configured credential value or a `cap.v3` token (GV-27).
 *
 * The host flushes on the next tool_call, at turn end, and on cancel via
 * {@link OutboundHoldback.flush}/{@link OutboundHoldback.flushAll}, and
 * drives the 250 ms idle flush via {@link OutboundHoldback.flushIdleSession}
 * (from a timer it owns). Flushing emits everything held INCLUDING a tail-anchored
 * partial (documented trade-off: a message whose final characters are the
 * literal prefix of a secret — e.g. prose ending in `cap.v3.` — is emitted
 * at turn end; progressive pushes never emit such a prefix).
 *
 * NEW-4 (chokepoint): {@link sanitizeOutboundStream} wraps the
 * `WritableStream` handed to `ndJsonStream` so EVERY serialized frame —
 * including SDK-generated JSON-RPC errors, agent→client requests, and
 * `$/cancel_request` — passes through {@link sanitizeOutbound} before it
 * hits the wire. Handler-level sanitization is an optimization only, never
 * the guarantee (GV-28).
 *
 * §12.6 (outbound backpressure): {@link OutboundQueue} is a per-connection
 * byte-capped (32 MiB) FIFO for serialized outbound frames. On overflow it
 * first coalesces consecutive `agent_message_chunk`/`tool_call_update`
 * frames that share an id (chunk text concatenates; a later update wins);
 * when coalescing cannot bring the queue back under the cap it aborts the
 * session's run with `stopReason: 'cancelled'` so memory stays bounded
 * instead of letting a stalled reader grow the queue without limit.
 */

import { loadProviderConfigSync } from '../provider-config'
import { sanitizeOutbound } from './outbound-filter'

import type { LoadedProviderConfig } from '../provider-config'

/**
 * Well-known credential-bearing env keys the holdback protects out of the
 * box (§12.1 env-pair rule). The provider configuration surface (providers.json
 * `apiKeyEnv`, built-in presets) declares more; see
 * {@link getConfiguredCredentialEnvKeys}.
 */
const CREDENTIAL_ENV_KEYS = [
  'OPENROUTER_API_KEY',
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
] as const

/** Floor on the holdback window (§12.8 NEW-3). */
const MIN_HOLDBACK_CHARS = 256

/** Absolute cap on a single held window so memory stays bounded. */
const MAX_HELD_WINDOW_CHARS = 64 * 1024

/**
 * Collects the credential env keys the provider configuration surface
 * declares (`apiKeyEnv` on openai-compatible / anthropic-compatible
 * providers — the built-in presets and any custom providers.json entry).
 * These are exactly the providers model routing can select, so their env
 * values are exactly the configured credentials that can reach assistant
 * text. The configuration is loaded through the SAME `env` the caller
 * supplied (no `process.env` access here); pass `loadedConfig` explicitly
 * to keep the call hermetic.
 */
export function getConfiguredCredentialEnvKeys(
  env: Record<string, string | undefined>,
  loadedConfig?: LoadedProviderConfig,
): string[] {
  const config = loadedConfig ?? loadProviderConfigSync({ env })
  const providers = config.config.providers ?? {}
  const keys = new Set<string>()
  for (const provider of Object.values(providers)) {
    if (
      (provider.type === 'openai-compatible' ||
        provider.type === 'anthropic-compatible') &&
      provider.apiKeyEnv
    ) {
      keys.add(provider.apiKeyEnv)
    }
  }
  return Array.from(keys).sort()
}

/**
 * Resolves {@link getConfiguredCredentialEnvKeys} for the no-injection path,
 * degrading to the well-known keys alone when the provider configuration
 * cannot be loaded (e.g. an invalid OPENBUFF_PROVIDER_CONFIG override): a
 * failed config load must never break serving, and the no-split invariant
 * still covers every credential whose key is discoverable.
 */
function safeConfiguredCredentialEnvKeys(
  env: Record<string, string | undefined>,
): string[] {
  try {
    return getConfiguredCredentialEnvKeys(env)
  } catch {
    return []
  }
}

/**
 * Collects the configured credential VALUES the holdback must never split:
 * for every credential-bearing env key present (and non-empty) in `env` —
 * the well-known provider keys plus every key the provider configuration
 * declares (providers.json `apiKeyEnv`, built-in presets) — the env-pair
 * text `KEY=<value>` plus the bare value itself. Values come ONLY from the
 * caller-supplied `env`; the configured key NAMES default to the provider
 * configuration surface unless `configuredCredentialEnvKeys` is supplied
 * explicitly (which keeps the call hermetic). Pure when the key list is
 * supplied; the default key resolution performs the provider config read the
 * host's own model routing performs anyway, and only trusted config surfaces
 * (project / global / explicit override) contribute key names.
 */
export function collectCredentialValues(
  env: Record<string, string | undefined>,
  configuredCredentialEnvKeys?: readonly string[],
): string[] {
  const keys = [
    ...CREDENTIAL_ENV_KEYS,
    ...(configuredCredentialEnvKeys ?? safeConfiguredCredentialEnvKeys(env)),
  ]
  const values: string[] = []
  const seen = new Set<string>()
  for (const key of keys) {
    if (seen.has(key)) continue
    seen.add(key)
    const value = env[key]
    if (typeof value === 'string' && value.length > 0) {
      values.push(`${key}=${value}`, value)
    }
  }
  return values
}

/**
 * The holdback window size for a set of configured credentials (§12.8
 * NEW-3): `max(longest configured credential length, 256)`.
 */
export function holdbackSizeFor(credentials: string[]): number {
  let longest = 0
  for (const value of credentials) {
    if (value.length > longest) longest = value.length
  }
  return Math.max(longest, MIN_HOLDBACK_CHARS)
}

/** A held streaming window for one `(sessionId, messageId)` pair. */
type HoldbackWindow = {
  /** Raw text still held (the trailing window; unsanitized). */
  held: string
  /** Immutable credential list the window was built with. */
  credentials: string[]
  /** Immutable holdback size for `credentials`. */
  holdback: number
  /** Host-supplied monotonic `now` of the last push/flush touch. */
  lastActivity: number
}

/**
 * Per-`(sessionId, messageId)` streaming holdback (§12.8 NEW-3, GV-27).
 * One instance serves the whole agent process.
 *
 * `push` retains the trailing holdback window raw and emits only the prefix
 * that can never straddle a protected value; the tail stays held until a
 * flush or a later push releases it. `flush`/`flushAll`/`flushIdle` emit
 * what remains. The no-split invariant holds regardless of
 * `sanitizeOutbound`'s length-changing replacements, because every emitted
 * piece is a contiguous RAW slice whose boundaries were verified before the
 * redaction pass.
 */
export class OutboundHoldback {
  private readonly windows = new Map<string, HoldbackWindow>()

  /**
   * Pushes one streaming chunk for `(sessionId, messageId)`. Returns the
   * pieces safe to emit NOW, in order (possibly empty). The first push for a
   * key freezes the credential list for that window.
   */
  push(
    sessionId: string,
    messageId: string,
    chunk: string,
    credentials: string[],
    now: number,
  ): string[] {
    const key = `${sessionId}\u0000${messageId}`
    let window = this.windows.get(key)
    if (window === undefined) {
      window = {
        held: '',
        credentials,
        holdback: holdbackSizeFor(credentials),
        lastActivity: now,
      }
      this.windows.set(key, window)
    }
    window.lastActivity = now
    window.held += chunk

    // Bound pathological non-flushing windows: force the oldest text out as
    // if a flush had arrived — but through the SAME safe-cut check as a
    // progressive push, so a configured credential or cap.v3 token straddling
    // the overflow cut is never split across two frames (GV-27 no-split
    // invariant holds on the overflow path too). If no safe cut exists the
    // overflow stays held (bounded growth is accepted over a split secret;
    // the next flush triggers then release it whole).
    if (window.held.length > MAX_HELD_WINDOW_CHARS) {
      const overflowCut = window.held.length - window.holdback
      const safe = this.pullCutBack(window, overflowCut)
      if (safe === undefined) {
        // Everything stays held: memory growth is bounded by the window cap
        // and no protected value is ever split.
        return []
      }
      const overflow = window.held.slice(0, safe)
      window.held = window.held.slice(safe)
      return this.emitSlice(window, overflow)
    }

    if (window.held.length <= window.holdback) {
      // Everything is inside the holdback window: emit nothing yet.
      return []
    }

    const cut = window.held.length - window.holdback
    const safe = this.pullCutBack(window, cut)
    if (safe === undefined) {
      // No safe cut exists yet: everything stays held.
      return []
    }
    const emitted = window.held.slice(0, safe)
    window.held = window.held.slice(safe)
    return this.emitSlice(window, emitted)
  }

  /**
   * Flushes one window (turn end / cancel / tool_call for its message).
   * Returns the sanitized remainder (possibly empty) and clears the window.
   * A tail-anchored partial prefix is emitted here (documented trade-off).
   */
  flush(sessionId: string, messageId: string, now?: number): string[] {
    const key = `${sessionId}\u0000${messageId}`
    const window = this.windows.get(key)
    if (window === undefined) return []
    if (now !== undefined) window.lastActivity = now
    this.windows.delete(key)
    if (window.held.length === 0) return []
    return this.emitSlice(window, window.held)
  }

  /**
   * Flushes every window OWNED BY one session (turn end / cancel), in
   * per-key insertion order. Session-scoped by design: a concurrent turn for
   * a DIFFERENT session sharing this holdback instance (one bridge instance
   * serves every socket connection) must never have its held text released
   * through this turn's sink — cross-session routing is the reviewer finding
   * this method exists to close.
   */
  flushSession(sessionId: string, now?: number): string[] {
    const prefix = `${sessionId}\u0000`
    const pieces: string[] = []
    for (const [key, window] of [...this.windows]) {
      if (!key.startsWith(prefix)) continue
      if (now !== undefined) window.lastActivity = now
      this.windows.delete(key)
      if (window.held.length > 0) {
        pieces.push(...this.emitSlice(window, window.held))
      }
      void key
    }
    return pieces
  }

  /**
   * Flushes every held window regardless of session. RESERVED for whole-
   * process teardown only — never call this from a per-turn path.
   */
  flushAll(now?: number): string[] {
    const pieces: string[] = []
    for (const [key, window] of [...this.windows]) {
      if (now !== undefined) window.lastActivity = now
      this.windows.delete(key)
      if (window.held.length > 0) {
        pieces.push(...this.emitSlice(window, window.held))
      }
      void key
    }
    return pieces
  }

  /**
   * Flushes windows OWNED BY one session idle for at least `idleMs`
   * (§12.8: 250 ms idle flush). Session-scoped for the same reason as
   * {@link flushSession}: the host's per-turn idle timer must only release
   * the OWNING session's windows, never another session's held text.
   */
  flushIdleSession(
    sessionId: string,
    now: number,
    idleMs: number,
  ): string[] {
    const prefix = `${sessionId}\u0000`
    const pieces: string[] = []
    for (const [key, window] of [...this.windows]) {
      if (!key.startsWith(prefix)) continue
      if (now - window.lastActivity >= idleMs) {
        this.windows.delete(key)
        if (window.held.length > 0) {
          pieces.push(...this.emitSlice(window, window.held))
        }
      }
      void key
    }
    return pieces
  }

  /**
   * Pulls the intended cut position back to the latest position where the
   * emitted prefix `held.slice(0, safe)` contains no PARTIAL protected
   * value: every full occurrence either ends at or before `safe` or starts
   * at or after `safe`, and no tail-anchored partial prefix (which may
   * complete in a future chunk) is emitted. Returns the safe cut, or
   * `undefined` when the whole window must stay held.
   *
   * Algorithm (bounded, deterministic — GV-27 / RF-11):
   * 1. Collect the boundaries of every full occurrence in the held window:
   *    each configured credential and every full cap.v3 token (anchor plus
   *    its trailing token-run characters).
   * 2. Compute the tail-hold ceiling: the earliest start of a tail-anchored
   *    PARTIAL prefix. For credentials a full occurrence at the tail is
   *    complete (redactable as a whole), so only proper prefixes count; for
   *    the cap.v3 anchor even a full anchor match at the tail may complete
   *    in the next chunk, so it holds too.
   * 3. Walk candidates downward from `min(cut, tailHold)`: while some full
   *    occurrence straddles the candidate, jump the candidate to the largest
   *    straddling occurrence's START (strictly decreasing, so this
   *    terminates, and the result is the LARGEST valid cut at or below the
   *    ceiling). A candidate of 0 means no safe cut exists.
   */
  private pullCutBack(
    window: HoldbackWindow,
    cut: number,
  ): number | undefined {
    const held = window.held
    type Occurrence = { start: number; end: number }
    const occurrences: Occurrence[] = []
    for (const value of window.credentials) {
      if (value.length === 0) continue
      let searchFrom = 0
      for (;;) {
        const idx = held.indexOf(value, searchFrom)
        if (idx === -1) break
        searchFrom = idx + 1
        occurrences.push({ start: idx, end: idx + value.length })
      }
    }
    // cap.v3 token family (a value shape, not a literal): full tokens are
    // the anchor plus its trailing token-run characters.
    const TOKEN_ANCHOR = 'cap.v3.'
    const isTokenRunChar = (ch: string): boolean => /[A-Za-z0-9._-]/.test(ch)
    let tokenSearchFrom = 0
    for (;;) {
      const idx = held.indexOf(TOKEN_ANCHOR, tokenSearchFrom)
      if (idx === -1) break
      tokenSearchFrom = idx + 1
      let end = idx + TOKEN_ANCHOR.length
      for (;;) {
        const ch = held[end]
        if (ch === undefined || !isTokenRunChar(ch)) break
        end += 1
      }
      occurrences.push({ start: idx, end })
    }

    // Tail-hold ceiling: the earliest start among tail-anchored PARTIAL
    // prefixes. The longest matching prefix gives the earliest start, so the
    // scan stops at the first (longest) match per value.
    let tailHold: number | undefined
    const considerTail = (value: string, includeFull: boolean): void => {
      const maxPrefix = includeFull
        ? Math.min(value.length, held.length)
        : Math.min(value.length - 1, held.length)
      for (let prefixLength = maxPrefix; prefixLength >= 1; prefixLength -= 1) {
        if (held.endsWith(value.slice(0, prefixLength))) {
          const start = held.length - prefixLength
          if (tailHold === undefined || start < tailHold) tailHold = start
          return
        }
      }
    }
    for (const value of window.credentials) {
      if (value.length > 0) considerTail(value, false)
    }
    considerTail('cap.v3.1.', true)
    considerTail('cap.v3.', true)

    let candidate = tailHold !== undefined ? Math.min(cut, tailHold) : cut
    if (candidate <= 0) return undefined
    for (;;) {
      let blocked: Occurrence | undefined
      for (const occurrence of occurrences) {
        if (
          occurrence.start < candidate &&
          occurrence.end > candidate &&
          (blocked === undefined || occurrence.start > blocked.start)
        ) {
          blocked = occurrence
        }
      }
      if (blocked === undefined) break
      candidate = blocked.start
      if (candidate <= 0) return undefined
    }
    return candidate
  }

  /**
   * Sanitizes one contiguous RAW slice and returns it as a single piece.
   * Slices are chosen before this call so a protected value can never be
   * split across two pieces; the redaction itself stays whole per slice.
   */
  private emitSlice(window: HoldbackWindow, text: string): string[] {
    if (text.length === 0) return []
    // Configured credentials are redacted by VALUE, not only by shape: a
    // value with no recognizable provider-secret shape must never cross the
    // wire either. Value-redaction cannot be defeated by a split because
    // every slice boundary was verified (pullCutBack) to never cut inside a
    // credential, so any slice containing part of a credential contains the
    // whole credential (GV-27 / RF-11).
    let sanitized = text
    for (const value of window.credentials) {
      if (value.length === 0) continue
      sanitized = sanitized.split(value).join('[REDACTED_SECRET]')
    }
    return [sanitizeOutbound(sanitized)]
  }
}

/**
 * NEW-4 chokepoint (§12.8, GV-28): wraps the WritableStream handed to
 * `ndJsonStream` so every serialized frame passes through
 * {@link sanitizeOutbound} before the wire. A chunk that contains no
 * redactable text is forwarded byte-identical; a redacted chunk is re-encoded
 * as UTF-8 through the wrapped target. SDK-generated JSON-RPC errors,
 * agent→client requests, and `$/cancel_request` all cross this wrapper.
 */
export function sanitizeOutboundStream(
  target: WritableStream<Uint8Array>,
): WritableStream<Uint8Array> {
  const decoder = new TextDecoder('utf8', { fatal: false })
  const encoder = new TextEncoder()
  return new WritableStream<Uint8Array>({
    async write(chunk) {
      const frame = decoder.decode(chunk, { stream: true })
      const sanitized = sanitizeOutbound(frame)
      if (sanitized === frame) {
        // No redaction applies: forward the original bytes unchanged.
        await writeThrough(target, chunk)
        return
      }
      await writeThrough(target, encoder.encode(sanitized))
    },
    async close() {
      // Flush the streaming decoder's tail before closing: a frame whose final
      // bytes are an incomplete UTF-8 sequence is held by `stream: true`
      // decoding and must still be sanitized and written before the wire ends.
      const tail = decoder.decode()
      if (tail.length > 0) {
        await writeThrough(target, encoder.encode(sanitizeOutbound(tail)))
      }
      return closeThrough(target)
    },
    abort(reason) {
      return abortThrough(target, reason)
    },
  })
}

async function writeThrough(
  target: WritableStream<Uint8Array>,
  chunk: Uint8Array,
): Promise<void> {
  const writer = target.getWriter()
  try {
    await writer.write(chunk)
  } finally {
    // Release WITHOUT closing: the writer is a per-call borrow, and the
    // target stream itself stays open for the next frame.
    writer.releaseLock()
  }
}

async function closeThrough(target: WritableStream<Uint8Array>): Promise<void> {
  const writer = target.getWriter()
  try {
    await writer.close()
  } catch {
    // The target may already be closed by its owner; closing is best-effort.
  } finally {
    writer.releaseLock()
  }
}

async function abortThrough(
  target: WritableStream<Uint8Array>,
  reason: unknown,
): Promise<void> {
  const writer = target.getWriter()
  try {
    await writer.abort(reason)
  } catch {
    // Best-effort: the target may already be errored/closed.
  } finally {
    writer.releaseLock()
  }
}

// ---------------------------------------------------------------------------
// §12.6 outbound backpressure (per-connection byte-capped queue)
// ---------------------------------------------------------------------------

/** §12.6: a connection's outbound queue is capped at 32 MiB. */
export const OUTBOUND_QUEUE_MAX_BYTES = 32 * 1024 * 1024

/** `sessionUpdate` kinds whose frames coalesce by concatenating `content.text`. */
const CHUNK_TEXT_KINDS = new Set(['agent_message_chunk', 'agent_thought_chunk'])

function isPlainRecordFrame(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Returns the record actually holding the session/update payload fields. */
function frameContainer(frame: Record<string, unknown>): Record<string, unknown> {
  if (typeof frame.sessionUpdate === 'string') return frame
  const params = frame.params
  if (isPlainRecordFrame(params)) {
    if (isPlainRecordFrame(params.update)) return params.update
    return params
  }
  return frame
}

/** Replaces the payload-holding container of `frame` with `merged`. */
function replaceContainer(
  frame: Record<string, unknown>,
  merged: Record<string, unknown>,
): void {
  if (typeof frame.sessionUpdate === 'string') {
    for (const key of Object.keys(frame)) delete frame[key]
    Object.assign(frame, merged)
    return
  }
  const params = frame.params
  if (isPlainRecordFrame(params)) {
    if (isPlainRecordFrame(params.update)) {
      params.update = merged
    } else {
      frame.params = merged
    }
    return
  }
  for (const key of Object.keys(frame)) delete frame[key]
  Object.assign(frame, merged)
}

/**
 * The stable identity tying consecutive coalesceable frames together:
 * `messageId` for chunk frames, `toolCallId` for `tool_call_update`. Returns
 * `undefined` for a non-coalesceable frame.
 */
function coalesceIdOf(frame: Record<string, unknown>): string | undefined {
  const container = frameContainer(frame)
  const kind = container.sessionUpdate
  if (typeof kind === 'string' && CHUNK_TEXT_KINDS.has(kind)) {
    const id = container.messageId
    return typeof id === 'string' && id.length > 0 ? id : undefined
  }
  if (kind === 'tool_call_update') {
    const id = container.toolCallId
    return typeof id === 'string' && id.length > 0 ? id : undefined
  }
  return undefined
}

/**
 * Merges `incoming` into the queued `existing` frame in place. Two chunk
 * frames for the same `messageId` concatenate their `content.text`. Two
 * `tool_call_update` frames for the same `toolCallId` keep the LATER frame's
 * fields (a status transition supersedes the earlier one) while concatenating
 * any `content` arrays so no emitted block is lost. Returns whether a merge
 * happened; the two frames must share a `sessionUpdate` kind and an id.
 */
function coalesceFrames(
  existing: Record<string, unknown>,
  incoming: Record<string, unknown>,
): boolean {
  const existingId = coalesceIdOf(existing)
  const incomingId = coalesceIdOf(incoming)
  if (existingId === undefined || existingId !== incomingId) return false
  const existingContainer = frameContainer(existing)
  const incomingContainer = frameContainer(incoming)
  const kind = existingContainer.sessionUpdate
  if (kind !== incomingContainer.sessionUpdate) return false

  if (typeof kind === 'string' && CHUNK_TEXT_KINDS.has(kind)) {
    const existingContent = existingContainer.content
    const incomingContent = incomingContainer.content
    if (
      isPlainRecordFrame(existingContent) &&
      isPlainRecordFrame(incomingContent) &&
      typeof existingContent.text === 'string' &&
      typeof incomingContent.text === 'string'
    ) {
      existingContent.text =
        (existingContent.text as string) + (incomingContent.text as string)
      return true
    }
    return false
  }

  // tool_call_update: the later frame's scalar fields supersede the earlier
  // one; content arrays concatenate so no emitted block is lost.
  const merged: Record<string, unknown> = { ...existingContainer }
  for (const [key, value] of Object.entries(incomingContainer)) {
    if (key === 'content') continue
    merged[key] = value
  }
  const existingContent = existingContainer.content
  const incomingContent = incomingContainer.content
  if (Array.isArray(existingContent) || Array.isArray(incomingContent)) {
    merged.content = [
      ...(Array.isArray(existingContent) ? existingContent : []),
      ...(Array.isArray(incomingContent) ? incomingContent : []),
    ]
  }
  replaceContainer(existing, merged)
  return true
}

/** The run-abort decision returned by an overflow that coalescing cannot fix. */
export type OutboundQueueAbort = {
  stopReason: 'cancelled'
  sessionId: string | undefined
}

export type OutboundEnqueueResult =
  | { status: 'queued' }
  | { status: 'coalesced' }
  | { status: 'abort'; abort: OutboundQueueAbort }

type QueueEntry = {
  frame: Record<string, unknown>
  bytes: number
  sessionId: string | undefined
}

/**
 * §12.6 outbound backpressure queue (per connection). Frames are enqueued as
 * already-sanitized serializable objects; the queue tracks their serialized
 * UTF-8 byte size against {@link OUTBOUND_QUEUE_MAX_BYTES}.
 *
 * Overflow handling is two-stage, in the order §12.6 prescribes:
 * 1. Coalesce: walk the queue and merge consecutive
 *    `agent_message_chunk`/`tool_call_update` frames that share an id. This
 *    shrinks the queue without dropping any text or terminal status.
 * 2. Abort: if the queue is STILL over the cap after coalescing, the run
 *    producing the flood is aborted with `stopReason: 'cancelled'` and the
 *    frame is dropped, so a stalled reader can never grow memory without
 *    bound. The abort decision is returned for the host to act on (the queue
 *    itself owns no run lifecycle).
 */
export class OutboundQueue {
  private readonly maxBytes: number
  private readonly entries: QueueEntry[] = []
  private totalBytes = 0

  constructor(maxBytes: number = OUTBOUND_QUEUE_MAX_BYTES) {
    this.maxBytes = maxBytes
  }

  /** Current queued byte total (serialized UTF-8). */
  get byteLength(): number {
    return this.totalBytes
  }

  /** Number of queued frames. */
  get size(): number {
    return this.entries.length
  }

  /** Extracts the sessionId a frame belongs to, when one is present. */
  private sessionIdOf(frame: Record<string, unknown>): string | undefined {
    if (typeof frame.sessionId === 'string') return frame.sessionId
    const params = frame.params
    if (isPlainRecordFrame(params) && typeof params.sessionId === 'string') {
      return params.sessionId
    }
    return undefined
  }

  private byteSizeOf(frame: Record<string, unknown>): number {
    return new TextEncoder().encode(JSON.stringify(frame)).byteLength
  }

  /**
   * Enqueues one frame. Coalesces into the immediately-preceding queued frame
   * when both are coalesceable and share an id. On overflow, coalesces the
   * whole queue; when that is not enough, returns the abort decision instead
   * of queueing (the run is cancelled and the frame dropped — fail closed).
   */
  enqueue(frame: Record<string, unknown>): OutboundEnqueueResult {
    const sessionId = this.sessionIdOf(frame)

    // Fast path: merge into the tail when it is the same coalesceable stream.
    const tail = this.entries[this.entries.length - 1]
    if (tail !== undefined && coalesceFrames(tail.frame, frame)) {
      const resized = this.byteSizeOf(tail.frame)
      this.totalBytes += resized - tail.bytes
      tail.bytes = resized
      if (this.totalBytes <= this.maxBytes) return { status: 'coalesced' }
    } else {
      const bytes = this.byteSizeOf(frame)
      this.entries.push({ frame, bytes, sessionId })
      this.totalBytes += bytes
      if (this.totalBytes <= this.maxBytes) return { status: 'queued' }
    }

    // Overflow: coalesce every consecutive mergeable run, then re-measure.
    this.coalesceAll()
    if (this.totalBytes <= this.maxBytes) {
      return { status: 'coalesced' }
    }

    // Still over the cap: abort the run rather than grow without bound.
    this.removeLast()
    return {
      status: 'abort',
      abort: { stopReason: 'cancelled', sessionId },
    }
  }

  /** Removes and returns the oldest queued frame, or `undefined` when empty. */
  dequeue(): Record<string, unknown> | undefined {
    const entry = this.entries.shift()
    if (entry === undefined) return undefined
    this.totalBytes -= entry.bytes
    return entry.frame
  }

  /** Drains every queued frame in FIFO order. */
  drain(): Array<Record<string, unknown>> {
    const out: Array<Record<string, unknown>> = []
    let frame = this.dequeue()
    while (frame !== undefined) {
      out.push(frame)
      frame = this.dequeue()
    }
    return out
  }

  /** Clears the queue (teardown / after an abort). */
  clear(): void {
    this.entries.length = 0
    this.totalBytes = 0
  }

  private removeLast(): void {
    const entry = this.entries.pop()
    if (entry !== undefined) this.totalBytes -= entry.bytes
  }

  /** Merges every run of consecutive coalesceable frames sharing an id. */
  private coalesceAll(): void {
    if (this.entries.length < 2) return
    const merged: QueueEntry[] = []
    let total = 0
    for (const entry of this.entries) {
      const tail = merged[merged.length - 1]
      if (tail !== undefined && coalesceFrames(tail.frame, entry.frame)) {
        const resized = this.byteSizeOf(tail.frame)
        total += resized - tail.bytes
        tail.bytes = resized
        continue
      }
      merged.push(entry)
      total += entry.bytes
    }
    this.entries.length = 0
    this.entries.push(...merged)
    this.totalBytes = total
  }
}
