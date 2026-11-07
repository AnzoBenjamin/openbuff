# Audit findings: cb-cli-services

- Subsystems: cli
- Features: command-routing, cli-args, chat-persistence, chat-history-listing, memory-store-v2, contained-file-io, chatgpt-oauth, analytics, logging, git-ops, bash-mode, acp-serve, settings-config, fingerprint-shell-detect, native-ripgrep, release-packaging, os-integration
- Files covered: 22
- Snapshot: 49801b44e84d3d8fa583c3ebd9b2855228bf122572b7cdf5f78c77b3389d824d

## [HIGH] security — cli/src/services/memory-v2/bun-sqlite-memory-repository.ts:172 — Memory store v2 (event-sourced SQLite): MIGRATE to Rust daemon (later)
- **Risk:** (2) 4.8k-line TS repo on bun:sqlite (class 445-2026, migrate 2336, applyProjection 2739, buildLexicalResult 3591-4549). The file itself declares SQLITE_OPEN_POSTURE='pathname-best-effort-unverified-open' (172-183): bun:sqlite only takes a path string, so the file checks (prepareDatabasePath 2034, verifyOpenedDatabasePath 2115) can't prove SQLite opened the files that were checked (TOCTOU on db/-wal/-shm). The lexical scoring runs on the JS main thread. The store is tied to one process, which rules out multi-client attach/detach. (3) Needs: an fd-anchored open, one writer for many readers, background projection rebuild/GC, and a store it can share across sessions.
- **Fix:** (4) Rust: rusqlite (bundled) + SQLITE_OPEN_NOFOLLOW + cap-std/openat2 for dir-anchored open, or a custom VFS; tantivy for lexical/concept recall; Go: modernc sqlite (weaker containment story). (5) Verdict: MIGRATE to Rust in the daemon. Keep the TS types (RuntimeNeutralMemoryRepositoryV2, line 74) as the IPC contract. (6) Now: nothing, keep the TS version. Next: a daemon-owned store unlocks attach/detach, cross-session memory, off-thread GC/compaction, and verified-open security. (7) Cost: L (4-6 wks). The projection/replay semantics and test corpus have to be ported, and two implementations run in parallel while it moves.
- **Evidence:** bun-sqlite-memory-repository.ts:1 (import bun:sqlite), :172-183 posture comment, :2034-2184 pathname hardening, :3591-4549 lexical scorer. Cost L. Confidence: medium-high. Needs web verification: rusqlite exposes SQLITE_OPEN_NOFOLLOW (SQLite >=3.31); whether bun:sqlite exposes open flags or fd-open in current Bun.

## [MEDIUM] security — cli/src/services/memory-v2/contained-file-io.ts:74 — Contained file IO (fd-anchored traversal): MIGRATE with memory store (Rust cap-std)
- **Risk:** (2) It emulates openat-style contained traversal in Node by walking directory fds and going through /proc/self/fd paths (procPath 74-78, openRoot 97, traverse 149, writeExclusive 267). That only works on Linux: requireSupported (56) gates other platforms, so macOS/Windows lose containment. (3) Needs: a portable, symlink-safe, race-free contained read/write.
- **Fix:** (4) Rust cap-std / cap-fs-ext (openat2 RESOLVE_BENEATH on Linux, O_NOFOLLOW_ANY on macOS); Go os.Root (Go 1.24+). (5) Verdict: MIGRATE together with the memory store. Go os.Root is a cheap alternative if the daemon ends up in Go. (6) Now: none. Next: equal containment on every platform for memory and plan artifacts. (7) Cost: S-M if done alongside the store.
- **Evidence:** contained-file-io.ts:56 requireSupported, :74 procPath, :97-164 openRoot/traverse (outline-level read only). Cost S-M. Confidence: medium. Needs web verification: Go os.Root semantics/version; cap-std macOS guarantees.

