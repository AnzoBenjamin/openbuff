# Audit findings: shard-agent-runtime

- Subsystems: agent-runtime.agent-loop, agent-runtime.streaming-parse, agent-runtime.token-counting, agent-runtime.context-management, agent-runtime.edit-transaction, agent-runtime.background-jobs, agent-runtime.orchestration, agent-runtime.sandboxing
- Features: xml-tool-call-streaming-parser, bpe-token-estimation, handleSteps-generator-re-drive, quickjs-isolation-P9-T4, background-agent-jobs-supervision, orchestration-ledger, preflight-syntax-validation, edit-transaction-machinery, semantic-compaction-governor, base2-gate-workflow, agent-attempt-selection
- Files covered: 16
- Snapshot: 4fc76b0bd48a0b11d651b8f4647bb302dc95344c8b5749411ed1f5fcc3e7a0ba

## [MEDIUM] performance — packages/agent-runtime/src/util/token-counter.ts — BPE token estimation is a pure CPU-bound kernel where a Rust tiktoken binding would make counts exact and fast
- **Risk:** Counts are estimates, not real tokenization: per-family fudge factors (1.35 Anthropic / 1.1 Gemini / 1.0 OpenAI) approximate provider tokenizers and the 20k-char sample extrapolation adds ~2% error on mixed content, so compaction trigger/eviction decisions near budget boundaries can flip on estimate error alone. The pathological-input cap (MAX_BPE_ENCODE_CHARS=100k, 20k sample) exists only because gpt-tokenizer's JS BPE is pathologically slow — a 5MB body previously stalled CI >2 minutes. All of this cost and error is concentrated in a pure, side-effect-free function.
- **Fix:** Move BPE encoding into a Rust tiktoken napi/WASM kernel exposing exact per-model tokenizer counts; keep the TS LRU cache, WeakMap incremental counter, and fudge-factor fallback as the degradation path. Difficulty: low-medium (pure function, clean interface, existing measure scripts to validate parity).
- **Evidence:** token-counter.ts:27-70 (MAX_BPE_ENCODE_CHARS doc: 'a single ~5MB tool-result body measured >2 minutes per encode locally and stalled the CI agent-runtime suite'; BPE_SAMPLE_CHARS: 'stays within ~2% for mixed prose/code'); :80-103 (fudgeFactorForModel constants 1.35/1.0/1.1); :60-66 (dependency comment 'gpt-tokenizer's BPE is pathologically slow')

## [MEDIUM] security — packages/agent-runtime/src/run-programmatic-step.ts — handleSteps re-drive runs non-serializable in-process generators via new Function in the host realm; QuickJS (P9-T4) should be a persistent VM with bytecode serialization, not just an isolate
- **Risk:** String handleSteps executes in the host realm via new Function, so untrusted/compromised template code reaches host globals (ORCH-2 test documents this as current behavior; the trust allowlist only gates provenance, not capability). Generator state lives in a module-level in-memory registry: abnormal exits leak the generator, a recycled runId can resume a stale generator (the code warns on this collision), and a process restart silently discards all in-flight programmatic state. A persistent QuickJS VM per run unlocks true isolation (host globals unreachable) AND true generator serialization/replay (JS_WriteObject bytecode serialization / heap snapshots), replacing the leak- and collision-prone registry with durable, resumable state — a benefit the SPEC's isolation framing alone does not capture.
- **Fix:** Implement P9-T4 as a persistent per-run QuickJS VM (not per-step instantiation): hold the VM across STEP/STEP_ALL yields like the current registry does, keep HandleStepsYieldValueSchema as the host<->VM boundary, and use QuickJS bytecode/heap serialization to checkpoint generator state for durable resume. Difficulty: medium-high (yield marshaling, async tool-call plumbing across the boundary).
- **Evidence:** run-programmatic-step.ts:55-57 ('Generator state can't be serialized, so we store it in memory'), :61-134 (AgentRunContextRegistry incl. runIdToOwnerAgentId collision detection), :318-327 ('new Function' materialization + TRUSTED_STRING_HANDLE_STEPS_EXECUTION_SOURCES allowlist), __tests__/sandbox-generator.test.ts:154-159 (ORCH-2: 'string handleSteps generator runs in the host realm via new Function, so host globals ARE reachable... test should be INVERTED when a real QuickJS/isolate sandbox lands')

## [MEDIUM] state-mutation — packages/agent-runtime/src/util/background-agent-jobs.ts — Background-agent supervision is an in-process Map + view-owned AbortControllers; crash recovery is reconcile-and-mark-interrupted, not real supervision
- **Risk:** Cancel authority for a running background agent lives on an in-process adapter view; the sweep must special-case non-terminal views or cancellation is stranded. On process crash, every running agent is lost and recovery is reconcile-and-mark-'interrupted' — no OS-level process tree survives to be reaped, killed, or resource-capped. Caps (MAX_RUNNING_BACKGROUND_AGENT_JOBS, per-root limits, TTL sweeps) are application heuristics standing in for OS accounting. This is exactly the supervision gap the SPEC's Rust jobd assignment exists to fill, but the SPEC should state that supervision of agent runs — not just job spawning — migrates to jobd.
- **Fix:** Keep this module as a thin TS adapter, but plan migrating supervision (not just launch) to the Rust jobd: child process per long-lived agent job, PID/cgroup tracking, hard kill, crash-survivable job state. Difficulty: medium-high (in-process async-generator agents would need a process or worker boundary; chunk streaming becomes IPC).
- **Evidence:** background-agent-jobs.ts:263-267 ('the view owns this job's AbortController, so dropping the view of a job whose core state is non-terminal would leave nothing able to cancel it'), :269-304 (sweepBackgroundAgentJobs heuristic eviction), :611-622 (reconcileInterruptedBackgroundAgentIntents), orchestration-ledger.ts:100-134 (reconcileInterruptedLedgerSpawns marks spawns 'interrupted' on resume)

## [MEDIUM] correctness — packages/agent-runtime/src/util/preflight-syntax-validation.ts — Preflight syntax validation is Bun-only for JS/TS (fails open in Node) and heuristic-only for Python/Go; tree-sitter via Rust closes both gaps
- **Risk:** In Node deployments, malformed JS/TS edits pass preflight (fail-open), enabling the exact cascade of stacked broken edits the gate exists to prevent; the hand-rolled Python indent/delimiter and Go block heuristics have both false positives and false negatives versus real parsers. A Rust tree-sitter binding (already present via @codebuff/code-map for other languages) would give uniform real grammar validation across JS/TS/Python/Go and remove the Bun-only dependency.
- **Fix:** Route all languages through the tree-sitter grammars already exposed via @codebuff/code-map (detectSyntaxErrorViaTreeSitter), with a Rust napi binding for parse throughput; keep Bun.Transpiler only as an optional fast path. Difficulty: low-medium. Aligns with SPEC's Rust index/code-intel assignment.
- **Evidence:** preflight-syntax-validation.ts:11-14 ('Bun.Transpiler is only available in the Bun runtime... skips preflight in Node'), :155-160 (fail-open 'valid: true' when Bun is undefined), :173-260 (validatePythonSyntax indent heuristics), :262-300 (validateGoSyntax heuristics)

## [LOW] performance — packages/agent-runtime/src/util/stream-xml-parser.ts — TS is clearly right for the streaming XML tool-call parser: bounded, allocation-light byte scanning at network cadence
- **Risk:** None material. Per-chunk work is O(chunk size) with a bounded tag-tail rescan window; total work is linear in payload; chunks arrive at LLM network cadence, so compute is orders of magnitude below transport latency. A Rust port would add a per-chunk FFI boundary whose marshaling cost exceeds the scan itself, for zero observable latency gain.
- **Fix:** None — keep TS. Do not spend roadmap capacity here.
- **Evidence:** stream-xml-parser.ts:44-58 (MAX_TAG_TAIL_CARRYOVER 'per-chunk rescan window ... stays O(tag length), not O(payload)'), :30-36 (bounded buffer + overflow discard framing), :214-247 (single-pass tag scans, zero-copy slices); tool-stream-parser.ts:107-130 (per-chunk parseStreamChunk call, streamed-through filteredText)

## [LOW] performance — packages/agent-runtime/src/process-edit-transaction.ts — Edit-transaction diff/patch kernel is a plausible future Rust napi kernel; the transaction orchestration itself belongs in TS
- **Risk:** The diff/patch kernel is O(n·m) on large files and the closest-match levenshtein fallback is O(n·m) in time/memory on large oldStrings, but these run per edit call (not per stream chunk) and the module's complexity is dominated by correctness logic (capability-token validation, failure classification, recovery guidance) that is deeply typed and protocol-coupled — a poor rewrite target.
- **Fix:** Optional future napi kernel (Rust 'similar' for diff, SIMD levenshtein) applied only above a size threshold; keep the transaction state machine, capability validation, and failure classification in TS. Difficulty: medium. Partially supports SPEC's Rust-kernel direction; no urgency.
- **Evidence:** process-edit-transaction.ts:1 ('import { applyPatch, createPatch, diffChars } from diff'), :374-379 (createPatch per changed file); process-str-replace.ts (levenshteinDistance/findClosestMatches fallback matching); structural-read.ts (stripStringsAndComments char scans)

## [LOW] api-contract — packages/agent-runtime/src/util/context-pruning.ts — Context-budget arithmetic must stay TS and should be codegen-shared, not language-ported (duplicated inline constants in the serialized pruner agent)
- **Risk:** Not a language-choice issue, but the protocol-first TS core carries a literal-duplication tax: context-pruning.ts explicitly maintains a hand-copied constant block inside the serialized context-pruner handleSteps, kept in sync only by an RF-3 test. Any language migration of budget arithmetic would multiply this sync burden.
- **Fix:** Codegen: emit the shared constant block from context-pruning.ts into the serialized agent source at build time, retiring the RF-3 sync test. No language change. Difficulty: low.
- **Evidence:** run-programmatic-step.ts:253-327 (orchestrationControlPlane injection 'because handleSteps is serialized and cannot import it'), context-pruning.ts:50-58 ('SINGLE SOURCE OF TRUTH ... re-copy to the pruner. Sync is guarded by RF-3 test ... until codegen/shared literal source is implemented')

## [LOW] error-handling — packages/agent-runtime/src/util/orchestration-ledger.ts — TS is clearly right for the orchestration ledger: tiny event-sourcing append with sha256 checksum; durability is bounded by AgentState, not language
- **Risk:** None justifying migration. The append/compaction/revision-conflict logic is small, zod-validated, and pure TS; checksum cost is trivial. Its durability is inherited from AgentState persistence, which is the actual weak point (see background-jobs finding), not the ledger code itself.
- **Fix:** Keep TS. If/when background-agent supervision moves to Rust jobd, ride the ledger's durability on the same durable store jobd owns rather than inventing a second one. Difficulty: n/a now.
- **Evidence:** orchestration-ledger.ts:17-21 (createHash('sha256').update(JSON.stringify(...))), :46-59 (zod-validated append, revision conflict throw), :28-44 (compactEvents bounded retention)

## [LOW] test-coverage — packages/agent-runtime/src/orchestration/workflow-engine.ts — TS is clearly right for the advisory workflow engine and agent-attempt selection; no language opportunity
- **Risk:** None. Both are small, pure, synchronous TS modules; the workflow engine is deliberately non-authoritative telemetry, and attempt selection is a plain filter/sort. Any rewrite (Rust/Go) would add a boundary across a Zod-validated protocol for no gain.
- **Fix:** None — keep TS in both.
- **Evidence:** workflow-engine.ts:1-10 ('ADVISORY / TELEMETRY-ONLY ... The controlling turn lifecycle ... lives in createBase2's serialized handleSteps generator'); select-agent-attempt.ts:66-115 (pure scoring sort)

## [LOW] performance — packages/agent-runtime/src/run-agent-step.ts — TS is clearly right for the agent loop drivers (loopAgentSteps / mainPrompt): I/O-bound orchestration dominated by LLM latency
- **Risk:** None from a language perspective: the loop is I/O-bound on LLM calls with per-iteration O(messages) accounting already mitigated by IncrementalTokenCounter (per-message WeakMap memoization) and the governor. The genuine risk here is complexity (a ~1800-line generator loop), which a language change would worsen, not fix.
- **Fix:** None on language. Treat any extraction of loop concerns as a TS refactor, not a polyglot migration.
- **Evidence:** run-agent-step.ts:1254-3044 (loopAgentSteps span), :1926-1947 region (IncrementalTokenCounter wiring replacing whole-history recounts); main-prompt.ts:27-167 (mainPrompt orchestration)

## [LOW] dependency-hygiene — packages/agent-runtime/src/util/token-counter.ts — gpt-tokenizer single-encoder dependency drives the whole fudge-factor and cap apparatus in token counting
- **Risk:** The module's design is shaped around one dependency limitation: a single gpt-4o BPE tokenizer plus three hand-tuned fudge factors to approximate other providers, a special-token escape hack (BPE_SPECIAL_TOKEN_ESCAPE), a cache band chosen to avoid the dependency's memory behavior, and a CI-stalling pathological input. This is dependency-driven complexity a real per-model tokenizer would eliminate.
- **Fix:** A Rust tiktoken napi kernel replaces this dependency outright and removes the fudge-factor approximation layer; alternatively add tiktoken-js only if a TS-only path is preferred. Difficulty: low-medium either way.
- **Evidence:** token-counter.ts:1 ('import { encode } from gpt-tokenizer/esm/model/gpt-4o'), :60-66 (dependency performance note), :80-103 (fudge factors compensating for the single-tokenizer approximation)

## Coverage receipt

### Subsystems
- agent-runtime.agent-loop
- agent-runtime.streaming-parse
- agent-runtime.token-counting
- agent-runtime.context-management
- agent-runtime.edit-transaction
- agent-runtime.background-jobs
- agent-runtime.orchestration
- agent-runtime.sandboxing

### Features
- xml-tool-call-streaming-parser
- bpe-token-estimation
- handleSteps-generator-re-drive
- quickjs-isolation-P9-T4
- background-agent-jobs-supervision
- orchestration-ledger
- preflight-syntax-validation
- edit-transaction-machinery
- semantic-compaction-governor
- base2-gate-workflow
- agent-attempt-selection

### Files
- packages/agent-runtime/src/run-agent-step.ts
- packages/agent-runtime/src/main-prompt.ts
- packages/agent-runtime/src/run-programmatic-step.ts
- packages/agent-runtime/src/tool-stream-parser.ts
- packages/agent-runtime/src/util/stream-xml-parser.ts
- packages/agent-runtime/src/util/token-counter.ts
- packages/agent-runtime/src/util/context-pruning.ts
- packages/agent-runtime/src/util/context-budget.ts
- packages/agent-runtime/src/process-edit-transaction.ts
- packages/agent-runtime/src/process-structured-edit.ts
- packages/agent-runtime/src/orchestration/workflow-engine.ts
- packages/agent-runtime/src/orchestration/select-agent-attempt.ts
- packages/agent-runtime/src/util/background-agent-jobs.ts
- packages/agent-runtime/src/util/orchestration-ledger.ts
- packages/agent-runtime/src/util/preflight-syntax-validation.ts
- packages/agent-runtime/src/__tests__/sandbox-generator.test.ts

### Domains
- security
- correctness
- state-mutation
- performance
- api-contract
- error-handling
- test-coverage
- dependency-hygiene
