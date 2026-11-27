# 03 — Orchestration as a model body

The shipped orchestrator has real delegation, process supervision, typed receipts and content-bound review gates. Its chief current weakness is inconsistent terminal state: a cost stop can reenter correction forever, while generator exceptions or aborts can be published as completed. Both findings were reproduced through the real runtime with injected dependencies and zero provider/network calls.

Snapshot: `ec141833a7efa94cd25b0e2c964fc2c832ce5983b2446c03769515032360deb0`. Examined 36 current inventory files in 83 exact windows. All eight domains were considered. Scope receipt is not a claim of whole-feature correctness.

## Confirmed findings

### 03-F1 — HIGH: Cost-budget stops reenter missing-output correction without consuming the step cap

**Trigger:** Run a prompt-only non-reviewer template with outputSchema, no output, default maxMissingOutputRetries, maxCostCents=0 (or an already exhausted cost cap), and stepsRemaining>0.

**Consequence:** The intended terminal budget stop becomes an unbounded retry cycle with no LLM call and no step consumption. It repeatedly grows/compacts message history and occupies the run until cancellation; a fixed step cap does not bound it.

**Evidence:** `packages/agent-runtime/src/run-agent-step.ts:681` — Pre-budget return sets shouldEndTurn=true without hitStepCap or consuming stepsRemaining.; `packages/agent-runtime/src/run-agent-step.ts:3291` — Non-reviewers default to no maximum missing-output retries.; `packages/agent-runtime/src/run-agent-step.ts:3309` — Correction suppresses only hitStepCap stops; it cannot distinguish budget termination.; `packages/agent-runtime/src/run-agent-step.ts:3348` — Correction resets shouldEndTurn=false, causing another pre-budget short circuit.; `packages/agent-runtime/src/__tests__/loop-agent-steps.test.ts:2573` — Existing test explains why step-cap retries must not be resurrected, but covers ordinary provider steps rather than cost stop.; `/home/ben/Code/CLI/openbuff/.omx/drafts/openbuff-body-review-2026-11-05/evidence/03-orchestration-probes.json:8` — DI probe observed 3 cost-stop messages, 2 correction messages, zero provider calls, and stepsRemaining still 1; only probe-supplied abort ended it.

**Suggested fix:** Carry a typed terminal reason from runAgentStep through loopAgentSteps and programmatic steps. Treat budget/step/cancellation stops as terminal incomplete outcomes and run schema correction only after model-requested completion; do not merely add another arbitrary retry limit.

**Acceptance probe:** Run the provider-free probe setup with one available step, unset output and maxCostCents=0, remove its observation-triggered abort, and assert one budget stop, zero provider calls, bounded messages, a naturally returned incomplete result and no successful terminal marker. Also cover a cap crossed after one real DI provider step and reviewer/non-reviewer variants.

Domains: correctness, error-handling, performance, test-coverage, api-contract. Confidence: high; basis: evidence.

### 03-F2 — HIGH: Caught handleSteps errors and aborts are journaled and receipted as completed

**Trigger:** A programmatic generator throws, yields an invalid operation, or encounters an execution rejection inside the main runProgrammaticStep catch. A genuine parent abort thrown there follows the same path.

**Consequence:** The error text is visible, but the machine contract says success: journal replay treats the run as cleanly complete and the parent can receive a completed/ok receipt with no errors. A cancellation can likewise be recorded as completed, undermining task continuation and supervision decisions.

