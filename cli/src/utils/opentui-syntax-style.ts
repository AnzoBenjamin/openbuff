import { SyntaxStyle, type StyleDefinitionInput } from '@opentui/core'

import { getSystemProcessEnv } from './env'

import type { MarkdownPalette } from './markdown-renderer'

/**
 * Maps our MarkdownPalette onto an OpenTUI 0.5 SyntaxStyle for the native
 * <markdown> renderable (Stage 2 of the OpenTUI 0.5 migration).
 *
 * Every style-entry shape and style NAME below was located in the installed
 * @opentui/core 0.5.12 source, not invented:
 *
 * - Entry shape (fg/bg ColorInput + bold/italic/underline/dim attributes)
 *   comes from node_modules/@opentui/core/syntax-style.d.ts
 *   (StyleDefinitionInput) and is applied via SyntaxStyle.fromStyles().
 * - Style names come from node_modules/@opentui/core/index.bun.js (bundled
 *   src/renderables/Markdown.ts), whose getStyle() consumers use exactly
 *   these groups: "default" (plain text fallback), "markup.raw" (inline
 *   codespans), "markup.strong", "markup.italic", "markup.strikethrough",
 *   "markup.link" / "markup.link.url" / "markup.link.label",
 *   "markup.list" (list bullet markers), "markup.quote" (blockquote content
 *   base highlight), "markup.heading" (table header cells), and "conceal"
 *   (blockquote border color AND thematic-break/hr border color via
 *   getStyle('conceal').fg).
 * - Per-depth headings: getStyle() falls back from "markup.heading.N" to the
 *   "markup.heading" base name, and the tree-sitter markdown highlights
 *   query shipped at node_modules/@opentui/core/assets/markdown/highlights.scm
 *   emits @markup.heading.1 .. @markup.heading.6, so the dotted names are
 *   registered individually.
 *
 * Palette fields with no unambiguous key in the installed source are
 * intentionally NOT mapped (rather than guessed):
 * - codeTextFg: fenced code blocks are rendered by CodeRenderable using
 *   tree-sitter token groups (string/keyword/comment/...), not a single
 *   markdown style key; there is no key for plain code text.
 * - dividerFg: thematic breaks reuse the "conceal" group (see above), which
 *   carries blockquoteBorderFg here; no separate divider key exists.
 *
 * D47 Stage 2: with the legacy renderer removed, the palette argument is
 * optional and accepts a Partial<MarkdownPalette>; every missing field falls
 * back to the former legacy defaults, so both
 * createMarkdownSyntaxStyle(agentPalette ?? {}) and an undefined palette work
 * without throwing.
 *
 * Memoization (native-handle leak fix): SyntaxStyle.fromStyles() allocates a
 * native handle that is never GC'd and has no finalizer, so both factories
 * below are memoized with a FLAT-KEYED bounded cache: the cache key is a
 * cheap '\0'-joined string of only the palette fields the style records
 * read (markdownStyleCacheKey / codeStyleCacheKey), built WITHOUT
 * constructing the record object or serializing it, so byte-identical style
 * records share one handle regardless of palette object identity while the
 * per-render/per-streaming-chunk hot path pays no record-build or
 * JSON.stringify cost. This covers fresh-object call
 * sites: agent-branch-wrapper.tsx builds a per-indent `{...palette,
 * codeTextFg}` spread and tool-branch.tsx builds a fresh object literal on
 * every render — both produce the same record (codeTextFg and any other
 * unmapped palette fields never reach the record, so they cannot change the
 * key), hence the same key and a cache hit instead of one native handle per
 * streaming chunk. This module is the single choke point for every call
 * site (components/blocks/content-with-markdown.tsx — called per render,
 * once per streaming chunk — and components/message-with-agents.tsx), so no
 * caller needs its own memoization; the undefined-palette path is cached
 * under its own cache key like any other.
 *
 * The caches are bounded at MAX_STYLE_CACHE_ENTRIES entries each, so the
 * worst case for a stream of distinct palettes is a bounded leak (≤ 64
 * handles per factory) instead of one handle per streaming chunk. Eviction
 * is LEAST-RECENTLY-USED, not FIFO: every cache hit re-inserts its entry
 * (Map re-insertion order), so a hot palette that keeps being requested
 * cannot be evicted by a stream of distinct palettes — a pure FIFO policy
 * would evict the hot entry and turn each subsequent request into a
 * handle-allocating miss (unbounded native-handle churn behind a bounded
 * cache). Evicted handles are dropped by reference only — NEVER destroyed
 * (no destroy() call anywhere in app code), because a live renderable may
 * still hold the shared handle. Cached handles are shared across renders.
 * clearSyntaxStyleCachesForTests() resets both caches.
 */
