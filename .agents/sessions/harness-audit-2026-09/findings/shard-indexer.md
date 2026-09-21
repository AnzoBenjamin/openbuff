# Audit findings: shard-indexer

- Subsystems: indexer-index-manager, indexer-index-store, indexer-query-engine, indexer-metadata-indexer, indexer-file-walker, indexer-semantic, indexer-chunk-freshness, indexer-asset-refs, indexer-repo-map, indexer-retrieval-quality, indexer-query-data, code-map-parse, code-map-structure, code-map-languages, code-map-chunks, code-map-wasm-repair, agent-runtime-query-index-tool
- Features: incremental-updates, staleness-invalidation, snapshot-identity, cache-locking-cas, cache-ownership, lexical-ranking, idf-weighting, graph-traversal, references-mode, command-discovery, semantic-embeddings, semantic-blending, vector-persistence, chunk-sidecar, chunk-freshness, asset-ref-extraction, repo-map-eval, retrieval-quality-metrics, wasm-checksum-pinning, wasm-path-resolution, parse-budgets, parse-incremental-reuse, gitignore-walking, sensitive-path-filtering, query-tool-handler, memory-first-shortcut
- Files covered: 27
- Snapshot: df9b2f192f10abc4503dfdc5a5a30643b0fd9ca84ef8d8cf5cd8988d93669cc1

## [MEDIUM] correctness — packages/indexer/src/metadata-indexer.ts:366 — Degraded-parser path drops the mutation delta and stamps a stale index as fresh
- **Risk:** When getFileTokenScores throws during an incremental refresh, the entire delta's file updates (new symbols, imports, chunks, deletions) are silently dropped AND builtAt is refreshed, re-arming the 5-minute staleness clock. The index reports fresh while missing content from edited files, so the age-based sweep does not converge until the next external markStale.
- **Fix:** On parserDegraded, keep the prior builtAt (or mark the snapshot retryable/stale) and re-queue the mutation delta via IndexManager so the next refresh re-applies it instead of stamping a degraded snapshot fresh.
- **Evidence:** updateMetadataIndex: `if (parserDegraded) { return { ...existing, builtAt: Date.now(), parseDiagnostics, coverage: ... } }` — placed before the `for (const file of changedFiles)` application loop and before deletion handling.

## [MEDIUM] correctness — packages/indexer/src/index-store.ts:419 — isMetadataIndex validates only the top-level shape; one malformed per-file entry breaks every query until rebuild
- **Risk:** A single malformed entry (e.g. files: { 'a.ts': null } or missing symbols/imports arrays from a partially-written or hand-edited cache) loads successfully and then throws inside scoreFile/querySearch on every query until a rebuild overwrites the file. The corrupt-index state persists across processes because loadIndex accepts it.
- **Fix:** Normalize/validate each IndexedFile entry at load (drop entries missing required arrays/strings), or wrap per-file scoring in query.ts with a shape guard so one bad entry degrades to a miss instead of a query failure.
- **Evidence:** isMetadataIndex ends with `value.fileCount = Object.keys(value.files).length; return true` — no per-entry shape check; query.ts scoreFile iterates `for (const sym of file.symbols)` and `for (const h of file.headings)` unguarded.

## [MEDIUM] correctness — packages/indexer/src/metadata-indexer.ts:253 — Stale-delta journal rejection mis-orders string workspace revisions
- **Risk:** The B5(c) stale-delta guard compares `string | number` values with `<`. For string revisions, lexicographic order makes '10' < '9', so a newer string revision is rejected as stale, the precise walk is skipped, and the refresh returns the existing index with only a builtAt bump — content changes are silently not incorporated until a full (non-precise) refresh happens.
- **Fix:** Normalize both revisions to a comparable form (coerce numeric strings to numbers, fall back to string equality only) before treating a delta as stale, and mergeMutationDeltas should prefer the maximum revision under the same normalization.
- **Evidence:** `if (mutationDelta?.complete === true && mutationDelta.revision !== undefined && existing.workspaceRevision !== undefined && mutationDelta.revision < existing.workspaceRevision) { return { ...existing, builtAt: Date.now() } }` with both typed `string | number` in types.ts.

