import path from 'node:path'

import {
  getLanguageCapability,
  SUPPORTED_LANGUAGE_IDS,
  type SupportedLanguageId,
} from '@codebuff/common/util/language-capabilities'

import {
  parseLanguageDiagnostics,
  type LanguageDiagnostic,
  type LanguageDiagnosticTextEdit,
} from '../tools/language-diagnostics'
import { mapWithConcurrency } from '../tools/concurrency'
import { getSdkEnv } from '../env'

/**
 * Diagnostic-delta preflight (LI-02 tiers 1–2).
 *
 * The service answers one question: "does this edit introduce NEW
 * compiler/LSP errors?" It captures a language-appropriate baseline, applies
 * an injected edit, captures again, and rejects ONLY when error-severity
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
}

/**
 * Injected runner seam. Implementations MUST honor `timeoutSeconds` (diagnostic
 * commands can be slow) and SHOULD treat a missing tool as a non-fatal
 * `errorMessage`/empty output rather than throwing, so a tool that is absent
 * cannot fabricate a rejection. This module parses whatever stdout/stderr the
 * runner returns; an absent tool therefore yields zero diagnostics.
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
 * - 'tolerant' (default): match on (file, code) only, so a pre-existing
 *   diagnostic that moved lines still matches its baseline and is NOT reported
 *   as new. Tolerant is the default because the strict matcher rejected valid
 *   edits whose PRE-EXISTING errors merely shifted lines (the edit did not
 *   introduce them); tolerance is the safer failure mode for a fail-open
 *   preflight. Opt back into strict via `deltaMode: 'strict'` or the
 *   OPENBUFF_DIAGNOSTIC_DELTA_MODE=strict env var.
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

export type DiagnosticDeltaPreflightResult =
  | { rejected: false }
  | {
      rejected: true
      /** New error-severity diagnostics introduced by the edit. */
      newDiagnostics: LanguageDiagnostic[]
      /** Aggregated tool-suggested fix-it edits across `newDiagnostics`. */
      fixIts: LanguageDiagnosticTextEdit[]
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

/** Files that map to a supported language with a diagnostic command. */
export function supportedDiagnosticFiles(files: readonly string[]): string[] {
  return files.filter((file) => languageIdForFile(file) !== undefined)
}

/**
 * Unique diagnostic commands needed to cover `files`, ordered by first use and
 * capped at MAX_DIAGNOSTIC_COMMANDS. Project/package-wide commands (cargo
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
  return commands.slice(0, MAX_DIAGNOSTIC_COMMANDS)
}

/**
 * Run the language-appropriate diagnostic command(s) for `files` through the
 * injected runner and parse the structured/text output into LanguageDiagnostic[]
 * via the existing parsers in tools/language-diagnostics. A command whose tool
 * is unavailable yields no diagnostics (never a fabricated rejection).
 */
export async function captureDiagnostics(params: {
  files: string[]
  cwd: string
  runCommand: DiagnosticCommandRunner
  env?: Record<string, string | undefined>
  signal?: AbortSignal
  timeoutSeconds?: number
  maxFiles?: number
}): Promise<LanguageDiagnostic[]> {
  const { cwd, runCommand, env, signal } = params
  const timeoutSeconds =
    params.timeoutSeconds ?? DEFAULT_DIAGNOSTIC_TIMEOUT_SECONDS
  const maxFiles = Math.max(1, params.maxFiles ?? MAX_PREFLIGHT_FILES)
  const files = supportedDiagnosticFiles(params.files).slice(0, maxFiles)
  const commands = collectDiagnosticCommands(files)

  const diagnostics: LanguageDiagnostic[] = []
  // Bounded parallel fan-out instead of a strictly serial command loop
  // (perf: diagnostic-preflight-serial-commands-hot-path): each command is a
  // compile-scale process with the full runner-seam timeout, so serial
  // execution summed every command's worst-case wall clock on the hot
  // file-change path. The window is capped at MAX_DIAGNOSTIC_CONCURRENCY and
  // each command still carries the caller's timeoutSeconds, so total work is
  // bounded. A failing/absent tool must not abort the preflight or fabricate
  // a rejection; treat it as producing no diagnostics and move on.
  const perCommand = await mapWithConcurrency(
    commands,
    // Floor of 1: mapWithConcurrency requires a positive integer, and a
    // capture with no commands must resolve empty exactly as the serial loop
    // did (an empty worker pool would resolve holes).
    Math.max(1, Math.min(MAX_DIAGNOSTIC_CONCURRENCY, commands.length)),
    async (command): Promise<LanguageDiagnostic[]> => {
      try {
        const result = await runCommand({
          command,
          cwd,
          timeoutSeconds,
          env,
          signal,
        })
        return parseLanguageDiagnostics({
          command,
          cwd,
          stdout: result.stdout ?? '',
          stderr: result.stderr ?? '',
        })
      } catch {
        return []
      }
    },
  )
  // Keep the serial loop's deterministic join order and total cap: results
  // are index-aligned with `commands`, so diagnostics accumulate in command
  // order and stop at MAX_TOTAL_DIAGNOSTICS exactly as before.
  for (const parsed of perCommand) {
    for (const diagnostic of parsed) {
      if (diagnostics.length >= MAX_TOTAL_DIAGNOSTICS) break
      diagnostics.push(diagnostic)
    }
    if (diagnostics.length >= MAX_TOTAL_DIAGNOSTICS) break
  }
  return diagnostics
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
  return JSON.stringify([diagnostic.file, diagnostic.code])
}

