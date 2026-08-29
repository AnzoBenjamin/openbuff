# Context Baseline 25–30k — LESSONS

Session: context-baseline-25k
Running notes on gotchas, decisions, and reusable patterns. Append-only.

## general-agent dual-site mirror trap — 2026-08-04

`agents/general-agent/general-agent.ts` has its own inline `shouldProactivelyQueryIndex` (length check + generic code-intent regex only). Mirroring base2's post-M4 strong-intent gate onto it is NOT behavior-neutral: `agents/__tests__/general-agent.test.ts` audit-loop tests drive prompt `'Audit service completeness'`, and once the classifier recognizes audit verbs the first yield flips from `spawn_agent_inline` (context-pruner) to `query_index`, breaking 3 tests (rejects audit completion without a structural receipt; breaks the audit loop once a matching structural receipt is present; breaks the audit loop after exhausting completion retries). Any M4-T2-style mirror must bundle those test updates (accept a query_index first yield) and ship as its own gate-scoped change — never fold it into an advisory-repair turn. The out-of-scope mirror was reverted via `git restore agents/general-agent/general-agent.ts`; suite back to 7/7.

## Editor scope discipline — 2026-08-04

When delegating "advisory repair" fixes to an editor, name the finding IDs AND explicitly forbid expanding scope items (dual-site mirrors, adjacent cleanups). The NF-1/NF-2 repair silently included a descoped dual-site change because the prompt mentioned M4-T2 in discovery context rather than as a non-goal.

## Gate timing notes — 2026-08-04

- `bun run typecheck` at repo root takes >30s (11 packages); run per-package or accept the timeout and let `run_file_change_hooks` do it.
- `git restore <file>` is safe for out-of-scope editor drift in this repo's hook configuration (typecheck-only hooks pass regardless; the gate scope follows dirty files).
