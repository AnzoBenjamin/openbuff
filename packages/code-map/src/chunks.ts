import { createHash } from 'node:crypto'

import { parseFileStructure } from './structure'

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
  /** File path as passed to `extractCodeChunks` (typically project-relative). */
  path: string
  /** Depth-aware name: parent names joined by `/` when nested. */
  qualifiedName: string
  /** Normalized definition kind from `parseFileStructure`. */
  kind: string
  /** First line of the chunk, trimmed, max 512 chars. */
  signature: string
  /** 1-indexed inclusive start line. */
  startLine: number
  /** 1-indexed inclusive end line. */
  endLine: number
  /** Nesting level by range containment (0 = top level). */
  depth: number
  /** Reserved for future doc-comment extraction; always empty in Phase A1. */
  docComment?: string
  /** sha256 hex of the chunk text slice (lines joined by `\n`). */
  hash: string
}

const MAX_SIGNATURE_LENGTH = 512

function sha256Hex(text: string): string {
  return createHash('sha256').update(text).digest('hex')
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
 * Extract chunk-addressed slices from source content using tree-sitter
 * structure (`parseFileStructure`).
 *
 * Unlike `parseFileStructure` (which returns `null` when no grammar is
 * available), this returns `[]` for unsupported extensions, empty files,
 * and files with no definitions.
 */
export async function extractCodeChunks(
  content: string,
  filePath: string,
): Promise<CodeChunk[]> {
  const symbols = await parseFileStructure(content, filePath)
  if (!symbols || symbols.length === 0) return []

  const lines = content.split(/\r?\n/)

  const sliceLines = (startLine: number, endLine: number): string[] => {
    const start = Math.max(1, Math.trunc(startLine))
    const end = Math.max(start, Math.trunc(endLine))
    // slice is 0-indexed exclusive end; clamp safely for out-of-range spans.
    return lines.slice(start - 1, Math.min(end, lines.length))
  }

  return symbols.map((sym) => {
    const containers = symbols
      .filter(
        (other) =>
          other !== sym &&
          other.startLine <= sym.startLine &&
          other.endLine >= sym.endLine &&
          (other.startLine < sym.startLine || other.endLine > sym.endLine),
      )
      .sort((a, b) => a.depth - b.depth || b.endLine - b.startLine - (a.endLine - a.startLine))
    const qualifiedName = [...containers.map((c) => c.name), sym.name].join('/')
    const chunkLines = sliceLines(sym.startLine, sym.endLine)
    const chunkText = chunkLines.join('\n')
    const hash = sha256Hex(chunkText)
    const firstLine = lines[Math.max(0, sym.startLine - 1)] ?? ''
    const signature = firstLine.trim().slice(0, MAX_SIGNATURE_LENGTH)
    return {
      chunkId: deriveChunkId(filePath, qualifiedName, sym.kind, hash),
      path: filePath,
      qualifiedName,
      kind: sym.kind,
      signature,
      startLine: sym.startLine,
      endLine: sym.endLine,
      depth: sym.depth,
      docComment: '',
      hash,
    }
  })
}
