import * as fs from 'fs'
import * as path from 'path'

import { getLanguageConfig, hasLanguageConfiguration } from './languages'

import { importSpecifiersFromAstCaptures } from './import-sites'

import type { LanguageConfig } from './languages'
import type { Parser, Query } from 'web-tree-sitter'
import { getLanguageFamily } from '@codebuff/common/util/language-profiles'

export const DEBUG_PARSING = false
const IGNORE_TOKENS = ['__init__', '__post_init__', '__call__', 'constructor']
const MAX_CALLERS = 25
const DEFAULT_MAX_PARSE_FILES = 10_000
const DEFAULT_MAX_PARSE_FILE_BYTES = 1_000_000
const DEFAULT_MAX_TOTAL_PARSE_BYTES = 500_000_000

const MAX_PARSE_FILES = getPositiveIntegerEnv(
  'CODEBUFF_MAX_PARSE_FILES',
  DEFAULT_MAX_PARSE_FILES,
)
const MAX_PARSE_FILE_BYTES = getPositiveIntegerEnv(
  'CODEBUFF_MAX_PARSE_FILE_BYTES',
  DEFAULT_MAX_PARSE_FILE_BYTES,
)
const MAX_TOTAL_PARSE_BYTES = getPositiveIntegerEnv(
  'CODEBUFF_MAX_TOTAL_PARSE_BYTES',
  DEFAULT_MAX_TOTAL_PARSE_BYTES,
)

/**
 * Default time slice (ms) of synchronous work between event-loop yields. The
 * gate is awaited at every scheduling seam — once per file-loop iteration AND
 * at the intra-file seams around each dominant synchronous block (source
 * load, tree-sitter parse entry) — so the slice bounds synchronous work
 * between consecutive yields across the whole run, not merely per file. The
 * residual exception is a single atomic native call (a whole-file tree-sitter
 * parse): it cannot be split, so it alone can overshoot the slice, and the
 * gate then suspends at the immediately following seam. Recorded baseline:
 * see the 'tunables cost baselines' block in
 * cli/src/utils/__tests__/opentui-syntax-style.test.ts.
 */
const DEFAULT_YIELD_INTERVAL_MS = 8
/**
 * Production yield interval, overridable via CODEBUFF_YIELD_INTERVAL_MS so the
 * 8ms default can be tuned and later regression-tracked against quantitative
 * before/after evidence (event-loop lag via perf_hooks.monitorEventLoopDelay,
 * cold-parse throughput) without a code change per experiment; the measured
 * gate-on/gate-off evidence harness lives in the 'yield-gate throughput and
 * event-loop-lag evidence' block in
 * cli/src/utils/__tests__/opentui-syntax-style.test.ts. The default
 * stays put until such evidence justifies moving it. Recorded baseline for
 * the cost this knob introduces (one macrotask suspension per elapsed slice
 * during cold parse; at interval 0, one per yield-gate call — pinned in the
 * 'tunables cost baselines' block in
 * cli/src/utils/__tests__/opentui-syntax-style.test.ts).
 */
let yieldIntervalMs = getPositiveIntegerEnv(
  'CODEBUFF_YIELD_INTERVAL_MS',
  DEFAULT_YIELD_INTERVAL_MS,
)
/**
 * Completed macrotask suspensions across every yield gate, incremented only
 * AFTER the awaited `setImmediate` resolves so a count > 0 proves the await
 * actually suspended through the macrotask queue. Read (and reset) via the
 * TEST-ONLY hooks below.
 */
let macrotaskYieldCount = 0

