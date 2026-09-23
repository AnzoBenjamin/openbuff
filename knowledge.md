# Project knowledge

This file gives Openbuff context about your project: goals, commands, conventions, and gotchas.

## Quickstart

- Setup: `bun install` (Bun workspace monorepo; Bun is pinned to 1.3.11 via `packageManager` in `package.json`)
- Dev: `bun run dev` boots the CLI TUI from local sources. Optional local services: `bun up` / `bun ps` / `bun down`
- Test: `bun run test` from the repo root (multi-workspace suite). Fast per-package loop: `cd <pkg> && bun test`. Do NOT use `bun --cwd <pkg> run <script>` — it silently prints the script list and exits 0 without running anything (see docs/testing.md)

## Architecture

- Key directories: `cli/` (TUI client, OpenTUI + React), `sdk/` (published as `@openbuff/sdk`), `packages/agent-runtime/` (agent loop), `packages/indexer/` (`query_index` backend), `packages/code-map/` (tree-sitter parsing), `packages/internal/` (provider wrappers), `common/` (shared types/tools/utilities), `agents/` (shipped agents), `.agents/` (project-local templates), `evals/` (BuffBench), `scripts/` (repo scripts)
- Data flow: CLI/TUI → `sdk/src/run.ts` → agent-runtime loop (`packages/agent-runtime/src/run-agent-step.ts`) → user-configured provider. Local/BYOK only: no server-side inference, tool calls execute on the user's machine. Full trace in docs/request-flow.md

## Conventions

- Formatting/linting: `bun run format` (Prettier). Typecheck with `bun run typecheck`; run the pre-push gates with `bun run check:ci-local`
- Patterns to follow: dependency injection over module mocking (contracts in `common/src/types/contracts/`); retrieval-led context gathering (`query_index` first, then verify with reads); `ErrorOr` error handling (`common/src/util/error.ts`)
- Things to avoid: don't force-push `main`; run interactive git commands in tmux; don't use `npm`/`yarn` (Bun only); don't document `OPENBUFF_*` env aliases that aren't implemented in code

See AGENTS.md and docs/development.md for the full guides.
