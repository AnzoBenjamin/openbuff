import type {
  MemoryPlaybook,
  PlaybookEnforcement,
  PlaybookScope,
  PlaybookStatus,
  PlaybookTrigger,
} from '../memory-playbook'
import type { MemoryProvenance } from '../memory-v2'

/**
 * Input for {@link PlaybookStoreContract.upsertByTriggerSignature}. The
 * trigger signature is derived from `trigger` + `scope` via
 * `computeTriggerSignature`, never supplied by the caller, so dedup stays
 * consistent across writers.
 */
export interface PlaybookUpsertInput {
  workspaceId: string
  taskId?: string
  title: string
  instruction: string
  trigger: PlaybookTrigger
  scope: PlaybookScope
  status: PlaybookStatus
  enforcement: PlaybookEnforcement
  provenance: MemoryProvenance
  expiresAt?: number
}

/**
 * DI contract for the playbook (procedural memory) store. Implementations
 * live outside common and persist `MemoryPlaybook` rows keyed by
 * `triggerSignature` (the upsert/dedup key — two playbooks with the same
 * signature are the same rule).
 */
export interface PlaybookStoreContract {
  /**
   * Insert-or-update by trigger signature: an input whose
   * `computeTriggerSignature(trigger, scope)` matches an existing row updates
   * that row in place (title/instruction/status/enforcement/counters) instead
   * of inserting a duplicate.
   */
  upsertByTriggerSignature(input: PlaybookUpsertInput): Promise<MemoryPlaybook>
  /** All non-retired playbooks visible in the workspace. */
  listActive(workspaceId: string): Promise<MemoryPlaybook[]>
  /**
   * Record one gate outcome against the playbook's counters (and the matching
   * `lastFiredAt` / `lastFalsePositiveAt` timestamp when applicable).
   */
  recordGateOutcome(
    playbookId: string,
    outcome: 'blocked' | 'bypassed' | 'compliedAfterBlock' | 'falsePositive',
    atMs: number,
  ): Promise<void>
  setStatus(
    playbookId: string,
    status: 'candidate' | 'active' | 'verified' | 'retired',
  ): Promise<void>
}
