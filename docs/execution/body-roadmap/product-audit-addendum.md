# Product audit addendum (PROD)

Requested by the user on 2026-11-12. This addendum turns the findings of the read-only product audit into planned work for the body roadmap. [execution-plan.json](execution-plan.json) registers it next to the RWEB addendum.

The frozen [PLAN.md](../../../.agents/sessions/body-capability-review-2026-11-05/PLAN.md) and [SPEC.md](../../../.agents/sessions/body-capability-review-2026-11-05/SPEC.md) keep their hashes. Every accepted receipt binds `planSha256`, so editing the base plan would invalidate all twelve accepted nodes. The 39-node completion graph, the ledger and the acceptance process are unchanged. This addendum adds:

- **Part A:** extra acceptance clauses for pending base cards. A card's receipt must bind this addendum and satisfy its clauses.
- **Part B:** new tasks `N01`–`N32`. They are tracked here, not as ledger completion nodes. Each one is accepted with the same receipt discipline as a base card.
- **Part C:** a dispatch order that interleaves the new tasks with the ready base cards.

## Basis

- Audit: `.agents/sessions/product-audit-2026-11-12/` (`REPORT.md`, `ROADMAP-COMPARISON.md`, `findings/*.md`, `competitors/A.md`, `competitors/B.md`). Finding IDs below (`read-search-01` and so on) refer to those files, which hold the `file:line` evidence.
- Verification runs on 2026-11-12 (`verification/trust.md`, `verification/runtime.md`). Probes ran against HEAD `f5aba489d` plus the working tree; the scripts are kept in `.agents/sessions/product-audit-2026-11-12/verification/probes/`. All 12 claims the audit had inferred were confirmed. Severity changes:
  - **extensions-03 HIGH → CRITICAL.** A project `openbuff.json` provider with `apiKeyEnv` and a foreign `baseURL` overrode the user's `defaultModel`. A capture server received the user's Anthropic key (`x-api-key`) and OpenAI key (`Bearer`). Project `fileChangeHooks` also ran untrusted.
  - **exec-jobs-04 MEDIUM → HIGH.** A project `openbuff.json` with `approvalMode: allow-all` took effect with no trust flag. `rm -rf`, `git push --force` and `curl` exfiltration ran without approval.
  - **exec-jobs-09 MEDIUM → HIGH.** Attached `BACKGROUND` jobs were re-parented to init after `process.exit(0)` and after SIGTERM. The SDK parent also ignores SIGINT while a job runs.
  - Confirmed at their existing severity: orchestration-01, exec-jobs-01, exec-jobs-02, extensions-05, cli-ux-02, read-search-03, language-intel-05, memory-context-01, providers-sdk-01.
  - New detail found while confirming them:
    - cli-ux-02: `--version` takes 1,024 ms from source and 842 ms from the Nov 10 binary.
    - extensions-05: the SDK puts project skills in `fileContext.skills` regardless of trust (`sdk/src/run-state.ts:861`).
    - orchestration-01: home `~/.agents` agents are always spawnable from plan mode.
    - providers-sdk side issue: the warning about outside-project configs names the user's global config, never the project file that took the route (`sdk/src/provider-config.ts:1399-1440`).
- Out of scope: the roadmap process (tiers, evidence volume, renewal rules). The user attributes its pace to the models used and keeps the process as it is.

## Part A — Amendments to pending base cards

Each clause is added to the card's **Accept** line. Accepted cards (B01–B05, B08, B18–B20, B28, B30, B36) are not reopened; their gaps become Part B tasks.

