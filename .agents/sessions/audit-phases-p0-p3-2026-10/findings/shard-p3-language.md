# Audit findings: shard-p3-language

- Subsystems: sdk-services-lsp-multiplexer, sdk-services-language-intelligence, sdk-services-symbol-enrichment, sdk-services-build-graph, sdk-services-diagnostic-delta, sdk-services-diagnostic-delta-runner, sdk-services-semgrep-baseline, sdk-services-harness-intelligence
- Features: lsp-warm-server-per-language-root, lsp-framed-transport-fail-closed-header-parsing, lsp-lru-eviction-restart-single-flight, root-marker-resolution-cache, lsp-sync-mutated-files, go-to-definition-find-references-hover-workspace-symbol, symbol-enrichment-hover-cache-path-content-hash, symbol-enrichment-inlay-hints, build-graph-owning-targets, build-graph-cargo-metadata-go-list, build-graph-command-token-whitelist, diagnostic-delta-strict-tolerant-matcher, diagnostic-delta-preflight-apply-rollback, diagnostic-command-runner-sigterm-sigkill, file-change-hook-preflight-fail-open, semgrep-baseline-sargv-whitelist, semgrep-availability-cache-single-flight, harness-environment-inspection-tool-probes, harness-affected-test-targets, harness-test-impact-tiers, harness-build-targets, harness-context-packet, harness-verified-knowledge, harness-workspace-leases, connector-operation-classification
- Files covered: 8
- Snapshot: 5c80253b458f8b07b8ca33e50cc3d6ad7e6cda07ef1715ba8adffd8c77905ab7

## [HIGH] correctness — sdk/src/services/semgrep-baseline.ts:158 — SIGKILL escalation timer armed at spawn time, not at the deadline, killing healthy semgrep scans after ~5s
- **Risk:** Every semgrep scan that runs longer than SIGTERM_GRACE_MS (5s default) is SIGKILLed at ~5s even though the configured deadline is 60s-300s. The child dies, 'close' fires with signal SIGKILL/exitCode -1, and a legitimately-running scan is reported as an error — real baseline findings are silently dropped and the availability of scans >5s effectively regresses to near-zero.
- **Fix:** Move the escalate setTimeout inside the deadline timer callback (as diagnostic-delta-runner.ts already does), or have the escalate callback check whether the deadline already fired before killing.
- **Evidence:** const timer = setTimeout(() => { ... child.kill('SIGTERM'); settle(...) }, timeoutMs); timer.unref(); escalate = setTimeout(() => { ... child.kill('SIGKILL') ... }, graceMs); escalate.unref() — escalate is created at line 158 in the runner body, not inside the timer callback (contrast diagnostic-delta-runner.ts:129-135 where escalate is armed inside the timeout handler).

## [MEDIUM] correctness — sdk/src/services/semgrep-baseline.ts:412 — semgrep exit code 1 (findings found) treated as failure, discarding parsed findings
- **Risk:** semgrep's documented convention (without --error) is exit code 1 when findings are present. A successful scan that finds vulnerabilities returns exitCode 1, hits this branch, and returns { status: 'error', findings: [] } — the security gate sees an 'error' instead of the taint findings, converting a real detection into a dropped signal.
- **Fix:** When exitCode is a semgrep findings-found code (1), still parse stdout SARIF and return status 'ok' with the findings (possibly recording the exit code), reserving 'error' for codes ≥2 or signaled exits.
- **Evidence:** if (scan.exitCode !== 0) { const snippet = scan.stderr...; return { status: 'error', reason: `semgrep failed with exit code ${scan.exitCode}...`, findings: [] } } — no handling of the findings-found exit code before this branch.

## [MEDIUM] security — sdk/src/services/build-graph.ts:544 — Python target testCommand interpolates unsanitized directory names, bypassing SAFE_COMMAND_TOKEN
- **Risk:** resolvePythonTargets interpolates the discovered manifest directory directly into `python -m pytest ${directory}` without the safeCommandToken whitelist that cargo names, go import paths, jvm dirs, and dotnet manifests all pass through. A repo containing a directory named e.g. `x; curl evil` or `$(...)` (attacker-controlled checkout content) yields a testCommand string containing shell metacharacters; any consumer that executes these strings through a shell gets command injection. The module's own whitelist comment says these values are attacker-controlled.
- **Fix:** Route the python (and any other remaining) directory through safeCommandToken and omit the command when it fails, matching the cargo/go/jvm/dotnet resolvers.
- **Evidence:** resolvePythonTargets pushes testCommand: directory === '.' ? 'python -m pytest' : `python -m pytest ${directory}` with no safeCommandToken call, while resolveJvmTargets/resolveCargoTargets/resolveGoTargets/resolveDotnetTargets all route through safeCommandToken (line 194).

