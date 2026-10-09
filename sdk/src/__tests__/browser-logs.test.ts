import { afterEach, describe, expect, test } from 'bun:test'
import type { ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { z } from 'zod/v4'

import {
  type BrowserAction,
  type Log,
  type NetworkEvent,
  BrowserActionInputSchema,
  BrowserActionSchema,
} from '@codebuff/common/browser-actions'

import {
  __registerBrowserSessionForTest,
  __resetPipeSupportProbeCacheForTest,
  __setBrowserTeardownTimingForTest,
  __setBrowserUserDataDirRemoverForTest,
  browserLogs,
  buildApng,
  buildPdfAttachmentMetadata,
  buildResponse,
  connectPage,
  detectPipeSupport,
  diagnoseNestingExceedsLimit,
  frameSelectorOffsetScript,
  getBrowserSessionKey,
  handleRecordingAction,
  honorStopRequestedDuringSpawn,
  MAX_DIAGNOSE_NESTING_DEPTH,
  normalizeBrowserUrl,
  parsePngChunks,
  recordNetworkEvent,
  rollbackBrowserSpawn,
  shareInFlightBrowserSpawn,
  stopBrowserSession,
  sweepDeferredBrowserUserDataDirs,
  translateFramePoint,
  waitForEvent,
  writePngChunk,
} from '../tools/browser-logs'

describe('browser_logs', () => {
  test('isolates session keys by root run and owning agent', () => {
    const base = {
      clientSessionId: 'session',
      rootRunId: 'root',
      parentRunId: 'parent',
      parentAgentId: 'browser-a',
    }
    expect(getBrowserSessionKey(base)).not.toBe(
      getBrowserSessionKey({ ...base, parentAgentId: 'browser-b' }),
    )
    expect(getBrowserSessionKey(base)).not.toBe(
      getBrowserSessionKey({ ...base, rootRunId: 'other-root' }),
    )
  })

  test('normalizes bare live domains to HTTPS', () => {
    expect(normalizeBrowserUrl('infraformat.com')).toBe(
      'https://infraformat.com',
    )
    expect(normalizeBrowserUrl('www.infraformat.com/path?q=1')).toBe(
      'https://www.infraformat.com/path?q=1',
    )
  })

  test('preserves explicit schemes and local dev HTTP defaults', () => {
    expect(normalizeBrowserUrl('https://infraformat.com')).toBe(
      'https://infraformat.com',
    )
    expect(normalizeBrowserUrl('http://localhost:5173')).toBe(
      'http://localhost:5173',
    )
    expect(normalizeBrowserUrl('about:blank')).toBe('about:blank')
    expect(normalizeBrowserUrl('data:text/html,<h1>Smoke</h1>')).toBe(
      'data:text/html,<h1>Smoke</h1>',
    )
    expect(normalizeBrowserUrl('localhost:5173')).toBe('http://localhost:5173')
    expect(normalizeBrowserUrl('127.0.0.1:3001')).toBe('http://127.0.0.1:3001')
  })

  test('browser tool input schema is object-shaped for function calling', () => {
    const jsonSchema = z.toJSONSchema(BrowserActionInputSchema, { io: 'input' })

    expect(jsonSchema).toMatchObject({
      type: 'object',
      properties: {
        type: {
          type: 'string',
        },
      },
    })
    expect(jsonSchema).not.toHaveProperty('oneOf')
    expect(
      BrowserActionInputSchema.safeParse({ type: 'navigate' }).success,
    ).toBe(false)
    expect(
      BrowserActionInputSchema.safeParse({
        type: 'storage',
        storage: 'local',
        operation: 'remove',
        key: 'token',
      }).success,
    ).toBe(true)
  })

  test('accepts richer browser action schemas', () => {
    const actions = [
      { type: 'key', key: 'Enter' },
      { type: 'key', key: 'k', modifiers: ['Meta' as const] },
      { type: 'mouse', event: 'click', x: 10, y: 20 },
      { type: 'hover', selector: 'button[aria-label="Menu"]' },
      { type: 'drag', fromSelector: '#source', toSelector: '#target' },
      { type: 'select', selector: 'select[name="plan"]', value: 'pro' },
      { type: 'wait_for', selector: '[data-loaded="true"]', timeout: 5000 },
      { type: 'upload', selector: 'input[type="file"]', paths: ['README.md'] },
      { type: 'cookie', operation: 'set', name: 'token', value: 'abc' },
      {
        type: 'storage',
        storage: 'local',
        operation: 'set',
        key: 'token',
        value: 'abc',
      },
      {
        type: 'viewport',
        width: 390,
        height: 844,
        isMobile: true,
        hasTouch: true,
      },
      {
        type: 'network',
        offline: false,
        latency: 100,
        downloadThroughput: 50_000,
      },
      { type: 'tab', operation: 'create', url: 'about:blank' },
      { type: 'recording', operation: 'start', everyNthFrame: 2 },
      { type: 'pdf', printBackground: true },
      { type: 'pixel_diff', expectedImageBase64: 'abc', threshold: 0.1 },
      { type: 'design_tokens' },
      {
        type: 'design_tokens',
        selector: 'main',
        maxElements: 200,
        frameSelector: 'iframe#embed',
      },
      { type: 'screenshot', screenshotPurpose: 'design' },
      { type: 'screenshot', screenshotPurpose: 'smoke', fullPage: true },
    ]

    for (const action of actions) {
      expect(BrowserActionSchema.parse(action).type).toBe(
        action.type as BrowserAction['type'],
      )
    }
  })

  test('input schema accepts design_tokens and screenshot purpose fields', () => {
    expect(
      BrowserActionInputSchema.safeParse({
        type: 'design_tokens',
        selector: 'main',
        maxElements: 100,
      }).success,
    ).toBe(true)
    expect(
      BrowserActionInputSchema.safeParse({
        type: 'screenshot',
        screenshotPurpose: 'design',
      }).success,
    ).toBe(true)
  })

  test('accepts iframe targeting on selector-based actions', () => {
    expect(
      BrowserActionSchema.parse({
        type: 'click',
        selector: 'button',
        frameSelector: 'iframe#checkout',
      }),
    ).toMatchObject({ type: 'click', frameSelector: 'iframe#checkout' })

    expect(
      BrowserActionSchema.parse({
        type: 'click',
        selector: 'button',
        frameUrl: '/embedded',
      }),
    ).toMatchObject({ type: 'click', frameUrl: '/embedded' })

    expect(
      BrowserActionSchema.parse({
        type: 'evaluate',
        script: 'document.body.innerText',
        frameUrl: '/embedded',
      }),
    ).toMatchObject({ type: 'evaluate', frameUrl: '/embedded' })

    expect(
      BrowserActionSchema.parse({
        type: 'mouse',
        event: 'click',
        x: 12,
        y: 34,
        frameSelector: 'iframe#checkout',
      }),
    ).toMatchObject({ type: 'mouse', frameSelector: 'iframe#checkout' })

    expect(
      BrowserActionSchema.parse({
        type: 'drag',
        fromX: 1,
        fromY: 2,
        toX: 3,
        toY: 4,
        frameUrl: '/embedded',
      }),
    ).toMatchObject({ type: 'drag', frameUrl: '/embedded' })
  })

  test('translates frame-local mouse coordinates to viewport coordinates', () => {
    const frameLocalClick = { x: 15, y: 25 }
    const frameOffset = { x: 100, y: 200 }

    expect(translateFramePoint(frameLocalClick, frameOffset)).toEqual({
      x: 115,
      y: 225,
    })
  })

  test('pdf metadata is JSON-only so unsupported PDF media does not break chat conversion', () => {
    const metadata = buildPdfAttachmentMetadata(
      Buffer.from('%PDF').toString('base64'),
    )

    expect(metadata).toEqual({
      pdfAttached: true,
      pdfBase64Length: 8,
      pdfByteLength: 4,
    })
  })

  test('resolves frameSelector offsets for explicit coordinate actions', () => {
    const previousDocument = globalThis.document
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: {
        querySelector: (selector: string) => {
          expect(selector).toBe('iframe#checkout')
          return { getBoundingClientRect: () => ({ left: 40, top: 60 }) }
        },
      },
    })

    try {
      const offset = Function(
        `return ${frameSelectorOffsetScript('iframe#checkout')}`,
      )()
      expect(translateFramePoint({ x: 12, y: 34 }, offset)).toEqual({
        x: 52,
        y: 94,
      })
    } finally {
      Object.defineProperty(globalThis, 'document', {
        configurable: true,
        value: previousDocument,
      })
    }
  })

  test('correlates responseReceived with its request method and url', () => {
    const networks: NetworkEvent[] = []
    const requests = new Map<string, { method: string; url: string }>()
    const timestamp = 1_700_000_000_000

    recordNetworkEvent(
      networks,
      requests,
      {
        method: 'Network.requestWillBeSent',
        params: {
          requestId: 'r1',
          request: { method: 'POST', url: 'https://api.example.com/x' },
        },
      },
      timestamp,
    )

    // requestWillBeSent only tracks the request; nothing is pushed yet.
    expect(networks).toHaveLength(0)
    expect(requests.size).toBe(1)

    recordNetworkEvent(
      networks,
      requests,
      {
        method: 'Network.responseReceived',
        params: {
          requestId: 'r1',
          response: { url: 'https://api.example.com/x', status: 200 },
        },
      },
      timestamp,
    )

    expect(networks).toEqual([
      {
        url: 'https://api.example.com/x',
        method: 'POST',
        status: 200,
        timestamp,
      },
    ])
    // The correlation entry is cleaned up once the response arrives.
    expect(requests.size).toBe(0)
  })

  test('reports tracked method and url for a correlated loadingFailed', () => {
    const networks: NetworkEvent[] = []
    const requests = new Map<string, { method: string; url: string }>()
    const timestamp = 1_700_000_000_001

    recordNetworkEvent(
      networks,
      requests,
      {
        method: 'Network.requestWillBeSent',
        params: {
          requestId: 'r2',
          request: { method: 'PUT', url: 'https://api.example.com/y' },
        },
      },
      timestamp,
    )

    recordNetworkEvent(
      networks,
      requests,
      {
        method: 'Network.loadingFailed',
        params: { requestId: 'r2', errorText: 'net::ERR_FAILED' },
      },
      timestamp,
    )

    // The failure reports the tracked method/url, not the requestId.
    expect(networks).toEqual([
      {
        url: 'https://api.example.com/y',
        method: 'PUT',
        errorText: 'net::ERR_FAILED',
        timestamp,
      },
    ])
    expect(requests.size).toBe(0)
  })

  test('bounds the tracked-request correlation map to avoid unbounded growth', () => {
    const networks: NetworkEvent[] = []
    const requests = new Map<string, { method: string; url: string }>()
    const timestamp = 1_700_000_000_002

    // Simulate many in-flight requests that never receive a response/failure
    // (which would otherwise leak entries for the life of the session).
    for (let i = 0; i < 2500; i++) {
      recordNetworkEvent(
        networks,
        requests,
        {
          method: 'Network.requestWillBeSent',
          params: {
            requestId: `req-${i}`,
            request: { method: 'GET', url: `https://api.example.com/${i}` },
          },
        },
        timestamp,
      )
    }

    // The map is capped at MAX_TRACKED_NETWORK_REQUESTS (2000); oldest entries
    // are evicted first, so the most recent request is retained.
    expect(requests.size).toBe(2000)
    expect(requests.has('req-2499')).toBe(true)
    expect(requests.has('req-0')).toBe(false)
    // No dangling response events were pushed for tracking-only requests.
    expect(networks).toHaveLength(0)
  })
})

