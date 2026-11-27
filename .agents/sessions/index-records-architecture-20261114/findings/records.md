# Records lifecycle and retrieval audit

Scope: durable Memory V2 observations, claims, evidence, projections, lexical/concept retrieval, consolidation, retention, and compaction archives. Product source is unchanged. This report complements the separate books, cold-start, code-map, and index lanes.

## Ranked findings

| Rank | Finding | Primary domain | Severity | Confidence |
| --- | --- | --- | --- | --- |
| 1 | Query-tail admission makes older pinned knowledge disappear while its projection remains stored | Correctness | High | High; hermetic reproduction |
| 2 | Archive bodies are stored in three representations and full-replaced per run | Performance/state mutation | High | High; schema, writer, supplied dbstat measurement |
| 3 | Whole-workspace freshness downgrades unchanged evidence after unrelated changes | Correctness | Medium | High; hermetic reproduction |
| 4 | Semantic recall searches a small already-admitted corpus, so it cannot recover excluded durable knowledge | Correctness/performance | Medium | High; direct code |
| 5 | Consolidation stays within task/facet groups and is operator-driven | Correctness/record quality | Medium | High for behavior; benefit of alternatives is a design inference |
| 6 | Archive storage/search failures collapse into skipped or empty results | Error handling/API contracts | Medium | High; direct code |

## R1 — Retrieval replays the recent event tail rather than querying current projections

**Evidence:** `cli/src/services/memory-v2/bun-sqlite-memory-repository.ts:121` bounds queries to 10,000 events and 8 MiB. Its `query` method at `:1924` invokes `scanSQLiteQuery`, reconstructs canonical envelopes, and calls `buildLexicalResult`. `cli/src/services/memory-v2/sqlite-query-scan.ts:5` admits newest project events by descending sequence; its worker at `:46` stops at the byte cap. Relevance, selector matching, pinning and usefulness are applied only after this admission.

`buildLexicalResult` at repository `:4759` reconstructs observations, tasks, verification, lifecycle and usage maps. Later verification/reinforcement/pin events are ignored when their observation anchor is absent. In contrast, the append projection at `:3968` maintains `memory_discoveries` and `memory_claims`; their tables exist at `:3365` and `:3373`. Primary retrieval does not use them. The source explicitly says to fold usage events rather than read its maintained usage projection.

**Hermetic reproduction:** A temporary repository received a canonical architecture observation, operator pin, and digest verification through the public append port. Querying it returned verified=1, reusable=1, reread=0. A single fixture transaction then inserted 10,001 irrelevant valid canonical task events. The same query returned verified=0, reusable=0, reread=0 with `result-cap-reached`. `getProjectionSnapshot` still contained the original discovery. Fixture insertion isolated query admission and did not replace the original observation or projection. The temporary database/script were removed.

**Risk/inference:** Accumulating more records can reduce useful recall. An old pinned record can be durable, protected from GC, and still invisible to a new session. Expanding the cap postpones this threshold and increases per-query parsing; it does not repair the model.

**Design remedy:** Keep the append-only log for audit/replay, but serve retrieval from incrementally maintained current-state projections indexed by repository, entity, selector, kind, lifecycle and full text. Keep a checked projection cursor and producer/schema version. Return projection lag/degradation explicitly. Apply a result/candidate budget after indexed relevance selection; preserve pinned active anchors irrespective of recent log volume. Make repair/backfill resumable over the entire log rather than making every ordinary query replay it.

**Required regression:** An old pinned/verified architecture claim must remain retrievable after substantially more than both event and byte caps of unrelated activity, including after close/reopen and projection repair. Also test old anchors with later verification, supersession, forgetting and reinforcement.

## R2 — Archive storage duplicates bodies and rewrites the full retained run

**Evidence:** Repository `:1325` writes each archive's entire `messages_json` into `context_archive_snapshots`; `:1331` writes extracted per-message `body` into `context_archive_messages`; `:1337` writes the body again into `context_archive_fts`. DDL at `:3413`, `:3425` and `:3450` confirms those representations. The FTS comment explicitly accepts regular, non-external-content FTS duplicate storage. The transaction at `:1387` deletes the run's previous snapshots, message rows, FTS rows and watermark, then inserts the complete supplied set. This is idempotent and atomic, but each actual flush performs full replacement.

The parent supplied read-only, point-in-time measurements for this checkout's store:

