import type { AgentRuntimeDeps } from '@codebuff/common/types/contracts/agent-runtime'
import type { ExecutionActor } from '@codebuff/common/types/contracts/client'
import {
  isContextArchiveBodyPageOutcome,
  CONTEXT_ARCHIVE_MAX_PAGE_BYTES,
  CONTEXT_ARCHIVE_PAGE_BYTES,
} from '@codebuff/common/util/context-archive-body'
import type { MemoryRepositoryV2 } from './memory-v2/types'

/** The host owns storage/project/authority; model input chooses only a bounded source selector. */
export function buildContextArchiveBodyReader(params: {
  repository?: Pick<MemoryRepositoryV2, 'readContextArchiveBodyPage'>
  registeredActor: (
    actor: ExecutionActor,
  ) =>
    | Readonly<{
        actor: ExecutionActor
        userInputId?: string
        strictProjectReads?: boolean
      }>
    | undefined
  allowProjectArchive: boolean
  signal?: AbortSignal
}): NonNullable<AgentRuntimeDeps['readContextArchiveBodyPage']> {
  return async (request) => {
    const unavailable = (reason: string) => ({
      status: 'unavailable' as const,
      reason,
    })
    const registered = request?.actor && params.registeredActor(request.actor)
    if (
      !registered ||
      registered.actor.runId !== request.actor.runId ||
      registered.actor.rootRunId !== request.actor.rootRunId ||
      registered.actor.agentId !== request.actor.agentId ||
      !registered.userInputId ||
      registered.userInputId !== request.userInputId
    )
      return unavailable(
        'Archive recall requires its registered actor/task identity.',
      )
    if (registered.strictProjectReads)
      return unavailable(
        'Strict project readers have no guarded canonical archive contract.',
      )
    if (!params.allowProjectArchive)
      return {
        status: 'missing',
        reason:
          'Project-wide archive recall is disabled for this edited conversation branch.',
      }
    if (params.signal?.aborted)
      return unavailable('Archive recall was cancelled before storage entry.')
    const read = params.repository?.readContextArchiveBodyPage
    if (!read)
      return unavailable(
        'The selected host repository has no original-body paging surface.',
      )
    const maxBytes = request.maxBytes ?? CONTEXT_ARCHIVE_PAGE_BYTES,
      offsetBytes = request.offsetBytes ?? 0
    if (
      typeof request.toolCallId !== 'string' ||
      !request.toolCallId ||
      request.toolCallId.length > 2048 ||
      (request.sourceRunId !== undefined &&
        (typeof request.sourceRunId !== 'string' ||
          !request.sourceRunId ||
          request.sourceRunId.length > 2048)) ||
      (request.expectedSha256 !== undefined &&
        !/^[a-f0-9]{64}$/.test(request.expectedSha256)) ||
      !Number.isSafeInteger(maxBytes) ||
      maxBytes < 1 ||
      maxBytes > CONTEXT_ARCHIVE_MAX_PAGE_BYTES ||
      !Number.isSafeInteger(offsetBytes) ||
      offsetBytes < 0
    )
      return {
        status: 'invalid-cursor',
        reason: 'The archive selector or byte page is invalid.',
      }
    // Explicit allowlist: host identity, arbitrary paths and peer policy never enter the storage request.
    const selector = {
      toolCallId: request.toolCallId,
      sourceRunId: request.sourceRunId,
      expectedSha256: request.expectedSha256,
      offsetBytes,
      maxBytes,
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const outcome = await Promise.race([
        read.call(params.repository, selector),
        new Promise<ReturnType<typeof unavailable>>((resolve) => {
          timer = setTimeout(
            () =>
              resolve(
                unavailable(
                  'Archive paging exceeded its bounded metadata wait.',
                ),
              ),
            3000,
          )
        }),
      ])
      if (!isContextArchiveBodyPageOutcome(outcome))
        return {
          status: 'corrupt',
          reason: 'The host archive returned an invalid page.',
        }
      if (
        outcome.status === 'ok' &&
        (outcome.toolCallId !== selector.toolCallId ||
          (selector.sourceRunId !== undefined &&
            outcome.runId !== selector.sourceRunId) ||
          (selector.expectedSha256 !== undefined &&
            outcome.sha256 !== selector.expectedSha256) ||
          outcome.startByte !== offsetBytes ||
          outcome.endByte - outcome.startByte > maxBytes)
      )
        return {
          status: 'corrupt',
          reason:
            'The host archive page does not match the exact requested source/hash/range.',
        }
      if (params.signal?.aborted)
        return unavailable(
          'Archive recall was cancelled before result delivery.',
        )
      return outcome
    } catch {
      return unavailable(
        'Original-body storage is unavailable; no original was inferred from an excerpt.',
      )
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }
}

/** Text recall uses the same private actor boundary and never turns a keyword hit into original/full authority. */
export function buildContextArchiveSearchReader(
  params: Omit<
    Parameters<typeof buildContextArchiveBodyReader>[0],
    'repository'
  > & {
    repository?: Pick<MemoryRepositoryV2, 'searchContextArchive'>
  },
): NonNullable<AgentRuntimeDeps['searchContextArchive']> {
  return async (request) => {
    const unavailable = (reason: string) => ({
      status: 'unavailable' as const,
      reasons: [reason],
      matches: [],
      snapshotsSearched: 0,
    })
    const registered = request?.actor && params.registeredActor(request.actor)
    if (
      !registered ||
      registered.actor.runId !== request.actor.runId ||
      registered.actor.rootRunId !== request.actor.rootRunId ||
      registered.actor.agentId !== request.actor.agentId ||
      !registered.userInputId ||
      registered.userInputId !== request.userInputId ||
      registered.strictProjectReads ||
      !params.allowProjectArchive ||
      params.signal?.aborted
    )
      return unavailable(
        'Archive search is unavailable for this actor/task/branch read boundary.',
      )
    const search = params.repository?.searchContextArchive,
      limit = request.limit ?? 6
    if (!search)
      return unavailable(
        'The selected repository has no durable archive search.',
      )
    if (
      typeof request.query !== 'string' ||
      !request.query.trim() ||
      request.query.length > 512 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 6
    )
      return unavailable('Invalid bounded archive search selector.')
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const outcome = await Promise.race([
        search.call(params.repository, { query: request.query, limit }),
        new Promise<ReturnType<typeof unavailable>>((resolve) => {
          timer = setTimeout(
            () =>
              resolve(
                unavailable('Archive search exceeded its metadata wait.'),
              ),
            3000,
          )
        }),
      ])
      if (
        !outcome ||
        !Array.isArray(outcome.matches) ||
        outcome.matches.length > limit ||
        !Number.isSafeInteger(outcome.snapshotsSearched) ||
        outcome.snapshotsSearched < 0 ||
        outcome.matches.some(
          (match) =>
            ![match.runId, match.toolName, match.toolCallId].every(
              (value) =>
                typeof value === 'string' &&
                value.length > 0 &&
                value.length <= 2048,
            ) ||
            !Number.isSafeInteger(match.step) ||
            match.step < 0 ||
            !Number.isFinite(match.archivedAt) ||
            typeof match.snippet !== 'string' ||
            match.snippet.length > 600 ||
            (match.body &&
              (!/^[a-f0-9]{64}$/.test(match.body.sha256) ||
                match.body.bodyId !== `sha256:${match.body.sha256}` ||
                !Number.isSafeInteger(match.body.utf8Bytes) ||
                match.body.utf8Bytes < 0)),
        )
      )
        return unavailable('The archive returned an invalid search page.')
      if (params.signal?.aborted)
        return unavailable('Archive search was cancelled before delivery.')
      return {
        status: outcome.status ?? 'ok',
        reasons: outcome.reasons?.slice(0, 8),
        snapshotsSearched: outcome.snapshotsSearched,
        retention: 'retention' in outcome ? outcome.retention : undefined,
        matches: outcome.matches.map((match) => ({
          runId: match.runId,
          archivedAt: match.archivedAt,
          step: match.step,
          toolName: match.toolName,
          toolCallId: match.toolCallId,
          snippet: match.snippet,
          body: match.body
            ? {
                bodyId: match.body.bodyId,
                sha256: match.body.sha256,
                utf8Bytes: match.body.utf8Bytes,
              }
            : undefined,
        })),
      }
    } catch {
      return unavailable('Durable archive search failed.')
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }
}
