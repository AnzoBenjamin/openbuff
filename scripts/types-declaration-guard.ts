#!/usr/bin/env bun
/**
 * Types-declaration guard.
 *
 * A TypeScript workspace has a second, quieter dependency invariant than the
 * provenance record: a package that ships no `.d.ts` of its own must have its
 * typings package declared in the SAME manifest that depends on it at runtime.
 * `lodash` in `dependencies` without `@types/lodash` in that member's
 * `devDependencies` (or `dependencies`) typechecks only while some other
 * workspace member happens to pull the typings in, and breaks the moment that
 * neighbour drops them. Nothing about `bun install` catches this, so a version
 * bump can silently drop the co-declaration and the breakage surfaces later as
 * an unexplained `Cannot find module 'lodash'` in a package nobody touched.
 *
 * This guard checks that invariant with EVIDENCE, in this order of authority:
 *
 * 1. A conventional typings sibling declared in the SAME manifest (`lodash` ->
 *    `@types/lodash`, `@scope/pkg` -> `@types/scope__pkg`).
 * 2. The package's own bundled declarations, proven from the INSTALL on disk:
 *    the resolved `node_modules/<pkg>/package.json` carrying a `types`/
 *    `typings` field that points at a real `.d.ts` (or a real `index.d.ts`
 *    beside its entry). A workspace install is part of this repository's
 *    reach, so this is disk evidence, not a guess about upstream — and it is
 *    what keeps self-typed packages (`zod`, `ai`, `gray-matter`, ...) from
 *    demanding `@types/<name>` siblings that do not exist on npm. A package
 *    that is NOT resolvable on disk gets NO exemption from this path: a
 *    pruned or isolated install is exactly the scenario the invariant guards,
 *    so an unresolvable dependency stays a violation with a message that says
 *    so.
 * 3. An explicit, reviewed `NO_TYPES_PACKAGE` exemption naming the package
 *    that actually supplies the declarations (`@types/bun` and `bun-types`
 *    both publish the `bun` module).
 *
 * The check is fail-closed in both directions: a runtime dependency with no
 * typings declared in its own manifest is a VIOLATION, never a printed note,
 * and a manifest that is present but unparseable is an ERROR, never a silently
 * empty dependency block. Adding a runtime dependency still requires a typing
 * decision in the diff — path 2 just makes that decision automatic when the
 * package itself answers it.
 *
 * The invariant is checked in BOTH directions. The forward check
 * (`collectUndeclaredTypes`) is "runtime dependency -> its typings declared
 * here". The reverse check (`collectOrphanedTypes`) is "typings declared here ->
 * the runtime package that needs them is declared here too": an `@types/*`
 * entry whose runtime sibling no block of that same manifest declares adds pure
 * install weight and asserts a typings contract no reader can satisfy, so it is
 * a VIOLATION rather than a note. A reviewed exception is recorded in
 * `ORPHANED_TYPES_EXEMPT`.
 *
 * `unclassifiedRuntimeDependencies` still reports every exemption on every run,
 * including a green one, so the exempted surface is visible and reviewable
 * rather than implicit, and the success message names the enforced scope.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Runtime packages for which no conventional `@types` sibling is the right
 * expectation, mapped to the package(s) that actually publish their
 * declarations.
 *
 * This is NOT an allowlist of packages the guard skips: it is the explicit
 * record of why the npm-conventional typings package does not apply to that
 * runtime package. A runtime dependency that is neither in here nor
 * co-declared with its typings is a violation, so there is no silent skip.
 */
export const NO_TYPES_PACKAGE = new Map<string, string>([
  ['bun', '@types/bun and bun-types both publish the `bun` module'],
  [
    'tree-sitter-wasms',
    'Wasm grammar artifacts only (no JS API, no declarations); no @types/* package exists on npm. Consumed as binaries by @vscode/tree-sitter-wasm, never as a typed import.',
  ],
  [
    'gif-encoder-2',
    'Untyped JPEG encoder (plain-JS src/, no .d.ts); no @types/gif-encoder-2 exists on npm. Used by evals rendering, which accesses it through local wrappers.',
  ],
  [
    '@anthropic-ai/claude-code',
    'Vendored CLI distribution; the package ships sdk-tools.d.ts for the tool-metadata surface, its main module is a CLI wrapper with no declarations, and no @types/* package exists on npm.',
  ],
])