describe('APNG assembly (writePngChunk / buildApng)', () => {
  // Independent bitwise CRC32 (no lookup table) so the chunk encoding's CRC
  // output is validated against a reference implementation, not itself.
  function referenceCrc32(bytes: Buffer): number {
    let crc = 0xffffffff
    for (const byte of bytes) {
      crc ^= byte
      for (let bit = 0; bit < 8; bit++) {
        crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1
      }
    }
    return (crc ^ 0xffffffff) >>> 0
  }

  function makeFrame(width: number, height: number, idat: Buffer): Buffer {
    const ihdr = Buffer.alloc(13)
    ihdr.writeUInt32BE(width, 0)
    ihdr.writeUInt32BE(height, 4)
    ihdr.writeUInt8(8, 8) // bit depth
    ihdr.writeUInt8(6, 9) // color type RGBA
    return Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      writePngChunk('IHDR', ihdr),
      writePngChunk('IDAT', idat),
      writePngChunk('IEND', Buffer.alloc(0)),
    ])
  }

  test('writePngChunk encodes length, type, payload, and a reference-checked CRC', () => {
    const payload = Buffer.from('payload-bytes')
    const chunk = writePngChunk('tEXt', payload)

    expect(chunk.readUInt32BE(0)).toBe(payload.length)
    expect(chunk.subarray(4, 8).toString('ascii')).toBe('tEXt')
    expect(chunk.subarray(8, 8 + payload.length).equals(payload)).toBe(true)
    expect(chunk.readUInt32BE(8 + payload.length)).toBe(
      referenceCrc32(Buffer.concat([Buffer.from('tEXt', 'ascii'), payload])),
    )
  })

  test('writePngChunk concatenates multiple payload parts into one chunk', () => {
    const chunk = writePngChunk('fdAT', Buffer.from('abc'), Buffer.from('def'))

    expect(chunk.readUInt32BE(0)).toBe(6)
    expect(chunk.subarray(8, 14).toString('ascii')).toBe('abcdef')
    expect(chunk.length).toBe(18)
    expect(chunk.readUInt32BE(14)).toBe(
      referenceCrc32(Buffer.from('fdATabcdef', 'ascii')),
    )
  })

  test('buildApng returns an empty buffer when there are no frames', () => {
    expect(buildApng([]).length).toBe(0)
  })

  test('buildApng reassembles frames with valid chunk structure and CRCs', () => {
    const firstIdat = Buffer.from('first-frame-image-data')
    const secondIdat = Buffer.from('second-frame-image-data')

    const apng = buildApng([
      { buffer: makeFrame(4, 3, firstIdat), timestamp: 0 },
      { buffer: makeFrame(4, 3, secondIdat), timestamp: 250 },
    ])

    const chunks = parsePngChunks(apng)
    expect(chunks.map((chunk) => chunk.type)).toEqual([
      'IHDR',
      'acTL',
      'fcTL',
      'IDAT',
      'fcTL',
      'fdAT',
      'IEND',
    ])

    // acTL declares the frame count and an infinite loop count.
    expect(chunks[1]!.data.readUInt32BE(0)).toBe(2)
    expect(chunks[1]!.data.readUInt32BE(4)).toBe(0)

    // The first frame keeps its IDAT payload byte-for-byte...
    expect(chunks[3]!.data.equals(firstIdat)).toBe(true)
    // ...and later frames become fdAT with their sequence number prefixed.
    expect(chunks[4]!.data.readUInt32BE(0)).toBe(1)
    expect(chunks[5]!.data.readUInt32BE(0)).toBe(2)
    expect(chunks[5]!.data.subarray(4).equals(secondIdat)).toBe(true)

    // fcTL carries the frame dimensions and the measured inter-frame delay.
    expect(chunks[2]!.data.readUInt32BE(0)).toBe(0)
    expect(chunks[2]!.data.readUInt32BE(4)).toBe(4)
    expect(chunks[2]!.data.readUInt32BE(8)).toBe(3)
    expect(chunks[2]!.data.readUInt16BE(20)).toBe(250)
    expect(chunks[2]!.data.readUInt16BE(22)).toBe(1000)

    // Every emitted chunk's stored CRC matches a reference CRC32 computed
    // over the type and payload — the encoding path under repair.
    let offset = 8
    for (const chunk of chunks) {
      const stored = apng.readUInt32BE(offset + 8 + chunk.data.length)
      const expected = referenceCrc32(
        Buffer.concat([Buffer.from(chunk.type, 'ascii'), chunk.data]),
      )
      expect(stored).toBe(expected)
      offset += 12 + chunk.data.length
    }
  })

  test('buildApng drops frames whose IHDR dimensions differ from frame 0', () => {
    const firstIdat = Buffer.from('first-frame-image-data')
    const resizedIdat = Buffer.from('resized-frame-image-data')
    const thirdIdat = Buffer.from('third-frame-image-data')

    const apng = buildApng([
      { buffer: makeFrame(500, 400, firstIdat), timestamp: 0 },
      { buffer: makeFrame(600, 450, resizedIdat), timestamp: 250 },
      { buffer: makeFrame(500, 400, thirdIdat), timestamp: 500 },
    ])

    const chunks = parsePngChunks(apng)
    expect(chunks.map((chunk) => chunk.type)).toEqual([
      'IHDR',
      'acTL',
      'fcTL',
      'IDAT',
      'fcTL',
      'fdAT',
      'IEND',
    ])

    // acTL declares the count of KEPT frames, not the raw input frame count.
    expect(chunks[1]!.data.readUInt32BE(0)).toBe(2)
    expect(chunks[1]!.data.readUInt32BE(4)).toBe(0)

    // The resized middle frame is skipped: every emitted fcTL carries the
    // kept frames' own 500x400 IHDR dimensions, never the mismatched 600x450,
    // so decoders never see fcTL dims disagreeing with the image data's IHDR.
    expect(chunks[2]!.data.readUInt32BE(4)).toBe(500)
    expect(chunks[2]!.data.readUInt32BE(8)).toBe(400)
    expect(chunks[4]!.data.readUInt32BE(4)).toBe(500)
    expect(chunks[4]!.data.readUInt32BE(8)).toBe(400)

    // Dropped frames do not consume sequence numbers: fcTL numbers stay
    // contiguous (0, 1) and the fdAT sequence continues at 2.
    expect(chunks[2]!.data.readUInt32BE(0)).toBe(0)
    expect(chunks[4]!.data.readUInt32BE(0)).toBe(1)
    expect(chunks[5]!.data.readUInt32BE(0)).toBe(2)
    expect(chunks[5]!.data.subarray(4).equals(thirdIdat)).toBe(true)
    // The skipped frame's image data is absent from the output entirely.
    expect(apng.includes(resizedIdat)).toBe(false)
  })

  test('buildApng skips a later frame without an IHDR instead of crashing', () => {
    const firstIdat = Buffer.from('first-frame-image-data')
    // A later frame captured without an IHDR cannot have its dimensions
    // checked, so it is skipped like a dimension mismatch.
    const headerless = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      writePngChunk('IDAT', Buffer.from('orphan-image-data')),
      writePngChunk('IEND', Buffer.alloc(0)),
    ])

    const apng = buildApng([
      { buffer: makeFrame(4, 3, firstIdat), timestamp: 0 },
      { buffer: headerless, timestamp: 250 },
    ])

    const chunks = parsePngChunks(apng)
    expect(chunks.map((chunk) => chunk.type)).toEqual([
      'IHDR',
      'acTL',
      'fcTL',
      'IDAT',
      'IEND',
    ])
    // Only frame 0 is kept: acTL counts one frame and its fcTL sequence
    // number is 0, with no sequence number consumed by the skipped frame.
    expect(chunks[1]!.data.readUInt32BE(0)).toBe(1)
    expect(chunks[2]!.data.readUInt32BE(0)).toBe(0)
    expect(apng.includes(Buffer.from('orphan-image-data'))).toBe(false)
  })
})