**Evidence:** `packages/agent-runtime/src/run-programmatic-step.ts:749` — Catch sets endTurn=true for all errors, appends an assistant error string and stores output.error.; `packages/agent-runtime/src/run-programmatic-step.ts:794` — It returns the normal programmatic result without propagating a failed/cancelled terminal reason.; `packages/agent-runtime/src/run-agent-step.ts:2855` — The caller interprets endTurn as normal shouldEndTurn.; `packages/agent-runtime/src/run-agent-step.ts:3352` — The loop breaks normally on that flag, bypassing failure/abort catch.; `packages/agent-runtime/src/run-agent-step.ts:3664` — Normal exit writes a terminal completed step boundary.; `packages/agent-runtime/src/run-agent-step.ts:3678` — Normal finishAgentRun is status completed.; `packages/agent-runtime/src/tools/handlers/tool/spawn-agent-utils.ts:2772` — Without an explicit terminal failure, a non-mutation child defaults to completed.; `packages/agent-runtime/src/supervision/child-entry.ts:987` — Supervised successful-loop settlement uses the same runtime receipt derivation.; `/home/ben/Code/CLI/openbuff/.omx/drafts/openbuff-body-review-2026-11-05/evidence/03-orchestration-probes.json:25` — DI exception probe observed completed finish, terminal completed journal, and completed/ok/errors=[] child receipt; abort probe observed the same successful finish with parent signal aborted.

**Suggested fix:** Use an explicit programmatic success/failure/cancellation result or rethrow into the loop terminal handler after preserving current state. The loop must finish as failed/cancelled, preserve pending work, avoid a successful terminal journal marker, and make runtime child receipts derive from that authoritative outcome.

**Acceptance probe:** Change the diagnostic exception/abort probes to require failed/cancelled finish statuses, no terminal completed boundary, and child receipts with failed/cancelled status and a typed error. Extend to a rejected awaited tool, partial edits before error, and real supervised bridge settlement; keep an ordinary successful generator control case.

Domains: correctness, error-handling, state-mutation, test-coverage, api-contract. Confidence: high; basis: evidence.

## Capabilities and maturity

Maturity and assurance are independent. Existing tests cited below were inspected unless explicitly identified as the three executed diagnostics.

| Capability | Maturity | Assurance / practical boundary |
|---|---|---|
| main-agent-selection-and-resumed-orchestration | usable | static trace; Full SDK resume/replay and provider selection are assigned elsewhere. |
| programmatic-generator-lifecycle | partial | static trace + 2 DI/stub-only runtime failure probes; 03-F2: errors are turned into endTurn=true and then a normal completed run. |
| foreground-and-background-delegation | usable | static trace; cited existing tests inspected, not executed in this shard; Foreground/background full success and fault-injection suites were not executed here. Receipt fidelity inherits 03-F2 for caught generator failures. |
| typed-handoffs-and-child-receipts | partial | static trace + DI/stub-only receipt probe; 03-F2 means the status contract is not authoritative on every runtime exit. |
| child-permission-and-path-narrowing | usable | static trace; cited existing tests inspected, not executed in this shard; This is template and handoff authority, not a complete operating-system or terminal-sandbox security review. |
| process-supervision-and-bounded-crash-restarts | partial | static trace; cited existing tests inspected, not executed in this shard; Node and Windows use the in-process fallback; this is an intentional runtime capability boundary, not an unwired Linux implementation. |
| parent-and-user-cancellation | partial | static trace + DI/stub-only cancellation probe; 03-F2: cancellation raised from inside the active generator can be misclassified. |
| cost-token-and-fixed-step-budgets | partial | static trace + DI/stub-only cost-stop probe; 03-F1: stop cause must be preserved through the output-correction and programmatic layers. |
| dirty-scope-and-content-bound-final-review | usable | static trace; cited existing tests inspected, not executed in this shard; A review is still model attestation; static file-byte matching is not semantic proof that a requirement was implemented. |
| requirements-coverage-and-model-task-autonomy | partial | static trace; cited existing tests inspected, not executed in this shard; The gate proves approval of the current edit set, not completion of every user objective. This distinction should remain visible in API status. |
| durable-gate-credit-and-pinned-open-work | usable | static trace; cited existing tests inspected, not executed in this shard; Full memory compaction/retrieval and durable journal replay were assigned elsewhere. |

### Existing strengths

