import { execFile } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

import { getProjectRoot } from '../project-files'
import { getSystemProcessEnv } from './env'

const execFileAsync = promisify(execFile)

/** Git timeout for every plumbing call: snapshots must never hang the TUI. */
const GIT_TIMEOUT_MS = 15_000

/** Maximum number of snapshots returned by the newest-first walk. */
const MAX_LISTED_SNAPSHOTS = 100

/**
 * Private ref namespace: turn snapshots live ONLY here. HEAD, the user's
 * real index, untracked files, .gitignore, and remote refs are never touched.
 */
export const TURN_SNAPSHOT_REF = 'refs/openbuff/turns'

/**
 * Injectable git seam (mirrors DetachAttachDeps in attach-session.ts):
 * production callers pass nothing and the real `git` binary is spawned with
 * array args (never a shell string, so argv-passed labels cannot inject);
 * tests inject a fake runner or a real temp-repo runner.
 */
export type GitRunner = (
  args: string[],
  opts: { cwd: string; env: Record<string, string | undefined> },
) => Promise<{ stdout: string; stderr: string }>

export type TurnSnapshotDeps = {
  runGit?: GitRunner
}

type TurnSnapshotOpts = {
  projectRoot?: string
  label?: string
}

export type TurnSnapshotOutcome =
  | { status: 'created'; sha: string; label: string }
  | { status: 'unavailable' }
  | { status: 'skipped'; reason: string }
  | { status: 'error'; message: string }

export type TurnSnapshotEntry = {
  sha: string
  label: string
  timestamp: number
}

export type UndoOutcome =
  | { status: 'undone'; toSha: string }
  | { status: 'nothing-to-undo' }
  | { status: 'unavailable' }
  | { status: 'error'; message: string }

export type RestoreOutcome =
  | { status: 'restored'; sha: string }
  | { status: 'not-found' }
  | { status: 'unavailable' }
  | { status: 'error'; message: string }

/**
 * Turn snapshots v1 (bounded first slice): git-plumbing snapshots of the
 * TRACKED tree, one per successful turn, chained on the private ref
 * `refs/openbuff/turns`.
 *
 * Scope notes: per-shell-command snapshots are wired for user-invoked
 * commands via runBashCommand (label 'shell'). Bisect-by-turn is implemented
 * via runTurnBisection (binary search over the chain) and exposed as
 * /bisect-turn (`list` shows snapshots, `stop` cancels a running bisection).
 *
 * Safety model:
 * - Only git plumbing is used. The user's real index and HEAD are never
 *   touched: `git add` runs exclusively with GIT_INDEX_FILE pointed at a
 *   private temp file, and writes go through `write-tree` / `commit-tree` /
 *   `update-ref` on the private ref.
 * - Untracked files are never captured nor restored (tracked-tree gate): the
 *   temp index is seeded from HEAD's tree and updated with `git add -u` (not
 *   `-A`, which would stage untracked paths into the snapshot).
 * - Working-tree rolls use a temp index + `git checkout-index -a -f
 *   --prefix=<root>/`, which overwrites tracked files in place and leaves
 *   untracked files, the real index, and HEAD alone.
 *
 * Every function is total: git failures map to structured outcomes and are
 * never thrown, so fire-and-forget callers cannot crash the TUI.
 */

