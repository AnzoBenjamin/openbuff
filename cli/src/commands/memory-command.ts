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
import { formatAge, pluralizeEntries } from '../utils/format-helpers'

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

export const STALE_PATHS_SHOWN = 5
export const GOAL_PREVIEW_CHARS = 120

/**
 * User-facing cause for each prune failure the store reports. A failed prune
 * must never be phrased as an absent record or as "nothing to prune": the
 * record still holds its stale entries and the user needs to know why.
 */
export const PRUNE_FAILURE_CAUSES: Record<
  Extract<TaskMemoryPruneOutcome, { status: 'failed' }>['reason'],
  string
> = {
  'invalid-record': 'the pruned record failed schema validation',
  'concurrent-write':
    'the record changed while pruning (a run saved task memory); re-run /memory prune',
  'write-failed':
    'the record could not be written (check file permissions and whether the filesystem supports atomic renames)',
}

// ---------------------------------------------------------------------------
// Shared helpers — journal logic is centralized here so string and block
// paths do not duplicate WorkspaceJournalService.create → collectWorkspaceMoves.
// ---------------------------------------------------------------------------

async function getStatusContext(deps: MemoryCommandDeps) {
  const rootDir = deps.getRootDir()
  const memory = await deps.loadPersistedTaskMemory({ rootDir })
  if (!memory) return null
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
    .map((item) => item.path as string)
    .slice(0, STALE_PATHS_SHOWN)
  const rawGoal = typeof memory.goal === 'string' ? memory.goal : null
  const hasGoal = !!rawGoal && rawGoal.length > 0
  const goal = hasGoal ? rawGoal : null
  const isGoalTruncated = hasGoal ? rawGoal!.length > GOAL_PREVIEW_CHARS : false
  const goalPreview = hasGoal
    ? rawGoal!.slice(0, GOAL_PREVIEW_CHARS)
    : '(none recorded)'
  return {
    memory,
    reconciled,
    live,
    stale,
    stalePaths,
    totalStaleCount: stale,
    goal,
    goalPreview,
    isGoalTruncated,
  }
}

async function getPruneOutcome(deps: MemoryCommandDeps) {
  const rootDir = deps.getRootDir()
  return deps.pruneStaleTaskMemoryEvidence({
    rootDir,
    // Prune DELETES what reconciles stale, so the known moves must be
    // supplied here too or a rename permanently loses valid evidence.
    workspaceMoves: await deps.getWorkspaceMoves(rootDir),
  })
}

function memoryBlockToString(block: import('../types/chat').MemoryContentBlock): string {
  switch (block.state) {
    case 'empty':
      return [
        'No persisted task memory for this project yet.',
        'It is written after your first successful run completes.',
      ].join('\n')
    case 'status': {
      const lines = [
        `Task memory: revision ${block.revision}, updated ${formatAge(Math.max(0, Date.now() - block.updatedAt))} ago.`,
        `Goal: ${block.goalPreview}`,
        `Decisions: ${block.counts.decisions} · Requirements: ${block.counts.requirements} · Edits: ${block.counts.editsMade}`,
        `Validations: ${block.counts.validationResults} · Blockers: ${block.counts.blockers} · Next actions: ${block.counts.nextActions}`,
        `Evidence: ${block.evidence.fresh} fresh, ${block.evidence.stale} stale (of ${block.evidence.total}).`,
      ]
      if (block.stalePaths.length > 0) {
        lines.push('Stale evidence paths:')
        for (const p of block.stalePaths) lines.push(`- ${p}`)
      }
      if (block.evidence.stale > 0) {
        lines.push('Run /memory prune to drop stale evidence entries.')
      }
      return lines.join('\n')
    }
    case 'pruned':
      return `Pruned ${block.removed} stale evidence ${pluralizeEntries(block.removed)}; ${block.remaining} remain.`
    case 'nothing-to-prune':
      return `Nothing to prune: all ${block.remaining} evidence entries are fresh.`
    case 'no-record':
      return 'No persisted task memory to prune for this project.'
    case 'failed':
      return [
        `Memory prune failed: ${block.cause}.`,
        `The record is unchanged: ${block.removed} stale evidence ${pluralizeEntries(block.removed)} still present (${block.remaining} fresh).`,
      ].join('\n')
    case 'error':
      return block.message
    default: {
      const unknownState = (block as { state?: string }).state ?? 'unknown'
      return `Memory status: unknown state "${unknownState}"`
    }
  }
}