/**
 * Create an independent macrotask-yield gate for ONE loop invocation. Every
 * getFileTokenScores call (and any nested invocation) gets its own gate
 * state, so concurrent parse loops each receive a full time slice instead of
 * sharing one module-level "last yield" timestamp.
 *
 * The gate measures elapsed time with performance.now(), NOT Date.now(): the
 * slice measures elapsed work time and must be immune to wall-clock steps
 * (NTP corrections, manual clock adjustment), which could otherwise suppress
 * or spuriously force yields during a long parse run.
 *
 * A plain `await` inside the loop resumes via the MICROTASK queue, which the
 * event loop drains fully before it can process I/O or UI input — so
 * per-file awaits never unblock the TUI during a cold parse of a large repo.
 * Awaiting a `setImmediate` schedules a MACROTASK, which lets the event loop
 * event loop interleave pending I/O and keystrokes between parse batches. Called at every
 * scheduling seam — the top of each file-loop iteration AND the intra-file
 * seams around each dominant synchronous block (source load, tree-sitter
 * parse entry) — so the slice bounds synchronous work between consecutive
 * yields across the whole run, not merely per file; a cheap no-op until the
 * time slice has elapsed. The invocation's first slice starts when its gate
 * is created, so an invocation whose total work stays below one slice never
 * suspends.
 *
 * Regression-pinned: the macrotask-yield regression tests assert that (a)
 * awaiting a gate lets a pending macrotask I/O callback run BEFORE the await
 * resumes, (b) the macrotaskYields counter increments only across an actual
 * suspension, (c) concurrent gates slice independently, and (d) the gate
 * factory remains an exported, awaitable seam via createYieldGateForTests /
 * forceEventLoopYieldForTests. Replacing the awaited `setImmediate` with a
 * plain await/microtask, dropping the awaited suspension, or inlining the
 * loop body so the gate disappears fails those tests.
 */
function createEventLoopYieldGate(
  initialLastYieldMs?: number,
): () => Promise<void> {
  // The invocation's first slice starts at gate CREATION, not at epoch 0: a
  // lastYield of 0 sits infinitely outside every slice, so the old default
  // forced the first gate call of EVERY invocation through a setImmediate
  // macrotask even when the whole invocation's work is far below one slice
  // (small incremental updateMetadataIndex/getFileTokenScores calls paid
  // ~1ms+ latency each). An explicit initialLastYieldMs (TEST-ONLY) still
  // pins the stale-gate semantics.
  const firstSliceStart = initialLastYieldMs ?? performance.now()
  let lastYield = firstSliceStart
  return async () => {
    const now = performance.now()
    if (now - lastYield < yieldIntervalMs) return
    lastYield = now
    await new Promise<void>((resolve) => setImmediate(resolve))
    macrotaskYieldCount += 1
  }
}

/**
 * TEST-ONLY yield-seam hooks (repo `*ForTests` convention) backing the
 * macrotask-yield regression pins described on
 * {@link createEventLoopYieldGate}. Never call from app code: they override
 * the production time slice.
 */

/** TEST-ONLY: override the yield interval (0 forces a yield on every call). */
export function setYieldIntervalForTests(intervalMs: number): void {
  if (Number.isFinite(intervalMs) && intervalMs >= 0) {
    yieldIntervalMs = intervalMs
  }
}

/** TEST-ONLY: restore the production yield interval and zero the counters. */
export function resetYieldStateForTests(): void {
  yieldIntervalMs = getPositiveIntegerEnv(
    'CODEBUFF_YIELD_INTERVAL_MS',
    DEFAULT_YIELD_INTERVAL_MS,
  )
  macrotaskYieldCount = 0
}

/** TEST-ONLY: yield-seam counters for regression assertions. */
export function getYieldStatsForTests(): { macrotaskYields: number } {
  return { macrotaskYields: macrotaskYieldCount }
}

/**
 * TEST-ONLY: the effective production yield interval (ms), so the 8ms
 * DEFAULT_YIELD_INTERVAL_MS default itself is pinnable in tests — a default
 * change must fail the interval pin and re-record the quantitative
 * before/after baseline it deltas against (see the 'tunables cost baselines'
 * and 'yield-gate throughput and event-loop-lag evidence' blocks in
 * cli/src/utils/__tests__/opentui-syntax-style.test.ts).
 */
export function getYieldIntervalForTests(): number {
  return yieldIntervalMs
}

/**
 * TEST-ONLY: create an independent yield gate exactly like the per-invocation
 * gates the parse loop awaits, so the per-invocation slice semantics and the
 * macrotask mechanism are pinnable without running a full parse. Omit the
 * argument for the production semantics (first slice starts at creation);
 * pass 0 explicitly for a stale gate whose first call always suspends.
 */
export function createYieldGateForTests(
  initialLastYieldMs?: number,
): () => Promise<void> {
  return createEventLoopYieldGate(initialLastYieldMs)
}

