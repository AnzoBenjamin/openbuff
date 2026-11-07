# Audit findings: cb-sdk-tools

- Subsystems: sdk
- Features: shell-command-policy, terminal-exec, background-jobs, job-tools, code-search, glob, git-tools, change-file, filesystem-authority, read-files-listing, concurrency, capability-tokens, browser-cdp, 3d-assets, language-diagnostics, file-change-hooks-validation, read-image
- Files covered: 28
- Snapshot: 49801b44e84d3d8fa583c3ebd9b2855228bf122572b7cdf5f78c77b3389d824d

## [HIGH] security — sdk/src/tools/terminal-command-policy.ts:733 — Shell command policy / parsing authority: HYBRID (CONSUME real bash parser in Rust; keep policy tables data-driven)
- **Risk:** Needs: exact bash grammar (quoting, heredocs, substitutions, compound commands, redirections) because it is a security boundary; determinism; must be the same authority the Rust sandbox shim enforces. Current: about 2450 lines of hand-rolled TS character scanners and regexes. scanActiveShellSyntax (733) is a quote/escape state machine, tokenizeTmuxShellWords (925) is a second tokenizer, splitReadOnlyShellSegments (1086) a third, findTraversalPath (1071) uses a regex tokenizer, hasShellInterpreterEscape (1067) only anchors at command start, WORKSPACE_DENY_PATTERNS (23-34) are line regexes, and wrapper unwrapping (advancePastEnvironmentDumpWrapper, about line 215) guesses option arity. Several independent approximations of bash lexing means they can disagree with each other and with the bash that run-terminal-command.ts:571-578 actually runs via `bash -c`. The language matters less than the missing AST: TS could host tree-sitter-bash through WASM, but it would still be a separate authority from a Rust landlock/seccomp shim, so the enforcement boundary stays split across two processes. This validates D40.
- **Fix:** Move the parse to Rust inside the sandbox shim/daemon, using tree-sitter-bash (tree-sitter crate) or the brush-parser / conch-parser crates. Alternative: Go with mvdan.cc/sh/v3 syntax, which is the most complete POSIX/bash parser, as a sidecar. Policy decisions become rules over an AST of commands, argv, redirections and substitutions. Profiles and deny tables live in shared data (TOML/JSON) that TS can still render in the UI. Unlocks now: one lexer instead of three; correct heredoc, `$(...)`, `<(...)` and compound handling; the decision and the enforcement (landlock path allowlist, seccomp) happen in the same process with no TOCTOU between check and exec; argv-level exec (execve of a parsed simple command instead of `bash -c`) for simple commands. Unlocks next: per-segment landlock rulesets, command provenance and audit logs, property/fuzz testing with cargo-fuzz against real bash, and reuse by the PTY host.
- **Evidence:** terminal-command-policy.ts:23-34 (regex deny list), 215-260 (wrapper arity heuristics), 733-766 (scanner), 925-960 (second tokenizer), 1067-1078 (interpreter escape and traversal regex), 1086 (segment splitter), 2092-2140 (entry point); run-terminal-command.ts:20-22,571-583 (policy then bash -c). Cost: L, about 3-5 engineer-weeks to port the rule surface plus a differential test corpus from the existing TS tests. Confidence: high that the parser should be consumed; medium on Rust vs Go (mvdan/sh is more complete, but the roadmap shim is Rust). Needs web verification: brush-parser/tree-sitter-bash coverage of heredocs and arithmetic; whether mvdan/sh can be embedded cheaply in a Rust shim (it would need cgo/ffi or a sidecar).

