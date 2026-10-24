import { createRequire } from 'node:module'
import * as fs from 'node:fs'
import * as path from 'node:path'

import type { ImportResolutionFile, TsAliasMap } from './import-resolution'

/**
 * Real TypeScript/JavaScript module-resolution tier for the indexer's import
 * graph (P3-T5 upgrade over the hand-rolled candidate prober).
 *
 * {@link createTsModuleResolver} returns a COMBINED resolver with two tiers:
 *
 * 1. PRIMARY — `oxc-resolver@11.24.2`: one `ResolverFactory` (the Rust
 *    resolver behind oxc's napi binding) constructed per cached resolver
 *    entry and driven per call via `factory.sync(directory, request)`; oxc
 *    has no cwd/root option, so the importing file's directory is passed
 *    per call. Unlike the ts host it probes the REAL filesystem, which buys
 *    native support for package.json `exports`/`imports` conditions,
 *    tsconfig `paths`, and project `references: 'auto'` without hand-built
 *    hosts. Its real-fs appetite is bounded on purpose: `nodePath: false`
 *    (no NODE_PATH expansion), `symlinks: false` (symlinked node_modules
 *    layouts must not rewrite paths outside the root-relative gate),
 *    `modules` unset, and `fullySpecified: false` so './helper.js' can
 *    still map to an indexed .ts file. Condition names are pinned to
 *    `['node', 'import']` (oxc has no condition default and fails on
 *    `exports` without one; our indexed imports are ESM-style). The
 *    `tsconfig` option (`configFile: <root>/tsconfig.json`,
 *    `references: 'auto'`) is wired only when `tsconfig.json` exists at the
 *    project root — a missing config is a wasted probe — and covers
 *    paths+references natively, complementing `loadTsAliases`, which feeds
 *    the ts fallback tier. Resolution failures are RETURNED in
 *    `result.error` — never thrown — and the closure is additionally
 *    guarded by try/catch.
 * 2. FALLBACK — `ts.resolveModuleName` from the `typescript` package,
 *    running against a minimal in-memory module-resolution host over the
 *    INDEXED files map — never the real filesystem — so the fallback tier
 *    cannot invent edges outside the index. It is used verbatim whenever
 *    the oxc napi binding fails to load or construct on the platform
 *    (fail-open at require AND at factory construction) or when oxc
 *    conservatively misses. The `packageJsons` fixture seam below is
 *    ts-fallback-only: the oxc factory reads the real filesystem and does
 *    not honor injected fixtures, which is exactly why the existing
 *    exports/imports tests that inject packageJsons keep exercising the
 *    fallback tier unchanged.
 *
 * The fallback tier's in-memory host:
 *
 * - `fileExists` answers from the indexed files map for source files
 *   (normalized to posix project-relative paths; absolute inputs are accepted
 *   only when they stay inside the project root), plus `true` for package.json
 *   manifests the host can actually serve: `ts.resolveModuleName` only
 *   consults `exports`/`imports` when the manifest exists, so reporting
 *   existence exactly when {@link readPackageJson}-equivalent content is
 *   available is what enables those fields. A non-manifest file outside the
 *   index still does not exist.
 * - `readFile` answers ONLY package.json requests, and only so
 *   `ts.resolveModuleName` can honor package.json `exports`/`imports`
 *   condition fields: it first answers from the injected `packageJsons`
 *   fixture map (project-relative path → raw JSON string), then — only when
 *   the map misses — performs a bounded real `fs.readFileSync` for an
 *   absolute `package.json` path inside the project root of at most 64 KiB.
 *   Every other request (all non-package.json files) stays undefined.
 *
 * Conservative contract (mirrors the `conservative-unresolved` rule in
 * import-resolution.ts): only relative specifiers (`./x`, `../x`) and
 * tsconfig-paths/bare specifiers that actually land on an indexed file
 * resolve. A bare specifier resolves only when the real resolution rules
 * (extension priority .ts > .tsx > .d.ts, /index resolution, `paths`,
 * package.json `exports`/`imports` conditions) hit an indexed file.
 *
 * package.json `exports`/`imports` support: with the host able to read
 * package.json files, the pinned typescript@5.5.4 honors the `exports`
 * field (including package self-name references like `pkg/sub` when the
 * package.json carries a matching `name`) and the `imports` field (`#alias`
 * specifiers) under the default `moduleResolution: 'bundler'` mode; the
 * resolver tests in ts-module-resolver.test.ts pin this behavior, and if a
 * TypeScript upgrade changes which fields each mode honors, that
 * docblock/test pair is the place to record and adapt it. Still NO
 * node_modules traversal written here: an `exports` target pointing into
 * node_modules resolves only if that exact file is indexed (which it never
 * is), so such specifiers stay null. The conservative final-edge gate is
 * UNCHANGED and remains the LAST check in EACH tier's resolver closure: a
 * resolution is accepted only when its absolute path (`resolvedFileName`
 * for the ts host, `result.path` for oxc) normalizes to a project-relative
 * path present in the indexed files map, so enabling exports/imports — or
 * oxc's native tsconfig `paths`/`references` resolution — cannot invent
 * edges into node_modules; it only lets real resolution rules map
 * bare/`#` specifiers onto indexed files.
 *
 * Fail-open: both `oxc-resolver` and `typescript` are loaded lazily via a
 * sync require-style dynamic import (the same spirit as the
 * `await import('bun:sqlite')` dynamic dependency in agent-runtime); if an
 * import fails, a module is unusable, or the oxc `ResolverFactory` cannot
 * be constructed (e.g. the platform napi binary is absent), that tier
 * yields null and resolution degrades gracefully: oxc → ts host → the
 * existing conservative resolution path, all unchanged.
 */

