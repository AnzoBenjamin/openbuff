import { spawn } from 'node:child_process'

import { parseLanguageDiagnostics } from '../tools/language-diagnostics'

import type { LanguageDiagnostic } from '../tools/language-diagnostics'

// P3-T11 (LI-10): Semgrep `--baseline-commit` security scan that surfaces
// taint/security findings on NEW code only (semgrep diffs the baseline ref
// internally and reports just findings introduced after it). Semgrep is a
// user-installed sidecar binary: absence, timeouts, and nonzero exits are
// honest status values, never thrown errors.
//
// The default runner is async (`spawn` + bounded stdout/stderr accumulation;
// the deadline settles the promise itself and escalates SIGTERM to SIGKILL
// after a grace period, so the wall-clock bound never depends on child
// cooperation): the async get_change_review_bundle tool
// path must not block the SDK event loop for the full scan duration.

export type SemgrepRunResult = {
  exitCode: number
  stdout: string
  stderr: string
  /** Set when the process was killed by a signal (e.g. timeout SIGTERM). */
  signal?: string | null
}

/**
 * Injectable process seam (mirrors the spawn/timeout conventions of `runGit`
 * in git-status.ts) so tests stay hermetic. Sync runners remain accepted for
 * compatibility, but the shipped default runner is async (`spawn`): the scan
 * must never block the SDK event loop.
 */
export type SemgrepRunner = (
  argv: string[],
  cwd: string,
  timeoutMs: number,
) => SemgrepRunResult | Promise<SemgrepRunResult>

export type SemgrepBaselineResult =
  | {
      status: 'ok'
      findings: LanguageDiagnostic[]
      toolVersion?: string
      /** Set when the file list was capped at MAX_SEMGREP_FILES. */
      truncated?: boolean
    }
  | { status: 'unavailable'; reason: string; findings: LanguageDiagnostic[] }
  | { status: 'error'; reason: string; findings: LanguageDiagnostic[] }
  | {
      status: 'skipped'
      reason: string
      findings: LanguageDiagnostic[]
    }

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
/**
 * Grace period between the deadline SIGTERM and the SIGKILL escalation.
 * Exported so the sibling diagnostic-command runner can mirror the same
 * escalation shape and the fixed perf baseline can cite the shared constant.
 */
export const SIGTERM_GRACE_MS = 5_000

// Full/short hex shas, a conservative ref name (origin/main, release-1.2)
// with an optional bounded tilde suffix (`main~1`, digits only) and an
// optional trailing '/', or the bounded time-travel shorthand `HEAD~N`
// (digits only). Anything else is rejected outright: the ref only ever
// travels as a single argv token (never shell-interpolated), and this
// whitelist keeps option-like (leading '-'), traversal-shaped ('..', e.g.
// 'a~../../x'), and metacharacter-bearing strings out of the argv array
// entirely. `..` anywhere is rejected explicitly, and tilde suffixes must be
// digits only (`HEAD~~`, `HEAD~1a` fail) so '~' cannot start a traversal
// sequence.
//
// Compatibility: `HEAD~N` and conservative `branch~N` refs (and a trailing
// '/' on a ref name) were accepted by the original contract for direct
// callers of runSemgrepBaseline and remain accepted. Resolving refs to hex
// shas (e.g. `git rev-parse <ref>`) is still preferred, which is what the
// shipped get_change_review_bundle path does.
const SAFE_BASELINE_REF =
  /^[0-9a-f]{4,40}$|^HEAD~\d{1,3}$|^[A-Za-z0-9](?:[A-Za-z0-9._/-]*[A-Za-z0-9._-])?(?:~\d{1,3})?\/?$/

function isSafeBaselineRef(ref: string): boolean {
  if (ref.includes('..')) return false
  return SAFE_BASELINE_REF.test(ref)
}

/**
 * Builds a spawn-based runner for `command`: bounded stdout/stderr
 * accumulation, a deadline that sends SIGTERM and settles the promise
 * immediately (matching the previous spawnSync timeout shape), and a short
 * unref'd grace timer — armed only when the deadline fires — that escalates
 * to SIGKILL so a child ignoring SIGTERM cannot stretch the wall-clock bound
 * past the deadline + grace. Exported so
 * tests can bind the deadline machinery to a controllable child process.
 */