/**
 * TEST-ONLY: await a gate from the same factory the parse loop awaits, so a
 * refactor that removes, renames, or inlines the gate fails the regression
 * tests instead of silently dropping the macrotask yield. Pinned to the
 * stale-gate semantics (lastYield = 0) so the FIRST call always suspends,
 * independent of the production interval.
 */
export async function forceEventLoopYieldForTests(): Promise<void> {
  await createEventLoopYieldGate(0)()
}

export interface ParseDiagnostic {
  filePath: string
  stage: 'language' | 'read' | 'parse'
  message: string
}

export interface ParseBudget {
  maxFiles: number
  maxFileBytes: number
  maxTotalBytes: number
}

export interface ParseCoverage {
  requestedFiles: number
  parsedFiles: number
  reusedFiles: number
  freshParsedFiles: number
  parsedBytes: number
  skippedFiles: number
  skippedKnownBytes: number
  skippedPrefixes: string[]
  skippedLanguages: string[]
  fileBudgetExceeded: boolean
  byteBudgetExceeded: boolean
  oversizedFiles: number
  maxFiles: number
  maxFileBytes: number
  maxTotalBytes: number
  truncated: boolean
}

type ParseTokensOptions = {
  maxBytes?: number
  remainingBytes?: number
  diagnostics?: ParseDiagnostic[]
}

type ParsedTokens = {
  numLines: number
  identifiers: string[]
  calls: string[]
}

type ParsedTokensForScoring = ParsedTokens & {
  bytes: number
  imports: string[]
  skipped: boolean
  skipReason?:
    | 'file_too_large'
    | 'total_byte_budget'
    | 'source_unavailable'
    | 'read_error'
    | 'parse_error'
}

type SourceReader = (filePath: string) => string | null | Promise<string | null>

type FileCallData = {
  calls: string[]
  scores: Record<string, number>
}

export interface TokenCallerMap {
  [filePath: string]: {
    [token: string]: string[] // Array of files that call this token
  }
}

export interface FileTokenData {
  tokenScores: { [filePath: string]: { [token: string]: number } }
  tokenCallers: TokenCallerMap
}

/** Raw per-file parse output, cacheable so unchanged files skip re-parsing. */
export interface ParsedFileTokens {
  identifiers: string[]
  calls: string[]
  numLines: number
  /**
   * P3-T5 AST import-capture tier: module specifiers captured by the tags
   * query's @import.* patterns for the five tier languages (TypeScript,
   * JavaScript, Python, Go, Rust), normalized by
   * `importSpecifiersFromAstCaptures` into the exact shapes the line-based
   * extractor emits. Optional so parse caches persisted before this tier
   * stay valid; consumers must fall back to line-based extraction when the
   * field is absent or empty.
   */
  imports?: string[]
}

export async function getFileTokenScores(
  projectRoot: string,
  filePaths: string[],
  readFile?: SourceReader,
  reuseParsed?: Record<string, ParsedFileTokens>,
  budgetOverrides: Partial<ParseBudget> = {},
): Promise<
  FileTokenData & {
    parsed: Record<string, ParsedFileTokens>
    diagnostics: ParseDiagnostic[]
    coverage: ParseCoverage
  }