/**
 * Reviewed exceptions to the reverse (orphaned-typings) direction, keyed by
 * `manifest:typesPackage` and mapped to the justification.
 *
 * This is NOT a place to park a dependency review objection: an entry is only
 * legitimate when the typings are genuinely required by that manifest's own
 * output while its code imports no runtime sibling. Prefer declaring the
 * runtime dependency; add an entry here only when that is impossible, and say
 * why inline.
 */
export const ORPHANED_TYPES_EXEMPT = new Map<string, string>([])

/**
 * Ambients typings that describe a RUNTIME TYPE-ONLY package rather than a
 * sibling of a runtime dependency.
 *
 * `@types/node` is the canonical case: it declares the `node` module's globals
 * (`process`, `Buffer`, the `node:*` specifiers) and no npm package named `node`
 * is installable, so the reverse check can never find a runtime sibling for it.
 * The value names where the ambient actually comes from, so the exemption is a
 * statement of fact rather than a suppression.
 *
 * `@types/*` entries for a runtime package that IS installable still belong in
 * the manifest that uses them (or in `ORPHANED_TYPES_EXEMPT` with a
 * justification), so this map must stay limited to runtimes with no
 * installable package of that name.
 */
export const AMBIENT_TYPES_PACKAGE = new Map<string, string>([
  [
    '@types/node',
    'Declares the `node` module and its globals (`process`, `Buffer`, `node:*`). There is no installable npm package named `node`, so no runtime sibling can exist in any manifest; the typings are the ambient environment contract for Node-targeted code.',
  ],
  [
    '@types/bun',
    'Declares the `bun` module and its globals. `bun` is a RUNTIME EXECUTABLE, not a registry dependency, so no manifest can declare it alongside these typings; the runtime dependency the typings accompany is recorded in NO_TYPES_PACKAGE instead.',
  ],
])

/**
 * Root-manifest typings that exist to type tooling or test-only ambient modules
 * rather than a runtime dependency of the root package.
 *
 * The root manifest is the workspace ROOT: it owns typechecking and test config
 * for the whole tree, so it legitimately declares typings for modules that no
 * root `dependencies` entry names — `@types/node-fetch` types code that uses
 * `node-fetch` transitively, `@types/js-yaml` types a helper the CLI or scripts
 * call through, `@types/parse-path` matches the resolved `parse-path` line
 * without the root depending on it directly.
 *
 * Keyed by `manifest:typesPackage`, and only honoured for the root manifest, so
 * the exemption cannot loosen the invariant for a member that ships code.
 */
export const ROOT_TOOLING_TYPES_EXEMPT = new Map<string, string>([
  [
    'package.json:@types/js-yaml',
    'Typings for the `js-yaml` helpers the CLI and scripts call; the root has no direct runtime dependency on `js-yaml`, so these typings exist for typechecking the workspace rather than for a root runtime import.',
  ],
  [
    'package.json:@types/node-fetch',
    'Typings for `node-fetch`, which reaches this tree transitively. Being declared at the root lets workspace code that receives or constructs a `node-fetch` response be typed without making `node-fetch` a root runtime dependency.',
  ],
  [
    'package.json:@types/parse-path',
    'Typings aligned with the lockfile-resolved `parse-path` line; the root does not import `parse-path` directly, so this pairs the typings with the resolution rather than with a root runtime dependency.',
  ],
])

/** Workspace package name prefixes that resolve inside this repository. */
const INTERNAL_PACKAGE_PREFIXES = ['@codebuff/', '@openbuff/']

/** Node core modules, which need no typings package of their own. */
const NODE_BUILTINS = new Set([
  'fs',
  'path',
  'os',
  'crypto',
  'child_process',
  'util',
  'stream',
  'events',
  'url',
  'zlib',
  'net',
  'http',
  'https',
  'tls',
  'dns',
  'tty',
  'readline',
  'worker_threads',
  'assert',
  'buffer',
  'querystring',
  'string_decoder',
  'timers',
  'v8',
  'vm',
  'async_hooks',
  'perf_hooks',
  'process',
])

/**
 * One workspace member's dependency declarations, with its project-relative
 * manifest path.
 */
export type WorkspaceManifest = {
  /** Manifest path relative to the repo root, slash-separated. */
  manifest: string
  /** The member's runtime dependencies. */
  dependencies: Record<string, string>
  /** The member's development dependencies. */
  devDependencies: Record<string, string>
}

