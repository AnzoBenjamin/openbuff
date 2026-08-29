import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { dirname, relative, resolve, sep, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

export type Finding = {
  path: string
  line: number
  message: string
}

export type CheckerResult = {
  name: string
  findings: Finding[]
}

export type MemoryDriftGuardResult = {
  score: number
  checkers: CheckerResult[]
}

const SKIP_DIRECTORIES = new Set([
  '.bun-install',
  '.git',
  '.next',
  '.omx',
  'build',
  'coverage',
  'dist',
  'node_modules',
  'web',
])

const SKIP_PATH_PREFIXES = [
  '.agents/sessions/',
  '.kimchi/',
  '.omx/',
  'packages/billing/',
  'packages/bigquery/',
  'evals/test-repos/',
]

const PATH_QUOTED_REGEX =
  /`((?:src|packages|cli|common|sdk|agents|scripts|docs)\/[A-Za-z0-9._\/-]+\.[A-Za-z]+)`/g

const COMMAND_REGEX =
  /bun\s+(?:--cwd[=\s]+[^\s]+\s+)?run\s+(?:--cwd[=\s]+[^\s]+\s+)?([a-zA-Z0-9:_-]+)/g

const DEPENDENCY_REGEX =
  /from ['"](@codebuff\/[a-z0-9-]+|@openbuff\/[a-z0-9-]+)['"]/g

const CROSS_FILE_LINK_REGEX = /\[[^\]]+\]\((\.[^)]+\.md)\)/g

const BROKEN_LINK_REGEX = /\[[^\]]+\]\(([^)#][^)]*?)(?:#[^)]*)?\)/g

const SCRIPT_COVERAGE_IGNORE = new Set([
  'byok-wording-guard.ts',
  'memory-drift-guard.ts',
  'index.ts',
])

function projectRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..')
}

function toProjectPath(root: string, path: string): string {
  return relative(root, path).split(sep).join('/')
}

function shouldSkipPath(projectPath: string): boolean {
  return SKIP_PATH_PREFIXES.some((prefix) => projectPath.startsWith(prefix))
}

function* markdownFiles(root: string, directory = root): Generator<string> {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolutePath = resolve(directory, entry.name)
    const projectPath = toProjectPath(root, absolutePath)

    if (entry.isDirectory()) {
      if (
        SKIP_DIRECTORIES.has(entry.name) ||
        shouldSkipPath(projectPath + '/')
      ) {
        continue
      }
      yield* markdownFiles(root, absolutePath)
      continue
    }

    if (!entry.isFile() || shouldSkipPath(projectPath)) {
      continue
    }

    if (entry.name.endsWith('.md') || entry.name.endsWith('.mdx')) {
      yield absolutePath
    }
  }
}

function readLines(filePath: string): string[] {
  return readFileSync(filePath, 'utf8').split('\n')
}

