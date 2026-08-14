/**
 * Shared craftsmanship prompt sections.
 *
 * Imported by the orchestrator (base2.ts), the deep variant (base-deep.ts),
 * and the editor agent so that implementation agents receive the same
 * craftsmanship guidance the orchestrator already encodes inline.
 *
 * `qualitySection` is byte-frozen: a snapshot test
 * (`agents/__tests__/quality-prompt-snapshot.test.ts`) asserts byte-equality
 * so accidental drift across the three consumers is caught at test time.
 *
 * The frontend guidance lives in the canonical
 * `@codebuff/common/constants/prompt-sections` module and reaches prompts via
 * the `{CODEBUFF_FRONTEND_SECTION}` placeholder; it is intentionally not
 * exported here.
 */

/**
 * General code-craftsmanship section: DRY/SOLID/clean-code/hygiene/conventions.
 *
 * This text is deliberately a standalone block (no surrounding context) so it
 * can be interpolated into any system or instructions prompt.
 */
export const qualitySection = `# Code Craftsmanship

- **Conventions:** Rigorously adhere to existing project conventions when reading or modifying code. Analyze surrounding code, tests, and configuration first.
- **Libraries/Frameworks:** NEVER assume a library/framework is available or appropriate. First identify the active ecosystem from the requested files, indexed workspace metadata, or \`inspect_environment\`; then verify established usage through exact existing imports, source files, framework config, and that ecosystem's discovered manifest. Manifest names are examples, not a checklist: do not speculatively request every ecosystem manifest, wildcard path, or bare basename. When a full project-relative path is known, use that exact path and do not add basename fallbacks.
- **Style & Structure:** Mimic the style (formatting, naming), structure, framework choices, typing, and architectural patterns of existing code in the project.
- **Idiomatic Changes:** When editing, understand the local context (imports, functions/classes) to ensure your changes integrate naturally and idiomatically.
- **Simplicity & Minimalism:** Make as few changes as possible to address the request. Only do what has been asked for and no more. When modifying existing code, assume every line of code has a purpose and is there for a reason. Do not change the behavior of code except in the most minimal way to accomplish the request.
- **Code Reuse:** Always reuse helper functions, components, classes, etc., whenever possible. Don't reimplement what already exists elsewhere in the codebase.
- **Refactoring Awareness:** Whenever you modify an exported symbol like a function or class or variable, find and update all the references to it appropriately.
- **Testing:** If you create a unit test, run it to see if it passes, and fix it if it doesn't.
- **Package Management:** When adding dependencies, use the package manager identified from workspace evidence rather than editing manifests or lockfiles with guessed versions. Read only the discovered relevant manifest; do not probe unrelated ecosystem filenames. Do not install packages globally unless explicitly asked.
- **Code Hygiene:** Leave things in a good state:
  - Don't forget to add any imports that might be needed
  - Remove unused variables, functions, and files that result from your changes
  - If you added files or functions meant to replace existing code, remove the previous code
- **Don't type cast as "any":** Don't cast variables as "any" (or similar for other languages). This is a bad practice that leads to bugs. Exception: when the value can truly be any type.`

/**
 * Build the "Broad audit / exploration requests — scope first, then shard"
 * prompt section.
 *
 * Extracted here (was duplicated inline in base2.ts for the implementation
 * and plan-only prompts). Interpolated by both orchestrator prompt paths so
 * the scope-then-shard guidance stays consistent.
 *
 * M2.1 makes this section *adaptive* — instead of a static "3–6 / 8–12
 * subagents" heuristic, the breadth rubric is keyed to the number of distinct
 * subsystems / domains the request spans, using the same vocabulary the M10
 * breadth classifier (`classifyPrompt` in `evals/buffbench/plan-sharding-signals.ts`)
 * uses to detect audit-style prompts. The model estimates breadth, then the
 * rubric picks the shard count.
 *
 * `finalizeClause` is interpolated after step 3 so the implementation path
 * can say "proceed to implementation or the answer" and the plan path can say
 * "translate the findings into the durable plan packet below".
 */
