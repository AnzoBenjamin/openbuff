# Audit findings: cb-rt-loop

- Subsystems: packages
- Features: agent-loop-orchestration, handleSteps-isolation, subagent-supervision, durable-journal-replay, xml-tool-stream-parsing, tool-scheduling-barriers, tool-arg-repair-validation, filesystem-containment-backstop, context-token-accounting-pruning, spawn-receipts-output-compaction, mcp-tool-loading, llm-api-fallbacks, templates-system-prompt, orchestration-control-plane, self-mutated-path-crediting
- Files covered: 16
- Snapshot: 49801b44e84d3d8fa583c3ebd9b2855228bf122572b7cdf5f78c77b3389d824d

## [LOW] api-contract — packages/agent-runtime/src/run-agent-step.ts — Agent loop orchestration (loopAgentSteps/runAgentStep): KEEP
- **Risk:** Rewriting the loop means re-implementing the AI SDK streaming contract, the zod tool schemas, the AgentState shape and the compaction governor, and keeping two copies in sync. Almost all per-step time goes to waiting on LLM/network I/O, so a faster language saves microseconds against multi-second waits. The SPEC non-goal ('do not rewrite the agent loop') holds up against this evidence.
- **Fix:** Keep TypeScript on Bun. Now: nothing to gain from moving. Next: expose loopAgentSteps behind a serializable step boundary (the AgentState JSON plus journal events) so other-language hosts can drive it as a process. Do not port it.
- **Evidence:** run-agent-step.ts runAgentStep and loopAgentSteps: the loop is await-chained over getAgentStreamFromTemplate/processStream/runProgrammaticStep. It mutates initialAgentState in place (Object.assign after each step). It is coupled to the 'ai' ToolSet, the zod MemoryTurnContextV2Schema, and the context-pruning governor. The file is about 3.2k lines. Cost of moving: very high (months, plus a dual-schema tax). Confidence: high.

## [HIGH] state-mutation — packages/agent-runtime/src/run-programmatic-step.ts — handleSteps generator isolation (in-process new Function): HYBRID→QuickJS/WASM for untrusted, keep in-process for bundled
- **Risk:** handleSteps runs in the same isolate as the runtime. It receives the live agentState and injected capabilities (orchestrationControlPlane, recordGateTelemetry). A bug or runaway generator can corrupt the parent state, and a synchronous infinite loop inside generator.next() blocks the event loop because MAX_PROGRAMMATIC_TOOL_CALLS only counts yields. Live generators sit in AgentRunContextRegistry and cannot be serialized, so D35 journal replay cannot restore a mid-turn generator. The comment at the registry says so directly: 'Generator state can't be serialized'. new Function only prevents closure capture; it gives no memory or CPU isolation.
- **Fix:** Keep the in-process TS path for executionSource bundled/local. For 'database' and third-party sources, which are denied today, run handleSteps in QuickJS through quickjs-emscripten (WASM) with a memory limit and an interrupt handler. Pass only the JSON PublicAgentState and tool results across the boundary. Now: untrusted programmatic agents can be enabled safely, with CPU and memory caps. Next: handleSteps becomes deterministic if it is re-driven from journaled yields (replay the generator by feeding it the recorded tool_results), which unblocks D35 without serializing continuations. A separate process is heavier than needed. Rust wasmtime is an option only if the SDK host itself moves to Rust.
- **Evidence:** run-programmatic-step.ts: AgentRunContextRegistry (runIdToGenerator), TRUSTED_STRING_HANDLE_STEPS_EXECUTION_SOURCES, `new Function(`return (${template.handleSteps})`)()`, the generator!.next(...) loop, and the generatorParams injection of orchestrationControlPlane. Cost: medium (about 2-4 weeks). The injected control-plane functions need a message-passing shim, and there is a performance hit for base2 if it is ever sandboxed, so keep base2 in-process. Confidence: medium-high. Needs web check: quickjs-emscripten support for async generators, and interrupt-handler overhead.

