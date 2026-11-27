# Openbuff as a model body: capability and implementation audit

Reviewed 2026-11-05–06. Source HEAD: e65c06c0ae783130998bd9ab18c8d35320e40ea8. Native inventory snapshot: ec141833a7efa94cd25b0e2c964fc2c832ce5983b2446c03769515032360deb0.

## Assessment

Openbuff already gives a configured model a substantial coding body: local BYOK inference, streamed tools and subagents, authenticated reads, coordinated edits, lexical/graph retrieval, optional semantic and precise indexes, compiler hooks, persistent memory, browser actions, image and 3D observations, and usable human controls. The main limitation is dependable continuity between those components. Several producers retain useful information that their consumers discard, reinterpret, or credit against a different identity.

The resulting macro gap is broader than an absent feature name. The body cannot yet consistently tell the model which action applied, which run failed or stopped, what remains uncertain after a crash, which observations describe current bytes, and which retained facts should inform the next task. That limits recovery and learning even when individual helpers work. This is a synthesis of the recorded implementation evidence; this review did not measure live model task success or prove a maximum achievable quality level.

The model should continue to own reasoning, strategy and action selection. Deterministic execution, observations, ownership, persistence, selected controls and truthful receipts belong to the body. Existing configurable templates, custom tools and generator workflows are useful strategic freedom. Repairing body contracts should make those strategies cooperate, while preserving the user's local/BYOK choices and intentional full-access execution posture.

[CAPABILITIES.md](CAPABILITIES.md) consolidates all 144 vertical records into 45 capabilities, with maturity, assurance, current gaps and graduation criteria. The ten families below consolidate all 118 finding records. Raw shard labels are 46 HIGH, 69 MEDIUM and 3 LOW; these are recorded classifications, not 118 independent priority units or a severity certification of ordinary CLI use. Triggers include optional services, long-running or concurrent work, stale-lock interleavings, finite limits, packaged assets and explicit recovery paths. Routine functionality and narrow reusable strengths remain visible.

## Scope and evidence

All 13 independent file-picker/auditor pairs completed, exceeding the minimum seven. They covered CLI/TUI; providers; orchestration; memory; durability; editing; languages; indexing; execution; extensions; evaluation/release; audit/docs; and perception. Every active package and all eight audit domains were assigned. [SCOPE.md](SCOPE.md) gives every filesystem top-level directory's disposition; [COVERAGE.md](COVERAGE.md) gives all 18 native subsystem labels and inspected counts.

The native inventory contains 3,056 files. Recovered receipts enumerate 555 unique inspected inventory files. Mechanical checks verify 147,555 unique source/test/doc read-window lines, including selected context in three supplemental files outside the native inventory. The historical review recorded 147,721 lines; a further 166-line interval could not be recovered and receives no inspection credit. These are bounded recorded windows, including tests and documentation, rather than a line-by-line audit of every inventoried file. Large orchestration, storage and browser files were sampled. Every Markdown shard report was read for the original synthesis; the synthesizer used durable findings and artifacts, without rereading implementation source.

Active coverage includes agents, CLI, common, SDK, scripts, evals, docs, root public configuration, .agents, .github, and every packages child: agent-runtime, code-map, indexer, internal and build-tools; Rust is separately covered. Archived agents and generated/local binaries, preferences, workflow state and old runtime/log data have explicit exclusions. Credentials, private provider values and historical raw logs were excluded. Vendored dependencies were context for selected protocol behavior, rather than a complete dependency-source audit.

[REVIEW-VALIDATION.json](REVIEW-VALIDATION.json) records the final mechanical checks for 13 completed pairs and the recovered receipt totals above. [COVERAGE-RESULT.json](COVERAGE-RESULT.json) separates structural inspection coverage from feature readiness. Its native complete=false remains deliberate: 22 heuristic candidate records and the existing coverage helper conflate inspection with feature readiness. An audit must be able to finish after proving an ability absent; a named helper must not make an unimplemented ability ready. Both directions have counterexamples in [12-audit-docs](findings/12-audit-docs.md).

Native inventory identity also excludes active cli/release sources and hashes large-file prefixes. [SOURCE-STABILITY.md](SOURCE-STABILITY.md) and its [machine-readable record](SOURCE-STABILITY.json) retain supplemental read provenance and the comparison of surviving captured windows against current source. The original 558-file full-hash map was not recovered, so full-file equality to the historical inspection cannot be certified. [CURRENT-FILE-HASHES.json](CURRENT-FILE-HASHES.json) binds the current 558 inventory and supplemental files; those fresh hashes are not historical equality evidence. Source HEAD remains unchanged. No source fixes were applied; existing user edits were preserved.

The existing suites provide useful lower-level assurance: 413 indexer tests passed, 28 audit/control-plane tests passed, and 19 Rust tests passed. The code-map run had 154 passes and four resource-path failures; isolated structure tests also failed. Pair 07 subsequently verified current pinned PHP/Swift/Kotlin/GDScript assets and successful parsing/query compilation with explicit assets. Consequently, the supported finding concerns default discovery and publication, rather than a blanket claim that those grammars cannot work.

