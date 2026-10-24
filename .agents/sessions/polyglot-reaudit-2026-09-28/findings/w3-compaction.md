# Audit findings: w3-compaction

- Subsystems: agents, packages, common
- Features: context-pruner, consolidation, archive-recall, tool-result-simplification, compaction-verification, compaction-eligibility, runtime-semantic-compaction
- Files covered: 13
- Snapshot: 49801b44e84d3d8fa583c3ebd9b2855228bf122572b7cdf5f78c77b3389d824d

## [HIGH] correctness — packages/agent-runtime/src/util/archive-recall-index.ts:75 — [POLY] FTS5 indexes JSON-escaped text: first word of every output line is glued to 'n' and unfindable
- **Risk:** toText() indexes JSON.stringify(part.value). Multi-line stdout/stderr (pytest, cargo, go test, gradle, tsc alike) becomes literal backslash-n sequences; unicode61 treats the backslash as a separator but keeps the following 'n' attached, so 'error[E0308]' at a line start is indexed as 'nerror', 'FAILED tests/x.py::test_y' as 'nfailed', '--- FAIL: TestFoo' leaves 'nfail'-style tokens, and tab-indented lines glue 't'. Queries for exactly the most important tokens (line-leading error/FAILED/panicked) return an empty indexed result with indexState 'indexed', so no fallback fires. This is a direct mechanism for the user report that recall_context 'effectively returns nothing'.
- **Fix:** Index a de-escaped, human-readable projection: for json parts, walk the value and join string leaves with newlines (keep JSON.stringify only for non-string scalars), or at minimum replace /\\[nrt]/g with a space before insert. Keep the scanner using the same projection so both paths stay consistent. Add a regression test with a multi-line cargo/pytest stdout seeded fact at a line start.
- **Evidence:** archive-recall-index.ts:75-82 toText uses JSON.stringify(part.value); :278 fts5(text, ...) with default unicode61 tokenizer; context-archive.ts:46 also stores truncate(JSON.stringify(part.value)) so the archived string itself is already escaped JSON.

## [HIGH] correctness — packages/agent-runtime/src/util/archive-recall-index.ts:278 — [POLY] Token-based FTS5 silently diverges from the substring scanner for identifiers (camelCase, partial names, Rust paths/generics, dunders)
- **Risk:** The docblock claims results are equivalent to recallFromArchive, but the scanner is substring and the index is whole-token. Query 'parse' finds 'parseConfig'/'parse_config' via scanner; FTS5 finds 'parse_config' (underscore splits) but not 'parseConfig' (single token 'parseconfig'), not 'HashMap' inside 'HashMap<String,Vec<u8>>' partials, not 'init' inside '__init__' partial prefix queries like 'Config' vs 'MyConfigLoader'. An empty indexed result is returned as healthy, never falling back, so recall regresses versus the scanner it replaced for exactly the partial-identifier queries a model issues. unicode61 remove_diacritics also makes the index match 'cafe' for 'café' where the scanner does not (minor divergence).
- **Fix:** Use tokenize='trigram' (SQLite >= 3.34, available in bun:sqlite) which gives substring semantics matching the scanner for terms >= 3 chars; route 1-2 char terms to the scanner. Optionally add a second column with a code-aware token stream (split camelCase/snake_case/::/<> while keeping the original token) for BM25 ranking. Alternatively: when the indexed path returns zero matches, run the scanner and return its results (cheap: archive is bounded).
- **Evidence:** archive-recall-index.ts:278 CREATE VIRTUAL TABLE ... USING fts5(text, ...) (no tokenize option => unicode61); :123 FTS5_OPERATOR_CHARS strips ':' so 'std::fs::read' becomes three AND terms; :126 HAS_TOKEN_CHAR; context-archive.ts:272 scanner uses lowered.includes(term). No test in archive-recall-index.test.ts or evals mentions camelCase/snake_case/trigram (code_search returned 0 matches).

