# Audit findings: shard-spawn-subagents

- Subsystems: packages/agent-runtime, common
- Features: spawn-agents-batch-orchestration, spawn-agent-inline-execution, typed-handoff-validation, spawn-permission-scoping, runtime-agent-receipts, receipt-reconciliation-ledger, output-compaction-bounding, librarian-clone-cleanup, background-agent-jobs, background-concurrency-caps, agent-template-registry-lookup, agent-template-schema-validation, child-context-isolation, spawn-depth-limiting, child-lifecycle-api, child-fs-process-isolation, child-timeout-and-max-turns, shell-spawn-type
- Files covered: 10
- Snapshot: a0de6357ff5254c1bb8cf2e92d821fd948811744293fe3361209c5d557e95392

## [HIGH] state-mutation — packages/agent-runtime/src/tools/handlers/tool/spawn-agents.ts:630 — Post-settle receipt construction is not exception-safe and permanently leaks workspace leases and discovery shards
- **Risk:** In the background settle handlers (buildRuntimeAgentReceipt at 607/671) and the foreground post-processing (864/888), releaseWorkspacePathLease (630/705/911) and completeDiscoveryShard run AFTER receipt construction. agentReceiptSchema.parse (spawn-agent-utils.ts:1529) is strict and can throw (non-JSON value in child output reaching jsonValueSchema, a handoff-derived field failing schema, a task-memory merge failure). Any throw skips the lease release and shard completion, so the handoff's writablePaths stay leased and the discovery shard stays active for the rest of the task - later legitimate spawns on those paths are rejected and file-picker dedup claims are blocked. The throw also escapes handleSpawnAgents after the children already finished, discarding their reports.
- **Fix:** Wrap each settle handler and the foreground result loop in try/finally so releaseWorkspacePathLease plus completeDiscoveryShard('interrupted') always run; build the receipt inside its own try and fall back to a minimal failed receipt on parse errors instead of throwing.
- **Evidence:** spawn-agents.ts:607 `const receipt = buildRuntimeAgentReceipt({` then 630 `releaseWorkspacePathLease(parentAgentState, validated.leaseId)` (same ordering at 671/705 and 864-888/911). spawn-agent-utils.ts:1529 `const receipt = agentReceiptSchema.parse({` on a `.strict()` schema (common/src/types/agent-handoff.ts agentReceiptSchema). No try/finally around the release calls.

## [HIGH] state-mutation — packages/agent-runtime/src/tools/handlers/tool/spawn-agent-inline.ts:390 — Inline spawn leaks its workspace lease and leaves a dangling spawn_started ledger event when receipt construction throws
- **Risk:** Only executeSubagent is inside try/catch (catch at 367 releases the lease). On the success path buildRuntimeAgentReceipt (376) and reconcileAgentReceiptIntoParent run BEFORE releaseWorkspacePathLease (390). If either throws (strict agentReceiptSchema.parse rejects a legacy handoff or non-JSON output), the lease is never released and the `spawn_started` orchestration event already emitted (appendOrchestrationEvent earlier in the handler) never receives its `spawn_finished` pair, so the control-plane ledger reports an in-flight spawn for the rest of the turn and the leased writablePaths are locked out.
- **Fix:** Wrap the post-execute block in try/finally: always release the lease and always emit a terminal ledger event (interrupted) if receipt reconciliation did not run; degrade the receipt rather than throwing.
- **Evidence:** spawn-agent-inline.ts:367 `releaseWorkspacePathLease(parentAgentState, leaseId)` inside `catch (error)`; 376 `const receipt = buildRuntimeAgentReceipt({`; 390 `releaseWorkspacePathLease(parentAgentState, leaseId)` after `reconcileAgentReceiptIntoParent`. spawn_started is appended before executeSubagent with no paired termination on this failure path.

