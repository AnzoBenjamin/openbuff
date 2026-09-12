# Memory V1 Removal Readiness Plan

## Non-claims and current status

This is the canonical readiness plan for a later Memory V1 removal decision. It is not removal approval.

- Release N retains V1 compatibility. `json-v1`, `shadow-v2`, V1 persistence, migration, fallback behavior, and the published V1 APIs remain supported as currently documented.
- No removal date or version is set. Removal, if any, requires a later release decision after every gate below passes.
- Migration is not claimed complete. Current evidence is insufficient to authorize removal.
- `/memory audit-migration` outcome `not-migrated` means removal is **not ready** for that project. It reports migration state and is not a product defect.
- Outcome `exact` currently means marker identity, imported task existence, imported observation IDs, and migration provenance were verified. It does not mean every source-derived task or observation body field was reconstructed and compared.
- Even `exact` is lossless only when `omittedFields === 0`, `(truncatedFields ?? 0) === 0`, and `warnings.length === 0`. Warnings are never waived.

Normative terms such as **MUST**, **MUST NOT**, and **SHOULD** define acceptance criteria for a later removal decision.

## Readiness definition

Memory V1 is removal-ready only when all in-scope projects and supported deployment paths have mechanically reviewable evidence that removing V1 will not lose data, misstate authority, strand mixed-version clients, or prevent rollback. Before any V1 behavior or API is removed:

1. Every source blocker below **MUST** be closed in implementation and tests.
2. Every in-scope project **MUST** have the per-project evidence bundle below. A project with `not-migrated`, lossy `exact`, an ambiguous `no-record`, incomplete evidence, or a changed V1 revision/checksum is a no-go.
3. The compatibility window and every staged rollout gate **MUST** complete without an unresolved rollback trigger.
4. Storage, restore, mixed-version, public-consumer, operator, telemetry/support, and ownership criteria **MUST** be signed off.
5. `auditTaskMemoryV1Migration`, `V1MigrationAuditReader`, `V1MigrationAuditOutcome`, and the related audit types **MUST** remain supported transitional read-only contracts until the rollback window closes, unless an equivalent supported diagnostic is available first.

## Current removal-readiness blockers

These blockers are grounded in the current source and make the present answer **not ready**:

1. **Body equality is not proved.** `auditMigrationMarkerBody` in `sdk/src/services/memory-v2/v1-migration.ts` verifies marker identity, imported task existence, imported observation IDs, task association, migration provenance, and the `legacy-v1` tag. It does not reconstruct the import from the V1 source and compare every source-derived task/observation body field. A future audit **MUST** perform that stronger deterministic comparison, with tests that tamper with each imported body field and prove the audit fails closed, before `exact` can authorize removal.
2. **`no-record` is ambiguous.** `loadPersistedTaskMemory` in `sdk/src/services/task-memory-store.ts` returns `undefined` for absent, invalid, unreadable, and checksum-failed records. Therefore `no-record` alone cannot prove that no V1 data exists. Readiness requires a future non-mutating storage inspection result that distinguishes at least `absent`, `valid`, `invalid`, and `unreadable`; only independently verified `absent` can satisfy absence evidence.
3. **The importer deliberately loses or excludes some data.** `importTaskMemoryV1` warns or omits data including a non-empty goal (`goal-excluded`) and legacy evidence (`legacy-evidence-unverified`), and can omit stale/unsafe/empty/capped data or truncate text. Any warning, omission, or truncation is lossy and cannot authorize removal. Common legitimate warning cases do not create an exception; warnings **MUST NOT** be waived.
4. **Interactive audit is bounded.** `scanV1MigrationAuditEvents` scans at most 10 export pages. `/memory audit-migration` therefore cannot be the sole release-evidence path for repositories beyond that bound. Release evidence requires a full or resumable, schema-validated audit that validates pagination and reaches the canonical end of every in-scope repository.
5. **Post-V1 authority failure semantics are undecided.** Before removal, behavior for legacy or invalid authority values and for V2-open/reset failure **MUST** be explicitly specified, tested, and communicated. It **MUST** fail closed and must not silently report successful V2 authority when canonical V2 storage did not open. The decision must cover `OPENBUFF_MEMORY_AUTHORITY`, SDK authority inputs, provider result types, CLI reporting, and persisted/session authority state.

