# Context Baseline 25–30k — STATUS

Session: context-baseline-25k
Last updated: 2026-08-04
Lifecycle: **active** (M1 canary slice landed; default-on blocked until AC-A1)

## Current state

M0 complete. M1 progressive **tool** disclosure canary slice landed (`tool-tiers.ts` + `createBase2` wiring, default **off**).

**Predecessor** `.agents/sessions/context-budget-architecture-2026-08/` remains complete for ledger/`/context`/disclosure _flag_/proactive cache/git gate/compaction/lifecycle. This program hits **≤30k fixed** (stretch 25k) without weakening the gate.

## Ability regression bar (AC-A1)

Added to SPEC (G8, R8, AC-A1) and PLAN (M1 default-on, M2-T8, X-T5, validation gates).

Before flipping **M1** or **M2** to **default-on**:

1. Full gate e2e suite, **and**
2. Buffbench subset **or** fixed smoke task set documented below
3. Results **no worse** than pre-flip baseline recorded here

Canary-only shipping does **not** satisfy AC-A1.

### Fixed smoke task set (draft for X-T5; finalize before first default-on)

Placeholder until first default-on attempt — record commands + scores here:

| ID  | Task                        | Command / procedure                                              | Pre-flip baseline |
| --- | --------------------------- | ---------------------------------------------------------------- | ----------------- |
| S1  | Gate lifecycle e2e          | `bun test agents/e2e/gate-lifecycle.e2e.test.ts`                 | TBD               |
| S2  | Gate aux ordering e2e       | `bun test agents/e2e/gate-aux-ordering.e2e.test.ts`              | TBD               |
| S3  | Progressive disclosure unit | `bun test agents/__tests__/base2-progressive-disclosure.test.ts` | TBD               |
| S4  | Context budget tools unit   | `bun test agents/__tests__/base2-context-budget.test.ts`         | TBD               |
| S5  | Optional buffbench subset   | document eval id + runner when used                              | TBD               |

## Baseline snapshot

### Legacy script numbers (pre-M0, 10k tree — overstated)

| Component                               |  Tokens |
| --------------------------------------- | ------: |
| Tool definitions (33 tools)             |  23,506 |
| base2 systemPrompt raw template         |  11,612 |
| File tree (10k budget)                  |   9,126 |
| Knowledge instruction static            |   1,036 |
| System info / git / patterns / language |   ~1.5k |
| Proactive query_index (rep. 24)         |  ~4,912 |
| git_status rep.                         |     ~52 |
| Script “fixed excl. injections”         | ~46,931 |
| Script total + injections               | ~51,895 |

### M0 production-faithful numbers (2026-08-04T05:49Z)

Source: `bun run scripts/measure-context-baseline.ts` exit 0 after M0 script rewrite.

| Metric                                                         |                               Tokens |
| -------------------------------------------------------------- | -----------------------------------: |
| Default fixed (prod, disclosure off, SMALL tree, no proactive) |                           **49,345** |
| Default fixed if disclosure on (est.)                          |                           **46,661** |
| Authored surface off → on                                      | 15,288 → 11,287 (**−4,001 / 26.2%**) |
| Injections (rep. proactive + git)                              |                                4,960 |
| First-turn (fixed + injections)                                |                               54,305 |
| Soft targets phase1/2/program/stretch                          |          all OVER advisory vs 49,345 |

#### Per-component (prod-fixed unless noted)

| Component                               |    Tokens | Tag                                  |
| --------------------------------------- | --------: | ------------------------------------ |
| base2 systemPrompt raw (disclosure off) |    11,612 | prod-fixed                           |
| Tool definitions (33 tools)             |    23,506 | prod-fixed                           |
| File tree SMALL (2.5k budget)           | **2,016** | prod-fixed                           |
| File tree FULL (10k)                    |     9,175 | comparison                           |
| Knowledge contents                      |        98 | prod-fixed                           |
| Knowledge instruction                   |     1,036 | prod-fixed                           |
| System info                             |       407 | prod-fixed                           |
| Git changes prompt                      | **9,975** | prod-fixed (dirty worktree inflated) |
| Patterns index                          |       307 | prod-fixed                           |
| Language + engine profile               |       388 | prod-fixed                           |
| Proactive query_index rep.              |     4,912 | injection                            |
| git_status rep.                         |        48 | injection                            |

#### Interpretation for planning

