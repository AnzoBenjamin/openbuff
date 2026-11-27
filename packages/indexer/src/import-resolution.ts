import * as path from 'node:path'

import {
  extractImportSitesFromLines,
  hasImportSiteExtraction,
  PYTHON_IMPORT_EXTENSIONS,
  resolveModuleSpecifier,
  TS_IMPORT_EXTENSIONS,
} from '@codebuff/code-map'

import type { ImportSite } from '@codebuff/code-map'

import type { TsModuleResolver } from './ts-module-resolver'

/**
 * Canonical import-specifier extraction + per-ecosystem resolution for the
 * indexer (P3-T5 / LI-08). Extraction reuses the shared line-based import
 * site helper from `@codebuff/code-map` (the leaf package that also powers
 * tree-sitter parsing); specifiers are then resolved to project-relative
 * file paths using conservative per-ecosystem rules:
 *
 * - TS/JS: relative `./`/`../` paths with extension + `/index` resolution,
 *   then tsconfig `compilerOptions.paths` aliases for non-relative specifiers.
 * - Python: exact Python modules and package initializers. Absolute names
 *   start in an indexed Python package/namespace directory, not a loose file.
 * - Rust: exact `.rs`/`mod.rs` module paths in a conventional source tree
 *   owned by the nearest Cargo package (or a standalone root-level `src`).
 * - Go: exact package directories within the caller's nearest `go.mod`.
 *   A single eligible source file represents package membership, not symbols.
 * - JVM/PHP: imports only resolve when the target file declares the matching
 *   `package`/`namespace` (no filename guessing).
 *
 * Ambiguous or external specifiers deliberately stay unresolved instead of
 * inventing graph edges (see docs/architecture.md).
 */

/** tsconfig `compilerOptions.paths` alias map: pattern -> target list. */
export type TsAliasMap = Record<string, string[]>

/**
 * Minimal shape of an indexed file used by resolution: a project-relative
 * path, extension, and a bounded content sample for declarations/manifests.
 */
export interface ImportResolutionFile {
  path: string
  ext: string
  contentSample?: string
}

/** Options accepted by {@link extractImportSpecifiers}. */
export interface ExtractImportSpecifiersOptions {
  /** Pre-split source lines; when omitted, `content` is split on \r?\n. */
  lines?: readonly string[]
  /** Virtual file path used to derive the extension when `extension` is omitted. */
  filePath?: string
  /** Max returned specifiers (default 50, matching historical index behavior). */
  maxSpecifiers?: number
}