const defaultRunGit: GitRunner = async (args, opts) => {
  return await execFileAsync('git', args, {
    cwd: opts.cwd,
    env: opts.env,
    timeout: GIT_TIMEOUT_MS,
  })
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function resolveProjectRoot(opts?: { projectRoot?: string }): string | undefined {
  if (opts?.projectRoot) {
    return opts.projectRoot
  }
  try {
    return getProjectRoot()
  } catch {
    // No project root configured (e.g. early startup): fail closed.
    return undefined
  }
}

async function runGitCommand(
  deps: TurnSnapshotDeps | undefined,
  args: string[],
  cwd: string,
  env: Record<string, string | undefined>,
): Promise<{ stdout: string; stderr: string }> {
  const runGit = deps?.runGit ?? defaultRunGit
  return await runGit(args, { cwd, env })
}

/** Resolve a ref to a sha, or undefined when it does not resolve. */
async function revParse(
  deps: TurnSnapshotDeps | undefined,
  ref: string,
  cwd: string,
  env: Record<string, string | undefined>,
): Promise<string | undefined> {
  try {
    const { stdout } = await runGitCommand(deps, ['rev-parse', '--verify', ref], cwd, env)
    const sha = stdout.trim()
    return sha.length > 0 ? sha : undefined
  } catch {
    return undefined
  }
}

/**
 * The repo is snapshot-capable only when it is a git repo with at least one
 * commit (a tree/commit rooted in HEAD is required for the tracked-tree gate).
 */
async function isSnapshotCapableRepo(
  deps: TurnSnapshotDeps | undefined,
  cwd: string,
  env: Record<string, string | undefined>,
): Promise<boolean> {
  try {
    await runGitCommand(deps, ['rev-parse', '--git-dir'], cwd, env)
    await runGitCommand(deps, ['rev-parse', '--verify', 'HEAD'], cwd, env)
    return true
  } catch {
    return false
  }
}

/**
 * `checkout-index --prefix` requires a trailing slash so values are always
 * treated as a directory prefix.
 */
function checkoutPrefix(root: string): string {
  return `${root.replace(/[\\/]+$/, '')}/`
}

function makeTempIndexDir(): string {
  return mkdtempSync(path.join(tmpdir(), 'openbuff-turn-snapshot-'))
}

function removeTempIndexDir(tempDir: string | undefined): void {
  if (tempDir) {
    try {
      rmSync(tempDir, { recursive: true, force: true })
    } catch {
      // Best-effort cleanup only; a leftover temp index is harmless.
    }
  }
}

export async function createTurnSnapshot(
  opts?: TurnSnapshotOpts,
  deps?: TurnSnapshotDeps,
): Promise<TurnSnapshotOutcome> {
  const root = resolveProjectRoot(opts)
  if (!root) {
    return { status: 'unavailable' }
  }
  // A running bisection is rewriting the tracked working tree and walking the
  // snapshot chain. A concurrent snapshot would chain onto a temporarily
  // rolled-back probed tree (or the in-flight final restore) instead of the
  // newest state, corrupting the chain the search is walking. Fail closed:
  // snapshots are paused until the bisection finishes.
  if (bisectRunning) {
    return {
      status: 'skipped',
      reason:
        'a turn bisection is in flight; snapshots are paused until it finishes',
    }
  }
  const label = opts?.label ?? 'turn'
  let tempDir: string | undefined
  try {
    const env = { ...getSystemProcessEnv() }
    if (!(await isSnapshotCapableRepo(deps, root, env))) {
      return { status: 'unavailable' }
    }

    // Private temp index: GIT_INDEX_FILE must be absolute so git never falls
    // back to the user's real index.
    tempDir = makeTempIndexDir()
    const indexEnv = {
      ...env,
      GIT_INDEX_FILE: path.join(tempDir, 'index'),
    }

    // Seed the temp index from HEAD's tree, then apply working-tree changes
    // for tracked paths only (`add -u`, never `-A`) so untracked files are
    // not captured by the snapshot.
    await runGitCommand(deps, ['read-tree', 'HEAD'], root, indexEnv)
    await runGitCommand(deps, ['add', '-u'], root, indexEnv)
    const tree = (await runGitCommand(deps, ['write-tree'], root, indexEnv)).stdout.trim()

    // Parent = current tip of the private ref; absent ref => orphan commit.
    const parent = await revParse(deps, TURN_SNAPSHOT_REF, root, env)
    if (parent) {
      const parentTree = await revParse(deps, `${parent}^{tree}`, root, env)
      if (parentTree === tree) {
        return {
          status: 'skipped',
          reason: 'tracked tree is unchanged since the last turn snapshot',
        }
      }
    }

    // Explicit identity so commit-tree works in CI containers without git
    // config. Args are an argv array: the label can never reach a shell.
    const commitArgs = [
      '-c',
      'user.name=openbuff',
      '-c',
      'user.email=openbuff@localhost',
      'commit-tree',
      tree,
      '-m',
      label,
    ]
    if (parent) {
      commitArgs.push('-p', parent)
    }
    const sha = (await runGitCommand(deps, commitArgs, root, env)).stdout.trim()
    await runGitCommand(deps, ['update-ref', TURN_SNAPSHOT_REF, sha], root, env)

    return { status: 'created', sha, label }
  } catch (error) {
    return { status: 'error', message: toErrorMessage(error) }
  } finally {
    removeTempIndexDir(tempDir)
  }
}

export async function listTurnSnapshots(
  opts?: { projectRoot?: string },
  deps?: TurnSnapshotDeps,
): Promise<TurnSnapshotEntry[]> {
  const root = resolveProjectRoot(opts)
  if (!root) {
    return []
  }
  try {
    const env = { ...getSystemProcessEnv() }
    if (!(await isSnapshotCapableRepo(deps, root, env))) {
      return []
    }
    if (!(await revParse(deps, TURN_SNAPSHOT_REF, root, env))) {
      return []
    }
    // Reading never touches the user's index, so a plain `git log` is fine.
    const { stdout } = await runGitCommand(
      deps,
      ['log', `--max-count=${MAX_LISTED_SNAPSHOTS}`, '--format=%H %ct %s', TURN_SNAPSHOT_REF],
      root,
      env,
    )
    return stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => {
        const [sha, timestamp, ...labelParts] = line.split(' ')
        return {
          sha,
          timestamp: Number.parseInt(timestamp, 10),
          label: labelParts.join(' '),
        }
      })
  } catch {
    return []
  }
}

