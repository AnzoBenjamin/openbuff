#!/usr/bin/env bun
/**
 * Long-running smoke test for a compiled CLI binary.
 *
 * `--version` and `--help` exit via commander synchronously, before async
 * startup failures (e.g. the unhandled rejection from Parser.init when the
 * tree-sitter wasm load fails) get a chance to fire. This script first runs
 * deterministic tree-sitter and OpenTUI-native probes. It can then spawn the
 * full CLI, let it run for a few seconds, and assert that the TUI rendered a
 * known boot screen.
 *
 * The positive check matters more than the negative one: a "did the boot
 * screen appear" assertion catches *any* startup failure — known fatals,
 * novel error messages, silent crashes, hangs, segfaults that produce no
 * output. Negative pattern matches are kept only for clearer diagnostics
 * when a known regression recurs.
 *
 * Full-screen output through a pipe is not deterministic on every supported
 * runtime (legacy Intel macOS may initialize correctly without painting).
 * Pass `--probe-only` there: it still exercises both packaged native/wasm
 * dependencies without treating terminal presentation as a portability API.
 *
 * Usage:
 *   bun cli/scripts/smoke-binary.ts <path-to-binary> [seconds] [--probe-only]
 *
 * Exits 0 if the deterministic probes pass and, unless probe-only, a boot
 * signal is detected with no fatal markers; exits 1 otherwise.
 */

import { spawn } from 'child_process'
import { existsSync } from 'fs'

// Any one of these strings appearing in stdout/stderr proves the binary
// reached its post-init UI: React tree mounted, OpenTUI rendered, async
// wasm init survived. Strings are static text from rendered components
// (not shimmer / animated) so they survive ANSI styling as contiguous
// substrings. Cover the multiple boot states the binary might land on:
//
//   - "will run commands on your behalf" — main surface header
//     (authed + session ready)
//   - "Press ENTER to login" / "Open this URL" — login modal (no cached
//     creds — typical CI smoke)
//   - "Enter a coding task" — chat input prompt
//   - DEC alternate-screen activation — OpenTUI renderer initialized and
//     began painting even if capability negotiation fragmented later labels.
// `openbuff bootscreen ok` — CLI emits this deterministic marker whenever
// stdout is a non-TTY pipe, because OpenTUI's renderer writes no frames when
// stdout is not a TTY (so the piped full-TUI smoke would otherwise see zero
// bytes on native Windows). The CLI intentionally does NOT exit after printing
// it, so this is a boot-presence signal, not a clean-exit marker.
const BOOT_SIGNAL_PATTERNS = [
  /will run commands on your behalf/,
  /Press ENTER to login/,
  /Open this URL/,
  /Enter a coding task/,
  /\x1b\[\?1049h/,
  /openbuff bootscreen ok\r?/,
] as const
// RF-4: patterns stay without /g so .test() has no lastIndex state across chunk scans.

// Fatal markers we already know about — kept for nicer error messages on
// regressions of bugs we've already seen. The boot-signal check above is
// the real gate: it fails on *any* startup problem, including ones whose
// error text we never thought to add here.
//
// Note both paths the cli error handlers print: "Fatal error during
// startup" (earlyFatalHandler in cli/src/index.tsx, fires while main()
// is still wiring up) and "Unhandled rejection:" / "Uncaught exception:"
// (installProcessCleanupHandlers in cli/src/utils/renderer-cleanup.ts,
// fires after the renderer is up). Wasm-load rejections can surface through
// the *late* renderer-cleanup path, after the boot screen has already rendered.
const FATAL_PATTERNS = [
  /Fatal error during startup/i,
  /Unhandled rejection:/i,
  /Uncaught exception:/i,
  /Internal error: tree-sitter\.wasm not found/i,
  /UnhandledPromiseRejection/i,
  /Cannot find module.*(?:tree-sitter\.wasm|tree-sitter|@opentui\/core)/i,
] as const

// Long enough that an unhandled rejection from the eager Parser.init has
// time to surface through the renderer-cleanup handler — that path is past
// startup incidents while a short window let CI pass. Async wasm rejections
// can fire after spawn (after React mounts and the renderer is up), so keep
// a generous default of 10s.
const DEFAULT_RUN_SECONDS = 10

// A hanging probe must fail the harness instead of hanging CI, so each
// deterministic probe gets a fixed budget. Reusing DEFAULT_RUN_SECONDS keeps
// the whole smoke bounded by the same value (10s) a probe can reasonably take.
const PROBE_TIMEOUT_SECONDS = DEFAULT_RUN_SECONDS

// Only the first CAPTURED_OUTPUT_CAP bytes of a child's stdout/stderr are
// retained in memory (capture handlers short-circuit past this). The failure
// reporter truncates further to 8 KB (half the cap) for readable diagnostics,
// so the 16 KB cap bounds memory while the 8 KB slice keeps error logs concise.
// Both values are intentionally aligned via CAPTURED_OUTPUT_CAP — keep them in sync.
const CAPTURED_OUTPUT_CAP = 16 * 1024
const CAPTURED_OUTPUT_FAIL_SLICE = 8 * 1024 // half of CAPTURED_OUTPUT_CAP for truncated error output
// Overlap retained across chunk boundaries so a fatal/boot pattern split
// across two data events is still detected by stream scanning.
const SCAN_OVERLAP = 512

// Smoke env: spread parent env for Windows compatibility (APPDATA,
// USERNAME, HOMEDRIVE, COMPUTERNAME etc.) while overriding only the
// deterministic vars. Previous strict allowlisting dropped critical
// Windows vars and caused 0-byte hangs; spreading avoids that while
// keeping TERM=dumb/NO_COLOR=1 deterministic.
function buildSmokeEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) env[k] = v
  }
  env.NO_COLOR = '1'
  env.TERM = 'dumb'
  return env
}

