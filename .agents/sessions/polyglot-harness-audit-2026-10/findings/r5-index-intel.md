# Audit findings: r5-index-intel

- Subsystems: indexer-index-store, indexer-index-manager, indexer-query-retrieval, indexer-scip-intel, indexer-import-resolution, code-map-tree-sitter-parse, code-map-grammar-wasm-repair, sdk-language-intelligence
- Features: index-persistence-cas, index-cache-locking, semantic-vector-cache, chunk-sidecar, byte-cap-tiered-persistence, lexical-retrieval-idf, pagerank-blend, posting-candidates, scip-ingest-merge, scip-runner-detection, ts-module-resolution-oxc, conservative-import-resolution, wasm-grammar-repair-pinning, tree-sitter-wasm-parse, lsp-language-intelligence, test-impact-analysis, mutation-delta-refresh
- Files covered: 16
- Snapshot: d2df71d608d67a3324faf6271f018ab600c00fab18ad1a67b7964172d6289935

## [MEDIUM] state-mutation — packages/indexer/src/index-store.ts:826 — saveChunkSidecar writes without CAS/newest-wins gate
- **Risk:** Unlike saveIndex (which CAS-gates on builtAt inside withCacheLock), saveChunkSidecar writes chunks.json under the lock with no generation check: a writer holding a stale snapshot can overwrite a newer sidecar, leaving chunks.json describing an older snapshot than metadata.json (the invariant saveIndex's own sidecar write explicitly preserves).
- **Fix:** Gate the write on the on-disk sidecar's snapshotId/builtAt (accept only when the incoming snapshotId is newer or the current artifact is absent), mirroring saveIndex's expectedBuiltAt CAS, or restrict saveChunkSidecar to callers already inside the saveIndex transaction.
- **Evidence:** saveChunkSidecar body: normalize → length check → assertCacheOwnership → withCacheLock(dir, () => atomicWriteJson(sidecarPath, normalized)) with no builtAt/snapshotId comparison against the artifact currently on disk.

## [MEDIUM] performance — packages/indexer/src/index-store.ts:32 — LOCK_TIMEOUT_MS (10s) shorter than realistic large-save critical section
- **Risk:** A live holder serializing a 47MB metadata.json (JSON.stringify + write) can hold the lock longer than 10s; a concurrent IndexManager build then throws 'Timed out waiting for index cache lock' and fails the build even though the holder is healthy and heartbeating.
- **Fix:** Scale LOCK_TIMEOUT_MS with the metadata byte cap (e.g. deadline proportional to artifact size), or make waiters poll the holder's heartbeat mtime and extend the deadline while it is fresh.
- **Evidence:** withCacheLock: deadline = Date.now() + LOCK_TIMEOUT_MS at line 950; timeout throw at line 1066-1068; LOCK_HEARTBEAT_MS only affects the holder's mtime, not the waiter's deadline.

## [MEDIUM] correctness — packages/indexer/src/scip-ingest.ts:332 — ingestScipDump serves merged index with queryData deleted, never rebuilt in-memory
- **Risk:** mergeScipEdgesIntoIndex deletes next.queryData because postings/adjacency are stale after the edge change, but ingestScipDump (index-manager.ts:928-946) assigns merged.index directly to this.index. getPostingCandidates then returns null for every query (falling back to scoring ALL files) and the persisted-adjacency fast path is gone until the next full rebuild/loadIndex (which does rebuild). Long-lived sessions degrade silently.
- **Fix:** Rebuild queryData in mergeScipEdgesIntoIndex (buildIndexQueryData is deterministic and already imported by index-store) or have ingestScipDump/adoptMergedIndex rebuild it before serving.
- **Evidence:** mergeScipEdgesIntoIndex: `const next = { ...index, graph: { nodes, edges: merged } }; delete next.queryData`; ingestScipDump: `this.index = merged.index` with no queryData rebuild or loadIndex-style normalization.

## [LOW] correctness — packages/indexer/src/scip-ingest.ts:375 — SCIP symbol→definition map is last-writer-wins for multiply-defined symbols
- **Risk:** definitionPathBySymbol is a Map keyed by symbol with last-sorted-document-wins semantics: a symbol defined in multiple files (re-exports, generated duplicates) makes all references point at only one defining file, dropping the other definition edges from the precise graph.
- **Fix:** Map symbol → set of defining documents and emit one edge per (from, definition) pair, or pick deterministically and document the single-definition assumption.
- **Evidence:** scipEdges: `for (const document of documents) { for (const occurrence of document.occurrences) { if (isDefinition(occurrence)) definitionPathBySymbol.set(occurrence.symbol, document.relativePath) } }` then references map to the single stored path.

## [MEDIUM] performance — packages/indexer/src/query.ts:617 — Retrieval scoring is not BM25 — no TF saturation, no length normalization, substring candidate expansion
- **Risk:** scoreFile is additive IDF weighting with substring containment: no term-frequency component (each field contributes once per token), no document-length normalization, and df itself is approximated by a substring union capped at 4096 (query-data.ts getPostingDocumentFrequency returns undefined at the cap). Recall is preserved but ranking quality diverges from BM25 exactly where SPEC P6-T7 plans tantivy; the substring vocabulary scan (every posting key per query token) is also the retrieval hot path on large indexes.
- **Fix:** Interim: store per-field term frequencies in IndexedFile (they exist in parseData tokenScores) and implement BM25 k1/b length normalization in scoreFile; long-term: the SPEC's tantivy cutover replaces postings+scoring wholesale — that boundary is correct, keep this TS tier as fallback.
- **Evidence:** computeIdfForTokens idf formula at query.ts:617; scoreFile adds at most one weight per field per token (break statements); getPostingCandidates scans `Object.keys(postings)` with includes() for each short token (query-data.ts:100-115).

## [MEDIUM] error-handling — packages/code-map/src/grammar-wasm-repair.ts:203 — Retry-After honored up to 3600s per attempt — worst-case repair stall contradicts documented bound
- **Risk:** A CDN (or hostile middlebox) sending Retry-After: 3600 stalls grammar repair for up to two hours (attempt 2 and attempt 3 each honor the header), contradicting the module's documented 'worst-case added latency stays bounded at 3 attempts x 30s plus two short retry delays' and blocking CLI/SDK startup that waits on grammar resolution.
- **Fix:** Cap the effective Retry-After per attempt (e.g. 30s, matching ATTEMPT_TIMEOUT_MS) or bound total repair wall-clock; treat Retry-After above the bound as a hard failure.
- **Evidence:** parseRetryAfterSeconds accepts 0..3600; computeRetryDelayMs returns retryAfterSeconds*1000 directly; sleep is awaited twice between the 3 attempts.

## [LOW] state-mutation — packages/indexer/src/index-store.ts:222 — saveIndex returns true when tier-4 cap skip persisted nothing
- **Risk:** Tier-4 (reduced doc still over cap) skips persisting entirely but returns true. adoptMergedIndex interprets true as 'persisted' and runs loadIndex verification, which loads the PREVIOUS snapshot and fails isSameIndexSnapshot — the merged edges silently stay memory-only, which is the intended fallback but is reached through a misleading success path any new caller could misuse.
- **Fix:** Return a tri-state or attach a persisted:false marker so callers can distinguish committed vs skipped; adoptMergedIndex should treat tier-4 as lost-CAS semantics (serve merged in-memory, warn loudly).
- **Evidence:** saveIndex: `if (reduced.size > MAX_METADATA_INDEX_BYTES) { console.warn(...); return true }`.

## [MEDIUM] api-contract — sdk/src/services/language-intelligence.ts:4 — No shared symbol/language registry across query_index, LSP tools, code-map, and test-impact (D29 drift)
- **Risk:** There is no shared symbol vocabulary across the four surfaces: query_index ranks files by IndexedFile.symbols token strings, code_search is raw ripgrep text, the LSP tools speak LSP positions/URIs keyed by common/language-capabilities SUPPORTED_LANGUAGE_IDS, code-map parse keys grammars by its own languageTable, and language family comes from a third table (common/language-profiles). SCIP symbols (the one precise scheme) are reduced to opaque edge labels and never cross-linked to node ids; harness-intelligence test-impact analysis has its own independent confidence model that does not consume index graph edges. D29's open language registry is not implemented; adding a language touches 3+ tables.
- **Fix:** Implement the D29 open language registry as the single source (ext-id → grammar, family, LSP capability) and introduce one canonical symbol-ID scheme (SCIP-style) emitted by the parse tier so query_index results, LSP locations, and test-impact seeds address the same symbol namespace.
- **Evidence:** sdk/src/services/language-intelligence.ts:4-9 imports common/language-capabilities; packages/code-map/src/languages.ts has its own languageTable; SCIP ingestion treats symbols as opaque strings (scip-ingest.ts docblock) and stores only labels; sdk/src/services/harness-intelligence.ts:472 ranks TestImpactConfidence without consuming index graph edges.

## [LOW] dependency-hygiene — packages/indexer/src/ts-module-resolver.ts:207 — oxc-resolver 11.24.2 primary tier is the right choice; dual-tier drift risk documented but real
- **Risk:** The combined oxc→ts.resolveModuleName→conservative tiering with a uniform project-relative final-edge gate is the correct boundary: oxc buys exports/imports/tsconfig-paths/references natively while the in-memory ts host keeps resolution index-bounded when the napi binary is missing. Residual drift: the ts fallback tier receives aliases but oxc relies solely on its own tsconfig option, so alias behavior differs between tiers depending on platform (napi present or not) — same input, different tier, different result on exotic platforms.
- **Fix:** None required for the choice; consider wiring oxc's tsconfig aliases for the fallback tier too and documenting that oxc's tsconfig references:'auto' can resolve across project-reference roots only when those files are indexed.
- **Evidence:** buildOxcResolver: conditionNames ['node','import'], extensions list with .d.ts last, symlinks:false, nodePath:false, fullySpecified:false; final gate `files[relative] === undefined → null` at the end of both tiers.

## [LOW] security — packages/indexer/src/index-store.ts:1050 — Lock liveness via PID probe is sound; stale-lock age heuristic is the only fallback for ambiguous owners
- **Risk:** A dead indexer's lock is reclaimed immediately via process.kill(pid,0) ESRCH — good — but pid reuse by an unrelated live process makes the stale lock appear alive, blocking every build for the full STALE_LOCK_MS (5 minutes) with no escape hatch other than the age check; the heartbeat keeps mtime fresh only for live holders, so this is a bounded (5 min) but real availability window after a crash on a busy machine.
- **Fix:** Bound the dead-owner wait (e.g. half STALE_LOCK_MS) with an mtime-based secondary check, or include a boot-unique token in the lock owner line to defeat pid reuse.
- **Evidence:** withCacheLock EEXIST branch: readFile + stat snapshot, isLockOwnerDead(content) via process.kill(pid,0), ageStale via mtime, reclaimStaleLock content-verified rename; release/reclaim both re-verify displaced bytes.

## [LOW] correctness — packages/code-map/src/grammar-wasm-repair.ts:323 — Grammar wasm checksum gating is sound; repair retry loop is fail-closed and re-verified
- **Risk:** Gating is correct end-to-end: candidate loads are hash-verified, downloads are byte-capped and sha256-pinned, and production repair output is re-verified before the path is returned. Remaining nit: the persisted wasm write (writeFile → rename) has no fsync, so a crash mid-rename could leave bytes that fail the pin at next load — but resolveGrammarWasmSource re-verifies candidates on every load, so the failure mode is a redownload, not corruption.
- **Fix:** No fix required; optional: fsync the wasm temp file before rename for durability symmetry with atomicWriteJson.
- **Evidence:** resolveGrammarWasmSource: candidates loop hashes each before acceptance; repairGrammarWasm hashes downloaded bytes against PINNED_GRAMMAR_ASSETS before persist; post-write re-verification only skipped for injected repairImpl.

## [LOW] test-coverage — packages/indexer/src/index-manager.ts:928 — Lock/SCIP/vector-cache machinery well-tested, but queryData-degradation and sidecar-clobber paths lack regression tests
- **Risk:** ingestScipDump's queryData-drop degradation (r5-3) and saveChunkSidecar's ungated write (r5-1) are both untested seams: scip-ingest.test.ts covers merge semantics and index-store.test.ts covers lock/CAS, but no test pins that a post-ingest in-memory index still answers queries efficiently or that a stale saveChunkSidecar cannot regress chunks.json.
- **Fix:** Add a regression test: build index, ingestScipDump with one precise edge, then queryIndex and assert candidates/postings behave (or assert queryData was rebuilt).
- **Evidence:** index-store.test.ts covers reclaimStaleLock/releaseOwnedLock/reduceIndexForByteCap/setWriteGitExclude; scip-runner.test.ts uses makeFakeRunner; no test drives ingestScipDump → querySearch with queryData absent.

## Coverage receipt

### Subsystems
- indexer-index-store
- indexer-index-manager
- indexer-query-retrieval
- indexer-scip-intel
- indexer-import-resolution
- code-map-tree-sitter-parse
- code-map-grammar-wasm-repair
- sdk-language-intelligence

### Features
- index-persistence-cas
- index-cache-locking
- semantic-vector-cache
- chunk-sidecar
- byte-cap-tiered-persistence
- lexical-retrieval-idf
- pagerank-blend
- posting-candidates
- scip-ingest-merge
- scip-runner-detection
- ts-module-resolution-oxc
- conservative-import-resolution
- wasm-grammar-repair-pinning
- tree-sitter-wasm-parse
- lsp-language-intelligence
- test-impact-analysis
- mutation-delta-refresh

### Files
- packages/indexer/src/index-store.ts
- packages/indexer/src/index-manager.ts
- packages/indexer/src/metadata-indexer.ts
- packages/indexer/src/query.ts
- packages/indexer/src/query-data.ts
- packages/indexer/src/import-resolution.ts
- packages/indexer/src/ts-module-resolver.ts
- packages/indexer/src/scip-ingest.ts
- packages/indexer/src/scip-runner.ts
- packages/indexer/src/pagerank.ts
- packages/code-map/src/parse.ts
- packages/code-map/src/structure.ts
- packages/code-map/src/import-sites.ts
- packages/code-map/src/grammar-wasm-repair.ts
- sdk/src/services/language-intelligence.ts
- sdk/src/services/harness-intelligence.ts

### Domains
- security
- correctness
- state-mutation
- error-handling
- performance
- dependency-hygiene
- test-coverage
- api-contract
