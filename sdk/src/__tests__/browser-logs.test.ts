import { describe, expect, test } from 'bun:test'
import { z } from 'zod/v4'

import {
  type BrowserAction,
  type NetworkEvent,
  BrowserActionInputSchema,
  BrowserActionSchema,
} from '@codebuff/common/browser-actions'

import {
  buildApng,
  buildPdfAttachmentMetadata,
  frameSelectorOffsetScript,
  getBrowserSessionKey,
  normalizeBrowserUrl,
  parsePngChunks,
  recordNetworkEvent,
  shareInFlightBrowserSpawn,
  translateFramePoint,
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
