import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { afterAll, describe, expect, test } from 'bun:test'

import { buildMetadataIndex, updateMetadataIndex } from './metadata-indexer'

import { resolveImportToFile } from './import-resolution'

import type { ImportResolutionFile } from './import-resolution'

const roots: string[] = []
afterAll(() => {
  for (const r of roots) {
    try {
      rmSync(r, { recursive: true, force: true })
    } catch {}
  }
})

function project(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'openbuff-imports-'))
  roots.push(root)
  for (const [rel, content] of Object.entries(files)) {
    const full = join(root, rel)
    mkdirSync(join(full, '..'), { recursive: true })
    writeFileSync(full, content)
  }
  return root
}

function hasReferenceEdge(
  graph: { edges: { from: string; to: string; type: string }[] },
  fromPath: string,
  toPath: string,
): boolean {
  return graph.edges.some(
    (e) =>
      e.type === 'references' &&
      e.from === `file:${fromPath}` &&
      e.to === `file:${toPath}`,
  )
}

function referenceTargets(
  graph: {
    edges: { from: string; to: string; type: string; label?: string }[]
  },
  fromPath: string,
  specifier: string,
): string[] {
  return graph.edges
    .filter(
      (edge) =>
        edge.type === 'references' &&
        edge.from === `file:${fromPath}` &&
        edge.label === specifier,
    )
    .map((edge) => edge.to)
}

