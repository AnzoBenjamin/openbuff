#!/usr/bin/env bun
/**
 * Dependency provenance guard.
 *
 * A manifest pin is only trustworthy if it can be reconciled to a real
 * upstream release: the version must exist on the registry, and the
 * integrity hash the lockfile records must be the one the registry publishes
 * for that release. `bun.lock` alone cannot answer that — it stores a hash,
 * not the upstream identity that produced it — so this guard keeps a
 * CHECKED-IN record of the upstream provenance for every declared third-party
 * dependency and reconciles it against the manifests and the lockfile.
 *
 * WHAT THE OFFLINE CHECK PROVES — AND DOES NOT PROVE. Both inputs to it,
 * `bun.lock` and `scripts/dependency-provenance.json`, are written by this
 * repository's own workflow (`bun install`, and `--refresh` reading the
 * registry). So the offline reconciliation proves that the RECORD AGREES WITH
 * THE LOCKFILE for every in-scope release; it does NOT prove upstream identity
 * on its own. A compromised or misconfigured registry mirror, or a refresh run
 * against a tampered lockfile, makes the two agree and this gate green. The
 * upstream anchor is therefore the REVIEWED DIFF of the record file: that diff
 * is produced by `--refresh` against the public registry and must be reviewed
 * and approved before it is committed. Treat a provenance-record change as a
 * supply-chain-affecting change, not as generated noise.
 *
 * A dependency is in scope when its manifest specifier names a release: either
 * outright, as an EXACT pin whose version starts with a digit
 * (`"lodash": "4.17.23"`), or through the lockfile, for a RANGE specifier
 * (`^1.18.2`) the lockfile already resolved. Specifiers that name nothing in
 * the registry — `workspace:`, `file:`, `link:`, git and URL forms — contribute
 * no release and are therefore ungated. Internal workspace packages are
 * excluded too, because they are not published.
 *
 * The record tracks RESOLVED UPSTREAM IDENTITIES, not manifest spellings. A
 * record entry for a package a manifest declares under a range
 * (`"@types/lodash": "^4.17.21"`) is legitimate provenance: the lockfile
 * resolved that range to that one release when the record was written.
 * Reconciliation therefore RETAINS such an entry rather than calling it stale;
 * an entry is stale only when no workspace manifest declares that package name
 * any more.
 *
 * A range is never guessed at, but it is not left unreconciled either: the
 * lockfile already decided which release every range means, so
 * `collectResolvedDependencies` reads that decision back out and the gate fails
 * CLOSED when a range-declared package has no recorded provenance for the
 * release bun.lock resolved — including a SECOND resolution of the same package
 * (root `ignore@6.0.2` alongside the sdk's exact `ignore@7.0.5`), which a
 * pin-only record silently under-describes. Exact pins remain the fail-closed
 * default; the resolved-range set is why the record is never narrower than the
 * real dependency graph.
 *
 * The reconciliation is OFFLINE by design. CI, `check:ci-local`, and the
 * pre-push hook all run it, and a network call in that path would make the
 * gate depend on registry availability (and slow it down) for a check that
 * can be answered from files already in the repository. The registry is
 * consulted only when the record is deliberately refreshed:
 *
 *   bun run scripts/dependency-provenance-guard.ts --refresh
 *
 * `--refresh` re-reads the registry for every exact pin and every lockfile-
 * resolved range release, then rewrites scripts/dependency-provenance.json. It
 * is the only path that touches the network, and it is a maintainer action, not
 * a gate.
 *
 * What the offline check asserts, for every exact third-party pin AND every
 * range-declared third-party dependency's lockfile-resolved release:
 *
 *   1. the release has a provenance record entry (a sourced upstream identity);
 *   2. the lockfile has an entry for it at all;
 *   3. the record's integrity equals the sha512 the lockfile records (the
 *      lockfile and the upstream identity agree);
 *   4. the record's tarball equals the canonical registry URL for that
 *      name and version (the record names the release it describes);
 *   5. the record carries an upstream license on the explicit SPDX allowlist
 *      (`LICENSE_ALLOWLIST`), which only admits permissive identifiers whose
 *      outbound redistribution terms are met by this repository's own
 *      Apache-2.0 license. `UNKNOWN` or any non-allowlisted identifier is a
 *      finding, so a copyleft or unknown-license dependency CANNOT pass green;
 *   5b. a release upstream marks deprecated is only reconciled when it has a
 *      reviewed `DEPRECATION_EXCEPTIONS` entry; an unreviewed one is a
 *      finding, so a deprecation cannot land as an after-the-fact note;
 *   6. the record has no entry for a package no manifest declares any more (a
 *      stale record would otherwise silently outlive its dependency). A
 *      range-declared package counts as declared; see above.
 *
 * Assertions 1 and 2 apply to every exact pin UNCONDITIONALLY. An exact pin is
 * never dropped from the scope because the lockfile failed to resolve it: it is
 * reported as `missing-lock-entry` instead. That matters for a dev pin whose
 * only lockfile evidence sits under a nested resolution path, and it is why the
 * lockfile scan keys on the `name@version` tuple body rather than on the
 * enclosing resolution-path key. Reconciliation and the `--refresh` path share
 * ONE scope definition (`withLockfileResolution`, reached through
 * `collectReconciledDependencies`), so the record can never be refreshed
 * narrower than the gate demands.
 *
 * A dependency with no upstream release, or a lockfile hash that does not match
 * the published one, therefore fails HERE — offline, from files in the
 * repository — instead of surfacing later as an unreconcilable dependency
 * graph that nobody can check without network access.
 */

