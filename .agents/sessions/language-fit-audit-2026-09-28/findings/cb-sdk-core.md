# Audit findings: cb-sdk-core

- Subsystems: sdk
- Features: run-loop-orchestration, tool-dispatch-trust-injection, terminal-approval-policy, readable-roots-trust-gate, observation-digest-gates, status-code-heuristics, librarian-clone-cleanup, client-facade, session-state-project-index, session-git-context, env-credential-scrubbing, llm-stream-retry-failover, tool-input-json-repair, request-context-token-budget, byok-cost-accounting, agent-runtime-di-wiring, failover-policy, model-routing-vision-compat, responses-api-sse-translation, remote-api-client, embeddings-factory, provider-config-schema-loader, provider-config-hot-path-cache, provider-config-transactional-write, model-discovery, retry-policy, serve-transport-selection, acp-serve-bridge, unix-socket-auth-listener, outbound-secret-redaction, ripgrep-resolution, job-update-forwarder, sdk-dependency-manifest, d38-authored-language-set
- Files covered: 21
- Snapshot: 49801b44e84d3d8fa583c3ebd9b2855228bf122572b7cdf5f78c77b3389d824d

## [LOW] api-contract — sdk/src/run.ts — Run-loop orchestration (runOnce: abort/timeout, callback queue, terminal promise, memory prepare/finish): KEEP
- **Risk:** Needs: async concurrency over one event loop, AbortSignal composition, tight coupling to AI SDK streams and JS callbacks (handleEvent/handleStreamChunk/overrideTools). Latency is dominated by LLM I/O, not CPU. TS is best: every collaborator (agent-runtime, AI SDK, host callbacks) is JS; a boundary here would serialize every stream chunk.
- **Fix:** Keep in TS. Unlock next: expose the same lifecycle over ACP (already started in serve/) so Rust daemon / other-language hosts drive runs without FFI. Do not port.
- **Evidence:** run.ts run()/runOnce(). Cost of moving: rewrite of ~1.5k lines plus all agent-runtime deps; per-chunk IPC overhead. Confidence: high.

## [MEDIUM] api-contract — sdk/src/run.ts — Tool dispatch + trusted-owner injection (handleToolCall if/else chain): HYBRID (TS dispatch, Rust executors for OS-touching tools)
- **Risk:** Needs: trust stamping (owner, fileFilter, capabilityIssuer) must be runtime-owned; OS-level tools (run_terminal_command, code_search, git_*, file mutation broker) need isolation and crash containment that an in-process Node call cannot give. Current in-process dispatch is right for policy, wrong as the enforcement point for the planned Rust sandbox shim.
- **Fix:** Keep dispatch/trust injection in TS; route process-spawning and fs-mutating executors through a stable versioned tool-exec protocol (JSON over stdio/UDS) to the Rust daemon/sandbox shim (tokio + landlock/seccompiler on Linux, sandbox-exec/Seatbelt on macOS). Unlocks now: crash containment for runaway tools; unlocks next: per-tool resource limits, remote/containerized execution with the same contract.
- **Evidence:** run.ts handleToolCall (~40-branch if/else, raceAgainstAbort, fs.hostProcessView checks). Cost: define protocol schema (zod->JSON Schema), Rust crate, CI matrix for 3 OSes; boundary overhead ~sub-ms per call, negligible vs tool runtime. Confidence: medium-high; landlock/Seatbelt capability specifics need web verification.

## [MEDIUM] correctness — sdk/src/run.ts — Terminal high-impact approval policy (authorizeHighImpactAction, approval receipts): HYBRID (policy TS, enforcement Rust shim)
- **Risk:** Needs: deterministic policy + tamper-resistant enforcement. Classification/approval flow is business logic that fits TS; but the command still executes via node child_process in the same process, so enforcement relies on correct classification of shell strings rather than OS containment.
- **Fix:** Keep evaluateHarnessActionPolicy/approval receipts in TS; have the Rust sandbox shim enforce the decided profile (fs/network allowlists) on the spawned child. Unlocks now: classification misses no longer equal escapes; next: policy-as-data shared with Python offline evaluation of approval telemetry.
- **Evidence:** run.ts handleToolCall run_terminal_command branch. Cost: shim must accept a policy descriptor; moderate. Confidence: medium.