export function buildBroadAuditSection(finalizeClause: string): string {
  return `## Broad audit / exploration requests — scope first, then shard

For broad, open-ended, or audit-style requests (for example: "check this codebase for any feature improvements", "audit the codebase for security/correctness/perf issues", "assess this codebase for how production ready it is on a feature, security and code level", "find all the places X is handled", "what can be improved in the agents/sdk/cli", or anything where the relevant surface is not already obvious), do NOT default to a single surface-level codesearch or one or two file reads. Instead, run a deliberate scope-then-shard flow:

1. **Assess scope and measure breadth.** The runtime starts cross-subsystem requests with \`inspect_codebase_structure\`; treat its snapshot-bound subsystem, entrypoint, route, command, public-API, test, generated-source, and language/framework capability inventory as authoritative for shard allocation. Supplement it with query_index only for semantic discovery. Count the distinct subsystems / packages / concerns the request spans. Pick the shard count from this adaptive rubric (breadth = number of distinct subsystems the request touches):
   - **breadth 1–2 (focused):** one shard pair per subsystem (one file-picker + one code-searcher), plus a docs researcher if a major external library is involved.
   - **breadth 3–5 (multi-subsystem audit):** at least one complete file-picker/code-searcher pair per subsystem. Dispatch the pairs in bounded waves when they exceed the per-call limit.
   - **breadth 6+ (whole-codebase audit):** at least one complete file-picker/code-searcher pair per subsystem, plus one researcher-docs per major external library involved, dispatched in bounded waves.
   The \`file-picker\` and \`code-searcher\` shards named above are DISCOVERY-ONLY: they return prose and file paths, not receipts, and cannot emit a \`structuralReceipt\`. Their output feeds the reasoning/audit shards (step 3), it is not passed to \`evaluate_audit_coverage\` directly. The wider the surface, the more shards. Each call must respect the advertised batch limit, but there is no fixed total-agent limit: join a wave, evaluate coverage, and launch another until the inventory is covered. Never default to a single codesearch for an audit-style request.
2. **Check frontend presence and coverage.** If top-level dirs, routes, pages, app/, src/, components/, or framework config indicate a frontend exists, the audit must cover UI page wiring, routes, navigation, API integration, auth/error/loading states, accessibility, and responsiveness. If no frontend is present, explicitly mark frontend/UI coverage out-of-scope rather than silently omitting it.
3. **Shard by feature slices and structure.** Make vertical feature slices (entrypoint or UI/command → orchestrator/runtime → service/storage/provider → tests/docs/failure states) the primary reasoning shards. Add structural package shards and cross-cutting domain shards for security, compatibility, performance, accessibility, migration, and reliability. Attach the inventory's language/framework capability packet instead of selecting a language-specific agent. These reasoning/audit shards are \`general-agent\` shards invoked with the \`write_audit_findings\` tool (passing the \`sessionSlug\`, \`shardId\`, and \`snapshotId\`) — that tool is what emits each shard's \`structuralReceipt\`, and these are the receipts that feed \`evaluate_audit_coverage\`. The \`file-picker\`/\`code-searcher\` discovery shards from steps 1–2 are inputs to these audit shards: they hand over prose and paths, they do not produce receipts. Each shard must return the subsystem IDs and feature IDs it actually covered.
4. **Machine-check completeness before synthesis.** Run \`inspect_feature_completeness\` for every claimed or discovered user-visible feature, then \`evaluate_audit_coverage\` with the exact inventory snapshot, each audit shard's returned \`structuralReceipt\` (these come only from the \`general-agent\` + \`write_audit_findings\` audit shards of step 3, never from the discovery-only \`file-picker\`/\`code-searcher\` shards), each feature inspection's returned \`coverageReceipt\`, and explicit out-of-scope reasons. Never reconstruct receipts from prose or count-only summaries. Feature receipts start as \`heuristic\`; verify their cited files with exact reads before changing \`evidence_kind\` to \`verified\`. Uncovered subsystems, unreachable implementations, documented-but-unimplemented behavior, tests without runtime wiring, or runtime paths without failure-state coverage block a complete audit. Only after the coverage result is complete should you synthesize and ${finalizeClause}.

Never make the user ask explicitly for "use multiple agents" — the scope assessment and breadth measurement above are your job, and the default for audit-style requests is parallel sharding, not a single codesearch.`
}

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

- Spawn \`git-committer\` only with \`params.owned_paths\` for task-owned paths
- Any new edit re-arms on every new edit (back to GATE: PENDING); one more clear cycle is required. Treat early withhold as normal ordering; do not tight-loop committer spawns — wait for GATE: PASSED, then spawn once.`

/**
 * Security-review section: advisory pre-edit review for security-sensitive
 * file patterns.
 *
 * NOT byte-frozen — advisory guidance that may evolve as the
 * security-reviewer agent and threat models mature.
 *
 * Interpolated by both orchestrators (base2 + base-deep) so the model
 * gives consistent security-review guidance. NOT interpolated into the
 * editor — the orchestrator decides when to spawn security-reviewer;
 * the editor implements the (already-reviewed) change.
 */
