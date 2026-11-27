import type {
  MemoryPlaybook,
  PlaybookEnforcement,
  PlaybookGateOutcome,
  PlaybookScope,
  PlaybookStatus,
  PlaybookTrigger,
} from '../memory-playbook'
import type { MemoryProvenance } from '../memory-v2'

/**
 * Input for {@link PlaybookStoreContract.upsertPlaybookByTriggerSignature}.
 * The trigger signature is derived from `trigger` + `scope` via
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
 * DI contract for the playbook (procedural memory) store. Declared verbatim
 * from the one shipped persistence surface — the SQLite driver
 * `BunSQLiteMemoryRepository`
 * (cli/src/services/memory-v2/bun-sqlite-memory-repository.ts) implements this
 * contract, and the coordinator-facing `listPlaybooks` /
 * `recordPlaybookGateOutcome` members of `MemoryRepositoryV2`
 * (sdk/src/services/memory-v2/types.ts) reuse the same names and signatures —
 * so the contract and the driver cannot drift apart again. Implementations
 * persist `MemoryPlaybook` rows keyed by `triggerSignature` (the upsert/dedup
 * key — two playbooks with the same signature are the same rule).
 */
export interface PlaybookStoreContract {
  /**
   * Insert-or-update by trigger signature: an input whose
   * `computeTriggerSignature(trigger, scope)` matches an existing row updates
   * that row in place (title/instruction/status/enforcement) while preserving
   * its playbookId, createdAt and counters, instead of inserting a duplicate.
   */
  upsertPlaybookByTriggerSignature(
    input: PlaybookUpsertInput,
  ): Promise<MemoryPlaybook>
  /**
   * Active, unexpired playbooks visible in the workspace — the runtime
   * playbook gate's per-turn input.
   */
  listPlaybooks(workspaceId: string): Promise<MemoryPlaybook[]>
  /**
   * Fold one gate outcome into the playbook's counters (and the matching
   * `lastFiredAt` / `lastFalsePositiveAt` timestamp when applicable). The
   * store stamps the fold time itself, so there is no timestamp parameter:
   * producers report only the outcome.
   */
  recordPlaybookGateOutcome(
    playbookId: string,
    outcome: PlaybookGateOutcome,
  ): Promise<void>
  /** Change a playbook's lifecycle status (e.g. retire a noisy rule). */
  setPlaybookStatus(playbookId: string, status: PlaybookStatus): Promise<void>
}
