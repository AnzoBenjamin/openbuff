import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

import { resolveProjectPath } from '@codebuff/common/util/project-path-containment'

export type BuildGraphConfidence = 'confirmed' | 'inferred' | 'unknown'

export type BuildGraphTargetKind =
  | 'package'
  | 'crate'
  | 'module'
  | 'project'
  | 'target'

export type BuildGraphTarget = {
  name: string
  kind: BuildGraphTargetKind
  root: string
  testCommand?: string
  buildCommand?: string
}

export type OwningTargetResolution = {
  file: string
  ecosystem: string
  targets: BuildGraphTarget[]
  confidence: BuildGraphConfidence
}

/**
 * Command-runner seam for ecosystem build tools (`cargo metadata`, `go list`).
 * Tests inject a fake; the default spawns the tool with a bounded timeout,
 * mirroring `toolVersion` in harness-intelligence.ts.
 */
export type BuildGraphRunner = (
  argv: string[],
  cwd: string,
) => { exitCode: number; stdout: string; stderr: string }

const maxFilesPerCall = 500
const runnerTimeoutMs = 10_000
// `cargo metadata` output is large even with --no-deps; bound it generously
// but finitely so a runaway tool cannot exhaust memory.
const runnerMaxBufferBytes = 16 * 1024 * 1024