type ProcessResult = {
  captured: string
  tail: string
  fatalHit: RegExp | null
  bootHit: RegExp | null
  markerHit: RegExp | null
  code: number | null
  signal: NodeJS.Signals | null
}

/** Shared bounded capture with stream-scanning so late output beyond the
 * head cap is not missed (RF-6). Deduplicates append/cap logic between
 * runProbe() and the full-TUI spawn (RF-5). */
function createBoundedCapture(marker?: RegExp) {
  let head = ''
  let tail = ''
  let scanTail = ''
  let fatalHit: RegExp | null = null
  let bootHit: RegExp | null = null
  let markerHit: RegExp | null = null
  // Clone marker without /g so lastIndex never bleeds across chunk scans or re-tests.
  const safeMarker = marker ? new RegExp(marker.source, marker.flags.replace('g', '')) : null
  const append = (chunk: Buffer): void => {
    const text = chunk.toString('utf8')
    // RF-4: scanCandidate is scanTail+text per chunk (bounded to SCAN_OVERLAP + chunk length); patterns must stay without /g to avoid lastIndex bleed.
    const scanCandidate = scanTail + text
    if (!fatalHit) {
      for (const p of FATAL_PATTERNS) {
        if (p.test(scanCandidate)) {
          fatalHit = p
          break
        }
      }
    }
    if (!bootHit) {
      for (const p of BOOT_SIGNAL_PATTERNS) {
        if (p.test(scanCandidate)) {
          bootHit = p
          break
        }
      }
    }
    if (safeMarker && !markerHit && safeMarker.test(scanCandidate)) {
      markerHit = safeMarker
    }
    scanTail = scanCandidate.slice(-SCAN_OVERLAP)
    if (head.length < CAPTURED_OUTPUT_CAP) {
      const remaining = CAPTURED_OUTPUT_CAP - head.length
      head += text.length > remaining ? text.slice(0, remaining) : text
    }
    if (text.length >= CAPTURED_OUTPUT_CAP) {
      tail = text.slice(-CAPTURED_OUTPUT_CAP)
    } else if (tail.length + text.length > CAPTURED_OUTPUT_CAP) {
      tail = tail.slice(-(CAPTURED_OUTPUT_CAP - text.length)) + text
    } else {
      tail += text
    }
  }
  return {
    getCaptured: () => head,
    getTail: () => tail,
    fatalMatched: () => fatalHit,
    bootMatched: () => bootHit,
    markerMatched: () => markerHit,
    append,
    attach: (proc: { stdout?: NodeJS.ReadableStream | null; stderr?: NodeJS.ReadableStream | null }) => {
      proc.stdout?.on('data', append)
      proc.stderr?.on('data', append)
    },
    detach: (proc: { stdout?: NodeJS.ReadableStream | null; stderr?: NodeJS.ReadableStream | null }) => {
      proc.stdout?.removeListener('data', append)
      proc.stderr?.removeListener('data', append)
    },
  }
}

