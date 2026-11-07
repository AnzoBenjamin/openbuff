import path from 'node:path'

import {
  getLanguageCapability,
  SUPPORTED_LANGUAGE_IDS,
  type SupportedLanguageId,
} from '@codebuff/common/util/language-capabilities'

import {
  parseLanguageDiagnosticsWithCoverage,
  type LanguageDiagnostic,
  type LanguageDiagnosticTextEdit,
} from '../tools/language-diagnostics'
import { mapWithConcurrency } from '../tools/concurrency'
import { getSdkEnv } from '../env'

/**
 * Diagnostic-delta preflight (LI-02 tiers 1–2).
 *
 * The service answers one question: "does this edit introduce NEW
 * compiler/LSP errors, and was that observation complete?" It captures a language-appropriate baseline, applies
 * an injected edit, captures again, and rejects on observed new error-severity
 * diagnostics appear that were not already present. Tool-suggested fix-its for
 * the new errors are aggregated so the caller can surface or apply them.
 *
 * Integration point: the true before/after baseline lives in the mutation
 * broker path (change-file.ts / filesystem-authority.ts), which can snapshot
 * diagnostics around an edit. This module intentionally does NOT import or
 * touch the broker; the edit is applied/rolled back through injected
 * callbacks so the caller owns the mutation lifecycle. file-change-hooks.ts
 * offers a thinner, env-gated observation seam (OPENBUFF_DIAGNOSTIC_PREFLIGHT)
 * for callers that already hold the baseline.
 *
 * Command selection is derived from the language registry
 * (common/util/language-capabilities): file extensions map to a supported
 * language, and each language contributes an ordered, parseable validation
 * command list aligned with its registry validation stages and tool metadata
 * (e.g. tsc/eslint for TypeScript, ruff/pyright for Python, cargo check for
 * Rust, go vet for Go).
 *
 * Deferred: the incremental daemons (tsc --watch, cargo check JSON daemon,
 * ruff server, dmypy) are not implemented; the preflight runs one-shot
 * diagnostic commands per invocation.
 *
 * All command execution goes through the injected {@link DiagnosticCommandRunner}
 * seam — this module never spawns directly — so tests are hermetic and the
 * caller controls the wall-clock bound (timeoutSeconds) per run.
 */

/** Minimal, spawn-agnostic result of running one diagnostic command. */
export type DiagnosticRunResult = {
  stdout?: string
  stderr?: string
  exitCode?: number
  errorMessage?: string
  timedOut?: boolean
  cancelled?: boolean
  outputTruncated?: boolean
  errorCode?: string
}

/**
 * Injected runner seam. Report exit status, cancellation, timeout and truncated
 * output explicitly. Missing/failed observations may allow optional work but
 * never certify a passed diagnostic check. An omitted exit status is unknown.
 */
export type DiagnosticCommandRunner = (params: {
  command: string
  cwd: string
  timeoutSeconds: number
  env?: Record<string, string | undefined>
  signal?: AbortSignal
}) => Promise<DiagnosticRunResult>

/**
 * How `computeDiagnosticDelta` decides whether a diagnostic in `after` already
 * existed in `before`.
 *
 * - 'tolerant' (default): match on (file, code, severity) with COUNT-AWARE multiset
 *   semantics, so a pre-existing diagnostic that moved lines still matches its
 *   baseline and is NOT reported as new, while a genuinely NEW diagnostic
 *   sharing a (file, code, severity) key with pre-existing ones is reported once the
 *   baseline count for that key is exhausted. Tolerant is the default because
 *   the strict matcher rejected valid edits whose PRE-EXISTING errors merely
 *   shifted lines (the edit did not introduce them); tolerance is the safer
 *   failure mode for a fail-open preflight. Opt back into strict via
 *   `deltaMode: 'strict'` or the OPENBUFF_DIAGNOSTIC_DELTA_MODE=strict env
 *   var.
 * - 'strict': match on (file, line, column, code/ruleId, severity). Precise,
 *   but a pre-existing diagnostic whose line merely shifted because an edit
 *   inserted/removed lines above it would be misread as NEW; two distinct
 *   diagnostics sharing a rule code stay distinct.
 */
