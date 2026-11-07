# Audit findings: r4-supervision

- Subsystems: supervision-harness, parent-child-rpc-bridge, child-entry-contract, subagent-execution-settle-chain, workspace-path-leases, orchestration-ledger, background-agent-jobs
- Features: pr-t1-receipt-envelope, process-supervision-flag-gating, supervised-restart-policy, parent-child-rpc-bridge, nonce-stamped-wire-markers, incremental-promptaistream-bridging, child-entry-single-envelope-contract, workspace-path-lease-fencing, orchestration-ledger-reconciliation, background-agent-job-registry
- Files covered: 10
- Snapshot: d2df71d608d67a3324faf6271f018ab600c00fab18ad1a67b7964172d6289935

## [HIGH] state-mutation — packages/agent-runtime/src/tools/handlers/tool/spawn-agent-utils.ts:2738 — runSupervisedSubagent returns the PRE-spawn agentState; the supervised child's final messageHistory/workspaceState/taskMemory never flow back to the parent
- **Risk:** In-process loopAgentSteps returns the child's evolved agentState; the supervised branch returns the caller's pre-spawn state object unchanged, so parent-side consumers that read result.agentState.messageHistory (finalizeOwnedLibrarianClone), childRunIds accumulation against the child state, and later compaction/pruning operate on the child's INITIAL state. The parent's aggregate memory of what the child said/learned diverges from what the child actually did — the same class of divergence the context-pruner carve-out had to special-case, but for every supervised child.
- **Fix:** Either carry the final child state slice (messageHistory tail, workspaceState revision, taskMemory) in the receipt envelope or a bounded auxiliary stdout line, or explicitly document and gate parent-side features that read child state after a supervised spawn.
- **Evidence:** spawn-agent-utils.ts:2832/2845/2861/2870 return { agentState, ... } with the passed-in state; the receipt schema carries no messageHistory/workspaceState fields, and child-entry.ts writes only the receipt envelope.

## [HIGH] state-mutation — packages/agent-runtime/src/supervision/supervised-spawn.ts:198 — Restartable 'nonzero_exit' re-runs the whole child body even when the child already performed side effects before dying pre-envelope
- **Risk:** The restartable predicate cannot distinguish 'child never started' from 'child ran real steps (edited files, consumed credits) and died before emitting the envelope'. A nonzero_exit after committed edits re-runs the WHOLE body with the same request: duplicate file mutations, duplicate credit spend, and a second spawn_started ledger event for work already done. The restart budget multiplies the damage.
- **Fix:** Have the child attest the start of side-effecting work (a journal/ledger event or a first-line stdout marker before the first mutating tool call) and make a crash AFTER that attestation non-restartable, or make restarts idempotent by keying on childRunIds/child agentId dedupe.
- **Evidence:** RESTARTABLE_CRASH_REASONS = { spawn_failed, internal_error, nonzero_exit } (supervised-spawn.ts:198-202); isRestartableCrash only checks outcome==='crashed' && receipt===undefined; the supervisor settles nonzero_exit for ANY exit!==0 including post-mutation crashes; the restart loop re-invokes runSettledAttempt(request) with the SAME request.

## [MEDIUM] correctness — packages/agent-runtime/src/supervision/supervised-spawn.ts:271 — computeRestartDelayMs cap at Number.MAX_SAFE_INTEGER does not prevent the immediate-fire setTimeout overflow it documents
- **Risk:** The doc claims the MAX_SAFE_INTEGER cap avoids the setTimeout(Infinity)-fires-immediately failure, but timers over 2^31-1ms also fire immediately in Bun/Node, so a large backoffMultiplier still produces a near-zero delay. The attempt bound (not the delay) is the only real wall-clock bound, so behavior stays bounded, but a restart storm burns attempts at ~0ms backoff instead of backing off.
- **Fix:** Clamp the delay to a practical ceiling (e.g. min(delay, 2**31-1) or a 30-60s max backoff) and correct the docblock; keep the attempt bound as the real cost bound.
- **Evidence:** computeRestartDelayMs returns Number.MAX_SAFE_INTEGER (~9.0e15), far beyond the 2147483647ms timer ceiling; the docblock's rationale ('setTimeout(Infinity) fires IMMEDIATELY...') applies equally to the returned cap.

