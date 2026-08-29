# PLAN — Over-strict Agent Guardrail Remediation (codebase-wide)

<!-- current-task: none -->

Tiered so you can approve only what you want. Every change touches a security
control, so each tier gets an advisory `security-reviewer` pass before edit plus
the full validation/reviewer gate after. Classifications: [B]=soften, [C]=keep.

Ranked by (friction relieved / risk added). Highest-value, lowest-risk first.

## Tier 1 — High-value, low-risk relaxations (recommended)

- [x] T1.1 Fix empty-readablePaths read lockout in spawn handoffs (HIGH) (empty readablePaths preserves unrestricted scope)
  - Surface: packages/agent-runtime/src/tools/handlers/tool/spawn-agent-utils.ts
  - Problem: a handoff with `readablePaths: []` rewrites a child from unrestricted
    reads to `read: []`, hard-blocking ALL project reads.
  - Fix: only narrow read scope when readablePaths is non-empty; otherwise preserve
    the child's static (possibly undefined = unrestricted) scope. Same for write
    when writablePaths is empty. Preserves child-cannot-exceed-parent.
  - Acceptance: empty readablePaths leaves filesystemScope.read undefined/unrestricted when child had no static read scope; non-empty still narrows
  - Validate: bun test packages/agent-runtime/src/**tests**/spawn-agents-permissions.test.ts

- [x] T1.2 Stop zeroing spawnableAgents / stripping programmaticToolNames on handoff (MEDIUM) (preserves static spawnableAgents + programmaticToolNames)
  - Surface: packages/agent-runtime/src/tools/handlers/tool/spawn-agent-utils.ts
  - Problem: any handoff-carrying child gets spawnableAgents forced to [] and hidden
    programmaticToolNames intersected with model-authored allowedTools.
  - Fix: preserve child static spawnableAgents; do not gate programmaticToolNames
    on model-visible allowedTools.
  - Acceptance: handoff child retains static spawnableAgents and programmaticToolNames
  - Validate: bun test packages/agent-runtime/src/**tests**/spawn-agents-permissions.test.ts

- [x] T1.3 Fix git-committer commit contradiction (folds in shell-policy-audit F1) (guide uses multiple -m; HEREDOC forbidden)
  - Surface: sdk/src/tools/terminal-command-policy.ts; common/src/constants/git-discipline.ts
  - Problem: git-commit profile rejects `$(`/heredoc, but gitCommitGuidePrompt instructs it.
  - Fix: structured commit-message path OR minimal bounded-heredoc allowance; reconcile guide.
  - Acceptance: multi-line commit possible under git-commit profile; guidance matches policy
  - Validate: bun test sdk/src/**tests**/terminal-command-policy.test.ts

- [x] T1.4 Expand combined short ripgrep flags + benign output flags (MEDIUM) (26/26 find-files-matching-content pass)
  - Surface: sdk/src/tools/find-files-matching-content.ts
  - Fix: expand /^-[a-zA-Z]{2,}$/ bundles before validation; add -v/--invert-match,
    -c/--count/--count-matches (and -o for code_search via extra switches). Keep
    dangerous-flag denials.
  - Acceptance: -ni accepted; --exec still rejected
  - Validate: bun test sdk/src/**tests**/find-files-matching-content.test.ts

- [x] T1.5 Narrow FORBIDDEN_SHELL_CHARACTERS for /git slash commands (MEDIUM) (8/8 git-command-args pass)
  - Surface: cli/src/commands/git-command-args.ts
  - Fix: keep hard-blocking newlines and shell operators `$;` + backtick + `|&<>\\`;
    allow `( ) [ ] { }` (args are single-quoted).
  - Acceptance: `:(exclude)dist` and `{a,b}.ts` parse; injection cases still throw
  - Validate: bun test cli/src/commands/**tests**/git-command-args.test.ts

## Tier 2 — Sensitive-path precision fixes (read surface)

- [x] T2.1 Tighten substring sensitive-path matches (MEDIUM) (precise kubeconfig/tfstate; drop .crt/.cer/.yarnrc)
  - Surface: common/src/util/sensitive-paths.ts
  - Fix: remove .crt/.cer; anchor kubeconfig and .tfstate; drop .yarnrc blanket ban.
  - Acceptance: public certs and kubeconfig docs readable; real secrets still blocked
  - Validate: bun test common/src/util/**tests**/sensitive-paths.test.ts

- [x] T2.2 Allow in-project absolute read paths (MEDIUM) (POSIX absolute form allowed; containment still authority)
  - Depends on: T2.1
  - Surface: sdk/src/tools/path-utils.ts
  - Fix: let resolveProjectPath containment be authority for absolute in-project paths.
  - Acceptance: absolute path inside project root reads; outside still denied
  - Validate: bun test sdk/src/**tests**/path-utils.test.ts

## Tier 3 — Throughput caps and edit-authorization friction

- [x] T3.1 Raise read/scan throughput caps (LOW) (caps raised; truncation flags kept)
  - Surface: read-files, read-subtree, web-search, code-search defaults
  - Acceptance: higher defaults with truncation flags still present
  - Validate: relevant per-package unit tests

- [x] T3.2 Soften str_replace edit-authorization friction (MEDIUM) (non-draining success; limit 5; small-file stale strip) (limit 5 non-draining; small-file stale strip)
  - Surface: edit-read-state.ts, process-str-replace.ts, str-replace.ts
  - Acceptance: non-staleness failures do not force full re-read; circuit breaker drains on success
  - Validate: bun test packages/agent-runtime/src/tools/handlers/tool/**tests**/str-replace-circuit-breaker.test.ts

## Keep — real security value (do NOT weaken)

SSRF host/IP/redirect revalidation; .env & private-key/credential/real-.tfstate
denials; project-path containment; cap.v3 HMAC signing + scope binding;
replace_range authority chain; plan-only terminal attenuation; force/delete/
default-branch push gating; privilege-escalation/system-package/env-dump bans.

## Validation gates

- Per-task bun test on named suites.
- security-reviewer advisory before editing terminal-command-policy.ts,
  sensitive-paths.ts, path-utils.ts, spawn-agent-utils.ts.
- Full runtime validation + reviewer gate before finalizing each tier.