import {
  existsSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Where the checked-in provenance record lives, relative to the repo root. */
export const PROVENANCE_RECORD_PATH = 'scripts/dependency-provenance.json'

/** The registry the provenance in the record was read from. */
export const REGISTRY_ORIGIN = 'https://registry.npmjs.org'

/**
 * Registry round-trips allowed in flight during a refresh. A refresh reads one
 * document per release, so the width is about not hammering the registry rather
 * than about total work; the gate has its own 15s per-request timeout.
 */
const REFRESH_FETCH_CONCURRENCY = 6

/**
 * Upstream provenance for one published release.
 */
export type ProvenanceEntry = {
  /** The `dist.integrity` (sha512) the registry publishes for this release. */
  integrity: string
  /** The license the release declares. */
  license: string
  /** The canonical registry tarball URL for this name@version. */
  tarball: string
  /** True when the registry marks the release deprecated. */
  deprecated: boolean
}

/**
 * The checked-in provenance record: one entry per declared third-party
 * dependency release, keyed by `name@version`.
 */
export type ProvenanceRecord = {
  /** Where the provenance in this record came from. */
  source: string
  /** When the record was last refreshed from that source. */
  verifiedAt: string
  /** Upstream provenance keyed by `name@version`. */
  packages: Record<string, ProvenanceEntry>
}

/**
 * One third-party dependency release in scope for the gate, with every manifest
 * that declares it. `spec` is the exact pin for an exact specifier, or the
 * release bun.lock resolved that range to.
 */
export type PinnedDependency = {
  /** `name@version`, at the pinned or lockfile-resolved version. */
  spec: string
  /** The package name. */
  name: string
  /** The pinned version, or the lockfile-resolved version for a range pin. */
  version: string
  /** The workspace manifests that declare the pin. */
  manifests: string[]
}

/**
 * A third-party dependency whose release comes from the lockfile rather than an
 * exact manifest pin, with every manifest that declares it under a range.
 */
export type ResolvedDependency = {
  /** The package name. */
  name: string
  /** Workspace manifests declaring the package under a range specifier. */
  manifests: string[]
}

/**
 * The ways the offline reconciliation can fail.
 */
export type ProvenanceFindingCode =
  | 'missing-provenance'
  | 'missing-lock-entry'
  | 'integrity-mismatch'
  | 'tarball-mismatch'
  | 'missing-license'
  | 'disallowed-license'
  | 'unreviewed-deprecation'
  | 'source-mismatch'
  | 'stale-provenance'

export type ProvenanceFinding = {
  code: ProvenanceFindingCode
  /** The `name@version` the finding is about, or `''` for repo-wide findings. */
  spec: string
  /** Human-readable explanation. */
  message: string
}

const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies'] as const

/**
 * The SPDX identifiers this repository may depend on, outbound license first.
 *
 * This repository publishes `@openbuff/sdk` under Apache-2.0 (root and sdk
 * manifests both say so), so every dependency must be redistributable under
 * terms Apache-2.0 can satisfy outbound: permissive licenses (MIT/ISC/BSD/
 * Apache/0BSD/CC0/Unlicense) do not constrain the outbound license, and the
 * LGPL-3.0/Apache-2.0 `or-later`/`WITH` variants below are attributed forms
 * that remain compatible. Anything else — copyleft (GPL/AGPL/SSPL), source-
 * available, `UNKNOWN`, or an empty field — is a finding.
 *
 * Deliberately an ALLOWLIST, not a blocklist: an unfamiliar identifier must be
 * reviewed and added here explicitly rather than slipping through by default.
 * Identifiers are compared exactly (trimmed) against the registry's `license`
 * field, which is an SPDX expression or identifier; a compound expression such
 * as `MIT OR Apache-2.0` is not on the list and needs a deliberate decision.
 */
export const LICENSE_ALLOWLIST = new Set([
  '0BSD',
  'Apache-2.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'CC0-1.0',
  'ISC',
  'LGPL-3.0-or-later',
  'MIT',
  'Unlicense',
])

/**
 * Reviewed, per-release exceptions to the allowlist, keyed by `name@version`
 * with the justification inline.
 *
 * The allowlist stays exact-match and fail-closed; this map is the explicit,
 * diff-visible decision record for a release whose upstream `license` field is
 * not a bare SPDX identifier this repository can allowlist globally. Each key
 * names ONE release, so bumping the dependency re-opens the review instead of
 * inheriting an old approval, and the justification is required reading for the
 * reviewer who sees the entry change.
 *
 * A release whose upstream identifier differs from an allowlisted one only by
 * case does NOT belong here: the record is normalised to the allowlisted
 * spelling when it is refreshed (see `normalizeLicense`), so an entry here is a
 * genuine, release-specific license decision rather than a spelling objection.
 *
 * `@anthropic-ai/claude-code` declares `SEE LICENSE IN README.md` rather than an
 * SPDX identifier. It is a `dependencies` entry of the private, dev-only
 * `evals` package (never shipped to consumers), and its README grants use of
 * the proprietary Claude Code CLI — which the evals harness invokes as a
 * separate process rather than linking or redistributing. Keeping the release
 * is the deliberate decision; the exception records it instead of weakening the
 * allowlist for every dependency.
 */
export const LICENSE_EXEMPTIONS = new Map<string, string>([
  [
    '@anthropic-ai/claude-code@2.0.56',
    'Dev-only eval dependency: `evals` is private and not published, so this release never enters an install graph consumers get. Upstream declares `SEE LICENSE IN README.md`, whose terms permit using the Claude Code CLI this harness invokes as a separate process; it is not linked, bundled, or redistributed. Reviewed and accepted for this exact release only.',
  ],
])

/**
 * Reviewed, per-release acceptance of upstream DEPRECATION, keyed by
 * `name@version` with the reason the release is retained.
 *
 * `checkProvenance` fails an in-scope release the record marks deprecated
 * unless its exact `name@version` appears here, so a newly deprecated release
 * cannot land green on a printed note: either it is replaced in the same
 * change, or a reviewer records why it stays. Keys name ONE release, so a bump
 * re-opens the review instead of inheriting the previous acceptance, and the
 * reason is what makes an accepted deprecation distinguishable from an
 * oversight during a dependency audit.
 */
export const DEPRECATION_EXCEPTIONS = new Map<string, string>([
  [
    '@oclif/parser@3.8.17',
    'Deprecated upstream because it is the legacy oclif v3 argument parser, but it is not a direct dependency of this workspace: it is resolved transitively through the `@oclif/core` v4 tooling chain, so this repository cannot replace or drop it without dropping that chain. Retained for this exact release; it is not promoted to a direct dependency. Replace it when the oclif tooling that pulls it in moves off the legacy parser.',
  ],
  [
    '@types/diff@8.0.0',
    'Deprecated upstream because `diff` now ships its own type declarations, so the separate `@types/diff` package is redundant. It is retained for this exact release because the workspace pins the `@types/diff` 8.0.0 typings that match the resolved `diff` 8.x line; dropping it is a typings change (`diff` imports and the type declarations it provides) that belongs in its own reviewed change rather than in the provenance record this entry accompanies.',
  ],
  [
    '@types/parse-path@7.1.0',
    'Deprecated upstream because `parse-path` now ships its own type declarations, so the separate `@types/parse-path` package is redundant. It is retained for this exact release because the root manifest declares it for the resolved `parse-path` 7.x line; consolidating onto the package-provided typings is a typings change that must be made and reviewed separately, not silently inherited from the provenance record.',
  ],
])

/**
 * Map an upstream license identifier onto the spelling the allowlist carries,
 * when the only difference is case (`UNLICENSE` -> `Unlicense`).
 *
 * Registries publish license fields in inconsistent case, and a release that
 * grants exactly the allowlisted terms must not read as a pending license
 * objection merely because of capitalisation. Comparison is otherwise exact, so
 * this normalises only when a case-insensitive match is UNIQUE on the
 * allowlist — an identifier that could map to more than one entry, or to none,
 * is left untouched and still has to be reviewed on its own.
 */
export function normalizeLicense(license: string): string {
  const trimmed = license.trim()
  if (LICENSE_ALLOWLIST.has(trimmed)) return trimmed
  const folded = trimmed.toLowerCase()
  const matches = [...LICENSE_ALLOWLIST].filter(
    (candidate) => candidate.toLowerCase() === folded,
  )
  return matches.length === 1 ? matches[0]! : trimmed
}

/** True when a recorded license identifier is not in its allowlisted spelling. */
export function licenseNeedsNormalization(license: string): boolean {
  return normalizeLicense(license) !== license.trim()
}

/** Workspace package name prefixes that resolve inside this repository. */
const INTERNAL_PACKAGE_PREFIXES = ['@codebuff/', '@openbuff/']

/**
 * The repository root: the parent of the `scripts/` directory this file
 * lives in.
 */
export function projectRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..')
}