## [MEDIUM] performance — packages/indexer/src/query-data.ts:66 — getPostingCandidates scans the full posting vocabulary per query token
- **Risk:** Substring matching is implemented by scanning the entire posting vocabulary for every query token (Object.keys(postings) inside the token loop). On a 20k-file repo the vocabulary is tens of thousands of tokens, so each query pays O(vocabulary x tokens) just to build the candidate set; getPostingDocumentFrequency fallbacks repeat it per token. Dominates query latency on large indexes.
- **Fix:** Build a bounded n-gram/trigram index over the posting vocabulary at build time (persisted in queryData) so substring expansion touches only candidate tokens instead of the whole vocabulary.
- **Evidence:** `const postingTokens = Object.keys(postings)` inside the per-token loop, followed by `if (indexedToken === token || (!indexedToken.includes(token) && !(indexedToken.length >= 4 && token.includes(indexedToken))))` — full-vocabulary scan per token.

## [MEDIUM] performance — packages/indexer/src/index-manager.ts:118 — Coarse markStale refresh pays a full tree walk plus full graph and postings rebuild
- **Risk:** markStale() sets forceRefresh without a delta, so updateMetadataIndex takes the non-precise branch: walkProjectDetailed re-reads every directory + stats every file, then createMetadataIndex rebuilds buildGraph (all nodes/edges, dedupeEdges string-set) and buildIndexQueryData (all postings) from scratch. Every agent edit wired through the coarse watcher signal pays this full-tree cost even though one file changed; only tree-sitter re-parsing is skipped.
- **Fix:** Narrow the non-precise walk (per-directory mtime shortcuts or a git-status fast path) and merge graph edges/queryData incrementally for unchanged files instead of rebuilding the full graph and posting lists on every refresh.
- **Evidence:** updateMetadataIndex: `preciseDelta ? await collectPreciseWalk(...) : await walkProjectDetailed(projectRoot, getIndexExcludes(config), config.maxFiles)`; createMetadataIndex unconditionally calls buildGraph + buildIndexQueryData over all files.

## [MEDIUM] performance — packages/indexer/src/index-store.ts:175 — Semantic vector cache persists all fingerprints x all files as one JSON document
- **Risk:** One semantic-vectors.json holds up to MAX_SEMANTIC_FINGERPRINTS (4) fingerprints x all file vectors (up to 20k files x model dimension, e.g. 1536 floats). atomicWriteJson stringifies the whole document synchronously while holding the cache lock: multi-hundred-MB JSON writes, seconds-long lock holds that block concurrent builds, and large heap spikes on every semantic build.
- **Fix:** Shard the vector cache per fingerprint file, store Float32 binary payloads instead of JSON, and write incrementally; bound per-fingerprint vector count or spill to a directory of per-batch files.
- **Evidence:** `existing.fingerprints[fingerprint] = { updatedAt: Date.now(), vectors: byHash }` with MAX_SEMANTIC_FINGERPRINTS = 4, then `await atomicWriteJson(cachePath, existing)` under withCacheLock.

## [MEDIUM] state-mutation — packages/indexer/src/index-store.ts:610 — saveIndex mutates the repository's .git/info/exclude as a side effect
- **Risk:** Saving the index silently appends '/.codebuff-index/' (or the configured cache dir) to the repository's .git/info/exclude. This mutates user git metadata outside the cache directory on every build, surprises users auditing their git config, and can contend on the same file when multiple processes index different roots of one repository.
- **Fix:** Make the exclude write opt-in via IndexingConfig (or derive ignores from the tool layer), and dedupe/skip when the process has already written the line this session.
- **Evidence:** `await fs.promises.appendFile(excludePath, `${prefix}${excludeLine}\n`, 'utf8')` inside ensureGitInfoExcludes, called unconditionally from saveIndex and saveSemanticVectors.