## [HIGH] correctness — packages/agent-runtime/src/tools/handlers/tool/spawn-agents.ts — Subagent supervision (same-process coroutines): HYBRID→process-per-subagent with a TS supervisor (D36), not Elixir
- **Risk:** Foreground and background subagents both run as promises in the parent's event loop. There is no crash containment: an OOM, a sync hang, or an uncaught rejection in one child takes down the whole session. Background jobs are 'fire-and-forget same-process', and their lifecycle depends on in-memory registries (allocateBackgroundAgentJobBatch, the 32 process-wide / 8 per-root budget). A large share of the code is manual compensation for the missing supervisor: rollbackValidatedClaims, wiredBackgroundJobIds, lease release in finally, and settle-fault handling.
- **Fix:** Run each subagent (or each background subagent first) as a Bun child process executing the same TS runtime. The parent sends a spawn request as serialized AgentState and handoff, and the child streams back PrintModeEvents plus the final receipt over stdio/IPC. The supervisor stays in TypeScript and only sees child process exits. Elixir/OTP gives the best supervision semantics, but it would push the whole runtime across a language boundary, and the AgentState/zod contracts would have to be duplicated. Now: kill -9 on a stuck child, per-child memory limits, and background jobs that outlive a UI crash. Next: combined with the D35 journal, a crashed child can be restarted from its last step_boundary. Workers are not recommended because they share process fate on OOM and still require message-passing refactors.
- **Evidence:** spawn-agents.ts handleSpawnAgents: the detachedPromise = executeSubagent(...) block is not awaited. The file also contains rollbackValidatedClaims, the wiredBackgroundJobIds/abandonPreLaunchBackgroundAgentJob path, and Promise.allSettled for foreground agents. spawn-agent-utils.ts executeSubagent calls loopAgentSteps in-process and degrades a crash to {type:'error'}. Cost: medium-high (4-8 weeks). Blockers are the callback deps in extractSubagentContextParams (requestToolCall, sendAction, promptAiSdkStream), which must become RPC, and the parent mutation sites (reconcileAgentReceiptIntoParent, leases, discoveryCoverage), which must move to message handlers. Confidence: medium. Needs web check: Bun IPC throughput and maturity, and how Bun.spawn behaves under memory limits.

## [MEDIUM] correctness — packages/agent-runtime/src/tool-stream-parser.ts — Durable journal/replay (D35): KEEP TS, fix determinism leaks
- **Risk:** Replay assumes toolCallIds are reproduced from the injected idGen: the executeSingleToolCall short-circuit keys on journalReader.toolResultFor(runId, toolCallId). XML tool-call ids use crypto.randomUUID (there is a TODO for P2-T1). Other places also bypass the injected deps: Date.now() in sentAt and checkpoints, generateCompactId in executeToolCall, and createAgentState ids. A replay therefore cannot match journaled results for XML-parsed calls or spawned children, and can re-execute side-effecting tools.
- **Fix:** Keep TypeScript. The journal writer/reader should be backed by SQLite (bun:sqlite) or be consumed from the Rust SDK host if one exists. Thread idGen and clock through tool-stream-parser, tool-executor (generateCompactId), spawn-agent-utils createAgentState, and the sentAt stamps. Now: tool results can be matched deterministically on replay. Next: a full D35 replay driver, combined with QuickJS re-driven generators.
- **Evidence:** tool-stream-parser.ts processChunk: `xml-${crypto.randomUUID()}` with a TODO(P2-T1). run-programmatic-step.ts executeSingleToolCall reads the journalReader.toolResultFor short-circuit. run-agent-step.ts appends journal llm_request/llm_response around processStream. tool-executor.ts: `params.toolCallId ?? generateCompactId()`. spawn-agent-utils.ts createAgentState: `generateCompactId()`. Cost: low (days). Confidence: high.

## [LOW] performance — packages/agent-runtime/src/tools/stream-parser.ts — XML/native tool-call stream parsing: KEEP
- **Risk:** None significant. Parsing is incremental over chunks, and its cost is negligible next to model token latency.
- **Fix:** Keep TypeScript. A Rust parser would add FFI copies for every chunk and gain nothing. Next: none.
- **Evidence:** tool-stream-parser.ts processStreamWithTools uses parseStreamChunk with createStreamParserState. Text is emitted straight through (no buffering). Cost of moving: medium, with no benefit. Confidence: high.

