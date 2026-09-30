#!/usr/bin/env bun

import { spawnSync, type SpawnSyncOptions } from 'child_process'
import { createHash } from 'crypto'
import { createRequire } from 'module'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

import { resolveGrammarWasmSource } from '../../packages/code-map/src/grammar-wasm-repair'
import { LANGUAGE_WASM_FILES } from '../../packages/code-map/src/wasm-files'
import {
  patchOpenTuiLegacyNativeLoaderSource,
  restoreOpenTuiNativeLoaderSource,
} from './open-tui-legacy-patch'

type TargetInfo = {
  bunTarget: string
  platform: NodeJS.Platform
  arch: string
}

const VERBOSE = process.env.VERBOSE === 'true'
const OVERRIDE_TARGET = process.env.OVERRIDE_TARGET
const OVERRIDE_PLATFORM = process.env.OVERRIDE_PLATFORM as
  | NodeJS.Platform
  | undefined
const OVERRIDE_ARCH = process.env.OVERRIDE_ARCH ?? undefined
const COMPILER_BIN = process.env.OPENBUFF_COMPILER_BIN ?? 'bun'
const IS_LEGACY_MACOS_BUILD = process.env.OPENBUFF_LEGACY_MACOS_BUILD === 'true'
const LEGACY_OPENTUI_LIB = process.env.OPENBUFF_LEGACY_OPENTUI_LIB
const LEGACY_RIPGREP_BIN = process.env.OPENBUFF_LEGACY_RIPGREP_BIN

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const cliRoot = join(__dirname, '..')
const repoRoot = dirname(cliRoot)

function log(message: string) {
  if (VERBOSE) {
    console.log(message)
  }
}

function logAlways(message: string) {
  console.log(message)
}

const REGISTRY_FETCH_TIMEOUT_MS = 30_000
const REGISTRY_FETCH_RETRIES = 2
/**
 * Per-chunk inactivity window for tarball body reads. Unlike an overall
 * AbortSignal timeout, this does not cap the total transfer duration: a slow
 * but healthy connection may take arbitrarily long, while a genuinely stalled
 * connection (no bytes for the idle window) aborts with an actionable error
 * instead of hanging the build indefinitely.
 */
const TARBALL_BODY_IDLE_TIMEOUT_MS = 30_000

/**
 * Fetch a registry URL with a hard timeout and bounded retries. Without this,
 * a stalled registry connection hangs the binary build indefinitely
 * (notably in CI) instead of failing with an actionable error.
 */
/**
 * Error subclass for terminal HTTP failures (4xx-class statuses that are not
 * worth retrying). Carrying it as a distinct type — instead of pattern-matching
 * on the message text — lets the retry loop fail fast on non-transient HTTP
 * statuses while still retrying genuine transient network errors (DNS
 * failures, connection resets, timeouts), whose standard fetch rejection
 * message is also "Failed to fetch".
 */
class TerminalHttpError extends Error {
  readonly status: number

  constructor(url: string, status: number, statusText: string) {
    super(`Failed to fetch ${url}: ${status} ${statusText}`)
    this.name = 'TerminalHttpError'
    this.status = status
  }
}

/**
 * HTTP statuses worth retrying: rate limiting and transient server-side
 * failures. Client errors like 404 are terminal for this URL.
 */
function isTransientHttpStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || (status >= 500 && status <= 599)
}

/**
 * Fetch a URL and consume its body with bounded retries. `fetchOnce` performs
 * one attempt and owns its own timeout semantics; `consume` reads the body of
 * a successful response. The loop handles transient HTTP statuses and network
 * errors from BOTH phases: a network failure mid-body has not consumed the
 * body yet, so a clean retry re-issues the request and reads the new body
 * from scratch instead of aborting the whole build. A body that was consumed
 * successfully is never re-downloaded: `consume` returning is what resolves
 * the loop.
 */
