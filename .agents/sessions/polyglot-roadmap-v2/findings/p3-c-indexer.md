# Audit findings: p3-c-indexer

- Subsystems: indexer, code-map
- Features: P3-T4-scip-ingest, P3-T5-import-resolution, P3-T9-pagerank-repo-map
- Files covered: 11
- Snapshot: f6f2d4aa162b3cc09c6d64e96f8e03bb4b430c5444981de1b88a548d1690980a

## [MEDIUM] correctness — packages/indexer/src/scip-ingest.ts:5 — P3-T4 SCIP ingestion is JSON-reader-only; no runner executes scip-typescript/python/rust-analyzer/java/go/clang/dotnet/ruby
- **Risk:** The plan's 'run ... when available' is not implemented; precise edges only arrive if something external invokes the indexers and feeds the JSON. STATUS.md's wording overstates the shipped capability, so consumers may expect self-configuring precise graphs that never materialize.
- **Fix:** Add a runner layer (spawn scip-* indexer CLIs when detected on PATH, parse their SCIP JSON via parseScipJson) or explicitly re-scope the plan item to 'consume externally produced SCIP dumps' and update PLAN.md/STATUS.md wording.
- **Evidence:** Repo-wide code_search for scip-typescript|scip-python|scip-rust|scip-java|scip-go|scip-clang|scip-dotnet|scip-ruby|scip print matches only scip-ingest.ts doc comments, scip-ingest.test.ts fixtures, and audit notes under .agents/sessions/. scip-ingest.ts exports only parseScipJson/mergeScipIntoIndex (lines 68, 112); index-manager.ts contains no scip references at all (grep returned 0 matches).

## [MEDIUM] correctness — packages/indexer/src/import-resolution.ts:270 — Python/Rust absolute bare imports resolve against local files, contradicting the module's 'conservative unresolved' contract
- **Risk:** Projects containing a file named like a stdlib/external module (json.py, log/, serde helpers) get heuristic 'references' edges to unrelated local files, polluting the graph that PageRank and queryReferences rely on.
- **Fix:** Gate absolute Python/Rust resolution on a local package/crate manifest (py package __init__.py at the module root, Cargo.toml-declared crate or src/lib.rs presence), or restrict to the documented relative/aliased forms.
- **Evidence:** import-resolution.ts:183-190 claims bare specifiers never resolve; lines 270-281 call resolveModuleSpecifier(modulePath, hasFile) for Python absolute imports and lines 246-259 do the same for Rust crate::-stripped paths (fromDir join then src/<path> fallback, line 256-259). files membership is the only guard.

## [LOW] correctness — packages/indexer/src/repo-map.ts:122 — rankedRepoMap/buildRepoMap order and tie-break paths with localeCompare, which is ICU/locale-dependent
- **Risk:** Tied PageRank scores and the repo-map text ordering can differ between machines/ICU builds, so 'deterministic, byte-identical' replay claims fail for rankedRepoMap and buildRepoMap output even though the PageRank scores themselves are deterministic.
- **Fix:** Use plain `<`/`>` byte-wise comparison as scip-ingest.ts does (scip-ingest.ts:182-188) instead of localeCompare for all path ordering.
- **Evidence:** repo-map.ts:91 `.sort((a, b) => a.path.localeCompare(b.path))`; repo-map.ts:122 `b.score - a.score || a.path.localeCompare(b.path)`; repo-map.ts:145 same tie-break in queryRepoMap. Doc comment at line 91-97 says 'deterministic'.

