import { createHash } from 'node:crypto'
import { lstat, open, readlink } from 'node:fs/promises'
import path from 'node:path'

import { LocalHarnessStore } from '../services/local-harness-store'
import { resolveWorkspaceIdentity } from '../services/repository-identity'
import { runSemgrepBaseline } from '../services/semgrep-baseline'
import { ExecutionRefusalError, isExecutionRefusalError, scheduleNodeDeadline } from '../services/execution-launch'
import { gitStatus, runGitBounded } from './git-status'

import type { CodebuffToolOutput } from '../../../common/src/tools/list'
import type { WorkspaceStateV1 } from '@codebuff/common/types/workspace-state'
import type { LanguageDiagnostic } from './language-diagnostics'
import type { SemgrepRunner } from '../services/semgrep-baseline'
import type { ExecutionAdapterContext, Refusal } from '@codebuff/common/types/contracts/execution-context'

const normalizeFile = (file: string) =>
  file.replace(/\\/g, '/').replace(/^\.\//, '')

const isSessionArtifactPath = (file: string): boolean => {
  const normalized = file.replace(/\\/g, '/').replace(/^\.\//, '')
  return normalized.startsWith('.agents/sessions/')
}

// Retention is bounded independently from content identity. Git stdout is
// streamed into a full digest; status membership must fit before parsing.
const MAX_SNAPSHOT_ID_DIFF_BYTES = 4 * 1024 * 1024
const SNAPSHOT_ID_FILE_CHUNK_BYTES = 64 * 1024
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
  try {
    // Identity status lines use JSON quoting after parsing NUL records.
    return JSON.parse(raw) as string
  } catch {
    // Git presentation diffs may instead contain C-style octal escapes.
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

// NUL status parsing canonicalizes paths as JSON, retaining whitespace and arrows.
const extractPorcelainPath = (line: string): string => line.slice(3)

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
  let files = identityLines
    .map((line) => unquoteGitPath(extractPorcelainPath(line)))
    .filter(Boolean)
  if (files.length === 0 && fallbackFiles) files = fallbackFiles
  // Drop session-artifact lines from the porcelain status used for identity;
  // the caller still returns the real, unfiltered status for display.
  const identityStatus = identityLines
    .filter((line) => {
      const p = unquoteGitPath(extractPorcelainPath(line))
      return p ? !isSessionArtifactPath(p) : true
    })
    .join('\n')
  return {
    files: files.filter((f) => !isSessionArtifactPath(f)),
    identityStatus,
  }
}

function identityLinesFromPorcelain(stdout: string): string[] {
  if (stdout && !stdout.endsWith('\0')) {
    throw new Error(
      'Incomplete Git status record; review membership unavailable.',
    )
  }
  const entries = stdout.split('\0')
  const lines: string[] = []
  for (let index = 0; index < entries.length - 1; index++) {
    const entry = entries[index]!
    if (entry.length < 4 || entry[2] !== ' ') {
      throw new Error(
        'Invalid Git status record; review membership unavailable.',
      )
    }
    const status = entry.slice(0, 2)
    const file = entry.slice(3)
    lines.push(`${status} ${JSON.stringify(file)}`)
    if (status.includes('R') || status.includes('C')) {
      // In -z format the destination is first, followed by the source.
      if (!entries[++index]) throw new Error('Incomplete Git rename record.')
    }
  }
  return lines
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
  executionRefusal?: Refusal
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
  executionContext?: ExecutionAdapterContext
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
    { ...bounded, executionContext: params.executionContext, branchId: 'bundle.security-default-ref', phase: 'security-baseline' },
  )
  if (defaultRef.executionRefusal) throw new ExecutionRefusalError(defaultRef.executionRefusal)
  if (defaultRef.exitCode === 0) {
    const ref = defaultRef.stdout.trim()
    if (isSafeRefName(ref)) {
      const mergeBase = await runGitBounded(
        ['merge-base', 'HEAD', ref],
        params.cwd,
        params.signal,
        { ...bounded, executionContext: params.executionContext, branchId: 'bundle.security-merge-base', phase: 'security-baseline' },
      )
      if (mergeBase.executionRefusal) throw new ExecutionRefusalError(mergeBase.executionRefusal)
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
    { ...bounded, executionContext: params.executionContext, branchId: 'bundle.security-parent', phase: 'security-baseline' },
  )
  if (parent.executionRefusal) throw new ExecutionRefusalError(parent.executionRefusal)
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
  executionContext?: ExecutionAdapterContext
}): Promise<SecurityScanResult> {
  const scannable = params.files.filter(isSemgrepScannableFile)
  if (scannable.length === 0) {
    return { status: 'skipped', reason: 'no-source-files', findings: [] }
  }
  try {
    const baselineCommit = await resolveSecurityScanBaseline(params)
    if (!baselineCommit) {
      return { status: 'skipped', reason: 'no-baseline-commit', findings: [] }
    }
    const result = await runSemgrepBaseline({
      cwd: params.cwd,
      baselineCommit,
      files: scannable,
      skipScan: params.skipScan,
      runner: params.runner,
      // P3 audit fix: forward the caller's cancellation so an aborted scan
      // settles promptly instead of waiting out the full timeout.
      signal: params.signal,
      executionContext: params.executionContext,
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
      ...('executionRefusal' in result ? { executionRefusal: result.executionRefusal as Refusal } : {}),
    }
  } catch (error) {
    // Fail-open: the optional security layer must never break the bundle.
    return {
      status: isExecutionRefusalError(error) ? 'unavailable' : 'error',
      reason: error instanceof Error ? error.message : String(error),
      findings: [],
      ...(isExecutionRefusalError(error) ? { executionRefusal: error.refusal } : {}),
    }
  }
}

/**
 * Bare hex evidence id for the change-review bundle (files/diff/empty-tree).
 * Not a gate attestation token — specialist/security/code-reviewer credit uses
 * opaque gate-owned `v3:…` fingerprints (`snapshot_id` / `snapshot_fingerprint`).
 * Empty-tree evidence must not clear specialist review while pending files exist.
 */

/** Hash complete file contents with bounded allocation and verified metadata. */
export async function hashIdentityFileBytes(
  hash: ReturnType<typeof createHash>,
  cwd: string,
  files: string[],
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<void> {
  options = { ...options }
  const controller = new AbortController()
  const onAbort = () => controller.abort(options.signal?.reason)
  if (options.signal?.aborted) onAbort()
  options.signal?.addEventListener('abort', onAbort, { once: true })
  const timeoutMs = options.timeoutMs ?? SNAPSHOT_ID_GIT_TIMEOUT_MS
  const startedAt = performance.now()
  const cancelDeadline = scheduleNodeDeadline(
    () => Math.max(0, (Number.isFinite(timeoutMs) ? timeoutMs : 0) - (performance.now() - startedAt)),
    () =>
      controller.abort(
        new Error(`File identity timed out after ${timeoutMs}ms`),
      ),
    // Keep this independent file-hash deadline referenced, as before.
    {
      set(delay, callback) { return setTimeout(callback, delay) },
      clear(timer) { clearTimeout(timer as ReturnType<typeof setTimeout>) },
    },
  )
  const check = () => controller.signal.throwIfAborted()
  // Bigint nanosecond metadata is compared, not hashed: touching an unchanged
  // file must not change identity. Replacement, growth and in-place writes
  // during a read fail closed instead of publishing a mixed content digest.
  const metadata = (info: {
    dev: bigint
    ino: bigint
    size: bigint
    mode: bigint
    mtimeNs: bigint
    ctimeNs: bigint
  }) =>
    [info.dev, info.ino, info.size, info.mode, info.mtimeNs, info.ctimeNs].join(
      ':',
    )
  const readContribution = async (file: string): Promise<string> => {
    check()
    const absolute = path.join(cwd, file)
    const before = await lstat(absolute, { bigint: true }).catch((error) => {
      if (error?.code === 'ENOENT') return undefined
      throw error
    })
    check()
    if (!before) return `${JSON.stringify(file)}:missing\0`
    const header = `${JSON.stringify(file)}:mode:${before.mode}:size:${before.size}\0`
    if (before.isSymbolicLink()) {
      const target = await readlink(absolute, { encoding: 'buffer' })
      const after = await lstat(absolute, { bigint: true })
      check()
      if (metadata(before) !== metadata(after)) {
        throw new Error(`File changed while hashing identity: ${file}`)
      }
      return `${header}link:${createHash('sha256').update(target).digest('hex')}\0`
    }
    if (!before.isFile()) {
      throw new Error(`Unsupported identity file type: ${file}`)
    }
    const handle = await open(absolute, 'r')
    try {
      check()
      if (metadata(before) !== metadata(await handle.stat({ bigint: true }))) {
        throw new Error(`File changed before hashing identity: ${file}`)
      }
      const content = createHash('sha256')
      const buffer = Buffer.allocUnsafe(SNAPSHOT_ID_FILE_CHUNK_BYTES)
      let total = 0n
      while (true) {
        check()
        const read = await handle.read(buffer, 0, buffer.length, null)
        check()
        if (read.bytesRead === 0) break
        total += BigInt(read.bytesRead)
        content.update(buffer.subarray(0, read.bytesRead))
      }
      const after = await handle.stat({ bigint: true })
      const current = await lstat(absolute, { bigint: true })
      check()
      if (
        total !== before.size ||
        metadata(before) !== metadata(after) ||
        metadata(before) !== metadata(current)
      ) {
        throw new Error(`File changed while hashing identity: ${file}`)
      }
      return `${header}file:${content.digest('hex')}\0`
    } finally {
      await handle.close()
    }
  }
  const task = async () => {
    const sorted = [...new Set(files)].sort()
    for (
      let offset = 0;
      offset < sorted.length;
      offset += SNAPSHOT_ID_READ_CONCURRENCY
    ) {
      check()
      // Promise.all observes every sibling at creation, including failures.
      // Only compact digests survive a batch; file allocations stay <= 8x64KiB.
      const contributions = await Promise.all(
        sorted
          .slice(offset, offset + SNAPSHOT_ID_READ_CONCURRENCY)
          .map(readContribution),
      )
      for (const contribution of contributions) hash.update(contribution)
    }
    check()
  }
  let removeCancel = () => {}
  const cancelled = new Promise<never>((_, reject) => {
    const rejectAbort = () =>
      reject(controller.signal.reason ?? new Error('Aborted'))
    controller.signal.addEventListener('abort', rejectAbort, { once: true })
    removeCancel = () =>
      controller.signal.removeEventListener('abort', rejectAbort)
    if (controller.signal.aborted) rejectAbort()
  })
  try {
    // Deadline/cancellation returns promptly even while an OS read settles.
    // The observed task closes its handles when pending I/O returns.
    await Promise.race([task(), cancelled])
  } finally {
    controller.abort(new Error('Identity hashing settled'))
    cancelDeadline()
    removeCancel()
    options.signal?.removeEventListener('abort', onAbort)
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
  statusSha256: string
  workspaceState?: WorkspaceStateV1
  signal?: AbortSignal
  executionContext?: ExecutionAdapterContext
  phase?: string
}): Promise<{
  snapshotId: string
  files: string[]
  identityStatus: string
  committedDiff?: string
}> {
  const hasWorktreeChanges = params.identityLines.length > 0
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
        executionContext: params.executionContext,
        branchId: 'bundle.clean-parent',
        phase: params.phase,
      },
    )
    if (parentCheck.executionRefusal) throw new ExecutionRefusalError(parentCheck.executionRefusal)
    if (parentCheck.exitCode === 0) {
      const committedDiffResult = await runGitBounded(
        ['diff', '--no-color', 'HEAD~1', 'HEAD', '--'],
        params.cwd,
        params.signal,
        {
          timeoutMs: SNAPSHOT_ID_GIT_TIMEOUT_MS,
          maxOutputBytes: MAX_SNAPSHOT_ID_DIFF_BYTES,
          executionContext: params.executionContext,
          branchId: 'bundle.clean-committed-diff',
          phase: params.phase,
        },
      )
      if (committedDiffResult.executionRefusal) throw new ExecutionRefusalError(committedDiffResult.executionRefusal)
      if (
        committedDiffResult.exitCode === 0 ||
        committedDiffResult.exitCode === 1
      ) {
        if (committedDiffResult.stdoutTruncated) {
          throw new Error(
            'Committed diff exceeds identity membership limit; complete review files are unavailable.',
          )
        }
        committedDiff = committedDiffResult.stdout
      }
    }
  }
  const { files, identityStatus } = deriveIdentityFromPorcelain(
    params.identityLines,
    committedDiff === undefined ? undefined : committedDiffFiles(committedDiff),
  )
  // Full raw stdout is hashed incrementally; presentation keeps its cap.
  const fullDiff = await runGitBounded(
    ['diff', '--binary', 'HEAD', '--', '.', ':(exclude).agents/sessions/**'],
    params.cwd,
    params.signal,
    {
      timeoutMs: SNAPSHOT_ID_GIT_TIMEOUT_MS,
      maxOutputBytes: MAX_SNAPSHOT_ID_DIFF_BYTES,
      executionContext: params.executionContext,
      branchId: 'bundle.full-binary-diff',
      phase: params.phase,
    },
  )
  if (fullDiff.executionRefusal) throw new ExecutionRefusalError(fullDiff.executionRefusal)
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
    .update(`status-sha256:${params.statusSha256}\0`)
    .update(`diff-sha256:${fullDiff.stdoutSha256}\0`)
  await hashIdentityFileBytes(hash, params.cwd, files, {
    signal: params.signal,
  })
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
  executionContext?: ExecutionAdapterContext
  phase?: string
}): Promise<{ snapshotId: string } | { errorMessage: string; executionRefusal?: Refusal }> {
  params = { ...params, signal: params.executionContext?.signal ?? params.signal }
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
      executionContext: params.executionContext,
      branchId: 'bundle.snapshot-head',
      phase: params.phase,
    },
  )
  if (head.exitCode !== 0) {
    return {
      errorMessage:
        head.stderr.trim() || 'Unable to attest validation snapshot.',
      ...(head.executionRefusal ? { executionRefusal: head.executionRefusal } : {}),
    }
  }
  const porcelain = await runGitBounded(
    // Session artifacts are excluded before both membership and full hashing.
    [
      'status',
      '--porcelain',
      '-z',
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
      executionContext: params.executionContext,
      branchId: 'bundle.snapshot-porcelain',
      phase: params.phase,
    },
  )
  if (porcelain.exitCode !== 0 || porcelain.stdoutTruncated) {
    return {
      errorMessage: porcelain.stdoutTruncated
        ? 'Git status exceeds identity membership limit; complete review files are unavailable.'
        : porcelain.stderr.trim() ||
          `git status exited with code ${porcelain.exitCode}.`,
      ...(porcelain.executionRefusal ? { executionRefusal: porcelain.executionRefusal } : {}),
    }
  }
  try {
    const identityLines = identityLinesFromPorcelain(porcelain.stdout)
    const identity = await buildSnapshotIdentity({
      cwd: params.cwd,
      headCommit: head.stdout.trim(),
      identityLines,
      statusSha256: porcelain.stdoutSha256,
      workspaceState: params.workspaceState,
      signal: params.signal,
      executionContext: params.executionContext,
      phase: params.phase,
    })
    return { snapshotId: identity.snapshotId }
  } catch (error) {
    return {
      errorMessage: error instanceof Error ? error.message : String(error),
      ...(isExecutionRefusalError(error) ? { executionRefusal: error.refusal } : {}),
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
  executionContext?: ExecutionAdapterContext
  /**
   * Skip the semgrep baseline scan for THIS bundle: targeted validation sets
   * it on the after-bundle because the before-bundle already ran the
   * identical scan for the same worktree. Additive; defaults to false.
   */
  skipSecurityScan?: boolean
}): Promise<CodebuffToolOutput<'get_change_review_bundle'>> {
  params = { ...params }
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
      // Default to the schema's own max (200_000): an 80k default clipped a
      // realistic multi-file review mid-diff, and the orchestrator saw a
      // fragment with no way to tell what was cut. An explicit
      // params.max_chars override is still honored exactly.
      max_chars: params.max_chars ?? 200_000,
      signal: params.signal,
      timeoutMs: SNAPSHOT_ID_GIT_TIMEOUT_MS,
      executionContext: params.executionContext,
      phase: 'bundle',
    }),
    runGitBounded(['rev-parse', 'HEAD'], params.cwd, params.signal, {
      timeoutMs: SNAPSHOT_ID_GIT_TIMEOUT_MS,
      maxOutputBytes: 4096,
      executionContext: params.executionContext,
      branchId: 'bundle.bundle-head',
      phase: 'bundle',
    }),
    resolveWorkspaceIdentity({
      cwd: params.cwd,
      signal: params.signal,
      timeoutMs: SNAPSHOT_ID_GIT_TIMEOUT_MS,
      executionContext: params.executionContext,
      phase: 'bundle',
    }).catch((error: unknown) => {
      if (isExecutionRefusalError(error)) return error
      throw error
    }),
  ])
  if (isExecutionRefusalError(workspace)) {
    return [{ type: 'json', value: { errorMessage: workspace.message, executionRefusal: workspace.refusal } }]
  }
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
          ...(head.executionRefusal ? { executionRefusal: head.executionRefusal } : {}),
          ...(value && 'executionRefusal' in value ? { executionRefusal: value.executionRefusal } : {}),
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
  // full status digest artifact-clean.
  // A4 advisory (identity-git-spawns-no-deadline parity): this porcelain spawn
  // ran with no wall-clock deadline while the identity-only path bounds the
  // same call. Use the identical bounds so a wedged git fails closed instead of
  // hanging the bundle build; a timeout resolves exitCode -1, which the
  // unchanged error mapping below already reports via the exitCode !== 0 branch.
  const porcelain = await runGitBounded(
    // Session artifacts are excluded before both membership and full hashing.
    [
      'status',
      '--porcelain',
      '-z',
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
      executionContext: params.executionContext,
      branchId: 'bundle.bundle-porcelain',
      phase: 'bundle',
    },
  )
  if (porcelain.exitCode !== 0 || porcelain.stdoutTruncated) {
    return [
      {
        type: 'json',
        value: {
          errorMessage: porcelain.stdoutTruncated
            ? 'Git status exceeds identity membership limit; complete review files are unavailable.'
            : porcelain.stderr.trim() ||
              `git status exited with code ${porcelain.exitCode}.`,
          ...(porcelain.executionRefusal ? { executionRefusal: porcelain.executionRefusal } : {}),
        },
      },
    ]
  }
  // Shared identity derivation (also used by the identity-only snapshot path)
  // so the bundle snapshotId and the targeted-validation drift checks can
  // never drift apart. Session plan artifacts under `.agents/sessions/**` are
  // filtered out of both the identity file list and the identity status while
  // the returned `status` below stays the real, unfiltered observation.
  let snapshotId: string
  let files: string[]
  try {
    const identityLines = identityLinesFromPorcelain(porcelain.stdout)
    const identity = await buildSnapshotIdentity({
      cwd: params.cwd,
      headCommit,
      identityLines,
      statusSha256: porcelain.stdoutSha256,
      workspaceState: params.workspaceState,
      signal: params.signal,
      executionContext: params.executionContext,
      phase: 'bundle',
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
          ...(isExecutionRefusalError(error) ? { executionRefusal: error.refusal } : {}),
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
    const findingEvidence = store.listWithDiagnostics(
      workspace.repositoryId,
      'findings',
    )
    if (findingEvidence.diagnostics.length > 0) {
      return [
        {
          type: 'json',
          value: {
            errorMessage: `Finding evidence unavailable: ${findingEvidence.diagnostics.length} corrupt or quarantined finding record(s) require repair.`,
          },
        },
      ]
    }
    findings = findingEvidence.records
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
    executionContext: params.executionContext,
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
