# Code map, structural inventory, and graph reuse

## Scope and confidence

Scoped source audit for the requested index/record architecture redesign. No production or test source changed. This report covers code-map parsing, metadata graph construction, precise enrichment, structural inventory/attestation, and their SDK consumers. Session bootstrap policy, book applicability, and primary memory retrieval are covered by separate lanes.

Evidence means a directly inspected code path or hermetic probe. Inference means an architectural implication of those paths. No latency, throughput, memory, or provider-cost benchmark was run.

## Current strengths

- `packages/code-map/src/parse.ts:350` accepts prior per-file parses and reports parser diagnostics/coverage. Parsing uses fair prefix/language ordering and bounded work; it no longer silently erases every file after a traversal-order budget cutoff.
- `packages/indexer/src/metadata-indexer.ts:655` hydrates/reuses persisted `parseData` and retries uncached failed parses. `:779` merges persisted and process-local parse summaries for incremental updates.
- `packages/indexer/src/types.ts:79` explicitly defines **persisted** query postings, document frequencies, and graph adjacency. `metadata-indexer.ts:757` and `:1099` produce those accelerators. It would be inaccurate to claim all graph/query acceleration is process-local.
- `metadata-indexer.ts:1375` resolves call candidates through imports and same-language definitions. `ts-module-resolver.ts:9` already includes an oxc native resolver plus a TypeScript fallback; basic module resolution does not require a new language rewrite.
- `packages/indexer/src/types.ts:59` distinguishes heuristic and precise edge provenance. `scip-runner.ts:17` already provides optional bounded, asynchronous compiler-indexer enrichment with off-thread dump parsing.
- `sdk/src/services/audit-intelligence.ts:156` attests full source bytes, file type/mode, and symlink targets, including opened-file metadata checks. `sdk/src/tools/audit-intelligence.ts:43` rejects a stale structural receipt instead of silently accepting it.
- `packages/agent-runtime/src/structural-read.ts:35` parses the exact content supplied to a structural read. Structural discovery and raw read/edit capabilities remain separate, a boundary the redesign should preserve.

## Findings

### CM-1 — HIGH — correctness / state mutation / test coverage / API contract

**Precise SCIP knowledge disappears on an unchanged refresh.**

- **Evidence:** `packages/indexer/src/scip-ingest.ts:228` returns a merged graph containing precise edges. The ordinary no-change refresh at `metadata-indexer.ts:741` rebuilds `buildGraph` from file metadata and `parseData`, then replaces the graph at `:756`. `buildGraph` accepts no prior enrichment layer and constructs a fresh empty edge array at `:1214`. The changed-file path also calls `createMetadataIndex` at `:881`, which constructs a fresh heuristic graph.
- **Evidence:** A hermetic temporary-project probe built an index for two unchanged TypeScript files, merged one `confidence: 'precise'` file-reference edge, then called `updateMetadataIndex(merged, root)` without changing either source. Result: `{"before":1,"after":0,"unchangedSources":true}`. The temporary project was deleted afterward.
- **Evidence:** `packages/indexer/src/index-manager.ts:601` loads the persisted graph and passes it through that ordinary update path on a new manager build. Its persistence test at `index-manager.test.ts:645` verifies a direct `loadIndex` round trip at `:691`; it never executes a fresh manager's reconciliation.
- **Inference:** Precise data can survive on disk yet vanish when the next session actually uses that disk snapshot. This directly undermines enrichment reuse and leaves the operator repeating a compile-scale indexer run.
- **Risk:** Persisted enrichment is mistaken for retained semantic knowledge. Graph precision changes across idle sessions without source changes.
- **Design remedy:** Persist graph facts by producer and source fingerprint: parser/import facts, compiler/SCIP facts, and learned/cited facts should have independent storage and invalidation. A parser refresh updates its own layer, retaining unaffected compiler edges. A compiler layer must include source/dependency/configuration identity, so preserving enrichment does not imply preserving stale edges. Add a real merge -> close/reopen/new-manager -> unchanged-refresh regression, plus changed-source and changed-build-config invalidation cases.

### CM-2 — MEDIUM — performance / state mutation

