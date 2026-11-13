# Openbuff product audit: synthesis (2026-11-12)

Sources: `BRIEF.md`, `competitors/A.md` (Claude Code, Codex CLI, Gemini CLI, Kiro CLI), `competitors/B.md` (OpenCode, Aider, Pi, Pi-Bolt), the 11 shard files in `findings/`, the card table in `.agents/sessions/body-capability-review-2026-11-05/PLAN.md:83-122`, and node statuses in `docs/execution/body-roadmap/ledger.json`. No product source was read for this synthesis. Every claim below comes from a shard, and the shard file holds the `file:line` evidence. Finding IDs use the shard prefix (`read-search-01` and so on). Roadmap state: 12 nodes accepted (B01, B02, B03, B04, B05, B08, B18, B19, B20, B28, B30, B36). The other 27 are pending, and B21 is being worked.

## Verdict

Openbuff has deeper safety and correctness engineering than any of the eight reference CLIs. It has transactional multi-file edits with stale-file checks at three hash layers, approvals bound to the exact command and context, fail-closed compound-command parsing, MCP origin labelling with DNS pinning, cross-provider failover, per-agent BYOK routing, process-isolated subagents, durable plan packets, `/bisect-turn`, and offline run replay. The weak spots are the ones users hit first. Each request carries about 47k fixed tokens and sends no prompt-cache markers, so a 30-step Sonnet task costs about 6× more input than it should. There is no first-run setup, and the CLI takes about 2 s to become ready. Several tools return silent wrong answers: memory-served `glob`/`list_directory`/`code_search`, an empty `workspace_symbol`, "no results" when DuckDuckGo blocks the search, and "no documentation" when the `read_docs` key is missing. Plan mode can still edit files through two routes. A cloned repo's `openbuff.json` can name its own credential-bearing providers and hook commands. Compared one by one: Claude Code leads on rewind, hooks, plugins and polish. Codex CLI leads on default sandboxing, headless `exec` and steering. Gemini CLI leads on trusted folders, shadow-git checkpoints and grounded search. Kiro CLI leads on permission rules and its trust screen. OpenCode leads on provider breadth, `webfetch` and combined undo. Aider, now in maintenance mode, still leads on its repo map and per-model edit formats. Pi and Pi-Bolt show that a small declared surface (under 1k tokens, 0.04 s start for Pi-Bolt) loses little capability when everything else is deferred. Openbuff has more features than any of them, but most of that breadth is declared on every request, unbounded in output, or undiscoverable. That is the specific pattern `competitors/B.md` §7 argues against.

## Top 15 fixes

Ranked by user impact per unit of effort. Effort: S is under a day, M is a few days, L is a week or more. Roadmap coverage refers to PLAN cards.

| # | Fix | Findings | Problem | Fix | Effort | Roadmap |
|---|---|---|---|---|---|---|
| 1 | Send prompt-cache markers on the agent loop | providers-sdk-01, memory-context-11 | The streaming path hard-codes `includeCacheControl` to false for every route, so Anthropic and OpenRouter→Claude users pay about 6× input cost (≈$9.60 vs ≈$1.55 for a 30-step Sonnet task). | Use `compatibility.stripCacheControl === false` as the non-streaming path does, default OpenRouter's Anthropic models to markers, add a wire test, and show cache-hit % per turn. | S | Not covered |
| 2 | Make plan mode read-only | orchestration-01, exec-jobs-02 | Plan mode still exposes `rename_symbol`/`code_action`/`extract_symbol`, auto-adds writing custom agents, and lets `basher` run any shell command at full access. | Gate mutation tools on plan lineage at dispatch, clamp plan descendants to the `read-only` terminal profile, and extend the reachability test to assert no mutating tool is reachable. | S–M | Not covered (B19 keeps full-access by choice) |
| 3 | Turn silent empty or wrong results into typed errors | read-search-01, language-intel-02, web-media-evals-03, web-media-evals-06, language-intel-07 | Memory-first skips return files that don't match the pattern, a cold `workspace_symbol` returns `[]`, a blocked DDG page reads as "No search results", a missing Context7 key reads as "No documentation found", and a missing LSP binary reads as "crashed". | Remove the memory skip for exhaustive tools. Return `unavailable`/`blocked`/`auth`/`not-installed` with a reason and next step. Add a negative test for each. | S each | Not covered |
| 4 | Retry Anthropic overloads and honour Retry-After | providers-sdk-02, providers-sdk-09 | HTTP 529 fails the turn on the first try even with a backup model configured, and Retry-After is capped at 8 s, so tier-limited 429s fail after about 24 s. | Add 529 (and SSE `overloaded_error`) to the retry and failover sets. Honour Retry-After up to 60–120 s with a visible countdown. | S | Partially B08 (accepted; fixture used 503 only) |
| 5 | Give shell commands a default timeout and close stdin | exec-jobs-01, exec-jobs-18 | SYNC commands default to no timeout with an open stdin pipe, so any prompting command hangs the turn, and cancelling discards all output. | Default to 2 min (model can raise it), use `stdin: ignore` for SYNC, add an idle-output watchdog, and keep partial output on abort. | S | Not covered |
| 6 | Close the web-fetch SSRF bypass | web-media-evals-01, web-media-evals-02 | `http://[::ffff:127.0.0.1]/` and the mapped cloud-metadata address pass the guard (confirmed live), and the DNS check and connect are separate lookups. | Unmap IPv4-mapped/NAT64 ranges with a real IP classifier shared with MCP, and route web fetch through the existing pinned-address fetch. | S | Not covered |
| 7 | Bound what a single tool result can return | read-search-02, read-search-03, read-search-04, language-intel-10, language-intel-11, language-intel-12 | `read_files` can return 10 MB, `glob` returns every match (32k tokens on this repo), LSP references are uncapped, `inspect_codebase_structure` returned 20.5 MB after blocking for 38 s, and the review bundle defaults to 200k chars. | Put a model-visible budget (about 25k tokens) and a per-line cap on every read/list/search result, return `partial` plus `nextOffset`, walk with `git ls-files`, and drop edit authority when trim removes content. | M | Not covered (B05 bounds allocation only) |
| 8 | Ship tree-sitter queries in the release tarball | language-intel-05 | The official tarball omits the `.scm` query files, so installed users get an index with no symbols, calls or imports in any language, and `/index status` still reads ready. | Add `tree-sitter-queries/` to both tar lists and the npm wrapper, or embed them, and make the smoke test assert non-empty symbols. | S | Covered by B24 (pending, waits on B23) |
| 9 | Cut the fixed prompt from about 47k tokens | orchestration-02, extensions-01, read-search-07, exec-jobs-14, language-intel-07, language-intel-12, orchestration-09 | base2 sends 21.9k tokens of tools, an 11.4k agent catalog and an 11k system prompt every step, with tier disclosure built but switched off and every MCP tool declared. | Turn on `progressiveToolDisclosure`, render the catalog one line per agent, defer MCP and rare tiers behind a `tool_search`, expose LSP only when a server is detected, and add a CI token budget. See "Minimalism vs breadth". | M | Not covered |
| 10 | Gate project config behind one persisted trust decision | extensions-03, extensions-04, exec-jobs-04, extensions-05 | A cloned repo's `openbuff.json` can define a credential-bearing provider pointed at any host, add hook commands, and (inferred) set `approvalMode: allow-all`. Meanwhile real user agents created by `/init` silently don't load without a per-run flag. | Show a trust screen on first launch in a project with executable config, persist it for TUI and serve, let untrusted project files only tighten approval, and make the `skill` fallback honour trust. | M | Partially B29 |
| 11 | Add `/compact`, `/usage` and a price/window table | memory-context-01, cli-ux-06, providers-sdk-03, providers-sdk-05 | `/compact` is rejected as unknown while error text tells users to run it, cost is blank for most BYOK routes (and rounded to whole cents), and no preset declares a context window. | Register `/compact [focus]`, add `/usage` with tokens, cache hits and cost (or "unknown"), and ship a models.dev-derived table of windows and prices that discovery also fills. | S (compact), M (cost table) | Partially B09 (pending) |
| 12 | First-run setup inside the TUI | cli-ux-01, providers-sdk-06, providers-sdk-13 | A new user learns there is no provider only after typing a prompt, must quit to export an env var, and the example config includes files that don't exist. | Open the provider picker at boot when not ready, accept a pasted key into a 0600 credential store or keychain, auto-offer presets for exported keys, and ship a self-contained example. | M | Not covered |
| 13 | Make the eval loop produce a signal | web-media-evals-10, web-media-evals-11, web-media-evals-14 | The nightly eval targets a nonexistent agent (`base2-free`) and always exits 0, the `[buffbench]` workflow runs a deleted script, and `packages/code-map` is missing from the CI test matrix. | Point the nightly at `base2`, upload results, diff against the last green run with `compare-runs.ts`, run a small subset on prompt/tool PRs, and add code-map to CI. | S–M | Partially B30 (accepted), B31, B32 |
| 14 | Reliable undo/rewind | write-edit-02, memory-context-08, write-edit-09 | Snapshots are taken only after successful turns and only for tracked files, so `/undo-turn` can revert the wrong turn and never removes agent-created files. The snapshot ref can also leak through `git push --mirror`. | Snapshot before each turn and mutating batch, include agent-created paths from broker receipts, store snapshots in a shadow repo outside `.git`, and add one `/rewind` for code, conversation or both. | M | Not covered (B34 adjacent) |
| 15 | Persistent approval rules and an honest approval prompt | exec-jobs-03, exec-jobs-06, exec-jobs-05 | Approval offers only "Allow once"/"Deny", shows only the first classified effect of a compound command, and the balanced-mode text promises that unclassified effects ask when they run freely. | Add ordered allow/ask/deny rules stored outside the repo plus "allow this prefix" and "allow for session" options, render the full command and every effect, and correct the balanced copy. | M | Partially B18 (accepted; UI and rules not covered) |

