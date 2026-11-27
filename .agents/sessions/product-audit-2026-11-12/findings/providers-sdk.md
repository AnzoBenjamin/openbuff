# Shard `providers-sdk`: providers, routing, retry/failover, cost, SDK surface

Audit date 2026-11-12, read-only. Line numbers are at HEAD (`f5aba489d` plus the uncommitted working tree that existed at audit start).

Probe method: four throwaway scripts lived in `/tmp/ob-probe/`, outside the repo. Each started a local `Bun.serve` fake provider and drove the real `promptAiSdkStream` (`sdk/src/impl/llm.ts:1136`) against a temporary `openbuff.json` (passed via `OPENBUFF_PROVIDER_CONFIG`). Nothing was written into the repository. `git status` was identical before and after.

## Scope

Inspected:
- `sdk/src/impl/llm.ts`, `model-provider.ts`, `failover.ts`, `chatgpt-backend-fetch.ts`, `opencode-go-responses-fetch.ts`, `agent-runtime.ts`, `database.ts`
- `sdk/src/provider-config.ts` (schemas 40-360, presets 2440-2770, include loader 850-1040), `model-discovery.ts`, `credentials.ts`, `credential-env-keys.ts`, `host-config.ts`, `retry-config.ts`, `error-utils.ts`, `index.ts`, `client.ts`, `run.ts` (options 360-470, auth gate 2361-2405)
- `packages/agent-runtime/src/llm-api/` (`claude.ts`, `gemini-with-fallbacks.ts`, `context7-api.ts` skimmed), `find-files/request-files-prompt.ts`, `prompt-agent-stream.ts`, `util/context-pruning.ts`
- `common/src/util/messages.ts` (cache anchors), `common/src/constants/model-config.ts`
- `node_modules/@ai-sdk/anthropic@2.0.50` (cache_control and usage mapping)
- CLI: `components/provider-picker-screen.tsx`, `components/model-route-picker.tsx`, `utils/status-bar-chips.ts`, `chat.tsx` (cost state), `utils/sdk-event-handlers.ts` (provider_status), `utils/openbuff-provider.ts` (`/provider` commands), `utils/error-messages.ts`
- Docs: `docs/local-mode.md`, `docs/request-flow.md`, `docs/openbuff-provider-model-setup-ux.md`, `docs/authentication.md`, `openbuff.json.example`, `sdk/README.md`, `sdk/examples/readme-example-{1,2}.ts`
- Prior work: `body-capability-review-2026-11-05/findings/02-providers.md` (02-F1–F7), PLAN cards B08/B09, `docs/execution/body-roadmap/STATE.md` (B08 accepted), and this audit's `findings/cli-ux.md` (cli-ux-01, cli-ux-06) and `findings/orchestration.md` (orchestration-02).

Skipped:
- `packages/internal/src/openai-compatible/**` adapter internals beyond the `includeUsage` path, which prior 02-F3 already covers.
- `context7-api.ts` (docs lookup, not a provider).
- Live calls to real providers, because the audit has no keys and is offline.
- OAuth refresh flows (02-F6 was not re-probed).

## Feature inventory