## [HIGH] security — sdk/src/tools/run-terminal-command.ts:578 — Terminal command execution / process spawning: MOVE→Rust (PTY host + sandbox shim)
- **Risk:** Needs: process groups, reliable tree kill, signals, PTY, cgroup/landlock/seccomp confinement applied before exec, env scrubbing, bounded output capture. Current: Node child_process.spawn('bash', ['-c', command], detached) at 578-583. Tree kill is process.kill(-pid) with a 5s SIGKILL timer (background-jobs.ts:45-74, run-terminal-command.ts:602-616), and there is no PTY. Node cannot apply landlock/seccomp/setrlimit/cgroup attach between fork and exec, has no PTY without native addons (node-pty), and has no job objects on Windows, so tree kill there is child.kill only (background-jobs.ts:69). This blocks the roadmap sandbox and PTY host. validateStagedCommit (37-66) also shells out to git three times synchronously.
- **Fix:** Rust exec host using the nix crate for setsid/killpg/prctl(PR_SET_PDEATHSIG), the landlock and seccompiler crates, the cgroups-rs crate (or systemd-run scopes), portable-pty for PTYs, and the windows crate for Job Objects and ConPTY. TS keeps orchestration and output formatting over a JSON-RPC or stdio protocol. Unlocks now: pre-exec confinement, guaranteed tree cleanup (cgroup.kill / Job Object), PDEATHSIG so children die with the CLI, interactive PTY commands. Unlocks next: per-command resource limits, network namespaces for dependency-mutation profiles, sharing one host with the daemon.
- **Evidence:** run-terminal-command.ts:37-66 (spawnSync git x3), 560-583 (bash -c, detached), 602-616 (SIGTERM, then SIGKILL after 5s); background-jobs.ts:45-74 (process-group kill, Windows falls back to the direct child). Cost: L (the shim is already planned; the incremental cost is protocol plus migrating the two spawn sites). Confidence: high. Verify: portable-pty ConPTY maturity; unprivileged cgroup v2 delegation availability on target distros.

## [MEDIUM] correctness — sdk/src/tools/background-jobs.ts:716 — Background job supervisor (spawn, log files, recovery, liveness): MOVE→Rust daemon
- **Risk:** Needs: survive CLI restarts, pid-reuse-safe liveness, log rotation and caps, O_EXCL/O_NOFOLLOW temp files, cross-session recovery. Current: 1460 lines of TS that re-implement a supervisor. Logs and metadata go to os.tmpdir with manual symlink and O_EXCL handling (701-715). Liveness comes from /proc starttime and only works on Linux (the BackgroundJob comment near 130). A 250ms polling drainer is used, and an orphan sweep runs on each start with a 24h TTL. All of this exists because the owning process is the short-lived CLI. A long-lived Rust daemon holding the child handles (pidfd on Linux, Job Objects on Windows) removes the recovery and pid-reuse problem class entirely.
- **Fix:** Rust daemon using tokio::process, pidfd (the pidfd crate or nix), and the notify crate or inotify for log tailing. Logs go in a daemon-owned 0700 state dir instead of shared /tmp. TS check_job, kill_job and list_jobs become thin RPC clients. The jobRegistry contract stays in TS as the event schema. Unlocks now: no /tmp symlink attack surface, exact exit codes after CLI restart, push-based output instead of 250ms polling. Unlocks next: jobs shared across sessions and agents, resumable PTY sessions, per-job cgroups for resource accounting.
- **Evidence:** background-jobs.ts:45-74, 160-200 (constants: 24h orphan TTL, 10MB log, 250ms monitor), 690-752 (symlink rejection, O_EXCL, spawn detached). Cost: M-L; it depends on the daemon existing. Confidence: medium-high. Verify: pidfd availability on the minimum supported kernel (5.3+).

## [LOW] correctness — sdk/src/tools/check-job.ts:1 — check_job / kill_job / job polling tools: KEEP (become RPC clients after daemon move)
- **Risk:** Needs: ownership gating, bounded accumulation, loop-breaker hints for the model. These are pure orchestration and presentation logic over jobRegistry. kill-job.ts gates ownership before killBackgroundJob (kill-job.ts:36-47). Nothing here is latency- or OS-bound.
- **Fix:** Keep in TS. After the background-jobs supervisor moves to the Rust daemon, swap the readNewJobOutput and killBackgroundJob imports for daemon RPC calls. The ownership check stays in TS or is mirrored in the daemon. Unlocks next: push notifications replace 200ms POLL_INTERVAL_MS.
- **Evidence:** check-job.ts:20-45 (limits, 200ms poll), 75-100 (hints); kill-job.ts:8-55. Cost: S. Confidence: high.

