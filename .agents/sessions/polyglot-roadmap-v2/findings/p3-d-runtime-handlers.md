# Audit findings: p3-d-runtime-handlers

- Subsystems: agent-runtime, sdk, common
- Features: P3-T2, P3-T7, P3-T10, P3-T11, D12
- Files covered: 15
- Snapshot: f6f2d4aa162b3cc09c6d64e96f8e03bb4b430c5444981de1b88a548d1690980a

## [MEDIUM] test-coverage — sdk/src/__tests__/language-intelligence.test.ts:168 — P3-T2 'per-language fixture tests' gate covers 2 of ~10 languages, all against fake multiplexers, no real-server fixture
- **Risk:** The P3-T2 gate ('tool-registration consistency + per-language fixture tests') is only partially satisfied: per-language resolution is tested for exactly 2 of the ~10 registered languages (typescript, python) and every test runs against an injected FAKE multiplexer — no test spawns a real language server. The registry supports tsserver/pyright/rust-analyzer/gopls/jdtls/Roslyn/clangd/ruby-lsp/intelephense (common/src/util/language-capabilities.ts:121-445) but none of those languages has a fixture test, and lsp-multiplexer.test.ts contains no languageId/no-server-spec coverage at all. A broken server spec for e.g. rust-analyzer or clangd would ship undetected. STATUS.md's 'end-to-end' wording overstates the coverage.
- **Fix:** Either add fixture tests for the remaining registered languages (at least a matrix over getLanguageToolSpecs entries) or amend the gate wording/STATUS to say per-language resolution is covered for 2 languages with fake multiplexers and real-server fixtures are deferred; document the deferral explicitly.
- **Evidence:** sdk/src/__tests__/language-intelligence.test.ts:168-196 test.each covers only typescript + python via a fake multiplexer that throws LspServerUnavailableError; common/src/util/language-capabilities.ts:121-445 registers tsserver/pyright/rust-analyzer/gopls/jdtls/Roslyn/clangd/ruby-lsp/intelephense specs; agent-runtime handler test (language-intelligence.test.ts:8-77) asserts only forwarded input shape against a fake requestClientToolCall; code_search for languageId/no-server-spec in sdk/src/__tests__/lsp-multiplexer.test.ts returns zero matches

## [MEDIUM] api-contract — packages/agent-runtime/src/util/token-counter.ts:119 — P3-T10: ExactTokenCounter is a seam with zero real implementations — fudge factors remain active and no eval-confirmed removal has occurred
- **Risk:** P3-T10 requires 'Remove the fudge factors behind an eval-confirmed flag'. The landed slice adds only the ExactTokenCounter seam, the OPENBUFF_EXACT_TOKENS gate, and the family cache; no tiktoken or HF tokenizers dependency exists anywhere in the workspace (bun.lock lists only gpt-tokenizer@2.9.0; packages/agent-runtime/package.json:30), registerExactTokenCounter/exactFamilyMatcher/getTokenizerForModel are referenced only by the test file, and with the flag ON but no registered provider the fudged 1.35/1.1 estimator silently remains the count source. There is also no EVAL-CONFIRMED evidence artifact for removing the factors. The gap IS documented in-code (token-counter.ts:116-121 'land behind this interface in a later slice — a new tokenizer dependency needs separate approval') and STATUS.md honestly says 'dependency-gated', so this is not an overclaim — but the plan item is NOT complete and the flag currently toggles nothing in production.
- **Fix:** Keep the seam but (a) mark P3-T10 as partially complete (seam + gate + family cache only, fudge factors still active) in STATUS/PLAN, (b) when providers land, gate their activation on documented eval confirmation per the plan's 'eval-confirmed flag' wording, and (c) record the X-2 baseline row reference in the P3-T10 DONE note.
- **Evidence:** token-counter.ts:116-121 'Concrete providers (tiktoken/HuggingFace) land behind this interface in a later slice — a new tokenizer dependency needs separate approval'; bun.lock:994 only gpt-tokenizer@2.9.0; packages/agent-runtime/package.json:30 'gpt-tokenizer'; referencedBy for registerExactTokenCounter/exactFamilyMatcher/getTokenizerForModel lists only packages/agent-runtime/src/util/__tests__/token-counter.test.ts; tests use a lengthCounter fake, never a real tokenizer

## [MEDIUM] correctness — sdk/src/tools/get-affected-tests.ts:13 — P3-T7 impact tiers are schema-present but the graph tier is inert in production (only convention tier populated)
- **Risk:** P3-T7 specifies tiered impact analysis across conventions, graph/SCIP reverse deps, build-tool queries, and coverage maps. The schema (common/src/tools/params/tool/get-affected-tests.ts:23-43) carries all four tier arrays plus per-candidate confidence ('high'|'medium'|'low', matching harness-intelligence.ts:392), but the SDK production tool wires only the convention tier: the comment at sdk/src/tools/get-affected-tests.ts:13-17 states the graph tier seam is a no-op because queryReferences is internal to packages/indexer. Graph/buildTool/coverage tiers are structurally present but empty in every production result. Confidence labels exist, so the letter of 'each result carries a confidence label' holds; the tier breadth does not.
- **Fix:** Document in the P3-T7 STATUS entry that only the convention tier is live in production pending the indexer reverse-deps seam, or expose a queryReferences accessor so the graph tier produces results.
- **Evidence:** sdk/src/tools/get-affected-tests.ts:13-17 comment 'The graph tier stays empty here: the sdk has no direct accessor for the indexer reference graph ... analyzeTestImpact runs with its default no-op reverse-deps seam'; common/src/tools/params/tool/get-affected-tests.ts:23-27 tiers object with convention/graph/buildTool/coverage arrays; harness-intelligence.ts:392 TestImpactConfidence = 'high' | 'medium' | 'low'

