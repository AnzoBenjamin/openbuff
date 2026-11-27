# Shard `extensions`: MCP, skills, hooks, custom tools, custom agents, config trust, ACP/serve

HEAD: `f5aba489d`. Read-only review. One read-only probe was run: a `bun -e` script that imports `mcpFileSchema` and calls `safeParse` on five sample configs. It wrote nothing.

## Scope

Inspected:
- MCP client and runtime: `common/src/mcp/client.ts` (transports 1404-1440, list_changed 1479, paginated discovery 1639-1731, `callMCPToolInternal` 1742-1770), `common/src/mcp/result.ts`, `common/src/types/mcp.ts`, `packages/agent-runtime/src/mcp.ts`, `packages/agent-runtime/src/mcp-constants.ts`, `sdk/src/agents/load-mcp-config.ts`, `cli/src/utils/local-agent-registry.ts`.
- Incoming MCP server: `cli/src/commands/mcp-command.ts`, `sdk/src/mcp/server.ts` (tool list 356-406).
- Custom tools: `sdk/src/custom-tool.ts`, `common/src/tools/external-tool.ts`.
- Skills: `common/src/tools/params/tool/skill.ts`, `packages/agent-runtime/src/tools/handlers/tool/skill.ts`, `sdk/src/skills/load-skills.ts`, `common/src/constants/skills.ts`, `common/src/types/skill.ts`, `common/src/util/skills.ts`, `cli/src/utils/skill-registry.ts`, `/skill:` command (`cli/src/commands/command-registry.ts:1519-1600`).
- Hooks: `common/src/tools/params/tool/run-file-change-hooks.ts`, `sdk/src/tools/file-change-hooks.ts` (exports only), `openbuff.d.example/hooks.json`, `docs/configuration.md:455-807`.
- Config and trust: `docs/configuration.md:1-82,520-620`, `sdk/src/host-config.ts:120-210`, `sdk/src/provider-config.ts:1205-1250`, `cli/src/index.tsx:585-640`, `cli/src/cli-args.ts:170-180,555-565`, `cli/src/utils/trusted-roots.ts`, `cli/src/commands/init.ts:105-141`, `cli/src/components/renderers/doctor-box.tsx:29-33`.
- Custom agents: `agents/types/agent-definition.ts`, `sdk/src/agents/load-agents.ts:60-110`, `docs/agents-and-tools.md:1-15,696-750`, `agents/patterns/add-an-agent.md`, `common/src/templates/initial-agents-dir/`.
- External CLI wrappers: `.agents/lib/create-cli-agent.ts`, `.agents/lib/cli-agent-schemas.ts`, `.agents/claude-code-cli.ts`, `packages/agent-runtime/src/tools/handlers/tool/run-terminal-command.ts:30-48`.
- ACP/serve: `cli/src/serve-command.ts`, `sdk/src/services/acp/acp-agent.ts:800-975,1020-1035`, `sdk/src/client/acp-client.ts` (header only).
- Base2 tool tiers: `packages/agent-runtime/src/util/base2-tool-tiers.ts`.
- Test inventory: file listings of `sdk/src/__tests__`, `common/src/mcp/__tests__`, `packages/agent-runtime/src/tools/handlers/tool/__tests__`.

Skipped or out of scope:
- ACP session persistence, reconnect and approval bridge internals. These belong to B17 and the `orchestration` and `exec-jobs` shards.
- The `file-change-hooks.ts` inference engine internals (1,865 lines) and diagnostic delta. Hook inference and timeout behavior were handed to the execution review in the prior audit (09).
- `sdk/src/mcp/server.ts` mutation broker (`apply_edits`). It is covered by the edit shard.
- Notion agents and `rust/` plugin host. The prior audit (10) already lists them as partial or absent.
- Base-prompt token cost and Markdown custom-agent ergonomics. These are already covered by `orchestration-02` and `orchestration-06`. I cross-reference them here and do not repeat them.

## Feature inventory

