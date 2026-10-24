# Audit findings: cb-sdk-services

- Subsystems: sdk
- Features: acp-agent-server, acp-extension-contracts, acp-session-journal, workspace-mutation-broker, workspace-journal, local-harness-store, sidecar-supervisor, task-memory-store-v1, memory-v2-coordinator, repository-identity, harness-enforcement-policy, harness-intelligence-leases-discovery, audit-intelligence-inventory, credentials-store, custom-tool-definition, validate-agents, load-agents, load-mcp-config, load-skills
- Files covered: 20
- Snapshot: 49801b44e84d3d8fa583c3ebd9b2855228bf122572b7cdf5f78c77b3389d824d

## [LOW] api-contract — sdk/src/services/acp/acp-agent.ts:156 — ACP agent server (createAcpAgent/serveAcpOverStdio): KEEP (TS)
- **Risk:** Protocol surface is thin glue over @agentclientprotocol/sdk; the prompt handler that it wraps is the TS core run. Moving it would put an IPC hop between the protocol and the agent loop and gain nothing. One real risk: serveAcpOverStdio uses AgentSideConnection, which the file itself says is @deprecated in favor of the agent() builder (line 371).
- **Fix:** KEEP in TS, using the official ACP TS SDK. Now: migrate to the non-deprecated agent() builder before it is removed. Later: if the Rust daemon (D1) needs to front editors directly, the official Rust ACP crate (agent-client-protocol) exists. Treat that as a separate daemon front door, not a port of this file.
- **Evidence:** acp-agent.ts:1-30 imports the SDK; :156-319 is a session map plus AbortController per turn; :357-379 is the ndJson stdio bridge; :371 has the deprecation note. Cost of moving: high (it would split the protocol from the TS run loop). Confidence: high. Verify on the web: whether the Rust/Python/Kotlin ACP SDKs are at parity with TS on extMethod and reverse requests, and when AgentSideConnection is scheduled for removal.

## [LOW] api-contract — sdk/src/services/acp/extensions.ts:10 — ACP extension contracts (Zod to JSON Schema): KEEP (TS)
- **Risk:** Zod is the single source of truth, and it already compiles to JSON Schema (compileAcpExtensionJsonSchemas, line 79) for the X-1 golden-vector pipeline. That is the right language-neutral handoff for polyglot consumers.
- **Fix:** KEEP. Now: publish the compiled JSON Schemas as artifacts. Next: generate Rust types from them with typify/schemars and Python types with datamodel-code-generator, so the Rust daemon and sidecars consume the same contract without hand-written structs.
- **Evidence:** extensions.ts:10-14 lists the methods; :54-70 holds the schemas; :79-89 compiles the JSON Schema. Cost: none. Confidence: high.

## [MEDIUM] state-mutation — sdk/src/services/acp/session-data.ts:343 — ACP session receipt/gate-state journal: HYBRID (TS projection; durability via Rust daemon journal later)
- **Risk:** Journal IO is fire-and-forget and best-effort: failures are swallowed (line 343-345), appendFile/writeFile run without fsync, and the bounded rewrite truncates the same file in place with writeFile (line 387) instead of temp+rename. A crash mid-rewrite loses session receipt history. Ordering is only serialized per instance (journalQueue), so two processes serving the same session can interleave writes. This is a durability-design gap, not a language gap.
- **Fix:** Keep the in-memory projection and redaction in TS (they are pure data shaping tied to the run loop). Now: switch the rewrite to temp+fsync+rename, reusing the broker's writeJsonDurable pattern. Next: once D1 exists, have the daemon own an append-only per-session log, either SQLite WAL via rusqlite or redb, and have TS subscribe to it. Session restore then survives CLI restarts and supports several frontends at once.
- **Evidence:** session-data.ts:336-345 swallows errors in the serialized queue; :355-364 appendFile has no fsync; :371-389 rewrites the whole file in place with writeFile. Cost to fix in TS: low. Cost to move durability into the daemon: medium. Confidence: high.

