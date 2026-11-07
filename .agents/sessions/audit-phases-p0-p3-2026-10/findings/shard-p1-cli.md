# Audit findings: shard-p1-cli

- Subsystems: cli-entry-dispatch, cli-serve-command, cli-args-parsing, cli-trusted-roots, cli-deferred-registries, cli-tree-sitter-client, cli-terminal-notify, cli-terminal-images, cli-headless-run, cli-dash-command, cli-package-dependencies
- Features: NEW-2-serve-trust, serve-stdio-socket-dispatch, deferred-registry-loads-whenRegistriesReady, osc9-osc777-notify, da1-image-capability-query, headless-run-json-ndjson, dash-server-export, tui-attach-mode, tree-sitter-highlighting
- Files covered: 11
- Snapshot: 5c80253b458f8b07b8ca33e50cc3d6ad7e6cda07ef1715ba8adffd8c77905ab7

## [MEDIUM] security — cli/src/serve-command.ts:118 — Full process env handed to runServe as credentialEnv (secret over-exposure)
- **Risk:** The entire process environment (which may contain unrelated secrets: cloud tokens, CI secrets, other tools' API keys) is handed to runServe on both transports. Any SDK-side logging, journaling, or error serialization of credentialEnv, or an over-broad 'credential collection' match, can leak unrelated secrets into journals/logs or to connected ACP clients.
- **Fix:** Pass a filtered env containing only the configured credential keys the SDK's holdback actually needs (e.g. pick an explicit allowlist of CODEBUFF/OPENBUFF auth vars) instead of the full process environment.
- **Evidence:** serve-command.ts: `credentialEnv: getSystemProcessEnv()` appears on both the stdio return (line ~118) and socket listener (line ~133) paths; no filtering or allowlist of credential keys is applied before the env object crosses into the SDK.

## [MEDIUM] security — cli/src/utils/terminal-notify.ts:20 — OSC 9/777 notification body/title not sanitized for control characters (terminal escape injection)
- **Risk:** body/title are interpolated raw into OSC sequences. The approval-needed notification body is `Approval needed: ${request.target.slice(0, 80)}` where request.target derives from project/file content; a target containing BEL (\x07) or ESC (\x1b) terminates/starts new terminal sequences, enabling terminal escape injection (arbitrary window-title writes, OSC hyperlink/clipboard abuse) from attacker-influenced project content. This is a prompt-injection-adjacent surface on the controlling TTY.
- **Fix:** Strip control characters (at minimum ESC 0x1b and BEL 0x07, plus C1 0x9b) from title and body before interpolating into the OSC sequences, e.g. body.replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').
- **Evidence:** terminal-notify.ts builds `\x1b]9;${body}\x07` and `\x1b]777;notify;${title};${body}\x07` with no character filtering; create-run-config.ts:229-234 and send-message.ts:509-514 feed untrusted content in via writeToTty.

## [MEDIUM] security — cli/src/utils/tree-sitter-client.ts:213 — Predictable shared /tmp cache path for tree-sitter grammars/queries without per-user isolation
- **Risk:** The worker creates and reads `<dataPath>/tree-sitter/{languages,queries}` at a fixed, world-readable/writable shared /tmp location shared by all users of the machine. A local attacker can pre-create the directory (or plant files) before the CLI runs, poisoning cached grammars/highlight queries that the worker then loads (query/wasm content injection into the worker), or symlink the directory to redirect writes.
- **Fix:** Isolate per user/process: include process.getuid?.() (or a per-install random suffix created with mkdtemp) in the data path, and/or verify ownership/mode of the cache directory before first use.
- **Evidence:** tree-sitter-client.ts getTreeSitterDataPath(): `path.join(os.tmpdir(), 'codebuff-tree-sitter')` passed as `dataPath` to `new TreeSitterClient({...})`; docstring confirms the worker mkdirs and caches under that path.

## [MEDIUM] correctness — cli/src/utils/terminal-images.ts:139 — Kitty graphics sequences omit the quiet flag (q=1): kitty writes ACK responses back to stdin
- **Risk:** Kitty graphics protocol sends a response escape sequence back on the terminal's input for every transmit/display command unless quiet mode (q=1/q=2) is requested. renderInlineImage sequences without q= cause kitty to inject `\x1b_G...\x1b\\` responses into stdin, which the TUI reads as garbage keypresses and would corrupt any protocol-wire consumer sharing stdin.
- **Fix:** Add `q=1` (or q=2) to kvPairs so kitty suppresses graphics-response escape sequences; validate the chosen value against the kitty graphics protocol spec before release.
- **Evidence:** terminal-images.ts generateKittyImageSequence builds kvPairs ['a=T','f=100','t=d',...] and optional c/r/i keys only; grep shows no `q=` anywhere in the module or its callers (image-card.tsx).

## [MEDIUM] correctness — cli/src/utils/terminal-images.ts:219 — parseDa1ImageCapability (DA1 capability query) has no production call site — plan claim unwired
- **Risk:** The audit context's plan claims a 'DA1 image capability query'; only the pure parser exists. detectTerminalImageSupport() (env-only) is what production consumes, so terminals that advertise image support via DA1 rather than env vars are never detected, and the claimed capability-query feature is effectively absent. Silent dead code also drifts from tests that assert behavior no production path exercises.
- **Fix:** Wire parseDa1ImageCapability into the renderer-path capability probe (run the time-bounded DA1/XTGETTCAP query in the wiring layer, feed the response into detection) or remove the function and the plan claim.
- **Evidence:** referencedBy for parseDa1ImageCapability lists only cli/src/utils/__tests__/terminal-images.test.ts and a comment in image-block.test.tsx; code_search for the symbol shows no non-test import. index.tsx:~660 gates on `detectTerminalImageSupport() === 'kitty'` only.

## [MEDIUM] correctness — cli/src/services/deferred-registries.ts:22 — registriesPromise never invalidated on project switch; whenRegistriesReady resolves with stale promise after switchProjectContext re-init
- **Risk:** After switchProjectContext (index.tsx handleProjectChange) re-initializes the agent/skill registries directly, registriesPromise still holds the original (already-resolved) load promise. Subsequent consumers gating on whenRegistriesReady() resolve immediately and can read a stale or mid-reinit registry for the newly selected project. Additionally, awaitRegistriesReady silently ignores its options when a load already started, so a caller passing a different trust decision gets the first caller's decision with no signal — a latent path for trust decisions to be applied to the wrong context.
- **Fix:** Add a reset seam (or make startDeferredRegistryLoads return a per-context promise keyed by project root) so whenRegistriesReady reflects the active project's registry state, and reject/merge conflicting options explicitly.
- **Evidence:** deferred-registries.ts: registriesPromise set once in startDeferredRegistryLoads, never cleared; awaitRegistriesReady awaits `registriesPromise` even when called with different options than the first start. index.tsx handleProjectChange calls initializeAgentRegistry/initializeSkillRegistry directly without touching this module.

## [LOW] correctness — cli/src/utils/trusted-roots.ts:8 — Realpath applied only to projectRoot; allowlist entries only path.resolve'd (asymmetric canonicalization)
- **Risk:** The 'fail-closed realpath check' is asymmetric: only the project root is realpath'd. An allowlist entry recorded as a symlink path (e.g. /home/user/link-to-repo) resolves via path.resolve to the symlink path and will never equal the realpath'd project root — trust silently fails to apply after a dir is replaced/moved/remounted, with no warning distinguishing 'not allowlisted' from 'allowlist entry stale'. Security direction is fail-closed (no widening), but the allowlist contract silently desyncs.
- **Fix:** Canonicalize both sides the same way: realpath the allowlist entries at load time (or document that entries must be real paths and warn on symlinked entries), keeping the fail-closed direction.
- **Evidence:** index.tsx: `effectiveTrust = isTrustedProjectRoot(fs.realpathSync(projectRoot), await loadTrustedRoots())`; trusted-roots.ts isTrustedProjectRoot: `path.resolve(root) === resolvedRoot` with no realpathSync on entries.

## [MEDIUM] security — cli/src/cli-args.ts:139 — Empty --socket value passes the typeof-string check and selects socket transport with an empty socketPath
- **Risk:** `openbuff serve --socket ''` passes the typeof check and selects socket transport with socketPath '' instead of failing closed like the sibling --socket-token/--token/--export empty-value checks. Behavior is delegated to the SDK's bind (obscure error or unintended default) rather than the documented fail-closed arg contract.
- **Fix:** Reject empty/whitespace-only --socket values via serveProgram.error, mirroring the --socket-token SEC-4 check.
- **Evidence:** cli-args.ts serve branch: `typeof serveOpts.socket === 'string' ? { transport: 'socket', socketPath: serveOpts.socket, ... }` — no non-empty check; contrast the explicit empty-token rejection two blocks below.

## [MEDIUM] error-handling — cli/src/index.tsx:740 — Non-renderer command paths run without any top-level error boundary; failures surface as unhandled rejections
- **Risk:** main() is invoked as `void main()` with no .catch, and the early uncaughtException/unhandledRejection handlers are installed only after the non-renderer command paths return. On serve/mcp/run/replay/dash, a failure in initializeApp, awaitRegistriesReady, getClient(), or runAcpServeCommand becomes an unhandled rejection handled only by runtime defaults — exit code is runtime-dependent and stderr diagnostics are inconsistent, breaking the documented 'exit code reflects outcome' contract for headless consumers (run/replay CI usage).
- **Fix:** Wrap the serve/mcp/run/replay/dash dispatch blocks in try/catch that writes a single stderr line and sets process.exitCode = 1, or install the unhandledRejection handler before dispatch with a non-TTY variant that does not touch the terminal.
- **Evidence:** index.tsx ends with `void main()`; the `process.on('uncaughtException'/'unhandledRejection', earlyFatalHandler)` registrations appear only after all non-renderer command blocks have returned; serve-command.ts has no try/catch around `await getClient()`.

## [LOW] error-handling — cli/src/utils/trusted-roots.ts:87 — Malformed trusted-roots.json silently degrades to empty allowlist with no warning
- **Risk:** A user who configured trusted-roots.json with invalid JSON, a non-array payload, or one non-string entry gets an empty allowlist with zero feedback — serve runs untrusted while the user believes trust was granted, and the only observable difference is the stderr banner in serve-command.ts. Silent fail-closed without a diagnostic makes the misconfiguration indistinguishable from 'file absent'.
- **Fix:** Emit one stderr line (path, reason category, never contents) for each fail-closed rejection cause, matching the permission-warning pattern already present.
- **Evidence:** trusted-roots.ts: the catch blocks for readFile, JSON.parse, Array.isArray, and the non-string-entry early return all `return []` with no warn call; only the (mode & 0o077) branch calls warn().

## [MEDIUM] correctness — cli/src/commands/dash-command.ts:165 — existsSync→openJournal TOCTOU can make the dash create the journal db, violating the documented 'dash never creates the db' invariant
- **Risk:** Between existsSync(journalPath) and openJournal(journalPath) the file can be removed; createRunJournal then creates a fresh empty db (the module's own comment says the dash must 'never create the db'), and the dashboard serves fabricated empty-but-present state from a file it created, racing a live WAL writer — the exact hazard the comment claims is prevented.
- **Fix:** Open with a read-only/SQLITE_OPEN_READONLY-style flag (or add a create:false option to createRunJournal) so the opener itself cannot create the file, and treat 'no file at open' as the empty-data fallback.
- **Evidence:** dash-command.ts openJournalIfPresent(): `if (!existsSync(journalPath)) return undefined;` then `return openJournal(journalPath)` where defaultOpenJournal calls `createRunJournal({ path: journalFile })` without a read-only open flag.

## [LOW] error-handling — cli/src/commands/run-command.ts:110 — Headless run has no default timeout/abort path; a hung client.run blocks CI indefinitely
- **Risk:** runHeadlessCommand passes deps?.signal straight through with no default and no deadline; a hung model/stream/network call in client.run blocks forever with ndjson already partially emitted. CI/headless consumers get no timeout and no partial-failure exit signal (only the final error line if the promise eventually rejects).
- **Fix:** Support a --timeout/-max-duration option (or an AbortSignal wired to SIGINT/SIGTERM) that aborts client.run and maps cancellation to a defined nonzero exit code.
- **Evidence:** run-command.ts: `await client.run({ agent..., prompt..., handleEvent, journalWriter, journalReader, signal: deps?.signal })` — signal only when a caller injects one; index.tsx run dispatch passes none.

## [MEDIUM] test-coverage — cli/src/services/deferred-registries.ts:1 — No tests for deferred-registries module or for index.tsx effectiveTrust trust-resolution invariant
- **Risk:** The two core P1 claims of the plan — deferred registry gating (whenRegistriesReady/awaitRegistriesReady start-once semantics, silent option-drop, never-rejects contract) and NEW-2 effectiveTrust resolution (serve flag OR allowlist, fail-closed realpath catch, top-level flag cannot widen serve trust) — have no test asserting them. Regressions in trust resolution (e.g. someone widening trust from session state) would pass CI.
- **Fix:** Add a deferred-registries unit suite (first-call wins, awaitRegistriesReady starts-and-awaits, never rejects) and an index-level dispatch test asserting effectiveTrust resolution for serve under flag/allowlist/corrupt-file cases.
- **Evidence:** referencedBy/glob show no cli/src/services/__tests__/deferred-registries*.test.ts and no test importing effectiveTrust logic from index.tsx; trusted-roots.test.ts covers only the pure allowlist functions.

## [LOW] state-mutation — cli/src/utils/terminal-images.ts:10 — cachedProtocol module-level cache never invalidated and has no test reset seam
- **Risk:** detectTerminalImageSupport memoizes the first env-derived result process-wide with no reset seam; in bun --isolate test workers a suite that triggers detection with a stubbed env pins the protocol for later suites in the same worker, and any runtime path that could legitimately see a changed environment (none today) would get stale results.
- **Fix:** Add a reset seam for tests (mirroring resetTreeSitterClientStateForTests) or move the cache behind an injectable store.
- **Evidence:** terminal-images.ts: `let cachedProtocol: TerminalImageProtocol | null = null` set inside detectTerminalImageSupport; no resetTreeSitter-style test seam exists in this module (unlike tree-sitter-client.ts which exports one).

## [LOW] dependency-hygiene — cli/package.json:56 — react-dom declared as devDependency while sibling runtime deps suggest a runtime import path
- **Risk:** react-dom@19.2.0 sits in devDependencies while react and the OpenTUI react renderer are runtime dependencies; if any runtime module (or @opentui/react's peer resolution) imports react-dom in a production install, the built binary/package breaks. Minor: most runtime deps use caret ranges (^) rather than pins while @opentui/core/react are exact — inconsistent supply-chain drift exposure.
- **Fix:** Move react-dom into dependencies if imported at runtime (or confirm @opentui/react bundles it), and consider a lockfile-driven CI check for floating-range drift on runtime deps.
- **Evidence:** cli/package.json dependencies vs devDependencies: react 19.2.0 (deps) vs react-dom 19.2.0 (devDeps); @opentui/core exact-pinned while commander, zod, immer etc. use ^ ranges.

## [LOW] performance — cli/src/commands/run-command.ts:88 — Per-event process.stdout.write without backpressure: unbounded memory on a slow pipe in --json mode
- **Risk:** In --json mode every PrintModeEvent is written with process.stdout.write without backpressure handling; when stdout is a slow pipe/file and the agent streams a large event volume, Node buffers the unwritten chunks in memory without bound (no await-drain / no stream pipeline), so a long headless run can grow memory until OOM.
- **Fix:** Batch ndjson lines and respect write() backpressure (await drain or use a writable stream with buffering limits), or cap buffered bytes and apply backpressure to the run.
- **Evidence:** run-command.ts: `writeStdout(JSON.stringify(event) + '\n')` per PrintModeEvent; default writeStdout is process.stdout.write with no drain handling anywhere in the module.

## [LOW] correctness — cli/src/cli-args.ts:128 — --stdio is declared but ignored when combined with --socket (silent transport precedence)
- **Risk:** `openbuff serve --stdio --socket /tmp/s.sock` silently picks socket transport because the socket branch wins whenever --socket is a string; the declared --stdio flag is never consulted. Users scripting the documented default (stdio) get a socket server and a generated-token stderr line instead.
- **Fix:** Either error on --stdio together with --socket or make the precedence explicit in the option description and returned type.
- **Evidence:** cli-args.ts serve branch: `.option('--stdio', ...)` is parsed into serveOpts.stdio but never read; transport selection is `typeof serveOpts.socket === 'string' ? socket : stdio`.

## [LOW] security — cli/src/serve-command.ts:126 — Socket path passed to runServe without existence/symlink pre-check (IPC endpoint plant/reuse)
- **Risk:** Socket mode binds at a user-supplied path with no pre-flight check in the CLI layer: a pre-existing file/symlink at socketPath is handed straight to the SDK. If the SDK's bind follows a pre-planted symlink (or reuses an existing socket), the IPC endpoint can be redirected by a local attacker who can write to the target directory; combined with token auth this is mitigated but the bind target itself is unvalidated.
- **Fix:** lstat the socket path before bind: refuse if it exists and is not a socket, refuse symlinks, and unlink only a pre-existing plain socket file after verifying ownership.
- **Evidence:** serve-command.ts: `transport: { kind: 'socket', socketPath: args.socketPath, token }` with no lstat/unlink/validation of args.socketPath in the CLI layer; the token generation path (randomBytes(32)) is sound and never touches stdout.

## Coverage receipt

### Subsystems
- cli-entry-dispatch
- cli-serve-command
- cli-args-parsing
- cli-trusted-roots
- cli-deferred-registries
- cli-tree-sitter-client
- cli-terminal-notify
- cli-terminal-images
- cli-headless-run
- cli-dash-command
- cli-package-dependencies

### Features
- NEW-2-serve-trust
- serve-stdio-socket-dispatch
- deferred-registry-loads-whenRegistriesReady
- osc9-osc777-notify
- da1-image-capability-query
- headless-run-json-ndjson
- dash-server-export
- tui-attach-mode
- tree-sitter-highlighting

### Files
- cli/src/index.tsx
- cli/src/serve-command.ts
- cli/src/cli-args.ts
- cli/src/utils/trusted-roots.ts
- cli/src/services/deferred-registries.ts
- cli/src/utils/tree-sitter-client.ts
- cli/src/utils/terminal-notify.ts
- cli/src/utils/terminal-images.ts
- cli/src/commands/run-command.ts
- cli/src/commands/dash-command.ts
- cli/package.json

### Domains
- security
- correctness
- state-mutation
- error-handling
- performance
- dependency-hygiene
- test-coverage
- api-contract
