# STATUS — Dynamic Cross-Session Memory V2 Repair

Status: ready for implementation; source work is incomplete and reviewer-blocked.
Current phase: R0 — contract freeze.
Current task: MEM2-R0-T1 Freeze and align canonical contracts.

## Implemented and locally validated before this plan refresh

- Memory V2 shared contracts, coordinator, migration, operator, SQLite adapter, provider, CLI commands/rendering, runtime context compiler, V1 migration, and eval surfaces exist in the dirty worktree.
- Focused common contract suite passed after depth/resource/freshness additions: 31 tests.
- Focused integrated SDK coordinator/migration/operator suite passed after earlier repairs: 64 tests.
- SDK build/dist smoke was repaired by synchronizing generated `ToolHelpers`; CJS require/tree-sitter smoke passed.
- Compiled CLI probe against `cli/bin/openbuff` passed.
- Earlier package-wide run reported 7,450 tests passed and 28 skipped, but subsequent source edits make that evidence stale.

## Current failing evidence

Focused SQLite command:

`bun --cwd=cli test src/services/memory-v2/__tests__/bun-sqlite-memory-repository.test.ts`

Result: 20 pass / 4 fail.

- Three test fixtures use invalid `sha256:observed`; fix fixtures, not the digest schema.
- Resource-budget query returns `failed` because unsupported low-level `task.updated` rows are unconditionally parsed as canonical envelopes. Query must skip unsupported families but still reject malformed recognized canonical events.

## Open source blockers

### Contract/integration

- Approved SPEC envelope/selector/coverage/failure semantics are not fully represented in the current common contract.
- Error/health taxonomy is collapsed across SQLite → provider → operator → CLI.
- Expected empty tail has no explicit CAS representation.

### SQLite/storage

- Project binding is incomplete for pre-existing/unbound eventful stores.
- Query byte cap is applied after materializing full rows.
- Canonical session/task/evidence reducers are incomplete; session lifecycle currently looks for payload `sessionId` instead of envelope session ID.
- Freshness checks do not require observed digest to equal evidence content digest.
- Exact idempotent replay can lose to stale expected-tail CAS.
- V1→V2 backfill implementation exists but lacks fixture coverage.
- Permission/symlink mitigation exists, but race-resistant ancestor containment is unproven with Bun’s pathname SQLite constructor.
- Compatibility/integrity preflight occurs too late relative to WAL setup.

### SDK/run

- Runtime authority validation and opt-in fail-closed coordinator behavior are implemented.
- Cursor refresh, project correlation, and same-instance terminal retry are implemented but need missing integration cases.
- CAS tail derivation can conflate empty tail with export failure and retry without protection.
- Persisted `finishing + pendingTerminal` is not replayed by a new coordinator.
- Run timeout stops awaiting preparation, but underlying Memory V2 work is not cooperatively cancelled/guarded against late mutation.

### Migration/operator

- Most earlier findings are repaired and focused suites were green.
- V1 same-revision conflict is still non-atomic between body pages and final marker.
- Manifest page 1 cannot assert empty tail.
- Task ownership remains optional in mutation requests.
- Redaction key coverage and verification-lifecycle/budget boundary tests need expansion.

### Provider/CLI

- CLI provider converts unavailable opt-in to V1 and omits SDK Memory V2 config, defeating coordinator fail-closed semantics.
- Provider reset closes shared repositories without active-client leases.
- CLI revalidate does not read/hash the live file.
- Import blanket-rejects nonempty targets instead of allowing admitted-prefix recovery.
- Correction lookup reads only one export page.
- Export/import ancestor checks remain pathname-raceable.
- Thrown and some returned errors bypass the sanitizer.

### Coverage/prompt

- `coverage.recorded` lacks query/facet/snapshot fields required for safe reuse.
- Discovery capture does not yet publish complete durable coverage events.

## Reviewer state

- Earlier security, compatibility, migration, and reliability reviews returned blocking source findings; they are not cleared until re-reviewed on the repaired snapshot.
- A later migration-review attempt failed because of provider quota/protocol attestation. This is not a source finding and not approval.
- Runtime validation previously passed configured typecheck hooks, but the snapshot is stale.

## Next checkpoint

Complete MEM2-R0-T1 and MEM2-R0-T2, then run the common focused suite, SDK Memory V2 focused suites, and CLI typecheck. Do not accept downstream validation/reviewer receipts produced before the final common contract.

