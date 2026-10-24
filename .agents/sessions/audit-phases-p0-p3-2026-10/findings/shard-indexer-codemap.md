# Audit findings: shard-indexer-codemap

- Subsystems: indexer-code-graph, indexer-scip-ingest, indexer-scip-runner, indexer-import-resolution, indexer-pagerank, indexer-index-store, indexer-index-manager, indexer-metadata-indexer, indexer-query, indexer-query-data, code-map-import-sites, agent-runtime-token-counter, common-language-capability-manifest, perf-baseline-script
- Features: stat-gated-rehashing, bounded-vocabulary-scan, scip-fail-closed-ingestion, scip-runner-subprocess-bounds, scip-offthread-parse-worker, pagerank-iteration-epsilon-clamps, conservative-import-resolution, tsconfig-alias-resolution, token-count-cache-bounds, exact-tokenizer-seam, frozen-capability-manifest-v1, perf-baseline-parity-rows, incremental-index-refresh, cache-lock-ownership, snapshot-verification, semantic-vector-cache
- Files covered: 17
- Snapshot: 5c80253b458f8b07b8ca33e50cc3d6ad7e6cda07ef1715ba8adffd8c77905ab7

## [MEDIUM] security — packages/indexer/src/metadata-indexer.ts:661 — 3D derived-metadata concepts ingested from a workspace-writable artifact file with only shallow validation
- **Risk:** Model-controlled content injected into agent context through query results and concept-based ranking; arbitrary prose in a workspace-writable artifact file becomes trusted index vocabulary.
- **Fix:** Validate concept shape against an allowlist (charset/length), strip control characters, or gate derived-metadata ingestion behind an explicit trust signal so untrusted workspace files cannot author index concepts.
- **Evidence:** JSON.parse(await fs.promises.readFile(path.join(params.projectRoot, ...metadataRelativePath.split('/')), 'utf8')) as { sourceHash?: string; concepts?: unknown } followed by concepts.filter((concept): concept is string => typeof concept === 'string' && concept.length <= 160).slice(0, 202) and concepts = [...concepts, ...metadata.concepts...] — no charset or content validation before the strings enter the index.

## [LOW] security — packages/indexer/src/metadata-indexer.ts:1150 — Raw package.json script commands and CI run: lines persisted verbatim as index concepts and surfaced in query snippets
- **Risk:** A malicious manifest can seed long, instruction-shaped strings into every command-discovery query result (prompt-injection surface via commandMatchedSnippets and explainResult).
- **Fix:** Cap each concept's length (the 160-entry cap bounds count only) and normalize shell/URL payloads before persisting them as query-facing text.
- **Evidence:** concepts.add(`script:${name}=${command}`) in extractPackageJsonConcepts and concepts.add(isRunCommand ? trimmed : `run:${trimmed}`) in extractCiWorkflowConcepts — the 160-entry cap bounds count, not per-entry length.

## [MEDIUM] security — packages/indexer/src/scip-ingest.ts:350 — SCIP symbol strings have no length cap and are persisted verbatim as edge labels that surface in query output
- **Risk:** A hostile dump can plant arbitrarily long, instruction-shaped strings into the persisted graph that later render into query explanations and related-file 'via' fields.
- **Fix:** Cap symbol length in parseOccurrence (e.g. 512 chars) and truncate or hash labels before persisting them into the graph.
- **Evidence:** parseOccurrence checks typeof symbol === 'string' && symbol.length === 0 rejection only; scipEdges sets label: occurrence.symbol, and query.ts reasonForEdge/via render edge labels into explanations.

## [LOW] security — packages/indexer/src/scip-runner.ts:712 — scip-* indexer binaries resolved from PATH by bare name and executed with cwd=projectRoot
- **Risk:** An untrusted repository can execute its own code with the agent's privileges when a user opts into SCIP ingest (supply-chain execution surface, comparable to npm scripts but less visible).
- **Fix:** Document the trust model prominently, resolve against explicitly configured absolute paths, or require per-binary user confirmation before first execution.
- **Evidence:** runSingleIndexer calls runner({ command: entry.bin, argv: entry.indexArgv(root, outputPath), cwd: root, ... }) with entry.bin = 'scip-typescript' etc.; spawn resolves unqualified names against PATH, which typically includes ./node_modules/.bin in agent/CLI environments.

