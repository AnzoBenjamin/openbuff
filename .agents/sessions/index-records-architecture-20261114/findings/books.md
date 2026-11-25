# Books and procedural context: verified architecture findings

Scope: playbook schema/store, per-turn loading, child inheritance, prompt compilation, deterministic gate/evidence, lifecycle, editor/git-committer consumers. Source files were read only. This report is the lane's only written artifact. Other lanes cover indexing, code-map, cold-start wiring, and general records.

## Findings ranked by relevance

### B1 — High, correctness/API contract: declared role/path scope is not applied

**Evidence.** `common/src/types/memory-playbook.ts:33` declares `scope.repos`, `scope.glob`, and `scope.agentTypes`. `common/src/types/contracts/playbook-store.ts:56` only accepts workspace identity; `cli/src/services/memory-v2/bun-sqlite-memory-repository.ts:1622` selects workspace/status/expiry without those scope fields. `sdk/src/services/memory-v2/coordinator.ts:1368` installs that entire active workspace set. `packages/agent-runtime/src/tools/handlers/tool/spawn-agent-utils.ts:3664` explicitly copies all of it to every child independently of transcript isolation. `packages/agent-runtime/src/memory/playbook-context.ts:115` takes no actor/task/path inputs. `packages/agent-runtime/src/memory/playbook-gate.ts:272` similarly takes no authenticated actor or touched-path context and checks only trigger/status/expiry. Targeted searches found no scope applicability use in these producer/consumer paths.

The editor's own brief excludes validation and Git work (`agents/editor/editor.ts:54`), whereas Git delivery is explicitly the committer's role (`agents/git-committer/git-committer.ts:11`). A pure runtime probe with `repos: ['repo-OTHER']`, `glob: ['other-path/**']`, and `agentTypes: ['git-committer']` still rendered the rule and produced a gate warning for a matching action.

**Inference/risk (high confidence).** An editor receives procedural instructions intended for a committer or its parent; the declared scope gives authors a false expectation that instructions and enforcement are limited. Not every injected rule actually fires: the gate still requires its tool/action/spawn trigger, so prompt pollution and enforcement overreach are distinct.

**Design remedy.** Resolve applicability once using host-authenticated repository/worktree identity, actor role/capabilities, task phase, and affected paths. Use the same resolved rule objects for prompt selection and execution gating. Distinguish the actor obliged to satisfy a rule from the target child of a spawn; a rule about spawning a committer belongs to the spawner. Preserve relevant rules across isolated children without copying unrelated rules. Cross-role reads of repository facts may remain useful; imperatives require explicit applicability.

### B2 — High, correctness/performance: budget clipping preserves imperatives while losing their conditions

**Evidence.** `packages/agent-runtime/src/memory/playbook-context.ts:94` renders title, instruction, then Applies-to and Required-first. `:144` sorts by SHA-derived signature; `:151` takes eight slots; `:172` allocates equal character shares; `:176` clips whole entries. Default cap is 1,500 characters (`:36`), while each instruction may be 4,096 characters (`common/src/types/memory-playbook.ts:80`). A pure runtime probe using one long, schema-valid rule retained its instruction but omitted both applicability and prerequisite lines. Tests intentionally assert clipping and lowest-signature selection (`packages/agent-runtime/src/memory/playbook-context.test.ts:109` and `:137`).

**Inference/risk (high confidence).** The model sees an imperative without the conditions limiting it, while an enforced rule can be omitted entirely by an unrelated hash order. Context cost is spent repeatedly on irrelevant or partially rendered instructions rather than task-specific knowledge. An explicit truncation marker does not repair missing semantics.

**Design remedy.** Treat applicability, required receipt type, and enforcement as an indivisible compact record. Render those first from the authoritative rule, and summarize optional explanatory prose separately. Choose only relevant records and allocate budget by phase/importance/relevance with deterministic tie-breaking; use IDs for expandable detail. Never silently clip executable rule conditions. The gate should remain authoritative even if explanatory details are not displayed.

### B3 — High, security/correctness: successful command text substitutes for reusable validation evidence

