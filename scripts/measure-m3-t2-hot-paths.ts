/**
 * M3-T2 hot-path benchmark: fixed-baseline before/after evidence for the seven
 * hot-path sites from the M3-T2 task (params/utils linear recovery, incremental
 * token counting + per-message memoization, tool JSON-schema memoization,
 * gate-marker stat-liveness cache, single-walk memory-drift guard, bounded
 * tool-result eviction).
 *
 * Contract (mirrors scripts/measure-perf-guards-baseline.ts):
 * - Fixed deterministic workloads: no randomness, no wall-clock dependence
 *   inside a timed section (CASE 5's measured op IS a file stat/read — its
 *   fixture files are small, fixed, and created before any warmup run).
 * - Every 'after' row runs the SHIPPED code imported from the real modules —
 *   never a local mirror of it. Every 'before' row is a faithful mirror of the
 *   pre-optimization shape; mirrors that cannot include a shipped layer say so
 *   in their row note with the bias direction.
 * - Baseline: median [min..max]±MAD of RUNS timed runs after WARMUP_RUNS
 *   warmups; per-op milliseconds on fixed workloads.
 * - Speedup ratios print ONLY for like-for-like rows (identical work layers,
 *   only the guarded change differs), each qualified by the min/max quotient
 *   envelope of the two rows: an envelope spanning 1.0x is marked
 *   `within-noise`. Rows whose columns do different work BY DESIGN (contract
 *   rows) print no ratio. The script exits non-zero only when a parity
 *   assertion fails.
 *
 * Usage: bun scripts/measure-m3-t2-hot-paths.ts
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, sep } from 'node:path'
import { z } from 'zod'

import { tryRecoverTruncatedToolArguments } from '../common/src/tools/params/utils'
import { toolParams } from '../common/src/tools/list'
import {
  countTokensJson,
  IncrementalTokenCounter,
} from '../packages/agent-runtime/src/util/token-counter'
import { parseRawToolCall } from '../packages/agent-runtime/src/tools/tool-executor'
import {
  buildMarkdownSnapshot,
  checkBrokenLink,
  checkEdges,
  checkPath,
  checkTodoFixme,
  type MarkdownSnapshot,
} from './memory-drift-guard'
import { evictStaleToolResults } from '../packages/agent-runtime/src/util/tool-result-eviction'
import { extractInlineFunctionSource } from '../agents/__tests__/helpers/extract-inline-function-source'

/** Fixed measurement baseline: identical constants for before and after rows. */
const RUNS = 5
const WARMUP_RUNS = 2

let sink = 0

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]!
}

/** Median absolute deviation about the median (robust dispersion). */
function medianAbsoluteDeviation(values: number[], center: number): number {
  const deviations = values
    .map((value) => Math.abs(value - center))
    .sort((a, b) => a - b)
  return deviations[Math.floor(deviations.length / 2)]!
}

type Timing = {
  medianMsPerOp: number
  minMsPerOp: number
  maxMsPerOp: number
  madMsPerOp: number
}

function measure(fn: () => number, iterations: number, runs = RUNS): Timing {
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
  ratioBasis: 'like-for-like' | 'contract'
  note: string
}

const rows: CaseRow[] = []

function formatMs(value: number): string {
  return value >= 1 ? value.toFixed(4) : value.toFixed(6)
}

function formatTiming(t: Timing): string {
  return `${formatMs(t.medianMsPerOp)} [${formatMs(t.minMsPerOp)}..${formatMs(t.maxMsPerOp)}]±${formatMs(t.madMsPerOp)}`
}

function report(row: CaseRow): void {
  rows.push(row)
  const { before, after, ratioBasis } = row
  let ratioText = 'n/a'
  if (ratioBasis === 'like-for-like') {
    const low = before.minMsPerOp / after.maxMsPerOp
    const high = before.maxMsPerOp / after.minMsPerOp
    const point = before.medianMsPerOp / after.medianMsPerOp
    const withinNoise = low <= 1 && high >= 1
    ratioText = `${point.toFixed(1)}x [${low.toFixed(1)}..${high.toFixed(1)}]${withinNoise ? ' within-noise' : ''}`
  }
  console.log(
    `  ${row.case.padEnd(9)} ${row.finding.padEnd(42)} before ${formatTiming(before).padEnd(34)} after ${formatTiming(after).padEnd(34)} ${ratioText.padEnd(18)} ${row.note}`,
  )
}

