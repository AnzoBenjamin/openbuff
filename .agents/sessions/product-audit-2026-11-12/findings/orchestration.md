# Shard `orchestration` — product audit 2026-11-12

Snapshot: working tree at audit time (dirty tree, read-only inspection). All measurements were taken with throwaway `bun test` scripts under `/tmp/orch-audit/` that import repo modules and write nothing to the repo. They use the repo's own `countTokens`/`countTokensJson` (`packages/agent-runtime/src/util/token-counter.ts`), the same counter `agents/__tests__/base2-context-budget.test.ts` uses. I checked `git status` afterwards: no tracked or untracked files were touched.

## Scope

Inspected:
- Runtime: `packages/agent-runtime/src/run-agent-step.ts` (budget/termination and output-correction windows), `run-programmatic-step.ts` (catch/termination), `templates/prompts.ts`, `templates/strings.ts` (agent catalog addendum), `util/base2-tool-tiers.ts`, `util/background-agent-jobs.ts`, and `orchestration/{workflow-engine,select-agent-attempt,discovery-coordinator}.ts` (headers and call sites). Supervision: `supervision/process-supervisor.ts` (deadline contract) and `supervised-spawn.ts` (launchability and deadline arming).
- Tool handlers: `spawn-agent-utils.ts` (permission, depth, deadline, truncation and supervised windows), `spawn-agents.ts` (capacity), `check-background-agent` (schema), `create-plan.ts`, `end-turn.ts`, `rename-symbol.ts`. Schemas in `common/src/tools/params/tool/`: spawn-agents, create-plan, write-todos, add-subgoal, update-subgoal, get-task, update-plan-status, check-background-agent, rename-symbol, code-action, extract-symbol.
- Agents: `agents/base2/base2.ts` (template body lines 240–830 and plan prompts 15399–15482), `base2-plan.ts`, `base2-execute-plan.ts`, `base2-fast.ts`, `tool-tiers.ts`, `agents/basher.ts`, `general-agent.ts` (tools), and `context-pruner.ts` (header). Tests: `agents/types/agent-definition.ts`, `agents/tool-reachability.test.ts`, `agents/__tests__/base2-mode-policy.test.ts`, `base2-context-budget.test.ts`, and `base2-progressive-tool-disclosure.test.ts`.
- SDK and CLI: `sdk/src/agents/load-agents.ts`, `sdk/src/impl/agent-runtime.ts` (supervision default), `sdk/src/run.ts` (mutating-tool set), `sdk/src/provider-config.ts:2055`, `cli/src/utils/local-agent-registry.ts`, `cli/src/utils/constants.ts` (modes), `cli/src/commands/command-registry.ts` (command list, plan and publish commands), `cli/src/data/slash-commands.ts`, `cli/src/hooks/use-chat-input.ts`, `cli/src/components/build-mode-buttons.tsx`, `agent-mode-toggle.tsx` (labels), `agent-checklist.tsx`, `chat-input-bar.tsx`, `cli/src/cli-args.ts:290`.
- Docs: `docs/agents-and-tools.md` (sections 1–125 plus heading map), `docs/architecture.md` (handleSteps mentions), `docs/local-mode.md:120–215`.
- Prior work: `body-capability-review-2026-11-05/findings/03-orchestration.md`, `findings/01-cli.md` (F8), `PLAN.md` card list, `docs/execution/body-roadmap/STATE.md`.
- Executed (existing tests, read-only): 8 files, 140 pass / 0 fail. The files were `spawn-settle-fault-injection`, `background-agent-jobs`, `spawn-depth`, `loop-agent-steps-abort`, `spawn-agent-utils-cancel`, `create-plan`, `update-plan-status`, and `end-turn-pending-jobs`.

Skipped, with reasons:
- I did not read most of the `base2.ts` generator body (lines 840–15398: gate logic). It is gate internals already covered by 03-orchestration, and the tool and prompt surface is what this shard evaluates.
- `tool-executor.ts`, `stream-parser.ts` and `tool-stream-parser.ts` were checked only by grep for planOnly and spawn validation. Parser fidelity belongs to the tools/streaming shard.
- `plan-session-picker-screen.tsx` and `cli/src/commands/plan-*.ts` were not re-audited. 01-CLI already traced them and 01-F1 and 01-F8 cover them.
- Thinker, reviewer, file-explorer and librarian internals were checked only for their tool lists, via the generated bundle.
- I ran no live provider or LSP probes, so the plan-mode mutation finding is static.