| Item | Observation |
| --- | ---: |
| SQLite main file | 530,518,016 bytes |
| Canonical events | 13,883 rows |
| Discoveries / claims / evidence | 6,896 / 7,071 / 465 rows |
| Archive messages / snapshots | 252,949 / 2,008 rows |
| `context_archive_messages` pages | 130,396,160 bytes |
| `context_archive_fts_content` pages | 129,224,704 bytes |
| `context_archive_snapshots` pages | 117,518,336 bytes |
| `context_archive_fts_data` pages | 42,737,664 bytes |

These are storage observations, not measured latency or a claim that all snapshot contents are duplicates. The direct schema does establish repeated body representations. The main-file size excludes any WAL/SHM bytes.

**Risk/inference:** Raw history occupies substantially more storage than the canonical event stream and repeatedly republishes existing bodies. Larger snapshot sets amplify serialization, transaction and FTS maintenance work. The existing 30-day TTL (`:127`) and bounded prune (`:129`) address age, not deduplication or incremental write cost.

**Design remedy:** Store each sanitized immutable message/body once under a stable message ID/content digest. Make archive snapshots ordered membership manifests plus step metadata. Use external-content FTS5 over the canonical message table, with transactional insert/delete maintenance and a rebuild path. Append new immutable snapshots; reconcile deleted membership/retention references separately. Retain explicit snapshot lineage and source run/step IDs. Keep durable learned facts under relevance/lifecycle retention independent of the shorter raw-history TTL.

**Required regression:** Roundtrip every existing archive action, preserve message order/tool-call lineage, prove FTS hits after incremental changes and rebuild, verify snapshot-reference GC cannot remove shared bodies, and retain existing sanitizer/owner-only storage posture during migration. Compare bytes written and storage amplification for repeated saves of a long session.

## R3 — Freshness binds reusable facts to the whole workspace

**Evidence:** Repository `contextMatches` at `:5008` first requires matching evidence/observed digests. When either request or verification carries workspace context, it additionally requires exact equality of workspace revision and snapshot ID. The coordinator attaches workspace context to verification at `sdk/src/services/memory-v2/coordinator.ts:2038`.

**Hermetic reproduction:** Before filling the admission tail in R1, the same query and evidence digest at revision 1/snapshot one returned verified=1, reread=0. Querying revision 2/snapshot two while leaving the evidence digest unchanged returned verified=0, reusable=1, reread=1. No degradation was reported because this is the implemented freshness policy.

**Risk/inference:** An unrelated file change can invalidate the verified category for stable architecture facts, prompting repeated selector reads. This is conditional on workspace context being supplied; it does not mean every stored fact always loses verification on every edit.

**Design remedy:** Separate durable factual freshness from operational execution/edit authority. Anchor a fact to the hashes and producer/configuration dependencies it actually depends on. Invalidate those facts when those dependencies change. A query may reuse the unchanged fact while still requiring fresh live reads before edits and current action/validation authority before mutations. Multi-file claims need an explicit dependency set rather than a blanket workspace revision.

**Required regression:** Unrelated changes preserve verified factual knowledge; source/dependency changes invalidate the relevant fact; reusing a fact never grants edit or execution permission.

## R4 — Concept vectors cannot recover excluded durable observations

**Evidence:** Repository `:4972` creates its concept corpus from the just-replayed active observations, sorts by observation ID and keeps 256. `:5494` invokes the expander only after lexical selection and appends at most eight advisory observations. Its candidates must still exist in the replayed observation map. `cli/src/services/memory-v2/concept-index.ts:89` persists model/text-fingerprinted vectors separately; the query scores vectors for the supplied corpus rather than searching the entire durable knowledge projection.

**Risk/inference:** A vector cache can be populated and reusable without providing repository-wide semantic memory recall. The current 256-entry ID-ordered sample is unrelated to task relevance and cannot restore an anchor excluded by R1.

**Design remedy:** Generate embeddings incrementally for current eligible knowledge records. Query their persistent candidate index, apply role/task/lifecycle/evidence filters, then fuse lexical/semantic/graph candidates. Keep embeddings advisory and retain their model/content fingerprint. Benchmark exact/lexical projection search first; introduce an ANN backend only when measured corpus size/latency requires it.

## R5 — Capture does not produce a consolidated reusable project model

**Evidence:** `sdk/src/services/memory-v2/operator-service.ts:485` reads all events for explicit consolidation and groups at `:507` by task ID, selector facet and observation kind. The canonical summary at `:574` is deterministic source-count/facet prose. The CLI exposes this through `/memory consolidate` at `cli/src/commands/memory-command.ts:758`. Coordinator capture automatically records observations/verifications, but `finishTurn` at `sdk/src/services/memory-v2/coordinator.ts:2123` builds terminal/usage records rather than calling consolidation. `common/src/util/claim-identity.ts:22` deduplicates normalized kind/text/evidence paths across tasks, but differently worded claims remain different identities.

