import { afterEach, describe, expect, test } from 'bun:test'
import { type ChildProcess } from 'node:child_process'
import type { Log } from '@codebuff/common/browser-actions'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { PassThrough, Writable } from 'node:stream'

import {
  MAX_PENDING_ROUTED_EVENTS,
  __registerBrowserSessionForTest,
  __resetPipeSupportProbeCacheForTest,
  connectPage,
  detectPipeSupport,
  discardPendingEvents,
  extractDevtoolsWebSocketUrl,
  flushPendingEvents,
  readDevtoolsWebSocketUrl,
  rollbackBrowserSpawn,
  rollbackStaleBrowserSession,
  redactDevtoolsUrl,
  routeEvent,
  stopBrowserSession,
  stopBrowserSessionsByOwner,
  type BrowserSessionOwner,
  type RoutableSession,
} from '../tools/browser-logs'
import {
  CdpPipeTransport,
  createWebSocketPipeBridge,
  type CdpPipeMessage,
  type CdpWebSocket,
} from '../tools/cdp-pipe-transport'

// SB-7: these tests exercise the NUL-framed CDP pipe transport WITHOUT a real
// Chrome. In-memory PassThrough streams stand in for fd 3 (writable, parent ->
// Chrome) and fd 4 (readable, Chrome -> parent). We assert the security- and
// correctness-relevant behaviors: exact framing, request/response correlation,
// session-scoped event routing, malformed-frame tolerance, an un-terminated
// frame buffer cap that fails closed, and pending-request rejection on close.

function makePair() {
  // `writable` is what the transport writes commands into (fd 3). We read the
  // framed bytes back off the same PassThrough to assert on-wire framing.
  const writable = new PassThrough()
  // `readable` is what the transport reads Chrome's messages from (fd 4). We
  // push framed bytes into it to simulate Chrome.
  const readable = new PassThrough()
  return { writable, readable }
}

function frame(message: CdpPipeMessage): Buffer {
  return Buffer.from(JSON.stringify(message) + '\0')
}

describe('CdpPipeTransport framing (outbound)', () => {
  test('send writes a NUL-terminated JSON frame with a monotonic id', async () => {
    const { writable, readable } = makePair()
    const written: Buffer[] = []
    writable.on('data', (chunk) => written.push(Buffer.from(chunk)))
    const transport = new CdpPipeTransport({ writable, readable })

    // Catch the pending promises: these framing tests never deliver a
    // response, so transport.close() at the end would otherwise reject them
    // as unhandled rejections (bun:test fails the test on those).
    transport.send('Page.enable', {}).catch(() => undefined)
    transport.send('Runtime.enable', {}).catch(() => undefined)
    // Flush the microtask/IO queue so PassThrough delivers the writes.
    await new Promise((resolve) => setImmediate(resolve))

    const joined = Buffer.concat(written).toString('utf8')
    const frames = joined.split('\0').filter((part) => part.length > 0)
    expect(frames).toHaveLength(2)
    expect(JSON.parse(frames[0])).toEqual({
      id: 1,
      method: 'Page.enable',
      params: {},
    })
    expect(JSON.parse(frames[1])).toEqual({
      id: 2,
      method: 'Runtime.enable',
      params: {},
    })
    transport.close()
  })

  test('send includes a top-level sessionId only when provided', async () => {
    const { writable, readable } = makePair()
    const written: Buffer[] = []
    writable.on('data', (chunk) => written.push(Buffer.from(chunk)))
    const transport = new CdpPipeTransport({ writable, readable })

    transport
      .send('Page.navigate', { url: 'about:blank' }, { sessionId: 'SID-1' })
      .catch(() => undefined)
    await new Promise((resolve) => setImmediate(resolve))

    const first = Buffer.concat(written).toString('utf8').split('\0')[0]
    expect(JSON.parse(first)).toEqual({
      id: 1,
      method: 'Page.navigate',
      params: { url: 'about:blank' },
      sessionId: 'SID-1',
    })
    transport.close()
  })
})

describe('CdpPipeTransport write backpressure', () => {
  // A Writable whose consumer is manually throttled: while throttled, _write
  // callbacks are held so writableLength climbs past the high-water mark,
  // exactly like a stalled Chrome reader on fd 3. release() drains the held
  // callbacks, which makes the stream drop below its high-water mark and
  // emit 'drain'.
  function makeThrottledWritable(highWaterMark: number) {
    const written: Buffer[] = []
    const held: Array<(error?: Error | null) => void> = []
    let throttled = true
    const writable = new Writable({
      highWaterMark,
      write(chunk: Buffer, _encoding, callback) {
        written.push(Buffer.from(chunk))
        if (throttled) held.push(callback)
        else callback()
      },
    })
    const release = () => {
      throttled = false
      for (const callback of held.splice(0)) callback()
    }
    return { writable, written, release }
  }

  const flush = async () => {
    await new Promise((resolve) => setImmediate(resolve))
    await new Promise((resolve) => setImmediate(resolve))
  }

  test('defers a send behind write backpressure and writes it once the pipe drains', async () => {
    const { writable, written, release } = makeThrottledWritable(16)
    const readable = new PassThrough()
    const transport = new CdpPipeTransport({ writable, readable })
    const frames = () =>
      Buffer.concat(written)
        .toString('utf8')
        .split('\0')
        .filter((part) => part.length > 0)

    // First send: the outbound buffer is empty, so the frame goes out
    // immediately and its _write callback is held, leaving writableLength
    // above the 16-byte high-water mark.
    const first = transport.send('Page.enable', {}).catch(() => undefined)
    // Second send: deferred — a stalled reader must not grow the outbound
    // buffer without bound.
    const second = transport.send('Runtime.enable', {}).catch(() => undefined)
    await flush()

    expect(frames()).toHaveLength(1)
    expect(JSON.parse(frames()[0])).toEqual({
      id: 1,
      method: 'Page.enable',
      params: {},
    })

    // The reader catches up: the held _write callbacks complete, the stream
    // drops below its high-water mark and emits 'drain', and the deferred
    // frame is written.
    release()
    await flush()

    expect(frames()).toHaveLength(2)
    expect(JSON.parse(frames()[1])).toEqual({
      id: 2,
      method: 'Runtime.enable',
      params: {},
    })

    transport.close()
    await Promise.all([first, second])
  })

  test('a send deferred behind backpressure never writes after the transport closes', async () => {
    const { writable, written, release } = makeThrottledWritable(16)
    const readable = new PassThrough()
    const transport = new CdpPipeTransport({ writable, readable })

    transport.send('A', {}).catch(() => undefined)
    const deferred = transport.send('B', {})
    await flush()
    expect(written).toHaveLength(1)

    // Closing must release the deferred write without placing it on the wire
    // and reject the waiting request like any other pending request.
    transport.close()
    await expect(deferred).rejects.toThrow('CDP pipe transport closed')

    // Even after the pipe drains, the abandoned frame must never reach it.
    release()
    await flush()
    expect(written).toHaveLength(1)
  })

  test('a frame stuck behind backpressure is dropped at the request timeout', async () => {
    const { writable, written, release } = makeThrottledWritable(16)
    const readable = new PassThrough()
    const transport = new CdpPipeTransport({ writable, readable })

    transport.send('A', {}).catch(() => undefined)
    const deferred = transport.send('B', {}, { timeoutMs: 20 })
    await flush()
    expect(written).toHaveLength(1)

    await expect(deferred).rejects.toThrow(/timed out after 20ms/)

    // The deferred frame was never placed on the wire, before or after the
    // pipe eventually drains.
    release()
    await flush()
    expect(written).toHaveLength(1)
    transport.close()
  })
})