## Resume instructions

1. Read SPEC and PLAN.
2. Start at `MEM2-R0-T1`; do not begin provider/CLI work before contract and SDK/SQLite boundaries stabilize.
3. After each task, append validation evidence here with `update_plan_status` and advance the PLAN current-task pointer.
4. If secure SQLite open requires a dependency/native helper, mark blocked and request explicit authorization; do not silently weaken the requirement.
5. Before final review, create one fresh bundle and freeze mutations until all structured receipts return.

<!-- update_plan_status:appended -->
## MEM2-R3-T1 validated — 2026-09-11T22:28:59.753Z

Completed `MEM2-R3-T1` migration/operator repair. Added explicit empty/event/any tail preconditions with legacy compatibility, revision-first V1 reservation and resumable CAS chaining, required task-scoped correction/revalidation, verification-lifecycle stripping, strengthened redaction, and manifest import guards/budgets. Validation: common Memory V2 34/34, SDK Memory V2 67/67, affected CLI/SQLite 78/78; common/SDK/CLI typechecks passed. Receipts: `kobhvIeXXMU`, `ko_Aib2doow`, `kpV0IF39BzA`.

Next: `MEM2-R1-T1` SQLite kernel repairs—project binding, pre-materialization query budget, canonical reducers/backfill, freshness, exact replay CAS, compatibility preflight, and filesystem/sidecar safety.


<!-- update_plan_status:appended -->
## SQLite kernel validated; native open limitation retained — 2026-09-11T23:56:58.032Z

SQLite kernel focused validation passed: CLI typecheck plus 43/43 tests (`kuWaxB7ntcI`). Implemented project inference/isolation, pre-materialization UTF-8 query budgets and event caps, same-request collision rejection, lost-response replay semantics, canonical reducers/rebuild equivalence, schema-v1 backfill/rollback/reopen checks, digest/workspace freshness matrix, dangling/nonregular DB-sidecar rejection, expanded schema preflight, and bounded failure classification.

Open security limitation: Bun exposes a pathname-only SQLite constructor. Current owner/regular-file/lstat/realpath/dev+inode checks are best-effort and do not prove descriptor-relative ancestor-swap resistance. No dependency/native helper is authorized; final security review remains blocking on this platform capability question.


<!-- update_plan_status:appended -->
## Coordinator and run reliability validated — 2026-09-12T00:41:17.964Z

SDK coordinator/run reliability validation passed: common typecheck + Memory V2 contracts 34/34 (`kwj7Hs4Iq7o`); SDK typecheck + coordinator, cancellation, contract, migration, and operator suites 88/88 (`kw4VXa5Vq8U`). Implemented explicit empty/event CAS rebase with fail-closed tail derivation, durable terminal replay across coordinators, abort-safe staged preparation, query-ID correlation, and run timeout/external-abort regressions.


<!-- update_plan_status:appended -->
## Final validation checkpoint — 2026-09-12T10:03:38.197Z

All declared workflow items complete.

**Integration matrix** (1548+ pass / 0 fail):
- common: 1237 pass across 71 files
- SDK Memory V2: 88 pass across 5 files (coordinator, v1-migration, operator-service, contract, run-cancellation)
- CLI Memory V2: 186 pass across 8 files (SQLite repo, contained-file-io, provider, memory-command, codebuff-client, env, slash-commands, memory-box)
- agent-runtime: 37 pass across 2 files (task-memory, memory-v2-context)
- discovery-coordinator: 12 pass across 1 file (3 new snapshot-bound identity tests)

**Package-wide validation**:
- Full monorepo typecheck: 11/11 packages pass
- SDK build: ESM/CJS/Types artifacts produced

**Reviewer results**:
- code-reviewer: LOOKS_GOOD (all dimensions pass, all 47 files attested)
- migration-reviewer: LOOKS_GOOD (7/7 requirements satisfied)
- compatibility-reviewer: LOOKS_GOOD (6/6 requirements satisfied)
- security-reviewer: NON_BLOCKING (2 low-severity advisories: journal sidecar, root mode)
- reliability-reviewer: 4 findings repaired (export retry, bounded finishTurn, generation-gated observations, leaf error masking)

**Discovery coverage vertical slice** shipped: taskId + workspaceSnapshotId in schema, coordinator, spawn wiring, and 3 new tests.