Close behind these: `mcp.json` that accepts common fields and keeps valid servers when one entry is bad (extensions-02, S), ACP `resource_link` support so editor `@file` mentions arrive (extensions-08, S–M), a fast path for `--version`/`--help` plus lazy imports (cli-ux-02, M), session-scoped LSP servers with diagnostics after edits (language-intel-01, language-intel-04, M–L), short capability handles instead of 800-char tokens (write-edit-01, M), headless `run` with stdin, `--model`, `--continue` and `--output-schema` (cli-ux-03, M), and general lifecycle hooks (extensions-07, L).

## Cross-cutting patterns

### 1. Silent wrong answers
Several tools return a successful-looking result that is false, and the model acts on it.
- `glob`, `list_directory` and `code_search` serve memory excerpts that don't match the request, with no provenance marker (read-search-01).
- `workspace_symbol` returns `[]` when no server is warm, though its schema promises `unavailable` (language-intel-02). A missing LSP binary is reported as "crashed" (language-intel-07).
- A DuckDuckGo bot-check page becomes "No search results found" (web-media-evals-03). Every Context7 failure, including a missing key sent as `Bearer undefined`, becomes "No documentation found" (web-media-evals-06).
- `render_ui` acknowledges renders that never happened (web-media-evals-08). `kill_job` returns `killed: true` before the kill is confirmed (exec-jobs-13).
- A trimmed read keeps `complete:true` and whole-file edit authority (read-search-03). Near-match auto-correct shows as plain "applied" in the CLI (write-edit-04). Failover after a 401 is overwritten by "recovered", so traffic and billing move silently (providers-sdk-08).
- The memory pass the UI calls "semantic (LLM)" is an extractive truncation (memory-context-05). A skipped or failed pruner pass is logged at debug or warn level only (memory-context-06).
- The nightly eval reports success no matter what (web-media-evals-11).

The prior review (B01–B36) fixed many of these at the action and run level. This class sits in tool results and UI text, where no card looks.

### 2. Token bloat with no caching
- About 47k static tokens per base2 step (orchestration-02), plus every MCP tool (extensions-01), about 1.4k of LSP tools that fail for most users (language-intel-07), about 1.2k of audit/review tools (language-intel-12), and duplicated read policy and harness jargon in the prompt (read-search-07, orchestration-09).
- Per-call cost on top of that: 795-character capability tokens on every read and edit (write-edit-01), unbounded result sizes (read-search-02, read-search-04, language-intel-10, language-intel-11), and a 10k-token floor on `read_docs` (web-media-evals-06).
- None of it is cached on the agent loop (providers-sdk-01). Mode switches change the system prompt and tool list, which breaks any cache that does exist (orchestration-08). Compaction rewrites the cached prefix (memory-context-11).
- The cost is also invisible: cost tracking is blank or wrong for most routes (providers-sdk-03), and the chip hides at 0 (cli-ux-06).
- Small local models can't fit the prompt at all. The Ollama default model has a 32k window, Ollama truncates silently, and the runtime assumes 190k (providers-sdk-05).

