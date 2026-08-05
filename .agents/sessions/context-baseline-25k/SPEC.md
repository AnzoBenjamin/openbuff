# Context Baseline 25–30k — SPEC

Status: ready
Session: context-baseline-25k
Owner: orchestrator (Buffy)
Created: 2026-08-04
Predecessor: `.agents/sessions/context-budget-architecture-2026-08/` (M0–M6 largely complete)

## Problem statement

The model context window fills quickly. Cost lives in two pools; the prior architecture session instrumented and partially reduced both, but **fixed per-turn overhead remains ~40–50k** on this repo before useful conversation work.

### Measured baseline (openbuff repo, 2026-08-04)

From `bun run scripts/measure-context-baseline.ts` (gpt-tokenizer + 1.35× Anthropic fudge):

| Component | Tokens | Notes |
|---|---:|---|
| Tool definitions (33 base2 tools) | **23,506** | Dominant fixed cost; regression cap 25k in `agents/__tests__/base2-context-budget.test.ts` |
| base2 systemPrompt (raw template) | **11,612** | Placeholders not expanded |
| File tree @ 10k budget | **9,126** | **Overstates default base2** — production uses `FILE_TREE_PROMPT_SMALL` (2.5k) |
| Knowledge files instruction (static) | 1,036 | Always-on “how to write knowledge” |
| System info / git / patterns / language | ~1.5k | Small |
| Proactive `query_index` (representative) | ~4.9k | Variable; often every coding turn |
| git_status | ~52 | Cheap; already gated by SDK |

**Script total (incl. 10k tree + injections):** ~51.9k (~27% of 190k).
**Realistic default-mode fixed cost (SMALL tree, no proactive):** ~**40–45k**.

### What already shipped (predecessor session)

- Context budget ledger + `/context` (alias `/ctx`)
- Progressive **prompt** disclosure (`progressivePromptDisclosure`, default **off**; env canary `OPENBUFF_PROGRESSIVE_PROMPT_DISCLOSURE`)
- Proactive retrieval cache + workspace revision + index mutation epoch invalidation
- Git observation gating (SDK `applyGitStatusGate`)
- Model-aware semantic compaction before mechanical 190k brake
- Tool-result lifecycle tagging / keep-N policy

### What is still open (this program)

1. **Tool schemas never tiered** — full ~23.5k every request
2. **Progressive prompt disclosure not default-on**
3. **Measurement overstates tree** — script measures 10k path; production SMALL unmeasured in “default fixed” line
4. **Proactive envelope still fat** on first miss (~5k + cross-subsystem extras)
5. **Knowledge essay** always-on (~1k)
6. Gate-critical text mixed with relocatable advisory bulk (M4 flag off keeps everything inline)

## Goals

- **G1.** Cut default-mode **fixed** baseline (system + tools + small tree + knowledge + profiles; **exclude** proactive) from ~40–45k to **≤30k**, stretch **≤25k**.
- **G2.** Progressive **tool** disclosure: core tools always registered; implement/audit/media tiers unlock deterministically without weakening the gate.
- **G3.** Default-on progressive **prompt** disclosure with gate text remaining fully inline.
- **G4.** Cheaper always-on project context (path-biased small tree + short knowledge blurb).
- **G5.** Lean proactive inject (tighter classifier + compact envelope); full envelope only on explicit `query_index`.
- **G6.** Optional schema/description diet on CORE tools.
- **G7.** Production-faithful measurement so claims are provable via the baseline script and `/context`.
- **G8.** No silent ability regression on default-on flips: gate e2e plus buffbench subset or fixed smoke tasks must be no worse than the pre-flip baseline recorded in STATUS.

## Non-goals