describe('CdpPipeTransport routing (inbound)', () => {
  test('resolves a pending request by matching id', async () => {
    const { writable, readable } = makePair()
    const transport = new CdpPipeTransport({ writable, readable })

    const promise = transport.send('Target.getTargets', {})
    readable.write(frame({ id: 1, result: { targetInfos: [] } }))
    await expect(promise).resolves.toEqual({ targetInfos: [] })
    transport.close()
  })

  test('rejects a pending request carrying a CDP error', async () => {
    const { writable, readable } = makePair()
    const transport = new CdpPipeTransport({ writable, readable })

    const promise = transport.send('Page.navigate', {})
    readable.write(frame({ id: 1, error: { message: 'Cannot navigate' } }))
    await expect(promise).rejects.toThrow('Cannot navigate')
    transport.close()
  })

  test('routes method messages to onEvent, preserving sessionId', async () => {
    const { writable, readable } = makePair()
    const events: CdpPipeMessage[] = []
    const transport = new CdpPipeTransport({
      writable,
      readable,
      onEvent: (message) => events.push(message),
    })

    readable.write(
      frame({
        method: 'Runtime.consoleAPICalled',
        params: { type: 'log' },
        sessionId: 'SID-9',
      }),
    )
    await new Promise((resolve) => setImmediate(resolve))
    expect(events).toHaveLength(1)
    expect(events[0].method).toBe('Runtime.consoleAPICalled')
    expect(events[0].sessionId).toBe('SID-9')
    transport.close()
  })

  test('reassembles a frame split across multiple data chunks', async () => {
    const { writable, readable } = makePair()
    const transport = new CdpPipeTransport({ writable, readable })

    const promise = transport.send('Target.getTargets', {})
    const full = frame({ id: 1, result: { ok: true } })
    readable.write(full.subarray(0, 5))
    readable.write(full.subarray(5))
    await expect(promise).resolves.toEqual({ ok: true })
    transport.close()
  })

  test('completes a partial frame and parses the next frame from the same chunk', async () => {
    const { writable, readable } = makePair()
    const transport = new CdpPipeTransport({ writable, readable })

    const promiseA = transport.send('A', {})
    const promiseB = transport.send('B', {})
    const frameA = frame({ id: 1, result: 'a' })
    const frameB = frame({ id: 2, result: 'b' })
    // First chunk: only the head of frame A, with no delimiter in it.
    readable.write(frameA.subarray(0, 8))
    // Second chunk: the tail that completes frame A, immediately followed by
    // all of frame B — the scan must resume mid-chunk and still find both.
    readable.write(Buffer.concat([frameA.subarray(8), frameB]))
    await expect(promiseA).resolves.toBe('a')
    await expect(promiseB).resolves.toBe('b')
    transport.close()
  })

  test(
    'assembles a very large multi-chunk frame within a bounded ' +
      'wall-clock budget (each chunk scanned only once)',
    async () => {
      const { writable, readable } = makePair()
      const transport = new CdpPipeTransport({ writable, readable })

      // ~32 MiB frame delivered in 1 KiB chunks, mirroring the multi-MB
      // screenshot/screencast frames this transport is sized for. The
      // incremental scan cursor scans each inbound chunk's own bytes only, so
      // total scanning work stays proportional to the frame size; this test
      // pins that with a measured wall-clock budget instead of asserting an
      // unmeasured asymptotic bound.
      const payloadSize = 32 * 1024 * 1024
      const chunkSize = 1024
      const promise = transport.send('Page.captureScreenshot', {})
      const full = frame({ id: 1, result: { data: 'x'.repeat(payloadSize) } })

      const startedAt = Date.now()
      for (let offset = 0; offset < full.length; offset += chunkSize) {
        readable.write(full.subarray(offset, offset + chunkSize))
      }
      const result = (await promise) as { data: string }
      const elapsedMs = Date.now() - startedAt

      expect(result.data.length).toBe(payloadSize)
      expect(elapsedMs).toBeLessThan(5000)
      transport.close()
    },
  )

  test('parses multiple frames delivered in a single chunk', async () => {
    const { writable, readable } = makePair()
    const events: CdpPipeMessage[] = []
    const transport = new CdpPipeTransport({
      writable,
      readable,
      onEvent: (message) => events.push(message),
    })

    const p1 = transport.send('A', {})
    const p2 = transport.send('B', {})
    readable.write(
      Buffer.concat([
        frame({ id: 1, result: 'a' }),
        frame({ method: 'Evt' }),
        frame({ id: 2, result: 'b' }),
      ]),
    )
    await expect(p1).resolves.toBe('a')
    await expect(p2).resolves.toBe('b')
    expect(events.map((event) => event.method)).toEqual(['Evt'])
    transport.close()
  })

  test('ignores a response for an unknown id and a malformed frame', async () => {
    const { writable, readable } = makePair()
    let eventCount = 0
    const transport = new CdpPipeTransport({
      writable,
      readable,
      onEvent: () => eventCount++,
    })

    const promise = transport.send('A', {})
    // Unknown id, then garbage, then the real response.
    readable.write(frame({ id: 999, result: 'ignored' }))
    readable.write(Buffer.from('not json\0'))
    readable.write(frame({ id: 1, result: 'ok' }))
    await expect(promise).resolves.toBe('ok')
    expect(eventCount).toBe(0)
    transport.close()
  })
})

