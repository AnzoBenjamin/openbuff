# Context Budget Architecture — STATUS

Session: context-budget-architecture-2026-08
Last updated: 2026-08-01

## Current state

Milestone 0 (baseline measurement) complete. Script created and run. Numbers recorded below.

## M0 Baseline Numbers (2026-08-01)

Measured via `bun run scripts/measure-context-baseline.ts` on the openbuff repo itself.
Token counts use gpt-tokenizer with 1.35x Anthropic fudge factor.

### Per-component breakdown

| Component | Tokens | Notes |
|---|---|---|
| base2 systemPrompt (raw template) | 10,674 | 39,283 chars; includes unreplaced placeholders |
| Knowledge files instruction (static) | 1,036 | The "how to use knowledge files" prompt |
| Patterns index prompt | 307 | Compact catalog from agents/patterns/INDEX.md |
| File tree prompt (agent, 10k budget) | 190 | UNDERESTIMATE — session-state extraction missed fileTree |
| System info prompt | 109 | OS, shell, chrome, recently-read files |
| Language + engine profile | 0 | UNDERESTIMATE — depends on fileTree which was empty |
| Knowledge files (root-level contents) | 0 | UNDERESTIMATE — sessionState.knowledgeFiles was empty |
| Git changes prompt | 0 | Clean tree at measurement time |
| **Fixed baseline subtotal** | **12,316** | Excludes injections; underestimates true cost |
| Proactive query_index (24 results) | 4,912 | scope=multi-file, mode=explain, limit=24 |
| git_status injection | 52 | Compact: branch + dirty paths |
| **Automatic injections subtotal** | **4,964** | Per-turn when proactive retrieval fires |
| **Total measured** | **17,280** | 9.1% of 190k max |

### Known underestimates

The script extracts ProjectFileContext fields from `initialSessionState()`, but the
session-state shape does not directly expose `knowledgeFiles`, `fileTree`, and
`userKnowledgeFiles` at the top level the script expected. In production:

- **Knowledge file contents** (knowledge.md, AGENTS.md, docs/architecture.md) add
  roughly 3,000–5,000 tokens based on the files present in this repo.
- **File tree** at 10k budget adds roughly 2,000–4,000 tokens for a repo this size.
- **Language profile** adds roughly 500–1,000 tokens.
- **Tool definitions** (schemas for ~40+ tools) are sent alongside the system prompt
  but NOT measured by this script. Estimated 15,000–25,000 tokens based on the
  tool count and schema verbosity.

### Realistic per-turn fixed cost estimate

| Component | Est. tokens |
|---|---|
| System prompt (assembled, placeholders replaced) | ~15,000–18,000 |
| Tool definitions (schemas) | ~15,000–25,000 |
| Per-turn injections (query_index + git_status) | ~5,000 |
| **Total fixed per-turn overhead** | **~35,000–48,000** |
| As % of 190k max | ~18–25% |

### Key takeaways for prioritization

1. **base2 systemPrompt template (10,674 tok)** is the single largest measured fixed
   cost and the primary target for M4 (progressive disclosure). A 25% reduction
   saves ~2,700 tokens/turn.
2. **Proactive query_index (~4,912 tok/injection)** is the largest per-turn variable
   cost. M2 (dedup + tighter classifier) can eliminate most repeat injections.
3. **git_status (52 tok)** is cheap individually but fires at 9 sites; M3 (delta
   helper) eliminates redundant fires. Cost savings are small but it removes
   noise from history that compounds over turns.
4. **Tool definitions** are a large unmeasured cost. Not in scope for this plan
   but worth a future investigation (lazy tool registration, schema compression).
5. **Pruning threshold (190k)** means the context grows to ~190k before any cleanup.
   M5 (earlier semantic compaction) addresses this.

## Completed work

- [x] SPEC.md written
- [x] PLAN.md written
- [x] M0-T1: scripts/measure-context-baseline.ts created and runs clean (exit 0)
- [x] M0-T2: Representative query_index and git_status injections measured
- [x] Numbers recorded in this file

## Next steps

- M1: Context budget ledger + /context telemetry
- M2: Retrieval dedup (can parallelize with M3, M4 after M1)
- M3: Git delta helper
- M4: Progressive prompt disclosure
- M5: Earlier semantic compaction

## Resume instructions

1. Read SPEC.md and PLAN.md in this directory.
2. The baseline script is at scripts/measure-context-baseline.ts.
3. Fix the session-state → ProjectFileContext extraction to get accurate
   knowledge/tree/profile numbers before starting M1.
4. Start M1-T1: create packages/agent-runtime/src/util/context-budget.ts.

<!-- update_plan_status:appended -->
## M0 numbers CORRECTED after under-measurement fix — 2026-08-01T06:32:17.067Z