### 3. Plan mode is not read-only, by two routes
- The root plan agent still has three LSP mutation tools, and user agents from `.agents/` are auto-added to `base2-plan` (orchestration-01).
- `basher` is spawnable in plan mode and runs at full access because per-agent terminal profiles are dead code (exec-jobs-02).
- The prompt claims a boundary the runtime does not enforce, and the reachability test checks only `edit_transaction` and `run_*`.

### 4. Trust model gaps
- `.agents/`, `mcp.json`, `execution` and `sandbox.allowPaths` require trust, but project `openbuff.json` providers with `apiKeyEnv`, `fileChangeHooks`, and probably `approvalMode` do not (extensions-03, exec-jobs-04).
- The `skill` tool's disk fallback reads untrusted project skills (extensions-05).
- Trust is a per-invocation flag with no prompt and no persistence in the TUI, so the README's `/init` flow produces agents that never load (extensions-04).
- On the approval side: no persistent rules (exec-jobs-03), a prompt that hides later effects (exec-jobs-06), and balanced-mode copy that overstates protection (exec-jobs-05).
- The OS sandbox is off by default and effectively unavailable outside Linux x64 with a hand-installed binary (exec-jobs-07). File edits have no approval mode or protected paths (write-edit-03).
- Web fetch has an SSRF bypass (web-media-evals-01) that also affects the MCP blocklist.

### 5. Shipped but unwired or undiscoverable
- Tier disclosure is pinned off (orchestration-02). PageRank weight is 0 and the repo map is unranked (language-intel-13, read-search-11).
- `add_subgoal`, `update_subgoal`, `think_deeply`, `lookup_agent_info` and `end_turn` are registered but reachable by no agent (orchestration-03). `find_files` and `find_files_matching_content` are quarantined but still registered (read-search-09).
- Per-agent terminal profiles exist but are never applied (exec-jobs-02). Custom themes are unwired (cli-ux-10). The `/publish` UI is mounted around a stub (orchestration-06). `/feedback` is disabled (web-media-evals-13).
- Some commands exist but can't be found. `/compact` is handled by the runtime but rejected by the CLI router (memory-context-01). `/plans` and `/plan-use` are registered but missing from the menu (cli-ux-07). The inline menu isn't fuzzy, commands have no usage hints, and `/help` lists no commands (cli-ux-07).
- `query_index` has no SDK handler, although base2 is told to start with it (read-search-11).
- Some features need configuration nobody tells the user about. Post-edit hooks are opt-in (write-edit-05). LSP needs servers on PATH, and nothing detects or reports them (language-intel-07). Shell shims are documented but not implemented (exec-jobs-20). `openbuff init` is advertised as a subcommand but isn't parsed as one (cli-ux-13).

### 6. Docs and prompt drift
- `cap.v3` appears in the editor prompt, base2, the SDK README and MCP descriptions, while the runtime mints `cap.v4` (write-edit-07, read-search-07, providers-sdk-11).
- `autoFileChangeHooks` docs contradict the code, and the hook timeout appears as 180, unbounded or 300 depending on where you look (write-edit-05).
- `synthesizer` is described as excluded from base2's spawnable agents but is included, and other orchestration docs have drifted too (orchestration-10).
- `researcher-web` is documented with a 3-search cap and a fast path, but has neither (web-media-evals-15).
- `add-an-agent.md` uses the wrong field names, and the docs still say programmatic agents run in a "secure sandbox" (extensions-12).
- The SDK examples target the removed hosted service (providers-sdk-11). `AgentDefinition` still talks about OpenRouter and an agent store (orchestration-06).
- Dead eval scripts remain, and the package is still named `@codebuff/evals` (web-media-evals-10).
- The README says nothing about web, browser, image, MCP config, `serve`, skills or trust (web-media-evals-15, extensions-12).

### 7. Cohesion: several tools for one job
- Five planning surfaces (orchestration-03).
- Two shell routes with different output shapes (exec-jobs-15, orchestration-08).
- Nine registered mutation tools with only one exposed (write-edit-07).
- Discovery split across `glob`, `list_directory`, `read_subtree`, `query_index`, `workspace_symbol`, `code_search` and `find_references` (read-search-09, language-intel-08).
- Different image pipelines for user and model (web-media-evals-09).
- Fetch hidden inside `web_search` and reachable only through a sub-agent (web-media-evals-05).
- Separate conversation and code undo (write-edit-02, memory-context-08).
- Mixed 0- and 1-based positions across LSP inputs, outputs and the TUI (language-intel-03).

### 8. Platform reach is Linux-first
- Windows needs an env var for Git Bash because auto-detection is dead code, has no PowerShell, and kills only the leader process (exec-jobs-12).
- On macOS a timeout kills only the leader, so grandchildren leak (exec-jobs-12).
- CI runs on Ubuntu only (cli-ux-12).
- B20 and B21 acceptance is Linux-only (roadmap-process-07).

## Per-area scorecard

Scores are 1 (poor) to 5 (best in class), judged from shard evidence.

| Area | Usability | Completeness vs best-in-class | Reliability | Headline |
|---|---|---|---|---|
| Read / search | 3 | 4 | 2 | Content-anchored and symbol reads lead the field, but results are unbounded and memory-first discovery fabricates answers |
| Write / edit | 3 | 4 | 4 | Strongest stale-file protection and atomic multi-file edits; costly capability tokens, weak undo, no edit approval |
| Exec / jobs | 2 | 3 | 3 | Exact approvals and a rich job model, but no default timeout, no rules, no user job control, Linux-only sandbox |
| Orchestration | 2 | 4 | 3 | Process-isolated subagents and durable plans; plan mode leaks writes and every step costs about 47k tokens |
| CLI UX | 3 | 3 | 3 | Editable queue, bisect, replay and attach; no onboarding, 2 s start, no steer, thin headless mode |
| Providers / SDK | 2 | 3 | 2 | Good failover and per-agent routing; no caching, 529 is terminal, cost mostly blank, SDK hard to adopt |
| Memory / context | 2 | 4 | 3 | Layered compaction with recall; `/compact` unreachable, instruction files root-only, memory carries metadata not decisions |
| Extensions (MCP, skills, hooks, ACP) | 2 | 2 | 3 | Hardened MCP provenance; no deferral, OAuth, lifecycle hooks or Markdown agents, and project config bypasses trust |
| Language intelligence | 2 | 3 | 2 | Honest plumbing and semantic edits; servers die each prompt, no diagnostics, queries missing from release builds |
| Web / media | 2 | 3 | 2 | Broadest browser tool of the set; SSRF bypass, a single scraped search backend, no direct fetch |
| Evals / quality loop | 2 | 2 | 1 | Unique head-to-head harness against rival CLIs; nightly is broken, no baseline gate, no feedback or telemetry |
| Roadmap / process | 1 | 2 | 2 | Precise cards with real fixes; 0.55–0.70 nodes/day, 13.8 GB of evidence, accepted work left uncommitted |

