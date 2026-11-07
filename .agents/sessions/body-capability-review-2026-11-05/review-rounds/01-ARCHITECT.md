# Dedicated architect review

Verdict: **REVISE**. Retain the recommended incremental direction, but repair two authority/dependency gaps before presenting the plan as execution ready. The objections do not justify a whole-loop Rust rewrite. This is the subsequent Architect gate; it does not approve the independent Critic gate.

Reviewed 2026-11-06 under the deliberate consensus contract in `/home/ben/.codex/skills/plan/SKILL.md`. Inputs were the frozen PLAN.md, SPEC.md, OLD-TASK-MIGRATION.md, REQUIREMENTS-REVIEW.md, CAPABILITY-RUBRIC.md, COVERAGE.md and COVERAGE-RESULT.json. Selective supporting reads were the durable 05/06/07/09 findings, DECISION-EXCERPT.md and the existing path-check receipt. No implementation source was reread, changed or tested; no external API, goal or additional agent was used. Dedicated Architect responsibility used the available inherited native model, not the unavailable fixed-role model configuration.

## Architectural assessment

The plan addresses the user's actual objective: give a configured model dependable observations, effects, continuation, memory and controls, and improve both authored-body cooperation and target-project language support. It preserves a useful existing body rather than equating additional languages with progress. R1–R12, F1–F10 and the conditional register provide a finite macro surface; the cards connect micro causes to real consumers and failure oracles (PLAN.md:7, :112–460; SPEC.md:17–62).

The most valuable decisions are correct:

- **Separate action result, run termination and task acceptance.** B02/B03/B30 cover fatal failure, cancellation, false mutation confirmation and a failed-action→successful-recovery control. A later accepted task retains its earlier failures. This avoids both false success and a blanket rejection of recovered tasks (PLAN.md:128, :138, :408; SPEC.md:64–70).
- **Keep source, result, identity, provenance and authority distinct.** Raw bytes are not normalized observation text; a truncated symbol label is not an opaque symbol identity; retrieval generation is not source freshness; peer origin is not host authority; a status label is not observed process death (B03/B05/B23/B26/B28; SPEC.md:73–92, :131).
- **Use Rust for a real capability.** The existing native exec role demonstrably supplies a standalone Linux filesystem restriction, while TS adoption and the broader D48 tiers remain unwired/unproved. OS-held ownership and durable fenced commit primitives are a credible native responsibility. Fixing lost WorkspaceEdit versions or MCP errors by porting them is not a capability case (findings/09-execution.md, “Native adoption and cross-language boundary”; findings/07-languages.md:1; B21/B22).
- **Prove two different kinds of language cooperation.** Authored fixture A must run the TS host→installed Rust role without Python. Target fixtures B/C exercise TS/Rust/Python schema consumers and C/Python ABI consumers; D retains useful generic operations for an unknown language. A Python target does not make Python mandatory body authorship (SPEC.md:109–133; B21/B23–B27).
- **Keep evidence levels honest.** Structural coverage is true and the minimum pair rule passes, while native readiness remains false. The 555-file/147,721-line-window receipt is substantial bounded inspection, not exhaustive correctness or installed assurance. The planner explicitly separates these from future acceptance (COVERAGE.md; COVERAGE-RESULT.json; PLAN.md:9).

I checked the artifact graph read-only: 35 cards and 35 graph rows, no unknown dependency IDs, no cycles, and B02/B03/B04 each have no prerequisites. There are 120 migration rows and 120 distinct historical IDs. This confirms syntactic feasibility and the initial queue; it does not prove every semantic prerequisite is present. The parent's check reports 91 existing listed test paths. Planned new runners are explicitly future work. The older PLAN-PATH-CHECK.json predates the parent's semantic-edit-apply anchor correction and is not treated as a new source finding.

## Required revisions

### ARCH-1 — P1: Make the TS→native writer transition an exclusive authority protocol

**Affected:** B04, B15, B16, B22, B26, B34; R3/R4/R6; historical P2-T2/P2-T5/P2-T8, P6-T2/P6-T5/P6-T6a; D50/D51/D56.

**Evidence:** SPEC.md:11 declares one logical session authority. B22 proposes native commits, leases, fencing and imports while retaining cooperative TS fallback (PLAN.md:326–330). B04 proves exclusion only among participating TS clients (PLAN.md:146–150). The underlying stale-breaker defect already allows two conditional commits against one preimage (findings/06-edits.md:20), and current supervised lease ownership has cross-boundary limitations (findings/05-durability.md:43; DECISION-EXCERPT.md, D56).