The initial M0 run under-measured because the script stub-extracted ProjectFileContext fields. The hardened script now uses the real `sessionState.fileContext`, and the base2 template measurement reflects the fully-assembled default-mode systemPrompt (createBase2('default')). Re-run 2026-08-01T06:30Z:

| Component | Tokens (corrected) | Was |
|---|---|---|
| base2 systemPrompt (raw template) | 11,631 | 10,674 |
| File tree prompt (agent, 10k) | 9,729 | 190 |
| Knowledge files (root-level contents) | 98 | 0 |
| Knowledge files instruction (static) | 1,036 | 1,036 |
| System info prompt | 326 | 109 |
| Git changes prompt | 363 | 0 |
| Patterns index prompt | 307 | 307 |
| Language + engine profile | 388 | 0 |
| **Fixed baseline** | **23,878** | **12,316** |
| Proactive query_index (24) | 4,912 | 4,912 |
| git_status | 52 | 52 |
| **Injections/turn** | **4,964** | **4,964** |
| **Total measured** | **28,842** | **17,280** |
| % of 190k max | **15.2%** | 9.1% |

Key revision: the fixed baseline was ~2x larger than first measured, dominated by the file tree (9,729) and the assembled systemPrompt template (11,631). Priorities for M4 (progressive disclosure) and M1 telemetry are unchanged but better justified. Tool-definition schemas remain the largest UNMEASURED cost (est 15–25k). Script hardening complete: isInjection/isRawTemplate flags, KNOWLEDGE_FILE_NAMES_LOWERCASE reuse, and exit-1 on component error.

<!-- update_plan_status:appended -->
## M1 complete — context budget ledger + /context telemetry (gate-verified) — 2026-08-02T23:25:00.119Z

M1 is complete and gate-verified (validation hooks + code-reviewer NON_BLOCKING on snapshot v3:c9d9450c41c52).

- M1-T1 ledger module (`packages/agent-runtime/src/util/context-budget.ts`) — already existed with createBudgetLedger/recordBlock/applyMeasure/finalizeLedger + full unit tests.
- M1-T2 instrument system-prompt assembly — already existed: `applyMeasure` wired into `prompts.ts` (fileTree, systemInfo, gitChanges) via `formatPrompt`'s optional `ledger` param.
- M1-T3 wire ledger into run-agent-step — DONE: `createBudgetLedger` before system-prompt assembly in `run-agent-step.ts`, threaded through the `systemPrompt` getAgentPrompt call, persisted to `initialAgentState.contextBudgetLedger` via `finalizeLedger` guarded by `builtSystemPromptThisTurn` (cached-prompt turns keep the prior ledger by identity). Added `AgentState.contextBudgetLedger?: ContextBudgetLedger` + `BudgetLine`/`BudgetCategory` types to `common/src/types/session-state.ts`.
- M1-T4 /context CLI command — DONE: `cli/src/commands/context.ts` `handleContextCommand` reads `runState.sessionState.mainAgentState.contextBudgetLedger`, renders via `formatLedgerForCli`, registered in `command-registry.ts` + `slash-commands.ts` as `/context` (alias `/ctx`).
- M1-T5 unit tests — DONE: existing ledger tests + new `cli/src/commands/__tests__/context.test.ts` (breakdown + no-data fallback) and a `loop-agent-steps.test.ts` case (ledger populated on build turn, kept by identity on cached-prompt turn).

Repairs during gate: moved `formatLedgerForCli` into `common/src/util/context-budget.ts` (shared single implementation, re-exported from agent-runtime); tightened the `BudgetLine.category` mirror from `string` to the canonical `BudgetCategory` union; documented the stale-windowTokens edge on cached-prompt turns.

Two NON_BLOCKING reviewer nits left for later: brittle substring assertions in context.test.ts (could pin exact formatted lines), and no zero-window/empty-ledger formatter branch coverage.

Next: M2 (retrieval dedup), M3 (git delta helper), M4 (progressive prompt disclosure) — independent, can parallelize. M5 (earlier semantic compaction) after M1.


<!-- update_plan_status:appended -->
## M4 complete + M5 verified already-implemented — 2026-08-03T12:57:34.911Z

## Progress checkpoint (2026-08-03)

### M4 — Progressive prompt disclosure — DONE (committed `a1882a65`)
- `createBase2({ progressivePromptDisclosure })` default off; flag-on relocates five advisory sections to `agents/guides/*`.
- Tests: `agents/__tests__/base2-progressive-disclosure.test.ts` (7/7) including qualitySection/code-craftsmanship coverage after reviewer repair.
- Gate: LOOKS_GOOD; typecheck agents + agent-runtime green. Not pushed.

