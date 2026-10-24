import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'

import {
  SidecarArtifactError,
  resolveSidecarArtifact,
} from '../services/sidecar-artifact'
import type {
  SidecarArtifactDeps,
  SidecarArtifactFsSeam,
} from '../services/sidecar-artifact'

// Fully injected I/O: every test runs against an in-memory fs seam and a
// fake fetch — no real network, no real tmpdir pollution.

const ARTIFACT_URL = 'https://artifacts.example.test/sidecars/agent-v1.bin'
const ARTIFACT_BYTES = new TextEncoder().encode('sidecar-binary-payload')
// Absolute on every platform; never created on the real filesystem (the
// resolver only sees the injected seam).
const LOCAL_PATH = path.join(
  os.tmpdir(),
  'sidecar-artifact-test',
  'agent.bin',
)

function sha256Hex(data: Uint8Array | string): string {
  return createHash('sha256').update(data).digest('hex')
}

function expectedCachePath(cacheDir: string, url: string): string {
  return path.join(cacheDir, `${sha256Hex(url)}-agent-v1.bin`)
}

type FakeFile = { content: Buffer; mode?: number }

function makeFsSeam(): {
  seam: SidecarArtifactFsSeam
  files: Map<string, FakeFile>
  unlinked: string[]
} {
  const files = new Map<string, FakeFile>()
  const unlinked: string[] = []
  const seam: SidecarArtifactFsSeam = {
    async readFile(filePath) {
      const file = files.get(filePath)
      if (!file) {
        throw Object.assign(new Error(`ENOENT: ${filePath}`), {
          code: 'ENOENT',
        })
      }
      return file.content
    },
    async writeFile(filePath, data, options) {
      files.set(filePath, { content: Buffer.from(data), mode: options.mode })
    },
    async mkdir() {
      return undefined
    },
    async stat(filePath) {
      if (!files.has(filePath)) {
        throw Object.assign(new Error(`ENOENT: ${filePath}`), {
          code: 'ENOENT',
        })
      }
      return { isFile: () => true }
    },
    async unlink(filePath) {
      unlinked.push(filePath)
      files.delete(filePath)
    },
    async rename(from, to) {
      const file = files.get(from)
      if (!file) {
        throw Object.assign(new Error(`ENOENT: ${from}`), {
          code: 'ENOENT',
        })
      }
      files.delete(from)
      files.set(to, file)
    },
  }
  return { seam, files, unlinked }
}

function makeFetch(body: Uint8Array, calls: string[]): typeof fetch {
  return (async () => {
    calls.push(ARTIFACT_URL)
    return new Response(body)
  }) as unknown as typeof fetch
}

async function captureError(
  run: () => Promise<unknown>,
): Promise<SidecarArtifactError> {
  try {
    await run()
  } catch (error) {
    if (error instanceof SidecarArtifactError) return error
    throw error
  }
  throw new Error(
    'Expected resolveSidecarArtifact to reject with SidecarArtifactError',
  )
}