## [MEDIUM] security — packages/code-map/src/languages.ts:150 — setWasmDir bypasses the path-traversal validation applied to CODEBUFF_WASM_DIR
- **Risk:** CODEBUFF_WASM_DIR is validated (validateWasmDir rejects '..' and relative paths), but the programmatic setWasmDir API stores customWasmDir unvalidated and resolveWasmPath joins it directly. Any library/plugin code that can call setWasmDir before first parse can point grammar loads at arbitrary files — and tree-sitter executes loaded WASM — bypassing the traversal guard the env path enforces.
- **Fix:** Run setWasmDir through validateWasmDir (require absolute, reject '..') and ignore/reject invalid values exactly like the env path; log when a value is rejected.
- **Evidence:** `export function setWasmDir(dir: string): void { customWasmDir = dir }` vs resolveWasmPath: `const customWasmDirPath = getWasmDir(); if (customWasmDirPath) { return path.join(customWasmDirPath, wasmFileName) }` — validateWasmDir invoked only for process.env.CODEBUFF_WASM_DIR.

## [LOW] security — packages/indexer/src/file-walker.ts:95 — statProjectFiles follows symlinks while the recursive walk skips them
- **Risk:** walkProjectDetailed never follows symlinks (dirent isSymbolicLink entries are neither isFile nor isDirectory, so they are skipped), but statProjectFiles — used for precise markPathsChanged deltas — uses fs.promises.stat, which follows symlinks. An in-repo symlink supplied in a mutation delta is stat'd, hashed, and read even when it points outside projectRoot; contents then flow into the index (imports, concepts, contentSample).
- **Fix:** Use lstat in statProjectFiles and skip symlinks (or resolve and verify the target stays under projectRoot), matching the walk's no-follow semantics.
- **Evidence:** `stat = await fs.promises.stat(absolutePath)` in statProjectFiles; walkProjectDetailed uses `readdir(dir, { withFileTypes: true })` and branches only on entry.isDirectory()/entry.isFile().

## [LOW] security — packages/indexer/src/index-store.ts:520 — Dead-owner lock reclaim relies on pid liveness, which PID reuse can defeat
- **Risk:** Lock reclamation trusts only the pid recorded in the lock file. If the owning process died and the pid was reused by an unrelated process, isLockOwnerDead returns false and the lock is held for the full STALE_LOCK_MS (5 min) — a stall, not corruption. Conversely, aggressive reclaim on ESRCH is safe. Conservative behavior is correct, but the failure mode (multi-minute stall after a crash + pid reuse) is silent.
- **Fix:** Acceptable as-is; optionally embed the owner's boot-id/start-time in the lock record to harden liveness checks, and document the PID-reuse window.
- **Evidence:** `const pid = Number.parseInt(pidText, 10); if (pid === process.pid) return false; process.kill(pid, 0); return false; catch { return code === 'ESRCH' }` — no identity beyond pid.

## [LOW] dependency-hygiene — packages/code-map/src/grammar-wasm-repair.ts:60 — gdscript grammar repair downloads from an unofficial third-party vendored fork
- **Risk:** Integrity is strong (sha256-pinned, verified before write), but availability/provenance for the gdscript grammar depends on a third-party personal GitHub repository pinned to one commit, and the other grammars fall back to a public CDN (cdn.jsdelivr.net). A deleted repo/CDN outage permanently breaks checksum-pinned repair for that grammar in compiled CLI builds.
- **Fix:** Vendor the gdscript wasm in the repo or an org-controlled npm package like the other grammars, or mirror tree-sitter-wasms under project infrastructure; keep the pinned checksum either way.
- **Evidence:** `sourceUrl: 'https://raw.githubusercontent.com/lusiem/code-atlas/2e416060.../grammars-vendored/tree-sitter-gdscript.wasm'` with comment 'The upstream grammar does not publish WASM artifacts. This immutable vendored build...'.

## [MEDIUM] test-coverage — packages/code-map/__tests__/integration.test.ts:100 — Integration tests vacuously pass when WASM is unavailable
- **Risk:** Every real-parser test wraps its body in try/catch and an `if (config?.parser)` guard whose else-branch runs `expect(true).toBe(true)`. When grammar WASM fails to load, the suite reports green while exercising zero parser behavior — a broken grammar ship (missing wasm assets, bad CODEBUFF_WASM_DIR) is invisible to CI, and the all-language-wasm.test.ts coverage does not cover this runtime path.
- **Fix:** Probe grammar availability once (setWasmDir to the packaged wasm dir) and use t.skipIf to skip explicitly, or assert getLanguageConfig resolves in CI environments that ship the wasm files so a broken grammar fails the suite.
- **Evidence:** `} else { console.log('... Skipping JavaScript test - WASM files not available'); expect(true).toBe(true) // Pass the test }` and the same pattern in the catch blocks.

