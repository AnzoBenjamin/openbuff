# Audit findings: shard-p0-safety

- Subsystems: sdk-env, sdk-cdp-transport, sdk-terminal-policy, sdk-terminal-execution, sdk-browser-logs, sdk-3d-assets, agent-runtime-str-replace, buffbench-statistics
- Features: P0-T1-child-process-env-credential-scrub, P0-T2-cdp-pipe-transport-fail-closed, P0-terminal-command-policy-profiles, P0-str-replace-tree-sitter-preflight, P0-T6-paired-bootstrap-ci, P0-T8-wilcoxon-significance-gate, chrome-sandbox-args-probe, blender-child-env-usage, staged-commit-safety-gate
- Files covered: 10
- Snapshot: 5c80253b458f8b07b8ca33e50cc3d6ad7e6cda07ef1715ba8adffd8c77905ab7

## [HIGH] security — sdk/src/env.ts:72 — getChildProcessEnv is a fixed 8-key denylist, not an allowlist; other provider credentials leak to child processes
- **Risk:** The claimed 'allowlist' is actually a hardcoded 8-key denylist (BYOK_OPENROUTER, 2 OAuth tokens, OPENBUFF_API_KEY, CODEBUFF_API_KEY, OPENAI_API_KEY, ANTHROPIC_API_KEY, OPENROUTER_API_KEY). Any other provider credential env var — e.g. one configured via openbuff.json apiKeyEnv, GEMINI_API_KEY, DEEPSEEK_API_KEY, AZURE_OPENAI_API_KEY, or a future provider preset — passes verbatim into every child shell command (run_terminal_command, sidecar, Blender), where the command or a compromised dependency can read and exfiltrate it. P0-T1's isolation guarantee only holds for the exact 8 names.
- **Fix:** Derive the strip set at runtime from the configured provider presets' apiKeyEnv values (and any BYOK-configured custom env names), or invert to a true allowlist of safe child vars; add a regression test that iterates every configured credential env name and asserts it is stripped.
- **Evidence:** sdk/src/env.ts getChildProcessEnv: `const env = { ...process.env }; delete env[BYOK_OPENROUTER_ENV_VAR]; ... delete env['OPENROUTER_API_KEY']; return env` — exactly eight named deletions; doc comment says 'we delete only the specific keys'.

## [MEDIUM] security — sdk/src/tools/run-terminal-command.ts:41 — validateStagedCommit spawns git with the full unscrubbed parent environment
- **Risk:** The git-commit safety preflight spawns git three times (diff --cached --check / --name-only / -U0) with the inherited full process.env, bypassing the getChildProcessEnv credential scrub used for the actual command. Repo-controlled git configuration (core.hooksPath, aliases, credential helpers, or a malicious .git/config in an untrusted workspace) executes with the agent's BYOK/OAuth/provider keys in its environment.
- **Fix:** Pass env: getChildProcessEnv() in the validateStagedCommit runGit helper (and confirm the shared runGit in git-status.ts used by listDirtyPaths does the same).
- **Evidence:** runGit = (args) => spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: GIT_SAFETY_OUTPUT_LIMIT }) — no env option, unlike the SYNC/BACKGROUND paths which build processEnv from getChildProcessEnv().

## [MEDIUM] security — sdk/src/tools/run-terminal-command.ts:640 — Caller-supplied env is merged after the credential scrub and can re-inject stripped key names
- **Risk:** In both the BACKGROUND and SYNC paths the caller/tool-call `env` map is spread after the scrubbed base (`{ ...getChildProcessEnv(), ...(env ?? {}) }`), so an env entry named OPENAI_API_KEY / CODEBUFF_API_KEY / etc. re-injects a value under the exact names the scrub removed. Any caller that forwards request-level env (or a tool-call that echoes a previously leaked value) silently defeats the credential isolation the profile policy otherwise enforces.
- **Fix:** Re-apply the credential denylist AFTER merging caller env (or reject/deny credential-named keys in the caller-supplied env for restricted profiles).
- **Evidence:** const processEnv = { ...getChildProcessEnv(), ...(env ?? {}) } as NodeJS.ProcessEnv — appears in both the BACKGROUND and SYNC spawn paths of runTerminalCommand.