| Feature | Entrypoint | Implementation | Tests | Maturity |
|---|---|---|---|---|
| MCP client: stdio, streamable HTTP, SSE | `.agents/mcp.json`, agent `mcpServers`, SDK `mcpServers` | `common/src/mcp/client.ts:1404-1440`, `stdio-transport.ts` | `common/src/mcp/__tests__/*` (10 files), `sdk/src/__tests__/run-mcp-*.test.ts` | useful |
| MCP OAuth | none | no `authProvider` anywhere in `common/src/mcp/` | none | absent |
| MCP resources, prompts | none | no `resources/*` or `prompts/*` calls | none | absent |
| MCP tool deferral (tool search, code mode) | none | every discovered tool is declared (`mcp.ts:42-150`) | none | absent |
| MCP discovery pagination and list_changed | automatic | `client.ts:1662-1717`, `:1479` | `catalog.test.ts` | useful |
| MCP config management (`mcp add/list`, `/mcp`) | none; `openbuff mcp` is the server | n/a | n/a | absent |
| Incoming MCP server (`openbuff mcp`) | `openbuff mcp [--mutations]` | `cli/src/commands/mcp-command.ts`, `sdk/src/mcp/server.ts` | `sdk/src/__tests__/mcp-server.test.ts` | useful |
| SDK custom tools | `getCustomToolDefinition` | `sdk/src/custom-tool.ts`, `sdk/src/run.ts:3145` | `custom-tool-dispatch.test.ts`, `custom-tool-types.test.ts` | useful |
| Skills (`SKILL.md`) | `skill` tool, `/skill:<name>` | `sdk/src/skills/load-skills.ts`, `handlers/tool/skill.ts` | `sdk/src/__tests__/load-skills.test.ts`; no handler test | partial |
| Lifecycle hooks (pre/post tool, session, prompt, stop, compact) | none | n/a | n/a | absent |
| File-change verification hooks | `fileChangeHooks`, `autoFileChangeHooks`, `run_file_change_hooks` | `sdk/src/tools/file-change-hooks.ts` | `file-change-hooks.test.ts` | useful |
| Custom agents (TS/JS `handleSteps` modules) | `.agents/**`, `/init`, `--agent` | `sdk/src/agents/load-agents.ts`, `cli/src/utils/local-agent-registry.ts` | `load-agents.test.ts`, `agent-registry-epoch.test.ts` | partial (trust UX, see 04) |
| Markdown / `.claude/agents` agents | none | loader accepts `.ts/.tsx/.js/.mjs/.cjs` only (`load-agents.ts:64`) | n/a | absent (orchestration-06) |
| Project trust | `--trust-project-agents`, `trusted-roots.json` (serve only) | `cli/src/index.tsx:593-611`, `cli/src/utils/trusted-roots.ts` | `trusted-roots.test.ts`, `cli-args.test.ts` | partial |
| Config fragments (`openbuff.d/`) | `openbuff.json`, `openbuff.d.example/` | `sdk/src/provider-config.ts`, `sdk/src/host-config.ts` | `host-config.test.ts`, `model-provider.test.ts` | useful |
| ACP agent (`openbuff serve`) | `openbuff serve [--socket]` | `cli/src/serve-command.ts`, `sdk/src/services/acp/acp-agent.ts` | `acp-*.test.ts`, `serve-*.test.ts` | partial (text-only prompts) |
| External CLIs as agents | `.agents/claude-code-cli.ts`, `codex-cli.ts`, `gemini-cli.ts` | `.agents/lib/create-cli-agent.ts`, tmux scripts | none for the wrappers | partial |
| Plugins / packages / marketplace | `/publish` stub | `command-registry.ts:1207-1213` | n/a | absent |
| Hot reload of agents, skills, MCP | none | no file watcher in `cli/src` | n/a | absent |

## Findings

### extensions-01: Every MCP tool is declared on every base-agent request, with no deferral, search or code mode
- **Axis:** usability (model-facing token cost) and completeness. **Severity:** HIGH.
- **Evidence:**
  - Servers in `.agents/mcp.json` are merged into every agent whose id starts with `base` (`cli/src/utils/local-agent-registry.ts:457-473`).
  - `getMCPToolData` publishes every tool of every server unless the agent's `toolNames` lists `server/tool` selectors (`packages/agent-runtime/src/mcp.ts:49-60,111-118`). Base agents carry no such selectors, and `mcp.json` has no per-server tool filter (`common/src/types/mcp.ts:3-18`).
  - The repo has no `tool_search`, `tool_load` or code-mode tool (search for `tool_search|toolSearch|codemode|load_tool` across `common`, `sdk`, `packages`, `cli`, `agents`: no matches).
  - The base2 tier mechanism (`packages/agent-runtime/src/util/base2-tool-tiers.ts:19-22`) is pinned off and covers built-in tools only.
