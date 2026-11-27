# Independent Critic review

Verdict: **REVISE**. The incremental direction, audit synthesis and migration are strong enough to retain. Execution readiness is blocked by an undefined cross-backend authority transition, unsupported atomicity/prerequisite claims, and a current diagnostic truth repair placed behind unrelated integration gates. This is my independent Critic decision; the Architect's REVISE verdict is an input, not approval of this gate.

Reviewed 2026-11-06, strictly after the completed Architect review, under deliberate consensus in `/home/ben/.codex/skills/plan/SKILL.md`. I read PLAN.md, SPEC.md, OLD-TASK-MIGRATION.md, ARCHITECT-REVIEW.md, REQUIREMENTS-REVIEW.md, COVERAGE.md, AUDIT-REPORT.md and CAPABILITIES.md; selectively consulted durable 05/06/07/09/10 findings and artifact inventories. I performed artifact-only graph, migration and lineage checks. No implementation source was reread, changed or tested; no external API, goal or extra agent was used. The available inherited native backend supplied this dedicated Critic responsibility; the unavailable fixed-role model is not claimed to have run.

## Independent checks and evidence limits

| Check | Observed artifact result | What it establishes |
|---|---|---|
| Card graph | 35 cards, 35 graph rows, no unknown prerequisites or cycles | Syntactic feasibility; semantic prerequisites still need revision |
| Initial queue | B02/B03/B04 each have no prerequisites | The proposed three-worker start is actually ready; B05/B06/B09 are correctly excluded |
| Historical migration | Exact inventory set: 120 rows/120 distinct IDs; no missing/extra IDs; original lines and checkbox history match | Every old declaration has one explicit disposition, without transferring completion |
| Dispositions | 36 split, 36 integrate, 17 verify, 27 defer, 2 consolidate, 2 retire | All six meanings are used; all deferred rows name valid gates and every referenced B-card exists |
| Finding coverage | All 118 index IDs appear explicitly in card Trace lines; no missing/extra finding IDs | No current finding is dropped from the executable work register |
| Capability lineage | All 144 exact pair/capability keys occur once in the 45-capability catalog's lineage; no missing/extra/duplicate keys | Consolidation preserves the original vertical records, including absent/unwired boundaries |
| Audit breadth | COVERAGE.md:26–32 and AUDIT-REPORT.md:17–29 report 13 paired shards, 555 inspected files and 147,721 unique read-window lines with explicit exclusions | Substantial bounded inspection, rather than correctness of every file or live task quality |
| Verification paths | Task context reports all 91 listed existing test paths exist; new runners are marked prospective | Path evidence supplied by the root; I did not independently restat source files or run those commands |

Reviewed artifact SHA256 values:

- PLAN.md: `f5da08c6ad6388b12a05897ec5ee18f9cab28120eafcd9a4ec3580c0cedf1163`
- SPEC.md: `9a9b58a7d8fcc91c7c5c80ffd678ac6a4e13dd0cdcc642ecb1ca305bbcdc4d30`
- OLD-TASK-MIGRATION.md: `0cce04a196aeaa54e60c83c529b92e4eab3ba20e61dee2c28dd0a0efa695e7af`

Source confidence is inherited from the durable inspected traces and diagnostic receipts, with the source HEAD/prefix/supplemental-release limitations retained. Artifact checks are independent evidence about this plan; they are not repaired product acceptance, installed assurance, a fresh source attestation or proof of model quality.

## Principle, alternative and scope assessment

The plan correctly treats the configured model as the reasoning and action-selection authority and the CLI/runtime as its body. R1–R12, F1–F10 and the ten responsibility rows cover present strengths, missing capabilities, micro causes, adverse states and future graduation rather than inventorying helpers alone (PLAN.md:7–21; SPEC.md:17–62; CAPABILITIES.md:17–28, :120–128). Full access remains intentional, narrower enforcement is selected, and actual requested/available/active/enforced states remain distinct. These choices are supported by the documented shipped full-access dispatch and existing custom strategies; no blanket first-party isolation or host-imposed task strategy is warranted (SPEC.md:7–9; findings/10-extensions.md:37; findings/09-execution.md:65–71).

