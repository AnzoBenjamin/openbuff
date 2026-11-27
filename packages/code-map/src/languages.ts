import * as fs from 'fs'
import * as path from 'path'
import { createHash } from 'node:crypto'

// Import some types for wasm & .scm files
import './types'

import { Language, Parser, Query } from 'web-tree-sitter'

import { initTreeSitterForNode } from './init-node'
import { repairGrammarWasm } from './grammar-wasm-repair'
import { DEBUG_PARSING } from './parse'

import { getDirnameDynamically } from './utils'
import { WASM_FILES } from './wasm-files'

export { WASM_FILES } from './wasm-files'

/* ------------------------------------------------------------------ */
/* 2. Types and interfaces                                           */
/* ------------------------------------------------------------------ */
export interface LanguageConfig {
  extensions: string[]
  wasmFile: string
  queryPathOrContent: string

  /* Loaded lazily ↓ */
  parser?: Parser
  query?: Query
  language?: Language
  /** Identity of the grammar and query bytes actually loaded into this config. */
  extractionIdentity?: string
}

export interface RuntimeLanguageLoader {
  loadLanguage(wasmFile: string): Promise<Language>
  initParser(): Promise<void>
  getLoadedLanguageFingerprint?(wasmFile: string): string | undefined
}

/* ------------------------------------------------------------------ */
/* 3. WASM file manifest                                             */
/* ------------------------------------------------------------------ */
/* ------------------------------------------------------------------ */
/* 4. Language table                                                 */
/* ------------------------------------------------------------------ */

/**
 * Tag-query file names per language. These are bare file names resolved to
 * absolute paths at query-load time by `resolveQueryPath` (called from
 * `createLanguageConfig`) — never imported at module-load time, so loading
 * this module requires no bundler `.scm` import plugin and performs no fs
 * reads.
 */
const QUERY_FILES = {
  typescript: 'tree-sitter-typescript-tags.scm',
  javascript: 'tree-sitter-javascript-tags.scm',
  python: 'tree-sitter-python-tags.scm',
  java: 'tree-sitter-java-tags.scm',
  csharp: 'tree-sitter-c_sharp-tags.scm',
  c: 'tree-sitter-c-tags.scm',
  cpp: 'tree-sitter-cpp-tags.scm',
  rust: 'tree-sitter-rust-tags.scm',
  ruby: 'tree-sitter-ruby-tags.scm',
  go: 'tree-sitter-go-tags.scm',
  php: 'tree-sitter-php-tags.scm',
  swift: 'tree-sitter-swift-tags.scm',
  kotlin: 'tree-sitter-kotlin-tags.scm',
  gdscript: 'tree-sitter-gdscript-tags.scm',
} as const

export const languageTable: LanguageConfig[] = [
  {
    extensions: ['.ts', '.mts', '.cts'],
    wasmFile: WASM_FILES['tree-sitter-typescript.wasm'],
    queryPathOrContent: QUERY_FILES.typescript,
  },
  {
    extensions: ['.tsx'],
    wasmFile: WASM_FILES['tree-sitter-tsx.wasm'],
    queryPathOrContent: QUERY_FILES.typescript,
  },
  {
    extensions: ['.js', '.jsx', '.mjs', '.cjs'],
    wasmFile: WASM_FILES['tree-sitter-javascript.wasm'],
    queryPathOrContent: QUERY_FILES.javascript,
  },
  {
    extensions: ['.py', '.pyi'],
    wasmFile: WASM_FILES['tree-sitter-python.wasm'],
    queryPathOrContent: QUERY_FILES.python,
  },
  {
    extensions: ['.java'],
    wasmFile: WASM_FILES['tree-sitter-java.wasm'],
    queryPathOrContent: QUERY_FILES.java,
  },
  {
    extensions: ['.cs'],
    wasmFile: WASM_FILES['tree-sitter-c-sharp.wasm'],
    queryPathOrContent: QUERY_FILES.csharp,
  },
  {
    extensions: ['.c', '.h'],
    wasmFile: WASM_FILES['tree-sitter-c.wasm'],
    queryPathOrContent: QUERY_FILES.c,
  },
  {
    extensions: ['.cc', '.cpp', '.cxx', '.hh', '.hpp', '.hxx'],
    wasmFile: WASM_FILES['tree-sitter-cpp.wasm'],
    queryPathOrContent: QUERY_FILES.cpp,
  },
  {
    extensions: ['.rs'],
    wasmFile: WASM_FILES['tree-sitter-rust.wasm'],
    queryPathOrContent: QUERY_FILES.rust,
  },
  {
    extensions: ['.rb'],
    wasmFile: WASM_FILES['tree-sitter-ruby.wasm'],
    queryPathOrContent: QUERY_FILES.ruby,
  },
  {
    extensions: ['.go'],
    wasmFile: WASM_FILES['tree-sitter-go.wasm'],
    queryPathOrContent: QUERY_FILES.go,
  },
  {
    extensions: ['.php'],
    wasmFile: WASM_FILES['tree-sitter-php.wasm'],
    queryPathOrContent: QUERY_FILES.php,
  },
  {
    extensions: ['.swift'],
    wasmFile: WASM_FILES['tree-sitter-swift.wasm'],
    queryPathOrContent: QUERY_FILES.swift,
  },
  {
    extensions: ['.kt', '.kts'],
    wasmFile: WASM_FILES['tree-sitter-kotlin.wasm'],
    queryPathOrContent: QUERY_FILES.kotlin,
  },
  {
    extensions: ['.gd'],
    wasmFile: WASM_FILES['tree-sitter-gdscript.wasm'],
    queryPathOrContent: QUERY_FILES.gdscript,
  },
]

