BEST-POSSIBLE PERSISTENT CODE UNDERSTANDING — FINAL PLAN (complete, not foundation)

Goal: turn N+1 reuses turn N without re-exploring. A reliable, dynamic, up-to-date map + snapshot where query_index visibly improves (method-level hits), memory reuses verified learning without re-read, and every reuse is freshness-gated. When done, query_index output changes, chunks are read-path (not write-only), sqlite + JSON each own what they are best at.

Storage decision (final):
- JSON index (.codebuff-index/metadata.json) owns the CODE MAP: files, chunks, postings, graph, queryData, parseData. Reason: fast full-load, atomicWriteJson, lock-guarded, portable, already incremental by hash+mtime. Do NOT duplicate whole map into sqlite.
- sqlite (memory-v2.sqlite, append-only memory_events + projections) owns UNDERSTANDING: observation.recorded + evidence{selector chunk/file/symbol, contentDigest=chunk.hash or file hash, excerpt, capturedAt} + evidence.verified/invalidated + coverage.recorded + claim.consolidated/superseded. Reason: CAS tails, deterministic verify eventIds, digest+revision/snapshot gating, 10k-event replay.
- Link key: chunkId (stable, content-independent, see P-A) + hash (version). Indexer is truth for current hash; sqlite is truth for what was learned at which hash/revision/snapshot. Reuse iff chunk.hash == evidence.contentDigest AND workspaceRevision/snapshotId match AND index snapshot covers hash.

Current truth (verified live):
- chunks.ts extractCodeChunks captures qualifiedName (containment), first-line signature only, line ranges only, hash + content-bound chunkId, docComment always empty. structure.ts AST walk, 14 langs, no types, no edges, no incremental reuse, IDs rotate on any body edit.
- Indexer persists chunks capped 100/file (metadata-indexer.ts indexWalkedFile) but query-data.ts collectFilePostingTokens ignores chunks, query.ts scoreFile has no chunk branch, QueryIndexResult has no chunk fields, semantic fileEmbeddingText excludes chunks, graph has no chunk nodes. Retrieval-quality 37/37 green on old ranker.
- Memory V2 chunk selector exists in common types but captureToolObservation emits file selectors only; verify promotion is mutation-only file selectors; reusableDiscovery guidance is advisory text; query-index handler returns output verbatim and only tags coverage verified flag; memory-v2-context emits tiered prompt (12k/2k, 500-char excerpts, untrusted banner) but nothing enforces skip.

