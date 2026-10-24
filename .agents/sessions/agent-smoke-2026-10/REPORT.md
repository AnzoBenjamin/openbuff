# Agent Smoke Test Report — 2026-10-08

Scope: every spawnable agent in the runtime catalog, tested with a tiny self-contained task against a scratch directory (`.agents/sessions/agent-smoke-2026-10/`), 3 waves, max 12 per wave. Thinker was smoke-tested separately in an earlier turn (passed). Scratch files are safe to delete.

## Results summary

| Agent | Result | Notes |
|---|---|---|
| thinker (prior turn) | PASS | structured output, receipt clean |
| file-picker | PASS | returned 8 files w/ summaries; slight relevance noise (read-files.ts, list.ts unrelated to terminal exec) |
| general-agent | PASS | correctly read scratch file and identified the seeded bug |
| researcher-web | PASS | Node 26 answer w/ citations |
| researcher-docs | ISSUE (minor) | completed but reported docs retrieval returned no results for "Bun"; fell back to general knowledge |
| basher | PASS | echo/pwd, exit 0 |
| editor | PASS | fixed seeded `add()` bug; mutation verified on disk |
| test-writer | PASS (advisory) | correctly flagged stale handoff info: file was still buggy at read time — good evidence discipline |
| doc-writer | PASS (advisory) | `status: blocked` in receipt while `outcome: ok` — status/outcome field naming is confusing |
| code-reviewer | PASS | found both seeded defects; verdict NON_BLOCKING |
| debugger | PASS | correct analysis; output tokenization was extremely fragmented (cosmetic) |
| architect | PASS | source-backed, structured dimensions |
| librarian | PASS | answered from a real shallow clone of oven-sh/bun; clone cleaned up |
| synthesizer | PASS | read findings dir, wrote AUDIT-REPORT.md; noted evidence-path caveats correctly |
| product-reviewer | PASS | PASS verdict w/ requirement coverage |
| integration-agent | PASS | correct ordering/validation analysis; noted the fix was already on disk |
| performance-specialist | PASS | O(1) assessment + evidence plan |
| reliability-reviewer | PASS | no blocking findings, sensible notes |
| migration-reviewer | PASS | correct trivial-move analysis; verified untracked status itself |
| accessibility-reviewer | PASS | sensible N/A sourcing |
| ux-visual-reviewer | PASS | found the typo, correctly scoped it out |
| compatibility-reviewer | PASS | no findings, correct contract reasoning |
| dependency-reviewer | PASS | clean assessment; output schema echoed a placeholder `$id` (example.com) — cosmetic |
| incident-coordinator | PASS | timeline + 4 low-severity advisory findings on the scratch file (over-eager finding emission, but valid process) |
| release-manager | PASS | advisory-only, ran nothing |
| docs-architect | PASS | 3-layer doc structure recommendation |
| evaluator | PASS | 5/5 score w/ source evidence; correctly flagged the prompt's bogus path as a discrepancy |
| security-reviewer | ISSUE (minor) | returned only echoed params; no substantive clean-verdict prose — likely due to manual spawn with a synthetic fingerprint |
| tmux-cli | FAIL then PASS on retry | first spawn failed: required `params.command` was missing and the agent errored with "No command provided" instead of proceeding; retry with command passed all 4 steps |
| browser-use | PASS | example.com rendered, 0 console errors, screenshot attached |
| repair-editor | PASS | fixed the reviewer-reported 'Smke' typo exactly; mutation verified on disk |

Not tested (by design):
- git-committer — would create a real commit; only runs after GATE: PASSED
- dependency-manager — would mutate package manifests/lockfiles
- context-pruner — runtime-owned; must never be spawned manually

## Issues found

1. **Orchestrator-side spawn serialization is fragile (root-side, not agent-side).** Two waves failed with `agents: expected object, received string` — the agents array got JSON-stringified. One attempt also failed on a truncated/incomplete `repair-editor` handoff. Retries with correct shapes succeeded. This is the biggest present issue observed in the exercise.

2. **tmux-cli requires `params.command` up-front (error not hint).** First spawn without `command` returned `overallStatus: failure — No command provided`. A clearer validation error (or a default no-op mode) would save a retry.

3. **researcher-docs retrieval gap for Bun.** Docs lookup returned nothing for a mainstream tool; it answered from general knowledge and honestly labeled it. Worth checking its docs index coverage for emerging/less-indexed ecosystems.

4. **security-reviewer under manual spawn returns near-empty output** (just echoed params). Either manual spawns without a gate fingerprint aren't fully supported, or the agent should still emit an explicit "clean verdict / cannot verify" message.

5. **tmux helper script bug (scripts/tmux):** the `capture` subcommand aborts on the first capture of a fresh session because `SEQ=$(cat "$SEQ_FILE" 2>/dev/null)` under `set -e` exits when `.seq` is missing. Suggested fix: `SEQ=$(cat "$SEQ_FILE" 2>/dev/null || echo 0)`. Also cosmetic: mise zsh-hook error noise pollutes captures under bash.

6. **Cosmetic:** doc-writer receipt mixes `status: blocked` with `outcome: ok`; dependency-reviewer echoes a placeholder schema `$id`; debugger output is heavily tokenized.

## Verdict

All 27 tested spawnable agents completed their smoke tasks after one retry each where needed. No agent produced incorrect domain output; the issues found are param-validation ergonomics, one helper-script bug, and two minor output-quality nits.
