# Independent critic review — final recovery-qualified revision

Verdict: **APPROVED**

The revised plan is actionable. CRIT-1, CRIT-2 and CRIT-3 are resolved, the bounded acceptance clarifications are incorporated, and representative implementation paths support the proposed work. No blocking planning objection remains.

This approves the planning artifact and its prospective acceptance contracts. It does not approve implementation, establish repaired product behavior, certify installed/native readiness, demonstrate live model gains, or complete publication.

## Review basis and frozen inputs

I read `/home/ben/.codex/prompts/critic.md` and reviewed the full PLAN.md, SPEC.md, AUDIT-REPORT.md, CAPABILITIES.md, OLD-TASK-MIGRATION.md, REQUIREMENTS-REVIEW.md, completed ARCHITECT-REVIEW.md, REVIEW-RESOLUTIONS.md, FINALIZATION-CHANGES.json, both round-1 reviews, PLAN-VALIDATION.json, REVIEW-VALIDATION.json, COVERAGE-RESULT.json, SCOPE.md and SOURCE-STABILITY.md.

I inspected current implementation, documentation and package anchors for representative high-risk paths. I independently checked artifact structure, references and lineage without running product or probe suites. I made no edits, replayed no recorded commands, activated no goals and spawned no agents.

The following hashes matched at entry and remained unchanged at the final check:

| File | Reviewed SHA-256 |
|---|---|
| PLAN.md | `60f28ae636ac0511266526d80221caf09c34c7ff8b0c53b79aba2d85787f8241` |
| SPEC.md | `4354e0932a9c33e4fc6b931d8099c1ceaf2669eac226e05406b502bd8c6c8c10` |
| OLD-TASK-MIGRATION.md | `e227904717f54ac415d57e9b43d85a86914f9a0d031a5f1e79b088bcac548ba1` |
| CAPABILITIES.md | `f5953baaded163f3268db9c3ab516806c5eb7a688b601f865424d13cc17c3265` |

Git HEAD also matched at entry and end: `e65c06c0ae783130998bd9ab18c8d35320e40ea8`.

The completed Architect reviewed the archived plan/spec hashes `8ffbb2268dc0b5641ded1201bdd6b15964630d08575f73369512c9798ab7b368` and `3bf9585bc801bc718c4f8e5fa8816d1b0d1b922fa8ff66e359a94ab18c6bddf6`. I compared those archives with the current documents. The differences concern the corrected SCIP citation, review-state wording and delivery wording; task contracts, dependencies and acceptance remain unchanged. FINALIZATION-CHANGES.json identifies the coverage metadata corrections separately. The completed Architect approval is an input to this independent decision.

## Independent consistency checks

| Check | Result |
|---|---|
| Cards and completion graph | 36 cards, 39 completion nodes; no unknown dependencies or cycles |
| Human tables versus canonical JSON | All 39 dependency rows agree |
| Initial dispatch | B02/B03/B04 have no prerequisites |
| Ready rotation | B36 and B30 have no prerequisites |
| B22 rollup | Requires M22-CORE, M22-TXN and M22-CHILD |
| Existing test references | 98 references resolve unambiguously to 97 distinct existing test files |
| Plan file references | 251 existing references resolve; 42 prospective references are distinguishable from existing resources |
| Local links in reviewed Markdown | 381 references checked; none missing |
| Current top-level directories | All 30 directories have a scope disposition |
| Historical migration | 120 rows, 120 distinct IDs; no missing/extra IDs or line/checkbox mismatches |
| Historical declaration preservation | All 120 inventory raw lines match the preserved historical PLAN.md |
| Finding coverage | All 118 finding IDs appear in card Trace fields; no unknown IDs |
| Capability lineage | All 144 exact vertical keys occur once across 45 catalog rows |

Migration dispositions remain 36 split, 36 integrate, 17 verify, 27 defer, two consolidate and two retire. Every referenced replacement node exists. These checks establish artifact consistency; they are not implementation acceptance.

