# SPEC — Retrieval & Memory Quality Tier 1

## Goals
Fix the root causes of "random, lackluster, bloated" output across three subsystems, measured before and after with machine-checkable quality metrics:

1. **code-map token ranking** (`packages/code-map/src/parse.ts`): replace popularity-boost scoring with tf×IDF so boilerplate (`map`, `fetch`, `describe`) sinks and distinctive identifiers rise.
2. **code-map call lists** (`packages/code-map/src/chunks.ts`, `structure.ts`): dedup-and-rank calls by frequency with a per-language stoplist; stop `@import.call` captures from polluting call sites; rank-then-cap instead of first-N.
3. **indexer graph expansion** (`packages/indexer/src/query.ts`): restrict related-file expansion to file↔file edges (resolved imports/references); drop concept/import second-hop noise; deterministic tie-breaking.
4. **task-memory curated write-path** (`packages/agent-runtime/src/util/task-memory.ts`, `sdk/src/services/task-memory-store.ts`, `common/src/util/decision-rationale.ts`): stop persisting per-read boilerplate evidence durably; tighten the rationale gate; add content-hash dedup.

## Non-goals
- No schema/ABI changes to `query_index` public output fields (Tier 2 work: result slimming, subScores, envelope slimming).
- No rewrite of memory-v2 coordinator or V1→V2 migration.
- No persisted postings/adjacency performance work (existing audit HIGH items stay for a later tier).
- No dependency changes.

## Acceptance criteria
- A1: `retrieval-quality` eval reports noise-ratio and recall@k; baseline numbers recorded in `STATUS.md` before Tier 1 edits; post-fix numbers recorded after.
- A2: `memory-retention` eval reports recall@k + noise-ratio (boilerplate-read ratio) for compiled context; baseline + post-fix numbers recorded.
- A3: token scores in `parse.ts` use in-file term frequency × IDF-style downweight; popularity (`boostScoresByExternalCalls`) no longer inflates ubiquitous tokens; existing `parse.test.ts` contracts updated deliberately.
- A4: chunk `calls` deduped by name with count + frequency-ordered cap; `@import.call` captures excluded from call sites; cap application records kept/total.
- A5: `query_index` relatedFiles no longer produced via shared-concept/import second-hop expansion unless the concept token appears in the query; result ordering has deterministic tie-break by path.
- A6: whole-file read results no longer become durable task-memory evidence (session-scoped working set instead, bounded); record_decision requires a real rationale clause; duplicate decision content deduped by content hash.
- A7: `bun run typecheck` passes for touched packages; `bun test` passes for code-map, indexer, agent-runtime, sdk, evals (targeted suites).

## Relevant systems
- `packages/code-map` (parse/structure/chunks), `packages/indexer` (query/graph), `packages/agent-runtime` (task-memory), `sdk` (task-memory-store), `evals` (retrieval-quality, memory-retention), `common` (schemas/util).

## Evidence
- Shard audits (this session): parse.ts:639/759/843 set-dump scoring; chunks.ts:462 first-N call caps; structure.ts:941 @import.call leak; metadata-indexer.ts:1223 file-scoped symbol nodes; query.ts:335/769 graph noise; task-memory.ts:~540 per-read evidence; decision-rationale.ts:17 keyword-only gate.
- `docs/audits/read-write-indexing-2026-07-14/findings/indexing-retrieval.md` (prior audit, still-unfixed items noted as Tier 2+).