/**
 * Read and parse a JSON file, or return undefined when it is missing or
 * unparseable. A malformed manifest is reported by the caller as a missing
 * pin rather than crashing the guard.
 */
function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return undefined
  }
}

/**
 * Parse a JSON object body, or return undefined when the text is not one. Used
 * where a manifest or lockfile that EXISTS but is unparseable must be reported
 * rather than silently read as having no dependencies.
 */
function parseJsonObject(raw: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return undefined
    }
    return parsed as Record<string, unknown>
  } catch {
    return undefined
  }
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
 * Every EXACT third-party pin across the workspace manifests.
 *
 * A specifier is a pin when it starts with a digit (`4.17.23`): it names one
 * upstream release, which is what the provenance record describes. Everything
 * else — `^`/`~`/`>=`/`*` ranges, `workspace:`, `file:`, `link:`, git and URL
 * specifiers — names no single release and contributes NO pin here. A range is
 * not resolved here on purpose: the lockfile already decided which release it
 * meant, and `collectResolvedDependencies` reads that decision back out so it is
 * reconciled too (see the module docblock), rather than re-derived per manifest.
 * Internal workspace packages are excluded because they are not published
 * upstream.
 *
 * Several manifests declaring the same `name@version` merge into one pin that
 * lists all of them.
 */
export function collectExactPins(root: string): PinnedDependency[] {
  const bySpec = new Map<string, PinnedDependency>()
  for (const directory of expandWorkspaceDirectories(root)) {
    const manifestPath = join(directory, 'package.json')
    if (!existsSync(manifestPath)) continue
    const manifest = readJson(manifestPath) as
      | Record<string, unknown>
      | undefined
    if (!manifest) continue
    const manifestRelative = relative(root, manifestPath).split(sep).join('/')
    for (const field of DEPENDENCY_FIELDS) {
      const dependencies = manifest[field]
      if (!dependencies || typeof dependencies !== 'object') continue
      for (const [name, rawVersion] of Object.entries(
        dependencies as Record<string, unknown>,
      )) {
        if (typeof rawVersion !== 'string') continue
        if (
          INTERNAL_PACKAGE_PREFIXES.some((prefix) => name.startsWith(prefix))
        ) {
          continue
        }
        // Only an exact specifier (version starts with a digit) pins a
        // release; a range or a non-registry specifier contributes no pin.
        if (!/^[0-9]/.test(rawVersion)) continue
        const version = rawVersion
        // Keyed by spec, so several manifests declaring the same
        // `name@version` merge into one pin that lists all of them.
        const spec = `${name}@${version}`
        const existing = bySpec.get(spec)
        if (existing) {
          if (!existing.manifests.includes(manifestRelative)) {
            existing.manifests.push(manifestRelative)
          }
          continue
        }
        bySpec.set(spec, {
          spec,
          name,
          version,
          manifests: [manifestRelative],
        })
      }
    }
  }
  return [...bySpec.values()].sort((left, right) =>
    left.spec < right.spec ? -1 : left.spec > right.spec ? 1 : 0,
  )
}

/**
 * Specifier prefixes whose release is NOT decided by bun.lock: workspace links
 * are local packages, `file:`/`link:`/`portal:` are paths, `patch:` points back
 * at a registry specifier the patch provider resolves, and git/URL specifiers
 * point outside the registry. (`npm:` aliases and plain ranges ARE registry
 * releases, so they stay in scope.) These are the only categories the gate
 * deliberately leaves ungated, and docs/development.md says so.
 */
const NON_REGISTRY_SPECIFIER_PREFIXES = [
  'workspace:',
  'file:',
  'link:',
  'portal:',
  'patch:',
  'git+',
  'git:',
  'github:',
  'http://',
  'https://',
]

/**
 * Every third-party dependency whose release is chosen by the LOCKFILE rather
 * than by an exact manifest pin, keyed by package name.
 *
 * A range (`^1.18.2`, `~2.9.0`, `>=1`, `*`) names no release on its own, which is
 * exactly why it cannot be skipped: this repository's highest-risk runtime
 * dependencies are caret-pinned (`@modelcontextprotocol/sdk`, `ai`, `ws`,
 * `micromatch`, `gray-matter`), and one package can resolve to more than one
 * version across the workspace (root `ignore@6.0.2` next to the sdk's exact
 * `ignore@7.0.5`). Gating only exact pins therefore under-describes the real
 * dependency graph. The lockfile already decided each range's release, so this
 * returns the names (with their declaring manifests) whose decision must be
 * reconciled; `checkProvenance` resolves the versions from bun.lock.
 *
 * Internal workspace packages are excluded because they are not published
 * (the published SDK bundles them into dist/; see sdk/package.json).
 */
