import { PassThrough, type Readable, type Writable } from 'node:stream'

/**
 * SB-7: Chrome DevTools Protocol transport over `--remote-debugging-pipe`.
 *
 * The prior implementation launched Chrome with `--remote-debugging-port`, which
 * opens an UNAUTHENTICATED HTTP + WebSocket listener on 127.0.0.1: any local
 * process (or a browser page navigated to a malicious origin that can reach
 * localhost) could enumerate `/json/list` and drive the debugger. The pipe
 * transport removes that listener entirely — Chrome reads CDP commands from fd 3
 * and writes responses/events to fd 4, so the debugging channel is reachable
 * only by the parent process that owns those file descriptors.
 *
 * Wire framing: each CDP message is a UTF-8 JSON object terminated by a single
 * NUL byte (`\0`). One flat connection multiplexes every target via a top-level
 * `sessionId` on both commands and events (CDP "flatten" mode). Request/response
 * correlation uses a monotonic integer `id` shared across the whole pipe.
 *
 * This module is deliberately decoupled from `child_process`: it takes a
 * Writable (fd 3) and a Readable (fd 4) so the framing, routing, buffering
 * bounds, and lifecycle can be unit-tested with in-memory streams and no real
 * Chrome.
 */

export type CdpPipeMessage = {
  id?: number
  method?: string
  params?: Record<string, unknown>
  result?: unknown
  error?: { message?: string; code?: number }
  sessionId?: string
}

type CdpPending = {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timeout: ReturnType<typeof setTimeout>
}

export type CdpPipeTransportOptions = {
  /** fd 3: the parent writes CDP commands here (Chrome reads them). */
  writable: Writable
  /** fd 4: Chrome writes responses/events here (the parent reads them). */
  readable: Readable
  /**
   * Dispatched for every inbound message that carries a `method` (a CDP event).
   * The `sessionId` (if any) is preserved so the caller can route the event to
   * the owning target.
   */
  onEvent?: (message: CdpPipeMessage) => void
  /**
   * Called once when the pipe closes (readable `end`/`close`, an `error`, or an
   * explicit `close()`), after every pending request has been rejected.
   */
  onClose?: (error?: Error) => void
  /**
   * Hard cap on a single un-terminated frame. A hostile or malfunctioning peer
   * that never emits a NUL delimiter must not grow the buffer without bound, so
   * once the pending (delimiter-less) bytes exceed this the transport fails
   * closed. Defaults to 256 MiB, comfortably above a full-page screenshot.
   */
  maxBufferBytes?: number
}

const DEFAULT_MAX_BUFFER_BYTES = 256 * 1024 * 1024
const DELIMITER = 0x00

export class CdpPipeTransport {
  private readonly writable: Writable
  private readonly readable: Readable
  private readonly onEvent?: (message: CdpPipeMessage) => void
  private readonly onClose?: (error?: Error) => void
  private readonly maxBufferBytes: number

  private nextId = 1
  private readonly pending = new Map<number, CdpPending>()
  /**
   * Abort handles for frames currently deferred behind write backpressure;
   * destroy() resolves them so a closed transport never writes afterwards.
   */
  private readonly drainWaiters = new Set<() => void>()
  private buffer: Buffer = Buffer.alloc(0)
  /**
   * Backing-allocation model: `buffer` is the whole allocation, `bufferOffset`
   * marks the consumed prefix, `bufferEnd` the live end, and `buffer.length`
   * the capacity. Growth retains the allocation's slack, so a frame spanning
   * many chunks is appended into the live end in place instead of re-copying
   * the whole accumulated tail on every chunk.
   */
  private bufferOffset = 0
  private bufferEnd = 0
  /**
   * Index in `buffer` up to which the live bytes have already been scanned for
   * the NUL delimiter without finding one. Always >= bufferOffset. Carrying
   * this cursor across chunks means each inbound chunk is scanned only over
   * its own new bytes instead of rescanning the accumulated delimiter-free
   * tail on every chunk.
   */
  private scanOffset = 0
  private closed = false