Offline probes exercise real local SQLite, adapters, framed peers, dispatchers and process behavior with controlled dependencies. A passing diagnostic often asserts the current defect. Provider fixtures make zero external requests; injected judges and vectors do not measure model quality. Selected mutation/index probes ran on installed Bun 1.3.14, while repository suites and other probes used pinned 1.3.5. Platform frequency, live-provider reliability, full installed consumers, killed live CLI recovery, real Blender/browser tasks and held-out learning gains remain unmeasured.

## Ranked families

Ranking weighs effects on user work, the model's next decision and the breadth of affected boundaries. It is not a serial execution dependency: small independent truth, fixture-isolation and smoke repairs can proceed immediately.

### AF01 — Source-preserving mutation and recovery authority

**Priority:** first repair authority that can replace or misattribute user bytes. **Confidence:** high in the demonstrated data/ownership transitions; spontaneous race frequency and power-loss behavior are unknown.

Ordinary read grants, whole-file requirements, pure preflight, conditional mutation primitives and guarded rollback are real strengths. The remaining holes sit at takeover, semantic apply and recovery. A controlled stale-breaker interleaving allowed two commits from one preimage. A semantic edit computed from an earlier read CAS-protected a later snapshot, removing an external append. Interrupted group recovery restored preimages over unrelated divergence, and a failed recovery was marked terminal so the next scan found no pending work.

Byte and operation completeness also vary by edit route: BOM preimages cannot match raw broker bytes; scoped CRLF edits normalize unrelated terminators; malformed LSP positions reach disk; failed peer edits or unsupported resource operations disappear while surviving edits apply. Concurrent snapshot producers can both report creation while one recovery point falls out of the listed chain. A separate index-lock takeover has the same generation-fencing weakness.

Evidence: [06-F1/F2/F4–F10/F12](findings/06-edits.md), [05-F9](findings/05-durability.md), [08-F8](findings/08-indexer.md), [01-F2](findings/01-cli.md); representative anchors are [workspace-mutation-broker.ts:601](/home/ben/Code/CLI/openbuff/sdk/src/services/workspace-mutation-broker.ts:601), [language-intelligence.ts:350](/home/ben/Code/CLI/openbuff/sdk/src/services/language-intelligence.ts:350), and [transaction-intent-log.ts:1249](/home/ben/Code/CLI/openbuff/sdk/src/tools/transaction-intent-log.ts:1249).

The shared fix is end-to-end source and ownership authority: preserve exact preimages, document versions, full operation rosters, expected after-state and fencing generations through every adapter. Admit groups only with their promised durable capacity; retain unresolved recovery until conditional evidence establishes ownership. Graduation requires competing takeover, external-edit, failed-recovery-retry and complete refactor fixtures, with byte equality outside intended changes. Sequential multi-file commit remains an explicit contract rather than an assumed filesystem-wide atomic operation.

### AF02 — Truthful action, run and task outcomes

**Priority:** establish canonical outcomes before adding consumers of success. **Confidence:** high; real runtime/adapter probes establish several misclassifications, while live-model omission frequency is unknown.

A cost stop on a prompt-only template with missing structured output reenters correction without using its available step. The bounded probe required its own cancellation; unbounded repetition follows the loop condition. More directly, a caught generator exception or AbortError returns ordinary endTurn and becomes a completed journal boundary and completed/ok child receipt. The visible error does not repair that machine contract.

The same pattern appears in adjacent consumers: rejected forward and rollback calls become confirmed applied evidence; resolved SDK errors become scored evaluator runs; MCP isError and structuredContent disappear; failed diagnostic capture becomes a passed empty delta. CLI client creation can strand occupancy, and validation exceptions resolve as accepted-looking sends. Browser diagnose loses media, edit-preview errors are labeled rendered, and render_ui acknowledges a render without a host acknowledgement.

Evidence: [03-F1/F2](findings/03-orchestration.md), [06-F3](findings/06-edits.md), [10-F1](findings/10-extensions.md), [07-F7](findings/07-languages.md), [11-F1](findings/11-evals-release.md), [01-F5/F6](findings/01-cli.md), [13-F3/F7/F9](findings/13-perception.md); [run-programmatic-step.ts:749](/home/ben/Code/CLI/openbuff/packages/agent-runtime/src/run-programmatic-step.ts:749), [filesystem.ts:1130](/home/ben/Code/CLI/openbuff/common/src/tools/results/filesystem.ts:1130), [codebuff.ts:125](/home/ben/Code/CLI/openbuff/evals/buffbench/runners/codebuff.ts:125).

Three levels need independent truth: an action's effect/result, a run's terminal reason, and a task's acceptance. A failed action keeps its failure receipt; a task may recover and later pass its oracle. Fatal generator errors, cancellation and hard stops must retain their actual terminal reason. A committed edit can remain applied while preview fails. Tests must include both fatal-path controls and failed-action→successful-recovery controls. Empty, unavailable, refused, partial and uncertain observations need explicit meanings across runtime, journal, SDK, CLI and evaluation.

