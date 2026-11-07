# Audit findings: shard-p2-durability

- Subsystems: agent-runtime-journal, agent-runtime-supervision, sdk-filesystem-tools, sdk-dash, cli-turn-snapshots, cli-index-watch
- Features: p2-t2-run-journal, p2-t2-replay-driver, p2-t8-supervised-spawn, p2-t5-transaction-intent-log, p2-t5-change-files-tx-wiring, p2-t4-turn-snapshots-bisection, p2-t7-dash-server, p2-t7-dash-provider, p2-t7-dash-static-export, run-journal-path-wiring, index-dir-watch-pool
- Files covered: 13
- Snapshot: 5c80253b458f8b07b8ca33e50cc3d6ad7e6cda07ef1715ba8adffd8c77905ab7

## [HIGH] performance — sdk/src/tools/transaction-intent-log.ts:625 — Intent-log append is a whole-file read-rewrite+fsync per event (O(n^2) cumulative)
- **Risk:** Every event append re-reads the ENTIRE JSONL log, re-serializes all surviving groups, rewrites the whole file via tmp+fsync+rename+dir-fsync, and fsyncs the state dir. With the 8 MiB cap reached, each of a transaction's 3+ appends moves/flushes ~8 MiB, making multi-file transactions O(log-size) per event and O(n^2) cumulatively; fsync storms slow every edit_transaction on large logs.
- **Fix:** Append-only writes (open 'a' + fsync) for tx_commit/tx_abort/tx_begin, keeping the read-rewrite only for the bounded trim path, or compact asynchronously under the same lock.
- **Evidence:** withIntentLogLock wraps readEvents() + boundTransactionGroups() + writeAtomic() for every beginTransaction/commitTransaction/abortTransaction; writeAtomic opens, writes, syncs, renames and dir-syncs the full serialized log each time.

## [HIGH] performance — packages/agent-runtime/src/util/run-journal.ts:500 — maxBytes retention does a full per-run table scan on EVERY append
- **Risk:** RUN_JOURNAL_DEFAULT_RETENTION sets maxBytes=512 MiB, so every append (or batch flush) scans ALL retained rows of the run and JSON-parses nothing but pays a full ordered scan plus per-row LENGTH just to compute the byte budget. Over a 20k-event run this is ~200M row visits in the synchronous hot path of the agent loop, directly slowing every tool call and LLM step.
- **Fix:** Maintain a running byte total per run (tracked in memory or a summary row), or scan from the oldest seq with a LIMIT/windowed sum and stop once the cap is met, instead of materializing every row per append.
- **Evidence:** const rows = db.query('SELECT seq, LENGTH(CAST(payload AS BLOB)) AS len FROM run_events WHERE run_id = ? ORDER BY seq ASC').all(runId) runs unconditionally on every append when maxBytesCap is set.

## [MEDIUM] performance — packages/agent-runtime/src/util/run-journal.ts:895 — toolResultForInput full-history scan with per-row JSON.parse on every tool dispatch
- **Risk:** toolResultForInput loads every tool_call row of the run, JSON.parse()s each payload, and for each name/shape match issues a nested tool_result query. Called on every tool dispatch, cost grows with total journaled calls; with retention up to 20k events/512 MiB, a long run pays a multi-MB parse per tool call.
- **Fix:** Maintain an in-memory per-run index (or a SQL expression index on a canonical-input-key column written at insert time) so the Nth completed match is found without scanning and re-parsing the whole history per dispatch.
- **Evidence:** SELECT seq, correlation, payload FROM run_events WHERE run_id = ? AND event_type = 'tool_call' ORDER BY seq ASC followed by per-row JSON.parse and a nested tool_result lookup per candidate.

## [MEDIUM] performance — packages/agent-runtime/src/util/run-journal.ts:1010 — classifyRunResume/planChildResume load the full run event list to inspect the tail
- **Risk:** classifyRunResume, planChildResume and planBackgroundAgentResume each call reader.events(runId), materializing the run's ENTIRE retained history (up to 20k events/512 MiB per run-journal-path defaults) in memory just to test whether one later event matches the tail. planChildResume additionally re-classifies each child the same way.
- **Fix:** Add a reader primitive that queries only events with seq > last.seq for a given type/correlation (the same bounded lookup toolResultFor already uses) instead of materializing the full event list.
- **Evidence:** reader.events(runId).some(...) inside classifyRunResume for both the tool_call and llm_request branches; planChildResume also starts with reader.events(parentRunId).

