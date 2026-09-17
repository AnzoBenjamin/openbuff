import { createHash } from 'node:crypto'

import { getLanguageConfig, hasLanguageConfiguration } from './languages'
import {
  buildQualifiedName,
  getLanguageTag,
  parseFileStructure,
} from './structure'

import type {
  StructureDiagnostic,
  SymbolModifiers,
  SymbolTypeInfo,
} from './structure'

/**
 * A chunk-addressed slice of a source file derived from a structural
 * definition (function, class, method, type, …).
 *
 * Conventions follow `structure.ts` `SymbolRange`: 1-indexed inclusive
 * `startLine`/`endLine`, `depth` by range containment (0 = top level).
 */
export interface CodeChunk {
  /** Deterministic id: sha256(path + qualifiedName + kind + hash) hex. */
  chunkId: string
  /**
   * Content-independent stable slot: sha256(path + qualifiedName + kind).
   * Survives body edits; `hash` remains the version.
   */
  stableChunkId: string
  /** File path as passed to `extractCodeChunks` (typically project-relative). */
  path: string
  /** Depth-aware name: parent names joined by `/` when nested. */
  qualifiedName: string
  /** Normalized definition kind from `parseFileStructure`. */
  kind: string
  /** Display prefix of the header span, trimmed, max 512 chars. */
  signature: string
  /** Full multi-line header/declarator span text (untruncated). */
  signatureText: string
  /** 1-indexed inclusive header span lines. */
  signatureRange: { startLine: number; endLine: number }
  /** 1-indexed inclusive start line. */
  startLine: number
  /** 1-indexed inclusive end line. */
  endLine: number
  /** 1-indexed columns (tree-sitter col + 1). */
  startCol?: number
  endCol?: number
  /** Byte offsets into the source. */
  startByte?: number
  endByte?: number
  /** True when declared under an export statement or with export/pub. */
  exported?: boolean
  /** Language family tag (e.g. `typescript`, `python`). */
  language?: string
  /** Nesting level by range containment (0 = top level). */
  depth: number
  /** Normalized preceding doc-comment text; '' when absent (legacy compat). */
  docComment?: string
  /** 1-indexed inclusive doc-comment span when docs exist. */
  docCommentRange?: { startLine: number; endLine: number }
  /** Structured doc view: normalized text + range. */
  doc?: { text: string; range: { startLine: number; endLine: number } }
  typeInfo?: SymbolTypeInfo
  modifiers?: SymbolModifiers
  /** Outgoing call sites inside this chunk (capped). */
  calls: ChunkCallSite[]
  /** Incoming same-file callers (unambiguous, capped, no self-calls). */
  calledBy: ChunkCaller[]
  /** File imports relevant to this chunk (capped). */
  imports: ChunkImportRef[]
  /** Resolved same-file outgoing references (capped). */
  references: ChunkReference[]
  /** sha256 hex of the chunk text slice (lines joined by `\n`). */
  hash: string
}

export interface ChunkCallSite {
  name: string
  line: number
  col: number
}

export interface ChunkCaller {
  caller: string
  line: number
  col: number
}

export interface ChunkImportRef {
  specifier: string
  line: number
  col: number
  names?: string[]
}

export interface ChunkReference {
  name: string
  line: number
  col: number
  target?: string
}

export interface ChunkDiagnostic {
  filePath: string
  stage: 'language' | 'read' | 'parse'
  message: string
}

export interface ExtractCodeChunksOptions {
  previousChunks?: CodeChunk[]
  contentHash?: string
  diagnostics?: ChunkDiagnostic[]
  /** Compat: accepted but ignored; hash memo remains canonical. */
  previousTree?: unknown
  /** Rename/move alias: previous path for stable-slot lineage lookup. */
  previousPath?: string
}

export interface ExtractCodeChunksResult {
  chunks: CodeChunk[]
  diagnostics: ChunkDiagnostic[]
  reusedChunks: number
  freshChunks: number
}