- The final reviewer is actually spawned by base2. Frozen scope and file bytes are checked again before approval; durable reuse requires current content, including creditable deletions. This makes review credit useful to a model choosing its next action.
- Spawn prevalidation and atomic detached-job allocation avoid invisible partial batch launches. Settlement explicitly folds child evidence and pairs receipts with spawn events; path leases are acquired before launch bookkeeping.
- Process supervision is wired in the SDK and supports compiled Bun POSIX self-exec. The bridge carries real callback dependencies, child requests live in owner-only files, and parent abort triggers process-group teardown.
- Parent Git/operator requirements do not become source-repair targets. Declared workflow continuation remains model guidance, which is appropriate when the model supplies semantic task intelligence.
- General audit agents cannot satisfy persistence simply by writing convincing final prose; their receipt requires a successful snapshot-bound findings artifact.

## Vertical traces and operational states

### main-agent-selection-and-resumed-orchestration

mainPrompt(action) → agentId/costMode template selection and loopAgentSteps → SDK prompt action passes the existing mainAgentState → resumed loop setup in loop-agent-steps.test.ts; selection-specific cases not inspected → docs/request-flow.md:118-157

**failure:** unknown explicit agent and missing selected template throw actionable errors; **loading:** loop rebuilds the prompt on agent-type change; **empty:** optional prompt is passed through; no separate empty-objective contract inspected; **cancellation:** same caller signal passes into loopAgentSteps; **retry:** no silent agent substitution for invalid explicit agent; **permission:** template resolution determines the tool/spawn surface

Gaps: Full SDK resume/replay and provider selection are assigned elsewhere.

### programmatic-generator-lifecycle

loopAgentSteps -> runProgrammaticStep → persistent per-run generator, STEP/STEP_ALL/GENERATE_N and tool yields → base2 and general-agent handleSteps; the next LLM step consumes yielded context → run-programmatic-step.test.ts:1035-1077; evidence/03-orchestration-probes.test.ts → docs/request-flow.md:131-154 and docs/agents-and-tools.md:515

**failure:** invalid yields, generator exceptions, and tool errors are caught but lose their failed terminal status (03-F2); **loading:** generator is retained across STEP/STEP_ALL instead of restarted; **empty:** missing structured output is corrected only for prompt-only templates; **cancellation:** ordinary loop abort is recognized; generator-caught AbortError can falsely complete (03-F2); **retry:** programmatic iterations have a local guard; generators are not restarted by output-schema correction; **permission:** untrusted stored executable strings are refused; yielded tools must be declared

Gaps: 03-F2: errors are turned into endTurn=true and then a normal completed run. A generator execution cap does not bound loops that repeatedly yield STEP after a budget stop.

### foreground-and-background-delegation

spawn_agents and spawn_agent_inline → whole-batch prevalidation; foreground allSettled; detached jobs and reconciliation → base2 reviewer/repair/writer spawns and model-issued discovery work → spawn-process-supervision.test.ts and spawn-settle-fault-injection.test.ts were located; output/abort tests and inline consumer were read → docs/agents-and-tools.md:517 and concurrent gate isolation section

**failure:** invalid later batch entry is rejected before detached children launch; failed children retain failed receipts; **loading:** subagent start/tool/result chunks carry nesting identity; **empty:** empty child output is a retryable typed miss; zero-child batch behavior was not probed; **cancellation:** background job controller and combined parent signal are wired; **retry:** scheduler explains bounded capacity rejection; caller joins/cancels before more launches; **permission:** template prevalidation and workspace path leases precede launch

Gaps: Foreground/background full success and fault-injection suites were not executed here. Receipt fidelity inherits 03-F2 for caught generator failures. Terminal-process broker/workspace lane isolation and background resume delivery are outside this shard.

### typed-handoffs-and-child-receipts

versioned handoff on spawn tools → strict v1 schema, capability derivation, normalized runtime receipt → spawn settle reconciles task memory and spawn_finished/receipt_reconciled ledger events → spawn-agent-utils-output.test.ts:1063-1187,1558-1685; diagnostic generator-error receipt probe → docs/agents-and-tools.md:579-695

