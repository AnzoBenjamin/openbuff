# Audit findings: w2-runtime-core

- Subsystems: packages
- Features: agent-loop, tool-executor, stream-parsing, context-pruning, spawn-agents, token-counting, background-jobs, task-memory, budget-enforcement
- Files covered: 13
- Snapshot: 49801b44e84d3d8fa583c3ebd9b2855228bf122572b7cdf5f78c77b3389d824d

## [HIGH] performance — packages/agent-runtime/src/util/tool-result-eviction.ts:336 — [BEST] Eviction re-serializes and re-tokenizes the entire transcript twice per call, bypassing the M3-T2 incremental counter
- **Risk:** evictStaleToolResults runs on every loop iteration above the eviction floor (55% of window). Each call does countTokensJson(messages) - countTokensJson(nextMessages): two full JSON.stringify passes over a transcript that can be MBs at 500k-1M windows, plus BPE (or the 20k-sample extrapolation). Per candidate it also stringifies the whole message (approximateTokens, :261) and its content again (contentReferencesProtectedPath, :205), and runs fileMutationResultV1Schema.safeParse on every old tool message (isSlimmedMutationResult, :130) even when nothing changes. On long turns this is O(transcript) work per iteration, so O(n^2) over the turn, exactly what IncrementalTokenCounter was introduced to remove in run-agent-step.
- **Fix:** Compute tokensSaved as the sum of per-candidate deltas: memoized messageTokens(original) minus countTokensJson(replacement), sharing the loop's IncrementalTokenCounter or a WeakMap. Serialize each candidate once and reuse that string for the approximate label and the protected-path scan. Memoize the 'already slimmed/evicted' verdict per message reference in a WeakSet so stable tail messages are not re-parsed each iteration.
- **Evidence:** tool-result-eviction.ts:336 `countTokensJson(messages) - countTokensJson(nextMessages)`; :261 `JSON.stringify(message).length * 0.25`; :205 `JSON.stringify(message.content)`; :130 isSlimmedMutationResult safeParse per tool message. The caller in run-agent-step.ts gates on `contextTokensBeforeProgrammatic > evictionFloorTokens` every iteration, and evaluates eviction before the savings floor can short-circuit.

## [HIGH] performance — packages/agent-runtime/src/run-agent-step.ts — [BEST] Journal llm_request stores the full messageHistory every step, so journal size grows O(n^2) over a turn
- **Risk:** P2-T2 appends `payload: { model, system, n, messages: agentState.messageHistory }` before every LLM stream. That is the whole transcript plus the system prompt on every step. A 100-step turn with a 400k-token history writes roughly 100 copies of it. The result is disk/IO amplification and serialization cost on the hot path (journalWriter.append presumably JSON-serializes synchronously), and retention-based bounding cannot help within one run.
- **Fix:** Journal deltas instead. Record the system prompt once, keyed by a content hash, and log only the messages appended since the previous llm_request (or a stable message-id list plus new bodies). Replay then reconstructs the request from the prior checkpoint plus the delta. If full payloads must stay, write them asynchronously off the step path.
- **Evidence:** run-agent-step.ts runAgentStep: `params.journalWriter.append(agentState.runId, { eventType: 'llm_request', ..., payload: { model: agentTemplate?.model, system, n: params.n ?? null, messages: agentState.messageHistory } })`. The comment says 'the journal now stores the FULL request payload per §8'.

## [MEDIUM] correctness — packages/agent-runtime/src/run-programmatic-step.ts — [BEST] Replay idempotency short-circuit is keyed on a freshly generated toolCallId, so it never matches unless idGen is fully deterministic and call-order-identical
- **Risk:** executeSingleToolCall does `toolCallId = idGen.uuid()` and then checks `journalReader.toolResultFor(runId, toolCallId)`. With realIdGen the id is random on every run, so a journaled result is never found and side-effecting tools re-execute on resume, defeating P2-T2 §4c. With a seeded idGen, correctness depends on every earlier uuid() call (agentStepId, ids generated elsewhere) happening in the same order, which is brittle.
- **Fix:** Key replay on a stable identity: (runId, stepNumber, per-step programmatic call index), or a hash of (toolName, canonical input, sequence). Journal that key in the tool_call event and look it up before minting the id. Add a test that resumes with realIdGen and asserts no re-execution.
- **Evidence:** run-programmatic-step.ts executeSingleToolCall: `const idGen = params.idGen ?? realIdGen; const toolCallId = idGen.uuid()` followed immediately by `params.journalReader.toolResultFor(agentState.runId, toolCallId)`.