- **Impact:** The B.md §3.5 figures are Playwright MCP at 13.7k tokens and Chrome DevTools MCP at 18k. One such server adds that much to the roughly 22k tokens of built-in tool definitions measured in `orchestration-02`. It costs BYOK users on every request and pushes small-context local models over their window. Pi (codemode by default, `deferred` via `tool_search`), OpenCode (Code Mode by default), Claude Code (`ToolSearch`) and Kiro (`tool_load`/`tool_call`) all defer MCP tools by default.
- **Suggested fix:**
  - Add a per-server `exposure: direct | deferred | hidden` setting, plus per-tool glob overrides on the Pi model, with `deferred` as the default once a token threshold is crossed.
  - Ship one `tool_search` tool (BM25 over name and description) that declares the matches for the next step.
  - Append newly declared tools after the cached prefix rather than rewriting it.
- **Prior cross-reference:** new. Related to `orchestration-02` (built-in tool cost).

### extensions-02: `mcp.json` is undocumented, rejects common config fields, and one bad entry silently drops the whole file
- **Axis:** usability and reliability. **Severity:** HIGH.
- **Evidence:**
  - The stdio and remote schemas are `z.strictObject` (`common/src/types/mcp.ts:3,13`). The loader's doc comment claims the format "matches the standard MCP config format used by Claude Code, Cursor" (`sdk/src/agents/load-mcp-config.ts:14-19`).
  - Probe results from `mcpFileSchema.safeParse`: a plain `{command,args}` entry passes. Adding `cwd`, `disabled: true`, `timeout`, or `type: "streamable-http"` fails. In the `disabled` case the valid sibling server `b` is lost as well, because the whole file fails.
  - A parse failure returns early (`load-mcp-config.ts:85-95`). The CLI loads with `verbose: false` (`local-agent-registry.ts:207-209`), so nothing is shown to the user.
  - `docs/` never mentions `mcp.json`: grep for `mcp\.json` in `docs/**/*.md` returns no matches. The location is `.agents/mcp.json`, not the Claude Code `.mcp.json` or `~/.claude.json`.
  - Stdio servers cannot set `cwd`, and no server can set a timeout. Tool calls use the vendor SDK's default request timeout because no override is passed (`client.ts:1760-1764`).
  - No `mcp add/list/login` command exists. `openbuff mcp` already names the incoming server (`cli/src/commands/mcp-command.ts:56`), which conflicts with the `claude mcp add` / `codex mcp add` / `pi mcp add` convention.
  - No `/mcp` status view exists. `/doctor` shows only a count of configured servers (`command-registry.ts:1116`). Server load failures go to `logger.warn` only (`mcp.ts:156-163`).
- **Impact:** A user who pastes a Cursor or Claude Code server block gets zero MCP tools and no explanation.
- **Suggested fix:**
  - Accept and ignore unknown keys with a warning. Support `cwd`, `disabled`, `timeout` and `streamable-http`.
  - Validate each server separately and keep the valid ones.
  - Also read the project `.mcp.json` (under trust).
  - Add `openbuff mcp-config add|list|remove` (or rename the server subcommand to `openbuff mcp serve`) and a `/mcp` view with per-server status, tool count and last error.
  - Document all of this in `docs/configuration.md`.
- **Prior cross-reference:** new. B28 fixed result and catalog fidelity, not config intake.

### extensions-03: Project `openbuff.json` is trusted without consent for hook commands and credential-bearing providers
- **Axis:** reliability (security). **Severity:** HIGH. Static evidence only; I did not run it end to end. Downgrade if provider routing is shown to ignore project `defaultModel`.
- **Evidence:**
  - `openbuff.json` in the cwd and its ancestors (up to `$HOME`) is loaded (`docs/configuration.md:24-26`).
  - Any file inside the project root counts as trusted for `apiKeyEnv` providers (`sdk/src/host-config.ts:126-131,206-207`; `sdk/src/provider-config.ts:1243`). Only fragments outside the project are stripped (`sdk/src/__tests__/host-config.test.ts:120-131`).
  - `fileChangeHooks` from project config are merged and concatenated with no origin check (`docs/configuration.md:465-482`; `sdk/src/run.ts:1062`). Grep for `trust|origin` in `sdk/src/tools/file-change-hooks.ts` finds only unrelated hits.
  - By contrast, `.agents/**`, `.agents/mcp.json`, `execution` and `sandbox.allowPaths` require explicit trust (`cli/src/index.tsx:586-611`; `docs/configuration.md:556-570`).
