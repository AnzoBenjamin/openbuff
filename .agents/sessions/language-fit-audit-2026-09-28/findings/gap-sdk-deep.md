# Audit findings: gap-sdk-deep

- Subsystems: sdk
- Features: terminal-command-policy-lexers, terminal-command-policy-regex-classifiers, terminal-policy-os-sandbox-gap, harness-action-classifier, harness-command-hash, harness-approval-store, browser-cdp-orchestration, browser-apng-codec, browser-pixel-diff, browser-chrome-discovery-launch, browser-injected-scripts-keymap, background-job-process-tree, background-job-pid-identity, background-job-log-files, background-job-line-framing, read-logs-tail, find-files-symbol-extraction, ripgrep-flag-tokenizer, change-review-snapshot, replace-range-splice, opencode-go-responses-translation, error-utils, thin-tool-wrappers, write-audit-findings-render
- Files covered: 17
- Snapshot: 49801b44e84d3d8fa583c3ebd9b2855228bf122572b7cdf5f78c77b3389d824d

## [HIGH] security — sdk/src/tools/terminal-command-policy.ts:442 — Shell lexing in the terminal policy (at least 12 hand-rolled lexers/tokenizers): HYBRID (one AST authority; sh-syntax WASM now, then Rust brush-parser)
- **Risk:** The file has 12+ separate quote/escape scanners, and they disagree on edge cases. Security decisions rest on whichever scanner a profile happens to call. The inventory: (1) whitespace split in isSafeShellSetOptions:52, isExportAssignmentForm:76, envRestUtilityBasename:98, hasMutationOrientedShellSetOptions:146; (2) extractSubstitutionsAndRemainder:442 with nested takeParenBody/takeBacktickBody; (3) scanActiveShellSyntax:733 and its matchers at :769/:778/:786/:793; (4) hasActiveTmuxCompoundShellSyntax:801, its own keyword scanner; (5) tokenizeTmuxShellWords:925, a quote-removal word lexer; (6) two command resolvers that have drifted apart, resolveEnvironmentDumpCommand:256 and resolveTmuxCommand:981. Only the first accepts env -0/--null and command -p/-v/-V and unwraps nice/timeout/busybox; (7) the regex token splitter /(?:[^\s"']+|"[^"]*"|'[^']*')+/g is copied into findTraversalPath:1071, findEscapingTraversalPath:1266, findOutsideAbsolutePath:1928, and the git add path parse in evaluateTerminalCommandPolicy (~:2300); (8) splitReadOnlyShellSegments:1086; (9) four redirection parsers: stripSafeReadOnlyRedirections:1155, hasUnsafeTmuxWriteRedirection:1174, DIAGNOSTIC_WRITE_REDIRECTION_PATTERN:1391 + stripDiagnosticRedirections:1418, BOUNDED_DIAGNOSTIC_HEREDOC_PATTERN:1405; (10) quotedContentRanges:1844; (11) the bare-home operand scan in findOutsideAbsolutePath, which uses command.split(/\s+/) and is not quote-aware; (12) splitFlagTokens in find-files-matching-content.ts:755. None of these models ANSI-C $'..' quoting, brace/tilde expansion, arithmetic $((..)), here-strings, or line continuation. Each profile therefore sees a different command.
- **Fix:** Build a single parse, ParsedCommand = parse(cmd) → AST (lists, pipelines, simple commands with resolved argv[0] after assignment/env/command/wrapper unwrapping, redirects with fd and target, substitutions as child nodes, heredocs with quoted-delimiter flag). Every profile and the harness classifier then walk that AST instead of re-lexing the string. It replaces items 1-11. NOW: consume sh-syntax (the mvdan/sh WASM build) from TS; it exposes a typed AST and needs no new runtime. LATER, once a Rust sidecar exists for sandboxing/process supervision, move the parse to brush-parser, which has the highest bash fidelity (tree-sitter-bash has open fidelity bugs, so avoid it). Keep the TS profile rules as AST visitors. Anything the parser cannot represent must fail closed. Cost: about 1-2 weeks to port the profiles plus differential tests against the existing terminal-command-policy.test.ts corpus. Confidence: high.
- **Evidence:** Function starts are listed above. For example, resolveTmuxCommand:981 skips only -i/--ignore-environment for env, while resolveEnvironmentDumpCommand:256 also skips -0/--null. hasUnsafeTmuxExecutable:1054 uses the former and the env-dump gate uses the latter, so the same segment resolves to different executables depending on the profile.

## [HIGH] security — sdk/src/tools/terminal-command-policy.ts:23 — Regex command classifiers anchored at string start: MOVE→AST visitors (TS, sh-syntax now / brush-parser later)
- **Risk:** Many deny/allow regexes are anchored with ^ against the whole normalized command, not per segment. Examples: WORKSPACE_DENY_PATTERNS:23 (sudo/su, system package managers, force/delete push) and the dependency list DEPENDENCY_MUTATION_COMMANDS:671. In the workspace-write profile, per-segment checks (~:2420) only test outside-path containment. So `true && sudo x` or `cd . && git push --force origin main` would not match the anchored deny patterns. This is from reading the code; I did not execute it. The read-only profiles do split into segments first (findReadOnlyDanger:1461 per segment), so their exposure is smaller. Other regex classifiers in the file: findReadOnlyDanger:1461 (14 patterns), findReadOnlyMutation:1536, isReadOnlyGitCommand:1641 (13 alternations), isAllowedComplexGitCommand:1695 (about 20 guards plus 9 allow regexes), stripCommitMessageArgs:1564, hasPlaceholderCommitMessage:1609, hasUnsafeReadOnlyGitOption:1625, MUTATION_EXECUTABLE_COMMAND_PATTERN:1889, the inline shell-indirection regex (~:2395), and the tmux inline npm/git regexes (~:2150).
- **Fix:** Evaluate deny rules against every simple-command node of the AST, after argv[0] resolution, not against the raw string. Express the git rules as argv matchers (subcommand plus flag set) rather than regexes over quoted text. That removes the stripCommitMessageArgs workaround, because -m values become ordinary argv entries. Verdict: KEEP the rule logic in TS, but move it onto the AST from the finding above. Unlocks now: deny rules hold across &&, ;, | and newlines. Unlocks next: the same visitors can be reused by the harness classifier. Cost: medium. Confidence: high for the anchoring (read directly from the code); I did not execute the bypass.
- **Evidence:** WORKSPACE_DENY_PATTERNS:23-34 all begin with ^. In evaluateTerminalCommandPolicy, the workspace-write branch runs `for (const [pattern, reason] of WORKSPACE_DENY_PATTERNS) if (pattern.test(command))` on the whole command string, then loops over segments calling only findWorkspaceSegmentOutsidePath/findOutsideAbsolutePath.

## [MEDIUM] security — sdk/src/tools/terminal-command-policy.ts:2092 — String policy used as the only containment layer: CONSUME an OS sandbox (bubblewrap+seccomp on Linux, Seatbelt on macOS) through a Rust helper
- **Risk:** evaluateTerminalCommandPolicy is a pre-exec lexical gate. The file itself says it cannot authorize later filesystem opens (comments at hasUnsafeTmuxWriteRedirection:1167 and hasUnsafeTmuxFileMutation:1231: 'a policy-time path check cannot safely authorize a later filesystem open'). Any lexer gap is a full escape, because nothing enforces anything at the kernel level.
- **Fix:** Move enforcement into the kernel, following Codex's Linux approach: bubblewrap for mount/network namespaces plus seccomp (not Landlock-only), and sandbox-exec/Seatbelt profiles on macOS. Launch through a small Rust helper that pairs with process-wrap for supervision. Keep the AST policy as the UX/intent layer that produces clear denial reasons. Verdict: CONSUME, with the Rust launcher. Unlocks now: read-only and workspace-write profiles become real, so the 60+ regexes stop being security-critical. Unlocks next: the tmux-test fixture writes that the comments say need 'a dedicated executor' become possible. Cost: high; per-platform work. Confidence: medium-high.
- **Evidence:** Comments at :1167-1172 and :1231-1235. The only enforcement is `return { allowed: true|false }` at :2092 onward.

## [HIGH] security — sdk/src/services/harness-enforcement.ts:167 — Harness action classifier (about 14 anchored regexes): MOVE→shared AST visitor (TS on the sh-syntax/brush-parser AST)
- **Risk:** classifyTerminalHarnessAction:167 tests anchored regexes (^git\s+push, ^git\s+commit, ^(?:kubectl|helm|terraform…), ^(?:curl|wget)…, the ^rm deletion regex, ^find) against the whole command. Only the FIRST command of a composition gets classified. `cd repo && git push origin main` returns undefined, so evaluateHarnessActionPolicy:338 never sees a push, and the default-branch push approval (:360-369) and high-impact approvals are skipped. Some rules use \b instead of ^, such as the migration rule at ~:245, so behavior is inconsistent across rules. The dependency-install regex at ~:237 is a second copy of DEPENDENCY_MUTATION_COMMANDS (terminal-command-policy.ts:671), so the two can drift.
- **Fix:** Classify every simple-command node from the shared AST and return the highest-risk action, or a list of actions. Derive the dependency and publish tables from one shared exported table. Verdict: MOVE to the AST (stays TS). Cost: low once the AST exists. Confidence: high (read from the code, not executed).
- **Evidence:** harness-enforcement.ts:176 `command.match(/^git\s+push(?:\s+(.+))?$/i)`; :206 `/^git\s+commit\b/i`; :285 `/^(?:(?:command|exec)\s+)?rm\s+-[^\n]*r[^\n]*\s+(.+)$/i`. All anchored at string start.

## [LOW] correctness — sdk/src/services/harness-enforcement.ts:147 — hashCommand normalization: KEEP TS (node:crypto), but hash the canonical AST form
- **Risk:** normalizeCommand:147 collapses ALL whitespace, including newlines and whitespace inside quotes. The terminal policy's normalizeCommand (terminal-command-policy.ts:691) deliberately keeps newlines as separators. As a result, `a\nb` (two commands) and `a b` (one command) share an approval hash, and so do `echo 'x  y'` and `echo 'x y'`. That weakens the 'bind approval to the EXACT command' guarantee claimed at :150-155.
- **Fix:** Hash the raw command bytes, or a canonical serialization of the parsed AST. Do not use a lossy regex-normalized string. sha256 via node:crypto stays as is. Cost: trivial. Confidence: high.
- **Evidence:** harness-enforcement.ts:147-158 vs terminal-command-policy.ts:691-695.

## [LOW] correctness — sdk/src/services/harness-enforcement.ts:42 — Approval/ownership record services: KEEP TS
- **Risk:** HarnessApprovalService.consume:69 correctly serializes read-modify-write under withKindLock. ChangeOwnershipService:303 validates paths only with a `..` substring check. This is plain I/O-bound record logic; no other language would help.
- **Fix:** Keep in TS. The only suggested change is to reuse the project's canonical path containment helper instead of change.path.includes('..'). Confidence: high.
- **Evidence:** harness-enforcement.ts:85-118 (withKindLock), :317 (includes('..')).

## [LOW] correctness — sdk/src/tools/browser-logs.ts:133 — CDP orchestration (sessions, pipe transport, event routing, probing, input dispatch): KEEP TS
- **Risk:** This is protocol orchestration, and TS is the right fit. It covers: browserLogs dispatcher:133, spawn dedupe shareInFlightBrowserSpawn (~:680), ensureBrowserSession, detectPipeSupport:831 (positive-only per-executable cache, fails closed on timeout instead of falling back to the unauthenticated port), spawnPipeConnection:1169/spawnPortConnection:1213, connectPage flatten attach + pending-event buffer, routeEvent:1540, recordNetworkEvent:1759, frame/context resolution, and the input/cookie/tab/recording handlers. Rewriting it in Rust would buy nothing, because the latency is all in Chrome. A consume alternative exists: puppeteer-core with pipe:true offers the same private-pipe transport. However, the hand-written transport here has deliberate security properties (redacted DevTools URL, no port fallback on timeout), and switching would mean re-auditing them. chromeSandboxArgs:592 falls back to --no-sandbox when it cannot tell whether the sandbox will work. It also does not probe Ubuntu 24.04's kernel.apparmor_restrict_unprivileged_userns, so it can pick sandboxed mode and then Chrome fails to launch.
- **Fix:** KEEP. Optionally add a probe of /proc/sys/kernel/apparmor_restrict_unprivileged_userns in chromeSandboxArgs. Revisit puppeteer-core only if keeping up with CDP churn becomes costly. Confidence: high.
- **Evidence:** browser-logs.ts:133, :592-632, :831-940, :1169-1260, :1540-1570.

## [MEDIUM] correctness — sdk/src/tools/browser-logs.ts:3188 — Hand-rolled APNG/PNG chunk codec and CRC32: CONSUME (upng-js for APNG, zlib.crc32 / Bun.hash.crc32 for CRC)
- **Risk:** buildApng:3188, parsePngChunks:3233, writePngChunk:3247, frameControlData, makeCrcTable:3309 and crc32:3321 are a hand-written binary codec. It has correctness gaps. (a) Every frame is written with the FIRST frame's IHDR width/height, and IHDR is taken only from the first frame. Page.screencastFrame sizes change when the viewport, device metrics, or fullPage change, so later IDAT data gets decoded under the wrong dimensions and the APNG is corrupt. (b) Per-frame bit depth, colour type and PLTE are not checked. (c) parsePngChunks does no CRC verification and does not bounds-check length, so a truncated chunk silently yields a short subarray. (d) The CRC is a JS byte loop over multi-MB payloads.
- **Fix:** Consume upng-js (UPNG.encode handles APNG with delays). Before encoding, decode frames with the already-present pngjs and resize or pad them to a common size. Alternatively, record via CDP to WebM with ffmpeg if it is available. For CRC, use zlib.crc32 (Node ≥22.2) or Bun.hash.crc32. Verdict: CONSUME. Unlocks now: valid recordings under viewport changes, and about 150 fewer lines of binary code. Cost: low. Confidence: high.
- **Evidence:** browser-logs.ts:3194-3229: width/height are read once from parsed[0] IHDR and reused in every fcTL. crc32:3321 is a per-byte JS loop.

## [LOW] dependency-hygiene — sdk/src/tools/browser-logs.ts:2722 — pixel_diff (pngjs + pixelmatch): KEEP (already consumed)
- **Risk:** pixelDiff:2722 already uses pngjs and pixelmatch. cropPngData:2796 copies rows manually, which is fine. When the actual and expected images differ in size, the diff silently compares only the overlapping top-left crop, and the mismatchRatio does not reflect the size mismatch. That can hide layout regressions.
- **Fix:** KEEP these dependencies. Report sizeMismatch explicitly, or count the non-overlapping area as mismatched. No language change needed. Confidence: high.
- **Evidence:** browser-logs.ts:2760-2775 (Math.min width/height).

## [LOW] dependency-hygiene — sdk/src/tools/browser-logs.ts:2046 — Chrome executable discovery: CONSUME chrome-launcher's Launcher.getInstallations or @puppeteer/browsers
- **Risk:** findChromeExecutable:2046 hardcodes 6 Linux/macOS paths. It has no Windows paths (Program Files / LOCALAPPDATA), no Edge or Brave, no snap/flatpak, and no PATH lookup. On Windows the browser tool always fails unless CHROME_PATH is set.
- **Fix:** Consume chrome-launcher's installation finder (TS, small), or @puppeteer/browsers to resolve or install a pinned Chrome for Testing. Keep the CHROME_PATH override first. Cost: low. Confidence: high.
- **Evidence:** browser-logs.ts:2046-2066.

## [LOW] security — sdk/src/tools/browser-logs.ts:2807 — Injected page scripts and key table: KEEP TS, switch to Runtime.callFunctionOn with arguments
- **Risk:** snapshotScript:2807, designTokensScript, elementPointScript, typeScript, selectScript, scrollScript, waitForScript and storageScript build JS source by string interpolation. Values go through JSON.stringify, which is safe. The inline error messages use escapeForJs:3109, a hand-rolled escaper. keyDefinition:3073 is a 9-entry hand table: non-US characters and keys like F1-F12, Home/End and PageUp are either missing or get fake codes (e.g. `Key${key.toUpperCase()}` for digits and punctuation).
- **Fix:** KEEP in TS. Pass selector/text as Runtime.callFunctionOn arguments instead of interpolating them into source, which removes escapeForJs entirely. Consume puppeteer-core's USKeyboardLayout table (a data-only import) or copy it. Cost: low. Confidence: medium-high.
- **Evidence:** browser-logs.ts:3073-3107 (keyDefinition), :3109-3117 (escapeForJs), :2807 onward (script builders).

## [MEDIUM] correctness — sdk/src/tools/background-jobs.ts:55 — Process-tree spawn/kill supervision: MOVE→Rust (process-wrap + sysinfo) as a supervisor sidecar
- **Risk:** isProcessTreeAlive:45 and terminateProcessTree:55 rely on detached:true plus a negative-pid group signal on POSIX. On win32, startBackgroundJob:674 does not detach and the fallback is child.kill(signal), which kills only the shell, so grandchildren leak. Windows has no Job Object. A child that calls setsid/setpgid escapes the group kill. The SIGTERM→SIGKILL escalation via scheduleKillEscalation:1188 is emulated with unref'd timers. Nothing kills jobs automatically if the CLI crashes; the code relies on the 24h orphan sweep plus recovery.
- **Fix:** Move spawn/kill to a Rust helper using process-wrap (it supersedes command-group): process groups plus kill-on-drop on Unix, Job Objects with KILL_ON_JOB_CLOSE on Windows, optional PR_SET_PDEATHSIG on Linux. It could share a binary with the bubblewrap sandbox launcher. Keep the jobRegistry adapter, ownership and output framing in TS, talking to the helper over stdio JSON. Unlocks now: correct tree kill on Windows, and no orphans after a CLI crash. Unlocks next: cgroup-v2 resource limits and a sandbox wrapper in the same place. Cost: medium (new binary distribution). Confidence: medium-high.
- **Evidence:** background-jobs.ts:45-74, :723 (`detached: os.platform() !== 'win32'`), :1188-1235.

## [MEDIUM] correctness — sdk/src/tools/background-jobs.ts:1144 — PID-reuse identity guard via /proc/<pid>/stat: MOVE→Rust (sysinfo start_time / pidfd) or CONSUME a cross-platform start-time source
- **Risk:** readProcessStartTime:1144 works only on Linux. On macOS and Windows it returns undefined, so killBackgroundJob:1237 marks every recovered job 'lost' and refuses to kill it (:1290-1310). Cross-session job control is therefore Linux-only in practice. The recovery metadata is also unauthenticated JSON in the shared tmpdir (SEC-5 is acknowledged as a follow-up at ~:1300).
- **Fix:** The Rust supervisor from the previous finding can hold a pidfd on Linux, which eliminates the pid-reuse race entirely, and use sysinfo::Process::start_time() on macOS and Windows. If staying in TS, read start time with `ps -o lstart= -p` on macOS. Add an HMAC to the metadata with a per-user key (node:crypto is enough). Cost: low-medium. Confidence: high.
- **Evidence:** background-jobs.ts:1144-1167 (`if (os.platform() !== 'linux') return undefined`), :1290-1310 (fails closed to lost).

## [LOW] performance — sdk/src/tools/background-jobs.ts:310 — Job log files (O_EXCL/O_NOFOLLOW creation, quota truncation, orphan sweep, metadata projection): KEEP TS
- **Risk:** safeCreateJobLogFile:214, safeWriteJobMetadata, safeOpenJobLogForRead and removeFileIfPresent are careful and correct fs code, and TS is fine for them. One cost: truncateLogToTail:310 allocates a 10 MB buffer and rewrites the file on every 250 ms tick while the job is over quota (:790-800), which is about 40 MB/s of churn during shutdown. sweepOrphanedJobFilesForTest:405 does a synchronous readdir of the whole tmpdir on the first spawn.
- **Fix:** KEEP. Truncate only once per overshoot of maxBytes plus a slack amount (e.g. 1 MB), or rotate the log instead of rewriting. Confidence: high.
- **Evidence:** background-jobs.ts:310-335, :775-805.

## [LOW] performance — sdk/src/tools/background-jobs.ts:614 — Output line framing (StringDecoder + lineCarry): KEEP TS
- **Risk:** emitJobOutputLines:614 re-slices lineCarry after every newline. A 100 KB drain with many short lines copies the remaining string on each line, which is O(n²). The decoder use at readNewJobOutput:1346 is correct across chunk boundaries.
- **Fix:** KEEP in TS. Split once with indexOf offsets and a single final slice. Confidence: high.
- **Evidence:** background-jobs.ts:614-630.

## [LOW] correctness — sdk/src/tools/read-logs.ts:242 — Backward log tail reader: KEEP TS (fix UTF-8 boundary and quadratic rescans)
- **Risk:** readTail:242 decodes each 64 KB chunk with buf.toString('utf8') independently. Multi-byte characters split at a chunk boundary become U+FFFD pairs. It also recounts newlines over the whole growing `collected` string on every chunk, which is O(n²) up to the 8×maxChars bound.
- **Fix:** KEEP in TS. Accumulate Buffers and decode once, or back up to a UTF-8 lead byte. Count newlines per chunk incrementally. Confidence: high.
- **Evidence:** read-logs.ts:262-280.

## [MEDIUM] correctness — sdk/src/tools/find-files-matching-content.ts:831 — groupBySymbol symbol extraction (regex plus brace counting): CONSUME @ast-grep/napi or web-tree-sitter
- **Risk:** extractSymbolsForLines:831 uses three regexes (declRegex, varDeclRegex, methodRegex) and counts braces with countChar. It counts braces inside strings, comments, template literals and regex literals. For Python, def lines push onto the stack with 0 braces and never pop, so later lines are attributed to the wrong symbol. Nested Go/Rust impl blocks confuse the scope stack. ripgrep itself is already consumed (KEEP).
- **Fix:** Consume @ast-grep/napi (a Rust tree-sitter core with prebuilt N-API binaries) or web-tree-sitter with per-language grammars. Use the enclosing named declaration node for each match line. Reuse whatever tree-sitter/code-map infrastructure the repo already has, if any; I did not verify that in this shard. Unlocks now: correct symbols for Python and other indentation-scoped languages. Unlocks next: shared symbol index with read_outline. Cost: low-medium. Confidence: high.
- **Evidence:** find-files-matching-content.ts:831-905 (countChar-based scope stack, no string/comment awareness).

## [LOW] correctness — sdk/src/tools/find-files-matching-content.ts:597 — Safe ripgrep flag parser/tokenizer: KEEP TS
- **Risk:** parseSafeRipgrepFlags:597 and splitFlagTokens:755 use a small allowlist and are fail-closed, and they include recovery for JSON-stringified argv. This is another hand-rolled quote tokenizer, but it only feeds an allowlist and never reaches a shell, because spawn is called with an argv array. Low risk.
- **Fix:** KEEP. Optionally share one shell-words tokenizer with the AST layer for consistency. Confidence: high.
- **Evidence:** find-files-matching-content.ts:597-753, :755-805; spawn with argv at ~:170.

## [MEDIUM] correctness — sdk/src/tools/get-change-review-bundle.ts:133 — Change-review snapshot identity: KEEP TS, switch to NUL-delimited git porcelain
- **Risk:** Files are parsed from `git status --porcelain -uall` with line.slice(3).split(' -> '). Without -z, git C-quotes paths that contain spaces, non-ASCII bytes or quotes ("a b.ts"), so those files do not exist under the parsed name and buildSnapshotId:26 skips them via existsSync. Renames whose names contain ' -> ' are also mis-split. buildSnapshotId reads every untracked file fully and synchronously with readFileSync into the hash, so large untracked artifacts block the event loop.
- **Fix:** KEEP in TS. Use `status --porcelain=v1 -z -uall` and parse NUL records, and stream file hashing with fs.createReadStream. Using the git CLI is the right way to consume git; no libgit2 needed. Confidence: high.
- **Evidence:** get-change-review-bundle.ts:116-136 (porcelain split), :51-58 (readFileSync per file).

## [LOW] correctness — sdk/src/tools/replace-range.ts:38 — Capability-checked range splice: KEEP TS
- **Risk:** replaceRange uses getRawRangeSpan:38 and getRangeLineEnding. It re-anchors against the capability hash and delegates the conditional commit to changeFile with an exact hash. This is string manipulation tied closely to TS capability/filesystem-authority types. Moving it would cross an FFI boundary with no gain.
- **Fix:** KEEP. Confidence: high.
- **Evidence:** replace-range.ts:38-77, :288-304.

## [LOW] dependency-hygiene — sdk/src/impl/opencode-go-responses-fetch.ts:133 — Chat Completions ↔ Responses translation for OpenCode Go: CONSUME @ai-sdk/openai's native Responses model (createOpenAI({ baseURL }).responses(id))
- **Risk:** The module translates requests (transformOpenCodeGoResponsesRequestBody:133) and non-streaming responses (transformResponsesJsonToChatCompletions:199) by hand, and reuses the ChatGPT-backend stream transformer. It drops Responses-only data: reasoning items/summaries, usage.output_tokens_details.reasoning_tokens, cached input tokens, refusal parts. It hardcodes the finish_reason mapping. It also replaces upstream response headers (rate-limit and request-id headers are lost on the SSE and JSON paths). repairToolCallHistory:70 is still useful.
- **Fix:** Point an @ai-sdk/openai provider at the Go base URL and use its .responses() language model. The AI SDK already implements Responses streaming, tools, reasoning and usage. Keep repairToolCallHistory as a message pre-pass in TS. Verdict: CONSUME. Unlocks now: reasoning tokens and usage fidelity, and about 300 fewer lines. Cost: low; must confirm Go's endpoint is compatible with the SDK's request shape. Confidence: medium.
- **Evidence:** opencode-go-responses-fetch.ts:133-186, :199-276, :318-323 (headers replaced with a fresh Headers object).

## [LOW] correctness — sdk/src/error-utils.ts:93 — HTTP/provider error helpers: KEEP TS
- **Risk:** This is pure JS object shaping for AI SDK errors (createHttpError, getErrorStatusCode:189, isRetryableStatusCode). isProviderContentPolicyResponse:93 matches substrings in message/responseBody. It is conservative by design but will not detect provider codes nested in JSON bodies whose wording differs from the list.
- **Fix:** KEEP. Optionally parse responseBody JSON and check error.code (e.g. 'content_filter') before falling back to substring matching. Confidence: high.
- **Evidence:** error-utils.ts:93-117, :189-208.

## [LOW] correctness — sdk/src/tools/list-jobs.ts:37 — Thin tool wrappers (list-jobs, get-task, inspect-workspace, inspect-environment, audit-intelligence tool, index): KEEP TS
- **Risk:** These are glue between the registry, git CLI and plan artifacts and the tool output schema. list-jobs.ts:37 is a read-only registry digest. get-task.ts:13 reads plan artifacts. inspect-workspace.ts:8 runs 5 parallel git calls. inspect-environment.ts:3 is a one-line delegate. audit-intelligence.ts:20 keeps a bounded 16-entry cache validated per cwd. index.ts:61 exports ToolHelpers. No hot loops, no parsing, and no Python-offline or Rust fit. Minor note: get-task reads ACTIVE_SESSION and PLAN.md with no size bound, which is acceptable.
- **Fix:** KEEP. Confidence: high.
- **Evidence:** list-jobs.ts:37-152; get-task.ts:13-67; inspect-workspace.ts:8-84; inspect-environment.ts:3-7; audit-intelligence.ts:20-30; index.ts:61-78.

## [LOW] security — sdk/src/tools/write-audit-findings.ts:113 — Audit findings Markdown render and exclusive write: KEEP TS
- **Risk:** renderAuditFindingsMarkdown:113 collapses newlines via singleLine to prevent forged headings. The exclusive create and the byte-identity idempotency check at :330-350 are sound. It does not escape a leading '#' or markdown control characters inside single-line fields, which is harmless because headings require a line start.
- **Fix:** KEEP. Confidence: high.
- **Evidence:** write-audit-findings.ts:30-32, :113-165, :320-370.

## Coverage receipt

### Subsystems
- sdk

### Features
- terminal-command-policy-lexers
- terminal-command-policy-regex-classifiers
- terminal-policy-os-sandbox-gap
- harness-action-classifier
- harness-command-hash
- harness-approval-store
- browser-cdp-orchestration
- browser-apng-codec
- browser-pixel-diff
- browser-chrome-discovery-launch
- browser-injected-scripts-keymap
- background-job-process-tree
- background-job-pid-identity
- background-job-log-files
- background-job-line-framing
- read-logs-tail
- find-files-symbol-extraction
- ripgrep-flag-tokenizer
- change-review-snapshot
- replace-range-splice
- opencode-go-responses-translation
- error-utils
- thin-tool-wrappers
- write-audit-findings-render

### Files
- sdk/src/tools/terminal-command-policy.ts
- sdk/src/tools/browser-logs.ts
- sdk/src/tools/background-jobs.ts
- sdk/src/services/harness-enforcement.ts
- sdk/src/impl/opencode-go-responses-fetch.ts
- sdk/src/error-utils.ts
- sdk/src/tools/replace-range.ts
- sdk/src/tools/audit-intelligence.ts
- sdk/src/tools/get-change-review-bundle.ts
- sdk/src/tools/find-files-matching-content.ts
- sdk/src/tools/list-jobs.ts
- sdk/src/tools/read-logs.ts
- sdk/src/tools/get-task.ts
- sdk/src/tools/inspect-workspace.ts
- sdk/src/tools/inspect-environment.ts
- sdk/src/tools/write-audit-findings.ts
- sdk/src/tools/index.ts

### Domains
- security
- performance
- correctness
- dependency-hygiene
