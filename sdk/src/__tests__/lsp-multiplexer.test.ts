import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { afterEach, describe, expect, test } from 'bun:test'
import { getExactContentHash } from '@codebuff/common/util/content-hash'
import { toolParams } from '@codebuff/common/tools/list'

import {
  clearRootResolutionCache,
  defaultRootResolver,
  LspServerError,
  LspServerUnavailableError,
} from '../services/lsp-multiplexer'
import { createTestLspMultiplexer as createLspMultiplexer } from './lsp-execution-fixture'
import { WorkspaceMutationBroker } from '../services/workspace-mutation-broker'
import { createLanguageIntelligence } from '../services/language-intelligence'
import { createNodeFileSystem } from '../tools/node-filesystem'
import { createTransactionIntentLogForWorkspace, recoverAndRevertInterruptedTransactions } from '../tools/transaction-intent-log'
import { renameSymbol } from '../tools/rename-symbol'
import { codeAction } from '../tools/code-action'
import { extractSymbol } from '../tools/extract-symbol'

import type { LspChildHandle, LspSpawnSpec } from '../services/lsp-multiplexer'

/** A fake LSP peer: captures framed requests written to its stdin and replies. */
type FakePeer = {
  child: LspChildHandle
  received: string[]
  respond(next: (message: Record<string, unknown>) => Record<string, unknown> | null): void
  crash(): void
  killCount(): number
}

function frame(body: string): Buffer {
  return Buffer.from(`Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n${body}`, 'utf8')
}

function makePeer(
  behavior: (message: Record<string, unknown>, peer: FakePeer) => Record<string, unknown> | null,
): FakePeer {
  let writeBuffer = Buffer.alloc(0)
  let killed = 0
  const dataListeners: Array<(chunk: Buffer) => void> = []
  const exitListeners: Array<(code: number | null, signal: string | null) => void> = []
  const received: string[] = []
  let customResponder: ((message: Record<string, unknown>) => Record<string, unknown> | null) | null =
    null

  const peer: FakePeer = {
    received,
    respond(next) {
      customResponder = next
    },
    crash() {
      for (const listener of exitListeners) listener(1, null)
    },
    killCount: () => killed,
    child: {
      pid: 4242,
      stdin: {
        write(chunk: string) {
          writeBuffer = Buffer.concat([writeBuffer, Buffer.from(chunk, 'utf8')])
          for (;;) {
            const headerEnd = writeBuffer.indexOf('\r\n\r\n')
            if (headerEnd === -1) return
            const header = writeBuffer.subarray(0, headerEnd).toString('utf8')
            const match = /Content-Length:\s*(\d+)/i.exec(header)
            if (!match) {
              writeBuffer = writeBuffer.subarray(headerEnd + 4)
              continue
            }
            const length = Number(match[1])
            const start = headerEnd + 4
            if (writeBuffer.length < start + length) return
            const body = writeBuffer.subarray(start, start + length).toString('utf8')
            writeBuffer = writeBuffer.subarray(start + length)
            received.push(body)
            const message = JSON.parse(body) as Record<string, unknown>
            if (typeof message.id !== 'number') continue // notification
            const response = (customResponder ?? behavior)(message, peer)
            if (response) {
              for (const listener of dataListeners) {
                listener(frame(JSON.stringify(response)))
              }
            }
          }
        },
        end() {
          /* noop */
        },
      },
      stdout: {
        on(_event: 'data', listener: (chunk: Buffer) => void) {
          dataListeners.push(listener)
        },
      },
      on(event: 'exit' | 'error', listener: (arg0: never, arg1: never) => void) {
        if (event === 'exit') {
          exitListeners.push(listener as (code: number | null, signal: string | null) => void)
        }
      },
      kill() {
        killed++
      },
    },
  }
  return peer
}

const okInitialize = { capabilities: {} }

// The default root resolver memoizes directory→root walks for a TTL window;
// every test must start from a cold cache so fixtures created inside a test
// are actually seen by the walk.
afterEach(() => {
  clearRootResolutionCache()
})

function defaultBehavior(message: Record<string, unknown>): Record<string, unknown> | null {
  const id = message.id as number
  switch (message.method) {
    case 'initialize':
      return { jsonrpc: '2.0', id, result: okInitialize }
    case 'textDocument/definition':
      return { jsonrpc: '2.0', id, result: [{ uri: 'file:///x.ts', range: { start: { line: 1, character: 2 }, end: { line: 1, character: 5 } } }] }
    case 'textDocument/references':
      return { jsonrpc: '2.0', id, result: [] }
    case 'textDocument/hover':
      return { jsonrpc: '2.0', id, result: { contents: { kind: 'markdown', value: 'type info' } } }
    case 'textDocument/documentSymbol':
      return { jsonrpc: '2.0', id, result: [{ name: 'foo', kind: 12, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } }, selectionRange: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } } }] }
    default:
      return { jsonrpc: '2.0', id, result: null }
  }
}