**Gap:** “Old holder cannot commit” is a good oracle, but the plan does not identify how pre-native/cooperative writers are excluded once native ownership is active. Native fencing cannot stop an old TS writer that never submits its fence to the native authority. Preserving TS fallback without a backend-selection/cutover contract permits two exclusion domains for one repository. A correct import plus a green two-new-client fixture can still pass while an old SDK/CLI, detached child, index writer or recovery scanner writes independently.

**Concrete revision:** Add a bounded B22 transition contract that states:

1. Which component issues session/run/action identities and terminal transitions, and which native operations validate resource ownership. TS orchestration and native storage must consume the same identities rather than run competing state machines.
2. How each repository/store selects its active backend and generation/epoch; how a legacy participating client discovers selection or refuses; and how mutation, recovery, snapshot/index publication and child commits are admitted during quiescence/import/cutover.
3. That activating native ownership cannot automatically fall back to TS writes after a daemon disconnect. Preserve work and report unavailable/recovery-required until the same authority is recovered or an explicit ownership-safe transition completes.
4. How rollback after native writes differs from abandoning an import before cutover. Restoring a stale TS snapshot is not a safe rollback of an active native epoch. Include schema/protocol compatibility for packed old/new clients, typed version refusal and public SDK compatibility behavior.

An implementation may choose a simple per-repository exclusive migration lock and fail-closed legacy-client policy; the review does not require a new distributed system. The scope is cooperating Openbuff writers. Ordinary user/external editor writes remain governed by captured-basis conflict detection, not falsely prevented by an SDK fence.

**Required proof:** Add an old-TS-client/new-native-client adversarial fixture, including a previously live/detached holder. Kill before import, during import, immediately after cutover and after a native commit. Resume with client version skew and a daemon outage. Assert one admitted writer, rejection of stale backend/fence, original identities and receipt hashes, preserved originals/conflicts, and no silent TS fallback. Exercise the actual SDK/runtime adapters, not only native store calls. Attach this proof to B22 and the relevant installed client cells.

**Principle violation unless repaired:** Principles 2 and 3 promise authority-boundary confirmation and recovery from verified state. A native token used only inside one backend does not satisfy those principles across the transition.

### ARCH-2 — P1: Align migration and atomicity claims with the contracts that establish them

**Affected:** B05/B06/B07/B15/B16/B22; R3/R4/R9; historical P2-T5/P4-T3/P4-T4/P6-T5/P6-T6a.

**Evidence:** B22 promises exact import/export from “corrected TS stores” and native commit/CAS on actual files, but its only prerequisites are B04/B15/B21 (PLAN.md:95, :326–330). Its transitive prerequisite set is B02/B03/B04/B15/B18/B19/B20/B21; B05 and B07 are absent. B07 explicitly says B22 consumes its corrected contract (PLAN.md:176). The omitted repairs provide exact bytes, expected after-state, durable admission, conditional contained recovery and nonterminal recovery-required state (B05/B07; findings/06-edits.md:26–28, :38, :42).

B06 also says declaration+consumer+resource rename applies “atomically or all stay untouched,” while depending only on B03/B05 (PLAN.md:79, :166–170). Current coordinated editing has atomic preflight and **visible sequential commit**, not general multi-file filesystem atomic visibility (findings/06-edits.md:9). Complete semantic preflight does not itself repair stale ownership or make crash/foreign-divergence recovery atomic.

**Concrete revision:** Name the exact stores and guarantee levels being graduated:

- If initial B22 owns only a new journal/job/lease registry and fenced commit API, say so; leave legacy transaction-intent import and production recovery consumption gated on accepted B07/B05. Likewise gate any production child-lease migration on the B16 integration proof, or explicitly own and test that integration inside B22.
- If B22 initially imports/migrates transaction intents and recovery authority, add B07 as a prerequisite. B07 already carries B05/B03/B04. Preserve the early exec→minimal-daemon path by staging this import rather than silently accepting unrepaired transaction semantics.
- Define B06's first proof as complete, versioned, zero-write refusal during preflight plus guarded sequential execution through the selected coordinator. Require B04/B07 for stronger ownership/recoverability graduation, or state an explicit supported coordinator prerequisite. Do not promise instantaneous multi-file atomic visibility to unrelated external writers. Partial/uncertain mid-commit outcomes must retain evidence and conflicts under R1/R3/R4.

**Required proof:** Before native transaction import, seed a legitimate uncertain legacy intent plus foreign divergence, a replaced parent, and a once-failing restoration. Import/restart must preserve foreign/outside bytes, exact byte hashes and retryable unresolved paths. For B06, distinguish unsupported/malformed complete-intent refusal (zero writes), successful declaration+consumer+resource change, and failure/crash during sequential application with truthful partial/recovery state. Validate the changed dependency graph and every claimed readiness tier.

