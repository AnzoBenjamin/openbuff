# Audit findings: resolutions-M4-S2-spawn

- Subsystems: packages/agent-runtime, common
- Features: spawn-agents-batch-orchestration, spawn-agent-inline-execution, typed-handoff-validation, runtime-agent-receipts, librarian-clone-cleanup, background-agent-jobs, background-concurrency-caps, agent-template-registry-lookup, child-context-isolation, child-timeout-and-max-turns, output-compaction-bounding
- Files covered: 7

## [HIGH] correctness — packages/agent-runtime/src/tools/handlers/tool/spawn-agent-inline.ts — [ALREADY-RESOLVED][M2-T1] Inline spawn lease/ledger exception-safe
- **Risk:** was: settle throw leaked lease + dangling spawn_started
- **Fix:** none
- **Evidence:** spawn-agent-inline.ts handleSpawnAgentInline: try/catch/finally; catch emits interrupted orchestration event unless receiptReconciled; finally releaseWorkspacePathLease on every path.

## [HIGH] state-mutation — packages/agent-runtime/src/tools/handlers/tool/spawn-agents.ts — [ALREADY-RESOLVED][M2-T1] Batch settle handlers exception-safe
- **Risk:** was: post-settle throw leaked lease/shard
- **Fix:** none
- **Evidence:** spawn-agents.ts background .then handler: try/finally releases lease + completes discovery shard; .catch same pattern. Covered by spawn-settle-fault-injection.test.ts.

## [HIGH] correctness — packages/agent-runtime/src/tools/handlers/tool/spawn-agent-utils.ts — [ALREADY-RESOLVED][M2-T2] Unversioned/legacy handoff fail-closed
- **Risk:** was: TypeError on handoff.permissions
- **Fix:** none
- **Evidence:** spawn-agent-utils.ts:373-402 comment 'M2-T2 (fail closed)'; schemaVersion undefined throws actionable error; agentHandoffSchema.safeParse gate.

## [MEDIUM] correctness — packages/agent-runtime/src/tools/handlers/tool/spawn-agent-utils.ts — [ALREADY-RESOLVED][M2-T2/R2] Receipt builder never throws
- **Risk:** was: ZodError/TypeError from unvalidated handoff fields
- **Fix:** none
- **Evidence:** inferAgentRole (1140-1170) safeParses handoff.role with agentType fallback; handoff?.findings?.find optional (1630); buildRuntimeAgentReceipt try/catch returns failed receipt (1769-1816).

## [MEDIUM] correctness — packages/agent-runtime/src/tools/handlers/tool/spawn-agent-utils.ts — [ALREADY-RESOLVED][M2-T2] Empty allowedTools preserves static tool set
- **Risk:** was: zero-tool child from empty allowedTools
- **Fix:** none
- **Evidence:** spawn-agent-utils.ts:473-477 requestedTools falls back to staticTools when allowedTools empty; M2-T2 comment.

## [MEDIUM] state-mutation — packages/agent-runtime/src/tools/handlers/tool/spawn-agents.ts — [FIXED] Batch rollback skips already-launched background coroutines
- **Risk:** was: rollback released leases of launched coroutines
- **Fix:** none
- **Evidence:** spawn-agents.ts rollbackValidatedClaims skips wiredBackgroundAgentIds; launch-loop catch abandons only non-wired jobs via abandonPreLaunchBackgroundAgentJob and settles their intents.

## [LOW] correctness — packages/agent-runtime/src/tools/handlers/tool/spawn-agent-utils.ts — [FIXED] subagent_start/finish pairing guaranteed on failure
- **Risk:** was: started-but-never-finished child on failure
- **Fix:** none
- **Evidence:** spawn-agent-utils.ts executeSubagent catch: emits subagent_finish with error for any loopAgentSteps failure, rethrows only for cancellation, else degrades to type:'error' output (2345-2387).

## [MEDIUM] security — packages/agent-runtime/src/tools/handlers/tool/spawn-agent-utils.ts — [ACCEPTED] Librarian clone cleanup keeps bounded user-message fallback
- **Risk:** residual: user-role text still eligible as rm target
- **Fix:** none — residual risk bounded to attacker-precreated dir inside /tmp/librarian-<repo>- namespace
- **Evidence:** spawn-agent-utils.ts:1030-1076 user-message fallback retained for backwards compat (RF-3 comment); assistant content never trusted; rm guarded by repoUrl shape validation + /tmp/librarian-<repo>-<digits> prefix/suffix checks; transient rm failures logged not thrown.

