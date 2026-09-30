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
import { restoreOpenTuiNativeLoaderSource } from './open-tui-legacy-patch'

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

/**
 * Marker the built CLI's `--smoke-opentui` probe prints on success
 * (cli/src/index.tsx, consumed verbatim). Keep in sync with that probe.
 */
export const OPENTUI_SMOKE_OK_MARKER = 'opentui smoke ok'

/**
 * Pure argv for the standalone-binary smoke probe: the built binary is
 * spawned with the `--smoke-opentui` flag implemented in cli/src/index.tsx
 * (createTestRenderer over the packaged native library; never takes over
 * the terminal). Exported so unit tests can pin the probe invocation
 * without spawning anything.
 */
export function buildOpentuiSmokeArgs(): string[] {
  return ['--smoke-opentui']
}

/**
 * Assert the captured stdout of a `--smoke-opentui` probe run contains the
 * success marker. Kept pure so the unit tests can pin the acceptance
 * contract (marker present → pass, absent → fail closed) without spawning
 * a binary.
 */
export function assertOpentuiSmokeOutput(stdout: string): void {
  if (!stdout.includes(OPENTUI_SMOKE_OK_MARKER)) {
    throw new Error(
      `Standalone-binary smoke output does not contain "${OPENTUI_SMOKE_OK_MARKER}"; the built binary did not complete the OpenTUI native-library probe`,
    )
  }
}

/** Hard wall-clock budget for the standalone-binary smoke spawn. */
const SMOKE_BUILT_BINARY_TIMEOUT_MS = 60_000
/** Cap on the stdout/stderr echoed into a smoke failure, for readable logs. */
const SMOKE_OUTPUT_FAIL_SLICE = 8 * 1024

/**
 * Spawn the freshly built standalone binary with the `--smoke-opentui` probe
 * and require it to print the success marker. The probe runs with a hard
 * timeout so a hung binary fails the build with a bounded, actionable error
 * instead of stalling CI. On failure the captured stdout/stderr are included
 * in the thrown error (which main's handler prints). No shell interpolation:
 * the binary path and probe flag are passed directly to spawnSync.
 */
function runBuiltBinarySmoke(binaryPath: string): void {
  logAlways(
    `Running standalone-binary smoke on ${binaryPath} (--smoke-opentui, ${SMOKE_BUILT_BINARY_TIMEOUT_MS / 1000}s timeout)`,
  )
  const result = spawnSync(binaryPath, buildOpentuiSmokeArgs(), {
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: SMOKE_BUILT_BINARY_TIMEOUT_MS,
    env: process.env,
  })
  const stdout = result.stdout?.toString() ?? ''
  const stderr = result.stderr?.toString() ?? ''
  if (result.error) {
    throw new Error(
      `Standalone-binary smoke could not run ${binaryPath}: ${result.error.message}`,
    )
  }
  if (result.status !== 0) {
    throw new Error(
      `Standalone-binary smoke failed for ${binaryPath} with exit code ${result.status}${
        result.signal ? ` (signal ${result.signal})` : ''
      }\n--- stdout ---\n${stdout.slice(0, SMOKE_OUTPUT_FAIL_SLICE)}\n--- stderr ---\n${stderr.slice(0, SMOKE_OUTPUT_FAIL_SLICE)}`,
    )
  }
  assertOpentuiSmokeOutput(stdout)
  logAlways(
    `✅ Standalone-binary smoke passed: the built binary resolves the OpenTUI native library (${OPENTUI_SMOKE_OK_MARKER})`,
  )
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
  // Opt-in standalone-binary smoke (--smoke-built-binary). Default CI/release
  // invocations are unchanged: without the flag no smoke runs.
  const smokeBuiltBinary = process.argv.includes('--smoke-built-binary')

  if (!version) {
    throw new Error('Version argument is required when building a binary')
  }

  log(`Building ${binaryName} @ ${version}`)

  const targetInfo = getTargetInfo()
  // Resolved once up front so a misconfigured OPENTUI_LIBC fails the build
  // immediately (before the agent/SDK prebuilds) instead of mid-build, and
  // reused for the compile subprocess env below.
  const targetOpentuiLibc = resolveTargetOpentuiLibc(
    targetInfo.platform,
    process.env,
  )
  if (smokeBuiltBinary) {
    log('Standalone-binary smoke (--smoke-built-binary) enabled')
  }
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

  // Collect all NEXT_PUBLIC_* environment variables. JSON.stringify quotes
  // each value as a valid double-quoted JS string literal (escaping embedded
  // quotes and backslashes), so a value containing `"` cannot produce a
  // malformed --define argument. `value ?? ''` stays: JSON.stringify(undefined)
  // would otherwise return the string 'undefined'.
  const nextPublicEnvVars = Object.entries(process.env)
    .filter(([key]) => key.startsWith('NEXT_PUBLIC_'))
    .map(([key, value]) => [`process.env.${key}`, JSON.stringify(value ?? '')])

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
    restoreOpenTui05NativeLoaderPath()
    if (IS_LEGACY_MACOS_BUILD) {
      assertLegacyMacOSBuildConfig(targetInfo)
      verifyLegacyBundleShapeFixtures()
      assertLegacyCompilerSatisfiesOpentuiEngines()
      verifyLegacyOpentuiDylibMatchesPin()
      patchOpenTuiCoreNativeLoaderForLegacy()
    } else {
      await ensureOpenTuiNativeBundle(targetInfo)
    }

    log(
      `${COMPILER_BIN} ${buildArgs
        .map((arg) => (arg.includes(' ') ? `"${arg}"` : arg))
        .join(' ')}`,
    )

    // Pin the runtime libc resolution for the compiled binary: the 0.5.x
    // @opentui/core resolver reads OPENTUI_LIBC at runtime, so leaving it to
    // the ambient build environment would make the binary's native library
    // selection non-deterministic. Only Linux targets get the variable, and
    // only when it resolved to an explicit variant; an unset/empty value
    // means the runtime default (glibc) and stays unset. process.env is
    // spread so the compile subprocess keeps PATH and every other variable.
    const compileEnv =
      targetInfo.platform === 'linux' && targetOpentuiLibc
        ? { ...process.env, OPENTUI_LIBC: targetOpentuiLibc }
        : process.env

    runCommand(COMPILER_BIN, buildArgs, { cwd: cliRoot, env: compileEnv })
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

  // Opt-in standalone-binary smoke (the OpenTUI standalone-test acceptance
  // gate). Non-legacy lane only: the legacy macOS lane pairs a separate
  // prebuilt dylib and is validated by its own gates.
  if (smokeBuiltBinary && !IS_LEGACY_MACOS_BUILD) {
    runBuiltBinarySmoke(outputFile)
  } else if (smokeBuiltBinary) {
    log('Skipping standalone-binary smoke: not supported on the legacy macOS lane')
  }

  logAlways(
    `✅ Built ${outputFilename} (${targetInfo.platform}-${targetInfo.arch})`,
  )
}