Options A and B are viable, fairly described scheduling/authority alternatives. B has a substantive benefit: native OS-held ownership can reduce the interval in which fail-closed TS safety strands interrupted work. A has a substantive benefit: discarded bytes/results, bad identities and incorrect consumers need repair regardless of language, and small current repairs should not wait for a daemon. The four-slot throughput cost and risk of freezing native contracts too early are real tradeoffs. Whole-loop Rust and permanent TS daemon alternatives have explicit capability/decision invalidation reasons (PLAN.md:25–32, :524–532; AUDIT-REPORT.md:176–190). I do not reject the alternatives as shallow.

The favored option is not yet fully consistent with principles 2/3/5. It promises one verified authority while leaving the active-backend transition undefined, uses atomicity beyond the selected coordinator's demonstrated guarantee, and permits a native consumer to import a corrected contract before its producer is accepted. It also describes short independent truth repairs while coupling 07-F7 to twelve prerequisite cards. Those are concrete contradictions, not a reason to restart the entire plan.

## Required revisions

### CRIT-1 — P1: Define and test one participating writer authority through cutover, outage and rollback

**Cards:** B04/B15/B16/B22/B26/B34; R3/R4/R6. **Relationship:** independently confirms ARCH-1 and tightens its guarantee scope.

**Evidence:** SPEC.md:11 declares one session authority. PLAN.md:326–330 gives B22 native commit/lease/journal authority while preserving TS fallback; no backend-selection epoch or outage/rollback rule is specified. B04's accepted tier is explicitly cooperative and fail-closed (:146–150). A native fence cannot exclude a TS adapter that never submits it. Existing stale takeover and unrenewed ownership failures make this a live contract concern, not a hypothetical porting preference (`workspace-mutation-broker.ts:601`, findings/06-edits.md:20; `workspace-path-leases.ts:45`, findings/05-durability.md:41).

**Required change:** State the supported client/daemon versions, participating writer set, repository/store backend and epoch, identity issuer, admission/fence validator and terminal-state owner. Cover broker mutation, transaction recovery, snapshot/index publication and child-mediated commits. State quiescence, import, activation and restart behavior. Once native authority is active, daemon loss must preserve state and return unavailable/recovery-required; it must not silently resume cooperative TS writes. Distinguish abandoning import before activation from an ownership-safe transition after native commits. Define schema/protocol version refusal and an explicit downgrade/rollback rule that cannot restore a stale TS snapshot over native work.

**Realizability boundary:** An unaware old binary or arbitrary full-access shell can still write as the user without consulting the new API. Do not promise that a native token prevents these writes. Require every supported participating TS adapter to discover/refuse the active epoch, and explicitly treat unparticipating writers as external effects under the captured-basis/conflict contract. Fencing guarantees apply to admitted operations; preserving full access does not make universal filesystem exclusion possible. This boundary must be stated in the mixed-version fixture, rather than hiding a nonparticipating legacy writer inside a claimed exclusive domain.

**Required proof:** Through actual SDK/runtime/native adapters, run compatible TS-backend and native clients, a stale live/detached participating holder, and incompatible/unaware versions with their stated boundaries. Kill before/during import, just after activation, and after a native commit; inject daemon outage and client version skew. Assert one admitted authority, stale epoch/fence refusal, original identities/receipt hashes, preserved originals/conflicts and no automatic fallback. Verify the explicit rollback or refusal path. Include backend/epoch/import phase in machine receipts and affected installed-client cells.

**Stop:** A green two-new-client store test, native token check or restored import hash cannot graduate the transition if another supported adapter writes in a separate exclusion domain.

### CRIT-2 — P1: Align atomicity and migration graduation with actual producer contracts

**Cards:** B05/B06/B07/B15/B16/B22; R3/R4/R9. **Relationship:** independently confirms ARCH-2.

**Evidence:** B22's eight transitive prerequisites are B02/B03/B04/B15/B18/B19/B20/B21; B05/B07 are absent, despite B07 explicitly saying B22 consumes its corrected contract (PLAN.md:95, :176, :326–330). Those omitted repairs supply raw bytes, durable admission, expected after-state, contained conditional recovery and retryable unfinished state. The current counterexamples overwrite foreign divergence and mark failed restoration terminal (`transaction-intent-log.ts:161,1249,1263,1367`, findings/06-edits.md:26–28). B06 depends only on B03/B05 but requires all edits to apply atomically or leave everything untouched and stops on any subset commit (PLAN.md:79, :166–170). The current coordinator has atomic preflight and visible sequential commit (findings/06-edits.md:9; AUDIT-REPORT.md:45).