## Feature inventory

| feature | entrypoint | implementation | tests | maturity |
|---|---|---|---|---|
| Default orchestrator (base2, 42 tools, 33 visible spawnable agents) | CLI mode DEFAULT → `base2` (`cli/src/utils/constants.ts:109`) | `agents/base2/base2.ts:245-830`, `tool-tiers.ts:153` | `agents/tool-reachability.test.ts`, `base2-context-budget.test.ts` | useful |
| Foreground subagent spawn (batch ≤12, depth ≤3) | `spawn_agents` (`common/.../spawn-agents.ts`) | `spawn-agents.ts`, `spawn-agent-utils.ts:4298-4310` | `spawn-depth`, `spawn-agents-permissions`, `spawn-settle-fault-injection` | useful |
| Inline spawn (programmatic, history-editing) | `spawn_agent_inline` (programmatic-only) | `spawn-agent-inline.ts` | `spawn-agent-inline-nesting.test.ts` | useful (internal) |
| Background subagents (≤32 global / ≤8 per root) | `spawn_agents{background:true}` + `check_background_agent` | `util/background-agent-jobs.ts:76-77,440-455` | `background-agent-jobs.test.ts` | partial (poll-only, no user UI) |
| Process-supervised subagents | SDK default on Bun/POSIX (`sdk/src/impl/agent-runtime.ts:104-125`) | `supervision/*` | `supervised-bridge-e2e`, `supervised-restart` | useful |
| Oversize child output → temp artifact pointer | automatic | `spawn-agent-utils.ts:1112-1160` | `spawn-agent-utils-output.test.ts` | useful |
| Plan mode (durable SPEC/PLAN/STATUS/LESSONS) | DEFAULT↔PLAN toggle, `/mode:plan` | `base2-plan.ts`, `base2.ts:15399-15479`, `create_plan`, `update_plan_status` | `create-plan.test.ts`, `update-plan-status.test.ts` | partial (not read-only: F01) |
| Plan → execute handoff | "Execute Plan" button (`build-mode-buttons.tsx:56`), `/resume-plan` | `use-chat-input.ts:89-94`, `command-registry.ts:1278-1310` | `session-route-recovery.test.tsx` (per 01-CLI) | useful |
| Plan session commands | `/plans`, `/plan-use`, `/plan-status`, `/plan-artifact`, `/update-plan`, `/lessons` | `cli/src/commands/plan-artifacts.ts` | 01-CLI | partial (`/plans`, `/plan-use` not in menu, 01-F8) |
| Todo list | `write_todos` | `write-todos.ts` | (renderer `cli/src/components/tools/write-todos.tsx`) | useful |
| Durable task read | `get_task` | `get-task.ts` | — | partial (overlaps plan tools) |
| Subgoals | `add_subgoal` / `update_subgoal` | `add-subgoal.ts`, `update-subgoal.ts` | — | unwired (no agent exposes them) |
| `think_deeply`, `lookup_agent_info`, `end_turn` | tool registry | handlers present | `end-turn-pending-jobs.test.ts` | unwired for every shipped agent (only listed in `tool-tiers.ts` policy) |
| Custom agents (`.agents/*.ts`) | `/init`, `--agent <id>`, `@` menu | `sdk/src/agents/load-agents.ts:64`, `cli/src/utils/local-agent-registry.ts:441-455` (auto-spawnable from `base*`) | loader tests | useful (TS-only) |
| Agent publishing | `/publish` | `command-registry.ts:1207-1213` (stub), `publish-container.tsx`, `agent-checklist.tsx` | — | unwired (dead UI) |
| Per-agent model routing | `openbuff.json` `modes`/`agents`/`defaultModel`, `/models set agent …` | `sdk/src/impl/model-provider.ts`, `provider-config.ts:2055` | sdk tests | useful |
| Progressive tool disclosure (tiers) | `programmaticConfig.progressiveToolDisclosure` | `util/base2-tool-tiers.ts` | `base2-progressive-tool-disclosure.test.ts` | unwired (pinned `false`, `base2.ts:488`) |
| Workflow engine | — | `orchestration/workflow-engine.ts` (telemetry-only by its own header) | `workflow-engine.test.ts` | partial (advisory) |
| Terminal outcome truth (prior 03-F1/F2) | loop | `run-agent-step.ts:697,1015` (`termination: 'budget_exhausted'`), `run-programmatic-step.ts:789` (`cancelled`/`failed`) | `loop-agent-steps-abort.test.ts` | useful (B02 accepted) |