> {
  const startTime = Date.now()
  // One yield gate per invocation: concurrent getFileTokenScores calls each
  // get their own time slice instead of sharing one (see
  // createEventLoopYieldGate).
  const yieldToEventLoop = createEventLoopYieldGate()
  const tokenScores: Record<string, Record<string, number>> = {}
  const externalCalls: Record<string, number> = {}
  const fileCallsMap = new Map<string, string[]>()
  const parsedByPath: Record<string, ParsedFileTokens> = {}
  const diagnostics: ParseDiagnostic[] = []
  const budget: ParseBudget = {
    maxFiles: budgetOverrides.maxFiles ?? MAX_PARSE_FILES,
    maxFileBytes: budgetOverrides.maxFileBytes ?? MAX_PARSE_FILE_BYTES,
    maxTotalBytes: budgetOverrides.maxTotalBytes ?? MAX_TOTAL_PARSE_BYTES,
  }
  let freshParsedFiles = 0
  let reusedFiles = 0
  let totalParsedBytes = 0
  let skippedKnownBytes = 0
  let oversizedFiles = 0
  let fileBudgetExceeded = false
  let byteBudgetExceeded = false
  const skippedPaths: string[] = []
  const skippedLanguages = new Set<string>()

  // Round-robin top-level-prefix/language buckets so a tight parse budget does
  // not erase every symbol from directories that happen to sort last.
  for (const filePath of fairParseOrder(filePaths)) {
    // Macrotask yield so a long cold parse does not starve the event loop
    // (see yieldToEventLoop): the yield precedes all work/continue paths so
    // every iteration is covered uniformly and loop-carried state below is
    // untouched.
    await yieldToEventLoop()
    // Path-traversal guard (mirrors file-walker statProjectFiles): caller- or
    // cache-supplied paths must never be joined onto projectRoot unchecked, or
    // a corrupted index cache could point statSync/readFileSync at arbitrary
    // files outside the project. Unsafe paths are skipped like any other
    // unparsable file — they are never read.
    const fullPath = resolveWithinProjectRoot(projectRoot, filePath)
    if (fullPath === null) {
      skippedPaths.push(filePath)
      skippedLanguages.add(path.extname(filePath) || 'unknown')
      continue
    }

    // Incremental fast path: reuse a prior parse for an unchanged file. The
    // caller is responsible for only passing reuse entries for files whose
    // content has not changed (verified by hash/mtime in the indexer).
    const reused = reuseParsed?.[filePath]
    let parsed: ParsedFileTokens
    if (reused) {
      parsed = reused
      reusedFiles++
    } else {
      if (freshParsedFiles >= budget.maxFiles) {
        fileBudgetExceeded = true
        skippedPaths.push(filePath)
        skippedLanguages.add(path.extname(filePath) || 'unknown')
        skippedKnownBytes += getKnownFileSize(fullPath)
        continue
      }
      if (totalParsedBytes >= budget.maxTotalBytes) {
        byteBudgetExceeded = true
        skippedPaths.push(filePath)
        skippedLanguages.add(path.extname(filePath) || 'unknown')
        skippedKnownBytes += getKnownFileSize(fullPath)
        continue
      }
      const languageConfig = await getLanguageConfig(fullPath)
      if (!languageConfig) {
        skippedPaths.push(filePath)
        skippedKnownBytes += getKnownFileSize(fullPath)
        skippedLanguages.add(path.extname(filePath) || 'unknown')
        diagnostics.push({
          filePath,
          stage: 'language',
          message: hasLanguageConfiguration(fullPath)
            ? `Tree-sitter grammar failed to load for ${path.extname(filePath) || 'file'}. Verify the packaged language WASM files and CODEBUFF_WASM_DIR.`
            : `No tree-sitter language configuration available for ${path.extname(filePath) || 'file'}`,
        })
        continue
      }

      const result = await parseTokensForScoring({
        filePath,
        fullPath,
        languageConfig,
        readFile,
        maxFileBytes: budget.maxFileBytes,
        remainingBytes: budget.maxTotalBytes - totalParsedBytes,
        diagnostics,
        yieldToEventLoop,
      })
      if (result.skipped) {
        skippedPaths.push(filePath)
        skippedLanguages.add(path.extname(filePath) || 'unknown')
        if (result.skipReason === 'file_too_large') oversizedFiles++
        if (result.skipReason === 'total_byte_budget') byteBudgetExceeded = true
        skippedKnownBytes += result.bytes || getKnownFileSize(fullPath)
        continue
      }

      freshParsedFiles++
      totalParsedBytes += result.bytes
      parsed = {
        identifiers: result.identifiers,
        calls: result.calls,
        numLines: result.numLines,
        imports: result.imports,
      }
    }

    parsedByPath[filePath] = parsed
    const { scores, calls } = scoreFileTokens(fullPath, parsed)
    tokenScores[filePath] = scores
    fileCallsMap.set(filePath, calls)

    for (const call of calls) {
      if (!scores[call]) {
        externalCalls[call] = (externalCalls[call] ?? 0) + 1
      }
    }
  }

  const tokenCallers = buildTokenCallers(tokenScores, fileCallsMap)
  boostScoresByExternalCalls(tokenScores, externalCalls)

  if (DEBUG_PARSING) {
    const endTime = Date.now()
    console.log(`Parsed ${filePaths.length} files in ${endTime - startTime}ms`)

    try {
      fs.writeFileSync(
        '../debug/debug-parse.json',
        JSON.stringify({
          tokenCallers,
          tokenScores,
          fileCallsMap,
          externalCalls,
        }),
      )
    } catch {
      // Silently ignore debug file write errors in test environments
    }
  }

  const coverage: ParseCoverage = {
    requestedFiles: filePaths.length,
    parsedFiles: Object.keys(parsedByPath).length,
    reusedFiles,
    freshParsedFiles,
    parsedBytes: totalParsedBytes,
    skippedFiles: skippedPaths.length,
    skippedKnownBytes,
    skippedPrefixes: Array.from(
      new Set(skippedPaths.map((filePath) => topLevelPrefix(filePath))),
    ).sort(),
    skippedLanguages: Array.from(skippedLanguages).sort(),
    fileBudgetExceeded,
    byteBudgetExceeded,
    oversizedFiles,
    maxFiles: budget.maxFiles,
    maxFileBytes: budget.maxFileBytes,
    maxTotalBytes: budget.maxTotalBytes,
    truncated: skippedPaths.length > 0,
  }

  return {
    tokenScores,
    tokenCallers,
    parsed: parsedByPath,
    diagnostics,
    coverage,
  }
}

