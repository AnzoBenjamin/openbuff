# Audit findings: shard-sdk

- Subsystems: sdk
- Features: code_search, find_files_matching_content, list_directory, read_files_ranges, read_image, workspace_mutation_broker_cas, workspace_journal, llm_streaming_failover, byok_model_routing, semantic_indexing_embeddings, sdk_build_distribution
- Files covered: 14
- Snapshot: 3ce1fa2b4613303fb428bab8463887ba85bd13958dfd9df8c276dee8231f053a

## [HIGH] performance — sdk/src/tools/code-search.ts — Hot path: every code_search pays a fresh ripgrep process spawn + full tree re-scan
- **Risk:** Each code_search/find_files_matching_content call pays ~10-50ms of process spawn plus full tree re-walk. The tool is the agent's highest-frequency read path; latency scales linearly with repo size on every invocation and cannot be amortized from TS.
- **Fix:** Rust core embedding the actual ripgrep/regex/globset crates via NAPI: in-process search with persistent parallel walker, incremental results, sub-millisecond dispatch and reuse of the process's thread pool. Candidate language: Rust.
- **Evidence:** code-search.ts codeSearch() spawns `child_process.spawn(rgPath, args, ...)` on every call with process startup, PATH/vendor resolution (getBundledRgPath stat/access calls), and streaming JSON parse in JS; find_files_matching_content shares the same binary path.

## [HIGH] performance — sdk/src/tools/code-search.ts — Hot path: ripgrep JSON event stream parsed and re-formatted line-by-line in JS
- **Risk:** ripgrep --json emits one JSON object per match/context line; at large result volumes the JS event-loop parse+string-build work dominates, delays early-stop decisions, and burns budget (estimatedOutputLen accounting) before the global cap settles. On big monorepos the parser, not rg, becomes the bottleneck.
- **Fix:** Rust NAPI module that consumes rg's stdout internally and returns pre-grouped, pre-truncated results (or a typed buffer) so TS never touches per-line JSON. Candidate language: Rust.
- **Evidence:** code-search.ts stdout 'data' handler: `chunk.toString('utf8')`, `jsonRemainder.split('\n')`, per-line `JSON.parse(line)` into `evt:any`, regex `rawText.replace(/\r?\n$/, '')`, string template formatting, plus the entire duplicated parse loop repeated verbatim in the 'close' handler for the remainder flush.

## [HIGH] performance — sdk/src/tools/node-filesystem.ts — Hot path: bounded range reads scan file bytes one-at-a-time in JS
- **Risk:** read_files ranges on large files (the documented use is 'oversized files') pay a full-file single-threaded JS byte scan: a 50MB file costs ~50M JS loop iterations plus per-line allocations, adding hundreds of ms of user-visible latency per ranged read and blocking the event loop between awaits.
- **Fix:** Rust NAPI using memmap2 + SIMD memchr (via memchr crate) for line scanning, returning totalLines and the requested slice in one mmap pass without copies. Candidate language: Rust.
- **Evidence:** node-filesystem.ts readNodeTextRange: `for await (const chunkValue of createReadStream(filePath))` then `for (let index = 0; index < chunk.byteLength; index += 1)` scanning every byte for 0x0a, with Buffer.concat per line and `Buffer.concat(output)` at the end; totalLines requires reading the ENTIRE file even when endLine is small.

## [MEDIUM] performance — sdk/src/tools/bounded-readdir.ts — Hot path: directory listing materializes entries through libuv with no native batched getdents
- **Risk:** On huge directories (node_modules-scale) the non-streaming path allocates every dirent before slicing; even the streaming path pays per-entry JS object allocation. Node libuv cannot batch getdents efficiently, so large-directory listing latency is structurally worse than a native readdir.
- **Fix:** Rust getdents64/ReadDirectoryChangesW-based iterator exposed via NAPI that yields exactly `limit` entries with lazy type resolution. Candidate language: Rust.
- **Evidence:** bounded-readdir.ts readBoundedEntries: non-streaming fallback `await fs.readdir(directoryPath, { withFileTypes: true })` then `.slice(0, limit)`; streaming path pushes Dirent objects one by one from `streamDirectory.call(fs, ...)`. MAX_LIST_DIRECTORY_ENTRIES cap exists, but the underlying readdir materializes all entries first.

