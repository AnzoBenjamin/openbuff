# BEST-POSSIBLE PERSISTENT CODE UNDERSTANDING — FINAL PLAN (complete, not foundation)

Goal: turn N+1 reuses turn N without re-exploring. A reliable, dynamic, up-to-date map + snapshot where query_index visibly improves (method-level hits), memory reuses verified learning without re-read, and every reuse is freshness-gated. Done = query_index output changes, chunks are read-path (not write-only), sqlite + JSON each own what they are best at.

## 0. Storage decision (final, locked)

- JSON index `.codebuff-index/metadata.json` owns the CODE MAP: `files`, `chunks`, `postings`, `graph`, `queryData`, `parseData`. Why: fast full-load, `atomicWriteJson` + lock guard (`packages/indexer/src/index-store.ts:84-124,326-376`), portable, already incremental by hash+mtime. Do NOT duplicate the whole map into sqlite.
- sqlite `memory-v2.sqlite` owns UNDERSTANDING: append-only `memory_events` + projections (`memory_tasks|sessions|artifacts|claims|evidence|discoveries`), event types `observation.recorded`, `evidence.{attached,verified,invalidated,rebound}`, `coverage.recorded`, `claim.{consolidated,corrected,superseded,forgotten,pinned}` (`cli/src/services/memory-v2/bun-sqlite-memory-repository.ts:MIGRATION_1/2`, `applyProjection ~1650-1800`). Why: CAS tails, deterministic verify eventIds, digest+revision/snapshot gating, 10k-event replay (`MAX_QUERY_EVENTS 10000`, `MAX_QUERY_PAYLOAD_BYTES 8MiB`).
- Link key: `stableChunkId` (content-independent, P-A) + `hash` (version). Indexer is truth for current hash; sqlite is truth for what was learned at which hash/revision/snapshot. Reuse iff `chunk.hash == evidence.contentDigest AND workspaceRevision/snapshotId match AND index snapshot covers hash`.
- Non-goals: no duplication of full source into sqlite (excerpts <=1KB only); no hosted embeddings/cloud sync; no V1 removal; no new deps without approval; persisted text stays untrusted evidence, never instructions.

## 1. Current truth (verified live, do not re-litigate)

- `packages/code-map/src/chunks.ts:14-34,65-111`: qualifiedName via containment, first-line signature only (`slice(0,512)`), line ranges only, `hash=sha256(lines)`, `chunkId=sha256(path+qualifiedName+kind+hash)`, `docComment:''` always. `structure.ts:17-23,30-60,243-338`: AST walk, 14 langs, no types, refs excluded by design, fresh `parse()` every call, dedupe `startLine:endLine:name` collides on overloads.
- `packages/indexer/src/metadata-indexer.ts:502-534`: chunks persisted capped 100/file, `undefined` on error/empty. `types.ts:1-20`: `CodeChunkSummary`, `IndexedFile.chunks?`. `query-data.ts:collectFilePostingTokens`: values = path/symbols/headings/concepts/imports only — chunks contribute zero tokens. `query.ts:scoreFile`: fileName 5 / path 2 / symbol 3 / heading 2.5 / concept 1.5 / import 1 + IDF + graph; no chunk branch, `matchedOn` has no `chunk`, `QueryIndexResult` has no chunk fields. `semantic.ts:fileEmbeddingText` excludes chunks. Retrieval-quality 37/37 green on old ranker.
- Memory V2: `common/src/types/memory-v2.ts:122-141` chunk selector exists; `coordinator.ts:captureToolObservation ~950-1050` emits file selectors only; verify promotion mutation-only file selectors (`MAX_VERIFY_PER_CAPTURE 5`, `STORED 10`); `bun-sqlite-memory-repository.ts:buildLexicalResult ~2600-3100` partitions verified/reusable/reread/historical, `contextMatches ~2725-2755` strict digest+revision/snapshot, `selectorKey 2481-2494` handles chunk, rank `selector-match +0.25`, chunk `+0.05`, `lexical-match <=0.3`, verified `+0.15`, pinned `+0.04`, recency `+0.01`.
- Runtime: `query-index.ts:30` calls client unconditionally, `:41-50` only post-tags coverage via `getVerifiedMemoryPaths` + `recordDiscoveryResult`; output returned verbatim (`return {output}`, test asserts `toEqual`). `discovery-coordinator.ts:90,145,170-192`: verified flag path-equality only, never filters/skips. `memory-v2-context.ts:12k/2k, 500-char excerpts, banner tiers` prompt-only; `run-agent-step.ts:1935,1969-1978` injects per-iteration, no tool-input enforcement. `coveredDomains` never populated, `symbols` always `[]`, caps candidates 512/shards 256/gaps 128.

