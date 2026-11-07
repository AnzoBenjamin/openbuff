# Audit findings: w2-sdk-core

- Subsystems: sdk
- Features: sdk-run, llm-provider, filesystem-tools, mutation-broker, terminal-policy, env-allowlist, ripgrep-bundling
- Files covered: 16
- Snapshot: 49801b44e84d3d8fa583c3ebd9b2855228bf122572b7cdf5f78c77b3389d824d

## [HIGH] security — sdk/src/env.ts:69 — [POLY] Child-process env strips only 8 hardcoded key names; configured apiKeyEnv secrets (OPENCODE_GO_API_KEY, GLM_API_KEY, AWS_BEARER_TOKEN_BEDROCK, FREEMODEL_API_KEY, GEMINI/GOOGLE keys) leak to every terminal command
- **Risk:** getChildProcessEnv deletes BYOK_OPENROUTER, ChatGPT OAuth, OPENBUFF/CODEBUFF_API_KEY, OPENAI/ANTHROPIC/OPENROUTER_API_KEY only. The shipped presets in provider-config.ts use OPENCODE_GO_API_KEY, GLM_API_KEY, AWS_BEARER_TOKEN_BEDROCK, FREEMODEL_API_KEY as apiKeyEnv; these remain visible to run_terminal_command children, build scripts (build.rs, setup.py, gradle plugins, postinstall) and any compromised dependency. The docstring claims provider credentials are removed, which is only true for three providers.
- **Fix:** Derive the strip set dynamically: union of the static list plus every provider.apiKeyEnv in loadProviderConfigSync() (and OPENBUFF_PROVIDER_CONFIG-resolved configs). Add a test that a preset apiKeyEnv is absent from getChildProcessEnv(). Positive note: because this is a denylist, toolchain vars (GOPATH, CARGO_HOME, RUSTUP_HOME, JAVA_HOME, VIRTUAL_ENV, PYENV_ROOT, SDKMAN_DIR, DOTNET_ROOT, ANDROID_HOME) are correctly preserved — keep denylist semantics for those.
- **Evidence:** env.ts:69-80 deletes exactly 8 named keys; provider-config.ts presets: opencode-go apiKeyEnv 'OPENCODE_GO_API_KEY', glm 'GLM_API_KEY', bedrock 'AWS_BEARER_TOKEN_BEDROCK', freemodel 'FREEMODEL_API_KEY'. run-terminal-command.ts spreads getChildProcessEnv() into processEnv for both SYNC and BACKGROUND paths.

## [HIGH] security — sdk/src/tools/terminal-command-policy.ts:1255 — [POLY] read-only / librarian-read-only profiles allow build tools and script runners that execute repository-controlled code (cargo build/run/test with build.rs, go generate, gradle/mvn plugins, python x.py, make <target>, dotnet build, mix compile, bundle exec)
- **Risk:** findReadOnlyDanger only denies interpreter one-liners (-c/-e with env/write heuristics), 'make install', package managers, and a verb list for git/kubectl/docker/gh. Any command that runs repository code is allowed in read-only: `cargo test` runs build.rs and proc-macros, `go generate` runs arbitrary directives, `./gradlew check` executes build logic, `python manage.py migrate` or `python script.py` runs anything, `make` default target is arbitrary. These write target/, build/, .gradle/, __pycache__ and can mutate the workspace or exfiltrate, defeating the read-only guarantee relied on by file-picker/researcher/librarian agents. The TS-centric regexes block `node -e` but not `node script.js` either, so this is not polyglot-only, but non-TS ecosystems have far more implicit-execution entry points.
- **Fix:** Invert read-only to an allowlist of inspection executables (cat/ls/rg/grep/head/tail/wc/git read verbs/`cargo metadata`/`go list`/`go env`/`pip show`/`dotnet --info`, etc.) instead of a danger denylist; everything that invokes a build graph or interpreter on a file is denied. Per D10/P5-T1 this belongs in the sandbox shim's parsed-argv classifier; until then add an explicit deny list for build/run verbs of cargo, go, gradle(w), mvn(w), dotnet, swift, mix, bundle exec, rake, composer run, poetry run, uv run, python/ruby/node/bun <file>, make.
- **Evidence:** terminal-command-policy.ts findReadOnlyDanger dangerousCommands array: only 'make\s+install', interpreter `(-c|-e)` forms gated on process.env/open/write keywords; no cargo/go/gradle/mvn/dotnet/swift/mix entries. evaluateTerminalCommandPolicy read-only branch runs findReadOnlyDanger per segment and otherwise allows.