- Not changing provider/model routing or BYOK architecture.
- Not rewriting context-pruner summarization heuristics beyond wiring already done.
- Not altering the deterministic edit / read-capability system.
- **Not weakening the reviewer/validation gate contract** (hooks → automated reviewer; basher / `run_targeted_validation` remain optional evidence only).
- Not removing programmatic tools required by `handleSteps` (`spawn_agent_inline`, `git_status`, `run_file_change_hooks`, `inspect_codebase_structure`).
- No new third-party dependencies.
- Not counting proactive inject as part of the fixed 25–30k target (report fixed vs first-turn separately).
- Not hard-gating requests that exceed per-component budgets (ledger remains advisory unless a later program decides otherwise).

## Gate invariants (non-negotiable)

Any optimization MUST preserve:

1. **Runtime owns the gate** — on turn end, hooks then automated code-reviewer; model does not “run” the gate.
2. **Pinned authority** — `GATE: PENDING | PASSED`, `pendingGateFiles`, fail-closed repair loops.
3. **What is not the gate** — basher typecheck/test/lint and `run_targeted_validation` are optional evidence only; they do not unlock `git-committer`.
4. **Withholds while PENDING** — `suggest_followups` rejected; `git-committer` withheld; no manual code-reviewer re-spawn for the same pending set.
5. **Re-arm on edit** — any new mutation returns to PENDING.
6. **Programmatic tools stay available** to `handleSteps` even if model-facing `toolNames` shrink.

**Always-on inline (never guide-only):**

- Full `gateAwarenessSection` (`agents/base2/quality-prompt-section.ts`)
- Minimal harness recovery: end turn when GATE PENDING; do not treat typecheck as gate

**OK to relocate / lazy-load:** craftsmanship, git discipline detail, security pre-edit procedure, specialist catalog, broad-audit procedure, fat schemas for rare tools, full file tree, full knowledge essay.

## Requirements

### R0 — Measurement lock

- Extend `scripts/measure-context-baseline.ts` to report:
  - `FILE_TREE_PROMPT_SMALL` (2.5k) and full (10k) separately
  - progressive prompt disclosure off vs on (authored surface)
  - tool tiers once defined (core vs full)
  - a single **“default base2 assembled fixed”** line matching production placeholders
- Soft CI targets: phase-1 fixed ≤ 32k; phase-2 ≤ 28k; program target ≤ 30k / stretch 25k
- `/context` categories remain accurate (`tools`, `fileTree`, `system`, etc.)

### R1 — Progressive tool disclosure

- Define tiers in a single source of truth (e.g. `agents/base2/tool-tiers.ts`):
  - **CORE** — discovery/orchestration always model-visible
  - **IMPLEMENT** — edit/plan/validation helpers when implementation starts
  - **AUDIT** — structure/completeness/coverage tools for broad audits
  - **MEDIA_3D** — image/3d tools when media paths appear
  - **JOB_EXTRA** — e.g. `kill_job` as needed
- Wire `createBase2` `toolNames` from tiers + mode (`planOnly` / `fast` / `executePlan` gates preserved).
- Only unlocked tools enter provider ToolSet / token accounting (`getToolSet` / `run-agent-step`).
- Locked tool call → actionable error (or one-shot deterministic unlock) — no silent no-op.
- Prefer **deterministic unlock from `handleSteps`** (classifier + phase) over free-form model `enable_tools`.
- `programmaticToolNames` unchanged.
- Short always-on prompt block describing tool surface / unlock rules.
- Flags: canary `OPENBUFF_PROGRESSIVE_TOOL_DISCLOSURE`; explicit option on `createBase2`; safe default until proven.

### R2 — Default-on progressive prompt disclosure

- Ship M4 behavior default **on** (or env default on) after canary.
- Relocate: quality, git discipline, security review, specialist routing, broad-audit (existing guides under `agents/guides/*`).
- Optionally second wave: compress long spawning/examples; shrink `knowledgeFilesPrompt` to ~150 tok + guide.
- Mode-thin instructions: conversation-only / plan / default / fast as specified in PLAN.
- Keep ≥25% authored-surface reduction test (`agents/__tests__/base2-progressive-disclosure.test.ts`).

### R3 — Cheaper project context