export const SUPPORTED_CODE_EXTENSIONS = Object.freeze(
  languageTable.flatMap((config) =>
    config.extensions.map((ext) => ext.toLowerCase()),
  ),
)

/* ------------------------------------------------------------------ */
/* 5. WASM directory management                                      */
/* ------------------------------------------------------------------ */
let customWasmDir: string | undefined

/**
 * Set a custom WASM directory for loading tree-sitter WASM files.
 * This can be useful for custom packaging or deployment scenarios.
 *
 * Public-API compatibility: the directory is stored VERBATIM (an empty
 * string clears it), exactly as the original contract promised. Relative
 * directories remain valid and are resolved against the process cwd at
 * grammar-load time by `resolveWasmPath`. The strict absolute/no-traversal
 * validation is deliberately applied only to the untrusted
 * `CODEBUFF_WASM_DIR` environment override, which callers cannot pass
 * through this typed API — never silently to a caller-supplied argument,
 * which would drop the caller's directory back to the default location
 * with no error or returned status.
 */
export function setWasmDir(dir: string): void {
  customWasmDir = dir || undefined
}

export function getWasmDir(): string | undefined {
  return customWasmDir
}

const extractionAssetDigests = new Map<
  string,
  { stamp: string; digest: string }
>()
const MAX_EXTRACTION_ASSET_DIGESTS = 128
const loadedWasmAssets = new Map<
  string,
  { candidates: string; digest: string }
>()
const loadedConfigAssets = new WeakMap<
  LanguageConfig,
  { parser: Parser; wasm: string; query: string }
>()
const configLoads = new WeakMap<LanguageConfig, Promise<void>>()
/** Bump when parse-summary extraction semantics change. */
export const PARSE_EXTRACTION_VERSION = '3'

/** Content and grammar/query identity for immutable per-source parse objects. */
export function getParserExtractionFingerprint(filePath: string): string {
  const extension = path.extname(filePath).toLowerCase()
  const config = languageTable.find((entry) =>
    entry.extensions.includes(extension),
  )
  return extractionFingerprint(
    extension,
    config
      ? extractionIdentity(
          getWasmAssetIdentity(config.wasmFile),
          getQueryAssetIdentity(config),
        )
      : 'unsupported',
  )
}

/** Capture this before asynchronous source reads so later asset changes cannot relabel a parse. */
export function getLoadedParserExtractionFingerprint(
  filePath: string,
  config: LanguageConfig,
): string {
  return extractionFingerprint(
    path.extname(filePath).toLowerCase(),
    config.extractionIdentity ??
      extractionIdentity(
        getWasmAssetIdentity(config.wasmFile),
        getQueryAssetIdentity(config),
      ),
  )
}