## [MEDIUM] error-handling — sdk/src/services/lsp-multiplexer.ts:752 — acquire() returns a permanently-dead server entry after a failed restart; requests fail with 'stopped' forever
- **Risk:** After a crash + one failed restart attempt (emit 'gave-up'), entry.connection stays the dead connection with running=false and entry remains in the servers map. acquire()'s existing branch returns it unconditionally without checking connection.isRunning or restarting a replacement, so every subsequent definition/hover/references/syncFile call for that (language, root) fails with LspServerError('stopped') until the entry happens to be LRU-evicted — a permanent degradation of language intelligence for the affected root.
- **Fix:** In acquire's existing-entry branch, when the connection is not running and no restart is in flight, stop/remove the entry and fall through to a fresh cold start (or trigger the restart path) instead of returning a dead connection.
- **Evidence:** const existing = servers.get(key); if (existing) { servers.delete(key); servers.set(key, existing); if (existing.restarting) await existing.restarting; return existing } — no isRunning check and no restart trigger in the existing-entry branch.

## [MEDIUM] correctness — sdk/src/services/lsp-multiplexer.ts:875 — workspaceSymbol routes the query to whichever warm server is most recent, regardless of language
- **Risk:** The helper iterates all servers and returns the last running one regardless of language. A workspace_symbol query issued while the most-recent warm server is, say, pyright will be answered by the Python server (empty/wrong symbol universe) even though a warm tsserver exists; results are language-dependent and effectively arbitrary when multiple servers are warm. workspaceSymbol() takes no file path, so there is no way for the caller to influence selection.
- **Fix:** Take an optional languageId/hint parameter for workspaceSymbol and prefer (or require) a warm server whose languageId matches; otherwise fall back to an honest unavailable result rather than querying an unrelated server.
- **Evidence:** warmEntryForWorkspaceSymbol loops over servers.values() and keeps the last entry with connection.isRunning, with no languageId/extension check against the query or any target file.

## [MEDIUM] error-handling — sdk/src/services/lsp-multiplexer.ts:453 — handleMessage silently drops unparseable bodies and non-numeric ids, leaving pending requests to hang until timeout
- **Risk:** If a framed body is valid-length but not valid JSON, or a response carries a string id (valid per JSON-RPC but not produced here), handleMessage silently returns. The pending request whose response was corrupted is never resolved or rejected and hangs until the full requestTimeoutMs (10s) expires — every corrupted response converts into a worst-case latency hit rather than a fast protocol error, and repeated corruption serially stalls the multiplexer's request pipeline.
- **Fix:** On unparseable frame bodies, reject all pending requests (or at least fail the connection) instead of silently returning; consider accepting string ids and, if the parsed message carries an id not present in pending, log/emit a protocol event for observability.
- **Evidence:** try { message = JSON.parse(body) } catch { return }; ... const id = message['id']; if (typeof id !== 'number') return // a server->client notification/request — both paths leave the matching pending entry (if any) unrejected.

## [MEDIUM] correctness — sdk/src/services/harness-intelligence.ts:80 — discoverNamedFiles uses unbounded recursion with no depth or visited-directory cap (build-graph's F3 hardening not mirrored)
- **Risk:** build-graph.ts's discoverBuildGraphFiles was explicitly hardened with MAX_WALK_DEPTH=12 and MAX_VISITED_DIRS=2000 citing security review F3, but harness-intelligence's discoverNamedFiles is still plain unbounded recursion: a deep directory tree (pathological or malicious checkout) causes stack overflow (RangeError) or an unbounded synchronous walk on the gate's hot path. The two modules also disagree on the security posture for the same operation.
- **Fix:** Port build-graph's iterative stack walk with MAX_WALK_DEPTH (e.g. 12) and MAX_VISITED_DIRS (e.g. 2000) caps into discoverNamedFiles, or share one bounded discovery helper between both modules.
- **Evidence:** const visit = (directory: string): void => { ... for (const entry of entries) { ... if (entry.isDirectory()) { if (!ignoredDiscoveryDirectories.has(entry.name)) visit(absolute) } ... } }; visit(root) — no depth parameter, no visited counter, no stack-based iteration.