## [MEDIUM] performance — sdk/src/dash/provider.ts:75 — dash listRuns materializes every event of every listed run just to count them
- **Risk:** listRuns calls journalReader.events(runId) for each of up to 64 run ids and keeps only length and first event, materializing up to ~1.28M journal rows (64 x 20k retained events) per dashboard request; the server calls listRuns on every /api/runs poll.
- **Fix:** Use a lightweight count/first-event reader primitive (e.g. a SQL COUNT + MIN(created_at) per run) instead of hydrating every event per listing call.
- **Evidence:** for (const runId of knownRunIds()) { const events = journalReader.events(runId); ... eventCount: events.length } — full event arrays retained only to read .length and events[0].

## [MEDIUM] correctness — sdk/src/tools/transaction-intent-log.ts:500 — Lock-break unlink race can delete a freshly acquired lock, allowing two concurrent writers
- **Risk:** Two waiters can both observe a dead/stale holder, and the second waiter's unlink can delete the FIRST waiter's freshly created lock (open 'wx' succeeded between the stale read and the unlink). Both then proceed under the belief they hold the lock, interleaving the whole-file read-rewrite and silently dropping another transaction's tx_begin/tx_commit line — exactly the lost-marker corruption the lock exists to prevent.
- **Fix:** Guard the break by identity: re-stat (or open+read) the lock immediately before unlink and verify it is still the same file/inode (mtime+content match, or rename-then-unlink of the exact path to a private temp name), and make losers detect a replaced lock via their recorded holder identity.
- **Evidence:** holder/breakLock decided from readIntentLogLockHolder + isProcessAlive; `await unlink(lockPath)` executes later with no re-verification, then the loop retries `open(lockPath, 'wx')`.

## [MEDIUM] correctness — sdk/src/tools/transaction-intent-log.ts:430 — Trim can evict a live sibling's half-applied tx_begin, destroying its durable pre-image
- **Risk:** Bounded-file policy drops OLDEST transactions first with no regard for resolution state. A sibling process that began a transaction (tx_begin appended, tx_commit not yet) and then stalls >100 newer transactions (or >8 MiB of newer traffic) has its tx_begin evicted; on recovery its half-applied file mutations can never be reverted, and a lost tx_commit variant makes recovery revert files the transaction already committed — the inverse corruption.
- **Fix:** Pin unfinished (last-event-tx_begin) groups during trim, or refuse the append (ok:false) when the trim would evict an unresolved tx_begin, so a live writer's pre-image is never silently dropped.
- **Evidence:** while (bounded.length > maxTransactions || measuredBytes(bounded) > maxBytes) bounded.shift() — no liveness/age check on the evicted group; appendEvent persists the bounded result unconditionally.

## [MEDIUM] correctness — packages/agent-runtime/src/util/run-journal.ts:870 — Opt-in batching defers the tool_call completion-marker commit past tool execution (replay double-execution window)
- **Risk:** The module contract states append 'must commit its completion-marker boundary before the tool executes'. With batching enabled, a journaled tool_call can sit in memory up to 50 ms / 32 events while the side-effecting tool runs; a kill -9 in that window leaves the journal showing the PREVIOUS tail, so classifyRunResume says 'clean' and replay re-executes an already-applied side-effecting tool call — a double-execution window batch mode reintroduces.
- **Fix:** Force a synchronous flush (drainPending) before any side-effecting tool_call event is allowed to execute, or exempt side-effecting tool_call/llm_request completion markers from batching.
- **Evidence:** if (pending.length >= batching.maxBatchEvents) { drainPending() } else { scheduleFlushTimer(batching.maxBatchDelayMs) } — no flush is forced before tool dispatch.

## [MEDIUM] error-handling — packages/agent-runtime/src/util/run-journal.ts:970 — close() can leak the sqlite connection and flush timer when the final drain throws
- **Risk:** close() calls drainPending() before setting closed or closing the db. A non-SQLITE_BUSY insert error (e.g. disk I/O error) propagates out of close(), skipping db.close() and clearFlushTimer(), leaving the sqlite handle and the unref'd timer alive for process lifetime and wedging the connection's stranded transaction state.
- **Fix:** Wrap drainPending in try/finally so the timer is cleared and db.close() always runs, then set closed=true before propagating (or swallowing) the drain error.
- **Evidence:** close(): drainPending(); clearFlushTimer(); db.close(); closed = true — a throw from drainPending skips clearFlushTimer and db.close, and no try/finally protects them.