## Per-project evidence bundle

For each project in the release scope, retain a reviewable bundle outside this canonical policy document. Do not paste local machine paths, local source revisions/checksums, or artifact hashes into this file. The bundle **MUST** contain:

- project identity and evidence collection time, tool/release identity, and the declared release-scope owner;
- the non-mutating V1 inspection result (`valid` or independently proven `absent`; never inferred from `no-record`);
- for a valid record, the checksum-verified V1 backup and its recorded revision/checksum in the controlled evidence system;
- import outcome and a fresh full/resumable audit against that same V1 revision/checksum;
- an `exact` result from the future full-body-comparison audit, with `omittedFields === 0`, `(truncatedFields ?? 0) === 0`, and `warnings.length === 0`;
- a validated canonical V2 export, including validated manifest/event schemas, project identity, pagination continuity, and terminal cursor/end-of-export evidence;
- restore-drill evidence from a disposable copy, plus read/query verification after restore;
- mixed-version test results, authority/degradation diagnostics, and operator acknowledgement of any retry or remediation;
- evidence-review signoff and an explicit pass/fail disposition for every checklist item.

Any stale, partial, unparsable, mismatched, `not-migrated`, `incomplete`, `mismatch`, `rejected`, or `failed` evidence blocks that project.

## Compatibility window

Release N is the deprecation release and keeps compatibility. During the compatibility window:

- V1 read/write persistence, import, shadow/fallback behavior, authority values, CLI guidance, and public SDK/common contracts remain available.
- Deprecation notices direct operators to collect evidence; they do not claim migration completion or imply a removal date/version.
- A prior compatible artifact and configuration **MUST** remain available and tested for rollback.
- The window ends only through a later release decision after all gates and signoffs pass. It is not ended merely by low observed V1 use or by an `exact` result from the current bounded audit.

## Staged rollout gates

Each gate is blocking and advances only with recorded evidence and owner approval. No numeric threshold or fixed hold duration is defined here; release owners must judge the scoped evidence and unresolved risk rather than retrofit an arbitrary percentage.

### Gate 0: blocker closure

- [ ] Full source-derived task/observation body comparison is implemented and tampered-body tests fail closed.
- [ ] Non-mutating V1 inspection distinguishes `absent`, `valid`, `invalid`, and `unreadable`.
- [ ] A full/resumable validated audit supports stores beyond the interactive 10-page bound.
- [ ] Post-V1 authority and V2-open/reset failure semantics are approved and fail closed.
- [ ] Lossless evaluation uses the exact zero-omission/zero-truncation/zero-warning predicate.

### Gate 1: evidence tooling and rehearsal

- [ ] Evidence tooling is read-only except for an explicit import operation and produces the complete per-project bundle.
- [ ] Backup, canonical V2 export, disposable restore, re-import, and rollback procedures pass in supported storage environments.
- [ ] Unit, contract, integration, storage, consumer, and release validation below pass.

### Gate 2: compatibility-window observation

- [ ] All in-scope projects have fresh passing bundles.
- [ ] Telemetry and support review finds no unresolved V1 dependency, data-loss signal, authority misreporting, or rollback blocker.
- [ ] Mixed-version operation and rollback remain supported with both stores preserved.

### Gate 3: reversible removal candidate

- [ ] A candidate artifact can disable the proposed V1 surfaces without deleting either store or preventing re-enable/rollback.
- [ ] Upgrade, downgrade, mixed-version, invalid-authority, V2-open failure, and restored-data scenarios pass.
- [ ] Public API and CLI removal inventories have consumer migration evidence and release-note review.