/**
 * Legacy macOS lane requirement (finding RF-1-8372bc6f): the legacy build
 * lane must keep working against the OpenTUI 0.5.x bundle shape. For the
 * pinned @opentui/core 0.5.x release the lane requires, and the gates in the
 * legacy branch of main() enforce, exactly:
 * 1. the 0.5.x native-library resolver (resolveNativeLibraryPath) appears
 *    exactly once across the shipped index/chunk-*.js bundles, in one of the
 *    two shapes recorded in verifyLegacyBundleShapeFixtures, so the sibling
 *    libopentui.dylib patch applies and restores losslessly (the fixture
 *    self-check plus the in-patch round-trip verification inside
 *    patchOpenTuiCoreNativeLoaderForLegacy provide runtime evidence);
 * 2. the shipped legacy libopentui.dylib's source version matches the
 *    installed @opentui/core (verifyLegacyOpentuiDylibMatchesPin);
 * 3. the legacy compiler satisfies the installed core's engines.bun floor
 *    (assertLegacyCompilerSatisfiesOpentuiEngines).
 * Every gate fails closed and logs its own runtime evidence line at build
 * time.
 */
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

/**
 * OpenTUI 0.5.x replaced the 0.2.x template-literal platform import
 * (`await import(`@opentui/core-${process.platform}-${process.arch}/index.ts`)`)
 * with resolveNativeLibraryPath() backed by static per-platform imports, so
 * the 0.2.x-only patch in ./open-tui-legacy-patch.ts no longer finds a loader
 * to rewrite and every legacy macOS build failed closed. The legacy macOS
 * lane still ships a macOS 11-compatible libopentui.dylib next to the
 * executable, so the 0.5.x resolver assignment is rewritten to that sibling
 * path. In the shipped @opentui/core 0.5.12 bundle the resolver lives inside
 * a chunk-*.js bundle and declares `var targetLibPath;` separately from its
 * later assignment (`targetLibPath = await resolveNativeLibraryPath();`), so
 * the pattern must match the bare assignment as well as a combined
 * `var`-declaration form. The original statement is preserved verbatim in a
 * marker comment so restoreOpenTui05NativeLoaderSource() can revert the patch
 * exactly; restoring must always run before a legacy patch is re-applied to
 * the shared node_modules bundle. The legacy replacement text is
 * byte-identical to the 0.2.x legacy loader in ./open-tui-legacy-patch.ts, so
 * restoreOpenTuiCoreNativeLoader() must not touch files carrying 0.5.x patch
 * evidence (the marker comment or a 0.5.x resolver): rewriting them to the
 * 0.2.x canonical loader would corrupt the 0.5.x bundle before its own
 * restore runs.
 */
const OPEN_TUI_05_RESOLVER_PATTERN =
  /\b(?:var\s+)?targetLibPath\s*=\s*(?:await\s+)?resolveNativeLibraryPath\s*\(\s*\)\s*;/g
const OPEN_TUI_05_RESOLVER_LEGACY_REPLACEMENT =
  'var targetLibPath = process.execPath.slice(0, process.execPath.lastIndexOf("/") + 1) + "libopentui.dylib";'
const OPEN_TUI_05_RESOLVER_ORIGINAL_MARKER =
  '__OPENBUFF_LEGACY_05_RESOLVER_ORIGINAL__'

/** True when `source` carries OpenTUI 0.5.x's resolveNativeLibraryPath loader. */
function isOpenTui05NativeLoaderSource(source: string): boolean {
  return [...source.matchAll(OPEN_TUI_05_RESOLVER_PATTERN)].length > 0
}

/**
 * Rewrite OpenTUI 0.5.x's resolveNativeLibraryPath() loader to the sibling
 * dylib path used by the legacy macOS lane. Throws when the loader is absent
 * or ambiguous instead of patching a bundle of unknown shape.
 */
function patchOpenTui05NativeLoaderSource(source: string): string {
  const matches = [...source.matchAll(OPEN_TUI_05_RESOLVER_PATTERN)]
  if (matches.length !== 1) {
    throw new Error(
      `Expected exactly one OpenTUI 0.5.x native library resolver, found ${matches.length}`,
    )
  }
  const original = matches[0]![0]
  return source.replace(
    original,
    `/*${OPEN_TUI_05_RESOLVER_ORIGINAL_MARKER} ${JSON.stringify(original)}*/\n${OPEN_TUI_05_RESOLVER_LEGACY_REPLACEMENT}`,
  )
}

