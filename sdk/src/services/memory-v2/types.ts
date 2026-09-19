import {
  MemoryAuthorityModeSchema,
  type MemoryAppendOutcome,
  type MemoryAppendRequest,
  type MemoryAuthorityMode,
  type MemoryEventDraft,
  type MemoryEventId,
  type MemoryExportOutcome,
  type MemoryExportRequest,
  type MemoryHealth,
  type MemoryHealthRequest,
  type MemoryQueryOutcome,
  type ProjectId,
  type MemoryRebuildOutcome,
  type MemoryRebuildRequest,
  type MemoryRetrievalRequest,
  type MemoryVerifyOutcome,
  type MemoryVerifyRequest,
} from '@codebuff/common/types/memory-v2'

export type { MemoryAuthorityMode }

export interface MemoryV2ClientConfig {
  /**
   * Storage boundary for Memory V2. Optional so wiring that could not open a
   * repository still runs under a V2 authority: the coordinator then emits
   * the S4 degraded state (authority stays active, nothing is injected)
   * instead of silently falling back to V1.
   */
  repository?: MemoryRepositoryV2
  projectId: ProjectId
  /** Explicit authority selection. Takes precedence over the legacy mode. */
  authority?: MemoryAuthorityMode
  /** @deprecated Use authority. shadow maps to shadow-v2; inject maps to sqlite-v2-opt-in. */
  mode?: 'shadow' | 'inject'
  capture: 'off' | 'safe'
}

/**
 * Effective authority selection with runtime validation. JavaScript callers
 * can pass any value for `authority`, so it is validated against the
 * canonical schema: an invalid runtime value selects json-v1 with
 * `invalidAuthority` set so the coordinator can report reason
 * 'invalid-authority' and keep any V2 context clear instead of trusting
 * unvalidated input.
 */
export function getEffectiveMemoryAuthority(
  config: Pick<MemoryV2ClientConfig, 'authority' | 'mode'>,
): { requested: MemoryAuthorityMode; invalidAuthority: boolean } {
  if (config.authority !== undefined) {
    const parsed = MemoryAuthorityModeSchema.safeParse(config.authority)
    if (!parsed.success) {
      return { requested: 'json-v1', invalidAuthority: true }
    }
    return { requested: parsed.data, invalidAuthority: false }
  }
  return {
    requested: config.mode === 'inject' ? 'sqlite-v2-opt-in' : 'shadow-v2',
    invalidAuthority: false,
  }
}

/**
 * Runtime-neutral persistence boundary for Memory V2.
 *
 * Implementations own storage and concurrency. Append inputs are event drafts;
 * implementations assign sequences and expose committed event envelopes. All
 * inputs and outputs are bounded, schema-validated JSON DTOs and intentionally
 * expose no database or runtime driver types.
 */
export interface MemoryStoreStats {
  eventCount: number
  bytes: number
}

export interface PrivilegedCompactionInput {
  projectId: ProjectId
  eventIds: MemoryEventId[]
  archiveClaimDraft: MemoryEventDraft
  archiveLines: string[]
  archivePath: string
  archiveHash: string
}

export interface PrivilegedCompactionResult {
  archivedEventIds: MemoryEventId[]
  beforeCount: number
  afterCount: number
  beforeBytes: number
  afterBytes: number
}

export interface GcCandidateSelection {
  eventIds: MemoryEventId[]
}

/** One bounded per-observation usage-projection entry (P4 usage correlation). */
export interface MemoryUsageEntry {
  observationId: string
  usedCount: number
  ignoredCount: number
  staledCount: number
  /** Last reuse mechanism observed for the observation, or null when unset. */
  lastMechanism: string | null
  lastTurnId: string | null
  lastSequence: number
}

export interface MemoryUsageReadRequest {
  projectId: ProjectId
  /**
   * Optional bounded filter; implementations cap the filter (64 ids) and the
   * returned rows (256), so callers must not rely on full enumeration.
   */
  observationIds?: string[]
}

/**
 * Runtime-neutral usage-projection read outcome. The error branch keeps the
 * driver's failure classification as an opaque bounded string so the boundary
 * stays free of runtime or storage driver types.
 */
export type MemoryUsageReadOutcome =
  | { status: 'ok'; usage: MemoryUsageEntry[] }
  | {
      status: 'error'
      error: { kind: string; message: string; retryable: boolean }
    }