## [MEDIUM] state-mutation — packages/agent-runtime/src/tool-stream-parser.ts:217 — [BEST] Remaining nondeterminism sources in the core bypass the injected idGen/clock (P2-T1 incomplete)
- **Risk:** Replay/determinism (P2-T1/P2-T2) cannot reproduce identity ids or timestamps while these bypass the deps: crypto.randomUUID for XML tool-call ids (tool-stream-parser.ts:217, marked TODO); Math.random in background job ids (background-agent-jobs.ts:92); Date.now for message sentAt (run-agent-step.ts:1802, tool-executor.ts:3280, :3667), the checkpoint throttle (run-agent-step.ts:1898), and the commitTaskMemory default (task-memory.ts:362, which also feeds the checksum); generateCompactId for fallback toolCallIds (tool-executor.ts:2257, stream-parser.ts:319), subagent agentId (spawn-agent-utils.ts:2327), and receiptId/evidence ids (spawn-agent-utils.ts:1500, :1931, :2009). The loop resolves `clock` but still stamps the USER_PROMPT sentAt with Date.now().
- **Fix:** Thread idGen/clock through processStreamWithTools, executeToolCall (already carries params.clock), createAgentState, buildRuntimeAgentReceipt and the background-job allocator. Replace every direct call with the injected deps. Add a lint rule (no-restricted-globals / no-restricted-syntax) for Date.now/Math.random/crypto.randomUUID inside packages/agent-runtime/src, with an allowlist for real-runtime-deps.
- **Evidence:** code_search output: tool-stream-parser.ts:217 `xml-${crypto.randomUUID()}`; background-agent-jobs.ts:92 `Math.random().toString(16)`; run-agent-step.ts:544/815/1269/1802/1898 Date.now; tool-executor.ts:2257/3280/3495/3667; task-memory.ts:362 `params.now ?? Date.now()`; spawn-agent-utils.ts:1500/1931/2009/2327 generateCompactId.

## [MEDIUM] api-contract — packages/agent-runtime/src/run-agent-step.ts — [BEST] Core modules far exceed the 3k-line cohesion bound; loopAgentSteps is a ~1,500-line function with many loop-local closures
- **Risk:** run-agent-step.ts is 3,186 lines and tool-executor.ts is 3,753 (spawn-agent-utils.ts is 2,697 and self-documents three extraction candidates). loopAgentSteps inlines the compaction governor wiring, eviction, semantic/mechanical compaction telemetry, tier-driven tool rebuilds, checkpointing and output-schema retries in one while-loop full of shared `let` state. That makes the invariants (the announce/settle pairing, the incremental-counter reset points) hard to test in isolation and invites regressions such as the TDZ issue the comments mention. executeToolCall mixes containment, the followups gate, the git-committer dirty-file gate (including an inline normalizeCoveragePath) and spawn pre-validation.
- **Fix:** Extract loopAgentSteps phases into pure step functions: a compaction pipeline (eviction -> governor -> semantic -> mechanical) returning a typed ContextPressureResult; a tool-surface manager (tier rebuild plus toolsForTokenCount); and a checkpoint policy. Split tool-executor into input-repair (parseRawToolCall and the coercers), the containment backstop, the gate policies (followups, committer coverage), and dispatch. Perform the spawn-agent-utils split it already documents (receipt / librarian cleanup / output compaction).
- **Evidence:** editAnchor endLine: run-agent-step.ts 3186, tool-executor.ts 3753, spawn-agent-utils.ts 2697. The spawn-agent-utils header says: 'This file currently aggregates three independent concerns that are candidates for future extraction'.

## [MEDIUM] performance — packages/agent-runtime/src/tools/stream-parser.ts:668 — [BEST] fullResponseChunks.join('') runs on every dispatched tool call, which is quadratic in response length
- **Risk:** Each native or custom tool dispatch passes `fullResponse: fullResponseChunks.join('')`, which rebuilds the entire accumulated response string. A long response with many tool calls (parallel reads, spawn batches) pays O(response_len x tool_calls). fullResponseChunks also keeps every per-token chunk alive for the step and is later logged in full.
- **Fix:** Keep a running `fullResponse` string (append on each text chunk) or a lazily-joined memo that invalidates on push. Pass a getter if handlers rarely read it. Drop fullResponseChunks from the debug log, or bound it.
- **Evidence:** stream-parser.ts:668 and :689 `fullResponse: fullResponseChunks.join('')` inside createToolExecutionCallback.onTagEnd; :949 again at return; run-agent-step logs `fullResponseChunks` in the End-step debug.

