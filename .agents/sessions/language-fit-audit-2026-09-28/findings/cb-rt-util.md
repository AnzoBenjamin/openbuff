# Audit findings: cb-rt-util

- Subsystems: packages, agents
- Features: tokenization, incremental-token-counter, tool-result-eviction, context-pruning-budgets-mechanical-trim, semantic-compaction-selection, compaction-verification, context-archive, archive-recall-index, context-consolidation, run-journal, workspace-path-leases, background-agent-jobs, stream-xml-parser, parse-tool-calls-from-text, simplify-tool-results, task-memory, memory-v2-context, budget-enforcement, plan-execution-state, filesystem-scope, project-path-policy, tool-result-lifecycle, agent-runtime-deps, context-pruner-handlesteps
- Files covered: 25
- Snapshot: 49801b44e84d3d8fa583c3ebd9b2855228bf122572b7cdf5f78c77b3389d824d

## [MEDIUM] performance — packages/agent-runtime/src/util/token-counter.ts:2 — Tokenization: HYBRID (MOVE->Rust tiktoken-rs/HF tokenizers in daemon + provider count_tokens calibration)
- **Risk:** Current: gpt-tokenizer o200k (gpt-4o) BPE in JS for every model, corrected by hard-coded fudge factors (Anthropic 1.35, Gemini 1.1, OpenAI 1.0; no-model default = 1.35). Needs: accurate per-provider counts to drive compaction triggers, bounded worst-case latency. The file documents pure-JS BPE taking >2 minutes on a ~5MB separator-free body (stalled CI), which forced prefix sampling (20k chars) plus length-ratio extrapolation, and an 8KB LRU cap. Result: counts are estimate-of-an-estimate (sampling error x fudge error), so trigger decisions near boundaries flip. Best-in-class: Rust tiktoken-rs (OpenAI o200k/cl100k), HF `tokenizers` (Rust core; loads Llama/Qwen/Gemma/DeepSeek tokenizer.json for open models); Python tiktoken is also Rust underneath (no benefit over direct Rust); Claude/Gemini tokenizers are not published for local use, so exact counts there come only from provider count_tokens APIs.
- **Fix:** NOW: keep the TS API surface (countTokens/countTokensJson/IncrementalTokenCounter) but back it with a native Rust counter (tiktoken-rs + tokenizers) behind the daemon or a bun:ffi/N-API addon; drop prefix sampling for OpenAI/open-weight models (exact, linear-time). Replace static fudge factors with per-model ratios calibrated from provider-reported usage.input_tokens (already returned per step) stored as a rolling EWMA. NEXT: exact per-open-model counts for local/OpenRouter models via tokenizer.json registry; batched counting of whole histories off the JS thread.
- **Evidence:** token-counter.ts:2 (import encode from gpt-tokenizer/esm/model/gpt-4o), :29-57 (MAX_CACHEABLE_INPUT_CHARS 8KB, MAX_BPE_ENCODE_CHARS 100k, BPE_SAMPLE_CHARS 20k; comment cites >2min encode of 5MB), :95-115 fudgeFactorForModel, :150-172 sampled extrapolation, :236-248 legacy default 'anthropic/claude' sentinel. Cost: M (1-2 wk): Rust crate + FFI/daemon RPC + calibration store; tests must switch from exact-number pins to tolerance. Confidence: high on current mechanism; medium on gains. Verify on web: tiktoken-rs linear-time behavior on pathological separator-free inputs; whether Anthropic still offers only the count_tokens API (no local tokenizer); gpt-tokenizer 2.9 perf characteristics.

## [LOW] performance — packages/agent-runtime/src/util/token-counter.ts:330 — Incremental token counter (per-message memo): KEEP
- **Risk:** WeakMap keyed by live message object identity; this is intrinsically a JS-heap concept and cannot cross an FFI/RPC boundary without losing identity (would need content hashing instead).
- **Fix:** Keep in TS as the caching layer in front of whatever native counter backs countTokensJson. If the counter moves to a daemon, batch unseen messages into one RPC per step.
- **Evidence:** token-counter.ts:~330-381 IncrementalTokenCounter (WeakMap<object, number>). Cost: none. Confidence: high.

