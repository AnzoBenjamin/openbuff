import * as fs from 'node:fs'
import * as path from 'node:path'

import ignore from 'ignore'
import { isMandatorySensitiveReadPath } from '@codebuff/common/util/sensitive-paths'
import { THREE_D_ASSET_EXTENSIONS } from '@codebuff/common/util/file'

const DEFAULT_EXCLUDE_DIRS = new Set([
  'node_modules',
  '.bun-install',
  '.git',
  'dist',
  'build',
  '.next',
  '.nuxt',
  '.output',
  '.turbo',
  'coverage',
  '.cache',
  '.codebuff-index',
  '.omx',
  'tmp',
  '.tmp',
  'out',
])

const MAX_FILE_SIZE = 500_000 // 500KB for text parsing
const DEFAULT_MAX_FILES = 20_000

function isGeneratedOperationalArtifact(relativePath: string): boolean {
  return (
    relativePath === '.agents/sessions' ||
    relativePath.startsWith('.agents/sessions/') ||
    relativePath === '.openbuff/artifacts' ||
    relativePath.startsWith('.openbuff/artifacts/') ||
    /^evals\/buffbench\/[^/]+-base2-lite-error-[^/]+\.json$/i.test(relativePath)
  )
}

export interface WalkProjectResult {
  files: WalkedFile[]
  truncated: boolean
  maxFiles: number
  skippedFiles: number
  skippedPrefixes: string[]
}

/**
 * Binary file extensions that should be skipped during indexing. These files
 * are either binary assets (game engine, 3D models, textures, audio) or
 * file types that cannot be meaningfully parsed as UTF-8 text. Skipping them
 * avoids corrupting the indexer with garbage from binary-reading-as-text and
 * keeps the file count budget available for source files.
 *
 * Game engine binary formats: .uasset, .umap, .assets, .fbx, .obj, .dae,
 * .3ds, .blend. Unity .meta/.prefab/.unity are NOT here — they are YAML text
 * in Unity's text serialization mode and are parsed for asset references.
 *
 * Standard binary/media formats already handled by the size filter or the
 * truncation filter are included here too for defense-in-depth at the walk
 * stage so they never even get stat'd or hashed.
 */
export const BINARY_EXTENSIONS = new Set([
  // Game engine binary asset formats. Unity .meta/.prefab/.unity are
  // intentionally NOT here — they are text (YAML) in Unity's text
  // serialization mode and are parsed for asset references by the indexer.
  '.uasset',
  '.umap',
  '.assets',
  '.fbx',
  '.obj',
  '.dae',
  '.3ds',
  '.blend',
  '.glb',
  '.gltf',
  '.stl',
  '.ply',
  '.usd',
  '.usda',
  '.usdc',
  '.usdz',

  // Image / texture formats
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
  '.psd',
  '.exr',
  '.hdr',

  // Audio formats
  '.mp3',
  '.wav',
  '.ogg',
  '.flac',
  '.aac',
  '.m4a',
  '.wma',
  '.opus',

  // Video formats
  '.mp4',
  '.mov',
  '.avi',
  '.mkv',
  '.webm',
  '.wmv',
  '.flv',

  // 3D / animation binary formats
  '.anim',
  '.controller',
  '.mat',
  '.cub',
  '.physicmaterial',

  // Compiled / packaged formats
  '.class',
  '.jar',
  '.war',
  '.dll',
  '.lib',
  '.exe',
  '.so',
  '.dylib',
  '.o',
  '.a',

  // Compressed archives
  '.zip',
  '.tar',
  '.gz',
  '.rar',
  '.7z',
  '.bz2',
  '.xz',
  '.dmg',
  '.iso',
  '.pkg',
  '.deb',
  '.rpm',

  // Binary containers
  '.pdf',
  '.docx',
  '.xlsx',
  '.pptx',
  '.epub',
  '.sqlite',
  '.db',
  '.bin',
  '.dat',
])

export interface WalkedFile {
  absolutePath: string
  relativePath: string
  ext: string
  mtime: number
  size: number
  asset?: { kind: '3d'; format: string }
}

export async function walkProject(
  projectRoot: string,
  extraExclude: string[] = [],
): Promise<WalkedFile[]> {
  return (await walkProjectDetailed(projectRoot, extraExclude)).files
}

type ScopedMatcher = { base: string; matcher: ReturnType<typeof ignore> }

