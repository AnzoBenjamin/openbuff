import { createHash } from 'node:crypto'

import { classifyMemoryArtifactPath } from '@codebuff/common/util/memory-artifact-policy'

import {
  MemoryAppendOutcomeSchema,
  MemoryAppendRequestSchema,
  MemoryEventIdSchema,
  MemoryExportOutcomeSchema,
  MemoryQueryOutcomeSchema,
  MemoryRetrievalRequestSchema,
  MemoryTurnContextV2Schema,
  QueryCategoryCountsSchema,
  QueryDegradationSummarySchema,
  type MemoryAuthorityMode,
  type MemoryEventDraft,
  type MemoryEventId,
  type MemoryJsonValue,
  type MemoryRetrievalResult,
  type MemorySessionId,
  type TaskId,
} from '@codebuff/common/types/memory-v2'
import type {
  AgentOutput,
  AgentState,
  MemoryAuthorityReasonCode,
  MemoryParityStateV2,
  MemoryRuntimeStateV2,
} from '@codebuff/common/types/session-state'
import {
  fileMutationResultV1Schema,
  getConfirmedAppliedActionsV1,
} from '@codebuff/common/tools/results/filesystem'
import type { Logger } from '@codebuff/common/types/contracts/logger'
import type { ToolResultOutput } from '@codebuff/common/types/messages/content-part'
import type { WorkspaceStateV1 } from '@codebuff/common/types/workspace-state'

import {
  createMemoryEventDraft,
  deriveMemorySessionId,
  deriveObservationId,
  deriveQueryId,
  deriveTaskId,
} from './event-factory'
import { importTaskMemoryV1, type V1MigrationOutcome } from './v1-migration'
import {
  getEffectiveMemoryAuthority,
  type MemoryRepositoryV2,
  type MemoryV2ClientConfig,
} from './types'

const MAX_QUERY_LENGTH = 8_192
const MAX_PATHS = 32
const MAX_ACTIONS = 32
const MAX_CANONICAL_NODES = 512
const MAX_CONFLICT_RETRIES = 2
const MAX_TAIL_EXPORT_PAGES = 10
const MAX_PARITY_COUNT_ENTRIES = 64
const FINISH_TURN_TIMEOUT_MS = 2_000

type QueryTerminal = NonNullable<
  MemoryRuntimeStateV2['pendingTerminal']
>['query']

type TailDerivationResult =
  | { kind: 'empty' }
  | { kind: 'found'; eventId: MemoryEventId }
  | { kind: 'failed' }

type PreparationOperation = {
  generation: number
  signal?: AbortSignal
  runtimeState?: MemoryRuntimeStateV2
  queryTerminal?: QueryTerminal
  ready: boolean
}