describe('import graph: alias + re-export resolution', () => {
  test('resolves tsconfig path aliases into reference edges', async () => {
    const root = project({
      'tsconfig.json': JSON.stringify({
        compilerOptions: {
          baseUrl: '.',
          paths: {
            '@pkg/common/*': ['./common/src/*'],
            '@pkg/sdk': ['./sdk/src/index.ts'],
          },
        },
      }),
      'common/src/util.ts': 'export const helper = () => 1\n',
      'sdk/src/index.ts': 'export const sdk = 2\n',
      'app/main.ts': [
        "import { helper } from '@pkg/common/util'",
        "import { sdk } from '@pkg/sdk'",
        'export function main() { return helper() + sdk }',
      ].join('\n'),
    })

    const index = await buildMetadataIndex(root)
    // Alias imports must resolve to real files as `references` edges.
    expect(
      hasReferenceEdge(index.graph, 'app/main.ts', 'common/src/util.ts'),
    ).toBe(true)
    expect(
      hasReferenceEdge(index.graph, 'app/main.ts', 'sdk/src/index.ts'),
    ).toBe(true)
  })

  test('captures re-export (export ... from) specifiers', async () => {
    const root = project({
      'src/inner.ts': 'export const x = 1\n',
      'src/barrel.ts': "export { x } from './inner'\n",
    })
    const index = await buildMetadataIndex(root)
    expect(index.files['src/barrel.ts'].imports).toContain('./inner')
    expect(hasReferenceEdge(index.graph, 'src/barrel.ts', 'src/inner.ts')).toBe(
      true,
    )
  })

  test('extracts and resolves Python package imports', async () => {
    const root = project({
      'app/__init__.py': '',
      'app/models.py': 'class User:\n    pass\n',
      'app/service.py': 'from .models import User\n',
    })

    const index = await buildMetadataIndex(root)
    expect(index.files['app/service.py'].imports).toContain('.models')
    expect(
      hasReferenceEdge(index.graph, 'app/service.py', 'app/models.py'),
    ).toBe(true)
  })

  test('extracts and resolves Rust modules', async () => {
    const root = project({
      'src/lib.rs': 'mod config;\nuse crate::config::Config;\n',
      'src/config.rs': 'pub struct Config;\n',
    })

    const index = await buildMetadataIndex(root)
    expect(index.files['src/lib.rs'].imports).toContain('config')
    expect(index.files['src/lib.rs'].imports).toContain('crate::config::Config')
    expect(hasReferenceEdge(index.graph, 'src/lib.rs', 'src/config.rs')).toBe(
      true,
    )
  })

  test('extracts only quoted paths inside Go import declarations', async () => {
    const root = project({
      'go.mod': 'module example.com/demo\n',
      'internal/logging/log.go': 'package logging\n',
      'cmd/main.go': [
        'package main',
        'import (',
        '  "fmt"',
        '  logging "example.com/demo/internal/logging"',
        ')',
        'const unrelated = "not/an/import"',
      ].join('\n'),
    })

    const index = await buildMetadataIndex(root)
    expect(index.files['cmd/main.go'].imports).toEqual([
      'fmt',
      'example.com/demo/internal/logging',
    ])
    expect(
      hasReferenceEdge(index.graph, 'cmd/main.go', 'internal/logging/log.go'),
    ).toBe(true)
  })

  test('does not resolve external JavaScript packages by filename suffix', async () => {
    const root = project({
      'src/react.ts': 'export const local = true\n',
      'src/app.ts': "import React from 'react'\n",
    })

    const index = await buildMetadataIndex(root)
    expect(hasReferenceEdge(index.graph, 'src/app.ts', 'src/react.ts')).toBe(
      false,
    )
  })

  test('requires declared package identity for JVM and PHP imports', async () => {
    const root = project({
      'src/main/java/com/external/User.java':
        'package com.local;\npublic class User {}\n',
      'com/root/RootUser.java':
        'package com.wrong;\npublic class RootUser {}\n',
      'src/main/java/app/App.java':
        'package app;\nimport com.external.User;\nimport com.root.RootUser;\npublic class App {}\n',
      'src/Vendor/User.php':
        '<?php\nnamespace Local\\Models;\nfinal class User {}\n',
      'src/App.php': '<?php\nnamespace App;\nuse Vendor\\User;\n',
    })

    const index = await buildMetadataIndex(root)
    expect(
      hasReferenceEdge(
        index.graph,
        'src/main/java/app/App.java',
        'src/main/java/com/external/User.java',
      ),
    ).toBe(false)
    expect(
      hasReferenceEdge(index.graph, 'src/App.php', 'src/Vendor/User.php'),
    ).toBe(false)
    expect(
      hasReferenceEdge(
        index.graph,
        'src/main/java/app/App.java',
        'com/root/RootUser.java',
      ),
    ).toBe(false)
  })

  test('requires the local go.mod module prefix for Go package edges', async () => {
    const root = project({
      'go.mod': 'module example.com/local\n',
      'internal/logging/log.go': 'package logging\n',
      'cmd/main.go':
        'package main\nimport "other.example/project/internal/logging"\n',
    })
    const index = await buildMetadataIndex(root)
    expect(
      hasReferenceEdge(index.graph, 'cmd/main.go', 'internal/logging/log.go'),
    ).toBe(false)
  })

  test('extracts and resolves Java package imports', async () => {
    const root = project({
      'src/main/java/com/acme/User.java':
        'package com.acme;\npublic class User {}\n',
      'src/main/java/com/acme/UserService.java':
        'package com.acme;\nimport com.acme.User;\npublic class UserService {}\n',
    })

    const index = await buildMetadataIndex(root)
    expect(
      index.files['src/main/java/com/acme/UserService.java'].imports,
    ).toContain('com.acme.User')
    expect(
      hasReferenceEdge(
        index.graph,
        'src/main/java/com/acme/UserService.java',
        'src/main/java/com/acme/User.java',
      ),
    ).toBe(true)
  })

  test('extracts and resolves C and GDScript file references', async () => {
    const root = project({
      'src/main.c': '#include "util.h"\n',
      'src/util.h': 'int value(void);\n',
      'scripts/player.gd':
        'const Helpers = preload("res://scripts/helpers.gd")\n',
      'scripts/helpers.gd': 'class_name Helpers\n',
    })

    const index = await buildMetadataIndex(root)
    expect(hasReferenceEdge(index.graph, 'src/main.c', 'src/util.h')).toBe(true)
    expect(
      hasReferenceEdge(index.graph, 'scripts/player.gd', 'scripts/helpers.gd'),
    ).toBe(true)
  })

  test('indexes language-native validation commands from manifests', async () => {
    const root = project({
      'Cargo.toml': '[package]\nname = "demo"\nversion = "0.1.0"\n',
      'pom.xml': '<project></project>\n',
      'service.csproj': '<Project Sdk="Microsoft.NET.Sdk"></Project>\n',
      'project.godot': '[application]\nconfig/name="Demo"\n',
    })

    const index = await buildMetadataIndex(root)
    expect(index.files['Cargo.toml'].concepts).toContain('cargo test')
    expect(index.files['pom.xml'].concepts).toContain('mvn test')
    expect(index.files['service.csproj'].concepts).toContain('dotnet test')
    expect(index.files['project.godot'].concepts).toContain('godot test')
  })

  test('does not resolve Python absolute imports against loose same-named files', async () => {
    const root = project({
      'json.py': 'value = 1\n',
      'main.py': 'import json\n',
    })

    const index = await buildMetadataIndex(root)
    // A bare `import json` with only a loose local json.py must stay
    // unresolved (conservative-unresolved contract).
    expect(hasReferenceEdge(index.graph, 'main.py', 'json.py')).toBe(false)
  })

  test('resolves Python absolute imports under indexed top-level package dirs', async () => {
    const root = project({
      'mypkg/__init__.py': '',
      'mypkg/mod.py': 'def run():\n    pass\n',
      'main.py': 'import mypkg.mod\n',
    })

    const index = await buildMetadataIndex(root)
    expect(hasReferenceEdge(index.graph, 'main.py', 'mypkg/mod.py')).toBe(true)
  })

  test('resolves Rust crate, self and super against the nearest Cargo package', async () => {
    const root = project({
      'Cargo.toml': '[package]\nname = "outer"\nversion = "0.1.0"\n',
      'src/lib.rs': 'mod config;\n',
      'src/config.rs': 'pub struct Outer;\n',
      'crates/inner/Cargo.toml':
        '[package]\nname = "inner"\nversion = "0.1.0"\n',
      'crates/inner/src/lib.rs': 'mod config;\nmod service;\n',
      'crates/inner/src/config.rs': 'pub struct Inner;\n',
      'crates/inner/src/service.rs': 'mod worker;\nmod settings;\n',
      'crates/inner/src/service/settings.rs': 'pub struct Settings;\n',
      'crates/inner/src/service/worker.rs': [
        'use crate::config;',
        'use self::local;',
        'use super::settings;',
        'use super::super::config as root_config;',
        'use super::super::super::outside;',
        'mod local;',
        'mod foreign;',
        'mod ambiguous;',
        'mod outer_only;',
      ].join('\n'),
      'crates/inner/src/service/config.rs': 'pub struct Shadow;\n',
      'crates/inner/src/service/worker/local/mod.rs': 'pub struct Local;\n',
      'crates/inner/src/service/worker/foreign.ts': 'export const decoy = 1\n',
      'crates/inner/src/service/worker/ambiguous.rs': 'pub struct Flat;\n',
      'crates/inner/src/service/worker/ambiguous/mod.rs':
        'pub struct Nested;\n',
      'crates/inner/src/outer_only.rs': 'pub struct WrongScope;\n',
      'crates/inner/outside.rs': 'pub struct Outside;\n',
    })

    const { files, graph } = await buildMetadataIndex(root)
    const worker = 'crates/inner/src/service/worker.rs'
    for (const [specifier, target] of [
      ['crate::config', 'crates/inner/src/config.rs'],
      ['self::local', 'crates/inner/src/service/worker/local/mod.rs'],
      ['super::settings', 'crates/inner/src/service/settings.rs'],
      ['super::super::config', 'crates/inner/src/config.rs'],
      ['local', 'crates/inner/src/service/worker/local/mod.rs'],
    ]) {
      expect(files[worker].imports).toContain(specifier)
      expect(referenceTargets(graph, worker, specifier)).toEqual([
        `file:${target}`,
      ])
    }
    for (const specifier of [
      'super::super::super::outside',
      'foreign',
      'ambiguous',
      'outer_only',
    ]) {
      expect(files[worker].imports).toContain(specifier)
      expect(referenceTargets(graph, worker, specifier)).toEqual([])
    }
  })

  test('does not guess a Rust crate root outside a supported source tree', async () => {
    const root = project({
      'src/lib.rs': 'mod config;\n',
      'src/config.rs': 'pub struct Root;\n',
      'loose/caller.rs': 'use crate::config;\nuse self::config;\n',
      'loose/config.rs': 'pub struct Decoy;\n',
    })
    const { files, graph } = await buildMetadataIndex(root)
    expect(files['loose/caller.rs'].imports).toEqual([
      'crate::config',
      'self::config',
    ])
    for (const specifier of files['loose/caller.rs'].imports) {
      expect(referenceTargets(graph, 'loose/caller.rs', specifier)).toEqual([])
    }
  })

  test('scopes Go package references to the exact directory of the owning module', async () => {
    const root = project({
      'go.mod': 'module example.com/outer\n',
      'service.go': 'package outer\n',
      'main/main.go':
        'package main\nimport "example.com/outer/nested/pkg/single"\n',
      'nested/go.mod': 'module example.com/inner\n',
      'nested/root.go': 'package inner\n',
      'nested/cmd/main.go': [
        'package main',
        'import (',
        '  "example.com/inner"',
        '  "example.com/inner/pkg/single"',
        '  "example.com/inner/pkg/typescript"',
        '  "example.com/inner/missing/pkg/suffix"',
        '  "example.com/inner/pkg/ambiguous"',
        '  "example.com/inner/pkg/testonly"',
        '  "example.com/outer"',
        ')',
      ].join('\n'),
      'nested/pkg/single/source.go': 'package single\n',
      'nested/pkg/single/source_test.go': 'package single\n',
      'pkg/single/outer.go': 'package single\n',
      'nested/pkg/typescript/source.ts': 'export const decoy = 1\n',
      'nested/pkg/suffix/source.go': 'package suffix\n',
      'pkg/suffix/outer.go': 'package suffix\n',
      'nested/pkg/ambiguous/a.go': 'package ambiguous\n',
      'nested/pkg/ambiguous/b.go': 'package ambiguous\n',
      'nested/pkg/testonly/source_test.go': 'package testonly\n',
    })

    const { files, graph } = await buildMetadataIndex(root)
    const caller = 'nested/cmd/main.go'
    for (const [specifier, expected] of [
      ['example.com/inner', ['file:nested/root.go']],
      ['example.com/inner/pkg/single', ['file:nested/pkg/single/source.go']],
      ['example.com/inner/pkg/typescript', []],
      ['example.com/inner/missing/pkg/suffix', []],
      ['example.com/inner/pkg/ambiguous', []],
      ['example.com/inner/pkg/testonly', []],
      ['example.com/outer', []],
    ] as const) {
      expect(files[caller].imports).toContain(specifier)
      expect(referenceTargets(graph, caller, specifier)).toEqual([...expected])
    }
    const childModule = 'example.com/outer/nested/pkg/single'
    expect(files['main/main.go'].imports).toContain(childModule)
    expect(referenceTargets(graph, 'main/main.go', childModule)).toEqual([])
  })

  test('reconciles inbound Go package edges when only the declaration changes', async () => {
    const caller = 'nested/cmd/main.go'
    const target = 'nested/pkg/util/util.go'
    const specifier = 'example.com/inner/pkg/util'
    const library = 'package util\nfunc main() {}\n'
    const root = project({
      'nested/go.mod': 'module example.com/inner\n',
      [caller]: `package main\nimport _ "${specifier}"\nfunc main() {}\n`,
      [target]: library,
    })
    const first = await buildMetadataIndex(root)
    expect(referenceTargets(first.graph, caller, specifier)).toEqual([
      `file:${target}`,
    ])

    const delta = { changedPaths: [target], complete: true }
    writeFileSync(join(root, target), 'package main\nfunc main() {}\n')
    const removed = await updateMetadataIndex(first, root, {}, delta)
    expect(removed.updateStats?.changedFiles).toEqual([target])
    expect(removed.files[caller].imports).toEqual([specifier])
    expect(referenceTargets(removed.graph, caller, specifier)).toEqual([])

    writeFileSync(join(root, target), library)
    const restored = await updateMetadataIndex(removed, root, {}, delta)
    expect(restored.updateStats?.changedFiles).toEqual([target])
    expect(referenceTargets(restored.graph, caller, specifier)).toEqual([
      `file:${target}`,
    ])
  })

  test('only resolves Python imports to exact Python modules and package initializers', async () => {
    const root = project({
      'tsconfig.json': JSON.stringify({
        compilerOptions: { paths: { alias_only: ['./lib/alias.ts'] } },
      }),
      'lib/alias.ts': 'export const decoy = 1\n',
      'pkg/__init__.py': '',
      'pkg/service.py': [
        'from .models import Model',
        'from .rust_only import Rust',
        'from .index_only import Value',
        'from .ambiguous import Value',
        'from . import models',
        'from ..outside import Value',
        'import alias_only',
        'import pkg.rust_only',
        'import pkg',
        'import loose',
      ].join('\n'),
      'pkg/models.pyi': 'class Model: ...\n',
      'pkg/models.ts': 'export class Model {}\n',
      'pkg/rust_only.rs': 'pub struct Rust;\n',
      'pkg/index_only/index.py': 'Value = 1\n',
      'pkg/ambiguous.py': 'Value = 1\n',
      'pkg/ambiguous/__init__.py': 'Value = 2\n',
      'outside.py': 'Value = 1\n',
      'pkg.py': 'Value = 1\n',
      'loose.py': 'Value = 1\n',
      'loose/decoy.ts': 'export const value = 1\n',
    })

    const { files, graph } = await buildMetadataIndex(root)
    const caller = 'pkg/service.py'
    for (const [specifier, expected] of [
      ['.models', ['file:pkg/models.pyi']],
      ['.', ['file:pkg/__init__.py']],
      ['pkg', ['file:pkg/__init__.py']],
      ['.rust_only', []],
      ['pkg.rust_only', []],
      ['.index_only', []],
      ['.ambiguous', []],
      ['..outside', []],
      ['alias_only', []],
      ['loose', []],
    ] as const) {
      expect(files[caller].imports).toContain(specifier)
      expect(referenceTargets(graph, caller, specifier)).toEqual([...expected])
    }
  })
})

