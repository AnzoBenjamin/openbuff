# Product audit 2026-11-12: coverage status

The synthesis is complete, and all 11 shards delivered. The outputs are `REPORT.md`, `ROADMAP-COMPARISON.md` and this file. Coverage below comes from each shard's `## Scope` section. A directory counts as "audited" when at least one shard inspected files in it at line level. "Partial" means it was inspected at feature level or by listing only.

## Coverage matrix: area → shard

| Area (BRIEF.md) | Shard file | Covered | Notes |
|---|---|---|---|
| Read, search, navigation tools | `findings/read-search.md` | yes | Schemas, runtime handlers, SDK tools, CLI renderers, indexer entry points. 135 tests run. LSP navigation handed to language-intel, `recall_context` to memory-context. |
| Mutation tools, diff UX, undo, post-edit feedback | `findings/write-edit.md` | yes | Static only, no test suites run. `processStrReplace` body covered by grep. |
| Command execution, jobs, approvals, sandbox | `findings/exec-jobs.md` | yes | Rust exec at feature level only. Two inferred findings marked. |
| Orchestration, subagents, plan mode, custom agents | `findings/orchestration.md` | yes | 140 tests run. Token counts measured. The base2 gate body (lines 840–15398) was skipped as covered by prior 03-orchestration. |
| CLI UX | `findings/cli-ux.md` | yes | Startup measured with a binary built 2026-11-10. Tool renderers, pricing tables and serve internals skipped. |
| Providers, routing, retry/failover, cost, SDK surface | `findings/providers-sdk.md` | yes | Four fake-provider wire probes. No real provider calls. OAuth refresh not re-probed. |
| Context compaction, memory, instruction files, sessions | `findings/memory-context.md` | yes | About 900 of 3,349 pruner lines read. `memory-command.ts` traced through a sub-agent only. |
| MCP, skills, hooks, custom tools, trust, ACP/serve | `findings/extensions.md` | yes | One `safeParse` probe. ACP persistence and approval bridge left to B17. Rust plugin host and Notion agents skipped. |
| LSP, code-map, indexer features, audit/review tools | `findings/language-intel.md` | yes | 90 LSP tests (clangd only) and 170/172 code-map tests run. Index build and inspect probes. No TS/Rust/Python/Go server available. |
| Web, media, browser, evals and quality infrastructure | `findings/web-media-evals.md` | yes | Live SSRF probe. Full CDP implementation and 3D SDK skipped (B33/B35). No LLM or eval run. |
| Roadmap process and priorities | `findings/roadmap-process.md` | yes | Ledger, STATE.md, evidence sizes, git history. Individual evidence receipts sampled by name and size only. |
| Competitors | `competitors/A.md`, `competitors/B.md` | yes | Claude Code, Codex CLI, Gemini CLI, Kiro CLI, OpenCode, Aider, Pi, Pi-Bolt. |
| Synthesis | `REPORT.md`, `ROADMAP-COMPARISON.md`, `STATUS.md` | yes | Built from shard files, the PLAN card table and ledger statuses only. No product source read. |

## Subsystem enumeration: top-level directories

