# Audit findings: p3-f-tests

- Subsystems: sdk-language-intelligence, sdk-lsp-multiplexer, sdk-symbol-enrichment, sdk-build-graph, sdk-diagnostic-delta, sdk-semgrep-baseline, sdk-harness-intelligence, sdk-get-change-review-bundle, indexer-scip-ingest, indexer-pagerank, agent-runtime-token-counter, agent-runtime-language-handlers
- Features: P3-T2 tool-registration consistency + per-language fixture tests, P3 security repairs F1-F4 regression pinning, OPENBUFF_DIAGNOSTIC_PREFLIGHT flag-off identity, OPENBUFF_EXACT_TOKENS flag-off identity, pageRankWeight default-0 identity, LSP Content-Length framing, SCIP ingest safety caps, semgrep SARIF baseline, diagnostic-delta preflight, harness workspace leases, get-change-review-bundle snapshot identity
- Files covered: 17
- Snapshot: f6f2d4aa162b3cc09c6d64e96f8e03bb4b430c5444981de1b88a548d1690980a

## [MEDIUM] test-coverage — sdk/src/__tests__/lsp-multiplexer.test.ts:429 — F1 LSP malformed-header fail-closed has NO regression test (fixed without a pinning test)
- **Risk:** The fail-closed branch added by the security repair can regress silently: nothing fails if the guard is deleted, since the fake peer never emits a header without Content-Length.
- **Fix:** Add a FakePeer variant (or raw stdout injection) that emits a header block without Content-Length (and one with a non-numeric length), then assert the mux transitions to gone/disposes the child rather than parsing garbage.
- **Evidence:** sdk/src/services/lsp-multiplexer.ts:429-433 `// Fail closed on a malformed header... this.handleGone('malformed LSP header: missing Content-Length')`. lsp-multiplexer.test.ts:24-77 makePeer's stdin parser only ever matches /Content-Length:\s*(\d+)/i and the only frame source is the frame() helper at :22-24 which always emits a valid header. Zero test references 'malformed'.

## [MEDIUM] test-coverage — sdk/src/__tests__/build-graph.test.ts:1 — F4 command-token whitelist (build-graph.ts:163-166) has NO regression test
- **Risk:** If the whitelist regex is widened or bypassed (e.g. during a refactor), arbitrary tool output could be interpolated into testCommand/buildCommand with no test catching it — the exact command-injection class F4 was filed for.
- **Fix:** Add a test with a runner returning a package name containing a shell metacharacter (e.g. `core; rm -rf /` or a space) and assert resolveOwningTargets yields no targets/command for that file (skip, not guess).
- **Evidence:** sdk/src/services/build-graph.ts:163 `const SAFE_COMMAND_TOKEN = /^[A-Za-z0-9._~/:-]+$/`, used at :221 (cargo name), :292 (go ImportPath), :409 (dotnet dir), :427 (gradle path), :451. build-graph.test.ts only feeds safe names ('core', 'example.com/mymod/api', '@app/api'); code_search for unsafe-name/shell-metachar tests in the file returns nothing.

## [LOW] test-coverage — sdk/src/services/build-graph.ts:113 — F3 build-graph directory-walk depth cap untested (only the 500-file input cap is pinned)
- **Risk:** The depth bound (the actual F3 repair) can be regressed to an unbounded recursion/walk without any test failing; only the per-call file cap is pinned.
- **Fix:** Add a fixture with a >12-deep nested manifest (or deep source file) and assert discovery stops/does not recurse beyond the bound and the file resolves to 'unknown' rather than hanging.
- **Evidence:** sdk/src/services/build-graph.ts:113 `const MAX_WALK_DEPTH = 12` with stack-based iterative walk at :116-136. build-graph.test.ts:380-385 'caps the number of files resolved per call' asserts length 500 only. No fixture creates nested directories near depth 12.

## [MEDIUM] test-coverage — sdk/src/__tests__/lsp-multiplexer.test.ts:243 — 'handles a partial frame split across chunks' test does not test partial frames (asserts nothing about splitting)
- **Risk:** STATUS claims bounded frame buffers and crash-restart handling are 'hermetically tested', but frame-split reassembly and the runaway-peer kill switch are untested; the test name suggests coverage that does not exist.
- **Fix:** Inject a stdout chunk sequence that splits one frame across multiple data events (and a >cap frame) and assert the response is reassembled / the peer is failed closed.
- **Evidence:** sdk/src/services/lsp-multiplexer.ts:24 'Bounded frame-reassembly buffer (fail closed on a runaway peer)'; :418 runaway-peer fail-closed. The test at :243-251 contains the self-defeating comment 'Wrap: re-emit responses byte-by-byte by intercepting stdout listeners is complex; instead assert the client reassembles by sending two chunks' and then only asserts Array.isArray(result).