### Gate 4: later removal decision

- [ ] Every go/no-go item is checked and required owners have signed off.
- [ ] No rollback trigger is open.
- [ ] The decision explicitly identifies the surfaces approved for removal; unlisted V1 behavior remains supported.
- [ ] The rollback window and criteria are declared for that release while transitional diagnostics remain supported.

## Public SDK/common removal inventory

A later decision **MUST** explicitly inventory and assess, rather than implicitly delete, at least:

- SDK task-memory functions: `loadPersistedTaskMemory`, `reconcileTaskMemoryEvidence`, `saveMergedTaskMemory`, `pruneStaleTaskMemoryEvidence`, and `codebuffFsToNodePromises`;
- SDK migration functions: `importTaskMemoryV1`, `getV1MigrationIdentity`, and the transitional read-only `auditTaskMemoryV1Migration`;
- SDK types: `TaskMemoryStoreFs`, `WorkspaceMoveRecord`, `TaskMemoryPruneOutcome`, `V1MigrationOutcome`, `V1MigrationWarningCode`, `V1MigrationSourceItemCounts`, `V1MigrationAuditReader`, and `V1MigrationAuditOutcome`;
- common schemas/constants/types: `TASK_MEMORY_LIST_CAPS`, `taskMemoryEvidenceV1Schema`, `taskMemoryDraftV1Schema`, `taskMemoryV1Schema`, `TaskMemoryEvidenceV1`, `TaskMemoryDraftV1`, and `TaskMemoryV1`;
- common session/checkpoint contracts that carry V1 import, compatibility-shadow, parity, warning, or authority state, including `MemoryV1ImportWarningCode`, `MemoryV1ImportState`, and `MemoryAuthorityStateV2`;
- persisted `.openbuff/memory/task-memory.json` semantics and any runtime hydration, reconciliation, save, prune, shadow, fallback, or migration callers.

For each item, record public/internal status, known consumers, replacement, compatibility impact, test coverage, documentation, and rollback behavior. Audit contracts follow the longer transitional lifetime stated above.

## CLI/env/provider removal inventory

A later decision **MUST** separately inventory:

- `/memory status`, `/memory prune`, and `/memory audit-migration`, including all outcome and warning guidance;
- `OPENBUFF_MEMORY_AUTHORITY`, `getMemoryAuthoritySelection`, and authority values `json-v1`, `shadow-v2`, and `sqlite-v2-opt-in`;
- invalid/legacy authority handling, the default authority, and SDK-supplied authority options;
- `ProjectMemoryV2Provider`, `MemoryV2ProviderResult`, effective/requested authority reporting, and storage-unavailable/reset-during-open degradation;
- CLI status/diagnose/authority output, V1 compatibility-shadow reporting, V2 export/import, and operator recovery instructions;
- packaged configuration, environment documentation, release notes, scripts, and external automation that set or parse these values.

Removal readiness requires tested replacements and fail-closed reporting for every inventoried path.

## Storage, backup, and no-deletion rules

Before a project can pass readiness:

- Create and retain a checksum-verified V1 backup before import or authority changes.
- Produce and validate a canonical V2 export as described in the evidence bundle.
- Perform a restore drill on a disposable copy and validate restored reads/queries; never rehearse destructively on the only copy.
- Preserve both V1 and V2 stores, their backups, and the prior compatible artifact/configuration throughout rollout and the rollback window.
- **MUST NOT** automatically delete V1 data, automatically clean up either store, or migrate in place. Import/copy to V2 and verify independently.
- Destructive cleanup, if ever proposed after the rollback window, requires a separate explicit decision, fresh backups, operator-visible scope, and its own rollback analysis. It is not authorized by this plan.

## Mixed-version and rollback criteria

Older compatible clients may continue to revise V1 while newer clients use V2. Therefore:

