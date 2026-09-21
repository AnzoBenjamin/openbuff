# Audit findings: shard-memory-v2

- Subsystems: memory-v2-storage-repository, memory-v2-contained-file-io, memory-v2-concept-index, memory-v2-project-provider, memory-v2-coordinator, memory-v2-operator-service, memory-v2-usage-observer, memory-v2-event-factory, memory-v2-common-schemas, memory-v2-usefulness-scorer, memory-v1-migration, agent-runtime-memory-v2-context, agent-runtime-task-memory, memory-v2-test-suite, docs-memory-v1-removal-readiness
- Features: sqlite-event-store-append-only-cas, projection-replay-and-rebuild, privileged-compaction-gc, claim-dedup-projection, usage-projection, observation-lifecycle-status, lexical-retrieval-ranking, concept-semantic-recall-cache, project-provider-leases, memory-authority-selection, turn-lifecycle-parking-replay, tool-observation-capture, verification-hooks, contradiction-flagging, usefulness-scoring, memory-context-compilation, v1-import-reservation-audit, manifest-export-import-redaction, contained-file-io
- Files covered: 33
- Snapshot: df9b2f192f10abc4503dfdc5a5a30643b0fd9ca84ef8d8cf5cd8988d93669cc1

## [MEDIUM] security — sdk/src/services/memory-v2/operator-service.ts:340 — Regex-only secret redaction in manifest export leaves non-enumerated secret formats unredacted
- **Risk:** exportManifest() redaction is a fixed pattern list (PEM, Bearer, ghp_/github_pat_, AKIA/ASIA, VAR=VALUE assignments, sensitive JSON keys). JWTs, generic base64/hex API keys without a recognized prefix, and secrets embedded in non-assignment syntax pass through unredacted into the exported manifest, which is explicitly labeled non-authoritative but is designed to leave the machine; a sensitive-key whose redaction would break schema validation is dropped, but a key outside SENSITIVE_KEYS (e.g. 'credentials', 'sessionKey', 'private_token') keeps its value.
- **Fix:** Gate export of sensitivity != 'public' evidence behind an explicit operator flag; add JWT/entropy-based detection; on un-redactable sensitive-key hits with values preserved, fail the event into warnings instead of exporting it.
- **Evidence:** const PRIVATE_KEY_PEM / SECRET_ASSIGNMENT / BEARER_TOKEN / GITHUB_TOKEN regexes are the sole free-text redaction; SENSITIVE_KEYS drops only exact normalized key matches. operator-service.test.ts 'redacts free-text tokens...' passes only for the enumerated formats.