**Risk/inference:** Repeated observations of the same subsystem can accumulate without forming an enduring entity/predicate model. Current consolidation merges nearby records within one task; it is not general cross-session architecture learning. This does not establish that automatic summarization is always beneficial.

**Design remedy:** Model repository entities and evidence-backed claims separately from raw observations. Use explicit entity/predicate/source identity for exact deduplication and keep contradiction/supersession lineage. Schedule bounded background maintenance after committed capture, consolidating deterministic exact duplicates automatically. Treat semantic merges/summaries as derived candidates with source links and confidence; they must not manufacture verified facts or operator policy. Retain operator inspection/correction/pinning.

## R6 — Archive errors are hard to distinguish from successful absence

**Evidence:** `searchContextArchive` at repository `:1531` returns the same empty result when the store is closed or when both FTS and fallback queries fail. FTS failure falls back to bounded LIKE; an outer failure becomes empty. `persistContextArchiveSnapshots` at `:1308` returns skipped counts for closed storage, invalid inputs or failed transactions. CLI archive sync (`cli/src/services/memory-v2/context-archive-sync.ts:159`) logs failures without a retrieval-visible reason.

**Risk/inference:** A user/agent can interpret unavailable history as no history and repeat discovery. Current primary memory queries already have typed degradation; archive retrieval needs equivalent honesty.

**Design remedy:** Extend archive outcomes with available/degraded/unavailable state and bounded reason codes, while preserving successful empty as a distinct state. Keep FTS fallback visible as degraded capability. Carry status into cold-start context and diagnostics without changing authorization or blocking routine work.

## Current strengths to preserve

- Schema-validated canonical events, project binding, append-only audit history and transactional maintained projections.
- Owner-only memory directory/file posture; archive bodies inherit CLI persistence sanitization. A new shared blob/FTS path must preserve these boundaries.
- Actual digest verification for complete native reads and confirmed mutations; discovery hints do not automatically become authority.
- Stable claim dedup identity, explicit correction/supersession/forget/pin/reinforce events and operator tooling.
- Deterministic usefulness and GC criteria. `common/src/util/compaction-eligibility.ts:74` protects pinned observations and avoids heuristic eviction of explicit/reused/reinforced claims. R1 bypasses those protections through query admission rather than deleting records.
- Model/content-fingerprinted optional concept vectors, bounded queries, FTS capability fallback and atomic archive replacement.

## Eight-domain coverage

| Domain | Disposition |
| --- | --- |
| Security | Reviewed project binding, schema admission, digest honesty, sanitization boundary and owner-only storage. No separate new authorization bypass established; proposed derived facts must remain distinct from instructions/edit grants. |
| Correctness | R1, R3, R4, R5; lifecycle reconstruction and anchor loss reproduced. |
| State mutation | R2; transactional projection/append and archive replacement inspected. |
| Error handling | R6; typed primary query degradation versus archive empty fallback inspected. |
| Performance | R1, R2, R4; operation shapes/storage measured, latency not measured. |
| Dependency hygiene | Active backend is Bun/TypeScript SQLite; optional vector store shares that runtime. No scoped manifest defect established. |
| Test coverage | Existing repository/replay/GC/archive/concept tests inspected; hermetic probes cover old-anchor loss and unrelated-revision downgrade. Proposed migration/reuse regressions enumerated above. |
| API/ABI contracts | Preserve event/export lineage, versioned projection compatibility, typed degradation and exact digest semantics. Any archive-outcome or normalized-store change needs a compatible public boundary/migration. |

## Language choice and limits

The active record backend directly imports `bun:sqlite`; a Rust memory/index service would be new implementation work. `rust/crates/openbuff-native/src/lib.rs:16` currently exports execution only; its daemon/infer/plugin/a11y role dispatch at `:71` is explicitly unimplemented. Its Cargo manifest has no SQLite/search dependency. Rust could own a long-lived single-writer intelligence service, but changing language alone will preserve R1/R3/R5 unless the data/query model changes.

This lane did not benchmark live first-token latency, inspect specific historical claims for disappearance, assess all user projects, or establish semantic-merge accuracy. The parent database sample supports actual scale and storage shape; the isolated probe establishes the two retrieval mechanisms. Product evaluation should measure useful prior-fact retrieval and repeated discovery over genuinely new CLI conversations, separately from storage load or search ranking tests.
