# P2 coherence audit — synthesis (2026-10-05)

Scope: PLAN.md P2 section (P2-T1…P2-T9) vs. source tree. Method: 8 parallel audit shards (p2-a…p2-h), each verifying claims against source with file:line evidence; orchestrator spot-verified the highest-impact claims (resumeDriver callers, transitionBase2GateSafe consumers, killGroup threading). Per-shard artifacts: `p2-a-determinism.md` … `p2-h-coherence.md` in this directory. Read-only audit — no edits, no test re-runs (suite greenness rests on PLAN/STATUS attestation).

## Verdict

The P2 phase is **substantively coherent**: every declared task has real, landing-quality implementation behind it, dependencies (P2-T1→T2→T3; PR-T1/T2/T6→P2-T8) hold in code, every named gate artifact exists, and the traceability matrix mappings check out against the re-audit report. However, **the phase is not gap-free**: 0 CRITICAL / 0 HIGH, **~14 MEDIUM** and ~25 LOW findings across shards, concentrated in three honest-but-real categories:

1. **Deferred items with no owning task** (the largest class): five "rides a later slice" notes in PLAN have no named owner.
2. **Plan-text overclaims**: three tasks marked `[x]` whose headline overstates the landed slice (P2-T3 `--model`, P2-T6 "drives the gate", P2-T7 "replay").
3. **Test/gate softness**: several gates pass by trace or mock-level wiring rather than end-to-end exercise, and two are platform-gated or simulated.

## MEDIUM findings (consolidated)

| # | Task | Finding | Evidence |
|---|------|---------|----------|
| M1 | P2-T2 | **Production crash-resume is classify-and-log only.** `executeRunResumeReport` has zero production callers — the `resumeDriver` seam exists in run-agent-step.ts:1379/:1580 but nothing in sdk/cli passes it; loopAgentSteps builds the resume report and only warns. Plan wording is technically accurate but "resume a run at the in-flight step" is not user-reachable yet. | code_search `resumeDriver` in sdk/cli = 0 matches; run-replay-driver.ts:45-55 admits test-only |
| M2 | P2-T2 | **Background-agent resume-from-own-journal silently dropped from PLAN.** P2-T2 is `[x]` with "the last declared remaining work" closed, while run-replay-driver.ts:36-55 documents background resume as an unimplemented known gap. | run-replay-driver.ts:36-55 |
| M3 | P2-T6 | **`transitionBase2GateSafe` is production-unconsumed and the deferral has no owning task.** base2.ts:7397 still drives the gate through the throwing transition path inside a local try/catch. | code_search in agents/base2 = 0 hits (orchestrator-verified) |
| M4 | P2-T6 | **Checkbox overclaims the headline** ("drives the gate") the bounded slice deliberately did not achieve; the engine's own header says ADVISORY/TELEMETRY-ONLY. | workflow-engine.ts:1-15 |
| M5 | P2-T3 | **`--model M` is annotation-only** — replay re-emits the journaled stream; no live LLM pass, no model fork. PLAN `[x]` DONE entry does not record the limitation. | replay-command.ts:128-131 |
| M6 | P2-T8 | **Flag-on today degrades every subagent to `unsupported-deps`.** The supervised path fails closed for children needing parent callbacks; no RPC bridge exists and no PLAN task owns it. Flag-on is honest-failing, not supervised execution. | child-entry.ts:48-65/:124-131 |
| M7 | P2-T8 | **Supervised-child env allowlist omits keys a real run needs** — provider base-URL overrides, HTTP(S)_PROXY/NO_PROXY, TMPDIR, LANG/LC_*, `CODEBUFF_RG_PATH` (itself an X-1 golden-vector override). Real supervised children would be silently misconfigured. | process-supervisor.ts:473-481, sdk/src/impl/agent-runtime.ts:67-82 |
| M8 | P2-T8 | **ORCH-3 "restart policies" half untracked** — supervision delivers hard kill but zero restart/respawn logic; respawn exists only on P2-T2's background-intent path. | process-supervisor.ts (no restart logic) |
| M9 | P2-T4 | **Pre-dispatch shell snapshot races the command** — fire-and-forget snapshot (5+ sequential git subprocesses) can lose to a fast mutating command; pre-command capture is best-effort, not guaranteed. | router.ts:98-103 |
| M10 | P2-T4 | **Snapshot failures are silently dropped** at both call sites (`.catch(() => undefined)`); persistent git failure means undo coverage lapses with zero signal. | send-message.ts:516-521, router.ts:103 |
| M11 | P2-T4 | **Bisect concurrency guard is process-local** — two concurrent CLI instances can interleave checkout rewrites. | turn-snapshots.ts:529 |
| M12 | P2-T4 | **Gate verified only at mock level on the bash path** — no end-to-end bash-write → snapshot → undo → tree-reverted test. | bash-command.test.ts:210-219 spies only |
| M13 | P2-T1 | **Stale-high determinism baseline** — 4 files were converted below their baselined counts without `--update-baseline`, granting 5 silent unmarked `Date.now` insertions in exactly the just-converted files before CI fails. Also ~7 unmarked persisted-timestamp sites (discovery-coordinator assignedAt/completedAt, context-consolidation-runner consolidatedAt, ToolMessage.sentAt) covered by baseline only, no marker/rationale. | p2-a findings; discovery-coordinator.ts:552/:895/:945 |
| M14 | P2-T9 | **fd-cap overflows and watch failures are silent** — dropped subtrees are never logged/counted/reported; user cannot tell live watching is partial. Plus the plan's suggested `index.watch` capability reporting is absent. | index-dir-watch.ts:134-138 |