## [LOW] performance — packages/agent-runtime/src/util/tool-result-eviction.ts:335 — Tool-result eviction: KEEP (TS), use incremental counting
- **Risk:** Pure message-array rewrite policy tightly bound to Message types; no language gain. Only hotspot: tokensSaved = countTokensJson(messages) - countTokensJson(nextMessages) re-serializes and re-encodes the entire transcript twice per eviction attempt, and the protection scan JSON.stringifies each candidate. A native tokenizer would make this cheap, but the right fix is algorithmic.
- **Fix:** Compute savings as sum over replaced messages of (old count - tombstone count) via IncrementalTokenCounter rather than two whole-array encodes. Keep policy in TS.
- **Evidence:** tool-result-eviction.ts:201-217 (contentReferencesProtectedPath stringify + substring scan, 5M cap), :260-261 approximateTokens, :335-336 whole-array double count. Cost: S. Confidence: high.

## [LOW] correctness — packages/agent-runtime/src/util/context-pruning.ts:164 — Context pruning budgets + mechanical trim: KEEP
- **Risk:** Arithmetic budget derivation (getSemanticCompactionBudget, reserved tokens, governor) and trimMessagesToFitTokenLimitWithReport are policy over JS message objects; cost is dominated by token counting, not the policy code.
- **Fix:** Keep. Benefits automatically from a native counter. Constants already single-sourced into context-pruner.ts via generator.
- **Evidence:** context-pruning.ts:132-302 budget fns, :320-347 maybePruneContext; messages.ts:535-856 trimMessagesToFitTokenLimitWithReport (outline only). Cost: none. Confidence: high (messages.ts body not read in full).

## [MEDIUM] correctness — agents/context-pruner.ts:1 — Semantic compaction selection: HYBRID (keep TS extractive policy; optional LLMLingua-2 via ONNX in Rust daemon, not Python)
- **Risk:** Current: context-pruner handleSteps is a heuristic extractive summarizer (regex fact extraction, role budgets 0.4/0.3/0.3, knowledge_memory pinned block) that estimates tokens with CHARS_PER_TOKEN=3 while the runtime trigger uses BPE*fudge, so pruner-internal budgets and runtime triggers use different estimators. runtime-semantic-compaction.ts spawns this as an LLM child. handleSteps is serialized via new Function, so it CANNOT import native code — any learned compressor must run runtime-side. Needs: better token-level selection of verbose tool output (logs, search hits) than head/tail truncation. Best-in-class: LLMLingua-2 (Python/PyTorch reference; XLM-R/BERT token classifier exportable to ONNX); Rust `ort` (ONNX Runtime bindings) + HF tokenizers can run it in-daemon; onnxruntime-node also possible in TS. Python sidecar adds a heavy runtime (torch) to a CLI for marginal gain.
- **Fix:** NOW: keep TS policy; replace CHARS_PER_TOKEN=3 estimates with a runtime-injected count (params already carry semantic budget) so both sides agree. NEXT: add an optional runtime-side pre-pass that compresses stale verbose tool results with LLMLingua-2 exported to ONNX, executed via `ort` in the Rust daemon (shared with tokenizers), gated by an eval (evals/compaction-fidelity). Do not introduce a Python process.
- **Evidence:** agents/context-pruner.ts: CHARS_PER_TOKEN = 3 and budget fractions in handleSteps constants block; generated-budgets region comment says handleSteps is serialized (new Function) and cannot import modules; estimatedContextTokens = chars/3. runtime-semantic-compaction.ts:34-217 LLM child spawn. Cost: estimator alignment S; LLMLingua-2 ONNX path L (model export, ~500MB model distribution question, eval gating). Confidence: medium. Verify on web: LLMLingua-2 ONNX export availability/licensing, model size, ort CPU latency per 10k tokens.