## [MEDIUM] performance — sdk/src/services/harness-intelligence.ts:316 — 14 serial spawnSync tool-version probes per inspect call, uncached, each with a 3s timeout
- **Risk:** inspectHarnessEnvironment calls toolVersion for 14 tools on every invocation. discoveryCache caches only the manifest walk — the tools record is rebuilt every call. Each probe is a synchronous spawnSync with a 3s timeout, so a machine where several tools are missing/slow (ENOENT is fast, but a hung binary burns the full 3s) can block the SDK event loop for tens of seconds per inspection, on a path the comments describe as called 'on every iteration' of the aux gate.
- **Fix:** Cache the tools record per cwd alongside the discovery cache (with the same TTL), probe tools in parallel (async spawn), or probe lazily/only for ecosystems present in the discovered manifests.
- **Evidence:** tools: { git: toolVersion('git'), bun: toolVersion('bun'), ... } — 14 toolVersion calls inline; toolVersion has no cache and spawnSync({ timeout: 3000 }); discoveryCache caches only discoverWorkspaces output, not the tools record.

## [MEDIUM] correctness — sdk/src/services/diagnostic-delta.ts:241 — Strict delta matcher (the default) rejects valid edits whose pre-existing errors merely shifted lines
- **Risk:** strictKey matches on (file, line, column, code, severity). Any edit above a pre-existing error shifts that error's line, so the after-capture no longer matches the baseline and the preflight reports a NEW error that already existed — rejecting a valid edit (the exact false-positive class the feature exists to prevent). The docstring acknowledges the trade-off but strict remains the default for all callers, including the mutation-broker path, unless callers remember to opt into tolerant mode.
- **Fix:** Default the broker path to 'tolerant' (or a hybrid key that matches a shifted diagnostic by (file, code) within a small line window), and only use strict mode where exact-position matching is required.
- **Evidence:** const keyOf = options.mode === 'tolerant' ? tolerantKey : strictKey ... strictKey includes diagnostic.range?.start.line/column; preflightDiagnosticDelta defaults to strict (no mode passed by callers shown).

## [MEDIUM] error-handling — sdk/src/services/diagnostic-delta.ts:319 — preflightDiagnosticDelta leaves the edit applied without rollback if applyEdit throws; a throwing rollbackEdit also swallows the rejection result
- **Risk:** If applyEdit() throws after partially mutating state, the function throws and rollbackEdit is never invoked, leaving the workspace mutated with no compensation path. Symmetrically, on the rejection path `if (rollbackEdit) await rollbackEdit()` (line 336) is unguarded: a throwing rollback discards the entire { rejected: true, newDiagnostics, fixIts } result and replaces it with the rollback error, losing the diagnostics the caller needs.
- **Fix:** Wrap applyEdit in try/catch that invokes rollbackEdit (best-effort, swallowing/secondary-error-logging) before rethrowing, and guard the rejection-path rollback so the fixIts result is still returned if rollback fails.
- **Evidence:** const before = await capture(); await applyEdit(); const after = ...; ... if (rollbackEdit) await rollbackEdit() — applyEdit is not wrapped in try/catch and the rollback call is unguarded.

## [LOW] security — sdk/src/services/language-intelligence.ts:341 — Query paths are resolved without project-path containment, inconsistent with build-graph/harness-intelligence
- **Risk:** goToDefinition/findReferences/hoverType resolve params.path against cwd and pass it straight to the multiplexer, which walks upward for root markers and spawns servers with that cwd. A model-supplied path outside the project (e.g. ../../etc or an absolute path) is not rejected, unlike build-graph.ts and harness-intelligence.ts which both gate on resolveProjectPath scope === 'project'. Impact is bounded (LSP queries are read-only and spawn argv is fixed), but it is an inconsistent containment boundary and lets a server's cwd be pointed outside the workspace.
- **Fix:** Route params.path through resolveProjectPath (same as build-graph/harness-intelligence) and return an unavailable/error result for out-of-project paths before touching the multiplexer.
- **Evidence:** mux.definition({ filePath: path.resolve(options.cwd, params.path), ... }) — path.resolve only normalizes; no resolveProjectPath/scope check anywhere in the module, unlike build-graph.ts toProjectRelativeFiles.

