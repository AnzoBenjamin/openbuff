import { spawnSync } from 'node:child_process'

import { parseLanguageDiagnostics } from '../tools/language-diagnostics'

import type { LanguageDiagnostic } from '../tools/language-diagnostics'

// P3-T11 (LI-10): Semgrep `--baseline-commit` security scan that surfaces
// taint/security findings on NEW code only (semgrep diffs the baseline ref
// internally and reports just findings introduced after it). Semgrep is a
// user-installed sidecar binary: absence, timeouts, and nonzero exits are
// honest status values, never thrown errors.

export type SemgrepRunResult = {
  exitCode: number
  stdout: string
  stderr: string
  /** Set when the process was killed by a signal (e.g. timeout SIGTERM). */
  signal?: string | null
}

/**
 * Injectable process seam (mirrors the spawnSync/timeout conventions of
 * `toolVersion` in harness-intelligence.ts) so tests stay hermetic.
 */
export type SemgrepRunner = (
  argv: string[],
  cwd: string,
  timeoutMs: number,
) => SemgrepRunResult

export type SemgrepBaselineResult =
  | { status: 'ok'; findings: LanguageDiagnostic[]; toolVersion?: string }
  | { status: 'unavailable'; reason: string; findings: LanguageDiagnostic[] }
  | { status: 'error'; reason: string; findings: LanguageDiagnostic[] }

/** Upper bound on files handed to a single scan (one --include per file). */
export const MAX_SEMGREP_FILES = 200
const DEFAULT_SCAN_TIMEOUT_MS = 60_000
const MAX_SCAN_TIMEOUT_MS = 300_000
const MIN_SCAN_TIMEOUT_MS = 1_000
const AVAILABILITY_TIMEOUT_MS = 3_000
/** Bounds the SARIF document buffered from semgrep stdout. */
const MAX_SARIF_BYTES = 8 * 1024 * 1024
const MAX_STDERR_SNIPPET = 400
const MAX_FINDINGS = 200

// Full/short hex shas, or a conservative ref name (HEAD~1, origin/main).
// Anything else is rejected outright: the ref only ever travels as a single
// argv token (never shell-interpolated), and this whitelist keeps option-like
// or metacharacter-bearing strings out of the argv array entirely.
const SAFE_BASELINE_REF = /^[0-9a-f]{4,40}$|^[A-Za-z0-9][A-Za-z0-9._/~^-]*$/

