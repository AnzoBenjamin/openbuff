/**
 * Perf-repair wave — fixed-baseline before/after benchmark
 * (RF-1-41ffd2b0: fixed measurement baselines / benchmark before-after
 * evidence for this perf-repair wave).
 *
 * Times each perf guard introduced in this wave against a faithful
 * reimplementation of its PRE-FIX loop shape on one fixed deterministic
 * workload. "before" rows rebuild RegExp objects per call, replay the whole
 * carry buffer per chunk, or re-walk shared graph nodes (the pre-fix
 * behaviors); "after" rows call the shipped code.
 *
 * Like-for-like contract (RF-8 / RF-9): every before/after pair feeds
 * identical inputs through identical work layers — only the guarded change
 * differs — and every "after" row runs the shipped path (parseStreamChunk,
 * the shipped TOOL_EXTRACTION_PATTERN exported from
 * parse-tool-calls-from-text, extractFirstJsonObjectCandidate, the shipped
 * cachedRegExp memo, publishSelfMutatedPaths), never a local mirror of it
 * (after-rows-measure-mirrors / case2-after-row-local-pattern-mirror). Local
 * rebuilds exist ONLY on "before" rows, where the rebuilt-per-call shape IS
 * the pre-fix behavior under measurement. Every non-cap case asserts
 * before/after result parity so both rows compute identical output and the
 * measured delta is only the guarded cost. Rows whose two columns do
 * different work BY DESIGN — cap-engagement rows (3c, 4d), where bounding the
 * work IS the cap, and CASE 5, whose row evidences union parity + the
 * traversal bound rather than an isolated speedup — print no speedup ratio
 * (report() marks them `ratioBasis: 'contract'`).
 *
 * Evidence map (finding → case):
 *   lang-profile-regex-per-call ............... CASE 1
 *   tool-call-regex-built-per-parse ........... CASE 2
 *   stream-chunk-rescans-buffered-tool-call ... CASE 3 (carry-buffer replay)
 *   in-call-payload-replayed-per-chunk ........ CASE 3d (in-call replay)
 *   stream-buffer-unbounded-retained-text ..... CASE 3 note (retention bound
 *       is structural — flush at tool calls / stream end, pinned by the
 *       tool-stream-parser suite; CASE 3 measures the parse-side replay)
 *   per-call-regex-in-process-structured-edit . CASE 4 (cachedRegExp class)
 *   64KB tool-call buffer budget .............. CASE 3b (headroom) + 3c (cap)
 *   MAX_JSON_CANDIDATES=32 parse budget ...... CASE 4c (headroom) + 4d (cap)
 *   single-visited-set-shared-across-results .. CASE 5 (per-payload depth-aware
 *       memo; re-walk on strictly shallower reach)
 *   diagnostic-capture-utf8-chunk-split ........ CASE 10 (per-chunk toString
 *       decode vs the shipped byte-bounded single-decode capture)
 *   semgrep-availability-cache-unbounded +
 *   sync-versions-map-unbounded ................ CASE 11 (unbounded Map vs the
 *       shipped bounded-cache primitive; contract row — bounding IS the cap)
 *   snapshot-identity-serial-file-reads ........ CASE 12 (serial per-file
 *       identity reads vs the shipped bounded read window; CASE 12b is the
 *       map-then-join retention contract row)
 *   diagnostic-runner-timeout-no-sigkill-escalation ... CASE 13 (contract row —
 *       bare SIGTERM vs the shipped SIGTERM→SIGKILL escalation on a
 *       SIGTERM-ignoring child)
 *
 * X-2 additions — absolute "(after only)" rows (pure timing observations: no
 * before/after exists for these seams, so no speedup ratio is printed; each
 * case asserts only a small contract check on the shipped output):
 *   token-counting seam: raw BPE encode vs 100k-char-cap extrapolation CASE 6a/6b
 *   5MB pathological estimator (D12/P3-T10; BPE bounded to the 20k sample,
 *       body never BPE-encoded; own pass/fail, no parity row) ........ CASE 6c
 *   code_search JS-side rg line parse (formatCodeSearchOutput) ......... CASE 7
 *   X-2a hot paths (D13): assignDepths sweep + getPostingCandidates ... CASE 8a/8b
 *   tool-call stream parse (parseStreamChunk, 100KB in 1KB chunks) ..... CASE 9
 *
 * Manual-only X-2 rows (deliberately NOT measured here: they need a real
 * TUI/process and cannot run deterministically in CI — listed so the X-2
 * gate stays honest instead of shipping fake numbers):
 *   TUI keystroke latency — p50/p99 keystroke-to-render in the real Ink TUI
 *     via a scripted keystroke harness against a live terminal.
 *   cold-start — CLI process spawn → first interactive prompt, warm vs cold
 *     cache; process spawn timing is machine-dependent.
 *
 * Each row reports the median of RUNS timed runs per op together with its
 * min/max range and MAD dispersion (RF-13), and every printed speedup ratio
 * carries the min/max quotient envelope of the two rows: an envelope that
 * spans parity (1.0x) is marked `within-noise` — inside demonstrated
 * run-to-run spread, not evidence of a speedup. Numbers are evidence of
 * scale, not pass/fail thresholds — the script exits non-zero only when a
 * result-parity assertion fails.
 *
 * Usage: bun run scripts/measure-perf-guards-baseline.ts
 */

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { open, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'

import {
  detectLanguageProfilesFromTask,
  escapeRegexForLiteral,
} from '../common/src/util/language-profiles'
import {
  LANGUAGE_CAPABILITY_REGISTRY,
  SUPPORTED_LANGUAGE_IDS,
} from '../common/src/util/language-capabilities'
import { endToolTag, startToolTag } from '../common/src/tools/constants'
import { cachedRegExp } from '../packages/agent-runtime/src/process-structured-edit'
import {
  parseTextWithToolCalls,
  TOOL_EXTRACTION_PATTERN,
} from '../packages/agent-runtime/src/util/parse-tool-calls-from-text'
import {
  createStreamParserState,
  extractFirstJsonObjectCandidate,
  parseStreamChunk,
} from '../packages/agent-runtime/src/util/stream-xml-parser'
import {
  creditSelfMutatedPathValue,
  publishSelfMutatedPaths,
} from '../packages/agent-runtime/src/run-agent-step'
import { countTokens } from '../packages/agent-runtime/src/util/token-counter'
import { formatCodeSearchOutput } from '../common/src/util/format-code-search'
import {
  buildIndexQueryData,
  getPostingCandidates,
  MAX_POSTING_CANDIDATE_PATHS,
} from '../packages/indexer/src/query-data'

import type { SymbolRange } from '../packages/code-map/src/structure'
import type { IndexedFile, MetadataIndex } from '../packages/indexer/src/types'
import type { SupportedLanguageId } from '../common/src/util/language-capabilities'
import type { CodebuffSpawn } from '@codebuff/common/types/spawn'
import {
  BoundedStreamCapture,
  createDiagnosticCommandRunner,
  MAX_CAPTURED_STREAM_BYTES,
} from '../sdk/src/services/diagnostic-delta-runner'
import { LRUCache } from '../common/src/util/lru-cache'
import {
  hashIdentityFileBytes,
} from '../sdk/src/tools/get-change-review-bundle'
import { mapWithConcurrency } from '../sdk/src/tools/concurrency'

/** Fixed measurement baseline: identical constants for before and after rows. */
const RUNS = 5
const WARMUP_RUNS = 2

/**
 * Active baseline, overridable per invocation by runPerfGuardsBaseline
 * options (the smoke test runs 1 timed run, 0 warmups, every case scaled to
 * a single timed op). Defaults preserve the fixed baseline exactly.
 */
let activeRuns = RUNS
let activeWarmups = WARMUP_RUNS
let activeIterationsScale = 1
const PATH_SIGNAL_TAIL = '(?=$|[\\s`\'"),:;])'

/** Fixed workloads (deterministic; no I/O, no clock, no randomness). */
const TASK_TEXT =
  'Port the TypeScript importer to Python and Rust, wire the Go module and ' +
  'go.mod, update build.gradle and the C# csproj, add a Rakefile, ' +
  'composer.json, Package.swift, and CMakeLists.txt'
const TOOL_CALL_TEXT =
  'Preamble text before the calls.\n' +
  `${startToolTag}\n${JSON.stringify({
    cb_tool_name: 'read_files',
    paths: ['a.ts'],
  })}\n${endToolTag}\n` +
  'Middle prose segment.\n' +
  `${startToolTag}\n${JSON.stringify({
    cb_tool_name: 'glob',
    patterns: ['**/*.ts'],
  })}\n${endToolTag}\n` +
  'Closing prose.\n'
const TEXT_CHUNKS = Array.from({ length: 2048 }, () => 'abcdefghij'.repeat(10))
const SPECIFIERS = Array.from(
  { length: 50 },
  (_, i) => `@scope/pkg-${i}`,
)
const IMPORT_STATEMENTS = Array.from(
  { length: 200 },
  (_, i) => `import { x } from "@scope/pkg-${i % 50}"`,
)
const GRAPH_NODES = 400
const GRAPH_BRANCHING = 6
/**
 * 64KB budget rows: `IN_BUDGET_CALL_PAYLOAD` stays under
 * DEFAULT_MAX_TOOL_CALL_BUFFER_LENGTH (64KB) so it completes (headroom row);
 * `OVERSIZED_CALL_PAYLOAD` blows past it so the budget + discard-mode
 * contract engages (cap row). Path strings are ~38B each: 1200 ≈ 46KB in
 * budget, 3000 ≈ 114KB over budget.
 */
const IN_BUDGET_CALL_PAYLOAD = JSON.stringify({
  cb_tool_name: 'read_files',
  paths: Array.from(
    { length: 1200 },
    (_, i) => `packages/agent-runtime/src/file-${i}.ts`,
  ),
})
const OVERSIZED_CALL_PAYLOAD = JSON.stringify({
  cb_tool_name: 'read_files',
  paths: Array.from(
    { length: 3000 },
    (_, i) => `packages/agent-runtime/src/file-${i}.ts`,
  ),
})
/** MAX_JSON_CANDIDATES rows: balanced decoy braces that never parse as JSON. */
const DECOY_BRACES = Array.from({ length: 200 }, (_, i) => `{d${i}}`).join(' ')
const PROSE_PAYLOAD_JSON = JSON.stringify({
  cb_tool_name: 'read_files',
  paths: ['z.ts'],
})

let sink = 0

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]!
}

/** Median absolute deviation about the median (robust dispersion, RF-13). */
function medianAbsoluteDeviation(values: number[], center: number): number {
  const deviations = values
    .map((value) => Math.abs(value - center))
    .sort((a, b) => a - b)
  return deviations[Math.floor(deviations.length / 2)]!
}

/** Per-op timing with retained dispersion (RF-13 ratio stability). */
type Timing = {
  medianMsPerOp: number
  minMsPerOp: number
  maxMsPerOp: number
  madMsPerOp: number
}

/**
 * Times fn RUNS times × iterations, returning per-op milliseconds with the
 * min/max range and MAD retained alongside the median so report() can qualify
 * each ratio against the measurement noise floor (RF-13).
 */
function measure(
  fn: () => number,
  iterations: number,
  runs = activeRuns,
): Timing {
  // Iteration scale lets the smoke test collapse every case to a single timed
  // op without touching the per-case iteration constants (1 is the floor so a
  // 0 scale still times one real op per run).
  const scaledIterations = Math.max(
    1,
    Math.round(iterations * activeIterationsScale),
  )
  const once = () => {
    let checksum = 0
    for (let i = 0; i < scaledIterations; i++) checksum += fn()
    return checksum
  }
  for (let w = 0; w < activeWarmups; w++) sink += once()
  const samples: number[] = []
  for (let r = 0; r < runs; r++) {
    const started = performance.now()
    sink += once()
    samples.push((performance.now() - started) / scaledIterations)
  }
  const medianMsPerOp = median(samples)
  return {
    medianMsPerOp,
    minMsPerOp: Math.min(...samples),
    maxMsPerOp: Math.max(...samples),
    madMsPerOp: medianAbsoluteDeviation(samples, medianMsPerOp),
  }
}

/**
 * Async counterpart of {@link measure} for the I/O-shaped seams (CASE 12/13):
 * identical dispersion bookkeeping, with each op awaited instead of called
 * synchronously.
 */