export function collectResolvedDependencies(
  root: string,
): ResolvedDependency[] {
  const byName = new Map<string, ResolvedDependency>()
  for (const directory of expandWorkspaceDirectories(root)) {
    const manifestPath = join(directory, 'package.json')
    if (!existsSync(manifestPath)) continue
    const manifest = readJson(manifestPath) as
      | Record<string, unknown>
      | undefined
    if (!manifest) continue
    const manifestRelative = relative(root, manifestPath).split(sep).join('/')
    for (const field of DEPENDENCY_FIELDS) {
      const dependencies = manifest[field]
      if (!dependencies || typeof dependencies !== 'object') continue
      for (const [name, rawVersion] of Object.entries(
        dependencies as Record<string, unknown>,
      )) {
        if (typeof rawVersion !== 'string') continue
        if (
          INTERNAL_PACKAGE_PREFIXES.some((prefix) => name.startsWith(prefix))
        ) {
          continue
        }
        // An exact specifier is already a pin; the exact-pin check owns it.
        if (/^[0-9]/.test(rawVersion)) continue
        if (
          NON_REGISTRY_SPECIFIER_PREFIXES.some((prefix) =>
            rawVersion.startsWith(prefix),
          )
        ) {
          continue
        }
        const existing = byName.get(name)
        if (existing) {
          if (!existing.manifests.includes(manifestRelative)) {
            existing.manifests.push(manifestRelative)
          }
          continue
        }
        byName.set(name, { name, manifests: [manifestRelative] })
      }
    }
  }
  return [...byName.values()].sort((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
  )
}

/**
 * The `name@version` -> integrity map the lockfile records.
 *
 * bun.lock stores each resolved package as
 * `["name@version", "", { ...deps }, "sha512-..."]`, so the integrity is the
 * last element of that tuple. The key of the enclosing object is a RESOLUTION
 * PATH — for a duplicated dependency it is a nested path such as
 * `"@types/diff/diff"` — so the `name@version` inside the tuple, not the key,
 * identifies the release. Matching the tuple body rather than the key is what
 * makes this scan independent of nesting depth: a workspace-nested resolution
 * (`"typescript": ["typescript@5.5.4", ...]`) and a top-level one are read
 * identically, which is what keeps an exact dev pin like `typescript@5.5.4`
 * reconcilable instead of quietly out of scope.
 */
export function parseLockIntegrities(lockText: string): Map<string, string> {
  const integrities = new Map<string, string>()
  const pattern = /"([^"]+@[0-9][^"]*)",\s*"",\s*\{[^\n]*\},\s*"(sha\d+-[^"]+)"/g
  for (const match of lockText.matchAll(pattern)) {
    integrities.set(match[1]!, match[2]!)
  }
  return integrities
}

/**
 * Every version bun.lock resolved for a package name, sorted.
 *
 * `parseLockIntegrities` keys by `name@version`, so a package the lockfile
 * resolved more than once contributes one entry per release (`ignore@6.0.2`
 * and `ignore@7.0.5` can both be present). Reading the versions back is what
 * lets a range be reconciled against the release it ACTUALLY resolved to
 * instead of the release an exact pin elsewhere in the workspace suggests.
 *
 * A scoped name contains `@` itself, so the version starts after the LAST `@`.
 */
export function resolvedVersions(
  name: string,
  lockIntegrities: ReadonlyMap<string, string>,
): string[] {
  const versions: string[] = []
  for (const spec of lockIntegrities.keys()) {
    const at = spec.lastIndexOf('@')
    if (at <= 0) continue
    if (spec.slice(0, at) !== name) continue
    versions.push(spec.slice(at + 1))
  }
  return versions.sort()
}

/**
 * The canonical registry tarball URL for a name and version.
 *
 * A scoped package's tarball lives under its scope but is named after the
 * unscoped package: `@types/lodash@4.17.21` resolves to
 * `.../@types/lodash/-/lodash-4.17.21.tgz`.
 */
export function canonicalTarball(name: string, version: string): string {
  const basename = name.startsWith('@')
    ? name.slice(name.indexOf('/') + 1)
    : name
  return `${REGISTRY_ORIGIN}/${name}/-/${basename}-${version}.tgz`
}

/**
 * Load the checked-in provenance record, or undefined when it is missing or
 * unparseable.
 */
export function readProvenanceRecord(
  root: string = projectRoot(),
): ProvenanceRecord | undefined {
  const record = readJson(join(root, PROVENANCE_RECORD_PATH)) as
    | ProvenanceRecord
    | undefined
  if (!record || typeof record !== 'object') return undefined
  if (!record.packages || typeof record.packages !== 'object') return undefined
  return record
}

/**
 * Assert the release invariants for one in-scope dependency release: a sourced
 * identity, agreement with the lockfile hash, the canonical tarball, and a
 * license. Shared by the exact-pin and lockfile-resolved passes so the two
 * scopes cannot drift apart.
 */
function reconcileRelease(
  dependency: PinnedDependency,
  lockIntegrities: ReadonlyMap<string, string>,
  record: ProvenanceRecord,
  findings: ProvenanceFinding[],
): void {
  const entry = record.packages[dependency.spec]
  const declaredBy = dependency.manifests.join(', ')
  if (!entry) {
    findings.push({
      code: 'missing-provenance',
      spec: dependency.spec,
      message: `declared by ${declaredBy} but has no upstream provenance record; refresh it with \`bun run scripts/dependency-provenance-guard.ts --refresh\``,
    })
    return
  }

  const lockIntegrity = lockIntegrities.get(dependency.spec)
  if (!lockIntegrity) {
    findings.push({
      code: 'missing-lock-entry',
      spec: dependency.spec,
      message: `declared by ${declaredBy} but bun.lock records no integrity for it`,
    })
  } else if (lockIntegrity !== entry.integrity) {
    findings.push({
      code: 'integrity-mismatch',
      spec: dependency.spec,
      message: `bun.lock records ${lockIntegrity} but the provenance record says ${entry.integrity}; the lockfile and the upstream release disagree`,
    })
  }

  const expectedTarball = canonicalTarball(
    dependency.name,
    dependency.version,
  )
  if (entry.tarball !== expectedTarball) {
    findings.push({
      code: 'tarball-mismatch',
      spec: dependency.spec,
      message: `provenance record names ${entry.tarball} but the canonical registry URL for ${dependency.name}@${dependency.version} is ${expectedTarball}`,
    })
  }

  if (!entry.license) {
    findings.push({
      code: 'missing-license',
      spec: dependency.spec,
      message: 'provenance record carries no upstream license',
    })
  } else if (!isAllowedLicense(entry.license, dependency.spec)) {
    findings.push({
      code: 'disallowed-license',
      spec: dependency.spec,
      message: `provenance record carries upstream license \`${entry.license}\`, which is not on the Apache-2.0-compatible allowlist (${[...LICENSE_ALLOWLIST].sort().join(', ')}) and has no LICENSE_EXEMPTIONS entry; review the license before depending on this release`,
    })
  }

  // A deprecation is a supply-chain decision, not a log line: an in-scope
  // release upstream discourages use of may only pass with a reviewed
  // per-release acceptance recorded here.
  assertDeprecationAccepted(entry, dependency.spec, findings)
}