/**
 * Shared mechanics for undo/restore: materialize a snapshot commit's tree
 * into the tracked working tree via a private temp index, never touching the
 * real index, HEAD, or untracked files.
 */
async function checkoutSnapshotTree(
  deps: TurnSnapshotDeps | undefined,
  commitSha: string,
  root: string,
): Promise<void> {
  const tempDir = makeTempIndexDir()
  try {
    const indexEnv = {
      ...getSystemProcessEnv(),
      GIT_INDEX_FILE: path.join(tempDir, 'index'),
    }
    await runGitCommand(deps, ['read-tree', `${commitSha}^{tree}`], root, indexEnv)
    await runGitCommand(
      deps,
      ['checkout-index', '-a', '-f', `--prefix=${checkoutPrefix(root)}`],
      root,
      indexEnv,
    )
  } finally {
    removeTempIndexDir(tempDir)
  }
}

export async function undoLastTurn(
  opts?: { projectRoot?: string },
  deps?: TurnSnapshotDeps,
): Promise<UndoOutcome> {
  const root = resolveProjectRoot(opts)
  if (!root) {
    return { status: 'unavailable' }
  }
  try {
    const env = { ...getSystemProcessEnv() }
    if (!(await isSnapshotCapableRepo(deps, root, env))) {
      return { status: 'unavailable' }
    }
    const tip = await revParse(deps, TURN_SNAPSHOT_REF, root, env)
    if (!tip) {
      return { status: 'nothing-to-undo' }
    }
    // Undo steps back one snapshot: target is the parent of the newest one.
    // Newer snapshots are kept (the ref is not moved).
    const parent = await revParse(deps, `${tip}^`, root, env)
    if (!parent) {
      return { status: 'nothing-to-undo' }
    }
    await checkoutSnapshotTree(deps, parent, root)
    return { status: 'undone', toSha: parent }
  } catch (error) {
    return { status: 'error', message: toErrorMessage(error) }
  }
}

export async function restoreToTurn(
  sha: string,
  opts?: { projectRoot?: string },
  deps?: TurnSnapshotDeps,
): Promise<RestoreOutcome> {
  const root = resolveProjectRoot(opts)
  if (!root) {
    return { status: 'unavailable' }
  }
  // Only hex shas are accepted: this both rejects typos early and prevents
  // user input from being parsed as git options (argv is otherwise injected
  // verbatim into `rev-parse --verify`).
  if (!/^[0-9a-fA-F]{4,40}$/.test(sha)) {
    return { status: 'not-found' }
  }
  try {
    const env = { ...getSystemProcessEnv() }
    if (!(await isSnapshotCapableRepo(deps, root, env))) {
      return { status: 'unavailable' }
    }
    const resolved = await revParse(deps, `${sha}^{commit}`, root, env)
    if (!resolved) {
      return { status: 'not-found' }
    }
    await checkoutSnapshotTree(deps, resolved, root)
    return { status: 'restored', sha: resolved }
  } catch (error) {
    return { status: 'error', message: toErrorMessage(error) }
  }
}

