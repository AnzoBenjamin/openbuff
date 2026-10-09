# Audit findings: shard-parse-index

- Subsystems: code-map-parse-tier, code-map-structure-chunks, code-map-grammar-wasm-lifecycle, indexer-store-persistence, indexer-query-retrieval, indexer-metadata-graph, indexer-semantic-tier, indexer-walk-freshness
- Features: tree-sitter-wasm-parse-tier, wasm-grammar-repair-download, incremental-parse-reuse, token-caller-graph, structure-symbols-call-sites, code-chunks-extraction, chunk-sidecar-freshness, metadata-graph-build, import-resolution-heuristics, bm25-postings-query, graph-neighborhood-boost, semantic-cosine-blend, json-index-store-locking, file-walk-ignore-policy, repo-map-prototype
- Files covered: 15
- Snapshot: 4fc76b0bd48a0b11d651b8f4647bb302dc95344c8b5749411ed1f5fcc3e7a0ba

## [HIGH] performance — packages/code-map/src/parse.ts:109 — Parse tier: single-threaded sequential WASM tree-sitter; parallel native parse is the one genuine throughput unlock, but budgets and reuse caches cap today's exposure
- **Risk:** The parse tier is the strongest speed case for native code: web-tree-sitter is single-threaded (one JS-emscripten parser per language), every file is parsed sequentially via awaited parseTokensForScoring, and captures cross the WASM/JS boundary per node. A cold first-ever build of a large repo pays this fully. However, incremental reuse already bounds steady-state cost to changed files, and the walker/parse budgets (20k walk cap, 10k parse cap) mean current exposure is capped by design.
- **Fix:** Do not pull native parsing earlier than P6 on throughput grounds alone. Keep P6-T7 gated on X-2, but shape the X-2 benchmark now to measure the cold full parse (first-ever build) with the existing reuse caches disabled, not the steady-state refresh. If cold-parse latency for a 10k-file repo proves product-painful, a rayon-parallel native parse (one parser per worker thread; grammars are Send once loaded) is the correct first native crate, and it slots into the D8 fresh cargo workspace without touching the TS API contract (FileTokenData is plain data).
- **Evidence:** languages.ts:28-30 imports web-tree-sitter and Language; :205-235 UnifiedLanguageLoader.loadLanguage awaits Language.load(wasmPath) (WASM grammar) and createLanguageConfig caches one Parser/Query per language (:355-385). parse.ts:146-225 getFileTokenScores awaits parseTokensForScoring sequentially per file in fairParseOrder (no concurrency); parse.ts:635-660 parseFile runs parser.parse + query.captures on the JS main thread. Budgets parse.ts:23-27 (DEFAULT_MAX_PARSE_FILES 10_000, 1MB/file, 500MB total). Reuse caches: parse.ts:155-158 (reuseParsed), metadata-indexer.ts:118 parsedCacheByRoot, and parseData is persisted inside metadata.json (metadata-indexer.ts:622-635 createMetadataIndex; index-store.ts:185 saveIndex), so steady-state refreshes re-parse only changed files (metadata-indexer.ts:340-376).

## [MEDIUM] performance — packages/code-map/src/parse.ts:475 — Token scoring + caller graph is full-recompute on every build even when parses were reused; CPU-bound but pure-JS arithmetic
- **Risk:** Incremental updates skip tree-sitter for unchanged files but the scoring/caller pass is still full-recompute: getFileTokenScores runs scoreFileTokens and buildTokenCallers over every file in the merged set, so an agent edit re-runs O(total identifiers + total calls x candidates) JS work each refresh. This is a CPU-bound hot loop, but it is map/array arithmetic, not parsing — a native port buys little and duplicates a contract that tests pin.
- **Fix:** Optimize in TS first (persist tokenScores per file like ParsedFileTokens and merge instead of recomputing; the same-language caller contract at parse.ts:503-527 is already a pinned, test-covered rule that survives a port). Only escalate to a rayon kernel if X-2 shows this pass dominating after the parse fix. No capability is unlocked here by going native — it is pure arithmetic over Maps.
- **Evidence:** parse.ts:454-473 scoreFileTokens iterates all identifiers per file; parse.ts:475-536 buildTokenCallers builds a token->definitions map over all tokenScores then loops fileCallsMap x calls x candidates with a per-candidate filter allocation; parse.ts:538-548 boostScoresByExternalCalls rewrites every (file, token) score. metadata-indexer.ts:340-376 and 460-496 pass ALL allCodeFilePaths to getFileTokenScores with reuseParsed so cached files skip tree-sitter but are still fully re-scored.

