/**
 * `/memory` — inspect and prune persisted cross-session task memory for the
 * current project root. Read-only by default; `prune` drops stale evidence.
 */
import { createHash } from 'node:crypto'

import {
  collectWorkspaceMoves,
  getHarnessStateDir,
  loadPersistedTaskMemory,
  pruneStaleTaskMemoryEvidence,
  reconcileTaskMemoryEvidence,
  MemoryEventEnvelopeSchema,
  MemoryExportManifestV2Schema,
  MemorySessionIdSchema,
  V1MigrationPayloadSchema,
  QueryIdSchema,
  WorkspaceJournalService,
} from '@openbuff/sdk'

import { getProjectRoot } from '../project-files'
import {
  ContainedFileIoError,
  createContainedProjectDirectory,
  readContainedProjectFile,
} from '../services/memory-v2/contained-file-io'
import { getProjectMemoryV2Provider } from '../services/memory-v2/provider'
import { formatAge, pluralizeEntries } from '../utils/format-helpers'

import type { TaskMemoryPruneOutcome, WorkspaceMoveRecord } from '@openbuff/sdk'

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
  getMemoryV2?: typeof getProjectMemoryV2Provider
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
  getMemoryV2: getProjectMemoryV2Provider,
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

function memoryBlockToString(
  block: import('../types/chat').MemoryContentBlock,
): string {
  switch (block.state) {
    case 'report':
      return block.lines.join('\n')
    case 'empty':
      return [
        'No persisted task memory for this project yet.',
        'It is written after your first successful run completes.',
        ...(block.v2Lines ?? []),
      ].join('\n')
    case 'status': {
      const lines = [
        `Task memory: revision ${block.revision}, updated ${formatAge(Math.max(0, Date.now() - block.updatedAt))} ago.`,
        `Goal: ${block.goalPreview}`,
        `Decisions: ${block.counts.decisions} · Requirements: ${block.counts.requirements} · Edits: ${block.counts.editsMade}`,
        `Validations: ${block.counts.validationResults} · Blockers: ${block.counts.blockers} · Next actions: ${block.counts.nextActions}`,
        `Evidence: ${block.evidence.fresh} fresh, ${block.evidence.stale} stale (of ${block.evidence.total}).`,
        ...(block.v2Lines ?? []),
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

const MEMORY_USAGE = 'Usage: /memory [status|authority|diagnose|query <text>|inspect [eventId]|consolidate [--apply] [--task <id>]|repair [--apply]|revalidate <observationId> <path> [--apply]|correct <observationId> <replacement-summary> [--apply]|forget <observationId...> [--apply]|pin <observationId> [--apply]|export [--format json|markdown] [--include-stale]|import <project-relative-json-path> [--apply]|prune]'
const CLI_SESSION_ID = 'memory-cli'
const EXPORT_MAX_BYTES = 8 * 1024 * 1024

function report(title: string, lines: string[], tone: import('../types/chat').MemoryReportTone = 'secondary', insertCommands?: Array<{ label: string; command: string }>): import('../types/chat').MemoryContentBlock {
  return { type: 'memory', state: 'report', title, tone, lines: lines.slice(0, 100), ...(insertCommands?.length ? { insertCommands } : {}) }
}

function commandError(message: string): import('../types/chat').MemoryContentBlock {
  return report('Memory V2', [message.slice(0, 1_024)], 'error')
}

function safeOperationMessage(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) return 'The operation could not be completed.'
  const allowed = [
    'Canonical inventory is temporarily unavailable.',
    'Canonical inventory failed validation.',
    'Memory V2 storage is unavailable; continuing with V1 memory.',
    'Memory V2 storage is unavailable; V1 remains disabled under opt-in authority.',
    'Memory V2 was reset while opening; continuing with V1 memory.',
    'Memory V2 was reset while opening; V1 remains disabled under opt-in authority.',
    'V1 JSON memory is authoritative; SQLite was not opened.',
    'Invalid memory authority; using V1 memory only.',
  ]
  return allowed.includes(value) ? value : 'The operation could not be completed safely.'
}

function operationLines(outcome: { outcome: string; error?: { message?: unknown; retryable?: unknown } }, extra: string[] = []): string[] {
  return [
    `Outcome: ${outcome.outcome}.`,
    ...extra,
    ...(outcome.error ? [
      `Error: ${safeOperationMessage(outcome.error.message)}`,
      `Retryable: ${outcome.error.retryable === true ? 'yes' : 'no'}.`,
    ] : []),
  ]
}

function isFailureOutcome(outcome: { outcome: string }): boolean {
  return ['failed', 'rejected', 'busy', 'integrity-mismatch'].includes(outcome.outcome)
}

function deterministicId(prefix: string, value: string): string {
  return `${prefix}:${createHash('sha256').update(value).digest('hex').slice(0, 24)}`
}

async function getV2(deps: MemoryCommandDeps) {
  return deps.getMemoryV2
    ? deps.getMemoryV2(deps.getRootDir())
    : {
        status: 'unavailable' as const,
        requestedAuthority: 'shadow-v2',
        effectiveAuthority: 'json-v1' as const,
        degradation: 'Memory V2 is unavailable; continuing with V1 memory.',
        retryable: false,
      }
}

function parseArgs(rawArgs: string): { command: string; args: string[]; apply: boolean } {
  const tokens = rawArgs.trim().split(/\s+/).filter(Boolean)
  const command = (tokens.shift() ?? 'status').toLowerCase()
  const apply = tokens.includes('--apply')
  return { command, args: tokens.filter((token) => token !== '--apply'), apply }
}

async function runV2Command(rawArgs: string, deps: MemoryCommandDeps): Promise<import('../types/chat').MemoryContentBlock> {
  const parsed = parseArgs(rawArgs)
  if (!['authority', 'diagnose', 'query', 'inspect', 'consolidate', 'repair', 'revalidate', 'correct', 'forget', 'pin', 'export', 'import'].includes(parsed.command)) return commandError(MEMORY_USAGE)
  const v2 = await getV2(deps)
  try {
    if (parsed.command === 'authority') {
    return report('Memory authority', [
      'Valid values: json-v1, shadow-v2, sqlite-v2-opt-in.',
      `Requested: ${v2.requestedAuthority}; effective: ${v2.effectiveAuthority}.`,
      'Switch via OPENBUFF_MEMORY_AUTHORITY or the SDK authority option, then reset/restart the client.',
    ])
  }
  if (v2.status === 'unavailable') return report('Memory V2 unavailable', [
    `Requested authority: ${v2.requestedAuthority}; active authority: ${v2.effectiveAuthority}.`,
    safeOperationMessage(v2.degradation),
  ], 'warning')
  const scope = { schemaVersion: 2 as const, projectId: v2.projectId, sessionId: MemorySessionIdSchema.parse(CLI_SESSION_ID) }
  const now = new Date().toISOString()

  if (parsed.command === 'diagnose') {
    const [health, kernel, capabilities, inventory] = await Promise.all([
      v2.repository.health({ schemaVersion: 2, projectId: v2.projectId }),
      v2.repository.kernelHealth(),
      v2.repository.getCapabilities(),
      canonicalInventory(v2, 1_000),
    ])
    const events = inventory.events
    return report('Memory V2 diagnosis', [
      `Requested authority: ${v2.requestedAuthority}; active authority: ${v2.effectiveAuthority}.`,
      'V1 compatibility shadow: available when task-memory.json is hydrated and remains normally persisted.',
      `Health: ${health.status}; repository authority: ${health.authority.kind}.`,
      `Backend: ${health.backend.backendId}; capabilities: ${health.backend.capabilities.join(', ')}.`,
      `Kernel: ${kernel.status}; schema: ${kernel.schemaVersion ?? 'unknown'}; projection cursor: ${kernel.projectionCursor ?? 'unknown'}.`,
      `Integrity: ${health.issues.length ? health.issues.map(safeOperationMessage).join('; ') : 'ok'}.`,
      `Events inspected: ${inventory.error ? 'unavailable' : events.length}.`,
      !inventory.error
        ? (() => {
            const marker = [...events].reverse().find((event) => event.eventType === 'migration.v1.imported')
            const payload = marker ? V1MigrationPayloadSchema.safeParse(marker.payload) : undefined
            return payload?.success
              ? `Last V1 import: revision ${payload.data.sourceRevision ?? 'unknown'}; checksum ${payload.data.sourceChecksum?.slice(0, 24) ?? 'unknown'}; identity ${payload.data.legacyRecordKey.slice(0, 64)}.`
              : 'Last V1 import: unavailable.'
          })()
        : 'Last V1 import: unavailable.',
      'Last parity: unavailable in this command session.',
      capabilities.status === 'ok' ? `Kernel capabilities: ${capabilities.capabilities.filter(({ available }) => available).map(({ name }) => name).join(', ')}.` : 'Kernel capabilities unavailable.',
      health.status === 'healthy' ? 'Recovery guidance: none required.' : 'Recovery guidance: run /memory repair for a non-destructive projection preview.',
    ], health.status === 'healthy' ? 'success' : 'warning')
  }

  if (parsed.command === 'query') {
    const text = parsed.args.join(' ').trim()
    if (!text) return commandError(MEMORY_USAGE)
    const outcome = await v2.repository.query({ ...scope, queryId: QueryIdSchema.parse(deterministicId('query', text)), query: text, selectors: [], artifactKinds: [], includeHistorical: false, maxResultsPerCategory: 10 })
    if (outcome.outcome !== 'result') return commandError(`Memory query failed: ${safeOperationMessage(outcome.error.message)} Retryable: ${outcome.error.retryable ? 'yes' : 'no'}.`)
    const result = outcome.result
    const lines = [
      `Tasks: ${result.matchedTasks.length}; verified: ${result.verifiedKnowledge.length}; discoveries: ${result.reusableDiscovery.length}; reread: ${result.rereadRequired.length}; historical: ${result.historicalContext.length}.`,
      ...result.matchedTasks.map((item) => `Task ${item.taskId} [${item.score.toFixed(2)}]: ${item.title}.`),
      ...result.verifiedKnowledge.map((item) => `Verified ${item.observation.observationId} [${item.score.toFixed(2)}]: ${item.observation.summary}. Reasons: ${item.reasons.map(({ code }) => code).join(', ')}.`),
      ...result.reusableDiscovery.map((item) => `Discovery ${item.observation.observationId} [${item.score.toFixed(2)}]: ${item.observation.summary}.`),
      ...result.rereadRequired.map((item) => `Reread ${item.observationId}: ${'path' in item.selector ? item.selector.path : item.selector.uri} (${item.reason}).`),
      `Degradation: ${result.degradation.state === 'none' ? 'none' : result.degradation.reasons.map(({ detail }) => detail).join('; ')}.`,
    ]
    return report('Memory V2 query', lines, result.rereadRequired.length ? 'warning' : 'success')
  }

  if (parsed.command === 'inspect') {
    const inventory = await canonicalInventory(v2, parsed.args[0] ? 10_000 : 100)
    if (inventory.error) return commandError(`Memory inspect failed: ${safeOperationMessage(inventory.error.message)}`)
    const selected = parsed.args[0] ? inventory.events.filter(({ eventId }) => eventId === parsed.args[0]) : inventory.events
    if (parsed.args[0] && selected.length === 0) return commandError('The requested canonical event was not found in the bounded inventory.')
    return report('Memory V2 canonical events', selected.slice(0, 100).map((event) => `#${event.sequence} ${event.eventId} · ${event.eventType} · ${event.occurredAt}`))
  }

  if (parsed.command === 'consolidate') {
    const taskIndex = parsed.args.indexOf('--task')
    const taskId = taskIndex >= 0 ? parsed.args[taskIndex + 1] : undefined
    if (taskIndex >= 0 && !taskId) return commandError(MEMORY_USAGE)
    const outcome = await v2.operator.consolidate({ ...scope, ...(taskId ? { taskId } : {}), policyVersion: 'cli-v1', mode: parsed.apply ? 'apply' : 'preview', occurredAt: now, maxGroups: 5 })
    const lines = operationLines(outcome, ['Canonical events are append-only; consolidation does not delete source events.'])
    const command = `/memory consolidate${taskId ? ` --task ${taskId}` : ''} --apply`
    return report('Memory V2 consolidation', lines, isFailureOutcome(outcome) ? 'error' : 'secondary', parsed.apply ? undefined : [{ label: 'Insert apply command', command }])
  }

  if (parsed.command === 'repair') {
    if (parsed.args.includes('--reset-corrupt')) return commandError('Destructive reset-corrupt is not supported in this release.')
    const outcome = await v2.operator.repair({ ...scope, mode: parsed.apply ? 'apply' : 'preview', rebuildId: deterministicId('repair', String(v2.projectId)), projectionNames: ['tasks', 'sessions', 'artifacts', 'claims', 'evidence', 'discoveries'] })
    return report('Memory V2 projection repair', operationLines(outcome, ['Canonical events are never deleted or reset.']), isFailureOutcome(outcome) ? 'error' : 'secondary', parsed.apply ? undefined : [{ label: 'Insert apply command', command: '/memory repair --apply' }])
  }

  if (parsed.command === 'revalidate') {
    if (parsed.args.length !== 2) return commandError(MEMORY_USAGE)
    const observationId = parsed.args[0]!
    const requestedPath = parsed.args[1]!
    const pathParts = requestedPath.split('/')
    if (!requestedPath || requestedPath.startsWith('/') || requestedPath.includes('\\') || pathParts.some((part) => !part || part === '.' || part === '..')) {
      return commandError('Revalidation requires a contained project-relative path.')
    }
    const taskId = await lookupObservationTaskId(v2, [observationId])
    if (!taskId) return commandError('The observation task could not be resolved.')
    const action = parsed.apply
      ? { kind: 'verify' as const, observationId, selector: { kind: 'file' as const, path: requestedPath }, observedDigest: readContainedProjectFile(deps.getRootDir(), requestedPath, EXPORT_MAX_BYTES).digest }
      : { kind: 'verify' as const, observationId, selector: { kind: 'file' as const, path: requestedPath } }
    const outcome = await v2.operator.revalidate({ ...scope, taskId, mode: parsed.apply ? 'apply' : 'preview', actions: [action] })
    return report('Memory V2 revalidation', operationLines(outcome, [parsed.apply ? 'Live file verification completed.' : 'Selector validated; live file verification is pending apply.']), isFailureOutcome(outcome) ? 'error' : 'secondary', parsed.apply ? undefined : [{ label: 'Insert apply command', command: `/memory revalidate ${parsed.args[0]} ${parsed.args[1]} --apply` }])
  }

  if (['correct', 'forget', 'pin'].includes(parsed.command)) {
    const observationId = parsed.args[0]
    if (!observationId) return commandError(MEMORY_USAGE)
    let action: unknown
    if (parsed.command === 'forget') {
      action = { kind: 'forget', observationIds: parsed.args, reason: 'user-request', requestedBy: 'cli-user', evidenceDisposition: 'remove-references' }
    } else if (parsed.command === 'pin') {
      if (parsed.args.length !== 1) return commandError(MEMORY_USAGE)
      action = { kind: 'pin', observationId, reason: 'Pinned by user from the CLI', pinnedBy: 'cli-user' }
    } else {
      const replacement = parsed.args.slice(1).join(' ').trim()
      if (!replacement) return commandError(MEMORY_USAGE)
      const inventory = await canonicalInventory(v2, 10_000)
      if (inventory.error) return commandError(`Correction lookup failed: ${safeOperationMessage(inventory.error.message)}`)
      const source = inventory.events.find((event) => event.eventType === 'observation.recorded' && event.payload.observation.observationId === observationId)
      if (!source || source.eventType !== 'observation.recorded') return commandError('The source observation could not be found; correction was not created.')
      const original = source.payload.observation
      action = { kind: 'correct', observationId, reason: 'User correction from the CLI', correction: { ...original, observationId: deterministicId('observation', `${observationId}:${replacement}`), summary: replacement.slice(0, 1_024), detail: replacement.slice(0, 16_384), evidence: original.evidence.map(({ excerpt: _excerpt, ...evidence }) => evidence), observedAt: now } }
    }
    const targetObservationIds = parsed.command === 'forget' ? parsed.args : [observationId]
    const taskId = parsed.command === 'correct' && typeof action === 'object' && action !== null && 'correction' in action
      ? (action as { correction: { taskId: string } }).correction.taskId
      : await lookupObservationTaskId(v2, targetObservationIds)
    if (!taskId) return commandError('The observation task could not be resolved.')
    const outcome = await v2.operator.correct({ ...scope, taskId, mode: parsed.apply ? 'apply' : 'preview', occurredAt: now, action })
    const applyCommand = `/memory ${parsed.command} ${parsed.args.join(' ')} --apply`
    return report(`Memory V2 ${parsed.command}`, operationLines(outcome, ['Preview is the default; apply appends canonical lifecycle events.']), isFailureOutcome(outcome) ? 'error' : 'secondary', parsed.apply ? undefined : [{ label: 'Insert apply command', command: applyCommand }])
  }

  if (parsed.command === 'export') return runExport(v2, parsed.args, deps.getRootDir())
  if (parsed.command === 'import') return runImport(v2, parsed.args, parsed.apply, deps.getRootDir())
  return commandError(MEMORY_USAGE)
  } finally {
    if (v2.status === 'available') await v2.release?.()
  }
}

async function lookupObservationTaskId(
  v2: Extract<Awaited<ReturnType<typeof getV2>>, { status: 'available' }>,
  observationIds: string[],
): Promise<string | undefined> {
  const inventory = await canonicalInventory(v2, 10_000)
  if (inventory.error) return undefined
  const wanted = new Set(observationIds)
  const taskIds = new Set<string>()
  for (const event of inventory.events) {
    if (event.eventType === 'observation.recorded' && wanted.has(event.payload.observation.observationId)) {
      taskIds.add(event.payload.observation.taskId)
      wanted.delete(event.payload.observation.observationId)
    } else if (event.eventType === 'claim.consolidated' && wanted.has(event.payload.canonicalObservation.observationId)) {
      taskIds.add(event.payload.canonicalObservation.taskId)
      wanted.delete(event.payload.canonicalObservation.observationId)
    } else if (event.eventType === 'claim.corrected' && wanted.has(event.payload.correction.observationId)) {
      taskIds.add(event.payload.correction.taskId)
      wanted.delete(event.payload.correction.observationId)
    }
  }
  return wanted.size === 0 && taskIds.size === 1 ? [...taskIds][0] : undefined
}

async function runExport(
  v2: Extract<Awaited<ReturnType<typeof getV2>>, { status: 'available' }>,
  args: string[],
  root: string,
): Promise<import('../types/chat').MemoryContentBlock> {
  const formatIndex = args.indexOf('--format')
  const format = formatIndex >= 0 ? args[formatIndex + 1] : 'json'
  if (format !== 'json' && format !== 'markdown') return commandError('Export format must be json or markdown.')
  const outcome = await v2.operator.exportManifest({ schemaVersion: 2, projectId: v2.projectId, generatedAt: new Date().toISOString(), includeStale: args.includes('--include-stale'), rendering: format === 'markdown' ? 'json-and-markdown' : 'json' })
  if (outcome.outcome !== 'exported') return commandError(`Memory export failed: ${safeOperationMessage(outcome.error.message)} Retryable: ${outcome.error.retryable ? 'yes' : 'no'}.`)
  const stem = `memory-v2-${outcome.manifest.checksum.slice(7, 23)}`
  const jsonName = `${stem}.json`
  const json = `${JSON.stringify(outcome.manifest, null, 2)}\n`
  if (Buffer.byteLength(json) > EXPORT_MAX_BYTES) return commandError('Memory export exceeds the bounded file size.')
  const directory = createContainedProjectDirectory(root, '.openbuff/memory/exports')
  let jsonCreated = false
  try {
    try {
      directory.writeExclusive(jsonName, json)
      jsonCreated = true
    } catch (error) {
      if (!(error instanceof ContainedFileIoError) || error.code !== 'exists') throw error
      const existing = readContainedProjectFile(root, `.openbuff/memory/exports/${jsonName}`, EXPORT_MAX_BYTES).text
      if (existing !== json) throw error
    }
    const paths = [`.openbuff/memory/exports/${jsonName}`]
    if (format === 'markdown') {
      if (!outcome.markdown || Buffer.byteLength(outcome.markdown) > EXPORT_MAX_BYTES) throw new ContainedFileIoError('too-large')
      const markdownName = `${stem}.md`
      try {
        directory.writeExclusive(markdownName, outcome.markdown)
      } catch (error) {
        if (!(error instanceof ContainedFileIoError) || error.code !== 'exists') throw error
        const existingMarkdown = readContainedProjectFile(root, `.openbuff/memory/exports/${markdownName}`, EXPORT_MAX_BYTES).text
        if (existingMarkdown !== outcome.markdown) throw error
      }
      paths.push(`.openbuff/memory/exports/${markdownName}`)
    }
    return report('Memory V2 export', [`Created: ${paths.join(', ')}.`, `Checksum: ${outcome.manifest.checksum}.`, `Canonical events: ${outcome.manifest.canonicalEventCount}; exported: ${outcome.manifest.events.length}.`, `Warnings: ${outcome.manifest.warnings.length ? outcome.manifest.warnings.slice(0, 20).map(safeOperationMessage).join('; ') : 'none'}.`], 'success')
  } catch {
    if (jsonCreated) directory.remove(jsonName)
    return commandError('Memory export failed: local output could not be created safely.')
  } finally {
    directory.close()
  }
}

function stableManifestJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableManifestJson).join(',')}]`
  if (typeof value === 'object') return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${stableManifestJson((value as Record<string, unknown>)[key])}`).join(',')}}`
  return JSON.stringify(null)
}

async function runImport(
  v2: Extract<Awaited<ReturnType<typeof getV2>>, { status: 'available' }>,
  args: string[],
  apply: boolean,
  root: string,
): Promise<import('../types/chat').MemoryContentBlock> {
  if (args.length !== 1) return commandError(MEMORY_USAGE)
  if (!args[0]!.toLowerCase().endsWith('.json')) return commandError('Memory import rejected: Import requires a project-relative JSON path.')
  try {
    const manifest = MemoryExportManifestV2Schema.parse(JSON.parse(readContainedProjectFile(root, args[0]!, EXPORT_MAX_BYTES).text))
    if (manifest.projectId !== v2.projectId) return commandError('Memory import rejected: Manifest project does not match the current project.')
    const { checksum: _checksum, ...checksumManifest } = manifest
    const checksum = `sha256:${createHash('sha256').update(stableManifestJson(checksumManifest)).digest('hex')}`
    if (checksum !== manifest.checksum) return commandError('Memory import rejected: Manifest checksum is invalid.')
    if (!apply) return report('Memory V2 import preview', [`Validated ${args[0]}.`, `Events: ${manifest.events.length}; checksum: ${manifest.checksum}.`, 'No writes were performed.'], 'secondary', [{ label: 'Insert apply command', command: `/memory import ${args[0]} --apply` }])
    const outcome = await v2.operator.importManifest({ schemaVersion: 2, projectId: v2.projectId, manifest, rebuildId: deterministicId('import', manifest.checksum), projectionNames: ['tasks', 'sessions', 'artifacts', 'claims', 'evidence', 'discoveries'], pageSize: 100 })
    return report('Memory V2 import', operationLines(outcome, [`Source: ${args[0]}.`]), outcome.outcome === 'imported' || outcome.outcome === 'no-op' ? 'success' : 'error')
  } catch (error) {
    const message = error instanceof ContainedFileIoError && error.code === 'invalid-path'
      ? 'Import requires a project-relative JSON path.'
      : error instanceof ContainedFileIoError && ['missing', 'not-regular', 'too-large'].includes(error.code)
        ? 'Import file is missing, not regular, or too large.'
        : 'The input could not be validated safely.'
    return commandError(`Memory import rejected: ${message}`)
  }
}

async function canonicalInventory(
  v2: Extract<Awaited<ReturnType<typeof getV2>>, { status: 'available' }>,
  maximum: number,
): Promise<{ events: import('@openbuff/sdk').MemoryEventEnvelope[]; error?: { message: string } }> {
  const events: import('@openbuff/sdk').MemoryEventEnvelope[] = []
  const cursors = new Set<string>()
  let afterEventId: import('@openbuff/sdk').MemoryEventId | undefined
  const pageBound = Math.min(100, Math.ceil(maximum / 1_000) + 1)
  for (let pageIndex = 0; pageIndex < pageBound && events.length < maximum; pageIndex++) {
    const page = await v2.repository.export({
      schemaVersion: 2,
      projectId: v2.projectId,
      ...(afterEventId ? { afterEventId } : {}),
      limit: Math.min(1_000, maximum - events.length),
    })
    if (page.outcome !== 'page') return { events: [], error: { message: 'Canonical inventory is temporarily unavailable.' } }
    const parsedEvents: import('@openbuff/sdk').MemoryEventEnvelope[] = []
    for (const candidate of page.events) {
      const parsed = MemoryEventEnvelopeSchema.safeParse(candidate)
      if (!parsed.success || parsed.data.projectId !== v2.projectId) return { events: [], error: { message: 'Canonical inventory failed validation.' } }
      parsedEvents.push(parsed.data)
    }
    if (page.nextAfterEventId && parsedEvents.length === 0) return { events: [], error: { message: 'Canonical inventory pagination did not advance.' } }
    if (page.nextAfterEventId) {
      if (
        page.nextAfterEventId === afterEventId ||
        cursors.has(page.nextAfterEventId) ||
        page.nextAfterEventId !== parsedEvents.at(-1)?.eventId
      ) return { events: [], error: { message: 'Canonical inventory pagination did not advance.' } }
      cursors.add(page.nextAfterEventId)
    }
    events.push(...parsedEvents)
    if (!page.nextAfterEventId) return { events }
    afterEventId = page.nextAfterEventId
  }
  return events.length >= maximum ? { events } : { events: [], error: { message: 'Canonical inventory exceeded its page bound.' } }
}

export async function handleMemoryCommandBlocks(
  rawArgs: string,
  deps: MemoryCommandDeps = defaultDeps,
): Promise<import('../types/chat').MemoryContentBlock> {
  try {
    const parsed = parseArgs(rawArgs)
    if (parsed.command === 'prune') return await runPruneBlock(deps)
    if (parsed.command === 'status') return await runStatusBlock(deps)
    return await runV2Command(rawArgs, deps)
  } catch {
    return commandError('The memory operation could not be completed safely. Please retry.')
  }
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
    let v2Lines: string[] | undefined
    if (deps.getMemoryV2) {
      const v2 = await getV2(deps)
      try {
      if (v2.status === 'available') {
        const [health, kernel, inventory] = await Promise.all([
          v2.repository.health({ schemaVersion: 2, projectId: v2.projectId }),
          v2.repository.kernelHealth(),
          canonicalInventory(v2, 1_000),
        ])
        const migration = !inventory.error
          ? [...inventory.events].reverse().find((event) => event.eventType === 'migration.v1.imported')
          : undefined
        const migrationPayload = migration
          ? V1MigrationPayloadSchema.safeParse(migration.payload)
          : undefined
        v2Lines = [
          `Memory authority: requested ${v2.requestedAuthority}; active ${v2.effectiveAuthority}.`,
          `V1 compatibility shadow: ${context ? 'available' : 'not yet available'}.`,
          `Memory V2: ${health.status}; repository authority ${health.authority.kind}; backend ${health.backend.backendId}.`,
          migrationPayload?.success
            ? `Last V1 import: revision ${migrationPayload.data.sourceRevision ?? 'unknown'}; checksum ${migrationPayload.data.sourceChecksum?.slice(0, 24) ?? 'unknown'}; identity ${migrationPayload.data.legacyRecordKey.slice(0, 64)}.`
            : 'Last V1 import: unavailable.',
          'Last parity: unavailable in this command session.',
          `Schema ${kernel.schemaVersion ?? 'unknown'}; capabilities ${health.backend.capabilities.join(', ')}; events ${inventory.error ? 'unavailable' : inventory.events.length}; projection ${kernel.projectionCursor ?? 'unknown'}.`,
          `Degradation: ${health.issues.length ? health.issues.map(safeOperationMessage).join('; ') : 'none'}.`,
        ]
      } else {
        v2Lines = [
          `Memory authority: requested ${v2.requestedAuthority}; active ${v2.effectiveAuthority}.`,
          `V1 compatibility shadow: ${context ? 'available' : 'not yet available'}.`,
          `Memory V2: ${safeOperationMessage(v2.degradation)}`,
        ]
      }
      } finally {
        if (v2.status === 'available') await v2.release?.()
      }
    }
    if (!context) return { type: 'memory', state: 'empty', ...(v2Lines ? { v2Lines } : {}) }
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
      ...(v2Lines ? { v2Lines } : {}),
    }
  } catch {
    return {
      type: 'memory',
      state: 'error',
      message: 'Memory status failed safely. Please retry.',
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
  } catch {
    return {
      type: 'memory',
      state: 'error',
      message: 'Memory prune failed safely. Please retry.',
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
