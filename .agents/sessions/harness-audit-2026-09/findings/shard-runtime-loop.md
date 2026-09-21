# Audit findings: shard-runtime-loop

- Subsystems: agent-loop, tool-dispatch, edit-system, context-management, subagent-spawning, web-fetching, background-jobs, read-authorization, budget-enforcement
- Features: step-cap-checkpoint, near-cap-nudge, budget-caps, semantic-compaction-governor, tool-result-eviction, compaction-archive-recall, compaction-verification, context-budget-ledger, edit-transaction-preflight, capability-substitution, read-authorization-remint, spawn-gates, background-agent-jobs, spawn-depth-cap, agent-receipts, workspace-path-leases, discovery-shards, ssrf-web-fetch-guards, llm-streaming, structured-output-retries
- Files covered: 26
- Snapshot: df9b2f192f10abc4503dfdc5a5a30643b0fd9ca84ef8d8cf5cd8988d93669cc1

## [MEDIUM] security — packages/agent-runtime/src/tools/handlers/tool/web-search-utils.ts:194 — SSRF DNS-rebinding TOCTOU in fetchPublicWebUrl: validated addresses are not pinned to the connection
- **Risk:** fetchPublicWebUrl validates all resolved IPs via assertSafePublicWebUrl, but the subsequent fetch(current) re-resolves DNS independently. An attacker-controlled DNS server can answer the validation lookup with a public IP and the fetch-time lookup with 127.0.0.1/169.254.169.254, reaching cloud metadata or internal services from the agent host. Redirect hops re-validate but inherit the same TOCTOU.
- **Fix:** Pin the validated IP: resolve once via node:dns, validate all addresses, then dial the pinned IP (custom undici Agent/dispatcher with SNI/host override) or re-validate the actually-connected remote address post-connect and abort if it is not one of the validated addresses.
- **Evidence:** fetchPublicWebUrl: 'let current = await assertSafePublicWebUrl(params.url)' then inside the loop 'const response = await fetch(current, { headers, redirect: "manual", signal })' — the URL object only carries the hostname; fetch performs its own DNS resolution. Redirect hops are re-validated the same way, so the gap applies per hop.

## [MEDIUM] security — packages/agent-runtime/src/tools/tool-executor.ts:3056 — Generic native tool failures echo raw error.message into agent-visible output, contradicting the module's own sanitization policy
- **Risk:** The MIGRATION NOTE (lines 148-160) claims 'the sibling native_tool_result_error path likewise never echoes raw internals', but the generic handler-failure catch interpolates the raw error message into agent-visible tool output. Unlinke spawn_agents (which routes through extractSanitizedSpawnRecoveryHint), every other tool's handler failure can surface stack-adjacent internals (paths, provider messages, internal IDs) to the model transcript and CLI.
- **Fix:** Apply the same policy as the spawn path: emit a static per-tool failure message plus a classified, allowlisted recovery hint; keep the raw error in logger.warn (already present). Alternatively add a sanitizing gate inside buildNativeToolResultErrorOutputV1 and update the migration note to match.
- **Evidence:** tool-executor.ts:3056-3061: 'buildNativeToolResultErrorOutputV1({ toolName, callId, issueCount: 1, message: `The ${toolName} handler failed after the tool call started: ${error instanceof Error ? error.message : String(error)}. No successful result is confirmed.` })' — direct interpolation of the thrown error, no extractSanitizedSpawnRecoveryHint-style allowlist.

