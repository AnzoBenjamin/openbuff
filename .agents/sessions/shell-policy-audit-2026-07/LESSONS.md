# LESSONS — Shell/Terminal Security Restriction Audit

## Key insight

The git-committer's unreliability is not a bug in git-committer — it's a
contradiction: `gitCommitGuidePrompt` tells the model to use
`git commit -m "$(cat <<'EOF' ... EOF)"`, but the `git-commit` terminal profile's
`hasActiveShellSyntaxAnywhere` rejects `$(`, backticks, `<`, `>` anywhere (and
raw newlines). Guidance and enforcement must be co-designed or they fight.

## Enforcement layering

Three independent layers touch a git command:

1. `evaluateTerminalCommandPolicy` (profile allowlist),
2. `classifyTerminalHarnessAction` + `evaluateHarnessActionPolicy` (approval),
3. `validateStagedCommit` (staged-diff safety re-scan).
   Redundant for an already-locked profile; a single authoritative owner per
   concern would reduce friction.

## Distinguish friction from security value

- Real value (keep): traversal/outside-path containment, force/delete-push
  block, privilege escalation, env dump, sensitive-file staged scan, tmux
  write-through-shell block.
- Mostly friction (relax): quote-blind raw-syntax ban on git-commit, git
  read-only composition limited to git-only segments, /git slash-command
  bracket/brace ban.

## Gotcha

The raw-syntax guard is intentionally NOT quote-aware because `bash -c` expands
substitution/redirection even inside quotes. Any relaxation (Approach A) must
use a bounded, quoted-delimiter heredoc parse (like the existing
`stripBoundedDiagnosticHeredoc`) so body text stays inert — do not just make the
guard quote-aware.