describe('CdpPipeTransport lifecycle and bounds', () => {
  test('rejects all pending requests when the pipe closes', async () => {
    const { writable, readable } = makePair()
    const transport = new CdpPipeTransport({ writable, readable })

    const promise = transport.send('A', {})
    expect(transport.pendingCount).toBe(1)
    readable.emit('end')
    await expect(promise).rejects.toThrow(/closed/)
    expect(transport.pendingCount).toBe(0)
    expect(transport.isClosed).toBe(true)
  })

  test('send after close rejects immediately', async () => {
    const { writable, readable } = makePair()
    const transport = new CdpPipeTransport({ writable, readable })
    transport.close()
    await expect(transport.send('A', {})).rejects.toThrow('closed')
  })

  test('fails closed when an un-terminated frame exceeds the buffer cap', async () => {
    const { writable, readable } = makePair()
    let closeError: Error | undefined
    const transport = new CdpPipeTransport({
      writable,
      readable,
      maxBufferBytes: 64,
      onClose: (error) => {
        closeError = error
      },
    })

    const promise = transport.send('A', {})
    // 128 bytes with no NUL delimiter: exceeds the 64-byte cap.
    readable.write(Buffer.alloc(128, 0x41))
    await expect(promise).rejects.toThrow(/without a delimiter/)
    expect(transport.isClosed).toBe(true)
    expect(closeError?.message).toMatch(/without a delimiter/)
  })

  test('a timed-out request is dropped from the pending set', async () => {
    const { writable, readable } = makePair()
    const transport = new CdpPipeTransport({ writable, readable })

    const promise = transport.send('Slow', {}, { timeoutMs: 5 })
    await expect(promise).rejects.toThrow(/timed out after 5ms/)
    expect(transport.pendingCount).toBe(0)
    transport.close()
  })
})

// These suites exercise the multiplexed event router and the spawn rollback
// helper from browser-logs.ts WITHOUT a real Chrome child: routeEvent and
// rollbackBrowserSpawn are deliberately narrowed/exported so the event-routing
// window (between Target.attachToTarget resolving and connectPage registering
// the page) and the post-spawn failure rollback are unit-testable.

describe('multiplexed event routing (browser-logs routeEvent)', () => {
  function makeRoutingFixture() {
    const { writable, readable } = makePair()
    const transport = new CdpPipeTransport({ writable, readable })
    const makePage = (targetId: string, sessionId: string) => ({
      targetId,
      sessionId,
      transport,
      eventWaiters: new Map<string, Array<() => void>>(),
      executionContexts: new Map<string, number>(),
    })
    const pageA = makePage('target-a', 'SID-A')
    const session: RoutableSession = {
      pages: new Map([[pageA.targetId, pageA]]),
      pagesBySessionId: new Map([[pageA.sessionId, pageA]]),
      activeTargetId: pageA.targetId,
      logs: [],
      networks: [],
      networkRequests: new Map(),
      logOffset: 0,
      networkOffset: 0,
      recording: null,
      pendingEvents: new Map(),
      pendingEventCount: 0,
    }
    return { transport, session, pageA, makePage }
  }

  const consoleEvent = (sessionId: string | undefined, text: string) => ({
    method: 'Runtime.consoleAPICalled',
    params: { type: 'log', args: [text] },
    ...(sessionId ? { sessionId } : {}),
  })

  test('buffers events for an unregistered sessionId instead of misrouting them to the active page', () => {
    const { transport, session, pageA } = makeRoutingFixture()

    let deliveredToActivePage = false
    pageA.eventWaiters.set('Runtime.consoleAPICalled', [
      () => {
        deliveredToActivePage = true
      },
    ])

    // SID-B has no registered page yet: this is exactly the window between
    // Target.attachToTarget resolving and connectPage registering the page.
    routeEvent(session, consoleEvent('SID-B', 'hello'))

    // The event must NOT fall through to the previously active page...
    expect(deliveredToActivePage).toBe(false)
    expect(session.logs).toHaveLength(0)
    // ...and must be buffered for its own sessionId.
    expect(session.pendingEvents.get('SID-B')).toHaveLength(1)
    transport.close()
  })

  test('flushPendingEvents delivers buffered events in order once the page registers', () => {
    const { transport, session, makePage } = makeRoutingFixture()

    routeEvent(session, consoleEvent('SID-B', 'first'))
    routeEvent(session, consoleEvent('SID-B', 'second'))

    const pageB = makePage('target-b', 'SID-B')
    session.pages.set(pageB.targetId, pageB)
    session.pagesBySessionId.set(pageB.sessionId, pageB)
    flushPendingEvents(session, pageB)

    // Both buffered events were delivered, in arrival order, to their own
    // page instead of being dropped or misrouted to the active page.
    expect(session.logs.map((log) => log.message)).toEqual(['first', 'second'])
    expect(session.pendingEvents.size).toBe(0)
    // The running total stays in sync with the drained buffers.
    expect(session.pendingEventCount).toBe(0)
    transport.close()
  })

  test('browser-level events without a sessionId still fall back to the active page', () => {
    const { transport, session, pageA } = makeRoutingFixture()

    let delivered = false
    pageA.eventWaiters.set('Target.targetCreated', [
      () => {
        delivered = true
      },
    ])

    routeEvent(session, { method: 'Target.targetCreated', params: {} })

    expect(delivered).toBe(true)
    expect(session.pendingEvents.size).toBe(0)
    transport.close()
  })

  test('delivers a session-scoped event to the page registered under its sessionId', () => {
    const { transport, session, pageA } = makeRoutingFixture()

    let delivered = false
    pageA.eventWaiters.set('Runtime.consoleAPICalled', [
      () => {
        delivered = true
      },
    ])

    // SID-A is registered in pagesBySessionId: the O(1) lookup must deliver
    // the event to its own page instead of queueing or misrouting it.
    routeEvent(session, consoleEvent('SID-A', 'routed'))

    expect(delivered).toBe(true)
    expect(session.pendingEvents.size).toBe(0)
    transport.close()
  })

  test('pending buffers stay bounded at MAX_PENDING_ROUTED_EVENTS', () => {
    const { transport, session, makePage } = makeRoutingFixture()

    const extra = 10
    for (let i = 0; i < MAX_PENDING_ROUTED_EVENTS + extra; i++) {
      routeEvent(session, consoleEvent('SID-B', `e${i}`))
    }

    let buffered = 0
    for (const entries of session.pendingEvents.values()) {
      buffered += entries.length
    }
    expect(buffered).toBe(MAX_PENDING_ROUTED_EVENTS)
    // The O(1) running count stays in sync with the buffered totals, including
    // after oldest-first drops.
    expect(session.pendingEventCount).toBe(MAX_PENDING_ROUTED_EVENTS)

    // The oldest events were dropped; flush delivers exactly the cap.
    const pageB = makePage('target-b', 'SID-B')
    session.pages.set(pageB.targetId, pageB)
    session.pagesBySessionId.set(pageB.sessionId, pageB)
    flushPendingEvents(session, pageB)
    expect(session.logs).toHaveLength(MAX_PENDING_ROUTED_EVENTS)
    transport.close()
  })
})