## [MEDIUM] correctness — packages/agent-runtime/src/tools/handlers/tool/spawn-agent-utils.ts:2091 — Documented 'repeated-step watchdog' does not exist; subagent loops lack a stuck-loop guard
- **Risk:** executeSubagent's cancellation comment states subagents are bounded by 'the repeated-step watchdog', and the audit brief expects util/step-loop-guard.ts — neither exists anywhere in the package. A model stuck repeating an identical failing tool call (same input, same error) is bounded only by the full MAX_AGENT_STEPS_DEFAULT step budget and cost caps, so each wasted step pays an LLM call and the loop terminates at the cap with no early stuck detection.
- **Fix:** Implement the guard in util/step-loop-guard.ts: hash (toolName, canonical input, result status) per step, track consecutive repeats per run, and after N identical steps inject a system-tagged intervention message or terminate with a resumable checkpoint; add a dedicated test. Otherwise remove the comment claim.
- **Evidence:** spawn-agent-utils.ts:2090-2092: 'There is no wall-clock deadline: productive subagents are bounded only by cancellation, the repeated-step watchdog, spawn depth, and cost/token budgets.' code_search for 'watchdog|repeated-step|step-loop-guard' across packages/ returns only comment references; glob 'packages/agent-runtime/src/util/step-loop-guard.ts' returns 0 files.

## [LOW] correctness — packages/agent-runtime/src/process-edit-transaction.ts:478 — Failed-replacement attribution parses indices out of human-readable error strings
- **Risk:** resolveFailedEdit recovers which replacement failed by regex-matching the human-readable error text ('replacement (\d+)') produced by process-str-replace. If that message wording changes, the lookup silently yields the coalesced edit index instead, so failures[] attributes the failure to the wrong edit and edit-loop retry guidance points the model at the wrong replacement.
- **Fix:** Return a structured failedReplacementIndex from processStrReplace/processTransactionEdit alongside the message and consume that field here; keep the regex only as a legacy fallback.
- **Evidence:** process-edit-transaction.ts:478-481: 'const replacementMatch = errorMessage.match(/replacement (\d+)/i); const replacementIndex = replacementMatch ? Number.parseInt(replacementMatch[1], 10) - 1 : -1' then 'sourceEditIndex = replacementIndex >= 0 ? coalescedEdit?.replacementEditIndexes[replacementIndex] : undefined'.

## [LOW] correctness — packages/agent-runtime/src/util/compaction-verification.ts:93 — Extraction verification over-reports coverage via whole-transcript substring matching
- **Risk:** verifyExtractionCoverage counts a fact as retained when the fact string appears anywhere in JSON.stringify(postMessages). A path echoed in an unrelated retained message, a todo list, or a command string satisfies the check even when the actual read/edit evidence was destroyed, so missing[] under-reports and the recovery guidance can claim full coverage after a lossy compaction.
- **Fix:** Restrict the survival check to the retained <knowledge_memory>/summary blocks plus structured task-memory fields (filesInspected/editsMade exact or path-normalized membership), not the whole serialized transcript; optionally require the fact to appear in a retained tool-result or memory entry rather than anywhere.
- **Evidence:** compaction-verification.ts: 'const postText = JSON.stringify(postMessages)' then 'if (postText.includes(fact)) continue; if (memoryCites(taskMemory, fact)) continue' — memoryCites itself uses entry.includes(fact) on task-memory list entries.

## [LOW] state-mutation — packages/agent-runtime/src/util/context-pruning.ts:503 — Governor disables passes by mutating passesThisTurn to a sentinel, producing false telemetry
- **Risk:** recordPassSettled disables further passes by overwriting governor.passesThisTurn with SEMANTIC_MAX_PASSES_PER_TURN after 2 unproductive passes. The denial reason then renders 'Turn cap reached (3/3 passes)' although only 2 passes ran, and the no-progress cap becomes indistinguishable from the genuine turn cap in logs, events, and any consumer correlating pass counts against cost telemetry.
- **Fix:** Add an explicit capped/no-progress state or flag on the governor and surface it in the denial reason and telemetry, keeping passesThisTurn equal to the number of passes actually announced.
- **Evidence:** context-pruning.ts:501-504: 'governor.consecutiveNoProgressPasses += 1; if (governor.consecutiveNoProgressPasses >= 2) { governor.passesThisTurn = SEMANTIC_MAX_PASSES_PER_TURN }' and shouldRunSemanticPass reason: `Turn cap reached (${governor.passesThisTurn}/${SEMANTIC_MAX_PASSES_PER_TURN} passes)`.

