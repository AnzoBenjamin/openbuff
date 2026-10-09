import { timingSafeEqual } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  lstatSync,
  openSync,
  statSync,
  unlinkSync,
} from 'node:fs'
import { createServer } from 'node:net'
import type { Socket } from 'node:net'
import { dirname } from 'node:path'
import { Readable } from 'node:stream'

import { AgentSideConnection, ndJsonStream } from '@agentclientprotocol/sdk'

import {
  createAcpAgent,
  resolveAcpServeOptions,
} from '../services/acp/acp-agent'
import type { AcpAgentOptions } from '../services/acp/acp-agent'
import {
  OutboundQueue,
  OUTBOUND_QUEUE_MAX_BYTES,
  sanitizeOutboundStream,
} from './outbound'

/**
 * Options for {@link serveAcpOverSocket}. Everything the ACP agent needs
 * (`promptHandler`, `sessionData`, `loadHandler`, ...) rides through the
 * `Omit<AcpAgentOptions, 'connection'>` spread — the per-connection
 * `connection` is minted inside this transport. `socketPath`/`token` are the
 * unix-socket transport surface; the callbacks are observability seams the
 * CLI/tests bind.
 */
export type ServeAcpOverSocketOptions = Omit<AcpAgentOptions, 'connection'> & {
  /** Absolute path of the unix domain socket to bind. NEVER a TCP address. */
  socketPath: string
  /**
   * Shared secret every client must present as its first line (see SEC-4
   * below). Compared in constant time; never logged.
   */
  token: string
  /** Fired once the socket is bound and chmod'd 0o600. */
  onListening?: (info: { socketPath: string }) => void
  /**
   * Fired when a connection is rejected. Receives a reason STRING only
   * ('timeout' | 'bad-token' | 'auth-line-too-long') — never the token.
   */
  onAuthFailure?: (reason: string) => void
  /** Closes the server when aborted. */
  signal?: AbortSignal
  /**
   * Grace window (ms) for a connection to send its auth line before it is
   * destroyed. Defaults to 5000; tests inject a short value.
   */
  authTimeoutMs?: number
}

/**
 * Hard cap on the buffered auth line before the newline arrives. A client that
 * never sends a newline is already bounded in TIME by the auth timeout; this
 * bounds it in SPACE so a same-uid peer cannot force unbounded buffer growth
 * inside the grace window.
 */
const MAX_AUTH_LINE_BYTES = 64 * 1024

/**
 * Serves the Wave-1 ACP agent over a unix domain socket, honoring
 * P1-T1-DESIGN §SEC-4 socket auth. UNIX-SOCKET ONLY — there is no TCP listener
 * anywhere in this module by design.
 *
 * SEC-4 layered auth model:
 *  1. OS-credential layer. The parent directory is asserted safe
 *     ({@link assertSocketDirSafe}): it must exist, be a real directory (not a
 *     symlink), be owned by the current euid, and carry no group/other write
 *     bits. The socket itself is chmod'd `0o600` synchronously immediately
 *     after the bind, BEFORE any accept callback can run (no bind→chmod
 *     connectability window). Together the
 *     owner-only directory + `0o600` socket mean ONLY the same uid can even
 *     `connect()` — this is the SO_PEERCRED-equivalent guard, since node does
 *     not expose the peer uid directly.
 *  2. Token layer. Because a DIFFERENT process running as the SAME uid could
 *     still connect, every connection must present a shared secret as its
 *     first line before any ACP framing. The token defends against that
 *     same-uid peer.
 *
 * Stale-socket handling takes an exclusive `${socketPath}.lock` first
 * (`openSync(..., 'wx')`); only while holding the lock is a pre-existing
 * SOCKET at `socketPath` unlinked (a non-socket path is refused). The lock is
 * released/unlinked on close, and also if binding fails, so a crash cannot
 * strand it.
 *
 * Auth-line/stream boundary contract (documented so the client wave matches):
 * the client sends exactly one JSON line
 * `{"type":"openbuff.serve.auth","token":"<token>"}\n` and then IMMEDIATELY
 * begins ACP ndJson framing on the SAME socket. The server buffers bytes until
 * the first `\n`, validates the token in constant time, unshifts any bytes
 * that arrived after the newline back onto the socket, and only then hands the
 * socket to `ndJsonStream` + a per-connection `AgentSideConnection` exactly
 * like `serveAcpOverStdio`. No ack byte is sent — a valid token is silently
 * followed by ACP framing.
 *
 * @returns `{ close }` — closes the server, unlinks the socket + lock, and is
 * idempotent. Closes automatically if `options.signal` aborts.
 */
