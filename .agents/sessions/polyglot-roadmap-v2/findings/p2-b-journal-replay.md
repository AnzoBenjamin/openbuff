# Audit findings: p2-b-journal-replay

- Subsystems: agent-runtime-run-journal, agent-runtime-replay-driver, agent-runtime-loop-journaling, cli-journal-wiring, sdk-journal-threading, dash-journal-provider
- Features: ORCH-1, ORCH-6, P2-T2-journal-slices-1-4, P2-T3-replay-cli
- Files covered: 24

## [MEDIUM] correctness — packages/agent-runtime/src/run-agent-step.ts:1379 — executeRunResumeReport / resumeDriver has no production caller — test-only, documented only in code comments
- **Risk:** The kill-9 resume story is not reachable in production: a real crash-resumed run journals its state but nothing ever acts on the report, so an in-flight side-effecting tool's resume classification is built and logged but never re-driven. The PLAN's 'wired' wording can be read as production-wired.
- **Fix:** Either wire a production resumeDriver in cli/src/commands/run-command.ts + use-send-message.ts (where journalWriter/journalReader are already threaded) or annotate PLAN.md P2-T2 and run-agent-step.ts:1372 to state explicitly that the driver seam is test-only pending the live re-drive slice.
- **Evidence:** code_search for 'resumeDriver' over sdk/src + cli/src returns 0 matches; only run-agent-step.ts and test files reference it. run-replay-driver.ts:45-55 docblock: 'no in-repo production re-launch path exists outside tests'; 'resume-from-own-journal for background agents stays deferred' (lines 36-43). PLAN.md:88 replay-driver+slice-4 entry claims '(b) wired additively in run-agent-step.ts' — accurate only about the seam existing inside the not-clean branch, not about a production caller. Corroborated by prior shard .agents/sessions/audit-phases-p0-p3-2026-10/findings/shard-p2-durability.md:106.

## [LOW] correctness — .agents/sessions/polyglot-roadmap-v2/PLAN.md:88 — PLAN P2-T2 marked fully [x] with no REMAINING note while background resume-from-own-journal is silently deferred
- **Risk:** A killed background researcher/librarian intent is classified 'respawn' but never actually re-launched by any in-repo path; the PLAN checkbox overstates completion of ORCH-1's 'background agents included' resume promise.
- **Fix:** Append a one-line REMAINING/known-gap note to PLAN.md P2-T2 pointing at run-replay-driver.ts:36-55, or file it as an explicit follow-up task, so the checkbox [x] matches the implemented scope.
- **Evidence:** run-replay-driver.ts:36-43 'Known remaining gap ... resume-from-own-journal for background agents stays deferred ... the reDriveChild/respawnBackground seams still do not replay a background child from its own journal.' PLAN.md:88 final sub-slice: 'BACKGROUND-JOURNALING SUB-SLICE DONE 2026-10-02 (the last declared remaining work)' with no trailing REMAINING clause. run-journal.test.ts:875+ covers child kill-9 classification, but respawnBackground is only exercised by injected test handlers.

## [LOW] correctness — packages/agent-runtime/src/run-programmatic-step.ts:712 — PLAN claim that the run-programmatic-step per-child spawn append 'dedupes against' the launch-time intent is not literally implemented
- **Risk:** Only a doc-accuracy discrepancy: two spawn events per background child (jobId-correlated and childRunId-correlated) can coexist in the journal; classifier semantics tolerate it today, but any future consumer matching spawn events by runId could double-count.
- **Fix:** Correct the PLAN wording ('coexists with, not dedupes against') or add an actual dedupe guard keyed on childRunId in run-programmatic-step.ts:712 if a shared correlation is introduced later.
- **Evidence:** spawn-agents.ts:570-584 appends {eventType:'spawn', correlation: job.jobId, payload:{agentType, background:true, jobId}}; run-programmatic-step.ts:712-719 appends {eventType:'spawn', correlation: childRunId, payload:{childRunId}} unconditionally for newChildRunIds. No dedupe check exists in either file (code_search 'dedupe' in run-programmatic-step.ts: 0 matches). planChildResume keys on correlation matching a later step_boundary, so duplicate spawn intents with different correlations do not corrupt classification.