async function fetchWithRetry<T>(
  url: string,
  fetchOnce: () => Promise<Response>,
  consume: (response: Response) => Promise<T>,
): Promise<T> {
  let lastError: unknown
  for (let attempt = 0; attempt <= REGISTRY_FETCH_RETRIES; attempt++) {
    try {
      const response = await fetchOnce()
      if (!response.ok) {
        if (!isTransientHttpStatus(response.status)) {
          // Client/HTTP errors are not transient: fail immediately with the
          // actionable status instead of retrying.
          throw new TerminalHttpError(url, response.status, response.statusText)
        }
        // Transient registry failure (408/425/429/5xx): retry with backoff.
        // The body of a transient-status response is never read on this
        // path, so cancel it before the response is discarded: an unread
        // body keeps its underlying socket/stream allocated for every
        // discarded attempt in this long-lived build process.
        lastError = new TerminalHttpError(url, response.status, response.statusText)
        await response.body?.cancel().catch(() => {})
        if (attempt < REGISTRY_FETCH_RETRIES) {
          const backoffMs = 1000 * 2 ** attempt
          log(
            `Registry fetch for ${url} returned ${response.status}; retrying in ${backoffMs}ms (attempt ${attempt + 1}/${REGISTRY_FETCH_RETRIES + 1})`,
          )
          await new Promise((resolve) => setTimeout(resolve, backoffMs))
          continue
        }
        throw lastError
      }
      return await consume(response)
    } catch (error) {
      // Only terminal HTTP errors bypass retries; transient network failures
      // (which fetch also surfaces as "Failed to fetch"), including failures
      // mid-body while `consume` is reading, are retried below — the body is
      // not consumed yet at that point, so a clean retry is possible. A
      // failed consume releases its response's stream in its own cleanup, so
      // a retry never leaks the previous attempt's socket.
      if (error instanceof TerminalHttpError) {
        throw error
      }
      lastError = error
      if (attempt < REGISTRY_FETCH_RETRIES) {
        log(
          `Retrying registry fetch for ${url} after attempt ${attempt + 1} failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        )
      }
    }
  }
  throw new Error(
    `Registry fetch for ${url} failed after ${REGISTRY_FETCH_RETRIES + 1} attempts (timeout ${REGISTRY_FETCH_TIMEOUT_MS}ms per attempt): ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
  )
}

/**
 * Fetch registry metadata and parse its JSON body with bounded retries
 * covering the whole fetch-and-consume-parse path: a network failure mid-body
 * is retried like a connection failure instead of aborting the build, the
 * body is read with the same per-chunk inactivity bound as the tarball body —
 * a stalled metadata body fails with an actionable error and is retried
 * rather than hanging the build indefinitely — and a complete 200 response
 * whose body is not valid JSON (a captive portal, a transparent proxy error
 * page, or corrupted-at-origin bytes) is retried too: the parse runs inside
 * the fetchWithRetry loop, so a non-JSON body is treated as a transient
 * failure instead of terminally failing the build. A body that parses
 * cleanly is never re-downloaded; only a failed fetch, read, or parse
 * triggers a retry.
 */
async function fetchJsonWithRetry(url: string): Promise<unknown> {
  return fetchWithRetry(
    url,
    () =>
      fetch(url, { signal: AbortSignal.timeout(REGISTRY_FETCH_TIMEOUT_MS) }),
    async (response) => {
      const buffer = await readBodyWithIdleTimeout(
        response,
        TARBALL_BODY_IDLE_TIMEOUT_MS,
        'Registry metadata response',
      )
      try {
        return JSON.parse(buffer.toString('utf-8'))
      } catch (error) {
        // Thrown inside the retry loop: fetchWithRetry retries this like any
        // other transient failure and includes the message in its final
        // error when the retries are exhausted.
        throw new Error(
          `Registry metadata response was not valid JSON: ${
            error instanceof Error ? error.message : String(error)
          }`,
        )
      }
    },
  )
}

/**
 * Download a tarball into a buffer with a timeout covering only connection
 * establishment and response headers, and with the body read inside the
 * retried region. The body transfer itself is NOT capped by an AbortSignal —
 * a multi-megabyte native bundle on a slow but healthy connection must be
 * allowed to finish, instead of being aborted mid-transfer and re-downloaded
 * in full by each retry attempt — but a network failure or stall mid-body is
 * retried like a connection failure instead of aborting the whole build.
 */
async function fetchTarballBufferWithRetry(url: string): Promise<Buffer> {
  return fetchWithRetry(
    url,
    () => fetchWithHeadersTimeout(url, REGISTRY_FETCH_TIMEOUT_MS),
    (response) =>
      readBodyWithIdleTimeout(response, TARBALL_BODY_IDLE_TIMEOUT_MS),
  )
}

async function fetchWithHeadersTimeout(
  url: string,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(
    () =>
      controller.abort(
        new Error(`Response headers not received within ${timeoutMs}ms`),
      ),
    timeoutMs,
  )
  try {
    // Resolving means the response headers have arrived: release the timeout
    // so the body transfer runs uncapped.
    return await fetch(url, { signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Read a response body with a per-chunk inactivity timeout instead of a cap
 * on the total transfer duration: a slow but healthy connection may take
 * arbitrarily long overall, while a stalled connection (no bytes for the
 * idle window) aborts with an actionable error instead of hanging the build.
 * `label` names the transfer in stall errors so a metadata-body stall is not
 * misreported as a tarball failure.
 */
async function readBodyWithIdleTimeout(
  response: Response,
  idleTimeoutMs: number,
  label = 'Tarball download',
): Promise<Buffer> {
  const body = response.body
  if (!body) {
    throw new Error('Tarball download returned no readable body stream')
  }
  const reader = body.getReader()
  const chunks: Buffer[] = []
  let idleTimer: ReturnType<typeof setTimeout> | undefined
  let idleReject: ((reason?: unknown) => void) | undefined
  let idleFired = false
  const armIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer)
    idleTimer = setTimeout(() => {
      idleFired = true
      // Cancel the stream so the pending read settles and the connection is
      // released instead of leaking.
      void reader.cancel().catch(() => undefined)
      idleReject?.(
        new Error(
          `${label} stalled: no bytes received for ${idleTimeoutMs}ms`,
        ),
      )
    }, idleTimeoutMs)
  }
  try {
    armIdleTimer()
    for (;;) {
      const read = reader.read()
      // If the idle timer fires first this read is abandoned; the no-op catch
      // keeps the abandoned promise from surfacing as an unhandled rejection.
      read.catch(() => undefined)
      const result = await Promise.race([
        read,
        new Promise<never>((_, reject) => {
          idleReject = reject
        }),
      ])
      // A timer firing between iterations cancels the reader, whose pending
      // read then resolves as done: without this check the loop would return
      // a partial tarball instead of failing the stalled transfer.
      if (idleFired) {
        throw new Error(
          `${label} stalled: no bytes received for ${idleTimeoutMs}ms`,
        )
      }
      armIdleTimer()
      if (result.done) break
      chunks.push(Buffer.from(result.value))
    }
    return Buffer.concat(chunks)
  } finally {
    if (idleTimer) clearTimeout(idleTimer)
    void reader.cancel().catch(() => undefined)
  }
}

function runCommand(
  command: string,
  args: string[],
  options: SpawnSyncOptions = {},
) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    stdio: VERBOSE ? 'inherit' : 'pipe',
    env: options.env,
  })

  if (result.status !== 0) {
    const stderr = result.stderr?.toString() ?? ''
    throw new Error(
      `Command "${command} ${args.join(' ')}" failed with exit code ${
        result.status
      }${stderr ? `\n${stderr}` : ''}`,
    )
  }
}

function getTargetInfo(): TargetInfo {
  if (OVERRIDE_TARGET && OVERRIDE_PLATFORM && OVERRIDE_ARCH) {
    return {
      bunTarget: OVERRIDE_TARGET,
      platform: OVERRIDE_PLATFORM,
      arch: OVERRIDE_ARCH,
    }
  }

  const platform = process.platform
  const arch = process.arch

  const mappings: Record<string, TargetInfo> = {
    'linux-x64': {
      bunTarget: 'bun-linux-x64-baseline',
      platform: 'linux',
      arch: 'x64',
    },
    'linux-arm64': {
      bunTarget: 'bun-linux-arm64',
      platform: 'linux',
      arch: 'arm64',
    },
    'darwin-x64': {
      bunTarget: 'bun-darwin-x64',
      platform: 'darwin',
      arch: 'x64',
    },
    'darwin-arm64': {
      bunTarget: 'bun-darwin-arm64',
      platform: 'darwin',
      arch: 'arm64',
    },
    'win32-x64': {
      bunTarget: 'bun-windows-x64',
      platform: 'win32',
      arch: 'x64',
    },
  }

  const key = `${platform}-${arch}`
  const target = mappings[key]

  if (!target) {
    throw new Error(`Unsupported build target: ${key}`)
  }

  return target
}

async function main() {
  const [, , binaryNameArg, version] = process.argv
  const binaryName = binaryNameArg ?? 'codecane'

  if (!version) {
    throw new Error('Version argument is required when building a binary')
  }

  log(`Building ${binaryName} @ ${version}`)

  const targetInfo = getTargetInfo()
  const binDir = join(cliRoot, 'bin')

  if (!existsSync(binDir)) {
    mkdirSync(binDir, { recursive: true })
  }

  // Generate bundled agents file before compiling
  log('Generating bundled agents...')
  runCommand('bun', ['run', 'scripts/prebuild-agents.ts'], {
    cwd: cliRoot,
    env: process.env,
  })
  runCommand('bun', ['run', 'scripts/generate-init-type-sources.ts'], {
    cwd: cliRoot,
    env: process.env,
  })

  // Ensure SDK assets exist before compiling the CLI
  log('Building SDK dependencies...')
  runCommand('bun', ['run', '--cwd', '../sdk', 'build'], {
    cwd: cliRoot,
    env: process.env,
  })

  const outputFilename =
    targetInfo.platform === 'win32' ? `${binaryName}.exe` : binaryName
  const outputFile = join(binDir, outputFilename)

  // Collect all NEXT_PUBLIC_* environment variables
  const nextPublicEnvVars = Object.entries(process.env)
    .filter(([key]) => key.startsWith('NEXT_PUBLIC_'))
    .map(([key, value]) => [`process.env.${key}`, `"${value ?? ''}"`])

  const defineFlags = [
    ['process.env.NODE_ENV', '"production"'],
    ['process.env.CODEBUFF_IS_BINARY', '"true"'],
    ['process.env.CODEBUFF_CLI_VERSION', `"${version}"`],
    ['process.env.DEV', '"false"'],
    [
      'process.env.CODEBUFF_CLI_LEGACY_MACOS',
      IS_LEGACY_MACOS_BUILD ? '"true"' : '"false"',
    ],
    [
      'process.env.CODEBUFF_CLI_TARGET',
      IS_LEGACY_MACOS_BUILD
        ? `"darwin-${targetInfo.arch}-legacy"`
        : `"${targetInfo.platform}-${targetInfo.arch}"`,
    ],
    ...nextPublicEnvVars,
  ]

  const buildArgs = [
    'build',
    'src/index.tsx',
    '--compile',
    `--outfile=${outputFile}`,
    '--sourcemap=none',
    ...defineFlags.flatMap(([key, value]) => ['--define', `${key}=${value}`]),
  ]

  if (!IS_LEGACY_MACOS_BUILD) {
    // Required so compiled binaries use the production JSX runtime (avoids
    // jsxDEV crashes). Bun 1.0's compiler predates these flags, so the legacy
    // lane uses explicit defines above instead.
    buildArgs.splice(3, 0, '--production', `--target=${targetInfo.bunTarget}`)
    buildArgs.push('--env "NEXT_PUBLIC_*"')
  } else {
    buildArgs.push('--conditions=production')
  }

  // Serialize the shared-bundle patch/restore cycle and the compile that
  // reads its result under an exclusive lock: writeBundleFileAtomically makes
  // each individual bundle write atomic, but two concurrent invocations can
  // still interleave their read-modify-write cycles on the SHARED node_modules
  // @opentui/core bundle — a non-legacy build's restore can revert a legacy
  // build's freshly written patch (or vice versa) before that build's compile
  // reads it, shipping a binary compiled against the wrong bundle state.
  await acquireOpenTuiBundleLock()
  try {
    patchOpenTuiAssetPaths()
    restoreOpenTuiCoreNativeLoader()
    if (IS_LEGACY_MACOS_BUILD) {
      assertLegacyMacOSBuildConfig(targetInfo)
      patchOpenTuiCoreNativeLoaderForLegacy()
    } else {
      await ensureOpenTuiNativeBundle(targetInfo)
    }

    log(
      `${COMPILER_BIN} ${buildArgs
        .map((arg) => (arg.includes(' ') ? `"${arg}"` : arg))
        .join(' ')}`,
    )

    runCommand(COMPILER_BIN, buildArgs, { cwd: cliRoot })
  } finally {
    releaseOpenTuiBundleLock()
  }

  // Bun 1.0 writes a compiled executable next to the entrypoint even when an
  // absolute --outfile is provided. Normalize it into cli/bin for packaging.
  if (IS_LEGACY_MACOS_BUILD && !existsSync(outputFile)) {
    const legacyOutput = join(cliRoot, 'src', outputFilename)
    if (!existsSync(legacyOutput)) {
      throw new Error(
        `Legacy compiler did not produce ${outputFile} or ${legacyOutput}`,
      )
    }
    renameSync(legacyOutput, outputFile)
  }

  if (IS_LEGACY_MACOS_BUILD) {
    copyFileSync(LEGACY_OPENTUI_LIB!, join(binDir, 'libopentui.dylib'))
    copyFileSync(LEGACY_RIPGREP_BIN!, join(binDir, 'rg'))
    chmodSync(join(binDir, 'rg'), 0o755)
  }

  // Ship tree-sitter.wasm as a sibling file next to the binary. Bun
  // --compile asset embedding is unreliable on Windows (every JS-level
  // retrieval mechanism we tried — `with { type: 'file' }`, base64 string
  // literals, chunked base64, function-wrapped chunked base64 — got
  // tree-shaken, minified away, or returned an undefined binding even
  // when the bytes were in the binary). The pre-init reads it from
  // `dirname(process.execPath)`, which works the same on every platform
  // because it's a normal disk read, not a bunfs lookup.
  const sourceWasm = findWebTreeSitterWasm()
  const siblingWasm = join(binDir, 'tree-sitter.wasm')
  writeFileSync(siblingWasm, readFileSync(sourceWasm))
  logAlways(`Copied tree-sitter.wasm sibling: ${sourceWasm} → ${siblingWasm}`)
  let copiedGrammarCount = 0
  const wasmManifest: Record<string, string> = {
    'tree-sitter.wasm': createHash('sha256')
      .update(readFileSync(siblingWasm))
      .digest('hex'),
  }
  for (const wasmFile of LANGUAGE_WASM_FILES) {
    const source = await findGrammarWasmSource(wasmFile)
    copyFileSync(source, join(binDir, wasmFile))
    wasmManifest[wasmFile] = createHash('sha256')
      .update(readFileSync(source))
      .digest('hex')
    copiedGrammarCount++
  }
  writeFileSync(
    join(binDir, 'tree-sitter-manifest.json'),
    `${JSON.stringify({ schemaVersion: 1, files: wasmManifest }, null, 2)}\n`,
  )
  logAlways(`Copied ${copiedGrammarCount} tree-sitter language grammars`)

  if (targetInfo.platform !== 'win32') {
    chmodSync(outputFile, 0o755)
  }

  logAlways(
    `✅ Built ${outputFilename} (${targetInfo.platform}-${targetInfo.arch})`,
  )
}

function assertLegacyMacOSBuildConfig(targetInfo: TargetInfo) {
  if (
    targetInfo.platform !== 'darwin' ||
    !['x64', 'arm64'].includes(targetInfo.arch)
  ) {
    throw new Error(
      'The legacy macOS build is supported only for darwin-x64 and darwin-arm64',
    )
  }
  if (!LEGACY_OPENTUI_LIB || !existsSync(LEGACY_OPENTUI_LIB)) {
    throw new Error(
      'OPENBUFF_LEGACY_OPENTUI_LIB must point to a macOS 11-compatible libopentui.dylib',
    )
  }
  if (!LEGACY_RIPGREP_BIN || !existsSync(LEGACY_RIPGREP_BIN)) {
    throw new Error(
      'OPENBUFF_LEGACY_RIPGREP_BIN must point to a macOS 11-compatible rg binary',
    )
  }
}

/**
 * Replace a file's contents atomically via a temp sibling + rename: a plain
 * read → writeFileSync on a SHARED node_modules bundle is not safe across the
 * concurrent build-binary invocations the bundle installer in this script
 * explicitly anticipates — two interleaved read-modify-write pairs can tear
 * the file or persist a mixed patched/restored bundle. renameSync is atomic
 * on the same filesystem, so every reader sees either the old or the new
 * bundle, never a torn one. The temp name is PID/attempt-unique so two
 * concurrent writers cannot clobber each other's staging file.
 */
function writeBundleFileAtomically(bundlePath: string, contents: string) {
  const tmpPath = `${bundlePath}.${process.pid}.${Date.now()}.tmp`
  try {
    writeFileSync(tmpPath, contents)
    renameSync(tmpPath, bundlePath)
  } catch (error) {
    try {
      rmSync(tmpPath, { force: true })
    } catch {
      // The temp file may never have been created; the original error below
      // is the root cause.
    }
    throw error
  }
}

/** Exclusive lock serializing the shared-bundle patch/restore + compile window. */
const OPENTUI_BUNDLE_LOCK_FILE = join(
  cliRoot,
  'node_modules',
  '.opentui-core-bundle.lock',
)
/** Bounded wait for a live holder before failing with an actionable error. */
const OPENTUI_BUNDLE_LOCK_WAIT_MS = 30 * 60_000
const OPENTUI_BUNDLE_LOCK_POLL_MS = 500

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Whether a PID is alive (mirrors scripts/start-services.ts isProcessRunning):
 * EPERM means the signal was denied, not that the process is gone, so a live
 * process we lack permission to signal still counts as alive.
 */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EPERM') return true
    return false
  }
}

