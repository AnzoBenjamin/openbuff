# Audit findings: plan-RB

- Subsystems: .agents
- Features: rb-injected-clock-id, rb-run-journal, rb-mid-step-resume, rb-deterministic-replay, rb-turn-snapshots-undo-timeline, rb-crash-atomic-transactions, rb-dashboard, rb-persisted-workflow-statechart, rb-message-passing-subagents, rb-lanes, rb-resident-daemon, rb-index-service, rb-native-parse-tier, rb-cross-session-scheduler, redb-drop, mergiraf, principle1-broker-adjudication, daemon-ordering, x-tasks, pr-tasks, p2-tasks, p6-tasks
- Files covered: 10
- Snapshot: 49801b44e84d3d8fa583c3ebd9b2855228bf122572b7cdf5f78c77b3389d824d

## [HIGH] state-mutation — .agents/sessions/polyglot-roadmap-v2/SPEC.md:21 — Principle 1 broker/journal ownership: CHANGE→split (TS broker API+policy, Rust daemon commit authority+store)
- **Risk:** Principle 1 says the TS core owns the mutation broker and run journal. cb-sdk-services argues the whole broker and workspace journal should move to the Rust daemon. Both positions are partly right. Today the broker is a cooperative mkdir lock with polling sleep, pid-liveness checks through process.kill(pid,0) (pid reuse is a hazard), whole-file rehashing, and recovery run separately by every process. That cannot be a single-writer authority across CLI, ACP serve, IDE and lanes. Porting all of it, including receipt schemas, cap.v3 validation and tool-facing semantics, would split the contract (principle 5) and leave the loop depending on IPC on every edit.
- **Fix:** Adjudicate with a dated SPEC amendment that separates the broker API from the commit authority. - Stays TS: the conditionalCommit/Delete/Move API, cap.v3 checks, receipt schemaVersion 1, and the policy. Principle 1 holds for the contract. - Moves to the D1 daemon: the commit primitive and the durable log. That means dirfd-anchored staged write, renameat2(RENAME_NOREPLACE)/renamex_np, dir fsync, OS locks (fd-lock/fs4), and the receipt log plus the WorkspaceStateV1 advance in one rusqlite transaction. - Degraded tier: the current TS mkdir-lock path, reported via X-4. - NOW, in TS: move local-harness-store/receipts onto bun:sqlite WAL with BEGIN IMMEDIATE and revision CAS. This removes the pid heuristics and Atomics.wait spins. - NEXT: the daemon is the only writer, so the sandbox can deny workspace writes to everyone else (kernel-enforced), and index invalidation comes straight from receipts.
- **Evidence:** SPEC.md:21 principle 1. cb-sdk-services workspace-mutation-broker.ts:160-165 (cooperative), :570-648 (mkdir lock + poll + process.kill), workspace-journal.ts:61-99 (separate RMW). Cost: interim SQLite M; daemon commit port M-H (about 1k lines of recovery semantics; golden vectors on receipts keep TS/Rust cross-checkable). Confidence: medium-high. Web claims unverified in this shard: renameat2 availability, macOS renamex_np, fs4 Windows semantics.

## [HIGH] performance — .agents/sessions/polyglot-roadmap-v2/SPEC.md:167 — D1 resident daemon ordering: REORDER→minimal openbuffd right after the first X-3b crate, before P3-T1/P1-T3
- **Risk:** Many shards want the daemon: journal and leases (cb-rt-util), broker, harness store, sidecar supervision and memory-v2 (cb-sdk-services, cb-cli-services), and walker/watch/parse/index (cb-code-intel). D42 (LSP) needs it too. Scheduling it at P6-T5 means P2, P3 and P5 each build throwaway TS interim mechanisms, such as the P2-T9 watcher, TS leases and a TS sidecar supervisor, and then migrate them. D14 also forbids a Rust store before X-3b, and X-3b's first crate is gated on P5-T1.
- **Fix:** Split P6-T5 into: - D1-min (new phase, right after the first X-3b crate lands): process lifecycle, a peer-cred and token authenticated unix socket, a version handshake, a rusqlite WAL store reusing the P2-T2/P6-T6a schemas, the lease authority with fencing tokens (globset overlap), and hosting of the notify watcher and walker. - D1-full (P6): index/tantivy, parse, scheduler, jobd absorption. Keep every TS API as a client with the in-process path as a degraded tier. Allow X-3b's first crate to be the daemon/index-walker if P5-T1 slips; X-3b already allows 'or P4 if a native need appears earlier'. NOW: kills the P2-T9 throwaway and cross-process lease blindness, and gives attach/detach (P1-T3) and D42 a host. LATER: one index, broker and memory per repo for all lanes.
- **Evidence:** SPEC.md:167 D1, :187 D14; PLAN.md:138 P6-T5, :27 X-3b. cb-rt-util workspace-path-leases.ts:14 (process-local Map), cb-code-intel index-manager.ts HIGH, cb-sdk-services sidecar-supervisor placement. Cost: D1-min M (3-4 wk: tokio, interprocess/tokio UnixListener, rusqlite, globset, cargo-dist artifacts); saves an estimated 3+ interim TS subsystems. Confidence: medium-high.