## [MEDIUM] security — packages/agent-runtime/src/supervision/parent-bridge-server.ts:200 — Parent bridge server performs no connection authentication — any same-user local process can invoke the bridged handlers, including fetch proxy and credit consumption with the parent's apiKey
- **Risk:** The bridge server trusts ANY client that connects to the socket: there is no peer-credential check and no per-connection auth token (the per-table nonce only gates marker substitution, not dispatch). Any process running as the same user that can traverse the 0700 sandbox dir (e.g. a compromised tool subprocess of another agent in the same session) can connect and invoke promptAiSdk/fetch/consumeCreditsWithFallback — the parent stamps its own authoritative apiKey into every bridged request, so the attacker pivots LLM calls, arbitrary fetch (SSRF), and credit consumption through the parent's credentials.
- **Fix:** Authenticate the first line per connection with a per-server secret minted next to the nonce, or verify SO_PEERCRED/peer pid equals the spawned child pid before accepting dispatch.
- **Evidence:** startParentBridgeServer's net.createServer callback adds sockets and dispatches lines with no credential check; nonce only gates marker substitution (bridge-protocol.ts:484); SupervisedBridgeHandlerDeps.apiKey is stamped into prompt/startAgentRun/finishAgentRun/addAgentStep/fetchAgentFromDatabase handlers (parent-bridge-server.ts:812/1124-1143).

## [MEDIUM] state-mutation — packages/agent-runtime/src/util/workspace-path-leases.ts:101 — releaseWorkspacePathLease has no ownership check and leases carry no fencing token — any agent can release another agent's lease by id
- **Risk:** extendWorkspacePathLease enforces ownership, but releaseWorkspacePathLease does not: any agent holding the bare leaseId string can release another agent's ACTIVE lease and then acquire the overlapping paths itself, while the previous owner believes it still holds exclusivity. There is also no fencing token: the leaseId never changes across release/re-acquire, so a stale holder cannot even detect that its lease was transferred. The lease subsystem answers the fencing-token audit question in the negative — it is a coordination hint, not an exclusion primitive.
- **Fix:** Require ownerAgentId on release and reject mismatches like extend does; add a monotonically increasing generation number checked at acquire time so a released-then-reacquired lease invalidates stale handles.
- **Evidence:** releaseWorkspacePathLease(state, leaseId, now) deletes activeLeases and flips the durable record with no owner comparison; extendWorkspacePathLease explicitly checks params.ownerAgentId !== lease.ownerAgentId and throws; no lease generation/epoch field exists on ActiveLease.

## [HIGH] state-mutation — packages/agent-runtime/src/util/workspace-path-leases.ts:16 — Workspace-path lease registry is process-local, so supervised children (separate processes) never see the parent's or each other's leases — mutual exclusion silently vanishes across the supervision boundary
- **Risk:** A supervised child executes acquireWorkspacePathLease inside its OWN process, where the module-level activeLeases map starts empty: the child's acquire NEVER conflicts with the parent's or sibling supervised children's leases, and its release never updates the parent's map. Two supervised editors mutating the same paths are both granted 'active' exclusivity concurrently — the lease guarantee silently does not exist exactly where process supervision enables the heaviest parallel mutation.
- **Fix:** Route lease acquire/release through the parent bridge (a new bridged lease method) or persist leases in the run journal / a shared store so all supervisors observe the same lease set.
- **Evidence:** const activeLeases = new Map<string, ActiveLease>() at module scope; nothing in supervised-spawn.ts, child-entry.ts, or the bridge method list (BRIDGE_METHODS) carries lease state across processes; reconcileInterruptedPathLeases only patches the parent's durable records against the parent's own map.

