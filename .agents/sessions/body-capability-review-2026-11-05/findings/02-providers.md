# Provider and BYOK capability review

Openbuff has a real local BYOK body: CLI readiness, configurable routing, native tool transport, request trimming, cancellation, and recovery status all reach production consumers. Recovery and accounting are less mature than their helper tests suggest. Seven defects are reproduced without external APIs; the strongest are server-error failover losing the original status and default streams losing usage/cost provenance.

Snapshot: `ec141833a7efa94cd25b0e2c964fc2c832ce5983b2446c03769515032360deb0`. Scope: **41 current inventory files / 64 exact sampled ranges**, all eight audit domains. **7 findings** (1 HIGH, 6 MEDIUM), **14 capabilities**. Source was not changed.

**Verification:** pinned Bun1.3.5;62 existing unit/adapter tests passed (464 assertions);9 offline current-behavior probes passed (29 assertions). Probe source/result: [02-providers-probes.test.ts](../evidence/02-providers-probes.test.ts.txt), [02-providers-probes.json](../evidence/02-providers-probes.json). These probes passing means the reported current behavior is reproduced, not that the defects pass desired acceptance. HTTP/SSE probes use the real configured resolver, model adapter, and AI SDK unless explicitly labeled stream/credential DI.

## Capabilities and production completeness

| Capability | Maturity | Assurance and practical limit |
|---|---|---|
| byok-routing | **usable** | static CLI→runtime trace + offline integration; Availability guarantees are limited by02-F1/F2/F4; user-run env overrides were not audited end-to-end. |
| capability-resolution | **partial** | static trace + offline options/wire probes; Model tools.supported/requiredToolChoice/structuredOutputs and promptCaching metadata are advisory/display data; provider compatibility controls transport. Probe shows tools.supported=false still sends native tools, which is a completeness limit rather than an assumed security defect. |
| native-tool-streaming | **usable** | static consumer trace + unit + offline real adapter/SDK stream; No real provider API/model quality test in this review. |
| text-tool-fallback | **usable** | static consumer trace + unit; Requires a model capable of following the text protocol; success against arbitrary chat-only models was not measured. |
| retry-failover | **partial** | static trace +62 selected unit tests + offline real HTTP/SSE and DI probes; 02-F1 hides initial HTTP status after SDK retries;02-F2 loses in-band status;02-F7 diverges from the shared policy. |
| cancellation-timeouts | **usable** | static CLI→adapter trace + unit; No live hung socket or provider ignoring abort test here. |
| oauth-subscription | **partial** | static trace + offline resolver/credential DI; 02-F6 makes skip-based recovery incomplete for configured OAuth routes. |
| context-limit-adaptation | **partial** | static runtime/request trace + unit inspection + offline preflight probe; 02-F4 couples capability resolution to all backup credentials. |
| usage-and-cost | **partial** | static runtime observers + unit + offline production transport probes; 02-F3 proves missing/zero cost and missing usage under normal production configurations. |
| vision-input-routing | **usable** | static adapter/consumer trace + unit inspection; Fallback still uses model-name heuristics and scans credential-validating candidates; no live image quality or multi-provider preference test here. |
| empirical-language-recommendations | **usable** | static real CLI command→helper trace + unit inspection; This is opt-in recommendation lookup, not autonomous language-aware run routing or an automatic evaluation→quality update loop. |
| openrouter-specific-accounting | **unwired** | static constructor/caller search + adapter unit tests; No production SDK/CLI constructor caller was found for the specialized adapter; type-only imports do not execute it. |
| output-ceilings-and-truncation | **partial** | static stream/contract trace + unit; Configured outputTokens is a default, not an enforced provider maximum; adapters may reject a larger template request. This precedence is documented, not a newly invented breaking change. |
| native-gemini-protocol | **absent** | static configured-provider entrypoint/manifest inspection; Gemini is usable through an OpenAI-compatible gateway; direct Gemini API transport is absent in the reviewed source-selected routing path. |

Useful existing strengths include strict BYOK routing with no hosted inference fallback, actual local/native tool schemas, a delivery-based retry gate that drops stale buffered calls, authoritative stream-only truncation markers, model-context overhead reservation, AbortSignal propagation, bounded metadata waits, and coalesced CLI provider status. The empirical language/task/role recommendation command is actually wired, but it is an opt-in lookup over configured measurements.

Per-model tools/cache/structured metadata is currently advisory. The actual native-tool control is provider compatibility.supportsTools. The specialized OpenRouter accounting adapter and failover-floor helper have tests but no production caller found; their green tests are not evidence of shipped default behavior. Direct Gemini protocol support is absent in the reviewed routing union; Gemini through OpenAI-compatible gateways remains a supported design choice.

## Findings

### 02-F1 — AI SDK retry wrappers disable configured failover after initial HTTP 5xx

**HIGH; confidence high; evidence.** Domains: correctness, error-handling, api-contract, test-coverage.

**Trigger:** An ordinary agent request (maxRetries: 3) receives initial HTTP 503 responses whose message is 'Provider unavailable'; defaultModel=local/primary and failoverModels=['local/backup'].

**Consequence:** Observed actual AI SDK/adapter path makes four primary HTTP requests, throws AI_RetryError with lastError.statusCode=503 but classifierStatus absent, and makes zero backup requests. This is not the intended Openbuff outer retry/failover policy; UI attempt/status telemetry cannot see the inner retries either.

**Current evidence:**

- `packages/agent-runtime/src/prompt-agent-stream.ts:95` — Production agent requests set maxRetries: 3, enabling AI SDK transport retries.
- `sdk/src/impl/llm.ts:1339` — streamText spreads streamParams, including that maxRetries value; only OAuth explicitly disables SDK retries at line 1361.
- `sdk/src/error-utils.ts:189` — getErrorStatusCode only reads top-level numeric statusCode/status; it does not unwrap AI_RetryError.lastError.
- `sdk/src/impl/llm.ts:2027` — Configured backup requires isFailoverEligibleError(error), which receives the wrapper.
- `sdk/src/impl/failover.ts:98` — A wrapper with no top-level status is ineligible for failover.
- `docs/configuration.md:173` — Documented 5xx behavior is retries followed by configured failover.