// Former legacy-renderer defaults (markdown-renderer.tsx before D47 Stage 2).
const DEFAULT_HEADING_FG: Record<number, string> = {
  1: 'magenta',
  2: 'green',
  3: 'green',
  4: 'green',
  5: 'green',
  6: 'green',
}

// Module-level flat-keyed caches backing both factories (see the
// memoization JSDoc above). Cache key = the '\0'-joined effective palette
// values the record reads (markdownStyleCacheKey / codeStyleCacheKey), so
// byte-identical records always produce the same key while the record
// object itself is built only on a cache miss.
//
// Bounded at maxStyleCacheEntries() entries per factory, with LRU hit
// promotion: a cache hit re-inserts its entry, so on insert at capacity the
// LEAST-RECENTLY-USED entry is evicted (first key of the promotion-updated
// Map order), never a recently-hit hot entry. INVARIANT: evicted handles
// are dropped by reference only — NEVER call destroy(), a live renderable
// may still hold them.
//
// `let` because the test-only reset swaps in fresh maps (existing pattern).
let markdownStyleHandleCache = new Map<string, SyntaxStyle>()
let codeStyleHandleCache = new Map<string, SyntaxStyle>()

/**
 * Default bound on native SyntaxStyle handles retained per factory cache.
 * Overridable via CODEBUFF_MAX_STYLE_CACHE_ENTRIES so the default can be
 * tuned and later regression-tracked against quantitative before/after
 * evidence (handle allocations per streaming session, resident memory
 * attributable to cached styles) without a code change per experiment. The
 * default stays put until such evidence justifies moving it. Recorded
 * baseline for the cost this knob introduces (one native handle per cache
 * miss under the LRU bound; per-call flat-key build allocation on the
 * render hot path): see the 'tunables cost baselines' block in
 * cli/src/utils/__tests__/opentui-syntax-style.test.ts.
 */
const DEFAULT_MAX_STYLE_CACHE_ENTRIES = 64

function maxStyleCacheEntries(): number {
  // Via the cli env helper (env-architecture guard): production cli files
  // never read ambient process.env directly.
  const raw = getSystemProcessEnv().CODEBUFF_MAX_STYLE_CACHE_ENTRIES
  if (!raw) return DEFAULT_MAX_STYLE_CACHE_ENTRIES
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : DEFAULT_MAX_STYLE_CACHE_ENTRIES
}

/**
 * Bounded LRU insertion for both style-handle caches: on insert at
 * capacity, evict the LEAST-RECENTLY-USED entry (the first key of the
 * promotion-updated Map order). The victim is dropped by reference only —
 * NEVER call destroy(), a live renderable may still hold it (see the
 * invariant on the cache declarations above).
 */
function cacheStyleHandle(
  cache: Map<string, SyntaxStyle>,
  key: string,
  handle: SyntaxStyle,
): void {
  if (cache.size >= maxStyleCacheEntries()) {
    const lru = cache.keys().next()
    if (!lru.done) {
      cache.delete(lru.value)
    }
  }
  cache.set(key, handle)
}

/**
 * LRU hit promotion for both style-handle caches: a cache hit re-inserts
 * the entry at the tail of the Map (fresh insertion order; the value object
 * is reused, not reallocated), so a hot palette cannot be evicted by a
 * stream of distinct palettes. Without promotion, pure FIFO eviction turns
 * every hot-palette return under distinct-key pressure into a cache miss
 * that allocates a new never-destroyed native handle — unbounded handle
 * churn behind a "bounded" cache.
 */
function promoteCacheEntry(
  cache: Map<string, SyntaxStyle>,
  key: string,
  handle: SyntaxStyle,
): void {
  // Delete-then-set moves the entry to the tail of the Map's insertion
  // order without reallocating the native handle (the value is reused).
  cache.delete(key)
  cache.set(key, handle)
}

/**
 * One merged heading slot exactly as buildMarkdownStyleRecord's
 * `{ ...DEFAULT_HEADING_FG, ...palette?.headingFg }` spread produces it: an
 * OWN property wins even when its value is undefined (clobbering the
 * default), while an absent slot keeps the shared default. Returns the
 * merged (possibly undefined) slot value; callers apply the record's
 * `headingFg[N] ?? headingFg[6]` fallthrough on top.
 */
function mergedHeadingSlot(
  headingFg: Record<number, string> | undefined,
  slot: number,
): string | undefined {
  return headingFg && Object.prototype.hasOwnProperty.call(headingFg, slot)
    ? headingFg[slot]
    : DEFAULT_HEADING_FG[slot]
}

