import { createHash } from 'node:crypto'

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

/** Identity bound in UTF-16 code units; over-limit descriptors are refused. */
export const MAX_SCIP_SYMBOL_CHARS = 16_384
/** Display-only cap; never used for a definition or reference lookup. */
export const MAX_SCIP_LABEL_CHARS = 160
const SCIP_PRODUCER_VERSION = 'scip-json:2'

export type ScipIngestErrorCode =
  | 'malformed'
  | 'occurrence-limit'
  | 'edge-limit'
  | 'symbol-limit'
  | 'ambiguous-definition'

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
      checkSymbolLength(rawExternal.symbol)
      externalSymbols.push(rawExternal.symbol)
    }
  }
  return { documents, externalSymbols }
}

/**
 * Merge precise SCIP cross-reference edges into an index snapshot. Pure: the
 * input is not mutated. The returned snapshot shares every non-graph field;
 * its graph adds `confidence: 'precise'` file→file reference edges and drops
 * the whole persisted query accelerator (`queryData`): adjacency, postings,
 * and document frequencies are all stale after the edge change, so consumers
 * rebuild it from `graph.edges` or fall back to the uncached query path.
 * Existing edges keep their
 * (absent = heuristic) confidence; a precise edge replaces a heuristic
 * duplicate of the same (from, to, type) tuple instead of doubling it.
 *
 * @deprecated P3-T4: kept for compatibility and now delegates to
 * {@link mergeScipEdgesIntoIndex} after deriving edges via
 * {@link scipEdges}; prefer `scipPreciseEdges` + `mergeScipEdgesIntoIndex`
 * (the single-pass batch merge the scip-runner uses) or `runScipIngest`
 * directly. Unsafe paths and ambiguous definition ownership fail closed;
 * an input deriving no cross-file edges leaves the original index unchanged.
 */
export function mergeScipIntoIndex(
  index: MetadataIndex,
  scip: ScipIndex,
): MetadataIndex {
  return mergeScipEdgesIntoIndex(index, scipPreciseEdges(scip)).index
}

/**
 * Derive the precise file→file reference edges of a validated SCIP index —
 * the same derivation {@link mergeScipIntoIndex} performs — without merging.
 * Fails closed with a typed {@link ScipIngestError} on unsafe paths or
 * distinct definition owners for the same opaque descriptor. The scip-runner
 * derives every indexer dump's edges up front and merges them all in one pass,
 * instead of chaining one full-index-copying merge per indexer.
 */
export function scipPreciseEdges(scip: ScipIndex): IndexEdge[] {
  const skippedUnsafePaths = scip.documents.filter(
    (document) => !isSafeRelativePath(document.relativePath),
  ).length
  if (skippedUnsafePaths > 0) {
    throw new ScipIngestError(
      'malformed',
      `SCIP index contains ${skippedUnsafePaths} document(s) whose relative_path escapes the project root`,
    )
  }
  return scipEdges(scip.documents)
}

/**
 * Merge already-derived precise edges into an index snapshot in one pass.
 * Pure: the input is not mutated. Like {@link mergeScipIntoIndex}, the whole
 * persisted query accelerator (`queryData` — adjacency, postings, and
 * document frequencies) is dropped because it is stale after the edge
 * change; consumers rebuild it from `graph.edges` or fall back. Semantics
 * match {@link mergeScipIntoIndex}
 * (heuristic duplicates of the same (from, to, type) tuple are superseded,
 * dedupe by endpoints/type and opaque identity (legacy edges use their label),
 * edge cap enforced) but the index is
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
  for (const edge of withoutStaleScipProjection(index).graph.edges) {
    if (
      (edge.confidence ?? 'heuristic') === 'heuristic' &&
      preciseTuples.has(edgeTupleKey(edge))
    ) {
      continue
    }
    merged.push(edge)
  }

  const addedKeys = new Set<string>()
  const existingPreciseKeys = new Set(
    merged.filter((edge) => edge.confidence === 'precise').map(edgeDedupeKey),
  )
  let addedCount = 0
  for (const edge of preciseEdges) {
    const key = edgeDedupeKey(edge)
    if (addedKeys.has(key) || existingPreciseKeys.has(key)) continue
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
    const sourceHashes: Record<string, string> = {}
    for (const nodeId of [edge.from, edge.to]) {
      const filePath = nodeId.startsWith('file:')
        ? nodeId.slice(5)
        : index.graph.nodes[nodeId]?.path
      if (filePath && index.files[filePath])
        sourceHashes[filePath] = index.files[filePath]!.hash
    }
    merged.push({
      ...edge,
      confidence: 'precise',
      producer: edge.producer ?? {
        name: 'scip',
        version: SCIP_PRODUCER_VERSION,
        configFingerprint: index.sourceConfigFingerprint,
        sourceHashes,
      },
    })
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
 * produce no edge. Conflicting definition owners fail closed even when the
 * conflicting descriptor is not referenced by this dump.
 */
