# PLAN — Shell/Terminal Security Restriction Remediation

Tiered so you can approve only what you want. Tier 1 fixes the git-committer
pain directly; higher tiers are optional cleanups. Every change is
security-sensitive → advisory `security-reviewer` before edit + full
validation/reviewer gate after.

## Tier 1 — Fix git-committer reliability (recommended)

- [ ] T1.1 Allow multi-line commit messages under the git-commit profile
  - Depends on: none
  - Approach A (minimal): extend the existing bounded-heredoc allowance (already
    used by `validation-diagnosis` via `stripBoundedDiagnosticHeredoc`) to accept
    the `git commit -m "$(cat <<'EOF' ... EOF)"` shape for git-commit, treating
    the quoted-delimiter body as inert data. Keep the raw-syntax guard for every
    other git-commit command.
  - Approach B (cleaner, larger): give git-committer a structured commit path so
    the message travels as a tool parameter and never through the shell (no `$(`,
    no heredoc). Removes the contradiction entirely.
  - Acceptance: git-committer produces a 2+ line commit message end-to-end.
  - Validate: `bun test sdk/src/__tests__/terminal-command-policy.test.ts` +
    `agents/__tests__/git-committer.test.ts`.

- [ ] T1.2 Reconcile `gitCommitGuidePrompt` with the policy
  - Depends on: T1.1
  - If Approach A: keep the heredoc guidance (now permitted). If Approach B:
    rewrite the guide to describe the structured path and drop the shell HEREDOC.
  - Acceptance: guidance no longer instructs a form the active profile blocks.
  - Validate: `agents/__tests__/quality-prompt-snapshot.test.ts`.

- [ ] T1.3 Widen read-only git composition to allow safe pagers/filters
  - Depends on: none
  - In `isReadOnlyGitCommand` composition path, permit non-git segments drawn
    from a tight allowlist (`head`, `tail`, `cat`, `wc`, `nl`, `grep`, `rg`,
    `sort`, `uniq`) so `git log | head` works; keep the no-substitution / no-
    redirection guards.
  - Acceptance: `git log --oneline | head -20` allowed; `git log | sh` still denied.
  - Validate: `bun test sdk/src/__tests__/terminal-command-policy.test.ts`.

## Tier 2 — Reduce redundant enforcement layers (optional)

- [ ] T2.1 De-duplicate git-action gating for the git-commit profile
  - Depends on: T1.\*
  - Decide the git-commit profile is authoritative; avoid double-gating `commit`
    through the harness approval layer for that profile (push/force still gated).
    Document which layer owns which concern in `docs/agents-and-tools.md`.
  - Acceptance: a normal git-committer commit is evaluated by one authoritative
    layer; no behavior change for push/force/default-branch.
  - Validate: `bun test sdk/src/__tests__/harness-enforcement.test.ts` +
    `sdk/src/__tests__/run-terminal-command.test.ts`.

- [ ] T2.2 Soften the git add allowlist failure mode (F3)
  - Depends on: T2.1
  - Keep the exact-subset rule but improve the denial reason and consider
    accepting `./`-prefixed / normalized-equivalent paths without failing.
  - Acceptance: equivalent path spellings no longer spuriously rejected.

## Tier 3 — CLI convenience (optional, low risk)

- [ ] T3.1 Narrow FORBIDDEN_SHELL_CHARACTERS for /git slash commands (F5)
  - Depends on: none
  - Stop blocking `[ ] { } ( )` (still block `; $ \` | & < > \\` and newlines) so
    git pathspec/brace syntax works; args are already shell-quoted individually.
  - Acceptance: `/git diff 'app/{a,b}'` parses; injection cases still throw.
  - Validate: `bun test cli/src/commands/__tests__/git-command-args.test.ts`.

## Risks / blockers

- These are security controls. Any relaxation must be reviewed by
  `security-reviewer` and must not weaken the (C) keep-list in SPEC.
- Approach B (T1.1) is a larger surface (new structured executor path); Approach
  A is the minimal fix.
- Open question: which tiers to execute, and A vs B for T1.1.

## Validation gates

- Per-task `bun test` on the named suites.
- Full runtime validation + reviewer gate before finalizing any tier.
- security-reviewer advisory pass on `terminal-command-policy.ts` changes.