| feature | entrypoint | implementation | tests | maturity |
|---|---|---|---|---|
| OpenAI-compatible provider | `openbuff.json` `type: openai-compatible` | `provider-config.ts:251-278`, `model-provider.ts:686` | `model-provider.test.ts`, `provider-contract-regressions.test.ts` | useful |
| Anthropic Messages provider | `type: anthropic-compatible` | `provider-config.ts:310-350`, `model-provider.ts:885-915` | `model-provider.test.ts` | partial (no caching, no thinking; see 01 and 04) |
| ChatGPT/Codex subscription OAuth | `/provider connect codex` | `chatgpt-backend-fetch.ts`, `credentials.ts` | `chatgpt-backend-fetch.test.ts`, `llm-chatgpt-oauth-policy.test.ts` | useful |
| OpenCode Go (chat + responses) | `/setup opencode-go` | `opencode-go-responses-fetch.ts`, preset `provider-config.ts:2452-2496` | `opencode-go-responses-fetch.test.ts` | useful |
| Presets (9) | `/setup <id>`, provider picker | `provider-config.ts:2451-2702`, `provider-picker-screen.tsx:63-140` | `provider-config.test.ts` | partial (stale; see 07) |
| Native Gemini / Vertex / Azure / Bedrock SigV4 / Copilot / Claude subscription | — | — | — | absent |
| Model discovery | `/provider models <id> --refresh` | `model-discovery.ts:313-370` | `model-provider.test.ts` | partial (capabilities discarded; see 03 and 05) |
| Per-mode / per-agent routing and reasoning | `/models` picker, `openbuff.json` | `model-route-picker.tsx`, `resolveConfiguredAgentModelConfig` | `model-provider.test.ts` | useful |
| Reasoning effort on the wire | route `reasoningEffort` | `llm.ts:1058-1076` | `provider-contract-regressions.test.ts` | partial (OpenAI only; see 04) |
| Prompt caching | automatic | `common/src/util/messages.ts:682-707`, gated at `llm.ts:1412-1413` | none on the streaming path | unwired on the main path (01) |
| Retry with Retry-After | automatic | `retry-config.ts:407-450, 499-535`; streaming `llm.ts:2046-2092` | `retry-config.test.ts` | partial (529, 8 s cap; see 02 and 09) |
| Failover chain | `failoverModels` | `failover.ts`, `llm.ts:2096-2138` | `failover.test.ts`, `failover-integration.test.ts` | useful; visibility weak (08) |
| Adaptive trim on provider context-limit error | automatic | `llm.ts:982-1015, 2002-2031` | `llm-context-window.test.ts`, `llm-ontrim-retry.test.ts` | useful |
| Text-tool fallback for no-tool providers | `compatibility.supportsTools:false` | `llm.ts:1374-1397` | `llm-tool-call-buffer.test.ts:210` | useful |
| Cost accounting | `onCostCalculated` → status-bar chip | `llm.ts:300-344, 1922-1960`; chip `status-bar-chips.ts:624-630`; state `chat.tsx:611,754` | `llm-cost.test.ts`, `status-bar-chips.test.ts` | partial / mostly blank (03) |
| SDK `run()` / `OpenbuffClient` | `@openbuff/sdk` | `run.ts`, `client.ts` | many | useful, hard to adopt (11) |
| SDK as ACP server / MCP server | `runServe`, `runMcp` | `index.ts:184-237` | yes | useful |

## Findings

### providers-sdk-01 · HIGH · The main agent stream never sends prompt-cache markers, for any provider
- **Axis:** usability (cost and latency), reliability (the docs and code claim something else).
- **Evidence:**
  - The streaming request builder passes `includeCacheControl: isChatGptOAuth && compatibility.stripCacheControl === false` (`sdk/src/impl/llm.ts:1412-1413`). It ignores the caller's `includeCacheControl` and ignores the provider type. Anthropic-compatible and OpenAI-compatible routes therefore always get `false`. The ChatGPT OAuth schema also defaults `stripCacheControl: true` (`provider-config.ts:283`, using the `providerCompatibilitySchema` default at `:94`), so in practice no route gets markers.
  - The non-streaming and structured paths use the right condition (`llm.ts:2220`, `:2384`). Only the agent loop, which carries almost all tokens, is wrong. The line dates from `e0686cd80` and was carried through `b1b91e9c2`.
  - The runtime computes `includeCacheControl: supportsCacheControl(...)` (`packages/agent-runtime/src/run-agent-step.ts:1087`) with a comment saying llm.ts overrides it.
  - The cache anchors exist and would work. `convertCbToModelMessages` places up to three `cache_control` anchors (`common/src/util/messages.ts:682-707`, `withCacheControl` `:43-66`). `@ai-sdk/anthropic@2.0.50` accepts both `cacheControl` and `cache_control` (`node_modules/@ai-sdk/anthropic/dist/index.mjs:613`).
  - **Probe** (`/tmp/ob-probe/cache-probe.ts`, real `promptAiSdkStream`, `includeCacheControl: true`): an anthropic-compatible request body had **0** occurrences of `cache_control`. An openai-compatible body also had 0.
  - The Anthropic preset says "Enables real prompt caching" (`provider-config.ts:2678`), and `DEFAULT_ANTHROPIC_COMPATIBILITY` says it "turns on prompt caching" (`:77-88`). Both are untrue for the agent loop.
  - The OpenRouter preset (`provider-config.ts:2548-2573`) inherits `stripCacheControl: true` (`:69`). That alone would block OpenRouter→Claude caching. The `llm.ts:1412` gate blocks it even if a user sets `stripCacheControl: false`.
  - The ChatGPT backend request has no `prompt_cache_key` (`chatgpt-backend-fetch.ts:190-215`). Codex CLI sends one per conversation to get backend cache affinity, so subscription users also lose cache locality. This point is lower confidence because the Codex detail comes from knowledge of codex-rs, not a probe.