## [HIGH] state-mutation — sdk/src/services/workspace-mutation-broker.ts:166 — Workspace mutation broker (CAS commit/delete/move + receipts + recovery): MOVE→Rust (resident daemon), TS client stays
- **Risk:** The roadmap keeps this broker in TS, which I challenge. The broker is a cooperative lock plus a durable write-ahead receipt protocol, so it is exactly the single-writer authority a resident daemon should own. Today exclusion depends on mkdir lock dirs, polling sleep (line 602), and pid liveness via process.kill(pid,0) (line 643). That approach has pid-reuse hazards, holds no kernel locks, rereads whole files to hash them (readHash, line 902), and every participating process runs recovery on its own. Each CLI, ACP session, and sidecar instance competes through the filesystem.
- **Fix:** MOVE the authority to Rust inside the D1 daemon, sharing crates with sandbox/index. Libraries: rustix/nix for openat, renameat2(RENAME_NOREPLACE), linkat, and fsync on dirs; fs4 or fd-lock for OS advisory locks (flock/LockFileEx); blake3 or sha2 for streaming hashes; rusqlite in WAL mode or redb for the receipt log in place of per-receipt JSON files. Keep a thin TS client exposing the same conditionalCommit/Delete/Move API so the tool layer doesn't change. Unlocks now: one serialized authority with no polling or pid heuristics, dirfd-relative ops that close the symlink TOCTOU gap in resolvePath, and cheaper hashing. Unlocks next: the sandbox can enforce that only the daemon writes to the workspace (kernel-enforced rather than cooperative, which the doc comment at 160-165 admits it lacks), the index crate gets invalidation straight from committed receipts, and several frontends can share one broker.
- **Evidence:** workspace-mutation-broker.ts:160-165 says it is cooperative, not kernel-enforced; :240-340 is conditionalCommit with a staged write, link/rename, dir fsync, and post-commit hash; :570-619 is the mkdir lock plus poll; :621-648 is the stale check via process.kill; :678-761 is receipt recovery; :942-981 are the durable JSON and dir fsync with Windows carve-outs. Cost: medium-high (about 1000 lines of subtle recovery semantics to port, plus IPC and a fallback path when the daemon is absent). Confidence: medium-high. Verify on the web: renameat2 and RENAME_EXCHANGE availability on macOS (renamex_np), and fs4 Windows semantics.

## [MEDIUM] state-mutation — sdk/src/services/workspace-journal.ts:61 — Workspace journal (WorkspaceStateV1 advance): MOVE→Rust daemon alongside the broker (pure reducer stays shared)
- **Risk:** advance() is a read-modify-write of one JSON record under a LocalHarnessStore kind lock. It runs synchronously, blocking the event loop with Atomics.wait spin-locks, and it is fed by broker receipts. Keeping the journal and the broker in separate authorities invites divergence: a receipt can commit while the journal advance fails.
- **Fix:** MOVE to D1 and advance in the same transaction as the broker receipt, a single rusqlite transaction covering both the receipt and the workspace state. Keep advanceWorkspaceState as a pure function defined by golden vectors, so TS and Rust implementations can be cross-checked. Now: receipts and journal state update atomically together. Next: the daemon can push snapshotId changes to the index and sandbox, and TS callers stop spinning on file locks.
- **Evidence:** workspace-journal.ts:61-99 is advance under withKindLock plus put with an expected revision; :42-44 fallbackIdentity digests the path when git fails. Cost: low-medium once the broker has moved. Confidence: medium.

## [MEDIUM] performance — sdk/src/services/local-harness-store.ts:189 — Local harness record store (JSON files + mkdir locks): CONSUME SQLite (bun:sqlite now; rusqlite in daemon later)
- **Risk:** This is a hand-built mini database: one JSON file per record, a directory lock with pid-verified reclaim (line 106-187), a synchronous busy-wait via Atomics.wait (line 232) that blocks the JS thread for up to 5s, and writeJsonAtomic without fsync (line 62-69), so a rename can land before the data is durable. list() reads the whole directory. The many reliability-finding comments show the lock logic has needed repeated patching.
- **Fix:** CONSUME an embedded database instead of maintaining the lock and record code. Now: bun:sqlite in WAL mode with BEGIN IMMEDIATE (the CLI already uses it for memory-v2), and revision CAS becomes UPDATE ... WHERE revision=?. Next: when D1 lands, the same schema moves behind the daemon on rusqlite, and the approval, ownership, lease, knowledge, and journal kinds share one transactional store with the broker. Unlocks: no event-loop blocking, crash-safe durability, indexed listing, and roughly 300 lines of lock code deleted.
- **Evidence:** local-harness-store.ts:45-48 lock constants and the SharedArrayBuffer wait; :62-69 atomic write with no fsync; :106-187 pid-verified reclaim; :189-287 withFilesystemLock busy-wait. Cost: medium (data migration from the JSON tree). Confidence: high.