- **SMALL tree is ~2.0k**, not ~9k — prior overstatement confirmed.
- **Tools (23.5k) still dominate** fixed cost → M1 is still the largest lever.
- **Git changes ~10k** on this run is session-dependent (large dirty/diff in worktree). On a clean tree this line is near 0–few hundred; **clean-ish fixed ≈ 49,345 − 9,975 ≈ 39.4k**.
- Disclosure on saves ~2.7k on raw system alone (est. fixed 46.7k) and **26.2% authored surface** (meets AC-P1 canary metric).
- AC-F1 (≤30k) is **not** met yet; gap is mostly tools + template + dirty git.

## Completed work (this session)

- [x] SPEC.md / PLAN.md / STATUS.md initial plan artifacts
- [x] AC-A1 ability-regression bar added to SPEC + PLAN + STATUS
- [x] M0-T1/T2/T3: production-faithful baseline measurement
- [x] M1-T1: `agents/base2/tool-tiers.ts` (CORE/IMPLEMENT/AUDIT/MEDIA_3D/JOB_EXTRA + `resolveModelToolNames`)
- [x] M1-T2: `createBase2` wires `toolNames` via resolver (mode gates preserved)
- [x] M1-T6: `progressiveToolDisclosure` option + `OPENBUFF_PROGRESSIVE_TOOL_DISCLOSURE` canary (default off)
- [x] M1 unit tests: `agents/__tests__/base2-progressive-tool-disclosure.test.ts` (core &lt;12k, env canary, planOnly gates)
- [x] Docs: `docs/environment-variables.md`, `docs/configuration.md`
- [ ] M1-T3: handleSteps `unlockedToolTiers` deterministic unlock
- [ ] M1-T4: locked-tool runtime error path
- [ ] M1-T5: always-on “Tool surface” prompt block
- [ ] M1 default-on: **blocked until AC-A1**

## Completed work (predecessor — do not redo)

- Context budget ledger + `/context`
- Progressive prompt disclosure implementation (flag/env; guides; ≥25% test)
- Proactive retrieval cache + indexMutationEpoch invalidation
- Git status observation gating (SDK)
- Semantic compaction at model-aware trigger
- Tool-result lifecycle policy

## Pending work

1. **M0** — complete
2. **M1** — canary surface done; remaining unlock/runtime/prompt + default-on after AC-A1
3. **M2** — Progressive prompt disclosure default-on **only after AC-A1**
4. **M3** — Smaller SMALL tree + knowledge instruction
5. **M4** — Lean proactive classifier + compact envelope
6. **M5** — Optional CORE schema diet
7. **M6** — History hygiene polish
8. **X-\*** — Docs, full validation, default flips

## Next checkpoint

**M1-T3/T4/T5:** deterministic unlock in handleSteps + locked-tool error + tool-surface prompt (still canary-only; no default-on).

## Resume instructions

1. Read `SPEC.md` then `PLAN.md`.
2. Run baseline script; update this STATUS with M0 numbers.
3. Gate e2e + **AC-A1** before any M1/M2 default-on.
4. Never relocate `gateAwarenessSection`.

## Target scoreboard

|                             |          M0 measured |               After program |
| --------------------------- | -------------------: | --------------------------: |
| Tools                       |                23.5k | 8–12k core (full on unlock) |
| Authored surface            | 15.3k off / 11.3k on |         keep ≥25% reduction |
| Tree (production SMALL)     |             **2.0k** |                     ~1.5–2k |
| Knowledge instruction       |                 1.0k |                       ~0.2k |
| Git changes (this worktree) |    **10.0k** (dirty) |                 ~0 on clean |
| **Fixed total (this run)**  |            **49.3k** |                 **~25–30k** |
| **Fixed if clean git**      |      **~39.4k est.** |                 **~25–30k** |
| Proactive first hit         |                  ~5k |                     ~0–1.5k |
| Gate                        |        full strength |               **unchanged** |
| Ability (default-on)        |                  n/a |          **AC-A1** hard bar |

## Blockers

None for M0 (complete). Default-on blocked until AC-A1 evidence is recorded.

<!-- update_plan_status:appended -->

## M1-T3/T4/T5 verified landed — 2026-08-04 — 2026-08-04T21:12:43.936Z

## M1-T3/T4/T5 verified landed — 2026-08-04

Resume at M1-T3 found the unlock runtime already shipped; verified against live code, no new edits this turn.

- **M1-T3** deterministic unlock: `publishUnlockedToolTiers` defined inside serialized `handleSteps` (inlines deriveIntentSignals/resolveUnlockedTiersForPhase; canary via programmaticConfig). Inline-vs-canonical sync guard test passes across the phase/prompt matrix; canary-off clears stale unlocks.
- **M1-T4** runtime surface: `run-agent-step` filters custom/MCP `additionalToolDefinitions` via `getEffectiveAgentToolNames(template, agentState)`; loopAgentSteps test proves per-step expand AND shrink of the offered ToolSet; `tool-executor` rejects still-locked tier tools with `buildUnavailableToolMessage` (lists current available surface, actionable, fail-closed).
- **M1-T5** always-on `## Tool surface` prompt block present when progressiveToolDisclosure is on.