export type TsModuleResolver = (
  importPath: string,
  fromFilePath: string,
) => string | null

/** Minimal typed surface of the lazily loaded `typescript` module. */
type TypescriptModule = typeof import('typescript')

/** Minimal typed surface of the lazily loaded `oxc-resolver` module. */
type OxcResolverModule = typeof import('oxc-resolver')

/** Sync require-style dynamic import (the indexer runs under Bun/ESM). */
const requireTypescript = createRequire(import.meta.url)

/** Sync require-style dynamic import for the oxc napi binding. */
const requireOxcResolver = createRequire(import.meta.url)

/**
 * Upper bound on the real-filesystem package.json fallback read (64 KiB):
 * larger manifests fail open to undefined so a pathological file cannot
 * bloat the resolution host.
 */
const MAX_PACKAGE_JSON_BYTES = 64 * 1024

interface ResolverCacheEntry {
  projectRoot: string
  moduleResolution: 'node' | 'bundler'
  aliases: TsAliasMap | undefined
  packageJsons: Record<string, string> | undefined
  resolver: TsModuleResolver | null
}

/**
 * Memoize the created resolver per `files` record identity (same WeakMap
 * pattern as `topLevelDirsCache` in import-resolution.ts) so a build pass
 * reuses one resolution host instead of rebuilding it per import site.
 */
const resolverCache = new WeakMap<
  Record<string, ImportResolutionFile>,
  ResolverCacheEntry
>()

export function createTsModuleResolver(params: {
  projectRoot: string
  files: Record<string, ImportResolutionFile>
  aliases?: TsAliasMap
  moduleResolution?: 'node' | 'bundler'
  /** Optional hermetic package.json fixtures: project-relative path → raw JSON string. */
  packageJsons?: Record<string, string>
}): TsModuleResolver | null {
  const moduleResolution = params.moduleResolution ?? 'bundler'
  const cached = resolverCache.get(params.files)
  if (
    cached &&
    cached.projectRoot === params.projectRoot &&
    cached.moduleResolution === moduleResolution &&
    cached.aliases === params.aliases &&
    cached.packageJsons === params.packageJsons
  ) {
    return cached.resolver
  }
  // Combined closure: oxc-resolver is the PRIMARY tier, the
  // ts.resolveModuleName host is the FALLBACK (used when oxc failed to
  // load/construct, or when oxc conservatively missed). Each tier fails
  // open internally; when BOTH fail to construct, the factory returns null
  // so the caller's optional-resolver contract holds. The oxc factory is
  // stateful/caching and lives inside this cached entry — no extra
  // memoization needed.
  const oxcTier = buildOxcResolver(params)
  const tsTier = buildTsModuleResolver(params, moduleResolution)
  const resolver: TsModuleResolver | null =
    oxcTier === null && tsTier === null
      ? null
      : (importPath, fromFilePath) =>
          oxcTier?.(importPath, fromFilePath) ??
          tsTier?.(importPath, fromFilePath) ??
          null
  resolverCache.set(params.files, {
    projectRoot: params.projectRoot,
    moduleResolution,
    aliases: params.aliases,
    packageJsons: params.packageJsons,
    resolver,
  })
  return resolver
}