/**
 * Revert patchOpenTui05NativeLoaderSource (a no-op on unpatched sources).
 * Fails closed when the marker exists but the recorded-original/legacy block
 * cannot be matched: silently returning here would leave a stale
 * legacy-patched 0.5.x resolver in the shared node_modules bundle for the
 * non-legacy build to compile with no signal that anything went wrong.
 */
function restoreOpenTui05NativeLoaderSource(source: string): string {
  const markerStart = `/*${OPEN_TUI_05_RESOLVER_ORIGINAL_MARKER} `
  const start = source.indexOf(markerStart)
  if (start === -1) return source
  const end = source.indexOf('*/', start)
  if (end === -1) {
    throw new Error(
      `Found an unterminated ${OPEN_TUI_05_RESOLVER_ORIGINAL_MARKER} comment; the shared OpenTUI 0.5.x bundle carries a corrupt legacy patch and cannot be restored — reinstall @opentui/core before building`,
    )
  }
  const markerBlock = source.slice(start, end + 2)
  let original: string
  try {
    const parsed: unknown = JSON.parse(
      source.slice(start + markerStart.length, end),
    )
    if (typeof parsed !== 'string') {
      throw new Error('the recorded original is not a JSON string')
    }
    original = parsed
  } catch (error) {
    throw new Error(
      `Could not restore the OpenTUI 0.5.x native library resolver: the ${OPEN_TUI_05_RESOLVER_ORIGINAL_MARKER} comment does not record the original resolver as a JSON string (${error instanceof Error ? error.message : String(error)}); the shared OpenTUI 0.5.x bundle carries a corrupt legacy patch — reinstall @opentui/core before building`,
    )
  }
  const patchedBlock = `${markerBlock}\n${OPEN_TUI_05_RESOLVER_LEGACY_REPLACEMENT}`
  if (!source.includes(patchedBlock)) {
    throw new Error(
      `Found the ${OPEN_TUI_05_RESOLVER_ORIGINAL_MARKER} comment but not the legacy resolver block it recorded; the shared OpenTUI 0.5.x bundle carries a stale legacy patch of an unexpected shape — reinstall @opentui/core before building`,
    )
  }
  return source.replace(patchedBlock, original)
}

/**
 * OpenTUI 0.5.x ships its JS as an index entry plus code-split chunk-*.js
 * bundles (chunk-bun-*.js in @opentui/core 0.5.12). The native-library
 * resolver and the tree-sitter asset references live in the chunks, so every
 * scan of the shared node_modules bundle must consider both layouts.
 */
function isOpentuiCoreBundleFile(file: string): boolean {
  return (
    file.endsWith('.js') &&
    (file.startsWith('index') || file.startsWith('chunk'))
  )
}

function restoreOpenTui05NativeLoaderPath() {
  const coreDirs = [
    join(repoRoot, 'node_modules', '@opentui', 'core'),
    join(cliRoot, 'node_modules', '@opentui', 'core'),
  ]
  const searchedFiles = new Set<string>()

  for (const coreDir of coreDirs) {
    if (!existsSync(coreDir)) continue
    for (const file of readdirSync(coreDir)) {
      if (!isOpentuiCoreBundleFile(file)) continue
      const bundlePath = join(coreDir, file)
      if (searchedFiles.has(bundlePath)) continue
      searchedFiles.add(bundlePath)

      const source = readFileSync(bundlePath, 'utf8')
      const restored = restoreOpenTui05NativeLoaderSource(source)
      if (restored !== source) {
        // Atomic replace (see writeBundleFileAtomically): concurrent
        // build-binary invocations share this node_modules bundle.
        writeBundleFileAtomically(bundlePath, restored)
        logAlways(
          `Restored OpenTUI 0.5.x native resolver (reverted stale legacy patch): ${bundlePath}`,
        )
      }
    }
  }
}

/**
 * The legacy macOS lane copies a prebuilt libopentui.dylib next to the
 * executable while the compiled binary embeds the JS bindings of the
 * @opentui/core version pinned in cli/package.json. The two FFI surfaces
 * must match: newer OpenTUI versions add FFI entry points (clipboard, audio)
 * and change struct layouts, so a dylib built from an older OpenTUI source
 * crashes or misbehaves under newer bindings. Callers that know the dylib's
 * source version declare it via OPENBUFF_LEGACY_OPENTUI_VERSION, and it must
 * equal the installed @opentui/core version. Without that declaration the
 * gate still fails closed on the drift it can observe from the workspace:
 * the legacy lane (0.5.x native-library resolver patch plus the shipped
 * dylib pairing) is validated only against the pinned @opentui/core version,
 * so an installed core that has moved off the pin must not compile the
 * legacy lane.
 */
function verifyLegacyOpentuiDylibMatchesPin() {
  const installedCoreVersion = readInstalledOpentuiCoreVersion()
  const dylibVersion = process.env.OPENBUFF_LEGACY_OPENTUI_VERSION
  if (dylibVersion) {
    if (dylibVersion !== installedCoreVersion) {
      throw new Error(
        `Legacy libopentui.dylib version ${dylibVersion} does not match the installed @opentui/core ${installedCoreVersion}; rebuild the legacy dylib from the matching OpenTUI source before building the legacy lane.`,
      )
    }
    logAlways(
      `Verified legacy libopentui.dylib version ${dylibVersion} matches @opentui/core ${installedCoreVersion}`,
    )
    return
  }
  const pinnedCoreVersion = readPinnedOpentuiCoreVersion()
  if (installedCoreVersion !== pinnedCoreVersion) {
    throw new Error(
      `Installed @opentui/core ${installedCoreVersion} does not match the pinned version ${pinnedCoreVersion} in cli/package.json; the legacy macOS lane (0.5.x native-library resolver patch and libopentui.dylib pairing) is validated only against the pin. Install @opentui/core ${pinnedCoreVersion} or declare the legacy dylib's source version via OPENBUFF_LEGACY_OPENTUI_VERSION.`,
    )
  }
  logAlways(
    `Verified legacy lane against @opentui/core pin ${pinnedCoreVersion} (installed ${installedCoreVersion})`,
  )
}