**failure:** missing_output/schema_invalid/truncated/crashed are distinguished, but caught handleSteps failure becomes completed/ok (03-F2); **loading:** receipt appears when child settles; interim chunks are observational; **empty:** null/no harvested answer is downgraded to partial with retryable error; **cancellation:** schema supports cancelled; aborted generator can bypass that status; **retry:** retryability is explicit for missing output/schema rejection; **permission:** claims of changed files are compared with runtime mutation attestations

Gaps: 03-F2 means the status contract is not authoritative on every runtime exit. General-agent can be credited from a non-empty final answer without task_completed; task completion remains model judgment except strict audit persistence.

### child-permission-and-path-narrowing

validateVersionedAgentHandoff -> deriveSpawnTemplateCapabilities → tool ceiling, filesystem-pattern narrowing and plan-only inheritance → foreground/inline templates and tool execution checks → capability tests were not expanded beyond the selected output tests; static consumers were read → docs/agents-and-tools.md:579-595 describes reviewer contracts; selected gate-lifecycle.e2e.test.ts:288-310 supplies the least-privilege repair example. Full permission documentation was not traced.

**failure:** legacy/incomplete handoff and attempted tool widening fail with actionable messages; **loading:** narrowing occurs before launch; no partially launched child; **empty:** empty permissions preserve static scope by explicit convention; they do not mean deny-all; **cancellation:** no independent permission-cancellation policy; **retry:** same invalid request cannot widen authority through retry; **permission:** model-visible tools and requested file paths narrow; static hidden programmatic tools retain their own ceiling

Gaps: This is template and handoff authority, not a complete operating-system or terminal-sandbox security review. Empty lists mean preserve authority; callers that need deny-all require an explicit contract.

### process-supervision-and-bounded-crash-restarts

SDK getAgentRuntimeImpl default-supervision policy → buildDefaultSpawnSupervised -> process supervisor -> child-entry with parent RPC bridge → executeSubagent selects supervised or in-process route; validated supervised receipt enters existing settle chains → real-process supervised-bridge-e2e.test.ts:1-143 inspected; routing tests located; not executed here → SDK source comments and supervised-spawn module contract

**failure:** unsupported bridge deps and invalid/missing child envelopes settle honestly; transport crashes may restart; **loading:** fresh owner-only sandbox, ready bridge, then process launch; **empty:** missing_output/schema_invalid/truncated are not transport-crash restarts; **cancellation:** parent signal kills the child process group; pruner deliberately stays in-process; **retry:** SDK requests up to three restarts; backoff and fresh per-attempt sandbox are real; explicit deadline restarts can multiply spend; **permission:** allowlisted child environment, 0700 directory, 0600 request file and parent-owned tool/LLM bridge

Gaps: Node and Windows use the in-process fallback; this is an intentional runtime capability boundary, not an unwired Linux implementation. No default wall-clock deadline is imposed. Explicit bounds are supported. No real process/compiled-binary/grandchild-reaping tests ran in this shard. Context-pruner requires shared in-memory state and is explicitly exempt from process isolation.

### parent-and-user-cancellation

loopAgentSteps.signal and background-agent cancel operation → loop abort checkpoints, background controller, supervised process-group teardown → SDK turn cancellation and nested child execution → loop-agent-steps-abort.test.ts:1-176 inspected; generator-abort diagnostic probe executed → supervised-spawn.ts module contract and background-job cancellation comments

**failure:** normal AbortError uses cancelled; caught programmatic AbortError follows completed path (03-F2); **loading:** running child/job remains visible and has a cancellation target; **empty:** unknown job cancellation returns actionable error; already settled cancel is idempotent; **cancellation:** parent and job signals combine; supervisor uses SIGTERM then SIGKILL; listeners removed at settlement; **retry:** aborted parent prevents normal crash restart loop continuation; **permission:** job cancellation is owner-scoped in the surrounding API; full ownership handler was not inspected

Gaps: 03-F2: cancellation raised from inside the active generator can be misclassified. Real shell-grandchild cleanup and terminal job cancellation are outside executed evidence.

### cost-token-and-fixed-step-budgets

