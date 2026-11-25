import * as crypto from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'

import {
  extractCodeChunks,
  getFileTokenScores,
  AST_IMPORT_SPECIFIER_LIMIT,
  SUPPORTED_CODE_EXTENSIONS,
  getParserExtractionFingerprint,
} from '@codebuff/code-map'

import {
  extractImportSpecifiers,
  resolveImportToFile,
  stripJsonComments,
} from './import-resolution'
import { createTsModuleResolver } from './ts-module-resolver'
import {
  BINARY_EXTENSIONS,
  statProjectFiles,
  walkProjectDetailed,
} from './file-walker'
import {
  buildGuidToPathMap,
  extractAssetRefs,
  resolveGuidRef,
} from './asset-refs'
import { sanitizeIndexCacheDir } from './index-store'
import {
  buildIndexQueryDataAsync,
  updateIndexQueryDataAsync,
} from './query-data'
import type {
  GraphWeights,
  IndexedFile,
  IndexEdge,
  IndexGraph,
  IndexGraphDependencies,
  IndexingConfig,
  IndexMutationDelta,
  IndexNode,
  MetadataIndex,
  ParseDiagnostic,
} from './types'
import type { ParseCoverage, ParsedFileTokens } from '@codebuff/code-map'
import type { WalkedFile, WalkProjectResult } from './file-walker'
import type { TsModuleResolver } from './ts-module-resolver'
import { getLanguageFamily } from '@codebuff/common/util/language-profiles'

const CODE_EXTENSIONS = new Set(SUPPORTED_CODE_EXTENSIONS)

const DOC_EXTENSIONS = new Set(['.md', '.mdx', '.txt', '.rst'])
const CONFIG_EXTENSIONS = new Set(['.json', '.jsonc', '.yaml', '.yml', '.toml'])

/**
 * Default time slice (ms) of synchronous work between event-loop yields. The
 * gate is awaited at every scheduling seam — once per file-loop iteration AND
 * at the intra-file seams around each dominant synchronous block (stat/hash
 * pass, content extraction vs. tree-sitter chunk extraction) — so the slice
 * bounds synchronous work between consecutive yields across the whole run,
 * not merely per file. The residual exception is a single atomic native call
 * (a whole-content SHA-256 or a whole-file tree-sitter parse): it cannot be
 * split, so it alone can overshoot the slice, and the gate then suspends at
 * the immediately following seam. Recorded baseline: see the 'tunables cost
 * baselines' block in cli/src/utils/__tests__/opentui-syntax-style.test.ts.
 */
const DEFAULT_YIELD_INTERVAL_MS = 8
/**
 * Production yield interval, overridable via CODEBUFF_YIELD_INTERVAL_MS so the
 * 8ms default can be tuned and later regression-tracked against quantitative
 * before/after evidence (event-loop lag via perf_hooks.monitorEventLoopDelay,
 * cold-index throughput) without a code change per experiment; the measured
 * gate-on/gate-off evidence harness lives in the 'yield-gate throughput and
 * event-loop-lag evidence' block in
 * cli/src/utils/__tests__/opentui-syntax-style.test.ts, which measures BOTH
 * packages' loops against fixed recorded baselines: the code-map cold parse
 * (RECORDED_YIELD_GATE_BASELINE) and this package's cold buildMetadataIndex
 * over the same shared fixture (RECORDED_INDEXER_YIELD_GATE_BASELINE — its
 * mechanism assertions read the indexer module's OWN suspension counter, so
 * they cover the indexer's yield-gated loops independently of the embedded
 * code-map parse counter). The default
 * stays put until such evidence justifies moving it. Recorded baseline for
 * the cost this knob introduces (one macrotask suspension per elapsed slice
 * during cold index; at interval 0, one per yield-gate call — pinned in the
 * 'tunables cost baselines' block in
 * cli/src/utils/__tests__/opentui-syntax-style.test.ts and by the indexer
 * cold-build suspension pin in
 * packages/indexer/src/metadata-indexer.test.ts).
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
 * Create an independent macrotask-yield gate for ONE indexing invocation.
 * Every buildMetadataIndex / updateMetadataIndex call gets its own gate
 * state, so concurrent index builds (e.g. index-manager refreshing two
 * roots) each receive a full time slice instead of sharing one module-level
 * "last yield" timestamp.
 *
 * The gate measures elapsed time with performance.now(), NOT Date.now(): the
 * slice measures elapsed work time and must be immune to wall-clock steps
 * (NTP corrections, manual clock adjustment), which could otherwise suppress
 * or spuriously force yields during a long index run.
 *
 * A plain `await` inside a loop resumes via the MICROTASK queue, which the
 * event loop drains fully before it can process I/O or UI input — so
 * per-file awaits never unblock the TUI during a cold index build on a large
 * repo. Awaiting a `setImmediate` schedules a MACROTASK, which lets the
 * event loop interleave pending I/O and keystrokes between file batches.
 * (Local helper instead of importing from code-map keeps the packages
 * decoupled; duplicating the helper and its TEST-ONLY hooks across the two
 * packages is acceptable.) Called at every scheduling seam — the top of each
 * file-loop iteration AND the intra-file seams around each dominant
 * synchronous block (stat/hash, content vs. chunk extraction) — so the slice
 * bounds synchronous work between consecutive yields across the whole run,
 * not merely per file; a cheap no-op until the time slice has elapsed. The
 * invocation's first slice starts when its gate is created, so an invocation
 * whose total work stays below one slice never suspends.
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

/** Positive-int env override with fallback (mirrors code-map's parse.ts). */
function getPositiveIntegerEnv(name: string, fallback: number): number {
  const raw = process.env[name]
  if (!raw) return fallback
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
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
 * gates the indexing loops await, so the per-invocation slice semantics and
 * the macrotask mechanism are pinnable without running a full index build.
 * Omit the argument for the production semantics (first slice starts at
 * creation); pass 0 explicitly for a stale gate whose first call always
 * suspends.
 */
export function createYieldGateForTests(
  initialLastYieldMs?: number,
): () => Promise<void> {
  return createEventLoopYieldGate(initialLastYieldMs)
}

/**
 * TEST-ONLY: await a gate from the same factory the indexing loops await, so
 * a refactor that removes, renames, or inlines the gate fails the regression
 * tests instead of silently dropping the macrotask yield. Pinned to the
 * stale-gate semantics (lastYield = 0) so the FIRST call always suspends,
 * independent of the production interval.
 */
export async function forceEventLoopYieldForTests(): Promise<void> {
  await createEventLoopYieldGate(0)()
}

/**
 * TEST-ONLY re-export namespace: code-map's parse-loop yield hooks, exposed
 * through this module so dependents that declare only @codebuff/indexer
 * (e.g. @codebuff/cli, whose yield-gate regression pins in
 * cli/src/utils/__tests__/opentui-syntax-style.test.ts cover BOTH packages'
 * loops) can reach them without importing '@codebuff/code-map/parse'
 * directly. @codebuff/cli does not declare @codebuff/code-map, so a direct
 * import there would be a phantom dependency resolved only via hoisting and
 * would break if this package dropped its code-map dependency. The namespace
 * carries the same module instance the '@codebuff/code-map/parse' specifier
 * resolves to, so the module-level yield state is shared, not duplicated.
 */
export * as codeMapParseYieldHooks from '@codebuff/code-map/parse'

/** Historical hardcoded graph edge weights — the ranking baseline. */
export const DEFAULT_GRAPH_WEIGHTS: Required<GraphWeights> = {
  defines: 1,
  imports: 0.7,
  references: 0.9,
  containsHeading: 0.8,
  mentions: 0.6,
  calls: 1.1,
}

/** Merge partial user graph weights over the historical defaults (undefined-safe). */
export function resolveGraphWeights(
  weights?: GraphWeights,
): Required<GraphWeights> {
  const resolved: Required<GraphWeights> = { ...DEFAULT_GRAPH_WEIGHTS }
  if (weights) {
    for (const key of Object.keys(
      DEFAULT_GRAPH_WEIGHTS,
    ) as (keyof GraphWeights)[]) {
      const value = weights[key]
      if (typeof value === 'number' && Number.isFinite(value)) {
        resolved[key] = value
      }
    }
  }
  return resolved
}

function toRevisionKey(
  value: string | number | undefined,
): number | string | undefined {
  if (value === undefined) return undefined
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : String(value)
  }
  const trimmed = value.trim()
  if (/^\d+$/.test(trimmed)) return Number.parseInt(trimmed, 10)
  return trimmed
}

/**
 * P8.3: numeric-aware ordered comparison of persisted/incoming workspace
 * revisions. Plain `<` on the raw values mis-orders numeric strings against
 * numbers and each other ('10' < '9'); numeric strings are coerced to numbers.
 * Returns a negative number when a sorts before b.
 */
export function compareRevisions(
  a: string | number | undefined,
  b: string | number | undefined,
): number {
  const keyA = toRevisionKey(a)
  const keyB = toRevisionKey(b)
  if (keyA === undefined || keyB === undefined) return 0
  if (typeof keyA === 'number' && typeof keyB === 'number') {
    return keyA < keyB ? -1 : keyA > keyB ? 1 : 0
  }
  const strA = String(keyA)
  const strB = String(keyB)
  return strA < strB ? -1 : strA > strB ? 1 : 0
}

const MARKDOWN_LINK_REGEX = /\[[^\]]+\]\(([^)]+)\)/g

/**
 * In-process cache of raw tree-sitter parse output per file, keyed by project
 * root. Lets incremental rebuilds re-parse ONLY changed files instead of the
 * whole project (the cross-file call graph is recomputed cheaply from the
 * merged set). Lost on process restart — the first build of a session is a
 * full parse, which is correct, just not free.
 */
const parsedCacheByRoot = new Map<string, Record<string, ParsedFileTokens>>()

/** Cache of resolved tsconfig path aliases per project root. */
const tsAliasCacheByRoot = new Map<string, TsAliasMap>()