type OpentuiCorePackageInfo = {
  version?: string
  engines?: { bun?: string; node?: string }
}

function readInstalledOpentuiCorePackage(): OpentuiCorePackageInfo {
  for (const base of [cliRoot, repoRoot]) {
    const corePackagePath = join(
      base,
      'node_modules',
      '@opentui',
      'core',
      'package.json',
    )
    if (!existsSync(corePackagePath)) continue
    return JSON.parse(readFileSync(corePackagePath, 'utf8')) as OpentuiCorePackageInfo
  }
  throw new Error(
    'Could not read the installed @opentui/core version from node_modules/@opentui/core/package.json',
  )
}

function readInstalledOpentuiCoreVersion(): string {
  const { version } = readInstalledOpentuiCorePackage()
  if (!version) {
    throw new Error(
      'The installed @opentui/core package.json does not declare a version',
    )
  }
  return version
}

/**
 * Parse a dot-separated numeric version (e.g. '1.2.0') into numeric parts.
 * Returns null when any component is not fully numeric — including prerelease
 * suffixes ('1.2.0-beta.1' must fail closed, not silently parse its '0-beta'
 * component as the numeric part 0) — so callers never compare a version they
 * cannot interpret exactly.
 */
function parseNumericVersionParts(version: string): number[] | null {
  const parts = version.split('.')
  if (parts.length === 0) return null
  const numericParts: number[] = []
  for (const part of parts) {
    if (!/^[0-9]+$/.test(part)) return null
    numericParts.push(Number.parseInt(part, 10))
  }
  return numericParts
}

/**
 * Compare two numeric version part lists, padding the shorter with zeros so
 * a shorter bound (e.g. the [2] ceiling of '^1') compares correctly against
 * a longer version (e.g. '1.5.0').
 */
function compareVersionParts(a: number[], b: number[]): number {
  const length = Math.max(a.length, b.length)
  for (let i = 0; i < length; i++) {
    const aPart = a[i] ?? 0
    const bPart = b[i] ?? 0
    if (aPart !== bPart) return aPart < bPart ? -1 : 1
  }
  return 0
}

/**
 * Exclusive upper bound, as numeric parts, of a `^` or `~` floor per semver
 * range semantics: `^a.b.c` excludes (a+1).0.0 — or 0.(b+1).0 / 0.0.(c+1)
 * when the leading majors are zero — and `~a.b.c` excludes a.(b+1).0 (a bare
 * `~a` or `^a` excludes (a+1).0.0). Without this ceiling the legacy-lane
 * gate would treat these comparators as unbounded >= floors and accept a
 * far newer compiler than the range declares.
 */
function caretTildeCeiling(
  operator: '^' | '~',
  floorParts: number[],
): number[] {
  const [major = 0, minor = 0, patch = 0] = floorParts
  if (operator === '^') {
    if (floorParts.length === 1 || major > 0) return [major + 1]
    if (floorParts.length === 2 || minor > 0) return [0, minor + 1]
    return [0, 0, patch + 1]
  }
  if (floorParts.length === 1) return [major + 1]
  return [major, minor + 1]
}

/**
 * Minimal engines-range check for the legacy-lane gate: a range is satisfied
 * when at least one `||` alternative is satisfied and every space-separated
 * comparator inside an alternative is satisfied. Supported operators are
 * >=, >, <=, <, =, and `^`/`~` as semver ranges with an exclusive ceiling
 * (`^1.0.0` is [1.0.0, 2.0.0), `~1.2.0` is [1.2.0, 1.3.0)) — not bare >=
 * floors. Anything the parser cannot interpret — including prerelease
 * versions on either side of a comparison — fails closed so the gate never
 * silently skips a check it could not evaluate.
 */
function isVersionSatisfyingRange(version: string, range: string): boolean {
  const versionParts = parseNumericVersionParts(version)
  if (!versionParts) return false
  return range.split('||').some((alternative) =>
    alternative
      .trim()
      .split(/\s+/)
      .every((comparator) => {
        const match = /^(>=|<=|>|<|=|\^|~)?\s*v?([0-9][0-9.]*)$/.exec(
          comparator.trim(),
        )
        if (!match) return false
        const floorParts = parseNumericVersionParts(match[2]!)
        if (!floorParts) return false
        switch (match[1]) {
          case '^':
          case '~': {
            const ceiling = caretTildeCeiling(match[1], floorParts)
            return (
              compareVersionParts(versionParts, floorParts) >= 0 &&
              compareVersionParts(versionParts, ceiling) < 0
            )
          }
          case '>':
            return compareVersionParts(versionParts, floorParts) > 0
          case '<':
            return compareVersionParts(versionParts, floorParts) < 0
          case '<=':
            return compareVersionParts(versionParts, floorParts) <= 0
          case '=':
          case undefined:
            return compareVersionParts(versionParts, floorParts) === 0
          default:
            return compareVersionParts(versionParts, floorParts) >= 0
        }
      }),
  )
}

