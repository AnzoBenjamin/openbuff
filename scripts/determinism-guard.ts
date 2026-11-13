/**
 * P2-T1 enforcement guard (Followup C): fails when NEW direct `Date.now()`,
 * `crypto.randomUUID()`, or bare `randomUUID()` calls are added to
 * agent-runtime production files.
 *
 * A call is allowed when either:
 *  - it is adjacent (on its own line or up to 8 lines above) to an explicit
 *    deferral marker comment (`TODO(P2-T1b)`, `TODO(P2-T2)`, `NOTE(P2-T1)`), or
 *  - its per-file, per-pattern count is covered by the checked-in baseline
 *    `scripts/determinism-guard-baseline.json` (excess calls fail).
 *
 * Scope: `packages/agent-runtime/src` production files only — test files and
 * `__tests__/` directories are never scanned, and everything outside the
 * subtree (including `common/src/deps/real-runtime-deps.ts`, the sanctioned
 * realIdGen/realClock source) is out of scope by construction.
 *
 * Run modes (`bun scripts/determinism-guard.ts`):
 *  - default: check-only; exits 1 when there are findings, 0 otherwise.
 *  - `--update-baseline`: regenerate the checked-in baseline snapshot.
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

export type Finding = {
  path: string
  line: number
  message: string
}

export type DeterminismGuardResult = {
  score: number
  findings: Finding[]
}

/**
 * Pattern kinds tracked by the baseline. `dateNow` covers direct `Date.now(`
 * calls; `randomUuid` covers `crypto.randomUUID(` and bare `randomUUID(` (the
 * bare form only when the file imports randomUUID from node:crypto).
 */
export type PatternKind = 'dateNow' | 'randomUuid'

export type BaselineFileCounts = {
  dateNow: number
  randomUuid: number
}

export type DeterminismBaseline = {
  schemaVersion: 1
  generatedAt: string
  files: Record<string, BaselineFileCounts>
}

export type DeterminismGuardOptions = {
  /** Override the baseline location (defaults to `<root>/scripts/…`). */
  baselinePath?: string
}

const SCANNED_SUBDIR = join('packages', 'agent-runtime', 'src')
const BASELINE_RELATIVE_PATH = join('scripts', 'determinism-guard-baseline.json')

const SKIP_DIRECTORIES = new Set(['.git', 'node_modules', '__tests__'])

/**
 * Deferral markers that suppress a forbidden call on the marker's line or any
 * of the 8 lines below it: the call is a known, deliberately deferred site
 * (P2-T1b / P2-T2 follow-up), not a NEW untracked usage.
 */
const DEFERRAL_MARKERS = ['TODO(P2-T1b)', 'TODO(P2-T2)', 'NOTE(P2-T1)'] as const
const MARKER_WINDOW_LINES = 8

const KIND_LABELS: Record<PatternKind, string> = {
  dateNow: 'Date.now',
  randomUuid: 'randomUUID',
}

const DATE_NOW_REGEX = /Date\.now\(/
const QUALIFIED_RANDOM_UUID_REGEX = /crypto\.randomUUID\(/
// Bare form: word boundary before the identifier but NOT a member access.
// `crypto.randomUUID(` is its own pattern; `foo.randomUUID(` stays out of
// scope so injected idGen wrappers are never false-positived. The two regexes
// cannot match the same occurrence (the bare lookbehind rejects a preceding
// `.`), so no extra dedupe is needed.
const BARE_RANDOM_UUID_REGEX = /(?<![\w.])randomUUID\(/

// Lazy match consumes exactly one import statement up to its `from
// '<specifier>'` clause, so a randomUUID imported from elsewhere (e.g. a local
// wrapper module) never enables the bare-call pattern.
const IMPORT_STATEMENT_REGEX = /import[\s\S]*?from\s*['"]([^'"]+)['"]/g
const CRYPTO_SPECIFIERS = new Set(['crypto', 'node:crypto'])

function projectRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..')
}

function toProjectPath(root: string, path: string): string {
  return relative(root, path).split(sep).join('/')
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

function* productionFiles(root: string): Generator<string> {
  const srcDir = join(root, SCANNED_SUBDIR)
  if (!existsSync(srcDir)) {
    return
  }
  yield* walkProductionFiles(srcDir)
}

function* walkProductionFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const absolutePath = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (SKIP_DIRECTORIES.has(entry.name)) {
        continue
      }
      yield* walkProductionFiles(absolutePath)
      continue
    }
    if (!entry.isFile()) {
      continue
    }
    if (!entry.name.endsWith('.ts') && !entry.name.endsWith('.tsx')) {
      continue
    }
    if (entry.name.endsWith('.test.ts') || entry.name.endsWith('.test.tsx')) {
      continue
    }
    yield absolutePath
  }
}