## [LOW] security — packages/agent-runtime/src/util/memory-v2-context.ts:17 — Prompt injection hardening HTML-escapes only; markdown structural sequences in memory text are not neutralized
- **Risk:** escapeText neutralizes only &, <, > before memory observation summaries/details/excerpts are concatenated into the prompt block. Markdown structural tokens (``` fences, #/## headings, --- rules, **bold**, [link](url)) in memory text survive intact and can reshape the prompt's visual structure around the 'untrusted evidence' banner. HTML escaping is the right baseline, but the compiled block is markdown-ish prompt text, not HTML.
- **Fix:** Additionally strip or escape markdown structural sequences (leading #, >, -), backtick fences, and C0 control characters per rendered field before joining blocks.
- **Evidence:** const escapeText = (value) => value.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;') — no markdown/whitespace control handling; test only asserts '<system>' is escaped.

## [LOW] security — cli/src/services/memory-v2/bun-sqlite-memory-repository.ts:191 — bun:sqlite open is pathname-based and race-prone by the module's own admission (mitigated, not eliminated)
- **Risk:** The module is honest about it (SQLiteOpenPosture 'pathname-best-effort-unverified-open', requireSecureOpen fails closed), but in the default posture there is a window between preflightExistingDatabase()/verifyOpenedDatabasePath() and SQLite's own VFS open where the db or -wal/-shm sidecar can be swapped by a same-host attacker; identity (dev/ino) re-checks narrow but cannot close it because the final open is still by pathname.
- **Fix:** Keep requireSecureOpen wired into any privileged/high-trust deployment path; document the posture in operator guidance; long-term, vendor a VFS or driver that accepts a pre-validated descriptor.
- **Evidence:** SQLITE_OPEN_POSTURE = 'pathname-best-effort-unverified-open'; BunSQLiteMemoryRepository.open validates preflightExistingDatabase then new Database(path) then verifyOpenedDatabasePath — no descriptor-passing open exists.

## [LOW] security — cli/src/services/memory-v2/concept-index.ts:305 — FINGERPRINT_LRU_LIMIT constant interpolated directly into a DELETE statement
- **Risk:** DELETE ... LIMIT ${FINGERPRINT_LRU_LIMIT} builds SQL by template interpolation. The value is a module constant (4), so it is not currently exploitable, but the pattern invites future edits to interpolate runtime values into the same statement.
- **Fix:** Bind the limit as a parameter or clamp through a validated integer interpolation helper, so a future constant change cannot become an injection sink.
- **Evidence:** db.exec(`DELETE FROM fingerprint_lru WHERE fingerprint NOT IN (SELECT fingerprint FROM fingerprint_lru ORDER BY updated_at DESC, rowid DESC LIMIT ${FINGERPRINT_LRU_LIMIT})`)

## [LOW] state-mutation — cli/src/services/memory-v2/provider.ts:283 — Concurrent provider.open() with a different root spuriously fails the first caller's in-flight open
- **Risk:** open(rootB) while open(rootA) is in-flight awaits this.close(), bumping generation and clearing this.pending. rootA's pending promise then observes generation mismatch, closes the just-opened repository, and reports reason 'reset-during-open' to a caller who never reset anything. Degradation is retryable and fail-closed, but concurrent multi-root tooling gets spurious open failures, and no test covers two different roots opened concurrently.
- **Fix:** Scope generation invalidation to same-root opens (keep per-root pending maps) or return a distinct 'superseded-by-concurrent-open' reason; add a concurrency test for two roots opened in parallel.
- **Evidence:** open(): if (this.pending?.root === root && ...) dedup branch; next statement `if (this.current || this.pending) await this.close()` closes this.pending=null and generation++ before the different-root open proceeds; provider.test.ts has no concurrent-different-root case.

## [LOW] correctness — sdk/src/services/memory-v2/coordinator.ts:721 — appendBounded timeout abandons but does not cancel the in-flight append; shared runtimeState still mutates afterward
- **Risk:** When the 2s timer wins the race, finishPreparedTurn parks 'finishing'+pendingTerminal, but the queued append keeps running and its continuation still assigns runtimeState.lastEventId and (via earlier awaits) the shared agentState.memoryV2 reference after the caller observed the timeout. The design converges on the next prepareTurn (terminal decision replays, deterministic event ids dedup), but shared state mutates after an observed timeout, which is subtle and untested.
- **Fix:** Set a timed-out flag on the operation (or thread the timer's signal into isCurrent) so the abandoned continuation skips runtimeState and agentState writes; the terminal replay path already converges, so this is a hygiene fix.
- **Evidence:** appendBounded: Promise.race([pending, timeout]) then finally clearTimeout; append() continuation `runtimeState.lastEventId = outcome.lastEventId` runs inside the queued task regardless of the race result.

## [LOW] correctness — cli/src/services/memory-v2/bun-sqlite-memory-repository.ts:1245 — verify() synthesizes occurredAt/verifiedAt from the identity hash (~2020 epoch), not the real clock
- **Risk:** verify() derives occurredAt/verifiedAt from Date.UTC(2020,0,1)+hash to make verification idempotent and deterministic. Consequence: every evidence.verified event claims a 2020-era clock, so any consumer that orders by verifiedAt against wall-clock capturedAt/observedAt (or a future retention policy based on verifiedAt) mis-sorts verifications as oldest-possible. freshnessClass in buildLexicalResult is presence-based and unaffected today.
- **Fix:** Keep the deterministic eventId for dedup but store the real clock in verifiedAt (the event id already encodes the identity hash; determinism of the payload timestamp is not required for idempotency), or document the synthetic epoch prominently in the schema description.
- **Evidence:** const timestamp = new Date(Date.UTC(2020, 0, 1) + Number.parseInt(hash.slice(0, 8), 16) * 1_000).toISOString(); payload.verifiedAt: timestamp

## [MEDIUM] correctness — sdk/src/services/memory-v2/v1-migration.ts:470 — 10-export-page ceiling makes V1 import and every operator operation fail closed for stores beyond ~10k events
- **Risk:** findMigrationMarker throws 'Migration marker lookup exceeded page limit' past 10 export pages, so importTaskMemoryV1 returns failed/repository-failed for any store above ~10k canonical events; MemoryV2OperatorService.allEvents throws the same bound, so consolidate/correct/revalidate/repair/exportManifest/importManifest/compact all fail closed on large stores. The readiness doc acknowledges the interactive audit bound as blocker #4, but the import itself is equally bounded and is the only path to create the evidence the audit consumes.
- **Fix:** Make the scans cursor-resumable and stream-aggregating (fold markers incrementally instead of materializing all events), or expose the exceeded bound as a distinct typed outcome so operators see a size limitation rather than a repository failure.
- **Evidence:** for (let page = 0; page < MAX_EXPORT_PAGES; page++) ... throw new Error('Canonical export page limit exceeded') (operator); findMigrationMarker: throw new Error('Migration marker lookup exceeded page limit') -> importTaskMemoryV1 catch returns { outcome: 'failed', reason: 'repository-failed' }.

## [MEDIUM] performance — cli/src/services/memory-v2/bun-sqlite-memory-repository.ts:600 — Every append and query re-scans the event log via json_extract with no generated column or index
- **Risk:** appendKernel's transaction runs a project-binding scan (SELECT DISTINCT json_extract(metadata_json,'$.projectId') ... WHERE json_extract(metadata_json,'$.schemaVersion')=2), readLastEventIdForProject, getStoreStats, export, selectGCandidates and scanQueryRows all filter on json_extract over memory_events with no index or generated column. Each append and each query parses JSON for every row of the store: O(total-events) per append, O(n^2) cumulative across a session; at the 10k-event cap every append re-parses 10k JSON documents.
- **Fix:** Add a MIGRATION_4 that materializes project_id (and schema_version) as generated columns with indexes on (project_id, sequence); this converts every per-append/per-query scan into an index seek and also speeds getStoreStats/export/selectGCandidates.
- **Evidence:** appendKernel: SELECT DISTINCT json_extract(metadata_json, '$.projectId') ... FROM memory_events WHERE json_extract(metadata_json, '$.schemaVersion') = 2 LIMIT 2 (inside every append transaction); scanQueryRows: WHERE json_extract(metadata_json, '$.projectId') = ?1 ORDER BY sequence DESC; MIGRATION_1 creates no expression index.

## [LOW] performance — cli/src/services/memory-v2/bun-sqlite-memory-repository.ts:3600 — Retrieval re-folds the whole canonical log per query and uses a 10k-parameter IN list
- **Risk:** buildLexicalResult re-folds up to MAX_QUERY_EVENTS (10k) canonical events into observation/task state maps on every query — recomputing selectorKey, excerpt token sets, usefulness scores and contradiction candidates from scratch — despite the repository already maintaining memory_claims/memory_usage/memory_evidence projections. scanQueryRows also issues a second query with up to 10,000 IN-list parameters, which depends on SQLite's SQLITE_MAX_VARIABLE_NUMBER (32766 on modern builds, 999 on legacy builds) and can fail outright on older runtimes.
- **Fix:** Read the maintained memory_claims/memory_usage/memory_evidence projections (or maintain an incremental fold cursor) instead of re-deriving from the log per query; chunk the IN list (e.g. 900 per statement) or join a temp table of sequences.
- **Evidence:** const rows = database.query(`... WHERE sequence IN (${sequences.map(() => '?').join(',')}) ORDER BY sequence DESC`).all(...sequences) with MAX_QUERY_EVENTS = 10_000; buildLexicalResult rebuilds observations/tasks/freshness maps from those envelopes on every call.

## [LOW] error-handling — cli/src/services/memory-v2/provider.ts:100 — defaultOpener swallows recall-expander composition failures with a bare catch and no telemetry
- **Risk:** defaultOpener wraps indexing-config loading and embedder creation in a bare catch with no log, warn, or counter. A misconfigured openbuff.json (e.g. semantic.enabled true but a broken model factory) silently disables semantic recall forever with zero observability — users see only the downstream 'lexical-only' behavior with no diagnostic trail.
- **Fix:** Log once per process via the existing warn-latch pattern with a bounded, path-free message and the failure stage, so misconfiguration is diagnosable without changing the degrade behavior.
- **Evidence:** try { const indexingConfig = loadProviderConfigSync().config.indexing ... } catch { // Advisory only: recall expansion stays off when composition fails. }

## [MEDIUM] dependency-hygiene — cli/src/services/memory-v2/bun-sqlite-memory-repository.ts:44 — Mixed deep-relative and package-alias imports for the same memory-v2 contracts create dual-instance and drift risk
- **Risk:** The CLI repository deep-imports ../../../../common/src/types/memory-v2, ../../../../common/src/util/*, and ../../../../sdk/src/services/memory-v2/types by relative path, while provider.ts imports the same operator/schema surface from '@openbuff/sdk' and sdk sources import '@codebuff/common'. The same MemoryRepositoryV2/MemoryEventEnvelope contracts can therefore resolve to two distinct module instances in one process depending on the entry point, breaking type identity and making the CLI bundle's ABI silently diverge from the published SDK package.
- **Fix:** Standardize memory-v2 contract imports on the published package names in every consumer (or on workspace aliases everywhere), so the interface, the schemas, and the repository resolve to exactly one module instance per process.
- **Evidence:** provider.ts: import { createConfiguredEmbedder, loadProviderConfigSync, MemoryV2OperatorService, ProjectIdSchema } from '@openbuff/sdk'; bun-sqlite-memory-repository.ts: import { ... } from '../../../../common/src/types/memory-v2' and import type { ... } from '../../../../sdk/src/services/memory-v2/types'.

## [MEDIUM] test-coverage — sdk/src/services/memory-v2/__tests__/coordinator.test.ts:1 — Timeout parking, page-limit exhaustion, fingerprint LRU eviction, and concurrent different-root opens are untested
- **Risk:** Four failure paths have no test: (1) the FINISH_TURN_TIMEOUT_MS=2000 branch of appendBounded — no test parks a turn via timeout or asserts the abandoned append's post-timeout state behavior; (2) allEvents page-limit exhaustion — no operator test feeds >10 export pages to consolidate/correct/exportManifest to assert the typed failure; (3) concept-index LRU eviction — no test verifies a 5th fingerprint evicts vectors of the oldest (FINGERPRINT_LRU_LIMIT=4) or that eviction of an in-use fingerprint degrades gracefully; (4) provider concurrent open with two different roots — no test pins the spurious 'reset-during-open' behavior reported to the first caller.
- **Fix:** Add: a fake-clock coordinator test that holds the queue past 2s and asserts parked replay; a 10k+ event RepositoryStub test asserting the typed page-limit outcome for consolidate/exportManifest/import; a 5-fingerprint concept test asserting eviction of the oldest fingerprint's vectors; and a two-provider different-root parallel-open test.
- **Evidence:** code_search for 'FINISH_TURN_TIMEOUT' finds only the definition/usage (coordinator.ts 64/721/728/1952) with no test reference; concept-index.test.ts covers timeout/error/no-embedder and poisoned rows but not fingerprint eviction; operator-service.test.ts covers page-failure/repeated-cursor/health-failure but not the MAX_EXPORT_PAGES exhaustion branch.

## [LOW] api-contract — docs/memory-v1-removal-readiness.md:51 — Readiness doc blocker #5 (undecided authority-failure semantics) is stale: code implements and tests fail-closed semantics
- **Risk:** Blocker #5 states post-V1 authority and V2-open/reset failure semantics are 'undecided' and must be specified before removal, but the code already implements and tests fail-closed semantics end-to-end: getMemoryAuthoritySelection maps invalid values to json-v1 with reason 'invalid-authority' (cli/src/utils/env.ts:89-110, default sqlite-v2-opt-in), ProjectMemoryV2Provider distinguishes storage-unavailable vs reset-during-open with per-authority degradation strings, and the coordinator's applyDegradedState keeps opt-in active without re-activating V1 (provider.test.ts, coordinator.test.ts assert all of these). The doc's blocker list is stale relative to code, which could misdirect the later removal decision. Conversely the doc's 10-page-audit claim and the goal-excluded / legacy-evidence-unverified warning behavior are verified accurate against v1-migration.ts.
- **Fix:** Update the readiness doc to mark the authority-semantics blocker as implemented-and-tested (citing the provider/coordinator tests) so Gate 0 reflects the code; keep the 10-page-audit and lossless-predicate blockers open.
- **Evidence:** Doc: 'Post-V1 authority failure semantics are undecided ... MUST be explicitly specified, tested, and communicated' (Gate 0 unchecked). Code: getMemoryAuthoritySelection maps unknown values to json-v1 with reason invalid-authority (cli/src/utils/env.ts:89-110); coordinator.test.ts 'invalid runtime authority safely selects json-v1 and performs no V2 work'; provider.test.ts 'default authority selection fails closed without V1 fallback'.

## Coverage receipt

### Subsystems
- memory-v2-storage-repository
- memory-v2-contained-file-io
- memory-v2-concept-index
- memory-v2-project-provider
- memory-v2-coordinator
- memory-v2-operator-service
- memory-v2-usage-observer
- memory-v2-event-factory
- memory-v2-common-schemas
- memory-v2-usefulness-scorer
- memory-v1-migration
- agent-runtime-memory-v2-context
- agent-runtime-task-memory
- memory-v2-test-suite
- docs-memory-v1-removal-readiness

### Features
- sqlite-event-store-append-only-cas
- projection-replay-and-rebuild
- privileged-compaction-gc
- claim-dedup-projection
- usage-projection
- observation-lifecycle-status
- lexical-retrieval-ranking
- concept-semantic-recall-cache
- project-provider-leases
- memory-authority-selection
- turn-lifecycle-parking-replay
- tool-observation-capture
- verification-hooks
- contradiction-flagging
- usefulness-scoring
- memory-context-compilation
- v1-import-reservation-audit
- manifest-export-import-redaction
- contained-file-io

### Files
- cli/src/services/memory-v2/provider.ts
- cli/src/services/memory-v2/contained-file-io.ts
- cli/src/services/memory-v2/concept-index.ts
- cli/src/services/memory-v2/usefulness-scorer.ts
- cli/src/services/memory-v2/index.ts
- cli/src/services/memory-v2/bun-sqlite-memory-repository.ts
- cli/src/services/memory-v2/__tests__/provider.test.ts
- cli/src/services/memory-v2/__tests__/contained-file-io.test.ts
- cli/src/services/memory-v2/__tests__/concept-index.test.ts
- cli/src/services/memory-v2/__tests__/concept-firewall.test.ts
- cli/src/services/memory-v2/__tests__/bun-sqlite-memory-repository.test.ts
- cli/src/services/memory-v2/__tests__/two-session-cold-start.test.ts
- cli/src/services/memory-v2/__tests__/usefulness-scorer.test.ts
- cli/src/services/memory-v2/__tests__/memory-v1-migration-sqlite-roundtrip.test.ts
- sdk/src/services/memory-v2/coordinator.ts
- sdk/src/services/memory-v2/operator-service.ts
- sdk/src/services/memory-v2/usage-observer.ts
- sdk/src/services/memory-v2/event-factory.ts
- sdk/src/services/memory-v2/v1-migration.ts
- sdk/src/services/memory-v2/types.ts
- sdk/src/services/memory-v2/__tests__/coordinator.test.ts
- sdk/src/services/memory-v2/__tests__/operator-service.test.ts
- sdk/src/services/memory-v2/__tests__/usage-observer.test.ts
- sdk/src/services/memory-v2/__tests__/v1-migration.test.ts
- common/src/types/memory-v2.ts
- common/src/types/__tests__/memory-v2.test.ts
- common/src/util/usefulness-scorer.ts
- packages/agent-runtime/src/util/memory-v2-context.ts
- packages/agent-runtime/src/util/task-memory.ts
- packages/agent-runtime/src/util/__tests__/memory-v2-context.test.ts
- packages/agent-runtime/src/util/__tests__/task-memory.test.ts
- cli/src/utils/env.ts
- docs/memory-v1-removal-readiness.md

### Domains
- security
- correctness
- state-mutation
- error-handling
- performance
- dependency-hygiene
- test-coverage
- api-contract