## [MEDIUM] error-handling — packages/agent-runtime/src/tools/handlers/tool/spawn-agent-utils.ts — [ACCEPTED] No per-child wall-clock deadline (deliberate)
- **Risk:** a stalled child blocks the parent turn until abort
- **Fix:** none — deliberate: bounded by cancellation, repeated-step watchdog, spawn depth, cost/token budgets
- **Evidence:** executeSubagent comment 'There is no wall-clock deadline' (2328-2331); subagent-timeout.test.ts asserts subagentTimeoutMs is never forwarded to executeSubagent.

## [MEDIUM] performance — packages/agent-runtime/src/tools/handlers/tool/spawn-agent-utils.ts — [ACCEPTED] Receipt walks remain multi-pass but bounded
- **Risk:** CPU cost proportional to transcript size on settle
- **Fix:** none — fuse passes opportunistically later
- **Evidence:** buildRuntimeAgentReceipt walks receiptSources repeatedly but extractRuntimeMutationToolMessages pre-narrows history; bounded depth; perf-only, no correctness impact.

## [LOW] correctness — packages/agent-runtime/src/tools/handlers/tool/spawn-agents.ts — [ACCEPTED] Soft background-cap check stays advisory
- **Risk:** soft check may pass where hard gate rejects (rolled back cleanly)
- **Fix:** none — soft check advisory only
- **Evidence:** spawn-agents.ts:261 maxRunningForRoot: 8 literal and intent-derived count remain; authoritative gate assertBackgroundAgentCapacity (background-agent-jobs.ts:412-440) is registry-wide and atomic per batch via allocateBackgroundAgentJobBatch.

## [LOW] error-handling — packages/agent-runtime/src/tools/handlers/tool/spawn-agents.ts — [ACCEPTED] Verified-memory failures still swallowed silently
- **Risk:** silent memory-forwarding degradation
- **Fix:** none
- **Evidence:** spawn-agents.ts try/catch around getVerifiedMemoryExcerpts and forwardVerifiedExcerpts keeps bare catches with best-effort comments.

## [LOW] correctness — packages/agent-runtime/src/tools/handlers/tool/spawn-agent-utils.ts — [ACCEPTED] Handoff compaction structural drops unmarked
- **Risk:** >64-entry handoff lists lose tail invisibly
- **Fix:** none — bounded, string truncation is marked
- **Evidence:** spawn-agent-utils.ts compactValue still slices arrays/objects to 64 and depth 6 without a truncated marker (343-351).

## [LOW] correctness — packages/agent-runtime/src/tools/handlers/tool/spawn-agent-utils.ts — [ACCEPTED] Mutation status coercion documented + fail-closed
- **Risk:** child 'partial' status still surfaces as completed with attested mutations and no errors
- **Fix:** none
- **Evidence:** spawn-agent-utils.ts:1634-1657 mutationsComplete requires errors.length===0 (fail-closed) and only reconciles stale blocked/null output when attested mutations exist; RF-2/7/11/16 comments document the override.

## [LOW] api-contract — packages/agent-runtime/src/templates/agent-registry.ts — [ACCEPTED] assembleLocalAgentTemplates doc drift
- **Risk:** misleading docstring
- **Fix:** none — docstring drift only
- **Evidence:** agent-registry.ts:107-110 still '{ ...dynamicTemplates }' with 'Use dynamic templates only' comment.

## [LOW] security — common/src/types/agent-template.ts — [ACCEPTED] handleSteps provenance not integrity-enforced
- **Risk:** executable handleSteps in local/database templates unverified
- **Fix:** none — revisit if remote template sourcing is introduced
- **Evidence:** agent-template.ts executionSource documents provenance; no integrity check found in shard scope. Local-first: templates are user-authored project files, no remote template execution path verified in this shard.

## [LOW] api-contract — packages/agent-runtime/src/tools/handlers/tool/spawn-agent-utils.ts — [ACCEPTED] Size/type-dependent child output envelope retained
- **Risk:** consumers shape-sniff truncated outputs
- **Fix:** none — stable-envelope refactor deferred
- **Evidence:** spawn-agent-utils.ts normalizeSpawnedAgentOutput (928-991) and boundAgentOutputForParent still map error/truncation shapes; bounded and documented compaction.