// Captures the module specifier from: `import … from 'x'`, `export … from 'x'`
// (re-exports), `require('x')` / `import('x')` (dynamic), and `import 'x'`
// (side-effect). The {0,500} bound avoids catastrophic backtracking.
const IMPORT_REGEX =
  /(?:\b(?:import|export)\b[\s\S]{0,500}?\bfrom\s+['"]([^'"]+)['"])|(?:\b(?:require|import)\s*\(\s*['"]([^'"]+)['"])|(?:\bimport\s+['"]([^'"]+)['"])/g

const MAX_SPECIFIERS = 50

/**
 * Extract the unique, order-preserving list of raw import specifiers for a
 * source file (the persisted `IndexedFile.imports` shape). Specifiers keep
 * the exact text written in source: `crate::config::Config` for Rust,
 * `com.acme.User` for Java, `Vendor\User` for PHP, `./inner` for TS.
 *
 * Line-based site extraction is shared with `@codebuff/code-map`; the TS/JS
 * branch additionally runs the multiline-capable import regex so specifiers
 * split across lines (e.g. a multi-line named-import list) are captured.
 */
export function extractImportSpecifiers(
  content: string,
  extension: string,
  opts?: ExtractImportSpecifiersOptions,
): string[] {
  const max = opts?.maxSpecifiers ?? MAX_SPECIFIERS
  const imports = new Set<string>()
  const ext = extension.toLowerCase()
  if (!hasImportSiteExtraction(opts?.filePath ?? `file${ext}`)) return []

  const lines = opts?.lines ?? content.split(/\r?\n/)
  const sites = extractImportSitesFromLines(
    lines,
    opts?.filePath ?? 'file',
    ext,
  )
  for (const site of sites) {
    if (imports.size >= max) break
    // PHP keeps the canonical slash-normalized specifier (the historical
    // index shape); every other ecosystem indexes the raw source text.
    imports.add(ext === '.php' ? site.specifier : site.text)
  }

  if ((TS_IMPORT_EXTENSIONS as readonly string[]).includes(ext)) {
    // Multi-line `import { a,\n b } from 'x'` specifiers are invisible to the
    // per-line sites pass; pick them up here. Duplicates collapse via the Set.
    const regex = new RegExp(IMPORT_REGEX.source, 'g')
    let match: RegExpExecArray | null
    while ((match = regex.exec(content)) !== null && imports.size < max) {
      const specifier = (match[1] ?? match[2] ?? match[3])?.trim()
      if (specifier) imports.add(specifier)
    }
  }

  if (ext === '.php') {
    // require/include calls are file imports too (historical index behavior).
    const regex =
      /\b(?:require|require_once|include|include_once)\s*\(?\s*['"]([^'"]+)/g
    let match: RegExpExecArray | null
    while ((match = regex.exec(content)) !== null && imports.size < max) {
      const specifier = match[1]?.trim()
      if (specifier) imports.add(specifier)
    }
  }

  return [...imports].slice(0, max)
}

/**
 * Per-import-site extraction detail (specifier + source location + names),
 * for callers that need more than the deduped specifier list.
 */
export function extractImportSites(
  content: string,
  filePath: string,
): ImportSite[] {
  const dot = filePath.lastIndexOf('.')
  const ext = dot >= 0 ? filePath.slice(dot).toLowerCase() : ''
  return extractImportSitesFromLines(content.split(/\r?\n/), filePath, ext)
}

export function stripJsonComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
    .replace(/,(\s*[}\]])/g, '$1')
}

/**
 * Resolve a non-relative import via tsconfig `paths` aliases (e.g.
 * "@codebuff/common/util/x" -> "common/src/util/x"). Supports both wildcard
 * (`@scope/*`) and exact (`@scope/sdk`) patterns. Targets are interpreted
 * relative to the project root (baseUrl="." in this repo).
 */
export function resolveAliasImport(
  importPath: string,
  aliases: TsAliasMap,
  files: Record<string, ImportResolutionFile>,
): string | null {
  const hasFile = (candidate: string) => files[candidate] !== undefined
  for (const [pattern, targets] of Object.entries(aliases)) {
    const starIndex = pattern.indexOf('*')
    if (starIndex >= 0) {
      const prefix = pattern.slice(0, starIndex)
      const suffix = pattern.slice(starIndex + 1)
      if (
        importPath.startsWith(prefix) &&
        importPath.endsWith(suffix) &&
        importPath.length >= prefix.length + suffix.length
      ) {
        const middle = importPath.slice(
          prefix.length,
          importPath.length - suffix.length,
        )
        for (const target of targets) {
          const base = target.replace('*', middle)
          const resolved = resolveModuleSpecifier(base, hasFile)
          if (resolved) return resolved
        }
      }
    } else if (importPath === pattern) {
      for (const target of targets) {
        const resolved = resolveModuleSpecifier(target, hasFile)
        if (resolved) return resolved
      }
    }
  }
  return null
}

/**
 * Perf guard: the conservative Python absolute-import rule checks whether an
 * import's first segment is an indexed top-level directory. Deriving that set
 * scans every indexed path, so it is memoized per `files` snapshot (the
 * indexer reuses one record for a whole build pass) instead of rescanning all
 * paths for every absolute import site — O(imports x files) becomes O(files)
 * once per snapshot.
 */
const topLevelDirsCache = new WeakMap<
  Record<string, ImportResolutionFile>,
  Set<string>
>()