function scipEdges(input: readonly ScipDocument[]): IndexEdge[] {
  const documents = [...input].sort((a, b) =>
    compareStrings(a.relativePath, b.relativePath),
  )

  const definitionBySymbol = new Map<
    string,
    { path: string; digest?: string }
  >()
  for (const document of documents) {
    for (const occurrence of document.occurrences) {
      // Also bound descriptors in programmatically constructed ScipIndex values.
      checkSymbolLength(occurrence.symbol)
      if (isLocalSymbol(occurrence.symbol) || !isDefinition(occurrence))
        continue
      const definition = definitionBySymbol.get(occurrence.symbol)
      if (definition && definition.path !== document.relativePath) {
        throw new ScipIngestError(
          'ambiguous-definition',
          `SCIP symbol has ambiguous definition ownership: ${definition.path} and ${document.relativePath}`,
        )
      }
      if (!definition) {
        definitionBySymbol.set(occurrence.symbol, {
          path: document.relativePath,
        })
      }
    }
  }

  const edges: IndexEdge[] = []
  const seen = new Set<string>()
  for (const document of documents) {
    const fromId = fileNodeId(document.relativePath)
    for (const occurrence of document.occurrences) {
      if (isLocalSymbol(occurrence.symbol) || isDefinition(occurrence)) continue
      const definition = definitionBySymbol.get(occurrence.symbol)
      if (!definition || definition.path === document.relativePath) continue
      // Use exact string code units: UTF-8 replacement would conflate distinct
      // descriptors containing unpaired surrogates accepted by JSON.parse.
      definition.digest ??= createHash('sha256')
        .update(occurrence.symbol, 'utf16le')
        .digest('hex')
      const edge: IndexEdge = {
        from: fromId,
        to: fileNodeId(definition.path),
        type: 'references',
        weight: SCIP_EDGE_WEIGHT,
        label: occurrence.symbol.slice(0, MAX_SCIP_LABEL_CHARS),
        identityDigest: definition.digest,
        confidence: 'precise',
      }
      const key = edgeDedupeKey(edge)
      if (seen.has(key)) continue
      if (edges.length >= SCIP_MAX_MERGED_EDGES) {
        throw new ScipIngestError(
          'edge-limit',
          `SCIP dump exceeded the cap of ${SCIP_MAX_MERGED_EDGES} edges`,
        )
      }
      seen.add(key)
      edges.push(edge)
    }
  }
  edges.sort(
    (a, b) =>
      compareStrings(a.from, b.from) ||
      compareStrings(a.to, b.to) ||
      compareStrings(a.identityDigest!, b.identityDigest!),
  )
  return edges
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
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
  checkSymbolLength(symbol)
  const occurrence: ScipOccurrence = { symbol }
  if (symbol_roles !== undefined) occurrence.symbolRoles = symbol_roles
  return occurrence
}

function checkSymbolLength(symbol: string): void {
  if (symbol.length > MAX_SCIP_SYMBOL_CHARS) {
    throw new ScipIngestError(
      'symbol-limit',
      `SCIP symbol exceeds the cap of ${MAX_SCIP_SYMBOL_CHARS} UTF-16 code units`,
    )
  }
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
export function edgeTupleKey(edge: IndexEdge): string {
  return JSON.stringify([edge.from, edge.to, edge.type])
}

/** In-memory identity, shared by precise merge and graph recomposition. */
export function edgeDedupeKey(edge: IndexEdge): string {
  return edge.identityDigest === undefined
    ? JSON.stringify([edge.from, edge.to, edge.type, edge.label ?? ''])
    : JSON.stringify([edge.from, edge.to, edge.type, null, edge.identityDigest])
}

/** V1 joined on clipped labels and could silently choose an ambiguous owner. */
export function isStaleScipEdge(edge: IndexEdge): boolean {
  return (
    edge.confidence === 'precise' &&
    edge.producer?.name === 'scip' &&
    edge.producer.version === 'scip-json:1'
  )
}

/** Refuse lossy V1 evidence, without discarding unrelated index facts. */
export function withoutStaleScipProjection(
  index: MetadataIndex,
): MetadataIndex {
  const staleTuples = new Set<string>()
  for (const edge of index.graph.edges) {
    if (isStaleScipEdge(edge)) staleTuples.add(edgeTupleKey(edge))
  }
  if (staleTuples.size === 0) return index

  const edges = index.graph.edges.filter((edge) => !isStaleScipEdge(edge))
  // A valid precise edge may still supersede the structural fallback.
  for (const edge of edges) {
    if (edge.confidence === 'precise') staleTuples.delete(edgeTupleKey(edge))
  }
  if (staleTuples.size && index.graphData) {
    const present = new Set(edges.map(edgeDedupeKey))
    for (const group of Object.values(index.graphData)) {
      for (const edge of group.edges) {
        if (
          edge.confidence === 'precise' ||
          !staleTuples.has(edgeTupleKey(edge))
        )
          continue
        const key = edgeDedupeKey(edge)
        if (present.has(key)) continue
        present.add(key)
        edges.push(edge)
      }
    }
  }
  return {
    ...index,
    graph: { ...index.graph, edges },
    // The old adjacency refers to the pre-filtered edge array.
    queryData: undefined,
  }
}
