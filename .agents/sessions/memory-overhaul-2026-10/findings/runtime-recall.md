# Audit findings: runtime-recall

- Subsystems: agent-runtime
- Features: task-memory, memory-v2-context, recall-context, record-decision, write-todos, update-plan-status, context-archive, archive-recall-index, context-consolidation, context-consolidation-runner, context-pruning, compaction-verification, spawn-agents-gate, compaction-retention-eval
- Files covered: 18
- Snapshot: 1d150eb58b494899bfe81792df3501634ce3d1a2b67c2c1ed52dff0532b75ec2

## [HIGH] correctness — packages/agent-runtime/src/run-agent-step.ts — Memory injection is per-step ephemeral messages, not session-start state
- **Risk:** Memory reaches the model only as step-scoped userMessage blocks that expire with timeToLive:'agentStep'; nothing persists across sessions in the runtime except agentState.taskMemory hydration, so memory cannot change agent behavior across sessions (owner thesis confirmed at the injection layer).
- **Fix:** Introduce a session-start hydration seam that compiles memory once per session with a deterministic read-back contract, instead of re-deriving ephemeral per-step blocks.
- **Evidence:** run-agent-step.ts:2221-2242 buildCompiledTaskMemoryMessage emits userMessage tagged ['TASK_MEMORY_CONTEXT'], timeToLive 'agentStep', keepDuringTruncation true, only when state.taskMemory exists AND no correlated memory-v2 context (2222: !getCorrelatedAuthoritativeV2(state)). run-agent-step.ts:2243-2253 buildCompiledMemoryV2Message emits ['MEMORY_V2_CONTEXT'] only when state.memoryAuthority.active === 'sqlite-v2-opt-in' AND memoryV2Context.userInputId === userInputId (2211-2219). V2 context staged per turn by sdk/src/services/memory-v2/coordinator.ts:1263-1274 only under the opt-in authority; degraded retrieval injects nothing (1259-1262). Assembled into messagesWithStepPrompt at 2254-2262, re-assembled after the programmatic step (2678-2686) and after mechanical trim (2822-2830); passed to runAgentStep as memoryContextMessages (2999-3002) and spliced after expireMessages(history,'agentStep') at 683-685.

## [MEDIUM] performance — packages/agent-runtime/src/util/task-memory.ts — Task-memory and memory-v2 budgets: ~36k chars root, ~12k chars V2, with freshness+relevance filtering
- **Risk:** Fixed char caps (not token-accurate) and section fractions silently drop entries below the compile threshold; a 36k-char V1 block or 12k-char V2 block is the entire automatic memory surface the model sees per step.
- **Fix:** Token-count-based budgets and priority-aware eviction rather than fixed char fractions; expose the dropped-entry count as telemetry.
- **Evidence:** task-memory.ts:17-21 ROOT_CONTEXT_CHARS=36000, CHILD_CONTEXT_CHARS=14000, review receipt 4000, current request 8000. compileTaskMemoryContext (1240-1261) computes model-scaled cap = max(2400, floor(contextWindowTokens*4*0.1)) min fixed cap. compileBoundedMemoryObject (1142-1238) filters: (a) freshness evidenceIsFresh vs memory.workspaceRevision (1170-1172; stale revision-guarded read/edit/validation/review entries dropped, REVISION_GUARDED_EVIDENCE_KINDS at 48-53), (b) relevance ranking evidenceRelevanceScore*33 + query-term score when focusPaths/request terms exist (1182-1204), evidenceLimit = max(2, floor((root?64:20)*scale)) at 1169, (c) per-section fractions requirements .2, decisions .1, blockers .13, nextActions .11, filesInspected/editsMade/validationResults .07 each, reviewReceipts .06 (1228-1235). Serialized as JSON inside <task_memory> with a caveat that earlier-session entries are NOT re-verified (1257). memory-v2-context.ts:7-8 MEMORY_V2_CONTEXT_MAX_CHARS=12000, CHILD_MAX_CHARS=2000; compileMemoryV2Context (95-379) renders prefix metadata (safety banner, rereadRequired warnings, degradation, ranking reasons, currentCoverage; prefix budget 10% of maxChars at 141) then five deterministic categories — verifiedKnowledge / reusableDiscovery / matchedTasks / rereadRequired / historicalContext (~244-370), each entry child-clipped and canonical-JSON sorted, verified excerpts clipped to 500 chars/evidence, final output clipped to maxChars.