- **Who is affected:** OpenAI direct and OpenRouter→OpenAI/Gemini still get the providers' *automatic* prefix caching. Direct Anthropic, OpenRouter→Anthropic, OpenCode Go anthropic models and the Bedrock "mantle" Claude route get no caching.
- **Cost impact** (estimate from list prices, not a measurement):
  - Inputs: base2 sends about 47k static tokens per step (orchestration-02: 21,938 tools + 11,006 system + 1,822 instructions + 751 step + 11,442 catalog). Claude Sonnet 4.5 costs $3/M input, $3.75/M for 5-minute cache writes and $0.30/M for cache reads.
  - Static prefix only: $0.141 per step uncached vs $0.014 cached, a 90% saving.
  - A 30-step task whose history grows linearly from 0 to 120k tokens (about 4k new tokens per step):
    - Uncached input is 30 × (47k + 60k avg) ≈ 3.21M tokens, which costs **≈ $9.60**.
    - Cached input is ≈ 0.17M written ($0.63) plus ≈ 3.04M read ($0.91), which costs **≈ $1.55**.
  - So input cost is **about 6× higher**: roughly $8 extra per task on Sonnet, and about $13 on Opus 4.5 ($5/M input). Subagents add their own prompts on top. Time-to-first-token also loses the cache speedup.
- **Fix:**
  - Use `includeCacheControl: compatibility.stripCacheControl === false` on the streaming path, the same condition as `llm.ts:2220`.
  - Give the OpenRouter preset `stripCacheControl: false`, or special-case `anthropic/*` models on openrouter.ai.
  - Add `prompt_cache_key` (session id) to the ChatGPT backend body.
  - Add a wire test asserting `cache_control` on an anthropic-compatible stream, which is the probe above.
  - Show cache-hit % per turn; `cacheHitRate` already exists at `cli/src/types/chat.ts:728`.
- **Prior review:** new. 02-F3 covers accounting, not request caching.

### providers-sdk-02 · HIGH · Anthropic "overloaded" (HTTP 529) fails the turn immediately, with no retry and no failover
- **Axis:** reliability.
- **Evidence:**
  - `RETRYABLE_STATUS_CODES = {408, 429, 500, 502, 503, 504}` (`sdk/src/error-utils.ts:52`).
  - `classifyRetryableError` returns `{retryable:false}` for any other explicit status (`retry-config.ts:526-528`).
  - `FAILOVER_ELIGIBLE_STATUS_CODES = {401, 403, 500, 502, 503, 504}` (`failover.ts:39-41`).
  - Anthropic signals overload with 529 `overloaded_error`. The transient-message patterns (`retry-config.ts:355-368`) do not include "overloaded".
  - **Probe** (`/tmp/ob-probe/overload-probe.ts`): a 529 followed by a healthy response gave `FAILED after 1 requests: AI_APICallError Overloaded statusCode=529`. The same script with 503 retried once and succeeded (`attempt 2/4`, `recovered`).
- **Impact:** Anthropic overload is common at peak times. Every overload kills the turn, even when a backup model is configured. Claude Code retries overloaded errors with backoff (A§1.7 notes retries with backoff on overload for WebFetch, and the main loop does the same).
- **Fix:** add 529 to both sets. Treat a 200-status SSE `overloaded_error` the same way, and test that path too.
- **Prior review:** new. B08 (accepted) unified the policy but its fixture uses 503 only.

### providers-sdk-03 · HIGH · Cost tracking is blank for most BYOK users, and wrong where it does run
- **Axis:** completeness, reliability.
- **Evidence:**
  - There is no built-in price table. Cost needs `modelCapabilities.pricing` (`llm.ts:276-344`) or OpenRouter cost metadata. None of the 9 presets ship pricing or `modelCapabilities` (`provider-config.ts:2451-2702`).
  - **02-F3 is still present.** Both the provider-cost and configured-pricing paths sit inside `!compatibility.stripProviderMetadata` (`llm.ts:1922`), and that flag defaults to true for OpenAI-compatible routes (`provider-config.ts:74`). **Probe:** an openai-compatible route with pricing $3/$15 per M and 20k/10k usage produced **no** cost callback. The same route as anthropic-compatible produced 21 cents.
  - OpenRouter's cost is read from `providerMetadata.codebuff.usage` (`llm.ts:1932-1938`, `:2283`, `:2451`), a legacy hosted-Codebuff namespace. The OpenRouter preset is a plain openai-compatible provider, so this cost source is unreachable. The prior review rated this "openrouter-specific-accounting: unwired".
  - Discovery parses OpenRouter `pricing` and `context_length` (`model-discovery.ts:207-238`), but `addDiscoveredModelToProviderConfig` only adds the id (`:444-488`). Nothing else reads the discovery cache for capabilities: `readModelDiscoveryCache` is used only for listing (`cli/src/utils/openbuff-provider.ts:956-967`).
  - Each request is rounded to whole cents (`llm.ts:342`, `:273`). A 0.4¢ subagent or Haiku step records 0¢, so many small steps are under-counted. B09 asks for high internal precision.
  - Latent Anthropic undercount: the AI SDK maps `inputTokens = input_tokens` and `cachedInputTokens = cache_read_input_tokens` (`@ai-sdk/anthropic` `index.mjs:2770-2775`). Anthropic's `input_tokens` *excludes* cache reads and writes, yet `computeCostCentsFromUsage` subtracts cached from input (`llm.ts:325-326`) and never charges `cacheCreationInputTokens`. Once 01 is fixed, Anthropic cost will be under-reported.
  - Display: the chip hides at 0 (`cli/src/utils/status-bar-chips.ts:624-630`, already covered by cli-ux-06), so these gaps show up as "free".
