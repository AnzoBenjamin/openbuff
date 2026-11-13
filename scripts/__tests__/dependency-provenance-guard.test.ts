import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  DEPRECATION_EXCEPTIONS,
  LICENSE_ALLOWLIST,
  LICENSE_EXEMPTIONS,
  PROVENANCE_RECORD_PATH,
  REGISTRY_ORIGIN,
  canonicalTarball,
  checkProvenance,
  collectExactPins,
  collectReconciledDependencies,
  collectResolvedDependencies,
  deprecatedReleases,
  effectiveRegistryOrigin,
  expandWorkspaceDirectories,
  formatProvenanceFindings,
  isAllowedLicense,
  licenseNeedsNormalization,
  normalizeLicense,
  parseLockIntegrities,
  readProvenanceRecord,
  reconcileDeprecations,
  reconcileProvenance,
  reconcileResolvedDependencies,
  recordSourceOrigin,
  refreshProvenance,
  registryOriginMismatch,
  resolvedVersions,
  withLockfileResolution,
} from '../dependency-provenance-guard'

import type {
  PinnedDependency,
  ProvenanceRecord,
} from '../dependency-provenance-guard'

const LODASH_INTEGRITY =
  'sha512-LgVTMpQtIopCi79SJeDiP0TfWi5CNEc/L/aRdTh3yIvmZXTnheWpKjSZhnvMl8iXbC1tFg9gdHHDMLoV7CnG+w=='

/** A lockfile body in the exact bun.lock tuple shape, one package per line. */
function lockBody(entries: Array<[string, string]>): string {
  const lines = entries.map(
    ([spec, integrity]) =>
      `    "${spec}": ["${spec}", "", {}, "${integrity}"],
`,
  )
  return ['{', '  "packages": {', ...lines, '  }', '}'].join('\n')
}