export type DeltaMatchMode = 'strict' | 'tolerant'

/**
 * Env var that opts a caller back into the 'strict' delta matcher (value
 * 'strict', case-insensitive). The default is 'tolerant' — see
 * {@link DeltaMatchMode} for the trade-offs and why tolerant won.
 */
export const DELTA_MODE_ENV_FLAG = 'OPENBUFF_DIAGNOSTIC_DELTA_MODE'

export type DiagnosticCoverageStatus =
  | 'complete'
  | 'incomplete'
  | 'unavailable'
  | 'unknown'
export type DiagnosticCommandObservation = {
  command: string
  status:
    | 'completed'
    | 'failed'
    | 'timed_out'
    | 'cancelled'
    | 'unavailable'
    | 'unknown'
  exitCode?: number
  errorMessage?: string
  outputTruncated: boolean
  diagnosticCount: number
  coverageStatus: DiagnosticCoverageStatus
}
export type DiagnosticCapture = {
  diagnostics: LanguageDiagnostic[]
  commands: DiagnosticCommandObservation[]
  coverage: {
    status: DiagnosticCoverageStatus
    requestedFiles: string[]
    observedFiles: string[]
    unobservedFiles: string[]
    reasons: string[]
  }
}
export type DiagnosticStatus =
  | 'passed'
  | 'new_errors'
  | 'failed'
  | 'cancelled'
  | 'unavailable'
  | 'incomplete'
  | 'unknown'
export type DiagnosticObservations = {
  basis: 'before_after' | 'current_only' | 'unknown'
  before?: DiagnosticCapture
  after?: DiagnosticCapture
  reason?: string
}
export type DiagnosticDeltaPreflightResult = (
  | { rejected: false }
  | {
      rejected: true
      newDiagnostics: LanguageDiagnostic[]
      fixIts: LanguageDiagnosticTextEdit[]
    }
) & {
  /** Optional only for legacy injected adapters; absence grants no passed evidence. */
  diagnosticStatus?: DiagnosticStatus
  observations?: DiagnosticObservations
}

/** Bounded work: cap files inspected per preflight/capture. */
const MAX_PREFLIGHT_FILES = 20
/** Bounded work: cap distinct diagnostic commands executed per capture. */
const MAX_DIAGNOSTIC_COMMANDS = 4
/** Bounded output: cap total diagnostics retained across all commands. */
const MAX_TOTAL_DIAGNOSTICS = 200
/** Bounded output: cap aggregated fix-it edits returned on rejection. */
const MAX_FIXITS = 50
/** Diagnostic commands can be slow; bound each run through the runner seam. */
const DEFAULT_DIAGNOSTIC_TIMEOUT_SECONDS = 120
/**
 * Bounded parallel window for the per-capture command fan-out (perf:
 * diagnostic-preflight-serial-commands-hot-path): running up to
 * MAX_DIAGNOSTIC_COMMANDS (4) compile-scale commands strictly serially added
 * up to ~8 minutes of hook latency per file-change-hook invocation under the
 * 120s default timeout. Two concurrent toolchain processes already saturate
 * most dev machines, so the window trades a bounded CPU-contention increase
 * for a bounded (halved) worst-case latency instead of fanning out wider.
 */
const MAX_DIAGNOSTIC_CONCURRENCY = 2

/**
 * Ordered, parseable validation commands per language, aligned with each
 * language's registry `validation.focused` stages and `tools` metadata. Where a
 * tool supports a machine-readable format that carries fix-its (ruff, cargo,
 * eslint), the JSON variant is preferred so `fixes` survive into the preflight
 * result; plain-text compilers (tsc, go vet) are parsed by the regex parsers.
 */
const DIAGNOSTIC_COMMANDS: Partial<
  Record<SupportedLanguageId, readonly string[]>
> = {
  typescript: ['tsc --noEmit --pretty false', 'eslint --format=json .'],
  python: ['ruff check --output-format=json', 'pyright --outputjson'],
  rust: ['cargo check --message-format=json'],
  go: ['go vet ./...'],
}

