import type { IndexEdge, IndexNode, MetadataIndex } from './types'

/**
 * SCIP ingestion (P3-T4 / LI-03): merge precise cross-reference edges from a
 * SCIP JSON document (e.g. `scip print --json`) into the indexer graph.
 * Tree-sitter edges stay in place as the heuristic fallback; every edge added
 * here is labeled `confidence: 'precise'` and supersedes a heuristic duplicate
 * of the same (from, to, type) tuple. SCIP symbol strings are opaque
 * descriptors — only the definition bit and the `local ` prefix are read, the
 * symbol scheme is never guessed. Unknown symbols produce no edge.
 */

/** SCIP `symbol_roles` bit marking a definition occurrence. */
const SCIP_SYMBOL_ROLE_DEFINITION = 1

/** Prefix of file-local SCIP symbols; they never cross file boundaries. */
const SCIP_LOCAL_SYMBOL_PREFIX = 'local '

/** Hard bounds so a hostile or corrupt SCIP dump cannot stall ingestion. */
export const SCIP_MAX_OCCURRENCES_PER_DOCUMENT = 20_000
export const SCIP_MAX_MERGED_EDGES = 50_000

/** Historical default `references` weight from metadata-indexer. */
const SCIP_EDGE_WEIGHT = 0.9

export type ScipIngestErrorCode = 'malformed' | 'occurrence-limit' | 'edge-limit'

/** Typed failure for malformed or unbounded SCIP input; ingestion fails closed. */
export class ScipIngestError extends Error {
  readonly code: ScipIngestErrorCode

  constructor(code: ScipIngestErrorCode, message: string) {
    super(message)
    this.name = 'ScipIngestError'
    this.code = code
  }
}

/** A validated SCIP occurrence (only the fields ingestion consumes). */
export interface ScipOccurrence {
  /** Opaque SCIP symbol descriptor; never parsed beyond the local prefix. */
  symbol: string
  /** Raw `symbol_roles` bitfield; absent means "reference". */
  symbolRoles?: number
}

/** A validated SCIP document. */
export interface ScipDocument {
  relativePath: string
  language?: string
  occurrences: ScipOccurrence[]
}

/** The supported SCIP JSON shape, post-validation. */
export interface ScipIndex {
  documents: ScipDocument[]
  /** Symbols defined outside the project (informational; never edge targets). */
  externalSymbols: string[]
}

/**
 * Validating parser for the supported SCIP JSON shape:
 * `{ documents: [{ relative_path, language?, occurrences: [{ range, symbol, symbol_roles?, syntax_kind? }] }], external_symbols?: [{ symbol, ... }] }`
 * where `range` is `[startLine, startChar, endLine, endChar]` or
 * `[line, char, len]`. Fails closed with a typed {@link ScipIngestError} on
 * any malformed input.
 */
export function parseScipJson(json: unknown): ScipIndex {
  if (!isRecord(json)) {
    throw new ScipIngestError('malformed', 'SCIP JSON root must be an object')
  }
  if (!Array.isArray(json.documents)) {
    throw new ScipIngestError(
      'malformed',
      'SCIP JSON must contain a documents array',
    )
  }
  const documents: ScipDocument[] = []
  for (const rawDocument of json.documents) {
    documents.push(parseDocument(rawDocument))
  }
  const externalSymbols: string[] = []
  if (json.external_symbols !== undefined) {
    if (!Array.isArray(json.external_symbols)) {
      throw new ScipIngestError(
        'malformed',
        'external_symbols must be an array when present',
      )
    }
    for (const rawExternal of json.external_symbols) {
      if (!isRecord(rawExternal) || typeof rawExternal.symbol !== 'string') {
        throw new ScipIngestError(
          'malformed',
          'external_symbols entries must be objects with a string symbol',
        )
      }
      externalSymbols.push(rawExternal.symbol)
    }
  }
  return { documents, externalSymbols }
}