Validation: `bun test agents/__tests__/base2-progressive-tool-disclosure.test.ts` 50/50 pass; `agent-tool-names.test.ts` 3/3; `agents` + `packages/agent-runtime` typecheck clean.

PLAN checkboxes M1-T3/T4/T5 and the two open M1-T7 test bullets marked done. Next checkpoint unchanged: M1 default-on still **blocked until AC-A1** (gate e2e + buffbench subset or fixed smoke set, no worse than baseline). M2/M3/M4 remain pending.

<!-- update_plan_status:appended -->

## Smoke set + M4 baselines — 2026-08-04 — 2026-08-04T23:20:04.488Z

## Smoke set + M4 baselines — 2026-08-04

Context: after M4 landed (lean proactive inject), the fixed smoke set that gates any M1/M2 default-on is now recorded. All commands were run inside this session against the working tree at snapshot v3:34e577b5d0f3f5.

| ID  | Task                        | Command                                                          | Result                                      |
| --- | --------------------------- | ---------------------------------------------------------------- | ------------------------------------------- |
| S1  | Gate lifecycle e2e          | `bun test agents/e2e/gate-lifecycle.e2e.test.ts`                 | 3 pass / 0 fail                             |
| S2  | Gate aux ordering e2e       | `bun test agents/e2e/gate-aux-ordering.e2e.test.ts`              | 14 pass / 0 fail                            |
| S3  | Progressive disclosure unit | `bun test agents/__tests__/base2-progressive-disclosure.test.ts` | part of 61/61 combined with S4              |
| S4  | Context budget tools unit   | `bun test agents/__tests__/base2-context-budget.test.ts`         | part of 61/61 combined with S3              |
| S5  | Optional buffbench subset   | document eval id + runner when used                              | deferred until the first default-on attempt |

## Follow-up fixes (post-M4)

The M4 code-reviewer pass returned `NON_BLOCKING` with two advisory findings; both are deferred for follow-up without re-arming the gate:

- **NF-1 (prompt/payload mismatch):** `EXPLORE_PROMPT` in `agents/base2/base2.ts` still tells consuming subagents to "deduplicate its candidates, matchedSnippets, and relatedFiles", but the M4 compact envelope deliberately drops those fields from the proactive route note. Reconcile the wording (or note the fields come from the live query_index tool, not the injected note).
- **NF-2 (persisted `result` never re-read):** `toCompactProactiveRetrievalResult` returns `[{ type:'json', value }]` and the hit path yields only the route-note string; the stored `proactiveRetrievalCache.result` is asserted only by tests. Either consume `.result` on a cache hit or drop the persisted body if it is genuinely unused.

Both findings are advisory; the gate passed with full validation and six satisfied requirement-coverages (serialization self-containment, cache contract, cache-hit semantics, regex safety, over-tightening check for broad/audit prompts, and regression-test presence).

<!-- update_plan_status:appended -->

## NF-1/NF-2 resolved — 2026-08-04 — 2026-08-05T00:38:00.947Z

Both M4 reviewer advisories fixed and locally validated (agents suites: base2 198/198, general-agent 7/7):

- **NF-1:** `EXPLORE_PROMPT` now says "deduplicate its candidates by path, score, reason, and kind" — matching the compact proactive envelope's surviving fields instead of dropped `relatedFiles`/`matchedSnippets`.
- **NF-2:** cache-HIT route note now embeds `cachedProactiveRetrieval.result` (compact envelope) alongside the route metadata, so the persisted envelope is genuinely consumed rather than write-only. Defensive fallback omits the suffix when the entry is somehow absent.
- **Scope correction:** an attempted M4 mirror of the classifier onto `general-agent`'s `shouldProactivelyQueryIndex` (M4-T2) broke 3 audit-loop tests (audit prompts began firing query_index first, shifting the expected yield sequence). The file was reverted to HEAD; the mirror is re-queued as its own scoped change with test updates if pursued.
- Gate: hooks green on `agents/base2/base2.ts` + `agents/__tests__/base2.test.ts` (+ session artifacts); reviewer pass returned LOOKS_GOOD on the NF-1/NF-2 scope; deliverables committed as `77f403b`.

## AC-A1 evaluation + M2 default-on flip — 2026-08-05