## P-A Code-map completeness — `packages/code-map`

Target files: `src/chunks.ts`, `src/structure.ts`, `src/parse.ts`, `src/languages.ts`, `src/types.ts`, `src/__tests__/chunks.test.ts`, `src/__tests__/structure.test.ts`, `src/__tests__/incremental-parse.test.ts`.

Work:
- A1 AST signatures: multi-line declarator/header span per grammar, `signatureText + signatureRange`, params/returns/generics/decorators/modifiers where fields exist. Keep 512-char display cap, add full span field. Cover TS/Python/Rust/Go/C++ multi-line fns.
- A2 docComment{text,range}: preceding `comment/doc_comment` nodes or leading block within 5 lines, normalized per idiom (strip `/// /** # """ '''`). Never empty when source has docs; assert non-empty.
- A3 typeInfo/modifiers: param/return/field types, visibility, export/static/async from grammar fields, fallback `detail` string. Additive optional.
- A4 chunk edges: join `structure` defs with `parse` calls + import resolution: per-chunk `calls/calledBy/imports/references` with line/col, import-aware resolver, per-chunk caps like `MAX_CALLERS=25`, self-calls skipped, unambiguous same-language rule kept.
- A5 incremental reuse: `extractCodeChunks(content,path,{previousTree,previousChunks,contentHash})` + hash/mtime memo + tree-sitter `edit` path + `reusedChunks/freshChunks` counters like `ParseCoverage`. No fresh `parse()` when hash unchanged.
- A6 stable IDs: `stableChunkId = sha256(path+qualifiedName+kind)` persistent slot; `hash` stays version; rename/move alias map; keep `deriveChunkId` content-bound for compat, canonical = stable. Test: body edit preserves stableId, changes hash.
- A7 ranges+diagnostics: add startCol/endCol + byte offsets + export flag + language tag; return diagnostics (not silent `[]/null`) for unsupported/failed; dedupe key includes kind+col to fix overload collisions; unify qualified-name logic (remove chunks/structure drift).

Acceptance gate:
- `bun --cwd=packages/code-map run typecheck` clean; `bun test src/__tests__/chunks.test.ts src/__tests__/structure.test.ts src/__tests__/incremental-parse.test.ts` green including new signature/doc/type/edge/stability tests; no regression on 14 langs.

## P-B Indexer chunk-aware map — `packages/indexer`

Target files: `src/types.ts`, `src/metadata-indexer.ts`, `src/query-data.ts`, `src/query.ts`, `src/semantic.ts`, `src/repo-map.ts`, `src/index-store.ts`, `src/index-manager.ts`, `src/query-quality.test.ts`, `src/retrieval-quality.test.ts`, `fixtures/retrieval-quality-openbuff-v1.json`.

Work:
- B1 postings: `collectFilePostingTokens` adds `chunks.qualifiedName` split (camel/snake/dot/slash) + kind tokens; rebuild `documentFrequencies`; persist via `buildIndexQueryData`. Chunk-only queries become retrievable.
- B2 ranking: `LexicalWeights.chunk` (default 4 vs symbol 3, tunable via `openbuff.json`), `scoreFile` chunk loop over `file.chunks` (IDF-weighted), `matchedOn` += `chunk`, `matchedSnippets` += `chunkId qualifiedName Lstart-end`. `findSeedPaths`/`querySearch` inherit via postings; no separate candidate path.
- B3 result shape: `QueryIndexResult.chunks?: Array{chunkId,qualifiedName,kind,startLine,endLine,hash,score}` capped 5/file; `indexedHash` stays file hash; expose chunkHash map for freshness display.
- B4 graph/semantic bounded: add chunk nodes `chunk:path#chunkId` + `defines` file->chunk weight 1 if corpus MRR lifts without blowup, else keep file graph + chunk-aware `fileEmbeddingText/Hash` (qualifiedNames in). Decide by measurement, document choice.
- B5 freshness: per-chunk hash compare in `updateMetadataIndex` (reuse unchanged summaries, re-extract dirty files only); snapshotId content-addressed (drop `builtAt` from identity, keep as metadata); `loadIndex` hash-verify option; `workspaceRevision` journal enforcement (reject stale `complete:true` deltas); mark `contentSample` truncation so sample staleness is visible.
- B6 cache: keep inline chunks (cap 100/file); if `metadata.json` bloats, move to sidecar `chunks.json` under same lock/`atomicWriteJson`. Report size + load ms before/after.