/**
 * Flat cache key for createMarkdownSyntaxStyle: mirrors EXACTLY the palette
 * values buildMarkdownStyleRecord reads (same fallbacks, same
 * codeMonochrome handling, heading defaults merged the same way — including
 * an explicitly present but undefined headingFg slot, which clobbers the
 * default in the record's spread merge and falls through to the heading-6
 * slot), so two palettes produce the same key if and only if they produce
 * byte-identical records. The '\0' separator keeps adjacent components
 * unambiguous.
 *
 * Deliberately cheaper than the former build-record-then-JSON.stringify
 * key: the hot path allocates only the key string itself (heading values
 * are resolved per slot via own-property checks — no merged heading object
 * literal, no intermediate array + join), while the full record (and its
 * nested object literals) is constructed only on a cache miss.
 */
function markdownStyleCacheKey(palette?: Partial<MarkdownPalette>): string {
  // Heading slots mirror buildMarkdownStyleRecord's spread merge exactly
  // (see mergedHeadingSlot): merged slot N, then the record's
  // `headingFg[N] ?? headingFg[6]` fallthrough. A plain
  // `headingFg?.[N] ?? DEFAULT_HEADING_FG[N]` here would key an
  // explicit-undefined slot identically to an absent slot while their
  // records differ (heading N renders the merged slot-6 color vs the
  // slot-N default), so one caller would receive the wrong memoized handle.
  const headingFg = palette?.headingFg
  const h6 = mergedHeadingSlot(headingFg, 6)
  const h1 = mergedHeadingSlot(headingFg, 1) ?? h6
  const h2 = mergedHeadingSlot(headingFg, 2) ?? h6
  const h3 = mergedHeadingSlot(headingFg, 3) ?? h6
  const h4 = mergedHeadingSlot(headingFg, 4) ?? h6
  const h5 = mergedHeadingSlot(headingFg, 5) ?? h6
  const codeBackground = palette?.codeMonochrome
    ? ''
    : palette?.codeBackground ?? '#0d1117'
  return (
    (palette?.codeMonochrome ? 'mono' : 'color') +
    '\0' +
    (palette?.inlineCodeFg ?? '#86efac') +
    '\0' +
    codeBackground +
    '\0' +
    (palette?.linkFg ?? '#3B82F6') +
    '\0' +
    (palette?.listBulletFg ?? 'white') +
    '\0' +
    (palette?.blockquoteTextFg ?? 'gray') +
    '\0' +
    (palette?.blockquoteBorderFg ?? 'gray') +
    '\0' +
    h1 +
    '\0' +
    h2 +
    '\0' +
    h3 +
    '\0' +
    h4 +
    '\0' +
    h5 +
    '\0' +
    h6
  )
}

export function createMarkdownSyntaxStyle(
  palette?: Partial<MarkdownPalette>,
): SyntaxStyle {
  // Cheap flat cache key built straight from the palette fields the record
  // reads — the full record object is constructed only on a cache miss, so
  // the per-render/per-streaming-chunk hot path never pays for record
  // construction or JSON serialization (see the cache declarations).
  const key = markdownStyleCacheKey(palette)
  const cached = markdownStyleHandleCache.get(key)
  if (cached !== undefined) {
    promoteCacheEntry(markdownStyleHandleCache, key, cached)
    return cached
  }
  const style = SyntaxStyle.fromStyles(buildMarkdownStyleRecord(palette))
  cacheStyleHandle(markdownStyleHandleCache, key, style)
  return style
}

/**
 * TEST-ONLY reset for both syntax-style handle caches, following the repo's
 * `*ForTests` convention (setAgentRegistryLoggerForTests,
 * resetTreeSitterClientStateForTests). Never call from app code: cached
 * handles are shared across renders and must live for the process lifetime.
 */
export function clearSyntaxStyleCachesForTests(): void {
  markdownStyleHandleCache = new Map()
  codeStyleHandleCache = new Map()
}

/**
 * Pure record construction for createMarkdownSyntaxStyle: runs only on a
 * cache miss (see markdownStyleCacheKey), byte-identical output to the
 * former inline literal. The fixed-order object literal keeps the emitted
 * style mapping stable for byte-identical palettes.
 */