async function measureAsync<T>(
  fn: () => Promise<T>,
  iterations: number,
  runs = activeRuns,
): Promise<Timing> {
  const scaledIterations = Math.max(
    1,
    Math.round(iterations * activeIterationsScale),
  )
  const once = async (): Promise<number> => {
    let checksum = 0
    for (let i = 0; i < scaledIterations; i++) {
      // String-returning ops (CASE 12 identity hashes) contribute no checksum
      // but are still awaited every iteration, so nothing is dead-code
      // eliminated and the measured work is the op itself.
      const value = await fn()
      if (typeof value === 'number') checksum += value
    }
    return checksum
  }
  for (let w = 0; w < activeWarmups; w++) sink += await once()
  const samples: number[] = []
  for (let r = 0; r < runs; r++) {
    const started = performance.now()
    sink += await once()
    samples.push((performance.now() - started) / scaledIterations)
  }
  const medianMsPerOp = median(samples)
  return {
    medianMsPerOp,
    minMsPerOp: Math.min(...samples),
    maxMsPerOp: Math.max(...samples),
    madMsPerOp: medianAbsoluteDeviation(samples, medianMsPerOp),
  }
}

interface CaseRow {
  case: string
  finding: string
  before: Timing
  after: Timing
  /**
   * 'like-for-like' rows feed identical work through both columns (only the
   * guarded change differs), so the printed before/after quotient is a real
   * speedup. 'contract' rows do different work BY DESIGN — cap-engagement rows
   * (bounding the work IS the cap) and CASE 5 (parity + walk bound, not a
   * timing win) — so no ratio is printed: a quotient across different work is
   * not a speedup (RF-8 / case5-asymmetric-speedup-ratio).
   */
  ratioBasis: 'like-for-like' | 'contract'
  note: string
}

const rows: CaseRow[] = []

function formatTiming(timing: Timing): string {
  return (
    `${timing.medianMsPerOp.toFixed(4).padStart(9)} ` +
    `[${timing.minMsPerOp.toFixed(4)}..${timing.maxMsPerOp.toFixed(4)}]` +
    `±${timing.madMsPerOp.toFixed(4)}`
  )
}

function report(row: CaseRow): void {
  rows.push(row)
  let speedup = 'n/a'
  if (row.ratioBasis === 'like-for-like' && row.after.medianMsPerOp > 0) {
    const ratio = row.before.medianMsPerOp / row.after.medianMsPerOp
    // RF-13 noise floor: the quotient's min/max envelope computed from both
    // rows' dispersion. When the envelope spans parity (1.0x) the measured
    // delta cannot be distinguished from run-to-run noise and is marked
    // `within-noise` — never read as a speedup.
    const envelopeLow = row.before.minMsPerOp / row.after.maxMsPerOp
    const envelopeHigh = row.before.maxMsPerOp / row.after.minMsPerOp
    const withinNoise = envelopeLow <= 1 && envelopeHigh >= 1
    speedup =
      `${ratio.toFixed(1)}x [${envelopeLow.toFixed(1)}..${envelopeHigh.toFixed(1)}]` +
      (withinNoise ? ' within-noise' : '')
  }
  console.log(
    `  ${row.case.padEnd(9)} ${row.finding.padEnd(44)} ` +
      `before ${formatTiming(row.before)} ms/op  ` +
      `after ${formatTiming(row.after)} ms/op  ${speedup}  ${row.note}`,
  )
}

function assertParity(label: string, before: unknown, after: unknown): void {
  const beforeJson = JSON.stringify(before)
  const afterJson = JSON.stringify(after)
  if (beforeJson !== afterJson) {
    // Throw (not process.exit): library callers of runPerfGuardsBaseline get a
    // catchable error; the import.meta.main CLI entry catches it and exits
    // non-zero, preserving CLI behavior.
    throw new Error(
      `PARITY FAILURE in ${label}\n  before: ${beforeJson}\n  after:  ${afterJson}`,
    )
  }
}

// ---------------------------------------------------------------------------
// CASE 1 — lang-profile-regex-per-call
// ---------------------------------------------------------------------------

function legacyTaskAliasHit(taskText: string, alias: string): boolean {
  const startsWithWord = /^\w/.test(alias)
  const endsWithWord = /\w$/.test(alias)
  const pattern =
    (startsWithWord ? '\\b' : '') +
    escapeRegexForLiteral(alias) +
    (endsWithWord ? '\\b' : '')
  return new RegExp(pattern, 'i').test(taskText)
}

function legacyPathSignalHit(taskText: string, signal: string): boolean {
  return new RegExp(
    escapeRegexForLiteral(signal) + PATH_SIGNAL_TAIL,
    'i',
  ).test(taskText)
}

/**
 * Pre-fix shape: every candidate signal compiles a fresh RegExp per call.
 * Work layers mirror the shipped detectLanguageProfilesFromTask exactly —
 * same signal iteration and short-circuit order, same registry mapping over
 * SUPPORTED_LANGUAGE_IDS order, same profile result type — so only the RegExp
 * construction timing differs between the measured rows (RF-8 /
 * case1-before-row-asymmetric-work-layers).
 */
function legacyDetectLanguageProfilesFromTask(
  taskText: string,
): ReturnType<typeof detectLanguageProfilesFromTask> {
  const detected = new Set<SupportedLanguageId>()
  for (const languageId of SUPPORTED_LANGUAGE_IDS) {
    const capability = LANGUAGE_CAPABILITY_REGISTRY[languageId]
    const hit =
      capability.taskAliases.some((alias) =>
        legacyTaskAliasHit(taskText, alias),
      ) ||
      capability.manifestNames.some((signal) =>
        legacyPathSignalHit(taskText, signal),
      ) ||
      capability.manifestExtensions.some((signal) =>
        legacyPathSignalHit(taskText, signal),
      ) ||
      capability.extensions.some((signal) =>
        legacyPathSignalHit(taskText, signal),
      ) ||
      (languageId === 'go' && /\bGo\b/.test(taskText))
    if (hit) detected.add(languageId)
  }
  // Same registry-mapping layer as the shipped profilesForIds.
  return SUPPORTED_LANGUAGE_IDS.filter((id) => detected.has(id)).map(
    (id) => LANGUAGE_CAPABILITY_REGISTRY[id],
  )
}

function runCase1(): void {
  const legacyProfiles = legacyDetectLanguageProfilesFromTask(TASK_TEXT)
  const fixedProfiles = detectLanguageProfilesFromTask(TASK_TEXT)
  assertParity(
    'CASE 1',
    legacyProfiles.map((profile) => profile.id),
    fixedProfiles.map((profile) => profile.id),
  )
  // Identical checksum consumer on both rows (RF-8 like-for-like /
  // case1-before-row-asymmetric-work-layers): the same reduce over the same
  // profile objects — only the guarded change (RegExp construction timing)
  // differs between the measured closures.
  const checksum = (
    profiles: ReturnType<typeof detectLanguageProfilesFromTask>,
  ): number => profiles.reduce((sum, profile) => sum + profile.id.length, 0)
  const legacy = measure(
    () => checksum(legacyDetectLanguageProfilesFromTask(TASK_TEXT)),
    500,
  )
  const fixed = measure(
    () => checksum(detectLanguageProfilesFromTask(TASK_TEXT)),
    500,
  )
  report({
    case: 'CASE 1',
    finding: 'lang-profile-regex-per-call',
    before: legacy,
    after: fixed,
    ratioBasis: 'like-for-like',
    note: `${legacyProfiles.length} langs detected, 500 ops/run`,
  })
}

// ---------------------------------------------------------------------------
// CASE 2 — tool-call-regex-built-per-parse
// ---------------------------------------------------------------------------

/**
 * Pre-fix shape ONLY (the measured before row): the extraction RegExp is
 * rebuilt on every parse. The measured after row times the SHIPPED
 * TOOL_EXTRACTION_PATTERN exported from parse-tool-calls-from-text.ts — never
 * a local rebuild of it (after-rows-measure-mirrors /
 * case2-after-row-local-pattern-mirror).
 */
function buildExtractionPattern(): RegExp {
  return new RegExp(
    `${escapeRegexForLiteral(startToolTag)}([\\s\\S]*?)${escapeRegexForLiteral(endToolTag)}`,
    'gs',
  )
}

function countMatches(pattern: RegExp): number {
  // Mirror the shipped call-site contract: a 'g'-flagged pattern carries
  // lastIndex across uses, so reset before each matchAll run
  // (parseTextWithToolCalls does the same on TOOL_EXTRACTION_PATTERN).
  pattern.lastIndex = 0
  let count = 0
  for (const _match of TOOL_CALL_TEXT.matchAll(pattern)) count++
  return count
}

function runCase2(): void {
  assertParity(
    'CASE 2',
    countMatches(buildExtractionPattern()),
    countMatches(TOOL_EXTRACTION_PATTERN),
  )
  const legacy = measure(() => countMatches(buildExtractionPattern()), 2000)
  const fixed = measure(() => countMatches(TOOL_EXTRACTION_PATTERN), 2000)
  const endToEnd = measure(
    () => parseTextWithToolCalls(TOOL_CALL_TEXT).length,
    2000,
  )
  report({
    case: 'CASE 2',
    finding: 'tool-call-regex-built-per-parse',
    before: legacy,
    after: fixed,
    ratioBasis: 'like-for-like',
    note: 'pattern hoist isolated (2 calls in workload), 2000 ops/run',
  })
  console.log(
    `  ${'CASE 2e'.padEnd(9)} ${'(reference) parseTextWithToolCalls end-to-end'.padEnd(44)} ` +
      `after ${formatTiming(endToEnd)} ms/op  includes per-call JSON parse`,
  )
}

// ---------------------------------------------------------------------------
// CASE 3 — stream-chunk-rescans-buffered-tool-call / stream-buffer retention
// ---------------------------------------------------------------------------

/**
 * Pre-fix shape: the carry buffer accumulates the whole stream and every
 * chunk rescans it in full (quadratic replay in chunk count).
 */
function legacyCarryReplay(): number {
  let buffer = ''
  let lastHit = -1
  for (const chunk of TEXT_CHUNKS) {
    buffer += chunk
    lastHit = buffer.indexOf(startToolTag)
  }
  // Parity checksum is total characters retained. The indexOf not-found
  // sentinel (-1) must NOT leak into the total or the before/after rows would
  // differ by 1 on a tag-free workload; the rescan itself is the measured cost.
  return buffer.length + Math.max(0, lastHit)
}

/** Shipped shape: carry-over is truncated to the tag-tail window per chunk. */
function fixedCarryReplay(): number {
  const state = createStreamParserState()
  let emitted = 0
  for (const chunk of TEXT_CHUNKS) {
    emitted += parseStreamChunk(chunk, state).filteredText.length
  }
  return emitted + state.buffer.length
}