### AF03 — One durable session owner and executable continuation

**Priority:** repair current journal/ACP ownership before enlarging daemon or lane surfaces. **Confidence:** high in source/DI facts; crash replay and simultaneous destructive effects beyond the fixtures are conditional inferences.

Checkpoint storage preserves bytes and uses an atomic queue, but interrupted main resume mints a fresh run ID unless explicitly pinned. Completed-effect lookup then uses the wrong identity. Programmatic journal wrappers do not cover model-selected dispatch, and absent external acknowledgement cannot distinguish not-executed from executed-but-unrecorded. Parent cleanup closes shared journal handles while detached work can remain live; later appends become no-ops.

ACP has real authenticated transports and redacted projections, but its bridge starts each prompt without previousRun and discards returned state. A nonexistent session can load successfully. Loading a running ID in another connection loses its original controller and admits a second prompt in the DI fixture. Attached TUI readiness additionally checks unrelated local providers. Browser child stamps are replaced with a main owner, creating inferred sibling session interference. Live leases lack renewal; workflow telemetry is skipped because producer/consumer member names differ; replay JSON reads a different assistant-text field.

Evidence: [05-F1–F8/F10](findings/05-durability.md), [01-F3](findings/01-cli.md), [13-F2](findings/13-perception.md); [run-agent-step.ts:1963](/home/ben/Code/CLI/openbuff/packages/agent-runtime/src/run-agent-step.ts:1963), [bridge.ts:754](/home/ben/Code/CLI/openbuff/sdk/src/serve/bridge.ts:754), [acp-agent.ts:886](/home/ben/Code/CLI/openbuff/sdk/src/services/acp/acp-agent.ts:886).

One service/session owner must retain executable state, identities, controllers, live-child journal lifetime and leases while connection sinks change. Effects require durable identities and declared replay policy. Arbitrary shell/MCP/custom effects can remain unobservable after a crash; automatic rerun must wait for reconciliation evidence or an explicit decision. Do not promise universal exactly-once execution. Graduation uses disposable fresh-process fixtures at pre-dispatch, during-effect, post-effect/pre-confirmation and confirmed boundaries, plus live detach/load/cancel exclusion. Manual serve and compiled Bun POSIX child supervision already exist and should be retained.

### AF04 — Fresh, coherent language and retrieval observations

**Priority:** fix generation and identity truth before ranking or ecosystem expansion. **Confidence:** high in deterministic counterexamples; real compiler/server task quality is unmeasured.

The lexical retriever, graph modes, command discovery and optional precision consumers are wired. Their representations can disagree. Failed embedding replacement leaves changed/deleted vectors queryable under new metadata. Scoped candidates can vanish behind an unscoped cap; fair-share walking drops files even when all eligible files fit. Known same-size/mtime changes reuse old hashes; repeated deltas reset the age that should trigger a full safety sweep. Precise edges disappear on routine refresh, and a source-only snapshot cannot fence graph-only adoption.

Language identities have similar losses. Bare-extension family normalization merges unrelated languages, producing a Python→Rust same-name call in a fixture. Truncated SCIP descriptors collide while still labeled precise. Rust crate imports and Go package suffix heuristics select wrong owners. LSP initial open and first edit both use version 1; root/document-ID selection and skipped dirty documents further weaken freshness.

Evidence: [07-F1–F4/F6/F8/F10/F11](findings/07-languages.md), [08-F1/F3–F7/F9](findings/08-indexer.md); [index-manager.ts:663](/home/ben/Code/CLI/openbuff/packages/indexer/src/index-manager.ts:663), [scip-ingest.ts:367](/home/ben/Code/CLI/openbuff/packages/indexer/src/scip-ingest.ts:367), [language-profiles.ts:163](/home/ben/Code/CLI/openbuff/common/src/util/language-profiles.ts:163).

Opaque semantic identity must survive separately from bounded labels. Publish coherent source/vector/graph generations; preserve only hash-matching enrichments; distinguish full reconciliation time from delta liveness. Share LSP document/version authority and mark skipped dirty observations unavailable or reopen them. Package queries alongside WASM and prove semantic output from isolated artifacts. Current pinned grammars work with explicit assets, which narrows the diagnosis. Graduation compares accelerated/scoped retrieval against baseline, tests changed/deleted inputs and stale merges, and follows committed bytes through actual language services.

### AF05 — Knowledge that retains meaning and reaches the next decision

**Priority:** repair canonical capture/injection before adding learning infrastructure. **Confidence:** high from real SQLite close/reopen fixtures; semantic usefulness and model behavior remain unmeasured.

Default CLI selection of sqlite-v2-opt-in reaches preparation, capture and protected prompt injection. Startup and terminal task transitions nevertheless share an event identity, so SQLite rejects the terminal batch and leaves finishing state. A newly prepared task filters out ordinary previous-task observations without reporting degradation. Explicit record_decision rationale and excerpts become generic metadata despite their V1 copy retaining meaning.