/** Resolve a file to its supported language via the registry's extensions. */
function languageIdForFile(file: string): SupportedLanguageId | undefined {
  const extension = path.extname(file).toLowerCase()
  if (!extension) return undefined
  for (const id of SUPPORTED_LANGUAGE_IDS) {
    const capability = getLanguageCapability(id)
    if ((capability.extensions as readonly string[]).includes(extension)) {
      return id
    }
  }
  return undefined
}

/** Files known to the language registry; capture reports missing command support. */
export function supportedDiagnosticFiles(files: readonly string[]): string[] {
  return files.filter((file) => languageIdForFile(file) !== undefined)
}

/**
 * All diagnostic commands needed to cover `files`, ordered by first use.
 * Capture applies the command cap and records every omitted scope. Project/package-wide commands (cargo
 * check, tsc, go vet) run once per capture rather than per file.
 */
function collectDiagnosticCommands(files: readonly string[]): string[] {
  const commands: string[] = []
  const seenLanguages = new Set<SupportedLanguageId>()
  for (const file of files) {
    const languageId = languageIdForFile(file)
    if (!languageId || seenLanguages.has(languageId)) continue
    seenLanguages.add(languageId)
    for (const command of DIAGNOSTIC_COMMANDS[languageId] ?? []) {
      if (!commands.includes(command)) commands.push(command)
    }
  }
  return commands
}

type CaptureParams = {
  files: string[]
  cwd: string
  runCommand: DiagnosticCommandRunner
  env?: Record<string, string | undefined>
  signal?: AbortSignal
  timeoutSeconds?: number
  maxFiles?: number
}