## Findings

### orchestration-01: Plan mode is not read-only. The root exposes three LSP mutation tools, and no mutation handler checks plan lineage
- **Axis:** reliability (security/state-mutation) and cohesion. **Severity:** HIGH. The exposure is confirmed statically; it was not exercised against a live LSP.
- **Evidence:**
  - `packages/agent-runtime/src/util/base2-tool-tiers.ts:69-82` puts `rename_symbol`, `code_action` and `extract_symbol` in the `implement` tier.
  - `agents/base2/tool-tiers.ts:124-140`: `modeAllowsTool` withholds only `edit_transaction`, `edit_3d_asset`, `run_targeted_validation`, `run_terminal_command` and `write_todos` in plan mode. Measured base2-plan surface: 38 tools, including `rename_symbol`, `code_action`, `extract_symbol` and `kill_job`.
  - The schemas say these tools apply edits: `common/src/tools/params/tool/rename-symbol.ts:21` ("applies the returned WorkspaceEdit through the workspace mutation broker"), and the same wording in `code-action.ts:20` and `extract-symbol.ts:20`. `sdk/src/run.ts:230-240` lists them as mutating tools.
  - The handler forwards with no gate (`packages/agent-runtime/src/tools/handlers/tool/rename-symbol.ts:11-34`).
  - Grepping `planOnly` across `packages/agent-runtime/src`, `sdk/src` and `common/src` finds only `browser-logs.ts:38` and `spawn-agent-utils.ts:512-523`. The latter downgrades only `terminalPermissionProfile` for children.
  - `cli/src/utils/local-agent-registry.ts:441-455` auto-adds every user `.agents/` agent to every `base*` template, including `base2-plan`. A custom agent with `edit_transaction` therefore runs with full write authority under plan mode.
  - Gap in the existing tests: the plan-only reachability test (`agents/tool-reachability.test.ts`, "plan-only excludes project execution") asserts only `edit_transaction`, the legacy edit tools and `run_*`.
  - The plan prompt claims a boundary the runtime does not enforce: `base2.ts:15413` says "Plan mode must not edit project source".
- **Impact:** A user who picks PLAN expects no source changes, which is how Claude Code, Gemini CLI and OpenCode `plan` behave. The model can rename symbols across the workspace, organize imports, extract files, or delegate to a writing custom agent.
- **Suggested fix:** Add the three semantic-edit tools (and `kill_job` unless intended) to `MODE_GATED_TOOL_NAMES`, denied when `planOnly`. Add one runtime check at mutation dispatch (the broker entry, or `tool-executor` for every tool in `DIAGNOSTIC_BASELINE_TOOL_NAMES` other than `create_plan`/`update_plan_status`) that refuses when the agent's lineage has `programmaticConfig.planOnly`. In `deriveSpawnTemplateCapabilities`, strip mutation tools from plan-lineage children. Extend the reachability test to assert that the plan-mode surface ∩ mutating tools ⊆ {create_plan, update_plan_status}.
- **Prior cross-reference:** new. 03-orchestration lists "read-only plan inheritance" as a strength, but it inspected only terminal inheritance.

