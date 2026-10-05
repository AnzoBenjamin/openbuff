/**
 * P2-T8b: supervised-child RPC bridge contract tests (in-process, no real
 * child). Covers the ndjson framing primitives, the parent bridge server +
 * child bridge client round-trip over a real Unix socket, marker
 * rehydration, fail-closed behavior on malformed input, close() semantics,
 * and the child-entry missing-deps gate.
 *
 * Every await that could hang on a bridge bug is wrapped in a bounded wait
 * (2s) so a defect shows as a timeout failure, never a hung test.
 */
import {
  BRIDGE_LOGGER_MARKER,
  BRIDGE_MAX_MESSAGE_BYTES,
  BRIDGE_MAX_STREAM_NEXT_REPLY_BYTES,
  BRIDGE_MAX_STREAM_CHUNKS_BYTES,
  BRIDGE_METHODS,
  BRIDGE_SIGNAL_MARKER,
  BridgeClosedError,
  createBridgeDateWireMarker,
  createBridgeWireMarker,
  BridgeProtocolError,
  createNdjsonLineReader,
  createStreamTruncationErrorResult,
  encodeBridgeMessage,
  findNonRoundTripSafeResultPaths,
  isBridgeDateWireMarker,
  isIncrementalStreamUnsupportedError,
  type BridgeMethod,
} from '../bridge-protocol'
import {
  buildSupervisedBridgeHandlers,
  MAX_CONCURRENT_BRIDGE_NOTIFIES,
  MAX_CONCURRENT_BRIDGE_STREAMS,
  startParentBridgeServer,
  type ParentBridgeHandlers,
  type ParentBridgeServer,
  type SupervisedBridgeHandlerDeps,
} from '../parent-bridge-server'
import {
  buildBridgedChildDeps,
  connectChildBridge,
  toBridgeJsonSchema,
  type ChildBridgeClient,
} from '../child-bridge-client'
import { missingChildCallbackDeps } from '../child-entry'

import { describe, expect, it } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as net from 'node:net'
import type { SupervisedSpawnRequest } from '@codebuff/common/types/contracts/agent-runtime'
import z from 'zod/v4'

const CALL_BUDGET_MS = 2_000

/** Rejects with a descriptive timeout error if the promise takes > ms. */
function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  const timeout = new Promise<never>((_, reject) => {
    const timer = setTimeout(() => {
      reject(
        new Error(
          `${label} timed out after ${ms}ms — a bridge bug would hang here`,
        ),
      )
    }, ms)
    timer.unref?.()
  })
  return Promise.race([promise, timeout])
}

type TimedOutcome =
  | { kind: 'resolved'; value: unknown }
  | { kind: 'rejected'; error: unknown }
  | { kind: 'timeout' }

/** Settles a promise's outcome within ms, reporting 'timeout' instead of hanging. */
async function settleWithin(
  promise: Promise<unknown>,
  ms: number,
): Promise<TimedOutcome> {
  return (await Promise.race([
    promise.then(
      (value) => ({ kind: 'resolved', value }) as TimedOutcome,
      (error: unknown) => ({ kind: 'rejected', error }) as TimedOutcome,
    ),
    Bun.sleep(ms).then(() => ({ kind: 'timeout' }) as TimedOutcome),
  ])) as TimedOutcome
}

type BridgeHarness = {
  dir: string
  socketPath: string
  server: ParentBridgeServer
  client: ChildBridgeClient
  teardown: () => Promise<void>
}