**Suggested fix:** Choose one retry owner for all provider request paths (prefer the Openbuff loop with AI SDK maxRetries: 0), preserve the last provider error/status in a canonical error contract, and classify failover on that contract.

**Acceptance probe:** Use the offline HTTP fixture from evidence/02-providers-probes.test.ts, probe http-retry-wrapper-disables-failover: primary returns HTTP503 + Retry-After:0, backup streams text. Require bounded primary attempts followed by one backup attempt, final success, and accurate retry/failover status events.

### 02-F2 — In-band SSE error status is converted into prose instead of retry metadata

**MEDIUM; confidence high; evidence.** Domains: correctness, error-handling, api-contract, test-coverage.

**Trigger:** A configured provider opens HTTP200 SSE and emits {error:{message:'Upstream provider failure',code:'upstream_error',status:'503'}} before any content, with a configured backup.

**Consequence:** Observed real SDK stream receives OpenAICompatibleStreamError, classifier status is absent, and performs one primary request with no retry or backup, despite an explicit server-error status in the provider payload.

**Current evidence:**

- `packages/internal/src/openai-compatible/chat/openai-compatible-chat-language-model.ts:122` — createOpenAICompatibleStreamError embeds code/status/details into Error.message but only assigns name; it does not retain status/statusCode properties.
- `packages/internal/src/openai-compatible/chat/openai-compatible-chat-language-model.ts:670` — The production SSE adapter uses that converter for error chunks.
- `sdk/src/impl/llm.ts:1648` — The stream loop throws that converted Error for non-tool errors.
- `sdk/src/error-utils.ts:189` — Retry/failover status extraction only reads numeric properties, not embedded message JSON.
- `packages/internal/src/openai-compatible/chat/openai-compatible-chat-language-model.test.ts:335` — Existing 'preserves structured provider metadata' regression checks message contents rather than retry-classifier-visible status.

**Suggested fix:** Normalize validated numeric/string status into a structured numeric statusCode and preserve provider code/details separately from the display message. Reuse the same error contract as HTTP failures.

**Acceptance probe:** Run the sse-status-loss fixture through the production configured model and AI SDK. Require classifier status503 and the documented bounded retry→backup behavior before any content is delivered; malformed status must remain unclassified.

### 02-F3 — Default streaming transport drops usage and suppresses configured cost accounting

**MEDIUM; confidence high; evidence.** Domains: correctness, state-mutation, api-contract, test-coverage.

**Trigger:** A real configured OpenAI-compatible stream uses pricing input=$3/M, output=$15/M and offers usage 20,000 input +10,000 output tokens. A tool turn sends usage after finish_reason=tool_calls; separately a normal text turn sends known usage with stripProviderMetadata=true.

**Consequence:** Observed tool stream delivers its tool call but loses all offered usage; with metadata stripping disabled the cost callback reports0 instead of21 cents. With the default stripping flag enabled, a text stream retains usage but never calls the cost observer at all. Cache/calibration inputs and step cost therefore lack truthful provider provenance. Actual provider charges and hard budget enforcement were not measured by these probes.

**Current evidence:**

- `sdk/src/provider-config.ts:73` — stripProviderMetadata defaults true for OpenAI-compatible providers.
- `sdk/src/impl/model-provider.ts:686` — CLI/SDK configured OpenAI-compatible providers use the local OpenAICompatibleChatLanguageModel.
- `sdk/src/impl/model-provider.ts:696` — That production constructor always sets includeUsage: undefined; config exposes no includeUsage control.
- `packages/internal/src/openai-compatible/chat/openai-compatible-chat-language-model.ts:424` — The usage request field is sent only when includeUsage is enabled.
- `packages/internal/src/openai-compatible/chat/openai-compatible-chat-language-model.ts:939` — On a tool-calls finish, the default adapter terminates the stream before later usage chunks.
- `sdk/src/impl/llm.ts:1844` — Both provider cost extraction and configured-pricing fallback are inside !stripProviderMetadata.
- `sdk/src/impl/llm.ts:1876` — If cost fallback does run without token counts, computeCostCentsFromUsage treats missing usage as zero.
- `packages/agent-runtime/src/run-agent-step.ts:734` — Reported cost is accumulated into step accounting.
- `packages/agent-runtime/src/run-agent-step.ts:797` — The usage callback unconditionally feeds cache totals and token-calibration observations.
- `packages/internal/src/openai-compatible/chat/openai-compatible-chat-language-model.test.ts:70` — The green late-usage test explicitly constructs includeUsage: true, unlike the shipped constructor.

**Suggested fix:** Separate request-metadata compatibility from response accounting; negotiate include_usage for supporting endpoints and retain terminal usage when requested; represent unknown usage/cost distinctly from zero. Keep high precision internally and round only for display. Attach provider/model/currency/provenance to accounting.

**Acceptance probe:** Use late-tool-usage and strip-provider-metadata-cost-gate fixtures with the real configured adapter. Both must report21 cents with 20k/10k usage, preserve exactly one tool call, and report unknown rather than0 when the endpoint supplies no usage. Test endpoints that reject include_usage via an explicit compatibility control, and assert runtime aggregates receive the same receipt.

### 02-F4 — Context preflight requires backup credentials before a healthy primary can run

**MEDIUM; confidence high; evidence.** Domains: correctness, error-handling, api-contract, test-coverage.

**Trigger:** defaultModel=local/primary is an unauthenticated local provider with a valid200k window; failoverModels includes backup/emergency with HTTPS endpoint and an unset apiKeyEnv.

**Consequence:** Observed getModelForRequest successfully constructs the primary, but capacity resolution and promptAiSdkStream throw the backup missing-key error before any fetch. A dormant emergency route takes down the otherwise usable primary.

**Current evidence:**

- `sdk/src/impl/model-provider.ts:424` — Context resolution is documented as capacity-only without touching credentials.
- `sdk/src/impl/model-provider.ts:439` — It scans every primary/failover candidate and calls credential-validating resolveConfiguredProviderModel.
- `sdk/src/provider-config.ts:2034` — A matched backup with missing apiKeyEnv throws synchronously.
- `packages/agent-runtime/src/run-agent-step.ts:1572` — The production agent loop calls the resolver before its first programmatic step.
- `sdk/src/impl/llm.ts:1197` — The stream path also calls it before entering the guarded provider attempt loop.
- `cli/src/utils/openbuff-provider.ts:1021` — CLI readiness validates the selected root provider, so the primary can pass readiness before this backup error.
- `docs/configuration.md:141` — Failover is documented as secondary and starts only after primary request failure.