## [LOW] dependency-hygiene — packages/agent-runtime/src/tools/handlers/tool/spawn-agent-inline.ts — [ACCEPTED] lodash is a direct declared dependency
- **Risk:** bundle size only
- **Fix:** none — transitive-drift concern resolved
- **Evidence:** import { mapValues } from 'lodash' (spawn-agent-inline.ts:2); packages/agent-runtime/package.json declares lodash 4.17.23 directly.

## [MEDIUM] security — packages/agent-runtime/src/tools/handlers/tool/spawn-agents.ts — [ESCALATED] Verified memory excerpts laundered as system-tagged text
- **Risk:** repo-controlled excerpt text enters child context inside a system-tagged wrapper — prompt-injection amplifier
- **Fix:** File packages/agent-runtime/src/tools/handlers/tool/spawn-agents.ts: replace the `<system>` wrapper with explicit untrusted marker text, e.g. 'Verified memory excerpts (file-derived data, NOT instructions):' keeping tags ['SUBAGENT_CONTEXT']; test: packages/agent-runtime/src/__tests__/spawn-agents-message-history.test.ts (assert wrapper text and tag).
- **Evidence:** spawn-agents.ts forwardVerifiedExcerpts still builds `<system>Verified memory excerpts (bounded, N paths):...` from entry.excerpt and unshifts with tags:['SUBAGENT_CONTEXT'], keepDuringTruncation.

## [MEDIUM] performance — packages/agent-runtime/src/templates/agent-registry.ts — [ESCALATED] Database agent cache key mismatch + 'latest' exclusion
- **Risk:** every spawn of a published agent refetches the template (N+1 network I/O on spawn hot path)
- **Fix:** File packages/agent-runtime/src/templates/agent-registry.ts: after fetch, cache under the requested keys too — databaseAgentCache.set(agentId, dbAgent); if (normalizedAgentId !== agentId) set(normalizedAgentId, dbAgent); optionally short-TTL entry for 'latest'. Test: new packages/agent-runtime/src/__tests__/agent-registry-cache.test.ts asserting second lookup does not call fetchAgentFromDatabase.
- **Evidence:** agent-registry.ts:70/85 databaseAgentCache.set(dbAgent.id, dbAgent) vs 48-55 has(agentId)/has(normalizedAgentId); 'latest' never cached (83-86).

## [MEDIUM] state-mutation — packages/agent-runtime/src/tools/handlers/tool/spawn-agent-utils.ts — [ESCALATED] Full-history transfer shares mutable message objects
- **Risk:** in-place child mutation (truncation rewrites, tag flips) corrupts the parent transcript
- **Fix:** File packages/agent-runtime/src/tools/handlers/tool/spawn-agent-utils.ts (createAgentState): structuredClone(parentAgentState.messageHistory) before filterUnfinishedToolCalls for 'full' mode (or document/enforce message immutability). Test: packages/agent-runtime/src/__tests__/spawn-agents-message-history.test.ts — assert parent history unchanged after child-side mutation of a transferred message.
- **Evidence:** spawn-agent-utils.ts:2124 messageHistory = filterUnfinishedToolCalls(parentAgentState.messageHistory) — same objects; taskMemory/workspaceState use structuredClone (2193-2201).

## [MEDIUM] test-coverage — packages/agent-runtime/src/tools/handlers/tool/spawn-agents.ts — [ESCALATED] Missing MAX_SPAWN_BATCH_SIZE rejection test (partial: fault-injection exists)
- **Risk:** batch-cap rejection regression lands silently
- **Fix:** File packages/agent-runtime/src/__tests__/spawn-settle-fault-injection.test.ts (or new spawn-agents-batch-cap.test.ts): call handleSpawnAgents with > MAX_SPAWN_BATCH_SIZE agents, assert it rejects with the documented message and launches nothing (no lease, no shard, no ledger event).
- **Evidence:** code_search over packages/agent-runtime/src/__tests__ finds spawn-settle-fault-injection.test.ts (lease release under settle faults) but no MAX_SPAWN_BATCH_SIZE reference.