## [HIGH] correctness — packages/agent-runtime/src/tools/handlers/tool/spawn-agent-inline.ts:185 — Unversioned/legacy handoff crashes spawn_agent_inline with a raw TypeError instead of validating
- **Risk:** validateVersionedAgentHandoff (line 111) returns early for handoffs without `schemaVersion` (non-repair-editor), i.e. free-form handoffs are an accepted input class (buildSpawnParamsWithHandoff even normalizes string `context`). The inline handler then passes that raw object to `handoff?.permissions.allowedTools` (185) and deriveSpawnTemplateCapabilities (167), which dereferences `handoff.permissions.allowedTools` (spawn-agent-utils.ts:461). A handoff like {context: 'text'} or {taskId: 'x'} throws "Cannot read properties of undefined (reading 'allowedTools')" with no actionable message. spawn-agents.ts avoids this by canonicalizing (handoff as AgentHandoff only when schemaVersion === 1) before the same calls; the inline path never does.
- **Fix:** Canonicalize the handoff in spawn_agent_inline exactly like spawn-agents (only pass it onward when schemaVersion === 1 and it parses as AgentHandoff), or make validateVersionedAgentHandoff reject any non-schemaVersion-1 object so both handlers share one contract.
- **Evidence:** spawn-agent-inline.ts:111 `validateVersionedAgentHandoff({ agentType, handoff })`; 167 `deriveSpawnTemplateCapabilities({ ... handoff,` ; 185 `requiredTools: handoff?.permissions.allowedTools ?? [],` (optional chain covers `handoff` only, not `handoff.permissions`). spawn-agents.ts contrast: `handoff && typeof handoff === 'object' && handoff.schemaVersion === 1 ? (handoff as AgentHandoff) : undefined`.

## [MEDIUM] correctness — packages/agent-runtime/src/tools/handlers/tool/spawn-agent-utils.ts:1030 — Receipt builder dereferences handoff fields it never validated, throwing instead of producing a status
- **Risk:** inferAgentRole does `if (handoff) return handoff.role` (1030): for a handoff lacking `role` it returns undefined, and agentReceiptSchema.parse (1529) then throws a ZodError because `role` is a required enum. Similarly `params.handoff?.findings.find(...)` (1474) throws a TypeError when a child output claims findingsAddressed and the handoff has no findings array. buildSpawnParamsWithHandoff explicitly supports free-form handoffs, so this is a reachable input class; the throw surfaces as a failed tool call and (via the settle-path gaps) leaks leases.
- **Fix:** Validate the handoff with agentHandoffSchema.safeParse at the receipt boundary and fall back per field (role from inferAgentRole by agent type, empty findings list) instead of dereferencing unvalidated input; never let the receipt builder throw.
- **Evidence:** spawn-agent-utils.ts:1030 `if (handoff) return handoff.role`; 1474 `const finding = params.handoff?.findings.find(`; 1529 `agentReceiptSchema.parse({` with `role: inferredRole` and common/src/types/agent-handoff.ts `role: agentRoleSchema` required.

## [MEDIUM] security — packages/agent-runtime/src/tools/handlers/tool/spawn-agent-utils.ts:962 — Librarian clone cleanup trusts user-role message text as the rm target (prompt-injection amplified deletion)
- **Risk:** The directory passed to `rm -rf` is regex-extracted from message text. Provenance prefers tool/system-tagged messages but falls back to user-role messages (962) when none match. User-role content inside a spawned child can carry attacker-influenced text (parent-forwarded context, repo-derived excerpts), so a prompt-injected sentence matching `The repository has been cloned to \`<path>\`.` can direct deletion at a directory the attacker names. The `/tmp/librarian-<repoName>-<digits>` prefix+digit-suffix check bounds the blast radius but still permits deleting an unowned directory an attacker pre-created inside that namespace.
- **Fix:** Drop the user-message fallback entirely (require role 'tool' or system-tagged provenance) and prove ownership with a runtime marker file created at clone time (e.g. .codebuff-clone-id) before rm; treat missing marker as refuse-and-warn.
- **Evidence:** spawn-agent-utils.ts:962 `params.messageHistory?.filter((m) => (m as Message).role === 'user') as` feeding `extractCloneDir`, then `await rm(cloneDir, { recursive: true, force: true })` guarded only by the `/tmp/librarian-${repoName}-` prefix and `/^\d+$/` suffix checks.

## [MEDIUM] security — packages/agent-runtime/src/tools/handlers/tool/spawn-agents.ts:338 — Verified memory excerpts are laundered into child context as system-tagged text
- **Risk:** forwardVerifiedExcerpts builds `<system>Verified memory excerpts ...` from file-derived excerpt text and unshifts it into the child's message history (338) with keepDuringTruncation. Repo-controlled strings (README content, source comments) can therefore enter the child's context inside a system-tagged wrapper, giving attacker-influenced data elevated trust - a prompt-injection amplifier with no untrusted-content delimiter or provenance label per excerpt.
- **Fix:** Pass excerpts as clearly delimited untrusted data without the `<system>` wrapper (or with an explicit 'untrusted file excerpt' marker), and label each excerpt with its source path and verification state so the child treats it as evidence, not instructions.
- **Evidence:** spawn-agents.ts:307 `const forwardVerifiedExcerpts = (`; 338 `history.unshift({` with content text `` `<system>Verified memory excerpts (bounded, ${bounded.length} paths):...` `` built from `entry.excerpt` values obtained via `getVerifiedMemoryExcerpts(parentAgentState, ...)`.