## [HIGH] correctness — packages/agent-runtime/src/tools/handlers/tool/recall-context.ts — recall_context searches the per-call FTS5 archive index + consolidations; retrieval is strictly pull-based with zero push-injection at decision points
- **Risk:** The model must already know it needs a fact to call recall_context; no decision point (spawn_agents, git push, task completion) surfaces archived memory deterministically, so compacted evidence is only recovered when the model self-identifies the gap.
- **Fix:** Add push-injection at decision points (e.g. pre-spawn/pre-push playbook consult reading the archive index and consolidation store keyed by observed task state) in addition to the pull tool.
- **Evidence:** recall-context.ts:23-27 recallFromArchiveIndexed(agentState.compactionArchive, query) — in-memory bun:sqlite FTS5 index built PER CALL over flattened archive tool messages (archive-recall-index.ts:1-38 docblock; buildArchiveRecallRows 102-121), ORDER BY row_index DESC newest-snapshot-first (31-37), RECALL_MAX_RESULTS=6 x RECALL_SNIPPET_CHARS=600 (context-archive.ts:46-47). Second source: searchConsolidations(agentState.contextConsolidations, query) (recall-context.ts:29-42) OR-ranked bounded summaries, omitted entirely when none exist. Invocations strictly pull-based: the only runtime mentions are (a) the tool description telling the model to use it when retained <knowledge_memory> references a detail whose tool output was compacted away (common/src/tools/params/tool/recall-context.ts:28-30), and (b) the recovery clause of the context_compaction event when verifyExtractionCoverage found missing facts (run-agent-step.ts:2778-2781, 'recover verbatim via recall_context'). No push-injection before spawn_agents or before git-committer/push; the only deterministic push at a decision point is the behavior-negative gate guard (see finding procedural-gate-seam).

## [HIGH] state-mutation — packages/agent-runtime/src/tools/handlers/tool/record-decision.ts — record_decision writes to agentState.taskMemory.decisions+evidence; automatic read-back exists only via the compiled <task_memory> block
- **Risk:** Decisions are stored but never consulted deterministically before consequential actions (git ops, spawns, session resume); read-back is best-effort rendering inside a per-step block that freshness/ranking filters can drop, so recorded decisions do not gate behavior.
- **Fix:** Make decisions a first-class store read by a procedural gate (see procedural-gate-seam) and guarantee decision survival in compilation (no relevance-based drop for decisions tied to open plan tasks).
- **Evidence:** record-decision.ts:142-148 lazily initializes agentState.taskMemory and pushes '[' + kind + '] ' + rawText into memory.decisions (165-168, FIFO-capped by TASK_MEMORY_LIST_CAPS.decisions at 167-169) plus a structured evidence entry (kind decision/requirement/note, id 'decision:<ts>:<seq>', supersedes persisted, 203-224), evidence FIFO-capped (225-227). Validation: text <=1024 chars, rationale mandatory for decision/constraint via hasDecisionRationale (48-50), 1..32 evidenceSelectors classified by classifyMemoryArtifactPath (110-123), verbatim same-kind dedup (135-152). Automatic read-back is exactly two sites: (1) compileTaskMemoryContext renders memory.decisions into the per-step <task_memory> block (task-memory.ts:1229) with evidence subject to freshness/ranking (1170-1205); (2) compaction-verification.ts memoryCites (79+) checks filesInspected/editsMade, NOT decisions. Everything else is pull-only; the tool is session-scoped state, not a durable store — cross-session durability depends on the session layer hydrating agentState.taskMemory.

## [MEDIUM] state-mutation — packages/agent-runtime/src/tools/tool-executor.ts — Deterministic procedural gate seam: tool-executor.ts executeToolCall pre-dispatch (filterSpawnAgentsGate pattern); handleSteps cannot host it (stringified)
- **Risk:** The playbook-gate requirement ('consult playbook store keyed by observed task state before git-committer/push; run check:ci-local first') has one correct seam; placing it in base2's handleSteps is impossible because handleSteps is serialized via .toString() + new Function(), so a wrong placement silently never runs.
- **Fix:** Implement the playbook gate in tool-executor.ts pre-dispatch, mirroring filterSpawnAgentsGate: consult playbook store keyed by agentState/task state, rewrite effectiveInput or return a structured refusal; must cover spawn_agent_inline and run_terminal_command git-push paths.
- **Evidence:** tool-executor.ts:279-318 filterSpawnAgentsGate filters git-committer from a spawn_agents batch when canSuggestFollowups === false (gate not green), invoked at tool-executor.ts:2565-2580, second unvalidated-dirty-files guard ~2582-2823, COMMIT ANYWAY scoped bypass. Primary seam: executeToolCall pre-dispatch at tool-executor.ts:2563-2580 where effectiveInput for spawn_agents/spawn_agent_inline is already rewritten before the handler runs; spawn_agent_inline handled separately at ~3021. Alternative step-loop seam: run-agent-step.ts:2502-2510 runProgrammaticStep invocation where base2 handleSteps executes, but base2/base2.ts:816 handleSteps is serialized via .toString() + new Function() (comments at 21-24, 1051, 1538, 3440) and cannot close over module imports — a gate there would need the inline generated-region pattern (<gate-helpers-generated> at base2.ts:20-24; generated inline helpers at 9588, 10776-10813). Runtime-side gate needs no splicing and is unit-testable (existing filter tests at packages/agent-runtime/src/__tests__/run-agent-step-tools.test.ts:582-1041). The gate already has agentState access for keying by observed task state.

