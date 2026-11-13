import { describe, expect, test } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  NO_TYPES_PACKAGE,
  checkTypesDeclarations,
  collectOrphanedTypes,
  collectUndeclaredTypes,
  expectedTypesPackage,
  expandWorkspaceDirectories,
  formatTypesDeclarationViolations,
  installedPackageShipsTypes,
  orphanedTypesExemptions,
  readWorkspaceManifests,
  resolveInstalledPackageDir,
  runtimePackageForTypes,
  unclassifiedRuntimeDependencies,
} from '../types-declaration-guard'

import type { WorkspaceManifest } from '../types-declaration-guard'

const repoRoot = join(import.meta.dir, '..', '..')

function withTempRepo(build: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), 'types-declaration-'))
  try {
    build(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

function writeManifest(root: string, subdir: string, value: unknown): void {
  const dir = join(root, subdir)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify(value, null, 2))
}

/** A manifest record with no dependencies, as the check consumes it. */
function manifestRecord(
  manifest: string,
  dependencies: Record<string, string> = {},
  devDependencies: Record<string, string> = {},
): WorkspaceManifest {
  return { manifest, dependencies, devDependencies }
}

describe('expectedTypesPackage', () => {
  test('maps lodash to @types/lodash', () => {
    expect(expectedTypesPackage('lodash')).toBe('@types/lodash')
  })

  test('maps any other unscoped name to @types/<name>', () => {
    expect(expectedTypesPackage('micromatch')).toBe('@types/micromatch')
  })

  test('maps a scoped name to @types/<scope>__<pkg>', () => {
    // npm's scoped-types convention: strip the leading `@`, join with `__`.
    expect(expectedTypesPackage('@scope/pkg')).toBe('@types/scope__pkg')
  })
})

describe('runtimePackageForTypes', () => {
  test('inverts the unscoped convention', () => {
    expect(runtimePackageForTypes('@types/lodash')).toBe('lodash')
  })

  test('inverts the scoped convention', () => {
    expect(runtimePackageForTypes('@types/scope__pkg')).toBe('@scope/pkg')
  })

  test('round-trips with expectedTypesPackage', () => {
    for (const name of ['lodash', 'micromatch', '@scope/pkg']) {
      expect(runtimePackageForTypes(expectedTypesPackage(name))).toBe(name)
    }
  })
})

describe('readWorkspaceManifests', () => {
  test('expands glob patterns against the real tree and skips absent paths', () => {
    withTempRepo((root) => {
      writeManifest(root, '.', {
        name: 'root',
        workspaces: ['packages/*', 'missing-dir'],
      })
      writeManifest(root, 'packages/a', {
        name: 'a',
        dependencies: { lodash: '^4.17.23' },
        devDependencies: { '@types/lodash': '^4.17.21' },
      })
      writeManifest(root, 'packages/b', { name: 'b' })
      // A real subdirectory that is not a workspace member because it is not
      // matched by the pattern and has no manifest.
      mkdirSync(join(root, 'packages', 'c'), { recursive: true })

      const manifests = readWorkspaceManifests(root)

      expect(manifests.map((entry) => entry.manifest)).toEqual([
        'package.json',
        'packages/a/package.json',
        'packages/b/package.json',
      ])
      // Absent `missing-dir` and manifest-less `packages/c` are not reported.
      expect(
        manifests.some((entry) => entry.manifest.includes('missing-dir')),
      ).toBe(false)
      expect(manifests.some((entry) => entry.manifest.includes('c/'))).toBe(
        false,
      )
    })
  })

  test('defaults missing dependency blocks to empty records', () => {
    withTempRepo((root) => {
      writeManifest(root, '.', { name: 'root', workspaces: ['sdk'] })
      writeManifest(root, 'sdk', { name: 'sdk', dependencies: 'not-an-object' })

      const manifests = readWorkspaceManifests(root)
      const sdk = manifests.find((entry) => entry.manifest === 'sdk/package.json')

      expect(manifests).toHaveLength(2)
      expect(sdk!.dependencies).toEqual({})
      expect(sdk!.devDependencies).toEqual({})
    })
  })

  test('expandWorkspaceDirectories always includes the root', () => {
    withTempRepo((root) => {
      writeManifest(root, '.', { name: 'root', workspaces: ['packages/*'] })
      const directories = expandWorkspaceDirectories(root).map((directory) =>
        directory.slice(root.length + 1),
      )
      expect(directories).toEqual([''])
    })
  })
})

describe('collectUndeclaredTypes', () => {
  test('passes when the typings are co-declared in devDependencies', () => {
    const violations = collectUndeclaredTypes({
      manifests: [
        manifestRecord(
          'package.json',
          { lodash: '^4.17.23' },
          { '@types/lodash': '^4.17.21' },
        ),
      ],
    })

    expect(violations).toEqual([])
  })

  test('passes when the typings are co-declared in dependencies instead', () => {
    // devDependencies is the canonical home, but declaring the typings as a
    // runtime dependency is unusual — not a violation.
    const violations = collectUndeclaredTypes({
      manifests: [
        manifestRecord('package.json', {
          lodash: '^4.17.23',
          '@types/lodash': '^4.17.21',
        }),
      ],
    })

    expect(violations).toEqual([])
  })

  test('reports a runtime dependency with no co-declared typings', () => {
    const violations = collectUndeclaredTypes({
      manifests: [manifestRecord('common/package.json', { lodash: '^4.17.23' })],
    })

    expect(violations).toEqual([
      {
        manifest: 'common/package.json',
        dependency: 'lodash',
        expectedTypes: '@types/lodash',
      },
    ])
  })

  test('requires the typings in the SAME manifest that depends on it', () => {
    // Typings declared by a different workspace member do not satisfy the
    // invariant: it is about the manifest that owns the runtime dependency.
    const violations = collectUndeclaredTypes({
      manifests: [
        manifestRecord('a/package.json', { lodash: '^4.17.23' }),
        manifestRecord(
          'b/package.json',
          {},
          { '@types/lodash': '^4.17.21' },
        ),
      ],
    })

    expect(violations).toHaveLength(1)
    expect(violations[0]!.manifest).toBe('a/package.json')
  })

  test('fails a scoped runtime dependency whose scoped typings are missing', () => {
    // The guard is manifest-driven, not allowlist-driven: any runtime
    // dependency whose typings are not declared in the same manifest fails,
    // whatever its name.
    const violations = collectUndeclaredTypes({
      manifests: [
        manifestRecord('sdk/package.json', { '@scope/pkg': '^1.0.0' }),
      ],
    })

    expect(violations).toEqual([
      {
        manifest: 'sdk/package.json',
        dependency: '@scope/pkg',
        expectedTypes: '@types/scope__pkg',
      },
    ])
  })

  test('passes a scoped runtime dependency whose scoped typings are declared', () => {
    const violations = collectUndeclaredTypes({
      manifests: [
        manifestRecord(
          'sdk/package.json',
          { '@scope/pkg': '^1.0.0' },
          { '@types/scope__pkg': '^1.0.0' },
        ),
      ],
    })

    expect(violations).toEqual([])
  })

  test('ignores @types/*, internal workspace packages and node builtins', () => {
    const violations = collectUndeclaredTypes({
      manifests: [
        manifestRecord('package.json', {
          '@types/lodash': '^4.17.21',
          '@codebuff/common': 'workspace:*',
          '@openbuff/sdk': 'workspace:*',
          'node:fs': '^1.0.0',
          fs: '^1.0.0',
          path: '^1.0.0',
          crypto: '^1.0.0',
          process: '^1.0.0',
          worker_threads: '^1.0.0',
        }),
      ],
    })

    expect(violations).toEqual([])
  })

  test('skips a runtime package recorded in NO_TYPES_PACKAGE', () => {
    // `bun` has no `@types/bun` sibling: the `bun` module is published by
    // `@types/bun`/`bun-types`, so the exemption records why.
    expect(NO_TYPES_PACKAGE.has('bun')).toBe(true)
    const violations = collectUndeclaredTypes({
      manifests: [manifestRecord('cli/package.json', { bun: '^1.3.5' })],
    })

    expect(violations).toEqual([])
  })

  test('reports a non-allowlisted runtime dependency with no typings', () => {
    // The regression the hard-coded allowlist missed: a dependency of ANY name
    // whose typings were dropped must fail the gate, not print a note.
    const violations = collectUndeclaredTypes({
      manifests: [
        manifestRecord('packages/indexer/package.json', {
          micromatch: '^4.0.8',
        }),
      ],
    })

    expect(violations).toEqual([
      {
        manifest: 'packages/indexer/package.json',
        dependency: 'micromatch',
        expectedTypes: '@types/micromatch',
      },
    ])
  })

  test('does not check devDependencies-only entries', () => {
    // A devDependencies entry is not a runtime dependency, so the invariant
    // guards nothing about it.
    const violations = collectUndeclaredTypes({
      manifests: [
        manifestRecord('package.json', {}, { lodash: '^4.17.23' }),
      ],
    })

    expect(violations).toEqual([])
  })

  test('sorts violations by manifest then dependency', () => {
    const violations = collectUndeclaredTypes({
      manifests: [
        manifestRecord('z/package.json', { lodash: '^4.17.23' }),
        manifestRecord('a/package.json', { lodash: '^4.17.23' }),
      ],
    })

    expect(violations.map((violation) => violation.manifest)).toEqual([
      'a/package.json',
      'z/package.json',
    ])
  })

  test('sorts two dependencies of one manifest by name', () => {
    const violations = collectUndeclaredTypes({
      manifests: [
        manifestRecord('a/package.json', {
          micromatch: '^4.0.8',
          lodash: '^4.17.23',
        }),
      ],
    })

    expect(violations.map((violation) => violation.dependency)).toEqual([
      'lodash',
      'micromatch',
    ])
  })
})

describe('unclassifiedRuntimeDependencies', () => {
  test('reports only the runtime deps covered by a NO_TYPES_PACKAGE exemption', () => {
    // Everything else is classified (declared typings or a violation), so a
    // green run reports exactly the exempted surface.
    const unclassified = unclassifiedRuntimeDependencies({
      manifests: [
        manifestRecord('cli/package.json', {
          bun: '^1.3.5',
          lodash: '^4.17.23',
          '@codebuff/common': 'workspace:*',
        }),
      ],
    })

    expect(unclassified).toEqual([
      {
        manifest: 'cli/package.json',
        dependency: 'bun',
        expectedTypes: '@types/bun',
      },
    ])
  })
})

describe('checkTypesDeclarations', () => {
  test('checks a fixture workspace end to end', () => {
    withTempRepo((root) => {
      writeManifest(root, '.', {
        name: 'root',
        workspaces: ['packages/*'],
        dependencies: { lodash: '^4.17.23' },
        devDependencies: { '@types/lodash': '^4.17.21' },
      })
      writeManifest(root, 'packages/untyped', {
        name: 'untyped',
        dependencies: { lodash: '^4.17.23' },
      })
      writeManifest(root, 'packages/typed', {
        name: 'typed',
        dependencies: { lodash: '^4.17.23' },
        devDependencies: { '@types/lodash': '^4.17.21' },
      })

      const result = checkTypesDeclarations(root)

      expect(result.ok).toBe(false)
      expect(result.violations).toEqual([
        {
          manifest: 'packages/untyped/package.json',
          dependency: 'lodash',
          expectedTypes: '@types/lodash',
        },
      ])
    })
  })

  test('passes a fixture workspace whose runtime deps declare their typings', () => {
    withTempRepo((root) => {
      writeManifest(root, '.', {
        name: 'root',
        workspaces: ['sdk'],
        dependencies: { lodash: '^4.17.23' },
        devDependencies: { '@types/lodash': '^4.17.21' },
      })
      writeManifest(root, 'sdk', {
        name: 'sdk',
        dependencies: { lodash: '^4.17.23', '@codebuff/common': 'workspace:*' },
        devDependencies: { '@types/lodash': '^4.17.21' },
      })

      // Nothing is exempted and nothing is missing typings, so the fixture is
      // green with an empty exemption list.
      expect(checkTypesDeclarations(root)).toEqual({
        ok: true,
        violations: [],
        orphanedTypes: [],
        unclassified: [],
      })
    })
  })

  test('fails a workspace whose typings have no runtime sibling', () => {
    // The reverse direction: an orphaned `@types/*` devDependency — the exact
    // shape the two @types/lodash entries had — must fail the gate.
    withTempRepo((root) => {
      writeManifest(root, '.', { name: 'root', workspaces: ['packages/*'] })
      writeManifest(root, 'packages/indexer', {
        name: 'indexer',
        dependencies: { ignore: '^7.0.5' },
        devDependencies: { '@types/lodash': '^4.17.21' },
      })

      const result = checkTypesDeclarations(root)

      expect(result.ok).toBe(false)
      expect(result.orphanedTypes).toEqual([
        {
          manifest: 'packages/indexer/package.json',
          dependency: '@types/lodash',
          expectedTypes: 'lodash',
        },
      ])
    })
  })

  test('this repository satisfies the invariant today', () => {
    // Every workspace member declares the typings of every runtime dependency
    // it owns in its own manifest, so a pruned/isolated install resolves them
    // without relying on the root devDependency hoist.
    expect(existsSync(join(repoRoot, 'bun.lock'))).toBe(true)

    const { ok, violations, orphanedTypes } = checkTypesDeclarations(repoRoot)

    expect(violations).toEqual([])
    expect(orphanedTypes).toEqual([])
    expect(ok).toBe(true)
  })

  test('the published sdk manifest ships no types-only package at runtime', () => {
    // Regression guard for the runtime/development dependency boundary
    // finding: @openbuff/sdk is `private: false`, and its `//dependencies`
    // contract marks every non-@codebuff entry else shipped to consumers as
    // a runtime dependency. A types-only `@types/*` package in `dependencies`
    // forces node typings into every consumer install graph, so it must live
    // in devDependencies instead.
    const sdkManifest = JSON.parse(readFileSync(join(repoRoot, 'sdk', 'package.json'), 'utf8')) as {
      private?: boolean
      devDependencies: Record<string, string>
      dependencies: Record<string, string>
    }

    expect(sdkManifest.private).toBe(false)
    expect(
      Object.keys(sdkManifest.dependencies).filter((name) =>
        name.startsWith('@types/'),
      ),
    ).toEqual([])
    expect(Object.keys(sdkManifest.devDependencies)).toContain('@types/ws')
    // The lodash typings the published declaration output references are
    // declared by the manifest that ships them, not by the root hoist.
    expect(Object.keys(sdkManifest.devDependencies)).toContain('@types/lodash')
  })
})

describe('collectOrphanedTypes', () => {
  test('reports a typings package whose runtime sibling no manifest block declares', () => {
    expect(
      collectOrphanedTypes({
        manifests: [
          manifestRecord(
            'cli/package.json',
            { picocolors: '^1.1.1' },
            { '@types/lodash': '^4.17.21' },
          ),
        ],
      }),
    ).toEqual([
      {
        manifest: 'cli/package.json',
        dependency: '@types/lodash',
        expectedTypes: 'lodash',
      },
    ])
  })

  test('passes a typings package whose runtime sibling is declared', () => {
    expect(
      collectOrphanedTypes({
        manifests: [
          manifestRecord(
            'agent-runtime/package.json',
            { lodash: '4.17.23' },
            { '@types/lodash': '^4.17.21' },
          ),
        ],
      }),
    ).toEqual([])
  })

  test('accepts the runtime sibling declared in devDependencies', () => {
    expect(
      collectOrphanedTypes({
        manifests: [
          manifestRecord(
            'cli/package.json',
            {},
            { react: '19.2.0', '@types/react': '19.2.14' },
          ),
        ],
      }),
    ).toEqual([])
  })

  test('checks a scoped typings package against its scoped runtime sibling', () => {
    expect(
      collectOrphanedTypes({
        manifests: [
          manifestRecord(
            'sdk/package.json',
            {},
            { '@types/scope__pkg': '^1.0.0' },
          ),
        ],
      }),
    ).toEqual([
      {
        manifest: 'sdk/package.json',
        dependency: '@types/scope__pkg',
        expectedTypes: '@scope/pkg',
      },
    ])
  })

  test('does not blame a dev-only runtime package for a missing sibling', () => {
    // A devDependency is not a runtime dependency, so the forward check stays
    // silent — but the reverse direction still requires the runtime sibling of
    // a declared typings package, which is exactly what stops a copy-pasted
    // `@types/*` line from surviving a removed runtime dependency.
    expect(
      collectOrphanedTypes({
        manifests: [
          manifestRecord(
            'cli/package.json',
            {},
            { '@types/lodash': '^4.17.21' },
          ),
        ],
      }),
    ).toHaveLength(1)
  })

  test('reports an orphaned @types entry declared in dependencies too', () => {
    expect(
      collectOrphanedTypes({
        manifests: [
          manifestRecord('a/package.json', { '@types/lodash': '^4.17.21' }),
        ],
      }),
    ).toEqual([
      {
        manifest: 'a/package.json',
        dependency: '@types/lodash',
        expectedTypes: 'lodash',
      },
    ])
  })

  test('ignores @types for Node builtins and for runtime packages the guard exempts', () => {
    expect(
      collectOrphanedTypes({
        manifests: [
          manifestRecord(
            'package.json',
            {},
            {
              '@types/node': '^22.9.0',
              '@types/process': '^1.0.0',
            },
          ),
        ],
      }),
    ).toEqual([])
  })

  test('sorts violations by manifest then dependency', () => {
    const violations = collectOrphanedTypes({
      manifests: [
        manifestRecord('z/package.json', {}, { '@types/lodash': '^4.17.21' }),
        manifestRecord('a/package.json', {}, { '@types/lodash': '^4.17.21' }),
      ],
    })

    expect(violations.map((violation) => violation.manifest)).toEqual([
      'a/package.json',
      'z/package.json',
    ])
  })
})

describe('orphanedTypesExemptions', () => {
  test('reports nothing when no exemption applies', () => {
    expect(
      orphanedTypesExemptions({
        manifests: [
          manifestRecord(
            'agent-runtime/package.json',
            { lodash: '4.17.23' },
            { '@types/lodash': '^4.17.21' },
          ),
        ],
      }),
    ).toEqual([])
  })
})

describe('formatTypesDeclarationViolations', () => {
  test('reports a clean pass', () => {
    // The success message names the ENFORCED scope, in both directions: every
    // runtime dependency of every workspace manifest, not an allowlist of
    // packages, and every declared typings package's runtime sibling.
    expect(formatTypesDeclarationViolations([])).toBe(
      'Type declaration guard passed: every runtime dependency of every workspace manifest declares its typings in that same manifest, and every declared @types package has the runtime dependency it types in that same manifest, or is recorded in NO_TYPES_PACKAGE / ORPHANED_TYPES_EXEMPT with the package that supplies them.',
    )
  })

  test('lists every manifest, dependency and the missing @types package', () => {
    const message = formatTypesDeclarationViolations([
      {
        manifest: 'common/package.json',
        dependency: 'lodash',
        expectedTypes: '@types/lodash',
      },
    ])

    expect(message).toContain('Type declaration guard failed:')
    expect(message.split('\n')).toHaveLength(2)
    expect(message).toContain('common/package.json')
    expect(message).toContain('lodash declares no @types/lodash')
    expect(message.startsWith('  - ')).toBe(false)
    expect(message.split('\n')[1]!.startsWith('  - ')).toBe(true)
  })

  test('names the orphaned typings package and the runtime package it types', () => {
    const message = formatTypesDeclarationViolations(
      [],
      [],
      [
        {
          manifest: 'cli/package.json',
          dependency: '@types/lodash',
          expectedTypes: 'lodash',
        },
      ],
    )

    expect(message).toContain('Type declaration guard failed:')
    expect(message).toContain(
      'cli/package.json: @types/lodash types lodash, which this manifest declares in neither dependencies nor devDependencies',
    )
  })

  test('names the exempted runtime dependencies on a green run', () => {
    const message = formatTypesDeclarationViolations([], [
      {
        manifest: 'cli/package.json',
        dependency: 'bun',
        expectedTypes: '@types/bun',
      },
    ])

    expect(message.split('\n')[0]).toContain('guard passed')
    expect(message).toContain('NO_TYPES_PACKAGE')
    expect(message).toContain('  - cli/package.json: bun')
  })
})

describe('bundled-types disk evidence', () => {
  test('a self-typed runtime dependency is compliant via the disk predicate', () => {
    // zod bundles its own declarations and no @types/zod exists on npm: the
    // disk predicate proves compliance from the install, so no sibling and no
    // exemption is required. Without the predicate the same fixture stays a
    // violation (fail-closed: no evidence, no exemption).
    const manifests = [
      manifestRecord('sdk/package.json', { zod: '^4.2.1' }),
    ]
    expect(
      collectUndeclaredTypes({
        manifests,
        shipsOwnTypes: () => true,
      }),
    ).toEqual([])
    expect(collectUndeclaredTypes({ manifests })).toEqual([
      {
        manifest: 'sdk/package.json',
        dependency: 'zod',
        expectedTypes: '@types/zod',
      },
    ])
  })

  test('an unresolvable dependency is never exempted by disk evidence', () => {
    // A package that is not installed anywhere reachable cannot be proven to
    // carry declarations, so it stays a violation even though the disk
    // predicate is wired — the pruned-install scenario the invariant guards.
    expect(
      collectUndeclaredTypes({
        manifests: [manifestRecord('sdk/package.json', { lodash: '^4.17.23' })],
        shipsOwnTypes: () => false,
      }),
    ).toEqual([
      {
        manifest: 'sdk/package.json',
        dependency: 'lodash',
        expectedTypes: '@types/lodash',
      },
    ])
  })

  test('the real install classifies zod as self-typed and lodash as not', () => {
    // Pinned against the checked-in install so the resolver tiers (types
    // field, index.d.ts, entry-adjacent and subpath-adjacent .d.ts) are
    // exercised by real package manifests, not only fixtures.
    const zodDir = resolveInstalledPackageDir('zod', repoRoot, repoRoot)
    expect(zodDir).toBeDefined()
    expect(installedPackageShipsTypes(zodDir!)).toBe(true)

    const lodashDir = resolveInstalledPackageDir('lodash', repoRoot, repoRoot)
    expect(lodashDir).toBeDefined()
    expect(installedPackageShipsTypes(lodashDir!)).toBe(false)

    // A scoped package resolved through node_modules/@scope/pkg, typing its
    // declarations beside subpath exports rather than the root entry.
    const mcpDir = resolveInstalledPackageDir(
      '@modelcontextprotocol/sdk',
      repoRoot,
      repoRoot,
    )
    expect(mcpDir).toBeDefined()
    expect(installedPackageShipsTypes(mcpDir!)).toBe(true)

    expect(
      resolveInstalledPackageDir('definitely-not-installed-anywhere', repoRoot, repoRoot),
    ).toBeUndefined()
  })

  test('a member resolves its own node_modules copy before the hoisted one', () => {
    withTempRepo((root) => {
      writeManifest(root, '.', { name: 'root' })
      writeManifest(root, 'member', { name: 'member' })
      // The member shadows the root copy with an untyped one: resolution from
      // the MEMBER must find the member-local node_modules first.
      mkdirSync(join(root, 'node_modules', 'hoisted-pkg'), { recursive: true })
      writeFileSync(
        join(root, 'node_modules', 'hoisted-pkg', 'package.json'),
        JSON.stringify({ name: 'hoisted-pkg', types: './index.d.ts' }),
      )
      writeFileSync(
        join(root, 'node_modules', 'hoisted-pkg', 'index.d.ts'),
        'export {}',
      )
      mkdirSync(join(root, 'member', 'node_modules', 'hoisted-pkg'), {
        recursive: true,
      })
      writeFileSync(
        join(root, 'member', 'node_modules', 'hoisted-pkg', 'package.json'),
        JSON.stringify({ name: 'hoisted-pkg' }),
      )

      const fromMember = resolveInstalledPackageDir(
        'hoisted-pkg',
        join(root, 'member'),
        root,
      )
      expect(fromMember).toBe(join(root, 'member', 'node_modules', 'hoisted-pkg'))
      expect(installedPackageShipsTypes(fromMember!)).toBe(false)
    })
  })
})

describe('malformed manifests fail closed', () => {
  test('an unparseable workspace manifest is an error, not empty dependencies', () => {
    withTempRepo((root) => {
      writeManifest(root, '.', { name: 'root', workspaces: ['sdk'] })
      mkdirSync(join(root, 'sdk'), { recursive: true })
      // Raw invalid JSON: a parse failure would previously contribute no
      // dependencies and the guard would "pass" over an unchecked member.
      writeFileSync(join(root, 'sdk', 'package.json'), '{ not json')

      expect(() => readWorkspaceManifests(root)).toThrow(/not valid JSON/)
      expect(() => checkTypesDeclarations(root)).toThrow(/not valid JSON/)
    })
  })

  test('a manifest parsing to a non-object is an error too', () => {
    withTempRepo((root) => {
      writeManifest(root, '.', { name: 'root', workspaces: ['sdk'] })
      writeManifest(root, 'sdk', 123)

      expect(() => readWorkspaceManifests(root)).toThrow(/not a JSON object/)
    })
  })

  test('an unparseable root manifest is an error for workspace expansion', () => {
    withTempRepo((root) => {
      writeFileSync(join(root, 'package.json'), 'not json at all')

      expect(() => expandWorkspaceDirectories(root)).toThrow(/not valid JSON/)
    })
  })
})
