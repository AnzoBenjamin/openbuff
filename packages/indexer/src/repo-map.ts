import { queryIndex, type QueryOptions } from './query'
import { getPageRankAdjacency, personalizedPageRank } from './pagerank'

import type {
  IndexedFile,
  MetadataIndex,
  PageRankOptions,
  QueryIndexResult,
} from './types'

/**
 * Deterministic code-point string comparison (locale-independent). ICU's
 * `localeCompare` is environment-dependent, so ordering must never rely on it.
 */
function compareStrings(a: string, b: string): number {
  if (a < b) return -1
  if (a > b) return 1
  return 0
}

export interface RepoMapOptions {
  maxFiles?: number
  maxSymbolsPerFile?: number
  maxImportsPerFile?: number
  maxHeadingsPerFile?: number
  fileTypes?: string[]
}

export interface RepoMapEntry {
  path: string
  ext: string
  symbols: string[]
  imports: string[]
  headings: string[]
  concepts: string[]
}

export interface RepoMapResult {
  map: string
  entries: RepoMapEntry[]
}

/** A file ranked by personalized PageRank over the code graph (P3-T9). */
export interface RankedRepoMapEntry {
  path: string
  /** Personalized-PageRank score; scores across a run sum to at most 1. */
  score: number
}

export interface RetrievalComparisonCase {
  query: string
  expectedPaths: string[]
  queryOptions?: QueryOptions
  repoMapOptions?: RepoMapOptions
}

export interface RetrievalStrategyMetrics {
  passed: number
  meanReciprocalRank: number
  failed: Array<{
    query: string
    expectedPaths: string[]
    actualPaths: string[]
  }>
}

export interface RetrievalComparisonReport {
  total: number
  queryIndex: RetrievalStrategyMetrics
  repoMap: RetrievalStrategyMetrics
}

const DEFAULT_REPO_MAP_OPTIONS: Required<Omit<RepoMapOptions, 'fileTypes'>> = {
  maxFiles: 40,
  maxSymbolsPerFile: 12,
  maxImportsPerFile: 6,
  maxHeadingsPerFile: 6,
}

/**
 * Prototype-only repo-map renderer for retrieval evals. It compresses indexed
 * structural metadata into a deterministic text map; it is not used by the
 * default query_index path.
 */
export function buildRepoMap(
  index: MetadataIndex,
  options: RepoMapOptions = {},
): RepoMapResult {
  const opts = { ...DEFAULT_REPO_MAP_OPTIONS, ...options }
  const entries = Object.values(index.files)
    .filter((file) => matchesFileType(file, options.fileTypes))
    .sort((a, b) => compareStrings(a.path, b.path))
    .slice(0, opts.maxFiles)
    .map((file) => toRepoMapEntry(file, opts))

  const map = entries.map(formatRepoMapEntry).join('\n')
  return { map, entries }
}

/**
 * P3-T9 ranked repo map: runs personalized PageRank over the code graph and
 * returns the top-N files for the seed set (sorted by score desc, path asc
 * for determinism). An empty/unresolvable seed set falls back to a global
 * importance ranking (uniform personalization). Files with no graph edges
 * never appear. Work is bounded by the PageRank iteration cap and the
 * adjacency is cached per index revision.
 */
export function rankedRepoMap(
  index: MetadataIndex,
  seeds: string[],
  options: RepoMapOptions & PageRankOptions = {},
): { entries: RankedRepoMapEntry[] } {
  const limit = Math.max(
    0,
    options.maxFiles ?? DEFAULT_REPO_MAP_OPTIONS.maxFiles,
  )
  const adjacency = getPageRankAdjacency(index)
  const seedVector = new Map<string, number>()
  for (const path of seeds) {
    const nodeId = `file:${path}`
    if (adjacency.has(nodeId)) seedVector.set(nodeId, 1)
  }
  const scores = personalizedPageRank({
    adjacency,
    seeds: seedVector,
    damping: options.damping,
    maxIterations: options.maxIterations,
    epsilon: options.epsilon,
  })

  const entries: RankedRepoMapEntry[] = []
  for (const [nodeId, score] of scores) {
    if (!nodeId.startsWith('file:') || score <= 0) continue
    const path = nodeId.slice('file:'.length)
    if (!matchesFileType(index.files[path], options.fileTypes)) continue
    entries.push({ path, score: round(score) })
  }
  entries.sort(
    (a, b) => b.score - a.score || compareStrings(a.path, b.path),
  )
  return { entries: entries.slice(0, limit) }
}

export function compareRetrievalStrategies(
  index: MetadataIndex,
  cases: RetrievalComparisonCase[],
): RetrievalComparisonReport {
  return {
    total: cases.length,
    queryIndex: evaluateStrategy(cases, (testCase) =>
      queryIndex(index, testCase.query, {
        limit: 10,
        ...testCase.queryOptions,
      }).map((result) => result.path),
    ),
    repoMap: evaluateStrategy(cases, (testCase) =>
      queryRepoMap(index, testCase.query, {
        maxFiles: 10,
        ...testCase.repoMapOptions,
      }).map((result) => result.path),
    ),
  }
}

export function queryRepoMap(
  index: MetadataIndex,
  query: string,
  options: RepoMapOptions = {},
): QueryIndexResult[] {
  const tokens = tokenize(query)
  const { entries } = buildRepoMap(index, {
    ...options,
    // Score against the complete candidate set, then limit after sorting.
    maxFiles: Object.keys(index.files).length,
  })
  const limit = options.maxFiles ?? DEFAULT_REPO_MAP_OPTIONS.maxFiles

  return entries
    .map((entry) => scoreRepoMapEntry(entry, tokens))
    .filter((result) => result.score > 0)
    .sort(
      (a, b) => b.score - a.score || compareStrings(a.path, b.path),
    )
    .slice(0, limit)
}