| Card | Added scope | Added acceptance | Findings |
|---|---|---|---|
| B09 | Built-in model price and context-window table, sourced from a models.dev snapshot and filled by discovery. Anthropic token semantics (cache read and write tokens counted separately). Sub-cent precision. `/usage` command. | A direct Anthropic, OpenAI and OpenRouter route each report non-zero cost per turn with no user pricing config. `/usage` shows input, output, cache-read and cache-write tokens, cost (or `unknown` with a reason) and context use. 02-F3 fixture (OpenAI-compatible route with pricing) produces a cost callback. Cost accumulates in fractional cents. | providers-sdk-03, providers-sdk-05, cli-ux-06 |
| B10 | Interrupt/queue race. | Interrupting a turn with a queued prompt never auto-sends the queued prompt without an explicit user action. | cli-ux-11 |
| B11 | One command definition source, fuzzy inline menu with usage hints, `/help` command directory, `/plans` and `/plan-use` listed, `/compact` registered (see N13), `openbuff init` parsed as a subcommand. | A test enumerates the router table and asserts every routed command appears in the menu, `/help` and docs. `/compact`, `/plans`, `/plan-use` resolve. `openbuff init` runs init. | cli-ux-07, cli-ux-13, memory-context-01 |
| B12 | Scope note: 04-F1 and caller-side 04-F2 are already fixed at HEAD. Remaining: decision text replaced by tool/path summaries, re-sort before the 12,000-char clip, V1 memory injected on degraded turns. | A recorded decision's own text reaches the next task's prompt. The highest-ranked item survives the clip. A degraded turn injects no V1 memory when V2 is enabled. | memory-context-02 |
| B13 | Remove the 100-message transcript cap before save. | A 500-message session saves and resumes with all messages. | cli-ux-05, memory-context-09 |
| B17 | ACP prompt blocks: `resource_link`, `resource` and `image`. Zed setup doc. (The block intake fix ships early as N12; B17 binds it.) | An ACP prompt with an `@file` resource link and an image reaches the model with the file content and image, and an unsupported block type returns a typed error instead of being dropped. | extensions-08 |
| B24 | Split the packaging fix out of the B23 dependency (ships early as N09). | The release tarball and npm wrapper contain every `tree-sitter-queries/*.scm`. The installed smoke test asserts non-empty symbols, calls and imports for TS, Python and Rust fixtures. | language-intel-05 |
| B25 | Session-scoped language servers (one per session, not per prompt), `$/progress` readiness, diagnostics capture after edits, conditional tool exposure when a server is detected, install hints, one position convention, bounded results. | Two consecutive prompts reuse one warm server. A cold query waits for readiness or returns `unavailable`. An edit that introduces a type error returns that diagnostic in the edit result. LSP tools are absent from the tool list when no server is installed, and a missing binary reports `not_installed` with an install command. All LSP inputs and outputs use 1-based lines and columns. References are capped with `partial` and a continuation. | language-intel-01, -02, -03, -04, -07, -09, -10 |
| B26 | Index metadata size ceiling and `.tmp` sweep. | Indexing a 10k-file fixture persists and reloads without re-indexing. Abandoned `.tmp` files are removed at startup. | language-intel-06 |
| B29 | Becomes the long-term home of the project trust gate delivered by N02. Adds hot reload of agents and skills, and a working `/publish` (or removes it). | Trust decisions are per project and persist across TUI, `run`, `serve` and SDK. `/reload` picks up new agents and skills. `/publish` either works end to end or is no longer mounted. | extensions-04, orchestration-06 |
| B32 | Targets, not just baselines: ready-to-type time, idle RSS, `--version` time, static prompt tokens. `packages/code-map` in the CI test matrix. | `PERFORMANCE.json` records each target and CI fails when one regresses past its target (targets set by N15 and N03). code-map tests run in CI. | cli-ux-02, web-media-evals-14 |
| B33 | Do the small truth fixes first: one browser read-only policy (13-F1) and an honest `render_ui` result (13-F9). Unify model and user image pipelines (see N20). | `render_ui` returns `not_rendered` when no interactive host is attached. The browser policy has one source and a test that fails if the two consumers disagree. | web-media-evals-07, -08, -09 |
| B34 | Interim delivery N17 (git worktrees) ships user value before B22 and B27 land. B34 binds N17 and keeps its existing acceptance. | See N17. | roadmap-process-06 |
| B14 | Unchanged scope; reconfirmed present at HEAD. | — | memory-context-03 |
| B23–B25 | Unchanged base scope; 07-F2–F9 reconfirmed present at HEAD. | — | language-intel-14 |
| B29 (base scope) | Unchanged; 10-F3, 10-F5 and 10-F10 reconfirmed present at HEAD. | — | extensions-09, extensions-13 |

## Part B — New tasks

Format follows the base cards: **Findings**, **Scope**, **Accept**, **Verify**, **Prereqs**. Prerequisites name only base nodes or other N tasks. "None" means ready now. Test paths marked *(new)* are to be created. Severity reflects the verification results above.

### Wave 1 — security and silent failures (ready now)

#### N01 — Prompt caching on the agent loop
- **Findings:** providers-sdk-01 (confirmed: 0 `cache_control` markers in a 35 KB streaming request), memory-context-11, orchestration-08.
- **Scope:** `sdk/src/impl/llm.ts:1412` uses `isChatGptOAuth && stripCacheControl === false`; change it to `compatibility.stripCacheControl === false` like the non-streaming path at `:2220`. Default OpenRouter routes to `anthropic/*` models to send markers. Keep one system prompt and tool list across plan/execute so the cached prefix survives a mode switch. Show cache-hit % per turn.
- **Accept:** The fake-Anthropic wire test sees markers on the system, tools and last-user breakpoints for the anthropic-compatible and OpenRouter-Anthropic presets, and none for strict OpenAI-compatible presets. A 10-step fixture reports cache-read tokens on steps 2–10. A plan→execute switch keeps the same prefix hash.
- **Verify:** `bun test sdk/src/__tests__/llm-cache-control-wire.test.ts` *(new; seed from `.agents/sessions/product-audit-2026-11-12/verification/probes/runtime/p7-cache.ts`)*, `bun test sdk/src/__tests__/llm.test.ts`.
- **Prereqs:** none.

#### N02 — Project trust gate for executable and credential-bearing config
- **Findings:** extensions-03 (**CRITICAL**, confirmed key exfiltration), exec-jobs-04 (**HIGH**, confirmed), extensions-04, extensions-05 (confirmed, plus `run-state.ts:861`), and the misattributed warning at `provider-config.ts:1399-1440`.
- **Scope:** Until the user trusts a project, `openbuff.json` and `openbuff.d/` content inside it can only tighten policy:
  - no providers with `apiKeyEnv` or credentials, and no `baseURL` overrides of existing providers;
  - no `defaultModel` or mode/agent routes to project-defined providers;
  - no `fileChangeHooks` and no `execution` settings;
  - no `approvalMode` looser than the user's;
  - no `sandbox.allowPaths`;
  - project skills and `.agents/` are not loaded into `fileContext`.

  A first-launch trust screen lists exactly what the project config would enable. The answer is persisted per project path and config hash, outside the repo, and applies to TUI, `run`, `serve` and SDK. Any change to the config hash asks again. Warnings name the file that took effect.
- **Accept:**
  - The verification probes (`.agents/sessions/product-audit-2026-11-12/verification/probes/trust/p1.ts`, `p2.ts`, `p2b.ts`, `p3.ts`) are ported as tests. Untrusted, they show no request to the capture server, no key, no hook execution, `balanced` approval kept, and no project skill in the prompt.
  - After trust is granted, the same fixtures behave as configured.
  - A config change after trust re-prompts.
  - `--trust-project-agents` still works for CI and is recorded as an explicit grant.
- **Verify:** `bun test sdk/src/__tests__/project-trust-gate.test.ts` *(new)*, `bun test sdk/src/__tests__/host-config.test.ts sdk/src/__tests__/provider-config.test.ts`, plus a tmux CLI check of the trust screen.
- **Prereqs:** none (B29 later binds it).

