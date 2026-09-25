import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { describe, expect, spyOn, test } from 'bun:test'

import {
  BINARY_EXTENSIONS,
  normalizeRelativePath,
  statProjectFiles,
  walkProject,
  walkProjectDetailed,
} from './file-walker'

// ---------------------------------------------------------------------------
// BINARY_EXTENSIONS set
// ---------------------------------------------------------------------------

describe('file-walker BINARY_EXTENSIONS', () => {
  test('is a non-empty Set of lowercase strings starting with a dot', () => {
    expect(BINARY_EXTENSIONS).toBeInstanceOf(Set)
    expect(BINARY_EXTENSIONS.size).toBeGreaterThan(0)
    for (const ext of BINARY_EXTENSIONS) {
      expect(typeof ext).toBe('string')
      expect(ext.startsWith('.')).toBe(true)
      expect(ext).toBe(ext.toLowerCase())
    }
  })

  test('includes game engine binary asset formats', () => {
    for (const ext of [
      '.uasset',
      '.umap',
      '.assets',
      '.fbx',
      '.obj',
      '.dae',
      '.3ds',
      '.blend',
    ]) {
      expect(BINARY_EXTENSIONS.has(ext)).toBe(true)
    }
  })

  test('includes standard image formats', () => {
    for (const ext of [
      '.png',
      '.jpg',
      '.jpeg',
      '.gif',
      '.bmp',
      '.tiff',
      '.tif',
      '.webp',
      '.ico',
      '.svg',
      '.dds',
      '.tga',
    ]) {
      expect(BINARY_EXTENSIONS.has(ext)).toBe(true)
    }
  })

  test('includes audio, video, and animation binary formats', () => {
    for (const ext of [
      '.mp3',
      '.wav',
      '.ogg',
      '.flac',
      '.mp4',
      '.mov',
      '.avi',
      '.mkv',
      '.webm',
      '.anim',
      '.controller',
      '.mat',
    ]) {
      expect(BINARY_EXTENSIONS.has(ext)).toBe(true)
    }
  })

  test('includes compiled, archive, and binary container formats', () => {
    for (const ext of [
      '.class',
      '.jar',
      '.war',
      '.dll',
      '.lib',
      '.exe',
      '.so',
      '.dylib',
      '.zip',
      '.tar',
      '.gz',
      '.rar',
      '.7z',
      '.pdf',
      '.docx',
      '.xlsx',
      '.sqlite',
      '.db',
      '.bin',
      '.dat',
    ]) {
      expect(BINARY_EXTENSIONS.has(ext)).toBe(true)
    }
  })

  test('does NOT include Unity text serialization formats (.meta, .prefab, .unity)', () => {
    // These are YAML text in Unity's text serialization mode — they need to be
    // indexed as text so the asset reference extractor can parse them.
    expect(BINARY_EXTENSIONS.has('.meta')).toBe(false)
    expect(BINARY_EXTENSIONS.has('.prefab')).toBe(false)
    expect(BINARY_EXTENSIONS.has('.unity')).toBe(false)
  })

  test('does NOT include Godot text formats (.tscn, .tres, .gd)', () => {
    expect(BINARY_EXTENSIONS.has('.tscn')).toBe(false)
    expect(BINARY_EXTENSIONS.has('.tres')).toBe(false)
    expect(BINARY_EXTENSIONS.has('.gd')).toBe(false)
  })

  test('does NOT include Unreal .uproject (JSON text)', () => {
    expect(BINARY_EXTENSIONS.has('.uproject')).toBe(false)
  })

  test('does NOT include source code or config extensions', () => {
    for (const ext of [
      '.ts',
      '.tsx',
      '.js',
      '.jsx',
      '.py',
      '.java',
      '.cs',
      '.rs',
      '.go',
      '.rb',
      '.php',
      '.swift',
      '.kt',
      '.md',
      '.json',
      '.yaml',
      '.yml',
      '.toml',
    ]) {
      expect(BINARY_EXTENSIONS.has(ext)).toBe(false)
    }
  })
})

test('canonicalizes Windows-style relative paths for portable graph keys', () => {
  expect(normalizeRelativePath('packages\\indexer\\src\\query.ts')).toBe(
    'packages/indexer/src/query.ts',
  )
})

// ---------------------------------------------------------------------------
// walkProject binary skip behavior
// ---------------------------------------------------------------------------

async function makeTempProject(files: Record<string, string>): Promise<string> {
  const root = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), 'codebuff-walker-'),
  )
  for (const [relativePath, content] of Object.entries(files)) {
    const absolutePath = path.join(root, relativePath)
    await fs.promises.mkdir(path.dirname(absolutePath), { recursive: true })
    await fs.promises.writeFile(absolutePath, content, 'utf8')
  }
  return root
}

