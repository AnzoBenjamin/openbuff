# Audit findings: sdk-coordinator

- Subsystems: sdk
- Features: coordinator.capture-kind-mapping, coordinator.capture-drop-gates, coordinator.event-append-flow, coordinator.claim-dedup, coordinator.usage-correlation, coordinator.terminal-drafts, operator-service.compaction-gc, operator-service.claim-consolidation, usage-observer.correlateUsage, event-factory.derived-ids, task-memory-store.v1-evidence-store, procedural-playbook-absence
- Files covered: 11
- Snapshot: 1d150eb58b494899bfe81792df3501634ce3d1a2b67c2c1ed52dff0532b75ec2

## [MEDIUM] api-contract — sdk/src/services/memory-v2/coordinator.ts — 27-tool capture map folds into only 5 observation kinds
- **Risk:** Kind classification is regex/structural only with hard-coded confidence 0.5; read/search/list/discovery outputs all land as 'discovery' observations with no semantic value ranking.
- **Fix:** No defect; documents the write-side taxonomy that the overhaul must reshape (no 'procedural' kind exists).
- **Evidence:** sdk/src/services/memory-v2/coordinator.ts:89-118; sdk/src/services/memory-v2/coordinator.ts:132-133; sdk/src/services/memory-v2/coordinator.ts:219-235

## [MEDIUM] state-mutation — sdk/src/services/memory-v2/coordinator.ts — Non-native, MCP, non-JSON and contentless tool calls dropped; the rest journaled
- **Risk:** Tests confirm the drop policy (sdk/src/services/memory-v2/__tests__/coordinator.test.ts:1101-1135): run_terminal_command, error outputs, and mixed outputs are dropped.
- **Fix:** No defect; quantifies the capture funnel for the overhaul (terminal tools like run_terminal_command are invisible to memory entirely).
- **Evidence:** sdk/src/services/memory-v2/coordinator.ts:1359-1373; sdk/src/services/memory-v2/coordinator.ts:1379; sdk/src/services/memory-v2/coordinator.ts:1383-1406; sdk/src/services/memory-v2/coordinator.ts:1426-1434

## [MEDIUM] performance — sdk/src/services/memory-v2/coordinator.ts — Per-call CAS append queue blocks the agent turn
- **Risk:** Appends are awaited inline inside the tool-result path (run.ts:1466 awaits memoryV2Coordinator.recordToolObservation per tool call), so journaling latency is on the turn's critical path.
- **Fix:** No defect; the overhaul's write path is fully serialized through this queue today.
- **Evidence:** sdk/src/services/memory-v2/coordinator.ts:693-719; sdk/src/services/memory-v2/coordinator.ts:736-774; sdk/src/services/memory-v2/event-factory.ts:69-89; sdk/src/services/memory-v2/event-factory.ts:27-39; sdk/src/run.ts:1466-1471

## [HIGH] correctness — sdk/src/services/memory-v2/coordinator.ts — Claim dedup covers only record_decision; ~20 read/search/list tools have no content dedup
- **Risk:** Every successful captured call with any path/count produces a brand-new observation.recorded; the store grows linearly with tool-call volume and is never collapsed into knowledge.
- **Fix:** Add content-hash-based dedup (digest already computed at coordinator.ts:1499) and a significance threshold so repeated reads/searches reinforce instead of appending new observations.
- **Evidence:** sdk/src/services/memory-v2/coordinator.ts:1470-1497; sdk/src/services/memory-v2/coordinator.ts:1612-1630; sdk/src/services/memory-v2/types.ts:124-133; sdk/src/services/memory-v2/types.ts:222-224; sdk/src/services/memory-v2/coordinator.ts:1426-1434

## [HIGH] test-coverage — sdk/src/services/memory-v2/usage-observer.ts — Usage observer measures skip correlation, not outcome impact
- **Risk:** Nothing proves memory changed an outcome: no recall-precision, no counterfactual comparison, no read-avoidance rate surfaced anywhere in the sdk subsystem; usage counts are never read by the coordinator for re-ranking (getUsage is optional and unused by coordinator.ts).
- **Fix:** Track a retrieval-quality metric: fraction of turns where injected memory avoided a read, plus outcome deltas; the usage projection (types.ts:91-100) is the natural place to aggregate it.
- **Evidence:** sdk/src/services/memory-v2/usage-observer.ts:24-170; sdk/src/services/memory-v2/coordinator.ts:2025-2073; sdk/src/services/memory-v2/types.ts:91-100; sdk/src/services/memory-v2/coordinator.ts:1956-1958