/**
 * Stat specific relative paths without walking the project tree.
 * Applies the same exclusion policy and per-file filters as
 * {@link walkProjectDetailed}: ancestor `.gitignore` / `.openbuffignore` /
 * `.codebuffignore` patterns, `ignore()`-style `extraExclude` globs,
 * basename/prefix excludes, default exclude dirs, size/binary/3D, sensitive,
 * and generated operational artifacts.
 */
export async function statProjectFiles(
  projectRoot: string,
  relativePaths: string[],
  extraExclude: string[] = [],
): Promise<WalkedFile[]> {
  const normalizedExtraExclude = extraExclude.map((item) =>
    normalizeRelativePath(item),
  )
  const extraExcludeSet = new Set(
    normalizedExtraExclude.map((item) => item.replace(/\/$/, '')),
  )
  // Cache directory matchers across stated paths (O(depth) per unique dir).
  const directoryMatcherCache = new Map<string, ScopedMatcher>()
  const results: WalkedFile[] = []
  for (const rawPath of relativePaths) {
    const relativePath = normalizeRelativePath(rawPath).replace(/^\.\//, '')
    if (!relativePath) continue
    if (
      path.isAbsolute(rawPath) ||
      path.isAbsolute(relativePath) ||
      relativePath.startsWith('/') ||
      relativePath.split('/').includes('..')
    ) {
      continue
    }
    if (
      isMandatorySensitiveReadPath(relativePath) ||
      isGeneratedOperationalArtifact(relativePath) ||
      isExtraExcludedPath(relativePath, extraExcludeSet) ||
      (await isIgnoredLikeWalk(
        projectRoot,
        relativePath,
        normalizedExtraExclude,
        extraExcludeSet,
        directoryMatcherCache,
      ))
    ) {
      continue
    }
    const absolutePath = path.join(projectRoot, relativePath)
    // P8.6: lstat (not stat) so symlink entries are skipped instead of
    // followed, matching the recursive walk's no-follow semantics — an
    // out-of-project symlink must not be stat'd/hashed as an in-project file.
    let stat: fs.Stats
    try {
      stat = await fs.promises.lstat(absolutePath)
    } catch {
      continue
    }
    // stat-only checks like isFile() are skipped for symlinks entirely: a
    // symlink to a regular file inside the project would still be indexed
    // through its target's content, which the walk's readdir no-follow
    // contract does not do (readdir classifies symlinks as neither
    // isFile() nor isDirectory()).
    if (stat.isSymbolicLink()) continue
    if (!stat.isFile()) continue
    const ext = path.extname(relativePath).toLowerCase()
    const is3dAsset = THREE_D_ASSET_EXTENSIONS.has(ext)
    if (stat.size > MAX_FILE_SIZE && !is3dAsset) continue
    if (BINARY_EXTENSIONS.has(ext) && !is3dAsset) continue
    results.push({
      absolutePath,
      relativePath,
      ext,
      mtime: stat.mtimeMs,
      size: stat.size,
      ...(is3dAsset
        ? { asset: { kind: '3d' as const, format: ext.slice(1) } }
        : {}),
    })
  }
  return results
}

function isExtraExcludedPath(
  relativePath: string,
  extraExcludeSet: Set<string>,
): boolean {
  const segments = relativePath.split('/')
  for (const exclude of extraExcludeSet) {
    if (!exclude) continue
    if (relativePath === exclude || relativePath.startsWith(`${exclude}/`)) {
      return true
    }
    if (!exclude.includes('/') && segments.includes(exclude)) {
      return true
    }
  }
  return false
}

/**
 * Apply walkProjectDetailed ignore semantics for a single relative path:
 * load ancestor ignore files from projectRoot (O(depth), no tree walk) and
 * evaluate `ignore()` matchers the same way the recursive walk does.
 */
function isIgnoredLikeWalk(
  projectRoot: string,
  relativePath: string,
  extraExclude: string[],
  extraExcludeSet: Set<string>,
  directoryMatcherCache: Map<string, ScopedMatcher>,
): Promise<boolean> {
  return (async () => {
    const segments = relativePath.split('/').filter(Boolean)
    if (segments.length === 0) return true

    let currentAbs = projectRoot
    const parents: ScopedMatcher[] = []

    for (let i = 0; i < segments.length; i++) {
      const name = segments[i]!
      const isLast = i === segments.length - 1

      if (!isLast) {
        if (DEFAULT_EXCLUDE_DIRS.has(name) || extraExcludeSet.has(name)) {
          return true
        }
      }

      let directoryMatcher = directoryMatcherCache.get(currentAbs)
      if (!directoryMatcher) {
        directoryMatcher = {
          base: currentAbs,
          matcher: ignore().add([
            ...(await loadDirectoryIgnorePatterns(currentAbs)),
            ...(currentAbs === projectRoot ? extraExclude : []),
          ]),
        }
        directoryMatcherCache.set(currentAbs, directoryMatcher)
      }

      const matchers = [...parents, directoryMatcher]
      const abs = path.join(currentAbs, name)
      const ignored = matchers.some(({ base, matcher }) => {
        const scoped = normalizeRelativePath(path.relative(base, abs))
        return scoped && matcher.ignores(isLast ? scoped : `${scoped}/`)
      })
      if (ignored) return true

      if (!isLast) {
        parents.push(directoryMatcher)
        currentAbs = abs
      }
    }

    return false
  })()
}

export async function walkProjectDetailed(
  projectRoot: string,
  extraExclude: string[] = [],
  maxFiles = DEFAULT_MAX_FILES,
): Promise<WalkProjectResult> {
  const extraExcludeSet = new Set(extraExclude)
  const candidatesByPrefix = new Map<string, WalkedFile[]>()
  const eligibleCountsByPrefix = new Map<string, number>()

  // Per-prefix candidate cap (reliability finding
  // per-prefix-cap-equals-max-files): each top-level prefix bucket is capped
  // at a fair share of maxFiles instead of maxFiles itself, so a wide
  // monorepo cannot accumulate O(prefixes x maxFiles) candidate entries per
  // refresh. Discovering a new prefix tightens the shared cap and trims
  // existing buckets from the tail; bucket heads are always retained so the
  // round-robin trim below keeps its truncation-fairness semantics.
  const sharedPrefixCap = (): number =>
    Math.max(1, Math.ceil(maxFiles / Math.max(1, candidatesByPrefix.size)))
  const trimPrefixBuckets = (cap: number): void => {
    for (const [prefix, bucket] of candidatesByPrefix) {
      if (bucket.length > cap) {
        candidatesByPrefix.set(prefix, bucket.slice(0, cap))
      }
    }
  }

  type ScopedMatcher = { base: string; matcher: ReturnType<typeof ignore> }

  async function walk(dir: string, parents: ScopedMatcher[]): Promise<void> {
    // No-follow guard at the recursion point (reliability finding
    // walk-dir-swap-after-lstat-window): the caller's lstat re-verify and
    // this readdir are separate path-based operations, so a directory
    // swapped to an out-of-project symlink between them must be refused
    // HERE — this is the last check before any traversal into its bytes.
    // Cheap (one lstat per directory visited), ENOENT tolerated (vanished
    // mid-walk is skipped like any other disappearance).
    try {
      const dirStat = await fs.promises.lstat(dir)
      if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) return
    } catch {
      return
    }
    let entries: fs.Dirent[]
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }

    entries.sort((a, b) => a.name.localeCompare(b.name))
    const directoryMatcher = ignore().add([
      ...(await loadDirectoryIgnorePatterns(dir)),
      ...(dir === projectRoot ? extraExclude : []),
    ])
    const matchers = [...parents, { base: dir, matcher: directoryMatcher }]
    for (const entry of entries) {
      const abs = path.join(dir, entry.name)
      const rel = normalizeRelativePath(path.relative(projectRoot, abs))
      const ignored = matchers.some(({ base, matcher }) => {
        const scoped = normalizeRelativePath(path.relative(base, abs))
        return (
          scoped && matcher.ignores(entry.isDirectory() ? `${scoped}/` : scoped)
        )
      })

      if (entry.isDirectory()) {
        if (
          DEFAULT_EXCLUDE_DIRS.has(entry.name) ||
          extraExcludeSet.has(entry.name) ||
          isGeneratedOperationalArtifact(rel)
        ) {
          continue
        }
        if (ignored) continue
        // P8.6 follow-up (reliability finding walk-dir-symlink-toctou):
        // re-verify the directory entry with lstat before recursing — a path
        // swapped from directory to out-of-project symlink between readdir
        // and the recursive readdir must not be followed (the walk's
        // documented no-follow contract). A vanished entry is skipped like
        // any other mid-walk disappearance.
        try {
          const dirStat = await fs.promises.lstat(abs)
          if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) continue
        } catch {
          continue
        }
        await walk(abs, matchers)
      } else if (entry.isFile()) {
        if (
          ignored ||
          isMandatorySensitiveReadPath(rel) ||
          isGeneratedOperationalArtifact(rel)
        )
          continue
        let stat: fs.Stats
        try {
          // P8.6: lstat (not stat) so a symlink swapped in between readdir
          // and stat is skipped instead of followed, matching the
          // statProjectFiles no-follow contract. An entry that vanished
          // mid-walk lands in the catch below and is skipped.
          stat = await fs.promises.lstat(abs)
        } catch {
          continue
        }
        if (stat.isSymbolicLink()) continue
        if (!stat.isFile()) continue
        const ext = path.extname(entry.name).toLowerCase()
        const is3dAsset = THREE_D_ASSET_EXTENSIONS.has(ext)
        if (stat.size > MAX_FILE_SIZE && !is3dAsset) continue
        if (BINARY_EXTENSIONS.has(ext) && !is3dAsset) continue
        const prefix = rel.includes('/') ? (rel.split('/')[0] ?? rel) : '<root>'
        eligibleCountsByPrefix.set(
          prefix,
          (eligibleCountsByPrefix.get(prefix) ?? 0) + 1,
        )
        let prefixCandidates = candidatesByPrefix.get(prefix)
        if (!prefixCandidates) {
          // A newly discovered prefix tightens everyone's fair share.
          trimPrefixBuckets(
            Math.max(1, Math.ceil(maxFiles / (candidatesByPrefix.size + 1))),
          )
          prefixCandidates = []
        }
        if (prefixCandidates.length >= sharedPrefixCap()) continue
        prefixCandidates.push({
          absolutePath: abs,
          relativePath: normalizeRelativePath(rel),
          ext,
          mtime: stat.mtimeMs,
          size: stat.size,
          ...(is3dAsset
            ? { asset: { kind: '3d' as const, format: ext.slice(1) } }
            : {}),
        })
        candidatesByPrefix.set(prefix, prefixCandidates)
      }
    }
  }

  await walk(projectRoot, [])
  const prefixes = [...candidatesByPrefix.keys()].sort()
  const offsets = new Map(prefixes.map((prefix) => [prefix, 0]))
  const results: WalkedFile[] = []
  while (results.length < maxFiles) {
    let added = false
    for (const prefix of prefixes) {
      if (results.length >= maxFiles) break
      const offset = offsets.get(prefix) ?? 0
      const candidate = candidatesByPrefix.get(prefix)?.[offset]
      if (!candidate) continue
      results.push(candidate)
      offsets.set(prefix, offset + 1)
      added = true
    }
    if (!added) break
  }
  const eligibleFiles = [...eligibleCountsByPrefix.values()].reduce(
    (sum, count) => sum + count,
    0,
  )
  const skippedFiles = Math.max(0, eligibleFiles - results.length)
  const skippedPrefixes = prefixes.filter(
    (prefix) =>
      (eligibleCountsByPrefix.get(prefix) ?? 0) > (offsets.get(prefix) ?? 0),
  )
  return {
    files: results,
    truncated: skippedFiles > 0,
    maxFiles,
    skippedFiles,
    skippedPrefixes,
  }
}

async function loadIgnorePatterns(filePath: string): Promise<string[]> {
  try {
    const content = await fs.promises.readFile(filePath, 'utf8')
    return content
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'))
  } catch {
    return []
  }
}

/**
 * Load all three per-directory ignore files concurrently (reliability finding
 * synchronous-readfile-per-directory-in-async-walk): the async walk issues
 * one awaited batch per directory instead of three blocking readFileSync
 * syscalls that interleave with awaited stats.
 */
async function loadDirectoryIgnorePatterns(dir: string): Promise<string[]> {
  const [gitignore, openbuffignore, codebuffignore] = await Promise.all([
    loadIgnorePatterns(path.join(dir, '.gitignore')),
    loadIgnorePatterns(path.join(dir, '.openbuffignore')),
    loadIgnorePatterns(path.join(dir, '.codebuffignore')),
  ])
  return [...gitignore, ...openbuffignore, ...codebuffignore]
}

export function normalizeRelativePath(relativePath: string): string {
  return relativePath.replace(/\\/g, '/')
}