| Directory | Status | Shards | Basis or reason |
|---|---|---|---|
| `agents/` | audited | orchestration, write-edit, exec-jobs, web-media-evals, read-search, language-intel | base2 and tool tiers, editor, basher, browser-use, researchers, context-pruner, agent-definition types, reachability and context-budget tests. |
| `agents-graveyard/` | out of scope | none | No shard inspected it. The name suggests retired agents that are not shipped. This was not verified, so it is the one top-level code directory with no audit evidence. |
| `cli/` | audited | cli-ux, write-edit, exec-jobs, orchestration, memory-context, extensions, providers-sdk, read-search, language-intel, web-media-evals | Commands, router, components, hooks, state, utils, init, release wrapper and build script. |
| `common/` | audited | all feature shards | Tool schemas (`common/src/tools/params/tool/`), MCP client, content-hash, messages, env, browser policy, project file tree, templates. |
| `docs/` | audited (for drift and contracts) | all shards; roadmap-process for `docs/execution/` | `agents-and-tools.md`, `configuration.md`, `local-mode.md`, `deterministic-edit-system.md`, `getting-started.md`, `architecture.md`, `testing.md`, `design/cli-overhaul/`. Evidence receipts under `docs/execution/body-roadmap/evidence/` were measured by size only. |
| `evals/` | audited | web-media-evals; write-edit and language-intel for metrics and trajectories | BuffBench mains, runners, scripts, `package.json`, deterministic compaction and memory evals. No eval executed. |
| `packages/` | audited | read-search, write-edit, orchestration, memory-context, language-intel, extensions, web-media-evals, cli-ux | `agent-runtime` (handlers, run loop, compaction, memory, MCP), `indexer`, `code-map` (tests run). `internal` only for `env.ts` and the env schema. `build-tools` only noted as having no tests (web-media-evals-14). |
| `rust/` | partial | exec-jobs | `openbuff-native` exec, sandbox and runner at feature level. Seccomp/Landlock internals, `openbuff-workspace-harness` and the plugin host were skipped as out of the brief's scope or covered by B21 and prior audit 10. |
| `scripts/` | partial | extensions, web-media-evals | `scripts/tmux/` (CLI wrappers), `scripts/benchmark-providers.ts` (OTel mention), `scripts/compare-buffbench-runs.ts`. The rest is developer tooling outside product scope. |
| `sdk/` | audited | read-search, write-edit, exec-jobs, providers-sdk, extensions, language-intel, memory-context, orchestration, web-media-evals | Tools, services (broker, memory V2, LSP, ACP, native exec), `run.ts`, `client.ts`, `index.ts`, provider config, README and examples. |
| `test/` | partial | web-media-evals | `test/fixtures/body/` listed only. Fixtures, not product code. |
| `web/` | out of scope | web-media-evals-16 (hygiene) | Empty except a `.env.local` symlink. No product code. |
| `e2e-traces/` | out of scope | web-media-evals-16 (hygiene) | Empty directory (`agents/e2e-traces/` also empty). |
| `debug/` | out of scope | web-media-evals-16 (hygiene) | Ignored by `.gitignore:23`. Local debug output. |
| `scratch-logs/` | out of scope | web-media-evals-16 (hygiene) | Contains only `*.log`, effectively ignored. The directory itself has no ignore rule. |
| `.agents/` | partial | extensions, roadmap-process | `lib/create-cli-agent.ts`, `cli-agent-schemas.ts`, the `claude-code-cli`/`codex-cli`/`gemini-cli` wrappers, `mcp.json`/skills loading paths, and the loader import behaviour (extensions-13). `sessions/` holds audit artifacts and is out of scope as product, except the prior review used as input. |
| `.github/` | audited | web-media-evals, cli-ux, language-intel | `ci.yml` (test matrix, Ubuntu-only), `evals.yml`, `nightly-evals.yml`, `buffbench.yml`, `nightly-e2e.yml`, `cli-release-build.yml` (tar lists, Windows build). |

Other paths the shards touched (not in the requested list):
- `.omx/` (143 MB, roadmap-process context and state).
- `.tmp/` (untracked and not ignored, web-media-evals-16).
- Root `*.log` files, `openbuff.json.example`, `openbuff.d.example/` (providers-sdk-13, extensions-12), `README.md`, `WINDOWS.md`, `AGENTS.md`, `ROUTER.md`.

## Open items and limits

- `agents-graveyard/` has no audit evidence. If it is loaded by any build or loader path, it needs a shard.
- macOS and Windows runtime behaviour, live model turns, real provider calls and ACP internals were not exercised (see REPORT.md "Limits").
- The workspace was read-only. No file outside `.agents/sessions/product-audit-2026-11-12/` was modified by this synthesis.