- **Impact:** BYOK users pay real money and get no cost view. Pi, Aider and OpenCode ship price-aware registries (B§3.6 "model registry generated from OpenRouter and models.dev with costs", B§2.6 per-message cost, B§1.6 `opencode stats`).
- **Fix:**
  - Ship a models.dev-derived capability table (window, output cap, pricing including cache read/write, reasoning support) as defaults under user config.
  - Persist discovered capabilities when adding a model.
  - Move accounting out from under `stripProviderMetadata`.
  - Read OpenRouter `usage.cost` from the real provider namespace and request `usage:{include:true}`.
  - Keep sub-cent precision.
  - Use per-provider token semantics.
- **Prior review:** 02-F3 (still present at `llm.ts:1922`), card B09 (not accepted). Display side: cli-ux-06.

### providers-sdk-04 · MEDIUM · Reasoning effort does nothing on Claude routes, and the subscription route silently defaults to "low"
- **Axis:** completeness, cohesion.
- **Evidence:**
  - `withConfiguredReasoningEffort` writes only the `openai-compatible` and `openai` namespaces (`llm.ts:1058-1076`). Nothing maps effort to Anthropic `thinking` / `budget_tokens`. The only `thinking` reference disables it for DeepSeek (`model-provider.ts:980`).
  - **Probe** (`/tmp/ob-probe/effort-probe.ts`, `defaultReasoningEffort: 'high'`): the anthropic-compatible body keys were `model, max_tokens, system, messages, stream`, with **no `thinking`**. The openai-compatible body had `reasoning_effort: "high"`, which confirms 02-F5 is fixed for OpenAI-compatible IDs.
  - `createProviderPresetConfig` seeds `high` effort for 15 agents (`provider-config.ts:2716-2760`). On the Anthropic preset those settings are silently ignored.
  - The `/models` picker offers High/Medium/Low/None for every model (`cli/src/components/model-route-picker.tsx:60-92`) with no "unsupported" state.
  - The ChatGPT backend uses `effort: reasoningEffort || 'low'` (`chatgpt-backend-fetch.ts:207-210`). base2 is not in the seeded list, so the main agent on `codex/gpt-5.5` runs at low effort unless configured. Codex CLI's default is medium.
- **Fix:**
  - Map effort to Anthropic `thinking` with a per-model budget, and pass the thinking budget through `max_tokens`.
  - Grey out unsupported efforts in the picker.
  - Default the subscription route to medium.
- **Prior review:** 02-F5 (fixed for openai-compatible by B08). The Anthropic mapping is new.

### providers-sdk-05 · MEDIUM · Context windows are unknown for every preset; local models overflow silently
- **Axis:** reliability, usability.
- **Evidence:**
  - No preset declares `context.windowTokens` (`provider-config.ts:2451-2702`). An unknown window falls back to `DEFAULT_MAX_CONTEXT_TOKENS = 190_000` (`packages/agent-runtime/src/util/context-pruning.ts:23,160,305`).
  - The Ollama preset defaults to `qwen2.5-coder:32b` (`provider-config.ts:2574-2595`). That model has a 32k native window, and Ollama serves a smaller `num_ctx` unless it is configured through a Modelfile or `OLLAMA_CONTEXT_LENGTH`. The about 47k static base2 prompt (orchestration-02) cannot fit.
  - Ollama truncates over-long prompts without an error. The docs admit this (`docs/local-mode.md:325-331`) and advise "set `num_ctx` explicitly on Ollama", but the Ollama OpenAI-compatible `/v1` endpoint used here takes no per-request `num_ctx`.
  - The adaptive trim only triggers on provider error text (`llm.ts:982-1015`), so the silent truncation is never caught.
  - The reverse problem also exists: GPT-5.5 and Gemini-class windows (≥400k) are capped at 190k.
  - Discovery throws away the OpenRouter `context_length` it already fetched (see 03).
- **Impact:** a first-run local user gets a model that never sees most of its instructions. That produces the "degeneration" symptoms that local-mode.md spends 80 lines on.
- **Fix:**
  - Ship windows in the capability table (03).
  - For Ollama, read `/api/show` `model_info.*.context_length` and warn when the static prompt exceeds the window.
  - Change the Ollama preset to a current tool-calling coder model with documented `num_ctx` setup.
  - Fail loudly when static prompt tokens exceed the window.