function runProbe(binary: string, flag: string, marker?: RegExp): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const proc = spawn(binary, [flag], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: buildSmokeEnv(),
    })

    const cap = createBoundedCapture(marker)
    cap.attach(proc)
    const cleanup = () => cap.detach(proc)

    // Time out a hanging probe so a defective binary can't stall CI. Kill the
    // child and reject; `requireProbe`'s await throws and the harness fails.
    const timer = setTimeout(() => {
      try {
        proc.kill('SIGKILL')
      } catch {
        // process already dead or not killable; reject is what matters
      }
      cleanup()
      proc.removeAllListeners()
      reject(
        new Error(
          `probe for flag ${flag} timed out after ${PROBE_TIMEOUT_SECONDS}s`,
        ),
      )
    }, PROBE_TIMEOUT_SECONDS * 1000)

    proc.once('error', (err: Error) => {
      // A spawn 'error' (e.g. ENOENT) fires before 'exit'; the child may still
      // be alive. Kill it so we never leak a live process, mirroring the
      // full-TUI path which SIGKILLs on timeout.
      clearTimeout(timer)
      try {
        proc.kill('SIGKILL')
      } catch {
        // process already dead or not killable; reject is what matters
      }
      cleanup()
      proc.removeAllListeners()
      reject(err)
    })
    proc.once('exit', (code, signal) => {
      clearTimeout(timer)
      cleanup()
      proc.removeAllListeners()
      resolve({ captured: cap.getCaptured(), tail: cap.getTail(), fatalHit: cap.fatalMatched(), bootHit: cap.bootMatched(), markerHit: cap.markerMatched(), code, signal })
    })
  })
}

async function requireProbe(
  binary: string,
  flag: string,
  marker: RegExp,
  label: string,
): Promise<void> {
  const result = await runProbe(binary, flag, marker)
  if (result.code === 0 && result.markerHit !== null) return

  // RF-2: include stream-scanned fatalHit and bounded tail so late fatals beyond the head cap are not lost in diagnostics.
  const headSlice = result.captured.slice(0, CAPTURED_OUTPUT_FAIL_SLICE)
  const tailSlice = result.tail && result.tail !== result.captured ? result.tail.slice(-CAPTURED_OUTPUT_FAIL_SLICE) : ''
  const fatalInfo = result.fatalHit ? ` stream fatal ${result.fatalHit} (stream-scanned)` : ''
  const tailInfo = tailSlice ? `\n--- tail (last ${CAPTURED_OUTPUT_FAIL_SLICE / 1024}KB) ---\n${tailSlice}` : ''
  throw new Error(
    `${label} smoke failed (${formatExit(result.code, result.signal)})${fatalInfo}\n${headSlice}${tailInfo}`,
  )
}

function formatExit(
  code: number | null,
  signal: NodeJS.Signals | null,
): string {
  if (signal) return `signal ${signal}`
  return `exit code ${code}`
}