## [MEDIUM] state-mutation — cli/src/utils/run-state-storage.ts:347 — Chat/run-state persistence + mid-turn checkpoints: KEEP-NOW, MOVE-TO-DAEMON-LATER
- **Risk:** (2) Each save synchronously writes the whole state three times: the envelope chat-state.json plus the legacy run-state.json and chat-messages.json (saveChatState 347-398, writeJsonAtomic 243-257). The temp+rename has no fsync. There's a 30s checkpoint file (saveCheckpoint 457). The mixed-version envelope guards (84, 101) are careful. Rewriting O(history) on every turn blocks the TUI thread as sessions grow. With no single-writer lock, two processes (TUI + serve) on one chat can overwrite each other. (3) Needs: append-only/incremental writes, one writer, and reads that a detached client can do.
- **Fix:** (4) TS: bun:sqlite WAL table or append-only JSONL plus a periodic snapshot. Rust: rusqlite/redb in the daemon. (5) Verdict: KEEP TS now and switch to append-only JSONL deltas plus a snapshot. Drop the legacy sidecars once history reads the envelope. Put ownership in the daemon when attach/detach ships. (6) Now: cheaper turns, crash-safe writes (add fsync). Next: daemon-owned sessions enable attach/detach and multiple viewers. (7) Cost: S now, M for the daemon move.
- **Evidence:** run-state-storage.ts:243-257 writeJsonAtomic (no fsync), :347-398 triple write, :457-503 checkpoint. Cost S/M. Confidence: high (code read fully).

## [LOW] performance — cli/src/utils/chat-history.ts:62 — Chat history listing: KEEP (TS)
- **Risk:** (2) Lists up to 500 chat directories and fully JSON.parses each chat-messages.json just to get the first user prompt and a count (sync 62-138, async 140-201 batched 16/32). Cost scales with total history bytes. (3) Needs: a cheap index.
- **Fix:** (5) KEEP TS. Write a small index.json (or a column in the daemon DB) with firstPrompt and messageCount at save time. (6) Now: instant history screen. Next: the daemon serves the list to any client. (7) Cost: S.
- **Evidence:** chat-history.ts:103-108 full parse per chat. Cost S. Confidence: high.

## [LOW] performance — cli/src/commands/command-registry.ts:441 — Slash-command routing + CLI arg parsing: KEEP (TS)
- **Risk:** (2) A declarative ALL_COMMANDS registry (441-1235) with fuzzy suggestions (1270), routeUserPrompt (router.ts:259), and commander argv parsing with a separate serve program (cli-args.ts:41-99). All of it is coupled to the zustand stores and React UI. (3) Needs: UI coupling and fast iteration. There's no compute load.
- **Fix:** (5) KEEP TS; moving it to another language gains nothing. When the daemon arrives, split command semantics (daemon RPC) from presentation (TUI) so thin clients can reuse them. (7) Cost: none.
- **Evidence:** command-registry.ts:441-1235, router.ts:259-533, cli-args.ts:29-151. Cost none. Confidence: high.

## [MEDIUM] security — cli/src/utils/chatgpt-oauth.ts:89 — ChatGPT OAuth PKCE + credential storage: KEEP TS flow, CONSUME OS keychain
- **Risk:** (2) Node http loopback callback server (158-243) plus fetch token exchange (282-331). Credentials are persisted through SDK saveChatGptOAuthCredentials (324); the storage backend wasn't verified in this shard and is probably a JSON file under the config dir. Separately, state is set to the PKCE code_verifier (89, 257), which puts the verifier in the authorize URL and browser history and defeats PKCE's secrecy. (3) Needs: secret storage at rest, random state.
- **Fix:** (4) TS: @napi-rs/keyring (a wrapper over the Rust keyring crate: macOS Keychain, Windows Credential Manager, Secret Service) with a file fallback. Rust: keyring crate + oauth2 crate in the daemon. Go: zalando/go-keyring. (5) Verdict: KEEP the TS flow, CONSUME a keychain binding, use an independent random state now. (6) Now: tokens stay off disk. Next: the daemon holds tokens and clients never see refresh tokens. (7) Cost: S.
- **Evidence:** chatgpt-oauth.ts:89 `const state = codeVerifier`, :257 same, :324 saveChatGptOAuthCredentials (SDK). Cost S. Confidence: high on state reuse; storage backend unverified. Needs web verification: @napi-rs/keyring maintenance status and Bun compatibility.