Archive retention has a separate collision: newer pre-compaction pointers shadow original eviction bodies for exact-ID recall, although the original still exists. Ranked memory is reordered by JSON before a 12,000-character clip, dropping the most relevant fixture item. Degraded V2 telemetry claims no fallback while actual request construction can inject V1. CLI transcript trimming removes older saved presentation after 100 messages; that finding does not establish SDK model-history loss.

Evidence: [04-F1–F5/F9](findings/04-memory.md), [01-F7](findings/01-cli.md); [coordinator.ts:2145](/home/ben/Code/CLI/openbuff/sdk/src/services/memory-v2/coordinator.ts:2145), [coordinator.ts:1173](/home/ben/Code/CLI/openbuff/sdk/src/services/memory-v2/coordinator.ts:1173), [context-archive.ts:525](/home/ben/Code/CLI/openbuff/packages/agent-runtime/src/util/context-archive.ts:525).

Preserve replay-stable lifecycle identities, bounded decision meaning, ranked complete-item selection and the exact emitted observation set. Separate current-task correlation from project knowledge retrieval and report the actual injected authority. Original-result recall needs body-completeness selection and immutable range-readable artifacts when bounded archives age out. Existing compaction floors, stale-read revocation, revision-CAS replacement, V1 merged atomic persistence and SQLite payload equality are valuable. Graduation must carry named facts and original results through repeated compaction, terminal replay, process reopen and a distinct next task, under a declared retention envelope.

### AF06 — Owned processes and actual resource bounds

**Priority:** repair cleanup and bounds where finite options are selected. **Confidence:** high in Linux subprocess, allocation and fake-transport probes; broader platform behavior is unknown.

SYNC timeout and BACKGROUND kill can clear escalation when the leader exits even though a TERM-resistant descendant remains alive. The probes observed sleeping descendants after 5.5 seconds, while the job reported stopped and refused further kill. Output-quota failure similarly settles before complete cleanup. Evaluator cancellation returned cancelled while a descendant later wrote a marker. LSP framing failure discards its child handle without killing it; disposal can race an unjoined restart.

Other caps bound returned data rather than owned work. MCP eviction removes registry entries without closing clients. A 1 KiB file-read budget performed a 24 MiB long-line concat before returning zero bytes. Vector persistence wrote a 9,697,695-byte cache that its 8,000,000-byte loader rejected, making the cold result empty. Costs of re-embedding follow the load path but were not measured. A reused generic sidecar keeps its previous stop promise; exposure is limited by its missing default consumer.

Evidence: [09-F5/F6/F7/F10](findings/09-execution.md), [11-F2](findings/11-evals-release.md), [07-F5/F9](findings/07-languages.md), [06-F11](findings/06-edits.md), [08-F2](findings/08-indexer.md); [run-terminal-command.ts:1663](/home/ben/Code/CLI/openbuff/sdk/src/tools/run-terminal-command.ts:1663), [background-jobs.ts:497](/home/ben/Code/CLI/openbuff/sdk/src/tools/background-jobs.ts:497), [node-filesystem.ts:147](/home/ben/Code/CLI/openbuff/sdk/src/tools/node-filesystem.ts:147).

Keep owner and cleanup state independent of action failure or leader exit. Selected enforced deadlines require an empty owned process scope; a still-live or uncertain scope is failed enforcement acceptance and retains cleanup authority. Intentional productive wall-clock defaults remain available. Stream limits need bounded internal buffering; write/read byte budgets must agree; eviction must dispose idle resources without killing active users. Graduation measures the covered Linux scope, adversarial descendants, disposal/restart races, realistic vector dimensions and UTF-8 roundtrips. It cannot be satisfied by a stopped flag or pool count alone.

### AF07 — Provider protocol, recovery and accounting conformance

**Priority:** normalize errors, retry ownership and accounting in present adapters. **Confidence:** high from real AI SDK/adapter HTTP/SSE fixtures and injected routing; real API/OAuth quality is unknown.

Initial HTTP503 becomes AI_RetryError after four primary requests, hides classifier status and sends zero backup requests. HTTP200 SSE503 loses structured status as it becomes prose. Separately, the outer streaming loop retries a content-policy503 four times despite the shared classifier's fail-fast decision. These are distinct observed layers; this audit does not extrapolate a universal multiplied request count.

Normal transport also loses late tool usage or skips configured cost calculation under default metadata stripping. The 20k-input/10k-output fixture at $3/$15 per million should report 21 cents, but reports zero or no callback. Missing backup credentials block a healthy primary's capacity lookup; reasoning effort uses mismatched namespaces for arbitrary provider IDs; configured OAuth selection ignores the skip flag meant to recover elsewhere.

Evidence: [02-F1–F7](findings/02-providers.md); [error-utils.ts:189](/home/ben/Code/CLI/openbuff/sdk/src/error-utils.ts:189), [llm.ts:1844](/home/ben/Code/CLI/openbuff/sdk/src/impl/llm.ts:1844), [model-provider.ts:439](/home/ben/Code/CLI/openbuff/sdk/src/impl/model-provider.ts:439).