function extractionFingerprint(extension: string, identity: string): string {
  return createHash('sha256')
    .update(
      `parse:${PARSE_EXTRACTION_VERSION};web-tree-sitter:0.25.10;${extension};${identity}`,
    )
    .digest('hex')
}

function extractionIdentity(wasm: string, query: string): string {
  return JSON.stringify([wasm, query])
}

function getAssetIdentity(assetPath: string): string {
  try {
    const stat = fs.statSync(assetPath)
    const stamp = `${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}`
    let cached = extractionAssetDigests.get(assetPath)
    if (!cached || cached.stamp !== stamp) {
      cached = {
        stamp,
        digest: createHash('sha256')
          .update(fs.readFileSync(assetPath))
          .digest('hex'),
      }
      if (extractionAssetDigests.size >= MAX_EXTRACTION_ASSET_DIGESTS) {
        const oldest = extractionAssetDigests.keys().next().value
        if (oldest !== undefined) extractionAssetDigests.delete(oldest)
      }
      extractionAssetDigests.set(assetPath, cached)
    }
    return cached.digest
  } catch {
    return `unavailable:${path.basename(assetPath)}`
  }
}

function getWasmCandidates(wasmFile: string): {
  primary: string
  fallback: string | null
  identity: string
} {
  const primary = resolveWasmPath(wasmFile)
  const fallback = tryResolveFromPackage(wasmFile)
  return {
    primary,
    fallback,
    identity: JSON.stringify([
      primary,
      getAssetIdentity(primary),
      fallback,
      fallback ? getAssetIdentity(fallback) : null,
    ]),
  }
}

function getWasmAssetIdentity(wasmFile: string): string {
  const candidates = getWasmCandidates(wasmFile)
  const loaded = loadedWasmAssets.get(wasmFile)
  if (loaded?.candidates === candidates.identity) return loaded.digest
  const availableIdentity = getAssetIdentity(
    fs.existsSync(candidates.primary) || !candidates.fallback
      ? candidates.primary
      : candidates.fallback,
  )
  // A removed/unmounted asset cannot replace a valid grammar already in
  // memory. Keep identifying those loaded bytes; available replacements
  // still invalidate the parser when their bytes differ.
  return availableIdentity.startsWith('unavailable:') && loaded
    ? loaded.digest
    : availableIdentity
}

function getQueryAssetIdentity(config: LanguageConfig): string {
  return config.queryPathOrContent.endsWith('.scm')
    ? getAssetIdentity(resolveQueryPath(config.queryPathOrContent))
    : createHash('sha256').update(config.queryPathOrContent).digest('hex')
}

/**
 * Validate the untrusted `CODEBUFF_WASM_DIR` environment override. Rejects
 * relative paths (which could escape the intended sandbox depending on CWD)
 * and paths containing `..` segments (path traversal). Returns the resolved
 * absolute path or `null` if invalid. NOT applied to `setWasmDir`, whose
 * public contract stores caller-supplied directories verbatim.
 */
function validateWasmDir(dir: string): string | null {
  if (!dir || dir.includes('..')) {
    return null
  }
  const resolved = path.isAbsolute(dir) ? path.resolve(dir) : null
  return resolved
}

/* ------------------------------------------------------------------ */
/* 6. WASM & query path resolvers                                   */
/* ------------------------------------------------------------------ */

/**
 * Resolve the path to a WASM file in a Node.js or Bun environment.
 * Works for both ESM and CJS builds of the SDK.
 */
function resolveWasmPath(wasmFileName: string): string {
  const customWasmDirPath = getWasmDir()
  if (customWasmDirPath) {
    return path.join(customWasmDirPath, wasmFileName)
  }

  // Try environment variable override (validated to prevent path traversal)
  const envWasmDir = process.env.CODEBUFF_WASM_DIR
  if (envWasmDir) {
    const validated = validateWasmDir(envWasmDir)
    if (validated) {
      return path.join(validated, wasmFileName)
    }
    // Invalid env value: fall through to default resolution rather than loading
    // an arbitrary attacker-controlled path.
  }

  // Get the directory of this module
  const moduleDir = (() => {
    const dirname = getDirnameDynamically(import.meta.url)
    if (typeof dirname !== 'undefined') {
      return dirname
    }
    // For ESM builds, we can't reliably get the module directory in all environments
    // So we fall back to process.cwd() which works for our use case
    return process.cwd()
  })()

  // For bundled SDK: WASM files are in a shared wasm directory. We don't check
  // file existence here; Language.load() handles it and falls back to package
  // resolution if the path is missing. The first candidate is the shared wasm
  // directory (new approach to avoid duplication).
  return path.join(moduleDir, '..', 'wasm', wasmFileName)
}