/** Real parent bridge server + connected child client on a fresh mkdtemp socket. */
async function startBridge(handlers: ParentBridgeHandlers): Promise<BridgeHarness> {
  const dir = mkdtempSync(join(tmpdir(), 'bridge-test-'))
  const socketPath = join(dir, 'rpc.sock')
  const server = startParentBridgeServer(handlers, socketPath)
  await server.ready
  const client = await connectChildBridge(socketPath)
  return {
    dir,
    socketPath,
    server,
    client,
    teardown: async () => {
      client.close()
      await server.close()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

describe('parent↔child bridge round-trip (P2-T8b)', () => {
  it(
    'bridged requestToolCall returns the handler result verbatim; trackEvent resolves',
    async () => {
      const bridge = await startBridge({
        requestToolCall: async (p) => ({ echo: p }),
        trackEvent: async () => null,
      })
      try {
        const deps = buildBridgedChildDeps(bridge.client)
        const result = await withTimeout(
          deps.requestToolCall({ payload: 1 } as never),
          CALL_BUDGET_MS,
          'requestToolCall round-trip',
        )
        expect(result as Record<string, unknown>).toEqual({
          echo: { payload: 1 },
        })
        const fireAndForget = deps.trackEvent({ name: 'probe' } as never)
        await withTimeout(
          Promise.resolve(fireAndForget),
          CALL_BUDGET_MS,
          'trackEvent fire-and-forget',
        )
      } finally {
        await bridge.teardown()
      }
    },
  )

  it(
    'handler throw: arrives child-side as a rejection carrying the thrown text (no hang)',
    async () => {
      const bridge = await startBridge({
        requestToolCall: async () => {
          throw new Error('boom-explosive')
        },
      })
      try {
        const deps = buildBridgedChildDeps(bridge.client)
        const outcome = await settleWithin(
          deps.requestToolCall({} as never),
          CALL_BUDGET_MS,
        )
        expect(outcome.kind).toBe('rejected')
        if (outcome.kind !== 'rejected') return
        expect(String((outcome.error as Error).message)).toContain(
          'boom-explosive',
        )
      } finally {
        await bridge.teardown()
      }
    },
  )

  it(
    'SYNCHRONOUS handler throw: a structured error reply, the socket stays usable (never an uncaught parent crash)',
    async () => {
      const bridge = await startBridge({
        requestToolCall: () => {
          // Sync throw BEFORE any promise exists — the shape
          // promptAiSdkStructured's convertJsonSchemaToZod rejection takes.
          throw new Error('boom-sync')
        },
        trackEvent: async () => null,
      })
      try {
        const deps = buildBridgedChildDeps(bridge.client)
        const outcome = await settleWithin(
          deps.requestToolCall({} as never),
          CALL_BUDGET_MS,
        )
        expect(outcome.kind).toBe('rejected')
        if (outcome.kind !== 'rejected') return
        expect(String((outcome.error as Error).message)).toContain('boom-sync')
        // The parent never destroyed the socket: a follow-up request still
        // round-trips (the sync throw was encoded, not fatal).
        const followUp = await withTimeout(
          bridge.client.call('trackEvent', { after: 'sync-throw' }),
          CALL_BUDGET_MS,
          'post-sync-throw follow-up',
        )
        expect(followUp).toBeNull()
      } finally {
        await bridge.teardown()
      }
    },
  )

  it(
    'unknown method (outside BRIDGE_METHODS): a structured unknown-bridge-method failure, not a crash',
    async () => {
      expect(BRIDGE_METHODS).toContain('requestToolCall')
      const bridge = await startBridge({})
      try {
        const outcome = await settleWithin(
          bridge.client.call('not-a-real-method' as unknown as BridgeMethod, {}),
          CALL_BUDGET_MS,
        )
        expect(outcome.kind).toBe('rejected')
        if (outcome.kind !== 'rejected') return
        expect(String((outcome.error as Error).message)).toContain(
          'unknown bridge method',
        )
      } finally {
        await bridge.teardown()
      }
    },
  )

  it(
    'markers: logger/signal markers rehydrate into live parent values; functions are dropped',
    async () => {
      // Marker REHYDRATION lives inside buildSupervisedBridgeHandlers'
      // rehydrateParams, so the test must go through the built handler table
      // (a raw handler table would only ever see the raw wire markers).
      let captured: unknown
      const deps = {
        requestToolCall: (p: unknown) => {
          captured = p
          return Promise.resolve(null)
        },
        trackEvent: async () => null,
        fetch: globalThis.fetch,
        apiKey: 'test-key',
      } as unknown as SupervisedBridgeHandlerDeps
      const table = buildSupervisedBridgeHandlers(deps)
      const bridge = await startBridge(table)
      // The per-table nonce rides on the built table (collision-proof
      // sentinel): the child stamps markers with it, the parent rehydrates
      // ONLY exact matches.
      const nonce = table.bridgeNonce
      try {
        const childDeps = buildBridgedChildDeps(bridge.client, { bridgeNonce: nonce })
        await withTimeout(
          childDeps.requestToolCall({
            logger: createBridgeWireMarker('logger', nonce),
            signal: createBridgeWireMarker('signal', nonce),
            onHook: () => {},
          } as never),
          CALL_BUDGET_MS,
          'marker rehydration round-trip',
        )
        const params = (captured ?? {}) as Record<string, unknown>
        const logger = params.logger as Record<string, unknown>
        expect(typeof logger.debug).toBe('function')
        expect(typeof logger.info).toBe('function')
        expect(typeof logger.warn).toBe('function')
        expect(typeof logger.error).toBe('function')
        expect(params.signal instanceof AbortSignal).toBe(true)
        expect(params.onHook).toBeUndefined()
      } finally {
        await bridge.teardown()
      }
    },
  )

  it(
    'collision-proof sentinel: agent-authored __openbuffBridge-keyed params (legacy shape or a forged nonce) cross the bridge verbatim — never substituted with live values',
    async () => {
      // The finding: markers were recognized by CONTENT alone, so any
      // agent-authored param member carrying the key was silently substituted
      // parent-side. The nonce-stamped sentinel fixes exactly this.
      let captured: unknown
      const deps = {
        requestToolCall: (p: unknown) => {
          captured = p
          return Promise.resolve(null)
        },
        trackEvent: async () => null,
        fetch: globalThis.fetch,
        apiKey: 'test-key',
      } as unknown as SupervisedBridgeHandlerDeps
      const table = buildSupervisedBridgeHandlers(deps)
      const bridge = await startBridge(table)
      const agentAuthored = {
        logger: BRIDGE_LOGGER_MARKER,
        signal: { __openbuffBridge: 'signal', nonce: 'forged-by-the-agent' },
        payload: { __openbuffBridge: 'logger', nonce: table.bridgeNonce, extra: 'keep-me' },
      }
      try {
        const childDeps = buildBridgedChildDeps(bridge.client, {
          bridgeNonce: table.bridgeNonce,
        })
        await withTimeout(
          childDeps.requestToolCall(agentAuthored as never),
          CALL_BUDGET_MS,
          'collision immunity round-trip',
        )
        // EVERY member arrives verbatim: the legacy content-only logger
        // marker, the forged-nonce signal, and even the exact-nonce object
        // that ALSO carries agent-authored extra data (not a pure marker).
        expect(captured).toEqual(agentAuthored)
      } finally {
        await bridge.teardown()
      }
    },
  )

  it(
    'sendAction markers: nested logger/signal wire markers rehydrate into live parent values (no marker garbage reaches the real dep)',
    async () => {
      let captured: unknown
      const deps = {
        sendAction: (p: unknown) => {
          captured = p
          return Promise.resolve(null)
        },
        trackEvent: async () => null,
        fetch: globalThis.fetch,
        apiKey: 'test-key',
      } as unknown as SupervisedBridgeHandlerDeps
      const table = buildSupervisedBridgeHandlers(deps)
      const bridge = await startBridge(table)
      try {
        const childDeps = buildBridgedChildDeps(bridge.client, {
          bridgeNonce: table.bridgeNonce,
        })
        // The CHILD sanitizer converts a live logger-like object and a live
        // AbortSignal into nonce-stamped wire markers; the parent must
        // rehydrate them (exact nonce match) before the REAL sendAction dep
        // sees the params.
        childDeps.sendAction({
          command: 'probe',
          logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
          signal: new AbortController().signal,
        } as never)
        await withTimeout(Bun.sleep(100), CALL_BUDGET_MS, 'sendAction notify delivery')
        const params = (captured ?? {}) as Record<string, unknown>
        expect(params.command).toBe('probe')
        const logger = params.logger as Record<string, unknown>
        expect(typeof logger.debug).toBe('function')
        expect(params.signal instanceof AbortSignal).toBe(true)
        expect(params.logger).not.toEqual(BRIDGE_LOGGER_MARKER)
        expect(params.signal).not.toEqual(BRIDGE_SIGNAL_MARKER)
        expect(params.logger).not.toEqual(createBridgeWireMarker('logger', table.bridgeNonce))
      } finally {
        await bridge.teardown()
      }
    },
  )

  it(
    'LEGACY full-collection promptAiSdkStream stays BYTE-IDENTICAL (P2-T8c): a stream past BRIDGE_MAX_STREAM_CHUNKS_BYTES truncates (truncated: true) and still returns the result — driven through a PARTIAL table so the child wrapper exercises its REAL fallback',
    async () => {
      // 14 chunks of ~1 MiB each: aggregate 14 MiB > the 12 MiB budget, but
      // the single reply must still encode under the 16 MiB message cap.
      // The REAL collectPromptStream runs UNCHANGED behind a PARTIAL handler
      // table that supplies ONLY the legacy full-collection method (exactly
      // the pre-incremental surface): the child wrapper first attempts the
      // incremental start, receives the parent's structured missing-method
      // error, and falls back through isIncrementalStreamUnsupportedError —
      // so this one test pins BOTH the unchanged legacy truncation behavior
      // AND the child's fallback wiring end-to-end.
      const chunkText = 'x'.repeat(1024 * 1024)
      const deps = {
        promptAiSdkStream: async function* () {
          for (let i = 0; i < 14; i++) {
            yield { type: 'text', text: chunkText }
          }
          return { aborted: false, value: 'done' }
        },
        trackEvent: async () => null,
        fetch: globalThis.fetch,
        apiKey: 'test-key',
      } as unknown as SupervisedBridgeHandlerDeps
      const full = buildSupervisedBridgeHandlers(deps)
      const partialTable: ParentBridgeHandlers = {
        promptAiSdkStream: full.promptAiSdkStream,
        trackEvent: full.trackEvent,
      }
      const bridge = await startBridge(partialTable)
      try {
        const childDeps = buildBridgedChildDeps(bridge.client)
        const generator = childDeps.promptAiSdkStream({} as never)
        let delivered = 0
        for (;;) {
          const next = await withTimeout(
            generator.next(),
            CALL_BUDGET_MS,
            'stream chunk delivery',
          )
          if (next.done) {
            expect((next.value as { value?: unknown }).value).toBe('done')
            break
          }
          delivered += 1
        }
        // The pre-budget chunks were delivered; the over-budget tail was
        // dropped (bounded, loud), and the reply still encoded (the child got
        // the final result instead of a fail-closed socket destroy).
        expect(delivered).toBeGreaterThan(0)
        expect(delivered).toBeLessThan(14)
        // Aggregate delivered bytes stayed within the stream budget.
        expect(delivered * (chunkText.length + 32)).toBeLessThanOrEqual(
          BRIDGE_MAX_STREAM_CHUNKS_BYTES,
        )
      } finally {
        await bridge.teardown()
      }
    },
  )

  it(
    'bridged requestFiles forwards capabilityIssuer verbatim so the parent mints cap.v3 editAnchors (child-minted-cap-v3 repair)',
    async () => {
      let captured: unknown
      const capabilityIssuer = { projectId: '/test/project', runId: 'run-1' }
      const bridge = await startBridge({
        requestFiles: async (p) => {
          captured = p
          return { results: [] }
        },
        trackEvent: async () => null,
      })
      try {
        const deps = buildBridgedChildDeps(bridge.client)
        await withTimeout(
          deps.requestFiles({ filePaths: ['src/a.ts'], capabilityIssuer } as never),
          CALL_BUDGET_MS,
          'requestFiles round-trip',
        )
        // The issuer ({ projectId, runId }) is JSON-serializable and crosses
        // the bridge verbatim: the parent's real requestFiles mints cap.v3
        // editAnchors over the content it actually read, and the child's
        // read_files handler re-mints them with its own in-process HMAC key
        // (a cap.v3 token is verifiable only where minted) — so
        // capability-bearing edits no longer loop on 'fresh_read_required'.
        expect(captured).toMatchObject({
          filePaths: ['src/a.ts'],
          capabilityIssuer,
        })
      } finally {
        await bridge.teardown()
      }
    },
  )

  it(
    'server close() cancels the in-flight promptAiSdkStream: the provider iterator is torn down (finally runs) and its rehydrated signal aborted (stream-iterator-not-cancelled-on-bridge-close repair)',
    async () => {
      let consumedFirst = false
      let finallyRan = false
      let providerSignalAborted = false
      const deps = {
        promptAiSdkStream: async function* (params: unknown) {
          const signal = (params as { signal?: AbortSignal }).signal
          signal?.addEventListener('abort', () => {
            providerSignalAborted = true
          })
          try {
            yield { type: 'text', text: 'chunk-1' }
            consumedFirst = true
            // Park like a provider stream blocked mid-chunk: without the
            // close-cancel teardown this generator never finishes and the
            // collector keeps buffering with no consumer.
            await new Promise<never>((_, reject) => {
              const onAbort = () => reject(new Error('provider stream aborted'))
              if (signal?.aborted) onAbort()
              else signal?.addEventListener('abort', onAbort, { once: true })
            })
            yield { type: 'text', text: 'never-delivered' }
            return { aborted: false, value: 'done' }
          } finally {
            finallyRan = true
          }
        },
        trackEvent: async () => null,
        fetch: globalThis.fetch,
        apiKey: 'test-key',
      } as unknown as SupervisedBridgeHandlerDeps
      const table = buildSupervisedBridgeHandlers(deps)
      const bridge = await startBridge(table)
      try {
        const childDeps = buildBridgedChildDeps(bridge.client, {
          bridgeNonce: table.bridgeNonce,
        })
        const generator = childDeps.promptAiSdkStream({} as never)
        // Drive the INCREMENTAL path: the first next() starts the stream and
        // pulls exactly ONE provider chunk (chunk-1), suspending the provider
        // generator at its first yield.
        const first = await withTimeout(
          generator.next(),
          CALL_BUDGET_MS,
          'first incremental chunk',
        )
        expect((first.value as { text?: string }).text).toBe('chunk-1')
        // A second next() resumes the provider generator PAST the first yield
        // (so consumedFirst flips) and parks it mid-chunk — this pull never
        // resolves until close() tears the stream down.
        const pending = generator.next()
        pending.catch(() => {}) // closed-bridge rejection is expected, never unhandled
        await withTimeout(
          waitFor(
            () => consumedFirst,
            CALL_BUDGET_MS,
            'parent collector consumed the first provider chunk',
          ),
          CALL_BUDGET_MS,
          'parent collector consumed the first provider chunk',
        )
        // close() kills the pending handler via the killed race AND must
        // cancel the underlying provider iterator (the structural
        // cancelInFlightStreams probe fires before the pending rejects).
        await withTimeout(bridge.server.close(), CALL_BUDGET_MS, 'server close')
        await withTimeout(
          waitFor(
            () => finallyRan,
            CALL_BUDGET_MS,
            'provider generator finally block',
          ),
          CALL_BUDGET_MS,
          'provider generator finally block',
        )
        // The generator's finally ran (the in-process consumer-early-return
        // teardown parity) and the rehydrated signal was aborted, so a
        // provider blocked mid-chunk stops producing (spend stops).
        expect(finallyRan).toBe(true)
        expect(providerSignalAborted).toBe(true)
      } finally {
        await bridge.teardown()
      }
    },
  )
})

describe('bridge fail-closed behavior (P2-T8b)', () => {
  it(
    'malformed line from the child: the server destroys the connection promptly',
    async () => {
      const bridge = await startBridge({})
      try {
        const raw = net.connect({ path: bridge.socketPath })
        await withTimeout(
          new Promise<void>((resolve) => raw.once('connect', () => resolve())),
          CALL_BUDGET_MS,
          'raw socket connect',
        )
        raw.write('not json\n')
        const outcome = await settleWithin(
          new Promise<void>((resolve) => raw.once('close', () => resolve())),
          CALL_BUDGET_MS,
        )
        expect(outcome.kind).toBe('resolved')
        raw.destroy()
      } finally {
        await bridge.teardown()
      }
    },
  )

  it(
    'malformed line from the parent: subsequent client calls reject promptly (fail-closed)',
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'bridge-test-'))
      const socketPath = join(dir, 'rpc.sock')
      // A stand-in parent that greets every connection with garbage: the
      // client must fail closed promptly instead of hanging on a reply.
      const fakeParent = net.createServer((socket) => {
        socket.write('not json\n')
      })
      await withTimeout(
        new Promise<void>((resolve) => fakeParent.listen(socketPath, resolve)),
        CALL_BUDGET_MS,
        'fake parent listen',
      )
      try {
        const client = await connectChildBridge(socketPath)
        const outcome = await settleWithin(
          client.call('trackEvent', {}),
          CALL_BUDGET_MS,
        )
        expect(outcome.kind).toBe('rejected')
        if (outcome.kind !== 'rejected') return
        // Fail-closed either way: the garbage line itself surfaces as a
        // 'malformed' BridgeProtocolError, while a call that arrives after
        // the socket already died rejects with the typed BridgeClosedError.
        const message = String((outcome.error as Error).message)
        expect(
          message.includes('malformed') || message.includes('closed'),
        ).toBe(true)
      } finally {
        fakeParent.close()
        rmSync(dir, { recursive: true, force: true })
      }
    },
  )

  it(
    'close(): unlinks the socket file and subsequent calls reject promptly',
    async () => {
      const bridge = await startBridge({ trackEvent: async () => null })
      try {
        expect(existsSync(bridge.socketPath)).toBe(true)
        await withTimeout(bridge.server.close(), CALL_BUDGET_MS, 'server close')
        expect(existsSync(bridge.socketPath)).toBe(false)
        const outcome = await settleWithin(
          bridge.client.call('trackEvent', {}),
          CALL_BUDGET_MS,
        )
        expect(outcome.kind).toBe('rejected')
        if (outcome.kind !== 'rejected') return
        expect(outcome.error instanceof BridgeClosedError).toBe(true)
      } finally {
        bridge.client.close()
        rmSync(bridge.dir, { recursive: true, force: true })
      }
    },
  )
})