## [MEDIUM] performance — sdk/src/run.ts — Native capability gap: no parallel tree traversal / worker-pool filesystem scans anywhere in the run loop
- **Risk:** Large-session runs (long message histories, many agent definitions, deep workspace state) pay main-thread costs for snapshotting and journal writes that a native pool could parallelize; TS offers no zero-copy structured snapshot or rayon-class parallelism.
- **Fix:** Rust worker pool (rayon) behind NAPI for hashing, journal serialization, and structured snapshots; keep the JS event loop free. Candidate language: Rust.
- **Evidence:** run.ts: `structuredClone(sessionState)` in getCancelledSessionState, per-step checkpoint `onCheckpoint` callbacks, and full cloneDeep(agentDefinitions); workspace-journal.ts advance() rewrites the whole journal record under a kind-lock per change. No worker-thread offload of file hashing or parse work anywhere in the SDK surface.

## [MEDIUM] performance — sdk/src/services/workspace-mutation-broker.ts — Performance: mutation broker hashes full file contents in JS and fsyncs repeatedly per mutation
- **Risk:** Every guarded mutation re-hashes whole files twice+ (before-hash, post-commit verification, recovery re-reads) from userspace with no kernel page-cache readahead hints, and the mkdir-based lock burns a 20ms poll loop per contended mutation. For multi-MB files this adds real per-edit latency the CAS design cannot avoid in JS.
- **Fix:** Rust broker core using io_uring/dio, xxh3/blake3 hashing with content-addressed caching, and fcntl/flock-based locks instead of mkdir-poll. Candidate language: Rust.
- **Evidence:** conditionalCommit/delete/move each call `readHash()` which does `fs.readFile(filePath)` then `createHash('sha256').update(content)` — full re-read of every file (including the destination on move, the tombstone on delete) plus fsyncDirectory on parent dirs; writeStagedFile does handle.sync(); lock acquisition polls every 20ms up to 10s.

## [HIGH] performance — sdk/src/impl/embeddings.ts — New-feature blocker: embeddings are remote-only; no local/GPU inference possible from TS
- **Risk:** Semantic indexing of a large repo means thousands of chunk embeddings serialized over the network with per-batch round-trips; no GPU/local inference path exists, and TS has no viable ONNX/WebGPU embedding runtime with acceptable throughput. Offline/private-repo indexing — a core BYOK/local-first promise — is blocked entirely without a routable /embeddings endpoint.
- **Fix:** Rust NAPI embedding runtime (candle or ort with CUDA/Metal execution providers) exposing a local EmbedFn; keep cacheKey namespacing per finding below. Candidate language: Rust.
- **Evidence:** embeddings.ts createConfiguredEmbedder: `resolveConfiguredProviderModel` rejects anything whose provider.type !== 'openai-compatible' and returns null ('Embeddings require an OpenAI-compatible /embeddings endpoint'), forcing every embedding through a remote HTTP batch call via embedMany.

## [HIGH] performance — sdk/src/tools/code-search.ts — Ecosystem leverage: ripgrep internals, tree-sitter native, tantivy, notify are all one Rust boundary away
- **Risk:** The most valuable native libraries in this space (ripgrep internals, tree-sitter native bindings, tantivy, notify, blake3) are Rust crates unreachable from TS; the current architecture shells out to a binary or loads WASM, losing streaming, mmap, and shared-state caching that the native versions provide.
- **Fix:** Rust core exposing search (ripgrep crates), parsing (tree-sitter native runtime instead of WASM), and indexing (tantivy) behind NAPI; keep the JS tool handlers as thin wrappers. Candidate language: Rust.
- **Evidence:** codeSearch streams `--json` rg output through JS, but ripgrep internals (grep-searcher, ignore, globset) are the crates rg itself is built from; find_files_matching_content (same getBundledRgPath import) and the code-map/tree-sitter WASM grammars in build.ts (LANGUAGE_WASM_FILES copied to dist/wasm) are the native-capability seams already exposed.

## [MEDIUM] performance — sdk/src/native/ripgrep.ts — Performance: rg path resolution does synchronous stat/access probe chains on every search
- **Risk:** Every code_search re-runs the binary-resolution filesystem probe chain (uncached stat/access syscalls) before spawning; also the whole per-platform vendor/ directory (5 binaries) ships in the npm tarball, bloating install size, and unsupported platform/arch throws at runtime.
- **Fix:** Rust: link ripgrep as a library, eliminating the binary-probe entirely and the fork/exec boundary. Candidate language: Rust.
- **Evidence:** ripgrep.ts getBundledRgPath probes statSync/accessSync across devPath, distPath, CJS __dirname paths, PATH scan, and node_modules dist path — several stat round-trips per search call (getBundledRgPath is called inside codeSearch on every invocation, not cached).