/**
 * Fallback: try to resolve from the original package for development
 */
function tryResolveFromPackage(wasmFileName: string): string | null {
  try {
    // This works in development/monorepo scenarios
    return require.resolve(`@vscode/tree-sitter-wasm/wasm/${wasmFileName}`)
  } catch {
    return null
  }
}

/**
 * Resolve the absolute path to a tree-sitter tag-query (.scm) file.
 * Mirrors `resolveWasmPath`: get the module directory (with a process.cwd()
 * fallback for ESM builds where `__dirname` is unavailable). Works for both
 * ESM and CJS builds of the SDK, including npm consumers where the module
 * directory is inside node_modules. The module directory may be either the
 * src/ dir that directly contains `tree-sitter-queries` (dev/monorepo and
 * Bun-resolved layouts) or a package-entry/dist dir that does not (npm
 * layouts where the entry is `dist/index.js`), so both layouts are probed.
 *
 * Fail-closed-simple: return the first candidate whose file exists, else the
 * primary candidate. Nothing here throws: the caller reads the returned path
 * inside its fail-open query block, and a missing/unreadable file only leaves
 * that language's `query` undefined (the grammar itself stays cached — see
 * `createLanguageConfig`).
 */
function resolveQueryPath(queryFileName: string): string {
  if (path.isAbsolute(queryFileName)) return queryFileName
  const candidates = getQueryCandidatePaths(queryFileName)
  return (
    candidates.find((candidate) => fs.existsSync(candidate)) ?? candidates[0]
  )
}

/**
 * Ordered candidate locations for one tag-query file. Shared by
 * {@link resolveQueryPath} and {@link getTagQueryStatus} so the status report
 * probes exactly the paths the loader reads.
 */
function getQueryCandidatePaths(queryFileName: string): string[] {
  // Get the directory of this module
  const moduleDir = (() => {
    const dirname = getDirnameDynamically(import.meta.url)
    if (typeof dirname !== 'undefined') {
      return dirname
    }
    // For ESM builds, we can't reliably get the module directory in all environments
    // So we fall back to process.cwd() which works for our use case
    return process.cwd()
  })()

  return [
    // Primary: the module directory directly contains `tree-sitter-queries`
    // (dev/monorepo and Bun-resolved layouts).
    path.join(moduleDir, 'tree-sitter-queries', queryFileName),
    // npm/bundled layouts where the module directory is the package entry
    // (e.g. `dist/index.js`); the src/ tree sits one level below it.
    path.join(moduleDir, 'src', 'tree-sitter-queries', queryFileName),
    // Compiled binaries: the release tarball ships `tree-sitter-queries/`
    // next to the executable (see cli/scripts/release-tarball-files.sh).
    path.join(
      path.dirname(process.execPath),
      'tree-sitter-queries',
      queryFileName,
    ),
    // Fallback for development/monorepo layouts where the module directory
    // doesn't contain the queries directly.
    path.join(process.cwd(), 'tree-sitter-queries', queryFileName),
  ]
}

/** Every distinct tag-query file the language table needs. */
export const TAG_QUERY_FILES: readonly string[] = Object.freeze([
  ...new Set(Object.values(QUERY_FILES)),
])

export interface TagQueryStatus {
  /** Number of distinct query files the language table needs. */
  total: number
  /** Query files found on disk, by file name. */
  available: string[]
  /** Query files that no candidate location provides. */
  missing: string[]
}

/**
 * Report which tag-query files can be found, probing the same locations the
 * loader reads. When queries are missing, parsing still succeeds but yields
 * no symbols, calls or imports for that language, so callers surface this as
 * a degraded index rather than relying on the DEBUG_PARSING log.
 * `exists` is an injection seam for tests.
 */