/**
 * Upper bound on the number of distinct project roots whose parse/alias
 * caches we retain in-process. Eviction is FIFO (Map insertion order). A
 * long-lived process that indexes many distinct roots can't grow these
 * without bound; the oldest root's cache is dropped on overflow. Each of
 * the two per-root maps is bounded INDEPENDENTLY: a doc-only root (no code
 * files) gets a tsAliasCacheByRoot entry without any parsedCacheByRoot
 * insert, so bounding only the parse-cache size would let the alias cache
 * grow without bound. Exported so tests can assert the bound is enforced
 * on every write path.
 */
export const MAX_INDEXED_PROJECT_ROOTS = 8

/**
 * FIFO eviction guard shared by every insert path into either per-root
 * cache. Both maps must be bounded independently: a doc-only root (no code
 * files) gets a tsAliasCacheByRoot entry via loadTsAliases WITHOUT any
 * parsedCacheByRoot insert, so gating eviction on the parse-cache size
 * alone lets the alias cache grow without bound in a long-lived process
 * indexing many distinct doc-only roots. Each map evicts its own oldest
 * root on overflow; evicting a parse-cache root also drops that root's
 * alias entry, and evicting an alias-only root leaves any parse cache it
 * may still hold intact (aliases are recomputable on the next load).
 */
function evictOldestRootCacheIfNeeded(): void {
  if (parsedCacheByRoot.size >= MAX_INDEXED_PROJECT_ROOTS) {
    const oldestRoot = parsedCacheByRoot.keys().next().value
    if (oldestRoot !== undefined) {
      parsedCacheByRoot.delete(oldestRoot)
      tsAliasCacheByRoot.delete(oldestRoot)
    }
  }
  if (tsAliasCacheByRoot.size >= MAX_INDEXED_PROJECT_ROOTS) {
    const oldestRoot = tsAliasCacheByRoot.keys().next().value
    if (oldestRoot !== undefined) {
      tsAliasCacheByRoot.delete(oldestRoot)
    }
  }
}

/**
 * Single write path into parsedCacheByRoot: every insert routes through the
 * FIFO eviction guard so MAX_INDEXED_PROJECT_ROOTS bounds the number of
 * retained per-root caches even when a build/update holds a complete parse
 * result to store (previously those paths called .set directly and bypassed
 * eviction, letting the map grow past the bound).
 */
function setParsedCache(
  projectRoot: string,
  cache: Record<string, ParsedFileTokens>,
): void {
  if (!parsedCacheByRoot.has(projectRoot)) {
    evictOldestRootCacheIfNeeded()
  }
  parsedCacheByRoot.set(projectRoot, cache)
}

/** Test hook: number of roots currently holding parse caches. */
export function getParsedCacheRootCount(): number {
  return parsedCacheByRoot.size
}

/** Test hook: number of roots currently holding tsconfig alias caches. */
export function getTsAliasCacheRootCount(): number {
  return tsAliasCacheByRoot.size
}

/**
 * Warn-latch for transient hash-read failures: the same unreadable path
 * previously failed silently on every refresh. Each distinct path warns at
 * most once per process; the latch is FIFO-bounded so a long-lived process
 * indexing many distinct failing paths cannot grow it without bound. Keyed
 * by absolute path so identical relative paths in different projects are
 * warned (and latched) independently.
 */
const HASH_READ_FAILURE_WARN_LATCH_LIMIT = 256
const hashReadFailureWarnedPaths = new Set<string>()

function recordHashReadFailure(
  absolutePath: string,
  relativePath: string,
  error: unknown,
): void {
  if (hashReadFailureWarnedPaths.has(absolutePath)) return
  if (hashReadFailureWarnedPaths.size >= HASH_READ_FAILURE_WARN_LATCH_LIMIT) {
    const oldest = hashReadFailureWarnedPaths.keys().next()
    if (!oldest.done) hashReadFailureWarnedPaths.delete(oldest.value)
  }
  hashReadFailureWarnedPaths.add(absolutePath)
  const message = error instanceof Error ? error.message : String(error)
  console.warn(
    `[metadata-indexer] hash read failed for ${relativePath} (will retry on a later refresh): ${message}`,
  )
}

function getParsedCache(projectRoot: string): Record<string, ParsedFileTokens> {
  let cache = parsedCacheByRoot.get(projectRoot)
  if (!cache) {
    evictOldestRootCacheIfNeeded()
    cache = {}
    parsedCacheByRoot.set(projectRoot, cache)
  }
  return cache
}

export async function buildMetadataIndex(
  projectRoot: string,
  config: IndexingConfig = {},
): Promise<MetadataIndex> {
  tsAliasCacheByRoot.delete(projectRoot)
  const walked = await walkProjectDetailed(
    projectRoot,
    getIndexExcludes(config),
    config.maxFiles,
  )
  const files = walked.files

  const codeFilePaths = files
    .filter((f) => CODE_EXTENSIONS.has(f.ext))
    .map((f) => f.relativePath)

  let tokenScores: Record<string, Record<string, number>> = {}
  let tokenCallers: Record<string, Record<string, string[]>> = {}
  let parseDiagnostics: ParseDiagnostic[] = []
  let parseCoverage: ParseCoverage | undefined
  let parseData: Record<string, ParsedFileTokens> = {}
  const parsedSourceHashes = new Map<string, string>()
  if (codeFilePaths.length > 0) {
    try {
      const data = await getFileTokenScores(
        projectRoot,
        codeFilePaths,
        (filePath) => {
          const content = fs.readFileSync(
            path.join(projectRoot, filePath),
            'utf8',
          )
          parsedSourceHashes.set(filePath, hashContent(content))
          return content
        },
      )
      tokenScores = data.tokenScores
      tokenCallers = data.tokenCallers
      parseDiagnostics = data.diagnostics
      parseCoverage = data.coverage
      parseData = data.parsed
      setParsedCache(projectRoot, parseData)
    } catch (error) {
      parseDiagnostics = [createParseDiagnostic(projectRoot, error)]
    }
  }

  const indexedFiles: Record<string, IndexedFile> = {}

  // One yield gate per invocation: concurrent buildMetadataIndex calls each
  // get their own time slice instead of sharing one (see
  // createEventLoopYieldGate).
  const yieldToEventLoop = createEventLoopYieldGate()

  for (const file of files) {
    // Macrotask yield so a cold build does not starve the TUI (see
    // createEventLoopYieldGate). Precedes all per-file work; loop-carried state
    // (indexedFiles) is mutated only below the yield.
    await yieldToEventLoop()
    const indexed = await indexWalkedFile({
      absolutePath: file.absolutePath,
      projectRoot,
      relativePath: file.relativePath,
      mtime: file.mtime,
      size: file.size,
      ext: file.ext,
      asset: file.asset,
      tokenScores: tokenScores[file.relativePath] ?? {},
      astImports: parseData[file.relativePath]?.imports,
      parsedSourceHash: parsedSourceHashes.get(file.relativePath),
      yieldToEventLoop,
    })
    if (indexed) {
      indexedFiles[file.relativePath] = indexed
      if (
        parseData[file.relativePath] &&
        parsedSourceHashes.get(file.relativePath) !== indexed.hash
      ) {
        delete parseData[file.relativePath]
        parseDiagnostics.push({
          filePath: file.relativePath,
          stage: 'parse',
          message:
            'Source changed between parsing and publication; cached parse was discarded',
        })
      }
    }
  }

  const index = await createMetadataIndex(
    projectRoot,
    indexedFiles,
    tokenCallers,
    config.weights?.graph,
    parseDiagnostics,
    parseData,
  )
  index.coverage = createIndexCoverage(walked, parseCoverage)
  index.updateStats = {
    hashedFiles: Object.keys(indexedFiles).length,
    parsedFiles: parseCoverage?.freshParsedFiles ?? 0,
    graphFilesUpdated: Object.keys(indexedFiles).length,
    graphEdgesUpdated: index.graph.edges.length,
    postingsUpdated: Object.keys(index.queryData?.postings ?? {}).length,
    changedFiles: Object.keys(indexedFiles).sort(),
    deletedFiles: [],
  }
  index.freshness = parseDiagnostics.length ? 'unverified' : 'verified'
  index.unverifiedPaths = parseDiagnostics.map(
    (diagnostic) => diagnostic.filePath,
  )
  return index
}