/**
 * The legacy macOS lane compiles src/index.tsx with a Bun 1.0-era compiler
 * (COMPILER_BIN predates --production; see the buildArgs branch in main),
 * while the bundle it embeds — the installed @opentui/core — declares a
 * minimum Bun version in its engines field that the JS bundle's syntax may
 * depend on. verifyLegacyOpentuiDylibMatchesPin gates the dylib FFI pairing
 * but cannot observe the compiler, so this gate runs `COMPILER_BIN --version`
 * and fails closed when it does not satisfy the installed core's engines.bun
 * floor: a legacy lane compiled by an older compiler against a newer JS
 * bundle must fail at build time instead of misparsing or crashing at
 * runtime.
 */
function assertLegacyCompilerSatisfiesOpentuiEngines() {
  const corePackage = readInstalledOpentuiCorePackage()
  if (!corePackage.version) {
    throw new Error(
      'The installed @opentui/core package.json does not declare a version; cannot evaluate the legacy compiler gate',
    )
  }
  const bunFloor = corePackage.engines?.bun
  if (!bunFloor) {
    log(
      `Installed @opentui/core ${corePackage.version} declares no engines.bun floor; skipping the legacy compiler gate`,
    )
    return
  }
  const versionResult = spawnSync(COMPILER_BIN, ['--version'], {
    stdio: 'pipe',
  })
  if (versionResult.status !== 0) {
    throw new Error(
      `Could not read ${COMPILER_BIN} --version (exit code ${versionResult.status}); the legacy macOS lane cannot verify the compiler against @opentui/core ${corePackage.version}'s engines.bun floor (${bunFloor})`,
    )
  }
  const compilerVersion =
    versionResult.stdout?.toString().trim().split(/\s+/).pop() ?? ''
  if (!isVersionSatisfyingRange(compilerVersion, bunFloor)) {
    throw new Error(
      `The legacy macOS lane compiles with ${COMPILER_BIN} ${compilerVersion}, which does not satisfy @opentui/core ${corePackage.version}'s engines.bun floor (${bunFloor}). The 0.5.x JS bundle may use syntax the legacy compiler cannot parse or compile; use a compiler at or above the floor or pin an @opentui/core version the legacy compiler supports before building the legacy lane.`,
    )
  }
  logAlways(
    `Verified legacy compiler ${COMPILER_BIN} ${compilerVersion} satisfies @opentui/core ${corePackage.version} engines.bun (${bunFloor})`,
  )
}

/** A legacy-gate self-check expectation that must fail with `expectedSubstring`. */
function expectLegacySelfCheckFailure(
  label: string,
  expectedSubstring: string,
  thrower: () => unknown,
): void {
  try {
    thrower()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (!message.includes(expectedSubstring)) {
      throw new Error(
        `Legacy gate self-check (${label}) failed with an unexpected error: ${message}`,
      )
    }
    return
  }
  throw new Error(
    `Legacy gate self-check (${label}) did not fail closed as required`,
  )
}

/**
 * Deterministic runtime evidence for the legacy lane's 0.5.x bundle-shape
 * contract (see the requirement comment above assertLegacyMacOSBuildConfig).
 * Runs on every legacy build BEFORE the real shipped bundle is patched and
 * fails closed when the recorded 0.5.12 fixture shapes no longer match the
 * resolver regex, when the patch/restore cycle is lossy, when a corrupt
 * legacy patch is not rejected on restore, or when the engines-range gate
 * mis-evaluates a version. The REAL shipped 0.5.12 chunk bundles are
 * additionally verified by the round-trip check inside
 * patchOpenTuiCoreNativeLoaderForLegacy, so only a successful legacy build
 * run against the actual node_modules bundle completes the runtime evidence
 * for the lane.
 */
function verifyLegacyBundleShapeFixtures(): void {
  // Recorded from the shipped @opentui/core 0.5.12 chunk bundles: the
  // resolver appears both as a combined `var` declaration+assignment and as
  // a bare assignment following a separate `var targetLibPath;` declaration.
  const resolverFixtures = [
    'var targetLibPath = await resolveNativeLibraryPath();',
    'var targetLibPath;\nconst nativeModule = await import("./native.js");\ntargetLibPath = await resolveNativeLibraryPath();',
  ]
  for (const fixture of resolverFixtures) {
    // Unpatched restore must be a no-op.
    if (restoreOpenTui05NativeLoaderSource(fixture) !== fixture) {
      throw new Error(
        'Legacy gate self-check: restoreOpenTui05NativeLoaderSource modified an unpatched 0.5.12 fixture',
      )
    }
    const patched = patchOpenTui05NativeLoaderSource(fixture)
    if (!patched.includes(OPEN_TUI_05_RESOLVER_LEGACY_REPLACEMENT)) {
      throw new Error(
        'Legacy gate self-check: the 0.5.12 fixture patch does not carry the sibling-dylib legacy resolver',
      )
    }
    if (restoreOpenTui05NativeLoaderSource(patched) !== fixture) {
      throw new Error(
        'Legacy gate self-check: the 0.5.12 resolver patch does not round-trip losslessly',
      )
    }
  }
  expectLegacySelfCheckFailure(
    '0.5.12 resolver absent',
    'found 0',
    () => patchOpenTui05NativeLoaderSource('var unrelated = 1;'),
  )
  expectLegacySelfCheckFailure(
    '0.5.12 resolver ambiguous',
    'found 2',
    () =>
      patchOpenTui05NativeLoaderSource(
        `${resolverFixtures[0]}\n${resolverFixtures[0]}`,
      ),
  )
  expectLegacySelfCheckFailure(
    'corrupt legacy patch marker on restore',
    'stale legacy patch',
    () =>
      restoreOpenTui05NativeLoaderSource(
        `/*${OPEN_TUI_05_RESOLVER_ORIGINAL_MARKER} ${JSON.stringify(resolverFixtures[0])}*/\nvar unrelated = 1;`,
      ),
  )

  // Spot-check the engines.bun range gate the legacy compiler check relies
  // on, including the fail-closed cases (^/~ ceilings, prerelease versions,
  // unparseable versions).
  const rangeChecks: Array<[version: string, range: string, expected: boolean]> = [
    ['1.3.11', '^1.2.0', true],
    ['1.2.11', '^1.2.0', true],
    ['2.0.0', '^1.2.0', false],
    ['1.2.11', '~1.2.0', true],
    ['1.3.11', '~1.2.0', false],
    ['1.3.11', '>=1.0.0', true],
    ['1.0.0', '^1.2.0', false],
    ['1.3.11-beta.1', '^1.2.0', false],
    ['1.9.5', '^1.0.0 || >=1.9.0', true],
    ['1.3.11', '^2.0.0 || <1.0.0', false],
    ['not-a-version', '^1.0.0', false],
  ]
  for (const [version, range, expected] of rangeChecks) {
    if (isVersionSatisfyingRange(version, range) !== expected) {
      throw new Error(
        `Legacy gate self-check: isVersionSatisfyingRange(${version}, ${range}) should be ${expected}`,
      )
    }
  }
  logAlways(
    'Legacy gate self-check OK: 0.5.12 resolver fixtures patch/restore round-trip, corrupt-patch restore fails closed, engines.bun range gate verified',
  )
}