## [MEDIUM] performance — .agents/sessions/polyglot-roadmap-v2/PLAN.md:143 — P6-T6 store (redb vs SQLite): DROP redb→rusqlite only
- **Risk:** D14 and P6-T6 leave 'redb/rusqlite' open. redb is a pure-Rust KV store with no SQL. The journal (P2-T2), P6-T6a index store, memory-v2, harness store, leases and receipts are all SQLite schemas with SQL queries. A second engine means two durability models, two backup and inspect stories, and it blocks lifting schemas unchanged from bun:sqlite to rusqlite.
- **Fix:** Decide on rusqlite (bundled, WAL, FTS5) as the only daemon store. Design the P6-T6a/P2-T2 bun:sqlite schemas to be lifted to rusqlite unchanged. Use tantivy only for BM25/fuzzy segments. NOW: one schema family and inspectability with the sqlite3 CLI and the P2-T7 dash. LATER: a single transaction across receipt, journal and index rows.
- **Evidence:** PLAN.md:143 'transactional redb/SQLite store'; SPEC.md:187 D14 'redb/rusqlite'. cb-rt-util run-journal finding ('redb would lose SQL queries used here'); cb-sdk-services local-harness-store CONSUME SQLite. Cost: none (it is a decision). Confidence: high.

## [LOW] correctness — .agents/sessions/polyglot-roadmap-v2/SPEC.md:169 — D3 mergiraf: KEEP (external user-installed git merge driver)
- **Risk:** This is the right call. mergiraf is GPL-3.0-only and its Rust API is explicitly unstable. PLAN P6-T4 calls it a 'Rust CLI sidecar', which suggests it gets built or supervised; it should do neither.
- **Fix:** Keep D3. Invoke it per merge through a lane-local git config merge.<driver>.driver, detect it through X-4 ('merge: mergiraf|diff3'), and don't route it through X-5 supervision because it runs once per invocation. NOW: syntax-aware land_lane with no license exposure. LATER: nothing.
- **Evidence:** SPEC.md:169 D3; PLAN.md:137. License and API claims come from D3 and were not re-verified on the web here. Cost: S. Confidence: high.

## [MEDIUM] correctness — .agents/sessions/polyglot-roadmap-v2/SPEC.md:74 — R-B injected clock/id: KEEP TS; close remaining determinism leaks
- **Risk:** TS injection through AgentRuntimeDeps is the right mechanism, since there is no language question here. cb-rt-loop found leaks that are still open: xml-${crypto.randomUUID()} in tool-stream-parser (TODO(P2-T1)), tool-executor generateCompactId, spawn-agent-utils createAgentState ids, and sentAt Date.now. The determinism guard baseline-suppresses about 20 files and does not match generateCompactId.
- **Fix:** Thread idGen/clock through tool-stream-parser, generateCompactId callers, createAgentState and sentAt. Extend guard patterns to generateCompactId/Math.random and shrink the baseline to zero. NOW: toolResultFor matching works for XML-parsed calls and children. LATER: P2-T3 byte-identical replay.
- **Evidence:** SPEC.md:74; PLAN.md:87. cb-rt-loop tool-stream-parser finding (MEDIUM). Cost: S (days). Confidence: high.