P-A Code-map completeness (packages/code-map)
 Files: src/chunks.ts, src/structure.ts, src/parse.ts, src/languages.ts, src/types.ts, src/__tests__/chunks.test.ts, src/__tests__/structure.test.ts, src/__tests__/incremental-parse.test.ts
 Work:
 - AST signature extractor: multi-line declarator/header span, normalized signatureText + signatureRange, params/returns/generics/decorators/modifiers where grammar exposes fields. Keep 512-char display cap, add full span.
 - docComment{text,range}: preceding comment/doc_comment nodes or leading comment block within 5 lines, normalized per language (strip /// /** # """ '''). Never empty when source has docs; tests assert non-empty.
 - typeInfo/modifiers: param types, return type, field types, visibility, export/static/async from grammar fields, fallback detail string. Additive optional fields.
 - Chunk edges: join structure defs with parse calls + import resolution: per-chunk calls/calledBy/imports/references with line/col, import-aware resolver, MAX_CALLERS-style per-chunk caps, column ranges. Reuse buildTokenCallers unambiguous rule.
 - Incremental reuse: extractCodeChunks(content,path,{previousTree,previousChunks,contentHash}) + hash/mtime memo + tree-sitter edit path + reusedChunks/freshChunks coverage counters like ParseCoverage.
 - Stable IDs: stableId = sha256(path+qualifiedName+kind) persistent slot, hash stays version field; rename/move alias map; deriveChunkId keeps content-bound form for compat, new stableChunkId is canonical. Test: body edit preserves stableId, changes hash.
 - Ranges: add startCol/endCol + byte offsets + export flag + language tag; diagnostics (not silent []/null) for unsupported/failed parses; fix overload dedupe key to include kind+col.
 Acceptance: code-map typecheck; chunks/structure/incremental suites green incl new signature/doc/type/edge/stability tests; no regression on 14 langs.

P-B Indexer chunk-aware map (packages/indexer)
 Files: src/types.ts, src/metadata-indexer.ts, src/query-data.ts, src/query.ts, src/semantic.ts, src/repo-map.ts, src/index-store.ts, src/index-manager.ts, src/query-quality.test.ts, src/retrieval-quality.test.ts, fixtures/retrieval-quality-openbuff-v1.json
 Work:
 - Postings: collectFilePostingTokens adds chunks qualifiedName split (camel/snake/dot/slash) + kind tokens; documentFrequencies rebuilt; persist via buildIndexQueryData. Chunk-only queries become retrievable.
 - Ranking: LexicalWeights.chunk (default tuned vs symbol 3, e.g. 4), scoreFile chunk loop over file.chunks (qualifiedName/kind match, IDF-weighted), matchedOn adds chunk variant, matchedSnippets adds chunk lines chunkId qualifiedName Lstart-end. Candidate gating via postings automatically includes chunk hits; findSeedPaths inherits.
 - Result shape: QueryIndexResult adds chunks?: Array{chunkId,qualifiedName,kind,startLine,endLine,hash,score} capped 5 per file; indexedHash stays file hash; add chunkHash map for freshness display.
 - Graph/semantic (bounded): chunk nodes optional (chunk: path#chunkId) with defines edges file->chunk weight 1, or minimal: keep file graph, add chunk-aware semantic input (qualifiedNames into fileEmbeddingText + fileEmbeddingHash). Choose nodes if corpus MRR lifts without blowup, else semantic-only.
 - Freshness: per-chunk hash compare on updateMetadataIndex (reuse unchanged chunk summaries, re-extract only dirty files); snapshotId content-addressed (drop builtAt from identity, keep as metadata); loadIndex hash-verify option; workspaceRevision journal enforcement (reject stale complete:true deltas); contentSample truncation marker so sample staleness is visible.
 - Cache: keep chunks persisted inline (cap 100/file already); if corpus shows bloat, move to sidecar chunks.json with same atomicWriteJson guard. Measure metadata.json size + load time before/after.
 Acceptance: indexer typecheck; metadata/query/query-quality/retrieval-quality green; retrieval-quality corpus Recall@K/MRR/nDCG improve or hold with chunk-hit cases added (method-name queries hit exact chunk); latency within budget; metadata.json size delta reported.

P-C Memory capture + verification end-to-end (common + sdk)
 Files: common/src/types/memory-v2.ts, sdk/src/services/memory-v2/coordinator.ts, sdk/src/services/memory-v2/operator-service.ts, sdk/src/services/memory-v2/event-factory.ts, sdk tests
 Work:
 - Auto-capture chunk selectors: extend collectPaths with chunk derivation — when read_files has line ranges or code_search/query_index returns symbol/chunk hits, emit selector kind chunk{path,chunkId,qualifiedName,startLine,endLine} + file fallback; contentDigest = chunk.hash (sha256:hex) when known else file hash; excerpt = signature + bounded lines (<=1KB) not just tool kind path counts.
 - Verify for all selector kinds: generalize lastCapturedVerifies + verifyCapturedPaths + P2 hook beyond file/mutation: reads/search/discovery enqueue chunk/symbol/line-range verifies with observedDigest from index; keep MAX_VERIFY_PER_CAPTURE 5 / STORED 10 bounds, best-effort, never throw.
 - Coverage with negatives/gaps: run_targeted_validation/run_file_change_hooks -> tests covered/partial, get_change_review_bundle -> validation partial, plus explicit not-covered + gap selectors for unresolvedGaps; cap 5/turn; keep evaluate_audit_coverage path unchanged.
 - Consolidation chunk-aware: selectorFacet already handles chunk path#chunkId:start-end; canonicalObservation merges evidence slice 0,8 + deduped selectors slice 0,5 with content-bearing summary/detail (facet + source ids + policy).
 Acceptance: sdk typecheck; coordinator/operator/v1-migration suites green incl new chunk capture/verify/consolidation tests; VerifiedKnowledge.superRefine digest rule holds; no verified+reread overlap.

P-D SQLite retrieval honesty (cli)
 Files: cli/src/services/memory-v2/bun-sqlite-memory-repository.ts + tests, cli/src/services/memory-v2/provider.ts, contained-file-io.ts
 Work:
 - Keep bounded-lexical-v1 deterministic core + MAX_QUERY_EVENTS 10000 + 8MiB budget + degradation codes. Keep lexical-match code; add chunk selector-match +0.05; add digest-freshness boost + excerpt-token overlap with documented weights summing <=1; tiebreak exact>token>verified>pinned>sequence.
 - contextMatches stays strict: freshness.state==verified AND (path-bearing => observedDigest==contentDigest) AND (revision/snapshot present => exact equality). Apply same gate to currentCoverage. Chunk selectors use chunk.hash equality, not file hash.
 - FTS5 for excerpts only if bun:sqlite probe passes, fallback lexical-scan-v1 retained; no new deps; owner-only 0700/0600 preserved; projections rebuildable; exportManifest stays sanitizing (excerpt stripped, verification-state-stripped warning).
 Acceptance: cli typecheck; bun-sqlite 49/49 style suite green incl freshness matrix (same-snapshot verified=1, digest mismatch/rev8/snap8/rev-only/snap-only => verified=0 + reread=1); query/verify/health/export/rebuild contracts hold.

P-E Runtime memory-first enforcement (packages/agent-runtime)
 Files: src/orchestration/discovery-coordinator.ts, src/tools/handlers/tool/query-index.ts, src/tools/handlers/tool/spawn-agents.ts, src/tools/handlers/tool/code-search.ts, src/tools/handlers/tool/find-files.ts, src/run-agent-step.ts, orchestration/discovery tests
 Work:
 - Read path (new): before query_index/spawn, consult memoryV2Context.verifiedKnowledge + discoveryCoverage.candidates/shards/unresolvedGaps + index snapshot identity + chunk hashes. Outcomes: full cover at same revision/snapshot/hash => skip index call and serve verified excerpt receipt; partial cover => narrow input (pathPrefixes/limit/mode) to gaps only; stale/missing => proceed full.
 - Extend claimDiscoveryShard dedup beyond file-picker/lister to query_index/code_search via normalized question+revision+taskId hash; duplicate returns existing receipt instead of throwing batch failure.
 - Forward verified context into child prompts (createAgentState subAgentState excerpt subset, bounded) so subagents inherit without re-query.
 - Populate coveredDomains + symbols (currently always []), preserve queryHash per batch (not overwrite), raise caps only with eviction accounting (candidates 512/shards 256/gaps 128 today — document or lift with memory bounds).
 - reconcileInterruptedDiscoveryShards stays run-entry only (active->interrupted).
 Acceptance: agent-runtime typecheck; discovery-coordinator/query-index/spawn suites green; new tests prove skip on full cover, narrow on partial, full on stale, output receipt shape when skipped; no tool-output mutation when not skipped (existing output-unchanged tests hold).

P-F Prompt tiers + understanding payload (packages/agent-runtime/src/util + run-agent-step)
 Files: src/util/memory-v2-context.ts + tests, src/util/task-memory.ts, src/run-agent-step.ts (getCorrelatedAuthoritativeV2, buildCompiledMemoryV2Message)
 Work:
 - Keep DTO-only compiler, 12k/2k bounds, 10% prefix reservation, canonical-JSON ordering, HTML-escaping, untrusted-evidence banner. Verified block carries digest + chunk line range + 500-char excerpt + verifiedAt + revision/snapshot; reusable needs spot-check; reread must re-read.
 - currentCoverage renders negatives/gaps; ranking explanations render lexical-match honestly; degradation backend/authority/resource-budget clears context but keeps sqlite-v2-opt-in active.
 - V2 authoritative path suppresses taskMemory duplicate; TTL agentStep + keepDuringTruncation preserved.
 Acceptance: memory-v2-context/task-memory/loop-agent-steps suites green; compiled output contains digest+range+excerpt for verified, banner tiers intact, bounds/determinism tests hold.

P-G Lifecycle, retention, observability, quality gates
 Files: sdk operator-service (forgotten/pinned/rebound), cli repository (rebuild, health, capabilities), scripts/memory-drift-guard.ts, evals/memory-retention, packages/indexer retrieval-quality corpus, cli/common knowledge.md
 Work:
 - Append-only canonical events; retention via claim.forgotten + evidenceDisposition, never deleteEvents/compact; rebuildProjections truncation guard + cursor!=tail; authority-flip rollback (json-v1/shadow-v2 + close), no canonical mutation; owner-only files; workspace revision/snapshot freshness on every read.
 - Observability: index build metrics (files, chunks, reusedChunks/freshChunks, metadata.json bytes, load ms), memory metrics (verified/reusable/reread/historical counts, verify promotion rate, skip/narrow/full rates, coverage dimensions), retrieval-quality Recall@K/MRR/nDCG + latency + noise tracked per corpus version.
 - Docs: cli/knowledge.md + common/knowledge.md refresh bullets per change (memory-drift guard must stay 0 findings); STATUS/LESSONS receipts per phase.
 Acceptance: full matrix green — common 42, code-map 21+, indexer metadata 16 + query/quality/retrieval 37, sdk coordinator+operator 59, cli sqlite 49, agent-runtime context+discovery+query-index 28; monorepo typecheck 11/11; drift guard 0 findings; corpus quality gates hold or improve; chunk-hit demo queries return method-level results.

Execution order: P-A -> P-B (first visible query_index gain) -> P-C+P-D -> P-E (first skipped re-exploration) -> P-F -> P-G. Each phase ends with focused typecheck+tests + STATUS receipt before next.
Risks: chunk postings bloat (cap + sidecar fallback); stable-ID migration for existing caches (backfill + alias map); semantic BYOK dep freeze (lexical+FTS5 first, vectors behind flag); watcher invalidation bound to workspaceRevision; embedding/summarization spend if understanding distillation added later (out of scope for map GA — structural+docs+types+edges is GA, LLM distillation is follow-up).