## [LOW] correctness — packages/agent-runtime/src/util/compaction-verification.ts:88 — Compaction verification: KEEP
- **Risk:** Pure fact-derivation + substring check bounded to 200 facts; one JSON.stringify of post-history. No language benefit.
- **Fix:** Keep.
- **Evidence:** compaction-verification.ts:49-77 deriveExpectedFacts, :88-103 verifyExtractionCoverage. Cost: none. Confidence: high.

## [LOW] state-mutation — packages/agent-runtime/src/util/context-archive.ts:94 — Context archive: KEEP
- **Risk:** In-memory capped snapshots (8x200x4k) persisted on AgentState, identity dedupe via WeakSet, monotonic archivedAt mint. JS-object-identity-bound; bounded size.
- **Fix:** Keep. LATER, if archive becomes cross-session in a daemon, it should move with the recall store (see archive recall finding).
- **Evidence:** context-archive.ts:23-27 caps, :62 WeakSet, :85-91 mintArchivedAt, :94-194 archive fns, :243-298 substring scanner. Cost: none. Confidence: high.

## [LOW] performance — packages/agent-runtime/src/util/archive-recall-index.ts:226 — Archive recall (bun:sqlite FTS5 per-call :memory:): KEEP; tantivy only if archive becomes persistent/cross-session
- **Risk:** Current: builds a fresh :memory: FTS5 table per recall over <=~1600 rows / ~6.4MB, ordered newest-first (bm25 unused), fails open to substring scan. Needs: small-corpus AND search. tantivy (Rust) brings segment management, analyzers, BM25 but is overkill for a per-call, ephemeral, 6MB corpus; the per-call rebuild is the only cost and is bounded. Rust rusqlite FTS5 is equivalent functionality to bun:sqlite.
- **Fix:** Keep. Minor: cache the built index keyed by archive array identity/length to avoid rebuild per query. LATER (daemon, cross-session recall over many runs): CONSUME tantivy in the daemon or reuse the daemon's rusqlite with FTS5 + bm25 ordering; choose tantivy only if needing fuzzy/phrase-with-positions at >100MB scale.
- **Evidence:** archive-recall-index.ts:67 MAX_INDEX_TEXT_CHARS 16M, :182-197 dynamic import bun:sqlite, :226-325 per-call CREATE VIRTUAL TABLE fts5 + ORDER BY row_index DESC. Cost: none now; M later. Confidence: high. Verify on web: FTS5 compiled into bun:sqlite on all Bun release platforms (Windows/musl).

## [LOW] performance — packages/agent-runtime/src/util/context-consolidation.ts:150 — Context consolidation (background LLM summary + keyword search): KEEP
- **Risk:** LLM-bound fire-and-forget child; search is OR-substring over <=8 summaries. No language benefit.
- **Fix:** Keep. Optionally route searchConsolidations through the same FTS5 index for bm25 ranking.
- **Evidence:** context-consolidation.ts:35-65 selection, :94-106 prompt build, :150-188 searchConsolidations; context-consolidation-runner.ts:68-146 fire-and-forget spawn. Cost: none. Confidence: high.

