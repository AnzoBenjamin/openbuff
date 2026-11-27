# Competitor set B: OpenCode, Aider, Pi, Pi-Bolt (as of 12 Nov 2026)

Research date: 2026-11-12. Sources are official docs, repos, source files and changelogs unless marked "third-party". All text is paraphrased. Versions checked against registries on the research date:

| CLI | Current version | Source |
|---|---|---|
| OpenCode | 2.2.7 (`@opencode/cli`; the V1 line `opencode-ai` 1.18.x only gets critical fixes) | [npm](https://registry.npmjs.org/@opencode%2Fcli/latest), [issue #54469](https://github.com/anomalyco/opencode/issues/54469) |
| Aider | 0.86.2 (2026-02-12); last feature release 0.86.0 (2025-08-09); last commit to `main` 2026-05-22 | [PyPI](https://pypi.org/project/aider-chat/), [HISTORY.md](https://github.com/Aider-AI/aider/blob/main/HISTORY.md) |
| Pi | `@earendil-works/pi-coding-agent` 1.5.2 | [npm](https://registry.npmjs.org/@earendil-works%2Fpi-coding-agent/latest), [repo](https://github.com/earendil-works/pi) |
| Pi-Bolt | 1.2.1 (repo created 2026-10-02, about 800 stars) | [npm](https://registry.npmjs.org/pi-bolt/latest), [repo](https://github.com/opensec-git/Pi-Bolt) |

Context changes since 2025 that matter for this audit:
- **OpenCode moved** from `sst/opencode` to [`anomalyco/opencode`](https://github.com/anomalyco/opencode) (about 226k stars). OpenCode 2 is a separate implementation: npm 2.0.0 shipped 2026-09-11, and the official announcement came 2026-10-12 (third-party: [winder.ai](https://winder.ai/deepseek-harness-vs-opencode/), [yodev](https://www.yodev.dev/t/opencode-2-0-que-cambia-y-como-actualizar-desde-1-x-yodev-tested/5671)). **V2 removed LSP.** It accepts `lsp` config but runs no language servers and returns no diagnostics ([migrate-v1 doc](https://github.com/anomalyco/opencode/blob/dev/services/site/src/docs/content/migrate-v1.mdx)). The V2 edit tool source still contains a TODO to add LSP diagnostics once an LSP runtime exists ([edit.ts](https://github.com/anomalyco/opencode/blob/dev/packages/core/src/tool/plugin/edit.ts)).
- **Pi moved** from `badlogic/pi-mono` to `earendil-works/pi` after Armin Ronacher's company Earendil acquired it on 2026-04-08 (third-party: [implicator.ai](https://www.implicator.ai/pi-is-not-a-claude-code-rival-it-is-a-harness-rebellion/)). The repo has about 122k stars. **Pi reversed its "no MCP, ever" position.** It now ships a first-class MCP client, which by default reaches tools through code mode instead of declaring them to the model ([mcp.md](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/mcp.md)).
- **Aider is in maintenance mode.** Its HISTORY "main branch" section adds model aliases (GPT-5.x, Claude 4.5–4.7, Gemini 3) and an `/ok` command. Nothing agentic has been added. Third-party trackers describe it as stalled ([rywalker.com](https://rywalker.com/research/aider), [tomrochette.com](https://www.tomrochette.com/agents/aider/)). The community fork [aider-ce / cecli](https://github.com/ErichBSchulz/aider-ce) exists because upstream moves slowly.

---

## 1. OpenCode (V2, 2.2.x)

### 1.1 Built-in tools
Source: [tools.mdx](https://github.com/anomalyco/opencode/blob/dev/services/site/src/docs/content/tools.mdx) and the tool sources under `packages/core/src/tool/plugin/`.

| Tool | Parameters and behavior |
|---|---|
| `read` | `path`, `offset`, `limit`. Returns numbered lines, at most 2,000 lines and 50 KiB per page, with each line cut at 2,000 chars. A directory path gives a non-recursive listing. Passes PNG/JPEG/GIF/WebP/PDF up to 20 MiB to the model. Fails on other binaries. |
| `glob` | `pattern`, `path`, `hidden`, `limit`. Default 100 results, 30 s timeout. |
| `grep` | `pattern` (regex unless `literal`), `path`, `include`, `caseSensitive`, `limit`. Default 100 matching lines, 30 s timeout. |
| `edit` | `path`, `oldString`, `newString`, `replaceAll`. Must match exactly once unless `replaceAll` is set. **Fuzzy fallback:** if there is no exact match, it retries ignoring typographic quote/dash/space variants, then trailing whitespace per line. Whitespace-insensitive line voting is used to build "did you mean" hints. CRLF/LF is preserved. Line-number prefixes from `read` output must be stripped. A configured formatter may run afterwards ([edit.ts](https://github.com/anomalyco/opencode/blob/dev/packages/core/src/tool/plugin/edit.ts), [formatters](https://github.com/anomalyco/opencode/blob/dev/services/site/src/docs/content/formatters.mdx)). No stale-file (read-before-write / mtime) check is documented in V2. |
| `write` | Whole-file create or overwrite. Creates parent dirs and may run the formatter. |
| `patch` | Multi-file `*** Add/Update/Delete File` envelope (the Codex apply_patch format). Exposed **only to GPT models**; other models get `edit` + `write`. This is per-model tool shaping. |
| `shell` | `command`, `workdir`, `timeout` (ms; default 2 min foreground, 0 disables), `background` (returns immediately and notifies the session on completion; no timeout by default). An auto-background mode moves commands still running at timeout into the background. Large output is truncated and the full output is kept in a managed file ([shell.ts](https://github.com/anomalyco/opencode/blob/dev/packages/core/src/tool/plugin/shell.ts)). Permission is evaluated per scanner-parsed sub-command. |
| `webfetch` | `url`, `format` (markdown default / text / html), `timeout` up to 120 s. Text responses only. |
| `websearch` | `query`. Uses a selectable provider integration ([websearch.mdx](https://github.com/anomalyco/opencode/blob/dev/services/site/src/docs/content/websearch.mdx)). |
| `question` | Structured multi-choice question to the user. A free-form answer is always allowed. |
| `skill` | Loads one skill's instructions and resources on demand. |
| `subagent` | `agent`, `description`, `prompt`, optional `sessionID` to continue a child. Always async: the parent gets a `<subagent>` message each time the child goes idle. Default nesting depth 1. |
| `execute` (Code Mode) | JS sandbox (no fs/imports/timers, has `fetch`) that calls tools from a catalog. **MCP tools are reached through Code Mode by default.** Set `codemode: false` on a server to declare its tools directly. Namespaces: `opencode` (`session_rename`, `session_move`, `worktree_create/list/remove`) and `browser` (Desktop-attached browser: tabs, snapshots, clicks, screenshots, console/network, perf traces, Lighthouse). |
| `experimental_image_generate` | Background image generation and editing when a connected provider has an image model. |
| todo | **Off by default in V2.** Enable with `experimental.todo` ([migrate-v1](https://github.com/anomalyco/opencode/blob/dev/services/site/src/docs/content/migrate-v1.mdx)). |
| LSP | **Removed in V2** (see above). V1 auto-installed or ran about 30 language servers and fed diagnostics back after edits ([v1 lsp doc](https://github.com/anomalyco/opencode/blob/dev/services/site/src/docs/v1/content/lsp.mdx)). Users objected that falling back to project lint commands means slower feedback and missing linters ([issue #50916](https://github.com/anomalyco/opencode/issues/50916)). |
| Repo map | None. |

### 1.2 Orchestration
- **Agents** ([agents.mdx](https://github.com/anomalyco/opencode/blob/dev/services/site/src/docs/content/agents.mdx)): Markdown files with frontmatter (`.opencode/agents/<name>.md`, global `~/.config/opencode/agents/`), or JSONC under `agents`. Fields: `description`, `mode` (`primary` / `subagent` / `all`), `model` (with a `#variant` suffix), `system`, `steps`, `permissions`. Nested paths become IDs (`team/reviewer`).
- Built-in visible agents: **build** (default, broad access), **plan** (read-only except plan files; shell still permission-gated), **general** (subagent, cannot spawn more), **explore** (read-only subagent). Hidden maintenance agents: `compaction`, `title`, `summary`.
- Subagent launch is controlled by `subagent` permission rules on the parent. The child uses its own permissions.
- Headless: `opencode run "<msg>"`, with `--standalone` for CI (private server in the same process). `opencode mini` gives a minimal interactive UI. `opencode api` makes authenticated raw calls to the background service, for example `POST /api/session/<id>/compact` ([cli/commands.mdx](https://github.com/anomalyco/opencode/blob/dev/services/site/src/docs/content/cli/commands.mdx)).
- SDK: `@opencode/client` for the V2 server API. Breaking change from V1 ([migrate-v1](https://github.com/anomalyco/opencode/blob/dev/services/site/src/docs/content/migrate-v1.mdx)).
- ACP: `opencode acp` for editor integration.
- Background work: background shell, always-async subagents, background image generation.
- Worktrees: first-class `worktree_create` plus `session_move`, so a session can be moved into a fresh worktree.

### 1.3 Context management
- **Compaction** ([compaction.mdx](https://github.com/anomalyco/opencode/blob/dev/services/site/src/docs/content/compaction.mdx)): on by default. When near the window, it summarizes the whole conversation and keeps about 15k recent tokens verbatim (`compaction.keep.tokens`). `buffer` accepts tokens or a percentage. The summary request sends the full conversation **so it reuses the prompt cache**, and later compactions update the previous checkpoint summary. Manual compaction goes through the API. V1 `prune` / `tail_turns` were dropped.
- **Memory files** ([instructions.mdx](https://github.com/anomalyco/opencode/blob/dev/services/site/src/docs/content/instructions.mdx)): global `~/.config/opencode/AGENTS.md` plus every `AGENTS.md` from the cwd up to the project root. Skills follow the Agent Skills format. **References** let the agent address outside directories by name.
- **Undo/checkpoints** ([snapshots.mdx](https://github.com/anomalyco/opencode/blob/dev/services/site/src/docs/content/snapshots.mdx)): a git-backed snapshot before and after every model step. `/undo` stages a rollback of both conversation and files, and puts the prompt back in the editor for revision. `/redo` cancels. Coverage: tracked files and non-ignored untracked files ≤ 2 MiB in the active directory. Snapshots need a git repo.
- **Sessions**: stored server-side (SQLite). `/sessions`, `opencode session`, `/btw <question>` (side question that is not added to history).
- **Prompt caching:** opt-in **session warming** ([warming.mdx](https://github.com/anomalyco/opencode/blob/dev/services/site/src/docs/content/warming.mdx)) sends a keep-alive request at 90% of the model's `cache.ttl` (or every 4 min) for up to 30 min after the last real request.
- Token economy: per-model prompt variants. Pi's author describes OpenCode's Claude prompt as a cut-down copy of Claude Code's ([Zechner blog](https://mariozechner.at/posts/2025-11-30-pi-coding-agent/)). `opencode stats` reports usage.

### 1.4 Safety / permissions
- Ordered rule list `{action, resource, effect}`. **The last match wins**, and the default when nothing matches is `ask` ([permissions.mdx](https://github.com/anomalyco/opencode/blob/dev/services/site/src/docs/content/permissions.mdx)). Actions: `read`, `edit`, `glob`, `grep`, `shell`, `subagent`, `skill`, `question`, `webfetch`, `websearch`, `external_directory`, `<server>_<tool>`, `execute`. For an operation touching many resources, any deny blocks it, otherwise any ask prompts.
- The built-in `build` agent allows tools by default and asks only on sensitive env-file reads. **V2 changed `external_directory` to allow by default** (V1 asked).
- No OS sandbox. Docker images exist (`ghcr.io/anomalyco/opencode`).
- Security track record: CVE-2026-22812, an unauthenticated localhost server with permissive CORS that allowed drive-by RCE in versions before 1.0 ([GHSA-vxw4-wv6m-9hhh](https://github.com/advisories/GHSA-vxw4-wv6m-9hhh)). An `/global/upgrade` content-type RCE fixed in 1.18.22 ([Datadog](https://securitylabs.datadoghq.com/articles/opencode-upgrade-remote-code-execution/)). A malicious-MCP-server OAuth RCE on Windows/WSL in October 2026 ([Pillar](https://www.pillar.security/blog/open-and-shut-remote-code-execution-in-opencode-via-mcp-oauth)). V2 servers use HTTP Basic auth (`OPENCODE_PASSWORD`) and one-time pairing links.

### 1.5 Extensibility
- **Plugins** ([plugins overview](https://github.com/anomalyco/opencode/blob/dev/services/site/src/docs/content/build/plugins/index.mdx), [server part](https://github.com/anomalyco/opencode/blob/dev/services/site/src/docs/content/build/plugins/server.mdx)): one npm package can have up to four parts. **Server** (tools, hooks, integrations, commands, agents, providers, MCP, permissions, sessions, storage, VCS, worktrees, websearch), **TUI**, **GUI** (Desktop), and **RPC** (a typed contract between the parts). Registries are edited through replayable synchronous **transforms**, for example `ctx.model.transform` to drop models above a price. The V2 plugin API is a breaking change from V1.
- Plugins load from `.opencode/plugins/` automatically or from the `plugins` array (npm, versioned, local paths).
- **MCP** ([mcp-servers.mdx](https://github.com/anomalyco/opencode/blob/dev/services/site/src/docs/content/mcp-servers.mdx)): `mcp.servers` with local (stdio) or remote, OAuth, and separate `timeout.catalog` / `timeout.execution`. Exposure goes through Code Mode by default.
- Custom commands (Markdown), skills, themes, keybinds, formatters, and **policies** (provider allow/deny).

### 1.6 UX
- **Client/server architecture:** one background service (`opencode service start|restart`, default port 49374) that the TUI, Desktop app, web UI (`opencode pair` prints one-time links valid 5 min, plus a QR code; `--remote` goes through an OpenTunnel relay) and editors (ACP) all attach to ([web.mdx](https://github.com/anomalyco/opencode/blob/dev/services/site/src/docs/content/cli/web.mdx)).
- TUI ([tui.mdx](https://github.com/anomalyco/opencode/blob/dev/services/site/src/docs/content/cli/tui.mdx)): `@file#20-45` range mentions, `!` shell mode, Ctrl+P command palette, Enter steers a running turn and Ctrl+X Enter queues. Model switching mid-session with Ctrl+X M or `/models`, and F2 cycles recent models.
- Providers: many built in, connected with `/connect`. The models.dev registry was created by the OpenCode team. Paid add-ons: OpenCode Console, Zen, Go ($10/month). Cost data appears in `opencode stats`.
- Git: snapshots (above) and worktree tools. No auto-commit.

### 1.7 Performance
Pi-Bolt's harness measured OpenCode **2.0.27** against Pi-Bolt 0.8.5 with the same scripted local model ([BENCHMARKS.md § Against OpenCode 2.0](https://github.com/opensec-git/Pi-Bolt/blob/pi-bolt/docs/BENCHMARKS.md)). On Linux: ready-to-type 1,687 ms vs 39 ms. CPU for a 5-prompt interactive session 8.6 s vs 0.19 s. Peak memory 408 MB vs 149 MB. CPU per prompt at prompt 25 was 475 ms vs 49 ms. OpenCode did not finish all answers in the tmux run. Note that the measurement comes from a competitor.
Issue reports: unbounded heap growth to 37 GB RSS ([#15348](https://github.com/anomalyco/opencode/issues/15348)), OOM/soft lockups ([#13230](https://github.com/anomalyco/opencode/issues/13230)), a 2 GB SQLite database with no pruning ([#16729](https://github.com/anomalyco/opencode/issues/16729)), and orphaned LSP processes in V1 ([#18632](https://github.com/anomalyco/opencode/issues/18632)).

### 1.8 Benchmarks
Terminal-Bench 2.0: **OpenCode + Claude Opus 4.5 = 51.7%** (2026-01-12). Same model, other harnesses: Claude Code 52.1%, Terminus 2 57.8% ([tbench.ai snapshot, April 2026](https://web.archive.org/web/20260410072937/https:/www.tbench.ai/leaderboard/terminal-bench/2.0)). No OpenCode V2 entry was found.

### 1.9 Weaknesses / complaints
- The V2 rewrite broke plugins, the server API and TUI config. LSP was removed. Todo is behind a flag. V2 shipped without release notes for weeks ([#52184](https://github.com/anomalyco/opencode/issues/52184)), and V1/V2 version confusion followed ([#54813](https://github.com/anomalyco/opencode/issues/54813)).
- Heavy runtime: about 1.5 s startup, roughly 0.4 s CPU per prompt even early in a session, and memory-leak reports.
- Repeated RCE-class security bugs tied to the always-on server.
- Permissive defaults (build agent allows most tools; external directories allowed).

---

## 2. Aider (0.86.x)

### 2.1 Built-in "tools"
Aider does **not use tool calling** for edits. The model replies in a text edit format, and Aider parses and applies it.
- **Edit formats** ([edit-formats](https://aider.chat/docs/more/edit-formats.html)):
  - `whole`: full file.
  - `diff`: git-conflict-style `<<<<<<< SEARCH / ======= / >>>>>>> REPLACE` blocks after the file path.
  - `diff-fenced`: path inside the fence, for Gemini.
  - `udiff`: simplified unified diff, introduced to reduce GPT-4 Turbo "lazy coding" ([blog](https://aider.chat/2023/12/21/unified-diffs.html)).
  - `editor-diff` / `editor-whole`: slim prompts for architect mode.
  - Aider also supports a `patch` format for OpenAI models.
  - The format is chosen per model in `model-settings.yml`. For example, 0.85.5 forces `diff` for GPT-5.
- Matching: SEARCH must match file content. Aider tolerates some whitespace/indent drift and `...` elisions, and on failure it reports the near-miss lines so the model can retry (behavior of `editblock_coder`; not separately documented).
- Freshness: chat files are re-sent from disk each turn, so the model sees current content. Separately, dirty files are committed before Aider edits them (below).
- **Repo map** ([repomap](https://aider.chat/docs/repomap.html)): tree-sitter extracts definitions and references. A graph ranking (PageRank over a file-dependency graph, [2023 post](https://aider.chat/2023/10/22/repomap.html)) picks the most-referenced symbols that fit `--map-tokens` (default **1k**). The map grows when no files are in chat (`--map-multiplier-no-files`), and `--map-refresh` sets refresh policy. `/map` and `/map-refresh` print or refresh it. Recent additions are Fortran, Haskell, Julia, Zig and Bash tags.
- Shell: the model can *suggest* commands (`--suggest-shell-commands`), and the user confirms each one. `/run` (or `!`) runs a command and optionally adds its output. `/test` adds output only on non-zero exit. There is no autonomous shell loop and no timeout or background controls.
- **Lint/test loop** ([lint-test](https://aider.chat/docs/usage/lint-test.html)): built-in linters run after every edit (`--auto-lint`, `--lint-cmd`, per-language `--lint "lang: cmd"`). `--test-cmd` with `--auto-test` feeds failures back automatically.
- Web: `/web <url>` scrapes to markdown (Playwright optional). No search.
- Other: `/voice` input, `/paste` images, `--watch-files` "AI comments" (write `AI!` or `AI?` in any editor to trigger) ([watch](https://aider.chat/docs/usage/watch.html)), browser GUI, `/copy-context` for pasting into web chat UIs ([copypaste](https://aider.chat/docs/usage/copypaste.html)), and "infinite output" that continues past the output limit by prefill on supporting models ([infinite-output](https://aider.chat/docs/more/infinite-output.html)).
- No todo tool, LSP or MCP. MCP issue #3314 has been open since Feb 2025 (third-party: [oodle.ai](https://www.oodle.ai/guides/mcp/aider)).

### 2.2 Orchestration
- **Chat modes** ([modes](https://aider.chat/docs/usage/modes.html)): `code`, `ask`, `architect`, `help`, `context`. `/ask` and `/code` apply to one message, and `/chat-mode` is sticky. The recommended workflow is to agree a plan in `/ask`, then say "go ahead" (or `/ok`) in code mode.
- **Architect/editor split:** the architect model reasons and writes plain-language change instructions. A separate `--editor-model` with `editor-diff` / `editor-whole` turns them into well-formed edits. On the polyglot board, o3 (high) + gpt-4.1 in architect mode scored 78.2%.
- Three model roles: main, editor, weak. The weak model writes commit messages and history summaries.
- Headless: `--message` / `-m`, `--message-file`, `--yes`. Shell loops over files are the documented batch pattern. The Python `Coder` API is unofficial ([scripting](https://aider.chat/docs/scripting.html)).
- No subagents or background tasks.

### 2.3 Context management
- The user manages context manually with `/add`, `/drop`, `/read-only`, `/ls`, `/tokens`, `/clear`, `/reset`. `--read CONVENTIONS.md` is the memory-file pattern ([conventions](https://aider.chat/docs/usage/conventions.html)).
- History summarization by the weak model starts after `--max-chat-history-tokens`. `--restore-chat-history` restores the previous chat. `/save` and `/load` write and replay command files. There is no session tree.
- **Prompt caching** (`--cache-prompts`, [caching](https://aider.chat/docs/usage/caching.html)): orders the request as system prompt, read-only files, repo map, then editable files to maximise cache hits. `--cache-keepalive-pings` keeps the cache warm.
- Undo is git: `/undo` reverts the last Aider commit. `/diff` shows changes since the last message.

### 2.4 Safety / permissions
Aider confirms before running shell commands, adding files, or creating a repo. `--yes-always` disables the prompts. Edits apply without asking, and git is the safety net. No sandbox.

### 2.5 Extensibility
YAML/env config, `.aider.model.settings.yml` / `.aider.model.metadata.json` for model tuning, custom commit prompts, and LiteLLM for providers. No plugin system, hooks or MCP.

### 2.6 UX
- prompt_toolkit line REPL, not a full-screen TUI. Multiline mode and vi/emacs bindings.
- `/model`, `/editor-model`, `/weak-model` switch models mid-session. `/reasoning-effort` and `/think-tokens` set reasoning controls.
- Providers via LiteLLM (dozens of providers, plus Ollama and local models).
- Per-message and session cost shown after each reply.
- **Git** ([git](https://aider.chat/docs/git.html)): auto-commits every edit with a Conventional-Commits message written by the weak model. Pre-existing dirty changes are committed separately first. Commits get an "(aider)" author/committer suffix. Pre-commit hooks are skipped unless `--git-commit-verify` is set. Toggles: `--no-auto-commits`, `--no-dirty-commits`, `--no-git`.

### 2.7 Performance
Python startup with LiteLLM import is slow (seconds). No published measurements found.

### 2.8 Benchmarks
- **Aider polyglot** (225 Exercism exercises in C++/Go/Java/JS/Python/Rust; [leaderboard data](https://github.com/Aider-AI/aider/blob/main/aider/website/_data/polyglot_leaderboard.yml), last entry 2025-10-03):

| Model | Edit format | Pass rate | Cost |
|---|---|---|---|
| gpt-5 (high) | diff | 88.0% | $29.08 |
| gpt-5 (medium) | diff | 86.7% | $17.69 |
| o3-pro (high) | diff | 84.9% | $146.32 |
| gemini-2.5-pro-preview-06-05 (32k think) | diff-fenced | 83.1% | $49.88 |
| gpt-5 (low) | diff | 81.3% | $10.37 |
| o3 (high) + gpt-4.1 | architect | 78.2% | $17.55 |
| DeepSeek-V3.2-Exp (Reasoner) | diff | 74.2% | **$1.30** |

- Aider has no Terminal-Bench 2.0 or SWE-bench entry as a harness.

### 2.9 Weaknesses / complaints
- Development has stalled. The maintainer is mostly absent ([#4613](https://github.com/aider-ai/aider/issues/4613), [#5673](https://github.com/Aider-AI/aider/issues/5673), [HN](https://news.ycombinator.com/item?id=46067090)), about 1,950 issues are open, and model recommendations are stale.
- It is not an agent: there is no autonomous tool loop, the human manages context, and it has no MCP or subagents.
- The auto-commit flood annoys some users, and commits skip pre-commit hooks by default.

---

## 3. Pi (earendil-works/pi 1.5.x)

### 3.1 Built-in tools
Source: [cli.md § Tools](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/cli.md) and [src/core/tools](https://github.com/earendil-works/pi/tree/main/packages/coding-agent/src/core/tools).
- **Default enabled: `read`, `bash`, `edit`, `write`.** Also built in but off by default: `grep`, `find`, `ls`, and `powershell` on Windows. Built-in extensions add `codemode` and `tool_search`, which turn on automatically when MCP needs them.
- `read`: `path`, `offset` (1-indexed), `limit`. Truncates at **2,000 lines or 50 KB**, whichever comes first, and tells the model to continue with `offset`. Images (jpg/png/gif/webp/bmp) are sent as attachments with model-specific resize.
- `edit`: `path`, `edits: [{oldText, newText}]` (a multi-edit array; an older single `oldText/newText` form is migrated). Each `oldText` must be **unique and non-overlapping in the original file**. Matching tries an exact match first, then a **fuzzy fallback** (NFKC normalisation, smart quotes, Unicode dashes and spaces to ASCII, trailing whitespace stripped). CRLF and BOM are preserved. A **file-mutation queue** serialises concurrent edits to the same file within a turn ([edit-diff.ts](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/tools/edit-diff.ts), [extensions.md file-mutation section](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md)). No stale-read check.
- `write`: whole-file create or overwrite, with mkdir -p.
- `bash`: `command`, `timeout` in seconds (**no default timeout**). Output goes to the model truncated (2,000 lines / 50 KB) with `full_output_path`. Runs as a detached process group. **No background bash by design.** The author recommends tmux ([Zechner blog](https://mariozechner.at/posts/2025-11-30-pi-coding-agent/)).
- `codemode` ([codemode.md](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/codemode.md)): raw JS run in a **QuickJS sandbox** (no Node, fs, network or timers) that calls `tools.*`, plus `searchTools()` (BM25), `describeTool()`, `ALL_TOOLS`, `store()/load()` (branch-aware state persisted in the session, limit 256 KB per value / 1 MB total) and `models` (non-LLM models such as classifiers and image generation). Options line: `max_output_tokens` (default 10k; head+tail kept, full output to a temp file), `timeout_ms`. Only the script's output reaches the model. `codemode.mode: only` hides all other tools behind it. Inline declarations share a 3,000-token budget.
- `tool_search`: declares matching deferred tools for the next call.
- No built-in web, todo, LSP or repo map. All of these come as extensions or packages, for example `opensec-pi-todo` and `pi-fff`.

### 3.2 Orchestration
- **No built-in subagents or plan mode, on purpose** ([README](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/README.md)). The documented alternatives: have Pi run itself via `bash`, optionally inside tmux; use a prompt template for review subagents; or use the example extensions `subagent/` and `plan-mode/` ([extensions.md examples](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md)).
- Modes ([how-pi-works](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/how-pi-works.md)): interactive; **print** (`-p`); **JSON** event stream (JSONL); **RPC** (JSONL commands on stdin, events on stdout, including extension UI over RPC, [rpc.md](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/rpc.md)); and the **TypeScript SDK** (in-process sessions, [sdk.md](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sdk.md)). OpenClaw is the flagship embedder.
- Message queueing: **steering** messages enter after the current assistant turn, **follow-ups** after all pending work. Aborting returns queued messages to the editor.
- **Virtual models** ([virtual-models.md](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/virtual-models.md)): an extension-registered selectable model that routes each request to a physical model and thinking level, for example plan on a big model and implement on a small one (`jev-router.ts` example).

### 3.3 Context management
- **Session tree** ([sessions.md](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sessions.md), [session-format.md](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/session-format.md)): JSONL at `~/.pi/agent/sessions/--<path>--/<ts>_<uuid>.jsonl`. Entries have `id` and `parentId`, and the leaf is the active branch. Entry types: `session` header, `message`, `model_change`, `thinking_level_change`, `usage`, `compaction`, **`context_edit`** (append-only removal or replacement of an earlier entry's contribution to *future* context, branch-relative), `branch_summary`, `custom`, `custom_message`, `label`, `session_info`. Format v3, with auto-migration.
- `/tree` moves within a file. Selecting a user message puts it back in the editor to re-branch. `/fork` creates a new file from an earlier user message, and `/clone` copies the active branch. **Branch summarization:** when you leave a branch, Pi can summarize it into the branch you enter.
- **Compaction** ([compaction.md](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/compaction.md)): triggers at `contextTokens > window − reserveTokens` (default 16,384), checked between tool batches as well as before prompts. It keeps `keepRecentTokens` (default 20k), and the structured summary is updated iteratively and tracks file operations cumulatively. One compact-and-retry recovery on overflow or an early `length` stop. Original entries stay in the tree. `/compact [instructions]`. Extensions can replace compaction (`session_before_compact`).
- Memory files: global and project `AGENTS.md` / `CLAUDE.md` / `AGENTS.override.md`. `SYSTEM.md` / `APPEND_SYSTEM.md` replace or extend the system prompt.
- Undo: **no built-in file checkpoints.** The `git-checkpoint.ts` example stashes on each turn. `/tree` rewinds the conversation only.
- **Prompt caching:** `cacheWarming` `off|streaming|idle` (default `idle`, up to 30 min). It runs only when the model declares a cache TTL **and Pi estimates at least $0.05 of avoided cache-miss cost**. `showCacheMissNotices` reports misses. When MCP server summaries change, Pi appends the new section to the conversation instead of rewriting tool declarations, so the cache prefix stays intact ([settings.md](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/settings.md), [mcp.md](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/mcp.md)).
- **Token economy:** as of Nov 2025 the system prompt plus tool definitions were **under 1,000 tokens**. Only AGENTS.md is appended, and skill bodies load on demand ([Zechner blog](https://mariozechner.at/posts/2025-11-30-pi-coding-agent/)). The 1.5.x edit tool description is longer (multi-edit guidance), so the current figure is probably somewhat higher. I did not re-measure it.
- `/session` shows file, ID, message count, tokens and cost. `/export` writes HTML or JSONL, and `/share` uploads with a viewer link. The project encourages publishing OSS sessions to Hugging Face (`pi-share-hf`).

### 3.4 Safety / permissions
- **YOLO by default:** no approval prompts for file or shell actions. The author argues that read data + execute code + network access cannot be made safe, so he does not pretend to ([blog](https://mariozechner.at/posts/2025-11-30-pi-coding-agent/)). The current docs state that safety must come from OS or VM isolation, and that watching transcripts or reviewing diffs is not a security boundary ([security.md](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/security.md)).
- **Project trust:** loading `.pi/settings.json`, `.pi/mcp.json`, `.pi/extensions|skills|prompts|themes`, `.pi/SYSTEM.md` or project `.agents/skills` needs a trust decision. Sources: `--approve`/`--no-approve`, an extension `project_trust` handler, `~/.pi/agent/trust.json`, or `defaultProjectTrust` (default `ask`; non-interactive modes skip untrusted resources). AGENTS.md / CLAUDE.md load regardless of trust.
- Opt-in guards as extensions: `permission-gate.ts`, `protected-paths.ts`, `dirty-repo-guard.ts`, and `gondolin/` (routes built-in tools and `!` commands into a micro-VM). Tool `annotations` (`readOnlyHint`, `destructiveHint`, …) let a permission extension mimic Codex's approval policy. `containerization.md` covers isolation.
- Users have asked for an optional core safety mode ([discussion #3169](https://github.com/earendil-works/pi/discussions/3169)).

### 3.5 Extensibility
- **Extensions** ([extensions.md](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md), about 158 KB of docs): in-process TypeScript factories, hot-reloadable with `/reload`. APIs:
  - `registerTool` (TypeBox schemas, custom renderers, `executionMode: "sequential"`, can override built-ins), `registerCommand`, `registerShortcut`, `registerFlag`, `registerProvider`, `registerVirtualModel`, `registerMcpServer`, `registerMessageRenderer` / `registerEntryRenderer`, `sendMessage` / `sendUserMessage`, `setActiveTools`, `pi.exec` (timeout, `maxBuffer` 256 MiB), `pi.events` (inter-extension bus).
  - Session control: `ctx.newSession`, `ctx.fork`, `ctx.navigateTree`, `ctx.compact`, `ctx.getContextUsage`.
  - **Events/hooks:** `project_trust`, `resources_discover`, `session_start` / `before_switch` / `before_fork` / `before_compact` / `before_tree` / `shutdown`, `before_agent_start`, `agent_*`, `turn_*`, `message_*`, `tool_execution_*`, **`context`** and **`context_with_system`** (rewrite the context per request), `before_provider_headers` / `before_provider_request` / `after_provider_response` / `provider_stream_event`, `cache_warming_decision`, `model_select`, `thinking_level_select`, `tool_call` (block or modify), `tool_result`, `user_bash`, `input`.
  - About 70 bundled examples, including games (Doom overlay).
- **Skills** (Agent Skills spec, on-demand), **prompt templates** (Markdown to `/` commands with args), **themes**, and **Pi packages** that bundle all four via npm or git (`pi install npm:…`). Third-party reports counted more than 2,100 community packages in May 2026 ([implicator.ai](https://www.implicator.ai/pi-is-not-a-claude-code-rival-it-is-a-harness-rebellion/)).
- **MCP (changed stance):** the Nov 2025 blog said MCP would never be supported, citing Playwright MCP (21 tools, 13.7k tokens) and Chrome DevTools MCP (26 tools, 18k tokens) as 7–9% of context before work starts. Pi 1.5 supports stdio and streamable HTTP (no SSE), OAuth, `pi mcp add|list|login`, and `/mcp`. The **default exposure is `codemode`**: tools are not declared and are found by scripts. The other exposures are `deferred` (found via `tool_search`), `direct` and `hidden`, with per-tool `toolExposure` globs. Tools are named `mcp__<server>__<tool>`. The first prompt waits at most 10 s, and only for `direct` servers. The "progressive disclosure" argument behind the original refusal is now built into the MCP client.

### 3.6 UX
- **pi-tui:** retained-mode components render to line arrays. **Differential rendering** compares new lines with the previously written back-buffer and redraws only what changed, inside **synchronized output** (CSI 2026) for almost no flicker. It renders into the native scrollback, so terminal scrolling and search keep working ([blog](https://mariozechner.at/posts/2025-11-30-pi-coding-agent/), [tui.md](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/tui.md)). Components: Markdown, Image, Editor, SelectList, ScrollView, MouseRegion and others.
- Model switching mid-session: `/model`, `/scoped-models` with keyboard cycling, `/thinking`. Cross-provider context handoff (pi-ai converts thinking and tool blocks between APIs).
- Providers: `/login` for subscriptions (Claude Pro/Max, ChatGPT/Codex, Copilot…) or API keys. Anthropic, OpenAI, Google, xAI, Groq, Cerebras, OpenRouter, any OpenAI-compatible endpoint, llama.cpp router (`/llama`). The model registry is generated from OpenRouter and models.dev with costs.
- Cost: footer shows context usage, tokens and cost. `/session` gives totals.
- Git: none built in. Extensions `auto-commit-on-exit.ts`, `git-checkpoint.ts` and `git-merge-and-resolve.ts` add it.

### 3.7 Performance (Node)
From Pi-Bolt's measurements of Pi 1.4.0 on Node 24, Linux x86-64, one CPU ([Pi-Bolt README](https://github.com/opensec-git/Pi-Bolt)): ready-to-type 423 ms; memory after 40 prompts 521 MB; 352 ms CPU per prompt at prompts 21–40; **143.7 s to write a 400 KB file through a tool call**; and 18.6 s CPU to stream a 60k-char answer. The causes are in Pi's own code: it re-lexes all Markdown, re-parses tool-call args and re-highlights on each redraw, so cost grows quadratically with length (see Pi-Bolt).

### 3.8 Benchmarks
- Terminal-Bench 2.0, Claude Opus 4.5, 5 trials per task. The author reported 2nd place on the leaderboard as of 2025-12-02 (results.json submitted, [blog](https://mariozechner.at/posts/2025-11-30-pi-coding-agent/)). **The April 2026 snapshot of the official board ([archive](https://web.archive.org/web/20260410072937/https:/www.tbench.ai/leaderboard/terminal-bench/2.0)) has no Pi entry**, so treat the claim as self-reported. The comparable Opus 4.5 entries on that board are Terminus 2 57.8%, Claude Code 52.1%, OpenHands 51.9% and OpenCode 51.7%.
- Edit-format evidence from the Pi ecosystem: the oh-my-pi fork's **hashline** edit format (each read line tagged with a short content hash; edits address hashes and are rejected if the content changed) reportedly lifted Grok Code Fast 1 from 6.7% to 68.3% on 180 React edit tasks, averaging +15 points across 16 models (third-party summary of Can Bölük's "Harness Problem" experiments: [yuv.ai](https://yuv.ai/blog/oh-my-pi-omp-explained)).

### 3.9 Weaknesses / complaints
- No sandbox or approvals in core, and safety depends on third-party extensions ([#3169](https://github.com/earendil-works/pi/discussions/3169), [glukhov.org review](https://glukhov.org/ai-devtools/pi/pi-coding-agent-review/)).
- "A harness you finish yourself" ([devopstales](https://devopstales.github.io/ai/pi-coding-agent-review/)). Extension install and discovery docs confuse newcomers ([#3735](https://github.com/earendil-works/pi/discussions/3735)). Extensions run with full process permissions.
- No built-in file undo, background processes, todo or web.
- PRs and issues from new contributors are auto-closed and reviewed later ([README](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/README.md)).
- Node runtime cost on long sessions and large writes (above).
- The "no MCP" stance was reversed, so some of the published minimalism arguments now describe an older Pi.

---

## 4. Pi-Bolt (opensec-git/Pi-Bolt 1.2.x)

### 4.1 What it is
Pi-Bolt is an independent fork of Pi, compiled ahead of time to a single native executable. It needs no Node, Bun or npm at run time ([README](https://github.com/opensec-git/Pi-Bolt), [ARCHITECTURE.md](https://github.com/opensec-git/Pi-Bolt/blob/pi-bolt/docs/ARCHITECTURE.md)). The pipeline:
1. Bun bundles Pi into JavaScriptCore bytecode.
2. An AOT compiler lowers every function to x86-64 or ARM64 machine code through **B3**, the back end of JSC's top-tier JIT (built on oven-sh/WebKit#743 and ported to x86-64 and macOS).
3. A **prebuilt heap** with Pi's modules already loaded is mmapped from the executable, so nothing is parsed or compiled at launch.
4. A training profile orders code pages so that startup touches as few as possible.

The default build has **no JIT**: Pi code is AOT machine code, and code loaded at run time (extensions, `eval`) is interpreted. The `-jit` build adds tiering for runtime code. Pi's code stays AOT, and the JIT build is within about 5% of the default. Each binary is stamped for one Pi version and one engine.

### 4.2 Compatibility
- Same commands, sessions, settings and providers as Pi. It uses `~/.pi/agent` as is and installs as `pi-bolt` alongside `pi`.
- "Every Pi extension works unchanged." Heavy extensions should use `pi-bolt compile` (compiles the installed extensions into the binary on Linux/macOS) or the JIT build. Extensions using `bun:ffi` need the JIT build, and the default build prints the command to switch.
- `piBolt.packages` extends or excludes entries from Pi's shared package list (`-npm:…`).
- Correctness gates: `e2e_tools.py` checks every Pi tool's output and files are byte-identical to stock Bun. TUI checks compare screens line by line and colour by colour. AOT fuzzing runs. 4,779 of 4,786 JSC stress tests behave the same; the 7 that differ inspect JIT internals ([BENCHMARKS.md § Correctness](https://github.com/opensec-git/Pi-Bolt/blob/pi-bolt/docs/BENCHMARKS.md)).

### 4.3 Added features over Pi
- `--acp` runs it as an Agent Client Protocol agent in Zed, JetBrains, VS Code, Neovim and others.
- `--mcp` runs it **as an MCP server**, so other agents (e.g. Claude Code) can give it a task through a `prompt` tool and continue the session in later calls.
- **In-process `grep`/`find` on by default**, following .gitignore with nothing to install. They are replaced by FFF's tools when `pi-fff` is loaded and can be disabled with `"defaultTools": ["-grep","-find"]`.
- The installer verifies the release signature and offers `opensec-pi-subagents` (separate-session agents, parallel workflows, scheduled jobs), `opensec-pi-todo` (live todo panel) and `opensec-pi-fff`.
- `pi-bolt doctor` prints a redacted diagnostics report. `pi-bolt update [--rollback|--channel beta]` and opt-in background auto-update (at most daily; `PIBOLT_NO_AUTO_UPDATE=1`).
- Herdr pane integration: state reporting plus session restore on restart.

### 4.4 Incremental parsing and rendering
These Pi-Bolt changes to Pi's code explain most of its streaming and large-write gains ([BENCHMARKS.md § In a real terminal](https://github.com/opensec-git/Pi-Bolt/blob/pi-bolt/docs/BENCHMARKS.md)):
- **Markdown:** Pi rebuilds a component that re-lexes, re-renders, re-wraps and re-highlights the whole answer on every few words. Pi-Bolt keeps the lexed and rendered blocks and redoes **only the last two blocks**, because a block's end depends on the following line. Highlighted code is cached by language and text. Output is verified identical.
- **Streaming tool-call arguments:** Pi re-parses all partial JSON each time characters arrive. Pi-Bolt re-parses only when the arguments have **grown by one eighth**, then fully at completion. This turns a quadratic cost into a roughly linear one.
- **Write previews:** Pi highlights every line of a file being written, and all of it again on each redraw. Pi-Bolt highlights only the lines a collapsed call shows, and the rest on expand.
- Frame cost is claimed to be about flat from 0 to 4,000 messages.

### 4.5 Performance claims
Pi-Bolt 1.0.0 vs Pi 1.4.0 as released, Linux x86-64 pinned to one CPU ([README benchmarks](https://github.com/opensec-git/Pi-Bolt)):

| Metric | Pi-Bolt | Pi on Bun | Pi on Node 24 |
|---|---:|---:|---:|
| Ready to type | 41 ms | 366 ms | 423 ms |
| Write 400 KB file via tool call | 1.2 s | 194.8 s | 143.7 s |
| CPU, stream 60k-char answer | 2.34 s | 21.92 s | 18.62 s |
| CPU per prompt (prompts 21–40) | 46 ms | 328 ms | 352 ms |
| CPU, interactive session | 167 ms | 1,087 ms | 1,180 ms |
| Memory after 40 prompts | 117 MB | 309 MB | 521 MB |

The headline claims are 10× faster to start, 7× less CPU and 4.5× less memory (from the Linux table above). macOS M5 results: ready-to-type 24 ms vs 151 ms on Node, and memory after 40 prompts 89 MB vs 1,363 MB. Windows x64: 78 ms vs 363 ms. Pi-Bolt 1.2.0 cut "typical home" startup instructions by a further 40% compared with 1.1.7. Pi-Bolt also benchmarks itself against PiG (Go port) and oh-my-pi. The tables use a scripted local model, so they measure harness overhead only. With a real hosted model, wall time is dominated by the model. Those real-model figures were last taken on 0.6.1.

### 4.6 Platforms
Linux x86-64 (AVX2 and baseline; glibc ≥ 2.17 or musl/Alpine ≥ 3.23), Linux ARM64 (Raspberry Pi 3+, Graviton), **Android 7+ in Termux** (the installer installs Termux glibc and sets the loader), macOS 13+ on Apple silicon (no Intel Mac), and Windows 10 1809+/11 x64 (compiled code on AVX2, bytecode otherwise). Windows ARM64 runs the x64 build under emulation. Install via curl/PowerShell, Homebrew, Scoop, mise, npm, Bun or AUR.

### 4.7 Weaknesses
- Tied to one Pi version per build, so it lags upstream releases.
- Runtime-loaded extensions are slow on the default build: an extension hot loop took 1,315 ms interpreted vs 55 ms compiled in.
- No Intel Mac build. No type feedback for AOT code (no speculative specialization). Young project with about 800 stars.
- Benchmarks are self-published, and the OpenCode comparison is against a competitor.
- Inherits all of Pi's safety posture.

---

## 5. Comparison matrix

| Capability | OpenCode 2.2 | Aider 0.86 | Pi 1.5 | Pi-Bolt 1.2 |
|---|---|---|---|---|
| Edit mechanism | Tool `edit` (oldString/newString, replaceAll); `patch` envelope for GPT only; `write` | Text formats: whole / diff (SEARCH/REPLACE) / diff-fenced / udiff / patch / editor-*; per-model default | Tool `edit` with `edits[]` multi-block, unique and non-overlapping; `write` | Same as Pi |
| Fuzzy match | Quotes/dashes/spaces, then trailing-WS; whitespace-vote hints | Whitespace/indent and `...` tolerance | NFKC + quotes/dashes/spaces + trailing-WS | Same as Pi |
| Stale-file detection | Not in V2 | Re-sends files each turn; commits dirty files first | No (mutation queue only) | No |
| Read limits | 2,000 lines / 50 KiB / 2,000-char lines; PDF and images | Whole files in chat | 2,000 lines / 50 KB; images | Same |
| Search tools | `grep`, `glob` (100 results, 30 s) | Repo map only | `grep`/`find`/`ls` off by default | `grep`/`find` on by default, in-process |
| Shell | 2 min default timeout, `background`, auto-background, managed full output | User-confirmed `/run`, `/test`; no loop | No default timeout, no background (use tmux), 50 KB / 2,000-line truncation | Same as Pi |
| Web | `webfetch` + `websearch` | `/web` scrape | Extension | Extension |
| Todo / plan | Todo behind flag; `plan` agent | `ask` / `architect` modes | Extensions (`plan-mode/`, todo) | `opensec-pi-todo` offered |
| LSP | Removed in V2 (V1 had about 30 servers) | No | No (extensions) | No |
| Repo map | No | Tree-sitter + PageRank, 1k-token budget | No | No |
| Code mode | `execute` (JS, catalog, `fetch`) | No | `codemode` (QuickJS, BM25 tool search, store, non-LLM models) | Same |
| Subagents | Built-in, always async, resumable by sessionID, depth 1 | No | Example extension / self-spawn via bash | `opensec-pi-subagents` offered |
| Architect / editor split | No (agents per model) | Yes | Virtual-model router extension | Same |
| Headless | `run --standalone`, HTTP API, `@opencode/client`, ACP | `--message`, `--yes`, unofficial Python API | `-p`, JSON stream, RPC, TS SDK | Same + `--acp`, `--mcp` server |
| Compaction | Auto, keep 15k, cache-reusing summary, checkpoint updates | Weak-model history summary | Auto at window − 16k, keep 20k, iterative structured summary, one overflow retry, pluggable | Same |
| Memory files | AGENTS.md hierarchy, skills, references | `--read` conventions | AGENTS/CLAUDE.md, SYSTEM.md, skills | Same |
| Undo | Per-step git snapshots; `/undo` `/redo` restore files + prompt | Git `/undo` of aider commit | Conversation tree only; git-checkpoint extension | Same |
| Session structure | Server DB; `/btw` side questions | Linear chat history file | JSONL tree, `/tree` `/fork` `/clone`, branch summaries, `context_edit` | Same |
| Prompt-cache care | Opt-in warming at 90% TTL | `--cache-prompts` ordering + keepalive pings | Cost-gated warming (≥ $0.05), append-only MCP updates, miss notices | Same |
| System prompt size | Large, per-model | Medium (format-specific) | Under 1k tokens incl. tools (Nov 2025 claim) | Same |
| Approvals | Ordered allow/ask/deny rules, last wins; permissive build defaults | Confirms shell/file-add; `--yes-always` | None (YOLO); project trust for resource loading | Same |
| Sandbox | None (Docker image) | None | None in core; gondolin micro-VM example; container docs | Same |
| Plugins / extensions | npm plugins with server/TUI/GUI/RPC parts, transforms | None | In-process TS extensions (about 40 events), packages, skills, templates, themes | Same + `pi-bolt compile` |
| MCP | Yes, Code Mode by default | No | Yes, codemode/deferred/direct/hidden per tool | Same + acts as MCP server |
| Hooks | Plugin transforms + runtime hooks | Lint/test commands, git hooks optional | `tool_call`, `context`, `before_provider_request`, etc. | Same |
| UI | Full-screen TUI, mini UI, Desktop, web, ACP; shared background server | Line REPL, browser GUI, watch-mode AI comments | pi-tui differential renderer in native scrollback | Same, with incremental Markdown and arg parsing |
| Model switch mid-session | Ctrl+X M, F2 recent | `/model`, `/editor-model`, `/weak-model` | `/model`, scoped cycling, `/thinking`, cross-provider handoff | Same |
| Providers | Many + Zen/Go/Console | LiteLLM (dozens) | Many + subscription logins, llama.cpp | Same |
| Cost display | `opencode stats` | After every message | Footer + `/session` | Same |
| Git integration | Snapshots, worktree tools | Auto-commit every edit, dirty-commit, attribution | Extensions | Same |
| Startup (Linux) | ≈ 1.7 s | Seconds (Python), unmeasured | ≈ 0.42 s (Node) | ≈ 0.04 s |
| Memory, long session | 273–408 MB | n/a | 521 MB (Node) | 117 MB |
| Published task results | TB2 51.7% (Opus 4.5) | Polyglot leaderboard (88% gpt-5 high) | TB2 self-reported #2 (Opus 4.5, Dec 2025) | None (same agent as Pi) |
| Platforms | macOS/Linux/Windows; Desktop | Python anywhere | Node 22.19+ anywhere; Termux | Native: Linux x64/ARM64, Termux, macOS arm64, Windows x64 |

---

## 6. Ideas worth stealing (15)

1. **Per-model edit tool shaping (OpenCode `patch` for GPT only; Aider per-model edit format).** Models are trained on different edit grammars. Aider's polyglot table shows format choice per model, and the hashline experiments suggest the harness format can swing weak models by tens of points. Ship a format registry keyed by model family.
2. **Hash-anchored or verified edits (oh-my-pi hashline).** Addressing lines by a short content hash removes whitespace-reproduction failures and gives stale-file detection at no extra cost, since a hash mismatch means the file changed. The reported effect is +15 points on average.
3. **Code mode with deferred tool discovery (Pi `codemode` + BM25 `searchTools`; OpenCode `execute`).** Tools are not declared up front. The model scripts calls in a sandbox and only the script output enters context. This answers MCP context bloat (13.7k–18k tokens per big server) without dropping MCP.
4. **Per-tool MCP exposure levels (Pi: codemode / deferred / direct / hidden with glob `toolExposure`).** Users can make `search_code` direct, `get_*` scriptable and `delete_*` unreachable. Context cost and safety are controlled per tool.
5. **Cache-preserving context mutation (Pi appends MCP summary changes instead of editing declarations; OpenCode compaction reuses the request's cache).** Prompt-cache hits are the main cost lever on long sessions, so design every context change as append-only.
6. **Cost-gated cache warming (Pi warms only when estimated savings ≥ $0.05; OpenCode warms at 90% TTL).** Keep-alive pings cost money. Pi's version decides from expected value.
7. **Session tree with `context_edit` entries and branch summaries (Pi).** Users can branch without losing work, drop a noisy tool result from *future* context without rewriting history, and carry a summary of an abandoned branch. History stays auditable.
8. **Per-step git snapshots with combined conversation+file undo, and the prompt restored for editing (OpenCode `/undo` `/redo`).** "Undo and rephrase" becomes one action.
9. **Repo map with graph ranking under a token budget (Aider).** A cheap structural overview that grows when no files are in context. Useful as a first-turn primer and for weaker models.
10. **Architect/editor model split (Aider), generalised as virtual models (Pi).** A strong reasoner plans and a cheap model emits the edits. Pi makes it a user-selectable "model" that routes each request.
11. **Always-async subagents that report on idle and can be resumed by session ID (OpenCode).** The parent keeps working, and the child can be sent follow-ups. This removes the black-box, one-shot problem Pi criticises.
12. **Incremental streaming render and partial-JSON parsing (Pi-Bolt: re-lex only the last two Markdown blocks; re-parse args only after 1/8 growth; lazy highlighting).** Writing a 400 KB file dropped from 143.7 s to 1.2 s. Any TUI that streams long tool args or answers has this quadratic cost.
13. **Differential rendering into native scrollback with synchronized output (pi-tui).** No flicker, and the terminal's own scroll and search keep working.
14. **Agent as a server for other agents (Pi-Bolt `--mcp` and `--acp`; OpenCode shared background server with paired clients).** One engine serves TUI, editor, web and other agents.
15. **Lint/test-after-edit feedback loop (Aider `--auto-lint` / `--auto-test`) as a cheap stand-in for LSP diagnostics.** OpenCode V2 users complained when LSP diagnostics disappeared. A configurable post-edit check command that feeds failures back keeps most of the value at a fraction of the runtime cost.

Honourable mentions:
- Project-trust gating of executable project resources (Pi).
- `/btw` side questions that stay out of history (OpenCode).
- Watch-mode `AI!` comments from any editor (Aider).
- Steering vs follow-up message queues (Pi).
- `doctor` command with redacted output (Pi-Bolt).

---

## 7. The minimalism argument

### Pi's case
Sources: [Zechner, Nov 2025](https://mariozechner.at/posts/2025-11-30-pi-coding-agent/), [Pi README](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/README.md).
1. **Tool count.** Four tools (read, write, edit, bash) are enough. Frontier models are RL-trained on agentic coding and already know these shapes, and bash covers everything else. Pi argues that Claude Code- and OpenCode-style tool suites mostly re-describe what bash already does.
2. **Prompt size.** Under 1k tokens for system prompt plus tools, against around 10k elsewhere. Pi argues a long prompt adds little to a model that already knows the job, and costs tokens on every request.
3. **Model confusion and stability.** Harnesses that change their prompt and tools every release change model behaviour and break workflows. A small, stable surface is predictable.
4. **Observability.** Built-in subagents and plan mode hide work: you cannot see what a subagent read. Planning to a file the user can see, and self-spawning in tmux, keep everything inspectable. Using parallel subagents to implement features is called an anti-pattern.
5. **Context cost.** MCP servers can dump 13.7k–18k tokens of tool schemas (7–9% of the window) into every session. CLIs with READMEs give progressive disclosure.
6. **Safety theatre.** Permission prompts don't stop prompt injection once a model can read data, run code and reach the network. Real safety is OS isolation, so Pi skips the prompts.
7. **Extensibility instead of features.** Ship primitives (events, tools, UI) and let users or the agent build plan mode, todos and subagents as packages.

### Evidence for
- **Terminal-Bench 2.0:** Terminus 2, which only gives the model a tmux session, scored 57.8% with Opus 4.5, ahead of Claude Code (52.1%), OpenHands (51.9%) and OpenCode (51.7%) on the same model ([tbench snapshot](https://web.archive.org/web/20260410072937/https:/www.tbench.ai/leaderboard/terminal-bench/2.0)). Pi self-reported 2nd place in Dec 2025. With a fixed model, a heavier harness did not buy score.
- **Cost and latency:** a small prompt saves tokens on every request. Pi-Bolt's measurements show OpenCode's feature-heavy runtime spends about 0.4–0.7 s CPU per prompt and 400 MB, against 46 ms and 117 MB for a lean harness. Its requests were also larger (19.1 MB vs 16.9 MB at prompt 75).
- **Stability:** OpenCode V2's rewrite broke plugins, the API and config, and removed LSP and default todos. That is the churn Pi warns about. OpenCode's always-on server is also where its RCE CVEs came from, a larger attack surface.
- **Ecosystem uptake:** more than 2,100 community packages and OpenClaw built on the SDK suggest primitives plus packages scale.

### Evidence against / caveats
- **Pi itself moved toward breadth where it mattered.** It added MCP, codemode, tool_search, project trust and virtual models. The way it added them is the lesson: breadth arrives *deferred*, not declared, so the prompt stays small while capability grows.
- **Harness details move scores a lot.** The hashline result (+15 points on average, 6.7% to 68.3% for one model) and Aider's per-model format table show that *better* tools, not *fewer* tools, are what count. A minimal edit tool can be a weak one.
- **Some breadth has measurable value.** Aider's repo map and architect mode (o3 + gpt-4.1 at 78.2% for $17.55 vs o3-pro at 84.9% for $146) show cost-quality trade-offs that four tools don't cover. OpenCode users pushed back on losing LSP diagnostics. Lint/test feedback loops catch errors before the model's next turn.
- **Safety:** YOLO-only blocks adoption in teams. Pi's own community asked for a core safety mode. Most users don't sandbox, so "use a VM" protects few people in practice.
- **Benchmarks are thin.** Pi's TB2 result is self-reported and absent from the later official snapshot. Leaderboard noise is about ±2.5 points. Leading TB2 entries in 2026 (ForgeCode, Pilot, Droid around 77–83%) are often tuned harnesses, so engineering effort helps at the top end even if raw tool count doesn't.
- **Minimal core shifts the work to users.** The reviews call Pi "a harness you finish yourself", and new users report confusion over extension installation.

### Takeaways for a feature-rich CLI
- **Breadth helps when it is *deferred*:** discoverable via search or code mode, loaded on demand (skills, MCP, rare tools), and kept out of the per-request prompt. It hurts when every capability is a declared tool with a long description on every turn.
- **Spend on tool quality, not tool count:** per-model edit formats, verified or hash-anchored edits, post-edit lint/test feedback, good truncation with full-output files.
- **Keep the declared core small and stable across releases**, and version prompt and tool changes as deliberately as API changes. Behaviour drift is a real cost to users.
- **Make orchestration observable:** async subagents with visible transcripts, plans written to files, a session tree. Users then get the benefit of subagents without the black box Pi objects to.
- **Measure harness overhead:** startup, CPU per prompt, quadratic streaming costs. Pi-Bolt shows these can be 10–100× and are mostly fixable in user-space code, without dropping features.
- **Offer safety as an opt-in, cheap layer** (ordered allow/ask/deny rules like OpenCode, tool annotations like Pi) with an honest statement that only isolation is a boundary.
