# Audit findings: p3-b-sdk-services

- Subsystems: p3-lsp-multiplexer, language-intelligence, diagnostic-delta, symbol-enrichment, build-graph, semgrep-baseline, harness-intelligence, tools-language-intel, tools-harness-reads, run-p3-wiring
- Features: P3-T1, P3-T3, P3-T6, P3-T7, P3-T8, P3-T11
- Files covered: 15
- Snapshot: f6f2d4aa162b3cc09c6d64e96f8e03bb4b430c5444981de1b88a548d1690980a

## [HIGH] correctness — sdk/src/services/lsp-multiplexer.ts:776 — syncFile is an unwired seam — mutation broker never syncs LSP documents (P3-T1 gap)
- **Risk:** After any edit committed through the mutation broker (change-file/filesystem-authority/workspace-mutation-broker), open LSP documents are never sent didChange, so every warm server answers definition/hover/references against stale text. The plan requires document sync through the mutation broker; the header comment itself admits syncFile is 'a no-op-safe standalone method'.
- **Fix:** Wire syncFile into the broker commit path (post-commit receipt handler) or into change-file.ts's apply path, issuing didOpen/didChange/didClose with the committed version/text; add an integration test asserting a broker edit is visible to a subsequent hover.
- **Evidence:** Code search for 'syncFile' across sdk/src + common/src finds only the definition (lsp-multiplexer.ts:541,776), its own doc comment (:26), and test call sites (sdk/src/__tests__/lsp-multiplexer.test.ts:183-198, fake at language-intelligence.test.ts:39). No production caller.

## [HIGH] correctness — sdk/src/services/language-intelligence.ts:156 — Production multiplexer has no rootResolver — per-root keying degenerates to per-directory
- **Risk:** createLanguageIntelligence builds createLspMultiplexer({ spawner }) without options.rootResolver, so defaultRootResolver (lsp-multiplexer.ts:515-525) returns the file's parent directory and ignores spec.rootMarkers entirely. Server keys become (language, file-directory), so a monorepo spawns a server per directory, and DEFAULT_MAX_SERVERS=4 LRU eviction (lsp-multiplexer.ts:30,611-622) thrashes/kills warm servers mid-session — contradicting the plan's 'one warm server per language/root' and STATUS's 'warm server per (language,root)' claim.
- **Fix:** Pass a rootMarker-aware rootResolver (walk up to nearest tsconfig.json/Cargo.toml/go.mod etc.) in language-intelligence.ts:156, and add a test that two files in the same marker-root share one warm server.
- **Evidence:** lsp-multiplexer.ts:519-521 comment: 'production wiring supplies a real rootMarker-aware resolver' — but the only production construction site (language-intelligence.ts:156-163) passes only { spawner }; rootMarkers from the spec (lsp-multiplexer.ts:630) are discarded by the default resolver.

## [HIGH] correctness — sdk/src/run.ts:2571 — P3-T3 rejection gate unreachable: no caller supplies the diagnosticDelta injector
- **Risk:** The 'reject edit only if it introduces NEW errors' behavior never executes. runFileChangeHooks only runs the preflight when BOTH the env flag is set AND a diagnosticDelta injector is passed (file-change-hooks.ts:876); run.ts:2571-2577 and run-targeted-validation.ts:78-86 call it without diagnosticDelta, and preflightDiagnosticDelta has zero production callers. Even with OPENBUFF_DIAGNOSTIC_PREFLIGHT=1 the feature is dormant — the flag-off byte-identical claim is trivially true because the on-path is dead too.
- **Fix:** Wire preflightDiagnosticDelta (with applyEdit/rollbackEdit callbacks owning the mutation lifecycle) into the broker/edit path and pass it as diagnosticDelta from run.ts and run-targeted-validation.ts; add an end-to-end test with the flag on.
- **Evidence:** preflightDiagnosticDelta (diagnostic-delta.ts:245) is referenced only by sdk/src/__tests__/diagnostic-delta.test.ts; DiagnosticDeltaHook type (file-change-hooks.ts:728-733) and its consumer (:876-899) are never given an injector in run.ts:2571 or run-targeted-validation.ts:78.

