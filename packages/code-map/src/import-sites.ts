/**
 * Canonical line-based import/include/use-site extraction, shared by the
 * per-chunk import refs (chunks.ts) and the project import graph
 * (@codebuff/indexer import-resolution.ts).
 *
 * Lives in code-map (the leaf package) because the dependency direction is
 * indexer -> code-map; both consumers call this single implementation.
 *
 * Note: chunk extraction runs per line (bounded work, no cross-line regex
 * backtracking) and never re-parses — tree-sitter already parsed the file
 * for structure/call sites. Block forms (e.g. Go `import ( ... )`) are
 * handled by matching each spec line inside the block.
 *
 * P3-T5 AST import-capture tier: the shared tree-sitter tags queries (the
 * same .scm files the parse pipeline consumes) additionally emit
 * `@import.specifier` / `@import.call` captures for five languages
 * (TypeScript, JavaScript, Python, Go, Rust);
 * {@link importSpecifiersFromAstCaptures} maps those captures into the exact
 * specifier shapes this line-based extractor emits, and the indexer prefers
 * the AST tier when captures are present, falling back here byte-identically
 * otherwise. This extractor remains the canonical fallback and is unchanged.
 */

export const TS_IMPORT_EXTENSIONS = [
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
] as const

export const PYTHON_IMPORT_EXTENSIONS = ['.py', '.pyi'] as const

export const JVM_IMPORT_EXTENSIONS = ['.java', '.kt', '.kts'] as const

export const C_FAMILY_IMPORT_EXTENSIONS = [
  '.c',
  '.cc',
  '.cpp',
  '.cxx',
  '.h',
  '.hh',
  '.hpp',
  '.hxx',
] as const

/** One import/include/use occurrence in a source file. */
export interface ImportSite {
  /**
   * Canonical specifier shape: path-style (`/` separators) for the JVM/PHP
   * ecosystems (used by per-chunk name matching), raw source text otherwise
   * (e.g. `crate::config::Config`, `com.acme.User`).
   */
  specifier: string
  /** Specifier exactly as written in source (e.g. dotted JVM package path). */
  text: string
  /** 1-indexed source line of the import. */
  line: number
  /** 1-indexed column of the specifier text. */
  col: number
  /** Named bindings pulled in by the import (capped), when syntactically known. */
  names?: string[]
}

const MAX_IMPORT_SITES = 100
const MAX_IMPORT_NAMES = 25
const MAX_SPECIFIER_LENGTH = 512

function extensionOf(filePath: string): string {
  const dot = filePath.lastIndexOf('.')
  return dot >= 0 ? filePath.slice(dot).toLowerCase() : ''
}

export function hasImportSiteExtraction(filePath: string): boolean {
  const ext = extensionOf(filePath)
  return (
    (TS_IMPORT_EXTENSIONS as readonly string[]).includes(ext) ||
    (PYTHON_IMPORT_EXTENSIONS as readonly string[]).includes(ext) ||
    ext === '.rs' ||
    ext === '.go' ||
    (JVM_IMPORT_EXTENSIONS as readonly string[]).includes(ext) ||
    (C_FAMILY_IMPORT_EXTENSIONS as readonly string[]).includes(ext) ||
    ext === '.cs' ||
    ext === '.rb' ||
    ext === '.php' ||
    ext === '.swift' ||
    ext === '.gd'
  )
}

/**
 * Extract import sites from already-split source lines.
 *
 * `ext` defaults to `filePath`'s extension; callers that split by extension
 * family (e.g. the indexer) pass it explicitly to skip the path handling.
 */