- **Impact:**
  - A cloned repo can ship `openbuff.json` with `providers.x = {baseURL: <attacker>, apiKeyEnv: "OPENAI_API_KEY"}` and `defaultModel: "x/..."`. The user's existing key is then sent to that host on the first prompt.
  - The same repo can also declare `fileChangeHooks` commands that run after the first agent edit, with no prompt shown.
  - Gemini (trusted folders), Kiro (trust screen) and Pi (`defaultProjectTrust: ask`) gate this class of project config. A.md §4.4 and B.md §3.4 describe them.
- **Suggested fix:**
  - Treat project and ancestor `providers` that carry `apiKeyEnv`/`baseURL`, plus `fileChangeHooks`, as executable project config that needs the same trust decision as `.agents/`.
  - Without trust, keep `defaultModel` and route choices only when they point at user-global providers.
- **Prior cross-reference:** new. Prior audit 09/10 did not cover project `openbuff.json` credentials.

### extensions-04: Project trust is a per-invocation flag with no prompt or persistence in the TUI, so `/init` agents silently do not load
- **Axis:** usability and cohesion. **Severity:** HIGH.
- **Evidence:**
  - In the TUI, `effectiveTrust` is only the raw `--trust-project-agents` flag. The `trusted-roots.json` allowlist is read only for `serve` (`cli/src/index.tsx:593-611`).
  - The allowlist has no command that writes it (`cli/src/utils/trusted-roots.ts`; no trust command in `command-registry.ts`).
  - `/init` creates `.agents/` and reports success without mentioning trust (`cli/src/commands/init.ts:111-141`). `README.md:181-190` presents `/init` as the way to create agents.
  - `docs/agents-and-tools.md:13` documents "project `.agents` → parent → home" precedence with no trust caveat. The flag appears only in `--help` (`cli/src/cli-args.ts:560`) and `/doctor` (`doctor-box.tsx:29-31`).
  - Skills follow the same flag (`cli/src/index.tsx:797-799`).
  - Nothing reloads after a mid-session edit: there is no watcher in `cli/src`.
- **Impact:** A first-time user who follows the README gets a custom agent and skills that never appear unless they find `/doctor`. Every later launch needs the flag again.
- **Suggested fix:**
  - On first launch in a project that has `.agents/`, `.claude/skills` or an executable `openbuff.json`, show a Kiro- or Gemini-style trust screen. Persist the answer to `trusted-roots.json` and use it for the TUI as well as serve.
  - Add `/trust` and `/reload`.
  - Have `/init` print the trust state.
- **Prior cross-reference:** B29 (explicit agent loading) is adjacent but does not cover trust UX. New.

### extensions-05: The `skill` tool's disk fallback bypasses project-skill trust, reverses precedence, and has no tests
- **Axis:** reliability (security, correctness) and test gaps. **Severity:** MEDIUM.
- **Evidence:**
  - When a name is not in the trust-filtered cache, `handleSkill` calls `loadSkillFromDisk(projectRoot, name)` (`packages/agent-runtime/src/tools/handlers/tool/skill.ts:136-142`).
  - `loadSkillFromDisk` always searches `<project>/.agents/skills` and `<project>/.claude/skills` (`:61-68`) and returns the first match (`:70,102`). The first match is the home directory, so global wins.
  - The loader searches in the opposite order and lets project override global (`sdk/src/skills/load-skills.ts:172-183,247-251`).
  - The tool description itself tells the model it may load "any skill … by name" (`common/src/tools/params/tool/skill.ts:33-35`).
  - No test references `handleSkill` or `loadSkillFromDisk` under `packages/agent-runtime/src`.
- **Impact:** Without trust, an untrusted repo's `SKILL.md` still reaches the model on request. That is a prompt-injection channel. When names collide, the handler and the `/skill:` command (which reads the registry) can resolve different files.
- **Suggested fix:**
  - Pass the trust decision and directory list into `fileContext` and reuse `loadSkills` for the fallback.
  - Keep loader precedence.
  - Add handler tests for traversal, untrusted project, precedence and a skill created mid-session.
- **Prior cross-reference:** new.

### extensions-06: Skill results omit the skill directory, so bundled scripts and references cannot be used
- **Axis:** completeness and usability. **Severity:** MEDIUM.
- **Evidence:**
  - The `skill` output schema is `{name, description, content, license}` (`common/src/tools/params/tool/skill.ts:19-24`), and the handler returns only those fields (`skill.ts:166-178`), although `filePath` is known (`:107`).
  - The catalog lists name and description only (`common/src/util/skills.ts:20-40`).
  - `content` repeats the YAML frontmatter (`load-skills.ts:101`).