Use one observable retry owner and canonical provider errors retaining status, cause and retry hints. Preserve the delivery gate that prevents replay after delivered content. Separate capability metadata from credential/client construction, and request compatibility from response accounting. Unknown, estimated and provider-reported usage/cost need precision, currency and provenance; remote in-flight spending cannot become an exact hard guarantee merely from post-step accounting. Graduation uses configured production constructors and consumer totals, arbitrary provider IDs, terminal usage, backup readiness, cancellation and recovery. Direct Gemini transport is an optional absent protocol; gateway Gemini remains usable.

### AF08 — Exact effect policy and portable provenance

**Priority:** honor the controls already retained by the product, with exact action identity. **Confidence:** high in harmless classification/env/origin probes; downstream secret exposure is conditional.

Approval classification normalizes executable whitespace before parsing and hashing, allowing newline-separated effects to evade the scanner and conflating different quoted bytes. Returning the first routine effect hides later risky effects. Force/delete feature pushes become routine under balanced policy despite the retained destructive-push gate. The one-use approval store itself correctly binds and consumes scoped receipts; its input identity needs repair.

The ordinary terminal strips synthetic canonical keys even after override merging, while compiler/LSP/Chrome/discovery seams can inherit them. Configured hooks lack the run's approval/profile context. MCP origin marks survive a direct trusted path but change across JSON and reverse RPC. Trusted-root discovery imports auxiliary session, test and dependency modules before validating an entrypoint. Ordinary API strings are misclassified as paths; wrappers claim tmux-test enforcement although bundled dispatch deliberately uses full-access. Omitted autoFileChangeHooks activates inferred commands despite the documented explicit opt-in.

Evidence: [09-F1–F4/F8](findings/09-execution.md), [10-F2/F3/F8/F10/F11](findings/10-extensions.md), [12-F5](findings/12-audit-docs.md), [01-F1](findings/01-cli.md), [11-F8/F9](findings/11-evals-release.md); [harness-enforcement.ts:153](/home/ben/Code/CLI/openbuff/sdk/src/services/harness-enforcement.ts:153), [agent-registry.ts:185](/home/ben/Code/CLI/openbuff/packages/agent-runtime/src/templates/agent-registry.ts:185), [file-change-hooks.ts:1538](/home/ben/Code/CLI/openbuff/sdk/src/tools/file-change-hooks.ts:1538).

Preserve full access, legitimate project variables, explicit tool grants and intentional server credentials. Parse/hash exact executable bytes and evaluate the complete effect plan under the selected policy. Carry parent-owned per-server provenance through persistence/RPC; declare extension entrypoints and real path/effect fields; unify child-environment and hook authorization contracts. Reauthorize physical artifact/recovery targets. Evaluate untrusted benchmark code without controller keys/home, or label an explicitly trusted evaluation boundary. Graduation demonstrates exact identity, portable origins, scoped env delegation and truthful effective-profile receipts, without adding blanket restrictions.

### AF09 — Review, evaluation and learning evidence that deserves credit

**Priority:** isolate test sinks immediately, then repair source/outcome/experiment evidence before promotion. **Confidence:** high in helper/SDK/CLI probes; no faulty live promotion or model-review frequency was observed.

Reviewer gates accept a well-formed foreign fingerprint over the same path roster and later persist credit under the expected identity. Ordinary receipts can omit dimension outcomes and requirement coverage. Untracked equal-length changes beyond a 1 MiB prefix leave targeted-validation identity unchanged and can receive full passed assurance. Cached audit source and nested feature identities drift; quarantined findings disappear from bundle output without degraded evidence. The coverage helper cannot express a fully assessed absent capability.

Evaluator evidence has independent losses: repeated commits overwrite observations; excluding low scores reverses a fixture's regression into improvement; emitted artifacts omit language/repeat/settings identity; NaN data passes a pure significance/promotion gate. Existing live promotion independently rejects insufficient single-run evidence, and measured adoption is unwired. Retention oracles often preserve identifiers rather than facts. Effective playbooks become verified and disappear, scopes are ignored, and unrelated reads manufacture negative usage signals. Some tests delete the live lesson directory; those dangerous tests were not executed.

Evidence: [12-F1–F4/F6–F8](findings/12-audit-docs.md), [11-F3–F7/F10–F12](findings/11-evals-release.md), [04-F6–F8](findings/04-memory.md); [gate-reviewer.ts:292](/home/ben/Code/CLI/openbuff/agents/base2/gate-reviewer.ts:292), [get-change-review-bundle.ts:393](/home/ben/Code/CLI/openbuff/sdk/src/tools/get-change-review-bundle.ts:393), [statistics.ts:188](/home/ben/Code/CLI/openbuff/evals/buffbench/statistics.ts:188).

