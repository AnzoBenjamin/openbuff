# Audit findings: cli-store

- Subsystems: cli.memory-v2.store, cli.memory-v2.provider, cli.memory-v2.concept-index, cli.memory-v2.context-archive-sync, cli.memory-v2.contained-file-io, common.memory-v2.types, sdk.memory-v2.coordinator, agent-runtime.memory-v2-context
- Features: memory-events-append-only-log, event-sourced-projections, context-archive-fts5-recall, concept-embeddings, cold-start-verified-knowledge, soft-forget, procedural-memory-gap
- Files covered: 26
- Snapshot: 1d150eb58b494899bfe81792df3501634ce3d1a2b67c2c1ed52dff0532b75ec2

## [HIGH] state-mutation — cli/src/services/memory-v2/bun-sqlite-memory-repository.ts — Persisted schema: append-only event log + projection tables; retention only on context-archive side tables
- **Risk:** Storage grows without bound across sessions and projects: every turn appends lifecycle/observation/coverage/usage events (coordinator.ts:725-1794) into an append-only log with projections duplicated per entity and full message bodies archived per run. The only eviction is a 30-day TTL prune on context-archive snapshots, capped at 500 per flush; the canonical event log and projections have no retention policy at all, so the store grows monotonically — the direct mechanism behind the owner's bloat complaint.
- **Fix:** For the overhaul: keep the append-only canonical log but add a bounded retention policy for projections and context archive messages (row-count or byte budget per project), and document/centralize the retention constants currently scattered as literals (:108-120).
- **Evidence:** cli/src/services/memory-v2/bun-sqlite-memory-repository.ts:97 (SCHEMA_VERSION=4), :102-117 (read caps + archive TTL/prune constants), :2908-2937 (MIGRATION_1 + append-only triggers), :2939-2984 (MIGRATION_2 projections + memory_usage + claim_dedup DDL), :2999-3039 (context archive DDL + FTS5), :130-143 (GC_RELEVANT_EVENT_TYPES), common/src/types/memory-v2.ts:720-776 (event discriminated union), concept-index.ts:84-102 (CONCEPT_DDL)

## [HIGH] performance — cli/src/services/memory-v2 — Write-heavy / read-light asymmetry: many per-turn append paths vs a single bounded ~12k-char read per turn
- **Risk:** Record-heavy/read-light asymmetry: a dozen event kinds are appended from 15+ call sites across every turn and run, but the sole steady-state retrieval surface is one bounded query per turn compiled into <=12k chars of prompt text — most persisted detail is written and never read, which is both wasted IO and the reason recorded lessons (e.g. CI-check-before-push) fail to influence behavior: they are stored but the retrieval+prompt path cannot reliably surface them.
- **Fix:** Rebalance the asymmetry: either reduce per-turn write fan-out (consolidate lifecycle/usage drafts) or make the read budget adaptive (e.g. prioritize claim.pinned and high-use observations over the fixed 100-per-category cut). The 12k read cap is the bottleneck the overhaul should treat as the contract to redesign.
- **Evidence:** sdk/src/services/memory-v2/coordinator.ts:725-1794 (8+ append call sites) vs :1158-1178 (single query per turn) and :1264 (context installation); packages/agent-runtime/src/util/memory-v2-context.ts:6-7 (12_000/2_000 char budgets), :275-360 (bounded category blocks), consumed at packages/agent-runtime/src/run-agent-step.ts:2216-2247; cli/src/services/memory-v2/context-archive-sync.ts:86-182; cli/src/utils/codebuff-client.ts:206; cli/src/services/memory-v2/bun-sqlite-memory-repository.ts:112-117 (recall read caps); cli/src/services/memory-v2/usefulness-scorer.ts:1-2 (pure re-export)

## [MEDIUM] test-coverage — cli/src/services/memory-v2/__tests__/two-session-cold-start.test.ts — two-session-cold-start.test.ts pins: fresh-digest reuse across sessions, mismatch->rereadRequired, soft-forget with preserved events
- **Risk:** Cold-start correctness is pinned at the repository layer only; the tests say nothing about whether retrieved knowledge is actually injected into prompts (that happens in the coordinator/run-agent-step layer). Any schema redesign must preserve the three pinned invariants or these tests (and their intent) break silently.
- **Fix:** Port the three invariants as contract tests over any new schema: fresh-digest reuse, mismatch->rereadRequired demotion, soft-forget with historical replay.
- **Evidence:** cli/src/services/memory-v2/__tests__/two-session-cold-start.test.ts:107-143 (fresh reuse across sessions), :145-239 (digest mismatch demotion + idempotent stale verify), :241-341 (soft forget, includeHistorical replay, preserved canonical events)

