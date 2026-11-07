# Audit findings: r3-agent-loop

- Subsystems: agent-runtime:agent-loop, agent-runtime:run-journal, agent-runtime:replay-driver, agent-runtime:context-archive-recall, agent-runtime:token-counter, agent-runtime:context-budget-ledger, agent-runtime:tool-stream-parser, agents:context-pruner, agent-runtime:orchestration-workflow-engine, agent-runtime:orchestration-discovery-coordinator
- Features: P2-T2-run-journal-replay, D26-eviction-archive, D27-fts5-recall-index, M3-T2-token-estimator-fudge, semantic-compaction-governor, P2-3-midturn-checkpoint, SPEC-P6-T5-rust-daemon, SPEC-P6-T6-tantivy, SPEC-P9-T4-quickjs
- Files covered: 14
- Snapshot: d2df71d608d67a3324faf6271f018ab600c00fab18ad1a67b7964172d6289935

## [HIGH] correctness — packages/agent-runtime/src/util/run-journal.ts:343 — Journal replay keys tool inputs by a 32-bit FNV-1a hash — a collision replays the wrong tool result
- **Risk:** toolResultForInput keys (toolName, input) pairs on stableHash, which common/src/util/stable-hash.ts pins as 32-bit FNV-1a (8 hex chars). At ~2^32 space, a few tens of thousands of distinct journaled tool inputs make birthday collisions likely across a long-lived per-project journal; the lookup then compares hash equality only (it never re-compares the canonicalized inputs), so a colliding pair replays the WRONG tool_result for a re-executed side-effecting call after a kill-9 resume — e.g. feeding one str_replace/write_file result to a different edit. The docstring claims 'collision-bounded', but 32 bits is not a safe bound for a durability cross-check whose whole purpose is preventing double execution or wrong-result substitution.
- **Fix:** Key the lookup on the canonicalized input string itself (it is already deterministic and bounded by retention) or at minimum re-compare canonicalizeJournalJson(payload.input) === canonicalizeJournalJson(input) after the hash prefilter, and upgrade the hash to sha256 if a compact key is required.
- **Evidence:** journalToolInputKey returns stableHash(toolName + NUL + canonicalizeJournalJson(input)); stable-hash.ts is FNV-1a 32-bit padded to 8 hex. toolResultForInput compares journalToolInputKey(toolName, payload.input) !== wantedKey and returns JSON.parse(resultRow.payload) on hash match only.

## [HIGH] correctness — packages/agent-runtime/src/run-agent-step.ts:1655 — Journal replay is classify-and-log: built-in resume path never re-drives children or respawns background jobs
- **Risk:** The P2-T2b gap is confirmed and is broader than the driver docblock admits. Inside loopAgentSteps, the replay seams passed to executeReplayActions are explicitly logging-only (replayChild/respawnBackground each just logger.debug), so the built-in resume path classifies interrupted children and background intents but re-drives nothing; actual recovery depends entirely on a caller-injected params.resumeDriver (sdk/src/services/run-resume-driver.ts). run-replay-driver.ts itself documents that resume-from-own-journal for background agents is deferred and that no in-repo production re-launch path exists outside tests, so an interrupted background job whose intent is 'interrupted' and non-rerunnable only ever needs_confirmation with no confirmer wired in the runtime.
- **Fix:** Either wire production seams that re-drive children from their own journals (consuming toolResultFor/toolResultForInput) and journal the respawnOf marker at the actual re-launch site, or surface the gap in the resume report (a 'deferred' verdict on RunResumeReport) so callers do not treat a log-only replay as recovery.
- **Evidence:** run-replay-driver.ts docblock: 'resume-from-own-journal for background agents stays deferred ... the reDriveChild/respawnBackground seams still do not replay a background child from its own journal'. run-agent-step.ts replayChild seam body is a single logger.debug call; spawn-agent-utils.ts:160 forwards journalWriter into children but nothing consumes the child journal to restore its final output.