function assertParity(name: string, before: unknown, after: unknown): void {
  const a = JSON.stringify(before)
  const b = JSON.stringify(after)
  if (a !== b) {
    console.error(`PARITY FAILURE in ${name}\n  before: ${a.slice(0, 200)}\n  after:  ${b.slice(0, 200)}`)
    process.exit(1)
  }
}

/** Tolerant parity for token-count rows (array-wrapper overhead is ~0-8 tok). */
function assertParityClose(
  name: string,
  before: number,
  after: number,
  relTol: number,
): void {
  const scale = Math.max(Math.abs(before), Math.abs(after), 1)
  if (Math.abs(before - after) / scale > relTol) {
    console.error(
      `PARITY FAILURE in ${name}: before ${before} vs after ${after} (relTol ${relTol})`,
    )
    process.exit(1)
  }
}

function runCase1(): void {
  // ~40 nested objects cut mid-final-string, well under the scan bound.
  const parts: string[] = ['{"k":']
  for (let i = 0; i < 40; i++) {
    parts.push(
      `{"paths":["packages/agent-runtime/src/file-${i}.ts","a.ts"],"n":${i},`,
    )
  }
  parts.push('"tail":"truncated-string-that-never-closes')
  const rawInput = parts.join('')

  const shipped = () => {
    const recovered = tryRecoverTruncatedToolArguments(rawInput)
    return recovered === undefined ? -1 : Object.keys(recovered).length
  }
  // Legacy O(n^2) shape (pre-fix, per the shipped function's own docblock):
  // for EVERY candidate closer (latest -> earliest) re-run the
  // string/escape/brace state machine over the WHOLE prefix to recover the
  // residual open-container stack, close the candidate with balanced closers,
  // and accept the first candidate whose JSON.parse yields a plain non-empty
  // object. Candidate strings are byte-identical to the shipped scanner's by
  // construction, so parity holds.
  const legacy = () => {
    for (let end = rawInput.length - 1; end > 0; end--) {
      const ch = rawInput[end]
      if (ch !== '}' && ch !== ']') continue
      // Re-scan the whole prefix — the O(n^2) cost the M3-T2 fix removes.
      const openStack: string[] = []
      let inString = false
      let escapedData = false
      let mismatched = false
      for (let i = 0; i <= end; i++) {
        const c = rawInput[i]
        if (inString) {
          if (escapedData) escapedData = false
          else if (c === '\\') escapedData = true
          else if (c === '"') inString = false
        } else if (c === '"') inString = true
        else if (c === '{') openStack.push('{')
        else if (c === '[') openStack.push('[')
        else if (c === '}' || c === ']') {
          const open = openStack.pop()
          if (
            open === undefined ||
            (c === '}' && open !== '{') ||
            (c === ']' && open !== '[')
          ) {
            mismatched = true
            break
          }
        }
      }
      if (mismatched || inString) continue
      let candidate = rawInput.slice(0, end + 1)
      for (let i = openStack.length - 1; i >= 0; i--) {
        candidate += openStack[i] === '{' ? '}' : ']'
      }
      try {
        const parsed = JSON.parse(candidate) as unknown
        if (
          parsed !== null &&
          typeof parsed === 'object' &&
          !Array.isArray(parsed) &&
          Object.keys(parsed as Record<string, unknown>).length > 0
        ) {
          return Object.keys(parsed as Record<string, unknown>).length
        }
      } catch {
        // Not a clean prefix; try the next closer.
      }
    }
    return -1
  }
  assertParity('CASE 1 recovered keys', legacy(), shipped())
  report({
    case: 'CASE 1',
    finding: 'truncated-args O(n^2) prefix re-parse vs single forward pass',
    before: measure(legacy, 200),
    after: measure(shipped, 200),
    ratioBasis: 'like-for-like',
    note: `${rawInput.length}B truncated payload, ~40 candidate closers`,
  })
}