export const MAX_SIGNATURE_LENGTH = 512
/** Per-chunk edge caps, mirroring parse.ts MAX_CALLERS. */
export const MAX_CHUNK_CALLS = 25
export const MAX_CHUNK_CALLERS = 25
export const MAX_CHUNK_IMPORTS = 25
export const MAX_CHUNK_REFERENCES = 25

function sha256Hex(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

export function hashContent(content: string): string {
  return sha256Hex(content)
}

/**
 * Derive a deterministic chunk id from its address components.
 *
 * `startHash` is the sha256 hex of the chunk text slice (see
 * `extractCodeChunks`). Concatenation order is
 * `path + qualifiedName + kind + startHash`.
 */
export function deriveChunkId(
  path: string,
  qualifiedName: string,
  kind: string,
  startHash: string,
): string {
  return sha256Hex(`${path}${qualifiedName}${kind}${startHash}`)
}

/**
 * Canonical content-independent stable id: sha256(path+qualifiedName+kind).
 * A body edit preserves this id and changes `hash`; a rename/move changes it.
 */
export function deriveStableChunkId(
  path: string,
  qualifiedName: string,
  kind: string,
): string {
  return sha256Hex(`${path}${qualifiedName}${kind}`)
}

const chunkMemo = new Map<string, { contentHash: string; chunks: CodeChunk[] }>()

export function clearChunkMemo(): void {
  chunkMemo.clear()
}

/** Rename/move alias: oldPath -> newPath (bounded, additive). */
export const chunkAlias = new Map<string, string>()
const MAX_CHUNK_ALIASES = 500
const MAX_ALIAS_PATH_LENGTH = 1024
const MAX_ALIAS_RESOLVE_DEPTH = 10

/**
 * Record that `oldPath` was renamed/moved to `newPath` so stable-slot
 * lineage can be resolved via `resolveChunkAlias`. Additive; body-edit
 * stable ID behavior is unchanged.
 */
export function registerChunkRenameAlias(oldPath: string, newPath: string): void {
  if (typeof oldPath !== 'string' || typeof newPath !== 'string') return
  if (oldPath.length === 0 || newPath.length === 0) return
  if (oldPath.length > MAX_ALIAS_PATH_LENGTH || newPath.length > MAX_ALIAS_PATH_LENGTH) return
  if (oldPath === newPath) return
  if (!chunkAlias.has(oldPath) && chunkAlias.size >= MAX_CHUNK_ALIASES) {
    const oldest = chunkAlias.keys().next()
    if (!oldest.done) chunkAlias.delete(oldest.value)
  }
  chunkAlias.set(oldPath, newPath)
}

/**
 * Resolve a path through the rename-alias chain (cycle-safe, depth-capped).
 * Returns the input unchanged when no alias applies.
 */
export function resolveChunkAlias(filePath: string): string {
  if (typeof filePath !== 'string' || filePath.length === 0) return filePath
  let current = filePath
  const seen = new Set<string>([current])
  for (let i = 0; i < MAX_ALIAS_RESOLVE_DEPTH; i++) {
    const next = chunkAlias.get(current)
    if (!next || next.length === 0) break
    if (seen.has(next)) break
    seen.add(next)
    current = next
  }
  return current
}

function remapChunksForPath(chunks: CodeChunk[], newPath: string): CodeChunk[] {
  return chunks.map((chunk) => {
    if (chunk.path === newPath) return chunk
    return {
      ...chunk,
      path: newPath,
      stableChunkId: deriveStableChunkId(newPath, chunk.qualifiedName, chunk.kind),
      chunkId: deriveChunkId(newPath, chunk.qualifiedName, chunk.kind, chunk.hash),
      calls: [...chunk.calls],
      calledBy: [...chunk.calledBy],
      imports: [...chunk.imports],
      references: [...chunk.references],
    }
  })
}

function findAliasMemoChunks(
  filePath: string,
  previousPath: string | undefined,
  currentHash: string,
): CodeChunk[] | null {
  const candidates: string[] = []
  const pushCandidate = (candidate: string) => {
    if (!candidate || candidate === filePath) return
    if (candidate.length > MAX_ALIAS_PATH_LENGTH) return
    if (candidates.includes(candidate)) return
    if (candidates.length >= 10) return
    candidates.push(candidate)
  }
  if (previousPath) {
    pushCandidate(previousPath)
    const resolved = resolveChunkAlias(previousPath)
    pushCandidate(resolved)
  }
  for (const [oldPath, newPath] of chunkAlias) {
    if (candidates.length >= 10) break
    if (newPath === filePath || resolveChunkAlias(oldPath) === filePath) {
      pushCandidate(oldPath)
    }
  }
  for (const candidate of candidates) {
    const memo = chunkMemo.get(candidate)
    if (memo && memo.contentHash === currentHash) {
      if (memo.chunks.length === 0) return []
      return remapChunksForPath(memo.chunks, filePath)
    }
  }
  return null
}

function sliceLines(
  lines: string[],
  startLine: number,
  endLine: number,
): string[] {
  const start = Math.max(1, Math.trunc(startLine))
  const end = Math.max(start, Math.trunc(endLine))
  // slice is 0-indexed exclusive end; clamp safely for out-of-range spans.
  return lines.slice(start - 1, Math.min(end, lines.length))
}

function lastNameSegment(qualifiedName: string): string {
  const parts = qualifiedName.split('/')
  return parts[parts.length - 1] ?? qualifiedName
}

async function extractCallSites(
  content: string,
  filePath: string,
): Promise<ChunkCallSite[]> {
  let cfg
  try {
    cfg = await getLanguageConfig(filePath)
  } catch {
    return []
  }
  if (!cfg?.parser || !cfg?.query) return []
  let tree
  try {
    tree = cfg.parser.parse(content)
  } catch {
    return []
  }
  if (!tree) return []
  try {
    const captures = cfg.query.captures(tree.rootNode)
    const sites: ChunkCallSite[] = []
    for (const capture of captures) {
      const name = (capture as { name?: string }).name ?? ''
      if (!name.toLowerCase().includes('call')) continue
      const node = (capture as { node?: { text?: string; startPosition?: { row: number; column: number } } }).node
      if (!node || typeof node.text !== 'string') continue
      const raw = node.text.split(/\r?\n/, 1)[0]?.trim() ?? ''
      if (!raw) continue
      const short = raw.split(/::|\./).filter(Boolean).pop() ?? raw
      if (!short || short.length > 128) continue
      const pos = node.startPosition
      if (!pos) continue
      sites.push({ name: short, line: pos.row + 1, col: pos.column + 1 })
      if (sites.length >= 500) break
    }
    return sites
  } catch {
    return []
  } finally {
    ;(tree as { delete?: () => void }).delete?.()
  }
}

function extractImportSites(
  lines: string[],
  filePath: string,
): ChunkImportRef[] {
  const dot = filePath.lastIndexOf('.')
  const ext = dot >= 0 ? filePath.slice(dot).toLowerCase() : ''
  const sites: ChunkImportRef[] = []
  const push = (
    specifier: string,
    line: number,
    col: number,
    names?: string[],
  ) => {
    const spec = specifier.trim()
    if (!spec || spec.length > 512) return
    sites.push({
      specifier: spec,
      line,
      col,
      ...(names && names.length > 0 ? { names: names.slice(0, 25) } : {}),
    })
  }
  lines.forEach((rawLine, idx) => {
    const lineNo = idx + 1
    const line = rawLine
    if (['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'].includes(ext)) {
      const fromMatch = line.match(/\b(?:import|export)\b[^'\"]*\bfrom\s+['\"]([^'\"]+)['\"]/)
      if (fromMatch?.[1]) {
        const brace = line.match(/\{([^}]*)\}/)
        const names = brace?.[1]
          ? brace[1].split(',').map((s) => s.trim().split(/\s+/).pop()!).filter(Boolean)
          : undefined
        push(fromMatch[1], lineNo, (line.indexOf(fromMatch[1]) + 1) || 1, names)
        return
      }
      const sideMatch = line.match(/^\s*import\s+['\"]([^'\"]+)['\"]/)
      if (sideMatch?.[1]) {
        push(sideMatch[1], lineNo, (line.indexOf(sideMatch[1]) + 1) || 1)
        return
      }
      const reqMatch = line.match(/\b(?:require|import)\s*\(\s*['\"]([^'\"]+)['\"]\s*\)/)
      if (reqMatch?.[1]) {
        push(reqMatch[1], lineNo, (line.indexOf(reqMatch[1]) + 1) || 1)
        return
      }
      return
    }
    if (['.py', '.pyi'].includes(ext)) {
      const fromMatch = line.match(/^\s*from\s+([.\w]+)\s+import\s+(.+)$/)
      if (fromMatch) {
        const names = (fromMatch[2] ?? '').split(',').map((s) => s.trim().split(/\s+/)[0]!).filter(Boolean)
        push(fromMatch[1], lineNo, (line.indexOf(fromMatch[1]) + 1) || 1, names)
        return
      }
      const impMatch = line.match(/^\s*import\s+([\w.]+)/)
      if (impMatch?.[1]) {
        push(impMatch[1], lineNo, (line.indexOf(impMatch[1]) + 1) || 1, [
          impMatch[1].split('.').pop()!,
        ])
        return
      }
      return
    }
    if (ext === '.rs') {
      const m = line.match(/^\s*(?:pub\s+)?(?:use|mod)\s+([\w:]+)/)
      if (m?.[1]) push(m[1].replace(/::/g, '/'), lineNo, (line.indexOf(m[1]) + 1) || 1)
      return
    }
    if (ext === '.go') {
      const m = line.match(/^\s*import\s+(?:[\w.]+\s+)?["`]([^"`]+)["`]/)
      if (m?.[1]) push(m[1], lineNo, (line.indexOf(m[1]) + 1) || 1)
      return
    }
    if (['.java', '.kt', '.kts'].includes(ext)) {
      const m = line.match(/^\s*import\s+(?:static\s+)?([\w.]+)/)
      if (m?.[1]) push(m[1].replace(/\./g, '/'), lineNo, (line.indexOf(m[1]) + 1) || 1)
      return
    }
    if (['.c', '.cc', '.cpp', '.cxx', '.h', '.hh', '.hpp', '.hxx'].includes(ext)) {
      const m = line.match(/^\s*#\s*include\s*[<"]([^>"]+)[>"]/)
      if (m?.[1]) push(m[1], lineNo, (line.indexOf(m[1]) + 1) || 1)
      return
    }
    if (ext === '.cs') {
      const m = line.match(/^\s*(?:global\s+)?using\s+(?:[\w]+\s*=\s*)?([\w.]+)\s*;/)
      if (m?.[1]) push(m[1].replace(/\./g, '/'), lineNo, (line.indexOf(m[1]) + 1) || 1)
      return
    }
    if (ext === '.rb') {
      const m = line.match(/^\s*require(?:_relative)?\s*[('" ]+([^'"\s)]+)/)
      if (m?.[1]) push(m[1], lineNo, (line.indexOf(m[1]) + 1) || 1)
      return
    }
    if (ext === '.php') {
      const m = line.match(/^\s*use\s+([\w\\]+)/)
      if (m?.[1]) push(m[1].replace(/\\/g, '/'), lineNo, (line.indexOf(m[1]) + 1) || 1)
      return
    }
    if (ext === '.swift') {
      const m = line.match(/^\s*import\s+(?:\w+\s+)?([\w.]+)/)
      if (m?.[1]) push(m[1], lineNo, (line.indexOf(m[1]) + 1) || 1)
      return
    }
    if (ext === '.gd') {
      const m = line.match(/\b(?:preload|load)\s*\(\s*["'](?:res:\/\/)?([^"']+)/)
      if (m?.[1]) push(m[1], lineNo, (line.indexOf(m[1]) + 1) || 1)
      return
    }
  })
  return sites.slice(0, 100)
}

async function buildChunks(
  content: string,
  filePath: string,
  structureDiagnostics: StructureDiagnostic[],
): Promise<{ chunks: CodeChunk[]; callSites: ChunkCallSite[]; importSites: ChunkImportRef[] }> {
  const symbols = await parseFileStructure(content, filePath, structureDiagnostics)
  if (!symbols || symbols.length === 0) return { chunks: [], callSites: [], importSites: [] }

  const lines = content.split(/\r?\n/)
  const language = getLanguageTag(filePath)
  const callSites = await extractCallSites(content, filePath)
  const importSites = extractImportSites(lines, filePath)

  const chunks: CodeChunk[] = symbols.map((sym) => {
    const qualifiedName = buildQualifiedName(symbols, sym)
    const chunkLines = sliceLines(lines, sym.startLine, sym.endLine)
    const chunkText = chunkLines.join('\n')
    const hash = sha256Hex(chunkText)
    const fullHeader = (sym.signatureText ?? lines[Math.max(0, sym.startLine - 1)] ?? '').trim()
    const signature = fullHeader.slice(0, MAX_SIGNATURE_LENGTH)
    const sigStart = sym.signatureStartLine ?? sym.startLine
    const sigEnd = sym.signatureEndLine ?? sym.startLine
    const docText = sym.docText ?? ''
    return {
      chunkId: deriveChunkId(filePath, qualifiedName, sym.kind, hash),
      stableChunkId: deriveStableChunkId(filePath, qualifiedName, sym.kind),
      path: filePath,
      qualifiedName,
      kind: sym.kind,
      signature,
      signatureText: fullHeader,
      signatureRange: { startLine: sigStart, endLine: sigEnd },
      startLine: sym.startLine,
      endLine: sym.endLine,
      ...(sym.startCol !== undefined ? { startCol: sym.startCol } : {}),
      ...(sym.endCol !== undefined ? { endCol: sym.endCol } : {}),
      ...(sym.startByte !== undefined ? { startByte: sym.startByte } : {}),
      ...(sym.endByte !== undefined ? { endByte: sym.endByte } : {}),
      ...(sym.exported ? { exported: true as const } : {}),
      language,
      depth: sym.depth,
      docComment: docText,
      ...(sym.docText
        ? {
            docCommentRange: {
              startLine: sym.docStartLine ?? sym.startLine,
              endLine: sym.docEndLine ?? sym.startLine,
            },
            doc: {
              text: sym.docText,
              range: {
                startLine: sym.docStartLine ?? sym.startLine,
                endLine: sym.docEndLine ?? sym.startLine,
              },
            },
          }
        : {}),
      ...(sym.typeInfo ? { typeInfo: sym.typeInfo } : {}),
      ...(sym.modifiers ? { modifiers: sym.modifiers } : {}),
      calls: [],
      calledBy: [],
      imports: [],
      references: [],
      hash,
    }
  })

  // Index chunks by simple name for unambiguous same-file resolution.
  const bySimpleName = new Map<string, number[]>()
  chunks.forEach((chunk, idx) => {
    const simple = lastNameSegment(chunk.qualifiedName)
    const list = bySimpleName.get(simple) ?? []
    list.push(idx)
    bySimpleName.set(simple, list)
  })

  // Assign outgoing calls to the innermost containing chunk.
  const callOwner = new Map<number, number>()
  callSites.forEach((site, siteIdx) => {
    let best = -1
    let bestSpan = Number.POSITIVE_INFINITY
    chunks.forEach((chunk, idx) => {
      if (site.line < chunk.startLine || site.line > chunk.endLine) return
      const span = chunk.endLine - chunk.startLine
      if (span < bestSpan) {
        bestSpan = span
        best = idx
      }
    })
    if (best >= 0) callOwner.set(siteIdx, best)
  })

  // Outgoing calls + resolved references.
  callSites.forEach((site, siteIdx) => {
    const owner = callOwner.get(siteIdx)
    if (owner === undefined) return
    const chunk = chunks[owner]!
    if (chunk.calls.length < MAX_CHUNK_CALLS) {
      const last = chunk.calls[chunk.calls.length - 1]
      if (!(last && last.name === site.name && last.line === site.line && last.col === site.col)) {
        chunk.calls.push({ name: site.name, line: site.line, col: site.col })
      }
    }
    const candidates = (bySimpleName.get(site.name) ?? []).filter((idx) => idx !== owner)
    if (candidates.length === 0) return
    // Same-file === same language: keep the unambiguous rule by skipping
    // only when the name matches no local definition is handled above.
    // Overloads share one qualifiedName; link each distinct chunk once.
    const seenTargets = new Set<string>()
    for (const targetIdx of candidates) {
      const target = chunks[targetIdx]!
      const key = `${target.qualifiedName}\0${target.kind}`
      if (seenTargets.has(key)) continue
      seenTargets.add(key)
      if (chunk.references.length < MAX_CHUNK_REFERENCES) {
        chunk.references.push({
          name: site.name,
          line: site.line,
          col: site.col,
          target: target.qualifiedName,
        })
      }
      break
    }
  })

  // Incoming calledBy: invert resolved outgoing calls, skip self-calls.
  callSites.forEach((site, siteIdx) => {
    const owner = callOwner.get(siteIdx)
    if (owner === undefined) return
    const caller = chunks[owner]!
    const candidates = (bySimpleName.get(site.name) ?? []).filter((idx) => idx !== owner)
    if (candidates.length === 0) return
    const distinct = new Map<string, number>()
    for (const idx of candidates) {
      const target = chunks[idx]!
      const key = `${target.qualifiedName}\0${target.kind}`
      if (!distinct.has(key)) distinct.set(key, idx)
    }
    // Unambiguous same-language rule: when several unrelated definitions
    // share one bare name, do not guess; link only a single logical target.
    if (distinct.size !== 1) return
    const targetIdx = [...distinct.values()][0]!
    const target = chunks[targetIdx]!
    if (target.calledBy.length >= MAX_CHUNK_CALLERS) return
    if (target.calledBy.some((c) => c.caller === caller.qualifiedName && c.line === site.line && c.col === site.col)) return
    target.calledBy.push({ caller: caller.qualifiedName, line: site.line, col: site.col })
  })

  // Per-chunk imports: inside-span imports plus name-relevant file imports.
  chunks.forEach((chunk) => {
    const callNames = new Set(chunk.calls.map((c) => c.name))
    const chunkText = sliceLines(lines, chunk.startLine, chunk.endLine).join('\n')
    for (const imp of importSites) {
      if (chunk.imports.length >= MAX_CHUNK_IMPORTS) break
      const insideSpan = imp.line >= chunk.startLine && imp.line <= chunk.endLine
      const nameHit = (imp.names ?? []).some((n) => callNames.has(n) || chunkText.includes(n))
      if (insideSpan || nameHit) {
        if (!chunk.imports.some((e) => e.specifier === imp.specifier && e.line === imp.line)) {
          chunk.imports.push({ ...imp })
        }
      }
    }
  })

  return { chunks, callSites, importSites }
}

/**
 * Extract chunk-addressed slices from source content using tree-sitter
 * structure (`parseFileStructure`).
 *
 * Unlike `parseFileStructure` (which returns `null` when no grammar is
 * available), this returns `[]` for unsupported extensions, empty files,
 * and files with no definitions. New `opts` are optional for compat:
 * pass `previousChunks` + `contentHash` to reuse without a fresh parse
 * when the content hash is unchanged.
 */
export async function extractCodeChunks(
  content: string,
  filePath: string,
  opts?: ExtractCodeChunksOptions,
): Promise<CodeChunk[]> {
  const result = await extractCodeChunksDetailed(content, filePath, opts)
  if (opts) {
    if (opts.diagnostics) {
      opts.diagnostics.length = 0
      opts.diagnostics.push(...result.diagnostics)
    } else {
      opts.diagnostics = [...result.diagnostics]
    }
  }
  return result.chunks
}

export async function extractCodeChunksDetailed(
  content: string,
  filePath: string,
  opts?: ExtractCodeChunksOptions,
): Promise<ExtractCodeChunksResult> {
  const currentHash = hashContent(content)
  const contentHash = opts?.contentHash ?? currentHash
  // Compat: tree-sitter edit path stays out of scope; hash memo is canonical.
  void opts?.previousTree
  // Incremental fast path: no fresh parse() when the hash is unchanged and
  // the caller hands back the previous chunks for this path.
  if (opts?.previousChunks && opts.contentHash !== undefined && opts.contentHash === currentHash) {
    const cached = opts.previousChunks
    // Rename/move lineage: remap stable-slot ids when the caller hands back
    // chunks extracted under a previous path. Same-path reuse keeps identity.
    const needsRemap =
      cached.length > 0 && cached[0]?.path !== undefined && cached[0]?.path !== filePath
    const chunksForPath = needsRemap ? remapChunksForPath(cached, filePath) : cached
    chunkMemo.set(filePath, { contentHash: currentHash, chunks: chunksForPath })
    return {
      chunks: chunksForPath,
      diagnostics: [],
      reusedChunks: chunksForPath.length,
      freshChunks: 0,
    }
  }
  const memo = chunkMemo.get(filePath)
  if (memo && memo.contentHash === currentHash) {
    return {
      chunks: memo.chunks,
      diagnostics: [],
      reusedChunks: memo.chunks.length,
      freshChunks: 0,
    }
  }
  // Rename/move alias lineage: reuse the memo entry stored under the previous
  // path (explicit `previousPath` or a registered alias) when the content
  // hash is unchanged. Body-edit stable ID behavior is unchanged.
  const aliasHit = findAliasMemoChunks(filePath, opts?.previousPath, currentHash)
  if (aliasHit) {
    chunkMemo.set(filePath, { contentHash: currentHash, chunks: aliasHit })
    return {
      chunks: aliasHit,
      diagnostics: [],
      reusedChunks: aliasHit.length,
      freshChunks: 0,
    }
  }
  const structureDiagnostics: StructureDiagnostic[] = []
  const { chunks } = await buildChunks(content, filePath, structureDiagnostics)
  const diagnostics: ChunkDiagnostic[] = structureDiagnostics.map((d) => ({
    filePath: d.filePath,
    stage: d.stage === 'language' ? ('language' as const) : ('parse' as const),
    message: d.message,
  }))
  // Surface a diagnostic instead of a silent [] when nothing was produced
  // because the language is unsupported or the parse failed.
  if (chunks.length === 0 && diagnostics.length === 0 && content.trim().length > 0) {
    diagnostics.push({
      filePath,
      stage: hasLanguageConfiguration(filePath) ? ('parse' as const) : ('language' as const),
      message: hasLanguageConfiguration(filePath)
        ? `No definitions extracted for ${filePath}`
        : `No tree-sitter language configuration available for ${filePath}`,
    })
  }
  if (chunks.length > 0 || content.length === 0) {
    chunkMemo.set(filePath, { contentHash: currentHash, chunks })
  }
  void contentHash
  return {
    chunks,
    diagnostics,
    reusedChunks: 0,
    freshChunks: chunks.length,
  }
}