### orchestration-02: The default orchestrator sends about 47k static tokens before any user content, and the existing disclosure mechanism is switched off
- **Axis:** usability (model-facing, cost/latency). **Severity:** HIGH.
- **Evidence (measured; placeholders unexpanded, so these are lower bounds):**

  | surface | tools | tool-definition tokens | system prompt | instructions prompt | step prompt (per step) | agent catalog |
  |---|---|---|---|---|---|---|
  | `base2` | 42 | 21,938 | 11,006 | 1,822 | 751 | 11,442 (33 agents) |
  | `base2-plan` | 38 | 17,321 | 8,889 | 2,034 | 307 | |
  | `base2-execute-plan` | 43 | 24,314 | 11,006 | 2,384 | 1,552 | |
  | `base2-fast` | 41 | 21,643 | 9,076 | 1,139 | 145 | |

  - Largest tool definitions: `edit_transaction` 3,416, `update_plan_status` 2,361, `spawn_agents` 2,257, `read_files` 1,767, `code_search` 1,738, `create_plan` 916, `evaluate_audit_coverage` 843, `edit_3d_asset` 716.
  - The agent catalog addendum (`packages/agent-runtime/src/templates/strings.ts:404-427`) adds a full JSON input contract per agent in `generic` mode.
  - `agents/__tests__/base2-context-budget.test.ts:28-35` already records about 27.6k tokens with 40 skills and allows up to 29.5k.
  - The progressive tier mechanism exists but is pinned off (`agents/base2/base2.ts:488`, `progressiveToolDisclosure: false`). So the 3D tier (4 tools, ~1.5k tokens), the audit tier and the plan tools ship on every request.
  - `lookup_agent_info`, which could serve per-agent contracts on demand, is registered but exposed to no agent.
- **Impact:** Every turn of every session pays about 47k input tokens, plus file tree, git status, AGENTS.md and skills. Competitor B.md §3.3 puts Pi under 1k and "around 10k elsewhere". Claude Code and Kiro defer MCP and rare tools (`ToolSearch`, `tool_load`). The cost is felt directly by BYOK users, and it crowds the window for small-context local models.
- **Suggested fix:**
  - Flip `progressiveToolDisclosure` on, with CORE plus `implement`, and unlock `audit` and `media_3d` through a skill or a `tool_load`-style tool.
  - Render the catalog as one line per agent and fetch each JSON contract through `lookup_agent_info` (expose it), or only for agents with required params.
  - Move the `update_plan_status` and `create_plan` prose into the plan-mode instructions, out of the tool descriptions.
  - Add a CI token budget for the full static request: system + tools + catalog + instructions.
- **Prior cross-reference:** new. B32 (performance baselines) is adjacent, but token budget is not in its scope.

### orchestration-03: Five overlapping planning and progress surfaces, and two of them are unwired
- **Axis:** cohesion and usability. **Severity:** MEDIUM.
- **Evidence:**
  - Default and execute-plan base2 expose `write_todos`, `create_plan`, `update_plan_status` and `get_task` together (measured tool lists). That is at least 3.3k tokens of planning schemas.
  - `add_subgoal` and `update_subgoal` (`common/src/tools/params/tool/add-subgoal.ts`, `update-subgoal.ts`) are registered, but `rg` finds them only in `agents/types/*` and the policy list in `agents/base2/tool-tiers.ts`, so no agent can call them.
  - `think_deeply`, `lookup_agent_info` and `end_turn` are unwired in the same way.
  - In default mode, `create_plan`'s description tells the model "After creating the plan, you should end turn to let the user review the plan" (`create-plan.ts:49`). That conflicts with the implementation-mode flow, and base2 has no `end_turn` tool.
  - Completion signalling is also split three ways: `set_output` (subagents), `task_completed` (general-agent), and `end_turn` (unused).
- **Impact:** The model must pick among a todo list, a markdown plan file, a structured plan-status patcher and a durable task reader that describe the same work. Claude Code consolidated this into Task* tools with dependencies. Kiro V3 dropped todo and goal tools entirely (A.md §4.1).
- **Suggested fix:** Make one model-facing task tool: `write_todos` with stable ids, status and `depends_on`, optionally backed by `.agents/sessions/<slug>/PLAN.md`. Keep `create_plan` plan-mode-only. Make `get_task` and `update_plan_status` programmatic or execute-plan-only. Remove the subgoal tools and `think_deeply` from the registry, or add them to `removedToolNames`. Drop the "end turn" sentence outside plan mode.
- **Prior cross-reference:** new.