**Evidence.** `packages/agent-runtime/src/memory/session-evidence-log.ts:11` records only tool name, command text, and timestamp. Its matcher is a case-insensitive literal substring (`:69`). `packages/agent-runtime/src/tools/tool-executor.ts:667` records terminal results absent an `errorMessage`, not a typed validation receipt. `packages/agent-runtime/src/memory/playbook-gate.ts:185` implements only `toolSucceeded`; the other three schema-valid evidence kinds always remain unsatisfied. The prompt explicitly requires each agent to run prerequisites itself because child evidence is invisible (`playbook-context.ts:84`).

Both seeds demand `*check:ci-local*` (`cli/src/services/memory-v2/bun-sqlite-memory-repository.ts:3515`, `:3544`) while their instructions permit package-appropriate typecheck/test alternatives (`:3523`, `:3552`). The commit seed actually applies to spawning git-committer (`:3509`), not to its eventual Git commit. A pure probe recorded `echo check:ci-local` and the procedural gate changed from warned to allowed. No real shell command or Git mutation was performed for the probe.

**Inference/risk (high confidence).** The procedure can demand repeated validation across actors even when the actual code and validated inputs are unchanged; the permitted alternatives cannot satisfy the seeded literal matcher. Conversely, a successful echo mentioning the required script is treated as validation. Timestamp freshness alone does not bind a result to relevant code, configuration, tool version, repository, or dependency state. This is a procedural-gate flaw; separate terminal authorization and the existing validation/reviewer gates still apply and were not bypassed by the probe.

**Design remedy.** Store host-authenticated validation receipts identifying check kind, actual command/argv and cwd, exit/outcome, covered inputs/content digests, relevant config/lockfile/tool versions, and producer/run identity. Query those receipts across parent and child actors within the same task/change scope. Reuse only when their declared dependency closure is unchanged; invalidate relevant receipts on changes. Resolve repository-supported validation alternatives into typed check capabilities. Keep learned guidance distinct from mandatory executable policy, and reject unsupported prerequisite kinds at rule activation rather than requiring the model to satisfy impossible conditions.

### B4 — Medium, state mutation/API contract: lifecycle verification makes rules disappear

**Evidence.** `cli/src/services/memory-v2/playbook-lifecycle.ts:141` proposes an active enforced rule becoming `verified` after sufficient counter evidence. Operator `/memory playbooks --apply` writes that status (`cli/src/commands/memory-command.ts:1690`). The store accepts only `status = 'active'` (`bun-sqlite-memory-repository.ts:1631`); prompt compiler rejects verified (`playbook-context.ts:137`); gate rejects verified (`playbook-gate.ts:289`). A pure probe confirmed verified rules compile to an empty string. The lifecycle action remains operator-applied, not an automatic model promotion.

Separately, inject-only candidates produce no gate verdicts (`playbook-gate.ts:293`), while their promotion requires fired counters (`playbook-lifecycle.ts:124`). The default runtime lane therefore supplies no observation of the very shadow matches those counters are supposed to assess.

**Inference/risk (high confidence for disappearance; medium for all counter sources).** A successful lifecycle transition removes a proven rule from both instruction and enforcement. Shadow-rule usefulness cannot be measured by this gate path. Other external/manual counter producers have not been exhaustively enumerated.

**Design remedy.** Separate activation state from evidence/quality state: e.g. enabled/disabled/retired plus proposed/evaluated/verified confidence and independent enforcement mode. Make lifecycle transitions typed and atomic, and contract-test them through store loading, actor filtering, prompt rendering, and gate behavior. Count shadow applicability and satisfaction without changing dispatch; measure benefit and false positives rather than using only obstruction/compliance counts.

### B5 — Medium, security/error handling: procedure classification disagrees with the execution classifier

**Evidence.** `packages/agent-runtime/src/memory/playbook-gate.ts:58` splits shell text on whitespace and examines only the leading Git subcommand. A pure probe produced a warning for `git push` but no verdict for `git status && git push`, `env git push`, or `git -C "path with spaces" push`. The SDK already contains a different captured-command/effect classifier (`sdk/src/services/harness-enforcement.ts:1395`) with shell-list and wrapper handling.

**Inference/risk (high confidence).** The same terminal action has inconsistent procedural behavior depending on quoting or wrappers. This is not a finding that those forms bypass the independent execution approval policy; only playbook matching was tested.

**Design remedy.** Classify captured execution once into versioned action/effect facts. Policy, procedure applicability, receipts, audit logs, and UI explanation should consume those same facts. Do not independently infer action semantics from model-authored prose or a whitespace split.