## [LOW] state-mutation — packages/agent-runtime/src/run-agent-step.ts:1077 — Mixed in-place vs copy-on-write mutation discipline in runAgentStep is fragile under refactor
- **Risk:** runAgentStep mixes two mutation disciplines on the same object: copy-on-write spreads (lines 446-456, 481-487, 1077-1095) coexist with in-place writes (messageHistory at 559/872/1037, taskMemory at 862, consecutiveTextOnlyWithoutCompletion at 1032, output at 1049, selfMutatedPaths via publishSelfMutatedPaths at 843-846). Correctness today depends on every in-place write landing before the final spread reads the same reference; any early-return added between an in-place write and the spread (or a future refactor that clones earlier) silently drops that write. The C2.3 comments document the cost-accumulator instance of exactly this bug class.
- **Fix:** Pick one ownership model per function: either fully in-place (like loopAgentSteps documents) or fully copy-on-write, and freeze the boundary with a lint rule or a deep-readonly type for the pre-spread alias. At minimum, group every in-place write adjacent to the final spread with a comment tying them to it.
- **Evidence:** run-agent-step.ts mixes 'agentState.messageHistory = agentMessagesUntruncated' (559), 'agentState.taskMemory = nextTaskMemory' (862), 'agentState.consecutiveTextOnlyWithoutCompletion = consecutive' (1032), 'agentState.output = { harvestedFromFallback: true }' (1049) with 'agentState = { ...agentState, ... }' (1077) and 'agentState = { ...agentState, ... }' (446).

## [LOW] error-handling — packages/agent-runtime/src/run-agent-step.ts:2805 — finishAgentRun is awaited unguarded inside the error/cancel catch paths
- **Risk:** All three finishAgentRun awaits inside the catch block (cancelled path 2805, failed path 2846) and the success path (2762) are unguarded. If finishAgentRun itself rejects (telemetry sink outage, serialization bug), the rejection replaces the original error: the 402 re-throw never happens, the structured error output is never returned, and the caller observes an unrelated persistence failure instead of the real failure mode.
- **Fix:** Wrap each finishAgentRun call in the catch path (and ideally the success path) in a try/catch that logs and continues, so the original error and its output contract are always preserved; optionally record a telemetry flag that run finalization failed.
- **Evidence:** catch block: 'const status = signal.aborted ? "cancelled" : "failed"; await finishAgentRun({ ...params, runId, status, ... errorMessage })' — no try/catch around the call before 'if (statusCode === 402) { throw error }' and the error-output return.

## [MEDIUM] performance — packages/agent-runtime/src/run-agent-step.ts:1994 — Loop re-tokenizes the full transcript 4-6 times per iteration; no per-message token memoization
- **Risk:** Every loop iteration performs multiple full tokenizations of the entire transcript via countTokensJson (contextTokenCount estimate before programmatic step, re-estimate after eviction, after programmatic step, plus historyTokensBefore/AfterProgrammatic, plus evictStaleToolResults' two whole-array counts, plus verifyExtractionCoverage's full JSON.stringify). Token counting walks every character with gpt-tokenizer, so on 200k-1M token histories each step re-pays O(context) CPU several times over in the hottest loop of the runtime, adding latency and burning event-loop time between the LLM call and tool execution.
- **Fix:** Memoize per-message token counts keyed by message reference (Map<Message, number>, WeakMap or a symbol side-channel), and compute array totals by summation with invalidation only for changed entries; reuse the before/after measurements for the trigger decision instead of a separate estimate pass. The same memo serves eviction's delta (sum only changed candidates).
- **Evidence:** run-agent-step.ts: 'const estimateContextTokensLocally = () => countTokensJson(messagesWithStepPrompt) + systemAndToolsTokens' (1994) called at 1997, 2067, 2385, 2520; 'const historyTokensBeforeProgrammatic = countTokensJson(historyBeforeProgrammatic)' (2193); 'const historyTokensAfterProgrammatic = countTokensJson(currentAgentState.messageHistory)' (2387). tool-result-eviction.ts: 'const tokensSaved = countTokensJson(messages) - countTokensJson(nextMessages)'.