export function parseTokens(
  filePath: string,
  languageConfig: LanguageConfig,
  readFile?: (filePath: string) => string | null,
  options: ParseTokensOptions = {},
): ParsedTokens {
  const { numLines, identifiers, calls } = parseTokensWithLimits(
    filePath,
    languageConfig,
    readFile,
    options,
  )
  return { numLines, identifiers, calls }
}

/**
 * P3-T5 AST import-capture tier: like {@link parseTokens}, but also surfaces
 * the import specifiers captured by the tags query's @import.* patterns
 * (normalized to the line-based extractor's shapes — see
 * {@link ParsedFileTokens.imports}). Exported so the tier can be pinned per
 * language with mock parser/query configs, without a live WASM grammar.
 */
export function parseTokensWithImports(
  filePath: string,
  languageConfig: LanguageConfig,
  readFile?: (filePath: string) => string | null,
  options: ParseTokensOptions = {},
): ParsedTokens & { imports: string[] } {
  const { numLines, identifiers, calls, imports } = parseTokensWithLimits(
    filePath,
    languageConfig,
    readFile,
    options,
  )
  return { numLines, identifiers, calls, imports }
}

/**
 * Async per-file parse entry for {@link getFileTokenScores}: awaits the
 * invocation's yield gate at the intra-file seams (before the source load
 * and again before the tree-sitter parse block) so each schedulable
 * synchronous block stays within one time slice even for a single large
 * file (see {@link createEventLoopYieldGate}). The tree-sitter parse itself
 * is one atomic native call — the documented residual exception.
 */