export async function updateMetadataIndex(
  existing: MetadataIndex,
  projectRoot: string,
  config: IndexingConfig = {},
  mutationDelta?: IndexMutationDelta,
): Promise<MetadataIndex> {
  tsAliasCacheByRoot.delete(projectRoot)
  if (
    mutationDelta?.complete === true &&
    mutationDelta.revision !== undefined &&
    existing.workspaceRevision !== undefined &&
    compareRevisions(mutationDelta.revision, existing.workspaceRevision) < 0
  )
    return { ...existing, builtAt: Date.now() }

  const preciseDelta =
    mutationDelta?.complete === true && !mutationDelta.coverageGap
  const walked = preciseDelta
    ? await collectPreciseWalk(existing, projectRoot, mutationDelta!, config)
    : await walkProjectDetailed(
        projectRoot,
        getIndexExcludes(config),
        config.maxFiles,
      )
  const files = walked.files
  const yieldToEventLoop = createEventLoopYieldGate()
  const currentByPath = new Map(files.map((file) => [file.relativePath, file]))
  const changedDeltaPaths = new Set(
    (mutationDelta?.changedPaths ?? []).map(normalizeMutationPath),
  )
  const deletedPaths = preciseDelta
    ? new Set((mutationDelta?.deletedPaths ?? []).map(normalizeMutationPath))
    : new Set(
        Object.keys(existing.files).filter(
          (filePath) => !currentByPath.has(filePath),
        ),
      )
  if (preciseDelta) {
    for (const filePath of changedDeltaPaths) {
      if (!currentByPath.has(filePath) && existing.files[filePath])
        deletedPaths.add(filePath)
    }
  }
  const updatedFiles = { ...existing.files }
  const changedFiles: typeof files = []
  const hashByPath = new Map<string, string>()
  const hashReadFailedPaths = new Set<string>()
  const contentReadFailedPaths = new Set<string>()
  const readDiagnostics: ParseDiagnostic[] = []
  let hashedFiles = 0
  for (const file of files) {
    await yieldToEventLoop()
    const indexed = existing.files[file.relativePath]
    if (preciseDelta && !changedDeltaPaths.has(file.relativePath)) continue
    let hash: string | undefined
    // Known dirty paths and coverage gaps always rehash. Stat equality is
    // merely an accelerator for files covered by a continuous journal.
    if (
      indexed &&
      !changedDeltaPaths.has(file.relativePath) &&
      !mutationDelta?.verifyContent
    ) {
      try {
        const stat = await fs.promises.stat(file.absolutePath)
        if (
          indexed.mtime === stat.mtimeMs &&
          indexed.size === stat.size &&
          indexed.mtime === file.mtime &&
          indexed.size === file.size
        )
          hash = indexed.hash
      } catch {
        /* Rehash when stat cannot attest the cached identity. */
      }
    }
    if (hash === undefined) {
      try {
        hashedFiles += 1
        hash = file.asset
          ? await hashBinaryFile(file.absolutePath)
          : await hashFile(file.absolutePath)
      } catch (error) {
        hashReadFailedPaths.add(file.relativePath)
        recordHashReadFailure(file.absolutePath, file.relativePath, error)
        readDiagnostics.push({
          filePath: file.relativePath,
          stage: 'read',
          message: error instanceof Error ? error.message : String(error),
        })
        continue
      }
    }
    await yieldToEventLoop()
    hashByPath.set(file.relativePath, hash)
    const derivedMetadataPath = file.asset
      ? `.openbuff/artifacts/3d/metadata/${hash}.json`
      : undefined
    let hasNewDerivedMetadata = false
    if (
      derivedMetadataPath &&
      indexed?.asset?.derivedMetadataPath !== derivedMetadataPath
    ) {
      try {
        await fs.promises.stat(
          path.join(projectRoot, ...derivedMetadataPath.split('/')),
        )
        hasNewDerivedMetadata = true
      } catch {
        /* Optional derived asset metadata. */
      }
    }
    if (!indexed || indexed.hash !== hash || hasNewDerivedMetadata)
      changedFiles.push(file)
    else if (indexed.mtime !== file.mtime || indexed.size !== file.size)
      updatedFiles[file.relativePath] = {
        ...indexed,
        mtime: file.mtime,
        size: file.size,
      }
  }

  const allCodePaths = files
    .filter((file) => CODE_EXTENSIONS.has(file.ext))
    .map((file) => file.relativePath)
  const currentFingerprints = getParseFingerprints(allCodePaths)
  const previousParse = existing.parseData ?? {}
  const changedPathSet = new Set(changedFiles.map((file) => file.relativePath))
  const parsePaths = allCodePaths.filter(
    (filePath) =>
      !hashReadFailedPaths.has(filePath) &&
      (changedPathSet.has(filePath) ||
        !previousParse[filePath] ||
        existing.parseFingerprints?.[filePath] !==
          currentFingerprints[filePath]),
  )
  let parseData = { ...previousParse }
  const parseFingerprints = { ...(existing.parseFingerprints ?? {}) }
  let parseDiagnostics = (existing.parseDiagnostics ?? []).filter(
    (diagnostic) =>
      currentByPath.has(diagnostic.filePath) &&
      !parsePaths.includes(diagnostic.filePath),
  )
  let parsedFiles = 0
  let parseCoverage = existing.coverage?.parser
  const parseContents = new Map<string, string>()
  const failedParsePaths = new Set<string>()
  let tokenScores: Record<string, Record<string, number>> = {}
  if (parsePaths.length) {
    try {
      const data = await getFileTokenScores(
        projectRoot,
        parsePaths,
        async (filePath) => {
          const content = await fs.promises.readFile(
            path.join(projectRoot, filePath),
            'utf8',
          )
          parseContents.set(filePath, content)
          return content
        },
      )
      parsedFiles = data.coverage.freshParsedFiles
      tokenScores = data.tokenScores
      parseData = { ...parseData, ...data.parsed }
      parseDiagnostics = [...parseDiagnostics, ...data.diagnostics]
      parseCoverage = data.coverage
      for (const filePath of parsePaths) {
        if (data.parsed[filePath])
          parseFingerprints[filePath] =
            data.parsed[filePath]!.extractionFingerprint ??
            currentFingerprints[filePath]!
        else {
          failedParsePaths.add(filePath)
          // Keep the last valid source and its parse together after a failed
          // derivation. The path remains explicitly unverified for discovery.
          if (!previousParse[filePath]) delete parseData[filePath]
        }
      }
    } catch (error) {
      return {
        ...existing,
        parserDegraded: true,
        freshness: 'unverified',
        unverifiedPaths: parsePaths,
        parseDiagnostics: [createParseDiagnostic(projectRoot, error)],
        coverage: createIndexCoverage(walked, parseCoverage),
        updateStats: {
          hashedFiles,
          parsedFiles,
          graphFilesUpdated: 0,
          changedFiles: [],
          deletedFiles: [],
        },
      }
    }
  }
  for (const filePath of deletedPaths) {
    delete updatedFiles[filePath]
    delete parseData[filePath]
    delete parseFingerprints[filePath]
  }
  const reindexPaths = new Set([...changedPathSet, ...parsePaths])
  for (const filePath of reindexPaths) {
    await yieldToEventLoop()
    const file = currentByPath.get(filePath)
    if (
      !file ||
      hashReadFailedPaths.has(filePath) ||
      (failedParsePaths.has(filePath) && existing.files[filePath])
    )
      continue
    const previous = existing.files[filePath]
    const indexed = await indexWalkedFile({
      absolutePath: file.absolutePath,
      projectRoot,
      relativePath: filePath,
      mtime: file.mtime,
      size: file.size,
      ext: file.ext,
      asset: file.asset,
      hash: hashByPath.get(filePath),
      content: parseContents.get(filePath),
      tokenScores: tokenScores[filePath] ?? {},
      astImports: parseData[filePath]?.imports,
      previousChunks:
        existing.parseFingerprints?.[filePath] === currentFingerprints[filePath]
          ? previous?.chunks
          : undefined,
      previousHash: previous?.hash,
      readFailedPaths: contentReadFailedPaths,
      yieldToEventLoop,
    })
    if (indexed) updatedFiles[filePath] = indexed
    else if (!contentReadFailedPaths.has(filePath))
      delete updatedFiles[filePath]
  }
  for (const filePath of contentReadFailedPaths) {
    if (previousParse[filePath]) parseData[filePath] = previousParse[filePath]!
    else delete parseData[filePath]
    if (existing.parseFingerprints?.[filePath])
      parseFingerprints[filePath] = existing.parseFingerprints[filePath]!
    else delete parseFingerprints[filePath]
    readDiagnostics.push({
      filePath,
      stage: 'read',
      message: 'Source content could not be read during reconciliation',
    })
  }
  parseDiagnostics.push(...readDiagnostics)
  setParsedCache(projectRoot, parseData)

  const changedFacts = new Set([
    ...deletedPaths,
    ...Object.keys(updatedFiles).filter(
      (filePath) => updatedFiles[filePath] !== existing.files[filePath],
    ),
  ])
  const graphChangedPaths = new Set([
    ...Array.from(changedFacts).filter(
      (filePath) =>
        existing.files[filePath]?.hash !== updatedFiles[filePath]?.hash,
    ),
    ...parsePaths.filter(
      (filePath) =>
        !failedParsePaths.has(filePath) &&
        !contentReadFailedPaths.has(filePath),
    ),
  ])
  const sourceConfigFingerprint = getSourceConfigurationFingerprint(
    updatedFiles,
    projectRoot,
  )
  const graphConfigFingerprint = getGraphConfigurationFingerprint(
    sourceConfigFingerprint,
    config.weights?.graph,
  )
  const configChanged =
    existing.graphConfigFingerprint !== graphConfigFingerprint
  const dependencies = updateGraphDependencies(
    existing,
    updatedFiles,
    parseData,
    graphChangedPaths,
  )
  let graphData: Record<string, IndexGraph>
  let graphFilesUpdated = 0
  let graphUpdatedPaths = new Set<string>()
  if (!existing.graphData || !existing.graphDependencies || configChanged) {
    const aliases = loadTsAliases(projectRoot)
    const structural = await buildGraph(
      updatedFiles,
      {},
      aliases,
      resolveGraphWeights(config.weights?.graph),
      parseData,
      createTsModuleResolver({ projectRoot, files: updatedFiles, aliases }),
      yieldToEventLoop,
      undefined,
      dependencies.definitions,
    )
    graphData = partitionGraphBySource(structural, updatedFiles)
    graphFilesUpdated = Object.keys(updatedFiles).length
    graphUpdatedPaths = new Set([...Object.keys(updatedFiles), ...deletedPaths])
  } else {
    const affected = collectAffectedGraphPaths(
      existing,
      updatedFiles,
      parseData,
      graphChangedPaths,
      dependencies,
    )
    graphUpdatedPaths = affected
    graphFilesUpdated = Array.from(affected).filter((filePath) =>
      Boolean(updatedFiles[filePath]),
    ).length
    graphData = { ...existing.graphData }
    for (const filePath of deletedPaths) delete graphData[filePath]
    if (affected.size) {
      const aliases = loadTsAliases(projectRoot)
      const structural = await buildGraph(
        updatedFiles,
        {},
        aliases,
        resolveGraphWeights(config.weights?.graph),
        parseData,
        createTsModuleResolver({ projectRoot, files: updatedFiles, aliases }),
        yieldToEventLoop,
        affected,
        dependencies.definitions,
      )
      Object.assign(
        graphData,
        partitionGraphBySource(structural, updatedFiles, affected),
      )
    }
  }
  const graph = composeGraphLayers(
    graphData,
    existing,
    updatedFiles,
    sourceConfigFingerprint,
  )
  const queryData =
    changedFacts.size || graph !== existing.graph
      ? await updateIndexQueryDataAsync(
          existing,
          updatedFiles,
          graph,
          changedFacts,
          yieldToEventLoop,
        )
      : existing.queryData
  const skippedPaths = new Set([
    ...allCodePaths.filter((filePath) => !parseData[filePath]),
    ...failedParsePaths,
  ])
  if (parseCoverage)
    parseCoverage = {
      ...parseCoverage,
      requestedFiles: allCodePaths.length,
      parsedFiles: allCodePaths.length - skippedPaths.size,
      freshParsedFiles: parsedFiles,
      reusedFiles: Math.max(
        0,
        allCodePaths.length - skippedPaths.size - parsedFiles,
      ),
      skippedFiles: skippedPaths.size,
      skippedPrefixes: Array.from(
        new Set(
          Array.from(skippedPaths).map((filePath) =>
            filePath.includes('/') ? filePath.split('/')[0]! : '.',
          ),
        ),
      ).sort(),
      skippedLanguages: Array.from(
        new Set(
          Array.from(skippedPaths).map((filePath) => path.extname(filePath)),
        ),
      ).sort(),
      truncated: skippedPaths.size > 0,
    }
  const unverifiedPaths = Array.from(
    new Set([
      ...hashReadFailedPaths,
      ...contentReadFailedPaths,
      ...failedParsePaths,
    ]),
  ).sort()
  return {
    ...existing,
    builtAt: Date.now(),
    parserDegraded: undefined,
    files: updatedFiles,
    fileCount: Object.keys(updatedFiles).length,
    graph,
    graphData,
    graphDependencies: dependencies,
    graphConfigFingerprint,
    sourceConfigFingerprint,
    queryData,
    parseData,
    parseFingerprints,
    parseDiagnostics,
    freshness: unverifiedPaths.length ? 'unverified' : 'verified',
    unverifiedPaths,
    coverage: createIndexCoverage(walked, parseCoverage),
    updateStats: {
      hashedFiles,
      parsedFiles,
      graphFilesUpdated,
      graphEdgesUpdated: countUpdatedGraphEdges(
        existing,
        graphData,
        graph,
        graphUpdatedPaths,
      ),
      postingsUpdated: Array.from(
        new Set([
          ...Object.keys(existing.queryData?.postings ?? {}),
          ...Object.keys(queryData?.postings ?? {}),
        ]),
      ).filter(
        (token) =>
          existing.queryData?.postings[token] !== queryData?.postings[token],
      ).length,
      changedFiles: Array.from(changedFacts)
        .filter((filePath) => Boolean(updatedFiles[filePath]))
        .sort(),
      deletedFiles: Array.from(deletedPaths).sort(),
    },
  }
}