/**
 * Report a deprecated release that has no reviewed `DEPRECATION_EXCEPTIONS`
 * entry. Shared by the scoped reconciliation and the record-wide pass below, so
 * a deprecated release cannot pass by not being reconciled at all.
 */
function assertDeprecationAccepted(
  entry: ProvenanceEntry,
  spec: string,
  findings: ProvenanceFinding[],
): void {
  if (!entry.deprecated) return
  if (DEPRECATION_EXCEPTIONS.has(spec)) return
  findings.push({
    code: 'unreviewed-deprecation',
    spec,
    message:
      'upstream marks this release deprecated and no DEPRECATION_EXCEPTIONS entry accepts it; replace the release, or record why it is retained in DEPRECATION_EXCEPTIONS',
  })
}

/**
 * True when a recorded upstream license is on the allowlist, or when the
 * release it belongs to has an explicit reviewed `LICENSE_EXEMPTIONS` entry.
 * `UNKNOWN` is the literal `fetchProvenance` writes when the registry publishes
 * no license, so it is never allowlisted — and a release-specific exemption is
 * the only way to admit a non-allowlisted identifier.
 *
 * An exemption is scoped to the full `name@version`, never to a license string:
 * a new release of the same package must be reviewed again rather than
 * inheriting the previous decision.
 */
export function isAllowedLicense(
  license: string,
  spec?: string,
): boolean {
  if (LICENSE_ALLOWLIST.has(normalizeLicense(license))) return true
  return spec !== undefined && LICENSE_EXEMPTIONS.has(spec)
}

/**
 * The origin the checked-in record was sourced from, or `undefined` when it
 * carries none. The offline gate compares it to `REGISTRY_ORIGIN`, because a
 * record refreshed from a mirror pins that mirror's identity while
 * `canonicalTarball` derives every comparison from the public registry — the
 * two cannot be reconciled silently.
 */
export function recordSourceOrigin(record: ProvenanceRecord): string | undefined {
  const source = record.source?.trim().replace(/\/+$/, '')
  return source ? source : undefined
}

/**
 * Reconcile the reconciled scope against the lockfile and the record.
 *
 * Every check here is answerable from files in the repository: the pins come
 * from the manifests, the integrity hashes come from bun.lock, and the
 * upstream identities come from the checked-in record.
 *
 * Every supplied release is asserted, resolved by the lockfile or not: a pin
 * with no lockfile integrity is a `missing-lock-entry` finding, which is what
 * stops a manifest pin and a lockfile that never resolved it from passing
 * silently. Callers therefore pass the FULL scope, not just the pins the
 * lockfile happens to mention.
 *
 * `declaredNames` is every package name any workspace manifest declares, at
 * ANY specifier. The record tracks resolved upstream identities, so it can
 * legitimately contain the release a caret/tilde range resolved to even though
 * `collectExactPins` never turns that range into a pin. Such an entry is not
 * stale: the range names the package, and the lockfile named the release.
 * Only a package no manifest mentions at all is stale. When the set is not
 * supplied, staleness is decided against the supplied releases alone.
 */
export function reconcileProvenance(
  pins: readonly PinnedDependency[],
  lockIntegrities: ReadonlyMap<string, string>,
  record: ProvenanceRecord,
  declaredNames?: ReadonlySet<string>,
): ProvenanceFinding[] {
  const findings: ProvenanceFinding[] = []

  // Assert the recorded origin FIRST. `canonicalTarball` derives every tarball
  // comparison from `REGISTRY_ORIGIN`, so a record refreshed from a mirror pins
  // that mirror's identity — and the lockfile was produced by the same mirror,
  // so the two agree with each other while both disagree with the origin the
  // tarball assertion is measured against. Reporting the mismatch here is what
  // stops a mirror-sourced record from being reconciled as the public one.
  const recordedOrigin = recordSourceOrigin(record)
  if (recordedOrigin !== REGISTRY_ORIGIN) {
    findings.push({
      code: 'source-mismatch',
      spec: '',
      message: recordedOrigin
        ? `provenance record was sourced from ${recordedOrigin}, but the gate derives every tarball comparison from ${REGISTRY_ORIGIN}; re-refresh the record against ${REGISTRY_ORIGIN}, or point the gate at the registry the lockfile was resolved from`
        : `provenance record declares no source origin, but the gate derives every tarball comparison from ${REGISTRY_ORIGIN}; re-refresh the record so it names the registry it was read from`,
    })
  }

  for (const pin of pins) {
    reconcileRelease(pin, lockIntegrities, record, findings)
  }

  // Deduplicated so a release reached through more than one rule contributes at
  // most one `stale-provenance` decision per record entry.
  const reconciled = new Set(pins.map((pin) => pin.spec))
  for (const spec of Object.keys(record.packages).sort()) {
    if (reconciled.has(spec)) continue
    // A record entry for a package a manifest still declares under a range is
    // legitimate provenance for the release the lockfile resolved; only a
    // package no manifest declares at all is stale.
    if (declaredNames?.has(spec.slice(0, spec.lastIndexOf('@')))) continue
    findings.push({
      code: 'stale-provenance',
      spec,
      message:
        'provenance record describes a dependency no workspace manifest declares any more',
    })
  }

  return findings
}

/**
 * Reconcile every RANGE-declared dependency against the release(s) bun.lock
 * resolved for it.
 *
 * This is the coverage boundary the exact-pin pass leaves open: caret-pinned
 * runtime dependencies are the highest-risk ones, and a package can resolve to
 * more than one version across the workspace. Each resolved release must carry
 * the same upstream evidence an exact pin does, so a duplicate resolution such
 * as root `ignore@6.0.2` is reconciled instead of being described by the sdk's
 * `ignore@7.0.5` alone.
 *
 * Fail-closed in both directions: a declared range with NO lockfile resolution
 * is a finding (the lockfile no longer describes the manifests), and so is a
 * resolved release with no provenance entry.
 */