## [MEDIUM] state-mutation — .agents/sessions/polyglot-roadmap-v2/SPEC.md:75 — R-B run journal: KEEP bun:sqlite now; CHANGE→rusqlite host in D1-min later
- **Risk:** Keeping the same SQLite schema is best. The current weaknesses are that seq is minted with MAX(seq)+1 followed by INSERT (two statements, no transaction), synchronous=NORMAL is used even for the tool_call marker that gates side effects, and the journal's lifetime equals the owning CLI process.
- **Fix:** NOW: mint seq with a single INSERT…SELECT COALESCE(MAX(seq),-1)+1 inside BEGIN IMMEDIATE, and use synchronous=FULL (or a checkpoint) for tool_call appends. NEXT: the daemon hosts the same schema through rusqlite and exposes append/events/toolResultFor over RPC, while the TS JournalWriter/Reader interfaces and the pure classifiers stay. This unlocks multi-client resume and resume after the client dies.
- **Evidence:** SPEC.md:75; PLAN.md:88; P2-T2-DESIGN §2 and §8. cb-rt-util run-journal.ts:115-147. Cost: S now, M in the daemon. Confidence: high. SQLite WAL+NORMAL loses the last commits on power loss (general SQLite knowledge, not re-verified).

## [MEDIUM] correctness — .agents/sessions/polyglot-roadmap-v2/SPEC.md:76 — R-B mid-step resume: KEEP TS replay (D35); build the replay driver
- **Risk:** Replaying handleSteps by re-driving it with journaled tool_results is the correct mechanism. Heap snapshots are rejected by D35, and generators can't be serialized. The resume report exists but nothing acts on it yet. The in-flight tool is at-least-once.
- **Fix:** Implement the driver: re-instantiate the generator, feed it tool_results from toolResultFor, and execute the missing call live. Pair the in-flight window with P2-T5 intent records for exactly-once side-effecting tools. NOW: kill-9 resume that users can see. LATER: daemon-hosted runs resume after the client dies.
- **Evidence:** SPEC.md:76; PLAN.md:88 (the REMAINING note); P2-T2-DESIGN §4b-4c. cb-rt-loop handleSteps finding. Cost: M. Confidence: high.

## [LOW] correctness — .agents/sessions/polyglot-roadmap-v2/SPEC.md:77 — R-B deterministic replay: KEEP TS
- **Risk:** Replay and fork are loop-level concerns that depend on the AI SDK and zod contracts. Porting them buys nothing. The real blocker is the set of determinism leaks listed under the injected clock/id finding.
- **Fix:** Keep P2-T3 in TS over the journal reader. Export runs as eval fixtures in the same JSON the journal stores. NOW: fork-from-step. LATER: eval fixtures feed P8.
- **Evidence:** SPEC.md:77; PLAN.md:89. cb-rt-loop durable-journal finding. Cost: M. Confidence: high.

## [LOW] state-mutation — .agents/sessions/polyglot-roadmap-v2/SPEC.md:78 — R-B turn snapshots/undo/timeline: KEEP TS + git CLI plumbing
- **Risk:** git plumbing with a private GIT_INDEX_FILE is the best tool: it respects user config and is correct. gix adds nothing at per-turn frequency. Undo cannot cover untracked-ignored files or side effects outside the tree until P5/P6 overlay.
- **Fix:** Keep it, and report undo coverage as a tier (D33): 'tracked-tree only'. LATER: lanes COW (P6-T2) gives full-workspace undo.
- **Evidence:** SPEC.md:78; PLAN.md:90. cb-cli-services git.ts ('KEEP git CLI'). Cost: M. Confidence: high.

## [MEDIUM] state-mutation — .agents/sessions/polyglot-roadmap-v2/SPEC.md:79 — R-B crash-atomic transactions: CHANGE→intent log in the same SQLite store; commit primitive to daemon
- **Risk:** A separate intent-log file next to per-receipt JSON files repeats the split-authority problem, where a receipt commits but the journal advance fails.
- **Fix:** Write the transaction intent, receipts and WorkspaceStateV1 in one SQLite transaction (bun:sqlite now, rusqlite in the daemon). Do the file-level commit through renameat2/renamex_np in the daemon, with the TS rename+fsync path as the degraded tier. NOW: atomic multi-file edits and exactly-once for resume. LATER: kernel-enforced single writer.
- **Evidence:** SPEC.md:79; PLAN.md:91. cb-sdk-services workspace-journal finding. Cost: M. Confidence: medium-high.