export function serveAcpOverSocket(options: ServeAcpOverSocketOptions): {
  close: () => Promise<void>
} {
  const {
    socketPath,
    token,
    onListening,
    onAuthFailure,
    signal,
    authTimeoutMs = 5000,
    ...agentOptions
  } = options

  // SEC-4 step 1: refuse an unsafe parent directory (and an unsupported
  // platform) BEFORE binding or touching the lock.
  assertSocketDirSafe(socketPath)

  const lockPath = `${socketPath}.lock`
  // SEC-4 step 2: take an exclusive lock. 'wx' fails if the lock already
  // exists — another server may own this socket, so refuse rather than race.
  let lockFd: number
  try {
    lockFd = openSync(lockPath, 'wx')
  } catch {
    throw new Error(
      `refusing to serve: lock file already exists (another server may own it): ${lockPath}`,
    )
  }

  let lockReleased = false
  const releaseLock = (): void => {
    if (lockReleased) return
    lockReleased = true
    try {
      closeSync(lockFd)
    } catch {}
    try {
      unlinkSync(lockPath)
    } catch {}
  }

  try {
    // SEC-4 step 3: only while HOLDING the lock, remove a stale socket. A path
    // that exists but is NOT a socket is refused (never blindly unlinked).
    const existing = lstatSync(socketPath, { throwIfNoEntry: false })
    if (existing) {
      if (!existing.isSocket()) {
        throw new Error(
          `refusing to serve: path exists and is not a socket: ${socketPath}`,
        )
      }
      unlinkSync(socketPath)
    }

    // Auto-derive the session/load restore handler once, then reuse it for
    // every connection's agent (mirrors serveAcpOverStdio).
    const resolvedOptions = resolveAcpServeOptions(agentOptions)

    const server = createServer((socket) => {
      handleConnection(socket, token, authTimeoutMs, resolvedOptions, onAuthFailure)
    })

    // SEC-4 step 4: bind, then chmod 0o600 so ONLY the owner uid can connect.
    // The chmod runs SYNCHRONOUSLY right after listen() returns, before any
    // event-loop turn: node binds a unix socket inside the listen() call
    // (uv_pipe_bind creates the socket inode), while the 'listening' and
    // connection callbacks only run on a later turn. chmod'ing in the
    // listening callback left a bind→chmod window in which the inode existed
    // with the process-default mode and a same-uid peer could connect()
    // before the mode was tightened. A failed bind leaves no inode (ENOENT):
    // the real bind error then surfaces through the server 'error' handler
    // below; any OTHER chmod failure is fail-loud.
    server.listen(socketPath, () => {
      onListening?.({ socketPath })
    })
    try {
      chmodSync(socketPath, 0o600)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw err
      }
    }

    let closed = false
    const onAbort = (): void => {
      void close()
    }
    const close = async (): Promise<void> => {
      if (closed) return
      closed = true
      if (signal) signal.removeEventListener('abort', onAbort)
      await new Promise<void>((resolve) => server.close(() => resolve()))
      try {
        unlinkSync(socketPath)
      } catch {}
      releaseLock()
    }

    // A late bind error (e.g. the socket path became unusable) must not strand
    // the lock: release it so a retry is not blocked by our own stale lock.
    server.on('error', () => {
      releaseLock()
    })

    if (signal) {
      if (signal.aborted) void close()
      else signal.addEventListener('abort', onAbort)
    }

    return { close }
  } catch (err) {
    // A failed stale-socket check / bind setup must not leave a stale lock.
    releaseLock()
    throw err
  }
}

/**
 * SEC-4 OS-credential precondition. The socket's PARENT directory must exist,
 * be a real directory (not a symlink), be owned by the current euid, and carry
 * no group/other write bits — so no other user can drop a socket or hijack the
 * path. `process.geteuid`/`getuid` are absent on Windows; without them the
 * OS-credential layer cannot be enforced, so unix-socket serving is refused
 * LOUDLY rather than silently degrading.
 */
export function assertSocketDirSafe(socketPath: string): void {
  if (
    typeof process.geteuid !== 'function' ||
    typeof process.getuid !== 'function'
  ) {
    throw new Error('unix socket serving is not supported on this platform')
  }
  const dir = dirname(socketPath)
  const linkStat = lstatSync(dir, { throwIfNoEntry: false })
  if (!linkStat) {
    throw new Error(`serve socket parent directory does not exist: ${dir}`)
  }
  if (linkStat.isSymbolicLink()) {
    throw new Error(`serve socket parent directory must not be a symlink: ${dir}`)
  }
  const dirStat = statSync(dir)
  if (!dirStat.isDirectory()) {
    throw new Error(`serve socket parent is not a directory: ${dir}`)
  }
  if (dirStat.uid !== process.geteuid()) {
    throw new Error(
      `serve socket parent directory must be owned by the current user: ${dir}`,
    )
  }
  if ((dirStat.mode & 0o022) !== 0) {
    throw new Error(
      `serve socket parent directory must not be group/other-writable: ${dir}`,
    )
  }
}