## [LOW] security — packages/indexer/src/index-store.ts:1010 — Cache-lock liveness probe trusts pid from lock file content but is correctly conservative
- **Risk:** A locally crafted lock file can name an arbitrary pid, but the probe is signal-0 only and treats EPERM as alive, so there is no signal-delivery or kill-foreign-process risk; ambiguity fails conservative (no reclaim).
- **Fix:** None required; document that lock-file pids are attacker-influenceable only within the same-user cache dir and are used solely for liveness probing.
- **Evidence:** isLockOwnerDead parses content.split('\n', 1)[0].split(':', 1)[0] as pid and calls process.kill(pid, 0); signal-0 cannot inject signals and EPERM is treated as alive, so the worst case is a spurious keep-alive verdict.

## [LOW] correctness — packages/indexer/src/metadata-indexer.ts:240 — Stat-gated hashing is a documented two-check gate but still admits a write landing between stat and hash
- **Risk:** A file modified between the fresh stat and the later content read is treated as unchanged for this refresh; the index lags by one refresh cycle until the next mutation signal.
- **Fix:** Accept the documented tradeoff but re-stat after hashing changed files (or document the stat→hash race alongside the touch-less-write caveat) so the gate's coverage claim is accurate.
- **Evidence:** The stat gate requires indexed.mtime === stat.mtimeMs && indexed.size === stat.size && indexed.mtime === file.mtime && indexed.size === file.size; the comment names the touch-less-write gap, but the stat→hash race window (write between fs.promises.stat and hashFile) is also unhandled and undocumented.

## [LOW] correctness — packages/indexer/src/pagerank.ts:96 — Damping clamp allows exactly 1.0, where power iteration need not converge on periodic graphs
- **Risk:** With damping=1 on a periodic strongly-connected graph the stationary distribution may not exist, so returned scores are an arbitrary iterate rather than a converged ranking — silently skewed blend results for pageRankWeight > 0.
- **Fix:** Clamp damping to (0, 1) exclusive, or document that damping=1 on periodic graphs returns an unconverged iterate.
- **Evidence:** sanitize(params.damping, DEFAULT_PAGERANK_DAMPING, 0, 1) permits 1.0; the loop runs at most MAX_PAGERANK_ITERATIONS (200) with no convergence warning and returns the last iterate.

## [LOW] correctness — packages/agent-runtime/src/util/token-counter.ts:520 — IncrementalTokenCounter stores systemAndToolsTokens but messagesTokens never includes it
- **Risk:** A caller that stores the system/tools count but sums only messagesTokens() silently under-counts context, or one that adds it twice over-counts; either direction flips compaction/eviction triggers.
- **Fix:** Expose totalTokens(messages) that adds the stored system/tools count, or remove the unused field and make the caller-owned addend explicit at the call site.
- **Evidence:** setSystemAndToolsTokens(tokens) writes this.systemAndToolsTokens and reset() zeroes it, but messagesTokens returns only the per-message sum; the class docstring promises a 'number-identical contract with the whole-history path', which this field's non-participation can violate depending on caller discipline.

## [MEDIUM] correctness — packages/indexer/src/query-data.ts:80 — getPostingDocumentFrequency reports the cap-truncated candidate union as document frequency, skewing IDF for frequent tokens
- **Risk:** For a very frequent token with no exact posting, the reported df is clamped at 4096 while the true df may be far larger, inflating that token's IDF weight and over-ranking common-term matches across the corpus.
- **Fix:** Return undefined (forcing the whole-corpus fallback in computeIdfForTokens) when the candidate union saturated the cap, so frequent tokens get an accurate df.
- **Evidence:** getPostingDocumentFrequency returns getPostingCandidates(index, [normalized])?.size when documentFrequencies lacks the token; getPostingCandidates breaks its vocabulary scan at candidates.size >= MAX_POSTING_CANDIDATE_PATHS (4096), and computeIdfForTokens feeds that number into Math.log((total + 1) / (df + 1)) + 1.