/**
 * Merge precise SCIP cross-reference edges into an index snapshot. Pure: the
 * input is not mutated. The returned snapshot shares every non-graph field;
 * its graph adds `confidence: 'precise'` file→file reference edges and drops
 * the persisted adjacency accelerator, whose edge indexes would be stale
 * (consumers rebuild it from `graph.edges`). Existing edges keep their
 * (absent = heuristic) confidence; a precise edge replaces a heuristic
 * duplicate of the same (from, to, type) tuple instead of doubling it.
 */
export function mergeScipIntoIndex(
  index: MetadataIndex,
  scip: ScipIndex,
): MetadataIndex {
  const { edges: preciseEdges, skippedUnsafePaths } = scipEdges(scip)
  // F2: a guard-tripped SCIP document must be observable, not silently
  // absorbed — a hostile dump of '../' paths would otherwise look like a
  // clean scan. Fail closed when any document escapes the project root.
  if (skippedUnsafePaths > 0) {
    throw new ScipIngestError(
      'malformed',
      `SCIP index contains ${skippedUnsafePaths} document(s) whose relative_path escapes the project root`,
    )
  }
  if (preciseEdges.length === 0) return index

  const nodes: Record<string, IndexNode> = { ...index.graph.nodes }
  const preciseTuples = new Set(preciseEdges.map(edgeTupleKey))
  const merged: IndexEdge[] = []
  for (const edge of index.graph.edges) {
    if (
      (edge.confidence ?? 'heuristic') === 'heuristic' &&
      preciseTuples.has(edgeTupleKey(edge))
    ) {
      continue
    }
    merged.push(edge)
  }

  const addedKeys = new Set<string>()
  let addedCount = 0
  for (const edge of preciseEdges) {
    const key = edgeDedupeKey(edge)
    if (addedKeys.has(key)) continue
    if (addedCount >= SCIP_MAX_MERGED_EDGES) {
      throw new ScipIngestError(
        'edge-limit',
        `SCIP merge exceeded the cap of ${SCIP_MAX_MERGED_EDGES} edges`,
      )
    }
    addedKeys.add(key)
    addedCount++
    ensureFileNode(nodes, edge.from)
    ensureFileNode(nodes, edge.to)
    merged.push(edge)
  }

  const next: MetadataIndex = { ...index, graph: { nodes, edges: merged } }
  delete next.queryData
  return next
}

/**
 * Derive the precise file→file reference edges of a validated SCIP index —
 * the same derivation {@link mergeScipIntoIndex} performs — without merging.
 * Fails closed with the typed {@link ScipIngestError} when any document
 * escapes the project root. The scip-runner derives every indexer dump's
 * edges up front and merges them all in one pass, instead of chaining one
 * full-index-copying merge per indexer.
 */
export function scipPreciseEdges(scip: ScipIndex): IndexEdge[] {
  const { edges, skippedUnsafePaths } = scipEdges(scip)
  if (skippedUnsafePaths > 0) {
    throw new ScipIngestError(
      'malformed',
      `SCIP index contains ${skippedUnsafePaths} document(s) whose relative_path escapes the project root`,
    )
  }
  return edges
}

/**
 * Merge already-derived precise edges into an index snapshot in one pass.
 * Pure: the input is not mutated. Semantics match {@link mergeScipIntoIndex}
 * (heuristic duplicates of the same (from, to, type) tuple are superseded,
 * dedupe by (from, to, type, label), edge cap enforced) but the index is
 * copied exactly once regardless of how many sources contributed edges —
 * the chained per-indexer merge shape copied the full snapshot once per
 * successful indexer (O(k x |index|) allocations for k indexers).
 *
 * @returns the merged snapshot and the number of edges actually added.
 */