## [HIGH] correctness — agents/context-pruner.ts:2760 — [POLY] Pruner keeps only 'command: exit N' for terminal runs; failing test names/errors from pytest, cargo, go test, gradle, dotnet, rspec are dropped
- **Risk:** For run_terminal_command the tool_facts entry records only 'Command failed with exit code: N' and knowledge_memory.validationResults records '<cmd>: exit N'. stdout/stderr content is never summarized; collectFailureTexts only captures strings that START with 'error'/'failed' or match edit-failure phrasing, which pytest ('===== test session starts'), cargo ('   Compiling'/'running 12 tests'), go ('=== RUN'), gradle ('> Task'), dotnet, rspec output never do. After compaction the agent knows a test run failed but not which test or why, forcing a re-run (expensive in cargo/gradle). VALIDATION_TOOLS (incl. 'basher') is declared but never used, so basher-run validation produces no validation result at all.
- **Fix:** Add a bounded, language-neutral failure extractor over stdout/stderr tails: capture lines matching a small multi-ecosystem table (pytest 'FAILED path::test' and 'E   ' lines, cargo 'test x ... FAILED'/'error[E....]'/'panicked at', go '--- FAIL:'/'FAIL\t', gradle 'FAILED'/'BUILD FAILED', dotnet 'Failed ', rspec 'rspec ./spec...:N', tsc 'error TS', eslint 'N problems') plus the final summary line; store up to K lines in validationResults. Use VALIDATION_TOOLS (or delete it) and handle basher/spawn results that carry exitCode.
- **Evidence:** context-pruner.ts:2757-2775 only exitCode and command (sliced to 77+'...') recorded; :233 const VALIDATION_TOOLS = ['run_terminal_command','basher'] has no other reference (code_search: 1 match); collectFailureTexts regex /^(?:error|failed)\b/i on whole strings.

## [HIGH] correctness — packages/agent-runtime/src/util/simplify-tool-results.ts:8 — [POLY] Head-only 2k excerpts lose the tail where pytest/cargo/gradle/go put the failure summary
- **Risk:** getOutputExcerpt keeps the first 2,000 chars of stdout/stderr. Most runners (pytest 'short test summary info', cargo 'failures:' + 'test result: FAILED', gradle 'BUILD FAILED' + 'What went wrong', go 'FAIL pkg', jest summary) emit the actionable part at the END, after collection/compile noise. Combined with DEFAULT_FULL_TOOL_RESULTS_TO_KEEP=1 (tool-result-lifecycle.ts:10), a failing test run becomes a head excerpt of compile progress as soon as any later verbose tool runs. context-archive.ts truncate() (4k head-only) has the same shape, so recall cannot recover the tail either.
- **Fix:** Use the same 80/20 head+tail strategy as the pruner's truncateLongText (or tail-biased 30/70 for failed commands) in getOutputExcerpt and context-archive truncate(); for failed commands prefer lines matched by the failure extractor proposed for the pruner. Consider keeping the newest failed run_terminal_command result full as a protected slot.
- **Evidence:** simplify-tool-results.ts:6 OUTPUT_EXCERPT_LIMIT=2_000, :13 trimmed.slice(0, OUTPUT_EXCERPT_LIMIT); :85-86 stdoutExcerpt only when failed but still head-only; context-archive.ts:29-32 value.slice(0, MAX_ARCHIVE_MESSAGE_CHARS); tool-result-lifecycle.ts:10 DEFAULT_FULL_TOOL_RESULTS_TO_KEEP = 1.

## [MEDIUM] correctness — packages/agent-runtime/src/util/context-archive.ts:267 — Archive recall searches only tool messages; archived user requirements and assistant decisions are unrecallable
- **Risk:** archivePreCompaction stores user and assistant messages, but recallFromArchive and buildArchiveRecallRows skip role !== 'tool'. The facts the pruner loses most (user constraints in long messages, assistant reasoning, tool-call inputs such as write_file content or the exact command) cannot be found via recall_context. Also archiveMessage truncates only tool messages, so user/assistant messages (e.g. write_file inputs with whole files) are stored unbounded, breaking the documented 8x200x4k persisted-size contract.
- **Fix:** Flatten user text, assistant text and tool-call inputs into recall rows (role column, UNINDEXED), and route every role through the 4k truncation in archiveMessage.
- **Evidence:** context-archive.ts:34-35 archiveMessage returns non-tool messages unchanged; :267 if (message.role !== 'tool') continue; archive-recall-index.ts:98 same filter in buildArchiveRecallRows.