describe('shareInFlightBrowserSpawn (single-flight spawn guard)', () => {
  test('concurrent calls for the same key share one in-flight spawn', async () => {
    let spawnCount = 0
    let release!: (session: string) => void
    const spawnSession = () => {
      spawnCount += 1
      return new Promise<string>((resolve) => {
        release = resolve
      })
    }

    const first = shareInFlightBrowserSpawn('race-key', spawnSession)
    const second = shareInFlightBrowserSpawn('race-key', spawnSession)

    // Only one spawn attempt is made for the shared key.
    expect(spawnCount).toBe(1)

    release('session-a')
    await expect(first).resolves.toBe('session-a')
    // Both concurrent callers observe the same settled session.
    await expect(second).resolves.toBe('session-a')
  })

  test('a settled spawn is cleared so the next call starts a fresh spawn', async () => {
    let spawnCount = 0
    const spawnSession = async () => {
      spawnCount += 1
      return `session-${spawnCount}`
    }

    expect(await shareInFlightBrowserSpawn('retry-key', spawnSession)).toBe(
      'session-1',
    )
    expect(await shareInFlightBrowserSpawn('retry-key', spawnSession)).toBe(
      'session-2',
    )
    expect(spawnCount).toBe(2)
  })

  test('concurrent callers share one failed spawn, which is then retriable', async () => {
    let spawnCount = 0
    const rejecters: Array<(error: Error) => void> = []
    const spawnSession = () => {
      spawnCount += 1
      return new Promise<string>((_resolve, reject) => {
        rejecters.push(reject)
      })
    }

    const first = shareInFlightBrowserSpawn('fail-key', spawnSession)
    const second = shareInFlightBrowserSpawn('fail-key', spawnSession)
    expect(spawnCount).toBe(1)

    rejecters[0]!(new Error('chrome failed to launch'))
    await expect(first).rejects.toThrow('chrome failed to launch')
    // Both concurrent callers observe the same failure — no second spawn.
    await expect(second).rejects.toThrow('chrome failed to launch')

    // The failed entry is cleared, so the next call spawns again.
    const third = shareInFlightBrowserSpawn('fail-key', spawnSession)
    expect(spawnCount).toBe(2)
    rejecters[1]!(new Error('chrome failed to launch'))
    await expect(third).rejects.toThrow('chrome failed to launch')
  })
})