Pre-flip smoke baselines (S1–S4) were recorded on the pre-flip tree; the M2 default-on flip was then applied (`DEFAULT_PROGRESSIVE_PROMPT_DISCLOSURE = true`, resolver = `option ?? (envCanary || default)`) and the same suites re-run.

Post-flip vs. baseline:

| Suite                              | Baseline                                | Post-flip                                                                  | Verdict  |
| ---------------------------------- | --------------------------------------- | -------------------------------------------------------------------------- | -------- |
| S1 gate-lifecycle e2e              | 3/3                                     | 3/3 (17/17 combined with S2)                                               | no worse |
| S2 gate-aux-ordering e2e           | 14/14                                   | 14/14 (combined above)                                                     | no worse |
| S3 progressive-disclosure unit     | 9/9                                     | 9/9 (3 assertions realigned to default-on contract, equal strength)        | no worse |
| S4 tool-tier + context-budget unit | 52/52 (61/61 combined with S3 pre-flip) | 52/52                                                                      | no worse |
| base2.test.ts (regression net)     | 137/137                                 | 137/137 (2 stale verbatim-prompt assertions moved to explicit-off surface) | no worse |
| agents typecheck                   | clean                                   | clean                                                                      | no worse |

AC4 metric confirmed post-flip by `scripts/measure-context-baseline.ts`: authored surface 15,290 -> 11,288 tok (-4,002, 26.2% >= 25% target). Caveat: the script's `Default fixed (prod)` line (48,034 tok) is unchanged because it measures the raw system template with unreplaced placeholders; the disclosure saving flows only through production runtime assembly (known SPEC open item #3 measurement gap).

AC-A1 **satisfied for the prompt-disclosure flip**: no suite is worse than its recorded baseline. The M2 flip is ready to gate and commit.

<!-- update_plan_status:appended -->

## Deliverables committed — 2026-08-05 — 2026-08-05T02:59:40.287Z

H1 landed on `77f403b0110da31acff3b3e6b18db509bf44d8fa` (`feat(base2): tier model-visible tools by phase + slim proactive retrieval`, +3004/−129 across 14 files). M1 (progressive tool disclosure) and M4 (lean proactive inject) shipped; NF-1/NF-2 follow-ups resolved; session artifacts committed. The branch is ahead 1 of origin; no push was requested or performed.

**Still outstanding:** M2 default-on for progressive prompt disclosure is blocked on AC-A1 smoke evidence (S1–S4 commands + pre-flip baselines not yet recorded in STATUS.md). That is the only remaining commitment-gate item.

<!-- update_plan_status:appended -->

## AC-A1 pre-flip smoke baselines — 2026-08-05 — 2026-08-05T06:02:55.271Z

## AC-A1 pre-flip smoke baselines — 2026-08-05

Recorded against HEAD `77f403b` (post-M1/M4, disclosure default OFF — the M2 flip candidate). All ran on this tree.

| ID  | Task                        | Command                                                                                                | Pre-flip result                                                                                      |
| --- | --------------------------- | ------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| S1  | Gate lifecycle e2e          | `bun test agents/e2e/gate-lifecycle.e2e.test.ts`                                                       | **3 pass / 0 fail** (3 gate events visible: blocked→awaiting_review→final_response_allowed per test) |
| S2  | Gate aux ordering e2e       | `bun test agents/e2e/gate-aux-ordering.e2e.test.ts`                                                    | **14 pass / 0 fail**                                                                                 |
| S3  | Progressive disclosure unit | `bun test agents/__tests__/base2-progressive-disclosure.test.ts`                                       | **9 pass / 0 fail**                                                                                  |
| S4  | Context budget tools unit   | `bun test agents/__tests__/base2-context-budget.test.ts` + `base2-progressive-tool-disclosure.test.ts` | **52 pass / 0 fail** (combined)                                                                      |
| S5  | buffbench subset            | (none wired)                                                                                           | deferred — no default-on attempt yet                                                                 |

AC-A1 rule: M2 default-on is acceptable only if the post-flip runs match these results on the same tree.

<!-- update_plan_status:appended -->

## M3 tree/knowledge reductions — 2026-08-05 — 2026-08-05T10:11:05.319Z

M3-T1..T4 landed (AC-A1 for M2 already satisfied).

**Code**