## Competitive gaps

Deduplicated across shards. P0 means users notice it in the first session or it costs money or safety. P1 is a clear competitive gap. P2 and P3 are nice to have.

| Capability | Who has it (how) | Openbuff state | Findings | Priority |
|---|---|---|---|---|
| Prompt caching on the main loop | Claude Code (automatic), Aider (`--cache-prompts` plus keepalive), Pi (cost-gated warming) | No markers sent | providers-sdk-01, memory-context-11 | P0 |
| Small or deferred tool surface | Pi (<1k tokens, codemode, `tool_search`), Claude Code `ToolSearch`, Kiro `tool_load`, OpenCode Code Mode | About 47k static tokens; MCP all declared | orchestration-02, extensions-01 | P0 |
| Read-only plan mode | Claude Code, Gemini `--approval-mode=plan`, OpenCode `plan` | Leaks through LSP edits, custom agents and basher | orchestration-01, exec-jobs-02 | P0 |
| In-session credential setup | Pi `/login`, OpenCode `/connect`, Gemini auth picker | Env var plus restart | cli-ux-01 | P0 |
| Fast startup | Pi-Bolt 41 ms, Codex <50 ms, Pi 0.42 s | 1.8–2.1 s, 210 MB | cli-ux-02 | P0 |
| Default shell timeout | Claude Code 2 min/10 min max, OpenCode 2 min plus auto-background | Unbounded, stdin open | exec-jobs-01 | P0 |
| Persistent allow/ask/deny rules | Kiro `permissions.yaml`, Claude `Bash(prefix *)`, OpenCode ordered rules | Allow once / Deny | exec-jobs-03 | P0 |
| Project trust gate | Kiro trust screen, Gemini trusted folders, Pi `defaultProjectTrust: ask` | Per-run flag; `openbuff.json` trusted implicitly | extensions-03, extensions-04 | P0 |
| Lifecycle hooks | Claude Code (~28 events), Codex (14), Gemini (11), Kiro (13), Pi (~40) | Post-edit verification only | extensions-07 | P0 |
| Bounded reads and listings | Claude Code (25k-token pages, Glob 100), OpenCode and Pi (2,000 lines / 50 KB) | 10 MB per read; `glob` unbounded | read-search-02, read-search-04 | P0 |
| Reliable or pluggable search, direct fetch | Gemini grounded search, Codex `web_search`, Claude/Gemini/Kiro/OpenCode fetch tools | DDG scrape only; fetch via sub-agent; SSRF bypass | web-media-evals-01, -03, -05 | P0 |
| File checkpoints plus combined rewind | Claude Code `/rewind`, Gemini shadow-git `/restore`, OpenCode `/undo` | Post-turn tracked-only snapshots; separate `/undo` | write-edit-02, memory-context-08 | P0 |
| Headless scripting surface | Codex `exec` (stdin, `--output-schema`, resume), Claude/Gemini `-p` stream-json, Pi RPC | Prompt, `--json` and `--timeout` only | cli-ux-03 | P0 |
| Eval regression gate | Pi-Bolt tool e2e gates; none of the others publish one | Nightly broken | web-media-evals-10, -11 | P0 |
| Price/window registry and cost view | OpenCode models.dev, Pi registry and footer, Aider per-message cost, Claude `/usage` | Blank for most routes | providers-sdk-03, providers-sdk-05, cli-ux-06 | P1 |
| Overload and rate-limit resilience | Claude Code retries overloads | 529 terminal; 8 s Retry-After cap | providers-sdk-02, -09 | P1 |
| Manual compact and LLM-quality summary | `/compact` in Claude, Codex, Kiro and Pi; Codex trained compaction; Pi structured summary | Unreachable; extractive only | memory-context-01, -05 | P1 |
| Hierarchical instruction files and `@imports` | Claude Code, Codex, OpenCode | One file per directory, root only | memory-context-04 | P1 |
| Post-edit diagnostics | Claude Code LSP after edits, Aider `--auto-lint`/`--auto-test` | None from LSP; hooks opt-in | language-intel-04, write-edit-05 | P1 |
| Session-scoped language servers and auto-install | Claude Code plugins, OpenCode V1 | Per-prompt, PATH only | language-intel-01, -07 | P1 |
| Per-model edit format | Aider format table, OpenCode `patch` for GPT, oh-my-pi hashline | One surface for all models | write-edit-08, write-edit-01 | P1 |
| Edit approval and protected paths | Claude acceptEdits, Gemini autoEdit, Kiro Supervised with `.git/**` always-ask | None | write-edit-03 | P1 |
| OS sandbox on by default | Codex (Seatbelt, bwrap+seccomp, Windows user) | Off; Linux x64 opt-in with manual binary | exec-jobs-07 | P1 |
| Network allowlist | Claude proxy allowlist, Kiro `COMMON_DEPENDENCIES` | All or nothing | exec-jobs-07 | P1 |
| User job and agent panel | Claude `/tasks`, Kiro Ctrl+G, Codex `/agents`, OpenCode idle push | Tool card only; background agents poll-only | exec-jobs-08, orchestration-05 | P1 |
| Markdown subagents with turn/time limits | Claude, Gemini (`max_turns` 30, `timeout_mins` 10), OpenCode, Kiro | TS modules; no bounds | orchestration-04, -06 | P1 |
| Cheap-model role for helper agents | Claude Explore→Haiku, Aider weak model, Pi virtual models | Everything uses `defaultModel` | orchestration-07 | P1 |
| Steer vs queue | Codex Enter/Tab, OpenCode, Pi | Queue only | cli-ux-04 | P1 |
| Session fork, tree, rename, export | Pi `/tree` `/fork` `/export`, Codex `/rename` and `fork --worktree` | Edit-fork in place; text export | cli-ux-05, memory-context-08 | P1 |
| MCP OAuth and config UX | Every reference CLI with MCP; `claude/codex/pi mcp add`, `/mcp` | Static headers; strict, undocumented `mcp.json` | extensions-02, -10 | P1 |
| ACP rich prompts | Gemini `--acp`, OpenCode `acp`, Kiro | Text blocks only | extensions-08 | P1 |
| Skills with bundled resources | Claude/Agent Skills | Skill directory not returned | extensions-06 | P1 |
| Provider breadth and subscription logins | Pi (Claude Pro/Max, ChatGPT, Copilot), OpenCode, Codex (Bedrock/Vertex/OSS) | 3 wire types, 9 stale presets, no headers | providers-sdk-06, -07, -10 | P1 |
| Reasoning control on Claude | Codex, Aider `/think-tokens`, Pi `/thinking` | Ignored on Claude routes | providers-sdk-04 | P1 |
| PDF, notebook and image downscale | Claude Read (`pages`, `.ipynb`, auto-downscale), Gemini PDF/audio, Pi resize | Refused or raw bytes | read-search-05, -06, web-media-evals-09 | P1 |
| Public benchmark results | OpenCode, Claude Code, Pi (Terminal-Bench 2.0), Aider polyglot | None | web-media-evals-12 | P1 |
| Feedback capture and OpenTelemetry | Claude, Codex, Gemini OTel | Feedback disabled, no OTel | web-media-evals-13 | P1 |
| Windows shell and CI | Claude and Pi PowerShell tools, Codex Windows sandbox, Pi-Bolt Windows build | Git Bash via env var; build smoke only | exec-jobs-12, cli-ux-12 | P1 |
| Ranked repo map | Aider (tree-sitter plus PageRank, 1k tokens) | Unranked prototype | read-search-11, language-intel-13 | P2 |
| Interactive PTY | Codex `write_stdin`, Gemini node-pty | None | exec-jobs-19 | P2 |
| `@file:line`, `$EDITOR`, vim, keymap | Claude, Gemini, OpenCode, Codex | None | cli-ux-08 | P2 |
| Plugin/package distribution, hot reload | Claude plugins, Pi packages, Gemini extensions, Pi `/reload` | `/publish` stub; restart required | extensions-04, orchestration-06 | P2 |
| Statusline, themes, native scrollback | Claude scriptable statusline, Codex themes, pi-tui | Hardcoded, dark/light, alternate screen | cli-ux-10, -16 | P3 |