/**
 * Turn bisection (P2-T4): binary-search the snapshot chain to find the FIRST
 * turn whose tracked tree breaks a test command.
 *
 * - `bisectTurnsPure` is the pure search core (no git, no subprocess): it
 *   probes at most 1 + ceil(log2(n)) indices and assumes the OLDEST snapshot
 *   passes (a failing oldest snapshot is reported as an inconclusive
 *   baseline instead of a bogus "first failing turn").
 * - `runTurnBisection` materializes each probed snapshot with the SAME
 *   private mechanics as /restore (temp GIT_INDEX_FILE + checkout-index), so
 *   HEAD, the user's real index, and untracked files are never touched, and
 *   always restores the NEWEST snapshot's tree when the run ends (cancel,
 *   failure, or success). Leaving the tree at the last known-good snapshot
 *   is opt-in via `keepBestState`.
 * - The test command runs through argv arrays only (never a shell), with a
 *   10-minute bound per probe; a non-zero exit or timeout counts as "suite
 *   failed at this turn". A command that cannot even start (ENOENT,
 *   permission denied) is a command-level error instead of a failing probe.
 * - An in-flight guard rejects a second concurrent run: only one bisection
 *   may rewrite the tracked working tree at a time, so the ALWAYS-restores
 *   contract above cannot be broken by interleaved checkouts.
 */

let bisectCancelled = false

/**
 * In-flight guard: only one bisection may rewrite the tracked working tree
 * at a time. Concurrent runs (or a bisection overlapping an agent turn)
 * would interleave checkoutSnapshotTree rewrites and break the
 * "ALWAYS restores the newest snapshot's tree when the run ends" contract.
 */
let bisectRunning = false

/** Whether a turn bisection is currently rewriting the tracked working tree. */
export function isTurnBisectionRunning(): boolean {
  return bisectRunning
}

/** Request cancellation of a running turn bisection (/bisect-turn stop). */
export function cancelTurnBisection(): void {
  bisectCancelled = true
}

class BisectCancelledError extends Error {}

/**
 * The test command itself could not run (ENOENT, permission denied, empty
 * argv). Distinct from "the suite failed at this snapshot": a mistyped
 * command must never be reported as a failing baseline.
 */
class BisectCommandError extends Error {}

export type BisectProgress = {
  phase: 'start' | 'probe'
  index?: number
  count?: number
  sha?: string
  label?: string
}

export type BisectOutcome =
  | {
      status: 'found'
      failingSha: string
      failingLabel: string
      probesRun: number
      bestSha?: string
    }
  | {
      status: 'inconclusive'
      reason: 'baseline-fails' | 'no-failure-reproduced'
      probesRun: number
    }
  | { status: 'no-snapshots' }
  | { status: 'too-few-snapshots'; count: number }
  | { status: 'cancelled' }
  | { status: 'unavailable' }
  | { status: 'error'; message: string }

/**
 * Pure bisection core over `count` snapshots ordered oldest (index 0) to
 * newest (index count-1). `probeFn` returns true when the suite FAILS at the
 * probed index. Returns the smallest failing index, or null when nothing
 * fails; a failing index 0 breaks the "oldest passes" invariant and is
 * reported via `baselineFailed` without searching. Each index is probed at
 * most once and at most 1 + ceil(log2(count)) probes run.
 */
