# Audit findings: r1-sdk-mutation-core

- Subsystems: sdk-mutation-core, sdk-tool-dispatch, filesystem-authority, workspace-mutation-broker, transaction-intent-log, harness-enforcement, agent-runtime-seam, llm-provider-adapter
- Features: file_mutation_result_v1_receipts, cap_v3_edit_anchor_freshness, conditional_commit_cas_authority, transaction_intent_log_recovery, terminal_permission_profiles, harness_high_impact_classification, approval_receipt_grant_consume, file_change_hooks_and_diagnostic_preflight, process_supervision_seam, client_mcp_first_call_approval, workspace_journal_advance, run_timeout_and_cancellation, override_attestation_downgrade, node_filesystem_bounded_range_read
- Files covered: 22
- Snapshot: d2df71d608d67a3324faf6271f018ab600c00fab18ad1a67b7964172d6289935

## [HIGH] security — sdk/src/tools/filesystem-authority.ts:86 — Owned-temp executable-extension blocklist omits native/binary executables (.exe, .dll, .so, .jar, .wasm, .msi, .vbs, .com, .scr)
- **Risk:** The header comment states this extension set is the ONLY defense against a file-changing tool staging an executable under an OS temp root for a later terminal command to execute. Missing .exe/.dll/.so/.jar/.wasm/.msi/.vbs/.com/.scr means a staged Windows PE (payload.exe), a .jar for 'java -jar', a .wasm runtime target, or a shared library can be created in /tmp by write_file/edit_transaction and executed by the very next run_terminal_command, defeating the stated terminal-policy-bypass invariant. Interpreter one-liners are refused but 'java -jar /tmp/x.jar' and binary execution are not covered by terminal-command-policy either.
- **Fix:** Add .exe/.dll/.so/.dylib/.jar/.wasm/.msi/.vbs/.com/.scr/.psm1/.elf to the refusal set; better, create the harness's own 0o700 noexec temp root for tool scratch writes instead of admitting the whole OS temp tree, so executability is a filesystem property rather than an extension list.
- **Evidence:** OWNED_TEMP_REFUSED_EXTENSIONS = new Set(['.sh','.bash','.zsh','.ksh','.command','.bat','.cmd','.ps1','.js','.mjs','.cjs','.jsx','.ts','.tsx','.mts','.cts','.py','.pyw','.pl','.rb','.lua','.php','.r','.jl','.tcl']) — no .exe/.dll/.so/.jar/.wasm; header comment: 'This is now the ONLY defense against a file-changing tool staging a script anywhere under an OS temp root'.

## [HIGH] security — sdk/src/services/harness-enforcement.ts:170 — High-impact command classifier is evaded by shell wrappers (sh -c / bash -c / eval) and unstripped prefixes (timeout, nice)
- **Risk:** classifySegment strips only command/exec/time/env/sudo/doas/xargs prefixes and classifySingleSegment has no branch for sh/bash/zsh/dash -c or eval. A command like 'bash -c "git push origin main"' or 'eval "git push --force"' splits into one segment whose head is bash/eval, matches no classifier regex, returns undefined, and the push executes in balanced mode with no approval and no harness metadata. Same for 'timeout 10 git push' (timeout is not a stripped wrapper, so the segment head is 'timeout'). The module docblock claims the classifier catches commands that cross trust boundaries; this is a direct evasion of that contract.
- **Fix:** Recursively classify the bodies of sh/bash/zsh/dash -c and eval segments (splitCommandSegments already extracts substitution bodies — extend it to -c string args), and add timeout/nice/ionice/stdbuf/flock/setsid handling to the wrapper strip list. Add a regression test: 'bash -c "git push origin main"' must classify as push.
- **Evidence:** classifySegment strips only /^(command|exec|time|env|sudo|doas|xargs)\s+/; classifySingleSegment matches /^git\s+push/ and friends but has no sh/bash -c or eval branch; balanced mode allows everything not classified and not default-branch push.

