# Audit findings: w2-plan-p1-p2

- Subsystems: .agents, sdk, cli, packages
- Features: P1-T1, P1-T2, P1-T3, P1-T4, P1-T5, P1-T6, P1-T7, P1-T9, P1-T10, P2-T1, P2-T2, P2-T3, P2-T4, P2-T5, P2-T6, P2-T7, P2-T8, P2-T9
- Files covered: 16
- Snapshot: 49801b44e84d3d8fa583c3ebd9b2855228bf122572b7cdf5f78c77b3389d824d

## [HIGH] correctness — cli/src/utils/syntax-highlighter.tsx:9 — [LANG][POLY] P1-T6: web-tree-sitter-only highlighting covers 15 grammars — change approach to shiki (TextMate) primary, tree-sitter as optional tier
- **Risk:** highlightCode is a stub (returns one <span>, :9-19) and renderCodeBlock paints every line in codeTextFg (markdown-renderer.tsx renderCodeBlock). Building on the shipped web-tree-sitter grammars limits highlighting to the 15 grammars in packages/code-map/src/wasm-files.ts:2-16 (ts/tsx/js/py/java/c#/c/cpp/rust/ruby/go/php/swift/kotlin/gdscript). Fenced blocks agents emit most often in polyglot repos — bash/sh, json, yaml, toml, sql, diff, dockerfile, makefile, hcl/terraform, lua, elixir, haskell, scala, zig, dart, ocaml, nix, proto, graphql, markdown — would stay monochrome. Those grammars also ship without highlights.scm queries in this repo (code-map uses them for tags/outline), so each needs a query file added and maintained (inferred; not verified per grammar).
- **Fix:** Use shiki (pinned exact) with its JavaScript regex engine (createJavaScriptRegexEngine, which avoids the Oniguruma WASM) and lazy per-language grammar import. That covers about 200 TextMate grammars, the same set VS Code uses. It is TS in-process (principle 3a) and emits token arrays {content,color,fontStyle} that map straight onto the styled-span protocol P1-T6 already plans. Resolve fence aliases via shiki's bundledLanguagesAlias. For a language shiki lacks, fall back to the tree-sitter highlights.scm path for the 15 local grammars, then to plain text. Report which tier was used in the X-4 capability map. Reject syntect/tree-sitter-highlight via napi: principle 3d allows napi only for sub-ms kernels with X-2 evidence, and there is no baseline row for highlighting. Highlight only closed fences, per the existing renderStreamingMarkdown split, and memoize by (lang, content hash) so P1-T10 caching composes.
- **Evidence:** PLAN.md P1-T6: 'Real syntax highlighting using the already-shipped web-tree-sitter grammars (or shiki)'. cli/src/utils/syntax-highlighter.tsx:9-19 stub ('For now, just return the code'). packages/code-map/src/wasm-files.ts:2-16 lists 15 grammars; packages/code-map/src/languages.ts:63-133 registry. markdown-renderer.tsx renderCodeBlock applies a single fg per line.

## [HIGH] correctness — .agents/sessions/polyglot-roadmap-v2/PLAN.md — [LANG] P2-T8: Bun Workers for subagent supervision cannot hard-kill or cap resources — change approach to supervised child processes
- **Risk:** A Bun Worker shares the process address space. Worker.terminate() does not kill OS processes the child agent spawned (run_terminal_command, MCP stdio servers, LSP). A native fault in any worker (the Bun recursive-watcher SIGILL documented at index-workspace-watcher.ts:31-36, the node-llama-cpp segfault behind D7) takes down the parent and every sibling. Per-worker memory/CPU caps are not enforceable (Bun does not honor Node resourceLimits, inferred from Bun docs, not verified here). 'Hard kill and restart policies' therefore cannot be delivered with Workers.
- **Fix:** Supervise each subagent as a child process via Bun.spawn with ipc (or ndjson over stdio, reusing the X-5 sidecar-supervisor code: handshake, backoff, bounded pending map). Place it in its own process group (detached, then kill(-pgid)) so a hard kill takes the whole tree. Children return receipts over IPC and only the parent applies them, as the plan already says. When P5-T2/P6-T5 land, the Rust jobd/daemon takes over cgroups v2, pidfd and Job Objects for the same children with no protocol change. Keep Workers only for pure-CPU helpers that spawn nothing.
- **Evidence:** PLAN.md P2-T8: 'Supervision uses Bun Workers with hard kill and restart policies'. SPEC D7 rationale (a crash must not take down the TUI). cli/src/utils/index-workspace-watcher.ts:31-36 (Bun native trap takes the process). PLAN.md X-5 sidecar-supervisor already implements restart/backoff for child processes.

## [HIGH] state-mutation — .agents/sessions/polyglot-roadmap-v2/PLAN.md — [POLY] P2-T4: turn snapshots via git write-tree cover only the git-visible tree — ecosystem build artifacts, installed deps and non-git repos are silently outside /undo-turn
- **Risk:** A private GIT_INDEX_FILE + write-tree captures tracked (and optionally untracked non-ignored) files only. Almost every basher side effect in a non-JS repo lands in ignored paths: cargo target/, .venv/site-packages from pip/uv/poetry, __pycache__, Go module cache, Maven ~/.m2 and target/, Gradle .gradle/build, .NET bin/obj, CMake build dirs, Bundler vendor/bundle, CocoaPods Pods, and global caches outside the repo. Package-manager installs mutate those plus lockfiles. /undo-turn would restore the lockfile but not the installed tree, leaving the workspace inconsistent. It would also claim success, which violates principle 6. Repos not on git (hg/svn/jj/none) get nothing.
- **Fix:** Keep git plumbing, but: (1) snapshot with `git add -A` into the private index so untracked non-ignored files are covered, with a size cap and an LFS/binary skip list; (2) for a non-git or bare workspace, use a shadow repo (GIT_DIR=.openbuff/snapshots.git, GIT_WORK_TREE=root); (3) derive an 'uncovered side-effect' list per ecosystem from language-capabilities.ts (D16) and diff ignored-path mtimes before and after each shell command, then report `undo: tracked-tree-only; not restored: target/, .venv/` in the undo result and X-4 instead of claiming full undo; (4) after restoring a lockfile, offer the ecosystem's reinstall command (cargo build, uv sync, go mod download, dotnet restore) as a suggested follow-up, not an automatic one. The complete fix is the P6-T2 COW lanes (reflink/overlayfs).
- **Evidence:** PLAN.md P2-T4: 'private GIT_INDEX_FILE, write-tree, commit-tree onto a private ref ... gate: undo covers basher side effects in the tracked tree'. SPEC principle 6 (never overstate guarantees). The index watcher's JS-centric ignore list (index-workspace-watcher.ts:13-25) shows the same blind spot.

## [MEDIUM] api-contract — sdk/src/services/acp/extensions.ts:10 — [LANG] P1-T1: keep the TS ACP SDK; migrate off the deprecated AgentSideConnection and fix the extension namespace drift (openbuff/* vs _openbuff.dev/*)
- **Risk:** The TS SDK is the right choice, because the core stays TS under principle 1. Moving to the Rust agent-client-protocol crate would split the core across a process boundary for no gain. The implementation has drifted from the normative design, though. ACP_EXTENSION_METHODS are 'openbuff/getReceipts|askUser|gateState' (:10-14), while P1-T1-DESIGN §6 requires '_openbuff.dev/<area>/<verb>' plus extVersion negotiation and the no-ext-echo rule. The underscore prefix is the ACP extension marker, so strict clients may route non-underscore methods as unknown core methods. Session ids are randomUUID (acp-agent.ts newSession), not the obs_+ULID the design pins (GV-04), and they bypass P2-T1 IdGen. serveAcpOverStdio and the socket listener both use the @deprecated AgentSideConnection, although the design selects the fluent agent() API.
- **Fix:** Keep @agentclientprotocol/sdk pinned. Rename the extension methods to the _openbuff.dev namespace with a one-release alias table. Negotiate clientCapabilities._meta['openbuff.dev'].extVersion. Mint session ids through the injected IdGen with an obs_ prefix. Port both transports to the agent() builder behind one shared factory, so the socket and stdio paths cannot diverge. Pin all of this with GV-01…GV-14.
- **Evidence:** sdk/src/services/acp/extensions.ts:10-14; acp-agent.ts newSession uses randomUUID and initialize omits _meta negotiation; acp-agent.ts serveAcpOverStdio comment 'AgentSideConnection is marked @deprecated'; socket-listener.ts handleConnection repeats the same construct. P1-T1-DESIGN.md §6 conventions, §3.2, GV-04.

## [MEDIUM] security — sdk/src/serve/bridge.ts — [LANG] P1-T2: keep TS for the bridge; change the NEW-7 SSRF pinning mechanism (undici Agent connect.lookup is not a reliable seam under Bun fetch)
- **Risk:** Everything remaining in P1-T2 is correctly TS: the §4.2 event mapping, holdback, limits and containment are protocol glue. One mechanism is risky. NEW-7 pins DNS through an undici Agent connect.lookup passed as a fetch dispatcher. Bun's fetch is not undici, and dispatcher/connect.lookup support is partial or absent (inferred, not verified in this shard). A DNS-rebinding TOCTOU would then stay open while tests pass on Node semantics. Peer-cred is also unavailable in Bun net, which the design already acknowledges. Separately, the bridge today forwards only 'text' events (bridge.ts extractForwardableText), so the tool_call/plan/usage rows are the actual gap to close. That gap is plan work, not a language issue.
- **Fix:** Implement client-MCP http/sse egress by resolving once with dns.lookup(all), checking every address against the §12.3 policy, and connecting to the vetted IP via node:tls/https with servername/Host set to the original hostname. Alternatively, give the MCP SDK transport a custom fetch built on that. Add a test that serves a rebinding resolver. When P5-T3 lands, route client MCP egress through the Rust hyper/rustls egress proxy, which enforces the policy at connect time. Keep peer-cred as documented best-effort.
- **Evidence:** P1-T1-DESIGN.md §12.8 NEW-7 ('custom fetch whose undici Agent connect.lookup enforces the §12.3 IP policy'); §2 peer-cred note. sdk/src/serve/bridge.ts extractForwardableText only returns event.type==='text'. PLAN.md P1-T2 REMAINING list.

## [MEDIUM] correctness — .agents/sessions/polyglot-roadmap-v2/PLAN.md — [LANG] P1-T3: keep TS (ACP ClientSideConnection); resolve the detach/reattach vs connection-owned-session conflict first
- **Risk:** TS is correct because the TUI is TS and the SDK ships ClientSideConnection. The plan's 'detach/reattach to a live session' contradicts P1-T1-DESIGN §12.2, under which each session is owned by the creating connection and owner disconnect aborts the run and denies pending approvals (§12.4). Taken literally, reattaching is impossible, and detaching kills the run.
- **Fix:** Add an explicit extension method, _openbuff.dev/session/attach {sessionId, resumeToken}. The server mints a one-time resumeToken per session, stores it only in the 0600 run dir, and makes owner-disconnect a grace-period park (approvals held, not auto-denied, for N seconds) instead of an abort. Pin this with new golden vectors. Keep the in-process compat shim as the D5 default.
- **Evidence:** PLAN.md P1-T3 'detach/reattach to a live session'. P1-T1-DESIGN.md §12.2 Ownership, §12.4 Disconnect. socket-listener.ts: a fresh AgentSideConnection per socket with a per-connection session map.

## [MEDIUM] performance — packages/agent-runtime/src/util/run-journal.ts:135 — [LANG] P2-T2: keep bun:sqlite (Rust redb only at P6-T5); change approach for batching/retention: in-memory seq, transactions, per-run files
- **Risk:** bun:sqlite WAL is the right store: synchronous, zero dependencies, and the D14-sanctioned store. An append-only JSONL log would lose indexed correlation lookups, and redb belongs in the Rust daemon later. The current shape will not scale, though. Every append runs SELECT MAX(seq) then INSERT with no transaction (:135-150), so a crash between the two is safe but concurrent writers (background agents, P2-T8 processes) can collide on the PK. classifyRunResume calls reader.events(runId) (a full scan plus JSON.parse of every payload) per classification, and planChildResume repeats that per child. JSON.parse on read is unguarded, so one torn row throws the whole resume. Retention by DELETE on a single db file bloats it without VACUUM.
- **Fix:** Keep a per-runId seq counter in memory, seeded once from MAX(seq). Wrap each step's non-critical appends in one BEGIN IMMEDIATE…COMMIT flushed at step_boundary, and commit the tool_call row synchronously on its own (design §8). Answer 'has tool_result for correlation' with an indexed EXISTS query instead of events(). Wrap parseRow in a try/catch that surfaces a typed corrupt_event resume classification. Put retention on one file per root run (or ATTACH per run) so rotation is an unlink. The replay driver stays TS because it re-drives TS generators. Cross-process writers after P2-T8 go through the parent (single writer), keeping the design's single-writer assumption true.
- **Evidence:** run-journal.ts append (MAX(seq) then INSERT), classifyRunResume uses reader.events(runId).some(...), parseRow JSON.parse. P2-T2-DESIGN.md §8 hot-path and growth risks, §9 slice 4.

## [MEDIUM] correctness — .agents/sessions/polyglot-roadmap-v2/PLAN.md — [LANG] P2-T3: keep TS; bind replay/fork to P2-T4 workspace tree ids or replay is not deterministic
- **Risk:** TS is correct, since replay re-drives the TS loop and generator from journaled llm_response/tool_result. Determinism covers the model and tool outputs but not the workspace. --from-step N re-executes live tools against today's working tree, not the tree that existed at step N. Replays and eval-fixture exports therefore diverge in any repo whose build or tests depend on file state (every language).
- **Fix:** Journal the P2-T4 snapshot tree id in each step_boundary payload. `replay --from-step N` first materializes that tree into a scratch worktree (git worktree add --detach, or the P6-T2 lane later), then replays. The eval fixture exports as {tree id bundle, journal slice}. Pin Clock/IdGen as in P2-T1.
- **Evidence:** PLAN.md P2-T3; P2-T2-DESIGN.md §5 (determinism covers ids/timestamps only); run-journal.ts step_boundary payload carries {status, childRunIds, credits} and no tree id.

## [MEDIUM] performance — cli/src/utils/index-workspace-watcher.ts:27 — [LANG] P2-T9: adopt an existing prebuilt watcher (@parcel/watcher) instead of hand-rolled per-directory fs.watch workers
- **Risk:** Per-directory non-recursive fs.watch with an fd cap reproduces the exact failure being avoided (one fd per directory under Bun). Past the cap it silently degrades to partial coverage, and it needs its own directory-walk and rename bookkeeping, all to be deleted at P6-T6. @parcel/watcher is an existing, widely used prebuilt addon. It uses inotify watch descriptors (bounded by max_user_watches, not the fd table), FSEvents, and ReadDirectoryChangesW, applies ignore globs natively, and batches events. Principle 3d explicitly allows existing prebuilt addons, and the plan's 'do not build a napi watcher kernel' does not forbid adopting one.
- **Fix:** Add @parcel/watcher (pinned exact, dependency-review, `bun add --cwd cli`) behind a capability probe. If it fails to load under Bun, drop to a documented age-sweep tier and report `index.watch: sweep-only` in X-4. Feed its batched events into the existing classifyIndexWatchPath/markPathsChanged flush. P6-T6 notify-rs in the daemon supersedes it without an API change. Gate with a Linux+Bun test on a 50k-directory tree that also asserts no EMFILE.
- **Evidence:** cli/src/utils/index-workspace-watcher.ts:27-37 disables recursive watching on linux+bun; PLAN.md P2-T9 'worker-thread non-recursive per-directory watchers with an fd cap'; SPEC principle 3(d).

## [MEDIUM] correctness — cli/src/utils/index-workspace-watcher.ts:13 — [POLY] P2-T9: watcher ignore set is JS-ecosystem-only — build outputs of other languages flood the index dirty queue
- **Risk:** IGNORED_TOP_LEVEL hardcodes .git/.hg/.svn/node_modules/dist/build/.next/.nuxt/.output/.turbo/coverage. A cargo build writes thousands of files under target/, pytest writes __pycache__/.pytest_cache, and there are also .venv, .tox, .mypy_cache, vendor/, .NET bin/obj, .gradle, zig-cache/.zig-cache, Elixir _build/deps, .stack-work, Pods/DerivedData, .dart_tool and cmake-build-*. Each is classified 'changed', triggering markPathsChanged storms or markStale during every build and test run. Nested ignores (crates/foo/target) are not matched at all because only the top-level segment is checked.
- **Fix:** Derive ignores from the repo's .gitignore stack (git check-ignore --stdin in batches, or the ignore package that code_search/rg already honor) and union a per-ecosystem artifact list sourced from language-capabilities.ts (D16), so the index, watcher and snapshots share one definition. Match every path segment, not just the top level.
- **Evidence:** cli/src/utils/index-workspace-watcher.ts:13-25 IGNORED_TOP_LEVEL; classifyIndexWatchPath checks only relativePath.split('/')[0].

## [LOW] dependency-hygiene — .agents/sessions/polyglot-roadmap-v2/PLAN.md — [LANG] P1-T4: confirmed — TS @modelcontextprotocol/sdk in-process
- **Risk:** None from the language choice. The MCP server exposes TS-owned state (index, cap.v3 reads, broker receipts, memory), and the official TS SDK is already a dependency (P1-T1-DESIGN §13, sdk 1.20.2). A Rust/Go server would have to proxy every call back into the TS core. Polyglot value comes from what it exposes, which is language-neutral once P3 LSP/SCIP feed query_index.
- **Fix:** Keep. Emit the tool JSON Schemas from the X-1 compileToolJsonSchemas artifacts (D17) so the MCP tool list cannot drift. Route receipt-backed edits through the same sanitizeOutbound chokepoint as ACP.
- **Evidence:** PLAN.md P1-T4; P1-T1-DESIGN.md §13 MCP SDK row; SPEC D17.

## [LOW] api-contract — .agents/sessions/polyglot-roadmap-v2/PLAN.md — [LANG] P1-T5: confirmed — TS; make `run --json` an ndjson dump of the ACP session/update stream rather than a new schema
- **Risk:** No language issue. The only risk is inventing a third event schema next to PrintModeEvent and ACP updates.
- **Fix:** Keep TS. Implement `openbuff run --json` as an in-process ACP client that writes the sanitized session/update frames as ndjson, with exit codes mapped from stopReason (§4.5). CI consumers can then share parsers with editor clients and the P7-T6 generated SDKs.
- **Evidence:** PLAN.md P1-T5; P1-T1-DESIGN.md §4.2, §4.5.

## [LOW] correctness — .agents/sessions/polyglot-roadmap-v2/PLAN.md — [LANG] P1-T7: confirmed — TS escape sequences; shelling to wl-copy is correct until P7-T5 arboard
- **Risk:** OSC 9/777 and DA1/XTGETTCAP are byte strings written to the TTY, and a native addon adds nothing. wl-copy/xclip/pbcopy spawns are the right interim before the P7-T5 arboard napi. The only caveat is that the spawns must use getChildProcessEnv (P0-T1) and be async, not execSync.
- **Fix:** Keep. Wrap OSC 9/777 in tmux DCS passthrough when $TMUX is set. Parse the XTGETTCAP/DA1 replies with a timeout so the P1-T9 startup budget is not blocked.
- **Evidence:** PLAN.md P1-T7, P7-T5; P1-T9 (OSC probe startup blocking).

## [LOW] performance — .agents/sessions/polyglot-roadmap-v2/PLAN.md — [LANG] P1-T9: confirmed — TS startup reordering; no native component justified
- **Risk:** Every item (Promise.all of the theme probe and init, lazy Parser.init, deferred registries, pre-warmed rg) is scheduling, not compute. The sub-100ms target belongs to P7-T8 (warm daemon).
- **Fix:** Keep. Land the X-2 cold-start row first so the P7-T8 daemon claim has a baseline.
- **Evidence:** PLAN.md P1-T9, P7-T8, X-2 (cold start documented as manual-only row).

## [LOW] performance — cli/src/utils/markdown-renderer.tsx:113 — [LANG] P1-T10: confirmed — keep remark/mdast with block-level caching; comrak/pulldown-cmark napi not justified
- **Risk:** renderMarkdown re-parses the whole document per chunk (processor.parse, :113 and renderMarkdown). The fix the plan chooses, caching closed blocks and re-parsing only the trailing open block, turns the cost from O(document) into O(tail), which removes the case for a native parser. comrak via napi would also need an mdast-compatible AST and would break applyInlineFallbackFormatting. micromark alone is lower-level than needed.
- **Fix:** Keep remark. Split on top-level block boundaries using the mdast position offsets of all but the last root child, reuse the cached React nodes by content hash, and treat an open fence (hasIncompleteCodeFence) as the tail. Add an X-2 row for streaming a 200KB markdown document, and reconsider native only if that row fails.
- **Evidence:** cli/src/utils/markdown-renderer.tsx:113 processor; renderMarkdown parses the full string; renderStreamingMarkdown splits at the last fence. PLAN.md P1-T10 'No napi markdown parser'.

## [LOW] correctness — packages/agent-runtime/src/orchestration/workflow-engine.ts:50 — [LANG] P2-T1: confirmed — TS injection; extend Clock to workflow-engine before P2-T6 persists it
- **Risk:** Correctly TS, and the determinism guard is the right enforcement. transitionWorkflow still calls Date.now() at :50 and :80. It is advisory today, but once P2-T6 makes it the persisted gate, replayed transitions will mint different updatedAt values and break byte-matching replay.
- **Fix:** Keep. Add an optional `now` or `clock` param to transitionWorkflow/transitionBase2Gate as part of P2-T6, and remove the baseline entry for this file.
- **Evidence:** workflow-engine.ts:50 and :80 Date.now(); PLAN.md P2-T1 determinism-guard baseline.

## [LOW] correctness — .agents/sessions/polyglot-roadmap-v2/PLAN.md — [LANG] P2-T5: confirmed — TS intent log; store it in the P2-T2 journal rather than a separate file
- **Risk:** TS is correct because the broker is TS. renameat2(RENAME_EXCHANGE) via X-3 is rightly deferred, since write-temp + fsync + rename is portable (and MoveFileEx on Windows). A second log would duplicate the crash-recovery reader.
- **Fix:** Keep. Record transaction intents as journal events (tx_begin/tx_commit with transactionId), so classifyRunResume also detects half-applied transactions and P2-T2 §8's exactly-once gap closes in one place.
- **Evidence:** PLAN.md P2-T5; P2-T2-DESIGN.md §8 'pair with P2-T5'.

## [LOW] api-contract — packages/agent-runtime/src/orchestration/workflow-engine.ts — [LANG] P2-T6: confirmed — hand-rolled data-defined statechart over XState, until P9-T4
- **Risk:** XState v5 offers persisted snapshots and Stately visualization, but the authoritative gate runs inside base2's serialized handleSteps (new Function, workflow-engine.ts docblock). An imported library cannot cross that boundary until P9-T4's QuickJS VM. The existing definition is already plain data (WorkflowDefinitionV1), which is what persistence and visualization need.
- **Fix:** Keep hand-rolled. Add hierarchical/guard fields as a versioned WorkflowDefinitionV2, export a Mermaid/SCXML view for `openbuff dash`, persist state in the P2-T2 journal, and take the clock via injection. Revisit XState after P9-T4.
- **Evidence:** workflow-engine.ts:1-15 (gate lives in serialized handleSteps), :22-28 data definition; PLAN.md P2-T6, P9-T4.

## [LOW] security — .agents/sessions/polyglot-roadmap-v2/PLAN.md — [LANG] P2-T7: confirmed — TS/React dashboard via Bun.serve; add Host/Origin checks against DNS rebinding
- **Risk:** The language choice is right: it reuses the React components and journal readers. Any localhost HTTP server with a token is still exposed to DNS rebinding and cross-origin requests from the browser if the token leaks into URLs or referrers.
- **Fix:** Keep. Bind to 127.0.0.1 only. Reject any Host that is not 127.0.0.1:port or localhost:port, and reject cross-origin Origin headers. Pass the token via fragment and then a cookie (SameSite=Strict), and never put it in a query string. Run all served journal content through sanitizeOutbound. The static export must contain no cap.v3 tokens.
- **Evidence:** PLAN.md P2-T7 'localhost + token dashboard'; P1-T1-DESIGN.md §12.1 chokepoint.

## Coverage receipt

### Subsystems
- .agents
- sdk
- cli
- packages

### Features
- P1-T1
- P1-T2
- P1-T3
- P1-T4
- P1-T5
- P1-T6
- P1-T7
- P1-T9
- P1-T10
- P2-T1
- P2-T2
- P2-T3
- P2-T4
- P2-T5
- P2-T6
- P2-T7
- P2-T8
- P2-T9

### Files
- .agents/sessions/polyglot-roadmap-v2/PLAN.md
- .agents/sessions/polyglot-roadmap-v2/SPEC.md
- .agents/sessions/polyglot-roadmap-v2/P1-T1-DESIGN.md
- .agents/sessions/polyglot-roadmap-v2/P1-T2-DESIGN.md
- .agents/sessions/polyglot-roadmap-v2/P2-T2-DESIGN.md
- sdk/src/services/acp/acp-agent.ts
- sdk/src/services/acp/extensions.ts
- sdk/src/serve/bridge.ts
- sdk/src/serve/socket-listener.ts
- packages/agent-runtime/src/util/run-journal.ts
- packages/agent-runtime/src/orchestration/workflow-engine.ts
- cli/src/utils/markdown-renderer.tsx
- cli/src/utils/syntax-highlighter.tsx
- cli/src/utils/index-workspace-watcher.ts
- packages/code-map/src/wasm-files.ts
- packages/code-map/src/languages.ts

### Domains
- security
- correctness
- state-mutation
- error-handling
- performance
- dependency-hygiene
- test-coverage
- api-contract