#### N03 — Plan mode is read-only
- **Findings:** orchestration-01 (confirmed: 38 tools including `rename_symbol`, `code_action`, `extract_symbol`, `kill_job`; children keep edit tools; `~/.agents` agents always spawnable), exec-jobs-02 (confirmed: `run-terminal-command.ts:42` sends `full-access`; a plan-mode `rm -f` ran).
- **Scope:** Enforce at dispatch, not in the prompt. Every tool call carries the root mode lineage. In plan lineage, refuse every mutating tool except `create_plan` and `update_plan_status`, plus mutating LSP actions and `kill_job` of jobs the plan did not start. Apply the per-agent terminal profile in the runtime handler instead of hardcoding `full-access`, and clamp plan-lineage descendants to `read-only`. Filter spawnable agents in plan mode to those whose tools are all non-mutating.
- **Accept:**
  - `agents/tool-reachability.test.ts` asserts that no mutating tool is reachable from `base2-plan` or any plan-lineage child.
  - The `p4.ts` and `p5.ts` probes become tests: plan-mode rename and `rm` are refused with a typed `plan_mode_read_only` error, and the files are unchanged.
  - Execute mode is unaffected.
  - Non-plan agents with declared `read-only`/`workspace-write` profiles run under those profiles. This changes the B19 choice to keep full-access; record that in B19's next renewal.
- **Verify:** `bun test agents/tool-reachability.test.ts packages/agent-runtime/src/tools/handlers/tool/__tests__/` and `bun test packages/agent-runtime/src/__tests__/plan-mode-dispatch.test.ts` *(new)*.
- **Prereqs:** none.

#### N04 — Typed results instead of silent empty or false success
- **Findings:** read-search-01, language-intel-02, language-intel-07, web-media-evals-03, web-media-evals-06, web-media-evals-08 (with B33), exec-jobs-13, providers-sdk-08, memory-context-05, memory-context-06.
- **Scope:**
  - Remove the memory-first short-circuit from exhaustive tools (`glob`, `list_directory`, `code_search`). Memory may add hints, marked as memory-sourced.
  - `workspace_symbol` with no warm server returns `unavailable`.
  - A missing LSP binary returns `not_installed`.
  - A DuckDuckGo bot or blocked page returns `blocked`. Context7 with no key returns `auth_required` and no longer sends `Bearer undefined`.
  - `kill_job` reports `killed` only after the exit is observed.
  - A 401/403 failover leaves a persistent status warning naming the env var.
  - The extractive compaction pass is labelled extractive.
  - Pruner skips and failures appear in the compaction card.
- **Accept:** Each listed tool has a negative test reproducing its failure state and asserting the typed status, a reason and a next step. The `glob('Dockerfile', cwd:'src')` probe with only `src/auth/login.ts` in memory returns no match.
- **Verify:** `bun test packages/agent-runtime/src/tools/handlers/tool/__tests__/discovery-coordinator.test.ts sdk/src/__tests__/language-intelligence.test.ts packages/agent-runtime/src/tools/handlers/tool/__tests__/web-search.test.ts` plus new negative cases in each.
- **Prereqs:** none.

#### N05 — Web egress safety
- **Findings:** web-media-evals-01 (confirmed `200 INTERNAL-SECRET` through `http://[::ffff:127.0.0.1]/`), web-media-evals-02. `isBlockedMcpAddress` has the same gap.
- **Scope:** One shared IP classifier for web fetch, redirects and MCP. It unmaps IPv4-mapped, IPv4-compatible and NAT64 IPv6 and checks every private, loopback, link-local, CGNAT and metadata range. Fetch connects to the pinned resolved address (reuse the MCP pinned fetch) so the check and the connection use the same lookup. Redirects are re-checked per hop.
- **Accept:** Tests refuse `[::ffff:127.0.0.1]`, `[::ffff:a9fe:a9fe]`, `[::127.0.0.1]`, `[64:ff9b::7f00:1]`, decimal and octal IPv4 forms, and a public URL redirecting to each. A DNS-rebinding fixture (public on the first lookup, private on the second) is refused. Public fetches still work.
- **Verify:** `bun test packages/agent-runtime/src/tools/handlers/tool/__tests__/web-search-utils.test.ts sdk/src/__tests__/mcp-address-policy.test.ts` *(new cases)*.
- **Prereqs:** none.

#### N06 — Command execution defaults and job lifetime
- **Findings:** exec-jobs-01 (confirmed hang), exec-jobs-09 (**HIGH**, confirmed orphans), exec-jobs-18.
- **Scope:**
  - SYNC commands default to a 120 s timeout (the model may raise it, with a user cap) and `stdin: ignore`.
  - An idle-output watchdog reports "waiting for input?" after 30 s.
  - Cancelling keeps partial output.
  - On SDK/CLI exit (normal, SIGINT, SIGTERM), attached jobs are terminated by process group. Detached jobs follow the existing ownership transfer.
  - The SDK parent honours SIGINT while jobs run.
- **Accept:**
  - The `read x` probe fails within 1 s with EOF.
  - A silent `sleep 200` hits the default timeout.
  - The `p1` orphan probe leaves no surviving `sleep` after each exit path.
  - A cancelled `yes | head -c 1M` returns its partial output.
  - A detached job survives exit as designed.
- **Verify:** `bun test sdk/src/__tests__/run-terminal-command.test.ts sdk/src/__tests__/execution-launch.test.ts` and `bun test sdk/src/__tests__/attached-job-exit.test.ts` *(new, real processes)*.
- **Prereqs:** B20 (accepted).