async function indexWalkedFile(params: {
  projectRoot: string
  absolutePath: string
  relativePath: string
  mtime: number
  size: number
  ext: string
  asset?: { kind: '3d'; format: string }
  hash?: string
  /** Exact source text used by the parse of this changed file. */
  content?: string
  parsedSourceHash?: string
  tokenScores: Record<string, number>
  /**
   * P3-T5 AST import-capture tier: import specifiers captured by the
   * code-map tags query for this file's language (five tier languages).
   * Empty/undefined keeps the line-based fallback byte-identical.
   */
  astImports?: string[]
  previousChunks?: IndexedFile['chunks']
  previousHash?: string
  /**
   * Caller-collected set of relative paths whose content read failed
   * transiently inside this function, so the caller can keep the previous
   * indexed entry instead of dropping a still-existing file.
   */
  readFailedPaths?: Set<string>
  /** Macrotask yield gate owned by the calling index build/update run. */
  yieldToEventLoop: () => Promise<void>
}): Promise<IndexedFile | null> {
  // Skip binary files entirely — they cannot be parsed as UTF-8 text and
  // reading them would corrupt the index with garbage imports/symbols.
  // The file-walker already skips these, but this is a defense-in-depth
  // guard in case files are added through a different path.
  if (params.asset) {
    let hash: string
    try {
      hash = params.hash ?? (await hashBinaryFile(params.absolutePath))
    } catch {
      return null
    }
    const formatConcept = `3d ${params.asset.format}`
    let concepts = [formatConcept, '3d asset']
    let derivedMetadataPath: string | undefined
    const metadataRelativePath = `.openbuff/artifacts/3d/metadata/${hash}.json`
    try {
      const metadata = JSON.parse(
        await fs.promises.readFile(
          path.join(params.projectRoot, ...metadataRelativePath.split('/')),
          'utf8',
        ),
      ) as { sourceHash?: string; concepts?: unknown }
      if (metadata.sourceHash === hash && Array.isArray(metadata.concepts)) {
        concepts = [
          ...concepts,
          ...metadata.concepts.filter(
            (concept): concept is string =>
              typeof concept === 'string' && concept.length <= 160,
          ),
        ].slice(0, 202)
        derivedMetadataPath = metadataRelativePath
      }
    } catch {
      // Derived metadata is optional; the path/format index remains valid.
    }
    return {
      path: params.relativePath,
      mtime: params.mtime,
      size: params.size,
      hash,
      ext: params.ext,
      symbols: [],
      imports: [],
      headings: [],
      concepts,
      contentSample: `${params.asset.format} 3D asset (${params.size} bytes)`,
      asset: {
        kind: '3d',
        format: params.asset.format,
        sizeBytes: params.size,
        ...(derivedMetadataPath ? { derivedMetadataPath } : {}),
      },
    }
  }
  if (BINARY_EXTENSIONS.has(params.ext)) {
    return null
  }
  let content = ''
  try {
    content =
      params.content ??
      (await fs.promises.readFile(params.absolutePath, 'utf8'))
  } catch {
    // Transient read failure: report it so the caller can keep the previous
    // indexed entry for this still-walked file instead of dropping it.
    params.readFailedPaths?.add(params.relativePath)
    return null
  }

  const exactContentHash = hashContent(content)
  const parseMatches =
    !params.parsedSourceHash || params.parsedSourceHash === exactContentHash
  const symbols = parseMatches ? getTopSymbols(params.tokenScores, 30) : []
  const imports = extractImports(
    content,
    params.ext,
    parseMatches ? params.astImports : undefined,
  )
  const headings = DOC_EXTENSIONS.has(params.ext)
    ? extractHeadings(content)
    : []
  const configConcepts = extractConfigConcepts(params.relativePath, content)
  const baseConcepts = DOC_EXTENSIONS.has(params.ext)
    ? extractConcepts(content, headings)
    : CODE_EXTENSIONS.has(params.ext)
      ? extractCodeComments(content)
      : CONFIG_EXTENSIONS.has(params.ext)
        ? configConcepts
        : []
  const concepts = mergeConcepts(baseConcepts, configConcepts)
  const contentSampleRaw = content
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .slice(0, 120)
    .join('\n')
  const contentSampleSliced = contentSampleRaw.slice(0, 4_000)
  const contentSampleTruncated =
    contentSampleSliced.length < contentSampleRaw.length
  const contentSample = contentSampleTruncated
    ? `${contentSampleSliced}…[truncated]`
    : contentSampleSliced

  // Extract asset references from game engine text files (Unity .meta/.prefab/.unity,
  // Godot .tscn/.tres, Unreal .uproject, Bevy configs). Returns [] for non-asset files.
  const assetRefs = extractAssetRefs(content, params.ext, params.relativePath)

  // Intra-file yield seam: the content read / imports / headings / concepts /
  // content-sample extraction block above and the tree-sitter chunk
  // extraction block below each stay within one time slice (a single
  // whole-file tree-sitter chunk parse is one atomic native call — the
  // documented residual exception; see createEventLoopYieldGate).
  await params.yieldToEventLoop()

  // Phase A2 (additive): chunk summaries for code files only. Reuses the
  // already-read `content`; never re-reads disk. Errors or empty results
  // leave `chunks` undefined to keep the cache compact.
  let chunks: IndexedFile['chunks']
  // Content hash, computed AT MOST once per file: on the cold-build path
  // buildMetadataIndex passes no `hash`, and this full synchronous SHA-256
  // over the entire content used to run twice per code file (once for
  // chunk freshness here and once for the indexed record below) inside the
  // yield-seam-bounded block. Non-code files hash lazily at the return.
  let contentHash: string | undefined
  if (CODE_EXTENSIONS.has(params.ext)) {
    contentHash = exactContentHash
    if (
      params.previousChunks &&
      params.previousHash &&
      contentHash === params.previousHash
    ) {
      chunks = params.previousChunks.slice(0, 100)
      if (chunks.length === 0) chunks = undefined
    } else
      try {
        const rawChunks = await extractCodeChunks(content, params.relativePath)
        if (rawChunks.length > 0) {
          chunks = rawChunks.slice(0, 100).map((chunk) => ({
            chunkId: chunk.chunkId,
            qualifiedName: chunk.qualifiedName,
            kind: chunk.kind,
            startLine: chunk.startLine,
            endLine: chunk.endLine,
            hash: chunk.hash,
            stableChunkId: chunk.stableChunkId,
            signature: chunk.signature,
          }))
          if (chunks.length === 0) chunks = undefined
        }
      } catch {
        chunks = undefined
      }
  }

  return {
    path: params.relativePath,
    mtime: params.mtime,
    size: params.size,
    hash: exactContentHash,
    ext: params.ext,
    symbols,
    imports,
    headings,
    concepts,
    contentSample,
    ...(chunks ? { chunks } : {}),
    ...(assetRefs.length > 0 ? { assetRefs } : {}),
  }
}

function getParseFingerprints(filePaths: string[]): Record<string, string> {
  const byExtension = new Map<string, string>()
  const fingerprints: Record<string, string> = {}
  for (const filePath of filePaths) {
    const extension = path.extname(filePath).toLowerCase()
    if (!byExtension.has(extension))
      byExtension.set(extension, getParserExtractionFingerprint(filePath))
    fingerprints[filePath] = byExtension.get(extension)!
  }
  return fingerprints
}

