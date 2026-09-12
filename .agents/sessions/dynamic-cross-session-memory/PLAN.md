# PLAN — Dynamic Cross-Session Memory V2 Repair

Session: `dynamic-cross-session-memory`
Status: ready for implementation

<!-- current-task: MEM2-R3-T1 Repair SDK migration/operator atomicity and trust boundaries -->

## Execution rules

- Resume from the current dirty worktree; preserve unrelated changes.
- The controlling next action is the SDK migration/operator repair. Do not restart completed discovery.
- Run the narrow validation listed for each task before moving on.
- Shared contract changes invalidate downstream evidence; rerun affected SDK/CLI suites after any common schema change.
- Update `STATUS.md` at each checkpoint/blocker/resolution and append durable gotchas to `LESSONS.md`.
- A reviewer crash, quota error, or attestation failure is not approval.
- No dependency additions, commit, push, release, or deployment without separate authorization.

## Phase R3 — SDK migration/operator repair

- [ ] MEM2-R3-T1 Repair SDK migration/operator atomicity and trust boundaries
  - Acceptance: V1 revision ownership is reserved atomically before body pages; competing checksums cannot both append bodies; newer revisions supersede older imported observations; source counts/truncation are deterministic; imported verification lifecycle is stripped; mutation requests require task scope; export redacts sensitive key variants and secret patterns; import enforces depth/byte limits; every page, including an empty initial tail, is CAS-guarded; admitted prefixes resume and divergence rejects.
  - Validate: `bun --cwd=sdk run typecheck && bun --cwd=sdk test src/services/memory-v2/__tests__/v1-migration.test.ts src/services/memory-v2/__tests__/operator-service.test.ts src/services/memory-v2/__tests__/coordinator.test.ts`

## Phase R1 — SQLite kernel and storage security

- [ ] MEM2-R1-T1 Restore and strengthen the focused SQLite suite
  - Depends on: MEM2-R3-T1
  - Replace invalid `sha256:observed` fixtures with valid digests; do not weaken the schema.
  - Skip unsupported low-level event families during public query while rejecting malformed recognized canonical events.
  - Complete project binding, pre-materialization byte budgets, exact-replay CAS, distinct failure preflight, canonical projectors, V1→V2 backfill, digest/workspace freshness, and permission/sidecar coverage.
  - Acceptance: the current 20-pass/4-fail baseline becomes fully green; append and rebuild projections are normalized-equivalent; foreign/unbound stores cannot be queried/exported/rebuilt; stale evidence never enters verified knowledge; corrupt/incompatible/busy/I/O states remain distinct.
  - Validate: `bun --cwd=cli run typecheck && bun --cwd=cli test src/services/memory-v2/__tests__/bun-sqlite-memory-repository.test.ts`

- [ ] MEM2-R1-T2 Resolve race-resistant SQLite open support
  - Depends on: MEM2-R1-T1
  - Prove a descriptor-relative/no-follow/beneath primitive for database and WAL/SHM creation/open, or return typed unsupported and keep opt-in fail-closed on platforms where it cannot be guaranteed.
  - Acceptance: supported platforms have deterministic ancestor/leaf replacement tests; unsupported platforms perform no SQLite mutation and report a typed visible outcome.
  - Validate: focused storage security tests plus compiled SQLite open/write/close/reopen/read probe.

## Phase R2 — SDK run/coordinator reliability

- [ ] MEM2-R2-T1 Close coordinator cursor, correlation, CAS, terminal replay, and cancellation edges
  - Depends on: MEM2-R3-T1
  - Distinguish empty tail from tail-derivation failure; never retry without CAS.
  - Verify imported/no-op cursor refresh before lifecycle append and both project/query correlation.
  - Replay persisted `finishing + pendingTerminal` in a new coordinator before starting a new turn.
  - Cooperatively cancel preparation or generation-guard against late mutation after timeout/abort.
  - Acceptance: no append retry drops CAS; mismatched results are never installed; terminal replay commits exactly once across restart; abandoned preparation cannot mutate state or start a model call.
  - Validate: SDK coordinator and targeted run cancellation/timeout tests plus SDK typecheck.

## Phase R4 — Provider/client authority and ownership