async function parseTokensForScoring(params: {
  filePath: string
  fullPath: string
  languageConfig: LanguageConfig
  readFile?: SourceReader
  maxFileBytes: number
  remainingBytes: number
  diagnostics: ParseDiagnostic[]
  /** Macrotask yield gate owned by the calling getFileTokenScores run. */
  yieldToEventLoop: () => Promise<void>
}): Promise<ParsedTokensForScoring> {
  const {
    filePath,
    fullPath,
    languageConfig,
    readFile,
    maxFileBytes,
    remainingBytes,
    diagnostics,
    yieldToEventLoop,
  } = params
  const limits = {
    maxBytes: maxFileBytes,
    remainingBytes,
    diagnostics,
  }

  if (remainingBytes <= 0) {
    return emptyParsedTokens('total_byte_budget')
  }

  if (!readFile) {
    try {
      await yieldToEventLoop()
      const loaded = loadSourceWithinLimits({
        filePath: fullPath,
        maxBytes: maxFileBytes,
        remainingBytes,
      })
      if (!loaded.source) {
        return emptyParsedTokens(loaded.skipReason, loaded.bytes)
      }
      // Intra-file seam: the synchronous stat/read block above and the
      // tree-sitter parse block below each stay within one time slice (the
      // parse itself is one atomic native call — the documented exception).
      await yieldToEventLoop()
      return parseTokensFromLoadedSource(
        fullPath,
        languageConfig,
        loaded.source,
        limits,
      )
    } catch (e) {
      diagnostics.push({
        filePath,
        stage: 'parse',
        message: getErrorMessage(e),
      })
      return emptyParsedTokens('parse_error')
    }
  }

  try {
    await yieldToEventLoop()
    const source = await readFile(filePath)
    const loaded = loadSourceWithinLimits({
      filePath,
      readFile: () => source,
      maxBytes: maxFileBytes,
      remainingBytes,
    })
    if (!loaded.source) {
      return emptyParsedTokens(loaded.skipReason, loaded.bytes)
    }
    // Intra-file seam: the synchronous budget accounting above and the
    // tree-sitter parse block below each stay within one time slice (the
    // parse itself is one atomic native call — the documented exception).
    await yieldToEventLoop()
    return parseTokensFromLoadedSource(
      filePath,
      languageConfig,
      loaded.source,
      limits,
    )
  } catch (e) {
    diagnostics.push({
      filePath,
      stage: 'read',
      message: getErrorMessage(e),
    })
    if (DEBUG_PARSING) {
      console.error(`Error reading source: ${e}`)
      console.log(filePath)
    }
    return emptyParsedTokens('read_error')
  }
}

function parseTokensWithLimits(
  filePath: string,
  languageConfig: LanguageConfig,
  readFile: ((filePath: string) => string | null) | undefined,
  options: ParseTokensOptions,
): ParsedTokensForScoring {
  const maxBytes = options.maxBytes ?? MAX_PARSE_FILE_BYTES
  const remainingBytes = options.remainingBytes ?? MAX_TOTAL_PARSE_BYTES
  try {
    if (remainingBytes <= 0) {
      return emptyParsedTokens('total_byte_budget')
    }

    const loaded = loadSourceWithinLimits({
      filePath,
      readFile,
      maxBytes,
      remainingBytes,
    })
    if (!loaded.source) {
      return emptyParsedTokens(loaded.skipReason, loaded.bytes)
    }

    return parseTokensFromLoadedSource(
      filePath,
      languageConfig,
      loaded.source,
      options,
    )
  } catch (e) {
    options.diagnostics?.push({
      filePath,
      stage: 'parse',
      message: getErrorMessage(e),
    })
    if (DEBUG_PARSING) {
      console.error(`Error parsing query: ${e}`)
      console.log(filePath)
    }
    return emptyParsedTokens('parse_error')
  }
}

/**
 * Parse + capture half of {@link parseTokensWithLimits}: runs the tree-sitter
 * parse, the @import.* capture normalization, and the token de-duplication on
 * an already budget-checked source. Split out so the async parse path
 * ({@link parseTokensForScoring}) can open a yield gate seam between the
 * source load and this block, bounding the synchronous work between
 * consecutive yields across the whole run rather than merely per file.
 */
function parseTokensFromLoadedSource(
  filePath: string,
  languageConfig: LanguageConfig,
  source: { code: string; bytes: number },
  options: ParseTokensOptions,
): ParsedTokensForScoring {
  const { parser, query } = languageConfig

  try {
    if (!parser || !query) {
      throw new Error('Parser or query not found')
    }

    const parseResults = parseFile(parser, query, source.code)
    const identifiers = Array.from(new Set(parseResults.identifier))
    const calls = Array.from(new Set(parseResults['call.identifier']))
    // P3-T5 AST import-capture tier: @import.* captures from the SAME tags
    // query (tree-sitter-queries/*.scm), normalized to the line-based
    // extractor's specifier shapes. Languages without import captures yield
    // [] here, which consumers treat as "fall back to line-based".
    const imports = importSpecifiersFromAstCaptures(
      parseResults['import.specifier'] ?? [],
      parseResults['import.call'] ?? [],
      filePath,
    )

    if (DEBUG_PARSING) {
      console.log(`\nParsing ${filePath}:`)
      console.log('Identifiers:', identifiers)
      console.log('Calls:', calls)
    }

    return {
      numLines: countLines(source.code),
      identifiers: identifiers ?? [],
      calls: calls ?? [],
      imports,
      bytes: source.bytes,
      skipped: false,
    }
  } catch (e) {
    options.diagnostics?.push({
      filePath,
      stage: 'parse',
      message: getErrorMessage(e),
    })
    if (DEBUG_PARSING) {
      console.error(`Error parsing query: ${e}`)
      console.log(filePath)
    }
    return emptyParsedTokens('parse_error')
  }
}