## [LOW] state-mutation — packages/agent-runtime/src/tools/stream-parser.ts — Tool scheduling barriers (per-path read/write concurrency): KEEP
- **Risk:** Promise-chain barriers are correct for a single-threaded event loop. Their data structures are bounded (RF-5 pruning on settle).
- **Fix:** Keep TypeScript. If tools later move into subprocesses, keep this scheduler in the parent. Next: none.
- **Evidence:** stream-parser.ts processStream: writeBarriersByPath, customToolBarrier, inFlightReads, extractWritePath/canonicalizePathForBarrier, waitForOutstandingTools in finally. Cost of moving: high. Confidence: high.

## [LOW] api-contract — packages/agent-runtime/src/tools/tool-executor.ts — Tool argument repair and validation (parseRawToolCall, zod): KEEP
- **Risk:** The zod schemas in common/tools are the single source of truth for provider tool definitions and validation. A port would split that source. The hot cost, z.toJSONSchema, is already memoized (TOOL_JSON_SCHEMA_CACHE).
- **Fix:** Keep TypeScript. Next: if polyglot tools need the same contracts, export JSON Schema from zod as a build artifact. Do not re-implement the repair logic.
- **Evidence:** tool-executor.ts: parseRawToolCall, coerceInputScalarsBySchema, TOOL_JSON_SCHEMA_CACHE, repairEditToolScalars, detectMisbracedSpawnPayload. Cost of moving: high. Confidence: high.

## [LOW] correctness — packages/agent-runtime/src/tools/tool-executor.ts — Filesystem containment backstop (canonicalScopedToolPath): KEEP (authority lives in SDK handlers)
- **Risk:** The backstop calls realpathSync per path on the dispatch path, and there is a residual TOCTOU window, which the code acknowledges. The SDK handlers remain the authoritative layer.
- **Fix:** Keep TypeScript here. If the SDK tool host moves to Rust, put authoritative containment there (cap-std / openat2-style dirfd resolution) and keep this layer lexical. Next: kernel-enforced containment through a Rust host.
- **Evidence:** tool-executor.ts: canonicalScopedToolPath (realpathSync walk-up), EXTERNAL_READ_EXEMPT_TOOLS, OWNED_TEMP_WRITE_EXEMPT_TOOLS. Cost: low here. Confidence: medium. Needs web check: cap-std capability model.

## [LOW] performance — packages/agent-runtime/src/run-agent-step.ts — Context token accounting and pruning: KEEP (optionally CONSUME native tokenizer)
- **Risk:** countTokensJson runs every iteration on the system prompt and tools. It is memoized per message (IncrementalTokenCounter). The tokenizer implementation in util/token-counter was not read, so its actual cost is unverified.
- **Fix:** Keep the logic in TypeScript. If profiling shows the tokenizer is hot, consume a native/WASM tokenizer (e.g. a tiktoken WASM build) rather than moving the pruner. Next: cheaper per-step estimates on 1M-token windows.
- **Evidence:** run-agent-step.ts loopAgentSteps: IncrementalTokenCounter, `systemAndToolsTokens = countTokensJson(system) + countTokensJson(toolsForTokenCount)` recomputed each iteration. Cost: low. Confidence: medium, because util/token-counter.ts was not read.

## [LOW] state-mutation — packages/agent-runtime/src/tools/handlers/tool/spawn-agent-utils.ts — Spawn receipts and output compaction: KEEP
- **Risk:** This is pure JSON shaping against zod schemas (agentReceiptSchema), with no compute pressure.
- **Fix:** Keep TypeScript. With process supervision (D36), this code runs parent-side on the receipts children return. Next: none.
- **Evidence:** spawn-agent-utils.ts: buildRuntimeAgentReceiptOrThrow, normalizeSpawnedAgentOutput, boundAgentOutputForParent (256k cap, persistOversizeArtifact), mergeLastMessageFragments. Cost of moving: high. Confidence: high.

## [LOW] api-contract — packages/agent-runtime/src/mcp.ts — MCP tool loading: KEEP / CONSUME official TS SDK
- **Risk:** Uses convertJsonSchemaToZod over client-supplied schemas. The code is small, I/O-bound and handles failures per server (allSettled).
- **Fix:** Keep TypeScript. The official MCP SDK is TS-first. Next: none.
- **Evidence:** mcp.ts getMCPToolData: Promise.allSettled over requestMcpToolData, resolveMCPConfigOrigin untrusted-description wrapping. Cost: n/a. Confidence: high.