## [MEDIUM] api-contract — sdk/src/run.ts:2222 — Custom tool definitions bypass the external-mutation attestation downgrade that overrides are subject to
- **Risk:** The override path scans mutation-shaped results and downgrades any file_mutation_result that is not verified by verifyExternalMutation to outcome 'unconfirmed' with receiptId stripped. The custom-tool branch (toolName not in toolNames) returns customToolHandler.execute(...) directly, so a custom tool definition returning a file_mutation_result with outcome 'applied' and authorityReceipt flows to the model and downstream consumers (serve event-bridge, memory-v2 coordinator, base2 gate all consume getConfirmedAppliedActionsV1/fileMutationResultV1Schema) as an authority-backed receipt with zero attestation — exactly the self-certification the override guard exists to prevent. Divergent contract between the two extension mechanisms.
- **Fix:** Route custom-tool results through the same findFileMutationResult + verifyExternalMutation downgrade scan (downgrade to 'unconfirmed' like overrides), or reject file_mutation_result payloads from custom tool definitions outright. Add a test in run-mutation-dispatch.test.ts.
- **Evidence:** run.ts custom-tool branch 'return { output: ... customToolHandler.execute(input, { signal }) }' precedes the override block whose parsed-data downgrade runs only for the named tool set; post-dispatch block: 'const resultMutation = findFileMutationResult(result)' plus getConfirmedAppliedActionsV1 gate.

## [MEDIUM] api-contract — sdk/src/tools/change-file.ts:106 — Divergent error shapes between write tools: changeFile throws on containment refusal, replace_range/edit_transaction return structured results
- **Risk:** changeFile throws a bare Error on containment refusal while its sibling tools return structured failures: replace_range returns errorResult({file, errorMessage}) and changeFiles emits a not_applied receipt with FilesystemError code 'outside_project'. The thrown error is caught by handleToolCall's generic catch and collapsed to {errorMessage} with no 'file' field and no error code, so model-facing and host-facing consumers keying on file/error.code see a different shape for the same refusal depending on which edit tool fired. Three divergent error shapes for one policy decision.
- **Fix:** Return a structured not_applied file_mutation_result with FilesystemError code 'outside_project' (mirroring transactionFailureResult) instead of throwing, so all three write tools emit the same error shape.
- **Evidence:** change-file.ts:107-110 'throw new Error("file path is outside the project directory")'; replace-range.ts:74-79 errorResult(relativePath, 'file path is outside the project directory'); change-files' transactionFailureResult emits FilesystemError code 'outside_project'.

## [MEDIUM] error-handling — sdk/src/run.ts:2446 — SYNC run_terminal_command defaults to an infinite timeout (timeout_seconds ?? -1)
- **Risk:** runOnce dispatches run_terminal_command with timeout_seconds defaulting to -1, and runTerminalCommand treats timeout_seconds < 0 as 'no timer'. A SYNC command that hangs (waiting on stdin, a dead pipe, a network mount) with no explicit timeout and no AbortSignal never settles: the run is blocked indefinitely unless the host separately sets runTimeoutMs. This contradicts the harness's own bounded-default convention (file-change-hooks defaults hooks to 300s) and turns a common model omission into a whole-run hang.
- **Fix:** Default to a bounded timeout (e.g. 300s, matching the hook default) and treat -1 as an explicit opt-in, or arm a watchdog that force-resolves the tool result after a hard ceiling while the child continues as a background job.
- **Evidence:** run.ts: 'timeout_seconds: terminalInput.timeout_seconds ?? -1'; run-terminal-command.ts: 'if (timeout_seconds >= 0) { timer = setTimeout(...) }' and header comment 'infinite timeout when < 0'; contrast file-change-hooks.ts 'const HOOK_DEFAULT_TIMEOUT_SECONDS = 300'.

## [MEDIUM] performance — sdk/src/tools/change-file.ts:641 — edit_transaction performs three full-file reads plus repeated hashing per staged path (double validation across prepare, pre-commit recheck, and receipt verification)
- **Risk:** Each staged file is fully read and hashed three times per edit_transaction: (1) prepareTransactionChange reads full content, (2) the pre-commit recheck loop calls readOptionalText on every change again, (3) authority.issueCommittedReceipt re-snapshots every path (full read + sha256) to verify expectedFinalHashes — and when the broker-backed adapter is installed, WorkspaceMutationBroker.conditionalCommit itself hashes before and after. For N files near MAX_TRANSACTION_FILE_BYTES this is ~3N full-file reads + ~4N sha256 passes per transaction, doubling latency and memory churn for multi-MB edits. The pre-commit recheck adds nothing the subsequent conditionalCommit CAS (expectedHash vs live hash inside the lock) does not already enforce.
- **Fix:** Carry the prepare-time hash into the pre-commit recheck (compare hashes instead of re-reading full content — or drop the recheck since the CAS subsumes it), and thread the broker's post-commit committedHash into issueCommittedReceipt instead of re-snapshotting every path.
- **Evidence:** prepareTransactionChange: 'const beforeContent = await readOptionalText(...)'; recheck loop: 'for (const change of prepared) { const currentSource = await readOptionalText(...) }'; filesystem-authority.issueCommittedReceipt: 'const snapshot = await this.snapshot(authorized)' per expectedFinalHashes entry; WorkspaceMutationBroker.readHash: 'exactHash(await fs.readFile(filePath))'.