- **Impact:** Claude and Agent Skills commonly ship `scripts/`, `references/` and `assets/` next to `SKILL.md` and refer to them by relative path. The model cannot resolve those paths, so the "Claude-compatible" `~/.claude/skills` import (`load-skills.ts:160-170`) only works for text-only skills.
- **Suggested fix:**
  - Return `directory` (absolute) and a bounded list of the skill's files.
  - Strip frontmatter from `content`.
  - Optionally honour `allowed-tools`.
- **Prior cross-reference:** new.

### extensions-07: No general lifecycle hooks; the only user hooks are post-edit verification commands
- **Axis:** completeness. **Severity:** HIGH.
- **Evidence:**
  - The config schema has `fileChangeHooks` and `autoFileChangeHooks` only (`sdk/src/provider-config.ts:502-516`).
  - Grep for `PreToolUse|SessionStart|UserPromptSubmit|beforeToolCall|lifecycleHooks` in `sdk`, `cli`, `packages` and `common` finds only Memory V2 payload names (`common/src/types/memory-v2.ts:665`).
  - SDK hosts get `handleEvent` (observe only) and `requestApproval` for terminal effects (`sdk/src/run.ts:423`; `sdk/README.md:215-218`). Neither is configurable from the CLI.
- **Impact:** Users cannot block or rewrite a tool call, inject context at session start or prompt submit, run a command on stop or compaction, or notify on idle. Competitors offer:
  - Claude Code: about 28 events with command, HTTP, prompt and MCP actions (A.md §1.5).
  - Codex: 14 events, including model-request hooks (A.md §2.5).
  - Gemini: 11 events, including `BeforeModel` (A.md §3.5).
  - Kiro: 13 triggers with command or agent-prompt actions and matchers (A.md §4.5).
  - Pi: about 40 extension events (B.md §3.5).
- **Suggested fix:**
  - Add a `hooks` block in `openbuff.json`, gated by trust (see extensions-03), with `PreToolUse`, `PostToolUse`, `UserPromptSubmit`, `SessionStart`, `Stop`, `PreCompact` and `PostCompact` first.
  - Use Claude-compatible stdin JSON and exit-code-2 blocking so existing scripts port unchanged.
  - Fold `fileChangeHooks` in as a `PostFileChange` event.
- **Prior cross-reference:** prior audit 10 noted that "generic pre/post-tool … JSON receipt hooks" were absent. No B-card adds them. New as a product gap.

### extensions-08: ACP prompts keep only text blocks, so editor `@file` mentions are dropped
- **Axis:** completeness and usability (IDE integration). **Severity:** HIGH.
- **Evidence:**
  - `promptText` is built from `block.type === 'text'` only (`sdk/src/services/acp/acp-agent.ts:1028-1030`).
  - Initialization advertises `image: false, embeddedContext: false` (`:818-825`). ACP clients therefore fall back to `resource_link` blocks for mentioned files, and the ACP spec requires agents to accept text and resource-link blocks in a baseline prompt. Those blocks are counted for size (`:547`) and then discarded.
  - No user doc explains `openbuff serve` or editor setup: grep for `zed|acp|serve` in `README.md` and `docs/getting-started.md` finds nothing relevant.
- **Impact:** In Zed and other ACP hosts, files the user attaches with `@` never reach the agent, and no error is shown. Gemini (`--acp`), OpenCode (`opencode acp`), Kiro and Pi-Bolt (`--acp`) are the comparison set.
- **Suggested fix:**
  - Map `resource_link` to a file reference the runtime reads under containment, and `resource` to inline context. Then advertise `embeddedContext: true`.
  - Support `image` through the existing image path.
  - Add a Zed setup section to the docs.
- **Prior cross-reference:** new. B17 covers session persistence and reconnect only.

