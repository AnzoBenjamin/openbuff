# Audit findings: p2-f-supervision

- Subsystems: agent-runtime-supervision, agent-runtime-spawn, common-contracts, sdk-impl, docs, tests-supervision
- Features: P2-T8
- Files covered: 18
- Snapshot: workspace.v1.6908.9a7a1c5b

## [LOW] api-contract — packages/agent-runtime/src/supervision/process-supervisor.ts:261 — VERIFIED: process-supervisor.ts implements all claimed settle semantics
- **Risk:** None — this is a verification finding, not a defect.
- **Fix:** None required — claims verified against source and tests.
- **Evidence:** process-supervisor.ts:261-437 spawnSettledSubagent; SETTLE_STDOUT_CAP_BYTES=8MiB (:79), SETTLE_STDERR_CAP_BYTES=64KiB (:82) never parsed, SETTLE_KILL_GRACE_MS (:85), defaultSpawnSeam detached:true (:182-215) with killGroup negative-pid kill; agentReceiptSchema.safeParse only (:415-424); spawn throw -> crashResult('spawn_failed', null) (:318-321). Fixture modes ok/no-output/invalid/bad-schema/truncated/crash/slow/env pinned by supervision/__tests__/process-supervisor.test.ts:83-330 (truncated test :146-159, garbage-stdout :244-279, spawn-failed :230-242, timeout group-kill :192-210).

## [LOW] api-contract — packages/agent-runtime/src/supervision/child-entry.ts:150 — VERIFIED: child-entry.ts one-envelope contract + temp-file argv + closed env universe
- **Risk:** None — verification finding.
- **Fix:** None required.
- **Evidence:** child-entry.ts:150-178 runChildEntryMain writes one JSON.stringify(envelope)+'\n' via Bun.write(Bun.stdout); diagnostics go to process.stderr (:152,:162); non-'agentType' request rejected (:157-160) -> exit 1 (no stdout). runSupervisedChildEntry returns buildUnsupportedDepsReceipt for every request (:124-131) naming all 16 CHILD_CALLBACK_DEPS (:48-65). supervised-spawn.ts:79-86 args:[requestPath] with stdin:'ignore' in process-supervisor.ts:316-320; request file written mode 0o600 inside the 0700 mkdtemp sandbox and rmSync'd in finally (:73-100).

## [LOW] api-contract — sdk/src/impl/agent-runtime.ts:183 — VERIFIED: flag-gated adoption via processSupervision+spawnSupervised seeded at SDK impl seam; flag-off byte-identical
- **Risk:** None — verification finding.
- **Fix:** None required.
- **Evidence:** sdk/src/impl/agent-runtime.ts:183-192 seeds {processSupervision:true, spawnSupervised: spawnSupervised ?? buildDefaultSpawnSupervised(...)} when flag truthy or caller-passed true; truthiness table 1/true/yes/on case-insensitive (:48-53). extractSubagentContextParams forwards both (spawn-agent-utils.ts:163-164); executeSubagent branches (:2973-2988) and warns 'processSupervision is enabled but no spawnSupervised seam is wired' when flag-on without a seam. TEST_AGENT_RUNTIME_IMPL in common/src/testing/fixtures/agent-runtime.ts contains NEITHER key, so flag-off test/production-default behavior is byte-identical.

## [LOW] test-coverage — packages/agent-runtime/src/__tests__/spawn-settle-fault-injection.test.ts:179 — GATE PARTIAL: spawn-settle-fault-injection.test.ts exists but covers PR-T1 receipt-chain faults, NOT the D36 child-process fault axes
- **Risk:** A reviewer checking the plan gate by filename could conclude the D36 settle fault axes (crash/timeout/no-output/schema-invalid/truncated) are untested at the production choke point; they are only tested at the supervisor module level, and the flag-on routing tests in spawn-process-supervision.test.ts stub the seam rather than exercising real settle failures end-to-end.
- **Fix:** Either rename the plan gate reference to name process-supervisor.test.ts, or add D36 settle-outcome fault cases (supervised-seam crash/timeout/missing_output/schema_invalid/truncated through executeSubagent) to the spawn-settle file so the named gate file covers what the gate text says.
- **Evidence:** packages/agent-runtime/src/__tests__/spawn-settle-fault-injection.test.ts is the M2-T1 spawn-settle fault-injection suite: injected faults into buildRuntimeAgentReceipt / reconcileAgentReceiptIntoParent / extractSubagentContextParams across inline + background + foreground-batch spawn paths, asserting lease release, no dangling spawns, ledger interrupted pairing, discovery-shard closure (:179-571). The fault axes named in the plan gate (crash/timeout/no-output/schema-invalid/truncated) are covered instead by supervision/__tests__/process-supervisor.test.ts:83-330. The plan gate is satisfied by the suite existing at that exact path, but the name-to-content match is loose: the gate says 'spawn-settle fault-injection suite' and the file delivers PR-T1 settle-chain fault injection, not D36 settle-outcome fault injection.