/** One bounded claim-dedup projection entry (P7 claim identity). */
export interface MemoryClaimDedupEntry {
  claimId: string
  observationId: string
}

export interface MemoryClaimDedupReadRequest {
  projectId: ProjectId
  /** Optional bounded filter; implementations cap the filter (64 ids) and the returned rows (256). */
  claimIds?: string[]
}

/**
 * Runtime-neutral claim-dedup projection read outcome. The error branch keeps
 * the driver's failure classification as an opaque bounded string so the
 * boundary stays free of runtime or storage driver types.
 */
export type MemoryClaimDedupReadOutcome =
  | { status: 'ok'; entries: MemoryClaimDedupEntry[] }
  | {
      status: 'error'
      error: { kind: string; message: string; retryable: boolean }
    }

/** One bounded observation lifecycle-status entry (P7 supersede safety). */
export interface MemoryObservationStatusEntry {
  observationId: string
  taskId: string
  /**
   * 'unknown' is the fail-closed branch: a row whose projection state is
   * unreadable or malformed cannot be proven active, so supersession-safety
   * callers (which accept only 'active' targets) must treat it as ineligible.
   */
  status: 'active' | 'retracted' | 'unknown'
}

export interface MemoryObservationStatusReadRequest {
  projectId: ProjectId
  /** Optional bounded filter; implementations cap the filter (64 ids) and the returned rows (256). */
  observationIds: string[]
}

/**
 * Runtime-neutral observation lifecycle-status read outcome. The error branch
 * keeps the driver's failure classification as an opaque bounded string so the
 * boundary stays free of runtime or storage driver types.
 */
export type MemoryObservationStatusReadOutcome =
  | { status: 'ok'; entries: MemoryObservationStatusEntry[] }
  | {
      status: 'error'
      error: { kind: string; message: string; retryable: boolean }
    }

/**
 * Runtime-neutral persistence boundary for Memory V2.
 *
 * Implementations own storage and concurrency. Append inputs are event drafts;
 * implementations assign sequences and expose committed event envelopes. All
 * inputs and outputs are bounded, schema-validated JSON DTOs and intentionally
 * expose no database or runtime driver types.
 */
export interface MemoryRepositoryV2 {
  append(request: MemoryAppendRequest): Promise<MemoryAppendOutcome>
  query(request: MemoryRetrievalRequest): Promise<MemoryQueryOutcome>
  verify(request: MemoryVerifyRequest): Promise<MemoryVerifyOutcome>
  rebuild(request: MemoryRebuildRequest): Promise<MemoryRebuildOutcome>
  health(request: MemoryHealthRequest): Promise<MemoryHealth>
  export(request: MemoryExportRequest): Promise<MemoryExportOutcome>
  /**
   * Optional bounded read of the usage projection (P4). Absent on fakes that
   * do not track reuse; callers must narrow before use (see getStoreStats).
   */
  getUsage?(params: MemoryUsageReadRequest): Promise<MemoryUsageReadOutcome>
  /**
   * Optional bounded read of the claim-dedup projection (P7). Absent on fakes
   * that do not track claim identity; callers must narrow before use.
   */
  getClaimDedup?(
    params: MemoryClaimDedupReadRequest,
  ): Promise<MemoryClaimDedupReadOutcome>
  /**
   * Optional bounded read of observation lifecycle status (P7). Absent on
   * fakes that do not track observations; callers must narrow before use.
   */
  getObservationStatus?(
    params: MemoryObservationStatusReadRequest,
  ): Promise<MemoryObservationStatusReadOutcome>
  /** Optional privileged GC surface. Absent on fakes; fail-closed when missing. */
  getStoreStats?(request: { projectId: ProjectId }): Promise<MemoryStoreStats>
  selectGCandidates?(request: {
    projectId: ProjectId
    olderThanDays: number
    maxEvents: number
  }): Promise<GcCandidateSelection>
  privilegedCompact?(
    input: PrivilegedCompactionInput,
  ): Promise<PrivilegedCompactionResult>
  /** Alias some drivers expose for GC inspection. */
  inspectForGC?(request: {
    projectId: ProjectId
    olderThanDays: number
    maxEvents: number
  }): Promise<GcCandidateSelection>
}