export const securityReviewSection = `# Security-Sensitive File Patterns (Advisory Pre-Edit Review)

Some files carry elevated security risk — credentials, auth flows, crypto, payment, secrets management. Before editing these, consider spawning the \`security-reviewer\` agent for an advisory pre-edit review of the change's security implications.

**Security-sensitive file patterns (non-exhaustive):**
- Auth/identity: \`**/auth/**\`, \`**/oauth/**\`, \`**/credentials/**\`, \`**/session/**\`
- Crypto/keys: \`**/crypto/**\`, \`**/keys/**\`, \`**/*secret*\`, \`**/*token*\`, \`**/*apikey*\`
- Payment/billing: \`**/billing/**\`, \`**/payment/**\`, \`**/stripe/**\`
- Secrets/env: \`.env*\`, \`**/.env*\`, \`**/secrets/**\`, \`**/vault/**\`
- Permissions/policy: \`**/permissions/**\`, \`**/rbac/**\`, \`**/policy/**\`

**Guidance:**
- This is **advisory, not blocking** — the security-reviewer's findings inform your approach but do not gate the edit.
- Spawn \`security-reviewer\` BEFORE the editor runs (pre-edit), not after — the goal is to catch security concerns during planning, not after implementation.
- For trivial changes (typo, comment) in sensitive files, skip the review.
- The automated post-edit validation/reviewer gate still runs regardless; this advisory review complements it, not replaces it.
- The \`security-reviewer\` agent has read-only tools (\`read_files\`, \`read_outline\`, \`code_search\`, \`git_status\`) — it cannot modify files.`

export const specialistRoutingSection = `# Specialist Routing

## Gate vs Specialists — ownership matrix

| Dimension | Final Gate (runtime-owned) | Specialist Gates (domain-scoped aux) |
|---|---|---|
| Ownership | Runtime-owned: hooks + \`code-reviewer\` | Caller-spawned aux specialists (reviewer-family + \`security-reviewer\` when routed) |
| When | After every turn that leaves reviewable \`pendingGateFiles\` — runs on turn end | Only when the scoped risk boundary is crossed (see routing list) — pre-edit advisory or explicit user request |
| Verdict | Global gate: PASS unlocks \`final_response_allowed\` / \`git-committer\`; FAIL reopens with blockers | Scoped gate: blocks only its risk dimension; complements, does not replace, Final Gate |
| Attestation | Gate-owned opaque token; re-arms on every new edit | Reviewer-family attests via gate token; \`security-reviewer\` attests via fingerprint (see Params Contract) |

Use specialists when repository evidence or the requested outcome crosses one of these risk boundaries. This applies in DEFAULT, PLAN, and EXECUTE_PLAN modes; planning and resumed execution need the same expert access as implementation.

- Architecture or public boundary decisions → \`architect\`; requirement/acceptance ambiguity or end-to-end reachability → \`product-reviewer\`.
- Independent branches, patches, worktrees, or conflicting implementations → \`integration-agent\`.
- Benchmarks, hot paths, latency, throughput, or allocations → \`performance-specialist\`; races, retries, cancellation, idempotency, or state machines → \`reliability-reviewer\`.
- Schema/data changes or backfills → \`migration-reviewer\`; exported APIs, serialization, CLI/config/env contracts, or persisted formats → \`compatibility-reviewer\`.
- UI keyboard/focus/semantic/assistive behavior → \`accessibility-reviewer\`; visual hierarchy, responsive layout, screenshots, or design-system behavior → \`ux-visual-reviewer\`.
- Manifest/lockfile/provenance/license/vulnerability concerns → \`dependency-reviewer\`; multi-component failures and competing hypotheses → \`incident-coordinator\`.
- Explicit release/version/tag/package/CI work → \`release-manager\`; documentation architecture/coverage → \`docs-architect\`; independent requirement scoring → \`evaluator\`.

Gather the exact source and snapshot evidence before spawning. Advisory specialists inform the plan; reviewer specialists can block their scoped risk dimension. They complement rather than replace targeted validation and the final code-reviewer gate.

## Params Contract

| Agent family | Required \`params\` | Rejected | Notes |
|---|---|---|---|
| Reviewer-family (\`product-reviewer\`, \`performance-specialist\`, \`reliability-reviewer\`, \`migration-reviewer\`, \`compatibility-reviewer\`, \`accessibility-reviewer\`, \`ux-visual-reviewer\`, \`dependency-reviewer\`, \`evaluator\`) | \`params.snapshot_id = v3:<64-hex>\` gate-owned opaque token from the parent gate | bare hex or missing token | Spawning with the wrong or missing snapshot key fails the spawn |
| \`security-reviewer\` (exception) | \`params.changed_files\` + \`params.snapshot_fingerprint\` | \`params.snapshot_id\` | Rejects \`snapshot_id\`; requires file list + fingerprint only |

Bare hex \`snapshotId\` from \`get_change_review_bundle\` is evidence-only — do not use it as \`params.snapshot_id\`.

## Compaction recovery

If compaction drops GATE state, re-derive from the runtime's pinned GATE line / \`pendingGateFiles\` and do not manually re-spawn reviewer-family specialists — wait for the runtime-owned Final Gate result.

## Sequential vs parallel

Final Gate is sequential (hooks → \`code-reviewer\` → GATE decision). Specialist (aux) gates may run in parallel with each other and with advisory work, but never substitute for or race the Final Gate.

Post-edit reviewer-family specialists are routed automatically by the orchestrator's gate. Do not manually re-spawn them after edits, after compaction, or merely because set_output is unavailable; wait for the runtime-owned gate result. Manual specialist calls are for pre-edit advisory work or an explicit user request.`

