import * as path from 'node:path'

import {
  extractImportSitesFromLines,
  hasImportSiteExtraction,
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
 * - Python: relative (`from .`) modules resolve from the importing file's
 *   directory; absolute modules resolve only when their first segment is an
 *   indexed top-level package/namespace directory — a loose same-named file
 *   never satisfies `import X` (conservative-unresolved contract).
 * - Rust: `mod`/`use` paths including `crate::`/`self::`/`super::` prefixes;
 *   the crate-root (`src/`) fallback applies only to explicit `crate::`
 *   paths, so bare imports resolve only in the importing file's directory.
 * - Go: module-path prefixes gated on the local `go.mod` module identity.
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
 * path, extension, and (for JVM/PHP declaration checks + the Go module line)
 * a content sample.
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
  const sites = extractImportSitesFromLines(lines, opts?.filePath ?? 'file', ext)
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
      // Only nested paths contribute a top-level directory; a loose top-level
      // file (e.g. `json.py`) never satisfies an absolute import.
      if (slash > 0) dirs.add(candidate.slice(0, slash))
    }
    topLevelDirsCache.set(files, dirs)
  }
  return dirs
}

/**
 * Resolve one import specifier to a project-relative file path, or `null`
 * when it is external, ambiguous, or unmatched. Conservative by design:
 * non-TS/JS bare specifiers (other than tsconfig aliases) never resolve, so
 * e.g. `import React from 'react'` cannot match a local `react.ts`.
 *
 * Snapshot contract: the conservative Python absolute-import rule derives its
 * top-level-directory set once per `files` record object identity (memoized
 * via {@link topLevelDirsFor}) and is NOT recomputed when the same record
 * object is mutated in place between calls. Callers that mutate the record
 * must pass a fresh record (or a copy) for the mutation to be reflected in
 * resolution results — a stale record silently yields stale results.
 */
export function resolveImportToFile(
  fromFilePath: string,
  fromExtension: string,
  importPath: string,
  files: Record<string, ImportResolutionFile>,
  aliases?: TsAliasMap,
  tsResolver?: TsModuleResolver | null,
): string | null {
  const normalizedImport = importPath.replace(/\\/g, '/')
  const hasFile = (candidate: string) => files[candidate] !== undefined
  let suffixSpecifier = normalizedImport
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
    const fromDir = path.posix.dirname(fromFilePath.replace(/\\/g, '/'))
    const local = resolveModuleSpecifier(
      path.posix.normalize(path.posix.join(fromDir, normalizedImport)),
      hasFile,
    )
    if (local) return local
  }
  if (['.java', '.kt', '.kts', '.cs', '.php'].includes(fromExtension)) {
    const dottedPath = normalizedImport.replace(/\./g, '/')
    suffixSpecifier = dottedPath
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
  if (fromExtension === '.rs') {
    const fromDir = path.posix.dirname(fromFilePath.replace(/\\/g, '/'))
    const isCrateRooted = normalizedImport.startsWith('crate::')
    const rustPath = normalizedImport
      .replace(/^crate::/, '')
      .replace(/^self::/, '')
      .replace(/^super::/, '../')
      .replace(/::/g, '/')
    const local = resolveModuleSpecifier(
      path.posix.normalize(path.posix.join(fromDir, rustPath)),
      hasFile,
    )
    if (local) return local
    // Crate-root fallback only for explicit `crate::` paths (audit G): a
    // bare `use config;` must not match a same-named module in some other
    // directory — only the importing file's own directory counts.
    if (isCrateRooted) {
      const crateRelative = resolveModuleSpecifier(`src/${rustPath}`, hasFile)
      if (crateRelative) return crateRelative
    }
  }
  if (['.py', '.pyi'].includes(fromExtension)) {
    const leadingDots = normalizedImport.match(/^\.+/)?.[0].length ?? 0
    const modulePath = normalizedImport.slice(leadingDots).replace(/\./g, '/')
    if (leadingDots > 0) {
      let baseDir = path.posix.dirname(fromFilePath.replace(/\\/g, '/'))
      for (let index = 1; index < leadingDots; index++)
        baseDir = path.posix.dirname(baseDir)
      const relative = resolveModuleSpecifier(
        path.posix.join(baseDir, modulePath),
        hasFile,
      )
      if (relative) return relative
    } else {
      // Conservative absolute-import rule (audit G): an absolute import
      // resolves only when its FIRST segment is an indexed top-level
      // package/namespace directory; segment resolution then continues under
      // it. A bare `import X` whose X is only a loose same-named file stays
      // unresolved ('conservative-unresolved' contract) instead of inventing
      // a graph edge.
      const firstSegment = modulePath.split('/')[0] ?? ''
      // Membership test against the per-snapshot memoized top-level directory
      // set (see topLevelDirsFor) instead of a full indexed-path scan per
      // import site.
      const hasTopLevelDir =
        firstSegment.length > 0 && topLevelDirsFor(files).has(firstSegment)
      if (hasTopLevelDir) {
        const absolute = resolveModuleSpecifier(modulePath, hasFile)
        if (absolute) return absolute
      }
    }
  }
  if (normalizedImport.startsWith('.')) {
    const fromDir = path.posix.dirname(fromFilePath.replace(/\\/g, '/'))
    const normalizedBase = path.posix.normalize(
      path.posix.join(fromDir, normalizedImport),
    )
    return resolveModuleSpecifier(normalizedBase, hasFile)
  }
  // Non-relative: try tsconfig path aliases (workspace-internal imports).
  if (aliases) {
    const aliasResolved = resolveAliasImport(normalizedImport, aliases, files)
    if (aliasResolved) return aliasResolved
  }
  // TS/JS catch-all tier (P3-T5): real `ts.resolveModuleName` resolution over
  // the indexed files map. Runs only after the cheaper relative/alias arms
  // fail, and only when the caller injected a resolver — omitted/undefined
  // keeps prior behavior byte-identical.
  if (
    tsResolver &&
    (TS_IMPORT_EXTENSIONS as readonly string[]).includes(fromExtension)
  ) {
    const resolved = tsResolver(normalizedImport, fromFilePath)
    if (resolved) return resolved
  }
  // Go module imports include a repository/module prefix. Resolve only when
  // the specifier carries the local go.mod module identity, and only via an
  // unambiguous package-directory suffix, to avoid inventing graph edges.
  if (fromExtension !== '.go') {
    return null
  }
  const goModule = files['go.mod']?.contentSample?.match(
    /^\s*module\s+([^\s]+)\s*$/m,
  )?.[1]
  if (!goModule || !normalizedImport.startsWith(`${goModule}/`)) return null
  suffixSpecifier = normalizedImport.slice(goModule.length + 1)
  const suffixMatches = Object.keys(files).filter((candidate) => {
    const withoutExtension = candidate.replace(/\.[^.\/]+$/, '')
    const packageDirectory = path.posix.dirname(withoutExtension)
    return (
      suffixSpecifier.endsWith(withoutExtension) ||
      withoutExtension.endsWith(suffixSpecifier) ||
      (fromExtension === '.go' &&
        packageDirectory !== '.' &&
        suffixSpecifier.endsWith(packageDirectory))
    )
  })
  if (suffixMatches.length === 1) return suffixMatches[0]
  return null
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
