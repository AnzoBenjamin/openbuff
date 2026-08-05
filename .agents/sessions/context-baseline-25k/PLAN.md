# Context Baseline 25–30k — PLAN

Session: context-baseline-25k
Spec: ./SPEC.md
Status: active
<!-- current-task: X-T5 smoke set -->

Sequencing: **measure first (M0)**, then **tool tiers (M1)** as largest fixed win, parallel **prompt default-on (M2)** + **tree/knowledge (M3)**, then **proactive lean (M4)**, optional **schema diet (M5)**, **history polish (M6)**. Gate e2e after every default flip.

Predecessor complete (do not re-implement): ledger, `/context`, prompt disclosure *flag*, proactive cache+epoch, git gate, semantic compaction, tool-result lifecycle — see `../context-budget-architecture-2026-08/STATUS.md`.

---

## Milestone 0 — Measurement lock (no behavior change)

Goal: production-faithful numbers; stop optimizing the wrong baseline.

- [x] M0-T1 Extend `scripts/measure-context-baseline.ts`:
  - Measure `FILE_TREE_PROMPT_SMALL` (2.5k) and full 10k separately
  - Measure progressive prompt disclosure off vs on (authored surface via `createBase2`)
  - Emit single **default base2 assembled fixed** line (production placeholders)
  - Optionally stub tool-tier totals once tiers exist (core vs full)
- [x] M0-T2 Record corrected numbers in STATUS.md (fixed vs first-turn with proactive)
- [x] M0-T3 Soft assertion helpers or documented phase targets (≤32k / ≤28k / ≤30k)
- Validation: `bun run scripts/measure-context-baseline.ts` exit 0; STATUS updated — **done 2026-08-04** (fixed 49,345 this worktree; ~39.4k if git clean)

---

## Milestone 1 — Progressive tool disclosure (R1, AC-F2, AC-G*)

Goal: cut tool definition tax from ~23.5k toward core ≤12k.

- [x] M1-T1 Create `agents/base2/tool-tiers.ts` with CORE / IMPLEMENT / AUDIT / MEDIA_3D / JOB_EXTRA and `resolveModelToolNames`
- [x] M1-T2 Wire `createBase2` `toolNames` from tiers + existing mode gates (`planOnly`, `fast`, `executePlan`, `noAskUser`); keep `programmaticToolNames` unchanged
- [ ] M1-T3 Agent state: `unlockedToolTiers`; deterministic unlock in `handleSteps` on implement intent / active work / audit classifier / media paths
  - Acceptance: `publishUnlockedToolTiers` runs before each STEP inside serialized handleSteps; inline copy guarded by a sync test against `resolveUnlockedTiersForPhase(deriveIntentSignals(...))`
  - Validate: bun test agents/__tests__/base2-progressive-tool-disclosure.test.ts
- [ ] M1-T4 Runtime: only unlocked tools in `getToolSet` / token ledger; locked call → actionable message (tool-executor or spawn path)
  - Acceptance: loopAgentSteps test shows per-step expand AND shrink; `tool-executor` rejects still-locked tier tools with the listed current surface
  - Validate: bun test agents/__tests__/base2-progressive-tool-disclosure.test.ts
- [ ] M1-T5 Short always-on “Tool surface” prompt block
  - Acceptance: `## Tool surface` block present in the base2 system prompt exactly when progressiveToolDisclosure is on
  - Validate: bun test agents/__tests__/base2-progressive-tool-disclosure.test.ts
- [x] M1-T6 Flag: `progressiveToolDisclosure` option + `OPENBUFF_PROGRESSIVE_TOOL_DISCLOSURE` canary (default off until canary green)
- [x] M1-T7 Tests (partial — unit canary + core &lt;12k + planOnly gates; gate e2e unlock + locked-tool path now landed and green):
  - [x] Core-only token total ≤ ~12k; full ≤ 25k
  - [x] Plan mode never exposes `edit_transaction`
  - [x] Gate e2e with IMPLEMENT unlocked after first edit
  - [x] Locked tool error path
- Validation: agents + agent-runtime typecheck; unit + gate e2e subset
- Sequencing note: M0 recommended for before/after numbers
- Risk: prompt-cache miss on unlock — accept per phase; keep CORE stable

### M1 rollout

| Phase | Behavior |
|---|---|
| Canary | env on: core + auto-unlock IMPLEMENT on implement intent (does **not** satisfy AC-A1) |
| Default-on | only after **AC-A1**: full gate e2e **and** buffbench subset or fixed smoke set; results no worse than STATUS baseline |
| Kill switch | explicit false → full 33-tool surface |

---

## Milestone 2 — Default-on progressive prompt disclosure (R2, AC-P1, AC-G2)

Goal: thinner always-on authored surface; gate text remains full.

