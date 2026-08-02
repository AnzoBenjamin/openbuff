# Context Budget Architecture — PLAN

Session: context-budget-architecture-2026-08
Spec: ./SPEC.md
Status: draft

Sequencing principle: measure first (M1) so every later change is validated against real numbers, then the three independent reductions (M2 retrieval, M3 git, M4 prompt), then earlier compaction (M5), then lifecycle polish (M6). M2–M4 are independent and can be parallelized after M1.

## Milestone 0 — Baseline measurement (no behavior change)

Goal: capture current per-component token costs so reductions are provable.

- [ ] M0-T1 Add a throwaway instrumentation harness (script under scripts/) that builds the orchestrator system prompt + file tree + knowledge for this repo and prints token counts per block using countTokensJson (packages/agent-runtime/src/util/token-counter.ts). Record numbers in STATUS.md.
- [ ] M0-T2 Measure one representative proactive query_index result and one git_status injection; record tokens.
- Validation: script runs via bun; numbers recorded. No source behavior change.

## Milestone 1 — Context budget ledger + telemetry (R1, R2, AC1)

Goal: per-turn, per-component accounting surfaced to the CLI.

- [ ] M1-T1 Create packages/agent-runtime/src/util/context-budget.ts with ContextCategory, BudgetLine, ContextBudgetLedger, recordBlock, finalizeLedger, formatLedgerForCli (see SPEC interfaces). Reuse TOKEN_COUNT_CACHE.
- [ ] M1-T2 Instrument system-prompt assembly (packages/agent-runtime/src/system-prompt/prompts.ts: getProjectFileTreePrompt, knowledgeFilesPrompt, additionalSystemPrompts, getSystemInfoPrompt) to record blocks into a ledger passed via params or returned alongside.
- [ ] M1-T3 Instrument run-agent-step.ts contextTokenCount computation to attach ledger to session state/telemetry.
- [ ] M1-T4 Ship /context command (follow agents/patterns/ship-a-cli-command.md): register in cli/src/commands/command-registry.ts and cli/src/data/slash-commands.ts; render formatLedgerForCli. Optionally fold into /usage.
- [ ] M1-T5 Unit tests: ledger sums match countTokensJson of assembled request within 5%; format output stable.
- Validation: bun typecheck (packages/agent-runtime, cli); new unit tests pass; manual /context run.
- Depends on: M0.

## Milestone 2 — Retrieval dedup + tighter classifier (R3, AC2)

Goal: stop re-injecting identical proactive query_index results.

- [ ] M2-T1 Add retrieval cache keyed by stableHash(normalizedQuery) + workspace revision (common/src/types/workspace-state.ts). Store last entry in agentState (mutableAgentState) with tokens + timestamp.
- [ ] M2-T2 In agents/base2/base2.ts around the proactive query_index yield (~line 704): on cache hit with unchanged revision, yield an add_message pointer (<200 tokens) instead of the full tool call; on miss, run query_index and record the entry.
- [ ] M2-T3 Invalidate cache on workspace revision change (advanceWorkspaceState) and on index markPathsChanged (packages/indexer/src/index-manager.ts).
- [ ] M2-T4 Tighten classifyProactiveRetrieval (base2.ts:7893): remove/weight-down generic triggers (context, index, flow) so they alone do not fire; keep strong-intent words. Mirror the change in agents/general-agent/general-agent.ts shouldProactivelyQueryIndex.
- [ ] M2-T5 Tests: extend agents/__tests__/base2.test.ts "base2 proactive index lookup" — assert second equivalent turn injects pointer not full result; assert generic-word prompt no longer triggers; assert invalidation after revision bump.
- Validation: bun test agents/__tests__/base2.test.ts; typecheck agents.
- Depends on: M1 (uses ledger tokens for assertions). Independent of M3/M4.

## Milestone 3 — Git delta helper (R4, AC3)

Goal: one guarded git observation instead of 9 redundant yields.

- [ ] M3-T1 Add maybeYieldGitObservation helper (new util consumed by base2 handleSteps). Computes a worktree fingerprint, compares to state.lastGitFingerprint; returns full git_status on first/changed, compact delta add_message on minor change, undefined when unchanged.
- [ ] M3-T2 Replace all 9 inline git_status yields in agents/base2/base2.ts (lines 787, 1097, 2480, 3133, 3354, 3474, 4064, 4301, 4449) with calls to the helper. Preserve the semantic reason each site existed (turn start vs post-gate) via the helper's note field.
- [ ] M3-T3 Store lastGitFingerprint + workspaceRevision in agentState; reset on revision change.
- [ ] M3-T4 Tests: base2 handleSteps test asserting zero git blocks across unchanged consecutive turns and exactly one compact delta after a simulated change. Update affected e2e expectations (agents/e2e/gate-lifecycle.e2e.test.ts, reviewer-spawn-conditions.e2e.test.ts) only where the redundant yields were asserted.
- Validation: bun test agents; typecheck agents.
- Depends on: M1. Independent of M2/M4.
- Risk: many e2e tests assert git_status yields — audit assertions before replacing; keep first-observation behavior identical.

