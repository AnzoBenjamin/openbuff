import {
  decodeReadCapabilityToken,
  encodeReadCapabilityToken,
  getContentHash,
  normalizeLineEndings,
  readCapabilityMatchesScope,
} from '@codebuff/common/util/content-hash'

import type { SymbolRange } from '@codebuff/code-map'
import type {
  FilesystemError,
  ReadFilesItemV1,
} from '@codebuff/common/tools/results/filesystem'
import type { ReadCapabilityScope } from '@codebuff/common/util/content-hash'

/**
 * Tree-sitter-backed structural extraction for the read_outline tool and
 * read_files symbol slicing, shared so both behave identically across languages.
 *
 * code-map is imported dynamically: its module top-level constructs a
 * tree-sitter loader and kicks off WASM init, which we do NOT want to trigger
 * at agent-runtime load time (e.g. in environments that never call these
 * tools). A failed import or parse degrades gracefully to `null`, letting the
 * caller fall back to a regex heuristic.
 */
export async function getFileStructure(
  content: string,
  filePath: string,
): Promise<SymbolRange[] | null> {
  try {
    const { parseFileStructure } = await import('@codebuff/code-map')
    return await parseFileStructure(content, filePath)
  } catch (err) {
    // Degrade gracefully to null (caller falls back to regex heuristic), but
    // surface the failure so a broken code-map install doesn't silently drop
    // structural reads for the whole session.
    console.debug(
      `[structural-read] getFileStructure failed for ${filePath}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    )
    return null
  }
}

/** Imports/includes/module lines worth surfacing in an outline header. */
const IMPORT_LINE_REGEX =
  /^\s*(?:import\b|from\s+\S+\s+import\b|export\s+\{|export\s+\*|const\s+\w+\s*=\s*require\(|require\s|use\s+\w|#include\b|using\s+\w|package\s+\w|namespace\s+\w)/

export function extractImportLines(
  content: string,
  limit = 60,
): { line: number; text: string }[] {
  const out: { line: number; text: string }[] = []
  const lines = content.split(/\r?\n/)
  for (let i = 0; i < lines.length && out.length < limit; i++) {
    const trimmed = lines[i].trim()
    if (trimmed.length === 0) continue
    if (IMPORT_LINE_REGEX.test(lines[i])) {
      out.push({ line: i + 1, text: trimmed })
    }
  }
  return out
}

// Extend a symbol's 1-indexed start line upward to include a contiguous,
// immediately-preceding comment block (JSDoc slash-star block, block comment,
// or consecutive slash-slash line comments). Stops at the first blank line or
// non-comment line, and only extends when the comment block is directly
// adjacent to the symbol (no blank-line gap). Returns the adjusted start line
// (unchanged if there is no preceding comment block).
//
// Used by rewrite_symbol so the old doc-block is replaced atomically with the
// symbol, avoiding orphan/duplicate JSDoc blocks that would shift line numbers
// and invalidate cached anchors on subsequent edits.
export function extendRangeToPrecedingComment(
  lines: string[],
  symbolStartLine: number,
): { startLine: number; commentPrefix: string } {
  // The line immediately preceding the symbol (1-indexed → 0-indexed).
  const prevIdx = symbolStartLine - 2
  if (prevIdx < 0) return { startLine: symbolStartLine, commentPrefix: '' }

  const prevLine = lines[prevIdx]

  // Case 1: preceding line ends a block/JSDoc comment (`*/`). Walk upward to
  // find the matching opener `/*`, requiring no blank line in between.
  if (/\*\/\s*$/.test(prevLine)) {
    let openerIdx = prevIdx
    let foundOpen = false
    while (openerIdx >= 0) {
      const line = lines[openerIdx]
      if (openerIdx !== prevIdx && line.trim() === '') {
        // Blank line between opener and closer → not contiguous.
        return { startLine: symbolStartLine, commentPrefix: '' }
      }
      if (line.includes('/*') && !/^\s*\*\//.test(line)) {
        foundOpen = true
        break
      }
      openerIdx--
    }
    if (foundOpen) {
      const blockLines = lines.slice(openerIdx, prevIdx + 1)
      return {
        startLine: openerIdx + 1,
        commentPrefix: blockLines.join('\n') + '\n',
      }
    }
  }

  // Case 2: preceding line is a `//` line comment. Grab the contiguous run.
  if (/^\s*\/\//.test(prevLine)) {
    let runStart = prevIdx
    while (runStart - 1 >= 0 && /^\s*\/\//.test(lines[runStart - 1])) {
      runStart--
    }
    const runLines = lines.slice(runStart, prevIdx + 1)
    return {
      startLine: runStart + 1,
      commentPrefix: runLines.join('\n') + '\n',
    }
  }

  return { startLine: symbolStartLine, commentPrefix: '' }
}

/**
 * Mint a read capability token for a 1-indexed inclusive line range, using the
 * exact same LF-normalization + hashing as read_files / str_replace so the
 * token validates identically when later passed as basedOnRead on an edit.
 */
export function mintSliceCapability(params: {
  content: string
  startLine: number
  endLine: number
  scope?: ReadCapabilityScope
}): { readCapability?: string; rangeHash: string; sliceContent: string } {
  const { content, startLine, endLine } = params
  const lines = content.replace(/\r\n/g, '\n').split('\n')
  const start = Math.max(1, startLine)
  const end = Math.min(lines.length, Math.max(start, endLine))
  const sliceContent = lines.slice(start - 1, end).join('\n')
  const rangeHash = getContentHash(sliceContent)
  return {
    ...(params.scope
      ? {
          readCapability: encodeReadCapabilityToken({
            startLine: start,
            endLine: end,
            hash: rangeHash,
            scope: params.scope,
          }),
        }
      : {}),
    rangeHash,
    sliceContent,
  }
}

export function validateRewriteSymbolReadCapability(params: {
  readCapability: string
  path: string
  slice: Pick<ExtractedSlice, 'content' | 'startLine' | 'endLine'>
  scope?: Omit<ReadCapabilityScope, 'path'>
}): string | undefined {
  const decoded = decodeReadCapabilityToken(params.readCapability)
  if (typeof decoded === 'string') return decoded
  if (!params.scope?.projectId || !params.scope.runId) {
    return `rewrite_symbol blocked for ${params.path}: authenticated readCapability scope is unavailable.`
  }
  if (
    !readCapabilityMatchesScope(decoded, {
      ...params.scope,
      path: params.path,
    })
  ) {
    return `rewrite_symbol blocked for ${params.path}: the readCapability belongs to a different project, path, or agent run.`
  }
  if (
    decoded.startLine !== params.slice.startLine ||
    decoded.endLine !== params.slice.endLine
  ) {
    return `rewrite_symbol blocked for ${params.path}: the readCapability does not cover the exact original symbol replacement span ${params.slice.startLine}-${params.slice.endLine}.`
  }
  if (getContentHash(params.slice.content) !== decoded.hash) {
    return `rewrite_symbol blocked for ${params.path}: the readCapability-covered symbol content is stale.`
  }
  return undefined
}

/** Render a tree-sitter structure list into a compact, indented outline. */
export function renderStructureOutline(
  content: string,
  symbols: SymbolRange[],
): string {
  const importLines = extractImportLines(content)
  const lines: string[] = []
  for (const imp of importLines) {
    lines.push(`Line ${imp.line}: ${imp.text}`)
  }
  if (importLines.length > 0 && symbols.length > 0) lines.push('')
  for (const sym of symbols) {
    const indent = '  '.repeat(sym.depth)
    const span =
      sym.startLine === sym.endLine
        ? `Line ${sym.startLine}`
        : `Lines ${sym.startLine}-${sym.endLine}`
    lines.push(`${indent}${span}: ${sym.kind} ${sym.name}`)
  }
  return lines.join('\n')
}

export type ExtractedSlice = {
  symbol: string
  kind?: string
  content: string
  startLine: number
  endLine: number
  readCapability?: string
}

/** 1-indexed line number containing the 0-indexed character offset `index`. */
function getLineNumberAtIndex(content: string, index: number): number {
  let line = 1
  const end = Math.min(index, content.length)
  for (let i = 0; i < end; i++) {
    if (content.charCodeAt(i) === 10) {
      line++
    }
  }
  return line
}

/**
 * Shared exact-literal occurrence walk (indexOf-based, non-overlapping
 * matches). Returns the 1-indexed inclusive line range of every occurrence of
 * `match` in `content`, up to `limit`. This is the single source of truth for
 * literal-occurrence line mapping, used by process-str-replace
 * (occurrenceIndex targeting and diagnostics) and by the read_files `around`
 * selector, so both agree on occurrence ordering and line spans.
 */
export function findLiteralOccurrences(
  content: string,
  match: string,
  limit: number = Number.MAX_SAFE_INTEGER,
): { startLine: number; endLine: number }[] {
  const ranges: { startLine: number; endLine: number }[] = []
  if (!match) return ranges
  let index = content.indexOf(match)

  while (index !== -1 && ranges.length < limit) {
    ranges.push({
      startLine: getLineNumberAtIndex(content, index),
      endLine: getLineNumberAtIndex(content, index + match.length),
    })
    index = content.indexOf(match, index + Math.max(1, match.length))
  }

  return ranges
}

/**
 * Returns the 0-indexed character offset of the Nth (1-indexed) exact
 * occurrence of `match` in `content`, or -1 when fewer than N exist.
 */
export function nthLiteralOccurrenceIndex(
  content: string,
  match: string,
  n: number,
): number {
  if (!match) return -1
  let index = content.indexOf(match)
  let count = 1
  while (index !== -1 && count < n) {
    index = content.indexOf(match, index + Math.max(1, match.length))
    count++
  }
  return count === n ? index : -1
}

/**
 * Returns the 1-indexed inclusive line range of the Nth (1-indexed) exact
 * occurrence of `match` in `content`, or null when fewer than N exist.
 */
export function nthOccurrenceLineRange(
  content: string,
  match: string,
  n: number,
): { startLine: number; endLine: number } | null {
  const index = nthLiteralOccurrenceIndex(content, match, n)
  if (index === -1) return null
  return {
    startLine: getLineNumberAtIndex(content, index),
    endLine: getLineNumberAtIndex(content, index + match.length),
  }
}

/**
 * Resolve the ABSOLUTE 1-indexed inclusive line range of the Nth (1-indexed,
 * default 1) exact literal occurrence of `match`, searched only inside the
 * capability-authorized line window `capabilityStartLine..capabilityEndLine`
 * of `content`. Occurrence ordering and line spans come from the shared
 * literal-occurrence helpers above, so replace_range agrees with read_files
 * and str_replace. `found` reports how many occurrences exist inside the
 * authorized window, for not-found diagnostics.
 */
export function resolveOccurrenceRangeInCapabilityRange(params: {
  content: string
  match: string
  occurrence?: number
  capabilityStartLine: number
  capabilityEndLine: number
}): {
  range: { startLine: number; endLine: number } | null
  found: number
} {
  const { content, match, capabilityStartLine, capabilityEndLine } = params
  const authorizedContent = normalizeLineEndings(content)
    .split('\n')
    .slice(capabilityStartLine - 1, capabilityEndLine)
    .join('\n')
  const range = nthOccurrenceLineRange(
    authorizedContent,
    match,
    params.occurrence ?? 1,
  )
  if (!range) {
    return {
      range: null,
      found: findLiteralOccurrences(authorizedContent, match).length,
    }
  }
  // Authorized-slice line numbers are relative to capabilityStartLine.
  const lineOffset = capabilityStartLine - 1
  return {
    range: {
      startLine: range.startLine + lineOffset,
      endLine: range.endLine + lineOffset,
    },
    found: 1,
  }
}

const DEFAULT_MAX_MATCHES_PER_SYMBOL = 5

/**
 * Extract code slices for the given symbol names from a file's raw content,
 * preferring tree-sitter structure and falling back to a regex heuristic for
 * unparseable files or symbols the parser doesn't surface. Parser-proven
 * declarations carry an edit capability; heuristic slices are read-only and
 * require an exact range read before editing.
 *
 * Shared by read_files (symbols mode).
 */
export async function extractSlices(
  rawContent: string,
  filePath: string,
  symbols: string[],
  maxMatchesPerSymbol: number = DEFAULT_MAX_MATCHES_PER_SYMBOL,
  capabilityScope?: ReadCapabilityScope,
): Promise<ExtractedSlice[]> {
  const slices: ExtractedSlice[] = []
  const structure = await getFileStructure(rawContent, filePath)
  const lines = rawContent.replace(/\r\n/g, '\n').split('\n')

  for (const symbol of symbols) {
    const astMatches =
      structure
        ?.filter((s) => s.name === symbol)
        .slice(0, maxMatchesPerSymbol) ?? []

    if (astMatches.length > 0) {
      for (const match of astMatches) {
        const { startLine } = extendRangeToPrecedingComment(
          lines,
          match.startLine,
        )
        const { readCapability, sliceContent } = mintSliceCapability({
          content: rawContent,
          startLine,
          endLine: match.endLine,
          scope: capabilityScope,
        })
        slices.push({
          symbol,
          kind: match.kind,
          content: sliceContent,
          startLine,
          endLine: match.endLine,
          readCapability,
        })
      }
      continue
    }

    const fallback = regexSlice(rawContent, symbol, filePath)
    if (fallback) {
      const { startLine } = extendRangeToPrecedingComment(
        lines,
        fallback.startLine,
      )
      const sliceContent = lines
        .slice(startLine - 1, fallback.endLine)
        .join('\n')
      slices.push({
        symbol,
        content: sliceContent,
        startLine,
        endLine: fallback.endLine,
      })
    }
  }

  return slices
}

/**
 * Select a single symbol slice by name and 1-indexed occurrence, mirroring
 * rewrite_symbol's `occurrence` semantics: when several top-level symbols
 * share the name, `occurrence` picks that AST match (default 1). Wraps
 * extractSlices without changing its signature or multi-match behavior.
 * Returns null when the name (or that occurrence) is not present.
 */
export async function selectSymbolSlice(params: {
  rawContent: string
  filePath: string
  name: string
  occurrence?: number
  capabilityScope?: ReadCapabilityScope
}): Promise<ExtractedSlice | null> {
  const occurrence = params.occurrence ?? 1
  const slices = await extractSlices(
    params.rawContent,
    params.filePath,
    [params.name],
    occurrence,
    params.capabilityScope,
  )
  return slices[occurrence - 1] ?? null
}

/**
 * Heuristic single-symbol slicer used only when tree-sitter cannot provide a
 * range. Returns a 1-indexed inclusive line span or null. Brace-based for
 * C-family languages, indentation-based for Python.
 *
 * Brace counting is done over a string/comment-stripped projection so braces
 * inside `"…{ }…"`, `'…'`, template literals, `/* … *\/`, and `// …` comments
 * do not skew the count. Without this, code like `console.log("}")` or block
 * comments containing `{` could close the symbol body early (or never).
 */
function regexSlice(
  rawContent: string,
  symbol: string,
  filePath: string,
): { startLine: number; endLine: number } | null {
  const lines = rawContent.split(/\r?\n/)
  const isPython = filePath.endsWith('.py')
  const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const symbolRegex = new RegExp(`\\b${escaped}\\b`)

  let startLine = -1
  for (let i = 0; i < lines.length; i++) {
    if (symbolRegex.test(lines[i])) {
      const line = lines[i]
      if (
        /\b(function|class|const|let|var|def|interface|type|struct|fn|func)\b/.test(
          line,
        ) ||
        /^\s*(?:(?:public|private|protected|static|async|export)\s+)*[A-Za-z_$][\w$]*\s*\([^;]*\)\s*(?::[^={]+)?\s*[{:]\s*$/.test(
          line,
        )
      ) {
        startLine = i
        break
      }
    }
  }
  if (startLine === -1) return null

  let endLine = startLine
  if (isPython) {
    const startIndent =
      lines[startLine].length - lines[startLine].trimStart().length
    for (let j = startLine + 1; j < lines.length; j++) {
      const trimmed = lines[j].trim()
      if (trimmed.length === 0) {
        endLine = j
        continue
      }
      const indent = lines[j].length - lines[j].trimStart().length
      if (indent <= startIndent) break
      endLine = j
    }
  } else {
    // Project each line onto a brace-only view by stripping strings, template
    // literals, and comments so quoted/commented braces don't move the count.
    let braceCount = 0
    let foundBrace = false
    let inBlockComment = false
    for (let j = startLine; j < lines.length; j++) {
      const stripped = stripStringsAndComments(lines[j], inBlockComment)
      inBlockComment = stripped.endedInBlockComment
      for (const char of stripped.text) {
        if (char === '{') {
          braceCount++
          foundBrace = true
        } else if (char === '}') {
          braceCount--
        }
      }
      endLine = j
      if (foundBrace && braceCount <= 0) break
    }
  }

  return { startLine: startLine + 1, endLine: endLine + 1 }
}

// ---------------------------------------------------------------------------
// Shared per-selector block builders (read_files windows/around/symbol)
// ---------------------------------------------------------------------------

/** Capabilities the block builders need from their calling handler. */
export type ReadBlockBuilderContext = {
  /** Memoized per-path file loader (single underlying read per path). */
  loadFile: (
    path: string,
  ) => Promise<{ content: string } | { error: FilesystemError }>
  /** Mint a cap.v3 editAnchor for a complete block, or undefined when the
   * authoritative scope is unavailable. */
  mintBlockEditAnchor: (
    path: string,
    startLine: number,
    endLine: number,
    blockContent: string,
  ) =>
    | {
        startLine: number
        endLine: number
        contentHash: string
        readCapability: string
      }
    | undefined
  /** Run the shared coverage → authority ladder for a completed block. */
  applyBlockAuthority: (params: {
    path: string
    startLine: number
    endLine: number
    totalLines: number
    sourceContent: string
    capabilityEligible?: boolean
  }) => void
  /** Return a too_large error when a block exceeds the per-block byte budget. */
  overBudgetError: (blockContent: string) => FilesystemError | undefined
  /** Scope used to mint parser-proven symbol-slice capabilities. */
  capabilityIssuer: { projectId: string; runId: string }
  /** Tracks paths with at least one successful block read. */
  successfulReadPaths: Set<string>
}

const DEFAULT_WINDOW_SIZE = 400
const DEFAULT_CONTEXT_LINES = 40

/** Build one `window` selector item (or an error item) for a windowed read. */
export async function buildWindowBlock(
  ctx: ReadBlockBuilderContext,
  request: { path: string; windowSize?: number; window?: number },
  requestIndex: number,
): Promise<ReadFilesItemV1> {
  const path = request.path
  const loaded = await ctx.loadFile(path)
  if ('error' in loaded) {
    return {
      selector: 'window',
      requestIndex,
      path,
      status: 'error',
      error: loaded.error,
    }
  }
  const lines = normalizeLineEndings(loaded.content).split('\n')
  const totalLines = lines.length
  const windowSize = request.windowSize ?? DEFAULT_WINDOW_SIZE
  const windowCount = Math.max(1, Math.ceil(totalLines / windowSize))
  const window = request.window ?? 1
  if (window > windowCount) {
    return {
      selector: 'window',
      requestIndex,
      path,
      status: 'error',
      error: {
        code: 'invalid_request',
        message: `read_files window ${window} is out of range for ${path}: the file has ${totalLines} lines (${windowCount} window(s) of ${windowSize} lines). Omit window to get the manifest plus the first window.`,
        retryable: true,
        recovery: 'read_smaller_range',
      },
    }
  }
  const startLine = (window - 1) * windowSize + 1
  const endLine = Math.min(totalLines, window * windowSize)
  const blockContent = lines.slice(startLine - 1, endLine).join('\n')
  const tooLarge = ctx.overBudgetError(blockContent)
  if (tooLarge) {
    return {
      selector: 'window',
      requestIndex,
      path,
      status: 'error',
      error: tooLarge,
    }
  }
  const editAnchor = ctx.mintBlockEditAnchor(
    path,
    startLine,
    endLine,
    blockContent,
  )
  ctx.successfulReadPaths.add(path)
  const item: ReadFilesItemV1 = {
    selector: 'window',
    requestIndex,
    path,
    status: 'ok',
    content: blockContent,
    sourceContent: blockContent,
    startLine,
    endLine,
    totalLines,
    complete: true,
    windowSize,
    windowCount,
    window,
    ...(editAnchor ? { editAnchor } : {}),
  }
  ctx.applyBlockAuthority({
    path,
    startLine,
    endLine,
    totalLines,
    sourceContent: blockContent,
  })
  return item
}

/** Build one `around` selector item (or an error item) for an anchored read. */
export async function buildAroundBlock(
  ctx: ReadBlockBuilderContext,
  request: {
    path: string
    match: string
    occurrence?: number
    contextLines?: number
  },
  requestIndex: number,
): Promise<ReadFilesItemV1> {
  const path = request.path
  const loaded = await ctx.loadFile(path)
  if ('error' in loaded) {
    return {
      selector: 'around',
      requestIndex,
      path,
      status: 'error',
      error: loaded.error,
    }
  }
  const normalized = normalizeLineEndings(loaded.content)
  const lines = normalized.split('\n')
  const totalLines = lines.length
  const occurrence = request.occurrence ?? 1
  const contextLines = request.contextLines ?? DEFAULT_CONTEXT_LINES
  const occurrences = findLiteralOccurrences(normalized, request.match)
  const matched = occurrences[occurrence - 1]
  if (!matched) {
    return {
      selector: 'around',
      requestIndex,
      path,
      status: 'error',
      error: {
        code: 'no_match',
        message: `read_files found ${occurrences.length} exact occurrence(s) of the match in ${path}, so occurrence ${occurrence} does not exist. Re-check the literal text against a fresh read.`,
        retryable: true,
        recovery: 'read_again',
      },
    }
  }
  const startLine = Math.max(1, matched.startLine - contextLines)
  const endLine = Math.min(totalLines, matched.endLine + contextLines)
  const blockContent = lines.slice(startLine - 1, endLine).join('\n')
  const tooLarge = ctx.overBudgetError(blockContent)
  if (tooLarge) {
    return {
      selector: 'around',
      requestIndex,
      path,
      status: 'error',
      error: tooLarge,
    }
  }
  const editAnchor = ctx.mintBlockEditAnchor(
    path,
    startLine,
    endLine,
    blockContent,
  )
  ctx.successfulReadPaths.add(path)
  const item: ReadFilesItemV1 = {
    selector: 'around',
    requestIndex,
    path,
    status: 'ok',
    content: blockContent,
    sourceContent: blockContent,
    startLine,
    endLine,
    totalLines,
    complete: true,
    match: request.match,
    occurrence,
    totalOccurrences: occurrences.length,
    ...(editAnchor ? { editAnchor } : {}),
  }
  ctx.applyBlockAuthority({
    path,
    startLine,
    endLine,
    totalLines,
    sourceContent: blockContent,
  })
  return item
}

/** Build one `symbol` selector item (or an error item) for an occurrence-aware symbol read. */
export async function buildSymbolBlock(
  ctx: ReadBlockBuilderContext,
  request: { path: string; name: string; occurrence?: number },
  requestIndex: number,
): Promise<ReadFilesItemV1> {
  const path = request.path
  const loaded = await ctx.loadFile(path)
  if ('error' in loaded) {
    return {
      selector: 'symbol',
      requestIndex,
      path,
      status: 'error',
      error: loaded.error,
    }
  }
  const occurrence = request.occurrence ?? 1
  const slice = await selectSymbolSlice({
    rawContent: loaded.content,
    filePath: path,
    name: request.name,
    occurrence,
    capabilityScope: { ...ctx.capabilityIssuer, path },
  })
  if (!slice) {
    return {
      selector: 'symbol',
      requestIndex,
      path,
      status: 'error',
      error: {
        code: 'no_match',
        message: `Symbol "${request.name}" (occurrence ${occurrence}) was not found in ${path}. Use read_outline to list the available symbols, then retry with an exact name.`,
        retryable: true,
        recovery: 'choose_symbol',
      },
    }
  }
  const totalLines = normalizeLineEndings(loaded.content).split('\n').length
  const tooLarge = ctx.overBudgetError(slice.content)
  if (tooLarge) {
    return {
      selector: 'symbol',
      requestIndex,
      path,
      status: 'error',
      error: tooLarge,
    }
  }
  // Mirror read_files: only parser-proven slices (which carry a minted
  // readCapability) expose an editAnchor; heuristic regex slices stay
  // read-only and require an anchored window/around read before editing.
  const editAnchor = slice.readCapability
    ? ctx.mintBlockEditAnchor(
        path,
        slice.startLine,
        slice.endLine,
        slice.content,
      )
    : undefined
  ctx.successfulReadPaths.add(path)
  const item: ReadFilesItemV1 = {
    selector: 'symbol',
    requestIndex,
    path,
    status: 'ok',
    content: slice.content,
    sourceContent: slice.content,
    startLine: slice.startLine,
    endLine: slice.endLine,
    totalLines,
    complete: true,
    symbol: slice.symbol,
    ...(slice.kind ? { kind: slice.kind } : {}),
    occurrence,
    ...(editAnchor ? { editAnchor } : {}),
  }
  // A whole-file-spanning slice may grant, but only when the slice is
  // parser-proven; heuristic slices classify as 'none'.
  ctx.applyBlockAuthority({
    path,
    startLine: slice.startLine,
    endLine: slice.endLine,
    totalLines,
    sourceContent: slice.content,
    capabilityEligible: Boolean(slice.readCapability),
  })
  return item
}

/**
 * Project a source line onto a string/comment-free view used for brace
 * counting in `regexSlice`. Tracks whether the line ends still inside a
 * `/* … *\/` block comment so the caller can carry that state forward.
 *
 * Handled lexical contexts:
 *  - double-quoted strings (with `\"` escape)
 *  - single-quoted strings (with `\'` escape)
 *  - template literals (backtick, with `\`` escape; does NOT recurse into
 *    `${…}` interpolations, which is a conservative approximation but still
 *    drops the literal text correctly)
 *  - line comments `// …` (rest of line is dropped)
 *  - block comments `/* … *\/` (across lines via `startsInBlockComment`)
 */
function stripStringsAndComments(
  line: string,
  startsInBlockComment: boolean,
): { text: string; endedInBlockComment: boolean } {
  let out = ''
  let inBlock = startsInBlockComment
  let i = 0
  while (i < line.length) {
    if (inBlock) {
      const close = line.indexOf('*/', i)
      if (close === -1) {
        return { text: out, endedInBlockComment: true }
      }
      i = close + 2
      inBlock = false
      continue
    }
    const ch = line[i]
    const next = line[i + 1]
    if (ch === '/' && next === '*') {
      inBlock = true
      i += 2
      continue
    }
    if (ch === '/' && next === '/') {
      // Rest of line is a comment.
      return { text: out, endedInBlockComment: false }
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch
      i++
      while (i < line.length) {
        const c = line[i]
        if (c === '\\') {
          i += 2
          continue
        }
        if (c === quote) {
          i++
          break
        }
        i++
      }
      continue
    }
    out += ch
    i++
  }
  return { text: out, endedInBlockComment: inBlock }
}