/**
 * One attempt to take the OpenTUI bundle lock exclusively. Returns false when
 * the lock is (or may be) held by another invocation; the caller's poll loop
 * retries. Mirrors scripts/start-services.ts createStartLock + the steal
 * branch of acquireStartLock, including that protocol's attempt-unique stolen
 * name: `attempt` (the poll-loop iteration this call belongs to) is folded
 * into the stolen file's name so a live holder's record preserved by an
 * earlier attempt's failed restore can never be clobbered by a later
 * attempt's rename to the same path.
 */
function tryAcquireOpenTuiBundleLock(attempt: number): boolean {
  mkdirSync(join(cliRoot, 'node_modules'), { recursive: true })
  // Exclusive-create publish, hard-linked from a private temp file (the same
  // sequence scripts/start-services.ts createStartLock uses): linkSync fails
  // with EEXIST when the lock already exists, and — unlike a
  // create-then-write sequence — the lock path can never exist with an empty
  // record that a concurrent waiter would classify as corrupt and steal while
  // the creator is still writing it.
  const tmpPath = `${OPENTUI_BUNDLE_LOCK_FILE}.${process.pid}.tmp`
  writeFileSync(tmpPath, `${process.pid}\n`)
  try {
    linkSync(tmpPath, OPENTUI_BUNDLE_LOCK_FILE)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  } finally {
    // The published lock is its own directory entry, so unlinking the temp
    // name never removes it (and cleans up on the EEXIST path).
    try {
      unlinkSync(tmpPath)
    } catch {
      // Ignore
    }
  }

  // Contended. Steal only a provably abandoned lock — its holder PID is dead
  // (or the record is corrupt). A live holder is waited for by
  // acquireOpenTuiBundleLock's poll loop, never stolen from, regardless of
  // the lock's age: nothing refreshes the lock's mtime while the holder's
  // patch/compile window runs, so an age threshold would rename a long-lived
  // live holder's lock aside mid-critical-section and two builds would patch
  // and compile the shared @opentui/core bundle concurrently. A crashed
  // holder is reclaimed through its dead PID instead.
  let observedRaw: string
  let observedMtimeMs: number
  let observedIno: number
  try {
    const stat = statSync(OPENTUI_BUNDLE_LOCK_FILE)
    const holderRaw = readFileSync(OPENTUI_BUNDLE_LOCK_FILE, 'utf-8').trim()
    const holder = holderRaw === '' ? null : Number.parseInt(holderRaw, 10)
    const holderAlive =
      holder !== null && Number.isFinite(holder) && isPidAlive(holder)
    // Never steal from a live holder regardless of the lock's age (see the
    // comment above): the bounded wait fails with an actionable error instead
    // of stealing from a long-lived live holder mid-critical-section.
    if (holderAlive) {
      return false
    }
    observedRaw = holderRaw
    observedMtimeMs = stat.mtimeMs
    observedIno = stat.ino
  } catch {
    // The lock vanished between the failed create and this read: the poll
    // loop retries the exclusive create.
    return false
  }

  // Move the candidate lock aside atomically and verify it is the exact file
  // that was validated (same holder record, mtime, and inode): a competing
  // waiter that observed the same abandoned lock may have won the rename and
  // already replaced the path with its own fresh lock, and renaming THAT one
  // aside would break its holder's ownership.
  // The stolen file's name is unique per attempt (the same protocol
  // scripts/start-services.ts acquireStartLock uses): a fixed per-PID name
  // would let a later attempt's renameSync silently overwrite a live
  // holder's lock record that an earlier attempt's failed restore preserved
  // there, destroying the only remaining ownership record of that holder.
  const stolenPath = `${OPENTUI_BUNDLE_LOCK_FILE}.${process.pid}.${attempt}.stolen`
  try {
    renameSync(OPENTUI_BUNDLE_LOCK_FILE, stolenPath)
  } catch {
    // The lock vanished before the rename: the poll loop retries.
    return false
  }
  let stoleObservedLock = false
  try {
    const stolenStat = statSync(stolenPath)
    stoleObservedLock =
      readFileSync(stolenPath, 'utf-8').trim() === observedRaw &&
      stolenStat.mtimeMs === observedMtimeMs &&
      stolenStat.ino === observedIno
  } catch {
    stoleObservedLock = false
  }
  if (!stoleObservedLock) {
    // The moved lock was not the one validated above: restore it so its
    // holder keeps ownership of the path. linkSync fails with EEXIST when
    // another waiter exclusive-created a lock at the freed path in the
    // meantime, leaving that waiter in possession; on that failure the moved
    // file is unlinked only when its recorded holder is provably dead — a
    // live holder's record is preserved under this attempt's unique stolen
    // name instead of being destroyed, which would leave two invocations
    // both believing they hold the lock.
    try {
      linkSync(stolenPath, OPENTUI_BUNDLE_LOCK_FILE)
      try {
        unlinkSync(stolenPath)
      } catch {
        // Ignore
      }
    } catch {
      try {
        const movedRaw = readFileSync(stolenPath, 'utf-8').trim()
        const movedHolder =
          movedRaw === '' ? null : Number.parseInt(movedRaw, 10)
        if (
          movedHolder === null ||
          !Number.isFinite(movedHolder) ||
          !isPidAlive(movedHolder)
        ) {
          unlinkSync(stolenPath)
        }
      } catch {
        // Ignore: the moved file is unreadable or already gone.
      }
    }
    return false
  }
  // The verified abandoned lock is ours to discard. Leave the freed path for
  // the next poll iteration's exclusive create — a competing waiter may claim
  // it first, and the loop simply tries again.
  try {
    unlinkSync(stolenPath)
  } catch {
    // Ignore
  }
  return false
}