## [HIGH] api-contract — common/src/types/memory-v2.ts — Procedural memory (playbooks) has no schema home today: closest fits are observation kinds and claim.pinned with no always-include read path
- **Risk:** Procedural lessons cannot change behavior reliably: there is no schema home for condition->action rules, no always-include prompt injection path, and no condition-matching machinery. This is the direct root cause of the owner's 'CI-check-before-push lesson is repeatedly forgotten' report — such a rule, if recorded at all, competes lexically in a 12k bounded context and can be clipped or never retrieved.
- **Fix:** Add a procedural kind to MemoryObservationSchema (condition/action/trigger fields) and a pinned/always-include read path in MemoryRetrievalResult so such rules are injected every turn independent of lexical query match. The existing claim.pinned event kind plus the free-form tags array are the natural seams.
- **Evidence:** common/src/types/memory-v2.ts:232-239 (observation kind enum lacking procedural), :246 (free-form tags), :720-776 (event union lacking procedural kind); packages/agent-runtime/src/util/memory-v2-context.ts:356-388 (category blocks appended after bounded prefix, can be clipped); cli/src/services/memory-v2/bun-sqlite-memory-repository.ts:130-143 (claim.pinned exists, no pinned read path found in query compilation)

## [MEDIUM] performance — cli/src/services/memory-v2 — Bloat/inefficiency: unbounded tables, per-run body duplication, FTS5-optional fallback, sync fs on open path, dedup backfill replay, over-fetch vs 12k compile budget
- **Risk:** Cumulative inefficiency: monotonic storage growth (bloat), doubled body storage per run, silent FTS5 absence degrading recall to LIKE scans, duplicated embeddings store with its own sync-fs setup, cold-start replay proportional to log size, and over-fetch discarded at compile time. Together these explain both 'bloated' and 'inefficient' in the owner's report.
- **Fix:** Consolidate dual body storage behind external-content FTS or a rebuild-on-corruption strategy; gate cold-start backfill behind a metadata cursor (already present) but skip when schema version current; replace sync fs calls in concept-index/contained-file-io open paths with async; align retrieval batch size with the compile budget instead of fetching 100/category.
- **Evidence:** bun-sqlite-memory-repository.ts:108-110 (TTL prune constants), :117 (500-row LIKE scan cap), :1283-1319 (prune-before-write transaction), :3000-3021 (dual snapshot+messages storage), :3030-3034 (duplicate-body design comment), :3036-3049 (FTS5 optional availability), :2903 (dedup backfill cursor at open); concept-index.ts:2,84-102 (sync fs + separate DB); packages/agent-runtime/src/util/memory-v2-context.ts:356-388 vs coordinator.ts:1174 (fetch 100/category, compile to 12k chars)

## Coverage receipt

### Subsystems
- cli.memory-v2.store
- cli.memory-v2.provider
- cli.memory-v2.concept-index
- cli.memory-v2.context-archive-sync
- cli.memory-v2.contained-file-io
- common.memory-v2.types
- sdk.memory-v2.coordinator
- agent-runtime.memory-v2-context

### Features
- memory-events-append-only-log
- event-sourced-projections
- context-archive-fts5-recall
- concept-embeddings
- cold-start-verified-knowledge
- soft-forget
- procedural-memory-gap

### Files
- cli/src/services/memory-v2/bun-sqlite-memory-repository.ts
- cli/src/services/memory-v2/concept-index.ts
- cli/src/services/memory-v2/provider.ts
- cli/src/services/memory-v2/context-archive-sync.ts
- cli/src/services/memory-v2/contained-file-io.ts
- cli/src/services/memory-v2/index.ts
- cli/src/services/memory-v2/usefulness-scorer.ts
- cli/src/services/memory-v2/__tests__/two-session-cold-start.test.ts
- cli/src/services/memory-v2/__tests__/bun-sqlite-memory-repository.test.ts
- cli/src/services/memory-v2/__tests__/context-archive-sync.test.ts
- cli/src/services/memory-v2/__tests__/concept-firewall.test.ts
- cli/src/services/memory-v2/__tests__/concept-index.test.ts
- cli/src/services/memory-v2/__tests__/contained-file-io.test.ts
- cli/src/services/memory-v2/__tests__/memory-v1-migration-sqlite-roundtrip.test.ts
- cli/src/services/memory-v2/__tests__/provider.test.ts
- common/src/types/memory-v2.ts
- packages/agent-runtime/src/util/memory-v2-context.ts
- packages/agent-runtime/src/run-agent-step.ts
- sdk/src/services/memory-v2/coordinator.ts
- sdk/src/services/memory-v2/operator-service.ts
- sdk/src/services/memory-v2/v1-migration.ts
- sdk/src/run.ts
- cli/src/utils/codebuff-client.ts
- cli/src/utils/run-state-storage.ts
- cli/src/commands/memory-command.ts
- cli/src/commands/mcp-command.ts

### Domains
- api-contract
- performance
- test-coverage
- state-mutation
- correctness