## [MEDIUM] performance — packages/agent-runtime/src/util/token-counter.ts — [LANG] Token-counting kernel (gpt-tokenizer BPE) should move to a native/WASM kernel per D12; keep the TS facade
- **Risk:** The file documents that gpt-tokenizer's pure-JS BPE takes more than 2 minutes on a ~5MB separator-free body and stalled CI for 25 minutes. The mitigations (100k cap, 20k prefix-sample extrapolation, 8KB LRU bound, uncached 8-100KB band re-encoded on every call) trade accuracy for bounded latency: a transcript whose first 20k chars are unrepresentative (e.g. system-like JSON followed by CJK or minified code) extrapolates badly and can flip compaction triggers. Token counting runs per message on every iteration and on every eviction pass, so it is the one genuinely CPU-bound kernel in the core. Verdict: MOVE the kernel (tiktoken-rs via NAPI/bun:ffi, or a tiktoken WASM build with linear-time merges) behind the existing countTokens/countTokensJson/IncrementalTokenCounter API, which stays TS. Stream parsing, JSON repair and eviction logic stay TS (see the separate finding).
- **Fix:** Add a native/WASM encoder behind a `TokenEncoder` interface. Pick it at startup and fall back to the current JS path. Once encode is linear-time, remove the sampling extrapolation for inputs up to ~10MB. Add a benchmark gate in scripts/measure-m3-t2-hot-paths.ts covering the pathological separator-free and CJK cases.
- **Evidence:** token-counter.ts MAX_BPE_ENCODE_CHARS doc: 'a single ~5MB tool-result body measured >2 minutes per encode locally and stalled the CI agent-runtime suite at its whole 25-minute budget'; BPE_SAMPLE_CHARS = 20_000 prefix extrapolation; SEC-TC-RESCAN-1 notes that the 8KB-100KB band is re-encoded in full on every call.

## [MEDIUM] correctness — packages/agent-runtime/src/util/token-counter.ts — [POLY] Fudge factors and fallbacks are tuned on English code/JSON; non-Latin-script repos and prose get mis-sized budgets
- **Risk:** The per-family factors (Claude 1.35, Gemini 1.1, OpenAI 1.0) are documented as calibrated on 'typical code/JSON transcripts'. The Claude-vs-o200k ratio differs sharply for CJK, Cyrillic, Arabic, and for repos with heavy non-English comments or docs, so compaction triggers early or late (late means provider 400s and emergency trims). The chars/3 error fallback and the 20k-prefix extrapolation assume Latin density, so a polyglot transcript whose prefix is English system text and whose tail is CJK is undercounted. No-model callers silently default to the Anthropic 1.35 factor even when the routed model is OpenAI or Gemini.
- **Fix:** Calibrate from provider usage. The loop already receives usage.inputTokens per step (onCacheDebugUsageReceived), so keep an exponential moving ratio of provider-reported to locally estimated tokens per model and apply it in place of the static factor. Thread the routed model into every countTokens call site instead of the anthropic sentinel. Add script-mix fixtures (CJK, RTL, minified JS, Rust, Go) to token-counter.test.ts.
- **Evidence:** token-counter.ts: ANTHROPIC_TOKEN_FUDGE_FACTOR 1.35 with the doc 'on typical code/JSON transcripts'; countTokens defaults `model ?? ANTHROPIC_TOKEN_FUDGE_FACTOR_MARKED_MODEL`; the fallback is `Math.ceil((serialized.length / 3) * fudgeFactorForModel(model))`.

## [MEDIUM] correctness — packages/agent-runtime/src/util/tool-result-eviction.ts:205 — [POLY] Importance-aware eviction protection matches paths by substring over JSON-escaped content, so it fails for Windows and backslash-path tool output
- **Risk:** contentReferencesProtectedPath runs `JSON.stringify(message.content).includes(path)` against forward-slash protected paths. Tool output from Windows toolchains or non-JS build tools (MSBuild, cargo on Windows, pytest on Windows) prints `src\a.rs`, which serializes as `src\\a.rs` and never matches `src/a.rs`. The result that pinned task memory depends on is then evicted. Plain substring matching also means `a.ts` protects `data.ts`. This is the pinned-decision loss the protection exists to prevent, and it happens mainly in non-TS/Windows repos.
- **Fix:** Normalize each candidate's text once before matching: unescape to raw strings by walking the parts rather than using a JSON dump, then map backslashes to forward slashes. Match with segment boundaries (reuse summaryMentionsFocusPath from task-memory.ts). Add Windows-path and cargo/pytest-output fixtures.
- **Evidence:** tool-result-eviction.ts:205-214 `const serialized = JSON.stringify(message.content) ... if (scanRegion.includes(path)) return true`; deriveProtectedEvictionPaths keeps only paths accepted by looksLikeProjectPath (forward-slash project form).