## [MEDIUM] test-coverage — packages/indexer/src/index-store.test.ts:1 — No tests for malformed per-file cache entries, parserDegraded delta loss, read-error eviction, or revision ordering
- **Risk:** The riskiest persistence/update paths have no regression coverage: corrupt per-file cache entries reaching queryIndex, the parserDegraded early-return in updateMetadataIndex (delta loss + builtAt re-stamp), hash-read failures during incremental updates (changedFiles push without hash), and revision comparison semantics for string vs numeric workspace revisions.
- **Fix:** Add table-driven tests for malformed per-file cache entries (must not throw), a getFileTokenScores stub that throws (must re-queue delta / not refresh builtAt), a hash-read failure (must retain prior entry), and string-vs-number revision ordering.
- **Evidence:** index-store.test.ts covers CAS/locks/sidecar/snapshotId only with valid MetadataIndex fixtures; index-manager.test.ts covers markStale/markPathsChanged/epoch/build-failure status; no test builds a metadata.json with files: { 'a.ts': null } or simulates a parser throw inside updateMetadataIndex.

## [LOW] test-coverage — packages/indexer/src/file-walker.ts:1 — File-walker symlink semantics and sensitive-path traversal are untested
- **Risk:** The walker's de-facto security property — symlinked files/directories are never followed and sensitive paths are excluded via isMandatorySensitiveReadPath — is enforced only incidentally (dirent type checks + filter calls) and is not pinned by any test. A refactor to fs.promises.stat-based walking or a Dirent handling change could silently introduce symlink traversal or sensitive-file reads into the index.
- **Fix:** Add tests pinning symlink behavior (files skipped, dir symlinks not traversed) and a tmpdir-inside-tmpdir traversal test so the security property is regression-guarded.
- **Evidence:** file-walker.test.ts covers makeTempProject/walkProject/walkProjectDetailed/statProjectFiles happy paths only; walk() branches on `entry.isDirectory() / entry.isFile()` and statProjectFiles on `stat.isFile()` with no symlink fixtures.

## [LOW] api-contract — packages/agent-runtime/src/tools/handlers/tool/query-index.ts:21 — query_index tool handler emits a matchedOn value absent from the QueryIndexResult contract
- **Risk:** The query_index tool handler emits matchedOn values ('verified-memory') that are not in the indexer's QueryIndexResult['matchedOn'] union in packages/indexer/src/types.ts. Consumers keying on matchedOn (renderers, memory-coverage trackers, future language clients) see an undocumented value; the drift is invisible to the compiler because the handler casts the output.
- **Fix:** Extend the shared QueryIndexResult matchedOn union (or a shared tool-schema package) to include 'verified-memory' so cross-package usage is compiler-checked.
- **Evidence:** query-index.ts: `matchedOn: ['verified-memory']` vs types.ts QueryIndexResult.matchedOn: Array<'symbol' | 'path' | 'heading' | 'import' | 'graph' | 'concept' | 'semantic' | 'command' | 'chunk'>.

## [LOW] api-contract — packages/indexer/src/index-store.ts:76 — Persisted queryData is trusted without shape validation; corrupt accelerators break queries the missing-key path would survive
- **Risk:** loadIndex rebuilds queryData only when the key is absent. A present-but-corrupt queryData (postings values that are not string arrays, adjacency indexes pointing past the edges array) is trusted as-is; getPostingCandidates iterates `postings[indexedToken]` assuming string[] and buildAdjacency maps edge indexes assuming numeric in-range entries, so corruption throws during queries rather than degrading to the documented compatibility fallback.
- **Fix:** Normalize/validate queryData at load (arrays of strings, in-range edge indexes) and rebuild via buildIndexQueryData on any violation, mirroring the fail-safe treatment of missing queryData.
- **Evidence:** `if (!parsed.queryData) { parsed.queryData = buildIndexQueryData(parsed.files, parsed.graph) }` — no validation of postings/documentFrequencies/adjacency contents; buildAdjacency: `edgeIndexes.map((edgeIndex) => edges[edgeIndex]).filter(Boolean)`.