## [LOW] state-mutation — sdk/src/services/workspace-mutation-broker.ts:521 — Broker receipts directory grows without bound: listReceipts bounds reads but nothing prunes finalized receipt files
- **Risk:** listReceipts caps how many receipt files are READ (newest 500) but nothing ever deletes final receipts; every brokerRevision appends one JSON file per mutation, forever, across sessions. Long-lived workspaces accumulate unbounded files in the state dir (state-dir disk growth and readdir cost growth for recoverPendingReceipts/listReceipts); pending receipts are cleaned but final ones are not.
- **Fix:** During initialize (under the workspace lock), keep the newest K receipts and unlink older final receipts, or move pruning behind a periodic/size-triggered sweep; keep pending receipts and recovery-relevant receipts exempt.
- **Evidence:** listReceipts: '.sort().slice(-RECEIPT_LIST_LIMIT)' with comment 'no pruning this session'; no unlink/rename of aged receipt files anywhere in the class; receiptsDir is mkdir'd in initialize.

## [LOW] security — sdk/src/tools/run-terminal-command.ts:30 — Staged-commit secret scan matches only OpenSSH PEM headers and AKIA keys
- **Risk:** The git-commit profile's staged-diff safety gate detects only PEM private-key headers and AWS AKIA access keys. GitHub (ghp_/gho_/github_pat_), Slack (xoxb-), Stripe (sk_live_), GitLab (glpat-), and generic Bearer tokens in a staged diff sail through, so the agent can commit credentials the gate was built to block; the gate's block message implies comprehensive secret detection it does not provide.
- **Fix:** Broaden the pattern set (GitHub/GitLab/Slack/OpenAI token prefixes, generic 'high-entropy assignment' heuristic) or make it a pluggable scanner the host can supply, and cover staged file paths against a configurable denylist rather than a fixed regex.
- **Evidence:** SENSITIVE_STAGED_CONTENT = /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|AKIA[0-9A-Z]{16}/i; SENSITIVE_STAGED_PATH covers .env/id_rsa/pem/p12/pfx only.