describe('browser stop-vs-inflight-spawn race', () => {
  function makeTeardownSession() {
    // Minimal mocks matching the narrowed surfaces honorStopRequestedDuringSpawn
    // consumes: kill returns boolean (ChildProcess contract), close returns void.
    const child = { kill: (): boolean => true }
    const transport = { close: (): void => undefined }
    return { child, transport, userDataDir: '/tmp/fake-user-data' }
  }

  test('a stop requested while a spawn is in flight rolls the completed spawn back', async () => {
    let spawnCount = 0
    let release!: (session: { child: any; transport: any; userDataDir: string }) => void
    const spawnSession = () => {
      spawnCount += 1
      return new Promise<any>((resolve) => {
        release = resolve
      })
    }

    // Start the spawn (in flight)...
    const inFlight = shareInFlightBrowserSpawn('stop-race-key', spawnSession)
    expect(spawnCount).toBe(1)

    // ...request stop while it is still in flight (no registered session yet,
    // matching stopBrowserSession's empty-registry branch).
    await stopBrowserSession('stop-race-key')

    // The in-flight spawn completes with a live teardown-shaped session.
    const session = makeTeardownSession()
    release(session)
    await expect(inFlight).resolves.toBe(session)

    // The stop-vs-spawn guard must consume the pending stop and roll back the
    // freshly spawned session instead of letting it register untracked.
    expect(
      honorStopRequestedDuringSpawn('stop-race-key', session),
    ).toBe(true)
    expect(
      honorStopRequestedDuringSpawn('stop-race-key', session),
    ).toBe(false)
  })

  test('a normal start with no pending stop registers without rollback', () => {
    const session = makeTeardownSession()
    expect(
      honorStopRequestedDuringSpawn('clean-key', session),
    ).toBe(false)
  })

  afterEach(() => {
    __setBrowserTeardownTimingForTest({
      childExitTimeoutMs: 2_000,
      childExitPollMs: 10,
      userDataDirRetryDelayMs: 25,
      userDataDirRetries: 4,
    })
  })

  test('a stop arms the race marker during teardown, before it returns', async () => {
    // A child that only exits when the test lets it, so teardown's bounded
    // child-exit wait is still in flight when the in-flight spawn completes.
    let exitChild!: () => void
    const childExited = new Promise<void>((resolve) => {
      exitChild = resolve
    })
    const child = {
      exitCode: null as number | null,
      kill: () => {
        void childExited.then(() => {
          child.exitCode = 0
        })
        return true
      },
    }
    const userDataDir = mkdtempSync(path.join(tmpdir(), 'cb-stop-race-mid-'))
    __setBrowserTeardownTimingForTest({
      childExitTimeoutMs: 5_000,
      childExitPollMs: 5,
    })
    __registerBrowserSessionForTest('stop-mid-teardown-key', {
      child,
      transport: { close: () => undefined },
      userDataDir,
    } as unknown as Parameters<typeof __registerBrowserSessionForTest>[1])

    // An in-flight spawn for the same key...
    let release!: (session: {
      child: { kill: () => boolean }
      transport: { close: () => void }
      userDataDir: string
    }) => void
    const inFlight = shareInFlightBrowserSpawn(
      'stop-mid-teardown-key',
      () =>
        new Promise<{
          child: { kill: () => boolean }
          transport: { close: () => void }
          userDataDir: string
        }>((resolve) => {
          release = resolve
        }),
    )

    // ...races a stop whose teardown is still awaiting the child's exit.
    const stopPromise = stopBrowserSession('stop-mid-teardown-key')

    // The spawn completes while teardown is still in flight.
    release(makeTeardownSession())
    await expect(inFlight).resolves.toBeDefined()

    // Before stop resolves, the marker must already be armed: the completed
    // spawn's registration guard rolls the session back instead of letting a
    // live browser outlive a stop that is about to return success. The marker
    // stays armed for the whole teardown window — every spawn racing the
    // still-in-flight teardown is rolled back, not just the first one — and
    // is cleared by the stop's own completion, so it cannot poison a later
    // legitimate start.
    const survivor = makeTeardownSession()
    expect(
      honorStopRequestedDuringSpawn('stop-mid-teardown-key', survivor),
    ).toBe(true)
    expect(
      honorStopRequestedDuringSpawn('stop-mid-teardown-key', survivor),
    ).toBe(true)

    // Let the child exit so teardown completes and the stop returns.
    exitChild()
    await stopPromise
    expect(existsSync(userDataDir)).toBe(false)
    // After the stop has returned, the marker is consumed: a fresh spawn
    // registers normally instead of being rolled back by a stale marker.
    expect(
      honorStopRequestedDuringSpawn('stop-mid-teardown-key', survivor),
    ).toBe(false)

    // Let the child exit so teardown completes and the stop returns.
    exitChild()
    await stopPromise
    expect(existsSync(userDataDir)).toBe(false)
  })
})