## [LOW] correctness — .agents/sessions/polyglot-roadmap-v2/SPEC.md:80 — R-B dashboard: KEEP TS/React
- **Risk:** There is no language question. The UI reuses the React components.
- **Fix:** Read the journal and receipts through a read-only SQLite handle, and serve from the ACP serve socket (later the daemon) with token auth. It needs auth because it is localhost network-exposed.
- **Evidence:** SPEC.md:80; PLAN.md:93. Cost: M. Confidence: high.

## [MEDIUM] state-mutation — .agents/sessions/polyglot-roadmap-v2/SPEC.md:81 — R-B persisted workflow statechart: KEEP TS; CONSUME XState v5 (host-side interpreter)
- **Risk:** base2's 12k-line generator encodes the gate lifecycle implicitly (cb-agents). base2 handleSteps is serialized with new Function, so it cannot import XState. The interpreter has to live host-side and be reached through the orchestrationControlPlane injection.
- **Fix:** Put the machine config in data (XState v5 or an equivalent JSON transition table) with typed TS guards and actions. The runtime interprets it and journals the events and snapshots. NOW: visualizable, exhaustively testable gate, and replay by re-feeding events. LATER: gate-policy variants and a dash visualization.
- **Evidence:** SPEC.md:81; PLAN.md:92. cb-agents base2.ts:243 (MEDIUM); cb-rt-loop workflow-engine. Cost: L (incremental per sub-loop). Confidence: medium. XState snapshot persistence not web-verified.

## [HIGH] correctness — .agents/sessions/polyglot-roadmap-v2/SPEC.md:82 — R-B message-passing subagents: CHANGE→OS process per subagent, TS supervisor (D36)
- **Risk:** Subagents run as promises in the parent's event loop, so one OOM or sync hang kills the session. D36 already chose processes, but the PLAN text still says Bun Workers.
- **Fix:** Use a Bun.spawn child running the same TS runtime, with AgentState and handoff over IPC/stdio, and the parent applying receipts. LATER: move supervision (cgroups, Job Objects) to the daemon/jobd. Elixir was rejected because it would duplicate contracts.
- **Evidence:** SPEC.md:82, :230 D36. cb-rt-loop spawn-agents HIGH. Cost: M-H (4-8 wk; the callback deps become RPC). Confidence: medium.

## [MEDIUM] state-mutation — .agents/sessions/polyglot-roadmap-v2/SPEC.md:83 — R-B lanes: KEEP split (TS laneId/orchestration, Rust COW service)
- **Risk:** The split is right. Worktree creation through gix is less mature than git CLI (unverified).
- **Fix:** See P6-T1 through P6-T4. The Rust lanes crate does reflink/clonefile/overlayfs and gix in-memory trees; worktree add and merge-tree go through the git CLI. It is hosted in the daemon.
- **Evidence:** SPEC.md:83; PLAN.md:134-137. Cost: L. Confidence: medium.

## [HIGH] performance — .agents/sessions/polyglot-roadmap-v2/SPEC.md:84 — R-B resident daemon: KEEP Rust (D1) + REORDER earlier
- **Risk:** Rust is right: it shares crates with the shim and index, ships as one static binary, and avoids paying the boundary twice (PC-5). The only problem is timing.
- **Fix:** See the D1 ordering finding. Libraries: tokio, rusqlite, globset, notify, ignore, tantivy, gix, and keyring (single token refresher). Distribute with cargo-dist.
- **Evidence:** SPEC.md:84, :167. Evidence from all cb-* shards. Cost: L total. Confidence: high.

## [HIGH] performance — .agents/sessions/polyglot-roadmap-v2/SPEC.md:85 — R-B index service: KEEP Rust; REORDER walker+watcher ahead of the full daemon
- **Risk:** cb-code-intel rates walker, watch, parse and index Rust HIGH: the walker is serial awaits, the Linux watcher is disabled, and every process holds a full index copy. I agree. Scoring weights stay in TS.
- **Fix:** Order: 1. A walker+hash crate (ignore WalkParallel, sha256 kept for chunk-id compatibility). 2. A notify-debouncer-full watcher in D1-min. 3. The P6-T6a store lifted to rusqlite. 4. tantivy. 5. The parse tier. TS keeps final ranking and blending. NOW: live index on Linux. LATER: a shared index across lanes, cross-repo search, and TIA.
- **Evidence:** SPEC.md:85; PLAN.md:139-145. cb-code-intel file-walker.ts:369, index-workspace-watcher.ts:26, index-manager.ts:564. Cost: L. Confidence: high.