## Milestone 4 — Progressive prompt disclosure (R5, AC4)

Goal: shrink the always-on orchestrator system prompt; keep guidance retrievable.

- [ ] M4-T1 Inventory the orchestrator system prompt (agents/base2/base2.ts systemPrompt + quality-prompt-section.ts + patterns index) and measure each section (from M0/M1 ledger). Identify verbose, rarely-needed blocks (specialist routing detail, security pattern list, full recovery workflow prose).
- [ ] M4-T2 Relocate verbose detail into skills/knowledge (existing skill loader; see cli/src/data/slash-commands.ts getSlashCommandsWithSkills and agents/patterns/). Replace inline prose with a compact always-on index: one line per rule block with trigger keywords and the skill/pattern name to load.
- [ ] M4-T3 Ensure trigger keywords in the compact index cause the model to load the relevant skill/pattern on demand (verify against skill tool behavior).
- [ ] M4-T4 Gate behind a config flag (default off) until evals show no task-success regression.
- [ ] M4-T5 Tests: assert always-on prompt token count reduced >= 25% vs M0 baseline; assert each relocated block is reachable via its named skill/pattern; snapshot test of the compact index.
- Validation: bun typecheck agents + cli; prompt budget test; run a small buffbench subset (evals/) comparing before/after if available.
- Depends on: M1. Independent of M2/M3.
- Risk: hidden guidance regression — mitigate with flag + eval comparison; do not drop any mandate, only relocate detail.

## Milestone 5 — Earlier semantic compaction (R6, AC5)

Goal: compact before the 190k emergency brake.

- [ ] M5-T1 In packages/agent-runtime/src/run-agent-step.ts, compute getSemanticCompactionBudget(getEffectiveContextLimits(...)) for the active model and trigger semantic compaction at triggerBudgetTokens (not DEFAULT_MAX_CONTEXT_TOKENS). Keep maybePruneContext as the hard fallback.
- [ ] M5-T2 Ensure pinned control-plane memory (extractPinnedContextBlocks) and fixed baseline stay outside the history budget.
- [ ] M5-T3 Wire the LLM context-pruner (agents/context-pruner.ts) spawn to the budget trigger where smarter summarization is wanted; keep deterministic trim as fallback.
- [ ] M5-T4 Tests: extend packages/agent-runtime/src/util/__tests__/context-pruning.test.ts and agents/e2e/context-pruning-threshold.e2e.test.ts — synthetic growing history triggers compaction at triggerBudgetTokens, before 190k; pinned blocks retained.
- Validation: bun test packages/agent-runtime; e2e context-pruning tests.
- Depends on: M1. Can run parallel to M2–M4.

## Milestone 6 — Tool-result lifecycle (R7)

Goal: deterministic TTL/importance compression for verbose results.

- [ ] M6-T1 Tag verbose tool results (query_index, read_files, spawn_agents) with importance + turn-born metadata at creation.
- [ ] M6-T2 Replace the blunt numToolResultsToKeep cutoff in simplifyToolResultHelper (messages.ts:153) with a deterministic policy: compress to a receipt after N turns unless pinned/important. Keep behavior monotonic and testable.
- [ ] M6-T3 Tests: unit tests for the lifecycle policy; ensure no pinned/active-work result is ever dropped.
- Validation: bun test packages/agent-runtime; messages.test.ts.
- Depends on: M5 (shares compaction path).

## Cross-cutting

- [ ] X-T1 Keep all behavior changes behind config flags with safe defaults; document flags in docs/configuration.md and docs/environment-variables.md.
- [ ] X-T2 Update docs/architecture.md "Deterministic Edits, Reviewer Gates, and Plan Artifacts" area with a short context-budget section once M1 lands.
- [ ] X-T3 Run full validation suite before finalizing: bun typecheck across packages/agent-runtime, agents, cli, common; bun test for touched packages; relevant e2e (context-pruning, base2 proactive, gate-lifecycle).

## Validation gates (per milestone)

- M1: ledger sum within 5% of request tokens; /context renders.
- M2: second-turn pointer <200 tokens; generic-word no-trigger; invalidation on revision bump.
- M3: zero git blocks on unchanged turns; one delta after change.
- M4: >=25% always-on prompt reduction; all blocks retrievable; no eval regression (flag-gated).
- M5: compaction at triggerBudgetTokens before 190k; pinned retained.
- M6: lifecycle compression deterministic; pinned never dropped.

## Risks tracker

- e2e tests asserting redundant git_status yields (M3) — audit first.
- prompt disclosure regressions (M4) — flag + eval comparison.
- token-count drift vs provider — advisory ledger first, not a hard gate.
- stale retrieval cache after external edits (M2) — revision + index-staleness invalidation.