## [MEDIUM] security — sdk/src/tools/browser-logs.ts:674 — chromeSandboxArgs fails open to --no-sandbox and misses the Ubuntu 24.04 AppArmor userns restriction
- **Risk:** When sandbox availability cannot be determined the function returns ['--no-sandbox'], launching headless Chrome (which renders untrusted web content) with its OS sandbox disabled. Additionally the probe only checks unprivileged_userns_clone and max_user_namespaces, not Ubuntu 24.04's apparmor_restrict_unprivileged_userns, so on AppArmor-restricted hosts the probe returns [] (sandboxed) while Chrome actually cannot create its namespace sandbox — the exact 'broken sandbox launch' failure the fail-open branch claims to avoid.
- **Fix:** Also check /proc/sys/kernel/apparmor_restrict_unprivileged_userns before returning [], and make the undeterminable case fail closed (refuse to launch or require explicit opt-in) instead of silently disabling the sandbox.
- **Evidence:** chromeSandboxArgs(): reads only unprivileged_userns_clone and user/max_user_namespaces; final line `return ['--no-sandbox']` under 'Undeterminable: fail open'; spawnPipeConnection/spawnPortConnection splice ...chromeSandboxArgs() into the argv of both transports.

## [LOW] security — sdk/src/env.ts:87 — getSystemProcessEnv exports the raw unscrubbed process.env
- **Risk:** getSystemProcessEnv() hands out the raw, unscrubbed process.env as a public helper. Any future child-spawn or logging path that consumes it silently bypasses the credential scrub, and the name does not signal the hazard.
- **Fix:** Remove the export or mark it explicitly as unsafe-for-child-spawn (e.g. rename/deprecate with a lint rule) so future spawn sites cannot adopt it silently.
- **Evidence:** export const getSystemProcessEnv = (): NodeJS.ProcessEnv => { return process.env } sits in the same module as the scrub and is an unconditioned full-env escape hatch.

## [LOW] correctness — sdk/src/tools/3d-assets.ts:290 — runBlender merges stdout and stderr into one buffer, risking corrupted JSON marker lines and split UTF-8
- **Risk:** runBlender appends both streams into one string (output += chunk.toString('utf8')); an interleaved stderr chunk can split the OPENBUFF_3D_JSON: line before its newline, so the marker-line slice fed to JSON.parse is truncated/corrupted and inspection fails non-deterministically. Per-chunk toString('utf8') also mangles multi-byte UTF-8 sequences split at chunk boundaries.
- **Fix:** Capture stdout and stderr into separate Buffers (decode once at close), and extract the JSON marker line from stdout only.
- **Evidence:** child.stdout.on('data', appendOutput); child.stderr.on('data', appendOutput) — both append into the single `output` string via chunk.toString('utf8').

## [LOW] correctness — sdk/src/tools/3d-assets.ts:340 — OPENBUFF_3D_OPERATIONS env value is unbounded and can exceed OS env-size limits
- **Risk:** The model-controlled operations array is serialized into the OPENBUFF_3D_OPERATIONS env var with no size limit; a very large payload can exceed OS environment/ARG_MAX limits and fail spawn with an opaque E2BIG error instead of a clear validation message.
- **Fix:** Cap the operations payload size or pass it via the already-on-disk script/adjacent temp file instead of the environment.
- **Evidence:** runBlender(['--background', '--python', editScriptPath], BLENDER_TIMEOUT_MS, { OPENBUFF_3D_OPERATIONS: JSON.stringify(params.operations) }, params.signal) with no size cap on the JSON payload.

## [MEDIUM] correctness — evals/buffbench/statistics.ts:180 — Wilcoxon normal approximation applied at arbitrarily small n in the significance gate
- **Risk:** The normal approximation with continuity/tie corrections is computed for any n >= 1 nonzero diffs with no exact-test fallback or minimum-sample guard. A P0-T8 significance gate built on this p-value can pass or fail proposals on statistically meaningless samples (e.g. 3-5 pairs), where the normal approximation is invalid.
- **Fix:** Return a flag or throw/guard when n is below a minimum (e.g. 8-10 nonzero diffs), or implement the exact signed-rank null distribution for small n; have the significance gate require both minimum n and CI exclusion of zero.
- **Evidence:** const varW = (n*(n+1)*(2*n+1))/24 - tieCorrection; ... const z = (diff - sign*0.5)/Math.sqrt(varW); const pValueTwoSided = 2*(1 - normalCdf(Math.abs(z))) — computed for any n >= 1 with nonzero diffs.

## [LOW] correctness — evals/buffbench/statistics.ts:115 — Bootstrap percentile indices are asymmetric (off-by-one on the upper bound)
- **Risk:** lowerIdx = floor(0.025 * iterations) but upperIdx = floor(0.975 * iterations) (index 1950 of 0..1999) — the two tails are selected with inconsistent rounding, so the CI is asymmetrically biased upward by one rank; for small iteration counts the asymmetry is proportionally larger.
- **Fix:** Use paired conventional indices, e.g. lowerIdx = Math.floor((alpha/2)*iterations) and upperIdx = Math.ceil((1-alpha/2)*iterations) - 1, and pin both in the unit test.
- **Evidence:** const lowerIdx = Math.floor((alpha / 2) * iterations); const upperIdx = Math.min(iterations - 1, Math.floor((1 - alpha / 2) * iterations)) — for alpha=0.05, iterations=2000: 50 and 1950.