function topLevelDirsFor(
  files: Record<string, ImportResolutionFile>,
): Set<string> {
  let dirs = topLevelDirsCache.get(files)
  if (!dirs) {
    dirs = new Set()
    for (const candidate of Object.keys(files)) {
      const slash = candidate.indexOf('/')
      // Only Python sources contribute package/namespace evidence.
      const ext = files[candidate]?.ext
      if (slash > 0 && ext && pythonExtensions.has(ext))
        dirs.add(candidate.slice(0, slash))
    }
    topLevelDirsCache.set(files, dirs)
  }
  return dirs
}

const pythonExtensions = new Set<string>(PYTHON_IMPORT_EXTENSIONS)
const tsExtensions = new Set<string>(TS_IMPORT_EXTENSIONS)
const identifier = /^[_\p{ID_Start}][_\p{ID_Continue}]*$/u

function uniquePath(candidates: string[]): string | null {
  return candidates.length === 1 ? candidates[0]! : null
}

function resolvePythonImport(
  fromPath: string,
  specifier: string,
  files: Record<string, ImportResolutionFile>,
): string | null {
  const depth = specifier.match(/^\.+/)?.[0].length ?? 0
  const module = specifier.slice(depth)
  const segments = module ? module.split('.') : []
  if (segments.some((part) => !identifier.test(part))) return null

  let dir = path.posix.dirname(fromPath)
  if (depth > 0) {
    for (let level = 1; level < depth && dir !== '.'; level++)
      dir = path.posix.dirname(dir)
    // `from ..` may not climb out of the known package into the index root.
    if (dir === '.') return null
  } else {
    if (!segments[0] || !topLevelDirsFor(files).has(segments[0])) return null
    dir = '.'
  }
  const base = path.posix.join(dir, ...segments)
  const candidates = [`${base}/__init__.py`, `${base}/__init__.pyi`]
  if (segments.length > 0 && (depth > 0 || segments.length > 1))
    candidates.push(`${base}.py`, `${base}.pyi`)
  return uniquePath(
    candidates.filter((candidate) =>
      pythonExtensions.has(files[candidate]?.ext ?? ''),
    ),
  )
}

function nearestManifest(
  dir: string,
  name: string,
  files: Record<string, ImportResolutionFile>,
): string | null {
  while (true) {
    const candidate = path.posix.join(dir, name)
    if (files[candidate]) return candidate
    if (dir === '.') return null
    dir = path.posix.dirname(dir)
  }
}

function isWithin(dir: string, target: string): boolean {
  return dir === '.' || target === dir || target.startsWith(`${dir}/`)
}

