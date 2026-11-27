import type {
  ContextArchiveSnapshot,
  ContextArchiveBody,
  ContextArchiveRetentionReceipt,
} from '@codebuff/common/types/context-archive'
import type { ArchiveFlushOutcome } from '../../utils/persisted-context-archive'
import type { RunState } from '@openbuff/sdk'

import { logger } from '../../utils/logger'
import { getProjectMemoryV2Provider } from './provider'
import { getMemoryAuthoritySelection } from '../../utils/env'
import { archiveSnapshotIdentity } from './context-archive-store'

/**
 * Cross-session persistence for the compaction-fidelity context archive
 * (`agentState.compactionArchive`, the `recall_context` source).
 *
 * Two best-effort seams:
 * - {@link flushContextArchiveSnapshots} pushes the CURRENT archive into the
 *   memory-v2 store whenever chat state is saved (fire-and-forget from
 *   saveChatState in cli/src/utils/run-state-storage.ts).
 * - {@link hydrateContextArchiveSnapshots} merges durable snapshots back into
 *   a restored session's archive so `recall_context` keeps working across
 *   sessions (wired at the loadMostRecentChatState restore seam in
 *   cli/src/hooks/use-send-message.ts).
 *
 * The memory-v2 repository exposes the context-archive surface as OPTIONAL
 * methods (the SDK's "callers must narrow" contract, like getStoreStats), so
 * every helper narrows before use and degrades to a log when the surface,
 * the provider, or storage is unavailable. Nothing here may throw into its
 * caller: chat-state persistence and session restore must never break
 * because of archive sync.
 */

/**
 * Mirror of the runtime's per-kind archive caps in
 * packages/agent-runtime/src/util/context-archive.ts (MAX_ARCHIVE_SNAPSHOTS
 * and MAX_EVICTION_ARCHIVE_SNAPSHOTS). The runtime is deliberately
 * dependency-free and does not export into the CLI, so the constants are
 * re-declared here with this pointer comment; drift would show up as the
 * store holding more snapshots than the runtime archive can carry.
 */
const MAX_ARCHIVE_SNAPSHOTS = 8
const MAX_EVICTION_ARCHIVE_SNAPSHOTS = 16

/**
 * Durable snapshots fetched per hydration, newest-first. 24 = the total of
 * the per-kind caps above (8 semantic/mechanical + 16 eviction), so one load
 * can fill every remaining slot.
 */
const HYDRATION_SNAPSHOT_LIMIT = 24

/** Narrowed shape of the repository's optional context-archive persist. */
type PersistContextArchiveSnapshots = (request: {
  runId: string
  snapshots: ContextArchiveSnapshot[]
  bodies?: Record<string, ContextArchiveBody>
}) => Promise<{
  persisted: number
  skipped: number
  status?: 'ok' | 'degraded' | 'unavailable'
  reasons?: string[]
  retention?: ContextArchiveRetentionReceipt
}>

/** Narrowed shape of the repository's optional context-archive load. */
type LoadContextArchiveSnapshots = (request: {
  runId?: string
  limit?: number
}) => Promise<{
  snapshots: ContextArchiveSnapshot[]
  status?: 'ok' | 'degraded' | 'unavailable'
  reasons?: string[]
}>

/**
 * Narrow an optional repository method before use (SDK contract: callers
 * must narrow). Returns undefined when the repository is not an object or
 * does not expose the named function. The extracted function is BOUND to
 * the repository before being returned: prototype methods such as
 * BunSQLiteMemoryRepository.persistContextArchiveSnapshots and
 * loadContextArchiveSnapshots read `this.requireOpen()`/`this.database`, so
 * a detached call would throw inside the caller's try/catch and every real
 * flush/hydration would silently degrade to a warn log.
 */
