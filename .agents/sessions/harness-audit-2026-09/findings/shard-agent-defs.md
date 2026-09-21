# Audit findings: shard-agent-defs

- Subsystems: base2-orchestrator, base2-mode-variants, tool-tiers, quality-prompt-sections, gate-reviewer-helpers, editor-family, thinker, file-explorer-family, general-agent, code-reviewer, security-reviewer, specialist-factory, basher, tmux-cli, context-pruner, git-committer, dependency-manager, librarian, agents-constants, agents-test-suite
- Features: progressive-prompt-disclosure, guide-pointer-table-and-fallbacks, spawnable-roster-mode-deltas, tool-tier-mode-gates, typed-editor-handoff-envelope, repair-editor-versioned-handoff, reviewer-structured-verdict-schema, reviewer-snapshot-attestation-fingerprint, reviewer-bypass-challenge, specialist-snapshot-id-omit-for-manual-contract, audit-shard-write-authority, knowledge-memory-compaction, untrusted-capture-wrapping, github-clone-allowlist, dependency-rollback-receipts-v2, pruner-budgets-generated-region, roster-drift-guards, tool-reachability-guards, quality-prompt-byte-freeze, set-output-mention-alignment
- Files covered: 35
- Snapshot: df9b2f192f10abc4503dfdc5a5a30643b0fd9ca84ef8d8cf5cd8988d93669cc1