## [MEDIUM] performance — packages/agent-runtime/src/util/archive-recall-index.ts:283 — [BEST] Per-call FTS5 rebuild without a transaction or prepared statement, then discards BM25 ordering
- **Risk:** Every recall_context call dynamic-imports bun:sqlite, creates an index and runs up to ~1,600 autocommitted db.run INSERTs (up to ~6.4 MB text) with no BEGIN/COMMIT and no reused prepared statement; then ORDER BY row_index DESC LIMIT 6 throws away relevance, so the index buys only token matching (which is worse than the scanner, see above) at higher cost. The archive changes only at compaction points, so rebuilding per query is avoidable.
- **Fix:** Wrap inserts in a transaction with db.prepare() reuse; cache the built index keyed by the compactionArchive array identity (WeakMap, the same identity discipline archivePreCompaction already uses) and invalidate on reassignment; order by bm25(recall) with recency as tiebreaker (or blend) so ranking justifies the index.
- **Evidence:** archive-recall-index.ts:283-293 loop of db.run(insert, ...) per row; :296 ORDER BY row_index DESC LIMIT ?; :197 await import('bun:sqlite') per call; module docblock lines 30-36 defer bm25 ordering.

## [MEDIUM] correctness — packages/agent-runtime/src/util/compaction-verification.ts:58 — [BEST] Verification misses write_file/edit paths and false-flags every command longer than 80 chars
- **Risk:** deriveExpectedFacts reads input.paths or input.edits for write_file, but write_file uses input.path, so written files are never expected facts; str_replace, apply_patch, replace_range, rewrite_symbol, edit_transaction are ignored entirely. Commands are expected as slice(0,80) while the pruner stores slice(0,77)+'...' and summarizeToolCall slices to 50, and memoryCites checks only filesInspected/editsMade (not validationResults), so long commands (typical for cargo/gradle/dotnet invocations) are always reported missing, polluting recovery guidance. JSON.stringify(postMessages).includes(fact) also misses Windows paths and commands containing quotes because they are escaped in the JSON.
- **Fix:** Derive paths via the same getEditPaths/getInspectionPaths logic the pruner uses (input.path, operation.path, edits[].path) for all EDIT_TOOLS; compare commands with a shared normalizer (same truncation as the pruner) and include validationResults in memoryCites; search a plain-text projection instead of JSON.
- **Evidence:** compaction-verification.ts:58-67 read_files/write_file branch only reads input.paths/input.edits; :70 input.command.slice(0,80); :79-81 memoryCites excludes validationResults; :95 postText = JSON.stringify(postMessages); context-pruner.ts:2770 command.slice(0,77)+'...'.

## [MEDIUM] performance — agents/context-pruner.ts:708 — [BEST] Pruner token estimate ignores tool results/tool-call inputs and uses a fixed 3 chars/token
- **Risk:** estimatedContextTokens sums getTextContent(), which returns only text parts, so tool messages (json parts) and assistant tool-call inputs count as zero; the trigger is correct only because agentState.contextTokenCount is maxed in. Per-entry budget accounting uses length/3, which undercounts CJK/non-ASCII identifiers and comments (~1 token per char) by up to 3x and overcounts dense ASCII code, so budgets for non-English repos overrun the target.
- **Fix:** Estimate from a full serialization (text + JSON tool parts + tool-call inputs) and use a script-aware estimator (e.g. count non-ASCII code points at ~1 token each), or inject the runtime tokenizer count per entry via params.
- **Evidence:** context-pruner.ts:98 CHARS_PER_TOKEN = 3; :708-715 reduce over getTextContent(message).length; getTextContent only concatenates part.type === 'text'.

