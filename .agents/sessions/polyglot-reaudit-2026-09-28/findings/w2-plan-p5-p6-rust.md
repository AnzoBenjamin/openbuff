# Audit findings: w2-plan-p5-p6-rust

- Subsystems: .agents, rust, sdk, packages, .github
- Features: P5-T1, P5-T2, P5-T3, P5-T4, P5-T5, P5-T6, P5-T7, P6-T1, P6-T2, P6-T3, P6-T4, P6-T5, P6-T6, P6-T6a, P6-T7, P6-T8, P6-T9, X-3b
- Files covered: 17
- Snapshot: 49801b44e84d3d8fa583c3ebd9b2855228bf122572b7cdf5f78c77b3389d824d

## [HIGH] security — .agents/sessions/polyglot-roadmap-v2/PLAN.md — [LANG] P5-T1: Landlock ABI probe omits v5/v6 scopes (abstract unix sockets, signals, ioctl) — escape via host abstract sockets
- **Risk:** P5-T1 probes only FS (v1), REFER (v2) and TCP (v4). A Landlock+seccomp child can still connect() to host abstract unix sockets (D-Bus session bus, X11 @/tmp/.X11-unix, ssh-agent/gpg-agent when abstract) and signal processes outside the sandbox. It can also ioctl devices unless ABI v5 LANDLOCK_ACCESS_FS_IOCTL_DEV is handled. Any of these reaches host code execution outside the profile, and the tier would still say 'parse+landlock'.
- **Fix:** Use the `landlock` crate (rust-landlock, maintained by the Landlock author) in CompatLevel::BestEffort. Probe up to ABI v6: LANDLOCK_SCOPE_ABSTRACT_UNIX_SOCKET and LANDLOCK_SCOPE_SIGNAL on kernel ≥6.12, IOCTL_DEV at v5. When v6 is missing, add seccompiler rules that deny connect() on AF_UNIX abstract addresses where feasible, or deny socket(AF_UNIX) in read-only profiles. Report each missing scope in the X-4 tier string, e.g. 'landlock-v4 (no unix-scope)'.
- **Evidence:** PLAN P5-T1: 'Probe the Landlock ABI at runtime (FS >=5.13, REFER >=5.19, TCP >=6.7)'. SPEC D4 lists the same three ABIs. No scoping or ioctl ABI is mentioned anywhere.