## Strengths to keep

- **Edit safety.** Edits preflight everything, commit through a CAS broker with fsync and post-commit hashes, and recover with per-file receipts. Stale-file checks run at three hash layers. No-match errors carry ranked candidates. Localized edits preserve bytes, BOM and EOL (write-edit strengths).
- **Content-anchored and symbol reads.** `around`, `symbol(s)` and tree-sitter `read_outline` avoid line-number drift. Read errors are typed with `code`/`retryable`/`recovery` (read-search strengths).
- **Approval integrity.** Grants are single-use and bound to the command hash plus the execution context. The compound-command classifier fails closed, even in allow-all. Credentials are scrubbed after the env merge (exec-jobs strengths; B18 and B19 verified at HEAD).
- **Background jobs.** Cursored events, `wait_for` follow, loop-breaker hints, cross-session recovery and `touchedPaths` attribution of shell edits (exec-jobs strengths).
- **MCP hardening.** WeakMap-held origin, untrusted-description labels, DNS pinning and SSRF refusal, `allSettled` discovery, honest catalogs and hashed aliases (extensions strengths; B28 fixes verified).
- **Multi-provider BYOK.** Per-mode and per-agent routing and reasoning, failover with a delivery gate, vision rerouting for non-vision models, text-tool fallback, and ChatGPT and OpenCode Go transports (providers-sdk, web-media-evals, orchestration strengths).
- **Process-isolated subagents and durable plans.** Supervised child processes with group teardown, lossless oversize child output, and SPEC/PLAN/STATUS/LESSONS packets that survive across days (orchestration strengths).
- **Governed, recoverable compaction.** Free eviction first, an anti-thrash governor, an archived pre-image with `recall_context`, read authority revoked after compaction, and an honest compaction UI (memory-context strengths).
- **Unique CLI tools.** `/bisect-turn`, safe token-bound `/restore`, an editable queue, `openbuff replay`/`dash`, ACP attach/detach, and the headless JSON failure contract (cli-ux strengths).
- **Openbuff as a server.** `openbuff mcp` exposes the index read-only to other agents, and `openbuff serve` speaks ACP with socket auth (extensions strengths).
- **Index transparency.** `/index explain`, coverage and parser-budget reporting, and opt-in SCIP (language-intel strengths).
- **Evaluation design.** BuffBench runs Claude Code, Codex and OpenCode on the same tasks with the same judges. Compaction and memory evals are deterministic. A reachability test fails when a tool is unusable by every agent (web-media-evals strengths).
- **Browser breadth.** About 25 CDP actions, pixel diff, APNG recording and design tokens (web-media-evals strengths).

## Minimalism vs breadth

`competitors/B.md` §7 concludes that breadth helps only when it is deferred. Spend on tool quality rather than tool count, keep the declared core small and stable, and measure harness overhead. Openbuff currently does the opposite. base2 declares 42 tools (21,938 tokens), a 33-agent catalog with full JSON contracts (11,442), an 11,006-token system prompt, 1,822 tokens of instructions and 751 of step prompt. That totals about 47k tokens before any user content (orchestration-02), and none of it is cached (providers-sdk-01). Terminal-Bench 2.0 shows a tmux-only harness beating Claude Code and OpenCode on the same model (B.md §7), so the declared surface is not buying score.

Recommendation. Tool names are those cited by the shards; token figures are shard measurements or estimates.

**Keep in the declared core (target about 15 tools).**
- Reading: `read_files`, `read_outline`, `glob`, `list_directory`, `code_search`, `query_index`.
- Editing and running: `edit_transaction`, one shell route (`run_terminal_command`, with basher kept as an opt-in "summarize output" helper).
- Agents and planning: `spawn_agents`, `write_todos` (with ids, status and `depends_on`).
- Other: `ask_user`, `skill`, a new `web_fetch` split out of `web_search`, and `read_image` moved out of the 3D tier.
- Trim descriptions as you keep them. `code_search` goes from 4.5 KB to about 1.5 KB with its false lines removed. The capability narrative moves out of `read_files`. `owner` and the 30-field output union come out of `run_terminal_command`. Read policy is stated once.

