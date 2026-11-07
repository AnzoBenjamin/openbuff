# Audit findings: p2-h-coherence

- Subsystems: agent-runtime-run-journal, agent-runtime-supervision, agent-runtime-clock-idgen, cli-run-journal-path, cli-dash-command, cli-replay-command, cli-turn-snapshots, cli-index-dir-watch, sdk-dash-provider, sdk-transaction-intent-log, common-agent-handoff-schema, common-commit-receipt-schema, agents-workflow-engine
- Features: P2-T1, P2-T2, P2-T3, P2-T4, P2-T5, P2-T6, P2-T7, P2-T8, P2-T9, ORCH-1, ORCH-3, ORCH-6, ORCH-7, EV-2, EV-5, EV-8, SB-3, S7, PR-T1, X-1
- Files covered: 25

## [MEDIUM] correctness — agents/base2/base2.ts:7397 — P2-T6 deferred item 'base2.ts wiring rides a later slice' has NO owning task
- **Risk:** transitionBase2GateSafe (the structured never-throw outcome naming the illegal from+event) exists but base2.ts:7397-7399 still drives the gate through the throwing/swallowing transition path, so the fail-loud telemetry correctness goal of P2-T6 is not realized in production; code_search for transitionBase2GateSafe in agents/base2 returns zero hits. Because the PLAN entry is marked [x] DONE with the wiring deferred to an unnamed 'later slice', nothing tracks it.
- **Fix:** Name the owning task (e.g. a P2-T6b line item or fold into the next agents-phase task) in PLAN.md, or land the transitionBase2GateSafe adoption in base2.ts with a test pinning the structured error on an illegal transition.
- **Evidence:** PLAN.md P2-T6 entry: 'base2.ts wiring rides a later slice; the structured error now NAMES the illegal from+event instead of a swallowed throw'. Verified live: code_search 'transitionBase2GateSafe' in agents/base2 = 0 matches; base2.ts:7397-7399 assigns mutableAgentState.workflowStates['base2-gate-v1'] = transition({...}) directly.

## [MEDIUM] correctness — packages/agent-runtime/src/supervision/process-supervisor.ts — ORCH-3 'restart policies' aspect unimplemented in P2-T8 and untracked
- **Risk:** The re-audit's ORCH-3 entry (§3b table) describes supervision via workers as 'Hard kill, restart policies (ORCH-3)'. P2-T8 delivers hard kill (SIGTERM→SIGKILL grace, negative-pid group kill per process-supervisor.ts:25-27, :125-129) but has zero restart/retry/respawn logic for supervised children (code_search 'restart|retry|respawn' in process-supervisor.ts = 0 matches). Restart policy only exists for background-agent journal intents via planBackgroundAgentResume (P2-T2), a different surface. No PLAN entry owns the gap.
- **Fix:** Either record in the P2-T8 PLAN entry that restart policy for supervised children rides P2-T2's planBackgroundAgentResume / a named later task, or add a respawn option to spawnSettledSubagent.
- **Evidence:** REAUDIT-REPORT.md §3b 'Supervision via Workers | spawn-agents.ts | Hard kill, restart policies (ORCH-3)'; PLAN traceability 'ORCH-3 P2-T8'; code_search confirms no restart logic in packages/agent-runtime/src/supervision/process-supervisor.ts.

## [MEDIUM] error-handling — packages/agent-runtime/src/supervision/child-entry.ts:79 — P2-T8 'full RPC bridge rides a later slice' deferred with NO owning task
- **Risk:** The flag-gated supervised path returns a structured 'unsupported-deps' failed receipt whenever a child needs parent callbacks (requestToolCall/sendAction/promptAiSdkStream) — i.e. real subagents cannot actually run under process supervision yet. The docblock says the full RPC bridge rides a later slice, but no PLAN task owns that slice, so the D36 adoption story silently ends at honest degradation.
- **Fix:** Add a named follow-up task (e.g. P2-T8b 'supervised-child RPC bridge') to PLAN.md, or fold the bridge into an existing P5/P6 supervision task so the deferral is tracked.
- **Evidence:** child-entry.ts:79 'agentReceiptSchema-valid, exit-code-free — the parent's settle chain' plus the 'unsupported-deps' contract; PLAN P2-T8 entry: 'a child whose required parent callbacks ... cannot be satisfied returns a structured failed receipt with code unsupported-deps (honest degradation — the full RPC bridge rides a later slice, documented)'. No owning task exists in PLAN Dependencies or the traceability matrix.