function loadPackageJson(root: string, subdir: string): any {
  const pkgPath = join(root, subdir, 'package.json')
  if (!existsSync(pkgPath)) {
    return undefined
  }
  try {
    return JSON.parse(readFileSync(pkgPath, 'utf8'))
  } catch (err) {
    console.debug(
      `[memory-drift-guard] loadPackageJson failed for ${pkgPath}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    )
    return undefined
  }
}

function nearestPackageJsonSubdir(root: string, filePath: string): string {
  let dir = dirname(filePath)
  while (dir.startsWith(root)) {
    if (existsSync(join(dir, 'package.json'))) {
      const rel = relative(root, dir)
      return rel === '' ? '.' : rel.split(sep).join('/')
    }
    const parent = dirname(dir)
    if (parent === dir) {
      break
    }
    dir = parent
  }
  return '.'
}

function scriptMissingInPkg(pkg: any | undefined, scriptName: string): boolean {
  if (!pkg || typeof pkg !== 'object') {
    return true
  }
  const scripts = pkg.scripts
  return !scripts || typeof scripts !== 'object' || !(scriptName in scripts)
}

function dependencyExists(root: string, pkgName: string): boolean {
  const rootPkg = loadPackageJson(root, '.')
  if (rootPkg) {
    const deps = {
      ...(rootPkg.dependencies || {}),
      ...(rootPkg.devDependencies || {}),
      ...(rootPkg.peerDependencies || {}),
    }
    if (pkgName in deps) {
      return true
    }
    const workspaces: string[] = rootPkg.workspaces
      ? Array.isArray(rootPkg.workspaces)
        ? rootPkg.workspaces
        : rootPkg.workspaces.packages || []
      : []
    for (const ws of workspaces) {
      const cleaned = ws.replace(/\/\*$/, '')
      const wsPath = join(root, cleaned, 'package.json')
      if (existsSync(wsPath)) {
        try {
          const wsPkg = JSON.parse(readFileSync(wsPath, 'utf8'))
          if (wsPkg.name === pkgName) {
            return true
          }
        } catch (err) {
          console.debug(
            `[memory-drift-guard] workspace pkg parse failed for ${wsPath}: ${
              err instanceof Error ? err.message : String(err)
            }`,
          )
        }
      }
    }
  }

  if (pkgName.startsWith('@codebuff/') || pkgName.startsWith('@openbuff/')) {
    const localName = pkgName.split('/')[1]
    const pkgDir = join(root, 'packages', localName)
    if (existsSync(join(pkgDir, 'package.json'))) {
      return true
    }
  }
  return false
}

export function checkPath(root: string): Finding[] {
  const findings: Finding[] = []
  for (const filePath of markdownFiles(root)) {
    const projectPath = toProjectPath(root, filePath)
    const lines = readLines(filePath)
    lines.forEach((line, index) => {
      PATH_QUOTED_REGEX.lastIndex = 0
      let match: RegExpExecArray | null
      while ((match = PATH_QUOTED_REGEX.exec(line)) !== null) {
        const quoted = match[1]
        if (!existsSync(join(root, quoted))) {
          findings.push({
            path: projectPath,
            line: index + 1,
            message: `referenced path \`${quoted}\` does not exist`,
          })
        }
      }
    })
  }
  return findings
}

export function checkEdges(root: string): Finding[] {
  const findings: Finding[] = []
  for (const filePath of markdownFiles(root)) {
    const base = filePath.split(sep).pop() || ''
    if (base !== 'knowledge.md' && !base.endsWith('.knowledge.md')) {
      continue
    }
    const projectPath = toProjectPath(root, filePath)
    const lines = readLines(filePath)
    let inSection = false
    lines.forEach((line, index) => {
      if (line.startsWith('## ')) {
        const heading = line.slice(3).toLowerCase()
        inSection =
          heading.includes('architecture') ||
          heading.includes('key areas') ||
          heading.includes('key directories')
        return
      }
      if (!inSection) {
        return
      }
      const bulletDirRegex = /- `([A-Za-z0-9._\/-]+)`/g
      let m: RegExpExecArray | null
      while ((m = bulletDirRegex.exec(line)) !== null) {
        const dirName = m[1]
        if (dirName.includes('.')) {
          continue
        }
        if (!existsSync(join(root, dirName))) {
          findings.push({
            path: projectPath,
            line: index + 1,
            message: `architectural directory \`${dirName}\` does not exist`,
          })
        }
      }
    })
  }
  return findings
}

export function checkIndexSync(root: string): Finding[] {
  const findings: Finding[] = []
  const indexFiles = ['AGENTS.md', 'ROUTER.md', 'agents/patterns/INDEX.md']
  for (const indexFile of indexFiles) {
    const abs = join(root, indexFile)
    if (!existsSync(abs)) {
      continue
    }
    const projectPath = indexFile
    const lines = readLines(abs)
    const linkRegex = /\[[^\]]+\]\(([^)]+)\)/g
    const quotedRegex =
      /`((?:src|packages|cli|common|sdk|agents|scripts|docs)\/[A-Za-z0-9._\/-]+(?:\.[A-Za-z]+)?)`/g
    lines.forEach((line, index) => {
      linkRegex.lastIndex = 0
      let m: RegExpExecArray | null
      while ((m = linkRegex.exec(line)) !== null) {
        const target = m[1]
        if (
          target.startsWith('http://') ||
          target.startsWith('https://') ||
          target.startsWith('#')
        ) {
          continue
        }
        if (!existsSync(join(root, target))) {
          findings.push({
            path: projectPath,
            line: index + 1,
            message: `index references missing file ${target}`,
          })
        }
      }
      quotedRegex.lastIndex = 0
      while ((m = quotedRegex.exec(line)) !== null) {
        const target = m[1]
        if (!existsSync(join(root, target))) {
          findings.push({
            path: projectPath,
            line: index + 1,
            message: `index references missing path ${target}`,
          })
        }
      }
    })
  }
  return findings
}