**Suggested fix:** Resolve route/model capability metadata without credential validation; check credentials when a candidate is actually selected. Surface invalid backup readiness separately, with a defined skip/fail behavior when failover is needed.

**Acceptance probe:** Use context-preflight-backup-credential-coupling fixture. Require primary window200k and a successful primary request with backup credentials absent. If primary fails, require a precise backup configuration result without erasing the primary failure.

### 02-F5 — Configured reasoning effort is omitted for custom OpenAI-compatible provider IDs

**MEDIUM; confidence high; evidence.** Domains: correctness, api-contract, test-coverage.

**Trigger:** A custom provider ID 'local' declares reasoning support and high/medium/low efforts; defaultReasoningEffort='high'; a normal agent stream is sent through the actual configured adapter.

**Consequence:** Observed ModelResult.reasoningEffort is high while the HTTP body has no reasoning_effort. Providers named 'openai' can use the other namespace, making behavior depend on the arbitrary configuration ID rather than declared capabilities. Adaptive role choices can likewise be selected but never transmitted.

**Current evidence:**

- `sdk/src/impl/model-provider.ts:243` — Configured route effort is resolved and exposed on ModelResult.
- `sdk/src/impl/llm.ts:1037` — withConfiguredReasoningEffort writes providerOptions.openaiCompatible and providerOptions.openai.
- `packages/internal/src/openai-compatible/chat/openai-compatible-chat-language-model.ts:181` — The adapter's providerOptionsName is the configured provider ID.
- `packages/internal/src/openai-compatible/chat/openai-compatible-chat-language-model.ts:207` — The generic options namespace read by the adapter is 'openai-compatible' (hyphenated), followed by the provider ID.
- `packages/internal/src/openai-compatible/chat/openai-compatible-chat-language-model.ts:288` — reasoning_effort is emitted only from the options it parsed.
- `packages/agent-runtime/src/prompt-agent-stream.ts:138` — Template effort uses the same camelCase namespace, so the generic route shares the mismatch.

**Suggested fix:** Publish one canonical generic provider-options namespace and use it consistently at producer/adapter boundaries, or map options using the resolved provider ID. Preserve compatibility with existing public option names and validate effort support.

**Acceptance probe:** Use reasoning-provider-options-namespace fixture; run high/medium/low route and template overrides for provider IDs local, custom-gateway, and openai. Require the same correct wire reasoning_effort or an explicit unsupported-setting result.

### 02-F6 — Configured OAuth routes ignore the skip flag used for recovery

**MEDIUM; confidence high; evidence.** Domains: correctness, error-handling, state-mutation, api-contract, test-coverage.

**Trigger:** defaultModel='codex/gpt-5.5', provider codex type chatgpt-oauth; recovery or a non-streaming caller invokes getModelForRequest with skipChatGptOAuth:true.

**Consequence:** Observed actual model resolver still requests OAuth credentials and returns isChatGptOAuth:true. Thus the recursive recovery path can revisit the same excluded provider instead of selecting BYOK backup. A known configured OAuth rate limit is not prevented by the cache in that branch. The probe injected credentials and did not exercise real refresh/subscription services.

**Current evidence:**

- `sdk/src/impl/model-provider.ts:234` — The resolver receives skipChatGptOAuth.
- `sdk/src/impl/model-provider.ts:302` — A configured chatgpt-oauth provider is selected unconditionally; skip/rate-limit flags are checked only in the later implicit OAuth branch.
- `sdk/src/impl/model-provider.ts:379` — Only implicit OAuth honors skipChatGptOAuth and the rate-limit cache.
- `sdk/src/impl/llm.ts:1578` — The OAuth rate-limit recovery recursively calls the same params with skipChatGptOAuth:true to obtain configured provider fallback.
- `sdk/src/impl/llm.ts:1631` — Failed auth refresh uses the same skip-based fallback.
- `sdk/src/impl/llm.ts:2091` — Non-streaming requests also rely on skipChatGptOAuth:true.
- `sdk/src/impl/__tests__/llm-chatgpt-oauth-policy.test.ts:58` — Existing test checks the policy helper's skip behavior, not actual configured model selection.

**Suggested fix:** Define explicit OAuth recovery routing: honor skip for configured routes, select only configured BYOK backup candidates, and fail with an actionable reconnect/route message when none exists. Make rate-limit state apply to configured OAuth routes too.

**Acceptance probe:** Use configured-oauth-ignores-skip fixture plus a simulated pre-content429/failed-auth-refresh recovery. After skip is requested, neither OAuth credential getter nor backend fetch may be called again; configured BYOK backup must run or an actionable terminal error must result.

### 02-F7 — Streaming retry bypasses the shared deterministic-error policy

**MEDIUM; confidence high; evidence.** Domains: correctness, error-handling, performance, test-coverage, api-contract.

**Trigger:** An injected provider stream fails before output with createProviderContentPolicyError({statusCode:503}); the shared classifier says retryable:false.

**Consequence:** Observed promptAiSdkStream makes four stream attempts and three backoff calls while the shared policy requires one. Deterministic refusals can consume extra requests and delay, and the streaming layer does not share the documented header-aware decision. The four attempts are Openbuff outer stream calls in this DI probe; they are distinct from the four internal HTTP retries in02-F1.

**Current evidence:**

- `sdk/src/retry-config.ts:412` — The shared classifier fails fast for content-policy errors and explicit non-retryable statuses, and extracts bounded Retry-After.
- `sdk/src/impl/llm.ts:1915` — Streaming normalizes content-policy errors but does not call the shared classifier afterward.
- `sdk/src/impl/llm.ts:1977` — Streaming accepts transient message OR retryable status OR empty stream; a policy error retaining503 is consequently retried.
- `sdk/src/impl/llm.ts:1997` — Streaming always computes exponential delay rather than applying the shared Retry-After decision.
- `sdk/src/impl/llm.ts:2151` — Non-streaming uses runWithRetryPolicy, so policies diverge.
- `sdk/src/__tests__/retry-config.test.ts:196` — The retry matrix tests the correct helper, not the production streaming gate.