**Required change:** Choose and name the stores and guarantee tier being accepted. If B22 imports transaction intents/recovery state, require accepted B07, which already carries B05/B03/B04. If it initially owns only a new job/journal/lease registry and fenced commit API, keep transaction import and its production recovery consumer as a separate gated card/milestone. Production child lease migration must consume B16's integration proof or own that explicit proof inside B22. A direct B21→B22 edge can remain; it cannot bypass corrected-store semantics.

For B06, distinguish (a) complete version/basis/operation preflight with zero-write refusal, (b) guarded sequential success, and (c) mid-commit failure/crash with truthful partial/uncertain effects and ownership-bound recovery. Add B04/B07 prerequisites for the stronger ownership/recovery tier, or explicitly gate that graduation separately. Do not promise instantaneous multi-file visibility to external writers, and do not forbid an unavoidable intermediate partial state while requiring sequential execution. Keep the complete-intent requirement: unsupported/malformed members must refuse the whole intent before effects. Apply the same tier rule to B15/B16 when their continuation fixture consumes transaction recovery or native fencing; useful immediate identity/journal/renewal work can retain a narrower cooperative acceptance boundary.

**Required proof:** Enumerate TextDocumentEdit/versioned and unversioned edits, CreateFile/RenameFile/DeleteFile, supported options/annotations, conflicting operations and negotiated positions; supported cases execute and unsupported cases refuse the complete preflight. Add crash/failure during real sequential application, preserving per-operation receipts and unresolved conflicts. Before transaction import, seed uncertain legacy state, foreign divergence, replaced parents and a once-failing restoration; import/restart must preserve exact hashes, outside/foreign bytes and retryable unfinished paths. Revalidate semantic dependencies and readiness predicates, not only absence of cycles.

**Stop:** Do not accept an imported corrected recovery contract before its producer, call complete preflight filesystem-wide atomicity, or mark an entire card accepted after an explicitly narrower milestone.

### CRIT-3 — P2: Make the existing diagnostic false-success repair independently executable

**Cards:** B27, with B02/B19 integration as relevant; R1/R6/R8/R9. **Relationship:** additional Critic ordering finding.

**Evidence:** `diagnostic-delta.ts:232,463` drops execution failure and accepts empty deltas; `file-change-hooks.ts:1691` projects `diagnostic_delta_passed`. The timeout/127 counterexample is already demonstrated (findings/07-languages.md:36; AUDIT-REPORT.md:53). B27 owns that repair but has six direct and twelve transitive prerequisites, including all fifteen packed grammars, four real LSP cells, complete semantic refactors and retrieval generation work (PLAN.md:100, :374–380). None is intrinsically needed to retain a failed command outcome through the existing delta/hook consumer. This conflicts with driver 1 and the immediate-truth ordering correction (PLAN.md:23, :68–70; REQUIREMENTS-REVIEW.md:23).

**Required change:** Separate the existing diagnostic outcome/coverage repair from joined-language graduation. Give the immediate slice its own bounded card or independently accepted readiness predicate with no unrelated parser/LSP/index/refactor prerequisites; B02 may be needed for a shared outcome schema. Keep B19 context and the full B06/B23–B26/B27 joined-contract gates on later integration. Update the graph, queue eligibility, R/old-task mappings and count declarations consistently. If using milestones, the validator and completion ledger must understand them explicitly; a partial B27 must not appear wholly accepted.

**Required proof:** Key-free existing diagnostic and file-change-hook suites exercise timeout, exit 127, cancellation, missing/partial/capped output and a normal successful check through the actual delta→hook→SDK/client projection. Failed/unavailable observations never produce passed diagnostic evidence; pre-existing harmless errors and valid optional-check behavior remain distinguishable. The later B/C/D joined-language fixtures remain mandatory for their deeper claim.

**Stop:** Do not leave a current false-success correction hostage to complete language-toolchain or native installation breadth, and do not make missing tools a pass to shorten the prerequisite chain.

## Bounded acceptance and command clarifications

Resolve these in the revision; they need no whole-loop redesign or new language commitment.

