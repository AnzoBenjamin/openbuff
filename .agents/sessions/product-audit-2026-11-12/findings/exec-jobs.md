# Shard `exec-jobs`: command execution, background jobs, approvals, sandbox

Audit at HEAD `f5aba489d`, read-only. Nothing was executed except `git log/show`, `ls`, `wc` and `grep`. Unless a finding says otherwise, its line references were read directly. Two claims were inferred from code paths without being reproduced; they are marked *(inferred)*.

## Scope

**Inspected**
- Schemas: `common/src/tools/params/tool/{run-terminal-command,check-job,list-jobs,kill-job,run-targeted-validation,get-affected-tests,get-build-targets,git-status,git-branch}.ts`
- Runtime handlers: `packages/agent-runtime/src/tools/handlers/tool/` (same nine)
- SDK tools:
  - `sdk/src/tools/`: `run-terminal-command.ts`, `terminal-command-policy.ts`, `terminal-output-spool.ts`, `background-jobs.ts`, `check-job.ts`, `list-jobs.ts`, `kill-job.ts`, `read-logs.ts`, `git-status.ts`, `git-branch.ts`, `get-affected-tests.ts`, `get-build-targets.ts`, `run-targeted-validation.ts`
  - `sdk/src/job-update-forwarder.ts`
- SDK services and host execution:
  - `sdk/src/services/`: `execution-launch.ts`, `harness-enforcement.ts`, `native-exec.ts` (platform gate), `configured-host-execution.ts`
  - `sdk/src/host-execution.ts`
  - `sdk/src/run.ts`: terminal dispatch, the job forwarder, the list_jobs and git_status gates, and run-end cleanup
- CLI:
  - `cli/src/commands/permissions.ts`, `cli/src/commands/command-registry.ts`
  - `cli/src/components/permissions-screen.tsx`, `cli/src/components/pending-bash-message.tsx`, `cli/src/components/terminal-command-display.tsx`
  - `cli/src/utils/`: `create-run-config.ts` (approval prompt), `command-approvals.ts`, `sdk-event-handlers.ts` (`handleJobUpdate`), `renderer-cleanup.ts`
- Agents: `agents/basher.ts`, `agents/base2/base2.ts` (spawnable agents and job guidance), `agents/base2/tool-tiers.ts`
- Docs: `docs/agents-and-tools.md` (restriction policy and shell shims), `docs/configuration.md` (filesystem sandbox and execution backend)
- Rust, at feature level: `rust/crates/openbuff-native/src/exec/*`, `tests/exec-control.rs`
- Commit `a5ab1abb9` (make filesystem sandboxing opt-in)
- Prior work: `.agents/sessions/body-capability-review-2026-11-05/findings/09-execution.md`, `PLAN.md` cards B18–B21, `docs/execution/body-roadmap/STATE.md`

**Skipped**
- Rust internals beyond feature level (seccomp filter contents, Landlock ruleset construction): out of the brief's scope.
- `rust/crates/openbuff-workspace-harness`: not an exec or sandbox crate.
- Test file bodies: inventoried by name only. Failure-path coverage claims rest on name searches and are marked as such.
- ACP `serve` approval bridge: read only for its approval contract (`sdk/src/serve/bridge.ts:159,561-615`, via context gathering).

## Feature inventory

