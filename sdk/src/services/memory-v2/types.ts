import {
  MemoryAuthorityModeSchema,
  type MemoryAppendOutcome,
  type MemoryAppendRequest,
  type MemoryAuthorityMode,
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
export interface MemoryRepositoryV2 {
  append(request: MemoryAppendRequest): Promise<MemoryAppendOutcome>
  query(request: MemoryRetrievalRequest): Promise<MemoryQueryOutcome>
  verify(request: MemoryVerifyRequest): Promise<MemoryVerifyOutcome>
  rebuild(request: MemoryRebuildRequest): Promise<MemoryRebuildOutcome>
  health(request: MemoryHealthRequest): Promise<MemoryHealth>
  export(request: MemoryExportRequest): Promise<MemoryExportOutcome>
}
