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

import type { SupportedLanguageId } from '../common/src/util/language-capabilities'

/** Fixed measurement baseline: identical constants for before and after rows. */
const RUNS = 5
const WARMUP_RUNS = 2
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
  runs = RUNS,
): Timing {
  const once = () => {
    let checksum = 0
    for (let i = 0; i < iterations; i++) checksum += fn()
    return checksum
  }
  for (let w = 0; w < WARMUP_RUNS; w++) sink += once()
  const samples: number[] = []
  for (let r = 0; r < runs; r++) {
    const started = performance.now()
    sink += once()
    samples.push((performance.now() - started) / iterations)
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
    console.error(`PARITY FAILURE in ${label}`)
    console.error(`  before: ${beforeJson}`)
    console.error(`  after:  ${afterJson}`)
    process.exit(1)
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

console.log('=== Perf-repair wave fixed-baseline benchmark (RF-1-41ffd2b0) ===')
console.log(`Project: ${process.cwd()}`)
console.log(`Date: ${new Date().toISOString()}`)
console.log(
  `Baseline: median [min..max]±MAD of ${RUNS} runs after ${WARMUP_RUNS} warmup runs; per-op ms on fixed workloads`,
)
console.log('')
runCase1()
runCase2()
runCase3()
runCase4()
runCase5()
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
console.log('  CASE 5) print n/a — their columns measure different work by design.')
console.log(
  '  Ratio stability (RF-13): every row prints min/max/MAD dispersion and each',
)
console.log(
  '     speedup carries its min/max quotient envelope; envelopes spanning 1.0x',
)
console.log('     are marked within-noise and are not evidence of a speedup.')
console.log(`Work checksum (defeats DCE): ${sink === 0 ? 0 : 1}`)