describe('file-walker walkProject', () => {
  test('applies nested ignore files and mandatory sensitive-path policy', async () => {
    const root = await makeTempProject({
      'src/keep.ts': 'export const keep = true\n',
      'src/.gitignore': 'ignored.ts\n',
      'src/ignored.ts': 'export const secret = true\n',
      'src/.openbuffignore': 'private/\n',
      'src/private/data.ts': 'private\n',
      '.env': 'TOKEN=secret\n',
      '.env.example': 'TOKEN=example\n',
      id_ed25519: 'private key\n',
    })

    const paths = (await walkProject(root)).map((file) => file.relativePath)
    expect(paths).toContain('src/keep.ts')
    expect(paths).toContain('.env.example')
    expect(paths).not.toContain('src/ignored.ts')
    expect(paths).not.toContain('src/private/data.ts')
    expect(paths).not.toContain('.env')
    expect(paths).not.toContain('id_ed25519')
  })

  test('excludes generated operational artifacts by default', async () => {
    const root = await makeTempProject({
      '.agents/sessions/a/findings.md': 'stale audit\n',
      '.agents/custom-agent.ts': 'export default {}\n',
      '.omx/plans/plan.md': 'generated plan\n',
      '.openbuff/artifacts/3d/metadata/hash.json': '{}\n',
      'evals/buffbench/task-base2-lite-error-ab12.json': '{}\n',
      'src/main.ts': 'export const main = true\n',
    })
    expect((await walkProject(root)).map((file) => file.relativePath)).toEqual([
      '.agents/custom-agent.ts',
      'src/main.ts',
    ])
  })

  test('reports deterministic partial coverage when maxFiles is reached', async () => {
    const root = await makeTempProject({
      'a/1.ts': '1',
      'b/2.ts': '2',
      'c/3.ts': '3',
    })
    const result = await walkProjectDetailed(root, [], 2)
    expect(result.files.map((file) => file.relativePath)).toEqual([
      'a/1.ts',
      'b/2.ts',
    ])
    expect(result.truncated).toBe(true)
    expect(result.skippedFiles).toBe(1)
    expect(result.skippedPrefixes).toEqual(['c'])
  })

  test('allocates capped coverage fairly across top-level prefixes', async () => {
    const root = await makeTempProject({
      'a/1.ts': '1',
      'a/2.ts': '2',
      'a/3.ts': '3',
      'b/1.ts': '1',
      'c/1.ts': '1',
    })
    const result = await walkProjectDetailed(root, [], 3)
    expect(result.files.map((file) => file.relativePath)).toEqual([
      'a/1.ts',
      'b/1.ts',
      'c/1.ts',
    ])
    expect(result.skippedPrefixes).toEqual(['a'])
  })

  test('caps per-prefix candidates below maxFiles so memory stays O(maxFiles)', async () => {
    // Regression for the M4-S6 per-prefix cap finding: a wide monorepo with
    // many top-level prefixes must not accumulate O(prefixes x maxFiles)
    // candidate entries per refresh. With 20 files per prefix across 10
    // prefixes (200 files) and maxFiles=20, the total returned set is still
    // capped at 20 and each prefix contributes an equal fair share.
    const files: Record<string, string> = {}
    for (let prefix = 0; prefix < 10; prefix++) {
      for (let i = 0; i < 20; i++) {
        files[`p${prefix}/file-${i}.ts`] = '1'
      }
    }
    const root = await makeTempProject(files)

    const result = await walkProjectDetailed(root, [], 20)
    expect(result.files).toHaveLength(20)
    const perPrefix = new Map<string, number>()
    for (const file of result.files) {
      const prefix = file.relativePath.split('/')[0]!
      perPrefix.set(prefix, (perPrefix.get(prefix) ?? 0) + 1)
    }
    // Round-robin fairness holds across all 10 prefixes.
    expect(perPrefix.size).toBe(10)
    for (const count of perPrefix.values()) {
      expect(count).toBe(2)
    }
    expect(result.truncated).toBe(true)
    expect(result.skippedFiles).toBe(180)
  })

  test('reads ignore files through async fs (no blocking readFileSync during the walk)', async () => {
    // Regression for the M4-S6 async-ignore-reads finding: loadIgnorePatterns
    // must use fs.promises.readFile so the async walk does not issue blocking
    // syscalls that interleave with awaited stats.
    const root = await makeTempProject({
      'src/keep.ts': 'export const keep = true\n',
      'src/skipped.ts': 'export const skipped = true\n',
      'src/.gitignore': 'skipped.ts\n',
    })
    const realReadFile = fs.promises.readFile
    let syncReadFileSyncUsed = false
    const readFileSpy = spyOn(fs.promises, 'readFile').mockImplementation(
      (async (
        pathLike: Parameters<typeof realReadFile>[0],
        options?: Parameters<typeof realReadFile>[1],
      ) => {
        return realReadFile(
          pathLike,
          options as Parameters<typeof realReadFile>[1],
        )
      }) as typeof fs.promises.readFile,
    )
    // The ignore loader must NOT call the blocking fs.readFileSync while the
    // async walk runs; the sync API is spied (same pattern as the lstat TOCTOU
    // test below) so any sync ignore read is observable.
    const realReadFileSync = fs.readFileSync
    const readFileSyncSpy = spyOn(fs, 'readFileSync').mockImplementation(
      // The single-purpose mock is cast to the spied signature so the
      // multi-overload arm is also satisfied (TS2345 otherwise), mirroring the
      // lstat spy's documented cast.
      ((
        filePath: Parameters<typeof realReadFileSync>[0],
        options?: Parameters<typeof realReadFileSync>[1],
      ) => {
        const target = String(filePath)
        if (
          target.endsWith('.gitignore') ||
          target.endsWith('.openbuffignore') ||
          target.endsWith('.codebuffignore')
        ) {
          syncReadFileSyncUsed = true
        }
        return realReadFileSync(filePath, options)
      }) as unknown as typeof fs.readFileSync,
    )

    try {
      const files = await walkProject(root)
      const relPaths = files.map((file) => file.relativePath)
      // Ignore semantics are unchanged through the async path.
      expect(relPaths).toContain('src/keep.ts')
      expect(relPaths).not.toContain('src/skipped.ts')
      // The async reader WAS used for the ignore files...
      expect(
        readFileSpy.mock.calls.some((call) =>
          String(call[0]).endsWith('.gitignore'),
        ),
      ).toBe(true)
      // ...and the blocking sync API never touched an ignore file.
      expect(syncReadFileSyncUsed).toBe(false)
    } finally {
      readFileSpy.mockRestore()
      readFileSyncSpy.mockRestore()
    }
  })
  test('keeps 3D assets as metadata-only candidates and skips other binaries', async () => {
    const root = await makeTempProject({
      'src/main.ts': 'export const x = 1\n',
      'assets/player.png': '\x89PNG fake binary\n',
      'assets/model.fbx': 'binary fbx data\n',
      'assets/scene.uasset': 'unreal binary\n',
    })

    const files = await walkProject(root)
    const relPaths = files.map((f) => f.relativePath)
    expect(relPaths).toContain('src/main.ts')
    expect(relPaths).not.toContain('assets/player.png')
    expect(relPaths).toContain('assets/model.fbx')
    expect(
      files.find((file) => file.relativePath === 'assets/model.fbx')?.asset,
    ).toEqual({
      kind: '3d',
      format: 'fbx',
    })
    expect(relPaths).not.toContain('assets/scene.uasset')
  })

  test('includes Unity text serialization files (.meta, .prefab, .unity)', async () => {
    const root = await makeTempProject({
      'Assets/Main.unity': '%YAML 1.1\n--- !u!1001\n',
      'Assets/Player.prefab.meta': 'guid: abc123\n',
      'Assets/Player.prefab': '%YAML 1.1\n--- \n',
    })

    const files = await walkProject(root)
    const relPaths = files.map((f) => f.relativePath)
    expect(relPaths).toContain('Assets/Main.unity')
    expect(relPaths).toContain('Assets/Player.prefab.meta')
    expect(relPaths).toContain('Assets/Player.prefab')
  })

  test('includes Godot text files (.tscn, .tres, .gd)', async () => {
    const root = await makeTempProject({
      'Scenes/Main.tscn': '[ext_resource path="res://player.png" ...]\n',
      'Scripts/player.gd': 'extends Node2D\n',
      'Resources/health.tres': '[resource]\n',
    })

    const files = await walkProject(root)
    const relPaths = files.map((f) => f.relativePath)
    expect(relPaths).toContain('Scenes/Main.tscn')
    expect(relPaths).toContain('Scripts/player.gd')
    expect(relPaths).toContain('Resources/health.tres')
  })

  test('includes Unreal .uproject (JSON text)', async () => {
    const root = await makeTempProject({
      'MyGame.uproject': '{"Modules": [{"Name": "MyGame"}]}\n',
    })

    const files = await walkProject(root)
    const relPaths = files.map((f) => f.relativePath)
    expect(relPaths).toContain('MyGame.uproject')
  })

  test('returns WalkedFile with ext as lowercase', async () => {
    const root = await makeTempProject({
      'src/Index.TS': 'export const x = 1\n',
      'data/config.JSON': '{}\n',
    })

    const files = await walkProject(root)
    const tsFile = files.find((f) => f.relativePath === 'src/Index.TS')
    const jsonFile = files.find((f) => f.relativePath === 'data/config.JSON')
    expect(tsFile?.ext).toBe('.ts')
    expect(jsonFile?.ext).toBe('.json')
  })

  test('walks an empty directory and returns []', async () => {
    const root = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), 'codebuff-walker-'),
    )
    const files = await walkProject(root)
    expect(files).toEqual([])
  })
})