- [ ] MEM2-R4-T1 Add provider leases and preserve opt-in fail-closed wiring
  - Depends on: MEM2-R1-T2, MEM2-R2-T1
  - Retire providers on reset/root/authority switch but close only after active leases drain.
  - Propagate requested `sqlite-v2-opt-in` with no repository when storage is unavailable so the coordinator remains active and V1 stays suppressed.
  - Acceptance: active runs survive reset; close is exactly-once after the final release; pending-open and failed-construction paths clean up; opt-in failure yields visible degradation without V1 substitution; shadow/json-v1 behavior remains compatible.
  - Validate: `bun --cwd=cli run typecheck && bun --cwd=cli test src/services/memory-v2/__tests__/provider.test.ts src/__tests__/utils/env.test.ts`

## Phase R5 — CLI command and contained file operations

- [ ] MEM2-R5-T1 Repair CLI import, revalidation, correction lookup, and error boundaries
  - Depends on: MEM2-R3-T1, MEM2-R4-T1
  - Use one bounded contained regular-file read/digest and exclusive owner-only output abstraction.
  - Revalidate live bytes with digest/workspace context; preview must not claim verification.
  - Remove blanket nonempty-target import rejection and delegate admitted-prefix recovery to the operator.
  - Paginate correction lookup with repeated/nonadvancing/empty-page guards.
  - Sanitize returned and thrown V1/V2/provider/operator failures at one top-level boundary.
  - Acceptance: traversal, absolute, symlink, nonregular, oversize, and deterministic replacement races cannot escape the project; partial import resumes; targets after page one resolve; no path/SQL/token/secret leaks.
  - Validate: `bun --cwd=cli run typecheck && bun --cwd=cli test src/commands/__tests__/memory-command.test.ts src/data/__tests__/slash-commands.test.ts src/components/__tests__/memory-box.test.tsx`

## Phase R6 — Coverage and prompt safety

- [ ] MEM2-R6-T1 Complete snapshot-bound coverage and bounded context compilation
  - Depends on: MEM2-R2-T1
  - Extend coverage events with query/facet/scope/exclusions/limits/candidates/negative results/unresolved gaps/workspace/index snapshots.
  - Capture only declared bounded tool adapters; require matching task/query/snapshot before reuse or suppression.
  - Keep verified/reusable/reread/historical sections separate and treat persisted text as untrusted evidence.
  - Acceptance: coverage survives a new chat but cannot suppress exploration across mismatched identity/snapshots; stale or unverified text never appears as verified/instruction authority; prompt size remains bounded.
  - Validate: agent-runtime task-memory, loop-agent-steps, and memory-v2-context focused tests plus the retention eval.

## Phase R7 — Integration and finalization

- [ ] MEM2-R7-T1 Run the focused integration matrix
  - Depends on: MEM2-R1-T2, MEM2-R2-T1, MEM2-R4-T1, MEM2-R5-T1, MEM2-R6-T1
  - Acceptance: common contracts, SDK coordinator/migration/operator, SQLite, provider, CLI command/renderer/slash-command, runtime context, and eval focused suites pass together.
  - Validate: record the exact combined commands and totals in `STATUS.md`.

- [ ] MEM2-R7-T2 Run package-wide validation and artifact smoke checks
  - Depends on: MEM2-R7-T1
  - Acceptance: common, agent-runtime, SDK, CLI, and evals typechecks/tests pass; SDK ESM/CJS/types build and Node dist smoke pass; no Bun DB leakage reaches SDK artifacts; compiled CLI probes and supported SQLite round trip pass.
  - Validate: current package scripts from manifests, then `bun --cwd=sdk run build && bun --cwd=sdk run smoke-test:dist`, followed by current CLI binary build/probe commands.

- [ ] MEM2-R7-T3 Obtain stable exact-snapshot reviews
  - Depends on: MEM2-R7-T2
  - Build one fresh bundle and freeze mutations while security, compatibility, migration, reliability, and final code review run.
  - Acceptance: every reviewer returns a structured non-blocking verdict with the matching fingerprint; quota/protocol failures are retried only against a fresh stable bundle and are never counted as approval.
  - Validate: record fingerprint and receipt IDs in `STATUS.md`.

- [ ] MEM2-R7-T4 Finalize durable artifacts
  - Depends on: MEM2-R7-T3
  - Acceptance: PLAN/STATUS/LESSONS reflect the actual worktree, supported/disabled platform decisions, validation/review receipts, and deferred default-cutover work; current-task pointer is cleared.
  - Validate: `get_task` reports no structural errors and no pending implementation task.

## Risks and blockers

- Race-resistant SQLite open may require a native helper/dependency. Pause for explicit approval rather than weakening the requirement.
- Any common contract change invalidates downstream validation and review receipts.
- Reviewer quota/protocol errors can block finalization even when source validation is green.
- V2 default authority, V1 removal, dependency changes, release, commit, and push remain out of scope.