- Default orchestrator tree budget **1,500–2,000** (from 2,500 SMALL); path-oriented / symbol-stripped earlier.
- On-demand full tree via tools or LARGE placeholder for search agents only.
- Shrink static knowledge instruction; keep root knowledge **contents**.

### R4 — Lean proactive inject

- Tighten `classifyProactiveRetrieval`: stronger intent; no fire on bare generic words alone; Q&A without edit intent skips proactive.
- Lower limits: unknown ~8, multi-file ~12, cross-subsystem ~16 (from 14/24/30).
- Compact proactive envelope (paths, scores, top symbols, snapshotId; omit fat `status.coverage` / long explanations). Target **&lt;1.5k** tokens when fired.
- Defer or summarize cross-subsystem `inspect_codebase_structure` + root `list_directory` extras.
- Do not pin proactive results; lifecycle normal importance.

### R5 — Schema / description diet (optional stack)

- Rank tools by tokens; cap verbose descriptions; leaner Zod→JSON Schema where safe.
- CORE total still ≤ ~12k after diet.

### R6 — History hygiene (non-fixed)

- Tag proactive for aggressive simplify; keep spawn/read bounds; do not put fixed baseline inside history budget (already true).

### R7 — Backward compatibility & docs

- Feature flags with safe rollout (canary → default-on → kill switch).
- Document in `docs/configuration.md`, `docs/environment-variables.md`, `docs/architecture.md` context-budget section.
- Existing gate e2e, context-pruning, and progressive-disclosure tests must keep passing (updated only where behavior intentionally changes).

### R8 — Ability regression bar (hard for default-on)

- Before flipping **M1** (progressive tool disclosure) or **M2** (progressive prompt disclosure) to **default-on**, record evidence in STATUS that satisfies **AC-A1**.
- Gate e2e alone is **necessary but not sufficient** for ability: also run a buffbench subset **or** a fixed smoke task set documented in STATUS.
- Results must be **no worse** than the pre-flip baseline (task success / gate pass rates) recorded in STATUS.
- Canary-only shipping (env flag on for dogfood) does **not** satisfy AC-A1 for a production default flip.

## Acceptance criteria

| ID | Criterion |
|---|---|
| AC-F1 | Default-mode **fixed** baseline ≤ **30k**; stretch ≤ **25k** (no proactive) |
| AC-F2 | Core-only tools ≤ **12k**; full tools ≤ **25k** |
| AC-G1 | Gate e2e suites pass (`gate-lifecycle`, `gate-aux-ordering`, reviewer spawn conditions) |
| AC-G2 | `gateAwarenessSection` still fully inline when progressive prompt is on |
| AC-G3 | Programmatic hooks/git/spawn_inline work with locked model tools |
| AC-P1 | Progressive prompt default-on ≥ **25%** authored reduction |
| AC-R1 | Weak-intent prompts do not proactive-inject; compact proactive &lt; **1.5k** when fired |
| AC-T1 | Baseline script reports production-faithful default fixed line |
| AC-C1 | `/context` reflects tool tiers and tree budget after changes |
| AC-A1 | Before flipping M1 or M2 to **default-on**, run (a) full gate e2e suite **and** (b) either a buffbench subset or a fixed smoke task set documented in STATUS; results must be **no worse than the pre-flip baseline** recorded in STATUS (task success / gate pass rates). Canary-only shipping does not satisfy AC-A1. |

## Relevant systems (exact files)