Require full content identity, explicitly eligible assessment tiers, persistent evidence diagnostics, finite measurements and unique immutable experiment manifests. Preserve measured zeros, failures and paid incomplete attempts. Keep identifier metrics but add independent fact/negation/blocker/continuation oracles. Separate procedure activation from verification and correlate actual emitted/used evidence. Learning graduation needs a predeclared held-out split, paired baseline/candidate trials, language strata, sufficient evidence, a real adopted consumer and rollback. Markdown lessons, counters and passing policy helpers remain useful components rather than proof of improvement.

### AF10 — Feature and extension readiness across real host boundaries

**Priority:** repair reachable interfaces; defer frontiers until a declared workload needs them. **Confidence:** high in recorded schema/media/native probes and static branches; installed apps and 3D outcomes remain unknown.

Valid local generators lose module dependencies through toString/new Function. Schema transport can weaken required/never/additional-property constraints; sentinel prompt validation rejects legitimate minLength/enum schemas. MCP discovery stops at one page and caches successful listings, while delimiter-based identities misroute valid names. Original SDK custom-tool schemas and MCP provider schemas already preserve valuable validation behavior.

Visible features have corresponding consumer gaps: file submission drains non-ready context; failed image retry sends previous bytes; plan commands are executable but hidden from discovery. Browser policy sources disagree, pixel diff ignores extra image extent, and glTF/GLB/OBJ inspection has no corresponding Blender preview import branch. Preview hashes describe an earlier read while Blender opens the live path, so wrong-revision attribution is a conditional consequence. Native exec works standalone, yet smoke expects its former stub and host framing has no compatible adopted path.

Evidence: [01-F4/F8](findings/01-cli.md), [10-F4–F7/F9](findings/10-extensions.md), [13-F1/F4–F6/F8](findings/13-perception.md), [09-F9](findings/09-execution.md); [run-programmatic-step.ts:401](/home/ben/Code/CLI/openbuff/packages/agent-runtime/src/run-programmatic-step.ts:401), [mcp/client.ts:830](/home/ben/Code/CLI/openbuff/common/src/mcp/client.ts:830), [3d-assets.ts:825](/home/ben/Code/CLI/openbuff/sdk/src/tools/3d-assets.ts:825).

Trusted module/bundle execution, canonical descriptor identities, schema equivalence and generation-aware discovery should serve existing extensions. Media outcomes need accessible artifact references, actual decoded dimensions and host acknowledgements. Preserve narrow image/link/native-3D and conditional-edit capabilities. Native PTY, daemon/lane operations, declarative/untrusted plugin hosting, desktop and voice are absent or unwired in reviewed paths. Engine presets are useful recipes, with job guidance lacking a production consumer. Graduate each feature by its actual source→installed/runtime→host-result path; names, dependencies and stub tests do not suffice.

## Why sound roadmap principles did not establish usable features

The historical roadmap contained appropriate principles: canonical contracts, one authority for effects, process supervision, replay rather than heap snapshots, open capability tiers, ecosystem analyzers, and language choices based on capabilities. Several became useful implementation. Generated tool/schema/spawn catalogs, authenticated reads, conditional mutations, real compiled-Bun supervision and configured validation should be retained.

[OLD-TASK-INVENTORY.json](OLD-TASK-INVENTORY.json) contains 120 declarations, of which 58 were historically checked. Historical status is distinct from current readiness. Some completion notes expressly described a slice or deferred adoption; later work also landed real consumers. This review uses current traces and does not recycle old parent-abort or unadopted-supervision claims where current source has repaired them.

| Historical example | Present strength | Why the broader ability still needs graduation |
|---|---|---|
| P2-T8 process supervision | Real Bun POSIX process/bridge path, bounded crash restarts and parent cancellation | Generator termination and replay/journal lifetime still produce wrong or incomplete outcomes: AF02/AF03. |
| P3-T4 SCIP ingestion | Real opt-in CLI ingestion, graph adoption and query consumer | Bounded display strings corrupt opaque identity, refresh loses enrichment, and source-only fences miss graph changes: AF04. |
| P3-T5 import resolution | Shared extraction and live index graph integration | Bare-extension family and owning crate/package errors create wrong edges; a consumer exists without sufficient semantic proof: AF04. |
| X-1 canonical schemas and vectors | Real generated descriptors and strict unsupported-type generation | JSON/schema/RPC transport still changes extension origin, validation or arguments: AF08/AF10. |

The recurring cause is a weaker completion predicate than the capability requires. Tests assert a status, kind, token, path, emitted schema or helper return while skipping the next consumer. Memory cold-start queries bypass the exact task filter used by preparation. Adapter usage tests enable an option absent from configured production construction. Fidelity checks preserve an identifier while losing its value. Restart tests often gracefully reopen or seed DTOs without applying the uncertain effect. Count/byte caps verify bounded presentation while discarding identity or exceeding loader budgets.

Other failures arise from producer/consumer mismatch despite valid schemas: workflow member names, reasoning-option namespaces, replay text fields, active/verified procedure states and MCP result projection. Identity and lifetime cross file, run, task, object, connection and process boundaries without a common authority. Broad roadmaps can then multiply interfaces before those guarantees are integrated. A checked scaffold or green helper becomes evidence for more than was actually executed.