describe('browser session teardown resource safety', () => {
  afterEach(() => {
    __setBrowserTeardownTimingForTest({
      childExitTimeoutMs: 2_000,
      childExitPollMs: 10,
      userDataDirRetryDelayMs: 25,
      userDataDirRetries: 4,
    })
    __setBrowserUserDataDirRemoverForTest(null)
  })

  function registerTeardownSession(
    sessionKey: string,
    userDataDir: string,
    child: ChildProcess,
  ): void {
    __registerBrowserSessionForTest(sessionKey, {
      child,
      transport: { close: () => undefined },
      userDataDir,
    } as unknown as Parameters<typeof __registerBrowserSessionForTest>[1])
  }

  function makeFakeChild(order: string[]): ChildProcess {
    // Minimal ChildProcess-shaped mock: kill() flips exitCode on a later
    // tick, mirroring a child that needs a moment to terminate after the
    // signal, so the teardown must actually observe the exit.
    const child = {
      exitCode: null as number | null,
      kill: () => {
        order.push('kill')
        Promise.resolve().then(() => {
          child.exitCode = 0
        })
        return true
      },
    }
    return child as unknown as ChildProcess
  }

  test('stop removes the user-data dir only after the child exits', async () => {
    const order: string[] = []
    const userDataDir = mkdtempSync(path.join(tmpdir(), 'cb-teardown-ok-'))
    __setBrowserTeardownTimingForTest({
      childExitTimeoutMs: 500,
      childExitPollMs: 5,
    })
    __setBrowserUserDataDirRemoverForTest((dir) => {
      order.push('remove')
      rmSync(dir, { recursive: true, force: true })
      return true
    })
    registerTeardownSession('teardown-ok', userDataDir, makeFakeChild(order))

    await stopBrowserSession('teardown-ok')

    // The child was killed and its exit observed BEFORE the user-data dir
    // was removed — never rmSync'd while the child is still terminating.
    expect(order).toEqual(['kill', 'remove'])
    expect(existsSync(userDataDir)).toBe(false)
  })

  test('a removal that keeps failing is deferred and reclaimed by a later sweep', async () => {
    const userDataDir = mkdtempSync(path.join(tmpdir(), 'cb-teardown-stuck-'))
    __setBrowserTeardownTimingForTest({
      childExitTimeoutMs: 0,
      childExitPollMs: 1,
      userDataDirRetryDelayMs: 1,
      userDataDirRetries: 2,
    })
    // Simulate the dying child holding the dir open: every removal fails
    // (EBUSY/EPERM on Windows) and the dir survives the stop.
    __setBrowserUserDataDirRemoverForTest(() => false)
    registerTeardownSession('teardown-stuck', userDataDir, {
      exitCode: null,
      kill: () => true,
    } as unknown as ChildProcess)

    await stopBrowserSession('teardown-stuck')
    // The failed removal was not silently lost: the dir is deferred for a
    // later reclaim instead of leaking forever.
    expect(existsSync(userDataDir)).toBe(true)

    // By the next session activity the child has exited: the sweep reclaims
    // the deferred dir (the registry entry is already gone, so the
    // respawn-time rollbackStaleBrowserSession cleanup never runs here).
    __setBrowserUserDataDirRemoverForTest((dir) => {
      rmSync(dir, { recursive: true, force: true })
      return true
    })
    sweepDeferredBrowserUserDataDirs()
    expect(existsSync(userDataDir)).toBe(false)
  })

  test('a failed spawn rollback defers the user-data dir for the later sweep', () => {
    const userDataDir = mkdtempSync(path.join(tmpdir(), 'cb-rollback-defer-'))
    // Simulate the dying child still holding the dir open after the
    // asynchronous kill: the best-effort removal fails (EBUSY/EPERM on
    // Windows) exactly like the spawn-failure and pipe-probe rollback paths.
    __setBrowserUserDataDirRemoverForTest(() => false)
    rollbackBrowserSpawn({
      child: { kill: () => true },
      transport: { close: () => undefined },
      userDataDir,
    })
    // The failed removal was not silently lost: the dir survives for a later
    // reclaim instead of leaking one temp dir per failed spawn/probe.
    expect(existsSync(userDataDir)).toBe(true)

    // By the next sweep the child has exited: the dir is reclaimed.
    __setBrowserUserDataDirRemoverForTest((dir) => {
      rmSync(dir, { recursive: true, force: true })
      return true
    })
    sweepDeferredBrowserUserDataDirs()
    expect(existsSync(userDataDir)).toBe(false)
  })
})