function resolveRustImport(
  fromPath: string,
  specifier: string,
  files: Record<string, ImportResolutionFile>,
): string | null {
  const parts = specifier.split('::')
  const prefix = parts[0]
  const scoped = prefix === 'crate' || prefix === 'self' || prefix === 'super'
  if (scoped && parts.at(-1) === '*') parts.pop()
  if (!parts.every((part) => identifier.test(part))) return null
  // A multi-segment bare `use` can name a dependency; no local basis.
  if (!scoped && parts.length !== 1) return null

  const fromDir = path.posix.dirname(fromPath)
  const manifest = nearestManifest(fromDir, 'Cargo.toml', files)
  const sample = manifest && files[manifest]?.contentSample
  // Support conventional lib/main targets, not workspace-only or custom
  // target layouts. An unsupported nearest manifest blocks any outer crate.
  if (
    manifest &&
    (!sample ||
      !/^\s*\[\s*package\s*\]\s*(?:#.*)?$/m.test(sample) ||
      /…\[truncated\]$|^\s*\[(?:\s*lib\s*\]|\[\s*bin\s*\])|^\s*autolib\s*=/m.test(
        sample,
      ))
  )
    return null
  const src = manifest
    ? path.posix.join(path.posix.dirname(manifest), 'src')
    : 'src'
  if (!isWithin(src, fromDir) || isWithin(`${src}/bin`, fromDir)) return null

  const roots = [`${src}/lib.rs`, `${src}/main.rs`].filter(
    (candidate) => files[candidate]?.ext === '.rs',
  )
  const crateRoot = roots.includes(fromPath) ? fromPath : uniquePath(roots)
  if (!crateRoot) return null
  let base = fromDir
  if (fromPath !== crateRoot && path.posix.basename(fromPath) !== 'mod.rs')
    base = path.posix.join(fromDir, path.posix.basename(fromPath, '.rs'))

  if (prefix === 'crate') {
    base = src
    parts.shift()
  } else if (prefix === 'self') {
    parts.shift()
  } else {
    while (parts[0] === 'super') {
      if (base === src) return null
      base = path.posix.dirname(base)
      parts.shift()
    }
  }
  if (parts.length === 0) return null

  const moduleCandidates = (segments: string[]) => {
    const target = path.posix.join(base, ...segments)
    return [`${target}.rs`, `${target}/mod.rs`].filter(
      (candidate) =>
        files[candidate]?.ext === '.rs' &&
        nearestManifest(path.posix.dirname(candidate), 'Cargo.toml', files) ===
          manifest,
    )
  }
  const exact = moduleCandidates(parts)
  if (exact.length > 0) return uniquePath(exact)
  // Only the final segment may be an item, not an arbitrary longer suffix.
  // This is a module reference, not proof that the item exists.
  if (scoped && parts.length > 1 && !specifier.endsWith('::*'))
    return uniquePath(moduleCandidates(parts.slice(0, -1)))
  return null
}

const goFilesByDirectory = new WeakMap<
  Record<string, ImportResolutionFile>,
  Map<string, string[]>
>()

function isGoSourceFile(file: ImportResolutionFile): boolean {
  return file.ext === '.go' && !/(?:^|\/)[._]|_test\.go$/.test(file.path)
}

/** Shared declaration basis for Go resolution and incremental invalidation. */
export function hasImportableGoPackageDeclaration(
  file: ImportResolutionFile | undefined,
): boolean {
  if (!file || !isGoSourceFile(file)) return false
  // A package declaration precedes other tokens; `main` cannot be imported.
  const name = file.contentSample?.match(
    /^(?:\s|\/\/[^\n]*|\/\*[\s\S]*?\*\/)*package[ \t]+([\w]+)[ \t]*(?:[;\r\n]|\/\/|$)/,
  )?.[1]
  return Boolean(name && name !== 'main')
}

function goSourcesFor(
  dir: string,
  files: Record<string, ImportResolutionFile>,
): string[] {
  let directories = goFilesByDirectory.get(files)
  if (!directories) {
    directories = new Map()
    for (const file of Object.values(files)) {
      if (!isGoSourceFile(file)) continue
      const parent = path.posix.dirname(file.path)
      const sources = directories.get(parent) ?? []
      sources.push(file.path)
      directories.set(parent, sources)
    }
    goFilesByDirectory.set(files, directories)
  }
  return directories.get(dir) ?? []
}

const goPathSegment = /^[A-Za-z0-9._~-]+$/

function resolveGoImport(
  fromPath: string,
  specifier: string,
  files: Record<string, ImportResolutionFile>,
): string | null {
  const fromDir = path.posix.dirname(fromPath)
  const manifest = nearestManifest(fromDir, 'go.mod', files)
  if (!manifest) return null
  const directives = files[manifest]?.contentSample
    ?.split(/\r?\n/)
    .filter((line) => /^[ \t]*module(?:[ \t]|$)/.test(line))
  if (directives?.length !== 1) return null
  const directive = directives[0]!.match(
    /^[ \t]*module[ \t]+(?:"([^"\s]+)"|([^"\s]+))[ \t]*(?:\/\/.*)?$/,
  )
  const modulePath = directive?.[1] ?? directive?.[2]
  if (
    !modulePath ||
    (specifier !== modulePath && !specifier.startsWith(`${modulePath}/`))
  )
    return null
  if (
    specifier
      .split('/')
      .some(
        (part) => !goPathSegment.test(part) || part === '.' || part === '..',
      )
  )
    return null

  const root = path.posix.dirname(manifest)
  const packageDir = path.posix.join(
    root,
    specifier.slice(modulePath.length + 1),
  )
  if (
    fromDir === packageDir ||
    nearestManifest(packageDir, 'go.mod', files) !== manifest
  )
    return null
  const source = uniquePath(goSourcesFor(packageDir, files))
  return source && hasImportableGoPackageDeclaration(files[source])
    ? source
    : null
}