## [MEDIUM] correctness — cli/src/utils/turn-snapshots.ts:40 — Turn-snapshot ref grows unbounded and pollutes the user's git namespace (gc never reclaims it)
- **Risk:** Every turn appends a commit to refs/openbuff/turns with no pruning, so the chain and its objects grow without bound and are kept alive against git gc forever (repo bloat proportional to session history). Additionally `git push --mirror` (or any refspec wildcard push) happily publishes refs/openbuff/turns to the user's remote.
- **Fix:** Add a retention policy (e.g. keep newest N snapshots, delete older ones with git delete-ref + repack/prune reachable-only-through-the-ref objects), and/or keep snapshots in an alternates object store outside the user's repo so the ref namespace and object count stay bounded.
- **Evidence:** refs/openbuff/turns is updated via update-ref on every turn; listTurnSnapshots caps listing at 100 but nothing prunes commits/objects; docs say the ref is private but never address push/gc behavior.

## [LOW] security — cli/src/utils/turn-snapshots.ts:195 — Snapshot commits capture uncommitted tracked content (including possible secrets) and are pushable via --mirror
- **Risk:** Snapshots capture the tracked tree INCLUDING uncommitted working-tree state. If a user edits a credential-bearing tracked file mid-session (or secrets pass through tracked files), the bytes are committed as openbuff-authored objects; a `git push --mirror` or clone-with-refs transfer would publish them outside the machine, bypassing the user's intentional 'not committed yet' state.
- **Fix:** Restrict snapshot pushes (document/intercept --mirror exposure is hard; at minimum exclude sensitive paths via the snapshot index update or store snapshots under a refs namespace excluded from remote config), and bound retention so stale secret-bearing snapshots are deleted.
- **Evidence:** createTurnSnapshot seeds the index from HEAD then `git add -u` (working tree deltas) and commit-tree; nothing filters or encrypts snapshot contents.

## [MEDIUM] error-handling — packages/agent-runtime/src/supervision/process-supervisor.ts:345 — Settle has no deadline independent of child death: an unkillable child hangs the supervisor forever
- **Risk:** The timeout path only sends signals; if the child ignores SIGKILL (uninterruptible D state), the group kill throws repeatedly and is swallowed, or the injected seam's kill is a no-op, captureStream's `await reader.read()` and `await proc.exited` never settle and spawnSettledSubagent hangs forever, leaking both the child and the supervisor's callers' awaited promise (an fd/process leak in the supervision path itself).
- **Fix:** Race captureStream/proc.exited against an absolute deadline (timeoutMs + grace + margin); on deadline, resolve a crashed 'timeout' outcome, terminate the worker-side readers, and report stdoutBytes counted so far.
- **Evidence:** termTimer schedules killChild('SIGTERM') then killTimer killChild('SIGKILL'), both in try/catch swallow; captureStream loops `await reader.read()` with no deadline; proc.exited awaited without a race against a hard deadline.

## [LOW] correctness — packages/agent-runtime/src/supervision/process-supervisor.ts:430 — Multiple stdout lines accepted; last non-empty line wins despite one-line contract
- **Risk:** The child contract is 'exactly ONE newline-terminated JSON line', but the settle path takes the LAST non-empty line and validates only it; a child that prints debug/log lines and then a receipt settles as 'ok', so whatever earlier unvalidated bytes the child emitted are ignored rather than treated as a contract violation — a weakening of the security contract that garbage stdout is never ok.
- **Fix:** Reject stdout with more than one non-empty line as schema_invalid (or crashed/malformed_output) so a chatty child can never smuggle a crafted envelope past earlier unvalidated output.
- **Evidence:** const lastLine = [...lines].reverse().find((line) => line.trim().length > 0) — earlier non-empty lines are silently discarded before agentReceiptSchema.safeParse(JSON.parse(lastLine)).