const optionalMethod = <F>(repository: unknown, key: string): F | undefined => {
  if (typeof repository !== 'object' || repository === null) return undefined
  const candidate = (repository as Record<string, unknown>)[key]
  if (typeof candidate !== 'function') return undefined
  // Double cast through unknown: a bound function type never sufficiently
  // overlaps a generic type parameter for a direct `as F` conversion.
  return (candidate as (this: unknown, ...args: unknown[]) => unknown).bind(
    repository,
  ) as unknown as F
}

/**
 * Call the repository's optional `persistContextArchiveSnapshots` after
 * narrowing. Best-effort: returns null (after a log) when the method is
 * absent or the call fails — never throws.
 */
export async function persistContextArchiveSnapshotsToRepository(
  repository: unknown,
  request: {
    runId: string
    snapshots: ContextArchiveSnapshot[]
    bodies?: Record<string, ContextArchiveBody>
  },
): Promise<{
  persisted: number
  skipped: number
  status?: 'ok' | 'degraded' | 'unavailable'
  reasons?: string[]
  retention?: ContextArchiveRetentionReceipt
} | null> {
  const persist = optionalMethod<PersistContextArchiveSnapshots>(
    repository,
    'persistContextArchiveSnapshots',
  )
  if (!persist) {
    logger.debug(
      { runId: request.runId, snapshotCount: request.snapshots.length },
      '[context-archive] Repository has no context-archive persist surface; skipping flush',
    )
    return null
  }
  try {
    const outcome = await persist(request)
    if (outcome.status === 'degraded' || outcome.status === 'unavailable')
      logger.warn(
        {
          runId: request.runId,
          status: outcome.status,
          reasons: outcome.reasons,
        },
        '[context-archive] Durable archive persistence is degraded',
      )
    return outcome
  } catch (error) {
    logger.warn(
      {
        runId: request.runId,
        error: error instanceof Error ? error.message : String(error),
      },
      '[context-archive] Context archive persist failed (non-fatal)',
    )
    return null
  }
}

/**
 * Call the repository's optional `loadContextArchiveSnapshots` after
 * narrowing. Best-effort: returns null (after a log) when the method is
 * absent or the call fails — never throws.
 */
export async function loadContextArchiveSnapshotsFromRepository(
  repository: unknown,
  request: { runId?: string; limit?: number },
): Promise<ContextArchiveSnapshot[] | null> {
  const load = optionalMethod<LoadContextArchiveSnapshots>(
    repository,
    'loadContextArchiveSnapshots',
  )
  if (!load) {
    logger.debug(
      {},
      '[context-archive] Repository has no context-archive load surface; skipping hydration',
    )
    return null
  }
  try {
    const loaded = await load(request)
    if (loaded?.status === 'unavailable') {
      logger.warn(
        { reasons: loaded.reasons },
        '[context-archive] Durable archive storage is unavailable',
      )
      return null
    }
    if (loaded?.status === 'degraded')
      logger.warn(
        { reasons: loaded.reasons },
        '[context-archive] Durable archive hydration is partial',
      )
    return Array.isArray(loaded?.snapshots) ? loaded.snapshots : []
  } catch (error) {
    logger.warn(
      { error: error instanceof Error ? error.message : String(error) },
      '[context-archive] Context archive load failed (non-fatal)',
    )
    return null
  }
}

/**
 * Flush the run's current context archive into the memory-v2 store. The
 * repository incrementally reconciles ordered snapshots per source run, so
 * the whole current archive is sent with its original run provenance.
 * Best-effort and never throws: a missing runId, an
 * empty/absent archive, or an unavailable provider/repository all degrade to
 * a debug log. Fire-and-forget from the sync saveChatState path — never
 * awaited there.
 */
