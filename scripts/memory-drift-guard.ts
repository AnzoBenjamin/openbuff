import { createHash } from 'node:crypto'
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

/**
 * M3-T2: one shared snapshot of the markdown tree. Each checker previously
 * ran its own recursive `markdownFiles` walk plus a per-file read, so a run
 * re-walked the entire repo and re-read every .md/.mdx once PER CHECKER.
 * `runMemoryDriftGuard` now walks ONCE, reads each file once, and hands the
 * snapshot to every checker; direct checker calls without a snapshot keep
 * their own walk (backward-compatible with the pinned tests).
 */
export type MarkdownSnapshot = {
  files: string[]
  linesByFile: Map<string, string[]>
}

export function buildMarkdownSnapshot(root: string): MarkdownSnapshot {
  const files: string[] = []
  const linesByFile = new Map<string, string[]>()
  for (const filePath of markdownFiles(root)) {
    try {
      linesByFile.set(filePath, readFileSync(filePath, 'utf8').split('\n'))
      files.push(filePath)
    } catch (err) {
      // An unreadable file cannot be checked by any checker, so it is dropped
      // from the snapshot ENTIRELY (not just its lines): keeping it in
      // `files` would make every checker fall back to a direct re-read that
      // re-throws here, crashing runMemoryDriftGuard (the CI gate) instead
      // of skipping the file.
      console.debug(
        `[memory-drift-guard] buildMarkdownSnapshot read failed for ${filePath}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      )
    }
  }
  return { files, linesByFile }
}

/** File list for a checker: the shared snapshot when present, else its own walk. */
function snapshotFiles(
  snapshot: MarkdownSnapshot | undefined,
  root: string,
): string[] {
  return snapshot ? snapshot.files : [...markdownFiles(root)]
}

/**
 * Lines for one file from the shared snapshot, falling back to a direct read
 * only when the checker was called without a snapshot. Files whose snapshot
 * read failed are excluded from `snapshot.files`, so this fallback is never
 * reached for an unreadable file.
 */
function snapshotFileLines(
  snapshot: MarkdownSnapshot | undefined,
  filePath: string,
): string[] {
  const cached = snapshot?.linesByFile.get(filePath)
  if (cached) return cached
  return readLines(filePath)
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

export function checkPath(
  root: string,
  snapshot?: MarkdownSnapshot,
): Finding[] {
  const findings: Finding[] = []
  for (const filePath of snapshotFiles(snapshot, root)) {
    const projectPath = toProjectPath(root, filePath)
    const lines = snapshotFileLines(snapshot, filePath)
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

export function checkEdges(
  root: string,
  snapshot?: MarkdownSnapshot,
): Finding[] {
  const findings: Finding[] = []
  for (const filePath of snapshotFiles(snapshot, root)) {
    const base = filePath.split(sep).pop() || ''
    if (base !== 'knowledge.md' && !base.endsWith('.knowledge.md')) {
      continue
    }
    const projectPath = toProjectPath(root, filePath)
    const lines = snapshotFileLines(snapshot, filePath)
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

/**
 * TEST-ONLY seam: when set, this module spawns this command instead of the
 * literal `git` binary for its staleness probe and history lookups. Tests use
 * it to force a broken git environment (e.g. `/bin/false`, or a shim that
 * fails only some subcommands) without PATH manipulation, which does not
 * affect child-process resolution under Bun. Never set outside tests.
 */
let gitCommandForTest: string | null = null

/**
 * TEST-ONLY: inject the git command this module spawns (`null` restores the
 * default `git` binary). Always reset to `null` in a test's `finally`.
 */
export function setGitCommandForTest(cmd: string | null): void {
  gitCommandForTest = cmd
}

function gitBinary(): string {
  return gitCommandForTest ?? 'git'
}

/**
 * One cheap git probe distinguishing a BROKEN git environment (the binary is
 * missing or git itself fails) from a defined no-history state ("not a git
 * repository", exit 128). Returns a human-readable failure note for the
 * former and null otherwise, so `checkStaleness` can degrade VISIBLY —
 * reporting that freshness could not be verified — instead of silently
 * reporting "clean" when its git lookups fail (fail-visible, not fail-open).
 */
function gitProbeFailure(root: string): string | null {
  try {
    execFileSync(gitBinary(), ['rev-parse', '--git-dir'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    return null
  } catch (err) {
    const e = err as { code?: unknown; status?: unknown }
    // Exit 128 is git's defined "not a git repository" refusal: there is no
    // history to drift against, which is a clean (not degraded) state.
    if (e.status === 128) return null
    if (e.code === 'ENOENT') return 'git could not be spawned'
    return `git probe failed (status ${String(e.status ?? 'unknown')})`
  }
}

/**
 * Flags knowledge.md / *.knowledge.md files whose last commit is older than
 * the last commit of their sibling src/ (or topic-relevant src subset).
 *
 * PR-T5 (D23) Slice 3 — recorded review receipts: before emitting a stale
 * finding for a pair, the guard consults
 * `<root>/.openbuff/memory/review-receipt.json` (loaded ONCE per call). A
 * STRICTLY VALID receipt (see {@link loadReviewReceipt}) with verdict
 * LOOKS_GOOD whose `fileHashes` entry for EVERY file of the pair's last
 * source commit (`git log -1 --name-only --format= -- <srcRelative>`, batched
 * like batchLastCommitEpochs) matches the CURRENT sha256 of the raw bytes on
 * disk means those exact bytes were reviewed, so the stale finding is
 * suppressed. Any missing entry, hash mismatch, unreadable file, or receipt
 * that failed strict validation (treated as ABSENT) keeps the finding
 * standing — a malformed or forged receipt can never suppress a finding.
 *
 * FAIL-VISIBLE on the tool, not fail-open: a BROKEN git environment (binary
 * missing, git itself failing) is reported as a DEGRADED finding per
 * candidate pair — freshness could not be verified — instead of silently
 * looking like a clean pass. A defined no-history state (the path is not in a
 * git repository, or the path has no commits) remains a clean skip.
 */
export function checkStaleness(
  root: string,
  snapshot?: MarkdownSnapshot,
): Finding[] {
  const candidates: Array<{
    filePath: string
    projectPath: string
    srcRelative: string
    topic: string
    base: string
  }> = []
  for (const filePath of snapshotFiles(snapshot, root)) {
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
  const degradedFindings = (reason: string): Finding[] =>
    candidates.map((c) => ({
      path: c.projectPath,
      line: 1,
      message: `staleness check degraded (${reason}): could not verify whether ${c.base} is stale — treat as UNVERIFIED, not clean`,
    }))
  // Fail-visible gate: a broken git environment must not be indistinguishable
  // from a clean pass. One probe call; when git is unusable every candidate
  // pair is reported as DEGRADED instead of silently producing no findings.
  const gitFailure = gitProbeFailure(root)
  if (gitFailure !== null) {
    return degradedFindings(`git unavailable: ${gitFailure}`)
  }
  const computeFindings = (): Finding[] => {
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
    // PR-T5 (D23) Slice 3: load the recorded review receipt ONCE per call and
    // list each candidate pair's last src-commit files in one batched pass
    // (mirroring batchLastCommitEpochs). The receipt is optional gitignored
    // local state: absent/unreadable/malformed behaves exactly as before.
    const receipt = loadReviewReceipt(root)
    // Batched last-src-commit file lists are only needed to verify a receipt:
    // with no usable receipt the default path keeps its exact prior git-call
    // profile (staleness epochs + dirty set only).
    const srcCommitFilesByPath = receipt
      ? batchLastCommitFiles(
          root,
          candidates.map((c) => c.srcRelative),
        )
      : new Map<string, string[]>()
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
        // Receipt attestation first: a LOOKS_GOOD receipt whose recorded
        // hashes still match the CURRENT bytes of every file in the last
        // source commit means those exact bytes were reviewed, so the stale
        // finding is suppressed for this pair. Anything else (a missing
        // entry, a hash mismatch, an unreadable file, a wrong verdict, an
        // absent receipt) leaves the finding standing.
        const sourceCommitFiles = srcCommitFilesByPath.get(c.srcRelative) ?? []
        if (
          receipt &&
          verifyReceiptCoversPair(root, receipt, sourceCommitFiles)
        ) {
          console.debug(
            `[memory-drift-guard] staleness suppressed by review receipt: ${c.projectPath}`,
          )
          continue
        }
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
  }
  // Fail-visible wrap around the ENTIRE per-pair computation: a git failure
  // DURING the work (batched last-commit lookups, receipt hash cross-check)
  // must degrade VISIBLY per pair, not fall into a silent zero-findings
  // result that reads as a clean gate.
  try {
    return computeFindings()
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    console.debug(
      `[memory-drift-guard] checkStaleness git lookup failed: ${reason}`,
    )
    // Degraded, not suppressed: an unexpected git failure still reports every
    // candidate pair as UNVERIFIED so a broken environment cannot read as a
    // clean gate.
    return degradedFindings(`git failure during staleness check: ${reason}`)
  }
}

/**
 * A git failure during the per-pair staleness work is a DEFINED no-history
 * state only when git itself refuses with exit 128 ("not a git repository"):
 * then the caller keeps its clean default. Every other failure (git
 * semi-broken, crashed, killed) is rethrown so `checkStaleness`'s post-probe
 * wrap can degrade VISIBLY instead of the failure being swallowed into silent
 * zero findings (fail-open).
 */
function isGitNoHistoryFailure(err: unknown): boolean {
  const e = err as { status?: unknown }
  return e.status === 128
}

function batchLastCommitEpochs(
  root: string,
  pathspecs: string[],
): Map<string, number | null> {
  const out = new Map<string, number | null>()
  for (const ps of pathspecs) out.set(ps, lastCommitEpoch(root, ps))
  return out
}

/**
 * The only verdicts a recorded review receipt may carry. A receipt with any
 * other verdict string is not a real reviewer run's output and is treated as
 * ABSENT (never suppressive).
 */
const RECEIPT_VERDICTS = new Set(['LOOKS_GOOD', 'NON_BLOCKING', 'BLOCKING'])

/** A recorded file hash must be exactly a 64-char lowercase sha256 hex digest. */
const SHA256_HEX_RE = /^[0-9a-f]{64}$/

/**
 * PR-T5 (D23) Slice 3 — recorded review receipt consumed by `checkStaleness`.
 *
 * Shape contract (`.openbuff/memory/review-receipt.json`, gitignored local
 * state like the task-memory.json precedent):
 * `{ schemaVersion: 1, reviewer: string, verdict: 'LOOKS_GOOD',
 * reviewedFiles: string[], fileHashes: Record<path, sha256-hex>,
 * recordedAt: string }`. The receipt attests that a reviewer returned
 * LOOKS_GOOD over exact file bytes; `fileHashes` binds those bytes so the
 * guard can verify at check time that the attested content is still on disk.
 */
export type RecordedReviewReceipt = {
  schemaVersion: number
  reviewer: string
  verdict: string
  reviewedFiles: string[]
  fileHashes: Record<string, string>
  recordedAt: string
  /**
   * Optional reviewer-run identity. Validated (non-empty string) when
   * present; the receipt's anti-forgery binding is the fileHashes
   * cross-check against the CURRENT bytes of the pair's last src commit,
   * not this identity.
   */
  receiptId?: string
  agentId?: string
}

/**
 * Load the recorded review receipt.
 *
 * FAIL-OPEN ON PRESENCE, FAIL-CLOSED ON TRUST: a missing or unreadable
 * receipt is treated as ABSENT (null) and is never required for correctness —
 * the staleness gate behaves exactly as before whenever the receipt cannot be
 * found. But a receipt that IS present must validate STRICTLY before it may
 * influence anything: `schemaVersion` must be exactly 1, `verdict` must be
 * one of the known reviewer verdicts, `reviewer` must name a real reviewer
 * agent, every `fileHashes` VALUE must be a 64-char lowercase sha256 hex
 * digest (the keys are the project-relative file paths those digests attest),
 * and the optional reviewer-run identity fields (`receiptId`, `agentId`) must
 * be non-empty strings when present. A malformed or suspicious receipt —
 * wrong schema version, unknown verdict, prefixed or non-hex hash value,
 * empty identity — is treated as ABSENT (null), never as suppressive
 * evidence, so a forged or corrupted receipt cannot manufacture a clean gate.
 * Only a structurally valid record is returned.
 */
export function loadReviewReceipt(root: string): RecordedReviewReceipt | null {
  const receiptFile = join(root, '.openbuff', 'memory', 'review-receipt.json')
  if (!existsSync(receiptFile)) {
    return null
  }
  try {
    const parsed: unknown = JSON.parse(readFileSync(receiptFile, 'utf8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null
    }
    const record = parsed as Record<string, unknown>
    const fileHashes = record.fileHashes
    if (
      record.schemaVersion !== 1 ||
      typeof record.reviewer !== 'string' ||
      record.reviewer.trim().length === 0 ||
      typeof record.verdict !== 'string' ||
      !RECEIPT_VERDICTS.has(record.verdict) ||
      typeof record.recordedAt !== 'string' ||
      record.recordedAt.trim().length === 0 ||
      !Array.isArray(record.reviewedFiles) ||
      !record.reviewedFiles.every(
        (file) => typeof file === 'string' && file.length > 0,
      ) ||
      !fileHashes ||
      typeof fileHashes !== 'object' ||
      Array.isArray(fileHashes) ||
      !Object.entries(fileHashes).every(
        ([path, hash]) =>
          path.length > 0 &&
          typeof hash === 'string' &&
          SHA256_HEX_RE.test(hash),
      )
    ) {
      return null
    }
    // Optional reviewer-run identity: when carried, it must be well-formed.
    const receiptId = record.receiptId
    const agentId = record.agentId
    if (
      (receiptId !== undefined &&
        (typeof receiptId !== 'string' || receiptId.trim().length === 0)) ||
      (agentId !== undefined &&
        (typeof agentId !== 'string' || agentId.trim().length === 0))
    ) {
      return null
    }
    const receipt: RecordedReviewReceipt = {
      schemaVersion: record.schemaVersion,
      reviewer: record.reviewer,
      verdict: record.verdict,
      reviewedFiles: record.reviewedFiles as string[],
      fileHashes: Object.fromEntries(
        Object.entries(fileHashes as Record<string, string>),
      ),
      recordedAt: record.recordedAt,
    }
    if (typeof receiptId === 'string') receipt.receiptId = receiptId
    if (typeof agentId === 'string') receipt.agentId = agentId
    return receipt
  } catch (err) {
    console.debug(
      `[memory-drift-guard] loadReviewReceipt failed for ${receiptFile}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    )
    return null
  }
}

/**
 * sha256 over the RAW bytes currently on disk for `absolutePath`, hex-encoded.
 * No CRLF/newline normalization: a git blob hash is not reproducible here, so
 * the receipt is written against this same raw-bytes hash at review time and
 * verified against it at check time.
 */
export function sha256FileHash(absolutePath: string): string {
  return createHash('sha256').update(readFileSync(absolutePath)).digest('hex')
}

/**
 * Files changed by the LAST git commit touching each pathspec, batched one
 * `git log -1 --name-only --format= -- <pathspec>` per distinct pathspec
 * (mirroring batchLastCommitEpochs). `--format=` suppresses the commit
 * header, so stdout is exactly one committed filename per line. A directory
 * pathspec resolves to the files of the last commit touching that directory;
 * a pathspec with no git history yields an empty list.
 */
export function batchLastCommitFiles(
  root: string,
  pathspecs: string[],
): Map<string, string[]> {
  const out = new Map<string, string[]>()
  for (const ps of [...new Set(pathspecs)]) {
    out.set(ps, lastCommitFiles(root, ps))
  }
  return out
}

/** Files of the last commit touching `pathspec` (empty when git has none). */
function lastCommitFiles(root: string, pathspec: string): string[] {
  let stdout: string
  try {
    stdout = execFileSync(
      gitBinary(),
      ['log', '-1', '--name-only', '--format=', '--', pathspec],
      {
        cwd: root,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    )
  } catch (err) {
    if (isGitNoHistoryFailure(err)) return []
    throw err
  }
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
}

/**
 * True when the receipt attests the CURRENT bytes of every file in the pair's
 * last source commit. Verification is current-bytes-only: each file's hash is
 * recomputed from disk and compared against the receipt's recorded
 * `fileHashes[path]`, so a receipt written for older bytes never suppresses a
 * finding. Any file missing from the receipt, absent or unreadable on disk,
 * or hashed differently fails the check, and `verdict` must be LOOKS_GOOD.
 * An empty commit-file list can never be attested.
 */
export function verifyReceiptCoversPair(
  root: string,
  receipt: RecordedReviewReceipt,
  sourceCommitFiles: string[],
): boolean {
  if (receipt.verdict !== 'LOOKS_GOOD') return false
  if (sourceCommitFiles.length === 0) return false
  for (const projectPath of sourceCommitFiles) {
    const recordedHash = receipt.fileHashes[projectPath]
    if (typeof recordedHash !== 'string' || recordedHash.length === 0) {
      return false
    }
    const absolutePath = join(root, projectPath)
    if (!existsSync(absolutePath)) return false
    try {
      if (sha256FileHash(absolutePath) !== recordedHash) return false
    } catch {
      return false
    }
  }
  return true
}

function batchDirtySet(root: string, pathspecs: string[]): Set<string> {
  if (pathspecs.length === 0) return new Set()
  try {
    const stdout = execFileSync(
      gitBinary(),
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
  } catch (err) {
    if (isGitNoHistoryFailure(err)) return new Set()
    throw err
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
      gitBinary(),
      ['log', '-1', '--format=%ct', '--', pathspec],
      {
        cwd: root,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    )
  } catch (err) {
    if (isGitNoHistoryFailure(err)) return null
    throw err
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
      gitBinary(),
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
  } catch (err) {
    if (isGitNoHistoryFailure(err)) return null
    throw err
  }
  const trimmed = stdout.trim()
  if (trimmed === '') {
    return null
  }
  const epoch = Number.parseInt(trimmed, 10)
  return Number.isFinite(epoch) ? epoch : null
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

export function checkCommand(
  root: string,
  snapshot?: MarkdownSnapshot,
): Finding[] {
  const findings: Finding[] = []
  for (const filePath of snapshotFiles(snapshot, root)) {
    const projectPath = toProjectPath(root, filePath)
    const lines = snapshotFileLines(snapshot, filePath)
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

export function checkDependency(
  root: string,
  snapshot?: MarkdownSnapshot,
): Finding[] {
  const findings: Finding[] = []
  for (const filePath of snapshotFiles(snapshot, root)) {
    const projectPath = toProjectPath(root, filePath)
    const lines = snapshotFileLines(snapshot, filePath)
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

export function checkCrossFile(
  root: string,
  snapshot?: MarkdownSnapshot,
): Finding[] {
  const findings: Finding[] = []
  for (const filePath of snapshotFiles(snapshot, root)) {
    const projectPath = toProjectPath(root, filePath)
    const dir = dirname(filePath)
    const lines = snapshotFileLines(snapshot, filePath)
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

export function checkScriptCoverage(
  root: string,
  snapshot?: MarkdownSnapshot,
): Finding[] {
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
  for (const filePath of snapshotFiles(snapshot, root)) {
    try {
      allMdContent.push(
        snapshotFileLines(snapshot, filePath).join('\n'),
      )
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

export function checkTodoFixme(
  root: string,
  snapshot?: MarkdownSnapshot,
): Finding[] {
  const findings: Finding[] = []
  // Match TODO/FIXME/XXX only when followed by `:` or `(` (i.e. an actual
  // unresolved marker), not when used as a feature/section name like
  // "TODO List Positioning" or "FIXME notes".
  const markerRegex = /\b(TODO|FIXME|XXX)\b[:(]/
  for (const filePath of snapshotFiles(snapshot, root)) {
    const projectPath = toProjectPath(root, filePath)
    const lines = snapshotFileLines(snapshot, filePath)
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

export function checkBrokenLink(
  root: string,
  snapshot?: MarkdownSnapshot,
): Finding[] {
  const findings: Finding[] = []
  for (const filePath of snapshotFiles(snapshot, root)) {
    const projectPath = toProjectPath(root, filePath)
    const dir = dirname(filePath)
    const lines = snapshotFileLines(snapshot, filePath)
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
 *
 * M4-T3: the `.openbuff/.gitignore` written by check:ci-local is scoped to the
 * transient lock file only (OPENBUFF_DIR_GITIGNORE_CONTENT in
 * scripts/check-ci-local.ts is the single source for those rules), so a
 * tracked task-memory.json stays `git add`-able on machines that run
 * check:ci-local and this tracked-mode path remains reachable.
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
  run: (root: string, snapshot?: MarkdownSnapshot) => Finding[]
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
  // M3-T2: ONE shared markdown-tree snapshot for every checker. Each checker
  // previously re-ran its own recursive directory walk and re-read every
  // .md/.mdx file; the snapshot turns that into one walk plus one read per
  // file for the whole run.
  const snapshot = buildMarkdownSnapshot(root)
  const checkers: CheckerResult[] = CHECKERS.map(({ name, run }) => ({
    name,
    findings: run(root, snapshot),
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