## [MEDIUM] correctness — sdk/src/run.ts — readableRoots ER-1 trust gate (selectTrustedReadableRoots + ensureExternalReadRootsConfigured): KEEP decision in TS, mirror enforcement into Rust sandbox
- **Risk:** Needs: pure, testable path containment. TS is fine for the decision; but the allowlist is only enforced by TS read tools, not by child processes (a terminal command can read any root).
- **Fix:** Keep the pure gate in TS; pass the trusted root set to the Rust sandbox shim as read-only landlock rules. Unlocks: one allowlist governs both tool reads and spawned processes.
- **Evidence:** run.ts selectTrustedReadableRoots, isPathInsideDirectory. Cost: small once shim exists. Confidence: medium.

## [LOW] performance — sdk/src/run.ts — list_jobs / git_status per-turn digest gates: KEEP
- **Risk:** Needs: cheap hashing of small payloads, closure-scoped state. No CPU pressure.
- **Fix:** Keep TS.
- **Evidence:** run.ts applyListJobsDigestGate, applyGitStatusGate (stableHash). Confidence: high.

## [LOW] correctness — sdk/src/run.ts — Status-code extraction from error strings (extractStatusCodeFromMessage): KEEP
- **Risk:** String heuristics on AI SDK error text; language irrelevant. Brittleness is a correctness issue, not a language one ('500' substring matches any message containing 500).
- **Fix:** Keep TS; prefer structured APICallError.statusCode (already via getErrorStatusCode) over substring matching.
- **Evidence:** run.ts extractStatusCodeFromMessage/handlePromptResponse. Confidence: high.

## [LOW] correctness — sdk/src/run.ts — Librarian clone detection + cleanup (regex on command, rmSync, 30min timer): KEEP / later move into daemon
- **Risk:** Owning temp dirs via regex on a shell string is fragile; timer dies with process so clones leak on crash.
- **Fix:** Short term keep TS. When Rust daemon lands, it owns scratch dirs (tempfile crate, cleanup on daemon start). Unlocks: crash-safe temp lifecycle.
- **Evidence:** run.ts ownedLibrarianCloneDirs / cleanupLibrarianClone. Confidence: high.

## [LOW] api-contract — sdk/src/client.ts — OpenbuffClient facade: KEEP (npm public API)
- **Risk:** Public TS SDK surface; callbacks are JS functions, so FFI to other languages is impossible by design. Polyglot hosts should use ACP, not bindings.
- **Fix:** Keep TS. Unlock next: document ACP (serve) as the cross-language SDK instead of generating Python/Go bindings.
- **Evidence:** client.ts OpenbuffClient.run. Confidence: high.