**Even an unchanged refresh reconstructs the full graph and query accelerators.**

- **Evidence:** The no-source-change branch at `metadata-indexer.ts:655` still calls global `buildGraph` and `buildIndexQueryDataAsync` at `:741` and `:757`. `buildModuleAwareCallEdges` scans all parsed definitions at `:1383` and all callers at `:1415`. On changed files, `getFileTokenScores` at `:799` recomputes scores/callers for the merged project set, and `createMetadataIndex` at `:881` reconstructs the graph globally.
- **Inference:** Reusing parse summaries avoids tree-sitter work but does not make the entire pipeline incremental. Cost still scales with all files/symbols/edges during refresh. No measured latency is asserted.
- **Risk:** Reconciliation and small edits repeatedly rebuild data whose dependencies mostly did not change; this adds avoidable CPU/allocation work before retrieval becomes ready.
- **Design remedy:** Maintain per-file postings, definitions, imports, reverse dependents, and producer-owned edges transactionally. For no-change reconciliation reuse the existing derived snapshot unless parser/resolver/configuration identity changed. For a changed file update its facts and affected import/call dependents, rather than regenerating every fact. Use background integrity sweeps to detect missed events; keep query-visible immutable snapshots stable during publication.

### CM-3 — MEDIUM — performance / dependency hygiene / API contract

**SDK symbol bootstrap uses a separate ephemeral cache and full warm verification.**

- **Evidence:** `sdk/src/run-state.ts:347` retains only one last-project module-global `completeProjectIndexCache`, keyed by cwd, filesystem object identity, scoring-function identity, and ordered membership. `:402` reads/hashes every cached parsed file for reuse. A miss invokes `scoreProject` with `reuseParsed` absent at `:432`.
- **Evidence:** The CLI's paths-only mode bypasses this symbol computation at `run-state.ts:839`; continued paths-only turns likewise bypass it at `:1170`. This path is **not** evidence that today's default CLI reparses every source before every model call.
- **Inference:** SDK symbol users and the persistent IndexManager can duplicate parsing/discovery for the same repository. New processes, changing fs wrapper identity, alternating projects, and membership changes lose the SDK cache.
- **Risk:** Consumers see different reuse/freshness behaviour depending on entrypoint; a language rewrite alone does not remove those competing authorities.
- **Design remedy:** Introduce a shared repository-intelligence interface used by CLI and SDK. Immutable parse outputs should be keyed by content digest, language, grammar/parser version, and relevant extraction options; symbol/bootstrap views should derive from the same durable facts. Retain a virtual-filesystem provider for SDK callers rather than making a live daemon mandatory. Fresh file reads and edit-capability issuance remain independent.

### CM-4 — MEDIUM — performance / error handling / security boundary

**Structural inventory caching does not reuse source attestation work.**

- **Evidence:** `sdk/src/services/audit-intelligence.ts:211` recursively walks the whole root before applying scope. `:156` synchronously reads and SHA256-hashes every selected file's full bytes. `sdk/src/tools/audit-intelligence.ts:20` retains 16 inventories, but every feature/coverage attestation calls `inspectCodebaseStructure` again at `:42`; the cached object mainly supplies the earlier scope.
- **Inference:** Asking about multiple features repeatedly performs discovery and source hashing. The exact-byte attestation is intentional correctness protection, so substituting an unchecked stale index would weaken the contract.
- **Risk:** Repeated synchronous I/O can delay the TUI/SDK and encourage redundant snapshots; removing checks to make it fast would allow stale audit evidence.
- **Design remedy:** Share a durable source-membership/Merkle snapshot with indexed metadata. Re-attest changed leaves and membership through a trusted change cursor, retaining opened-file checks for uncertain paths. Keep full attestation as explicit/background recovery when watcher coverage is incomplete, the service was stopped, or source history is unknown. Structural consumers should read an immutable attested revision rather than independently rediscovering the repository per feature.

### CM-5 — MEDIUM — correctness / API semantics / product design

**Generated structural maps are useful facts but do not provide durable feature understanding.**

