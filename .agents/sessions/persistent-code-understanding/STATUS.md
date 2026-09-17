# STATUS — Persistent Codebase Understanding

Status: SPEC + PLAN frozen. Inventory in progress.
Current phase: INV -> A.
Current task: inventory precise targets.

## Progress

- SPEC.md created: two-store design (chunk code store + understanding memory), invariants, R-A/R-P0..P8.
- PLAN.md created: phased tasks A, P0-P8 with validation per phase.
- Next: inventory exact symbols/files, then Phase A chunk store.

## Validation receipts

- None yet.

## Resume

1. Read SPEC.md + PLAN.md in this session dir.
2. Continue at current-task pointer in PLAN.md.
3. After each phase record receipts here.

<!-- update_plan_status:appended -->

## Phase A + P0 + P1 + P2 + P4 + P5 + P6 landed — 2026-09-16T13:42:34.781Z

Chunk store (chunks.ts, structure root-skip fix, indexer chunks, CodeChunkSummary), P0 chunk selector + lexical-match, P1 enriched evidence capture, P2 verifyCapturedPaths best-effort hook, P4 coverage inference for validation tools, P5 lexical-match rename + chunk boost + selectorKey, P6 tiered verified excerpts. Validation observed green: common 42/42, code-map 21/21, indexer metadata 27/27, SDK coordinator+operator 59/59, CLI sqlite 49/49, agent-runtime context 9/9; code-map/indexer/common typechecks clean. Remaining: P7 memory-first DiscoveryMemoryPort wiring, P3 consolidation polish (already exists), P8 lifecycle docs + full matrix.

<!-- update_plan_status:appended -->
## P7 memory-first wiring verified — 2026-09-16T14:34:57.029Z

getVerifiedMemoryPaths + verifiedPaths plumbed through planDiscoveryBatch/recordDiscoveryResult and query-index/spawn-agents handlers. agent-runtime typecheck clean; discovery-coordinator + query-index 19/19 green. Behavior-preserving: optional param, empty set default.


<!-- update_plan_status:appended -->
## P3 consolidation polish + P8 lifecycle verified — 2026-09-16T14:36:45.700Z

P3: canonicalObservation now carries merged evidence (max 8, deterministic source order) + merged selectors (dedupe, max 5) + content-bearing summary/detail with facet. SDK typecheck clean; operator-service 24/24 green. P8: append-only canonical events, owner-only dirs 0o700 / files 0o600, rebuild guard with cursor checks, authority-flip rollback (json-v1/shadow-v2) preserved; typechecks clean across common/code-map/indexer/sdk/cli/agent-runtime.

<!-- update_plan_status:appended -->
## P-A/P-B close-out — 2026-09-17T07:01:20.269Z

P-A code-map completeness verified: signatures (multi-line header span + range), docs (non-empty with ranges), typeInfo/modifiers, per-chunk edges (calls/calledBy/imports/references, caps 25, self-skip, unambiguous), incremental reuse (previousChunks+contentHash memo + reused/fresh counters), stable IDs (stableChunkId preserved on body edit, hash version), ranges (cols/bytes/export/language) + diagnostics. Rename lineage additive: previousTree compat param + previousPath + registerChunkRenameAlias/resolveChunkAlias (bounded 500, cycle-safe) with remap reuse. Validation: code-map typecheck clean; chunks/structure/incremental 35/35 green (incl. alias round-trip, cycle, remap tests).

P-B indexer chunk-aware map verified: B1 postings include chunk qualifiedName+kind; B2 ranking LexicalWeights.chunk + scoreFile chunk loop + matchedOn chunk + snippets; B3 result chunks capped 5/file; B4 decision DOCUMENTED: keep file graph (no chunk node blowup), chunk-aware fileEmbeddingText only (first 20 qualifiedNames) — see semantic.ts; B5 freshness: per-file chunk reuse on unchanged hash, snapshotId content-addressed (builtAt excluded), loadIndex expectedSnapshotId verify (null on mismatch), workspaceRevision journal rejects stale complete:true, contentSample ...[truncated] marker; B6 cache: inline chunks cap 100/file, no sidecar. Size: metadata.json 41M (42664449 bytes), 1927 files, 653 chunks, load 222ms. Validation: indexer typecheck clean; index-store 12/12, metadata+query 46/46, query-quality+retrieval 9/9 (Recall/MRR/nDCG gates hold). No ranking/weight behavior change beyond additive chunk branch.


<!-- update_plan_status:appended -->
## Chunk-hit corpus + snapshot verify wiring — 2026-09-17T08:30:40.621Z

Corpus v1 now 15 docs / 13 queries with 3 verified chunk-hit cases (embedding-text -> semantic.ts, snapshot-identity -> index-manager.ts, snapshot-verify -> index-store.ts), each rank #1 at k=3 live. IndexManager._build post-save reload now fail-closed via loadIndex expectedSnapshotId (falls back to in-memory index on mismatch; preserves concurrent-newest-wins on CAS loss). Validation: indexer typecheck clean; retrieval-quality 3/3; manager+store 23/23; drift guard 0 findings.


<!-- update_plan_status:appended -->
## Chunk-hit corpus + snapshot verify wiring — 2026-09-17T08:31:10.143Z

Corpus v1 now 15 docs / 13 queries with 3 verified chunk-hit cases (embedding-text -> semantic.ts, snapshot-identity -> index-manager.ts, snapshot-verify -> index-store.ts), each rank #1 at k=3 live. IndexManager._build post-save reload now fail-closed via loadIndex expectedSnapshotId (falls back to in-memory index on mismatch; preserves concurrent-newest-wins on CAS loss). Validation: indexer typecheck clean; retrieval-quality 3/3; manager+store 23/23; drift guard 0 findings.