## [LOW] correctness — sdk/src/services/language-intelligence.ts:124 — toLspPosition sends line - 1 unvalidated; line 0 becomes -1
- **Risk:** Tool inputs are model-controlled; line=0 (or a negative line) produces line=-1, which some language servers reject with an error or, worse, silently mis-resolve. No clamping or validation is applied before the value is serialized into the LSP request.
- **Fix:** Clamp to line: Math.max(0, line - 1) (and reject non-integers) before constructing the LSP position.
- **Evidence:** function toLspPosition(line: number, character: number): LspPosition { return { line: line - 1, character } } — no Math.max(0, ...) and no upper bound against document length.

## [LOW] correctness — sdk/src/services/symbol-enrichment.ts:245 — inlayHint request range end line is off by one past EOF
- **Risk:** For an N-line file, split('\n').length is N, but LSP line indices are 0-based so the last valid line is N-1; the requested range ends one line past EOF. Well-behaved servers clamp, but strictly validating servers may return an error (swallowed by the catch, degrading enrichment silently) or behave inconsistently.
- **Fix:** Use the last line index (split length - 1, min 0) as the range end line.
- **Evidence:** const range: LspRange = { start: { line: 0, character: 0 }, end: { line: fileText.split('\n').length, character: 0 } } — should be fileText.split('\n').length - 1.

## [LOW] state-mutation — sdk/src/services/build-graph.ts:609 — buildGraphCache keyed by cwd only, ignoring the injected runner identity
- **Risk:** cachedTargetIndex caches by resolved root only. A caller that injects a test/fake runner (the exported BuildGraphRunner seam exists for exactly that) within the 5s TTL of a default-runner entry, or vice versa, silently observes the other runner's target index. Semgrep's availability cache was explicitly fixed to key by runner first (WeakMap); build-graph was not given the same treatment, so test isolation depends entirely on callers remembering clearBuildGraphCache().
- **Fix:** Key the cache by (root, runner identity) like semgrep-baseline's WeakMap-by-runner pattern, or document/clear the cache at the injection boundary.
- **Evidence:** const cached = buildGraphCache.get(root) ... buildGraphCache.set(root, { expiresAt: now + buildGraphCacheTtlMs, targets }) — the runner is neither in the key nor part of the cached value's identity.

