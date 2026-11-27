# Index persistence and retrieval architecture findings

Scope: CLI startup and query entrypoints, IndexManager lifecycle, metadata reconciliation, snapshot and vector persistence, watcher invalidation, lexical graph retrieval, and representative lifecycle/quality tests. This is a source-based architecture review; no runtime timing or model behaviour was measured. Source files remain unchanged.

## Ranked findings

### 1. High — performance / API contracts: a cold process cannot serve its durable snapshot until reconciliation and publication finish

**Evidence:** `packages/indexer/src/index-manager.ts:600` loads the saved index into a local variable. It then calls `updateMetadataIndex` at line 611 and `saveIndex` at line 637. The first assignment to the serving `this.index` occurs at line 676 or the alternate branches at lines 698/709. `cli/src/utils/codebuff-client.ts:295` waits up to 2,000ms and proceeds to the query without requiring readiness. `IndexManager.query` explicitly returns empty results before readiness (`index-manager.ts:399`). Startup already requests background construction (`cli/src/init/init-app.ts:27`).

**Inference / risk:** When loading, reconciliation or persistence exceeds the query wait, a new CLI process can provide no indexed candidates despite a usable saved index. This encourages fallback discovery. The repository does not establish how often this happens on the user's actual sessions. Startup is background work, so this is not proof that all provider dispatches block on indexing.

**Design remedy:** Separate opening a last-known snapshot from reconciling it. Expose a read-only cached generation promptly with explicit indexed revision, freshness and coverage. Run reconciliation in the background and atomically publish the next generation. Relevant source reads must still verify current bytes before edits; cached retrieval must not create edit or execution authority. Give cold-start context compilation a bounded query against the opened generation, rather than treating a valid saved snapshot as unavailable throughout rebuild.

### 2. High — performance / state mutation: monolithic publication amplifies small edits and the byte cap can discard the very state needed for next-session reuse

**Evidence:** The default durable representation is a single `metadata.json`, fully read and parsed (`packages/indexer/src/index-store.ts:145`). Update persistence serializes the complete document (`index-store.ts:415`) and writes its chunk sidecar (`index-store.ts:300`). The 64,000,000-byte cap is declared at `index-store.ts:722`; the first reduction tier drops both `queryData` and `parseData` (`index-store.ts:422`). A subsequent load rebuilds query data if absent (`index-store.ts:182`), and metadata reconciliation detects missing parse data (`metadata-indexer.ts:655`). If even reduced metadata exceeds the cap, `saveIndex` serves in memory and skips durable writes (`index-store.ts:263`). Even a precise update recomputes global token scores/callers from merged parse records (`metadata-indexer.ts:773`) and recreates graph/query metadata (`metadata-indexer.ts:882`, `:1099`).

**Inference / risk:** Cross-session reuse is weakest precisely on larger repositories. A one-file mutation can entail whole-snapshot serialization and derived graph/index reconstruction, even though unchanged tree-sitter parses are reusable. Above the cap, loss of parse records can force hydration on later starts; this is a conditional risk, not evidence that the user's present snapshot has already been reduced. Synthetic latency claims are unwarranted without measurement.

**Design remedy:** Store immutable per-content parse/chunk records and indexed file revisions separately from transactional generation manifests. Keep postings, document frequencies and graph adjacency in durable incremental tables or a dedicated search index. Replace only changed file rows and affected edges/postings. Apply size budgets to query output and bounded caches, with explicit eviction and reproducible repair, rather than dropping all parse reuse from the canonical document. Keep old/new generations and source identity distinct from derived materialization identity.

### 3. Medium — correctness / state mutation: precise deltas are session-local hints, while offline or ambiguous changes return to whole-project reconciliation

**Evidence:** `metadata-indexer.ts:516` uses the precise path only for `complete: true`; otherwise it calls the whole-project walker (`:519`). CLI SDK-owned mutations supply exact paths and workspace revision (`cli/src/utils/create-run-config.ts:300`), but terminal/custom/MCP effects use `markStale` (`:313`). The watcher accumulates paths in process-local sets and flushes after 75ms (`cli/src/utils/index-workspace-watcher.ts:114`); ambiguity schedules full stale marking (`:120`). Linux+Bun watcher coverage is capped and uncovered directories rely on age sweeps (`:154`). Index mutation epoch is explicitly non-persistent (`index-manager.ts:201`).

**Inference / risk:** The current design has no durable watch/change cursor that can prove a stopped process observed all filesystem changes. It must therefore reconcile after restart, and periodically traverse unwatched subtrees. Stat-gated reuse prevents most unchanged file reads/hashes, so this must not be described as reparsing the whole repository on every session.

**Design remedy:** A repository service should own a durable sequenced mutation journal with exact receipts, watcher hints, overflow/gap markers, and an indexed cursor. Use shared Git tree/blob identity plus separate worktree overlays to reuse committed content without mixing dirty states. A continuously running service can maintain the cursor across CLI sessions. If it was stopped or a watcher gap exists, perform a background integrity reconciliation; no design can infer arbitrary offline writes reliably from an absent event. Canonicalize project identity separately from each worktree identity.

### 4. Medium — correctness / security boundary: mtime-and-size reuse does not establish byte freshness