- **Prior review:** prior "context-limit-adaptation: partial". Not covered by a card.

### providers-sdk-06 · MEDIUM · Provider coverage is three wire types, with no subscription logins beyond ChatGPT and no custom headers
- **Axis:** completeness.
- **Evidence:**
  - The only provider types are `openai-compatible`, `chatgpt-oauth` and `anthropic-compatible` (`provider-config.ts:251-356`).
  - The schemas have no `headers` field (`:251-268`, `:310-338`). Endpoints that need non-Bearer auth or extra headers cannot be configured. Examples are Azure OpenAI `api-key`, Cloudflare AI Gateway, Portkey and Helicone.
  - There is no SigV4 Bedrock (only the "mantle" bearer endpoint), no Vertex, no native Gemini, no GitHub Copilot and no Claude Pro/Max login.
  - `CREDENTIAL_ENV_KEYS` captures `GEMINI_API_KEY`, `GOOGLE_API_KEY`, `DEEPSEEK_API_KEY`, `GROQ_API_KEY`, `MISTRAL_API_KEY`, `TOGETHER_API_KEY`, `FIREWORKS_API_KEY` and `XAI_API_KEY` (`credential-env-keys.ts:39-46`). None of them has a preset, and nothing auto-detects an exported key. The picker lists only the 9 presets (`provider-picker-screen.tsx:63-140`).
- **Competitors:**
  - Pi has `/login` for Claude Pro/Max, ChatGPT and Copilot, built-in Anthropic/OpenAI/Google/xAI/Groq/Cerebras/OpenRouter, mid-session `/model` with cross-provider context handoff, and a registry generated from OpenRouter plus models.dev (B§3.6).
  - OpenCode has many built-in providers via `/connect` and created the models.dev registry (B§1.6).
  - Codex CLI has `model_providers.<id>` with command-backed bearer tokens, built-in Bedrock and Vertex, and `--oss` for Ollama and LM Studio (A§2.6).
  - Claude Code has Anthropic, Bedrock, Vertex and Foundry, plus `ANTHROPIC_BASE_URL` gateways (A§1.6).
- **Fix:**
  - Add a `headers` / `envHeaders` map.
  - Add presets for Gemini (OpenAI-compatible endpoint), xAI, Groq, DeepSeek, Mistral, LM Studio, llama.cpp and vLLM.
  - Auto-offer a preset when a matching key is exported (this ties into cli-ux-01).
  - Consider Copilot. Consider Claude subscription login only after checking Anthropic's terms for third-party use.
- **Prior review:** prior "native-gemini-protocol: absent". Onboarding is covered by cli-ux-01; key auto-detection is new.

### providers-sdk-07 · MEDIUM · Presets are stale and internally inconsistent
- **Axis:** usability, cohesion.
- **Evidence:**
  - OpenRouter defaults to `anthropic/claude-sonnet-4.5` with `claude-opus-4.1` and `openai/gpt-4.1-mini` (`provider-config.ts:2548-2573`).
  - The Anthropic preset defaults to `claude-sonnet-4-5` and lists opus-4-1 and sonnet-4-0 (`:2674-2702`). The Bedrock preset in the same file lists `claude-opus-4-8` and `claude-sonnet-4-6` (`:2635-2643`), and the docs map to `claude-opus-4.7` (`docs/local-mode.md:233`).
  - Bedrock hardcodes the `ap-northeast-1` mantle URL and `apac.*` profiles, but also lists `us.amazon.nova-*` and `us.meta.llama3-3-*` (`:2632-2646`). US cross-region profiles are not invocable from an APAC regional endpoint.
  - GLM defaults to `glm-4.6` (`:2596-2618`), while the OpenCode Go preset already ships GLM 5.x.
  - Ollama defaults to `qwen2.5-coder` (`:2574-2595`).
  - The example agent model `google/gemini-3.1-flash-lite-preview` (`sdk/examples/readme-example-2.ts:18`) has no matching preset.
- **Fix:**
  - Generate preset model lists from the capability table, or fetch them at `/setup` time.
  - Make the Bedrock region a parameter and derive the profile prefix from it.
  - Add a CI check that preset defaults appear in the table.
- **Prior review:** new.