## [MEDIUM] performance — sdk/src/run-state.ts — Project discovery + symbol token scoring (discoverProjectPaths, computeProjectIndex via code-map/tree-sitter WASM): MOVE->Rust (planned index)
- **Risk:** Needs: fast gitignore-aware walk, parsing many files, low memory, incremental updates. Runs on every run AND every continued run (applyOverridesToSessionState rediscovers the live tree and re-scores), on the main event loop, using web-tree-sitter WASM. This is CPU-bound, repeated, and blocks startup latency on large repos.
- **Fix:** Rust index daemon: `ignore` crate (ripgrep's walker) + native `tree-sitter` + notify-based incremental invalidation; TS calls it over the daemon protocol and receives fileTree/tokenScores. Unlocks now: sub-second warm session start, no WASM parse on each turn; next: persistent cross-session symbol graph, semantic index sharing with embeddings, watch-driven context freshness.
- **Evidence:** run-state.ts initialSessionState / applyOverridesToSessionState / computeProjectIndex; package.json web-tree-sitter 0.25.10, @vscode/tree-sitter-wasm. Cost: large (index crate + protocol), but already on roadmap; boundary returns large JSON — use MessagePack or paging. Confidence: medium; speedup magnitude native vs WASM tree-sitter needs benchmarking.

## [LOW] performance — sdk/src/run-state.ts — Git context capture (getGitChanges: 4 git spawns with 5s timeout): CONSUME git CLI (keep)
- **Risk:** Spawning git is the correct consume choice; porting to gitoxide/libgit2 buys little for 4 calls per session.
- **Fix:** Keep consuming git. Later, if the Rust daemon already holds the repo, use gix for status to share with index invalidation.
- **Evidence:** run-state.ts getGitChanges/childProcessToPromise. Confidence: high.

## [LOW] performance — sdk/src/run-state.ts — Session state cloning/restore (JSON.parse(JSON.stringify), structuredClone, sanitizeAgentStateSecurityMaps): KEEP
- **Risk:** Whole-state deep clones per run grow with message history; a TS algorithmic issue, not a language fit issue.
- **Fix:** Keep TS; consider structural sharing if profiling shows cost.
- **Evidence:** run-state.ts applyOverridesToSessionState, withMessageHistory. Confidence: high.

## [LOW] correctness — sdk/src/env.ts — Env accessors + child-process credential scrubbing (getChildProcessEnv denylist): KEEP, plus allowlist in Rust shim
- **Risk:** Denylist of 8 names misses other provider secrets (any apiKeyEnv from openbuff.json, e.g. OPENCODE_GO_API_KEY, FREEMODEL_API_KEY). Language-neutral issue.
- **Fix:** Keep TS; derive denylist from configured apiKeyEnv values; later the Rust sandbox shim applies env_clear + allowlist. Unlocks: provider-agnostic secret isolation.
- **Evidence:** env.ts getChildProcessEnv vs provider-config.ts presets apiKeyEnv. Confidence: high.

## [LOW] api-contract — sdk/src/impl/llm.ts — LLM streaming with retry, failover, ChatGPT OAuth fallback (promptAiSdkStream/promptAiSdk/promptAiSdkStructured): KEEP (CONSUME Vercel AI SDK)
- **Risk:** Needs: broad provider coverage, tool-call repair hooks, streaming. Vercel AI SDK (ai@5) is the best-in-class multi-provider library; Rust (async-openai, genai) and Go equivalents are far narrower and lack repairToolCall/structured output parity.
- **Fix:** Keep TS, keep consuming `ai`. Do not move inference into the Rust daemon.
- **Evidence:** llm.ts promptAiSdkStream (nested failover/retry loops). Confidence: high; Rust ecosystem breadth claim could be web-verified.

## [LOW] correctness — sdk/src/impl/llm.ts — Truncated tool-input JSON repair (repairTruncatedToolInputJson): KEEP
- **Risk:** Bounded 64-char repair; O(64*n) worst case on small inputs. Deliberately conservative; generic libs (jsonrepair npm) are more aggressive and would violate the faithfulness guard.
- **Fix:** Keep hand-written TS.
- **Evidence:** llm.ts repairTruncatedToolInputJson. Confidence: high.

## [MEDIUM] performance — sdk/src/impl/llm.ts — Request-time token budgeting (countRequestOverheadTokens, getMessagesForModelContext via countTokensJson): HYBRID (CONSUME native/WASM tokenizer)
- **Risk:** Runs on every attempt over full message history + tool schemas (asSchema conversion per tool). Token counting implementation (agent-runtime token-counter) not read in this shard; if it is a JS BPE or char heuristic, it is both slow and inaccurate per provider.
- **Fix:** Consume a compiled tokenizer: tiktoken (Rust core, WASM/npm binding) or HF `tokenizers`; cache schema token counts per tool definition. Unlocks: accurate provider-specific budgets; next: same counts reused by Python offline stats.
- **Evidence:** llm.ts countToolSurfaceTokens/countOpaqueToolSchemaTokens; token-counter.ts NOT read (unresolved). Cost: one npm dep, small. Confidence: low-medium pending token-counter read.

## [LOW] correctness — sdk/src/impl/llm.ts — BYOK cost accounting + provider context-limit parsing: KEEP
- **Risk:** Simple arithmetic/regex; no fit issue.
- **Fix:** Keep TS.
- **Evidence:** llm.ts computeCostCentsFromUsage, getProviderContextLimitFromError. Confidence: high.

## [LOW] api-contract — sdk/src/impl/agent-runtime.ts — Agent-runtime DI wiring + local-mode DB stubs: KEEP
- **Risk:** Pure wiring of JS functions.
- **Fix:** Keep TS.
- **Evidence:** agent-runtime.ts getAgentRuntimeImpl. Confidence: high.

## [LOW] correctness — sdk/src/impl/failover.ts — Failover model list + eligibility classification: KEEP
- **Risk:** Pure functions; tightly bound to AI SDK error classes (NoOutputGeneratedError).
- **Fix:** Keep TS.
- **Evidence:** failover.ts resolveModelsToTry/isFailoverEligibleError. Confidence: high.

## [LOW] api-contract — sdk/src/impl/model-provider.ts — Model routing, vision fallback, provider compatibility transforms: KEEP
- **Risk:** Produces AI SDK LanguageModel objects; must live next to the AI SDK. Regex name heuristics (vision/non-vision, deepseek/glm quirks) are data that belongs in config, not a language issue. Module-level ChatGPT rate-limit cache is per-process; fine until multi-process daemon.
- **Fix:** Keep TS; move heuristic tables to declarative capability data.
- **Evidence:** model-provider.ts getModelForRequest, getModelVisionSupport, applyConfiguredProviderRequestCompatibility. Confidence: high.

## [MEDIUM] dependency-hygiene — sdk/src/impl/chatgpt-backend-fetch.ts — Chat Completions <-> Responses API SSE translation (ChatGPT backend + OpenCode Go): CONSUME @ai-sdk/openai Responses model
- **Risk:** ~640 hand-written lines re-implement Responses SSE parsing, tool-call index mapping and done-args reconciliation, reused by opencode-go-responses-fetch. Protocol drift is the risk; language is fine (must stay in-process with the AI SDK stream).
- **Fix:** Replace with @ai-sdk/openai `openai.responses(model)` (createOpenAI with custom baseURL/headers/fetch for chatgpt.com/backend-api/codex and opencode Go /responses), keeping only the 404->429 remap and header injection. Unlocks now: upstream-maintained reasoning/tool events; next: native reasoning summaries and built-in tools without translator changes.
- **Evidence:** chatgpt-backend-fetch.ts createSseTransformStream/transformChatGptBackendRequestBody; model-provider.ts createOpenAIOAuthModel. Cost: small-medium; add pinned @ai-sdk/openai. Confidence: medium; NEEDS WEB VERIFICATION that the Responses provider accepts the ChatGPT backend's required instructions/store:false shape.

## [LOW] dependency-hygiene — sdk/src/impl/database.ts — Remote Codebuff API client (user info, agent registry, agent runs): KEEP (largely unused in local mode)
- **Risk:** agent-runtime.ts wires local stubs, so these HTTP functions are only used by other callers; fetchWithRetry duplicates runWithRetryPolicy.
- **Fix:** Keep TS; reuse runWithRetryPolicy; consider deleting if hosted paths are gone.
- **Evidence:** database.ts fetchWithRetry, getUserInfoFromApiKey; agent-runtime.ts localGetUserInfoFromApiKey. Confidence: medium.

## [LOW] performance — sdk/src/impl/embeddings.ts — BYOK embeddings factory: KEEP (remote); local embeddings later CONSUME in Rust index
- **Risk:** Remote embedding calls are I/O-bound; TS is fine.
- **Fix:** Keep TS for remote. When the Rust index adds offline/local embeddings, consume fastembed-rs/ort (ONNX) there rather than authoring. Unlocks: offline semantic search without API keys.
- **Evidence:** embeddings.ts createConfiguredEmbedder. Confidence: medium; fastembed-rs maturity needs verification.

## [MEDIUM] api-contract — sdk/src/provider-config.ts — openbuff.json schema, fragment loader, merge + ancestor trust gate: KEEP TS as single source; export JSON Schema for Rust/Python
- **Risk:** Needs: one authoritative schema across TS runtime, Rust daemon/index (indexing.*, readableRoots), and Python offline (pricing/quality.coding). Re-implementing merge/trust rules in Rust or Python would fork security semantics (ER-1, M1-T3).
- **Fix:** Keep zod in TS; emit z.toJSONSchema(providerConfigFileSchema) as a build artifact; pass RESOLVED config to Rust over the daemon protocol instead of letting Rust parse openbuff.json; Python reads the emitted JSON Schema (pydantic via datamodel-codegen). Unlocks: schema-checked cross-language config; next: config validation in editors.
- **Evidence:** provider-config.ts providerConfigFileSchema, loadProviderConfigSync, stripApiKeyEnvProvidersFromFragment. Cost: small build step. Confidence: high.

## [LOW] performance — sdk/src/provider-config.ts — Provider-config hot-path cache key (sync re-read + stat of every fragment per call): KEEP, fix algorithmically
- **Risk:** collectProviderConfigDependencyPaths re-reads and JSON-parses every config file synchronously on every loadProviderConfigSync call (every LLM request) just to build the cache key. Language-neutral cost.
- **Fix:** Keep TS; use fs.watch-based invalidation or stat-only keys. No move needed.
- **Evidence:** provider-config.ts resolveProviderConfigDependencyPaths/buildProviderConfigCacheKey. Confidence: high.

## [LOW] correctness — sdk/src/provider-config.ts — Provider config writes (writeJsonFilesTransaction/writeJsonFileAtomic) + presets data: KEEP
- **Risk:** Multi-file rename transaction is best-effort, not crash-atomic; same in any language. Presets are data.
- **Fix:** Keep TS; optionally move presets to JSON data files.
- **Evidence:** provider-config.ts writeJsonFilesTransaction, OPENBUFF_PROVIDER_PRESETS. Confidence: high.

## [LOW] correctness — sdk/src/model-discovery.ts — Provider model discovery + cache: KEEP
- **Risk:** Small HTTP + JSON cache; hardcoded ~/.config/openbuff path diverges from getConfigDir().
- **Fix:** Keep TS; use getConfigDir.
- **Evidence:** model-discovery.ts getCachePath. Confidence: high.

## [LOW] correctness — sdk/src/retry-config.ts — Shared retry policy + error classification: KEEP
- **Risk:** Pure logic over JS error shapes (undici codes, AI SDK).
- **Fix:** Keep TS.
- **Evidence:** retry-config.ts runWithRetryPolicy/classifyRetryableError. Confidence: high.

## [LOW] api-contract — sdk/src/serve/serve.ts — Serve transport selection (stdio vs unix socket): KEEP
- **Risk:** Thin wiring.
- **Fix:** Keep TS.
- **Evidence:** serve.ts runServe. Confidence: high.

## [LOW] api-contract — sdk/src/serve/bridge.ts — ACP prompt bridge + MCP origin marking: KEEP (CONSUME @agentclientprotocol/sdk)
- **Risk:** Must sit next to OpenbuffClient.run and the WeakMap origin marks (object identity), which cannot cross a process boundary.
- **Fix:** Keep TS; ACP stdio is the polyglot boundary.
- **Evidence:** bridge.ts createServeBridge, acpMcpServersToConfigRecord. Confidence: high.

## [MEDIUM] correctness — sdk/src/serve/socket-listener.ts — Unix-socket listener with SEC-4 auth: MOVE->Rust when the daemon lands (HYBRID now)
- **Risk:** Needs: OS peer credentials, Windows support, long-lived multiplexing. Node cannot read SO_PEERCRED, so auth is dir-perms + shared token; Windows is refused outright. A Rust listener gets real peer uid/pid checks and named pipes.
- **Fix:** Rust daemon owns the listener: tokio UnixStream::peer_cred (+ getpeereid on macOS), tokio named pipes on Windows; forwards authenticated ACP framing to the TS agent over stdio. Unlocks now: kernel-verified peer identity, Windows serve; next: one daemon multiplexing many clients/sessions and surviving agent crashes.
- **Evidence:** socket-listener.ts serveAcpOverSocket/assertSocketDirSafe (comment: 'node does not expose the peer uid'). Cost: medium; extra hop per message (negligible vs LLM). Confidence: medium; peer_cred platform coverage needs verification.

## [LOW] correctness — sdk/src/serve/outbound-filter.ts — Outbound secret redaction: KEEP (optionally CONSUME gitleaks rule set)
- **Risk:** V8 regex is backtracking, but these patterns are simple single-class runs so linear in practice. Coverage (only 3 key families) is the real gap.
- **Fix:** Keep TS; import a pinned subset of gitleaks/trufflehog regex rules as data.
- **Evidence:** outbound-filter.ts sanitizeOutbound. Confidence: high.

## [LOW] dependency-hygiene — sdk/src/native/ripgrep.ts — ripgrep binary resolution: CONSUME (keep); later link grep crates in Rust index
- **Risk:** Correct consume choice. Resolution chain is duplicated (PATH checked twice) and uses new Function for __dirname.
- **Fix:** Keep consuming rg. When Rust index exists, search can use ripgrep's `grep`/`ignore` crates in-process, removing per-search spawn and the vendored binary matrix.
- **Evidence:** ripgrep.ts getBundledRgPath. Confidence: high.

## [LOW] api-contract — sdk/src/job-update-forwarder.ts — Background job update forwarder: KEEP
- **Risk:** Event projection over in-process registry.
- **Fix:** Keep TS; if job registry moves into the Rust daemon, this becomes a protocol subscriber with the same shape.
- **Evidence:** job-update-forwarder.ts createJobUpdateForwarder. Confidence: high.

## [MEDIUM] dependency-hygiene — sdk/package.json — SDK dependency manifest: KEEP TS deps, pin ranges; WASM deps are consume choices
- **Risk:** Open ranges (^) on ai, @agentclientprotocol/sdk, zod, ws, micromatch, gray-matter, pixelmatch, pngjs in a published SDK; @types/ws in runtime dependencies. quickjs WASM (handleSteps sandbox) and tree-sitter WASM are sound CONSUME choices; tree-sitter WASM becomes redundant once the Rust index parses natively.
- **Fix:** Pin exact versions; move @types/ws to devDependencies; drop web-tree-sitter/@vscode/tree-sitter-wasm after Rust index lands.
- **Evidence:** sdk/package.json dependencies. Cost: trivial. Confidence: high.

## [LOW] api-contract — sdk/package.json — D38 authored-language set (TS + Rust + Python-offline): CONFIRM for sdk-core
- **Risk:** No feature in this shard needs Go, Zig or C/C++: I/O and orchestration fit TS, OS containment/index/socket fit Rust. The bigger lever is CONSUME: ai SDK, ACP SDK, rg, git, tree-sitter grammars, tiktoken, gitleaks rules, @ai-sdk/openai Responses.
- **Fix:** Adopt D38 unchanged for this subsystem; add an explicit 'consume-first' rule plus a zod->JSON Schema contract artifact as the cross-language source of truth.
- **Evidence:** All files in this shard. Confidence: medium-high (limited to sdk-core).

## Coverage receipt

### Subsystems
- sdk

### Features
- run-loop-orchestration
- tool-dispatch-trust-injection
- terminal-approval-policy
- readable-roots-trust-gate
- observation-digest-gates
- status-code-heuristics
- librarian-clone-cleanup
- client-facade
- session-state-project-index
- session-git-context
- env-credential-scrubbing
- llm-stream-retry-failover
- tool-input-json-repair
- request-context-token-budget
- byok-cost-accounting
- agent-runtime-di-wiring
- failover-policy
- model-routing-vision-compat
- responses-api-sse-translation
- remote-api-client
- embeddings-factory
- provider-config-schema-loader
- provider-config-hot-path-cache
- provider-config-transactional-write
- model-discovery
- retry-policy
- serve-transport-selection
- acp-serve-bridge
- unix-socket-auth-listener
- outbound-secret-redaction
- ripgrep-resolution
- job-update-forwarder
- sdk-dependency-manifest
- d38-authored-language-set

### Files
- sdk/src/run.ts
- sdk/src/client.ts
- sdk/src/run-state.ts
- sdk/src/env.ts
- sdk/src/impl/llm.ts
- sdk/src/impl/agent-runtime.ts
- sdk/src/impl/failover.ts
- sdk/src/impl/model-provider.ts
- sdk/src/impl/database.ts
- sdk/src/impl/embeddings.ts
- sdk/src/impl/chatgpt-backend-fetch.ts
- sdk/src/provider-config.ts
- sdk/src/model-discovery.ts
- sdk/src/retry-config.ts
- sdk/src/serve/serve.ts
- sdk/src/serve/bridge.ts
- sdk/src/serve/socket-listener.ts
- sdk/src/serve/outbound-filter.ts
- sdk/src/native/ripgrep.ts
- sdk/src/job-update-forwarder.ts
- sdk/package.json

### Domains
- performance
- dependency-hygiene
- api-contract
- correctness