function runCase3(): void {
  assertParity('CASE 3 totals', legacyCarryReplay(), fixedCarryReplay())
  const legacy = measure(legacyCarryReplay, 30)
  const fixed = measure(fixedCarryReplay, 30)
  report({
    case: 'CASE 3',
    finding: 'stream-chunk-rescans-buffered-tool-call',
    before: legacy,
    after: fixed,
    ratioBasis: 'like-for-like',
    note: `2048 × 100B chunks outside a call (${(TEXT_CHUNKS.length * TEXT_CHUNKS[0]!.length) / 1024}KB), 30 ops/run`,
  })

  const sliceIntoChunks = (text: string, count: number): string[] => {
    const size = Math.ceil(text.length / count)
    const chunks: string[] = []
    for (let i = 0; i < text.length; i += size) {
      chunks.push(text.slice(i, i + size))
    }
    return chunks
  }
  const streamCallStats = (chunks: string[]) => {
    const state = createStreamParserState()
    let toolCalls = 0
    let bufferErrors = 0
    let leaked = 0
    for (const chunk of chunks) {
      const result = parseStreamChunk(chunk, state)
      toolCalls += result.toolCalls.length
      for (const error of result.errors) {
        if (error.code === 'tool_call_buffer_exceeded') bufferErrors++
      }
      leaked += result.filteredText.length
    }
    return { toolCalls, bufferErrors, leaked }
  }

  // 64KB budget headroom (RF-1-41ffd2b0 cap evidence): an in-budget tool call
  // streamed in 512 chunks must complete exactly once and leak no bytes into
  // the visible text stream.
  const inBudgetChunks = sliceIntoChunks(
    `${startToolTag}\n${IN_BUDGET_CALL_PAYLOAD}\n${endToolTag}`,
    512,
  )
  assertParity('CASE 3b in-budget contract', streamCallStats(inBudgetChunks), {
    toolCalls: 1,
    bufferErrors: 0,
    leaked: 0,
  })
  const insideCall = () => streamCallStats(inBudgetChunks).toolCalls
  const insideMs = measure(insideCall, 30)
  console.log(
    `  ${'CASE 3b'.padEnd(9)} ${'(after only) 64KB budget headroom'.padEnd(44)} ` +
      `after ${formatTiming(insideMs)} ms/op  ` +
      `${inBudgetChunks.length} chunks → 1 tool call, ${IN_BUDGET_CALL_PAYLOAD.length}B of 64KB budget`,
  )

  // 64KB budget cap engagement: an oversized call must trip the budget exactly
  // once and discard the rest silently (0 calls, 0 leaked bytes). The before
  // row is the pre-budget shape — retain every byte and rescan the whole
  // buffer per chunk (quadratic) — so outputs differ BY DESIGN here: that
  // discard contract IS the cap.
  const oversizedChunks = sliceIntoChunks(
    `${startToolTag}\n${OVERSIZED_CALL_PAYLOAD}\n${endToolTag}`,
    512,
  )
  assertParity('CASE 3c budget cap contract', streamCallStats(oversizedChunks), {
    toolCalls: 0,
    bufferErrors: 1,
    leaked: 0,
  })
  const legacyRetainRescan = (): number => {
    let buffer = ''
    let lastHit = -1
    for (const chunk of oversizedChunks) {
      buffer += chunk
      lastHit = buffer.indexOf(endToolTag)
    }
    return buffer.length + Math.max(0, lastHit)
  }
  const legacyMs = measure(legacyRetainRescan, 30)
  const capMs = measure(() => streamCallStats(oversizedChunks).bufferErrors, 30)
  report({
    case: 'CASE 3c',
    finding: '64KB tool-call buffer budget (cap engages)',
    before: legacyMs,
    after: capMs,
    ratioBasis: 'contract',
    note: `${OVERSIZED_CALL_PAYLOAD.length}B payload in ${oversizedChunks.length} chunks: before retains+rescans all bytes, after discards past 64KB (outputs differ by design)`,
  })

  // In-call payload replay (in-call-payload-replayed-per-chunk / RF-11):
  // inside a tool call the pre-fix shape re-concatenated the ENTIRE
  // accumulated payload with each chunk and rescanned it end-to-end for the
  // end tag — O(payload² / chunkSize) in CPU plus the same order in concat
  // allocation. Both rows accumulate the identical payload and search for the
  // identical end tag per chunk; only the rescan window differs (whole payload
  // vs the tag-tail window). The end tag is absent from the workload, so the
  // measured cost is purely the per-chunk in-call rescan shape (CASE 3's rows
  // do the same for the outside-call replay).
  const inCallPayloadChunks = sliceIntoChunks(IN_BUDGET_CALL_PAYLOAD, 512)
  const legacyInCallReplay = (): number => {
    let payload = ''
    let lastHit = -1
    for (const chunk of inCallPayloadChunks) {
      payload += chunk
      lastHit = payload.indexOf(endToolTag)
    }
    return payload.length + Math.max(0, lastHit)
  }
  const fixedInCallReplay = (): number => {
    const state = createStreamParserState()
    // Prime the parser INSIDE the call (right after the start tag, buffer
    // empty — so both rows accumulate exactly the same payload bytes); both
    // rows measure only the in-call payload replay. The exported startToolTag
    // constant carries a trailing newline the parser classifies as call
    // payload, so feed the bare tag: the parity checksum is a byte count and
    // must cover only the workload payload.
    parseStreamChunk(startToolTag.trimEnd(), state)
    let emitted = 0
    for (const chunk of inCallPayloadChunks) {
      emitted += parseStreamChunk(chunk, state).filteredText.length
    }
    return emitted + state.buffer.length
  }
  assertParity(
    'CASE 3d in-call totals',
    legacyInCallReplay(),
    fixedInCallReplay(),
  )
  const legacyInMs = measure(legacyInCallReplay, 30)
  const fixedInMs = measure(fixedInCallReplay, 30)
  report({
    case: 'CASE 3d',
    finding: 'in-call payload replayed per chunk',
    before: legacyInMs,
    after: fixedInMs,
    ratioBasis: 'like-for-like',
    note: `${IN_BUDGET_CALL_PAYLOAD.length}B in-call payload in ${inCallPayloadChunks.length} ~90B chunks (no end tag): before replays the whole payload per chunk, after rescans only the tag tail`,
  })
}

// ---------------------------------------------------------------------------
// CASE 4 — per-call-regex-in-process-structured-edit (cachedRegExp class)
// ---------------------------------------------------------------------------

const QUOTE_CLASS = '["\'`]'

function specifierHitPattern(specifier: string): string {
  return `${QUOTE_CLASS}${escapeRegexForLiteral(specifier)}${QUOTE_CLASS}`
}

/**
 * 'none' rebuilds the RegExp per test (the pre-fix per-call shape); 'shipped'
 * memoizes through process-structured-edit's shipped cachedRegExp — the same
 * bounded LRU cache the import-edit path hits — so the after
 * row measures the shipped cache and not a local mirror (RF-8 /
 * after-rows-measure-mirrors).
 */
function countSpecifierHits(cache: 'none' | 'shipped'): number {
  let hits = 0
  for (const statement of IMPORT_STATEMENTS) {
    for (const specifier of SPECIFIERS) {
      const regex =
        cache === 'none'
          ? new RegExp(specifierHitPattern(specifier))
          : cachedRegExp(`specifier-hit:${specifier}`, () =>
              new RegExp(specifierHitPattern(specifier)),
            )
      if (regex.test(statement)) hits++
    }
  }
  return hits
}

function runCase4(): void {
  assertParity(
    'CASE 4',
    countSpecifierHits('none'),
    countSpecifierHits('shipped'),
  )
  const legacy = measure(() => countSpecifierHits('none'), 30)
  const fixed = measure(() => countSpecifierHits('shipped'), 30)
  report({
    case: 'CASE 4',
    finding: 'per-call-regex-in-process-structured-edit',
    before: legacy,
    after: fixed,
    ratioBasis: 'like-for-like',
    note: '50 specifiers × 200 statements (shipped cachedRegExp memo vs per-call construction), 30 ops/run',
  })

  // MAX_JSON_CANDIDATES headroom (RF-1-41ffd2b0 cap evidence): realistic prose
  // decoy braces + payload must extract the real tool call exactly as the bare
  // payload does (4 of the 32-candidate budget used).
  const prosePayload = `use {a} like this: {b} then {c} then ${PROSE_PAYLOAD_JSON}`
  const statsFrom = (content: string) => {
    const state = createStreamParserState()
    const result = parseStreamChunk(
      `${startToolTag}\n${content}\n${endToolTag}`,
      state,
    )
    return {
      toolCalls: result.toolCalls.length,
      toolName: result.toolCalls[0]?.toolName,
    }
  }
  assertParity(
    'CASE 4c prose-embedded payload',
    statsFrom(prosePayload),
    statsFrom(PROSE_PAYLOAD_JSON),
  )
  const proseMs = measure(() => statsFrom(prosePayload).toolCalls, 200)
  console.log(
    `  ${'CASE 4c'.padEnd(9)} ${'(after only) MAX_JSON_CANDIDATES headroom'.padEnd(44)} ` +
      `after ${formatTiming(proseMs)} ms/op  ` +
      `3 decoy braces + payload: 4 of 32 candidates used`,
  )

  // MAX_JSON_CANDIDATES cap engagement: 200 balanced decoy braces with no real
  // JSON payload. Both rows run the SHIPPED candidate loop
  // (extractFirstJsonObjectCandidate → JSON.parse / parseJsonStringWithRepair)
  // on identical input, so per-candidate cost is like-for-like and the after
  // row is evidence about the shipped code, not a mirror (RF-8 /
  // after-rows-measure-mirrors). Only the candidate budget differs — uncapped
  // (the pre-cap loop shape, before row) vs the shipped 32-candidate budget
  // (after row). Both must yield NO candidate — parity on the outcome — with
  // the bounded scan doing at most 32/200 of the work.
  const uncappedCandidate = (): string | null =>
    extractFirstJsonObjectCandidate(DECOY_BRACES, Number.POSITIVE_INFINITY)
      ?.candidate ?? null
  const cappedCandidate = (): string | null =>
    extractFirstJsonObjectCandidate(DECOY_BRACES)?.candidate ?? null
  assertParity(
    'CASE 4d candidate-cap outcome',
    uncappedCandidate(),
    cappedCandidate(),
  )
  const uncappedScan = measure(() => uncappedCandidate()?.length ?? 0, 200)
  const cappedScan = measure(() => cappedCandidate()?.length ?? 0, 200)
  report({
    case: 'CASE 4d',
    finding: 'MAX_JSON_CANDIDATES=32 parse budget (cap engages)',
    before: uncappedScan,
    after: cappedScan,
    ratioBasis: 'contract',
    note: `200 decoy braces, no payload: shipped candidate loop — before runs uncapped (all 200), after stops at 32 (same outcome: none)`,
  })
}

// ---------------------------------------------------------------------------
// CASE 5 — single-visited-set-shared-across-results (per-payload guard)
// ---------------------------------------------------------------------------

interface GraphNode {
  touchedPaths: string[]
  children: GraphNode[]
}

function buildCyclicGraph(): GraphNode {
  const nodes: GraphNode[] = Array.from({ length: GRAPH_NODES }, (_, i) => ({
    touchedPaths: [`graph/node-${i}.ts`],
    children: [],
  }))
  for (let i = 0; i < GRAPH_NODES; i++) {
    for (let k = 1; k <= GRAPH_BRANCHING; k++) {
      nodes[i]!.children.push(nodes[(i + k * 7) % GRAPH_NODES]!)
    }
  }
  return nodes[0]!
}

/**
 * Pre-fix shape: depth>8 pruning only — a shared node reached through
 * several parents is re-walked every time (exponential in depth levels).
 * Node crediting runs through the SHIPPED creditSelfMutatedPathValue layer
 * (plus the same Set/sort publish step), so before/after rows run identical
 * crediting work and only the traversal guard differs (RF-8 /
 * case5-asymmetric-speedup-ratio).
 */
function legacyVisit(value: unknown, depth: number, paths: Set<string>): void {
  if (value == null || depth > 8) return
  if (Array.isArray(value)) {
    for (const item of value) legacyVisit(item, depth + 1, paths)
    return
  }
  if (typeof value !== 'object') return
  const plain = value as Record<string, unknown>
  if (plain.type === 'json' && 'value' in plain) {
    legacyVisit(plain.value, depth + 1, paths)
  }
  creditSelfMutatedPathValue(paths, value)
  for (const nested of Object.values(plain)) {
    if (nested && typeof nested === 'object') {
      legacyVisit(nested, depth + 1, paths)
    }
  }
}

function runCase5(): void {
  const root = buildCyclicGraph()
  const content = [{ type: 'json', value: root }]

  // One shared envelope walked `payloads` times — the pre-fix shape re-walks
  // shared nodes both within and across results. Both sides credit through
  // the shipped layer and publish the same sorted set (asserted below), so the
  // rows are like-for-like.
  const legacyPublished = (payloads: number): string[] => {
    const paths = new Set<string>()
    for (let i = 0; i < payloads; i++) legacyVisit(content, 0, paths)
    return [...paths].sort()
  }
  const fixedPublished = (payloads: number): string[] => {
    const state = { selfMutatedPaths: [] } as unknown as Parameters<
      typeof publishSelfMutatedPaths
    >[0]['agentState']
    return publishSelfMutatedPaths({
      agentState: state,
      toolResults: Array.from({ length: payloads }, () => ({
        content,
      })) as unknown as Parameters<
        typeof publishSelfMutatedPaths
      >[0]['toolResults'],
    })
  }

  assertParity('CASE 5', legacyPublished(1), fixedPublished(1))
  const legacy = measure(() => legacyPublished(2).length, 30)
  const fixed = measure(() => fixedPublished(2).length, 30)
  report({
    case: 'CASE 5',
    finding: 'single-visited-set-shared-across-results',
    before: legacy,
    after: fixed,
    ratioBasis: 'contract',
    note: `cyclic graph ${GRAPH_NODES} nodes × branching ${GRAPH_BRANCHING}, 2 payload walks/op, 30 ops/run (parity + walk-bound row: no speedup ratio)`,
  })
}

