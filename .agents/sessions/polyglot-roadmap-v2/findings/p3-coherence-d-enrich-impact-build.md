# Audit findings: p3-coherence-d-enrich-impact-build

- Subsystems: sdk-symbol-enrichment, sdk-harness-intelligence, sdk-build-graph, sdk-lsp-multiplexer, sdk-tool-get-build-targets, sdk-tool-get-affected-tests, common-tool-param-schemas
- Features: p3-t6-symbol-enrichment, p3-t7-test-impact-tiers, p3-t8-build-graph
- Files covered: 9

## [MEDIUM] correctness — sdk/src/services/symbol-enrichment.ts:272 — P3-T6 verdict: PARTIAL — enrichment service, caps, path-aware cache-key fix, and inlayHint-absent note all verified, but enrichFileSymbols has no production consumer
- **Risk:** The sha256-content-keyed LRU enrichment service is implemented and tested but never called outside its test file; hover_type answers via language-intelligence directly with no enrichment cache and no documentSymbol/inlayHint layering. Readers of PLAN.md P3-T6 'landed' may assume the enrichment tier is reachable when it is dead code.
- **Fix:** Either wire enrichFileSymbols into a production path (e.g. the hover_type tool or a get_symbols tool) or record an explicit ACCEPTED/eval-utility status in PLAN.md P3-T6 like the P3-T9 rankedRepoMap precedent, so 'landed' is not read as production-reachable.
- **Evidence:** sdk/src/services/symbol-enrichment.ts:272-349 — enrichFileSymbols merges documentSymbol + hover (+optional inlayHint) into EnrichedSymbol[] with caps MAX_SYMBOLS_PER_FILE=200 / MAX_HOVER_CALLS_PER_FILE=200 / MAX_INLAY_HINTS_PER_FILE=1000 (lines 18-23) and unavailable-safe degradation (LspServerUnavailableError/LspServerError -> {symbols:[], unavailable:{reason}}, lines ~280-293; safeHover keeps symbols on per-symbol hover failure, ~216-226). Cache-key fix VERIFIED: line ~284 keys createHash('sha256') on `${filePath}\0${fileText}` with an explicit NUL separator and a comment stating two byte-identical files at different paths must not collide — the earlier cross-file-pollution finding is fixed. inlayHint-absent note VERIFIED accurate: the LspMultiplexer type in sdk/src/services/lsp-multiplexer.ts (~lines 527-550) declares only definition/references/hover/documentSymbol/workspaceSymbol/syncFile/warmServerCount/dispose — no inlayHint — so the optional seam (typeof multiplexer.inlayHint !== 'function', symbol-enrichment.ts:237) always degrades to an empty map with the real multiplexer. GAP: code_search shows enrichFileSymbols referenced ONLY by sdk/src/__tests__/symbol-enrichment.test.ts; no tool, run.ts path, or language-intelligence call site invokes it, so the P3-T6 deliverable is unreachable in production (the plan's DONE text does not claim wiring, but the 'landed' status overstates reachability without an explicit ACCEPTED/eval-utility note like P3-T9 received). Also confirmed fixed: the earlier LOW inlayHint range-end off-by-one is clamped to the last real line (collectInlayHintsByLine, ~245).

## [LOW] correctness — sdk/src/services/harness-intelligence.ts:696 — P3-T7 verdict: MATCHES — tiered impact with confidence labels, honest graph-tier note, honest coverage placeholder, and bounded discovery all verified
- **Risk:** No gap against the plan claim; recorded so the coherence verdict is persisted. The only residual risk is cosmetic: TestImpactCandidate.path doubles as a command string for build-tool candidates.
- **Fix:** None required for the plan claims. Optionally rename the build-tool candidate field or add a discriminator so consumers do not treat command strings as paths.
- **Evidence:** sdk/src/services/harness-intelligence.ts:~696-780 — analyzeTestImpact evaluates tiers in order convention (high confidence, fs.existsSync-checked) -> graph (reverseDeps injected seam, medium) -> build-tool (buildToolTestCommands, medium when the owning workspace is confirmed/nested or a compiled ecosystem, else low) -> coverage (always []); every candidate enters byPath via offer(paths, tier, confidence) so each carries a tier+confidence label. Coverage tier honestly labeled: docstring 'tier 4 coverage: honest placeholder, always []. Historical-coverage impact maps land in a later task; nothing is fabricated here'. Graph-tier honest note VERIFIED: sdk/src/tools/get-affected-tests.ts:10-11 GRAPH_TIER_NOTE = 'indexer reverse-dependency graph is not wired into this tool yet; graph tier is empty', attached to every impact entry (line ~26-31), and common/src/tools/params/tool/get-affected-tests.ts:43-48 declares graphNote optional in the output schema so it is not silently dropped. The note is accurate: analyzeTestImpact runs with the default no-op reverseDeps seam and the tool injects nothing. discoverNamedFiles bounded VERIFIED: iterative stack walk with MAX_WALK_DEPTH=12 and MAX_VISITED_DIRS=2000, symlinks skipped, ignored-dir set — the earlier unbounded-recursion finding is fixed (~lines 70-115). Minor observation (not blocking): build-tool 'candidates' place command strings (e.g. 'npm run test') in TestImpactCandidate.path, mixing file paths and commands in one field, disambiguated only by tier.

## [LOW] correctness — sdk/src/services/build-graph.ts:1 — P3-T8 verdict: MATCHES — all seven claimed resolvers, owningTargets wiring, longest-prefix matching, TTL cache, bounded walk, SAFE_COMMAND_TOKEN routing (incl. BG-1), and the deferred-systems header verified
- **Risk:** No gap against the plan claim. Two minor residual risks recorded separately (maxFilesPerCall silent truncation; cache key omits runner).
- **Fix:** None required. Optional: surface a truncated flag on get_build_targets when files are dropped, and include the runner identity in the cache key.
- **Evidence:** sdk/src/services/build-graph.ts — (a) all seven claimed resolvers exist and run the claimed tools: resolveCargoTargets spawns ['cargo','metadata','--no-deps','--format-version','1'] (~247), resolveGoTargets spawns ['go','list','-json','./...'] with a concatenated-JSON-object stream parser (~294-365), resolveJavaScriptTargets walks discovered package.json manifests with lockfile/packageManager-derived manager (~387-450), resolveJvmTargets handles pom.xml and build.gradle[.kts] statically (~452), resolveDotnetTargets handles .csproj (~489), resolveCMakeTargets handles CMakeLists.txt (~512), resolvePythonTargets handles pyproject.toml/setup.py (~534). (b) Wiring VERIFIED not dead code: sdk/src/tools/get-build-targets.ts:14-25 calls resolveOwningTargets and adds additive owningTargets to the output, and common/src/tools/params/tool/get-build-targets.ts:23-44 declares owningTargets optional in the outputSchema with an honest 'absent when resolution failed' description; fail-open try/catch in the tool keeps the existing targets result intact. (c) Longest-prefix ownership VERIFIED: resolveOwningTargets (~690-703) picks max root.length with a confidenceRank tiebreak. (d) TTL cache VERIFIED: buildGraphCacheTtlMs=5_000, maxEntries 32, insert-order eviction (~572-665). (e) Bounded walk VERIFIED (F3 fix): discoverBuildGraphFiles is iterative with MAX_WALK_DEPTH=12 / MAX_VISITED_DIRS=2000 and skips symlinks (~154-196). (f) SAFE_COMMAND_TOKEN allowlist VERIFIED everywhere identifiers are interpolated: cargo -p name, go import path, JVM mvn -pl dir and gradle :path, dotnet csproj path, python pytest dir, and — BG-1 fix confirmed — the packageManager-derived JS manager passes through the same whitelist with an 'npm' fallback (resolveJavaScriptTargets: `safeCommandToken(manager ?? '') ?? 'npm'`). (g) Deferred systems VERIFIED documented and not pretended: module header lines 9-10 state 'Deferred: Bazel, nx, real MSBuild, the Gradle Tooling API, and the CMake File API are not implemented'; CMake targets honestly carry no commands.

## [LOW] api-contract — sdk/src/services/build-graph.ts:695 — resolveOwningTargets silently truncates input beyond maxFilesPerCall=500 without a truncation flag
- **Risk:** A caller passing more than 500 files gets owning-target resolution for only the first 500 with no signal that the rest were skipped; per-file results for later files are silently absent rather than honestly flagged, an honesty gap inconsistent with the truncated flag pattern used elsewhere this wave.
- **Fix:** Add an additive optional `truncated`/`filesConsidered` field to the get_build_targets output (mirroring the semgrep truncated flag) or at least document the cap in the tool description.
- **Evidence:** sdk/src/services/build-graph.ts:~695 `params.files.slice(0, maxFilesPerCall)` with maxFilesPerCall=500 (~93); no `truncated` flag exists on the get_build_targets output schema (common/src/tools/params/tool/get-build-targets.ts), unlike the semgrep securityScan `truncated` cap flag added in the same wave per STATUS.md:344.

## [LOW] correctness — sdk/src/services/build-graph.ts:642 — buildGraphCache key does not include the runner, so an injected runner can observe a previous runner's cached index within the TTL window
- **Risk:** A caller that passes a custom BuildGraphRunner within the same 5s TTL window for a cwd already cached under the default runner receives the default runner's results (real spawnSync output) instead of its injected seam's output, so injected-runner behavior is not hermetic across calls within a TTL window.
- **Fix:** Either include a runner identity in the cache key or document that non-default runners must clear the cache / construct separate instances.
- **Evidence:** sdk/src/services/build-graph.ts:~642-665 cachedTargetIndex looks up buildGraphCache by root only; the runner parameter is not part of the cache key; clearBuildGraphCache is exported for tests, which is the documented mitigation.

## [LOW] test-coverage — sdk/src/services/symbol-enrichment.ts:237 — P3-T6 plan note is accurate today but structurally fragile: the inlayHint tier is detected only via a duck-typed capability check against a seam the real multiplexer does not satisfy
- **Risk:** The inlayHint-absent degradation is asserted against the seam type, but nothing pins the structural compatibility of the real LspMultiplexer with SymbolEnrichmentMultiplexer; if either type drifts (e.g. hover signature changes), the mismatch would surface only at the point a future consumer wires enrichment, not in tests.
- **Fix:** Add a compile-time or runtime conformance assertion (e.g. a type-level satisfies check or a test asserting createLspMultiplexer output is assignable to SymbolEnrichmentMultiplexer) so a future inlayHint addition to the multiplexer is noticed.
- **Evidence:** sdk/src/__tests__/symbol-enrichment.test.ts covers the service seam; sdk/src/__tests__/harness-read-tools.test.ts:74-80 pins the owningTargets field; no test exercises the real LspMultiplexer against the SymbolEnrichmentMultiplexer seam (the real type lacks inlayHint entirely, so the check can only ever be false in production).

## Coverage receipt

### Subsystems
- sdk-symbol-enrichment
- sdk-harness-intelligence
- sdk-build-graph
- sdk-lsp-multiplexer
- sdk-tool-get-build-targets
- sdk-tool-get-affected-tests
- common-tool-param-schemas

### Features
- p3-t6-symbol-enrichment
- p3-t7-test-impact-tiers
- p3-t8-build-graph

### Files
- sdk/src/services/symbol-enrichment.ts
- sdk/src/services/harness-intelligence.ts
- sdk/src/services/build-graph.ts
- sdk/src/tools/get-build-targets.ts
- sdk/src/tools/get-affected-tests.ts
- sdk/src/services/lsp-multiplexer.ts
- common/src/tools/params/tool/get-build-targets.ts
- common/src/tools/params/tool/get-affected-tests.ts
- .agents/sessions/polyglot-roadmap-v2/PLAN.md

### Domains
- correctness
- error-handling
- security
- api-contract