export function reconcileResolvedDependencies(
  dependencies: readonly ResolvedDependency[],
  lockIntegrities: ReadonlyMap<string, string>,
  record: ProvenanceRecord,
): ProvenanceFinding[] {
  const findings: ProvenanceFinding[] = []

  for (const dependency of dependencies) {
    const versions = resolvedVersions(dependency.name, lockIntegrities)
    if (versions.length === 0) {
      findings.push({
        code: 'missing-lock-entry',
        spec: dependency.name,
        message: `declared by ${dependency.manifests.join(', ')} but bun.lock resolves no release for it; run \`bun install\` and commit the lockfile`,
      })
      continue
    }
    for (const version of versions) {
      reconcileRelease(
        {
          spec: `${dependency.name}@${version}`,
          name: dependency.name,
          version,
          manifests: dependency.manifests,
        },
        lockIntegrities,
        record,
        findings,
      )
    }
  }

  return findings
}

/**
 * Every third-party package name any workspace manifest declares, at any
 * specifier. Used to decide whether a record entry is stale: a range-declared
 * package still has a resolved release behind it, so its provenance is not
 * orphaned.
 */
function declaredPackageNames(root: string): Set<string> {
  const names = new Set<string>()
  for (const directory of expandWorkspaceDirectories(root)) {
    const manifestPath = join(directory, 'package.json')
    if (!existsSync(manifestPath)) continue
    const manifest = readJson(manifestPath) as
      | Record<string, unknown>
      | undefined
    if (!manifest) continue
    for (const field of DEPENDENCY_FIELDS) {
      const dependencies = manifest[field]
      if (!dependencies || typeof dependencies !== 'object') continue
      for (const name of Object.keys(
        dependencies as Record<string, unknown>,
      )) {
        if (
          INTERNAL_PACKAGE_PREFIXES.some((prefix) => name.startsWith(prefix))
        ) {
          continue
        }
        names.add(name)
      }
    }
  }
  return names
}

/**
 * Every dependency release the gate reconciles, read from the workspace: the
 * exact pins plus each range-declared dependency at the release(s) bun.lock
 * resolved for it.
 *
 * This and `refreshProvenance` walk the SAME scope helper, so the record can
 * never be refreshed narrower than the gate reconciles. An exact pin is in
 * scope whether or not the lockfile resolved it: keeping an unresolved pin in
 * the scope is what makes `reconcileRelease` report `missing-lock-entry`
 * instead of a manifest pin and a silent lockfile disagreeing past a green run.
 * The lockfile scan behind it keys on each resolution tuple's `name@version`
 * body rather than on the enclosing key, so a resolution stored under a bare
 * workspace name (`"typescript": ["typescript@5.5.4", ...]`) and one stored
 * under a nested path are both found.
 */
export function collectReconciledDependencies(
  root: string,
  lockIntegrities: ReadonlyMap<string, string>,
): PinnedDependency[] {
  return withLockfileResolution(
    collectExactPins(root),
    lockIntegrities,
    collectResolvedDependencies(root),
  )
}

/**
 * The reconciliation scope as a pure function of already-collected inputs: the
 * pins themselves, plus every range-declared dependency at the release(s) the
 * lockfile resolved for it.
 *
 * Split out of `collectReconciledDependencies` so the scope can be built from a
 * fixture pin list in tests as well as from the filesystem, and so "in scope"
 * has exactly one definition. The gate uses it in BOTH directions —
 * `checkProvenance` demands upstream evidence for exactly these releases, and
 * `refreshProvenance` fetches evidence for exactly these releases — which is
 * what keeps a refreshed record from being narrower than the assertion that
 * consumes it, and an assertion from silently skipping a declared pin.
 */
export function withLockfileResolution(
  pins: readonly PinnedDependency[],
  lockIntegrities: ReadonlyMap<string, string>,
  resolvedDependencies: readonly ResolvedDependency[],
): PinnedDependency[] {
  const bySpec = new Map<string, PinnedDependency>()
  const add = (dependency: PinnedDependency) => {
    const existing = bySpec.get(dependency.spec)
    if (!existing) {
      bySpec.set(dependency.spec, {
        ...dependency,
        manifests: [...dependency.manifests],
      })
      return
    }
    for (const manifest of dependency.manifests) {
      if (!existing.manifests.includes(manifest)) {
        existing.manifests.push(manifest)
      }
    }
  }
  for (const pin of pins) add(pin)
  for (const dependency of resolvedDependencies) {
    for (const version of resolvedVersions(dependency.name, lockIntegrities)) {
      add({
        spec: `${dependency.name}@${version}`,
        name: dependency.name,
        version,
        manifests: dependency.manifests,
      })
    }
  }
  return [...bySpec.values()].sort((left, right) =>
    left.spec < right.spec ? -1 : left.spec > right.spec ? 1 : 0,
  )
}

/**
 * Read the lockfile, the manifests, and the record, and reconcile them.
 *
 * Scope is the UNION of the exact pins and every range-declared dependency's
 * lockfile-resolved releases, so `pins` is the full set of `name@version`
 * identities the gate reconciled: exact pins stay the fail-closed default, and
 * no declared runtime dependency drops out of the record just because its
 * manifest specifier is a range.
 *
 * That union is BOTH the asserted scope and the reported one: `reconcileRelease`
 * is handed every entry in `pins`, so an exact pin bun.lock never resolved fails
 * as `missing-lock-entry` instead of passing unreported. `refreshProvenance`
 * walks the same helper, so the record always covers what the gate demands.
 */