## [MEDIUM] api-contract — sdk/src/services/workspace-mutation-broker.ts — Stability contract: workspace mutation receipts are persisted cross-process state
- **Risk:** Receipts are persisted cross-process durable state: other Openbuff processes and future versions read them during recovery. A native rewrite of the broker (or its host process) that changed receipt shape, state names ('prepared'/'recovery_required'/final states), or brokerRevision semantics would strand existing workspaces in unrecoverable state.
- **Fix:** Any native reimplementation (Rust) must reproduce the exact receipt JSON schema, the pending→final transition protocol, and filename zero-padding, or version the format behind the existing schemaVersion field. Keep receipts as the stable boundary; only the locking/IO internals may move natively.
- **Evidence:** workspace-mutation-broker.ts WorkspaceMutationReceipt type: schemaVersion 1, authorityKind WORKSPACE_MUTATION_AUTHORITY = 'cooperative_cas'; prepareReceipt/updatePendingReceipt/finalizeReceipt write pending/ then receipts/ JSON files with zero-padded revision filenames — read back by recoverPendingReceipts on every subsequent mutation.

## [MEDIUM] api-contract — sdk/src/run.ts — Stability contract: tool-handler output shapes and read-capability tokens must survive any native component
- **Risk:** handleToolCall is the published dispatch surface: ToolResultOutput shapes, FileMutationResultV1/CommitReceiptV1 receipts, cap.v3 ReadCapabilityIssuer content-hash caps, host verifyExternalMutation/onFilesystemMutation hooks, and the CodebuffFileSystem adapter contract (readdirView pairing, hostProcessView flag gating code_search/3d tools) are all consumed by external hosts. A native rewrite that drifts on any of these breaks every embedding host.
- **Fix:** Keep these as the stable JS boundary; implement native accelerators behind them (a Rust-backed CodebuffFileSystem adapter, native range-read, native search) rather than replacing the contract surface. Candidate language: Rust via NAPI behind the existing interfaces.
- **Evidence:** run.ts ClientToolOverrides/OverrideDescriptor + handleToolCall's per-tool dispatch (fileMutationResultV1Schema.safeParse, verifyExternalMutation downgrade to 'unconfirmed', getConfirmedAppliedActionsV1 gate, FilesystemMutationEvent with workspaceRevision/workspaceSnapshotId); node-filesystem.ts streamDirectory is 'deliberately not named opendir' with a `readdirView` pairing guard, and resolveStreamDirectory requires `streamDirectory.readdirView === fs.readdir`.

## [MEDIUM] api-contract — sdk/src/impl/embeddings.ts — Stability contract: EmbedFn.cacheKey format gates semantic-index cache compatibility
- **Risk:** The embeddings cacheKey defines which persisted vector caches are reusable. Adding a native/local embedder (candle/ort) produces different vector spaces for the same model string; without a namespaced cacheKey scheme, switching a user between remote and local embeddings would silently mix incompatible vectors in one cache.
- **Fix:** Namespace local embeddings under a distinct providerId/cacheKey prefix (e.g. 'local:onnx/<model>') so the existing cache-compatibility mechanism naturally isolates the new vector spaces. Candidate language: n/a (contract change); implementation Rust.
- **Evidence:** embeddings.ts: `embed.cacheKey = JSON.stringify({ providerId, baseURL, providerModel })` with the comment 'These fields fully identify the resolved endpoint/model whose vector space determines cache compatibility.'

## [LOW] api-contract — sdk/src/native/ripgrep.ts — Stability contract: CODEBUFF_RG_PATH env override and rg path resolution are user-visible behavior
- **Risk:** CODEBUFF_RG_PATH is a documented user escape hatch and the probe order (env → dev vendor → dist vendor → CJS dirname → PATH → node_modules dist) is relied on by the CLI and find_files_matching_content. Any redistribution (single binary, embedded engine) must keep the override honored and the failure message actionable.
- **Fix:** Preserve CODEBUFF_RG_PATH as an explicit 'use this binary instead of the embedded engine' override in any native search component, and keep the error-message contract. Candidate language: Rust engine honoring the same override.
- **Evidence:** ripgrep.ts: `if (env.CODEBUFF_RG_PATH && isExecutableFile(env.CODEBUFF_RG_PATH)) return env.CODEBUFF_RG_PATH`; error text instructs "run 'npm run fetch-ripgrep', install ripgrep, or set CODEBUFF_RG_PATH"; referencedBy shows cli/src/native/ripgrep.ts and find-files-matching-content.ts importing getBundledRgPath.