export function getTagQueryStatus(
  options: { exists?: (filePath: string) => boolean } = {},
): TagQueryStatus {
  const exists = options.exists ?? fs.existsSync
  const available: string[] = []
  const missing: string[] = []
  for (const file of TAG_QUERY_FILES) {
    if (getQueryCandidatePaths(file).some((candidate) => exists(candidate))) {
      available.push(file)
    } else {
      missing.push(file)
    }
  }
  return { total: TAG_QUERY_FILES.length, available, missing }
}

/**
 * Split a tags query into top-level chunks (balanced s-expressions, aware of
 * `"` strings and `;` line comments) so {@link stripImportCapturePatterns}
 * can drop individual patterns without touching the rest of the query.
 */
function splitTopLevelQueryPatterns(content: string): string[] {
  const patterns: string[] = []
  let depth = 0
  let start = -1
  let inString = false
  let inComment = false
  for (let i = 0; i < content.length; i++) {
    const ch = content.charAt(i)
    if (inComment) {
      if (ch === '\n') inComment = false
      continue
    }
    if (inString) {
      if (ch === '\\') {
        i++
      } else if (ch === '"') {
        inString = false
      }
      continue
    }
    if (ch === '"') {
      inString = true
      if (depth === 0 && start < 0) start = i
      continue
    }
    if (ch === ';') {
      inComment = true
      if (depth === 0 && start < 0) start = i
      continue
    }
    if (ch === '(') {
      depth++
      if (depth === 1 && start < 0) start = i
      continue
    }
    if (ch === ')') {
      depth--
      if (depth === 0 && start >= 0) {
        patterns.push(content.slice(start, i + 1))
        start = -1
      }
      continue
    }
    if (depth === 0 && start < 0 && !/\s/.test(ch)) start = i
  }
  if (start >= 0) patterns.push(content.slice(start))
  return patterns
}

/**
 * P3-T5 fail-open helper: drop every top-level pattern containing an
 * `@import.` capture. Returns the content unchanged when no pattern contains
 * one, so the caller can distinguish "nothing to strip" (rethrow the
 * original compile error) from a stripped query (retry the compile).
 */
function stripImportCapturePatterns(queryContent: string): string {
  const patterns = splitTopLevelQueryPatterns(queryContent)
  if (!patterns.some((pattern) => pattern.includes('@import.'))) {
    return queryContent
  }
  return patterns.filter((pattern) => !pattern.includes('@import.')).join('\n')
}

/* ------------------------------------------------------------------ */
/* 7. One-time library init                                          */
/* ------------------------------------------------------------------ */
// Initialize tree-sitter with Node.js-specific configuration

/* ------------------------------------------------------------------ */
/* 8. Unified runtime loader                                         */
/* ------------------------------------------------------------------ */
class UnifiedLanguageLoader implements RuntimeLanguageLoader {
  private parserReady: Promise<void>

  constructor() {
    this.parserReady = initTreeSitterForNode()
  }

  async initParser(): Promise<void> {
    try {
      await this.parserReady
    } catch (err) {
      // The cached init promise rejected (e.g. transient wasm load failure).
      // Retry so a one-time failure doesn't permanently break every
      // subsequent parse — a permanently-rejected promise would re-throw the
      // same cached error forever and the loader would never recover.
      this.parserReady = initTreeSitterForNode()
      await this.parserReady
    }
  }

  async loadLanguage(wasmFile: string): Promise<Language> {
    const candidates = getWasmCandidates(wasmFile)
    const load = async (wasmPath: string): Promise<Language> => {
      // Load the exact bytes whose digest labels the persisted parse objects.
      const bytes = fs.readFileSync(wasmPath)
      const language = await Language.load(bytes)
      loadedWasmAssets.set(wasmFile, {
        candidates: candidates.identity,
        digest: createHash('sha256').update(bytes).digest('hex'),
      })
      return language
    }

    // Try to load the language using Node.js-specific method if available
    let lang: Language
    try {
      lang = await load(candidates.primary)
    } catch (err) {
      // Fallback: try resolving from the original package (development)
      const fallbackPath = candidates.fallback
      if (fallbackPath) {
        lang = await load(fallbackPath)
      } else {
        // Legacy npm wrappers update the compiled binary but preserved only
        // tree-sitter.wasm. A compiled CLI can securely repair a missing
        // language grammar from pinned package bytes; SDK consumers remain
        // offline and receive the original load error.
        const repairDir = process.env.CODEBUFF_WASM_DIR
        const repairedPath =
          process.env.CODEBUFF_IS_BINARY === 'true' && repairDir
            ? await repairGrammarWasm({ wasmFile, targetDir: repairDir })
            : null
        if (!repairedPath) throw err
        lang = await load(repairedPath)
      }
    }

    return lang
  }