## [LOW] dependency-hygiene — cli/src/utils/analytics.ts:139 — Analytics/telemetry: KEEP (delete dead scaffold; OTel later if needed)
- **Risk:** (2) initAnalytics, trackEvent, identifyUser and flushAnalytics are no-ops (139-160). logError (162) checks `client`, which is never assigned, so the PostHog client import and the analytics-dispatcher in logger.ts:98 are dead weight. Callers (router.ts:97, fingerprint.ts:187) still build payloads. (3) Needs: local-only operation, or opt-in telemetry later.
- **Fix:** (4) If telemetry comes back: @opentelemetry/sdk-node (TS) or opentelemetry + tracing-opentelemetry (Rust daemon), exporting OTLP to a user-chosen endpoint. (5) KEEP TS. Remove the posthog/analytics-core imports and dead state now. (6) Now: a smaller binary and less supply-chain surface. Next: opt-in OTel spans from the daemon. (7) Cost: XS.
- **Evidence:** analytics.ts:1-6 posthog import, :139-160 no-ops, :162-186 unreachable client path; logger.ts:98 dispatcher. Cost XS. Confidence: high.

## [LOW] performance — cli/src/utils/logger.ts:129 — Logging: KEEP (TS pino)
- **Risk:** (2) pino with a sync SonicBoom destination (139-143), 10 MiB rotation (97, 189). The sync writes block the TUI thread on slow disks, which is minor. (3) Needs: structured JSONL.
- **Fix:** (5) KEEP. Consider sync:false with a flush on exit. The daemon would use the Rust tracing + tracing-appender crates. (7) Cost: XS.
- **Evidence:** logger.ts:129-165, :97 LOG_MAX_BYTES. Cost XS. Confidence: high.

## [LOW] performance — cli/src/utils/git.ts:8 — Git ops (repo root, diff stats): KEEP (git CLI); gix only if daemon watches repos
- **Risk:** (2) findGitRoot walks up looking for .git (8-21) and ignores GIT_DIR, worktrees and submodules only partly (a .git file still matches). Diff stats come from `git status --porcelain` via execFile with a 5s timeout (79-105); the sync execSync variant (54-72) uses a shell string. Spawn cost is ~10-50ms per poll. (3) Needs: occasional status. No heavy object access.
- **Fix:** (4) Rust gix (gix-status, gix-discover); Go go-git (status is slow on large repos); TS isomorphic-git (slow). (5) KEEP the git CLI: it's the most correct choice (respects user config, hooks, fsmonitor). Use `git rev-parse --show-toplevel` for the root. MIGRATE to gix only if a daemon needs to watch many repos at high frequency. (7) Cost: none now; M for a gix daemon.
- **Evidence:** git.ts:8-21, :54-72 execSync, :79-105 execFile. Cost none/M. Confidence: high. Needs web verification: gix status feature completeness (index+worktree diff) in current release.