## [MEDIUM] correctness — packages/agent-runtime/src/util/compaction-verification.ts — Compaction archives bounded snapshots and verifies extraction coverage; gaps recoverable only via pull recall_context
- **Risk:** Facts the model omitted from the post-compaction state are detected but not re-injected — the model is merely told it may recall them, so survival is advisory, not guaranteed.
- **Fix:** Auto-push missing facts (or their verbatim tool outputs) back into the next step's memory block instead of relying on the model to call recall_context.
- **Evidence:** context-archive.ts:20-47 MAX_ARCHIVE_SNAPSHOTS/MAX_ARCHIVE_MESSAGES/MAX_ARCHIVE_MESSAGE_CHARS bound the archive (8 snapshots x 200 messages x 4k chars per archive-recall-index.ts:11-13); archivePreCompaction appends a snapshot with a dedicated cap before each compaction; archiveEvictedToolResults handles EVICTION_ARCHIVE_REASON evictions. compaction-verification.ts:49-77 deriveExpectedFacts derives ground truth from pre-compaction tool-call INPUTS (read_files/write_file paths via looksLikeProjectPath, run_terminal_command commands truncated to 80 chars), capped MAX_VERIFICATION_FACTS=200 (18); verifyExtractionCoverage checks each against post-compaction history text AND task memory via memoryCites (79+) which only consults filesInspected/editsMade (80). Missing facts surface in the compaction event's recovery guidance (run-agent-step.ts:2778-2781) pointing at recall_context or a re-read.

## [MEDIUM] test-coverage — packages/agent-runtime/src/util/context-consolidation-runner.ts — Background consolidation is canary-gated OFF by default; its product is reachable only through pull-based recall
- **Risk:** The summarization leg of the memory pipeline produces nothing in default runs, and even when enabled its summaries sit in agentState.contextConsolidations until the model chooses to recall — read-light by construction.
- **Fix:** Default-on consolidation behind a budget, plus push-injection of matching consolidations at decision points.
- **Evidence:** context-consolidation-runner.ts:83 gate `if (agentTemplate.programmaticConfig?.backgroundSnapshotConsolidation !== true) return` — OFF unless the template opts in; 20 in-process WeakSet guard; 85-89 selectUnconsolidatedSnapshots over compactionArchive vs contextConsolidations; 94 fire-and-forget by design (caller does not await); 100-119 synthetic prompt-only CONSOLIDATOR_AGENT_ID child with toolNames [] and no transcript write-back. context-consolidation.ts: MAX_CONSOLIDATIONS / MAX_CONSOLIDATION_CHARS / MAX_SNAPSHOTS_PER_RUN bound the store; recordConsolidation appends; searchConsolidations is only called from recall-context.ts:29-42.

## [LOW] correctness — packages/agent-runtime/src/util/archive-recall-index.ts — Archive recall index: per-call in-memory FTS5, newest-first ordering, fail-open to scanner
- **Risk:** BM25 relevance is computed but deliberately unused (recency-first contract), so relevant older facts can be pushed out of the 6-result window by newer irrelevant ones.
- **Fix:** Expose bm25 ordering as an option when a consumer needs relevance-first recall.
- **Evidence:** archive-recall-index.ts:31-37 ordering contract ORDER BY row_index DESC (recency-first, matching recallFromArchive); 35-37 BM25 available via fts5 rank/bm25() but kept unused as documented follow-up; 18-23 fail-open semantics — any bun:sqlite/FTS5/sanitization/cap failure falls back to the byte-identical recallFromArchive substring scanner; 25-29 indexState 'indexed' vs 'fallback' distinguishes empty-match from failure, indexError bounded to 300 chars. Archive bounded 8 snapshots x 200 messages x 4k chars (11-13); sanitizer shared with cli durable context_archive_fts store (49-55).