**Principle violation unless repaired:** Principles 2, 3 and 5 require verified bytes/ownership and task-specific outcome evidence. The current graph allows a consumer to claim a corrected recovery contract before its producer has passed, and uses “atomic” beyond the demonstrated boundary.

## Strongest steelman against Option A

Option B deserves more weight than a generic “native work may be faster” argument. Fail-closed B04 is an appropriate immediate safety repair, but a killed/unknown owner can strand mutation or indexing until explicit resolution. That is a liveness cost for the everyday interrupted/concurrent task families, not merely an implementation inconvenience (B04; F4/F5; findings/05-durability.md). Under A, several TS ownership domains are repaired and then migrated while ACP, children, recovery and future lanes consume them. Each additional client increases the number of paths that must obey the eventual cutover.

A dedicated early native lane can reduce this transition surface: establish a minimal versioned exec/owner/store boundary, use real OS-held exclusion, and have subsequent clients consume one durable lease/job/journal authority. It preserves immediate B02/B03/evaluator truth repairs; it does not rewrite model reasoning in Rust. This directly serves D42/D50/D51 and the user's desire for long-running, shareable body capabilities. If interruption/concurrency is the dominant real workload, reducing the time spent on provisional TS ownership can be more valuable than finishing more unrelated client/memory defects concurrently.

The counterargument has a limit: a daemon cannot reconstruct discarded bytes, decide whether an arbitrary external effect occurred, or repair an erroneous MCP projection. Native-first interfaces fixed before these producer/consumer semantics are known can fossilize defects. Option A remains reasonable after ARCH-1/ARCH-2 because its immediate repairs are independently valuable and define what the native service must preserve (B02/B03/B05/B07/B15/B28; findings/06-edits.md:48; findings/09-execution.md, final repair recommendation).

## Tradeoff tensions and synthesis

| Tension | A earns | B earns | Recommended resolution |
|---|---|---|---|
| Safety versus crash-recovery liveness | Immediate B04 refuses ambiguous ownership without an unproved takeover | OS-held native exclusion can reclaim after real owner death | Accept B04 as a declared safety tier; do not describe it as recovered liveness. Graduate reclamation only at B22 with mixed-client proof |
| Repair throughput versus transition duration | Three independent B02/B03/B04 lanes address observed current defects | A persistent native lane reduces the provisional ownership lifetime | Keep the initial queue, then reserve a bounded native lane once its minimum context/scope prerequisites are available; V rotates within the four-slot limit |
| Small native contract versus complete launcher/platform integration | Common TS context repairs expose existing semantic losses | A minimal native owner can stabilize authority before all adapters multiply | Separate named prerequisite milestones from full matrix graduation; retain unavailable cells and corrected-store import gates |
| Broad generic language reach versus trustworthy deep support | Generic actions keep unknown projects usable | Actual installed parser/server/compiler and interface proofs give depth | Keep operation-specific tiers, real B/C interfaces and unknown D; expand depth on demonstrated task demand, not authored-language count |

The synthesis is **A's immediate truth repairs plus B's deliberately bounded ownership milestone**. Start B02/B03/B04 as written. Prepare the native protocol/backend-selection contract early. After the minimum effective execution context and truthful process-scope adapter exist, use the actual one-shot Rust role, then boot the smallest native journal/job/lease owner. Stage imports behind their actual corrected-store contracts. Maintain TS full-access usability throughout, without advertising native fencing for a cooperative fallback.

The direct B21→B22 edge is present and valid. It is not, by itself, proof of an early small native milestone: B21 currently waits for all-launcher B19/B20 and includes new selected Linux enforcement work, while B22 combines stores, commits, migration and jobs (PLAN.md:296–330). If that breadth threatens the native lane, split named readiness milestones/cards and teach the dependency validator about them. Do not mark a whole card accepted on a partial milestone. Alternatively retain the current full gates and state their scheduling cost honestly. This is a scope/scheduling recommendation, not a third mandatory blocker.

## Additional bounded improvements

1. **Enumerate semantic operation and replay support.** B06 should list support/refusal for TextDocumentEdit/versioned and unversioned edits, CreateFile, RenameFile, DeleteFile, options/annotations, conflicting operations and position encodings. Unsupported members must refuse the complete transaction before effects. B15/B29 should identify the resumable durable prefix and nondeterministic inputs that must be recorded or make continuation unavailable. A bundle preserves executable code, not an arbitrary live JS heap, module mutable state or an unjournaled model decision. Add changed-bundle and nondeterministic-state refusal controls; keep explicit journal replay and no universal exactly-once promise (SPEC.md:82–92, :115; B06/B15/B29; 06-F6/05-F2/10-F5).