/**
 * Resolve one import specifier to a project-relative file path, or `null`
 * when it is external, ambiguous, or not supported by the indexed basis.
 *
 * Snapshot contract: the directory lookups for Python and Go are memoized per
 * `files` record object identity. Pass a fresh record when any files change.
 */
export function resolveImportToFile(
  fromFilePath: string,
  fromExtension: string,
  importPath: string,
  files: Record<string, ImportResolutionFile>,
  aliases?: TsAliasMap,
  tsResolver?: TsModuleResolver | null,
): string | null {
  const fromPath = fromFilePath.replace(/\\/g, '/')
  // These ecosystems must never fall through to another language's resolver.
  if (pythonExtensions.has(fromExtension))
    return resolvePythonImport(fromPath, importPath, files)
  if (fromExtension === '.rs')
    return resolveRustImport(fromPath, importPath, files)
  if (fromExtension === '.go')
    return resolveGoImport(fromPath, importPath, files)

  const normalizedImport = importPath.replace(/\\/g, '/')
  const hasFile = (candidate: string) => files[candidate] !== undefined
  if (fromExtension === '.gd') {
    return resolveModuleSpecifier(
      normalizedImport.replace(/^res:\/\//, ''),
      hasFile,
    )
  }
  if (
    ['.c', '.cc', '.cpp', '.cxx', '.h', '.hh', '.hpp', '.hxx', '.rb'].includes(
      fromExtension,
    )
  ) {
    const fromDir = path.posix.dirname(fromPath)
    const local = resolveModuleSpecifier(
      path.posix.normalize(path.posix.join(fromDir, normalizedImport)),
      hasFile,
    )
    if (local) return local
  }
  if (['.java', '.kt', '.kts', '.cs', '.php'].includes(fromExtension)) {
    const dottedPath = normalizedImport.replace(/\./g, '/')
    if (['.java', '.kt', '.kts', '.php'].includes(fromExtension)) {
      const declared = resolveDeclaredPackageImport(
        dottedPath,
        fromExtension,
        files,
      )
      if (declared) return declared
    } else {
      const exact = resolveModuleSpecifier(dottedPath, hasFile)
      if (exact) return exact
    }
  }
  if (normalizedImport.startsWith('.')) {
    const fromDir = path.posix.dirname(fromPath)
    const normalizedBase = path.posix.normalize(
      path.posix.join(fromDir, normalizedImport),
    )
    return resolveModuleSpecifier(normalizedBase, hasFile)
  }
  if (!tsExtensions.has(fromExtension)) return null
  // TS/JS only: try tsconfig aliases, then the injected compiler resolver.
  return (
    (aliases && resolveAliasImport(normalizedImport, aliases, files)) ||
    tsResolver?.(normalizedImport, fromPath) ||
    null
  )
}

/**
 * JVM/PHP resolution requires the target file to declare the imported
 * package/namespace identity; a filename match alone is never enough.
 */
export function resolveDeclaredPackageImport(
  importPath: string,
  fromExtension: string,
  files: Record<string, ImportResolutionFile>,
): string | null {
  const segments = importPath.split('/').filter(Boolean)
  if (segments.length < 2) return null
  const symbolName = segments.at(-1)!
  const packageName = segments
    .slice(0, -1)
    .join(fromExtension === '.php' ? '\\' : '.')
  const allowedExtensions =
    fromExtension === '.php' ? new Set(['.php']) : new Set(['.java', '.kt'])
  const matches = Object.values(files).filter((candidate) => {
    if (!allowedExtensions.has(candidate.ext)) return false
    if (path.posix.basename(candidate.path, candidate.ext) !== symbolName) {
      return false
    }
    const sample = candidate.contentSample ?? ''
    if (fromExtension === '.php') {
      return new RegExp(
        `^\\s*namespace\\s+${escapeRegex(packageName)}\\s*;`,
        'm',
      ).test(sample)
    }
    return new RegExp(
      `^\\s*package\\s+${escapeRegex(packageName)}\\s*;?`,
      'm',
    ).test(sample)
  })
  return matches.length === 1 ? matches[0].path : null
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