## [MEDIUM] test-coverage — packages/agent-runtime/src/tools/handlers/tool/__tests__/language-intelligence.test.ts:1 — P3-T2 gate 'per-language fixture tests' only partially satisfied: language-intelligence path is entirely mock-based with 2-language extension mapping; no real per-language fixtures
- **Risk:** The STATUS 'language-intelligence handlers' claim rests on a 1-test pass-through seam; regressions in handler-level behavior (input forwarding drift, error envelope shape) would not be caught.
- **Fix:** Either expand the handler tests (error-envelope forwarding, unexpected toolName, malformed input) or add a small consistency test asserting the four tool names appear in tools/list.ts, handlers/list.ts, and the renderer registry.
- **Evidence:** packages/agent-runtime/src/tools/handlers/tool/__tests__/language-intelligence.test.ts:1-77 (single describe, single test, requestClientToolCall stub returns a fixed empty envelope); compare sdk/src/__tests__/language-intelligence.test.ts (8 tests, ~12 assertions). PLAN.md:100 P3-T2 gate 'tool-registration consistency + per-language fixture tests' — registration is pinned in common/src/tools/list.ts:112-115,317-330 + handlers/list.ts:109-112, but no test cross-checks list.ts↔handlers↔cli renderers automatically.

## [LOW] test-coverage — sdk/src/__tests__/language-intelligence.test.ts:159 — harness-read-tools and agent-runtime handler suites are much thinner than the STATUS aggregate suggests
- **Risk:** The plan gate reads as real per-language fixtures; in reality the LSP-facing layer is validated only against hand-written fakes, so per-language wiring (e.g. which extension maps to which server spec) for the other ~dozens of supported languages is untested.
- **Fix:** Add at least one fixture per supported languageId for the extension→language→server-spec resolution chain (pure, no LSP needed), or relax the STATUS/gate wording to 'metadata-layer multi-ecosystem fixtures'.
- **Evidence:** sdk/src/__tests__/language-intelligence.test.ts:159-181 test.each([['src/foo.ts','typescript'],['src/foo.py','python']]) — only 2 entries and both assert the same mocked unavailable shape; lsp-multiplexer.test.ts covers .ts/.py/.gd spawn decisions but always via makePeer. Multi-language fixture coverage DOES exist in build-graph.test.ts (rust/go/js/java/jvm/dotnet/cmake/python, 7+ ecosystems) and diagnostic-delta (ruff+cargo parsers) and harness-intelligence (bun/pnpm/cargo/uv).

## [LOW] test-coverage — sdk/src/__tests__/harness-read-tools.test.ts:16 — Assertion-count spot check: two suites are 1-test files; per-suite counts broadly match STATUS claims
- **Risk:** Aggregate suite counts are honest, but a reader of STATUS could over-read the two 1-test files as substantive validation of their subsystems.
- **Fix:** None required for the suite-count claim itself (it holds); optionally fold harness-read-tools coverage into harness-intelligence tests or add a renderer-shape test for the cli side.
- **Evidence:** sdk/src/__tests__/harness-read-tools.test.ts:16-65 single test (~5 expect calls, though it does pin the byte-identical `targets` field plus the new tiered `impact` shape). suites counts: language-intelligence sdk 8 tests/~12 asserts; lsp-multiplexer 12/~28; symbol-enrichment 13/~30; build-graph 9/~45 (dense toEqual); diagnostic-delta 24/~48; semgrep-baseline 9/~26; harness-intelligence 14/~55; get-change-review-bundle 10/~38; scip-ingest 11/~36 (matches '11/11'); pagerank 16/~38; token-counter 20/~46.

## Coverage receipt

### Subsystems
- sdk-language-intelligence
- sdk-lsp-multiplexer
- sdk-symbol-enrichment
- sdk-build-graph
- sdk-diagnostic-delta
- sdk-semgrep-baseline
- sdk-harness-intelligence
- sdk-get-change-review-bundle
- indexer-scip-ingest
- indexer-pagerank
- agent-runtime-token-counter
- agent-runtime-language-handlers

### Features
- P3-T2 tool-registration consistency + per-language fixture tests
- P3 security repairs F1-F4 regression pinning
- OPENBUFF_DIAGNOSTIC_PREFLIGHT flag-off identity
- OPENBUFF_EXACT_TOKENS flag-off identity
- pageRankWeight default-0 identity
- LSP Content-Length framing
- SCIP ingest safety caps
- semgrep SARIF baseline
- diagnostic-delta preflight
- harness workspace leases
- get-change-review-bundle snapshot identity

### Files
- sdk/src/__tests__/language-intelligence.test.ts
- sdk/src/__tests__/lsp-multiplexer.test.ts
- sdk/src/__tests__/symbol-enrichment.test.ts
- sdk/src/__tests__/build-graph.test.ts
- sdk/src/__tests__/diagnostic-delta.test.ts
- sdk/src/__tests__/semgrep-baseline.test.ts
- sdk/src/__tests__/harness-intelligence.test.ts
- sdk/src/__tests__/get-change-review-bundle.test.ts
- packages/indexer/src/scip-ingest.test.ts
- packages/indexer/src/pagerank.test.ts
- packages/agent-runtime/src/util/__tests__/token-counter.test.ts
- packages/agent-runtime/src/tools/handlers/tool/__tests__/language-intelligence.test.ts
- sdk/src/__tests__/harness-read-tools.test.ts
- sdk/src/services/lsp-multiplexer.ts
- sdk/src/services/build-graph.ts
- .agents/sessions/polyglot-roadmap-v2/PLAN.md
- .agents/sessions/polyglot-roadmap-v2/STATUS.md

### Domains
- test-coverage
- correctness