The replacement plan should preserve historical implementation and map each declaration to verify/retain, integrate, split, consolidate, defer or retire. Completion needs a reachable producer→consumer task, its expected positive and adverse behavior, runnable evidence, exact ownership, prerequisites and a stop rule. A task card should never turn a historical checkbox, parser count or named role into a readiness claim.

## Both meanings of polyglot

**Authored body.** Current implementation is predominantly TypeScript/Bun with a small real Rust execution slice. Pair 09 freshly built and executed Rust Landlock allow/deny behavior; that is stronger than a stub assertion. Default host adoption is unwired: Rust expects a raw ExecPlan and then ordinary target bytes, while the generic TS supervisor sends correlated JSON-RPC envelopes. Cwd/network/deadline fields and richer platform tiers remain outside the implemented role's current contract. A native adapter should graduate by compatible producer, lifecycle, output and effective-enforcement receipts.

Optional offline Python analysis/oracles are a future conditional component, not an already authored runtime inferred from fixtures or test-file extensions. Mature parsers, language servers, SCIP indexers, compilers and native UI libraries are consumed ecosystem tools; their implementation languages do not enlarge Openbuff's authored-language inventory. Keep immediate repairs in TS. Add Rust or offline analysis only for a concrete kernel/ownership/tooling or measured workload advantage, with one run/effect authority. No language-variety rewrite or heap snapshot is indicated.

**Target projects.** Generic text/read/edit/shell tools reach many languages, while syntax, semantic navigation/refactor, diagnostics/build/test and cross-component interface validation have different coverage. Twelve profile IDs, fifteen grammar variants over fourteen named source languages, eleven stdio LSP launch specs and fourteen executable probes are separate inventories. Four concrete diagnostic dispatch entries do not certify all those languages. JavaScript/TypeScript and C/C++ grouping also must not erase protocol document IDs. [07-languages](findings/07-languages.md) records the per-tier limits.

Two independent cooperation fixtures are needed. An authored-body fixture should exercise TS host→Rust role with negotiated versions, exact policy/env/cwd semantics, cancellation, output and truthful enforcement; it must pass without an authored Python service. A target-project fixture should change a shared schema/ABI across a TS consumer, Python component and Rust component, follow actual consumers/generated artifacts, and execute owning build/test targets. Invoking target-project Python tools does not make Python mandatory in the body's architecture.

Both fixtures need immutable source/artifact/diagnostic identities, agreed byte and position encodings, declared capabilities, typed errors and observed outcomes. Include an unknown-language generic control and honest unavailable-tool cells. Compare task success and resource costs against the current manual tool/hook baseline. Adding more adapters is useful only when the evidence shows a capability gain.

## Inputs to the executable priority queue

Begin with small independent TS repairs: truthful terminal/action propagation and send cleanup; exact mutation/recovery ownership; memory lifecycle identities and cross-turn selection; MCP result preservation; exact retained policy/env forwarding; isolated evaluator sinks; and current native smoke expectations. Their correctness does not depend on a daemon, broader plugin host or a new implementation language.

Then integrate durable session/effect ownership, coherent index/LSP generations, lossless refactors, source-bound review/validation, immutable experiment identity and real installed consumers. Attach relevant installation/native/CI probes to each feature task so evidence cannot become a postponed phase. Keep one shared contract owner and a short dependency-ready queue rather than blocking all immediate repairs on whole roadmap stages.

Only after those prerequisites should broader PTY/daemon/lane/plugin/media surfaces or learned routing graduate. Each uses a finite task/client/platform/language matrix and a declared envelope for correctness, recovery, interruptions, latency/cost/memory, retention and installation. Baselines and task oracles determine thresholds. No live quality gain, perfect stochastic non-regression, indefinite bounded retention or universal external-effect exactly-once guarantee is claimed by this review.

## Complete finding lineage and eight-domain view

Each finding is assigned once to its primary synthesis family below. Domain membership is overlapping and follows the durable source records, so its counts must not be summed as independent issues. All 118 records report high confidence in cited behavior; 114 have evidence basis and four have inference basis, specifically 05-F2/F3/F5/F9. Evidence records can also contain explicitly conditional consequences, such as outside-file disclosure or wrong-revision media. High confidence in an inspected transition is not a measured production frequency.