## [LOW] correctness — sdk/src/services/semgrep-baseline.ts:409 — Timeout detection sniffs stderr for /timed out/i, risking false-positive timeout classification
- **Risk:** Timeout detection partly rests on substring-matching the child's stderr. A semgrep run that legitimately prints 'timed out' (e.g. a rule-engine message or nested tool output) while exiting 0 is misclassified as a timeout and its parsed findings are discarded. The signal field already provides a structured timeout indicator; the regex is redundant and harmful.
- **Fix:** Rely on the structured signal field (and the runner's own timeout marker) rather than sniffing stderr text.
- **Evidence:** if (scan.signal === 'SIGTERM' || /timed out/i.test(scan.stderr)) { return { status: 'error', reason: 'semgrep-timeout', findings: [] } }

## [LOW] correctness — sdk/src/services/harness-intelligence.ts:460 — Bogus build/test commands: cargo -p uses directory basename, and unparseable package.json yields 'unknown run <script>'
- **Risk:** Two related issues: (1) buildToolTestCommands derives the cargo package name from the directory basename — cargo package names may differ from the directory (hyphens/underscores, renamed [package] name), producing `cargo test -p wrong-name` that fails or tests nothing; (2) when a package.json fails to parse, inferWorkspace leaves manager 'unknown' while ecosystem stays 'javascript', so getBuildTargets/buildToolTestCommands emit commands like `unknown run test` — a nonsense command surfaced as a confirmed/inferred target rather than 'unknown'.
- **Fix:** For cargo, read the package name from Cargo.toml (or omit -p); for javascript with manager 'unknown', fall back to 'npm' or emit no command with confidence 'unknown'.
- **Evidence:** if (workspace.manager === 'cargo') return { commands: [`cargo test -p ${path.posix.basename(workspace.root)}`], confirmed: true } ...; scripts.map((script) => `${workspace.manager} run ${script}`) — manager can be the literal 'unknown' from inferWorkspace's catch path.

## [LOW] error-handling — sdk/src/services/diagnostic-delta-runner.ts:168 — Signal-killed children reported as exitCode 1, and whitespace argv split is an undocumented invariant
- **Risk:** A child killed by a signal reports exitCode 1 indistinguishably from a normal nonzero exit, so callers cannot tell a crashed compiler from a failing one (semgrep's runner surfaces `signal` for this). Separately, argv is derived by whitespace-splitting the fixed command strings; the current table has no quoted args, but any future entry with quoted arguments (paths, globs) would be silently mis-split into wrong argv tokens with no guard or test enforcing that constraint.
- **Fix:** Thread the close signal into the result (as semgrep's SemgrepRunResult does) and consider quoting-aware parsing or per-command argv arrays in the DIAGNOSTIC_COMMANDS table.
- **Evidence:** child.on('close', (code: number | null) => { finish({ exitCode: code ?? 1, ... }) }) — the close handler's second (signal) parameter is ignored, and argv construction is command.split(/\s+/).filter(Boolean).

## [LOW] test-coverage — sdk/src/services/semgrep-baseline.ts:143 — No test covers semgrep's exit-code-1-with-findings path or the makeSpawnRunner escalation timing
- **Risk:** The two most consequential behaviors on this path — nonzero-exit-with-findings handling and the SIGKILL escalation timing (finding #1/#2) — have no test asserting the failure mode, which is how the escalate-at-spawn bug and the exit-1 findings drop could land unnoticed. The existing makeSpawnRunner export exists specifically so tests can bind the deadline machinery to a controllable child, but no test covers the escalate timer's schedule.
- **Fix:** Add tests: (1) runner exits 1 with valid SARIF stdout → findings survive; (2) fake child still alive past deadline+grace receives SIGKILL, and alive-but-healthy at <5s does not.
- **Evidence:** referencedBy shows semgrep-baseline tests cover clearSemgrepAvailabilityCache/runSemgrepBaseline/makeSpawnRunner and diagnostic-delta tests cover the delta functions, but neither suite asserts the two behaviors above (no finding of severity error with parsed findings; no slow-child SIGKILL-timing test).

## Coverage receipt

### Subsystems
- sdk-services-lsp-multiplexer
- sdk-services-language-intelligence
- sdk-services-symbol-enrichment
- sdk-services-build-graph
- sdk-services-diagnostic-delta
- sdk-services-diagnostic-delta-runner
- sdk-services-semgrep-baseline
- sdk-services-harness-intelligence

### Features
- lsp-warm-server-per-language-root
- lsp-framed-transport-fail-closed-header-parsing
- lsp-lru-eviction-restart-single-flight
- root-marker-resolution-cache
- lsp-sync-mutated-files
- go-to-definition-find-references-hover-workspace-symbol
- symbol-enrichment-hover-cache-path-content-hash
- symbol-enrichment-inlay-hints
- build-graph-owning-targets
- build-graph-cargo-metadata-go-list
- build-graph-command-token-whitelist
- diagnostic-delta-strict-tolerant-matcher
- diagnostic-delta-preflight-apply-rollback
- diagnostic-command-runner-sigterm-sigkill
- file-change-hook-preflight-fail-open
- semgrep-baseline-sargv-whitelist
- semgrep-availability-cache-single-flight
- harness-environment-inspection-tool-probes
- harness-affected-test-targets
- harness-test-impact-tiers
- harness-build-targets
- harness-context-packet
- harness-verified-knowledge
- harness-workspace-leases
- connector-operation-classification

### Files
- sdk/src/services/lsp-multiplexer.ts
- sdk/src/services/language-intelligence.ts
- sdk/src/services/symbol-enrichment.ts
- sdk/src/services/build-graph.ts
- sdk/src/services/diagnostic-delta.ts
- sdk/src/services/diagnostic-delta-runner.ts
- sdk/src/services/semgrep-baseline.ts
- sdk/src/services/harness-intelligence.ts

### Domains
- security
- correctness
- state-mutation
- error-handling
- performance
- dependency-hygiene
- test-coverage
- api-contract