/**
 * Normalize any host/resolver path to a posix project-relative path,
 * rejecting absolute paths outside the root and any `..` escape
 * (belt-and-braces against host quirks; nothing outside the index may
 * become an edge).
 */
function toProjectRelative(
  absoluteRoot: string,
  candidate: string,
): string | null {
  const absolute = path.isAbsolute(candidate)
    ? candidate
    : path.resolve(absoluteRoot, candidate)
  const relative = path.relative(absoluteRoot, absolute)
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    return null
  }
  return relative.split(path.sep).join('/')
}

/**
 * PRIMARY tier: an oxc-resolver (Rust) factory over the REAL filesystem.
 * One `ResolverFactory` is constructed per cached resolver entry; its
 * internal caches live for that entry's lifetime, so no extra memoization
 * is needed here. Fail-open: if the oxc napi binding cannot be required or
 * the factory cannot be constructed (e.g. the platform binary is absent),
 * this yields null and the ts.resolveModuleName fallback tier takes over.
 */
function buildOxcResolver(params: {
  projectRoot: string
  files: Record<string, ImportResolutionFile>
}): TsModuleResolver | null {
  let oxc: OxcResolverModule | undefined
  try {
    oxc = requireOxcResolver('oxc-resolver') as OxcResolverModule
  } catch {
    // Fail-open: no oxc napi binding -> no oxc tier; the ts host fallback
    // (or the conservative arms) remain the resolution path.
    return null
  }
  if (typeof oxc?.ResolverFactory !== 'function') return null

  const absoluteRoot = path.resolve(params.projectRoot)
  const files = params.files

  // oxc has no cwd/root option: the importing file's directory is passed
  // per sync() call, anchored on the same resolved root as the ts tier.
  // The tsconfig option is only wired when the manifest exists at the
  // project root — a missing config is a wasted probe — and covers
  // tsconfig paths + project references natively (complementing
  // loadTsAliases, which feeds the ts fallback tier).
  const tsconfigPath = path.join(absoluteRoot, 'tsconfig.json')
  let factory: InstanceType<OxcResolverModule['ResolverFactory']>
  try {
    factory = new oxc.ResolverFactory({
      // Required for exports/imports fields (oxc has no condition default);
      // our indexed imports are ESM-style, so 'import' alongside 'node'.
      conditionNames: ['node', 'import'],
      // Order matters: TS sources before their compiled outputs, d.ts last.
      extensions: [
        '.ts',
        '.tsx',
        '.js',
        '.jsx',
        '.mjs',
        '.cjs',
        '.mts',
        '.cts',
        '.json',
        '.d.ts',
      ],
      // Keep './helper.js' able to map to an indexed .ts file.
      fullySpecified: false,
      // Symlinked node_modules layouts must not rewrite resolved paths
      // outside the root-relative gate.
      symlinks: false,
      // Minimize node_modules traversal appetite (no NODE_PATH expansion).
      nodePath: false,
      ...(fs.existsSync(tsconfigPath)
        ? {
            tsconfig: {
              configFile: tsconfigPath,
              references: 'auto' as const,
            },
          }
        : {}),
    })
  } catch {
    // Fail-open at construction too (missing/unloadable napi binary);
    // the ts host fallback takes over.
    return null
  }

  return (importPath, fromFilePath) => {
    try {
      // oxc failures are RETURNED in `error`, never thrown; anything
      // without an absolute `path` is a conservative miss.
      const result = factory.sync(
        path.dirname(path.resolve(absoluteRoot, fromFilePath)),
        importPath,
      )
      const resolvedPath = result.path
      if (typeof resolvedPath !== 'string') return null
      // IDENTICAL final-edge gate as the ts tier (unchanged, LAST check):
      // real node_modules probes resolve to real files, but node_modules is
      // never indexed, so those edges are refused here.
      const relative = toProjectRelative(absoluteRoot, resolvedPath)
      if (relative === null || files[relative] === undefined) return null
      return relative
    } catch {
      // Belt-and-braces: even a raised oxc error degrades to unresolved.
      return null
    }
  }
}