**Merge.**
- `check_job`, `list_jobs`, `kill_job` and `check_background_agent` into one `jobs` tool (or keep the three job tools and fold background agents into them).
- `read_logs` into `check_job`/`read_files`, with `offset`/`grep`.
- `inspect_workspace` and `inspect_environment` into one tool, or into first-turn context.
- `read_files` selectors down to `paths`, `ranges`, `around` and `symbols` (read-search-09).

**Defer** behind `progressiveToolDisclosure` and a `tool_search`/`tool_load` tool:
- The audit trio and `get_change_review_bundle` (about 1.2k tokens; the gate already calls the bundle programmatically).
- The 3D tier (about 1.5k).
- The LSP read and edit tools (about 1.4k), exposed only when a server for a workspace language is detected.
- `browser_logs`, `read_docs` and `web_search` query mode.
- `git_status`/`git_branch` (the shell covers them).
- `create_plan`, `update_plan_status` and `get_task` (about 3.3k), plan mode and execute-plan only.
- All MCP tools above a token threshold, with per-server `direct|deferred|hidden` exposure.

**Make programmatic-only:** `run_targeted_validation`, `get_affected_tests`, `get_build_targets` and `run_file_change_hooks` (the base2 gate already calls them).

**Drop:**
- `find_files`, `find_files_matching_content` (quarantined; `find_files` still calls a hosted Vertex model).
- `add_subgoal`, `update_subgoal`, `think_deeply` and `end_turn` (unreachable).
- `render_ui`, or restrict it to the interactive CLI host (about 390 tokens for one button).
- The standalone `str_replace`/`write_file`/`replace_range`/`rewrite_symbol` registrations for new sessions.

**Catalog:** one line per agent, with contracts served through `lookup_agent_info`. That saves an estimated 9–10k tokens.

**Prompt:** remove the duplicated tier/capability paragraph and the "never spawn context-pruner" line. Keep one system prompt and tool list across modes so the cache prefix survives the plan→execute switch (orchestration-08).

Estimated result: about 47k down to roughly 20–25k fixed tokens, then about 90% cheaper on repeat steps once caching works. Lock the result in with a CI budget for system + tools + catalog + instructions. Keep the breadth. It is the product's advantage over Pi, but load it only when needed.

## Findings index

Severity is as reported by the shard. "See X" marks a duplicate or near-duplicate; the primary entry carries the fix.

### Read / search (`findings/read-search.md`)
- read-search-01 · HIGH · Memory-first short-circuit returns fabricated glob, list_directory and code_search results
- read-search-02 · HIGH · `read_files` has no model-facing size cap (10 MB per result)
- read-search-03 · MEDIUM · Context trim strips read content but keeps `complete:true` and edit authority
- read-search-04 · MEDIUM · `glob` is unbounded, with no limit/offset
- read-search-05 · MEDIUM · PDFs, notebooks and non-UTF-8 text get misleading or no support
- read-search-06 · MEDIUM · `read_image` sends raw bytes and advertises BMP/TIFF (see also web-media-evals-09)
- read-search-07 · MEDIUM · Read/search definitions cost about 7.8k tokens; code_search prose duplicated and inaccurate (part of orchestration-02)
- read-search-08 · MEDIUM · Contradictory selection guidance between schema and tool descriptions
- read-search-09 · LOW · Quarantined tools still registered; read_files has six selector kinds
- read-search-10 · LOW · Path-listing inconsistencies in glob and list_directory
- read-search-11 · LOW · Retrieval is CLI-only; Aider-style repo map unwired (see also language-intel-13)
- read-search-12 · LOW · Missing-file errors give no candidates

### Write / edit (`findings/write-edit.md`)
- write-edit-01 · HIGH · Read-capability tokens are the dominant model-facing cost and failure mode
- write-edit-02 · HIGH · Turn snapshots miss pre-turn state, agent-created files and cancelled turns
- write-edit-03 · MEDIUM · No approval, preview or protected paths for file mutations
- write-edit-04 · MEDIUM · Near-match auto-correct applies 92%-similar edits silently
- write-edit-05 · MEDIUM · Post-edit feedback is opt-in and gate-only; docs contradict code
- write-edit-06 · MEDIUM · Whole-file writes drop the BOM and convert CRLF to LF
- write-edit-07 · LOW · Many edit surfaces, one exposed; stale `cap.v3` names in guidance
- write-edit-08 · MEDIUM · No per-model edit format or per-model edit-success eval
- write-edit-09 · LOW · Snapshot ref and intent log store plaintext; receipts unbounded
- write-edit-10 · MEDIUM · Prior 06-F* residuals at HEAD (06-F10, 06-F12 still present)

### Exec / jobs (`findings/exec-jobs.md`)
- exec-jobs-01 · HIGH · No default timeout and open stdin, so prompting commands hang
- exec-jobs-02 · HIGH · Per-agent terminal profiles are dead code; plan mode runs any shell via basher (pairs with orchestration-01)
- exec-jobs-03 · HIGH · No persistent allow/deny rules; only "Allow once" or "Deny"
- exec-jobs-04 · MEDIUM · Repo `openbuff.json` can likely set `approvalMode: allow-all` (inferred; see extensions-03)
- exec-jobs-05 · MEDIUM · Balanced-mode copy says unclassified effects ask; they run
- exec-jobs-06 · MEDIUM · Approval prompt shows only the first effect
- exec-jobs-07 · MEDIUM · OS sandbox off by default, Linux-only; network all-or-nothing
- exec-jobs-08 · MEDIUM · No TUI list/watch/kill for background jobs (pairs with orchestration-05)
- exec-jobs-09 · MEDIUM · Attached jobs likely outlive CLI exit (inferred)
- exec-jobs-10 · MEDIUM · Spool and job-log temp artifacts leak
- exec-jobs-11 · MEDIUM · Truncated output stored as single-line JSON; read_logs only tails
- exec-jobs-12 · MEDIUM · Windows/macOS gaps: Git Bash auto-detect dead, no PowerShell, partial tree kill (see also cli-ux-12)
- exec-jobs-13 · LOW · kill_job reports killed before confirmation
- exec-jobs-14 · LOW · Terminal schema heavy and contradictory (part of orchestration-02)
- exec-jobs-15 · LOW · Two shell routes; git_branch refuses dirty trees (see also orchestration-08)
- exec-jobs-16 · LOW · get_affected_tests graph tier always empty
- exec-jobs-17 · LOW · Live job output truncated head-first in forwarder, tail-first in CLI
- exec-jobs-18 · LOW · Cancelling a SYNC command discards its output
- exec-jobs-19 · LOW · No PTY/interactive input; no cwd/env persistence
- exec-jobs-20 · LOW · Shell shims documented but not implemented