## [LOW] correctness — sdk/src/tools/file-change-hooks.ts:695 — Configured file-change hooks run under assistant mode with no authorizeHighImpactAction, so matching hook commands are hard-denied
- **Risk:** runFileChangeHooks invokes runTerminalCommand without passing mode or authorizeHighImpactAction, so mode defaults to 'assistant': classifyTerminalHarnessAction runs on every hook command and, with no authorize callback, any configured hook whose command matches a high-impact shape (e.g. a project whose Makefile 'deploy' target is invoked via an inferred 'make deploy' hook, or a configured hook containing 'npm publish') is hard-denied with 'requires a snapshot-scoped user approval' and no path to approval — the hook gate silently never validates for such repos, degrading verification to a denial the model sees as a failed hook.
- **Fix:** Run configured hooks under an explicit hooks policy namespace (e.g. mode 'user' with the hook's own bounded profile, or pass an authorizeHighImpactAction that surfaces the approval request through the host), and document that hook commands bypassing the classifier is intentional if that is the chosen design.
- **Evidence:** runFileChangeHooks: 'return run({ command: hookCommand.command, process_type: "SYNC", cwd, projectRoot: cwd, timeout_seconds: hook.timeoutSeconds ?? HOOK_DEFAULT_TIMEOUT_SECONDS, env, signal: params.signal })' — no mode, no authorizeHighImpactAction.

## [LOW] performance — sdk/src/tools/node-filesystem.ts:120 — readNodeTextRange walks the entire file byte-by-byte even when the requested bounded window is already complete
- **Risk:** readNodeTextRange scans every byte of every chunk with an index loop and never stops early: a bounded range read of lines 5-10 in a 500MB file streams and byte-scans the entire file to compute totalLines and the complete flag. The docblock claims memory-boundedness, which holds, but the CPU cost is O(file size) regardless of window size, making the range-read capability slow precisely for the oversized files it exists to serve.
- **Fix:** Scan chunks with Buffer.indexOf(0x0a) instead of per-byte iteration, and add an early-exit fast path (stop streaming once the requested window is fully returned) that reports totalLines as undefined/approximate, letting read-files choose between exact-metadata and bounded-latency modes.
- **Evidence:** Inner loop: 'for (let index = 0; index < chunk.byteLength; index += 1) { if (chunk[index] !== 0x0a) continue; ... }'; no early return; result contract requires totalLines and complete so the whole stream is always consumed.

## [LOW] dependency-hygiene — sdk/src/tools/run-terminal-command.ts:4 — Deep relative cross-package imports bypass the @codebuff/common package alias used everywhere else in the sdk
- **Risk:** This file imports stripColors/truncateStringWithMessage and CodebuffToolOutput via deep relative paths into common's source tree ('../../../common/src/util/string', '../../../common/src/tools/list') while every other sdk module imports the same package through the @codebuff/* alias. This couples the sdk build to common's on-disk layout, breaks if the package is consumed as built artifacts, and will silently drift if common moves files.
- **Fix:** Replace the deep relative imports with the @codebuff/common package alias so the SDK stops reaching across package source boundaries at build time.
- **Evidence:** run-terminal-command.ts imports 'from ../../../common/src/util/string' and 'from ../../../common/src/tools/list' while sibling modules import '@codebuff/common/util/...'; type imports in the same file use the alias form.

## [LOW] correctness — sdk/src/services/harness-enforcement.ts:634 — evaluateHarnessActionPolicy consumes hasMatchingApproval but its only wired caller path can never present one for hook-denied commands
- **Risk:** evaluateHarnessActionPolicy denies high-impact actions when hasMatchingApproval is false, and runTerminalCommand surfaces 'denied by harness approval policy' for them; file-change hooks (previous finding) reach this state with no consume() path because no approval receipt ids are threaded into hook execution. The approval machinery (HarnessApprovalService.grant/consume) is only wired on the run_terminal_command branch of handleToolCall, so any other caller of classifyTerminalHarnessAction cannot ever satisfy the policy it enforces — a latent divergent contract between the classifier and its only consumer.
- **Fix:** Either thread the approval path into hook execution, or add a dedicated 'hook' policy namespace that documents hooks as host-configured trusted commands and skips the assistant-mode classifier for them, with the bounded per-hook timeout as the compensating control.
- **Evidence:** evaluateHarnessActionPolicy: requiresApproval = approvalMode === 'strict' || (approvalMode === 'balanced' && highImpact.has(params.action)) with highImpact = {migration, release, deploy, external-network, arbitrary-code, workspace-delete}; hooks call run() with no authorizeHighImpactAction (file-change-hooks.ts:695) so consume can never be reached from that path.

## [LOW] dependency-hygiene — sdk/src/tools/transaction-intent-log.ts:561 — Userspace advisory locking (pid + instance-token machinery) re-implements what kernel primitives provide; documented residual races are inherent to the approach
- **Risk:** Both the intent-log lock and WorkspaceMutationBroker's workspace lock re-implement cross-process exclusion in userspace (exclusive-create files + pid liveness + per-process-instance tokens + identity re-confirmation before unlink). The module comments themselves document residual windows (recycled pid whose new occupant never touches the log defers revert; identity-less lock break race; legacy pid-only rows). A Rust sidecar or even a small native addon using flock(2)/renameat2(RENAME_NOREPLACE)/openat2(RESOLVE_BENEATH) would give kernel-enforced exclusion, kill the entire pid-recycle token apparatus, and shrink both files by hundreds of lines — this is the one capability in the shard where a language/runtime switch has a concrete, strictly-better case. TypeScript remains the right choice for everything else in this shard (tool dispatch, zod receipt schemas, diff application, event-loop concurrency); Python is strictly worse everywhere here.
- **Fix:** Consolidate both on one kernel-level primitive (flock via a small napi/native helper or a Rust sidecar exposing acquire/release/recover), keeping the JS JSONL format; if the no-native-dependency constraint is deliberate, at least unify the two divergent lock implementations behind one shared module with shared tests.
- **Evidence:** withIntentLogLock + confirmLockIdentity + ownerBlocksRevert + ownerTokenFilePath machinery (transaction-intent-log.ts:561-649 and 449-560); comments acknowledge 'Residual window: a recycled pid whose new occupant never touches this log...' and a legacy-pid conservative path; the sibling WorkspaceMutationBroker independently re-implements another mkdir-based lock with its own stale/pid recovery (workspace-mutation-broker.ts:570-648).

## [MEDIUM] test-coverage — sdk/src/__tests__/harness-enforcement.test.ts:1 — Test gaps for the shard's highest-risk behaviors: classifier shell-wrapper evasion, custom-tool self-certified receipts, binary executable staging in owned temp, and transaction read amplification
- **Risk:** Verified gaps: (1) no test feeds 'sh -c "git push"'/'bash -c'/'eval' to classifyTerminalHarnessAction, so the wrapper-evasion hole is invisible to CI; (2) no test stages a .exe/.jar file under an owned-temp path to exercise OWNED_TEMP_REFUSED_EXTENSIONS; (3) no test runs a custom tool definition returning a file_mutation_result payload to assert (or fix) the missing attestation downgrade; (4) no test pins the number of filesystem reads per edit_transaction change, so the triple-read regression cannot be caught. Existing suites (terminal-command-policy, filesystem-authority, change-file, transaction-intent-log, workspace-mutation-broker) are otherwise strong.
- **Fix:** Add four targeted tests: classifier evasion via shell wrappers; owned-temp .exe staging refusal; custom-tool mutation-shape downgrade (or explicit rejection); and a read-count assertion pinning the edit_transaction I/O contract before optimizing it.
- **Evidence:** Grep of sdk/src/__tests__/harness-enforcement.test.ts shows no sh/bash/eval cases; terminal-command-policy.test.ts covers /tmp traversal and tmux but no staged binary; run-mutation-dispatch.test.ts covers override downgrade and MCP gating but not customToolDefinitions returning mutation shapes; change-file.test.ts has no triple-read assertion.

## Coverage receipt

### Subsystems
- sdk-mutation-core
- sdk-tool-dispatch
- filesystem-authority
- workspace-mutation-broker
- transaction-intent-log
- harness-enforcement
- agent-runtime-seam
- llm-provider-adapter

### Features
- file_mutation_result_v1_receipts
- cap_v3_edit_anchor_freshness
- conditional_commit_cas_authority
- transaction_intent_log_recovery
- terminal_permission_profiles
- harness_high_impact_classification
- approval_receipt_grant_consume
- file_change_hooks_and_diagnostic_preflight
- process_supervision_seam
- client_mcp_first_call_approval
- workspace_journal_advance
- run_timeout_and_cancellation
- override_attestation_downgrade
- node_filesystem_bounded_range_read

### Files
- sdk/src/run.ts
- sdk/src/client.ts
- sdk/src/impl/llm.ts
- sdk/src/impl/agent-runtime.ts
- sdk/src/tools/change-file.ts
- sdk/src/tools/filesystem-authority.ts
- sdk/src/tools/node-filesystem.ts
- sdk/src/tools/transaction-intent-log.ts
- sdk/src/tools/terminal-command-policy.ts
- sdk/src/tools/run-terminal-command.ts
- sdk/src/services/workspace-mutation-broker.ts
- sdk/src/services/harness-enforcement.ts
- sdk/src/tools/mutation-capabilities.ts
- sdk/src/tools/file-change-hooks.ts
- sdk/src/tools/replace-range.ts
- sdk/src/tools/path-utils.ts
- sdk/src/tools/__tests__/transaction-intent-log.test.ts
- sdk/src/__tests__/harness-enforcement.test.ts
- sdk/src/__tests__/terminal-command-policy.test.ts
- sdk/src/__tests__/change-file.test.ts
- sdk/src/__tests__/filesystem-authority.test.ts
- sdk/src/__tests__/workspace-mutation-broker.test.ts

### Domains
- security
- correctness
- state-mutation
- error-handling
- performance
- dependency-hygiene
- test-coverage
- api-contract
