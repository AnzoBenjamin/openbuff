# Audit findings: plan-RD

- Subsystems: .agents
- Features: RD-p0-leak-bypass-fixes, RD-os-sandbox-shim, RD-shell-ast-precheck, RD-jobd, RD-egress-proxy-secret-broker, RD-pty-host-terminal-session, RD-secret-scanning, RD-mcp-sandbox-lockfile, RD-browser-in-sandbox, RD-microvm-tier, RD-provenance, P0-T1, P0-T2, P0-T3, P0-T4, P0-T5, P0-T6, P0-T7, P0-T8, P5-T1, P5-T2, P5-T3, P5-T4, P5-T5, P5-T6, P5-T7, P10-T1, P10-T2, P10-T3, P10-T4, P10-T5, P10-T6, P10-T7, P10-T8, P10-T9, adjudication-D40-shell-parser, adjudication-D31-gitleaks-codegen, adjudication-native-binary-topology, adjudication-P5-ordering
- Files covered: 8
- Snapshot: 49801b44e84d3d8fa583c3ebd9b2855228bf122572b7cdf5f78c77b3389d824d

## [HIGH] security — PLAN.md:32 — P0-S1 R-D P0 leak/bypass fixes: CHANGE→add P0-S1 task now, TS in-process (no new language)
- **Risk:** R-D lists 'P0 leak and bypass fixes', but the only P0 security tasks are T1–T4 (all marked done), and P0-S1 exists only as a proposal (AUDIT §7, SPEC D31/D32 'Applies at P0-S1'). Of the 17 HIGH security findings, 13 are code-level and need no shim: env denylist, read-only profile running build scripts, full-access for every agent, ^-anchored approval classifier, ACP sessionId traversal, browser file://, MCP IPv6-mapped SSRF, CRLF redaction bypass, 5-shape corpus with the gh[o rus]_ typo, eval token in origin, runner full env, buffbench toJSON(secrets), wrong docs claim. They stay open while P1-T2 exposes the tool surface to remote ACP clients, which widens the blast radius.
- **Fix:** Best: a P0-S1 task in TS/YAML, sequenced before any further P1/P2 work. Items: sessionId regex + journalDir containment; http/https/about:blank scheme allowlist via CDP Fetch.enable; ipaddr.js (or node:net BlockList) over a shared blocked-CIDR data file, stripping the trailing dot, checked post-DNS; CRLF-aware redaction through the D30 codec; env strip derived from configured apiKeyEnv + D31 table; permission_profile derived from agentTemplate/handoff (least privilege); read-only profile as an allowlist; eval env allowlist + tokenless origin + explicit secrets + permissions block (i.e. land P8-T0 now). Add codebase-found items: OAuth `state = codeVerifier` (use an independent random state), serve token printed to stderr (write a 0600 file instead), and embedded rg trusted without a hash (verify sha256). Unlocks now: closes ~75% of HIGH security findings in days, with no toolchain. Next: gives D32/D40 and the shim a clean baseline to cross-check against.
- **Evidence:** PLAN.md:34-37 (P0-T1..T4 only); AUDIT-REPORT §6 HIGH list, §7 P0-S1; cb-cli-services chatgpt-oauth.ts:89 (state=verifier), serve-command.ts:97 (token on stderr), ripgrep.ts:32-35 (trust-existing); cb-sdk-core env.ts denylist; cb-common mcp/client.ts:455-473 (v6 first-hextet only), redact-secrets.ts:18. Cost: M (1.5–2.5 eng-weeks total, each item S). Confidence: high. Web claims (unverified, domain knowledge): ipaddr.js range() names include ipv4Mapped/uniqueLocal/linkLocal; CDP Fetch domain can fail requests by URL pattern.

## [HIGH] security — PLAN.md:34 — P0-T1 child-env credential strip: CHANGE→TS allowlist + apiKeyEnv-derived + D31 codegen list (reopen)
- **Risk:** Marked DONE, but it ships with residuals SB2-F1 (generic OPENAI/ANTHROPIC/OPENROUTER_API_KEY not stripped) and SB2-F2 (blender spawn gets the full env). Audit Top #4 (HIGH) still reports env.ts:69 as an 8-name denylist, and cb-sdk-core confirms that configured apiKeyEnv values such as OPENCODE_GO_API_KEY leak. A denylist is the wrong mechanism for a secret boundary.
- **Fix:** Best: keep TS, but switch to true env_clear + allowlist semantics (PATH, HOME, LANG, TERM, the registry toolchainHomes vars from D29), with the denylist as a defense-in-depth layer built from (a) every configured apiKeyEnv and (b) the D31 codegen'd env-name list. Route every spawn site through it (3d-assets, sidecar-supervisor, librarian clones). Later, the Rust shim does env_clear itself and the P5-T3 broker supplies placeholders. Unlocks now: provider-agnostic isolation. Next: children never see keys (P5-T3).
- **Evidence:** PLAN.md:34 residuals SB2-F1/F2; AUDIT Top #4, §6 HIGH env.ts:69; cb-sdk-core env.ts finding (denylist of 8 misses apiKeyEnv). Cost: S (2–3 days incl. an allowlist regression test per toolchain). Confidence: high. Web claims: none.

## [LOW] security — PLAN.md:35 — P0-T2 one-shot approval token on reruns: KEEP (TS)
- **Risk:** Correct mechanism: reruns keep mode:'assistant' plus the original profile and a one-shot preApprovedAction. Remaining weakness: single-use consumption rides the JSON harness store with mkdir locks and Atomics.wait, so consume-once isn't transactional across processes.
- **Fix:** Keep TS. When local-harness-store moves to bun:sqlite (cb-sdk-services), make consume a single `UPDATE ... WHERE consumed=0`; later it moves behind openbuffd. Bind the approval to the D40 parsed argv plan hash rather than the raw command string once the parse gate exists, so a whitespace or quoting variant can't reuse an approval. Unlocks next: approvals that are replay-proof across CLI/serve processes.
- **Evidence:** PLAN.md:35; cb-sdk-services harness-enforcement.ts:70-118 (consume path inherits store lock weaknesses), local-harness-store.ts:189-287. Cost: S. Confidence: medium-high. Web claims: none.