## [MEDIUM] correctness — packages/agent-runtime/src/tools/handlers/tool/spawn-agent-utils.ts:528 — Empty handoff allowedTools silently strips every child tool while empty path lists preserve static scope
- **Risk:** deriveSpawnTemplateCapabilities narrows the child's toolNames to `inheritedTemplate.toolNames.filter((toolName) => requestedTools.has(toolName))` plus grantable read-only tools (528). With `permissions.allowedTools: []` the requested set is empty, so the child receives toolNames: [] (zero tools). The same empty-list convention for readablePaths/writablePaths is explicitly documented to preserve static scope ("Empty array must NOT become a zero-read/write lockout"). A caller mirroring that convention for tools silently spawns a zero-tool child that burns a full spawn cycle and reports a confusing downstream failure.
- **Fix:** Treat an empty allowedTools list as 'no tool narrowing' (keep inheritedTemplate.toolNames) to match the path semantics, or reject empty allowedTools explicitly at handoff validation with an actionable error.
- **Evidence:** spawn-agent-utils.ts:461 `const requestedTools = new Set(handoff.permissions.allowedTools)`; 528-533 `toolNames: [...inheritedTemplate.toolNames.filter((toolName) => requestedTools.has(toolName)), ...grantedReadOnlyTools]`; contrast 481-490 where `read`/`write` skip narrowing when the list length is 0.

## [MEDIUM] correctness — packages/agent-runtime/src/tools/handlers/tool/spawn-agents.ts:404 — Batch rollback also rolls back background spawns whose coroutines were already launched
- **Risk:** rollbackValidatedClaims (body releases leases at 404) iterates ALL validatedAgents - releasing leases, completing discovery shards as 'interrupted', and emitting ledger 'interrupted' for every started spawn - without consulting wiredBackgroundJobIds (506). If the background launch loop throws after some jobs were wired (a synchronous throw from createCombinedAbortSignal, extractSubagentContextParams, or a chunk handler), the already-running children get their leases released and their shards settled while running; their settle handlers later release the lease a second time and complete the shard again ('completed' after 'interrupted'), and the ledger shows both 'interrupted' and 'spawn_finished' for one live spawn.
- **Fix:** Skip wiredBackgroundJobIds entries (match by job id / subAgentState.agentId) inside rollbackValidatedClaims so only never-launched spawns are rolled back; make lease release and shard completion idempotent no-ops after terminal settlement.
- **Evidence:** spawn-agents.ts:404 `releaseWorkspacePathLease(parentAgentState, validated.leaseId)` inside `rollbackValidatedClaims` looping `for (const validated of validatedAgents)`; catch at 748 calls `rollbackValidatedClaims(...)` after the loop in which `wiredBackgroundJobIds.add(job.jobId)` marked live coroutines that must never be rolled back.