- `FILE_TREE_PROMPT_SMALL` budget **2_500 → 1_750** (`packages/agent-runtime/src/templates/strings.ts`).
- Agent-mode truncation **preferPathOnly** (`truncate-file-tree.ts` + `getProjectFileTreePrompt` passes `preferPathOnly: mode === 'agent'`); search/LARGE unchanged (symbol-rich).
- Static `knowledgeFilesPrompt` shrunk to short blurb + pointer; full essay at `agents/guides/knowledge-files.md`. Root knowledge **contents** injection unchanged.
- Baseline script `FILE_TREE_SMALL_BUDGET = 1_750` + comments.

**Validation**

- `bun test` truncate-file-tree + prompts-ledger: **10/10 pass**
- `packages/agent-runtime` typecheck: clean
- `bun run scripts/measure-context-baseline.ts`:
  - File tree SMALL (1750 budget): **1,773** tok (was ~2.0k @ 2500)
  - Knowledge instruction static: **99** tok (was ~1,036)
  - Default fixed (prod, SMALL, no proactive): **46,808** tok (session-dependent git still inflates)

**Next:** gate this M3 diff; optional commit after GATE: PASSED. M5 schema diet / M1 tool default-on still separate.

<!-- update_plan_status:appended -->

## Resume 2026-08-05 — continue open plan — 2026-08-05T17:37:42.619Z

Resumed context-baseline-25k. Verified live tree:

- M1 canary surface (tool tiers + unlock + locked-tool path + Tool surface prompt): landed earlier; default-on still blocked on AC-A1 for tools (prompt AC-A1 already satisfied for M2).
- M2 progressive prompt disclosure default-on: committed `71eb68b44`.
- M3 cheaper SMALL tree (1750) + knowledge blurb: committed `9ce22c079`.
- M4 lean proactive: committed in `77f403b01` + NF-1/NF-2 follow-ups.

PLAN checkboxes were stale; syncing done markers. Next implementation: **M5 schema/description diet** (rank CORE tools, shorten top descriptions, keep core ≤12k), then M6 history hygiene polish and remaining X-T docs if needed.

<!-- update_plan_status:appended -->

## M5-T1 ranking — 2026-08-05 — 2026-08-05T17:44:16.775Z

Measured via `scripts/rank-core-tool-tokens.ts` (new):

| Metric                  |     Tokens |
| ----------------------- | ---------: |
| CORE total              | **14,183** |
| progressive core-only   | **14,183** |
| full surface (33 tools) | **23,598** |
| AC-F2 core target       |    ≤12,000 |

Top CORE costs: read_files 3002, spawn_agents 2876, query_index 1219, ask_user 1078, check_job 954, check_background_agent 936, suggest_followups 754, write_todos 627, list_jobs 569, glob 549.

Next: M5-T2 shorten top CORE tool descriptions (~2.5–4k savings needed).

<!-- update_plan_status:appended -->

## M5 schema diet complete — 2026-08-05 — 2026-08-05T17:46:34.460Z

M5-T1 ranking + M5-T2/T3 description diet landed.

**Token budget (scripts/rank-core-tool-tokens.ts):**
| Metric | Before | After |
|---|---:|---:|
| CORE / progressive core-only | 14,183 | **9,680** (AC-F2 ≤12k met) |
| Full surface (33 tools) | 23,598 | **19,095** (≤25k still met) |

**Edits:** shortened model-facing `description` prose on top CORE tools under `common/src/tools/params/tool/` (read_files, spawn_agents, query_index, ask_user, check_job, check_background_agent, suggest_followups, write_todos, list_jobs, glob, read_subtree, read_logs). Ranking helper: `scripts/rank-core-tool-tokens.ts`.

**Validation (local):**

- `bun test` coerce-to-array + base2-progressive-tool-disclosure + base2-context-budget: green (core-only <12k assertion pass)
- `cd common && bun run typecheck`: clean

**M6 quick check:** `tool-result-lifecycle.ts` already tags `query_index` as VERBOSE + normal importance (not pinned/high); spawn tools stay high. M6-T1 largely already satisfied; residual M6-T2/T3 optional polish only.

**Still open on this plan:** M1 tool default-on (AC-A1 for tools), M5 default-on N/A (diet is always-on), optional M6 polish, X-T docs for tool tiers + schema diet.

<!-- update_plan_status:appended -->

## M5 security review cleared — 2026-08-05T17:59:42.118Z

Snapshot-bound security-reviewer returned LOOKS_GOOD (receipt 0xRtSQH7XPo / snapshot v3:8b8a8c283b248aeb571eb42f715cc448ac9d77f39c473a974eb8ecdeb6eb1db5). Coverage covered; no findingIds. Pending files: rank script + 12 CORE tool description diets. Local checks earlier: coreTotal 9680 (≤12k), 138+8 tests pass, common typecheck clean. Ending turn for automated hooks+reviewer gate.
