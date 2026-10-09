import * as fsp from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'

import { describe, expect, test } from 'bun:test'

import type { ImportResolutionFile, TsAliasMap } from './import-resolution'
import { createTsModuleResolver } from './ts-module-resolver'

function makeFiles(paths: string[]): Record<string, ImportResolutionFile> {
  const files: Record<string, ImportResolutionFile> = {}
  for (const filePath of paths) {
    files[filePath] = {
      path: filePath,
      ext: filePath.slice(filePath.lastIndexOf('.')),
    }
  }
  return files
}

describe('ts-module-resolver: real ts.resolveModuleName tier', () => {
  test('creates a resolver when the typescript module is available', () => {
    expect(
      createTsModuleResolver({ projectRoot: '/proj', files: makeFiles([]) }),
    ).not.toBeNull()
  })

  test('resolves a relative specifier to an indexed file', () => {
    const files = makeFiles(['src/a.ts', 'src/helper.ts'])
    const resolver = createTsModuleResolver({ projectRoot: '/proj', files })
    expect(resolver?.('./helper', 'src/a.ts')).toBe('src/helper.ts')
  })

  test('anchors relative resolution on the importing file directory', () => {
    const files = makeFiles(['src/deep/a.ts', 'src/deep/sibling.ts'])
    const resolver = createTsModuleResolver({ projectRoot: '/proj', files })
    expect(resolver?.('./sibling', 'src/deep/a.ts')).toBe(
      'src/deep/sibling.ts',
    )
  })

  test('resolves a bare specifier through tsconfig paths aliases', () => {
    const files = makeFiles(['src/a.ts', 'src/util.ts'])
    const aliases: TsAliasMap = { '@acme/*': ['src/*'] }
    const resolver = createTsModuleResolver({
      projectRoot: '/proj',
      files,
      aliases,
    })
    expect(resolver?.('@acme/util', 'src/a.ts')).toBe('src/util.ts')
  })

  test('prefers .ts over .js when both are indexed', () => {
    const files = makeFiles(['src/a.ts', 'src/helper.ts', 'src/helper.js'])
    const resolver = createTsModuleResolver({ projectRoot: '/proj', files })
    expect(resolver?.('./helper', 'src/a.ts')).toBe('src/helper.ts')
  })

  test('maps a .js specifier to the indexed .ts source', () => {
    const files = makeFiles(['src/a.ts', 'src/helper.ts'])
    const resolver = createTsModuleResolver({ projectRoot: '/proj', files })
    expect(resolver?.('./helper.js', 'src/a.ts')).toBe('src/helper.ts')
  })

  test('resolves /index when the index file is indexed', () => {
    const files = makeFiles(['src/a.ts', 'src/util/index.ts'])
    const resolver = createTsModuleResolver({ projectRoot: '/proj', files })
    expect(resolver?.('./util', 'src/a.ts')).toBe('src/util/index.ts')
  })

  test('stays null for bare specifiers that match nothing (no invented edges)', () => {
    const files = makeFiles(['src/a.ts', 'src/react.ts'])
    const resolver = createTsModuleResolver({ projectRoot: '/proj', files })
    expect(resolver?.('react', 'src/a.ts')).toBeNull()
    expect(resolver?.('nope/missing', 'src/a.ts')).toBeNull()
  })

  test('stays null when resolution lands outside the indexed files map', () => {
    const files = makeFiles(['src/a.ts'])
    const resolver = createTsModuleResolver({ projectRoot: '/proj', files })
    expect(resolver?.('./missing', 'src/a.ts')).toBeNull()
  })

  test('stays null for paths escaping the project root', () => {
    const files = makeFiles(['src/a.ts'])
    const resolver = createTsModuleResolver({ projectRoot: '/proj', files })
    expect(resolver?.('../../etc/passwd', 'src/a.ts')).toBeNull()
    expect(resolver?.('../../../etc/passwd', 'src/a.ts')).toBeNull()
  })

  test('memoizes the resolver per files record identity', () => {
    const files = makeFiles(['src/a.ts', 'src/helper.ts'])
    const first = createTsModuleResolver({ projectRoot: '/proj', files })
    const second = createTsModuleResolver({ projectRoot: '/proj', files })
    expect(second).toBe(first)
  })
})

