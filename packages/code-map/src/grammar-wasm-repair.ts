import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

// Pinned hashes make the compiled CLI's legacy-wrapper repair deterministic:
// downloaded executable WASM is never loaded unless it matches the exact
// package bytes used by the release build.
type PinnedGrammarAsset = {
  packageName: string
  packageVersion: string
  remoteFile: string
  sha256: string
  sourceUrl?: string
}

const wasms = (remoteFile: string, sha256: string): PinnedGrammarAsset => ({
  packageName: 'tree-sitter-wasms',
  packageVersion: '0.1.13',
  remoteFile,
  sha256,
})

export const PINNED_GRAMMAR_ASSETS: Readonly<
  Record<string, PinnedGrammarAsset>
> = {
  'tree-sitter-c-sharp.wasm': wasms(
    'tree-sitter-c_sharp.wasm',
    '6266a7e32d68a3459104d994dc848df15d5672b0ea8e86d327274b694f8e6991',
  ),
  'tree-sitter-cpp.wasm': wasms(
    'tree-sitter-cpp.wasm',
    'f6afdf53bfd6de76557bb7edb624a3a3869e14d9a83b78433f93617ecee42527',
  ),
  'tree-sitter-go.wasm': wasms(
    'tree-sitter-go.wasm',
    '9963ca89b616eaf04b08a43bc1fb0f07b85395bec313330851f1f1ead2f755b6',
  ),
  'tree-sitter-java.wasm': wasms(
    'tree-sitter-java.wasm',
    '637aac4415fb39a211a4f4292d63c66b5ce9c32fa2cd35464af4f681d91b9a1f',
  ),
  'tree-sitter-javascript.wasm': wasms(
    'tree-sitter-javascript.wasm',
    '63812b9e275d26851264734868d27a1656bd44a2ef6eb3e85e6b03728c595ab5',
  ),
  'tree-sitter-python.wasm': wasms(
    'tree-sitter-python.wasm',
    '9056d0fb0c337810d019fae350e8167786119da98f0f282aceae7ab89ee8253b',
  ),
  'tree-sitter-ruby.wasm': wasms(
    'tree-sitter-ruby.wasm',
    '93a5022855314cdb45458c7bb026a24a0ebc3a5ff6439e542e881f14dfa13a39',
  ),
  'tree-sitter-rust.wasm': wasms(
    'tree-sitter-rust.wasm',
    '4409921a70d0aa5bec7d1d7ce809a557a8ee1cf6ace901e3ac6a76e62cfea903',
  ),
  'tree-sitter-tsx.wasm': wasms(
    'tree-sitter-tsx.wasm',
    '6aa3b2c70e76f5d48eafef1093e9c4de383e13f2fdde2f4e9b98a378f6a8f1b6',
  ),
  'tree-sitter-typescript.wasm': wasms(
    'tree-sitter-typescript.wasm',
    '8515404dceed38e1ed86aa34b09fcf3379fff1b4ff9dd3967bcd6d1eb5ac3d8f',
  ),
  'tree-sitter-kotlin.wasm': wasms(
    'tree-sitter-kotlin.wasm',
    'b5cb00c8d06ed0f10f1dbe497205b437809d7e87db1f638721a8cfb30e044449',
  ),
  'tree-sitter-php.wasm': wasms(
    'tree-sitter-php.wasm',
    '55bb617b6f01e14bab997861f0b20a2420cf6ba3199ffeb295b9ec398966d8a3',
  ),
  'tree-sitter-swift.wasm': wasms(
    'tree-sitter-swift.wasm',
    '41c4fdb2249a3aa6d87eed0d383081ff09725c2248b4977043a43825980ffcc7',
  ),
  'tree-sitter-gdscript.wasm': {
    packageName: 'tree-sitter-gdscript',
    packageVersion: '6.1.0',
    remoteFile: 'tree-sitter-gdscript.wasm',
    // The upstream grammar does not publish WASM artifacts. This immutable
    // vendored build is documented as tree-sitter-gdscript 6.1.0 compiled
    // with tree-sitter-cli 0.25.10 and emscripten 4.0.4 (ABI 14).
    sourceUrl:
      'https://raw.githubusercontent.com/lusiem/code-atlas/2e416060c2f70e99d46d09382f90523d6bd75993/grammars-vendored/tree-sitter-gdscript.wasm',
    sha256: '42eb46aa698cb82d4bc2f0d61c8a57cdae9ec29e42c8f632430744f890879f90',
  },
}

export function getPinnedGrammarAssetUrl(wasmFile: string): string | null {
  const asset = PINNED_GRAMMAR_ASSETS[wasmFile]
  if (!asset) return null
  return (
    asset.sourceUrl ??
    `https://cdn.jsdelivr.net/npm/${asset.packageName}@${asset.packageVersion}/${asset.packageName === 'tree-sitter-wasms' ? 'out' : 'wasm'}/${encodeURIComponent(asset.remoteFile)}`
  )
}

// Transient network failures are retried so one flaky fetch can no longer
// fail a release build. Only network-level problems retry: fetch throwing,
// the per-attempt abort/timeout, and retryable HTTP statuses (5xx and 429).
// Worst-case added latency stays bounded at 3 attempts x 30s plus two short
// retry delays. A sha256 mismatch is deterministic corruption of the
// downloaded bytes, so it fails immediately without retrying.
const MAX_REPAIR_ATTEMPTS = 3
const ATTEMPT_TIMEOUT_MS = 30_000
const DEFAULT_RETRY_DELAY_MS = 2_000

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))