template maxCostCents/maxTokensPerTurn and AgentState.stepsRemaining → pre-provider cumulative cost check, post-step cost/input check and explicit step-cap signal → runAgentStep -> loopAgentSteps -> handleSteps and structured-output correction → budget-enforcement.test.ts:1-27,300-410 are helper tests; loop-agent-steps.test.ts:2573-2643 tests ordinary step-cap retry; diagnostic budget probe executes actual loop → budget-enforcement.ts:88-124 describes actual semantics and incomplete-stop message

**failure:** cost stop is folded into generic turn-complete; missing-output correction can spin (03-F1); **loading:** near-step-cap checkpoint nudge is emitted once; **empty:** unset output with cost budget 0 triggered repeated stops without provider calls or step consumption; **cancellation:** external abort terminates the demonstrated loop; a natural budget termination did not; **retry:** step-cap stops are guarded; budget stops are not guarded in generic correction; **permission:** limits are caller/template controls; no hidden default hard repair cap

Gaps: 03-F1: stop cause must be preserved through the output-correction and programmatic layers. Cost is checked after a step has spent it and therefore is a soft cap. Input-size cap does not measure cumulative run tokens. No shared pre-spend reservation across concurrent children or supervised crash attempts was established in this shard.

### dirty-scope-and-content-bound-final-review

base2 sees completed model STEP after edits → validation hooks, frozen dirty scope, reviewer attestation, repair, live content check → canSuggestFollowups/final-response state and commit guard for task-owned dirty files → gate-lifecycle.e2e.test.ts:134-310; deterministic gen.next tests, not full provider E2E → docs/request-flow.md:258-301; docs/agents-and-tools.md:531-597

**failure:** hook/reviewer/attestation problems keep work pending; infrastructure bypass is explicit snapshot-bound user authority; **loading:** gate progress is durable and published before reviewer launch; **empty:** no reviewable sources gets an explicit skip; unreadable content never grants durable credit; **cancellation:** pending state survives an interrupted turn, subject to the terminal-state bug in the runtime kernel; **retry:** one reviewer-protocol repair retry; source repair uses progress/cycle guards and optional caps; **permission:** concurrent foreign dirty paths are not absorbed solely because a terminal command ran

Gaps: A review is still model attestation; static file-byte matching is not semantic proof that a requirement was implemented. Full bypass parser, auxiliary specialist waves, hook executor, and filesystem broker were not fully audited here.

### requirements-coverage-and-model-task-autonomy

structured reviewer fields and declared workflow todos → hard in-scope requirement/coverage rules and soft parent workflow continuation notice → base2 chooses repair/re-review versus current-edit finalization; intelligent model owns remaining parent duties → gate-lifecycle.e2e.test.ts:1084-1259 explicitly distinguishes parent-owned and in-scope gaps → docs/agents-and-tools.md:599-686

**failure:** in-scope missing requirements, blocked dimensions and missing coverage remain blockers regardless of LOOKS_GOOD; **loading:** remaining declared workflow appears in pinned state and gate-pass message; **empty:** no declared todos leaves the normal finalization message; **cancellation:** model may stop with a stated concrete reason; no whole-objective completion oracle was established; **retry:** remaining implementation causes further edits and rearmed gates; parent-only duties are not sent to repair-editor; **permission:** commit/push/operator work is left to the parent and applicable user authority

Gaps: The gate proves approval of the current edit set, not completion of every user objective. This distinction should remain visible in API status. Selected docs still describe unconditional writer predicates and an old default docs target; the current source uses request-conditioned writers and source_files only. Project command fallback has language heuristics; manifest/environment command-quality evidence belongs to the polyglot/environment shard.

### durable-gate-credit-and-pinned-open-work

resumed base2ActiveWork on a new turn → JSON-safe state, per-file markers, exact fingerprint reuse and pinned unresolved snapshot → next base2 loop and model context following compaction/resume → selected gate lifecycle asserts durable blocker state; full serialization/replay tests were not expanded → docs/request-flow.md:264-296 and docs/agents-and-tools.md:527-529

