import * as crypto from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'

import {
  extractCodeChunks,
  getFileTokenScores,
  AST_IMPORT_SPECIFIER_LIMIT,
  SUPPORTED_CODE_EXTENSIONS,
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
import { buildIndexQueryData } from './query-data'
import type {
  GraphWeights,
  IndexedFile,
  IndexEdge,
  IndexGraph,
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
 * without bound; the oldest root's cache is dropped on overflow. Exported
 * so tests can assert the bound is enforced on every write path.
 */
export const MAX_INDEXED_PROJECT_ROOTS = 8

function evictOldestRootCacheIfNeeded(): void {
  if (parsedCacheByRoot.size >= MAX_INDEXED_PROJECT_ROOTS) {
    const oldestRoot = parsedCacheByRoot.keys().next().value
    if (oldestRoot !== undefined) {
      parsedCacheByRoot.delete(oldestRoot)
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
  if (codeFilePaths.length > 0) {
    try {
      const data = await getFileTokenScores(projectRoot, codeFilePaths)
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

  for (const file of files) {
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
    })
    if (indexed) indexedFiles[file.relativePath] = indexed
  }

  const index = createMetadataIndex(
    projectRoot,
    indexedFiles,
    tokenCallers,
    config.weights?.graph,
    parseDiagnostics,
    parseData,
  )
  index.coverage = createIndexCoverage(walked, parseCoverage)
  return index
}

export async function updateMetadataIndex(
  existing: MetadataIndex,
  projectRoot: string,
  config: IndexingConfig = {},
  mutationDelta?: IndexMutationDelta,
): Promise<MetadataIndex> {
  tsAliasCacheByRoot.delete(projectRoot)
  // B5(c) workspaceRevision journal: reject stale complete:true deltas. If the
  // incoming revision is older than the incorporated revision, skip the precise
  // walk and return existing with a builtAt refresh so callers observe liveness
  // without regressing to stale content.
  if (
    mutationDelta?.complete === true &&
    mutationDelta.revision !== undefined &&
    existing.workspaceRevision !== undefined &&
    compareRevisions(mutationDelta.revision, existing.workspaceRevision) < 0
  ) {
    return { ...existing, builtAt: Date.now() }
  }
  const preciseDelta = mutationDelta?.complete === true
  const walked = preciseDelta
    ? await collectPreciseWalk(existing, projectRoot, mutationDelta, config)
    : await walkProjectDetailed(
        projectRoot,
        getIndexExcludes(config),
        config.maxFiles,
      )
  const files = walked.files
  const currentByPath = new Map(files.map((f) => [f.relativePath, f]))
  const changedDeltaPaths = new Set(
    (mutationDelta?.changedPaths ?? []).map(normalizeMutationPath),
  )
  const deletedPaths = preciseDelta
    ? new Set((mutationDelta?.deletedPaths ?? []).map(normalizeMutationPath))
    : new Set(Object.keys(existing.files))

  if (preciseDelta) {
    for (const changedPath of changedDeltaPaths) {
      if (!currentByPath.has(changedPath) && existing.files[changedPath]) {
        deletedPaths.add(changedPath)
      }
    }
  }

  if (!preciseDelta) {
    for (const f of files) {
      deletedPaths.delete(f.relativePath)
    }
  }

  const hashByPath = new Map<string, string>()
  const hashReadFailedPaths = new Set<string>()
  // Content reads that failed inside indexWalkedFile even though hashing
  // succeeded (e.g. the file became unreadable between the hash read and the
  // content read). Mirrors hashReadFailedPaths: a still-walked file must
  // keep its previous indexed entry instead of being dropped from the index.
  const contentReadFailedPaths = new Set<string>()
  const changedFiles: typeof files = []
  const updatedFiles: Record<string, IndexedFile> = { ...existing.files }
  let metadataOnlyChange = false

  for (const file of files) {
    const indexed = existing.files[file.relativePath]
    if (preciseDelta && !changedDeltaPaths.has(file.relativePath)) {
      continue
    }
    // Stat-gated hashing (X-2a): unchanged files skip the content read +
    // SHA-256 entirely. A file is treated as unchanged only when BOTH the
    // walked mtime/size AND a fresh stat() match the indexed record — the
    // walked mtime can be stale for precise-delta overlays rebuilt from the
    // indexed record, and the fresh stat catches changes that land between
    // the walk and this loop. Known tradeoff (the standard indexer one,
    // prescribed by the DEPTH audit): a touch-less write that keeps mtime
    // AND size identical is invisible to this gate. Stat failures fall back
    // to hashing, preserving the previous behavior.
    // Residual race (documented, tolerated): the fresh stat() above and the
    // hash read below are not atomic. A write landing between them is hashed
    // as NEW content but recorded under the PRE-write mtime/size from the
    // walk, so that record's stat identity is temporarily wrong. The next
    // refresh's fresh stat() then mismatches the indexed record and forces a
    // re-hash — the index self-heals one refresh late; content is never
    // lost, only transiently attributed to a stale stat.
    let hash: string | undefined
    if (indexed) {
      try {
        const stat = await fs.promises.stat(file.absolutePath)
        if (
          indexed.mtime === stat.mtimeMs &&
          indexed.size === stat.size &&
          indexed.mtime === file.mtime &&
          indexed.size === file.size
        ) {
          hash = indexed.hash
        }
      } catch {
        // Stat failure: fall back to hashing below (current behavior).
      }
    }
    if (hash === undefined) {
      try {
        hash = file.asset
          ? await hashBinaryFile(file.absolutePath)
          : await hashFile(file.absolutePath)
      } catch (error) {
        hashReadFailedPaths.add(file.relativePath)
        // Bounded diagnostics: warn once per path instead of silently
        // retrying (and silently failing) on every refresh.
        recordHashReadFailure(file.absolutePath, file.relativePath, error)
        changedFiles.push(file)
        continue
      }
    }
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
        // No derived inspection cache is available yet.
      }
    }
    if (!indexed || indexed.hash !== hash || hasNewDerivedMetadata) {
      changedFiles.push(file)
    } else if (indexed.mtime !== file.mtime || indexed.size !== file.size) {
      updatedFiles[file.relativePath] = {
        ...indexed,
        mtime: file.mtime,
        size: file.size,
        hash,
      }
      metadataOnlyChange = true
    }
  }

  const needsParseHydration = existing.parseData === undefined
  if (
    changedFiles.length === 0 &&
    deletedPaths.size === 0 &&
    !needsParseHydration
  ) {
    const graphFiles = metadataOnlyChange ? updatedFiles : existing.files
    const aliases = loadTsAliases(projectRoot)
    // One fail-open ts resolution tier per pass (null when the typescript
    // module is unavailable).
    const graph = buildGraph(
      graphFiles,
      {},
      aliases,
      resolveGraphWeights(config.weights?.graph),
      existing.parseData,
      createTsModuleResolver({ projectRoot, files: graphFiles, aliases }),
    )
    return {
      ...existing,
      builtAt: Date.now(),
      // A refresh that applied changes clears any prior degraded flag (P8.1).
      parserDegraded: undefined,
      files: graphFiles,
      graph,
      queryData: buildIndexQueryData(graphFiles, graph),
      coverage: createIndexCoverage(walked, existing.coverage?.parser),
    }
  }

  const allCodeFilePaths = files
    .filter(
      (f) =>
        CODE_EXTENSIONS.has(f.ext) && !hashReadFailedPaths.has(f.relativePath),
    )
    .map((f) => f.relativePath)

  // Only changed code files need re-parsing; reuse cached parse output for the
  // rest. The global token scores + call graph are then recomputed from the
  // merged set (cheap, no tree-sitter). This avoids a full project re-parse on
  // every incremental update (e.g. after each agent edit).
  const changedPathSet = new Set(changedFiles.map((f) => f.relativePath))
  const previousCache = {
    ...(existing.parseData ?? {}),
    ...getParsedCache(projectRoot),
  }
  const reuseParsed: Record<string, ParsedFileTokens> = {}
  for (const codePath of allCodeFilePaths) {
    if (!changedPathSet.has(codePath) && previousCache[codePath]) {
      reuseParsed[codePath] = previousCache[codePath]
    }
  }

  let tokenScores: Record<string, Record<string, number>> = {}
  let tokenCallers: Record<string, Record<string, string[]>> = {}
  let parseDiagnostics: ParseDiagnostic[] = []
  let parseCoverage: ParseCoverage | undefined
  let parseData: Record<string, ParsedFileTokens> = { ...previousCache }
  let parserDegraded = false
  if (allCodeFilePaths.length > 0) {
    try {
      const data = await getFileTokenScores(
        projectRoot,
        allCodeFilePaths,
        undefined,
        reuseParsed,
      )
      tokenScores = data.tokenScores
      tokenCallers = data.tokenCallers
      parseDiagnostics = data.diagnostics
      parseCoverage = data.coverage
      parseData = data.parsed
      setParsedCache(projectRoot, parseData)
    } catch (error) {
      parseDiagnostics = [createParseDiagnostic(projectRoot, error)]
      parserDegraded = true
    }
  }

  if (parserDegraded) {
    // P8.1: the parser degraded, so `files`/`parseData` above were not
    // refreshed and the pending mutation delta was dropped. Keep the prior
    // builtAt (and workspaceRevision) intact — re-stamping Date.now() would
    // mark a stale index fresh and suppress the manager's staleness-driven
    // retry. parseDiagnostics/coverage are preserved; the returned
    // `parserDegraded` flag makes IndexManager re-queue the delta once.
    return {
      ...existing,
      parserDegraded: true,
      parseDiagnostics,
      coverage: createIndexCoverage(walked, parseCoverage),
    }
  }

  for (const deletedPath of deletedPaths) {
    delete updatedFiles[deletedPath]
    delete parseData[deletedPath]
  }

  for (const file of changedFiles) {
    const previous = existing.files[file.relativePath]
    const indexed = await indexWalkedFile({
      absolutePath: file.absolutePath,
      projectRoot,
      relativePath: file.relativePath,
      mtime: file.mtime,
      size: file.size,
      ext: file.ext,
      asset: file.asset,
      hash: hashByPath.get(file.relativePath),
      tokenScores: tokenScores[file.relativePath] ?? {},
      astImports: parseData[file.relativePath]?.imports,
      previousChunks: previous?.chunks,
      previousHash: previous?.hash,
      readFailedPaths: contentReadFailedPaths,
    })
    if (indexed) {
      updatedFiles[file.relativePath] = indexed
    } else if (
      (hashReadFailedPaths.has(file.relativePath) ||
        contentReadFailedPaths.has(file.relativePath)) &&
      existing.files[file.relativePath]
    ) {
      // Transient (non-deletion) read failure: the walk still sees the file,
      // so keep the previous indexed entry until a later refresh can re-read
      // it instead of silently dropping a still-existing file from the index.
    } else {
      delete updatedFiles[file.relativePath]
    }
  }

  for (const [filePath, scores] of Object.entries(tokenScores)) {
    const file = currentByPath.get(filePath)
    const indexed = updatedFiles[filePath]
    if (!file || !indexed) continue
    updatedFiles[filePath] = {
      ...indexed,
      symbols: getTopSymbols(scores, 30),
    }
  }

  const index = createMetadataIndex(
    projectRoot,
    updatedFiles,
    tokenCallers,
    config.weights?.graph,
    parseDiagnostics,
    parseData,
  )
  index.coverage = createIndexCoverage(walked, parseCoverage)
  return index
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
    content = await fs.promises.readFile(params.absolutePath, 'utf8')
  } catch {
    // Transient read failure: report it so the caller can keep the previous
    // indexed entry for this still-walked file instead of dropping it.
    params.readFailedPaths?.add(params.relativePath)
    return null
  }

  const symbols = getTopSymbols(params.tokenScores, 30)
  const imports = extractImports(content, params.ext, params.astImports)
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
  const contentSampleTruncated = contentSampleSliced.length < contentSampleRaw.length
  const contentSample = contentSampleTruncated ? `${contentSampleSliced}…[truncated]` : contentSampleSliced

  // Extract asset references from game engine text files (Unity .meta/.prefab/.unity,
  // Godot .tscn/.tres, Unreal .uproject, Bevy configs). Returns [] for non-asset files.
  const assetRefs = extractAssetRefs(content, params.ext, params.relativePath)

  // Phase A2 (additive): chunk summaries for code files only. Reuses the
  // already-read `content`; never re-reads disk. Errors or empty results
  // leave `chunks` undefined to keep the cache compact.
  let chunks: IndexedFile['chunks']
  if (CODE_EXTENSIONS.has(params.ext)) {
    const contentHash = params.hash ?? hashContent(content)
    if (params.previousChunks && params.previousHash && contentHash === params.previousHash) {
      chunks = params.previousChunks.slice(0, 100)
      if (chunks.length === 0) chunks = undefined
    } else try {
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
    hash: params.hash ?? hashContent(content),
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

function createMetadataIndex(
  projectRoot: string,
  files: Record<string, IndexedFile>,
  tokenCallers: Record<string, Record<string, string[]>>,
  graphWeights?: GraphWeights,
  parseDiagnostics: ParseDiagnostic[] = [],
  parseData: Record<string, ParsedFileTokens> = {},
): MetadataIndex {
  const aliases = loadTsAliases(projectRoot)
  const graph = buildGraph(
    files,
    tokenCallers,
    aliases,
    resolveGraphWeights(graphWeights),
    parseData,
    createTsModuleResolver({ projectRoot, files, aliases }),
  )
  return {
    version: '2',
    projectRoot,
    builtAt: Date.now(),
    fileCount: Object.keys(files).length,
    files,
    graph,
    queryData: buildIndexQueryData(files, graph),
    parseData,
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

function buildGraph(
  files: Record<string, IndexedFile>,
  tokenCallers: Record<string, Record<string, string[]>>,
  aliases: TsAliasMap | undefined,
  weights: Required<GraphWeights>,
  parseData: Record<string, ParsedFileTokens> = {},
  tsResolver: TsModuleResolver | null = null,
): IndexGraph {
  const nodes: Record<string, IndexNode> = {}
  const edges: IndexEdge[] = []

  // Build a GUID → asset-path map from all indexed .meta files so Unity guid
  // references in .prefab/.unity files can be resolved to actual file paths.
  const guidToPathMap = buildGuidToPathMap(files)

  for (const file of Object.values(files)) {
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
    if (!files[definingFile]) continue
    for (const [token, callers] of Object.entries(callersByToken)) {
      for (const callerFile of callers) {
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
    ...buildModuleAwareCallEdges(
      files,
      parseData,
      aliases,
      weights.calls,
      tsResolver,
    ),
  )

  return { nodes, edges: dedupeEdges(edges) }
}

function buildModuleAwareCallEdges(
  files: Record<string, IndexedFile>,
  parseData: Record<string, ParsedFileTokens>,
  aliases: TsAliasMap | undefined,
  weight: number,
  tsResolver: TsModuleResolver | null = null,
): IndexEdge[] {
  const definitions = new Map<string, string[]>()
  for (const [filePath, parsed] of Object.entries(parseData)) {
    if (!files[filePath]) continue
    for (const symbol of parsed.identifiers) {
      const paths = definitions.get(symbol) ?? []
      if (!paths.includes(filePath)) paths.push(filePath)
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