const defaultBuildGraphRunner: BuildGraphRunner = (argv, cwd) => {
  if (argv.length === 0) {
    return { exitCode: 1, stdout: '', stderr: 'empty argv' }
  }
  const result = spawnSync(argv[0], argv.slice(1), {
    cwd,
    encoding: 'utf8',
    timeout: runnerTimeoutMs,
    maxBuffer: runnerMaxBufferBytes,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  return {
    exitCode: typeof result.status === 'number' ? result.status : 1,
    stdout: result.stdout ?? '',
    stderr: result.error
      ? `${result.stderr ?? ''}${result.error.message}`
      : (result.stderr ?? ''),
  }
}

type IndexedTarget = BuildGraphTarget & {
  ecosystem: string
  confidence: BuildGraphConfidence
}

const ignoredDiscoveryDirectories = new Set([
  '.git',
  '.hg',
  '.svn',
  'node_modules',
  'target',
  'dist',
  'build',
  'out',
  '.next',
  '.turbo',
  '.cache',
  '.venv',
  'venv',
  '__pycache__',
])

const discoveredFileNames = new Set([
  'package.json',
  'pom.xml',
  'build.gradle',
  'build.gradle.kts',
  'CMakeLists.txt',
  'pyproject.toml',
  'setup.py',
  'bun.lock',
  'bun.lockb',
  'pnpm-lock.yaml',
  'yarn.lock',
  'package-lock.json',
])

/**
 * Mirrors `discoverNamedFiles` in harness-intelligence.ts, collecting only the
 * manifests/lockfiles the build-graph resolvers key on.
 */
function discoverBuildGraphFiles(root: string): string[] {
  // Iterative walk with hard caps on depth and visited directories: an
  // unbounded recursion can stack-overflow or stall the main thread on a
  // pathological/deep tree (security review F3). Symlinks are skipped, so
  // hard-linked loops are the remaining risk, bounded by the visit cap.
  const MAX_WALK_DEPTH = 12
  const MAX_VISITED_DIRS = 2_000
  const found: string[] = []
  const stack: Array<{ directory: string; depth: number }> = [
    { directory: root, depth: 0 },
  ]
  let visited = 0
  while (stack.length > 0) {
    const current = stack.pop()
    if (!current) break
    if (visited++ >= MAX_VISITED_DIRS) break
    if (current.depth > MAX_WALK_DEPTH) continue
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(current.directory, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue
      const absolute = path.join(current.directory, entry.name)
      if (entry.isDirectory()) {
        if (!ignoredDiscoveryDirectories.has(entry.name)) {
          stack.push({ directory: absolute, depth: current.depth + 1 })
        }
      } else if (
        discoveredFileNames.has(entry.name) ||
        entry.name.endsWith('.csproj')
      ) {
        found.push(path.relative(root, absolute).replace(/\\/g, '/'))
      }
    }
  }
  return found.sort()
}

function directoryName(root: string, directory: string): string {
  return directory === '.' ? path.basename(root) : path.posix.basename(directory)
}

/**
 * Whitelist for identifiers interpolated into testCommand/buildCommand
 * strings (cargo package names, go import paths, module dirs, manifest
 * paths). Security review F4: these values come from dependency manifests /
 * tool output and are attacker-controlled; a future consumer that runs a
 * command string through a shell must never see a shell metacharacter. These
 * strings must only ever be executed as argv arrays, never via a shell.
 * The colon is allowed for Gradle project paths (`:libs:ui:test`); it is not
 * a shell command separator (`;`, `&`, `|` are the separators to exclude).
 */
const SAFE_COMMAND_TOKEN = /^[A-Za-z0-9._~/:-]+$/
function safeCommandToken(value: string): string | undefined {
  return SAFE_COMMAND_TOKEN.test(value) ? value : undefined
}

/**
 * Project-relative, POSIX-separator form of an absolute tool-reported
 * directory, or undefined when it escapes the project root.
 */
function relativeDirWithin(
  root: string,
  absoluteDir: string,
): string | undefined {
  const relative = path.relative(root, absoluteDir).replace(/\\/g, '/')
  if (relative === '') return '.'
  if (
    relative === '..' ||
    relative.startsWith('../') ||
    path.isAbsolute(relative)
  ) {
    return undefined
  }
  return relative
}

/**
 * Rust: `cargo metadata --no-deps --format-version 1`. Parses only the needed
 * fields and tolerates missing ones; an absent/failing cargo is an honest
 * skip (no filesystem guessing at crate names).
 */
function resolveCargoTargets(
  root: string,
  runner: BuildGraphRunner,
): IndexedTarget[] {
  const output = runner(
    ['cargo', 'metadata', '--no-deps', '--format-version', '1'],
    root,
  )
  if (output.exitCode !== 0) return []
  let packages: unknown
  try {
    packages = (JSON.parse(output.stdout) as { packages?: unknown }).packages
  } catch {
    return []
  }
  if (!Array.isArray(packages)) return []
  const targets: IndexedTarget[] = []
  for (const pkg of packages) {
    if (typeof pkg !== 'object' || pkg === null) continue
    const { name, manifest_path } = pkg as {
      name?: unknown
      manifest_path?: unknown
    }
    if (typeof name !== 'string' || name.length === 0) continue
    if (typeof manifest_path !== 'string' || manifest_path.length === 0)
      continue
    const directory = relativeDirWithin(root, path.dirname(manifest_path))
    if (directory === undefined) continue
    const safeName = safeCommandToken(name)
    targets.push({
      ecosystem: 'rust',
      confidence: 'confirmed',
      name,
      kind: 'crate',
      root: directory,
      ...(safeName
        ? {
            testCommand: `cargo test -p ${safeName}`,
            buildCommand: `cargo build -p ${safeName}`,
          }
        : {}),
    })
  }
  return targets
}

/** `go list -json ./...` emits a stream of concatenated JSON objects, not an array. */
function parseJsonObjectStream(text: string): unknown[] {
  const objects: unknown[] = []
  let depth = 0
  let start = -1
  let inString = false
  let escaped = false
  for (let index = 0; index < text.length; index++) {
    const char = text[index]
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') {
      inString = true
    } else if (char === '{') {
      if (depth === 0) start = index
      depth++
    } else if (char === '}') {
      depth--
      if (depth === 0 && start >= 0) {
        try {
          objects.push(JSON.parse(text.slice(start, index + 1)))
        } catch {
          /* skip the malformed object, keep the rest of the stream */
        }
        start = -1
      }
    }
  }
  return objects
}

/** Go: `go list -json ./...` (ImportPath, Dir) -> owning package. */
function resolveGoTargets(
  root: string,
  runner: BuildGraphRunner,
): IndexedTarget[] {
  const output = runner(['go', 'list', '-json', './...'], root)
  if (output.exitCode !== 0) return []
  const targets: IndexedTarget[] = []
  for (const object of parseJsonObjectStream(output.stdout)) {
    if (typeof object !== 'object' || object === null) continue
    const { ImportPath, Dir } = object as {
      ImportPath?: unknown
      Dir?: unknown
    }
    if (typeof ImportPath !== 'string' || ImportPath.length === 0) continue
    if (typeof Dir !== 'string' || Dir.length === 0) continue
    const directory = relativeDirWithin(root, Dir)
    if (directory === undefined) continue
    const safeImport = safeCommandToken(ImportPath)
    targets.push({
      ecosystem: 'go',
      confidence: 'confirmed',
      name: ImportPath,
      kind: 'package',
      root: directory,
      ...(safeImport
        ? {
            testCommand: `go test ${safeImport}`,
            buildCommand: `go build ${safeImport}`,
          }
        : {}),
    })
  }
  return targets
}

const jsManagerLockfiles = [
  ['bun.lock', 'bun'],
  ['bun.lockb', 'bun'],
  ['pnpm-lock.yaml', 'pnpm'],
  ['yarn.lock', 'yarn'],
  ['package-lock.json', 'npm'],
] as const

/** Mirrors the `closest` ancestor walk in harness-intelligence.ts `inferWorkspace`. */
function closestDiscoveredFile(
  files: Set<string>,
  directory: string,
  names: readonly string[],
): string | undefined {
  let current = directory
  while (true) {
    for (const name of names) {
      const candidate = current === '.' ? name : `${current}/${name}`
      if (files.has(candidate)) return candidate
    }
    if (current === '.') return undefined
    const parent = path.posix.dirname(current)
    current = parent === current ? '.' : parent
  }
}

/**
 * JS/TS: package.json workspace discovery, mirroring the workspace inference
 * pattern in harness-intelligence.ts (nearest ancestor lockfile decides the
 * manager and confirms it; `packageManager` field confirms; otherwise npm is
 * inferred). Commands come from the owning package's scripts.
 */
function resolveJavaScriptTargets(
  root: string,
  discovered: string[],
): IndexedTarget[] {
  const discoveredSet = new Set(discovered)
  const targets: IndexedTarget[] = []
  for (const manifest of discovered) {
    if (path.posix.basename(manifest) !== 'package.json') continue
    const directory = path.posix.dirname(manifest)
    let manager: string | undefined
    let confidence: BuildGraphConfidence = 'inferred'
    for (const [lockfile, lockfileManager] of jsManagerLockfiles) {
      if (closestDiscoveredFile(discoveredSet, directory, [lockfile])) {
        manager = lockfileManager
        confidence = 'confirmed'
        break
      }
    }
    let name = directoryName(root, directory)
    let testCommand: string | undefined
    let buildCommand: string | undefined
    try {
      const parsed = JSON.parse(
        fs.readFileSync(path.join(root, manifest), 'utf8'),
      ) as {
        name?: string
        packageManager?: string
        scripts?: Record<string, unknown>
      }
      if (parsed.name) name = parsed.name
      if (!manager && parsed.packageManager) {
        manager = parsed.packageManager.split('@')[0]
        confidence = 'confirmed'
      }
      const resolvedManager = manager ?? 'npm'
      if (typeof parsed.scripts?.test === 'string') {
        testCommand = `${resolvedManager} run test`
      }
      if (typeof parsed.scripts?.build === 'string') {
        buildCommand = `${resolvedManager} run build`
      }
    } catch {
      confidence = 'unknown'
    }
    targets.push({
      ecosystem: 'javascript',
      confidence,
      name,
      kind: 'package',
      root: directory,
      ...(testCommand ? { testCommand } : {}),
      ...(buildCommand ? { buildCommand } : {}),
    })
  }
  return targets
}

/** Java/JVM: pom.xml / gradle module dirs, inferred from the filesystem only. */
function resolveJvmTargets(
  root: string,
  discovered: string[],
): IndexedTarget[] {
  const targets: IndexedTarget[] = []
  for (const manifest of discovered) {
    const base = path.posix.basename(manifest)
    const directory = path.posix.dirname(manifest)
    if (base === 'pom.xml') {
      const safeDir = safeCommandToken(directory)
      targets.push({
        ecosystem: 'java',
        confidence: 'inferred',
        name: directoryName(root, directory),
        kind: 'module',
        root: directory,
        ...(safeDir
          ? {
              testCommand: `mvn -pl ${safeDir} test`,
              buildCommand: `mvn -pl ${safeDir} package`,
            }
          : {}),
      })
    } else if (base === 'build.gradle' || base === 'build.gradle.kts') {
      const gradlePath =
        directory === '.' ? '' : `:${directory.split('/').join(':')}`
      const safeGradle =
        directory === '.' ? '' : safeCommandToken(gradlePath)
      targets.push({
        ecosystem: 'jvm',
        confidence: 'inferred',
        name: directory === '.' ? ':' : gradlePath,
        kind: 'module',
        root: directory,
        ...(safeGradle !== undefined
          ? {
              testCommand: `gradle ${safeGradle}:test`,
              buildCommand: `gradle ${safeGradle}:build`,
            }
          : {}),
      })
    }
  }
  return targets
}

/** C#: .csproj dirs -> `dotnet test/build <csproj>`. */
function resolveDotnetTargets(discovered: string[]): IndexedTarget[] {
  const targets: IndexedTarget[] = []
  for (const manifest of discovered) {
    if (!manifest.endsWith('.csproj')) continue
    const safeManifest = safeCommandToken(manifest)
    targets.push({
      ecosystem: 'dotnet',
      confidence: 'inferred',
      name: path.posix.basename(manifest),
      kind: 'project',
      root: path.posix.dirname(manifest),
      ...(safeManifest
        ? {
            testCommand: `dotnet test ${safeManifest}`,
            buildCommand: `dotnet build ${safeManifest}`,
          }
        : {}),
    })
  }
  return targets
}

/** C/C++: CMakeLists.txt dirs -> owning CMake project dir. */
function resolveCMakeTargets(
  root: string,
  discovered: string[],
): IndexedTarget[] {
  const targets: IndexedTarget[] = []
  for (const manifest of discovered) {
    if (path.posix.basename(manifest) !== 'CMakeLists.txt') continue
    const directory = path.posix.dirname(manifest)
    targets.push({
      ecosystem: 'c-cpp',
      confidence: 'inferred',
      name: directoryName(root, directory),
      kind: 'project',
      root: directory,
      // No commands: the configured build directory cannot be known from
      // discovery alone, so guessing one would be dishonest.
    })
  }
  return targets
}

/** Python: nearest pyproject.toml/setup.py -> package root. */
function resolvePythonTargets(
  root: string,
  discovered: string[],
): IndexedTarget[] {
  const targets: IndexedTarget[] = []
  const claimed = new Set<string>()
  for (const manifest of discovered) {
    const base = path.posix.basename(manifest)
    if (base !== 'pyproject.toml' && base !== 'setup.py') continue
    const directory = path.posix.dirname(manifest)
    if (claimed.has(directory)) continue
    claimed.add(directory)
    targets.push({
      ecosystem: 'python',
      confidence: 'inferred',
      name: directoryName(root, directory),
      kind: 'package',
      root: directory,
      testCommand:
        directory === '.'
          ? 'python -m pytest'
          : `python -m pytest ${directory}`,
    })
  }
  return targets
}

/**
 * Per-cwd cache of ecosystem target detection. Tool probes (`cargo metadata`,
 * `go list`) and the manifest walk are the expensive parts and change far
 * more slowly than source files, so a short TTL keeps repeat calls cheap
 * while still picking up newly added targets. Mirrors the discoveryCache
 * pattern in harness-intelligence.ts.
 */
const buildGraphCacheTtlMs = 5_000
const buildGraphCacheMaxEntries = 32
const buildGraphCache = new Map<
  string,
  { expiresAt: number; targets: IndexedTarget[] }
>()

/** Drop every cached target index (tests, and callers that just scaffolded a workspace). */
export function clearBuildGraphCache(): void {
  buildGraphCache.clear()
}

function buildTargetIndex(
  root: string,
  runner: BuildGraphRunner,
): IndexedTarget[] {
  let discovered: string[] | undefined
  const discover = () => (discovered ??= discoverBuildGraphFiles(root))
  // A failing or slow ecosystem tool must never break resolution of the
  // other ecosystems: each resolver is isolated and contributes nothing when
  // its tool is absent or its output unusable.
  const resolvers: Array<() => IndexedTarget[]> = [
    () => resolveCargoTargets(root, runner),
    () => resolveGoTargets(root, runner),
    () => resolveJavaScriptTargets(root, discover()),
    () => resolveJvmTargets(root, discover()),
    () => resolveDotnetTargets(discover()),
    () => resolveCMakeTargets(root, discover()),
    () => resolvePythonTargets(root, discover()),
  ]
  const targets: IndexedTarget[] = []
  for (const resolve of resolvers) {
    try {
      targets.push(...resolve())
    } catch {
      /* honest skip: this ecosystem contributes nothing */
    }
  }
  return targets
}

function cachedTargetIndex(
  root: string,
  runner: BuildGraphRunner,
): IndexedTarget[] {
  const now = Date.now()
  const cached = buildGraphCache.get(root)
  if (cached && cached.expiresAt > now) return cached.targets
  const targets = buildTargetIndex(root, runner)
  buildGraphCache.delete(root)
  if (buildGraphCache.size >= buildGraphCacheMaxEntries) {
    const oldest = buildGraphCache.keys().next()
    if (!oldest.done) buildGraphCache.delete(oldest.value)
  }
  buildGraphCache.set(root, {
    expiresAt: now + buildGraphCacheTtlMs,
    targets,
  })
  return targets
}

/**
 * Project-relative, POSIX-separator forms of `files`, dropping anything that
 * is not an in-project path. Mirrors `toProjectRelativeFiles` in
 * harness-intelligence.ts, including the owned-temp scope rejection.
 */
function toProjectRelativeFiles(cwd: string, files: string[]): string[] {
  return files.flatMap((file) => {
    const resolved = resolveProjectPath(cwd, file)
    return resolved && resolved.scope === 'project'
      ? [resolved.relativePath.replace(/\\/g, '/')]
      : []
  })
}

function ownsFile(targetRoot: string, file: string): boolean {
  return (
    targetRoot === '.' ||
    file === targetRoot ||
    file.startsWith(`${targetRoot}/`)
  )
}

const confidenceRank: Record<BuildGraphConfidence, number> = {
  unknown: 0,
  inferred: 1,
  confirmed: 2,
}

/**
 * Map source files to their owning build targets. Ownership is the
 * longest-prefix match across every ecosystem's target roots; ties break
 * toward higher-confidence detections. A file no target owns resolves to
 * `{ targets: [], confidence: 'unknown' }`.
 */
export function resolveOwningTargets(params: {
  cwd: string
  files: string[]
  runner?: BuildGraphRunner
}): OwningTargetResolution[] {
  const root = path.resolve(params.cwd)
  const index = cachedTargetIndex(root, params.runner ?? defaultBuildGraphRunner)
  const files = toProjectRelativeFiles(
    root,
    params.files.slice(0, maxFilesPerCall),
  )
  return files.map((file) => {
    let best: IndexedTarget | undefined
    for (const target of index) {
      if (!ownsFile(target.root, file)) continue
      if (
        best &&
        (best.root.length > target.root.length ||
          (best.root.length === target.root.length &&
            confidenceRank[best.confidence] >= confidenceRank[target.confidence]))
      ) {
        continue
      }
      best = target
    }
    if (!best) {
      return { file, ecosystem: 'unknown', targets: [], confidence: 'unknown' }
    }
    const { ecosystem, confidence, ...target } = best
    return { file, ecosystem, targets: [target], confidence }
  })
}