## [HIGH] security — agents/git-committer/git-committer.ts:171 — git add quoting uses JSON.stringify — double-quoted shell interpolation surface on owned_paths
- **Risk:** owned_paths entries are quoted with JSON.stringify (double quotes), not POSIX single quotes. Inside double quotes the shell expands $(...), backticks, $VAR and \ sequences, so a crafted or model-derived owned_path like 'src/$(rm -rf ~).ts' executes as command substitution when handleSteps builds the git add line. basher.ts and librarian.ts both use correct single-quote escaping, so this is an intra-repo inconsistency, not a missing pattern.
- **Fix:** Use the POSIX single-quote escaping already established in basher.ts/librarian.ts (shellQuote: wrap in single quotes, replace ' with '\'' — note the repo's existing replacement is malformed for values containing backslashes; prefer the standard `'\''` form), and add adversarial quoting tests.
- **Evidence:** command: `git add -- ${ownedPaths.map((path: string) => JSON.stringify(path)).join(' ')}` — contrast basher.ts shellQuote = `'${value.replaceAll("'", `'\''`)}'` and librarian.ts's identical POSIX escape with its SECURITY comment.

## [MEDIUM] security — agents/git-committer/git-committer.ts:336 — git push interpolates branch name without separator or charset guard
- **Risk:** remote is validated against /^[A-Za-z0-9._/-]+$/ but branch (read from `git branch --show-current`) is interpolated unvalidated. A branch name beginning with '-' would be parsed as an option by git push; any shell-significant character is passed to run_terminal_command unescaped.
- **Fix:** Validate branch against the same charset allowlist used for remote (or a git-ref-safe regex), or insert a `--`-style guard; mirror the guard in the rev-list count command.
- **Evidence:** input: { command: `git push -u ${remote} ${branch}` } — no charset test on branch anywhere in the push block; remote has /^[A-Za-z0-9._/-]+$/.

## [LOW] security — agents/base2/base2.ts:9271 — Reviewer bypass challenge id uses Math.random despite the codebase's crypto.randomUUID policy
- **Risk:** The reviewer-bypass challenge id is derived from Date.now() plus Math.random() (~30 bits of entropy), while basher.ts and tmux-cli.ts deliberately migrated to crypto.randomUUID for /tmp paths citing predictability/symlink risk. The bypass authorization is only as strong as the unguessability of this token once a challenge is outstanding.
- **Fix:** Use crypto.randomUUID() for challenge ids, matching the documented rationale in basher.ts/tmux-cli.ts.
- **Evidence:** id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}` — same file family that adopted crypto.randomUUID for /tmp paths in basher.ts and tmux-cli.ts.

## [MEDIUM] error-handling — agents/librarian/librarian.ts:125 — Librarian clone command has no timeout
- **Risk:** The git clone invocation sets no timeout_seconds, so a hung or very large clone blocks the agent turn indefinitely; every downstream step (exploration, set_output) is starved and the parent sees no failure.
- **Fix:** Pass a bounded timeout_seconds (e.g. 300–600) on the clone call and report a timeout as a failed status, consistent with tmux-cli's bounded setup calls.
- **Evidence:** command: 'git clone --depth 1 ' + shellQuote(repoUrl) + ' ' + shellQuote(cloneDir) — no timeout_seconds key in the input object.

## [LOW] correctness — agents/basher.ts:263 — Basher non-summarized path discards non-JSON tool results as empty message
- **Risk:** When what_to_summarize is unset and the run_terminal_command result is not a JSON object (e.g. a plain string result envelope), the code substitutes { message: '' } and the real command output is silently dropped from the agent's structured output.
- **Fix:** Pass string results through as { message: stringValue } (or include rawValue) instead of substituting an empty message.
- **Evidence:** const output = result?.type === 'json' && typeof result.value === 'object' ? result.value : { message: '' }

## [MEDIUM] performance — agents/editor/editor.ts:772 — Editor output returns the full unbounded message transcript to the parent
- **Risk:** The editor's set_output ships the entire newMessages transcript (schema `messages: { type: 'array', items: {} }` — untyped and unbounded) to the parent. A long multi-file edit session lands the full tool-call/tool-result transcripts in the parent's context on top of the spawn-result envelope, with no cap comparable to base2's fitReceiptToStorageBound.
- **Fix:** Compact newMessages to receipt-shaped entries (tool name, paths, commit ids) or cap the payload the way base2's fitReceiptToStorageBound bounds review receipts.
- **Evidence:** outputSchema: messages: { type: 'array', items: {} } ... input: { output: { status, messages: newMessages, changedFiles, ... } } with no slice/cap on newMessages.

## [LOW] correctness — agents/thinker/thinker.ts:119 — Thinker papers over stale local step-resume type with a cast for hitStepCap
- **Risk:** handleSteps recovers hitStepCap via `(resumed as { hitStepCap?: boolean }).hitStepCap` because the package's local step-resume type omits the runtime field. The assertion hides the contract gap; a future rename of the runtime field fails silently and the thinker would re-yield STEP forever against a fixed step cap (the very loop the code documents it must avoid).
- **Fix:** Add hitStepCap to the local step-resume type in agents/types/agent-definition.ts and delete the cast; the narrowing comment already concedes the type is wrong.
- **Evidence:** hitStepCap = (resumed as { hitStepCap?: boolean }).hitStepCap === true — comment: 'hitStepCap is passed at runtime but not declared on the agents package's local step-resume type; cast narrowly (base2 pattern).'

## [LOW] correctness — agents/editor/editor.ts:781 — Duplicated, already-drifted validation-command mapping between editor.ts and base2.ts
- **Risk:** inferValidationCommands in editor.ts and inferPackageTestCommand in base2.ts (base2.ts:9390) both hardcode the openbuff monorepo layout (packages/*, agents/, common/src/, cli/src/) with slightly different rules — editor matches `.py` while base2 matches `.pyi?` for pytest. The copies drift silently, and the shipped generic editor carries repo-specific paths that are dead weight in user projects.
- **Fix:** Hoist the mapping to a shared module (or add it to the generated-region/parity-test pattern) so both consumers cannot drift; parameterize the monorepo-specific prefixes.
- **Evidence:** editor.ts: if (/\.py$/.test(path)) addCommand('pytest') vs base2.ts:9411 if (/\.pyi?$/.test(filePath)) return 'pytest'.

## [MEDIUM] test-coverage — agents/__tests__/git-committer.test.ts:230 — git-committer test pins the unsafe JSON.stringify quoting instead of adversarial paths
- **Risk:** The staging test asserts the exact JSON.stringify-shaped `git add` command, so any fix to the quoting (finding above) must first break this test, and no case exercises shell metacharacters in owned_paths. The test suite currently certifies the injection-prone behavior as correct.
- **Fix:** Replace with a table of hostile path cases (spaces, single quotes, double quotes, $(...), backticks, leading dashes, unicode) asserting the generated command is inert under `sh -c`, independent of quoting style.
- **Evidence:** git-committer.test.ts:230: `git add -- ${ownedPaths.map((path) => JSON.stringify(path)).join(' ')}` — assertion text equals the buggy template.

## [MEDIUM] test-coverage — agents/__tests__/dependency-manager.test.ts:1 — Dependency-manager command matrix and timeout clamping lack exhaustive tests
- **Risk:** The suite exercises rollback/lockfile semantics (advancePastSnapshotRead) but the 18-manager × 5-operation command matrix in handleSteps appears spot-checked rather than table-driven; a wrong verb for one manager (e.g. dotnet/gradle paths) would ship unnoticed, and the timeout_seconds clamp (1..1800, -1 default) has no visible boundary tests.
- **Fix:** Add a table-driven test enumerating expected generated commands for every manager×operation pair, plus timeout clamp boundary cases (0, 1, 1800, NaN).
- **Evidence:** agents/__tests__/dependency-manager.test.ts outlines helpers around snapshot-read advancement; no enumerated manager/operation command table is visible in the suite structure.

## [LOW] correctness — agents/dependency-manager/dependency-manager.ts:621 — Gradle/maven 'restore' emits list-only commands but reports success
- **Risk:** For maven the agent runs `mvn dependency:resolve` and for gradle `./gradlew dependencies` for sync/restore operations; neither restores anything (they only resolve/list), yet the agent then reports status 'success' with 'Dependency operation completed successfully.', overstating the effect to the parent.
- **Fix:** Emit status 'unsupported' with an honest message for restore on maven/gradle (or document resolve-only semantics in the receipt message) so the parent does not treat the operation as completed restore.
- **Evidence:** } else if (manager === 'maven') { commands.push('mvn dependency:resolve') } else if (manager === 'gradle') { commands.push('./gradlew dependencies') }

## [LOW] correctness — agents/specialists/create-specialist.ts:100 — Advisory specialists skip snapshot_id pattern validation entirely
- **Risk:** Reviewer-family specialists enforce params.snapshot_id against ^v3:[a-f0-9]{64}$ when supplied, but the pattern is omitted entirely for advisory specialists (to avoid rejecting an empty value), so an advisory spawn may echo any arbitrary string as snapshotFingerprint with no validation — an asymmetry the prompt text does not disclose.
- **Fix:** Apply `pattern: '^(|v3:[a-f0-9]{64})$'` uniformly (empty-or-v3) so advisory fingerprints get the same shape guarantee without the empty-string reject.
- **Evidence:** ...(config.advisory ? {} : { pattern: '^v3:[a-f0-9]{64}$' }), with comment: 'Do not apply the pattern when advisory so an empty advisory value is not forced into a hard schema reject.'

## [MEDIUM] state-mutation — agents/editor/editor.ts:590 — Triple-maintained inline helper copies with parity tests as the only guard
- **Risk:** Because handleSteps is serialized via toString/new Function, isFileChangingTool/collectToolInputFiles/hasEditArtifact/visit exist as hand-inlined copies in editor.ts, parallel inline copies in base2.ts's <gate-helpers-generated> region, and canonical modules (gate-files.ts, gate-reviewer.ts). base2's region is script-generated with a freshness check, but editor.ts's copies are hand-synced with only a comment ('Keep these in sync'), so a semantic change to committed-receipt acceptance can silently diverge between the editor's changed-file detection and the gate's.
- **Fix:** Extend scripts/generate-gate-helpers.ts to emit the editor's copies (and add a freshness test mirroring pruner-budgets-freshness.test.ts), so all inline copies are generated from the module files rather than hand-synced.
- **Evidence:** editor.ts NOTE: 'these helpers are inlined here ... handleSteps is serialized via .toString()/new Function ... Keep these in sync with agents/base2/gate-files.ts and the parallel inline copies in agents/base2/base2.ts.'

## [MEDIUM] performance — agents/base2/base2.ts:618 — Base2 always-on prompt surface remains multi-thousand-token despite progressive disclosure
- **Risk:** The default-mode system+instructions surface retains a very large always-on block (Code Editing Mandates, Harness-enforced recovery workflow, ~60-line Spawning agents guidelines with per-agent param catalogs) even with progressive prompt disclosure relocating six sections. Every step of the most-spawned agent pays this cost, and there is no per-agent token budget test — only the ≥25% authored-reduction metric for the disclosure feature.
- **Fix:** Add a per-agent assembled-prompt token budget to CI (mirroring the ≥25% authored-reduction metric), and relocate the spawn-guidelines detail block to the guide/fallback-placeholder mechanism already built for the six relocated sections.
- **Evidence:** buildArray block spanning lines 622–682 plus '# Code Editing Mandates' (582-601) and '# Harness-enforced recovery workflow' (603-616) are unconditional in the assembled systemPrompt.

## [LOW] error-handling — agents/basher.ts:60 — Basher defaults to no timeout for arbitrary SYNC commands
- **Risk:** timeout_seconds is optional with 'Omit or -1 for no timeout (the default)', so any SYNC command that hangs (interactive prompt, network wait) wedges the basher agent and its parent's join point with no bound; dependency-manager documents the same unbounded default for package-manager commands.
- **Fix:** Default to a finite bound (e.g. 600s) with an explicit opt-out flag for legitimately long commands, and let BACKGROUND mode cover the never-exiting case it already supports.
- **Evidence:** timeout_seconds: { type: 'number', description: 'Optional wall-clock bound in seconds. Omit or -1 for no timeout (the default).' }

## [LOW] api-contract — agents/dependency-manager/dependency-manager.ts:645 — Dependency-manager spreads raw tool-result values into the public results array
- **Risk:** results.push({ command, ...(resultValue ?? {}) }) copies whatever fields the run_terminal_command envelope currently carries into the public structured output; the array has no declared item schema, so a runtime envelope change (extra/renamed fields, nested payloads) silently changes the agent's output contract consumed by parents.
- **Fix:** Project explicit fields (exitCode, stdout tail, stderr tail, errorMessage, jobId) into the receipt instead of spreading the raw envelope.
- **Evidence:** results.push({ command, ...(resultValue ?? {}) }) — resultValue is `toolResult?.find(...)?.value as Record<string, unknown> | undefined`.

## [LOW] dependency-hygiene — agents/file-explorer/file-picker.ts:53 — CLI imports extractErrorMessage from the agent-definition package
- **Risk:** Module-level extractErrorMessage is exported for tests but is imported by cli/src/utils/error-handling.ts, coupling CLI error handling to a bundled agent-definition module. The agents package becomes a util library by side effect, and the same helper is duplicated a second time inside the serialized handleSteps closure, so three copies can drift.
- **Fix:** Move the helper to a shared util package (e.g. @codebuff/common/util) and re-point the CLI import so the agents package's public surface stays agent definitions.
- **Evidence:** referencedBy extractErrorMessage: ["agents/__tests__/file-picker.test.ts", "cli/src/utils/error-handling.ts"]

## [LOW] correctness — agents/file-explorer/file-picker.ts:236 — Directory-sanitization logic duplicated between file-picker and file-lister with asymmetric 8-dir cap
- **Risk:** The directory sanitization (backslash normalization, ./ strip, absolute/traversal/glob rejection) is duplicated verbatim in file-picker.ts and file-lister.ts; file-lister caps valid directories at 8 (.slice(0, 8)) while file-picker applies no cap when scoping its own output, so the two layers can disagree on scope as the filter evolves.
- **Fix:** Extract the sanitizer into the generated-region/parity pattern (or share via common) and align the directory cap in file-picker with file-lister's documented 8.
- **Evidence:** file-picker.ts requestedDirectories filter (no slice) vs file-lister.ts: .slice(0, 8) with description 'At most 8 valid directories are used; extra entries are ignored.'

## [LOW] error-handling — agents/tmux-cli.ts:690 — tmux-cli setup command runs without an explicit timeout
- **Risk:** The combined setup script (stale-capture sweep, helper write, session start, command send) is yielded without timeout_seconds, unlike the later capture (10s) and stop (15s) calls; a hung tmux/CLI startup blocks the turn unboundedly, and the teardown stop is the only cleanup if STEP_ALL crashes.
- **Fix:** Add a bounded timeout_seconds (e.g. 30) to the setup command and to the teardown stop command for symmetry with the capture call.
- **Evidence:** yield { toolName: 'run_terminal_command', input: { command: setupScript } } — compare the later capture call's timeout_seconds: 10 and stop call's timeout_seconds: 15.

## Coverage receipt

### Subsystems
- base2-orchestrator
- base2-mode-variants
- tool-tiers
- quality-prompt-sections
- gate-reviewer-helpers
- editor-family
- thinker
- file-explorer-family
- general-agent
- code-reviewer
- security-reviewer
- specialist-factory
- basher
- tmux-cli
- context-pruner
- git-committer
- dependency-manager
- librarian
- agents-constants
- agents-test-suite

### Features
- progressive-prompt-disclosure
- guide-pointer-table-and-fallbacks
- spawnable-roster-mode-deltas
- tool-tier-mode-gates
- typed-editor-handoff-envelope
- repair-editor-versioned-handoff
- reviewer-structured-verdict-schema
- reviewer-snapshot-attestation-fingerprint
- reviewer-bypass-challenge
- specialist-snapshot-id-omit-for-manual-contract
- audit-shard-write-authority
- knowledge-memory-compaction
- untrusted-capture-wrapping
- github-clone-allowlist
- dependency-rollback-receipts-v2
- pruner-budgets-generated-region
- roster-drift-guards
- tool-reachability-guards
- quality-prompt-byte-freeze
- set-output-mention-alignment

### Files
- agents/base2/base2.ts
- agents/base2/base2-plan.ts
- agents/base2/quality-prompt-section.ts
- agents/base2/tool-tiers.ts
- agents/base2/gate-reviewer.ts
- agents/editor/editor.ts
- agents/editor/repair-editor.ts
- agents/thinker/thinker.ts
- agents/file-explorer/file-picker.ts
- agents/file-explorer/file-lister.ts
- agents/file-explorer/directory-lister.ts
- agents/file-explorer/glob-matcher.ts
- agents/general-agent/general-agent.ts
- agents/reviewer/code-reviewer.ts
- agents/security-reviewer/security-reviewer.ts
- agents/basher.ts
- agents/context-pruner.ts
- agents/specialists/create-specialist.ts
- agents/specialists/architect.ts
- agents/specialists/performance-specialist.ts
- agents/specialists/evaluator.ts
- agents/git-committer/git-committer.ts
- agents/dependency-manager/dependency-manager.ts
- agents/librarian/librarian.ts
- agents/tmux-cli.ts
- agents/constants.ts
- agents/package.json
- agents/tool-reachability.test.ts
- agents/__tests__/base2.test.ts
- agents/__tests__/roster-drift.test.ts
- agents/__tests__/audit-contracts.test.ts
- agents/__tests__/editor.test.ts
- agents/__tests__/thinker.test.ts
- agents/__tests__/git-committer.test.ts
- agents/__tests__/dependency-manager.test.ts

### Domains
- security
- correctness
- state-mutation
- error-handling
- performance
- dependency-hygiene
- test-coverage
- api-contract
