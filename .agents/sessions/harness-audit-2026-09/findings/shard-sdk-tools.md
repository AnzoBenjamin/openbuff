# Audit findings: shard-sdk-tools

- Subsystems: sdk-local-tool-execution, sdk-terminal-command-policy, sdk-filesystem-authority, sdk-workspace-mutation-broker, sdk-workspace-journal, sdk-provider-routing-failover, sdk-credentials, sdk-run-orchestration, sdk-file-change-hooks, sdk-read-files, sdk-node-filesystem, sdk-mutation-capabilities, sdk-provider-config, sdk-retry-config, sdk-concurrency, sdk-dependency-manifest
- Features: local-tool-execution, terminal-command-policy, filesystem-authority, workspace-mutation-broker, workspace-journal, provider-routing-failover, credentials-handling, run-orchestration, file-change-hooks, read-files-bounded-reads, node-filesystem-adapter, mutation-capabilities, provider-config-cache, retry-backoff
- Files covered: 35
- Snapshot: df9b2f192f10abc4503dfdc5a5a30643b0fd9ca84ef8d8cf5cd8988d93669cc1

## [HIGH] security — sdk/src/tools/terminal-command-policy.ts:1972 — WORKSPACE_DENY_PATTERNS bypassable via wrapper prefix (env/command/nice/nohup/timeout/busybox) in workspace-write
- **Risk:** In workspace-write (and any profile reaching the deny-pattern gate), prefixing a denied command with a recognized wrapper (`env`, `command`, `nice`, `nohup`, `timeout`, `time`, `setsid`, `busybox`) moves the denied executable off the command-start anchor, so `env sudo apt-get install -y evil` or `command sudo rm ...` bypasses the privilege-escalation and system-package deny patterns while the same command typed directly is refused. The env-dump resolver unwraps exactly these wrappers for dump detection but the deny patterns are only matched against the raw string, contradicting the tool schema's 'allow-all suppresses prompts without disabling non-negotiable containment' guarantee.
- **Fix:** Run WORKSPACE_DENY_PATTERNS against the resolved first executable (reuse resolveEnvironmentDumpCommand/resolveTmuxCommand output, as hasUnsafeTmuxGitCommand already does) in addition to the raw command, so `env sudo ...`, `command sudo ...`, `nice sudo ...`, `timeout 10 sudo ...`, and `busybox sudo ...` fail closed the same as bare `sudo ...`.
- **Evidence:** terminal-command-policy.ts: WORKSPACE_DENY_PATTERNS entries are all anchored `^(?:sudo|su)\b` / `^(?:apt|apt-get|...)\b`; findProcessEnvironmentIssue resolves `env` wrappers via resolveEnvironmentDumpCommand and returns no issue for a non-dumper executable, and evaluateTerminalCommandPolicy only tests the raw command string against WORKSPACE_DENY_PATTERNS, so `env sudo apt-get install -y pkg` (workspace-write) reaches `{ allowed: true }`.

## [MEDIUM] state-mutation — sdk/src/tools/read-files.ts:460 — Local mapWithConcurrency duplicate drops the shared helper's first-failure-wins contract, leaving in-flight reads unawaited on rejection
- **Risk:** planNativeReads uses a private mapWithConcurrency that has no failure capture: if one authorizeReadTarget/readCanonicalSnapshot rejects, Promise.all rejects immediately while other workers keep issuing unawaited filesystem reads (background IO the caller can no longer observe), and items past the failure point are never reported. The shared tools/concurrency.ts helper documents and implements the opposite contract (first failure wins, started calls awaited before rethrow). The two implementations can drift.
- **Fix:** Delete the local duplicate in read-files.ts and import mapWithConcurrency from tools/concurrency.ts (it already returns index-aligned results, awaits started calls, and rethrows the first error).
- **Evidence:** read-files.ts defines a private async function mapWithConcurrency whose worker loop is `while (nextIndex < values.length) { throwIfAborted(signal); ... await map(...) }` with no `failure` capture, while tools/concurrency.ts exports the corrected implementation used by other tools.