## [MEDIUM] error-handling — packages/agent-runtime/src/tools/handlers/tool/spawn-agent-utils.ts:2086 — Foreground subagents have no wall-clock deadline; a hung child blocks the parent turn indefinitely
- **Risk:** The code states: "There is no wall-clock deadline: productive subagents are bounded only by cancellation, the repeated-step watchdog, spawn depth, and cost/token budgets." A stalled model/stream inside one foreground child keeps spawn-agents' Promise.allSettled pending until the entire parent run is aborted; there is no per-child timeout that converts a hung child into a failed receipt, and stepsRemaining (MAX_AGENT_STEPS_DEFAULT) bounds step count, not wall time. One wedged child stalls the whole batch and the user's turn.
- **Fix:** Add a per-child wall-clock timeout (template-configurable, sane default) that aborts the child's signal and yields a 'failed' receipt with a timeout error; also allow per-spawn maxTurns/maxSteps overrides so a batch can bound each child independently.
- **Evidence:** spawn-agent-utils.ts:2083-2088 around `onResponseChunk(startEvent)` and the comment "There is no wall-clock deadline:"; `result = await loopAgentSteps({...})` is awaited with only `contextParams.signal` (the parent's signal) as cancellation.

## [MEDIUM] performance — packages/agent-runtime/src/templates/agent-registry.ts:85 — Database agent cache key mismatch and 'latest' exclusion cause an N+1 fetch per spawn
- **Risk:** Cache lookups test `databaseAgentCache.has(agentId)` / `has(normalizedAgentId)` but entries are stored under `dbAgent.id` (70, 85). Whenever those differ (bare 'editor' resolving to a publisher-qualified/versioned id), every spawn refetches the same template from the database - and a spawn_agents batch of N agents repeats the fetch N times. The deliberate no-cache rule for 'latest' (84) compounds this for unpinned published agents. This is network I/O on the spawn hot path.
- **Fix:** Store the template under the requested lookup keys (agentId and normalizedAgentId) in addition to dbAgent.id, and consider a short-TTL cache entry for 'latest' to bound refetches within one turn.
- **Evidence:** agent-registry.ts:70 and 85 `databaseAgentCache.set(dbAgent.id, dbAgent)` versus 42-55 lookup keys `databaseAgentCache.has(agentId)` / `has(normalizedAgentId)`; line 84 comment "Cache only specific versions to avoid stale 'latest' results".

## [MEDIUM] performance — packages/agent-runtime/src/tools/handlers/tool/spawn-agent-utils.ts:1529 — Receipt building runs many independent deep walks over child output and full history on every spawn settle
- **Risk:** buildRuntimeAgentReceipt calls extractReceiptStringArray roughly 8 times (each a full depth-8 traversal of the output), containsToolCall twice over [output, messageHistory] (depth 12), containsStructuralAuditReceipt over the same sources, extractReceiptEvidence another walk, and extractMutationAttestations runs two zod safeParses per edit_transaction tool part. For an inline pruner child that inherits the parent's FULL message history (messageHistoryMode 'full'), every spawn settle pays these repeated traversals of a potentially large transcript - CPU cost proportional to batch size times transcript size on the spawn hot path.
- **Fix:** Fuse the key-based string extractions into one visitor pass, restrict history walks to role 'tool' messages (plus system-tagged ones where needed), and skip schema parsing for parts whose toolCallId does not match before safeParse.
- **Evidence:** spawn-agent-utils.ts:1529 receipt assembly calls `extractReceiptStringArray(params.output, 'requirementsAddressed' | 'acceptanceCriteriaAddressed' | 'findingsAddressed' | 'assumptions' | 'unresolved' | 'requestedValidation')` plus `extractReceiptStringArray(receiptSources, 'artifacts')`; `containsToolCall(receiptSources, 'task_completed')` walks `params.agentState.messageHistory`; extractMutationAttestations safeParses `fileMutationResultV1Schema` then `commitReceiptV1Schema` per json part.

## [MEDIUM] state-mutation — packages/agent-runtime/src/tools/handlers/tool/spawn-agent-utils.ts:1881 — Full-history transfer shares mutable message objects between parent and child (no clone), unlike taskMemory/workspaceState
- **Risk:** `filterUnfinishedToolCalls(parentAgentState.messageHistory)` (1881) returns a new array containing the SAME message objects as the parent's transcript. Any in-place mutation inside the child (truncation rewriting content parts, tag flips such as keepDuringTruncation, array pushes) is visible in the parent's history and can corrupt the parent's transcript and compaction state. The same function explicitly `structuredClone`s taskMemory and workspaceState (1954) "so children cannot mutate the parent's source of truth" but not messages - an inconsistent isolation boundary.
- **Fix:** structuredClone (or copy-on-write) the transferred messages for 'full' mode, or enforce and document message immutability across the spawn boundary and add a test asserting the parent's history is unchanged after child-side edits.
- **Evidence:** spawn-agent-utils.ts:1881 `messageHistory = filterUnfinishedToolCalls(parentAgentState.messageHistory)` versus 1950-1958 `taskMemory: ... structuredClone(parentAgentState.taskMemory)` and `workspaceState: ... structuredClone(parentAgentState.workspaceState)`.

## [MEDIUM] test-coverage — packages/agent-runtime/src/tools/handlers/tool/spawn-agents.ts:189 — Spawn batch-cap rejection and lease/shard cleanup on receipt failure have no asserting tests
- **Risk:** code_search over packages/agent-runtime/src/__tests__ returns zero references to MAX_SPAWN_BATCH_SIZE and zero references to acquire/releaseWorkspacePathLease. The batch-size rejection (189) has no test asserting its failure mode, and no test covers the handler's lease and discovery-shard cleanup when post-execution receipt construction throws (the failure class behind the HIGH lease-leak findings). The only lease test found (packages/agent-runtime/src/util/__tests__/workspace-path-leases.test.ts) exercises the lease util in isolation, not the spawn handlers' rollback/settle paths, so these regressions would land silently.
- **Fix:** Add tests that (a) assert handleSpawnAgents rejects > MAX_SPAWN_BATCH_SIZE with the documented message and launches nothing, and (b) inject a receipt-construction failure (legacy handoff or non-JSON output) and assert the workspace lease is released, the discovery shard is settled, and the ledger receives a terminal event.
- **Evidence:** spawn-agents.ts:189 `if (agents.length > MAX_SPAWN_BATCH_SIZE) {`; code_search pattern `releaseWorkspacePathLease|acquireWorkspacePathLease|MAX_SPAWN_BATCH_SIZE` over paths [packages/agent-runtime/src/__tests__] matched only schemaVersion/buildRuntimeAgentReceipt usages, none of the three symbols.

## [LOW] correctness — packages/agent-runtime/src/tools/handlers/tool/spawn-agents.ts:261 — Soft background-capacity check undercounts and hardcodes the hard limit's value
- **Risk:** selectAgentAttempt receives `runningForRoot` counted only from this parent's backgroundAgentJobs intents and `maxRunningForRoot: 8` as a literal (261). The count excludes same-batch background peers validated in the same Promise.all (none are registered yet) and other parents' jobs under the same root run, while the authoritative gate (allocateBackgroundAgentJobBatch -> assertBackgroundAgentCapacity) counts registry-wide per clientSessionId+rootRunId. A batch can pass the soft check and then be rejected by the hard gate after leases and ledger events were taken (needing rollback), and the duplicated literal drifts if MAX_RUNNING_BACKGROUND_AGENT_JOBS_PER_ROOT (background-agent-jobs.ts:70, not exported) is retuned.
- **Fix:** Export the per-root limit constant, import it in the handlers, and feed selectAgentAttempt the true registry-based running count including same-batch peers (or drop the soft check and rely solely on the atomic capacity gate).
- **Evidence:** spawn-agents.ts:261 `maxRunningForRoot: 8,` with `runningForRoot: input.background ? (parentAgentState.backgroundAgentJobs?.filter((job) => job.status === 'running').length ?? 0) : 0`; background-agent-jobs.ts:70 `const MAX_RUNNING_BACKGROUND_AGENT_JOBS_PER_ROOT = 8` (module-local).

## [LOW] correctness — packages/agent-runtime/src/util/background-agent-jobs.ts:705 — Consumer cursor eviction can drop an actively polling consumer (Map.set does not refresh insertion order)
- **Risk:** setConsumerCursor writes `job.consumerCursors.set(consumerId, nextCursor)` (705) and evicts `oldest` by Map insertion order when size exceeds MAX_CONSUMER_CURSORS (708). For an existing key, Map.set preserves the ORIGINAL insertion position, so the consumer that has polled since creation remains the oldest and can be evicted while newer idle consumers survive - unless it happens to be the consumer currently writing. The evicted consumer's getBackgroundAgentConsumerCursor then returns undefined and its next cursor-less poll replays the retained buffer or misreports droppedChunks.
- **Fix:** Refresh recency on every write (delete then set) before the eviction check so the cursor map behaves as a true LRU keyed on last use.
- **Evidence:** background-agent-jobs.ts:700-712 `function setConsumerCursor(...)` with `job.consumerCursors.set(consumerId, nextCursor)` then `const oldest = job.consumerCursors.keys().next().value; if (typeof oldest === 'string' && oldest !== consumerId) { job.consumerCursors.delete(oldest) }`.

## [LOW] error-handling — packages/agent-runtime/src/util/background-agent-jobs.ts:495 — Job settle handlers are unguarded; their own throws become unhandled rejections and strand the parent intent
- **Risk:** attachJobCompletionHandlers wires `job.promise.then(onFulfilled, onRejected)` (495) and discards the derived promise. If registry.emit or syncViewFromCore throws inside a handler, the resulting rejection is unhandled (process-level failure under strict unhandled-rejection modes) and the parent's durable intent stays 'running', which reconcileInterruptedBackgroundAgentIntents later mislabels 'interrupted' with a misleading reason. This also applies to the re-thrown rejection from spawn-agents' background .catch handler, whose errors flow through this same onRejected.
- **Fix:** Wrap both handlers in try/catch (log through the module logger or a passed Logger) and always settle the matching parent intent even when the registry write fails.
- **Evidence:** background-agent-jobs.ts:494-517 `function attachJobCompletionHandlers(job) { job.promise.then((result) => { ... registry.emit(job.jobId, {...}); ... syncViewFromCore(job, coreJob) }, (error) => { ... registry.emit ... }) }` - no catch and no stored handle on the derived promise.

## [LOW] error-handling — packages/agent-runtime/src/tools/handlers/tool/spawn-agents.ts:305 — Verified-memory forwarding failures are swallowed silently with no log
- **Risk:** The `try { verifiedExcerptsForSpawn = getVerifiedMemoryExcerpts(...) } catch { verifiedExcerptsForSpawn = [] }` block (around 305) and the bare catch inside forwardVerifiedExcerpts drop every failure without logging. A broken discovery/memory integration degrades silently: children quietly lose verified context and no operator signal ever appears, making the failure indistinguishable from 'no verified memory exists'.
- **Fix:** Log the caught error at debug/warn with the parent run id (consistent with the milestone-only catches elsewhere in this handler), and keep the empty-array fallback.
- **Evidence:** spawn-agents.ts:302-306 `try { verifiedExcerptsForSpawn = getVerifiedMemoryExcerpts(parentAgentState, {...}).slice(0, 5) } catch { verifiedExcerptsForSpawn = [] }` and the `} catch { // Best-effort forwarding only. }` at the end of forwardVerifiedExcerpts - neither logs.

## [LOW] correctness — packages/agent-runtime/src/tools/handlers/tool/spawn-agent-utils.ts:344 — Handoff compaction silently drops array items, object keys, and nesting depth with no truncation marker
- **Risk:** compactValue truncates long strings with a visible marker but silently slices arrays to 64 entries (344) and objects to 64 keys (348), and replaces anything deeper than 6 levels with '[truncated nested handoff]'. A handoff carrying more than 64 findings, requirements, or path entries loses the tail invisibly: the child cannot tell the control-plane envelope was cut and the receipt carries no truncation record, so requirements can be silently unaddressed.
- **Fix:** When items or keys are dropped, append an explicit marker entry (e.g. { truncated: n }) and surface the compaction counts on the spawned-agent receipt so truncation is observable.
- **Evidence:** spawn-agent-utils.ts:343-350 `if (Array.isArray(value)) { return value.slice(0, 64).map(...) } return Object.fromEntries(Object.entries(value).slice(0, 64).map(...))` versus the string branch which returns `${value.slice(0, 3_000)}...[truncated handoff]...`.

## [LOW] correctness — packages/agent-runtime/src/tools/handlers/tool/spawn-agent-utils.ts:1486 — Receipt status is coerced to 'completed' whenever any mutation attestation exists, masking partial completion
- **Risk:** `mutationsComplete = mutationAgent && hasMutationProgress && errors.length === 0` (1486) overrides the child-reported status and rewrites output.value.status to 'completed' with the attested changedFiles. A child that applied 1 of several requested edits and reported 'blocked' or 'partial' surfaces to the parent as 'completed'; only its raw output text preserves the truth. Parent gates that read receipt.status (task-memory reconciliation, reviewer gates) can therefore treat incomplete work as done. The override is deliberate (RF-2/7/11/16 comments) but is invisible in the receipt.
- **Fix:** Emit 'partial' (or preserve findReceiptStatus) when the child reported 'blocked'/'partial', or record the coercion explicitly in receipt.errors/assumptions so downstream gates can see that the status was runtime-overridden.
- **Evidence:** spawn-agent-utils.ts:1486-1527 `const mutationsComplete = mutationAgent && hasMutationProgress && errors.length === 0` feeding `resolvedStatus` and `reconciledOutput` which sets `status: 'completed', changedFiles: ...` on the output value.

## [LOW] api-contract — packages/agent-runtime/src/templates/agent-registry.ts:109 — assembleLocalAgentTemplates drops static templates despite its documented contract
- **Risk:** The docstring says "Assemble local agent templates from fileContext + static templates" and getAgentTemplate's priority comment says localAgentTemplates holds "dynamic agents + static templates", but the implementation returns only `{ ...dynamicTemplates }` (109). Any caller expecting bundled static templates in the returned map silently gets a smaller lookup surface: lookups fall through to the database fetch or fail with 'Agent type X not found', and the error suggests a missing template that actually exists but was never assembled.
- **Fix:** Merge the bundled static template map into the returned record (static first, dynamic overriding), or correct the documented contract so callers know only dynamic agents are assembled here.
- **Evidence:** agent-registry.ts:92-110 `export function assembleLocalAgentTemplates` docstring "Assemble local agent templates from fileContext + static templates" and body `const agentTemplates = { ...dynamicTemplates }` with the comment "Use dynamic templates only".

## [LOW] api-contract — packages/agent-runtime/src/tools/handlers/tool/spawn-agent-utils.ts:1966 — logAgentSpawn is exported but never called - dead spawn-logging API
- **Risk:** logAgentSpawn (1966) is not imported by spawn-agents.ts or spawn-agent-inline.ts and has no other production callers, so the documented spawn-logging contract (template, prompt, and spawn metadata at debug level) never fires. The export will rot unnoticed and operators debugging spawn metadata get nothing, while the function's presence implies coverage that does not exist.
- **Fix:** Call logAgentSpawn at spawn start in both handlers (after validation, with the resolved template), or delete the export and its dead metadata plumbing.
- **Evidence:** spawn-agent-utils.ts:1966 `export function logAgentSpawn(params: {`; the import lists of spawn-agents.ts and spawn-agent-inline.ts include validateAndGetAgentTemplate, validateAgentInput, createAgentState, executeSubagent, extractSubagentContextParams, buildSpawnParamsWithHandoff, deriveSpawnTemplateCapabilities, validateVersionedAgentHandoff, buildRuntimeAgentReceipt, reconcileAgentReceiptIntoParent (and createCombinedAbortSignal) but not logAgentSpawn.

## [LOW] correctness — common/src/types/dynamic-agent-template.ts:71 — functionSchema's z.custom check returns a wrapped function instead of a boolean, so handleSteps values are effectively unvalidated
- **Risk:** `z.custom((fn: any) => schema.implement(fn))` (71) returns the zod-wrapped implementation - a truthy object - for any input, including non-functions (schema.implement does not type-check its argument). DynamicAgentTemplateSchema therefore accepts handleSteps values that are neither a StepHandler function nor generator code string; the misconfiguration only surfaces when the generator is invoked at runtime, far from the validation error a template author needed.
- **Fix:** Return a boolean from the custom check (`typeof fn === 'function'` plus an arity/shape probe) and keep z.string() for sandboxed generator code, so invalid handleSteps fail at template load with a path-precise issue.
- **Evidence:** dynamic-agent-template.ts:70-71 `const functionSchema = <T extends z.core.$ZodFunction>(schema: T) => z.custom<Parameters<T['implement']>[0]>((fn: any) => schema.implement(fn))`; line 93 `const HandleStepsSchema = functionSchema(` used in `z.union([z.string(), HandleStepsSchema])` for `handleSteps`.

## [LOW] dependency-hygiene — packages/agent-runtime/src/tools/handlers/tool/spawn-agent-inline.ts:2 — Full 'lodash' import for one helper in the spawn hot path
- **Risk:** `import { mapValues } from 'lodash'` (2) pulls the CJS lodash build for a single object-mapping helper in a runtime handler module - bundle size and cold-start cost on a hot spawn path. Lodash is also the kind of dependency that drifts to a transitive (undeclared) state in monorepos; nothing in this shard confirms it is a direct dependency of packages/agent-runtime.
- **Fix:** Replace with a 3-line local mapValues (or import from lodash-es/mapValues / lodash/mapValues) and confirm 'lodash' is declared in packages/agent-runtime/package.json rather than hoisted transitively.
- **Evidence:** spawn-agent-inline.ts:2 `import { mapValues } from 'lodash'`; its only use is `toolDefinitions: mapValues(parentTools, (tool) => ({ description: tool.description, inputSchema: tool.inputSchema as {} }))`.

## [LOW] security — common/src/types/agent-template.ts — handleSteps accepts arbitrary executable generator code with no provenance enforcement at the template boundary
- **Risk:** `handleSteps?: StepHandler<P, T> | string // Function or string of the generator code for running in a sandbox` allows templates to carry executable generator code, and AgentTemplate.executionSource ('bundled' | 'local' | 'database') merely records provenance. In this shard's surface nothing verifies integrity (signature/hash) of non-bundled executable templates before their handleSteps runs, so a database- or local-file-sourced template is trusted code execution on the same footing as bundled code.
- **Fix:** Require signed or hash-pinned provenance for executionSource !== 'bundled' before treating handleSteps as executable, and reject executable templates whose integrity cannot be verified.
- **Evidence:** common/src/types/agent-template.ts: `executionSource?: 'bundled' | 'local' | 'database'` documented as "Runtime provenance used to enforce executable-template trust boundaries" and `handleSteps?: StepHandler<P, T> | string // Function or string of the generator code for running in a sandbox`; dynamic-agent-template.ts accepts `handleSteps: z.union([z.string(), HandleStepsSchema])` with no integrity field.

## [LOW] correctness — packages/agent-runtime/src/tools/handlers/tool/spawn-agent-utils.ts:2083 — subagent_start is emitted outside the try that guarantees subagent_finish
- **Risk:** executeSubagent fires `onResponseChunk(startEvent)` (2083) before the try/catch that emits `subagent_finish` (with an error field on failure). If a chunk handler throws (client transport error, a throwing writeToClient), the spawn aborts with no matching finish event, leaving the UI and any consumer of the chunk stream with a started-but-never-finished child and no error marker.
- **Fix:** Emit the start event inside a try/finally that guarantees exactly one matching subagent_finish (with the thrown error) no matter how the chunk handlers behave.
- **Evidence:** spawn-agent-utils.ts:2076-2125 `onResponseChunk(startEvent)` at 2083 precedes `try { result = await loopAgentSteps({...}) } catch (error) { failed = true; onResponseChunk({ type: 'subagent_finish', ... error ... }); throw error }`.

## [LOW] api-contract — packages/agent-runtime/src/tools/handlers/tool/spawn-agent-utils.ts:837 — Normalized child output shape becomes size- and type-dependent, drifting the spawn result contract
- **Risk:** normalizeSpawnedAgentOutput (837) rewrites `{type:'error'}` outputs to `{errorMessage}`, injects synthetic `truncation` counters, replaces deeply nested values with `{type:'truncatedNestedAgentOutput'}`, and once serialization exceeds 256k may replace the whole structured output with `{type:'agentReceipt', truncated:true, summary}` or a reviewer-shaped projection. Consumers that parse `value.files`, `value.verdict`, or `value.summary` from spawn results therefore receive different shapes depending on output size and agent type - a silent contract change at size thresholds rather than a versioned envelope change.
- **Fix:** Keep one stable result envelope (always {status, value, truncation?}) across sizes and move size-based fallbacks into a documented `truncated` field, so consumers can detect degradation without shape-sniffing.
- **Evidence:** spawn-agent-utils.ts:837-870 `export function normalizeSpawnedAgentOutput` mapping `type:'error'` to `{errorMessage}`; boundAgentOutputForParent returning `{ type: 'agentReceipt', agentType, truncated: true, summary: ... }` past PARENT_AGENT_OUTPUT_MAX_CHARS (256_000) and `summarizeNestedAgentOutput` returning `{ type: 'truncatedNestedAgentOutput', truncated: true, ... }`.

## Coverage receipt

### Subsystems
- packages/agent-runtime
- common

### Features
- spawn-agents-batch-orchestration
- spawn-agent-inline-execution
- typed-handoff-validation
- spawn-permission-scoping
- runtime-agent-receipts
- receipt-reconciliation-ledger
- output-compaction-bounding
- librarian-clone-cleanup
- background-agent-jobs
- background-concurrency-caps
- agent-template-registry-lookup
- agent-template-schema-validation
- child-context-isolation
- spawn-depth-limiting
- child-lifecycle-api
- child-fs-process-isolation
- child-timeout-and-max-turns
- shell-spawn-type

### Files
- packages/agent-runtime/src/tools/handlers/tool/spawn-agents.ts
- packages/agent-runtime/src/tools/handlers/tool/spawn-agent-inline.ts
- packages/agent-runtime/src/tools/handlers/tool/spawn-agent-utils.ts
- packages/agent-runtime/src/util/background-agent-jobs.ts
- packages/agent-runtime/src/templates/agent-registry.ts
- packages/agent-runtime/src/templates/types.ts
- common/src/types/spawn.ts
- common/src/types/agent-handoff.ts
- common/src/types/agent-template.ts
- common/src/types/dynamic-agent-template.ts

### Domains
- security
- correctness
- state-mutation
- error-handling
- performance
- dependency-hygiene
- test-coverage
- api-contract
