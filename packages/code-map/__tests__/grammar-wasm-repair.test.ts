import { afterEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import { createHash } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'

import {
  computeRetryDelayMs,
  getPinnedGrammarAssetUrl,
  PINNED_GRAMMAR_ASSETS,
  REPAIR_RETRY_BASE_DELAY_MS,
  repairGrammarWasm,
  resolveGrammarWasmSource,
} from '../src/grammar-wasm-repair'
import { LANGUAGE_WASM_FILES } from '../src/wasm-files'

describe('grammar WASM repair', () => {
  const roots: string[] = []

  afterEach(() => {
    for (const root of roots.splice(0)) {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test('writes only checksum-verified pinned grammar bytes', async () => {
    const targetDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'openbuff-grammar-repair-'),
    )
    roots.push(targetDir)
    const sourcePath =
      require.resolve('tree-sitter-wasms/out/tree-sitter-javascript.wasm')
    const bytes = fs.readFileSync(sourcePath)
    const repaired = await repairGrammarWasm({
      wasmFile: 'tree-sitter-javascript.wasm',
      targetDir,
      fetchImpl: async () => new Response(bytes) as Response,
    })

    expect(repaired).toBe(path.join(targetDir, 'tree-sitter-javascript.wasm'))
    expect(fs.readFileSync(repaired!)).toEqual(bytes)
  })

  test('pins verified repair bytes for every advertised language', () => {
    const repoRoot = path.resolve(import.meta.dir, '../../..')
    expect(Object.keys(PINNED_GRAMMAR_ASSETS).sort()).toEqual(
      [...LANGUAGE_WASM_FILES].sort(),
    )
    for (const wasmFile of LANGUAGE_WASM_FILES) {
      const asset = PINNED_GRAMMAR_ASSETS[wasmFile]!
      expect(getPinnedGrammarAssetUrl(wasmFile)).toMatch(/^https:\/\//)
      if (asset.sourceUrl) {
        expect(asset.sourceUrl).toContain(
          '/2e416060c2f70e99d46d09382f90523d6bd75993/',
        )
        expect(asset.sha256).toMatch(/^[a-f0-9]{64}$/)
        continue
      }
      const packageDir =
        asset.packageName === 'tree-sitter-wasms' ? 'out' : 'wasm'
      const source = path.join(
        repoRoot,
        'node_modules',
        asset.packageName,
        packageDir,
        asset.remoteFile,
      )
      expect(fs.existsSync(source), wasmFile).toBe(true)
      expect(
        createHash('sha256').update(fs.readFileSync(source)).digest('hex'),
      ).toBe(asset.sha256)
    }
  })

  test('rejects unpinned or checksum-mismatched bytes', async () => {
    const targetDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'openbuff-grammar-repair-'),
    )
    roots.push(targetDir)
    const fetchImpl = async () => new Response('not a grammar') as Response

    expect(
      await repairGrammarWasm({
        wasmFile: 'tree-sitter-javascript.wasm',
        targetDir,
        fetchImpl,
      }),
    ).toBeNull()
    expect(
      await repairGrammarWasm({
        wasmFile: 'tree-sitter-kotlin.wasm',
        targetDir,
        fetchImpl,
      }),
    ).toBeNull()
  })

  test('retries transient network failures and succeeds on a later attempt', async () => {
    const targetDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'openbuff-grammar-repair-'),
    )
    roots.push(targetDir)
    const sourcePath =
      require.resolve('tree-sitter-wasms/out/tree-sitter-javascript.wasm')
    const bytes = fs.readFileSync(sourcePath)
    let fetchCalls = 0

    const repaired = await repairGrammarWasm({
      wasmFile: 'tree-sitter-javascript.wasm',
      targetDir,
      retryDelayMs: 0,
      fetchImpl: async () => {
        fetchCalls++
        if (fetchCalls === 1) throw new Error('socket hang up')
        return new Response(bytes) as Response
      },
    })

    expect(fetchCalls).toBe(2)
    expect(repaired).toBe(path.join(targetDir, 'tree-sitter-javascript.wasm'))
    expect(fs.readFileSync(repaired!)).toEqual(bytes)
  })

  test('retries retryable 5xx and 429 responses before succeeding', async () => {
    const targetDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'openbuff-grammar-repair-'),
    )
    roots.push(targetDir)
    const sourcePath =
      require.resolve('tree-sitter-wasms/out/tree-sitter-javascript.wasm')
    const bytes = fs.readFileSync(sourcePath)
    let fetchCalls = 0

    const repaired = await repairGrammarWasm({
      wasmFile: 'tree-sitter-javascript.wasm',
      targetDir,
      retryDelayMs: 0,
      fetchImpl: async () => {
        fetchCalls++
        if (fetchCalls === 1) {
          return new Response('service unavailable', {
            status: 503,
          }) as Response
        }
        if (fetchCalls === 2) {
          return new Response('too many requests', { status: 429 }) as Response
        }
        return new Response(bytes) as Response
      },
    })

    expect(fetchCalls).toBe(3)
    expect(repaired).toBe(path.join(targetDir, 'tree-sitter-javascript.wasm'))
    expect(fs.readFileSync(repaired!)).toEqual(bytes)
  })

  test('does not retry a sha256 mismatch and reports the distinct reason', async () => {
    const targetDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'openbuff-grammar-repair-'),
    )
    roots.push(targetDir)
    let fetchCalls = 0
    const failureReasons: string[] = []

    const repaired = await repairGrammarWasm({
      wasmFile: 'tree-sitter-javascript.wasm',
      targetDir,
      retryDelayMs: 0,
      fetchImpl: async () => {
        fetchCalls++
        return new Response('not a grammar') as Response
      },
      onFailure: (reason) => {
        failureReasons.push(reason)
      },
    })

    expect(fetchCalls).toBe(1)
    expect(repaired).toBeNull()
    expect(failureReasons).toEqual([
      'downloaded bytes failed sha256 verification',
    ])
  })

  test('gives up after three attempts and reports the last retryable status', async () => {
    const targetDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'openbuff-grammar-repair-'),
    )
    roots.push(targetDir)
    let fetchCalls = 0
    const failureReasons: string[] = []

    const repaired = await repairGrammarWasm({
      wasmFile: 'tree-sitter-javascript.wasm',
      targetDir,
      retryDelayMs: 0,
      fetchImpl: async () => {
        fetchCalls++
        return new Response('overloaded', { status: 503 }) as Response
      },
      onFailure: (reason) => {
        failureReasons.push(reason)
      },
    })

    expect(fetchCalls).toBe(3)
    expect(repaired).toBeNull()
    expect(failureReasons).toEqual(['HTTP 503 after 3 attempts'])
  })

  test('reports the last observable failure when a network error precedes retryable statuses', async () => {
    const targetDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'openbuff-grammar-repair-'),
    )
    roots.push(targetDir)
    let fetchCalls = 0
    const failureReasons: string[] = []

    const repaired = await repairGrammarWasm({
      wasmFile: 'tree-sitter-javascript.wasm',
      targetDir,
      retryDelayMs: 0,
      fetchImpl: async () => {
        fetchCalls++
        if (fetchCalls === 1) throw new Error('socket hang up')
        return new Response('overloaded', { status: 503 }) as Response
      },
      onFailure: (reason) => {
        failureReasons.push(reason)
      },
    })

    expect(fetchCalls).toBe(3)
    expect(repaired).toBeNull()
    expect(failureReasons).toEqual(['HTTP 503 after 3 attempts'])
  })

  test('reports the last observable failure when retryable statuses precede a network error', async () => {
    const targetDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'openbuff-grammar-repair-'),
    )
    roots.push(targetDir)
    let fetchCalls = 0
    const failureReasons: string[] = []

    const repaired = await repairGrammarWasm({
      wasmFile: 'tree-sitter-javascript.wasm',
      targetDir,
      retryDelayMs: 0,
      fetchImpl: async () => {
        fetchCalls++
        if (fetchCalls < 3) {
          return new Response('overloaded', { status: 503 }) as Response
        }
        throw new Error('connection reset by peer')
      },
      onFailure: (reason) => {
        failureReasons.push(reason)
      },
    })

    expect(fetchCalls).toBe(3)
    expect(repaired).toBeNull()
    expect(failureReasons).toEqual([
      'network error after 3 attempts: connection reset by peer',
    ])
  })

  test('releases discarded response bodies for retryable and non-retryable failures', async () => {
    const targetDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'openbuff-grammar-repair-'),
    )
    roots.push(targetDir)
    const cancelCountGetters: Array<() => number> = []
    const trackedFailureResponse = (status: number): Response => {
      let cancelCount = 0
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('discarded body'))
          controller.close()
        },
        cancel() {
          cancelCount++
        },
      })
      cancelCountGetters.push(() => cancelCount)
      return new Response(body, { status }) as Response
    }

    const retryable = await repairGrammarWasm({
      wasmFile: 'tree-sitter-javascript.wasm',
      targetDir,
      retryDelayMs: 0,
      fetchImpl: async () => trackedFailureResponse(503),
    })
    expect(retryable).toBeNull()
    expect(cancelCountGetters.map((getCount) => getCount())).toEqual([1, 1, 1])

    cancelCountGetters.length = 0
    const nonRetryable = await repairGrammarWasm({
      wasmFile: 'tree-sitter-javascript.wasm',
      targetDir,
      retryDelayMs: 0,
      fetchImpl: async () => trackedFailureResponse(404),
    })
    expect(nonRetryable).toBeNull()
    expect(cancelCountGetters.map((getCount) => getCount())).toEqual([1])
  })

  test('uses checksum-pinned repair when installed package candidates are missing', async () => {
    const targetDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'openbuff-grammar-resolver-'),
    )
    roots.push(targetDir)
    const repairedPath = path.join(targetDir, 'tree-sitter-gdscript.wasm')
    let repairCalls = 0

    const resolved = await resolveGrammarWasmSource({
      wasmFile: 'tree-sitter-gdscript.wasm',
      candidates: [path.join(targetDir, 'missing-package-asset.wasm')],
      repairDir: targetDir,
      repairImpl: async () => {
        repairCalls++
        fs.writeFileSync(repairedPath, 'verified wasm fixture')
        return repairedPath
      },
    })

    expect(resolved).toBe(repairedPath)
    expect(repairCalls).toBe(1)
  })

  test('prefers installed package assets without invoking network repair', async () => {
    const targetDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'openbuff-grammar-resolver-'),
    )
    roots.push(targetDir)
    const installedPath =
      require.resolve('tree-sitter-wasms/out/tree-sitter-javascript.wasm')

    const resolved = await resolveGrammarWasmSource({
      wasmFile: 'tree-sitter-javascript.wasm',
      candidates: [installedPath],
      repairDir: targetDir,
      repairImpl: async () => {
        throw new Error('repair should not run')
      },
    })

    expect(resolved).toBe(installedPath)
  })

  test('rejects an installed candidate whose checksum does not match the pin', async () => {
    const targetDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'openbuff-grammar-resolver-'),
    )
    roots.push(targetDir)
    const pollutedPath = path.join(targetDir, 'polluted.wasm')
    const repairedPath = path.join(targetDir, 'repaired.wasm')
    fs.writeFileSync(pollutedPath, 'untrusted extra package file')

    const resolved = await resolveGrammarWasmSource({
      wasmFile: 'tree-sitter-gdscript.wasm',
      candidates: [pollutedPath],
      repairDir: targetDir,
      repairImpl: async () => {
        fs.writeFileSync(repairedPath, 'verified by repair contract')
        return repairedPath
      },
    })

    expect(resolved).toBe(repairedPath)
  })

  test('explains why checksum-pinned repair failed when retries are exhausted', async () => {
    const targetDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'openbuff-grammar-resolver-'),
    )
    roots.push(targetDir)
    let fetchCalls = 0

    await expect(
      resolveGrammarWasmSource({
        wasmFile: 'tree-sitter-gdscript.wasm',
        candidates: [path.join(targetDir, 'missing.wasm')],
        repairDir: targetDir,
        repairImpl: async (repairParams) =>
          repairGrammarWasm({
            ...repairParams,
            retryDelayMs: 0,
            fetchImpl: async () => {
              fetchCalls++
              throw new Error('connection reset by peer')
            },
          }),
      }),
    ).rejects.toThrow(
      'checksum-pinned repair failed: network error after 3 attempts: connection reset by peer',
    )
    expect(fetchCalls).toBe(3)
  })

  test('fails closed when neither package candidates nor pinned repair exist', async () => {
    const targetDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'openbuff-grammar-resolver-'),
    )
    roots.push(targetDir)

    await expect(
      resolveGrammarWasmSource({
        wasmFile: 'tree-sitter-gdscript.wasm',
        candidates: [path.join(targetDir, 'missing.wasm')],
        repairDir: targetDir,
        repairImpl: async () => null,
      }),
    ).rejects.toThrow('checksum-pinned repair failed')
  })

  test('rejects a body whose Content-Length exceeds the byte cap before streaming', async () => {
    // Regression for the M4-S6 unbounded-arrayBuffer finding: a hijacked
    // asset source declaring an oversized body must be rejected from its
    // headers, without buffering the bytes and before the sha256 check.
    const targetDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'openbuff-grammar-cap-len-'),
    )
    roots.push(targetDir)
    const failureReasons: string[] = []
    let cancelCount = 0
    // The body never closes: if the implementation streamed it, the attempt
    // would hang instead of failing fast from the declared length.
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(1024))
      },
      cancel() {
        cancelCount++
      },
    })

    const repaired = await repairGrammarWasm({
      wasmFile: 'tree-sitter-javascript.wasm',
      targetDir,
      fetchImpl: async () =>
        new Response(body, {
          headers: { 'content-length': String(8 * 1024 * 1024) },
        }) as Response,
      maxBodyBytes: 1024 * 1024,
      onFailure: (reason) => failureReasons.push(reason),
    })

    expect(repaired).toBeNull()
    expect(failureReasons).toEqual([
      'downloaded body missing or exceeded the 1048576-byte cap',
    ])
    // The rejected body was released rather than left holding its socket.
    expect(cancelCount).toBe(1)
    expect(
      fs.existsSync(path.join(targetDir, 'tree-sitter-javascript.wasm')),
    ).toBe(false)
  })

  test('aborts a body that streams past the byte cap mid-stream', async () => {
    // No Content-Length header: the cap must be enforced while streaming so
    // an unbounded body cannot force a huge allocation before hashing.
    const targetDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'openbuff-grammar-cap-stream-'),
    )
    roots.push(targetDir)
    const failureReasons: string[] = []
    const chunk = new Uint8Array(768 * 1024).fill(1)
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(chunk)
        controller.enqueue(chunk) // 1.5MB total > the 1MB test cap
        controller.close()
      },
    })

    const repaired = await repairGrammarWasm({
      wasmFile: 'tree-sitter-javascript.wasm',
      targetDir,
      fetchImpl: async () => new Response(body) as Response,
      maxBodyBytes: 1024 * 1024,
      onFailure: (reason) => failureReasons.push(reason),
    })

    expect(repaired).toBeNull()
    expect(failureReasons).toEqual([
      'downloaded body missing or exceeded the 1048576-byte cap',
    ])
    // Nothing was persisted from the oversized download.
    expect(fs.readdirSync(targetDir)).toEqual([])
  })

  test('honors Retry-After and backs off exponentially with jitter', () => {
    // Regression for the M4-S6 fixed-retry-delay finding: a Retry-After
    // header wins verbatim (seconds to ms), including an explicit 0.
    expect(computeRetryDelayMs(REPAIR_RETRY_BASE_DELAY_MS, 1, 7)).toBe(7000)
    expect(computeRetryDelayMs(REPAIR_RETRY_BASE_DELAY_MS, 2, 0)).toBe(0)
    // Without Retry-After: exponential backoff with jitter in [0.5x, 1x). The
    // jitter never makes the delay LONGER than the un-jittered backoff.
    expect(computeRetryDelayMs(2000, 1, null)).toBeLessThanOrEqual(2000)
    expect(computeRetryDelayMs(2000, 1, null)).toBeGreaterThanOrEqual(1000)
    expect(computeRetryDelayMs(2000, 3, null)).toBeLessThanOrEqual(8000)
    expect(computeRetryDelayMs(2000, 3, null)).toBeGreaterThan(2000)
  })

  test('re-verifies repaired bytes against the pin before returning them', async () => {
    // Regression for the M4-S6 load-rehash finding: bytes at the repaired
    // path must match the pin when the production repair output is loaded,
    // so a file swapped in between write and load is rejected.
    const targetDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'openbuff-grammar-rehash-'),
    )
    roots.push(targetDir)
    const gdscriptPath = path.join(targetDir, 'tree-sitter-gdscript.wasm')
    fs.writeFileSync(gdscriptPath, 'bytes swapped in after repair')

    await expect(
      resolveGrammarWasmSource({
        wasmFile: 'tree-sitter-gdscript.wasm',
        candidates: [path.join(targetDir, 'missing.wasm')],
        repairDir: targetDir,
        repairImpl: async () => gdscriptPath,
        forceRepairedBytesVerification: true,
      }),
    ).rejects.toThrow('repaired file no longer matches the pinned checksum')

    // Genuine pinned bytes resolve through the same verification path.
    const realBytes = fs.readFileSync(
      require.resolve('tree-sitter-wasms/out/tree-sitter-javascript.wasm'),
    )
    const jsPath = path.join(targetDir, 'tree-sitter-javascript.wasm')
    fs.writeFileSync(jsPath, realBytes)
    const resolved = await resolveGrammarWasmSource({
      wasmFile: 'tree-sitter-javascript.wasm',
      candidates: [path.join(targetDir, 'missing.wasm')],
      repairDir: targetDir,
      repairImpl: async () => jsPath,
      forceRepairedBytesVerification: true,
    })
    expect(resolved).toBe(jsPath)
  })
})