## [MEDIUM] correctness — packages/agent-runtime/src/tools/handlers/tool/spawn-agent-utils.ts — [POLY] Librarian clone cleanup hardcodes a /tmp prefix and silently leaks clones on macOS (os.tmpdir under /var/folders) and Windows
- **Risk:** finalizeOwnedLibrarianClone accepts only cloneDir values starting with `/tmp/librarian-<repo>-<digits>`. Anywhere the clone path comes from os.tmpdir() (macOS $TMPDIR, Windows %TEMP%) the check fails, so it logs 'Refusing ... unowned path' and never deletes the clone. Repeated librarian use then fills the disk. The same module's persistOversizeArtifact correctly uses tmpdir(), so the two are inconsistent.
- **Fix:** Derive the expected prefix from `join(realpath(tmpdir()), 'librarian-' + repoName + '-')` (or a shared constant used by the cloning tool). Compare canonicalized paths with path.relative containment rather than string startsWith. Add a test with TMPDIR overridden.
- **Evidence:** spawn-agent-utils.ts finalizeOwnedLibrarianClone: `const expectedPrefix = repoName ? `/tmp/librarian-${repoName}-` : ''` and `!cloneDir.startsWith(expectedPrefix)`; compare persistOversizeArtifact `join(tmpdir(), 'openbuff-spawn-output')`.

## [LOW] api-contract — packages/agent-runtime/src/tools/handlers/tool/spawn-agent-utils.ts — [POLY] Editor brief prose fallback requires a slash-containing path with an extension, rejecting root-level or extensionless targets common in non-TS repos
- **Risk:** The fallback regex `hasConcreteTargetPath` requires `dir/.../name.ext`. Valid targets such as `Makefile`, `Dockerfile`, `BUILD.bazel` at the root, `go.mod`, `Cargo.toml` at the root, or `CMakeLists.txt` do not match, so a concrete prose brief for them is rejected. The spawn loop then burns retries.
- **Fix:** Allow root-level filenames and a known set of extensionless build files (Makefile, Dockerfile, Justfile, BUILD, WORKSPACE, Gemfile, Rakefile, Procfile). Alternatively, check the candidate against fileContext's file tree instead of a regex.
- **Evidence:** spawn-agent-utils.ts validateAgentInput: `/(?:^|[\s`'"(])(?:\.\.?\/)?[\w@.-]+(?:\/[\w@.-]+)+\.[A-Za-z][\w.-]*/m` has a mandatory `(?:\/...)+` segment and extension.

## [LOW] error-handling — packages/agent-runtime/src/tools/tool-executor.ts — [BEST] onCostCalculated promise is not awaited after tool completion (floating promise, lost rejection)
- **Risk:** In executeToolCall's result handler, `onCostCalculated(creditsUsed)` returns a Promise that is neither awaited nor caught. A rejecting cost sink becomes an unhandled rejection (Bun may crash or warn), and the debug log reads agentState.creditsUsed before the accumulation lands. In runAgentStep the closure accumulates into step-local stepCreditsUsed, so any late settle after the final spread is dropped.
- **Fix:** `await onCostCalculated(creditsUsed)` inside the async .then, and catch/log on failure. Enable @typescript-eslint/no-floating-promises for packages/agent-runtime.
- **Evidence:** tool-executor.ts, end of executeToolCall: `if (creditsUsed) { onCostCalculated(creditsUsed); logger.debug({ credits: creditsUsed, totalCredits: agentState.creditsUsed }, ...) }`.

## [LOW] dependency-hygiene — packages/agent-runtime/src/tool-stream-parser.old.ts — [BEST] Dead tool-stream-parser.old.ts is still present (re-flag of the harness-audit-2026-09-22 finding)
- **Risk:** The superseded parser copy sits beside the live module and inside the build/lint/search scope. Maintainers can patch the dead copy, and the file shows up in agent file trees and in test fixtures (run-state-context-overflow*.json). The earlier audit's fix was not applied.
- **Fix:** Delete the file, or move it out of src/ into an archive excluded from tsconfig and lint.
- **Evidence:** glob found packages/agent-runtime/src/tool-stream-parser.old.ts. The prior finding is at .agents/sessions/harness-audit-2026-09-22/findings/shard-runtime-loop.md:123. Live imports reference only '../tool-stream-parser'.

