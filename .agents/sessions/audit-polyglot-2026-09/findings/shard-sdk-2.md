# Audit findings: shard-sdk-2

- Subsystems: sdk-core, sdk-llm-stack, sdk-terminal-policy, sdk-process-supervision, sdk-workspace-mutation, sdk-browser-automation, sdk-filesystem-tools, sdk-native-binding
- Features: terminal-command-policy, background-jobs-supervision, workspace-mutation-receipt-journal, cdp-pipe-transport, browser-session-management, llm-streaming-retry-failover, provider-model-resolution, provider-failover-policy, ripgrep-binary-discovery, node-filesystem-adapter, harness-discovery-leases, workspace-journal, run-orchestration, sdk-env-config, terminal-command-execution
- Files covered: 16
- Snapshot: 4fc76b0bd48a0b11d651b8f4647bb302dc95344c8b5749411ed1f5fcc3e7a0ba

## [HIGH] security — sdk/src/tools/terminal-command-policy.ts:2092 — Terminal command policy: 2451-line lexical shell security boundary implemented as regex/string heuristics in TS
- **Risk:** A hand-rolled lexical approximation of shell semantics cannot be sound: shell quoting/expansion is context-free, and regex heuristics (e.g. quotedContentRanges, splitReadOnlyShellSegments) can mis-parse adversarial input. A false-negative here is a workspace-escape / arbitrary-command vector for agent-driven commands. This is the highest-value component in the SDK for a language change: Rust gives memory safety (irrelevant here), but more importantly a real parser (tree-sitter-bash or shlex-style tokenization) plus unit-testability outside the JS event loop, and it can be co-located with the locked Rust sandbox shim that actually executes commands.
- **Fix:** Challenge/extend the locked SPEC: move the policy gate into the Rust sandbox shim as a proper shell parser (e.g. a POSIX/bash parse crate) that either constructs an argv plan or refuses, keeping the TS function as a thin ACP client. Port incrementally (profile-by-profile, keeping the TS decision as a cross-check) rather than a big-bang rewrite. Until then, add property-based differential tests (parser vs. real bash -n execution traces) to compensate for TS heuristics.
- **Evidence:** sdk/src/tools/terminal-command-policy.ts:691-2451 evaluateTerminalCommandPolicy; quotedContentRanges/scanActiveShellSyntax regex scanners at 733-798, 1844-1880; profile branches at 2141-2448; test suite sdk/src/__tests__/terminal-command-policy.test.ts

## [MEDIUM] state-mutation — sdk/src/tools/background-jobs.ts:674 — Background job supervision is a userspace poller reimplementing what a supervisor process provides
- **Risk:** All supervision correctness depends on the Node event loop staying alive: a crash or long event-loop stall in the SDK process orphans detached children (detached: true, process group) with only best-effort 24h /tmp sweeps as recovery. The pid-reuse guard (childProcessStartTime) is Linux-only ('undefined on non-Linux hosts' per the comment at line ~132), so macOS/Windows recovered jobs can act on a recycled pid. The 250ms polling drainer wastes CPU and adds up to 250ms latency per output tick.
- **Fix:** Supports the locked SPEC (Rust jobd). Recommend migrating supervision INTO the locked Rust jobd design: jobd forks processes into their own session/pgid, owns log fds, and reports lifecycle over the ACP v1 channel; TS keeps only a client stub. Migrate opportunistically when jobd lands — do not rewrite TS supervision independently, or you pay the cost twice.
- **Evidence:** sdk/src/tools/background-jobs.ts:674-879 spawn + setInterval(250ms) drainer; :45-74 process-group signaling via process.kill(-pid); :1144-1162 readProcessStartTime string-parses /proc/<pid>/stat; recovery projection 448-521; kill escalation 1186-1239