## [MEDIUM] dependency-hygiene — packages/agent-runtime/package.json:34 — Direct runtime imports of zod and @ai-sdk/provider are undeclared; mixed pinning policy
- **Risk:** Runtime source imports zod (zod/v4 in tool-executor.ts:34, spawn-agent-utils.ts:56, used for spawn input schemas and scalar coercion) and @ai-sdk/provider (type-only, tool-executor.ts:97), but package.json declares neither — both resolve only as transitive dependencies of 'ai' or workspace packages, so a transitive refactor or hoisting change breaks the runtime build undeclared. Pinning policy is also mixed: lodash/diff/zod-from-json-schema exact, ai ^5.0.52 and gpt-tokenizer ^2.8.1 floating minors.
- **Fix:** Add zod (and @ai-sdk/provider if the type import is kept) to dependencies with an explicit version; standardize on exact pins for runtime-affecting deps (or all deps) so provider transitive drift cannot change coercion/repair behavior silently.
- **Evidence:** package.json dependencies lists only @codebuff/common, gpt-tokenizer, zod-from-json-schema, lodash, @codebuff/code-map, ai, diff; tool-executor.ts:34 'import z from "zod/v4"' (runtime use in coerceInputScalarsBySchema), tool-executor.ts:97 'import type { LanguageModelV2StreamPart } from "@ai-sdk/provider"'.

## [MEDIUM] test-coverage — packages/agent-runtime/src/run-agent-step.ts:1913 — No tests for the (missing) step-loop guard, DNS-rebinding TOCTOU, or governor throw-path settle; loop tests could not be confirmed to cover step-cap/generator break-out
- **Risk:** Gaps confirmed against the tree: (1) no test can assert the repeated-step watchdog because util/step-loop-guard.ts does not exist and the guard is unimplemented; (2) web-search-security.test.ts covers static blocking but a DNS-rebinding TOCTOU test (resolver that returns a public IP then a loopback IP) is absent; (3) the hitStepCap threading into the base2 generator break-out and the finally-settle of a pending compaction card on throw are loop-integration paths whose coverage could not be confirmed in loop-agent-steps.test.ts; (4) the pre-launch background job abandonment path (wiredBackgroundJobIds / abandonPreLaunchBackgroundAgentJob) has no dedicated error-injection test visible.
- **Fix:** Add: (1) a stuck-loop guard test once the watchdog exists; (2) a fetch-level test that swaps DNS (custom lookup) to prove the connected address is the validated one; (3) a loop test asserting hitStepCap breaks the base2 generator instead of re-triggering the gate; (4) a background test asserting allocateBackgroundAgentJobBatch throw before attach leaves zero 'running' jobs (abandonPreLaunchBackgroundAgentJob path).
- **Evidence:** glob 'packages/agent-runtime/src/util/step-loop-guard.ts' -> 0 files. web-search-utils.ts fetch loop: 'const response = await fetch(current, { headers, redirect: "manual", signal })' with no post-connect address assertion. Existing suites confirmed present but not audited line-by-line for these branches.

## [LOW] api-contract — packages/agent-runtime/src/tools/tool-executor.ts:161 — Deliberate breaking change to spawn_agents failure errorMessage contract (static message + sanitized recoveryHint)
- **Risk:** The retired 'Agent spawn failed: <raw message>' per-agent error format was replaced by a static SPAWN_HANDLER_FAILURE_MESSAGE plus a sanitized, allowlisted recoveryHint (validation-shaped prefixes only, 2000-char cap). This is a deliberate breaking change to spawn_agents tool-output shape; any downstream consumer or test pinning the old interpolated format or parsing raw handler errors from output will silently break. The note explicitly forbids pinning the new format in tests, so a future accidental reintroduction of interpolation would not be caught.
- **Fix:** No code change required; keep the do-not-pin instruction. Track a changelog entry for the tool-output schema so external consumers parsing per-agent errorMessage are warned, and consider versioning the envelope if more fields land.
- **Evidence:** tool-executor.ts:161-162 'const SPAWN_HANDLER_FAILURE_MESSAGE = "Agent spawn failed because the handler could not validate the request."' with output shape { errorMessage, recoveryHint? } per agent entry; extractSanitizedSpawnRecoveryHint allowlist regex at 186-190.