export function mergeScipEdgesIntoIndex(
  index: MetadataIndex,
  preciseEdges: readonly IndexEdge[],
): { index: MetadataIndex; edgesMerged: number } {
  if (preciseEdges.length === 0) return { index, edgesMerged: 0 }

  const nodes: Record<string, IndexNode> = { ...index.graph.nodes }
  const preciseTuples = new Set(preciseEdges.map(edgeTupleKey))
  const merged: IndexEdge[] = []
  for (const edge of index.graph.edges) {
    if (
      (edge.confidence ?? 'heuristic') === 'heuristic' &&
      preciseTuples.has(edgeTupleKey(edge))
    ) {
      continue
    }
    merged.push(edge)
  }

  const addedKeys = new Set<string>()
  let addedCount = 0
  for (const edge of preciseEdges) {
    const key = edgeDedupeKey(edge)
    if (addedKeys.has(key)) continue
    if (addedCount >= SCIP_MAX_MERGED_EDGES) {
      throw new ScipIngestError(
        'edge-limit',
        `SCIP merge exceeded the cap of ${SCIP_MAX_MERGED_EDGES} edges`,
      )
    }
    addedKeys.add(key)
    addedCount++
    ensureFileNode(nodes, edge.from)
    ensureFileNode(nodes, edge.to)
    merged.push(edge)
  }

  const next: MetadataIndex = { ...index, graph: { nodes, edges: merged } }
  delete next.queryData
  return { index: next, edgesMerged: addedCount }
}

/**
 * Derive precise file→file reference edges from a validated SCIP index.
 * Definition occurrences (symbol_roles definition bit) map symbols to their
 * defining document; reference occurrences then point at that file. Local
 * symbols stay file-internal, self edges are skipped, and unknown symbols
 * produce no edge. Documents are visited in sorted order so merged output is
 * deterministic; documents whose relative_path escapes the project are
 * skipped outright.
 */
function scipEdges(scip: ScipIndex): {
  edges: IndexEdge[]
  skippedUnsafePaths: number
} {
  const allDocuments = [...scip.documents]
  const skippedUnsafePaths = allDocuments.filter(
    (document) => !isSafeRelativePath(document.relativePath),
  ).length
  const documents = allDocuments
    .filter((document) => isSafeRelativePath(document.relativePath))
    .sort((a, b) =>
      a.relativePath < b.relativePath
        ? -1
        : a.relativePath > b.relativePath
          ? 1
          : 0,
    )

  const definitionPathBySymbol = new Map<string, string>()
  for (const document of documents) {
    for (const occurrence of document.occurrences) {
      if (isLocalSymbol(occurrence.symbol)) continue
      if (isDefinition(occurrence)) {
        definitionPathBySymbol.set(occurrence.symbol, document.relativePath)
      }
    }
  }

  const edges: IndexEdge[] = []
  const seen = new Set<string>()
  for (const document of documents) {
    const fromId = fileNodeId(document.relativePath)
    for (const occurrence of document.occurrences) {
      if (isLocalSymbol(occurrence.symbol) || isDefinition(occurrence)) continue
      const definingPath = definitionPathBySymbol.get(occurrence.symbol)
      if (definingPath === undefined || definingPath === document.relativePath) {
        continue
      }
      const edge: IndexEdge = {
        from: fromId,
        to: fileNodeId(definingPath),
        type: 'references',
        weight: SCIP_EDGE_WEIGHT,
        label: occurrence.symbol,
        confidence: 'precise',
      }
      const key = edgeDedupeKey(edge)
      if (seen.has(key)) continue
      seen.add(key)
      edges.push(edge)
    }
  }
  return { edges, skippedUnsafePaths }
}

