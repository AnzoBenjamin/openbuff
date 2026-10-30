# Audit findings: lens-inference-learning

- Subsystems: sdk-llm-request-loop, sdk-provider-routing, sdk-model-discovery, sdk-embeddings, memory-v2, agent-runtime-context-management
- Features: constrained-tool-decoding, local-inference-kv-reuse, learned-router, trace-learning-dspy-lora, memory-rerank-classify, local-compaction, open-weight-tokenizers, failover-confirmation
- Files covered: 19
- Snapshot: 1100aecfb57d2576e054f1182e75c6f694d6f6908577ed90429482adbdb02be8

## [HIGH] correctness — sdk/src/impl/llm.ts — IL-1 Grammar-constrained tool-call decoding would remove the repair layer for local models
- **Risk:** Today tool-call validity depends on the model plus four layers of repair after the fact. The repairs are bounded by design (at most 64 chars, a mismatched bracket fails), so truncated or garbled calls still cost a full extra LLM round trip. Small local models, which are the local-first target, produce malformed JSON most often, and they get no structural guarantee.
- **Fix:** Add an in-process local backend that uses llama.cpp GBNF/JSON-schema grammars or llguidance (Rust, the constraint engine used by llama.cpp and vLLM) or outlines-core (Rust). Compile each agent's Zod tool schemas (already the single source per compile-tool-definitions) into one grammar: a union over tool names, each with its own input schema. Decoding then cannot produce an unknown tool name or invalid JSON. Keep the repair code only for hosted providers. Can TS do it? Mostly yes: node-llama-cpp (TS over llama.cpp) exposes JSON-schema grammars. The real dependency is llama.cpp (C++) plus a native addon either way. Bun compatibility of node-llama-cpp is unverified. Hosted providers cannot be constrained beyond their own json_schema/strict mode.
- **Evidence:** llm.ts repairTruncatedToolInputJson (bounded truncation repair, MAX_TRUNCATION_CHARS=64). The experimental_repairToolCall hook in promptAiSdkStream rewrites NoSuchToolError into spawn_agents and passes InvalidToolInputError back to the agent to retry. direct-agent-tool-repair.ts buildSpawnAgentsInputForDirectAgentCall. common/src/tools/params/utils.ts:74 repairMalformedJsonSeparators. provider-config.ts supportsStructuredOutputs defaults to false, and the ollama preset sets it false. model-provider.ts shouldDowngradeRequiredToolChoiceForProviderModel strips tool_choice:'required' for deepseek/glm by name regex.

## [HIGH] performance — sdk/src/impl/model-provider.ts — IL-2 In-process local engine: KV-cache/prefix reuse across agent steps, KV forking for subagents, speculative decoding
- **Risk:** Local models are reached only as a stateless OpenAI-compatible HTTP endpoint (Ollama preset). Every agent step resends and re-prefills the whole transcript. Subagents spawned from the same parent prefix pay the prefill again. The compaction governor (3 paid passes per turn) exists because context is expensive, and with a persistent local KV cache much of that cost goes away. There is no way to snapshot or restore a session's model state.
- **Fix:** Embed a local engine behind the LanguageModel interface as a new provider type (e.g. 'local-embedded'). Options: llama.cpp through Rust (llama-cpp-2 crate) or node-llama-cpp; mistral.rs (Rust: paged attention, prefix caching, speculative decoding, LoRA hot-swap); MLX (C++/Swift/Python) for Apple Silicon. Keep one context sequence per agent run and append only the delta each step. Fork the KV cache at the spawn point for spawn_agents children. Save/restore slots to disk for instant /resume. Enable a draft model for speculative decoding. Can TS do it? Partially: node-llama-cpp has context sequences and session save. Paged or prefix-shared multi-sequence scheduling and MLX need Rust/C++/Swift.
- **Evidence:** provider-config.ts OPENBUFF_PROVIDER_PRESETS.ollama uses baseURL http://localhost:11434/v1 over HTTP only. model-provider.ts getModelForRequest builds only OpenAICompatibleChatLanguageModel or createAnthropic clients, with no in-process engine. llm.ts promptAiSdkStream calls convertCbToModelMessages over the full params.messages on every attempt. Prompt caching exists only as provider cache_control, and stripCacheControl defaults to true (DEFAULT_PROVIDER_COMPATIBILITY). context-pruning.ts SEMANTIC_MAX_PASSES_PER_TURN=3 and SEMANTIC_COOLDOWN_ITERATIONS=3 are cost governors.

