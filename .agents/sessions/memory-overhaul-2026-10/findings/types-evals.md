# Audit findings: types-evals

- Subsystems: common, evals, cli, sdk, agent-runtime
- Features: memory-v2-event-sourced-schema, task-memory-v1-legacy-schema, context-archive-snapshot, context-consolidation-summary, discovery-coverage, usefulness-scoring, compaction-eligibility-gc, contradiction-detection, memory-artifact-policy, decision-rationale-gate, context-budget-ledger, compaction-retention-eval, memory-retention-eval, compaction-fidelity-eval, buffbench-deterministic-signals
- Files covered: 24
- Snapshot: 1d150eb58b494899bfe81792df3501634ce3d1a2b67c2c1ed52dff0532b75ec2

## [HIGH] api-contract — common/src/types — Memory type surface is split across three generations (V1 task-memory, V2 event-sourced, session context-archive/consolidation) with budgets scattered and no unifying record-kind registry
- **Risk:** No unifying record-kind registry: task-memory V1 (deprecated but still load-bearing in compaction-fidelity + memory-retention evals and record_decision via TASK_MEMORY_LIST_CAPS) and memory-v2 coexist; budgets are scattered (char caps here, array caps there, retrieval MAX_ITEMS=100, currentCoverage max 5), making it impossible to reason about total memory cost per turn or to add a new record kind in one place.
- **Fix:** For the overhaul: collapse the three generations behind one record-kind registry with per-kind explicit budgets (the V2 file already has the right budget primitives), add an enforcement-seam playbook kind (see TE-6), and bound discovery-coverage arrays.
- **Evidence:** common/src/types/memory-v2.ts:228-250 (MemoryObservationSchema kinds: fact|decision|constraint|discovery|warning|outcome); memory-v2.ts:3-6 (MAX_ID_LENGTH=128, MAX_PATH_LENGTH=1024, MAX_TEXT_LENGTH=16384, MAX_ITEMS=100); memory-v2.ts:93-94 (shortText max 1024, longText max 16384); memory-v2.ts:243-246 (evidence max 32, selectors max 32, tags max 32 per observation); memory-v2.ts:987-1001 (retrieval result arrays capped at MAX_ITEMS=100; currentCoverage max 5; rankingReasons max 500); common/src/types/task-memory.ts:13-23 (TASK_MEMORY_LIST_CAPS: requirements 64, decisions 64, filesInspected 128, editsMade 128, validationResults 64, reviewReceipts 64, blockers 64, nextActions 32, evidence 256); task-memory.ts:59-103 (goal 8000 chars, list items 1500-4000 chars, historicalSummary 24000 chars, evidence summary 2000 chars); common/src/types/context-archive.ts:19-26 (persisted-size contract: 8 snapshots x 200 messages x 4k chars/message); common/src/types/context-consolidation.ts:14-19 (bounded LLM summary, no numeric cap in type); common/src/types/discovery-coverage.ts:3-34 (candidates/shards/coveredDomains/unresolvedGaps arrays unbounded); memory-v2.ts:1399-1459 (consolidation candidates max 5, planned events max 100)