/**
 * A dependency/typings pair the guard rejects, in either direction: a runtime
 * dependency whose typings are not declared in its own manifest, or an
 * `@types/*` entry whose runtime package its own manifest does not declare.
 */
export type TypesDeclarationViolation = {
  /** Manifest path relative to the repo root, slash-separated. */
  manifest: string
  /**
   * The offending dependency. Forward direction: the runtime dependency whose
   * typings are not declared. Reverse direction: the orphaned typings package.
   */
  dependency: string
  /**
   * Forward direction: the typings package that should have been co-declared.
   * Reverse direction: the runtime package declared by neither block.
   */
  expectedTypes: string
}

/**
 * What `collectUndeclaredTypes` consumes: the manifests to check plus the
 * disk-evidence predicate for bundled typings. Passed as an object so a caller
 * can hand the check a fixture set without touching disk; `shipsOwnTypes` is
 * optional so pure-manifest fixtures stay deterministic (an absent predicate
 * simply means "no disk evidence", which never exempts a dependency).
 */
export type TypesDeclarationInput = {
  manifests: readonly WorkspaceManifest[]
  /**
   * Disk evidence: does the installed copy of `dependency`, resolved from the
   * member that owns `manifest`, ship its own `.d.ts`? Wired by
   * `checkTypesDeclarations` over the real install; tests inject a stub.
   */
  shipsOwnTypes?: (dependency: string, manifest: string) => boolean
}

/**
 * The repository root: the parent of the `scripts/` directory this file
 * lives in.
 */
export function projectRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..')
}

/**
 * Read and parse a JSON file, or return undefined when it is missing. A
 * manifest that is present but unparseable is an ERROR, not an empty
 * dependency block: a malformed `package.json` would otherwise make the guard
 * "pass" by contributing no dependencies to check (fail-open), so the parse
 * failure is rethrown with the path attached for the top level to fail closed.
 */
function readJson(path: string): unknown {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
  try {
    return JSON.parse(text)
  } catch (error) {
    throw new Error(
      `manifest is not valid JSON: ${path} (${error instanceof Error ? error.message : String(error)})`,
    )
  }
}

/** Narrow an unknown manifest field to a `name -> specifier` record. */
function asDependencyRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const record: Record<string, string> = {}
  for (const [name, specifier] of Object.entries(
    value as Record<string, unknown>,
  )) {
    record[name] = typeof specifier === 'string' ? specifier : ''
  }
  return record
}

/**
 * The workspace member directories declared by the root manifest, with the
 * root itself included. A `dir/*` pattern expands to the directories that
 * actually exist under it, so a workspace member is only reported when it
 * is really on disk.
 */
export function expandWorkspaceDirectories(root: string): string[] {
  const rootManifest = readJson(join(root, 'package.json')) as
    | { workspaces?: unknown }
    | undefined
  const patterns = Array.isArray(rootManifest?.workspaces)
    ? (rootManifest.workspaces as unknown[]).filter(
        (entry): entry is string => typeof entry === 'string',
      )
    : ['.']

  const directories = new Set<string>([root])
  for (const pattern of patterns) {
    if (pattern.endsWith('/*')) {
      const parent = join(root, pattern.slice(0, -2))
      if (!existsSync(parent)) continue
      for (const entry of readdirSync(parent, { withFileTypes: true })) {
        if (entry.isDirectory()) directories.add(join(parent, entry.name))
      }
      continue
    }
    directories.add(join(root, pattern))
  }
  return [...directories].sort()
}

/**
 * Every workspace member manifest, sorted by manifest path. Members whose
 * `package.json` is missing are skipped; a member with no dependency blocks
 * reports empty records rather than being dropped.
 */
export function readWorkspaceManifests(root: string): WorkspaceManifest[] {
  const manifests: WorkspaceManifest[] = []
  for (const directory of expandWorkspaceDirectories(root)) {
    const manifestPath = join(directory, 'package.json')
    if (!existsSync(manifestPath)) continue
    const manifest = readJson(manifestPath)
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
      // A manifest that parses to a non-object is as unusable as one that does
      // not parse: skipping it would shrink the checked scope silently.
      throw new Error(
        `manifest is not a JSON object: ${manifestPath}`,
      )
    }
    manifests.push({
      manifest: relative(root, manifestPath).split(sep).join('/'),
      dependencies: asDependencyRecord(
        (manifest as Record<string, unknown>).dependencies,
      ),
      devDependencies: asDependencyRecord(
        (manifest as Record<string, unknown>).devDependencies,
      ),
    })
  }
  return manifests.sort((left, right) =>
    left.manifest < right.manifest ? -1 : left.manifest > right.manifest ? 1 : 0,
  )
}