- [ ] M2-T1 Confirm guides exist and tests pass with flag on (`agents/__tests__/base2-progressive-disclosure.test.ts`)
- [ ] M2-T2 Default `progressivePromptDisclosure` **true** (explicit false still wins; update env docs: default on)
- [ ] M2-T3 Ensure `gateAwarenessSection` is **never** passed through `disclose()` — always full text
- [ ] M2-T4 Optional: shrink `knowledgeFilesPrompt` to short blurb + `agents/guides/knowledge-files.md`
- [ ] M2-T5 Optional second wave: compress long spawning guidelines / multi examples to index + one example
- [ ] M2-T6 Mode-thin instructions where cheap (conversation / plan vs implement) without dropping gate in implement modes
- [ ] M2-T7 Gate e2e + progressive-disclosure suite green; update `docs/configuration.md` / `docs/environment-variables.md`
- [ ] M2-T8 Before default-on: satisfy **AC-A1** (gate e2e + buffbench subset or fixed smoke tasks; no worse than STATUS baseline). Record evidence in STATUS.
- Validation: agents tests; gate e2e; **AC-A1** before default true
- Sequencing note: independent of M1; canary dogfood recommended before default flip
- Risk: hidden guidance — keep trigger pointers; canary first; **AC-A1** hard bar for default-on

---

## Milestone 3 — Cheaper always-on project context (R3)

Goal: lower SMALL tree + knowledge instruction cost.

- [ ] M3-T1 Lower `FILE_TREE_PROMPT_SMALL` budget in `packages/agent-runtime/src/templates/strings.ts` from 2_500 → **1_500–2_000**
- [ ] M3-T2 Bias truncation toward path-only / drop symbols earlier for agent-mode small tree (`truncate-file-tree.ts` if needed)
- [ ] M3-T3 Shrink static `knowledgeFilesPrompt` (or pair with M2-T4 guide)
- [ ] M3-T4 Update baseline script expectations; document that LARGE remains for search agents
- Validation: measure script; prompts-ledger tests if any; no gate impact expected
- Sequencing note: uses M0 for proof of savings
- Risk: low — discovery tools remain

---

## Milestone 4 — Lean proactive inject (R4, AC-R1)

Goal: fewer firings + smaller first-hit payload.

- [x] M4-T1 Tighten `classifyProactiveRetrieval` in `agents/base2/base2.ts` (stronger intent; strip bare generic solo triggers; skip pure Q&A)
- [x] M4-T2 Mirror intent policy in `agents/general-agent/general-agent.ts` if still dual-sited — N/A: no dual-site exists (verified absence of `classifyProactiveRetrieval` there)
- [x] M4-T3 Lower default limits (unknown 8, multi-file 12, cross-subsystem 16)
- [x] M4-T4 Compact proactive result envelope (&lt;1.5k); full envelope on explicit `query_index` only — via inline `toCompactProactiveRetrievalResult`
- [x] M4-T5 Defer or summarize cross-subsystem structure/list_directory extras
- [x] M4-T6 Tests: no-fire weak prompts; compact size; cache hit still pointer; epoch invalidation unchanged
- Validation: base2 proactive tests; agents typecheck — gate reviewer verdict NON_BLOCKING 2026-08-04, coverage covered; two advisory nits (NF-1 EXPLORE_PROMPT mentions dropped matchedSnippets/relatedFiles; NF-2 compact cache result read-once) recorded in STATUS.md
- Sequencing note: uses M0 for size assertions
- Risk: audit breadth — keep full path on explicit tool / confirmed audit

---

## Milestone 5 — Schema / description diet (R5, optional)

Goal: extra 1–3k on CORE without removing tools.

- [ ] M5-T1 Rank tools by token cost (script or unit helper)
- [ ] M5-T2 Shorten top CORE descriptions / redundant field describes
- [ ] M5-T3 Re-check core ≤12k and schema compile/generate guards
- Validation: `base2-context-budget`; tool definition generate if required
- Sequencing note: prefer after M1 (diet CORE after tiers exist)
- Risk: model misuse from terse schemas — keep critical constraints in schema

---

## Milestone 6 — History hygiene polish (R6)

Goal: remaining window lasts longer (not fixed baseline).

- [ ] M6-T1 Ensure proactive injects are lifecycle-normal (not pinned/high)
- [ ] M6-T2 Verify spawn/read digest bounds; document any gaps
- [ ] M6-T3 Optional prompt nudge: prefer post-edit receipts over full re-reads
- Validation: tool-result-lifecycle + messages trim tests
- Sequencing note: no critical dependencies

---

## Cross-cutting

- [ ] X-T1 Flags documented (`OPENBUFF_PROGRESSIVE_TOOL_DISCLOSURE`, disclosure default change)
- [ ] X-T2 Architecture/config docs updated for tool tiers + 25–30k program
- [ ] X-T3 Full validation before default-on flips: typecheck agents/agent-runtime/cli/common; gate e2e; context-pruning; progressive-disclosure; baseline script
- [ ] X-T4 Do **not** remove automated reviewer/hooks to save tokens
- [ ] X-T5 Document the fixed smoke task set (or buffbench subset commands) in STATUS **before** the first M1/M2 default-on attempt; record pre-flip baseline scores for **AC-A1**

---

## Suggested calendar (indicative)

| Window | Work |
|---|---|
| Week 1 | M0 measurement lock |
| Week 1–2 | M1 tool tiers (canary) |
| Week 2 | M2 prompt default-on + M3 tree/knowledge (parallel) |
| Week 3 | M4 proactive + M5 schema diet |
| Week 4 | M1/M2 default-on only after |