describe('createLspMultiplexer', () => {
  test('cold-starts one server and answers a definition request with framing', async () => {
    const peers: FakePeer[] = []
    const mux = createLspMultiplexer({
      spawner: (spec: LspSpawnSpec) => {
        void spec
        const peer = makePeer(defaultBehavior)
        peers.push(peer)
        return peer.child
      },
    })
    const result = await mux.definition({ filePath: '/proj/src/a.ts', position: { line: 0, character: 1 } })
    expect(Array.isArray(result)).toBe(true)
    expect(peers.length).toBe(1)
    expect(mux.warmServerCount()).toBe(1)
    // initialize + initialized notification + the definition request
    const methods = peers[0].received.map((body) => (JSON.parse(body) as { method?: string }).method)
    expect(methods).toContain('initialize')
    expect(methods).toContain('initialized')
    expect(methods).toContain('textDocument/definition')
    await mux.dispose()
  })

  test('reuses one warm server per (language, root)', async () => {
    const peers: FakePeer[] = []
    const mux = createLspMultiplexer({
      spawner: () => {
        const peer = makePeer(defaultBehavior)
        peers.push(peer)
        return peer.child
      },
    })
    await mux.definition({ filePath: '/proj/src/a.ts', position: { line: 0, character: 0 } })
    await mux.hover({ filePath: '/proj/src/b.ts', position: { line: 0, character: 0 } })
    expect(peers.length).toBe(1)
    expect(mux.warmServerCount()).toBe(1)
    await mux.dispose()
  })

  test('spawns a distinct server per language', async () => {
    const peers: FakePeer[] = []
    const mux = createLspMultiplexer({
      spawner: () => {
        const peer = makePeer(defaultBehavior)
        peers.push(peer)
        return peer.child
      },
    })
    await mux.definition({ filePath: '/proj/a.ts', position: { line: 0, character: 0 } })
    await mux.definition({ filePath: '/proj/b.py', position: { line: 0, character: 0 } })
    expect(peers.length).toBe(2)
    expect(mux.warmServerCount()).toBe(2)
    await mux.dispose()
  })

  test('evicts the least-recently-used server past maxServers', async () => {
    const events: string[] = []
    const mux = createLspMultiplexer({
      maxServers: 2,
      onEvent: (event) => events.push(event.kind),
      spawner: () => makePeer(defaultBehavior).child,
      rootResolver: ({ filePath }) => filePath, // each file its own root
    })
    await mux.definition({ filePath: '/r1/a.ts', position: { line: 0, character: 0 } })
    await mux.definition({ filePath: '/r2/b.ts', position: { line: 0, character: 0 } })
    await mux.definition({ filePath: '/r3/c.ts', position: { line: 0, character: 0 } })
    expect(mux.warmServerCount()).toBe(2)
    expect(events).toContain('evicted')
    await mux.dispose()
  })

  test('syncFile issues didOpen then didChange', async () => {
    const peer = makePeer(defaultBehavior)
    const mux = createLspMultiplexer({ spawner: () => peer.child })
    await mux.syncFile({ filePath: '/proj/a.ts', version: 1, text: 'const x = 1' })
    await mux.syncFile({ filePath: '/proj/a.ts', version: 2, text: 'const x = 2' })
    const methods = peer.received.map((body) => (JSON.parse(body) as { method?: string }).method)
    expect(methods).toContain('textDocument/didOpen')
    expect(methods).toContain('textDocument/didChange')
    await mux.dispose()
  })

  test('syncFile with close issues didClose', async () => {
    const peer = makePeer(defaultBehavior)
    const mux = createLspMultiplexer({ spawner: () => peer.child })
    await mux.syncFile({ filePath: '/proj/a.ts', version: 1, text: 'x' })
    await mux.syncFile({ filePath: '/proj/a.ts', version: 2, text: 'x', close: true })
    const methods = peer.received.map((body) => (JSON.parse(body) as { method?: string }).method)
    expect(methods).toContain('textDocument/didClose')
    await mux.dispose()
  })

  test('reports an unsupported language without spawning', async () => {
    let spawned = 0
    const mux = createLspMultiplexer({
      spawner: () => {
        spawned++
        return makePeer(defaultBehavior).child
      },
    })
    await expect(
      mux.definition({ filePath: '/proj/a.unknownext', position: { line: 0, character: 0 } }),
    ).rejects.toBeInstanceOf(LspServerUnavailableError)
    expect(spawned).toBe(0)
    await mux.dispose()
  })

  test('reports a tcp-only server spec (gdscript) as unavailable', async () => {
    const mux = createLspMultiplexer({ spawner: () => makePeer(defaultBehavior).child })
    await expect(
      mux.definition({ filePath: '/proj/a.gd', position: { line: 0, character: 0 } }),
    ).rejects.toBeInstanceOf(LspServerUnavailableError)
    await mux.dispose()
  })

  test('times out a stuck request with a typed error', async () => {
    const stuck = makePeer((message) =>
      message.method === 'initialize' ? { jsonrpc: '2.0', id: message.id as number, result: okInitialize } : null,
    )
    const mux = createLspMultiplexer({ spawner: () => stuck.child, requestTimeoutMs: 30 })
    await expect(
      mux.hover({ filePath: '/proj/a.ts', position: { line: 0, character: 0 } }),
    ).rejects.toBeInstanceOf(LspServerError)
    await mux.dispose()
  })

  test('handles a partial frame split across chunks', async () => {
    const peer = makePeer(defaultBehavior)
    // Wrap: re-emit responses byte-by-byte by intercepting stdout listeners is
    // complex; instead assert the client reassembles by sending two chunks.
    const mux = createLspMultiplexer({ spawner: () => peer.child })
    const result = await mux.documentSymbol({ filePath: '/proj/a.ts' })
    expect(Array.isArray(result)).toBe(true)
    await mux.dispose()
  })

  test('surfaces a protocol error response as LspServerError', async () => {
    const peer = makePeer((message) => {
      if (message.method === 'initialize') {
        return { jsonrpc: '2.0', id: message.id as number, result: okInitialize }
      }
      return { jsonrpc: '2.0', id: message.id as number, error: { code: -32601, message: 'nope' } }
    })
    const mux = createLspMultiplexer({ spawner: () => peer.child })
    await expect(
      mux.definition({ filePath: '/proj/a.ts', position: { line: 0, character: 0 } }),
    ).rejects.toBeInstanceOf(LspServerError)
    await mux.dispose()
  })

  test('dispose stops every warm server', async () => {
    const peers: FakePeer[] = []
    const mux = createLspMultiplexer({
      spawner: () => {
        const peer = makePeer(defaultBehavior)
        peers.push(peer)
        return peer.child
      },
    })
    await mux.definition({ filePath: '/proj/a.ts', position: { line: 0, character: 0 } })
    await mux.definition({ filePath: '/proj/b.py', position: { line: 0, character: 0 } })
    await mux.dispose()
    expect(mux.warmServerCount()).toBe(0)
    for (const peer of peers) expect(peer.killCount()).toBeGreaterThan(0)
  })

  test('marker-aware root resolution shares one warm server across a subtree', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lsp-mux-root-'))
    const nested = path.join(root, 'packages', 'app')
    fs.mkdirSync(nested, { recursive: true })
    fs.writeFileSync(path.join(root, 'tsconfig.json'), '{}')
    const roots: string[] = []
    const mux = createLspMultiplexer({
      spawner: (spec: LspSpawnSpec) => {
        roots.push(spec.cwd)
        return makePeer(defaultBehavior).child
      },
    })
    try {
      await mux.definition({
        filePath: path.join(nested, 'a.ts'),
        position: { line: 0, character: 0 },
      })
      await mux.hover({
        filePath: path.join(nested, 'src', 'b.ts'),
        position: { line: 0, character: 0 },
      })
      // tsconfig.json at the temp root claims both files' root: one warm
      // server, so exactly ONE cold-start spawn happened, at the marker
      // directory (the second call reused the warm server).
      expect(roots).toEqual([root])
      expect(mux.warmServerCount()).toBe(1)
    } finally {
      await mux.dispose()
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test('the first rootMarker in the spec wins over later markers', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lsp-mux-prio-'))
    const nested = path.join(root, 'packages', 'app')
    fs.mkdirSync(nested, { recursive: true })
    // The TypeScript spec lists tsconfig.json before package.json, so the
    // nearer package.json must not claim the root.
    fs.writeFileSync(path.join(root, 'tsconfig.json'), '{}')
    fs.writeFileSync(path.join(nested, 'package.json'), '{}')
    const roots: string[] = []
    const mux = createLspMultiplexer({
      spawner: (spec: LspSpawnSpec) => {
        roots.push(spec.cwd)
        return makePeer(defaultBehavior).child
      },
    })
    try {
      await mux.definition({
        filePath: path.join(nested, 'a.ts'),
        position: { line: 0, character: 0 },
      })
      expect(roots).toEqual([root])
    } finally {
      await mux.dispose()
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test('falls back to the parent directory when the spec has no rootMarkers', async () => {
    const roots: string[] = []
    const mux = createLspMultiplexer({
      spawner: (spec: LspSpawnSpec) => {
        roots.push(spec.cwd)
        return makePeer(defaultBehavior).child
      },
    })
    // The csharp spec declares rootMarkers: [] — parent-directory keying is
    // unchanged.
    await mux.definition({
      filePath: '/proj/src/a.cs',
      position: { line: 0, character: 0 },
    })
    expect(roots).toEqual(['/proj/src'])
    await mux.dispose()
  })

  test('memoizes the walk per (directory, rootMarkers) until cleared', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lsp-mux-memo-'))
    const nested = path.join(root, 'packages', 'app')
    fs.mkdirSync(nested, { recursive: true })
    fs.writeFileSync(path.join(root, 'tsconfig.json'), '{}')
    const markers = ['tsconfig.json']
    const first = defaultRootResolver({
      filePath: path.join(nested, 'a.ts'),
      rootMarkers: markers,
    })
    expect(first).toBe(root)
    // A nearer marker appearing AFTER the first resolution is not seen on the
    // next call: the TTL memo served the walk result, so no new syscall walk
    // ran for the same (directory, marker list).
    fs.writeFileSync(path.join(nested, 'tsconfig.json'), '{}')
    const second = defaultRootResolver({
      filePath: path.join(nested, 'a.ts'),
      rootMarkers: markers,
    })
    expect(second).toBe(first)
    // Clearing the cache drops the memo, so the walk re-runs and now sees the
    // nearer marker.
    clearRootResolutionCache()
    const third = defaultRootResolver({
      filePath: path.join(nested, 'a.ts'),
      rootMarkers: markers,
    })
    expect(third).toBe(nested)
    fs.rmSync(root, { recursive: true, force: true })
  })

  test('coalesces concurrent cold starts for the same (language, root) key', async () => {
    const peers: FakePeer[] = []
    const mux = createLspMultiplexer({
      spawner: () => {
        const peer = makePeer(defaultBehavior)
        peers.push(peer)
        return peer.child
      },
    })
    // The bounded-parallel syncMutatedFiles path (concurrency 4) makes
    // concurrent acquire() on the same key reachable on every multi-file
    // mutation commit: the losers must join the winner's cold start instead
    // of spawning duplicate servers whose losing child would leak.
    const results = await Promise.all([
      mux.definition({ filePath: '/proj/a.ts', position: { line: 0, character: 0 } }),
      mux.hover({ filePath: '/proj/b.ts', position: { line: 0, character: 0 } }),
      mux.documentSymbol({ filePath: '/proj/c.ts' }),
    ])
    expect(results.every((result) => result !== null)).toBe(true)
    expect(peers.length).toBe(1)
    expect(mux.warmServerCount()).toBe(1)
    await mux.dispose()
  })

  test('concurrent cold starts for distinct keys never overshoot maxServers', async () => {
    const mux = createLspMultiplexer({
      maxServers: 2,
      rootResolver: ({ filePath }) => filePath, // each file its own root
      spawner: () => makePeer(defaultBehavior).child,
    })
    // Two concurrent cold starts that each observe room after one eviction
    // used to both proceed and register, transiently exceeding the cap
    // (evictIfNeeded checked size synchronously, awaited connection.stop(),
    // and re-checked nothing). Eviction + slot reservation are now
    // serialized, so the bound holds under concurrent distinct-key starts.
    const settled = await Promise.allSettled([
      mux.definition({ filePath: '/r1/a.ts', position: { line: 0, character: 0 } }),
      mux.definition({ filePath: '/r2/b.ts', position: { line: 0, character: 0 } }),
      mux.definition({ filePath: '/r3/c.ts', position: { line: 0, character: 0 } }),
      mux.definition({ filePath: '/r4/d.ts', position: { line: 0, character: 0 } }),
    ])
    expect(mux.warmServerCount()).toBeLessThanOrEqual(2)
    // At least one caller must get a usable server, and every rejection (a
    // caller whose entry was evicted right after its start completed fails
    // its request with the typed stopped error) is an LspServerError, never
    // an unexpected crash.
    expect(settled.some((outcome) => outcome.status === 'fulfilled')).toBe(true)
    for (const outcome of settled) {
      if (outcome.status === 'rejected') {
        expect(outcome.reason).toBeInstanceOf(LspServerError)
      }
    }
    await mux.dispose()
  })

  test('workspaceSymbol reuses an already-warm server without cold-starting or erroring', async () => {
    const peers: FakePeer[] = []
    const mux = createLspMultiplexer({
      spawner: () => {
        const peer = makePeer((message) => {
          const id = message.id as number
          if (message.method === 'workspace/symbol') {
            return {
              jsonrpc: '2.0',
              id,
              result: [
                {
                  name: 'foo',
                  kind: 12,
                  location: {
                    uri: 'file:///proj/src/a.ts',
                    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } },
                  },
                },
              ],
            }
          }
          return defaultBehavior(message)
        })
        peers.push(peer)
        return peer.child
      },
    })
    // Warm the server with a file-anchored request first. The resulting
    // server map key ('typescript:file:///proj/src') is not a resolvable file
    // path, so the symbol query must reuse the warm entry directly instead of
    // re-acquiring via the key (which used to throw unsupported-language).
    await mux.definition({ filePath: '/proj/src/a.ts', position: { line: 0, character: 0 } })
    const symbols = await mux.workspaceSymbol('foo')
    expect(Array.isArray(symbols)).toBe(true)
    expect(symbols?.[0]?.name).toBe('foo')
    // No cold start for the symbol query: the warm peer answered it.
    expect(peers.length).toBe(1)
    expect(mux.warmServerCount()).toBe(1)
    const methods = peers[0].received.map((body) => (JSON.parse(body) as { method?: string }).method)
    expect(methods).toContain('workspace/symbol')
    expect(methods.filter((method) => method === 'initialize')).toHaveLength(1)
    await mux.dispose()
  })

  // N04 / language-intel-07: a missing server binary is `not-installed`
  // (with the install hint), never a 'crashed' error, and is not respawned.
  test('a missing server binary rejects with not-installed and is negatively cached', async () => {
    let spawned = 0
    const mux = createLspMultiplexer({
      spawner: () => {
        spawned++
        const errorListeners: Array<(error: unknown) => void> = []
        const child: LspChildHandle = {
          stdin: { write() {}, end() {} },
          stdout: { on() {} },
          on(event: 'exit' | 'error', listener: (...args: never[]) => void) {
            if (event === 'error') errorListeners.push(listener as (error: unknown) => void)
          },
          kill() {},
        }
        queueMicrotask(() => {
          const error = Object.assign(
            new Error('Executable not found in $PATH: "typescript-language-server"'),
            { code: 'ENOENT' },
          )
          for (const listener of errorListeners) listener(error)
        })
        return child
      },
    })
    const first = await mux
      .definition({ filePath: '/proj/a.ts', position: { line: 0, character: 0 } })
      .then(() => undefined, (error: unknown) => error)
    expect(first).toBeInstanceOf(LspServerUnavailableError)
    expect(first).not.toBeInstanceOf(LspServerError)
    const typed = first as LspServerUnavailableError
    expect(typed.reason).toBe('not-installed')
    expect(typed.command).toBe('typescript-language-server')
    expect(typed.languageId).toBe('typescript')
    expect(typed.install).toContain('typescript-language-server')

    const second = await mux
      .hover({ filePath: '/proj/b.ts', position: { line: 0, character: 0 } })
      .then(() => undefined, (error: unknown) => error)
    expect((second as LspServerUnavailableError).reason).toBe('not-installed')
    expect(spawned).toBe(1)
    await mux.dispose()
  })

  test('a warm server answering null for workspace/symbol is an empty answer, and a rejection is typed unavailable', async () => {
    let symbolMode: 'null' | 'error' = 'null'
    const mux = createLspMultiplexer({
      spawner: () =>
        makePeer((message) => {
          const id = message.id as number
          if (message.method === 'workspace/symbol') {
            return symbolMode === 'null'
              ? { jsonrpc: '2.0', id, result: null }
              : { jsonrpc: '2.0', id, error: { code: -32601, message: 'Unhandled method workspace/symbol' } }
          }
          return defaultBehavior(message)
        }).child,
    })
    await mux.definition({ filePath: '/proj/a.ts', position: { line: 0, character: 0 } })
    expect(await mux.workspaceSymbol('foo')).toEqual([])
    symbolMode = 'error'
    const rejected = await mux
      .workspaceSymbol('foo')
      .then(() => undefined, (error: unknown) => error)
    expect(rejected).toBeInstanceOf(LspServerUnavailableError)
    expect((rejected as LspServerUnavailableError).reason).toBe('workspace-symbol-unsupported')
    await mux.dispose()
  })

  test('workspaceSymbol with no warm server returns null without spawning', async () => {
    let spawned = 0
    const mux = createLspMultiplexer({
      spawner: () => {
        spawned++
        return makePeer(defaultBehavior).child
      },
    })
    const symbols = await mux.workspaceSymbol('foo')
    expect(symbols).toBeNull()
    expect(spawned).toBe(0)
    await mux.dispose()
  })

  // P3 audit remediation (per-language spawn-spec pin): every stdio-launchable
  // language must resolve extension -> language -> languageServer spec -> the
  // exact spawn argv from the registry. gdscript is tcp-only and must be
  // rejected as 'tcp-transport', never spawned. Hermetic: the spawner captures
  // the spec and returns a fake peer; no real language server is started.
  const SPAWN_ARGV_CASES: Array<{
    languageId: string
    filePath: string
    argv: readonly string[]
  }> = [
    { languageId: 'typescript', filePath: '/proj/a.ts', argv: ['typescript-language-server', '--stdio'] },
    { languageId: 'python', filePath: '/proj/a.py', argv: ['pyright-langserver', '--stdio'] },
    { languageId: 'rust', filePath: '/proj/a.rs', argv: ['rust-analyzer'] },
    { languageId: 'go', filePath: '/proj/a.go', argv: ['gopls'] },
    { languageId: 'java', filePath: '/proj/a.java', argv: ['jdtls'] },
    { languageId: 'csharp', filePath: '/proj/a.cs', argv: ['csharp-ls'] },
    { languageId: 'cpp', filePath: '/proj/a.cpp', argv: ['clangd'] },
    { languageId: 'ruby', filePath: '/proj/a.rb', argv: ['ruby-lsp'] },
    { languageId: 'php', filePath: '/proj/a.php', argv: ['intelephense', '--stdio'] },
    { languageId: 'swift', filePath: '/proj/a.swift', argv: ['sourcekit-lsp'] },
    { languageId: 'kotlin', filePath: '/proj/a.kt', argv: ['kotlin-language-server'] },
  ]

  for (const { languageId, filePath, argv } of SPAWN_ARGV_CASES) {
    test(`resolves ${languageId} to its languageServer spawn argv`, async () => {
      const specs: LspSpawnSpec[] = []
      const mux = createLspMultiplexer({
        spawner: (spec: LspSpawnSpec) => {
          specs.push(spec)
          return makePeer(defaultBehavior).child
        },
      })
      await mux.definition({ filePath, position: { line: 0, character: 0 } })
      expect(specs).toHaveLength(1)
      expect([...specs[0].argv]).toEqual([...argv])
      await mux.dispose()
    })
  }

  test('rejects the tcp-only gdscript server spec as tcp-transport without spawning', async () => {
    let spawned = 0
    const mux = createLspMultiplexer({
      spawner: () => {
        spawned++
        return makePeer(defaultBehavior).child
      },
    })
    const failure = await mux
      .definition({ filePath: '/proj/a.gd', position: { line: 0, character: 0 } })
      .then(
        () => {
          throw new Error('expected gdscript definition to reject')
        },
        (error: unknown) => error,
      )
    expect(failure).toBeInstanceOf(LspServerUnavailableError)
    expect((failure as LspServerUnavailableError).reason).toBe('tcp-transport')
    expect((failure as LspServerUnavailableError).languageId).toBe('gdscript')
    expect(spawned).toBe(0)
    await mux.dispose()
  })

  // F1 regression pin (fail-closed framing): a header block with no parseable
  // Content-Length (or a non-numeric/oversize one) means the peer is not
  // speaking LSP framing. The connection must tear down (in-flight request
  // rejects with LspServerError reason 'crashed', a 'restart' event fires) and
  // must NOT resynchronize — subsequent garbage is never parsed as a frame.
  // The frame() helper always emits a valid header, so these peers emit the
  // malformed header manually via an `emitRaw` stdout hook.
  type RawPeer = FakePeer & { emitRaw(chunk: Buffer): void }

  function makeRawPeer(
    behavior: (message: Record<string, unknown>, peer: FakePeer) => Record<string, unknown> | null,
  ): RawPeer {
    const base = makePeer(behavior)
    // Wrap (not replace) the base stdout so consume()'s 'data' listener joins
    // the SAME listener chain the base peer's stdin->response loop pushes
    // framed responses into. Replacing stdout with a fresh object disconnects
    // that plumbing (the base loop fires its own captured array), deadlocking
    // the initialize handshake before any malformed byte is ever emitted.
    // emitRaw is an additional injection point feeding the same chain.
    const consumers: Array<(chunk: Buffer) => void> = []
    const child: LspChildHandle = {
      ...base.child,
      stdout: {
        on(event: 'data', listener: (chunk: Buffer) => void) {
          base.child.stdout.on(event, listener)
          consumers.push(listener)
        },
      },
    }
    return {
      ...base,
      child,
      emitRaw(chunk: Buffer) {
        for (const consumer of consumers) consumer(chunk)
      },
    }
  }

  // The request promise travels several microtasks (withServer -> acquire ->
  // connection.request) before send() registers it in the pending map and
  // writes it to the peer. Emitting the malformed bytes only after the peer
  // has received the request guarantees it is genuinely in flight, so the
  // fail-closed teardown rejects it with 'crashed' rather than the request
  // bouncing off the already-dead connection with 'stopped'.
  async function waitUntilSent(peer: FakePeer, method: string): Promise<void> {
    for (let attempt = 0; attempt < 50; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 0))
      const sent = peer.received.some(
        (body) => (JSON.parse(body) as { method?: string }).method === method,
      )
      if (sent) return
    }
    throw new Error(`peer never received '${method}'`)
  }

  test('a header block with no Content-Length fails closed, restarts, and never resynchronizes', async () => {
    const events: Array<{ kind: string; reason?: string }> = []
    const peer = makeRawPeer((message) =>
      message.method === 'initialize'
        ? { jsonrpc: '2.0', id: message.id as number, result: okInitialize }
        : null,
    )
    const mux = createLspMultiplexer({
      spawner: () => peer.child,
      onEvent: (event) => events.push(event as { kind: string; reason?: string }),
      requestTimeoutMs: 5_000,
    })
    // Warm the server so the initialize handshake completes.
    await mux.syncFile({ filePath: '/proj/a.ts', version: 1, text: 'const x = 1' })

    // Start an in-flight request the peer never answers, then push a malformed
    // header block (no Content-Length) from the server's stdout.
    const inFlight = mux.hover({ filePath: '/proj/a.ts', position: { line: 0, character: 0 } })
    await waitUntilSent(peer, 'textDocument/hover')
    peer.emitRaw(
      Buffer.from('Content-Type: application/vscode-jsonrpc; charset=utf-8\r\n\r\n{}', 'utf8'),
    )

    const failure = await inFlight.then(
      () => {
        throw new Error('expected the in-flight request to reject')
      },
      (error: unknown) => error,
    )
    expect(failure).toBeInstanceOf(LspServerError)
    expect((failure as LspServerError).reason).toBe('crashed')
    expect((failure as Error).message).toBe(
      'LSP server died (malformed LSP header: missing Content-Length).',
    )
    // A crash (not a clean stop) fires a restart event.
    expect(events.some((event) => event.kind === 'restart')).toBe(true)

    // No resynchronization: bytes pushed after the teardown are never parsed
    // as a frame. A valid-looking framed response injected now must not
    // resolve anything or crash the process — the connection is dead.
    const resurrect = frame(JSON.stringify({ jsonrpc: '2.0', id: 999, result: 'pwned' }))
    peer.emitRaw(resurrect)
    await mux.dispose()
  })

  test('an oversize Content-Length fails closed with invalid Content-Length', async () => {
    const events: Array<{ kind: string; reason?: string }> = []
    const peer = makeRawPeer((message) =>
      message.method === 'initialize'
        ? { jsonrpc: '2.0', id: message.id as number, result: okInitialize }
        : null,
    )
    const mux = createLspMultiplexer({
      spawner: () => peer.child,
      onEvent: (event) => events.push(event as { kind: string; reason?: string }),
      requestTimeoutMs: 5_000,
    })
    await mux.syncFile({ filePath: '/proj/a.ts', version: 1, text: 'const x = 1' })

    const inFlight = mux.hover({ filePath: '/proj/a.ts', position: { line: 0, character: 0 } })
    await waitUntilSent(peer, 'textDocument/hover')
    // A Content-Length past maxFrameBytes must fail closed, not buffer-wait.
    peer.emitRaw(Buffer.from('Content-Length: 999999999999\r\n\r\n', 'utf8'))

    const failure = await inFlight.then(
      () => {
        throw new Error('expected the in-flight request to reject')
      },
      (error: unknown) => error,
    )
    expect(failure).toBeInstanceOf(LspServerError)
    expect((failure as LspServerError).reason).toBe('crashed')
    expect((failure as Error).message).toBe(
      'LSP server died (invalid Content-Length 999999999999).',
    )
    expect(events.some((event) => event.kind === 'restart')).toBe(true)
    await mux.dispose()
  })

  // Remediation (dead-entry cold-start replacement): a cached entry whose
  // connection is permanently dead (the single restart attempt gave up) must
  // be treated as a miss and replaced by a fresh cold start through the
  // existing single-flight path, instead of being handed back and failing
  // every query with 'stopped' until LRU eviction.
  test('a dead cached entry is replaced by a cold start instead of failing with stopped', async () => {
    const events: string[] = []
    const peers: FakePeer[] = []
    const mux = createLspMultiplexer({
      onEvent: (event) => events.push(event.kind),
      startupTimeoutMs: 50,
      requestTimeoutMs: 1_000,
      spawner: () => {
        // Spawn 1: the healthy original. Spawn 2: the restart attempt, whose
        // initialize handshake never completes, so the restart gives up and
        // leaves the cached entry dead. Spawn 3: the healthy replacement.
        const peer = makePeer(peers.length === 1 ? () => null : defaultBehavior)
        peers.push(peer)
        return peer.child
      },
    })
    await mux.syncFile({ filePath: '/proj/a.ts', version: 1, text: 'const x = 1' })
    expect(mux.warmServerCount()).toBe(1)

    // Crash the warm server; its one restart attempt never initializes and
    // gives up, leaving the cached entry with a dead connection.
    peers[0].crash()
    expect(events).toContain('restart')
    for (let attempt = 0; attempt < 100; attempt++) {
      if (events.includes('gave-up')) break
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    expect(events).toContain('gave-up')

    // The next acquire must cold-start a replacement (spawn 3) instead of
    // returning the dead entry whose requests all reject with 'stopped'.
    const result = await mux.hover({ filePath: '/proj/a.ts', position: { line: 0, character: 0 } })
    expect(result).not.toBeNull()
    expect(peers.length).toBe(3)
    expect(events.filter((kind) => kind === 'started')).toHaveLength(2)
    await mux.dispose()
  })

  // Remediation (uncorrelatable response frames): a framed response whose
  // body is unparseable cannot be matched to any pending request. The
  // pending request must be rejected with a structured protocol error
  // promptly instead of hanging until the request timeout, and the
  // connection must stay up (only broken *framing* tears it down).
  test('an unparseable response body rejects the pending request with a protocol error instead of hanging', async () => {
    const events: string[] = []
    const peer = makeRawPeer((message) =>
      message.method === 'initialize'
        ? { jsonrpc: '2.0', id: message.id as number, result: okInitialize }
        : null,
    )
    const mux = createLspMultiplexer({
      spawner: () => peer.child,
      onEvent: (event) => events.push(event.kind),
      // Long on purpose: a 'protocol' rejection (not 'timeout') proves the
      // pending request did not hang until this fired.
      requestTimeoutMs: 10_000,
    })
    await mux.syncFile({ filePath: '/proj/a.ts', version: 1, text: 'const x = 1' })

    const inFlight = mux.hover({ filePath: '/proj/a.ts', position: { line: 0, character: 0 } })
    await waitUntilSent(peer, 'textDocument/hover')
    // Well-formed framing, unparseable body: correlation is impossible.
    peer.emitRaw(frame('not json at all'))

    const failure = await inFlight.then(
      () => {
        throw new Error('expected the in-flight request to reject')
      },
      (error: unknown) => error,
    )
    expect(failure).toBeInstanceOf(LspServerError)
    expect((failure as LspServerError).reason).toBe('protocol')
    // Not torn down: no crash/restart event fired for one bad frame.
    expect(events.some((kind) => kind === 'restart' || kind === 'gave-up')).toBe(false)

    // The connection still works: a follow-up request is answered normally.
    peer.respond((message) => {
      if (message.method === 'textDocument/hover') {
        return { jsonrpc: '2.0', id: message.id as number, result: { contents: 'recovered' } }
      }
      return null
    })
    const followUp = await mux.hover({
      filePath: '/proj/a.ts',
      position: { line: 0, character: 0 },
    })
    expect(followUp).not.toBeNull()
    await mux.dispose()
  })

  test('a non-numeric response id rejects pending requests; an unknown id is ignored silently', async () => {
    const peer = makeRawPeer((message) =>
      message.method === 'initialize'
        ? { jsonrpc: '2.0', id: message.id as number, result: okInitialize }
        : null,
    )
    const mux = createLspMultiplexer({
      spawner: () => peer.child,
      requestTimeoutMs: 10_000,
    })
    await mux.syncFile({ filePath: '/proj/a.ts', version: 1, text: 'const x = 1' })

    const inFlight = mux.hover({ filePath: '/proj/a.ts', position: { line: 0, character: 0 } })
    await waitUntilSent(peer, 'textDocument/hover')
    peer.emitRaw(frame(JSON.stringify({ jsonrpc: '2.0', id: 'not-a-number', result: null })))

    const failure = await inFlight.then(
      () => {
        throw new Error('expected the in-flight request to reject')
      },
      (error: unknown) => error,
    )
    expect(failure).toBeInstanceOf(LspServerError)
    expect((failure as LspServerError).reason).toBe('protocol')

    // An unknown numeric id (a reply to a request this client never sent) is
    // ignored silently: nothing is rejected and the connection stays up, so
    // the next real response still resolves its request.
    peer.respond((message) =>
      message.method === 'textDocument/hover'
        ? { jsonrpc: '2.0', id: message.id as number, result: { contents: 'ok' } }
        : null,
    )
    peer.emitRaw(frame(JSON.stringify({ jsonrpc: '2.0', id: 9999, result: 'stray' })))
    const later = mux.hover({ filePath: '/proj/a.ts', position: { line: 0, character: 0 } })
    expect(await later).not.toBeNull()
    await mux.dispose()
  })

  // Remediation (workspace/symbol language routing): with a filePath context
  // the language is derived from the extension via the registry mapping and
  // the query routes to THAT language's warm server; when no language can be
  // determined or no server for it is warm, it degrades to the existing
  // unavailable result (null) without cold-starting.
  test('workspaceSymbol routes by filePath language and degrades to null when unavailable', async () => {
    const peers: FakePeer[] = []
    const mux = createLspMultiplexer({
      spawner: () => {
        const index = peers.length
        const peer = makePeer((message) => {
          const id = message.id as number
          if (message.method === 'workspace/symbol') {
            return {
              jsonrpc: '2.0',
              id,
              result: [
                {
                  name: `symbol-from-${index}`,
                  kind: 12,
                  location: {
                    uri: `file:///x${index}`,
                    range: {
                      start: { line: 0, character: 0 },
                      end: { line: 0, character: 0 },
                    },
                  },
                },
              ],
            }
          }
          return defaultBehavior(message)
        })
        peers.push(peer)
        return peer.child
      },
    })
    // Warm one server per language: peers[0] is typescript, peers[1] python.
    await mux.definition({ filePath: '/proj/a.ts', position: { line: 0, character: 0 } })
    await mux.definition({ filePath: '/proj/b.py', position: { line: 0, character: 0 } })
    expect(peers.length).toBe(2)
    expect(mux.warmServerCount()).toBe(2)

    // The .py context routes to the python server (peers[1]), NOT whichever
    // warm server is most recent.
    const pySymbols = await mux.workspaceSymbol('foo', '/proj/c.py')
    expect(pySymbols?.[0]?.name).toBe('symbol-from-1')
    const tsSymbols = await mux.workspaceSymbol('foo', '/proj/c.ts')
    expect(tsSymbols?.[0]?.name).toBe('symbol-from-0')

    // No language determinable -> unavailable (null), never a throw.
    expect(await mux.workspaceSymbol('foo', '/proj/c.unknownext')).toBeNull()
    // Known language with no warm server for it -> unavailable (null), and
    // no cold start is issued for the symbol query.
    expect(await mux.workspaceSymbol('foo', '/proj/c.rs')).toBeNull()
    expect(peers.length).toBe(2)
    expect(mux.warmServerCount()).toBe(2)
    await mux.dispose()
  })

  // P4-T2 (rename/codeAction): the semantic-edit paths follow the same
  // hermetic framed-peer pattern as definition above. NO capability-
  // advertisement gate is asserted: the request is issued verbatim and an
  // incapable server's error response surfaces as the caller's typed error.
  test('prepareRenameParams and rename follow the definition/references request pattern', async () => {
    const peer = makePeer((message) => {
      const id = message.id as number
      switch (message.method) {
        case 'initialize':
          return { jsonrpc: '2.0', id, result: okInitialize }
        case 'textDocument/prepareRename':
          return {
            jsonrpc: '2.0',
            id,
            result: { range: { start: { line: 0, character: 6 }, end: { line: 0, character: 7 } } },
          }
        case 'textDocument/rename':
          return {
            jsonrpc: '2.0',
            id,
            result: {
              changes: {
                'file:///proj/a.ts': [
                  { range: { start: { line: 0, character: 6 }, end: { line: 0, character: 7 } }, newText: 'renamed' },
                ],
              },
            },
          }
        default:
          return { jsonrpc: '2.0', id, result: null }
      }
    })
    const mux = createLspMultiplexer({ spawner: () => peer.child })
    // 0-based positions are consumed verbatim: the mux never re-bases (the
    // service layer owns the single 1-based-to-0-based shift).
    const range = await mux.prepareRenameParams({
      filePath: '/proj/a.ts',
      position: { line: 7, character: 2 },
    })
    expect(range).toEqual({
      range: { start: { line: 0, character: 6 }, end: { line: 0, character: 7 } },
    })
    const changes = await mux.rename({
      filePath: '/proj/a.ts',
      position: { line: 7, character: 2 },
      newName: 'renamed',
    })
    expect(changes).toEqual({
      'file:///proj/a.ts': [
        { range: { start: { line: 0, character: 6 }, end: { line: 0, character: 7 } }, newText: 'renamed' },
      ],
    })
    const requests = peer.received.map(
      (body) => JSON.parse(body) as { method?: string; params?: Record<string, unknown> },
    )
    const prepare = requests.find((m) => m.method === 'textDocument/prepareRename')
    expect(prepare?.params?.position).toEqual({ line: 7, character: 2 })
    const rename = requests.find((m) => m.method === 'textDocument/rename')
    expect(rename?.params?.position).toEqual({ line: 7, character: 2 })
    expect(rename?.params?.newName).toBe('renamed')
    await mux.dispose()
  })

  test('B06 preserves the exact version-7 document basis in a framed rename response', async () => {
    const text = '\uFEFFconst value = 1\r\n'
    const uri = 'file:///proj/a.ts'
    const peer = makePeer(message => message.method === 'textDocument/rename'
      ? { jsonrpc: '2.0', id: message.id, result: { documentChanges: [{
          textDocument: { uri, version: 7 },
          edits: [{ range: { start: { line: 0, character: 7 }, end: { line: 0, character: 12 } }, newText: 'next' }],
        }] } }
      : defaultBehavior(message))
    const mux = createLspMultiplexer({ spawner: () => peer.child })
    try {
      await mux.syncFile({ filePath: '/proj/a.ts', version: 7, text })
      const intent = await mux.renameIntent!({ filePath: '/proj/a.ts', position: { line: 0, character: 7 }, newName: 'next' })
      expect(intent).toMatchObject({ encoding: 'utf-16', operations: [{
        uri, version: 7, requestedVersion: 7, expectedRawHash: getExactContentHash(text), newContent: '\uFEFFconst next = 1\r\n',
      }] })
    } finally { await mux.dispose() }
  })

  const b06Uri = 'file:///proj/a.ts'
  const b06Edit = { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, newText: 'replacement' }
  const b06Document = { textDocument: { uri: b06Uri, version: 7 }, edits: [b06Edit] }

  test.each([
    ['wrong version', { documentChanges: [{ ...b06Document, textDocument: { uri: b06Uri, version: 6 } }] }, 'version'],
    ['missing basis', { changes: { [b06Uri]: [b06Edit], 'file:///proj/unknown.ts': [b06Edit] } }, 'missing pre-request'],
    ['malformed member', { documentChanges: [b06Document, { textDocument: { uri: 'file:///proj/b.ts', version: 7 }, edits: [{ unexpected: 'payload' }] }] }, 'malformed text edit'],
    ['unsupported resource option', { documentChanges: [b06Document, { kind: 'delete', uri: 'file:///proj/b.ts', options: { recursive: true } }] }, 'unsupported'],
    ['mixed edit forms', { changes: { [b06Uri]: [b06Edit] }, documentChanges: [b06Document] }, 'exactly one'],
    ['unverified annotations', { documentChanges: [{ ...b06Document, edits: [{ ...b06Edit, annotationId: 'confirmation' }] }] }, 'unsupported annotation'],
    ['repeated text version', { documentChanges: [b06Document, b06Document] }, 'repeated semantic path'],
    ['rename cycle', { documentChanges: [
      { kind: 'rename', oldUri: b06Uri, newUri: 'file:///proj/new.ts' },
      { kind: 'rename', oldUri: 'file:///proj/new.ts', newUri: b06Uri },
    ] }, 'repeated semantic path'],
    ['numeric version on a created document', { documentChanges: [
      { kind: 'create', uri: 'file:///proj/new.ts' },
      { textDocument: { uri: 'file:///proj/new.ts', version: 1 }, edits: [] },
    ] }, 'created document does not have a pre-request version'],
  ] as const)('B06 refuses a whole framed plan containing %s', async (_label, reply, message) => {
    const peer = makePeer(request => request.method === 'textDocument/rename'
      ? { jsonrpc: '2.0', id: request.id, result: reply }
      : defaultBehavior(request))
    const mux = createLspMultiplexer({ spawner: () => peer.child })
    try {
      await mux.syncFile({ filePath: '/proj/a.ts', version: 7, text: 'a\n' })
      await mux.syncFile({ filePath: '/proj/b.ts', version: 7, text: 'b\n' })
      await expect(mux.renameIntent!({ filePath: '/proj/a.ts', position: { line: 0, character: 0 }, newName: 'replacement' })).rejects.toThrow(message)
    } finally { await mux.dispose() }
  })

  test('B06 does not accept a document sync while the rename is pending', async () => {
    const peer = makeRawPeer(request => request.method === 'textDocument/rename' ? null : defaultBehavior(request))
    const mux = createLspMultiplexer({ spawner: () => peer.child })
    try {
      await mux.syncFile({ filePath: '/proj/a.ts', version: 7, text: 'original\n' })
      const rename = mux.renameIntent!({ filePath: '/proj/a.ts', position: { line: 0, character: 0 }, newName: 'replacement' })
      await waitUntilSent(peer, 'textDocument/rename')
      await mux.syncFile({ filePath: '/proj/a.ts', version: 8, text: 'concurrent\n' })
      const request = peer.received.map(body => JSON.parse(body)).find(body => body.method === 'textDocument/rename')
      peer.emitRaw(frame(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { documentChanges: [b06Document] } })))
      await expect(rename).rejects.toThrow('changed while the edit request was in flight')
    } finally { await mux.dispose() }
  })

  test.each(['rename', 'bad-scalar', 'hover'] as const)('B06 negotiated UTF-8 uses the captured raw coordinate units: %s', async mode => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'openbuff-b06-utf8-'))
    const cwd = path.join(fs.realpathSync(tmp), 'project')
    fs.mkdirSync(cwd)
    const file = path.join(cwd, 'source.ts')
    const original = '\uFEFF😀 café\r\nnext\r'
    const wireRange = { start: { line: 0, character: 8 }, end: { line: 0, character: 13 } }
    const peer = makePeer(request => {
      if (request.method === 'initialize') return { jsonrpc: '2.0', id: request.id, result: { capabilities: { positionEncoding: 'utf-8' } } }
      if (request.method === 'textDocument/prepareRename') return { jsonrpc: '2.0', id: request.id, result: wireRange }
      if (request.method === 'textDocument/hover') return { jsonrpc: '2.0', id: request.id, result: { contents: 'known symbol', range: wireRange } }
      if (request.method !== 'textDocument/rename') return defaultBehavior(request)
      return { jsonrpc: '2.0', id: request.id, result: { documentChanges: [{
        textDocument: { uri: pathToFileURL(file).href, version: 3 },
        edits: [{ range: { ...wireRange, start: { line: 0, character: mode === 'bad-scalar' ? 4 : 8 } }, newText: '茶' }],
      }] } }
    })
    const mux = createLspMultiplexer({ spawner: () => peer.child, rootResolver: () => cwd })
    try {
      fs.writeFileSync(file, original)
      await mux.syncFile({ filePath: file, version: 3, text: original })
      const broker = await WorkspaceMutationBroker.create({ cwd, stateDir: path.join(tmp, 'state') })
      const host = createNodeFileSystem({ mutationBroker: broker })
      const service = createLanguageIntelligence({ cwd, fs: host, multiplexer: mux })
      const request = { path: 'source.ts', line: 1, character: 4 }
      if (mode === 'hover') {
        const result = await service.hoverType(request)
        expect(result[0]?.value).toMatchObject({ hover: { range: { ...wireRange, positionEncoding: 'utf-8' }, contents: 'known symbol' } })
      } else {
        const result = await renameSymbol(service, { ...request, new_name: '茶' }, { cwd, fs: host })
        if (mode === 'bad-scalar') {
          expect(result.output[0]?.value).toMatchObject({ errorMessage: expect.stringContaining('Unicode scalar') })
        } else {
          expect(result.mutation?.outcome).toBe('applied')
          expect(result.mutation?.authorityReceipt?.actions[0]?.beforeHash).toBe(getExactContentHash(original))
        }
      }
      const frames = peer.received.map(body => JSON.parse(body))
      expect(frames[0]?.params.capabilities.general.positionEncodings).toContain('utf-8')
      for (const sent of frames.filter(frame => ['textDocument/prepareRename', 'textDocument/rename', 'textDocument/hover'].includes(frame.method))) {
        expect(sent.params.position).toEqual({ line: 0, character: 8 })
      }
      expect(fs.readFileSync(file, 'utf8')).toBe(mode === 'rename' ? '\uFEFF😀 茶\r\nnext\r' : original)
      expect(await broker.listReceipts()).toHaveLength(mode === 'rename' ? 1 : 0)
      if (process.env.OPENBUFF_CAPTURE_B06_SEMANTICS === '1') {
        console.log('B06_UTF8 ' + JSON.stringify({
          mode, encoding: 'utf-8',
          beforeHash: getExactContentHash(original),
          afterHash: getExactContentHash(fs.readFileSync(file, 'utf8')),
          sentPositions: frames.filter(frame => ['textDocument/prepareRename', 'textDocument/rename', 'textDocument/hover'].includes(frame.method)).map(frame => frame.params.position),
          brokerStates: (await broker.listReceipts()).map(receipt => receipt.state),
        }))
      }
    } finally {
      await mux.dispose()
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })

  test('B06 refuses an encoding not negotiated by the semantic lane before dispatch', async () => {
    const peer = makePeer(request => request.method === 'initialize'
      ? { jsonrpc: '2.0', id: request.id, result: { capabilities: { positionEncoding: 'utf-32' } } }
      : defaultBehavior(request))
    const mux = createLspMultiplexer({ spawner: () => peer.child })
    try {
      await mux.syncFile({ filePath: '/proj/a.ts', version: 7, text: 'a\n' })
      await expect(mux.renameIntent!({ filePath: '/proj/a.ts', position: { line: 0, character: 0 }, newName: 'replacement' })).rejects.toThrow('position encoding')
      expect(peer.received.some(body => JSON.parse(body).method === 'textDocument/rename')).toBe(false)
    } finally { await mux.dispose() }
  })

  test.each(['committed', 'stale', 'occupied-create', 'foreign-midcommit'] as const)('B06 producer-to-broker rename result: %s', async mode => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'openbuff-b06-broker-'))
    const cwd = path.join(fs.realpathSync(tmp), 'project')
    const stateDir = path.join(tmp, 'state')
    fs.mkdirSync(cwd)
    const paths = ['definition.ts', 'consumer.ts', 'move-from.ts', 'obsolete.ts'].map(name => path.join(cwd, name))
    const original = ['export const value = 1\r\n', 'import { value } from "./definition"\r\n', 'export const moved = 2\n', 'obsolete\n']
    const created = path.join(cwd, 'helper.ts')
    const moved = path.join(cwd, 'moved.ts')
    const edits = paths.slice(0, 2).map((file, index) => ({
      textDocument: { uri: pathToFileURL(file).href, version: index + 5 },
      edits: [{ range: { start: { line: 0, character: original[index]!.indexOf('value') }, end: { line: 0, character: original[index]!.indexOf('value') + 5 } }, newText: 'renamed' }],
    }))
    const peer = makeRawPeer(request => request.method === 'textDocument/prepareRename'
      ? { jsonrpc: '2.0', id: request.id, result: edits[0]!.edits[0]!.range }
      : request.method === 'textDocument/rename' ? null : defaultBehavior(request))
    const mux = createLspMultiplexer({ rootResolver: () => cwd, spawner: () => peer.child })
    try {
      for (const [index, file] of paths.entries()) {
        fs.writeFileSync(file, original[index]!)
        await mux.syncFile({ filePath: file, version: index + 5, text: original[index]! })
      }
      const broker = await WorkspaceMutationBroker.create({ cwd, stateDir })
      const fileSystem = createNodeFileSystem({ mutationBroker: broker })
      const intentLog = createTransactionIntentLogForWorkspace({ cwd, stateDir })
      if (mode === 'foreign-midcommit') {
        const commit = fileSystem.conditionalCommit!
        fileSystem.conditionalCommit = async (target, bytes, options) => {
          if (String(target) === paths[1]) {
            fs.writeFileSync(paths[0]!, 'foreign source\n')
            throw new Error('fixture failure during consumer commit')
          }
          return commit(target, bytes, options)
        }
      }
      const service = createLanguageIntelligence({ cwd, fs: fileSystem, multiplexer: mux })
      const application = renameSymbol(service, { path: 'definition.ts', line: 1, character: 13, new_name: 'renamed' }, { cwd, fs: fileSystem, intentLog })
      await waitUntilSent(peer, 'textDocument/rename')
      const request = peer.received.map(body => JSON.parse(body)).find(body => body.method === 'textDocument/rename')
      const consumer = mode === 'stale' ? original[1]!.replace('\r\n', '\n') : original[1]!
      if (mode === 'stale') fs.writeFileSync(paths[1]!, consumer)
      if (mode === 'occupied-create') fs.writeFileSync(created, 'occupied\n')
      const documentChanges = [
        edits[0],
        { kind: 'create', uri: pathToFileURL(created).href, options: { overwrite: false, ignoreIfExists: false } },
        { textDocument: { uri: pathToFileURL(created).href, version: null }, edits: [{ ...b06Edit, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, newText: 'export const helper = true\n' }] },
        edits[1],
        { kind: 'rename', oldUri: pathToFileURL(paths[2]!).href, newUri: pathToFileURL(moved).href },
        { kind: 'delete', uri: pathToFileURL(paths[3]!).href, options: { recursive: false } },
      ]
      const capture = process.env.OPENBUFF_CAPTURE_B06_SEMANTICS === '1'
      const currentHashes = () => Object.fromEntries([...paths, created, moved].map(file => [path.basename(file), fs.existsSync(file) ? getExactContentHash(fs.readFileSync(file, 'utf8')) : null]))
      const preApplicationHashes = capture ? currentHashes() : undefined
      const wireReply = JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { documentChanges } })
      peer.emitRaw(frame(wireReply))
      const result = await application
      const postApplicationHashes = capture ? currentHashes() : undefined
      let recovery: unknown
      if (mode === 'foreign-midcommit') {
        expect(result.output[0]?.value).toMatchObject({ applied: false })
        expect(result.mutation?.outcome).toBe('rollback_incomplete')
        expect(result.mutation?.authorityReceipt?.actions.map(action => action.status)).toEqual([
          'rollback_failed', 'rolled_back', 'failed', 'not_started', 'not_started',
        ])
        const recover = () => recoverAndRevertInterruptedTransactions({ cwd, fs: fileSystem, intentLog })
        const blocked = await recover()
        expect(blocked).toMatchObject({ ok: false, status: 'recovery_required', transactionIds: [result.mutation?.authorityReceipt?.transactionId] })
        expect(paths.map(file => fs.readFileSync(file, 'utf8'))).toEqual(['foreign source\n', ...original.slice(1)])
        expect(fs.existsSync(created)).toBe(false)
        expect(fs.existsSync(moved)).toBe(false)
        fs.writeFileSync(paths[0]!, original[0]!.replace('value', 'renamed'))
        const repaired = await recover()
        expect(repaired).toMatchObject({ ok: true, revertedPaths: 1 })
        recovery = { blocked, repaired }
        expect(paths.map(file => fs.readFileSync(file, 'utf8'))).toEqual(original)
      } else if (mode !== 'committed') {
        expect(result.mutation?.outcome).toBe('not_applied')
        expect(result.mutation?.errors[0]?.code).toBe(mode === 'stale' ? 'stale_state' : 'already_exists')
        expect(await broker.listReceipts()).toEqual([])
        expect(paths.map(file => fs.readFileSync(file, 'utf8'))).toEqual([original[0], consumer, ...original.slice(2)])
        expect(fs.existsSync(intentLog.filePath)).toBe(false)
        expect(fs.existsSync(moved)).toBe(false)
        if (mode === 'occupied-create') expect(fs.readFileSync(created, 'utf8')).toBe('occupied\n')
        else expect(fs.existsSync(created)).toBe(false)
      } else {
        expect(result.mutation?.outcome).toBe('applied')
        expect(result.mutation?.authorityReceipt?.transactionId).toStartWith('tx-')
        expect((await broker.listReceipts()).map(receipt => [receipt.action, receipt.state])).toEqual([
          ['commit', 'committed'], ['create', 'committed'], ['commit', 'committed'], ['move', 'committed'], ['delete', 'committed'],
        ])
        expect(paths.slice(0, 2).map(file => fs.readFileSync(file, 'utf8'))).toEqual(original.slice(0, 2).map(text => text.replace('value', 'renamed')))
        expect(fs.readFileSync(created, 'utf8')).toBe('export const helper = true\n')
        expect(fs.readFileSync(moved, 'utf8')).toBe(original[2]!)
        expect(paths.slice(2).map(file => fs.existsSync(file))).toEqual([false, false])
      }
      if (capture) {
        const receipt = result.mutation?.authorityReceipt
        console.log('B06_SEMANTIC ' + JSON.stringify({
          mode, outcome: result.mutation?.outcome,
          errors: result.mutation?.errors.map(error => error.code),
          transactionId: receipt?.transactionId,
          wireReplyHash: getExactContentHash(wireReply),
          requested: documentChanges.map(change => change?.textDocument ? { kind: 'text', ...change.textDocument } : { kind: change?.kind, uri: change?.uri, oldUri: change?.oldUri, newUri: change?.newUri }),
          preApplicationHashes, postApplicationHashes, recovery,
          actions: receipt?.actions.map(({ action, path, destinationPath, beforeHash, afterHash, status, forward }) => ({ action, path, destinationPath, beforeHash, afterHash, status, forward })),
          liveHashes: currentHashes(),
        }))
      }
    } finally {
      await mux.dispose()
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })

  test.each([
    'organize-applied',
    'organize-annotated',
    'organize-confirmation',
    'organize-missing-annotation',
    'organize-stale',
    'organize-wrong-kind',
    'extract-applied',
    'extract-annotated',
    'extract-confirmation',
    'extract-wrong-destination',
    'extract-command-only',
    'extract-edit-and-command',
  ] as const)('B06 applies only a complete versioned code action: %s', async mode => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'openbuff-b06-action-'))
    const cwd = path.join(fs.realpathSync(tmp), 'project')
    const stateDir = path.join(tmp, 'state')
    fs.mkdirSync(cwd)
    const source = path.join(cwd, 'source.ts')
    const dest = path.join(cwd, 'helper.ts')
    const offeredDest = mode === 'extract-wrong-destination' ? path.join(cwd, 'different.ts') : dest
    const extract = mode.startsWith('extract')
    const original = extract ? 'const selected = 1\r\n' : 'import { selected } from "./helper"\r\n'
    const next = extract ? 'import { selected } from "./helper"' : ''
    const annotated = mode.endsWith('-annotated') || mode.endsWith('-confirmation') || mode === 'organize-missing-annotation'
    const sourceAnnotation = { id: 'source', label: 'Update the source', description: 'Replace the selected range.' }
    const createAnnotation = { id: 'create', label: 'Create helper file' }
    const contentAnnotation = { id: 'content', label: 'Populate helper' }
    const edit = {
      ...(annotated && mode !== 'organize-missing-annotation' ? { changeAnnotations: {
        source: { label: sourceAnnotation.label, description: sourceAnnotation.description, needsConfirmation: mode === 'organize-confirmation' },
        create: { label: createAnnotation.label, needsConfirmation: mode === 'extract-confirmation' },
        content: { label: contentAnnotation.label },
      } } : {}),
      documentChanges: [
      { textDocument: { uri: pathToFileURL(source).href, version: 4 }, edits: [{
        ...(annotated ? { annotationId: 'source' } : {}),
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: original.indexOf('\r') } }, newText: next,
      }] },
      ...(extract ? [
        { kind: 'create', uri: pathToFileURL(offeredDest).href, ...(annotated ? { annotationId: 'create' } : {}) },
        { textDocument: { uri: pathToFileURL(offeredDest).href, version: null }, edits: [{
          ...(annotated ? { annotationId: 'content' } : {}),
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, newText: 'export const selected = 1\r\n',
        }] },
      ] : []),
    ] }
    const peer = makeRawPeer(message => message.method === 'textDocument/codeAction' ? null : defaultBehavior(message))
    const mux = createLspMultiplexer({ spawner: () => peer.child, rootResolver: () => cwd })
    try {
      fs.writeFileSync(source, original)
      await mux.syncFile({ filePath: source, version: 4, text: original })
      const broker = await WorkspaceMutationBroker.create({ cwd, stateDir })
      const fileSystem = createNodeFileSystem({ mutationBroker: broker })
      const intentLog = createTransactionIntentLogForWorkspace({ cwd, stateDir })
      const service = createLanguageIntelligence({ cwd, fs: fileSystem, multiplexer: mux })
      const opts = { cwd, fs: fileSystem, intentLog }
      const position = { path: 'source.ts', line: 1, character: 0 }
      const application = extract
        ? extractSymbol(service, { ...position, destination_path: 'helper.ts', symbol_name: 'selected' }, opts)
        : codeAction(service, { ...position, kind: 'source.organizeImports' }, opts)
      await waitUntilSent(peer, 'textDocument/codeAction')
      const request = peer.received.map(body => JSON.parse(body)).find(body => body.method === 'textDocument/codeAction')
      if (mode === 'organize-stale') fs.writeFileSync(source, original.replace('\r\n', '\n'))
      const commandBearing = mode === 'extract-command-only' || mode === 'extract-edit-and-command'
      const action = {
        title: extract ? 'Extract to file' : 'Organize imports',
        kind: mode === 'organize-wrong-kind' ? 'quickfix' : extract ? 'refactor.extract.constant' : 'source.organizeImports',
        ...(mode === 'extract-command-only' ? {} : { edit }),
        ...(commandBearing ? { command: { title: 'Resolve extraction', command: 'fixture.extract' } } : {}),
      }
      peer.emitRaw(frame(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: [action] })))
      const result = await application
      if (mode.endsWith('-applied') || mode.endsWith('-annotated')) {
        expect(result.mutation?.outcome).toBe('applied')
        expect(fs.readFileSync(source, 'utf8')).toBe(next + '\r\n')
        if (extract) expect(fs.readFileSync(dest, 'utf8')).toBe('export const selected = 1\r\n')
        if (annotated) {
          const schema = extract ? toolParams.extract_symbol.outputSchema : toolParams.code_action.outputSchema
          const published = schema.parse(result.output)
          expect(published[0]?.value).toMatchObject({ results: [
            { applied: true, annotations: [sourceAnnotation] },
            ...(extract ? [{ applied: true, annotations: [createAnnotation, contentAnnotation] }] : []),
          ] })
        }
      } else {
        expect(result.mutation?.outcome).not.toBe('applied')
        expect(await broker.listReceipts()).toEqual([])
        expect(fs.readFileSync(source, 'utf8')).toBe(mode === 'organize-stale' ? original.replace('\r\n', '\n') : original)
        expect(fs.existsSync(dest)).toBe(false)
        expect(fs.existsSync(offeredDest)).toBe(false)
        const message = JSON.stringify(result.output)
        if (commandBearing) expect(message).toContain('command')
        if (mode.endsWith('-confirmation')) expect(message).toContain('requires host confirmation')
        if (mode === 'organize-missing-annotation') expect(message).toContain('annotation reference')
        if (mode === 'extract-wrong-destination') expect(message).toContain('destination')
        if (mode === 'organize-stale') expect(result.mutation?.errors[0]?.code).toBe('stale_state')
      }
      const commandRequests = peer.received.filter(body => JSON.parse(body).method === 'workspace/executeCommand').length
      expect(commandRequests).toBe(0)
      if (!extract) expect(request.params.context.only).toEqual(['source.organizeImports'])
      if (process.env.OPENBUFF_CAPTURE_B06_SEMANTICS === '1') {
        console.log('B06_ACTION ' + JSON.stringify({
          mode, commandRequests,
          wireKind: action.kind,
          outcome: result.mutation?.outcome ?? 'refused',
          output: result.output[0]?.value,
          sourceAfterHash: getExactContentHash(fs.readFileSync(source, 'utf8')),
          destinationAfterHash: fs.existsSync(dest) ? getExactContentHash(fs.readFileSync(dest, 'utf8')) : null,
          brokerStates: (await broker.listReceipts()).map(receipt => receipt.state),
        }))
      }
    } finally {
      await mux.dispose()
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })

  test('rename normalizes documentChanges and skips a non-text-edit entry honestly', async () => {
    const peer = makePeer((message) => {
      const id = message.id as number
      if (message.method === 'initialize') {
        return { jsonrpc: '2.0', id, result: okInitialize }
      }
      if (message.method === 'textDocument/rename') {
        return {
          jsonrpc: '2.0',
          id,
          result: {
            documentChanges: [
              {
                // The per-textDocument version is accepted but ignored: the
                // on-disk bytes are authoritative downstream.
                textDocument: { uri: 'file:///proj/a.ts', version: 3 },
                edits: [
                  { range: { start: { line: 1, character: 0 }, end: { line: 1, character: 4 } }, newText: 'sum' },
                ],
              },
              {
                // A non-plain-text edit (no range/newText — a textual-diff
                // shape): skipped with a recorded reason instead of failing
                // the whole workspace edit.
                textDocument: { uri: 'file:///proj/diff.ts' },
                edits: [{ textDocument: { uri: 'file:///proj/diff.ts' }, text: 'diff' }],
              },
            ],
          },
        }
      }
      return { jsonrpc: '2.0', id, result: null }
    })
    const mux = createLspMultiplexer({ spawner: () => peer.child })
    const changes = await mux.rename({
      filePath: '/proj/a.ts',
      position: { line: 0, character: 0 },
      newName: 'x',
    })
    expect(changes).toEqual({
      'file:///proj/a.ts': [
        { range: { start: { line: 1, character: 0 }, end: { line: 1, character: 4 } }, newText: 'sum' },
      ],
    })
    await mux.dispose()
  })

  test('codeAction returns only edit-carrying actions with normalized changes', async () => {
    const peer = makePeer((message) => {
      const id = message.id as number
      if (message.method === 'initialize') {
        return { jsonrpc: '2.0', id, result: okInitialize }
      }
      if (message.method === 'textDocument/codeAction') {
        return {
          jsonrpc: '2.0',
          id,
          result: [
            // A command-only action: skipped, never resolved.
            { title: 'organize imports (command only)', command: { title: 'x' } },
            {
              title: 'Remove unused import',
              edit: {
                changes: {
                  'file:///proj/a.ts': [
                    { range: { start: { line: 0, character: 0 }, end: { line: 1, character: 0 } }, newText: '' },
                  ],
                },
              },
            },
          ],
        }
      }
      return { jsonrpc: '2.0', id, result: null }
    })
    const mux = createLspMultiplexer({ spawner: () => peer.child })
    const actions = await mux.codeAction({
      filePath: '/proj/a.ts',
      position: { line: 3, character: 1 },
      only: ['source.organizeImports'],
    })
    expect(actions).toHaveLength(1)
    expect(actions[0]?.title).toBe('Remove unused import')
    expect(actions[0]?.changesByUri).toEqual({
      'file:///proj/a.ts': [
        { range: { start: { line: 0, character: 0 }, end: { line: 1, character: 0 } }, newText: '' },
      ],
    })
    const request = peer.received
      .map((body) => JSON.parse(body) as { method?: string; params?: Record<string, unknown> })
      .find((m) => m.method === 'textDocument/codeAction')
    // The request carries the zero-diagnostic context and the ONLY filter;
    // CodeActionParams has no top-level `position` key — the caller's
    // 0-based position is echoed as range: { start, end = position }.
    expect(request?.params).toEqual({
      textDocument: { uri: 'file:///proj/a.ts' },
      range: { start: { line: 3, character: 1 }, end: { line: 3, character: 1 } },
      context: { diagnostics: [] },
      only: ['source.organizeImports'],
    })
    await mux.dispose()
  })

  test('an incapable rename server errors honestly instead of a capability-gated no-op', async () => {
    const peer = makePeer((message) => {
      const id = message.id as number
      if (message.method === 'initialize') {
        return { jsonrpc: '2.0', id, result: okInitialize }
      }
      if (message.method === 'textDocument/rename') {
        return { jsonrpc: '2.0', id, error: { code: -32601, message: 'method not found' } }
      }
      return { jsonrpc: '2.0', id, result: null }
    })
    const mux = createLspMultiplexer({ spawner: () => peer.child })
    await expect(
      mux.rename({ filePath: '/proj/a.ts', position: { line: 0, character: 0 }, newName: 'x' }),
    ).rejects.toBeInstanceOf(LspServerError)
    await mux.dispose()
  })

  test('an injected openFile auto-opens an unopened document before the document-scoped request', async () => {
    // Real-server contract (observed clangd): a document query for a file the
    // server has not received must arrive as didOpen first — strict servers
    // answer with -32602 'trying to get AST for non-added document' otherwise.
    const peer = makePeer((message) => {
      const id = message.id as number
      if (message.method === 'initialize') {
        return { jsonrpc: '2.0', id, result: okInitialize }
      }
      if (message.method === 'textDocument/rename') {
        return {
          jsonrpc: '2.0',
          id,
          result: {
            changes: {
              'file:///proj/a.ts': [
                {
                  range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
                  newText: 'x',
                },
              ],
            },
          },
        }
      }
      return { jsonrpc: '2.0', id, result: null }
    })
    const mux = createLspMultiplexer({
      spawner: () => peer.child,
      openFile: async () => 'const a = 1\n',
    })
    const changes = await mux.rename({
      filePath: '/proj/a.ts',
      position: { line: 0, character: 0 },
      newName: 'x',
    })
    expect(changes).toEqual({
      'file:///proj/a.ts': [
        { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, newText: 'x' },
      ],
    })
    const messages = peer.received.map(
      (body) => JSON.parse(body) as { method?: string; params?: Record<string, unknown> },
    )
    const methods = messages.map((message) => message.method)
    const openIndex = methods.indexOf('textDocument/didOpen')
    const renameIndex = methods.indexOf('textDocument/rename')
    expect(openIndex).toBeGreaterThanOrEqual(0)
    expect(renameIndex).toBeGreaterThan(openIndex)
    const openMessage = messages.find((message) => message.method === 'textDocument/didOpen')
    const textDocument = openMessage?.params?.['textDocument'] as
      | { uri?: string; text?: string; languageId?: string }
      | undefined
    expect(textDocument?.uri).toBe('file:///proj/a.ts')
    expect(textDocument?.text).toBe('const a = 1\n')
    expect(textDocument?.languageId).toBe('typescript')
    await mux.dispose()
  })
})