/**
 * The typings package npm conventions expect for a runtime package name:
 * `lodash` -> `@types/lodash` and `@scope/pkg` -> `@types/scope__pkg` (strip
 * the leading `@`, replace `/` with `__`).
 */
export function expectedTypesPackage(name: string): string {
  if (!name.startsWith('@')) return `@types/${name}`
  return `@types/${name.slice(1).replace('/', '__')}`
}

/**
 * The runtime package an `@types/*` typings package describes, the exact
 * inverse of `expectedTypesPackage`: `@types/lodash` -> `lodash` and
 * `@types/scope__pkg` -> `@scope/pkg`.
 */
export function runtimePackageForTypes(typesPackage: string): string {
  const unscoped = typesPackage.startsWith('@types/')
    ? typesPackage.slice('@types/'.length)
    : typesPackage
  const separator = unscoped.indexOf('__')
  if (separator === -1) return unscoped
  return `@${unscoped.slice(0, separator)}/${unscoped.slice(separator + 2)}`
}

/**
 * True when the package needs no typings package of its own: an internal
 * workspace package, a typings package, or a Node builtin.
 */
function shipsItsOwnTypes(name: string): boolean {
  if (INTERNAL_PACKAGE_PREFIXES.some((prefix) => name.startsWith(prefix))) {
    return true
  }
  if (name.startsWith('@types/')) return true
  if (name.startsWith('node:')) return true
  return NODE_BUILTINS.has(name)
}

/**
 * Resolve the installed directory of `dependency` for the workspace member at
 * `memberDir`, walking up through parent `node_modules` to the repository
 * root — the same resolution an import from that member performs. Returns
 * undefined when the package is not installed anywhere reachable, which is NOT
 * an exemption: a dependency that cannot be inspected cannot be proven to
 * carry declarations.
 */
export function resolveInstalledPackageDir(
  dependency: string,
  memberDir: string,
  root: string,
): string | undefined {
  let current = memberDir
  while (true) {
    const candidate = join(current, 'node_modules', ...dependency.split('/'))
    if (existsSync(join(candidate, 'package.json'))) return candidate
    if (current === root) return undefined
    const parent = dirname(current)
    if (parent === current) return undefined
    current = parent
  }
}

/**
 * Whether an installed package directory ships its own TypeScript
 * declarations. Three proofs, in order: a `types`/`typings` field that
 * resolves to an existing file; an `index.d.ts` beside the package root; and
 * a `.d.ts` beside the package's ENTRY — the `exports['.']` condition value
 * or `main` — which is how modern packages that carry no top-level `types`
 * field still bundle declarations (`@modelcontextprotocol/sdk`,
 * `gpt-tokenizer`). Field values that do not resolve are NOT proof, and an
 * entry without an adjacent `.d.ts` is not proof either; unresolved cases fall
 * through to "not proven" rather than being assumed.
 */