### extensions-09: External-CLI wrapper agents scrape interactive TUIs through a repo-relative tmux script and still misreport their permission profile
- **Axis:** reliability and cohesion. **Severity:** MEDIUM.
- **Evidence:**
  - The wrappers start `claude --permission-mode acceptEdits` inside tmux through `./scripts/tmux/tmux-cli.sh` (`.agents/claude-code-cli.ts:7-13,42`). That path exists only in this repo (`scripts/tmux/`), and the wrappers themselves live in project `.agents/`, which needs trust.
  - Output schema and prompts still claim `permissionProfile: "tmux-test"` is runtime-enforced (`.agents/lib/cli-agent-schemas.ts:10-15`; `create-cli-agent.ts:68`; `claude-code-cli.ts:78`). The runtime stamps `full-access` (`handlers/tool/run-terminal-command.ts:37-42`). Prior finding 10-F10 is still present at HEAD.
  - The `toString` constraint is still documented in every wrapper (`.agents/claude-code-cli.ts:15`, `codex-cli.ts:95`, `gemini-cli.ts:21`). Prior finding 10-F5 is still present.
  - None of the wrappers use the target CLI's headless JSON mode (`claude -p --output-format stream-json`, `codex exec --json`, `gemini -p --output-format json`) or its ACP mode. Openbuff already has an ACP client (`sdk/src/client/acp-client.ts:7-11`).
  - No tests cover the wrappers.
- **Impact:** These wrappers do not work outside the openbuff repo. Results depend on screen-scraping timing, and their receipts state a false enforcement claim.
- **Suggested fix:**
  - Ship one bundled `external-agent` that drives any ACP agent (claude-code-acp, `gemini --acp`, `kiro-cli acp`, `opencode acp`) through the existing ACP client, falling back to headless JSON modes.
  - Report the real terminal profile.
- **Prior cross-reference:** 10-F10 and 10-F5, under B29 (open).

### extensions-10: No MCP OAuth, resources, prompts or sampling
- **Axis:** completeness. **Severity:** MEDIUM.
- **Evidence:**
  - Remote configs carry only static `headers`/`params` (`common/src/types/mcp.ts:13-18`), and the transports are built without an `authProvider` (`client.ts:1415-1440`).
  - Grep for `listResources|readResource|listPrompts|getPrompt` finds nothing. The only notification handler is tool list-changed (`client.ts:1479`).
- **Impact:** Hosted MCP servers that need OAuth (GitHub, Linear, Notion, Sentry remote servers) cannot be used without hand-copied tokens. MCP prompts cannot become slash commands, and resources cannot be `@`-mentioned. Claude Code, Codex, Gemini, Kiro, OpenCode and Pi all support MCP OAuth (A.md §§1.5, 2.5, 3.5, 4.5; B.md §§1.5, 3.5).
- **Suggested fix:**
  - Implement the SDK `OAuthClientProvider` with tokens stored in `~/.config/openbuff/credentials.json` (0600), plus a `login` command.
  - Expose resources through a single `read_mcp_resource` tool and prompts as `/mcp:<server>:<prompt>`.
- **Prior cross-reference:** new.

### extensions-11: MCP and custom tools default to `endsAgentStep: true`, so one call is made per step
- **Axis:** usability (latency). **Severity:** LOW. I did not verify whether native parallel tool calls bypass this.
- **Evidence:** Every MCP descriptor is published with `endsAgentStep: true` (`packages/agent-runtime/src/mcp.ts:144`). `getCustomToolDefinition` defaults it to `true` (`sdk/src/custom-tool.ts:69`). The doc comment says the model "will not be able to call any other tools after this one in a single step" (`custom-tool.ts:54`).
- **Impact:** Read-only MCP calls (for example three `get_issue` lookups) cannot be batched. Each costs a model round trip.
- **Suggested fix:** Default to `false` for MCP tools with `readOnlyHint: true`, and let a per-server setting override it.
- **Prior cross-reference:** new.

### extensions-12: Extension docs drift and missing user docs
- **Axis:** usability (docs). **Severity:** LOW.
- **Evidence:**
  - `agents/patterns/add-an-agent.md:12-13` tells contributors to set `tools` and `subagents` fields. The type uses `toolNames` and `spawnableAgents` (`agents/types/agent-definition.ts:147,182`; `agents/editor/editor.ts:138`).
  - `docs/agents-and-tools.md:11` still says programmatic agents "execute in a secure sandbox". Prior finding 10-F11 is still present.
  - There are no user docs for MCP server config, `openbuff mcp`, `openbuff serve`, skills directories or project trust (see extensions-02, 04 and 08).
  - `openbuff.d.example/hooks.json` is specific to this monorepo (`typecheck-common`, `typecheck-sdk`), although `docs/configuration.md:38-41` presents the directory as a copyable example.