Also MEDIUM-adjacent (p2-b): PLAN text claims the per-child spawn append "dedupes against" the launch-time intent — no dedupe exists (different correlations coexist; harmless today, but the plan text is inaccurate).

## Resolved during synthesis

- **killGroup threading (p2-h L7):** RESOLVED — the default supervision seam implements the negative-pid group kill (supervised-spawn.ts:22-26, process-supervisor.ts:205/:316-321); residual is only the missing real-grandchild reaping test (p2-f).
- **P2-T5 tx_abort on exceptions:** NOT a gap — change-file.ts:801-898 catch is the shared path for all throw types and always appends tx_abort. Real residual: a failed tx_commit append AFTER files committed leaves a tx_begin-only record that startup recovery will revert — committed work is destroyed (lossy fail-open direction; p2-d MEDIUM-class).
- **P2-T4 untracked-file coverage:** honest documented limitation (docblock + command success messages disclose it; plan marks SB-3 partial) — not a silent gap.

## LOW findings (summary)

- Docs/plan hygiene: STATUS.md has no P2 completion append and still lists "P2+" as open (L); P2-T1 is the only P2 task with no declared `gate:` clause; PLAN line citations for P2-T1 drifted (sites converted, citations stale); PLAN "before and after each turn and each shell command" wording only partially honored (no after-snapshot; after-shell only).
- P2-T7 dash: generated token reaches **stdout** via the URL in default serve mode (`openbuff dash | tee` captures the bearer secret; stderr-only claim doesn't hold); timeline is display-only (no interactive replay/scrub); journal open runs WAL/DDL (row-read-only, not connection-read-only); malformed non-Bearer auth silently downgrades; runIds() SQL wording cosmetic deviation.
- P2-T9 watcher: latent Windows separator bug in remove-prefix (unreachable today); permanent degradation latch (one worker crash disables pool, no retry); 250ms resweep + depth-8 leaves deep bootstrap-window dirs to the age sweep; gate test is Linux-gated so vacuous off-Linux CI; no end-to-end test through ensureIndexWorkspaceWatcher (mirror-harness only).
- P2-T5: recovery is once-per-process, not once-per-run (docstring honest, PLAN wording imprecise); symlink/ACL metadata outside both rollback tiers (documented).
- P2-T2: kill-9 gate is a deterministic simulation, not a real SIGKILL integration test; slice-1 reviewer advisories (unguarded JSON.parse on journal read, classifyRunResume full scan) have no owning task; P2-T6 PR-T5-era advisory: none.
- P2-T8: `OPENBUFF_PROCESS_SUPERVISION` undocumented in docs/; no flag-on end-to-end test with a real child; stale spawn-agent-utils.ts:2966 limitation comment contradicts the shipped killGroup; P2-T8 gate file name (spawn-settle-fault-injection.test.ts) covers receipt-chain faults while the D36 settle axes live in process-supervisor.test.ts — name-to-content mismatch, coverage exists.
- P2-T4: `git replace --graft` in pruneTurnSnapshots is a repo-global mutation undisclosed in the "private ref only" safety model; /restore hint dead-ends (no list subcommand).
- P2-T1: cache-debug snapshotId + workspace-path-leases leaseId randomUUID unmarked (baseline-only).

## What checked clean

- IdGen/Clock contracts, real defaults, and run-path injection: all verified; zero `TODO(P2-T1b)` markers remain; guard wired as check-ci-local Step E with matching suppression semantics (8-line window, fail-closed baseline, excess reporting).
- P2-T2 journal: all claimed symbols exist; kill-9 resume gate test present and strong; toolResultForInput short-circuit consumed by the live runtime path; background-coroutine journaling holds via the single choke point; CLI closes journals in finally; dash/replay/headless/TUI all share run-journal-path.ts.
- P2-T3 replay CLI: fail-closed arg parsing, ndjson export, journal closes.
- P2-T4: git-plumbing mechanics, busy-checks, sha validation, bisect bounds and restore-always-newest all match the plan.
- P2-T5: transactionId propagation (with an honest refinement — receipts stamp the id only when a durable intent record exists), intent-log bounds/locks/recovery, golden vectors untouched by construction.
- P2-T7 dash server auth/containment/caps and all four doc repoints verified.
- P2-T8: supervisor + child-entry contracts, PR-T1 envelope reuse (no second schema), flag-off byte-identical, both programmatic spawn sites covered.
- P2-T9: pool wiring, shared state machine, auto-add, unref semantics, production reachability via create-run-config, gate satisfied by source trace.

## Recommended follow-ups (priority order)

1. **Name owners for the 5 unowned deferrals** (PLAN edits): P2-T6 base2 transitionBase2GateSafe adoption; P2-T8 supervised-child RPC bridge; P2-T8 restart policies; P2-T2 background resume-from-own-journal; P2-T7 tmux-viewer parity. Each is a one-line PLAN amendment or a named sub-task id.
2. **Amend three `[x]` headlines** to record honest limitations: P2-T3 `--model` annotation-only; P2-T6 headline vs bounded slice; P2-T7 "replay" display-only.
3. **Decide the crash-resume story**: either wire a production resumeDriver (run-command.ts + use-send-message.ts already thread journals) or annotate P2-T2 that production resume is classify-and-log pending the live re-drive slice. This is the biggest gap between the plan's promise (ORCH-1) and user reachability.
4. **Regenerate the determinism baseline** (`--update-baseline`) and decide marker-vs-rationale for the ~7 unmarked persisted-timestamp sites; consider a CI baseline==counts check.
5. **Dash token hygiene**: route the default-serve URL (with embedded token) to stderr or print a tokenless URL + hint.
6. **Snapshot failure surfacing + race fix** on P2-T4 (log/count dropped snapshot outcomes; consider awaiting the snapshot before dispatch or accepting documented best-effort).
7. **Test closes**: end-to-end bash-write→snapshot→undo; supervised grandchild-reaping; ensureIndexWorkspaceWatcher integration on Linux; one real-SIGKILL journal resume integration test (opt-in).
8. **Supervised-child env allowlist** needs the missing operational keys before any flag-on use (proxy, TMPDIR, LANG, CODEBUFF_RG_PATH, provider base URLs).

 Shard artifact index: p2-a-determinism.md, p2-b-journal-replay.md, p2-c-turn-snapshots.md, p2-d-transactions-workflow.md, p2-e-dash.md, p2-f-supervision.md, p2-g-index-watcher.md, p2-h-coherence.md.