## [MEDIUM] correctness — packages/agent-runtime/src/run-agent-step.ts:2155 — Routed model is never threaded into the hot-path token estimator: per-family fudge factors are unreachable and Anthropic 1.35 is applied universally
- **Risk:** The M3-T2 per-family fudge factors (Anthropic 1.35, OpenAI 1.0, Gemini 1.1) are dead on every runtime accounting path: runAgentStep counts the system prompt with countTokensJson(system) with no model, IncrementalTokenCounter.messageTokens calls countTokensJson without a model, and context-budget.applyMeasure prices ledger blocks the same way. countTokens resolves the undefined-model sentinel ANTHROPIC_TOKEN_FUDGE_FACTOR_MARKED_MODEL ('anthropic/claude'), so every transcript is priced at the 1.35 Anthropic factor regardless of the routed model. For OpenAI-routed agents the raw gpt-4o BPE count is already correct, so context is overstated ~35% and semantic compaction/eviction triggers fire about a third early (extra paid pruner passes, aggressive trims); for Gemini it is ~25% early. The estimator fix the audit trail records was wired only into the optional exact-counting path, not the default path.
- **Fix:** Thread the routed model (agentTemplate.model or agentState.contextWindowTokens resolver output) through IncrementalTokenCounter, countTokensJson call sites in run-agent-step.ts, and context-budget measureBlock so fudgeFactorForModel actually selects the family factor; exact-tokenizer providers already exist behind the OPENBUFF_EXACT_TOKENS seam and would also start working on the hot path.
- **Evidence:** token-counter.ts: `const ANTHROPIC_TOKEN_FUDGE_FACTOR_MARKED_MODEL = 'anthropic/claude'` and `countTokens(text, model)` falls back to it when model is undefined. run-agent-step.ts:2155 `new IncrementalTokenCounter()` whose messageTokens calls countTokensJson(message) with no model. context-budget.ts applyMeasure does the same for the persisted /context ledger.

## [MEDIUM] correctness — packages/agent-runtime/src/util/archive-recall-index.ts:105 — FTS5 recall path diverges from the substring scanner it claims to be byte-identical to
- **Risk:** The module contract says indexed results are byte-identical to the recallFromArchive scanner (fallback keeps 'matching behavior ... identical to the scanner'). But the scanner matches the literal lowercased substring (lowered.includes(term)) while the FTS path quotes each sanitized word as an adjacency phrase: unicode61 splits 'foo-bar' into tokens foo and bar, and a quoted phrase matches any adjacent tokens regardless of the separating character, so 'foo bar' or 'foo/bar' in archived text matches a 'foo-bar' query on the indexed path but not on the scanner path. A recall_context result can therefore differ (extra or missing matches) depending on whether bun:sqlite FTS5 was available — non-deterministic behavior across hosts for the same archive and query.
- **Fix:** After the FTS MATCH, filter rows with the scanner's own predicate (every raw lowercased term must appear in row.text.toLowerCase()) before mapping to matches, so the indexed result set is a subset identical to the scanner's; or document the adjacency-vs-substring divergence in the contract instead of claiming byte-identity.
- **Evidence:** sanitizeFtsQuery keeps hyphens inside quoted terms; the MATCH is run with no post-filter; the docblock claims 'snippets stay byte-identical between the indexed and fallback paths' via the shared toText, which covers serialization but not term matching.

## [MEDIUM] state-mutation — packages/agent-runtime/src/util/context-archive.ts:34 — Compaction archive worst-case memory bound is ~200M characters per agent state with no aggregate byte cap
- **Risk:** Eviction snapshots carry original pre-tombstone bodies up to EVICTION_ARCHIVE_MESSAGE_CHARS=64_000 each, and the dedicated cap allows MAX_EVICTION_ARCHIVE_SNAPSHOTS=16 snapshots of up to MAX_ARCHIVE_MESSAGES=200 messages. Worst case is 16 x 200 x 64k = ~204.8M characters of retained per-run state held on agentState.compactionArchive (as UTF-16 JS strings roughly 400 MB), never evicted by the compaction machinery it exists to serve, and duplicated into the per-call FTS index rows on every recall_context. Long-running loops with heavy eviction can grow this silently; nothing bounds total archive bytes, only per-kind snapshot counts.
- **Fix:** Add an aggregate byte/char budget across the whole archive (sum of archived text chars, enforced oldest-first across kinds), or lower EVICTION_ARCHIVE_MESSAGE_CHARS / snapshot counts so the worst case is O(tens of MB), and document the bound next to the caps.
- **Evidence:** MAX_ARCHIVE_SNAPSHOTS=8, MAX_EVICTION_ARCHIVE_SNAPSHOTS=16, MAX_ARCHIVE_MESSAGE_CHARS=4_000, EVICTION_ARCHIVE_MESSAGE_CHARS=64_000, MAX_ARCHIVE_MESSAGES=200; appendSnapshotWithDedicatedCap enforces only per-kind counts, with no aggregate byte budget.