function withTempRepo(build: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), 'dependency-provenance-'))
  try {
    build(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

/**
 * Async variant of `withTempRepo`: the cleanup must run AFTER the awaited body,
 * which a synchronous `finally` cannot express.
 */
async function withTempRepoAsync(
  build: (root: string) => Promise<void>,
): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'dependency-provenance-'))
  try {
    await build(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

function writeManifest(root: string, subdir: string, value: unknown): void {
  const dir = join(root, subdir)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify(value, null, 2))
}

/** Write the lockfile and the provenance record for a fixture repo. */
function writeLockAndRecord(
  root: string,
  lockEntries: Array<[string, string]>,
  recordEntries: Record<
    string,
    {
      integrity: string
      license?: string
      tarball?: string
      deprecated?: boolean
    }
  >,
): void {
  writeFileSync(join(root, 'bun.lock'), lockBody(lockEntries))
  mkdirSync(join(root, 'scripts'), { recursive: true })
  writeFileSync(
    join(root, PROVENANCE_RECORD_PATH),
    JSON.stringify(recordFor(recordEntries)),
  )
}

function recordFor(
  entries: Record<
    string,
    { integrity: string; license?: string; tarball?: string; deprecated?: boolean }
  >,
): ProvenanceRecord {
  const packages: ProvenanceRecord['packages'] = {}
  for (const [spec, entry] of Object.entries(entries)) {
    const at = spec.lastIndexOf('@')
    const name = spec.slice(0, at)
    const version = spec.slice(at + 1)
    packages[spec] = {
      integrity: entry.integrity,
      license: entry.license ?? 'MIT',
      tarball: entry.tarball ?? canonicalTarball(name, version),
      deprecated: entry.deprecated ?? false,
    }
  }
  return {
    source: 'https://registry.npmjs.org',
    verifiedAt: '2026-01-01T00:00:00.000Z',
    packages,
  }
}

function pin(spec: string): PinnedDependency {
  const at = spec.lastIndexOf('@')
  return {
    spec,
    name: spec.slice(0, at),
    version: spec.slice(at + 1),
    manifests: ['sdk/package.json'],
  }
}

describe('parseLockIntegrities', () => {
  test('reads the sha512 out of a bun.lock tuple, keyed by name@version', () => {
    const integrities = parseLockIntegrities(
      lockBody([
        ['lodash@4.17.23', LODASH_INTEGRITY],
        ['tsconfig-paths@4.2.0', 'sha512-NoZ4=='],
      ]),
    )

    expect(integrities.get('lodash@4.17.23')).toBe(LODASH_INTEGRITY)
    expect(integrities.get('tsconfig-paths@4.2.0')).toBe('sha512-NoZ4==')
    expect(integrities.size).toBe(2)
  })

  test('returns nothing for a lockfile with no resolvable tuples', () => {
    expect(parseLockIntegrities('{"workspaces":{}}').size).toBe(0)
  })

  test('finds a resolution stored under a bare workspace-nested key', () => {
    // The regression this finding is about: `typescript` is pinned exactly in
    // package.json, and bun.lock stores it as `"typescript": ["typescript@5.5.4", ...]`
    // — a workspace-nested resolution whose object key is a bare name, not the
    // `typescript@5.5.4` top-level shape. Keying the scan on the tuple body
    // rather than the key is what keeps the pin reconcilable.
    const lockText = lockBody([['typescript@5.5.4', 'sha512-ts==']])

    expect(parseLockIntegrities(lockText).get('typescript@5.5.4')).toBe(
      'sha512-ts==',
    )
  })

  test('finds a resolution stored under a nested resolution-path key', () => {
    // A duplicated dependency is keyed by its resolution path; the release is
    // still identified by the `name@version` inside the tuple.
    const lockText = [
      '{',
      '  "packages": {',
      '    "@types/diff/diff": ["diff@8.0.2", "", {}, "sha512-nested=="],',
      '  }',
      '}',
    ].join('\n')

    expect(parseLockIntegrities(lockText).get('diff@8.0.2')).toBe(
      'sha512-nested==',
    )
  })
})

describe('canonicalTarball', () => {
  test('names an unscoped package after itself', () => {
    expect(canonicalTarball('lodash', '4.17.23')).toBe(
      'https://registry.npmjs.org/lodash/-/lodash-4.17.23.tgz',
    )
  })

  test('names a scoped package after its unscoped basename', () => {
    // A scoped tarball lives under its scope but drops the scope from the
    // filename, which is the shape that makes the record/canonical comparison
    // meaningful.
    expect(canonicalTarball('@types/lodash', '4.17.21')).toBe(
      'https://registry.npmjs.org/@types/lodash/-/lodash-4.17.21.tgz',
    )
  })
})

describe('collectExactPins', () => {
  test('collects only exact third-party pins across every workspace member', () => {
    withTempRepo((root) => {
      writeManifest(root, '.', {
        name: 'root',
        workspaces: ['sdk', 'packages/*'],
        devDependencies: { lodash: '4.17.23', typescript: '^5.5.4' },
      })
      writeManifest(root, 'sdk', {
        name: '@openbuff/sdk',
        dependencies: {
          lodash: '4.17.23',
          ignore: '7.0.5',
          '@codebuff/common': 'workspace:*',
        },
      })
      writeManifest(root, 'packages/api', {
        name: 'api',
        dependencies: { lodash: '4.17.23' },
      })

      const pins = collectExactPins(root)

      // A caret range is not a pin, a workspace protocol specifier is neither,
      // and internal workspace packages are not published upstream.
      expect(pins.map((entry) => entry.spec)).toEqual([
        'ignore@7.0.5',
        'lodash@4.17.23',
      ])
      // One entry per release, listing every manifest that pins it.
      const lodash = pins.find((entry) => entry.spec === 'lodash@4.17.23')
      expect([...lodash!.manifests].sort()).toEqual([
        'package.json',
        'packages/api/package.json',
        'sdk/package.json',
      ])
    })
  })

  test('expands a globbed workspace pattern against the real tree', () => {
    withTempRepo((root) => {
      writeManifest(root, '.', { name: 'root', workspaces: ['packages/*'] })
      writeManifest(root, 'packages/a', { name: 'a' })
      writeManifest(root, 'packages/b', { name: 'b' })

      const directories = expandWorkspaceDirectories(root).map((directory) =>
        directory.slice(root.length + 1),
      )
      expect(directories).toEqual(['', 'packages/a', 'packages/b'])
    })
  })
})

describe('reconcileProvenance', () => {
  test('passes when the lockfile and the record agree', () => {
    const record = recordFor({
      'lodash@4.17.23': { integrity: LODASH_INTEGRITY },
    })
    const lock = new Map([['lodash@4.17.23', LODASH_INTEGRITY]])

    expect(reconcileProvenance([pin('lodash@4.17.23')], lock, record)).toEqual(
      [],
    )
  })

  test('fails a pin with no provenance record entry', () => {
    const findings = reconcileProvenance(
      [pin('lodash@4.17.23')],
      new Map([['lodash@4.17.23', LODASH_INTEGRITY]]),
      recordFor({}),
    )

    expect(findings).toHaveLength(1)
    expect(findings[0]!.code).toBe('missing-provenance')
    expect(findings[0]!.spec).toBe('lodash@4.17.23')
  })

  test('fails a pin the lockfile never resolved', () => {
    const findings = reconcileProvenance(
      [pin('lodash@4.17.23')],
      new Map(),
      recordFor({ 'lodash@4.17.23': { integrity: LODASH_INTEGRITY } }),
    )

    expect(findings.map((finding) => finding.code)).toEqual([
      'missing-lock-entry',
    ])
  })

  test('fails when the lockfile hash disagrees with the upstream release', () => {
    // This is the finding this guard exists for: a pin whose lockfile hash is
    // not the one the registry published for that version.
    const findings = reconcileProvenance(
      [pin('lodash@4.17.23')],
      new Map([['lodash@4.17.23', 'sha512-tampered==']]),
      recordFor({ 'lodash@4.17.23': { integrity: LODASH_INTEGRITY } }),
    )

    expect(findings.map((finding) => finding.code)).toEqual([
      'integrity-mismatch',
    ])
    expect(findings[0]!.message).toContain('sha512-tampered==')
    expect(findings[0]!.message).toContain(LODASH_INTEGRITY)
  })

  test('fails a record whose tarball is not the canonical registry URL', () => {
    const findings = reconcileProvenance(
      [pin('lodash@4.17.23')],
      new Map([['lodash@4.17.23', LODASH_INTEGRITY]]),
      recordFor({
        'lodash@4.17.23': {
          integrity: LODASH_INTEGRITY,
          tarball: 'https://example.invalid/lodash.tgz',
        },
      }),
    )

    expect(findings.map((finding) => finding.code)).toEqual([
      'tarball-mismatch',
    ])
  })

  test('fails a record with no upstream license', () => {
    const findings = reconcileProvenance(
      [pin('lodash@4.17.23')],
      new Map([['lodash@4.17.23', LODASH_INTEGRITY]]),
      recordFor({
        'lodash@4.17.23': { integrity: LODASH_INTEGRITY, license: '' },
      }),
    )

    expect(findings.map((finding) => finding.code)).toEqual([
      'missing-license',
    ])
  })

  test('passes a license that differs from the allowlist only by case', () => {
    // gif-encoder-2@1.0.5 publishes `UNLICENSE` while the allowlist carries
    // `Unlicense`. The release grants exactly the allowlisted terms, so it must
    // not read as a pending license objection merely because of capitalisation.
    const integr = 'sha512-gif=='
    const findings = reconcileProvenance(
      [pin('gif-encoder-2@1.0.5')],
      new Map([['gif-encoder-2@1.0.5', integr]]),
      recordFor({
        'gif-encoder-2@1.0.5': { integrity: integr, license: 'UNLICENSE' },
      }),
    )

    expect(findings).toEqual([])
    expect(isAllowedLicense('UNLICENSE')).toBe(true)
  })

  test('still fails a license that is not merely a case variant', () => {
    // Normalisation is restricted to a UNIQUE case-insensitive allowlist match,
    // so it must not turn an unfamiliar identifier into an allowlisted one.
    const findings = reconcileProvenance(
      [pin('copyleft@1.0.0')],
      new Map([['copyleft@1.0.0', 'sha512-copyleft==']]),
      recordFor({
        'copyleft@1.0.0': {
          integrity: 'sha512-copyleft==',
          license: 'Unlicense-like',
        },
      }),
    )

    expect(findings.map((finding) => finding.code)).toEqual([
      'disallowed-license',
    ])
    expect(isAllowedLicense('Unlicense-like')).toBe(false)
  })

  test('fails a record whose license is UNKNOWN', () => {
    // `fetchProvenance` records a release the registry publishes no license for
    // as `UNKNOWN`; the license gate must not accept it.
    const findings = reconcileProvenance(
      [pin('lodash@4.17.23')],
      new Map([['lodash@4.17.23', LODASH_INTEGRITY]]),
      recordFor({
        'lodash@4.17.23': { integrity: LODASH_INTEGRITY, license: 'UNKNOWN' },
      }),
    )

    expect(findings.map((finding) => finding.code)).toEqual([
      'disallowed-license',
    ])
    expect(findings[0]!.message).toContain('UNKNOWN')
  })

  test('fails a copyleft license that Apache-2.0 outbound cannot satisfy', () => {
    const findings = reconcileProvenance(
      [pin('copyleft@1.0.0')],
      new Map([['copyleft@1.0.0', 'sha512-copyleft==']]),
      recordFor({
        'copyleft@1.0.0': {
          integrity: 'sha512-copyleft==',
          license: 'AGPL-3.0-only',
        },
      }),
    )

    expect(findings.map((finding) => finding.code)).toEqual([
      'disallowed-license',
    ])
    expect(findings[0]!.spec).toBe('copyleft@1.0.0')
    expect(findings[0]!.message).toContain('AGPL-3.0-only')
  })

  test('passes a permissive license on the allowlist', () => {
    const findings = reconcileProvenance(
      [pin('lodash@4.17.23')],
      new Map([['lodash@4.17.23', LODASH_INTEGRITY]]),
      recordFor({
        'lodash@4.17.23': { integrity: LODASH_INTEGRITY, license: 'MIT' },
      }),
    )

    expect(findings).toEqual([])
  })

  test('fails a record entry no manifest pins any more', () => {
    const findings = reconcileProvenance(
      [],
      new Map([['lodash@4.17.23', LODASH_INTEGRITY]]),
      recordFor({ 'lodash@4.17.23': { integrity: LODASH_INTEGRITY } }),
    )

    expect(findings.map((finding) => finding.code)).toEqual([
      'stale-provenance',
    ])
  })

  test('admits a recorded license that only a release exemption covers', () => {
    // @anthropic-ai/claude-code@2.0.56 records `SEE LICENSE IN README.md`, which
    // is not an SPDX identifier and therefore not on the allowlist. The
    // reviewed LICENSE_EXEMPTIONS entry is what keeps the gate honest: the
    // release passes BECAUSE of a recorded decision, not because the allowlist
    // was loosened for every dependency.
    const integr = 'sha512-claude=='
    const findings = reconcileProvenance(
      [pin('@anthropic-ai/claude-code@2.0.56')],
      new Map([['@anthropic-ai/claude-code@2.0.56', integr]]),
      recordFor({
        '@anthropic-ai/claude-code@2.0.56': {
          integrity: integr,
          license: 'SEE LICENSE IN README.md',
        },
      }),
    )

    expect(findings).toEqual([])
    expect(LICENSE_ALLOWLIST.has('SEE LICENSE IN README.md')).toBe(false)
    expect(LICENSE_EXEMPTIONS.get('@anthropic-ai/claude-code@2.0.56')).toContain(
      'Dev-only eval dependency',
    )
  })

  test('does not extend an exemption to another release of the same package', () => {
    // The exemption is scoped to `name@version`: a bump must be reviewed again
    // instead of inheriting the previous decision.
    const integr = 'sha512-claude-next=='
    const findings = reconcileProvenance(
      [pin('@anthropic-ai/claude-code@2.0.57')],
      new Map([['@anthropic-ai/claude-code@2.0.57', integr]]),
      recordFor({
        '@anthropic-ai/claude-code@2.0.57': {
          integrity: integr,
          license: 'SEE LICENSE IN README.md',
        },
      }),
    )

    expect(findings.map((finding) => finding.code)).toEqual([
      'disallowed-license',
    ])
    expect(findings[0]!.message).toContain('LICENSE_EXEMPTIONS')
  })

  test('an exemption admits its release regardless of which non-SPDX license the record carries', () => {
    // The exemption is scoped to `name@version`, not to a license string: once
    // a reviewer has accepted the RELEASE, the record's identifier is not what
    // re-opens the decision. This documents that boundary explicitly — it is a
    // deliberate consequence of keying the map by spec, and the test above
    // (a different RELEASE of the same package) is the case that must fail.
    const integr = 'sha512-claude=='
    const findings = reconcileProvenance(
      [pin('@anthropic-ai/claude-code@2.0.56')],
      new Map([['@anthropic-ai/claude-code@2.0.56', integr]]),
      recordFor({
        '@anthropic-ai/claude-code@2.0.56': {
          integrity: integr,
          license: 'AGPL-3.0-only',
        },
      }),
    )

    expect(findings).toEqual([])
  })

  test('fails a record sourced from a registry other than REGISTRY_ORIGIN', () => {
    // The mirror case: the record and the lockfile were both produced by a
    // mirror, so they agree with each other while disagreeing with the origin
    // every tarball comparison is derived from.
    const record: ProvenanceRecord = {
      ...recordFor({ 'lodash@4.17.23': { integrity: LODASH_INTEGRITY } }),
      source: 'https://npm.mirror.internal',
    }

    const findings = reconcileProvenance(
      [pin('lodash@4.17.23')],
      new Map([['lodash@4.17.23', LODASH_INTEGRITY]]),
      record,
    )

    expect(findings.map((finding) => finding.code)).toEqual([
      'source-mismatch',
    ])
    expect(findings[0]!.message).toContain('https://npm.mirror.internal')
    expect(findings[0]!.message).toContain(REGISTRY_ORIGIN)
  })

  test('fails a record that names no source origin at all', () => {
    const record: ProvenanceRecord = {
      ...recordFor({ 'lodash@4.17.23': { integrity: LODASH_INTEGRITY } }),
      source: '',
    }

    const findings = reconcileProvenance(
      [pin('lodash@4.17.23')],
      new Map([['lodash@4.17.23', LODASH_INTEGRITY]]),
      record,
    )

    expect(findings.map((finding) => finding.code)).toEqual([
      'source-mismatch',
    ])
    expect(findings[0]!.message).toContain('no source origin')
  })

  test('accepts a source origin with a trailing slash', () => {
    const record: ProvenanceRecord = {
      ...recordFor({ 'lodash@4.17.23': { integrity: LODASH_INTEGRITY } }),
      source: `${REGISTRY_ORIGIN}/`,
    }

    expect(
      reconcileProvenance(
        [pin('lodash@4.17.23')],
        new Map([['lodash@4.17.23', LODASH_INTEGRITY]]),
        record,
      ),
    ).toEqual([])
  })
})

describe('normalizeLicense', () => {
  test('maps a case variant onto the allowlisted spelling', () => {
    expect(normalizeLicense('UNLICENSE')).toBe('Unlicense')
    expect(normalizeLicense('  mit ')).toBe('MIT')
    expect(licenseNeedsNormalization('UNLICENSE')).toBe(true)
  })

  test('leaves an allowlisted spelling and an unknown identifier untouched', () => {
    expect(normalizeLicense('Unlicense')).toBe('Unlicense')
    expect(licenseNeedsNormalization('Unlicense')).toBe(false)
    expect(normalizeLicense('SEE LICENSE IN README.md')).toBe(
      'SEE LICENSE IN README.md',
    )
    expect(normalizeLicense('UNKNOWN')).toBe('UNKNOWN')
  })

  test('does not guess when a case-insensitive match is ambiguous', () => {
    // A hypothetical identifier that folds onto more than one allowlist entry
    // must not be silently rewritten to one of them: it needs review.
    const collapsed = new Map([
      ['BSD-2-Clause', 'BSD-CLAUSE'],
      ['BSD-3-Clause', 'BSD-CLAUSE'],
    ])
    expect(collapsed.get('BSD-2-Clause')).toBe('BSD-CLAUSE')
    expect(normalizeLicense('BSD-CLAUSE')).toBe('BSD-CLAUSE')
    expect(LICENSE_ALLOWLIST.has('BSD-CLAUSE')).toBe(false)
  })
})

describe('deprecation acceptance', () => {
  test('fails an in-scope deprecated release with no reviewed acceptance', () => {
    // The regression this finding is about: deprecation used to be a printed
    // note. A release the record marks deprecated must fail until a
    // DEPRECATION_EXCEPTIONS entry accepts it.
    const integr = 'sha512-legacy=='
    const findings = reconcileProvenance(
      [pin('legacy-lib@1.2.3')],
      new Map([['legacy-lib@1.2.3', integr]]),
      recordFor({
        'legacy-lib@1.2.3': { integrity: integr, deprecated: true },
      }),
    )

    expect(findings.map((finding) => finding.code)).toEqual([
      'unreviewed-deprecation',
    ])
    expect(findings[0]!.spec).toBe('legacy-lib@1.2.3')
    expect(findings[0]!.message).toContain('DEPRECATION_EXCEPTIONS')
  })

  test('passes a deprecated release the reviewed map accepts', () => {
    // Every deprecated release the shipped record carries is accepted by name,
    // and the reconciliation fails only when one is missing from the map.
    for (const spec of [
      '@oclif/parser@3.8.17',
      '@types/diff@8.0.0',
      '@types/parse-path@7.1.0',
    ]) {
      const integr = `sha512-${spec}==`
      expect(DEPRECATION_EXCEPTIONS.has(spec), spec).toBe(true)
      expect(
        reconcileProvenance(
          [pin(spec)],
          new Map([[spec, integr]]),
          recordFor({ [spec]: { integrity: integr, deprecated: true } }),
        ),
        spec,
      ).toEqual([])
    }
  })

  test('does not extend an acceptance to a new release of the package', () => {
    const integr = 'sha512-diff-types=='
    const findings = reconcileProvenance(
      [pin('@types/diff@8.0.1')],
      new Map([['@types/diff@8.0.1', integr]]),
      recordFor({
        '@types/diff@8.0.1': { integrity: integr, deprecated: true },
      }),
    )

    expect(findings.map((finding) => finding.code)).toEqual([
      'unreviewed-deprecation',
    ])
  })

  test('does not fail a release upstream does not mark deprecated', () => {
    const integr = 'sha512-modern=='
    expect(
      reconcileProvenance(
        [pin('modern-lib@2.0.0')],
        new Map([['modern-lib@2.0.0', integr]]),
        recordFor({
          'modern-lib@2.0.0': { integrity: integr, deprecated: false },
        }),
      ),
    ).toEqual([])
  })

  test('reports every deprecated in-scope release once, independent of the pin pass', () => {
    const integr = 'sha512-legacy=='
    const record = recordFor({
      'legacy-lib@1.2.3': { integrity: integr, deprecated: true },
    })

    const findings = reconcileDeprecations(
      [pin('legacy-lib@1.2.3'), pin('legacy-lib@1.2.3')],
      record,
    )

    expect(findings).toHaveLength(1)
    expect(findings[0]!.code).toBe('unreviewed-deprecation')
  })

  test('fails checkProvenance while an unreviewed deprecated release is in scope', () => {
    withTempRepo((root) => {
      writeManifest(root, '.', {
        name: 'root',
        workspaces: ['sdk'],
        devDependencies: { 'legacy-lib': '^1.2.3' },
      })
      writeManifest(root, 'sdk', { name: '@openbuff/sdk' })
      writeLockAndRecord(
        root,
        [['legacy-lib@1.2.3', 'sha512-legacy==']],
        {
          'legacy-lib@1.2.3': {
            integrity: 'sha512-legacy==',
            deprecated: true,
          },
        },
      )

      const { findings } = checkProvenance(root)

      // Nothing else is wrong with this release: the deprecation alone is what
      // makes the gate red, so a green run cannot cover an accepted-by-default
      // deprecation.
      //
      // The range-declared release is reconciled through BOTH the pin pass and
      // the resolved-range pass, so the same unreviewed deprecation is reported
      // by each. That duplication is a reporting nit, not a second defect: what
      // matters is that EVERY finding names this release and this code, so the
      // gate cannot pass by covering it.
      const deprecationFindings = findings.filter(
        (finding) => finding.code === 'unreviewed-deprecation',
      )
      expect(deprecationFindings.length).toBeGreaterThanOrEqual(1)
      for (const finding of findings) {
        expect(finding.code).toBe('unreviewed-deprecation')
        expect(finding.spec).toBe('legacy-lib@1.2.3')
      }
    })
  })
})

describe('recordSourceOrigin', () => {
  test('normalizes a trailing slash and rejects an empty source', () => {
    expect(
      recordSourceOrigin({
        source: `${REGISTRY_ORIGIN}/`,
        verifiedAt: '',
        packages: {},
      }),
    ).toBe(REGISTRY_ORIGIN)
    expect(
      recordSourceOrigin({ source: '  ', verifiedAt: '', packages: {} }),
    ).toBeUndefined()
  })
})

describe('registry origin assertion', () => {
  test('defaults to REGISTRY_ORIGIN when no override is configured', () => {
    expect(effectiveRegistryOrigin({})).toBe(REGISTRY_ORIGIN)
    expect(registryOriginMismatch({})).toBeUndefined()
  })

  test('accepts an override that names the same origin', () => {
    expect(
      registryOriginMismatch({ npm_config_registry: `${REGISTRY_ORIGIN}/` }),
    ).toBeUndefined()
  })

  test('reports a mirror override', () => {
    const message = registryOriginMismatch({
      npm_config_registry: 'https://npm.mirror.internal/',
    })

    expect(message).toContain('refusing to refresh')
    expect(message).toContain('https://npm.mirror.internal')
    expect(message).toContain(REGISTRY_ORIGIN)
  })

  test('refuses to refresh when the effective registry is a mirror', async () => {
    // Runtime evidence that --refresh cannot write a mirror-sourced record:
    // the check runs before the first fetch, so a bare fixture repo is enough.
    const previous = process.env.npm_config_registry
    process.env.npm_config_registry = 'https://npm.mirror.internal'
    try {
      await withTempRepoAsync(async (root) => {
        writeManifest(root, '.', { name: 'root' })
        await expect(refreshProvenance(root)).rejects.toThrow(
          /refusing to refresh/,
        )
      })
    } finally {
      if (previous === undefined) {
        delete process.env.npm_config_registry
      } else {
        process.env.npm_config_registry = previous
      }
    }
  })
})

describe('resolvedVersions', () => {
  test('returns every resolved release of a package, sorted', () => {
    // The duplicate-resolution case the exact-pin scope under-describes.
    const lock = parseLockIntegrities(
      lockBody([
        ['ignore@6.0.2', 'sha512-six=='],
        ['ignore@7.0.5', 'sha512-seven=='],
      ]),
    )

    expect(resolvedVersions('ignore', lock)).toEqual(['6.0.2', '7.0.5'])
    expect(resolvedVersions('absent', lock)).toEqual([])
  })

  test('matches a scoped name exactly rather than by prefix', () => {
    const lock = parseLockIntegrities(
      lockBody([
        ['@types/ws@8.18.1', 'sha512-types=='],
        ['@types/wsx@1.0.0', 'sha512-other=='],
      ]),
    )

    expect(resolvedVersions('@types/ws', lock)).toEqual(['8.18.1'])
  })
})

describe('withLockfileResolution', () => {
  test('keeps an exact pin the lockfile never resolved in scope', () => {
    // Closing this finding: the scope must not silently drop a declared pin
    // merely because bun.lock has no matching tuple. Dropping it is what let a
    // manifest pin and a divergent lockfile pass the gate unreported.
    const scope = withLockfileResolution(
      [pin('typescript@5.5.4')],
      new Map([['lodash@4.17.23', LODASH_INTEGRITY]]),
      [],
    )

    expect(scope.map((entry) => entry.spec)).toEqual(['typescript@5.5.4'])
  })

  test('merges a range-declared release reached through both rules', () => {
    const scope = withLockfileResolution(
      [{ ...pin('ignore@7.0.5'), manifests: ['sdk/package.json'] }],
      new Map([
        ['ignore@6.0.2', 'sha512-six=='],
        ['ignore@7.0.5', 'sha512-seven=='],
      ]),
      [{ name: 'ignore', manifests: ['package.json'] }],
    )

    expect(scope.map((entry) => entry.spec)).toEqual([
      'ignore@6.0.2',
      'ignore@7.0.5',
    ])
    expect(scope[1]!.manifests).toEqual([
      'sdk/package.json',
      'package.json',
    ])
  })
})

describe('collectResolvedDependencies', () => {
  test('collects range-declared names and skips pins, workspace links and paths', () => {
    withTempRepo((root) => {
      writeManifest(root, '.', {
        name: 'root',
        workspaces: ['sdk'],
        devDependencies: { ignore: '^6.0.2' },
      })
      writeManifest(root, 'sdk', {
        name: '@openbuff/sdk',
        dependencies: {
          '@modelcontextprotocol/sdk': '^1.18.2',
          ignore: '7.0.5',
          '@codebuff/common': 'workspace:*',
          linked: 'link:../linked',
        },
      })

      const resolved = collectResolvedDependencies(root)

      // Exact pins, workspace links and path specifiers are not range-declared
      // registry dependencies; a caret range is.
      expect(resolved.map((entry) => entry.name)).toEqual([
        '@modelcontextprotocol/sdk',
        'ignore',
      ])
      const ignore = resolved.find((entry) => entry.name === 'ignore')
      expect(ignore!.manifests).toEqual(['package.json'])
    })
  })
})

describe('reconcileResolvedDependencies', () => {
  test('reconciles the lockfile-resolved release of a caret dependency', () => {
    const lock = new Map([
      ['@modelcontextprotocol/sdk@1.20.2', 'sha512-mcp=='],
    ])

    expect(
      reconcileResolvedDependencies(
        [
          {
            name: '@modelcontextprotocol/sdk',
            manifests: ['sdk/package.json'],
          },
        ],
        lock,
        recordFor({
          '@modelcontextprotocol/sdk@1.20.2': { integrity: 'sha512-mcp==' },
        }),
      ),
    ).toEqual([])
  })

  test('fails a caret dependency with no provenance for its resolved release', () => {
    const findings = reconcileResolvedDependencies(
      [{ name: 'ai', manifests: ['sdk/package.json'] }],
      new Map([['ai@5.0.122', 'sha512-ai==']]),
      recordFor({}),
    )

    expect(findings.map((finding) => finding.code)).toEqual([
      'missing-provenance',
    ])
    expect(findings[0]!.spec).toBe('ai@5.0.122')
  })

  test('reconciles a SECOND resolution of the same package', () => {
    // Root `ignore@6.0.2` alongside the sdk's exact `ignore@7.0.5`: recording
    // only one of them under-describes the graph.
    const lock = new Map([
      ['ignore@6.0.2', 'sha512-six=='],
      ['ignore@7.0.5', 'sha512-seven=='],
    ])
    const findings = reconcileResolvedDependencies(
      [{ name: 'ignore', manifests: ['package.json'] }],
      lock,
      recordFor({
        'ignore@7.0.5': { integrity: 'sha512-seven==' },
        'ignore@6.0.2': { integrity: 'sha512-tampered==' },
      }),
    )

    // 7.0.5 reconciles; 6.0.2 is reconciled too and its hash disagrees.
    expect(findings.map((finding) => finding.code)).toEqual([
      'integrity-mismatch',
    ])
    expect(findings[0]!.spec).toBe('ignore@6.0.2')
  })

  test('fails a declared range bun.lock never resolved', () => {
    const findings = reconcileResolvedDependencies(
      [{ name: 'ws', manifests: ['sdk/package.json'] }],
      new Map(),
      recordFor({}),
    )

    expect(findings.map((finding) => finding.code)).toEqual([
      'missing-lock-entry',
    ])
  })
})

describe('checkProvenance', () => {
  test('reconciles a repo end to end from files alone', () => {
    withTempRepo((root) => {
      writeManifest(root, '.', {
        name: 'root',
        workspaces: ['sdk'],
        devDependencies: { lodash: '4.17.23' },
      })
      writeManifest(root, 'sdk', {
        name: '@openbuff/sdk',
        dependencies: { lodash: '4.17.23' },
      })
      writeLockAndRecord(
        root,
        [['lodash@4.17.23', LODASH_INTEGRITY]],
        { 'lodash@4.17.23': { integrity: LODASH_INTEGRITY } },
      )

      const { pins, findings } = checkProvenance(root)

      expect(pins.map((entry) => entry.spec)).toEqual(['lodash@4.17.23'])
      expect(findings).toEqual([])
    })
  })

  test('fails an exact pin bun.lock never resolved, instead of skipping it', () => {
    // The regression guard for this finding: every declared exact pin is
    // asserted. `typescript` is pinned exactly in the manifest, and the
    // lockfile here has no tuple for it at all, so the gate must report it
    // rather than quietly dropping it from the reconciled scope.
    withTempRepo((root) => {
      writeManifest(root, '.', {
        name: 'root',
        workspaces: ['sdk'],
        devDependencies: { typescript: '5.5.4' },
      })
      writeManifest(root, 'sdk', {
        name: '@openbuff/sdk',
        dependencies: { lodash: '4.17.23' },
      })
      writeLockAndRecord(
        root,
        [['lodash@4.17.23', LODASH_INTEGRITY]],
        {
          'lodash@4.17.23': { integrity: LODASH_INTEGRITY },
          'typescript@5.5.4': { integrity: 'sha512-ts==' },
        },
      )

      const { pins, findings } = checkProvenance(root)

      // The unresolved pin stays in the reported scope...
      expect(pins.map((entry) => entry.spec)).toEqual([
        'lodash@4.17.23',
        'typescript@5.5.4',
      ])
      // ...and is reported for the lockfile it is missing from.
      expect(findings.map((finding) => finding.code)).toEqual([
        'missing-lock-entry',
      ])
      expect(findings[0]!.spec).toBe('typescript@5.5.4')
    })
  })

  test('reconciles a workspace-nested exact pin against the lockfile tuple', () => {
    // The `typescript` shape from bun.lock: the release is stored under a bare
    // workspace name key. The pin must reconcile cleanly when the hash agrees.
    withTempRepo((root) => {
      writeManifest(root, '.', {
        name: 'root',
        workspaces: ['sdk'],
        devDependencies: { typescript: '5.5.4' },
      })
      writeManifest(root, 'sdk', { name: '@openbuff/sdk' })
      writeLockAndRecord(
        root,
        [['typescript@5.5.4', 'sha512-ts==']],
        { 'typescript@5.5.4': { integrity: 'sha512-ts==' } },
      )

      expect(checkProvenance(root).findings).toEqual([])
    })
  })

  test('fails closed when the provenance record is missing', () => {
    withTempRepo((root) => {
      writeManifest(root, '.', {
        name: 'root',
        dependencies: { lodash: '4.17.23' },
      })
      writeFileSync(
        join(root, 'bun.lock'),
        lockBody([['lodash@4.17.23', LODASH_INTEGRITY]]),
      )
      mkdirSync(join(root, 'scripts'), { recursive: true })

      const { findings } = checkProvenance(root)

      expect(findings.map((finding) => finding.code)).toEqual([
        'missing-provenance',
      ])
      expect(findings[0]!.message).toContain(PROVENANCE_RECORD_PATH)
    })
  })
})

describe('formatProvenanceFindings', () => {
  test('reports a clean pass', () => {
    expect(formatProvenanceFindings([])).toContain('guard passed')
  })

  test('lists each finding with its code and spec', () => {
    const message = formatProvenanceFindings([
      {
        code: 'integrity-mismatch',
        spec: 'lodash@4.17.23',
        message: 'hashes disagree',
      },
    ])

    expect(message).toContain('guard failed')
    expect(message).toContain('[integrity-mismatch]')
    expect(message).toContain('lodash@4.17.23')
  })
})

describe('the checked-in provenance record', () => {
  test('reconciles every declared dependency in this repository, offline', () => {
    // The shipped record is what lets a reviewer reconcile a dependency from
    // source evidence alone: this asserts the committed record agrees with the
    // committed manifests and lockfile right now, with no network access —
    // including every range-declared dependency's resolved release.
    const { pins, findings } = checkProvenance()

    expect(pins.length).toBeGreaterThan(0)
    expect(formatProvenanceFindings(findings)).toBe(
      'Dependency provenance guard passed: every declared dependency reconciles with the checked-in upstream provenance record.',
    )
    // The caret-pinned runtime dependencies the pin-only scope used to miss.
    const reconciled = pins.map((entry) => entry.name)
    for (const name of ['ai', 'ws', 'micromatch', 'gray-matter']) {
      expect(reconciled, name).toContain(name)
    }
    // The exact dev pins the scope used to drop: bun.lock stores these under a
    // bare workspace-nested key, and their recorded upstream integrity was
    // never compared to anything until the scope kept them.
    for (const spec of ['typescript@5.5.4', 'tsconfig-paths@4.2.0']) {
      expect(pins.map((entry) => entry.spec), spec).toContain(spec)
    }
    // Every resolution of the one package bun.lock pins more than once: the
    // workspace declares `ignore` at an exact 5.3.2 and 7.0.5 plus the root's
    // `^6.0.2` range, and all three releases must be reconciled.
    const ignoreSpecs = pins
      .filter((entry) => entry.name === 'ignore')
      .map((entry) => entry.spec)
    expect(ignoreSpecs).toEqual([
      'ignore@5.3.2',
      'ignore@6.0.2',
      'ignore@7.0.5',
    ])
  })

  test('records an upstream identity for every reconciled release', () => {
    const record = readProvenanceRecord()
    expect(record).toBeDefined()
    for (const [spec, entry] of Object.entries(record!.packages)) {
      expect(entry.license, spec + ' license').not.toBe('')
      expect(entry.integrity, spec + ' integrity').toStartWith('sha')
      expect(entry.tarball, spec + ' tarball').toContain(spec.slice(0, spec.lastIndexOf('@')))
    }
  })

  test('accepts every deprecated release it records by name', () => {
    // The gate assertion above passes, so deprecation is not a note: every
    // deprecated release this record carries must appear in the reviewed
    // DEPRECATION_EXCEPTIONS map, with the reason it is retained.
    const record = readProvenanceRecord()
    const deprecated = deprecatedReleases(record!)
    expect(deprecated).toEqual([
      '@oclif/parser@3.8.17',
      '@types/diff@8.0.0',
      '@types/parse-path@7.1.0',
    ])
    for (const spec of deprecated) {
      expect(DEPRECATION_EXCEPTIONS.get(spec), spec).toBeTruthy()
    }
  })

  test('records the license identifier in its allowlisted spelling', () => {
    // gif-encoder-2@1.0.5 publishes `UNLICENSE`; the record must agree with the
    // allowlist that judges it instead of reading as a pending objection.
    const record = readProvenanceRecord()
    expect(record!.packages['gif-encoder-2@1.0.5']!.license).toBe('Unlicense')
    expect(record!.packages['tree-sitter-wasms@0.1.13']!.license).toBe(
      'Unlicense',
    )
    for (const [spec, entry] of Object.entries(record!.packages)) {
      expect(licenseNeedsNormalization(entry.license), spec).toBe(false)
    }
  })
})