describe('APNG dropped-frame delay accounting', () => {
  function makeFrame(width: number, height: number, idat: Buffer): Buffer {
    const ihdr = Buffer.alloc(13)
    ihdr.writeUInt32BE(width, 0)
    ihdr.writeUInt32BE(height, 4)
    ihdr.writeUInt8(8, 8)
    ihdr.writeUInt8(6, 9)
    return Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      writePngChunk('IHDR', ihdr),
      writePngChunk('IDAT', idat),
      writePngChunk('IEND', Buffer.alloc(0)),
    ])
  }

  test('a kept frame before dropped frames carries the accumulated wall-clock span', () => {
    const firstIdat = Buffer.from('first-frame-image-data')
    const resizedIdat = Buffer.from('resized-frame-image-data')
    const thirdIdat = Buffer.from('third-frame-image-data')

    const apng = buildApng([
      { buffer: makeFrame(500, 400, firstIdat), timestamp: 0 },
      { buffer: makeFrame(600, 450, resizedIdat), timestamp: 100 },
      { buffer: makeFrame(600, 450, resizedIdat), timestamp: 200 },
      { buffer: makeFrame(500, 400, thirdIdat), timestamp: 500 },
    ])

    const chunks = parsePngChunks(apng)
    expect(chunks.map((chunk) => chunk.type)).toEqual([
      'IHDR',
      'acTL',
      'fcTL',
      'IDAT',
      'fcTL',
      'fdAT',
      'IEND',
    ])

    // Frame 0 is kept; both resized frames are dropped; the last frame is
    // kept. acTL counts only kept frames.
    expect(chunks[1]!.data.readUInt32BE(0)).toBe(2)

    // The first kept frame's delay must span 0 -> 500ms (the next KEPT
    // frame's timestamp), covering the time the dropped frames occupied.
    // With the old per-original-frame gap it would have been just 100ms.
    expect(chunks[2]!.data.readUInt16BE(20)).toBe(500)
    expect(chunks[2]!.data.readUInt16BE(22)).toBe(1000)

    // The last kept frame has no successor; it reuses the previous kept
    // inter-frame gap (500 - 0 = 500).
    expect(chunks[4]!.data.readUInt16BE(20)).toBe(500)
    expect(chunks[4]!.data.readUInt16BE(22)).toBe(1000)
  })

  test('all-matching frames keep the original inter-frame delays', () => {
    const firstIdat = Buffer.from('first-frame-image-data')
    const secondIdat = Buffer.from('second-frame-image-data')

    const apng = buildApng([
      { buffer: makeFrame(4, 3, firstIdat), timestamp: 0 },
      { buffer: makeFrame(4, 3, secondIdat), timestamp: 250 },
    ])

    const chunks = parsePngChunks(apng)
    expect(chunks[2]!.data.readUInt16BE(20)).toBe(250)
    expect(chunks[2]!.data.readUInt16BE(22)).toBe(1000)
  })
})

describe('diagnose nesting guard', () => {
  function nestedDiagnose(depth: number): BrowserAction {
    // Built bottom-up: the innermost step action is a plain snapshot, and
    // each enclosing level is a diagnose step whose action is the previous
    // level, so the result nests `depth` diagnose actions deep.
    let inner: unknown = { type: 'snapshot' }
    for (let i = 0; i < depth; i++) {
      inner = {
        type: 'diagnose',
        steps: [{ label: `level-${i}`, action: inner }],
      }
    }
    // DiagnosticStepSchema's `action` field excludes 'diagnose', but the
    // tool-input path validates steps with DiagnosticStepInputSchema, whose
    // action is an unvalidated record — so a nested diagnose reaches
    // browserLogs at runtime as an untyped value. The cast mirrors that
    // runtime reality.
    return inner as BrowserAction
  }

  test(`nesting up to ${MAX_DIAGNOSE_NESTING_DEPTH} levels is allowed`, () => {
    expect(
      diagnoseNestingExceedsLimit(nestedDiagnose(MAX_DIAGNOSE_NESTING_DEPTH), 1),
    ).toBe(false)
  })

  test('nesting beyond the limit is rejected', () => {
    expect(
      diagnoseNestingExceedsLimit(
        nestedDiagnose(MAX_DIAGNOSE_NESTING_DEPTH + 1),
        1,
      ),
    ).toBe(true)
  })

  test('malformed step entries do not crash the depth check', () => {
    const malformed = {
      type: 'diagnose',
      steps: [null, { action: { type: 'diagnose', steps: 'nope' } }],
    } as unknown as BrowserAction
    expect(diagnoseNestingExceedsLimit(malformed, 1)).toBe(false)
  })

  test('a hostile deeply-nested diagnose returns a bounded error instead of exhausting the stack', async () => {
    const output = await browserLogs(nestedDiagnose(50))
    const json = output.find((item) => item.type === 'json')
    expect(json?.value.success).toBe(false)
    expect(json?.value.error).toContain(
      `nest at most ${MAX_DIAGNOSE_NESTING_DEPTH} levels deep`,
    )
  })
})