export function checkStaleness(root: string): Finding[] {
  const candidates: Array<{
    filePath: string
    projectPath: string
    srcRelative: string
    topic: string
    base: string
  }> = []
  for (const filePath of markdownFiles(root)) {
    const base = filePath.split(sep).pop() || ''
    if (base !== 'knowledge.md' && !base.endsWith('.knowledge.md')) {
      continue
    }
    const dir = dirname(filePath)
    const siblingSrc = join(dir, 'src')
    if (!existsSync(siblingSrc)) {
      continue
    }
    const projectPath = toProjectPath(root, filePath)
    const srcRelative = toProjectPath(root, siblingSrc)
    const topic = base.endsWith('.knowledge.md')
      ? base.slice(0, -'.knowledge.md'.length)
      : ''
    candidates.push({ filePath, projectPath, srcRelative, topic, base })
  }
  if (candidates.length === 0) return []
  try {
    // Batch git worktree-dirty checks: one `git status` for all knowledge
    // paths instead of one per knowledge.md (spawns scale with files, not
    // knowledge.md count). Batch commit-timestamp lookups by deduplicating
    // pathspecs so repeated src/ or knowledge.md paths do not respawn git.
    const dirtySet = batchDirtySet(
      root,
      candidates.map((c) => c.projectPath),
    )
    const plainSrcPaths = [
      ...new Set(
        candidates.filter((c) => c.topic === '').map((c) => c.srcRelative),
      ),
    ]
    const knowledgePaths = [...new Set(candidates.map((c) => c.projectPath))]
    const plainSrcEpochs = batchLastCommitEpochs(root, plainSrcPaths)
    const mdEpochs = batchLastCommitEpochs(root, knowledgePaths)
    const topicEpochs = new Map<string, number | null>()
    const topicKeys = [
      ...new Set(
        candidates
          .filter((c) => c.topic !== '')
          .map((c) => `${c.srcRelative}\0${c.topic}`),
      ),
    ]
    for (const key of topicKeys) {
      const separator = key.indexOf('\0')
      const srcRel = key.slice(0, separator)
      const topic = key.slice(separator + 1)
      topicEpochs.set(key, lastCommitEpochForTopic(root, srcRel, topic))
    }
    const findings: Finding[] = []
    for (const c of candidates) {
      if (dirtySet.has(c.projectPath)) continue
      const lastCommitMd = mdEpochs.get(c.projectPath) ?? null
      const lastCommitSource =
        c.topic === ''
          ? (plainSrcEpochs.get(c.srcRelative) ?? null)
          : (topicEpochs.get(`${c.srcRelative}\0${c.topic}`) ?? null)
      if (lastCommitSource === null || lastCommitMd === null) continue
      if (lastCommitSource > lastCommitMd) {
        findings.push({
          path: c.projectPath,
          line: 1,
          message:
            c.topic === ''
              ? `knowledge.md last commit is older than sibling src/ last commit (stale)`
              : `\`${c.base}\` last commit is older than last topic-relevant \`${c.srcRelative}\` commit (stale)`,
        })
      }
    }
    return findings
  } catch (err) {
    console.debug(
      `[memory-drift-guard] checkStaleness git lookup failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    )
    return []
  }
}

function batchLastCommitEpochs(
  root: string,
  pathspecs: string[],
): Map<string, number | null> {
  const out = new Map<string, number | null>()
  for (const ps of pathspecs) out.set(ps, lastCommitEpoch(root, ps))
  return out
}

function batchDirtySet(root: string, pathspecs: string[]): Set<string> {
  if (pathspecs.length === 0) return new Set()
  try {
    const stdout = execFileSync(
      'git',
      ['status', '--porcelain', '--', ...pathspecs],
      {
        cwd: root,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    )
    const dirty = new Set<string>()
    for (const line of stdout.split('\n')) {
      if (!line.trim()) continue
      const m = line.match(/^..\s+(.*)$/)
      if (!m) continue
      let p = m[1].trim()
      if (p.startsWith('"') && p.endsWith('"')) p = p.slice(1, -1)
      const arrow = p.indexOf(' -> ')
      if (arrow !== -1) p = p.slice(arrow + 4)
      dirty.add(p)
    }
    return dirty
  } catch {
    return new Set()
  }
}

/**
 * Returns the epoch seconds of the most recent git commit touching `pathspec`,
 * or `null` if git is unavailable or the path is untracked/unknown.
 *
 * `pathspec` is project-relative (e.g. `common/src` or `common/knowledge.md`).
 * `git log -1 --format=%ct -- <pathspec>` returns the committer timestamp;
 * for a directory it resolves to the last commit that touched any file under
 * that directory. Empty stdout means the path is untracked or nonexistent.
 */
function lastCommitEpoch(root: string, pathspec: string): number | null {
  let stdout: string
  try {
    stdout = execFileSync(
      'git',
      ['log', '-1', '--format=%ct', '--', pathspec],
      {
        cwd: root,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    )
  } catch {
    return null
  }
  const trimmed = stdout.trim()
  if (trimmed === '') {
    return null
  }
  const epoch = Number.parseInt(trimmed, 10)
  return Number.isFinite(epoch) ? epoch : null
}

/**
 * Returns the epoch seconds of the most recent git commit touching a
 * topic-relevant path under `srcRelative`, or `null` when git fails or no such
 * path exists in history (empty stdout — same fail-open signal as
 * `lastCommitEpoch`).
 *
 * Two `:(glob,icase)` pathspecs are needed because `*` never crosses `/`:
 * one matches the topic inside a file name (`cli/src/tmux-runner.ts`), the
 * other matches it inside a directory name (`cli/src/tmux/session.ts`).
 * Each pathspec is a separate argv element — `execFileSync` does not use a
 * shell, so quoting them would make the quotes literal and match nothing.
 */
function lastCommitEpochForTopic(
  root: string,
  srcRelative: string,
  topic: string,
): number | null {
  let stdout: string
  try {
    stdout = execFileSync(
      'git',
      [
        'log',
        '-1',
        '--format=%ct',
        '--',
        `:(glob,icase)${srcRelative}/**/*${topic}*`,
        `:(glob,icase)${srcRelative}/**/*${topic}*/**`,
      ],
      {
        cwd: root,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    )
  } catch {
    return null
  }
  const trimmed = stdout.trim()
  if (trimmed === '') {
    return null
  }
  const epoch = Number.parseInt(trimmed, 10)
  return Number.isFinite(epoch) ? epoch : null
}

function pathHasWorkingTreeChanges(root: string, pathspec: string): boolean {
  try {
    const stdout = execFileSync(
      'git',
      ['status', '--porcelain', '--', pathspec],
      {
        cwd: root,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    )
    return stdout.trim() !== ''
  } catch {
    return false
  }
}

/**
 * True only when `pathspec` is tracked in git. Used to keep this blocking gate
 * off machine-local artifacts: an untracked path is by definition not
 * repository content, so no source change can produce or fix a finding on it.
 * git being unavailable degrades to "not tracked" (skip) rather than a
 * finding nobody can act on.
 */
function pathIsTracked(root: string, pathspec: string): boolean {
  try {
    const stdout = execFileSync('git', ['ls-files', '--', pathspec], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    return stdout.trim() !== ''
  } catch {
    return false
  }
}

export function checkCommand(root: string): Finding[] {
  const findings: Finding[] = []
  for (const filePath of markdownFiles(root)) {
    const projectPath = toProjectPath(root, filePath)
    const lines = readLines(filePath)
    lines.forEach((line, index) => {
      COMMAND_REGEX.lastIndex = 0
      let match: RegExpExecArray | null
      while ((match = COMMAND_REGEX.exec(line)) !== null) {
        const fullMatch = match[0]
        const scriptName = match[1]
        // Skip flag fragments (e.g. `--cwd` captured when a placeholder like
        // `<workspace>` follows the flag instead of a real cwd value).
        if (scriptName.startsWith('--')) {
          continue
        }
        // Skip file-path fragments. The regex char class excludes `/`, so a
        // command like `bun run evals/foo.ts` captures only `evals`. Detect
        // this by checking if the next char in the line is `/`.
        const captureEnd = match.index + fullMatch.length
        if (captureEnd < line.length && line[captureEnd] === '/') {
          continue
        }
        // Skip degenerate single-char captures.
        if (scriptName.length <= 1) {
          continue
        }
        const cwdMatch = fullMatch.match(/--cwd[=\s]+([^\s]+)/)
        let subdir = cwdMatch ? cwdMatch[1] : ''
        // Track whether subdir came from an author-explicit --cwd/cd target
        // (vs nearest-package inference). Root script fallback applies only
        // for inferred package docs documenting bare monorepo-root scripts.
        let explicitCwd = Boolean(subdir)
        // If --cwd points outside the project root (absolute path not under
        // root), ignore it and fall back to cwd inference.
        if (
          subdir &&
          subdir.startsWith('/') &&
          !subdir.startsWith(root + sep)
        ) {
          subdir = ''
          explicitCwd = false
        }
        if (!subdir) {
          // Infer cwd from a `cd <dir> &&` prefix earlier on the same line.
          const cdMatch = line.match(/cd\s+([^\s&]+)\s*&&/)
          if (cdMatch) {
            const candidate = cdMatch[1]
            // Reject out-of-repo absolute paths (e.g. transcript lines that
            // reference a sibling checkout like /home/user/Code/CLI/codebuff).
            if (
              !candidate.startsWith('/') ||
              candidate.startsWith(root + sep)
            ) {
              subdir = candidate
              explicitCwd = true
            }
          }
        }
        if (!subdir) {
          // Multi-line cd prefix: look back at preceding lines within the
          // same code block for a standalone `cd <dir>` line (common in
          // bash snippets like `cd cli\nbun run test:tmux-poc`). Stop at a
          // blank line, a closing code fence, or a ~10-line window.
          for (let prev = index - 1; prev >= 0 && prev >= index - 10; prev--) {
            const prevLine = lines[prev].trim()
            if (prevLine === '' || prevLine.startsWith('```')) {
              break
            }
            const prevCd = prevLine.match(/^cd\s+([^\s&]+)\s*$/)
            if (prevCd) {
              const candidate = prevCd[1]
              if (
                !candidate.startsWith('/') ||
                candidate.startsWith(root + sep)
              ) {
                subdir = candidate
                explicitCwd = true
              }
              break
            }
            // If the previous line itself runs a command (e.g. `bun run ...`),
            // don't cross it — the cd likely isn't on this block's path.
            if (/(bun|npm|yarn|pnpm)\s+run\s/.test(prevLine)) {
              break
            }
          }
        }
        if (!subdir) {
          // Fall back to the nearest package.json ancestor of the markdown
          // file. A README in `cli/` should resolve against `cli/package.json`,
          // not the root.
          subdir = nearestPackageJsonSubdir(root, filePath)
        }
        // Normalize root-relative cwd forms so root scripts resolve cleanly.
        if (subdir === '.' || subdir === './') {
          subdir = '.'
        }
        const pkg = loadPackageJson(root, subdir)
        if (scriptMissingInPkg(pkg, scriptName)) {
          // Package READMEs often document monorepo-root scripts as bare
          // `bun run <script>` without --cwd. Accept root when the nearest
          // package was only inferred — never when the author explicitly
          // targeted another package via --cwd or cd.
          const rootPkg = subdir === '.' ? pkg : loadPackageJson(root, '.')
          if (
            !explicitCwd &&
            subdir !== '.' &&
            !scriptMissingInPkg(rootPkg, scriptName)
          ) {
            continue
          }
          findings.push({
            path: projectPath,
            line: index + 1,
            message: `command references missing script \`${scriptName}\` in ${subdir === '.' ? 'root' : subdir}/package.json`,
          })
        }
      }
    })
  }
  return findings
}

export function checkDependency(root: string): Finding[] {
  const findings: Finding[] = []
  for (const filePath of markdownFiles(root)) {
    const projectPath = toProjectPath(root, filePath)
    const lines = readLines(filePath)
    lines.forEach((line, index) => {
      DEPENDENCY_REGEX.lastIndex = 0
      let match: RegExpExecArray | null
      while ((match = DEPENDENCY_REGEX.exec(line)) !== null) {
        const pkgName = match[1]
        if (!dependencyExists(root, pkgName)) {
          findings.push({
            path: projectPath,
            line: index + 1,
            message: `references dependency \`${pkgName}\` not present in repo`,
          })
        }
      }
    })
  }
  return findings
}

export function checkCrossFile(root: string): Finding[] {
  const findings: Finding[] = []
  for (const filePath of markdownFiles(root)) {
    const projectPath = toProjectPath(root, filePath)
    const dir = dirname(filePath)
    const lines = readLines(filePath)
    lines.forEach((line, index) => {
      CROSS_FILE_LINK_REGEX.lastIndex = 0
      let match: RegExpExecArray | null
      while ((match = CROSS_FILE_LINK_REGEX.exec(line)) !== null) {
        const target = match[1]
        const resolved = resolve(dir, target)
        if (!existsSync(resolved)) {
          findings.push({
            path: projectPath,
            line: index + 1,
            message: `cross-file link ${target} does not exist`,
          })
        }
      }
    })
  }
  return findings
}

function listTopLevelScripts(root: string): string[] {
  const scriptsDir = join(root, 'scripts')
  if (!existsSync(scriptsDir)) {
    return []
  }
  let entries: import('node:fs').Dirent[] = []
  try {
    entries = readdirSync(scriptsDir, { withFileTypes: true })
  } catch (err) {
    console.debug(
      `[memory-drift-guard] listTopLevelScripts readdir failed for ${scriptsDir}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    )
    return []
  }
  return entries
    .filter((e) => e.isFile() && e.name.endsWith('.ts'))
    .map((e) => e.name)
}

/**
 * Expands the root `package.json` `workspaces` declaration into concrete
 * project-relative subdirectories. A trailing `/*` entry (e.g. `packages/*`)
 * is enumerated against the real directory listing so globbed members like
 * `packages/agent-runtime` are returned instead of a literal `packages`.
 *
 * Missing directories and a missing/malformed `workspaces` field degrade to
 * an empty result rather than throwing.
 */
function workspacePackageSubdirs(root: string): string[] {
  const rootPkg = loadPackageJson(root, '.')
  const patterns: unknown = Array.isArray(rootPkg?.workspaces)
    ? rootPkg.workspaces
    : rootPkg?.workspaces?.packages
  if (!Array.isArray(patterns)) {
    return []
  }
  const subdirs = new Set<string>()
  for (const pattern of patterns) {
    if (typeof pattern !== 'string' || pattern === '') {
      continue
    }
    if (!pattern.endsWith('/*')) {
      subdirs.add(pattern)
      continue
    }
    const parent = pattern.slice(0, -2)
    const parentDir = join(root, parent)
    if (!existsSync(parentDir)) {
      continue
    }
    try {
      for (const entry of readdirSync(parentDir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          subdirs.add(`${parent}/${entry.name}`)
        }
      }
    } catch (err) {
      console.debug(
        `[memory-drift-guard] workspacePackageSubdirs readdir failed for ${parentDir}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      )
    }
  }
  return [...subdirs]
}

export function checkScriptCoverage(root: string): Finding[] {
  const findings: Finding[] = []
  const scripts = listTopLevelScripts(root)
  // A script is covered when any workspace package wires it into its scripts —
  // e.g. `cli/package.json` invoking `../scripts/generate-gate-helpers.ts` —
  // so scan the root manifest plus every workspace member manifest.
  const manifestSubdirs = new Set<string>([
    '.',
    'scripts',
    ...workspacePackageSubdirs(root),
  ])
  const scriptValues: string[] = []
  for (const subdir of manifestSubdirs) {
    const pkg = loadPackageJson(root, subdir)
    if (pkg?.scripts && typeof pkg.scripts === 'object') {
      for (const v of Object.values(pkg.scripts)) {
        if (typeof v === 'string') {
          scriptValues.push(v)
        }
      }
    }
  }

  // Allowlist file: scripts/.coverage-allow — one basename per line. Used for
  // standalone utility scripts that are run directly via `bun scripts/foo.ts`
  // and are intentionally not referenced in package.json or markdown.
  const allowlistPath = join(root, 'scripts', '.coverage-allow')
  const allowlist = new Set<string>()
  if (existsSync(allowlistPath)) {
    for (const line of readLines(allowlistPath)) {
      const trimmed = line.trim()
      if (trimmed && !trimmed.startsWith('#')) {
        allowlist.add(trimmed)
      }
    }
  }

  const allMdContent: string[] = []
  for (const filePath of markdownFiles(root)) {
    try {
      allMdContent.push(readFileSync(filePath, 'utf8'))
    } catch (err) {
      console.debug(
        `[memory-drift-guard] checkScriptCoverage read failed for ${filePath}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      )
    }
  }

  for (const scriptName of scripts) {
    if (SCRIPT_COVERAGE_IGNORE.has(scriptName)) {
      continue
    }
    if (allowlist.has(scriptName)) {
      continue
    }
    const inMarkdown = allMdContent.some((c) => c.includes(scriptName))
    const inPackageJson = scriptValues.some((v) => v.includes(scriptName))
    if (!inMarkdown && !inPackageJson) {
      findings.push({
        path: `scripts/${scriptName}`,
        line: 1,
        message: `script not mentioned in any markdown file or workspace package.json`,
      })
    }
  }
  return findings
}

export function checkToolConfigSync(root: string): Finding[] {
  const findings: Finding[] = []
  const routerPath = join(root, 'ROUTER.md')
  if (!existsSync(routerPath)) {
    return findings
  }
  const projectPath = 'ROUTER.md'
  const lines = readLines(routerPath)
  const quotedFileRegex = /`([A-Za-z0-9._\/-]+\.[A-Za-z]+)`/g
  lines.forEach((line, index) => {
    if (!line.startsWith('|')) {
      return
    }
    quotedFileRegex.lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = quotedFileRegex.exec(line)) !== null) {
      const target = match[1]
      if (!existsSync(join(root, target))) {
        findings.push({
          path: projectPath,
          line: index + 1,
          message: `ROUTER table references missing file ${target}`,
        })
      }
    }
  })
  return findings
}

export function checkTodoFixme(root: string): Finding[] {
  const findings: Finding[] = []
  // Match TODO/FIXME/XXX only when followed by `:` or `(` (i.e. an actual
  // unresolved marker), not when used as a feature/section name like
  // "TODO List Positioning" or "FIXME notes".
  const markerRegex = /\b(TODO|FIXME|XXX)\b[:(]/
  for (const filePath of markdownFiles(root)) {
    const projectPath = toProjectPath(root, filePath)
    const lines = readLines(filePath)
    lines.forEach((line, index) => {
      if (line.includes('<!-- allow-todo -->')) {
        return
      }
      if (markerRegex.test(line)) {
        findings.push({
          path: projectPath,
          line: index + 1,
          message: `unresolved TODO/FIXME marker in knowledge file`,
        })
      }
    })
  }
  return findings
}

export function checkBrokenLink(root: string): Finding[] {
  const findings: Finding[] = []
  for (const filePath of markdownFiles(root)) {
    const projectPath = toProjectPath(root, filePath)
    const dir = dirname(filePath)
    const lines = readLines(filePath)
    lines.forEach((line, index) => {
      BROKEN_LINK_REGEX.lastIndex = 0
      let match: RegExpExecArray | null
      while ((match = BROKEN_LINK_REGEX.exec(line)) !== null) {
        const target = match[1]
        if (
          target.startsWith('http://') ||
          target.startsWith('https://') ||
          target.startsWith('#')
        ) {
          continue
        }
        const resolved = resolve(dir, target)
        if (!existsSync(resolved)) {
          findings.push({
            path: projectPath,
            line: index + 1,
            message: `broken link ${target}`,
          })
        }
      }
    })
  }
  return findings
}

/**
 * Validate the persisted cross-session task memory record when the repository
 * TRACKS one: flag evidence entries whose bound path no longer exists on disk
 * unless the record already marks them stale. Absent or unparseable records
 * produce no findings (the store fails closed on those at hydration time).
 * JSON has no meaningful per-finding line, so findings report line 1.
 *
 * `.openbuff/memory/task-memory.json` is normally machine-local runtime state
 * written by whatever runs happened on that machine. This guard is a blocking
 * repo gate (CI and the pre-push hook), so it must only judge tracked
 * repository content: an untracked record is skipped entirely, because no
 * source change produced its contents and none can clear a finding on it.
 */
export function checkTaskMemory(root: string): Finding[] {
  const memoryProjectPath = '.openbuff/memory/task-memory.json'
  const memoryFile = join(root, '.openbuff', 'memory', 'task-memory.json')
  if (!existsSync(memoryFile) || !pathIsTracked(root, memoryProjectPath)) {
    return []
  }
  let evidence: Array<{ path?: unknown; stale?: unknown }>
  try {
    const parsed: unknown = JSON.parse(readFileSync(memoryFile, 'utf8'))
    const candidate = (parsed as { evidence?: unknown } | null)?.evidence
    if (!Array.isArray(candidate)) {
      return []
    }
    evidence = candidate as Array<{ path?: unknown; stale?: unknown }>
  } catch {
    return []
  }
  const findings: Finding[] = []
  for (const item of evidence) {
    if (typeof item?.path !== 'string' || item.path.length === 0) {
      continue
    }
    if (item.stale === true) {
      continue
    }
    if (!existsSync(join(root, item.path))) {
      findings.push({
        path: memoryProjectPath,
        line: 1,
        message: `task-memory evidence path \`${item.path}\` does not exist but is not marked stale`,
      })
    }
  }
  return findings
}

export const CHECKERS: Array<{
  name: string
  run: (root: string) => Finding[]
}> = [
  { name: 'path', run: checkPath },
  { name: 'edges', run: checkEdges },
  { name: 'index-sync', run: checkIndexSync },
  { name: 'staleness', run: checkStaleness },
  { name: 'command', run: checkCommand },
  { name: 'dependency', run: checkDependency },
  { name: 'cross-file', run: checkCrossFile },
  { name: 'script-coverage', run: checkScriptCoverage },
  { name: 'tool-config-sync', run: checkToolConfigSync },
  { name: 'todo-fixme', run: checkTodoFixme },
  { name: 'broken-link', run: checkBrokenLink },
  { name: 'task-memory', run: checkTaskMemory },
]

export function runMemoryDriftGuard(
  root = projectRoot(),
): MemoryDriftGuardResult {
  const checkers: CheckerResult[] = CHECKERS.map(({ name, run }) => ({
    name,
    findings: run(root),
  }))
  const score = checkers.reduce((sum, c) => sum + c.findings.length, 0)
  return { score, checkers }
}

export function formatMemoryDriftReport(
  result: MemoryDriftGuardResult,
): string {
  if (result.score === 0) {
    return `Memory drift guard passed: 0 findings across ${result.checkers.length} checkers.`
  }
  const header = `Memory drift guard: ${result.score} finding(s) across ${result.checkers.length} checker(s)`
  const blocks: string[] = []
  for (const checker of result.checkers) {
    if (checker.findings.length === 0) {
      continue
    }
    blocks.push(`## ${checker.name} (${checker.findings.length})`)
    for (const finding of checker.findings) {
      blocks.push(`${finding.path}:${finding.line}: ${finding.message}`)
    }
  }
  return [header, ...blocks].join('\n')
}

if (import.meta.main) {
  const result = runMemoryDriftGuard()
  const report = formatMemoryDriftReport(result)
  if (result.score > 0) {
    console.error(report)
    process.exit(1)
  }
  console.log(report)
}