### orchestration-04: Subagents have no default step, turn or time bound, and agent definitions cannot set one
- **Axis:** reliability and usability. **Severity:** MEDIUM.
- **Evidence:**
  - `MAX_AGENT_STEPS_DEFAULT = -1` (`common/src/constants/agents.ts:234`), used for children at `spawn-agent-utils.ts:3636`.
  - In-process children have no wall-clock deadline (`spawn-agent-utils.ts:4329-4332`).
  - Supervised children arm a deadline only on an explicit `request.timeoutMs` (`supervision/supervised-spawn.ts:669-674`). Yet the comment at `spawn-agent-utils.ts:4008-4010` claims "the supervisor default (SETTLE_DEFAULT_TIMEOUT_MS) applies", which is stale.
  - `AgentDefinition` (`agents/types/agent-definition.ts:23-260`) has `maxSpawnDepth`, `maxCostCents` and `maxTokensPerTurn`, but no `maxSteps`, `maxTurns` or `timeout`.
  - The base2 repair loops are also unlimited by default (`docs/agents-and-tools.md:597`).
  - A background child can run until the CLI session ends (`spawn-agents.ts:69`).
- **Impact:** A looping or stalled subagent, for example a provider stream that hangs without erroring, is bounded only by user cancellation or by an optional cost cap that is checked after spend. Gemini defaults `max_turns: 30` and `timeout_mins: 10`. Claude Code has `maxTurns` and returns a resumable partial result (A.md §1.2, §3.2).
- **Suggested fix:**
  - Add `maxSteps` and `timeoutSeconds` to `AgentDefinition` and the `spawn_agents` entry. Give bundled read-only agents defaults (for example, file-picker at 20 steps and 5 min).
  - Enforce the bound in both routes, using the supervisor's existing `idleTimeoutMs` for supervised children.
  - On expiry, return a typed `truncated`/`timeout` receipt carrying the partial output.
  - Fix the stale comment.
- **Prior cross-reference:** 03-orchestration noted "No default wall-clock deadline is imposed… intentional". Making it configurable is new. Partially related to B20 (scope termination).

### orchestration-05: Background agents are poll-only, invisible to the user, and tied to the session
- **Axis:** completeness and usability. **Severity:** MEDIUM.
- **Evidence:**
  - The only observation path is the model calling `check_background_agent` (`common/src/tools/params/tool/check-background-agent.ts:53-61`), which polls with cursors.
  - I found no runtime injection that announces completion into the parent's next step. I searched `run-agent-step.ts` and `main-prompt.ts` for background-completion notices and found only resume and reconcile machinery (`run-agent-step.ts:42-58`).
  - The pending-job summary lives in `end_turn` (`end-turn.ts:46-90`), but base2 does not expose `end_turn`.
  - The CLI command registry has no `/tasks`, `/agents` or `/jobs` command (the full list from `command-registry.ts` `name:` entries).
  - Jobs are in-process only: "Cannot outlive this CLI session" (`spawn-agents.ts:69`).
- **Impact:** The user cannot list or cancel running background agents. The model learns a job finished only if it remembers to poll, which costs a tool round-trip each time. Claude Code runs subagents in the background by default and has `/tasks` and an agent view. OpenCode posts a `<subagent>` message when a child goes idle. Kiro has `Ctrl+G` monitoring and cloud sessions. Codex has `/agents` (A.md §1.2, §2.2, §4.2; B.md §1.1).
- **Suggested fix:**
  - Push a compact `background_agent_settled` notice into the parent's next step prompt when a job settles.
  - Add a `/jobs` (or `/agents`) TUI panel backed by `jobRegistry.listRunning`, with cancel and an open-transcript view.
  - Expose the end-of-turn pending-job summary through the runtime instead of the unused `end_turn` tool.
- **Prior cross-reference:** new. Durable resume is covered by B16; isolated concurrent work by B34.