## [MEDIUM] error-handling — sdk/src/impl/chatgpt-backend-fetch.ts:527 — transformResponseStream swallows pipe errors, converting a failed backend stream into a silently truncated completion
- **Risk:** When the ChatGPT backend connection drops mid-response, pipeTo rejects, the catch discards the error, and the transformed readable ends cleanly — the AI SDK treats it as a complete (short) response. Retries and failover never trigger because no error is raised, and the agent proceeds on truncated model output.
- **Fix:** Capture the TransformStream controller and call controller.error(...) in the pipeTo rejection (and/or convert known aborts to cancel), so a failed backend stream surfaces as an LLM stream error eligible for the existing retry/failover classification instead of silently truncated output.
- **Evidence:** chatgpt-backend-fetch.ts: `inputStream.pipeTo(transform.writable).catch(() => {})` is the only error path for the source stream; no branch ever calls controller.error() on the returned readable.

## [MEDIUM] state-mutation — sdk/src/credentials.ts:245 — Non-atomic rewrite of credentials.json can corrupt stored user API key on crash mid-write
- **Risk:** saveChatGptOAuthCredentials rewrites the entire credentials file (including the stored default user API key) in place with fs.writeFileSync. A crash, disk-full, or power loss mid-write truncates/corrupts credentials.json, silently logging the user out of both Codebuff and ChatGPT OAuth; there is no temp-file+rename despite the codebase having atomic-write helpers elsewhere (writeJsonFileAtomic, broker writeJsonDurable).
- **Fix:** Write to a temp file in the same dir with mode 0600, fsync, then rename over credentials.json (the codebase already has this pattern in provider-config writeJsonFileAtomic and workspace-mutation-broker writeJsonDurable).
- **Evidence:** credentials.ts saveChatGptOAuthCredentials: `fs.writeFileSync(credentialsPath, JSON.stringify(updatedData, null, 2), { mode: 0o600 })` — no temp file, no rename; clearChatGptOAuthCredentials rewrites the same way after `delete existingData.chatgptOAuth`.

## [MEDIUM] performance — sdk/src/credentials.ts:300 — No negative cache/backoff for failed ChatGPT OAuth refresh — each LLM request re-pays the network round-trip
- **Risk:** refreshChatGptOAuthToken returns null on failure and nothing records the failure. getValidChatGptOAuthCredentials re-attempts the refresh on every subsequent LLM request, so when the token endpoint is down or the refresh token is revoked, every model call pays a fresh network round-trip (up to CHATGPT_OAUTH_REFRESH_TIMEOUT_MS = 30s) before failing, stalling runs and multiplying load on the auth endpoint.
- **Fix:** Memoize refresh failures with a short TTL (e.g. 30–60s negative cache), and/or short-circuit getValidChatGptOAuthCredentials to null while a previous refresh for the same env recently failed.
- **Evidence:** credentials.ts refreshChatGptOAuthToken has no failure memoization; impl/llm.ts promptAiSdkStream calls getModelForRequest per attempt, and model-provider.ts getModelForRequest awaits getValidChatGptOAuthCredentials on every call for chatgpt-oauth providers.

## [MEDIUM] performance — sdk/src/provider-config.ts:1248 — Provider-config 'fast path' performs a full recursive config walk + stat per call on the LLM hot path
- **Risk:** loadProviderConfigSync is called on every LLM request (getModelForRequest, promptAiSdkStream) plus per run() (run.ts ~615). The 'fast path' computes buildProviderConfigCacheKey first, which recursively walks extends/include/openbuff.d fragments (existsSync + readFileSync + JSON.parse per node) and then statSyncs every dependency — synchronous IO on the event loop per model request. A config with many fragments or a populated openbuff.d directory turns every request into a multi-file synchronous walk.
- **Fix:** Cache the resolved dependency-path list per config-path set (only re-stat mtimes per call), or use a fs.watch/poll-based invalidation so the hot path does a bounded number of stat calls.
- **Evidence:** provider-config.ts loadProviderConfigSync: `const cacheKey = buildProviderConfigCacheKey(configPaths, explicitConfigPath)` runs before `if (providerConfigCache && providerConfigCache.key === cacheKey)`; buildProviderConfigCacheKey calls collectProviderConfigDependencyPaths (which readFileSync+JSON.parse every config) and then statSync every dependency.