const CAPTURE_KINDS: Readonly<Record<string, string>> = {
  read_files: 'read',
  code_search: 'search',
  find_files_matching_content: 'search',
  list_directory: 'list',
  glob: 'list',
  git_status: 'discovery',
  inspect_workspace: 'discovery',
  get_task: 'discovery',
  get_change_review_bundle: 'review',
  run_targeted_validation: 'validation',
  run_file_change_hooks: 'validation',
  inspect_environment: 'discovery',
  get_affected_tests: 'test',
  get_build_targets: 'build',
  inspect_codebase_structure: 'discovery',
  inspect_feature_completeness: 'review',
  evaluate_audit_coverage: 'review',
  write_file: 'mutation',
  str_replace: 'mutation',
  create_plan: 'mutation',
  edit_transaction: 'mutation',
  replace_range: 'mutation',
  write_audit_findings: 'mutation',
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

function canonicalBounded(value: unknown): string {
  let nodes = 0
  const visit = (candidate: unknown, depth: number): unknown => {
    if (++nodes > MAX_CANONICAL_NODES || depth > 6) return '[bounded]'
    if (
      candidate === null ||
      typeof candidate === 'boolean' ||
      (typeof candidate === 'number' && Number.isFinite(candidate))
    ) {
      return candidate
    }
    if (typeof candidate === 'string') return candidate.slice(0, 4_096)
    if (Array.isArray(candidate)) {
      return candidate.slice(0, 64).map((item) => visit(item, depth + 1))
    }
    if (isRecord(candidate)) {
      return Object.fromEntries(
        Object.keys(candidate)
          .sort()
          .slice(0, 64)
          .map((key) => [key.slice(0, 128), visit(candidate[key], depth + 1)]),
      )
    }
    return String(candidate).slice(0, 128)
  }
  return JSON.stringify(visit(value, 0))
}

const digestOutput = (output: ToolResultOutput[]): string =>
  `sha256:${createHash('sha256').update(canonicalBounded(output)).digest('hex')}`

function normalizeProjectPath(candidate: unknown): string | undefined {
  if (typeof candidate !== 'string') return undefined
  const decision = classifyMemoryArtifactPath(candidate)
  return decision.allowed ? decision.normalizedPath : undefined
}

function collectPaths(input: unknown, values: Record<string, unknown>[]): string[] {
  const paths = new Set<string>()
  const add = (candidate: unknown) => {
    const normalized = normalizeProjectPath(candidate)
    if (normalized && paths.size < MAX_PATHS) paths.add(normalized)
  }
  const addArray = (candidate: unknown) => {
    if (!Array.isArray(candidate)) return
    for (const item of candidate.slice(0, MAX_PATHS)) {
      if (typeof item === 'string') add(item)
      else if (isRecord(item)) {
        add(item.path)
        add(item.filePath)
        add(item.destinationPath)
      }
    }
  }
  if (isRecord(input)) {
    add(input.path)
    add(input.filePath)
    add(input.cwd)
    addArray(input.paths)
    addArray(input.filePaths)
    addArray(input.files)
    addArray(input.scope)
  }
  for (const value of values.slice(0, 16)) {
    add(value.path)
    add(value.filePath)
    add(value.destinationPath)
    addArray(value.paths)
    addArray(value.files)
    addArray(value.results)
    addArray(value.matches)
    addArray(value.entries)
    addArray(value.actions)
  }
  return [...paths]
}

function hasErrorResult(values: Record<string, unknown>[]): boolean {
  return values.some(
    (value) =>
      typeof value.errorMessage === 'string' ||
      value.type === 'error' ||
      value.outcome === 'rejected' ||
      value.outcome === 'failed',
  )
}

/**
 * Sums bounded non-negative integer counts from an untrusted marker payload.
 * Accepts a single count, a bounded array, or a bounded record of counts;
 * anything else is unreadable and reported as undefined.
 */
function boundedCountSum(candidate: unknown, depth = 0): number | undefined {
  if (typeof candidate === 'number') {
    return Number.isInteger(candidate) && candidate >= 0 ? candidate : undefined
  }
  if (depth >= 2) return undefined
  if (Array.isArray(candidate)) {
    let sum = 0
    for (const item of candidate.slice(0, MAX_PARITY_COUNT_ENTRIES)) {
      const value = boundedCountSum(item, depth + 1)
      if (value === undefined) return undefined
      sum += value
    }
    return sum
  }
  if (isRecord(candidate)) {
    const keys = Object.keys(candidate)
    if (keys.length > MAX_PARITY_COUNT_ENTRIES) return undefined
    let sum = 0
    for (const key of keys) {
      const value = boundedCountSum(candidate[key], depth + 1)
      if (value === undefined) return undefined
      sum += value
    }
    return sum
  }
  return undefined
}

/**
 * Defensively reads the optional migration-marker fields the V1 importer may
 * return on imported/no-op outcomes (added by a sibling change): the
 * repository cursor after the import batch, the bounded source item counts,
 * and the truncated-field count recorded in the marker payload. Values that
 * are absent or fail validation are omitted so callers proceed unchanged.
 */
export function extractV1MigrationExtras(migration: V1MigrationOutcome): {
  lastEventId?: MemoryEventId
  sourceItemCount?: number
  truncatedFields?: number
} {
  if (migration.outcome !== 'imported' && migration.outcome !== 'no-op') return {}
  const marker: unknown = migration
  if (!isRecord(marker)) return {}
  const extras: {
    lastEventId?: MemoryEventId
    sourceItemCount?: number
    truncatedFields?: number
  } = {}
  const lastEventId = MemoryEventIdSchema.safeParse(marker.lastEventId)
  if (lastEventId.success) extras.lastEventId = lastEventId.data
  const sourceItemCount = boundedCountSum(marker.sourceItemCounts)
  if (sourceItemCount !== undefined) extras.sourceItemCount = sourceItemCount
  const truncatedFields = marker.truncatedFields
  if (
    typeof truncatedFields === 'number' &&
    Number.isSafeInteger(truncatedFields) &&
    truncatedFields >= 0
  ) {
    extras.truncatedFields = truncatedFields
  }
  return extras
}

/**
 * Parity compares the migration marker's own source item counts against the
 * imported observation coverage — never query-result categories, which are
 * incommensurate with them (migration:parity-compares-incommensurate-counts).
 * When the marker carries no source counts, parity is reported as unavailable
 * and the query categories remain available as telemetry via `counts.v2`.
 */
export function computeMemoryParity(params: {
  memory: NonNullable<AgentState['taskMemory']>
  result: MemoryRetrievalResult
  migration: V1MigrationOutcome
}): MemoryParityStateV2 {
  const { memory, result, migration } = params
  const listCounts = {
    requirements: memory.requirements.length,
    decisions: memory.decisions.length,
    filesInspected: memory.filesInspected.length,
    editsMade: memory.editsMade.length,
    validationResults: memory.validationResults.length,
    reviewReceipts: memory.reviewReceipts.length,
    blockers: memory.blockers.length,
    nextActions: memory.nextActions.length,
    historicalSummary: memory.historicalSummary.trim() ? 1 : 0,
    evidenceFresh: memory.evidence.filter((item) => item.stale !== true).length,
    evidenceStale: memory.evidence.filter((item) => item.stale === true).length,
  }
  const importedCoverage =
    migration.outcome === 'imported' || migration.outcome === 'no-op'
      ? migration.importedObservationIds.length
      : 0
  const v2Counts = {
    matched: result.matchedTasks.length,
    verified: result.verifiedKnowledge.length,
    reusable: result.reusableDiscovery.length,
    reread: result.rereadRequired.length,
    historical: result.historicalContext.length,
    importedCoverage,
  }
  let classification: MemoryParityStateV2['classification'] = 'unavailable'
  let reasonCodes: MemoryParityStateV2['reasonCodes'] = ['import-unavailable']
  const { sourceItemCount } = extractV1MigrationExtras(migration)
  if (sourceItemCount !== undefined) {
    if (sourceItemCount === importedCoverage) {
      classification = 'match'
      reasonCodes = ['coverage-equivalent']
    } else if (sourceItemCount > importedCoverage) {
      classification = 'v1-ahead'
      reasonCodes = ['v1-counts-greater']
    } else {
      classification = 'v2-ahead'
      reasonCodes = ['v2-counts-greater']
    }
  }
  return {
    revision: memory.revision,
    checksum: memory.checksum.slice(0, 256),
    classification,
    reasonCodes,
    counts: { v1: listCounts, v2: v2Counts },
  }
}

function countSummary(values: Record<string, unknown>[]): Record<string, number> {
  const summary: Record<string, number> = {}
  const keys = [
    'results',
    'matches',
    'entries',
    'files',
    'tests',
    'targets',
    'findings',
    'diagnostics',
    'issues',
  ]
  for (const key of keys) {
    let count = 0
    let recognized = false
    for (const value of values) {
      const item = value[key]
      if (Array.isArray(item)) {
        count += Math.min(item.length, 100)
        recognized = true
      } else if (typeof item === 'number' && Number.isInteger(item) && item >= 0) {
        count += Math.min(item, 100)
        recognized = true
      }
    }
    if (recognized) summary[key] = Math.min(count, 100)
  }
  return summary
}

export class MemoryV2Coordinator {
  private queue: Promise<void> = Promise.resolve()
  private runtimeState: MemoryRuntimeStateV2 | undefined
  private queryTerminal: QueryTerminal | undefined
  private preparationReady = false
  private preparationGeneration = 0
  private activePreparation: PreparationOperation | undefined

  constructor(
    private readonly config: MemoryV2ClientConfig,
    private readonly logger?: Pick<Logger, 'warn'>,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  private bestEffort(operation: () => Promise<void>): Promise<void> {
    return operation().catch((error) => {
      this.logger?.warn({ error }, 'Memory V2 coordination failed')
    })
  }

  private isCurrent(operation?: PreparationOperation): boolean {
    return (
      operation === undefined ||
      (this.activePreparation === operation &&
        operation.generation === this.preparationGeneration &&
        operation.signal?.aborted !== true)
    )
  }

  private async append(
    events: MemoryEventDraft[],
    runtimeState: MemoryRuntimeStateV2,
    preparation?: PreparationOperation,
  ): Promise<boolean> {
    let committed = false
    const queued = this.queue.then(async () => {
      if (!this.isCurrent(preparation)) return
      if (events.length === 0) {
        committed = true
        return
      }
      const repository = this.config.repository
      if (!repository) return
      committed = await this.appendWithConflictRetry(
        repository,
        events,
        runtimeState,
        preparation,
      )
    })
    this.queue = queued.catch((error) => {
      this.logger?.warn({ error }, 'Memory V2 append failed')
    })
    await this.queue
    return committed && this.isCurrent(preparation)
  }

  private appendBounded(
    events: MemoryEventDraft[],
    runtimeState: MemoryRuntimeStateV2,
  ): Promise<boolean> {
    const pending = this.append(events, runtimeState)
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), FINISH_TURN_TIMEOUT_MS)
      timer.unref?.()
    })
    return Promise.race([pending, timeout]).finally(() => {
      if (timer !== undefined) clearTimeout(timer)
    })
  }

  private async appendWithConflictRetry(
    repository: MemoryRepositoryV2,
    events: MemoryEventDraft[],
    runtimeState: MemoryRuntimeStateV2,
    preparation?: PreparationOperation,
  ): Promise<boolean> {
    let expectedTail = runtimeState.lastEventId
      ? { kind: 'event' as const, eventId: runtimeState.lastEventId }
      : { kind: 'empty' as const }
    for (let attempt = 0; ; attempt++) {
      const outcome = MemoryAppendOutcomeSchema.parse(
        await repository.append(
          MemoryAppendRequestSchema.parse({
            schemaVersion: 2,
            projectId: this.config.projectId,
            events,
            expectedTail,
          }),
        ),
      )
      if (!this.isCurrent(preparation)) return false
      if (outcome.outcome === 'appended') {
        runtimeState.lastEventId = outcome.lastEventId
        return true
      }
      this.logger?.warn(
        { outcome: outcome.outcome, code: outcome.error.code, attempt },
        'Memory V2 append was not committed',
      )
      const conflict = outcome.error.code === 'conflict' && outcome.error.retryable
      if (!conflict || attempt >= MAX_CONFLICT_RETRIES) return false
      const tail = await this.deriveRepositoryTail(repository, preparation)
      if (!this.isCurrent(preparation) || tail.kind === 'failed') return false
      expectedTail =
        tail.kind === 'empty'
          ? { kind: 'empty' }
          : { kind: 'event', eventId: tail.eventId }
    }
  }

  private async deriveRepositoryTail(
    repository: MemoryRepositoryV2,
    preparation?: PreparationOperation,
  ): Promise<TailDerivationResult> {
    let afterEventId: MemoryEventId | undefined
    let tail: MemoryEventId | undefined
    const seenCursors = new Set<MemoryEventId>()
    try {
      for (let page = 0; page < MAX_TAIL_EXPORT_PAGES; page++) {
        const rawOutcome: unknown = await repository.export({
          schemaVersion: 2,
          projectId: this.config.projectId,
          ...(afterEventId ? { afterEventId } : {}),
          limit: 1_000,
        })
        if (!this.isCurrent(preparation)) return { kind: 'failed' }
        const parsed = MemoryExportOutcomeSchema.safeParse(rawOutcome)
        if (!parsed.success || parsed.data.outcome !== 'page') {
          return { kind: 'failed' }
        }
        const outcome = parsed.data
        if (outcome.events.some((event) => event.projectId !== this.config.projectId)) {
          return { kind: 'failed' }
        }
        const last = outcome.events.at(-1)
        if (last) tail = last.eventId
        const next = outcome.nextAfterEventId
        if (!next) return tail ? { kind: 'found', eventId: tail } : { kind: 'empty' }
        if (outcome.events.length === 0 || next === afterEventId || seenCursors.has(next)) {
          return { kind: 'failed' }
        }
        seenCursors.add(next)
        afterEventId = next
      }
    } catch (error) {
      this.logger?.warn({ error }, 'Memory V2 tail derivation failed')
    }
    return { kind: 'failed' }
  }

  /**
   * Shared decision S4: degraded V2 handling. Under sqlite-v2-opt-in the
   * authority STAYS active and any injected context is cleared — V1 is never
   * re-activated (existing run-agent-step behavior keeps it suppressed while
   * the authority is opt-in). Only json-v1/shadow-v2 requests fall back to
   * json-v1.
   */
  private applyDegradedState(
    agentState: AgentState,
    reason: MemoryAuthorityReasonCode,
  ): void {
    agentState.memoryV2Context = undefined
    if (!agentState.memoryAuthority) return
    agentState.memoryAuthority.active =
      agentState.memoryAuthority.requested === 'sqlite-v2-opt-in'
        ? 'sqlite-v2-opt-in'
        : 'json-v1'
    agentState.memoryAuthority.fallbackOccurred = false
    agentState.memoryAuthority.reason = reason
  }

  async prepareTurn(params: {
    agentState: AgentState
    trustedUserInputId: string
    query: string
    workspaceState?: WorkspaceStateV1
    resumeInterruptedTurn?: boolean
    signal?: AbortSignal
  }): Promise<void> {
    const operation: PreparationOperation = {
      generation: ++this.preparationGeneration,
      signal: params.signal,
      ready: false,
    }
    this.activePreparation = operation
    this.runtimeState = undefined
    this.queryTerminal = undefined
    this.preparationReady = false
    const stagedState: AgentState = {
      ...params.agentState,
      memoryV2: params.agentState.memoryV2
        ? structuredClone(params.agentState.memoryV2)
        : undefined,
      memoryAuthority: params.agentState.memoryAuthority
        ? structuredClone(params.agentState.memoryAuthority)
        : undefined,
      memoryV2Context: params.agentState.memoryV2Context
        ? structuredClone(params.agentState.memoryV2Context)
        : undefined,
    }
    const invalidate = () => {
      if (this.activePreparation !== operation) return
      operation.ready = false
      this.runtimeState = undefined
      this.queryTerminal = undefined
      this.preparationReady = false
      this.queue = Promise.resolve()
    }
    params.signal?.addEventListener('abort', invalidate, { once: true })
    const commit = () => {
      if (!this.isCurrent(operation)) return false
      params.agentState.memoryV2 = stagedState.memoryV2
      params.agentState.memoryV2Context = stagedState.memoryV2Context
      params.agentState.memoryAuthority = stagedState.memoryAuthority
      this.runtimeState = operation.runtimeState
      this.queryTerminal = operation.queryTerminal
      this.preparationReady = operation.ready
      return true
    }

    try {
      const { requested, invalidAuthority } =
        getEffectiveMemoryAuthority(this.config)
      stagedState.memoryV2Context = undefined
      stagedState.memoryAuthority = {
        schemaVersion: 1,
        userInputId: params.trustedUserInputId.slice(0, 128),
        requested,
        active: 'json-v1',
        fallbackOccurred: false,
        reason: invalidAuthority
          ? 'invalid-authority'
          : requested === 'json-v1'
            ? 'json-v1-selected'
            : requested === 'shadow-v2'
              ? 'shadow-v2-selected'
              : undefined,
        v1CompatibilityShadowAvailable: stagedState.taskMemory !== undefined,
        v1Import: stagedState.taskMemory
          ? { status: 'not-required' }
          : { status: 'no-record' },
      }
      if (requested === 'json-v1') {
        stagedState.memoryV2 = undefined
        commit()
        return
      }
      if (!this.config.repository) {
        this.logger?.warn({}, 'Memory V2 repository is unavailable')
        this.applyDegradedState(stagedState, 'backend-unavailable')
        commit()
        return
      }
      try {
        await this.prepareConfiguredTurn(
          { ...params, agentState: stagedState },
          requested,
          operation,
        )
      } catch (error) {
        if (!this.isCurrent(operation)) return
        this.logger?.warn({ error }, 'Memory V2 preparation failed')
        this.applyDegradedState(stagedState, 'query-failed')
      }
      commit()
    } finally {
      params.signal?.removeEventListener('abort', invalidate)
    }
  }

  private async prepareConfiguredTurn(params: {
    agentState: AgentState
    trustedUserInputId: string
    query: string
    workspaceState?: WorkspaceStateV1
    resumeInterruptedTurn?: boolean
    signal?: AbortSignal
  }, authority: Exclude<MemoryAuthorityMode, 'json-v1'>, operation: PreparationOperation): Promise<void> {
    const repository = this.config.repository
    if (!repository) {
      this.applyDegradedState(params.agentState, 'backend-unavailable')
      return
    }
    let persisted = params.agentState.memoryV2
    if (
      persisted?.projectId === this.config.projectId &&
      persisted.turn.status === 'finishing'
    ) {
      // Legacy finishing checkpoints did not persist a replayable decision.
      // They fail closed below rather than fabricating a terminal payload.
      const decision = this.parsePendingTerminal(persisted.pendingTerminal)
      if (!decision) {
        operation.runtimeState = persisted
        this.applyDegradedState(params.agentState, 'lifecycle-append-failed')
        return
      }
      const replayState = structuredClone(persisted)
      operation.runtimeState = replayState
      operation.queryTerminal = decision.query
      const replayed = await this.append(
        this.buildTerminalDrafts(replayState, decision),
        replayState,
        operation,
      )
      if (!this.isCurrent(operation)) return
      if (!replayed) {
        params.agentState.memoryV2 = replayState
        operation.runtimeState = replayState
        operation.queryTerminal = decision.query
        operation.ready = false
        this.applyDegradedState(params.agentState, 'lifecycle-append-failed')
        return
      }
      replayState.turn.status = decision.status
      replayState.activeTask.status = decision.status
      replayState.pendingTerminal = undefined
      params.agentState.memoryV2 = replayState
      persisted = replayState
    }
    const activePersisted =
      persisted?.projectId === this.config.projectId &&
      persisted.turn.status === 'active'
        ? persisted
        : undefined
    const resumedPersisted =
      params.resumeInterruptedTurn === true ? activePersisted : undefined
    const resume = resumedPersisted !== undefined
    const isNewSession = activePersisted === undefined
    const startedAt = activePersisted
      ? activePersisted.sessionStartedAt
      : this.now()
    const sessionId = activePersisted
      ? activePersisted.sessionId
      : deriveMemorySessionId({
          projectId: this.config.projectId,
          userInputId: params.trustedUserInputId,
        })
    const turnStartedAt = resumedPersisted
      ? resumedPersisted.turn.startedAt
      : this.now()
    const taskId = resumedPersisted
      ? resumedPersisted.activeTask.taskId
      : deriveTaskId({
          projectId: this.config.projectId,
          sessionId,
          userInputId: params.trustedUserInputId,
        })
    const queryId = resumedPersisted
      ? resumedPersisted.turn.queryId
      : deriveQueryId({
          projectId: this.config.projectId,
          sessionId,
          userInputId: params.trustedUserInputId,
        })
    const runtimeState: MemoryRuntimeStateV2 = {
      schemaVersion: 2,
      projectId: this.config.projectId,
      sessionId,
      sessionStartedAt: startedAt,
      ...(persisted?.lastEventId ? { lastEventId: persisted.lastEventId } : {}),
      activeTask: { taskId, status: 'active' },
      turn: {
        userInputId: resumedPersisted
          ? resumedPersisted.turn.userInputId
          : params.trustedUserInputId.slice(0, 128),
        queryId,
        startedAt: turnStartedAt,
        status: 'active',
      },
    }
    operation.runtimeState = runtimeState
    params.agentState.memoryV2 = runtimeState

    let migration: V1MigrationOutcome = { outcome: 'no-record' }
    if (params.agentState.taskMemory) {
      migration = await importTaskMemoryV1({
        memory: params.agentState.taskMemory,
        projectId: this.config.projectId,
        sessionId,
        repository,
      })
      if (!this.isCurrent(operation)) return
      if (migration.outcome === 'imported' || migration.outcome === 'no-op') {
        // compatibility:v1-import-invalidates-persisted-tail: the import (or
        // its confirmed no-op) may advance the repository tail past this
        // turn's persisted cursor. Adopt the returned cursor before any
        // lifecycle or capture append chains off the stale one; when the
        // outcome carries no cursor, proceed unchanged.
        const { lastEventId: importedTail } =
          extractV1MigrationExtras(migration)
        if (importedTail) {
          runtimeState.lastEventId = importedTail
          params.agentState.memoryV2 = runtimeState
        }
        params.agentState.memoryAuthority!.v1Import = {
          status: migration.outcome,
          revision: migration.revision,
          checksum: migration.checksum.slice(0, 256),
          identity: migration.identity.slice(0, 256),
          importedObservations: migration.importedObservationIds.length,
          omittedFields: migration.omittedFields,
          warningCodes: migration.warnings,
        }
      } else if (migration.outcome === 'rejected' || migration.outcome === 'failed') {
        const reason: MemoryAuthorityReasonCode =
          migration.reason === 'checksum-mismatch'
            ? 'migration-checksum-mismatch'
            : migration.outcome === 'rejected'
              ? 'migration-rejected'
              : 'migration-failed'
        params.agentState.memoryAuthority!.v1Import = {
          status: 'failed',
          ...(migration.revision !== undefined ? { revision: migration.revision } : {}),
          ...(migration.checksum ? { checksum: migration.checksum.slice(0, 256) } : {}),
          reason,
        }
        this.applyDegradedState(params.agentState, reason)
        if (authority === 'sqlite-v2-opt-in') return
      } else if (migration.outcome === 'no-record') {
        params.agentState.memoryAuthority!.v1Import = { status: 'no-record' }
      }
    }

    const drafts: MemoryEventDraft[] = []
    if (isNewSession) {
      drafts.push(
        createMemoryEventDraft({
          projectId: this.config.projectId,
          sessionId,
          userInputId: params.trustedUserInputId,
          occurredAt: startedAt,
          eventType: 'session.started',
          payload: { payloadSchemaVersion: 1, startedAt },
        }),
      )
    }
    if (!resume) {
      drafts.push(
        createMemoryEventDraft({
          projectId: this.config.projectId,
          sessionId,
          userInputId: params.trustedUserInputId,
          occurredAt: turnStartedAt,
          eventType: 'task.created',
          payload: {
            payloadSchemaVersion: 1,
            taskId,
            title: 'SDK agent turn',
            objective: 'Complete the trusted SDK user input.',
            initialStatus: 'created',
          },
        }),
        createMemoryEventDraft({
          projectId: this.config.projectId,
          sessionId,
          userInputId: params.trustedUserInputId,
          sourceIndex: 1,
          occurredAt: turnStartedAt,
          eventType: 'task.transitioned',
          payload: {
            payloadSchemaVersion: 1,
            taskId,
            fromStatus: 'created',
            toStatus: 'active',
            reason: 'SDK turn started',
          },
        }),
        createMemoryEventDraft({
          projectId: this.config.projectId,
          sessionId,
          userInputId: params.trustedUserInputId,
          sourceIndex: 2,
          occurredAt: turnStartedAt,
          eventType: 'query.started',
          payload: {
            payloadSchemaVersion: 1,
            queryId,
            taskId,
            userInputId: params.trustedUserInputId.slice(0, 128),
            mode: authority === 'sqlite-v2-opt-in' ? 'inject' : 'shadow',
            startedAt: turnStartedAt,
          },
        }),
      )
    }
    const lifecycleCommitted = await this.append(drafts, runtimeState, operation)
    if (!this.isCurrent(operation)) return
    if (!lifecycleCommitted) {
      this.applyDegradedState(params.agentState, 'lifecycle-append-failed')
      if (authority === 'sqlite-v2-opt-in') return
    }

    const query = params.query.trim().slice(0, MAX_QUERY_LENGTH) || 'SDK agent turn'
    const queryRequest = MemoryRetrievalRequestSchema.parse({
      schemaVersion: 2,
      queryId,
      projectId: this.config.projectId,
      sessionId,
      query,
      taskId,
      ...(params.workspaceState
        ? {
            workspaceRevision: params.workspaceState.revision,
            workspaceSnapshotId: params.workspaceState.snapshotId,
          }
        : {}),
      selectors: [],
      artifactKinds: [],
      includeHistorical: true,
      maxResultsPerCategory: 100,
    })
    let rawOutcome: unknown
    try {
      rawOutcome = await repository.query(queryRequest)
      if (!this.isCurrent(operation)) return
    } catch (error) {
      this.logger?.warn({ error }, 'Memory V2 query threw')
      operation.queryTerminal = {
        outcome: 'failed',
        error: 'Memory repository query threw',
        retryable: true,
      }
      this.applyDegradedState(params.agentState, 'query-threw')
      return
    }
    const parsedOutcome = MemoryQueryOutcomeSchema.safeParse(rawOutcome)
    if (!parsedOutcome.success) {
      this.logger?.warn({}, 'Memory V2 query returned an invalid result')
      operation.queryTerminal = {
        outcome: 'failed',
        error: 'Memory repository query returned an invalid result',
        retryable: true,
      }
      this.applyDegradedState(params.agentState, 'query-invalid-result')
      return
    }
    const outcome = parsedOutcome.data
    if (outcome.outcome === 'result') {
      const result = outcome.result
      // reliability:query-result-project-is-not-correlated: only a fully
      // correlated result (project and query) may drive parity or context
      // installation; anything else is an invalid result and degrades S4.
      if (
        result.projectId !== this.config.projectId ||
        result.queryId !== queryId
      ) {
        this.logger?.warn({}, 'Memory V2 query result failed correlation checks')
        operation.queryTerminal = {
          outcome: 'failed',
          error: 'Memory repository query result failed correlation checks',
          retryable: true,
        }
        this.applyDegradedState(params.agentState, 'query-invalid-result')
        return
      }
      if (params.agentState.taskMemory) {
        params.agentState.memoryAuthority!.parity = computeMemoryParity({
          memory: params.agentState.taskMemory,
          result,
          migration,
        })
      }
      operation.ready = true
      operation.queryTerminal = {
        outcome: 'completed',
        counts: {
          matchedTasks: result.matchedTasks.length,
          verifiedKnowledge: result.verifiedKnowledge.length,
          reusableDiscovery: result.reusableDiscovery.length,
          rereadRequired: result.rereadRequired.length,
          historicalContext: result.historicalContext.length,
        },
        degradation:
          result.degradation.state === 'none'
            ? { state: 'none' }
            : {
                state: 'degraded',
                reasons: result.degradation.reasons.map(({ code, retryable }) => ({
                  code,
                  retryable,
                })),
              },
      }
      // Shared decision S4: a retrieval that degraded because the backend,
      // authority, or resource budget was unavailable must not inject context,
      // but the opt-in authority stays active (V1 is not re-activated).
      const retrievalUnavailable =
        result.degradation.state === 'degraded' &&
        result.degradation.reasons.some(
          (reason) =>
            reason.code === 'backend-unavailable' ||
            reason.code === 'authority-unavailable' ||
            reason.code === 'resource-budget',
        )
      if (retrievalUnavailable) {
        this.applyDegradedState(params.agentState, 'backend-unavailable')
        return
      }
      if (authority === 'sqlite-v2-opt-in') {
        params.agentState.memoryV2Context = MemoryTurnContextV2Schema.parse({
          schemaVersion: 2,
          userInputId: params.trustedUserInputId.slice(0, 128),
          queryId,
          taskId,
          result,
        })
        params.agentState.memoryAuthority!.active = 'sqlite-v2-opt-in'
        params.agentState.memoryAuthority!.fallbackOccurred = false
        params.agentState.memoryAuthority!.reason = undefined
      }
      return
    }
    const rejected = outcome.outcome === 'rejected'
    operation.queryTerminal = {
      outcome: 'failed',
      error: rejected
        ? 'Memory repository query rejected'
        : 'Memory repository query failed',
      retryable: outcome.error.retryable,
    }
    this.applyDegradedState(
      params.agentState,
      rejected ? 'query-rejected' : 'query-failed',
    )
  }

  async recordToolObservation(params: {
    toolName: string
    callId: string
    userInputId: string
    input: unknown
    output: ToolResultOutput[]
    workspaceState?: WorkspaceStateV1
    native: boolean
    mcp?: boolean
  }): Promise<void> {
    return this.bestEffort(() => this.captureToolObservation(params))
  }

  private async captureToolObservation(params: {
    toolName: string
    callId: string
    userInputId: string
    input: unknown
    output: ToolResultOutput[]
    workspaceState?: WorkspaceStateV1
    native: boolean
    mcp?: boolean
  }): Promise<void> {
    const runtimeState = this.runtimeState
    const preparation = this.activePreparation
    if (
      this.config.capture !== 'safe' ||
      !this.preparationReady ||
      !runtimeState ||
      runtimeState.turn.status !== 'active' ||
      !params.native ||
      params.mcp ||
      !CAPTURE_KINDS[params.toolName] ||
      params.output.length === 0 ||
      params.output.some((part) => part.type !== 'json')
    ) {
      return
    }
    const values: Record<string, unknown>[] = []
    for (const part of params.output) {
      if (part.type !== 'json' || !isRecord(part.value)) return
      values.push(part.value)
    }
    if (hasErrorResult(values)) return

    const captureKind = CAPTURE_KINDS[params.toolName]!
    let actions: MemoryJsonValue[] = []
    if (captureKind === 'mutation') {
      const mutation = values
        .map((value) => fileMutationResultV1Schema.safeParse(value))
        .find((parsed) => parsed.success)
      if (!mutation?.success) return
      actions = getConfirmedAppliedActionsV1(mutation.data)
        .slice(0, MAX_ACTIONS)
        .flatMap((action) => {
          const normalizedPath = normalizeProjectPath(action.path)
          const normalizedDestination = action.destinationPath
            ? normalizeProjectPath(action.destinationPath)
            : undefined
          if (!normalizedPath || (action.destinationPath && !normalizedDestination)) return []
          return [
            {
              action: action.action,
              path: normalizedPath,
              ...(normalizedDestination ? { destinationPath: normalizedDestination } : {}),
              beforeHash: action.beforeHash,
              afterHash: action.afterHash,
            },
          ]
        })
      if (actions.length === 0) return
    }

    const paths = collectPaths(params.input, values)
    const counts = countSummary(values)
    const hasPositiveCount = Object.values(counts).some((count) => count > 0)
    const hasRecognizedStatus = values.some(
      (value) =>
        typeof value.status === 'string' ||
        typeof value.success === 'boolean' ||
        typeof value.passed === 'boolean' ||
        typeof value.workspaceSnapshotId === 'string' ||
        typeof value.snapshotId === 'string',
    )
    if (
      captureKind !== 'mutation' &&
      paths.length === 0 &&
      !hasPositiveCount &&
      !hasRecognizedStatus
    ) {
      return
    }
    const observedAt = this.now()
    const observationId = deriveObservationId({
      projectId: this.config.projectId,
      sessionId: runtimeState.sessionId,
      userInputId: params.userInputId,
      callId: params.callId,
      sourceIndex: 0,
    })
    const metadata: Record<string, MemoryJsonValue> = {
      callId: params.callId.slice(0, 128),
      outputDigest: digestOutput(params.output),
      captureKind,
      counts,
      ...(actions.length > 0 ? { actions } : {}),
      ...(params.workspaceState
        ? {
            workspaceRevision: params.workspaceState.revision,
            workspaceSnapshotId: params.workspaceState.snapshotId,
          }
        : {}),
    }
    const event = createMemoryEventDraft({
      projectId: this.config.projectId,
      sessionId: runtimeState.sessionId,
      userInputId: params.userInputId,
      callId: params.callId,
      occurredAt: observedAt,
      eventType: 'observation.recorded',
      payload: {
        payloadSchemaVersion: 1,
        observation: {
          observationId,
          taskId: runtimeState.activeTask.taskId,
          kind: captureKind === 'mutation' ? 'outcome' : 'discovery',
          summary: `${params.toolName.slice(0, 128)} produced structured ${captureKind} metadata`,
          detail: `Captured ${paths.length} project-relative path selector(s) and bounded structured result counts.`,
          confidence: 0.5,
          evidence: [],
          selectors: paths.map((projectPath) => ({ kind: 'file' as const, path: projectPath })),
          provenance: {
            origin: 'tool',
            recordedBy: 'sdk-memory-v2',
            sourceEventIds: [],
            sourceSessionId: runtimeState.sessionId,
            toolName: params.toolName.slice(0, 128),
            metadata,
          },
          tags: ['sdk-capture', captureKind],
          observedAt,
        },
      },
    })
    if (!this.isCurrent(preparation) || this.runtimeState !== runtimeState) return
    await this.append([event], runtimeState, preparation)

    // After the observation append, check if this is an audit coverage result
    // and emit coverage.recorded events for each covered dimension.
    if (params.toolName === 'evaluate_audit_coverage') {
      const coverageEvents = this.extractCoverageEvents({
        values,
        runtimeState,
        userInputId: params.userInputId,
        callId: params.callId,
        observedAt,
        workspaceState: params.workspaceState,
      })
      if (coverageEvents.length > 0 && this.isCurrent(preparation) && this.runtimeState === runtimeState) {
        await this.append(coverageEvents, runtimeState, preparation)
      }
    }
  }

  private extractCoverageEvents(params: {
    values: Record<string, unknown>[]
    runtimeState: { sessionId: MemorySessionId; activeTask: { taskId: TaskId } }
    userInputId: string
    callId: string
    observedAt: string
    workspaceState?: WorkspaceStateV1
  }): MemoryEventDraft[] {
    const drafts: MemoryEventDraft[] = []
    for (const value of params.values) {
      // evaluate_audit_coverage returns { status: 'complete'|'incomplete', ... }
      if (typeof value.status !== 'string') continue
      const features = Array.isArray(value.features) ? value.features : []
      // Only emit coverage for complete evaluations
      if (value.status !== 'complete' && value.status !== 'incomplete') continue
      const state = value.status === 'complete' ? 'covered' : 'partial'
      const draft = createMemoryEventDraft({
        projectId: this.config.projectId,
        sessionId: params.runtimeState.sessionId,
        userInputId: params.userInputId,
        callId: params.callId,
        occurredAt: params.observedAt,
        eventType: 'coverage.recorded',
        payload: {
          payloadSchemaVersion: 1,
          taskId: params.runtimeState.activeTask.taskId,
          dimension: 'validation' as const,
          state: state as 'covered' | 'partial',
          selectors: features
            .filter((f: unknown): f is { feature: string } =>
              typeof f === 'object' && f !== null && typeof (f as Record<string, unknown>).feature === 'string'
            )
            .slice(0, 64)
            .map((f: { feature: string }) => ({ kind: 'file' as const, path: f.feature.slice(0, 512) })),
          notes: `Audit coverage evaluation: ${value.status}. Features evaluated: ${features.length}.`.slice(0, 4_096),
          ...(params.workspaceState ? {
            workspaceRevision: params.workspaceState.revision,
            workspaceSnapshotId: params.workspaceState.snapshotId,
          } : {}),
        },
      })
      drafts.push(draft)
    }
    return drafts.slice(0, 5)
  }

  async finishTurn(params: {
    agentState: AgentState
    output: AgentOutput
    signal?: AbortSignal
  }): Promise<void> {
    return this.bestEffort(() => this.finishPreparedTurn(params))
  }

  private async finishPreparedTurn(params: {
    agentState: AgentState
    output: AgentOutput
    signal?: AbortSignal
  }): Promise<void> {
    const runtimeState = this.runtimeState
    if (
      !runtimeState ||
      (runtimeState.turn.status !== 'active' &&
        runtimeState.turn.status !== 'finishing')
    ) {
      return
    }
    const parked = this.parsePendingTerminal(runtimeState.pendingTerminal)
    const status =
      parked?.status ??
      (params.signal?.aborted === true
        ? 'cancelled'
        : params.output.type === 'error'
          ? 'failed'
          : 'completed')
    const endedAt = parked?.endedAt ?? this.now()
    const query =
      parked?.query ??
      this.queryTerminal ?? {
        outcome: 'failed' as const,
        error: 'Memory query did not produce a result',
        retryable: true,
      }
    const decision: NonNullable<MemoryRuntimeStateV2['pendingTerminal']> = {
      status,
      endedAt,
      query,
    }
    runtimeState.turn.status = 'finishing'
    runtimeState.pendingTerminal = decision
    params.agentState.memoryV2 = runtimeState

    const committed = await this.appendBounded(
      this.buildTerminalDrafts(runtimeState, decision),
      runtimeState,
    )
    if (!committed) {
      this.logger?.warn(
        {},
        'Memory V2 terminal batch was not committed; terminal status stays parked for replay',
      )
      return
    }
    runtimeState.turn.status = status
    runtimeState.activeTask.status = status
    runtimeState.pendingTerminal = undefined
    params.agentState.memoryV2 = runtimeState
  }

  private parsePendingTerminal(
    value: unknown,
  ): NonNullable<MemoryRuntimeStateV2['pendingTerminal']> | undefined {
    if (!isRecord(value)) return undefined
    if (
      value.status !== 'completed' &&
      value.status !== 'failed' &&
      value.status !== 'cancelled'
    ) return undefined
    if (typeof value.endedAt !== 'string' || Number.isNaN(Date.parse(value.endedAt))) {
      return undefined
    }
    if (!isRecord(value.query)) return undefined
    if (value.query.outcome === 'completed') {
      const counts = QueryCategoryCountsSchema.safeParse(value.query.counts)
      const degradation = QueryDegradationSummarySchema.safeParse(
        value.query.degradation,
      )
      if (!counts.success || !degradation.success) return undefined
      return {
        status: value.status,
        endedAt: value.endedAt,
        query: {
          outcome: 'completed',
          counts: counts.data,
          degradation: degradation.data,
        },
      }
    }
    if (
      value.query.outcome !== 'failed' ||
      typeof value.query.error !== 'string' ||
      value.query.error.length < 1 ||
      value.query.error.length > 1_024 ||
      typeof value.query.retryable !== 'boolean'
    ) return undefined
    return {
      status: value.status,
      endedAt: value.endedAt,
      query: {
        outcome: 'failed',
        error: value.query.error,
        retryable: value.query.retryable,
      },
    }
  }

  private buildTerminalDrafts(
    runtimeState: MemoryRuntimeStateV2,
    decision: NonNullable<MemoryRuntimeStateV2['pendingTerminal']>,
  ): MemoryEventDraft[] {
    const { status, endedAt, query } = decision
    const common = {
      projectId: this.config.projectId,
      sessionId: runtimeState.sessionId,
      userInputId: runtimeState.turn.userInputId,
      occurredAt: endedAt,
    }
    const queryEvent =
      query.outcome === 'completed'
        ? createMemoryEventDraft({
            ...common,
            sourceIndex: 0,
            eventType: 'query.completed',
            payload: {
              payloadSchemaVersion: 1,
              queryId: runtimeState.turn.queryId,
              taskId: runtimeState.activeTask.taskId,
              completedAt: endedAt,
              counts: query.counts,
              degradation: query.degradation,
            },
          })
        : createMemoryEventDraft({
            ...common,
            sourceIndex: 0,
            eventType: 'query.failed',
            payload: {
              payloadSchemaVersion: 1,
              queryId: runtimeState.turn.queryId,
              taskId: runtimeState.activeTask.taskId,
              failedAt: endedAt,
              error: query.error,
              retryable: query.retryable,
            },
          })
    return [
      queryEvent,
      createMemoryEventDraft({
        ...common,
        sourceIndex: 1,
        eventType: 'task.transitioned',
        payload: {
          payloadSchemaVersion: 1,
          taskId: runtimeState.activeTask.taskId,
          fromStatus: 'active',
          toStatus: status,
          reason: `SDK turn ${status}`,
        },
      }),
      createMemoryEventDraft({
        ...common,
        sourceIndex: 2,
        eventType: 'session.ended',
        payload: { payloadSchemaVersion: 1, status, endedAt },
      }),
    ]
  }
}