- After any V1 revision or checksum change, the prior migration evidence is stale: re-import and collect a fresh lossless full audit before proceeding.
- Mixed-version tests **MUST** cover old-writer/new-reader, new-writer/old-reader, concurrent/sequential use, upgrade, downgrade, and interrupted V2 open/import.
- Rollback **MUST** restore the prior compatible artifact and configuration without deleting or overwriting either store. Both stores remain intact for diagnosis and a later retry.
- A rollback is complete only when authority reporting matches actual storage use, the V1 backup still verifies, V1 operation is usable where expected, and no post-backup V1 revision is silently discarded.
- `auditTaskMemoryV1Migration` and its audit types remain available through the rollback window unless an equivalent supported read-only diagnostic exists.

## Telemetry and support review

Use privacy-appropriate, bounded signals already available to the product; do not add project contents, local paths, checksums, or raw repository errors to telemetry. Review by release scope and supported deployment path:

- requested versus effective authority, fallback/degradation, V2 open/reset failures, and invalid/legacy authority selection;
- migration outcomes and warning/omission/truncation presence, without treating `not-migrated` as a defect;
- audit incompleteness/mismatch/failure and page-bound encounters;
- restore, rollback, data-loss, stale-evidence, and mixed-version support cases;
- external consumer reports concerning deprecated SDK/common/CLI contracts.

No numeric threshold, support-volume limit, percentage, or hold duration is prescribed here. Owners must document the reviewed evidence, unresolved cases, and why the observed record is sufficient for the scoped decision. Any credible unresolved data loss, false authority claim, inability to restore, or required V1 dependency is a no-go.

## Decision ownership and signoffs

Roles may be filled according to the release process; this plan does not name individuals. The release record **MUST** include approval from:

- the Memory implementation owner, for blocker closure and semantic correctness;
- the storage/reliability owner, for backup, canonical export, restore, mixed-version, and rollback evidence;
- SDK/common and CLI maintainers, for public contract and operator inventory;
- test/release engineering, for the validation matrix and artifact reproducibility;
- support/operations, for migration guidance, observed cases, and rollback readiness;
- the release decision owner, for final scope, accepted residual risk, rollback window, and go/no-go disposition.

A signoff identifies its evidence bundle and scope; silence or a general release approval is not a Memory V1 removal signoff.

## Rollback triggers

Stop rollout and restore the prior compatible artifact/configuration when any of the following occurs:

- V1 inspection is ambiguous, invalid, unreadable, or disagrees with the retained backup;
- audit is not fresh and lossless, any warning/omission/truncation appears, or a source-derived body tamper is not detected;
- a V1 revision/checksum changes without re-import and fresh audit;
- canonical V2 export, restore, pagination, integrity, or query validation fails;
- requested and effective authority diverge without an explicit fail-closed degradation, or V2-open failure is reported as successful V2 authority;
- a supported mixed-version, upgrade, downgrade, or consumer path requires a removed surface;
- either store, backup, prior artifact/configuration, or transitional diagnostic is unavailable during the rollback window;
- telemetry/support review identifies credible data loss, inaccessible memory, or an unresolved rollback blocker.

## Validation matrix

### Unit and contract

- Import mapping and lossless predicate tests, including every warning/omission/truncation code.
- Full reconstruction/equality tests for every source-derived task and observation field; tamper each field and require fail-closed non-`exact` results.
- V1 inspector tests for `absent`, `valid`, `invalid`, `unreadable`, and checksum failure.
- Audit outcome, schema, project-binding, duplicate-ID, pagination, terminal-cursor, and resumability tests.
- Authority parsing/provider-result tests for current, legacy, invalid, unavailable, reset, and thrown-open paths; reported authority must equal actual authority.
- Public type/export contract tests, retaining transitional audit contracts.

### Integration and storage