1. **B08/B09 — declare the selected finite admission policy.** Finite retry ownership is correctly required, but the adverse fixture should commit max attempts, bounded retry/backoff/Retry-After values and cancellation wait before running it. B09 must state what capped admission does when usage/pricing is incomplete: conservative reservation, explicit estimate/degraded cap, or refusal. Test late/missing usage after a failed request, concurrent children and restart, proving unknown cost cannot reset spend or grant unlimited new attempts. Keep the declared remote in-flight overshoot limitation (SPEC.md:76–78; PLAN.md:188–200; ARCHITECT-REVIEW.md:89). These are fixture/policy declarations, not invented universal billing or latency targets.

2. **B15/B29 — name the supported resumable prefix and nondeterministic input boundary.** A dependency bundle repairs the demonstrated module-constant/import loss; it does not persist arbitrary mutable module state, unjournaled direct I/O, randomness, time or a live JS heap (`load-agents.ts:221`, `run-programmatic-step.ts:401`, findings/10-extensions.md:37). Specify which recorded input/output prefix can be reconstructed and which unrecorded state makes automatic continuation unavailable. Add changed-bundle, mutable-module and unrecorded-nondeterminism refusal controls alongside a positive recorded-input replay control. Trusted/full-access execution can remain supported while automatic recovery has this narrower contract (SPEC.md:82–92, :115; PLAN.md:256–260, :396–400; ARCHITECT-REVIEW.md:85).

3. **B19/B29/B31 — prove retained choice through a real consumer.** Existing full-access acceptance and user-selected route override are good. Include a custom strategy performing normal full-access work, a required unavailable profile returning its truthful unavailable state, and an explicit user/model-selected route winning over recommendation. Report lifecycle state without prescribing the model's task workflow (SPEC.md:7–9; PLAN.md:298, :398, :418).

4. **B21/B22/B24/B25/B27/B32/B35 — supply executable bootstrap and assurance tiers.** New rusqlite/OS dependencies and real servers/Chrome/Blender require locked acquisition and toolchain manifests before locked/offline acceptance. Distinguish that bootstrap from the key-free/offline proof; missing tools stay unavailable. Export BODY_EVIDENCE or pass it explicitly to every runner if runners use process environment—the current shell setup assigns an unexported variable (PLAN.md:54–62). Resolve the Bun 1.3.5 executable from the actual approved environment/manifest rather than assuming that one home cache path exists on every host. Give smoke commands their concrete build/artifact arguments and each new runner its invocation. Source/DI, installed, real-tool and selected-platform acceptance must remain separate cells.

5. **Cross-reference fixes.** SPEC.md:21's “B35 PTY gate” must be G-PTY; B35 owns 3D. Include G-PROVIDER in the ADR follow-up gate roster if it remains in the conditional register (PLAN.md:477, :534). Preserve the explicit no-Python authored fixture and independent Python target-toolchain distinction.

## Deliberate pre-mortem and verification assessment

The plan has the required three substantive failure scenarios and expanded unit/integration/e2e/observability work. It is not a missing-pre-mortem or helper-only verification proposal. The second scenario needs the CRIT-1/CRIT-2 controls before it earns high-risk mitigation credit.

| Failure scenario | Adequate existing controls | Revision needed |
|---|---|---|
| False successful task through a consumer | B02/B03/B28/B30 actual projections; fatal/cancel and failed-action→successful-recovery controls; failure receipts retained | Add independent 07-F7 repair and preserve action/run/task distinctions in every client sink |
| Crash/timeout causes overwrite, duplicate effect or living work | Four crash boundaries; B04 fail-closed safety; B07 ownership recovery; B15 uncertainty stop; B20 actual descendant exit with finite D/G/K/J | Add mixed backend/epoch/version/outage/rollback and sequential partial-commit cases; never credit a native token as universal fencing |
| Polyglot/learning growth masks regressions | Packed assets, real language/ABI consumers, unavailable cells; complete attempt populations; held-out/power/strata/rollback; conditional frontiers | Keep manifest/bootstrap facts executable; retain workflow validation versus measured-improvement distinction |

The proposed positive/adverse oracles mostly discriminate the underlying failure:

- **Outcomes:** fatal generator, cancellation and hard stop cannot become a completed run; a later accepted task preserves earlier failed actions. A normally completed run can still have rejected/unknown task acceptance (SPEC.md:64–70; B02/B03/B30). This essential distinction is sound.
- **Limits and recovery:** D=250 ms, G=200 ms, K=200 ms, J=1 s define a finite fault fixture, with observed scope death, drained/closed streams, no late markers and retained cleanup authority. Escaped work outside a cooperative tier is disclosed; OS-wide claims require actual selected-host proof. An unverifiable external effect remains uncertain and stops automatic rerun. Failed restoration remains retryable rather than being falsely declared terminal (SPEC.md:74–92; B04/B07/B15/B20–B22).
- **Memory:** 200 messages, thirty exact 32-KiB results, three real compactions, fresh-process next-task recall, five exact values/negations/statuses and decision/rationale prevent substring-only credit. Prompt/hot-window, artifact quota, SQLite overhead, pinned-capacity failure, rolling cutoff and keep-until-delete are separate. No bounded indefinite retention promise survives (SPEC.md:94–104; B12–B14).
- **Language:** authored A proves an actual installed TS→Rust role with Python absent. Target B tests TS/Rust/Python JSON-schema consumers; C tests C/Python ABI; D proves useful generic actions with unavailable higher tiers. Fifteen grammars do not certify fifteen semantic servers. Missing toolchain, stale basis/schema, failed consumer or skipped real-server cell cannot certify joined acceptance (SPEC.md:121–135; B21/B23–B27).
- **Learning/performance:** predeclared eligible paired held-out repeats, language margins/power/confidence, complete paid/error data, explicit candidate application and exact rollback are credible future gates. A no-promotion fixture can prove plumbing; empirical improvement still requires real eligible trials. Equivalent correct baselines, recorded versions/configuration and uncertainty avoid fabricated speedups or zero stochastic regression claims (SPEC.md:137–141; B30–B32).
- **Observability:** actual identities, effect/basis hashes, owner generations, usage provenance, cleanup, enforcement and retention cutoff are appropriate machine evidence. Add active backend/epoch/import phase for migration. A bounded local receipt/opt-in telemetry path is sufficient; OTel/Parquet/DuckDB are fairly conditional (PLAN.md:62, :495).

Unit/DI commands and adverse tests are credible prospective work, not evidence already run. New fixture creation is stated, existing test paths have supplied root path evidence, and optional platforms/real tools remain unverified until their cells execute. Command bootstrap/env details above still need correction for a portable execution handoff.

## Dependencies, staffing and conditional work

Leader plus three worker slots is feasible. B02/B03/B04 have distinct primary seams, while public schemas and `sdk/src/run.ts` are explicitly leader-owned and serialized. Rotation to an independent verifier is essential and correctly stays within four total slots. The callable-role/native-backend adaptation and outside-tmux versus selected Team+Ultragoal path are accurately distinguished; no unavailable model or tmux runtime is silently assumed (PLAN.md:36–50, :502–520).

The direct B21→B22 edge establishes adjacency, not the promised small early native milestone. B21 first needs all-launcher B19/B20 and new Linux selected-enforcement work; B22 then combines new store/commit/lease/job/journal and migration. Either stage independently named, fully verified readiness slices and make their graph/ledger semantics explicit, or retain the full gates and state the scheduling cost honestly. Do not resolve the contradiction by marking the broad card complete on a minimal daemon boot. The synthesis I favor remains immediate TS truth repairs plus an explicitly bounded native authority lane once its real producer contracts exist.

The conditional register and 120 migration dispositions preserve the frontiers rather than hiding current defects. PTY, native desktop/voice, remote/coedit, deeper languages, model training, new clients and native kernels each need a declared workload and oracle. Exact policies/results/env/memory/diagnostic repairs remain current work. No new capability should graduate because of a grammar count, a prompt, an old checked line or keyword completeness (PLAN.md:464–477; OLD-TASK-MIGRATION.md:7–11, :138–140; CAPABILITIES.md:124–128).

## Approval conditions and next gate

Retain this plan rather than restart planning. The next revision must resolve CRIT-1/CRIT-2 with ARCH-1/ARCH-2, separate CRIT-3's current diagnostic truth repair, and apply the bounded acceptance/command clarifications. Update SPEC, card counts/graph/ready predicates, affected old-task mappings, pre-mortem controls and ADR consequences together; preserve the exact 120-ID history and 118/144 lineage. Record explicit resolutions without describing prospective fixtures as observed repairs.

After the revised artifact checks pass, run a new dedicated Architect review and only then a new independent Critic review. Publication/planning completion remains separate from source implementation, installed/native feature readiness and live improvement. **No consensus approval or execution authorization is issued by this review.**