## [LOW] correctness — sdk/src/tools/cdp-pipe-transport.ts:233 — writeFrame rejections are swallowed; write errors surface only as request timeouts
- **Risk:** send() fires the framed write with `void this.writeFrame(...).catch(() => undefined)`. A synchronous/synchronous-ish write failure (EPIPE on a dying Chrome) is swallowed and the caller only learns via the default 15s request timeout instead of an immediate error, slowing failure propagation across every CDP call.
- **Fix:** Reject the correlated pending entry (or destroy the transport) when writeFrame fails, so callers get the real error immediately.
- **Evidence:** void this.writeFrame(payload, timeoutMs).catch(() => undefined); return promise — the catch discards the write error instead of rejecting `promise`.

## [LOW] state-mutation — sdk/src/tools/browser-logs.ts:1502 — CDP events arriving before the session object exists are silently dropped
- **Risk:** The transport's onEvent callback is `if (session) routeEvent(session, message)`; events delivered between transport construction (before Target.setDiscoverTargets even resolves) and session assignment are silently discarded, unlike unregistered-sessionId events which are buffered. Early console/network events from the initial page can be lost.
- **Fix:** Buffer pre-session events (bounded, like routeEvent's pendingEvents) and replay them once the session registers.
- **Evidence:** onEvent: (message) => { if (session) routeEvent(session, message) } — no buffering path for the pre-session window.

## [LOW] state-mutation — sdk/tools/browser-logs.ts:950 — pipeProbeCache entries never evicted; deferred user-data-dir cleanups only swept on next session activity
- **Risk:** pipeProbeCache entries are only TTL-checked on read and never evicted, and deferredUserDataDirCleanups is drained solely by sweepDeferredBrowserUserDataDirs() at the start of ensureBrowserSession; in a long-lived process that stops spawning browser sessions, deferred temp user-data dirs are never reclaimed until exit.
- **Fix:** Evict stale pipeProbeCache entries opportunistically (or cap its size) and sweep deferred dirs on an unref'd timer as a backstop.
- **Evidence:** const pipeProbeCache = new Map<string, { probedAt: number }>() — read paths check probedAt but nothing deletes; deferredUserDataDirCleanups.add(...) only drained from sweepDeferredBrowserUserDataDirs called by ensureBrowserSession.

## [LOW] error-handling — sdk/src/tools/3d-assets.ts:930 — inspect3dAsset metadata-cache write failures silently swallowed
- **Risk:** The metadata-cache write block wraps mkdir/createFileExclusive/writeFile in a bare catch with no logging; an unexpected failure mode (e.g. permission or disk-full errors distinct from the intended EEXIST no-op) is indistinguishable from 'adapter cannot persist caches' in any log.
- **Fix:** Log the swallowed error at debug level with the path so cache-write regressions are diagnosable.
- **Evidence:** try { ...createFileExclusive / writeFile... } catch { // Inspection remains useful even when an adapter cannot persist caches. }

## [MEDIUM] test-coverage — sdk/src/__tests__/env.test.ts:210 — getChildProcessEnv tests mirror the implementation's denylist and never assert against a non-listed credential
- **Risk:** The suite sets and asserts the same 8 hardcoded names the implementation deletes, plus one unrelated survivor var. There is no test that a non-listed provider credential (e.g. GEMINI_API_KEY or an openbuff.json-configured apiKeyEnv variable) stays out of child env — the exact failure mode of the denylist design is structurally untestable by the current suite, so the T1 claim is only verified against its own echo.
- **Fix:** Add a test that derives the expected strip set from the provider-config apiKeyEnv presets and asserts every configured credential env name is absent from getChildProcessEnv() output.
- **Evidence:** env.test.ts 'omits the agent process own provider credentials' sets exactly CODEBUFF_BYOK_OPENROUTER, both OAuth tokens, OPENBUFF_API_KEY, CODEBUFF_API_KEY and asserts toBeUndefined for each — the fixture set is identical to the implementation's delete list, so the test cannot fail on a real leak.

## [LOW] test-coverage — sdk/src/__tests__/cdp-pipe-transport.test.ts:1523 — No test covers writable-side error teardown or late responses after timeout in the CDP transport
- **Risk:** Lifecycle tests cover readable end/close/error and explicit close(), but there is no test that a writable 'error' destroys the transport and rejects pending requests (the constructor wires writable.on('error', destroy)), and none that a late response for an already-timed-out id is ignored without state corruption. The write-side failure path — the one that actually fires when Chrome dies mid-command — is untested.
- **Fix:** Add a writable-error destruction test and a late-response-for-timed-out-id test.
- **Evidence:** No test in the suite instantiates a writable that emits 'error' and asserts pendingCount drops to 0 / isClosed becomes true; no test writes a frame for an id whose timeout already fired and asserts no state change.

## [LOW] dependency-hygiene — sdk/package.json:30 — @types/ws shipped in production dependencies of the published SDK
- **Risk:** @types/ws (8.18.1) is listed in production dependencies alongside the runtime ws dependency; type-only packages shipped as runtime deps inflate installs for SDK consumers and blur the runtime/type boundary. Other @types packages (@types/diff, @types/pngjs) are correctly in devDependencies, so this is an inconsistency.
- **Fix:** Move @types/ws to devDependencies.
- **Evidence:** "dependencies": { "@agentclientprotocol/sdk": ..., "@types/ws": "8.18.1", ..., "ws": "^8.18.0", ... } with a separate devDependencies block that already holds other @types packages.

## [LOW] api-contract — sdk/src/env.ts:60 — getChildProcessEnv's published contract is denylist semantics while the task claims an allowlist
- **Risk:** getChildProcessEnv is consumed by sidecar-supervisor, 3d-assets, and run-terminal-command on the documented contract that non-credential vars survive verbatim. The P0-T1 claim describes an 'allowlist', but the implemented contract is a denylist: converting to a true allowlist later would remove vars callers may have come to rely on (a behavioral break), and today the doc comment overstates isolation ('must not be able to read those secrets') relative to what the implementation guarantees.
- **Fix:** Document the exact guarantee on the export (denylist, enumerated keys, subject to growth) so the contract is explicit before the set changes.
- **Evidence:** Comment: 'delete only the specific keys that hold Openbuff's own BYOK/OAuth/API credentials AND those generic upstream provider keys ... Keys are deleted by exact name (no wildcard filtering)'; the claim T1 describes this as an allowlist.

## [LOW] performance — packages/agent-runtime/src/process-str-replace.ts:2255 — Near-match failure path runs the full candidate scan twice (findClosestMatches)
- **Risk:** On the no-match failure path tryMatchOldStr calls findClosestMatches twice: once inside tryNearMatchAutoCorrect (limit 8) and again for the diagnostics block. Each call scores 7 window sizes across every line of the file (Float32Array scans) and runs Levenshtein on the top candidates — for a 100KB+ file the failure path pays the full candidate scan twice, doubling latency exactly when the model is retrying in a loop.
- **Fix:** Compute the match set once (share the findClosestMatches result between the auto-correct attempt and the diagnostics render).
- **Evidence:** const nearMatch = await tryNearMatchAutoCorrect({ ... limit: 8 via findClosestMatches }) ... const closestMatches = findClosestMatches({ initialContent, oldStr }) — two full candidate scans per failed match.

## [LOW] performance — packages/agent-runtime/src/process-str-replace.ts:1560 — updateValidatedRangesAfterEdit re-splits the whole file per edit event
- **Risk:** updateValidatedRangesAfterEdit executes content.split('\n') on the full current content for every edit event, and it is invoked once per replacement event (and per occurrence in the allowMultiple path) inside the batch loop — O(events × ranges × file size) on 100KB+ anchored batches.
- **Fix:** Split the content once per edit and pass the precomputed lines (or update ranges arithmetically without re-slicing).
- **Evidence:** updateValidatedRangesAfterEdit: `const lines = content.split('\n')` executed once per call; called in a loop over replacementResult.editEvents and again per occurrence in the unanchored allowMultiple path.

## Coverage receipt

### Subsystems
- sdk-env
- sdk-cdp-transport
- sdk-terminal-policy
- sdk-terminal-execution
- sdk-browser-logs
- sdk-3d-assets
- agent-runtime-str-replace
- buffbench-statistics

### Features
- P0-T1-child-process-env-credential-scrub
- P0-T2-cdp-pipe-transport-fail-closed
- P0-terminal-command-policy-profiles
- P0-str-replace-tree-sitter-preflight
- P0-T6-paired-bootstrap-ci
- P0-T8-wilcoxon-significance-gate
- chrome-sandbox-args-probe
- blender-child-env-usage
- staged-commit-safety-gate

### Files
- sdk/src/env.ts
- sdk/src/__tests__/env.test.ts
- sdk/src/tools/cdp-pipe-transport.ts
- sdk/src/__tests__/cdp-pipe-transport.test.ts
- sdk/src/tools/terminal-command-policy.ts
- sdk/src/tools/run-terminal-command.ts
- sdk/src/tools/browser-logs.ts
- sdk/src/tools/3d-assets.ts
- packages/agent-runtime/src/process-str-replace.ts
- evals/buffbench/statistics.ts

### Domains
- security
- correctness
- state-mutation
- error-handling
- performance
- dependency-hygiene
- test-coverage
- api-contract