## [LOW] error-handling — sdk/src/services/language-intelligence.ts:200 — Unknown non-LSP errors escape the structured-degradation boundary and rethrow
- **Risk:** The 'never throws, structured unavailable/error degradation' claim holds only for the two typed error classes. runQuery re-throws any other error, and requestClientToolCall transport failures propagate through the agent-runtime handlers unchanged (all six handlers are bare pass-throughs awaiting previousToolCallFinished then the client call). This is arguably honest (unknown errors fail loudly) but it is an untested and undocumented boundary: a test pins LspServerError -> errorMessage and LspServerUnavailableError -> unavailable, but no test pins the rethrow behavior, and no code comment states which error classes are deliberately allowed to escape.
- **Fix:** Either fold unknown errors into a structured errorMessage with a distinct reason, or add a test pinning the rethrow contract so the boundary is deliberate and visible.
- **Evidence:** sdk/src/services/language-intelligence.ts:196-206 runQuery catch: LspServerUnavailableError -> toUnavailable, LspServerError -> toErrorMessage, bare 'throw error' otherwise; lsp-multiplexer.ts:626 throws on disposed multiplexer but also as LspServerError (caught); sdk/src/__tests__/language-intelligence.test.ts:119-131 tests only the LspServerError branch

## [LOW] api-contract — packages/agent-runtime/src/tools/handlers/list.ts:1 — No dead handlers: all six new handlers registered and type-enforced; token-counter seam exports are test-only by design
- **Risk:** None found: all six handlers (find_references/go_to_definition/hover_type/workspace_symbol at list.ts:106-109, get_change_review_bundle at :90, get_affected_tests at :137-equivalent) are imported and registered in codebuffToolHandlers, and the record is type-checked with satisfies {[K in ToolName]: CodebuffToolHandlerFunction<K>} so a missing registration fails typecheck. Tool-registration consistency for the P3-T2 gate holds on the agent-runtime side (common/src/tools/list.ts registers both param schemas at :94/:113 and client tool call schema entries at :236/:321). The token-counter exported-for-test functions are production-unused by design and named/commented as such.
- **Fix:** None required; record as verified-positive evidence.
- **Evidence:** list.ts:26-29 imports the four LI handlers, :46/:88-89 import/registers get_affected_tests and get_change_review_bundle; list.ts:138-152 'satisfies { [K in ToolName]: CodebuffToolHandlerFunction<K> }'; common/src/tools/list.ts:94/113 registers both param schemas; referencedBy on all six handler files shows their test files, and list.ts consumes them in production

## [LOW] performance — packages/agent-runtime/src/util/token-counter.ts:398 — Exact-tokenizer path memory/latency bounds verified; flag-off path byte-identical
- **Risk:** No defect: the exact path is bounded (MAX_EXACT_ENCODE_CHARS=1M, 100k sample extrapolation above), provider caches inherit the 8KB/1000-entry LRU discipline, and the family cache is a bounded LRU tested for churn. Flag-off byte-identity is verified by the test asserting countTokens(text,'anthropic/...') === countTokens(text) with the gate off, and the gate read is per-call (deliberately uncached, documented). Only residual note: the exact path bypasses the 100k BPE cap, so a provider counting a 900k-char input in full could add latency — bounded but worth a baseline row when providers land (ties to D12).
- **Fix:** None required; note in the provider-slice handoff that the 100k..1M full-encode band should get a latency row in the X-2 baseline.
- **Evidence:** token-counter.ts:100-113 family LRU 1000 entries; :139-143 registration cache 1000 entries with the same >100/<=8KB band; :398-412 exact oversized path extrapolates from a 100k sample; token-counter.test.ts 'provider cache honors MAX_CACHEABLE_INPUT_CHARS' pins the bands

## Coverage receipt

### Subsystems
- agent-runtime
- sdk
- common

### Features
- P3-T2
- P3-T7
- P3-T10
- P3-T11
- D12

### Files
- packages/agent-runtime/src/tools/handlers/tool/go-to-definition.ts
- packages/agent-runtime/src/tools/handlers/tool/find-references.ts
- packages/agent-runtime/src/tools/handlers/tool/hover-type.ts
- packages/agent-runtime/src/tools/handlers/tool/workspace-symbol.ts
- packages/agent-runtime/src/tools/handlers/tool/get-affected-tests.ts
- packages/agent-runtime/src/tools/handlers/tool/get-change-review-bundle.ts
- packages/agent-runtime/src/tools/handlers/list.ts
- packages/agent-runtime/src/util/token-counter.ts
- packages/agent-runtime/src/tools/handlers/tool/__tests__/language-intelligence.test.ts
- packages/agent-runtime/src/util/__tests__/token-counter.test.ts
- sdk/src/services/language-intelligence.ts
- sdk/src/__tests__/language-intelligence.test.ts
- sdk/src/tools/get-affected-tests.ts
- common/src/tools/params/tool/get-affected-tests.ts
- common/src/tools/params/tool/get-change-review-bundle.ts

### Domains
- correctness
- error-handling
- test-coverage
- api-contract
- dependency-hygiene
- performance