## [MEDIUM] state-mutation — packages/agent-runtime/src/util/run-journal.ts:105 — Run journal durability: MOVE->Rust (rusqlite in daemon) when the daemon exists; KEEP bun:sqlite until then
- **Risk:** Current: bun:sqlite, WAL + synchronous=NORMAL, synchronous append on the hot path, SELECT MAX(seq) per append (read-then-write, safe only with a single writer), JSON payload TEXT, classifyRunResume/planChildResume load the entire run's events. Journal lifetime equals the CLI process owning the handle; parent and child journals, background intents and leases are reconciled from the same process. Needs: crash-safe append, single-writer seq allocation across multiple clients, resume after CLI death. WAL+NORMAL survives process kill-9 but can lose the last commits on OS crash/power loss. Best-in-class: rusqlite (same SQL/schema, bundled SQLite, can set synchronous=FULL for tool_call boundaries), redb (pure-Rust ACID KV; would lose SQL queries used here), Python sqlite3 no advantage.
- **Fix:** NOW: keep bun:sqlite; use synchronous=FULL (or per-boundary FULL) for tool_call markers that gate side effects, and allocate seq in-process or via INSERT ... SELECT COALESCE(MAX(seq),-1)+1 in one statement inside BEGIN IMMEDIATE. NEXT: host the journal in the Rust daemon with rusqlite keeping this exact schema, exposing append/events/toolResultFor over RPC, so multiple CLI/IDE clients share one writer and resume survives client death; keep the pure classifiers (classifyRunResume etc.) in TS or port as pure functions.
- **Evidence:** run-journal.ts:70-83 SCHEMA_SQL STRICT, :92-97 require('bun:sqlite'), :115-118 WAL + synchronous=NORMAL, :131-147 append MAX(seq)+1 then INSERT (two statements, no txn), :193-229 classifyRunResume reads events(runId) fully. Cost: NOW S; daemon port M (schema reuse makes it mostly plumbing). Confidence: high on mechanism. Verify on web: SQLite WAL synchronous=NORMAL durability (process-crash safe, may roll back last txns on power loss).

## [MEDIUM] correctness — packages/agent-runtime/src/util/workspace-path-leases.ts:14 — Workspace path leases/locks: MOVE->Rust daemon (single lease authority); KEEP overlap logic semantics
- **Risk:** Current: module-level Map in one JS process; overlap via stable glob prefix; 30-min TTL; durable mirror on AgentState only marked 'interrupted' after restart. Two CLI processes (or IDE + CLI) on the same repo get zero conflict detection, so concurrent agents can edit overlapping paths. OS advisory locks (fs2/fd-lock/flock) lock files, not glob patterns, so they are not a substitute alone. Needs: cross-process, cross-client mutual exclusion over path patterns with TTL/heartbeat and crash recovery.
- **Fix:** NOW: optionally persist leases in the project-scoped SQLite (same db as journal) with BEGIN IMMEDIATE acquisition so multiple processes see each other; expire by TTL. NEXT: move lease authority into the Rust daemon (in-memory table + rusqlite persistence, globset for overlap), with heartbeat from clients; TS keeps a thin client.
- **Evidence:** workspace-path-leases.ts:14 const activeLeases = new Map, :15 DEFAULT_LEASE_MS 30min, :21-39 stablePrefix/overlaps, :47-95 acquire (process-local check), :159-167 reconcileInterruptedPathLeases. Cost: SQLite interim S-M; daemon M. Confidence: high that leases are process-local; unverified whether the product runs multiple processes per repo today.

## [LOW] state-mutation — packages/agent-runtime/src/util/background-agent-jobs.ts:104 — Background agent jobs registry: KEEP (LATER daemon-owned)
- **Risk:** Registry holds JS promises/coroutines and chunk buffers; inherently tied to the JS runtime executing agents. Process-scoped by design (kill-9 destroys jobs; resume via intents in run-journal).
- **Fix:** Keep in TS. When agent execution moves under a daemon, the job registry moves with the executor, not independently.
- **Evidence:** background-agent-jobs.ts:59-71 caps, :104 registry, :456-526 promise attach/completion handlers (outline only; bodies not read). Cost: none. Confidence: medium (outline-level read).

## [LOW] performance — packages/agent-runtime/src/util/stream-xml-parser.ts:105 — Streaming tool-call XML parser: KEEP
- **Risk:** Incremental indexOf with bounded tag-tail carry, already linear; per-chunk work is tiny and FFI/RPC per stream chunk would cost more than it saves.
- **Fix:** Keep.
- **Evidence:** stream-xml-parser.ts:105-242 parseStreamChunk tail-window scan, overflow discard mode. Cost: none. Confidence: high.

