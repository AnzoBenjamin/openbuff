import { createHash } from 'node:crypto'

import { LRUCache } from '@codebuff/common/util/lru-cache'

import { LspServerError, LspServerUnavailableError } from './lsp-multiplexer'

import type {
  LspDocumentSymbol,
  LspHover,
  LspPosition,
  LspRange,
} from './lsp-multiplexer'

/**
 * P3-T6 (LI-09): symbol enrichment.
 *
 * Additive service that layers LSP-derived type signatures and doc comments on
 * top of the existing index symbols. For a file it runs `textDocument/documentSymbol`,
 * then issues `textDocument/hover` at each top-level symbol's selection-range start
 * to capture the type signature + doc comment, and (when the server advertises the
 * capability) `textDocument/inlayHint` over the whole file range for inferred types.
 *
 * Design/bounds:
 * - The multiplexer is injected (a multiplexer-like seam), so tests are hermetic.
 * - Results are cached by path-aware content hash (sha256(filePath + '\0' +
 *   fileText)) in a bounded in-process LRU, so re-enriching an unchanged file
 *   is free and edits invalidate naturally. The path is in the key because
 *   hover enrichment is location-dependent (imports resolve per path); two
 *   byte-identical files at different paths must not share an entry.
 * - Per-file work is bounded: at most {@link MAX_SYMBOLS_PER_FILE} top-level symbols
 *   are enriched and at most {@link MAX_HOVER_CALLS_PER_FILE} hover calls are issued.
 * - Never throws for a missing/crashed server: `LspServerUnavailableError` /
 *   `LspServerError` from `documentSymbol` degrade to an honest
 *   `{ symbols: [], unavailable: { reason } }` result; a per-symbol hover failure
 *   keeps the symbol with undefined detail/documentation rather than dropping it.
 */

const MAX_SYMBOLS_PER_FILE = 200
const MAX_HOVER_CALLS_PER_FILE = 200
const MAX_INLAY_HINTS_PER_FILE = 1_000
/** Bound on hover requests in flight concurrently per file enrichment. */
const HOVER_CONCURRENCY = 8

/** Upper bound on cached per-file enrichment results (keyed by path-aware content hash). */
export const SYMBOL_ENRICHMENT_CACHE_MAX_ENTRIES = 200

const ENRICHMENT_CACHE = new LRUCache<string, EnrichedSymbol[]>(
  SYMBOL_ENRICHMENT_CACHE_MAX_ENTRIES,
)

/** Minimal `textDocument/inlayHint` shape (LSP 3.17). */
export type LspInlayHint = {
  position: LspPosition
  label: string | Array<{ value: string }>
  kind?: number
}

/**
 * The multiplexer-like seam this service drives. Structurally compatible with
 * the real {@link LspMultiplexer} (which supplies `hover`/`documentSymbol` with
 * these exact signatures). `inlayHint` is OPTIONAL and only present when the
 * server's initialize capabilities advertise `inlayHintProvider` — its absence
 * is how unsupported servers are detected, so enrichment skips it quietly.
 */
export type SymbolEnrichmentMultiplexer = {
  hover(params: {
    filePath: string
    position: LspPosition
  }): Promise<LspHover | null>
  documentSymbol(params: {
    filePath: string
  }): Promise<LspDocumentSymbol[] | null>
  inlayHint?(params: {
    filePath: string
    range: LspRange
  }): Promise<LspInlayHint[] | null>
}

/** A document symbol enriched with hover docs / type and inlay-hint inferred type. */
export type EnrichedSymbol = {
  name: string
  kind: number
  range: LspRange
  selectionRange: LspRange
  detail?: string
  documentation?: string
  inferredType?: string
  children?: EnrichedSymbol[]
}

export type EnrichFileSymbolsResult = {
  symbols: EnrichedSymbol[]
  /** Present (with an honest reason) only when the server was unavailable/crashed. */
  unavailable?: { reason: string }
}

/** Exported-for-test view of the bounded enrichment cache. */
export function symbolEnrichmentCacheSizeForTest(): number {
  return ENRICHMENT_CACHE.size
}