### orchestration-06: Custom-agent ergonomics lag Markdown-frontmatter competitors, and the public type carries hosted-product leftovers
- **Axis:** usability and completeness. **Severity:** MEDIUM.
- **Evidence:**
  - The loader accepts only `.ts/.tsx/.js/.mjs/.cjs` (`sdk/src/agents/load-agents.ts:64`).
  - There is no `/agents` creation or list command (command registry).
  - The public `AgentDefinition` says the model "Can be any model in OpenRouter" (`agents/types/agent-definition.ts:35`), describes `providerOptions` as OpenRouter routing (`:64-66`), refers to the agent store and publishing (`:25-29`, `:177-178`), and says `contextTokenCount` comes from "/api/v1/token-count" (`:354`). The `/init` template copies the same text (`common/src/templates/initial-agents-dir/types/agent-definition.ts:191,368`).
  - `/publish` is a stub (`cli/src/commands/command-registry.ts:1207-1213`), but `PublishContainer` and `AgentChecklist` (451 lines) are still mounted (`cli/src/components/chat-input-bar.tsx:222-230`).
  - `--agent` help says "(default: base)" (`cli/src/cli-args.ts:290`), but the default is `base2`. `BASE_AGENT_IDS` (`spawn-agent-utils.ts:276-281`) lists `base`, `base-free`, `base-max` and `base-experimental`, none of which is in the 45 bundled agents.
- **Impact:** Writing a reviewer subagent takes an executable TS module, the type file, and knowledge of `handleSteps`. Claude Code, Gemini, OpenCode and Kiro need a few lines of Markdown frontmatter. The stale OpenRouter and store wording misleads BYOK users about which models and providers apply.
- **Suggested fix:**
  - Accept `.agents/*.md` (frontmatter: `id`, `description`, `model`, `tools`, `spawnableAgents`, `maxSteps`, `outputSchema`) mapped onto `AgentDefinition`. Keep TS for programmatic agents.
  - Add `/agents` (list, show source, create from template).
  - Rewrite the type comments for BYOK routing (`openbuff.json` `agents[id]`).
  - Delete the publish UI, or hide it behind a build flag.
  - Fix the `--agent` help and remove the dead `BASE_AGENT_IDS`.
- **Prior cross-reference:** B29 (explicit agent loading/trust) partially overlaps. Ergonomics are new.

### orchestration-07: Subagents have no cheap-model role, so every subagent inherits the expensive default
- **Axis:** completeness. **Severity:** MEDIUM.
- **Evidence:**
  - Routing order is modes → `agents[id]` → `defaultModel` → explicit model → hard error (`docs/local-mode.md:185-192`). `base2.ts:358-367` states there is no hardcoded fallback.
  - `rg` for `smallModel|weakModel|fastModel` in `sdk/src/provider-config.ts` and `docs/configuration.md` finds nothing.
- **Impact:** Unless the user maps each of 33 agents by hand, the file-pickers, researchers and specialists run on the orchestrator's model. That multiplies BYOK cost per parallel wave. Claude's Explore defaults to Haiku. Aider has a `weak` model role. Pi has virtual-model routing (A.md §1.2; B.md §2.2, §3.2).
- **Suggested fix:** Add a `roles: { fast, strong }` (or `smallModel`) key that bundled discovery and summarization agents resolve to before `defaultModel`. Surface it in `/setup` and `/models`.
- **Prior cross-reference:** new. B08 covers route metadata fidelity, not role defaults.

### orchestration-08: Shell access and system prompt change between modes, so the plan→execute handoff loses the prompt cache
- **Axis:** cohesion. **Severity:** LOW.
- **Evidence:**
  - `run_terminal_command` is allowed only when `executePlan` (`agents/base2/tool-tiers.ts:134-135`). DEFAULT must route every command through the `basher` subagent (`agents/basher.ts:75,100`; `spawn_agents` has `endsAgentStep: true`), while EXECUTE_PLAN gets a direct shell.
  - "Execute Plan" switches the root agent `base2-plan` → `base2-execute-plan` (`cli/src/hooks/use-chat-input.ts:89-94`). That changes the system prompt (8,889 → 11,006 tokens) and the tool set (38 → 43), so the first execute turn cannot reuse the provider's cached prefix.
  - The handler is still named `handleBuildFast` even though it runs the normal-cost execute agent.
- **Impact:** DEFAULT and EXECUTE_PLAN behave differently for the same shell need, and the model is told different rules for each. The handoff costs a full uncached request.
- **Suggested fix:** Give DEFAULT the same shell surface as EXECUTE_PLAN, or make both use basher. Keep one system prompt and tool list across modes, and express mode as an instructions/step prompt plus runtime gates (see orchestration-01). That keeps the cache prefix stable.
- **Prior cross-reference:** new.