## [LOW] correctness — packages/indexer/src/index-store.ts:300 — Persisted vector records are not dimension-validated; mismatched dimensions silently score 0
- **Risk:** isValidVector accepts any finite numeric array regardless of length. If a fingerprint's cached vectors were produced with a different model dimension than the current query embedding (fingerprint collision, model config change with same cacheKey), cosineSimilarity returns 0 for every length-mismatched pair, silently disabling semantic recall with no diagnostic — the blend just disappears.
- **Fix:** Record the vector dimension per fingerprint in the cache and reject records whose length differs; treat a persisted dimension change as a cache miss and re-embed.
- **Evidence:** isValidVector: `Array.isArray(value) && value.length > 0 && value.every((component) => typeof component === 'number' && Number.isFinite(component))`; semantic.ts cosineSimilarity: `if (a.length === 0 || a.length !== b.length) return 0`.

## [LOW] performance — packages/code-map/src/structure.ts:470 — Quadratic containment scans for depth and qualified-name construction per file
- **Risk:** assignDepths computes isStrictContainer against every other symbol for each symbol (O(S^2) per file), and buildQualifiedName re-runs findContainers per chunk in chunks.ts buildChunks — so symbol-dense files (generated code, large barrel files) pay quadratic containment scans twice per parse. Bounded by the 1MB per-file parse cap but still the hot path for dense files.
- **Fix:** Cache containers per symbol (assignDepths already computes them) or sort once and use an interval stack to make containment O(S log S); memoize qualified names during chunk construction.
- **Evidence:** structure.ts assignDepths: `const containers = sorted.filter((other) => other !== sym && isStrictContainer(other, sym))` per symbol; buildQualifiedName: `const containers = findContainers(symbols, sym)` called again per chunk in chunks.ts buildChunks.

## [LOW] performance — packages/indexer/src/query.ts:260 — Command-intent queries bypass the postings index and score the whole corpus
- **Risk:** When commandIntent is true (commands mode or phrase-detected intent), candidates is set to null so querySearch scores every indexed file through scoreFile plus commandMatchedSnippets, bypassing the postings accelerator entirely. Command-discovery queries on large repos do a full-corpus scoring pass; the same applies whenever postings are absent.
- **Fix:** Maintain a command-oriented posting list (package.json/CIs/task-runner/manifest paths already classifiable at build time) and restrict command-mode scoring to it, falling back to a full scan only when the posting list is empty.
- **Evidence:** `const candidates = commandIntent ? null : getPostingCandidates(index, tokens)` then `for (const file of filesToScore) { ... scoreFile(file, tokens, idf, commandIntent, lexicalWeights) }` over all values; commandMatchedSnippets also called per file inside scoreFile when commandIntent.

## [LOW] correctness — packages/indexer/src/query.ts:470 — IDF fallback counts documents with substring semantics while scoring-path postings use tokenized exact match
- **Risk:** When queryData.postings lack a token, document frequency falls back to fileContainsToken, which uses substring semantics (symbolMatchesToken allows forward substring and >= 4-char reverse substring) over raw fields. The postings-derived df uses tokenized exact vocabulary. The two semantics disagree, so IDF weights for the same token differ depending on which cache generation is loaded — ranking is internally consistent per query but not stable across caches, and rare tokens can be over- or down-weighted.
- **Fix:** Derive document frequency and scoring from one shared predicate — prefer computing df from the postings themselves (substring-expanded candidate sizes) and use the same expansion for scoring, or gate the fallback to the tokenized-exact semantics.
- **Evidence:** computeIdfForTokens: `if (df === undefined) { df = 0; for (const file of Object.values(index.files)) { if (fileContainsToken(file, token)) df++ } }` where fileContainsToken uses symbolMatchesToken substrings, versus postings built by tokenizePostingValue exact tokens in query-data.ts.