## [HIGH] security — .agents/sessions/polyglot-roadmap-v2/SPEC.md — [LANG] P5-T1: 'fall back to netns for network' fails on Ubuntu ≥23.10 / hardened distros where unprivileged userns is restricted
- **Risk:** An unprivileged netns needs CLONE_NEWUSER. On Ubuntu 23.10+ kernel.apparmor_restrict_unprivileged_userns=1 blocks this, and Debian/RHEL hardening sysctls do the same. Kernels below 6.7 (no Landlock TCP) are exactly the older distros where userns is also often off, so on those hosts the network fallback quietly becomes no network enforcement.
- **Fix:** Order the network tiers as: (1) Landlock TCP v4 bind/connect, restricted to the egress-proxy port on loopback; (2) seccomp filter on socket(AF_INET/AF_INET6) plus a connect allowlist to the proxy UDS (Codex's linux-sandbox approach); (3) netns only when a userns probe succeeds. Record 'network: unenforced' as a separate X-4 field so the shim can refuse if the profile requires it. Add a CI leg on ubuntu-24.04 with the AppArmor userns restriction enabled.
- **Evidence:** SPEC D4: 'probe the ABI at runtime and fall back to netns for network'. Nothing in the plan probes for userns availability.

## [MEDIUM] security — .agents/sessions/polyglot-roadmap-v2/PLAN.md — [LANG] P5-T1: D10 parse gate — use native tree-sitter-bash sharing the P4-T8 .scm policy queries, and exec argv plans without bash
- **Risk:** Porting the 2451-line regex policy 'profile-by-profile' into Rust would produce a second hand-written lexer, repeating the dual-mirror drift the X-3b charter forbids. A parser that differs from real bash in how it reads the input (brush-parser, conch-parser, which is unmaintained, or any custom lexer) is itself an escape vector.
- **Fix:** (1) The TS pre-check (P4-T8, web-tree-sitter) and the shim (native `tree-sitter` + `tree-sitter-bash` crates) evaluate the SAME .scm policy queries compiled from one source. The TS tier and the enforcement tier then differ only in runtime, with a single rule source. (2) Refuse any tree containing ERROR/MISSING nodes, expansions, or compound commands outside the profile allowlist. (3) For 'structured argv plan' commands, the shim calls execve(argv) directly with no bash, so no differential between the shim's parse and bash's parse remains. Only 'full-access' and 'workspace-write' shell forms reach bash, and they are bounded by Landlock, not by parsing. mvdan/sh (Go) is the most faithful parser but would bring a Go toolchain into the shim; use it only as a CI differential oracle, next to `bash -n`. Keep the parser advisory; the OS layer is the boundary.
- **Evidence:** terminal-command-policy.ts implements its own lexers: tokenizeTmuxShellWords, splitReadOnlyShellSegments, extractSubstitutionsAndRemainder, scanActiveShellSyntax, quotedContentRanges. PLAN P5-T1: 'port evaluateTerminalCommandPolicy profile-by-profile into the shim's parse gate'. run-terminal-command.ts always spawns bash -c.

## [MEDIUM] security — .agents/sessions/polyglot-roadmap-v2/SPEC.md — [LANG] P5-T1: Windows AppContainer breaks most native toolchains; use restricted token + low integrity + Job Object
- **Risk:** AppContainer processes lose access to the user profile, registry hives and most of %USERPROFILE%. That breaks cargo (%USERPROFILE%\.cargo), MSBuild/NuGet, Go, Gradle and pip, and forces broad ACL rewrites that are hard to reverse.
- **Fix:** Through windows-rs: CreateRestrictedToken with deny-only SIDs, a Low integrity level plus explicit ACEs on the workspace, and a Job Object (KILL_ON_JOB_CLOSE, ACTIVE_PROCESS_LIMIT, JOB_OBJECT_LIMIT_PROCESS_MEMORY). This is the direction Codex's Windows sandbox took. Keep AppContainer only for the P5-T7 browser tier. Network on Windows: a WFP filter by AppContainer SID or restricted-token SID, or proxy-only env. macOS: confirm Seatbelt SBPL via sandbox-exec (Endpoint Security needs an Apple entitlement; Virtualization.framework belongs to P10-T1).
- **Evidence:** SPEC D4: 'Windows uses AppContainer + Job Objects'. run-terminal-command.ts runs Git Bash or WSL bash on Windows, and those also need profile/registry access.

## [HIGH] correctness — sdk/src/tools/terminal-command-policy.ts — [POLY] P5-T1: sandbox profiles do not model toolchain homes (~/.cargo, ~/.rustup, ~/go, ~/.m2, ~/.gradle, venvs, /nix/store)
- **Risk:** The current policy denies every `~/…` / `$HOME/…` operand and every absolute path outside the project, except temp dirs, /bin and /usr/bin. It exempts neither /usr/local, /opt, /nix/store nor toolchain caches. A Landlock profile ported from this model makes cargo, go, mvn, gradle, pip/uv, rustup proxies, nix-shell and pyenv shims fail with EACCES on their caches and toolchains. The result is either a sandbox that is useless for non-JS repos, or users switching to full-access.
- **Fix:** Derive the per-profile read (RX) and write roots from the D16 language-capabilities manifest, resolving the env vars first: CARGO_HOME, RUSTUP_HOME, GOPATH/GOMODCACHE/GOCACHE, GRADLE_USER_HOME, MAVEN_OPTS/maven.repo.local, PIP_CACHE_DIR, UV_CACHE_DIR, VIRTUAL_ENV/CONDA_PREFIX, PYENV_ROOT, NVM_DIR/BUN_INSTALL, DOTNET/NUGET_PACKAGES, SDKMAN_DIR, /nix/store (read-only), /opt, /usr/local. Caches get write access only in the dependency-mutation and workspace-write profiles; toolchains are read+exec everywhere. The shim takes these roots as a structured list, and X-4 reports which roots were granted.
- **Evidence:** findOutsideAbsolutePath returns true for any `~/` or `$HOME/` token and exempts only /dev/null, /bin/, /usr/bin/ and isOwnedTempScope. DEPENDENCY_MUTATION_COMMANDS already covers cargo/go/uv/poetry/pip/mvn/gradle/dotnet/composer/swift/mix, so these ecosystems are expected callers.

## [MEDIUM] correctness — .agents/sessions/polyglot-roadmap-v2/PLAN.md — [LANG] P5-T2: jobd — pidfd + subreaper via rustix; cgroup v2 via systemd transient scope (zbus), not raw cgroups-rs; ship as a library inside openbuffd
- **Risk:** Unprivileged processes cannot create cgroups unless systemd has delegated a subtree. cgroups-rs writing to /sys/fs/cgroup therefore fails for normal users, and mem/cpu/pids caps would silently not apply. The plan also ships jobd both as a standalone binary with its own socket (P5-T2) and as absorbed into P6-T5, which doubles the IPC surface.
- **Fix:** Linux: call StartTransientUnit(scope, Delegate=yes) over D-Bus with `zbus` to get a delegated cgroup v2 subtree. Fall back to an existing delegated subtree, and otherwise to prlimit/RLIMIT_AS with tier 'limits: rlimit-only'. Use pidfd_open/pidfd_send_signal and PR_SET_CHILD_SUBREAPER through `rustix`, which is lighter and safer than `nix` and covers pidfd. pidfd removes the /proc starttime pid-reuse heuristic entirely. macOS: kqueue EVFILT_PROC plus process groups. Windows: Job Objects with KILL_ON_JOB_CLOSE. Build it as the `jobd` library crate linked into openbuffd and into the shim (the shim is the direct parent), exposed only through the daemon's single JSON-RPC socket.
- **Evidence:** background-jobs.ts uses process.kill(-pid), a /proc/<pid>/stat field-22 starttime guard, and 5 s SIGKILL escalation timers, all of which pidfd makes unnecessary. PLAN Dependencies: 'P5-T2 is absorbed into P6-T5'.

## [HIGH] security — .agents/sessions/polyglot-roadmap-v2/PLAN.md — [LANG] P5-T3: egress = empty netns / Landlock-TCP + UDS-bridged proxy built on hudsucker; placeholder-token secret broker; CONNECT passthrough by default
- **Risk:** Writing a MITM proxy by hand on hyper/rustls/rcgen duplicates hudsucker. MITM-ing every destination breaks toolchains that pin certificates, and requires injecting a CA into every ecosystem's trust store. slirp4netns/pasta add external binaries and userns requirements.
- **Fix:** Base the proxy on `hudsucker` (hyper + rustls + rcgen). Default to CONNECT passthrough with an SNI/host allowlist. MITM only the destinations where the broker injects credentials. Children see placeholder env values (e.g. OPENBUFF_SECRET_<id>) that the proxy swaps into Authorization headers for the matching host, so raw keys never enter the sandbox. Enforcement: the child is in an empty netns (loopback only) with a small in-shim TCP-to-UDS forwarder to the host proxy, the model Anthropic's sandbox-runtime and Codex use. Without userns, use Landlock TCP connect restricted to the proxy port. macOS: SBPL `(allow network-outbound (remote tcp "localhost:PORT"))` only. Write the audit log as JSONL into the P2-T2 journal.
- **Evidence:** PLAN P5-T3: 'lang Rust (hyper/rustls/rcgen)', 'egress allowlist enforced via netns'. P0-T1 already strips BYOK vars (SB2-F1 residual: generic OPENAI/ANTHROPIC keys still pass).

## [HIGH] correctness — .agents/sessions/polyglot-roadmap-v2/PLAN.md — [POLY] P5-T3: egress allowlist and proxy/CA plumbing must cover every ecosystem's registry and trust store
- **Risk:** The JVM (Maven/Gradle) ignores HTTPS_PROXY and uses its own cacerts. Python requests/pip use certifi; Node uses NODE_EXTRA_CA_CERTS; cargo uses CARGO_HTTP_CAINFO or http.proxy; git uses GIT_SSL_CAINFO; Go honors HTTPS_PROXY and SSL_CERT_FILE. A proxy that only works for npm makes dependency-mutation fail for cargo, go, pip, mvn and gradle.
- **Fix:** Publish a per-ecosystem egress manifest in the D16 registry: default registries (crates.io/static.crates.io/index.crates.io, proxy.golang.org/sum.golang.org, pypi.org/files.pythonhosted.org, repo1.maven.org/plugins.gradle.org/services.gradle.org, registry.npmjs.org, nuget.org, rubygems.org, packagist.org) plus proxy injection per tool: JAVA_TOOL_OPTIONS=-Dhttps.proxyHost/-Djavax.net.ssl.trustStore, GRADLE_OPTS, CARGO_HTTP_PROXY/CAINFO, PIP_CERT/REQUESTS_CA_BUNDLE/SSL_CERT_FILE, NODE_EXTRA_CA_CERTS, GIT_SSL_CAINFO. With CONNECT passthrough as the default, most of these need proxy variables only and no CA.
- **Evidence:** DEPENDENCY_MUTATION_COMMANDS lists 17 ecosystem command families. The P5-T3 text names no registries or trust-store mechanics.

## [MEDIUM] correctness — .agents/sessions/polyglot-roadmap-v2/PLAN.md — [LANG] P5-T4: portable-pty confirmed; use alacritty_terminal (not vt100) as the screen model; the PTY child must run under the shim
- **Risk:** The vt100 crate has thinner coverage of modern sequences (alternate-screen edge cases, wide chars, DECSET modes, OSC 8) than alacritty_terminal. Zed uses alacritty_terminal for its terminal, which shows it holds up for agent-driven screen assertions. A PTY host that spawns outside the shim bypasses P5-T1.
- **Fix:** Use `portable-pty` for spawn (ConPTY on Windows) and `alacritty_terminal` (Term + vte parser) for the grid and screen assertions. Detect awaiting-input with tcgetpgrp on the master compared with the child pgid, plus a read-blocked check on the tty (Linux /proc/<pid>/wchan or syscall), rather than prompt regexes. Write asciinema v2 casts directly as JSONL. Spawn through the shim/jobd so PTY sessions inherit Landlock and cgroup limits.
- **Evidence:** PLAN P5-T4: 'portable-pty + vt100/alacritty_terminal', 'awaiting-input detection via the foreground pgrp'. It does not say that PTY sessions are sandboxed.

## [LOW] correctness — .agents/sessions/polyglot-roadmap-v2/PLAN.md — [POLY] P5-T4: prompt detection must stay language-agnostic (python/irb/ghci/node/sbt/gradle REPLs, pip/cargo interactive prompts)
- **Risk:** Regex prompt detection tuned to bash/node misses REPLs and tool prompts in other ecosystems (sbt, ghci, iex, gradle --continuous, cargo login, pip keyring).
- **Fix:** Make the foreground-pgrp plus read-blocked signal the primary detector. Treat prompt regexes only as per-language hints from the D16 registry.
- **Evidence:** PLAN P5-T4: 'SYNC commands go PTY-backed with prompt detection'.

## [MEDIUM] dependency-hygiene — .agents/sessions/polyglot-roadmap-v2/PLAN.md — [LANG] P5-T5: keep gitleaks TOML as the rule authority, but do not add a Go sidecar — run commit gating on the same TOML in Rust, and treat TruffleHog (AGPL-3.0) as user-installed only
- **Risk:** A Go sidecar adds a whole toolchain and build matrix to CI just for commit gating. The gitleaks rules are RE2 syntax, which the Rust `regex` crate accepts almost verbatim; the JS codegen still needs translation ((?i) inline flags, (?P<name>) groups). TruffleHog is AGPL-3.0, which the plan does not note, unlike mergiraf's GPL.
- **Fix:** (1) Vendor the gitleaks config TOML with a pinned version and checksum. (2) Put a Rust scanner in openbuffd/shim built on `regex` + `aho-corasick` keyword prefilter (the gitleaks 'keywords' field) + entropy, for commit gating and bulk scans. noseyparker (Rust, Apache-2.0, vectorscan) is the best-performing alternative; ripsecrets is too small a corpus. If a user-installed gitleaks binary exists, use it as the preferred engine. (3) The TS codegen translates the RE2 constructs and fails CI on any rule it cannot compile in JS. Golden vectors pin that [REDACTED] and pass-through behaviour are identical across TS and Rust. (4) TruffleHog verification is opt-in and user-installed, per the D3 precedent.
- **Evidence:** redact-secrets.ts TOKEN_SHAPES has 5 regexes plus SENSITIVE_KEYWORD. validateStagedCommit uses a single SENSITIVE_STAGED_CONTENT regex (PEM and AKIA only). SPEC D15 and principle 4 give Go for gitleaks.

## [MEDIUM] security — sdk/src/tools/run-terminal-command.ts — [POLY] P5-T5: staged-path gate omits non-JS credential files (.pypirc, .cargo/credentials.toml, settings.xml, gradle.properties, .netrc, .npmrc, .docker/config.json)
- **Risk:** The commit gate blocks .env/id_rsa/credentials/pem/p12/pfx files but lets through ecosystem credential stores that routinely hold registry tokens.
- **Fix:** Take sensitive staged paths from the same gitleaks-derived/D16 manifest: .pypirc, pip.conf, .cargo/credentials(.toml), .m2/settings.xml, gradle.properties, .npmrc/.yarnrc.yml, .netrc, .docker/config.json, .gem/credentials, nuget.config, composer auth.json, terraform .tfvars, kubeconfig.
- **Evidence:** SENSITIVE_STAGED_PATH = /(^|\/)(\.env($|\.)|id_rsa|id_ed25519|credentials(?:\.(?:json|ya?ml))?|.*\.(?:pem|p12|pfx))$/i

## [MEDIUM] dependency-hygiene — .agents/sessions/polyglot-roadmap-v2/PLAN.md — [LANG] P5-T6: TS + shim confirmed; the lockfile needs per-ecosystem integrity pins (npm sha512, uv/PyPI hashes, OCI digests, binary sha256) [POLY]
- **Risk:** MCP servers are launched through npx, uvx/pipx, docker, go install and plain binaries. A lockfile holding only name@version cannot verify uvx/docker/binary servers, and those are the most common non-JS MCP servers.
- **Fix:** Use a lock entry schema of {launcher: npx|uvx|docker|binary|cargo, resolved, integrity}. Integrity is npm dist.integrity, uv.lock hashes (`uvx --from pkg==v` with --require-hashes), an OCI image digest (@sha256), or a sha256 for downloaded binaries. The shim profile per server comes from its capability grants (fs roots, egress hosts).
- **Evidence:** PLAN P5-T6: 'pinned versions, checksums, capability grants'. It specifies no ecosystem launchers.

## [MEDIUM] security — .agents/sessions/polyglot-roadmap-v2/PLAN.md — [LANG] P5-T7: Chromium inside the shim conflicts with Chrome's own namespace sandbox; use a dedicated browser profile plus --proxy-server and CDP Fetch as defense in depth
- **Risk:** Chrome's sandbox needs clone(CLONE_NEWUSER/NEWPID/NEWNET) and its own seccomp-bpf. A shim seccomp filter that denies unshare/clone namespaces forces --no-sandbox, which undoes P0-T4. An empty netns without the proxy wiring breaks navigation.
- **Fix:** Give the browser its own shim profile: allow nested userns for Chrome's sandbox, Landlock FS limited to the profile dir, network only to the egress proxy via --proxy-server=http://127.0.0.1:PORT, with the P5-T3 host allowlist as the enforcement point. Add CDP Fetch.requestPaused interception on the existing pipe transport as a second allowlist layer that reports blocked hosts. On Windows, this is the case for AppContainer.
- **Evidence:** P0-T4 chromeSandboxArgs() gates --no-sandbox on userns availability, and cdp-pipe-transport.ts exists (PLAN P0-T4).

## [LOW] api-contract — .agents/sessions/polyglot-roadmap-v2/PLAN.md — [LANG] P6-T1: confirmed
- **Risk:** None. laneId as a versioned X-1 addition in TS is correct: it is a contract change and belongs with the Zod/golden-vector pipeline (D17).
- **Fix:** Proceed as planned. Also add laneId to the D16 manifest handshake so the lanes sidecar can negotiate it.
- **Evidence:** SPEC principle 5: 'The laneId and protocol additions are v2 schemas.'

## [MEDIUM] state-mutation — .agents/sessions/polyglot-roadmap-v2/PLAN.md — [LANG] P6-T2: create lanes with the git CLI (`git worktree add`) plus the reflink-copy crate; use gix only for read-side trees/status; overlayfs only as an optional tier
- **Risk:** gix does not fully implement worktree add: submodules, LFS smudge filters, hooks, sparse-checkout and .gitattributes filters are partial. In-memory gix trees give tests no filesystem to run in. overlayfs needs privilege, or userns on kernel ≥5.11, and whiteouts complicate land. Rolling a custom COW layer risks silent divergence from git semantics.
- **Fix:** A lane = `git worktree add --detach <dir> <base>`, which covers LFS, submodules, sparse and filters. Untracked build state is then seeded with `reflink-copy` (FICLONE on btrfs/xfs/bcachefs, APFS clonefile, ReFS block clone), falling back to hardlink or copy. Use gix for fast status, diff and tree-writing (land via merge-tree). fuse-overlayfs/overlayfs is an opt-in tier. Report 'lanes: reflink|copy' through X-4.
- **Evidence:** PLAN P6-T2: 'per-agent COW workspaces via gix in-memory trees, git worktree, and reflink/clonefile/overlayfs'.

## [HIGH] correctness — .agents/sessions/polyglot-roadmap-v2/PLAN.md — [POLY] P6-T2: lanes ignore per-language build dirs — .venv, CMake and bazel state is not relocatable; target/ and node_modules are huge
- **Risk:** Copying or reflinking a .venv breaks it, because shebangs and pyvenv.cfg embed absolute paths. CMakeCache.txt and compile_commands.json embed the source path. Bazel output_base is keyed by workspace path, so every lane builds cold. cargo target/ runs to multiple GB and is locked per dir. Gradle project .gradle/ and daemons collide. Per-lane tests would then be wrong or very slow for non-JS repos.
- **Fix:** Add per-ecosystem lane seeding to the D16 registry. node_modules: reflink, or pnpm/bun store hardlinks. .venv: recreate with `uv sync --frozen` (fast, cache-backed), never copy. cargo: per-lane CARGO_TARGET_DIR seeded by reflink, with optional sccache. go: the global module/build cache is shared read-mostly. gradle/maven: shared ~/.gradle and ~/.m2, per-lane build/, --project-cache-dir per lane. CMake: reconfigure into a fresh build dir. bazel: --output_base per lane, plus a shared --disk_cache/--repository_cache. Record the strategy chosen per lane in its receipt.
- **Evidence:** PLAN P6-T2 says only 'Tests run per lane'. Nothing in P6 mentions target/, .venv, build/ or bazel.

## [LOW] correctness — .agents/sessions/polyglot-roadmap-v2/PLAN.md — [LANG] P6-T3: confirmed
- **Risk:** None. Orchestration in TS plus `git merge-tree --write-tree` is the right choice: it computes the merge without touching the worktree.
- **Fix:** Probe git ≥2.38 and report it through X-4. Use --write-tree -z --name-only for structured conflicts. Give each lane its own netns or port range so parallel test servers do not collide.
- **Evidence:** PLAN P6-T3: 'land_lane tool lands via git merge-tree --write-tree with structured conflicts'.

## [LOW] dependency-hygiene — .agents/sessions/polyglot-roadmap-v2/SPEC.md — [LANG] P6-T4: confirmed
- **Risk:** None. D3 (mergiraf as an external, user-installed git merge driver) is right: GPL-3.0 and an unstable library API rule out linking. Difftastic is diff-only and cannot merge; no Apache/MIT structured-merge tool matches mergiraf's language coverage.
- **Fix:** Use merge.conflictStyle=zdiff3 (`git merge-file --zdiff3`) as the fallback instead of plain diff3. Detect mergiraf's supported languages with `mergiraf languages` so non-covered files go straight to zdiff3.
- **Evidence:** SPEC D3; PLAN P6-T4: 'diff3 → mergiraf sidecar (D3)'.

## [MEDIUM] state-mutation — packages/agent-runtime/src/util/workspace-path-leases.ts — [LANG] P6-T5: Rust daemon confirmed; IPC = JSON-RPC 2.0 over UDS/named pipe (jsonrpsee + interprocess) with types generated from the D17 JSON Schema; leases daemon-owned with fencing tokens, singleton held by flock
- **Risk:** tonic gRPC or capnp would add a second schema source next to Zod/JSON Schema (D17) and ACP JSON-RPC (D9). Leases today live in a per-process Map, so cross-terminal exclusion does not exist. The broker's mkdir lock with pid liveness and staleLockMs heuristics can wrongly reclaim a lock across pid reuse or PID namespaces.
- **Fix:** Transport: jsonrpsee over a UDS (Linux/macOS) or named pipe (Windows) through the `interprocess` crate, with SO_PEERCRED/getpeereid auth as in the P1-T2 SEC-4 socket. Rust types come from the published JSON Schemas via `typify`, keeping one schema authority. The daemon holds an exclusive flock (the `fd-lock` crate) on its state-dir lockfile, which the kernel releases on crash, so no stale heuristics are needed. Leases carry monotonic fencing tokens that the broker checks at commit. X-5 supervises the daemon. Do not use napi-rs or uniffi for the daemon (uniffi has no Node target); napi-rs stays for kernels.
- **Evidence:** workspace-path-leases.ts: `const activeLeases = new Map<string, ActiveLease>()`, in-process only. workspace-mutation-broker.ts: acquireWorkspaceLock uses mkdir plus owner.json pid, and canRecoverLock uses an age check plus process.kill(pid,0).

## [MEDIUM] state-mutation — .agents/sessions/polyglot-roadmap-v2/PLAN.md — [LANG] P6-T6: drop redb — use rusqlite (bundled, WAL) on the SAME schema/file P6-T6a ships in bun:sqlite; notify + ignore + grep-searcher + tantivy confirmed
- **Risk:** The plan lists 'redb/SQLite'. redb would force a second migration from the TS sqlite store, and bun/TS readers could no longer open the index directly during the degradation tier. notify on Linux runs into inotify max_user_watches on large monorepos (with node_modules/target excluded or not).
- **Fix:** Use rusqlite with a bundled SQLite on the P6-T6a schema. The TS fallback and the daemon then read the same file, and cutover becomes an ownership change instead of a migration. Keep tantivy as the BM25/fuzzy/phrase tier; the CQ-T3 archive index moves to it too. Run notify with debouncer-full, cap watch counts, and fall back to an age-sweep tier reported through X-4. Offer Watchman as an optional backend when installed. Search uses the `ignore` + `grep-searcher`/`grep-regex` crates.
- **Evidence:** PLAN P6-T6: 'transactional redb/SQLite store'. D14: 'the daemon's redb/rusqlite store supersedes it later'.

## [MEDIUM] performance — .agents/sessions/polyglot-roadmap-v2/PLAN.md — [POLY] P6-T6: live watching and indexing need default excludes for non-gitignored build dirs (target/, .venv, build/, .gradle, bazel-*, __pycache__, .tox, vendor/, _build, .dart_tool, Pods)
- **Risk:** Repos that do not gitignore these directories, or tools that create them after checkout, flood notify and blow inotify limits. Indexing generated code then skews ranking.
- **Fix:** Take default excludes from the D16 registry per detected ecosystem and apply them in the `ignore` WalkBuilder and the watcher filter. Report the excluded roots.
- **Evidence:** PLAN P6-T6 and P2-T9 mention an fd cap but no ecosystem excludes.

## [LOW] state-mutation — packages/indexer/src/index-store.ts — [LANG] P6-T6a: confirmed
- **Risk:** None. bun:sqlite WAL behind loadIndex/saveIndex is the right way to delete the ~430-line advisory lock (withCacheLock/reclaimStaleLock/releaseOwnedLock plus heartbeat) and the whole-document JSON rewrite.
- **Fix:** Design the schema for reuse by rusqlite (see P6-T6): STRICT tables, a user_version migration, and computeIndexSnapshotId golden vectors, so the Rust daemon opens the same file.
- **Evidence:** index-store.ts: withCacheLock with heartbeat, reclaim and release; atomicWriteJson rewrites metadata.json in full.

## [LOW] correctness — .agents/sessions/polyglot-roadmap-v2/PLAN.md — [LANG] P6-T7: confirmed
- **Risk:** Low. Native tree-sitter plus rayon with unchanged .scm queries is the best option. The one parity risk is grammar version skew between WASM and native builds.
- **Fix:** Build native and WASM grammars from the same pinned grammar sources and ABI version (one grammars manifest), and gate cutover on the buildTokenCallers conformance fixture.
- **Evidence:** PLAN P6-T7: 'native tree-sitter + rayon, .scm queries unchanged … WASM fallback kept until parity'.

## [LOW] performance — .agents/sessions/polyglot-roadmap-v2/PLAN.md — [LANG] P6-T8: confirmed
- **Risk:** None. Cross-session token buckets need one authority, and the daemon is it.
- **Fix:** Use the `governor` crate (GCRA) for buckets and EWMA health in the daemon, exposed over the P6-T5 JSON-RPC. Keep failover decisions in TS per IL-8. Fail open to per-process limits when the daemon is down, and report it.
- **Evidence:** PLAN P6-T8; traceability 'IL-8 P6-T8 (keep failover in TS)'.

## [MEDIUM] error-handling — .agents/sessions/polyglot-roadmap-v2/PLAN.md — [LANG] P6-T9: memmap2 over live workspace files risks SIGBUS; use pread with large buffers, mmap only for immutable snapshots
- **Risk:** Agents, editors and formatters truncate or rewrite workspace files all the time. A read through a mapping of a file truncated underneath it raises SIGBUS and kills the resident daemon, which then takes down leases, jobs and the index together.
- **Fix:** Use buffered pread (or an rg-style `grep-searcher` MmapChoice::never for mutable files) plus memchr for range reads. Reserve memmap2 for daemon-owned immutable artifacts (tantivy segments, sqlite). Use getdents64 via rustix for large-directory listing. Keep the X-2 gate.
- **Evidence:** PLAN P6-T9: 'Uses memmap2+memchr and getdents in the daemon'.

## [MEDIUM] dependency-hygiene — rust/Cargo.toml — [BEST] X-3b: resolver "2" / edition 2021 — adopt edition 2024 + resolver "3" (MSRV-aware) + workspace rust-version; that is what prevents the napi MSRV incident
- **Risk:** The toolchain pin makes an MSRV violation fail loudly, but resolver 2 still selects dependency versions whose MSRV is newer than the pinned toolchain. That is exactly the napi 3.13 / 1.88 incident, which then needs manual downgrades.
- **Fix:** Set `[workspace.package] edition = "2024"` and `rust-version = "<pin>"`, set resolver = "3" (Cargo ≥1.84 picks MSRV-compatible versions), and have members inherit with `edition.workspace = true`. Keep Cargo.lock tracked, and run CI with `--locked`.
- **Evidence:** rust/Cargo.toml: resolver = "2". Crate Cargo.toml: edition = "2021". X-3B-DESIGN-NOTE §1 describes the MSRV incident.

## [LOW] dependency-hygiene — rust/rust-toolchain.toml — [BEST] X-3b: toolchain pinned to 1.87.0 (May 2025), well behind current stable; the CI action duplicates the pin
- **Risk:** By the time the first real crates land, landlock, tokio, windows-rs, tantivy, gix and hudsucker will have MSRVs above 1.87, so the stale pin will force either a bump or old crate versions. `dtolnay/rust-toolchain@1.87.0` is a second copy of the pin that can drift from the file.
- **Fix:** Bump to current stable when P5-T1 lands, and add components = ["clippy","rustfmt"] plus targets. In CI, use an action that reads rust-toolchain.toml (actions-rust-lang/setup-rust-toolchain, or plain `rustup show`) so the file is the only source. Keep the deliberate-bump policy.
- **Evidence:** rust-toolchain.toml channel = "1.87.0"; rust-workspace.yml uses dtolnay/rust-toolchain@1.87.0.

## [MEDIUM] dependency-hygiene — .github/workflows/rust-workspace.yml — [BEST] X-3b: no cargo-deny/cargo-audit, clippy, fmt, [workspace.lints] or --locked — license policy (GPL mergiraf, AGPL trufflehog) is unenforced
- **Risk:** The plan's license rules (D3 GPL never linked, AGPL TruffleHog) and supply-chain risk are not machine-checked. Nothing enforces unsafe_code discipline, which the shim needs.
- **Fix:** Add a deny.toml with a licenses allowlist (Apache-2.0/MIT/BSD/ISC/Unicode/MPL-2.0; deny GPL/AGPL), bans (duplicate major versions), advisories (RustSec) and sources (crates.io only). CI runs `cargo deny check`, `cargo clippy --workspace --all-targets -- -D warnings`, `cargo fmt --check`, and `cargo build/test --locked`. Add `[workspace.lints]`: rust.unsafe_code = "deny" (the shim/jobd crates `allow` it locally with SAFETY comments), clippy.all = warn. Add cargo-vet or dependency-review for new crates.
- **Evidence:** rust-workspace.yml runs only `cargo build --workspace` and `cargo test --workspace`. rust/Cargo.toml has no lints table.

## [MEDIUM] test-coverage — .github/workflows/rust-workspace.yml — [BEST] X-3b: sketched matrix misses aarch64-apple-darwin/linux-arm64 and runs `cargo test --target` cross (cannot execute); sandbox tests need real kernels/OSes
- **Risk:** The sketch lists x86_64-apple-darwin but not aarch64-apple-darwin (most Macs), and omits aarch64 Linux musl and Windows arm64. Running `cargo test --target X` on ubuntu for darwin or windows targets cannot execute the binaries, which breaks charter rule 2 (run the native path). Landlock and SBPL escape tests need kernel ≥6.7/6.12 and macOS hosts.
- **Fix:** Build and test on native runners: ubuntu-24.04 (x64), ubuntu-24.04-arm, macos-14 (arm64) plus macos-13 (x64), windows-latest (plus windows-11-arm when available). Build distributable Linux binaries with cargo-zigbuild (musl static, or a glibc 2.17 floor). Add a kernel-matrix job (e.g. a virtme-ng/QEMU run of the P5-T1 adversarial suite on 5.15, 6.8 and 6.12) so each Landlock ABI tier is actually exercised. Smoke-test the downloaded artifact on every leg.
- **Evidence:** rust-workspace.yml commented matrix: 5 targets, all tested by `cargo test --workspace --target ${{ matrix.target }}` under a single ubuntu-latest runs-on.

## [MEDIUM] security — .agents/sessions/polyglot-roadmap-v2/X-3B-DESIGN-NOTE.md — [BEST] X-3b: 'checksummed artifacts' is not enough — add Sigstore/GitHub build-provenance attestations, macOS codesign+notarization and Windows Authenticode; pull cargo-dist forward from P10-T8
- **Risk:** Checksums fetched from the same origin as the binary do not authenticate a sandbox binary that runs with authority over user processes. Unsigned macOS binaries hit Gatekeeper and quarantine, and unsigned Windows binaries hit SmartScreen/Defender. The release tooling (cargo-dist) sits in P10 while the sidecars ship at P5.
- **Fix:** In X-3b: cargo-dist for the build/release matrix and installers; `actions/attest-build-provenance` (SLSA, Sigstore keyless) plus a SHA256SUMS file signed with cosign; X-5 verifies the attestation or pinned sha256 embedded at TS build time before spawning; Apple Developer ID codesign plus notarytool; Authenticode (Azure Trusted Signing).
- **Evidence:** PLAN X-3b: 'publishes checksummed artifacts'. P10-T8 holds cargo-dist and 'moves checksums to build time'. X-5 is PARTIAL with checksum wiring deferred.

## [LOW] api-contract — .agents/sessions/polyglot-roadmap-v2/X-3B-DESIGN-NOTE.md — [LANG] X-3b: confirmed
- **Risk:** None for the core charter. A separate cargo workspace, standalone sidecar binaries over stdio JSON-RPC, napi-rs only for X-2-evidenced kernels (Bun supports Node-API; uniffi has no JS target), no dual JS mirror, and the carried-forward two-stage loading pattern are the best available shape.
- **Fix:** Apply the [BEST] amendments above (resolver 3/edition 2024, lints/deny, native-runner matrix, signing/cargo-dist). Add `[profile.release] lto = "thin", codegen-units = 1, strip = true, panic = "abort"` for the sidecars (the shim must not unwind across fork/exec).
- **Evidence:** X-3B-DESIGN-NOTE §1–§3; rust/README.md; openbuff-workspace-harness lib.rs protocol_version test.

## Coverage receipt

### Subsystems
- .agents
- rust
- sdk
- packages
- .github

### Features
- P5-T1
- P5-T2
- P5-T3
- P5-T4
- P5-T5
- P5-T6
- P5-T7
- P6-T1
- P6-T2
- P6-T3
- P6-T4
- P6-T5
- P6-T6
- P6-T6a
- P6-T7
- P6-T8
- P6-T9
- X-3b

### Files
- .agents/sessions/polyglot-roadmap-v2/PLAN.md
- .agents/sessions/polyglot-roadmap-v2/SPEC.md
- .agents/sessions/polyglot-roadmap-v2/X-3B-DESIGN-NOTE.md
- .github/workflows/rust-workspace.yml
- sdk/src/tools/terminal-command-policy.ts
- sdk/src/tools/run-terminal-command.ts
- sdk/src/tools/background-jobs.ts
- sdk/src/services/workspace-mutation-broker.ts
- packages/indexer/src/index-store.ts
- packages/agent-runtime/src/util/workspace-path-leases.ts
- common/src/util/redact-secrets.ts
- rust/Cargo.toml
- rust/rust-toolchain.toml
- rust/crates/openbuff-workspace-harness/Cargo.toml
- rust/crates/openbuff-workspace-harness/src/lib.rs
- rust/README.md
- rust/.gitignore

### Domains
- security
- correctness
- state-mutation
- error-handling
- performance
- dependency-hygiene
- test-coverage
- api-contract
