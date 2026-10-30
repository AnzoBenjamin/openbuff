import * as fs from 'fs'
import * as path from 'path'

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
}

export interface RuntimeLanguageLoader {
  loadLanguage(wasmFile: string): Promise<Language>
  initParser(): Promise<void>
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
    const dirname = getDirnameDynamically()
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
  // Get the directory of this module
  const moduleDir = (() => {
    const dirname = getDirnameDynamically()
    if (typeof dirname !== 'undefined') {
      return dirname
    }
    // For ESM builds, we can't reliably get the module directory in all environments
    // So we fall back to process.cwd() which works for our use case
    return process.cwd()
  })()

  const primary = path.join(moduleDir, 'tree-sitter-queries', queryFileName)
  if (fs.existsSync(primary)) {
    return primary
  }

  // Candidate for npm/bundled layouts where the module directory is the
  // package entry (e.g. `dist/index.js`) and does not directly contain
  // `tree-sitter-queries`; the src/ tree with the queries sits one level
  // below the entry directory.
  const srcCandidate = path.join(
    moduleDir,
    'src',
    'tree-sitter-queries',
    queryFileName,
  )
  if (fs.existsSync(srcCandidate)) {
    return srcCandidate
  }

  // Candidate for compiled binaries: the release layout can ship the
  // `tree-sitter-queries/` directory next to the executable, where no
  // module-relative (bundle) nor src-relative (monorepo) layout applies.
  // Existence-checked like the src candidate so a binary shipped without the
  // query dir simply falls through — its grammar stays cached with `query`
  // undefined (see createLanguageConfig).
  const execDirCandidate = path.join(
    path.dirname(process.execPath),
    'tree-sitter-queries',
    queryFileName,
  )
  if (fs.existsSync(execDirCandidate)) {
    return execDirCandidate
  }

  // Fallback for development/monorepo layouts where the module directory
  // doesn't contain the queries directly.
  const cwdCandidate = path.join(
    process.cwd(),
    'tree-sitter-queries',
    queryFileName,
  )
  return fs.existsSync(cwdCandidate) ? cwdCandidate : primary
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
    // Resolve WASM file path
    let wasmPath = resolveWasmPath(wasmFile)

    // Try to load the language using Node.js-specific method if available
    let lang: Language
    try {
      lang = await Language.load(wasmPath)
    } catch (err) {
      // Fallback: try resolving from the original package (development)
      const fallbackPath = tryResolveFromPackage(wasmFile)
      if (fallbackPath) {
        lang = await Language.load(fallbackPath)
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
        lang = await Language.load(repairedPath)
      }
    }

    return lang
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

  if (!cfg.parser) {
    try {
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
        let querySource = cfg.queryPathOrContent
        if (!path.isAbsolute(querySource)) {
          querySource = resolveQueryPath(querySource)
        }
        const queryContent = path.isAbsolute(querySource)
          ? fs.readFileSync(querySource, 'utf8')
          : querySource
        try {
          cfg.query = new Query(lang, queryContent)
        } catch {
          // Query content rejected as written (e.g. a bad @import.* pattern):
          // retry ONCE with the import-capture patterns stripped. If even the
          // stripped query fails to compile, the block's catch below leaves
          // `cfg.query` undefined without throwing away the cached grammar.
          const stripped = stripImportCapturePatterns(queryContent)
          if (stripped !== queryContent) {
            cfg.query = new Query(lang, stripped)
          }
        }
      } catch (err) {
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
    } catch (err) {
      // Let the runtime-specific implementation handle error logging
      throw err
    }
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
