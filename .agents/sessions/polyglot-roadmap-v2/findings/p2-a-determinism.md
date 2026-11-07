# Audit findings: p2-a-determinism

- Subsystems: agent-runtime-contracts, agent-runtime-run-loop, agent-runtime-background-jobs, agent-runtime-tool-execution, agent-runtime-memory, agent-runtime-orchestration, repo-determinism-guard
- Features: P2-T1, P2-T1b, ORCH-6
- Files covered: 26

## [LOW] correctness — common/src/types/contracts/agent-runtime.ts:13 — VERIFIED: IdGen/Clock contracts + optional deps fields match PLAN P2-T1
- **Risk:** none (verification finding)
- **Fix:** none
- **Evidence:** agent-runtime.ts:13-30 defines IdGen {uuid(), prefixedId(prefix, separator?)} and Clock {now()} doc-commented P2-T1; AgentRuntimeDeps carries optional idGen?/clock? fields plus journalWriter?/journalReader? (P2-T2) and processSupervision?/spawnSupervised? (P2-T8). Matches PLAN claim of optional additive fields.

## [LOW] correctness — common/src/deps/real-runtime-deps.ts:4 — VERIFIED: realIdGen/realClock defaults exist and are the sanctioned ambient source
- **Risk:** none (verification finding)
- **Fix:** none
- **Evidence:** real-runtime-deps.ts:4-12: realIdGen.uuid()=crypto.randomUUID(), prefixedId wraps it; realClock.now()=Date.now(). The guard header explicitly scopes this file OUT of scanning ('everything outside the subtree ... is out of scope by construction').