### Orchestration (`findings/orchestration.md`)
- orchestration-01 · HIGH · Plan mode is not read-only (LSP mutation tools, custom agents, no lineage gate)
- orchestration-02 · HIGH · About 47k static tokens per step; disclosure mechanism off
- orchestration-03 · MEDIUM · Five overlapping planning surfaces, two unwired
- orchestration-04 · MEDIUM · Subagents have no default step/turn/time bound and cannot define one
- orchestration-05 · MEDIUM · Background agents are poll-only, invisible and session-bound
- orchestration-06 · MEDIUM · Custom agents are TS-only; public type carries hosted leftovers; dead publish UI
- orchestration-07 · MEDIUM · No cheap-model role for helper agents
- orchestration-08 · LOW · Shell surface and system prompt change between modes, breaking the cache
- orchestration-09 · LOW · Prompt leaks harness internals and repeats itself (part of orchestration-02)
- orchestration-10 · LOW · Docs drift on orchestration contracts

### CLI UX (`findings/cli-ux.md`)
- cli-ux-01 · HIGH · No guided first run; keys cannot be entered in the TUI
- cli-ux-02 · HIGH · About 2 s to ready, 210 MB idle; `--version` 0.83 s
- cli-ux-03 · HIGH · Headless `openbuff run` lacks stdin, model, resume and schema
- cli-ux-04 · MEDIUM · Cannot steer a running turn; Enter always queues
- cli-ux-05 · MEDIUM · Thin session management; 100-message transcript cap still present (01-F7)
- cli-ux-06 · MEDIUM · No `/usage` or `/cost`; cost chip hides itself (`/compact` part: see memory-context-01)
- cli-ux-07 · MEDIUM · Slash catalog drift; weak inline discovery; `/help` lists no commands
- cli-ux-08 · MEDIUM · No `@file:line`, `$EDITOR`, vim mode or keymap; Tab overloaded
- cli-ux-09 · MEDIUM · Ctrl+V runs up to four sync clipboard subprocesses on the UI thread
- cli-ux-10 · LOW · Two themes; custom theme code unwired; status line fixed
- cli-ux-11 · LOW · Possible auto-send of a queued prompt after interrupt (unverified)
- cli-ux-12 · LOW · Windows support is build smoke only (see also exec-jobs-12)
- cli-ux-13 · LOW · `openbuff init` advertised but not parsed as a subcommand
- cli-ux-14 · LOW · Non-prod builds print an env banner on stdout
- cli-ux-15 · LOW · Unwired components and code
- cli-ux-16 · LOW · Alternate screen loses native scrollback; per-chunk work is O(messages)

### Providers / SDK (`findings/providers-sdk.md`)
- providers-sdk-01 · HIGH · Main agent stream never sends prompt-cache markers
- providers-sdk-02 · HIGH · Anthropic 529 fails the turn with no retry or failover
- providers-sdk-03 · HIGH · Cost tracking blank for most BYOK routes and wrong where it runs (02-F3 still present)
- providers-sdk-04 · MEDIUM · Reasoning effort ignored on Claude routes; subscription route defaults to low
- providers-sdk-05 · MEDIUM · Context windows unknown for every preset; local models overflow silently
- providers-sdk-06 · MEDIUM · Three wire types, no headers, one subscription login
- providers-sdk-07 · MEDIUM · Presets stale and inconsistent
- providers-sdk-08 · MEDIUM · Failover on 401/403 nearly silent and repeated per request
- providers-sdk-09 · MEDIUM · Retry-After capped at 8 s
- providers-sdk-10 · MEDIUM · Local endpoint rules block LAN/Docker/WSL; `[::1]` never matches
- providers-sdk-11 · MEDIUM · SDK hard to adopt: no per-run model, internals-first README, broken examples
- providers-sdk-12 · LOW · Hosted-Codebuff residue reachable from the BYOK SDK
- providers-sdk-13 · LOW · Example config includes missing files; missing includes skipped silently

### Memory / context (`findings/memory-context.md`)
- memory-context-01 · HIGH · `/compact` rejected by the CLI while recovery text recommends it
- memory-context-02 · HIGH · Memory V2 lifecycle only partly repaired (04-F3, F5, F9 open)
- memory-context-03 · MEDIUM · Verified procedures stop applying; scope ignored (04-F6–F8)
- memory-context-04 · MEDIUM · Instruction files: one per directory, nested dropped, no imports, double injection
- memory-context-05 · MEDIUM · "Semantic" compaction is extractive but labelled LLM
- memory-context-06 · MEDIUM · Compaction silently skips custom agents; pruner failures only logged
- memory-context-07 · MEDIUM · Overflow recovery recognises three wordings, retries once
- memory-context-08 · MEDIUM · No fork/branch; separate code and conversation rewind (code side: see write-edit-02)
- memory-context-09 · MEDIUM · Transcript capped at 100 messages before save (see cli-ux-05)
- memory-context-10 · MEDIUM · Later snapshot can shadow original-body recall (04-F4)
- memory-context-11 · LOW · No cache warming; compaction rewrites the cached prefix (see providers-sdk-01)
- memory-context-12 · LOW · `/memory` expert-only; no "remember this" to a readable file

### Extensions (`findings/extensions.md`)
- extensions-01 · HIGH · Every MCP tool declared on every request; no deferral or search
- extensions-02 · HIGH · `mcp.json` undocumented, strict, and one bad entry drops the file
- extensions-03 · HIGH · Project `openbuff.json` trusted for hook commands and credential providers
- extensions-04 · HIGH · Trust is a per-run flag with no prompt or persistence; `/init` agents don't load
- extensions-05 · MEDIUM · `skill` disk fallback bypasses trust and reverses precedence
- extensions-06 · MEDIUM · Skill results omit the skill directory
- extensions-07 · HIGH · No general lifecycle hooks
- extensions-08 · HIGH · ACP prompts keep only text; editor `@file` mentions dropped
- extensions-09 · MEDIUM · External-CLI wrappers scrape TUIs via a repo-relative script (10-F5, 10-F10)
- extensions-10 · MEDIUM · No MCP OAuth, resources, prompts or sampling
- extensions-11 · LOW · MCP and custom tools default to `endsAgentStep: true`
- extensions-12 · LOW · Extension docs drift; missing user docs (10-F11)
- extensions-13 · MEDIUM · Agent discovery imports auxiliary modules (10-F3)

