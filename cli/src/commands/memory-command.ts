/**
 * `/memory` — inspect and prune persisted cross-session task memory for the
 * current project root. Read-only by default; `prune` drops stale evidence.
 */
import {
  collectWorkspaceMoves,
  getHarnessStateDir,
  loadPersistedTaskMemory,
  pruneStaleTaskMemoryEvidence,
  reconcileTaskMemoryEvidence,
  WorkspaceJournalService,
} from '@openbuff/sdk'

import { getProjectRoot } from '../project-files'

import type {
  TaskMemoryPruneOutcome,
  WorkspaceMoveRecord,
} from '@openbuff/sdk'

export type MemoryCommandDeps = {
  getRootDir: () => string
  loadPersistedTaskMemory: typeof loadPersistedTaskMemory
  reconcileTaskMemoryEvidence: typeof reconcileTaskMemoryEvidence
  pruneStaleTaskMemoryEvidence: typeof pruneStaleTaskMemoryEvidence
  /**
   * Journal-recorded file moves for this project. Both subcommands reconcile
   * evidence, and reconciliation without moves reports a renamed file's
   * evidence as stale — which `prune` then DELETES.
   */
  getWorkspaceMoves: (rootDir: string) => Promise<WorkspaceMoveRecord[]>
}

/**
 * The same move set run hydration feeds `reconcileTaskMemoryEvidence`, read
 * from the workspace journal so `/memory` applies hydration's documented
 * move-rebinding contract instead of a weaker one. `collectWorkspaceMoves`
 * swallows read failures for a missing journal and bounds the result, but a
 * failure to *create* the journal (IO error, unavailable store) must surface
 * as a command failure rather than a prune run against an unknown move set
 * — otherwise evidence bound to a renamed file reconciles stale and is
 * permanently deleted. Missing journal (no record yet) still yields empty
 * moves via the successful create + empty-read path; only IO/create failures
 * throw.
 */
async function loadWorkspaceMoves(
  rootDir: string,
): Promise<WorkspaceMoveRecord[]> {
  const journal = await WorkspaceJournalService.create({
    rootDir: getHarnessStateDir(),
    cwd: rootDir,
  })
  return collectWorkspaceMoves(journal)
}

const defaultDeps: MemoryCommandDeps = {
  getRootDir: getProjectRoot,
  loadPersistedTaskMemory,
  reconcileTaskMemoryEvidence,
  pruneStaleTaskMemoryEvidence,
  getWorkspaceMoves: loadWorkspaceMoves,
}

const STALE_PATHS_SHOWN = 5
const GOAL_PREVIEW_CHARS = 120

/**
 * User-facing cause for each prune failure the store reports. A failed prune
 * must never be phrased as an absent record or as "nothing to prune": the
 * record still holds its stale entries and the user needs to know why.
 */
const PRUNE_FAILURE_CAUSES: Record<
  Extract<TaskMemoryPruneOutcome, { status: 'failed' }>['reason'],
  string
> = {
  'invalid-record': 'the pruned record failed schema validation',
  'concurrent-write':
    'the record changed while pruning (a run saved task memory); re-run /memory prune',
  'write-failed':
    'the record could not be written (check file permissions and whether the filesystem supports atomic renames)',
}

export async function handleMemoryCommand(
  rawArgs: string,
  deps: MemoryCommandDeps = defaultDeps,
): Promise<string> {
  const trimmed = rawArgs.trim()
  const normalized = (trimmed.split(/\s+/)[0] || 'status').toLowerCase()

  if (normalized === 'prune') {
    return runPrune(deps)
  }
  if (normalized !== 'status') {
    return 'Usage: /memory [status|prune]'
  }
  return runStatus(deps)
}

async function runStatus(deps: MemoryCommandDeps): Promise<string> {
  try {
    const rootDir = deps.getRootDir()
    const memory = await deps.loadPersistedTaskMemory({ rootDir })
    if (!memory) {
      return [
        'No persisted task memory for this project yet.',
        'It is written after your first successful run completes.',
      ].join('\n')
    }

    const reconciled = await deps.reconcileTaskMemoryEvidence({
      memory,
      rootDir,
      // Same move contract as hydration: a renamed file's evidence is
      // rebound to its destination rather than reported stale (and then
      // offered up for pruning).
      workspaceMoves: await deps.getWorkspaceMoves(rootDir),
    })
    const live = reconciled.evidence.filter((item) => !item.stale).length
    const stale = reconciled.evidence.length - live
    const stalePaths = reconciled.evidence
      .filter((item) => item.stale && item.path)
      .slice(0, STALE_PATHS_SHOWN)
      .map((item) => `- ${item.path}`)
    const goal = memory.goal
      ? memory.goal.slice(0, GOAL_PREVIEW_CHARS)
      : '(none recorded)'

    const lines = [
      `Task memory: revision ${memory.revision}, updated ${formatAge(Date.now() - memory.updatedAt)} ago.`,
      `Goal: ${goal}`,
      `Decisions: ${memory.decisions.length} · Requirements: ${memory.requirements.length} · Edits: ${memory.editsMade.length}`,
      `Validations: ${memory.validationResults.length} · Blockers: ${memory.blockers.length} · Next actions: ${memory.nextActions.length}`,
      `Evidence: ${live} fresh, ${stale} stale (of ${reconciled.evidence.length}).`,
    ]
    if (stalePaths.length > 0) {
      lines.push('Stale evidence paths:')
      lines.push(...stalePaths)
    }
    if (stale > 0) {
      lines.push('Run /memory prune to drop stale evidence entries.')
    }
    return lines.join('\n')
  } catch (error) {
    return `Memory status failed: ${error instanceof Error ? error.message : String(error)}`
  }
}

async function runPrune(deps: MemoryCommandDeps): Promise<string> {
  try {
    const rootDir = deps.getRootDir()
    const outcome = await deps.pruneStaleTaskMemoryEvidence({
      rootDir,
      // Prune DELETES what reconciles stale, so the known moves must be
      // supplied here too or a rename permanently loses valid evidence.
      workspaceMoves: await deps.getWorkspaceMoves(rootDir),
    })
    if (outcome.status === 'no-record') {
      return 'No persisted task memory to prune for this project.'
    }
    if (outcome.status === 'failed') {
      return [
        `Memory prune failed: ${PRUNE_FAILURE_CAUSES[outcome.reason]}.`,
        `The record is unchanged: ${outcome.removed} stale evidence ${pluralizeEntries(outcome.removed)} still present (${outcome.remaining} fresh).`,
      ].join('\n')
    }
    if (outcome.removed === 0) {
      return `Nothing to prune: all ${outcome.remaining} evidence entries are fresh.`
    }
    return `Pruned ${outcome.removed} stale evidence ${pluralizeEntries(outcome.removed)}; ${outcome.remaining} remain.`
  } catch (error) {
    return `Memory prune failed: ${error instanceof Error ? error.message : String(error)}`
  }
}

function pluralizeEntries(count: number): string {
  return count === 1 ? 'entry' : 'entries'
}

function formatAge(milliseconds: number): string {
  if (milliseconds < 1_000) return '<1s'
  const seconds = Math.floor(milliseconds / 1_000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ${minutes % 60}m`
  return `${Math.floor(hours / 24)}d ${hours % 24}h`
}