## [LOW] performance — sdk/src/tools/code-search.ts:233 — code_search: CONSUME ripgrep (already) — KEEP TS wrapper
- **Risk:** Needs: fast regex search, gitignore semantics, bounded output. The code already spawns the bundled rg with --json --no-config (code-search.ts:6,195-233) and allow-lists flags through parseSafeRipgrepFlags. The TS side does path containment and JSON-stream truncation, and none of that is hot. Moving the wrapper to Rust would only save the spawn cost (about ms per call).
- **Fix:** Keep. Optional later: when the Rust daemon exists, link the grep-searcher and ignore crates in-process to avoid per-call spawns and share one warmed ignore/walker cache with glob and list_directory. Also consider reading `ignore` output for glob (see the glob finding).
- **Evidence:** code-search.ts:6 (getBundledRgPath), 146-168 (flag allow-list), 185-200 (args), 233 (spawn). find-files-matching-content.ts:171 also spawns rg. Cost: none now; M later. Confidence: high.

## [MEDIUM] performance — sdk/src/tools/glob.ts:25 — glob file discovery: CONSUME ripgrep --files / Rust ignore+globset
- **Risk:** Needs: gitignore-correct walk and fast matching on large monorepos. Current: getProjectFileTree builds the whole project tree in JS, flattens it, runs micromatch over every path, then does fs.stat on every match with unbounded Promise.all fan-out (glob.ts:101-112). That is O(repo) memory on each call, and the unbounded concurrent stats contradict the concurrency.ts contract. rg --files -g <pattern> (already bundled) or the ignore and globset crates do this streaming with correct ignore semantics.
- **Fix:** Short term: call bundled `rg --files --no-config -g <pattern>` (plus --sortr=modified, or keep the TS mtime sort bounded through mapWithConcurrency). Long term: Rust daemon with the ignore::WalkParallel and globset crates, plus a persistent file index kept fresh by notify. Unlocks now: sub-second glob on 100k-file repos and no full-tree allocation. Unlocks next: a shared watched index for glob, code_search, list_directory and the affected-test graph.
- **Evidence:** glob.ts:25-30 (full tree plus flatten), 66-98 (micromatch), 101-112 (unbounded Promise.all stat). Cost: S (rg) / M (daemon index). Confidence: medium-high. Verify: rg --files glob semantics vs micromatch for patterns like `**/*.{ts,tsx}` and negations, to avoid behavior drift.

## [MEDIUM] dependency-hygiene — sdk/src/tools/git-status.ts:9 — git status/diff/branch/dirty-path tracking: HYBRID (keep git CLI for writes; CONSUME gix for read-only status in daemon)
- **Risk:** Needs: porcelain correctness, rename handling, low latency for the frequent dirty-path snapshots taken before and after every command (run-terminal-command.ts listDirtyPaths, check_job settlement). Current: a git child process on each call, parsing `--porcelain` with line.slice(3).split(' -> '), which breaks on quoted and escaped paths because -z is not used (run-terminal-command.ts:185-190). Output is buffered without bounds before truncation (git-status.ts:56-63). The git CLI is the most correct option for mutations (checkout -b). gix status is fast in-process but its worktree status coverage is still maturing.
- **Fix:** Now, in TS: use `git status --porcelain=v2 -z` and bound the stdout buffer. Later, in the Rust daemon: gix (gitoxide) for index/HEAD/status reads and change-review snapshot ids, plus notify-driven dirty tracking that avoids spawning git before and after each command. Keep the git CLI for branch, commit and push. Unlocks now: correct paths with spaces, quotes and unicode. Unlocks next: cheap per-command touched-path attribution and a watched workspace revision.
- **Evidence:** git-status.ts:9-91 (spawn and unbounded concat), 105-117; git-branch.ts:81-91 (checkout -b through the CLI; fine to keep); run-terminal-command.ts:177-196 (non -z porcelain parse), 37-66 (spawnSync diff). Cost: S (the -z fix) / M (gix). Confidence: medium. Verify: gix status parity (untracked, submodules, sparse checkout) as of the current release.