- `agents/base2/base2.ts` — `toolNames`, `programmaticToolNames`, progressive disclosure, `classifyProactiveRetrieval`, proactive yield/cache
- `agents/base2/quality-prompt-section.ts` — gate + relocatable sections
- `agents/guides/*` — on-demand prompt guides
- `agents/__tests__/base2-progressive-disclosure.test.ts`, `base2-context-budget.test.ts`
- `agents/e2e/gate-lifecycle.e2e.test.ts`, `gate-aux-ordering.e2e.test.ts`, reviewer-spawn e2e
- `packages/agent-runtime/src/run-agent-step.ts` — ledger, tools, system prompt assembly
- `packages/agent-runtime/src/tools/prompts.ts`, `tool-executor.ts` — ToolSet / locked-tool behavior
- `packages/agent-runtime/src/templates/strings.ts` — `FILE_TREE_PROMPT_SMALL` (2.5k), LARGE, placeholders
- `packages/agent-runtime/src/system-prompt/prompts.ts`, `truncate-file-tree.ts`
- `packages/agent-runtime/src/util/context-budget.ts`, `context-pruning.ts`, `tool-result-lifecycle.ts`, `token-counter.ts`
- `scripts/measure-context-baseline.ts`
- `cli/src/commands/context.ts`
- `common/src/tools/list.ts` — tool schemas
- `docs/configuration.md`, `docs/environment-variables.md`, `docs/architecture.md`
- Predecessor: `.agents/sessions/context-budget-architecture-2026-08/{SPEC,PLAN,STATUS}.md`

## Key interfaces (pseudo-code)

```ts
// agents/base2/tool-tiers.ts (NEW)
export const CORE_TOOLS = [/* spawn_agents, query_index, read_*, list_directory, glob, ask_user, skill, jobs minimal, ... */] as const
export const IMPLEMENT_TOOLS = [/* edit_transaction, create_plan, update_plan_status, inspect_*, get_affected_tests, run_targeted_validation, ... */] as const
export const AUDIT_TOOLS = [/* inspect_codebase_structure, inspect_feature_completeness, evaluate_audit_coverage, get_change_review_bundle, get_task */] as const
export const MEDIA_3D_TOOLS = [/* read_image, inspect_3d_asset, render_3d_preview, edit_3d_asset */] as const

export type ToolTier = 'core' | 'implement' | 'audit' | 'media_3d' | 'job_extra'
export function resolveModelToolNames(params: {
  mode: 'default' | 'fast'
  planOnly?: boolean
  executePlan?: boolean
  unlockedTiers: ToolTier[]
}): string[]

// agent state (additive)
// unlockedToolTiers?: ToolTier[]
// progressiveToolDisclosure?: boolean

// proactive compact envelope (proactive path only)
// { kind: 'query_index_result_compact', results: [{ path, score, topSymbols?, reason? }], totalIndexed, indexAge, snapshotId }
```

## Token budget math (how to hit 25–30k)

| Workstream | Est. save | Mechanism |
|---|---:|---|
| Progressive tool disclosure | **12–16k** | Core ~12–15 tools always; rest on demand |
| Default progressive prompt disclosure | **3–5k** | M4 flag on; gate text inline |
| Cheaper tree + knowledge | **1–3k** | 1.5–2k tree; short knowledge blurb |
| Lean proactive | **2–4k/firing** | Classifier + compact envelope (variable) |
| Schema diet | **1–3k** | Shorter CORE schemas |

Stack: ~42k realistic fixed − 14k tools − 4k prompt − 2k tree/knowledge ≈ **22–26k** fixed.

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| Model cannot find locked tool | Deterministic phase unlock + clear error |
| Hidden craftsmanship/git rules | Trigger pointers; canary; **AC-A1** buffbench/smoke before default-on |
| Prompt-cache thrash on tool unlock | Unlock once per phase; stabilize CORE all session |
| Audit quality drop from lean proactive | Full envelope on explicit tool; structure when audit confirmed |
| Gate weakened by thinner prompts | Never relocate `gateAwarenessSection`; gate e2e is merge bar |
| Ability regression on default-on flips | **AC-A1** hard bar: gate e2e + buffbench/smoke no worse than STATUS baseline |
| Measuring wrong tree budget | R0 production-faithful script |
| e2e asserting full tool list | Update only intentional assertions; keep gate semantics |

## Out of scope (future)

- Hard per-component request refusal over budget
- Embedding-based retrieval dedup
- Cross-session budget persistence
- Removing the automated reviewer to save tokens

## Related reading

- Predecessor session STATUS (completed architecture work)
- `docs/configuration.md` — Context budget and proactive retrieval
- `docs/architecture.md` — Context budget, retrieval caching, git observation gating