export function checkProvenance(root: string = projectRoot()): {
  pins: PinnedDependency[]
  findings: ProvenanceFinding[]
} {
  const exactPins = collectExactPins(root)
  const resolvedDependencies = collectResolvedDependencies(root)
  const lockPath = join(root, 'bun.lock')
  const lockIntegrities = parseLockIntegrities(
    existsSync(lockPath) ? readFileSync(lockPath, 'utf8') : '',
  )
  // One definition of "in scope" for the whole gate: exact pins (resolved or
  // not) plus every range-declared dependency at its lockfile release(s).
  const pins = withLockfileResolution(
    exactPins,
    lockIntegrities,
    resolvedDependencies,
  )
  const record = readProvenanceRecord(root)
  if (!record) {
    return {
      pins,
      findings: [
        {
          code: 'missing-provenance',
          spec: '',
          message: `no provenance record at ${PROVENANCE_RECORD_PATH}; create it with \`bun run scripts/dependency-provenance-guard.ts --refresh\``,
        },
      ],
    }
  }
  return {
    pins,
    findings: [
      // Every release in scope is reconciled through the same assertion, so a
      // dev pin the lockfile never resolved cannot slip past unreported.
      ...reconcileProvenance(
        pins,
        lockIntegrities,
        record,
        declaredPackageNames(root),
      ),
      ...reconcileResolvedDependencies(
        resolvedDependencies,
        lockIntegrities,
        record,
      ),
      // Deprecation is asserted for EVERY release in scope, independent of
      // whether the release reconciled above: a deprecated release that is not
      // in `pins` at all (a transitive resolution outside the reconciled union)
      // still fails until a `DEPRECATION_EXCEPTIONS` entry accepts it.
      ...reconcileDeprecations(pins, record),
    ],
  }
}

/**
 * Reconcile upstream DEPRECATION across the whole reconciled scope.
 *
 * `reconcileRelease` already reports a deprecated release it reconciles, but
 * that pass only sees `pins`. This one walks the record for every in-scope
 * spec, so a deprecated release cannot become green by falling outside the
 * union: it is either accepted by a reviewed `DEPRECATION_EXCEPTIONS` entry or
 * it is a `unreviewed-deprecation` finding. One finding per spec, so a release
 * reachable through two rules is reported once.
 */
export function reconcileDeprecations(
  pins: readonly PinnedDependency[],
  record: ProvenanceRecord,
): ProvenanceFinding[] {
  const findings: ProvenanceFinding[] = []
  const reported = new Set<string>()
  for (const pin of pins) {
    const entry = record.packages[pin.spec]
    if (!entry || reported.has(pin.spec)) continue
    const before = findings.length
    assertDeprecationAccepted(entry, pin.spec, findings)
    if (findings.length > before) reported.add(pin.spec)
  }
  return findings
}

/**
 * The deprecated releases the record knows about, sorted.
 *
 * Deprecation is NOT informational: `checkProvenance` reports an in-scope
 * deprecated release with no `DEPRECATION_EXCEPTIONS` entry as
 * `unreviewed-deprecation` and fails. This helper names the accepted subset for
 * reviewers (`--refresh` prints it), so the accepted decisions stay visible
 * without a green run being reachable for an unreviewed one.
 */
export function deprecatedReleases(record: ProvenanceRecord): string[] {
  return Object.entries(record.packages)
    .filter(([, entry]) => entry.deprecated)
    .map(([spec]) => spec)
    .sort()
}

/**
 * Format the findings for a terminal.
 */
export function formatProvenanceFindings(
  findings: readonly ProvenanceFinding[],
): string {
  if (findings.length === 0) {
    return 'Dependency provenance guard passed: every declared dependency reconciles with the checked-in upstream provenance record.'
  }
  return [
    'Dependency provenance guard failed:',
    ...findings.map((finding) =>
      finding.spec
        ? `  - [${finding.code}] ${finding.spec}: ${finding.message}`
        : `  - [${finding.code}] ${finding.message}`,
    ),
  ].join('\n')
}

/**
 * Fetch the upstream provenance for one release. Exported so the refresh path
 * can be exercised without a network in tests.
 */
export async function fetchProvenance(
  name: string,
  version: string,
): Promise<ProvenanceEntry> {
  const url = `${REGISTRY_ORIGIN}/${name}/${version}`
  const response = await fetch(url, {
    signal: AbortSignal.timeout(15_000),
  })
  if (!response.ok) {
    throw new Error(`${url} responded ${response.status}`)
  }
  const body = (await response.json()) as {
    version?: string
    license?: unknown
    deprecated?: unknown
    dist?: { integrity?: string; tarball?: string }
  }
  if (body.version !== version) {
    throw new Error(
      `${url} returned version ${String(body.version)}, expected ${version}`,
    )
  }
  const integrity = body.dist?.integrity
  if (!integrity) {
    throw new Error(`${url} published no dist.integrity`)
  }
  // A release with no registry license is recorded as `UNKNOWN`, which the
  // license allowlist then reports as `disallowed-license`: coercion keeps the
  // record schema total, and the gate (not this fetch) is what fails closed.
  //
  // A published identifier is recorded in its ALLOWLISTED spelling when it
  // differs only by case (`UNLICENSE` -> `Unlicense`), so the record agrees
  // with the allowlist that judges it instead of reading as a pending license
  // objection for a release this repository keeps.
  const license =
    typeof body.license === 'string'
      ? normalizeLicense(body.license)
      : 'UNKNOWN'
  return {
    integrity,
    license,
    tarball: body.dist?.tarball ?? canonicalTarball(name, version),
    deprecated: Boolean(body.deprecated),
  }
}

/**
 * Build a fresh provenance record from the registry for every release in the
 * reconciliation scope.
 *
 * A pin whose fetch fails fails the WHOLE refresh: the record is either a
 * complete, mutually consistent snapshot of every in-scope release or it is not
 * written at all. Publishing a partial record would leave the checked-in file
 * describing a pin set that no longer matches the manifests, which the offline
 * gate then rejects — and the diff would look like a legitimate refresh.
 *
 * The scope is `collectReconciledDependencies`, the same helper the offline
 * gate demands evidence for, so a release the gate asserts is always a release
 * this refresh records — including an exact dev pin whose only lockfile entry
 * lives under a nested resolution path.
 *
 * Fetches run with bounded concurrency rather than serially, so a repo with
 * dozens of pins does not spend its whole refresh waiting on registry
 * round-trips one at a time.
 *
 * The refresh REFUSES to run when the effective registry (`npm_config_registry`)
 * is not `REGISTRY_ORIGIN`: the record it would write names the mirror as its
 * source while the offline gate derives every tarball comparison from the public
 * registry, so the two would disagree and the committed diff would look like a
 * legitimate refresh. Detecting the mismatch here is what makes the guard's
 * origin assertion actionable instead of a caveat.
 */
