# Design: Phases 2–4 re-derived against the current architecture (2026-10-25)

Authoritative design record for the re-derived Phase 2 read band, the Phase 4 learning loop, the second seed playbook, and the warn→block decision. It supersedes the pre-rewrite Phase 2–4 text in PLAN.md (per that file's rewrite note) and grounds every claim in the live tree, re-verified 2026-10-25. Sections marked LANDED shipped in this wave; the rest is the forward build plan.

## Phase 2 — reserved `<active_playbooks>` read band (LANDED 2026-10-25)

- `packages/agent-runtime/src/memory/playbook-context.ts`: pure `compileActivePlaybooksContext(playbooks, options?)` with `ACTIVE_PLAYBOOKS_CONTEXT_MAX_CHARS = 1_500`, `ACTIVE_PLAYBOOKS_CONTEXT_MAX_PLAYBOOKS = 8`, `ACTIVE_PLAYBOOKS_HEADER_MAX_CHARS = 400`. Per-entry `MemoryPlaybookSchema.safeParse` validation (invalid entries are dropped — the band vouches for content as operator-authored, so nothing schema-invalid may be vouched for), `status === 'active'` filter, deterministic order (triggerSignature, then playbookId, code-point compare), equal-share entry budgeting, explicit `…[truncated]` markers (a hidden rule is strictly worse than a clipped rule: the gate fires either way, and the warn round-trip still delivers the full instruction verbatim), and a final clip so the cap holds by construction. No clock — expiry stays the gate's job.
- Injection: a third sibling builder `buildCompiledPlaybooksMessage` in `run-agent-step.ts` (tags `['ACTIVE_PLAYBOOKS_CONTEXT']`, `timeToLive: 'agentStep'`, `keepDuringTruncation: true`), added at all five message-assembly sites (per-step build, post-eviction, post-programmatic, post-prune, `memoryContextMessages`). The band is a separate user message — never an input to `compileMemoryV2Context` — so the 12k V2 cap and the 1.5k band cap are independent by construction.
- Framing contract: the band header states these ARE trusted operator-authored rules (the explicit opposite of the memory-v2 "untrusted evidence, never instructions" banner), names the gated tools, and carries the pre-satisfy directive plus the self-run clause ("a subagent's runs are not visible to this gate") — the band teaches the evidence-visibility contract that closes the basher-delegation blind spot for the evidence producer.
- Word parity: the band reuses the gate's own `describeRequiredEvidence` (now exported) and a new exported `describePlaybookTrigger` so the visibility channel and the enforcement channel describe the same rule in the same words.
- No root-only guard: the band's visibility predicate exactly mirrors the gate's enforcement predicate (`agentState.playbookContext` + tool). At design time only the root carried `playbookContext`; followup wave 2 (2026-10-25) landed child gating — children now carry a cloned `playbookContext`, so the band and the gate extend to them together, as this section predicted.
- Tests: `packages/agent-runtime/src/memory/playbook-context.test.ts` (determinism, cap/equal-share, truncation selection, schema boundary, framing, gate word parity, header bound), plus band-beside-V2 and absent-context cases in `loop-agent-steps.test.ts`.

## Phase 4 — learning loop

### Landed in this wave (the foundation seam)
- `PlaybookGateOutcome`/`PlaybookGateOutcomeEvent` types in `common/src/types/memory-playbook.ts`; the `'warned'` outcome added to the store-contract / sdk-repository / sdk-coordinator / cli-repository unions (type-level only — the store's counter fold already bumps `fired`/`lastFiredAt` unconditionally and each specific counter through `+0` ternaries, so a warn records fired-with-warn with zero behavior change).
- Additive-optional `onPlaybookGateOutcome` dep on `AgentRuntimeDeps` (never throws, never rejects; absent = exactly today's behavior).
- `packages/agent-runtime/src/memory/playbook-outcome-reporter.ts`: hazard-isolated fire-and-forget reporter. The hazard it exists for: a throwing producer inside the gate's existing try block would be swallowed by the fail-open catch and let a BLOCKED call proceed. The reporter isolates the emission so that can never happen.
- Emission from the tool-executor gate block: each surfaced verdict reports `{playbookId, triggerSignature, outcome: 'warned' | 'blocked'}` after its `onResponseChunk`.
- `enforcement: 'inject-only'` now means what it says: a matching inject-only playbook surfaces NO verdict (the gate evaluates it; the band renders it; nothing interrupts dispatch). This is the candidate shadow channel — dead vocabulary becomes the Phase 4 pipeline.

### Outcome mapping (gate → counters)

| Gate verdict | Emitted outcome | Counter effect |
|---|---|---|
| blocked | `'blocked'` | fired+1, blocked+1, lastFiredAt |
| warned (default mode) | `'warned'` | fired+1, lastFiredAt only |
| inject-only shadow fire | `'warned'` | fired+1, lastFiredAt (shadow signal) |
| applicable + satisfied | `'allowed'` verdict emitted (LANDED 2026-10-25 wave 3) — feeds the comply correlation only; never surfaced to the user, never reported to the store | — |
| bypassed | not producible yet (P3 journal leg; both child transports are closed — in-process state merge wave 2, supervised receipt transport wave 3) | bypassed |
| compliedAfterBlock | LANDED 2026-10-25 wave 3: bounded session gate history correlates blocked(sig) → in-session allowed(sig) and reports exactly once per prior block (never for heeded warns) | fired+1, compliedAfterBlock+1 |
| falsePositive | operator-only (P4 command) | fired+1, falsePositives+1, lastFalsePositiveAt |

Do NOT reuse `compliedAfterBlock` for heeded warns — that counter means specifically after-block compliance; polluting it destroys the one strong effectiveness signal.

### Candidate pipeline

Candidates are authored with `status: 'active'`, `enforcement: 'inject-only'`: the band renders them (their only channel — literally inject-only), the gate evaluates them and shadows the fire as `'warned'`. Zero new counters, zero schema changes. A `status: 'candidate'` row is invisible to both gate and band and can never accumulate counters, so candidates must ride the inject-only channel instead.

### Promotion / retirement policy (counters as-is; evaluator is a pure function, run by an operator CLI command with `--dry-run` default, or behind `OPENBUFF_PLAYBOOK_AUTO_LIFECYCLE=1` at memory-service startup — default off; never on the tool-dispatch hot path)

| Transition | Conditions (ALL) | Action |
|---|---|---|
| candidate → active | fired ≥ 8; falsePositives === 0; lastFiredAt within 14d | setPlaybookStatus('active') and flip enforcement inject-only → warn |
| active → verified | fired ≥ 10; blocked ≥ 3; compliedAfterBlock ≥ 3; falsePositives ≤ 1 and ≤ 10% of fired; bypassed ≤ 1 | setPlaybookStatus('verified') |
| any → retired (noise) | fired ≥ 4 and (falsePositives/fired ≥ 0.5 or bypassed/fired ≥ 0.3) | setPlaybookStatus('retired') |
| candidate → retired (dud) | created > 30d ago and fired < 2 | setPlaybookStatus('retired') |
| verified → block-eligible | status verified AND operator gate mode already block | operator flips enforcement via upsertPlaybookByTriggerSignature (preserves id/counters). Never automatic. |

Measurement subtleties the policy encodes: the band makes `fired` a DECREASING measure of success (the model pre-satisfies; a quiet rule is a working rule) — so never retire active rules on staleness, only on noise; `fired` counts every recorded gate event (including falsePositive/compliedAfterBlock bumps), not raw trigger matches; gate counters alone cannot distinguish "rule working" from "rule ignored" — that correlation needs the P3 event-journal leg (mistake rate measured independently of the rule).

### P4 build order
1. ~~Producer dep + emission + 'warned' widening~~ (landed this wave) — counters can move at all.
2. ~~Production wiring at the SDK impl entry seam~~ (LANDED 2026-10-25, followup wave 2): `sdk/src/run.ts` exports the pure `buildPlaybookGateOutcomeReporter(repository, logger)` — `undefined` when this run's Memory V2 repository or its optional `recordPlaybookGateOutcome` member is absent (an unwired run's deps stay byte-identical, key entirely absent), otherwise a never-throwing/never-rejecting closure that forwards the STORE signature `(playbookId, outcome)` — never the whole event — binds the member once, catches sync throws, and `.catch`es rejected store promises (debug log, no-op; a mid-session-retirement throw like 'The playbook was not found.' is safe). `getAgentRuntimeImpl` threads it via the file's conditional-spread convention. Historical note: the earlier `MemoryV2Coordinator.recordPlaybookGateOutcome` wrapper stays removed; the seam wires the store member directly, and the no-op-when-absent + failure-swallow behavior is pinned by `sdk/src/__tests__/agent-runtime-impl-playbook-outcome.test.ts` at the seam (the coordinator-level coverage the earlier reviewer wording asked for is moot — no coordinator leg exists).
3. ~~inject-only gate semantics~~ (landed) + ~~candidate authoring path~~ (LANDED 2026-10-25 wave 3): `/memory playbooks propose <project-relative-json-path> [--apply]` — strict `PlaybookProposalSchema` (cli/src/services/memory-v2/playbook-proposal.ts; length limits copied from MemoryPlaybookSchema so every parsed proposal assembles a store-valid upsert; trigger/scope reuse the store's own schemas; unknown keys rejected so a proposal can never smuggle status/enforcement/counters/provenance), contained .json read with sanitized errors, preview default, `--apply` upserts as status 'active' + enforcement 'inject-only' with provenance origin 'user' — authoring can never enforce; promotion to 'warn' is the lifecycle evaluator's job alone. Same-signature upsert refreshes contents while preserving id/counters.
4. ~~Comply detection~~ (LANDED 2026-10-25 wave 3): `packages/agent-runtime/src/memory/session-gate-history.ts` (cap 50, splice-in-place, sessionEvidenceLog pattern); `evaluatePlaybookGate` now emits `{ outcome: 'allowed', playbook }` for applicable-and-satisfied rules — behavior-invisible (no chunk, no dispatch change, no store report); tool-executor records every verdict in the per-agent history and correlates blocked(sig) → in-session allowed(sig), reporting `'compliedAfterBlock'` exactly once per prior block through the hazard-isolated reporter seam (never for heeded warns — the invariant is test-pinned).
5. FP operator command (STILL OPEN — counters fold `falsePositive`, but nothing records it yet) + ~~`evaluatePlaybookLifecycle` pure function + CLI report verb~~ (LANDED 2026-10-25, followup wave 2): pure evaluator at `cli/src/services/memory-v2/playbook-lifecycle.ts` implements the policy table below verbatim (deterministic playbookId code-point order; promote never flips to 'block'); optional `listAllPlaybooks?(workspaceId)` operator read added to `MemoryRepositoryV2` and implemented by BunSQLiteMemoryRepository (every row regardless of status/expiry); `/memory playbooks` report in memory-command.ts (bounded 30 rows, dry-run default, apply affordance only when actions exist, `--apply` via setPlaybookStatus + upsertPlaybookByTriggerSignature with the row's current contents verbatim and enforcement → 'warn' only, fail-closed clean errors when operator members are absent).
6. P3 journal legs: `playbook.warned/blocked/bypassed` events + mistake-rate measurement → closes the working-vs-ignored loop and unlocks verified-status block flips.

## Seed-2 (LANDED 2026-10-25)

Root-level `run_terminal_command` `git-push` requires a same-session successful CI check (`*check:ci-local*` within 14_400_000 ms), `enforcement: 'warn'`, seeded per-workspace idempotently beside seed-1 (existing rows never refreshed — a workspace already carrying seed-1 gains only seed-2).

Rationale: the child-gating gap rules out every candidate living inside the git-committer child (its `playbookContext` is undefined — createAgentState does not copy it), so the two seeds cover the two disjoint ROOT-level routes to the same irreversible mistake: seed-1 the delegated route (spawn git-committer), seed-2 the direct route (root pushes itself). Push over root-commit because a push is public and irreversible; a root commit is local and revertible and occurs in legitimately CI-disproportionate contexts (docs/config), inflating false positives. The instruction encodes the two teachable mitigations: self-run (not delegated — closes the basher blind spot for the evidence producer) and separate-command (a compound `check && push` records evidence only post-dispatch, so the first compound call warns once — benign under warn).

Known FP surface (the reason enforcement stays warn, and precisely the FP-measurement vehicle for the warn→block decision): a root push after a green validation gate still warns when validation ran through spawned agents rather than a root `run_terminal_command` (no ledger entry).

## Warn→block verdict (DECIDED 2026-10-25: do NOT flip)

Seeds stay `enforcement: 'warn'`; the default gate mode stays `'warn'`. Operators who want block set `OPENBUFF_PLAYBOOK_GATE=block` AND re-upsert the seed with `enforcement: 'block'` (the upsert refreshes enforcement on the existing row while preserving id/counters). Rationale: zero measured FP evidence (the counter producer had no production callers until this wave); block before the band is proven maximizes hard refusals the model cannot anticipate; a playbook block has no mid-session bypass (the COMMIT ANYWAY affordance belongs to a different guard), so block on a push rule stops legitimate emergency pushes until CI runs.

Prerequisite checklist before ANY flip (each item must be checked and documented):
1. Band landed and accepted (done — this wave; live-session pre-satisfaction observed without a warn round-trip).
2. Producer wired in production (LANDED 2026-10-25, followup wave 2: `buildPlaybookGateOutcomeReporter` at the SDK entry seam); ≥1 evaluation period of real counters on both seeds (clock starts now).
3. falsePositives measured on seed-2 specifically (compound-command case; gate-green-but-not-in-ledger case); ratio < 20% before that seed is considered.
4. Kill-switch documented: `OPENBUFF_PLAYBOOK_GATE=off` disables the whole gate; the downgrade-only property (block-enforcement playbook only warns under warn mode) is the partial-rollback lever — unsetting block mode restores warn without touching rows.
5. Enforcement-flip affordance documented: re-upsert by triggerSignature with `enforcement: 'block'` (no dedicated CLI verb exists yet — add in P4 or document the upsert path).
6. Cross-session ledger behavior stated: the evidence ledger is in-memory per session, so under block the CI check must be re-run EVERY session before the first push (withinMs cannot bridge processes).
7. Bypass posture decided: no mid-session bypass for a playbook block; emergency-push policy is an operator decision made before enabling block.
8. Child-gap caveat (UPDATED 2026-10-25 waves 2–3): the committer child now carries a cloned `playbookContext`, so its own gate evaluates its internal `git push` — the child hole is closed for gate evaluation; supervised children additionally export their evidence to the parent ledger via the receipt transport. Remaining nuance: a supervised child resolves the default warn mode (the gate-mode env is not threaded through the supervised-child allowlist).
9. Flip order: seed-1 (spawn rule; reviewer gate still behind it) before seed-2 (push rule; irreversible), one at a time, only once each reaches `verified` per the lifecycle policy or by explicit operator judgment.

## Deferred / open items

- **Child gating gap (LANDED 2026-10-25, followup wave 2 — closed for in-process children):** `createAgentState` clones `playbookContext` into every child (structuredClone, the `taskMemory` precedent); the supervised-spawn request slice carries it; `buildChildAgentState` rehydrates it with per-entry `MemoryPlaybookSchema` validation (invalid entries dropped and logged, non-array dropped whole); `mergeChildEvidenceIntoParent` folds a settled child's in-process evidence ledger into the parent's at all five settle sites (never throws, cap-respecting, entries copied) — so CI run inside an in-process basher child now creates root-visible evidence, and a git-committer child's internal `git push` is gated by its cloned rules under warn. CLOSED (2026-10-25 wave 3): the supervised receipt transport now carries a bounded `sessionEvidence` snapshot (additive-optional field on `agentReceiptSchema`, ≤50 entries serialized child-side from the child's own ledger at the success-receipt build, omitted when empty; legacy receipts stay valid), and the parent folds it via `mergeSupervisedEvidenceIntoParent` (spawn-agent-utils.ts — never-throw, cap-respecting, entries copied) at the single supervised-receipt acceptance point inside executeSubagent, so every handler settle path inherits the fold and crashed/invalid receipts never fold. Both transports are closed: in-process children merge via the state ledger (wave 2), supervised children via the receipt (wave 3). Remaining nuance: OPENBUFF_PLAYBOOK_GATE is deliberately not threaded through the supervised-child env allowlist, so a supervised child resolves the default warn mode regardless of the parent's mode.
- **claim.pinned band routing (old P2-T2):** superseded for candidates by the inject-only channel; pinned-claim visibility still rides the V2 context categories. Keep open for the P3 read-side hygiene pass.
- **Digest ledger / cold-start (old P2-T3):** unchanged; still open.
- **Enforcement-flip CLI verb + `/memory playbooks` report (old P4-T2):** the report + lifecycle evaluator + propose verb are LANDED (waves 2–3); the enforcement-flip verb and the FP operator verb remain folded into P4 build order items 5–6.