function loadSourceWithinLimits(params: {
  filePath: string
  readFile?: (filePath: string) => string | null
  maxBytes: number
  remainingBytes: number
}): {
  source: { code: string; bytes: number } | null
  skipReason?: ParsedTokensForScoring['skipReason']
  bytes: number
} {
  const { filePath, readFile, maxBytes, remainingBytes } = params

  if (!readFile) {
    const bytes = fs.statSync(filePath).size
    if (bytes > maxBytes) {
      return { source: null, skipReason: 'file_too_large', bytes }
    }
    if (bytes > remainingBytes) {
      return { source: null, skipReason: 'total_byte_budget', bytes }
    }

    return {
      source: { code: fs.readFileSync(filePath, 'utf8'), bytes },
      bytes,
    }
  }

  const code = readFile(filePath)
  if (code === null) {
    return { source: null, skipReason: 'source_unavailable', bytes: 0 }
  }

  const bytes = Buffer.byteLength(code, 'utf8')
  if (bytes > maxBytes) {
    return { source: null, skipReason: 'file_too_large', bytes }
  }
  if (bytes > remainingBytes) {
    return { source: null, skipReason: 'total_byte_budget', bytes }
  }

  return { source: { code, bytes }, bytes }
}

function scoreFileTokens(fullPath: string, parsed: ParsedTokens): FileCallData {
  const scores: Record<string, number> = {}
  const dirs = path.dirname(fullPath).split(path.sep)
  const depth = dirs.length
  const tokenBaseScore =
    0.8 ** depth * Math.sqrt(parsed.numLines / (parsed.identifiers.length + 1))

  for (const identifier of parsed.identifiers) {
    if (!IGNORE_TOKENS.includes(identifier)) {
      scores[identifier] = tokenBaseScore
    }
  }

  return { scores, calls: parsed.calls }
}

/**
 * Resolve caller edges from token scores and per-file call lists. Exported so
 * the same-language caller-resolution rule is directly testable; inputs are the
 * tokenScores/fileCallsMap shapes produced by {@link getFileTokenScores}.
 */
export function buildTokenCallers(
  tokenScores: Record<string, Record<string, number>>,
  fileCallsMap: Map<string, string[]>,
): TokenCallerMap {
  const definitions = new Map<
    string,
    Array<{ filePath: string; family: string }>
  >()

  for (const [filePath, scores] of Object.entries(tokenScores)) {
    // Language family depends only on filePath, so resolve it once per file
    // (with its lone path.extname/toLowerCase allocation) instead of once per
    // candidate edge inside the caller-resolution loops below.
    const family = getLanguageFamily(path.extname(filePath).toLowerCase())
    for (const token of Object.keys(scores)) {
      ;(definitions.get(token) ?? definitions.set(token, []).get(token)!).push({
        filePath,
        family,
      })
    }
  }

  const tokenCallers: TokenCallerMap = {}
  for (const [callingFile, calls] of fileCallsMap.entries()) {
    // callerLanguage is invariant across this file's calls and candidates, so
    // hoist it out of the inner loops rather than recomputing it (and its
    // path.extname/toLowerCase allocation) per call and per candidate edge.
    const callerLanguage = getLanguageFamily(callingFile)
    for (const call of calls) {
      const candidates = definitions.get(call) ?? []
      const sameLanguage = candidates.filter(
        (candidate) => candidate.family === callerLanguage,
      )
      // Same-language definitions only (M4-S6): cross-language raw-name
      // matches are ambiguous in polyglot monorepos — a .py and a .ts file
      // both defining the same name would fabricate a false blast-radius
      // edge. Caller edges resolve only when exactly one same-language
      // definition exists; import-aware graph construction adds stronger
      // cross-language edges later. This contract is pinned by both
      // code-map's buildTokenCallers tests and the indexer's
      // call-navigation suite ('does not create cross-language raw-name call
      // edges').
      const eligible = sameLanguage
      const definingFile =
        eligible.length === 1 ? eligible[0]?.filePath : undefined
      if (!definingFile || callingFile === definingFile) {
        continue
      }

      const callersByToken = (tokenCallers[definingFile] ??= {})
      const callerFiles = (callersByToken[call] ??= [])
      if (
        callerFiles.length < MAX_CALLERS &&
        !callerFiles.includes(callingFile)
      ) {
        callerFiles.push(callingFile)
      }
    }
  }

  return tokenCallers
}