- **Impact:** Contributors following the pattern hit type errors. Users who copy the example get hooks that fail outside this repo.
- **Suggested fix:**
  - Fix the field names.
  - Replace "secure sandbox" with "host realm, trusted code".
  - Add a user-facing "Extending Openbuff" page.
  - Make the example hooks generic.
- **Prior cross-reference:** 10-F11 under B29. The rest is new.

### extensions-13: Agent discovery still imports auxiliary modules before validating them
- **Axis:** reliability. **Severity:** MEDIUM. This is a re-check only.
- **Evidence:** The walker still skips only `skills/`, `.d.ts` and `.test.ts` (`sdk/src/agents/load-agents.ts:66-89`), so `.agents/lib/*.ts`, `.agents/sessions/**` and `__tests__/*.spec.ts` are all imported. This repo's own `.agents/` holds `lib/` and a large `sessions/` tree.
- **Impact:** Same as 10-F3. Startup imports unrelated code, and import failures stay invisible with `verbose: false`.
- **Suggested fix:** As B29: declare explicit entrypoints and surface import diagnostics in `/doctor`.
- **Prior cross-reference:** 10-F3, under B29 (open), still present.

### Prior findings re-checked at HEAD
- **10-F1** (MCP `isError`/`structuredContent` lost): fixed. `common/src/mcp/result.ts:6-18` carries both fields. B28 accepted.
- **10-F2** (origin lost across JSON): `sdk/src/__tests__/mcp-origin-continuation.test.ts` exists, and B28 is accepted. I did not re-probe it.
- **10-F4** (first page only, stale cache): fixed. Discovery is paginated with cursor-loop detection (`client.ts:1662-1717`), and the cache is invalidated on list_changed (`:1479`).
- **10-F8** (all strings treated as paths): fixed. Only declared `pathParameters` are checked (`common/src/tools/external-tool.ts:56-122`; `sdk/src/run.ts:3145`).
- **10-F9** (`__` delimiter ambiguity): fixed. Names that are ambiguous or contain `__` get an encoded `openbuff_ext_mcp_<hash>` alias, and dispatch never splits names (`external-tool.ts:27-54`).
- **10-F3, 10-F5, 10-F10, 10-F11:** still present (extensions-13, 09, 09 and 12). All four are under B29.
- **10-F6, 10-F7** (schema portability, prompt sentinel): not re-verified in this shard.

## Competitive gaps

| Capability | Best-in-class CLI and how it does it | Openbuff state | Priority |
|---|---|---|---|
| MCP context control | Pi: `codemode` default, `deferred` via BM25 `tool_search`, per-tool `toolExposure` globs, append-only updates (B.md §3.5). OpenCode: Code Mode default. Claude Code: `ToolSearch` | All tools declared directly (extensions-01) | P0 |
| Project trust gate | Kiro: trust screen; untrusted folders load no agents, steering, MCP, skills or workflows. Gemini: trusted folders. Pi: `defaultProjectTrust: ask`, `trust.json` | Per-run flag for `.agents/`; project `openbuff.json` trusted implicitly (extensions-03, 04) | P0 |
| Lifecycle hooks | Claude Code: about 28 events, command/HTTP/prompt/MCP actions, exit-2 block. Kiro: 13 triggers, agent-prompt actions | Post-edit verification only (extensions-07) | P0 |
| MCP OAuth | Codex `/mcp login`; Kiro CIMD; Claude Code, Gemini, OpenCode, Pi OAuth | Static headers only (extensions-10) | P1 |
| MCP config UX | `claude mcp add`, `codex mcp add`, `pi mcp add|list|login`, `/mcp`; Kiro `--require-mcp-startup` | Undocumented strict `.agents/mcp.json`; silent failure (extensions-02) | P1 |
| ACP rich prompts | Gemini `--acp`, OpenCode `acp`, Kiro: file and image context from the editor | Text only (extensions-08) | P1 |
| Skills with resources | Claude Code / Agent Skills: `scripts/`, `references/` resolved relative to the skill | Directory path not returned (extensions-06) | P1 |
| Plugin / package distribution | Claude Code plugins + marketplaces; Pi packages via npm/git (more than 2,100); Gemini extensions gallery; OpenCode npm plugins | None; `/publish` stub (`command-registry.ts:1207-1213`) | P2 |
| Hot reload | Pi `/reload`; Kiro MCP hot reload | Restart required | P2 |
| Markdown agent definitions | Claude Code, Gemini, OpenCode: MD + YAML; Kiro: JSON/MD | TS/JS only (see orchestration-06) | P1 |
| Delegate to other agents | Pi-Bolt `--mcp` exposes a `prompt` tool. Kiro / Gemini A2A remote agents | Tmux scraping wrappers (extensions-09); `openbuff mcp` exposes index tools but no agent-run tool | P2 |
| MCP resources/prompts | Claude Code resources and `@` mentions; Gemini resources as tools | Absent (extensions-10) | P2 |