## [LOW] state-mutation — sdk/src/services/workspace-mutation-broker.ts:240 — Mutation broker receipt journal: durability implemented correctly in TS; language migration would add risk, not guarantees
- **Risk:** The broker is deliberately crash-tolerant: every intermediate state is a durable receipt, recovery is a pure function of (receipt, on-disk hash), and ambiguous states fail closed to recovery_required rather than guessing. Moving it to Rust would buy no additional guarantee — Node fs sync()/fsync directory already provides the needed durability primitves — and would lose the existing TS test suite (workspace-mutation-broker.test.ts). The one real (language-independent) weakness: the mkdir-based lock plus owner.json is two-step, so a crash between mkdir and owner.json write yields a lock with no owner that recovery must wait out for staleLockMs.
- **Fix:** Do NOT migrate — TS is the right choice here; this supports the SPEC's protocol-first TS core and no-big-bang-rewrite stance. If the Rust sandbox shim ever owns workspace writes, expose this broker's receipt protocol over ACP instead of rewriting its logic. One cheap TS improvement regardless of language: the mkdir-lock owner.json write can fail after mkdir succeeds, leaving an empty lock dir that only staleness timeout recovers — write owner.json via a temp-file rename inside the lock dir.
- **Evidence:** sdk/src/services/workspace-mutation-broker.ts:240-340 conditionalCommit; :927-962 writeStagedFile/writeJsonDurable with handle.sync() + fsyncDirectory; :570-648 mkdir-lock with pid+token recovery; :659-761 recoverReceipt state machine

## [LOW] correctness — sdk/src/tools/cdp-pipe-transport.ts:65 — CDP pipe transport buffer management is in good shape in TS; native rewrite unjustified
- **Risk:** Current on-disk state audited: the module is pipe-fd based (no TCP listener), the 256MiB un-terminated-frame cap is present and compares LIVE bytes (bufferEnd - bufferOffset), frame scanning is amortized O(n) via a carried scanOffset, and the buffer never re-concatenates (copyWithin/growth paths). This is well-bounded pure-JS byte plumbing over ~300 lines; a Rust rewrite would only add an FFI boundary for no isolation gain, since a hostile Chrome can already crash the session via onClose and the pending-request rejection path is clean.
- **Fix:** Keep TS. Optional hardening (language-independent): JSON.parse failures currently silently drop frames (handleFrame:246-272 catch-return) — consider counting and surfacing malformed-frame metrics so a desynchronized pipe is diagnosable rather than invisible.
- **Evidence:** sdk/src/tools/cdp-pipe-transport.ts:65-66 DEFAULT_MAX_BUFFER_BYTES = 256*1024*1024, DELIMITER 0x00; :162-244 onData offset-based accumulation with bufferOffset/bufferEnd/scanOffset carry; :238-244 fail-closed live-bytes cap check; browser-logs.ts:688-719 spawn with stdio ['ignore','ignore','ignore','pipe','pipe'] and --remote-debugging-pipe