## [HIGH] correctness — sdk/src/tools/change-file.ts:1342 — [BEST][POLY] UTF-8 BOM / encoding asymmetry between read path and edit path: read_files strips BOM via TextDecoder, applyChange reads with Node 'utf-8' (BOM kept, lossy on invalid bytes) so freshness hashes disagree for BOM files
- **Risk:** read-files.ts decodeText and change-file.ts readOptionalText use `new TextDecoder('utf-8', {fatal:true})`, whose default ignoreBOM:false strips a leading U+FEFF. applyChange uses `fs.readFile(fullPath,'utf-8')` (Buffer.toString), which keeps U+FEFF and silently replaces invalid bytes with U+FFFD. getContentHash(oldContent) therefore differs from the hash the model obtained through read_files for every UTF-8-with-BOM file — the default for Visual Studio/.NET (.cs, .csproj, .sln), PowerShell, many Windows-authored Java/C++ files — producing permanent stale_state rejections on guarded str_replace/write_file. Unguarded full-file writes drop the BOM, changing bytes toolchains may depend on. The lossy decode also means a patch-type change against a Latin-1/Windows-1252 file (legacy Java/C#/Delphi) is applied to U+FFFD-corrupted text and committed.
- **Fix:** Use one decoder helper everywhere (read-files, change-file applyChange, readOptionalText, replace-range): decode with fatal:true and ignoreBOM:true, record `hasBom` + line-ending style in the snapshot, hash content consistently, and re-emit the BOM (and original CRLF) on commit. Refuse (not lossily decode) non-UTF-8 in applyChange. Add tests for BOM, CRLF, UTF-16, and Latin-1 fixtures across read→edit round trips.
- **Evidence:** read-files.ts:297 `new TextDecoder('utf-8', { fatal: true }).decode(bytes)`; change-file.ts:813 same decoder in readOptionalText; change-file.ts:1342 `await fs.readFile(fullPath, 'utf-8')` then getContentHash(oldContent) compared to change.expectedHash. No ignoreBOM option anywhere (search for FEFF/BOM/ignoreBOM in content-hash.ts and filesystem-authority.ts returned 0 matches).

## [MEDIUM] correctness — sdk/src/tools/run-terminal-command.ts:653 — [POLY] stdout/stderr decoded per chunk with Buffer.toString(): multi-byte UTF-8 split across chunk boundaries becomes U+FFFD
- **Risk:** `data.toString()` on each 'data' event corrupts characters split between pipe chunks (64KiB boundaries), which is routine for compiler/test output containing CJK/Cyrillic paths, messages localized by rustc/go/javac/dotnet (LANG=ja_JP), emoji in test names, etc. The model then sees garbled paths it cannot act on. appendCapped also slices by UTF-16 code units and can split surrogate pairs.
- **Fix:** Call childProcess.stdout.setEncoding('utf8') / stderr.setEncoding('utf8') (uses StringDecoder) or accumulate Buffers and decode once at close; slice caps on code-point boundaries. Add a test that feeds a 3-byte char split across two chunks.
- **Evidence:** run-terminal-command.ts:652-659 `childProcess.stdout.on('data', (data: Buffer) => { stdout = appendCapped(stdout, data.toString()) })` and same for stderr; no setEncoding call in the file.

## [MEDIUM] state-mutation — sdk/src/services/workspace-mutation-broker.ts:278 — [BEST][LANG] Broker create-exclusive and move depend on hard links (fs.link); fail entirely on filesystems without hard-link support, and Windows rename has no EBUSY/EPERM retry
- **Risk:** conditionalCommit(expectedHash=null) links staging→target and conditionalMove links source→destination then unlinks. On FAT/exFAT, many SMB/NFS mounts, some container/virtualized mounts and Windows network drives, link() returns EPERM/ENOTSUP/EXDEV, so every file creation and every move through the broker throws — all guarded creates fail closed for users on those volumes. On Windows, fs.rename over a file held open by an IDE indexer/antivirus (common with Visual Studio, Rider, IntelliJ on .gradle/obj trees) returns EPERM/EBUSY with no retry, surfacing as write failures.
- **Fix:** Add a capability probe at broker create and a fallback: open(target,'wx') + write + fsync for create; for move use rename with a pre-check under the workspace lock. LANG verdict: YES for the primitive only — expose renameat2(RENAME_NOREPLACE/RENAME_EXCHANGE) and O_TMPFILE+linkat on Linux, MoveFileExW without MOVEFILE_REPLACE_EXISTING + ReplaceFileW on Windows, renamex_np(RENAME_EXCL) on macOS via the Rust workspace napi addon; keep receipts/journal logic in TS. Add bounded retry with backoff for Windows EPERM/EBUSY/EACCES on rename.
- **Evidence:** workspace-mutation-broker.ts:278 `await fs.link(stagingPath, target.absolutePath)` for creates; :462 `await fs.link(source.absolutePath, destination.absolutePath)` for moves; :297 `await fs.rename(stagingPath, target.absolutePath)` with no retry; EEXIST is the only code handled specially.

## [MEDIUM] performance — sdk/src/services/workspace-mutation-broker.ts:246 — [BEST] Every broker mutation serializes on one workspace-wide mkdir lock with 20ms polling and performs ~8-10 fsyncs (lock owner, state.json revision, pending receipt, staged file, dirs, final receipt)
- **Risk:** edit_transaction with N files and parallel agents all contend on a single `${brokerDir}.lock` directory; each commit re-runs recoverPendingReceipts (readdir) and writes state.json + pending + final receipt durably. On slow disks/NFS/Windows Defender-scanned dirs this is tens-hundreds of ms per file and bounds throughput for large polyglot refactors (e.g. renaming a Java package touching hundreds of files). Receipts accumulate forever (listReceipts caps reads at 500 but never prunes).
- **Fix:** Batch: one lock acquisition and one revision bump per edit_transaction (add a conditionalCommitBatch API), group fsyncs of the receipts directory, derive revision from a monotonically named receipt instead of rewriting state.json, and add receipt pruning/compaction. Consider an OS advisory lock (flock/LockFileEx via napi) instead of mkdir polling.
- **Evidence:** workspace-mutation-broker.ts conditionalCommit → withWorkspaceLock → requireRecoveredWorkspace → prepareReceipt (readJson+writeJsonDurable state.json, writeJsonDurable pending) → writeStagedFile(sync) → rename → fsyncDirectory → finalizeReceipt (writeJsonDurable final, unlink pending, fsyncDirectory). acquireWorkspaceLock polls with DEFAULT_LOCK_POLL_MS = 20; RECEIPT_LIST_LIMIT comment 'no pruning this session'.

## [MEDIUM] correctness — sdk/src/provider-config.ts:1010 — [BEST] Provider config discovery and ancestor trust gate use process.cwd(), not the run's cwd option
- **Risk:** loadProviderConfigSync builds ancestor paths from process.cwd() and isTrustedProviderConfigPath/warnIfAncestorConfigHasApiKeyEnv use process.cwd() as projectRoot. SDK hosts (serve bridge, evals, IDE extensions) that pass `cwd` for a different repository load the wrong project openbuff.json, miss the target repo's routes/readableRoots, and classify the target repo's config as untrusted-ancestor (or the host's dir as trusted project). run.ts passes only `env`, never cwd, to loadProviderConfigSync.
- **Fix:** Add `cwd` to loadProviderConfigSync params, include it in the cache key, thread it from run()/getModelForRequest (via ModelRequestParams) and use it for ancestor discovery and trust classification.
- **Evidence:** provider-config.ts:1010 `...getAncestorProviderConfigPaths(process.cwd())`; :1395 `projectRoot: process.cwd()`; :1442 `warnIfAncestorConfigHasApiKeyEnv(config, sourceFilePaths, process.cwd())`. run.ts calls `loadProviderConfigSync(env ? { env } : {})`; model-provider.ts getModelForRequest calls `loadProviderConfigSync()` with no args.

## [MEDIUM] error-handling — sdk/src/impl/llm.ts:536 — [BEST] LLM request timeout is a single 10-minute wall clock over headers+full stream with no inactivity timeout
- **Risk:** withDefaultRequestTimeout uses AbortSignal.timeout(600_000) for the entire streamText call. A legitimately long reasoning generation (large-context refactors, high reasoning effort) exceeding 10 minutes is killed mid-stream; because content was already yielded, the catch path throws without retry/failover. Conversely a stream that stalls after the first token waits the full 10 minutes before recovery. Neither is configurable per provider.
- **Fix:** Split into a headers/first-chunk timeout (e.g. 60-120s) and an idle-between-chunks timeout (e.g. 90s) reset on each fullStream chunk, with the overall ceiling configurable in provider capabilities; classify the idle-timeout abort as transient so pre-content cases retry/failover.
- **Evidence:** llm.ts:528 DEFAULT_LLM_REQUEST_TIMEOUT_MS = 600_000; :536-541 AbortSignal.any([signal, AbortSignal.timeout(...)]); :1200 abortSignal: withDefaultRequestTimeout(streamParams.signal); catch block throws when anyContentYielded.

## [MEDIUM] correctness — packages/agent-runtime/src/util/token-counter.ts:229 — [POLY] Emergency-brake token budget uses a character-based estimate with an Anthropic fudge factor; undercounts non-English/CJK code and comments
- **Risk:** countTokens → estimateTokensForSerialized with a fixed per-model fudge; getMessagesForModelContext and countRequestOverheadTokens rely on it. Code bases with CJK/Cyrillic identifiers, comments or string resources tokenize at roughly 1 token per character on most BPE tokenizers, so the estimate can undershoot by 2-3x, the request-time trim does not fire, and the provider rejects the request. Recovery depends on getProviderContextLimitFromError parsing the error text once per failover model.
- **Fix:** Use a script-aware estimator (count non-ASCII code points at ~1 token each) or a real tokenizer per provider family when available; add a telemetry comparison of estimated vs provider-reported inputTokens to calibrate. (Estimator body not read; ratio behavior inferred from the fudge-factor design.)
- **Evidence:** token-counter.ts:229-234 countTokens delegates to estimateTokensForSerialized(text, model ?? 'anthropic/claude'); :241 comment 'legacy behavior (Anthropic 1.35)'. llm.ts getMessagesForModelContext/countRequestOverheadTokens use countTokensJson.

## [MEDIUM] security — sdk/src/tools/terminal-command-policy.ts:23 — [POLY] workspace-write deny list misses publish/deploy and global-install forms of non-JS ecosystems; dependency-mutation list misses common forms
- **Risk:** WORKSPACE_DENY_PATTERNS covers sudo, system package managers, rm -r /, and force git push only. `cargo publish`, `npm publish`, `twine upload`, `poetry publish`, `gem push`, `dotnet nuget push`, `mvn deploy`, `gradle publish`, `mix hex.publish`, `swift package-registry publish`, `cargo install`, `go install`, `pipx install`, `dotnet tool install -g` are all allowed in workspace-write and bypass harness approval unless classifyTerminalHarnessAction catches them (not verified here). DEPENDENCY_MUTATION_COMMANDS omits `python -m pip install`, `uv pip install`, `pipenv install`, `conda install`, `npm ci`, `pnpm i`, `bun i`, bare `yarn`, `go mod vendor`, `pod install`, `cargo generate-lockfile`, and pip installs without an active VIRTUAL_ENV (writes to user/system site-packages; only --user/--system flags are blocked).
- **Fix:** Add a registry-publish/global-install deny (or approval) class spanning cargo/npm/pnpm/yarn/bun/twine/poetry/uv/gem/nuget/mvn/gradle/mix/swift/go install/pipx, and extend dependency-mutation patterns; require VIRTUAL_ENV/.venv for pip. Per D10 implement this as argv-level rules in the P5-T1 sandbox shim parser rather than more regexes.
- **Evidence:** terminal-command-policy.ts:23-34 WORKSPACE_DENY_PATTERNS (4 entries); :671-689 DEPENDENCY_MUTATION_COMMANDS (npm/pnpm/yarn/bun, uv/poetry, pip, cargo add/rm/fetch/update, go get/mod tidy/download, dotnet, bundle, composer, swift, dart/flutter, mix, mvn, gradle).

## [MEDIUM] api-contract — sdk/src/tools/terminal-command-policy.ts:1 — [LANG] 2,450-line regex/hand-rolled shell lexer policy should be retired in favor of the sandbox shim's parsed-argv policy (confirms D10)
- **Risk:** The module contains at least five independent quote/escape scanners (scanActiveShellSyntax, extractSubstitutionsAndRemainder, tokenizeTmuxShellWords, splitReadOnlyShellSegments, quotedContentRanges) plus two near-duplicate command resolvers (resolveTmuxCommand vs resolveEnvironmentDumpCommand with divergent env -0 handling). None handle heredocs generally, ANSI-C quoting ($'..'), arithmetic, brace expansion, aliases or functions; each bypass fix adds another special case. This is the wrong layer to enforce policy: bash re-parses the string after the check.
- **Fix:** Verdict: move enforcement to the P5-T1 shim (Rust, using a real POSIX shell parser such as tree-sitter-bash or conch-parser, then policy on resolved argv/execve), and demote this TS module to advisory pre-classification for UX messages. Keep the published SDK surface (TerminalPermissionProfile) unchanged. Until then, collapse the scanners into one tokenizer with a shared test corpus.
- **Evidence:** terminal-command-policy.ts: resolveEnvironmentDumpCommand skips '-0'/'--null' while resolveTmuxCommand does not; multiple scanners each reimplement quote/escape state machines; file endLine 2452.

## [LOW] api-contract — sdk/src/run.ts:1 — [BEST] run.ts is 2,870 lines with a ~40-branch handleToolCall if/else dispatcher and an inline approval state machine
- **Risk:** Tool dispatch, MCP approval, override attestation, terminal harness approval (grant/consume loop), workspace journal advance and change-observer notification are all in one function, making per-tool abort/typing discipline inconsistent (many `input as {...}` casts bypass the parsed clientToolCallSchema result) and hard to test in isolation.
- **Fix:** Extract a typed tool registry (Record<ClientToolName, handler(parsedInput, ctx)>) using the already-parsed schema output, move authorizeHighImpactAction into services/harness-enforcement, and keep run.ts as orchestration only.
- **Evidence:** run.ts handleToolCall: sequential `else if (toolName === ...)` branches from write_audit_findings through git_branch, with casts like `(input as { paths: string[] }).paths`, while `parsed = clientToolCallSchema.parse(normalizedAction)` is only used for run_terminal_command.

## [LOW] dependency-hygiene — sdk/src/native/ripgrep.ts:150 — [LANG] ripgrep fallback path still points at @codebuff/sdk and PATH lookup runs twice; keep rg as external binary
- **Risk:** The published-package fallback joins node_modules/@codebuff/sdk/dist/vendor, which never exists for @openbuff/sdk installs, and findExecutableOnPath is called twice with identical inputs. Harmless but misleading in the error message.
- **Fix:** Use the @openbuff/sdk package path (or resolve via import.meta.resolve), drop the duplicate PATH probe. LANG verdict: keep ripgrep as an external bundled binary — process isolation, streaming output and killability outweigh a grep-searcher napi port; no change of language warranted.
- **Evidence:** ripgrep.ts:150-160 distVendorPath uses '@codebuff', 'sdk'; findExecutableOnPath(binaryName, env) called at ~:143 and again at ~:164.

## Coverage receipt

### Subsystems
- sdk

### Features
- sdk-run
- llm-provider
- filesystem-tools
- mutation-broker
- terminal-policy
- env-allowlist
- ripgrep-bundling

### Files
- sdk/src/run.ts
- sdk/src/client.ts
- sdk/src/impl/llm.ts
- sdk/src/impl/failover.ts
- sdk/src/impl/model-provider.ts
- sdk/src/provider-config.ts
- sdk/src/tools/node-filesystem.ts
- sdk/src/tools/read-files.ts
- sdk/src/tools/change-file.ts
- sdk/src/services/workspace-mutation-broker.ts
- sdk/src/services/workspace-journal.ts
- sdk/src/tools/run-terminal-command.ts
- sdk/src/tools/terminal-command-policy.ts
- sdk/src/env.ts
- sdk/src/native/ripgrep.ts
- packages/agent-runtime/src/util/token-counter.ts

### Domains
- security
- correctness
- state-mutation
- error-handling
- performance
- dependency-hygiene
- test-coverage
- api-contract