**failure:** legacy/missing fingerprint and unreadable markers refuse reuse; pass resets retry and specialist ledgers; **loading:** pinned gate progress sends deltas when only the progress line changes; **empty:** clean idle/no unresolved work emits no pinned block; **cancellation:** pending file and blocker state survives turn interruption; journal replay engine is out of scope; **retry:** same-files reuse requires exact fresh content fingerprint; new bytes reopen; **permission:** commit/follow-up affordances stay blocked while task-owned dirty reviewable work remains unvalidated

Gaps: Full memory compaction/retrieval and durable journal replay were assigned elsewhere. Pinned state makes required work available to the model; it cannot guarantee the model semantically uses it.

## Domain assessment

| Domain | Assessment |
|---|---|
| security | Inspected strict handoff validation, template ceilings, read-only plan inheritance, executable-string trust gate, owner-only supervision files/environment, and cancellation cleanup. No concrete exploit is established. Static hidden programmatic authority remains separate from handoff model-visible tools; broker/sandbox enforcement and full RPC attack surface were not audited. |
| correctness | 03-F1 and 03-F2 are dynamically confirmed on the real loop with injected dependencies. Current final-review scope/byte checks and strict missing-output receipt classification are substantial correctness strengths. |
| state-mutation | Generator and signal cleanup, atomic batch job allocation, path-lease ordering, event reconciliation, per-file pass state and ledger resets were inspected. 03-F2 creates incorrect completed journal/state transitions on failures. No broader race claim or full workspace-lane verification is made. |
| error-handling | Actionable prevalidation and typed child transport failures are wired. 03-F1 misroutes terminal budget stops into correction; 03-F2 consumes programmatic exceptions before failed/cancelled handling. Real retry backoff and explicit optional deadlines exist; default unbounded child lifetime is intentional. |
| performance | Batch clone caching, bounded background concurrency, bounded receipt/ledger mechanisms, progress-delta pinning, parallel foreground settlement and marker reuse were observed. 03-F1 can grow history and keep CPU/context work alive without provider progress. No latency, throughput or memory benchmark was performed. |
| dependency-hygiene | Read agent-runtime and agents manifests. Bun 1.3.5 is declared and used for the probes; runtime dependencies include workspace common, ai range, tokenizer ranges and pinned schema bridge library. Lockfile/advisory/pruned-install auditing was not done, so no package vulnerability or isolated-install claim is made. |
| test-coverage | Existing typed receipt, step-cap output correction, abort and deterministic generator gate tests were read; real-process bridge tests were inspected but not run. The selected budget suite is helper-only, despite its picker label. New /tmp DI probes reproduce the missing budget-stop discriminator and failure-to-completion propagation; normal gateway/provider end-to-end assurance remains separate. |
| api-contract | Strict v1 handoffs/receipts and additive optional fields preserve explicit wire shapes. 03-F1 violates the terminal budget control contract and 03-F2 violates completed/failed/cancelled meaning, even while schemas parse. Default Bun POSIX self-exec support is current; stale SDK/docs wording and request-conditioned writer semantics should be aligned with source. |

## Verification

Three bounded diagnostic tests passed on Bun 1.3.5. They assert the observed defects, not corrected behavior. The budget probe supplied its own cancellation after three repeated budget stops; both error probes naturally returned completed status. No provider/network call or source change occurred.

Probe source: `/home/ben/Code/CLI/openbuff/.omx/drafts/openbuff-body-review-2026-11-05/evidence/03-orchestration-probes.test.ts`. Probe observations: `/home/ben/Code/CLI/openbuff/.omx/drafts/openbuff-body-review-2026-11-05/evidence/03-orchestration-probes.json`.

## Recommended executable work