## [MEDIUM] error-handling — packages/agent-runtime/src/tool-stream-parser.ts:226 — XML tool-call execution is awaited inline in the stream with no error boundary — one throwing call kills the entire stream
- **Risk:** XML-path tool calls parsed from text are executed inline inside the stream generator: processChunk awaits executeXmlToolCall per toolCall with no local guard. If the injected callback throws (executor rejection, abort, handler bug), the throw propagates out of processStreamWithTools and tears down the remaining stream — losing all not-yet-emitted text and any subsequent tool calls — whereas the provider-native tool-call path lets the executor decide per-call outcomes and keeps the stream alive. One malformed or failing XML tool call thus converts a partial success into a whole-step failure.
- **Fix:** Wrap each executeXmlToolCall in a bounded try/catch that emits an error print-mode chunk (or a failed tool_result envelope) and continues the stream, matching the executor's own per-call error surfacing on the native path.
- **Evidence:** processChunk 'text' branch: `for (const toolCall of toolCalls) { ... await executeXmlToolCall({...}) }` with no try/catch and no error chunk emission, unlike processToolCallObject which deliberately avoids double-reporting and lets the executor decide the outcome.

## [MEDIUM] correctness — agents/context-pruner.ts:100 — Pruner and runtime disagree on the token estimator: chars/3 over text parts only vs BPE+fudge over full serialization
- **Risk:** The pruner decides whether to compact and how to split its summary budgets using Math.ceil(text.length / 3) over getTextContent(message) only — for tool messages (role 'tool', array content of json parts) getTextContent returns the empty string, so tool-result bodies contribute 0 to its estimate, and the chars/3 density disagrees with the runtime's BPE-plus-fudge count over the full serialized message (which is what agentState.contextTokenCount carries). The Math.max(agentState.contextTokenCount, estimate) merge hides the underestimate while the runtime count exists, but the summary-budget arithmetic (user/assistant/toolFacts budgets in tokens vs chars/3-measured entries) still prices the retained summary with a different estimator than the one that measured the overflow, so post-prune size can miss the target by a model-dependent factor.
- **Fix:** Treat agentState.contextTokenCount as the only trigger input (drop the chars/3 estimate or gate it behind an absent runtime count), and have the budget-split math consume a tokens figure derived from the same estimator the runtime uses.
- **Evidence:** context-pruner.ts: `const estimatedContextTokens = Math.ceil(currentMessages.reduce((total, message) => total + getTextContent(message).length, 0) / CHARS_PER_TOKEN)` — getTextContent joins only part.type==='text' parts. Runtime path: incrementalTokenCounter.messagesTokens -> countTokensJson(message) over the full serialized message.