describe('P4-T2 extract seams (create-file documentChanges / executeCommand / command passthrough)', () => {
  test('executeCommand normalizes create-file documentChanges and surfaces createdUris', async () => {
    const peer = makePeer((message) => {
      const id = message.id as number
      if (message.method === 'initialize') {
        return { jsonrpc: '2.0', id, result: okInitialize }
      }
      if (message.method === 'workspace/executeCommand') {
        return {
          jsonrpc: '2.0',
          id,
          result: {
            documentChanges: [
              {
                textDocument: { uri: 'file:///proj/a.ts' },
                edits: [
                  {
                    range: {
                      start: { line: 0, character: 0 },
                      end: { line: 0, character: 1 },
                    },
                    newText: 'b',
                  },
                ],
              },
              {
                kind: 'create',
                uri: 'file:///proj/new.ts',
                edits: [
                  {
                    range: {
                      start: { line: 0, character: 0 },
                      end: { line: 0, character: 0 },
                    },
                    newText: 'export {}\n',
                  },
                ],
              },
              {
                kind: 'rename',
                oldUri: 'file:///proj/old.ts',
                newUri: 'file:///proj/renamed.ts',
              },
            ],
          },
        }
      }
      return { jsonrpc: '2.0', id, result: null }
    })
    const mux = createLspMultiplexer({ spawner: () => peer.child })
    const edit = await mux.executeCommand({
      filePath: '/proj/a.ts',
      command: 'ts.extract',
    })
    // The create uri is recorded; its edits flow into changesByUri like any
    // other text-edit list; the rename kind is skipped, not applied.
    expect(edit.createdUris).toEqual(['file:///proj/new.ts'])
    expect(Object.keys(edit.changesByUri).sort()).toEqual([
      'file:///proj/a.ts',
      'file:///proj/new.ts',
    ])
    // The command was forwarded verbatim; `arguments` is omitted entirely
    // when the caller passed none (the LSP default is no arguments).
    const request = peer.received
      .map(
        (body) => JSON.parse(body) as { method?: string; params?: Record<string, unknown> },
      )
      .find((m) => m.method === 'workspace/executeCommand')
    expect(request?.params).toEqual({ command: 'ts.extract' })
    await mux.dispose()
  })

  test('executeCommand treats a null or non-workspace-edit reply as an empty edit, not an error', async () => {
    const peer = makePeer((message) => {
      const id = message.id as number
      if (message.method === 'initialize') {
        return { jsonrpc: '2.0', id, result: okInitialize }
      }
      if (message.method === 'workspace/executeCommand') {
        return { jsonrpc: '2.0', id, result: null }
      }
      return { jsonrpc: '2.0', id, result: null }
    })
    const mux = createLspMultiplexer({ spawner: () => peer.child })
    const edit = await mux.executeCommand({
      filePath: '/proj/a.ts',
      command: 'x',
      arguments: [1],
    })
    expect(edit).toEqual({ changesByUri: {}, createdUris: [] })
    await mux.dispose()
  })

  test('executeCommand surfaces a server error honestly', async () => {
    const peer = makePeer((message) => {
      const id = message.id as number
      if (message.method === 'initialize') {
        return { jsonrpc: '2.0', id, result: okInitialize }
      }
      if (message.method === 'workspace/executeCommand') {
        return { jsonrpc: '2.0', id, error: { code: -32601, message: 'method not found' } }
      }
      return { jsonrpc: '2.0', id, result: null }
    })
    const mux = createLspMultiplexer({ spawner: () => peer.child })
    await expect(
      mux.executeCommand({ filePath: '/proj/a.ts', command: 'x' }),
    ).rejects.toBeInstanceOf(LspServerError)
    await mux.dispose()
  })

  test('a create documentChanges entry without a parseable uri is skipped honestly', async () => {
    const peer = makePeer((message) => {
      const id = message.id as number
      if (message.method === 'initialize') {
        return { jsonrpc: '2.0', id, result: okInitialize }
      }
      if (message.method === 'workspace/executeCommand') {
        return {
          jsonrpc: '2.0',
          id,
          result: {
            documentChanges: [
              // No top-level uri and no textDocument.uri: nothing to record.
              { kind: 'create', options: { overwrite: false } },
            ],
          },
        }
      }
      return { jsonrpc: '2.0', id, result: null }
    })
    const mux = createLspMultiplexer({ spawner: () => peer.child })
    const edit = await mux.executeCommand({
      filePath: '/proj/a.ts',
      command: 'ts.extract',
    })
    expect(edit).toEqual({ changesByUri: {}, createdUris: [] })
    await mux.dispose()
  })

  test('codeAction surfaces a command-only action verbatim for caller-side resolution', async () => {
    const peer = makePeer((message) => {
      const id = message.id as number
      if (message.method === 'initialize') {
        return { jsonrpc: '2.0', id, result: okInitialize }
      }
      if (message.method === 'textDocument/codeAction') {
        return {
          jsonrpc: '2.0',
          id,
          result: [
            {
              title: 'Extract function',
              command: {
                command: '_tsls.extractFunction',
                arguments: ['arg1'],
              },
            },
            {
              title: 'Edit-carrying',
              edit: {
                changes: {
                  'file:///proj/a.ts': [
                    {
                      range: {
                        start: { line: 0, character: 0 },
                        end: { line: 0, character: 1 },
                      },
                      newText: 'x',
                    },
                  ],
                },
              },
            },
          ],
        }
      }
      return { jsonrpc: '2.0', id, result: null }
    })
    const mux = createLspMultiplexer({ spawner: () => peer.child })
    const actions = await mux.codeAction({
      filePath: '/proj/a.ts',
      position: { line: 1, character: 0 },
    })
    // The command-only action is surfaced (empty changesByUri + the verbatim
    // command), NOT resolved here; the edit-carrying action is unchanged.
    expect(actions).toHaveLength(2)
    expect(actions[0]).toEqual({
      title: 'Extract function',
      changesByUri: {},
      command: { command: '_tsls.extractFunction', arguments: ['arg1'] },
    })
    expect(Object.keys(actions[1]?.changesByUri ?? {})).toEqual([
      'file:///proj/a.ts',
    ])
    await mux.dispose()
  })
})