/** Compatibility projection. Call captureDiagnosticObservation for validation evidence. */
export async function captureDiagnostics(
  params: CaptureParams,
): Promise<LanguageDiagnostic[]> {
  return (await captureDiagnosticObservation(params)).diagnostics
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Recognize only formats from the selected command table, never arbitrary log emptiness. */
function recognizedOutput(
  command: string,
  stdout: string,
  stderr: string,
  parsedCount: number,
): boolean {
  if (!stdout.trim() && !stderr.trim()) return true
  if (
    command.startsWith('ruff ') ||
    command.startsWith('eslint ') ||
    command.startsWith('pyright ')
  ) {
    if (stderr.trim()) return false
    try {
      const value: unknown = JSON.parse(stdout)
      if (command.startsWith('ruff '))
        return (
          Array.isArray(value) &&
          value.length === parsedCount &&
          value.every(
            (entry) =>
              record(entry) &&
              typeof entry.filename === 'string' &&
              typeof entry.message === 'string' &&
              record(entry.location) &&
              typeof entry.location.row === 'number',
          )
        )
      if (command.startsWith('eslint '))
        return (
          Array.isArray(value) &&
          value.reduce(
            (count, entry) =>
              count +
              (record(entry) && Array.isArray(entry.messages)
                ? entry.messages.length
                : 0),
            0,
          ) === parsedCount &&
          value.every(
            (entry) =>
              record(entry) &&
              typeof entry.filePath === 'string' &&
              Array.isArray(entry.messages) &&
              entry.messages.every(
                (message) =>
                  record(message) &&
                  typeof message.message === 'string' &&
                  typeof message.severity === 'number',
              ),
          )
        )
      if (!record(value)) return false
      const entries = value.generalDiagnostics ?? value.diagnostics
      return (
        Array.isArray(entries) &&
        entries.length === parsedCount &&
        entries.every(
          (entry) =>
            record(entry) &&
            typeof entry.message === 'string' &&
            typeof entry.file === 'string' &&
            record(entry.range),
        )
      )
    } catch {
      return false
    }
  }
  if (command.startsWith('cargo ')) {
    const lines = stdout.split(/\r?\n/).filter((line) => line.trim())
    let messages = 0
    const known = lines.every((line) => {
      try {
        const value: unknown = JSON.parse(line)
        if (record(value) && value.reason === 'compiler-message') messages++
        return (
          record(value) &&
          ((value.reason === 'compiler-message' &&
            record(value.message) &&
            typeof value.message.message === 'string' &&
            Array.isArray(value.message.spans)) ||
            value.reason === 'compiler-artifact' ||
            value.reason === 'build-script-executed' ||
            value.reason === 'build-finished')
        )
      } catch {
        return false
      }
    })
    return (
      known &&
      messages === parsedCount &&
      stderr
        .split(/\r?\n/)
        .every(
          (line) =>
            !line.trim() ||
            /^\s*(Checking |Compiling |Finished |warning: .*generated|error: could not compile )/.test(
              line,
            ),
        )
    )
  }
  const lines = `${stdout}\n${stderr}`.split(/\r?\n/)
  let located = false
  return lines.every((line) => {
    if (!line.trim()) return true
    if (
      (command.startsWith('tsc ') &&
        /^.+\(\d+,\d+\): (error|warning) TS\d+:/.test(line)) ||
      (command.startsWith('go ') && /^.+:\d+(?::\d+)?:/.test(line))
    ) {
      located = true
      return true
    }
    return (
      (located && /^\s+/.test(line)) ||
      (command.startsWith('go ') && /^# /.test(line))
    )
  })
}

function completedWithDiagnostics(
  command: string,
  result: DiagnosticRunResult,
  count: number,
): boolean {
  if (result.exitCode === 0) return true
  if (count === 0) return false
  return command.startsWith('cargo ')
    ? result.exitCode === 101
    : command.startsWith('tsc ')
      ? result.exitCode === 1 || result.exitCode === 2
      : result.exitCode === 1
}

/** Capture command execution and bounded coverage alongside parsed diagnostics. */
export async function captureDiagnosticObservation(
  params: CaptureParams,
): Promise<DiagnosticCapture> {
  const { cwd, runCommand, env, signal } = params
  const maxFiles = Math.max(
    1,
    Math.min(MAX_PREFLIGHT_FILES, params.maxFiles ?? MAX_PREFLIGHT_FILES),
  )
  const requestedFiles = [...new Set(params.files)]
  const files = supportedDiagnosticFiles(requestedFiles).slice(0, maxFiles)
  const planned = collectDiagnosticCommands(files)
  const commands = planned.slice(0, MAX_DIAGNOSTIC_COMMANDS)
  const captures = await mapWithConcurrency(
    commands,
    Math.max(1, Math.min(MAX_DIAGNOSTIC_CONCURRENCY, commands.length)),
    async (command) => {
      let result: DiagnosticRunResult
      try {
        result = signal?.aborted
          ? { cancelled: true }
          : await runCommand({
              command,
              cwd,
              timeoutSeconds:
                params.timeoutSeconds ?? DEFAULT_DIAGNOSTIC_TIMEOUT_SECONDS,
              env,
              signal,
            })
      } catch (error) {
        result = {
          errorMessage: error instanceof Error ? error.message : String(error),
          cancelled:
            signal?.aborted ||
            (error instanceof Error && error.name === 'AbortError'),
        }
      }
      const parsed = parseLanguageDiagnosticsWithCoverage({
        command,
        cwd,
        stdout: result.stdout ?? '',
        stderr: result.stderr ?? '',
      })
      let status: DiagnosticCommandObservation['status']
      if (result.cancelled || signal?.aborted) status = 'cancelled'
      else if (result.timedOut) status = 'timed_out'
      else if (
        result.exitCode === 127 ||
        result.errorCode === 'ENOENT' ||
        result.errorCode === 'EMPTY_COMMAND'
      )
        status = 'unavailable'
      else if (result.errorMessage) status = 'failed'
      else if (
        result.exitCode === undefined ||
        !Number.isInteger(result.exitCode)
      )
        status = 'unknown'
      else
        status = completedWithDiagnostics(
          command,
          result,
          parsed.diagnostics.length,
        )
          ? 'completed'
          : 'failed'
      const outputTruncated = Boolean(
        result.outputTruncated || parsed.truncated,
      )
      const coverageStatus: DiagnosticCoverageStatus = outputTruncated
        ? 'incomplete'
        : status === 'unavailable'
          ? 'unavailable'
          : status !== 'completed'
            ? 'unknown'
            : recognizedOutput(
                  command,
                  result.stdout ?? '',
                  result.stderr ?? '',
                  parsed.diagnostics.length,
                )
              ? 'complete'
              : 'unknown'
      const observation: DiagnosticCommandObservation = {
        command,
        status,
        exitCode: result.exitCode,
        errorMessage: result.errorMessage,
        outputTruncated,
        diagnosticCount: parsed.diagnostics.length,
        coverageStatus,
      }
      return { diagnostics: parsed.diagnostics, observation }
    },
  )
  const observations = captures.map((capture) => capture.observation)
  const allDiagnostics = captures.flatMap((capture) => capture.diagnostics)
  const observedFiles = files.filter((file) => {
    const selected = DIAGNOSTIC_COMMANDS[languageIdForFile(file)!] ?? []
    return (
      selected.length > 0 &&
      selected.every((command) =>
        observations.some(
          (observation) =>
            observation.command === command &&
            observation.status === 'completed' &&
            observation.coverageStatus === 'complete',
        ),
      )
    )
  })
  const unobservedFiles = requestedFiles.filter(
    (file) => !observedFiles.includes(file),
  )
  const reasons: string[] = []
  if (
    requestedFiles.some(
      (file) =>
        !languageIdForFile(file) ||
        !DIAGNOSTIC_COMMANDS[languageIdForFile(file)!]?.length,
    )
  )
    reasons.push('missing_language_command')
  if (supportedDiagnosticFiles(requestedFiles).length > files.length)
    reasons.push('file_cap')
  if (planned.length > commands.length) reasons.push('command_cap')
  if (
    allDiagnostics.length > MAX_TOTAL_DIAGNOSTICS ||
    observations.some((entry) => entry.outputTruncated)
  )
    reasons.push('output_cap')
  if (observations.some((entry) => entry.status !== 'completed'))
    reasons.push('command_unsuccessful')
  if (observations.some((entry) => entry.coverageStatus === 'unknown'))
    reasons.push('unknown_observation')
  if (commands.length === 0) reasons.push('no_diagnostic_commands')
  const status: DiagnosticCoverageStatus =
    commands.length === 0
      ? 'unavailable'
      : reasons.length === 0 && unobservedFiles.length === 0
        ? 'complete'
        : reasons.includes('output_cap') ||
            reasons.includes('file_cap') ||
            reasons.includes('command_cap') ||
            observedFiles.length > 0
          ? 'incomplete'
          : observations.every((entry) => entry.status === 'unavailable')
            ? 'unavailable'
            : 'unknown'
  return {
    diagnostics: allDiagnostics.slice(0, MAX_TOTAL_DIAGNOSTICS),
    commands: observations,
    coverage: {
      status,
      requestedFiles,
      observedFiles,
      unobservedFiles,
      reasons,
    },
  }
}

function captureStatus(capture: DiagnosticCapture): DiagnosticStatus {
  if (capture.commands.some((command) => command.status === 'cancelled'))
    return 'cancelled'
  if (
    capture.commands.some(
      (command) =>
        command.status === 'failed' || command.status === 'timed_out',
    )
  )
    return 'failed'
  return capture.coverage.status === 'complete'
    ? 'passed'
    : capture.coverage.status
}

function strictKey(diagnostic: LanguageDiagnostic): string {
  return JSON.stringify([
    diagnostic.file,
    diagnostic.range?.start.line ?? null,
    diagnostic.range?.start.column ?? null,
    diagnostic.code,
    diagnostic.severity,
  ])
}

function tolerantKey(diagnostic: LanguageDiagnostic): string {
  return JSON.stringify([diagnostic.file, diagnostic.code, diagnostic.severity])
}

/**
 * Pure delta: the diagnostics in `after` that have no matching diagnostic in
 * `before` under the requested match mode. Matching key (strict) is (file,
 * line, column, code/ruleId, severity); tolerant mode matches on (file, code, severity)
 * with count-aware multiset semantics to survive line shifts. See
 * {@link DeltaMatchMode}.
 *
 * DEFAULT: 'tolerant'. The strict matcher rejected valid edits whose
 * PRE-EXISTING errors merely shifted lines, so the default flips to tolerant;
 * strict remains available via `options.mode: 'strict'` or the
 * {@link DELTA_MODE_ENV_FLAG} env var.
 *
 * Tolerant matching is count-aware (multiset semantics): the baseline counts
 * per (file, code, severity) key are consumed as `after` diagnostics match against
 * them, so a diagnostic counts as NEW once the baseline count for its key is
 * exhausted. A plain per-key Set would mask a genuinely NEW error that merely
 * shares a rule code with a pre-existing one; the multiset keeps N
 * pre-existing errors tolerated while the (N+1)th same-key error is reported.
 */
export function computeDiagnosticDelta(
  before: readonly LanguageDiagnostic[],
  after: readonly LanguageDiagnostic[],
  options: { mode?: DeltaMatchMode } = {},
): LanguageDiagnostic[] {
  const keyOf = resolveDeltaKeyOf(options.mode)
  if (keyOf !== tolerantKey) {
    // Strict mode keeps its original exact-set semantics.
    const baseline = new Set(before.map(keyOf))
    return after.filter((diagnostic) => !baseline.has(keyOf(diagnostic)))
  }
  // Count-aware tolerant matching (multiset semantics): consume one baseline
  // occurrence per matched after-diagnostic, so an after diagnostic sharing a
  // pre-existing (file, code, severity) key is only tolerated while baseline counts
  // remain; once exhausted it is reported as NEW. Pure line shifts stay
  // tolerated because the match key ignores positions.
  const baselineCounts = new Map<string, number>()
  for (const diagnostic of before) {
    const key = tolerantKey(diagnostic)
    baselineCounts.set(key, (baselineCounts.get(key) ?? 0) + 1)
  }
  const delta: LanguageDiagnostic[] = []
  for (const diagnostic of after) {
    const key = tolerantKey(diagnostic)
    const remaining = baselineCounts.get(key) ?? 0
    if (remaining > 0) {
      baselineCounts.set(key, remaining - 1)
      continue
    }
    delta.push(diagnostic)
  }
  return delta
}

/**
 * Resolve the effective delta match mode. Explicit `options.mode` wins;
 * otherwise OPENBUFF_DIAGNOSTIC_DELTA_MODE=strict opts into the strict
 * matcher and the default is 'tolerant' (fail-open-friendly: a pre-existing
 * diagnostic that merely shifted lines must not fabricate a rejection).
 */
function resolveDeltaKeyOf(
  mode?: DeltaMatchMode,
): (diagnostic: LanguageDiagnostic) => string {
  if (mode) return mode === 'tolerant' ? tolerantKey : strictKey
  // Env access is routed through the SDK env helper (env-architecture gate);
  // DELTA_MODE_ENV_FLAG names the OPENBUFF_DIAGNOSTIC_DELTA_MODE var.
  return getSdkEnv()[DELTA_MODE_ENV_FLAG]?.trim().toLowerCase() === 'strict'
    ? strictKey
    : tolerantKey
}

/**
 * Full preflight flow: capture baseline diagnostics, apply the injected
 * `applyEdit()` callback, capture again, and compute the delta. The callback
 * shape lets the caller decide how the edit is applied (and, on rejection,
 * rolled back via the optional `rollbackEdit`), so this module never touches
 * the mutation broker directly.
 *
 * `baseline` (optional, P3 audit fix D): a caller that already captured the
 * PRE-EDIT diagnostic state (e.g. run.ts before a file-mutating tool
 * executes) supplies it here. When present, the first capture is skipped and
 * `baseline` is used as `before` — the real after-capture still runs (a
 * baseline makes `skipSecondCapture` moot; when both are given, the baseline
 * wins and the second capture runs so a genuine delta can be computed), so
 * the reject-only-on-new-errors path becomes reachable on the hook seam.
 *
 * Rejects ONLY when the delta contains error-severity diagnostics. On
 * rejection the edit is undone when `rollbackEdit` is supplied (keeping the
 * preflight non-mutating) and the new errors' fix-its are aggregated; on
 * acceptance the edit stays applied. New warnings never reject.
 *
 * Failure containment: a throwing `applyEdit` never leaves the edit applied
 * with no rollback — the edit is rolled back best-effort inside its own
 * try/catch (a rollback failure is logged, never masked over the original
 * apply error) and a structured rejection is returned. The rejection carries
 * no fabricated diagnostics: with no honest after-capture, `newDiagnostics`
 * and `fixIts` are empty and the caller denies by default. Likewise a
 * throwing `rollbackEdit` on the rejection path is logged and does NOT
 * discard the rejection result — the caller still receives the new errors and
 * their fix-its.
 */
export async function preflightDiagnosticDelta(params: {
  files: string[]
  cwd: string
  runCommand: DiagnosticCommandRunner
  applyEdit: () => void | Promise<void>
  rollbackEdit?: () => void | Promise<void>
  env?: Record<string, string | undefined>
  signal?: AbortSignal
  timeoutSeconds?: number
  maxFiles?: number
  deltaMode?: DeltaMatchMode
  /**
   * Skip the second diagnostic capture when the caller's `applyEdit` is a
   * guaranteed no-op. Used by the file-change-hook seam, which observes
   * already-changed files and passes a no-op applyEdit: a second capture can
   * only re-observe the identical on-disk state, so compile-scale commands
   * (tsc --noEmit, ruff, cargo check) would run twice per hook invocation for
   * redundant second capture. With this flag one current-state observation
   * is retained. It can pass only when complete and error-free; existing
   * errors without a pre-edit basis remain unknown. Mutating callers keep
   * both captures.
   */
  skipSecondCapture?: boolean
  /**
   * Pre-edit diagnostic snapshot supplied by a caller that captured the
   * baseline BEFORE the file mutation ran (P3 audit fix D). When present the
   * first capture is skipped and this is used as `before`; the real
   * after-capture still runs (the baseline wins over `skipSecondCapture`),
   * making the reject-only-on-new-errors path reachable on the hook seam.
   */
  baseline?: DiagnosticCapture | LanguageDiagnostic[]
}): Promise<DiagnosticDeltaPreflightResult> {
  const { files, cwd, runCommand, applyEdit, rollbackEdit, env, signal } =
    params
  const capture = () =>
    captureDiagnosticObservation({
      files,
      cwd,
      runCommand,
      env,
      signal,
      timeoutSeconds: params.timeoutSeconds,
      maxFiles: params.maxFiles,
    })

  // When a pre-edit baseline is supplied, skip the first capture and use it
  // as `before`. The after-capture below still runs (a baseline wins over
  // skipSecondCapture) so the preflight can compute a real delta.
  const before: DiagnosticCapture = Array.isArray(params.baseline)
    ? {
        diagnostics: params.baseline,
        commands: [],
        coverage: {
          status: 'unknown',
          requestedFiles: files,
          observedFiles: [],
          unobservedFiles: files,
          reasons: ['legacy_baseline_has_no_observation'],
        },
      }
    : (params.baseline ?? (await capture()))
  const observations: DiagnosticObservations = {
    basis:
      params.skipSecondCapture && params.baseline === undefined
        ? 'current_only'
        : 'before_after',
    before,
  }
  if (
    signal?.aborted ||
    before.commands.some((command) => command.status === 'cancelled')
  ) {
    return {
      rejected: true,
      diagnosticStatus: 'cancelled',
      observations,
      newDiagnostics: [],
      fixIts: [],
    }
  }
  // A throwing applyEdit used to leave the edit applied with no rollback and
  // crash the whole preflight. Contain it: roll back best-effort in its own
  // try/catch (a rollback failure is logged, never masked over the original
  // apply error) and return a structured rejection. The rejection carries no
  // fabricated diagnostics — with no honest after-capture, newDiagnostics and
  // fixIts are empty and the caller denies by default (fail-open preflight
  // semantics are preserved: nothing is invented to reject with).
  try {
    await applyEdit()
  } catch (error) {
    console.error(
      '[diagnostic-delta] applyEdit threw; rolling back the edit',
      error instanceof Error ? error : String(error),
    )
    if (rollbackEdit) {
      try {
        await rollbackEdit()
      } catch (rollbackError) {
        console.error(
          '[diagnostic-delta] rollbackEdit threw while undoing a failed applyEdit; the edit may be left applied',
          rollbackError instanceof Error
            ? rollbackError
            : String(rollbackError),
        )
      }
    }
    return {
      rejected: true,
      diagnosticStatus: 'failed',
      observations: { ...observations, reason: 'apply_edit_failed' },
      newDiagnostics: [],
      fixIts: [],
    }
  }
  // A no-op applyEdit cannot change diagnostics, so the second capture is
  // guaranteed redundant work on the hot file-change path; reuse the baseline
  // instead of re-running the full command set. A supplied pre-edit baseline
  // wins over this flag: the after-state must be captured for real so the
  // delta against that baseline can be computed.
  const after =
    params.skipSecondCapture && params.baseline === undefined
      ? before
      : await capture()

  observations.after = after
  const beforeStatus = captureStatus(before)
  const afterStatus = captureStatus(after)
  if (beforeStatus !== 'passed' || afterStatus !== 'passed') {
    const priority: DiagnosticStatus[] = [
      'cancelled',
      'failed',
      'unavailable',
      'incomplete',
      'unknown',
    ]
    const diagnosticStatus =
      priority.find(
        (status) => status === beforeStatus || status === afterStatus,
      ) ?? 'unknown'
    return { rejected: false, diagnosticStatus, observations }
  }
  if (
    observations.basis === 'current_only' &&
    after.diagnostics.some((entry) => entry.severity === 'error')
  ) {
    return {
      rejected: false,
      diagnosticStatus: 'unknown',
      observations: { ...observations, reason: 'missing_pre_edit_baseline' },
    }
  }
  if (
    JSON.stringify([...before.coverage.requestedFiles].sort()) !==
      JSON.stringify([...after.coverage.requestedFiles].sort()) ||
    JSON.stringify(before.commands.map((entry) => entry.command).sort()) !==
      JSON.stringify(after.commands.map((entry) => entry.command).sort())
  ) {
    return {
      rejected: false,
      diagnosticStatus: 'incomplete',
      observations: { ...observations, reason: 'baseline_scope_mismatch' },
    }
  }
  const delta = computeDiagnosticDelta(before.diagnostics, after.diagnostics, {
    mode: params.deltaMode,
  })
  const newErrors = delta.filter(
    (diagnostic) => diagnostic.severity === 'error',
  )
  if (newErrors.length === 0) {
    // No new error-severity diagnostics: accept the edit and keep it applied.
    return { rejected: false, diagnosticStatus: 'passed', observations }
  }

  // A throwing rollbackEdit used to discard the whole rejection result. Log
  // it and still return the structured rejection with the new diagnostics and
  // their fix-its; the caller decides what to do with an edit that failed to
  // roll back.
  if (rollbackEdit) {
    try {
      await rollbackEdit()
    } catch (rollbackError) {
      console.error(
        '[diagnostic-delta] rollbackEdit threw after rejecting the edit; the edit may be left applied',
        rollbackError instanceof Error ? rollbackError : String(rollbackError),
      )
    }
  }
  const fixIts: LanguageDiagnosticTextEdit[] = []
  const seenFixes = new Set<string>()
  for (const diagnostic of newErrors) {
    for (const fix of diagnostic.fixes ?? []) {
      if (fixIts.length >= MAX_FIXITS) break
      const key = JSON.stringify(fix)
      if (seenFixes.has(key)) continue
      seenFixes.add(key)
      fixIts.push(fix)
    }
  }
  return {
    rejected: true,
    diagnosticStatus: 'new_errors',
    observations,
    newDiagnostics: newErrors,
    fixIts,
  }
}