/**
 * Pure delta: the diagnostics in `after` that have no matching diagnostic in
 * `before` under the requested match mode. Matching key (strict) is (file,
 * line, column, code/ruleId, severity); tolerant mode matches on (file, code)
 * to survive line shifts. See {@link DeltaMatchMode}.
 *
 * DEFAULT: 'tolerant'. The strict matcher rejected valid edits whose
 * PRE-EXISTING errors merely shifted lines, so the default flips to tolerant;
 * strict remains available via `options.mode: 'strict'` or the
 * {@link DELTA_MODE_ENV_FLAG} env var.
 */
export function computeDiagnosticDelta(
  before: readonly LanguageDiagnostic[],
  after: readonly LanguageDiagnostic[],
  options: { mode?: DeltaMatchMode } = {},
): LanguageDiagnostic[] {
  const keyOf = resolveDeltaKeyOf(options.mode)
  const baseline = new Set(before.map(keyOf))
  return after.filter((diagnostic) => !baseline.has(keyOf(diagnostic)))
}

/**
 * Resolve the effective delta match mode. Explicit `options.mode` wins;
 * otherwise OPENBUFF_DIAGNOSTIC_DELTA_MODE=strict opts into the strict
 * matcher and the default is 'tolerant' (fail-open-friendly: a pre-existing
 * diagnostic that merely shifted lines must not fabricate a rejection).
 */
function resolveDeltaKeyOf(mode?: DeltaMatchMode): (
  diagnostic: LanguageDiagnostic,
) => string {
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
   * a guaranteed-empty delta. With this flag the after-capture reuses the
   * baseline capture (delta collapses to empty → accept); the mutation-broker
   * path, whose applyEdit actually mutates, keeps both captures.
   */
  skipSecondCapture?: boolean
}): Promise<DiagnosticDeltaPreflightResult> {
  const { files, cwd, runCommand, applyEdit, rollbackEdit, env, signal } = params
  const capture = () =>
    captureDiagnostics({
      files,
      cwd,
      runCommand,
      env,
      signal,
      timeoutSeconds: params.timeoutSeconds,
      maxFiles: params.maxFiles,
    })

  const before = await capture()
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
          rollbackError instanceof Error ? rollbackError : String(rollbackError),
        )
      }
    }
    return {
      rejected: true,
      newDiagnostics: [],
      fixIts: [],
    }
  }
  // A no-op applyEdit cannot change diagnostics, so the second capture is
  // guaranteed redundant work on the hot file-change path; reuse the baseline
  // instead of re-running the full command set.
  const after = params.skipSecondCapture ? before : await capture()

  const delta = computeDiagnosticDelta(before, after, {
    mode: params.deltaMode,
  })
  const newErrors = delta.filter(
    (diagnostic) => diagnostic.severity === 'error',
  )
  if (newErrors.length === 0) {
    // No new error-severity diagnostics: accept the edit and keep it applied.
    return { rejected: false }
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
  return { rejected: true, newDiagnostics: newErrors, fixIts }
}