describe('rollbackBrowserSpawn (post-spawn failure rollback)', () => {
  function makeAttempt() {
    const killCalls: string[] = []
    const child: Pick<ChildProcess, 'kill'> = {
      kill: () => {
        killCalls.push('kill')
        return true
      },
    }
    let closeCalls = 0
    const transport = {
      close: () => {
        closeCalls++
      },
    }
    const userDataDir = mkdtempSync(path.join(tmpdir(), 'cdp-rollback-'))
    return {
      child,
      transport,
      userDataDir,
      killCalls,
      closedCount: () => closeCalls,
    }
  }

  test('closes the transport, kills the child, and removes the temp user-data dir', () => {
    const attempt = makeAttempt()
    expect(existsSync(attempt.userDataDir)).toBe(true)

    rollbackBrowserSpawn({
      child: attempt.child,
      transport: attempt.transport,
      userDataDir: attempt.userDataDir,
    })

    expect(attempt.closedCount()).toBe(1)
    expect(attempt.killCalls).toEqual(['kill'])
    expect(existsSync(attempt.userDataDir)).toBe(false)
  })

  test('keeps rolling back when the transport close throws', () => {
    const attempt = makeAttempt()
    const throwingTransport = {
      close: () => {
        throw new Error('transport already destroyed')
      },
    }

    rollbackBrowserSpawn({
      child: attempt.child,
      transport: throwingTransport,
      userDataDir: attempt.userDataDir,
    })

    // The guarded cleanup still reaches the child kill and the temp dir.
    expect(attempt.killCalls).toEqual(['kill'])
    expect(existsSync(attempt.userDataDir)).toBe(false)
  })

  test('rolls back without a transport when spawn failed before transport creation', () => {
    const attempt = makeAttempt()

    rollbackBrowserSpawn({
      child: attempt.child,
      userDataDir: attempt.userDataDir,
    })

    expect(attempt.killCalls).toEqual(['kill'])
    expect(existsSync(attempt.userDataDir)).toBe(false)
  })
})

describe('rollbackStaleBrowserSession (dead-session resource rollback)', () => {
  function makeStaleSession(sessionKey: string) {
    const { writable, readable } = makePair()
    const transport = new CdpPipeTransport({ writable, readable })
    const disposeCalls: number[] = []
    const killCalls: number[] = []
    const userDataDir = mkdtempSync(path.join(tmpdir(), 'cdp-stale-'))
    const session = {
      child: {
        kill: () => {
          killCalls.push(1)
          return true
        },
      } as unknown as ChildProcess,
      transport,
      userDataDir,
      disposeTransport: () => {
        disposeCalls.push(1)
      },
    }
    __registerBrowserSessionForTest(sessionKey, session)
    return { session, transport, userDataDir, disposeCalls, killCalls }
  }

  test('deregisters the session and rolls back transport, ws disposal, child, and temp dir', () => {
    const stale = makeStaleSession('stale-full')

    rollbackStaleBrowserSession('stale-full', stale.session)

    // Everything the dead session held is reclaimed deterministically —
    // including the WebSocket fallback's disposeTransport and the temp
    // user-data dir — and the registry entry is gone, so ensureBrowserSession
    // respawns instead of returning the dead session.
    expect(stale.disposeCalls).toHaveLength(1)
    expect(stale.killCalls).toHaveLength(1)
    expect(stale.transport.isClosed).toBe(true)
    expect(existsSync(stale.userDataDir)).toBe(false)
  })

  test('a respawned session registered under the same key survives the stale rollback', async () => {
    const stale = makeStaleSession('stale-race')
    // Overwrites the registry entry, like a respawn that raced the rollback.
    const respawned = makeStaleSession('stale-race')
    try {
      rollbackStaleBrowserSession('stale-race', stale.session)

      // The stale session's resources were reclaimed...
      expect(stale.killCalls).toHaveLength(1)
      expect(stale.transport.isClosed).toBe(true)
      expect(existsSync(stale.userDataDir)).toBe(false)
      // ...while the newer session stays registered and untouched.
      expect(respawned.killCalls).toHaveLength(0)
      expect(respawned.transport.isClosed).toBe(false)
      expect(existsSync(respawned.userDataDir)).toBe(true)

      // The registry still holds the respawned session: teardown reaches it.
      await stopBrowserSession('stale-race')
      expect(respawned.killCalls).toHaveLength(1)
      expect(existsSync(respawned.userDataDir)).toBe(false)
    } finally {
      stale.transport.close()
      respawned.transport.close()
    }
  })
})

// --- SB-7 compatibility + orphaned-session lifecycle additions ---

const flushAsync = async () => {
  await new Promise((resolve) => setImmediate(resolve))
}

const consoleEvent = (sessionId: string, text: string) => ({
  method: 'Runtime.consoleAPICalled',
  params: { type: 'log', args: [text] },
  sessionId,
})

/**
 * A CdpPipeTransport wired to a scripted CDP peer: every outbound frame is
 * parsed, recorded, and answered by `respond` (undefined means no response).
 * This stands in for Chrome so connectPage and the pipe probe can be driven
 * without a real browser.
 */
function makeScriptedCdp(
  respond: (
    method: string,
    params: Record<string, unknown>,
  ) => { result?: unknown; error?: string } | undefined,
) {
  const { writable, readable } = makePair()
  const sawFrames: Array<{
    method: string
    params: Record<string, unknown>
  }> = []
  let buffered = Buffer.alloc(0)
  writable.on('data', (chunk: Buffer) => {
    buffered = Buffer.concat([buffered, chunk])
    let delimiter = buffered.indexOf(0)
    while (delimiter !== -1) {
      const frameText = buffered.subarray(0, delimiter).toString('utf8')
      buffered = buffered.subarray(delimiter + 1)
      delimiter = buffered.indexOf(0)
      if (frameText.length === 0) continue
      const message = JSON.parse(frameText) as {
        id: number
        method: string
        params: Record<string, unknown>
      }
      sawFrames.push({ method: message.method, params: message.params })
      const scripted = respond(message.method, message.params)
      if (!scripted) continue
      const response: CdpPipeMessage = scripted.error
        ? { id: message.id, error: { message: scripted.error } }
        : { id: message.id, result: scripted.result ?? {} }
      readable.write(frame(response))
    }
  })
  const transport = new CdpPipeTransport({ writable, readable })
  return { transport, sawFrames }
}