### Language intelligence (`findings/language-intel.md`)
- language-intel-01 · HIGH · Language servers live for one prompt; no readiness tracking
- language-intel-02 · HIGH · `workspace_symbol` returns empty success when cold
- language-intel-03 · HIGH · Mixed 0/1-based position conventions
- language-intel-04 · HIGH · LSP diagnostics never collected (see also write-edit-05)
- language-intel-05 · HIGH · Release tarball ships no tree-sitter queries (07-F1)
- language-intel-06 · MEDIUM · Index persistence at its 64 MB ceiling on a 2.7k-file repo
- language-intel-07 · MEDIUM · LSP tools advertised unconditionally; no detection, install path or docs
- language-intel-08 · MEDIUM · No base2 guidance on LSP tools; usage never measured
- language-intel-09 · MEDIUM · Monorepo roots exceed the 4-server pool (07-F6, 07-F8)
- language-intel-10 · MEDIUM · LSP results unbounded and verbose
- language-intel-11 · HIGH · `inspect_codebase_structure` ignores `.gitignore`, blocks, returns megabytes
- language-intel-12 · MEDIUM · Review bundle and audit trio heavy as always-on tools
- language-intel-13 · LOW · PageRank and repo map rank nothing (see read-search-11)
- language-intel-14 · MEDIUM · Prior 07-F2–F9 all still present

### Web / media / evals (`findings/web-media-evals.md`)
- web-media-evals-01 · HIGH · SSRF guard bypassed by IPv4-mapped IPv6 (confirmed live)
- web-media-evals-02 · MEDIUM · DNS check and connect are separate lookups
- web-media-evals-03 · HIGH · Search is a single keyless DDG scrape; blocks look like empty results
- web-media-evals-04 · MEDIUM · Web fetch flattens pages and decodes binaries as text
- web-media-evals-05 · MEDIUM · No direct fetch for the main agent
- web-media-evals-06 · MEDIUM · `read_docs` reports every failure as "No documentation found"
- web-media-evals-07 · MEDIUM · Browser read-only policy has two sources of truth (13-F1)
- web-media-evals-08 · LOW · `render_ui` acknowledges renders that never happened (13-F9)
- web-media-evals-09 · MEDIUM · Model and user image paths use different pipelines (see read-search-06)
- web-media-evals-10 · HIGH · `[buffbench]` workflow and eval scripts point at deleted files
- web-media-evals-11 · HIGH · Nightly eval targets a nonexistent agent; no baseline
- web-media-evals-12 · MEDIUM · No public benchmark results or harness
- web-media-evals-13 · MEDIUM · No user feedback input or telemetry export
- web-media-evals-14 · MEDIUM · CI matrix omits `packages/code-map`
- web-media-evals-15 · LOW · Docs drift for researcher-web; README silent on web/media
- web-media-evals-16 · LOW · Root and evals hygiene (`.tmp/` not ignored, dual lockfiles, tracked error JSON)

### Roadmap / process (`findings/roadmap-process.md`)
- roadmap-process-01 · HIGH · Throughput fell to 0.55–0.70 nodes/day; 39–49 days left at that rate
- roadmap-process-02 · HIGH · 13.8 GB / 64,686 files of evidence (~600:1 vs product lines); disk at 98%
- roadmap-process-03 · HIGH · Renewal churn: 75–85% of promotion effort re-certifies prior nodes
- roadmap-process-04 · HIGH · Accepted B19/B20 work and the live ledger are uncommitted
- roadmap-process-05 · MEDIUM · STATE.md unreadable for humans; no changelog
- roadmap-process-06 · HIGH · Accepted work is all reliability/assurance; ready usability cards idle
- roadmap-process-07 · HIGH · No cards for onboarding, latency, prompt size, cross-platform, common UX
- roadmap-process-08 · MEDIUM · Acceptance demands OS/timing proofs beyond user need
- roadmap-process-09 · LOW · Bespoke Python process tooling, untested in CI

Totals: 145 findings. 39 are HIGH, of which 33 are product findings and 6 are process findings. 71 are MEDIUM and 35 are LOW.

## Limits

- **Probed (code executed by a shard):**
  - read-search-01 (in-process memory probe), read-search-02 (3–4 MB reads), read-search-04 (glob counts on this repo).
  - providers-sdk-01, -02, -03 and -04 (fake-provider wire probes).
  - web-media-evals-01 (live loopback SSRF).
  - cli-ux-02 (tmux startup timings with a binary built 2026-11-10, which may lag HEAD).
  - orchestration-02 (repo token counter), write-edit-01 (token sizes).
  - language-intel-06 and -11 (index build and inspect probes), extensions-02 (`safeParse` probe).
  - The existing tests the shards ran: read-search 135, orchestration 140 and language-intel LSP 90, all passing. code-map ran 170 pass and 2 fail (GDScript).
- **Inferred from code, not executed:**
  - exec-jobs-04, exec-jobs-09, extensions-03 and orchestration-01. These are static, but each has strong evidence.
  - read-search-03, write-edit-06, cli-ux-11, cli-ux-13, language-intel-09, and the providers-sdk-11 example failure.
  - All claims about TypeScript, Rust, Python or Go language servers. Only clangd was installed.
- **Estimates:** the cost figures in providers-sdk-01 come from list prices, not billing. The roadmap finish dates are extrapolations. The token savings in "Minimalism vs breadth" are summed from shard measurements and are approximate.
- **Not covered by any shard:**
  - Live model turns of any kind.
  - Real-provider calls and OAuth refresh.
  - Tool-renderer internals in `cli/src/components/tools/*`.
  - ACP session and approval internals (B17).
  - Rust crate internals beyond feature level.
  - `agents-graveyard/`.
  - Runtime behaviour on macOS and Windows.
  - `rust/` plugin host, Notion agents, 3D tool internals (B35), and the full `browser-logs.ts` CDP implementation.
  - See `STATUS.md` for the directory-level coverage map.
- **Competitor facts** come from `competitors/A.md` and `B.md` (dated 2026-11-12). They were not independently re-verified here. Some, such as the Codex `prompt_cache_key` detail and Pi's Terminal-Bench placing, are marked lower-confidence in their sources.
- **Synthesis inputs:** this synthesis read the shard files and the roadmap card table and ledger only. Where shards disagree, the more specific evidence was preferred. For example, memory-context-02 reports 04-F1 and 04-F2 fixed even though B12 is still pending.