## [LOW] correctness — packages/code-map/src/import-sites.ts:216 — Go import-block close detection treats any line containing ')' as the block terminator
- **Risk:** A Go import block whose closing paren line carries trailing content keeps inGoImportBlock true, so subsequent non-import lines with backquoted strings are captured as import specifiers — phantom graph edges.
- **Fix:** Tighten the block-exit match to a bare close (optionally with a trailing comment) and require the close on its own line, matching gofmt output.
- **Evidence:** const spec = line.match(/^\s*(?:[\w.]+\s+)?["`]([^"`]+)["`]\s*(?:\/\/.*)?$/) runs while inGoImportBlock is true; a spec line with a trailing inline comment after the quote but before other text, or a closing line with trailing content, is mishandled.

## [LOW] correctness — packages/indexer/src/index-manager.ts:995 — mergeMutationDeltas revision comparison is numeric-aware but falls back to 'next wins' on incomparable types
- **Risk:** A numeric revision racing a non-numeric revision resolves to the incoming one regardless of intent; harmless for well-formed monotonic revisions but surprising for mixed workspaces.
- **Fix:** Document the mixed-type comparison contract (or coerce both to strings in the tie case) so revision ordering is deterministic across type boundaries.
- **Evidence:** const revision = current?.revision !== undefined && next.revision !== undefined && compareRevisions(current.revision, next.revision) > 0 ? current.revision : (next.revision ?? current?.revision) — when compareRevisions returns 0 for incomparable mixed types the first branch is false, but the fallback still picks next.revision, so ordering among mixed-type revisions is arbitrary rather than documented.

