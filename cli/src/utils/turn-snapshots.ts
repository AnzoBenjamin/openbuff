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
 * Scope notes (NOT in this slice, per plan): snapshotting per shell command
 * and bisecting failures by turn are left for a later slice.
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