export async function refreshProvenance(
  root: string = projectRoot(),
): Promise<ProvenanceRecord> {
  // Walk the SAME scope the offline gate reconciles — the scope helper, not a
  // hand-rolled union — so a refreshed record can never be narrower than what
  // the gate demands (a narrower refresh would write a record the gate
  // immediately rejects, and a narrower GATE would let a pin pass unreconciled).
  const lockPath = join(root, 'bun.lock')
  const lockIntegrities = parseLockIntegrities(
    existsSync(lockPath) ? readFileSync(lockPath, 'utf8') : '',
  )
  // Refuse BEFORE the first fetch: writing a record sourced from a mirror would
  // make the offline gate's origin assertion fail on a file whose diff looks
  // like a legitimate refresh.
  const originMismatch = registryOriginMismatch()
  if (originMismatch) throw new Error(originMismatch)
  const pins = collectReconciledDependencies(root, lockIntegrities)
  // Fetched by SPEC, deduplicated. `collectReconciledDependencies` already keys
  // its map by spec, but the scope is a union of exact pins and lockfile-resolved
  // range releases, so the same `name@version` can be reached through more than
  // one logical rule. Deduplicating here as well keeps the fetch list and the
  // write single-writer even if the scope builder ever changes shape. Scheduling the raw pin list would then let two workers
  // fetch the same immutable document concurrently — the effective in-flight
  // request count would exceed REFRESH_FETCH_CONCURRENCY, and a failure on the
  // duplicate would reject the whole all-or-nothing refresh for no reason. This
  // also makes the `packages[spec]` write single-writer, so "a complete snapshot
  // or nothing" no longer depends on batch ordering.
  const specs = [...new Set(pins.map((pin) => pin.spec))]
  const pinsBySpec = new Map(pins.map((pin) => [pin.spec, pin]))
  const packages: Record<string, ProvenanceEntry> = {}
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < specs.length) {
      const spec = specs[next]
      next += 1
      const pin = pinsBySpec.get(spec)!
      const entry = await fetchProvenance(pin.name, pin.version)
      packages[pin.spec] = entry
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(REFRESH_FETCH_CONCURRENCY, specs.length) },
      () => worker()),
  )
  // Belt and braces: every reconciled release must be present, even if
  // `collectReconciledDependencies` and the fetch loop ever disagree about the
  // list they walked.
  for (const pin of pins) {
    if (!packages[pin.spec]) {
      throw new Error(`no provenance fetched for ${pin.spec}`)
    }
  }
  return {
    source: REGISTRY_ORIGIN,
    verifiedAt: new Date().toISOString(),
    packages,
  }
}

/**
 * The registry a refresh would actually read from: `npm_config_registry` when it
 * is set, otherwise bun's default registry configuration. `bun install` resolves
 * through this same setting, so a refresh must refuse to write a record when it
 * names an origin other than `REGISTRY_ORIGIN` — otherwise the record pins the
 * mirror's identity while the offline gate measures every tarball against the
 * public registry, and nothing would notice the two were sourced differently.
 */
export function effectiveRegistryOrigin(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const raw = env.npm_config_registry?.trim()
  if (!raw) return REGISTRY_ORIGIN
  return raw.replace(/\/+$/, '')
}

/**
 * The message a refresh must fail with when the effective registry is not the
 * origin the record is written against, or `undefined` when they agree.
 */
export function registryOriginMismatch(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const effective = effectiveRegistryOrigin(env)
  if (effective === REGISTRY_ORIGIN) return undefined
  return `refusing to refresh ${PROVENANCE_RECORD_PATH}: the effective registry (npm_config_registry=${effective}) is not ${REGISTRY_ORIGIN}, so the record would pin a mirror's identity while the gate derives every tarball comparison from ${REGISTRY_ORIGIN}. Unset npm_config_registry, or refresh from a checkout whose origin matches the registry it resolves through.`
}

/**
 * Write the record atomically: build the full text, write it to a sibling temp
 * file, then rename over the tracked path. A refresh killed mid-write therefore
 * leaves either the previous record or the complete new one — never a truncated
 * file that the offline gate and CI both reject.
 */
export function writeProvenanceRecord(
  record: ProvenanceRecord,
  root: string = projectRoot(),
): string {
  const target = join(root, PROVENANCE_RECORD_PATH)
  const temp = `${target}.tmp-${process.pid}`
  const body = `${JSON.stringify(record, null, 2)}\n`
  try {
    writeFileSync(temp, body)
    renameSync(temp, target)
  } catch (error) {
    try {
      if (existsSync(temp)) unlinkSync(temp)
    } catch {
      // Best effort: the original error is the one worth reporting.
    }
    throw error
  }
  return target
}

if (import.meta.main) {
  const root = projectRoot()
  const refresh = process.argv.includes('--refresh')
  try {
    if (refresh) {
      const record = await refreshProvenance(root)
      // Atomic replace: a refresh killed mid-write must never leave a truncated
      // record behind, because the offline gate and CI would then fail on a file
      // whose diff looks like a legitimate refresh.
      writeProvenanceRecord(record, root)
      console.log(
        `Refreshed ${Object.keys(record.packages).length} dependency provenance entries in ${PROVENANCE_RECORD_PATH}.`,
      )
      // Deprecation is a reviewed decision, not a note: name every deprecated
      // release the fresh record carries so the reviewer of this diff can add
      // the `DEPRECATION_EXCEPTIONS` entry (or drop the release) that the
      // offline gate will otherwise demand.
      const deprecated = deprecatedReleases(record)
      if (deprecated.length > 0) {
        console.log(
          `Review: ${deprecated.length} refreshed release(s) are deprecated upstream and need a DEPRECATION_EXCEPTIONS entry to pass the gate: ${deprecated.join(', ')}`,
        )
      }
      process.exit(0)
    }

    const { pins, findings } = checkProvenance(root)
    // An unreviewed deprecated release is a finding (`unreviewed-deprecation`),
    // so a green run below means every deprecated release in scope is covered
    // by a reviewed DEPRECATION_EXCEPTIONS entry. The accepted decisions are
    // still printed, so an audit can see them without reading the map.
    if (findings.length > 0) {
      console.error(formatProvenanceFindings(findings))
      process.exit(1)
    }
    const record = readProvenanceRecord(root)
    const deprecated = record ? deprecatedReleases(record) : []
    console.log(
      `Dependency provenance guard passed: ${pins.length} dependency releases reconcile with the checked-in upstream provenance record.`,
    )
    if (deprecated.length > 0) {
      console.log(
        `Accepted deprecations (DEPRECATION_EXCEPTIONS): ${deprecated.join(', ')}`,
      )
    }
  } catch (error) {
    console.error(
      error instanceof Error ? error.message : String(error),
    )
    process.exit(1)
  }
}