## [HIGH] correctness — sdk/src/model-provider.ts — IL-3 Model/effort selection per step is regex heuristics, not a learned local router
- **Risk:** Reasoning effort is chosen by regex on the agent id. Vision capability is guessed from model-name regexes. Empirical quality data (quality.coding) is manual and opt-in, and never feeds routing. Failover reacts only to HTTP status. The agent cannot learn that model X fails on task type Y in this repo, which works against the 'efficient learning agent' goal.
- **Fix:** Train a small classifier/router on step features: agent role, tool history, language, and prompt embedding. Labels come from observed outcomes (success, retries, repair events, user acceptance, cost). Training in Python (RouteLLM-style matrix factorization or BERT classifier, scikit-learn/PyTorch), exported to ONNX. Inference in-process via ort (Rust) or onnxruntime-node. The output is a recommendation surfaced like /models recommend, keeping the documented rule that explicit routing is never silently overridden. Can TS do it? Inference yes (onnxruntime-node/transformers.js). Training realistically no; that part is Python.
- **Evidence:** sdk/src/impl/model-provider.ts selectAdaptiveReasoningEffort uses regexes over agentId (/thinker|debugger|reviewer|plan.../ goes to high). isLikelyVisionModelName and isLikelyNonVisionModelName use name regexes. getVisionFallbackRank is a hardcoded opus>sonnet>gpt-5 ordering. provider-config.ts recommendConfiguredModel reads static quality.coding and 'deliberately does not participate in resolveConfiguredAgentModelConfig'. failover.ts isFailoverEligibleError is status-code only.

## [HIGH] state-mutation — sdk/src/services/memory-v2/usage-observer.ts — IL-4 No learning loop from session traces: prompt optimization (DSPy/GEPA) and LoRA adaptation need Python
- **Risk:** Memory-v2 records observations, usage, and usefulness, but that data only feeds retrieval. Prompts, tool descriptions, and model weights never improve from outcomes. For a project whose stated goal is 'an efficient learning agent', the learning is limited to what fits in the context window.
- **Fix:** Add an offline 'openbuff learn' sidecar in Python. It exports memory-v2 events and transcripts, accepted diffs, and repair/retry events as a dataset. Step 1: DSPy/GEPA optimization of agent instructions and tool descriptions against evals/ (buffbench, compaction-fidelity), output as versioned prompt overlays. Step 2: for local models, a LoRA/QLoRA fine-tune with unsloth/PEFT/TRL or mlx-lm on successful trajectories, loaded per project via llama.cpp/mistral.rs LoRA hot-swap. Distribution: optional uv-managed env, never required on the hot path. Can TS do it? No; there is no credible TS ecosystem for either. Risks: privacy (traces stay local, consistent with BYOK), eval overfitting, and a Python toolchain dependency.
- **Evidence:** sdk/src/services/memory-v2/usage-observer.ts correlateUsage and cli/src/services/memory-v2/usefulness-scorer.ts (re-exports common/src/util/usefulness-scorer) score memory usage but only for retrieval. provider-config.ts has static agent prompts and routing with no prompt-overlay or adapter field. modelCapabilitiesSchema.quality.coding (sampleSize, benchmark) is filled by hand. docs/goal.md: 'Make an efficient learning agent that can do anything.'

## [MEDIUM] correctness — cli/src/services/memory-v2/concept-index.ts — IL-5 Memory recall lacks a reranker; observation classification and consolidation search are keyword heuristics
- **Risk:** Concept recall (1) brute-forces cosine over JSON-serialized vectors, (2) has no cross-encoder reranking, so precision on near-duplicate observations is poor, (3) assigns decision/constraint/fact by keyword signals, and (4) searches consolidations by lowercase substring OR-match. Wrong or stale memories get injected with nothing to catch contradictions.
- **Fix:** Local models in-process through ort or fastembed-rs (Rust): bge-reranker or ms-marco-MiniLM for reranking top-k; a small NLI or zero-shot classifier (DeBERTa-v3) for observation kind and contradiction/staleness detection between new and stored claims, which would feed the operator-service revalidate/correct flow. This is a new angle beyond the prior report's sqlite-vec item. Can TS do it? Yes, with transformers.js/onnxruntime-node at lower throughput. The Rust gain is batching and CPU/GPU execution providers, not capability.
- **Evidence:** cli/src/services/memory-v2/concept-index.ts:40 cosineSimilarity is used at :309 and :335 over every cached vector, and :302-330 store vectors as JSON.stringify(vector). sdk/src/services/memory-v2/coordinator.ts:219 classifyObservationKind uses valuesContainDecisionSignal/valuesContainConstraintSignal. packages/agent-runtime/src/util/context-consolidation.ts searchConsolidations uses 'terms.filter((t) => lowered.includes(t))'.