## [MEDIUM] correctness — packages/code-map/src/structure.ts:355 — assignDepths is O(n^2) containment filtering per file — quadratic CPU-bound loop independent of parser language
- **Risk:** assignDepths is O(symbols^2): for each symbol it filters and sorts all other symbols for containment. Files with hundreds of definitions (generated code, large modules) pay quadratic cost inside the single shared parse that both structure and chunks depend on. A native tree-sitter port would inherit this unless the algorithm is fixed first — the loop is in TS, not in the parser.
- **Fix:** Fix in TS with a sorted sweep / interval stack (O(n log n)); no native involvement. This is also the right fix to land before any X-2 measurement so the benchmark does not attribute structure-walk cost to WASM tree-sitter.
- **Evidence:** structure.ts:355-374 assignDepths sorts symbols then for each calls findContainers (structure.ts:338-353) which filters ALL symbols and sorts them; the same containment filter runs again inside buildQualifiedName (structure.ts:376-379) during chunk building.

## [LOW] performance — packages/code-map/src/chunks.ts:476 — Chunk assembly has per-file quadratic loops (call-site owner scan, per-line import regexes, chunk-text substring scans) — TS-adequate at per-file scale
- **Risk:** buildChunks assigns each of up to 500 call sites to its containing chunk by scanning every chunk (O(sites x chunks)), and per-chunk import matching re-slices chunk text and substring-scans it per import name. For typical files (<100 symbols) this is negligible; for a pathological 5k-line file with many chunks it is a per-file hot loop that a native port would merely re-implement.
- **Fix:** Adequate as-is; micro-optimize (build line->chunk index once, reuse chunk text) only if profiling shows it. Native code is not justified for per-file chunk assembly.
- **Evidence:** chunks.ts:340-470 extractImportSites runs up to 4 regexes per line per language family; chunks.ts:530-560 callOwner scans every chunk per call site; chunks.ts:640-668 computes chunkText.includes(n) for every import name x chunk; buildChunks re-slices chunk text (sliceLines + join) that was already hashed.

## [HIGH] state-mutation — packages/indexer/src/index-store.ts:166 — Index persistence is whole-document JSON rewrite + fsync + ad-hoc 430-line advisory lock per refresh — the strongest case for a transactional native store (redb/sqlite), independent of parse speed
- **Risk:** The store is the largest complexity sink in the subsystem, and its cost is correctness, not speed: every refresh re-serializes the entire index (metadata.json + chunks.json sidecar + semantic vectors), fsyncs, and renames; every load re-parses the whole JSON and sanitizes it. Concurrency is handled by a ~430-line hand-rolled advisory file lock (heartbeat, pid-liveness reclaim, rename-verified release) that has already generated multiple reliability findings. A transactional store (redb/sqlite) — or the locked Rust index service at P6-T5 — makes all of this native behavior: incremental puts, real transactions, crash safety, no lock scaffolding. This is a capability unlock (concurrent readers + writer, partial refresh commits) that JSON cannot offer regardless of speed.
- **Fix:** Agree with the locked sequencing, with one amendment: make the on-disk format migration (not the Rust daemon) the deliverable. A redb/sqlite store behind the existing loadIndex/saveIndex signatures can land in TS or as the first index-service crate and immediately deletes the lock machinery and whole-file rewrite. Sequence the X-2 measurement to include persist cost (JSON.stringify of the full index + sidecar + fsync per refresh), which is currently invisible to a parse-only benchmark.
- **Evidence:** index-store.ts:166-199 saveIndex: withCacheLock + readJsonFile CAS + atomicWriteJson(indexPath) + best-effort atomicWriteJson(CHUNKS_FILE) in the same txn; :1074-1095 atomicWriteJson (temp file, fsync, rename, compact-JSON hack above 4096 chars); :116-119 loads parse the whole file; :757-940 withCacheLock with token-verified acquire, 30s unref'd heartbeat, pid-liveness probe (isLockOwnerDead 890-915), rename-verified reclaim (reclaimStaleLock 917-990) and release (releaseOwnedLock 995-1070). Sidecar bounds: MAX_CHUNK_SIDECAR_ENTRIES 200_000 / MAX_CHUNK_SIDECAR_BYTES 8_000_000 (:447-448).

