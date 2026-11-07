# Audit findings: cb-code-intel

- Subsystems: packages, rust, cli
- Features: file-walking, hashing, tree-sitter-wasm-parse, symbol-extraction, import-resolution, call-graph, bm25-scoring-postings, embeddings-cosine, persistence-locking, watching, index-orchestration-daemon, repo-map, chunk-freshness-retrieval-eval, asset-refs
- Files covered: 26
- Snapshot: 49801b44e84d3d8fa583c3ebd9b2855228bf122572b7cdf5f78c77b3389d824d

## [HIGH] performance — packages/indexer/src/file-walker.ts:369 — File walking: MOVE to Rust (ignore crate WalkParallel)
- **Risk:** Current mechanism: single-threaded async recursive walk; every directory does await lstat + await readdir + await loadDirectoryIgnorePatterns, builds a fresh npm `ignore` matcher per dir and tests every entry against ALL ancestor matchers (matchers.some over the parent chain), then lstat per file. Serial awaits (await walk(abs, matchers)) mean zero I/O parallelism; per-entry cost grows with directory depth. On 100k+ file monorepos this dominates cold build and every non-precise refresh (updateMetadataIndex falls back to full walk). Needs: throughput, bounded memory, parallelism. Best-in-class: Rust `ignore` (ripgrep's walker: parallel, gitignore/.ignore semantics, compiled globsets); Go: godirwalk/fastwalk; Zig: no mature gitignore lib.
- **Fix:** Implement walk in a Rust `openbuff-index` crate using ignore::WalkBuilder::build_parallel with custom filters mirroring DEFAULT_EXCLUDE_DIRS, isMandatorySensitiveReadPath, isGeneratedOperationalArtifact, symlink no-follow, MAX_FILE_SIZE and per-prefix fair-share cap; emit WalkedFile records over the sidecar protocol. Keep TS walker as fallback when sidecar unavailable. Add parity test corpus (file-walker.test.ts fixtures) run against both. Unlocks now: 5-10x faster cold walk (verify); later: shared walk for daemon, cross-repo roots, gix-based dirty-set via git index instead of walking.
- **Evidence:** file-walker.ts:341-513 (walkProjectDetailed), :369-478 (walk: serial await, per-dir ignore().add, matchers.some ancestor scan), :515-525 loadIgnorePatterns; indexer/package.json ignore ^7.0.5 (also an open range, not pinned). Cost: M (~1-2 wk) — Rust workspace exists but is empty (rust/Cargo.toml no workspace deps; lib.rs only workspace_protocol_version), so first crate also pays for sidecar spawn/handshake + 5-target release builds. Confidence: high on mechanism; speedup magnitude needs benchmarking/web verification.

## [LOW] performance — packages/indexer/src/metadata-indexer.ts:1327 — Hashing: KEEP (co-locate with walker later)
- **Risk:** Current: node:crypto SHA-256 (native OpenSSL) over utf8-decoded file content (hashFile) or streamed bytes (hashBinaryFile); stat-gated so unchanged files skip read+hash; chunk ids also sha256 (chunks.ts:140). Hash itself is native-speed; cost is the extra utf8 decode and serial per-file awaits in updateMetadataIndex loop, not the language. Rust gain alone (blake3/xxh3) is marginal vs. crossing a process boundary per file.
- **Fix:** Keep in TS. When the walker moves to Rust, compute content hashes there in the same parallel pass (keep sha256 for compatibility of persisted hash / chunk ids; blake3 only with an INDEX_VERSION bump). Minor TS win now: hash raw Buffer instead of utf8 string to avoid decode, and parallelize the stat+hash loop with bounded concurrency.
- **Evidence:** metadata-indexer.ts:1327-1344 hashFile/hashBinaryFile/hashContent; :270-312 stat-gated hashing in updateMetadataIndex (serial for-await); chunks.ts:140-162 sha256Hex/deriveChunkId; index-store.ts:456-464 snapshot id sha256. Cost: none now; S when bundled with walker. Confidence: high.

## [HIGH] performance — packages/code-map/src/languages.ts:249 — Tree-sitter WASM parse: MOVE to Rust native tree-sitter + rayon
- **Risk:** Current: web-tree-sitter 0.25.10 WASM, one Parser per language on the main JS thread; parseFile does parser.parse then query.captures and materializes node.text strings across the WASM boundary. Budgets (10k files, 1MB/file, 500MB total) exist because it is slow and single-threaded. Large operational burden: pre-init sibling-wasm hack for bun --compile on Windows, env/globalThis channels, runtime grammar download+sha256 repair from network, 15 grammar .wasm assets plus two wasm grammar packages (@vscode/tree-sitter-wasm and tree-sitter-wasms) pinned. Needs: multi-core throughput, low memory, incremental reparse (tree.edit) for daemon.
- **Fix:** Parse in Rust: tree-sitter crate + statically linked grammar crates (tree-sitter-typescript, -python, -rust, -go, ...), rayon par_iter over files, one Parser per thread, run the same .scm queries (tree-sitter-queries/*.scm are portable). Return identifiers/calls/symbol ranges as compact records. Keep WASM path as fallback for SDK consumers without the sidecar. Unlocks now: all cores used, removes parse budgets truncation on big repos, deletes wasm-shipping/repair code paths in the binary; next: incremental reparse with retained trees in a daemon, and grammars for more languages without shipping wasm.
- **Evidence:** languages.ts:249-299 UnifiedLanguageLoader (Language.load, repairGrammarWasm fallback at :283-293); init-node.ts:33-111; parse.ts:13-28 budgets, :350-409, :635-660 parseFile; cli/src/pre-init/tree-sitter-wasm.ts:1-97 (documents failed embedding attempts on Windows); grammar-wasm-repair.ts:214-321 network repair; wasm-files.ts:1-20 (15 grammars); code-map/package.json deps. Cost: M-L (2-3 wk): grammar crate version alignment with tree-sitter ABI, C toolchain in cross builds, query parity tests (structure.test.ts, chunks.test.ts). Confidence: high on architecture; native-vs-wasm per-file speed ratio (commonly cited 2-5x) needs web verification.

## [MEDIUM] correctness — packages/code-map/src/structure.ts:794 — Symbol extraction: MOVE with parser; CONSUME SCIP for precise symbols
- **Risk:** Current: iterative DFS over WASM tree with heuristic definitionKind/extractDefName/extractTypeInfo per language, plus a second captures pass for call sites (capped 500); chunks.ts derives chunk ids from these. Every node access crosses the JS<->WASM boundary, so this walk is costlier than the parse. Heuristic names are syntactic only — no scopes, no type resolution, overload ambiguity.
- **Fix:** Port the DFS (or use tree-sitter-tags crate with the existing *-tags.scm) into the Rust parse pass so symbols come out in one native traversal. For precision, CONSUME SCIP indexers (scip-typescript, rust-analyzer scip, scip-python, scip-java, scip-go) as optional enrichers keyed by file hash; universal-ctags as fallback for grammar-less languages. Keep chunk-id derivation byte-identical (path+qualifiedName+kind+sha256) so persisted ids survive.
- **Evidence:** structure.ts:794-1008 parseStructureOnce (DFS, header/doc/type extraction, captures loop :963-995); chunks.ts:148-162 deriveChunkId. Cost: M (bundled with parse move); SCIP consumption S-M per language but each indexer is a separate toolchain (node/JVM/rust-analyzer) — opt-in only. Confidence: medium-high; SCIP indexer coverage/maintenance status needs web verification.

## [MEDIUM] correctness — packages/indexer/src/metadata-indexer.ts:1516 — Import resolution: CONSUME oxc-resolver (TS/JS) + SCIP; drop duplicated regexes
- **Risk:** Current: per-language regex import extraction (metadata-indexer.ts:1025-1105) duplicated with a second, divergent line-regex set in chunks.ts:340-474; resolution is hand-rolled (relative paths, tsconfig paths via loadTsAliases, Go module suffix match, Java/PHP dotted paths). Misses package.json exports/imports conditions, workspace symlinks, index resolution variants, multi-line imports; resolveImportToFile is called O(imports) per file twice (buildGraph and buildModuleAwareCallEdges) and Go suffix fallback scans Object.keys(files) per import (O(N) each).
- **Fix:** Extract imports from the tree-sitter parse (import_statement nodes) in the Rust pass, single source of truth. Resolve TS/JS via oxc-resolver (Rust crate, also has napi binding usable from TS today — CONSUME immediately even before daemon) which implements enhanced-resolve semantics incl. tsconfig paths/exports. For other languages keep heuristics but precompute path->file maps once. Precise cross-file edges from SCIP where available. stack-graphs is NOT recommended: GitHub archived the project (verify).
- **Evidence:** metadata-indexer.ts:1025-1105 extractImports, :1385-1428 loadTsAliases, :1516-1624 resolveImportToFile (Go suffix O(N) scan :1605-1621), :790-813 and :958-968 double resolution; chunks.ts:340-474 extractImportSites duplicate regexes. Cost: S for oxc-resolver napi in TS now; M in Rust. Confidence: high on current gaps; oxc-resolver napi Bun compatibility and stack-graphs archival need web verification.

## [MEDIUM] correctness — packages/indexer/src/metadata-indexer.ts:924 — Call graph: CONSUME SCIP (precise) — prerequisite for TIA
- **Risk:** Current: file-level 'calls' edges from bare-name matching — a call resolves only if exactly one same-language file (preferring imported files) defines an identifier with that name; plus tokenCallers edges. No method receivers, no scopes; common names produce no edge, collisions produce wrong edges. Output is file->file only, so no symbol-level call graph and no test-impact analysis.
- **Fix:** Keep heuristic edges as fallback in TS (cheap). Add a SCIP ingestion path (in the Rust index crate) that loads index.scip occurrences into symbol-level def/ref edges keyed by file hash, enabling symbol call graph, 'who calls X', and TIA (map changed symbols -> reachable tests). Later in daemon: incremental SCIP re-index per changed package.
- **Evidence:** metadata-indexer.ts:924-1003 buildModuleAwareCallEdges (definitions Map by identifier name, unique-candidate rule :983-989); :893-907 tokenCallers edges; parse.ts:475-536 buildTokenCallers. Cost: M-L (SCIP protobuf parsing is easy via `scip` Rust crate; running language indexers is the cost). Confidence: medium; scip crate API needs verification.

## [MEDIUM] performance — packages/indexer/src/query-data.ts:61 — BM25/scoring + postings: KEEP scoring in TS now; MOVE index to tantivy (or zoekt) with daemon
- **Risk:** Current: custom TF-IDF-ish scorer (log((N+1)/(df+1))+1 IDF, weighted field substring matches, path-depth decay) — not BM25. Postings persisted as JSON Record<token,string[]> inside metadata.json; substring matching scans the entire posting vocabulary per query token (Object.keys(postings) loop), and scoreFile does linear scans of symbols/headings/concepts/imports/chunks per token. Fine at 10k files, degrades linearly with vocabulary; no phrase/trigram search, no cross-repo.
- **Fix:** Scoring weights and ranking heuristics are product logic iterated frequently — keep in TS. When the Rust daemon exists, put postings in tantivy (BM25, fast fields, prefix/ngram tokenizers replace the vocabulary substring scan, segment-based incremental updates) and return candidate sets + field hits to TS for final blend. For cross-repo/code-content search, CONSUME zoekt (Go, trigram) as a separate sidecar rather than reimplementing. Near-term TS fix: build a sorted vocabulary / n-gram map once per load instead of Object.keys per query.
- **Evidence:** query-data.ts:26-59 buildIndexQueryData, :61-101 getPostingCandidates (vocab scan :87-99); query.ts:417-557 scoreFile, :573-613 computeIdfForTokens (fallback full-file scan :597-601). Cost: tantivy M (after daemon); zoekt M (Go toolchain, separate binary). Confidence: medium; tantivy/zoekt fit high, sizes where JSON postings break need benchmark.

## [LOW] performance — packages/indexer/src/semantic.ts:63 — Embeddings/cosine search: KEEP (brute force fine); usearch later
- **Risk:** Current: file-level vectors as number[] (boxed doubles), brute-force cosine over all vectors per query, recomputing both norms each time; vectors persisted as JSON; embedding itself is an external EmbedFn (network/model) and dominates latency. At <=10k-50k files x ~1k dims, brute force is ms-scale; ANN adds little until chunk-level or cross-repo vectors.
- **Fix:** Keep in TS. Cheap wins: store Float32Array, pre-normalize at build so search is a dot product, persist as binary sidecar instead of JSON. Move to usearch (Rust/C++, also has JS binding) or LanceDB inside the daemon only when moving to chunk-level vectors or cross-repo corpora (>~1M vectors).
- **Evidence:** semantic.ts:63-75 cosineSimilarity, :116-194 buildFileVectors (hash-keyed reuse), :196-215 semanticSearch (map/sort all); index-store.ts:223-318 JSON vector cache; index-manager.ts:858-899 searchSemantic filters then brute force. Cost: trivial now; M for ANN. Confidence: high.

## [MEDIUM] performance — packages/indexer/src/index-store.ts:154 — Persistence + locking: MOVE with daemon (single writer, incremental store)
- **Risk:** Current: whole MetadataIndex (files, graph, parseData, postings) serialized via JSON.stringify and atomically rewritten + fsync on every refresh, then re-read and deep-compared for verification (index-manager.ts _build). Cross-process safety relies on a hand-rolled lockfile with heartbeat, pid liveness, rename-verified stale reclaim (~130 lines of subtle code with many past reliability findings). Cost is O(index size) per single-file edit; memory spikes from stringify of large objects; every lane/process loads its own full copy.
- **Fix:** In the Rust daemon, be the single writer (eliminates withCacheLock), store per-file records in an embedded KV (redb or SQLite) plus tantivy segments so an edit rewrites only affected rows; serve reads over the protocol. Until then, TS mitigation: split parseData/queryData into separate files so small edits don't rewrite everything.
- **Evidence:** index-store.ts:154-199 saveIndex, :757-884 withCacheLock, :1074-1094 atomicWriteJson (full stringify + fsync); index-manager.ts:564-684 _build (save then loadIndex+isSameIndexSnapshot verify). Cost: M-L, coupled to daemon. Confidence: high on mechanism.

## [HIGH] correctness — cli/src/utils/index-workspace-watcher.ts:26 — Watching: MOVE to Rust notify (+debouncer) in daemon
- **Risk:** Current: node:fs watch recursive with 75ms debounce, ignore filtering done after events arrive, per-event existsSync/statSync on the hot path, max 4 roots. Explicitly DISABLED on Linux under Bun because Bun's recursive watcher holds fds for the whole subtree (EMFILE -> SIGILL in HTTP client). So Linux users (CI, devcontainers, most servers) get no live index — only age-based sweeps and explicit SDK deltas. Rename/delete classification is extension-guessing.
- **Fix:** Implement watching in Rust with notify + notify-debouncer-full (inotify/FSEvents/ReadDirectoryChangesW), filtered by the same ignore matchers as the walker before registering inotify watches (so node_modules never consumes watches), emitting precise changed/deleted deltas to IndexManager.markPathsChanged. Optionally consume watchman when present. Unlocks now: live incremental index on Linux; next: one watcher per repo shared by all lanes/processes.
- **Evidence:** index-workspace-watcher.ts:26-35 supportsRecursiveIndexWorkspaceWatcher returns false on linux+bun; :37-74 classify with existsSync/statSync; :88-160 fs.watch recursive + 75ms flush; :12 MAX_WATCHED_ROOTS=4. Cost: S-M (notify is mature; inotify watch-limit handling needed). Confidence: high; notify behavior on large trees (inotify max_user_watches) needs verification.

## [HIGH] performance — packages/indexer/src/index-manager.ts:564 — Index orchestration: MOVE to Rust live index daemon shared across lanes
- **Risk:** Current: IndexManager is an in-process singleton per (root,config) inside each CLI/SDK process; epochs, pending mutation deltas, degraded re-queue, detached-instance forwarding all exist to reconcile multiple holders. Parallel lanes/agents each build, hold, persist and race on the same index (hence CAS on builtAt + lockfile). Memory and CPU are multiplied per lane; no cross-repo view.
- **Fix:** Introduce the planned Rust `index` sidecar (lib.rs already names shim/jobd/index/lanes crates and a version handshake) as a per-user daemon owning walk+watch+parse+store for N repos; TS IndexManager becomes a thin client (query/queryBlended/markPathsChanged over the protocol) with current in-process path as degraded fallback. Unlocks now: one index per repo for all lanes, no lock races; next: cross-repo search, symbol call graph, TIA queries, retained parse trees for incremental reparse.
- **Evidence:** index-manager.ts:290-321 markPathsChanged forwarding/epoch mirroring, :564-684 _build CAS/verify/requeue; rust/crates/openbuff-workspace-harness/src/lib.rs:1-16 (sidecar crates planned, protocol v1 constant only); rust/Cargo.toml empty workspace deps. Cost: L (4-6 wk): daemon lifecycle, IPC protocol, per-platform binaries in npm release, fallback parity. Confidence: medium-high; highest-leverage item in this shard.

## [LOW] correctness — packages/indexer/src/repo-map.ts:57 — Repo map: KEEP in TS
- **Risk:** Current: prototype-only renderer (not on default query path) — alphabetical sort, maxFiles slice, fixed-weight substring scoring. Pure formatting over already-built index data; no throughput concern. Quality gap is ranking (no graph centrality), not language.
- **Fix:** Keep TS. If promoted, add PageRank/personalized PageRank over index.graph (cheap in TS at file granularity) before truncation; consume daemon-provided symbol graph later.
- **Evidence:** repo-map.ts:57-75 buildRepoMap, :198-241 scoreRepoMapEntry. Cost: none. Confidence: high.

## [LOW] correctness — packages/indexer/src/chunk-freshness.ts:160 — Chunk freshness + retrieval-quality eval: KEEP in TS
- **Risk:** Pure, bounded, no-I/O predicates (FRESH/STALE/ORPHAN/SNAPSHOT-OLD) and offline metric computation (recall@k, MRR, nDCG). Tightly coupled to TS tool contracts and eval harness; no performance pressure.
- **Fix:** Keep TS. Ensure any Rust-side chunk id/hash derivation is byte-identical to chunks.ts deriveChunkId so freshness verdicts remain valid across the migration; retrieval-quality.ts should be the gate for every language move above (compare TS vs Rust retrieval parity).
- **Evidence:** chunk-freshness.ts:160-261 evaluateChunkFreshness; retrieval-quality.ts:47-132 evaluateRetrievalQuality. Cost: none. Confidence: high.

## [LOW] correctness — packages/indexer/src/asset-refs.ts:399 — Game-engine asset refs: KEEP in TS
- **Risk:** Regex/text extraction of Unity GUID, Godot res://, Unreal, Bevy refs; niche, low volume, product-specific. Only perf note: reads full text of large .unity/.prefab YAML files serially via indexWalkedFile.
- **Fix:** Keep TS; if the walker/parse moves to Rust, optionally emit raw text only for these extensions and leave extraction in TS.
- **Evidence:** asset-refs.ts:399-440 extractAssetRefs; metadata-indexer.ts:806-864 GUID resolution in buildGraph. Cost: none. Confidence: high.

## Coverage receipt

### Subsystems
- packages
- rust
- cli

### Features
- file-walking
- hashing
- tree-sitter-wasm-parse
- symbol-extraction
- import-resolution
- call-graph
- bm25-scoring-postings
- embeddings-cosine
- persistence-locking
- watching
- index-orchestration-daemon
- repo-map
- chunk-freshness-retrieval-eval
- asset-refs

### Files
- packages/code-map/package.json
- packages/indexer/package.json
- packages/code-map/src/parse.ts
- packages/code-map/src/languages.ts
- packages/code-map/src/chunks.ts
- packages/code-map/src/structure.ts
- packages/code-map/src/init-node.ts
- packages/code-map/src/grammar-wasm-repair.ts
- packages/code-map/src/wasm-files.ts
- packages/code-map/src/utils.ts
- packages/code-map/src/tree-sitter-queries
- packages/indexer/src/index-manager.ts
- packages/indexer/src/index-store.ts
- packages/indexer/src/metadata-indexer.ts
- packages/indexer/src/file-walker.ts
- packages/indexer/src/query.ts
- packages/indexer/src/query-data.ts
- packages/indexer/src/semantic.ts
- packages/indexer/src/repo-map.ts
- packages/indexer/src/chunk-freshness.ts
- packages/indexer/src/asset-refs.ts
- packages/indexer/src/retrieval-quality.ts
- cli/src/utils/index-workspace-watcher.ts
- cli/src/pre-init/tree-sitter-wasm.ts
- rust/crates/openbuff-workspace-harness/src/lib.rs
- rust/Cargo.toml

### Domains
- performance
- correctness
- dependency-hygiene