## Strengths

- **Fail-closed MCP provenance.** Origin is held in a WeakMap rather than trusting a peer field (`common/src/mcp/client.ts:172-254`). Descriptions from client-origin servers are prefixed as untrusted data (`packages/agent-runtime/src/mcp.ts:146-150`). `$VAR` expansion is refused for client-origin servers (`client.ts:1381-1399`). None of the reference CLIs label tool descriptions by origin.
- **SSRF and DNS-pinning defense for remote MCP.** Literal private and loopback hosts are refused at ACP `session/new` (`sdk/src/services/acp/acp-agent.ts:950-965`). Connect-time DNS pinning is in `common/src/mcp/dns-pinning.ts`. The B.md §1.4 OpenCode MCP-OAuth RCE shows why this matters.
- **Healthy-server isolation and honest catalogs.** `Promise.allSettled` discovery (`mcp.ts:47`), `complete`/`incompleteReasons` per catalog (`mcp.ts:65-128`), paginated discovery with cursor-loop detection, and list_changed invalidation.
- **Reversible tool identity.** Opaque hashed aliases prevent collisions between server, tool and built-in names (`common/src/tools/external-tool.ts:27-54`). Declared `pathParameters` give custom tools real filesystem containment without treating routes or regexes as paths (`:56-122`).
- **SDK custom tools keep the original Zod schema at execution**, including async refinements and transforms (`docs/agents-and-tools.md:707-711`; `sdk/src/custom-tool.ts:30-33`). Pi needs TypeBox for the same.
- **Openbuff as an MCP server for other agents.** `openbuff mcp` exposes `query_index`, `code_search`, `read_files`, `file_outline`, `codebase_structure` and `memory_search` read-only, with `apply_edits` behind `--mutations` (`sdk/src/mcp/server.ts:356-406`). Claude Code or Codex can use Openbuff's index through it. Among the reference CLIs only Pi-Bolt has an equivalent (`--mcp`), and it exposes a prompt tool, not retrieval.
- **Claude skill interop.** `~/.claude/skills` and `.claude/skills` are read alongside `.agents/skills` (`sdk/src/skills/load-skills.ts:160-183`), with a compact 180-character catalog (`common/src/util/skills.ts:3`).
- **Programmatic agents.** `handleSteps` generators can mix scripted tool calls with `STEP` model turns (`.agents/claude-code-cli.ts:18-40`). This gives deterministic control that Markdown-only agent formats cannot express.
- **ACP serve hardening.** Socket token auth, symlink-safe bind, credential holdback env and a cwd containment root (`cli/src/serve-command.ts:85-219`). Capability advertisement is honest about what is unsupported (`acp-agent.ts:805-825`).

## Roadmap mapping

| Finding | Mapping |
|---|---|
| extensions-01 MCP tool deferral | Not covered. The B28 catalog work is a prerequisite. Related to `orchestration-02`. |
| extensions-02 mcp.json intake, config UX | Not covered. B28 covers catalog and results only. |
| extensions-03 project `openbuff.json` trust | Not covered. B19 threads execution context, but no card gates project providers or hooks. |
| extensions-04 trust UX, `/init`, reload | Partially, through B29 (explicit agent loading). Trust prompt, persistence and reload are not covered. |
| extensions-05 skill fallback trust and precedence | Not covered. |
| extensions-06 skill directory | Not covered. |
| extensions-07 lifecycle hooks | Not covered. PLAN P9 lists "declarative agents lifecycle hooks" as deferred, under the B29 trace. |
| extensions-08 ACP non-text prompts | Not covered. B17 covers sessions and reconnect only. |
| extensions-09 CLI wrappers | Partially, through B29 (10-F10 receipts, 10-F5 stringification). An ACP-based external agent is not covered. |
| extensions-10 MCP OAuth, resources, prompts | Not covered. |
| extensions-11 `endsAgentStep` default | Not covered. |
| extensions-12 docs drift | Partially, through B29 (10-F11). The rest is not covered. |
| extensions-13 auxiliary module import | Covered by B29 (open). |