## [MEDIUM] correctness — sdk/src/services/diagnostic-delta.ts:110 — Optional incremental daemons (tsc --watch, cargo check JSON, ruff server, dmypy) not implemented and deferral undocumented
- **Risk:** P3-T3 lists optional incremental daemons; only one-shot commands exist (DIAGNOSTIC_COMMANDS, :110-117). Each preflight runs up to 4 project-wide commands twice (baseline + after) at up to 120s each (DEFAULT_DIAGNOSTIC_TIMEOUT_SECONDS :101) — if the seam is ever wired this is minutes of latency per edit. Nothing in the module header or STATUS-marked code records the daemons as deferred.
- **Fix:** Document the deferral in the module header and PLAN/STATUS, or implement a persistent watch tier behind the runner seam; also lower the effective per-capture wall clock before wiring.
- **Evidence:** Code search for '--watch|dmypy' across sdk/src, common/src, packages returns zero hits; diagnostic-delta.ts header (lines 10-44) mentions tiers 1-2 only, no daemon note.

## [MEDIUM] correctness — sdk/src/services/build-graph.ts:621 — build-graph service (P3-T8) is dead code — no production caller
- **Risk:** resolveOwningTargets and the whole ecosystem-target index are implemented and unit-tested but never invoked by any tool or run.ts branch. The shipped get_build_targets tool uses the manifest-based getBuildTargets from harness-intelligence instead, so owning-target builds (the plan's LI-07 goal) are not actually delivered to agents; the dual implementations can also drift.
- **Fix:** Either surface resolveOwningTargets through a tool / get_build_targets enrichment, or merge the two implementations and delete the unused one; record the decision in STATUS.
- **Evidence:** resolveOwningTargets is referenced only by sdk/src/__tests__/build-graph.test.ts (lines 9,72-391); get-build-targets.ts:1-3 imports getBuildTargets from harness-intelligence; run.ts:2681-2685 dispatches that one.

## [MEDIUM] test-coverage — sdk/src/services/build-graph.ts:89 — build-graph covers a subset of the plan's toolchains; missing entries undocumented
- **Risk:** Plan P3-T8 lists cargo metadata / go list / Gradle Tooling API / CMake File API / MSBuild / bazel / nx. Implemented: cargo metadata, go list, package.json workspaces, pom/gradle static files, .csproj, CMakeLists.txt, pyproject/setup.py. Missing: Bazel (no BUILD/WORKSPACE/BUILD.bazel in discoveredFileNames :89-102), nx, and MSBuild project evaluation (only .csproj filename discovery at :140). Gradle and CMake are static manifest parses, not the Tooling API / File API the plan names. The module documents no deferral.
- **Fix:** Add bazel/nx/MSBuild resolvers or an explicit 'supported toolchains' header note marking the rest deferred; note the Gradle-Tooling-API/CMake-File-API substitution as a deliberate downgrade.
- **Evidence:** discoveredFileNames (build-graph.ts:89-102) and resolver list (build-graph.ts:547-555) contain no bazel/nx/msbuild entries; no 'deferred' or 'subset' wording anywhere in the file.

## [MEDIUM] correctness — sdk/src/services/symbol-enrichment.ts:264 — symbol-enrichment (P3-T6) never called in production; real multiplexer lacks inlayHint
- **Risk:** The sha256-content-keyed LRU enrichment service is implemented and tested but no tool or run.ts path calls enrichFileSymbols — hover_type answers via language-intelligence directly with no cache and no documentSymbol/inlayHint layering, so the P3-T6 deliverable is unreachable. Additionally the production LspMultiplexer type (lsp-multiplexer.ts:527-550) has no inlayHint method, so even a future wiring would silently skip the inlayHint tier (capability check symbol-enrichment.ts:237).
- **Fix:** Expose enrichment through hover_type/read-files output or an explicit tool; add inlayHint to LspMultiplexer behind server capability negotiation, or drop the optional tier honestly.
- **Evidence:** enrichFileSymbols referenced only by sdk/src/__tests__/symbol-enrichment.test.ts; LspMultiplexer type (lsp-multiplexer.ts:527-550) declares definition/references/hover/documentSymbol/workspaceSymbol/syncFile only — no inlayHint.

## [MEDIUM] correctness — sdk/src/tools/get-affected-tests.ts:8 — get_affected_tests graph tier always empty — reverseDeps seam never wired to the indexer
- **Risk:** Plan P3-T7 tier 2 (graph/SCIP reverse deps) is implemented inside analyzeTestImpact but unreachable through the shipped tool: getAffectedTests calls analyzeTestImpact(cwd, files) with no options, so reverseDeps defaults to a no-op returning [] (harness-intelligence.ts:503) and every agent call sees graph: []. The in-file comment admits the sdk lacks an accessor for the indexer reference graph, so plan tier 2 ships empty in practice.
- **Fix:** Expose a bounded reverse-dependency lookup from the indexer (or packages/indexer query engine) and inject it at run.ts:2656; until then state the limitation in the tool output rather than only in a source comment.
- **Evidence:** get-affected-tests.ts:8-12 comment 'the graph tier stays empty here'; harness-intelligence.ts:503 `options.reverseDeps ?? (() => [])`; run.ts:2657 calls getAffectedTests(cwd, files) with no reverseDeps.

## [LOW] security — sdk/src/services/semgrep-baseline.ts:51 — semgrep: whitelist permits traversal-shaped refs, sync spawn blocks the event loop, >200-file truncation silent
- **Risk:** SAFE_BASELINE_REF's second alternative (^[A-Za-z0-9][A-Za-z0-9._/~^-]*$) accepts strings like 'a~../../x' — no injection risk (the ref travels as one argv token in '--baseline-commit=<ref>', never shell-interpolated, and the bundle path only passes hex merge-base output), but the whitelist is weaker than its comment implies. Separately, defaultRunner uses spawnSync with up to 60s timeout, blocking the JS event loop for the whole scan inside getChangeReviewBundle; files beyond MAX_SEMGREP_FILES=200 are silently dropped with no truncation marker in the result.
- **Fix:** Tighten the ref regex to hex-or-known-ref shapes; move to an async spawn or run the scan off the tool's critical path; add a truncatedFiles marker when the 200 cap clips.
- **Evidence:** semgrep-baseline.ts:51-52 regex; :176-186 argv construction ('--baseline-commit=' prefix, no shell); :47 spawnSync with timeout; :177-179 silent slice(0, MAX_SEMGREP_FILES); get-change-review-bundle.ts:88-96 passes only hex merge-base/HEAD~1.

## [LOW] correctness — sdk/src/services/symbol-enrichment.ts:269 — symbol-enrichment cache key omits file path — cross-file collisions on identical content
- **Risk:** The LRU is keyed only by sha256(fileText); two different files with byte-identical text share an entry. For servers whose documentSymbol/hover results depend on project context (imports, tsconfig paths), the second file can receive the first file's symbols/ranges. STATUS's 'sha256-content-keyed' claim is accurate but the key is weaker than content+path.
- **Fix:** Include filePath (and ideally languageId) in the cache key alongside the content hash.
- **Evidence:** symbol-enrichment.ts:269 `const cacheKey = createHash('sha256').update(fileText).digest('hex')` — filePath is destructured (:268) but unused in the key.

## Coverage receipt

### Subsystems
- p3-lsp-multiplexer
- language-intelligence
- diagnostic-delta
- symbol-enrichment
- build-graph
- semgrep-baseline
- harness-intelligence
- tools-language-intel
- tools-harness-reads
- run-p3-wiring

### Features
- P3-T1
- P3-T3
- P3-T6
- P3-T7
- P3-T8
- P3-T11

### Files
- sdk/src/services/lsp-multiplexer.ts
- sdk/src/services/language-intelligence.ts
- sdk/src/services/diagnostic-delta.ts
- sdk/src/services/symbol-enrichment.ts
- sdk/src/services/build-graph.ts
- sdk/src/services/semgrep-baseline.ts
- sdk/src/services/harness-intelligence.ts
- sdk/src/tools/go-to-definition.ts
- sdk/src/tools/find-references.ts
- sdk/src/tools/hover-type.ts
- sdk/src/tools/workspace-symbol.ts
- sdk/src/tools/get-affected-tests.ts
- sdk/src/tools/get-change-review-bundle.ts
- sdk/src/tools/file-change-hooks.ts
- sdk/src/run.ts

### Domains
- correctness
- error-handling
- performance
- security
- test-coverage