// Discarded error responses are never read, so their bodies are cancelled
// before the attempt ends: an undrained body can hold its socket open
// indefinitely and block connection reuse, and the per-attempt timeout is
// already cleared once headers arrive. Cancellation is best-effort:
// cancel() rejects for a body that already errored, and that must not be
// misreported as a network failure.
const releaseBody = async (response: Response): Promise<void> => {
  try {
    await response.body?.cancel()
  } catch {
    // Nothing left to release; keep the attempt's real failure reason.
  }
}

export async function repairGrammarWasm(params: {
  wasmFile: string
  targetDir: string
  fetchImpl?: typeof fetch
  retryDelayMs?: number
  onFailure?: (reason: string) => void
}): Promise<string | null> {
  const fail = (reason: string): null => {
    params.onFailure?.(reason)
    return null
  }

  const asset = PINNED_GRAMMAR_ASSETS[params.wasmFile]
  if (!asset) return fail(`no pinned checksum exists for ${params.wasmFile}`)
  if (!path.isAbsolute(params.targetDir)) {
    return fail(`repair target ${params.targetDir} is not an absolute path`)
  }
  const sourceUrl = getPinnedGrammarAssetUrl(params.wasmFile)
  if (!sourceUrl) {
    return fail(`no pinned download URL exists for ${params.wasmFile}`)
  }

  const fetchFn = params.fetchImpl ?? fetch
  const retryDelayMs = params.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS
  let lastErrorMessage: string | null = null
  let lastHttpStatus: number | null = null
  let verifiedBytes: Uint8Array | null = null

  // Each attempt re-downloads, so the hash always checks fresh bytes. Only
  // the network phase lives inside the retry loop: verified bytes break out
  // of the loop before persistence, so disk failures are never retried and
  // never misreported as network errors.
  for (let attempt = 1; attempt <= MAX_REPAIR_ATTEMPTS; attempt++) {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), ATTEMPT_TIMEOUT_MS)
    try {
      const response = await fetchFn(sourceUrl, { signal: controller.signal })
      if (response.ok) {
        const bytes = new Uint8Array(await response.arrayBuffer())
        const actualHash = createHash('sha256').update(bytes).digest('hex')
        if (actualHash !== asset.sha256) {
          // Retry cannot fix wrong bytes: fail immediately with a
          // distinct reason instead of burning more attempts.
          return fail('downloaded bytes failed sha256 verification')
        }
        verifiedBytes = bytes
        break
      } else if (response.status >= 500 || response.status === 429) {
        // Transient server-side condition: record it, release the body,
        // and try again. Clearing the network message keeps the final
        // diagnostic tied to the most recent attempt rather than an
        // earlier fetch throw.
        lastHttpStatus = response.status
        lastErrorMessage = null
        await releaseBody(response)
      } else {
        await releaseBody(response)
        return fail(`HTTP ${response.status} response`)
      }
    } catch (error) {
      // Fetch throwing covers network errors and the per-attempt abort
      // timeout; both are transient, so record the message and try again.
      lastErrorMessage = error instanceof Error ? error.message : String(error)
    } finally {
      clearTimeout(timeout)
    }
    // Delay only between attempts to keep the worst-case latency bounded.
    if (attempt < MAX_REPAIR_ATTEMPTS) {
      await sleep(retryDelayMs)
    }
  }

  if (verifiedBytes === null) {
    if (lastErrorMessage !== null) {
      return fail(
        `network error after ${MAX_REPAIR_ATTEMPTS} attempts: ${lastErrorMessage}`,
      )
    }
    return fail(`HTTP ${lastHttpStatus} after ${MAX_REPAIR_ATTEMPTS} attempts`)
  }

  try {
    await fs.mkdir(params.targetDir, { recursive: true, mode: 0o700 })
    const targetPath = path.join(params.targetDir, params.wasmFile)
    const tempPath = `${targetPath}.tmp.${process.pid}.${randomUUID()}`
    await fs.writeFile(tempPath, verifiedBytes, { mode: 0o600 })
    await fs.rename(tempPath, targetPath)
    return targetPath
  } catch (error) {
    return fail(
      `failed to persist repaired bytes: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

export async function resolveGrammarWasmSource(params: {
  wasmFile: string
  candidates: readonly string[]
  repairDir: string
  repairImpl?: typeof repairGrammarWasm
}): Promise<string> {
  const asset = PINNED_GRAMMAR_ASSETS[params.wasmFile]
  if (!asset) {
    throw new Error(`No pinned checksum exists for ${params.wasmFile}`)
  }

  for (const candidate of params.candidates) {
    try {
      const stats = await fs.stat(candidate)
      if (!stats.isFile() || stats.size === 0) continue
      const actualHash = createHash('sha256')
        .update(await fs.readFile(candidate))
        .digest('hex')
      if (actualHash === asset.sha256) return candidate
    } catch {
      // Continue through candidates before attempting the pinned repair.
    }
  }

  // Capture the last repair failure reason so the final error below can
  // state WHY checksum-pinned repair failed.
  let failureReason: string | undefined
  const repaired = await (params.repairImpl ?? repairGrammarWasm)({
    wasmFile: params.wasmFile,
    targetDir: params.repairDir,
    onFailure: (reason) => {
      failureReason = reason
    },
  })
  if (repaired) {
    try {
      const stats = await fs.stat(repaired)
      if (stats.isFile() && stats.size > 0) return repaired
    } catch {
      // Fall through to the deterministic missing-asset error below.
    }
  }

  throw new Error(
    `Missing required tree-sitter asset ${params.wasmFile}; searched ${params.candidates.join(', ')} and checksum-pinned repair failed${failureReason ? `: ${failureReason}` : ''}`,
  )
}