## [MEDIUM] performance — .agents/sessions/polyglot-roadmap-v2/SPEC.md:86 — R-B native parse tier: KEEP Rust tree-sitter+rayon; CONSUME oxc-parser for JS/TS
- **Risk:** The WASM parse runs single-threaded, and there is grammar-shipping and repair debt. Rust is best in class here.
- **Fix:** See P6-T7. It can ship as a standalone stdio sidecar supervised by X-5 before the daemon.
- **Evidence:** SPEC.md:86. cb-code-intel languages.ts:249 HIGH; D46. Cost: M-L. Confidence: high.

## [LOW] performance — .agents/sessions/polyglot-roadmap-v2/SPEC.md:87 — R-B cross-session scheduler: KEEP Rust daemon as permit authority, TS client does calls/failover
- **Risk:** Provider calls stay in the TS AI SDK, so the daemon should only grant permits and track the budget.
- **Fix:** See P6-T8.
- **Evidence:** SPEC.md:87; PLAN.md:148; IL-8. Cost: M. Confidence: medium-high.

## [LOW] correctness — .agents/sessions/polyglot-roadmap-v2/PLAN.md:23 — X-1 contract freeze: KEEP TS; add JSON Schema→Rust codegen
- **Risk:** Zod-sourced JSON Schema is the right ABI. The Rust daemon will need types, and hand-written structs would drift from it.
- **Fix:** Generate Rust types with typify/schemars from the published artifacts and golden-vector them in cargo test. NOW: nothing new. LATER: broker, journal and receipt parity across TS and Rust.
- **Evidence:** PLAN.md:23. cb-sdk-services extensions.ts finding. Cost: S. Confidence: high.

## [LOW] performance — .agents/sessions/polyglot-roadmap-v2/PLAN.md:24 — X-2 perf baselines: KEEP TS
- **Risk:** The index-stage attribution rows are still pending, and they gate the Rust index work.
- **Fix:** Land the walk/parse/persist/query-p99 rows with P6-T6a, before any Rust index crate.
- **Evidence:** PLAN.md:24-25. Cost: S. Confidence: high.

## [LOW] performance — .agents/sessions/polyglot-roadmap-v2/PLAN.md:25 — X-2a TS index fixes: KEEP (done)
- **Risk:** None.
- **Fix:** No action.
- **Evidence:** PLAN.md:25. Cost: none. Confidence: high.

## [LOW] correctness — .agents/sessions/polyglot-roadmap-v2/PLAN.md:26 — X-3a scaffold removal: KEEP (done)
- **Risk:** None.
- **Fix:** No action.
- **Evidence:** PLAN.md:26. Cost: none. Confidence: high.

## [MEDIUM] correctness — .agents/sessions/polyglot-roadmap-v2/PLAN.md:27 — X-3b Rust workspace: KEEP; CHANGE first-crate gate to 'first of shim|daemon-min|index-walker'
- **Risk:** Gating the 5-target CI matrix on P5-T1 alone delays every daemon consumer.
- **Fix:** Let the first real crate be whichever of these lands first. Keep the charter unchanged: no dual mirror, native path in CI from day one, pinned toolchain.
- **Evidence:** PLAN.md:27; X-3B-DESIGN-NOTE §1-2. Cost: none. Confidence: high.

## [LOW] correctness — .agents/sessions/polyglot-roadmap-v2/PLAN.md:28 — X-4 capability registry: KEEP TS
- **Risk:** The daemon needs to advertise its own tiers (store, watcher, broker authority).
- **Fix:** Merge the daemon handshake capabilities into CapabilitiesMapV1.
- **Evidence:** PLAN.md:28. Cost: S. Confidence: high.

## [LOW] state-mutation — .agents/sessions/polyglot-roadmap-v2/PLAN.md:29 — X-5 sidecar supervisor: KEEP TS now; supervision moves into D1 later
- **Risk:** Sidecars die with the CLI and can't be shared (cb-sdk-services).
- **Fix:** Later, the daemon supervises through tokio::process with process groups and cgroups/Job Objects, and TS keeps the client.
- **Evidence:** PLAN.md:29. cb-sdk-services sidecar-supervisor.ts:139. Cost: M later. Confidence: medium.