**Suggested fix:** Use classifyRetryableError in the streaming gate, with the explicit no-content and empty-stream exceptions retained. Apply its delayMs and cancellation semantics. Combine with a single retry owner so policy is checked before hidden SDK retries.

**Acceptance probe:** Use stream-loop-bypasses-shared-retry-classifier fixture. Require one call/no backoff for policy503 and non-retryable400 containing transient-sounding text; require bounded Retry-After for429, no retry after user abort, and existing safe buffered-tool retry/failover regressions to remain passing.

## Capability traces, states and strengths

### byok-routing: usable

Entrypoint → implementation → real consumer: `cli/src/hooks/use-send-message.ts:679`, `sdk/src/run.ts:743` → `sdk/src/provider-config.ts:1928`, `sdk/src/impl/model-provider.ts:231` → `sdk/src/impl/agent-runtime.ts:229`, `packages/agent-runtime/src/run-agent-step.ts:1023`.

Tests: `sdk/src/__tests__/model-provider.test.ts:761`, `sdk/src/__tests__/model-provider.test.ts:1428`, `evidence/02-providers-probes.test.ts`. Docs: `docs/local-mode.md:176`, `docs/request-flow.md:158`.

Failure: Invalid config, missing model/key and disconnected OAuth surface errors. Loading: Readiness awaits registry readiness before accepting a send. Empty: Missing configuration shows setup guidance. Cancellation: CLI supplies the run AbortSignal. Retry: Retry/failover partial; separate capability. Permission: Configured providers are the authority; ancestor apiKeyEnv trust gate and HTTPS checks exist.

Strengths:

- Local BYOK endpoints, model aliases, mode/per-agent overrides, native Anthropic gateways, and unauthenticated loopback endpoints have real consumers.
- No hosted inference/balance path in the selected production resolver; clear missing-key/model errors aid recovery.

Limits:

- Availability guarantees are limited by02-F1/F2/F4; user-run env overrides were not audited end-to-end.
- Provider/model mapping ambiguity is resolved by configured iteration order; this review did not measure routing quality.

### capability-resolution: partial

Entrypoint → implementation → real consumer: `sdk/src/provider-config.ts:146` → `sdk/src/provider-config.ts:1630` → `sdk/src/impl/model-provider.ts:261`, `cli/src/utils/openbuff-provider.ts:303`.

Tests: `sdk/src/__tests__/model-provider.test.ts:761`, `evidence/02-providers-probes.test.ts:advisory-tools-metadata`. Docs: `docs/configuration.md:193`.

Failure: Schema validation rejects malformed numbers/types; unsupported wire options are incompletely negotiated. Loading: Loaded with provider config. Empty: Unknown capabilities remain omitted/defaulted. Cancellation: No separate operation; follows request signal. Retry: Metadata is re-resolved per attempt. Permission: Capability metadata grants no filesystem permission; provider config trust governs transport.

Strengths:

- Mapped IDs and per-model overrides provide an extensible provider-independent metadata spine.
- Explicit image/context support avoids relying solely on model names; unknown metadata is retained rather than fabricating measured quality.

Limits:

- Model tools.supported/requiredToolChoice/structuredOutputs and promptCaching metadata are advisory/display data; provider compatibility controls transport. Probe shows tools.supported=false still sends native tools, which is a completeness limit rather than an assumed security defect.
- reasoning.defaultEffort is display metadata while route/adaptive effort decides execution; wire effort has02-F5.
- Legacy window fallback helper exists but production model/context resolvers use explicit metadata; docs/configuration.md explicitly requires migration.

### native-tool-streaming: usable

Entrypoint → implementation → real consumer: `packages/agent-runtime/src/prompt-agent-stream.ts:85` → `sdk/src/impl/llm.ts:1104`, `packages/internal/src/openai-compatible/chat/openai-compatible-chat-language-model.ts:414` → `packages/agent-runtime/src/run-agent-step.ts:1059`, `common/src/types/contracts/llm.ts:57`.

Tests: `sdk/src/impl/__tests__/llm-tool-call-buffer.test.ts:230`, `packages/internal/src/openai-compatible/chat/openai-compatible-chat-language-model.test.ts:234`. Docs: `docs/request-flow.md:146`, `docs/configuration.md:239`.

Failure: Malformed inputs reach validation/repair feedback; fatal provider errors preserve the no-duplicate gate. Loading: Text/reasoning stream immediately; tools wait for finish. Empty: Empty stream has explicit bounded retry/failover behavior. Cancellation: Caller signal reaches adapter HTTP/SSE. Retry: Buffered-only thrown failures can retry without emitting failed calls. Permission: Actual tool permissions are enforced downstream; no direct execution in provider adapter.

Strengths:

- Only actual delivery blocks retry, so a failed buffered payload cannot leak into the next successful attempt.
- Stream-only truncation evidence is stripped from persisted payload by the shared contract.
- Empty placeholders, missing IDs and anomalous continuations have focused adapter tests.

Limits:

- No real provider API/model quality test in this review.
- Tool schema/permission execution is owned by runtime/tool lanes; transport correctness does not prove every tool operation safe.
- Error-chunk flush can publish pending calls before a terminal error; this review records current behavior rather than treating all such calls as duplicates.

### text-tool-fallback: usable

Entrypoint → implementation → real consumer: `sdk/src/provider-config.ts:96` → `sdk/src/impl/llm.ts:1298` → `packages/agent-runtime/src/run-agent-step.ts:1059`, `packages/agent-runtime/src/prompt-agent-stream.ts:107`.

Tests: `sdk/src/impl/__tests__/llm-tool-call-buffer.test.ts:210`, `sdk/src/impl/__tests__/llm-context-window.test.ts:17`. Docs: `docs/local-mode.md:293`.

Failure: Unrenderable schemas fail explicitly. Loading: Instruction/history conversion happens per selected provider attempt. Empty: No schemas means no extra instructions. Cancellation: Follows stream cancellation. Retry: Rebuilt per attempt so backup compatibility can differ. Permission: Normal tool validation/permissions remain downstream.

Strengths:

- Fallback sends structured tool names/descriptions/schemas rather than hiding the tool surface.
- Historical calls/results are made compatible with providers rejecting tool roles.

Limits:

- Requires a model capable of following the text protocol; success against arbitrary chat-only models was not measured.
- Per-model tool hints do not automatically activate the fallback; provider compatibility flag is the actual control.
- Non-streaming generation omits native tools but does not use the same instruction/history fallback.

### retry-failover: partial

Entrypoint → implementation → real consumer: `sdk/src/impl/llm.ts:1196` → `sdk/src/impl/llm.ts:1203`, `sdk/src/retry-config.ts:460`, `sdk/src/impl/failover.ts:83` → `cli/src/utils/sdk-event-handlers.ts:2204`.

Tests: `sdk/src/__tests__/retry-config.test.ts:196`, `sdk/src/impl/__tests__/llm-tool-call-buffer.test.ts:284`, `evidence/02-providers-probes.test.ts`. Docs: `docs/configuration.md:140`.

Failure: Terminal failure after bounded eligible attempts; wrappers/status loss currently impair recovery. Loading: Visible provider-status events for Openbuff outer retries. Empty: NoOutputGeneratedError is an explicit retry/failover class. Cancellation: Backoff rejects promptly on signal abort. Retry: Partial; three concrete policy/transport defects. Permission: Only configured backup models; no arbitrary hosted fallback.

Strengths:

- No retry after delivered content protects edits/output from duplication.
- Auth and server status classes, rate-limit/timeouts carve-outs, and cancellation-aware waits are explicit.
- UI status events have a production consumer and do not accumulate assistant prose.

Limits:

- 02-F1 hides initial HTTP status after SDK retries;02-F2 loses in-band status;02-F7 diverges from the shared policy.
- Non-streaming/structured paths retry but have no configured failover loop.
- AI SDK and Openbuff retries are not one observable budget; no measured worst-case transport attempt count is claimed.

### cancellation-timeouts: usable

Entrypoint → implementation → real consumer: `cli/src/hooks/use-send-message.ts:787` → `sdk/src/impl/llm.ts:543`, `sdk/src/retry-config.ts:111` → `packages/internal/src/openai-compatible/chat/openai-compatible-chat-language-model.ts:443`, `cli/src/hooks/use-send-message.ts:819`.

Tests: `sdk/src/__tests__/retry-config.test.ts:371`, `sdk/src/__tests__/retry-config.test.ts:423`, `cli/src/utils/__tests__/provider-diagnostics.test.ts:36`. Docs: `docs/request-flow.md:180`, `docs/testing.md:21`.

Failure: Timeout/network errors and user cancellation are differentiated by signal checks. Loading: In-flight request remains abortable. Empty: Pre-aborted request returns without provider dispatch. Cancellation: Propagated signal; listener cleanup and no-backoff retry after abort. Retry: Bounded default timeout applies per request attempt. Permission: No new permission required to cancel; provider config determines request authority.

Strengths:

- Abort propagation spans CLI, runtime, SDK and adapter rather than only dismissing the UI.
- Wait listeners/timers are removed and optional metadata errors do not invalidate successful content.
- CLI serializes preserved cancelled state under send ownership.

Limits:

- No live hung socket or provider ignoring abort test here.
- The600s default is per request/attempt; it is not a total run SLA.
- Finish reason is awaited separately from optional post-stream metadata; alternate misbehaving LanguageModel implementations were not probed.

### oauth-subscription: partial

Entrypoint → implementation → real consumer: `cli/src/utils/openbuff-provider.ts:1032` → `sdk/src/impl/model-provider.ts:302`, `sdk/src/impl/llm.ts:1553` → `sdk/src/impl/llm.ts:1247`.

Tests: `sdk/src/impl/__tests__/llm-chatgpt-oauth-policy.test.ts:5`, `evidence/02-providers-probes.test.ts:configured-oauth-ignores-skip`. Docs: `docs/local-mode.md:251`, `docs/request-flow.md:172`.

Failure: Missing credentials/connect message; refresh failure currently has recovery gap. Loading: Credentials are fetched/refreshed on demand. Empty: Disconnected state is explicit. Cancellation: Request signal reaches the backend adapter; refresh lifecycle not dynamically verified. Retry: One auth refresh recursion; configured skip is defective. Permission: User explicitly connects a subscription; stored secrets were not read.

Strengths:

- Optional explicit provider path and actionable connect/reconnect failure states.
- No hosted credit charge for a provider-owned subscription; auth handling is separate from API keys.

Limits:

- 02-F6 makes skip-based recovery incomplete for configured OAuth routes.
- Credential persistence, real OAuth refresh and backend Responses stream conversion were not re-audited here.
- No live subscription assurance; prompt model allowlist/availability must be maintained separately.

### context-limit-adaptation: partial

Entrypoint → implementation → real consumer: `sdk/src/impl/model-provider.ts:429` → `sdk/src/impl/llm.ts:815`, `sdk/src/impl/llm.ts:1932` → `packages/agent-runtime/src/run-agent-step.ts:828`, `packages/agent-runtime/src/run-agent-step.ts:1572`.

Tests: `sdk/src/__tests__/model-provider.test.ts:1818`, `sdk/src/impl/__tests__/llm-context-window.test.ts:67`, `sdk/src/impl/__tests__/llm-context-window.test.ts:706`. Docs: `docs/configuration.md:193`, `docs/configuration.md:253`.

Failure: Oversized prompt can trim/retry once; unknown format still fails clearly. Loading: Window resolves before runtime starts and per attempted route. Empty: Unknown window uses the standard fallback budget. Cancellation: Follows run signal. Retry: One adaptive context retry within request budget. Permission: Pure capacity lookup should need no secret permission, currently violated by credential coupling.

Strengths:

- Pre-request capacity and dispatch-time emergency brake are both connected, avoiding a purely documented trim helper.
- System/tool overhead and text-history expansion are reserved.
- Emergency trims emit distinct telemetry for diagnosis; repeated identical non-streaming retries hoist trim once.

Limits:

- 02-F4 couples capability resolution to all backup credentials.
- resolveModelContextWindows failoverFloor helper is tested but has no production caller found; do not count floor negotiation as shipped.
- Adaptive context errors are recognized by bounded text patterns; arbitrary provider formats were not measured.