  getLoadedLanguageFingerprint(wasmFile: string): string | undefined {
    return loadedWasmAssets.get(wasmFile)?.digest
  }
}

/* ------------------------------------------------------------------ */
/* 9. Helper functions                                               */
/* ------------------------------------------------------------------ */
export function findLanguageConfigByExtension(
  filePath: string,
): LanguageConfig | undefined {
  const ext = path.extname(filePath).toLowerCase()
  return languageTable.find((c) => c.extensions.includes(ext))
}

/* ------------------------------------------------------------------ */
/* 10. Language configuration loader                                 */
/* ------------------------------------------------------------------ */

/**
 * One-time "tags query unavailable" debug-log latch per language (keyed by
 * wasmFile), so a compiled binary shipped without the .scm query files logs
 * the degradation once instead of once per parsed file.
 */
const loggedQueryUnavailable = new Set<string>()

export async function createLanguageConfig(
  filePath: string,
  runtimeLoader: RuntimeLanguageLoader,
): Promise<LanguageConfig | undefined> {
  const cfg = findLanguageConfigByExtension(filePath)
  if (!cfg) {
    return undefined
  }

  const pending = configLoads.get(cfg)
  if (pending) await pending
  const wasmIdentity = getWasmAssetIdentity(cfg.wasmFile)
  const queryIdentity = getQueryAssetIdentity(cfg)
  let loaded = loadedConfigAssets.get(cfg)
  // Public callers may inject or replace a parser on the language table.
  if (cfg.parser && loaded?.parser !== cfg.parser) {
    loaded = { parser: cfg.parser, wasm: wasmIdentity, query: queryIdentity }
    loadedConfigAssets.set(cfg, loaded)
    cfg.extractionIdentity = extractionIdentity(wasmIdentity, queryIdentity)
  }
  if (
    cfg.parser &&
    loaded?.wasm === wasmIdentity &&
    loaded.query === queryIdentity
  )
    return cfg

  const loading = (async () => {
    if (!cfg.parser || loaded?.wasm !== wasmIdentity) {
      await runtimeLoader.initParser()

      // Load the language using the runtime-specific loader
      const lang = await runtimeLoader.loadLanguage(cfg.wasmFile)

      // Create the parser and MEMOIZE the language + parser on the shared
      // languageTable entry BEFORE any tags-query work. The tags query is an
      // auxiliary consumer of the loaded grammar, so a missing/unreadable
      // .scm file or a Query compile failure must never discard an already
      // loaded wasm grammar: in compiled binaries whose release layout omits
      // the query files, throwing here used to leave `cfg.parser` unset and
      // made EVERY parsed file re-run a full `Language.load` on the same
      // grammar (observed: one grammar wasm opened 853 times in a single
      // cold index build, ~5GB of wasm instance churn that froze boot).
      const parser = new Parser()
      parser.setLanguage(lang)

      cfg.language = lang
      cfg.parser = parser
      cfg.query = undefined
      loaded = {
        parser,
        wasm:
          runtimeLoader.getLoadedLanguageFingerprint?.(cfg.wasmFile) ??
          getWasmAssetIdentity(cfg.wasmFile),
        query: '',
      }
    }

    // The language table stores bare .scm file names. Normalize them to
    // absolute paths at query-load time (module load performs no fs
    // reads). Resolve LOCALLY: do NOT mutate the shared languageTable
    // entry. Table configs are module-level singletons; rewriting
    // queryPathOrContent from the bare .scm filename to an absolute path
    // made repeated loads and any consumer holding a config (including
    // the table-consistency test, which joins the name onto the queries
    // dir) order-dependent on which grammar loaded first.
    //
    // The whole query block is FAIL-OPEN: a missing/unreadable .scm file
    // or a Query compile failure leaves `cfg.query` undefined and the
    // cached grammar untouched. P3-T5 note: the tags queries include the
    // AST import-capture tier (@import.* patterns), so a bad capture
    // addition degrades to "no import captures" for that language rather
    // than breaking all parsing for it. Unavailability is logged at most
    // once per language (DEBUG_PARSING only)
    try {
      cfg.query = undefined
      const queryContent = cfg.queryPathOrContent.endsWith('.scm')
        ? fs.readFileSync(resolveQueryPath(cfg.queryPathOrContent), 'utf8')
        : cfg.queryPathOrContent
      loaded!.query = createHash('sha256').update(queryContent).digest('hex')
      try {
        cfg.query = new Query(cfg.language!, queryContent)
      } catch {
        // Query content rejected as written (e.g. a bad @import.* pattern):
        // retry ONCE with the import-capture patterns stripped. If even the
        // stripped query fails to compile, the block's catch below leaves
        // `cfg.query` undefined without throwing away the cached grammar.
        const stripped = stripImportCapturePatterns(queryContent)
        if (stripped !== queryContent) {
          cfg.query = new Query(cfg.language!, stripped)
        }
      }
    } catch (err) {
      loaded!.query = queryIdentity
      if (
        DEBUG_PARSING &&
        !loggedQueryUnavailable.has(cfg.wasmFile) &&
        loggedQueryUnavailable.add(cfg.wasmFile)
      ) {
        console.error(
          `[tree-sitter] Tags query unavailable for ${cfg.wasmFile} (grammar stays cached, query disabled):`,
          err,
        )
      }
    }
    loadedConfigAssets.set(cfg, loaded!)
    cfg.extractionIdentity = extractionIdentity(loaded!.wasm, loaded!.query)
  })()
  configLoads.set(cfg, loading)
  try {
    await loading
  } finally {
    if (configLoads.get(cfg) === loading) configLoads.delete(cfg)
  }

  return cfg
}