### orchestration-09: Model-facing prompt leaks harness internals and repeats itself
- **Axis:** usability. **Severity:** LOW.
- **Evidence:**
  - `agents/base2/base2.ts:588` (system prompt) and `:658` (instructions) both carry the same "Tier1 whole-file auth (complete:true → reusable cap.v3) … Tier2 scoped caps … postEditCapabilities" paragraph.
  - `base2.ts:416` tells the model "Never spawn the context-pruner agent", but context-pruner is already filtered from the model-visible catalog (`packages/agent-runtime/src/templates/prompts.ts:236-242`).
- **Impact:** These are tokens on every request spent on internal capability jargon that the model cannot act on without reading the tool schemas, and on instructions about an agent the model cannot see.
- **Suggested fix:** Move capability-token rules into the `read_files` and `edit_transaction` result messages, where they apply. Delete the context-pruner line. Deduplicate the system and instructions copies.
- **Prior cross-reference:** new.

### orchestration-10: Docs drift on orchestration contracts
- **Axis:** cohesion. **Severity:** LOW.
- **Evidence:**
  - `docs/agents-and-tools.md:116-120` says `synthesizer` is "intentionally excluded" from `spawnableAgents`, but `agents/base2/base2.ts:538` includes it.
  - `docs/local-mode.md:187` lists only `modes.default` and `modes.plan`, while `sdk/src/provider-config.ts:2056` also routes `executePlan`.
  - AGENTS.md points to `docs/architecture.md` for the "handleSteps generator lifecycle", but that file has one line on it (`docs/architecture.md:65`).
  - The `sdk/src/impl/agent-runtime.ts:89-90` comment says subagents stay in-process "inside the compiled CLI binary". The self-exec path (`supervision/supervised-spawn.ts:490-513`) contradicts this.
- **Impact:** Agent authors and maintainers get wrong contracts, for example whether the orchestrator may call synthesizer.
- **Suggested fix:** Correct the four passages. Add a STEP / STEP_ALL / STEP_TEXT / GENERATE_N / return lifecycle section to `docs/architecture.md`, or point AGENTS.md at the `AgentDefinition.handleSteps` doc comment.
- **Prior cross-reference:** 03-orchestration noted "stale SDK/docs wording" (still present). Otherwise new.

### Prior findings re-checked at HEAD
- **03-F1** (budget stop re-enters correction): appears fixed. `run-agent-step.ts:684-699` returns `termination: 'budget_exhausted'`. B02 is accepted (`docs/execution/body-roadmap/STATE.md:44`). I did not re-run the probe.
- **03-F2** (generator errors receipted as completed): appears fixed. `run-programmatic-step.ts:789` now classifies `cancelled`/`failed`. B02 is accepted.
- **01-F8** (`/plans`, `/plan-use` missing from the menu): still present. `cli/src/data/slash-commands.ts` ids include resume-plan, update-plan, plan-status, plan-artifact and lessons, but not plans or plan-use. Covered by B11.

## Competitive gaps

| capability | best-in-class CLI and how it does it | Openbuff state | priority |
|---|---|---|---|
| Read-only plan mode with in-session approval | Claude Code `EnterPlanMode`/`ExitPlanMode` (classifier-approved reads, plan approved in place); Gemini `--approval-mode=plan` | Separate root agent; mutation tools leak (orchestration-01); approval is a button that switches agent | P0 |
| Small static prompt / deferred tools | Pi <1k tokens with codemode; Claude `ToolSearch`; Kiro `tool_load` | ~47k static tokens; tier disclosure exists but is off (orchestration-02) | P0 |
| Markdown subagent definitions | Claude (≈17 frontmatter fields), Gemini, OpenCode, Kiro JSON/MD | TS modules only (orchestration-06) | P1 |
| Per-subagent turn/time limits | Gemini `max_turns` 30 / `timeout_mins` 10; Claude `maxTurns` with resumable partial result | None by default; not definable (orchestration-04) | P1 |
| Background agent monitor + completion push | Claude `/tasks` + agent view; OpenCode idle `<subagent>` message; Kiro `Ctrl+G`; Codex `/agents` | Poll-only tool, no TUI panel (orchestration-05) | P1 |
| Resume or follow up a finished subagent | OpenCode `subagent{sessionID}`; Claude resume after `maxTurns` | Journal-based crash resume only; no model-facing continue-child | P2 |
| Cheap-model role for discovery agents | Claude Explore→Haiku; Aider weak model; Pi virtual models | Everything falls to `defaultModel` (orchestration-07) | P1 |
| Worktree isolation per subagent | Claude `isolation: worktree`; Codex `fork --worktree` | Path leases only; covered by roadmap B34 | P2 |
| Declarative DAG / loop-back stages | Kiro DAG with `max_iterations` 1–10 | Programmatic `handleSteps` can express it, but there is no declarative form; workflow-engine is telemetry-only | P3 |
| Cloud / out-of-session background runs | Claude projects, Codex cloud, Kiro `--cloud` | In-process only; out of scope for local-first | P3 |
| Single task tool with dependencies | Claude Task* tools | Five overlapping surfaces (orchestration-03) | P2 |