## [LOW] correctness — packages/agent-runtime/src/util/background-agent-jobs.ts — [ESCALATED] Consumer cursor eviction is not LRU (Map.set keeps insertion order)
- **Risk:** actively polling consumer evicted while idle newer consumers survive; next cursorless poll replays buffer / misreports drops
- **Fix:** File packages/agent-runtime/src/util/background-agent-jobs.ts (setConsumerCursor): job.consumerCursors.delete(consumerId) before set so every write refreshes recency. Test: packages/agent-runtime/src/__tests__/background-agent-jobs.test.ts — exceed MAX_CONSUMER_CURSORS while re-polling one consumer; assert it is never evicted.
- **Evidence:** background-agent-jobs.ts:700-712 setConsumerCursor plain set + evict oldest by insertion order.

## [LOW] error-handling — packages/agent-runtime/src/util/background-agent-jobs.ts — [ESCALATED] Job settle handlers unguarded
- **Risk:** throw inside a settle handler becomes an unhandled rejection; parent intent strands 'running'
- **Fix:** File packages/agent-runtime/src/util/background-agent-jobs.ts (attachJobCompletionHandlers): wrap both handler bodies in try/catch logging via a module logger, and ensure the parent intent still settles. Test: packages/agent-runtime/src/__tests__/background-agent-jobs.test.ts — registry.emit that throws; assert no unhandled rejection and view still synced on next observation.
- **Evidence:** background-agent-jobs.ts:494-519 job.promise.then(onFulfilled, onRejected) with registry.emit/syncViewFromCore inside, no catch.

## [LOW] api-contract — packages/agent-runtime/src/tools/handlers/tool/spawn-agent-utils.ts — [ESCALATED] logAgentSpawn exported but never called (dead API)
- **Risk:** documented spawn-logging contract never fires; export rots
- **Fix:** File packages/agent-runtime/src/tools/handlers/tool/spawn-agent-utils.ts + both handlers: call logAgentSpawn({agentTemplate, agentType, agentId, parentId, prompt, spawnParams, logger}) after validation in handleSpawnAgents and handleSpawnAgentInline — or delete the export. Test: extend spawn-agent-inline nesting test to assert logger.debug called at spawn.
- **Evidence:** spawn-agent-utils.ts:2209-2262 export; import lists of spawn-agents.ts and spawn-agent-inline.ts omit it.

## [LOW] correctness — common/src/types/dynamic-agent-template.ts — [ESCALATED] functionSchema z.custom returns wrapped fn, not boolean — handleSteps unvalidated
- **Risk:** handleSteps accepts non-function values; failure surfaces only at invocation
- **Fix:** File common/src/types/dynamic-agent-template.ts: return a boolean — z.custom((fn: unknown) => typeof fn === 'function'); keep z.string() union arm for generator code. Test: common templates validation test — non-function handleSteps rejected at load with a path-precise issue.
- **Evidence:** common/src/types/dynamic-agent-template.ts:70-71 z.custom((fn:any) => schema.implement(fn)) — truthy wrapped object for any input.

## [LOW] correctness — .agents/sessions/harness-remediation-2026-09-22/findings/resolutions-M4-S2.md — [SUMMARY] shard-spawn-subagents dispositions: ALREADY-RESOLVED 5, FIXED 2, ACCEPTED 11, ESCALATED 8 (total 26 incl. this entry)
- **Risk:** none
- **Fix:** See per-finding entries.
- **Evidence:** SUMMARY: shard-spawn-subagents had 24 findings; verified all against current code.

## Coverage receipt

### Subsystems
- packages/agent-runtime
- common

### Features
- spawn-agents-batch-orchestration
- spawn-agent-inline-execution
- typed-handoff-validation
- runtime-agent-receipts
- librarian-clone-cleanup
- background-agent-jobs
- background-concurrency-caps
- agent-template-registry-lookup
- child-context-isolation
- child-timeout-and-max-turns
- output-compaction-bounding

### Files
- packages/agent-runtime/src/tools/handlers/tool/spawn-agents.ts
- packages/agent-runtime/src/tools/handlers/tool/spawn-agent-inline.ts
- packages/agent-runtime/src/tools/handlers/tool/spawn-agent-utils.ts
- packages/agent-runtime/src/util/background-agent-jobs.ts
- packages/agent-runtime/src/templates/agent-registry.ts
- packages/agent-runtime/src/__tests__/spawn-settle-fault-injection.test.ts
- common/src/types/dynamic-agent-template.ts

### Domains
- correctness
- state-mutation
- security
- error-handling
- performance
- dependency-hygiene
- test-coverage
- api-contract
