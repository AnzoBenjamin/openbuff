/**
 * Shared craftsmanship prompt sections.
 *
 * Imported by the orchestrator (base2.ts), the deep variant (base-deep.ts),
 * and the editor agent so that implementation agents receive the same
 * craftsmanship guidance the orchestrator already encodes inline.
 *
 * `qualitySection` is byte-frozen: a snapshot test in
 * `agents/__tests__/quality-prompt-snapshot.test.ts` pins this constant's
 * bytes, so editing the text fails until the snapshot is deliberately updated.
 * That same test file separately asserts, by containment, that each of the
 * three consumers interpolates the constant — which is what keeps the three
 * consumers on identical text.
 *
 * Every relocatable section body now lives in
 * `@codebuff/common/constants/prompt-sections` and is RE-EXPORTED here: the
 * T1.4d guide fallback in `common/src/util/guides.ts` needs those bodies, and
 * `packages/agent-runtime` must not import from `agents/`. Re-exporting keeps
 * every existing consumer's import path unchanged.
 *
 * `gateAwarenessSection` stays authored here: it is deliberately NOT
 * relocatable to a guide, so it needs no fallback body.
 *
 * The frontend guidance lives in the canonical
 * `@codebuff/common/constants/prompt-sections` module and reaches prompts via
 * the `{CODEBUFF_FRONTEND_SECTION}` placeholder; it is intentionally not
 * exported here.
 */

export {
  buildBroadAuditSection,
  gitDisciplineSection,
  preReviewSelfCheckSection,
  qualitySection,
  securityReviewSection,
  specialistRoutingSection,
} from '@codebuff/common/constants/prompt-sections'
export type { BroadAuditFinalizeClause } from '@codebuff/common/constants/prompt-sections'

/**
 * Gate-awareness section: tells the orchestrator the runtime-owned
 * hooks→reviewer sequence, that targeted validation is not the gate, and
 * not to manually re-spawn code-reviewer for the same pending set.
 *
 * NOT byte-frozen — advisory guidance that may evolve with the gate.
 *
 * Interpolated by both base2 (conditionally, default mode only) and base-deep
 * (unconditionally) so both orchestrators give the model the same
 * gate-awareness guidance, avoiding redundant manual code-reviewer spawns
 * and basher/targeted-validation substitutes for the gate.
 */
export const gateAwarenessSection = `# Automated Validation & Review Gate

After you edit files, a runtime gate must clear before finalization.

## States (obey the pinned GATE line only)

- **GATE: PENDING** — finish implementation work, then **end your turn**. Do not finalize.
- **GATE: PASSED** (phase \`final_response_allowed\`) — final summary, followups, and git-committer are allowed.

The pinned GATE line is the only authority. Do not infer pass/fail from basher output, typecheck success, or UI chrome like "Hooks" / "Change review".

## What the gate is

On turn end, the runtime (not you) runs configured file-change hooks, then the automated code-reviewer, then sets GATE: PASSED or reopens with blockers.

You do not start, poll, or wait on that cycle as a separate process. End the turn; the next message already contains the result. In gate-disabled modes (fast / no-validation / plan-only) no automated reviewer runs — still obey the pinned GATE line only.

## What is not the gate

- Basher typecheck / test / lint commands = **local checks** (optional evidence only)
- \`run_targeted_validation\` = optional scoped evidence only (is NOT the gate; does not clear reviewer findings by itself; does **not** unlock \`git-committer\`)
Neither replaces the runtime hooks + automated code-reviewer path.

## Hard blocks while GATE: PENDING

- \`suggest_followups\` — rejected
- \`git-committer\` — withheld until GATE: PASSED
- Manual re-spawn of code-reviewer for the same pending set — do not; the automated gate owns that set. If phase is \`awaiting_validation\` / gate not yet passed, end the turn for the programmatic hooks→reviewer cycle.

## Pending-set authority

The gate covers the full \`pendingGateFiles\` / pending set in active-work state — not only the last file you edited. After multi-file edits, the full related set must clear before commit. The pending list is authoritative over conversational memory.

Dirty working-tree files are not the same as pending: only task-related **reviewable** dirty paths re-arm the gate. Local checks (basher/typecheck) and non-reviewable dirty (docs/session artifacts) do not clear or substitute for pending reviewable work.

## After GATE: PASSED

- Write the final user-visible completion summary first
- Spawn optional \`git-committer\` (with \`params.owned_paths\` for task-owned paths) before followups if committing this turn
- Call \`suggest_followups\` only as the absolute last tool after summary/commit; never mid-turn and never before remaining work
- The gate re-arms on every new edit (back to GATE: PENDING); one more clear cycle is required. Treat early withhold as normal ordering; do not tight-loop committer spawns — wait for GATE: PASSED, then spawn once.`