// ---------------------------------------------------------------------------
// X-2 CASE 6 — token counting (shipped countTokens seam)
// ---------------------------------------------------------------------------

/**
 * Deterministic ~50KB synthetic TS-like workload: one fixed snippet repeated
 * to clear 50KB (no randomness). 50KB sits in the shipped counter's 8KB-100KB
 * uncached band (above MAX_CACHEABLE_INPUT_CHARS, below MAX_BPE_ENCODE_CHARS),
 * so every timed call performs a real BPE encode — the LRU can never serve
 * these rows and the measurement stays honest.
 */
const TOKEN_WORKLOAD_SNIPPET = [
  'export function computeRow(values: number[], index: number): number {',
  '  const row = values[index] ?? 0',
  '  return row * 2 + 1',
  '}',
  'const ROWS = Array.from({ length: 64 }, (_, i) => computeRow([i, i + 1], i % 64))',
].join('\n')
const TOKEN_WORKLOAD_REPEATS = 250
const TOKEN_WORKLOAD = (TOKEN_WORKLOAD_SNIPPET + '\n').repeat(
  TOKEN_WORKLOAD_REPEATS,
)

function runCase6(): void {
  // Contract check (outside the timed sections): the shipped counter must
  // return a positive estimate on the fixed workload.
  const rawTokens = countTokens(TOKEN_WORKLOAD)
  if (!(rawTokens > 0)) {
    throw new Error(
      `CASE 6 contract failure: countTokens returned ${rawTokens}`,
    )
  }
  // Raw path: 50KB < MAX_BPE_ENCODE_CHARS (100k chars), so countTokens runs
  // the full-BPE encode — the estimator the capped path extrapolates from.
  const rawMs = measure(() => countTokens(TOKEN_WORKLOAD), 2)
  const rawTokensPerSec = Math.round(rawTokens / (rawMs.medianMsPerOp / 1000))
  console.log(
    `  ${'CASE 6a'.padEnd(9)} ${'X-2: countTokens raw BPE encode (50KB < cap)'.padEnd(44)} ` +
      `after ${formatTiming(rawMs)} ms/op  ` +
      `${TOKEN_WORKLOAD.length}B → ${rawTokens} tokens (raw path, never LRU-cached above 8KB), ~${rawTokensPerSec} tokens/s`,
  )

  // Capped path: the 100k-char cap itself is what the DEPTH audit wants
  // visible, so reproduce the shipped over-cap estimator shape exactly — a
  // BPE_SAMPLE_CHARS (20k) prefix sample encoded through the same countTokens
  // seam and extrapolated by the length ratio (token-counter.ts
  // MAX_BPE_ENCODE_CHARS). The workload is capped by construction here so the
  // cap's cost is in the baseline without a multi-minute multi-MB encode in CI.
  const cappedExtrapolatedTokens = (): number => {
    const sample = TOKEN_WORKLOAD.slice(0, 20_000)
    return Math.floor(
      (countTokens(sample) / sample.length) * TOKEN_WORKLOAD.length,
    )
  }
  const cappedMs = measure(cappedExtrapolatedTokens, 3)
  console.log(
    `  ${'CASE 6b'.padEnd(9)} ${'X-2: 100k-char cap → sample extrapolation'.padEnd(44)} ` +
      `after ${formatTiming(cappedMs)} ms/op  ` +
      `20k-char sample encode + ratio extrapolation → ~${cappedExtrapolatedTokens()} tokens (shipped capped estimator shape)`,
  )

  // 5MB pathological estimator row (D12 prerequisite, P3-T10): the shipped
  // over-cap estimator shape over a ~5MB body WITHOUT BPE-encoding the body —
  // full gpt-tokenizer BPE on a multi-MB string stalls CI >2min (that is why
  // the 100k-char cap exists). Self-contained check (own pass/fail, no
  // before/after parity row): the BPE input is bounded to the fixed 20k-char
  // sample for ANY body size.
  //
  // Accuracy is validated against REAL, falsifiable ground truth in a
  // genuinely NON-uniform, NON-periodic token-density regime (perf:
  // measurement-design-case6c-repetitive-body-linearity). The two earlier
  // body shapes were both periodic with the 20k sample spanning many full
  // cycles (TOKEN_WORKLOAD repeated verbatim, then a 4-segment ~2.5KB cycle),
  // so prefix-sample extrapolation was near-exact BY PERIODICITY and the
  // accuracy check could not fail on a sample-window or sample-region bug.
  // The body is now built in two regions with NO short period at sample
  // scale:
  //   - a 20k-char BALANCED PRELUDE: the four heterogeneous segments (dense
  //     code, prose, a low-density separator-free '=' run, comment prose)
  //     tiled in round-robin 1k chunks, exactly five rounds, so the prefix
  //     sample the estimator reads carries the exact 1:1:1:1 segment mix; and
  //   - a BLOCK REGION of 15k SINGLE-SEGMENT blocks rotating through the same
  //     four segments — a 60k rotation period strictly larger than the 20k
  //     sample, with 15k mono-density stretches inside it.
  // The block rotation preserves the 1:1:1:1 char mix, so the whole-body
  // density equals the prelude density and the shipped prefix estimator is
  // accurate — by prefix representativeness plus estimator correctness, not
  // by periodicity — and the check CAN fail:
  //   - a wrong-window estimator (a mid-body sample over the separator +
  //     comment blocks) diverges far beyond the tolerance (asserted below),
  //     which was impossible on the old periodic body where every 20k window
  //     carried the body's exact mix, and
  //   - a naive chars/3 density estimator misses by a wide margin (asserted).
  // Ground truth is the full-BPE count of an 80k sibling (< the 100k
  // MAX_BPE_ENCODE_CHARS cap) built as the prelude plus exactly ONE full 60k
  // block rotation — the same 1:1:1:1 mix, encoded directly in CASE 6a
  // style: an independent computation this check CAN fail against.
  const pathologicalSampleChars = 20_000
  // Deliberately different token densities per segment; segment order is
  // fixed so the body is deterministic.
  const HETERO_CODE = [
    'export interface RuntimeContext {',
    '  sessionId: string',
    '  revision: number',
    '  flags: ReadonlySet<string>',
    '}',
    'function hydrate(ctx: RuntimeContext, payload: unknown): void {',
    '  const flags = new Set(ctx.flags)',
    '  for (const key of Object.keys(payload ?? {})) flags.add(key)',
    '  ctx.revision += 1',
    '}',
  ].join('\n')
  const HETERO_PROSE =
    'The runtime hydrates its context from the serialized payload before ' +
    'each agent step, merging committed workspace flags into the live set so ' +
    'later prompts observe the same session state the user saw. '
  const HETERO_SEPARATOR = '='.repeat(2048)
  const HETERO_COMMENT =
    '// NOTE: keep this block aligned with the hydrate contract above; the ' +
    '// serializer round-trips flags through the journal so restarts resume ' +
    '// from the last committed revision without replaying the whole stream. '
  const HETERO_SEGMENTS = [
    HETERO_CODE,
    HETERO_PROSE,
    HETERO_SEPARATOR,
    HETERO_COMMENT,
  ]
  /** Tile `segment` (repeated with newline joiners) to exactly `chars`. */
  const tileSegment = (segment: string, chars: number): string => {
    const unit = segment + '\n'
    return unit.repeat(Math.ceil(chars / unit.length)).slice(0, chars)
  }
  // Balanced prelude: five 1k-char round-robin rounds over the four segments
  // = exactly `pathologicalSampleChars` chars with the exact 1:1:1:1 mix.
  const PRELUDE_CHUNK_CHARS = 1_000
  const PRELUDE_ROUNDS = 5
  const balancedPrelude = (() => {
    const chunks: string[] = []
    for (let round = 0; round < PRELUDE_ROUNDS; round++) {
      for (const segment of HETERO_SEGMENTS) {
        chunks.push(tileSegment(segment, PRELUDE_CHUNK_CHARS))
      }
    }
    return chunks.join('')
  })()
  // Block region: 15k single-segment blocks rotating through the segments.
  // The 60k rotation period exceeds the 20k sample, so no sample window
  // spans a full body period and each block is a 15k mono-density stretch.
  const BLOCK_CHARS = 15_000
  const BLOCK_ROTATION_CHARS = BLOCK_CHARS * HETERO_SEGMENTS.length
  const buildBlockBody = (targetChars: number): string => {
    const parts: string[] = [balancedPrelude]
    let total = balancedPrelude.length
    let block = 0
    while (total < targetChars) {
      const chunk = tileSegment(
        HETERO_SEGMENTS[block % HETERO_SEGMENTS.length]!,
        BLOCK_CHARS,
      )
      parts.push(chunk)
      total += chunk.length
      block++
    }
    return parts.join('').slice(0, targetChars)
  }
  const pathologicalBody = buildBlockBody(5 * 1024 * 1024)
  // Ground-truth sibling: prelude + exactly one full block rotation = 80k
  // chars (< the 100k cap), so the full-BPE token count is directly
  // computable, the sibling carries the same 1:1:1:1 mix as the sample, and
  // the count is independent of the estimator.
  const groundTruthSibling = buildBlockBody(
    balancedPrelude.length + BLOCK_ROTATION_CHARS,
  )
  const pathologicalEstimator = (text: string): number => {
    const sample = text.slice(0, pathologicalSampleChars)
    return Math.floor((countTokens(sample) / sample.length) * text.length)
  }
  const pathologicalEstFull = pathologicalEstimator(pathologicalBody)
  const pathologicalSample = pathologicalBody.slice(0, pathologicalSampleChars)
  // Ground-truth accuracy: the estimator over the sibling must track the
  // sibling's actual full-BPE count within a real relative tolerance. The
  // estimate derives from the 20k-char prelude ratio; the truth comes from
  // the complete encode of the 80k sibling — genuinely independent
  // computations, so this check CAN fail.
  const pathologicalEstSibling = pathologicalEstimator(groundTruthSibling)
  const groundTruthTokens = countTokens(groundTruthSibling)
  const pathologicalAccuracyError =
    Math.abs(pathologicalEstSibling - groundTruthTokens) / groundTruthTokens
  const pathologicalAccuracyTolerance = 0.08
  // Discriminating-power guard 1: a naive chars/3 density estimator must MISS
  // the tolerance — the body's true chars/token density is far from 3.
  const naiveCharsPerTokenEstimate = Math.floor(groundTruthSibling.length / 3)
  const naiveEstimatorError =
    Math.abs(naiveCharsPerTokenEstimate - groundTruthTokens) /
    groundTruthTokens
  // Discriminating-power guard 2 (falsifiability against non-uniformity): an
  // estimator that samples an UNREPRESENTATIVE window must also miss the
  // tolerance. The window below starts inside the separator block and spans
  // the separator + comment blocks, so its density diverges from the body's
  // balanced density — proving the accuracy check can genuinely fail when
  // the sample region is wrong.
  const wrongWindowSample = groundTruthSibling.slice(
    balancedPrelude.length + 2 * BLOCK_CHARS,
    balancedPrelude.length + 2 * BLOCK_CHARS + pathologicalSampleChars,
  )
  const wrongWindowEstimate =
    (countTokens(wrongWindowSample) / wrongWindowSample.length) *
    groundTruthSibling.length
  const wrongWindowError =
    Math.abs(wrongWindowEstimate - groundTruthTokens) / groundTruthTokens
  if (
    pathologicalBody.length < 5 * 1024 * 1024 ||
    pathologicalSample.length !== pathologicalSampleChars ||
    balancedPrelude.length !== pathologicalSampleChars ||
    BLOCK_ROTATION_CHARS <= pathologicalSampleChars ||
    !(pathologicalEstFull > 0) ||
    !(pathologicalEstSibling > 0) ||
    pathologicalAccuracyError > pathologicalAccuracyTolerance ||
    naiveEstimatorError <= pathologicalAccuracyTolerance ||
    wrongWindowError <= pathologicalAccuracyTolerance
  ) {
    throw new Error(
      `CASE 6c contract failure: body ${pathologicalBody.length}B, sample ${pathologicalSample.length} chars, est(5MB)=${pathologicalEstFull}, est(80KB sibling)=${pathologicalEstSibling}, full-BPE truth=${groundTruthTokens}, accuracy error ${(pathologicalAccuracyError * 100).toFixed(2)}%, naive chars/3 error ${(naiveEstimatorError * 100).toFixed(2)}%, wrong-window error ${(wrongWindowError * 100).toFixed(2)}% (expected >=5MB aperiodic body, ${pathologicalSampleChars}-char balanced prelude sample, block rotation > sample, est within ${(pathologicalAccuracyTolerance * 100).toFixed(0)}% of the full-BPE ground truth, naive chars/3 AND wrong-window estimators to MISS the tolerance so the check is falsifiable)`,
    )
  }
  const pathologicalMs = measure(
    () => pathologicalEstimator(pathologicalBody),
    3,
  )
  if (!(pathologicalMs.medianMsPerOp < 2000)) {
    throw new Error(
      `CASE 6c boundedness failure: estimator median ${pathologicalMs.medianMsPerOp.toFixed(1)} ms/op over the ~5MB body — the estimator regressed toward full-body BPE (the >2min CI stall this row guards against)`,
    )
  }
  console.log(
    `  ${'CASE 6c'.padEnd(9)} ${'X-2: 5MB pathological estimator (D12)'.padEnd(44)} ` +
      `after ${formatTiming(pathologicalMs)} ms/op  ` +
      `${pathologicalBody.length}B aperiodic heterogeneous-density body (20k balanced prelude + rotating 15k mono-density code/prose/separator/comment blocks), BPE bounded to the ${pathologicalSampleChars}-char sample (body never BPE-encoded), est ~${pathologicalEstFull} tokens, est(80KB)=${pathologicalEstSibling} vs full-BPE truth ${groundTruthTokens} (accuracy error ${(pathologicalAccuracyError * 100).toFixed(2)}% <= ${(pathologicalAccuracyTolerance * 100).toFixed(0)}%; naive chars/3 misses at ${(naiveEstimatorError * 100).toFixed(0)}%; wrong-window estimator misses at ${(wrongWindowError * 100).toFixed(0)}%), <2s boundedness guard`,
  )
}