### B6 — Medium, error handling/correctness: loaded rules are trusted instructions while rule service failures are optional

**Evidence.** The compiled header calls all entries trusted operator-authored rules (`playbook-context.ts:84`), including migration seeds and records whose valid provenance can be `derived`. Schema validation checks shape, not an operator authorization proof. Coordinator load failure empties the set (`coordinator.ts:1360`); gate exceptions continue dispatch (`tool-executor.ts:3385`, `:3486`). In warn mode the runtime explicitly continues dispatch even when a prerequisite is missing (`playbook-gate.ts:323`, `tool-executor.ts:3480`). Proposal/lifecycle application has explicit operator command paths; no automatic model activation was found in this lane.

**Inference/risk (medium).** A single undifferentiated book type simultaneously behaves as trusted instruction, learned optional guidance, and sometimes enforcement. Operators and models can mistake the memory service for an authoritative prerequisite system, or interpret advisory warnings as hard policy denials. Actual unauthorized active-row creation was not demonstrated.

**Design remedy.** Split operator policy from learned procedures and observed facts; retain provenance/approval metadata at the executable rule boundary. Declare availability and failure semantics per category. Expose rule ID, obligation actor, applicability, missing receipt, and advisory/block outcome together so the model is not expected to infer authority from a book title or warning prose.

## Validation performed

- Source reads and targeted consumer searches; no source edits.
- Pure Bun runtime probes only: scope acceptance, loss of rule conditions under budgeting, literal-text evidence acceptance, verified-status exclusion, and shell-form applicability mismatch.
- Existing unit tests inspected for clipping/status/lifecycle intent. This lane did not rerun the full test suite or inspect live user conversation/logs, so it does not claim how frequently these conditions occur in production.

## Eight-domain coverage

| Domain | Disposition within this scope |
| --- | --- |
| Security | Evidence spoofing and inconsistent action classification verified; independent terminal authorization explicitly outside these claims. |
| Correctness | Scope leakage, clipping, seed mismatch, unsupported evidence, status exclusion verified. |
| State mutation | Child rule clones are isolated; lifecycle status semantics mismatch verified. General SQLite concurrency is covered by records lane. |
| Error handling | Explicit fail-open load/gate and warn semantics examined. |
| Performance | Repeated global context injection and irrelevant bounded slots verified; latency/token measurements not performed. |
| Dependency hygiene | Common contracts and consumer imports inspected; no substantiated third-party dependency issue identified. |
| Test coverage | Existing tests assert problematic selection/status behavior; end-to-end applicability/receipt/lifecycle contracts are missing from inspected tests. |
| API/ABI contracts | Scope fields and lifecycle states do not have coherent cross-layer semantics; proposed remedies require versioned migration. |

## Files covered

`common/src/types/memory-playbook.ts`; `common/src/types/contracts/playbook-store.ts`; selected store sections in `cli/src/services/memory-v2/bun-sqlite-memory-repository.ts`; selected coordinator and command consumer sections; `packages/agent-runtime/src/tools/handlers/tool/spawn-agent-utils.ts`; `packages/agent-runtime/src/memory/playbook-context.ts`; `playbook-gate.ts`; `session-evidence-log.ts`; relevant `tool-executor.ts` and `run-agent-step.ts` sections; `cli/src/services/memory-v2/playbook-lifecycle.ts`; editor and git-committer definitions; context/gate/lifecycle tests; selected SDK execution classifier entrypoints.

Conventional instruction files were briefly checked: directory-based selectors in `sdk/src/instruction-files.ts:86` and touched-path injection in `packages/agent-runtime/src/util/nested-instruction-files.ts:89` have separate semantics and no role metadata. Root `AGENTS.md` instructions are user-authored policy and must not be silently weakened by role filtering. Generated facts and procedural books need distinct explicit classification rather than treating every Markdown source alike.

## Unknowns

- Frequency of irrelevant book exposure in actual sessions, and which records/operators populated the affected workspace stores.
- Total token/cost impact of repeated bands after provider caching.
- Counter writers outside the inspected runtime/CLI lane.
- Semantic relationship of conventional knowledge files to future role-scoped factual retrieval; root user instructions must remain authoritative.
- Trust/availability requirements for mandatory policy should be specified by product semantics, not inferred from the current learned-procedure mechanism.