  constructor(options: CdpPipeTransportOptions) {
    this.writable = options.writable
    this.readable = options.readable
    this.onEvent = options.onEvent
    this.onClose = options.onClose
    this.maxBufferBytes = options.maxBufferBytes ?? DEFAULT_MAX_BUFFER_BYTES

    this.readable.on('data', (chunk: Buffer | string) => {
      this.onData(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
    })
    // A closed or errored pipe means Chrome is gone; reject everything pending
    // so callers surface a real error instead of hanging until their timeout.
    this.readable.on('end', () => this.destroy())
    this.readable.on('close', () => this.destroy())
    this.readable.on('error', (error: Error) => this.destroy(error))
    this.writable.on('error', (error: Error) => this.destroy(error))
  }

  /**
   * Send a CDP command and resolve with its `result`. A top-level `sessionId`
   * routes the command to a specific attached target (flatten mode); omit it for
   * browser-level domains (e.g. Target.*). Rejects on a CDP `error`, on timeout,
   * or if the pipe is closed.
   */
  send(
    method: string,
    params: Record<string, unknown> = {},
    options: { sessionId?: string; timeoutMs?: number } = {},
  ): Promise<unknown> {
    if (this.closed) {
      return Promise.reject(new Error('CDP pipe transport is closed'))
    }
    const id = this.nextId++
    const timeoutMs = options.timeoutMs ?? 15_000
    const message: CdpPipeMessage = { id, method, params }
    if (options.sessionId) message.sessionId = options.sessionId

    const promise = new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (!this.pending.has(id)) return
        this.pending.delete(id)
        reject(new Error(`${method} timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timeout })
    })

    // A NUL byte can never appear in JSON.stringify output, so it is an
    // unambiguous frame delimiter.
    const payload = JSON.stringify(message) + '\0'
    // Honor the writable's backpressure signal (the same condition write()'s
    // `false` return reports): writeFrame defers this frame while the pipe's
    // outbound buffer sits at or above its high-water mark and waits for
    // 'drain', so a stalled Chrome reader cannot grow Node's internal send
    // buffer without bound. The pending timeout above still applies.
    void this.writeFrame(payload, timeoutMs).catch(() => undefined)
    return promise
  }

  /**
   * Place one framed command on the wire, deferring while the writable is
   * backpressured. The wait is bounded by `timeoutMs`: if the pipe has not
   * drained within that budget the frame is dropped and the pending request's
   * own timeout rejects the caller.
   */
  private async writeFrame(payload: string, timeoutMs: number): Promise<void> {
    while (!this.closed) {
      const buffered = this.writable.writableLength
      const highWaterMark = this.writable.writableHighWaterMark
      if (buffered === 0 || buffered < highWaterMark) {
        this.writable.write(payload)
        return
      }
      const drained = await new Promise<boolean>((resolve) => {
        const finish = (value: boolean) => {
          clearTimeout(timer)
          this.writable.removeListener('drain', onDrain)
          this.drainWaiters.delete(waiter)
          resolve(value)
        }
        const timer = setTimeout(() => finish(false), timeoutMs)
        const onDrain = () => finish(true)
        const waiter = () => finish(false)
        this.writable.once('drain', onDrain)
        this.drainWaiters.add(waiter)
      })
      if (!drained) return
    }
  }

  /** Number of in-flight requests awaiting a response. Exposed for tests. */
  get pendingCount(): number {
    return this.pending.size
  }

  get isClosed(): boolean {
    return this.closed
  }

  /** Explicitly tear down the transport and reject all pending requests. */
  close(): void {
    this.destroy()
  }

  private onData(chunk: Buffer): void {
    if (this.closed) return
    if (chunk.length > 0) {
      // Offset-based accumulation: bufferOffset marks the consumed prefix and
      // bufferEnd the live end of the backing allocation (buffer.length is the
      // full capacity), so appending never concatenates and consuming never
      // re-slices. Growth retains the allocation's slack, so a frame that
      // spans many chunks is appended into the live end in place instead of
      // re-copying the whole accumulated tail on every chunk.
      const liveLength = this.bufferEnd - this.bufferOffset
      if (liveLength === 0) {
        // Fast path: nothing buffered, adopt the chunk without a copy.
        this.buffer = chunk
        this.bufferOffset = 0
        this.bufferEnd = chunk.length
        this.scanOffset = 0
      } else if (this.bufferEnd + chunk.length <= this.buffer.length) {
        // Slack in the current allocation: append the chunk in place.
        chunk.copy(this.buffer, this.bufferEnd)
        this.bufferEnd += chunk.length
      } else if (chunk.length <= this.bufferOffset) {
        // The consumed prefix leaves room inside the existing allocation:
        // move the live remainder to the front (copyWithin handles the
        // overlap) and append the chunk behind it.
        this.buffer.copyWithin(0, this.bufferOffset, this.bufferEnd)
        chunk.copy(this.buffer, liveLength)
        this.scanOffset -= this.bufferOffset
        this.bufferOffset = 0
        this.bufferEnd = liveLength + chunk.length
      } else {
        // Grow with amortized doubling and copy ONLY the live remainder: the
        // old allocation (with its consumed prefix) is dropped instead of
        // being pinned by a subarray view. The new allocation keeps its
        // slack, so subsequent chunks append in place.
        const needed = liveLength + chunk.length
        let capacity = this.buffer.length * 2
        if (capacity < needed) capacity = needed
        const grown = Buffer.allocUnsafe(capacity)
        this.buffer.copy(grown, 0, this.bufferOffset, this.bufferEnd)
        chunk.copy(grown, liveLength)
        this.buffer = grown
        this.scanOffset -= this.bufferOffset
        this.bufferOffset = 0
        this.bufferEnd = needed
      }
    }

    // Frame scanning resumes at scanOffset — the carry-over cursor marking how
    // much of the live tail has already been searched without finding a NUL —
    // so each inbound chunk is scanned only over its own new bytes rather than
    // rescanning the accumulated multi-MB tail on every chunk. The scan runs
    // over the live view so the allocation's uninitialized slack is never
    // read, and the per-frame views handed to JSON.parse are transient and
    // safe.
    const live = this.buffer.subarray(0, this.bufferEnd)
    let searchFrom = this.scanOffset
    while (true) {
      const delimiterIndex = live.indexOf(DELIMITER, searchFrom)
      if (delimiterIndex === -1) break
      // The first frame starts at bufferOffset: bytes [bufferOffset,
      // scanOffset) are the already-scanned, delimiter-free head of a partial
      // frame that the delimiter now found completes.
      const frame = live.subarray(this.bufferOffset, delimiterIndex)
      this.bufferOffset = delimiterIndex + 1
      searchFrom = delimiterIndex + 1
      if (frame.length > 0) this.handleFrame(frame)
    }
    // indexOf returned -1 from searchFrom, so nothing in [searchFrom, liveEnd)
    // holds a delimiter; the next chunk resumes there instead of rescanning.
    this.scanOffset = this.bufferEnd

    // Fail closed on an un-terminated frame that exceeds the cap, rather than
    // letting a peer that never sends a delimiter grow memory without bound.
    // Compare LIVE bytes (bufferEnd - bufferOffset), not the raw allocation
    // length.
    if (this.bufferEnd - this.bufferOffset > this.maxBufferBytes) {
      this.destroy(
        new Error(
          `CDP pipe frame exceeded ${this.maxBufferBytes} bytes without a delimiter`,
        ),
      )
    }
  }

  private handleFrame(frame: Buffer): void {
    let message: CdpPipeMessage
    try {
      message = JSON.parse(frame.toString('utf8')) as CdpPipeMessage
    } catch {
      // A malformed frame is ignored (matches the prior WebSocket handler): a
      // single bad message must not tear down the whole session.
      return
    }

    if (typeof message.id === 'number') {
      const pending = this.pending.get(message.id)
      if (!pending) return
      this.pending.delete(message.id)
      clearTimeout(pending.timeout)
      if (message.error) {
        pending.reject(new Error(message.error.message ?? 'CDP command failed'))
        return
      }
      pending.resolve(message.result)
      return
    }

    if (message.method) {
      this.onEvent?.(message)
    }
  }

  private destroy(error?: Error): void {
    if (this.closed) return
    this.closed = true
    const rejection =
      error ?? new Error('CDP pipe transport closed before the response arrived')
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout)
      pending.reject(rejection)
    }
    this.pending.clear()
    // Release frames deferred behind write backpressure: a closed transport
    // must never place bytes on the wire afterwards.
    for (const waiter of this.drainWaiters) waiter()
    this.drainWaiters.clear()
    this.buffer = Buffer.alloc(0)
    this.bufferOffset = 0
    this.bufferEnd = 0
    this.scanOffset = 0
    try {
      this.readable.removeAllListeners()
    } catch {
      // ignore
    }
    this.onClose?.(error)
  }
}

/**
 * The slice of a WebSocket client the bridge below needs. Deliberately
 * structural: the real `ws` client satisfies it, and unit tests can supply a
 * fake peer without a live server.
 */
export type CdpWebSocket = {
  send: (data: string) => void
  close: () => void
  on: (
    event: 'open' | 'message' | 'close' | 'error',
    listener: (payload: unknown) => void,
  ) => void
}

/**
 * Upper bound on outbound bytes accumulated between NUL delimiters while
 * bridging transport frames to the WebSocket peer. Commands are small JSON
 * objects, so a peer-facing failure that stops framing must fail closed long
 * before this cap is reached instead of growing memory without bound.
 */
const MAX_PENDING_OUTBOUND_BYTES = 1024 * 1024

/**
 * Bridge a browser WebSocket (the `--remote-debugging-port` fallback for
 * browser builds without `--remote-debugging-pipe`) onto the same NUL-framed
 * stream contract CdpPipeTransport expects, so framing, pending-request
 * correlation, timeouts, and buffer bounds are shared between the two
 * transports instead of duplicated.
 *
 * Outbound: the transport writes NUL-terminated JSON frames into `writable`;
 * the bridge strips the delimiter and forwards one WebSocket text message per
 * frame. Inbound: each WebSocket message is re-framed with a NUL delimiter and
 * pushed into `readable`, which CdpPipeTransport parses exactly like pipe
 * bytes. A closed or errored WebSocket destroys the readable, which rejects
 * every pending request exactly like a closed pipe.
 */
export function createWebSocketPipeBridge(ws: CdpWebSocket): {
  writable: Writable
  readable: Readable
  /** Closes the underlying WebSocket; callers invoke it on teardown. */
  dispose: () => void
} {
  const writable = new PassThrough()
  const readable = new PassThrough()
  let closed = false
  let pendingOut = Buffer.alloc(0)

  writable.on('data', (chunk: Buffer | string) => {
    if (closed) return
    const part = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
    pendingOut = Buffer.concat([pendingOut, part])
    if (pendingOut.length > MAX_PENDING_OUTBOUND_BYTES) {
      closed = true
      readable.destroy(
        new Error(
          'CDP outbound frame exceeded the WebSocket bridge buffer cap',
        ),
      )
      return
    }
    let delimiter = pendingOut.indexOf(0x00)
    while (delimiter !== -1) {
      const frame = pendingOut.subarray(0, delimiter)
      pendingOut = pendingOut.subarray(delimiter + 1)
      if (!closed && frame.length > 0) {
        try {
          ws.send(frame.toString('utf8'))
        } catch (error) {
          closed = true
          readable.destroy(
            new Error(
              `Failed to send a CDP command over the WebSocket transport: ${
                error instanceof Error ? error.message : String(error)
              }`,
            ),
          )
          return
        }
      }
      delimiter = pendingOut.indexOf(0x00)
    }
  })

  ws.on('message', (payload) => {
    if (closed || readable.destroyed) return
    const text =
      typeof payload === 'string'
        ? payload
        : Buffer.isBuffer(payload)
          ? payload.toString('utf8')
          : String(payload)
    readable.push(text + '\0')
  })
  ws.on('close', () => {
    if (closed) return
    closed = true
    // Destroying the readable makes CdpPipeTransport reject every pending
    // request, exactly like a closed pipe.
    readable.destroy()
  })
  ws.on('error', (payload) => {
    if (closed) return
    closed = true
    readable.destroy(
      payload instanceof Error
        ? payload
        : new Error('CDP WebSocket transport error'),
    )
  })

  return {
    writable,
    readable,
    dispose: () => {
      closed = true
      try {
        ws.close()
      } catch {
        // ignore
      }
    },
  }
}