## [MEDIUM] state-mutation — cli/src/commands/router.ts:44 — Bash mode (interactive shell commands): KEEP-NOW, MIGRATE PTY ownership to Rust daemon later
- **Risk:** (2) runBashCommand runs the SDK runTerminalCommand with process_type SYNC and a 10-minute timeout (38, 82-89). Output is buffered and shown only when the command completes. Cancellation is a map of AbortControllers kept in process memory (bash-command-controller.ts:1-24). There's no PTY, so interactive programs, colors and streaming don't work, and any running command dies with the TUI, which blocks detach. (3) Needs: a PTY, streamed output, a process that outlives the client, and reattach.
- **Fix:** (4) Rust portable-pty (wezterm) or pty-process; Go creack/pty; TS node-pty (a native addon, awkward with bun compile). (5) Verdict: KEEP TS now and add streaming. PTY sessions belong to a Rust (or Go) daemon. (6) Next: attach/detach of long-running commands, background jobs, and native notifications when a job finishes. (7) Cost: M.
- **Evidence:** router.ts:38 timeout, :82-89 SYNC runTerminalCommand; bash-command-controller.ts:1-24. Cost M. Confidence: medium-high. Needs web verification: node-pty/Bun compile compatibility.

## [LOW] security — cli/src/serve-command.ts:97 — ACP serve (stdio/unix socket): KEEP (TS) - seed of the daemon
- **Risk:** (2) runServe from the SDK over stdio or a token-authenticated unix socket, with a journal dir for restoring sessions (serve-command.ts:57-99, cli-args.ts:41-99). The generated token is printed to stderr (97), where it can end up in logs or terminal scrollback. (3) Needs: to reuse the TS SDK agent loop.
- **Fix:** (5) KEEP TS: the agent runtime is TS, so the server should live with it. Write the token to a 0600 file next to the socket instead of stderr. A future Rust supervisor (tray, PTY, memory) can proxy to this ACP endpoint. (6) Now: headless/IDE clients. Next: attach/detach through the same socket. (7) Cost: XS.
- **Evidence:** serve-command.ts:57-99, :97 token to stderr; cli-args.ts:41. Cost XS. Confidence: high.

## [LOW] state-mutation — cli/src/utils/settings.ts:130 — Settings/config dir: KEEP (TS)
- **Risk:** (2) XDG/APPDATA config dir resolution (auth.ts:19-40). settings.json is read-modify-written non-atomically (settings.ts:130-148), and loadSettings writes defaults as a side effect of a read (60-64). A concurrent TUI and serve process can lose updates. (3) Needs: a small config file.
- **Fix:** (5) KEEP. Reuse writeJsonAtomic from run-state-storage. (7) Cost: XS.
- **Evidence:** settings.ts:60-64, :130-148; auth.ts:19-40. Cost XS. Confidence: high.

## [LOW] dependency-hygiene — cli/src/utils/fingerprint.ts:20 — Fingerprint + shell detection: KEEP (TS, prune deps)
- **Risk:** (2) Lazily loads node-machine-id and systeminformation (20-86), which shell out to OS tools. It hashes MACs, serial and hostname (104-140), which is a privacy-sensitive PII hash in a local-only product. detect-shell uses `wmic` (detect-shell.ts:59), which is deprecated and removed in newer Windows. (3) Needs: a stable install id at most.
- **Fix:** (5) KEEP TS. Replace it with a random install UUID stored in the config dir and drop both deps. Replace wmic with PowerShell Get-CimInstance or the COMSPEC/PSModulePath heuristics. (7) Cost: XS.
- **Evidence:** fingerprint.ts:20-86, :104-140; detect-shell.ts:59. Cost XS. Confidence: high. Needs web verification: wmic removal timeline in Windows 11.

## [MEDIUM] security — cli/src/native/ripgrep.ts:38 — Native ripgrep delivery: KEEP rg binary, fix extraction (no language change)
- **Risk:** (2) The compiled binary self-extracts an embedded rg next to process.execPath (18-20, 59-66) and trusts any existing file there (32-35) without checking a hash. It runs chmod via spawn. The install dir may not be writable, which triggers a fallback, and any writable-dir attacker can plant rg. (3) Needs: a trusted, fast search binary.
- **Fix:** (4) Alternatives: Rust grep-searcher/ignore crates in a sidecar (same engine as rg); TS has no equal. (5) KEEP the rg subprocess. Extract to a per-user cache dir keyed by the embedded hash, verify sha256 before use, and use fs.chmod instead of spawn. (6) Next: a Rust daemon could link the grep/ignore crates directly. (7) Cost: S.
- **Evidence:** ripgrep.ts:18-20, :32-35 trust-existing, :59-66 write+chmod. Cost S. Confidence: high.