export function makeSpawnRunner(
  command: string,
  options?: { sigtermGraceMs?: number },
): SemgrepRunner {
  const graceMs = options?.sigtermGraceMs ?? SIGTERM_GRACE_MS
  return (argv, cwd, timeoutMs) =>
    new Promise<SemgrepRunResult>((resolve) => {
      let child: ReturnType<typeof spawn>
      try {
        child = spawn(command, argv, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
      } catch (error) {
        resolve({
          exitCode: -1,
          stdout: '',
          stderr: error instanceof Error ? error.message : String(error),
        })
        return
      }
      const stdoutChunks: Buffer[] = []
      const stderrChunks: Buffer[] = []
      let bufferedBytes = 0
      let settled = false
      let escalate: ReturnType<typeof setTimeout> | undefined
      const settle = (result: SemgrepRunResult): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (escalate) clearTimeout(escalate)
        resolve(result)
      }
      // Bounded by the timeout clamp in runSemgrepBaseline: the deadline sends
      // SIGTERM and settles the promise immediately (surfaced as exitCode -1 /
      // 'semgrep timed out', matching the previous spawnSync timeout shape).
      // The wall-clock bound must not depend on the child cooperating with
      // SIGTERM: a child that ignores the signal would otherwise leave
      // runSemgrepBaseline awaiting forever, whereas the replaced spawnSync
      // runner always returned at the deadline. A short unref'd grace timer —
      // armed HERE, when the deadline fires, never at spawn time — escalates
      // to SIGKILL so a still-alive child is reaped without ever holding the
      // process open on its own.
      const timer = setTimeout(() => {
        try {
          child.kill('SIGTERM')
        } catch {
          /* already gone */
        }
        settle({
          exitCode: -1,
          stdout: '',
          stderr: 'semgrep timed out',
          signal: 'SIGTERM',
        })
        // SIGKILL escalation is armed at the deadline (the
        // diagnostic-delta-runner shape), never at spawn time: arming it at
        // spawn would SIGKILL any healthy scan that merely outlives the grace
        // period while its deadline is still far off. Unref'd so it can never
        // hold the process open on its own.
        escalate = setTimeout(() => {
          try {
            child.kill('SIGKILL')
          } catch {
            /* already gone */
          }
        }, graceMs)
        escalate.unref()
      }, timeoutMs)
      // A deadline timer must never hold the process open on its own.
      timer.unref()
      // Bound the buffered SARIF document (the async equivalent of spawnSync's
      // maxBuffer): past the cap the child is killed and the run fails rather
      // than buffering unbounded output.
      const exceedCap = (): void => {
        try {
          child.kill('SIGTERM')
        } catch {
          /* already gone */
        }
        settle({
          exitCode: -1,
          stdout: '',
          stderr: `semgrep output exceeded ${MAX_SARIF_BYTES} bytes`,
        })
      }
      child.stdout?.on('data', (chunk: Buffer) => {
        if (settled) return
        bufferedBytes += chunk.length
        if (bufferedBytes > MAX_SARIF_BYTES) {
          exceedCap()
          return
        }
        stdoutChunks.push(chunk)
      })
      child.stderr?.on('data', (chunk: Buffer) => {
        if (settled) return
        bufferedBytes += chunk.length
        if (bufferedBytes > MAX_SARIF_BYTES) {
          exceedCap()
          return
        }
        stderrChunks.push(chunk)
      })
      child.on('error', (error) => {
        settle({
          exitCode: -1,
          stdout: '',
          stderr: error instanceof Error ? error.message : String(error),
        })
      })
      child.on('close', (code, signal) => {
        settle({
          exitCode: code ?? -1,
          stdout: Buffer.concat(stdoutChunks).toString('utf8'),
          stderr: Buffer.concat(stderrChunks).toString('utf8'),
          ...(signal ? { signal } : {}),
        })
      })
    })
}