export async function flushContextArchiveSnapshots(
  runState: RunState,
  owner?: {
    root: string
    authority: ReturnType<typeof getMemoryAuthoritySelection>
  },
): Promise<ArchiveFlushOutcome | undefined> {
  const mainAgentState = runState.sessionState?.mainAgentState
  const runId = mainAgentState?.runId
  const archive = mainAgentState?.compactionArchive
  if (!runId) {
    logger.debug({}, '[context-archive] Flush skipped: session has no runId')
    return
  }
  if (!Array.isArray(archive) || archive.length === 0) {
    logger.debug(
      { runId },
      '[context-archive] Flush skipped: compaction archive is empty',
    )
    return
  }
  try {
    const providerResult = await getProjectMemoryV2Provider(
      owner?.root,
      owner?.authority,
    )
    if (providerResult.status !== 'available') {
      logger.debug(
        { degradation: providerResult.degradation },
        '[context-archive] Flush skipped: memory-v2 unavailable',
      )
      return
    }
    try {
      const outcome = await persistContextArchiveSnapshotsToRepository(
        providerResult.repository,
        {
          runId,
          bodies: mainAgentState.contextArchiveBodies,
          snapshots: archive.map((snapshot) => ({
            ...snapshot,
            runId: snapshot.runId ?? runId,
          })),
        },
      )
      if (outcome) {
        logger.debug(
          {
            runId,
            snapshotCount: archive.length,
            persisted: outcome.persisted,
            skipped: outcome.skipped,
            status: outcome.status,
            reasons: outcome.reasons,
          },
          '[context-archive] Flushed context archive snapshots to memory-v2',
        )
        return outcome
      }
    } finally {
      await providerResult.release().catch((error) => {
        logger.debug(
          { error: error instanceof Error ? error.message : String(error) },
          '[context-archive] Provider lease release failed (non-fatal)',
        )
      })
    }
  } catch (error) {
    logger.warn(
      { runId, error: error instanceof Error ? error.message : String(error) },
      '[context-archive] Context archive flush failed (non-fatal)',
    )
  }
  return undefined
}

/**
 * Merge durable context-archive snapshots from the memory-v2 store into the
 * restored session's in-memory archive so `recall_context` covers prior
 * sessions. Best-effort and never throws: provider/storage failures degrade
 * to an empty durable set, so the in-memory archive is returned unchanged
 * (modulo the merge's identity pass).
 */
export async function hydrateContextArchiveSnapshots(
  inMemory: ContextArchiveSnapshot[] | undefined,
  options?: { includeProjectArchive?: boolean },
): Promise<ContextArchiveSnapshot[]> {
  if (options?.includeProjectArchive === false)
    return mergeContextArchives(inMemory, [])
  let durable: ContextArchiveSnapshot[] = []
  let release: (() => Promise<void>) | undefined
  try {
    const providerResult = await getProjectMemoryV2Provider()
    if (providerResult.status !== 'available') {
      logger.debug(
        { degradation: providerResult.degradation },
        '[context-archive] Hydration skipped: memory-v2 unavailable',
      )
    } else {
      release = providerResult.release
      const snapshots = await loadContextArchiveSnapshotsFromRepository(
        providerResult.repository,
        { limit: HYDRATION_SNAPSHOT_LIMIT },
      )
      if (snapshots) {
        durable = snapshots
        logger.debug(
          { durableCount: durable.length },
          '[context-archive] Loaded durable context archive snapshots for hydration',
        )
      }
    }
  } catch (error) {
    logger.warn(
      { error: error instanceof Error ? error.message : String(error) },
      '[context-archive] Context archive hydration failed (non-fatal)',
    )
  } finally {
    await release?.().catch((error) => {
      logger.debug(
        { error: error instanceof Error ? error.message : String(error) },
        '[context-archive] Provider lease release failed (non-fatal)',
      )
    })
  }
  return mergeContextArchives(inMemory, durable)
}