describe('createWebSocketPipeBridge (port fallback transport)', () => {
  type FakeWebSocket = CdpWebSocket & {
    sent: string[]
    deliverMessage: (text: string) => void
    emitClose: () => void
    emitError: (error: Error) => void
  }

  function makeFakeWebSocket(): FakeWebSocket {
    const sent: string[] = []
    const listeners: Record<
      'open' | 'message' | 'close' | 'error',
      Array<(payload: unknown) => void>
    > = { open: [], message: [], close: [], error: [] }
    const ws: FakeWebSocket = {
      sent,
      send: (data) => {
        sent.push(data)
      },
      close: () => {
        // The bridge tears itself down on the 'close' event, not on close().
      },
      on: (event, listener) => {
        listeners[event].push(listener)
      },
      deliverMessage: (text) => {
        for (const listener of listeners.message) listener(text)
      },
      emitClose: () => {
        for (const listener of listeners.close) listener(undefined)
      },
      emitError: (error) => {
        for (const listener of listeners.error) listener(error)
      },
    }
    return ws
  }

  test('bridges CdpPipeTransport frames over a WebSocket peer', async () => {
    const ws = makeFakeWebSocket()
    const { writable, readable } = createWebSocketPipeBridge(ws)
    const transport = new CdpPipeTransport({ writable, readable })

    const promise = transport.send('Target.getTargets', {})
    await flushAsync()
    // The outbound frame lost its NUL delimiter: one WebSocket text message
    // per CDP frame.
    expect(ws.sent).toEqual([
      JSON.stringify({ id: 1, method: 'Target.getTargets', params: {} }),
    ])

    // Inbound WebSocket messages are re-framed with NUL and parsed by the
    // shared transport, so correlation and routing behave like the pipe.
    ws.deliverMessage(JSON.stringify({ id: 1, result: { targetInfos: [] } }))
    await expect(promise).resolves.toEqual({ targetInfos: [] })
    transport.close()
  })

  test('a closed WebSocket rejects pending requests like a closed pipe', async () => {
    const ws = makeFakeWebSocket()
    const { writable, readable } = createWebSocketPipeBridge(ws)
    const transport = new CdpPipeTransport({ writable, readable })

    const promise = transport.send('A', {})
    await flushAsync()
    ws.emitClose()
    await expect(promise).rejects.toThrow(/closed/)
    expect(transport.isClosed).toBe(true)
  })

  test('a WebSocket error is surfaced as the pending rejection', async () => {
    const ws = makeFakeWebSocket()
    const { writable, readable } = createWebSocketPipeBridge(ws)
    const transport = new CdpPipeTransport({ writable, readable })

    const promise = transport.send('A', {})
    await flushAsync()
    ws.emitError(new Error('socket hang up'))
    await expect(promise).rejects.toThrow('socket hang up')
    expect(transport.isClosed).toBe(true)
  })

  test('fails closed when an outbound frame exceeds the bridge buffer cap', async () => {
    const ws = makeFakeWebSocket()
    const { writable, readable } = createWebSocketPipeBridge(ws)
    const transport = new CdpPipeTransport({ writable, readable })

    // > 1 MiB with no delimiter: the bridge must not accumulate outbound
    // bytes without bound when the peer-facing framing breaks.
    const promise = transport.send('Big', {
      blob: 'x'.repeat(2 * 1024 * 1024),
    })
    await expect(promise).rejects.toThrow(/buffer cap/)
    expect(transport.isClosed).toBe(true)
    expect(ws.sent).toHaveLength(0)
  })

  test('reassembles a frame written across multiple chunks before forwarding', async () => {
    const ws = makeFakeWebSocket()
    const { writable } = createWebSocketPipeBridge(ws)
    const payload = JSON.stringify({ id: 1, method: 'A', params: {} })

    writable.write(payload.slice(0, 5))
    await flushAsync()
    expect(ws.sent).toHaveLength(0)

    writable.write(payload.slice(5) + '\0')
    await flushAsync()
    expect(ws.sent).toEqual([payload])
  })

  test('stops forwarding after the WebSocket closed', async () => {
    const ws = makeFakeWebSocket()
    const { writable, readable } = createWebSocketPipeBridge(ws)
    const transport = new CdpPipeTransport({ writable, readable })

    transport.send('A', {}).catch(() => undefined)
    await flushAsync()
    expect(ws.sent).toHaveLength(1)

    ws.emitClose()
    await flushAsync()
    // Late bytes pushed into the bridge after close are never forwarded.
    writable.write('{"late":true}\0')
    await flushAsync()
    expect(ws.sent).toHaveLength(1)
    transport.close()
  })
})

describe('connectPage orphaned flatten-session cleanup', () => {
  function makeConnectSession(transport: CdpPipeTransport) {
    const makePage = (targetId: string, sessionId: string) => ({
      targetId,
      sessionId,
      transport,
      eventWaiters: new Map<string, Array<() => void>>(),
      executionContexts: new Map<string, number>(),
    })
    const session = {
      pages: new Map(),
      pagesBySessionId: new Map(),
      activeTargetId: 'target-a',
      // Full Log shape so routeEvent's pushes type-check without casting.
      logs: [] as Log[],
      networks: [],
      networkRequests: new Map(),
      logOffset: 0,
      networkOffset: 0,
      recording: null,
      pendingEvents: new Map(),
      pendingEventCount: 0,
      transport,
    }
    return { session, makePage }
  }

  test(
    'detaches the flatten session and drops its buffered events when ' +
      'enablePageDomains fails',
    async () => {
      const { transport, sawFrames } = makeScriptedCdp((method) =>
        method === 'Target.attachToTarget'
          ? { result: { sessionId: 'SID-B' } }
          : { error: 'domain enable refused' },
      )
      const { session } = makeConnectSession(transport)
      // An event for the attaching session arrived before registration.
      routeEvent(session, consoleEvent('SID-B', 'early'))
      expect(session.pendingEvents.get('SID-B')).toHaveLength(1)

      await expect(connectPage(session, 'target-b')).rejects.toThrow(
        'domain enable refused',
      )
      await flushAsync()

      // The orphaned flatten session is detached so Chrome stops routing its
      // events to a sessionId no page will ever register again.
      expect(
        sawFrames.some(
          (frame) =>
            frame.method === 'Target.detachFromTarget' &&
            frame.params.sessionId === 'SID-B',
        ),
      ).toBe(true)
      // No residual buffer for the orphaned sessionId; the running count
      // stays in sync.
      expect(session.pendingEvents.has('SID-B')).toBe(false)
      expect(session.pendingEventCount).toBe(0)
      // The failed page is deregistered so the next attempt reconnects.
      expect(session.pages.has('target-b')).toBe(false)
      expect(session.pagesBySessionId.has('SID-B')).toBe(false)
      transport.close()
    },
  )

  test('registers the page and drains buffered events on a successful reconnect', async () => {
    const { transport } = makeScriptedCdp((method) =>
      method === 'Target.attachToTarget'
        ? { result: { sessionId: 'SID-B' } }
        : { result: {} },
    )
    const { session } = makeConnectSession(transport)
    routeEvent(session, consoleEvent('SID-B', 'buffered-during-attach'))

    const page = await connectPage(session, 'target-b')

    expect(page.sessionId).toBe('SID-B')
    expect(session.pages.get('target-b')).toBe(page)
    expect(session.pagesBySessionId.get('SID-B')).toBe(page)
    expect(session.logs.map((log) => log.message)).toEqual([
      'buffered-during-attach',
    ])
    expect(session.pendingEventCount).toBe(0)
    transport.close()
  })

  test('discardPendingEvents drops buffered events and keeps the running count in sync', () => {
    const { writable, readable } = makePair()
    const transport = new CdpPipeTransport({ writable, readable })
    const { session } = makeConnectSession(transport)

    routeEvent(session, consoleEvent('SID-B', 'a'))
    routeEvent(session, consoleEvent('SID-C', 'b'))
    expect(session.pendingEventCount).toBe(2)

    discardPendingEvents(session, 'SID-B')

    expect(session.pendingEvents.has('SID-B')).toBe(false)
    expect(session.pendingEvents.get('SID-C')).toHaveLength(1)
    expect(session.pendingEventCount).toBe(1)
    transport.close()
  })
})