## Resolution of prior objections

| Prior objection | Verified resolution | Judgment |
|---|---|---|
| CRIT-1: competing TS/native authorities | One SessionAuthority semantic owner, physically bound repository selection, monotonic epoch, explicit compatibility, participating writer roster, admission held through effects, guarded native execution, quiescence/import/activation and outage refusal (`PLAN.md:712–718`; `SPEC.md:17–23`) | Resolved |
| CRIT-1: unsupported universal fencing | Unaware binaries and arbitrary full-access external effects remain outside admitted fencing; captured-basis conflict/reconciliation limits are explicit (`PLAN.md:714`, `:717`, `:720`) | Resolved |
| CRIT-2: imports before corrected producers | M22-CORE is an eligible fresh baseline; M22-TXN requires B05/B07; M22-CHILD requires B16 and M22-TXN; B22 requires all three current receipts and populated transition cases (`PLAN.md:124–128`, `:724–728`) | Resolved |
| CRIT-2: unsupported all-file atomicity | B06 requires B04/B07, enumerates supported/refused operations, separates zero-write complete preflight from guarded sequential effects, and preserves partial/uncertain/recovery/conflict state (`PLAN.md:530–546`; `SPEC.md:65`) | Resolved |
| CRIT-3: diagnostic truth delayed by deep integration | B36 has no prerequisites, owns the actual delta→hook→SDK/client path and is first worker rotation. B27 consumes it later (`PLAN.md:79`, `:772–778`, `:860–868`) | Resolved |

The native transition now addresses the actual exclusion problem. Current broker reclaim checks ownership and then removes the lock (`sdk/src/services/workspace-mutation-broker.ts:601–603`); index reclaim reads before renaming (`packages/indexer/src/index-store.ts:1164–1176`). A token checked only by native clients would not repair these separate domains. The proposed participating gate and guarded effect boundary do.

The plan also distinguishes pre-activation abandonment from post-activation downgrade. After native activation, outage or skew cannot reactivate TS writes, and stale TS snapshot restoration is expressly refused (`PLAN.md:717–718`). This is a concrete, testable refusal policy.

## Representative execution simulations

### Runtime and diagnostic truth

Current generator handling catches an exception, sets `endTurn=true` and returns normally (`packages/agent-runtime/src/run-programmatic-step.ts:749–799`). Normal loop finalization then writes completed journal/run state (`packages/agent-runtime/src/run-agent-step.ts:3664`, `:3678`). B02 owns the runtime transition and requires child, SDK and CLI/headless projections, including fatal, cancellation, hard-stop, happy and successful-recovery controls.

Diagnostic capture independently discards command status and converts exceptions to an empty diagnostic array (`sdk/src/services/diagnostic-delta.ts:225–239`). No new errors returns `rejected:false` (`:463–465`), which the hook projects as passed (`sdk/src/tools/file-change-hooks.ts:1691–1695`). B36’s bounded additive repair can proceed without new parser, LSP, index or native work. Its optional fail-open control preserves unsuccessful observation evidence while permitting work.

These cards can be executed through identified seams and have oracles that distinguish action failure, run termination and task acceptance.

### Complete semantic intent and recovery

WorkspaceEdit normalization ignores versions and skips malformed members (`sdk/src/services/lsp-multiplexer.ts:1057–1062`); rename returns only `changesByUri` (`:1318`). Per-file splice failures coexist with surviving changed files (`sdk/src/services/language-intelligence.ts:418–435`), and semantic application supplies unguarded full-file requests (`sdk/src/tools/semantic-edit-apply.ts:136–145`).

B06 requires retaining the complete intent and captured basis before effects. Its operation manifest specifies versioned/unversioned edits, creation, rename/delete, options, annotations, conflicts and encodings. Supported execution is visibly sequential.

B07 supplies the necessary recovery producer. Current recovery restores selected divergent paths and appends abort even when restoration fails (`sdk/src/tools/transaction-intent-log.ts:1249–1265`). The replacement requires proven after-state ownership, contained conditional restoration and persistent unfinished recovery. Native import cannot graduate these semantics before B05/B07 acceptance.