## [LOW] api-contract — packages/agent-runtime/src/llm-api/gemini-with-fallbacks.ts — LLM API fallbacks and retry: KEEP
- **Risk:** Network retry and backoff logic. The AI SDK provider ecosystem is TS-first.
- **Fix:** Keep TypeScript. Next: none.
- **Evidence:** gemini-with-fallbacks.ts: buildFallbackChain, promptFlashWithFallbacks, parseRetryAfterMs. prompt-agent-stream.ts getAgentStreamFromTemplate delegates to the injected promptAiSdkStream. Cost: n/a. Confidence: high.

## [LOW] performance — packages/agent-runtime/src/system-prompt/truncate-file-tree.ts — Templates, system prompt and file-tree truncation: KEEP
- **Risk:** Runs once per turn; the system prompt is cached across turns.
- **Fix:** Keep TypeScript. Next: none.
- **Evidence:** truncate-file-tree.ts truncateFileTreeBasedOnTokenBudget. templates/agent-registry.ts getAgentTemplate/assembleLocalAgentTemplates. main-prompt.ts mainPrompt/callMainPrompt. run-agent-step.ts system prompt reuse via initialAgentState.systemPrompt. Cost: n/a. Confidence: high.

## [LOW] state-mutation — packages/agent-runtime/src/orchestration/workflow-engine.ts — Orchestration control plane (workflow engine, discovery coordinator): KEEP
- **Risk:** These are pure functions injected into the base2 generator. If handleSteps is sandboxed they would need RPC, which is why base2 should stay in-process.
- **Fix:** Keep TypeScript. They are pure and JSON-in/JSON-out, so they are easy to expose over a QuickJS or IPC boundary later if needed.
- **Evidence:** workflow-engine.ts transitionWorkflow/transitionBase2Gate. discovery-coordinator.ts tryClaimDiscoveryShard/reconcileInterruptedDiscoveryShards. Injected via run-programmatic-step.ts generatorParams.orchestrationControlPlane. Cost: n/a. Confidence: high.

## [LOW] performance — packages/agent-runtime/src/run-agent-step.ts — Self-mutated path crediting (publishSelfMutatedPaths): KEEP
- **Risk:** Bounded walk with a depth-aware memo that handles cycles.
- **Fix:** Keep TypeScript. Next: none.
- **Evidence:** run-agent-step.ts publishSelfMutatedPaths / creditSelfMutatedPathValue (walkedAtDepth memo, depth>8 cap). Cost: n/a. Confidence: high.

## Coverage receipt

### Subsystems
- packages

### Features
- agent-loop-orchestration
- handleSteps-isolation
- subagent-supervision
- durable-journal-replay
- xml-tool-stream-parsing
- tool-scheduling-barriers
- tool-arg-repair-validation
- filesystem-containment-backstop
- context-token-accounting-pruning
- spawn-receipts-output-compaction
- mcp-tool-loading
- llm-api-fallbacks
- templates-system-prompt
- orchestration-control-plane
- self-mutated-path-crediting

### Files
- packages/agent-runtime/src/run-agent-step.ts
- packages/agent-runtime/src/run-programmatic-step.ts
- packages/agent-runtime/src/main-prompt.ts
- packages/agent-runtime/src/prompt-agent-stream.ts
- packages/agent-runtime/src/tool-stream-parser.ts
- packages/agent-runtime/src/tools/stream-parser.ts
- packages/agent-runtime/src/tools/tool-executor.ts
- packages/agent-runtime/src/tools/handlers/tool/spawn-agents.ts
- packages/agent-runtime/src/tools/handlers/tool/spawn-agent-utils.ts
- packages/agent-runtime/src/tools/handlers/tool/spawn-agent-inline.ts
- packages/agent-runtime/src/mcp.ts
- packages/agent-runtime/src/orchestration/discovery-coordinator.ts
- packages/agent-runtime/src/orchestration/workflow-engine.ts
- packages/agent-runtime/src/templates/agent-registry.ts
- packages/agent-runtime/src/system-prompt/truncate-file-tree.ts
- packages/agent-runtime/src/llm-api/gemini-with-fallbacks.ts

### Domains
- performance
- correctness
- state-mutation
- api-contract