## [LOW] error-handling — packages/agent-runtime/src/supervision/supervised-spawn.ts:60 — Default supervised-spawn seam can throw (mkdtemp/writeFile) instead of returning a structured failed receipt
- **Risk:** mkdtempSync (e.g. ENOSPC on tmpdir) or writeFileSync (EACCES/ENOSPC) rejects the seam with a raw Node error. SpawnSupervisedFn's documented contract (mirroring the supervisor's 'returns a structured outcome; never throws') is violated, so a transient tmpdir failure surfaces as an unhandled rejection in the flag-gated spawn path instead of an honest failed receipt.
- **Fix:** Wrap sandbox creation/request-file write in try/catch and return a structured failed receipt (crashed/spawn_failed) instead of throwing from the seam.
- **Evidence:** const sandboxCwd = mkdtempSync(join(tmpdir(), 'openbuff-supervised-cwd-')) and writeFileSync(requestPath, ...) execute outside any try; the finally block only covers post-mkdtemp cleanup.

## [LOW] error-handling — packages/agent-runtime/src/supervision/child-entry.ts:145 — defaultWrite voids Bun.write promise: unhandled rejection can crash the child mid-envelope
- **Risk:** If the stdout pipe write fails (e.g. the supervisor already tore down the pipe after a timeout kill), the voided promise rejects with no handler, producing an unhandled rejection that can crash the child with a non-contract exit code/stderr noise instead of the clean exit-1 path.
- **Fix:** Await the write (or attach a .catch that returns exit 1) so a failed envelope write maps to the contract's exit-1 failure path.
- **Evidence:** const defaultWrite: ChildEntryWrite = (line) => { void Bun.write(Bun.stdout, line) } — rejection is neither awaited nor caught.

## [MEDIUM] security — sdk/src/tools/transaction-intent-log.ts:200 — Durable pre-images persist full plaintext file contents (potentially secrets) in the shared state dir
- **Risk:** The module invariant asserts 'no cap.v3 secrets: paths, hashes and pre-images only', but beforeBytes is the full prior content of arbitrary project files — which may include .env values, API keys, or credentials the user kept out of git. These persist indefinitely (bounded by 100 transactions/8 MiB) in the shared harness state dir, readable by anything with the user's privileges, a broader exposure than the invariant's wording implies.
- **Fix:** Document the exposure explicitly, restrict stateDir permissions (0o700 dir / 0o600 log), and consider encrypting beforeBytes at rest or excluding sensitive paths (e.g. env/dotenv patterns) from durable pre-image capture with a clear warning in the tx result.
- **Evidence:** Invariants claim 'only before-images are stored (never after-bytes), and no cap.v3 secrets: paths, hashes and pre-images only'; beforeBytes carries raw UTF-8 file bytes into writeAtomic's plaintext JSONL.

## [MEDIUM] state-mutation — sdk/src/tools/change-file.ts:600 — AbortSignal not rechecked between per-change commits inside the transaction loop
- **Risk:** signal.aborted is checked once before beginCommit; the per-change commit loop never re-checks it. A user cancellation or deadline abort arriving while a multi-file transaction is mid-commit is ignored, and every remaining file is still written — mutations proceed after the caller believes the operation was cancelled.
- **Fix:** Recheck signal?.aborted at the top of each per-change iteration and abort the transaction (rollback committed prefix, abortTransaction marker) instead of continuing to commit.
- **Evidence:** for (const change of prepared) { await commitPreparedTransactionChange(change, fs, authority) } — no `if (signal?.aborted)` recheck; the earlier check runs before beginCommit only.

## [LOW] state-mutation — cli/src/utils/turn-snapshots.ts:470 — Bisection guard/cancel flags are process-global mutable state, unsafe across processes
- **Risk:** The in-flight guard and cancellation flag are module-level globals: they coordinate only within one process. A second openbuff process (or a headless run alongside the TUI) can snapshot/rewrite the tracked tree during an active bisection, corrupting the chain the search walks, and the 'always restores newest tree' contract can be broken by the other process's interleaved checkout-index.
- **Fix:** Persist a lock file/marker (e.g. under the project state dir) for the bisection lifetime, or accept and document the single-process limitation explicitly at the command boundary.
- **Evidence:** let bisectCancelled = false; let bisectRunning = false; guarded synchronously in runTurnBisection and checked in createTurnSnapshot, with no cross-process lock.