## [LOW] correctness — packages/agent-runtime/src/util/parse-tool-calls-from-text.ts:63 — Parse tool calls from text: KEEP
- **Risk:** Regex extraction + JSON repair over model text; small inputs, shares parseJsonStringWithRepair with the stream parser.
- **Fix:** Keep.
- **Evidence:** parse-tool-calls-from-text.ts:18-21 pattern, :63-161 (outline only). Cost: none. Confidence: medium.

## [LOW] correctness — packages/agent-runtime/src/util/simplify-tool-results.ts:272 — Simplify tool results: KEEP
- **Risk:** Per-tool shape rewriting of typed CodebuffToolOutput; type-coupled to TS tool schemas.
- **Fix:** Keep.
- **Evidence:** simplify-tool-results.ts:24-315 (outline only). Cost: none. Confidence: medium.

## [LOW] state-mutation — packages/agent-runtime/src/util/task-memory.ts:342 — Task memory: KEEP
- **Risk:** Schema-bound merge/commit/rank of TaskMemoryV1 with revision guards; logic heavy, data small.
- **Fix:** Keep. If memory becomes daemon-persisted, persist the serialized TaskMemoryV1 there but keep the merge logic in TS (or share via JSON schema).
- **Evidence:** task-memory.ts:342-372 commitTaskMemory, :625-796 tool evidence, :1136-1255 compile (outline only). Cost: none. Confidence: medium.

## [LOW] performance — packages/agent-runtime/src/util/memory-v2-context.ts:27 — Memory V2 context compiler: KEEP
- **Risk:** Deterministic bounded prompt rendering with zod parse. Minor perf nit: comparator re-stringifies and Array.from-splits both items per comparison (O(n log n) stringify); negligible at current sizes.
- **Fix:** Keep. Optionally precompute canonical keys once before sort.
- **Evidence:** memory-v2-context.ts:27-44 compareCodePoints/sortedByCanonicalJson, :95-374 compileMemoryV2Context. Cost: none. Confidence: high.

## [LOW] correctness — packages/agent-runtime/src/util/budget-enforcement.ts:55 — Budget enforcement + plan execution state validation: KEEP
- **Risk:** Pure small state-machine checks on AgentState/plan text.
- **Fix:** Keep.
- **Evidence:** budget-enforcement.ts:55-127; plan-execution-state.ts:32-182 validatePlanTransition. Cost: none. Confidence: high.

## [LOW] correctness — packages/agent-runtime/src/util/filesystem-scope.ts:3 — Filesystem scope glob matching: KEEP TS but CONSUME a real glob lib (Bun.Glob/picomatch); Rust globset if authority moves to daemon
- **Risk:** Hand-rolled glob->RegExp compiled on every call; supports *, **, ? only — brace {a,b} and [classes] are escaped as literals, so scope patterns using them silently fail to match (fail-closed for authority, but surprising). Security-relevant authority check with bespoke semantics.
- **Fix:** Use Bun.Glob.match or picomatch (pinned) with a cached compiled matcher; if lease/authority enforcement moves to the Rust daemon, use globset there and keep identical semantics tested via shared fixtures.
- **Evidence:** filesystem-scope.ts:3-42 scopePatternMatches (new RegExp per call; char-by-char translation), :55-81 narrowFilesystemPatterns. Cost: S. Confidence: high. Verify: Bun.Glob semantics for ** zero-dir matching match current tests.

## [LOW] correctness — packages/agent-runtime/src/util/project-path-policy.ts:11 — Project path policy + tool-result lifecycle tags: KEEP
- **Risk:** Tiny pure predicates/sets.
- **Fix:** Keep.
- **Evidence:** project-path-policy.ts:11-19; tool-result-lifecycle.ts:12-92. Cost: none. Confidence: high.