describe('detectPipeSupport (pipe compatibility probe)', () => {
  afterEach(() => {
    __resetPipeSupportProbeCacheForTest()
  })

  function makeProbeAttempt(
    transport: Pick<CdpPipeTransport, 'send' | 'close'>,
  ) {
    let killed = false
    const userDataDir = mkdtempSync(path.join(tmpdir(), 'cdp-probe-'))
    return {
      attempt: {
        child: {
          kill: () => {
            killed = true
            return true
          },
        },
        transport,
        userDataDir,
      },
      wasKilled: () => killed,
      userDataDir,
    }
  }

  test('returns true when the browser answers the full probe: getTargets plus flatten attach', async () => {
    const { transport, sawFrames } = makeScriptedCdp((method) =>
      method === 'Target.getTargets'
        ? {
            result: {
              targetInfos: [{ targetId: 'probe-target', type: 'page' }],
            },
          }
        : method === 'Target.attachToTarget'
          ? { result: { sessionId: 'SID-PROBE' } }
          : undefined,
    )
    const probe = makeProbeAttempt(transport)

    await expect(
      detectPipeSupport({
        executablePath: () => '/usr/bin/fake-chrome',
        spawn: () => probe.attempt,
        probeTimeoutMs: 200,
        cacheTtlMs: 60_000,
        now: () => 1_000,
      }),
    ).resolves.toBe(true)

    // The probe exercised the exact flatten-mode attach the session path
    // relies on (connectPage's Target.attachToTarget {flatten:true}), with a
    // targetId read from the getTargets result the way listTargets reads it.
    expect(
      sawFrames.some(
        (sent) =>
          sent.method === 'Target.attachToTarget' &&
          sent.params.targetId === 'probe-target' &&
          sent.params.flatten === true,
      ),
    ).toBe(true)

    // The probe browser is fully rolled back afterwards.
    expect(probe.wasKilled()).toBe(true)
    expect(existsSync(probe.userDataDir)).toBe(false)
    transport.close()
  })

  test('returns false and rolls back when the probe pipe demonstrably fails', async () => {
    const { writable, readable } = makePair()
    const transport = new CdpPipeTransport({ writable, readable })
    const probe = makeProbeAttempt(transport)
    // The browser exited without answering: the pipe is gone, which is
    // demonstrable evidence the pipe path cannot work (unlike a timeout).
    transport.close()

    await expect(
      detectPipeSupport({
        executablePath: () => '/usr/bin/fake-chrome',
        spawn: () => probe.attempt,
        probeTimeoutMs: 200,
        cacheTtlMs: 60_000,
        now: () => 2_000,
      }),
    ).resolves.toBe(false)

    expect(probe.wasKilled()).toBe(true)
    expect(existsSync(probe.userDataDir)).toBe(false)
  })

  test('returns false when the browser answers getTargets but refuses flatten attach', async () => {
    const { transport, sawFrames } = makeScriptedCdp((method) =>
      method === 'Target.getTargets'
        ? {
            result: {
              targetInfos: [{ targetId: 'probe-target', type: 'page' }],
            },
          }
        : method === 'Target.attachToTarget'
          ? { error: 'attach refused' }
          : undefined,
    )
    const probe = makeProbeAttempt(transport)

    // A build that round-trips Target.getTargets but does not honor
    // flatten-mode attach must fail the probe (so the session falls back to
    // the port transport), not pass the probe and only blow up later at
    // connectPage with "Chrome did not attach to target" and no fallback.
    await expect(
      detectPipeSupport({
        executablePath: () => '/usr/bin/fake-chrome',
        spawn: () => probe.attempt,
        probeTimeoutMs: 200,
        cacheTtlMs: 60_000,
        now: () => 1_000,
      }),
    ).resolves.toBe(false)
    expect(
      sawFrames.some((sent) => sent.method === 'Target.attachToTarget'),
    ).toBe(true)

    expect(probe.wasKilled()).toBe(true)
    expect(existsSync(probe.userDataDir)).toBe(false)
    transport.close()
  })

  test('returns false when flatten attach resolves without a sessionId', async () => {
    const { transport } = makeScriptedCdp((method) =>
      method === 'Target.getTargets'
        ? {
            result: {
              targetInfos: [{ targetId: 'probe-target', type: 'page' }],
            },
          }
        : method === 'Target.attachToTarget'
          ? { result: {} }
          : undefined,
    )
    const probe = makeProbeAttempt(transport)

    // connectPage requires a string sessionId from the attach result; an
    // attach that resolves without one is a demonstrable failure, not a
    // timeout, so the probe resolves false instead of failing closed.
    await expect(
      detectPipeSupport({
        executablePath: () => '/usr/bin/fake-chrome',
        spawn: () => probe.attempt,
        probeTimeoutMs: 200,
        cacheTtlMs: 60_000,
        now: () => 2_000,
      }),
    ).resolves.toBe(false)

    expect(probe.wasKilled()).toBe(true)
    expect(existsSync(probe.userDataDir)).toBe(false)
    transport.close()
  })

  test('returns false when getTargets carries no usable targetInfos entry', async () => {
    const { transport, sawFrames } = makeScriptedCdp((method) =>
      method === 'Target.getTargets' ? { result: {} } : undefined,
    )
    const probe = makeProbeAttempt(transport)

    // Without a usable targetInfos entry the session path could never find a
    // page target (waitForPageTarget), so the pipe path cannot work even
    // though the command itself round-tripped.
    await expect(
      detectPipeSupport({
        executablePath: () => '/usr/bin/fake-chrome',
        spawn: () => probe.attempt,
        probeTimeoutMs: 200,
        cacheTtlMs: 60_000,
        now: () => 3_000,
      }),
    ).resolves.toBe(false)
    // No targetId means the attach probe is never reached.
    expect(
      sawFrames.some((sent) => sent.method === 'Target.attachToTarget'),
    ).toBe(false)

    expect(probe.wasKilled()).toBe(true)
    expect(existsSync(probe.userDataDir)).toBe(false)
    transport.close()
  })

  test('caches a positive verdict per executable within the TTL and re-probes after it expires', async () => {
    let spawns = 0
    const hooks = {
      executablePath: () => '/usr/bin/fake-chrome',
      // detectPipeSupport rolls back (closes) each probe attempt's transport
      // in its finally block, so every spawn must get its OWN scripted peer:
      // sharing one transport would fail the second probe spuriously with
      // 'transport is closed' instead of exercising the verdict cache.
      spawn: () => {
        spawns++
        const { transport: probeTransport } = makeScriptedCdp((method) =>
          method === 'Target.getTargets'
            ? {
                result: {
                  targetInfos: [{ targetId: 'probe-target', type: 'page' }],
                },
              }
            : method === 'Target.attachToTarget'
              ? { result: { sessionId: 'SID-PROBE' } }
              : undefined,
        )
        return makeProbeAttempt(probeTransport).attempt
      },
      probeTimeoutMs: 200,
      cacheTtlMs: 60_000,
      now: () => 5_000,
    }

    await expect(detectPipeSupport(hooks)).resolves.toBe(true)
    await expect(detectPipeSupport(hooks)).resolves.toBe(true)
    expect(spawns).toBe(1)

    await expect(
      detectPipeSupport({ ...hooks, now: () => 5_000 + 60_001 }),
    ).resolves.toBe(true)
    expect(spawns).toBe(2)
  })

  test('fails closed on a probe timeout instead of using the port fallback', async () => {
    let spawns = 0
    const hooks = {
      executablePath: () => '/usr/bin/fake-chrome',
      spawn: () => {
        spawns++
        // A silent peer that never answers: each spawn gets its own transport
        // because detectPipeSupport's rollback closes the previous attempt's.
        const { writable, readable } = makePair()
        return makeProbeAttempt(
          new CdpPipeTransport({ writable, readable }),
        ).attempt
      },
      probeTimeoutMs: 20,
      cacheTtlMs: 60_000,
      now: () => 5_000,
    }

    // A timeout is not evidence the browser lacks pipe support: the probe
    // fails closed (rejects) instead of resolving false and routing the
    // session to the --remote-debugging-port=0 fallback.
    await expect(detectPipeSupport(hooks)).rejects.toThrow(
      /probe timed out after 20ms/,
    )
    // The negative is never cached, so a later session within the TTL still
    // re-probes rather than silently reusing the failed verdict.
    await expect(
      detectPipeSupport({ ...hooks, now: () => 5_000 + 1 }),
    ).rejects.toThrow(/probe timed out/)
    expect(spawns).toBe(2)
  })

  test('returns false when the probe spawn throws synchronously (missing fds)', async () => {
    let spawns = 0
    await expect(
      detectPipeSupport({
        executablePath: () => '/usr/bin/fake-chrome',
        spawn: () => {
          spawns++
          throw new Error(
            'Chrome did not expose the remote debugging pipe file descriptors',
          )
        },
        probeTimeoutMs: 200,
        cacheTtlMs: 60_000,
        now: () => 4_000,
      }),
    ).resolves.toBe(false)
    // A synchronous spawn throw is a demonstrable failure, so the session
    // falls back to the port transport instead of erroring out.
    expect(spawns).toBe(1)
  })

  test('does not reuse a positive verdict for a different resolved executable', async () => {
    const spawnedExecutables: string[] = []
    // Per-spawn transports: detectPipeSupport closes each attempt's transport
    // during rollback, so a shared peer would poison the second probe
    // regardless of the executable-keying behavior under test.
    const hooks = {
      executablePath: () => '/usr/bin/fake-chrome-a',
      spawn: (executablePath: string) => {
        spawnedExecutables.push(executablePath)
        const { transport: probeTransport } = makeScriptedCdp((method) =>
          method === 'Target.getTargets'
            ? {
                result: {
                  targetInfos: [{ targetId: 'probe-target', type: 'page' }],
                },
              }
            : method === 'Target.attachToTarget'
              ? { result: { sessionId: 'SID-PROBE' } }
              : undefined,
        )
        return makeProbeAttempt(probeTransport).attempt
      },
      probeTimeoutMs: 200,
      cacheTtlMs: 60_000,
      now: () => 5_000,
    }

    await expect(detectPipeSupport(hooks)).resolves.toBe(true)
    expect(spawnedExecutables).toEqual(['/usr/bin/fake-chrome-a'])

    // A different Chromium binary resolved within the TTL must not inherit
    // the first binary's positive verdict: it gets its own probe, and the
    // spawned binary is exactly the executable the cache key came from.
    await expect(
      detectPipeSupport({
        ...hooks,
        executablePath: () => '/usr/bin/fake-chrome-b',
      }),
    ).resolves.toBe(true)
    expect(spawnedExecutables).toEqual([
      '/usr/bin/fake-chrome-a',
      '/usr/bin/fake-chrome-b',
    ])
  })
})