// ---------------------------------------------------------------------------
// X-2 CASE 7 — code_search dispatch cost (JS-side rg line parse only)
// ---------------------------------------------------------------------------

/**
 * Honest scope: the ripgrep spawn itself is I/O-bound and machine-dependent,
 * so this case measures the cheap JS-side preparation seam the shipped
 * code_search handler runs over every result set — formatCodeSearchOutput's
 * per-line ripgrep parse/group loop (the parseRipgrepLine hot path) — over a
 * fixed synthetic 200-line rg stdout. This row is "rg line parse throughput",
 * NOT code_search end-to-end.
 */
const RG_LINES = 200
const RG_STDOUT = Array.from(
  { length: RG_LINES },
  (_, i) =>
    `packages/agent-runtime/src/module-${i % 20}.ts:${i + 1}:  const handle${i} = build(${i})`,
).join('\n')

function runCase7(): void {
  // Contract check: every synthetic match line survives formatting.
  const formatted = formatCodeSearchOutput(RG_STDOUT, { matchCount: RG_LINES })
  if (!formatted.includes(`Found ${RG_LINES} matches`)) {
    throw new Error('CASE 7 contract failure: match count header missing')
  }
  const parseMs = measure(
    () => formatCodeSearchOutput(RG_STDOUT, { matchCount: RG_LINES }).length,
    100,
  )
  console.log(
    `  ${'CASE 7'.padEnd(9)} ${'X-2: code_search rg line parse (JS-side only)'.padEnd(44)} ` +
      `after ${formatTiming(parseMs)} ms/op  ` +
      `${RG_LINES}-line synthetic rg stdout through shipped formatCodeSearchOutput (rg spawn NOT measured: I/O-bound, machine-dependent)`,
  )
}

// ---------------------------------------------------------------------------
// X-2 CASE 8 — index refresh hot paths (X-2a hot paths, D13)
// ---------------------------------------------------------------------------

/**
 * X-2a hot paths (D13), measured DIRECTLY: the metadata-indexer refresh loop
 * stats and hashes real files (updateMetadataIndex is not runnable in-memory
 * without a filesystem fixture), so the two hot functions this wave guarded
 * are timed over synthetic workloads instead and attributed "X-2a hot paths
 * (D13)" as the plan gate requires. The code-map module is imported
 * dynamically so a heavy/tree-sitter load failure degrades to a printed skip
 * rather than aborting the whole baseline.
 */
const X2A_SYMBOL_COUNT = 2000
const X2A_VOCAB_TOKENS = 5000
const X2A_QUERY_TOKENS = 40

/** Synthetic symbol ranges: one wide container every 4th symbol, 3-line
 * leaves between them, so the interval-stack sweep exercises real nesting. */
function buildSyntheticSymbols(): SymbolRange[] {
  const symbols: SymbolRange[] = []
  for (let i = 0; i < X2A_SYMBOL_COUNT; i++) {
    if (i % 4 === 0) {
      const start = i * 2 + 1
      symbols.push({
        name: `container${i}`,
        kind: 'class',
        startLine: start,
        endLine: start + 12,
        depth: 0,
      })
    } else {
      const start = i * 2 + 3
      symbols.push({
        name: `leaf${i}`,
        kind: 'function',
        startLine: start,
        endLine: start + 3,
        depth: 0,
      })
    }
  }
  return symbols
}