## [MEDIUM] dependency-hygiene — sdk/package.json:28 — engines.node >=18 contradicts required Node 20+ APIs (AbortSignal.any) used on the mandatory run path
- **Risk:** The SDK declares engines.node >=18.0.0, but core paths use AbortSignal.any (run.ts runSignal construction, Node >= 20.3), global crypto.randomUUID (Node 19+), and AbortSignal.timeout (fine on 18). On a declared-supported Node 18 runtime, every run() with or without a caller signal throws 'AbortSignal.any is not a function' at startup — the engines field under-declares the true floor and no CI matrix guards it.
- **Fix:** Raise engines to node >=20.3 (or >=20 LTS) and add a CI job on the oldest supported Node to catch runtime-version-only APIs before release.
- **Evidence:** sdk/package.json: `"engines": { "node": ">=18.0.0" }`; run.ts uses `AbortSignal.any([signal, timeoutAbortController.signal])`; credentials.ts uses `AbortSignal.timeout(...)` and `crypto.randomUUID()` as a global.

## [MEDIUM] test-coverage — sdk/src/tools/concurrency.ts:1 — No direct tests for the shared mapWithConcurrency failure/abort contract that other tools rely on
- **Risk:** The shared bounded fan-out documents a precise contract (RangeError on non-positive/non-integer concurrency, index-aligned results, first failure rethrown only after all started calls settle, no further items started) but no dedicated test file exists (no concurrency test found under sdk/src). Regressions in this helper would surface as flaky cross-tool IO bugs rather than a focused failure.
- **Fix:** Add a unit test asserting: (1) first mapper rejection is the rethrown error, (2) started promises settle before return, (3) no item past the failure is started, (4) RangeError on concurrency < 1 / non-integer.
- **Evidence:** sdk/src/tools/concurrency.ts is exported and referenced by read-files tests only indirectly; `glob sdk/src/**/__tests__/*concurrency*.test.ts` returns 0 files.

## [LOW] test-coverage — sdk/src/__tests__/credentials.test.ts:208 — Missing tests for concurrent OAuth refresh single-flight and cross-env promise sharing
- **Risk:** The module-level chatGptRefreshPromise single-flight ignores the clientEnv argument: a second concurrent caller with a different injected env receives the first caller's refresh result, and saveChatGptOAuthCredentials writes to the first caller's config dir. This cross-env behavior is undocumented and untested; a multi-root host or parallel test suite can persist tokens into the wrong config directory.
- **Fix:** Add tests for (a) two concurrent refreshes sharing one HTTP call, and (b) concurrent callers with distinct clientEnv values receiving credentials persisted to their own config dir (or pin the documented behavior).
- **Evidence:** credentials.test.ts refreshChatGptOAuthToken describe block covers only sequential success and missing-refresh cases; no `Promise.all([refreshChatGptOAuthToken(a), refreshChatGptOAuthToken(b)])` assertion exists.

## [LOW] security — sdk/src/tools/run-terminal-command.ts:33 — validateStagedCommit sensitive-path regex misses .envrc and id_ecdsa key material
- **Risk:** The git-commit profile's staged-diff guard blocks `.env`, `.env.*`, `id_rsa`, `id_ed25519`, credentials.json/yaml, and *.pem/p12/pfx, but not `.envrc` (direnv files routinely carry exported secrets) nor `id_ecdsa`/`id_dsa` SSH keys. A commit staging `.envrc` or `id_ecdsa` passes the safety policy and is pushed by an allowed `git push`.
- **Fix:** Extend the pattern with `\.envrc` and the standard id_(rsa|dsa|ecdsa|ed25519)(_sk)? key basenames, keeping the same fail-closed shape.
- **Evidence:** run-terminal-command.ts SENSITIVE_STAGED_PATH = /(^|\/)(\.env($|\.)|id_rsa|id_ed25519|credentials(?:\.(?:json|ya?ml))?|.*\.(?:pem|p12|pfx))$/i — no `.envrc`, no `id_ecdsa`/`id_dsa` alternatives.