/** Polls `check` every 10ms until it returns true or the budget expires. */
async function waitFor(
  check: () => boolean,
  ms: number,
  label: string,
): Promise<void> {
  const deadline = Date.now() + ms
  while (!check()) {
    if (Date.now() > deadline) {
      throw new Error(`${label} timed out after ${ms}ms — a bridge bug would hang here`)
    }
    await Bun.sleep(10)
  }
}

describe('fire-and-forget notify budget (P2-T8b notify-drop repair)', () => {
  it(
    'notify saturation: the overflowing notification gets a structured bridge_notify_overflow failure reply while request traffic keeps its own budget',
    async () => {
      // A handler that parks briefly keeps 128 notifications in flight long
      // enough for the 129th to hit the bounded notify budget.
      const bridge = await startBridge({
        trackEvent: async () => {
          await Bun.sleep(50)
          return null
        },
      })
      try {
        const raw = net.connect({ path: bridge.socketPath })
        await withTimeout(
          new Promise<void>((resolve) => raw.once('connect', () => resolve())),
          CALL_BUDGET_MS,
          'raw socket connect',
        )
        const replies: Array<{ id: string; ok: boolean; error?: { message: string } }> = []
        let buffer = ''
        raw.on('data', (chunk) => {
          buffer += chunk.toString('utf8')
          for (;;) {
            const newlineIndex = buffer.indexOf('\n')
            if (newlineIndex === -1) break
            const line = buffer.slice(0, newlineIndex)
            buffer = buffer.slice(newlineIndex + 1)
            if (line.length > 0) replies.push(JSON.parse(line))
          }
        })
        // Fire exactly one more fire-and-forget notification than the
        // dedicated notify budget allows, PLUS a normal request in the same
        // saturation window.
        const notifyCount = MAX_CONCURRENT_BRIDGE_NOTIFIES + 1
        for (let i = 0; i < notifyCount; i++) {
          raw.write(
            encodeBridgeMessage({
              id: `notify-trackEvent-${i}`,
              method: 'trackEvent',
              params: { n: i },
            }),
          )
        }
        raw.write(
          encodeBridgeMessage({
            id: 'rpc-1',
            method: 'trackEvent',
            params: { probe: 'request-budget' },
          }),
        )
        await withTimeout(
          waitFor(() => replies.length >= notifyCount + 1, CALL_BUDGET_MS, 'notify-budget replies'),
          CALL_BUDGET_MS,
          'notify-budget replies',
        )
        // Exactly ONE structured overflow failure — never a silent drop.
        const failures = replies.filter((reply) => !reply.ok)
        expect(failures).toHaveLength(1)
        expect(failures[0]?.error?.message).toContain('bridge_notify_overflow')
        // The request path is unaffected by notify saturation (separate budgets).
        const requestReply = replies.find((reply) => reply.id === 'rpc-1')
        expect(requestReply?.ok).toBe(true)
        raw.destroy()
      } finally {
        await bridge.teardown()
      }
    },
  )

  it(
    'a failure reply to a fire-and-forget notify is logged LOUDLY on stderr, never silently swallowed',
    async () => {
      const bridge = await startBridge({
        trackEvent: async () => {
          throw new Error('notify-nope')
        },
      })
      const stderrChunks: string[] = []
      const realWrite = process.stderr.write.bind(process.stderr)
      const stubWrite = ((...args: Parameters<typeof process.stderr.write>) => {
        stderrChunks.push(String(args[0]))
        return realWrite(...(args as Parameters<typeof realWrite>))
      }) as typeof process.stderr.write
      process.stderr.write = stubWrite
      try {
        const deps = buildBridgedChildDeps(bridge.client)
        deps.trackEvent({ name: 'probe' } as never)
        await withTimeout(
          Bun.sleep(100),
          CALL_BUDGET_MS,
          'notify failure propagation',
        )
        const stderr = stderrChunks.join('')
        expect(stderr).toContain('bridge notify failure')
        expect(stderr).toContain('notify-nope')
      } finally {
        process.stderr.write = realWrite
        await bridge.teardown()
      }
    },
  )
})