function buildGraphDependencies(
  parseData: Record<string, ParsedFileTokens>,
): IndexGraphDependencies {
  const definitions: Record<string, string[]> = Object.create(null)
  const callers: Record<string, string[]> = Object.create(null)
  for (const [filePath, parsed] of Object.entries(parseData)) {
    for (const symbol of new Set(parsed.identifiers))
      (definitions[symbol] ??= []).push(filePath)
    for (const call of new Set(parsed.calls))
      (callers[call] ??= []).push(filePath)
  }
  return { definitions, callers }
}

function updateGraphDependencies(
  previous: MetadataIndex,
  files: Record<string, IndexedFile>,
  parsed: Record<string, ParsedFileTokens>,
  changedPaths: ReadonlySet<string>,
): IndexGraphDependencies {
  if (!previous.graphDependencies) return buildGraphDependencies(parsed)
  const dependencies: IndexGraphDependencies = {
    definitions: Object.assign(
      Object.create(null),
      previous.graphDependencies.definitions,
    ),
    callers: Object.assign(
      Object.create(null),
      previous.graphDependencies.callers,
    ),
  }
  for (const filePath of changedPaths) {
    for (const [field, parseField] of [
      ['definitions', 'identifiers'],
      ['callers', 'calls'],
    ] as const) {
      const before = new Set(previous.parseData?.[filePath]?.[parseField] ?? [])
      const after = new Set(
        files[filePath] ? (parsed[filePath]?.[parseField] ?? []) : [],
      )
      for (const symbol of new Set([...before, ...after])) {
        if (before.has(symbol) === after.has(symbol)) continue
        const members = new Set(dependencies[field][symbol] ?? [])
        if (after.has(symbol)) members.add(filePath)
        else members.delete(filePath)
        if (members.size)
          dependencies[field][symbol] = Array.from(members).sort()
        else delete dependencies[field][symbol]
      }
    }
  }
  return dependencies
}