## [MEDIUM] performance — sdk/src/services/sidecar-supervisor.ts:139 — Sidecar supervisor (spawn, JSON-RPC over stdio, restart/backoff): HYBRID; MOVE supervision→Rust daemon when D1 exists, keep TS client
- **Risk:** Supervising from inside the CLI process means sidecars die with the CLI and can't be shared across sessions, each frontend respawns its own. It also can't use process groups, cgroups/Job Objects, or seccomp. The TS implementation itself is sound: bounded buffers, pending-request limits, stop-vs-crash disambiguation. The limitation is placement.
- **Fix:** Now: KEEP in TS for X-5 (it works, and a Rust daemon doesn't exist yet). Next: move lifecycle to D1 using tokio::process plus tokio-util LinesCodec for framing, command-group or setsid for process-group kill, cgroups-rs or Windows Job Objects for resource limits, and landlock/seccomp from the shared sandbox crate. TS keeps a thin client. Unlocks: sidecars that survive and are shared across CLI and ACP sessions, sandboxed sidecars, and reliable reaping of orphaned children.
- **Evidence:** sidecar-supervisor.ts:139-173 holds state and options; :281-314 spawnChild merges the child env; :220-252 request has a pending limit; outline :502-528 restartLoop, :537-555 killChild. Cost: medium. Confidence: medium. Verify on the web: command-group crate maintenance status.

## [MEDIUM] state-mutation — sdk/src/services/task-memory-store.ts:713 — Task memory V1 store (JSON + exclusive-create lock, evidence hashing/pruning): KEEP-then-RETIRE (superseded by memory-v2 SQLite)
- **Risk:** Same hand-rolled pattern as the harness store: writeRecordAtomically has no fsync (line 674-696), locks are in-process promise chains plus an exclusive-create lock file, and when the lock can't be taken the write is silently skipped (returns undefined). The CLI already defaults to sqlite-v2-opt-in, so V1 is legacy.
- **Fix:** Don't port to another language. Retire it after the v1-migration path (memory-v2/v1-migration.ts) is proven, and keep only the read-only importer in TS. Now: less duplicated durability code. Next: nothing to move.
- **Evidence:** task-memory-store.ts:674-696 atomic write with no fsync; :713-749 in-process plus file lock; :762-786 acquireRecordLock fails closed; cli/src/utils/env.ts:90 defaults to sqlite-v2-opt-in. Cost: low. Confidence: medium-high.

## [LOW] state-mutation — sdk/src/services/memory-v2/coordinator.ts:659 — Memory V2 coordinator/operator (turn prep, capture, classification): KEEP (TS); storage backend HYBRID→rusqlite in daemon later
- **Risk:** The coordinator is policy and data shaping tightly coupled to agent turns and tool results: observation classification, chunk hints, parity. It already talks to storage only through the MemoryRepositoryV2 interface (types.ts:184-226), with bun:sqlite as the backend in cli/. That boundary is correct. The one question is whether the store should be shared across processes.
- **Fix:** KEEP the coordinator in TS. Later, put MemoryRepositoryV2 behind D1 using rusqlite (bundled, WAL), plus sqlite-vec or usearch for concept vectors so the vector store sits with the index crate. The TS repository then becomes an IPC adapter. Unlocks next: one memory DB serving all sessions without SQLITE_BUSY contention, and memory and code index living together for retrieval.
- **Evidence:** coordinator.ts:659-2136 (outline); types.ts:23-37 config and :184-226 repository interface; cli/src/services/memory-v2/bun-sqlite-memory-repository.ts:1 is the bun:sqlite backend. Cost of moving the backend: medium. Confidence: medium. Not read in full: v1-migration.ts, operator-service.ts, event-factory.ts, usage-observer.ts.

## [LOW] performance — sdk/src/services/repository-identity.ts:28 — Repository/workspace identity (git rev-parse): KEEP now; CONSUME gix in Rust daemon later
- **Risk:** Every broker, journal, and store instance spawns two git processes to compute its identity. That cost is small but repeats on each instance.
- **Fix:** KEEP in TS. When D1 exists, compute identity in the daemon with gix (gitoxide) using discover plus common_dir, cache it for the daemon's lifetime, and share it with the index crate.
- **Evidence:** repository-identity.ts:32-35 spawns two git processes; :16-18 uses a sha256 prefix id. Cost: low. Confidence: high.

## [LOW] security — sdk/src/services/harness-enforcement.ts:167 — Harness approval/ownership/policy (classifyTerminalHarnessAction, evaluateHarnessActionPolicy): KEEP (TS) policy; storage follows harness-store CONSUME
- **Risk:** The policy is pure classification and decision code tied to TS tool definitions. Only the approval-consume path (line 70-118) needs atomic single-use semantics, and it inherits the harness store's lock weaknesses.
- **Fix:** KEEP the logic in TS. Make approval consume a single SQL UPDATE ... WHERE consumed=0 once the store is SQLite (and later sits in the daemon). If the sandbox crate needs the same command classification, share it as golden vectors instead of porting.
- **Evidence:** harness-enforcement.ts:42-119 HarnessApprovalService; :147-158 command normalize/hash; :167-293 classifier; :338-379 policy. Cost: low. Confidence: medium (read via outline plus the store internals).

## [MEDIUM] performance — sdk/src/services/harness-intelligence.ts:564 — Harness intelligence (workspace discovery, build/test targets, leases, verified knowledge): HYBRID; leases→daemon, discovery→Rust index crate
- **Risk:** WorkspaceLeaseService implements heartbeat leases on the JSON store with synchronous kind locks. A resident process is the natural lease holder. Discovery walks the tree synchronously (discoverNamedFiles) and calls spawnSync to get tool versions (toolVersion), both of which block the event loop on large monorepos.
- **Fix:** Leases: move to D1, with in-memory state plus rusqlite persistence, where daemon-held liveness replaces wall-clock heartbeat polling. Discovery: consume the ignore crate (ripgrep's walker) in the shared index crate, or call it through the daemon. Keep build/test-target inference and context packets in TS (heuristics tied to manifests). Unlocks: non-blocking discovery, and correct lease expiry when a CLI crashes.
- **Evidence:** harness-intelligence.ts:73-103 discoverNamedFiles; :224-241 toolVersion via spawnSync; :259-264 TTL cache; :564-744 lease service under withKindLock. Cost: medium. Confidence: medium.

## [MEDIUM] performance — sdk/src/services/audit-intelligence.ts:107 — Audit inventory (walk + sha256 inventory hash): MOVE→Rust (shared index crate)
- **Risk:** A synchronous recursive readdirSync walk plus a per-file read-and-hash (capped at 256KB each) blocks the thread and does O(repo) IO on every inspectCodebaseStructure call. The index crate will already walk and hash the same tree, so this duplicates it.
- **Fix:** MOVE to the Rust index crate: ignore::WalkParallel, blake3 or sha2 with rayon, and an incremental snapshot keyed on mtime/inode from the daemon's watcher (notify). Keep feature-completeness heuristics and coverage evaluation in TS. Unlocks now: near-instant snapshotIds. Next: snapshotIds shared with the broker and journal, so audit receipts bind to the same workspace revision.
- **Evidence:** audit-intelligence.ts:107-120 sync walk; :124-133 readCapped; :135-148 hashInventory; :150-253 inspectCodebaseStructure. Cost: medium (the hash definition must stay stable, or the snapshotId must be versioned). Confidence: high.

## [MEDIUM] security — sdk/src/credentials.ts:73 — Credentials store (OAuth tokens + API key in 0600 JSON): HYBRID; CONSUME OS keychain, keep TS refresh logic
- **Risk:** Secrets sit in plaintext JSON protected only by file mode. The code is careful (atomic writes, fsync, backup on the Windows rename fallback), but the storage mechanism is weaker than the OS keychain, and on Windows chmod is a no-op. Refresh single-flight is per process only (a module-level Map), so two CLI processes can race refreshing the same token.
- **Fix:** Store secrets in the OS keychain, with the JSON file as a headless fallback. TS option: @napi-rs/keyring or Bun.secrets. Rust option in the daemon: the keyring crate (macOS Keychain, Windows Credential Manager, Secret Service). Keep the OAuth refresh flow in TS for now. Later, the daemon becomes the single refresher, which removes the cross-process refresh race.
- **Evidence:** credentials.ts:39-55 dir set to 0700; :73-133 atomic 0600 write with the Windows fallback; :329-411 refresh single-flight per config dir, per process. Cost: low-medium. Confidence: medium. Verify on the web: whether Bun.secrets is GA and its platform coverage, and @napi-rs/keyring maintenance.

## [LOW] api-contract — sdk/src/custom-tool.ts:38 — Custom tool definition API: KEEP (TS)
- **Risk:** This is a public SDK type API built on Zod and TS conditional types (the name-collision error at line 52-56). Its value is inherently TS-specific.
- **Fix:** KEEP. Next: export inputSchema as JSON Schema, so custom tools defined in other languages (Python sidecars, MCP) can register through the same contract.
- **Evidence:** custom-tool.ts:9-25 type; :38-77 factory. Cost: none. Confidence: high.

## [LOW] api-contract — sdk/src/validate-agents.ts:62 — Agent definition validation (local Zod / remote API): KEEP (TS)
- **Risk:** Validation is Zod over TS agent definitions that the TS runtime executes. No performance or isolation need justifies a move.
- **Fix:** KEEP. If polyglot agent definitions arrive, publish the definition schema as JSON Schema rather than porting the validator.
- **Evidence:** validate-agents.ts:62-175. Cost: none. Confidence: high.

## [LOW] security — sdk/src/agents/load-agents.ts:314 — Local agent loader (dynamic import of .ts/.js agent modules): KEEP (TS); isolation via sandbox later
- **Risk:** Agents are executable TS/JS modules imported in-process through Bun (line 330), so the loader must stay TS. Trusted agent code runs with full CLI privileges. Opting into project agents means running arbitrary code, and the lexical containment check only guards the path.
- **Fix:** KEEP. Later: run untrusted project agents in a worker or subprocess under the Rust sandbox crate (landlock/seatbelt), rather than rewriting the loader.
- **Evidence:** load-agents.ts:65-91 walk; :93-102 dir precedence; :314-331 containment check plus cache-busted import. Cost: none to keep. Confidence: high.

## [LOW] security — sdk/src/agents/load-mcp-config.ts:54 — MCP config loader (mcp.json merge + origin marking): KEEP (TS)
- **Risk:** Small config parsing plus origin tagging for $VAR trust gating, fed to the TS MCP client. No benefit from moving.
- **Fix:** KEEP. CONSUME consideration: follow the de-facto mcp.json format that Claude Code and Cursor use, and don't extend it with custom fields.
- **Evidence:** load-mcp-config.ts:16-18 schema; :54-64 origin; :79-114 merge. Cost: none. Confidence: high.

## [LOW] api-contract — sdk/src/skills/load-skills.ts:231 — Skills loader (SKILL.md frontmatter via gray-matter): KEEP (TS)
- **Risk:** Synchronous directory reads over a handful of skill dirs, which is negligible. Already consumes gray-matter and follows the Claude-compatible .claude/skills layout.
- **Fix:** KEEP. Minor: includeProjectSkills defaults to true while agents and MCP default project loading off. Skills are not executable, but aligning the trust defaults is worth considering.
- **Evidence:** load-skills.ts:24-40 gray-matter; :168-186 dirs; :231-254 loadSkills with includeProjectSkills=true. Cost: none. Confidence: high.

## Coverage receipt

### Subsystems
- sdk

### Features
- acp-agent-server
- acp-extension-contracts
- acp-session-journal
- workspace-mutation-broker
- workspace-journal
- local-harness-store
- sidecar-supervisor
- task-memory-store-v1
- memory-v2-coordinator
- repository-identity
- harness-enforcement-policy
- harness-intelligence-leases-discovery
- audit-intelligence-inventory
- credentials-store
- custom-tool-definition
- validate-agents
- load-agents
- load-mcp-config
- load-skills

### Files
- sdk/src/services/acp/acp-agent.ts
- sdk/src/services/acp/extensions.ts
- sdk/src/services/acp/session-data.ts
- sdk/src/services/workspace-mutation-broker.ts
- sdk/src/services/workspace-journal.ts
- sdk/src/services/local-harness-store.ts
- sdk/src/services/sidecar-supervisor.ts
- sdk/src/services/task-memory-store.ts
- sdk/src/services/memory-v2/types.ts
- sdk/src/services/memory-v2/coordinator.ts
- sdk/src/services/repository-identity.ts
- sdk/src/services/harness-enforcement.ts
- sdk/src/services/harness-intelligence.ts
- sdk/src/services/audit-intelligence.ts
- sdk/src/credentials.ts
- sdk/src/custom-tool.ts
- sdk/src/validate-agents.ts
- sdk/src/agents/load-agents.ts
- sdk/src/agents/load-mcp-config.ts
- sdk/src/skills/load-skills.ts

### Domains
- performance
- state-mutation
- security
- api-contract