- Checksum-verified V1 backup, import, full canonical V2 export, disposable restore, and restored query/read validation.
- Stores larger than the interactive 10-page audit bound, malformed pages, interrupted/resumed scans, and repository failure.
- Filesystem permission/unreadable/invalid/checksum-failed cases without mutation.
- Both stores preserved across upgrade, downgrade, rollback, failed import, and failed V2 open.
- V1 revision/checksum change followed by mandatory re-import and fresh lossless audit.

### Consumer and release

- Published SDK/common API inventory and representative external-consumer compile/contract validation.
- CLI commands, environment/config parsing, diagnostics, operator messages, package upgrade/downgrade, and prior-artifact rollback.
- Release artifact smoke tests for each supported deployment/storage path.
- Release notes state Release N compatibility, no set removal date/version, no migration-complete claim, and the later-decision requirement.
- Evidence bundles and signoffs are reviewable without embedding local paths or secret/raw project content in committed documentation.

## Operator migration guidance

1. Keep a known-compatible artifact and the current authority configuration available.
2. Inspect V1 non-mutatingly. If the result is `invalid` or `unreadable`, stop and repair access/record handling; do not interpret it as absence. Until the future inspector exists, treat `no-record` as inconclusive.
3. Create and verify a V1 backup. Do not migrate in place or delete the source.
4. Import to V2 using the supported path, then run the full/resumable audit. `/memory audit-migration` remains useful interactively but its 10-page bound cannot be sole evidence for larger stores.
5. Stop on `not-migrated`, `incomplete`, `mismatch`, `rejected`, or `failed`. `not-migrated` means readiness work remains; it is not itself a product defect.
6. For `exact`, require `omittedFields === 0`, `(truncatedFields ?? 0) === 0`, and `warnings.length === 0`, plus the future full source-derived body comparison. Do not waive `goal-excluded`, `legacy-evidence-unverified`, or any other warning.
7. Validate and retain a canonical V2 export, then restore and test it on a disposable copy.
8. If V1 revision/checksum changes, re-import and repeat the fresh lossless audit and export validation.
9. Preserve both stores until the declared rollback window closes. On a trigger, restore the prior artifact/configuration; do not delete either store.

## Explicit go/no-go checklist

A later removal decision is **GO** only when every applicable item is checked:

- [ ] This is a later release decision; Release N was compatibility-only, and the proposed scope/date is explicit in that later record.
- [ ] Migration is not assumed complete; every in-scope project has a fresh per-project evidence bundle.
- [ ] All five current blockers are closed with reviewed implementation and tests.
- [ ] Every valid V1 record has full-body `exact` evidence and the exact lossless predicate passes with no warnings waived.
- [ ] Every claimed absent V1 record is independently inspected as `absent`; no decision relies on `no-record` alone.
- [ ] No project has `not-migrated`, stale, incomplete, mismatched, rejected, failed, lossy, invalid, unreadable, or partial evidence.
- [ ] Repositories beyond 10 pages were audited through the full/resumable validated path.
- [ ] Checksum-verified V1 backups, validated canonical V2 exports, and disposable restore drills pass.
- [ ] Both stores and a prior compatible artifact/configuration will remain intact through rollback; no automatic deletion or migrate-in-place is enabled.
- [ ] Every V1 revision/checksum change was followed by re-import and a fresh lossless audit.
- [ ] Mixed-version, authority, V2-open failure, upgrade/downgrade, rollback, and consumer validation pass fail-closed.
- [ ] Public SDK/common and CLI/env/provider inventories have replacements, consumer evidence, documentation, and rollback coverage.
- [ ] Transitional `auditTaskMemoryV1Migration` contracts remain supported through rollback or an equivalent diagnostic is available.
- [ ] Telemetry/support review has no unresolved removal blocker and invents no threshold to hide one.
- [ ] Required role-based signoffs reference the scoped evidence.
- [ ] No rollback trigger is open.

Any unchecked item is **NO-GO**. A no-go preserves current compatibility and sets no removal date/version.