## [MEDIUM] test-coverage — packages/agent-runtime/src/tools/handlers/tool/spawn-agent-utils.ts:3007 — No test exercises reaping of REAL shell grandchildren, and no test covers lease behavior across the supervision process boundary
- **Risk:** The documented teardown contract (grandchildren die with the group on timeout) has no test, so regressions in detached/killGroup semantics would ship silently; likewise the lease subsystem's behavior across the supervised-child process boundary (see the process-local registry finding) is untested and currently broken-by-design.
- **Fix:** Add a real-child e2e that spawns a shell grandchild (setsid and non-setsid variants) and asserts group reaping on timeout; add a two-process lease conflict test for the supervised boundary.
- **Evidence:** spawn-agent-utils.ts:3007-3010 'The residual gap: no test yet exercises reaping of REAL shell grandchildren'; workspace-path-leases tests exercise only the in-process Map.

## [HIGH] correctness — packages/agent-runtime/src/util/background-agent-jobs.ts:211 — currentChunks assumes the core ring and the live view hold the same chunks, but the core ring also holds lifecycle/status events — chunk sequences drift and cursor consumers silently lose data
- **Risk:** The core's 200-event ring buffer holds agent_chunk AND lifecycle/status events, so it evicts chunk events earlier than the view's 200-chunk ring. currentChunks then returns fewer chunks than the view holds and computes firstSequence from job.nextSequence - chunkEvents.length, producing sequence numbers that no longer match the view's numbering — readBackgroundAgentChunks' cursor math reports wrong droppedChunks and cursor consumers can skip or double-count chunks relative to readNewBackgroundAgentChunks consumers.
- **Fix:** Derive sequence numbering from the snapshot's own first chunk sequence (or persist a core-side chunk sequence), and reconcile the two readers onto one sequence space.
- **Evidence:** currentChunks derives firstSequence = job.nextSequence - chunkEvents.length from a core snapshot that can contain fewer chunk events than the view holds; the docblock's 'always hold the same chunks' premise is false once non-chunk events fill the core ring.

## [LOW] error-handling — packages/agent-runtime/src/supervision/process-supervisor.ts:346 — killed flag is set before the kill attempt, and the internal_error settle discards captured stdout diagnostics
- **Risk:** killed=true is set before killChild runs, so if both SIGTERM and SIGKILL throw (child already gone), the settled result still reports killed=true; the internal_error path also reports stdoutBytes 0 even when the capture streams had already buffered bytes, degrading the bounded-log diagnostics the crash triage relies on.
- **Fix:** Set killed only after a kill attempt that did not throw (or verify via proc.exited); include stdoutBytes/stderrTail from the captured buffers on the internal_error result.
- **Evidence:** timedOut=true; killed=true precede killChild attempts wrapped in empty catch; crashResult('internal_error', null, { killed }) leaves stdoutBytes at the 0 default.

## [MEDIUM] api-contract — packages/agent-runtime/src/supervision/parent-bridge-server.ts:262 — Notify-budget admission keyed on the child-controlled 'notify-' id prefix, and the reserved BRIDGE_CLOSE_ID is echoable as a reply id
- **Risk:** Notification budget admission is keyed on the client-chosen id prefix, so any request id starting with 'notify-' routes into the 128-notification budget instead of the 64-request budget (self-inflicted DoS / budget confusion). Separately, a child request with id exactly 'bridge-close' gets a reply carrying that id, which the child client's readLine treats as the parent close notification and fail-closes the whole bridge — a self-DoS triggered by one malformed call.
- **Fix:** Classify notifications by METHOD (a fixed notify-method set) rather than id prefix, and reject/reserve the bridge-close id server-side so it can never be echoed as a reply id.
- **Evidence:** isNotify = parsed.id.startsWith('notify-'); child-bridge-client.ts:161 'if (parsed.id === BRIDGE_CLOSE_ID) failClosed(...)'; writeMessage lets the caller choose any id shape.