#### N07 — Provider resilience
- **Findings:** providers-sdk-02 (529 terminal), providers-sdk-09 (Retry-After capped at 8 s), providers-sdk-10 (`[::1]`, LAN and Docker hosts), providers-sdk-08 (with N04).
- **Scope:**
  - Add 529 and the SSE `overloaded_error` to the retry set and the failover set.
  - Honour Retry-After up to 120 s, inside the run deadline, with a visible countdown.
  - Accept `[::1]`, `host.docker.internal` and explicitly configured private hosts as local endpoints.
  - Stop retrying a failed primary every request after a 401 failover. Mark the route degraded for the session.
- **Accept:**
  - A fake server returning 529 then 200 recovers.
  - 529 three times with a backup model configured fails over.
  - Retry-After 45 s is honoured with an injected clock.
  - An `http://[::1]:11434/v1` provider resolves as local.
  - After one 401 failover, later requests go to the backup until restart or `/provider`.
- **Verify:** `bun test sdk/src/__tests__/retry-config.test.ts sdk/src/__tests__/failover.test.ts sdk/src/__tests__/llm.test.ts`.
- **Prereqs:** B08 (accepted).

#### N08 — `/compact` and context controls
- **Findings:** memory-context-01 (confirmed "Command not found"), memory-context-04, memory-context-07.
- **Scope:**
  - Register `/compact [focus]` in the CLI router; it passes the focus to the runtime handler.
  - Load nested and ancestor `AGENTS.md`/`CLAUDE.md`/`knowledge.md` files: all present files per directory, root-to-cwd, plus nested files for touched directories, with `@path` imports.
  - Remove the double injection in `agents/base2/base2.ts:773-774`.
  - `/context` lists the instruction files in effect.
  - Overflow recovery recognises Gemini, Ollama, LM Studio and vLLM wordings and the `context_length_exceeded` code, and retries after a stronger compaction.
- **Accept:**
  - `/compact keep the API notes` compacts and keeps that focus.
  - A fixture with root `AGENTS.md`, `CLAUDE.md` and `pkg/AGENTS.md` (which imports `docs/x.md`) loads all four when working in `pkg/`, each once.
  - Each overflow wording triggers one compaction and retry.
- **Verify:** `bun test cli/src/commands/__tests__/router.test.ts sdk/src/__tests__/run-state.test.ts packages/agent-runtime/src/__tests__/run-agent-step.test.ts`.
- **Prereqs:** none (B11 lists it in the menu).

#### N09 — Ship tree-sitter queries in release builds (early B24 split)
- **Findings:** language-intel-05 (confirmed: an 18-entry tarball with 0 `.scm` files).
- **Scope:** Add `tree-sitter-queries/` to the release workflow tar lists and the npm wrapper `files`, or embed the queries in the binary. `/index status` reports `degraded: no queries` when they are missing.
- **Accept:** The tarball built by the release workflow's file list contains every query file. The installed smoke test indexes a TS fixture and finds symbols, calls and imports. With the queries removed, `/index status` says degraded.
- **Verify:** The release smoke script in `.github/workflows/` plus `bun test packages/code-map`.
- **Prereqs:** none. B24 binds this task.

#### N10 — Eval regression gate
- **Findings:** web-media-evals-10, web-media-evals-11, web-media-evals-14 (with B32), write-edit-08, language-intel-08.
- **Scope:**
  - Point the nightly at `base2` instead of `base2-free`, upload results, and diff against the last green run with `compare-runs.ts`. Exit non-zero past a noise band.
  - Fix or delete the `[buffbench]` workflow and the dead `evals/package.json` scripts.
  - Run a small task subset on PRs that touch `agents/`, `common/src/tools/params/` or system prompts.
  - Report per model the edit-commit rate, tool error rate, LSP call rate and static prompt tokens.
- **Accept:** A deliberately broken prompt change fails the PR subset. The nightly writes a results artifact and fails on regression. Every `evals/package.json` script resolves to an existing file.
- **Verify:** `bun run --cwd evals` the nightly entry against a two-task subset, and a workflow dry run via `act` or CI.
- **Prereqs:** B30 (accepted).

### Wave 2 — cost, onboarding and command UX

#### N11 — Static prompt budget and deferred tools
- **Findings:** orchestration-02 (about 47k fixed tokens), extensions-01, read-search-07, read-search-08, read-search-09, exec-jobs-14, language-intel-12, orchestration-03, orchestration-09, write-edit-07.
- **Scope:** Apply REPORT.md "Minimalism vs breadth".
  - **Turn on deferral:** enable `progressiveToolDisclosure` and add a `tool_search`/`tool_load` tool.
  - **Declared core:** about 15 tools.
  - **Merges:** job tools into one `jobs` tool, and `inspect_workspace` with `inspect_environment`.
  - **Defer:** the audit trio, review bundle, 3D tier, LSP tools (unless a server is detected), `browser_logs`, `read_docs`, git tools, the plan tools outside plan mode, and MCP tools above a token threshold (per-server `direct|deferred|hidden`).
  - **Programmatic only:** the validation tools.
  - **Remove:** unreachable tools (`add_subgoal`, `update_subgoal`, `think_deeply`, `end_turn`), quarantined tools (`find_files`, `find_files_matching_content`), and the standalone legacy edit registrations.
  - **Catalog:** one line per agent, with contracts served through `lookup_agent_info`.
  - **Prompt text:** fix the false `code_search` description, state read policy once, remove `cap.v3` mentions, and settle on one planning surface (`write_todos` with ids, status and `depends_on`; `create_plan` stays plan-mode only).
- **Accept:**
  - A CI test fails when base2's system prompt, tools, catalog and instructions exceed 25k tokens.
  - A deferred tool is callable after `tool_load` in the same turn.
  - With a 60-tool MCP server configured, the fixed token count is unchanged.
  - The tool-reachability test passes with no unreachable registered tools.
  - The N10 eval subset shows no regression against the pre-change baseline.