## [LOW] correctness — packages/agent-runtime/src/run-agent-step.ts:551 — VERIFIED: run paths use injected idGen/clock; ambient identity minting removed from identity sites
- **Risk:** none (verification finding)
- **Fix:** none
- **Evidence:** run-agent-step.ts:551-556 `const idGen = params.idGen ?? realIdGen; const clock = params.clock ?? realClock; const agentStepId = idGen.uuid()` (line numbers shifted from PLAN's :538 due to later edits); loopAgentSteps resolves clock at :1479 and threads clock.now() into reconcileInterruptedLedgerSpawns:1488, reconcileInterruptedBackgroundAgentIntents:1520, and :2317/:2459/:2782 append sites. run-programmatic-step.ts:296 idGen ?? realIdGen, :519 agentStepId = idGen.uuid(), :945-946 toolCallId = idGen.uuid() (PLAN said :489/:892 — drifted, sites converted).

## [LOW] test-coverage — packages/agent-runtime/src:1 — VERIFIED: zero TODO(P2-T1b) and TODO(P2-T2) markers remain in agent-runtime; guard semantics match plan
- **Risk:** none (verification finding)
- **Fix:** none
- **Evidence:** code_search for TODO(P2-T1b) and TODO(P2-T2) across packages/agent-runtime/src returns 0 matches; only 3 NOTE(P2-T1) markers remain (workflow-engine.ts:46, templates/strings.ts:170, spawn-agent-utils.ts:956). determinism-guard.ts isMarkerSuppressed scans lines N-8..N (8-line window matching PLAN); missing baseline file => empty baseline => every unmarked call is excess (fail-closed); malformed/wrong-shape baseline throws naming the file; excess reports the LAST (current - baseline) unsuppressed lines per kind.

## [LOW] correctness — scripts/check-ci-local.ts:410 — VERIFIED: guard wired into CI-local Step E with checked-in baseline
- **Risk:** none (verification finding)
- **Fix:** none
- **Evidence:** scripts/check-ci-local.ts:410-421 runs `bun --cwd=scripts run guard:determinism` as Step E and fails the suite on non-zero status; scripts/package.json:13 defines guard:determinism = bun run determinism-guard.ts; scripts/determinism-guard-baseline.json checked in with 19 file entries, schemaVersion 1.

## [MEDIUM] correctness — scripts/determinism-guard-baseline.json:1 — GAP: baseline is stale-high in 4 files, granting silent excess capacity for new unmarked Date.now calls
- **Risk:** The guard only fails on counts EXCEEDING baseline. Four files were converted below their baselined counts without regenerating the baseline: spawn-agents.ts (baseline 5, current 2), task-memory.ts (2, current 1), check-background-agent.ts (1, current 0), record-decision.ts (1, current 0). Together these grant 5 untracked Date.now insertions across the most recently-converted files before CI would notice, weakening the plan's 'any NEW unmarked call breaks CI' guarantee.
- **Fix:** Run `bun --cwd=scripts run guard:determinism -- --update-baseline` (or the writeDeterminismBaseline path) and commit the regenerated baseline so counts match the current tree; consider a CI check that baseline == current counts to prevent drift.
- **Evidence:** code_search Date\.now\(|randomUUID\( per file: spawn-agents.ts matches only :623,:630 vs baseline dateNow:5; task-memory.ts only :362 vs 2; check-background-agent.ts 0 matches vs 1; record-decision.ts 0 matches vs 1. All other baseline entries (context7-api 20, web-search 7, read-docs 3, discovery-coordinator 3, context-archive 2, run-agent-step 5, tool-executor 2, workspace-path-leases 6+1, orchestration-ledger 1+1, cache-debug 1, tool-stream-parser 1, gemini 1, update-plan-status 1, context-consolidation-runner 1) match current counts exactly.

## [MEDIUM] correctness — packages/agent-runtime/src/orchestration/discovery-coordinator.ts:552 — GAP: persisted discovery-shard timestamps use ambient Date.now with no deferral marker or documented rationale
- **Risk:** claimDiscoveryShard assignedAt (:552), tryClaimDiscoveryShard completedAt (:895), and recordDiscoveryResult completedAt (:945) persist wall-clock timestamps into the agentState discovery-coverage shards, which survive across sessions/replay. Under P2-T2 §5 these are replay-relevant persisted timestamps, but they carry no TODO(P2-T1b)/NOTE(P2-T1) marker and no recorded rationale, so the guard baseline (3) is the only thing covering them.
- **Fix:** Either add an optional now?/clock thread to the discovery coordinator from the loop's injected clock, or add an explicit NOTE(P2-T1) marker with rationale (like workflow-engine.ts:46) so the deferral is documented at the site rather than only in the baseline count.
- **Evidence:** code_search results: discovery-coordinator.ts:552 assignedAt: Date.now(), :895 completedAt: Date.now(), :945 const completedAt = Date.now(). File appears in baseline with dateNow:3, randomUuid:0. No TODO/NOTE marker appears in this file (0 matches for any P2-T1 marker in it).

## [LOW] correctness — packages/agent-runtime/src/util/context-consolidation-runner.ts:119 — GAP: consolidation consolidatedAt persists ambient Date.now, unmarked
- **Risk:** ContextConsolidation.consolidatedAt (:119) is persisted into agentState.contextConsolidations (which P2-T2 verified survives cross-session restore). It is a replay-relevant persisted timestamp with no marker and no documented rationale; covered only by the baseline count (1).
- **Fix:** Thread the injected clock (maybeRunBackgroundConsolidation is called from the run loop where clock is resolved) or add a NOTE(P2-T1) deferral marker with rationale.
- **Evidence:** code_search: context-consolidation-runner.ts:119 `consolidatedAt: Date.now()`; baseline dateNow:1; no P2-T1 markers in file.

## [LOW] correctness — packages/agent-runtime/src/tools/tool-executor.ts:3304 — PARTIAL: tool-executor clock threading covers evidence paths but ToolMessage.sentAt stays ambient
- **Risk:** tool-executor.ts:3343 and :3358 correctly pass `now: (params.clock ?? realClock).now()` to the buffered-evidence paths (P2-T1b claim VERIFIED), but the two ToolMessage.sentAt sites (:3304, :3691) still use ambient Date.now() — sentAt is persisted in message history (replay-correlation field per P2-T2 §5) with no marker and no recorded rationale; only baseline coverage (dateNow:2).
- **Fix:** Thread clock.now() into the ToolMessage construction (clock is already resolved in scope for the evidence calls), or mark both sites with NOTE(P2-T1) + rationale.
- **Evidence:** code_search: tool-executor.ts:3304 sentAt: Date.now(), :3691 sentAt: Date.now() (baseline dateNow:2); :3343/:3358 now: (params.clock ?? realClock).now().

## [LOW] correctness — packages/agent-runtime/src/tools/handlers/tool/spawn-agents.ts:623 — PARTIAL: spawn-agents lifecycle clock threading done; background chunk timestamps stay ambient
- **Risk:** The P2-T1b-claimed paths are converted and VERIFIED (intent timestamps :206, completedAt :686/:772, abandonedAt :822 all use (params.clock ?? realClock).now()), but appendBackgroundAgentChunk timestamps (:623, :630) still use ambient Date.now() with no marker. These are process-scoped polling-chunk stamps (not journaled), so impact is LOW, but they are unmarked unconverted sites.
- **Fix:** Add a NOTE(P2-T1) marker documenting chunk stamps as non-replay-critical, or pass clock.now() through the onResponseChunk closure.
- **Evidence:** code_search: spawn-agents.ts:623/:630 timestamp: Date.now(); :206/:686/:772/:822 use (params.clock ?? realClock).now(). Baseline dateNow:5 is stale-high vs current 2.

## [LOW] correctness — packages/agent-runtime/src/tool-stream-parser.ts:216 — COHERENCE: PLAN says tool-stream-parser xml-id was 'TODO-commented' but no TODO marker remains — site is now bare-baseline-covered
- **Risk:** PLAN P2-T1 slice-1 text states the tool-stream-parser.ts:216 xml-id site is 'TODO-commented in tool-stream-parser'. Actual code has the raw `xml-${crypto.randomUUID()}` (:217) with NO TODO(P2-T2)/TODO(P2-T1b)/NOTE marker anywhere in the file; the site is covered only by the baseline count (randomUuid:1). The P2-T1b FINISHED text's 'no TODO(P2-T1b) markers remain' is accurate, but the earlier slice narrative no longer matches the tree.
- **Fix:** Either convert the xml-id mint to an injected idGen (parseTextWithToolCalls accepts deps) or restore an explicit NOTE(P2-T1) deferral marker documenting why it stays ambient.
- **Evidence:** tool-stream-parser.ts:217 `const toolCallId = `xml-${crypto.randomUUID()}``; code_search TODO(P2-T1b)|TODO(P2-T2)|NOTE(P2-T1) in packages/agent-runtime/src returns 0 matches in tool-stream-parser.ts; baseline entry tool-stream-parser.ts randomUuid:1.

## [LOW] correctness — packages/agent-runtime/src/util/cache-debug.ts:191 — GAP: cache-debug snapshotId randomUUID unmarked; workspace-path-leases leaseId randomUUID unmarked
- **Risk:** PLAN deferred 'util/{cache-debug,workspace-path-leases,orchestration-ledger}.ts randomUUID sites' but after the marker sweep none of these carry a deferral marker; they are covered only by baseline counts. cache-debug.ts:191 snapshotId = randomUUID() (debug-snapshot naming, non-replay-critical — LOW); workspace-path-leases.ts:74 leaseId = randomUUID() feeds a DURABLE lease record alongside Date.now-based expiresAt (:75,:108,:143,:150,:164) — leases are persisted state, so leaseId nondeterminism plus ambient timestamps are both replay-relevant (MEDIUM-adjacent, LOW here because leases reconcile via expiresAt sweep).
- **Fix:** Mark both sites with NOTE(P2-T1) + rationale (operational/debug id) or convert to injected idGen via the deps thread that already reaches background-agent-jobs.
- **Evidence:** cache-debug.ts:191 `const snapshotId = randomUUID()` (baseline randomUuid:1, file imports from node:crypto); workspace-path-leases.ts:74 leaseId = randomUUID(), :41 sweep(now = Date.now()) default-arg contract documented in PLAN, 6 dateNow + 1 randomUuid in baseline; 0 marker matches in either file.

## [LOW] correctness — packages/agent-runtime/src/orchestration/workflow-engine.ts:46 — VERIFIED: the three remaining NOTE(P2-T1) markers document non-replay-critical rationale as claimed
- **Risk:** none (verification finding); one PLAN-coherence nit
- **Fix:** none; optionally update the PLAN slice-1 wording since the tool-stream-parser TODO is gone
- **Evidence:** workflow-engine.ts:46 NOTE(P2-T1) documents the Date.now() fallback (params.now ?? Date.now(), :51) — matches the P2-T6 clock-injection note and P2-T6 records the workflow-engine baseline removal. templates/strings.ts:170 NOTE(P2-T1) documents formatCurrentDate/CURRENT_DATE as non-persisted prompt content (explicitly EXCLUDED per PLAN). spawn-agent-utils.ts:956 NOTE(P2-T1) documents the :959 oversize-artifact TTL sweep as operational mtime expiry, not a replay-critical timestamp.

## [LOW] correctness — packages/agent-runtime/src/util/task-memory.ts:362 — VERIFIED: task-memory evidence paths use injected clock with realClock fallback as claimed
- **Risk:** none (verification finding)
- **Fix:** none
- **Evidence:** task-memory.ts:6 imports realClock; :362 `const updatedAt = params.now ?? Date.now()` (commitTaskMemory converted with fallback), :423 and :634 `verifiedAt: params.now ?? realClock.now()` for deriveToolEvidence/mergeAgentReceiptIntoTaskMemory — matches the P2-T1b text that the buffered per-result caller chain keeps a narrow fallback (the tool-executor :3343/:3358 now: thread covers the buffered callers).

## [LOW] correctness — packages/agent-runtime/src/util/background-agent-jobs.ts:355 — VERIFIED: background-agent-jobs lifecycle fns thread optional now with realClock fallback as claimed
- **Risk:** none (verification finding)
- **Fix:** none
- **Evidence:** background-agent-jobs.ts:38 imports realClock; :355 startedAt ?? params.now ?? realClock.now(), :626/:828/:898 job.completedAt = now ?? realClock.now(); callers converted per P2-T1b FINISHED: run-agent-step.ts:1520 reconcileInterruptedBackgroundAgentIntents(initialAgentState, clock.now()), spawn-agents.ts:206/:686/:772/:822, check-background-agent.ts:221 (clock ?? realClock).now(). No TODO(P2-T1b) markers remain (0 search matches).

## [LOW] correctness — packages/agent-runtime/src/util/orchestration-ledger.ts:86 — VERIFIED: orchestration-ledger accepts optional now with documented fallback chain
- **Risk:** none (verification finding)
- **Fix:** none
- **Evidence:** orchestration-ledger.ts:86 `timestamp: params.event.timestamp ?? params.now ?? Date.now()` and :56 eventId default randomUUID() — matches the PLAN's 'optional now? added but left on the fallback' description; both sites are baseline-covered (dateNow:1, randomUuid:1) and loopAgentSteps threads clock.now() at run-agent-step.ts:1488 reconcileInterruptedLedgerSpawns.

## [LOW] correctness — packages/agent-runtime/src/tools/handlers/tool/record-decision.ts:31 — VERIFIED: record-decision uses injected clock for updatedAt/evidenceId/verifiedAt as claimed
- **Risk:** none (verification finding)
- **Fix:** none
- **Evidence:** record-decision.ts:31-32 'P2-T1b: timestamps use the injected clock (realClock default)'/evidenceTimestamp = (params.clock ?? realClock).now(); :157 verifiedAt uses the injected clock. Matches P2-T1b DONE text including the persisted-supersedes fix context.

## [LOW] correctness — packages/agent-runtime/src/run-agent-step.ts:1979 — NOTE: remaining ambient Date.now sites in run-agent-step are operational, except sentAt
- **Risk:** :547/:818/:1294 are step-duration metrics and :1979 is the 30s mid-turn checkpoint throttle clock (operational interval, not persisted as state content) — consistent with the guard's design of allowing legacy sites via baseline. :1883 sentAt: Date.now() on a ToolMessage IS a persisted message-history timestamp, same class as tool-executor.ts:3304 (see that finding); unmarked, baseline-covered (dateNow:5 total).
- **Fix:** Fold run-agent-step.ts:1883 into the sentAt clock-threading fix recommended for tool-executor.ts.
- **Evidence:** code_search: run-agent-step.ts:547,818,1294,1883,1979 Date.now (baseline dateNow:5, exactly consumed).

## Coverage receipt

### Subsystems
- agent-runtime-contracts
- agent-runtime-run-loop
- agent-runtime-background-jobs
- agent-runtime-tool-execution
- agent-runtime-memory
- agent-runtime-orchestration
- repo-determinism-guard

### Features
- P2-T1
- P2-T1b
- ORCH-6

### Files
- common/src/types/contracts/agent-runtime.ts
- common/src/deps/real-runtime-deps.ts
- packages/agent-runtime/src/run-agent-step.ts
- packages/agent-runtime/src/run-programmatic-step.ts
- packages/agent-runtime/src/util/background-agent-jobs.ts
- packages/agent-runtime/src/util/task-memory.ts
- packages/agent-runtime/src/util/orchestration-ledger.ts
- packages/agent-runtime/src/util/context-archive.ts
- packages/agent-runtime/src/util/workspace-path-leases.ts
- packages/agent-runtime/src/util/cache-debug.ts
- packages/agent-runtime/src/util/context-consolidation-runner.ts
- packages/agent-runtime/src/tool-stream-parser.ts
- packages/agent-runtime/src/tools/tool-executor.ts
- packages/agent-runtime/src/tools/handlers/tool/record-decision.ts
- packages/agent-runtime/src/tools/handlers/tool/spawn-agents.ts
- packages/agent-runtime/src/tools/handlers/tool/check-background-agent.ts
- packages/agent-runtime/src/orchestration/discovery-coordinator.ts
- packages/agent-runtime/src/orchestration/workflow-engine.ts
- packages/agent-runtime/src/templates/strings.ts
- packages/agent-runtime/src/tools/handlers/tool/spawn-agent-utils.ts
- scripts/determinism-guard.ts
- scripts/determinism-guard-baseline.json
- scripts/check-ci-local.ts
- scripts/package.json
- .agents/sessions/polyglot-roadmap-v2/PLAN.md
- .agents/sessions/polyglot-roadmap-v2/STATUS.md