const defaultRunner: SemgrepRunner = makeSpawnRunner('semgrep')

type SemgrepAvailability =
  | { available: true; toolVersion?: string }
  | { available: false }

// Brief per-runner, per-cwd availability cache: the bundle is rebuilt on every gate
// evaluation, and a `semgrep --version` probe must not re-run each time.
// Entries are FIFO-trimmed (perf: semgrep-availability-cache-unbounded) so a
// long-lived process visiting many distinct cwds cannot grow the cache
// without bound — the same bounded-Map pattern as the scip-runner's
// detection cache. A live entry evicted by the cap is simply re-probed on
// the next miss (a cheap `--version` spawn with a 3s timeout).
const AVAILABILITY_CACHE_TTL_MS = 30_000
const MAX_AVAILABILITY_CACHE_ENTRIES = 256
// The cache is keyed by the injected runner first, then by cwd (a WeakMap so
// runner instances never leak): two distinct SemgrepRunner implementations
// used against the same cwd within the TTL must not observe each other's
// availability verdict through the exported injectable runner seam
// (compat: availability-cache-ignores-injected-runner). Each per-runner
// cwd map is FIFO-trimmed exactly like the previous flat per-cwd map.
let availabilityCache = new WeakMap<
  SemgrepRunner,
  Map<string, { expiresAt: number; result: SemgrepAvailability }>
>()

/** Drop cached availability probes (tests, freshly installed sidecars). */
export function clearSemgrepAvailabilityCache(): void {
  availabilityCache = new WeakMap()
}

/** FIFO trim (scip-runner detection-cache pattern): oldest entries first. */
function trimAvailabilityCache(
  byCwd: Map<string, { expiresAt: number; result: SemgrepAvailability }>,
): void {
  while (byCwd.size > MAX_AVAILABILITY_CACHE_ENTRIES) {
    const oldest = byCwd.keys().next()
    if (oldest.done) break
    byCwd.delete(oldest.value)
  }
}

// In-flight availability probes keyed by runner then cwd (perf:
// semgrep-availability-probe-no-single-flight): concurrent cold-cache callers
// of runSemgrepBaseline (parallel bundle builds / gate evaluations against the
// same cwd) join one `semgrep --version` probe instead of each spawning their
// own (3s timeout each) — the same single-flight shape as the scip-runner's
// inFlightDetections. Entries are removed as soon as their probe settles.
const inFlightProbes = new WeakMap<
  SemgrepRunner,
  Map<string, Promise<SemgrepAvailability>>
>()

async function probeAvailability(
  runner: SemgrepRunner,
  cwd: string,
): Promise<SemgrepAvailability> {
  const now = Date.now()
  const byCwd = availabilityCache.get(runner) ?? new Map()
  availabilityCache.set(runner, byCwd)
  const cached = byCwd.get(cwd)
  if (cached && cached.expiresAt > now) return cached.result
  let inFlightByCwd = inFlightProbes.get(runner)
  if (!inFlightByCwd) {
    inFlightByCwd = new Map()
    inFlightProbes.set(runner, inFlightByCwd)
  }
  const inFlight = inFlightByCwd.get(cwd)
  if (inFlight) return inFlight
  // Single-flight: concurrent callers on a cold cache key join one in-flight
  // probe. The runner is invoked synchronously (before the first await), so a
  // concurrent caller can never miss the registration and duplicate the
  // spawned probe process.
  // Declared before assignment so the finally-block identity guard can close
  // over the in-flight promise without tripping definite-assignment analysis.
  let probe: Promise<SemgrepAvailability> | undefined
  probe = (async () => {
    try {
      const probed = await runner(['--version'], cwd, AVAILABILITY_TIMEOUT_MS)
      if (probed.exitCode === 0) {
        const toolVersion = probed.stdout.trim().split('\n')[0]?.trim()
        return { available: true, ...(toolVersion ? { toolVersion } : {}) }
      }
      return { available: false }
    } catch {
      return { available: false }
    } finally {
      const map = inFlightProbes.get(runner)
      if (map && map.get(cwd) === probe) map.delete(cwd)
    }
  })()
  inFlightByCwd.set(cwd, probe)
  const result = await probe
  byCwd.set(cwd, {
    expiresAt: now + AVAILABILITY_CACHE_TTL_MS,
    result,
  })
  trimAvailabilityCache(byCwd)
  return result
}