export function formatRetrievalComparisonReport(
  report: RetrievalComparisonReport,
): string {
  const lines = [
    '# Retrieval Comparison',
    '',
    `Total cases: ${report.total}`,
    `query_index: ${report.queryIndex.passed}/${report.total} passed, MRR ${report.queryIndex.meanReciprocalRank.toFixed(3)}`,
    `repo_map: ${report.repoMap.passed}/${report.total} passed, MRR ${report.repoMap.meanReciprocalRank.toFixed(3)}`,
  ]

  if (report.queryIndex.failed.length || report.repoMap.failed.length) {
    lines.push('', '## Failures')
    appendFailures(lines, 'query_index', report.queryIndex.failed)
    appendFailures(lines, 'repo_map', report.repoMap.failed)
  }

  return lines.join('\n')
}

function toRepoMapEntry(
  file: IndexedFile,
  opts: Required<Omit<RepoMapOptions, 'fileTypes'>>,
): RepoMapEntry {
  return {
    path: file.path,
    ext: file.ext,
    symbols: file.symbols.slice(0, opts.maxSymbolsPerFile),
    imports: file.imports.slice(0, opts.maxImportsPerFile),
    headings: file.headings.slice(0, opts.maxHeadingsPerFile),
    concepts: file.concepts,
  }
}

function formatRepoMapEntry(entry: RepoMapEntry): string {
  const parts = [`${entry.path} (${entry.ext || 'no ext'})`]
  if (entry.symbols.length) parts.push(`  symbols: ${entry.symbols.join(', ')}`)
  if (entry.imports.length) parts.push(`  imports: ${entry.imports.join(', ')}`)
  if (entry.headings.length)
    parts.push(`  headings: ${entry.headings.join(' > ')}`)
  if (entry.concepts.length)
    parts.push(`  concepts: ${entry.concepts.slice(0, 8).join(', ')}`)
  return parts.join('\n')
}

function evaluateStrategy(
  cases: RetrievalComparisonCase[],
  getPaths: (testCase: RetrievalComparisonCase) => string[],
): RetrievalStrategyMetrics {
  let reciprocalRankTotal = 0
  const failed: RetrievalStrategyMetrics['failed'] = []

  for (const testCase of cases) {
    const actualPaths = getPaths(testCase)
    const firstExpectedRank = actualPaths.findIndex((path) =>
      testCase.expectedPaths.includes(path),
    )
    if (firstExpectedRank >= 0)
      reciprocalRankTotal += 1 / (firstExpectedRank + 1)

    const missing = testCase.expectedPaths.filter(
      (path) => !actualPaths.includes(path),
    )
    if (missing.length) {
      failed.push({
        query: testCase.query,
        expectedPaths: testCase.expectedPaths,
        actualPaths,
      })
    }
  }

  return {
    passed: cases.length - failed.length,
    failed,
    meanReciprocalRank:
      cases.length === 0 ? 0 : round(reciprocalRankTotal / cases.length),
  }
}

function scoreRepoMapEntry(
  entry: RepoMapEntry,
  tokens: string[],
): QueryIndexResult {
  let score = 0
  const matchedOn = new Set<QueryIndexResult['matchedOn'][number]>()
  const normalizedPath = entry.path.toLowerCase()

  for (const token of tokens) {
    if (normalizedPath.includes(token)) {
      score += 3
      matchedOn.add('path')
    }
    if (entry.symbols.some((symbol) => symbol.toLowerCase().includes(token))) {
      score += 4
      matchedOn.add('symbol')
    }
    if (
      entry.headings.some((heading) => heading.toLowerCase().includes(token))
    ) {
      score += 2
      matchedOn.add('heading')
    }
    if (entry.imports.some((item) => item.toLowerCase().includes(token))) {
      score += 1
      matchedOn.add('import')
    }
    if (
      entry.concepts.some((concept) => concept.toLowerCase().includes(token))
    ) {
      score += 2
      matchedOn.add('concept')
    }
  }

  return {
    path: entry.path,
    score: round(score),
    matchedOn: Array.from(matchedOn),
    symbols: entry.symbols,
    headings: entry.headings,
    explanation: `Matched repo-map metadata for ${entry.path}`,
  }
}

function matchesFileType(
  file: IndexedFile,
  fileTypes: string[] | undefined,
): boolean {
  if (!fileTypes?.length) return true
  const normalized = new Set(fileTypes.map(normalizeFileType))
  return normalized.has(normalizeFileType(file.ext))
}

function normalizeFileType(fileType: string): string {
  const normalized = fileType.trim().toLowerCase()
  return normalized.startsWith('.') ? normalized.slice(1) : normalized
}

function tokenize(query: string): string[] {
  return query
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[\s\-_./\\:,;()|]+/)
    .filter((token) => token.length >= 2)
    .filter((token) => !STOP_WORDS.has(token))
    .slice(0, 20)
}

function appendFailures(
  lines: string[],
  label: string,
  failures: RetrievalStrategyMetrics['failed'],
): void {
  for (const failure of failures) {
    lines.push(
      `- ${label}: "${failure.query}" expected ${failure.expectedPaths.join(', ')}; got ${failure.actualPaths.join(', ') || '(none)'}`,
    )
  }
}

function round(score: number): number {
  return Math.round(score * 1000) / 1000
}

const STOP_WORDS = new Set([
  'the',
  'and',
  'for',
  'are',
  'but',
  'not',
  'with',
  'from',
  'into',
  'before',
  'after',
  'this',
  'that',
  'edit',
  'edits',
])