### usage-and-cost: partial

Entrypoint → implementation → real consumer: `sdk/src/provider-config.ts:196` → `sdk/src/impl/llm.ts:297`, `sdk/src/impl/llm.ts:1844` → `packages/agent-runtime/src/run-agent-step.ts:734`, `packages/agent-runtime/src/run-agent-step.ts:804`.

Tests: `sdk/src/impl/__tests__/llm-cost.test.ts:6`, `packages/internal/src/openai-compatible/chat/openai-compatible-chat-language-model.test.ts:28`, `evidence/02-providers-probes.test.ts:late-tool-usage`. Docs: `docs/configuration.md:195`, `docs/request-flow.md:176`.

Failure: Missing metadata currently degrades to missing/zero, so error provenance is incomplete. Loading: Cost resolves after a successful stream. Empty: Missing usage is indistinguishable from zero at current observer/helper boundaries. Cancellation: Cancelled/failed attempt spend was not measured. Retry: Successful attempt cost only; failed/retried billed usage needs a defined receipt. Permission: Telemetry is local/BYOK, not hosted credit billing.

Strengths:

- Cost/usage have real runtime consumers and configured-pricing fallback exists.
- Step-local accumulation avoids stale pre-spread object mutation.
- OAuth subscription accounting is intentionally separate rather than fabricated request charges.

Limits:

- 02-F3 proves missing/zero cost and missing usage under normal production configurations.
- Whole-cent per-request rounding and accepted non-USD currency metadata are not sufficient for precise cross-provider spend accounting; no FX or measured accuracy claim.
- Provider-reported OpenRouter cost extraction expects codebuff.usage, while default configured clients neither use the specialized adapter nor install a raw usage metadata extractor.
- Unknown, absent, estimated and provider-reported accounting need explicit provenance before reliable spend comparisons/limits.

### vision-input-routing: usable

Entrypoint → implementation → real consumer: `sdk/src/impl/llm.ts:1239` → `sdk/src/impl/model-provider.ts:609` → `sdk/src/impl/model-provider.ts:250`, `packages/internal/src/openai-compatible/chat/convert-to-openai-compatible-chat-messages.ts:45`.

Tests: `sdk/src/__tests__/model-provider.test.ts:1741`, `sdk/src/__tests__/model-provider.test.ts:1896`. Docs: `docs/configuration.md:195`.

Failure: Missing/non-vision route gives an actionable error. Loading: Routing occurs before provider request. Empty: No image parts means ordinary model path. Cancellation: Uses request cancellation. Retry: Backup attempts re-evaluate vision requirements. Permission: Only configured provider candidates; no arbitrary external vision fallback.

Strengths:

- A non-image primary does not silently discard an image; route or actionable error is explicit.
- Per-model overrides and explicit vision route can cross configured providers.

Limits:

- Fallback still uses model-name heuristics and scans credential-validating candidates; no live image quality or multi-provider preference test here.
- Arbitrary non-image file inputs are explicitly unsupported by this adapter despite an input.file metadata field.
- Image capability is a routing/transport capability, not image understanding accuracy.

### empirical-language-recommendations: usable

Entrypoint → implementation → real consumer: `cli/src/commands/command-registry.ts:965` → `sdk/src/provider-config.ts:1868` → `cli/src/utils/openbuff-provider.ts:532`.

Tests: `sdk/src/__tests__/model-provider.test.ts:238`. Docs: `docs/local-mode.md:198`.

Failure: Bad command shape shows usage. Loading: Synchronous config-backed lookup. Empty: No matching measurements produces actionable guidance. Cancellation: No long-running work; evaluation cancellation is outside this capability. Retry: No retry needed for the lookup. Permission: Recommendation does not change routing or authorize model/provider use.

Strengths:

- Real user-facing consumer makes the existing multilingual hook useful today.
- Unmeasured models are excluded; benchmark/sample size/matched dimensions remain visible.
- Explicit routes are preserved and recommendations are opt-in.

Limits:

- This is opt-in recommendation lookup, not autonomous language-aware run routing or an automatic evaluation→quality update loop.
- Metrics are user-configured evidence; benchmark comparability, freshness and measured confidence are not enforced.
- Automated evaluator producers were out of this lane; do not infer they exist from the display schema.

### openrouter-specific-accounting: unwired

Entrypoint → implementation → real consumer: `packages/internal/src/openrouter-ai-sdk/chat/index.ts:395` → `packages/internal/src/openrouter-ai-sdk/chat/index.ts:527` → no production caller found.

Tests: `packages/internal/src/openrouter-ai-sdk/tests/stream-usage-accounting.test.ts:136`. Docs: `docs/request-flow.md:166`.

Failure: Transformer has error/finish branches, but no default consumer. Loading: Not on default run path. Empty: Unit fixtures cover usage present/absent. Cancellation: Adapter accepts abortSignal but not selected by real routing. Retry: No production retry contract for this unused adapter. Permission: Configured generic OpenRouter use remains BYOK; optional adapter selection not shipped.

Strengths:

- Reusable specialized transformer and injected HTTP tests exist as implementation material.
- Usage/cost details can be reused during adapter unification rather than designed from scratch.

Limits:

- No production SDK/CLI constructor caller was found for the specialized adapter; type-only imports do not execute it.
- Specialized adapter tests cannot assure real OpenRouter cost or multimodal metadata behavior in CLI runs.

### output-ceilings-and-truncation: partial

Entrypoint → implementation → real consumer: `sdk/src/provider-config.ts:153`, `sdk/src/provider-config.ts:174` → `sdk/src/impl/llm.ts:1345`, `sdk/src/impl/llm.ts:1752` → `sdk/src/impl/llm.ts:1795`, `common/src/types/contracts/llm.ts:66`.

Tests: `sdk/src/impl/__tests__/llm-tool-call-buffer.test.ts:339`. Docs: `docs/configuration.md:224`.

Failure: Provider length marks cut; invalid actual ceiling may produce provider error. Loading: Tools buffer until finish fact arrives. Empty: No configured ceiling uses provider/template default. Cancellation: Follows stream abort. Retry: No retry after delivered payload; truncation feedback belongs to runtime. Permission: Ceiling does not authorize oversized tool mutations; downstream validation still applies.