describe('ts-module-resolver: package.json exports/imports conditions', () => {
  test('resolves a bare specifier through the exports field (self-name)', () => {
    const files = makeFiles(['src/a.ts', 'src/entry.ts'])
    const resolver = createTsModuleResolver({
      projectRoot: '/proj',
      files,
      packageJsons: {
        'package.json': JSON.stringify({
          name: 'pkg',
          exports: { './sub': './src/entry.ts' },
        }),
      },
    })
    expect(resolver?.('pkg/sub', 'src/a.ts')).toBe('src/entry.ts')
  })

  test('resolves an imports (#) specifier onto an indexed file', () => {
    const files = makeFiles(['src/a.ts', 'src/entry.ts'])
    const resolver = createTsModuleResolver({
      projectRoot: '/proj',
      files,
      packageJsons: {
        'package.json': JSON.stringify({
          imports: { '#utils': './src/entry.ts' },
        }),
      },
    })
    expect(resolver?.('#utils', 'src/a.ts')).toBe('src/entry.ts')
  })

  test('stays null when an exports target points outside the indexed files map', () => {
    // The host CAN read the package.json here, but the exports target points
    // into node_modules, which is never indexed — the final-edge gate must
    // keep the resolution null (no invented node_modules edges).
    const files = makeFiles(['src/a.ts'])
    const resolver = createTsModuleResolver({
      projectRoot: '/proj',
      files,
      packageJsons: {
        'package.json': JSON.stringify({
          name: 'pkg',
          exports: { './sub': './node_modules/x/index.js' },
        }),
      },
    })
    expect(resolver?.('pkg/sub', 'src/a.ts')).toBeNull()
  })

  test('a different packageJsons fixture yields a fresh resolver (cache identity)', () => {
    const files = makeFiles(['src/a.ts', 'src/entry.ts'])
    const map = { 'package.json': '{"name":"a"}' }
    const first = createTsModuleResolver({
      projectRoot: '/proj',
      files,
      packageJsons: map,
    })
    expect(
      createTsModuleResolver({ projectRoot: '/proj', files, packageJsons: map }),
    ).toBe(first)
    expect(
      createTsModuleResolver({
        projectRoot: '/proj',
        files,
        packageJsons: { 'package.json': '{"name":"b"}' },
      }),
    ).not.toBe(first)
  })

  test('falls back to a bounded real package.json read inside the project root', async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'ts-resolver-'))
    await fsp.writeFile(
      path.join(root, 'package.json'),
      JSON.stringify({
        name: 'pkg',
        exports: { './sub': './src/entry.ts' },
      }),
    )
    const files = makeFiles(['src/a.ts', 'src/entry.ts'])
    const resolver = createTsModuleResolver({ projectRoot: root, files })
    expect(resolver?.('pkg/sub', 'src/a.ts')).toBe('src/entry.ts')
  })

  test('fails open when the real package.json exceeds the 64 KiB read bound', async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'ts-resolver-'))
    await fsp.writeFile(
      path.join(root, 'package.json'),
      JSON.stringify({
        name: 'pkg',
        // The exports target is intentionally ABSENT from the real fs (only
        // src/entry.ts is indexed and written): the oxc primary tier reads
        // this real oversized manifest without a size bound, so pointing it
        // at an on-disk file would let oxc self-reference-resolve 'pkg/sub'
        // and bypass the bound under test. With the target missing, oxc
        // conservatively misses and the ts fallback alone decides — and its
        // host refuses to serve the oversized manifest, so the .js → .ts
        // mapping that would otherwise land on the indexed src/entry.ts
        // never happens.
        exports: { './sub': './src/entry.js' },
        padding: 'x'.repeat(64 * 1024),
      }),
    )
    const files = makeFiles(['src/a.ts', 'src/entry.ts'])
    const resolver = createTsModuleResolver({ projectRoot: root, files })
    expect(resolver?.('pkg/sub', 'src/a.ts')).toBeNull()
  })
})