## [HIGH] correctness — common/src/util/usefulness-scorer.ts — usefulness-scorer gates only GC and retrieval rank order — it never gates what the agent sees or does; two of its six signal inputs have no producers; common and cli copies are NOT duplicated (cli is a 1-line re-export)
- **Risk:** scoreUsefulness output gates only storage-side decisions (GC eligibility in compaction-eligibility.ts and retrieval rank ORDER). Nothing consults the score at injection or decision time: compileMemoryV2Context (packages/agent-runtime/src/util/memory-v2-context.ts:95) and the run-agent-step memory attach path (run-agent-step.ts:2216-2247) do not read it, so a low-usefulness observation enters context exactly like a high-value one. Half the signal inputs are dead: staled has no producer at all; reinforced has exactly one producer (claim.reinforced fold). The score therefore cannot be evidence that memory changes behavior.
- **Fix:** Behavior overhaul seam: give the usefulness score an injection-time consumer (per-observation include/exclude and citation policy in compileMemoryV2Context / retrieval render), or delete the dead staled dimension and demote the scorer to pure GC ordering if injection-time gating is not wanted.
- **Evidence:** common/src/util/usefulness-scorer.ts:76-85 (weights used=4, reinforced=6, pinned=8, ignored=-3, staled=-5, age=-2; clamp [0,1000]; explicit tier age floor 12); usefulness-scorer.ts:56-73 (scoreUsefulness signature, 8 inputs); usefulness-scorer.ts:18-27 (deriveUsefulnessTier: record_decision tool + decision/constraint kind => 'explicit'; kind 'outcome' => 'outcome'; else 'derived'); usefulness-scorer.ts:62-63 doc: 'staled/reinforced are reserved for future producers (no producers exist in P5)' — staled still has NO producer anywhere (hardcoded staled:0 at cli/src/services/memory-v2/bun-sqlite-memory-repository.ts:4717 and compaction-eligibility.ts:83); common/src/util/compaction-eligibility.ts:4,78 (imports + calls scoreUsefulness for GC eligibility); compaction-eligibility.ts:127-152 (compactionEligibility: explicit tier never evicted; lowScore branch requires score<=0 AND used==0 AND reinforced==0 AND age>30d AND ignored>=3); cli/src/services/memory-v2/bun-sqlite-memory-repository.ts:4708-4723 (retrieval ranking feeds usefulness score into RankingReason/score); cli/src/services/memory-v2/usefulness-scorer.ts:1 is 'export * from \'../../../../common/src/util/usefulness-scorer\'' — a 1-line re-export barrel, NOT a duplicated copy (glob confirms exactly 2 files, one is a barrel)

## [MEDIUM] correctness — common/src/util/contradiction-detector.ts — contradiction-detector detects topic co-occurrence, not semantic contradiction; its only production consumer appends an advisory 'contradiction-suspected' reread marker — no gating, no auto-resolution, no agent-visible forcing function
- **Risk:** Detection is purely structural: two live decision/constraint observations sharing a stableChunkId topic key are flagged, regardless of whether their claims actually conflict. The sole consumer (bun-sqlite-memory-repository.ts:4870-4892) converts flags into rereadRequired entries with score 0; there is no blocking, no automatic supersession, and no requirement that the agent ever reconciles — the marker lands in context as advisory text only.
- **Fix:** Either upgrade the detector to surface both claims verbatim side-by-side with the supersede action wired into the same turn (behavior-changing), or document it honestly as duplicate-topic flagging only.
- **Evidence:** common/src/util/contradiction-detector.ts:18-26 (ContradictionCandidate shape + caps MAX_OBSERVATIONS_PER_TOPIC=4, MAX_TOPICS=16); contradiction-detector.ts:96-108 (STABLE_CHUNK_ID_METADATA_KEY='stableChunkId' metadata contract + STABLE_CHUNK_ID_RE); contradiction-detector.ts:120-146 (detectContradictions: group live decision/constraint observations by topic key; >=2 members => candidate); contradiction-detector.ts:149-155 (resolveSupersessionHead walks supersededBy edges, cycle-safe); cli/src/services/memory-v2/bun-sqlite-memory-repository.ts:71-75 (sole production import of detectContradictions/extractStableChunkIds/resolveSupersessionHead); bun-sqlite-memory-repository.ts:4870-4892 (flagged ids become rereadCandidates with reason 'contradiction-suspected', detail 'reconcile — resolve via record_decision(supersedes:[...])'); common/src/types/memory-v2.ts:892-908 (RereadRequiredSchema.reason enum includes 'contradiction-suspected'); memory-v2.ts:1003-1020 (SPEC S4 exception: verified + contradiction-suspected may coexist in MemoryRetrievalResult with a reconcile marker)