describe('resolveSidecarArtifact', () => {
  test('downloads, verifies, and caches a matching artifact (0600, byte-exact)', async () => {
    const { seam, files } = makeFsSeam()
    const calls: string[] = []
    const deps: SidecarArtifactDeps = {
      fetchImpl: makeFetch(ARTIFACT_BYTES, calls),
      fsSeam: seam,
      cacheDir: 'fake-cache',
    }

    const result = await resolveSidecarArtifact(
      { kind: 'download', url: ARTIFACT_URL, sha256: sha256Hex(ARTIFACT_BYTES) },
      deps,
    )

    const expectedPath = expectedCachePath('fake-cache', ARTIFACT_URL)
    expect(result.path).toBe(expectedPath)
    const cached = files.get(expectedPath)
    expect(cached).toBeDefined()
    expect(cached?.content.toString('hex')).toBe(
      Buffer.from(ARTIFACT_BYTES).toString('hex'),
    )
    expect(cached?.mode).toBe(0o600)

    // A second resolution is served from the verified cache without refetch.
    await resolveSidecarArtifact(
      { kind: 'download', url: ARTIFACT_URL, sha256: sha256Hex(ARTIFACT_BYTES) },
      deps,
    )
    expect(calls).toHaveLength(1)
  })

  test('rejects a checksum mismatch, names expected vs actual, and cleans up', async () => {
    const { seam, files, unlinked } = makeFsSeam()
    const expectedPath = expectedCachePath('fake-cache', ARTIFACT_URL)

    const error = await captureError(() =>
      resolveSidecarArtifact(
        {
          kind: 'download',
          url: ARTIFACT_URL,
          sha256: sha256Hex('other-bytes'),
        },
        {
          fetchImpl: makeFetch(ARTIFACT_BYTES, []),
          fsSeam: seam,
          cacheDir: 'fake-cache',
        },
      ),
    )

    expect(error).toBeInstanceOf(SidecarArtifactError)
    expect(error.reason).toBe('checksum-mismatch')
    expect(error.message).toContain(sha256Hex('other-bytes'))
    expect(error.message).toContain(sha256Hex(ARTIFACT_BYTES))
    // The manifest hash never landed on disk and the corrupt download left
    // no partial or tmp file behind.
    expect(files.has(expectedPath)).toBe(false)
    expect(unlinked).toContain(expectedPath)
    expect([...files.keys()].some((p) => p.includes('.tmp-'))).toBe(false)
  })

  test('re-downloads and verifies a corrupt cache entry instead of serving it', async () => {
    const { seam, files } = makeFsSeam()
    const expectedPath = expectedCachePath('fake-cache', ARTIFACT_URL)
    files.set(expectedPath, { content: Buffer.from('corrupt-payload') })
    const calls: string[] = []

    const result = await resolveSidecarArtifact(
      { kind: 'download', url: ARTIFACT_URL, sha256: sha256Hex(ARTIFACT_BYTES) },
      {
        fetchImpl: makeFetch(ARTIFACT_BYTES, calls),
        fsSeam: seam,
        cacheDir: 'fake-cache',
      },
    )

    // The corrupt entry was discarded: fetch ran exactly once and the cache
    // now holds the verified bytes.
    expect(calls).toHaveLength(1)
    expect(result.path).toBe(expectedPath)
    expect(files.get(expectedPath)?.content.toString('hex')).toBe(
      Buffer.from(ARTIFACT_BYTES).toString('hex'),
    )
  })

  test('maps a fetch rejection to reason "network"', async () => {
    const { seam, files } = makeFsSeam()

    const error = await captureError(() =>
      resolveSidecarArtifact(
        { kind: 'download', url: ARTIFACT_URL, sha256: sha256Hex(ARTIFACT_BYTES) },
        {
          fetchImpl: (async () => {
            throw new Error('dns failure')
          }) as unknown as typeof fetch,
          fsSeam: seam,
          cacheDir: 'fake-cache',
        },
      ),
    )

    expect(error.reason).toBe('network')
    expect(files.size).toBe(0)
  })

  test('maps an HTTP error status to reason "network"', async () => {
    const { seam } = makeFsSeam()

    const error = await captureError(() =>
      resolveSidecarArtifact(
        { kind: 'download', url: ARTIFACT_URL, sha256: sha256Hex(ARTIFACT_BYTES) },
        {
          fetchImpl: (async () => new Response(null, { status: 503 })) as unknown as typeof fetch,
          fsSeam: seam,
          cacheDir: 'fake-cache',
        },
      ),
    )

    expect(error.reason).toBe('network')
  })

  test('aborts bodies beyond the size cap with reason "too-large"', async () => {
    const { seam, files } = makeFsSeam()

    const error = await captureError(() =>
      resolveSidecarArtifact(
        { kind: 'download', url: ARTIFACT_URL, sha256: sha256Hex(ARTIFACT_BYTES) },
        {
          // maxDownloadBytes is a test-only seam lowering the production
          // 256 MiB cap so the incremental abort is exercised cheaply.
          fetchImpl: makeFetch(ARTIFACT_BYTES, []),
          fsSeam: seam,
          cacheDir: 'fake-cache',
          maxDownloadBytes: 4,
        },
      ),
    )

    expect(error.reason).toBe('too-large')
    expect(files.size).toBe(0)
  })

  test('rejects a malformed manifest sha256 with reason "invalid-source"', async () => {
    const { seam } = makeFsSeam()

    const error = await captureError(() =>
      resolveSidecarArtifact(
        { kind: 'download', url: ARTIFACT_URL, sha256: 'not-a-hash' },
        {
          fetchImpl: makeFetch(ARTIFACT_BYTES, []),
          fsSeam: seam,
          cacheDir: 'fake-cache',
        },
      ),
    )

    expect(error.reason).toBe('invalid-source')
  })

  test('honors the env seam for the cache directory', async () => {
    const { seam, files } = makeFsSeam()

    const result = await resolveSidecarArtifact(
      { kind: 'download', url: ARTIFACT_URL, sha256: sha256Hex(ARTIFACT_BYTES) },
      {
        fetchImpl: makeFetch(ARTIFACT_BYTES, []),
        fsSeam: seam,
        env: () => 'env-cache-dir',
      },
    )

    expect(result.path).toBe(expectedCachePath('env-cache-dir', ARTIFACT_URL))
    expect(files.has(result.path)).toBe(true)
  })

  test('resolves a local artifact whose sha256 matches expectedSha256', async () => {
    const { seam, files } = makeFsSeam()
    files.set(LOCAL_PATH, { content: Buffer.from('local-bytes') })

    const result = await resolveSidecarArtifact(
      {
        kind: 'local',
        path: LOCAL_PATH,
        expectedSha256: sha256Hex('local-bytes'),
      },
      { fsSeam: seam },
    )

    expect(result.path).toBe(LOCAL_PATH)
  })

  test('resolves a local artifact without expectedSha256 after an existence check', async () => {
    const { seam, files } = makeFsSeam()
    files.set(LOCAL_PATH, { content: Buffer.from('local-bytes') })

    const result = await resolveSidecarArtifact(
      { kind: 'local', path: LOCAL_PATH },
      { fsSeam: seam },
    )

    expect(result.path).toBe(LOCAL_PATH)
  })

  test('rejects a local artifact whose sha256 mismatches expectedSha256', async () => {
    const { seam, files } = makeFsSeam()
    files.set(LOCAL_PATH, { content: Buffer.from('local-bytes') })

    const error = await captureError(() =>
      resolveSidecarArtifact(
        {
          kind: 'local',
          path: LOCAL_PATH,
          expectedSha256: sha256Hex('other-local-bytes'),
        },
        { fsSeam: seam },
      ),
    )

    expect(error.reason).toBe('checksum-mismatch')
  })

  test('rejects a relative local path with reason "invalid-source"', async () => {
    const { seam } = makeFsSeam()

    const error = await captureError(() =>
      resolveSidecarArtifact(
        { kind: 'local', path: 'relative/agent.bin' },
        { fsSeam: seam },
      ),
    )

    expect(error.reason).toBe('invalid-source')
  })

  test('rejects an absent local path with reason "missing"', async () => {
    const { seam } = makeFsSeam()

    const error = await captureError(() =>
      resolveSidecarArtifact(
        { kind: 'local', path: LOCAL_PATH },
        { fsSeam: seam },
      ),
    )

    expect(error.reason).toBe('missing')
  })
})