export function extractImportSitesFromLines(
  lines: readonly string[],
  filePath: string,
  ext: string = extensionOf(filePath),
): ImportSite[] {
  const sites: ImportSite[] = []
  const push = (
    specifier: string,
    line: number,
    col: number,
    text: string = specifier,
    names?: string[],
  ): void => {
    const spec = specifier.trim()
    const raw = text.trim()
    if (!spec || spec.length > MAX_SPECIFIER_LENGTH) return
    sites.push({
      specifier: spec,
      text: raw || spec,
      line,
      col,
      ...(names && names.length > 0
        ? { names: names.slice(0, MAX_IMPORT_NAMES) }
        : {}),
    })
  }
  // For Go, the `import (` opener line is matched first and stripped so the
  // quoted-spec matcher below never scans the rest of that line: only quoted
  // paths inside real import declarations are captured, not lookalike strings.
  let inGoImportBlock = false
  lines.forEach((rawLine, idx) => {
    const lineNo = idx + 1
    const line = rawLine
    if ((TS_IMPORT_EXTENSIONS as readonly string[]).includes(ext)) {
      const fromMatch = line.match(
        /\b(?:import|export)\b[^'"]*\bfrom\s+['"]([^'"]+)['"]/,
      )
      if (fromMatch?.[1]) {
        const brace = line.match(/\{([^}]*)\}/)
        const names = brace?.[1]
          ? brace[1]
              .split(',')
              .map((s) => s.trim().split(/\s+/).pop()!)
              .filter(Boolean)
          : undefined
        push(
          fromMatch[1],
          lineNo,
          line.indexOf(fromMatch[1]) + 1 || 1,
          undefined,
          names,
        )
        return
      }
      const sideMatch = line.match(/^\s*import\s+['"]([^'"]+)['"]/)
      if (sideMatch?.[1]) {
        push(sideMatch[1], lineNo, line.indexOf(sideMatch[1]) + 1 || 1)
        return
      }
      const reqMatch = line.match(
        /\b(?:require|import)\s*\(\s*['"]([^'"]+)['"]\s*\)/,
      )
      if (reqMatch?.[1]) {
        push(reqMatch[1], lineNo, line.indexOf(reqMatch[1]) + 1 || 1)
        return
      }
      return
    }
    if ((PYTHON_IMPORT_EXTENSIONS as readonly string[]).includes(ext)) {
      const fromMatch = line.match(/^\s*from\s+([.\w]+)\s+import\s+(.+)$/)
      if (fromMatch) {
        const names = (fromMatch[2] ?? '')
          .split(',')
          .map((s) => s.trim().split(/\s+/)[0]!)
          .filter(Boolean)
        push(
          fromMatch[1],
          lineNo,
          line.indexOf(fromMatch[1]) + 1 || 1,
          undefined,
          names,
        )
        return
      }
      const impMatch = line.match(/^\s*import\s+([\w.]+)/)
      if (impMatch?.[1]) {
        push(
          impMatch[1],
          lineNo,
          line.indexOf(impMatch[1]) + 1 || 1,
          undefined,
          [impMatch[1].split('.').pop()!],
        )
        return
      }
      return
    }
    if (ext === '.rs') {
      const m = line.match(/^\s*(?:pub\s+)?(?:use|mod)\s+([\w:]+)/)
      if (m?.[1]) {
        push(
          m[1].replace(/::/g, '/'),
          lineNo,
          line.indexOf(m[1]) + 1 || 1,
          m[1],
        )
      }
      return
    }
    if (ext === '.go') {
      if (inGoImportBlock) {
        // Close only on a bare `)` line (optionally with a trailing comment):
        // any line that merely CONTAINS ')' — a quoted path or comment with a
        // paren — must not terminate the block.
        if (/^\s*\)\s*(?:\/\/.*)?$/.test(line)) {
          inGoImportBlock = false
          return
        }
      } else if (/^\s*import\s*\(\s*(?:\/\/.*)?$/.test(line)) {
        inGoImportBlock = true
        return
      } else {
        const single = line.match(/^\s*import\s+(?:[\w.]+\s+)?["`]([^"`]+)["`]/)
        if (single?.[1]) {
          push(single[1], lineNo, line.indexOf(single[1]) + 1 || 1)
        }
        return
      }
      const spec = line.match(/^\s*(?:[\w.]+\s+)?["`]([^"`]+)["`]\s*(?:\/\/.*)?$/)
      if (spec?.[1]) {
        push(spec[1], lineNo, line.indexOf(spec[1]) + 1 || 1)
      }
      return
    }
    if ((JVM_IMPORT_EXTENSIONS as readonly string[]).includes(ext)) {
      const m = line.match(/^\s*import\s+(?:static\s+)?([\w.]+)/)
      if (m?.[1]) {
        push(
          m[1].replace(/\./g, '/'),
          lineNo,
          line.indexOf(m[1]) + 1 || 1,
          m[1],
        )
      }
      return
    }
    if ((C_FAMILY_IMPORT_EXTENSIONS as readonly string[]).includes(ext)) {
      const m = line.match(/^\s*#\s*include\s*[<"]([^>"]+)[>"]/)
      if (m?.[1]) push(m[1], lineNo, line.indexOf(m[1]) + 1 || 1)
      return
    }
    if (ext === '.cs') {
      const m = line.match(
        /^\s*(?:global\s+)?using\s+(?:[\w]+\s*=\s*)?([\w.]+)\s*;/,
      )
      if (m?.[1]) {
        push(
          m[1].replace(/\./g, '/'),
          lineNo,
          line.indexOf(m[1]) + 1 || 1,
          m[1],
        )
      }
      return
    }
    if (ext === '.rb') {
      const m = line.match(/^\s*require(?:_relative)?\s*[('" ]+([^'"\s)]+)/)
      if (m?.[1]) push(m[1], lineNo, line.indexOf(m[1]) + 1 || 1)
      return
    }
    if (ext === '.php') {
      const m = line.match(/^\s*use\s+([\w\\]+)/)
      if (m?.[1]) {
        push(
          m[1].replace(/\\/g, '/'),
          lineNo,
          line.indexOf(m[1]) + 1 || 1,
          m[1],
        )
      }
      return
    }
    if (ext === '.swift') {
      const m = line.match(/^\s*import\s+(?:\w+\s+)?([\w.]+)/)
      if (m?.[1]) push(m[1], lineNo, line.indexOf(m[1]) + 1 || 1)
      return
    }
    if (ext === '.gd') {
      const m = line.match(
        /\b(?:preload|load)\s*\(\s*["'](?:res:\/\/)?([^"']+)/,
      )
      if (m?.[1]) push(m[1], lineNo, line.indexOf(m[1]) + 1 || 1)
      return
    }
  })
  return sites.slice(0, MAX_IMPORT_SITES)
}

/** Split content into lines and extract import sites (convenience wrapper). */
export function extractImportSites(
  content: string,
  filePath: string,
): ImportSite[] {
  return extractImportSitesFromLines(content.split(/\r?\n/), filePath)
}

/** Strip the surrounding quote characters from a captured string literal. */
function unquoteImportLiteral(text: string): string {
  const trimmed = text.trim()
  const quote = trimmed.charAt(0)
  if (
    trimmed.length >= 2 &&
    (quote === '"' || quote === "'" || quote === '`') &&
    trimmed.endsWith(quote)
  ) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

/**
 * Extensions whose tags queries emit @import.* captures this wave (P3-T5):
 * the TypeScript/JavaScript/Python/Go/Rust tier. Every other language yields
 * [] from {@link importSpecifiersFromAstCaptures} so its indexed imports stay
 * byte-identical to the line-based fallback.
 */
const AST_IMPORT_CAPTURE_LANGUAGES = new Set<string>([
  ...(TS_IMPORT_EXTENSIONS as readonly string[]),
  ...(PYTHON_IMPORT_EXTENSIONS as readonly string[]),
  '.go',
  '.rs',
])

/**
 * Reduce a Rust `use` declaration argument capture to its leading
 * ::-separated path: `crate::config::Config` stays whole, brace lists
 * (`crate::mod::{a, b}`) trim to the path prefix, glob imports keep their
 * `*` suffix, and `use x as y` trims at the alias. Returns null for anything
 * that is not path-shaped.
 */
function rustUseTreePath(capture: string): string | null {
  let usePath = capture.trim()
  const asIndex = usePath.search(/\s+as\s+/)
  if (asIndex > 0) usePath = usePath.slice(0, asIndex)
  const brace = usePath.indexOf('{')
  if (brace > 0) usePath = usePath.slice(0, brace).replace(/:+$/, '')
  usePath = usePath.replace(/\s+/g, '').replace(/;+$/, '')
  return /^[\w:]*\*?$/.test(usePath) && usePath !== '' ? usePath : null
}

/**
 * P3-T5 AST import-capture tier: normalize import specifiers captured by the
 * tags queries' `@import.specifier` / `@import.call` captures into the exact
 * shapes the line-based extractor emits, so AST captures can replace line
 * output without any downstream resolution change:
 *
 * - TS/JS: raw source text of the quoted module string, without quotes
 *   (`./b`, `node:fs`). require()/import() arguments are kept only when the
 *   captured call text starts with `require(` / `import(` — the query
 *   captures the whole call expression so no query predicates are needed,
 *   and any other string-argument call contributes nothing.
 * - Python: the dotted module path exactly as written (`os.path`, `.utils`,
 *   `.` for a bare relative from-import).
 * - Go: the import path literal without quotes (single and block forms).
 * - Rust: the leading ::-separated path of the use declaration argument.
 *
 * Returns [] when there are no captures — or when the file's language is
 * outside the five-language tier — the caller's signal to fall back to the
 * line-based extractor. Reuses MAX_SPECIFIER_LENGTH; the result is capped at
 * MAX_AST_IMPORT_SPECIFIERS like the line extractor's capping.
 */
export function importSpecifiersFromAstCaptures(
  specifierCaptures: readonly string[],
  callCaptures: readonly string[],
  filePath: string,
): string[] {
  const ext = extensionOf(filePath)
  if (!AST_IMPORT_CAPTURE_LANGUAGES.has(ext)) return []
  const specifiers = new Set<string>()
  const add = (specifier: string | null): void => {
    if (!specifier || specifier.length > MAX_SPECIFIER_LENGTH) return
    if (specifiers.size >= MAX_AST_IMPORT_SPECIFIERS) return
    specifiers.add(specifier)
  }

  if (ext === '.rs') {
    for (const capture of specifierCaptures) add(rustUseTreePath(capture))
  } else {
    // Python relative_import node text can carry the `from` keyword depending
    // on grammar version; strip it so the shape matches the line extractor.
    const isPython = (PYTHON_IMPORT_EXTENSIONS as readonly string[]).includes(
      ext,
    )
    for (const capture of specifierCaptures) {
      const cleaned = isPython
        ? capture.replace(/^from\s+/i, '')
        : capture
      add(unquoteImportLiteral(cleaned))
    }
  }

  if ((TS_IMPORT_EXTENSIONS as readonly string[]).includes(ext)) {
    for (const call of callCaptures) {
      const match = call.match(/^\s*(?:require|import)\s*\(\s*(['"])([^'"]+)\1/)
      if (match?.[2]) add(match[2])
    }
  }

  return [...specifiers]
}

const MAX_AST_IMPORT_SPECIFIERS = 100
/** Exported so the indexer can cap the AST tier with the same bound. */
export { MAX_AST_IMPORT_SPECIFIERS as AST_IMPORT_SPECIFIER_LIMIT }

/**
 * Resolve a module specifier to a project-relative file path using the
 * extension/index conventions shared by every supported ecosystem
 * (`base`, `base.<ext>`, `base/index.<ext>`, plus Python `__init__.py` and
 * Rust `mod.rs`). `hasFile` decides which candidate paths exist, so callers
 * stay free of any particular index shape.
 */
export function resolveModuleSpecifier(
  base: string,
  hasFile: (candidate: string) => boolean,
): string | null {
  const normalized = base.replace(/^\.\//, '')
  const sourceExtensions = [
    '.ts',
    '.tsx',
    '.js',
    '.jsx',
    '.mts',
    '.cts',
    '.mjs',
    '.cjs',
    '.py',
    '.pyi',
    '.rs',
    '.go',
    '.java',
    '.kt',
    '.kts',
    '.cs',
    '.c',
    '.cc',
    '.cpp',
    '.cxx',
    '.h',
    '.hh',
    '.hpp',
    '.hxx',
    '.rb',
    '.php',
    '.swift',
    '.gd',
  ]
  const candidates = [
    normalized,
    ...sourceExtensions.map((extension) => `${normalized}${extension}`),
    ...sourceExtensions.map((extension) => `${normalized}/index${extension}`),
    `${normalized}/__init__.py`,
    `${normalized}/mod.rs`,
  ]
  return candidates.find((candidate) => hasFile(candidate)) ?? null
}