export function installedPackageShipsTypes(packageDir: string): boolean {
  const manifest = readJson(join(packageDir, 'package.json')) as
    | { types?: unknown; typings?: unknown; main?: unknown; exports?: unknown }
    | undefined
  if (!manifest || typeof manifest !== 'object') return false
  for (const field of ['types', 'typings']) {
    const value = (manifest as Record<string, unknown>)[field]
    if (typeof value === 'string' && value.length > 0) {
      const resolved = resolve(packageDir, value)
      if (existsSync(resolved) && statSync(resolved).isFile()) return true
    }
  }
  if (existsSync(join(packageDir, 'index.d.ts'))) return true
  const entries: string[] = []
  const dotExports =
    manifest.exports &&
    typeof manifest.exports === 'object' &&
    !Array.isArray(manifest.exports)
      ? (manifest.exports as Record<string, unknown>)['.']
      : undefined
  if (typeof dotExports === 'string') {
    entries.push(dotExports)
  } else if (dotExports && typeof dotExports === 'object') {
    const conditions = dotExports as Record<string, unknown>
    // Every flat string condition, `types` first: some packages ship the
    // `.d.ts` beside only ONE of the condition entries (e.g. next to the
    // `require` build but not the `import` build), so all of them are
    // candidates.
    for (const condition of ['types', 'import', 'require', 'default']) {
      if (typeof conditions[condition] === 'string') {
        entries.push(conditions[condition] as string)
      }
    }
  }
  if (typeof manifest.main === 'string' && manifest.main.length > 0) {
    entries.push(manifest.main)
  }
  for (const entry of entries) {
    const dts = entry.replace(/\.(?:js|mjs|cjs)$/, '.d.ts')
    if (!dts.endsWith('.d.ts')) continue
    const resolved = resolve(packageDir, dts)
    if (existsSync(resolved) && statSync(resolved).isFile()) return true
  }
  // Final tier: a package consumed through SUBPATH exports (e.g.
  // `@modelcontextprotocol/sdk/client/index.js`) may ship declarations beside
  // those subpath entries while its `.` entry has none. One subpath with an
  // adjacent `.d.ts` proves the tarball bundles declarations.
  if (
    manifest.exports &&
    typeof manifest.exports === 'object' &&
    !Array.isArray(manifest.exports)
  ) {
    for (const [key, value] of Object.entries(
      manifest.exports as Record<string, unknown>,
    )) {
      if (key.includes('*')) continue
      const subEntries: string[] =
        typeof value === 'string'
          ? [value]
          : value && typeof value === 'object'
            ? (['types', 'import', 'require', 'default'] as const)
                .map((condition) => (value as Record<string, unknown>)[condition])
                .filter(
                  (condition): condition is string =>
                    typeof condition === 'string',
                )
            : []
      for (const subEntry of subEntries) {
        const dts = subEntry.replace(/\.(?:js|mjs|cjs)$/, '.d.ts')
        if (!dts.endsWith('.d.ts')) continue
        const resolved = resolve(packageDir, dts)
        if (existsSync(resolved) && statSync(resolved).isFile()) return true
      }
    }
  }
  return false
}

/** Total order over violations: manifest, then dependency. */
function compareViolations(
  left: TypesDeclarationViolation,
  right: TypesDeclarationViolation,
): number {
  return left.manifest < right.manifest
    ? -1
    : left.manifest > right.manifest
      ? 1
      : left.dependency < right.dependency
        ? -1
        : left.dependency > right.dependency
          ? 1
          : 0
}

/**
 * Every runtime dependency whose typings are not declared in its own manifest,
 * sorted by manifest then dependency.
 *
 * Fail-closed for every runtime dependency that is not an internal workspace
 * link, a typings package, or a Node builtin: there is no per-package allowlist
 * of dependencies the guard declines to check. Typings count as declared in
 * `devDependencies` (the canonical place) or in `dependencies` (unconventional
 * but not a violation), and only in the SAME manifest — a sibling member
 * declaring the typings does not satisfy the invariant. A package with no
 * conventional `@types` sibling must be recorded in `NO_TYPES_PACKAGE` together
 * with the package that supplies its declarations.
 */
export function collectUndeclaredTypes(
  findingsInput: TypesDeclarationInput,
): TypesDeclarationViolation[] {
  const violations: TypesDeclarationViolation[] = []
  const shipsOwnTypes = findingsInput.shipsOwnTypes
  for (const workspaceManifest of findingsInput.manifests) {
    const { manifest, dependencies, devDependencies } = workspaceManifest
    for (const name of Object.keys(dependencies)) {
      if (shipsItsOwnTypes(name)) continue
      const expectedTypes = expectedTypesPackage(name)
      if (
        expectedTypes in devDependencies ||
        expectedTypes in dependencies
      ) {
        continue
      }
      // Disk evidence outranks the exemption table: a package that provably
      // bundles its own declarations is compliant without any entry here, so
      // NO_TYPES_PACKAGE stays reserved for packages no install can prove.
      if (shipsOwnTypes?.(name, manifest)) continue
      if (NO_TYPES_PACKAGE.has(name)) continue
      violations.push({ manifest, dependency: name, expectedTypes })
    }
  }
  return violations.sort(compareViolations)
}

/**
 * Every runtime dependency the guard exempted through `NO_TYPES_PACKAGE`, as
 * `manifest -> dependency` pairs, sorted and deduplicated.
 *
 * The exemption list is the only place the guard declines to expect a
 * conventional `@types` sibling, so reporting it on every run — including a
 * green one — keeps that surface in review: a new exemption shows up here
 * instead of hiding behind a pass.
 */