describe('Python absolute-import top-level directory guard', () => {
  test('resolves repeatedly against one files snapshot via the memoized top-level set', () => {
    const files: Record<string, ImportResolutionFile> = {
      'pkg/__init__.py': { path: 'pkg/__init__.py', ext: '.py' },
      'pkg/mod.py': { path: 'pkg/mod.py', ext: '.py' },
      'loose.py': { path: 'loose.py', ext: '.py' },
    }
    // The index-build shape: one files snapshot resolved for every import
    // site. Results must be stable across repeated calls on the same snapshot
    // (the memoized top-level-directory set serves every lookup).
    expect(resolveImportToFile('main.py', '.py', 'pkg.mod', files)).toBe(
      'pkg/mod.py',
    )
    expect(resolveImportToFile('main.py', '.py', 'pkg.mod', files)).toBe(
      'pkg/mod.py',
    )
    // A loose same-named top-level file never satisfies an absolute import
    // (conservative-unresolved contract), memoized or not.
    expect(resolveImportToFile('main.py', '.py', 'loose', files)).toBeNull()
  })

  test('does not re-derive the top-level set when the record is mutated in place (documented memoization contract)', () => {
    const files: Record<string, ImportResolutionFile> = {
      'pkg/__init__.py': { path: 'pkg/__init__.py', ext: '.py' },
    }
    expect(resolveImportToFile('main.py', '.py', 'other', files)).toBeNull()
    // Documented on resolveImportToFile: the top-level-directory set is
    // memoized per `files` record object identity; mutating the same record
    // in place between calls is NOT reflected, so a caller that mutates the
    // record must pass a fresh record to see the mutation.
    files['other/__init__.py'] = { path: 'other/__init__.py', ext: '.py' }
    expect(resolveImportToFile('main.py', '.py', 'other', files)).toBeNull()
  })
})

