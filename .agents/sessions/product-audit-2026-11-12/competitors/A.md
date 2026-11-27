# Competitor feature audit A: Claude Code, Codex CLI, Gemini CLI, Kiro CLI

Snapshot date: 2026-11-12. Everything below is paraphrased from official docs, repos, and changelogs unless marked as a secondary source. Version numbers are the newest ones seen during research:

| CLI | Version seen | Source |
| --- | --- | --- |
| Claude Code | 2.1.322 (2026-11-10) | [changelog](https://code.claude.com/docs/en/changelog) |
| OpenAI Codex CLI | 0.167.2 stable, 0.170.0 alphas | [GitHub releases](https://github.com/openai/codex/releases) |
| Gemini CLI | v0.64.0 stable (2026-10-13), v0.65 preview, v0.66 reported | [latest](https://geminicli.com/docs/changelogs/latest/), [releasebot](https://releasebot.io/updates/google/gemini-cli) |
| Kiro CLI | 3.2.1 (2026-11-11), V3 harness default since 3.0.0 | [CLI changelog](https://kiro.dev/changelog/cli/) |

Two market events affect how to read this audit:

- **Gemini CLI lost its consumer audience.** Since 2026-06-18 it no longer serves free, Google AI Pro, or Ultra individual accounts. It still works for paid API keys, Vertex, and Code Assist Standard/Enterprise. Google moved consumers to a separate "Antigravity CLI" (`agy`) ([official discussion #27274](https://github.com/google-gemini/gemini-cli/discussions/27274), [#28017](https://github.com/google-gemini/gemini-cli/discussions/28017)). The open-source repo still ships weekly releases.
- **Kiro CLI rebuilt itself on a shared harness.** 3.0.0 made the V3 "unified agent harness" (the same one Kiro IDE and Web use) the default, removed the Classic UI and the desktop app, and shipped as a single `kiro-cli` binary ([changelog](https://kiro.dev/changelog/cli/), [V3 upgrade page](https://kiro.dev/docs/cli/v3/)).

Caveat: these products ship several times a week. Claude Code's GitHub CHANGELOG had headings for 427 versions as of 2026-10-21 ([secondary source](https://hidekazu-konishi.com/entry/claude_code_version_history_and_timeline.html)). Treat limits and defaults as point-in-time values.

---

## 1. Claude Code (Anthropic)

### 1.1 Built-in tools
Primary source for this section: [tools reference](https://code.claude.com/docs/en/tools-reference).

- **Read**
  - Returns text with line numbers and takes `offset`/`limit`.
  - Caps: 25k tokens per call by default (`CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS`). A whole-file read over 256 KB is refused. Reads that run over the cap return a `PARTIAL view` notice that explains how to page.
  - v2.1.296 added `allow_large: true` for one-shot large reads.
  - Images (PNG/JPEG/GIF/WebP) are auto-downscaled, and anything over 128 MB is refused.
  - PDFs: files over 10 pages are read through a `pages` range, up to 20 pages per call. This needs `pdftoppm` from poppler.
  - `.ipynb` notebooks return cells plus outputs. Notebooks over 256 KB of cells are an error, and files over 100 MB are refused.
  - Binary extensions (xlsx, parquet, zip) are refused. The error points the model at a skill or a shell command instead.
- **Write.** Overwrites a file. It refuses content that contains U+FFFD, so the model cannot write back garbled bytes it read from a non-UTF-8 file.
- **Edit**
  - Exact `old_string`→`new_string` replacement. No regex and no fuzzy matching.
  - `old_string` must be unique unless `replace_all: true` is set.
  - Read-before-edit is enforced. Newer models may skip the read when it wouldn't prompt. Viewing a file with `cat`/`sed -n`/`rg` through Bash also counts as a read.
  - Stale-file handling: if the file changed on disk since the last read, the edit still applies when `old_string` matches the current content exactly. The result then flags the other changes so the model re-reads.
  - Non-UTF-8 files are refused, except UTF-16LE with a BOM.
  - There is no multi-edit tool in the current table (MultiEdit no longer appears). `NotebookEdit` handles notebook cells.
- **Search**
  - On macOS, Linux, and WSL, `Glob` and `Grep` are **absent by default**. The model runs `find`/`grep` through Bash, and Claude Code backs those commands with embedded `bfs` and `ugrep`. Glob and Grep come back when Bash is removed or when you list them explicitly.
  - Grep is built on ripgrep. It has three output modes (`files_with_matches`, `content`, `count`), plus `glob`/`type` filters, `multiline`, and `head_limit`/`offset`.
  - Glob results are sorted by mtime and capped at 100, and Glob ignores `.gitignore` by default.
  - There is no built-in semantic search.
- **Bash**
  - Each call runs in a separate process. `cd` persists inside the project, and env vars don't persist; `CLAUDE_ENV_FILE` or a SessionStart hook can fix that.
  - Timeouts: 2 min by default (`BASH_DEFAULT_TIMEOUT_MS`) and 10 min max.
  - Output: about 30k chars inline. Larger output is saved to a file with a 2k-char preview. Failures get a head/tail excerpt of about 10k. The read-back window goes up to 150k (`BASH_MAX_OUTPUT_LENGTH`) and the inline window up to 128k (`bashOutputMaxChars`).
  - `run_in_background: true` starts a background task, listed with `/tasks`. Unattended runs (`-p`, SDK, CI) put a time limit on background commands.
  - Other shell tools: a native `PowerShell` tool, and `Monitor`, which streams each output line of a background command (or each WebSocket message) back to the model as an event.
- **WebFetch**
  - Converts the page to Markdown, then runs a *secondary model call* with the user's extraction prompt, so results are lossy by design.
  - Limits: 100k chars per call, a 15-minute cache, and a 5-minute deadline.
  - Refuses localhost and dotless hostnames. Cross-host redirects are returned rather than followed.
  - Ships a preapproved set of docs domains.
- **WebSearch.** Built in.
- **Task tracking.** `TaskCreate/TaskGet/TaskList/TaskUpdate` (with dependencies) replaced `TodoWrite`, which is disabled by default.
- **LSP tool.** Covers definition, references, hover/type, document and workspace symbols, implementations, and call hierarchy. It also reports diagnostics automatically after each edit. It only activates after you install a code-intelligence plugin for the language.
- **Other notable tools:**
  - `AskUserQuestion` (multiple choice)
  - `EnterPlanMode`/`ExitPlanMode`
  - `EnterWorktree`/`ExitWorktree`
  - `CronCreate/List/Delete` (session-scoped scheduled prompts)
  - `ScheduleWakeup` (self-paced `/loop`)
  - `Workflow` (script-driven fan-out of many subagents)
  - `SendMessage`/`ListAgents` (cross-session messaging)
  - `ToolSearch` (deferred MCP tool loading)
  - `PushNotification`
  - `Artifact`
  - `ReportFindings` (structured code-review output)

### 1.2 Orchestration
- **Subagents** ([docs](https://code.claude.com/docs/en/sub-agents))
  - Definition format: Markdown plus YAML frontmatter in `.claude/agents/` or `~/.claude/agents/`, scanned recursively. Precedence order: managed, `--agents` JSON, project, user, plugin.
  - Frontmatter fields: `name`, `description`, `tools`, `disallowedTools`, `model` (`sonnet`/`opus`/`haiku`/`fable`/full ID/`inherit`), `permissionMode`, `maxTurns`, `autoCompactWindow`, `skills` (preloaded), `mcpServers` (inline or by reference), `hooks`, `memory` (`user`/`project`/`local` persistent memory), `background`, `isolation: worktree`, `omitClaudeMd`, `effort`, `initialPrompt`.
  - Each subagent has its own context, and only its final result returns to the parent.
  - Built-in subagents: Explore (read-only, with quick/medium/very-thorough levels), Plan, and general-purpose.
  - Subagents run **in the background by default**, and their permission prompts surface in the main session.
  - Fork mode inherits the whole parent conversation. Hitting `maxTurns` returns a partial result that the parent can resume.
- **Beyond subagents** ([overview](https://code.claude.com/docs/en/agents)):
  - **Agent teams**: coordinated sessions with shared tasks and messaging.
  - **Agent view**: dispatch and monitor many background sessions.
  - **Dynamic workflows**: rerunnable scripts that orchestrate subagents.
  - **Projects**: parallel cloud sessions.
  - **Cloud scheduled tasks**: formerly "routines".
  - **Remote Control**: continue a local session from a phone.
- **Plan mode.** Read-only exploration plus classifier-approved commands. The plan is approved through `ExitPlanMode`.
- **Headless and SDK.** `claude -p` with JSON or stream-JSON output, plus the Agent SDK for TypeScript and Python ([headless](https://code.claude.com/docs/en/headless)). GitHub Actions integration also exists.

### 1.3 Context management
- **Auto-compact and `/compact`.** There is a per-model auto-compact window ([model config](https://code.claude.com/docs/en/model-config)), which subagents can override with `autoCompactWindow`. PreCompact/PostCompact hooks run around it.
- **Memory** ([memory](https://code.claude.com/docs/en/memory)). Hierarchical `CLAUDE.md`, and **AGENTS.md is also accepted**. Path-scoped `.claude/rules/*.md` files load lazily when a matching file is read, and **auto memory** collects learnings across sessions.
- **Checkpoints** ([checkpointing](https://code.claude.com/docs/en/checkpointing))
  - Every prompt that starts a turn snapshots the files touched by the edit tools. The last 100 checkpoints are kept and survive `--resume`. Snapshots are swept after about 30 days.
  - `/rewind` (or double Esc) offers: restore code+conversation, conversation only, or code only. It can also **summarize from here** or **summarize up to here**, which is targeted partial compaction.
  - Changes made through Bash are not tracked.
- **Sessions.** `--resume`, `--continue`, fork, and cross-device Remote Control. Fork mode exists for subagents.
- **Prompt caching** is managed automatically. The docs explain that switching models costs an uncached turn and what `/compact` costs ([prompt caching](https://code.claude.com/docs/en/prompt-caching)).

### 1.4 Safety and permissions
- **Modes** ([permission modes](https://code.claude.com/docs/en/permission-modes)): `default`/Manual, `acceptEdits`, `plan`, `auto`, `dontAsk`, and `bypassPermissions`.
  - `auto` uses a classifier model to review actions instead of the user. It has been the default starting mode for interactive sessions since v2.1.283.
  - `dontAsk` is for CI: anything that would prompt is denied.
  - Deny rules apply in every mode, including bypass. Protected paths have per-mode rules.
- **Rules.** Allow/ask/deny rules such as `Bash(git push *)`, `WebFetch(domain:x)`, and `Read(...)`, plus managed and enterprise settings.
- **Sandbox** ([sandboxing](https://code.claude.com/docs/en/sandboxing))
  - Opt-in (`/sandbox`). Built on the open-source [`@anthropic-ai/sandbox-runtime`](https://github.com/anthropics/sandbox-runtime), which uses bubblewrap on Linux and Seatbelt on macOS. Native Windows has no sandbox.
  - Covers Bash, PowerShell, and Monitor commands and their children. File tools, MCP servers, and hooks run outside it.
  - Writes are limited to the working directory and temp. Reads are open by default.
  - Network goes through a local proxy with a domain allowlist that starts empty.
  - Experimental credential masking swaps real secrets in at the proxy ([riptides comparison](https://riptides.io/blog/ai-coding-agent-sandboxes-compared/)).

### 1.5 Extensibility
- **MCP.** stdio and HTTP with OAuth, MCP resources, tool search for deferred loading, `WaitForMcpServers`, and "channels" that push events into a running session ([mcp](https://code.claude.com/docs/en/mcp), [channels](https://code.claude.com/docs/en/channels)).
- **Hooks** ([hooks](https://code.claude.com/docs/en/hooks))
  - About 28 events: `SessionStart`, `Setup`, `UserPromptSubmit`, `UserPromptExpansion`, `PreToolUse`, `PermissionRequest`, `PermissionDenied` (which can tell the model to retry), `PostToolUse`, `PostToolUseFailure`, `PostToolBatch`, `Notification`, `MessageDisplay`, `SubagentStart/Stop`, `TaskCreated/Completed`, `Stop`, `StopFailure`, `TeammateIdle`, `InstructionsLoaded`, `ConfigChange`, `CwdChanged`, `DirectoryAdded`, `FileChanged`, `WorktreeCreate/Remove`, `PreCompact`, `PostCompact`.
  - Hook types include command, HTTP, prompt, and MCP-tool hooks. Async hooks are supported.
- **Skills and slash commands.** Custom commands were folded into skills, and bundled skills ship with the CLI ([skills](https://code.claude.com/docs/en/skills)).
- **Plugins and marketplaces.** Plugins bundle agents, skills, hooks, MCP, and LSP. Managed marketplaces are supported. **Mods** add panes, commands, and tool-call rules ([mods](https://code.claude.com/docs/en/plugins/mods/overview)).
- **Output styles.** Built-ins such as Concise and Explanatory, plus custom styles ([output styles](https://code.claude.com/docs/en/output-styles)).

### 1.6 UX
- Customizable status line, showing context, cost, and git ([statusline](https://code.claude.com/docs/en/statusline)).
- `@`-mentions of files, agents, and `file:line`. Image paste. Vim mode. Configurable keybindings and terminal setup ([terminal config](https://code.claude.com/docs/en/terminal-config)).
- `/fast` fast mode ([fast mode](https://code.claude.com/docs/en/fast-mode)) and effort levels.
- IDE extensions for VS Code (inline diffs, plan review) and JetBrains. Also a Desktop app, web, and mobile.
- Cost and usage display through `/usage`, plus OpenTelemetry ([monitoring](https://code.claude.com/docs/en/monitoring-usage)).
- **Providers.** Claude models only, served by Anthropic API, Bedrock, Vertex, Microsoft Foundry, or Claude Platform on AWS. LLM gateways via `ANTHROPIC_BASE_URL` ([llm gateway](https://code.claude.com/docs/en/llm-gateway)). There is no first-class support for non-Claude models.

### 1.7 Reliability
- WebFetch extraction retries with backoff when the API is overloaded.
- `StopFailure` hook on API errors.
- Worktree isolation for sessions and subagents, with command-text checks that keep git inside the worktree.
- `/doctor` checks the setup.
- OpenTelemetry metrics and events.
- No auto-commit by default.

### 1.8 Weaknesses and complaints
- **Usage limits drain unpredictably.** This is the dominant complaint. Examples:
  - The March 2026 drain ([#38335](https://github.com/anthropics/claude-code/issues/38335), [#41930](https://github.com/anthropics/claude-code/issues/41930)).
  - A Max 20x weekly limit gone in 2–2.5 days after a "fix" ([#65678](https://github.com/anthropics/claude-code/issues/65678)).
  - Renewed reports in Oct–Nov 2026 ([#108534](https://github.com/anthropics/claude-code/issues/108534), [#107390](https://github.com/anthropics/claude-code/issues/107390)).
- **Locked to one model vendor.**
- **Sandbox gaps.** The sandbox is off by default, reads are open, and MCP servers and file tools run outside it ([riptides](https://riptides.io/blog/ai-coding-agent-sandboxes-compared/)).
- **Lossy WebFetch.** The secondary-model extraction can falsely report that a page doesn't mention something.
- **Fast churn.** Many breaking changes to scripts, hooks, and settings in 2026 ([secondary tracker](https://developertoolkit.ai/en/claude-code/reference/changelog/)).

---

## 2. OpenAI Codex CLI

Rust implementation, about 95% Rust, with sub-50 ms startup ([secondary](https://ai.miraheze.org/wiki/Codex_CLI)). Docs moved to `learn.chatgpt.com` ([CLI overview](https://learn.chatgpt.com/docs/codex/cli), [config reference](https://learn.chatgpt.com/docs/config-file/config-reference)).

### 2.1 Built-in tools
- **Read and search.** There is no dedicated read or grep tool. The model reads with shell commands (`cat`, `sed -n`, `rg`).
  - `view_image` (`features.view_image`) lets the model look at images. Users attach images with `-i/--image` or by pasting.
  - Per-tool output stored in history is capped by `tool_output_token_limit` ([config ref](https://learn.chatgpt.com/docs/config-file/config-reference)).
- **Edit: `apply_patch`.** A custom patch envelope (`*** Begin Patch` / `*** Update File` / context hunks). One call can add, delete, or update **multiple files**, so multi-file edits are atomic per call. Small models do poorly with this format ([third-party note](https://github.com/raullenchai/Rapid-MLX/blob/main/docs/guides/codex-cli.md)). Patches are also sandboxed ([riptides](https://riptides.io/blog/ai-coding-agent-sandboxes-compared/)).
- **Shell.**
  - `features.unified_exec` provides a PTY-backed exec. The model polls background terminals with `write_stdin` and `background_terminal_max_timeout`, so interactive and long-running processes work.
  - `features.shell_snapshot` snapshots the user's shell environment.
  - `shell_environment_policy` filters which env vars reach commands. KEY/SECRET/TOKEN vars pass by default unless filtered.
- **Web search.** `web_search = "cached" | "indexed" | "live" | "disabled"`. The default is cached/indexed. `--search` or `--yolo` makes it live.
- **Planning.** `/plan` mode and `/goal` for long-running objectives. Goal Mode became the default in May 2026 ([secondary](https://codersera.com/blog/openai-may-2026-updates-roundup/)).
- **LSP / code intelligence.** No built-in LSP tool is documented.
- **Code mode** (`features.code_mode`). The model writes code that calls tools as nested functions.

### 2.2 Orchestration
- **Subagents** ([concept](https://developers.openai.com/codex/concepts/subagents))
  - Custom agents are TOML files in `.codex/agents/` or `~/.codex/agents/`, with required `name`, `description`, and `developer_instructions` ([secondary](https://www.issoh.co.jp/tech/details/11463/)).
  - Roles can also be declared under `[agents.<name>]` with a `config_file` layer, so each role can set its own model.
  - Concurrency cap: `agents.max_concurrent_threads_per_session`, formerly `max_threads`, default 6. Spawn depth defaults to 1.
  - Codex spawns subagents only when asked. The DevDay refresh added an `/agents` view ([secondary](https://apidog.com/blog/codex-devday-2026-updates/)).
- **Plan mode.** `/plan`.
- **Side conversations.** `/side` and `/btw` open an ephemeral fork for a quick question.
- **Headless.** `codex exec` with JSONL events, `--output-schema` to force structured final output, `-o` to write the output to a file, stdin piped in as a `<stdin>` block, and `codex exec resume|fork` ([commands guide](https://developertoolkit.ai/en/codex/build/cli-commands/)). Codex refuses to run outside a git repo unless `--skip-git-repo-check` is set.
- **SDK.** A TypeScript SDK that spawns the CLI and speaks JSONL ([README](https://github.com/openai/codex/blob/main/sdk/typescript/README.md)), and a Python SDK. `codex app-server` speaks JSON-RPC 2.0 and powers the VS Code and JetBrains integrations ([OpenAI blog](https://openai.com/index/unlocking-the-codex-harness/)). `codex mcp-server` was deprecated in Aug 2026 in favor of app-server ([secondary](https://fixit.co.jp/tips/codex-mcp-server-deprecated/)).
- **Cloud.** `codex cloud exec/list/diff/apply`, with best-of-N runs.
- **Queued messages.** `codex queue --thread <name>` adds a message to another session's queue.

### 2.3 Context management
- **Auto-compaction.** Set the threshold with `model_auto_compact_token_limit`. `..._scope = total | body_after_prefix` chooses what the threshold counts. `/compact` triggers it manually. GPT-5.x-Codex models are trained for compaction ([OpenAI](https://openai.com/index/introducing-gpt-5-2-codex/)).
- **Memory.** `AGENTS.md`, hierarchical, with `project_doc_max_bytes` and `project_doc_fallback_filenames`. `/init` creates one. `features.memories` exists and is off by default.
- **Sessions.** Every session is saved. Commands: `codex resume` (picker, `--last`, `--all`), `/rename` named threads, `codex fork` (`--worktree` puts the fork in a managed worktree), and `/archive` and `/delete`. Esc twice edits the previous message.
- **No file rewind.** No first-class file-checkpoint rewind appears in the current slash-command list; git and worktrees are the undo path ([commands guide](https://developertoolkit.ai/en/codex/build/cli-commands/)).
- **History.** `history.persistence` and `history.max_bytes`.
- **Caching.** Prompt caching is implicit on the OpenAI side. `features.enable_request_compression` compresses requests.

### 2.4 Safety and permissions
- **Approval policy.** `approval_policy = on-request | never | granular{...}`. Granular toggles cover sandbox escalation, execpolicy rules, MCP elicitations, request_permissions, and skill approval.
- **Auto-review.** `approvals_reviewer = user | auto_review` lets a model review eligible prompts. `/approve` allows one retry after an auto-review denial.
- **Sandbox modes.** `sandbox_mode = read-only | workspace-write | danger-full-access`, with `[sandbox_workspace_write] writable_roots / network_access / exclude_tmpdir`. Named `[permissions.<name>]` profiles can carry deny-read globs ([config ref](https://learn.chatgpt.com/docs/config-file/config-reference)).
- **Sandbox on by default** ([riptides](https://riptides.io/blog/ai-coding-agent-sandboxes-compared/), [lib.rs](https://github.com/openai/codex/blob/main/codex-rs/linux-sandbox/src/lib.rs)):
  - macOS uses Seatbelt.
  - Linux uses **bubblewrap plus seccomp** with `no_new_privs`. This replaced the earlier Landlock-only approach, which is still available as a legacy mode.
  - Windows has `mxc`, `elevated` (a separate sandbox user, which gave the strongest credential isolation in tests), and `unelevated`.
- **Network.** Off by default. Turning it on opens everything, unless you enable the experimental `network_proxy` domain allowlist.
- **MCP tool approvals.** `default_tools_approval_mode = auto | prompt | writes | approve`, using the MCP `destructive_hint` and `open_world_hint` annotations.
- **Execpolicy rules.** Stable allow/prompt rules for commands ([field notes](https://github.com/disbitski/real-world-ai-lab/blob/main/field-notes/2026-06-20-locking-down-permissions-with-codex-rules.md)).

### 2.5 Extensibility
- **MCP.** stdio (`command`, `args`, `cwd`) and streamable HTTP with bearer-token env vars or OAuth. `/mcp login <name>` (0.161.0) and `codex mcp add`.
- **Hooks.** In `hooks.json` or inline. Events: `PreModelRequest`, `PostModelRequest`, `PreToolUse`, `PermissionRequest`, `PostToolUse`, `PreCompact`, `PostCompact`, `SessionStart`, `SessionEnd`, `SubagentStart`, `SubagentStop`, `UserPromptSubmit`, `Stop`, `Interrupt`. A separate `notify` command receives JSON on events.
- **Skills, plugins, and apps.** `/skills`, `/plugins`, and app/connector integrations (`features.apps`). The Codex Security plugin, CLI, and SDK are one example ([security](https://learn.chatgpt.com/docs/security)).
- **Slash commands.** `/review`, `/diff`, `/status`, `/model`, `/permissions`, `/compact`, `/new`, `/fork`, `/resume`, `/rename`, `/worktree`, `/plan`, `/goal`, `/init`, `/side`, `/mcp`, `/skills`, `/plugins`, `/approve`, `/copy`, `/export`. There is no `/help`; press `?` for shortcuts.

### 2.6 UX
- Full-screen TUI refresh in Oct 2026 ([secondary](https://dev.to/yong_yu_f98e15562e9b120a0/codex-clis-big-refresh-just-landed-first-session-parallel-agents-and-why-fork-isnt-a-worktree-1i1i)).
- `@` fuzzy file search and a `!` shell prefix.
- **Enter steers the running turn, and Tab queues a message for after it.**
- `Ctrl+G` opens `$EDITOR`, `Ctrl+R` searches history, `Ctrl+T` shows the transcript, and `Alt+,`/`Alt+.` change reasoning effort.
- `/keymap` remapping, Vim composer mode (`tui.vim_mode_default`), a configurable `tui.status_line`, and syntax themes.
- Voice input. Auto recaps while the terminal is unfocused (`tui.auto_recap`).
- **Built-in code review.** `/review` or `codex review --base|--uncommitted|--commit`, with a separate `review_model`.
- **Providers.** `model_providers.<id>` defines custom providers, including a command-backed bearer token, and there are built-in Bedrock and Vertex providers. `--oss` runs local models via Ollama or LM Studio. Sign-in is via ChatGPT or API key.

### 2.7 Reliability
- Native worktree management through `--worktree`, `/worktree`, and fork-into-worktree.
- `codex doctor`.
- OpenTelemetry export (`otel.exporter` over otlp-http or otlp-grpc).
- `features.prevent_idle_sleep`.
- Sandbox denials can be retried unsandboxed after approval ([gist](https://gist.github.com/rtzll/8ec03ad8a4cca3ae43ce3db7eb7dcc09)).

### 2.8 Weaknesses and complaints
- **Permission and sandbox state drifts or is ignored.** Examples:
  - Asks for approval even when set to full access ([#29235](https://github.com/openai/codex/issues/29235)).
  - Escalation isn't requested until permissions are reselected ([#56570](https://github.com/openai/codex/issues/56570)).
  - Approved escalations still run inside the sandbox in the CLI ([#41161](https://github.com/openai/codex/issues/41161)).
  - The profile flips silently ([#23958](https://github.com/openai/codex/issues/23958)).
  - auto_review is dropped after compaction ([#23875](https://github.com/openai/codex/issues/23875)).
  - The VS Code extension ignores a read-only config ([#52809](https://github.com/openai/codex/issues/52809)).
- **Seccomp breakage on Linux.** The seccomp filter breaks sends on connected Unix sockets ([#33793](https://github.com/openai/codex/issues/33793)). bwrap crashes inside default Docker seccomp profiles ([zenn](https://zenn.dev/kanagen/articles/devcontainer-codex-seccomp-unconfined?locale=en)).
- **Network is all-or-nothing** without the experimental proxy. Env secrets pass through by default.
- **No file rewind or checkpoints.** No built-in LSP.

---

## 3. Gemini CLI (Google)

Open-source TypeScript. Docs are at [geminicli.com/docs](https://geminicli.com/docs/) and in the [repo docs](https://github.com/google-gemini/gemini-cli/tree/main/docs). There are three release channels: nightly, preview, and weekly stable.

### 3.1 Built-in tools
Primary sources: [tools reference](https://github.com/google-gemini/gemini-cli/blob/main/docs/reference/tools.md) and [file-system tools](https://github.com/google-gemini/gemini-cli/blob/main/docs/tools/file-system.md).

- **`read_file`**
  - Reads text, **images, audio, and PDF**.
  - Line range parameters: the file-system doc lists `offset`/`limit`, while the policy-engine argument table lists `start_line`/`end_line`. The docs are inconsistent.
- **`read_many_files`**
  - Takes include/exclude globs and is triggered by `@path` in the prompt.
  - v0.64 added `@file:line` references ([latest](https://geminicli.com/docs/changelogs/latest/)).
- **`write_file` and `replace`**
  - `replace` takes `file_path`, `old_string`, `new_string`, a **required `instruction`** (a semantic description of the change), and `allow_multiple`.
  - Edits are exact-match and must be unique unless `allow_multiple` is set.
  - v0.64 serialized file-tool operations and made writes atomic.
- **Search tools**
  - `glob`: mtime-sorted, respects `.gitignore` and `.geminiignore`.
  - `grep_search`: uses `git grep`, then system grep, then a JS fallback. It has rich arguments: `fixed_strings`, `context`, `before`/`after`, `names_only`, `max_matches_per_file`, and total caps.
  - `list_directory`.
- **`run_shell_command`**
  - Arguments: `command`, `description`, `dir_path`, and `is_background`.
  - With `tools.shell.enableInteractiveShell`, commands run under node-pty, so **interactive commands** such as `git rebase -i` and vim work. The user presses Tab to focus the PTY and type into it ([shell](https://github.com/google-gemini/gemini-cli/blob/main/docs/tools/shell.md)).
  - Background PIDs are reported back to the model.
- **Web.** `google_web_search` (grounded Google Search) and `web_fetch`, which validates outbound requests against private and reserved IP ranges.
- **Todos and tracking.** `write_todos`, plus an experimental **task tracker**: `tracker_create/update/get/list_task`, `tracker_add_dependency`, and `tracker_visualize`, which draws an ASCII dependency graph. `update_topic` reports progress to the user.
- **Other.** `ask_user`, `enter_plan_mode`/`exit_plan_mode`, `activate_skill`, `get_internal_docs` (answers from Gemini CLI's own docs), and `save_memory` ([memory tool](https://github.com/google-gemini/gemini-cli/blob/main/docs/tools/memory.md)).
- **LSP.** No built-in LSP tool. IDE companion integration supplies editor context.

### 3.2 Orchestration
- **Subagents** (experimental) ([subagents](https://github.com/google-gemini/gemini-cli/blob/main/docs/core/subagents.md))
  - Markdown plus YAML in `.gemini/agents/` or `~/.gemini/agents/`.
  - Fields: `name`, `description`, `kind: local|remote`, `tools` (with wildcards `*`, `mcp_*`, `mcp_<server>_*`), inline `mcpServers`, `model` (default `inherit`), `temperature`, `max_turns` (default 30), `timeout_mins` (default 10).
  - Subagents have isolated history and recursion protection. Force one with `@agent`.
  - Built-ins: Codebase Investigator, CLI Help, Generalist, and a **Browser Agent** that drives Chrome, with persistent, isolated, or existing profiles and an optional computer-use visual model.
  - **Remote subagents** work over A2A ([remote agents](https://github.com/google-gemini/gemini-cli/blob/main/docs/core/remote-agents.md)).
- **Plan mode.** `--approval-mode=plan`, a strict read-only mode. It can also run headless ([plan mode](https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/plan-mode.md)).
- **Headless.** `-p` or a non-TTY stdin. `--output-format json|stream-json` (JSONL), where the JSON output includes stats ([headless](https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/headless.md)).
- **ACP mode.** `--acp` speaks JSON-RPC over stdio, which is how editors such as Zed embed it ([acp](https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/acp-mode.md)).
- **Git worktrees** (experimental), one per session ([worktrees](https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/git-worktrees.md)).
- **No official SDK.** The `a2a-server` package exists.

### 3.3 Context management
- **Compression.** Automatic, with a `PreCompress` hook and `/compress`.
- **Memory.**
  - Hierarchical `GEMINI.md`. The context filename is configurable, so it can be `AGENTS.md`.
  - `/memory` command, `save_memory` tool, and memory import with `@file` includes ([memport](https://github.com/google-gemini/gemini-cli/blob/main/docs/reference/memport.md)).
  - **Auto Memory** (experimental) mines past session transcripts in the background. It proposes memory updates as `.patch` diffs and drafts new skills, all of which the user reviews before they take effect ([auto memory](https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/auto-memory.md)).
- **Checkpointing** ([checkpointing](https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/checkpointing.md))
  - Before each approved file-modifying tool runs, the CLI commits to a **shadow git repo** in `~/.gemini/history/<hash>`. It also stores the conversation and the pending tool call.
  - `/restore` reverts the files and **re-proposes the tool call**.
  - `/rewind` (double Esc) rewinds the conversation and optionally the files ([rewind](https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/rewind.md)).
- **Sessions.** Resume, list, and delete ([session management](https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/session-management.md)). v0.64 made chat recording append-only with bounded history windowing.
- **Token caching.** Only with an API key or Vertex. OAuth via the Code Assist API is not supported. `/stats` shows cached tokens ([token caching](https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/token-caching.md)).

### 3.4 Safety and permissions
- **Approval modes.** `default`, `autoEdit`, `plan`, `yolo`.
- **Policy engine** ([policy engine](https://github.com/google-gemini/gemini-cli/blob/main/docs/reference/policy-engine.md))
  - TOML files in `~/.gemini/policies/*.toml`.
  - Each rule has a tool name, an `argsPattern` regex over the tool's JSON arguments, optional modes, a decision (`allow`, `deny`, `ask_user`), and a priority from 0 to 999 within admin, user, and workspace tiers.
- **Trusted folders.** An untrusted folder's settings, MCP servers, and tools are restricted ([trusted folders](https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/trusted-folders.md)).
- **Sandbox** ([sandbox](https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/sandbox.md))
  - Off by default. `GEMINI_SANDBOX=true|docker|podman|sandbox-exec|runsc|lxc`.
  - macOS Seatbelt profiles default to `permissive-open`.
  - Containers: Docker or Podman, with a custom image or a `.gemini/sandbox.Dockerfile`.
  - gVisor (`runsc`) on Linux.
  - Windows native uses icacls Low Mandatory Level.
  - **The whole CLI relaunches inside the sandbox**, unlike the other three, which wrap single commands. The network is open by default ([riptides](https://riptides.io/blog/ai-coding-agent-sandboxes-compared/)).
- **Enterprise.** System settings and enterprise controls ([enterprise](https://github.com/google-gemini/gemini-cli/blob/main/docs/admin/enterprise-controls.md)).

### 3.5 Extensibility
- **MCP.** stdio, SSE, and HTTP, with OAuth. v0.66 improved MCP OAuth flows ([releasebot](https://releasebot.io/updates/google/gemini-cli)). MCP resources are exposed as tools.
- **Hooks.** Events: `SessionStart`, `SessionEnd`, `BeforeAgent`, `AfterAgent`, **`BeforeModel`, `AfterModel`, `BeforeToolSelection`**, `BeforeTool`, `AfterTool`, `PreCompress`, `Notification`. The model-level hooks can rewrite requests and responses ([hooks reference](https://github.com/google-gemini/gemini-cli/blob/main/docs/hooks/reference.md)).
- **Custom commands.** TOML files under `.gemini/commands/` ([custom commands](https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/custom-commands.md)).
- **Skills.** In `.gemini/skills`, loaded by `activate_skill`.
- **Extensions.** Installable bundles of MCP servers, commands, context, and hooks, with a public gallery ([extensions](https://github.com/google-gemini/gemini-cli/blob/main/docs/extensions/reference.md)).
- **System prompt override.** Replace the whole system prompt from a file ([system prompt](https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/system-prompt.md)).

### 3.6 UX
- Themes, keyboard shortcuts, and Vim mode ([keyboard shortcuts](https://github.com/google-gemini/gemini-cli/blob/main/docs/reference/keyboard-shortcuts.md)).
- `@` file inclusion, `!` shell passthrough, and image paste.
- IDE companion for VS Code that shares open files and the selection and shows native diffs ([IDE integration](https://github.com/google-gemini/gemini-cli/blob/main/docs/ide-integration/index.md)).
- `/stats` for tokens and cache usage. Model steering. `/model` selection.
- **Providers.** Gemini models only, through a Gemini API key, Vertex, or Code Assist licenses.
- **Local routing.** An experimental local Gemma model can make the routing decisions ([local routing](https://github.com/google-gemini/gemini-cli/blob/main/docs/core/local-model-routing.md)).

### 3.7 Reliability
- **Model routing and fallback.** `ModelAvailabilityService` switches to a fallback model on quota or server errors, after asking the user by default ([model routing](https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/model-routing.md)).
- Atomic writes, and CLI state recovered from a backup when it is corrupted (v0.64).
- Ctrl+C emergency abort.
- OpenTelemetry telemetry ([telemetry](https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/telemetry.md)).
- The shadow-git checkpoint never touches the user's own repo.

### 3.8 Weaknesses and complaints
- **Consumer cutoff.** Since 2026-06-18, logging in with a Google account returns nothing for free, AI Pro, and Ultra individual accounts. Automations broke with no grace period (HTTP 410 reported) ([#28017](https://github.com/google-gemini/gemini-cli/discussions/28017), [TechTimes, secondary](https://www.techtimes.com/articles/318660/20260618/gemini-cli-shutdown-takes-effect-ci-cd-pipelines-break-go-based-antigravity-cli-arrives.htm)).
- **Quota and routing confusion before the cutoff.** A reported 200-request cap per 24 hours after v0.38 ([forum](https://discuss.ai.google.dev/t/usage-quotas-as-of-last-month-or-so-has-made-gemini-ai-pro-with-cli-and-antigraivity-worthless/144049)). Paid users routed to free-tier limits ([forum](https://discuss.ai.google.dev/t/quota-exceeded-please-try-again-later/127389/149), [discussion #24430](https://github.com/google-gemini/gemini-cli/discussions/24430)).
- **Weak sandbox defaults.** Default sandbox is off, and the Seatbelt profile allows reads of `~/.ssh` and `~/.aws` with an open network. Env redaction is off by default even though parts of the docs imply it's automatic ([riptides](https://riptides.io/blog/ai-coding-agent-sandboxes-compared/)).
- **Experimental core features.** Subagents, plan mode, worktrees, and the tracker are all experimental. The docs contradict each other on read_file parameters.

---

## 4. Kiro CLI (AWS)

V3 harness, shared with Kiro IDE, Web, and Mobile ([CLI docs](https://kiro.dev/docs/cli/)).

### 4.1 Built-in tools
Primary source: [built-in tools](https://kiro.dev/docs/tools/).

- **File tools**
  - `read_file` reads one file, text or image, per call.
  - `list_directory`, `file_search` (fuzzy glob), and `grep_search` (regex).
  - `fs_write` (create or overwrite), `fs_append`, `str_replace` (exact replace), and `delete_file`.
  - `.kiroignore` blocks direct reads and filters search results.
- **`execute_bash`** (`execute_pwsh` on Windows)
  - Supports `run_in_background`.
  - CLI V3 does *not* register process-control tools; those are IDE-only.
- **Web.** `remote_web_search` and `web_fetch`, with a 10 MB limit, a 30 s timeout, and text/HTML only. CLI V3 retries a transient failure once.
- **`code`** (CLI only). Tree-sitter for 18 languages: symbol search, document symbols, AST pattern search, and AST rewrite. Optional LSP for references, definitions, rename, and diagnostics.
- **`knowledge`** (experimental). Semantic or BM25 knowledge-base indexing and search.
- **`invoke_sub_agent`, `disclose_context`, `introspect`.**
  - `disclose_context` activates skills or steering.
  - `introspect` answers questions from Kiro's own docs.
- **`createHook`.** Creates hooks from chat.
- **Deferred MCP tool loading.** `tool_load`/`tool_call`.
- **No task-list tool in V3.** `chat.enableTodoList` has no effect there; the 2.x `todo` and `goal` tools were not carried over.
- **Tool selection.** Custom agents pick tools by category tags (`read`, `write`, `shell`, `web`, `subagent`, `@builtin`, `@mcp`, `*`) and can set `excludedTools`.

### 4.2 Orchestration
- **Sub-agents** ([sub-agents](https://kiro.dev/docs/custom-agents/subagents/))
  - Any custom agent can be a sub-agent. Built-ins: context gathering, general purpose, and introspect.
  - Sub-agents run in parallel with isolated context and share steering, MCP, and the workspace.
  - **DAG pipelines.** The main agent plans the dependency graph upfront. **Loop-back stages** take `target`, `trigger` text, and `max_iterations` (1–10); self-loops and mutual loops are rejected.
  - `Ctrl+G` monitors running sub-agents.
- **Custom agents.** JSON or Markdown profiles with tags, a permissions block, inline MCP, and a model. `/upgrade-agent` migrates 2.x configs ([V3](https://kiro.dev/docs/cli/v3/)).
- **Workflows** (opt-in, `chat.enableWorkflows`)
  - Background multi-step runs that show their plan before starting, while the main chat stays usable.
  - Per-step credit display (3.1.0). "Run one more iteration" (3.2.0).
  - Headless runs wait up to 6 hours for workflows to settle ([headless](https://kiro.dev/docs/cli/headless/)).
- **Specs.** `/spec new <name>`: requirements, then design, then a task plan, executed in the terminal with full-screen task execution. Plan-mode handoff.
- **Headless**
  - `kiro-cli chat --no-interactive` with `KIRO_API_KEY`, `--output-format stream-json`, `--trust-tools=<ids>` or `--trust-all-tools`, `--agent`, `--model`, `--effort`.
  - `--sandbox` fails closed if the sandbox can't start.
  - `--require-mcp-startup` exits with code 3 if an MCP server fails.
  - Interruption records appear in stream-json.
- **Cloud sessions.** `--cloud --repo owner/repo` runs in a managed sandbox that keeps going after disconnect. Resume from `/sessions`.
- **ACP.** Kiro embeds in other editors as an ACP agent. Clients can request permission presets in `_meta.kiro.policyPreset` ([permissions](https://kiro.dev/docs/permissions/)).
- **No public SDK** beyond ACP and headless.

### 4.3 Context management
- **Compaction** ([compaction](https://kiro.dev/docs/compaction/))
  - Automatic, plus manual `/compact` in the CLI.
  - The summary keeps goals, decisions, files, and constraints.
  - Settings: `compaction.excludeMessages` (default 2 pairs) and `compaction.excludeContextWindowPercent` (default 2%). The larger of the two wins.
  - Compaction is one-way.
  - PreCompact can refuse compaction with exit code 2. PostCompact receives the summary plus a `summary_path` (3.1.0).
- **Steering files.** Support nested `AGENTS.md`. Sub-agents can read the parent's memories (3.1.0).
- **Memory.** Opt-in, and carries repository context forward (3.0.0).
- **Rewind.** `/rewind` branches the conversation from an earlier turn, and `/tangent` creates named, nestable side conversations. **V3 has no file checkpoints**: the 2.x `/checkpoint` is gone, and the docs tell users to restore files with git ([V3](https://kiro.dev/docs/cli/v3/)).
- **Sessions.** Resume, export, dashboard search, full replay of saved tool results, and an opt-in session recap.
- **Prompt caching.** Not documented to users. Billing is in credits.

### 4.4 Safety and permissions
Primary source: [permissions](https://kiro.dev/docs/permissions/).

- **Capability rules** in `permissions.yaml` at user scope, or workspace scope under `~/.kiro/workspace-roots/<hash>/`, which lives *outside* the repo.
  - Capabilities: `fs_read`, `fs_write`, `shell`, `web_fetch`, `web_search`, `mcp`, `subagent`, `skill`, `power`, `context`, `diagnostics`, `sandbox_network`.
  - Effects: `deny`, `ask`, `allow`, `evaluate`.
  - Deny always wins across every scope (deny-overrides). Rules can have `exclude` patterns.
- **Shell parsing.** Compound commands (`;`, `&&`, `|`) are split and each part is checked separately. Combined short flags are inspected. Program-launching options such as `tar --to-command` always need approval. Commands that can't be parsed are blocked, and the agent is asked to rewrite them.
- **Hardcoded invariants**
  - Always denied: writes to its own permission and settings stores and `.kiroignore`.
  - Always asked: writes to `.git/**`, `.vscode/**`, and the `.kiro` agents, hooks, workflows, and powers directories.
- **Workspace trust gate.** On first launch in a folder, a trust screen appears. Until the user trusts the folder, its agents, steering, MCP servers, skills, and workflows don't load.
- **Modes.** Supervised, Accept file changes, and **Approve for me**. In Approve for me, a trust classifier judges only the actions no rule settles; it can approve, block, or ask. `/autonomous on` runs tasks without per-command approval with the sandbox on.
- **Presets.** `read-workspace`, `edit-workspace`, `read-only-shell`, `dev-shell`, `read-all`, `allow-all`, `approve-for-me`.
- **Sub-agent permissions.** A sub-agent's tool call must pass both its own policy and the parent's, and the stricter result wins.
- **Sandbox** ([sandbox](https://kiro.dev/docs/sandbox/))
  - Seatbelt on macOS, bwrap plus socat on Linux, and a one-time admin setup on Windows.
  - Network modes: `DEFAULT_BLOCKED` (the default), `COMMON_DEPENDENCIES`, `DEFAULT_ALLOWED`. `sandbox_network` host rules apply first-match.
  - **Can also wrap stdio MCP servers** (`mcpSandboxing`).
  - A project file can only *tighten* the global policy.

### 4.5 Extensibility
- **MCP.** stdio, HTTP, and SSE. Hot reload, OAuth with pre-registered clients, and Client ID Metadata Documents so no oauth block is needed (3.2.0). Org policy can restrict MCP.
- **Hooks** ([hooks](https://kiro.dev/docs/hooks/), [types](https://kiro.dev/docs/hooks/types/))
  - Defined in `.kiro/hooks/*.json` (version `v1`) and global `~/.kiro/hooks/`.
  - Triggers: `UserPromptSubmit`, `Stop`, `SessionStart`, `SessionEnd`, `PreCompact`, `PostCompact`, `PreToolUse`, `PostToolUse`, `PostFileCreate`, `PostFileSave`, `PostFileDelete`, `PreTaskExec`, `PostTaskExec`.
  - Actions: a `command` that receives JSON on stdin, or an `agent` prompt injected into the conversation.
  - Matchers accept category tags and `@server/tool` selectors.
  - `confirm` dialogs with a dynamic `confirmCommand`.
- **Skills, Powers, slash prompts.** Skills, Powers (packaged docs plus MCP; installed in the IDE and listed in the CLI), and `@prompt` / `@agent-sop:` prompts.
- **No plugin marketplace** comparable to Claude Code's. Powers are the closest equivalent.

### 4.6 UX
- **Terminal UI.** Full-screen TUI with Markdown, tool cards, and preserved scrollback. Output detail is adjustable per tool call (3.2.1). Mermaid diagram viewer (`Ctrl+]`, `/diagram`).
- **Input.** `/voice` input, clipboard images, file references, and queued messages.
- **Status line.** Shows session credits; `/usage` shows them too.
- **Models** ([models](https://kiro.dev/docs/models/))
  - The catalog includes Claude, GPT-5.6, Grok, Kimi, DeepSeek, MiniMax, GLM, and Qwen, plus an "Auto" router. Prices are per-model credit multipliers.
  - `/model` picks the model and effort. `/model fallback` handles the case where a model is unavailable or refuses.
- **No BYOK.** Users have requested it repeatedly ([#9367](https://github.com/kirodotdev/Kiro/issues/9367), [#1952](https://github.com/kirodotdev/Kiro/issues/1952), [#7834](https://github.com/kirodotdev/Kiro/issues/7834)).

### 4.7 Reliability
- Model fallback.
- Web tools retry once on transient failures.
- Headless exit codes, fail-closed `--sandbox`, and `--require-mcp-startup`.
- Queued prompts continue after compaction.
- Root/Administrator launch warning.
- `kiro-cli diagnostic` and `kiro-cli issue`.
- No built-in worktree feature. Git is the undo path.

### 4.8 Weaknesses and complaints
- **Credits burn fast and the tiers are coarse** ([#9154](https://github.com/kirodotdev/Kiro/issues/9154), [#5004](https://github.com/kirodotdev/Kiro/issues/5004), [#6077](https://github.com/kirodotdev/Kiro/issues/6077)).
- **The CLI shows the wrong plan for Identity Center users** ([#9832](https://github.com/kirodotdev/Kiro/issues/9832)).
- **No BYOK or local models.**
- **Painful V2-to-V3 migration.** Session stores are separate, hook and agent formats changed, `use_aws` and `/checkpoint` were removed, and a headless run that names no harness still defaults to V2 ([V3](https://kiro.dev/docs/cli/v3/), [headless](https://kiro.dev/docs/cli/headless/)).
- **Heavy issue volume.** 1,016 issues labelled `cli` (484 open) as of 2026-10-31 ([#12194](https://github.com/kirodotdev/Kiro/issues/12194)).

---

## 5. Comparison matrix

| Capability | Claude Code | Codex CLI | Gemini CLI | Kiro CLI |
| --- | --- | --- | --- | --- |
| Dedicated read tool w/ ranges | yes: offset/limit, 25k-token pages, `allow_large` | no: reads via shell | yes: line ranges | yes: `read_file` |
| PDF / image / notebook read | yes / yes / yes | partial: `view_image` only | yes / yes / no (also audio) | no / yes / no |
| Edit primitive | exact replace, `replace_all` | multi-file `apply_patch` | exact replace + `instruction` | exact `str_replace` |
| Stale-file protection | yes: read-before-edit, exact-match on current content | partial: patch context must match | partial: exact match | partial: exact match |
| Built-in grep/glob | partial: off by default on Unix, Bash uses embedded bfs/ugrep | no: shell `rg` | yes: rich grep args | yes |
| Semantic / code-intel search | partial: LSP via plugins | no | no | yes: tree-sitter `code` + LSP + `knowledge` |
| Shell background procs | yes: `run_in_background` + `Monitor` event stream | yes: unified_exec PTY + polling | yes: `is_background` | yes: `run_in_background`, no process-control tools |
| Interactive PTY commands | no | yes | yes: node-pty, Tab to focus | no |
| Web search / fetch | yes / yes, fetch is model-summarized | yes, cached/live / no fetch tool | yes, Google / yes, SSRF-guarded | yes / yes, 10 MB, 30 s |
| Todo / task tools | yes: Task* with dependencies | partial: `/goal`, plan | yes: todos + experimental DAG tracker | no in V3 |
| Subagents: definition | MD+YAML, ~17 fields | TOML roles | MD+YAML (experimental) | JSON/MD agent profiles |
| Subagent per-agent model | yes | yes: role config layer | yes | yes |
| Subagent DAG / loops | partial: Workflow scripts, agent teams | no | no | yes: DAG + loop-back stages |
| Plan mode | yes | yes | yes (experimental) | yes: Specs + plan handoff |
| Background / async runs | yes: background agents, agent view, cloud | yes: cloud tasks, queue | no | yes: Workflows, cloud sessions |
| Headless JSON stream | yes | yes, plus `--output-schema` | yes | yes |
| SDK | yes: TS + Python Agent SDK | yes: TS/Python SDK + app-server JSON-RPC | partial: ACP, a2a-server | partial: ACP only |
| ACP / editor protocol | partial: own IDE extensions | partial: app-server | yes: `--acp` | yes |
| Auto-compaction controls | yes: per-model window, partial summarize from rewind | yes: token limit + scope | yes | yes: keep-recent settings |
| Pre/Post-compact hooks | yes | yes | partial: PreCompress only | yes: Pre can veto, Post gets summary |
| Memory files | CLAUDE.md + AGENTS.md + rules + auto memory | AGENTS.md (+ memories, off by default) | GEMINI.md (configurable) + Auto Memory | Steering + nested AGENTS.md + Memory |
| File checkpoints / rewind | yes: 100 checkpoints, code/convo/both | no | yes: shadow git + re-propose tool call | no: convo rewind only |
| Session resume / fork | yes / yes | yes / yes, named, fork-into-worktree | yes / partial | yes / partial (tangent) |
| Approval modes | 6 modes incl. classifier `auto` | on-request/never/granular + auto_review | default/autoEdit/plan/yolo | Supervised/Accept edits/Approve for me |
| Rule language | tool(pattern) allow/ask/deny | execpolicy rules, permission profiles | TOML with argsPattern regex + priorities | YAML capabilities, deny-overrides, compound-command split |
| OS sandbox default | off | on | off | off |
| Sandbox tech (Linux/mac) | bwrap / Seatbelt | bwrap + seccomp / Seatbelt; Windows separate user | Docker/Podman/gVisor/LXC / Seatbelt (whole CLI) | bwrap / Seatbelt; wraps stdio MCP |
| Network policy | proxy domain allowlist, starts empty | off, or fully open (proxy experimental) | open | blocked / common-deps / open + host rules |
| Credential protection | partial: experimental masking proxy | partial: env filters | partial: env redaction off by default | partial: deny rules + hardcoded invariants |
| Workspace trust gate | partial | partial | yes: trusted folders | yes: trust screen |
| MCP stdio/http/OAuth | yes/yes/yes + tool search | yes/yes/yes | yes/yes/yes | yes/yes/yes + CIMD + deferred loading |
| Hooks | ~28 events, command/http/prompt/mcp types | 14 events incl. model request | 11 events incl. BeforeModel/AfterModel | 13 events, command/agent actions |
| Skills / plugins / marketplace | yes / yes / yes (+ mods) | yes / yes / partial | yes / extensions / gallery | yes / Powers / partial |
| Output styles | yes | no: personality toggle only | partial: system prompt override | no |
| Status line / cost display | yes, scriptable / yes | yes, configurable / yes | partial / `/stats` | yes / yes, credits |
| Vim mode / keymap | yes / yes | yes / yes | yes / yes | partial / yes |
| Steer mid-turn vs queue | partial: queue | yes: Enter steers, Tab queues | partial | partial: queued messages |
| Built-in code review | yes: ReportFindings, Code Review | yes: `/review`, `codex review` | no | no |
| Multi-provider / BYOK | partial: Claude only, many hosts + gateway | yes: custom providers + local `--oss` | no: Gemini only | no: multi-vendor catalog, no BYOK |
| Model fallback on failure | partial | no | yes: ModelAvailabilityService | yes: `/model fallback` |
| Worktrees | yes: flag, tool, subagent isolation | yes: `/worktree`, fork --worktree | yes (experimental) | no |
| Telemetry | OpenTelemetry | OpenTelemetry | OpenTelemetry | partial: not user-configurable in docs |

---

## 6. Ideas worth stealing (15)

1. **Rewind menu with "summarize from here / up to here"** (Claude Code). Merges undo and targeted compaction into one picker. The user can shrink just the noisy middle of a session instead of compacting everything, and can restore code, conversation, or both from the same screen.
2. **Shadow-git checkpoints that re-propose the tool call** (Gemini CLI). Snapshots land in a repo outside the user's git, so their history is never touched. After `/restore`, the agent offers the exact pending call again, so the user can retry or tweak it instead of re-prompting.
3. **Multi-file atomic patch tool** (Codex `apply_patch`). One call edits, adds, and deletes several files. That cuts round-trips and avoids half-applied refactors. The trade-off: small models struggle with the format, so offer it per model.
4. **Stale-file tolerant exact edit** (Claude Code). Allows an edit to a file that changed on disk as long as `old_string` still matches the current content exactly, then tells the model to re-read. This avoids pointless re-read loops while staying safe.
5. **Steer vs. queue keys** (Codex). Enter injects into the running turn and Tab queues a message for after it. That is a cheap UX change that removes the "interrupt or wait" dilemma.
6. **`--output-schema` for headless runs** (Codex). The final answer must match a JSON Schema, which makes the CLI a reliable building block in scripts and CI.
7. **Classifier-backed approval as the weakest rule** (Kiro "evaluate" effect; Claude `auto` mode; Codex `auto_review`). Users' deny/ask/allow rules decide first, and a model judges only what no rule settles. Kiro's framing as the *lowest-precedence* effect is the cleanest version and cuts prompt fatigue without overriding explicit rules.
8. **Compound-command parsing and unparseable-command rejection** (Kiro). Splits `;`, `&&`, and `|`, checks each part against the rules, inspects combined short flags, and makes the agent rewrite commands it can't parse. This closes the classic `npm test; curl evil` bypass of prefix rules.
9. **Repo-proof config placement and a workspace trust gate** (Kiro, Gemini trusted folders). Per-workspace permissions live outside the repo. A project file can only *tighten* the sandbox. Untrusted folders don't load agents, hooks, MCP servers, or skills. Together these stop a cloned repo from granting itself power.
10. **Sandbox that also wraps stdio MCP servers** (Kiro `mcpSandboxing`). In other CLIs, MCP servers run with full user rights outside the sandbox ([riptides](https://riptides.io/blog/ai-coding-agent-sandboxes-compared/)). Wrapping them closes the biggest trust gap.
11. **Network-off by default with a domain allowlist proxy** (Codex default-off; Claude/Kiro allowlists; Kiro `COMMON_DEPENDENCIES` preset). A "package registries only" preset is the practical middle ground between off and fully open.
12. **Subagent DAGs with bounded loop-back stages** (Kiro). The orchestrator plans dependencies upfront and supports reviewer→implementer loops with a trigger string and a 1–10 iteration cap, with cycles rejected. This gives declarative fan-out and fix loops without custom scripting.
13. **`Monitor` tool that turns process output lines into events** (Claude Code). The agent reacts to log lines or WebSocket messages mid-conversation instead of polling, which is useful for dev servers, test watchers, and deploys.
14. **Model-request hooks** (Gemini `BeforeModel`/`AfterModel`/`BeforeToolSelection`; Codex `PreModelRequest`/`PostModelRequest`). These let users and plugins rewrite prompts, filter the tool list, or audit responses without forking the harness. They are useful for BYOK routing, redaction, and evals.
15. **Auto Memory that mines past sessions into reviewable patches and skills** (Gemini CLI; Claude auto memory; Kiro Memory). Recurring facts and procedures are proposed as diffs the user approves, which turns session history into durable learning. This fits Openbuff's "learning agent" goal directly.

Honorable mentions:
- Gemini's whole-CLI container and gVisor sandbox with a project `sandbox.Dockerfile`.
- Kiro's `--require-mcp-startup` (exit code 3) and fail-closed `--sandbox` for CI.
- Codex `fork --worktree`, which branches a session into an isolated checkout in one command.
- Gemini's model fallback service, plus Kiro's `/model fallback` for refusals and outages.
- Claude Code's deferred `ToolSearch` and Kiro's `tool_load`, which keep large MCP catalogs out of the prompt.