## [MEDIUM] api-contract — .agents/sessions/polyglot-roadmap-v2/SPEC.md:215 — [LANG] D28 selection plan: LLMLingua-2 in a Python sidecar is not the best choice for code/log compaction
- **Risk:** LLMLingua-2 is an XLM-RoBERTa token classifier trained on MeetingBank prose; it is weak on source code, stack traces and test logs (it drops punctuation and identifiers that carry the meaning) and needs no Python at inference: it exports cleanly to ONNX. A Python sidecar adds interpreter/venv lifecycle, IPC and cold start on every user machine for a model that the planned Rust daemon (D1) could run via ort/fastembed-rs. Meanwhile P8-T9 plans the reranker in TS (transformers.js/onnxruntime-node), a third runtime for the same model class.
- **Fix:** Put selection in the Rust daemon: (1) deterministic structure-aware compression first, using the daemon's tree-sitter (keep signatures/diagnostic spans, elide bodies) and log-template mining (Drain-style) for test/build output, which is language-neutral and deterministic; (2) a multilingual code-capable cross-encoder reranker (e.g. bge-reranker-v2-m3 or jina-reranker-v2 class) via ort for query-conditioned selection; (3) LLMLingua-2 only as an optional ONNX model in the same runtime for prose. Keep the Python sidecar for research/eval of new models, not the hot path. Consolidate P8-T9 onto the same runtime.
- **Evidence:** SPEC.md:215 D28 moves LLMLingua-2/summarizers/rerankers to the D2 Python sidecar; PLAN.md:180 P8-T9 reranker lang TS (transformers.js/onnxruntime-node); PLAN.md:192 P9-T7 lang TS (ONNX); SPEC.md:167 D1 Rust daemon already carries tree-sitter and tantivy.

## [MEDIUM] api-contract — .agents/sessions/polyglot-roadmap-v2/PLAN.md:68 — [LANG] CQ-T3 'TS store first' FTS5 is reasonable as a stopgap but marked done while tokenizer design is wrong; tantivy tier needs a code tokenizer
- **Risk:** FTS5 in bun:sqlite is the right no-dependency interim store, but CQ-T3 is marked [x] with a default unicode61 tokenizer over JSON-escaped text, so the gate ('recall-over-archive integration test with seeded facts') does not exercise identifiers or multi-line output. The tantivy tier will inherit the same mistake unless the tokenizer contract is specified: tantivy's default tokenizer also does not split camelCase and has no substring matching.
- **Fix:** Reopen CQ-T3 with an explicit tokenizer contract shared by both tiers: plain-text projection, trigram (FTS5) / ngram (tantivy) field for substring parity, plus a code-identifier field splitting camelCase/snake_case/::/generics while keeping the full token; seed polyglot facts (Rust paths, Python dunders, Go test names, non-ASCII identifiers) in the gate test. Persist the index once the archive is persisted rather than rebuilding.
- **Evidence:** PLAN.md:68 CQ-T3 [x] 'TS store first (P8-T8 sqlite FTS5/vec pulled forward)'; archive-recall-index.ts:278 default tokenizer; no polyglot tokens in the recall tests (code_search found 0 matches for pytest/cargo test/go test/snake_case/camelCase/trigram).

## [MEDIUM] test-coverage — packages/agent-runtime/src/util/__tests__/archive-recall-index.test.ts — [POLY] No compaction/recall test exercises non-JS runner output or code identifiers
- **Risk:** Retention and recall evals cannot catch the escaped-newline, tokenizer, head-only-excerpt or validation-extraction regressions above because none seed pytest/cargo/go/gradle/dotnet output or snake_case/camelCase/:: identifiers.
- **Fix:** Add fixtures of real failing outputs from pytest, cargo test, go test, gradle, dotnet test, rspec and jest; assert (a) failing test names survive the pruner's knowledge_memory, (b) simplified results keep the summary tail, (c) recall_context finds line-leading and partial-identifier queries via the indexed path.
- **Evidence:** code_search over archive-recall-index.test.ts, simplify-tool-results.test.ts, compaction-verification.test.ts, evals/compaction-fidelity and evals/compaction-retention scenario tests for pytest|cargo test|go test|snake_case|camelCase|trigram returned 0 matches.