describe('ts-module-resolver: oxc-resolver primary tier', () => {
  // oxc probes the REAL filesystem, so these tests use real tmpdir projects
  // (real tsconfig.json / source files on disk) instead of the hermetic
  // '/proj' fixtures, which the ts fallback tier resolves against its
  // in-memory host.

  test('resolves a paths alias natively through oxc (real tmpdir project)', async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'oxc-resolver-'))
    await fsp.mkdir(path.join(root, 'src'), { recursive: true })
    await fsp.writeFile(
      path.join(root, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          baseUrl: '.',
          paths: { '@acme/*': ['./src/*'] },
        },
      }),
    )
    await fsp.writeFile(path.join(root, 'src', 'a.ts'), 'export {}\n')
    await fsp.writeFile(path.join(root, 'src', 'util.ts'), 'export {}\n')
    const files = makeFiles(['src/a.ts', 'src/util.ts'])
    const resolver = createTsModuleResolver({ projectRoot: root, files })
    // The ts fallback tier cannot resolve this: no injected `aliases` and
    // its host never reads tsconfig.json — a hit here proves the oxc
    // tier's native tsconfig `paths` support.
    expect(resolver?.('@acme/util', 'src/a.ts')).toBe('src/util.ts')
  })

  test('resolves through tsconfig references: auto (referenced project paths)', async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'oxc-references-'))
    await fsp.mkdir(path.join(root, 'packages', 'lib', 'src'), {
      recursive: true,
    })
    await fsp.writeFile(
      path.join(root, 'tsconfig.json'),
      JSON.stringify({
        references: [{ path: './packages/lib/tsconfig.json' }],
      }),
    )
    await fsp.writeFile(
      path.join(root, 'packages', 'lib', 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          baseUrl: '.',
          include: ['src'],
          paths: { '@lib/*': ['./src/*'] },
        },
      }),
    )
    await fsp.writeFile(
      path.join(root, 'packages', 'lib', 'src', 'a.ts'),
      'export {}\n',
    )
    await fsp.writeFile(
      path.join(root, 'packages', 'lib', 'src', 'util.ts'),
      'export {}\n',
    )
    const files = makeFiles([
      'packages/lib/src/a.ts',
      'packages/lib/src/util.ts',
    ])
    const resolver = createTsModuleResolver({ projectRoot: root, files })
    // The root tsconfig itself has no paths; only the referenced project's
    // tsconfig maps '@lib/*', so a hit proves oxc followed the reference.
    expect(resolver?.('@lib/util', 'packages/lib/src/a.ts')).toBe(
      'packages/lib/src/util.ts',
    )
  })

  test('refuses a bare specifier that resolves into real node_modules (final-edge gate)', async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'oxc-node-modules-'))
    await fsp.mkdir(path.join(root, 'src'), { recursive: true })
    await fsp.mkdir(path.join(root, 'node_modules', 'foo'), {
      recursive: true,
    })
    await fsp.writeFile(path.join(root, 'src', 'a.ts'), 'export {}\n')
    await fsp.writeFile(
      path.join(root, 'node_modules', 'foo', 'index.js'),
      'module.exports = {}\n',
    )
    const files = makeFiles(['src/a.ts'])
    const resolver = createTsModuleResolver({ projectRoot: root, files })
    // oxc probes the REAL filesystem and would resolve `foo` to
    // node_modules/foo/index.js; the unchanged final-edge gate must refuse
    // the edge because node_modules is never indexed. The ts fallback
    // cannot resolve it either, so null here pins the gate, not a tier.
    expect(resolver?.('foo', 'src/a.ts')).toBeNull()
  })

  test('result-based fail-open: relative resolution still works (oxc or ts fallback)', async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'oxc-failopen-'))
    await fsp.mkdir(path.join(root, 'src'), { recursive: true })
    await fsp.writeFile(path.join(root, 'src', 'a.ts'), 'export {}\n')
    await fsp.writeFile(path.join(root, 'src', 'helper.ts'), 'export {}\n')
    const files = makeFiles(['src/a.ts', 'src/helper.ts'])
    const resolver = createTsModuleResolver({ projectRoot: root, files })
    // Intentionally result-based: the assertion holds whether the oxc napi
    // binding is present (oxc resolves it) or absent (the ts host fallback
    // resolves it) — that graceful degradation is exactly what is pinned.
    expect(resolver?.('./helper', 'src/a.ts')).toBe('src/helper.ts')
  })
})