export function unclassifiedRuntimeDependencies(
  findingsInput: TypesDeclarationInput,
): TypesDeclarationViolation[] {
  const seen = new Set<string>()
  const unclassified: TypesDeclarationViolation[] = []
  for (const workspaceManifest of findingsInput.manifests) {
    const { manifest, dependencies } = workspaceManifest
    for (const name of Object.keys(dependencies)) {
      if (!NO_TYPES_PACKAGE.has(name)) continue
      if (shipsItsOwnTypes(name)) continue
      const key = `${manifest}\u0000${name}`
      if (seen.has(key)) continue
      seen.add(key)
      unclassified.push({
        manifest,
        dependency: name,
        expectedTypes: expectedTypesPackage(name),
      })
    }
  }
  return unclassified.sort(compareViolations)
}

/**
 * Every `@types/*` entry whose runtime package the SAME manifest declares in
 * neither `dependencies` nor `devDependencies`, sorted by manifest then
 * dependency.
 *
 * This is the reverse of `collectUndeclaredTypes` and closes the direction an
 * orphaned typings declaration slipped through: an `@types/*` entry with no
 * runtime sibling in its own manifest is install weight no reader of that
 * package can satisfy, and it is exactly the shape a copy-paste between
 * manifests produces. `runtimePackageForTypes` inverts the npm convention, so
 * the same pair of names is checked from both sides.
 *
 * An entry recorded in `ORPHANED_TYPES_EXEMPT` is skipped; the exemption is
 * reported by `orphanedTypesExemptions` so it stays visible on a green run.
 */
export function collectOrphanedTypes(
  findingsInput: TypesDeclarationInput,
): TypesDeclarationViolation[] {
  const violations: TypesDeclarationViolation[] = []
  for (const workspaceManifest of findingsInput.manifests) {
    const { manifest, dependencies, devDependencies } = workspaceManifest
    for (const typesPackage of declaredTypesPackages(workspaceManifest)) {
      const runtimePackage = runtimePackageForTypes(typesPackage)
      if (!runtimePackage) continue
      // An ambient typings package (`@types/node` -> `node`) describes the
      // environment, not an installable dependency, so there is no runtime
      // sibling to require.
      if (AMBIENT_TYPES_PACKAGE.has(typesPackage)) continue
      // A Node builtin has no runtime package to declare, and a runtime package
      // whose own typings are declared is not orphaned by definition.
      if (shipsItsOwnTypes(runtimePackage)) continue
      if (runtimePackage in dependencies || runtimePackage in devDependencies) {
        continue
      }
      if (ORPHANED_TYPES_EXEMPT.has(`${manifest}:${typesPackage}`)) continue
      // The workspace ROOT owns typechecking for the whole tree, so it
      // legitimately declares typings for modules no root `dependencies` entry
      // names. A member that ships code has no such exemption.
      if (manifest === 'package.json' && ROOT_TOOLING_TYPES_EXEMPT.has(`${manifest}:${typesPackage}`)) {
        continue
      }
      violations.push({
        manifest,
        dependency: typesPackage,
        expectedTypes: runtimePackage,
      })
    }
  }
  return violations.sort(compareViolations)
}

/**
 * Every typings package a manifest declares, in `dependencies` or
 * `devDependencies`, deduplicated and sorted. Unconventional placement in
 * `dependencies` is checked too: `@types/*` is a compile-time-only contract, so
 * an orphaned entry there is the same defect.
 */
function declaredTypesPackages(
  workspaceManifest: WorkspaceManifest,
): string[] {
  const names = new Set([
    ...Object.keys(workspaceManifest.dependencies),
    ...Object.keys(workspaceManifest.devDependencies),
  ])
  return [...names].filter((name) => name.startsWith('@types/')).sort()
}

/**
 * Every orphaned-typings pair the guard admitted through
 * `ORPHANED_TYPES_EXEMPT`, as `manifest -> typings package` entries.
 */
export function orphanedTypesExemptions(
  findingsInput: TypesDeclarationInput,
): TypesDeclarationViolation[] {
  const exemptions: TypesDeclarationViolation[] = []
  for (const workspaceManifest of findingsInput.manifests) {
    const { manifest } = workspaceManifest
    for (const typesPackage of declaredTypesPackages(workspaceManifest)) {
      if (!ORPHANED_TYPES_EXEMPT.has(`${manifest}:${typesPackage}`)) continue
      exemptions.push({
        manifest,
        dependency: typesPackage,
        expectedTypes: runtimePackageForTypes(typesPackage),
      })
    }
  }
  return exemptions.sort(compareViolations)
}