## [MEDIUM] security — common/src/util/memory-artifact-policy.ts — memory-artifact-policy governs only agent-recorded EVIDENCE paths; .agents/sessions readability is a separate allowlist (sensitive-paths.ts), .openbuff/memory is runtime-owned (policy actually DENIES it), and knowledge.md is not governed by this policy at all
- **Risk:** The policy's authority is narrower than its name suggests: it decides which paths may serve as memory EVIDENCE (enforced at record_decision.ts:92-95 and sdk coordinator.ts:271-275,1515-1548). Three other regimes live elsewhere: .agents/sessions readability (sensitive-paths.ts:173-193, an allowlist not a persistence policy), .openbuff/memory (runtime-owned, agent writes go through saveMergedTaskMemory, not through this policy — and the policy would DENY .openbuff paths as 'private-memory' anyway), and knowledge.md (drift-guard, unrelated). No single place answers 'what files are allowed where' for memory.
- **Fix:** In the overhaul, state the three policies in one place: artifact policy (what paths may become evidence), session-artifact allowlist (what audit artifacts stay readable), and the runtime store path — and decide whether .agents/sessions findings should also be injectable memory or remain eval-only artifacts.
- **Evidence:** common/src/util/memory-artifact-policy.ts:212-215 (segments[0]==='.openbuff' => allowed:false, kind 'data', generated 'ephemeral', reason 'private-memory'); memory-artifact-policy.ts:216-243 (denied: dependency, cache, build-output, temporary, log, sensitive, binary); memory-artifact-policy.ts:246-254 (generated patterns require hasGeneratedProvenance: generator+toolVersion<=128 chars, config path, 1..100 normalized sourceInputs); memory-artifact-policy.ts:255-311 (allowed: test, documentation (docs/ + md/mdx/rst/txt + readme/changelog), configuration (package.json/tsconfig/etc + dotfiles), data (csv/jsonl/ndjson/parquet/xml), source, other); packages/agent-runtime/src/tools/handlers/tool/record-decision.ts:1,92-95 (record_decision rejects evidence paths the policy denies); sdk/src/services/memory-v2/coordinator.ts:5,271-275,1515-1548 (coordinator normalizes/filters evidence and chunk paths through classifyMemoryArtifactPath); common/src/util/sensitive-paths.ts:168-193 (isAgentSessionArtifactPath: read-allowlist for .agents/sessions/<slug> root (segments<=3), known AGENT_SESSION_ARTIFACT_BASENAMES at depth 4, and findings/<*.md> — audit findings like this shard persist there and stay readable even when .agents/ is gitignored); evals/memory-retention/README.md:7 ('saveMergedTaskMemory persists merged memory under <root>/.openbuff/memory/task-memory.json' — runtime-owned store path written by SDK store code, outside the artifact policy); knowledge.md files: governed by scripts/memory-drift-guard.ts:419-558 staleness check (knowledge.md last commit older than sibling src/), NOT by memory-artifact-policy