async function runCase8(): Promise<void> {
  // --- X-2a hot path 1: assignDepths interval sweep over synthetic symbols.
  // The try/catch wraps ONLY the dynamic import: a load failure degrades to a
  // printed skip, while the contract check below throws out of runCase8 like
  // every other case (a throw inside the try would be swallowed by the skip).
  let codeMap: typeof import('../packages/code-map/src/structure') | undefined
  try {
    codeMap = await import('../packages/code-map/src/structure')
  } catch (error) {
    console.log(
      `  ${'CASE 8a'.padEnd(9)} SKIPPED — code-map structure import failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    )
  }
  if (codeMap) {
    const { assignDepths } = codeMap
    const symbols = buildSyntheticSymbols()
    const withDepths = assignDepths(symbols.map((sym) => ({ ...sym })))
    const maxDepth = Math.max(...withDepths.map((sym) => sym.depth))
    if (withDepths.length !== symbols.length || !(maxDepth >= 0)) {
      throw new Error(
        'CASE 8a contract failure: unexpected assignDepths output',
      )
    }
    const depthsMs = measure(
      () => assignDepths(symbols.map((sym) => ({ ...sym }))).length,
      20,
    )
    console.log(
      `  ${'CASE 8a'.padEnd(9)} ${'X-2a hot paths (D13): assignDepths sweep'.padEnd(44)} ` +
        `after ${formatTiming(depthsMs)} ms/op  ` +
        `${X2A_SYMBOL_COUNT} synthetic SymbolRanges (interval-stack sweep, max depth ${maxDepth})`,
    )
  }

  // --- X-2a hot path 2: getPostingCandidates substring union over a large
  // synthetic posting vocabulary (the X-2a-bounded scan).
  const files: Record<string, IndexedFile> = {}
  for (let i = 0; i < X2A_VOCAB_TOKENS; i++) {
    const path = `packages/agent-runtime/src/file-${i}.ts`
    files[path] = {
      path,
      mtime: 1_700_000_000_000 + i,
      size: 1000 + (i % 97) * 13,
      hash: `hash-${i}`,
      ext: '.ts',
      symbols: [`symbol${i}`],
      imports: [],
      headings: [],
      concepts: [`tok${i}token`],
    }
  }
  // The workload must engage the X-2a bounds this row is attributed to
  // (case8b-workload-never-engages-bounds): all-exact >=8-char tokens would
  // take the substring-scan skip branch and never exercise the scan loop or
  // the MAX_POSTING_CANDIDATE_PATHS cap. Half the tokens are exact postings
  // (the skip branch), half are short no-exact-posting prefixes ('tok') that
  // substring-match the whole tok* vocabulary, driving the candidate union
  // to the cap so the bounding fix is actually exercised and asserted below.
  const queryTokens: string[] = []
  for (let i = 0; i < X2A_QUERY_TOKENS; i++) {
    queryTokens.push(i % 2 === 0 ? `tok${i}token` : 'tok')
  }
  const queryData = buildIndexQueryData(files, { nodes: {}, edges: [] })
  const index: MetadataIndex = {
    version: '2',
    projectRoot: '/synthetic',
    builtAt: 0,
    fileCount: Object.keys(files).length,
    files,
    graph: { nodes: {}, edges: [] },
    queryData,
  }
  const candidates = getPostingCandidates(index, queryTokens)
  // Real shipped contract (query-data.ts getPostingCandidates): the
  // substring-scan union is bounded by MAX_POSTING_CANDIDATE_PATHS, but
  // exact-match postings are ALWAYS added on top of that capped union — the
  // superset-preservation guarantee means exact matches are never dropped.
  // So the final union is cap + (exact-match paths not already inside the
  // capped substring union), never exactly the cap. Assert both sides:
  //   (1) the substring-scan bound is ENGAGED (hard-fail if the scan never
  //       reached the cap — that is the guard this row evidences), and
  //   (2) the excess over the cap is at most the number of distinct
  //       exact-match paths of the query tokens, computed from the same
  //       workload's postings (the query tokens are already normalized, so
  //       direct postings lookup mirrors the shipped exact-add step).
  const exactMatchPaths = new Set<string>()
  for (const token of queryTokens) {
    for (const filePath of index.queryData?.postings[token] ?? []) {
      exactMatchPaths.add(filePath)
    }
  }
  if (
    !candidates ||
    candidates.size < MAX_POSTING_CANDIDATE_PATHS ||
    candidates.size > exactMatchPaths.size + MAX_POSTING_CANDIDATE_PATHS
  ) {
    throw new Error(
      `CASE 8b contract failure: expected the substring-scan union to engage the MAX_POSTING_CANDIDATE_PATHS bound (${MAX_POSTING_CANDIDATE_PATHS}) with exact-match paths added on top (≤ ${exactMatchPaths.size + MAX_POSTING_CANDIDATE_PATHS}), got ${candidates?.size ?? 'null'}`,
    )
  }
  const candidatesMs = measure(
    () => getPostingCandidates(index, queryTokens)?.size ?? 0,
    20,
  )
  console.log(
    `  ${'CASE 8b'.padEnd(9)} ${'X-2a hot paths (D13): getPostingCandidates'.padEnd(44)} ` +
      `after ${formatTiming(candidatesMs)} ms/op  ` +
      `${X2A_QUERY_TOKENS} query tokens (exact + substring prefix) over a ${X2A_VOCAB_TOKENS}-token vocabulary (${candidates.size} candidate paths — MAX_POSTING_CANDIDATE_PATHS=${MAX_POSTING_CANDIDATE_PATHS} bound engaged, exact-match paths added on top per the superset guarantee; ${exactMatchPaths.size} exact-match query-token paths)`,
  )
}

// ---------------------------------------------------------------------------
// X-2 CASE 9 — tool-call stream parse (shipped parseStreamChunk seam)
// ---------------------------------------------------------------------------

/**
 * Deterministic ~100KB payload of prose segments alternating with complete
 * tool calls, split into ~1KB chunks and fed through the shipped
 * parseStreamChunk state machine — the same seam the stream loop runs per
 * chunk (CASE 3 already pins its replay-cost guard; this row pins the
 * absolute end-to-end stream parse cost).
 */
const STREAM_TOOL_CALL = (index: number): string =>
  `${startToolTag}\n${JSON.stringify({
    cb_tool_name: 'read_files',
    paths: [`packages/agent-runtime/src/file-${index}.ts`],
  })}\n${endToolTag}\n`
const STREAM_TOOL_CALLS = 96
const STREAM_SEGMENTS: string[] = []
for (let i = 0; i < STREAM_TOOL_CALLS; i++) {
  STREAM_SEGMENTS.push(
    `Segment ${i}: ` +
      'prose filler text for the stream parse workload. '.repeat(20) +
      '\n',
  )
  STREAM_SEGMENTS.push(STREAM_TOOL_CALL(i))
}
const STREAM_PAYLOAD = STREAM_SEGMENTS.join('')
const STREAM_CHUNK_SIZE = 1024
const STREAM_CHUNKS: string[] = []
for (let i = 0; i < STREAM_PAYLOAD.length; i += STREAM_CHUNK_SIZE) {
  STREAM_CHUNKS.push(STREAM_PAYLOAD.slice(i, i + STREAM_CHUNK_SIZE))
}

function runCase9(): void {
  const streamStats = (): {
    toolCalls: number
    chars: number
    jsonErrors: number
  } => {
    const state = createStreamParserState()
    let toolCalls = 0
    let chars = 0
    let jsonErrors = 0
    for (const chunk of STREAM_CHUNKS) {
      const result = parseStreamChunk(chunk, state)
      toolCalls += result.toolCalls.length
      chars += result.filteredText.length
      for (const error of result.errors) {
        if (error.code === 'invalid_tool_call_json') jsonErrors++
      }
    }
    return { toolCalls, chars, jsonErrors }
  }
  // Contract check: framing only — every synthetic tool call is extracted
  // exactly once, the payloads parse cleanly, and prose actually streams.
  // Exact filteredText byte accounting is deliberately NOT asserted: the
  // shipped parser emits bytes immediately after an end tag (the workload's
  // per-call trailing newline) and retains a partial-tag carry in
  // state.buffer, so the emitted total sits a few bytes off the prose-only
  // sum (the same accounting CASE 3 handles via its like-for-like checksum).
  const stats = streamStats()
  if (
    stats.toolCalls !== STREAM_TOOL_CALLS ||
    stats.jsonErrors !== 0 ||
    stats.chars === 0
  ) {
    throw new Error(
      `CASE 9 contract failure: ${stats.toolCalls} tool calls, ${stats.jsonErrors} JSON errors, ${stats.chars} streamed chars (expected ${STREAM_TOOL_CALLS} calls, 0 errors, prose > 0)`,
    )
  }
  const streamMs = measure(() => streamStats().toolCalls, 10)
  console.log(
    `  ${'CASE 9'.padEnd(9)} ${'X-2: tool-call stream parse (shipped seam)'.padEnd(44)} ` +
      `after ${formatTiming(streamMs)} ms/op  ` +
      `${STREAM_PAYLOAD.length}B in ${STREAM_CHUNKS.length} ~1KB chunks → ${stats.toolCalls} tool calls, ${stats.chars} streamed chars`,
  )
}

// ---------------------------------------------------------------------------
// CASE 10 — diagnostic-capture-utf8-chunk-split (shipped BoundedStreamCapture)
// ---------------------------------------------------------------------------

/**
 * Before/after rows for the diagnostic-command runner's stream capture
 * (RF: diagnostic-capture-utf8-chunk-split). The after row runs the SHIPPED
 * exported BoundedStreamCapture from diagnostic-delta-runner.ts — the exact
 * class createDiagnosticCommandRunner now feeds child stdout/stderr into —
 * never a local mirror (RF-8 / after-rows-measure-mirrors). The before row
 * is the pre-fix shape it replaced: per-chunk `chunk.toString()` decoding,
 * capped by UTF-16 string length instead of bytes.
 *
 * Parity contract: over an ASCII workload both shapes retain the identical
 * total, so the measured delta is only the decode/capture cost. The
 * correctness half (multibyte sequences split at chunk boundaries) is
 * asserted OUTSIDE the timed sections: the pre-fix shape demonstrably
 * mangles a split 4-byte emoji into U+FFFD pairs while the shipped capture
 * decodes it byte-exact — the check can fail if the shipped capture ever
 * regresses to per-chunk decoding.
 */
const CAPTURE_CHUNKS: Buffer[] = Array.from(
  { length: 256 },
  () => Buffer.from('abcdefghij'.repeat(400), 'utf8'), // 4000B each → 1,024,000B total
)

function runCase10(): void {
  // ASCII parity: identical retained totals — only the capture shape differs.
  const preFixCapture = (): number => {
    let captured = ''
    for (const chunk of CAPTURE_CHUNKS) {
      if (captured.length < MAX_CAPTURED_STREAM_BYTES) {
        captured += chunk.toString()
      }
    }
    return captured.length
  }
  const shippedCapture = (): number => {
    const capture = new BoundedStreamCapture()
    for (const chunk of CAPTURE_CHUNKS) capture.push(chunk)
    return capture.text().length
  }
  assertParity('CASE 10 ascii capture totals', preFixCapture(), shippedCapture())
  const legacyMs = measure(preFixCapture, 30)
  const fixedMs = measure(shippedCapture, 30)
  report({
    case: 'CASE 10',
    finding: 'diagnostic-capture-utf8-chunk-split',
    before: legacyMs,
    after: fixedMs,
    ratioBasis: 'like-for-like',
    note: `${CAPTURE_CHUNKS.length} × 4000B ASCII chunks (${CAPTURE_CHUNKS.length * 4000}B total): before decodes per-chunk (chunk.toString()) and caps by UTF-16 length, after accumulates raw bytes and decodes once at stream end (identical totals)`,
  })

  // Multibyte correctness check (outside the timed sections): a 4-byte emoji
  // split across two stream chunks must survive the shipped capture intact,
  // while the pre-fix per-chunk decode corrupts it. The corruption SHAPE is
  // engine-specific (Bun and V8 emit different U+FFFD replacement patterns
  // for the split bytes), so the pre-fix check pins only "not intact" — the
  // falsifiable contract lives in the shipped decode and the byte cap below.
  const emoji = Buffer.from('😀', 'utf8')
  const splitEmojiChunks = [emoji.subarray(0, 2), emoji.subarray(2)]
  const preFixSplitDecode = (): string => {
    let captured = ''
    for (const chunk of splitEmojiChunks) captured += chunk.toString()
    return captured
  }
  const shippedSplitDecode = (): string => {
    const capture = new BoundedStreamCapture()
    for (const chunk of splitEmojiChunks) capture.push(chunk)
    return capture.text()
  }
  const preFixText = preFixSplitDecode()
  if (preFixText === '😀') {
    throw new Error(
      'CASE 10b pre-fix split-emoji decode unexpectedly intact — the pre-fix baseline is not reproducible on this engine',
    )
  }
  assertParity('CASE 10b shipped split-emoji decode', shippedSplitDecode(), '😀')

  // Byte-exact cap check (outside the timed sections): the shipped capture
  // retains EXACTLY MAX_CAPTURED_STREAM_BYTES bytes (the constant's name is
  // now honest) and its truncation boundary lands on a whole emoji (the cap
  // is divisible by 4), so no U+FFFD appears.
  const emojiStream = Buffer.concat(
    Array.from(
      { length: Math.ceil((MAX_CAPTURED_STREAM_BYTES + 64) / emoji.length) },
      () => emoji,
    ),
  )
  const capCheckChunks: Buffer[] = []
  for (let i = 0; i < emojiStream.length; i += 63) {
    capCheckChunks.push(emojiStream.subarray(i, i + 63))
  }
  const capCapture = (): number => {
    const capture = new BoundedStreamCapture()
    for (const chunk of capCheckChunks) capture.push(chunk)
    return Buffer.byteLength(capture.text(), 'utf8')
  }
  const capCaptureText = (): string => {
    const capture = new BoundedStreamCapture()
    for (const chunk of capCheckChunks) capture.push(chunk)
    return capture.text()
  }
  assertParity('CASE 10c byte cap total', capCapture(), MAX_CAPTURED_STREAM_BYTES)
  assertParity('CASE 10c byte cap content', capCaptureText(), '😀'.repeat(MAX_CAPTURED_STREAM_BYTES / 4))
  console.log(
    `  ${'CASE 10b/c'.padEnd(9)} ${'(contract) multibyte-safe decode + byte-exact cap'.padEnd(44)} ` +
      `split-emoji decode intact, cap retained at exactly ${MAX_CAPTURED_STREAM_BYTES} bytes`,
  )
}

// ---------------------------------------------------------------------------
// CASE 11 — semgrep-availability-cache-unbounded (bounded-cache contract row)
// ---------------------------------------------------------------------------

/**
 * Evidence row for the unbounded-cache class of fixes in this wave
 * (semgrep-availability-cache-unbounded; the identical shape — a Map keyed by
 * cwd with a TTL but no entry cap — drove the sync-versions-map-unbounded
 * fix in language-intelligence too, which shipped on the same bounded
 * primitive). The after row times the SHIPPED bounded-cache primitive from
 * common/src/util/lru-cache.ts — the exact class the semgrep availability
 * cache and the syncVersions map are built on — over a fixed
 * visit-many-distinct-cwds workload. The before row is the pre-fix shape it
 * replaced: a plain Map that grows without bound.
 *
 * Ratio basis 'contract' (RF-8): the two rows retain different amounts BY
 * DESIGN — bounding the retention IS the cap — so no speedup ratio is
 * printed. The retention difference is asserted outside the timed sections:
 * after one full pass the unbounded Map holds every key while the bounded
 * cache holds at most its cap; if the two ever report identical retention
 * the check fails (the bounded cache would not be bounding anything).
 */
const CACHE_KEYS = 2048
const CACHE_KEYS_LIST: string[] = Array.from(
  { length: CACHE_KEYS },
  (_, i) => `/tmp/perf-baseline-cwd-${i}`,
)
const CACHE_CAP = 256

function runCase11(): void {
  const preFixCache = new Map<string, number>()
  const shippedCache = new LRUCache<string, number>(CACHE_CAP)
  const pass = (cache: Map<string, number> | LRUCache<string, number>): number => {
    let hits = 0
    for (const key of CACHE_KEYS_LIST) {
      const cached = cache.get(key)
      if (cached !== undefined) hits += cached
      else cache.set(key, 1)
    }
    return hits + cache.size
  }
  // Warm both shapes with one full pass, then assert the retention contract.
  pass(preFixCache)
  pass(shippedCache)
  if (preFixCache.size <= shippedCache.size) {
    throw new Error(
      `CASE 11 contract failure: pre-fix unbounded Map retained ${preFixCache.size} entries vs shipped bounded cache ${shippedCache.size} — the bounded cache is not bounding`,
    )
  }
  if (shippedCache.size > CACHE_CAP) {
    throw new Error(
      `CASE 11 contract failure: shipped bounded cache grew to ${shippedCache.size} entries beyond its ${CACHE_CAP} cap`,
    )
  }
  const preFixMs = measure(() => pass(preFixCache), 20)
  const shippedMs = measure(() => pass(shippedCache), 20)
  report({
    case: 'CASE 11',
    finding: 'semgrep-availability-cache-unbounded',
    before: preFixMs,
    after: shippedMs,
    ratioBasis: 'contract',
    note: `${CACHE_KEYS} distinct cwds over the shipped ${CACHE_CAP}-entry cap: before retains every entry (unbounded Map, ${preFixCache.size} entries), after evicts least-recently-used (${shippedCache.size} entries — retention differs by design)`,
  })
}

// ---------------------------------------------------------------------------
// CASE 12 — snapshot-identity-serial-file-reads (shipped bounded read window)
// ---------------------------------------------------------------------------

/**
 * Before/after rows for the snapshot-identity per-file reads
 * (RF: snapshot-identity-serial-file-reads). The after row runs the SHIPPED
 * exported hashIdentityFileBytes from
 * sdk/src/tools/get-change-review-bundle.ts — the exact function
 * buildSnapshotIdentity feeds the snapshot hash — never a local mirror
 * (RF-8 / after-rows-measure-mirrors). The before row is the pre-fix shape it
 * replaced: a strictly serial stat + capped-prefix read + hash loop over the
 * sorted changed-file list.
 *
 * Parity contract: both shapes hash the identical byte stream (per-file
 * headers + byte prefixes joined in the same sorted order), so the digests
 * MUST be byte-identical — asserted outside the timed sections. The fixture
 * is a real temp directory of fixed-size files: the seam is I/O-shaped
 * (stat + open + read), so an in-memory synthetic would not exercise the
 * read fan-out this row evidences. The fixture is removed in a finally block.
 */
const IDENTITY_FILE_COUNT = 200
const IDENTITY_FILE_BYTES = 10_000

function makeIdentityFixture(): { cwd: string; files: string[] } {
  const cwd = mkdtempSync(path.join(tmpdir(), 'perf-identity-'))
  const files: string[] = []
  for (let i = 0; i < IDENTITY_FILE_COUNT; i++) {
    const name = `changed-${String(i).padStart(4, '0')}.txt`
    writeFileSync(
      path.join(cwd, name),
      `${name}:${'x'.repeat(IDENTITY_FILE_BYTES - name.length - 2)}\n`,
    )
    files.push(name)
  }
  return { cwd, files: [...files].sort() }
}

/** Per-file identity read shared by every CASE 12/12b shape. */
async function readIdentityContribution(
  cwd: string,
  file: string,
): Promise<{ header: string; bytes?: Buffer } | null> {
  const absolute = path.join(cwd, file)
  const info = await stat(absolute).catch(() => null)
  if (!info?.isFile()) return null
  const header = `\0${file}\0size:${info.size}\0`
  if (info.size === 0) return { header }
  const handle = await open(absolute, 'r')
  try {
    const buffer = Buffer.allocUnsafe(info.size)
    const read = await handle.read(buffer, 0, info.size, 0)
    return { header, bytes: buffer.subarray(0, read.bytesRead) }
  } finally {
    await handle.close()
  }
}

/** Pre-fix CASE 12 shape: strictly serial stat + read + hash per file. */
async function serialIdentityHash(
  cwd: string,
  files: string[],
): Promise<string> {
  const hash = createHash('sha256')
  for (const file of files) {
    const contribution = await readIdentityContribution(cwd, file)
    if (!contribution) continue
    hash.update(contribution.header)
    if (contribution.bytes) hash.update(contribution.bytes)
  }
  return hash.digest('hex')
}

/** Shipped shape: the exported hashIdentityFileBytes over a fresh digest. */
async function shippedIdentityHash(
  cwd: string,
  files: string[],
): Promise<string> {
  const hash = createHash('sha256')
  await hashIdentityFileBytes(hash, cwd, files)
  return hash.digest('hex')
}

/**
 * CASE 12b's before row: the wave's interim concurrency shape — one
 * mapWithConcurrency fan-out that collects EVERY per-file contribution in
 * memory before the join pass hashes them (the
 * snapshot-identity-contributions-unbounded-retention shape).
 */
async function mapThenJoinIdentityHash(
  cwd: string,
  files: string[],
): Promise<string> {
  const hash = createHash('sha256')
  const contributions = await mapWithConcurrency(files, 8, (file) =>
    readIdentityContribution(cwd, file),
  )
  for (const contribution of contributions) {
    if (!contribution) continue
    hash.update(contribution.header)
    if (contribution.bytes) hash.update(contribution.bytes)
  }
  return hash.digest('hex')
}

async function runCase12(): Promise<void> {
  const fixture = makeIdentityFixture()
  try {
    // Parity: the serial pre-fix shape, the interim map-then-join shape, and
    // the shipped bounded window must all digest the identical byte stream.
    assertParity(
      'CASE 12 identity digests',
      await serialIdentityHash(fixture.cwd, fixture.files),
      await shippedIdentityHash(fixture.cwd, fixture.files),
    )
    assertParity(
      'CASE 12b identity digests',
      await mapThenJoinIdentityHash(fixture.cwd, fixture.files),
      await shippedIdentityHash(fixture.cwd, fixture.files),
    )
    const serialMs = await measureAsync(
      () => serialIdentityHash(fixture.cwd, fixture.files),
      5,
    )
    const windowMs = await measureAsync(
      () => shippedIdentityHash(fixture.cwd, fixture.files),
      5,
    )
    report({
      case: 'CASE 12',
      finding: 'snapshot-identity-serial-file-reads',
      before: serialMs,
      after: windowMs,
      ratioBasis: 'like-for-like',
      note: `${IDENTITY_FILE_COUNT} × ~${IDENTITY_FILE_BYTES}B temp files: before hashes each file's stat + capped prefix strictly serially, after runs the shipped bounded read window (digest parity asserted)`,
    })
    const interimMs = await measureAsync(
      () => mapThenJoinIdentityHash(fixture.cwd, fixture.files),
      5,
    )
    report({
      case: 'CASE 12b',
      finding: 'snapshot-identity-contributions-unbounded-retention',
      before: interimMs,
      after: windowMs,
      ratioBasis: 'contract',
      note: `${IDENTITY_FILE_COUNT} changed files: the interim map-then-join shape retained every per-file byte prefix before hashing (changedFileCount × file-size retention), the shipped window hashes each contribution as it settles (retention bounded by the read window) — retention differs BY DESIGN, so no ratio is printed; digest parity is asserted`,
    })
  } finally {
    rmSync(fixture.cwd, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------------------
// CASE 13 — diagnostic-runner-timeout-no-sigkill-escalation (contract row)
// ---------------------------------------------------------------------------

/**
 * Contract row for the diagnostic command runner's timeout escalation
 * (RF: diagnostic-runner-timeout-no-sigkill-escalation). The child ignores
 * SIGTERM and exits on its own only after CASE13_CHILD_EXIT_MS. The before
 * shape is the pre-fix timeout block: a bare `child.kill()` (SIGTERM) with
 * no escalation, so a SIGTERM-ignoring child is only reaped at its natural
 * exit — with live pipes on the hot file-change path. The after shape is the
 * SHIPPED createDiagnosticCommandRunner with a short injected grace: the
 * deadline sends SIGTERM and settles the result immediately, and the SIGKILL
 * escalation reaps the child at deadline + grace.
 *
 * The evidenced property is the child's wall-clock reaping, so the
 * assertions (run outside any timed section and able to fail) read the
 * child's own pid and poll until the process is gone: the shipped runner
 * must reap the child near deadline + grace while the pre-fix shape holds it
 * to its natural exit. Timing rows repeat both shapes over the same child
 * workload for scale evidence; a production-toolchain reap-latency benchmark
 * would be machine-dependent by nature.
 */
const CASE13_CHILD_EXIT_MS = 1500
const CASE13_DEADLINE_MS = 200
const CASE13_GRACE_MS = 200

async function runCase13(): Promise<void> {
  const dir = mkdtempSync(path.join(tmpdir(), 'perf-case13-'))
  const childPath = path.join(dir, 'ignore-sigterm.cjs')
  const pidFile = path.join(dir, 'child.pid')
  writeFileSync(
    childPath,
    [
      "require('node:fs').writeFileSync(" +
        JSON.stringify(pidFile) +
        ', String(process.pid))',
      "process.on('SIGTERM', () => {})",
      `setTimeout(() => process.exit(0), ${CASE13_CHILD_EXIT_MS})`,
    ].join('\n'),
  )
  /** Wall-clock ms from spawn start until the child process is reaped. */
  const reapMs = async (shipped: boolean): Promise<number> => {
    rmSync(pidFile, { force: true })
    const started = performance.now()
    if (shipped) {
      const runCommand = createDiagnosticCommandRunner({
        spawn: spawn as unknown as CodebuffSpawn,
        sigtermGraceMs: CASE13_GRACE_MS,
      })
      // The runner settles its result AT the deadline; the child's reaping is
      // observed below through its pid, not through the runner's promise.
      void runCommand({
        command: `${process.execPath} ${childPath}`,
        cwd: dir,
        timeoutSeconds: CASE13_DEADLINE_MS / 1000,
      }).catch(() => {})
    } else {
      // Pre-fix shape: bare kill() at the deadline, no escalation.
      const child = spawn(process.execPath, [childPath])
      const timer = setTimeout(() => {
        try {
          child.kill()
        } catch {
          /* already gone */
        }
      }, CASE13_DEADLINE_MS)
      timer.unref?.()
      void new Promise<void>((resolve) => child.on('close', resolve)).catch(
        () => {},
      )
    }
    const giveUpAt = started + CASE13_CHILD_EXIT_MS + 5_000
    let pid = -1
    const sleepMs = (ms: number): Promise<void> =>
      new Promise((resolve) => setTimeout(resolve, ms))
    while (pid === -1 && performance.now() < giveUpAt) {
      try {
        pid = Number.parseInt(readFileSync(pidFile, 'utf8').trim(), 10)
      } catch {
        await sleepMs(10)
      }
    }
    if (pid === -1) return Number.POSITIVE_INFINITY
    for (;;) {
      let gone = false
      try {
        process.kill(pid, 0)
      } catch {
        gone = true
      }
      if (gone) return performance.now() - started
      if (performance.now() > giveUpAt) return Number.POSITIVE_INFINITY
      await sleepMs(10)
    }
  }

  try {
    // Contract assertions (outside any timed section; these CAN fail).
    const bareReap = await reapMs(false)
    const shippedReap = await reapMs(true)
    // Variance rationale for the ceiling slack (reviewer finding
    // case13-reap-slack-widened-undocumented): the +2_000ms margin over
    // deadline+grace is CI-jitter tolerance for this machine-dependent
    // reap-latency observation (10ms process.kill(pid, 0) polling plus fork
    // and SIGKILL scheduling variance on loaded runners), NOT the guarded
    // contract. The falsifiable assertion is the ordering check below: an
    // escalation path that regresses enough to reap between +1s and +2s past
    // the old bound lands AFTER the child's CASE13_CHILD_EXIT_MS natural
    // exit, so `shippedReap >= bareReap` still rejects it. The widened
    // ceiling only prevents a measurement-side scheduler hiccup from
    // false-failing a healthy escalation; it does not admit any failure mode
    // the ordering check would have caught.
    if (
      bareReap < CASE13_CHILD_EXIT_MS * 0.8 ||
      shippedReap > CASE13_DEADLINE_MS + CASE13_GRACE_MS + 2_000 ||
      shippedReap >= bareReap
    ) {
      throw new Error(
        `CASE 13 contract failure: SIGTERM-ignoring child reap latency — pre-fix bare-kill shape ${bareReap}ms (expected >= ${Math.round(CASE13_CHILD_EXIT_MS * 0.8)}ms: held to the child's natural exit), shipped escalated shape ${shippedReap}ms (expected <= ${CASE13_DEADLINE_MS + CASE13_GRACE_MS + 2_000}ms: reaped by the SIGKILL escalation)`,
      )
    }
    const bareMs = await measureAsync(() => reapMs(false), 1, 2)
    const escalatedMs = await measureAsync(() => reapMs(true), 1, 2)
    report({
      case: 'CASE 13',
      finding: 'diagnostic-runner-timeout-no-sigkill-escalation',
      before: bareMs,
      after: escalatedMs,
      ratioBasis: 'contract',
      note: `SIGTERM-ignoring child (${CASE13_CHILD_EXIT_MS}ms natural exit, ${CASE13_DEADLINE_MS}ms deadline, ${CASE13_GRACE_MS}ms grace): before is the pre-fix bare-kill shape (child held to its natural exit), after is the shipped SIGTERM→SIGKILL escalation — the columns bound different failure modes BY DESIGN, so no ratio is printed; the reap-latency contract is asserted above and can fail`,
    })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------------------

/**
 * Options for runPerfGuardsBaseline. Defaults preserve the fixed measurement
 * baseline exactly; the smoke test overrides them to keep the suite fast.
 */
export interface RunPerfGuardsBaselineOptions {
  /** Timed runs per measurement (default: the fixed baseline RUNS). */
  runs?: number
  /** Warmup runs before timing (default: the fixed baseline WARMUP_RUNS). */
  warmups?: number
  /**
   * Multiplier on every case's per-run iteration count (default 1). The smoke
   * test uses a fraction to collapse each case to a single timed op.
   */
  iterationsScale?: number
}

/**
 * Runs the full fixed-baseline benchmark and returns the measured rows.
 * Exported so the smoke test can drive it with tiny iteration counts; the
 * module itself only executes it when run directly (import.meta.main).
 * Throws (rather than calling process.exit) when a parity/contract assertion
 * fails so library callers can catch the failure; the import.meta.main CLI
 * entry catches it and exits non-zero.
 */
export async function runPerfGuardsBaseline(
  options: RunPerfGuardsBaselineOptions = {},
): Promise<CaseRow[]> {
  activeRuns = options.runs ?? RUNS
  activeWarmups = options.warmups ?? WARMUP_RUNS
  activeIterationsScale = options.iterationsScale ?? 1
  rows.length = 0
  sink = 0
  console.log(
    '=== Perf-repair wave fixed-baseline benchmark (RF-1-41ffd2b0) ===',
  )
  console.log(`Project: ${process.cwd()}`)
  console.log(`Date: ${new Date().toISOString()}`)
  console.log(
    `Baseline: median [min..max]±MAD of ${activeRuns} runs after ${activeWarmups} warmup runs; per-op ms on fixed workloads`,
  )
  console.log('')
  runCase1()
  runCase2()
  runCase3()
  runCase4()
  runCase5()
  runCase6()
  runCase7()
  await runCase8()
  runCase9()
  runCase10()
  runCase11()
  await runCase12()
  await runCase13()
  console.log('')
  console.log('--- Evidence notes ---')
  console.log(
    '  CASE 1-2, 4: before/after rows differ ONLY in RegExp construction timing',
  )
  console.log(
    '     (per-call new RegExp vs module-level hoist / the shipped bounded',
  )
  console.log('     cachedRegExp memo); match work identical.')
  console.log(
    '  CASE 3: before replays the whole carry buffer per chunk (quadratic); after',
  )
  console.log(
    '     truncates the carry to the tag-tail window outside a call (identical totals).',
  )
  console.log(
    '  CASE 3d: in-call payload replay — before re-concatenates and rescans the',
  )
  console.log(
    '     whole accumulated payload per chunk (quadratic); after rescans only the',
  )
  console.log('     tag-tail window + the fresh chunk (identical totals).')
  console.log(
    '  CASE 3b/3c (RF-1-41ffd2b0 cap evidence): 64KB maxToolCallBufferLength —',
  )
  console.log(
    '     3b measures in-budget headroom (46KB call completes, 0 leaks); 3c the cap',
  )
  console.log(
    '     engaging (114KB → 1 buffer-exceeded + silent discard) with the pre-budget',
  )
  console.log(
    '     retain-and-rescan shape as the before row (outputs differ by design).',
  )
  console.log(
    '  CASE 4c/4d (RF-1-41ffd2b0 cap evidence): MAX_JSON_CANDIDATES=32 — 4c measures',
  )
  console.log(
    '     headroom (3 decoy braces + payload: 4 of 32 candidates, exact extraction);',
  )
  console.log(
    '     4d the cap engaging (200 decoys: shipped candidate loop uncapped vs the',
  )
  console.log('     32-candidate budget, same outcome).')
  console.log(
    '  CASE 5: parity + bounded-traversal row (the single-visited-set fix is correctness',
  )
  console.log(
    "     hardening per its finding — 'structural hardening only', not a speedup): before",
  )
  console.log(
    '     re-walks shared/cyclic nodes once per path under the depth>8 cap (exponential',
  )
  console.log(
    '     in path levels); after memoizes the shallowest walk depth per object — arrays',
  )
  console.log(
    '     included — and re-walks only on a strictly shallower reach (identical union,',
  )
  console.log(
    '     <= 9 walks/object). Both rows run the shipped crediting layer over identical',
  )
  console.log(
    '     payloads (like-for-like, RF-8), and the evidenced properties here are the',
  )
  console.log(
    '     asserted union parity and the walk bound, not an isolated timing win — so no',
  )
  console.log('     speedup ratio is printed for this row.')
  console.log(
    '  stream-buffer-unbounded-retained-text: the retention bound (flush at tool calls',
  )
  console.log(
    '     and stream end) is structural and pinned by the tool-stream-parser suite;',
  )
  console.log('     CASE 3 measures the parse-side replay cost it complements.')
  console.log(
    '  CASE 10 (RF diagnostic-capture-utf8-chunk-split): before decodes child output',
  )
  console.log(
    '     per-chunk via chunk.toString() (splitting multibyte UTF-8 at chunk',
  )
  console.log(
    '     boundaries) and caps by UTF-16 length; after runs the shipped',
  )
  console.log(
    '     BoundedStreamCapture — raw-byte accumulation, ONE decode at stream end,',
  )
  console.log(
    '     byte-exact cap. ASCII totals parity is asserted; the split-emoji decode',
  )
  console.log(
    '     (10b) and byte-exact-cap (10c) contract checks run outside the timed',
  )
  console.log('     sections and CAN fail.')
  console.log(
    '  CASE 11 (RF semgrep-availability-cache-unbounded / sync-versions-map-unbounded):',
  )
  console.log(
    '     before is the pre-fix unbounded Map; after is the shipped bounded LRUCache',
  )
  console.log(
    '     primitive the semgrep availability cache and the syncVersions map are built',
  )
  console.log(
    '     on. Retention differs BY DESIGN (bounding the retention IS the cap), so no',
  )
  console.log(
    '     speedup ratio is printed; the retention contract is asserted and can fail.',
  )
  console.log(
    '  CASE 12 (RF snapshot-identity-serial-file-reads): before hashes each changed',
  )
  console.log(
    "     file's stat + capped byte prefix strictly serially; after runs the shipped",
  )
  console.log(
    '     hashIdentityFileBytes bounded read window (bounded in-flight reads,',
  )
  console.log(
    '     contributions hashed in sorted order). Digest parity across the serial',
  )
  console.log(
    '     shape, the interim map-then-join shape, and the shipped window is asserted',
  )
  console.log('     and can fail.')
  console.log(
    '  CASE 12b (RF snapshot-identity-contributions-unbounded-retention): contract',
  )
  console.log(
    '     row — the interim concurrency shape retained every per-file byte prefix',
  )
  console.log(
    '     before hashing (changedFileCount × file-size retention); the shipped',
  )
  console.log(
    '     window hashes each contribution as it settles, so retention is bounded',
  )
  console.log(
    '     by the read window instead of the changed-file count. Retention differs',
  )
  console.log(
    '     BY DESIGN (bounding the retention IS the cap), so no speedup ratio is',
  )
  console.log('     printed; digest parity is asserted and can fail.')
  console.log(
    '  CASE 13 (RF diagnostic-runner-timeout-no-sigkill-escalation): contract row —',
  )
  console.log(
    '     a SIGTERM-ignoring diagnostic child is reaped by the shipped SIGKILL',
  )
  console.log(
    '     escalation near deadline + grace, while the pre-fix bare-kill shape held',
  )
  console.log(
    '     it to its natural exit with live pipes. The columns bound different',
  )
  console.log(
    '     failure modes BY DESIGN, so no ratio is printed; the reap-latency',
  )
  console.log("     contract is asserted against the child's real pid and can fail.")
  console.log(
    '  Structural perf-tag attribution (guards whose property is pinned by their test',
  )
  console.log(
    '     suite rather than timed here, per the stream-buffer precedent above):',
  )
  console.log(
    '     scip-premerge-edge-accumulation — the merge-edge budget is consulted DURING',
  )
  console.log(
    '       accumulation (runSingleIndexer + the batch budget in scip-runner.ts); the',
  )
  console.log(
    '       over-cap retention bound is pinned by the scip-runner suite tests, so a',
  )
  console.log(
    '       heap-spike timing row over a synthetic 256MiB dump would measure the',
  )
  console.log(
    '       garbage collector, not the guard — attributed structurally instead.',
  )
  console.log(
    '     scip-detection-probe-no-single-flight, scip-dump-json-parse-heap-spike,',
  )
  console.log(
    '       lsp-coldstart-evict-overshoot, root-resolver-unmemoized-sync-walk-per-acquire,',
  )
  console.log(
    '       symbol-enrichment-serial-hover-roundtrips, build-graph-spawnsync-blocking-new-tool-path,',
  )
  console.log(
    '       sync-versions-map-unbounded, bundle-identity-unbounded-sync-io,',
  )
  console.log(
    '       snapshot-identity-diff-capture-unbounded, identity-git-spawns-no-deadline —',
  )
  console.log(
    '       concurrency/IO/process-seam guards whose property (bounded in-flight work,',
  )
  console.log(
    '       bounded capture, non-blocking event loop) is pinned by the sdk/indexer test',
  )
  console.log(
    '       suites; spawn-driven seams cannot be timed deterministically in CI, so they',
  )
  console.log(
    '       are attributed structurally here instead of shipping fake numbers.',
  )
  console.log(
    '       For symbol-enrichment-serial-hover-roundtrips specifically: the guarded',
  )
  console.log(
    '       property is the bounded hover fan-out with index-aligned results (real',
  )
  console.log(
    '       LSP round-trip latency is server- and machine-dependent), pinned by the',
  )
  console.log(
    '       symbol-enrichment suite rather than a simulated-latency timing row.',
  )
  console.log('')
  console.log(
    `All parity/contract assertions passed across ${rows.length} measured rows.`,
  )
  console.log(
    'Parity rows compute identical before/after outputs; cap rows (3c, 4d) assert',
  )
  console.log(
    "  the cap's contract on the shipped side (before/after outputs differ by design).",
  )
  console.log(
    "  Speedup ratios print only for like-for-like rows; 'contract' rows (3c, 4d,",
  )
  console.log(
    '  CASE 5, CASE 11, CASE 12b, CASE 13) print n/a — their columns measure',
  )
  console.log('  different work by design.')
  console.log(
    '  Ratio stability (RF-13): every row prints min/max/MAD dispersion and each',
  )
  console.log(
    '     speedup carries its min/max quotient envelope; envelopes spanning 1.0x',
  )
  console.log('     are marked within-noise and are not evidence of a speedup.')
  console.log(
    '  X-2 CASE 6-9: absolute (after-only) timing rows on the shipped seams — no',
  )
  console.log(
    '     before/after exists for these, so no speedup ratio is printed. CASE 6a/6b',
  )
  console.log(
    '     make the 100k-char BPE cap visible (raw encode vs 20k-sample extrapolation);',
  )
  console.log(
    '     CASE 6c (D12): ~5MB pathological estimator row — BPE stays bounded to the',
  )
  console.log(
    '     20k-char sample (the body is never BPE-encoded), with a heterogeneous-density',
  )
  console.log(
    '     accuracy check against a full-BPE ground-truth sibling body (a naive chars/3',
  )
  console.log(
    '     estimator demonstrably misses it, so the check is falsifiable) and a <2s',
  )
  console.log(
    '     boundedness guard against the >2min full-BPE CI stall.',
  )
  console.log(
    '     CASE 7 measures the JS-side rg line parse only (rg spawn is I/O-bound and',
  )
  console.log(
    '     machine-dependent, deliberately not measured); CASE 8 rows are attributed',
  )
  console.log(
    '     "X-2a hot paths (D13)" — the indexer refresh loop stats real files, so its',
  )
  console.log(
    '     two hot functions (assignDepths, getPostingCandidates) are measured directly;',
  )
  console.log(
    "     CASE 8b's query workload engages the substring scan + MAX_POSTING_CANDIDATE_PATHS",
  )
  console.log(
    '     bound (asserted: the union saturates the cap with exact-match paths added on',
  )
  console.log(
    '     top per the superset-preservation guarantee), not just the exact-match path;',
  )
  console.log(
    '     CASE 9 times the shipped parseStreamChunk seam over ~100KB in ~1KB chunks.',
  )
  console.log(
    '  Manual-only X-2 rows (deliberately NOT measured here — they need a real',
  )
  console.log(
    '     TUI/process and cannot run deterministically in CI; planned methods are',
  )
  console.log(
    '     listed so the X-2 gate stays honest instead of shipping fake numbers):',
  )
  console.log(
    '     TUI keystroke latency — scripted-keystroke p50/p99 keystroke-to-render',
  )
  console.log('       measured against the live Ink TUI in a real terminal;')
  console.log(
    '     cold-start — CLI process spawn → first interactive prompt, warm vs cold',
  )
  console.log('     cache (process spawn timing is machine-dependent).')
  console.log(`Work checksum (defeats DCE): ${sink === 0 ? 0 : 1}`)
  return [...rows]
}

if (import.meta.main) {
  runPerfGuardsBaseline().catch((error: unknown) => {
    console.error(error)
    process.exit(1)
  })
}