## [LOW] error-handling — cli/src/utils/index-dir-watch.ts:175 — Watcher worker crash is swallowed with no diagnostics
- **Risk:** worker.on('error') calls degradeOnce() with the error object unused and no logging anywhere; a persistently crashing watcher worker (e.g. a Bun fs.watch SIGILL loop) silently degrades the whole session to age-based sweeps with zero diagnostic signal, making the resulting stale-index behavior undiagnosable.
- **Fix:** Thread an optional logger/onDegrade(reason) through startDirectoryIndexWatch and log the worker error message and exit code once when degrading.
- **Evidence:** worker.on('error', () => { degradeOnce() }) and worker.on('exit', (code) => { if (code !== 0) degradeOnce() }) — the Error object and exit code are not surfaced to any logger.

## [MEDIUM] test-coverage — packages/agent-runtime/src/util/run-replay-driver.ts:200 — Replay driver has no production call site — replay/resume wiring is test-only
- **Risk:** The replay driver — the component whose entire purpose is preventing replay double-execution — is exercised only by unit tests with injected handlers. The production resume path's actual seam wiring (reDriveChild/respawnBackground implementations, marker journaling parity) is unverified, so the crash-atomicity claim rests on untested integration; the documented gap that no in-repo production re-launch path exists confirms the double-execution safety is aspirational.
- **Fix:** Wire the driver into the resume path (or explicitly remove it until the RPC/bridge slice lands) and add an integration test that kills a run mid-tool-call and asserts no double execution through the wired seams.
- **Evidence:** referencedBy for executeRunResumeReport lists only packages/agent-runtime/src/util/__tests__/run-replay-driver.test.ts; the file's own header admits 'the reDriveChild/respawnBackground seams still do not replay a background child from its own journal'.

## [LOW] api-contract — packages/agent-runtime/src/supervision/process-supervisor.ts:240 — memoryLimitMb accepted but never enforced — contract advertises a cap that does not exist
- **Risk:** Callers (and the audit plan) treat memoryLimitMb as a supervision guarantee; it is silently ignored, so a runaway supervised child can exhaust host memory with no cap and no error. A caller relying on the parameter has no way to detect the no-op.
- **Fix:** Either enforce a cap where the platform allows (e.g. ulimit/rlimit via the spawn seam) or rename/document the parameter as reserved so callers do not rely on a cap that does not exist.
- **Evidence:** /** Accepted for contract completeness; enforcement rides the adoption slice (see module doc). */ memoryLimitMb?: number — never referenced in spawnSettledSubagent.

## [LOW] security — sdk/src/dash/server.ts:455 — Dash token accepted via ?token= query and returned embedded in the handle URL
- **Risk:** The query-parameter fallback places the 256-bit dashboard token into URLs, which persist in shell history (command line that opens the URL), browser history, and any process listing that captured the printed URL. Loopback-only binding and constant-time comparison contain the blast radius, but the header-first path is strictly safer and the query form is offered by default.
- **Fix:** Prefer a header-only default with an explicit --token-in-url opt-in, or print a header-based curl example and mark the query fallback as deprecated for non-interactive use.
- **Evidence:** const url = `http://127.0.0.1:${server.port}/?token=${encodeURIComponent(token)}` — no header-only mode; server header comment documents the ?token= fallback.

## Coverage receipt

### Subsystems
- agent-runtime-journal
- agent-runtime-supervision
- sdk-filesystem-tools
- sdk-dash
- cli-turn-snapshots
- cli-index-watch

### Features
- p2-t2-run-journal
- p2-t2-replay-driver
- p2-t8-supervised-spawn
- p2-t5-transaction-intent-log
- p2-t5-change-files-tx-wiring
- p2-t4-turn-snapshots-bisection
- p2-t7-dash-server
- p2-t7-dash-provider
- p2-t7-dash-static-export
- run-journal-path-wiring
- index-dir-watch-pool

### Files
- packages/agent-runtime/src/util/run-journal.ts
- packages/agent-runtime/src/util/run-replay-driver.ts
- packages/agent-runtime/src/supervision/process-supervisor.ts
- packages/agent-runtime/src/supervision/supervised-spawn.ts
- packages/agent-runtime/src/supervision/child-entry.ts
- sdk/src/tools/transaction-intent-log.ts
- sdk/src/tools/change-file.ts
- cli/src/utils/turn-snapshots.ts
- sdk/src/dash/server.ts
- sdk/src/dash/provider.ts
- sdk/src/dash/export.ts
- cli/src/utils/run-journal-path.ts
- cli/src/utils/index-dir-watch.ts

### Domains
- security
- correctness
- state-mutation
- error-handling
- performance
- dependency-hygiene
- test-coverage
- api-contract