**Evidence:** `metadata-indexer.ts:572` documents that writes preserving both mtime and size are invisible. Lines 593–598 reuse the previous hash when current and walked stats match, including a changed path in a precise delta. The code also documents the stat/read race (`:581`). Query results expose indexed hashes rather than a live-read grant (`cli/src/utils/codebuff-client.ts:296`, `IndexManager` snapshot identity at `index-manager.ts:731`).

**Inference / risk:** A touchless external update, or a known changed path with preserved stats, can temporarily leave obsolete source metadata in retrieval. This is not evidence of an authorization bypass: downstream exact-read/edit authority is separate and must stay so.

**Design remedy:** Hash explicitly dirty paths even when stat identity matches. Treat stat equality as a cache freshness heuristic for unflagged files, not proof of source identity. Use captured-byte digests for source records, version-derived facts, and semantic-index attestations; combine journal guarantees with periodic content audits. Preserve current read capability checks at mutation boundaries.

### 5. High — test coverage / product correctness: index quality tests do not establish the goal of avoiding rediscovery across new sessions

**Evidence:** `packages/indexer/src/retrieval-quality.test.ts:99` freshly builds the repository index and evaluates fixed retrieval cases. The shipped corpus uses an incrementing fake clock (`:122`–`:127`) and asserts synthetic one-tick samples (`:152`), so it measures ranking but not real latency. Lifecycle tests cover stale serving, deltas, CAS/foreign-root safety, and embedding reuse. `query-cache.test.ts:9` prevents full-corpus enumeration for a posting-hit query. None of these particular tests runs two real CLI conversations and counts repeated discovery.

**Inference / risk:** Strong ranking and storage tests can pass while a new agent ignores existing knowledge or receives the wrong context. Absence of that product-level acceptance test permits regressions that frustrate the user's original objective.

**Design remedy:** Add two-fresh-session evaluations with unchanged and slightly changed workspaces. Measure startup-to-useful-context, cache/open/reconciliation work, redundant discovery/searches, unchanged-file reads, role-context relevance, retrieved prior facts, and correctness after a change. Use real elapsed-time benchmarks separately from deterministic ranking tests. Include restart, missed watcher events, worktrees, cap pressure, and optional semantic backend failure.

## Strengths to retain

- Parse summaries are already durable in normal-sized snapshots: changed paths alone reparse while `existing.parseData` supplies unchanged files (`metadata-indexer.ts:773`). The historical claim that parse caching is only process-local is obsolete.
- Lexical postings, document frequencies, and adjacency are already persisted in `queryData` and validated/restored on load (`index-store.ts:174`; `query-data.ts:41`). WeakMaps in `query.ts` cache materialized adjacency/IDF views; they do not imply every query rebuilds the entire graph.
- Source snapshot identity excludes `builtAt` (`index-manager.ts:731`), and exact publication bytes use a separate token (`index-store.ts:112`). Preserve that separation.
- Snapshot publication has locking, ownership checks, CAS and verification; concurrent workers must retain equivalent correctness (`index-store.ts:192`).
- Semantic input and embedder identity drive cache reuse, with batch validation and checkpointing (`semantic.ts:104`, `:119`; `index-store.ts:470`). Keep embedding optional; generic embeddings do not replace file/symbol/command retrieval or scoped context assembly.
- Parse degradation and mutation deltas are requeued with bounds and prior revision retained (`index-manager.ts:652`; `metadata-indexer.ts:815`).
- CLI path-only bootstrap is a purposeful latency choice (`create-run-config.ts:247`), so restoring eager full-project symbol scoring would undo that benefit. Supply a compact task briefing from durable state instead.

## Eight-domain coverage

| Domain | Inspected surfaces | Disposition |
| --- | --- | --- |
| Security | cache ownership, snapshot validation, foreign-root isolation, digests and retrieval boundary | Finding 4; no demonstrated edit-authority bypass |
| Correctness | freshness, mutation delta scope, stale/ready status, stat reuse | Findings 1, 3, 4 |
| State mutation | immutable serving generations, pending deltas, CAS, whole-graph publication | Findings 2, 3 |
| Error handling | failed loads/build stages, watcher downgrade, degraded parser, retry bounds | Preserved strengths; cold-open availability contributes to finding 1 |
| Performance | cold-open ordering, full JSON read/write, cap fallback, posting candidates, parse reuse | Findings 1, 2, 3 |
| Dependency hygiene | indexer manifest and code-map/resolver/TypeScript dependencies | No concrete defect established; a Rust move requires packaging/ABI/compile-pipeline comparison |
| Test coverage | manager/cache/quality tests and their acceptance scope | Finding 5 |
| API/ABI contracts | readiness/status/snapshot identity, query options, persistence success semantics | Findings 1, 2; preserve source/publication identity and versioned result schema |

## Limits and discriminating probes

- No live latency, cache-hit rate, model token savings or duplicate discovery count was measured.
- Inspect actual snapshot reduction tiers and saved parseData/queryData presence before claiming cap pressure caused this installation's rediscovery.
- Trace the first `query_index` in a fresh installed CLI process to distinguish cached-generation availability from the agent failing to request retrieval.
- This lane did not audit book scoping, memory-event/query reconstruction, child briefing inheritance, or graph semantic precision; those belong to adjacent lanes.