describe('file-walker statProjectFiles', () => {
  test('stats only the requested paths and applies walker filters', async () => {
    const root = await makeTempProject({
      'src/keep.ts': 'export const keep = true\n',
      'src/missing-neighbor.ts': 'export const gone = true\n',
      'assets/player.png': '\x89PNG fake binary\n',
      'assets/model.fbx': 'binary fbx data\n',
      '.env': 'TOKEN=secret\n',
      '.agents/sessions/a/findings.md': 'stale audit\n',
    })
    await fs.promises.unlink(path.join(root, 'src/missing-neighbor.ts'))

    const files = await statProjectFiles(root, [
      'src/keep.ts',
      'src/missing-neighbor.ts',
      'assets/player.png',
      'assets/model.fbx',
      '.env',
      '.agents/sessions/a/findings.md',
      'src/does-not-exist.ts',
    ])
    const relPaths = files.map((file) => file.relativePath)
    expect(relPaths).toEqual(['src/keep.ts', 'assets/model.fbx'])
    expect(
      files.find((file) => file.relativePath === 'assets/model.fbx')?.asset,
    ).toEqual({
      kind: '3d',
      format: 'fbx',
    })
  })

  test('rejects absolute paths and parent-directory segments', async () => {
    const root = await makeTempProject({
      'src/keep.ts': 'export const keep = true\n',
    })
    const files = await statProjectFiles(root, [
      '/etc/passwd',
      '../secret.ts',
      'src/../../etc/passwd',
      'src/keep.ts',
    ])
    const relPaths = files.map((file) => file.relativePath)
    expect(relPaths).toEqual(['src/keep.ts'])
    expect(relPaths).not.toContain('/etc/passwd')
    expect(relPaths).not.toContain('../secret.ts')
    expect(relPaths).not.toContain('src/../../etc/passwd')
  })

  test('honors extraExclude (basename, prefix, and ignore-style globs) and skips gitignored paths', async () => {
    const root = await makeTempProject({
      'src/keep.ts': 'export const keep = true\n',
      'src/skip-me.ts': 'export const skip = true\n',
      'vendor/lib/hidden.ts': 'export const vendor = true\n',
      'logs/app.log': 'log line\n',
      'tmp-data/cache.ts': 'export const cache = true\n',
      '.gitignore': 'logs/\n',
      'src/.gitignore': 'skip-me.ts\n',
      'src/.openbuffignore': 'nested-secret.ts\n',
      'src/nested-secret.ts': 'export const secret = true\n',
      '.codebuffignore': '*.tmp.ts\n',
      'scratch.tmp.ts': 'export const tmp = true\n',
    })

    const files = await statProjectFiles(
      root,
      [
        'src/keep.ts',
        'src/skip-me.ts',
        'vendor/lib/hidden.ts',
        'logs/app.log',
        'tmp-data/cache.ts',
        'src/nested-secret.ts',
        'scratch.tmp.ts',
      ],
      ['vendor', 'tmp-data/', 'scratch.tmp.ts'],
    )
    const relPaths = files.map((file) => file.relativePath)

    // Kept: not excluded by basename, prefix, ignore globs, or gitignore.
    expect(relPaths).toEqual(['src/keep.ts'])

    // Nested gitignore (basename pattern via .gitignore).
    expect(relPaths).not.toContain('src/skip-me.ts')
    // Root .gitignore directory pattern.
    expect(relPaths).not.toContain('logs/app.log')
    // Nested .openbuffignore.
    expect(relPaths).not.toContain('src/nested-secret.ts')
    // Root .codebuffignore glob (also listed in extraExclude).
    expect(relPaths).not.toContain('scratch.tmp.ts')
    // extraExclude basename / prefix (same policy as walkProjectDetailed).
    expect(relPaths).not.toContain('vendor/lib/hidden.ts')
    expect(relPaths).not.toContain('tmp-data/cache.ts')

    // Walk agrees on the same exclusion set for these paths.
    const walked = await walkProject(root, [
      'vendor',
      'tmp-data/',
      'scratch.tmp.ts',
    ])
    const walkedPaths = walked.map((file) => file.relativePath)
    expect(walkedPaths).toContain('src/keep.ts')
    expect(walkedPaths).not.toContain('src/skip-me.ts')
    expect(walkedPaths).not.toContain('logs/app.log')
    expect(walkedPaths).not.toContain('src/nested-secret.ts')
    expect(walkedPaths).not.toContain('scratch.tmp.ts')
    expect(walkedPaths).not.toContain('vendor/lib/hidden.ts')
    expect(walkedPaths).not.toContain('tmp-data/cache.ts')
  })

  test('walkProjectDetailed does not follow file symlinks (shared no-follow policy)', async () => {
    const root = await makeTempProject({
      'src/real.ts': 'export const real = 1\n',
    })
    // A symlink (swapped in between readdir and stat in the TOCTOU window, or
    // simply present on disk) must be skipped, not stat'd/hashed through its
    // target — matching statProjectFiles' P8.6 lstat contract.
    try {
      await fs.promises.symlink(
        path.join(root, 'src/real.ts'),
        path.join(root, 'src/link.ts'),
        'file',
      )
    } catch {
      // Platform cannot create symlinks (e.g. Windows without privileges):
      // the no-follow assertion is untestable here, so skip.
      return
    }
    const result = await walkProjectDetailed(root)
    const paths = result.files.map((file) => file.relativePath)
    expect(paths).toContain('src/real.ts')
    expect(paths).not.toContain('src/link.ts')
  })

  test('walkProjectDetailed skips entries that vanish between readdir and stat', async () => {
    const root = await makeTempProject({
      'src/keep.ts': 'export const keep = 1\n',
    })
    // Simulate a vanished entry by removing the file after building the tree
    // shape: a missing file must be skipped (ENOENT on lstat) without failing
    // the walk or inventing an entry.
    await fs.promises.unlink(path.join(root, 'src/keep.ts'))
    const result = await walkProjectDetailed(root)
    expect(result.files).toEqual([])
    expect(result.truncated).toBe(false)
  })

  test('skips a directory entry that lstat re-verify resolves to a symlink before recursion (dir-swap TOCTOU)', async () => {
    // Reliability finding walk-dir-swap-to-symlink-test-gap: the per-entry
    // lstat re-verify before recursion must refuse a directory that was
    // swapped to an out-of-project symlink inside the TOCTOU window.
    //
    // readdir(withFileTypes) reports the entry's on-disk type, so a STATIC
    // symlink fixture would be filtered at the entry-type check and never
    // reach the re-verify. Instead we simulate the race directly: the entry
    // passes the readdir type check (it really was a directory), but by the
    // time the walker lstats it again before recursing, it resolves to a
    // symlink pointing outside the project root.
    const root = await makeTempProject({
      'child/marker.ts': 'export const marker = 1\n',
      'src/keep.ts': 'export const keep = 1\n',
    })
    const outside = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), 'codebuff-walker-outside-'),
    )
    try {
      await fs.promises.writeFile(
        path.join(outside, 'outside-secret.ts'),
        'export const secret = 1\n',
        'utf8',
      )

      const childAbs = path.join(root, 'child')
      const realLstat = fs.promises.lstat.bind(fs.promises)
      const swappedStat = {
        isSymbolicLink: () => true,
        isDirectory: () => false,
        isFile: () => false,
      } as unknown as fs.Stats
      // The lstat overloads return Stats or BigIntStats depending on opts;
      // cast the single-purpose mock to the spied signature so the bigint
      // overload arm is also satisfied (TS2345 otherwise).
      const lstatSpy = spyOn(fs.promises, 'lstat').mockImplementation((async (
        p: fs.PathLike,
      ) =>
        p === childAbs
          ? swappedStat
          : await realLstat(p)) as unknown as typeof fs.promises.lstat)

      try {
        const result = await walkProjectDetailed(root)
        const paths = result.files.map((file) => file.relativePath)
        // Unaffected files are still walked.
        expect(paths).toContain('src/keep.ts')
        // The swapped entry is skipped — neither its in-project contents nor
        // anything reachable through the out-of-project target leaks in.
        expect(paths).not.toContain('child/marker.ts')
        expect(paths).not.toContain('outside-secret.ts')
      } finally {
        lstatSpy.mockRestore()
      }
    } finally {
      await fs.promises.rm(outside, { recursive: true, force: true })
    }
  })
})