## [MEDIUM] performance — packages/indexer/src/query-data.ts:56 — Lexical query: posting-vocabulary substring scan per token plus O(files x tokens) IDF fallback — validates the locked tantivy tier but is adequate at today's caps
- **Risk:** Lexical query is CPU-bound in pure JS: candidate expansion substring-scans the entire posting vocabulary for every token (substring-matching contract), and any token missing from postings falls back to an O(files x fields) document-frequency scan. At the 20k-file cap this is still milliseconds; the structure exists only because tantivy is not yet wired. This directly supports the locked P6-T6 tantivy decision rather than contradicting it.
- **Fix:** Keep tantivy at P6-T6 as locked; it replaces these loops wholesale and adds proper BM25 ranking, phrase queries and incremental segment merges — capabilities the hand-rolled postings cannot reach. Before then, bound the substring scan (e.g. n-gram postings for prefix matching) in TS if query latency is ever reported. The X-2 gate should measure query p99 as well as build time.
- **Evidence:** query-data.ts:46-73 getPostingCandidates iterates Object.keys(postings) (full vocabulary) per query token with includes() checks in both directions; query.ts:573-613 computeIdfForTokens falls back to fileContainsToken over Object.values(index.files) per uncached token; MAX_INDEX_AGE_MS index-store.ts:28 (5 min) with isIndexStale (:1148-1152) triggers scheduleRefreshIfNeeded in index-manager.ts.

## [MEDIUM] performance — packages/indexer/src/query.ts:444 — scoreFile + graph-neighborhood scoring are O(candidates x tokens x fields) with capped 2-hop traversal; no PageRank exists — ranking is adjacency-boost only
- **Risk:** Even with posting pre-filtering, scoreFile loops every candidate's symbols/headings/concepts/imports/chunks per token, and the graph neighborhood pass runs a 2-hop traversal per top result with per-result merge/sort. There is no PageRank or any global importance score anywhere in the subsystem: ranking is purely edge-weight adjacency boosts with hard caps (top-25 seeds, 40 second-hop edges, 5 related files). Native code would not speed this meaningfully at 20k files; what a native tier unlocks here is capability (PageRank/SCIP-grade global ranking over the full graph), which is an R-C track feature, not a P6 prerequisite.
- **Fix:** TS-adequate at current caps. If global importance ranking is wanted (the real 'repo map at scale' feature), land it as a native capability alongside the P6-T5/T6 index service where the graph already lives; a native port of the existing 2-hop boost alone buys nothing.
- **Evidence:** query.ts:444-520 scoreFile loops tokens x (symbols, headings, concepts, imports, chunks) per candidate file; :653-692 scoreGraphNeighborhood takes the top 25 direct results and pulls getRelatedFiles per seed; :700-760 getRelatedFiles walks adjacency with secondHopEdges.slice(0, 40) and re-merges related lists per result. metadata-indexer.ts:1637-1648 dedupeEdges keys every edge into a Set at build time.