/**
 * True when the file's import block binds `randomUUID` from 'node:crypto' or
 * 'crypto'. Each lazy match consumes exactly one import statement, so a
 * randomUUID imported from another module does not enable the bare pattern.
 */
function importsRandomUuidFromCrypto(content: string): boolean {
  IMPORT_STATEMENT_REGEX.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = IMPORT_STATEMENT_REGEX.exec(content)) !== null) {
    if (!CRYPTO_SPECIFIERS.has(match[1])) {
      continue
    }
    if (/\brandomUUID\b/.test(match[0])) {
      return true
    }
  }
  return false
}

/**
 * A forbidden call on line N is suppressed when any of lines
 * max(1, N - MARKER_WINDOW_LINES) .. N contains a deferral marker.
 */
function isMarkerSuppressed(lines: string[], lineNumber: number): boolean {
  const first = Math.max(1, lineNumber - MARKER_WINDOW_LINES)
  for (let n = first; n <= lineNumber; n++) {
    const text = lines[n - 1]
    if (DEFERRAL_MARKERS.some((marker) => text.includes(marker))) {
      return true
    }
  }
  return false
}

/**
 * Unsuppressed (marker-surviving) call lines per pattern kind for one file,
 * in top-down order. At most one occurrence per line per kind is reported
 * (the first), but a line with two different patterns yields two kinds.
 */
function unsuppressedLinesByKind(
  filePath: string,
): Record<PatternKind, number[]> {
  const content = readFileSync(filePath, 'utf8')
  const lines = content.split('\n')
  const importsRandomUuid = importsRandomUuidFromCrypto(content)
  const unsuppressed: Record<PatternKind, number[]> = {
    dateNow: [],
    randomUuid: [],
  }
  lines.forEach((line, index) => {
    const lineNumber = index + 1
    // Marker suppression depends only on the line number, never on the kind,
    // so a suppressed line can be skipped for every pattern at once.
    if (isMarkerSuppressed(lines, lineNumber)) {
      return
    }
    if (DATE_NOW_REGEX.test(line)) {
      unsuppressed.dateNow.push(lineNumber)
    }
    if (QUALIFIED_RANDOM_UUID_REGEX.test(line)) {
      unsuppressed.randomUuid.push(lineNumber)
    } else if (importsRandomUuid && BARE_RANDOM_UUID_REGEX.test(line)) {
      unsuppressed.randomUuid.push(lineNumber)
    }
  })
  return unsuppressed
}

/**
 * Scan agent-runtime production files and compare the current count of
 * unsuppressed calls per pattern kind against the checked-in baseline. Files
 * missing from the baseline fail on every unsuppressed call (the new-file
 * case); excess calls are reported by taking the LAST `current - baseline`
 * unsuppressed occurrences per kind, so appended code is what fails.
 */
export function runDeterminismGuard(
  root = projectRoot(),
  opts: DeterminismGuardOptions = {},
): DeterminismGuardResult {
  const baseline = loadDeterminismBaseline(root, opts.baselinePath)
  const findings: Finding[] = []
  const files = [...productionFiles(root)].sort(compareStrings)
  for (const filePath of files) {
    const projectPath = toProjectPath(root, filePath)
    const unsuppressed = unsuppressedLinesByKind(filePath)
    const baselineCounts = baseline.files[projectPath]
    for (const kind of ['dateNow', 'randomUuid'] as const) {
      const current = unsuppressed[kind]
      const allowed = baselineCounts ? baselineCounts[kind] : 0
      const excess = current.length - allowed
      if (excess <= 0) {
        continue
      }
      for (const line of current.slice(current.length - excess)) {
        findings.push({
          path: projectPath,
          line,
          message: `unmarked ${KIND_LABELS[kind]} call in agent-runtime production code (add a TODO(P2-T1b)/NOTE(P2-T1) deferral marker or use the injected clock/idGen)`,
        })
      }
    }
  }
  return { score: findings.length, findings }
}