## [MEDIUM] state-mutation — packages/indexer/src/metadata-indexer.ts:113 — parsedCacheByRoot.set bypasses evictOldestRootCacheIfNeeded, defeating the MAX_INDEXED_PROJECT_ROOTS bound on the build/update paths
- **Risk:** A long-lived process that calls buildMetadataIndex on many distinct project roots grows the full-tree parse cache (one Record per root, each holding every file's parsed tokens) without bound — the exact unbounded-memory shape MAX_INDEXED_PROJECT_ROOTS was added to prevent.
- **Fix:** Route all parsedCacheByRoot writes through a single setParsedCache(projectRoot, data) helper that performs the eviction check before inserting.
- **Evidence:** buildMetadataIndex and updateMetadataIndex call parsedCacheByRoot.set(projectRoot, parseData) directly; evictOldestRootCacheIfNeeded is only invoked from getParsedCache() and loadTsAliases(), so the bound is advisory on these write paths.

## [LOW] state-mutation — packages/indexer/src/scip-runner.ts:660 — inFlightDetections entries are removed only on settle; a never-settling probe leaks the entry and parks all joined waiters
- **Risk:** A runner seam that never settles (a custom/injected AsyncScipRunner without its own timeout) leaves every concurrent caller awaiting forever and accumulates one map entry per stuck key — leaked async work plus unbounded map growth over many roots.
- **Fix:** Race the probe against a hard timeout so it always settles, or cap/sweep inFlightDetections entries older than DETECTION_TIMEOUT_MS.
- **Evidence:** const probe = (async () => { ... finally { if (inFlightDetections.get(key) === probe) inFlightDetections.delete(key) } })() — the finally runs only when the promise settles; detectionCache is trimmed to 64 entries but inFlightDetections has no cap or deadline.

## [MEDIUM] error-handling — packages/indexer/src/metadata-indexer.ts:590 — Transient read failure inside indexWalkedFile deletes a still-existing file from the index (the hash-failure keep-previous guard does not cover it)
- **Risk:** A transient EBUSY/EACCES-style read failure between hashing and re-reading silently removes a still-existing file from the index — its symbols, chunks, and graph edges vanish until the next successful refresh, degrading query recall with no diagnostic.
- **Fix:** Return a typed result distinguishing 'file unreadable' from 'file deleted' (e.g. via a stat check or a sentinel) and treat unreadable like the hashReadFailedPaths branch: keep the previous entry.
- **Evidence:** hashReadFailedPaths.add(file.relativePath); changedFiles.push(file); continue happens on hash failure, but in the later loop `if (indexed) { updatedFiles[...] = indexed } else if (hashReadFailedPaths.has(...) && existing.files[...]) { /* keep */ } else { delete updatedFiles[file.relativePath] }` — indexWalkedFile returning null for a non-hash-read-failed path falls to the delete branch.

## [LOW] error-handling — packages/indexer/src/scip-runner.ts:850 — Worker-load failure silently degrades every ingest to a full main-thread 256MiB JSON.parse, defeating the off-thread guarantee with no surfaced status
- **Risk:** In a compiled build where the worker script is persistently unloadable, every near-cap 256MiB dump JSON.parse blocks the event loop for seconds per ingest — the exact heap-spike/latency pathology the worker was introduced to prevent, repeated indefinitely and invisibly.
- **Fix:** Memoize worker unavailability (or consecutive worker failures) for the process lifetime and surface the degraded mode in status, so the main-thread fallback engages once and is observable.
- **Evidence:** worker.on('error', () => { settle(() => { try { resolve(deriveScipDumpEdges(filePath)) } catch (derivationError) { reject(derivationError) } }) }) — deriveScipDumpEdges reads and JSON.parses the dump synchronously on the main thread; there is no memoization of worker failure so every subsequent dump repeats the stall.

## [LOW] error-handling — packages/indexer/src/metadata-indexer.ts:262 — Hash-read failure path swallows the error entirely and pushes the file into changedFiles, re-reading it later in the same pass
- **Risk:** A persistently unreadable file is silently retried every refresh with zero observability — the index neither flags the gap nor stops retrying, and users see stale recall with no explanation.
- **Fix:** Record a diagnostic (e.g. a ParseDiagnostic-style entry or coverage counter) when hash reads fail so operators can distinguish transient I/O degradation from a healthy refresh.
- **Evidence:** catch { hashReadFailedPaths.add(file.relativePath); changedFiles.push(file); continue } — the comment says 'Stat failures fall back to hashing, preserving the previous behavior' but hash failure pushes the file into the re-parse path where it can be re-read and (per the separate indexWalkedFile finding) dropped or re-derived with no degraded-state marker beyond a silent continue.

## [MEDIUM] performance — packages/indexer/src/index-store.ts:920 — atomicWriteJson always pays a full pretty-print serialization before discarding it for large documents
- **Risk:** Every saveIndex of a large index serializes the whole document twice (pretty + compact), roughly doubling CPU and transiently holding ~2× the artifact size in strings on each refresh — the hot path this wave was guarded for.
- **Fix:** Estimate size cheaply (e.g. file count or a compact serialize first for known-large artifact kinds) and only produce the pretty form for small documents.
- **Evidence:** const pretty = JSON.stringify(value, null, 2); const payload = pretty.length > PRETTY_PRINT_MAX_CHARS ? JSON.stringify(value) : pretty — the pretty form is materialized first and discarded for every large artifact.

## [MEDIUM] performance — packages/indexer/src/index-store.ts:68 — loadIndex and readSemanticVectorCache read and JSON.parse with no byte cap; only the chunk sidecar has MAX_CHUNK_SIDECAR_BYTES
- **Risk:** A corrupt or foreign multi-hundred-MB metadata.json (or semantic-vectors.json) in the cache dir is fully buffered and JSON.parsed on the main thread before validation, stalling the event loop and spiking the heap on every load attempt — the same dump-shape hazard SCIP ingestion caps at 256MiB with a stat-first guard.
- **Fix:** Apply the sidecar pattern to both files: stat before read, refuse payloads over a documented byte cap, and treat oversize as a cache miss (rebuild).
- **Evidence:** const content = await fs.promises.readFile(indexPath, 'utf8') then JSON.parse(content) — no stat/size check; the sidecar loader immediately below does `if (content.length > MAX_CHUNK_SIDECAR_BYTES) return null`.

## [LOW] performance — packages/indexer/src/query.ts:470 — scoreFile is O(queryTokens × per-file field sizes) per candidate with no early termination
- **Risk:** With a 4096-file candidate union, 20 query tokens, and files carrying up to 30 symbols / 120 concepts / 100 chunks each, scoring approaches O(candidates × tokens × fields) per query on the synchronous hot path; no early exit exists once a file's rank position is already secure.
- **Fix:** Acceptable given the existing caps; consider persisting a per-file normalized token set in queryData so scoring can early-exit per field, or short-circuit fields whose weight contribution cannot change the top-limit outcome.
- **Evidence:** for (const token of tokens) { ... for (const sym of file.symbols) ... for (const h of file.headings) ... for (const concept of file.concepts) ... for (const imp of file.imports) ... (file.chunks ?? []).filter(...) } over filesToScore (up to MAX_POSTING_CANDIDATE_PATHS = 4096 candidates, or all files when postings are absent).

## [LOW] dependency-hygiene — common/package.json:25 — Duplicate `ignore` dependency across workspace packages at two major versions (5.3.2 pinned vs ^7.0.5)
- **Risk:** Two major versions of the same library ship in one bundle: duplicated install size, divergent ignore-rule behavior between the walker (v5) and any v7 consumer, and double maintenance burden for security patches.
- **Fix:** Align both packages on one major (7.x) or isolate the walker's ignore usage so only one copy ships.
- **Evidence:** common/package.json: "ignore": "5.3.2"; packages/indexer/package.json: "ignore": "^7.0.5". Both packages are linked into the same application surface.

## [LOW] dependency-hygiene — common/package.json:18 — @types/pg, @types/readable-stream, @types/seedrandom shipped as runtime dependencies
- **Risk:** Type-only packages inflate the runtime dependency graph, get installed for consumers that never compile types, and can trigger peer/version conflicts in downstream installs.
- **Fix:** Move the three @types packages to devDependencies.
- **Evidence:** dependencies includes "@types/pg": "^8.11.10", "@types/readable-stream": "^4.0.18", "@types/seedrandom": "^3.0.8" with no separate devDependencies beyond @types/parse-path.

## [LOW] dependency-hygiene — packages/agent-runtime/package.json:15 — gpt-tokenizer caret range spans minor versions whose behavior the code documents as load-bearing (2.9.0 allowedSpecial semantics)
- **Risk:** A minor bump can silently change BPE density or special-token handling that ANTHROPIC/GEMINI fudge factors (1.35/1.1) were calibrated against, shifting compaction triggers without any code change.
- **Fix:** Pin to the calibrated minor (e.g. ~2.9.0) or add a calibration test in the token-counter suite that fails when tokenizer density drifts from the fudge-factor assumptions.
- **Evidence:** "gpt-tokenizer": "^2.8.1" resolves through 2.9.x; the source comment states 'allowedSpecial:"none" is not a valid value in gpt-tokenizer 2.9.0 — it throws TypeError', i.e. the module's correctness depends on minor-version-specific encode semantics.

## [MEDIUM] test-coverage — packages/indexer/src/scip-runner.test.ts:241 — No test drives a real SIGTERM-ignoring child through defaultAsyncScipRunner; timeout coverage is seam-only
- **Risk:** A regression in Node's timeout/SIGTERM mapping (or a stream handler that keeps the promise unsettled after close) ships untested: runScipIngest would either hang awaiting the runner or misreport a killed indexer as a clean exit.
- **Fix:** Add one test spawning a SIGTERM-ignoring child through defaultAsyncScipRunner asserting the runner settles within deadline + grace and that escalation occurs, mirroring perf-baseline CASE 13.
- **Evidence:** scip-runner.test.ts line 241 'reports timeout status when the indexer is killed' drives the fake runner's status to null; defaultAsyncScipRunner's real close/signal/error interleaving (including BoundedStreamCapture teardown under SIGTERM) has no process-level test, unlike diagnostic-delta-runner which gained perf-baseline CASE 13 for exactly this class.

## [LOW] test-coverage — packages/indexer/src/index-store.test.ts:1 — No test loads an oversized/truncated metadata.json or semantic-vectors.json and asserts a null miss without unbounded buffering
- **Risk:** The unbounded-read behavior (and any future cap) is unverified: a regression that reintroduces full-buffer parsing of hostile artifacts would pass the suite.
- **Fix:** Add error-path tests alongside the byte-cap fix: oversized artifacts must return null (miss → rebuild) without unbounded buffering.
- **Evidence:** index-store.test.ts covers save/load round-trips, CAS, and lock reclaim; loadChunkSidecar's MAX_CHUNK_SIDECAR_BYTES bound has no counterpart test for loadIndex or readSemanticVectorCache (which have no cap at all — see the separate performance finding).

## [LOW] test-coverage — packages/indexer/src/metadata-indexer.test.ts:88 — The fresh-stat gate and the hashReadFailedPaths keep-previous-entry path in updateMetadataIndex lack direct tests
- **Risk:** The transient-read-failure preservation behavior (and the cache bound) can regress silently; the deletion regression described in the error-handling finding would not fail any current test.
- **Fix:** Add a test forcing a read failure between hashing and indexWalkedFile and asserting the previous entry survives (pairs with the error-handling finding), plus a cache-eviction test driving >MAX_INDEXED_PROJECT_ROOTS roots through buildMetadataIndex.
- **Evidence:** metadata-indexer.test.ts covers hash-unchanged reuse and same-size content changes, and p8/p8-lite suites cover parserDegraded delta re-queueing, but the keep-previous branch (`else if (hashReadFailedPaths.has(file.relativePath) && existing.files[file.relativePath]) { /* keep */ }`) has no test, and neither does parsedCacheByRoot eviction on the build/update write paths.

## [LOW] api-contract — packages/indexer/src/index-store.ts:745 — saveChunkSidecar return type changed Promise<void> → Promise<boolean> (source-documented ABI break for .d.ts consumers)
- **Risk:** Callers compiled against the previous .d.ts silently ignore the boolean and cannot distinguish a committed sidecar write from a rejected one; TypeScript accepts the new signature wherever the old one was expected, so the break is invisible at compile time.
- **Fix:** Record the break in the changelog; consider a named SaveResult type if further boolean returns land here.
- **Evidence:** Docstring: 'this function previously returned Promise<void> and silently dropped invalid input; it now returns Promise<boolean>... consumers built against the previous .d.ts should re-baseline and branch on the boolean'.

## [LOW] api-contract — packages/indexer/src/scip-ingest.ts:130 — Two exported merge entrypoints with different return shapes for the same operation (mergeScipIntoIndex vs mergeScipEdgesIntoIndex)
- **Risk:** New callers picking the older entrypoint get no merged-edge count and may compute the delta wrong (0/negative per the documented supersede semantics), silently misreporting ingest results.
- **Fix:** Deprecate mergeScipIntoIndex or re-express it over the batch form so one merge shape is canonical and edge accounting has one contract.
- **Evidence:** export function mergeScipIntoIndex(index, scip): MetadataIndex versus export function mergeScipEdgesIntoIndex(index, preciseEdges): { index: MetadataIndex; edgesMerged: number } — the docstring of ingestScipDump warns 'A raw graph-edge length delta would net to 0 here (and go negative...)', which is exactly the mistake a mergeScipIntoIndex caller makes.

## [LOW] api-contract — common/src/util/language-capability-manifest.ts:85 — Manifest schema does not enforce the documented 'every supported language present exactly once' invariant on deserialized data
- **Risk:** A serialized manifest missing one or more languages validates successfully, so consumers that trust the schema's docstring contract will ship a partial capability manifest and fall back silently for the missing languages.
- **Fix:** Add a z.refine (or superRefine) requiring Object.keys to equal SUPPORTED_LANGUAGE_IDS, or switch to a strict object shape keyed by the enum so deserialized manifests honor the documented invariant.
- **Evidence:** languages: z.record(z.enum(SUPPORTED_LANGUAGE_IDS), languageCapabilitySchema) accepts a record containing any subset of the enum keys; the JSDoc on the schema asserts 'every supported language must be present exactly once' — buildLanguageCapabilityManifest guarantees it by construction, but parse() of an external manifest does not.

## [LOW] state-mutation — scripts/measure-perf-guards-baseline.ts:160 — Baseline script's global run-state (activeRuns/activeWarmups/activeIterationsScale, rows, sink) is module-scoped mutable state with no reentrancy guard
- **Risk:** Two concurrent runPerfGuardsBaseline calls (library mode is explicitly supported — the smoke test calls it) would interleave case rows, corrupt the shared rows array, and apply each other's runs/warmups/scale overrides; no process-lifetime leak exists, but measurement integrity and the child-process bookkeeping in CASE 13 are not reentrancy-safe.
- **Fix:** Move the run state into a per-invocation context object passed to the runCase* functions so library callers can run concurrently; document the single-flight constraint in the module docstring meanwhile.
- **Evidence:** let activeRuns = RUNS; let activeWarmups = WARMUP_RUNS; let activeIterationsScale = 1; const rows: CaseRow[] = []; let sink = 0 — runPerfGuardsBaseline resets them at entry and mutates across every case; CASE 12/13 spawn real children whose cleanup sits in finally blocks (bounded), but interleaved invocations would share rows/activeRuns mid-run.

## Coverage receipt

### Subsystems
- indexer-code-graph
- indexer-scip-ingest
- indexer-scip-runner
- indexer-import-resolution
- indexer-pagerank
- indexer-index-store
- indexer-index-manager
- indexer-metadata-indexer
- indexer-query
- indexer-query-data
- code-map-import-sites
- agent-runtime-token-counter
- common-language-capability-manifest
- perf-baseline-script

### Features
- stat-gated-rehashing
- bounded-vocabulary-scan
- scip-fail-closed-ingestion
- scip-runner-subprocess-bounds
- scip-offthread-parse-worker
- pagerank-iteration-epsilon-clamps
- conservative-import-resolution
- tsconfig-alias-resolution
- token-count-cache-bounds
- exact-tokenizer-seam
- frozen-capability-manifest-v1
- perf-baseline-parity-rows
- incremental-index-refresh
- cache-lock-ownership
- snapshot-verification
- semantic-vector-cache

### Files
- packages/indexer/src/query-data.ts
- packages/indexer/src/metadata-indexer.ts
- packages/indexer/src/query.ts
- packages/indexer/src/index-manager.ts
- packages/indexer/src/index-store.ts
- packages/indexer/src/scip-ingest.ts
- packages/indexer/src/scip-runner.ts
- packages/indexer/src/import-resolution.ts
- packages/indexer/src/pagerank.ts
- packages/code-map/src/import-sites.ts
- packages/agent-runtime/src/util/token-counter.ts
- common/src/util/language-capability-manifest.ts
- scripts/measure-perf-guards-baseline.ts
- packages/indexer/package.json
- packages/agent-runtime/package.json
- common/package.json
- packages/code-map/package.json

### Domains
- security
- correctness
- state-mutation
- error-handling
- performance
- dependency-hygiene
- test-coverage
- api-contract