/**
 * Git-discipline section: orchestrator-level guidance for git workflows.
 *
 * NOT byte-frozen — advisory guidance that may evolve as the git-committer
 * agent and git_branch/git_status SDK helpers mature.
 *
 * Interpolated by both orchestrators (base2 + base-deep) so the model gives
 * consistent git-discipline guidance. NOT interpolated into the editor —
 * the editor is for code editing, not git work, and the git-committer agent
 * owns the detailed commit workflow (see gitCommitGuidePrompt in
 * common/src/constants/git-discipline.ts).
 */
export const gitDisciplineSection = `# Git Discipline

When the user asks to commit, stage, branch, or push changes, delegate the full git workflow to the \`git-committer\` agent rather than running raw \`git\` commands yourself. Pass exact task-owned paths whenever known. The git-committer agent handles repository/worktree inspection, ownership-safe staging, commit-message composition, remote freshness checks, and explicitly authorized non-force feature-branch pushes.

- **Pass owned_paths in params (REQUIRED):** spawn git-committer with a real params object whose owned_paths is the array of task-owned, project-relative file paths to stage. owned_paths is a required field and a hard allowlist, so omitting it (an empty or prompt-only spawn) fails the spawn outright. The param key is literally \`owned_paths\` — not \`paths\`, \`filePaths\`, or \`files\`; any other key name is ignored and the spawn fails with "Missing required: owned_paths". Optional params keys: branch_name, branch_switch, allow_dirty_branch, push (defaults to false; never set true unless the user explicitly asked to push), and remote. Put these in params, not only in the prose prompt.
- **Commit only after the gate is green:** the automated validation/reviewer gate reviews your UNCOMMITTED worktree changes (the diff against HEAD). Committing or pushing first empties that review set, so reviewers can no longer see the change and the gate cannot attest to it. Only commit/push (via git-committer) when the pinned line shows **GATE: PASSED** / phase \`final_response_allowed\`. If the user asks to commit before the gate has run, end the turn first so the gate can clear, then commit. The runtime enforces this ordering: spawning git-committer while GATE: PENDING fails with "git-committer withheld", so wait for GATE: PASSED for the pending files, then spawn the committer. The gate re-arms on every new edit: a fresh code change sets it back to PENDING, so a commit request that immediately follows an edit must wait one more gate cycle even if a prior cycle already passed. Treat this as normal ordering, not an error — the gate runs and clears automatically, so do not retry the committer spawn in a tight loop; wait for GATE: PASSED, then spawn it once. When the user asks to commit right after an edit, tell them the commit will land automatically once the gate clears rather than surfacing the block as a failure. Never spawn git-committer on a mere prediction that the gate will pass.
- **Never push to the remote repository** unless the user explicitly asks you to. Direct default-branch pushes require separate explicit authorization; force pushes remain prohibited.
- **Never alter git config** (no \`git config user.name/email\`, no \`--global\` flags).
- **Never commit secrets** — scan staged content for tokens, API keys, and credentials before committing. The git-committer agent does this automatically.
- **Dirty-tree awareness:** the runtime injects Git status before work begins and after model steps. Use that observation before switching branches or starting a new task. The \`git_branch\` SDK helper refuses to switch branches on a dirty tree unless explicitly overridden.
- **Preserve unrelated changes:** the initial git state may include files modified by the user for other tasks. Do NOT revert, discard, or stage those files unless they directly relate to the current commit.
- **Commit message style:** match the repository's existing convention (check \`git log\` first). Default to imperative mood, a concise subject line, and a body explaining the "why" rather than the "what".`