function collectAffectedGraphPaths(
  previous: MetadataIndex,
  files: Record<string, IndexedFile>,
  parsed: Record<string, ParsedFileTokens>,
  changedPaths: ReadonlySet<string>,
  dependencies: IndexGraphDependencies,
): Set<string> {
  const affected = new Set(changedPaths)
  let importTopologyChanged = false
  const changedGuids = new Set<string>()
  for (const filePath of changedPaths) {
    const oldFile = previous.files[filePath]
    const newFile = files[filePath]
    const before = new Set(previous.parseData?.[filePath]?.identifiers ?? [])
    const after = new Set(parsed[filePath]?.identifiers ?? [])
    for (const symbol of new Set([...before, ...after])) {
      if (before.has(symbol) === after.has(symbol)) continue
      for (const caller of previous.graphDependencies?.callers[symbol] ?? [])
        affected.add(caller)
      for (const caller of dependencies.callers[symbol] ?? [])
        affected.add(caller)
    }
    if (!oldFile || !newFile) importTopologyChanged = true
    if (/\.(?:java|kt|php)$/.test(filePath)) {
      const declaration = (file: IndexedFile | undefined) =>
        file?.contentSample?.match(/(?:package|namespace)\s+[^;\n{]+/)?.[0]
      if (declaration(oldFile) !== declaration(newFile))
        importTopologyChanged = true
    }
    if (filePath.endsWith('.meta')) {
      for (const ref of [
        ...(oldFile?.assetRefs ?? []),
        ...(newFile?.assetRefs ?? []),
      ]) {
        if (ref.refType === 'guid') changedGuids.add(ref.rawRef)
      }
    }
    if (!newFile) {
      for (const edgeIndex of previous.queryData?.adjacency[
        fileNodeId(filePath)
      ] ?? []) {
        const edge = previous.graph.edges[edgeIndex]
        if (edge?.from.startsWith('file:')) affected.add(edge.from.slice(5))
      }
    }
  }
  if (importTopologyChanged) {
    const aliases = loadTsAliases(previous.projectRoot)
    const oldResolver = createTsModuleResolver({
      projectRoot: previous.projectRoot,
      files: previous.files,
      aliases,
    })
    const newResolver = createTsModuleResolver({
      projectRoot: previous.projectRoot,
      files,
      aliases,
    })
    for (const file of Object.values(files)) {
      if (affected.has(file.path)) continue
      for (const specifier of file.imports) {
        if (
          resolveImportToFile(
            file.path,
            file.ext,
            specifier,
            previous.files,
            aliases,
            oldResolver,
          ) !==
          resolveImportToFile(
            file.path,
            file.ext,
            specifier,
            files,
            aliases,
            newResolver,
          )
        ) {
          affected.add(file.path)
          break
        }
      }
      if (
        file.assetRefs?.some(
          (ref) => ref.resolvedPath && changedPaths.has(ref.resolvedPath),
        )
      )
        affected.add(file.path)
    }
  }
  if (changedGuids.size) {
    for (const file of Object.values(files)) {
      if (file.assetRefs?.some((ref) => changedGuids.has(ref.rawRef)))
        affected.add(file.path)
    }
  }
  return affected
}

/** Structural facts are owned by their source; shared nodes stay referenced. */
function partitionGraphBySource(
  graph: IndexGraph,
  files: Record<string, IndexedFile>,
  sourcePaths?: ReadonlySet<string>,
): Record<string, IndexGraph> {
  const grouped: Record<string, IndexGraph> = {}
  for (const filePath of sourcePaths ?? Object.keys(files)) {
    if (files[filePath]) grouped[filePath] = { nodes: {}, edges: [] }
  }
  for (const node of Object.values(graph.nodes)) {
    if (node.path && grouped[node.path])
      grouped[node.path]!.nodes[node.id] = node
  }
  for (const edge of graph.edges) {
    const source = edge.from.startsWith('file:')
      ? edge.from.slice(5)
      : graph.nodes[edge.from]?.path
    const group = source ? grouped[source] : undefined
    if (!group) continue
    group.edges.push(edge)
    const target = graph.nodes[edge.to]
    if (target && target.type !== 'file') group.nodes[target.id] = target
  }
  return grouped
}

function composeGraphLayers(
  structural: Record<string, IndexGraph>,
  previous: MetadataIndex,
  files: Record<string, IndexedFile>,
  sourceConfigFingerprint: string,
): IndexGraph {
  const priorPrecise = previous.graph.edges.filter(
    (edge) => edge.confidence === 'precise',
  )
  const precise = priorPrecise.filter((edge) => {
    const dependencies =
      edge.producer?.sourceHashes ??
      Object.fromEntries(
        [edge.from, edge.to]
          .filter((node) => node.startsWith('file:'))
          .map((node) => [node.slice(5), previous.files[node.slice(5)]?.hash]),
      )
    if (
      Object.entries(dependencies).some(
        ([filePath, hash]) => !hash || files[filePath]?.hash !== hash,
      )
    )
      return false
    const configFingerprint =
      edge.producer?.configFingerprint ?? previous.sourceConfigFingerprint
    return !configFingerprint || configFingerprint === sourceConfigFingerprint
  })
  if (
    previous.graphData &&
    precise.length === priorPrecise.length &&
    Object.keys(structural).length === Object.keys(previous.graphData).length &&
    Object.keys(structural).every(
      (filePath) => structural[filePath] === previous.graphData?.[filePath],
    )
  )
    return previous.graph

  const nodes: Record<string, IndexNode> = {}
  const edges: IndexEdge[] = []
  const preciseTuples = new Set(
    precise.map((edge) => `${edge.from}\0${edge.to}\0${edge.type}`),
  )
  for (const group of Object.values(structural)) {
    Object.assign(nodes, group.nodes)
    for (const edge of group.edges) {
      if (!preciseTuples.has(`${edge.from}\0${edge.to}\0${edge.type}`))
        edges.push(edge)
    }
  }
  edges.push(...precise)
  return { nodes, edges: dedupeEdges(edges) }
}

function countUpdatedGraphEdges(
  previous: MetadataIndex,
  graphData: Record<string, IndexGraph>,
  graph: IndexGraph,
  affected: ReadonlySet<string>,
): number {
  const key = (edge: IndexEdge) =>
    JSON.stringify([
      edge.from,
      edge.to,
      edge.type,
      edge.label ?? '',
      edge.confidence ?? 'heuristic',
    ])
  const before = new Map<string, IndexEdge>()
  const after = new Map<string, IndexEdge>()
  for (const filePath of affected) {
    for (const edge of previous.graphData?.[filePath]?.edges ?? [])
      before.set(key(edge), edge)
    for (const edge of graphData[filePath]?.edges ?? [])
      after.set(key(edge), edge)
  }
  for (const edge of previous.graph.edges)
    if (edge.confidence === 'precise') before.set(key(edge), edge)
  for (const edge of graph.edges)
    if (edge.confidence === 'precise') after.set(key(edge), edge)
  return Array.from(new Set([...before.keys(), ...after.keys()])).filter(
    (edgeKey) => {
      const oldEdge = before.get(edgeKey)
      const newEdge = after.get(edgeKey)
      return (
        oldEdge !== newEdge &&
        (!oldEdge ||
          !newEdge ||
          JSON.stringify(oldEdge) !== JSON.stringify(newEdge))
      )
    },
  ).length
}

/** Compiler/config/dependency inputs are distinct from structural edge weights. */
export function getSourceConfigurationFingerprint(
  files: Record<string, IndexedFile>,
  projectRoot: string,
): string {
  const digest = crypto.createHash('sha256').update('source-configuration:1\0')
  const configuration =
    /(?:^|\/)(?:tsconfig[^/]*\.json|jsconfig[^/]*\.json|package\.json|(?:bun|package|pnpm|yarn|Cargo|composer|poetry|uv).*lock[^/]*|go\.(?:mod|sum)|Cargo\.toml|pyproject\.toml|requirements[^/]*\.txt|pom\.xml|build\.gradle[^/]*|[^/]*\.(?:csproj|fsproj|sln))$/
  for (const filePath of Object.keys(files)
    .filter((filePath) => configuration.test(filePath))
    .sort()) {
    digest
      .update(filePath)
      .update('\0')
      .update(files[filePath]!.hash)
      .update('\0')
  }
  for (const relativePath of [
    'node_modules/.package-lock.json',
    'node_modules/.modules.yaml',
    '.pnp.cjs',
    '.pnp.loader.mjs',
  ]) {
    try {
      const absolutePath = path.join(projectRoot, relativePath)
      const stat = fs.statSync(absolutePath)
      digest.update(relativePath).update('\0')
      if (stat.size <= 1_000_000) digest.update(fs.readFileSync(absolutePath))
      else
        digest.update(`oversized:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`)
    } catch {
      digest.update(`${relativePath}:absent\0`)
    }
  }
  return digest.digest('hex')
}

function getGraphConfigurationFingerprint(
  sourceFingerprint: string,
  weights?: GraphWeights,
): string {
  return crypto
    .createHash('sha256')
    .update(
      JSON.stringify({
        version: 1,
        sourceFingerprint,
        weights: resolveGraphWeights(weights),
      }),
    )
    .digest('hex')
}

async function createMetadataIndex(
  projectRoot: string,
  files: Record<string, IndexedFile>,
  tokenCallers: Record<string, Record<string, string[]>>,
  graphWeights?: GraphWeights,
  parseDiagnostics: ParseDiagnostic[] = [],
  parseData: Record<string, ParsedFileTokens> = {},
): Promise<MetadataIndex> {
  const aliases = loadTsAliases(projectRoot)
  const yieldToEventLoop = createEventLoopYieldGate()
  const dependencies = buildGraphDependencies(parseData)
  const graph = await buildGraph(
    files,
    tokenCallers,
    aliases,
    resolveGraphWeights(graphWeights),
    parseData,
    createTsModuleResolver({ projectRoot, files, aliases }),
    yieldToEventLoop,
    undefined,
    dependencies.definitions,
  )
  const sourceConfigFingerprint = getSourceConfigurationFingerprint(
    files,
    projectRoot,
  )
  return {
    version: '2',
    projectRoot,
    builtAt: Date.now(),
    fileCount: Object.keys(files).length,
    files,
    graph,
    graphData: partitionGraphBySource(graph, files),
    graphDependencies: dependencies,
    sourceConfigFingerprint,
    graphConfigFingerprint: getGraphConfigurationFingerprint(
      sourceConfigFingerprint,
      graphWeights,
    ),
    queryData: await buildIndexQueryDataAsync(files, graph, yieldToEventLoop),
    parseData,
    parseFingerprints: Object.fromEntries(
      Object.entries(parseData).map(([filePath, parsed]) => [
        filePath,
        parsed.extractionFingerprint ??
          getParserExtractionFingerprint(filePath),
      ]),
    ),
    parseDiagnostics,
  }
}

function createIndexCoverage(
  walked: WalkProjectResult,
  parser?: ParseCoverage,
): NonNullable<MetadataIndex['coverage']> {
  return {
    truncated: walked.truncated || Boolean(parser?.truncated),
    maxFiles: walked.maxFiles,
    skippedFiles: walked.skippedFiles,
    skippedPrefixes: walked.skippedPrefixes,
    parser,
  }
}

async function collectPreciseWalk(
  existing: MetadataIndex,
  projectRoot: string,
  mutationDelta: IndexMutationDelta,
  config: IndexingConfig,
): Promise<WalkProjectResult> {
  const deletedPaths = new Set(
    (mutationDelta.deletedPaths ?? []).map(normalizeMutationPath),
  )
  const changedPaths = (mutationDelta.changedPaths ?? []).map(
    normalizeMutationPath,
  )
  const changedPathSet = new Set(changedPaths)
  const stated = await statProjectFiles(
    projectRoot,
    changedPaths,
    getIndexExcludes(config),
  )
  const statedByPath = new Map(stated.map((file) => [file.relativePath, file]))

  const files: WalkedFile[] = []
  for (const [relativePath, indexed] of Object.entries(existing.files)) {
    if (deletedPaths.has(relativePath)) continue
    const overlay = statedByPath.get(relativePath)
    if (overlay) {
      files.push(overlay)
      continue
    }
    // Invariant: changedPaths without a successful stat overlay must be omitted
    // so updateMetadataIndex can add them to deletedPaths.
    if (changedPathSet.has(relativePath)) continue
    files.push(walkedFileFromIndexed(projectRoot, indexed))
  }

  for (const file of stated) {
    if (
      !existing.files[file.relativePath] &&
      !deletedPaths.has(file.relativePath)
    ) {
      files.push(file)
    }
  }

  const coverage = existing.coverage
  return {
    files,
    truncated: coverage?.truncated ?? false,
    maxFiles: coverage?.maxFiles ?? config.maxFiles ?? 20_000,
    skippedFiles: coverage?.skippedFiles ?? 0,
    skippedPrefixes: coverage?.skippedPrefixes ?? [],
  }
}

function walkedFileFromIndexed(
  projectRoot: string,
  indexed: IndexedFile,
): WalkedFile {
  return {
    absolutePath: path.join(projectRoot, indexed.path),
    relativePath: indexed.path,
    ext: indexed.ext,
    mtime: indexed.mtime,
    size: indexed.size,
    ...(indexed.asset
      ? { asset: { kind: '3d' as const, format: indexed.asset.format } }
      : {}),
  }
}

function normalizeMutationPath(filePath: string): string {
  return filePath.replace(/\\/g, '/').replace(/^\.\//, '')
}

function createParseDiagnostic(
  projectRoot: string,
  error: unknown,
): ParseDiagnostic {
  return {
    filePath: projectRoot,
    stage: 'parse',
    message: error instanceof Error ? error.message : String(error),
  }
}

async function buildGraph(
  files: Record<string, IndexedFile>,
  tokenCallers: Record<string, Record<string, string[]>>,
  aliases: TsAliasMap | undefined,
  weights: Required<GraphWeights>,
  parseData: Record<string, ParsedFileTokens> = {},
  tsResolver: TsModuleResolver | null = null,
  yieldToEventLoop: () => Promise<void> = createEventLoopYieldGate(),
  sourcePaths?: ReadonlySet<string>,
  definitionPaths?: Record<string, string[]>,
): Promise<IndexGraph> {
  const nodes: Record<string, IndexNode> = {}
  const edges: IndexEdge[] = []

  // Build a GUID → asset-path map from all indexed .meta files so Unity guid
  // references in .prefab/.unity files can be resolved to actual file paths.
  const guidToPathMap = buildGuidToPathMap(files)

  for (const file of Object.values(files)) {
    if (sourcePaths && !sourcePaths.has(file.path)) continue
    await yieldToEventLoop()
    const fileId = fileNodeId(file.path)
    nodes[fileId] = {
      id: fileId,
      type: 'file',
      label: file.path,
      path: file.path,
    }

    for (const symbol of file.symbols.slice(0, 30)) {
      const symbolId = symbolNodeId(file.path, file.ext, symbol)
      nodes[symbolId] = {
        id: symbolId,
        type: 'symbol',
        label: symbol,
        path: file.path,
      }
      edges.push({
        from: fileId,
        to: symbolId,
        type: 'defines',
        weight: weights.defines,
        label: symbol,
      })
    }

    for (const importPath of file.imports.slice(0, 50)) {
      const importId = importNodeId(importPath)
      nodes[importId] ??= { id: importId, type: 'import', label: importPath }
      edges.push({
        from: fileId,
        to: importId,
        type: 'imports',
        weight: weights.imports,
        label: importPath,
      })
      const resolved = resolveImportToFile(
        file.path,
        file.ext,
        importPath,
        files,
        aliases,
        tsResolver,
      )
      if (resolved) {
        edges.push({
          from: fileId,
          to: fileNodeId(resolved),
          type: 'references',
          weight: weights.references,
          label: importPath,
        })
      }
    }

    for (const heading of file.headings.slice(0, 40)) {
      const headingId = headingNodeId(file.path, heading)
      nodes[headingId] = {
        id: headingId,
        type: 'heading',
        label: heading,
        path: file.path,
      }
      edges.push({
        from: fileId,
        to: headingId,
        type: 'contains_heading',
        weight: weights.containsHeading,
        label: heading,
      })
    }

    for (const concept of file.concepts.slice(0, 80)) {
      const conceptId = conceptNodeId(concept)
      nodes[conceptId] ??= { id: conceptId, type: 'concept', label: concept }
      edges.push({
        from: fileId,
        to: conceptId,
        type: 'mentions',
        weight: weights.mentions,
        label: concept,
      })
    }

    // Create graph edges from asset references (game-engine file → referenced asset).
    // Only resolved refs (GUID → path via guidToPathMap, or res:// → project path)
    // create file→file edges. Unresolved refs are informational only.
    if (file.assetRefs) {
      for (const ref of file.assetRefs.slice(0, 80)) {
        let resolvedPath: string | null = ref.resolvedPath

        // For Unity guid refs, resolve via the GUID → path map.
        // .meta files already have resolvedPath set (self-identifying); only
        // .prefab/.unity refs need lookup.
        if (ref.refType === 'guid' && !resolvedPath) {
          resolvedPath = resolveGuidRef(ref.rawRef, guidToPathMap)
        }

        // Try the resolved path directly. If the asset itself is a binary
        // file (e.g. .png) it won't be in the index — fall back to the .meta
        // file (which IS indexed as text YAML) so the reference edge still
        // connects to a real graph node.
        if (resolvedPath) {
          let edgeTarget: string | null = null
          if (files[resolvedPath]) {
            edgeTarget = resolvedPath
          } else if (files[`${resolvedPath}.meta`]) {
            edgeTarget = `${resolvedPath}.meta`
          }
          if (edgeTarget) {
            edges.push({
              from: fileId,
              to: fileNodeId(edgeTarget),
              type: 'references',
              weight: weights.references,
              label: ref.rawRef,
            })
          }
        }
      }
    }
  }

  for (const [definingFile, callersByToken] of Object.entries(tokenCallers)) {
    await yieldToEventLoop()
    if (!files[definingFile]) continue
    for (const [token, callers] of Object.entries(callersByToken)) {
      for (const callerFile of callers) {
        if (sourcePaths && !sourcePaths.has(callerFile)) continue
        if (!files[callerFile]) continue
        edges.push({
          from: fileNodeId(callerFile),
          to: fileNodeId(definingFile),
          type: 'calls',
          weight: weights.calls,
          label: token,
        })
      }
    }
  }

  edges.push(
    ...(await buildModuleAwareCallEdges(
      files,
      parseData,
      aliases,
      weights.calls,
      tsResolver,
      yieldToEventLoop,
      sourcePaths,
      definitionPaths,
    )),
  )

  return { nodes, edges: dedupeEdges(edges) }
}

async function buildModuleAwareCallEdges(
  files: Record<string, IndexedFile>,
  parseData: Record<string, ParsedFileTokens>,
  aliases: TsAliasMap | undefined,
  weight: number,
  tsResolver: TsModuleResolver | null = null,
  yieldToEventLoop: () => Promise<void> = createEventLoopYieldGate(),
  sourcePaths?: ReadonlySet<string>,
  definitionPaths?: Record<string, string[]>,
): Promise<IndexEdge[]> {
  const definitions = new Map<string, string[]>()
  const definitionMembership = new Map<string, Set<string>>()
  if (definitionPaths) {
    for (const [symbol, paths] of Object.entries(definitionPaths))
      definitions.set(symbol, paths)
  }
  for (const [filePath, parsed] of definitionPaths
    ? []
    : Object.entries(parseData)) {
    await yieldToEventLoop()
    if (!files[filePath]) continue
    for (const symbol of parsed.identifiers) {
      const paths = definitions.get(symbol) ?? []
      let members = definitionMembership.get(symbol)
      if (!members) {
        members = new Set()
        definitionMembership.set(symbol, members)
      }
      if (!members.has(filePath)) {
        members.add(filePath)
        paths.push(filePath)
      }
      definitions.set(symbol, paths)
    }
  }

  // Language family depends only on a file's extension, so resolve it once per
  // file (with its lone path.extname/toLowerCase allocation) instead of once
  // per candidate edge inside the caller-resolution loops below.
  const familyByPath = new Map<string, string>()
  const familyForPath = (filePath: string): string => {
    let family = familyByPath.get(filePath)
    if (family === undefined) {
      family = getLanguageFamily(files[filePath]?.ext)
      familyByPath.set(filePath, family)
    }
    return family
  }

  const edges: IndexEdge[] = []
  for (const [callerPath, parsed] of Object.entries(parseData)) {
    if (sourcePaths && !sourcePaths.has(callerPath)) continue
    await yieldToEventLoop()
    const caller = files[callerPath]
    if (!caller) continue
    const importedFiles = new Set(
      caller.imports
        .map((importPath) =>
          resolveImportToFile(
            caller.path,
            caller.ext,
            importPath,
            files,
            aliases,
            tsResolver,
          ),
        )
        .filter((filePath): filePath is string => Boolean(filePath)),
    )

    // callerLanguage is invariant across this caller's calls and candidates,
    // so hoist it out of the inner loops rather than recomputing it (and its
    // path.extname/toLowerCase allocation) per call and per candidate edge.
    const callerLanguage = familyForPath(callerPath)
    for (const call of parsed.calls) {
      const candidates = (definitions.get(call) ?? []).filter(
        (filePath) => filePath !== callerPath,
      )
      const sameLanguage = candidates.filter(
        (filePath) => familyForPath(filePath) === callerLanguage,
      )
      const languageCandidates = sameLanguage
      const importedCandidates = languageCandidates.filter((filePath) =>
        importedFiles.has(filePath),
      )
      const resolved =
        importedCandidates.length === 1
          ? importedCandidates[0]
          : languageCandidates.length === 1
            ? languageCandidates[0]
            : undefined
      if (!resolved) continue
      edges.push({
        from: fileNodeId(callerPath),
        to: fileNodeId(resolved),
        type: 'calls',
        weight,
        label: call,
      })
    }
  }
  return edges
}

function getIndexExcludes(config: IndexingConfig): string[] {
  const cacheDir = config.cacheDir ?? '.codebuff-index'
  const normalizedCacheDir = sanitizeIndexCacheDir(cacheDir)
  return [
    ...(config.exclude ?? []),
    normalizedCacheDir,
    `${normalizedCacheDir}/`,
  ]
}

function getTopSymbols(
  scores: Record<string, number>,
  limit: number,
): string[] {
  return Object.entries(scores)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([sym]) => sym)
}

/**
 * P3-T5 AST import-capture tier: prefer import specifiers captured by the
 * code-map tree-sitter tags query (the SAME .scm query the parse pipeline
 * runs; see `parseFile`'s @import.* capture grouping and
 * `importSpecifiersFromAstCaptures`) when the parse pipeline produced a
 * non-empty list for a tier language (TypeScript, JavaScript, Python, Go,
 * Rust). AST captures are normalized in code-map to the exact specifier
 * shapes the line-based extractor emits, so downstream resolution
 * (resolveImportToFile / edge building) is untouched.
 *
 * When the parse pipeline exposes no captures — the file's language has no
 * AST tier, the grammar failed to load, or the file produced no @import
 * captures — this falls back byte-identically to the canonical line-based
 * extraction (`extractImportSpecifiers`), which remains the safety net and
 * is NOT removed. Both tiers are capped by the same bound. Exported so the
 * seam contract is directly pinnable in tests.
 */
export function extractImports(
  content: string,
  extension: string,
  astImports?: string[],
): string[] {
  if (astImports && astImports.length > 0) {
    return astImports.slice(0, AST_IMPORT_SPECIFIER_LIMIT)
  }
  return extractImportSpecifiers(content, extension)
}

function extractHeadings(content: string): string[] {
  const headings: string[] = []
  for (const line of content.split('\n')) {
    const m = line.match(/^#{1,6}\s+(.+)$/)
    if (m) headings.push(m[1].trim())
  }
  return headings
}

function extractConcepts(content: string, headings: string[]): string[] {
  const concepts = new Set<string>()
  for (const heading of headings) {
    for (const token of conceptTokens(heading)) concepts.add(token)
    const normalized = normalizeConcept(heading)
    if (normalized) concepts.add(normalized)
  }

  let match: RegExpExecArray | null
  const regex = new RegExp(MARKDOWN_LINK_REGEX.source, 'g')
  while ((match = regex.exec(content)) !== null) {
    const href = match[1]
    if (!href) continue
    const base = href.split('#')[0]?.split('?')[0] ?? href
    const label = path.basename(base).replace(/\.[a-z0-9]+$/i, '')
    for (const token of conceptTokens(label)) concepts.add(token)
  }

  return Array.from(concepts).filter(Boolean).slice(0, 120)
}

function conceptTokens(text: string): string[] {
  return normalizeConcept(text)
    .split(/[\s\-_./]+/)
    .filter((token) => token.length >= 3)
}

function extractConfigConcepts(filePath: string, content: string): string[] {
  if (filePath.endsWith('package.json')) {
    return extractPackageJsonConcepts(content)
  }
  const languageManifestConcepts = extractLanguageManifestConcepts(filePath)
  if (languageManifestConcepts.length > 0) {
    return mergeConcepts(languageManifestConcepts, conceptTokens(content))
  }
  if (isCiWorkflowPath(filePath)) {
    return extractCiWorkflowConcepts(content)
  }
  if (isTaskRunnerPath(filePath)) {
    return [
      'command configuration',
      'task runner',
      ...conceptTokens(content).slice(0, 80),
    ]
  }
  return []
}

function extractLanguageManifestConcepts(filePath: string): string[] {
  const normalized = filePath.toLowerCase().replace(/\\/g, '/')
  const baseName = path.posix.basename(normalized)
  const conceptsByManifest: Record<string, string[]> = {
    'cargo.toml': [
      'rust manifest',
      'cargo check',
      'cargo test',
      'cargo clippy',
      'cargo fmt',
    ],
    'go.mod': ['go module', 'go test ./...', 'go vet ./...', 'gofmt'],
    'pyproject.toml': [
      'python manifest',
      'pytest',
      'ruff check',
      'mypy',
      'pyright',
    ],
    'requirements.txt': ['python dependencies', 'pytest', 'ruff check'],
    'pom.xml': ['java manifest', 'maven', 'mvn test', 'mvn verify'],
    'build.gradle': ['gradle build', 'gradle test', 'java manifest'],
    'build.gradle.kts': ['gradle build', 'gradle test', 'kotlin manifest'],
    'composer.json': [
      'php manifest',
      'composer test',
      'phpunit',
      'phpstan',
      'psalm',
    ],
    'package.swift': ['swift package', 'swift build', 'swift test'],
    gemfile: ['ruby dependencies', 'bundle exec rspec', 'bundle exec rubocop'],
    'project.godot': [
      'godot project',
      'godot headless validation',
      'godot test',
    ],
    'cmakelists.txt': ['cmake project', 'cmake build', 'ctest', 'clang tidy'],
  }
  if (conceptsByManifest[baseName]) return conceptsByManifest[baseName]
  if (baseName.endsWith('.csproj') || baseName.endsWith('.sln')) {
    return ['dotnet project', 'dotnet build', 'dotnet test', 'dotnet format']
  }
  return []
}

function mergeConcepts(primary: string[], secondary: string[]): string[] {
  if (secondary.length === 0) return primary
  return Array.from(new Set([...primary, ...secondary])).slice(0, 160)
}

/**
 * Raw command text (package.json script bodies, CI `run:`/`name:` lines) is
 * embedded verbatim as a query-facing concept; cap each such concept so a
 * pathological multi-kilobyte command cannot dominate the concept index.
 */
const MAX_RAW_CONCEPT_LENGTH = 200
const clampRawConcept = (concept: string): string =>
  concept.length > MAX_RAW_CONCEPT_LENGTH
    ? concept.slice(0, MAX_RAW_CONCEPT_LENGTH)
    : concept

function extractPackageJsonConcepts(content: string): string[] {
  const concepts = new Set<string>([
    'package manifest',
    'package scripts',
    'command configuration',
  ])
  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch {
    return Array.from(concepts)
  }
  if (!parsed || typeof parsed !== 'object' || !('scripts' in parsed)) {
    return Array.from(concepts)
  }

  const scripts = (parsed as { scripts?: unknown }).scripts
  if (!scripts || typeof scripts !== 'object') return Array.from(concepts)

  for (const [name, command] of Object.entries(scripts)) {
    if (typeof command !== 'string') continue
    concepts.add(name)
    concepts.add(`script ${name}`)
    concepts.add(clampRawConcept(`script:${name}=${command}`))
    for (const token of conceptTokens(`${name} ${command}`)) concepts.add(token)
  }
  return Array.from(concepts).slice(0, 160)
}

function extractCiWorkflowConcepts(content: string): string[] {
  const concepts = new Set<string>([
    'ci workflow',
    'github actions',
    'validation suite',
    'command configuration',
  ])
  for (const line of content.split('\n')) {
    const trimmed = line.trim()
    if (/^(?:-\s*)?(run|uses|name):\s+/i.test(trimmed)) {
      const isRunCommand = /^(?:-\s*)?run:/i.test(trimmed)
      concepts.add(
        clampRawConcept(
          isRunCommand
            ? trimmed.startsWith('run:')
              ? trimmed
              : `run:${trimmed}`
            : trimmed,
        ),
      )
      for (const token of conceptTokens(trimmed)) concepts.add(token)
    }
  }
  return Array.from(concepts).slice(0, 160)
}

function isCiWorkflowPath(filePath: string): boolean {
  return (
    filePath.startsWith('.github/workflows/') ||
    filePath.includes('/.github/workflows/')
  )
}

function isTaskRunnerPath(filePath: string): boolean {
  const normalized = filePath.toLowerCase().replace(/\\/g, '/')
  return (
    normalized.endsWith('makefile') ||
    normalized.endsWith('justfile') ||
    normalized.endsWith('turbo.json') ||
    normalized.endsWith('nx.json') ||
    normalized.endsWith('gulpfile.js') ||
    normalized.endsWith('gruntfile.js')
  )
}

/**
 * Extract concept tokens from code comments/docstrings so queries matching
 * phrases in commentary (not just symbol names) have recall. Handles `//` and
 * `/* *\/` (C-family), `#` line comments (Python/Ruby/Go shebang-style), and
 * triple-quoted docstrings. Capped to bound index growth.
 */
function extractCodeComments(content: string): string[] {
  const concepts = new Set<string>()
  const add = (text: string) => {
    for (const token of conceptTokens(text)) concepts.add(token)
  }

  // Block comments and triple-quoted docstrings.
  const blockRegex = /\/\*[\s\S]*?\*\/|"""[\s\S]*?"""|'''[\s\S]*?'''/g
  let match: RegExpExecArray | null
  while ((match = blockRegex.exec(content)) !== null && concepts.size < 200) {
    add(match[0])
  }

  // Line comments: `// ...` anywhere, or a line that (after trimming) starts
  // with `#` (avoids matching TS private fields like `this.#x`).
  for (const line of content.split('\n')) {
    if (concepts.size >= 200) break
    const slashIdx = line.indexOf('//')
    if (slashIdx >= 0) add(line.slice(slashIdx + 2))
    const trimmed = line.trimStart()
    if (trimmed.startsWith('#')) add(trimmed.slice(1))
  }

  return Array.from(concepts).filter(Boolean).slice(0, 120)
}

function normalizeConcept(text: string): string {
  return text
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

async function hashFile(filePath: string): Promise<string> {
  return hashContent(await fs.promises.readFile(filePath, 'utf8'))
}

async function hashBinaryFile(filePath: string): Promise<string> {
  // Hash raw bytes so binary 3D assets have a stable source identity. UTF-8
  // decoding before hashing changes invalid byte sequences and breaks the
  // hash-bound derived metadata cache.
  const hash = crypto.createHash('sha256')
  for await (const chunk of fs.createReadStream(filePath)) {
    hash.update(chunk)
  }
  return hash.digest('hex')
}

function hashContent(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex')
}

function fileNodeId(filePath: string): string {
  return `file:${filePath}`
}

function symbolNodeId(
  filePath: string,
  extension: string,
  symbol: string,
): string {
  return `symbol:${extension}:${filePath}#${symbol}`
}

function importNodeId(importPath: string): string {
  return `import:${importPath}`
}

function headingNodeId(filePath: string, heading: string): string {
  return `heading:${filePath}#${heading}`
}

function conceptNodeId(concept: string): string {
  return `concept:${concept}`
}

export type { TsAliasMap } from './import-resolution'
import type { TsAliasMap } from './import-resolution'

/**
 * Upper bound on tsconfig project references followed per loadTsAliases walk;
 * a hostile or accidental reference fan-out cannot grow the walk without
 * bound (cycles are separately bounded by the shared visited set).
 */
const MAX_TSCONFIG_REFERENCES = 32

/**
 * Load tsconfig `compilerOptions.paths` aliases (following `extends` AND
 * top-level `references`), so the import graph can resolve workspace-internal
 * aliases like "@codebuff/common/*" and paths declared by project-referenced
 * tsconfigs.
 *
 * Walk order: the root tsconfig.json contributes first, then its `extends`
 * chain (each extends resolved relative to the referencing file's directory);
 * a config's top-level `references` entries (`{ path: string }[]`, resolved
 * relative to the referencing file's directory, with a directory reference
 * getting `/tsconfig.json` appended, as TypeScript does) are queued behind
 * the extends chain, and each referenced config is walked with its own
 * extends chain too. A single visited set bounds the whole walk against
 * cycles, and at most MAX_TSCONFIG_REFERENCES references are followed.
 *
 * Closest-wins precedence, matching the existing rule: a key already in the
 * map is never overwritten, so the root config wins over its extends bases,
 * and nearer references win over farther ones in walk order. Paths
 * discovered through references are rebased to be project-root-relative (a
 * referenced config's `paths` are relative to that config's own directory,
 * but the resolver applies every alias against the project root).
 *
 * Tolerant/fail-open: comments/trailing commas are stripped, and malformed
 * JSON, missing files, reference cycles, or the reference cap simply
 * contribute nothing for that config (relative-import resolution still
 * works). Cached per root.
 */
function loadTsAliases(projectRoot: string): TsAliasMap {
  const cached = tsAliasCacheByRoot.get(projectRoot)
  if (cached) return cached

  const aliases: TsAliasMap = {}
  const queue: { filePath: string; viaReference: boolean }[] = [
    { filePath: path.join(projectRoot, 'tsconfig.json'), viaReference: false },
  ]
  const visited = new Set<string>()
  let referencesFollowed = 0
  while (queue.length > 0) {
    const entry = queue.shift()!
    if (visited.has(entry.filePath) || !fs.existsSync(entry.filePath)) {
      continue
    }
    visited.add(entry.filePath)
    let extendsPath: string | undefined
    const referencePaths: { filePath: string; viaReference: boolean }[] = []
    try {
      const raw = JSON.parse(
        stripJsonComments(fs.readFileSync(entry.filePath, 'utf8')),
      ) as {
        compilerOptions?: { paths?: unknown }
        extends?: unknown
        references?: unknown
      }
      const paths = raw?.compilerOptions?.paths
      if (paths && typeof paths === 'object') {
        // Paths in a config reached via `references` are relative to that
        // config's own directory; rebase them so they resolve against the
        // project root like every other alias.
        const rebasePrefix = entry.viaReference
          ? path
              .relative(projectRoot, path.dirname(entry.filePath))
              .split(path.sep)
              .join('/')
          : ''
        for (const [key, value] of Object.entries(paths)) {
          // Closest config wins; do not let a base config override.
          if (!(key in aliases) && Array.isArray(value)) {
            aliases[key] = (value as unknown[])
              .filter((t): t is string => typeof t === 'string')
              .map((t) => {
                const normalized = t.replace(/^\.\//, '').replace(/\\/g, '/')
                return rebasePrefix
                  ? `${rebasePrefix}/${normalized}`
                  : normalized
              })
          }
        }
      }
      const ext = raw?.extends
      if (typeof ext === 'string' && ext !== '') {
        extendsPath = path.resolve(path.dirname(entry.filePath), ext)
      }
      if (Array.isArray(raw?.references)) {
        for (const reference of raw.references) {
          const referencePath =
            reference !== null && typeof reference === 'object'
              ? (reference as { path?: unknown }).path
              : undefined
          if (typeof referencePath !== 'string') continue
          if (referencesFollowed >= MAX_TSCONFIG_REFERENCES) break
          referencesFollowed++
          const resolved = path.resolve(
            path.dirname(entry.filePath),
            referencePath,
          )
          // A directory reference names the referenced project root; its
          // tsconfig.json is the config file (mirrors TypeScript's behavior).
          referencePaths.push({
            filePath: /\.json$/i.test(resolved)
              ? resolved
              : path.join(resolved, 'tsconfig.json'),
            viaReference: true,
          })
        }
      }
    } catch {
      // Malformed/missing config contributes nothing; the walk continues.
    }
    // Extends chains drain before any queued reference so the root config
    // and its bases stay closer than referenced configs.
    if (extendsPath) {
      queue.unshift({
        filePath: extendsPath,
        viaReference: entry.viaReference,
      })
    }
    if (referencePaths.length > 0) queue.push(...referencePaths)
  }

  // Every alias-cache insert routes through the evicting helper so
  // MAX_INDEXED_PROJECT_ROOTS bounds this map too — including doc-only
  // roots whose project has no code files, for which no parsedCacheByRoot
  // insert ever happens (see evictOldestRootCacheIfNeeded).
  if (!tsAliasCacheByRoot.has(projectRoot)) {
    evictOldestRootCacheIfNeeded()
  }
  tsAliasCacheByRoot.set(projectRoot, aliases)
  return aliases
}

function dedupeEdges(edges: IndexEdge[]): IndexEdge[] {
  const seen = new Set<string>()
  const deduped: IndexEdge[] = []
  for (const edge of edges) {
    const key = `${edge.from}\0${edge.to}\0${edge.type}\0${edge.label ?? ''}`
    if (seen.has(key)) continue
    seen.add(key)
    deduped.push(edge)
  }
  return deduped
}