## [LOW] api-contract — docs/environment-variables.md:1 — OPENBUFF_PROCESS_SUPERVISION is undocumented in docs/ (0 matches across docs/)
- **Risk:** A user or operator cannot discover the flag, its truthiness convention (1/true/yes/on), or its current honest-degradation limitation from the docs surface; the flag's only documentation is code comments and the session PLAN.
- **Fix:** Add the flag to docs/environment-variables.md with truthiness semantics, default-off, and the current unsupported-deps caveat.
- **Evidence:** grep OPENBUFF_PROCESS_SUPERVISION over docs/ -> 0 matches; matches only in common/src/types/contracts/agent-runtime.ts:263, PLAN.md:94, common/knowledge.md:137, process-supervisor.ts:11, sdk/src/impl/agent-runtime.ts:42-52.

## [MEDIUM] correctness — packages/agent-runtime/src/supervision/child-entry.ts:124 — Flag-on path is reachable in production ONLY via env flag; without it the seam is unreachable in production (test-only), and even with it the child degrades to unsupported-deps
- **Risk:** An operator flipping OPENBUFF_PROCESS_SUPERVISION=1 in production degrades EVERY subagent spawn to a structured failed receipt (unsupported-deps) — silent functional regression masked as honest failure, only documented in module comments.
- **Fix:** None for this slice (honest degradation is documented), but the flag-on path should be marked as not-yet-production-safe in docs and the PLAN should note that flipping the flag today converts every subagent into a failed unsupported-deps spawn.
- **Evidence:** Flag-on routing tests (spawn-process-supervision.test.ts:165-354) stub the seam with fixture envelopes; no production caller sets processSupervision explicitly and the env flag is default-off. The two programmatic sites (context-consolidation-runner.ts:101, runtime-semantic-compaction.ts:219) inherit the flag via extractSubagentContextParams, so coverage IS complete at the choke point — but with the flag on, every real child returns the unsupported-deps failed receipt (child-entry.ts:124-131 fails closed for all requests), meaning flag-on production behavior is guaranteed-failing spawns, not supervised execution.

## [MEDIUM] state-mutation — packages/agent-runtime/src/supervision/supervised-spawn.ts:22 — Process-group teardown is SHIPPED (not deferred as claimed) but only tested with mock seams; real basher grandchildren behavior unverified
- **Risk:** When the RPC bridge lands and a real basher child spawns shell grandchildren, a timeout SIGKILL of the supervisor child would either reap the whole group (if detached:true holds) or orphan long-running grandchildren (if the child daemonized or detached itself into a new session, e.g. tmux/shell tricks) — untested, so the guarantee is unverified exactly where D36 (isolation) claims it matters.
- **Fix:** Add a fixture mode that spawns a real `bun -e` or `sleep` grandchild and assert the group kill reaps it (pgrep / waitpid semantics), and update the stale spawn-agent-utils.ts:2966-2968 limitation comment to reflect the shipped killGroup.
- **Evidence:** supervised-spawn.ts:22-26 documents the group kill as SHIPPED (negative-pid, 'so shell grandchildren die too'); process-supervisor.ts:46-58 killGroup implements it; tests pin group-kill (:192-210). BUT the real agent-runtime child (child-entry.ts) never runs a basher in this slice (unsupported-deps fails closed), so the grandchildren contract is UNTESTED against a real shell-tool child: the fixture children (settle-child.ts) spawn no grandchildren, and no test spawns a real bash -c 'sleep' grandchild under the group. The slice-1 limitation comment in spawn-agent-utils.ts:2966-2968 ('process-group teardown rides a later slice') now CONTRADICTS the code — teardown is implemented but unvalidated for real grandchildren.

## [MEDIUM] correctness — packages/agent-runtime/src/supervision/process-supervisor.ts:473 — buildSupervisedChildEnv omits keys a real LLM run needs — flag-on with real children would be silently broken
- **Risk:** When real supervised agents come online, LLM calls from the child would hit the default backend instead of a configured proxy/base URL, and CI runs would misbehave — a silently-broken flag-on configuration that looks like a network failure rather than an allowlist omission.
- **Fix:** When the RPC-bridge slice enables real children, extend the seed to thread provider base-URL/proxy vars explicitly (still via the allowlist, never wholesale), and document each added key on SupervisedChildEnvSeed.
- **Evidence:** SUPERVISED_CHILD_ENV_ALLOWLIST (process-supervisor.ts:473-481) + buildSupervisedChildEnvSeedFromSystemEnv (sdk/src/impl/agent-runtime.ts:67-82) forward ONLY OPENBUFF_API_KEY(/CODEBUFF fallback), BYOK OpenRouter, ChatGPT OAuth (both spellings), NODE_ENV. Not forwarded: OPENBUFF_BACKEND_URL/endpoint overrides, HTTP(S)_PROXY/NO_PROXY, provider base-URL vars used by model-provider.ts, TMPDIR, LANG/LC_*, XDG_*, CODEBUFF_RG_PATH (pinned as an env-override vector in X-1 golden vectors), CI env. PATH/HOME are correctly opt-in and currently unseeded (documented at sdk/src/impl/agent-runtime.ts:60-65).