/**
 * Per-connection SEC-4 token gate + ACP handoff. Buffers bytes until the first
 * newline, validates the auth line, then hands the socket to a per-connection
 * `AgentSideConnection` (tying each session to the connection that created
 * it). A connection that does not authenticate within `authTimeoutMs`, sends a
 * bad token, or overflows the auth-line buffer is destroyed and reported via
 * `onAuthFailure` — with a reason STRING only, never the token.
 */
function handleConnection(
  socket: Socket,
  token: string,
  authTimeoutMs: number,
  resolvedOptions: Omit<AcpAgentOptions, 'connection'>,
  onAuthFailure?: (reason: string) => void,
): void {
  let buffer = Buffer.alloc(0)
  let settled = false

  const timer = setTimeout(() => {
    if (settled) return
    settled = true
    socket.off('data', onData)
    onAuthFailure?.('timeout')
    socket.destroy()
  }, authTimeoutMs)
  // Never let the auth-timeout timer keep the event loop / process alive.
  timer.unref()

  const onData = (chunk: Buffer): void => {
    if (settled) return
    buffer = Buffer.concat([buffer, chunk])
    const newlineIndex = buffer.indexOf(0x0a)
    if (newlineIndex === -1) {
      if (buffer.length > MAX_AUTH_LINE_BYTES) {
        settled = true
        clearTimeout(timer)
        socket.off('data', onData)
        onAuthFailure?.('auth-line-too-long')
        socket.destroy()
      }
      return
    }
    settled = true
    clearTimeout(timer)
    // Pause BEFORE detaching the listener so no post-newline bytes are lost in
    // the window before ndJsonStream starts reading.
    socket.pause()
    socket.off('data', onData)

    const line = buffer.subarray(0, newlineIndex).toString('utf8')
    const rest = buffer.subarray(newlineIndex + 1)

    if (!verifyAuthLine(line, token)) {
      onAuthFailure?.('bad-token')
      socket.destroy()
      return
    }

    // Valid token: re-feed any bytes that arrived after the auth line, then
    // hand the socket to ACP ndJson framing exactly like serveAcpOverStdio.
    // The node<->web stream conversion cast pattern is copied verbatim from
    // serveAcpOverStdio: the SDK Stream type is defined over web streams.
    if (rest.length > 0) {
      socket.unshift(rest)
    }
    // NEW-4 chokepoint (§12.8): every serialized frame — including
    // SDK-generated JSON-RPC errors and agent→client requests — crosses
    // sanitizeOutbound before the wire; clean frames stay byte-identical.
    // §12.6 (OutboundQueue wiring): the sanitized frames then flow through
    // a per-connection queue that coalesces and drains respecting the
    // socket's backpressure; an overflow abort destroys the connection
    // (fail closed), which cancels the in-flight turn via the normal
    // owner-disconnect path.
    const stream = ndJsonStream(
      sanitizeOutboundStream(createOutboundQueueWritable(socket)),
      Readable.toWeb(socket) as unknown as ReadableStream<Uint8Array>,
    )
    // A fresh AgentSideConnection per socket: the session map inside
    // createAcpAgent is per-connection, so a session is tied to the connection
    // that created it.
    void new AgentSideConnection(
      (conn) => createAcpAgent({ ...resolvedOptions, connection: conn }),
      stream,
    )
  }

  socket.on('data', onData)
}

/**
 * Validates a single auth line against the expected token. The line must be
 * `{"type":"openbuff.serve.auth","token":"<token>"}`. `timingSafeEqual` throws
 * on a length mismatch, so byte-lengths are pre-checked and fail closed
 * without calling it; otherwise the compare is constant time.
 */
function verifyAuthLine(line: string, expectedToken: string): boolean {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return false
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    (parsed as Record<string, unknown>).type !== 'openbuff.serve.auth'
  ) {
    return false
  }
  const provided = (parsed as Record<string, unknown>).token
  if (typeof provided !== 'string') return false
  const providedBuf = Buffer.from(provided, 'utf8')
  const expectedBuf = Buffer.from(expectedToken, 'utf8')
  // Fail closed on length mismatch before timingSafeEqual (which throws).
  if (providedBuf.length !== expectedBuf.length) return false
  return timingSafeEqual(providedBuf, expectedBuf)
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * The node writable the queued outbound path writes to. Structurally
 * satisfied by a net `Socket` (and by test fakes), so the §12.6 wiring stays
 * testable without real sockets.
 */