## [MEDIUM] api-contract — cli/src/commands/replay-command.ts:128 — P2-T3 '--model M' fork is annotation-only; PLAN marks task DONE without recording the limitation
- **Risk:** PLAN P2-T3 promises 'openbuff replay <run> --from-step N [--model M] for deterministic replay/fork'. The landed command never performs a live LLM pass: --model 'annotates the fork rather than altering the stream' (replay-command.ts:128-131). A user passing --model gets a re-emitted journal trace with a label, not a model-forked run. The code documents this honestly but the PLAN [x] DONE entry does not, so plan readers believe forking works.
- **Fix:** Amend the PLAN P2-T3 entry to state that --model is currently annotation-only on the re-emitted stream and that live model-fork replay rides a named later task (e.g. the P9-T4 D35 resume path).
- **Evidence:** replay-command.ts:128-131 docblock '--model is honored as the replay fork's model override; because this slice is a deterministic re-emission of the journaled stream (no live LLM pass), it annotates the fork rather than altering the stream'; PLAN.md P2-T3: '[x] P2-T3 openbuff replay <run> --from-step N [--model M] for deterministic replay/fork ... (DONE 2026-09-28 ...)' with no annotation-only caveat.

## [MEDIUM] test-coverage — cli/src/commands/__tests__/bash-command.test.ts:210 — P2-T4 gate 'undo covers basher side effects in the tracked tree' verified only at mock level on the bash path
- **Risk:** The named gate exists in two halves: cli/src/utils/__tests__/turn-snapshots.test.ts exercises real git plumbing (createTurnSnapshot on a private ref, undoLastTurn, restoreToTurn over hermetic temp repos) and bash-command.test.ts:210-219 pins that runBashCommand fires createTurnSnapshot({label:'shell'}) — but the latter only spies the snapshot call; no test performs an actual bash file mutation and then verifies undoLastTurn restores the tracked tree. The end-to-end chain bash-write → snapshot → undo → tree-reverted is untested.
- **Fix:** Add one hermetic temp-repo test that runs a real mutating command through the runBashCommand dispatch seam (or calls createTurnSnapshot around a scripted file write), then undoLastTurn and asserts the tracked file content is restored.
- **Evidence:** bash-command.test.ts:49 spyOn(turnSnapshots,'createTurnSnapshot').mockImplementation(...) and :211-219 asserting call shape only; turn-snapshots.test.ts:89-102, :307-357 covers snapshot/undo/restore mechanics with real git but never a bash-originated mutation.

## [LOW] test-coverage — cli/src/utils/__tests__/index-workspace-watcher.test.ts:181 — P2-T9 gate test is Linux-gated, so the watch→dirty gate silently passes on non-Linux CI
- **Risk:** The P2-T9 gate ('watch events mark the index dirty on Linux/Bun') is exercised by a real fs.watch forwarding test that is skipped outside Linux (test.skipUnless-style guard at :181-183 'The repo runs on Linux, where real fs.watch events fire; skip elsewhere'). On macOS/Windows CI runners the gate suite passes with the core assertion skipped, and neither the PLAN entry nor the test file records this as a gate caveat.
- **Fix:** Note the platform gate in the PLAN P2-T9 entry, or add a non-Linux CI leg (or a documented contract assertion that classifyIndexWatchPath maps forwarded events to the shared debounce state) so the gate is not vacuous off-Linux.
- **Evidence:** index-workspace-watcher.test.ts:181-183 'forwards real change events from the worker pool' guarded by a Linux-only condition; PLAN P2-T9 gate: 'watch events mark the index dirty on Linux/Bun' with no platform-test caveat.