## [LOW] api-contract — packages/agent-runtime/src/tools/tool-executor.ts — [BEST] Gate flags are read and written through ad-hoc structural casts on AgentState instead of typed fields
- **Risk:** canSuggestFollowups, suggestFollowupsEmitted, uncommittedUnvalidatedFiles, commitScopeBypassAuthorized and commitScopeBypassRecord are accessed through `(agentState as { ... })` in many places. A rename in base2 silently disables a security-relevant gate (the git-committer dirty-file guard) with no type error. Other files add `as any` on the toolName and requestClientToolCall casts, and getPublicAgentState uses `messageHistory as any as ...`.
- **Fix:** Declare an optional typed `gateState` sub-object on AgentState in common, validated by zod at the base2 publish point. Read it through one accessor. Remove the `as any` casts.
- **Evidence:** tool-executor.ts: `(agentState as { canSuggestFollowups?: boolean }).canSuggestFollowups`, `(agentState as { commitScopeBypassAuthorized?: unknown })`, `}) as any,` on requestClientToolCall; run-programmatic-step.ts `messageHistory as any as PublicAgentState['messageHistory']` and `toolName: toolCallToExecute.toolName as any`.

## [LOW] performance — packages/agent-runtime/src/util/background-agent-jobs.ts — [BEST] Per-chunk JSON.stringify plus Buffer copy for every streamed background chunk, and O(buffer) rebuilds on every read
- **Risk:** appendBackgroundAgentChunk serializes and UTF-8-encodes each payload (token-sized text deltas included) purely for the 64KB size check. currentChunks rebuilds the whole projected array from a registry snapshot on every readBackgroundAgentChunks call. Both are bounded (200 events) but add constant per-token overhead to every background agent.
- **Fix:** Fast-path string/text payloads by length (string.length * 3 upper bound) before serializing, and skip Buffer.from unless close to the limit. Read chunks from the view's ring buffer, which is already kept in sync, instead of re-projecting the core snapshot.
- **Evidence:** background-agent-jobs.ts appendBackgroundAgentChunk: `const serialized = JSON.stringify(payload); const serializedBytes = Buffer.from(serialized, 'utf8')`; currentChunks: `registry.snapshot(job.jobId, 0)` mapped on every read.

## [LOW] test-coverage — packages/agent-runtime/src/util/stream-xml-parser.ts — [LANG] XML/JSON stream parsing should stay in TypeScript (confirmation)
- **Risk:** None. The parser is already linear: the rescan window is bounded by tag length (MAX_TAG_TAIL_CARRYOVER), JSON candidates are capped at 32, payloads are bounded at 64KB, and parsing is single-pass. Chunks are small and I/O-bound, so a native port would add FFI marshaling per chunk for no measurable gain. The only CPU-heavy kernel in scope is tokenization (separate finding). Minor polyglot nit: the fence strip recognizes only json|javascript|js.
- **Fix:** Keep in TS. Widen the fence regex to any language tag (```\w*), and add property-based tests for arbitrary chunk splits of tag boundaries.
- **Evidence:** stream-xml-parser.ts: MAX_TAG_TAIL_CARRYOVER comment 'per-chunk work stays linear in chunk size'; MAX_JSON_CANDIDATES = 32; DEFAULT_MAX_TOOL_CALL_BUFFER_LENGTH = 64 * 1024; fence regex /^```(?:json|javascript|js)?/.

## Coverage receipt

### Subsystems
- packages

### Features
- agent-loop
- tool-executor
- stream-parsing
- context-pruning
- spawn-agents
- token-counting
- background-jobs
- task-memory
- budget-enforcement

### Files
- packages/agent-runtime/src/run-agent-step.ts
- packages/agent-runtime/src/run-programmatic-step.ts
- packages/agent-runtime/src/tools/tool-executor.ts
- packages/agent-runtime/src/tools/stream-parser.ts
- packages/agent-runtime/src/tool-stream-parser.ts
- packages/agent-runtime/src/util/stream-xml-parser.ts
- packages/agent-runtime/src/util/token-counter.ts
- packages/agent-runtime/src/util/context-pruning.ts
- packages/agent-runtime/src/util/tool-result-eviction.ts
- packages/agent-runtime/src/tools/handlers/tool/spawn-agent-utils.ts
- packages/agent-runtime/src/util/background-agent-jobs.ts
- packages/agent-runtime/src/util/task-memory.ts
- packages/agent-runtime/src/util/budget-enforcement.ts

### Domains
- security
- correctness
- state-mutation
- error-handling
- performance
- dependency-hygiene
- test-coverage
- api-contract