/**
 * Serialize concurrent build-binary invocations behind an exclusive lock file
 * for the whole shared-bundle patch/restore + compile window (see
 * OPENTUI_BUNDLE_LOCK_FILE). Polls until the lock is acquired or the bounded
 * wait expires; the timeout fails this invocation with an actionable error
 * instead of hanging CI, and leaves the live holder's lock intact.
 */
async function acquireOpenTuiBundleLock(): Promise<void> {
  const deadline = Date.now() + OPENTUI_BUNDLE_LOCK_WAIT_MS
  // `attempt` numbers the poll iterations so each steal attempt's stolen
  // file gets a distinct private name (see tryAcquireOpenTuiBundleLock).
  let attempt = 0
  for (;;) {
    if (tryAcquireOpenTuiBundleLock(attempt)) return
    if (Date.now() >= deadline) {
      throw new Error(
        `Timed out after ${OPENTUI_BUNDLE_LOCK_WAIT_MS}ms waiting for the OpenTUI bundle lock (${OPENTUI_BUNDLE_LOCK_FILE}) held by another build-binary invocation; the shared node_modules bundle must not be patched or compiled concurrently.`,
      )
    }
    await sleep(OPENTUI_BUNDLE_LOCK_POLL_MS)
    attempt++
  }
}