function boostScoresByExternalCalls(
  tokenScores: Record<string, Record<string, number>>,
  externalCalls: Record<string, number>,
): void {
  for (const scores of Object.values(tokenScores)) {
    for (const token of Object.keys(scores)) {
      const numCalls = externalCalls[token] ?? 0
      scores[token] *= 1 + Math.log(1 + numCalls)
      scores[token] = Math.round(scores[token] * 1000) / 1000
    }
  }
}

function emptyParsedTokens(
  skipReason?: ParsedTokensForScoring['skipReason'],
  bytes = 0,
): ParsedTokensForScoring {
  return {
    numLines: 0,
    identifiers: [],
    calls: [],
    imports: [],
    bytes,
    skipped: Boolean(skipReason),
    skipReason,
  }
}

function fairParseOrder(filePaths: string[]): string[] {
  const buckets = new Map<string, string[]>()
  for (const filePath of filePaths) {
    const key = `${topLevelPrefix(filePath)}\0${path.extname(filePath).toLowerCase()}`
    ;(buckets.get(key) ?? buckets.set(key, []).get(key)!).push(filePath)
  }
  const queues = Array.from(buckets.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, files]) => files)
  const ordered: string[] = []
  for (let offset = 0; ordered.length < filePaths.length; offset++) {
    for (const queue of queues) {
      const filePath = queue[offset]
      if (filePath !== undefined) ordered.push(filePath)
    }
  }
  return ordered
}

function topLevelPrefix(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/')
  const slash = normalized.indexOf('/')
  return slash === -1 ? '.' : normalized.slice(0, slash)
}

/**
 * Resolve a caller-supplied relative path onto projectRoot safely: rejects
 * absolute paths, '..' segments, and NUL before joining, then resolves and
 * verifies the final absolute path stays under projectRoot. Returns null for
 * any path that would escape the project root.
 */
function resolveWithinProjectRoot(
  projectRoot: string,
  filePath: string,
): string | null {
  if (filePath.includes('\0')) return null
  const normalized = filePath.replace(/\\/g, '/').replace(/^\.\//, '')
  if (!normalized) return null
  if (path.isAbsolute(filePath) || normalized.startsWith('/')) return null
  if (normalized.split('/').includes('..')) return null
  const resolved = path.resolve(projectRoot, normalized)
  const root = path.resolve(projectRoot)
  if (resolved !== root && !resolved.startsWith(root + path.sep)) return null
  return resolved
}

function getKnownFileSize(filePath: string): number {
  try {
    return fs.statSync(filePath).size
  } catch {
    return 0
  }
}

function countLines(sourceCode: string): number {
  return (sourceCode.match(/\n/g)?.length ?? 0) + 1
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function getPositiveIntegerEnv(name: string, fallback: number): number {
  const raw = process.env[name]
  if (!raw) return fallback

  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function parseFile(
  parser: Parser,
  query: Query,
  sourceCode: string,
): { [key: string]: string[] } {
  const tree = parser.parse(sourceCode)
  if (!tree) {
    return {}
  }
  try {
    const captures = query.captures(tree.rootNode)
    const result: { [key: string]: string[] } = {}

    for (const capture of captures) {
      const { name, node } = capture
      if (!result[name]) {
        result[name] = []
      }
      result[name].push(node.text)
    }

    return result
  } finally {
    ;(tree as { delete?: () => void }).delete?.()
  }
}