## [MEDIUM] test-coverage — evals/compaction-retention/README.md — evals/compaction-retention covers within-run survival of pinned knowledge_memory facts; cross-session persistence is deferred to evals/memory-retention
- **Risk:** The eval proves facts survive compaction WITHIN a run (pinned block sections) but explicitly does not test whether facts change behavior across sessions — the exact owner concern is unmeasured by this suite.
- **Fix:** Extend the eval matrix (or the sibling evals/memory-retention) with a cross-session scenario asserting the recalled decision gates behavior, not just presence.
- **Evidence:** evals/compaction-retention/README.md:1-18 deterministic no-LLM eval driving agents/context-pruner.ts handleSteps directly, measuring the pinned <knowledge_memory> block sections (Goal/Decisions/Files Inspected/Edits Made/Validation Results/Review Receipts/Post-Edit Anchors/Blockers/Next Action), per-field caps baselined at 100k target scaled clamp(targetTokens/100000, 0.5, 3.0), whole block bounded max(1500, floor(target*0.25)) estimated tokens with oldest-first eviction, Goal/Next Action truncate toward floors rather than drop. Scenarios S1-S5 (24-28) + multi-pass drift sweep S10/S11 (30-35) asserting open blocker and review receipt fingerprint survive every pass. Metrics recallRate/blockTokens/retainedEntryCounts/compressionRatio (43-48). 67-68: 'Cross-session persistence of the same facts — covered by the sibling evals/memory-retention/ eval and the runtime task-memory suite'; 69-70: model-quality (does the model act on retained evidence) intentionally excluded as needing LLM-in-the-loop.

## [LOW] api-contract — packages/agent-runtime/src/tools/handlers/tool/write-todos.ts — write_todos and update_plan_status are session-scoped state trackers, not durable memory read-back channels
- **Risk:** Todos and plan-task receipts are often treated as 'memory' in the overhaul discussion, but neither crosses sessions nor gates agent behavior through memory — conflating them with memory would misdirect the redesign.
- **Fix:** Keep them as task-state channels; route durable conclusions extracted from them through record_decision into a durable store instead.
- **Evidence:** write-todos.ts: MAX_RETURNED_TODOS=20; handleWriteTodos persists a historical summary (persistedHistoricalSummary with completedCount/remainingCount/historicalTodoCount, masterTodosOmittedForLength:true) — only aggregate counts persist, not the tasks themselves, and read-back is the tool's own return value. update-plan-status.ts:120-154 gate-issued receipt verification via base2ActiveWork.planTaskGateReceipts (fail-closed on malformed ledger) — receipts gate plan-task COMPLETION within the run but are not memory and are not read across sessions.

## Coverage receipt

### Subsystems
- agent-runtime

### Features
- task-memory
- memory-v2-context
- recall-context
- record-decision
- write-todos
- update-plan-status
- context-archive
- archive-recall-index
- context-consolidation
- context-consolidation-runner
- context-pruning
- compaction-verification
- spawn-agents-gate
- compaction-retention-eval

### Files
- packages/agent-runtime/src/util/task-memory.ts
- packages/agent-runtime/src/util/memory-v2-context.ts
- packages/agent-runtime/src/util/context-archive.ts
- packages/agent-runtime/src/util/archive-recall-index.ts
- packages/agent-runtime/src/util/context-consolidation.ts
- packages/agent-runtime/src/util/context-consolidation-runner.ts
- packages/agent-runtime/src/util/context-pruning.ts
- packages/agent-runtime/src/util/compaction-verification.ts
- packages/agent-runtime/src/run-agent-step.ts
- packages/agent-runtime/src/tools/tool-executor.ts
- packages/agent-runtime/src/tools/handlers/tool/recall-context.ts
- packages/agent-runtime/src/tools/handlers/tool/record-decision.ts
- packages/agent-runtime/src/tools/handlers/tool/write-todos.ts
- packages/agent-runtime/src/tools/handlers/tool/update-plan-status.ts
- common/src/tools/params/tool/recall-context.ts
- sdk/src/services/memory-v2/coordinator.ts
- agents/base2/base2.ts
- evals/compaction-retention/README.md

### Domains
- correctness
- state-mutation
- performance
- test-coverage
- api-contract