/** Drops every cached enrichment result (test isolation). */
export function clearSymbolEnrichmentCacheForTest(): void {
  ENRICHMENT_CACHE.clear()
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

const FENCED_CODE_REGEX = /```[\w-]*\s*\n([\s\S]*?)```/

/**
 * Flattens LSP hover contents — MarkedString (`string` | `{language,value}`),
 * MarkedString[], or MarkupContent (`{kind,value}`) — to a single string.
 * Markdown and plaintext are both returned as-is (markup flattened, not parsed).
 */
export function flattenHoverContents(contents: unknown): string | undefined {
  if (contents === null || contents === undefined) return undefined
  if (typeof contents === 'string') {
    const trimmed = contents.trim()
    return trimmed.length > 0 ? trimmed : undefined
  }
  if (Array.isArray(contents)) {
    const parts = contents
      .map(flattenHoverContents)
      .filter((part): part is string => part !== undefined)
    return parts.length > 0 ? parts.join('\n\n') : undefined
  }
  if (isRecord(contents)) {
    const value = contents['value']
    if (typeof value === 'string') {
      const trimmed = value.trim()
      return trimmed.length > 0 ? trimmed : undefined
    }
  }
  return undefined
}

/**
 * Extracts the type/code signature from hover contents: the value of a
 * language-tagged MarkedString, or the first fenced code block in markdown.
 */
export function extractHoverSignature(contents: unknown): string | undefined {
  if (contents === null || contents === undefined) return undefined
  if (typeof contents === 'string') {
    const fenced = FENCED_CODE_REGEX.exec(contents)
    const signature = fenced?.[1]?.trim()
    return signature && signature.length > 0 ? signature : undefined
  }
  if (Array.isArray(contents)) {
    for (const item of contents) {
      const signature = extractHoverSignature(item)
      if (signature !== undefined) return signature
    }
    return undefined
  }
  if (isRecord(contents)) {
    const value = contents['value']
    if (typeof value !== 'string') return undefined
    if (typeof contents['language'] === 'string') {
      const trimmed = value.trim()
      return trimmed.length > 0 ? trimmed : undefined
    }
    return extractHoverSignature(value)
  }
  return undefined
}

function flattenInlayHintLabel(label: LspInlayHint['label']): string | undefined {
  const text =
    typeof label === 'string' ? label : label.map((part) => part.value).join('')
  // Type hints conventionally render as `: T`; strip the leading separator.
  const cleaned = text.trim().replace(/^[:\s]+/, '').trim()
  return cleaned.length > 0 ? cleaned : undefined
}

function toEnrichedSymbol(
  symbol: LspDocumentSymbol,
  inlayHintsByLine: ReadonlyMap<number, string>,
): EnrichedSymbol {
  const enriched: EnrichedSymbol = {
    name: symbol.name,
    kind: symbol.kind,
    range: symbol.range,
    selectionRange: symbol.selectionRange,
  }
  if (symbol.detail !== undefined) enriched.detail = symbol.detail
  const inferredType = inlayHintsByLine.get(symbol.selectionRange.start.line)
  if (inferredType !== undefined) enriched.inferredType = inferredType
  if (symbol.children && symbol.children.length > 0) {
    enriched.children = symbol.children
      .slice(0, MAX_SYMBOLS_PER_FILE)
      .map((child) => toEnrichedSymbol(child, inlayHintsByLine))
  }
  return enriched
}

function applyHover(symbol: EnrichedSymbol, hover: LspHover): void {
  const documentation = flattenHoverContents(hover.contents)
  if (documentation !== undefined) symbol.documentation = documentation
  const signature = extractHoverSignature(hover.contents)
  if (signature !== undefined) {
    symbol.detail ??= signature
    symbol.inferredType ??= signature
  }
}

/**
 * Hover for one symbol. A missing result (null) or an LSP server failure yields
 * null so the caller keeps the symbol unenriched instead of dropping it.
 */
async function safeHover(
  multiplexer: SymbolEnrichmentMultiplexer,
  filePath: string,
  position: LspPosition,
): Promise<LspHover | null> {
  try {
    return await multiplexer.hover({ filePath, position })
  } catch (error) {
    if (
      error instanceof LspServerUnavailableError ||
      error instanceof LspServerError
    ) {
      return null
    }
    throw error
  }
}

/**
 * Collects whole-file inlay hints into a line -> inferred-type map. Optional:
 * returns an empty map when the seam (server capability) is absent and never
 * fails enrichment when the request itself errors.
 */
async function collectInlayHintsByLine(
  filePath: string,
  fileText: string,
  multiplexer: SymbolEnrichmentMultiplexer,
): Promise<Map<number, string>> {
  const byLine = new Map<number, string>()
  if (typeof multiplexer.inlayHint !== 'function') return byLine
  const range: LspRange = {
    start: { line: 0, character: 0 },
    end: { line: fileText.split('\n').length, character: 0 },
  }
  let hints: LspInlayHint[] | null
  try {
    hints = await multiplexer.inlayHint({ filePath, range })
  } catch {
    return byLine
  }
  if (!hints) return byLine
  for (const hint of hints.slice(0, MAX_INLAY_HINTS_PER_FILE)) {
    const label = flattenInlayHintLabel(hint.label)
    if (label === undefined) continue
    const line = hint.position.line
    if (!byLine.has(line)) byLine.set(line, label)
  }
  return byLine
}

/**
 * Enriches a file's top-level document symbols with hover docs/type signatures
 * and (when supported) inlay-hint inferred types. Cached by path + content hash
 * so an unchanged file is a cache hit; an unavailable/crashed server returns an
 * honest `{ symbols: [], unavailable: { reason } }` instead of throwing.
 */
export async function enrichFileSymbols(params: {
  filePath: string
  fileText: string
  multiplexer: SymbolEnrichmentMultiplexer
}): Promise<EnrichFileSymbolsResult> {
  const { filePath, fileText, multiplexer } = params
  // Key on path + content: hover enrichment is path-dependent (imports resolve
  // per location), so two byte-identical files at different paths must not
  // collide. The NUL separator keeps path+content concatenation unambiguous.
  const cacheKey = createHash('sha256')
    .update(`${filePath}\0${fileText}`)
    .digest('hex')
  const cached = ENRICHMENT_CACHE.get(cacheKey)
  if (cached !== undefined) {
    return { symbols: cached }
  }

  let documentSymbols: LspDocumentSymbol[] | null
  try {
    documentSymbols = await multiplexer.documentSymbol({ filePath })
  } catch (error) {
    if (
      error instanceof LspServerUnavailableError ||
      error instanceof LspServerError
    ) {
      return { symbols: [], unavailable: { reason: error.reason } }
    }
    throw error
  }

  if (!documentSymbols || documentSymbols.length === 0) {
    ENRICHMENT_CACHE.set(cacheKey, [])
    return { symbols: [] }
  }

  const inlayHintsByLine = await collectInlayHintsByLine(
    filePath,
    fileText,
    multiplexer,
  )

  // Bounded-concurrency hover fan-out (perf:
  // symbol-enrichment-serial-hover-roundtrips): first-touch enrichment used
  // to issue up to MAX_HOVER_CALLS_PER_FILE hover round-trips strictly
  // sequentially per uncached file (200 serial LSP round-trips) even though
  // the language server answers requests concurrently. Results stay
  // index-aligned with the capped symbol list, so enrichment output is
  // identical to the serial loop's, and the per-file hover cap is unchanged.
  const targets = documentSymbols.slice(0, MAX_SYMBOLS_PER_FILE)
  const hoverTargets = targets.slice(0, MAX_HOVER_CALLS_PER_FILE)
  const hovers = new Array<LspHover | null>(hoverTargets.length)
  let nextHoverIndex = 0
  await Promise.all(
    Array.from(
      { length: Math.min(HOVER_CONCURRENCY, hoverTargets.length) },
      async () => {
        while (nextHoverIndex < hoverTargets.length) {
          const index = nextHoverIndex++
          hovers[index] = await safeHover(
            multiplexer,
            filePath,
            hoverTargets[index]!.selectionRange.start,
          )
        }
      },
    ),
  )
  const symbols: EnrichedSymbol[] = targets.map((symbol, index) => {
    const enriched = toEnrichedSymbol(symbol, inlayHintsByLine)
    const hover = hovers[index]
    if (hover) applyHover(enriched, hover)
    return enriched
  })

  ENRICHMENT_CACHE.set(cacheKey, symbols)
  return { symbols }
}
