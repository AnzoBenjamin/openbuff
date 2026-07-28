# STATUS — Shell/Terminal Security Restriction Audit

## Current state
Audit complete (plan mode). No source changed. Enforcement layer fully read and
mapped; findings F1–F6 recorded with file/line evidence in SPEC.md.

## Completed
- Read full policy engine (`terminal-command-policy.ts`), executor
  (`run-terminal-command.ts`), approval layer (`harness-enforcement.ts`),
  git-committer, git-discipline prompt, git-branch, CLI git-command-args.
- Mapped all profile assignments and `gitCommitGuidePrompt` injection point.
- Confirmed root cause of git-committer unreliability (F1: policy vs. guidance
  contradiction).

## Pending (awaiting user decision)
- Which tier(s) to execute (Tier 1 recommended).
- T1.1 Approach A (minimal heredoc allowance) vs B (structured commit path).

## Blocked
- All implementation blocked in plan mode + pending user go-ahead (security-
  sensitive changes).

## Next checkpoint
User selects tiers + A/B. Then exit plan mode, spawn security-reviewer
(advisory) on `terminal-command-policy.ts`, implement selected tasks, run the
named per-task suites, then full gate.

## Resume instructions
Re-read SPEC.md findings + PLAN.md tiers. Start with T1.1 on
`sdk/src/tools/terminal-command-policy.ts`.