/** 16 messages, each ~12KB serialized (above the 8192-char cacheable bound). */
function buildLargeMessages(): unknown[] {
  return Array.from({ length: 16 }, (_, i) => ({
    role: 'user',
    content: `msg-${i}: ${'x'.repeat(12_000)} end-${i}`,
  }))
}

function runCase2(): void {
  const messages = buildLargeMessages()
  const counter = new IncrementalTokenCounter()
  counter.messagesTokens(messages) // warm the WeakMap memo
  const shipped = () => counter.messagesTokens(messages)
  // Legacy shape (audit shard-runtime-loop run-agent-step.ts:1947): re-encode
  // the ENTIRE serialized history via countTokensJson every iteration.
  const legacy = () => countTokensJson(messages)
  const beforeTotal = legacy()
  const afterTotal = shipped()
  assertParityClose('CASE 2 token totals', beforeTotal, afterTotal, 0.02)
  report({
    case: 'CASE 2',
    finding: 'full-transcript re-encode vs incremental per-message counts',
    before: measure(legacy, 20),
    after: measure(shipped, 20),
    ratioBasis: 'like-for-like',
    note: `16 x ~12KB messages (${beforeTotal} vs ${afterTotal} tok, tol 2%: wrapper overhead)`,
  })
}

function runCase3(): void {
  const messages = buildLargeMessages()
  const counter = new IncrementalTokenCounter()
  counter.messagesTokens(messages) // warm
  // Like-for-like on the SAME array: uncached per-message recount (stringify +
  // count each message, every op) vs the shipped WeakMap-memoized recount.
  const legacy = () => {
    let total = 0
    for (const m of messages) total += countTokensJson(m as object)
    return total
  }
  const shipped = () => counter.messagesTokens(messages)
  assertParity('CASE 3 token totals', legacy(), shipped())
  report({
    case: 'CASE 3',
    finding: 'per-message recount vs WeakMap-memoized recount (same array)',
    before: measure(legacy, 50),
    after: measure(shipped, 50),
    ratioBasis: 'like-for-like',
    note: 'identical 16-message array; only the memo differs',
  })
}

function runCase4(): void {
  const paths = Array.from(
    { length: 200 },
    (_, i) => `packages/agent-runtime/src/file-${i}.ts`,
  )
  const input = JSON.stringify({ paths })
  const schema = toolParams['read_files'].inputSchema as z.ZodType
  const shipped = () => {
    const call = parseRawToolCall({
      rawToolCall: { toolName: 'read_files', toolCallId: 'c1', input },
    }) as { input?: { paths?: string[] } }
    return call.input?.paths?.length ?? -1
  }
  // Legacy shape (audit shard-tools-edit): the same pipeline with the input
  // schema converted via z.toJSONSchema on EVERY call. The shipped repair
  // chain (repairSetOutputData/repairTerminalCommandScalars/
  // repairEditToolScalars) is verified no-op for read_files inputs, so the
  // mirror omits it; the bias is conservative (the shipped row does strictly
  // more work).
  const legacy = () => {
    const parsed = JSON.parse(input) as unknown
    z.toJSONSchema(schema, { io: 'input' })
    const result = schema.safeParse(parsed)
    return result.success
      ? ((result.data as { paths?: string[] }).paths?.length ?? -1)
      : -1
  }
  assertParity('CASE 4 parsed input', legacy(), shipped())
  report({
    case: 'CASE 4',
    finding: 'per-call z.toJSONSchema vs TOOL_JSON_SCHEMA_CACHE memo',
    before: measure(legacy, 100),
    after: measure(shipped, 100),
    ratioBasis: 'like-for-like',
    note: 'read_files, 200 paths; repair chain no-op (bias conservative)',
  })
}

// CASE 5 helpers: extract the shipped gate marker from base2.ts using the
// recipe proven by agents/e2e/reviewer-spawn-conditions.e2e.test.ts.
function extractBase2JavaScript(): string {
  const base2Source = readFileSync(
    new URL('../agents/base2/base2.ts', import.meta.url),
    'utf8',
  )
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const transpiler = new Bun.Transpiler({ loader: 'ts' })
  return transpiler.transformSync(base2Source)
}