/**
 * Read the @opentui/core version pinned in cli/package.json, stripping any
 * range prefix (`^`, `~`, `>=`) so a ranged pin still compares equal to the
 * exact installed version.
 */
function readPinnedOpentuiCoreVersion(): string {
  const packageJson = JSON.parse(
    readFileSync(join(cliRoot, 'package.json'), 'utf8'),
  ) as { dependencies?: Record<string, string> }
  const pinned = packageJson.dependencies?.['@opentui/core']
  if (!pinned) {
    throw new Error(
      'cli/package.json does not declare an @opentui/core dependency; cannot verify the legacy lane against the pin',
    )
  }
  return pinned.replace(/^[^0-9]*/, '')
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
      // Under the 0.5.12 bundle layout this 0.2.x restore must not touch
      // files carrying 0.5.x native-loader evidence: the 0.2.x legacy loader
      // text is byte-identical to OPEN_TUI_05_RESOLVER_LEGACY_REPLACEMENT, so
      // a stale 0.5.x legacy patch would otherwise be misread as a 0.2.x
      // patch here and rewritten to the 0.2.x canonical platform import,
      // corrupting the 0.5.x bundle before its own restore runs below.
      if (
        source.includes(OPEN_TUI_05_RESOLVER_ORIGINAL_MARKER) ||
        isOpenTui05NativeLoaderSource(source)
      ) {
        continue
      }
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
      if (!isOpentuiCoreBundleFile(file)) continue
      const bundlePath = join(coreDir, file)
      if (searchedFiles.has(bundlePath)) continue
      searchedFiles.add(bundlePath)

      const source = readFileSync(bundlePath, 'utf8')
      if (!isOpenTui05NativeLoaderSource(source)) {
        continue
      }
      const patched = patchOpenTui05NativeLoaderSource(source)
      // Runtime evidence that the legacy patch is losslessly reversible on
      // the REAL shipped 0.5.12 chunk bundle (the fixture self-check covers
      // only the recorded shapes): the shared node_modules bundle must be
      // restorable for non-legacy builds, so a one-way patch must fail this
      // legacy build instead of poisoning the shared copy.
      const roundTripped = restoreOpenTui05NativeLoaderSource(patched)
      if (roundTripped !== source) {
        throw new Error(
          `The legacy resolver patch does not round-trip on ${bundlePath}: restoring the patched source does not reproduce the original bundle; refusing to compile the legacy lane against a one-way patch`,
        )
      }
      // Atomic replace (see writeBundleFileAtomically): concurrent
      // build-binary invocations share this node_modules bundle, so a plain
      // writeFileSync could tear it or persist a mixed patched/restored
      // state.
      writeBundleFileAtomically(bundlePath, patched)
      logAlways(`Verified legacy resolver patch round-trip: ${bundlePath}`)
      patchedPath = bundlePath
    }
  }

  if (!patchedPath) {
    throw new Error(
      `Could not find OpenTUI's 0.5.x native library resolver (resolveNativeLibraryPath) in:\n  - ${[
        ...searchedFiles,
      ].join('\n  - ')}`,
    )
  }
  logAlways(`Patched OpenTUI 0.5.x native library resolver: ${patchedPath}`)
}