## [LOW] correctness — sdk/src/tools/change-file.ts:1 — change_file / transactional multi-file edits + patch apply: KEEP (atomic CAS primitive → Rust broker later)
- **Risk:** Needs: content-hash CAS, rollback, bounded memory, patch application. Most of the logic is transaction bookkeeping and result schemas tightly bound to the common TS types, so TS fits. The weak point is atomicity: node-filesystem.ts:92-95 admits that Node cannot do an atomic compare-and-replace, so conditionalCommit exists only when a WorkspaceMutationBroker is injected. The `diff` npm applyPatch is adequate for this job.
- **Fix:** Keep the orchestration in TS. Implement the WorkspaceMutationBroker primitives (conditionalCommit, conditionalDelete, conditionalMove, createExclusive) in the Rust daemon: openat2(RESOLVE_BENEATH|RESOLVE_NO_SYMLINKS), flock or OFD locks, write-temp plus renameat2(RENAME_NOREPLACE/EXCHANGE), and fsync. Unlocks now: real CAS and symlink-race-free containment. Unlocks next: cross-process edit locking between concurrent agents, and landlock-aligned write roots.
- **Evidence:** change-file.ts:1-40 (imports: diff applyPatch, filesystem-authority), 105-120; node-filesystem.ts:25-59 (broker-only CAS), 92-95 (comment on the missing atomic CAS). Cost: M for the broker. Confidence: medium-high. Verify: renameat2/openat2 availability (Linux 5.6+) and macOS equivalents (renamex_np RENAME_EXCL).

## [MEDIUM] security — sdk/src/tools/filesystem-authority.ts:272 — FilesystemAuthority / path containment (path-utils, read-policy): HYBRID → enforcement in Rust (openat2/landlock), policy in TS
- **Risk:** Needs: symlink-race-free containment, consistent with the sandbox's view. Current: lexical plus realpath checks in TS (path-utils.ts, and common project-path-containment re-exported at path-utils.ts:46-51) followed by a separate open. That is inherently TOCTOU because a symlink can be swapped between realpath and open. FilesystemAuthority (272-912) adds in-process path locks and receipts, which do not protect against other processes. read-policy.ts is a simple sensitive-path and filter predicate, which is fine in TS.
- **Fix:** Keep the policy vocabulary (scopes, sensitive paths, receipts) in TS so it can be shown to the model and UI. Perform the actual open and commit in Rust with openat2 RESOLVE_BENEATH (cap-std crate) against a root dirfd, and make the same allowlist the landlock ruleset. Unlocks now: race-free containment, and read_files/list_directory/read_image can't be tricked by symlink swaps. Unlocks next: one policy source compiled into both TS checks and kernel enforcement.
- **Evidence:** filesystem-authority.ts:272-912 (class, withPathLocks 580, acquireLock 886, in-process only), 914-950 (capability detection); path-utils.ts:21-34 (lexical checks), 46-51 (re-exports); read-policy.ts:5-18. Cost: M. Confidence: medium, because filesystem-authority was reviewed by outline only. Verify: cap-std coverage on Windows/macOS.

## [LOW] performance — sdk/src/tools/read-files.ts:43 — read_files / list_directory / bounded-readdir / node-filesystem range reads: KEEP
- **Risk:** Needs: bounded memory, line-range windows, encoding detection, capability tokens. The code already streams (node-filesystem.ts readNodeTextRange, bounded-readdir.ts opendir capped at N+1) and bounds fan-out (READ_SNAPSHOT_CONCURRENCY=8 through concurrency.ts). Performance is I/O-bound, and the heavy value is schema and capability logic shared with common TS.
- **Fix:** Keep. Once the Rust broker exists, route opens through its RESOLVE_BENEATH dirfd (see the filesystem-authority finding). Optional later: mmap plus memchr line indexing in Rust for >10MB files if range reads become hot.
- **Evidence:** read-files.ts:43-60 (limits); list-directory.ts:34-50; bounded-readdir.ts:47-64; node-filesystem.ts:60-70,97-120. Cost: none. Confidence: high.