## [LOW] correctness — cli/src/commands/replay-command.ts:125 — replay command does not itself consume toolResultForInput — it re-emits journaled results only; --model is annotation-only
- **Risk:** Low: the short-circuit IS consumed where it matters (the runtime's live resume path), and the CLI replay is a pure deterministic re-emission that doubles as the eval-fixture export. The shard prompt's expectation ('consumed by the replay command path') is not met literally but the design doc's intent is honored.
- **Fix:** No code change required; optionally reword PLAN.md P2-T3 to 'short-circuit semantics preserved (replay re-emits journaled results, never re-executes)' for precision.
- **Evidence:** replay-command.ts:184-205: journal.events(runId) → filter by stepNumber → journalEventToPrintModeEvent → writeStdout; no toolResultForInput call anywhere in the file (code_search: only the docblock at line 127). Docblock 121-131: 'The replay NEVER re-executes a side-effecting tool ... any live re-drive on resume stays the runtime's job via the toolResultForInput short-circuit ... which this command does not bypass.' Runtime consumption verified at run-programmatic-step.ts:963-991 (occurrence counter via agentRunContextRegistry.nextReplayOccurrence at :965). PLAN.md:89 wording 'toolResultForInput short-circuit respected' matches this design.

## [LOW] error-handling — sdk/src/run.ts:1271 — journalWriter flush/close handled at CLI run end but not in sdk/src/run.ts; background children can outlive the closed connection
- **Risk:** If a future caller enables batching (createRunJournal batching option) through the SDK without closing, buffered events are lost on abrupt end; today the CLI owns close so exposure is limited to SDK-embedding hosts. Background children racing the close are handled fail-open by design.
- **Fix:** Consider a flush()/close() call in sdk/src/run.ts run teardown for SDK-embedded consumers that bypass the CLI, so batching adopters do not depend on host-side cleanup.
- **Evidence:** cli/src/commands/run-command.ts:238-249 and cli/src/hooks/use-send-message.ts:733-743 close the journal in finally, best-effort. code_search for close/flush in sdk/src/run.ts finds only journalWriter/journalReader threading (:411, :742, :1271). cli/src/utils/run-journal-path.ts:44-48 keeps batching opt-in and 'flush-per-append is the kill-9 crash-resume durability contract', so unflushed-batch loss cannot occur in the default wiring. run-agent-step.ts:938-961 and spawn-agents.ts:570-584 guard every append try/catch with 'closed connection raced by a detached background child' documented as fail-open.

## Coverage receipt

### Subsystems
- agent-runtime-run-journal
- agent-runtime-replay-driver
- agent-runtime-loop-journaling
- cli-journal-wiring
- sdk-journal-threading
- dash-journal-provider

### Features
- ORCH-1
- ORCH-6
- P2-T2-journal-slices-1-4
- P2-T3-replay-cli

### Files
- packages/agent-runtime/src/util/run-journal.ts
- packages/agent-runtime/src/util/run-replay-driver.ts
- packages/agent-runtime/src/util/__tests__/run-journal.test.ts
- packages/agent-runtime/src/util/__tests__/run-replay-driver.test.ts
- packages/agent-runtime/src/run-agent-step.ts
- packages/agent-runtime/src/run-programmatic-step.ts
- packages/agent-runtime/src/tools/tool-executor.ts
- packages/agent-runtime/src/tools/handlers/tool/spawn-agents.ts
- packages/agent-runtime/src/tools/handlers/tool/spawn-agent-utils.ts
- packages/agent-runtime/src/tools/handlers/tool/spawn-agent-inline.ts
- common/src/types/contracts/agent-runtime.ts
- sdk/src/run.ts
- sdk/src/impl/agent-runtime.ts
- sdk/src/dash/provider.ts
- sdk/src/__tests__/run-journal-wiring.test.ts
- cli/src/cli-args.ts
- cli/src/commands/run-command.ts
- cli/src/commands/replay-command.ts
- cli/src/commands/dash-command.ts
- cli/src/utils/run-journal-path.ts
- cli/src/hooks/use-send-message.ts
- cli/src/index.tsx
- .agents/sessions/polyglot-roadmap-v2/PLAN.md
- .agents/sessions/polyglot-roadmap-v2/P2-T2-DESIGN.md

### Domains
- correctness
- error-handling
- state-mutation
- test-coverage