export async function bisectTurnsPure(
  count: number,
  probeFn: (index: number) => Promise<boolean>,
): Promise<{
  firstFailingIndex: number | null
  probesRun: number
  baselineFailed: boolean
}> {
  if (count <= 0) {
    return { firstFailingIndex: null, probesRun: 0, baselineFailed: false }
  }
  let probesRun = 0
  const probe = async (index: number): Promise<boolean> => {
    probesRun += 1
    return await probeFn(index)
  }
  if (await probe(0)) {
    return { firstFailingIndex: null, probesRun, baselineFailed: true }
  }
  let lo = 1
  let hi = count - 1
  let firstFailingIndex: number | null = null
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2)
    if (await probe(mid)) {
      firstFailingIndex = mid
      hi = mid - 1
    } else {
      lo = mid + 1
    }
  }
  return { firstFailingIndex, probesRun, baselineFailed: false }
}

/**
 * Split a user test command into argv WITHOUT any shell: whitespace splits
 * tokens outside single/double quotes, and quoted sections keep their inner
 * whitespace. The output is only ever passed to execFile as an argv array,
 * so user input can never inject into a shell.
 */
function splitCommandArgv(command: string): string[] {
  const argv: string[] = []
  let current = ''
  let quote: string | null = null
  for (const ch of command) {
    if (quote !== null) {
      if (ch === quote) {
        quote = null
      } else {
        current += ch
      }
    } else if (ch === "'" || ch === '"') {
      quote = ch
    } else if (/\s/.test(ch)) {
      if (current.length > 0) {
        argv.push(current)
        current = ''
      }
    } else {
      current += ch
    }
  }
  if (current.length > 0) {
    argv.push(current)
  }
  return argv
}

/** Per-probe bound: a hung suite must never stall the bisection forever. */
const BISECT_PROBE_TIMEOUT_MS = 10 * 60 * 1000

/**
 * Default probe runner: execute the test command once from the project root
 * and resolve true only when it FAILS (non-zero exit or timeout). A
 * command-level failure - the process never started (ENOENT, EACCES, ...) or
 * the command is empty - throws BisectCommandError instead, so a mistyped
 * command is reported as an error, never as "the suite fails at the OLDEST
 * snapshot".
 */
async function defaultRunTestSuite(
  command: string,
  root: string,
): Promise<boolean> {
  const argv = splitCommandArgv(command)
  if (argv.length === 0) {
    throw new BisectCommandError('the test command is empty')
  }
  try {
    await execFileAsync(argv[0]!, argv.slice(1), {
      cwd: root,
      env: getSystemProcessEnv(),
      timeout: BISECT_PROBE_TIMEOUT_MS,
    })
    return false
  } catch (error) {
    const err = error as (Error & { code?: unknown; killed?: boolean }) | null
    // execFile sets a NUMERIC exit code when the process ran and exited
    // non-zero; a string code means the process never started (ENOENT,
    // EACCES, ...). Timeouts (ETIMEDOUT / killed) still count as probe
    // failures per the documented contract.
    if (
      err !== null &&
      typeof err.code === 'string' &&
      err.code !== 'ETIMEDOUT' &&
      err.killed !== true
    ) {
      throw new BisectCommandError(
        `test command '${argv[0]}' could not be run: ${err.code}`,
      )
    }
    return true
  }
}

