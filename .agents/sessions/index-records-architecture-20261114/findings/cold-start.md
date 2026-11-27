# Cold-session context and actor handoff audit

Date: 2026-11-14. Scope: fresh/continued CLI and SDK session setup, memory preparation, first agent step, child handoff, and reuse evaluation. Source was inspected without modification. This report is a review artifact, not a runtime receipt or a latency benchmark.

## Ranked findings

### 1. High — correctness / API contracts: prior factual context does not reach transcript-isolated children, while procedural context does

**Evidence:** `sdk/src/run.ts:1768` calls `MemoryV2Coordinator.prepareTurn` once for `sessionState.mainAgentState`. `packages/agent-runtime/src/tools/handlers/tool/spawn-agent-utils.ts:3618` constructs child state without `memoryV2Context` or `memoryAuthority`; at `:3655` it also withholds `taskMemory` when the history mode is `none`. At `:3664`, all playbooks are deliberately copied regardless of history mode. The V2 compiler in `packages/agent-runtime/src/run-agent-step.ts:2744` requires both active authority and a matching `userInputId`, so a child cannot obtain V2 context merely because the root already queried the repository.

A pure runtime probe constructed an editor child from a parent containing task memory, V2 context/authority and one playbook. Result: `childHasTaskMemory=false`, `childHasV2Context=false`, `childHasV2Authority=false`, `childHasPlaybooks=true`, `childHasParentTranscript=false`. The probe used synthetic marker objects and performed no source or repository writes.

**Inference:** An isolated editor or committer may independently find facts already discovered by another task or by its parent. Its manually supplied spawn brief can mitigate this, but the runtime offers no equivalent fresh, role-specific factual briefing through this construction. This is stronger than a general claim that memory is not persisted: root persistence and retrieval are already wired.

**Design remedy:** Prepare an actor-specific context packet on child creation through a host service that queries shared project facts using the child task, role, capabilities and focused paths. Keep transcript inheritance optional. Rebind the packet to authenticated current actor/turn correlation; do not copy a parent's serialized authority into the child. Select applicable procedures independently from shared factual knowledge. Context selection must not grant execution or edit authority.

### 2. High — correctness / performance: the ordinary bootstrap provides paths and memory matches, but no automatic task-specific code-index briefing

**Evidence:** `cli/src/utils/create-run-config.ts:249` selects `projectContextMode: 'paths'`. `sdk/src/run-state.ts:839` then populates the file tree without computing symbol/caller context. `agents/__tests__/base2.test.ts:1327` explicitly documents and asserts removal of automatic proactive `query_index` injection for code intent, concrete-file requests, repository Q&A and broad audits. `agents/__tests__/general-agent.test.ts:51` asserts the same removal for pathless general-agent requests. Index access remains available on demand; this does not mean indexing is absent.

**Inference:** The model is responsible for finding and querying relevant indexed code after startup. Persistent metadata can make an individual search faster while leaving every fresh model session responsible for identifying the relevant subsystem again. The tests establish startup policy; they do not prove how often a particular model later calls the index or repeats a search.

**Design remedy:** Add a bounded runtime briefing before the first substantive model step: project identity and relevant subsystem summary, task-specific candidate files, related tests/commands, cited prior decisions and focused uncertainty. For explicit small-file edits, use direct entity/path lookups; for broad or semantic requests, retrieve a bounded candidate set. Greeting, continuity-only, and already-specified tasks should not pay for universal expensive search. Existing path-only startup can remain fast while facts come from durable indexed state.

### 3. Medium — correctness / performance: root memory retrieval has no actor, path or artifact focus

**Evidence:** `sdk/src/services/memory-v2/coordinator.ts:1235` uses the trimmed raw prompt as its retrieval query. The request at `:1236` contains `selectors: []`, `artifactKinds: []`, `includeHistorical: true`, and `maxResultsPerCategory: 100`; it intentionally omits the new task as a restrictive retrieval scope so older knowledge remains eligible. `sdk/src/run.ts:1774` supplies only the current prompt as query text. `cli/src/utils/codebuff-client.ts:54` supplies the available V2 repository to the SDK, so this is the real default composition path.

**Inference:** Retrieval relies heavily on wording overlap and broad repository results rather than actor needs, explicit paths and known subsystem identity. Historical status is a sensible recall option, but broad admission increases the need for relevance and freshness selection downstream. This lane does not claim a measured recall failure or that the final prompt includes every one of the admitted records.

**Design remedy:** Build a typed query plan containing explicit path/entity matches, dependency/feature neighborhoods, task purpose, role and desired fact kinds. Retrieve lexical and optional semantic candidates, then rank and deduplicate under a token budget. Historical facts should retain lifecycle labels and require current evidence where applicable. Keep correlation task IDs separate from relevance scope so fresh tasks can still reuse prior discoveries.

### 4. Medium — performance / state mutation: live discovery is rebuilt independently of durable indexed project membership