## [LOW] state-mutation — packages/agent-runtime/src/util/context-consolidation-runner.ts:123 — Fire-and-forget consolidation writes to agentState after the step may have serialized/cloned it
- **Risk:** recordConsolidation reassigns agentState.contextConsolidations asynchronously; if the state object was already persisted or replaced (the pruner rewrites state, sessions serialize), the summary is silently lost or lands on a stale object. Canary-off by default, so impact is limited.
- **Fix:** Record into a per-run side store keyed by runId and merge at the next step boundary, or persist via the same revisioned task-memory path (expectedTaskMemoryRevision) the pruner uses.
- **Evidence:** context-consolidation-runner.ts:88-139 void (async () => {...recordConsolidation(agentState, ...)})(); context-consolidation.ts:128-136 reassigns the array.

## [LOW] performance — agents/context-pruner.ts:2047 — [BEST] 3.2k-line serialized generator with duplicated regex tables and English-only heuristics
- **Risk:** handleSteps must be self-contained (serialized), so all helpers live in one closure; the operational-line regex lists are duplicated between extractActiveWorkLines and sanitizeOperationalStateText and can drift. Decision extraction keys on English markers ('Using', 'Chose'), so 'Using' captures noise and non-English sessions record no decisions. Unit testing individual helpers is impossible without executing the whole template.
- **Fix:** Move the pure helpers into a canonical module and generate the serialized body (the repo already generates the budgets region via scripts/generate-pruner-budgets.ts), share one regex table, and unit-test helpers directly; make decisions come from structured sources (task memory/tool receipts) rather than English prefixes.
- **Evidence:** context-pruner.ts:2047-2070 decision markers regex; operational-line regexes repeated in extractActiveWorkLines and sanitizeOperationalStateText; generated region pattern at the pruner-budgets-generated block near line 140.

## [LOW] correctness — common/src/util/compaction-eligibility.ts:365 — Confirmation: P6 compaction eligibility is deterministic and language-neutral
- **Risk:** None found: no clock reads, code-point ordering, closure fixpoint only shrinks, pinned/explicit/reused observations protected. Recorded as a confirmation, not a defect.
- **Fix:** No change required.
- **Evidence:** compaction-eligibility.ts:46-55 compareCodePoints; :72-118 branch precedence with used/reinforced/explicit guards; :394-405 shrinking fixpoint; no Date.now in module.

## Coverage receipt

### Subsystems
- agents
- packages
- common

### Features
- context-pruner
- consolidation
- archive-recall
- tool-result-simplification
- compaction-verification
- compaction-eligibility
- runtime-semantic-compaction

### Files
- agents/context-pruner.ts
- packages/agent-runtime/src/util/context-consolidation.ts
- packages/agent-runtime/src/util/context-consolidation-runner.ts
- packages/agent-runtime/src/util/runtime-semantic-compaction.ts
- packages/agent-runtime/src/util/compaction-verification.ts
- packages/agent-runtime/src/util/simplify-tool-results.ts
- packages/agent-runtime/src/util/tool-result-lifecycle.ts
- packages/agent-runtime/src/util/context-archive.ts
- packages/agent-runtime/src/util/archive-recall-index.ts
- packages/agent-runtime/src/tools/handlers/tool/recall-context.ts
- common/src/util/compaction-eligibility.ts
- .agents/sessions/polyglot-roadmap-v2/SPEC.md
- .agents/sessions/polyglot-roadmap-v2/PLAN.md

### Domains
- security
- correctness
- state-mutation
- error-handling
- performance
- dependency-hygiene
- test-coverage
- api-contract