## [MEDIUM] performance — packages/agent-runtime/src/util/context-pruning.ts — IL-6 Compaction is rationed because it costs a remote LLM call; local compression would make it continuous
- **Risk:** The semantic pass is governed as a scarce resource (cooldown, rearm, 3 passes per turn), so between passes only deterministic eviction and the mechanical trim respond, and the trim drops content wholesale. Background consolidation is canary-gated OFF and uses a remote prompt-only child.
- **Fix:** Run compaction locally: LLMLingua-2 (a BERT-size token-keep classifier, Python-trained, runnable via ONNX/ort) for extractive compression of tool results, plus a small local summarizer (Qwen-1.5B-class through the IL-2 engine) for consolidation. With near-zero marginal cost, consolidation can run after every step and the governor can loosen for local runs. Can TS do it? Inference via transformers.js yes. The summarizer needs the IL-2 native engine.
- **Evidence:** context-pruning.ts: SEMANTIC_MAX_PASSES_PER_TURN=3, SEMANTIC_COOLDOWN_ITERATIONS=3, and the governor doc 'makes the expensive pass rare by construction'. context-consolidation.ts header: 'PROTOTYPE ... canary-gated OFF by default', CONSOLIDATION_PROMPT_CHARS=24_000, MAX_CONSOLIDATIONS=8.

## [MEDIUM] correctness — packages/agent-runtime/src/util/token-counter.ts — IL-7 Open-weight models (all opencode-go/ollama routes) fall to an uncorrected gpt-4o estimate
- **Risk:** This is a different angle from the prior tiktoken item: tiktoken does not cover Qwen/GLM/DeepSeek/Kimi/MiniMax, the default preset family. Their model strings hit the 1.0 default, so budgets can be off by roughly 10-30% on exactly the providers with small windows. Also, countTokens with no model defaults to the Anthropic 1.35 sentinel regardless of the routed model.
- **Fix:** Use HF tokenizers (Rust crate, the reference implementation) to load each model's tokenizer.json, fetched with discovery and cached next to model-discovery-cache.json, for exact counts on open-weight models. An embedded local engine (IL-2) exposes its exact tokenizer for free. Can TS do it? Yes: @huggingface/transformers ships a JS tokenizer that reads tokenizer.json, slower but correct. Rust is optional here.
- **Evidence:** token-counter.ts fudgeFactorForModel matches only claude/anthropic, gemini/google, gpt-/openai, and everything else gets 1.0. ANTHROPIC_TOKEN_FUDGE_FACTOR_MARKED_MODEL='anthropic/claude' is the no-model default. provider-config.ts OPENCODE_GO_CHAT_MODELS lists glm/kimi/deepseek/mimo and none match a family.

## [LOW] api-contract — sdk/src/impl/failover.ts — IL-8 Confirmation: provider/failover/discovery layer should stay TypeScript
- **Risk:** This closes the prior report's follow-up. failover.ts, model-discovery.ts, and the request loop in llm.ts are I/O-bound, pure policy, and pinned by tests (failover.test.ts, failover-integration.test.ts). No other language adds a feature here. The feature gaps are health-aware routing (latency/error EWMA, 429-aware provider scoring) and cost-aware cascades, and both are straightforward in TS.
- **Fix:** Keep in TS. If desired, add EWMA provider health scoring, feeding IL-3 features, next to FAILOVER_ELIGIBLE_STATUS_CODES without changing the documented failover contract (401/403/5xx, no-content-yielded gate).
- **Evidence:** failover.ts resolveModelsToTry and isFailoverEligibleError are pure functions. model-discovery.ts is fetch + JSON path normalization. llm.ts retry/failover loop uses runWithRetryPolicy and computeBackoffDelayMs.

## Coverage receipt

### Subsystems
- sdk-llm-request-loop
- sdk-provider-routing
- sdk-model-discovery
- sdk-embeddings
- memory-v2
- agent-runtime-context-management

### Features
- constrained-tool-decoding
- local-inference-kv-reuse
- learned-router
- trace-learning-dspy-lora
- memory-rerank-classify
- local-compaction
- open-weight-tokenizers
- failover-confirmation

### Files
- sdk/src/impl/llm.ts
- sdk/src/impl/model-provider.ts
- sdk/src/impl/failover.ts
- sdk/src/impl/embeddings.ts
- sdk/src/impl/direct-agent-tool-repair.ts
- sdk/src/provider-config.ts
- sdk/src/model-discovery.ts
- packages/agent-runtime/src/util/context-pruning.ts
- packages/agent-runtime/src/util/context-consolidation.ts
- packages/agent-runtime/src/util/token-counter.ts
- cli/src/services/memory-v2/concept-index.ts
- cli/src/services/memory-v2/usefulness-scorer.ts
- sdk/src/services/memory-v2/coordinator.ts
- sdk/src/services/memory-v2/usage-observer.ts
- common/src/tools/params/utils.ts
- packages/internal/src/openai-compatible/chat/openai-compatible-chat-language-model.ts
- docs/goal.md
- docs/local-mode.md
- .agents/sessions/audit-polyglot-2026-09/AUDIT-REPORT.md

### Domains
- correctness
- performance
- state-mutation
- api-contract
- dependency-hygiene