/**
 * Pure merge of the in-memory archive with durable snapshots (no I/O; unit
 * tested directly).
 *
 * - Identity covers the source run, timestamp, action and full ordered
 *   manifest. Different actions or content at the same timestamp remain
 *   independent. Legacy unnamed snapshots bind only to one matching source
 *   run; ambiguous source runs remain distinct.
 * - In-memory entries win on duplicate identity.
 * - Durable entries then fill the remaining per-kind cap slots in the
 *   store's newest-first order: semantic/mechanical snapshots share
 *   MAX_ARCHIVE_SNAPSHOTS and eviction snapshots have their own dedicated
 *   MAX_EVICTION_ARCHIVE_SNAPSHOTS (see
 *   packages/agent-runtime/src/util/context-archive.ts). In-memory entries
 *   are never dropped, even if the live archive already sits at/over a cap.
 * - The RESULT follows the runtime archive array convention: chronological
 *   oldest-first by archivedAt (recallFromArchiveIndexed derives
 *   newest-first via row_index DESC over array order, and archivedAt via
 *   [...archive].reverse()), so hydrated durable snapshots interleave
 *   chronologically with the in-memory archive and later appends land after
 *   older durable snapshots.
 */
export function mergeContextArchives(
  inMemory: ContextArchiveSnapshot[] | undefined,
  durable: ContextArchiveSnapshot[],
): ContextArchiveSnapshot[] {
  const identityOf = (snapshot: ContextArchiveSnapshot): string => {
    return (
      archiveSnapshotIdentity(snapshot) ??
      `${snapshot.runId ?? ''}\u0000${snapshot.archivedAt}\u0000${snapshot.action}`
    )
  }
  const isEviction = (action: ContextArchiveSnapshot['action']): boolean =>
    action === 'tool_result_eviction'

  const merged: ContextArchiveSnapshot[] = []
  const seenIdentities = new Set<string>()
  const kindCounts = { semanticOrMechanical: 0, eviction: 0 }
  const baseOf = (snapshot: ContextArchiveSnapshot) =>
    archiveSnapshotIdentity(snapshot, '') ??
    `${snapshot.archivedAt}\u0000${snapshot.action}`
  const sourceRunsByBase = new Map<string, Set<string>>()
  for (const snapshot of durable) {
    if (snapshot.runId) {
      const runs = sourceRunsByBase.get(baseOf(snapshot)) ?? new Set<string>()
      runs.add(snapshot.runId)
      sourceRunsByBase.set(baseOf(snapshot), runs)
    }
  }

  for (const snapshot of inMemory ?? []) {
    const knownRuns = sourceRunsByBase.get(baseOf(snapshot))
    // Legacy snapshots lack source run identity. Bind only an unambiguous
    // restore match, preserving distinct runs at equal transcript timestamps.
    const admitted =
      !snapshot.runId && knownRuns?.size === 1
        ? { ...snapshot, runId: [...knownRuns][0] }
        : snapshot
    merged.push(admitted)
    seenIdentities.add(identityOf(admitted))
    if (isEviction(snapshot.action)) kindCounts.eviction += 1
    else kindCounts.semanticOrMechanical += 1
  }

  // Load results arrive newest-first, so filling in array order prefers the
  // newest durable snapshots for the remaining per-kind cap slots.
  for (const snapshot of durable) {
    const identity = identityOf(snapshot)
    if (seenIdentities.has(identity)) continue
    const cap = isEviction(snapshot.action)
      ? MAX_EVICTION_ARCHIVE_SNAPSHOTS
      : MAX_ARCHIVE_SNAPSHOTS
    const kindCount = isEviction(snapshot.action)
      ? kindCounts.eviction
      : kindCounts.semanticOrMechanical
    if (kindCount >= cap) continue
    seenIdentities.add(identity)
    merged.push(snapshot)
    if (isEviction(snapshot.action)) kindCounts.eviction += 1
    else kindCounts.semanticOrMechanical += 1
  }
  // Hydration must observe the runtime archive array convention:
  // chronological oldest-first by archivedAt. Recall derives newest-first
  // via row_index DESC over array order (and archivedAt via
  // [...archive].reverse()), so a newest-first hydrated array would invert
  // recall ordering and the archivedAt provenance list, and later appends
  // would land after older durable snapshots. The store's newest-first load
  // order governs WHICH snapshots fill the remaining cap slots; the final
  // array order is chronological. Stable sort: in-memory entries stay ahead
  // of durable entries at an equal archivedAt.
  return merged.sort((left, right) => left.archivedAt - right.archivedAt)
}