## [LOW] correctness — packages/agent-runtime/src/util/run-journal.ts:1146 — classifyRunResume's tail-window completion scan is provably dead code — lastEvent is already the max-seq row
- **Risk:** classifyRunResume computes last = lastEvent(runId) (ORDER BY seq DESC LIMIT 1, the max-seq row) and then scans a bounded tail window for an event with e.seq > last.seq. Since last is by definition the newest event, no event with a larger seq can exist, so the some() predicate is always false and a tool_call/llm_request tail always classifies in-flight regardless of correlation. The elaborate 'correlation reuse guard' comment describes protection that structurally cannot fire (an earlier attempt's result can never be appended after the newest event), and the RESUME_TAIL_EVENT_LIMIT window is wasted work on a dead predicate. The resulting classification is still correct, but the code implies a guarantee it does not implement, which invites future edits to rely on the scan.
- **Fix:** Delete the tailWindow completion scan and classify directly on the tail event type plus correlation presence; or keep it and add a comment stating it is a defensive no-op so future readers do not trust it as a real completion check.
- **Evidence:** `const hasResult = correlation != null && tailWindow.some((e) => e.seq > last.seq && ...)` where tailWindow's first element IS last (ORDER BY seq DESC LIMIT).

## [LOW] correctness — packages/agent-runtime/src/tool-stream-parser.old.ts:1 — Dead superseded parser file left in src
- **Risk:** The superseded tool-stream-parser.old.ts (summarizeToolInput/extractToolCalls/processToolCallContents/extractToolsFromBufferAndProcess) still ships in src with no importers, so future edits can land in the wrong file or the dead heuristic code can be resurrected by a fuzzy match.
- **Fix:** Delete packages/agent-runtime/src/tool-stream-parser.old.ts (history preserves it) or move it under a clearly named fixtures/archive directory if the old extraction heuristics are still consulted.
- **Evidence:** glob shows both tool-stream-parser.ts and tool-stream-parser.old.ts; references list shows no importer of the .old file outside the repo's own audit trail.

## [LOW] correctness — packages/agent-runtime/src/util/context-archive.ts:329 — recallFromArchive early-exit returns archivedAt for all snapshots while claiming only some were searched
- **Risk:** When the RECALL_MAX_RESULTS cap is hit mid-archive, recallFromArchive returns matches and snapshotsSearched reflecting only the visited (newest) snapshots, but the archivedAt array lists every snapshot in the archive reversed. A consumer using archivedAt to describe where matches came from (per the docstring 'the same order matches return in') sees timestamps of snapshots that were never searched, overstating provenance coverage for the result set.
- **Fix:** Return archivedAt only for the snapshots actually searched (the first snapshotsSearched entries of the reversed list), keeping the 'newest first' contract.
- **Evidence:** recognition early exit: `return { matches, snapshotsSearched, archivedAt: [...archive].reverse().map((s) => s.archivedAt) }` inside the message loop, versus the full-scan return at the end.

## [LOW] error-handling — packages/agent-runtime/src/run-agent-step.ts:1675 — Replay telemetry counts logging-only seams as attempted and succeeded
- **Risk:** The loop passes logging-only replayChild/respawnBackground seams into executeReplayActions, which increments attempted and succeeded for each. The resulting log line ('plannedActions/attempted/succeeded/failed') reports replay actions as successfully executed even though the seams only wrote debug logs, so operators and future dash consumers reading this telemetry cannot distinguish a real replay from a no-op classification pass — masking exactly the P2-T2b completeness gap.
- **Fix:** Either omit the attempted/succeeded logging when the seams are known logging-only, or mark the report/plan with an executed:false field so downstream consumers and the dash do not read the counters as real replay progress.
- **Evidence:** loopAgentSteps: `const replayResult = await executeReplayActions(replayPlan.actions, { logger, replayChild: async (...) => { logger.debug(..., 'Journal replay: child disposition planned (logging-only seam)') }, ... })` followed by logging of attempted/succeeded.

## [LOW] api-contract — packages/agent-runtime/src/util/archive-recall-index.ts:1 — SPEC P6-T6 tantivy migration is the wrong tool for the archive-recall corpus; FTS5 over the bounded in-memory archive is correct
- **Risk:** SPEC plans a Rust tantivy index service (P6-T6). This shard's archive-recall index is a per-call in-memory FTS5 virtual table over at most ~4800 rows (~6.4 MB, 8x200x4k semantic + 16x200x64k eviction snapshots), rebuilt per call precisely to avoid stale-index drift, with BM25 available but deliberately unused (recency-first ordering matches the scanner). Moving this corpus to tantivy would add a daemon round-trip and persistence for an ephemeral, bounded, per-run structure — the wrong language/tool for this part, even though tantivy is right for the repo-wide search index.
- **Fix:** Scope P6-T6's tantivy adoption to the repository search/index service and record archive recall as staying on bun:sqlite FTS5; optionally expose bm25 ordering behind the existing indexState contract when a consumer needs relevance ranking.
- **Evidence:** archive-recall-index.ts builds 'CREATE VIRTUAL TABLE recall USING fts5(...)' per call over rows from buildArchiveRecallRows (bounded by the archive caps) with ORDER BY row_index DESC and unused bm25(); SPEC P6-T6 assigns tantivy to the index service; nothing in the archive-recall path requires cross-process or persistent indexing.

## [LOW] api-contract — packages/agent-runtime/src/util/run-replay-driver.ts:1 — SPEC P9-T4 QuickJS heap-snapshot task text contradicts the journal-replay resume protocol this stack implements (D35)
- **Risk:** The SPEC's P9-T4 task text still specifies QuickJS heap snapshots (JS_WriteObject of suspended generator state) as the resume mechanism and the Dependencies section claims 'P2-T2 is strengthened by P9-T4 (heap snapshots)'. This shard confirms the actual resume protocol is journal replay (classifyRunResume/planReplayActions/executeReplayActions plus the respawnOf marker convention), which D35 adopts; heap snapshots would duplicate and conflict with that protocol, and the respawn-marker parity note shows the protocol already has an unresolved wiring gap that P9-T4's snapshot story would not fix.
- **Fix:** Rewrite the P9-T4 task text to the D35 contract (bundled trusted host modules + P2-T2 replay for resume; QuickJS only for untrusted agents) and add an explicit P2-T2b backlog item for the production re-drive/respawn wiring, since the journal's replay protocol is the mechanism P9-T4 currently claims to strengthen.
- **Evidence:** run-replay-driver.ts: 'The driver never re-runs reconcileInterruptedBackgroundAgentIntents' and 'the CALLER that re-launches journals the parent spawn marker itself'; planBackgroundAgentResume depends on payload.respawnOf markers whose only documented writers are tests; run-journal.ts design comments cite P9-T4 heap snapshots as a strengthening dependency, which D35 replaces.

## [LOW] correctness — packages/agent-runtime/src/util/context-budget.ts:1 — Context budget ledger window and measured lines use incompatible token scales
- **Risk:** createBudgetLedger sets windowTokens from getEffectiveContextLimits(...).statusWindowTokens (an exact provider-safe figure), while every line recorded via measureBlock/applyMeasure is priced by countTokensJson with no model, i.e. the 1.35 Anthropic factor regardless of the routed model. The ledger therefore reports utilization (totalTokens/windowTokens) mixing two incompatible scales: an OpenAI-run's true utilization is overstated ~35%, and /context output plus compaction telemetry derived from the ledger disagree with the incremental counter only by luck (both use the same wrong factor today, but the ledger is compared against an unfactored window).
- **Fix:** Price ledger lines with the routed model's factor (or provider usage deltas where available) and state the estimator next to windowTokens so the ledger's implied utilization fraction is consistent with the pruning trigger's.
- **Evidence:** createBudgetLedger({ windowTokens: getEffectiveContextLimits(initialAgentState.contextWindowTokens, maxContextLength).statusWindowTokens }) pairs an exact window constant with a 1.35-factored measure path; runAgentStep's own budget check uses stepCacheTotalInputTokens (provider usage) while pruning uses the factored estimate — the two budgets are never reconciled.

## Coverage receipt

### Subsystems
- agent-runtime:agent-loop
- agent-runtime:run-journal
- agent-runtime:replay-driver
- agent-runtime:context-archive-recall
- agent-runtime:token-counter
- agent-runtime:context-budget-ledger
- agent-runtime:tool-stream-parser
- agents:context-pruner
- agent-runtime:orchestration-workflow-engine
- agent-runtime:orchestration-discovery-coordinator

### Features
- P2-T2-run-journal-replay
- D26-eviction-archive
- D27-fts5-recall-index
- M3-T2-token-estimator-fudge
- semantic-compaction-governor
- P2-3-midturn-checkpoint
- SPEC-P6-T5-rust-daemon
- SPEC-P6-T6-tantivy
- SPEC-P9-T4-quickjs

### Files
- packages/agent-runtime/src/run-agent-step.ts
- packages/agent-runtime/src/run-programmatic-step.ts
- packages/agent-runtime/src/tools/tool-executor.ts
- packages/agent-runtime/src/tool-stream-parser.ts
- packages/agent-runtime/src/tool-stream-parser.old.ts
- packages/agent-runtime/src/util/run-journal.ts
- packages/agent-runtime/src/util/run-replay-driver.ts
- packages/agent-runtime/src/util/context-archive.ts
- packages/agent-runtime/src/util/archive-recall-index.ts
- packages/agent-runtime/src/util/token-counter.ts
- packages/agent-runtime/src/util/context-budget.ts
- packages/agent-runtime/src/orchestration/workflow-engine.ts
- packages/agent-runtime/src/orchestration/discovery-coordinator.ts
- agents/context-pruner.ts

### Domains
- correctness
- error-handling
- state-mutation
- performance
- api-contract