function buildMarkdownStyleRecord(
  palette?: Partial<MarkdownPalette>,
): Record<string, StyleDefinitionInput> {
  const headingFg = { ...DEFAULT_HEADING_FG, ...palette?.headingFg }
  const codeBackground = palette?.codeMonochrome
    ? undefined
    : palette?.codeBackground ?? '#0d1117'

  return {
    // Fallback for unstyled markdown text: leave terminal defaults intact.
    default: {},
    // Markdown.ts renders inline codespans with the "markup.raw" group; our
    // legacy renderer drew them bold on the code background.
    'markup.raw': {
      fg: palette?.inlineCodeFg ?? '#86efac',
      bg: codeBackground,
      bold: true,
    },
    'markup.strong': { bold: true },
    'markup.italic': { italic: true },
    // Legacy strikethrough (mdast "delete") renders with TextAttributes.DIM.
    'markup.strikethrough': { dim: true },
    'markup.link': { fg: palette?.linkFg ?? '#3B82F6' },
    'markup.link.url': { fg: palette?.linkFg ?? '#3B82F6' },
    'markup.link.label': { fg: palette?.linkFg ?? '#3B82F6' },
    'markup.list': { fg: palette?.listBulletFg ?? 'white' },
    'markup.quote': { fg: palette?.blockquoteTextFg ?? 'gray' },
    // Drives blockquote border color (and hr/divider color) in Markdown.ts.
    conceal: { fg: palette?.blockquoteBorderFg ?? 'gray' },
    // Base heading style; Markdown.ts table header cells use "markup.heading"
    // with our headingFg[3] color, falling back to the deepest configured one.
    'markup.heading': {
      bold: true,
      fg: headingFg[3] ?? headingFg[6],
    },
    'markup.heading.1': {
      bold: true,
      fg: headingFg[1] ?? headingFg[6],
    },
    'markup.heading.2': {
      bold: true,
      fg: headingFg[2] ?? headingFg[6],
    },
    'markup.heading.3': {
      bold: true,
      fg: headingFg[3] ?? headingFg[6],
    },
    'markup.heading.4': {
      bold: true,
      fg: headingFg[4] ?? headingFg[6],
    },
    'markup.heading.5': {
      bold: true,
      fg: headingFg[5] ?? headingFg[6],
    },
    'markup.heading.6': {
      bold: true,
      fg: headingFg[6],
    },
  }
}

/**
 * Flat cache key for createCodeSyntaxStyle: mirrors EXACTLY the palette
 * fields buildCodeStyleRecord reads, so two palettes produce the same key
 * if and only if they produce byte-identical records.
 */
function codeStyleCacheKey(palette: MarkdownPalette): string {
  return [palette.inlineCodeFg, palette.codeHeaderFg, palette.linkFg].join(
    '\0',
  )
}

/**
 * Maps our MarkdownPalette onto an OpenTUI 0.5 SyntaxStyle for the native
 * <code> renderable (CodeRenderable), used when standalone code text is
 * rendered outside markdown (PLAN.md P1-T6).
 *
 * Verified against the installed @opentui/core 0.5.12, not invented:
 * - CodeOptions (node_modules/@opentui/core/renderables/Code.d.ts) takes the
 *   SyntaxStyle via the required `syntaxStyle` option; unstyled spans are
 *   drawn with the renderable's own fg/bg (TextBufferOptions), so the base
 *   codeTextFg/codeBackground look is applied by the <code> element itself
 *   (see components/blocks/code-block.tsx), NOT by a style entry.
 * - Style names below are tree-sitter capture groups emitted by the shipped
 *   highlights queries (node_modules/@opentui/core/assets/typescript/
 *   highlights.scm and the shared ecma query it embeds): comment, string,
 *   number, boolean, constant, keyword, function, type, module, attribute,
 *   label, string.escape. CodeRenderable resolves each highlight's group
 *   name against these registered names.
 *
 * Palette mapping (attribute-only where no palette field is unambiguous,
 * matching createMarkdownSyntaxStyle's don't-guess-colors philosophy):
 * - strings/numbers reuse inlineCodeFg (legacy code-token accent color).
 * - functions/types reuse codeHeaderFg (legacy code header color).
 * - modules/attributes reuse linkFg.
 * - comments/keywords/booleans/constants get attribute-only styling.
 */
export function createCodeSyntaxStyle(palette: MarkdownPalette): SyntaxStyle {
  // Cheap flat cache key (see codeStyleCacheKey); the record object is
  // built only on a cache miss.
  const key = codeStyleCacheKey(palette)
  const cached = codeStyleHandleCache.get(key)
  if (cached !== undefined) {
    promoteCacheEntry(codeStyleHandleCache, key, cached)
    return cached
  }
  const style = SyntaxStyle.fromStyles(buildCodeStyleRecord(palette))
  cacheStyleHandle(codeStyleHandleCache, key, style)
  return style
}

/**
 * Pure record construction for createCodeSyntaxStyle: runs only on a cache
 * miss (see codeStyleCacheKey), byte-identical output to the former inline
 * literal. The fixed-order object literal keeps the emitted style mapping
 * stable for byte-identical palettes.
 */
function buildCodeStyleRecord(
  palette: MarkdownPalette,
): Record<string, StyleDefinitionInput> {
  return {
    comment: { dim: true },
    string: { fg: palette.inlineCodeFg },
    'string.escape': { bold: true },
    number: { fg: palette.inlineCodeFg },
    boolean: { bold: true },
    constant: { bold: true },
    keyword: { bold: true },
    function: { fg: palette.codeHeaderFg },
    type: { fg: palette.codeHeaderFg },
    module: { fg: palette.linkFg },
    attribute: { fg: palette.linkFg },
    label: { italic: true },
  }
}