export async function handleMemoryCommandBlocks(
  rawArgs: string,
  deps: MemoryCommandDeps = defaultDeps,
): Promise<import('../types/chat').MemoryContentBlock> {
  const trimmed = rawArgs.trim()
  const normalized = (trimmed.split(/\s+/)[0] || 'status').toLowerCase()
  if (normalized === 'prune') {
    return runPruneBlock(deps)
  }
  if (normalized !== 'status') {
    return {
      type: 'memory',
      state: 'error',
      message: 'Usage: /memory [status|prune]',
    }
  }
  return runStatusBlock(deps)
}

export async function buildMemoryContentBlock(
  rawArgs: string,
  deps: MemoryCommandDeps = defaultDeps,
): Promise<import('../types/chat').MemoryContentBlock> {
  return handleMemoryCommandBlocks(rawArgs, deps)
}

async function runStatusBlock(
  deps: MemoryCommandDeps,
): Promise<import('../types/chat').MemoryContentBlock> {
  try {
    const context = await getStatusContext(deps)
    if (!context) {
      return { type: 'memory', state: 'empty' }
    }
    return {
      type: 'memory',
      state: 'status',
      revision: context.memory.revision,
      updatedAt: context.memory.updatedAt,
      goal: context.goal,
      goalPreview: context.goalPreview,
      isGoalTruncated: context.isGoalTruncated,
      counts: {
        decisions: context.memory.decisions.length,
        requirements: context.memory.requirements.length,
        editsMade: context.memory.editsMade.length,
        validationResults: context.memory.validationResults.length,
        blockers: context.memory.blockers.length,
        nextActions: context.memory.nextActions.length,
      },
      evidence: {
        fresh: context.live,
        stale: context.stale,
        total: context.reconciled.evidence.length,
      },
      stalePaths: context.stalePaths,
      totalStaleCount: context.totalStaleCount,
    }
  } catch (error) {
    return {
      type: 'memory',
      state: 'error',
      message: `Memory status failed: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
}

async function runPruneBlock(
  deps: MemoryCommandDeps,
): Promise<import('../types/chat').MemoryContentBlock> {
  try {
    const outcome = await getPruneOutcome(deps)
    if (outcome.status === 'no-record') {
      return { type: 'memory', state: 'no-record' }
    }
    if (outcome.status === 'failed') {
      return {
        type: 'memory',
        state: 'failed',
        reason: outcome.reason,
        cause: PRUNE_FAILURE_CAUSES[outcome.reason],
        removed: outcome.removed,
        remaining: outcome.remaining,
      }
    }
    if (outcome.removed === 0) {
      return {
        type: 'memory',
        state: 'nothing-to-prune',
        remaining: outcome.remaining,
      }
    }
    return {
      type: 'memory',
      state: 'pruned',
      removed: outcome.removed,
      remaining: outcome.remaining,
    }
  } catch (error) {
    return {
      type: 'memory',
      state: 'error',
      message: `Memory prune failed: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
}

export async function handleMemoryCommand(
  rawArgs: string,
  deps: MemoryCommandDeps = defaultDeps,
): Promise<string> {
  // Preserve string API for tests by delegating to the block API and
  // converting back to the legacy plain-text format — no duplicated journal logic.
  const block = await handleMemoryCommandBlocks(rawArgs, deps)
  return memoryBlockToString(block)
}

export { formatAge, pluralizeEntries }