This path is feasible without promising general filesystem-wide atomic visibility.

### Actual native adoption and populated cutover

Rust accepts initialize followed by a raw ExecPlan (`rust/crates/openbuff-native/src/exec/mod.rs:136–161`) and replaces itself with the target on Unix (`exec/runner.rs:65–70`). The generic TS supervisor instead sends correlated method/params RPC requests (`sdk/src/services/sidecar-supervisor.ts:246–251`). Existing smoke still expects the former stub (`rust/scripts/smoke-test-sidecar.sh:42–54`).

B21’s explicit one-shot adapter, separate control phase/channel, JSON-RPC-shaped target-output control and installed executable checks address that real mismatch. B22 then adds admission/store ownership through explicit milestones. Held participating operations, uncertain children, populated intents, daemon outage, skew and attempted stale rollback all have required acceptance cases.

M22-CORE’s adjacency after B21 is honestly a dependency statement. The plan retains full B19/B20/B21 costs and never treats partial native boot as full B22 completion.

## Requirement fit and testability

| Dimension | Assessment |
|---|---|
| Clarity | Owners, producer/consumer boundaries, prerequisites, language decisions, evidence and stop rules are explicit |
| Verifiability | Positive/adverse controls distinguish the reported defects; actual consumers and installed paths are required where relevant |
| Completeness | R1–R12, F1–F10, ten responsibilities, 45 capabilities, current findings and historical dispositions are retained |
| Big-picture fit | The model retains strategy/action selection; the body supplies dependable observations, effects, ownership, continuation and learning evidence |
| Principle/option consistency | Pass; the revised authority and recovery tiers align with the stated principles |
| Alternatives depth | Pass; earlier native ownership has a substantive liveness benefit and an acknowledged staffing/interface cost |
| Risk/verification rigor | Pass; refusal, uncertainty, adverse interleavings, finite limits and consumer evidence are explicit |
| Deliberate additions | Pass; three substantive pre-mortems and expanded unit/integration/e2e/observability coverage are present |

The catalog preserves useful foundations alongside partial, unwired, absent and unknown abilities. Its micro explanations connect limiting behavior to causes and future acceptance; they do not claim a measured maximum achievable product or model quality (`CAPABILITIES.md:9–15`, `:120–128`; `AUDIT-REPORT.md:168–172`).

Local/BYOK and explicit full access remain supported. Current request-flow documentation confirms local SDK/runtime/provider execution (`docs/request-flow.md:3–7`), and shipped terminal dispatch explicitly selects full access (`packages/agent-runtime/src/tools/handlers/tool/run-terminal-command.ts:38–42`). B19/B29/B31 include real custom-strategy, unavailable-required-profile and route-override controls.

Authored-language responsibilities are coherent: TS owns coordination/public interfaces; Rust earns native effects/ownership; optional Python remains offline. Consumed ecosystem languages do not inflate body authorship. Fixture A requires installed TS→Rust cooperation with Python absent. Fixtures B/C independently require TS/Rust/Python schema and C/Python ABI consumers; unknown-language D retains generic operations. Parser variants, semantic servers and executed validation remain separate tiers (`SPEC.md:139–149`).

## Bounded clarifications retained

- **Replay:** B15/B29 require immutable identity, a maximal contiguous verified recorded prefix and matching reconstructed yields. Missing records, changed bundles or unknown mutable/nondeterministic dependencies refuse automatic continuation. Trusted normal execution remains available; bundling is not a heap snapshot (`SPEC.md:98–110`).
- **Spend and retries:** Finite attempts/waits are predeclared. Strict capped admission refuses unknown pricing or unjustified reservations; incomplete attempts retain reservations through retry, children and restart. Estimated and uncapped choices have distinct provenance. No exact remote billing guarantee is implied (`SPEC.md:90–94`; B08/B09).
- **Retention:** Exact facts, negation, decision/rationale and original 32-KiB result identities survive three compactions and a fresh process within declared policies. Quota, pins, cutoff, SQLite overhead and unbounded keep-until-delete are distinct (`SPEC.md:114–122`).
- **Learning/performance:** B30/B31 preserve paid/error/incomplete attempts, reject nonfinite or insufficient evidence, predeclare held-out paired language gates and require actual application/rollback. Plumbing proof cannot become an empirical gain. Performance uses equivalent correct workloads and recorded baselines (`SPEC.md:157–161`).