## [HIGH] api-contract — sdk/src/services/memory-v2/coordinator.ts — No procedural/playbook memory layer exists; injection point is classifyObservationKind + captureToolObservation
- **Risk:** Playbooks ('before git push run check:ci-local') have no representation; a capture-side hook can piggyback on the existing per-tool append at coordinator.ts:1632, and an enforce-side hook belongs in prepareConfiguredTurn's context injection (coordinator.ts:935-1000), but neither exists today.
- **Fix:** Introduce a dedicated 'procedural' observation kind or a parallel playbook store keyed by trigger predicates, written at capture time and enforced at prepareTurn injection time.
- **Evidence:** sdk/src/services/memory-v2/coordinator.ts:233-235; sdk/src/services/memory-v2/coordinator.ts:1581-1610; sdk/src/services/memory-v2/coordinator.ts:1359-1368

## [MEDIUM] performance — sdk/src/services/memory-v2/coordinator.ts — Every turn emits 3 terminal + up to 4 lifecycle events unconditionally
- **Risk:** Every turn appends query.completed/query.failed + task.transitioned + session.ended + optional observation.reused regardless of whether anything changed; across long sessions this is 3-4 rows of pure lifecycle churn per turn that GC must later remove.
- **Fix:** Keep terminal drafts but gate their emission on session-level state changes rather than per-turn, or move terminal status into a single mutable record rather than an append-only journal.
- **Evidence:** sdk/src/services/memory-v2/coordinator.ts:2025-2073; sdk/src/services/memory-v2/coordinator.ts:2075-2135; sdk/src/services/memory-v2/types.ts:232-241; sdk/src/services/memory-v2/__tests__/operator-service.test.ts:1136-1211

## [HIGH] performance — sdk/src/services/memory-v2/types.ts — GC and compaction are manual, opt-in repository methods with no TTL
- **Risk:** Compaction is a manually invoked operator command, not an automatic coordinator behavior; nothing in the turn lifecycle ever calls compact/selectGCandidates, so a store grows unbounded until a human runs the operator.
- **Fix:** Run compaction automatically on a budget trigger from the coordinator, and add time-based expiry (TTL) on usage-projection and observation rows so stale knowledge decays without an operator.
- **Evidence:** sdk/src/services/memory-v2/types.ts:86-88; sdk/src/services/memory-v2/types.ts:232-241; sdk/src/services/memory-v2/operator-service.ts:59-62; sdk/src/services/memory-v2/__tests__/operator-service.test.ts:1136-1211

## [MEDIUM] performance — sdk/src/services/memory-v2/coordinator.ts — Significance gate admits noise: any positive count or status string journals an event
- **Risk:** Discovery/list events for tooling-generated directories and repeated identical reads are journaled identically to meaningful ones; metadata only carries callId, outputDigest, captureKind, counts — no semantic relevance signal that could down-rank them at retrieval.
- **Fix:** Suppression should be content-based (the digest already exists at coordinator.ts:1499) and value-based, not just identity-based.
- **Evidence:** sdk/src/services/memory-v2/coordinator.ts:89-118; sdk/src/services/memory-v2/coordinator.ts:1426-1434; sdk/src/services/memory-v2/coordinator.ts:1501-1506

## [MEDIUM] state-mutation — sdk/src/services/task-memory-store.ts — task-memory-store.ts (V1) journals evidence with prune but no TTL on the record itself
- **Risk:** The parallel V1 filesystem store has bounded caps (LIST_CAPS, EVIDENCE_STREAM_THRESHOLD_BYTES at task-memory-store.ts:81-115) and stale-evidence pruning (pruneStaleTaskMemoryEvidence, task-memory-store.ts:908-1021), but is a separate legacy path the V2 coordinator never reconciles against after migration.
- **Fix:** No defect; the overhaul should treat the V1 evidence list as the same read-light problem — evidence is stored but never proven to change agent behavior.
- **Evidence:** sdk/src/services/task-memory-store.ts:88-115; sdk/src/services/task-memory-store.ts:390-455; sdk/src/services/task-memory-store.ts:848-1021

## Coverage receipt

### Subsystems
- sdk

### Features
- coordinator.capture-kind-mapping
- coordinator.capture-drop-gates
- coordinator.event-append-flow
- coordinator.claim-dedup
- coordinator.usage-correlation
- coordinator.terminal-drafts
- operator-service.compaction-gc
- operator-service.claim-consolidation
- usage-observer.correlateUsage
- event-factory.derived-ids
- task-memory-store.v1-evidence-store
- procedural-playbook-absence

### Files
- sdk/src/services/memory-v2/coordinator.ts
- sdk/src/services/memory-v2/event-factory.ts
- sdk/src/services/memory-v2/usage-observer.ts
- sdk/src/services/memory-v2/operator-service.ts
- sdk/src/services/memory-v2/types.ts
- sdk/src/services/memory-v2/v1-migration.ts
- sdk/src/services/task-memory-store.ts
- sdk/src/run.ts
- sdk/src/services/memory-v2/__tests__/coordinator.test.ts
- sdk/src/services/memory-v2/__tests__/usage-observer.test.ts
- sdk/src/services/memory-v2/__tests__/operator-service.test.ts