export async function runTurnBisection(
  opts?: {
    projectRoot?: string
    command?: string
    keepBestState?: boolean
    onProgress?: (progress: BisectProgress) => void
  },
  deps?: TurnSnapshotDeps & {
    runTestSuite?: (
      entry: TurnSnapshotEntry,
      next: TurnSnapshotEntry | undefined,
    ) => Promise<boolean>
  },
): Promise<BisectOutcome> {
  // Fail closed against concurrent runs: two bisections would interleave
  // checkoutSnapshotTree rewrites of the same tracked working tree and
  // clobber each other's probes. Checked and set in the same synchronous
  // slice, so the guard is race-free within a process.
  if (bisectRunning) {
    return {
      status: 'error',
      message:
        'a turn bisection is already in flight - wait for it to finish or cancel it with /bisect-turn stop before starting another.',
    }
  }
  // A previous cancelled run must never poison the next one.
  bisectCancelled = false
  const root = resolveProjectRoot(opts)
  if (!root) {
    return { status: 'unavailable' }
  }
  const command = opts?.command ?? 'bun test'
  const runSuite =
    deps?.runTestSuite ??
    (async (
      entry: TurnSnapshotEntry,
      next: TurnSnapshotEntry | undefined,
    ) => await defaultRunTestSuite(command, root))
  const safeProgress = (progress: BisectProgress): void => {
    try {
      opts?.onProgress?.(progress)
    } catch {
      // A throwing progress callback must never break the bisection.
    }
  }
  bisectRunning = true
  try {
    const newestFirst = await listTurnSnapshots(opts, deps)
    if (newestFirst.length === 0) {
      return { status: 'no-snapshots' }
    }
    if (newestFirst.length < 3) {
      // A before/after pair plus the failing candidate is the minimum needed
      // to localize anything; 2 snapshots cannot.
      return { status: 'too-few-snapshots', count: newestFirst.length }
    }
    // Oldest → newest probe order (listTurnSnapshots is newest-first).
    const entries = [...newestFirst].reverse()
    safeProgress({ phase: 'start', count: entries.length })

    const probeFn = async (index: number): Promise<boolean> => {
      if (bisectCancelled) {
        throw new BisectCancelledError()
      }
      const entry = entries[index]!
      safeProgress({
        phase: 'probe',
        index,
        sha: entry.sha,
        label: entry.label,
      })
      // Same private mechanics as /restore: HEAD, the user's real index, and
      // untracked files are never touched.
      await checkoutSnapshotTree(deps, entry.sha, root)
      const failed = await runSuite(entry, entries[index + 1])
      if (bisectCancelled) {
        throw new BisectCancelledError()
      }
      return failed
    }

    const result = await bisectTurnsPure(entries.length, probeFn)

    // Mandatory cleanup: the tracked working tree goes back to the newest
    // snapshot's state (the pre-bisect view) no matter how the search ended.
    try {
      await checkoutSnapshotTree(deps, entries[entries.length - 1]!.sha, root)
    } catch (error) {
      return {
        status: 'error',
        message: `bisection finished but restoring the newest tracked state failed: ${toErrorMessage(error)}`,
      }
    }
    if (result.baselineFailed) {
      return {
        status: 'inconclusive',
        reason: 'baseline-fails',
        probesRun: result.probesRun,
      }
    }
    if (result.firstFailingIndex === null) {
      return {
        status: 'inconclusive',
        reason: 'no-failure-reproduced',
        probesRun: result.probesRun,
      }
    }
    const failing = entries[result.firstFailingIndex]!
    const bestSha =
      result.firstFailingIndex > 0
        ? entries[result.firstFailingIndex - 1]!.sha
        : undefined
    // Opt-in: leave the tracked tree at the last known-good snapshot.
    if (opts?.keepBestState === true && bestSha !== undefined) {
      try {
        await checkoutSnapshotTree(deps, bestSha, root)
      } catch (error) {
        return {
          status: 'error',
          message: `found the failing turn but restoring the best state failed: ${toErrorMessage(error)}`,
        }
      }
    }
    return {
      status: 'found',
      failingSha: failing.sha,
      failingLabel: failing.label,
      probesRun: result.probesRun,
      bestSha,
    }
  } catch (error) {
    if (error instanceof BisectCancelledError) {
      // Best-effort restore of the newest tree so a cancelled run never
      // leaves the working tree at a probed snapshot.
      try {
        const listed = await listTurnSnapshots(opts, deps)
        if (listed.length > 0) {
          await checkoutSnapshotTree(deps, listed[0]!.sha, root)
        }
      } catch {
        // The cancelled outcome is still reported even if this fails.
      }
      return { status: 'cancelled' }
    }
    // A thrown probe failure (e.g. a mistyped test command) must still
    // restore the newest snapshot's tree before the error is reported.
    try {
      const listed = await listTurnSnapshots(opts, deps)
      if (listed.length > 0) {
        await checkoutSnapshotTree(deps, listed[0]!.sha, root)
      }
    } catch {
      // The error outcome is still reported even if this restore fails.
    }
    return { status: 'error', message: toErrorMessage(error) }
  } finally {
    bisectRunning = false
  }
}
