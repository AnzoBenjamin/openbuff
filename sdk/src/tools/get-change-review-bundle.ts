import { spawn } from 'child_process'
import { createHash } from 'node:crypto'
import { open, stat } from 'node:fs/promises'
import path from 'node:path'

import { LocalHarnessStore } from '../services/local-harness-store'
import { resolveWorkspaceIdentity } from '../services/repository-identity'
import { runSemgrepBaseline } from '../services/semgrep-baseline'
import { gitStatus, runGitBounded } from './git-status'

import type { CodebuffToolOutput } from '../../../common/src/tools/list'
import type { WorkspaceStateV1 } from '@codebuff/common/types/workspace-state'
import type { LanguageDiagnostic } from './language-diagnostics'
import type { SemgrepRunner } from '../services/semgrep-baseline'

const normalizeFile = (file: string) =>
  file.replace(/\\/g, '/').replace(/^\.\//, '')

const isSessionArtifactPath = (file: string): boolean => {
  const normalized = file.replace(/\\/g, '/').replace(/^\.\//, '')
  return normalized.startsWith('.agents/sessions/')
}

/**
 * Snapshot-identity I/O bounds (perf: bundle-identity-unbounded-sync-io,
 * snapshot-identity-diff-capture-unbounded, identity-git-spawns-no-deadline).
 * Identity used to consume the complete `git diff --binary HEAD` output and
 * read every changed file's FULL bytes with synchronous fs calls on the hot
 * review path. The diff is now spawned with a bounded RETENTION cap
 * (MAX_SNAPSHOT_ID_DIFF_BYTES): git may still emit more than the cap, but only
 * its first cap bytes are buffered on the identity path — the untruncated byte
 * total is counted and mixed into the hash so a truncation boundary can never
 * alias two distinct worktree states. Each file contributes at most
 * MAX_SNAPSHOT_ID_FILE_BYTES bytes, read asynchronously via fs.promises, and
 * every identity-path git spawn carries a SNAPSHOT_ID_GIT_TIMEOUT_MS
 * wall-clock deadline so a wedged git fails closed instead of hanging.
 * (reliability: bundle-rev-parse-head-unbounded) the deadline covers the
 * bundle's ENTIRE git surface — the prelude (status/diff observation,
 * rev-parse HEAD, workspace identity) and the security-scan baseline
 * resolution all route through runGitBounded or the deadline-threaded
 * helpers — so the fail-closed guarantee holds end-to-end for the bundle
 * the gate invokes every cycle, not only inside
 * buildSnapshotIdentity/computeWorktreeSnapshotIdentity.
 */
const MAX_SNAPSHOT_ID_DIFF_BYTES = 4 * 1024 * 1024
const MAX_SNAPSHOT_ID_FILE_BYTES = 1024 * 1024

/**
 * Bounded fan-out for the per-file identity reads (perf:
 * snapshot-identity-serial-file-reads): the identity path runs on every
 * bundle build and twice per run_targeted_validation call, so the per-file
 * stat + capped-prefix reads run with bounded concurrency instead of strictly
 * serially. Each read's contribution is still joined into the hash in sorted
 * file order, so the snapshotId is byte-identical to the serial loop.
 */
const SNAPSHOT_ID_READ_CONCURRENCY = 8

/**
 * Wall-clock deadline for every git spawn on the snapshot-identity path
 * (perf: identity-git-spawns-no-deadline). Generous enough for slow disks and
 * CI runners, but a hard bound: runTargetedValidation executes this path twice
 * per call, so a wedged git must fail closed instead of hanging the caller.
 */
const SNAPSHOT_ID_GIT_TIMEOUT_MS = 10_000

// runGitBounded and its BoundedOutputCollector moved to git-status.ts
// (reliability: bundle-rev-parse-head-unbounded) so gitStatus can thread an
// opt-in wall-clock deadline without an import cycle; re-export the runner
// so the historical import path (run-git-bounded.test.ts and this file's
// prior consumers) keeps working.
export { runGitBounded }

/**
 * A3 advisory (committed-diff identity under git's C-style quoting): when a
 * path contains special characters (tabs, quotes, non-ASCII), `git diff`
 * emits the `b/<path>` half as a C-style-quoted string, e.g.
 * `b/"path/with\tspace.ts"`. The raw quoted form used to feed the
 * committed-diff identity file list, so such files hashed under their quoted
 * spelling instead of their real path. Only QUOTED paths are decoded; ordinary
 * (unquoted) paths pass through byte-identical so existing behavior never
 * changes.
 */
function unquoteGitPath(raw: string): string {
  if (raw.length < 2 || !raw.startsWith('"') || !raw.endsWith('"')) {
    return raw
  }
  const inner = raw.slice(1, -1)
  // \ooo octal bytes (1-3 digits) are git's encoding for non-ASCII bytes.
  // Consecutive octal bytes accumulate into one buffer and are decoded as
  // UTF-8 when the run ends, so multi-byte sequences (e.g. é = \303\251)
  // round-trip instead of mangling into one lone char per byte. All-ASCII
  // runs keep the historical String.fromCharCode mapping, and the simple
  // escapes (t, n, quote, backslash) are unchanged, so ordinary quoted paths
  // decode exactly as before.
  let out = ''
  let octalBytes: number[] | undefined
  const flushOctalRun = () => {
    if (octalBytes === undefined) return
    if (octalBytes.every((byte) => byte < 128)) {
      out += String.fromCharCode(...octalBytes)
    } else {
      out += Buffer.from(octalBytes).toString('utf8')
    }
    octalBytes = undefined
  }
  for (let i = 0; i < inner.length; i++) {
    const char = inner[i]!
    if (char !== '\\') {
      flushOctalRun()
      out += char
      continue
    }
    const next = inner[i + 1]
    if (next === 't' || next === 'n' || next === '"' || next === '\\') {
      flushOctalRun()
      out += next === 't' ? '\t' : next === 'n' ? '\n' : next
      i += 1
      continue
    }
    const octal = /^[0-7]{1,3}/.exec(inner.slice(i + 1))?.[0]
    if (octal !== undefined) {
      ;(octalBytes ??= []).push(parseInt(octal, 8))
      i += octal.length
      continue
    }
    // Unrecognized escape: keep the backslash verbatim, as before.
    flushOctalRun()
    out += '\\'
  }
  flushOctalRun()
  return out
}

/**
 * Extracts the changed-file paths from a committed `git diff` body.
 * Exported for test coverage; module-private in production usage.
 */
export function committedDiffFiles(diff: string): string[] {
  const files = new Set<string>()
  for (const line of diff.split('\n')) {
    const match = line.match(/^diff --git a\/.+ b\/(.+)$/)
    if (match) files.add(unquoteGitPath(match[1]))
  }
  return [...files]
}

/**
 * Extracts the path portion of a `git status --porcelain` line. Git only
 * formats a ` -> ` rename/copy arrow for R/C status entries, so the arrow
 * split applies only when the two-character status prefix contains R or C;
 * any other line keeps its whole path even if the filename itself contains
 * a literal ' -> '.
 */
const extractPorcelainPath = (line: string): string => {
  const status = line.slice(0, 2)
  const rest = line.slice(3)
  if (status.includes('R') || status.includes('C')) {
    return rest.split(' -> ').at(-1)?.trim() ?? ''
  }
  return rest.trim()
}

/**
 * Derives the identity file list and identity status from an uncollapsed
 * `git status --porcelain -uall` listing. Shared by the full bundle builder
 * and the identity-only snapshot path so the two snapshotId computations can
 * never drift apart.
 */
function deriveIdentityFromPorcelain(
  identityLines: string[],
  fallbackFiles?: string[],
): { files: string[]; identityStatus: string } {
  let files = identityLines.map(extractPorcelainPath).filter(Boolean)
  if (files.length === 0 && fallbackFiles) files = fallbackFiles
  // Drop session-artifact lines from the porcelain status used for identity;
  // the caller still returns the real, unfiltered status for display.
  const identityStatus = identityLines
    .filter((line) => {
      const p = extractPorcelainPath(line)
      return p ? !isSessionArtifactPath(p) : true
    })
    .join('\n')
  return {
    files: files.filter((f) => !isSessionArtifactPath(f)),
    identityStatus,
  }
}

// P3-T11 (LI-10): optional Semgrep --baseline-commit security layer. Semgrep
// is a user-installed sidecar; every failure mode (absent binary, missing
// merge-base, nonzero exit, timeout) degrades to a soft securityScan.status
// and never breaks the bundle.
const SEMGREP_SCANNABLE_EXTENSIONS = new Set([
  '.c',
  '.cc',
  '.cpp',
  '.cxx',
  '.cs',
  '.go',
  '.java',
  '.kt',
  '.kts',
  '.scala',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.php',
  '.py',
  '.rb',
  '.rs',
  '.swift',
])

const isSemgrepScannableFile = (file: string): boolean =>
  SEMGREP_SCANNABLE_EXTENSIONS.has(
    path.posix.extname(file.replace(/\\/g, '/')).toLowerCase(),
  )

type SecurityScanResult = {
  status: 'ok' | 'unavailable' | 'error' | 'skipped'
  findings: LanguageDiagnostic[]
  reason?: string
  toolVersion?: string
  /** Set when the semgrep file cap truncated the scanned file list. */
  truncated?: boolean
}

const isSafeRefName = (ref: string): boolean =>
  /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(ref)

const isHexCommit = (ref: string): boolean => /^[0-9a-f]{4,40}$/.test(ref)

/**
 * Baseline for the new-code-only scan: the merge-base with the default branch
 * (origin/HEAD), falling back to HEAD~1 for repos without a remote. Returns
 * null when no ancestor exists (e.g. a single-commit repository), which the
 * caller surfaces as 'skipped'.
 */
async function resolveSecurityScanBaseline(params: {
  cwd: string
  headCommit: string
  signal?: AbortSignal
}): Promise<string | null> {
  // (reliability: bundle-rev-parse-head-unbounded) the baseline resolution
  // is best-effort fail-open, so every spawn runs under the identity
  // deadline: a wedged git resolves exitCode -1 and the scan surfaces
  // 'skipped' (no-baseline-commit) instead of hanging the bundle.
  const bounded = {
    timeoutMs: SNAPSHOT_ID_GIT_TIMEOUT_MS,
    maxOutputBytes: 4096,
  }
  const defaultRef = await runGitBounded(
    ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'],
    params.cwd,
    params.signal,
    bounded,
  )
  if (defaultRef.exitCode === 0) {
    const ref = defaultRef.stdout.trim()
    if (isSafeRefName(ref)) {
      const mergeBase = await runGitBounded(
        ['merge-base', 'HEAD', ref],
        params.cwd,
        params.signal,
        bounded,
      )
      const candidate = mergeBase.stdout.trim()
      if (
        mergeBase.exitCode === 0 &&
        isHexCommit(candidate) &&
        candidate !== params.headCommit
      ) {
        return candidate
      }
    }
  }
  const parent = await runGitBounded(
    ['rev-parse', '--verify', 'HEAD~1'],
    params.cwd,
    params.signal,
    bounded,
  )
  const fallback = parent.stdout.trim()
  if (
    parent.exitCode === 0 &&
    isHexCommit(fallback) &&
    fallback !== params.headCommit
  ) {
    return fallback
  }
  return null
}

async function resolveSecurityScan(params: {
  cwd: string
  files: string[]
  headCommit: string
  /**
   * When set, an identical scan already ran for the before-bundle of this
   * worktree (targeted validation): the scan is skipped, not re-run.
   */
  skipScan?: boolean
  runner?: SemgrepRunner
  signal?: AbortSignal
}): Promise<SecurityScanResult> {
  const scannable = params.files.filter(isSemgrepScannableFile)
  if (scannable.length === 0) {
    return { status: 'skipped', reason: 'no-source-files', findings: [] }
  }
  const baselineCommit = await resolveSecurityScanBaseline(params)
  if (!baselineCommit) {
    return { status: 'skipped', reason: 'no-baseline-commit', findings: [] }
  }
  try {
    const result = await runSemgrepBaseline({
      cwd: params.cwd,
      baselineCommit,
      files: scannable,
      skipScan: params.skipScan,
      runner: params.runner,
      // P3 audit fix: forward the caller's cancellation so an aborted scan
      // settles promptly instead of waiting out the full timeout.
      signal: params.signal,
    })
    if (result.status === 'ok') {
      return {
        status: 'ok',
        findings: result.findings,
        ...(result.toolVersion ? { toolVersion: result.toolVersion } : {}),
        ...(result.truncated ? { truncated: result.truncated } : {}),
      }
    }
    return {
      status: result.status,
      reason: result.reason,
      findings: result.findings,
    }
  } catch (error) {
    // Fail-open: the optional security layer must never break the bundle.
    return {
      status: 'error',
      reason: error instanceof Error ? error.message : String(error),
      findings: [],
    }
  }
}

/**
 * Bare hex evidence id for the change-review bundle (files/diff/empty-tree).
 * Not a gate attestation token — specialist/security/code-reviewer credit uses
 * opaque gate-owned `v3:…` fingerprints (`snapshot_id` / `snapshot_fingerprint`).
 * Empty-tree evidence must not clear specialist review while pending files exist.
 */

/**
 * Bounded per-file byte hashing for snapshot identity (async, capped).
 * Exported for the fixed perf baseline (CASE 12b) and tests.
 */
export async function hashIdentityFileBytes(
  hash: ReturnType<typeof createHash>,
  cwd: string,
  files: string[],
): Promise<void> {
  const sorted = [...files].sort()
  // Per-file stat + capped-prefix reads run through a bounded read window
  // (perf: snapshot-identity-serial-file-reads) — the identity path runs on
  // every bundle build and twice per run_targeted_validation call, so a
  // strictly serial loop paid one full read round-trip per changed file. At
  // most SNAPSHOT_ID_READ_CONCURRENCY reads are in flight, and each settled
  // read's contribution is hashed in the same sorted order the serial loop
  // used (so the snapshotId is byte-identical) with its byte buffer released
  // immediately after (perf:
  // snapshot-identity-contributions-unbounded-retention): the previous
  // map-then-join shape retained every per-file capped byte prefix in memory
  // before hashing — a changedFileCount × 1MiB retention spike — whereas
  // retention is now bounded by the read window instead of the changed-file
  // count.
  const readContribution = async (
    file: string,
  ): Promise<{ header: string; bytes?: Buffer } | null> => {
    const absolute = path.join(cwd, file)
    const info = await stat(absolute).catch(() => null)
    if (!info?.isFile()) return null
    // Tracked content is already represented by the capped diff. Adding a
    // capped byte prefix per file also binds untracked files and protects
    // against parsing omissions in porcelain status output; the untruncated
    // size is mixed in so the cap boundary can never alias two states.
    const header = `\0${file}\0size:${info.size}\0`
    if (info.size === 0) return { header }
    const byteCount = Math.min(info.size, MAX_SNAPSHOT_ID_FILE_BYTES)
    const handle = await open(absolute, 'r')
    try {
      const buffer = Buffer.allocUnsafe(byteCount)
      const read = await handle.read(buffer, 0, byteCount, 0)
      return { header, bytes: buffer.subarray(0, read.bytesRead) }
    } finally {
      await handle.close()
    }
  }
  let nextToStart = 0
  const inFlight: Promise<{ header: string; bytes?: Buffer } | null>[] = []
  // The fan-out is total: a no-op rejection observer is attached at
  // CREATION time — the push-time .catch shape — rather than after the
  // oldest awaited read rejects. Thread scheduling completes the opens in
  // any order, so a sibling read can already have rejected by the time a
  // catch around `await pending` would run, and an unhandledRejection event
  // that already fired cannot be retracted by a later handler
  // (allSettled-after-the-fact was too late for exactly that reason). The
  // observer only marks sibling rejections observed; the original error
  // still propagates through `await pending` below and the caller fails
  // closed.
  const observed = (
    read: Promise<{ header: string; bytes?: Buffer } | null>,
  ): Promise<{ header: string; bytes?: Buffer } | null> => {
    void read.catch(() => null)
    return read
  }
  while (
    inFlight.length < SNAPSHOT_ID_READ_CONCURRENCY &&
    nextToStart < sorted.length
  ) {
    inFlight.push(observed(readContribution(sorted[nextToStart++]!)))
  }
  let settled = 0
  while (settled < sorted.length) {
    const pending = inFlight.shift()!
    // Keep the read window full while the oldest read settles: later files
    // read concurrently, earlier files hash in sorted order, and each hashed
    // buffer is released before the next contribution is taken.
    while (
      inFlight.length < SNAPSHOT_ID_READ_CONCURRENCY &&
      nextToStart < sorted.length
    ) {
      inFlight.push(observed(readContribution(sorted[nextToStart++]!)))
    }
    const contribution = await pending
    if (contribution === null) {
      settled++
      continue
    }
    hash.update(contribution.header)
    if (contribution.bytes !== undefined) hash.update(contribution.bytes)
    settled++
  }
}

/**
 * Core snapshot-identity computation shared by the full change-review bundle
 * and the identity-only targeted-validation path, so the two snapshotId
 * computations can never drift apart. `identityLines` is the uncollapsed
 * `git status --porcelain -uall` output. `workspaceState` no longer
 * participates in the hash — the id is content-keyed (see the preimage
 * comment below) — but stays on the signature so callers keep one shape;
 * the bundle payload still echoes its journal coordinates. Throws on git
 * failure; callers map that to their own error shape.
 */
async function buildSnapshotIdentity(params: {
  cwd: string
  headCommit: string
  identityLines: string[]
  /**
   * UNtruncated byte total of the `git status --porcelain -uall` spawn that
   * produced `identityLines` (runGitBounded's stdoutTotalBytes). The spawn
   * excludes `.agents/sessions/**` at the pathspec — mirroring the diff
   * spawn — so the total is artifact-clean: session plan artifacts never
   * reach it and can never move the snapshotId through the status-length
   * term. The bounded spawn retains only the first
   * MAX_SNAPSHOT_ID_DIFF_BYTES bytes, so changed/untracked files past the
   * cap are dropped from the identity lines; the total joins the hash
   * preimage (the status-length term) so the cap boundary can never alias
   * two distinct worktree states.
   */
  statusTotalBytes: number
  workspaceState?: WorkspaceStateV1
  signal?: AbortSignal
}): Promise<{
  snapshotId: string
  files: string[]
  identityStatus: string
  committedDiff?: string
}> {
  const hasWorktreeChanges = params.identityLines.some(
    (line) => (line.slice(3).split(' -> ').at(-1)?.trim() ?? '') !== '',
  )
  let committedDiff: string | undefined
  if (!hasWorktreeChanges) {
    // Fallback: when the worktree is clean (changes already committed),
    // review the last commit's diff so committed changes still get reviewed
    // instead of producing an empty bundle reviewers cannot attest to. Bounded
    // like the identity diff: the capped prefix satisfies both consumers (the
    // diff headers near the front of the output feed the identity file list,
    // and the bundle's presentation diff is capped far above its own max_chars
    // budget anyway), and the deadline keeps a wedged git from hanging the
    // identity path.
    const parentCheck = await runGitBounded(
      ['rev-parse', 'HEAD~1'],
      params.cwd,
      params.signal,
      {
        timeoutMs: SNAPSHOT_ID_GIT_TIMEOUT_MS,
        maxOutputBytes: MAX_SNAPSHOT_ID_DIFF_BYTES,
      },
    )
    if (parentCheck.exitCode === 0) {
      const committedDiffResult = await runGitBounded(
        ['diff', '--no-color', 'HEAD~1', 'HEAD', '--'],
        params.cwd,
        params.signal,
        {
          timeoutMs: SNAPSHOT_ID_GIT_TIMEOUT_MS,
          maxOutputBytes: MAX_SNAPSHOT_ID_DIFF_BYTES,
        },
      )
      if (
        committedDiffResult.exitCode === 0 ||
        committedDiffResult.exitCode === 1
      ) {
        committedDiff = committedDiffResult.stdout
      }
    }
  }
  const { files, identityStatus } = deriveIdentityFromPorcelain(
    params.identityLines,
    committedDiff === undefined ? undefined : committedDiffFiles(committedDiff),
  )
  // Presentation diffs are intentionally bounded. Snapshot identity is
  // bounded at the SPAWN level (perf:
  // snapshot-identity-diff-capture-unbounded): runGitBounded retains only the
  // first MAX_SNAPSHOT_ID_DIFF_BYTES bytes of the binary diff — the complete
  // output is never buffered on the identity path — and enforces a wall-clock
  // deadline. Per-file byte prefixes are read asynchronously with true sizes
  // mixed in so truncation boundaries cannot alias two distinct worktree
  // states; the untruncated diff byte total joins them in the hash below.
  const fullDiff = await runGitBounded(
    ['diff', '--binary', 'HEAD', '--', '.', ':(exclude).agents/sessions/**'],
    params.cwd,
    params.signal,
    {
      timeoutMs: SNAPSHOT_ID_GIT_TIMEOUT_MS,
      maxOutputBytes: MAX_SNAPSHOT_ID_DIFF_BYTES,
    },
  )
  if (fullDiff.exitCode !== 0 && fullDiff.exitCode !== 1) {
    throw new Error(
      fullDiff.stderr.trim() ||
        `git diff exited with code ${fullDiff.exitCode}.`,
    )
  }
  // Content-keyed preimage: the bare-hex snapshotId is evidence-only worktree
  // content identity (files/diff/HEAD), so it changes ONLY on real
  // worktree/HEAD drift. The harness workspace journal
  // (workspaceState.revision + workspaceState.snapshotId) used to be mixed in
  // here, but that journal advances on EVERY confirmed edit AND
  // conservatively on every run_terminal_command / run_file_change_hooks /
  // run_targeted_validation / custom-tool call, so during one gate cycle
  // (repair → validation → hooks → reviewers) parallel specialists each read
  // a DIFFERENT bare-hex id with zero file changes — the id was useless as a
  // drift signal and reviewers narrated spurious "live-bundle drift".
  // Callers that need the journal binding still get workspaceRevision /
  // workspaceSnapshotId echoed in the payload, and the harness-store scoping
  // in getChangeReviewBundle (record.snapshotId === snapshotId) now keeps
  // records in scope exactly while the content they were written against is
  // unchanged.
  const hash = createHash('sha256')
    .update(`${params.headCommit}\0${identityStatus}\0`)
    // (correctness: porcelain-total-bytes-not-hashed) identityStatus and the
    // identity file list are built from only the RETAINED porcelain prefix:
    // runGitBounded keeps the first MAX_SNAPSHOT_ID_DIFF_BYTES bytes of the
    // `git status --porcelain -uall` output that produced identityLines, so
    // changed/untracked files past the cap are silently dropped from the
    // identity lines and `files` — and untracked files never appear in the
    // tracked diff either, so two worktree states differing only past the
    // cap used to hash to an identical snapshotId and the
    // runTargetedValidation before/after drift check failed open. The
    // spawn's UNtruncated byte total joins the preimage here, mirroring the
    // diff-length term below, so the cap boundary can never alias two
    // distinct worktree states. The porcelain spawn excludes
    // `.agents/sessions/**` at the pathspec (the diff spawn's identical
    // exclusion), so the total counts only identity-relevant bytes and plan
    // artifacts cannot move the id through the status-length term.
    .update(`\0status-length:${params.statusTotalBytes}\0`)
    // stdout is already retained only up to MAX_SNAPSHOT_ID_DIFF_BYTES by the
    // bounded spawn, so this hashes exactly the capped prefix; the UNtruncated
    // byte total (stdoutTotalBytes counts every byte git emitted, retained or
    // not) is mixed in so states on either side of the cap cannot alias.
    .update(fullDiff.stdout)
    .update(`\0diff-length:${fullDiff.stdoutTotalBytes}\0`)
  await hashIdentityFileBytes(hash, params.cwd, files)
  return {
    snapshotId: hash.digest('hex'),
    files,
    identityStatus,
    ...(committedDiff !== undefined ? { committedDiff } : {}),
  }
}

/**
 * Identity-only snapshot derivation for callers that need ONLY the
 * snapshotId (targeted validation runs this twice per call for before/after
 * drift detection): skips the presentation diff, harness-store lookups, and
 * the semgrep scan that the full bundle builds, while computing the exact
 * same snapshotId as {@link getChangeReviewBundle} for the same worktree
 * state. The id is content-keyed, so those before/after drift checks fail
 * closed only on real worktree/HEAD drift — a harness workspace-journal
 * advance (every confirmed edit, plus the conservative advances on
 * validation/hooks/terminal/custom-tool calls) no longer registers as
 * drift.
 */
export async function computeWorktreeSnapshotIdentity(params: {
  cwd: string
  workspaceState?: WorkspaceStateV1
  signal?: AbortSignal
}): Promise<{ snapshotId: string } | { errorMessage: string }> {
  // Bounded deadline on every identity-path git spawn
  // (perf: identity-git-spawns-no-deadline): runTargetedValidation executes
  // this path twice per call, so a wedged git fails closed instead of hanging.
  const head = await runGitBounded(
    ['rev-parse', 'HEAD'],
    params.cwd,
    params.signal,
    {
      timeoutMs: SNAPSHOT_ID_GIT_TIMEOUT_MS,
      maxOutputBytes: MAX_SNAPSHOT_ID_DIFF_BYTES,
    },
  )
  if (head.exitCode !== 0) {
    return {
      errorMessage:
        head.stderr.trim() || 'Unable to attest validation snapshot.',
    }
  }
  const porcelain = await runGitBounded(
    // (correctness: porcelain-total-bytes-not-hashed) the artifact exclusion
    // lives in the pathspec so the spawn's UNtruncated byte total — the
    // status-length identity term — is artifact-clean: .agents/sessions
    // plan artifacts never reach it and can never move the snapshotId,
    // mirroring the diff spawn's identical `:(exclude)` pathspec. The
    // line-level isSessionArtifactPath filter stays as defense in depth.
    [
      'status',
      '--porcelain',
      '-uall',
      '--',
      '.',
      ':(exclude).agents/sessions/**',
    ],
    params.cwd,
    params.signal,
    {
      timeoutMs: SNAPSHOT_ID_GIT_TIMEOUT_MS,
      maxOutputBytes: MAX_SNAPSHOT_ID_DIFF_BYTES,
    },
  )
  if (porcelain.exitCode !== 0) {
    return {
      errorMessage:
        porcelain.stderr.trim() ||
        `git status exited with code ${porcelain.exitCode}.`,
    }
  }
  const identityLines = porcelain.stdout
    .split('\n')
    .filter((line) => line.trim() !== '')
  try {
    const identity = await buildSnapshotIdentity({
      cwd: params.cwd,
      headCommit: head.stdout.trim(),
      identityLines,
      statusTotalBytes: porcelain.stdoutTotalBytes,
      workspaceState: params.workspaceState,
      signal: params.signal,
    })
    return { snapshotId: identity.snapshotId }
  } catch (error) {
    return {
      errorMessage: error instanceof Error ? error.message : String(error),
    }
  }
}

export async function getChangeReviewBundle(params: {
  cwd: string
  stateDir?: string
  max_chars?: number
  workspaceState?: WorkspaceStateV1
  signal?: AbortSignal
  securityScanRunner?: SemgrepRunner
  /**
   * Skip the semgrep baseline scan for THIS bundle: targeted validation sets
   * it on the after-bundle because the before-bundle already ran the
   * identical scan for the same worktree. Additive; defaults to false.
   */
  skipSecurityScan?: boolean
}): Promise<CodebuffToolOutput<'get_change_review_bundle'>> {
  // (reliability: bundle-rev-parse-head-unbounded) the ENTIRE prelude runs
  // under the identity deadline: gitStatus threads its timeoutMs, HEAD
  // resolves through runGitBounded (a timeout resolves exitCode -1, which
  // the head.exitCode !== 0 arm below already fails closed on), and the
  // workspace identity resolves under the same bound — a wedged git can no
  // longer hang the bundle the gate invokes every cycle.
  const [git, head, workspace] = await Promise.all([
    gitStatus({
      cwd: params.cwd,
      include_diff: true,
      max_chars: params.max_chars ?? 80_000,
      signal: params.signal,
      timeoutMs: SNAPSHOT_ID_GIT_TIMEOUT_MS,
    }),
    runGitBounded(['rev-parse', 'HEAD'], params.cwd, params.signal, {
      timeoutMs: SNAPSHOT_ID_GIT_TIMEOUT_MS,
      maxOutputBytes: 4096,
    }),
    resolveWorkspaceIdentity({
      cwd: params.cwd,
      signal: params.signal,
      timeoutMs: SNAPSHOT_ID_GIT_TIMEOUT_MS,
    }),
  ])
  const value = git[0]?.type === 'json' ? git[0].value : undefined
  // Direct gitStatus() never emits the per-turn suppressed { unchanged }
  // variant (only applyGitStatusGate does). Fail closed if it appears so
  // TypeScript narrows to the full status/diff/truncated branch below.
  if (
    !value ||
    'errorMessage' in value ||
    'unchanged' in value ||
    head.exitCode !== 0
  ) {
    return [
      {
        type: 'json',
        value: {
          // (reliability: head-failure-empty-error-message) the head term
          // coalesces with `||`, not `??`: a silent non-zero `rev-parse HEAD`
          // exit resolves with EMPTY stderr (the normal-close settle path
          // carries no stderrNote) and an empty string is not nullish, so a
          // `??` chain surfaced `errorMessage: ''` with the documented
          // fallback unreachable — the `||` shape every sibling uses.
          errorMessage:
            (value && 'errorMessage' in value
              ? value.errorMessage
              : value && 'unchanged' in value
                ? value.note ||
                  'git_status returned a suppressed unchanged payload; expected a full status observation.'
                : undefined) ??
            (head.stderr.trim() || 'Unable to build change review bundle.'),
        },
      },
    ]
  }
  const headCommit = head.stdout.trim()
  const status = value.status
  let diff = value.diff ?? ''
  // Derive `files` and the identity status from an uncollapsed porcelain
  // listing. `gitStatus` runs `git status --short --branch`, which collapses a
  // fully untracked directory into a single shallow entry (e.g. `?? .agents/`)
  // that would slip past `isSessionArtifactPath`. `-uall` lists every untracked
  // file individually so session artifacts are matched and filtered reliably,
  // and the `:(exclude).agents/sessions/**` pathspec keeps the spawn's
  // untruncated byte total (the status-length identity term) artifact-clean —
  // plan artifacts cannot move the snapshotId through it.
  // A4 advisory (identity-git-spawns-no-deadline parity): this porcelain spawn
  // ran with no wall-clock deadline while the identity-only path bounds the
  // same call. Use the identical bounds so a wedged git fails closed instead of
  // hanging the bundle build; a timeout resolves exitCode -1, which the
  // unchanged error mapping below already reports via the exitCode !== 0 branch.
  const porcelain = await runGitBounded(
    // (correctness: porcelain-total-bytes-not-hashed) the artifact exclusion
    // lives in the pathspec so the spawn's UNtruncated byte total — the
    // status-length identity term — is artifact-clean: .agents/sessions
    // plan artifacts never reach it and can never move the snapshotId,
    // mirroring the diff spawn's identical `:(exclude)` pathspec. The
    // line-level isSessionArtifactPath filter stays as defense in depth.
    [
      'status',
      '--porcelain',
      '-uall',
      '--',
      '.',
      ':(exclude).agents/sessions/**',
    ],
    params.cwd,
    params.signal,
    {
      timeoutMs: SNAPSHOT_ID_GIT_TIMEOUT_MS,
      maxOutputBytes: MAX_SNAPSHOT_ID_DIFF_BYTES,
    },
  )
  if (porcelain.exitCode !== 0) {
    return [
      {
        type: 'json',
        value: {
          errorMessage:
            porcelain.stderr.trim() ||
            `git status exited with code ${porcelain.exitCode}.`,
        },
      },
    ]
  }
  const identityLines = porcelain.stdout
    .split('\n')
    .filter((line) => line.trim() !== '')
  // Shared identity derivation (also used by the identity-only snapshot path)
  // so the bundle snapshotId and the targeted-validation drift checks can
  // never drift apart. Session plan artifacts under `.agents/sessions/**` are
  // filtered out of both the identity file list and the identity status while
  // the returned `status` below stays the real, unfiltered observation.
  let snapshotId: string
  let files: string[]
  try {
    const identity = await buildSnapshotIdentity({
      cwd: params.cwd,
      headCommit,
      identityLines,
      statusTotalBytes: porcelain.stdoutTotalBytes,
      workspaceState: params.workspaceState,
      signal: params.signal,
    })
    snapshotId = identity.snapshotId
    files = identity.files
    if (identity.committedDiff !== undefined) diff = identity.committedDiff
  } catch (error) {
    return [
      {
        type: 'json',
        value: {
          errorMessage: error instanceof Error ? error.message : String(error),
        },
      },
    ]
  }
  let ownership: Record<string, unknown>[] = []
  let validation: Record<string, unknown>[] = []
  let findings: Record<string, unknown>[] = []
  if (params.stateDir) {
    const store = new LocalHarnessStore(params.stateDir)
    const changedFiles = new Set(files.map(normalizeFile))
    const inScope = (record: Record<string, unknown>, recordFiles: string[]) =>
      record.repositoryId === workspace.repositoryId &&
      record.workspaceId === workspace.workspaceId &&
      record.snapshotId === snapshotId &&
      recordFiles.some((file) => changedFiles.has(normalizeFile(file)))
    ownership = store
      .list(workspace.repositoryId, 'ownership')
      .filter((record) =>
        inScope(
          record,
          Array.isArray(record.changes)
            ? record.changes.flatMap((change) =>
                typeof change === 'object' &&
                change &&
                'path' in change &&
                typeof change.path === 'string'
                  ? [change.path]
                  : [],
              )
            : [],
        ),
      )
    validation = store
      .list(workspace.repositoryId, 'validation')
      .filter((record) =>
        inScope(
          record,
          Array.isArray(record.files)
            ? record.files.filter(
                (file): file is string => typeof file === 'string',
              )
            : [],
        ),
      )
    findings = store
      .list(workspace.repositoryId, 'findings')
      .filter(
        (record) =>
          record.status !== 'resolved' && record.status !== 'invalidated',
      )
      .filter((record) =>
        inScope(
          record,
          Array.isArray(record.files)
            ? record.files.filter(
                (file): file is string => typeof file === 'string',
              )
            : [],
        ),
      )
  }
  const securityScan = await resolveSecurityScan({
    cwd: params.cwd,
    files,
    headCommit,
    skipScan: params.skipSecurityScan,
    runner: params.securityScanRunner,
    signal: params.signal,
  })
  return [
    {
      type: 'json',
      value: {
        snapshotId,
        repositoryId: workspace.repositoryId,
        workspaceId: workspace.workspaceId,
        workspaceRevision: params.workspaceState?.revision,
        workspaceSnapshotId: params.workspaceState?.snapshotId,
        headCommit,
        status,
        files,
        diff,
        truncated: value.truncated ?? false,
        ownership,
        validation,
        findings,
        securityScan,
        snapshotIdUsage:
          "evidence-only: the bare-hex snapshotId is content-keyed worktree identity (files/diff/HEAD) for drift checks only — stable while no file or HEAD changes; a changed id means real worktree content drift. NEVER pass it (or any bare hex) as params.snapshot_id or params.snapshot_fingerprint — gate/specialist attestation uses the parent gate's opaque v3:<64-hex> token; manual spawns omit params.snapshot_id entirely (scoped files go in params.files).",
      },
    },
  ]
}