## [LOW] test-coverage — packages/agent-runtime/src/util/__tests__/run-journal.test.ts:663 — P2-T2 kill-9 gate is a deterministic simulation, not a real SIGKILL integration test
- **Risk:** The named gate 'kill-9 mid-tool-call resume test' exists (run-journal.test.ts:663 describe 'kill-9 mid-tool-call resume (P2-T2-DESIGN §6)') and is genuinely strong (phase 1 journals tool A's result + tool B's call; phase 2 asserts A is not re-executed and B executes exactly once), but no process actually receives SIGKILL — the kill is simulated by an in-process phase split. A real kill -9 against a live bun process (WAL fsync timing, fd state) is untested.
- **Fix:** Add one opt-in integration test that spawns a child run, SIGKILLs it mid-tool-call, and resumes from the on-disk journal; or record in PLAN that the gate is a deterministic simulation of the kill-9 window.
- **Evidence:** run-journal.test.ts:663-795 two-phase inline replay driver; STATUS/PLAN describe it as 'the deterministic kill-9 mid-tool-call resume driver' — the simulation framing is recorded in prose but the gate name in PLAN could mislead about a real signal test.

## [LOW] error-handling — packages/agent-runtime/src/util/run-journal.ts — P2-T2 slice-1 reviewer advisories recorded but with no owning task
- **Risk:** Three reviewer advisories from the P2-T2 slice-1 review remain open with no owner: (a) unguarded JSON.parse on journal read — a corrupted row degrades unhandled; (b) classifyRunResume is a full scan (index upgrade deferred); (c) llm/tool write points previously used stepNumber:0 (since closed). (a) and (b) are durability/perf items on the crash-resume hot path with no PLAN line item.
- **Fix:** Add the corrupted-row JSON.parse guard and the classifyRunResume index to a named follow-up (e.g. under P6-T6a/P8-T8 journal-store work) or a P2-T2 residual bullet.
- **Evidence:** PLAN P2-T2 slice-1 DONE note: 'reviewer LOOKS_GOOD (advisories only: single-writer MAX(seq)→INSERT non-transactional ...; unguarded JSON.parse on read — corrupted-row degradation is a later slice; ... classifyRunResume full-scan — index upgrade later ...)'. 'later slice' is unnamed.

## [LOW] correctness — .agents/sessions/polyglot-roadmap-v2/PLAN.md:P2-T7 — P2-T7 'tmux-viewer replacement parity rides later polish' has no owning task
- **Risk:** The dash lands as the user-facing run-inspection tool and docs are repointed (testing.md, tmux.knowledge.md, knowledge.md), but the PLAN records 'tmux-viewer replacement parity rides later polish' with no task id, leaving an open delta between the dash and the tmux-viewer feature set untracked.
- **Fix:** Name the owning task for the parity polish or record the parity delta as accepted-with-scope in the PLAN entry.
- **Evidence:** PLAN P2-T7 DONE note: 'first full slice; tmux-viewer replacement parity rides later polish'; no traceability-matrix or Dependencies entry owns it.

## [LOW] correctness — .agents/sessions/polyglot-roadmap-v2/STATUS.md:P0→P1-sweep — STATUS.md has no P2 completion append and still lists P2+ as open
- **Risk:** The P0→P1 sweep append says 'Still open (later phases by design): X-3b, X-5, P2+' while PLAN.md now marks every P2 task [x] with detailed DONE notes. STATUS.md contains no P2-specific append (P2 progress lives only inside PLAN entries), so a STATUS-only reader concludes P2 is unstarted.
- **Fix:** Append a short P2 completion note to STATUS.md (or a pointer stating P2 completions are recorded in PLAN entries), correcting the stale 'P2+' open list.
- **Evidence:** STATUS.md 'P0→P1 sweep completion — 2026-10-01': 'Still open (later phases by design): X-3b, X-5, P2+'; the latest STATUS appends cover P3, never P2; PLAN P2-T1..T9 all read '[x]'.