2. **Keep full-access/model choice through the actual consumer.** The language and policy tables correctly retain BYOK, explicit routes, optional narrower enforcement and host-trusted modules. B19/B29 fixtures should include a custom strategy using normal full access, an explicitly required unavailable profile, and a model/user-selected route overriding a recommendation. A host statechart supplies lifecycle guarantees; it must not prescribe the model's task strategy or silently reinterpret a template as enforced authority (SPEC.md:7–9; B18/B19/B29/B31).

3. **Define admission on incomplete usage.** B09 correctly reports observed/estimated/incomplete cost, failed attempts, reservations and possible remote overshoot. Record the selected policy when usage or pricing is unavailable: conservative reservation, explicit estimation/degraded cap, or refusal of further capped requests. Test that unknown cost cannot reset spend or authorize unbounded retry/restart admission. This need not invent an exact remote-billing promise (SPEC.md:78; B09/B31).

4. **Keep learning workflow proof distinct from empirical improvement.** The deterministic no-promotion/application/rollback fixture can graduate the plumbing. Held-out quality claims require actual eligible paired attempts, per-language strata, predeclared margin/power/confidence and complete costs. B31's dependence on the full B27 joined-language milestone is defensible for a broad polyglot promotion claim, but should not delay simple no-promotion plumbing if the scope is explicitly narrower. Retain the current rejection of nonfinite statistics and shared-lesson cleanup (B30/B31; SPEC.md:137–139).

5. **Clarify toolchain bootstrap and one cross-reference.** New rusqlite/OS-enforcement dependencies require a lockfile/toolchain acquisition step before locked/offline acceptance can run; installed assets/server/Blender cells require the declared manifest. Missing dependencies remain unavailable evidence, not a pass. SPEC.md:21 refers to “B35 PTY gate”; PTY is G-PTY, while B35 is 3D. Fix that reference without adding a PTY implementation commitment.

## Deliberate verification viability

The three pre-mortems are substantive: false success across clients, foreign overwrite/duplicate effects/hidden living processes, and polyglot/learning expansion masking regressions. Each names triggers, affected cards, controls and stop rules. The expanded test plan covers unit/property, offline integration, real process/filesystem faults, installed/native consumers, target-language e2e, long-session/evaluation and observability (PLAN.md:480–503). It should be retained.

The proposed oracles discriminate real defects rather than merely mirroring implementation:

- D/G/K/J defines a fault envelope with observed scope exit, no late marker and retained cleanup authority. A living covered descendant fails the selected enforced limit. Escaped work outside a cooperative tier is disclosed; wider guarantees require real OS scope tests. B04's fail-closed safety acceptance and B22's authoritative crash reclamation are deliberately different (SPEC.md:73–78; B04/B20/B21/B22).
- The memory fixture fixes values, negation, decision/rationale, original 32-KiB result hashes, compaction count and fresh-process recall. Rolling quota/expiry and keep-until-delete are distinct; over-quota pins cannot promise bounded indefinite retention. Prompt, artifact bytes and SQLite overhead are measured separately (SPEC.md:94–104; B12–B14).
- Schema/ABI B/C fixtures have real consumers and owning commands; missing tools, stale generation or a failed consumer prevents joined acceptance. A proves the authored TS/Rust boundary with Python absent. Fifteen parser variants do not certify fifteen independent semantic toolchains (SPEC.md:121–133; B21/B23–B27).
- MCP failures, structured-only/media/resource results and host provenance travel through real SDK/runtime/client/RPC consumers. Installed CLI/SDK/native checks cannot rely on repository ancestry, markers alone or skipped tool rows. Raw start/end/exit/usage/artifact evidence supports the outcome, not the other way around (B28/B32/B33/B35; SPEC.md:135).

ARCH-1/ARCH-2 add necessary cross-backend and guarantee-tier cases to that already strong verification strategy. Observability should carry backend/epoch, import phase, original identity, effective enforcement, action/run/task outcomes, basis and retention cutoff without turning implementation metadata into an unnecessary product approval flow. Local opt-in telemetry and bounded receipts are adequate; OTel, Parquet and DuckDB are correctly conditional.

## Handoff to the independent Critic

The recommended direction is architecturally viable after the two required revisions. Preserve the 120 historical dispositions and current evidence limits; do not transfer checkboxes or relabel diagnostic probes as repaired product evidence. Keep source/publication completion distinct from installed/live readiness.

The next Planner revision should record explicit resolutions for ARCH-1 and ARCH-2, update dependency/milestone semantics and the relevant fixtures, and retain the steelman and tradeoff costs in the ADR. The independent Critic must then assess the revised plan against the full user objective, requirement coverage, principle/option consistency, command/link validity and verification quality. This report is not self-approval of that gate.