## [MEDIUM] error-handling — packages/agent-runtime/src/supervision/parent-bridge-server.ts:223 — Oversized/unencodable reply destroys the WHOLE socket, and the per-message cap backstop is still reachable on non-stream bridged methods
- **Risk:** When encodeBridgeMessage throws for an oversized result, the reply path destroys the socket, killing ALL in-flight requests on that connection — the exact 'socket destroy settles a valid run as crashed' failure the stream-chunk budget was built to avoid, still reachable on every other bridged method whose result is unbounded (a huge promptAiSdk result, a large fetch bodyText, a big agent template). One oversized reply converts a healthy bridge into a bridge-connect/mid-run failure for all concurrent calls.
- **Fix:** Apply a per-method result budget (serialize-probe like handleIncrementalStreamNext) that answers a structured 'result too large' failure reply instead of destroying the shared socket.
- **Evidence:** reply() catches encodeBridgeMessage throw → socket.destroy() (parent-bridge-server.ts:223-230); only collectPromptStream and the incremental next path pre-budget their results; promptAiSdkStructured/fetchAgentFromDatabase/consumeCreditsWithFallback results are unbounded before encode.

## [MEDIUM] correctness — packages/agent-runtime/src/supervision/child-entry.ts:150 — getUserInfoFromApiKey fails closed to null for supervised children — BYOK user context silently diverges from the in-process path while the deps gate reports 'all supplied'
- **Risk:** In-process, getUserInfoFromApiKey supplies identity/billing context; supervised children always get null, so BYOK runs lose user-derived context silently (the dep gate reports no missing dep because the local stub counts as supplied). The fresh per-run databaseAgentCache also means published-agent memoization restarts per supervised spawn rather than per parent turn.
- **Fix:** Bridge a serializable projection of the user-info result, or surface the degradation in the receipt errors[] like the unsupported-deps gate does so it is diagnosable.
- **Evidence:** buildLocalChildDeps returns getUserInfoFromApiKey: async () => null (child-entry.ts:384-392); LOCALLY_SUPPLIED_DEP_NAMES marks it 'supplied' so the unsupported-deps gate never fires for it; databaseAgentCache is a fresh Map so cross-spawn template memoization within one parent turn does not carry into the child.

## [MEDIUM] api-contract — packages/agent-runtime/src/supervision/child-bridge-client.ts:351 — Structured prompts with refinements/transforms are a silent capability regression under supervision: JSON-Schema round trip guarantees a mid-run fail-closed rejection
- **Risk:** Agents whose set_output schemas use zod refinements/transforms or unrepresentable types (z.date, z.bigint) work in-process but fail closed under supervision: the child's promise rejects mid-loop and the run settles as a failed receipt. The eligibility is never surfaced at spawn time — only the unsupported-deps gate pre-flights — so the failure is discovered mid-run with provider spend already incurred.
- **Fix:** Pre-flight the schema at spawn time (degrade eligibility like the unsupported-deps gate) or transport refinements out-of-band; at minimum document the eligibility constraint on the template contract.
- **Evidence:** toBridgeJsonSchema calls z.toJSONSchema(schema) and propagates the throw (child-bridge-client.ts:351-355); the child-side re-validation throws on refinement violations (child-bridge-client.ts:676-685); the parent's convertJsonSchemaToZod rebuild drops refinements (parent-bridge-server.ts:1080).