function sliceHoistedConst(
  source: string,
  name: string,
): string {
  const start = source.indexOf(`const ${name}`)
  if (start < 0) {
    throw new Error(`Unable to find hoisted ${name} declaration`)
  }
  const equalsIndex = source.indexOf('=', start)
  // Initializers come in two shapes: quoted string literals (end-of-decl found
  // via the matching closing quote, robust to embedded `;`) and simple
  // non-quoted literals like `250` (end-of-decl is the first `;` after the
  // `=` — quote-hunting here would run past the declaration and swallow the
  // following `const gateMarkerCache = new Map()`, duplicating it in the eval
  // scope).
  let end: number
  if (equalsIndex < 0) {
    end = -1
  } else {
    let probe = equalsIndex + 1
    while (probe < source.length && /\s/.test(source[probe]!)) probe += 1
    const initializer = source[probe]
    if (initializer === "'" || initializer === '"') {
      const closeQuoteIndex = source.indexOf(initializer, probe + 1)
      end = closeQuoteIndex < 0 ? -1 : source.indexOf(';', closeQuoteIndex)
    } else {
      end = source.indexOf(';', equalsIndex)
    }
  }
  if (end < 0) {
    throw new Error(`Unable to find the end of the ${name} declaration`)
  }
  return source.slice(start, end + 1)
}

function buildMarkerFunctions(): {
  uncached: (path: string) => string
  cached: (path: string) => string
} {
  const js = extractBase2JavaScript()
  const missingConst = sliceHoistedConst(js, 'GATE_FILE_MISSING_CONTENT_MARKER')
  const cacheMaxConst = sliceHoistedConst(js, 'GATE_MARKER_CACHE_MAX')
  const uncachedSrc = extractInlineFunctionSource(
    js,
    'readGateFileContentMarkerUncached',
  )
  const uncached = new Function(
    `"use strict";\n${missingConst}\n${cacheMaxConst}\nconst gateMarkerCache = new Map()\n${uncachedSrc}\nreturn readGateFileContentMarkerUncached`,
  )() as (path: string) => string
  const wrapperSrc = extractInlineFunctionSource(js, 'readGateFileContentMarker')
  const fsHelperSrc = extractInlineFunctionSource(js, 'readGateMarkerBuiltinFs')
  const pathHelperSrc = extractInlineFunctionSource(js, 'requirePath')
  const cached = new Function(
    `"use strict";\n${missingConst}\n${cacheMaxConst}\nconst gateMarkerCache = new Map()\n${fsHelperSrc}\n${pathHelperSrc}\n${uncachedSrc}\n${wrapperSrc}\nreturn readGateFileContentMarker`,
  )() as (path: string) => string
  return { uncached, cached }
}

function runCase5(): void {
  const { uncached, cached } = buildMarkerFunctions()
  const scratchParent = join(process.cwd(), '.base2-test-scratch')
  mkdirSync(scratchParent, { recursive: true })
  const tempDir = mkdtempSync(join(scratchParent, '.m3t2-marker-parity-'))
  try {
    const files = Array.from({ length: 24 }, (_, i) => {
      const p = join(tempDir, `fixture-${i}.md`)
      writeFileSync(p, `# fixture ${i}\n${'content line\n'.repeat(400)}`)
      return p
    })
    const relPaths = files.map((f) => relative(process.cwd(), f).split(sep).join('/'))
    // Warm the cached wrapper's stat-liveness cache once (untimed).
    for (const p of relPaths) sink += cached(p).length
    const parityBefore = relPaths.map((p) => uncached(p))
    const parityAfter = relPaths.map((p) => cached(p))
    assertParity('CASE 5 marker strings', parityBefore, parityAfter)
    const legacy = () => {
      let total = 0
      for (const p of relPaths) total += uncached(p).length
      return total
    }
    const shipped = () => {
      let total = 0
      for (const p of relPaths) total += cached(p).length
      return total
    }
    report({
      case: 'CASE 5',
      finding: 'gate marker full re-hash vs stat-liveness cache fast path',
      before: measure(legacy, 30),
      after: measure(shipped, 30),
      ratioBasis: 'like-for-like',
      note: '24 x ~5KB fixtures; the measured op IS file stat/read (I/O-bound row)',
    })
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }
}

