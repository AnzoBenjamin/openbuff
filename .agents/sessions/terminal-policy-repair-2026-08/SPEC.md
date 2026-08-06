# SPEC — Terminal policy repair after reviewer gate (2026-08)

## Overview
The blanket "no raw newlines" terminal policy was removed from `evaluateTerminalCommandPolicy` (done, policy tests 33/33 green, typecheck hooks green). The reviewer gate returned 6 blocking findings (RF-1..RF-6) that must be repaired before the gate clears. All work is confined to two files:

- `sdk/src/tools/terminal-command-policy.ts`
- `sdk/src/__tests__/terminal-command-policy.test.ts`

Current snapshot fingerprint (use the harness-provided full value at execute time): `v3:7fa30d019b80a…` (files=sdk/src/tools/terminal-command-policy.ts, sdk/src/__tests__/terminal-command-policy.test.ts).

## Open findings (each repair edit must cite at least one)
- RF-1-4391b95f: tmux-test mutation/executable/git guards fail open when `splitReadOnlyShellSegments` returns undefined (`segments?.some(...) ?? false`). `touch workspace.txt;`, `tee workspace.txt;`, `rm -rf src &` never hit `hasUnsafeTmuxFileMutation`/`hasUnsafeTmuxExecutable`. Read-only correctly denies on `!segments`; tmux must fail closed the same way.
- RF-2-327c10c4: add tmux-test cases for trailing `;`, `;;`, leading `;`, and background `&` around mutators (touch/tee/rm) asserting `allowed===false`.
- RF-3-fa741f2a: git-commit allow regex only accepts `-m`; `hasPlaceholderCommitMessage`/`stripCommitMessageArgs` handle `--message`/`--message=`. Real `git commit --message "Fix"` gets a generic deny. Align allow with `--message` or encode the intentional deny in a test.
- RF-4-7b925458: test coverage missing for changed behavior.
- RF-5-e9fa653a: requirement: restricted profiles fail closed on unsafe/unparseable shell composition.
- RF-6-7a8c09df: requirement: behavior-changing policy paths have meaningful test coverage.

## Requirements
- R1 (RF-1, RF-5): Every tmux-test unsafe-detector built on `splitReadOnlyShellSegments` must treat an `undefined` parse as unsafe (fail closed), matching the existing read-only `!segments → deny` posture.
- R2 (RF-2, RF-4, RF-6): New adversarial test cases in `terminal-command-policy.test.ts` for unparseable/malformed composition around mutators under tmux-test, plus allow/deny coverage for any git-commit message-flag change.
- R3 (RF-3): `git commit --message "Fix"` and `--message=…` are either accepted by the allow clause or explicitly tested as intentionally denied. Preferred: extend the allow regex to accept `-m`/`--message` (both spaced and `=` forms), since other helpers already parse them.
- R4: Do not weaken other guards (git-commit substitution denial incl. double-quoted `$(`/backticks, path containment, workspace deny patterns, validation-diagnosis heredoc handling).

## Non-goals
- No refactor of the policy module structure; minimal diff.
- No changes to `run-terminal-command.ts`, git-discipline guidance, docs, or `.agents/sessions/*` history files.
- No re-introduction of the blanket raw-newline ban (already intentionally removed).

## Acceptance criteria
- A1: `bun test sdk/src/__tests__/terminal-command-policy.test.ts` passes including the new tmux-test fail-closed cases and git-commit `--message` cases.
- A2: File-change hooks (`bun run typecheck`, `cd sdk && bun run typecheck`) pass.
- A3: A fresh snapshot-bound code-reviewer clears RF-1..RF-6 with no new blockers.

## Relevant code anchors (verify fresh before editing)
- `splitReadOnlyShellSegments` (~line 458): returns `undefined` for substitution/backtick, background `&`, or any empty segment (trailing/leading `;`, `;;`).
- tmux-test block in `evaluateTerminalCommandPolicy` (~line 1103): `workspaceWriteSyntax` array of detectors; dependent detectors use `segments?.some(...) ?? false`.
- `hasUnsafeTmuxExecutable` (~line 427) and its siblings (`hasUnsafeTmuxFileMutation`, `hasUnsafeTmuxSedInPlace`, `hasUnsafeTmuxGitCommand`, `hasUnsafeTmuxWriteRedirection`, `hasActiveTmuxCompoundShellSyntax`) — the fail-open `?? false` sites.
- git-commit allow clause (~line 1210): `^git\s+commit\s+(?=.*-m(?:\s|$)).+` guards the commit allow.