## [LOW] dependency-hygiene — packages/agent-runtime/package.json:30 — agent-runtime dependencies: KEEP, pin ranges
- **Risk:** gpt-tokenizer ^2.8.1 and ai ^5.0.52 are caret ranges while other deps are exact; token-counter comments depend on gpt-tokenizer 2.9.0 behavior (allowedSpecial 'none' throws), so a minor bump can change counts/behavior that tests pin. Tokenizer dep becomes removable if a native counter lands.
- **Fix:** Pin gpt-tokenizer and ai to exact versions; plan removal of gpt-tokenizer after Rust counter migration (keep as fallback only).
- **Evidence:** package.json:28-36 dependencies; token-counter.ts:62-66 comment referencing gpt-tokenizer 2.9.0. Cost: XS. Confidence: high.

## [LOW] correctness — agents/context-pruner.ts:1 — Context-pruner handleSteps runtime: KEEP TS (sandbox-serialized JS is a hard constraint)
- **Risk:** handleSteps is serialized to a string and executed via new Function, so it must remain self-contained JS; constants are generated from context-pruning.ts with a freshness test. Any language move here is impossible without changing the agent-definition execution model.
- **Fix:** Keep. Push heavy work (exact token counts, learned compression) runtime-side and inject results via params (pattern already used for semanticBudget/taskMemory).
- **Evidence:** agents/context-pruner.ts: '<pruner-budgets-generated>' region comment (handleSteps serialized, cannot import), params.semanticBudget / params.taskMemory injection. Cost: none. Confidence: high.

## Coverage receipt

### Subsystems
- packages
- agents

### Features
- tokenization
- incremental-token-counter
- tool-result-eviction
- context-pruning-budgets-mechanical-trim
- semantic-compaction-selection
- compaction-verification
- context-archive
- archive-recall-index
- context-consolidation
- run-journal
- workspace-path-leases
- background-agent-jobs
- stream-xml-parser
- parse-tool-calls-from-text
- simplify-tool-results
- task-memory
- memory-v2-context
- budget-enforcement
- plan-execution-state
- filesystem-scope
- project-path-policy
- tool-result-lifecycle
- agent-runtime-deps
- context-pruner-handlesteps

### Files
- agents/context-pruner.ts
- packages/agent-runtime/package.json
- packages/agent-runtime/src/util/token-counter.ts
- packages/agent-runtime/src/util/archive-recall-index.ts
- packages/agent-runtime/src/util/run-journal.ts
- packages/agent-runtime/src/util/workspace-path-leases.ts
- packages/agent-runtime/src/util/runtime-semantic-compaction.ts
- packages/agent-runtime/src/util/compaction-verification.ts
- packages/agent-runtime/src/util/context-consolidation.ts
- packages/agent-runtime/src/util/context-consolidation-runner.ts
- packages/agent-runtime/src/util/context-archive.ts
- packages/agent-runtime/src/util/tool-result-eviction.ts
- packages/agent-runtime/src/util/context-pruning.ts
- packages/agent-runtime/src/util/stream-xml-parser.ts
- packages/agent-runtime/src/util/filesystem-scope.ts
- packages/agent-runtime/src/util/project-path-policy.ts
- packages/agent-runtime/src/util/budget-enforcement.ts
- packages/agent-runtime/src/util/plan-execution-state.ts
- packages/agent-runtime/src/util/tool-result-lifecycle.ts
- packages/agent-runtime/src/util/memory-v2-context.ts
- packages/agent-runtime/src/util/messages.ts
- packages/agent-runtime/src/util/simplify-tool-results.ts
- packages/agent-runtime/src/util/parse-tool-calls-from-text.ts
- packages/agent-runtime/src/util/task-memory.ts
- packages/agent-runtime/src/util/background-agent-jobs.ts

### Domains
- performance
- correctness
- state-mutation
- dependency-hygiene
