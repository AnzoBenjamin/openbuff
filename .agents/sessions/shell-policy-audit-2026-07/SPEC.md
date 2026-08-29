# SPEC — Shell/Terminal Security Restriction Audit

## Overview

Audit the terminal-command permission layer for restrictions that are more
punishing than protective — controls that block legitimate agent work (the
git-committer is the motivating example) without adding meaningful security
value. Produce ranked removal/relaxation candidates, clearly separating
low-value friction from genuine security controls that must stay.

The trigger: `git-committer` (profile `git-commit`) cannot reliably run git.
Root cause confirmed below is a direct contradiction between the guidance the
model receives and what the policy permits.

## Goals

- Enumerate every enforcement point in the terminal/shell policy layer.
- Classify each restriction as: (A) safe to relax/remove, (B) consolidate, or
  (C) keep (real security value).
- Give concrete, minimal change candidates for the (A)/(B) items.
- Fix the git-committer reliability problem specifically.

## Non-Goals

- Removing path-traversal, force-push, privilege-escalation, env-dump, or
  sensitive-file protections (these are (C) — real value).
- Rewriting the harness approval system.
- Touching `full-access`/`user` mode behavior.

## Relevant systems / files

- `sdk/src/tools/terminal-command-policy.ts` — `evaluateTerminalCommandPolicy`,
  per-profile guards (git-commit, dependency-mutation, read-only,
  validation-diagnosis, tmux-test, workspace-write). ~1200 lines. Primary surface.
- `sdk/src/tools/run-terminal-command.ts` — calls the policy, then
  `classifyTerminalHarnessAction`, then `validateStagedCommit` for git commits.
- `sdk/src/services/harness-enforcement.ts` — `classifyTerminalHarnessAction`,
  `evaluateHarnessActionPolicy` (second enforcement layer, approval-based).
- `agents/git-committer/git-committer.ts` — profile `git-commit`; handleSteps
  yields git commands; `owned_paths` → `allowed_paths`.
- `common/src/constants/git-discipline.ts` — `gitCommitGuidePrompt` (recommends
  HEREDOC commit form that the git-commit profile blocks).
- `common/src/tools/params/tool/run-terminal-command.ts` — injects
  `gitCommitGuidePrompt` into the tool description (line ~135).
- `cli/src/commands/git-command-args.ts` — `parseSafeGitArgs` /
  `FORBIDDEN_SHELL_CHARACTERS` for the `/git diff` and `/git status` slash commands.
- Profile assignments: `agents/git-committer`, `agents/dependency-manager`,
  `agents/debugger`, `agents/librarian`, `agents/browser-use`, `agents/tmux-cli`,
  `agents/basher`, `.agents/lib/create-cli-agent.ts`.

## Findings (evidence-backed)

### F1 — [HIGH friction] git-commit policy contradicts its own guidance

- `hasActiveShellSyntaxAnywhere` rejects `$(`, backtick, `<`, `>` ANYWHERE in a
  git-commit command (deliberately not quote-aware because `bash -c` expands
  inside quotes). Raw newlines are also rejected for non-full-access profiles.
- `gitCommitGuidePrompt` explicitly instructs: `git commit -m "$(cat <<'EOF' ... EOF)"`.
- Net effect: the documented multi-line commit workflow is impossible under
  `git-commit`; the agent is limited to single-line `-m "..."`. This is the
  "can't reliably manage git" symptom.

### F2 — [MEDIUM] Triple, overlapping enforcement for git actions

A single `git commit` from git-committer passes through:

1. `evaluateTerminalCommandPolicy` (git-commit profile — already fully constrains it),
2. `classifyTerminalHarnessAction` → `commit` action (approval layer; gated in
   `strict` mode),
3. `validateStagedCommit` re-scan in run-terminal-command.ts.
   The profile is already authoritative for git-committer; layers 2–3 add friction
   and cognitive load with little marginal safety for this already-locked profile.

### F3 — [LOW] git add requires non-empty allowed_paths + exact subset

`git add` under git-commit fails unless every staged path is an exact,
normalization-matched member of `owned_paths`. Legitimate but a real source of
"it refused my command" surprises when owned_paths is omitted or mismatched.

### F4 — [MEDIUM friction] Read-only git composition allowlist is too narrow

Under git-commit, shell composition (`|`/`&&`/`;`) requires EVERY segment to be
an allowlisted read-only _git_ command (`splitReadOnlyShellSegments().every(isReadOnlyGitCommand)`).
So ordinary inspection like `git log --oneline | head -20` is rejected because
`head` isn't a git command. Over-restrictive for an agent whose whole job is
inspecting git state.

### F5 — [LOW] CLI /git slash-command arg parser blocks pathspec syntax

`FORBIDDEN_SHELL_CHARACTERS = /[\n\r;$\`|&<>()[\]{}\\]/`blocks`[ ] { } ( )`,
which are legitimate in git pathspecs/brace globs (e.g. `:(exclude)`, `app/{a,b}`).
User-facing convenience command only.

### F6 — [KEEP / note] tmux-test TMUX_UNSAFE_EXECUTABLES is very broad

Blocks node/bun/make/find/awk/sed/python/etc. Niche profile; intentional. Note
but do not relax without a dedicated review.

## Keep — real security value (do NOT remove)

- Path traversal + outside-project absolute-path containment.
- Force/delete-push block; default-branch push approval gate.
- Privilege escalation (`sudo`/`su`), system package managers, env dumping.
- Sensitive-file / private-key staged-commit scan (`validateStagedCommit`).
- tmux write-through-shell fixture block.
- Interpreter one-liners that read env / spawn subprocesses in read-only mode.

## Acceptance criteria

- Each finding has a concrete file:line-backed cause and a proposed minimal change.
- git-committer can produce a multi-line commit and do normal read-only
  inspection composition after Tier 1.
- No (C) control is weakened.
- Existing `terminal-command-policy.test.ts` security cases still pass; new
  cases cover the relaxed paths.