describe('ndjson framing primitives (P2-T8b)', () => {
  it('encodeBridgeMessage: a string past the 16 MiB cap throws oversized', () => {
    const oversized = 'x'.repeat(BRIDGE_MAX_MESSAGE_BYTES + 1)
    expect(() => encodeBridgeMessage(oversized)).toThrow(BridgeProtocolError)
    try {
      encodeBridgeMessage(oversized)
      expect.unreachable()
    } catch (error) {
      expect((error as BridgeProtocolError).kind).toBe('oversized')
    }
  })

  it('encodeBridgeMessage: a non-JSON-serializable value throws malformed', () => {
    expect(() => encodeBridgeMessage(BigInt(1))).toThrow(BridgeProtocolError)
    try {
      encodeBridgeMessage(BigInt(1))
      expect.unreachable()
    } catch (error) {
      expect((error as BridgeProtocolError).kind).toBe('malformed')
    }
  })

  it('createNdjsonLineReader: emits one onLine per complete line in a single chunk', () => {
    const lines: string[] = []
    const protocolErrors: BridgeProtocolError[] = []
    const reader = createNdjsonLineReader({
      onLine: (line) => lines.push(line),
      onProtocolError: (error) => protocolErrors.push(error),
    })
    reader(new TextEncoder().encode('a\nb\n'))
    expect(lines).toEqual(['a', 'b'])
    expect(protocolErrors).toHaveLength(0)
  })

  it('createNdjsonLineReader: buffers a partial line and emits it on the completion chunk', () => {
    const lines: string[] = []
    const reader = createNdjsonLineReader({
      onLine: (line) => lines.push(line),
      onProtocolError: () => {},
    })
    reader(new TextEncoder().encode('ab'))
    expect(lines).toEqual([])
    reader(new TextEncoder().encode('c\n'))
    expect(lines).toEqual(['abc'])
  })

  it('createNdjsonLineReader: fires onProtocolError for a line beyond the cap', () => {
    const protocolErrors: BridgeProtocolError[] = []
    const reader = createNdjsonLineReader({
      onLine: () => {},
      onProtocolError: (error) => protocolErrors.push(error),
    })
    reader(new TextEncoder().encode(`${'x'.repeat(BRIDGE_MAX_MESSAGE_BYTES + 1)}\n`))
    expect(protocolErrors).toHaveLength(1)
    expect(protocolErrors[0].kind).toBe('oversized')
  })
})

describe('missingChildCallbackDeps gate (P2-T8b)', () => {
  it('a request without rpcSocketPath reports every callback dep missing', () => {
    const request: SupervisedSpawnRequest = {
      agentType: 'thinker',
      prompt: 'Probe',
      spawnParams: undefined,
    }
    const missing = missingChildCallbackDeps(request)
    expect(missing.length).toBeGreaterThan(0)
    expect(missing).toContain('promptAiSdkStream')
  })

  it('a request with rpcSocketPath supplies the full bridged set (empty missing list)', () => {
    const request: SupervisedSpawnRequest = {
      agentType: 'thinker',
      prompt: 'Probe',
      spawnParams: undefined,
      rpcSocketPath: '/tmp/x.sock',
    }
    expect(missingChildCallbackDeps(request)).toEqual([])
  })
})

describe('bridged promptAiSdkStructured schema conversion (fail-closed, P2-T8b)', () => {
  it('toBridgeJsonSchema: an unrepresentable zod schema THROWS instead of silently widening to { type: "object" }', () => {
    // z.toJSONSchema throws for z.date() (unrepresentable in JSON Schema) —
    // the exact input the removed try/catch fallback used to swallow.
    expect(() => toBridgeJsonSchema(z.date())).toThrow()
  })

  it('toBridgeJsonSchema: a representable zod schema still converts (happy path intact)', () => {
    const converted = toBridgeJsonSchema(z.object({ ok: z.boolean() }))
    expect(converted).toMatchObject({ type: 'object' })
    // Not the permissive widening fallback: the real properties survive.
    expect(converted).not.toEqual({ type: 'object' })
  })

  it('bridged promptAiSdkStructured REJECTS when the zod schema cannot be converted; the parent handler is never reached', async () => {
    const structuredCalls: unknown[] = []
    const bridge = await startBridge({
      promptAiSdkStructured: async (params) => {
        structuredCalls.push(params)
        return { aborted: false, value: {} }
      },
      trackEvent: async () => null,
    })
    try {
      const deps = buildBridgedChildDeps(bridge.client)
      const outcome = await settleWithin(
        deps.promptAiSdkStructured({
          apiKey: 'test-key',
          runId: 'run-1',
          messages: [],
          schema: z.date(),
          clientSessionId: 'cs-1',
          fingerprintId: 'fp-1',
          userInputId: 'ui-1',
          userId: undefined,
        } as never),
        CALL_BUDGET_MS,
      )
      expect(outcome.kind).toBe('rejected')
      // Fail-closed: no widened `{ type: 'object' }` ever crossed the wire.
      expect(structuredCalls).toHaveLength(0)
    } finally {
      await bridge.teardown()
    }
  })

  it('bridged promptAiSdkStructured: a representable zod schema crosses as real JSON Schema (never the widened fallback)', async () => {
    const bridge = await startBridge({
      promptAiSdkStructured: async (params) => params,
      trackEvent: async () => null,
    })
    try {
      const deps = buildBridgedChildDeps(bridge.client)
      const result = (await withTimeout(
        deps.promptAiSdkStructured({
          apiKey: 'test-key',
          runId: 'run-1',
          messages: [],
          schema: z.object({ ok: z.boolean() }),
          clientSessionId: 'cs-1',
          fingerprintId: 'fp-1',
          userInputId: 'ui-1',
          userId: undefined,
        } as never),
        CALL_BUDGET_MS,
        'structured happy path',
      )) as unknown as { schema: Record<string, unknown> }
      expect(result.schema).toMatchObject({ type: 'object' })
      expect(result.schema).not.toEqual({ type: 'object' })
    } finally {
      await bridge.teardown()
    }
  })

  it('parent handler: promptAiSdkStructured wire params WITHOUT a schema throw (never widen to { type: "object" })', () => {
    const structuredCalls: unknown[] = []
    const deps = {
      promptAiSdkStructured: async (params: unknown) => {
        structuredCalls.push(params)
        return { aborted: false, value: {} }
      },
      trackEvent: async () => null,
      apiKey: 'test-key',
    } as unknown as SupervisedBridgeHandlerDeps
    const handlers = buildSupervisedBridgeHandlers(deps)
    expect(() =>
      (handlers.promptAiSdkStructured as (params: unknown) => unknown)({}),
    ).toThrow(/JSON Schema/)
    expect(structuredCalls).toHaveLength(0)
  })
})

describe('bridged serialization fail-closed (structured re-validation + fetch body)', () => {
  it(
    'bridged promptAiSdkStructured: a schema-violating parent reply REJECTS with a clear authored-schema message (JSON-Schema round trip drops refinements/transforms)',
    async () => {
      // The parent handler IGNORES the requested schema entirely and returns
      // a value that violates the schema the child authored — exactly the
      // silent divergence the zod→JSON-Schema→zod round trip can produce.
      const bridge = await startBridge({
        promptAiSdkStructured: async () => ({
          aborted: false,
          value: { wrong: 'shape' },
        }),
        trackEvent: async () => null,
      })
      try {
        const deps = buildBridgedChildDeps(bridge.client)
        const outcome = await settleWithin(
          deps.promptAiSdkStructured({
            apiKey: 'test-key',
            runId: 'run-1',
            messages: [],
            schema: z.object({ ok: z.boolean() }),
            clientSessionId: 'cs-1',
            fingerprintId: 'fp-1',
            userInputId: 'ui-1',
            userId: undefined,
          } as never),
          CALL_BUDGET_MS,
        )
        expect(outcome.kind).toBe('rejected')
        if (outcome.kind !== 'rejected') return
        expect(String((outcome.error as Error).message)).toContain(
          'violates the authored schema',
        )
      } finally {
        await bridge.teardown()
      }
    },
  )

  it(
    'bridged promptAiSdkStructured: a conforming parent reply passes re-validation and the value is parsed through the authored schema',
    async () => {
      const bridge = await startBridge({
        promptAiSdkStructured: async () => ({
          aborted: false,
          value: { ok: true },
        }),
        trackEvent: async () => null,
      })
      try {
        const deps = buildBridgedChildDeps(bridge.client)
        const result = await withTimeout(
          deps.promptAiSdkStructured({
            apiKey: 'test-key',
            runId: 'run-1',
            messages: [],
            schema: z.object({ ok: z.boolean() }),
            clientSessionId: 'cs-1',
            fingerprintId: 'fp-1',
            userInputId: 'ui-1',
            userId: undefined,
          } as never),
          CALL_BUDGET_MS,
          'structured re-validation happy path',
        )
        expect((result as { value?: unknown }).value).toEqual({ ok: true })
      } finally {
        await bridge.teardown()
      }
    },
  )

  it(
    'bridged fetch: a non-string init.body (binary/FormData) REJECTS with a fail-closed message BEFORE any network call',
    async () => {
      let fetchCalls = 0
      const bridge = await startBridge({
        fetch: async () => {
          fetchCalls += 1
          return { status: 200, statusText: 'OK', headers: {}, bodyText: '' }
        },
        trackEvent: async () => null,
      })
      try {
        const deps = buildBridgedChildDeps(bridge.client)
        for (const body of [new Uint8Array([1, 2, 3]), new FormData()]) {
          const outcome = await settleWithin(
            deps.fetch('https://example.invalid/upload', {
              method: 'POST',
              body,
            }),
            CALL_BUDGET_MS,
          )
          expect(outcome.kind).toBe('rejected')
          if (outcome.kind !== 'rejected') return
          expect(String((outcome.error as Error).message)).toContain(
            'non-string init.body',
          )
        }
        // Fail-closed BEFORE the wire: the parent fetch handler was never
        // invoked — no bodyless request ever crossed the bridge.
        expect(fetchCalls).toBe(0)
      } finally {
        await bridge.teardown()
      }
    },
  )
})