- **Verify:** `bun test agents/tool-reachability.test.ts agents/__tests__/prompt-budget.test.ts` *(new)* and the N10 PR subset.
- **Prereqs:** N10 (for the regression check).

#### N12 — Headless run and ACP intake
- **Findings:** cli-ux-03, providers-sdk-11, extensions-08.
- **Scope:**
  - `openbuff run` reads the prompt from stdin and gains `-p`, `--model`, `--continue [id]`, `--output-schema <file>` and streaming JSON events (tool calls, results, usage). It runs the same provider readiness check as the TUI.
  - The SDK `run()` accepts a per-run `model`.
  - ACP keeps `resource_link`, `resource` and `image` blocks.
  - Rewrite the SDK README to lead with a ten-line quickstart (run, stream events, read the result), move the internals to a reference section, remove `cap.v3`, and fix the hosted `openbuff/base@0.0.16` example.
- **Accept:**
  - `echo task | openbuff run --model X --output-schema s.json` returns schema-valid JSON.
  - `--continue` resumes the last session.
  - A missing key gives the same message as the TUI.
  - An ACP prompt with a file link delivers the file content.
  - Every README example runs under `bun test sdk/e2e/readme-examples.test.ts` *(new)*.
- **Verify:** `bun test cli/src/__tests__/cli-args.test.ts cli/src/commands/__tests__/run-command.test.ts sdk/src/services/acp/__tests__/`.
- **Prereqs:** B02 (accepted).

#### N13 — First-run onboarding and credential entry
- **Findings:** cli-ux-01, providers-sdk-07, providers-sdk-13.
- **Scope:**
  - When no route is ready, the TUI opens the provider picker at boot.
  - The picker accepts a pasted key. It stores the key in the OS keychain where available, otherwise in a 0600 file under the Openbuff config dir, never in the repo.
  - Exported keys auto-offer the matching preset.
  - Refresh the stale presets (current model IDs, Bedrock region as a parameter) and record a date per preset.
  - Ship a self-contained `openbuff.json.example`.
- **Accept:** In a fresh `HOME`, launching the TUI, pasting a key and sending a prompt works without a restart (tmux test). The key file is 0600 and absent from `git status`. Every preset model ID resolves through discovery when online.
- **Verify:** `bun test cli/src/components/__tests__/provider-picker-screen.test.tsx sdk/src/__tests__/credentials.test.ts` plus the tmux scenario in `docs/testing.md` style.
- **Prereqs:** N02 (credential trust rules).

#### N14 — Approval rules and an honest prompt
- **Findings:** exec-jobs-03, exec-jobs-05, exec-jobs-06, write-edit-03, write-edit-04.
- **Scope:**
  - Ordered allow/ask/deny rules (deny wins) are stored in user config, and in project config only when trusted, as tighten-only.
  - New options: "allow this command prefix" and "allow for this session".
  - The approval prompt renders the full command and every classified effect.
  - Correct the balanced-mode copy.
  - Add an edit approval mode with diff preview (`ask-edits`), and protected paths (`.git/**`, `.env*`, the Openbuff config) that always ask.
  - Near-match edits applied by fuzzy matching are labelled in the CLI with the similarity.
- **Accept:**
  - A deny rule blocks even in allow-all.
  - An allow-prefix rule persists across restarts.
  - A compound command shows all its effects.
  - In `ask-edits`, each edit shows a diff and waits.
  - Writing `.env` asks in every mode.
  - A 92%-similar edit shows "applied with near-match (92%)".
- **Verify:** `bun test sdk/src/__tests__/harness-enforcement.test.ts cli/src/utils/__tests__/create-run-config.test.ts cli/src/components/__tests__/permissions-screen.test.tsx`.
- **Prereqs:** B18 (accepted), N02.

#### N15 — Startup budget
- **Findings:** cli-ux-02 (confirmed: 1,024 ms `--version` from source, 842 ms binary).
- **Scope:**
  - Add a fast path for `--version` and `--help` before any heavy import.
  - Lazy-load the TUI, SDK and tree-sitter.
  - Load the wasm asynchronously.
  - Make the direnv spawn asynchronous and off the critical path.
- **Accept:** On CI hardware, `--version` is under 100 ms and ready-to-type under 800 ms, with idle RSS reported. The numbers are recorded in `PERFORMANCE.json` and gated by B32.
- **Verify:** `bun run scripts/measure-startup.ts` *(new)* in CI.
- **Prereqs:** none.

#### N16 — Bounded tool outputs
- **Findings:** read-search-02, read-search-03 (confirmed), read-search-04, language-intel-10, language-intel-11, exec-jobs-11, web-media-evals-04.
- **Scope:**
  - Every read, list, search, LSP, inspect and bundle result has a model-visible budget (default about 25k tokens, configurable) and a per-line cap (2,000 chars). Over budget, the result is `partial` with `nextOffset`.
  - `glob` gains `limit` and `offset`.
  - `inspect_codebase_structure` walks with `git ls-files` (honouring `.gitignore`) off the event loop.
  - When trimming removes read content, `complete` is cleared and edit authority dropped.
  - Truncated shell output is stored as plain text that `read_logs`/`read_files` can page.
  - Web fetch keeps line structure and refuses binary content types.
- **Accept:**
  - A 10 MB file returns a first page and offset.
  - `glob **/*` on this repo returns at most the limit, plus a count.
  - `inspect_codebase_structure` on this checkout finishes in under 3 s and returns under 25k tokens.
  - The `read-search-03` probe shows `complete:false` and no anchor after trim.
  - A 1 MB command output can be paged.