/**
 * Runs `semgrep scan --baseline-commit <ref>` scoped to `files` and parses the
 * SARIF stdout through the existing SARIF parser from language-diagnostics.ts.
 *
 * Accepted `baselineCommit` forms: a full/short hex sha, a conservative ref
 * name (origin/main, release-1.2) with an optional bounded tilde suffix
 * (`main~1`, digits only) and an optional trailing '/', or the bounded
 * `HEAD~N` shorthand (digits only) — the forms accepted by the original
 * contract for direct callers. Any other ref — option-like,
 * traversal-shaped, or metacharacter-bearing — returns
 * `{ status: 'error', reason: 'invalid-baseline-commit' }` without invoking
 * the runner; resolving refs to hex shas (e.g. `git rev-parse <ref>`) is
 * still preferred, as the shipped get_change_review_bundle path does.
 *
 * Fail-open by contract: semgrep being absent, slow, or failing always yields
 * a status value with empty findings, never a thrown error.
 */
export async function runSemgrepBaseline(params: {
  cwd: string
  baselineCommit: string
  files: string[]
  runner?: SemgrepRunner
  timeoutMs?: number
  /**
   * Caller already ran an identical scan for an earlier snapshot of this
   * worktree (e.g. the before-bundle of targeted validation): skip the scan
   * and return a 'skipped' status without invoking the runner.
   */
  skipScan?: boolean
}): Promise<SemgrepBaselineResult> {
  if (params.skipScan) {
    return { status: 'skipped', reason: 'before-bundle-skipped', findings: [] }
  }
  if (!isSafeBaselineRef(params.baselineCommit)) {
    return {
      status: 'error',
      reason: 'invalid-baseline-commit',
      findings: [],
    }
  }
  const runner = params.runner ?? defaultRunner
  const availability = await probeAvailability(runner, params.cwd)
  if (!availability.available) {
    return { status: 'unavailable', reason: 'semgrep-not-found', findings: [] }
  }
  const toolVersion = availability.toolVersion
    ? { toolVersion: availability.toolVersion }
    : {}
  // Cap the file list: one --include pattern per file, never unbounded. The
  // cap is surfaced to the caller via the additive `truncated` flag instead
  // of silently dropping files.
  const truncated = params.files.length > MAX_SEMGREP_FILES
  const files = params.files.slice(0, MAX_SEMGREP_FILES)
  if (files.length === 0) {
    return { status: 'ok', findings: [], ...toolVersion }
  }
  // argv contract (compat: baseline-commit-equals-form): the scan uses the
  // documented, supported semgrep CLI equals form `--baseline-commit=<value>`,
  // and the ref travels as a single pre-validated argv token
  // (isSafeBaselineRef above) — never shell-interpolated.
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
    scan = await runner(
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
  // Timeout is detected from the structured signal field, not by sniffing
  // stderr for prose.
  if (scan.signal === 'SIGTERM') {
    return { status: 'error', reason: 'semgrep-timeout', findings: [] }
  }
  // Parse the SARIF before classifying the exit code: semgrep exits 1 when
  // the scan simply found results — a successful scan whose findings must be
  // surfaced, not dropped as a failure. Exit 1 without parsed findings (and
  // any other nonzero exit) stays an honest error.
  const findings = parseLanguageDiagnostics({
    command: 'semgrep scan --baseline-commit',
    cwd: params.cwd,
    stdout: scan.stdout,
  }).slice(0, MAX_FINDINGS)
  if (scan.exitCode !== 0 && !(scan.exitCode === 1 && findings.length > 0)) {
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
  return {
    status: 'ok',
    findings,
    ...(truncated ? { truncated } : {}),
    ...toolVersion,
  }
}