## [MEDIUM] correctness — sdk/src/tools/browser-logs.ts:2524 — browser-logs.ts embeds hand-rolled PNG/APNG encode + CRC32 + pixel-diff pipeline in TS
- **Risk:** The ~2700-line module mixes three concerns: CDP session lifecycle (fine in TS), browser action orchestration (fine in TS), and binary image processing (hand-rolled CRC-32 table, chunk writer, APNG assembly, pixel-diff). The hand-rolled PNG encoder is a classic correctness trap (endianness, chunk ordering, color-type edge cases) and pixelmatch over full-res buffers is the only compute-hot path; a Rust image pipeline (image/pixmap crates via napi) would be faster and more trustworthy. Currently bounded (MAX_RECORDING_FRAMES) so it is not urgent.
- **Fix:** If APNG/recording is promoted beyond an experiment, move frame capture + APNG assembly into a small Rust napi module (or into the locked Rust shim's image lane) and keep CDP session orchestration in TS. Until then, add round-trip tests decoding the generated APNG with pngjs to validate the hand-rolled encoder.
- **Evidence:** sdk/src/tools/browser-logs.ts:2631-2649 makeCrcTable/crc32; 2569-2629 parsePngChunks/writePngChunk/uint32/frameControlData; 2059-2142 pixelDiff/cropPngData; 578-613 chromeSandboxArgs /proc probing

## [LOW] api-contract — sdk/src/impl/llm.ts:1020 — llm.ts streaming/retry machinery must stay in TS — it is a thin layer over the AI SDK ecosystem
- **Risk:** The streaming/retry/failover machinery is deeply coupled to the Vercel AI SDK (streamText, NoOutputGeneratedError, NoSuchToolError, experimental_repairToolCall), provider-specific fetch wrappers, zod schemas, and the JS async-generator streaming model. A Rust rewrite would require reimplementing or binding the entire AI SDK surface across OpenAI/Anthropic/OpenRouter/ChatGPT-OAuth providers — a large surface with constant upstream drift and no compensating benefit: the work is I/O-bound, not compute-bound, and there is no crash-isolation need (a provider hang is already handled by withDefaultRequestTimeout abort signals, llm.ts:536-541).
- **Fix:** Keep TS — this supports the locked SPEC. The only extraction worth considering: error classification (failover.ts + error-utils.ts) is already pure and could be mirrored in Rust jobd if it ever owns provider calls, but that is speculative.
- **Evidence:** sdk/src/impl/llm.ts:1020-1833 promptAiSdkStream (failover x retry nesting, experimental_repairToolCall, ChatGPT OAuth classification); :758-894 getMessagesForModelContext; sdk/src/impl/failover.ts:36-101 status-code policy; retry-config.ts retry policy

## [LOW] correctness — sdk/src/impl/model-provider.ts:231 — model-provider/failover: pure config logic where TS is clearly correct
- **Risk:** Pure routing/compatibility policy (model resolution, reasoning-effort selection, vision fallback by name heuristics, request-body transforms). No OS access, no hot loops, no crash-isolation need. Fully unit-tested (model-provider.test.ts, failover.test.ts).
- **Fix:** Keep TS. If the heuristic tables grow, consider driving them from data (provider-config capability fields) rather than code, which is a TS-internal refactor, not a language change.
- **Evidence:** sdk/src/impl/model-provider.ts:231-421 getModelForRequest; :506-607 vision-name heuristics; :843-921 per-provider request transforms; sdk/src/impl/failover.ts:51-68 resolveModelsToTry

## [MEDIUM] performance — sdk/src/services/harness-intelligence.ts:224 — harness-intelligence uses blocking spawnSync on the shared event loop
- **Risk:** toolVersion probes tool versions via spawnSync, which blocks the entire event loop for the duration of each tool invocation — on a cold cache with several tools (tsc, pytest, cargo) this can stall streaming output for the whole SDK process, including in-flight LLM stream pumps. Everything else in the module (directory walking, lock files, lease records) is I/O-bound glue where TS is appropriate.
- **Fix:** Keep TS, but convert toolVersion to the async spawn used elsewhere in the codebase (run.ts uses childProcessToPromise) or memoize version probes per binary path. If jobd (locked Rust) gains a generic 'probe binary version' RPC, route through it.
- **Evidence:** sdk/src/services/harness-intelligence.ts:224-241 toolVersion via spawnSync; :73-103 discoverNamedFiles walk; :564-744 WorkspaceLeaseService withFilesystemLock

## [MEDIUM] correctness — sdk/src/tools/run-terminal-command.ts:215 — Terminal execution wrapper couples spawn, Windows bash discovery, and policy gate in one TS file
- **Risk:** runTerminalCommand spawns shell processes from inside the SDK process (no external supervisor), with Windows bash discovery by probing a hardcoded path list plus WSL patterns — fragile on nonstandard installs. Output bounding and git dirty-delta logic is careful but lives in-process, so a misbehaving child shares fate with the SDK only via the polling drainer (see background-jobs finding).
- **Fix:** Supports the locked SPEC: fold command execution into the Rust sandbox shim/jobd and have runTerminalCommand become an ACP client. The Windows bash discovery logic is the piece to scrutinize when porting — it is heuristic path probing that Rust's which/creation-flags semantics can replace with deterministic lookups.
- **Evidence:** sdk/src/tools/run-terminal-command.ts:68-146 findWindowsBash (GIT_BASH_COMMON_PATHS/WSL_BASH_PATH_PATTERNS); :215-785 runTerminalCommand spawn + output bounding; policy gate imported from terminal-command-policy.ts

## [LOW] performance — sdk/src/native/ripgrep.ts:37 — ripgrep discovery: already correctly delegates search to a native binary; TS glue is fine
- **Risk:** Correct pattern: the compute-heavy search already runs as a native rg binary; TS is only doing path resolution via stat/access probes plus an eval'd __dirname fallback (line ~140, `new Function(...)`), which is a CSP/eval smell in bundled contexts but functionally harmless in the CLI. No language change needed.
- **Fix:** Keep as-is. When the Rust shim lane lands, vendored-binary discovery can move there opportunistically, but there is no correctness or performance pressure to do so. Supports the SPEC's 'native where it pays' philosophy already embodied here.
- **Evidence:** sdk/src/native/ripgrep.ts:37-175 getBundledRgPath five-strategy discovery; consumed by code-search.ts and find-files-matching-content.ts which shell out to rg

## [LOW] correctness — sdk/src/tools/node-filesystem.ts:21 — node-filesystem adapter: TS is unambiguously right
- **Risk:** Thin adapter implementing the CodebuffFileSystem interface over node:fs with range reads; all mutation authority is delegated to the filesystem-authority/mutation-broker layer. There is no performance- or safety-critical logic here.
- **Fix:** Keep TS. This is exactly the layer the locked SPEC intends to stay in TypeScript behind the ACP v1 protocol.
- **Evidence:** sdk/src/tools/node-filesystem.ts:21-180 createNodeFileSystem/readNodeTextRange; delegation chain from sdk/src/run.ts:60-78 tool wiring

## [LOW] state-mutation — sdk/src/services/workspace-journal.ts:31 — workspace-journal: trivial TS record service, keep
- **Risk:** Small JSON record store (create/read/advance) over LocalHarnessStore's atomic JSON writes. Same reasoning as the mutation broker: crash-tolerant design, no hot path, existing TS tests. Three near-duplicate durable-JSON writers exist across services (local-harness-store, task-memory-store, mutation-broker) — a consolidation opportunity inside TS, not a language change.
- **Fix:** Keep TS. If a single durable-writes library is wanted, extract one shared helper rather than changing language.
- **Evidence:** sdk/src/services/workspace-journal.ts:31-100 WorkspaceJournalService create/read/advance; sibling services local-harness-store.ts writeJsonAtomic and task-memory-store.ts writeRecordAtomically + withMemoryFileLock

## [LOW] api-contract — sdk/src/run.ts:585 — run.ts orchestration (2758 lines): TS is structurally required by the locked ACP v1 core
- **Risk:** The run orchestrator and tool dispatcher are protocol plumbing: session state, tool dispatch, gates, and prompt response handling, all built on shared @codebuff/common types. Rewriting in another language would break the protocol-first TS core decision for zero gain; the file is large (2758 lines) but that is a modularity issue, not a language issue.
- **Fix:** Keep TS. Optional structural (not linguistic) improvement: extract the per-tool dispatch table into modules so tool ownership boundaries align with future ACP service boundaries.
- **Evidence:** sdk/src/run.ts:585-1520 runOnce; :1741-2620 handleToolCall; :1536-1668 digest/git-status gates; client.ts:6-50 thin OpenbuffClient

## [LOW] security — sdk/src/env.ts:66 — env.ts child-process env selection is a small, correct TS responsibility
- **Risk:** Env sanitization functions gate which variables reach child processes (getChildProcessEnv). This is a security-adjacent allowlist implemented in ~80 lines of TS. TS is the right language (it must compose with the JS process env and config loading), but the allowlist completeness deserves its own security review independent of language choice.
- **Fix:** Keep TS; add an explicit allowlist-based child env builder (deny-by-default) as a TS refactor — no language change required, and it strengthens the boundary the Rust shim will inherit.
- **Evidence:** sdk/src/env.ts:21-88 getSdkEnv/getChildProcessEnv/getSystemProcessEnv; background-jobs.ts:716-721 spawn env propagation; run-terminal-command.ts:10 getChildProcessEnv usage

## Coverage receipt

### Subsystems
- sdk-core
- sdk-llm-stack
- sdk-terminal-policy
- sdk-process-supervision
- sdk-workspace-mutation
- sdk-browser-automation
- sdk-filesystem-tools
- sdk-native-binding

### Features
- terminal-command-policy
- background-jobs-supervision
- workspace-mutation-receipt-journal
- cdp-pipe-transport
- browser-session-management
- llm-streaming-retry-failover
- provider-model-resolution
- provider-failover-policy
- ripgrep-binary-discovery
- node-filesystem-adapter
- harness-discovery-leases
- workspace-journal
- run-orchestration
- sdk-env-config
- terminal-command-execution

### Files
- sdk/src/run.ts
- sdk/src/client.ts
- sdk/src/env.ts
- sdk/src/tools/run-terminal-command.ts
- sdk/src/tools/terminal-command-policy.ts
- sdk/src/tools/background-jobs.ts
- sdk/src/services/workspace-mutation-broker.ts
- sdk/src/tools/cdp-pipe-transport.ts
- sdk/src/tools/browser-logs.ts
- sdk/src/impl/llm.ts
- sdk/src/impl/model-provider.ts
- sdk/src/impl/failover.ts
- sdk/src/native/ripgrep.ts
- sdk/src/tools/node-filesystem.ts
- sdk/src/services/harness-intelligence.ts
- sdk/src/services/workspace-journal.ts

### Domains
- correctness
- security
- performance
- state-mutation
- error-handling
- api-contract
- test-coverage