## [LOW] correctness — .agents/sessions/polyglot-roadmap-v2/PLAN.md:30 — X-6 citations: KEEP (done)
- **Risk:** None.
- **Fix:** No action.
- **Evidence:** PLAN.md:30. Cost: none. Confidence: high.

## [LOW] correctness — .agents/sessions/polyglot-roadmap-v2/PLAN.md:55 — PR-T1 handoff envelope: KEEP TS
- **Risk:** This is a receipt contract tied to zod.
- **Fix:** Carry the envelope unchanged over the P2-T8 process IPC.
- **Evidence:** PLAN.md:55. cb-rt-loop spawn receipts KEEP. Cost: none. Confidence: high.

## [MEDIUM] state-mutation — .agents/sessions/polyglot-roadmap-v2/PLAN.md:56 — PR-T2 out-of-band store: CHANGE→content-addressed blobs in the journal store, not os.tmpdir
- **Risk:** Artifacts under os.tmpdir are lost on reboot or tmp cleaning, so the pointers dangle across resume, which contradicts D20's 'run journal' target.
- **Fix:** Store the blobs keyed by sha256 in the run-journal DB (or a project-scoped CAS directory referenced from journal events), with the same retention rules as the journal. LATER: the daemon serves them to dash and IDEs.
- **Evidence:** PLAN.md:56 (os.tmpdir()/openbuff-spawn-output); SPEC D20. Cost: S. Confidence: high.

## [LOW] correctness — .agents/sessions/polyglot-roadmap-v2/PLAN.md:57 — PR-T3 arg normalization: KEEP TS
- **Risk:** None.
- **Fix:** No action.
- **Evidence:** PLAN.md:57. Cost: none. Confidence: high.

## [LOW] correctness — .agents/sessions/polyglot-roadmap-v2/PLAN.md:58 — PR-T4 plain-text edit blocks: KEEP TS
- **Risk:** The live A/B is blocked on provider keys.
- **Fix:** Run the A/B through the P8-T0 eval path.
- **Evidence:** PLAN.md:58. Cost: none. Confidence: high.

## [LOW] correctness — .agents/sessions/polyglot-roadmap-v2/PLAN.md:59 — PR-T5 content-hash attestation: KEEP TS
- **Risk:** The hash encoding must match the Rust daemon's later.
- **Fix:** Pin sha256-raw-bytes in X-1 vectors (D30).
- **Evidence:** PLAN.md:59. Cost: none. Confidence: high.

## [LOW] correctness — .agents/sessions/polyglot-roadmap-v2/PLAN.md:60 — PR-T6 fail-loud outputs: KEEP TS
- **Risk:** None.
- **Fix:** No action.
- **Evidence:** PLAN.md:60. Cost: none. Confidence: high.

## [MEDIUM] correctness — .agents/sessions/polyglot-roadmap-v2/PLAN.md:87 — P2-T1 Clock/IdGen: KEEP TS; status overclaims completion
- **Risk:** The entry says no TODO(P2-T1b) markers remain, but cb-rt-loop still finds randomUUID and generateCompactId sites, and the guard uses baseline suppression.
- **Fix:** Treat the guard baseline reaching zero as the DONE gate. See the R-B clock finding.
- **Evidence:** PLAN.md:87. cb-rt-loop tool-stream-parser.ts. Cost: S. Confidence: high.

## [MEDIUM] state-mutation — .agents/sessions/polyglot-roadmap-v2/PLAN.md:88 — P2-T2 run journal: KEEP bun:sqlite; fix seq transaction and durability
- **Risk:** See the R-B journal finding.
- **Fix:** Use BEGIN IMMEDIATE for seq and FULL sync on tool_call, and design the schema to be lifted to rusqlite.
- **Evidence:** PLAN.md:88. cb-rt-util run-journal.ts:131-147. Cost: S. Confidence: high.

## [LOW] correctness — .agents/sessions/polyglot-roadmap-v2/PLAN.md:89 — P2-T3 replay/fork: KEEP TS
- **Risk:** It depends on the P2-T1 leaks being closed.
- **Fix:** Close them first.
- **Evidence:** PLAN.md:89. Cost: M. Confidence: high.

## [LOW] state-mutation — .agents/sessions/polyglot-roadmap-v2/PLAN.md:90 — P2-T4 turn snapshots: KEEP TS git plumbing
- **Risk:** See the R-B snapshots finding.
- **Fix:** Report undo coverage as a tier.
- **Evidence:** PLAN.md:90. Cost: M. Confidence: high.