export type OutboundQueueWritableTarget = {
  /** Returns false when the writable's buffer is full (backpressure). */
  write: (chunk: Uint8Array) => boolean
  once: (event: 'drain', listener: () => void) => unknown
  destroy: () => void
  end?: () => unknown
}

/**
 * §12.6 outbound backpressure wiring (per connection): wraps the socket the
 * authenticated connection writes to so every outbound NDJSON frame is
 * enqueued into a per-connection {@link OutboundQueue} (which coalesces
 * consecutive chunk/update frames) and drained respecting the writable's
 * backpressure — writes continue while `write()` reports buffered capacity
 * and PAUSE the moment it returns false, resuming on 'drain'. A client that
 * keeps up therefore takes the immediate-write fast path; the queue only
 * grows while the client is genuinely stalled. When the queue's overflow
 * decision is `abort` (coalescing could not bring it back under its byte
 * cap) the connection is DESTROYED — fail closed. The existing
 * owner-disconnect path already aborts the in-flight turn and cancels
 * pending reverse requests on a destroyed socket, realizing §12.6's 'run
 * cancelled' semantics at the transport level.
 *
 * Frames are re-serialized as `JSON.stringify(frame) + '\n'` after the
 * round-trip through the queue; the sanitize chokepoint runs BEFORE this
 * wrapper (see handleConnection), so no unsanitized text can reach the wire.
 *
 * stdio stays UNWIRED deliberately: it is a process-lifetime transport whose
 * single peer is the host process reading our stdout, so there is no
 * per-connection backpressure boundary to protect.
 */
export function createOutboundQueueWritable(
  target: OutboundQueueWritableTarget,
  options?: { maxBytes?: number },
): WritableStream<Uint8Array> {
  const queue = new OutboundQueue(options?.maxBytes ?? OUTBOUND_QUEUE_MAX_BYTES)
  const decoder = new TextDecoder('utf8', { fatal: false })
  const encoder = new TextEncoder()
  let lineBuffer = ''
  let stalled = false
  let aborted = false

  const flushQueue = (): void => {
    if (stalled || aborted) return
    for (;;) {
      const frame = queue.dequeue()
      if (frame === undefined) return
      if (!target.write(encoder.encode(`${JSON.stringify(frame)}\n`))) {
        // Backpressure: the socket's buffer is full (the frame just handed
        // to write() is already buffered by the socket). Pause the drain and
        // resume on 'drain'; frames enqueued meanwhile stay queued.
        stalled = true
        target.once('drain', () => {
          stalled = false
          flushQueue()
        })
        return
      }
    }
  }

  /**
   * Fails closed: clears the queue, destroys the connection, errors the
   * stream. Declared `never` — it ALWAYS throws, so the compiler knows calls
   * terminate control flow and downstream narrowing survives.
   */
  // Variable-level `(reason: string) => never` annotation: TS's
  // never-return call analysis (which makes the guards below terminate
  // control flow so `parsed` narrows to Record<string, unknown>) only
  // applies when the const CARRIES an explicit never-typed signature, not
  // merely an inline arrow return type.
  const failClosed: (reason: string) => never = (reason) => {
    aborted = true
    queue.clear()
    target.destroy()
    throw new Error(reason)
  }

  return new WritableStream<Uint8Array>({
    write(chunk) {
      if (aborted) return
      lineBuffer += decoder.decode(chunk, { stream: true })
      for (;;) {
        const newlineIndex = lineBuffer.indexOf('\n')
        if (newlineIndex === -1) break
        const line = lineBuffer.slice(0, newlineIndex).trim()
        lineBuffer = lineBuffer.slice(newlineIndex + 1)
        if (line.length === 0) continue
        let parsed: unknown
        try {
          parsed = JSON.parse(line)
        } catch {
          failClosed(
            'outbound frame was not valid JSON; closing connection (fail closed).',
          )
        }
        if (!isJsonObject(parsed)) {
          failClosed(
            'outbound frame was not a JSON object; closing connection (fail closed).',
          )
        }
        const result = queue.enqueue(parsed)
        if (result.status === 'abort') {
          failClosed(
            'outbound queue overflow could not be coalesced; closing connection.',
          )
        }
      }
      flushQueue()
    },
    close() {
      lineBuffer = ''
      queue.clear()
      target.end?.()
    },
    abort() {
      aborted = true
      queue.clear()
      target.destroy()
    },
  })
}