Acceptance gate:
- `bun --cwd=packages/indexer run typecheck` clean; `metadata-indexer/query/query-quality/retrieval-quality` green; corpus Recall@K/MRR/nDCG improve or hold with new chunk-hit cases (method-name -> exact chunk); latency within budget; size delta reported.

## P-C Memory capture + verification end-to-end — `common` + `sdk`

Target files: `common/src/types/memory-v2.ts`, `sdk/src/services/memory-v2/coordinator.ts`, `sdk/src/services/memory-v2/operator-service.ts`, `sdk/src/services/memory-v2/event-factory.ts`, `sdk/src/services/memory-v2/__tests__/*`.

Work:
- C1 auto-capture chunk selectors: extend `collectPaths` with chunk derivation — `read_files` line ranges or `code_search/query_index` symbol/chunk hits emit `chunk{path,chunkId,qualifiedName,startLine,endLine}` + file fallback; `contentDigest = chunk.hash` when known else file hash; `excerpt = signature + bounded lines` <=1KB. Keep MAX_PATHS 32, MAX_ACTIONS 32, canonicalBounded caps.
- C2 verify all kinds: generalize `lastCapturedVerifies/verifyCapturedPaths`/P2 hook beyond file/mutation — reads/search/discovery enqueue chunk/symbol/line-range verifies with `observedDigest` from index; keep 5/10 bounds, best-effort, never throw (stub `verify` throws in tests).
- C3 coverage negatives/gaps: `run_targeted_validation/run_file_change_hooks -> tests covered/partial`, `get_change_review_bundle -> validation partial`, plus explicit `not-covered` + gap selectors from `unresolvedGaps`; cap 5/turn; keep `evaluate_audit_coverage -> validation` unchanged; avoid breaking conflict-retry count assertions.
- C4 consolidation chunk-aware: `selectorFacet` already `chunk:path#chunkId:start-end`; canonical merges `evidence.slice(0,8)` + deduped `selectors.slice(0,5)`, content-bearing summary/detail (facet + source ids + policy), deterministic `derivedId` (evidence-excluded so idempotency holds).

Acceptance gate:
- `bun --cwd=common run typecheck` + `memory-v2.test.ts` 42 green; `bun --cwd=sdk run typecheck` + coordinator/operator/v1-migration green including new chunk capture/verify/consolidation tests; `VerifiedKnowledge.superRefine` digest rule holds; no verified+reread overlap.

## P-D SQLite retrieval honesty — `cli`

Target files: `cli/src/services/memory-v2/bun-sqlite-memory-repository.ts` + tests, `provider.ts`, `contained-file-io.ts`.

Work:
- Keep `bounded-lexical-v1` deterministic core + 10k events + 8MiB budget + degradation codes. Keep `lexical-match`; chunk `selector-match +0.05`; add digest-freshness + excerpt-token weights, sum <=1, documented; tiebreak exact>token>verified>pinned>sequence.
- `contextMatches` stays strict: `state==verified AND (path-bearing => observedDigest==contentDigest) AND (revision/snapshot present => exact equality)`. Chunks compare `chunk.hash`, not file hash. Same gate for `currentCoverage`.
- FTS5 excerpts only if `bun:sqlite` probe passes, fallback `lexical-scan-v1`; no new deps; owner-only 0700/0600; projections rebuildable; `exportManifest` stays sanitizing (excerpt stripped, `verification-state-stripped`).

Acceptance gate:
- `bun --cwd=cli run typecheck` clean; `bun-sqlite-memory-repository.test.ts` 49-style green including freshness matrix (same-snapshot verified=1; digest-mismatch/rev8/snap8/rev-only/snap-only => verified=0 + reread=1); query/verify/health/export/rebuild contracts hold.

## P-E Runtime memory-first enforcement — `packages/agent-runtime`

Target files: `src/orchestration/discovery-coordinator.ts`, `src/tools/handlers/tool/query-index.ts`, `src/tools/handlers/tool/spawn-agents.ts`, `code-search.ts`, `find-files.ts`, `src/run-agent-step.ts`, orchestration/discovery tests.