## [LOW] security — sdk/src/tools/terminal-command-policy.ts:1886 — Bare ${HOME} expansion evades the home-directory outside-project check
- **Risk:** findOutsideAbsolutePath refuses `~`, `~/...`, `$HOME`, `$HOME/...`, and `${HOME}/...` tokens, but a bare `${HOME}` operand (e.g. `ls ${HOME}` in workspace-write) matches none of those shapes and is not an absolute path, so it slips past both the home check and the absolute-path scan. Inconsistent with the equivalent `$HOME` form which is refused.
- **Fix:** Add `token === '${HOME}'` to the home-token check (or test the parameter-expansion family uniformly).
- **Evidence:** terminal-command-policy.ts findOutsideAbsolutePath home checks: `token === '~' || token.startsWith('~/') || token === '$HOME' || token.startsWith('$HOME/') || token.startsWith('${HOME}/')`; the bare `${HOME}` token satisfies none of these.

## [LOW] correctness — sdk/src/run.ts:2564 — extractStatusCodeFromMessage substring matching yields false-positive status codes (e.g. '408' anywhere in a message)
- **Risk:** extractStatusCodeFromMessage uses raw substring matches: any error message containing '408' (e.g. a file count, a model name like gpt-0408) classifies as a timeout, and '500' inside unrelated text classifies as a server error. A wrong statusCode changes retry/failover behavior (408/429 are retry-only; 401/403 trigger failover). Additionally, handlePromptResponse resolves prompt-error with initialSessionState, discarding any session progress the runtime made (unlike the callMainPrompt catch path which uses getCancelledSessionState).
- **Fix:** Prefer structured status fields (apiErrorDetails) over message scraping; when scraping is required, match word-bounded status tokens (`\b503\b`) and document the heuristic as a fallback only.
- **Evidence:** run.ts extractStatusCodeFromMessage: `errorMessage.includes('503') || lowerMessage.includes('service unavailable')` — no word-boundary or structured-field check; run.ts:2695 returns `initialSessionState` for prompt-error responses.

## [LOW] performance — sdk/src/services/workspace-mutation-broker.ts:517 — Broker receipts directory grows without bound; listReceipts does serial O(n) IO over it
- **Risk:** Every committed/rejected/failed mutation appends a JSON receipt under the broker receiptsDir and nothing ever prunes them. listReceipts() (used by tooling/diagnostics) readdir's the whole directory and awaits readJson serially, so both disk usage and listing latency grow without bound over the life of a workspace, and one corrupt receipt file makes the entire listing throw.
- **Fix:** Cap the listing (read newest N by name order), skip/recover malformed receipts instead of throwing, and add retention pruning for terminal receipts older than a configurable age.
- **Evidence:** workspace-mutation-broker.ts listReceipts: `for (const name of names) { receipts.push(await this.readJson(...)) }` with `.sort()` on the full directory listing; nothing ever deletes files from this.receiptsDir.

## [LOW] api-contract — common/src/tools/params/tool/run-terminal-command.ts:110 — Model-facing run_terminal_command schema exposes an owner field that is silently overridden at runtime
- **Risk:** The model-facing input schema publishes an optional `owner` object (clientSessionId/rootRunId/parentRunId/parentAgentId) even though run.ts handleToolCall always overrides it with the trusted run identity. The schema text says 'agents must omit' but the field remains accepted-and-ignored — a contract smell that invites models to attempt ownership spoofing and gives no error signal when they do.
- **Fix:** Strip/reject `owner` at the model-facing schema boundary (z.strip() or an explicit refusal) rather than accepting-then-ignoring it, so the wire contract matches the trust model.
- **Evidence:** common/src/tools/params/tool/run-terminal-command.ts inputSchema declares an optional `owner` object described as 'Runtime-managed background job owner; agents must omit.'; run.ts handleToolCall run_terminal_command branch: `owner: trustedJobOwner` placed after the terminalInput spread.