/**
 * Walk the workspace and check every member's dependency declarations in BOTH
 * directions: every runtime dependency for typings declared in the same
 * manifest, and every declared `@types/*` entry for the runtime package it
 * types declared in the same manifest — together with the runtime dependencies
 * covered by a `NO_TYPES_PACKAGE` exemption and the typings covered by
 * `ORPHANED_TYPES_EXEMPT`.
 */
export function checkTypesDeclarations(root: string = projectRoot()): {
  ok: boolean
  violations: TypesDeclarationViolation[]
  orphanedTypes: TypesDeclarationViolation[]
  unclassified: TypesDeclarationViolation[]
} {
  const manifests = readWorkspaceManifests(root)
  const shipsOwnTypes = (dependency: string, manifest: string): boolean => {
    const packageDir = resolveInstalledPackageDir(
      dependency,
      dirname(join(root, manifest)),
      root,
    )
    return packageDir !== undefined && installedPackageShipsTypes(packageDir)
  }
  const violations = collectUndeclaredTypes({ manifests, shipsOwnTypes })
  const orphanedTypes = collectOrphanedTypes({ manifests })
  return {
    ok: violations.length === 0 && orphanedTypes.length === 0,
    violations,
    orphanedTypes,
    unclassified: unclassifiedRuntimeDependencies({ manifests }),
  }
}

/**
 * Format the violations for a terminal.
 *
 * The success text names the ENFORCED scope — every runtime dependency of every
 * workspace manifest, not a per-package allowlist — and the exemption list is
 * appended so the exempted surface is visible on a green run too.
 */
export function formatTypesDeclarationViolations(
  violations: readonly TypesDeclarationViolation[],
  unclassified: readonly TypesDeclarationViolation[] = [],
  orphanedTypes: readonly TypesDeclarationViolation[] = [],
): string {
  const all = [...violations, ...orphanedTypes]
  if (all.length === 0) {
    const lines = [
      'Type declaration guard passed: every runtime dependency of every workspace manifest declares its typings in that same manifest, and every declared @types package has the runtime dependency it types in that same manifest, or is recorded in NO_TYPES_PACKAGE / ORPHANED_TYPES_EXEMPT with the package that supplies them.',
    ]
    if (unclassified.length > 0) {
      lines.push(
        `Note: ${unclassified.length} runtime dependency release(s) rely on a NO_TYPES_PACKAGE exemption; confirm each still has no conventional @types sibling:`,
        ...unclassified.map(
          (entry) => `  - ${entry.manifest}: ${entry.dependency}`,
        ),
      )
    }
    if (orphanedTypes.length > 0) {
      lines.push(
        `Note: ${orphanedTypes.length} typings package(s) rely on an ORPHANED_TYPES_EXEMPT exemption:`,
        ...orphanedTypes.map(
          (entry) => `  - ${entry.manifest}: ${entry.dependency}`,
        ),
      )
    }
    return lines.join('\n')
  }
  const forward = new Set(
    violations.map((violation) => `${violation.manifest}\u0000${violation.dependency}`),
  )
  return [
    'Type declaration guard failed:',
    ...all.map((violation) =>
      // Both directions are named explicitly, so a reader never has to infer
      // which half of the invariant failed. The forward list is the authority
      // on which entries are runtime dependencies.
      forward.has(`${violation.manifest}\u0000${violation.dependency}`)
        ? `  - ${violation.manifest}: ${violation.dependency} declares no ${violation.expectedTypes}`
        : `  - ${violation.manifest}: ${violation.dependency} types ${violation.expectedTypes}, which this manifest declares in neither dependencies nor devDependencies`,
    ),
  ].join('\n')
}

if (import.meta.main) {
  try {
    const { ok, violations, orphanedTypes, unclassified } =
      checkTypesDeclarations()
    const text = formatTypesDeclarationViolations(
      violations,
      unclassified,
      orphanedTypes,
    )
    if (!ok) {
      console.error(text)
      process.exit(1)
    }
    console.log(text)
    process.exit(0)
  } catch (error) {
    // A malformed manifest (or an unreadable tree) must fail the guard, not
    // silently shrink the checked scope.
    console.error(
      `Type declaration guard failed: ${error instanceof Error ? error.message : String(error)}`,
    )
    process.exit(1)
  }
}