## [LOW] correctness — sdk/src/tools/concurrency.ts:38 — mapWithConcurrency / abort helpers: KEEP
- **Risk:** A pure async utility with a well-specified failure contract. It is idiomatic in TS and has no OS or perf needs.
- **Fix:** Keep. Apply it to glob.ts's unbounded stat fan-out.
- **Evidence:** concurrency.ts:11-76. Cost: none. Confidence: high.

## [LOW] correctness — sdk/src/tools/mutation-capabilities.ts:26 — Read/mutation capability token minting: KEEP
- **Risk:** Pure hashing and token encoding tied to common/util/content-hash, used by the model-facing protocol. No latency or OS needs. If the Rust broker must verify tokens, the format has to be specified, not reimplemented ad hoc.
- **Fix:** Keep in TS. If the daemon needs to verify tokens, specify the token format (HMAC/sha256 fields) as a versioned spec with golden vectors shared by both languages.
- **Evidence:** mutation-capabilities.ts:26-93. Cost: none. Confidence: high.

## [LOW] dependency-hygiene — sdk/src/tools/browser-logs.ts:934 — Browser automation (Chrome launch, CDP pipe transport, screenshots, APNG): KEEP TS; CONSUME for image ops
- **Risk:** Needs: CDP over --remote-debugging-pipe (fd3/fd4), which is secure and already implemented (cdp-pipe-transport.ts:1-60), plus event routing and JS evaluation. CDP is JSON-over-pipe and JS-native, and TS has the best ecosystem (chrome-remote-interface, Playwright's protocol types). Moving it to Rust (chromiumoxide) gains little. The weak part is a hand-rolled image stack of about 3300 lines: pngjs, pixelDiff, cropPngData, a custom APNG encoder with its own crc32 table (buildApng, makeCrcTable in the outline). That work is CPU-bound in JS.
- **Fix:** Keep the CDP session logic in TS, optionally adopting devtools-protocol typings. CONSUME for images: sharp (libvips) in TS, or the image, png and apng crates in the Rust daemon for crop, diff and APNG. Alternatively, let Chrome do the cropping (Page.captureScreenshot clip) and use pixelmatch for diffs. Later: run Chrome under the Rust sandbox shim (landlock, its own cgroup) instead of relying on chromeSandboxArgs. Unlocks now: faster diffs and less custom code. Unlocks next: sandboxed browser sessions with killable cgroups.
- **Evidence:** browser-logs.ts:6,8 (pngjs, ws imports), 930-960 (pipe probe spawn), 1129 (ws fallback), 1171-1230 (pipe/port spawns); outline: pixelDiff, cropPngData, buildApng, crc32; cdp-pipe-transport.ts:1-60. Cost: S (consume image libs) / M (sandboxed Chrome). Confidence: medium. Verify: that sharp is Bun-compatible for distribution (native addon), otherwise prefer the Rust route.

## [LOW] dependency-hygiene — sdk/src/tools/3d-assets.ts:296 — 3D asset inspect/render/edit: KEEP TS orchestration; CONSUME gltf parser
- **Risk:** Rendering and editing already CONSUME Blender through a subprocess (spawn('blender', ['--disable-autoexec', ...]), 296), which is correct. The TS side hand-parses GLB and OBJ (parseGlb, summarizeObj, collectGltfUris), which is small but security-relevant for untrusted binary input. It has no perf need.
- **Fix:** Keep. Optionally replace hand parsing with @gltf-transform/core (TS) or the gltf crate if moved to the daemon. Run Blender under the sandbox shim later, because Blender Python is arbitrary code even with --disable-autoexec for scripts invoked explicitly.
- **Evidence:** 3d-assets.ts:286-310 (runBlender), outline parseGlb/summarizeObj/readContainedAsset. Cost: S. Confidence: medium. Verify: gltf-transform Bun compatibility.

## [LOW] correctness — sdk/src/tools/language-diagnostics.ts:70 — Compiler/linter diagnostic parsing (tsc, cargo JSON, SARIF, etc.): KEEP
- **Risk:** Text and JSON parsing of tool output into LSP-like diagnostics. The work is bounded (MAX_DIAGNOSTICS=200), not hot, and the types are shared with TS consumers. SARIF and cargo JSON are handled structurally.
- **Fix:** Keep. Later: prefer native structured outputs (tsc has no JSON, so an LSP client via vscode-languageserver-protocol may be better) over regex scraping. The language choice is not the constraint.
- **Evidence:** language-diagnostics.ts:1-120 (types, severity, normalizeFile); outline lists the SARIF/cargo parsers. Cost: none. Confidence: high.

## [LOW] correctness — sdk/src/tools/file-change-hooks.ts:31 — File-change hook inference + execution (run_targeted_validation, affected tests, build targets): KEEP
- **Risk:** This is manifest sniffing (package.json, Cargo.toml, pyproject, gradle, etc.) and command construction, and it runs through runTerminalCommand, so it inherits whatever sandbox that path gets. get-affected-tests.ts and get-build-targets.ts are thin wrappers over services/harness-intelligence (not in this shard). run-targeted-validation.ts is snapshot-attestation orchestration. None of this is perf- or OS-bound.
- **Fix:** Keep in TS. Its security posture improves automatically when runTerminalCommand moves onto the Rust exec host. Later, a dependency graph for affected tests could come from the daemon's watched file index plus tree-sitter import extraction (Rust), which is a harness-intelligence concern.
- **Evidence:** file-change-hooks.ts:1-120 (constants, KNOWN_PROJECT_PATHS, runTerminalCommand import at 11); run-targeted-validation.ts:32-120; get-affected-tests.ts:1-10; get-build-targets.ts:1-8. Cost: none. Confidence: high.

## [LOW] performance — sdk/src/tools/read-image.ts:31 — read_image attachment: KEEP
- **Risk:** Reads bounded image bytes (25MB total cap) with containment checks and sends base64. There is no decoding or transcoding, so no native library is needed. If downscaling for token cost is added later, that becomes a CONSUME case.
- **Fix:** Keep. If resizing is added, CONSUME sharp or the Rust image crate (in the daemon) rather than implementing it in JS.
- **Evidence:** read-image.ts:21 (cap), 31-120. Cost: none. Confidence: high.

## Coverage receipt

### Subsystems
- sdk

### Features
- shell-command-policy
- terminal-exec
- background-jobs
- job-tools
- code-search
- glob
- git-tools
- change-file
- filesystem-authority
- read-files-listing
- concurrency
- capability-tokens
- browser-cdp
- 3d-assets
- language-diagnostics
- file-change-hooks-validation
- read-image

### Files
- sdk/src/tools/terminal-command-policy.ts
- sdk/src/tools/run-terminal-command.ts
- sdk/src/tools/code-search.ts
- sdk/src/tools/background-jobs.ts
- sdk/src/tools/concurrency.ts
- sdk/src/tools/read-policy.ts
- sdk/src/tools/kill-job.ts
- sdk/src/tools/git-status.ts
- sdk/src/tools/git-branch.ts
- sdk/src/tools/glob.ts
- sdk/src/tools/bounded-readdir.ts
- sdk/src/tools/mutation-capabilities.ts
- sdk/src/tools/browser-logs.ts
- sdk/src/tools/cdp-pipe-transport.ts
- sdk/src/tools/3d-assets.ts
- sdk/src/tools/filesystem-authority.ts
- sdk/src/tools/change-file.ts
- sdk/src/tools/read-files.ts
- sdk/src/tools/list-directory.ts
- sdk/src/tools/file-change-hooks.ts
- sdk/src/tools/language-diagnostics.ts
- sdk/src/tools/get-affected-tests.ts
- sdk/src/tools/get-build-targets.ts
- sdk/src/tools/run-targeted-validation.ts
- sdk/src/tools/check-job.ts
- sdk/src/tools/read-image.ts
- sdk/src/tools/node-filesystem.ts
- sdk/src/tools/path-utils.ts

### Domains
- performance
- security
- dependency-hygiene
- correctness