## [LOW] correctness — sdk/src/run.ts:727 — runOnce uses require('child_process') which is unavailable in strict ESM builds
- **Risk:** runOnce falls back to `require('child_process').spawn` for the spawn source. The package ships ESM (type: module, dist/*.mjs export); in a strict ESM context without a CJS shim, `require` is undefined and every run without an injected spawnSource throws ReferenceError instead of starting. Works under bun/CJS interop, but the default path is environment-dependent.
- **Fix:** Use a static `import { spawn } from 'node:child_process'` and only keep the injectable spawnSource override for tests.
- **Evidence:** run.ts `spawn = require('child_process').spawn as CodebuffSpawn` in the else branch of the spawnSource check; the file's other imports are ESM `import` statements.

## [LOW] error-handling — sdk/src/tools/file-change-hooks.ts:51 — Inferred/configured file-change hooks run with no timeout by default (-1), so one hung hook stalls the run
- **Risk:** runFileChangeHooks executes every matching hook with timeout_seconds = -1 (no wall-clock bound) unless the project opts in per hook. A hook that hangs (e.g. a dev-server script or a tool waiting on stdin) blocks the whole verification gate and the run indefinitely; runTerminalCommand honors -1 as 'infinite timeout' by design. A best-possible harness defaults to a finite cap and treats -1 as explicit opt-out.
- **Fix:** Default hooks to a finite timeout (e.g. 300s) with an explicit opt-out value, and surface per-hook timeout results in the hook output payload.
- **Evidence:** file-change-hooks.ts: `const HOOK_DEFAULT_TIMEOUT_SECONDS = -1` with comment 'Hooks are unbounded by default; -1 means no timeout'; runTerminalCommand: `if (timeout_seconds >= 0) { timer = setTimeout(...) }`.

## [LOW] error-handling — sdk/src/impl/llm.ts:1267 — No per-attempt inactivity deadline on provider streams; only caller abort/run timeout can break a stalled stream
- **Risk:** The attempt loop bounds retries by count but never by time: if a provider accepts the request and then stalls mid-stream (no chunks, no FIN), the for-await over response.fullStream blocks indefinitely unless the caller supplied a runTimeoutMs. Sub-agents or hosts that don't set runTimeoutMs inherit an unbounded hang; a best-possible harness applies a per-request or inactivity deadline to every provider call.
- **Fix:** Arm a per-attempt inactivity deadline (reset on each chunk) that aborts the attempt via the existing signal plumbing so the retry/failover machinery classifies it like any other transient error.
- **Evidence:** impl/llm.ts promptAiSdkStream: `for await (const chunkValue of response.fullStream)` has no deadline wrapper; the only timeout on the path is the optional run-level runTimeoutMs in run.ts.

## [LOW] dependency-hygiene — sdk/package.json:44 — Mixed exact/caret version pinning across runtime dependencies
- **Risk:** The dependency manifest pins some runtime deps exactly (@ai-sdk/anthropic 2.0.50, diff 8.0.3, web-tree-sitter 0.25.10) but floats others with carets (ai ^5.0.52, zod ^4.2.1, micromatch ^4.0.8, ws ^8.18.0) in a published SDK. Floating ranges let a transitive minor bump change provider request behavior between installs; there is no audit/pinning policy comment or lockfile-level enforcement visible for the shipped surface.
- **Fix:** Pick one policy (exact pins for runtime deps via lockfile enforcement), and add automated vulnerability scanning so the choice is enforced in CI.
- **Evidence:** sdk/package.json dependencies: `"@ai-sdk/anthropic": "2.0.50"` (exact) vs `"ai": "^5.0.52"`, `"zod": "^4.2.1"`, `"micromatch": "^4.0.8"` (floating).

## [LOW] performance — sdk/src/tools/node-filesystem.ts:64 — readNodeTextRange scans the whole file for any range request (documented, but O(file) per range)
- **Risk:** readNodeTextRange streams and scans the entire file byte-by-byte on every bounded range read to compute totalLines, even when the caller asked for lines 1000-1005 of a 500MB log. The comment documents memory-boundedness but not the O(file-size) IO cost per range read; repeated range reads of an oversized file re-scan the whole file each time.
- **Fix:** Track lastNewlineOffset while streaming and, when the requested window's bytes cannot fit before EOF, seek/short-circuit the tail once the window plus one line past endExclusive is satisfied.
- **Evidence:** node-filesystem.ts readNodeTextRange: `for await (const chunkValue of createReadStream(filePath))` walks all bytes, accumulating totalLines even when the requested window is tiny; MAX_RANGE_READ_BYTES bounds memory but not IO.

## [LOW] state-mutation — sdk/src/run.ts:712 — Mutation broker creation failure silently downgrades the run to a broker-less filesystem for its entire lifetime
- **Risk:** If WorkspaceMutationBroker.create throws (e.g. state dir unwritable, lock timeout during initialize), runOnce silently downgrades to a broker-less filesystem: conditionalCommit/Delete/Move capabilities disappear and every guarded edit fails closed for the whole run. The logger?.warn is the only signal — the run result carries no degraded-authority flag, so hosts cannot distinguish full-authority from fail-closed runs.
- **Fix:** Retry broker creation (it may have failed on a transient lock timeout), or hard-fail the run when guarded mutations are required; at minimum mark the capability tier in telemetry so degraded runs are observable.
- **Evidence:** run.ts runOnce: `fs = createNodeFileSystem({ mutationBroker })` only on success; the catch logs 'Workspace mutation broker unavailable; guarded mutations will fail closed' and constructs `createNodeFileSystem()` (no broker).

## Coverage receipt

### Subsystems
- sdk-local-tool-execution
- sdk-terminal-command-policy
- sdk-filesystem-authority
- sdk-workspace-mutation-broker
- sdk-workspace-journal
- sdk-provider-routing-failover
- sdk-credentials
- sdk-run-orchestration
- sdk-file-change-hooks
- sdk-read-files
- sdk-node-filesystem
- sdk-mutation-capabilities
- sdk-provider-config
- sdk-retry-config
- sdk-concurrency
- sdk-dependency-manifest

### Features
- local-tool-execution
- terminal-command-policy
- filesystem-authority
- workspace-mutation-broker
- workspace-journal
- provider-routing-failover
- credentials-handling
- run-orchestration
- file-change-hooks
- read-files-bounded-reads
- node-filesystem-adapter
- mutation-capabilities
- provider-config-cache
- retry-backoff

### Files
- sdk/src/client.ts
- sdk/src/run.ts
- sdk/src/run-state.ts
- sdk/src/credentials.ts
- sdk/src/provider-config.ts
- sdk/src/retry-config.ts
- sdk/src/impl/model-provider.ts
- sdk/src/impl/llm.ts
- sdk/src/impl/failover.ts
- sdk/src/impl/chatgpt-backend-fetch.ts
- sdk/src/tools/read-files.ts
- sdk/src/tools/node-filesystem.ts
- sdk/src/tools/filesystem-authority.ts
- sdk/src/tools/mutation-capabilities.ts
- sdk/src/tools/run-terminal-command.ts
- sdk/src/tools/terminal-command-policy.ts
- sdk/src/tools/concurrency.ts
- sdk/src/tools/file-change-hooks.ts
- sdk/src/services/workspace-mutation-broker.ts
- sdk/src/services/workspace-journal.ts
- sdk/src/__tests__/credentials.test.ts
- sdk/src/__tests__/filesystem-authority.test.ts
- sdk/src/__tests__/workspace-mutation-broker.test.ts
- sdk/src/__tests__/terminal-command-policy.test.ts
- sdk/src/__tests__/run-terminal-command.test.ts
- sdk/src/__tests__/read-files.test.ts
- sdk/src/__tests__/file-change-hooks.test.ts
- sdk/src/__tests__/chatgpt-backend-fetch.test.ts
- sdk/src/__tests__/model-provider.test.ts
- sdk/src/__tests__/retry-config.test.ts
- sdk/src/impl/__tests__/failover.test.ts
- sdk/src/impl/__tests__/failover-integration.test.ts
- sdk/src/tools/__tests__/list-directory.test.ts
- common/src/tools/params/tool/run-terminal-command.ts
- sdk/package.json

### Domains
- security
- correctness
- state-mutation
- error-handling
- performance
- dependency-hygiene
- test-coverage
- api-contract