- **Verify:** `bun test sdk/src/__tests__/read-files.test.ts packages/agent-runtime/src/__tests__/simplify-tool-results.test.ts sdk/src/__tests__/audit-intelligence.test.ts`.
- **Prereqs:** B05 (accepted).

#### N17 — Isolated parallel work on git worktrees (interim B34)
- **Findings:** roadmap-process-06, competitor gap (Codex `fork --worktree`, Claude Code worktrees).
- **Scope:**
  - Subagents or `/worktree <name>` sessions run in a git worktree under the Openbuff state dir.
  - Changes land through an observed merge or cherry-pick with conflict reporting.
  - Cleanup removes the worktree and branch.
  - No daemon dependency.
- **Accept:**
  - Two parallel editor subagents in separate worktrees each commit. The parent merges both, or reports the conflicting files.
  - Cancelling one leaves no worktree behind.
  - The main tree is untouched until landing.
- **Verify:** `bun test sdk/src/__tests__/worktree-sessions.test.ts` *(new, real git)*.
- **Prereqs:** B04 (accepted). B34 later binds it.

#### N18 — Reliable undo and rewind
- **Findings:** write-edit-02, write-edit-09, memory-context-08.
- **Scope:**
  - Snapshot before each turn and before each mutating batch, including agent-created paths from broker receipts.
  - Store snapshots in a shadow repository under the Openbuff state dir, not as refs in the project `.git`.
  - Add `/rewind` with three choices: code, conversation, or both. It keeps `/undo-turn` and `/restore` as aliases.
- **Accept:**
  - After a failed turn that created two files and edited one, `/rewind code` restores the pre-turn tree and deletes the new files.
  - A cancelled turn rewinds only itself, not the previous good turn.
  - `git push --mirror` publishes no snapshot refs.
- **Verify:** `bun test cli/src/utils/__tests__/turn-snapshots.test.ts cli/src/commands/__tests__/snapshot-commands.test.ts`.
- **Prereqs:** B04 (accepted).

### Wave 3 — breadth and parity

#### N19 — Lifecycle hooks
- **Findings:** extensions-07.
- **Scope:** Hook events: PreToolUse, PostToolUse, UserPromptSubmit, SessionStart, Stop, PreCompact and PostCompact.
  - Each hook receives Claude-compatible JSON on stdin.
  - Exit code 2 blocks the action and its stderr is shown to the model.
  - A tool matcher regex selects which tool calls fire a hook.
  - Hooks are configured in user config, or in project config when trusted (N02).
  - Each hook has a timeout.
- **Accept:** Each event fires once in a fixture session. A PreToolUse exit 2 blocks the tool with the hook's message. Untrusted project hooks do not run.
- **Verify:** `bun test sdk/src/__tests__/lifecycle-hooks.test.ts` *(new)*.
- **Prereqs:** N02.

#### N20 — Media and document inputs
- **Findings:** read-search-05, read-search-06, web-media-evals-09.
- **Scope:**
  - PDF reads with a `pages` parameter, as text with an image fallback.
  - `.ipynb` reads as cells with outputs.
  - Latin-1 and UTF-16 decoding with the detected encoding reported.
  - `read_image` downscales to the model's limit and drops BMP/TIFF claims unless converted.
  - One image pipeline for user attachments and model reads.
- **Accept:** Fixtures for a 30-page PDF (pages 3–5), a notebook, a UTF-16 file and a 12 MB PNG each return usable bounded content.
- **Verify:** `bun test sdk/src/__tests__/read-files.test.ts sdk/src/__tests__/read-image.test.ts`.
- **Prereqs:** N16.

#### N21 — Whole-file write byte preservation
- **Findings:** write-edit-06, write-edit-10 (06-F10, 06-F12 residuals).
- **Scope:** `write_file`/whole-file replacement preserves the original BOM and dominant EOL unless the content explicitly changes them. Close the 06-F12 residual.
- **Accept:** CRLF and BOM fixtures round-trip through a whole-file write with only the intended bytes changed.
- **Verify:** `bun test sdk/src/__tests__/change-file.test.ts`.
- **Prereqs:** B05 (accepted).

#### N22 — Job and background-agent control
- **Findings:** exec-jobs-08, exec-jobs-10, exec-jobs-17, orchestration-05.
- **Scope:**
  - A `/jobs` panel lists, follows and kills terminal jobs and background agents.
  - The parent agent is notified when a background agent finishes, instead of polling.
  - One truncation policy (tail-first) everywhere.
  - Spool and job-log temp files are cleaned up.
- **Accept:** In tmux, `/jobs` shows a running job and agent, follows output and kills each. A finished background agent produces a parent notification. No temp files remain after the session.
- **Verify:** `bun test cli/src/components/__tests__/jobs-screen.test.tsx` *(new)*, `bun test sdk/src/__tests__/job-update-forwarder.test.ts`.
- **Prereqs:** N06.

#### N23 — Subagent definitions and limits
- **Findings:** orchestration-04, orchestration-06, orchestration-07, extensions-11, extensions-12.
- **Scope:**
  - Markdown agent definitions (front matter: name, description, tools, model, `max_steps`, `timeout`) in `.agents/*.md` and `~/.agents/*.md`, alongside the TS format.
  - Default limits for subagents: 40 steps and 15 minutes, overridable.
  - A `helper` model role for discovery and summary agents, defaulting to the provider's small model.
  - Custom tools and MCP tools default to `endsAgentStep: false`.
  - Remove hosted leftovers from `AgentDefinition`.
  - Fix `add-an-agent.md` field names and the "secure sandbox" wording.
- **Accept:**
  - A Markdown agent loads, is spawnable and respects its tools list.
  - A runaway subagent stops at its limit with a typed result.
  - File-explorer runs on the helper model when one is configured.
