# Product audit brief (2026-11-12)

Goal of Openbuff: the best agentic coding CLI. Every feature must be cohesive with the rest
of the CLI, offer the best usability (broadest useful feature set) and be reliable.

This audit is READ-ONLY. Do not modify any file in the repository except your own output
file under `.agents/sessions/product-audit-2026-11-12/`. Do not run commands that write
to the repo (no formatters, no installs, no git commits, no builds that write into the tree).
Read-only commands (git log, rg, ls, wc, running existing tests that write nothing to the repo) are OK.

## Prior work you must not duplicate
- `.agents/sessions/body-capability-review-2026-11-05/` — capability catalog (CAPABILITIES.md),
  118 reliability findings (AUDIT-REPORT.md, findings/), replacement plan (PLAN.md, cards B01–B36).
  It focused on truthfulness/reliability. If you find the same issue, cite its finding/card ID
  and say whether it is still present at HEAD rather than re-describing it.
- `docs/execution/body-roadmap/` — live execution of that plan (STATE.md, ledger.json).

## What each feature shard evaluates
Follow each feature vertically: entrypoint (tool schema in `common/src/tools/params/tool/`,
CLI command, SDK API) -> implementation (`packages/agent-runtime/src/tools/handlers/tool/`,
`sdk/src/`, `cli/src/`) -> consumers (agents in `agents/`, CLI rendering in
`cli/src/components/tools/` etc.) -> tests -> docs -> failure states (error, empty, loading,
cancellation, retry, permission, huge input, binary input, timeouts).

Score every feature on three axes:
1. **Usability** — model-facing (schema clarity, parameter names, defaults, output shape and size,
   errors the model can act on, token cost of definition and results) and user-facing
   (TUI rendering, discoverability, controls, sensible defaults).
2. **Feature completeness vs reference CLIs** — Claude Code, OpenAI Codex CLI, Gemini CLI,
   OpenCode, Aider, Kiro CLI, Pi (earendil-works/pi, formerly badlogic/pi-mono) and Pi-Bolt
   (opensec-git/Pi-Bolt, AOT-compiled Pi). Use your knowledge, and the competitor file
   `COMPETITORS.md` in this directory if it exists. Say what they have that we lack, and what we
   have that they lack. Note where minimalism (Pi's 4-tool approach) beats breadth.
3. **Reliability** — failure modes, races, swallowed errors, missing tests on the failure path.
   The 8 audit domains (security, correctness, state mutation, error handling, performance,
   dependency hygiene, test gaps, API/contract breaks) apply.

Also look for **cohesion** problems: overlapping tools that confuse the model (e.g. several
search/read/edit variants), inconsistent naming/param conventions, features that exist but are
unwired or undiscoverable.

## Output contract
Write exactly one Markdown file: `.agents/sessions/product-audit-2026-11-12/findings/<shard-id>.md`
with these sections:
- `## Scope` — files/dirs inspected (list), and anything skipped with reason.
- `## Feature inventory` — table: feature | entrypoint | implementation | tests | maturity (useful/partial/unwired/absent).
- `## Findings` — each finding: ID (`<shard-id>-NN`), title, axis (usability/completeness/reliability/cohesion),
  severity (CRITICAL/HIGH/MEDIUM/LOW; downgrade when unsure), evidence (`path:line`), user/model impact,
  suggested fix, and prior-review cross-reference (B-card or finding ID, or "new").
- `## Competitive gaps` — table: capability | best-in-class CLI and how it does it | Openbuff state | priority.
- `## Strengths` — things Openbuff does better than the reference CLIs (with evidence).
- `## Roadmap mapping` — for each finding: covered by card X / partially / not covered.

Be concrete: every claim needs a file:line or a named external source. Return to the caller only a
5–10 line summary (top 3 findings + file path). Do not paste findings into your reply.