### M5 — Earlier semantic compaction — ALREADY IMPLEMENTED (no new code needed)
Verified against SPEC R6 / AC5 by reading source + running focused suites:
- `getSemanticCompactionBudget` + model-aware trigger/target in `packages/agent-runtime/src/util/context-pruning.ts`.
- Runtime: `run-agent-step.ts` computes semantic budget, detects retained `<knowledge_memory>`, emits `semantic_compaction` before `maybePruneContext` (mechanical emergency brake uses `providerSafeMessageLimit`, not bare 190k-only first response).
- Pruner injection: `run-programmatic-step.ts` injects authoritative `semanticBudget` into context-pruner generator params.
- Pinned/control-plane: extractPinnedContextBlocks + knowledge_memory retention; ledger annotate via `annotateLedgerAfterCompaction`.
- Tests green (33/33): `context-pruning.test.ts` + `loop-agent-steps.test.ts` including "runs semantic programmatic compaction before the mechanical brake" and small-model budget cases; context-pruner unit cases scale trigger under/over across windows (8k–1M).

### Remaining plan work
- **M3** (git delta helper): SPEC still open — no `maybeYieldGitObservation` symbol in tree; plan checkboxes unchecked. (Earlier session notes may have partially addressed git_status noise; re-audit before implementing.)
- **M2** residual: base2 has per-session proactive retrieval cache; TODO remains for index-manager `markPathsChanged` invalidation.
- **M6** (tool-result lifecycle): still uses blunt `numToolResultsToKeep = 1` in `messages.ts` simplifyToolResultHelper — next implementation milestone.
- Cross-cutting X-T1/X-T2 docs flags still open.

### Next checkpoint
Start **M6 tool-result lifecycle** (R7) unless user redirects to residual M3 git delta.


<!-- update_plan_status:appended -->
## M6 implementation in progress — tool-result lifecycle — 2026-08-03T13:08:03.830Z

M6 (R7) code landed locally, awaiting gate:

- New pure policy: `packages/agent-runtime/src/util/tool-result-lifecycle.ts` (tags + shouldKeepFullToolResult; protected does not consume keep-N budget).
- Wired into `simplifyToolResultHelper` / trim first pass in `messages.ts`.
- Tagging at creation in both `tool-executor.ts` ToolMessage sites (`lifecycleTagsForToolResult` + `sentAt`).
- Tests: `tool-result-lifecycle.test.ts` + messages trim case for pinned full vs normal simplify; local suite 57/57 pass.

Note: hard-budget second pass in trim may still content-simplify even `keepDuringTruncation` tool bodies (pre-existing emergency behavior; existing tests require it). M6 protects the first-pass keep-N policy + never *drops* pinned messages.


<!-- update_plan_status:appended -->
## M6 complete — tool-result lifecycle (gate-verified) — 2026-08-03T13:12:52.888Z

M6 (SPEC R7) complete and gate-verified LOOKS_GOOD on snapshot v3:77a0076fba5b5.

Shipped:
- `packages/agent-runtime/src/util/tool-result-lifecycle.ts` — pure policy (tags, isProtectedToolResult, shouldKeepFullToolResult); protected does not consume keep-N budget; default N=1 for newest unprotected summarizable results.
- Creation tagging in both tool-executor ToolMessage sites (`lifecycleTagsForToolResult` + `sentAt`).
- `messages.ts` simplifyToolResultHelper wired to policy on the first trim pass.
- Tests: tool-result-lifecycle unit + messages trim integration (pinned full vs normal simplify).

Caveat (documented): hard-budget second pass may still content-simplify keepDuringTruncation tool bodies under extreme pressure (pre-existing emergency behavior).

Also verified earlier this turn: M5 already implemented (no new code); M4 committed as `a1882a65`.

Remaining plan work: residual M3 git delta helper re-audit; M2 markPathsChanged invalidation TODO; X-T1/X-T2 docs.


<!-- update_plan_status:appended -->
## M2 residual + M3 + X-T1/X-T2 complete (gate-verified NON_BLOCKING) — 2026-08-03T13:51:26.913Z

All three suggested follow-ups are complete and gate-verified (NON_BLOCKING, 3 minor nits accepted without code changes):

- **M2 residual** — `IndexManager.indexMutationEpoch` (in-process monotonic, additive getter; increments on markStale/markPathsChanged); `query_index` result includes the epoch; base2 proactive cache invalidates when the newest epoch in messageHistory differs from the cache entry at the same workspace revision. Tests: IndexManager epoch + base2 epoch-guard invalidation.
- **M3** — already satisfied by SDK `applyGitStatusGate` (`sdk/src/run.ts`): unchanged per-turn git_status repeats compact to an "unchanged" note; no new base2 helper needed. Verified git-status-gate suite 12/12 + base2 suite green.
- **X-T1/X-T2** — context-budget documentation added to `docs/architecture.md` (Context Budget, Retrieval Caching, and Git Observation Gating), `docs/configuration.md` (Context budget and proactive retrieval), and `docs/environment-variables.md` (no new OPENBUFF_* vars).

Context-budget plan is now substantially complete across M0–M6 + cross-cutting docs. Remaining optional work: canary progressivePromptDisclosure, measure tool-definition schema cost, eval comparison.