## [LOW] dependency-hygiene — cli/scripts/release.ts:72 — Release/packaging (bun compile single binary + smoke): KEEP (TS/Bun); add cargo-dist only when Rust ships
- **Risk:** (2) release.ts dispatches a GitHub workflow and checks that it's running (72-143). smoke-binary.ts probes tree-sitter/OpenTUI and the bootscreen (274-467). Bun compile already produces a single binary. A polyglot daemon adds cross-compile and signing for each target, and ripgrep already has a legacy-macOS special case (ripgrep.ts:24). (3) Needs: reproducible multi-platform artifacts.
- **Fix:** (4) Rust: cargo-dist or cargo-zigbuild; Go: goreleaser. (5) KEEP TS scripts. When a Rust daemon lands, ship it as a sibling binary through cargo-dist and embed or co-locate it like rg, extending smoke-binary with a daemon probe. (7) Cost: S now, M once polyglot.
- **Evidence:** release.ts:72-143; smoke-binary.ts:274-467; ripgrep.ts:24. Cost S/M. Confidence: medium. Needs web verification: cargo-dist current support for embedding into non-Rust installers.

## [LOW] performance — cli/src/utils/terminal-title.ts:57 — OS integration (open URL, terminal title; future notifications/tray): KEEP (TS); tray/notify in Rust daemon later
- **Risk:** (2) `open` package with a headless-Linux guard (open-url.ts:18-37). OSC title written to /dev/tty or CON (terminal-title.ts:57-76). There are no native notifications or tray, and a TUI process can't host a tray anyway. (3) Needs: a long-lived process for tray and notifications.
- **Fix:** (4) Rust tray-icon + notify-rust / tauri-plugin-notification; Go fyne-io/systray + gen2brain/beeep. (5) KEEP the current TS utilities. Put tray and notifications in the Rust daemon. OSC 9/777 terminal notifications are a TS stopgap for now. (7) Cost: M for tray.
- **Evidence:** open-url.ts:18-37; terminal-title.ts:57-76. Cost XS now/M later. Confidence: medium. Needs web verification: OSC 9/777 terminal support matrix.

## Coverage receipt

### Subsystems
- cli

### Features
- command-routing
- cli-args
- chat-persistence
- chat-history-listing
- memory-store-v2
- contained-file-io
- chatgpt-oauth
- analytics
- logging
- git-ops
- bash-mode
- acp-serve
- settings-config
- fingerprint-shell-detect
- native-ripgrep
- release-packaging
- os-integration

### Files
- cli/src/serve-command.ts
- cli/src/cli-args.ts
- cli/src/utils/run-state-storage.ts
- cli/src/utils/chat-history.ts
- cli/src/utils/git.ts
- cli/src/utils/auth.ts
- cli/src/utils/analytics.ts
- cli/scripts/release.ts
- cli/scripts/smoke-binary.ts
- cli/src/utils/chatgpt-oauth.ts
- cli/src/utils/settings.ts
- cli/src/utils/bash-command-controller.ts
- cli/src/native/ripgrep.ts
- cli/src/utils/detect-shell.ts
- cli/src/utils/open-url.ts
- cli/src/utils/terminal-title.ts
- cli/src/utils/fingerprint.ts
- cli/src/utils/logger.ts
- cli/src/commands/router.ts
- cli/src/commands/command-registry.ts
- cli/src/services/memory-v2/bun-sqlite-memory-repository.ts
- cli/src/services/memory-v2/contained-file-io.ts

### Domains
- performance
- state-mutation
- security
- dependency-hygiene