## [MEDIUM] api-contract — packages/agent-runtime/src/run-agent-step.ts:1176 — BEST-POSSIBLE VERDICT — agent loop (loopAgentSteps/runAgentStep): adequate-with-gaps
- **Risk:** Verdict: adequate-with-gaps. Present: hard step cap with resumable checkpoint and assistant-turn persistence, one-time near-cap nudge, pre- and post-step budget enforcement with user-visible budget messages, semantic-compaction governor (cooldown/rearm/turn-cap/emergency override), compaction status settle guaranteed in finally, generator teardown in finally (no leaked generators on recycled runIds), abort checks per iteration, structured-output retry bound (3). Missing versus best-possible: no repeated-step/stuck-loop guard despite design comments referencing one (see correctness finding); no wall-clock stall alarm per step (a hung LLM stream blocks the loop with no runtime-level timeout visible in this file); n-param path defers budget enforcement to the next step's pre-check by design; token accounting is recomputed wholesale instead of incrementally.
- **Fix:** Implement util/step-loop-guard.ts (hash-based repeated-step detection with intervention message then resumable termination); add an optional per-step wall-clock alarm that aborts a stalled LLM stream; memoize token counts (see performance finding); add a budget check on the n-param return path.
- **Evidence:** run-agent-step.ts:438-464 step-cap resumable checkpoint with hitStepCap; 506-531 pre-LLM checkBudgetExceeded; 1805-1910 loop-local governor + registerCompaction; 2493-2568 mechanical trim as emergency brake; 2884-2899 finally: settleCompactionStatus() + clearAgentGeneratorForRun(runId).

## [MEDIUM] api-contract — packages/agent-runtime/src/tools/tool-executor.ts:2106 — BEST-POSSIBLE VERDICT — tool dispatch (executeToolCall/parseRawToolCall): adequate-with-gaps
- **Risk:** Verdict: adequate-with-gaps. Present: availability check before parsing (prevents removed-tool crash for programmatic callers), permission gate aligned with progressive tool disclosure, universal filesystem escape hard-block with canonical symlink-aware resolution and TOCTOU-mitigated realpath walk, deliberately fail-closed git-committer dirty-set coverage with segment-boundary prefix matching, atomic batch spawn validation, recoverable failure envelopes, output schema validation with read-authorization revocation, abortable serialization barrier. Missing versus best-possible: path extraction for containment is a hand-maintained if-chain (getFilesystemToolPaths) — the find_files_matching_content comment admits a tool previously shipped with NO backstop; a new filesystem tool silently gets none unless someone remembers; raw error.message echoed into generic failure output contradicts the module's own sanitization policy; code_search/glob/find_files_matching_content rely entirely on this single backstop layer (their SDK handlers do no containment).
- **Fix:** Replace the hand-written if-chain with a schema-driven per-tool path extractor (derive from toolParams inputSchemas) plus a registry test that fails when any handler with filesystem-touching inputs lacks an extractor; unify all native failure outputs on the sanitized envelope with an allowlisted recovery hint.
- **Evidence:** tool-executor.ts:2146 availability-before-parse guard; 2225-2340 escape hard-block with canonicalScopedToolPath realpath walk; 2578-2594 fail-closed dirty-set coverage; 2687-2702 refusal naming blocking files; 3046-3063 raw error.message envelope (see security finding); 1725-1815 hand-written tool->paths if-chain.