Where minimalism wins: Pi's argument (B.md §7) that subagents and plan mode hide work applies here only partly, because Openbuff renders nested subagent streams. Its token-cost argument applies fully. The 3D, audit and plan tiers are declared on every request even though most sessions never touch them.

## Strengths

- **Multi-vendor routing per agent.** Any agent, including custom ones, can be mapped to any BYOK provider through `openbuff.json` `agents[id]` or `/models set agent <id> <provider/model>` (`docs/local-mode.md:120-192`). Claude Code is Claude-only, and Gemini is Gemini-only (A.md §5).
- **Process-isolated subagents by default on Bun/POSIX.** Each child runs in an owner-only sandbox process with a parent RPC bridge and process-group SIGTERM→SIGKILL teardown (`sdk/src/impl/agent-runtime.ts:104-125`, `supervision/process-supervisor.ts:124-131`, `spawn-agent-utils.ts:4070-4110`). None of the reference CLIs documents per-subagent OS process isolation.
- **Lossless large child results.** When a child result exceeds the parent-visible budget, the parent gets a truncated receipt plus a pointer to the full output persisted under a 0700 temp directory (`spawn-agent-utils.ts:1112-1160`). Claude and Gemini return only the final text.
- **Durable, resumable plan packets.** SPEC/PLAN/STATUS/LESSONS live under `.agents/sessions/<slug>/`, with `/resume-plan`, `/plan-status` and a picker (`base2.ts:15413-15470`, `command-registry.ts:1278-1440`). This survives across days. Claude plan mode, Aider `/architect` and Codex `/plan` are session-scoped.
- **Safe spawning.** Batch prevalidation, atomic background capacity claims (`background-agent-jobs.ts:400-455`), depth limit with actionable errors (`spawn-agent-utils.ts:4304-4310`), and typed receipts (03-orchestration strengths). The 140 existing spawn, background, abort and plan tests pass.
- **Custom agents are spawnable without wiring.** The CLI auto-adds user agents to every `base*` roster and lets them override bundled ids (`cli/src/utils/local-agent-registry.ts:428-455`). Programmatic `handleSteps` gives code-level orchestration comparable to Claude "Workflows" scripts.

## Roadmap mapping

| finding | roadmap coverage |
|---|---|
| orchestration-01 | Not covered. B18 (approval identity) and B19 (effective context) are adjacent but do not gate plan-lineage mutation tools |
| orchestration-02 | Not covered. B32 measures release performance, not prompt/tool token budget |
| orchestration-03 | Not covered |
| orchestration-04 | Partially covered by B20 (scope termination/cleanup); the per-agent limits API is not covered |
| orchestration-05 | Partially covered: B16 (child journal/leases) and B34 (concurrent work); the UI and completion push are not covered |
| orchestration-06 | Partially covered by B29 (explicit agent loading/trust); Markdown format, `/agents` and stale type docs are not covered |
| orchestration-07 | Not covered (B08 covers route metadata only) |
| orchestration-08 | Not covered |
| orchestration-09 | Not covered |
| orchestration-10 | Partially covered by B01 (source/maturity truth) for stale SDK wording; the doc fixes are not covered |
| 03-F1 / 03-F2 (prior) | Covered by B02 (accepted); appear fixed at HEAD |
| 01-F8 (prior) | Covered by B11; still present |