## [LOW] test-coverage — .agents/sessions/polyglot-roadmap-v2/PLAN.md:P2-T1 — P2-T1 is the only P2 task with no declared gate clause
- **Risk:** The audit brief states 'every P2 task declares a gate in PLAN'; P2-T1's entry has 'lang TS.' and no 'gate:' clause. Enforcement actually exists (scripts/determinism-guard.ts wired into check:ci-local Step E, 10/10 tests) but is not declared as the gate, weakening gate honesty for ORCH-6's prerequisite.
- **Fix:** Add 'gate: determinism-guard 0 findings (scripts/determinism-guard.ts)' to the P2-T1 PLAN entry.
- **Evidence:** PLAN P2-T1 entry text ends 'lang TS.' with no gate clause, unlike P2-T2/T4/T8/T9 which each name a gate; the determinism guard is described in the DONE prose only.

## [LOW] state-mutation — packages/agent-runtime/src/supervision/supervised-spawn.ts — P2-T8 process-group teardown ownership between supervisor and supervised-spawn seam unverified
- **Risk:** process-supervisor.ts implements the negative-pid group kill (killGroup, :125-129, detached:true :192) and its docblock says injected seams without a killGroup 'fall back to the direct-pid kill'. Whether supervised-spawn.ts's default seam threads killGroup (so real Bun children with shell grandchildren get group teardown) was not verifiable from the evidence gathered; if it does not, timed-out supervised children leak grandchildren despite the D36 guarantee.
- **Fix:** Verify supervised-spawn.ts passes killGroup into spawnSettledSubagent; add a test pinning group teardown for a fixture child that spawns a grandchild, or record the limitation.
- **Evidence:** process-supervisor.ts:25-27 'the child as a group leader (Bun.spawn detached: true)' and :126-129 killGroup contract; PLAN P2-T8 slice-1 note 'process-group teardown rides the adoption slice (fixture children have no grandchildren)'. The adoption slice landed; its killGroup threading was not confirmed in this shard's reads.

## Coverage receipt

### Subsystems
- agent-runtime-run-journal
- agent-runtime-supervision
- agent-runtime-clock-idgen
- cli-run-journal-path
- cli-dash-command
- cli-replay-command
- cli-turn-snapshots
- cli-index-dir-watch
- sdk-dash-provider
- sdk-transaction-intent-log
- common-agent-handoff-schema
- common-commit-receipt-schema
- agents-workflow-engine

### Features
- P2-T1
- P2-T2
- P2-T3
- P2-T4
- P2-T5
- P2-T6
- P2-T7
- P2-T8
- P2-T9
- ORCH-1
- ORCH-3
- ORCH-6
- ORCH-7
- EV-2
- EV-5
- EV-8
- SB-3
- S7
- PR-T1
- X-1

### Files
- .agents/sessions/polyglot-roadmap-v2/PLAN.md
- .agents/sessions/polyglot-roadmap-v2/STATUS.md
- .agents/sessions/reaudit-polyglot-2026-09/REAUDIT-REPORT.md
- packages/agent-runtime/src/util/run-journal.ts
- packages/agent-runtime/src/util/run-replay-driver.ts
- packages/agent-runtime/src/util/__tests__/run-journal.test.ts
- packages/agent-runtime/src/supervision/process-supervisor.ts
- packages/agent-runtime/src/supervision/child-entry.ts
- packages/agent-runtime/src/supervision/__tests__/child-entry.test.ts
- cli/src/utils/run-journal-path.ts
- cli/src/commands/dash-command.ts
- cli/src/commands/replay-command.ts
- cli/src/utils/turn-snapshots.ts
- cli/src/commands/router.ts
- cli/src/utils/__tests__/turn-snapshots.test.ts
- cli/src/commands/__tests__/bash-command.test.ts
- cli/src/utils/__tests__/index-workspace-watcher.test.ts
- sdk/src/dash/provider.ts
- sdk/src/tools/transaction-intent-log.ts
- sdk/src/tools/change-file.ts
- sdk/src/tools/__tests__/transaction-intent-log.test.ts
- common/src/tools/results/filesystem.ts
- common/src/tools/params/__tests__/x1-golden-vectors.test.ts
- common/src/types/agent-handoff.ts
- agents/base2/base2.ts