describe('TS module-resolution tier wiring', () => {
  const files: Record<string, ImportResolutionFile> = {
    'src/util.ts': { path: 'src/util.ts', ext: '.ts' },
    'src/stub.ts': { path: 'src/stub.ts', ext: '.ts' },
  }
  const stubResolver = () => 'src/stub.ts'

  test('the relative arm still wins before the injected ts tier', () => {
    expect(
      resolveImportToFile(
        'src/a.ts',
        '.ts',
        './util',
        files,
        undefined,
        stubResolver,
      ),
    ).toBe('src/util.ts')
  })

  test('the injected ts tier resolves what the conservative arms miss', () => {
    expect(
      resolveImportToFile(
        'src/a.ts',
        '.ts',
        '@stub/thing',
        files,
        undefined,
        stubResolver,
      ),
    ).toBe('src/stub.ts')
  })

  test('omitting the resolver keeps conservative behavior byte-identical', () => {
    expect(
      resolveImportToFile('src/a.ts', '.ts', '@stub/thing', files),
    ).toBeNull()
  })

  test('the ts tier is not consulted for non-TS/JS extensions', () => {
    expect(
      resolveImportToFile(
        'src/a.py',
        '.py',
        '@stub/thing',
        files,
        undefined,
        stubResolver,
      ),
    ).toBeNull()
    expect(
      resolveImportToFile(
        'src/main.go',
        '.go',
        '@stub/thing',
        files,
        undefined,
        stubResolver,
      ),
    ).toBeNull()
  })
})