describe('bridged Date params + result round-trip safety (serialization repair)', () => {
  it(
    'bridged addAgentStep: a live Date startTime crosses the nonce-stamped date marker and the parent real dep receives a live Date (never {})',
    async () => {
      // The finding: Object.entries of a Date has no own enumerable
      // properties, so the plain-object sanitize walk delivered `{}` where
      // the in-process path delivers AddAgentStepFn's required
      // `startTime: Date`.
      let captured: unknown
      const deps = {
        addAgentStep: (p: unknown) => {
          captured = p
          return Promise.resolve(null)
        },
        trackEvent: async () => null,
        fetch: globalThis.fetch,
        apiKey: 'test-key',
      } as unknown as SupervisedBridgeHandlerDeps
      const table = buildSupervisedBridgeHandlers(deps)
      const bridge = await startBridge(table)
      const startTime = new Date('2024-01-15T10:30:00.000Z')
      try {
        const childDeps = buildBridgedChildDeps(bridge.client, {
          bridgeNonce: table.bridgeNonce,
        })
        await withTimeout(
          childDeps.addAgentStep({
            apiKey: 'child-key',
            agentRunId: 'ar-1',
            stepNumber: 1,
            startTime,
          } as never),
          CALL_BUDGET_MS,
          'addAgentStep Date round-trip',
        )
        const params = (captured ?? {}) as Record<string, unknown>
        // The parent's REAL dep receives a live Date carrying the same
        // instant — never the `{}` the plain-object walk alone produces.
        expect(params.startTime instanceof Date).toBe(true)
        expect((params.startTime as Date).getTime()).toBe(startTime.getTime())
      } finally {
        await bridge.teardown()
      }
    },
  )

  it(
    'no-nonce legacy wire: a live Date crosses as its ISO string data (the JSON.stringify-native shape), never {}',
    async () => {
      let captured: unknown
      const bridge = await startBridge({
        addAgentStep: async (p) => {
          captured = p
          return null
        },
        trackEvent: async () => null,
      })
      const startTime = new Date('2024-06-01T00:00:00.000Z')
      try {
        const deps = buildBridgedChildDeps(bridge.client)
        await withTimeout(
          deps.addAgentStep({ startTime } as never),
          CALL_BUDGET_MS,
          'no-nonce Date round-trip',
        )
        // Without a nonce no parent rehydrates anything: the ISO string
        // JSON.stringify renders natively crosses as data (and is NEVER the
        // `{}` the old sanitizer silently produced).
        expect((captured as Record<string, unknown>).startTime).toBe(
          startTime.toISOString(),
        )
      } finally {
        await bridge.teardown()
      }
    },
  )

  it(
    "date-marker collision immunity: agent-authored __openbuffBridge:'date' objects (forged nonce, extra members, non-string iso) cross verbatim — never rehydrated into a Date",
    async () => {
      let captured: unknown
      const deps = {
        requestToolCall: (p: unknown) => {
          captured = p
          return Promise.resolve(null)
        },
        trackEvent: async () => null,
        fetch: globalThis.fetch,
        apiKey: 'test-key',
      } as unknown as SupervisedBridgeHandlerDeps
      const table = buildSupervisedBridgeHandlers(deps)
      const bridge = await startBridge(table)
      const agentAuthored = {
        forged: createBridgeDateWireMarker(new Date(0), 'forged-by-the-agent'),
        extraMembers: {
          __openbuffBridge: 'date',
          nonce: table.bridgeNonce,
          iso: new Date(0).toISOString(),
          extra: 'keep-me',
        },
        badIso: { __openbuffBridge: 'date', nonce: table.bridgeNonce, iso: 123 },
      }
      try {
        const childDeps = buildBridgedChildDeps(bridge.client, {
          bridgeNonce: table.bridgeNonce,
        })
        await withTimeout(
          childDeps.requestToolCall(agentAuthored as never),
          CALL_BUDGET_MS,
          'date-marker collision round-trip',
        )
        // EVERY member arrives verbatim as DATA — none became a live Date.
        expect(captured).toEqual(agentAuthored)
      } finally {
        await bridge.teardown()
      }
    },
  )

  it('createBridgeDateWireMarker / isBridgeDateWireMarker: exact-shape exact-nonce recognition (collision-proof sentinel)', () => {
    const nonce = 'n-1'
    const marker = createBridgeDateWireMarker(new Date(1234), nonce)
    expect(marker).toEqual({
      __openbuffBridge: 'date',
      nonce,
      iso: '1970-01-01T00:00:01.234Z',
    })
    expect(isBridgeDateWireMarker(marker, nonce)).toBe(true)
    // A mismatching nonce, an extra member, a non-string iso, or a non-object
    // value is DATA, never a recognized marker.
    expect(isBridgeDateWireMarker(marker, 'other')).toBe(false)
    expect(isBridgeDateWireMarker({ ...marker, extra: 1 }, nonce)).toBe(false)
    expect(isBridgeDateWireMarker({ ...marker, iso: 5 }, nonce)).toBe(false)
    expect(isBridgeDateWireMarker(marker.iso, nonce)).toBe(false)
  })

  it('findNonRoundTripSafeResultPaths: names function members, live zod schemas, and Dates', () => {
    const offenses = findNonRoundTripSafeResultPaths({
      handleSteps: () => {},
      inputSchema: { prompt: z.string(), params: z.object({}) },
      outputSchema: z.boolean(),
      createdAt: new Date(0),
      ok: { nested: 'plain' },
    })
    expect(
      offenses.some(
        (p) => p.includes('handleSteps') && p.includes('function-valued'),
      ),
    ).toBe(true)
    expect(
      offenses.some(
        (p) => p.includes('inputSchema.prompt') && p.includes('zod schema'),
      ),
    ).toBe(true)
    expect(
      offenses.some(
        (p) => p.includes('inputSchema.params') && p.includes('zod schema'),
      ),
    ).toBe(true)
    expect(
      offenses.some(
        (p) => p.includes('outputSchema') && p.includes('zod schema'),
      ),
    ).toBe(true)
    expect(
      offenses.some((p) => p.includes('createdAt') && p.includes('Date')),
    ).toBe(true)
    // Plain JSON-serializable members are never named.
    expect(offenses.some((p) => p.includes('ok.nested'))).toBe(false)
  })

  it('findNonRoundTripSafeResultPaths: a plain JSON-serializable result reports no offenses', () => {
    expect(
      findNonRoundTripSafeResultPaths({ a: [1, 'x', { b: null }], c: 'd' }),
    ).toEqual([])
  })

  it(
    'bridged fetchAgentFromDatabase: a template with a programmatic handleSteps or live zod inputSchema REJECTS naming the offending members (the child never receives a damaged AgentTemplate)',
    async () => {
      const damagedTemplate = {
        id: 'pub/agent@1.0.0',
        displayName: 'Damaged',
        mcpServers: {},
        toolNames: [],
        spawnableAgents: [],
        systemPrompt: 's',
        instructionsPrompt: 'i',
        stepPrompt: 'p',
        inputSchema: { prompt: z.string() },
        outputSchema: z.object({ ok: z.boolean() }),
        handleSteps: function* () {},
        includeMessageHistory: false,
        inheritParentSystemPrompt: false,
        outputMode: 'last_message',
      }
      let depCalls = 0
      // The round-trip-safety gate lives inside buildSupervisedBridgeHandlers
      // (the fetchAgentFromDatabase handler wraps deps and validates the
      // result before it crosses the wire), so the test must build the table
      // through it — a raw handler table would bypass the validator entirely.
      const supervisedDeps = {
        fetchAgentFromDatabase: async () => {
          depCalls += 1
          return damagedTemplate
        },
        trackEvent: async () => null,
        apiKey: 'test-key',
      } as unknown as SupervisedBridgeHandlerDeps
      const table = buildSupervisedBridgeHandlers(supervisedDeps)
      const bridge = await startBridge(table)
      try {
        const deps = buildBridgedChildDeps(bridge.client)
        const outcome = await settleWithin(
          deps.fetchAgentFromDatabase({
            apiKey: 'k',
            parsedAgentId: { publisherId: 'pub', agentId: 'agent' },
          } as never),
          CALL_BUDGET_MS,
        )
        expect(outcome.kind).toBe('rejected')
        if (outcome.kind !== 'rejected') return
        // The real dep ran exactly once; its result was refused AT THE WIRE,
        // not silently degraded.
        expect(depCalls).toBe(1)
        const message = String((outcome.error as Error).message)
        expect(message).toContain('not JSON-round-trip-safe')
        expect(message).toContain('handleSteps')
        expect(message).toContain('inputSchema.prompt')
        expect(message).toContain('outputSchema')
      } finally {
        await bridge.teardown()
      }
    },
  )

  it(
    'bridged fetchAgentFromDatabase: a round-trip-safe template (string-valued handleSteps, no live zod members) crosses verbatim; a null result passes through',
    async () => {
      const template = {
        id: 'pub/agent@1.0.0',
        displayName: 'Safe',
        mcpServers: {},
        toolNames: [],
        spawnableAgents: [],
        systemPrompt: 's',
        instructionsPrompt: 'i',
        stepPrompt: 'p',
        inputSchema: {},
        includeMessageHistory: false,
        inheritParentSystemPrompt: false,
        outputMode: 'last_message',
        handleSteps: 'return STEP',
      }
      let result: unknown = template
      const bridge = await startBridge({
        fetchAgentFromDatabase: async () => result,
        trackEvent: async () => null,
      })
      try {
        const deps = buildBridgedChildDeps(bridge.client)
        const returned = await withTimeout(
          deps.fetchAgentFromDatabase({
            apiKey: 'k',
            parsedAgentId: { publisherId: 'pub', agentId: 'agent' },
          } as never),
          CALL_BUDGET_MS,
          'safe template round-trip',
        )
        expect(returned as unknown as typeof template).toEqual(template)
        // A null result (agent not found) passes through untouched.
        result = null
        expect(
          await withTimeout(
            deps.fetchAgentFromDatabase({} as never),
            CALL_BUDGET_MS,
            'null template round-trip',
          ),
        ).toBeNull()
      } finally {
        await bridge.teardown()
      }
    },
  )

  it(
    'typed dep contracts are preserved across the bridge: Date params arrive as Dates, round-trip-safe results cross verbatim, unsafe results fail closed',
    async () => {
      // End-to-end pin of the bridged serialization contract over the REAL
      // socket harness (requirement: bridged serialization preserves the
      // typed dep contracts for params and results crossing the socket):
      //  1. a live Date param rehydrates into a REAL Date parent-side;
      //  2. a round-trip-safe result (string handleSteps, no live zod
      //     members) crosses verbatim;
      //  3. a result that would degrade across the JSON wire (a live Date
      //     member) is REFUSED at the wire with the established
      //     round-trip-safety error — never silently delivered damaged —
      //     and the socket stays usable after the refusal.
      let capturedParams: unknown
      const safeTemplate = {
        id: 'pub/agent@1.0.0',
        displayName: 'Safe',
        mcpServers: {},
        toolNames: [],
        spawnableAgents: [],
        systemPrompt: 's',
        instructionsPrompt: 'i',
        stepPrompt: 'p',
        inputSchema: {},
        includeMessageHistory: false,
        inheritParentSystemPrompt: false,
        outputMode: 'last_message',
        handleSteps: 'return STEP',
      }
      let templateResult: unknown = safeTemplate
      const supervisedDeps = {
        addAgentStep: (p: unknown) => {
          capturedParams = p
          return Promise.resolve(null)
        },
        fetchAgentFromDatabase: async () => templateResult,
        trackEvent: async () => null,
        fetch: globalThis.fetch,
        apiKey: 'test-key',
      } as unknown as SupervisedBridgeHandlerDeps
      const table = buildSupervisedBridgeHandlers(supervisedDeps)
      const bridge = await startBridge(table)
      const startTime = new Date(1234567)
      try {
        const childDeps = buildBridgedChildDeps(bridge.client, {
          bridgeNonce: table.bridgeNonce,
        })

        // (1) Date param: the child sanitizer stamps the nonce-stamped date
        // marker; the parent rehydrates a live Date carrying the same
        // instant — the real dep receives the typed shape the in-process
        // path supplies, never the `{}` a Date would collapse to.
        await withTimeout(
          childDeps.addAgentStep({
            apiKey: 'child-key',
            agentRunId: 'ar-1',
            stepNumber: 1,
            startTime,
          } as never),
          CALL_BUDGET_MS,
          'typed-dep Date param round-trip',
        )
        const params = (capturedParams ?? {}) as Record<string, unknown>
        expect(params.startTime instanceof Date).toBe(true)
        expect((params.startTime as Date).getTime()).toBe(1234567)

        // (2) Round-trip-safe result: a string-valued handleSteps template
        // (no live zod members) crosses verbatim.
        const returned = (await withTimeout(
          childDeps.fetchAgentFromDatabase({
            apiKey: 'k',
            parsedAgentId: { publisherId: 'pub', agentId: 'agent' },
          } as never),
          CALL_BUDGET_MS,
          'typed-dep safe template round-trip',
        )) as unknown as typeof safeTemplate
        expect(returned).toEqual(safeTemplate)

        // (3) Fail-closed result: a template carrying a live Date member
        // would degrade to an ISO string across the JSON wire, so the
        // handler REFUSES it with the established round-trip-safety error
        // naming the offending member instead of delivering damaged data.
        templateResult = { ...safeTemplate, createdAt: new Date(0) }
        const outcome = await settleWithin(
          childDeps.fetchAgentFromDatabase({
            apiKey: 'k',
            parsedAgentId: { publisherId: 'pub', agentId: 'agent' },
          } as never),
          CALL_BUDGET_MS,
        )
        expect(outcome.kind).toBe('rejected')
        if (outcome.kind !== 'rejected') return
        const message = String((outcome.error as Error).message)
        expect(message).toContain('not JSON-round-trip-safe')
        expect(message).toContain('createdAt')
        expect(message).toContain('Date')

        // Fail-closed keeps the socket usable: a subsequent null result
        // (agent not found) still passes through untouched.
        templateResult = null
        expect(
          await withTimeout(
            childDeps.fetchAgentFromDatabase({} as never),
            CALL_BUDGET_MS,
            'typed-dep post-rejection socket health',
          ),
        ).toBeNull()
      } finally {
        await bridge.teardown()
      }
    },
  )
})