/**
 * Release the lock only when it still holds this process's PID. The lock is
 * renamed to a private name FIRST and the moved file verified AFTER, so the
 * file removed is exactly the file verified: a read-then-unlink directly on
 * the shared path would race a concurrent waiter's steal-and-replace between
 * the read and the unlink and erase that waiter's live lock record — two
 * builds would then both patch/compile the shared @opentui/core bundle. If
 * the moved record is not ours, it is restored to the path; when the freed
 * path was already re-claimed, the moved record is discarded only when its
 * holder is provably dead. (Same contract as
 * scripts/start-services.ts releaseStartLock.)
 */
function releaseOpenTuiBundleLock(): void {
  const releasedPath = `${OPENTUI_BUNDLE_LOCK_FILE}.${process.pid}.released`
  try {
    renameSync(OPENTUI_BUNDLE_LOCK_FILE, releasedPath)
  } catch {
    // No lock at the path: already released or stolen. Nothing to do.
    return
  }
  try {
    if (
      readFileSync(releasedPath, 'utf-8').trim() === String(process.pid)
    ) {
      try {
        unlinkSync(releasedPath)
      } catch {
        // Ignore
      }
      return
    }
    // The moved record belongs to another holder: the path was stolen and
    // replaced between our acquisition and this release. Restore it so that
    // holder keeps ownership of the lock.
    try {
      linkSync(releasedPath, OPENTUI_BUNDLE_LOCK_FILE)
      try {
        unlinkSync(releasedPath)
      } catch {
        // Ignore
      }
    } catch {
      // The freed path was already re-claimed (linkSync EEXIST): discard the
      // moved record only when its holder is provably dead; a live holder's
      // record is preserved under the private name.
      try {
        const holderRaw = readFileSync(releasedPath, 'utf-8').trim()
        const holder = holderRaw === '' ? null : Number.parseInt(holderRaw, 10)
        if (
          holder === null ||
          !Number.isFinite(holder) ||
          !isPidAlive(holder)
        ) {
          unlinkSync(releasedPath)
        }
      } catch {
        // Ignore: the moved file is unreadable or already gone.
      }
    }
  } catch {
    // Ignore: best-effort release.
  }
}