| Family | Records | Primary members |
|---|---:|---|
| AF01 — Source-preserving mutation and recovery authority | 13 | 01-F2; 05-F9; 06-F1–F2; 06-F4–F10; 06-F12; 08-F8 |
| AF02 — Truthful action, run and task outcomes | 11 | 01-F5–F6; 03-F1–F2; 06-F3; 07-F7; 10-F1; 11-F1; 13-F3; 13-F7; 13-F9 |
| AF03 — One durable session owner and executable continuation | 11 | 01-F3; 05-F1–F8; 05-F10; 13-F2 |
| AF04 — Fresh, coherent language and retrieval observations | 15 | 07-F1–F4; 07-F6; 07-F8; 07-F10–F11; 08-F1; 08-F3–F7; 08-F9 |
| AF05 — Knowledge that retains meaning and reaches the next decision | 7 | 01-F7; 04-F1–F5; 04-F9 |
| AF06 — Owned processes and actual resource bounds | 9 | 06-F11; 07-F5; 07-F9; 08-F2; 09-F5–F7; 09-F10; 11-F2 |
| AF07 — Provider protocol, recovery and accounting conformance | 7 | 02-F1–F7 |
| AF08 — Exact effect policy and portable provenance | 14 | 01-F1; 09-F1–F4; 09-F8; 10-F2–F3; 10-F8; 10-F10–F11; 11-F8–F9; 12-F5 |
| AF09 — Review, evaluation and learning evidence that deserves credit | 18 | 04-F6–F8; 11-F3–F7; 11-F10–F12; 12-F1–F4; 12-F6–F8 |
| AF10 — Feature and extension readiness across real host boundaries | 13 | 01-F4; 01-F8; 09-F9; 10-F4–F7; 10-F9; 13-F1; 13-F4–F6; 13-F8 |

The domain view distinguishes causes from impact. Security findings concern exact retained controls, portable provenance, physical targets and controller secrets; full access itself remains intentional. Correctness and state findings concern identities, versions, full operations and owned lifetimes, which can mislead subsequent model decisions or replace user work. Error handling loses failed/unknown state or cleanup authority. Performance findings expose concrete caps and allocations rather than measured optimality. Dependency findings concern asset/version/provenance delivery; no CVE or complete advisory audit is asserted. Tests frequently miss production composition, despite useful green suites. API/ABI defects change actual options, results, discovery and source credit.

| Domain | Records | All tagged members |
|---|---:|---|
| security | 14 | 01-F1; 04-F8; 06-F12; 09-F1–F5; 10-F2–F3; 10-F11; 11-F8–F9; 12-F5 |
| correctness | 110 | 01-F2–F4; 01-F6–F7; 02-F1–F7; 03-F1–F2; 04-F1–F9; 05-F1–F10; 06-F1–F10; 06-F12; 07-F1–F4; 07-F6–F11; 08-F1–F9; 09-F1–F6; 09-F8–F10; 10-F1–F10; 11-F1–F7; 11-F9–F12; 12-F1–F8; 13-F1–F9 |
| state-mutation | 56 | 01-F2; 01-F4–F5; 01-F7; 02-F3; 02-F6; 03-F2; 04-F1; 04-F3; 04-F6; 05-F1–F7; 05-F9; 06-F1–F8; 06-F10; 06-F12; 07-F4–F6; 08-F1–F2; 08-F5–F9; 09-F5–F7; 09-F10; 10-F2–F4; 11-F2–F3; 11-F9–F10; 12-F2–F3; 12-F6–F7; 13-F2; 13-F6; 13-F8 |
| error-handling | 45 | 01-F4–F6; 02-F1–F2; 02-F4; 02-F6–F7; 03-F1–F2; 04-F1; 04-F9; 05-F2–F3; 05-F6; 06-F1; 06-F4–F6; 06-F10–F11; 07-F5; 07-F7; 07-F9; 08-F1–F2; 08-F8; 09-F5–F9; 10-F1; 10-F3; 10-F5–F6; 11-F1–F2; 11-F6; 11-F11–F12; 12-F2; 12-F7; 13-F7–F8 |
| performance | 14 | 01-F7; 02-F7; 03-F1; 04-F5; 06-F11; 07-F5; 08-F2–F4; 08-F9; 09-F6–F7; 10-F3–F4 |
| dependency-hygiene | 4 | 07-F1; 11-F8; 11-F11; 13-F5 |
| test-coverage | 105 | 01-F5–F6; 01-F8; 02-F1–F7; 03-F1–F2; 04-F1–F9; 05-F1–F10; 06-F1–F12; 07-F1–F11; 08-F1–F9; 09-F1–F10; 10-F4–F7; 10-F9; 11-F1–F8; 11-F10–F12; 12-F1–F8; 13-F1; 13-F3–F9 |
| api-contract | 79 | 01-F1; 01-F3; 01-F8; 02-F1–F7; 03-F1–F2; 04-F1–F2; 04-F4–F6; 04-F8–F9; 05-F1; 05-F4–F5; 05-F8; 05-F10; 06-F2–F3; 06-F6–F11; 07-F1–F3; 07-F7–F9; 08-F1; 08-F3; 08-F5–F7; 09-F1–F4; 09-F8–F10; 10-F1–F2; 10-F4–F11; 11-F1; 11-F4–F6; 12-F1; 12-F3–F6; 12-F8; 13-F1–F9 |

Detailed triggers, individual severity, exact source windows, probes, strengths and proposed acceptance cases remain in the [13 durable reports](findings) and [FINDINGS-INDEX.json](FINDINGS-INDEX.json). This synthesis ranks work and catalogs readiness; implementation repairs and live capability graduation remain subsequent work.