function buildTsModuleResolver(
  params: {
    projectRoot: string
    files: Record<string, ImportResolutionFile>
    aliases?: TsAliasMap
    packageJsons?: Record<string, string>
  },
  moduleResolution: 'node' | 'bundler',
): TsModuleResolver | null {
  let ts: TypescriptModule | undefined
  try {
    ts = requireTypescript('typescript') as TypescriptModule
  } catch {
    // Fail-open: no typescript module -> no ts tier; the conservative arms
    // in resolveImportToFile remain the only resolution path.
    return null
  }
  if (typeof ts?.resolveModuleName !== 'function') return null

  const absoluteRoot = path.resolve(params.projectRoot)
  const files = params.files

  // Bounded cache for real-filesystem package.json reads so repeated
  // fileExists probes during resolution do not re-stat the same manifest per
  // import site (bounded at 64 entries; a full cache is simply cleared).
  const realPackageJsonCache = new Map<string, string | undefined>()

  // Serve a package.json request: injected fixture first, then a bounded
  // real read inside the project root. Both fileExists and readFile share
  // this helper so ts.resolveModuleName's manifest probes see one
  // consistent host.
  const readPackageJson = (name: string): string | undefined => {
    if (path.basename(name) !== 'package.json') return undefined
    if (!path.isAbsolute(name)) return undefined
    const relative = toProjectRelative(absoluteRoot, name)
    if (relative === null) return undefined
    const injected = params.packageJsons?.[relative]
    if (injected !== undefined) return injected
    if (realPackageJsonCache.has(name)) return realPackageJsonCache.get(name)
    try {
      const stat = fs.statSync(name)
      const content =
        stat.isFile() && stat.size <= MAX_PACKAGE_JSON_BYTES
          ? fs.readFileSync(name, 'utf8')
          : undefined
      if (realPackageJsonCache.size >= 64) realPackageJsonCache.clear()
      realPackageJsonCache.set(name, content)
      return content
    } catch {
      return undefined
    }
  }

  // In-memory module-resolution host over the INDEXED files map only.
  const host = {
    fileExists(name: string): boolean {
      const relative = toProjectRelative(absoluteRoot, name)
      if (relative !== null && files[relative] !== undefined) return true
      // package.json manifests are never indexed source files, but
      // ts.resolveModuleName only consults `exports`/`imports` when the
      // host reports the manifest exists — report existence exactly when
      // readPackageJson can serve it (injected fixture or bounded real
      // in-root read). The final-edge gate below still refuses any
      // resolution that does not land on an indexed file.
      return readPackageJson(name) !== undefined
    },
    readFile(name: string): string | undefined {
      // Only package.json requests are served (to power package.json
      // `exports`/`imports` conditions); everything else stays undefined.
      return readPackageJson(name)
    },
  }

  // Pinned minimal option shape (risk: option semantics drift across TS
  // versions; keep this list small and explicit).
  const options = {
    moduleResolution:
      moduleResolution === 'bundler'
        ? ts.ModuleResolutionKind.Bundler
        : ts.ModuleResolutionKind.NodeJs,
    esModuleInterop: true,
    allowJs: true,
    checkJs: false,
    ...(params.aliases
      ? { baseUrl: params.projectRoot, paths: params.aliases }
      : {}),
  }

  return (importPath, fromFilePath) => {
    try {
      // containingFile is anchored inside the project root so relative
      // specifiers resolve against the importing file's directory.
      const result = ts.resolveModuleName(
        importPath,
        path.resolve(absoluteRoot, fromFilePath),
        options,
        host,
      )
      const resolvedFileName = result.resolvedModule?.resolvedFileName
      if (typeof resolvedFileName !== 'string') return null
      const relative = toProjectRelative(absoluteRoot, resolvedFileName)
      if (relative === null || files[relative] === undefined) return null
      return relative
    } catch {
      // Any resolver-host quirk degrades to unresolved; the conservative
      // arms stay the source of truth.
      return null
    }
  }
}