function restoreOpenTuiCoreNativeLoader() {
  const coreDirs = [
    join(repoRoot, 'node_modules', '@opentui', 'core'),
    join(cliRoot, 'node_modules', '@opentui', 'core'),
  ]
  const searchedFiles = new Set<string>()

  for (const coreDir of coreDirs) {
    if (!existsSync(coreDir)) continue
    for (const file of readdirSync(coreDir)) {
      if (!file.startsWith('index') || !file.endsWith('.js')) continue
      const bundlePath = join(coreDir, file)
      if (searchedFiles.has(bundlePath)) continue
      searchedFiles.add(bundlePath)

      const source = readFileSync(bundlePath, 'utf8')
      const restored = restoreOpenTuiNativeLoaderSource(source)
      if (restored !== source) {
        // Atomic replace (see writeBundleFileAtomically): concurrent
        // build-binary invocations share this node_modules bundle, so a
        // plain writeFileSync could tear it or persist a mixed
        // patched/restored state.
        writeBundleFileAtomically(bundlePath, restored)
        logAlways(
          `Restored OpenTUI native loader (reverted stale legacy patch): ${bundlePath}`,
        )
      }
    }
  }
}

function patchOpenTuiCoreNativeLoaderForLegacy() {
  const coreDirs = [
    join(repoRoot, 'node_modules', '@opentui', 'core'),
    join(cliRoot, 'node_modules', '@opentui', 'core'),
  ]
  const searchedFiles = new Set<string>()
  let patchedPath: string | null = null

  for (const coreDir of coreDirs) {
    if (!existsSync(coreDir)) continue
    for (const file of readdirSync(coreDir)) {
      if (!file.startsWith('index') || !file.endsWith('.js')) continue
      const bundlePath = join(coreDir, file)
      if (searchedFiles.has(bundlePath)) continue
      searchedFiles.add(bundlePath)

      const source = readFileSync(bundlePath, 'utf8')
      if (
        !source.includes('@opentui/core-${process.platform}-${process.arch}')
      ) {
        continue
      }
      const patched = patchOpenTuiLegacyNativeLoaderSource(source)
      // Atomic replace (see writeBundleFileAtomically): concurrent
      // build-binary invocations share this node_modules bundle, so a plain
      // writeFileSync could tear it or persist a mixed patched/restored
      // state.
      writeBundleFileAtomically(bundlePath, patched)
      patchedPath = bundlePath
    }
  }

  if (!patchedPath) {
    throw new Error(
      `Could not find OpenTUI's dynamic platform loader in:\n  - ${[
        ...searchedFiles,
      ].join('\n  - ')}`,
    )
  }
  logAlways(`Patched OpenTUI legacy native loader: ${patchedPath}`)
}

main().catch((error: unknown) => {
  if (error instanceof Error) {
    console.error(error.message)
  } else {
    console.error(error)
  }
  process.exit(1)
})

/**
 * Find web-tree-sitter's tree-sitter.wasm in any plausible node_modules
 * layout — bun hoists differently across platforms and `bun install`
 * variants, and CI Windows lays it out differently than monorepo-root
 * installs.
 */