## [MEDIUM] performance — packages/indexer/src/semantic.ts:63 — Semantic search is a scalar-JS linear scan of all file vectors per query — the clearest small-scope native kernel candidate (earlier than the full parse tier)
- **Risk:** Every blended query does a full linear scan: one cosine similarity in scalar JS per indexed file (~20k x ~1536 dims ≈ 30M multiply-adds plus allocations) before sort. This is the single most quantifiable hot loop in the subsystem and the easiest native candidate: a SIMD/batched dot-product kernel does not need the full daemon and could land well before P6 as a small napi kernel, which is exactly the X-2-gated category the plan allows.
- **Fix:** This is the cheapest genuine native win: a batched dot-product/argmax kernel (or a usearch/hnsw ANN index) inside the D8 cargo workspace as a napi kernel — small surface, plain-data contract, and X-2 can measure it in minutes. Do it as evidence for the gate rather than a full parse tier; keep the JS scalar path as the WASM-era fallback per the locked parity rule.
- **Evidence:** semantic.ts:63-75 cosineSimilarity is a scalar for-loop; :205-217 semanticSearch maps it over every vector then sorts; index-manager.ts: searchSemantic passes the full filtered vector set (this.fileVectors) per blended query; vectors are persisted as JSON number arrays (index-store.ts saveSemanticVectors SEMANTIC_VECTOR_FILE).

## [MEDIUM] performance — packages/indexer/src/file-walker.ts:297 — File walk is sequential async readdir/lstat with per-directory ignore() matcher rebuild; live watching is only a host-side patch over a 5-minute staleness heuristic
- **Risk:** The cold walk is sequential awaited syscalls with an ignore() matcher rebuilt per directory and per walk (no cross-walk caching); this is I/O-bound, so a parallel native walker speeds cold builds but the bigger unlock is feature-level: a native daemon with notify gives true live watching. Today freshness is approximated by a 5-minute staleness window plus an optional CLI workspace watcher forwarding markPathsChanged — the indexer package itself has no watcher and no incremental directory state. This is the clearest 'features beyond speed' justification for the locked P6-T5 Rust daemon (D1 lists notify).
- **Fix:** Keep at P6-T5 as locked (notify + the ignore crate in the Rust daemon). The immediate TS improvement is caching ignore matchers per directory across a single walk and gating hashing on mtime+size; the watcher gap is a product decision (resident daemon) rather than a language one, because a Bun-native watcher could also be built if wanted earlier.
- **Evidence:** file-walker.ts:297-391 recursive walk: awaited lstat + readdir per directory, entries.sort per dir, ignore() constructed per directory, awaited Promise.all ignore-file loads (loadDirectoryIgnorePatterns :528-540); staleness heuristic index-store.ts:28 + :1148-1152; watcher integration is host-side only (cli/src/utils/index-workspace-watcher.ts calls IndexManager.markPathsChanged; index-manager.ts markStale/markPathsChanged ~200-280).

## [MEDIUM] performance — packages/indexer/src/metadata-indexer.ts:279 — Refresh path re-hashes every walked file (O(project bytes) sha256) every ~5 minutes even without a precise delta; the real incremental cost is hashing/import resolution, not tree-sitter
- **Risk:** In the non-precise-delta refresh path, every walked file is re-read and sha256-hashed on every refresh (mtime/size changes alone still hash); at a 500MB-budget repo this is the dominant refresh cost, likely larger than all tree-sitter work combined. Import resolution adds O(imports x ~30 candidate probes) map lookups per file via resolveModuleCandidates. These CPU-bound loops are pure TS I/O and hashing — a native tier does not address them, and they would pollute any parse-focused X-2 benchmark.
- **Fix:** TS fix first: stat (mtime+size) before hashing, hash only when stats differ from the indexed entry — no native code needed. Ensure the X-2 evidence gate counts hashing+walk bytes, otherwise it will understate TS-path cost and mis-attribute it to WASM parsing.
- **Evidence:** metadata-indexer.ts:262-303 updateMetadataIndex loops all files calling hashFile/hashBinaryFile; :279 hashFile await; :1301-1306 hashFile reads+hashes full content; parseData persisted via createMetadataIndex (:622-635) into metadata.json (index-store.ts:185); collectPreciseWalk (:1104-1148) limits the walk only when mutationDelta.complete === true.