| Feature | Entrypoint | Implementation | Tests | Maturity |
|---|---|---|---|---|
| Sync shell command | `run_terminal_command` (`common/.../run-terminal-command.ts:126-232`) | `sdk/src/tools/run-terminal-command.ts:1205-1793`, `execution-launch.ts` | `sdk/src/__tests__/run-terminal-command.test.ts` (timeout 287, env 607, spool 1538-1713) | useful |
| Output spool + retrieval | `fullLogPath` → `read_logs` | `terminal-output-spool.ts`, `read-logs.ts` | `run-terminal-command.test.ts:1538+`, `read-logs.test.ts` | partial (finding 11) |
| Background job start | `process_type: BACKGROUND`, `detach` | `background-jobs.ts:739-1045` | `run-session-job-ownership.test.ts`, `run-job-updates.test.ts` | useful |
| Poll/follow job | `check_job` | `sdk/src/tools/check-job.ts` | `check-job*.test.ts` | useful |
| List jobs | `list_jobs` | `list-jobs.ts`, digest gate `run.ts:2630-2672` | `list-jobs.test.ts`, `run-list-jobs-gate.test.ts` | useful |
| Kill job | `kill_job` | `kill-job.ts`, `background-jobs.ts:1420-1550` | `kill-job.test.ts` | partial (findings 12, 13) |
| Live job output to user | `job_update` SDK event | `job-update-forwarder.ts`, `cli/src/utils/sdk-event-handlers.ts:1386-1460` | `run-job-updates.test.ts` | partial (tool card only) |
| User job list/kill/attach in TUI | — | — | — | absent |
| User `!` shell | `/bash`, `!` prefix | `command-registry.ts:538`, `pending-bash-message.tsx` | — (none found) | useful (no streaming) |
| Approval modes | `--approval-mode`, `/permissions`, `approvalMode` in `openbuff.json` | `harness-enforcement.ts:17,1450-1528`, `host-execution.ts:104-207`, `command-approvals.ts:3-19` | `harness-enforcement.test.ts`, `execution-approval.test.ts`, `permissions-screen.test.tsx` | useful |
| Persistent allow/deny rules | — | — | — | absent |
| Per-agent terminal profiles | `terminalPermissionProfile` on templates | `terminal-command-policy.ts:2112-2470` | `terminal-command-policy.test.ts` (unit only) | unwired (finding 02) |
| Targeted validation | `run_targeted_validation` | `sdk/src/tools/run-targeted-validation.ts` → `file-change-hooks` | `run-targeted-validation.test.ts` | useful |
| Affected tests | `get_affected_tests` | `get-affected-tests.ts` → `harness-intelligence` | none found by name | partial (graph tier empty) |
| Build targets | `get_build_targets` | `get-build-targets.ts` → `build-graph` | none found by name | useful |
| Git status | `git_status` | `git-status.ts`, per-turn gate `run.ts:~2700` | `git-status.test.ts`, `run-git-status-gate.test.ts` | useful |
| Git branch | `git_branch` | `git-branch.ts` | `git-branch.test.ts` | useful (friction: finding 15) |
| Basher agent | spawn `basher` | `agents/basher.ts` | agents tests | useful |
| Filesystem sandbox | `sandbox.mode: project` | `common/src/util/filesystem-sandbox.ts`, path containment | `filesystem-sandbox.test.ts` | useful (opt-in) |
| OS sandbox (bwrap/seccomp/Landlock) | `execution.profile.preferredBackend: native-exec` | `native-exec.ts`, `rust/.../exec/*` | `native-exec.test.ts`, `exec-control.rs` | partial (Linux x64 only, user-supplied binary, B21 open) |
| Network policy | `plan.network == "deny"` → `--unshare-net` | `linux_sandbox.rs:211-223` | none found end to end | partial (native only, all-or-nothing) |
| Interactive/PTY commands | — | — | — | absent |
| Shell shims | `openbuff shims install` (docs) | — | — | absent (docs only) |

## Findings

### exec-jobs-01: No default timeout, and stdin is an open pipe, so prompting commands hang indefinitely
- **Axis:** reliability, usability
- **Severity:** HIGH
- **Evidence:**
  - The schema default is `timeout_seconds: -1`, documented as "no local timeout (the default)" (`common/src/tools/params/tool/run-terminal-command.ts:159-165`).
  - `-1` maps to `{kind:'unbounded'}` (`sdk/src/services/execution-launch.ts:49-60`).
  - The SDK fills `-1` when the field is omitted (`sdk/src/run.ts:3450`). Basher also defaults to `-1` (`agents/basher.ts:192-198`).
  - SYNC spawns with `stdio: 'pipe'` (`run-terminal-command.ts:1325,1482`). stdin is only closed on stop (`common/src/util/owned-process-scope.ts:85`, via context gathering).
  - There is no idle or no-output timeout anywhere in `execution-launch.ts`. The only mitigation is prompt text ("use -y ... will hang", schema lines 195-196).
- **Impact:**
  - Any command that prompts for input blocks the turn until the user cancels: `git rebase -i`, `npx create-*`, `ssh` host-key prompts, `npm init`, a test runner in watch mode run as SYNC.
  - The model gets no signal that the command is waiting for input.
  - In headless `openbuff run` or SDK runs with no parent deadline, the run can stall forever.