## [LOW] api-contract — packages/indexer/src/index-manager.ts:406 — IndexManager.query/queryBlended option types omit pageRankWeight, so IndexManager/CLI callers cannot opt in to PageRank ranking
- **Risk:** The CLI/MCP paths that go through IndexManager cannot enable the P3-T9 ranking blend; the feature is reachable only by direct queryIndex callers. Not a correctness bug (default 0 is a no-op), but the P3-T9 wiring is narrower than 'wired into query_index' implies for tool callers.
- **Fix:** Add pageRankWeight to IndexManager.query/queryBlended option types (it already flows through withConfigLexicalWeights's spread) or document that PageRank opt-in is a direct-queryIndex-only knob.
- **Evidence:** index-manager.ts query() signature lists only limit/fileTypes/pathPrefixes/mode/from/to/lexicalWeights (lines ~406-414); queryBlended mirrors it. queryIndex itself reads options.pageRankWeight (query.ts:185, 198, 245, 684).

## [LOW] test-coverage — packages/indexer/src/index.ts:44 — rankedRepoMap is exported but consumed only by pagerank.test.ts — production dead code
- **Risk:** The P3-T9 ranked repo map deliverable exists and is tested but has no production consumer; it neither feeds query_index nor any CLI/MCP tool, so its value is currently limited to offline retrieval evals.
- **Fix:** Either wire rankedRepoMap into an MCP/CLI surface (e.g. a ranked repo-map tool mode) or mark it prototype/eval-only in docs to avoid implying production availability.
- **Evidence:** Exported at index.ts:44; referencedBy for rankedRepoMap lists only packages/indexer/src/pagerank.test.ts (lines 11, 301-321). No cli/src or sdk/src references found.

## [LOW] error-handling — packages/indexer/src/scip-ingest.ts:144 — SCIP caps are fail-closed throws, not truncation: a >50k-edge dump or any single escaping path aborts ingestion entirely
- **Risk:** On large repositories a legitimate SCIP dump exceeding 50k unique cross-file edges (or containing one escaping path) aborts the entire merge rather than degrading, so precise-edge enrichment is all-or-nothing. This is deliberate fail-closed behavior, but the all-or-nothing tradeoff is undocumented in STATUS.
- **Fix:** Consider truncating with an observable diagnostic (keep the first 50k deterministic edges and record a coverage notice) instead of failing the whole merge, or document the hard ceiling.
- **Evidence:** scip-ingest.ts:144-152 throws ScipIngestError('edge-limit') when addedCount >= SCIP_MAX_MERGED_EDGES; scip-ingest.ts:128-139 throws when skippedUnsafePaths > 0. SCIP_MAX_MERGED_EDGES = 50_000 (line 21).

## [LOW] state-mutation — packages/indexer/src/scip-ingest.ts:338 — SCIP merge can invent file nodes for paths not present in index.files
- **Risk:** A SCIP dump referencing files the walker excluded (generated code, vendored-but-safe-relative paths) mints file nodes absent from index.files; getRelatedFiles guards on index.graph.nodes lookups so queries stay safe, but graph size and PageRank node count can exceed the indexed corpus.
- **Fix:** Drop precise edges whose endpoints are absent from index.files (or gate ensureFileNode on files membership) so the graph cannot reference unindexed paths.
- **Evidence:** scip-ingest.ts:338-346 ensureFileNode creates {type:'file'} nodes from edge endpoints without checking index.files; scipEdges validates only isSafeRelativePath (lines 320-331).

## [LOW] performance — packages/indexer/src/pagerank.ts:64 — PageRank node cap silently returns empty results above 50k nodes; maxIterations is caller-boundable to MAX_SAFE_INTEGER
- **Risk:** Default paths are bounded (50 iterations x edges, <=50k nodes, WeakMap adjacency per immutable index), but a caller-supplied maxIterations near MAX_SAFE_INTEGER with epsilon 0 yields unbounded iteration work; no internal ceiling exists beyond the caller's own value.
- **Fix:** Clamp maxIterations to a hard ceiling (e.g. 200) inside personalizedPageRank instead of accepting MAX_SAFE_INTEGER.
- **Evidence:** pagerank.ts:37 MAX_PAGERANK_NODES=50_000 with early return at lines 63-65; default maxIterations 50 (line 34) with sanitize bound [0, MAX_SAFE_INTEGER] at lines 50-56 and epsilon min 0 (lines 57-61) allowing a caller to force full-iteration runs.

## Coverage receipt

### Subsystems
- indexer
- code-map

### Features
- P3-T4-scip-ingest
- P3-T5-import-resolution
- P3-T9-pagerank-repo-map

### Files
- packages/indexer/src/scip-ingest.ts
- packages/indexer/src/import-resolution.ts
- packages/indexer/src/pagerank.ts
- packages/indexer/src/query.ts
- packages/indexer/src/repo-map.ts
- packages/indexer/src/types.ts
- packages/indexer/src/metadata-indexer.ts
- packages/indexer/src/index-manager.ts
- packages/indexer/src/index.ts
- packages/code-map/src/import-sites.ts
- packages/code-map/src/chunks.ts

### Domains
- correctness
- security
- state-mutation
- error-handling
- performance
- api-contract
- test-coverage