// Guarded so the unit tests in cli/src/__tests__ can import this module for
// its exported pure helpers without executing a full build.
if (import.meta.main) {
  main().catch((error: unknown) => {
    if (error instanceof Error) {
      console.error(error.message)
    } else {
      console.error(error)
    }
    process.exit(1)
  })
}

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

  // OpenTUI 0.2.x embedded a hard-coded build-machine __dirname pointing into
  // its own source tree ('packages/core/src/lib/tree-sitter/assets'). 0.5.x
  // no longer contains that pattern, so under the 0.5.12 pin the old rewrite
  // silently no-opped and left it unverified whether tree-sitter assets
  // resolve inside the compiled binary. Keep the 0.2.x rewrite for any
  // residue, then verify the 0.5.x bundle: it must not embed a build-machine
  // asset path and must carry a relative tree-sitter grammar asset reference
  // (a quoted ./…tree-sitter-*.wasm specifier, not the bare substring).
  const absolutePathPattern =
    /var __dirname = ".*?packages\/core\/src\/lib\/tree-sitter\/assets";/
  if (absolutePathPattern.test(content)) {
    const replacement =
      'var __dirname = path3.join(path3.dirname(fileURLToPath(new URL(".", import.meta.url))), "lib/tree-sitter/assets");'

    const patched = content.replace(absolutePathPattern, replacement)
    // Atomic replace (see writeBundleFileAtomically): concurrent build-binary
    // invocations share this node_modules bundle, so a plain writeFileSync
    // could tear it or persist a mixed patched/restored state.
    writeBundleFileAtomically(indexPath, patched)
    logAlways('Patched OpenTUI core tree-sitter asset paths')
    return
  }

  const buildMachineAssetPath = 'packages/core/src/lib/tree-sitter/assets'
  // 0.5.12 moved every tree-sitter asset reference out of the index entry
  // into its chunk-*.js bundles, so the 0.5.x verification must inspect every
  // bundle file: checking only the index entry fails valid 0.5.12 builds.
  const bundleFiles = readdirSync(coreDir).filter(isOpentuiCoreBundleFile)
  const bundleContents = bundleFiles.map((file) =>
    readFileSync(join(coreDir, file), 'utf8'),
  )
  const offendingBundleIndex = bundleContents.findIndex((bundleContent) =>
    bundleContent.includes(buildMachineAssetPath),
  )
  if (offendingBundleIndex !== -1) {
    throw new Error(
      `OpenTUI core bundle embeds a build-machine tree-sitter asset path that would not resolve inside a compiled binary: ${join(coreDir, bundleFiles[offendingBundleIndex]!)}`,
    )
  }
  // The bare substring 'tree-sitter' is satisfied vacuously (identifiers,
  // the web-tree-sitter package specifier, module paths), so require a
  // relative asset reference to a tree-sitter grammar wasm — exactly what
  // the compiled binary must resolve, e.g.
  // "./assets/javascript/tree-sitter-javascript.wasm" in the 0.5.12 chunks.
  const relativeTreeSitterWasmReference =
    /["'`]\.{1,2}\/[^"'`]*tree-sitter[^"'`]*\.wasm["'`]/
  if (
    !bundleContents.some((bundleContent) =>
      relativeTreeSitterWasmReference.test(bundleContent),
    )
  ) {
    throw new Error(
      `OpenTUI core bundle has no relative tree-sitter grammar asset reference (./…tree-sitter-*.wasm) to verify; refusing to compile a binary that may not resolve its grammar assets: ${indexPath}`,
    )
  }
  logAlways(
    'Verified OpenTUI core tree-sitter asset paths resolve relatively (0.5.x bundle)',
  )
}

// The OpenTUI native bundle is downloaded here via a direct registry fetch
// (not `bun install`/npm resolution), so its integrity is verified against
// pinned sha256 digests below rather than by extending the tree-sitter wasm
// manifest, which covers the sibling wasm assets staged elsewhere in this
// script. Digests are pinned per released tarball version; re-pin (update
// every entry together) whenever the OpenTUI core version bumps.
// Re-pinned 2026-09-28 for @opentui/core 0.5.12 (0.2.2 → 0.5.12 migration,
// Stage 1); the version is read from the installed core's package.json, so
// only these digests change on a bump.
/**
 * Pinned integrity digests for the OpenTUI optional native packages, copied
 * from the `sha512-…` integrity records bun.lock resolved for the
 * @opentui/core 0.5.12 optionalDependencies. Because the pin shares a source
 * with the lock, assertTarballIntegrity cross-checks every pinned digest
 * against the dist.integrity the registry publishes for the exact version
 * (fetched live during the build) before trusting it: a compromised or
 * mistyped bun.lock record now fails the build instead of propagating
 * verbatim into this gate. assertTarballIntegrity fails
 * closed when a package has no entry, so EVERY optional native package the
 * fetch path can target must be pinned — including @opentui/core-win32-arm64
 * and the musl Linux variants — so a win32-arm64 build that needs
 * ensureOpenTuiNativeBundle verifies its tarball instead of hard-failing on a
 * missing digest, and an OpenTUI version bump must re-pin every digest before
 * the build ships unverified tarballs.
 */
const OPENTUI_TARBALL_SHA512: Record<string, string> = {
  '@opentui/core-linux-x64': 'sha512-eZiCjEzwbb6qClPPfk32Nha9xmr9obt69Xj0+9SKsXxWLBKkjQEGOMRoh/R9ObaQF4aq8If1xV3VEY0sD9W9vg==',
  '@opentui/core-linux-arm64': 'sha512-XeKhuIaEtgipvuPHbl4qPOBj+Ut+2zObmsxMVM1jDcjz/FatG9PGeGQPx1G1SnvH2AgpT4K+eCu7DUF0+yIqoQ==',
  '@opentui/core-darwin-x64': 'sha512-uRrQJdHmLUSj3PV23QPi3WSimYTTxcXnVouxF6U4xMXlOv4N3SxnHfVwMRQkPqbGOfvVWHeLE6FdK4C+ubU0sQ==',
  '@opentui/core-darwin-arm64': 'sha512-YdVnP0tAyerBNl0mIcmQEOotPeZzW1VnSXKBl5cyZ5e6nDd2Y+ui/8eRPpn1oqcamf1NCnzS4ohMgejOvna8Zg==',
  '@opentui/core-win32-x64': 'sha512-KTwtwpfd2zF9opVh3SyRJYDd1o3Xv4XL8OZb8Zi+CqWUel6Y2IDCiVivCv8fGJt3J7wOIXXtuZI9ZUkLyKJCiQ==',
  '@opentui/core-win32-arm64': 'sha512-aLbm6870Ybls6CYL4zMOCImTBPLZHZMUXJFGqMI44lIWxitkAtT6zg5lYA4oRqFRzzryDclxr29+hDgT3p3Blw==',
  '@opentui/core-linux-x64-musl': 'sha512-WWW0hVBoSYZ3D6AgZ4u2Y5/u/IyIq2pDb+4yI3WgJ70Wyt6ofHy+6kRGRgbXFn1p+rPInAHjCXD2v6C7iEKSrA==',
  '@opentui/core-linux-arm64-musl': 'sha512-VZ2sNMw1d/r1SLPjUbOP9LKscKz1CQjID8adTL6gG8Lrrq+mYcIUxutyB+P/eG0J/7oRZLPR6OMt7dUOap6RTg==',
}