describe('incremental promptAiSdkStream bridging (P2-T8c)', () => {
  it('BRIDGE_METHODS carries the additive incremental stream methods (wire-safe append; the legacy full-collection entry is untouched)', () => {
    expect(BRIDGE_METHODS).toContain('promptAiSdkStreamStart')
    expect(BRIDGE_METHODS).toContain('promptAiSdkStreamNext')
    expect(BRIDGE_METHODS).toContain('promptAiSdkStreamStop')
    expect(BRIDGE_METHODS).toContain('promptAiSdkStream')
    expect(BRIDGE_METHODS.indexOf('promptAiSdkStream')).toBeLessThan(
      BRIDGE_METHODS.indexOf('promptAiSdkStreamStart'),
    )
  })

  it('isIncrementalStreamUnsupportedError: matches ONLY the parent structured missing-method replies for promptAiSdkStreamStart/Next (the single fallback decision)', () => {
    expect(
      isIncrementalStreamUnsupportedError(
        new Error(
          'bridge method not supplied by the parent: promptAiSdkStreamStart',
        ),
      ),
    ).toBe(true)
    expect(
      isIncrementalStreamUnsupportedError(
        new Error(
          'bridge method not supplied by the parent: promptAiSdkStreamNext',
        ),
      ),
    ).toBe(true)
    // Any other structured failure is NOT a fallback trigger.
    expect(
      isIncrementalStreamUnsupportedError(
        new Error(
          'bridge method not supplied by the parent: requestToolCall',
        ),
      ),
    ).toBe(false)
    expect(
      isIncrementalStreamUnsupportedError(
        new Error(
          'too many concurrent streams: the parent bridge incremental-stream registry is capped',
        ),
      ),
    ).toBe(false)
    expect(isIncrementalStreamUnsupportedError(new Error('boom'))).toBe(false)
    expect(isIncrementalStreamUnsupportedError('raw string')).toBe(false)
  })

  it('createStreamTruncationErrorResult: a structured StreamTruncatedError-styled aborted PromptResult naming the per-reply budget (never a socket destroy)', () => {
    const result = createStreamTruncationErrorResult('stream-1', 99)
    expect(result).toMatchObject({ aborted: true })
    expect((result as { reason?: string }).reason).toContain(
      'StreamTruncatedError',
    )
    expect((result as { reason?: string }).reason).toContain(
      String(BRIDGE_MAX_STREAM_NEXT_REPLY_BYTES),
    )
  })

  it(
    'INCREMENTAL happy path: one start + one next per chunk — the child holds exactly ONE chunk while the parent has produced exactly one (no full collection), and the final PromptResult flows back',
    async () => {
      const producedOrder: string[] = []
      let produced = 0
      let gate: (() => void) | undefined
      const gatePromise = new Promise<void>((resolve) => {
        gate = resolve
      })
      const deps = {
        promptAiSdkStream: async function* () {
          produced += 1
          producedOrder.push('chunk-1')
          yield { type: 'text', text: 'chunk-1' }
          // Park until the child's probe arrives: proves the provider was
          // pulled lazily (one chunk per round trip), not fully collected
          // the way the legacy path would.
          await gatePromise
          produced += 1
          producedOrder.push('chunk-2')
          yield { type: 'text', text: 'chunk-2' }
          produced += 1
          producedOrder.push('chunk-3')
          yield { type: 'text', text: 'chunk-3' }
          return { aborted: false, value: 'done' }
        },
        requestToolCall: async () => {
          // Runs while the provider generator is parked after chunk 1.
          expect(produced).toBe(1)
          gate?.()
          return null
        },
        trackEvent: async () => null,
        fetch: globalThis.fetch,
        apiKey: 'test-key',
      } as unknown as SupervisedBridgeHandlerDeps
      const table = buildSupervisedBridgeHandlers(deps)
      const bridge = await startBridge(table)
      try {
        const childDeps = buildBridgedChildDeps(bridge.client, {
          bridgeNonce: table.bridgeNonce,
        })
        const generator = childDeps.promptAiSdkStream({} as never)
        const chunks: string[] = []
        for (;;) {
          const next = await withTimeout(
            generator.next(),
            CALL_BUDGET_MS,
            'incremental chunk delivery',
          )
          if (next.done) {
            // The done reply carried the final PromptResult — the loop's
            // result semantics are unchanged (never undefined).
            expect((next.value as { value?: unknown }).value).toBe('done')
            break
          }
          chunks.push((next.value as { text: string }).text)
          if (chunks.length === 1) {
            // While the child holds exactly ONE chunk, probe the parent: the
            // provider must NOT have been fully collected (incremental pull).
            await withTimeout(
              childDeps.requestToolCall({ probe: 'incremental' } as never),
              CALL_BUDGET_MS,
              'incrementality probe',
            )
          }
        }
        expect(chunks).toEqual(['chunk-1', 'chunk-2', 'chunk-3'])
        expect(producedOrder).toEqual(['chunk-1', 'chunk-2', 'chunk-3'])
      } finally {
        await bridge.teardown()
      }
    },
  )

  it(
    'INCREMENTAL early return: the caller breaking out of the loop sends the best-effort promptAiSdkStreamStop and the parent tears the provider stream down exactly like the legacy cancelStream (finally runs + signal aborted)',
    async () => {
      let finallyRan = false
      let providerSignalAborted = false
      const deps = {
        promptAiSdkStream: async function* (params: unknown) {
          const signal = (params as { signal?: AbortSignal }).signal
          signal?.addEventListener('abort', () => {
            providerSignalAborted = true
          })
          try {
            yield { type: 'text', text: 'chunk-1' }
            yield { type: 'text', text: 'chunk-2' }
            // Park like a provider stream blocked mid-chunk: only an
            // explicit stop can tear this down.
            await new Promise<never>((_, reject) => {
              const onAbort = () => reject(new Error('provider stream aborted'))
              if (signal?.aborted) onAbort()
              else signal?.addEventListener('abort', onAbort, { once: true })
            })
            yield { type: 'text', text: 'never-delivered' }
            return { aborted: false, value: 'done' }
          } finally {
            finallyRan = true
          }
        },
        trackEvent: async () => null,
        fetch: globalThis.fetch,
        apiKey: 'test-key',
      } as unknown as SupervisedBridgeHandlerDeps
      const table = buildSupervisedBridgeHandlers(deps)
      const bridge = await startBridge(table)
      try {
        const childDeps = buildBridgedChildDeps(bridge.client, {
          bridgeNonce: table.bridgeNonce,
        })
        const generator = childDeps.promptAiSdkStream({} as never)
        const first = await withTimeout(
          generator.next(),
          CALL_BUDGET_MS,
          'first incremental chunk',
        )
        expect((first.value as { text?: string }).text).toBe('chunk-1')
        const second = await withTimeout(
          generator.next(),
          CALL_BUDGET_MS,
          'second incremental chunk',
        )
        expect((second.value as { text?: string }).text).toBe('chunk-2')
        // The caller's early return/break: the wrapper's finally must send
        // the best-effort stop, and the parent must tear the stream down.
        await withTimeout(
          generator.return(undefined as never),
          CALL_BUDGET_MS,
          'generator early return',
        )
        await withTimeout(
          waitFor(
            () => finallyRan && providerSignalAborted,
            CALL_BUDGET_MS,
            'provider teardown (finally + abort)',
          ),
          CALL_BUDGET_MS,
          'provider teardown (finally + abort)',
        )
        expect(finallyRan).toBe(true)
        expect(providerSignalAborted).toBe(true)
      } finally {
        await bridge.teardown()
      }
    },
  )

  it(
    'INCREMENTAL oversized single chunk: the structured StreamTruncatedError-styled aborted result flows back and the socket stays usable — never an oversized-encode socket destroy',
    async () => {
      const oversizedText = 'x'.repeat(BRIDGE_MAX_STREAM_NEXT_REPLY_BYTES + 1024)
      const deps = {
        promptAiSdkStream: async function* () {
          yield { type: 'text', text: 'before-oversize' }
          yield { type: 'text', text: oversizedText }
          yield { type: 'text', text: 'never-delivered' }
          return { aborted: false, value: 'done' }
        },
        trackEvent: async () => null,
        fetch: globalThis.fetch,
        apiKey: 'test-key',
      } as unknown as SupervisedBridgeHandlerDeps
      const table = buildSupervisedBridgeHandlers(deps)
      const bridge = await startBridge(table)
      try {
        const childDeps = buildBridgedChildDeps(bridge.client, {
          bridgeNonce: table.bridgeNonce,
        })
        const generator = childDeps.promptAiSdkStream({} as never)
        const first = await withTimeout(
          generator.next(),
          CALL_BUDGET_MS,
          'chunk before oversize',
        )
        expect((first.value as { text?: string }).text).toBe(
          'before-oversize',
        )
        const last = await withTimeout(
          generator.next(),
          CALL_BUDGET_MS,
          'oversized chunk reply',
        )
        expect(last.done).toBe(true)
        expect((last.value as { aborted?: boolean }).aborted).toBe(true)
        expect((last.value as { reason?: string }).reason).toContain(
          'StreamTruncatedError',
        )
        // The socket was never destroyed (the failure was encoded, not fatal):
        // a fresh stream still round-trips through the SAME connection.
        const generator2 = childDeps.promptAiSdkStream({} as never)
        const again = await withTimeout(
          generator2.next(),
          CALL_BUDGET_MS,
          'post-truncation socket health',
        )
        expect((again.value as { text?: string }).text).toBe('before-oversize')
        await withTimeout(
          generator2.return(undefined as never),
          CALL_BUDGET_MS,
          'post-truncation early return',
        )
      } finally {
        await bridge.teardown()
      }
    },
  )

  it(
    'ENVELOPE-OVERHEAD boundary: a chunk under the 16 MiB per-message cap but whose full reply line (envelope + {done:false,chunk}) would exceed it is probed as oversized and degrades to the structured StreamTruncatedError result — never an oversized-encode socket destroy',
    async () => {
      // The per-reply chunk cap reserves
      // BRIDGE_STREAM_NEXT_REPLY_ENVELOPE_RESERVE_BYTES below the hard
      // per-message cap, so a chunk sized BETWEEN the per-reply cap and the
      // hard cap is exactly the boundary the old raw-chunk probe mishandled:
      // it passed the probe (chunk < 16 MiB) but the full reply line
      // (envelope + {done:false,chunk}) overflowed encodeBridgeMessage and
      // destroyed the socket. It must now be probed oversized and degrade.
      const boundaryText = 'x'.repeat(
        BRIDGE_MAX_STREAM_NEXT_REPLY_BYTES + 512,
      )
      // Sanity: the chunk itself still fits the hard per-message cap — the
      // OLD probe would have admitted it (the exact divergence being fixed).
      expect(
        Buffer.byteLength(
          JSON.stringify({ type: 'text', text: boundaryText }),
          'utf8',
        ),
      ).toBeLessThan(BRIDGE_MAX_MESSAGE_BYTES)
      const deps = {
        promptAiSdkStream: async function* () {
          yield { type: 'text', text: 'before-boundary' }
          yield { type: 'text', text: boundaryText }
          yield { type: 'text', text: 'never-delivered' }
          return { aborted: false, value: 'done' }
        },
        trackEvent: async () => null,
        fetch: globalThis.fetch,
        apiKey: 'test-key',
      } as unknown as SupervisedBridgeHandlerDeps
      const table = buildSupervisedBridgeHandlers(deps)
      const bridge = await startBridge(table)
      try {
        const childDeps = buildBridgedChildDeps(bridge.client, {
          bridgeNonce: table.bridgeNonce,
        })
        const generator = childDeps.promptAiSdkStream({} as never)
        const first = await withTimeout(
          generator.next(),
          CALL_BUDGET_MS,
          'chunk before boundary',
        )
        expect((first.value as { text?: string }).text).toBe('before-boundary')
        const last = await withTimeout(
          generator.next(),
          CALL_BUDGET_MS,
          'boundary chunk reply',
        )
        expect(last.done).toBe(true)
        expect((last.value as { aborted?: boolean }).aborted).toBe(true)
        expect((last.value as { reason?: string }).reason).toContain(
          'StreamTruncatedError',
        )
        // The socket was never destroyed: a fresh stream still round-trips
        // through the SAME connection.
        const generator2 = childDeps.promptAiSdkStream({} as never)
        const again = await withTimeout(
          generator2.next(),
          CALL_BUDGET_MS,
          'post-boundary socket health',
        )
        expect((again.value as { text?: string }).text).toBe('before-boundary')
        await withTimeout(
          generator2.return(undefined as never),
          CALL_BUDGET_MS,
          'post-boundary early return',
        )
      } finally {
        await bridge.teardown()
      }
    },
  )

  it(
    'registry boundedness (in-process): the 257th start gets the structured too-many-concurrent-streams error, the cancelInFlightStreams drain empties the registry, and a finished stream is removed (stop reports stopped: false)',
    async () => {
      const deps = {
        promptAiSdkStream: async function* () {
          yield { type: 'text', text: 'chunk' }
          return { aborted: false, value: 'done' }
        },
        trackEvent: async () => null,
        fetch: globalThis.fetch,
        apiKey: 'test-key',
      } as unknown as SupervisedBridgeHandlerDeps
      const table = buildSupervisedBridgeHandlers(deps)
      const start = table.promptAiSdkStreamStart as (
        params: unknown,
      ) => Promise<{ streamId: string }>
      const next = table.promptAiSdkStreamNext as (
        params: unknown,
      ) => Promise<{ done: boolean; result?: unknown }>
      const stop = table.promptAiSdkStreamStop as (
        params: unknown,
      ) => Promise<{ stopped: boolean }>
      // Fill the registry to its cap: a child that keeps starting streams
      // without consuming or stopping them cannot grow it further.
      for (let i = 0; i < MAX_CONCURRENT_BRIDGE_STREAMS; i++) {
        await withTimeout(start({}), CALL_BUDGET_MS, `registry fill ${i}`)
      }
      const outcome = await settleWithin(start({}), CALL_BUDGET_MS)
      expect(outcome.kind).toBe('rejected')
      if (outcome.kind !== 'rejected') return
      expect(String((outcome.error as Error).message)).toContain(
        'too many concurrent streams',
      )
      // The close()-time drain (the SAME cancelInFlightStreams hook the
      // bridge server's close() probes structurally) empties the registry:
      // a start succeeds again afterwards. This is the boundedness backstop
      // for a child that never stops and never finishes its streams.
      table.cancelInFlightStreams()
      const revived = await withTimeout(
        start({}),
        CALL_BUDGET_MS,
        'post-drain start',
      )
      expect(typeof revived.streamId).toBe('string')
      // A stream consumed to done is removed from the registry (hygiene (a)):
      // a stop afterwards reports stopped: false — nothing left to tear down.
      await withTimeout(
        next({ streamId: revived.streamId }),
        CALL_BUDGET_MS,
        'consume chunk',
      )
      const finished = await withTimeout(
        next({ streamId: revived.streamId }),
        CALL_BUDGET_MS,
        'consume done',
      )
      expect(finished.done).toBe(true)
      expect((finished.result as { value?: unknown }).value).toBe('done')
      const stoppedAfterDone = await withTimeout(
        stop({ streamId: revived.streamId }),
        CALL_BUDGET_MS,
        'stop after done',
      )
      expect((stoppedAfterDone as { stopped: boolean }).stopped).toBe(false)
      // Leave nothing behind.
      table.cancelInFlightStreams()
    },
  )

  it(
    'registry hygiene (in-process): an explicit stop tears the provider stream down exactly like the legacy cancelStream (abort + iterator.return), reports stopped: true once, and a second stop is a no-op',
    async () => {
      let finallyRan = false
      let providerSignalAborted = false
      const deps = {
        promptAiSdkStream: async function* (params: unknown) {
          const signal = (params as { signal?: AbortSignal }).signal
          signal?.addEventListener('abort', () => {
            providerSignalAborted = true
          })
          try {
            yield { type: 'text', text: 'chunk-1' }
            await new Promise<never>((_, reject) => {
              const onAbort = () => reject(new Error('provider stream aborted'))
              if (signal?.aborted) onAbort()
              else signal?.addEventListener('abort', onAbort, { once: true })
            })
            yield { type: 'text', text: 'never-delivered' }
            return { aborted: false, value: 'done' }
          } finally {
            finallyRan = true
          }
        },
        trackEvent: async () => null,
        fetch: globalThis.fetch,
        apiKey: 'test-key',
      } as unknown as SupervisedBridgeHandlerDeps
      const table = buildSupervisedBridgeHandlers(deps)
      const start = table.promptAiSdkStreamStart as (
        params: unknown,
      ) => Promise<{ streamId: string }>
      const next = table.promptAiSdkStreamNext as (
        params: unknown,
      ) => Promise<{ done: boolean }>
      const stop = table.promptAiSdkStreamStop as (
        params: unknown,
      ) => Promise<{ stopped: boolean }>
      const { streamId } = await withTimeout(start({}), CALL_BUDGET_MS, 'start')
      await withTimeout(next({ streamId }), CALL_BUDGET_MS, 'first chunk')
      const stopped = await withTimeout(
        stop({ streamId }),
        CALL_BUDGET_MS,
        'explicit stop',
      )
      expect((stopped as { stopped: boolean }).stopped).toBe(true)
      await withTimeout(
        waitFor(
          () => finallyRan && providerSignalAborted,
          CALL_BUDGET_MS,
          'stop-time provider teardown',
        ),
        CALL_BUDGET_MS,
        'stop-time provider teardown',
      )
      expect(finallyRan).toBe(true)
      expect(providerSignalAborted).toBe(true)
      // The entry is gone: a second stop is a no-op, never a crash.
      const stoppedAgain = await withTimeout(
        stop({ streamId }),
        CALL_BUDGET_MS,
        'second stop',
      )
      expect((stoppedAgain as { stopped: boolean }).stopped).toBe(false)
    },
  )

  it(
    'child wrapper fallback: a partial table (no incremental methods) makes the wrapper fall back to the LEGACY full-collection call — chunks + result with BYTE-IDENTICAL semantics, and no stop is ever sent',
    async () => {
      const calls: BridgeMethod[] = []
      const stubClient: ChildBridgeClient = {
        call: async (method) => {
          calls.push(method)
          if (method === 'promptAiSdkStreamStart') {
            throw new Error(
              'bridge method not supplied by the parent: promptAiSdkStreamStart',
            )
          }
          if (method === 'promptAiSdkStream') {
            return {
              chunks: [
                { type: 'text', text: 'legacy-1' },
                { type: 'text', text: 'legacy-2' },
              ],
              result: { aborted: false, value: 'legacy-done' },
            }
          }
          throw new Error(`unexpected call: ${method}`)
        },
        notify: () => {},
        close: () => {},
        onClose: () => {},
      }
      const deps = buildBridgedChildDeps(stubClient)
      const generator = deps.promptAiSdkStream({} as never)
      const chunks: string[] = []
      for (;;) {
        const next = await withTimeout(
          generator.next(),
          CALL_BUDGET_MS,
          'fallback-path chunk delivery',
        )
        if (next.done) {
          expect((next.value as { value?: unknown }).value).toBe('legacy-done')
          break
        }
        chunks.push((next.value as { text: string }).text)
      }
      expect(chunks).toEqual(['legacy-1', 'legacy-2'])
      // Exactly one start attempt + the legacy call; no stop (nothing was
      // ever started).
      expect(calls).toEqual(['promptAiSdkStreamStart', 'promptAiSdkStream'])
    },
  )

  it(
    'child wrapper fail-closed: a done reply WITHOUT a result (the unknown/stale-streamId wire marker) rejects loudly instead of returning an undefined PromptResult',
    async () => {
      const stubClient: ChildBridgeClient = {
        call: async (method) => {
          if (method === 'promptAiSdkStreamStart') return { streamId: 'stream-1' }
          if (method === 'promptAiSdkStreamNext') return { done: true }
          if (method === 'promptAiSdkStreamStop') return { stopped: true }
          throw new Error(`unexpected call: ${method}`)
        },
        notify: () => {},
        close: () => {},
        onClose: () => {},
      }
      const deps = buildBridgedChildDeps(stubClient)
      const generator = deps.promptAiSdkStream({} as never)
      const outcome = await settleWithin(generator.next(), CALL_BUDGET_MS)
      expect(outcome.kind).toBe('rejected')
      if (outcome.kind !== 'rejected') return
      expect(String((outcome.error as Error).message)).toContain(
        'ended without a result',
      )
    },
  )
})