## [HIGH] test-coverage — evals — No eval measures BEHAVIOR CHANGE: compaction-retention, memory-retention, compaction-fidelity all measure text retention/recall of seeded facts, and buffbench deterministic signals measure task outcome (compile/test/lint) — memory's effect on agent decisions is explicitly out of scope everywhere
- **Risk:** Zero evals measure behavior change. compaction-retention measures text survival in the pinned block; memory-retention measures schema-validated evidence recall/trust in compiled JSON (its only quasi-behavioral metric, duplicateReadsAvoided, is a simulated read counter, not an agent decision); compaction-fidelity measures information losslessness; buffbench deterministic-signals clamp judge scores from compile/test/lint exit codes with no memory variable. The owner hypothesis 'memory does not change behavior' is currently untestable — and unfalsified — by the eval suite.
- **Fix:** Add an operational-memory eval: (a) A/B harness — run identical buffbench-style tasks with and without a known-correct memory payload and diff the decision trace (reads skipped due to verified selectors, tools chosen, blockers honored, supersede actions taken after contradiction markers); (b) extend memory-retention S6's simulated-read seam into an agent-in-the-loop read-skip counter measured against real tool calls; (c) a negative-control eval where stale/contradicted memory is injected and the correct behavior is to reread instead of trusting — scoring wrong-action-on-stale-memory, which no current eval can detect.
- **Evidence:** evals/compaction-retention/scenario.test.ts:1-29 (deterministic, no LLM: drives agents/context-pruner.ts handleSteps, measures pinned <knowledge_memory> block; S1-S11 scenarios are retention counts, ceiling enforcement, multipass survival of blocker + receipt fingerprint); evals/compaction-retention/README.md:43-52 (metrics: recallRate over seeded must-survive facts, blockTokens, retainedEntryCounts, compressionRatio — all text-presence metrics); evals/compaction-retention/README.md:69-70 (explicit: 'Model-quality questions (does the model act on retained evidence) — needs an LLM-in-the-loop eval and is intentionally excluded here'); evals/memory-retention/README.md:70-74 (explicit: 'There are no provider calls... or claims that memory improves LLM coding quality. The fixture measures evidence availability and integrity, not... model behavior'); evals/memory-retention/README.md:58-68 (S6 metrics coldReadAttempts=4, warmReadAttempts=2, duplicateReadsAvoided=2 — closest thing to a behavior metric, but reads are simulated by the fixture, not by an agent deciding to read); evals/memory-retention/README.md:84-88 (deferred: procedural recipe library, trust-scored ranking — listed as not built); evals/compaction-fidelity/scenario.test.ts:1-27 (F1-F5: eviction safety, verifier sensitivity, verbatim archive recall, aggregate fidelity=1.0, consolidation recall — all information-survival); evals/buffbench/deterministic-signals.ts:1-52 (final-check exit codes clamp the LLM judge — measures task outcomes only, never whether memory was consulted or changed a decision)

## [HIGH] api-contract — common/src/types/memory-v2.ts — GAP CONFIRMED: no schema kind for procedural playbooks (condition -> action with enforcement seam) exists anywhere in task-memory.ts or memory-v2.ts — the closest types are prose-only
- **Risk:** CONFIRMED: no schema kind represents a procedural playbook — a condition->action rule with an enforcement seam (e.g. 'before editing X, run Y; on failure do Z'). The nearest types are ReusableDiscovery (free-text reuseGuidance) and decision/constraint observations (prose summaries). A playbook cannot express: its trigger condition, its action, where it is enforced (injection-time vs pre-tool hook vs post-tool verify), or its verification status. This is why memory cannot change behavior structurally — the only behavior-shaping payloads are prose.
- **Fix:** Design a PlaybookV1 schema: { playbookId, trigger (condition: file/selector/topic), action (structured or tool-call template), enforcement: 'advisory'|'pre-tool-hook'|'post-tool-verify', evidence refs, re-verification policy }. Pair it with an operational-memory eval (TE-5) that scores whether a seeded playbook's guard fired at the condition->action seam.
- **Evidence:** code_search 'playbook|procedural|recipe' in common/src/types => 0 matches; code_search 'lesson' in common/src/types => 0 matches; common/src/types/memory-v2.ts:232-239 (MemoryObservation kind enum: fact|decision|constraint|discovery|warning|outcome — no playbook/recipe/lesson kind); memory-v2.ts:254-260 (TaskCreatedPayload: title/objective prose); memory-v2.ts:415-460 (claim.consolidated/superseded/reinforced/corrected — claim lifecycle only); memory-v2.ts:883-890 (ReusableDiscoverySchema: observation + reuseGuidance string max 4096 — free-text guidance, no condition/action structure, no enforcement hook); memory-v2.ts:964-985 (CurrentCoverageItemSchema: dimension enum requirements|implementation|tests|validation|risk — plan coverage, not procedural steps); common/src/types/task-memory.ts:29-47 (evidence kind enum: requirement|decision|read|edit|validation|review|blocker|handoff|note — no playbook kind); common/src/util/decision-rationale.ts:10-23 (DECISION_RATIONALE_MARKERS: because/since/so-that/rejected... — a prose rationale gate, not a condition->action contract); common/src/util/decision-rationale.ts:26 (DECISION_RATIONALE_MIN_LENGTH=24)