### providers-sdk-08 · MEDIUM · Failover on 401/403 is close to silent and is repeated on every request
- **Axis:** usability, reliability.
- **Evidence:**
  - 401/403 are failover-eligible (`failover.ts:39-41`). The loop emits `provider_status {status:'failover', model, nextModel, statusCode}` (`llm.ts:2132-2137`).
  - The CLI renders `Provider failover: A → B.` *without* the status code (`cli/src/utils/sdk-event-handlers.ts:2327-2329`).
  - Status blocks coalesce: "each event replaces the previous status block" (`:2333-2350`). The following `recovered` event (`llm.ts:1972-1980`) therefore overwrites the failover line with "Provider connection recovered."
  - The retry budget is per request (`llm.ts:1229-1236`) and there is no sticky circuit breaker for configured routes. The rate-limit cache exists only for implicit OAuth (`model-provider.ts:379`). Every later request pays a 401 round trip to the dead primary first.
  - The model chip continues to show the configured primary.
  - Without failover, a 401 shows "Authentication failed. Please check your API key." (`cli/src/utils/error-messages.ts:15-17`). That message names neither the provider nor the env var.
- **Impact:** a revoked or expired primary key silently moves all traffic, and the bill, to the backup model, possibly a different vendor or price tier. The user is never told which key to fix.
- **Fix:**
  - Keep a persistent warning in the chat history: "openrouter returned 401 (OPENROUTER_API_KEY); using anthropic/… for this session".
  - Demote a 401/403 primary for the session.
  - Include the provider id and `apiKeyEnv` in the auth error text.
  - Update the model chip to show the effective model.
- **Prior review:** new. B08 covered attempt-ledger truth, not user-facing disclosure.

### providers-sdk-09 · MEDIUM · Retry-After is capped at 8 s, so rate-limited turns retry too early and then fail
- **Axis:** reliability.
- **Evidence:**
  - `RETRY_BACKOFF_MAX_DELAY_MS = 8000` (`retry-config.ts:49`) also caps Retry-After (`:436-438`, `retryAfterMaxDelayMs ?? maxDelayMs` at `:522`).
  - `MAX_RETRIES_PER_MESSAGE = 3` (`:37`), so the total wait before failing is about 24 s.
  - 429 is deliberately not failover-eligible (`failover.ts:34-36`).
  - Server-indicated waits of 30–60 s on tier-limited Anthropic and OpenAI keys therefore produce three requests that are guaranteed to fail, then a terminal error.
- **Fix:**
  - Honour Retry-After up to roughly 60–120 s for 429, showing a visible countdown. The status line already shows `in Xs` (`sdk-event-handlers.ts:2326`).
  - Optionally allow `failoverOn429: true` per route.
- **Prior review:** B08's fixture deliberately caps Retry-After at 250 ms for tests. The production cap is not covered.

### providers-sdk-10 · MEDIUM · Local endpoint URL rules block common local setups; `[::1]` never matches
- **Axis:** usability, correctness.
- **Evidence:**
  - `isLocalHttpUrl` allows `http:` only for `['localhost','127.0.0.1','::1']` (`provider-config.ts:233-238`). WHATWG `URL.hostname` for `http://[::1]:11434` is `"[::1]"` (verified with `bun -e`), so IPv6 loopback is always rejected.
  - LAN GPU boxes (`http://192.168.x.x:11434`), `host.docker.internal`, Tailscale hosts and WSL→Windows Ollama are rejected outright (`:274-278`, `:346-350`).
  - `apiKeyEnv` requires `https` (`:268-272`, `:340-344`). A localhost vLLM or llama.cpp server started with `--api-key` cannot be configured with its key.
- **Fix:**
  - Compare against `[::1]`.
  - Allow private-range and `.local`/tailnet http behind an explicit `allowInsecureHttp: true` per provider.
  - Allow keys over loopback http.
- **Prior review:** new.

### providers-sdk-11 · MEDIUM · The SDK is hard to adopt: no per-run model option, an internals-first README, and examples that target the removed hosted service
- **Axis:** usability, cohesion.
- **Evidence:**
  - `RunOptions` / `OpenbuffClientOptions` have no `model` or inline provider config (`sdk/src/run.ts:360-470`, `:545`). Routing comes only from config files, or from `hostConfiguration.selection {kind:'explicit', path}` (`host-config.ts:22-31`). An embedder must write an `openbuff.json` to disk to choose a model.
  - `sdk/README.md` opens with sandbox notes, then filesystem CAS brokers, `streamDirectory` obligations and approvals (lines 1-114). It has no "set a key, run, stream events" quickstart.
  - The README says complete reads carry `cap.v3` tokens (`sdk/README.md:22`). The runtime mints and requires `cap.v4` (`packages/agent-runtime/src/process-str-replace.ts:397`, `process-edit-transaction.ts:746`). The MCP server descriptions also still say `cap.v3` (`sdk/src/mcp/server.ts:237,372`).
  - `sdk/examples/readme-example-1.ts:5-14` uses `apiKey: OPENBUFF_API_KEY` ("legacy hosted compatibility") and agent `openbuff/base@0.0.16`.
    - `normalizeAgentIdForLookup` keeps the version (`common/src/util/agent-id-parsing.ts:108-127`).
    - The local registry lookup always returns `null` (`sdk/src/impl/agent-runtime.ts:664-673`).
    - No local template is named `base@0.0.16`, so the example appears to fail with agent-not-found. This was not executed.
  - The `client.ts:42` doc says "Use 'base' for the default agent", while the default root agent is `base2`. `client.ts:45` still promises token streaming "in the future", but `handleStreamChunk` exists (`run.ts:424`).
  - When no `handleEvent` is supplied, the default handler *throws* from inside the event callback on an `error` event (`client.ts:16-22`).
  - The public barrel exports about 400 lines of surface with no tiering, including a dash server, an MCP server, 3D asset tools, Memory V2 internals, `createPaymentRequiredError` and the hosted `getUserInfoFromApiKey` (`sdk/src/index.ts:184-290`).