- **Evidence:** `ParsedFileTokens` at `packages/code-map/src/parse.ts:327` stores identifier/call names, line counts, module specifiers, and frequency counts; it does not contain compiler binding identities or explanations of feature purpose. `buildModuleAwareCallEdges` at `metadata-indexer.ts:1449` uses one imported candidate or one same-language candidate. `inspectCodebaseStructure` at `audit-intelligence.ts:225` classifies entrypoints/routes/public APIs from path patterns. Feature matching at `:395` starts from name/path terms.
- **Evidence:** `packages/indexer/src/repo-map.ts:80` says the compact text renderer is a prototype for retrieval evaluation, not the default query path. `rankedRepoMap` at `:108` can rank a seed-specific graph but is a library surface.
- **Inference:** Auto-generation itself is appropriate for structural facts. Saving those facts does not guarantee that an agent receives the subsystem explanation, feature flow, reliable validation commands, or prior decisions it needs. A persistent map with no task/role-aware consumer still permits repeated model discovery.
- **Risk:** Treating graph name matches or generated prose as authoritative architectural understanding overstates certainty; baking all generated text into every prompt produces noise instead of reuse.
- **Design remedy:** Keep generated facts and curated/source-cited feature models as distinct records linked by evidence. Expose capability/coverage/provenance in retrieval. Deliver a bounded role/task briefing using the existing graph, useful verified claims, relevant commands, and explicit unknowns. Compiler-resolved facts can strengthen the structural layer; learned summaries remain evidence-backed and invalidated by their dependencies rather than becoming executable policy.

## Eight-domain coverage

| Domain | Disposition within this scope |
|---|---|
| Security | Inspected path containment, full-byte structural attestation, SCIP validation and structural-read authority separation. No new authorization bypass established. Preserve those boundaries during cache reuse. |
| Correctness | Confirmed enrichment loss; recorded structural/heuristic limits without claiming compiler precision. |
| State mutation | Inspected immutable merge, no-change/changed refresh replacement, cache identity, and publication adoption. |
| Error handling | Inspected parse diagnostics/self-healing, structural fallback, stale receipt rejection, and optional SCIP failure modes. No unsupported error-handling defect added. |
| Performance | Inspected whole-graph rebuilds, repeated full attestation, and separate SDK warm reads. No runtime latency measured. |
| Dependency hygiene | Inspected existing code-map dependencies and native oxc/TypeScript fallback; language replacement is not required to access native parsing/resolution. |
| Test coverage | Inspected cache/incremental and snapshot tests; identified direct-load test failing to cover real restart reconciliation; ran hermetic precise-edge retention probe. |
| API/ABI | Inspected persisted optional parse/query data, additive precise provenance, symbol bootstrap compatibility, and attested inventory contract. |

## Reviewed source and test surfaces

`sdk/src/run-state.ts`; `packages/code-map/src/parse.ts`; `packages/indexer/src/metadata-indexer.ts`; `import-resolution.ts`; `ts-module-resolver.ts`; `types.ts`; `scip-ingest.ts`; `scip-runner.ts`; `index-manager.ts`; `repo-map.ts`; `sdk/src/services/audit-intelligence.ts`; `sdk/src/tools/audit-intelligence.ts`; `packages/agent-runtime/src/structural-read.ts`; selected tests in `metadata-indexer.test.ts`, `scip-ingest.test.ts`, `index-manager.test.ts`, `sdk/src/__tests__/project-index-cache.test.ts`, and `sdk/src/__tests__/audit-intelligence.test.ts`; `packages/code-map/package.json`.

## Unknowns and limits

- No actual multi-session CLI/provider trace was run; default model rediscovery frequencies and token costs remain unmeasured.
- No benchmark determines whether Rust, TypeScript/Bun, SQLite FTS5, or a dedicated search engine best meets the repository-size/latency targets. A durable shared service is an architectural boundary; language choice requires workload evidence.
- No available local SCIP compiler was invoked. Precise-edge loss was reproduced against the real merge/update implementations with a hermetic supplied edge, sufficient to establish retention failure.
- A shared source journal cannot assume no changes while it was stopped. Restart recovery and watcher gaps still require reconciliation; cached discovery cannot mint fresh mutation authority.
