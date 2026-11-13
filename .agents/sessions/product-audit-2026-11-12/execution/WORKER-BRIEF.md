# Worker brief: PROD addendum wave 1

You are implementing one or more tasks from `docs/execution/body-roadmap/product-audit-addendum.md`. Read your task sections there (Findings, Scope, Accept, Verify), the cited findings in `.agents/sessions/product-audit-2026-11-12/findings/`, and the probes in `.agents/sessions/product-audit-2026-11-12/verification/` (reports plus `probes/`). Read `AGENTS.md`, `docs/testing.md` (DI over mocking) and the relevant package `knowledge.md` before editing.

## Shared working tree: rules
- Several workers edit this same tree at the same time, and the tree already holds large uncommitted roadmap work (B19–B21). Never revert, reformat or "clean up" changes you did not make.
- Edit only the files your task needs. If you must touch a file that another task obviously owns (listed below), make the smallest targeted edit and record it in your receipt.
- Do not run any git command that changes state: no stash, checkout, restore, reset, commit, add or clean. Read-only git (diff, log, status, show) is fine.
- Do not run repo-wide formatters or lint `--fix`. Format only the files you changed, if at all.
- Run targeted tests (`bun test <files>`) and the typecheck of the packages you touched. Do not run the full CI suite. If a test that is unrelated to your change fails, note it and move on.
- Never write secrets. Use fake keys in tests.

## File ownership in this wave
- providers (N01, N07): `sdk/src/impl/llm.ts`, `sdk/src/impl/failover.ts`, `sdk/src/retry-config.ts`, `sdk/src/error-utils.ts`, OpenRouter/Anthropic preset compatibility blocks and local-endpoint checks in `sdk/src/provider-config.ts`.
- trust (N02): config loading and trust logic in `sdk/src/host-config.ts`, `sdk/src/provider-config.ts` (loader/merge only), `sdk/src/host-execution.ts` (approvalMode resolution), skill loading in `sdk/src/run-state.ts`, CLI trust screen and flags.
- plan (N03): `packages/agent-runtime/src/tools/handlers/tool/run-terminal-command.ts`, tool dispatch/plan-lineage checks in `packages/agent-runtime/src/`, `agents/base2/`, `agents/tool-reachability.test.ts`, `cli/src/utils/local-agent-registry.ts` (plan spawnable filtering).
- web (N05 plus N04 web parts): `packages/agent-runtime/src/tools/handlers/tool/web-search*.ts`, `read-docs.ts`, MCP address policy in `sdk/src/mcp/`.
- exec (N06): `sdk/src/tools/run-terminal-command.ts`, `sdk/src/services/execution-launch.ts`, job lifetime on exit, `common/src/tools/params/tool/run-terminal-command.ts` (timeout default text), `agents/basher.ts` default timeout.

## Receipt
When done, write `.agents/sessions/product-audit-2026-11-12/execution/<task-id>.md` with:
- **Status:** implemented / partial / blocked.
- **Changed files**, one line each saying what changed.
- **Acceptance:** each Accept clause from the addendum with met / not met and the test that shows it.
- **Commands run** and their results (pass/fail counts).
- **Not done**, plus follow-ups, and any edits made in files owned by another task.

Return only a short summary (5–8 lines) to the caller.