## [LOW] error-handling — packages/indexer/src/index-store.ts:560 — atomicWriteJson renames without fsyncing the parent directory
- **Risk:** atomicWriteJson fsyncs the temp file but not the containing directory after rename, so on crash-consistent filesystems (ext4 data=ordered) the rename itself may be lost. Impact is low because the index is rebuildable and loads treat missing/invalid files as misses, but the CAS/newest-wins guarantees the design documents are not crash-durable without the dir fsync.
- **Fix:** After rename, open the parent directory and fsync it (Node 18.16+ supports fs.promises.open(dir, 'r') + fh.sync() on Linux); skip on platforms where it is unsupported.
- **Evidence:** `await handle.sync(); await handle.close(); handle = undefined; await fs.promises.rename(temporaryPath, filePath)` — no directory handle open/fsync before or after rename.

## [LOW] state-mutation — packages/indexer/src/index-manager.ts:60 — IndexManager singleton LRU can evict a root with an in-flight build, silently duplicating work
- **Risk:** The per-root singleton cache evicts the oldest entry at MAX_INSTANCE_ROOTS = 8 with no reference to whether that manager has a build in flight. A long-lived process touching a ninth root drops an active manager mid-build; the next getInstance for the evicted root constructs a new instance whose _build re-walks the project and re-contends on the cache lock, duplicating work the evicted instance already did (its in-memory index and parsedCacheByRoot entries are also dropped).
- **Fix:** Evict only managers with no in-flight buildPromise (or park evicted instances until their build settles), and expose a test/dev hook to enumerate live managers.
- **Evidence:** `const oldestKey = IndexManager.instances.keys().next().value; if (oldestKey !== undefined) { IndexManager.instances.delete(oldestKey) }` — eviction is unconditional on size, no liveness check.

## Coverage receipt

### Subsystems
- indexer-index-manager
- indexer-index-store
- indexer-query-engine
- indexer-metadata-indexer
- indexer-file-walker
- indexer-semantic
- indexer-chunk-freshness
- indexer-asset-refs
- indexer-repo-map
- indexer-retrieval-quality
- indexer-query-data
- code-map-parse
- code-map-structure
- code-map-languages
- code-map-chunks
- code-map-wasm-repair
- agent-runtime-query-index-tool

### Features
- incremental-updates
- staleness-invalidation
- snapshot-identity
- cache-locking-cas
- cache-ownership
- lexical-ranking
- idf-weighting
- graph-traversal
- references-mode
- command-discovery
- semantic-embeddings
- semantic-blending
- vector-persistence
- chunk-sidecar
- chunk-freshness
- asset-ref-extraction
- repo-map-eval
- retrieval-quality-metrics
- wasm-checksum-pinning
- wasm-path-resolution
- parse-budgets
- parse-incremental-reuse
- gitignore-walking
- sensitive-path-filtering
- query-tool-handler
- memory-first-shortcut

### Files
- packages/indexer/src/index-manager.ts
- packages/indexer/src/index-store.ts
- packages/indexer/src/types.ts
- packages/indexer/src/query.ts
- packages/indexer/src/metadata-indexer.ts
- packages/indexer/src/file-walker.ts
- packages/indexer/src/chunk-freshness.ts
- packages/indexer/src/semantic.ts
- packages/indexer/src/asset-refs.ts
- packages/indexer/src/repo-map.ts
- packages/indexer/src/retrieval-quality.ts
- packages/indexer/src/query-data.ts
- packages/indexer/src/index-manager.test.ts
- packages/indexer/src/import-resolution.test.ts
- packages/indexer/src/query.test.ts
- packages/indexer/src/semantic.test.ts
- packages/indexer/src/index-store.test.ts
- packages/code-map/src/parse.ts
- packages/code-map/src/structure.ts
- packages/code-map/src/languages.ts
- packages/code-map/src/chunks.ts
- packages/code-map/src/grammar-wasm-repair.ts
- packages/code-map/src/wasm-files.ts
- packages/code-map/__tests__/integration.test.ts
- packages/code-map/__tests__/grammar-wasm-repair.test.ts
- packages/code-map/src/__tests__/incremental-parse.test.ts
- packages/agent-runtime/src/tools/handlers/tool/query-index.ts

### Domains
- security
- correctness
- state-mutation
- error-handling
- performance
- dependency-hygiene
- test-coverage
- api-contract