Strengths:

- Known length cuts survive as stream-only metadata to downstream validators.
- Per-model byte envelope and actual-token limit are distinct concepts with documented consumers.

Limits:

- Configured outputTokens is a default, not an enforced provider maximum; adapters may reject a larger template request. This precedence is documented, not a newly invented breaking change.
- maxOutputBytes is diagnostic only; it is not a hard output-memory/transport budget.
- OAuth backend treats output-token ceiling as a no-op per docs; no live cut/error behavior measured.

### native-gemini-protocol: absent

Entrypoint → implementation → real consumer: `sdk/src/provider-config.ts:351` → absent → no production caller found.

Tests: none in the reviewed path. Docs: `docs/request-flow.md:158`.

Failure: Native Gemini config type is not accepted. Loading: Not implemented. Empty: Not applicable. Cancellation: Not applicable. Retry: Not applicable. Permission: Gateway credentials follow normal BYOK configuration; no native permission path.

Strengths:

- Existing generic protocol and preserved tool metadata offer a starting point for a new native adapter.

Limits:

- Gemini is usable through an OpenAI-compatible gateway; direct Gemini API transport is absent in the reviewed source-selected routing path.
- Adding a vendor SDK is an optional protocol capability decision, not proof that current BYOK gateway support is defective.

## All eight audit domains

| Domain | Assessment |
|---|---|
| security | Reviewed provider schema validation, HTTPS credential transport, loopback-only unauthenticated HTTP, ancestor-source trust stripping, readonly-root provenance and no-hosted-fallback boundaries. No new concrete exploit was validated in this lane. Project/explicit provider config is deliberately trusted; discovery, credential persistence and arbitrary tool permission security are not fully re-audited here. |
| correctness | Real routing/stream/tool paths are present. Offline production probes establish status-wrapper/SSE normalization gaps, usage/cost loss, backup credential coupling and configured reasoning/OAuth control mismatch. Advisory tool metadata is distinguished from operational provider compatibility. |
| state-mutation | Pending tool buffers reset per attempt; delivered-content gate prevents unsafe replay; cost/cache observers use step-local accumulators; CLI send ownership protects authoritative completion; backoff/diagnostic listeners clean up. OAuth rate-limit state is process-global and configured routes do not honor it; config cache returns shared mutable data and fragmented atomic-write scopes were inspected without a crash/concurrent-writer test. |
| error-handling | Finite request/post-stream bounds and shared header-aware retry helper are strong existing infrastructure. Production streaming bypasses that helper, HTTP SDK wrappers obscure status, in-band errors flatten status, and OAuth skip recovery does not select a different configured transport. Suggested fixes retain delivered-content safety. |
| performance | Assessed tool/stream buffering, synchronous config dependency discovery, metadata waits, retry multiplication/wrapper effects and diagnostics worker-pool wiring. Cache invalidation rediscovering fragment files is deliberate. No throughput/latency/RSS measurements or known-vulnerability assertions are made.02-F7 demonstrates avoidable retry calls without fabricating timings. |
| dependency-hygiene | SDK declares ai and pinned @ai-sdk/anthropic; internal package declares @ai-sdk/provider/provider-utils and ai with compatible V2 interfaces. Shared workspace packages are deliberately bundled. Semver ranges and manifest declarations were inspected; registry/CVE/lock integrity and published dist were outside this lane. Installed AI SDK retry wrapper source was inspected only as probe context, excluded from native receipt. |
| test-coverage | 62 existing tests passed across retry policy, tool buffering, cost helper and the two adapters;9 offline current-behavior probes passed. These expose production wiring failures despite green helpers. OAuth tests are classifier-only; metadata error tests assert prose rather than classifier properties; usage test enables an option never enabled by the production constructor. No real API/live provider, CLI TUI end-to-end or OAuth refresh test was run. |
| api-contract | Checked provider config, compatibility controls, shared StreamChunk/truncation shape, CLI status consumer and configured routing docs. Failover after5xx and reasoning effort differ from production behavior. Per-model tools/caching metadata is advisory. Legacy-window helper and specialized OpenRouter/failover-floor helpers are not default runtime capabilities. OutputTokens precedence and output-byte diagnostic scope are documented limitations. |

## Grounded plan work

- **P0 — provider-canonical-errors-single-retry-owner** (02-F1, 02-F2, 02-F7): Create a provider error contract preserving HTTP/in-band code, status, retry hints and cause; disable hidden SDK retries and use the same policy for streaming/non-streaming/structured requests with the no-delivered-content guard. Acceptance: Real fake-HTTP503 and fake-SSE503 fixtures exhaust bounded primary attempts then recover on configured backup; policy errors use one attempt;429 obeys bounded Retry-After; abort and safe buffered-tool tests remain green.
- **P0 — provider-truthful-accounting** (02-F3): Separate response accounting from request metadata stripping, negotiate terminal usage, emit provenance-bearing unknown/estimated/provider-reported cost and usage, and preserve precision/currency until display. Correlate with the root's hard-budget/terminal-truthfulness milestone. Acceptance: Both20k/10k fake streams report21 cents and identical runtime totals with stripping on/off; no-usage endpoints produce unknown rather than0; callback provenance separates successful and billed failed attempts.
- **P1 — provider-capacity-without-secrets** (02-F4): Split metadata-only route resolution from credential/client construction; expose primary and backup readiness separately. Snapshot effective attempt route/capabilities once. Acceptance: Missing backup key cannot prevent healthy primary or pre-run capacity lookup; failure of the primary produces a precise backup readiness outcome.
- **P1 — provider-reasoning-options-contract** (02-F5): Unify generic/configured provider-options namespaces and effort precedence, with actual wire-request tests across arbitrary provider IDs. Acceptance: local/custom/openai IDs transmit identical configured effort; route/template/default/adaptive precedence is verified at the HTTP body.
- **P1 — provider-explicit-oauth-recovery** (02-F6): Replace recursive same-route OAuth fallback with explicit configured BYOK recovery candidates; honor skip/rate-limit state across configured/implicit OAuth paths. Acceptance: A pre-content429 or failed refresh never reselects excluded OAuth; backup runs or an actionable terminal error results, with credential/network seams injected.
- **P2 — provider-conformance-suite-and-capability-contract**: Build protocol-level fake-server/stream fixtures from entrypoint through runtime consumer, covering malformed tools, empty stream, late usage, cancellation, context limit and status metadata. Mark model tools/cache/structured metadata advisory or wire deliberate per-model negotiation; reuse specialized adapter code only after production caller selection is explicit. Acceptance: Fixture matrix runs without keys or network and asserts request bodies, stream payloads, terminal state, cost/usage provenance and CLI-visible events; passing helper tests alone do not mark a capability usable.
- **P2 — multilingual-recommendation-evidence**: Keep the wired opt-in /models recommend path, define a comparable benchmark receipt and a reviewed evaluation-to-quality update seam before automatic language/task routing. Native Gemini transport should be added only with a clear protocol/feature need and conformance target. Acceptance: Recommendations cite language/task/role, sample size, benchmark/version and measurement date; missing evidence stays explicit; explicit routes are preserved until the user opts into automatic selection.