## [LOW] api-contract — packages/agent-runtime/src/process-edit-transaction.ts:166 — BEST-POSSIBLE VERDICT — edit system (process-edit-transaction + edit-transaction handler): best-in-class
- **Risk:** Verdict: best-in-class. Present: strict all-or-nothing preflight (first failure aborts with NO files changed), documented idempotent skipIfMissing semantics distinguishing no-op-only transactions from genuinely empty edits, fail-closed confirmed-post-edit capability substitution gated on six conditions (well-formed token, anchor exists, whole-file anchor, known snapshot, hash freshness, scope-bound anti-replay), transport-truncation heuristics requiring double corroboration (payload imbalance AND whole-file raw imbalance) so authored regex fragments stay on preflight_failed, transformation ledger mapping replace_range offsets across prior edits with explicit unmappable-path fallback, recovery guidance that mandates re-reading EVERY target rather than replaying stale tokens, transaction-level size caps imported from common. Gap versus best-possible: failure attribution depends on regex over error strings.
- **Fix:** Propagate a structured failedReplacementIndex from the str_replace engine instead of regex-scanning the message; everything else already meets the best-possible bar for a harness edit system.
- **Evidence:** processEditTransaction: 'failures.push(...); break' on every error kind with 'NO files were changed' contract (340-350); substituteConfirmedPostEditCapabilities fail-closed checks 1-6 (209-238); looksLikeTruncatedEditContent requires BOTH payload imbalance and whole-file raw imbalance (114-120); recovery message forbids partial re-reads (344).

## [LOW] api-contract — packages/agent-runtime/src/run-agent-step.ts:2023 — BEST-POSSIBLE VERDICT — context management (pruning/eviction/archive/verification/consolidation/budget): best-in-class
- **Risk:** Verdict: best-in-class. Present: layered defense — free deterministic tool-result eviction above a window-derived floor (idempotent via tombstone detection, reference-stable no-op below the savings floor, importance-aware protection derived from task memory), a governor state machine making the expensive LLM pass rare by construction with an emergency override that provably cannot deadlock, post-compaction extraction verification surfacing lost facts in recovery guidance, identity-keyed pre-compaction archive with a bounded recall leg, mechanical trim demoted to emergency brake with archived recovery source, implicit read-authorizations revoked after EVERY history rewrite (eviction, semantic, mechanical) so stale reads cannot authorize edits, context-budget ledger with compaction annotation, window-class-aware budgets for 8k-1M windows with documented invariants. Gaps versus best-possible: verification matching is substring-loose (over-reports retention); no-progress cap reported via a sentinel that misstates pass counts.
- **Fix:** Anchor the verification fact-check to retained memory blocks and structured task-memory fields (see correctness finding); make the no-progress cap a first-class governor state instead of the passesThisTurn sentinel (see state-mutation finding).
- **Evidence:** run-agent-step.ts:2023-2077 eviction before governor; context-pruning.ts:414-464 governor decisions with documented rearm invariant (521-541); run-agent-step.ts:2432-2436 verifyExtractionCoverage wired into recovery guidance; context-archive.ts:100-119 identity-keyed archivePreCompaction; run-agent-step.ts:2045-2051 and 2509 revokeImplicitReadAuthorizationsAfterCompaction on every history rewrite.