function loadDeterminismBaseline(
  root: string,
  baselinePath?: string,
): DeterminismBaseline {
  const baselineFile = baselinePath ?? join(root, BASELINE_RELATIVE_PATH)
  if (!existsSync(baselineFile)) {
    // Fail closed: an ABSENT baseline behaves as an empty baseline, so every
    // unmarked call is excess. The baseline must be checked in for the guard
    // to allow any legacy call site; it can never silently disable rule B.
    return { schemaVersion: 1, generatedAt: '', files: {} }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(baselineFile, 'utf8'))
  } catch (err) {
    throw new Error(
      `determinism-guard baseline is not valid JSON: ${baselineFile} (${
        err instanceof Error ? err.message : String(err)
      })`,
    )
  }
  if (!isDeterminismBaseline(parsed)) {
    throw new Error(
      `determinism-guard baseline has an unexpected shape: ${baselineFile} (expected { schemaVersion: 1, generatedAt: string, files: { [projectRelativePath]: { dateNow: number, randomUuid: number } } })`,
    )
  }
  return parsed
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
}

function isDeterminismBaseline(value: unknown): value is DeterminismBaseline {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }
  const record = value as Record<string, unknown>
  if (record.schemaVersion !== 1 || typeof record.generatedAt !== 'string') {
    return false
  }
  const files = record.files
  if (!files || typeof files !== 'object' || Array.isArray(files)) {
    return false
  }
  return Object.values(files).every((counts) => {
    if (!counts || typeof counts !== 'object' || Array.isArray(counts)) {
      return false
    }
    const entry = counts as Record<string, unknown>
    return (
      isNonNegativeInteger(entry.dateNow) &&
      isNonNegativeInteger(entry.randomUuid)
    )
  })
}

/**
 * Regenerate the checked-in baseline from the CURRENT tree: one entry per
 * scanned file with at least one unsuppressed call site, keyed by
 * project-relative POSIX path. Output is key-sorted, 2-space-indented JSON
 * with a trailing newline so regenerations stay diff-able (byte-stable modulo
 * `generatedAt`, which callers may pin via `opts.generatedAt`).
 */
export function writeDeterminismBaseline(
  root = projectRoot(),
  opts: { generatedAt?: string } = {},
): DeterminismBaseline {
  const files: Record<string, BaselineFileCounts> = {}
  for (const filePath of productionFiles(root)) {
    const unsuppressed = unsuppressedLinesByKind(filePath)
    const counts: BaselineFileCounts = {
      dateNow: unsuppressed.dateNow.length,
      randomUuid: unsuppressed.randomUuid.length,
    }
    if (counts.dateNow === 0 && counts.randomUuid === 0) {
      continue
    }
    files[toProjectPath(root, filePath)] = counts
  }
  const sorted = Object.fromEntries(
    Object.entries(files).sort(([a], [b]) => compareStrings(a, b)),
  )
  const baseline: DeterminismBaseline = {
    schemaVersion: 1,
    generatedAt: opts.generatedAt ?? new Date().toISOString(),
    files: sorted,
  }
  const target = join(root, BASELINE_RELATIVE_PATH)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, JSON.stringify(baseline, null, 2) + '\n')
  return baseline
}

export function formatDeterminismReport(
  result: DeterminismGuardResult,
): string {
  if (result.score === 0) {
    return 'Determinism guard passed: 0 findings.'
  }
  const header = `Determinism guard: ${result.score} finding(s)`
  const lines = result.findings.map(
    (finding) => `${finding.path}:${finding.line}: ${finding.message}`,
  )
  return [header, ...lines].join('\n')
}

if (import.meta.main) {
  const root = projectRoot()
  if (process.argv.includes('--update-baseline')) {
    const baseline = writeDeterminismBaseline(root)
    console.log(
      `Determinism baseline written: ${BASELINE_RELATIVE_PATH} (${
        Object.keys(baseline.files).length
      } file(s) with unsuppressed call sites).`,
    )
  } else {
    const result = runDeterminismGuard(root)
    const report = formatDeterminismReport(result)
    if (result.score > 0) {
      console.error(report)
      process.exit(1)
    }
    console.log(report)
  }
}