Work:
- E1 read path (new, the actual re-exploration cut): before `query_index`/spawn, consult `memoryV2Context.verifiedKnowledge` + `discoveryCoverage.candidates/shards/unresolvedGaps` + index snapshot identity + chunk hashes. Full cover at same revision/snapshot/hash => skip index call, serve verified-excerpt receipt; partial => narrow input (`pathPrefixes/limit/mode`) to gaps; stale/missing => full call.
- E2 extend `claimDiscoveryShard` dedup beyond file-picker/lister to `query_index/code_search` (normalized question+revision+taskId); duplicate returns existing receipt instead of throwing batch.
- E3 forward verified excerpts into child `subAgentState` (bounded) so subagents inherit without re-query.
- E4 populate `coveredDomains` + `symbols` (today `[]`), preserve per-batch `queryHash`, document or lift caps (512/256/128) with eviction accounting. `reconcileInterruptedDiscoveryShards` stays run-entry only.

Acceptance gate:
- `bun --cwd=packages/agent-runtime run typecheck` clean; discovery/query-index/spawn suites green; new tests prove skip-on-full-cover, narrow-on-partial, full-on-stale, receipt shape on skip; existing output-unchanged tests hold when not skipped.

## P-F Prompt tiers + understanding payload

Target files: `src/util/memory-v2-context.ts` + tests, `src/util/task-memory.ts`, `src/run-agent-step.ts` (`getCorrelatedAuthoritativeV2`, `buildCompiledMemoryV2Message`).

Work:
- Keep DTO-only compiler, 12k/2k bounds, 10% prefix reservation, canonical-JSON order, HTML-escaping, untrusted banner. Verified block: digest + chunk range + 500-char excerpt + verifiedAt + revision/snapshot; reusable = spot-check; reread = must re-read.
- `currentCoverage` renders negatives/gaps; ranking renders `lexical-match` honestly; degradation backend/authority/budget clears context but keeps `sqlite-v2-opt-in` active (never V1 fallback).
- V2 authoritative suppresses taskMemory duplicate; TTL `agentStep` + `keepDuringTruncation` preserved.

Acceptance gate:
- memory-v2-context/task-memory/loop-agent-steps suites green; digest+range+excerpt present for verified; banner/bounds/determinism hold.

## P-G Lifecycle, retention, observability, quality gates

Target files: `sdk/.../operator-service.ts` (forgotten/pinned/rebound), `cli/.../bun-sqlite-memory-repository.ts` (rebuild/health/capabilities), `scripts/memory-drift-guard.ts`, `evals/memory-retention`, indexer corpus, `cli/knowledge.md`, `common/knowledge.md`.

Work:
- Append-only canonical events; retention via `claim.forgotten + evidenceDisposition`, never `deleteEvents/compact`; `rebuildProjections` truncation + `cursor!=tail` guard; authority-flip rollback only; owner-only files; freshness on every read.
- Metrics: index (files, chunks, reused/fresh, bytes, load ms), memory (verified/reusable/reread/historical, promotion rate, skip/narrow/full rates, coverage dims), retrieval (Recall@K/MRR/nDCG, latency, noise) per corpus version.
- Docs: knowledge refresh bullets per change (drift guard 0 findings); STATUS/LESSONS receipts per phase.

Acceptance gate (final):
- common 42, code-map 21+, indexer metadata 16 + query/quality/retrieval 37, sdk coordinator+operator 59, cli sqlite 49, agent-runtime context+discovery+query-index 28; monorepo typecheck 11/11; drift guard 0 findings; corpus gates hold-or-improve; chunk-hit demo queries return method-level results.

## Execution order + risks

Order: P-A -> P-B (first visible query_index gain) -> P-C+P-D -> P-E (first skipped re-exploration) -> P-F -> P-G. Each phase: focused typecheck+tests + STATUS receipt before next.

Risks: postings bloat (cap + sidecar fallback); stable-ID migration (backfill + alias map); semantic BYOK freeze (lexical+FTS5 first, vectors flagged); watcher invalidation bound to workspaceRevision; LLM distillation explicitly out of scope for map GA (structural+docs+types+edges is GA, distillation is follow-up).

## Definition of done (when BEST claim is legitimate)

- `query_index` method-name query returns exact chunk (`chunks[]` with line range) and corpus MRR lifts; chunks read-path proven by grep (hits in `query-data.ts` + `query.ts`) and tests.
- Same revision/snapshot/hash reuses verified excerpt with zero index call (skip test green); changed chunk hash forces precise reread (not whole-file).
- Freshness matrix green; full validation matrix green; drift guard clean; no write-only metadata remains.