- **Competitors:**
  - The Claude Agent SDK `query({prompt, options:{model,…}})` returns an async iterator of typed messages (A§1.2).
  - The Codex TS SDK has threads with `run` / `runStreamed` JSONL (A§2.2).
  - Pi has an in-process TS SDK plus JSONL RPC (B§3.2).
- **Fix:**
  - Add `model` and an inline `providers` override to `RunOptions`.
  - Add a 15-line quickstart (env key → `run` → `handleEvent` / `handleStreamChunk` → `previousRun`).
  - Fix `cap.v3`→`cap.v4`.
  - Rewrite the examples for BYOK with `base2`.
  - Split the exports into `@openbuff/sdk` (run, events, config) and `@openbuff/sdk/advanced`.
- **Prior review:** orchestration-10 mentions stale SDK wording in general. The rest is new. B01 covers maturity truth only.

### providers-sdk-12 · LOW · Hosted-Codebuff residue remains reachable from the BYOK SDK
- **Axis:** cohesion, security hygiene.
- **Evidence:**
  - `getUserInfoFromApiKey` is publicly exported (`sdk/src/index.ts:244`). It sends `Authorization: Bearer <apiKey>` to `https://openbuff.com/api/v1/me` (`sdk/src/impl/database.ts:124-165`, `sdk/src/constants.ts:7`). An SDK user who calls it sends a credential to a host that BYOK docs say is never contacted (`docs/local-mode.md:3`).
  - `run.ts:2387-2391` returns "Invalid API key or user not found". The default local runtime always returns a local user (`agent-runtime.ts:493, 654-662`), so the message is unreachable by default. It is reachable only when a host injects its own `getUserInfoFromApiKey`, and even then it is the wrong message for BYOK.
  - `find_files` is quarantined (`common/src/tools/constants.ts:173`), but its handler is still registered (`packages/agent-runtime/src/tools/handlers/list.ts:98`). That handler calls `promptFlashWithFallbacks` with the hosted finetuned Vertex file-picker model `ft_filepicker_010` and `openrouter_gemini2_5_flash` (`packages/agent-runtime/src/find-files/request-files-prompt.ts:222-229`, `llm-api/gemini-with-fallbacks.ts:239-300`). It is unreachable from base2's published tool list. If re-enabled, it would hard-fail BYOK routing.
  - `docs/authentication.md` is legacy-only (lines 1-9), but it is still listed among the docs.
- **Fix:**
  - Drop `getUserInfoFromApiKey` from the barrel.
  - Delete the find-files Vertex path or re-point it to a routed cheap model.
  - Make the run.ts message say "host identity check failed".
- **Prior review:** read-search-09 (quarantined tools still registered). The hosted-call export is new.

### providers-sdk-13 · LOW · `openbuff.json.example` includes files that do not exist, and missing includes are skipped silently
- **Axis:** usability.
- **Evidence:**
  - The example's `includes` points at `openbuff.d/{providers,routes,indexing}.json` (`openbuff.json.example:2-6`). Those files are not in the repo (`git ls-files` shows none).
  - The loader `continue`s on missing paths (`sdk/src/provider-config.ts:857-859`).
  - Copying the example therefore yields an empty config with no warning. The only guidance is a `_comment` string.
- **Fix:** ship a self-contained example (one provider plus `defaultModel`), and warn when an explicit include is missing.
- **Prior review:** new.

## Competitive gaps