/**
 * Assert the sha512 integrity of a downloaded OpenTUI tarball against BOTH
 * independent sources: the registry's published dist.integrity for the exact
 * version (fetched live during this build) and the pinned
 * OPENTUI_TARBALL_SHA512 record. The pinned digests were copied from
 * bun.lock, so on their own they only verify the tarball against whatever
 * the lock resolved — cross-checking pin vs registry and downloaded bytes vs
 * registry makes a compromised or mistyped lock record fail the build
 * instead of propagating verbatim into this gate. Fails closed when no
 * digest is pinned for the package (an OpenTUI version bump without
 * re-pinned digests must never ship unverified tarballs) or when the
 * registry publishes no integrity for the version, so the tarball is never
 * accepted on a single unverifiable source.
 */
function assertTarballIntegrity(
  tarballBuffer: Uint8Array,
  packageName: string,
  version: string,
  registryIntegrity: string | undefined,
) {
  const actual = `sha512-${createHash('sha512')
    .update(tarballBuffer)
    .digest('base64')}`
  if (registryIntegrity === undefined) {
    throw new Error(
      `The registry published no dist.integrity for ${packageName}@${version}; refusing to verify the tarball against the bun.lock-derived pin alone (actual integrity: ${actual}). Build against a registry that publishes integrity metadata (CODEBUFF_NPM_REGISTRY / NPM_REGISTRY_URL) — OpenTUI native tarballs are never fetched unverified.`,
    )
  }
  const expected = OPENTUI_TARBALL_SHA512[packageName]
  if (expected === undefined) {
    throw new Error(
      `No pinned sha512 integrity for ${packageName}@${version} in OPENTUI_TARBALL_SHA512 (actual integrity: ${actual}; registry integrity: ${registryIntegrity}). Pin the digest before building — OpenTUI native tarballs are never fetched unverified.`,
    )
  }

  if (registryIntegrity !== actual) {
    throw new Error(
      `Downloaded OpenTUI tarball ${packageName}@${version} does not match the registry-published integrity: registry ${registryIntegrity}, downloaded ${actual}`,
    )
  }
  if (expected !== registryIntegrity) {
    throw new Error(
      `Pinned OPENTUI_TARBALL_SHA512 digest for ${packageName}@${version} (${expected}) does not match the dist.integrity the registry publishes for that version (${registryIntegrity}); the bun.lock record the pin was copied from is wrong or compromised — re-pin from the registry-published integrity before building`,
    )
  }
  log(
    `Verified sha512 integrity for ${packageName}@${version} (pin == registry == downloaded bytes)`,
  )
}

/**
 * Resolve the libc variant a build target must use for its OpenTUI native
 * bundle, mirroring the @opentui/core 0.5.x runtime resolver
 * (getCurrentNodeAssetTarget in the shipped chunk bundle): only Linux targets
 * consult OPENTUI_LIBC — unset or empty means the runtime default (glibc) and
 * resolves to null, "glibc" and "musl" pass through, and any other non-empty
 * value throws the exact message the runtime resolver throws, so a
 * misconfigured environment fails at build time with the same actionable text
 * the compiled binary would print at runtime. Non-Linux targets have no libc
 * variant and return null regardless of the variable's value, matching the
 * runtime resolver, which never validates it off Linux.
 */
export function resolveTargetOpentuiLibc(
  targetPlatform: string,
  env: Record<string, string | undefined>,
): 'glibc' | 'musl' | null {
  if (targetPlatform !== 'linux') return null
  const libc = env.OPENTUI_LIBC
  if (libc === undefined || libc === '') return null
  if (libc === 'glibc' || libc === 'musl') return libc
  throw new Error(
    `On Linux, OPENTUI_LIBC must be unset, empty, "glibc", or "musl", got ${JSON.stringify(libc)}`,
  )
}

async function ensureOpenTuiNativeBundle(targetInfo: TargetInfo) {
  // Mirror the @opentui/core 0.5.x runtime resolver: a musl-targeted build
  // must fetch, verify, and install the `-musl` native bundle (its digest is
  // already pinned in OPENTUI_TARBALL_SHA512) — without the suffix the glibc
  // bundle would be installed and the compiled binary would fail to load its
  // native library on musl systems.
  const libc = resolveTargetOpentuiLibc(targetInfo.platform, process.env)
  const libcSuffix = libc === 'musl' ? '-musl' : ''
  const libcLabel =
    targetInfo.platform === 'linux' ? (libc ?? 'glibc (default)') : 'n/a'
  log(
    `Ensuring OpenTUI native bundle for ${targetInfo.platform}-${targetInfo.arch}${libcSuffix} (libc: ${libcLabel})`,
  )
  const packageName = `@opentui/core-${targetInfo.platform}-${targetInfo.arch}${libcSuffix}`
  const packageFolder = `core-${targetInfo.platform}-${targetInfo.arch}${libcSuffix}`
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
      `OpenTUI native bundle already present for ${targetInfo.platform}-${targetInfo.arch}${libcSuffix}`,
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
          integrity?: string
        }
      }
    >
  }
  const dist = metadata.versions?.[version]?.dist
  const tarballUrl = dist?.tarball
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
    assertTarballIntegrity(tarballBuffer, packageName, version, dist?.integrity)
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