## [LOW] api-contract — common/src/types/contracts/agent-runtime.ts:193 — VERIFIED: PR-T1→P2-T8 dependency holds — no second schema; envelope reuse via agentReceiptSchema + structural SettledSubagentResult
- **Risk:** None — dependency claim holds.
- **Fix:** None required.
- **Evidence:** SettledSubagentResult.outcome (common/src/types/contracts/agent-runtime.ts:193-209) reuses the AgentReceipt outcome enum values verbatim; SettledSubagentResult.receipt is typed `unknown` and re-validated through agentReceiptSchema.safeParse at the consumer (spawn-agent-utils.ts:2820-2830) before entering settle chains. No new zod schema for the envelope exists in supervision/* (grep agentReceiptSchema: imported only, never redefined). PR-T1 precedence order (crashed > missing_output > schema_invalid > truncated > ok) is enforced in process-supervisor.ts:368-424 and mirrored by the supervisedOutcome derivation (spawn-agent-utils.ts:1895-1926) + tests (spawn-agent-utils-output.test.ts:989-1066).

## [LOW] test-coverage — packages/agent-runtime/src/__tests__/spawn-process-supervision.test.ts:165 — Gate suite coverage of the demanded fault axes is complete at the supervisor level; two residual gaps
- **Risk:** A regression in the supervised branch's finish-event emission or in the real-child wiring would pass the suite, because every flag-on test bypasses the actual process spawn.
- **Fix:** Add one flag-on executeSubagent test driving the real fixture child through buildDefaultSpawnSupervised (crash + timeout) and assert subagent_finish emission on the supervised branch.
- **Evidence:** supervision/__tests__/process-supervisor.test.ts covers ok/no-output(schema_invalid variant :117-129)/bad-schema(:131-144)/truncated(:146-159)/crash(:161-171)/timeout+group-kill(:173-228)/spawn-failed(:230-242)/garbage-stdout(:244-279)/env-allowlist(:281-307)/concurrency(:309-329); child-entry.test.ts covers the one-envelope + unsupported-deps contract; spawn-process-supervision.test.ts covers flag routing (:165-354) and inline-handler integration (:355-449). Not covered: (a) missing_output at the supervisor level IS covered (:103-115); (b) schema-invalid IS covered; (c) NOT covered anywhere: a flag-on executeSubagent end-to-end with a REAL crashing/timeout child process (all flag-on routing tests stub the seam), and no test asserts the subagent_finish event is emitted on the supervised branch (the flag-off branch emits it explicitly; the supervised branch relies on `failed=false` falling through to :3083-3096).

## Coverage receipt

### Subsystems
- agent-runtime-supervision
- agent-runtime-spawn
- common-contracts
- sdk-impl
- docs
- tests-supervision

### Features
- P2-T8

### Files
- packages/agent-runtime/src/supervision/process-supervisor.ts
- packages/agent-runtime/src/supervision/child-entry.ts
- packages/agent-runtime/src/supervision/supervised-spawn.ts
- packages/agent-runtime/src/supervision/__fixtures__/settle-child.ts
- packages/agent-runtime/src/tools/handlers/tool/spawn-agent-utils.ts
- packages/agent-runtime/src/tools/handlers/tool/spawn-agents.ts
- common/src/types/contracts/agent-runtime.ts
- sdk/src/impl/agent-runtime.ts
- packages/agent-runtime/src/__tests__/spawn-settle-fault-injection.test.ts
- packages/agent-runtime/src/__tests__/spawn-process-supervision.test.ts
- packages/agent-runtime/src/supervision/__tests__/process-supervisor.test.ts
- packages/agent-runtime/src/supervision/__tests__/child-entry.test.ts
- packages/agent-runtime/src/tools/handlers/tool/__tests__/spawn-agent-utils-output.test.ts
- packages/agent-runtime/src/util/context-consolidation-runner.ts
- packages/agent-runtime/src/util/runtime-semantic-compaction.ts
- sdk/src/run.ts
- common/src/testing/fixtures/agent-runtime.ts
- docs

### Domains
- api-contract
- test-coverage
- correctness
- state-mutation