function runCase6(): void {
  const tempDir = mkdtempSync(join(tmpdir(), 'm3t2-md-guard-'))
  try {
    for (let i = 0; i < 12; i++) {
      const lines = Array.from(
        { length: 60 },
        (_, j) => (j === 10 ? `TODO: fix item ${i}` : `line ${j} of file ${i}`),
      )
      writeFileSync(join(tempDir, `doc-${i}.md`), lines.join('\n') + '\n')
    }
    const checkers = [checkPath, checkEdges, checkTodoFixme, checkBrokenLink]
    // Shipped shape: ONE buildMarkdownSnapshot walk shared by all checkers.
    const snapshot: MarkdownSnapshot = buildMarkdownSnapshot(tempDir)
    // Full per-checker parity FIRST (whole findings arrays, not just sums).
    assertParity(
      'CASE 6 findings',
      checkers.map((check) => check(tempDir)),
      checkers.map((check) => check(tempDir, snapshot)),
    )
    // Legacy shape: each checker re-walks and re-reads every markdown file.
    const legacy = () =>
      checkers.reduce((total, check) => total + check(tempDir).length, 0)
    const shipped = () =>
      checkers.reduce(
        (total, check) => total + check(tempDir, snapshot).length,
        0,
      )
    report({
      case: 'CASE 6',
      finding: 'per-checker walk+read vs single shared snapshot walk',
      before: measure(legacy, 20),
      after: measure(shipped, 20),
      ratioBasis: 'like-for-like',
      note: '12-file markdown fixture; checkPath/Edges/TodoFixme/BrokenLink subset',
    })
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }
}

function runCase7(): void {
  // ~22 steps x (1 assistant + 1 tool result with ~40KB content).
  const messages: Array<Record<string, unknown>> = []
  for (let step = 0; step < 22; step++) {
    messages.push({ role: 'assistant', content: `step ${step}` })
    messages.push({
      role: 'tool',
      toolCallId: `tc-${step}`,
      content: [{ type: 'text', value: 'r'.repeat(40_000) }],
    })
  }
  const originalLengths = messages.map((m) => JSON.stringify(m).length)
  const result = evictStaleToolResults(messages as never, {
    keepRecentSteps: 0,
    minSavingsTokens: 1,
  })
  // Contract assertion (like CASE 3c/4d): the bound's contract engages.
  if (!(result.evictedCount > 0 && result.tokensSaved > 0)) {
    console.error('CONTRACT FAILURE in CASE 7: eviction did not engage')
    process.exit(1)
  }
  const evictedTombstoned = result.messages.some(
    (m: Record<string, unknown>, i: number) =>
      JSON.stringify(m).length < originalLengths[i]! - 1000,
  )
  if (!evictedTombstoned) {
    console.error('CONTRACT FAILURE in CASE 7: no tombstoned result found')
    process.exit(1)
  }
  // Before row: the pre-bound shape — identity walk, no eviction, no scan cap.
  const legacy = () => {
    let total = 0
    for (const m of messages) total += JSON.stringify(m).length
    return total
  }
  const shipped = () => {
    const r = evictStaleToolResults(messages as never, {
      keepRecentSteps: 0,
      minSavingsTokens: 1,
    })
    return r.tokensSaved
  }
  report({
    case: 'CASE 7',
    finding: 'bounded tool-result eviction (contract row)',
    before: measure(legacy, 10),
    after: measure(shipped, 10),
    ratioBasis: 'contract',
    note: '22 x 40KB results; the evidenced property is the bound (MAX_PROTECTED_CONTENT_SCAN_CHARS scan cap) engaging, not a timing win',
  })
}

console.log('Baseline: median [min..max]±MAD of 5 runs after 2 warmups; per-op ms on fixed workloads')
runCase1()
runCase2()
runCase3()
runCase4()
runCase5()
runCase6()
runCase7()

console.log('All parity/contract assertions passed across 7 measured rows.')
console.log(
  'Parity rows compute identical before/after outputs; contract rows (7) assert',
)
console.log(
  '  the bound\'s contract on the shipped side. Speedup ratios print only for',
)
console.log(
  '  like-for-like rows and are qualified by the min/max quotient envelope.',
)
sink += rows.length