function findWebTreeSitterWasm(): string {
  const candidates = [
    join(cliRoot, 'node_modules', 'web-tree-sitter', 'tree-sitter.wasm'),
    join(cliRoot, '..', 'node_modules', 'web-tree-sitter', 'tree-sitter.wasm'),
    join(
      cliRoot,
      '..',
      'sdk',
      'node_modules',
      'web-tree-sitter',
      'tree-sitter.wasm',
    ),
  ]
  const found = candidates.find((p) => existsSync(p))
  if (found) return found
  try {
    const cliRequire = createRequire(join(cliRoot, 'package.json'))
    return cliRequire.resolve('web-tree-sitter/tree-sitter.wasm')
  } catch (err) {
    throw new Error(
      `Could not locate web-tree-sitter/tree-sitter.wasm. Searched:\n  - ` +
        candidates.join('\n  - ') +
        `\nAnd createRequire failed: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
}

async function findGrammarWasmSource(wasmFile: string): Promise<string> {
  const treeSitterWasmsName =
    wasmFile === 'tree-sitter-c-sharp.wasm'
      ? 'tree-sitter-c_sharp.wasm'
      : wasmFile
  const candidates = [
    join(repoRoot, 'sdk', 'dist', 'wasm', wasmFile),
    join(
      repoRoot,
      'node_modules',
      'tree-sitter-wasms',
      'out',
      treeSitterWasmsName,
    ),
    join(
      cliRoot,
      'node_modules',
      'tree-sitter-wasms',
      'out',
      treeSitterWasmsName,
    ),
    join(
      repoRoot,
      'node_modules',
      '@vscode',
      'tree-sitter-wasm',
      'wasm',
      wasmFile,
    ),
    join(
      cliRoot,
      'node_modules',
      '@vscode',
      'tree-sitter-wasm',
      'wasm',
      wasmFile,
    ),
  ]
  return resolveGrammarWasmSource({
    wasmFile,
    candidates,
    repairDir: join(repoRoot, 'sdk', 'dist', 'wasm'),
  })
}

function patchOpenTuiAssetPaths() {
  const coreDir = join(cliRoot, 'node_modules', '@opentui', 'core')
  if (!existsSync(coreDir)) {
    log('OpenTUI core package not found; skipping asset patch')
    return
  }

  const indexFile = readdirSync(coreDir).find(
    (file) => file.startsWith('index') && file.endsWith('.js'),
  )

  if (!indexFile) {
    log('OpenTUI core index bundle not found; skipping asset patch')
    return
  }

  const indexPath = join(coreDir, indexFile)
  const content = readFileSync(indexPath, 'utf8')

  const absolutePathPattern =
    /var __dirname = ".*?packages\/core\/src\/lib\/tree-sitter\/assets";/
  if (!absolutePathPattern.test(content)) {
    log('OpenTUI core bundle already has relative asset paths')
    return
  }

  const replacement =
    'var __dirname = path3.join(path3.dirname(fileURLToPath(new URL(".", import.meta.url))), "lib/tree-sitter/assets");'

  const patched = content.replace(absolutePathPattern, replacement)
  // Atomic replace (see writeBundleFileAtomically): concurrent build-binary
  // invocations share this node_modules bundle, so a plain writeFileSync
  // could tear it or persist a mixed patched/restored state.
  writeBundleFileAtomically(indexPath, patched)
  logAlways('Patched OpenTUI core tree-sitter asset paths')
}

// The OpenTUI native bundle is downloaded here via a direct registry fetch
// (not `bun install`/npm resolution), so its integrity is verified against
// pinned sha256 digests below rather than by extending the tree-sitter wasm
// manifest, which covers the sibling wasm assets staged elsewhere in this
// script. Digests are pinned per released tarball version; re-pin (update
// every entry together) whenever the OpenTUI core version bumps.
const OPENTUI_TARBALL_SHA256: Record<string, string> = {
  '@opentui/core-linux-x64': '703e55d1e46bf218986075748278435c85a13d86143065bd1897d2ab3e822ba9',
  '@opentui/core-linux-arm64': '08b8398bdaebc1a2b76b6a8a0a32c81d834c3bedf48d19f5d4b55a29be6b9508',
  '@opentui/core-darwin-x64': '9490d919f8fbace385267cf96160ee1b261cb5d12aeeaaf3290783db4ec176de',
  '@opentui/core-darwin-arm64': 'a323160f881f7b618ac0115f5a2c3dc1ba630aeb6f779d2d4ddf9a247b02a6f0',
  '@opentui/core-win32-x64': '3479016a17c32f2d77b4b7576cc9870393e65369c54daae876db11723d789429',
}

const UNPINNED_DIGEST = 'UNPINNED'

/**
 * Assert the sha256 digest of a downloaded OpenTUI tarball against
 * OPENTUI_TARBALL_SHA256. Skips with a warning when no digest is pinned;
 * throws when the downloaded bytes do not match the pinned digest.
 */
function assertTarballSha256(
  tarballBuffer: Uint8Array,
  packageName: string,
  version: string,
) {
  const actual = createHash('sha256')
    .update(tarballBuffer)
    .digest('hex')
  const expected = OPENTUI_TARBALL_SHA256[packageName]
  if (expected === undefined || expected === UNPINNED_DIGEST) {
    logAlways(
      `WARNING: no pinned sha256 digest for ${packageName}@${version}; skipping tarball integrity verification (actual sha256: ${actual} — pin it in OPENTUI_TARBALL_SHA256 to enforce integrity)`,
    )
    return
  }

  if (actual !== expected) {
    throw new Error(
      `Downloaded OpenTUI tarball ${packageName}@${version} failed sha256 verification: expected ${expected}, got ${actual}`,
    )
  }
  log(`Verified sha256 for ${packageName}@${version}`)
}

async function ensureOpenTuiNativeBundle(targetInfo: TargetInfo) {
  const packageName = `@opentui/core-${targetInfo.platform}-${targetInfo.arch}`
  const packageFolder = `core-${targetInfo.platform}-${targetInfo.arch}`
  const installTargets = [
    {
      label: 'workspace root',
      packagesDir: join(repoRoot, 'node_modules', '@opentui'),
      packageDir: join(repoRoot, 'node_modules', '@opentui', packageFolder),
    },
    {
      label: 'CLI workspace',
      packagesDir: join(cliRoot, 'node_modules', '@opentui'),
      packageDir: join(cliRoot, 'node_modules', '@opentui', packageFolder),
    },
  ]

  const missingTargets = installTargets.filter(
    ({ packageDir }) => !existsSync(packageDir),
  )
  if (missingTargets.length === 0) {
    log(
      `OpenTUI native bundle already present for ${targetInfo.platform}-${targetInfo.arch}`,
    )
    return
  }

  const corePackagePath =
    installTargets
      .map(({ packagesDir }) => join(packagesDir, 'core', 'package.json'))
      .find((candidate) => existsSync(candidate)) ?? null

  if (!corePackagePath) {
    log('OpenTUI core package metadata missing; skipping native bundle fetch')
    return
  }
  const corePackageJson = JSON.parse(readFileSync(corePackagePath, 'utf8')) as {
    optionalDependencies?: Record<string, string>
  }
  const version = corePackageJson.optionalDependencies?.[packageName]
  if (!version) {
    log(
      `No optional dependency declared for ${packageName}; skipping native bundle fetch`,
    )
    return
  }

  const registryBase =
    process.env.CODEBUFF_NPM_REGISTRY ??
    process.env.NPM_REGISTRY_URL ??
    'https://registry.npmjs.org'
  const metadataUrl = `${registryBase.replace(/\/$/, '')}/${encodeURIComponent(packageName)}`
  log(`Fetching OpenTUI native bundle metadata from ${metadataUrl}`)

  const metadata = (await fetchJsonWithRetry(metadataUrl)) as {
    versions?: Record<
      string,
      {
        dist?: {
          tarball?: string
        }
      }
    >
  }
  const tarballUrl = metadata.versions?.[version]?.dist?.tarball
  if (!tarballUrl) {
    throw new Error(`Tarball URL missing for ${packageName}@${version}`)
  }

  log(`Downloading OpenTUI native bundle from ${tarballUrl}`)
  const tarballBuffer = await fetchTarballBufferWithRetry(tarballUrl)

  const tempDir = mkdtempSync(join(tmpdir(), 'opentui-'))
  try {
    const tarballPath = join(
      tempDir,
      `${packageName.split('/').pop() ?? 'package'}-${version}.tgz`,
    )
    // The download (including its body read) completed inside the retried
    // fetch above; a stall or network failure mid-body was already retried
    // there instead of reaching this point.
    assertTarballSha256(tarballBuffer, packageName, version)
    await Bun.write(tarballPath, tarballBuffer)

    for (const target of missingTargets) {
      mkdirSync(target.packagesDir, { recursive: true })
      // Extract into a staging sibling directory instead of the final
      // packageDir: creating the target directory up front meant a tar
      // failure mid-extraction left a present-but-empty/partial directory
      // that the next build run treated as "bundle already present" and
      // skipped the fetch entirely — shipping a broken native bundle
      // silently. A staging dir keeps the final path either absent or
      // fully populated.
      // The PID disambiguates concurrent build invocations that start in
      // the same millisecond: identical staging paths would let one
      // process's rmSync(stagingDir) delete the other's in-progress
      // staging directory.
      const stagingDir = `${target.packageDir}.staging-${Date.now()}-${process.pid}`
      rmSync(stagingDir, { recursive: true, force: true })
      mkdirSync(stagingDir, { recursive: true })
      const previousExists = existsSync(target.packageDir)
      // Set once this attempt's rename put the bundle at packageDir: the
      // failure rollback below may remove it (when nothing pre-existed), but
      // must never remove a directory installed by a concurrent build.
      let installedByUs = false

      const tarballForTar =
        process.platform === 'win32'
          ? tarballPath.replace(/\\/g, '/')
          : tarballPath
      const extractDirForTar =
        process.platform === 'win32'
          ? stagingDir.replace(/\\/g, '/')
          : stagingDir

      const tarArgs = [
        '-xzf',
        tarballForTar,
        '--strip-components=1',
        '-C',
        extractDirForTar,
      ]
      if (process.platform === 'win32') {
        tarArgs.unshift('--force-local')
      }

      // Extraction succeeded: atomically move the staged bundle into
      // place. If a stale target directory already exists, move it to a
      // backup sibling first so a failed rename can restore the previous
      // bundle instead of destroying the only working copy.
      const backupDir = `${target.packageDir}.backup-${Date.now()}-${process.pid}`
      try {
        runCommand('tar', tarArgs)

        if (previousExists) {
          renameSync(target.packageDir, backupDir)
        }
        try {
          renameSync(stagingDir, target.packageDir)
        } catch (renameError) {
          if (previousExists && existsSync(backupDir)) {
            if (!existsSync(target.packageDir)) {
              // Nothing replaced the bundle we moved aside: put the previous
              // bundle back so the failure leaves the original state intact.
              renameSync(backupDir, target.packageDir)
            } else {
              // A concurrent build won the packageDir race between the
              // previousExists snapshot above and this rename and installed
              // a fresh bundle at the final path. Restoring the backup over
              // it would destroy their install, but leaving the backup in
              // place would strand the superseded bundle as a permanent
              // .backup-<ts>-<pid> sibling directory — delete it.
              rmSync(backupDir, { recursive: true, force: true })
            }
          }
          throw renameError
        }
        installedByUs = true
        if (previousExists) {
          rmSync(backupDir, { recursive: true, force: true })
        }
      } catch (error) {
        // Roll back only THIS target's half-installed state. Bundles this
        // attempt already finished installing into earlier targets are
        // complete, valid installs — deleting them here would destroy work
        // the next run would have to re-download. The next run re-checks
        // every install target before fetching, so completed targets are
        // skipped and only this failed target is retried. As before, a
        // directory installed by a concurrent build is never removed.
        if (installedByUs && !previousExists && existsSync(target.packageDir)) {
          rmSync(target.packageDir, { recursive: true, force: true })
        }
        rmSync(stagingDir, { recursive: true, force: true })
        throw error
      }
      log(
        `Installed OpenTUI native bundle for ${targetInfo.platform}-${targetInfo.arch} in ${target.label}`,
      )
    }
    logAlways(
      `Fetched OpenTUI native bundle for ${targetInfo.platform}-${targetInfo.arch}`,
    )
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }
}