describe('buildResponse log/network window consumption', () => {
  /**
   * A session narrowed to exactly the window-consumption state buildResponse
   * reads and advances, plus a page whose transport defers every evaluate
   * round-trip behind a manually released promise — the await point where a
   * concurrent action could previously interleave with the cursor advance.
   */
  function makeWindowHarness() {
    const session = {
      logs: [] as Log[],
      networks: [] as NetworkEvent[],
      logOffset: 0,
      networkOffset: 0,
    }
    const pendingEvaluate: Array<(value: unknown) => void> = []
    const page = {
      targetId: 'target-1',
      sessionId: 'SID-1',
      transport: {
        send: () =>
          new Promise<unknown>((resolve) => {
            pendingEvaluate.push(resolve)
          }),
      },
      eventWaiters: new Map(),
      executionContexts: new Map(),
    }
    return {
      session: session as unknown as Parameters<typeof buildResponse>[0],
      page: page as unknown as Parameters<typeof buildResponse>[1],
      releaseEvaluate: () => {
        const resolve = pendingEvaluate.shift()
        if (resolve) resolve({})
      },
      pushLog: (message: string) => {
        session.logs.push({
          type: 'info',
          message,
          timestamp: 1,
          source: 'browser',
        })
      },
    }
  }

  test('sequential actions consume their own window without duplicates', async () => {
    const { session, page, releaseEvaluate, pushLog } = makeWindowHarness()
    pushLog('one')
    const first = buildResponse(session, page, 'navigate')
    releaseEvaluate()
    const firstResponse = await first
    expect(firstResponse.logs.map((log) => log.message)).toEqual(['one'])
    expect(session.logOffset).toBe(1)

    pushLog('two')
    const second = buildResponse(session, page, 'snapshot')
    releaseEvaluate()
    const secondResponse = await second
    expect(secondResponse.logs.map((log) => log.message)).toEqual(['two'])
    expect(session.logOffset).toBe(2)
  })

  test('a concurrent action keeps the window it captured at entry', async () => {
    const { session, page, releaseEvaluate, pushLog } = makeWindowHarness()
    pushLog('one')
    // Both actions capture the cursors synchronously at entry (offset 0)
    // before either reaches its evaluate await.
    const first = buildResponse(session, page, 'navigate')
    const second = buildResponse(session, page, 'snapshot')
    // A new event arrives while both are awaiting their evaluate round-trip.
    pushLog('two')

    releaseEvaluate()
    const firstResponse = await first
    expect(firstResponse.logs.map((log) => log.message)).toEqual([
      'one',
      'two',
    ])
    expect(session.logOffset).toBe(2)

    // The first action's cursor advance must not empty or steal the second
    // action's window: the second response still reports everything it
    // captured at entry, including events that landed after the first
    // response consumed its own window.
    pushLog('three')
    releaseEvaluate()
    const secondResponse = await second
    expect(secondResponse.logs.map((log) => log.message)).toEqual([
      'one',
      'two',
      'three',
    ])
    expect(session.logOffset).toBe(3)
  })

  test('a concurrent buffer trim during the await does not drop the captured window', async () => {
    const { session, page, releaseEvaluate, pushLog } = makeWindowHarness()
    // Consume an initial window so the captured cursor is non-zero.
    pushLog('old-1')
    pushLog('old-2')
    const first = buildResponse(session, page, 'navigate')
    releaseEvaluate()
    await first
    expect(session.logOffset).toBe(2)

    // The response under test captures start = 2 ...
    pushLog('fresh')
    const second = buildResponse(session, page, 'snapshot')
    // ... and while it awaits its evaluate round-trip, a concurrent
    // trimSessionBuffer splices the consumed entries off the front and pulls
    // the shared cursor down by the splice count (splice(0, overflow), then
    // logOffset -= overflow).
    session.logs.splice(0, 2)
    session.logOffset = Math.max(0, session.logOffset - 2)

    releaseEvaluate()
    const secondResponse = await second
    // Slicing from the stale captured offset (2, now past the end of the
    // trimmed buffer) would silently drop the unconsumed 'fresh' event; the
    // trim-corrected cursor start must be used instead.
    expect(secondResponse.logs.map((log) => log.message)).toEqual(['fresh'])
    expect(session.logOffset).toBe(1)
  })
})

describe('detectPipeSupport concurrent probe dedup', () => {
  afterEach(() => {
    __resetPipeSupportProbeCacheForTest()
  })

  function makeProbeOverrides(result: 'supported' | 'refused') {
    let spawnCalls = 0
    const probe = {
      child: { kill: () => true },
      transport: {
        send: (method: string) => {
          if (result === 'refused') {
            return Promise.reject(new Error('pipe closed'))
          }
          // CdpPipeTransport.send resolves with the response's `result`
          // payload directly (the probe reads targetInfos/sessionId off the
          // resolved value, not off a { result: ... } envelope).
          if (method === 'Target.getTargets') {
            return Promise.resolve({
              targetInfos: [
                { targetId: 'probe-target', type: 'page' },
              ],
            })
          }
          return Promise.resolve({ sessionId: 'SID-PROBE' })
        },
        close: () => {},
      },
      userDataDir: mkdtempSync(path.join(tmpdir(), 'probe-dedup-')),
    }
    return {
      overrides: {
        executablePath: () => '/usr/bin/fake-chrome',
        spawn: () => {
          spawnCalls++
          return probe
        },
        probeTimeoutMs: 200,
        cacheTtlMs: 60_000,
        now: () => 1_000,
      },
      spawnCalls: () => spawnCalls,
    }
  }

  test('concurrent callers share one probe for the same executable', async () => {
    const { overrides, spawnCalls } = makeProbeOverrides('supported')
    const first = detectPipeSupport(overrides)
    const second = detectPipeSupport(overrides)
    await expect(first).resolves.toBe(true)
    await expect(second).resolves.toBe(true)
    // Only one probe Chrome was launched for both concurrent callers, like
    // shareInFlightBrowserSpawn collapses concurrent spawns.
    expect(spawnCalls()).toBe(1)
  })

  test('concurrent callers share one probe even when it fails', async () => {
    const { overrides, spawnCalls } = makeProbeOverrides('refused')
    const first = detectPipeSupport(overrides)
    const second = detectPipeSupport(overrides)
    // A demonstrable failure is not cached, but the in-flight probe is still
    // shared: concurrent callers do not each launch a probe browser.
    await expect(first).resolves.toBe(false)
    await expect(second).resolves.toBe(false)
    expect(spawnCalls()).toBe(1)
  })
})