| capability | best-in-class and how | Openbuff state | priority |
|---|---|---|---|
| Prompt caching on the agent loop | Claude Code manages caching automatically and documents its cost (A§1.3); Aider orders the prompt for cache hits and pings to keep the cache warm (B§2.3); Pi warms the cache when that saves at least $0.05 (B§3.3) | no markers sent on the stream path (01) | P0 |
| Price/window registry | OpenCode models.dev; Pi registry from OpenRouter + models.dev with costs (B§1.6, B§3.6) | none; discovery data discarded (03, 05) | P0 |
| Overload/rate-limit resilience | Claude Code retries overload; Codex owns retries | 529 terminal; Retry-After capped at 8 s (02, 09) | P0 |
| Per-turn and session cost | Aider per message; Claude `/usage`; Pi footer + `/session` | blank for most routes (03; display cli-ux-06) | P1 |
| Subscription logins | Pi: Claude Pro/Max, ChatGPT, Copilot (B§3.6); Codex: ChatGPT | ChatGPT only | P1 |
| Breadth of built-in providers | Pi ~8 native + compatible; OpenCode many; Codex Bedrock/Vertex/OSS | 3 wire types, 9 presets (06) | P1 |
| Reasoning control per model | Codex `Alt+,`/`Alt+.`; Aider `/reasoning-effort`, `/think-tokens`; Pi `/thinking` | per-route config; ignored on Claude (04) | P1 |
| Context-window awareness for local models | Codex `--oss` with Ollama/LM Studio; Pi llama.cpp router | 190k default; silent Ollama truncation (05) | P1 |
| Custom headers / gateways | Codex `model_providers` with custom auth; Claude `ANTHROPIC_BASE_URL` gateways | no headers field (06) | P2 |
| SDK quickstart, model option, typed stream | Claude Agent SDK `query()`; Codex SDK `runStreamed`; Pi SDK + RPC | file-only routing; internals-first README (11) | P1 |
| Mid-session model switch | OpenCode Ctrl+X M / F2; Pi `/model` + scoped cycling | `/models` picker edits config; no quick cycle | P2 |

## Strengths

- **Multi-provider failover with a delivery gate.** Ordered `failoverModels`, deduped (`failover.ts:54-70`). Failover never happens after content was yielded (`llm.ts:2099-2105`), and buffered tool calls from a failed attempt are dropped (`llm.ts:1265-1269`). Claude Code is single-vendor (A§1.6). Pi and OpenCode do not document automatic cross-provider failover.
- **Per-mode and per-agent routing with per-route reasoning**, edited in a picker (`model-route-picker.tsx`). Pi needs a virtual-model extension for the same thing (B§3.2).
- **Adaptive recovery from "prompt too long"**: it parses the provider's limit and retries once with a trimmed context (`llm.ts:982-1015, 2002-2031`).
- **Hostile-safe Retry-After parsing** that fails closed on malformed or past values (`retry-config.ts:407-450`).
- **Text-tool fallback** for providers without native tools, with token-overhead accounting (`llm.ts:1374-1397`).
- **ChatGPT subscription and OpenCode Go transports** that translate Chat Completions to Responses (`chatgpt-backend-fetch.ts`, `opencode-go-responses-fetch.ts`). Claude Code and Gemini CLI have no equivalent.
- **SDK can serve ACP and MCP** (`sdk/src/index.ts:184-237`). Codex needs `app-server`, and Pi needs Pi-Bolt for `--mcp` (B§4.3).
- **B08 fixes verified at HEAD:**
  - AI SDK hidden retries are disabled (`maxRetries: 0`, `llm.ts:1438`).
  - The streaming path uses the shared classifier (`llm.ts:2050`).
  - OpenAI-compatible routes send `reasoning_effort` (effort probe).

## Roadmap mapping

| finding | coverage |
|---|---|
| providers-sdk-01 caching not sent | not covered |
| providers-sdk-02 529 terminal | partially: B08 (accepted) owns retry policy; 529 not in its fixture |
| providers-sdk-03 cost blank/wrong | partially: B09 (not accepted) covers 02-F3, precision and provenance; price table, discovery persistence and Anthropic token semantics not covered |
| providers-sdk-04 effort on Claude / OAuth low default | partially: B08 fixed the namespace for OpenAI-compatible; Anthropic thinking not covered |
| providers-sdk-05 context windows | not covered |
| providers-sdk-06 provider breadth/headers | not covered (prior P2 "native Gemini optional") |
| providers-sdk-07 stale presets | not covered |
| providers-sdk-08 silent failover | not covered |
| providers-sdk-09 Retry-After cap | partially: B08 (fixture values only) |
| providers-sdk-10 local URL rules | not covered |
| providers-sdk-11 SDK ergonomics | partially: B01 (maturity wording); rest not covered |
| providers-sdk-12 hosted residue | partially: read-search-09 (quarantined tools); export not covered |
| providers-sdk-13 example config | not covered |
| 02-F3 (prior) | B09; still present (probe) |
| 02-F1, 02-F5, 02-F7 (prior) | B08 accepted; fixed at HEAD (F5 only for OpenAI-compatible) |
| 02-F4, 02-F6 (prior) | B08 accepted; not re-probed |