describe('DevTools WebSocket URL extraction (port fallback launch)', () => {
  function makeFakeChild(stderr: PassThrough) {
    const registered: Array<{ event: string; listener: () => void }> = []
    const removed: Array<{ event: string; listener: () => void }> = []
    // Structural stand-in for the child: matches the narrowed
    // DevtoolsReportingChild shape readDevtoolsWebSocketUrl accepts.
    const child = {
      stderr,
      on(event: string | symbol, listener: (...args: any[]) => void) {
        registered.push({ event: String(event), listener: () => listener() })
        return child
      },
      off(event: string | symbol, listener: (...args: any[]) => void) {
        removed.push({ event: String(event), listener: () => listener() })
        return child
      },
    }
    return { child, registered, removed }
  }

  test('extractDevtoolsWebSocketUrl picks the ws:// URL from the listening line', () => {
    expect(
      extractDevtoolsWebSocketUrl(
        '[info] DevTools listening on ws://127.0.0.1:9222/devtools/browser/x',
      ),
    ).toBe('ws://127.0.0.1:9222/devtools/browser/x')
    expect(extractDevtoolsWebSocketUrl('nothing here')).toBeUndefined()
  })

  test('readDevtoolsWebSocketUrl resolves the URL from stderr and detaches its listeners', async () => {
    const stderr = new PassThrough()
    const { child, removed } = makeFakeChild(stderr)
    const pending = readDevtoolsWebSocketUrl(child, 200)

    stderr.write(' Starting browser\n')
    await flushAsync()
    stderr.write(
      'DevTools listening on ws://127.0.0.1:41051/devtools/browser/guid\n',
    )

    await expect(pending).resolves.toBe(
      'ws://127.0.0.1:41051/devtools/browser/guid',
    )
    // The child-level listeners are detached once settled.
    expect(removed.map((item) => item.event).sort()).toEqual([
      'error',
      'exit',
    ])
  })

  test('readDevtoolsWebSocketUrl rejects when no URL appears within the timeout', async () => {
    const stderr = new PassThrough()
    const { child } = makeFakeChild(stderr)
    await expect(readDevtoolsWebSocketUrl(child, 20)).rejects.toThrow(
      /within 20ms/,
    )
  })

  test('readDevtoolsWebSocketUrl rejects when Chrome exits before reporting a URL', async () => {
    const stderr = new PassThrough()
    const { child, registered } = makeFakeChild(stderr)
    const pending = readDevtoolsWebSocketUrl(child, 200)
    await flushAsync()
    const exit = registered.find((item) => item.event === 'exit')
    exit?.listener()
    await expect(pending).rejects.toThrow(/exited before reporting/)
  })
})