const defaultRunner: SemgrepRunner = (argv, cwd, timeoutMs) => {
  const result = spawnSync('semgrep', argv, {
    cwd,
    encoding: 'utf8',
    timeout: timeoutMs,
    // spawnSync buffers stdout fully; maxBuffer is the hard byte cap on the
    // SARIF document (the streaming-cap equivalent for a sync spawn).
    maxBuffer: MAX_SARIF_BYTES,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const timedOut =
    !!result.error &&
    ((result.error as NodeJS.ErrnoException).code === 'ETIMEDOUT' ||
      result.signal === 'SIGTERM')
  const stderr =
    typeof result.stderr === 'string'
      ? result.stderr
      : (result.error?.message ?? '')
  return {
    exitCode: timedOut ? -1 : (result.status ?? -1),
    stdout: typeof result.stdout === 'string' ? result.stdout : '',
    stderr: timedOut ? 'semgrep timed out' : stderr,
    ...(result.signal ? { signal: result.signal } : {}),
  }
}

type SemgrepAvailability =
  | { available: true; toolVersion?: string }
  | { available: false }

// Brief per-cwd availability cache: the bundle is rebuilt on every gate
// evaluation, and a `semgrep --version` probe must not re-run each time.
const AVAILABILITY_CACHE_TTL_MS = 30_000
const availabilityCache = new Map<
  string,
  { expiresAt: number; result: SemgrepAvailability }
>()

/** Drop cached availability probes (tests, freshly installed sidecars). */
export function clearSemgrepAvailabilityCache(): void {
  availabilityCache.clear()
}

function probeAvailability(
  runner: SemgrepRunner,
  cwd: string,
): SemgrepAvailability {
  const now = Date.now()
  const cached = availabilityCache.get(cwd)
  if (cached && cached.expiresAt > now) return cached.result
  let result: SemgrepAvailability
  try {
    const probe = runner(['--version'], cwd, AVAILABILITY_TIMEOUT_MS)
    if (probe.exitCode === 0) {
      const toolVersion = probe.stdout.trim().split('\n')[0]?.trim()
      result = { available: true, ...(toolVersion ? { toolVersion } : {}) }
    } else {
      result = { available: false }
    }
  } catch {
    result = { available: false }
  }
  availabilityCache.set(cwd, {
    expiresAt: now + AVAILABILITY_CACHE_TTL_MS,
    result,
  })
  return result
}

/**
 * Runs `semgrep scan --baseline-commit <ref>` scoped to `files` and parses the
 * SARIF stdout through the existing SARIF parser from language-diagnostics.ts.
 * Fail-open by contract: semgrep being absent, slow, or failing always yields
 * a status value with empty findings, never a thrown error.
 */
export function runSemgrepBaseline(params: {
  cwd: string
  baselineCommit: string
  files: string[]
  runner?: SemgrepRunner
  timeoutMs?: number
}): SemgrepBaselineResult {
  if (!SAFE_BASELINE_REF.test(params.baselineCommit)) {
    return {
      status: 'error',
      reason: 'invalid-baseline-commit',
      findings: [],
    }
  }
  const runner = params.runner ?? defaultRunner
  const availability = probeAvailability(runner, params.cwd)
  if (!availability.available) {
    return { status: 'unavailable', reason: 'semgrep-not-found', findings: [] }
  }
  const toolVersion = availability.toolVersion
    ? { toolVersion: availability.toolVersion }
    : {}
  // Cap the file list: one --include pattern per file, never unbounded.
  const files = params.files.slice(0, MAX_SEMGREP_FILES)
  if (files.length === 0) {
    return { status: 'ok', findings: [], ...toolVersion }
  }
  const argv = [
    'scan',
    `--baseline-commit=${params.baselineCommit}`,
    '--sarif',
    '--quiet',
    '--metrics=off',
    // The caller supplies an explicit file list; nested untracked files must
    // not be filtered away by semgrep's git-aware ignoring.
    '--no-git-ignore',
    ...files.flatMap((file) => ['--include', file]),
  ]
  let scan: SemgrepRunResult
  try {
    scan = runner(
      argv,
      params.cwd,
      Math.min(
        Math.max(
          params.timeoutMs ?? DEFAULT_SCAN_TIMEOUT_MS,
          MIN_SCAN_TIMEOUT_MS,
        ),
        MAX_SCAN_TIMEOUT_MS,
      ),
    )
  } catch (error) {
    return {
      status: 'error',
      reason: error instanceof Error ? error.message : String(error),
      findings: [],
    }
  }
  if (scan.signal === 'SIGTERM' || /timed out/i.test(scan.stderr)) {
    return { status: 'error', reason: 'semgrep-timeout', findings: [] }
  }
  if (scan.exitCode !== 0) {
    const snippet = scan.stderr
      .trim()
      .replace(/\s+/g, ' ')
      .slice(0, MAX_STDERR_SNIPPET)
    return {
      status: 'error',
      reason: `semgrep failed with exit code ${scan.exitCode}${snippet ? `: ${snippet}` : ''}`,
      findings: [],
    }
  }
  const findings = parseLanguageDiagnostics({
    command: 'semgrep scan --baseline-commit',
    cwd: params.cwd,
    stdout: scan.stdout,
  }).slice(0, MAX_FINDINGS)
  return { status: 'ok', findings, ...toolVersion }
}