describe('waitForEvent waiter cleanup', () => {
  function makeWaiterPage() {
    return {
      eventWaiters: new Map<string, Array<() => void>>(),
    } as unknown as Parameters<typeof waitForEvent>[0]
  }

  test('a timed-out wait removes its waiter instead of leaking it', async () => {
    const page = makeWaiterPage()
    await expect(
      waitForEvent(page, 'Page.loadEventFired', 10),
    ).rejects.toThrow('Page.loadEventFired timed out after 10ms')
    // The timed-out waiter is gone: without the cleanup the leaked closure
    // would keep the entry (and everything it closes over) alive until the
    // same event name happened to fire later.
    expect(page.eventWaiters.has('Page.loadEventFired')).toBe(false)
  })

  test('one waiter timing out leaves other live waiters registered', async () => {
    const page = makeWaiterPage()
    const live = waitForEvent(page, 'Runtime.executionContextCreated', 5000)
    const timedOut = waitForEvent(page, 'Runtime.executionContextCreated', 10)
    await expect(timedOut).rejects.toThrow('timed out after 10ms')

    const waiters = page.eventWaiters.get('Runtime.executionContextCreated')
    expect(waiters).toHaveLength(1)
    // The surviving waiter still resolves when the event fires.
    waiters![0]!()
    await expect(live).resolves.toBeUndefined()
  })
})

describe('recording start failure rolls back session.recording', () => {
  function makeRecordingHarness() {
    const session = {
      logs: [] as Log[],
      networks: [] as NetworkEvent[],
      logOffset: 0,
      networkOffset: 0,
      recording: null,
    }
    let startScreencastCalls = 0
    const page = {
      targetId: 'target-1',
      sessionId: 'SID-1',
      transport: {
        send: (method: string) => {
          if (method === 'Page.startScreencast') {
            startScreencastCalls += 1
            if (startScreencastCalls === 1) {
              return Promise.reject(new Error('screencast refused'))
            }
          }
          return Promise.resolve({})
        },
      },
      eventWaiters: new Map(),
      executionContexts: new Map(),
    }
    const startAction = BrowserActionSchema.parse({
      type: 'recording',
      operation: 'start',
    }) as Extract<BrowserAction, { type: 'recording' }>
    return {
      session: session as unknown as Parameters<
        typeof handleRecordingAction
      >[0],
      page: page as unknown as Parameters<typeof handleRecordingAction>[1],
      startAction,
    }
  }

  test('a failed Page.startScreencast clears session.recording so start can be retried', async () => {
    const { session, page, startAction } = makeRecordingHarness()
    await expect(
      handleRecordingAction(session, page, startAction),
    ).rejects.toThrow('screencast refused')
    // The screencast never started, so the recording state must not claim it
    // did: a phantom active recording would permanently block future 'start'
    // attempts until a compensating 'stop'.
    expect(session.recording).toBeNull()

    // The retry (same action, transport now cooperating) succeeds and owns
    // the recording state.
    const output = await handleRecordingAction(session, page, startAction)
    const json = output.find((item) => item.type === 'json')
    expect(json?.value.success).toBe(true)
    expect(json?.value.action).toBe('recording')
    expect(session.recording).toMatchObject({ targetId: 'target-1' })
  })
})

describe('connectPage concurrent reconnect dedup', () => {
  function makeConnectHarness() {
    let attachCalls = 0
    let failNextAttach = false
    const pendingAttaches: Array<(value: unknown) => void> = []
    const session = {
      pages: new Map(),
      pagesBySessionId: new Map(),
      activeTargetId: 'target-1',
      logs: [],
      networks: [],
      networkRequests: new Map(),
      logOffset: 0,
      networkOffset: 0,
      recording: null,
      pendingEvents: new Map(),
      pendingEventCount: 0,
      transport: {
        isClosed: false,
        send: (
          method: string,
          _params?: Record<string, unknown>,
          _options?: { sessionId?: string },
        ) => {
          if (method === 'Target.attachToTarget') {
            attachCalls += 1
            if (failNextAttach) {
              failNextAttach = false
              return Promise.reject(new Error('attach refused'))
            }
            return new Promise<unknown>((resolve) => {
              pendingAttaches.push(resolve)
            })
          }
          // Domain-enable round-trips resolve immediately.
          return Promise.resolve({})
        },
      },
    }
    return {
      session: session as unknown as Parameters<typeof connectPage>[0],
      attachCalls: () => attachCalls,
      failNextAttach: () => {
        failNextAttach = true
      },
      resolveAttach: (sessionId: string) => {
        pendingAttaches.shift()?.({ sessionId })
      },
    }
  }

  test('concurrent reconnects of the same dead target share one flatten attach', async () => {
    const { session, attachCalls, resolveAttach } = makeConnectHarness()

    // Neither call sees a registered page, so both pass the existing-page
    // check; the single-flight guard must still issue only one attach.
    const first = connectPage(session, 'target-1')
    const second = connectPage(session, 'target-1')
    expect(attachCalls()).toBe(1)

    resolveAttach('SID-1')
    await expect(first).resolves.toMatchObject({ sessionId: 'SID-1' })
    await expect(second).resolves.toMatchObject({ sessionId: 'SID-1' })

    // One registered page under both indexes, and no loser sessionId left
    // attached whose events would drain into the bounded pending buffer.
    expect(session.pages.get('target-1')?.sessionId).toBe('SID-1')
    expect([...session.pagesBySessionId.keys()]).toEqual(['SID-1'])
  })

  test('a failed attach clears the in-flight entry so the reconnect can retry', async () => {
    const {
      session,
      attachCalls,
      failNextAttach,
      resolveAttach,
    } = makeConnectHarness()

    failNextAttach()
    await expect(connectPage(session, 'target-1')).rejects.toThrow(
      'attach refused',
    )
    expect(attachCalls()).toBe(1)

    // The retry issues a fresh attach instead of replaying the failed promise.
    const retry = connectPage(session, 'target-1')
    expect(attachCalls()).toBe(2)
    resolveAttach('SID-2')
    await expect(retry).resolves.toMatchObject({ sessionId: 'SID-2' })
  })
})