## [MEDIUM] api-contract — packages/agent-runtime/src/tools/handlers/tool/spawn-agents.ts:100 — BEST-POSSIBLE VERDICT — subagent spawning (spawn-agents/spawn-agent-inline/spawn-agent-utils): adequate-with-gaps
- **Risk:** Verdict: adequate-with-gaps. Present: whole-batch validation before any launch, atomic background capacity pre-allocation (batch cannot land between preflight and allocation), explicit pre-launch abandonment so a throw mid-loop cannot strand 'running' jobs consuming the process-wide/per-root budget, workspace-path-lease and discovery-shard rollback on batch failure, spawn-depth cap, structured runtime receipts with mutation attestations reconciled into parent state, sanitized spawn-failure outputs, combined abort signals with listener cleanup on both settle paths, librarian clone cleanup restricted to tool/system-trusted messages and shape-validated /tmp prefix. Gaps versus best-possible: no wall-clock deadline option for any spawn (deliberate, but a best-possible harness bounds unattended background jobs); the 'repeated-step watchdog' cited as a bound does not exist; reviewer/spawn recovery hints are a large hand-maintained agent-type dispatch chain (validateAgentInput) that drifts from schemas without a test forcing parity.
- **Fix:** Add an optional bounded default deadline for background jobs (e.g. configurable, with a clean resumable finish at the deadline) and a per-root wall-clock/fan-out telemetry counter; keep foreground spawns unbounded as documented.
- **Evidence:** spawn-agents.ts: 'const validatedAgents: ValidatedSpawnAgent[] = await Promise.all(agents.map(...))' before any launch; allocateBackgroundAgentJobBatch comment 'Either every id exists ... or nothing is launched'; spawn-agent-utils.ts:2067-2073 depth throw; createCombinedAbortSignal cleanup contract (2170-2208); MAX_SPAWN_BATCH_SIZE enforced in handler.

## Coverage receipt

### Subsystems
- agent-loop
- tool-dispatch
- edit-system
- context-management
- subagent-spawning
- web-fetching
- background-jobs
- read-authorization
- budget-enforcement

### Features
- step-cap-checkpoint
- near-cap-nudge
- budget-caps
- semantic-compaction-governor
- tool-result-eviction
- compaction-archive-recall
- compaction-verification
- context-budget-ledger
- edit-transaction-preflight
- capability-substitution
- read-authorization-remint
- spawn-gates
- background-agent-jobs
- spawn-depth-cap
- agent-receipts
- workspace-path-leases
- discovery-shards
- ssrf-web-fetch-guards
- llm-streaming
- structured-output-retries

### Files
- packages/agent-runtime/src/run-agent-step.ts
- packages/agent-runtime/src/main-prompt.ts
- packages/agent-runtime/src/tools/tool-executor.ts
- packages/agent-runtime/src/process-edit-transaction.ts
- packages/agent-runtime/src/util/read-authorization.ts
- packages/agent-runtime/src/util/context-pruning.ts
- packages/agent-runtime/src/util/context-budget.ts
- packages/agent-runtime/src/util/tool-result-eviction.ts
- packages/agent-runtime/src/util/tool-result-lifecycle.ts
- packages/agent-runtime/src/util/context-archive.ts
- packages/agent-runtime/src/util/compaction-verification.ts
- packages/agent-runtime/src/util/context-consolidation-runner.ts
- packages/agent-runtime/src/tools/handlers/tool/spawn-agent-utils.ts
- packages/agent-runtime/src/tools/handlers/tool/spawn-agents.ts
- packages/agent-runtime/src/tools/handlers/tool/spawn-agent-inline.ts
- packages/agent-runtime/src/tools/handlers/tool/web-search-utils.ts
- packages/agent-runtime/src/tools/handlers/tool/edit-transaction.ts
- packages/agent-runtime/package.json
- packages/agent-runtime/src/__tests__/loop-agent-steps.test.ts
- packages/agent-runtime/src/__tests__/loop-agent-steps-abort.test.ts
- packages/agent-runtime/src/__tests__/background-agent-jobs.test.ts
- packages/agent-runtime/src/__tests__/web-search-security.test.ts
- packages/agent-runtime/src/__tests__/edit-transaction-multi-file-recovery.e2e.test.ts
- packages/agent-runtime/src/__tests__/spawn-agents-permissions.test.ts
- packages/agent-runtime/src/util/__tests__/read-authorization.test.ts
- packages/agent-runtime/src/util/__tests__/context-pruning.test.ts

### Domains
- security
- correctness
- state-mutation
- error-handling
- performance
- dependency-hygiene
- test-coverage
- api-contract