## [HIGH] performance — sdk/src/tools/code-search.ts — New feature: persistent incremental full-text + semantic code index (tantivy) enabled by a native core
- **Risk:** Today every search is a fresh ripgrep invocation over the working tree; there is no persistent index, so results are unranked linear-scan output and latency scales with tree size every single call. TS cannot reach an embedded full-text engine.
- **Fix:** Rust tantivy index with notify-driven incremental updates exposed via NAPI: persistent ranked keyword index, hybrid with the semantic embeddings path, sub-100ms queries regardless of repo size. Candidate language: Rust.
- **Evidence:** code-search.ts rebuilds `searchPaths = ['.', ...existingHiddenDirs]` per call, re-parses flags through parseSafeRipgrepFlags, and settles after `matchesGlobal >= globalMaxResults || estimatedOutputLen >= maxOutputStringLength` — all per-call setup with no persisted index.

## [MEDIUM] api-contract — sdk/src/run.ts — New feature: live workspace watching (notify/inotify/FSEvents) for external-edit detection and auto-reindex
- **Risk:** External mutations (user editing in an IDE while the agent runs) are detected only lazily: hash mismatches at the next broker CAS, or host-implemented watchers. The SDK itself cannot push 'workspace changed' events, so agents can act on stale file views and caches invalidate only after the next tool call.
- **Fix:** Rust notify/watchman-class watcher surfaced as an SDK-level onExternalFilesystemChange event plus dirty-path feed for incremental reindex and live workspace-state sync. Candidate language: Rust (notify) via NAPI.
- **Evidence:** run.ts onFilesChanged/onFilesystemMutation are 'Called after a file-mutating tool ... runs, so a host can invalidate caches'; broker doc: 'workspace watchers and revision checks remain the external-mutation backstop' — but no watcher is wired in the SDK surface; change detection is fingerprint gates (applyGitStatusGate) computed only when the model calls git_status.

## [MEDIUM] performance — sdk/scripts/build.ts — Distribution: bundling workarounds and vendored-binary plumbing exist only because the SDK is pure JS
- **Risk:** The SDK must ship as an npm artifact consumed by arbitrary hosts (ESM+CJS+d.ts); Bun bundler bugs force brittle post-build regex patches on every release, and vendored per-platform ripgrep + tree-sitter WASM assets inflate the package. A native rewrite must keep the published surface (index.mjs/index.cjs/index.d.ts) byte-compatible in API shape or gate it behind a major version.
- **Fix:** Rust core shipped as prebuilt NAPI .node binaries (napi-rs supports one CI matrix covering all platforms) with a thin universal JS shim; the fragile bundle surgery disappears and the vendor/ripgrep directory is dropped in favor of the linked engine. Candidate language: Rust (napi-rs distribution).
- **Evidence:** sdk/scripts/build.ts: three Bun-bundler bug workarounds (fixCjsImportVars, fixEsmExportRenames, fixToolHelpers) regex-patching generated bundles, define of `import.meta.url: 'undefined'` for CJS (which ripgrep.ts works around with a `new Function('__dirname')` hack), external-dependency allowlisting, and dual ESM/CJS + d.ts bundling just to publish a Node-compatible package.

## Coverage receipt

### Subsystems
- sdk

### Features
- code_search
- find_files_matching_content
- list_directory
- read_files_ranges
- read_image
- workspace_mutation_broker_cas
- workspace_journal
- llm_streaming_failover
- byok_model_routing
- semantic_indexing_embeddings
- sdk_build_distribution

### Files
- sdk/src/native/ripgrep.ts
- sdk/scripts/fetch-ripgrep.ts
- sdk/src/tools/code-search.ts
- sdk/src/tools/bounded-readdir.ts
- sdk/src/tools/node-filesystem.ts
- sdk/src/services/workspace-mutation-broker.ts
- sdk/src/services/workspace-journal.ts
- sdk/src/impl/llm.ts
- sdk/src/impl/model-provider.ts
- sdk/src/impl/failover.ts
- sdk/src/run.ts
- sdk/src/tools/read-image.ts
- sdk/src/impl/embeddings.ts
- sdk/scripts/build.ts

### Domains
- performance
- api-contract