- **Suggested fix:**
  - Default SYNC to a finite timeout that the model can raise (Claude Code uses 2 min default and 10 min max; OpenCode uses 2 min).
  - Optionally auto-background on timeout (OpenCode's auto-background).
  - Give SYNC `stdin: 'ignore'` or `/dev/null` so prompts fail fast with EOF.
  - Add an idle-output watchdog that returns `{waitingForInput?: true}` with the tail.
  - Keep `-1` as an explicit opt-in.
- **Prior review:** new. B19 covers "actual timeout matches documentation" for hooks only.

### exec-jobs-02: Per-agent terminal permission profiles are dead code, and plan mode can run any shell command through basher
- **Axis:** security, cohesion
- **Severity:** HIGH
- **Evidence:**
  - The runtime hardcodes `permission_profile: 'full-access'` for every agent (`packages/agent-runtime/src/tools/handlers/tool/run-terminal-command.ts:38-42`). Its test pins this behavior (`.../__tests__/run-terminal-command.test.ts:68-98`, via context gathering).
  - The SDK then substitutes the host profile (`sdk/src/run.ts:3448`). The host profile is `full-access` unless `sandbox.mode` is `project` (`sdk/src/host-execution.ts:111-113`).
  - `terminalPermissionProfile: 'workspace-write'` on basher (`agents/basher.ts:80`) and the profiles on git-committer and the read-only agents therefore never reach `evaluateTerminalCommandPolicy` (`terminal-command-policy.ts:2112`).
  - Basher is spawnable in plan mode (`agents/base2/base2.ts:509-522`). In plan mode, `run_terminal_command` itself is withheld (`agents/base2/tool-tiers.ts:134-135`), so the read-only restriction applies to only one of the two shell routes.
  - The docs admit that plan-only attenuation is "currently overridden by the global full-access terminal profile" (`docs/agents-and-tools.md:62-63`).
  - The comment at `sdk/src/run.ts:3436-3446` still claims that the template profile clamps the policy engine. It is stale.
- **Impact:**
  - "Plan mode" is not read-only for shell commands: the model can `rm`, `git commit` or `npm install` through basher in plan mode, subject only to the balanced-mode approval classifier.
  - The roughly 2,400 lines of profile logic, including the git-commit owned-path staging and the dependency-manager no-composition rules, are untested in production.
- **Suggested fix:**
  - Either thread the template's `terminalPermissionProfile` as an upper bound intersected with the host profile, or delete the profile machinery and its schema enum.
  - At minimum, clamp plan-mode descendants to `read-only`.
  - Fix the stale comment.
- **Prior review:** partially covered by B19, which deliberately preserves "the current full-access choice". The plan-mode bypass is new.

### exec-jobs-03: No persistent allow or deny rules, and approval offers only "Allow once" or "Deny"
- **Axis:** completeness, usability
- **Severity:** HIGH
- **Evidence:**
  - The approval prompt has two options only (`cli/src/utils/create-run-config.ts:180-209`). Approval returns true only for `'Allow once'` (`create-run-config.ts:279`).
  - Grants are single-use: each grant is consumed immediately (`sdk/src/host-execution.ts:203-206`; `harness-enforcement.ts:73-148`).
  - There is no rule language and no settings key for command patterns. `provider-config.ts:517-520` has only an `approvalMode` enum.
  - `/permissions` changes an in-memory session override and persists nothing (`cli/src/commands/permissions.ts:14-48`).
- **Impact:**
  - In strict mode, every repeat of `bun test`, `git commit` or `npm install` prompts again.
  - The user cannot express "always allow `bun run typecheck`", "never allow `terraform`", or "allow `curl` to registry.npmjs.org".
  - Teams cannot ship a project policy, and CI has no explicit deny-on-prompt mode. Headless runs fail closed only because no callback is wired (`host-execution.ts:201`).
- **Suggested fix:**
  - Add ordered allow, ask and deny rules over the classified effect roster, of the form `{tool, pattern, effect}` with deny-wins semantics, in the style of Kiro's `permissions.yaml` or Claude Code's `Bash(prefix *)`.
  - Store user and workspace rules outside the repo, as Kiro does under `~/.kiro/workspace-roots/<hash>`.
  - Add "Allow always for this prefix" and "Allow for this session" options to the prompt.
  - Add an explicit `--approval-mode=deny-prompts` for CI.
- **Prior review:** new.

### exec-jobs-04: A cloned repo's `openbuff.json` can likely set `approvalMode: allow-all` without a trust gate *(inferred)*
- **Axis:** security
- **Severity:** MEDIUM
- **Evidence:**
  - The project and ancestor `openbuff.json` is discovered without a prompt, and in-project files are treated as trusted (`sdk/src/host-config.ts:107-118,189-198`).
  - Only `apiKeyEnv` providers are dropped for untrusted origins (`sdk/src/provider-config.ts:1243-1248`). I found no origin filter on `approvalMode`.
  - In contrast, `execution` is user-global-only (`docs/configuration.md:565-570`), `sandbox.allowPaths` from the project is ignored by default (`docs/configuration.md:546-550`), and `.agents/` requires `--trust-project-agents`.
- **Impact:** A malicious repo can silently disable approval prompts for the next run. This is the "repo grants itself power" class that Kiro and Gemini's trusted-folders gate close.
- **Suggested fix:**
  - Ignore `approvalMode` from project or ancestor origins unless the folder is trusted.
  - Allow project files only to tighten approval (`balanced` → `strict`), mirroring Kiro's "a project file can only tighten" rule.
  - Add a test.
- **Prior review:** partially covered by B29 (trusted bundles/extension tiers); `approvalMode` origin is not named there.

### exec-jobs-05: Balanced mode's description says unclassified effects ask, but they run freely
- **Axis:** security, usability
- **Severity:** MEDIUM
- **Evidence:**
  - The description reads "Routine commands run freely; destructive, remote, and unclassified effects ask" (`cli/src/utils/command-approvals.ts:13-14`).
  - In code, a command with no classified effect that parses cleanly is allowed (`sdk/src/host-execution.ts:151`).
  - The balanced high-impact set excludes `dependency-install`, `commit` and `push` (`harness-enforcement.ts:1484-1491`).
  - The classifier misses several risky shapes (`harness-enforcement.ts:262-405`): `npx`/`bunx <pkg>` (downloads and executes), `node script.js`, `curl -X POST` without `-d`, `chmod`, `mv`/`cp` and `>` overwrites, `rm -f` without `-r`, `docker build`, `git push origin feature`.
  - `pip install` and `npm install` run lifecycle scripts unprompted.
- **Impact:** Users who pick balanced because they read "unclassified effects ask" get weaker protection than advertised.
- **Suggested fix:**
  - Either change the copy to "unparseable shell asks", or classify `npx`/`bunx`/`dlx` and `pipx run` as arbitrary-code.
  - Add a `network-fetch-exec` effect.
  - Document the exact balanced matrix in `docs/configuration.md`.
- **Prior review:** B18 (accepted) fixed first-effect masking (09-F2) and push risks (09-F3). Both are verified fixed at HEAD: the effects loop is at `harness-enforcement.ts:1475-1483` and push risks at `:280-305`. The copy mismatch and the coverage gaps are new.

### exec-jobs-06: The approval prompt shows only the first effect, while approval authorizes the whole command
- **Axis:** usability, security
- **Severity:** MEDIUM
- **Evidence:**
  - The requested `target` is `first?.target` (`sdk/src/host-execution.ts:180-183`).
  - `buildHarnessApprovalPrompt` renders `request.action` and `request.target` only (`cli/src/utils/create-run-config.ts:180-189`). `rawCommand` and `effects[]` are passed in (`host-execution.ts:194-197`) but never displayed.
  - Example: for `npm install && rm -rf build`, the header reads "Allow dependency-install: npm install". The `rm` appears only in the reason text.
- **Impact:** The user approves a command they did not fully see. Approval binds the full command hash, so the hidden effect runs.
- **Suggested fix:** Render the full `rawCommand` and one line per classified effect, plus `parseStatus`.
- **Prior review:** partially covered by B18 (accepted), which emits the full roster to policy but not to the prompt UI. The UI gap is new.

### exec-jobs-07: The OS sandbox is off by default and effectively unavailable to normal users, and network control is all-or-nothing
- **Axis:** completeness, security
- **Severity:** MEDIUM
- **Evidence:**
  - Commit `a5ab1abb9` made filesystem containment opt-in. The default policy is unrestricted, so the host profile is `full-access` (`sdk/src/host-execution.ts:111-113`).
  - Even `sandbox.mode: project` is a tool-level policy: "the portable terminal backend does not isolate subprocesses at the OS level or restrict their network access" (`docs/configuration.md:539-541`).
  - The portable backend enforces only `exact-env` (`host-execution.ts:34-43`).
  - Native enforcement requires Linux x64 and a user-supplied artifact path with a sha256 pin (`sdk/src/services/native-exec.ts:204-217`; `docs/configuration.md:563-617`). The exec modules are `cfg(target_os="linux")`-only.
  - Network is either `--unshare-net` or fully open. There is no domain allowlist proxy (`rust/.../linux_sandbox.rs:211-223`, via context gathering).
- **Impact:**
  - Compared with Codex (sandbox on by default: Seatbelt, bwrap+seccomp, Windows sandbox user, network off) and Kiro (`DEFAULT_BLOCKED`, `COMMON_DEPENDENCIES`, `DEFAULT_ALLOWED`), Openbuff has no usable OS boundary on macOS or Windows.
  - On Linux the OS boundary needs manual binary installation.
  - The approval classifier is therefore the only line of defense.
- **Suggested fix:**
  - Ship the native binary per platform with the package.
  - Add a one-flag `--sandbox` that fails closed (Kiro's behavior).
  - Add a "package registries only" network preset.
  - Implement Seatbelt on macOS per D48/D49.
  - Until then, say plainly in `/permissions` that commands are not OS-isolated.
- **Prior review:** covered by B21 (in progress per `docs/execution/body-roadmap/STATE.md:3,13`). Distribution and the network allowlist are not in B21.

### exec-jobs-08: The user cannot list, watch, attach to or kill background jobs from the TUI
- **Axis:** completeness, usability
- **Severity:** MEDIUM
- **Evidence:**
  - `command-registry.ts` has no jobs or tasks command. The only related commands are `permissions` (507) and `bash` (538).
  - Jobs appear only as the originating tool card. `handleJobUpdate` appends deltas to `block.output` (`cli/src/utils/sdk-event-handlers.ts:1386-1430`).
  - The card shows `job <id>` and the log path as text (`cli/src/components/terminal-command-display.tsx:86-93`) and has no stop button.
  - The stop button exists only for the user's own `!` commands (`pending-bash-message.tsx:20`).
- **Impact:**
  - A dev server the agent started keeps running until the agent decides to call `kill_job` or the process dies.
  - After the card scrolls away, the user has no way to find it.
  - Claude Code has `/tasks` and Kiro has `Ctrl+G` for subagents. Gemini lets the user Tab into the PTY.
- **Suggested fix:**
  - Add `/jobs` with list, tail, follow and kill actions, backed by the existing `jobRegistry` and `killBackgroundJob`, which the CLI already uses through the SDK.
  - Add a kill key on running job cards.
  - Show a status-line count of running jobs.
- **Prior review:** new.

### exec-jobs-09: Attached background jobs appear to outlive CLI exit as orphans *(inferred)*
- **Axis:** reliability
- **Severity:** MEDIUM
- **Evidence:**
  - Children are spawned as detached process-group leaders (`run-terminal-command.ts:1325`).
  - Run-end cleanup only joins scopes that are already aborted, already stopping, or whose leader has exited (`sdk/src/services/execution-launch.ts:233-237`, called at `run.ts:970`).
  - CLI signal and exit handlers do not touch jobs (`cli/src/utils/renderer-cleanup.ts:111-150`).
  - The log quota timer and the escalation timers are `unref()`'d (`background-jobs.ts:916`).
  - A later session marks such a job `lost` only when someone polls it (`background-jobs.ts` recovery path).
- **Impact:** After Ctrl+C or quit, the agent's `bun dev`, `tail -f` or watchers keep holding ports and CPU with no owner. On the next launch, `list_jobs` does not probe liveness (`sdk/src/tools/list-jobs.ts:57-63`, via context gathering).
- **Suggested fix:**
  - On CLI exit, SIGTERM then SIGKILL every attached, non-detached job owned by this `clientSessionId`.
  - Keep `detach: true` jobs and print them in the exit summary.
  - Add an exit-cleanup test.
- **Prior review:** partially covered by B20 (accepted). It states that "Background stopping/recovery metadata remains an explicit limitation" (`STATE.md:36`). The exit hook is not covered.

### exec-jobs-10: Temp artifacts leak: SYNC spool directories are never removed, and the job-log sweep runs only on the first BACKGROUND spawn
- **Axis:** reliability (resource hygiene)
- **Severity:** MEDIUM
- **Evidence:**
  - After a successful `finish()`, the spool deletes only the raw `stdout` and `stderr` files and keeps `openbuff-command-output-*/output.json` (`sdk/src/tools/terminal-output-spool.ts:112-117`). No sweeper references that prefix.
  - Each spool can hold up to 10 MiB (`terminal-output-spool.ts:8`).
  - The job-file sweep is once per process and only inside `startBackgroundJob` (`background-jobs.ts:401-405,739`).
  - Basher full logs are capped at 20 (`agents/basher.ts:164,208-215`).
- **Impact:** Long sessions with chatty builds or tests accumulate unbounded `/tmp` data. Each overflowing command can leave up to 10 MiB.
- **Suggested fix:** Register spool directories with a TTL sweep that runs at process start, and cap total bytes or count, as basher already does.
- **Prior review:** new.

### exec-jobs-11: Retrieving truncated output is awkward because the spool is a single-line JSON blob and read_logs can only tail
- **Axis:** usability (model-facing)
- **Severity:** MEDIUM
- **Evidence:**
  - Inline output is 50,000 chars per stream, cut from the middle (`run-terminal-command.ts:47,1658-1668`).
  - The full artifact is written as one JSON object, `{"command":...,"stdout":"<escaped>","stderr":"<escaped>"}`, with no newlines (`terminal-output-spool.ts:89-107`).
  - The schema tells the model to read it with `read_logs` (`common/.../run-terminal-command.ts:202`).
  - `read_logs` only tails, by lines and characters, with a 20k default and a 100k cap (`sdk/src/tools/read-logs.ts:21,66-69,245-300`). It has no offset or grep parameter.
  - On a single-line file it returns the last 20k chars of escaped JSON, which contains stderr, not the middle of stdout that was truncated.
- **Impact:**
  - The model cannot reach the truncated middle, which is where the first failing test usually is, without guessing `read_files` ranges on a 10 MB single line.
  - Escaped `\n` sequences make every result harder to read.
  - Claude Code writes plain files and offers a 2k preview. OpenCode, Pi and Codex keep a plain full-output file.
- **Suggested fix:**
  - Keep `stdout.log` and `stderr.log` as plain text files, with the metadata alongside.
  - Return `fullStdoutPath` and `fullStderrPath` with line counts.
  - Give `read_logs` `offset` or `around`, and `grep` parameters.
- **Prior review:** new.

### exec-jobs-12: Windows and macOS gaps: Git Bash auto-detection is dead code, there is no PowerShell, and process-tree kill is partial
- **Axis:** completeness, reliability
- **Severity:** MEDIUM
- **Evidence:**
  - The host passes a Windows shell only when `OPENBUFF_GIT_BASH_PATH` or `CODEBUFF_GIT_BASH_PATH` is set (`sdk/src/host-execution.ts:383-387`). Otherwise the tool refuses (`run-terminal-command.ts:1310-1314`).
  - `findWindowsBash`, which probes common Git Bash install paths, has no callers (`run-terminal-command.ts:1078`). Out-of-the-box Windows users with Git for Windows installed are refused.
  - Windows kill signals only the leader (`background-jobs.ts:67-90`) and has no `taskkill /T`.
  - The process-group tier is Linux-only (`common/src/util/node-process-scope.ts:27`), so on macOS SYNC timeout only signals the bash leader.
  - Recovered jobs require Linux `/proc` start time (`background-jobs.ts:1319`), so on macOS and Windows a recovered job can never be killed and is marked `lost`.
- **Impact:** Windows is effectively unsupported without manual configuration. macOS leaks grandchildren on timeout. Pi and Claude Code ship a native PowerShell tool, and Codex has three Windows sandbox modes.
- **Suggested fix:**
  - Call `findWindowsBash(env)` when building `terminalShell`, and add a PowerShell fallback.
  - Use `taskkill /T /F` for trees on Windows.
  - Enable `posix-owned-group` on darwin.
- **Prior review:** new. The `findWindowsBash` regression is likely a B19 side effect.

### exec-jobs-13: kill_job reports `killed: true` before the kill is confirmed, and the requested signal becomes a force flag
- **Axis:** reliability, contract
- **Severity:** LOW
- **Evidence:** `background-jobs.ts:1433-1447` returns `{killed: true, status: 'stopping'}` immediately after `requestStop` or `retryCleanup(signal === 'SIGKILL')`.
- **Impact:** The model may proceed, for example rebinding a port, while the process is still alive. The status is `stopping` and the boolean says killed.
- **Suggested fix:** Return `killed: 'requested'`, or await cleanup up to the grace period, and document that SIGTERM and SIGKILL select graceful versus force escalation.
- **Prior review:** partially covered by B20 (accepted). That card's acceptance is limited to Linux cooperative cleanup; the result semantics are new.

### exec-jobs-14: The model-facing terminal schema is heavy and partly contradictory
- **Axis:** usability (token cost), cohesion
- **Severity:** LOW
- **Evidence:**
  - The input schema exposes `owner` with the note "agents must omit" (`common/.../run-terminal-command.ts:166-174`). The value is overridden server-side (`run.ts:3451`).
  - The output union carries more than 30 metadata fields across four variants (`:14-122`).
  - The description says both "Stick to these use cases: … Running tests" and "DO NOT … Run scripts without asking" (`:176-189`).
  - It says commands run "from the project root" while unrestricted mode accepts outside cwd (`docs/configuration.md:523-526`).
  - It still says "Don't run `git commit` … unless you get explicit permission" while also embedding a full commit guide (`:203`).
- **Impact:** Every request pays for these tokens, and the model receives mixed policy signals. Pi's bash tool definition is under 100 tokens.
- **Suggested fix:**
  - Drop `owner` from the model schema and inject it server-side only.
  - Shorten the output to `{exitCode, stdout, stderr, fullLogPath?, timedOut?, jobId?, errorMessage?}` and move binding and native metadata to a non-model channel.
  - Reconcile the "scripts" and "git" rules with approval modes.
- **Prior review:** new.

### exec-jobs-15: Overlapping execution surfaces, and git_branch refuses a dirty tree by default
- **Axis:** cohesion, usability
- **Severity:** LOW
- **Evidence:**
  - base2 has both `run_terminal_command` (mode-gated, `tool-tiers.ts:116,134`) and the `basher` subagent. The prompt says to use "basher only for commands without a dedicated tool" (`base2.ts:658`), and line 681 instructs "SYNC basher … BACKGROUND …".
  - Next to these sit `run_targeted_validation`, `get_affected_tests`, `get_build_targets` and `git_status`. Some are programmatic gate tools (`base2.ts:2489-2498`) and some are model tools.
  - `git_branch` defaults `allow_dirty: false` (`common/.../git-branch.ts:27-35`; `sdk/src/tools/git-branch.ts:55-86`). Yet its advertised use case is "commit on a new branch", and `git checkout -b` carries uncommitted changes safely.
- **Impact:**
  - Two routes to the same shell with different output shapes. Basher returns a filtered report, while the direct tool returns raw JSON.
  - The predictable first `git_branch` failure on dirty trees costs the model one extra turn.
- **Suggested fix:**
  - Pick one primary shell route for base2 and keep basher as an explicit "summarize output" helper.
  - Default `allow_dirty: true` for `switch: true`, or refuse only when untracked files would conflict.
- **Prior review:** new.

### exec-jobs-16: get_affected_tests always returns an empty graph tier
- **Axis:** completeness
- **Severity:** LOW
- **Evidence:** `sdk/src/tools/get-affected-tests.ts:9-10,18-22` states that the indexer's reverse-dependency graph is not wired and attaches a fixed `graphNote` to every entry.
- **Impact:** Test selection relies on naming conventions only, so cross-package importers are missed.
- **Suggested fix:** Expose the indexer's `references` query to the SDK. `query_index` already supports `references`, per AGENTS.md.
- **Prior review:** partially covered by B27 (per-root validation and joined target contracts).

### exec-jobs-17: Live job output is truncated head-first in the forwarder but tail-first in the CLI
- **Axis:** reliability (UX fidelity)
- **Severity:** LOW
- **Evidence:**
  - `truncateOutputDelta` keeps the first 2,000 chars of each delta (`sdk/src/job-update-forwarder.ts:6-11`).
  - The CLI keeps the tail of the accumulated output (`safeTailSlice`, `sdk-event-handlers.ts:1420`).
  - Force-emitted 64 KiB carry chunks (`MAX_LINE_BYTES`) therefore lose about 62k chars, including their tail, before the CLI's tail strategy is applied.
- **Impact:** For long single-line output such as minified errors or JSON logs, the user sees the wrong slice.
- **Suggested fix:** Keep the tail in the forwarder too, or split oversized deltas into several events.
- **Prior review:** new.

### exec-jobs-18: Cancelling a SYNC command discards all of its output
- **Axis:** usability
- **Severity:** LOW
- **Evidence:** `run-terminal-command.ts:1622-1627`: on `terminationReason === 'abort'`, the spool is discarded and a refusal with no stdout or stderr is returned.
- **Impact:** A user who interrupts a 5-minute test run loses everything it printed. The timeout path, by contrast, keeps partial output (`:1670-1690`).
- **Suggested fix:** Return the bounded inline stdout and stderr, and persist the spool, on abort as well.
- **Prior review:** new.

### exec-jobs-19: No PTY or interactive input, and no cwd or env persistence between calls
- **Axis:** completeness
- **Severity:** LOW (MEDIUM for TUI-heavy users)
- **Evidence:**
  - Every call is a fresh non-login `bash -c` (`run-terminal-command.ts:1310-1313`; `host-execution.ts:387`).
  - No PTY, `write_stdin` or job-stdin tool exists. BACKGROUND stdin is `ignore` (`background-jobs.ts` spawn `stdio: ['ignore', 'pipe', 'pipe']`).
  - `cd` and `export` do not persist. Only the `cwd` parameter does.
- **Impact:**
  - `git rebase -i`, REPLs, `gh auth login` and interactive installers are impossible. The model cannot answer a prompt from a background job.
  - Codex (`unified_exec` + `write_stdin`) and Gemini (node-pty, Tab to focus) support this. Claude Code persists `cd` within the project.
  - The repo has a `tmux-cli` agent and a `tmux-test` profile as a workaround.
- **Suggested fix:**
  - Add an optional `stdin` or `write_stdin(jobId, data)` for BACKGROUND jobs.
  - Consider a sticky-cwd option.
- **Prior review:** new.

### exec-jobs-20: Shell shims are documented but not implemented
- **Axis:** cohesion (discoverability)
- **Severity:** LOW
- **Evidence:** `docs/agents-and-tools.md:497-507` documents `openbuff shims install` and `openbuff shims env`. A search of `cli/`, `sdk/`, `common/` and `packages/` finds no implementation (via context gathering).
- **Impact:** Users who follow the docs get an unknown-command error.
- **Suggested fix:** Implement the shims or remove the section.
- **Prior review:** partially covered by B11 (contained and discoverable local controls).

### Prior findings re-checked at HEAD
- **09-F1 (whitespace collapse before hash):** fixed. `hashCommand` hashes raw bytes (`harness-enforcement.ts:231-233`). B18 accepted.
- **09-F2 (first effect masks later effects):** fixed. Every effect is evaluated (`harness-enforcement.ts:1475-1483`).
- **09-F3 (feature-branch force/delete push):** fixed. `pushRisks` is checked before the branch check (`:1492-1501`).
- **09-F5 and 09-F6 (leader exit / quota cancels kill):** addressed for Linux cooperative cleanup by B20 (accepted). Per `STATE.md:7` this is not proven on macOS or Windows; see finding 12.
- **09-F8 (hooks lack approval context):** hooks now derive the captured execution context (`sdk/src/tools/file-change-hooks.ts:1601-1606,1676-1696`). B19 is accepted. I did not reproduce this.
- **09-F9 (native smoke tests a stub):** still in B21, which is open.

## Competitive gaps

| Capability | Best-in-class CLI and how it does it | Openbuff state | Priority |
|---|---|---|---|
| Default command timeout | Claude Code: 2 min default, 10 min max (`BASH_DEFAULT_TIMEOUT_MS`). OpenCode: 2 min plus auto-background | Unbounded by default; stdin open (01) | P0 |
| Persistent allow/deny rules | Kiro: `permissions.yaml`, deny-overrides, compound split, stored outside the repo. Claude Code: `Bash(git push *)` rules | None; Allow once / Deny only (03) | P0 |
| OS sandbox default | Codex: on by default (Seatbelt, bwrap+seccomp, Windows sandbox user), network off | Off; native backend Linux x64 only with a manual binary (07) | P1 |
| Network allowlist | Claude Code: proxy allowlist starting empty. Kiro: `COMMON_DEPENDENCIES` preset | All-or-nothing, and native only (07) | P1 |
| Plan mode really read-only | Claude Code, Gemini, Kiro: plan mode blocks mutation | Basher runs full-access in plan mode (02) | P0 |
| User job control | Claude Code: `/tasks`, `Monitor`. Kiro: `Ctrl+G` | Tool card only; no list or kill (08) | P1 |
| Interactive PTY | Codex: `unified_exec` + `write_stdin`. Gemini: node-pty, Tab to focus | None (19) | P2 |
| Truncated-output retrieval | Claude Code: file plus 2k preview, 150k read-back. OpenCode and Pi: plain full-output file | Single-line JSON plus a tail-only reader (11) | P1 |
| Approval prompt fidelity | Kiro: each compound part checked and shown. Claude Code: full command shown | First effect only (06) | P1 |
| Repo-proof policy | Kiro: workspace rules outside the repo, trust screen. Gemini: trusted folders | `approvalMode` likely settable from the repo (04) | P1 |
| Windows shell | Claude Code and Pi: native PowerShell tool. Codex: Windows sandbox | Requires env var for Git Bash; auto-detect unused (12) | P1 |
| Classifier "auto" approvals | Claude Code `auto`, Codex `auto_review`, Kiro `evaluate` (lowest precedence) | None | P2 |
| cwd/env persistence | Claude Code: `cd` persists; `CLAUDE_ENV_FILE` | None (19) | P3 |
| Event stream from jobs | Claude Code `Monitor`: each output line becomes a model event | `check_job` `wait_for` follow (pull, bounded at 600 s) | P3 |

## Strengths

- **Exact, single-use, context-bound approvals.** A grant binds the command hash plus a 29-field v2 execution binding, together with repository, workspace, run and snapshot (`harness-enforcement.ts:186-197`; `host-execution.ts:174-207`). Mode changes cannot authorize an approval already pending (`command-approvals.ts:21-22`). None of the reference CLIs documents approval replay protection at this level.
- **Compound command classification fails closed.** The classifier splits `; && || | &` and newlines, extracts `$()` and backticks, unwraps `sudo`/`env`/`timeout`/`xargs`/`bash -c`/`eval` to depth 3, treats `git -C` and similar global options as unsupported, and denies malformed commands in every mode, including allow-all (`harness-enforcement.ts:539-802,1462-1468`). This is at least on par with Kiro's compound split and stronger than prefix rules.
- **Background job model.**
  - Sequenced event cursors, follow with `wait_for`, and `kill_on_timeout` (`check-job.ts`).
  - Server-side loop-breaker hints, `stop_polling` and `do_not_repoll` (`check-job.ts:76-110`).
  - A per-turn `list_jobs` change gate (`run.ts:2630-2672`).
  - Cross-session recovery with an ownership gate.
  - Hardened temp files: `O_EXCL|O_NOFOLLOW`, mode 0600 (`background-jobs.ts:240-300`).
  - Pi has no background jobs. Claude Code and Kiro offer `run_in_background` without cursorable joins.
- **`touchedPaths` after every command.** Dirty-tree deltas before and after each command attribute shell-made edits to the turn (`run-terminal-command.ts:1771-1777`). Claude Code's checkpoints explicitly do not track Bash changes.
- **Credential scrubbing after env merge.** Canonical and configured credential names are removed after overrides are merged (`common/src/util/execution-context.ts:420-438`; verified by B19). Codex passes `KEY`/`SECRET`/`TOKEN` variables through by default.
- **Bounded memory everywhere.** Each stream accumulates up to 100k chars with head and tail kept (`run-terminal-command.ts:1552-1567`). There is a 10 MiB spool quota with backpressure (`terminal-output-spool.ts:56-69`), and the job registry keeps a 500-event, 1 MiB ring.
- **Native Linux exec design.** bwrap with `--unshare-*`, `--cap-drop ALL` and `--die-with-parent`, a seccomp filter blocking io_uring and sockets, Landlock layering, and a refusal when seccomp is not observed (`linux_sandbox.rs:211-269`; `runner.rs:637-639`). Once shipped, this matches Codex's Linux design.

## Roadmap mapping

| Finding | Mapping |
|---|---|
| exec-jobs-01 timeout/stdin | not covered |
| exec-jobs-02 dead profiles / plan-mode basher | partially (B19 preserves full-access by choice; the plan-mode bypass is not covered) |
| exec-jobs-03 persistent rules | not covered |
| exec-jobs-04 repo-set `approvalMode` | partially (B29 trust tiers) |
| exec-jobs-05 balanced copy and coverage | partially (B18 accepted for compound/push; coverage and copy not covered) |
| exec-jobs-06 prompt shows first effect | partially (B18 roster; UI not covered) |
| exec-jobs-07 OS sandbox / network | covered by B21 (in progress); distribution and network allowlist not covered |
| exec-jobs-08 TUI job control | not covered |
| exec-jobs-09 orphans on exit | partially (B20 limitation noted) |
| exec-jobs-10 temp leaks | not covered |
| exec-jobs-11 log retrieval shape | not covered |
| exec-jobs-12 Windows/macOS | partially (B21 lists macOS Seatbelt and Windows cells; the `findWindowsBash` regression and tree-kill are not covered) |
| exec-jobs-13 kill_job semantics | partially (B20) |
| exec-jobs-14 schema weight | not covered |
| exec-jobs-15 overlapping surfaces / git_branch | not covered |
| exec-jobs-16 empty graph tier | partially (B27) |
| exec-jobs-17 forwarder truncation | not covered |
| exec-jobs-18 abort discards output | not covered |
| exec-jobs-19 PTY / persistence | not covered |
| exec-jobs-20 shell shims | partially (B11) |