## [MEDIUM] state-mutation — .agents/sessions/polyglot-roadmap-v2/PLAN.md:91 — P2-T5 crash-atomic transactions: CHANGE→one SQLite transaction; renameat2 via daemon, not X-3 napi
- **Risk:** The plan says 'renameat2 later via X-3', which suggests a napi kernel, and that duplicates the daemon commit authority.
- **Fix:** See the R-B crash-atomic finding.
- **Evidence:** PLAN.md:91. Cost: M. Confidence: medium-high.

## [MEDIUM] state-mutation — .agents/sessions/polyglot-roadmap-v2/PLAN.md:92 — P2-T6 persisted statechart: KEEP TS; CONSUME XState v5 host-side
- **Risk:** See the R-B statechart finding.
- **Fix:** Put the machine config in data and the interpreter in the runtime, and journal the events.
- **Evidence:** PLAN.md:92. cb-agents base2.ts:243. Cost: L. Confidence: medium.

## [LOW] correctness — .agents/sessions/polyglot-roadmap-v2/PLAN.md:93 — P2-T7 openbuff dash: KEEP TS/React
- **Risk:** It is network-exposed on localhost.
- **Fix:** Token auth, a read-only DB handle, and static export.
- **Evidence:** PLAN.md:93. Cost: M. Confidence: high.

## [HIGH] correctness — .agents/sessions/polyglot-roadmap-v2/PLAN.md:94 — P2-T8 subagents: CHANGE→process supervision (stale 'Bun Workers' text contradicts D36)
- **Risk:** Workers share process fate on OOM (cb-rt-loop), and the PLAN text was never amended after D36.
- **Fix:** Rewrite the task per D36: Bun.spawn plus IPC and a TS supervisor. Gate: kill-9 a child and have the parent keep running.
- **Evidence:** PLAN.md:94 vs SPEC.md:230. Cost: M-H. Confidence: high.

## [MEDIUM] performance — .agents/sessions/polyglot-roadmap-v2/PLAN.md:95 — P2-T9 interim watcher: CHANGE→documented age-sweep tier only; pull Rust notify into D1-min
- **Risk:** Worker-thread per-directory watchers are throwaway code, which the task itself warns against.
- **Fix:** Ship only the honest age-sweep tier (X-4) plus optional watchman consumption. The notify watcher arrives with D1-min.
- **Evidence:** PLAN.md:95. cb-code-intel index-workspace-watcher.ts:26 HIGH. Cost: S. Confidence: medium-high.

## [LOW] correctness — .agents/sessions/polyglot-roadmap-v2/PLAN.md:134 — P6-T1 laneId: KEEP TS
- **Risk:** It is a contract addition.
- **Fix:** Use a v2 schema with golden vectors, and mirror it into the Rust codegen.
- **Evidence:** PLAN.md:134. Cost: S. Confidence: high.

## [MEDIUM] state-mutation — .agents/sessions/polyglot-roadmap-v2/PLAN.md:135 — P6-T2 lanes service: KEEP Rust in daemon; CONSUME git CLI for worktree ops
- **Risk:** gix worktree and checkout coverage is incomplete (unverified).
- **Fix:** Use reflink-copy/clonefile/overlayfs plus gix in-memory trees in Rust, and shell out to git worktree add. Host it in the daemon rather than as a separate sidecar.
- **Evidence:** PLAN.md:135. Cost: L. Confidence: medium.

## [LOW] correctness — .agents/sessions/polyglot-roadmap-v2/PLAN.md:136 — P6-T3 best-of-N: KEEP TS + git merge-tree --write-tree
- **Risk:** This requires git 2.38 or later (unverified).
- **Fix:** Probe the git version and report it through X-4.
- **Evidence:** PLAN.md:136. Cost: M. Confidence: high.

## [LOW] correctness — .agents/sessions/polyglot-roadmap-v2/PLAN.md:137 — P6-T4 merge strategy: KEEP (mergiraf external driver); reword 'sidecar'
- **Risk:** See the D3 finding.
- **Fix:** Invoke it as a merge driver, with diff3 as the fallback.
- **Evidence:** PLAN.md:137. Cost: S. Confidence: high.