- **Verify:** `bun test cli/src/utils/__tests__/local-agent-registry.test.ts packages/agent-runtime/src/tools/handlers/tool/__tests__/spawn-agent-utils.test.ts`.
- **Prereqs:** N03 (plan filtering must see Markdown agents too).

#### N24 — Composer and session UX
- **Findings:** cli-ux-04, cli-ux-05, cli-ux-08, cli-ux-09, cli-ux-10, cli-ux-14, cli-ux-16, memory-context-12.
- **Scope:**
  - Steering: Enter sends to the running turn as guidance, and Tab queues.
  - Sessions: `/rename`, `/fork` (a new session from any message), and `/export` to Markdown and JSON.
  - Composer input: `@file:line` mentions, `$EDITOR` via Ctrl+X Ctrl+E, optional vim mode, a configurable keymap and asynchronous clipboard reads.
  - Display: custom themes wired up, a scriptable status line, and no env banner on stdout. Profile the per-chunk O(messages) work and fix it.
  - Memory: "remember this" writes to a readable memory file.
- **Accept:**
  - In tmux, a steering message changes the running turn.
  - A fork keeps the original session.
  - `@src/a.ts:10-20` attaches that range.
  - Ctrl+V does not block input.
  - Streaming into a 2,000-message transcript stays under 16 ms per frame.
- **Verify:** `bun test cli/src/` affected suites plus tmux scenarios.
- **Prereqs:** B10.

#### N25 — Provider breadth and reasoning control
- **Findings:** providers-sdk-04, providers-sdk-06, providers-sdk-12.
- **Scope:**
  - Reasoning effort maps to Anthropic `thinking` budgets and to Gemini thinking config. The ChatGPT subscription route defaults to `medium`.
  - Native Gemini (AI Studio/Vertex) and Bedrock Converse provider types.
  - Custom headers per provider.
  - GitHub Copilot and Claude subscription logins where their terms allow.
  - Remove the hosted-Codebuff residue (`getUserInfoFromApiKey`, the Vertex finetuned model path).
- **Accept:**
  - A Claude route with effort `high` sends a `thinking` block (wire test).
  - Gemini and Bedrock fixtures stream tool calls.
  - No SDK export calls `openbuff.com`.
- **Verify:** `bun test sdk/src/__tests__/model-provider.test.ts sdk/src/__tests__/llm.test.ts`.
- **Prereqs:** N07.

#### N26 — MCP and skills intake
- **Findings:** extensions-02, extensions-06, extensions-10.
- **Scope:**
  - `mcp.json` accepts the common fields (`cwd`, `disabled`, `timeout`, `type: streamable-http`). An invalid server entry is skipped with a visible error; the other servers still load.
  - Add `openbuff mcp add|list|remove` and a `/mcp` status view.
  - MCP OAuth for HTTP servers, plus resources and prompts.
  - Skill results include the skill directory for bundled files.
  - Document the `mcp.json` format.
- **Accept:**
  - A config with one bad server loads the others and shows the error in `/mcp`.
  - An OAuth fixture server connects after browser authorization.
  - A skill can reference its own `scripts/` file.
- **Verify:** `bun test common/src/types/__tests__/mcp.test.ts sdk/src/mcp/__tests__/ cli/src/commands/__tests__/mcp-command.test.ts`.
- **Prereqs:** B28 (accepted), N02.

#### N27 — Web search backends and direct fetch
- **Findings:** web-media-evals-03, web-media-evals-05, web-media-evals-15. Complements RWEB, which covers the browser backend.
- **Scope:**
  - Pluggable search providers (Brave, Tavily, Exa, SearXNG), each configured with a BYOK key. DuckDuckGo stays as the keyless fallback.
  - A `web_fetch` tool in base2's core that returns Markdown, using N05's egress policy.
  - Align the researcher-web docs with its behaviour.
- **Accept:** With a Brave key configured, search uses Brave. With no key, it uses DuckDuckGo and reports `blocked` when blocked (N04). base2 fetches a URL without spawning a subagent.
- **Verify:** `bun test packages/agent-runtime/src/tools/handlers/tool/__tests__/web-search.test.ts` plus `web-fetch.test.ts` *(new)*.
- **Prereqs:** N05.

#### N28 — Windows and macOS parity
- **Findings:** exec-jobs-12, cli-ux-12.
- **Scope:**
  - Wire `findWindowsBash` auto-detection.
  - Add a PowerShell route.
  - Process-tree kill on Windows (job objects) and macOS (process groups including grandchildren).
  - CI test jobs on `windows-latest` and `macos-latest` for the SDK and CLI suites.
- **Accept:**
  - On Windows CI, a shell command runs with no env var set.
  - A timeout kills the whole tree on both platforms.
  - The SDK and CLI suites pass on all three platforms.
- **Verify:** CI matrix.
- **Prereqs:** N06.

#### N29 — Public benchmarks and feedback loop
- **Findings:** web-media-evals-12, web-media-evals-13.
- **Scope:**
  - A Terminal-Bench 2.0 adapter and an Aider-polyglot-style edit benchmark run through BuffBench, with results published per release.
  - Re-enable `/feedback`, writing locally and exportable.
  - Opt-in OpenTelemetry export of usage, tool and error metrics. It feeds B31's candidate channel.
- **Accept:**
  - A release run records a Terminal-Bench score and cost alongside the release.
  - `/feedback` writes a record.
  - With OTel enabled, a local collector receives spans. With it disabled, nothing leaves the machine.
- **Verify:** `bun run --cwd evals` the benchmark adapters on a two-task subset, and `bun test sdk/src/__tests__/telemetry-export.test.ts` *(new)*.
- **Prereqs:** N10.