## [MEDIUM] correctness — common/src/util/compaction-eligibility.ts — compaction-eligibility constants confirm GC is the only consumer of usefulness scoring, and its thresholds (30d age, 3 ignores) make eviction nearly unreachable for explicit-tier observations — supporting the 'memory only grows, read-light' thesis
- **Risk:** Supporting evidence for the read-light hypothesis: the module with the strongest gating logic (GC) exists in full, but the read-side counterparts are either display-only (context-budget) or schema-only (parity counters with no consumer in common). Storage hygiene is mature; injection-time behavior is not.
- **Fix:** If the overhaul wants behavior change, repurpose these existing seams (ledger, parity counters) to report and enforce read-side budgets per turn rather than only storage-side ones.
- **Evidence:** common/src/util/compaction-eligibility.ts:22-25 (COMPACTION_MIN_AGE_DAYS=30, COMPACTION_IGNORE_THRESHOLD=3, COMPACTION_ORPHAN_MIN_AGE_DAYS=30); compaction-eligibility.ts:127-152 (explicit tier + pinned + used>0 + reinforced>0 all shielded from every eviction branch); compaction-eligibility.ts:100-106 (isOrphan: never retracted AND no verified evidence); compaction-eligibility.ts:255-450 (selectCompactionCandidates: closure fixpoint removes candidates a shared event could resurrect; maxEvents budget honored); cli/src/commands/memory-command.ts, sdk/src/services/memory-v2/operator-service.ts (consumers via referencedBy); common/src/types/session-state.ts outline (ContextBudgetLedger, MemoryParityCountsV2/MemoryParityStateV2/MemoryAuthorityStateV2/MemoryRuntimeStateV2 on AgentState); common/src/util/context-budget.ts:24-78 (formatLedgerForCli is the ONLY function in the module — CLI display of the ledger, consumed by cli/src/commands/context.ts)

## Coverage receipt

### Subsystems
- common
- evals
- cli
- sdk
- agent-runtime

### Features
- memory-v2-event-sourced-schema
- task-memory-v1-legacy-schema
- context-archive-snapshot
- context-consolidation-summary
- discovery-coverage
- usefulness-scoring
- compaction-eligibility-gc
- contradiction-detection
- memory-artifact-policy
- decision-rationale-gate
- context-budget-ledger
- compaction-retention-eval
- memory-retention-eval
- compaction-fidelity-eval
- buffbench-deterministic-signals

### Files
- common/src/types/memory-v2.ts
- common/src/types/task-memory.ts
- common/src/types/context-archive.ts
- common/src/types/context-consolidation.ts
- common/src/types/discovery-coverage.ts
- common/src/util/memory-artifact-policy.ts
- common/src/util/usefulness-scorer.ts
- common/src/util/contradiction-detector.ts
- common/src/util/compaction-eligibility.ts
- common/src/util/decision-rationale.ts
- common/src/util/context-budget.ts
- common/src/util/sensitive-paths.ts
- cli/src/services/memory-v2/usefulness-scorer.ts
- cli/src/services/memory-v2/bun-sqlite-memory-repository.ts
- packages/agent-runtime/src/tools/handlers/tool/record-decision.ts
- sdk/src/services/memory-v2/coordinator.ts
- packages/agent-runtime/src/util/memory-v2-context.ts
- packages/agent-runtime/src/run-agent-step.ts
- evals/compaction-retention/scenario.test.ts
- evals/compaction-retention/README.md
- evals/memory-retention/README.md
- evals/memory-retention/scenario.test.ts
- evals/compaction-fidelity/scenario.test.ts
- evals/buffbench/deterministic-signals.ts

### Domains
- api-contract
- correctness
- test-coverage
- security
- state-mutation