- **P0 — Define one authoritative terminal-outcome contract for the loop, programmatic steps, journals and child receipts; fix 03-F1 and 03-F2 through it.** A model needs trustworthy body state to decide whether to continue, retry or delegate. Parsing schemas cannot recover a terminal reason that the runtime discarded. Acceptance: Natural budget return is bounded without an injected abort; generator exceptions/aborts cannot publish completed journal/receipt status; pending task state remains resumable.
- **P1 — Promote the /tmp probes into targeted runtime regressions and add a provider-free vertical generator -> tool -> spawn -> parent receipt matrix.** Helper checks and gen.next gate tests are useful but missed the cross-layer terminal-state contract. Acceptance: Cover successful generator, thrown/rejected tool, failure after an edit, unset/schema-invalid/truncated output, zero/crossed budget, user abort while awaiting work, foreground/background and supervised settlement.
- **P1 — Make budget semantics and supervision support machine-readable and consistent with documentation. Decide explicitly whether a configured cost limit is a soft post-step cap or a shared pre-spend reservation.** Do not promise run-wide cost/token/isolation properties from limits that currently mean something narrower. Acceptance: The API reports per-step input versus cumulative tokens, per-attempt timeout/restart multiplication and Bun/POSIX versus Node/Windows process support; if hard aggregate limits are offered, concurrent children and restarts share measured reservations.
- **P2 — Keep semantic task decisions in the model, while separating current-edit gate credit, remaining declared workflow and authoritative runtime termination in the control plane.** The existing soft continuation notice is an appropriate autonomy boundary, but runtime status must describe it faithfully. Acceptance: A green edit gate does not imply every user objective completed; outstanding model-declared work remains visible without converting parent Git/operator duties into source-repair blockers.
- **P2 — Reduce orchestration maintenance coupling by extracting pure state transitions and generated adapters without changing first-party behavior. Align writer/routing documentation with current request-conditioned source.** The current large inline generator and several return/status surfaces made otherwise strong safeguards inconsistent. This is a maintainability recommendation, not a measured performance claim. Acceptance: Parity and generation freshness remain checked; the same vertical probes pass across base2 modes and custom programmatic agents; docs stop claiming unconditional writers or exclusion of compiled POSIX self-exec.

## Coverage limits

- This is an orchestration vertical slice, not a full-line audit of base2.ts (15396 lines), run-agent-step.ts (3905 lines) or spawn-agent-utils.ts (4566 lines). Exact observed windows are listed; unobserved specialist waves, writer target/command selectors, bypass parsing, output compaction and mutation extraction remain limits.
- All picker-selected ranges were inspected. Adjacent implementation and tests were read only to resolve the terminal-state and wiring hypotheses. Search-only test paths are not treated as full test inspection.
- No provider request, network call, source fix, destructive action or project gate test execution was performed. Three /tmp DI/stub-only diagnostic tests ran on cached Bun 1.3.5 and passed their defect-observation assertions; this does not validate production happy paths.
- The budget probe deliberately supplied cancellation after the third repeated stop to remain bounded. It demonstrates repeatability without step consumption; infinite duration and memory impact are inferred from the unbounded retry condition, not measured.
- Native query_index/read_files audit tools were unavailable in this Codex session. The pinned native inventory and saved picker were used with rg and exact line reads; no unavailable tool call is claimed.
- Provider adapters, context/memory quality, terminal/OS sandbox enforcement, SDK durable replay engine/workspace lanes, external model reliability, release performance and broad dependency advisories were assigned elsewhere or excluded.
- Capability maturity describes implemented current paths, while assurance describes what was actually inspected/executed. Structural receipts do not prove semantic feature completeness or test adequacy.

## Exact read receipt

Full structured receipt, capability evidence and read windows are in `03-orchestration.json`. The windows for the three largest implementation files are:

- `agents/base2/base2.ts`: 450-562, 1150-1205, 1760-2010, 2438-2489, 2510-2555, 2678-2764, 5460-5600, 6220-6380, 7700-7910, 7990-8140, 12076-12205, 13220-13365.
- `packages/agent-runtime/src/run-agent-step.ts`: 469-535, 590-695, 1220-1348, 1570-1685, 2300-2385, 2495-2515, 2820-2920, 3180-3368, 3560-3730, 3810-3856.
- `packages/agent-runtime/src/tools/handlers/tool/spawn-agent-utils.ts`: 312-460, 500-618, 2405-2538, 2614-2801, 2973-3100, 4189-4264.
