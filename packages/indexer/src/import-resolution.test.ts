import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { afterAll, describe, expect, test } from 'bun:test'

import { buildMetadataIndex } from './metadata-indexer'

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

  test('does not resolve Rust bare imports across directories', async () => {
    const root = project({
      'src/config.rs': 'pub struct Config;\n',
      'src/bin/tool.rs': 'mod config;\n',
      'src/bin/other.rs': 'use crate::config;\n',
    })

    const index = await buildMetadataIndex(root)
    // A bare `mod config;` must not match a same-named module in another
    // directory; only the importing file's own directory counts.
    expect(
      hasReferenceEdge(index.graph, 'src/bin/tool.rs', 'src/config.rs'),
    ).toBe(false)
    // An explicit crate:: path from the same directory still reaches the
    // crate-root module structure.
    expect(
      hasReferenceEdge(index.graph, 'src/bin/other.rs', 'src/config.rs'),
    ).toBe(true)
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
})