async function main(): Promise<void> {
  const binary = process.argv[2]
  const probeOnly = process.argv.includes('--probe-only')
  const secondsArg = process.argv.slice(3).find((arg) => arg !== '--probe-only')
  const runSeconds = Number(secondsArg ?? DEFAULT_RUN_SECONDS)

  if (!binary) {
    console.error(
      'Usage: bun smoke-binary.ts <path-to-binary> [seconds] [--probe-only]',
    )
    process.exit(2)
  }
  if (!existsSync(binary)) {
    console.error(`smoke-binary: binary not found: ${binary}`)
    process.exit(2)
  }
  if (!Number.isFinite(runSeconds) || runSeconds <= 0) {
    console.error(`smoke-binary: bad seconds arg: ${secondsArg}`)
    process.exit(2)
  }

  // (quiet by default; set SMOKE_VERBOSE=1 for step logs to reduce CI noise)
  const verbose = process.env.SMOKE_VERBOSE === '1'
  const vLog = (...args: unknown[]) => {
    if (verbose) console.log(...args)
  }
  vLog(`smoke-binary: probing ${binary}…`)

  await requireProbe(
    binary,
    '--smoke-tree-sitter',
    /tree-sitter smoke ok/,
    'tree-sitter',
  )
  vLog('smoke-binary: tree-sitter init OK.')

  await requireProbe(binary, '--smoke-opentui', /opentui smoke ok/, 'OpenTUI')
  vLog('smoke-binary: OpenTUI native init OK.')

  if (probeOnly) {
    vLog('smoke-binary: OK (deterministic probes passed).')
    return
  }

  vLog(`smoke-binary: spawning full TUI for ${runSeconds}s…`)

  const proc = spawn(binary, ['--smoke-bootscreen'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: buildSmokeEnv(),
  })

  const cap = createBoundedCapture()
  cap.attach(proc)

  let earlyExitCode: number | null = null
  let exitSignal: NodeJS.Signals | null = null
  let spawnError: Error | null = null
  const exited = new Promise<void>((resolve) => {
    // A spawn 'error' (e.g. ENOENT, EACCES) fires before 'exit' and the child
    // never emits 'exit' afterwards, so resolve here too; otherwise the await
    // below would hang forever (the killTimer only handles a live child).
    // Resolving with spawnError set lets the failure report cleanly.
    proc.once('error', (err: Error) => {
      spawnError = err
      resolve()
    })
    proc.once('exit', (code, signal) => {
      earlyExitCode = code
      exitSignal = signal
      resolve()
    })
  })

  let timedOut = false
  const killTimer = setTimeout(() => {
    // SIGKILL is the only signal that's portable across Linux/macOS/Windows
    // here; SIGTERM may be ignored by the renderer on some platforms. Wrapped in
    // try/catch so an ESRCH from the child exiting right at the timeout boundary
    // (between the exit event and clearTimeout below) can't escape into main's
    // catch and turn a clean timeout into an unexpected-exit(2) failure.
    // Only mark as timeout after confirming the kill was delivered; if the child
    // already exited proc.kill throws ESRCH and timedOut stays false so the
    // early-exit failure below is not masked (RF-1).
    try {
      if (proc.kill('SIGKILL')) {
        timedOut = true
      }
    } catch {
      // ESRCH – child already exited, leave timedOut false
    }
  }, runSeconds * 1_000)

  await exited
  clearTimeout(killTimer)
  // RF-1: detach bounded-capture listeners after the child has exited so handlers don't leak if the proc object is reused or keeps emitting.
  cap.detach(proc)
  proc.removeAllListeners()

  const fail = (reason: string): never => {
    const head = cap.getCaptured()
    const tail = cap.getTail()
    console.error(
      `smoke-binary: FAIL — ${reason} (${formatExit(earlyExitCode, exitSignal)}).`,
    )
    console.error(`--- captured output head (truncated to ${CAPTURED_OUTPUT_FAIL_SLICE / 1024}KB) ---`)
    console.error(head.slice(0, CAPTURED_OUTPUT_FAIL_SLICE))
    if (tail && tail !== head) {
      console.error(`--- captured output tail (last ${CAPTURED_OUTPUT_FAIL_SLICE / 1024}KB) ---`)
      console.error(tail.slice(-CAPTURED_OUTPUT_FAIL_SLICE))
    }
    process.exit(1)
  }

  // A spawn 'error' never emits 'exit', so fail cleanly rather than treating
  // the unresolved child as a boot failure or, without the handler above, an
  // uncaught 'error' event.
  if (spawnError) {
    fail(`failed to spawn binary: ${spawnError.message}`)
  }

  // Negative gate first: a known fatal marker gives us a more specific error
  // message than "no boot signal found" would. Stream-scanning via
  // cap.fatalMatched() catches late wasm rejections beyond the 16KB head cap
  // (RF-6); head/tail string checks provide a bounded fallback for diagnostics.
  const streamFatal = cap.fatalMatched()
  if (streamFatal) {
    fail(`output matched ${streamFatal} (stream-scanned)`)
  }
  for (const pattern of FATAL_PATTERNS) {
    if (pattern.test(cap.getCaptured()) || pattern.test(cap.getTail())) {
      fail(`output matched ${pattern}`)
    }
  }

  if (!timedOut && (exitSignal !== null || earlyExitCode !== 0)) {
    fail('binary terminated before the smoke timeout')
  }

  // Positive gate: the binary must have rendered a known boot screen. This
  // is the load-bearing assertion — it catches *any* startup failure (silent
  // crashes, hangs, novel error messages, segfaults), not just the listed
  // fatals. Checked via stream-scanned bootHit plus bounded head/tail fallback.
  const streamBoot = cap.bootMatched()
  const matchedSignal =
    streamBoot ?? BOOT_SIGNAL_PATTERNS.find((p) => p.test(cap.getCaptured()) || p.test(cap.getTail()))
  if (!matchedSignal) {
    fail(
      `binary never reached a known boot screen — checked ${BOOT_SIGNAL_PATTERNS.length} patterns`,
    )
  }

  vLog(
    `smoke-binary: OK (matched ${matchedSignal}, ${formatExit(earlyExitCode, exitSignal)}, ${cap.getCaptured().length} bytes head, ${cap.getTail().length} bytes tail).`,
  )
}

main().catch((err: unknown) => {
  console.error('smoke-binary: unexpected error:', err)
  process.exit(2)
})