#### N30 — Docs, prompt drift and repo hygiene
- **Findings:** orchestration-10, write-edit-05 (docs part), web-media-evals-15, web-media-evals-16, cli-ux-15, exec-jobs-20, extensions-12.
- **Scope:**
  - Correct the `autoFileChangeHooks` docs and settle one hook timeout value.
  - Fix the `synthesizer` exclusion text and the remaining orchestration doc drift.
  - Remove or implement the shell-shim docs.
  - Add web, browser, image, MCP config, `serve`, skills and trust to the README.
  - Ignore `.tmp/`.
  - Remove `cli/src/index-05.tsx`, `bun.lockb` (if `bun.lock` is canonical) and the tracked eval error JSONs.
  - Delete the unwired components listed in cli-ux-15.
- **Accept:** A docs check script compares documented defaults (hook timeout, `autoFileChangeHooks`, read limits) with the code constants and passes. `git status` is clean after a test run.
- **Verify:** `bun run scripts/check-doc-defaults.ts` *(new)*.
- **Prereqs:** N11 (tool and prompt changes land first).

#### N31 — Short capability handles for edits
- **Findings:** write-edit-01 (HIGH: each `cap.v4` token is about 795 characters and must be copied verbatim; `edit_transaction` costs about 11.3k characters of definition; `agents/editor/editor.ts:24-29` records non-Opus models landing zero edits).
- **Scope:**
  - Keep the authenticated capability on the host.
  - The model receives a short handle per read (for example `r7`), resolved at dispatch to the full bound token.
  - Strict read-before-edit, CAS bases and the run/project binding are unchanged.
  - Trim the `edit_transaction` description to the fields models use.
- **Accept:**
  - A forged, stale or cross-run handle is refused exactly like the full token is today.
  - The edit description and schema are under 4k characters.
  - On the N10 subset, the edit-commit rate for a non-Opus model rises over the pre-change baseline, and no model gets worse.
- **Verify:** `bun test packages/agent-runtime/src/__tests__/process-edit-transaction.test.ts sdk/src/__tests__/read-capability.test.ts` and the N10 subset.
- **Prereqs:** B05 (accepted), N10.

#### N32 — Sandbox reach
- **Findings:** exec-jobs-07 (the OS sandbox is off by default, Linux x64 only, needs a user-supplied binary, and network access is all or nothing).
- **Scope:** Starts after B21 is accepted at its current tier.
  - Ship the native binary in the release artifacts for Linux x64/arm64.
  - macOS Seatbelt backend.
  - A network allowlist (package registries, git hosts, configured providers) in place of all-or-nothing.
  - Offer the sandbox on the trust screen (N02) for untrusted projects.
  - The default stays opt-in until the macOS and Linux cells pass. Then decide whether to turn it on by default.
- **Accept:**
  - An installed release enables the sandbox without manual downloads.
  - On macOS and Linux, a write outside the project and a request to a non-allowlisted host are refused.
  - `bun install` and `git fetch` succeed under the allowlist.
- **Verify:** The native smoke checks in CI on both platforms.
- **Prereqs:** B21, N02.

## Part C — Dispatch order

The base graph is unchanged. The order below is a priority among nodes that are ready under it, plus the N tasks. B21 continues as the current node. To keep B21 bounded, accept its current Linux opt-in tier with stated limits, then move on.

| Wave | Work | Why first |
|---|---|---|
| 0 | Finish B21 at its current tier | Already in progress |
| 1 | N02, N03, N05, N01, N04, N06, N07, N08, N09, N10 | Security issues confirmed live (credential exfiltration, plan-mode writes, SSRF, allow-all), silent wrong answers, hangs and orphans, and the 6× cost bug. Most are small. |
| 2 | B10, B12, B09, B11, B32, B23, N11, N12, N13, N14, N15, N16, N17, N18, N31 | Ready base cards with high user value, plus cost, onboarding, startup, approval rules, bounded outputs, undo and parallel work |
| 3 | B13, B14, B33 (small fixes first), B24 (binds N09), B25, B26, N19–N30, N32 | Memory and history, LSP quality, breadth and parity |
| 4 | B07 → B06, B15 → B17, B29, B34 (binds N17), B16, B27, B35 | Durable recovery, semantic edits, ACP, extension tiers |
| 5 | M22-CORE, M22-TXN, M22-CHILD, B22, B31 | Infrastructure. Start when a measured need appears or when the earlier waves are done |

## Finding coverage

The audit's 145 findings are mapped as follows. Process findings (`roadmap-process-*`) are out of scope by the user's decision.

- **Part A clauses:** providers-sdk-03, -05; cli-ux-05, -06, -07, -11, -13; memory-context-01 (with N08), -02, -03, -09; extensions-04, -08; language-intel-01, -02, -03, -04, -05, -06, -07, -09, -10; web-media-evals-07, -08, -09, -14; orchestration-06; cli-ux-02 (with N15).
- **Part B tasks:** every other product finding, as listed in each task's **Findings** line.
- **Already fixed at HEAD and only regression-tested by their tasks:** 02-F1, 02-F5, 02-F7 (B08); 03-F1, 03-F2 (B02); 04-F1 and caller-side 04-F2; 06-F1, 06-F3 (narrowed), 06-F7, 06-F8, 06-F11; 09-F1, 09-F2, 09-F3; 10-F1, 10-F4, 10-F8, 10-F9; 12-F5.
- **Lower-priority remainder folded into the nearest task:**
  - into N11: read-search-10 (path listing), read-search-11 and language-intel-13 (repo map ranking, with B26), exec-jobs-15 (two shell routes; `git_branch` behaviour);
  - into N10: exec-jobs-16 (affected-tests graph tier);
  - into N24: exec-jobs-19 (PTY, cwd/env persistence; PTY is optional);
  - into N04: read-search-12 (near-match suggestions for missing files);
  - into B13: memory-context-10 (04-F4).