/* ------------------------------------------------------------------ */
/* 11. Public API                                                    */
/* ------------------------------------------------------------------ */
const unifiedLoader = new UnifiedLanguageLoader()

export async function getLanguageConfig(
  filePath: string,
): Promise<LanguageConfig | undefined> {
  try {
    return await createLanguageConfig(filePath, unifiedLoader)
  } catch (err) {
    if (DEBUG_PARSING) {
      console.error('[tree-sitter] Load error for', filePath, err)
    }
    return undefined
  }
}

export function hasLanguageConfiguration(filePath: string): boolean {
  return findLanguageConfigByExtension(filePath) !== undefined
}

/**
 * Advisory, fail-open tree-sitter syntax check for a candidate file content.
 *
 * Returns `{ available, hasError }`:
 * - `available: false` when the file extension has no tree-sitter language, the
 *   grammar cannot be loaded locally, `getLanguageConfig` returns undefined /
 *   has no parser, or ANY error is thrown. Callers must treat this as "skip".
 * - `available: true` with `hasError` reflecting `tree.rootNode.hasError`.
 *
 * This never throws and never opts into a network fetch: it relies solely on
 * the already-shipped local grammar loader (which only fetches when
 * CODEBUFF_IS_BINARY/CODEBUFF_WASM_DIR are set) and does not set those itself.
 */
export async function detectSyntaxErrorViaTreeSitter(
  filePath: string,
  content: string,
): Promise<{ available: boolean; hasError: boolean }> {
  try {
    if (!hasLanguageConfiguration(filePath)) {
      return { available: false, hasError: false }
    }
    const cfg = await getLanguageConfig(filePath)
    if (!cfg || !cfg.parser) {
      return { available: false, hasError: false }
    }
    const tree = cfg.parser.parse(content)
    if (!tree) {
      return { available: false, hasError: false }
    }
    const hasError = tree.rootNode.hasError
    try {
      tree.delete?.()
    } catch {
      // Some tree-sitter builds do not expose delete(); freeing is best-effort.
    }
    return { available: true, hasError }
  } catch {
    // Fail-open on any error (grammar unavailable, init failure, parse throw).
    return { available: false, hasError: false }
  }
}