## [MEDIUM] error-handling — packages/agent-runtime/src/tools/handlers/tool/spawn-agent-utils.ts:3000 — Supervised child does not observe the parent AbortSignal: user cancellation orphans a live, credit-consuming child until the 10-minute deadline
- **Risk:** On user/parent cancellation the supervised child keeps running its full wall-clock deadline (default 10 minutes) with live provider access through the bridge — continued credit spend and potential continued file mutation after the parent gave up. The rehydrated bridge signal is a fresh never-aborted controller, so nothing parent-side can cancel an in-flight child prompt.
- **Fix:** Bridge a cancel notification (parent abort → socket-level or notify method) that rejects the child's local signal so the loop unwinds promptly; wire the parent signal into the supervised seam.
- **Evidence:** spawn-agent-utils.ts:3000-3004 slice limitation comment; child loopParams signal: new AbortController().signal (child-entry.ts:570); no bridge method carries an abort notification (BRIDGE_METHODS has none).

## [LOW] correctness — packages/agent-runtime/src/supervision/parent-bridge-server.ts:435 — rehydrateParams depth>12 silently replaces deep structures with undefined instead of failing closed
- **Risk:** A legitimately deep (13+ levels) param structure is silently truncated to undefined members rather than failing closed — the receiving dep sees missing fields with no diagnostic on either side. Both directions share the bound, so the degradation is symmetric but silent, unlike the loud truncation contracts elsewhere in the bridge.
- **Fix:** Emit a loud stderr warning naming the dropped path (matching the codebase's 'bounded bridge is never a silent drop' convention) or fail closed on over-deep params.
- **Evidence:** walk: 'if (depth > 12) return undefined' with no diagnostic or error; the child sanitizer mirrors it (SANITIZE_MAX_DEPTH, child-bridge-client.ts:301); the marker stash/coercion only covers the two named roots.

## [LOW] state-mutation — packages/agent-runtime/src/util/orchestration-ledger.ts:23 — Orchestration ledger has no idempotency for duplicate spawn_finished events, and the checksum is recomputed post-compaction so historical integrity of dropped events is unverifiable
- **Risk:** A replayed settle tail (e.g. journal-resumed run delivering the same receipt twice through a different code path) appends a SECOND spawn_finished for the same spawnId, inflating the revision and breaking the one-start/one-finish pairing invariant downstream consumers may assume. Additionally the checksum is recomputed over compacted events, so the integrity of events dropped during compaction is unverifiable after the fact — the checksum validates the current window only.
- **Fix:** Dedupe spawn_finished by spawnId (first-wins) like receipt_reconciled, and carry a compacted-from checksum chain or compaction marker for auditability.
- **Evidence:** appendOrchestrationEvent dedupes only eventId and receipt_reconciled-by-receiptId (lines 57-71); compactEvents recomputes checksum over the compacted array (line 94); reconcileInterruptedLedgerSpawns tolerates duplicates only because it set-collects spawnIds.

## Coverage receipt

### Subsystems
- supervision-harness
- parent-child-rpc-bridge
- child-entry-contract
- subagent-execution-settle-chain
- workspace-path-leases
- orchestration-ledger
- background-agent-jobs

### Features
- pr-t1-receipt-envelope
- process-supervision-flag-gating
- supervised-restart-policy
- parent-child-rpc-bridge
- nonce-stamped-wire-markers
- incremental-promptaistream-bridging
- child-entry-single-envelope-contract
- workspace-path-lease-fencing
- orchestration-ledger-reconciliation
- background-agent-job-registry

### Files
- packages/agent-runtime/src/supervision/process-supervisor.ts
- packages/agent-runtime/src/supervision/supervised-spawn.ts
- packages/agent-runtime/src/supervision/bridge-protocol.ts
- packages/agent-runtime/src/supervision/parent-bridge-server.ts
- packages/agent-runtime/src/supervision/child-bridge-client.ts
- packages/agent-runtime/src/supervision/child-entry.ts
- packages/agent-runtime/src/tools/handlers/tool/spawn-agent-utils.ts
- packages/agent-runtime/src/util/background-agent-jobs.ts
- packages/agent-runtime/src/util/workspace-path-leases.ts
- packages/agent-runtime/src/util/orchestration-ledger.ts

### Domains
- security
- correctness
- state-mutation
- error-handling
- performance
- dependency-hygiene
- test-coverage
- api-contract