function parseDocument(rawDocument: unknown): ScipDocument {
  if (!isRecord(rawDocument)) {
    throw new ScipIngestError('malformed', 'document entries must be objects')
  }
  const { relative_path, language, occurrences } = rawDocument
  if (typeof relative_path !== 'string' || relative_path.length === 0) {
    throw new ScipIngestError(
      'malformed',
      'document.relative_path must be a non-empty string',
    )
  }
  if (language !== undefined && typeof language !== 'string') {
    throw new ScipIngestError(
      'malformed',
      'document.language must be a string when present',
    )
  }
  if (!Array.isArray(occurrences)) {
    throw new ScipIngestError(
      'malformed',
      'document.occurrences must be an array',
    )
  }
  if (occurrences.length > SCIP_MAX_OCCURRENCES_PER_DOCUMENT) {
    throw new ScipIngestError(
      'occurrence-limit',
      `document ${relative_path} exceeds the cap of ${SCIP_MAX_OCCURRENCES_PER_DOCUMENT} occurrences`,
    )
  }
  const parsed: ScipDocument = {
    relativePath: relative_path,
    occurrences: occurrences.map(parseOccurrence),
  }
  if (language !== undefined) parsed.language = language
  return parsed
}

function parseOccurrence(rawOccurrence: unknown): ScipOccurrence {
  if (!isRecord(rawOccurrence)) {
    throw new ScipIngestError('malformed', 'occurrence entries must be objects')
  }
  const { range, symbol, symbol_roles } = rawOccurrence
  if (!isScipRange(range)) {
    throw new ScipIngestError(
      'malformed',
      'occurrence.range must be [line, char, len] or [startLine, startChar, endLine, endChar]',
    )
  }
  if (typeof symbol !== 'string' || symbol.length === 0) {
    throw new ScipIngestError(
      'malformed',
      'occurrence.symbol must be a non-empty string',
    )
  }
  if (
    symbol_roles !== undefined &&
    (typeof symbol_roles !== 'number' ||
      !Number.isInteger(symbol_roles) ||
      symbol_roles < 0)
  ) {
    throw new ScipIngestError(
      'malformed',
      'occurrence.symbol_roles must be a non-negative integer when present',
    )
  }
  const occurrence: ScipOccurrence = { symbol }
  if (symbol_roles !== undefined) occurrence.symbolRoles = symbol_roles
  return occurrence
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Accepts `[startLine, startChar, endLine, endChar]` or `[line, char, len]`. */
function isScipRange(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    (value.length === 3 || value.length === 4) &&
    value.every((part) => typeof part === 'number' && Number.isFinite(part))
  )
}

function isDefinition(occurrence: ScipOccurrence): boolean {
  return ((occurrence.symbolRoles ?? 0) & SCIP_SYMBOL_ROLE_DEFINITION) !== 0
}

function isLocalSymbol(symbol: string): boolean {
  return symbol.startsWith(SCIP_LOCAL_SYMBOL_PREFIX)
}

/** Traversal guard: only plain project-relative paths are merged. */
function isSafeRelativePath(relativePath: string): boolean {
  if (
    relativePath.startsWith('/') ||
    relativePath.includes('\\') ||
    /^[A-Za-z]:/.test(relativePath)
  ) {
    return false
  }
  return relativePath
    .split('/')
    .every((segment) => segment !== '' && segment !== '.' && segment !== '..')
}

/** Matches metadata-indexer's fileNodeId so edges land on existing nodes. */
function fileNodeId(filePath: string): string {
  return `file:${filePath}`
}

function ensureFileNode(
  nodes: Record<string, IndexNode>,
  nodeId: string,
): void {
  const path = nodeId.startsWith('file:')
    ? nodeId.slice('file:'.length)
    : nodeId
  nodes[nodeId] ??= { id: nodeId, type: 'file', label: path, path }
}

/** Identity used for supersede semantics: same endpoints and type, any label. */
function edgeTupleKey(edge: IndexEdge): string {
  return `${edge.from}\0${edge.to}\0${edge.type}`
}

/** Matches metadata-indexer's dedupeEdges keying. */
function edgeDedupeKey(edge: IndexEdge): string {
  return `${edge.from}\0${edge.to}\0${edge.type}\0${edge.label ?? ''}`
}