B30’s isolation ordering is necessary and concrete: production writes to a hardcoded lesson directory (`evals/buffbench/run-buffbench.ts:314–321`), and the existing suite deletes that shared directory (`evals/buffbench/__tests__/run-buffbench.test.ts:1091–1094`). The plan expressly blocks that suite until the injected sink and sentinel check exist (`PLAN.md:808`).

## Commands, toolchains and ownership

Existing commands name existing files; proposed runners and their CLI contracts are explicitly future resources. The Bun 1.3.5 pin and CLI preload agree with current testing documentation (`docs/testing.md:23–34`). The SDK exposes actual CJS/ESM entries, build/prepack scripts and Node minimum (`sdk/package.json:8–14`, `:24–41`). Rust’s pinned 1.87.0 and workspace manifest provide concrete native inputs.

Bootstrap separates acquisition from locked/offline proof, requires reviewed dependencies/locks and records unavailable cells rather than manufacturing success (`PLAN.md:910–933`). Exported evidence variables, explicit runner arguments and concrete native build outputs make the handoff executable once resources are created.

Leader plus three workers is feasible. Initial cards have distinct primary seams; shared schemas and `sdk/src/run.ts` remain leader-owned and serialized. Later overlapping hook, memory/client and native adapters must follow the declared file/authority ownership rules, with independent verification rotating inside four total slots (`PLAN.md:40`, `:965–979`).

Conditional PTY, desktop, voice, remote/coedit, deeper language, isolation, ML, client and kernel work retains triggers and graduation evidence. It is neither hidden prerequisite work nor universal capability assurance.

## Recovery and assurance limits

The recovered evidence supports a qualified review:

- Thirteen paired audits satisfy the seven-pair minimum.
- Recovered receipts credit 555 inventory files and 147,555 reconstructed read-window lines.
- The historical 147,721-line figure differs by 166 unrecovered lines, which receive no inspection credit.
- The original 558-file whole-byte map is unavailable. Four surviving prior unchanged comparisons are historical evidence.
- The 258 captured windows across 173 files and 38,692 unique lines agree with current source under the recorded normalization. This does not establish original whole-file bytes, line endings or uninspected tails.
- CURRENT-FILE-HASHES.json is a fresh binding, not historical equality evidence.
- `structuralInspectionCovered=true` and `nativeComplete=false` remain separate claims.
- Recovered suite logs and diagnostic passes do not establish current repaired acceptance; diagnostic passes can reproduce defects.

These limits are consistently retained in AUDIT-REPORT.md, CAPABILITIES.md, SCOPE.md, SOURCE-STABILITY.md and the validation artifacts. I did not repeat the original audit or certify unavailable historical data.

## Remaining obligations and stop condition

**Blocking revisions:** none.

**Nonblocking polish:** no further revision is required for this planning verdict. The completed Architect’s citation and coverage-reference corrections are incorporated.

Future execution must still prove held admission through effects, complete preflight, truthful sequential recovery, replay eligibility, actual covered-scope cleanup, populated native imports, isolated installed consumers and eligible measured learning/performance outcomes. Missing positive cells, stale receipts, live covered resources, silent fallback, uncertain automatic replay or incomplete populations block the affected acceptance node.

The independent Critic gate is complete against the frozen hashes above. Persist this result and update the resolution/publication status through the root’s delivery process. Publication and later implementation authorization remain separate; no product card is accepted by this review.