## [MEDIUM] dependency-hygiene — packages/code-map/src/grammar-wasm-repair.ts:227 — Pinned-WASM grammar repair (network download + sha256 + re-verify) is WASM-only capital that a native grammar tier deletes outright
- **Risk:** A 400-line checksum-pinned network download/verify/repair module plus Bun/Windows bunfs path workarounds in init-node exist solely because grammars ship as emscripten WASM loaded at runtime. Native grammars compiled into a Rust daemon binary delete this entire distribution, hashing, retry, and path-resolution surface (and its attack surface: remote executable bytes). This is a real capability/reliability argument for the native tier that is independent of parsing speed — but it only applies to the binary distribution path; SDK consumers need the WASM fallback regardless.
- **Fix:** Use as supporting (not primary) evidence for P6-T7: the native tier eliminates this module for the CLI binary, but the locked WASM-until-parity fallback must keep it for the SDK. Do not accelerate native parsing for this reason alone; the repair path is well-tested and fail-open.
- **Evidence:** grammar-wasm-repair.ts:17-127 PINNED_GRAMMAR_ASSETS (15 pinned sha256s, one vendored gdscript sourceUrl); repairGrammarWasm (:227-330) fetch/retry/verify; resolveGrammarWasmSource (:332-405) re-verification. languages.ts:230-250 loadLanguage falls back to tryResolveFromPackage then repair only when CODEBUFF_IS_BINARY + CODEBUFF_WASM_DIR; init-node.ts:34-95 resolveTreeSitterWasm bunfs/sibling/env workarounds.

## [LOW] correctness — packages/indexer/src/metadata-indexer.ts:898 — Call/import resolution is regex + candidate-probing heuristics (up to ~30 extension probes per import, re-resolved per caller per build) — a capability ceiling, not a speed problem
- **Risk:** The calls graph is built from raw-name matching with language-family filters and import-set intersection; resolution probes up to ~30 extension/index candidates per import and re-resolves every import for every caller on each build. It is heuristic by design (documented conservative contract), so a native rewrite would produce the same ambiguous results faster. This is a quality ceiling the SPEC correctly assigns to SCIP/LSP tooling, not to the parse tier language.
- **Fix:** Keep TS. If call-resolution quality is the goal, the roadmap's SCIP/LSP items (R-C track) deliver it; a Rust rewrite of these heuristics would replicate the same ambiguity rules at the same quality.
- **Evidence:** metadata-indexer.ts:898-975 buildModuleAwareCallEdges builds the definitions map over all parseData then loops callers x calls with per-call filters and resolveImportToFile re-resolution; :1490-1600 resolveImportToFile branches per language with resolveModuleCandidates probing sourceExtensions + index/__init__/mod candidates (30+ files map probes per import).

## [LOW] state-mutation — packages/indexer/src/index-manager.ts:64 — IndexManager carries ~300 lines of detached-instance forwarding/epoch-mirror/CAS machinery that a single-owner native daemon service subsumes
- **Risk:** Because the manager is in-process under a single event loop but persists to a shared directory, it needs detached-holder forwarding, epoch mirroring, CAS-on-builtAt, and post-save snapshot verification — several hundred lines of defensive concurrency that a single-owner resident index service (locked P6-T5 Rust daemon) would subsume. This is evidence FOR the locked plan's daemon direction, not for accelerating the parse tier; nothing here justifies native code before P6.
- **Fix:** Supports the locked plan; no change needed. When the P6-T5 daemon lands, the manager becomes a thin protocol client and this machinery retires with it — a concrete de-duplication payoff to log against the daemon task.
- **Evidence:** index-manager.ts:getInstance (:64-115) eviction + embedder rewire; forwardPendingMutationsTo (:196-225); markStale/markPathsChanged forward+epoch-mirror blocks (:230-290); _build CAS-race handling (:470-530) with loadIndex verification and on-disk fallback; isSameIndexSnapshot (:905-925) full per-file hash comparison on every persist.

