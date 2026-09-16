PLAN — Persistent Codebase Understanding (chunk store + P0-P8)

Session: persistent-code-understanding
Status: SPEC frozen. PLAN active. STATUS tracks execution.

<!-- current-task: inventory -->

## Execution rules

- Resume from current worktree; preserve unrelated dirty files (dynamic-cross-session-memory STATUS/LESSONS, .cortexkit).
- Additive contracts only; no dependency additions without approval.
- sqlite-v2-opt-in fail-closed; append-only canonical events; bounded sizes; owner-only files.
- Persisted text untrusted evidence, never instructions.
- After each phase: focused typecheck+tests, record receipts in STATUS.md.
- Phase order: A -> P0 -> P1+P2+P6 -> P5+P7 -> P3+P4 -> P8.

## Tasks

- [ ] INV inventory precise targets (code-map/structure/parse, indexer/metadata/query/query-data/index-manager/semantic, coordinator, bun-sqlite repo, memory-v2-context, discovery-coordinator, spawn/query-index handlers, memory-v2 types/tests)
  - Validate: read receipts only.

- [ ] A chunk-addressed code store
  - A1 extract: packages/code-map/src/structure.ts + parse.ts + tree-sitter-queries -> Chunk{chunkId,qualifiedName,kind,signature,range,doc,hash}.
  - A2 resolve: packages/indexer/src/metadata-indexer.ts module-scoped symbol identity, chunk-granularity edges.
  - A3 persist: sqlite tables files/chunks/edges/chunk_fts/chunk_embeddings + incremental by hash+mtime in updateMetadataIndex + snapshot identity.
  - A4 dedup: SimHash near-dup quarantine, generated/vendored down-weight, truncation surfaces stale.
  - Validate: packages/code-map + packages/indexer typecheck + tests.

- [ ] P0 contracts additive (common/src/types/memory-v2.ts)
  - Clarify selector kinds incl chunk, rename semantic-match->lexical-match additively.
  - Validate: common typecheck + memory-v2.test.ts.

- [ ] P1 enriched capture (sdk/src/services/memory-v2/coordinator.ts)
  - evidence[]<=32 excerpt<=1KB digest sha256, content-bearing detail<=16k, confidence.
  - Validate: sdk coordinator tests.

- [ ] P2 verification promotion (cli/.../bun-sqlite-memory-repository.ts verify + coordinator hook)
  - inline verify on read/mutation, batched for discoveries, mismatch->invalidated.
  - Validate: bun-sqlite repo tests 49/49 style + roundtrip.

- [ ] P6 tiered prompt (packages/agent-runtime/src/util/memory-v2-context.ts)
  - verified+fresh reusable no re-read; reusable spot-check; reread must re-read. DTO-only, 12k/2k.
  - Validate: memory-v2-context tests + task-memory.

- [ ] P5 retrieval (bun-sqlite repo buildLexicalResult)
  - FTS5+postings+cosine+graph planner, deterministic tiebreaks, degradation preserved.
  - Validate: sqlite query tests.

- [ ] P7 memory-first orchestration (discovery-coordinator + spawn-agents + query-index handlers + DiscoveryMemoryPort)
  - Query B first, narrow/skip spawn on verified cover, record via recordToolObservation.
  - Validate: discovery-coordinator + query-index tests.

- [ ] P3 consolidation (operator service, claim.consolidated preview max5)
  - Validate: operator-service tests.

- [ ] P4 coverage negatives/gaps (extractCoverageEvents all 5 dims, cap5/turn)
  - Validate: coordinator coverage tests + retention eval.

- [ ] P8 lifecycle/retention/rollback + full matrix
  - append-only, owner-only, rebuild guard, authority-flip rollback docs.
  - Validate: package-wide typecheck 11/11 + focused suites + SDK build/dist smoke + CLI probe.

## Risks

- Embeddings default-on needs BYOK dep freeze exception; else keep lexical+FTS5 first, vectors behind flag.
- FTS5 in bun:sqlite probe only; fallback lexical-scan-v1 retained.
- Chunk migration from .codebuff-index JSON needs backfill + rollback.
