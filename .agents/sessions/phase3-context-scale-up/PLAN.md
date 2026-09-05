# Phase 3: Scaled-up index + dynamic memory (search→read handoff)

Decision record: user chose **Design + implement** with **Hybrid, measured** scope
(prompts/defaults first, measure context growth, add hard guardrails only where
measurements show drift).

## Existing surfaces (verified 2026-09-05)

- Guidance already present: reviewer instructions + spawn prompt already mandate
  `read_files windows/around/symbol` for large files (agents/reviewer/code-reviewer.ts:180,
  agents/base2/base2.ts:4740); orchestrator mandates carry the tiered read policy
  (base2.ts:546, base-deep.ts:45-52); EXPLORE_PROMPT mandates query_index-first
  discovery (base2.ts:11074). Editor large-file deterministic editing at editor.ts:122-128.
- Telemetry exists but is too coarse: `getContextCategory` lumps read_files /
  find_files / read_subtree / read_outline / query_index into ONE `fileReads`
  category (packages/agent-runtime/src/util/messages.ts:239-247). Whole-file
  bodies and cheap structured slices are indistinguishable, so "is the
  search→read handoff actually reducing read-token share?" is unanswerable.
- Compaction capture points already emit category before/after
  (run-agent-step.ts:2024-2029, 2254-2256; ContextTrimReport.beforeCategories /
  afterCategories / removedCategories).
- Dynamic memory: knowledge_memory pinned block survives compaction today
  (extractPinnedContextBlocks, retainedKnowledgeMemory). A durable per-task read
  ledger is DEFERRED until measurement shows the pinned block is insufficient.

## Milestones

- [x] P3.1 Design checkpoint (this document) — no code. (PLAN authored before implementation; no code changes in this task)
- [ ] P3.2 Phase 3a prompts: add the bounded search→read line to the specialist
  scoped review prompt (`buildSpecialistScopedReviewPrompt`, base2.ts ~8599-8635)
  so specialists get the same handoff reviewers already have. Do NOT alter the
  existing reviewer prompt line at base2.ts:4740 (tests assert its exact text).
- [ ] P3.3 Phase 3a measurement: split the `fileReads` context category into
  `boundedFileReads` (read_files with windows/around/symbol input, read_outline,
  query_index, find_files) and whole-file `fileReads` (read_files paths selector,
  read_subtree). Update ContextCategory union, summary initializer,
  CONTEXT_EVICTION_PRIORITY (bounded reads cheapest-to-recover → evict first),
  and additive tests in messages.test.ts.
- [ ] P3.4 Phase 3a validation: typecheck agent-runtime + agents; run messages,
  context-pruner, and the base2 prompt-assertion tests.
- [ ] P3.5 Measurement window (manual, no code): after a few real tasks, compare
  `boundedFileReads` vs `fileReads` token share from compaction telemetry.
- [ ] P3.6 DEFERRED hard guardrails (read_files auto-windowing past a size
  threshold, handoff contract in spawn params): implement ONLY if M5 shows
  whole-file share stays high or compaction churn recurs. Trigger, evidence, and
  scope to be recorded here before any implementation.
- [ ] P3.7 DEFERRED dynamic-memory durable read ledger: only if M5 shows eviction
  of needed reads (re-read churn after compaction).

## Risks / dependencies

- ContextCategory may be referenced in Record<ContextCategory, …> exhaustively;
  every key site must be updated or typecheck fails (good — it fails loud).
- gate telemetry fixtures in common/src/testing may embed category summaries.
- Prompt additions must stay one line to avoid prompt-size growth.
- M2/M3 are independent (agents vs agent-runtime workspaces) and can land in
  either order; both are small, additive, and locally validated like Phase 4.

<!-- update_plan_status:appended -->
## Phase 3a landed (2026-09-05) — 2026-09-05T18:53:14.099Z

Phase 3a implemented and locally validated (gate receipts pending). Files: packages/agent-runtime/src/util/messages.ts (boundedFileReads category split + eviction-first ordering), messages.test.ts (additive telemetry + eviction tests, 55/55), common/src/types/print-mode.ts (optional boundedFileReads so replayed pre-split events keep validating), cli/src/types/chat.ts (CompactionCategoryDelta union + boundedFileReads), cli/src/components/renderers/compaction-box.tsx (exhaustive 'bounded reads' label), agents/base2/base2.ts (specialist scoped-prompt bounded-read line at :9051; final-reviewer line untouched). Validation evidence: common/agent-runtime/agents/cli typechecks exit 0; gate suites 273/273; sdk-event-handlers 70/70; sweep-boxes 27/27. P3.2-P3.4 task toggles deferred until the gate mints receipts; P3.6/P3.7 remain DEFERRED per hybrid-measured scope (trigger = P3.5 measurement window showing whole-file share stays high or re-read churn after compaction).