describe('stopBrowserSession teardown (WebSocket fallback disposal)', () => {
  test('invokes disposeTransport so the fallback ws socket closes at explicit teardown', async () => {
    const { writable, readable } = makePair()
    const transport = new CdpPipeTransport({ writable, readable })
    const disposeCalls: number[] = []
    const killCalls: number[] = []
    __registerBrowserSessionForTest('stop-ws-fallback', {
      // Teardown only calls child.kill(), so a minimal stub suffices; cast to
      // the full ChildProcess type without instantiating one.
      child: {
        kill: () => {
          killCalls.push(1)
          return true
        },
      } as unknown as ChildProcess,
      transport,
      userDataDir: mkdtempSync(path.join(tmpdir(), 'cdp-stop-')),
      disposeTransport: () => {
        disposeCalls.push(1)
      },
    })

    try {
      await stopBrowserSession('stop-ws-fallback')

      // A session spawned on the WebSocket fallback carries disposeTransport;
      // explicit teardown must close the underlying ws socket deterministically
      // (before the transport and child teardown), not rely on child.kill()
      // racing Chrome's own socket close.
      expect(disposeCalls).toHaveLength(1)
      expect(killCalls).toHaveLength(1)
      expect(transport.isClosed).toBe(true)

      // The session was deregistered: a second stop is a no-op.
      await stopBrowserSession('stop-ws-fallback')
      expect(disposeCalls).toHaveLength(1)
    } finally {
      transport.close()
    }
  })

  test('tears down a pipe session with no disposeTransport without extra disposal', async () => {
    const { writable, readable } = makePair()
    const transport = new CdpPipeTransport({ writable, readable })
    const killCalls: number[] = []
    __registerBrowserSessionForTest('stop-pipe', {
      // Same minimal kill-only stub as above.
      child: {
        kill: () => {
          killCalls.push(1)
          return true
        },
      } as unknown as ChildProcess,
      transport,
      userDataDir: mkdtempSync(path.join(tmpdir(), 'cdp-stop-')),
    })

    try {
      await stopBrowserSession('stop-pipe')

      // The pipe transport needs no extra disposal, but the rest of the
      // teardown still runs.
      expect(killCalls).toHaveLength(1)
      expect(transport.isClosed).toBe(true)
    } finally {
      transport.close()
    }
  })
})

describe('stopBrowserSessionsByOwner (run-end reaping)', () => {
  test('reaps ownerless bare-key sessions alongside the owned session', async () => {
    const { writable, readable } = makePair()
    const transport = new CdpPipeTransport({ writable, readable })
    const killed: string[] = []
    const makeSession = (sessionKey: string, owner?: BrowserSessionOwner) => {
      const userDataDir = mkdtempSync(path.join(tmpdir(), 'cdp-reap-'))
      __registerBrowserSessionForTest(sessionKey, {
        owner,
        child: {
          kill: () => {
            killed.push(sessionKey)
            return true
          },
        } as unknown as ChildProcess,
        transport,
        userDataDir,
      })
      return userDataDir
    }

    const ownerlessDir = makeSession('ownerless-default')
    const ownedDir = makeSession('owned-match', {
      clientSessionId: 'run-1',
      rootRunId: 'root-1',
      parentRunId: 'parent-1',
      parentAgentId: 'browser-a',
    })
    const otherDir = makeSession('owned-other', {
      clientSessionId: 'run-2',
      rootRunId: 'root-1',
      parentRunId: 'parent-1',
      parentAgentId: 'browser-a',
    })

    try {
      await stopBrowserSessionsByOwner({ clientSessionId: 'run-1' })

      // The owner's session and the ownerless bare-key session are both
      // reaped at run end (no fd/process/temp-dir leak)...
      expect(killed.sort()).toEqual(['owned-match', 'ownerless-default'])
      expect(existsSync(ownerlessDir)).toBe(false)
      expect(existsSync(ownedDir)).toBe(false)
      // ...while a session owned by a different clientSessionId survives.
      expect(existsSync(otherDir)).toBe(true)
    } finally {
      await stopBrowserSession('owned-other')
      transport.close()
    }
  })
})

describe('redactDevtoolsUrl (ws capability-token redaction)', () => {
  test('strips the path carrying the browser capability token', () => {
    expect(
      redactDevtoolsUrl('ws://127.0.0.1:41051/devtools/browser/guid-token'),
    ).toBe('ws://127.0.0.1:41051')
    // Non-URL input degrades to a placeholder rather than leaking anything.
    expect(redactDevtoolsUrl('not a url')).toBe(
      '(redacted DevTools endpoint)',
    )
  })
})