## [LOW] security — PLAN.md:36 — P0-T3 tmux-cli teardown + bash -n test: KEEP (TS), retire into P5-T4
- **Risk:** The fix is fine. The task also surfaced that the runtime handler forwards permission_profile:'full-access' for all agents (now AUDIT Top #5, HIGH) and left it unwired, which leaves the tmux-test profile unenforced at the handler layer. The generated /tmp helper scripts are themselves attack surface.
- **Fix:** Keep. Move the full-access forwarding fix into P0-S1 (per-agent profiles). Retire the generated helper scripts when P5-T4 lands (tmux-cli on the PTY host, no /tmp executables). Unlocks: enforced agent profiles now; no executable temp files next.
- **Evidence:** PLAN.md:36 (profile-scope finding); AUDIT Top #5 run-terminal-command.ts:42; PLAN.md:127 P5-T4 'no /tmp executables'. Cost: S. Confidence: high. Web claims: none.

## [MEDIUM] security — PLAN.md:37 — P0-T4 Chrome pipe transport + --no-sandbox gating: KEEP TS CDP; add scheme allowlist gap to P0-S1
- **Risk:** --remote-debugging-pipe is the right mechanism, and TS is the best home for CDP (cb-sdk-tools browser-logs finding). But the task didn't cover navigation policy: browser-logs.ts:2130 allows file:// and has no egress control (AUDIT Top #9, HIGH). Also, where userns is unavailable, --no-sandbox still runs Chrome unsandboxed on the host.
- **Fix:** Keep TS for CDP. In P0-S1: a URL scheme allowlist enforced with CDP Fetch.enable interception (patterns for file:, chrome:, devtools:, and data: downloads), a dedicated throwaway --user-data-dir, and --proxy-server pointing at P5-T3 later. When userns is unavailable, report the tier as 'browser: unsandboxed' via X-4 instead of silently running. CONSUME sharp or Chrome clip for the image stack. Unlocks now: blocks local-file exfil. Next: P5-T7 shim profile.
- **Evidence:** PLAN.md:37; AUDIT Top #9, §6 HIGH browser-logs.ts:2130; cb-sdk-tools browser-logs.ts:934 (KEEP TS CDP, consume image ops). Cost: S. Confidence: high. Web claims (unverified): Fetch.requestPaused fires for main-frame navigations including file:// when patterns match.

## [LOW] correctness — PLAN.md:38 — P0-T5 tree-sitter hasError preflight: KEEP TS web-tree-sitter (reopen for .py/.go); ship tree-sitter-bash grammar here
- **Risk:** Not a security task, but it's the delivery vehicle for the D32 grammar: tree-sitter-bash isn't shipped today (AUDIT §6 LOW, CM). Python and Go still bypass tree-sitter and reject valid code (AUDIT §4, HIGH).
- **Fix:** Keep TS web-tree-sitter. Reopen per the audit (route .py/.go, gate on the error delta). Add a pinned tree-sitter-bash WASM, hash-verified at load (fixing the unverified runtime WASM finding), from the same grammar revision the Rust shim will compile natively (one grammar manifest, P6-T7). Unlocks now: the D32 TS AST pre-check. Next: identical grammar bytes on both sides of D40.
- **Evidence:** PLAN.md:38; AUDIT §4 P0-T5 reopen, §6 LOW 'tree-sitter-bash not shipped; hasError must deny', grammar-wasm-repair.ts:90 unverified WASM. Cost: S. Confidence: high. Web claims: none.

## [MEDIUM] security — PLAN.md:39 — P0-T6 eval hygiene: KEEP TS stats; REORDER P8-T0 isolation into P0 (eval secrets are HIGH)
- **Risk:** The statistics work is fine in TS (hardening is P8-T4a). The security-relevant problem: eval runners execute untrusted model output with --dangerously-skip-permissions / --full-auto and the full host env, with tokens in the origin URL and toJSON(secrets) in CI (3 HIGHs). P8-T0, the fix, sits in phase 8.
- **Fix:** Keep TS stats. Pull P8-T0 into P0-S1: rootless podman `--network none` (or via the egress proxy later), env allowlist, tokenless git origin with a credential helper, explicit per-secret env in workflows, and a `permissions:` block. Unlocks now: stops secret exposure in CI. Next: the same wrapper becomes the TS fleet (D39), with no Go.
- **Evidence:** PLAN.md:39, PLAN.md:164 (P8-T0); AUDIT §6 HIGH setup-test-repo.ts:191, runners/claude.ts:49, buffbench.yml:35; D18. Cost: S-M (3–5 days). Confidence: high. Web claims: none.

## [LOW] security — PLAN.md:40 — P0-T7 small correctness fixes (MCP name, config dedupe): KEEP TS; SSRF guard CONSUME ipaddr.js
- **Risk:** The items are correct and language-appropriate. The related MCP SSRF guard, a hand-rolled IPv4/IPv6 canonicalizer duplicated in agent-runtime web-search-utils, is the HIGH bypass (::ffff:7f00:1, NAT64, 6to4, trailing dot).
- **Fix:** Keep. CONSUME ipaddr.js plus one shared blocked-networks data file used by both TS copies and, later, by the Rust egress proxy (std::net + ipnet, to_ipv4_mapped). Unlocks: one SSRF policy across TS and Rust.
- **Evidence:** PLAN.md:40-49; cb-common mcp/client.ts:404 (CONSUME ipaddr.js / ipnet); AUDIT Top #10. Cost: S. Confidence: high. Web claims (unverified): ipaddr.js maintained and MIT.

## [LOW] correctness — PLAN.md:51 — P0-T8 structured diagnostics / SARIF: KEEP TS; reuse the SARIF ingest for gitleaks and semgrep output
- **Risk:** Correct mechanism. It's security-adjacent because SARIF is also gitleaks' and semgrep/opengrep's output format, and the audit notes a SARIF charOffset fake-range bug.
- **Fix:** Keep. Reuse the SARIF 2.1.0 parser for the P5-T5 commit gate (gitleaks --report-format sarif) so secret findings flow through the same diagnostics and review-bundle path. Fix the charOffset mapping. Unlocks: one findings pipeline for compiler, taint and secret results.
- **Evidence:** PLAN.md:51; AUDIT §5 language-diagnostics.ts:1050 SARIF charOffset; cb-sdk-tools language-diagnostics KEEP. Cost: XS. Confidence: medium-high. Web claims (unverified): gitleaks supports SARIF report format.

## [HIGH] security — PLAN.md:120 — P4-T8/D32/D40 shell AST pre-check + parser authority: CHANGE→Rust native tree-sitter-bash in shim (same grammar rev as TS), refuse-on-ERROR/unknown, execve parsed argv; mvdan/sh as CI oracle only; REORDER to right after P0-S1
- **Risk:** The plan puts the pre-check in P4 as advisory and the authoritative parse at P5-T1, with the parser undecided (tree-sitter-bash vs brush-parser vs mvdan/sh WASM). The ~2450-line regex policy with ≥3–5 divergent tokenizers, then `bash -c`, is the root of most HIGH shell bypasses (cb-sdk-tools). Any parser that differs from bash is an escape vector (parser differential). mvdan/sh via WASM would run in the TS process, not at the enforcement point, so check and exec stay split across processes, and it adds a Go→WASM blob. brush-parser is a full bash-compatible parser, but its fidelity to bash is unverified and it's a second grammar that disagrees with the TS pre-check.
- **Fix:** Adjudication (D40): authoritative = Rust shim compiling tree-sitter-bash natively at the SAME grammar revision and .scm queries as the TS web-tree-sitter pre-check (one grammar manifest). Both sides then parse identically, and the TS layer is a true fast mirror, not a divergent approximation. Soundness does not rely on tree-sitter matching bash exactly: (1) deny on any ERROR/MISSING node and any node kind outside an allowlist (arithmetic, coproc, eval-ish builtins, unquoted expansions in command position); (2) for simple commands and pipelines, the shim execve's the parsed argv itself with no bash, which removes the differential; (3) `bash -c` only for allowlisted compound forms, under OS enforcement; (4) CI differential fuzzing against real bash plus mvdan/sh (shfmt --tojson) as an oracle, with cargo-fuzz corpora. brush-parser: evaluate later as a second oracle, not the authority. Windows: PowerShell gets the tier 'lexical-only' or refusal, reported via X-4. Move earlier: D32's TS pre-check lands in P0-S1, and the shim's parse gate + execve lands as the first X-3b crate right after P0-S1, before landlock (it already closes the regex-bypass class). Unlocks now: one lexer, node-anchored 'why denied', exec-without-shell. Next: per-command landlock/seccomp profiles, argv-hash-bound approvals, PTY host reuse.
- **Evidence:** PLAN.md:120 (P4-T8 advisory, 'or mvdan/sh WASM'), PLAN.md:124 (D10 parse gate in shim); SPEC D10, D32, D40; AUDIT §4 P4-T8 ⚠ disagreement (P34 brush, P56 tree-sitter+execve, CM mvdan); cb-sdk-tools terminal-command-policy.ts:733 (3+ tokenizers, bash -c at run-terminal-command.ts:571-583). Cost: TS pre-check M (1–2 wks); Rust parse gate + execve L (3–5 wks incl. porting the rule surface as data + differential corpus). Confidence: high on shared-grammar + execve + deny-on-unknown; medium on brush fidelity. Web claims (unverified): tree-sitter-bash handles heredocs via an external scanner but has known gaps; shfmt --tojson emits a full AST; brush-parser is MIT and powers the brush shell.

## [HIGH] security — PLAN.md:124 — P5-T1 R-D OS sandbox shim: CHANGE→Rust landlock BestEffort to ABI v6 + seccompiler + userns-optional network tiers; macOS SBPL; Windows restricted token+low IL+Job (AppContainer opt-in)
- **Risk:** Rust is correct (landlock/seccomp must be applied between fork and exec, which Node can't do; cb-sdk-tools run-terminal-command.ts:578). Gaps in the plan: (1) the ABI probe stops at TCP v4, missing v5 ioctl-dev and v6 scopes (abstract unix sockets, signals), so a sandboxed child can signal or connect to host processes (AUDIT §6 HIGH). (2) The netns fallback needs unprivileged userns, which is restricted on Ubuntu ≥23.10 via AppArmor and on hardened distros (HIGH). (3) AppContainer breaks most toolchains that write to user profile dirs. (4) There are no toolchain-home read roots (cargo/go/pip/gradle caches), so non-JS builds break and users disable the sandbox.
- **Fix:** Best: Rust crates `landlock` (CompatLevel::BestEffort, request up to ABI v6, report the achieved ABI), `seccompiler` (or libseccomp-rs if unotify is needed; see P10-T2), `rustix`/`nix` for namespaces, prctl(NO_NEW_PRIVS, PDEATHSIG). Network tiers, in order: Landlock TCP connect restricted to the proxy port (≥6.7), then a seccomp socket-family filter (deny AF_INET/AF_INET6 except via the proxy unix socket), then netns only if userns is available. Always report the tier. macOS: generated SBPL profile via sandbox-exec (deprecated but functional; the Codex precedent), with P10-T1 VMs as the hedge. Windows: restricted token + low integrity + Job Object as the default, AppContainer as an opt-in stricter tier. Read/write roots come from the D29 registry (toolchainHomes, artifactDirs, credentialFiles denied), and trusted readableRoots come from run.ts (cb-sdk-core). Use codex-rs linux-sandbox as a reference implementation (license check before copying). Unlocks now: classification misses stop being escapes; honest 'sandbox: parse+landlock(v6)+seccomp' tier. Next: P5-T3/T6/T7, P9-T2 hooks, P2-T8 subprocess children and P8 eval runners all run under one shim.
- **Evidence:** PLAN.md:124; SPEC D4; AUDIT §4 P5-T1 change-approach, §6 HIGH 'Landlock v5/v6 scopes missing', 'netns fallback fails without userns'; cb-sdk-tools run-terminal-command.ts:578 (MOVE→Rust), cb-sdk-core run.ts readableRoots (mirror to landlock), cb-common sensitive-paths.ts (policy data shared with shim). Cost: L-XL (Linux 4–6 wks; macOS 2–3; Windows 4+), CI on 5+ targets. Confidence: high on direction; medium on Windows tiering. Web claims (unverified): Landlock ABI v5 = kernel 6.10 (IOCTL_DEV), v6 = 6.12 (scoped abstract unix/signal); Ubuntu 23.10+ restricts unprivileged userns via AppArmor; codex-rs is Apache-2.0.

## [MEDIUM] correctness — PLAN.md:125 — P5-T2 R-D jobd: CHANGE→Rust library crate hosted in a minimal openbuffd from P5 (not a separate jobd then absorbed); systemd transient scope via zbus; pidfd via rustix
- **Risk:** The plan builds jobd at P5 and then absorbs it into openbuffd at P6-T5 (PLAN.md:216), which means building the process host twice. Unprivileged cgroup v2 delegation often isn't available, so mem/cpu/pids caps fail silently. The TS supervisor it replaces (background-jobs.ts, 1460 lines) uses /tmp logs with manual symlink/O_EXCL defenses, /proc starttime liveness (Linux only), 250ms polling, and a direct-child-only kill on Windows.
- **Fix:** Best: a `openbuff-jobs` Rust library (tokio::process, rustix pidfd_open/pidfd_send_signal, PR_SET_CHILD_SUBREAPER, macOS kqueue EVFILT_PROC, Windows Job Objects with KILL_ON_JOB_CLOSE). Cgroups: delegated cgroup v2 if writable, else a systemd transient scope via zbus (org.freedesktop.systemd1 StartTransientUnit, user manager), else rlimits, with the tier reported. Host it in a minimal openbuffd from day one, and let P6-T5 extend that same daemon. Logs go in a daemon-owned 0700 state dir. Peer-cred socket via tokio UnixStream::peer_cred / named pipes. TS check_job/kill_job become RPC clients. Unlocks now: guaranteed tree kill, exact exit codes across CLI restarts, no /tmp attack surface. Next: per-job accounting in the TUI, shared jobs across sessions.
- **Evidence:** PLAN.md:125, PLAN.md:138 (P6-T5 absorbs jobd), PLAN.md:216; AUDIT §4 P5-T2 change-approach (systemd scope via zbus, pidfd via rustix); cb-sdk-tools background-jobs.ts:716 (MOVE→Rust daemon), check-job.ts KEEP as RPC client; cb-sdk-services sidecar-supervisor.ts (move supervision to D1). Cost: M-L (3–4 wks). Confidence: medium-high. Web claims (unverified): pidfd needs 5.3+; systemd user manager allows transient scopes with delegation unprivileged.

## [HIGH] security — PLAN.md:126 — P5-T3 R-D egress proxy + secret broker: CHANGE→Rust hudsucker (hyper/rustls/rcgen) with CONNECT-passthrough default, placeholder-token injection, per-ecosystem CA/proxy env, landlock-TCP enforcement
- **Risk:** The plan enforces egress 'via netns' only, which fails without userns (the same HIGH as P5-T1). Hand-rolling a MITM proxy on raw hyper/rustls/rcgen is a large, security-critical surface. MITM-by-default breaks JVM/pip/cargo/Go trust stores, and pinned clients break outright. There's no DNS-rebinding or SSRF classification, and 'children never hold raw keys' has no concrete mechanism.
- **Fix:** Best: Rust, CONSUME `hudsucker` (MITM framework on hyper + rustls + rcgen) instead of authoring on raw hyper. Default is CONNECT passthrough with an SNI/host allowlist. TLS interception only for hosts that need credential injection. Broker: children get placeholder tokens (e.g. OPENBUFF_PH_<id>), and the proxy swaps Authorization/header values only for the allowlisted destination bound to that placeholder, with an audit log. Emit per-ecosystem env: HTTPS_PROXY/NO_PROXY, NODE_EXTRA_CA_CERTS, REQUESTS_CA_BUNDLE/SSL_CERT_FILE, CARGO_HTTP_CAINFO, GIT_SSL_CAINFO, JAVA_TOOL_OPTIONS trust store, plus registry allowlists from D29 egressRegistries. Enforcement: Landlock TCP connect to the proxy port only (≥6.7), else a seccomp socket filter, else netns; the SBPL network rule on macOS. Share the blocked-CIDR table with the TS SSRF guard; resolve-then-connect to the vetted IP. Unlocks now: secret-less children, auditable egress. Next: browser (P5-T7), MCP servers (P5-T6), eval runners and remote swarms reuse one proxy.
- **Evidence:** PLAN.md:126; AUDIT §4 P5-T3 change-approach (hudsucker, CONNECT passthrough, placeholder broker), §6 HIGH 'egress proxy/secret broker design'; cb-common mcp/client.ts:404 (shared CIDR table + DNS-aware egress); cb-sdk-core env.ts. Cost: L (4–6 wks). Confidence: medium-high. Web claims (unverified): hudsucker is MIT/Apache and maintained; Landlock TCP (ABI v4) restricts bind/connect by port only, not by address.

## [MEDIUM] security — PLAN.md:127 — P5-T4 R-D PTY host + terminal_session: KEEP Rust portable-pty + alacritty_terminal (drop vt100 option); spawn via shim; host inside openbuffd
- **Risk:** The language choice is right: Node has no PTY without node-pty, which is awkward with bun --compile (cb-cli-services router.ts bash mode is buffered, no PTY, dies with the TUI). Risks: the vt100 crate's screen model is thinner than alacritty_terminal. Unless it's specified, the PTY child is spawned outside the sandbox. And a PTY master owned by the CLI can't be reattached.
- **Fix:** Keep Rust: portable-pty (ConPTY on Windows) + alacritty_terminal as the screen model; awaiting-input detection via tcgetpgrp foreground pgrp plus read-blocked heuristics; asciinema v2 cast writer. Every PTY child is launched through the shim with the caller's profile. The PTY master lives in openbuffd (the same process as jobd) so sessions survive CLI restarts. Stream output through the D31 Rust redactor before it leaves the daemon. Unlocks now: interactive commands, streaming bash mode, tmux-cli retirement (no /tmp executables). Next: structured stdout blocks for P9-T2 hooks, attach/detach from editors.
- **Evidence:** PLAN.md:127; AUDIT §4 P5-T4 keep (refine: vt100 thinner; PTY outside sandbox); cb-sdk-tools run-terminal-command.ts:578 (portable-pty), cb-cli-services router.ts:44 (bash mode, PTY in Rust daemon). Cost: M-L (3–4 wks). Confidence: high. Web claims (unverified): portable-pty ConPTY maturity on Windows 10 1809+.

## [HIGH] security — PLAN.md:128 — P5-T5 R-D secret scanning (D31): CHANGE→vendored pinned gitleaks.toml → build-time codegen to TS + Rust tables; no Go runtime; gitleaks binary CONSUMED in CI/pre-push only; REORDER codegen into P0-S1
- **Risk:** The plan still says 'lang Go sidecar + TS codegen', which contradicts D31 (no Go runtime) and D38/D39 (no authored Go). The current corpus is 5 shapes with a `gh[o rus]_` typo and a CRLF bypass (HIGH). Outbound-filter covers 3 providers, and operator-service has its own patterns, so there are ≥4 rule sets. Go RE2 syntax doesn't map one-to-one to JS RegExp (inline (?i) groups), so naive codegen silently mismatches. TruffleHog is AGPL-3.0.
- **Fix:** Adjudication (D31): ACCEPT. Vendor a pinned gitleaks config (MIT) and add a codegen step (three-mirror) that emits (a) a TS JSON rule table with regex dialect translation plus keyword prefilter and (b) a Rust include_str! table using the `regex` crate (RE2-family, linear-time, closest dialect match) + `aho-corasick` keyword prefilter, used by the PTY/proxy/log streams. Golden vectors pin the `[REDACTED]` contract and pass-through lines; any rule that doesn't translate is excluded and listed. Consumers: env strip, stream redaction, outbound filter, staged-commit gate, log sanitizer. Commit gating: CONSUME the upstream gitleaks binary (optional, checksum-verified, SARIF into P0-T8 ingest), never authored Go. TruffleHog is user-installed only (AGPL). Move the codegen and consumer unification into P0-S1. The Rust scanner lands with the shim/PTY. Unlocks now: ~200 provider rules, a single authority. Next: entropy scoring, identical redaction in TS and Rust paths.
- **Evidence:** PLAN.md:128 ('lang Go sidecar + TS codegen'); SPEC D15, D31, D38, D39; AUDIT §4 P5-T5 change-language, §6 HIGH redact-secrets.ts:15/:42; cb-common redact-secrets.ts:15 (CONSUME+CODEGEN, regex+aho-corasick), cb-sdk-core outbound-filter.ts (3 families). Cost: M (1.5–2 wks incl. dialect pass). Confidence: high. Web claims (unverified): gitleaks is MIT with ~150–200 rules; its regexes are Go RE2; some rules use (?i) inline groups; TruffleHog v3 is AGPL-3.0.

## [MEDIUM] security — PLAN.md:129 — P5-T6 R-D MCP server sandboxing + lockfile: KEEP TS lock + shim launch; CHANGE lock schema to per-launcher {launcher, resolved, integrity}
- **Risk:** TS is right: the official MCP TS SDK is the client, and origin marking is a TS WeakMap (cb-common). But 'pinned versions, checksums' is unverifiable for uvx/docker/raw-binary launchers, and the origin WeakMap can't cross into a Rust launcher. Remote HTTP MCP servers aren't covered by the shim.
- **Fix:** Keep TS. Lock entries per launcher: npx → npm integrity sha512 + resolved tarball; uvx → PyPI sha256 + a --require-hashes style pin; docker/podman → OCI digest; binary → sha256 + optional sigstore bundle. Launch stdio servers via the shim with a per-server profile (no workspace write by default, egress via the P5-T3 allowlist). Serialize origin as an explicit field in the launch request. Remote servers go through the egress proxy with the SSRF table. Unlocks now: reproducible, auditable MCP launches. Next: capability grants shared with the P9-T5 plugin registry.
- **Evidence:** PLAN.md:129; AUDIT §4 P5-T6 keep (extend); cb-common mcp/client.ts:594 (keep official TS SDK; origin must be explicit for Rust supervisor). Cost: M (2 wks). Confidence: medium-high. Web claims: none.

## [HIGH] security — PLAN.md:130 — P5-T7 R-D browser inside sandbox: CHANGE→dedicated Chrome shim profile (allow Chrome's own userns sandbox) + --proxy-server to P5-T3 + CDP Fetch scheme allowlist (allowlist lands now in P0-S1)
- **Risk:** 'Runs inside the shim' conflicts with Chrome's own sandbox: a generic seccomp/landlock profile that denies clone(CLONE_NEWUSER) forces --no-sandbox, which is worse. File:// exfil is open today (HIGH). The egress allowlist depends on netns.
- **Fix:** Keep TS CDP orchestration. Add a dedicated shim profile for Chrome: landlock roots = a throwaway user-data-dir + read-only system libs + fonts; seccomp permits the namespaces Chrome's sandbox needs; network only to the egress proxy (--proxy-server, proxy-bypass-list empty); CDP Fetch interception enforces the scheme and host allowlist. If nested userns is unavailable, report 'browser: shim-only (chrome sandbox off)' honestly. Unlocks now (via P0-S1): no file:// reads. Next: killable, cgroup-bounded browser sessions.
- **Evidence:** PLAN.md:130; AUDIT §4 P5-T7 change-approach, Top #9; cb-sdk-tools browser-logs.ts:934 (run Chrome under shim later). Cost: M (2–3 wks after P5-T1/T3). Confidence: medium. Web claims (unverified): Chrome's Linux sandbox uses unprivileged user namespaces when available, falling back to the setuid helper.

## [MEDIUM] security — PLAN.md:197 — P10-T1 R-D microVM tier: KEEP Rust; libkrun primary (Linux KVM + macOS HVF), Firecracker Linux-server option, Virtualization.framework via objc2 bindings (no Swift), podman/gVisor fallback
- **Risk:** The plan lists four backends without a primary, which multiplies integration cost. Firecracker is Linux/KVM only and has no macOS path. Using Apple Virtualization.framework from Swift would add an authored language, against D38. It isn't ordered relative to the P8-T3 eval fleet, which needs the same isolation.
- **Fix:** Keep Rust. Primary: libkrun (one API across Linux KVM and macOS Hypervisor.framework, already used by podman krun/muvm). Optional: Firecracker for Linux CI/server fleets with snapshot/branch. macOS alternative: Virtualization.framework via objc2-virtualization crate bindings, not Swift. Container tiers: gVisor runsc, then rootless podman. Windows: report none, or WSL2 later. Share the image/rootfs builder with the P8 eval fleet. Unlocks next: untrusted-repo mode and hermetic eval runners from one backend.
- **Evidence:** PLAN.md:197; SPEC D4 (VMs are the macOS hedge), D38/D39; AUDIT §4 P10-T1 keep (libkrun primary). Cost: XL (6–10 wks). Confidence: medium. Web claims (unverified): libkrun supports macOS via HVF on Apple Silicon; objc2-virtualization crate exists; Firecracker is Linux-only.

## [MEDIUM] security — PLAN.md:198 — P10-T2 R-D provenance: CHANGE→split into (a) syscall provenance with seccomp_unotify primary, eBPF/fanotify/ES/ETW privileged-only tiers, and (b) artifact provenance via sigstore + in-toto/SLSA pulled forward to X-3b/X-5
- **Risk:** aya eBPF needs CAP_BPF/root, fanotify needs CAP_SYS_ADMIN, EndpointSecurity needs an Apple entitlement, and ETW kernel providers need admin. So for normal unprivileged users the planned mechanism yields nothing, and the 'reading ~/.ssh — allow?' prompt only works through seccomp user notification. R-D 'Provenance' also covers supply-chain provenance, which the plan doesn't schedule at all: sidecar downloads (X-5) and release artifacts are unsigned (AUDIT X-5/X-3b findings).
- **Fix:** (a) Rust: seccomp_unotify via libseccomp-rs (or seccompiler with manual unotify) inside the shim as the unprivileged live-prompt tier. aya/fanotify/ETW are opt-in privileged tiers, and ES is reported 'none' without the entitlement. Provenance records are attached to broker receipts. (b) Artifact provenance: GitHub actions/attest-build-provenance (SLSA in-toto statements, sigstore keyless) plus cargo-dist in X-3b; sigstore-rs verify in X-5 before any sidecar runs. Optionally emit in-toto link statements for agent run receipts. Unlocks now: signed, verifiable native artifacts from the first crate. Next: live file-access prompts without root.
- **Evidence:** PLAN.md:198, PLAN.md:27 (X-3b publishes checksummed artifacts only), PLAN.md:29 (X-5 checksum only); AUDIT §4 P10-T2 keep (caveat: ES entitlement, in-toto), X-5 change-approach (sha256 + Sigstore verify), X-3b (cargo-dist + attestations + codesign). Cost: (a) L; (b) S-M (3–5 days). Confidence: medium-high. Web claims (unverified): seccomp user notification available since Linux 5.0 unprivileged with NO_NEW_PRIVS; sigstore-rs verification maturity.

## [LOW] security — PLAN.md:199 — P10-T3 GUI/screen perception: CHANGE→one Rust MCP server (objc2 AX + ScreenCaptureKit, windows-rs UIAutomation, atspi); drop Swift/C#
- **Risk:** Three authored toolchains (Swift, C#, Rust) for one approval-gated capability, against D38. It's security-sensitive (screen content can include secrets) but has no redaction path.
- **Fix:** One Rust MCP server using objc2 bindings for AX/ScreenCaptureKit, windows-rs for UIA, atspi + PipeWire portal on Linux, supervised by X-5, per-app allowlist and approval gate, OCR/text output passed through the D31 Rust redactor. Unlocks: one crate graph, with screen text redacted before reaching the model.
- **Evidence:** PLAN.md:199; SPEC D38; AUDIT §4 P10-T3 change-language. Cost: L. Confidence: medium. Web claims (unverified): objc2 has ScreenCaptureKit bindings.

## [LOW] dependency-hygiene — PLAN.md:200 — P10-T4 voice I/O: KEEP Rust whisper-rs sidecar (sherpa-onnx/ort alternative per D34)
- **Risk:** Not a security boundary. The main cost is a second ML runtime if D34's ort sidecar lands. Microphone access should be approval-gated.
- **Fix:** Keep whisper-rs (whisper.cpp) as an X-5 sidecar, or reuse the D34 ort sidecar with sherpa-onnx models to avoid a second runtime. Report mic permission via X-4.
- **Evidence:** PLAN.md:200; SPEC D34; AUDIT §4 P10-T4..T9 keep (sherpa-onnx optional). Cost: M. Confidence: medium. Web claims: none.

## [LOW] security — PLAN.md:201 — P10-T5 multi-machine swarms: KEEP Rust daemon; DROP Elixir option; remote workers run under shim/microVM, secrets stay on coordinator broker
- **Risk:** Remote workers widen the secret and exec blast radius. The Elixir option adds a language for no identified capability gain (D38).
- **Fix:** Keep the Rust daemon with fencing-token leases. Remote workers run each lane under the P5-T1 shim or P10-T1 VM. Provider keys are never forwarded; workers get P5-T3 placeholders that resolve at the coordinator's proxy. SSH with pinned host keys. Remove the Elixir clause.
- **Evidence:** PLAN.md:201; SPEC D1, D38. Cost: L. Confidence: medium. Web claims: none.

## [LOW] correctness — PLAN.md:202 — P10-T6 CRDT co-editing: KEEP TS Yjs (yrs only if daemon owns docs); edits must commit via mutation broker receipts
- **Risk:** CRDT merges could bypass the cap.v3/broker receipt path and the review gate.
- **Fix:** Keep Yjs in TS. Every CRDT-applied change materializes as a broker conditionalCommit with a receipt. Move to yrs only if openbuffd owns documents.
- **Evidence:** PLAN.md:202; AUDIT §4 P10-T4..T9 keep (yrs); cb-sdk-services workspace-mutation-broker.ts (single-writer authority). Cost: M. Confidence: medium. Web claims: none.

## [LOW] correctness — PLAN.md:203 — P10-T7 embedded LSP server: DROP (superseded by P1-T4 MCP + ACP extensions)
- **Risk:** The plan itself calls it lower value. It duplicates the intelligence exposure of P1-T4 and ACP, and every additional server is another auth surface.
- **Fix:** Drop it, or defer indefinitely. Expose the same intelligence via P1-T4 MCP and ACP extensions. If ever revived, use TS vscode-languageserver over stdio only.
- **Evidence:** PLAN.md:203 ('lower value than P3's LSP client'). Cost saved: M. Confidence: medium. Web claims: none.

## [MEDIUM] dependency-hygiene — PLAN.md:204 — P10-T8 single-binary distribution: CHANGE→cargo-dist + bun --compile with sigstore attestations/codesign/notarize from X-3b (REORDER earlier)
- **Risk:** Build-time checksums, signing and attestation are deferred to P10, but native security binaries (the shim) ship at P5. Unsigned sandbox binaries downloaded at runtime are a supply-chain hole. The embedded rg is trusted without a hash today.
- **Fix:** Keep cargo-dist for Rust artifacts and bun --compile for TS. Move signing/attestation (actions/attest-build-provenance, macOS codesign + notarization, Windows Authenticode) and build-time sha256 manifests into X-3b, so the first shim release is verifiable by X-5. Retire the vendored rg later as planned.
- **Evidence:** PLAN.md:204, PLAN.md:27; AUDIT §4 X-3b (cargo-dist + attestations + codesign); cb-cli-services ripgrep.ts:38 (no hash verify), release.ts (cargo-dist when Rust ships). Cost: S-M. Confidence: high. Web claims (unverified): cargo-dist supports GitHub attestations.

## [LOW] security — PLAN.md:205 — P10-T9 remaining napi kernels: KEEP evidence-gated; REORDER rusqlite hardened-open VFS into the openbuffd store work (fixes memory-v2 open TOCTOU)
- **Risk:** The 'rusqlite hardened-open VFS' is really a security fix: memory-v2 declares 'pathname-best-effort-unverified-open' (TOCTOU on db/-wal/-shm). Treating it as a perf-gated napi kernel delays it indefinitely.
- **Fix:** Keep the XML and ANSI kernels X-2-gated. Take the hardened open out of P10-T9 and deliver it with the daemon-owned store (rusqlite + SQLITE_OPEN_NOFOLLOW + cap-std dirfd), not as a napi kernel.
- **Evidence:** PLAN.md:205; cb-cli-services bun-sqlite-memory-repository.ts:172-183 (HIGH, unverified open posture), contained-file-io.ts:74 (Linux-only containment). Cost: M. Confidence: medium. Web claims (unverified): SQLITE_OPEN_NOFOLLOW since SQLite 3.31.

## [MEDIUM] correctness — PLAN.md:27 — Adjudication shim/jobd/PTY topology: CHANGE→ONE cargo workspace + ONE multi-call release artifact, TWO process roles (per-exec shim vs long-lived openbuffd hosting jobd+PTY), separate crates
- **Risk:** Landlock/seccomp/Seatbelt restrictions are per-process and irreversible, so the enforcing shim must be a short-lived exec'd process that restricts itself and then execve's. It can't be the long-lived supervisor, which has to keep broad rights to spawn many profiles, hold PTY masters and outlive the CLI. Fully separate jobd, PTY and shim binaries would triple release/sign/CI artifacts and duplicate the spawn path. A single process would violate least privilege.
- **Fix:** Crates: openbuff-sandbox (profile compile + landlock/seccomp/SBPL/Job apply, no tokio, minimal deps), openbuff-shparse (tree-sitter-bash gate, shared with the daemon for pre-validation), openbuff-jobs, openbuff-pty, openbuffd (tokio, jsonrpsee over UDS/named pipe). Ship ONE multi-call binary (argv[0]/subcommand: `openbuff-native sandbox-exec …` and `openbuff-native daemon`) for one signed artifact per target. Keep the shim code path free of tokio and network so its audited surface stays small; after execve none of it remains in the child. The daemon spawns every job and PTY child through the shim role. Before P6-T5, ship the minimal daemon (jobs+pty) and have P6-T5 extend it. Unlocks now: one artifact to sign and verify (X-5), no duplicated spawn logic. Next: index/lanes/scheduler join the same daemon without new artifacts.
- **Evidence:** PLAN.md:27 (X-3b hosts shim, jobd, index, lanes, pty, infer), PLAN.md:125, PLAN.md:127, PLAN.md:138, PLAN.md:216 (P5-T2 absorbed into P6-T5); SPEC D1 (shares crates, one static binary); cb-sdk-tools background-jobs.ts / run-terminal-command.ts (shared exec host), cb-sdk-services sidecar-supervisor.ts (supervision to D1). Cost: neutral vs plan (saves one artifact line and one jobd rewrite). Confidence: medium-high. Web claims: none.

## [HIGH] security — PLAN.md:222 — Adjudication P5 ordering: REORDER→not all of P5 before P1/P2; P0-S1 (TS) immediately, then D32 TS pre-check + P5-T1 Linux shim with D40 parse gate in parallel with P1-T2's remainder; P5-T2..T7 stay in track D
- **Risk:** The plan runs track D (P5) only 'after P1', in parallel with the others. P1-T2 serve is already exposing tools to remote ACP clients while 17 HIGH security findings are open. But pulling ALL of P5 ahead of P1/P2 would stall user-visible protocol and durability work for ~4–6 months, when 13 of the 17 HIGHs are TS/YAML fixes needing no shim, and only 3 are P5 design gaps (landlock v5/v6, userns-less netns, egress design).
- **Fix:** Order: (1) P0-S1 + P8-T0 + D31 codegen + D32 TS tree-sitter-bash pre-check (ERROR=deny, allowlisted read-only, per-agent profiles), 2–3 weeks, before any new P1/P2 feature. (2) P5-T1 Linux shim (parse gate + execve + landlock BestEffort + seccomp, honest tier) as the first X-3b crate, concurrent with the P1-T2 remainder and before P1-T3/T4 expose more surface (MCP server P1-T4 especially). (3) P5-T3 egress + P5-T5 Rust scanner next. (4) P5-T2/T4 as the minimal openbuffd. (5) macOS/Windows shim, P5-T6/T7 after. Gate P1-T4 'receipt-backed edits' and P2-T8 subprocess children on step 2. Unlocks now: most HIGHs closed within weeks, without freezing P1/P2. Next: every later sidecar and child (hooks, evals, MCP, browser) launches under enforcement from its first release.
- **Evidence:** PLAN.md:222 (tracks after P1), PLAN.md:216 (P5-T1 → T3/T6/T7, P9-T2, P10-T1/T2); AUDIT §1 (17 HIGH, mostly shared-root), §6 HIGH list (13 code-level, 3 plan-level P56); SPEC D32/D40 (pull forward), acceptance criteria (security-reviewer + adversarial tests for P0/P5). Cost: step 1 M (2–3 wks); step 2 L (4–6 wks) overlapping P1. Confidence: high. Web claims: none.

## Coverage receipt

### Subsystems
- .agents

### Features
- RD-p0-leak-bypass-fixes
- RD-os-sandbox-shim
- RD-shell-ast-precheck
- RD-jobd
- RD-egress-proxy-secret-broker
- RD-pty-host-terminal-session
- RD-secret-scanning
- RD-mcp-sandbox-lockfile
- RD-browser-in-sandbox
- RD-microvm-tier
- RD-provenance
- P0-T1
- P0-T2
- P0-T3
- P0-T4
- P0-T5
- P0-T6
- P0-T7
- P0-T8
- P5-T1
- P5-T2
- P5-T3
- P5-T4
- P5-T5
- P5-T6
- P5-T7
- P10-T1
- P10-T2
- P10-T3
- P10-T4
- P10-T5
- P10-T6
- P10-T7
- P10-T8
- P10-T9
- adjudication-D40-shell-parser
- adjudication-D31-gitleaks-codegen
- adjudication-native-binary-topology
- adjudication-P5-ordering

### Files
- .agents/sessions/polyglot-roadmap-v2/SPEC.md
- .agents/sessions/polyglot-roadmap-v2/PLAN.md
- .agents/sessions/polyglot-reaudit-2026-09-28/AUDIT-REPORT.md
- .agents/sessions/language-fit-audit-2026-09-28/findings/cb-sdk-tools.md
- .agents/sessions/language-fit-audit-2026-09-28/findings/cb-sdk-core.md
- .agents/sessions/language-fit-audit-2026-09-28/findings/cb-common.md
- .agents/sessions/language-fit-audit-2026-09-28/findings/cb-cli-services.md
- .agents/sessions/language-fit-audit-2026-09-28/findings/cb-sdk-services.md

### Domains
- security
- dependency-hygiene
- correctness
