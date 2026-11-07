# Audit findings: p3-coherence-g-scip-imports

- Subsystems: packages-indexer, packages-code-map, plan-doc-polyglot-roadmap-v2
- Features: P3-T4-scip-ingestion, P3-T5-import-resolution
- Files covered: 16

## [HIGH] correctness — .agents/sessions/polyglot-roadmap-v2/PLAN.md:103 — P3-T5 MISMATCH: plan claims import extraction 'from tree-sitter import nodes'; the landed extraction is line-based regex with no tree-sitter import-node capture anywhere
- **Risk:** PLAN.md:103 [x] '(DONE: landed — real import resolution from tree-sitter import nodes + the ecosystem resolver...)' contradicts source: extraction never touches a tree-sitter tree. Earlier audits (polyglot-reaudit w1-code-map) recommended tree-sitter @import captures + oxc-resolver and the task is recorded done under that mechanism; readers credit tree-sitter multi-line precision that the regex extractor does not have.
- **Fix:** Re-word PLAN.md:103 to the landed mechanism ('shared line-based import-site extraction + per-ecosystem conservative resolvers'), or actually land tree-sitter @import captures in the tags.scm queries and consume them in the shared extractor.
- **Evidence:** packages/code-map/src/import-sites.ts is the canonical extractor used by both chunks.ts (:104) and import-resolution.ts (:92-119) — it matches one rawLine at a time (TS fromMatch /\b(?:import|export)\b[^'"]*\bfrom\s+['"]([^'"]+)['"]/, Go single-line match + an import-block state machine at :219-260); its own header says extraction 'never re-parses — tree-sitter already parsed the file for structure/call sites', i.e. imports are regex-only. code_search for import_statement|import_specifier across packages/code-map/src returns 0 matches; the tree-sitter-queries/*.scm files carry no @import captures. The multiline TS gap is patched by a second regex (import-resolution.ts:100-109 IMPORT_REGEX), still not AST-based.

## [MEDIUM] correctness — packages/indexer/src/import-resolution.ts:243 — P3-T5 'the ecosystem resolver (ts.resolveModuleName, etc.)' is not landed: no ts.resolveModuleName (or oxc-resolver) anywhere in the indexer; resolution is hand-rolled
- **Risk:** PLAN.md:103 names ts.resolveModuleName as the resolver; source uses a hand-rolled extension/index candidate prober plus a custom tsconfig paths loader. Gaps vs a real resolver (package.json exports/imports conditions, project references, moduleResolution bundler) persist despite the DONE claim; earlier session findings (plan-RC, w2-plan-p3-p4) already recommended oxc-resolver over ts.resolveModuleName, so the shipped code matches neither the plan text nor the recommended replacement.
- **Fix:** Either land a real resolver (oxc-resolver napi, or ts.resolveModuleName with a parsed CompilerHost) for the TS/JS tier, or reword the plan parenthetical to the hand-rolled conservative resolver that actually shipped.
- **Evidence:** resolveImportToFile (import-resolution.ts:243-354) resolves via resolveModuleSpecifier (import-sites.ts:322-348 extension/index/__init__.py/mod.rs candidate list) and resolveAliasImport (:141-176 wildcard tsconfig paths); aliases are loaded by metadata-indexer.ts:1392-1438 via hand JSON.parse of the tsconfig extends chain. code_search for resolveModuleName|from 'typescript' across the repo matches only scripts/generate-*.ts and a cli test — zero in packages/indexer. The per-ecosystem tiers that DID land and match the 'ecosystem resolver' description: Python top-level-dir gate (:289-307, memoized via WeakMap :196-211), Rust crate::-only crate-root fallback (:268-287 with the audit-G comment), JVM/PHP declared-package gate (:356-390), Go go.mod module-prefix gate (:326-352). Tests: import-resolution.test.ts:46-293 pin each tier.

## [MEDIUM] api-contract — packages/indexer/src/index-manager.ts:810 — P3-T4: the SCIP runner and ingest are reachable ONLY from tests — no CLI command, no tool, no production path invokes runScipIngest/ingestScipDump, yet the plan marks the task [x] DONE without an ACCEPTED note
- **Risk:** PLAN.md:102 'run scip-typescript/... when available and merge precise edges into the indexer graph' reads as a working capability; in practice nothing can trigger it. The indexer package exports the symbols (index.ts:89-116) but referencedBy lists only test files. Sibling precedent: P3-T9 recorded rankedRepoMap's no-production-consumer state as ACCEPTED in the plan text, and P3-T6's unwired enrichment drew a MEDIUM in sibling shards; P3-T4 carries no such note.
- **Fix:** Add an explicit ACCEPTED/eval-utility note to PLAN.md:102 (like the P3-T9 precedent) or wire a surface (e.g. an 'openbuff index --scip' CLI flag or an index-refresh config knob) that actually invokes runScipIngest.
- **Evidence:** runScipIngest / detectAvailableScipIndexers(+Async) referencedBy = packages/indexer/src/scip-runner.test.ts only; IndexManager.ingestScipDump referencedBy = packages/indexer/src/index-manager.test.ts only; code_search for 'scip' in cli/src returns 0 matches; sdk/src/mcp/server.ts calls waitUntilReady/queryBlended but nothing scip-related. The capability itself is real and bounded (see the MATCHES anchors in this shard) — it is just unreachable outside tests.

## [MEDIUM] performance — packages/indexer/src/scip-ingest.ts:348 — SCIP symbol strings are unbounded: only a non-empty check guards occurrence.symbol, and the symbol is copied verbatim into the edge label — the reported 'bounded symbol labels' remediation is absent from source
- **Risk:** A legitimate or hostile dump can carry arbitrarily long SCIP symbol descriptors (scip-* symbols are long dotted descriptors); with up to SCIP_MAX_MERGED_EDGES=50,000 edges per merge and SCIP_MAX_OCCURRENCES_PER_DOCUMENT=20,000 per document (with no document-count cap), multi-KB labels are retained in the in-memory graph handed to IndexManager.ingestScipDump consumers. Count caps bound edge COUNT, not label SIZE.
- **Fix:** Cap the label at edge-construction time (e.g. slice to a documented max, mirroring metadata-indexer's 160-char concept guard) or reject over-long symbols as malformed in parseOccurrence.
- **Evidence:** scip-ingest.ts:343-356 parseOccurrence validates only `symbol.length === 0`; scipEdges builds `label: occurrence.symbol` verbatim in the IndexEdge (~:355); no slice/length cap for symbol strings exists anywhere in scip-ingest.ts or scip-runner.ts (code_search for symbol-length/slice caps matches only unrelated files). metadata-indexer.ts:605 shows the codebase's own capping pattern for derived strings (concept.length <= 160) — SCIP labels lack the equivalent.

## [LOW] correctness — packages/indexer/src/scip-ingest.ts:168 — The SCIP merge drops the ENTIRE queryData (postings + documentFrequencies included), while its doc comment claims it 'drops the persisted adjacency accelerator'
- **Risk:** After any merge, lexical posting/IDF acceleration is also discarded until the next full rebuild; the query path degrades gracefully (getPostingCandidates returns null on missing postings and callers fall back to corpus counting), so correctness holds, but the doc understates the discarded state and repeated opt-in merges keep queries on the slow path.
- **Fix:** Re-word the comment ('drops the persisted query accelerator — adjacency AND postings; consumers rebuild or fall back') or preserve postings (they are edge-independent) and drop only the adjacency map.
- **Evidence:** mergeScipIntoIndex :165-170 and mergeScipEdgesIntoIndex :250-255 both `delete next.queryData`; query-data.ts:63-68 getPostingCandidates reads index.queryData?.postings and returns null when absent; query.ts:977-983 getAdjacency rebuilds from graph.edges when the persisted map is missing; scip-ingest.test.ts:310-322 pins the queryData drop under the test name 'drops the stale persisted adjacency accelerator' (the test name repeats the understatement).

## [LOW] correctness — packages/indexer/src/types.ts:59 — P3-T4 VERDICT: MATCHES (a) — precise edges merge into the SAME graph the query path reads; the plan's 'labeled confidence:heuristic' fallback is implemented as documented absence-of-confidence (functionally equivalent)
- **Risk:** None observed for behavior; only the plan's literal wording: no source site assigns the literal confidence:'heuristic' — tree-sitter edges carry NO confidence field and types.ts documents absent === 'heuristic' so older persisted indexes round-trip unchanged.
- **Fix:** No action (optionally add a literal confidence:'heuristic' at the buildGraph edge sites to make the label explicit).
- **Evidence:** types.ts:53-59 `export type EdgeConfidence = 'heuristic' | 'precise'` with 'Absent means heuristic so older persisted indexes round-trip unchanged'; scip-ingest.ts:6-8 + :131-136/:205-210 treat `(edge.confidence ?? 'heuristic') === 'heuristic'` for supersede and stamp `confidence: 'precise'` on every merged edge; metadata-indexer.ts:883-908 and :1071-1077 push fallback edges with no confidence field; scip-ingest.test.ts:194-248 pins 'keeps heuristic edges untouched' + confidence undefined and the precise-supersedes-heuristic case. Merged edges land on the SAME MetadataIndex.graph the query path reads (query.ts getAdjacency :977-983 reads index.graph.edges; IndexManager.query → queryIndex consumes that graph), and the merge drops the stale adjacency accelerator so consumers rebuild (:165-170).

## [LOW] correctness — packages/indexer/src/scip-runner.ts:31 — P3-T4 VERDICT: MATCHES (b) — opt-in contract documented, refresh-time running genuinely deferred, inFlightDetections bounded, worker degradation memoized + surfaced
- **Risk:** None observed.
- **Fix:** No action.
- **Evidence:** scip-runner.ts:31-40 module header: 'Cost-control contract: NOTHING here runs automatically at refresh time... callers opt in by invoking runScipIngest (or IndexManager.ingestScipDump for an already-produced dump)'; index-manager.ts ingestScipDump doc (~:795-810): 'Automatic refresh-time scip-* running is deliberately deferred (cost control)'. Opt-in reachability: runScipIngest is invoked by no production code (see the MEDIUM reachability finding) — the deferral is documented, not silent. In-flight detections: detectionStatusAsync registers the probe synchronously before the first await, finally-deletes the entry on settle, and raceDetectionTimeout (DETECTION_PROBE_HARD_TIMEOUT_MS = 10_000) guarantees a never-settling runner seam cannot wedge the entry; detectionCache is FIFO-trimmed to MAX_DETECTION_CACHE_ENTRIES=64. Worker degradation: degradedWorkerSpawns (WeakMap per spawn seam) memoizes the first failure and recordWorkerLoadDegradation console.errors once — surfaced status, not silent per-ingest retries; parseScipDumpEdges skips the doomed spawn after the first failure and degrades to on-thread deriveScipDumpEdges (same stages/errors). Bounds: MAX_SCIP_INDEXERS_PER_CALL=8, MAX_INDEXER_CONCURRENCY=4, timeouts clamped [1s,600s], 64MiB process buffer cap, 256MiB dump-read cap, SCIP_MAX_MERGED_EDGES enforced DURING batch accumulation (batchBudget) and per-dump in runSingleIndexer.

## [LOW] correctness — .agents/sessions/polyglot-roadmap-v2/PLAN.md:102 — P3-T4 wording drift: the plan's binary list names 'rust-analyzer' but the shipped indexer table probes scip-rust
- **Risk:** Minor claim-vs-source drift; a rust-analyzer-based flow does not exist (documented in-source as a possible additional table row).
- **Fix:** Re-word PLAN.md:102 to 'scip-rust' (or land a rust-analyzer-backed row).
- **Evidence:** scip-runner.ts SCIP_INDEXER_COMMANDS rust entry uses bin 'scip-rust' with the comment 'The Rust entry uses scip-rust; a rust-analyzer-based variant would be an additional table row, not a shell-string fallback'; PLAN.md:102 names rust-analyzer in the binary list.

## [LOW] correctness — packages/code-map/src/chunks.ts:104 — P3-T5 VERDICT: MATCHES (a) — the chunks.ts duplicate import logic is genuinely gone; per-chunk extraction delegates to the shared import-sites implementation
- **Risk:** None observed.
- **Fix:** No action.
- **Evidence:** chunks.ts:99-110 'Per-chunk import extraction delegates to the canonical line-based implementation in import-sites.ts; chunks.ts keeps only the ChunkImportRef-shaped projection it has always exposed' — extractChunkImportSites (:104-150) wraps extractImportSitesFromLines; the per-language line regexes that previously lived in chunks.ts (reaudit w1-code-map cited old chunks.ts:340-474) now exist only in import-sites.ts. import-resolution.ts keeps one additional TS-only multiline IMPORT_REGEX (:100-109), explicitly documented as supplementing the per-line pass (multi-line named imports are invisible to per-line sites) — an intentional complement, not the removed duplication. STATUS.md:321 records the same dedup ('canonical line-based extraction moved to packages/code-map/src/import-sites.ts; chunks.ts delegates').

## [LOW] test-coverage — packages/code-map/src/import-sites.ts:219 — P3-T5 VERDICT: MATCHES (b) — Go import-block fix landed and pinned; real import resolution is wired into the actual index build
- **Risk:** None observed.
- **Fix:** No action.
- **Evidence:** import-sites.ts:219-260 inGoImportBlock state machine: the `import (` opener line is matched-and-stripped first so the quoted-spec matcher never scans the rest of that line; the block closes only on a bare `)` line (/^\s*\)\s*(?:\/\/.*)?$/) so a quoted path or comment containing ')' cannot terminate the block. Wired into the build: metadata-indexer.ts buildGraph :883-908 resolves every file.imports entry via resolveImportToFile into file→file 'references' edges; buildModuleAwareCallEdges :1032-1047 consumes resolved imports to disambiguate call edges; extractImports :1103-1105 delegates to extractImportSpecifiers (import-resolution.ts). Tests: import-resolution.test.ts:117-139 'extracts only quoted paths inside Go import declarations', :186-197 go.mod module-prefix gating, :141-151 no external-JS filename matching, :251-272 Python conservative rules, plus scip-ingest.test.ts (parse validation, caps, supersede, determinism) and scip-runner.test.ts (detection cache, per-indexer fail-open, worker degradation, temp-dir cleanup).

## Coverage receipt

### Subsystems
- packages-indexer
- packages-code-map
- plan-doc-polyglot-roadmap-v2

### Features
- P3-T4-scip-ingestion
- P3-T5-import-resolution

### Files
- .agents/sessions/polyglot-roadmap-v2/PLAN.md
- packages/indexer/src/scip-ingest.ts
- packages/indexer/src/scip-ingest.test.ts
- packages/indexer/src/scip-runner.ts
- packages/indexer/src/scip-runner.test.ts
- packages/indexer/src/scip-parse-worker.ts
- packages/indexer/src/import-resolution.ts
- packages/indexer/src/import-resolution.test.ts
- packages/indexer/src/metadata-indexer.ts
- packages/indexer/src/index-manager.ts
- packages/indexer/src/index.ts
- packages/indexer/src/types.ts
- packages/indexer/src/query.ts
- packages/indexer/src/query-data.ts
- packages/code-map/src/import-sites.ts
- packages/code-map/src/chunks.ts

### Domains
- correctness
- performance
- api-contract
- test-coverage