## [HIGH] performance — .agents/sessions/polyglot-roadmap-v2/PLAN.md:138 — P6-T5 openbuffd: REORDER (split into D1-min early + D1-full)
- **Risk:** See the D1 ordering finding.
- **Fix:** D1-min: the store, leases, watcher and broker commit authority. D1-full: index, jobd and scheduler.
- **Evidence:** PLAN.md:138. Cost: L. Confidence: medium-high.

## [HIGH] performance — .agents/sessions/polyglot-roadmap-v2/PLAN.md:139 — P6-T6 index service: KEEP Rust (notify, grep crates, tantivy); store=rusqlite
- **Risk:** See the index-service and redb findings.
- **Fix:** Stage it: walker, then watcher, then store, then tantivy. Keep CODEBUFF_RG_PATH honored.
- **Evidence:** PLAN.md:139-145. cb-code-intel HIGH. Cost: L. Confidence: high.

## [LOW] state-mutation — .agents/sessions/polyglot-roadmap-v2/PLAN.md:146 — P6-T6a TS index store: KEEP bun:sqlite
- **Risk:** The schema has to be liftable to rusqlite.
- **Fix:** Keep the schema dialect-neutral, and pin the snapshotId and stableChunkId vectors.
- **Evidence:** PLAN.md:146. cb-code-intel index-store.ts:154. Cost: M. Confidence: high.

## [MEDIUM] performance — .agents/sessions/polyglot-roadmap-v2/PLAN.md:147 — P6-T7 native parse tier: KEEP Rust; REORDER as an X-5 sidecar before the daemon
- **Risk:** Gating on P6-T5 delays it for no reason, since batch parsing is stateless.
- **Fix:** Use tree-sitter plus statically linked grammars, rayon and tree-sitter-tags, with oxc-parser for JS/TS (D46). Keep the WASM fallback. LATER: retained trees for incremental reparse in the daemon.
- **Evidence:** PLAN.md:147. cb-code-intel languages.ts:249, structure.ts:794. Cost: M-L. Confidence: high.

## [LOW] performance — .agents/sessions/polyglot-roadmap-v2/PLAN.md:148 — P6-T8 provider scheduler: KEEP Rust permit authority + TS failover
- **Risk:** If failover moved into the daemon, it would duplicate the AI SDK.
- **Fix:** The daemon runs token buckets and the spend ledger in rusqlite. TS keeps EWMA and failover (IL-8).
- **Evidence:** PLAN.md:148, :268. Cost: M. Confidence: medium-high.

## [LOW] performance — .agents/sessions/polyglot-roadmap-v2/PLAN.md:149 — P6-T9 range reads/readdir: KEEP evidence-gated (likely DROP)
- **Risk:** The ignore walker and grep crates in the daemon probably cover this.
- **Fix:** Close it unless the X-2 rows show a need.
- **Evidence:** PLAN.md:149. Cost: none. Confidence: medium.

## Coverage receipt

### Subsystems
- .agents

### Features
- rb-injected-clock-id
- rb-run-journal
- rb-mid-step-resume
- rb-deterministic-replay
- rb-turn-snapshots-undo-timeline
- rb-crash-atomic-transactions
- rb-dashboard
- rb-persisted-workflow-statechart
- rb-message-passing-subagents
- rb-lanes
- rb-resident-daemon
- rb-index-service
- rb-native-parse-tier
- rb-cross-session-scheduler
- redb-drop
- mergiraf
- principle1-broker-adjudication
- daemon-ordering
- x-tasks
- pr-tasks
- p2-tasks
- p6-tasks

### Files
- .agents/sessions/polyglot-roadmap-v2/SPEC.md
- .agents/sessions/polyglot-roadmap-v2/PLAN.md
- .agents/sessions/polyglot-roadmap-v2/P2-T2-DESIGN.md
- .agents/sessions/polyglot-roadmap-v2/X-3B-DESIGN-NOTE.md
- .agents/sessions/language-fit-audit-2026-09-28/findings/cb-rt-util.md
- .agents/sessions/language-fit-audit-2026-09-28/findings/cb-rt-loop.md
- .agents/sessions/language-fit-audit-2026-09-28/findings/cb-sdk-services.md
- .agents/sessions/language-fit-audit-2026-09-28/findings/cb-code-intel.md
- .agents/sessions/language-fit-audit-2026-09-28/findings/cb-cli-services.md
- .agents/sessions/language-fit-audit-2026-09-28/findings/cb-agents.md

### Domains
- state-mutation
- performance
- correctness