## Coverage and inspection receipt

- Receipt covers41 inventory files with64 exact sampled/merged ranges; large provider/run files were not audited line-for-line. Selected picker ranges were read, with adjacent production consumers added.
- Read-only source audit; only owned /tmp reports and offline probe artifacts were created. No source implementation or source test files were changed.
- Nine offline probes pin CURRENT observed behavior. Their passing result is reproduction evidence, not acceptance that these defects are fixed.62 existing tests passed separately under pinned Bun1.3.5.
- No external API calls, credential/private provider configuration values, private logs or secret environment values were inspected. Config fixtures and the OAuth credential function response were synthesized.
- Installed node_modules/ai/dist/index.mjs retry/error source was consulted for probe interpretation; not included as a current inventory source in structuralReceipt.
- Provider discovery transport, OAuth credential persistence/real refresh, Responses transformer internals, embedding generation and API-dependent concurrent/subagent e2e tests were not fully reviewed in this lane.
- Native Openbuff query_index/read_files/coverage tools are not exposed in this Codex session; discovery used picker artifacts, rg and exact numbered reads. Root will run native receipt validation.
- Capability quality is not model intelligence/accuracy. No provider benchmark, cost accuracy measurement or claim of best possible performance is made.
- Automatic benchmark-to-routing learning/measurement producers were not traced across evals; existing /models recommend is an opt-in configured evidence lookup.

Exact read ranges (inspection does not mean every line in each file was audited):

| Current file | Read ranges |
|---|---|
| `cli/src/__tests__/unit/openbuff-provider-readiness.test.ts` | 1–47 |
| `cli/src/commands/command-registry.ts` | 954–988 |
| `cli/src/components/provider-picker-screen.tsx` | 330–383 |
| `cli/src/hooks/use-send-message.ts` | 655–851 |
| `cli/src/utils/__tests__/provider-diagnostics.test.ts` | 1–82 |
| `cli/src/utils/openbuff-provider.ts` | 302–348, 485–566, 987–1048 |
| `cli/src/utils/provider-diagnostics.ts` | 1–59 |
| `cli/src/utils/sdk-event-handlers.ts` | 2195–2270 |
| `common/src/types/contracts/llm.ts` | 1–280 |
| `docs/architecture.md` | 155–177 |
| `docs/configuration.md` | 140–265 |
| `docs/local-mode.md` | 176–299 |
| `docs/request-flow.md` | 131–195 |
| `docs/testing.md` | 1–68 |
| `packages/agent-runtime/src/prompt-agent-stream.ts` | 1–150 |
| `packages/agent-runtime/src/run-agent-step.ts` | 720–750, 792–856, 1000–1078, 1560–1618 |
| `packages/internal/package.json` | 1–51 |
| `packages/internal/src/openai-compatible/chat/convert-to-openai-compatible-chat-messages.ts` | 1–178 |
| `packages/internal/src/openai-compatible/chat/openai-compatible-chat-language-model.test.ts` | 1–110, 234–365 |
| `packages/internal/src/openai-compatible/chat/openai-compatible-chat-language-model.ts` | 1–322, 414–1078 |
| `packages/internal/src/openai-compatible/chat/openai-compatible-chat-options.ts` | 1–25 |
| `packages/internal/src/openai-compatible/openai-compatible-error.ts` | 1–80 |
| `packages/internal/src/openrouter-ai-sdk/chat/index.ts` | 395–835 |
| `packages/internal/src/openrouter-ai-sdk/tests/stream-usage-accounting.test.ts` | 1–224 |
| `sdk/package.json` | 1–93 |
| `sdk/src/__tests__/model-provider.test.ts` | 200–421, 761–859, 948–1090, 1428–1503, 1729–1930 |
| `sdk/src/__tests__/retry-config.test.ts` | 196–469 |
| `sdk/src/env.ts` | 47–67 |
| `sdk/src/error-utils.ts` | 1–227 |
| `sdk/src/impl/__tests__/llm-chatgpt-oauth-policy.test.ts` | 1–67 |
| `sdk/src/impl/__tests__/llm-context-window.test.ts` | 1–168, 280–365, 706–721 |
| `sdk/src/impl/__tests__/llm-cost.test.ts` | 1–153 |
| `sdk/src/impl/__tests__/llm-repair-tool-input.test.ts` | 1–47 |
| `sdk/src/impl/__tests__/llm-tool-call-buffer.test.ts` | 1–396 |
| `sdk/src/impl/agent-runtime.ts` | 1–30, 180–246 |
| `sdk/src/impl/failover.ts` | 1–101 |
| `sdk/src/impl/llm.ts` | 277–348, 515–565, 791–2399 |
| `sdk/src/impl/model-provider.ts` | 1–989 |
| `sdk/src/provider-config.ts` | 1–365, 1069–1523, 1630–1707, 1868–2137, 2189–2221, 2533–2915 |
| `sdk/src/retry-config.ts` | 1–154, 178–523 |
| `sdk/src/run.ts` | 743–1040, 1780–1847 |

The JSON report contains the native-compatible structural receipt, capability chains/states, finding evidence, verification commands, and plan acceptance probes. It excludes installed dependency source and /tmp fixtures from inventory coverage.