## [LOW] performance — packages/indexer/src/chunk-freshness.ts:22 — Chunk freshness sidecar and repo-map prototype are pure bounded TS — explicitly WASM/TS-adequate, no native case
- **Risk:** Sidecar build/validation and chunk-freshness evaluation are bounded, pure, fail-closed TS logic with no hot loops beyond sorted key assembly over capped entries; the repo-map renderer is explicitly prototype-only. No native alternative is warranted; these are also the cleanest existing contracts to carry verbatim across any future store migration.
- **Fix:** No action. Keep the sidecar's stableChunkId/contentHash contract frozen (it is already a clean versioned interface) so the P6 store migration does not change freshness semantics.
- **Evidence:** chunk-freshness.ts:22-100 buildChunkSidecar pure builder with caps (100/file re-applied); :150-262 evaluateChunkFreshness inline-hash fallback; index-store.ts:449-655 sidecar save/load with strict validation and byte cap; repo-map.ts:33-63 buildRepoMap slices + localeCompare sort, prototype-only per its own doc comment.

## [LOW] api-contract — packages/indexer/src/query.ts:573 — Snapshot-identity contract (computeIndexSnapshotId, WeakMap caches keyed on immutable index objects) is the frozen interface a native tier must preserve
- **Risk:** Query-side correctness leans on WeakMap caches keyed by MetadataIndex object identity and on a content-addressed snapshotId algorithm shared between index-manager and index-store; any native tier must reproduce the identity semantics (immutable snapshot objects, sorted-path digest) or staleness/verification guarantees drift. This is a portability risk to record against the future native tier, not a current defect.
- **Fix:** Preserve these identity rules verbatim when migrating to a native store/tier; if the index lives in a Rust daemon at P6-T5, the snapshotId algorithm becomes the cross-language contract and deserves golden vectors in the X-1 fixture set before the port.
- **Evidence:** query.ts:573-613 idfCache WeakMap keyed on the immutable MetadataIndex object; query.ts:250-253 adjacencyCache WeakMap; index-store.ts:236-244 computeIndexSnapshotId content-addressed over sorted path+hash; index-manager.ts getSnapshotIdentity snapshotCache (:540-565) keyed on object identity.

## Coverage receipt

### Subsystems
- code-map-parse-tier
- code-map-structure-chunks
- code-map-grammar-wasm-lifecycle
- indexer-store-persistence
- indexer-query-retrieval
- indexer-metadata-graph
- indexer-semantic-tier
- indexer-walk-freshness

### Features
- tree-sitter-wasm-parse-tier
- wasm-grammar-repair-download
- incremental-parse-reuse
- token-caller-graph
- structure-symbols-call-sites
- code-chunks-extraction
- chunk-sidecar-freshness
- metadata-graph-build
- import-resolution-heuristics
- bm25-postings-query
- graph-neighborhood-boost
- semantic-cosine-blend
- json-index-store-locking
- file-walk-ignore-policy
- repo-map-prototype

### Files
- packages/code-map/src/languages.ts
- packages/code-map/src/parse.ts
- packages/code-map/src/structure.ts
- packages/code-map/src/chunks.ts
- packages/code-map/src/grammar-wasm-repair.ts
- packages/code-map/src/init-node.ts
- packages/indexer/src/index-manager.ts
- packages/indexer/src/index-store.ts
- packages/indexer/src/metadata-indexer.ts
- packages/indexer/src/query.ts
- packages/indexer/src/semantic.ts
- packages/indexer/src/repo-map.ts
- packages/indexer/src/file-walker.ts
- packages/indexer/src/chunk-freshness.ts
- packages/indexer/src/query-data.ts

### Domains
- performance
- correctness
- state-mutation
- error-handling
- dependency-hygiene
- api-contract