**Evidence:** Fresh session setup at `sdk/src/run-state.ts:798` invokes `discoverProjectPaths` when files are not explicitly supplied. Continued turns at `:1159` invoke it again, then reload knowledge/instruction files at `:1186`. `sdk/src/run.ts:1288` chooses continued-session override setup versus new initial state. The paths mode avoids parsing every source file, but it still obtains live membership through a separate discovery path.

**Inference:** This adds repeated filesystem discovery independently of the persistent index lifecycle. Exact cost depends on repository size and filesystem and was not measured. Refreshing visible membership is necessary after external creates/deletes; the finding concerns sharing trustworthy membership state, not suppressing freshness checks.

**Design remedy:** Let file-tree, instruction discovery and code retrieval consume one source inventory/change cursor with a dirty overlay. Reconcile missed/ambiguous changes and rebuild affected membership when needed. Do not assume watcher delivery proves unchanged files after downtime. Explicit virtual filesystem inputs must retain their existing authoritative semantics.

### 5. Medium — documentation / test coverage: storage cold-start tests do not verify the product goal, and architecture documentation describes removed behavior

**Evidence:** `cli/src/services/memory-v2/__tests__/two-session-cold-start.test.ts:245` records and verifies an observation, closes/reopens the store, then queries it. At `:291` it also invokes the coordinator with matching query text and verifies fresh-task retrieval. These are useful storage/coordinator tests; they do not run two fresh CLI conversations or measure repeated discovery. `docs/architecture.md:231` still describes proactive index-query caching although the agent tests above expressly assert its removal.

**Inference:** Passing storage reuse tests can coexist with agents rediscovering the repository. Stale architecture documentation can also lead future changes to optimize a path that is no longer present.

**Design remedy:** Add a real two-conversation trace evaluation with fixed tasks/models: first conversation discovers a feature; a new conversation using different wording retrieves it; a child uses the resulting scoped briefing. Track duplicate searches, unchanged-file rediscovery, useful prior-fact delivery, wrong-role procedure delivery, relevant-source reads, task completion and startup latency separately. Cover an unrelated edit and a relevant edit between sessions. Preserve live-read verification needed before edits; the objective is avoiding repeated broad discovery, not eliminating necessary exact reads. Derive architecture documentation from tested composition contracts where practical.

## Current strengths and boundaries

- Root V2 memory is acquired and injected in the actual CLI/SDK composition, rather than being only an unused storage library (`cli/src/utils/codebuff-client.ts:210`, `sdk/src/run.ts:1768`).
- Legacy task memory is hydrated and evidence-reconciled on fresh sessions (`sdk/src/run-state.ts:899`).
- V2 injection checks current trusted input correlation (`packages/agent-runtime/src/run-agent-step.ts:2744`), which should be preserved in any replacement.
- Memory preparation races cancellation and records degraded state; failures do not hang startup (`sdk/src/run.ts:1763`, `sdk/src/services/memory-v2/coordinator.ts:876`). V2 opt-in degradation deliberately avoids silently reactivating V1. This lane found no reason to weaken that boundary.
- Project storage identity canonicalizes the root and hashes its path (`cli/src/project-files.ts:54`). Reuse across worktrees/relocations would need a stable repository identity with distinct mutable worktree overlays; current isolation is evidence, but whether cross-worktree reuse is intended remains a design question.

## Eight-domain coverage

| Domain | Disposition in this lane |
|---|---|
| Security | Inspected authority correlation and transcript isolation. Recommendation preserves both; factual retrieval must not mint execution/edit authority. No additional security exploit established here. |
| Correctness | Findings 1–3 describe context delivery and relevance gaps. |
| State mutation | Child clone construction, continued-turn refresh, and cancellation/degradation inspected; immutable scoped packet recommended. |
| Error handling | Preparation abort and degraded-state behavior inspected; no additional fault substantiated within scope. |
| Performance | Findings 2–4 describe duplicated discovery and broad admission; no unmeasured latency figures claimed. |
| Dependency hygiene | Existing CLI→SDK→runtime contracts inspected; no dependency defect established. Host context service should be injected through shared contracts, without runtime importing CLI storage. |
| Test coverage | Finding 5 distinguishes persistence proof from actual new-conversation reuse and documents missing trace metrics. |
| API/ABI | Child state and V2 correlation contracts inspected. A new actor-context contract must preserve virtual-FS inputs and current SDK behavior during migration. |

## Unknowns and follow-up measurement

- No live provider run was executed, so model-dependent frequency of repeated discovery and the impact of prompt wording are unknown.
- This lane does not measure cold index availability, durable event admission, parser persistence or graph precision; those belong to the index, records and code-map lanes.
- CLI conversation ID versus V2 memory-session ID semantics require an explicit intended-lifecycle decision before redesigning session identity.
- A language rewrite by itself does not address these verified composition gaps. The interface and context-selection model must change regardless of implementation language.
