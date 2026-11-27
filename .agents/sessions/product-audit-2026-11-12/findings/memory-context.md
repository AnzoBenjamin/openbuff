# Shard `memory-context` — context compaction, memory, instruction files, sessions

HEAD at audit time: `f5aba489d`. Read-only static trace; no tests were run and no files outside this one were written.
Roadmap state: B12, B13 and B14 are all `pending` in `docs/execution/body-roadmap/ledger.json` (`/nodes/11..13`).

## Scope

Inspected:
- **Compaction pipeline**:
  - `packages/agent-runtime/src/run-agent-step.ts`: injection at 2686-2760, the eviction/semantic/mechanical pipeline at 2759-3370, manual compact at 1187-1215, and the knowledge cache note at 2262-2300.
  - `packages/agent-runtime/src/util/context-pruning.ts`, `context-archive.ts`, `runtime-semantic-compaction.ts` and `memory-v2-context.ts`.
  - `agents/context-pruner.ts`: 12-270, 559-850 and 3171-3349.
  - `sdk/src/impl/llm.ts`: 797-1018 and 1994-2100.
- **Memory**:
  - `packages/agent-runtime/src/memory/*` (playbook-gate 139-381 in detail).
  - `sdk/src/services/memory-v2/coordinator.ts`: 874-945, 1160-1430, 1599-1835 and 2139-2410.
  - `cli/src/services/memory-v2/bun-sqlite-memory-repository.ts`: 116-166, 1621-1690 and 5205-5360.
  - `cli/src/utils/env.ts`: 90-115.
- **Instruction files**: `sdk/src/run-state.ts` (72-136, 614-905), `packages/agent-runtime/src/templates/strings.ts` (215-278), `common/src/util/router.ts` (120-271), `ROUTER.md`, `agents/base2/base2.ts:760-780` and `packages/agent-runtime/src/system-prompt/prompts.ts` (23-80).
- **Sessions and rewind**:
  - `cli/src/utils/run-state-storage.ts`: 28-125 and 705-1012.
  - `cli/src/hooks/use-send-message.ts`: 145-160, 380-395 and 720-740.
  - `cli/src/state/chat-store.ts`: 207-350.
  - `cli/src/hooks/helpers/send-message.ts`: 340-356 and 560-580.
  - `cli/src/utils/turn-snapshots.ts`: 1-30, 210-260, 380-450 and the export list.
  - `cli/src/commands/command-registry.ts`: 715-750 and 900-935.
  - `cli/src/commands/router.ts`: 485-516.
  - `cli/src/data/slash-commands.ts`: 40-260.
  - `cli/src/cli-args.ts`: 342-436 and 547-601.
- **UI**: `cli/src/utils/status-bar-chips.ts` (218-292, 384-392) and `cli/src/commands/context.ts` (via sub-agent trace).
- **Prior review**: `.agents/sessions/body-capability-review-2026-11-05/PLAN.md` (B12-B14) and `findings/04-memory.md`, `01-cli.md`, `11-evals-release.md`.

Skipped or partial:
- `agents/context-pruner.ts` is 3,349 lines. I read about 900 of them, so pruner handling of reasoning parts is unverified.
- `memory-command.ts` (2,179 lines): I traced only the usage string and the authority hint, through a sub-agent.
- The `recall-context` handler's output caps: I used the constants in `context-archive.ts:46-47` and did not read the handler body.
- Prompt-cache anchor selection in `common/src/util/messages.ts` before line 540.
- Exact behaviour of the bare-word `compact` path after the model reply (`run-agent-step.ts:1187+`): only partly read.

## Feature inventory

| Feature | Entrypoint | Implementation | Tests | Maturity |
|---|---|---|---|---|
| Auto compaction, layer 1: deterministic tool-result eviction | automatic, at 70% of window | `run-agent-step.ts:2797-2870`, `tool-result-eviction.ts` | `util/__tests__/context-pruning.test.ts`, `context-archive.test.ts` | useful |
| Auto compaction, layer 2: "semantic" pass | automatic at about 78% of window, with a governor | `context-pruning.ts:176-250,402-447`; `agents/context-pruner.ts` (heuristic, no LLM call) | `agents/__tests__/context-pruner.test.ts`, `pruner-budgets-freshness.test.ts`, `evals/compaction-*` | useful (lossy) |
| Auto compaction, layer 3: mechanical trim, plus SDK request-time trim | automatic at the provider-safe limit | `run-agent-step.ts:3276-3370`; `llm.ts:819-980` | `context-pruning.test.ts` | useful (last resort) |
| Overflow retry | provider "prompt too long" error | `llm.ts:982-1018, 2016-2045` (one retry, 3 regexes) | not found for non-OpenAI/Anthropic wording | partial |
| Manual compaction | bare word `compact` only; `/compact` is rejected | `run-agent-step.ts:1187-1215`, `prompts.ts:23-37,77-78`; `router.ts:492-515` | none found | unwired / undiscoverable |
| Compaction visibility | compaction card and status chip "⇲ compacting N%"; ctx% bar with trigger marker | `compaction-box.tsx`, `status-bar-chips.ts:218-292,384-392` | `status-bar*.test.tsx`, `compact-queue-status.test.tsx` | useful |
| `/context` (`/ctx`) | slash command | `cli/src/commands/context.ts` (budget ledger plus gate budgets) | `commands/__tests__/context.test.ts` | useful |
| Pre-compaction archive and `recall_context` | model tool | `context-archive.ts` (8 semantic/mechanical snapshots at 4k chars per message, 16 eviction snapshots at 64k); SQLite flush with 30-day TTL (`bun-sqlite-memory-repository.ts:127`) | `context-archive.test.ts`, `archive-recall-index.test.ts` | useful (04-F4 open) |
| Cross-session memory V2 (SQLite) | automatic, on by default (`env.ts:100`) | `coordinator.ts`, `.openbuff/memory/memory-v2.sqlite` | `coordinator.test.ts`, `two-session-cold-start.test.ts` | partial |
| `record_decision` | model tool | `record-decision.ts` handler → V1 taskMemory; V2 keeps only the claimId | `record-decision.test.ts` | partial |
| Playbooks (procedural memory and gate) | `/memory playbooks …`; automatic gate | `memory/playbook-gate.ts`, `playbook-context.ts` | `playbook-gate.test.ts`, `playbook-context.test.ts` | partial (04-F6, 04-F8 open) |
| `/memory` operator surface | `status/query/inspect/correct/forget/pin/export/import/compact-memory/playbooks/…` | `cli/src/commands/memory-command.ts:232` | `memory-command.test.ts` | useful, but expert-grade |
| Project instruction files | automatic | `run-state.ts:78-87,684-750`; `strings.ts:216-278`; `router.ts` | `knowledge-file-selection.test.ts`, `run-state-home-policy.test.ts` | partial |
| `/init` | slash command | `prompts.ts:61-71` (writes `knowledge.md`) | — | useful |
| Session save and resume | `--continue [id]`, `/history` (`/chats`) picker | `run-state-storage.ts:720-962` | `run-state-storage.test.ts`, `turn-checkpoint.test.ts` | useful |
| Mid-turn crash checkpoint | automatic, about every 30 s | `run-state-storage.ts:705-715,980-1020`; `use-send-message.ts:720-740` | `turn-checkpoint.test.ts` | useful |
| Conversation rewind | `/undo`, `/redo` (20 deep; restores RunState too) | `chat-store.ts:207-350` | — (not located) | useful |
| Code rewind | `/undo-turn`, `/restore <snap>`, `/bisect-turn` | `turn-snapshots.ts` (git plumbing on `refs/openbuff/turns`, 50 retained) | not located in this pass | useful (tracked files only) |
| Session fork, tree or branch | — (`openbuff replay` is read-only journal inspection) | `cli-args.ts:343-436` | — | absent |
| Prompt caching | automatic | `withCacheControl` (`common/src/util/messages.ts:43-67`); session-stable system prompt (`run-agent-step.ts:2268-2282`) | — | partial (no warming) |

## Findings

### memory-context-01 — Manual compaction is unreachable through `/compact`, but the error recovery text tells users to run `/compact`
- **Axis:** usability, cohesion. **Severity:** HIGH.
- **Evidence:**
  - The runtime handles a prompt equal to `/compact` or `compact` (`packages/agent-runtime/src/run-agent-step.ts:1187-1215`; prompt at `system-prompt/prompts.ts:23-37,77-78`).
  - The CLI has no `compact` command. It is absent from `cli/src/data/slash-commands.ts` and from `command-registry.ts`.
  - Any unknown slash input is answered locally with "Command not found" and never reaches the agent (`cli/src/commands/router.ts:492-515`).
  - Two recovery strings tell users to run `/compact`: `run-agent-step.ts:3363` and `cli/src/utils/sdk-event-handlers.ts:1984`.
  - The bare word `compact` reaches the agent, but nothing documents it.
- **Impact:** At the moment the user most needs it (context brakes exceeded), the advised action fails. There is no way to compact proactively before a long task, and no way to pass instructions the way `/compact [focus]` works in Claude Code, Codex or Pi.
- **Fix:**
  - Register `/compact [instructions]` as a real command that drives the same `context-pruner` path as auto compaction, with forced trigger and archiving, rather than the model-summary prompt.
  - Emit the normal `context_compaction` event.
  - Add a router test.
- **Prior:** new. 01-cli covered compaction status only.

### memory-context-02 — Memory V2 lifecycle (B12) is only partly repaired: decision meaning is lost, ranking is discarded, and degraded turns inject V1
- **Axis:** reliability, completeness. **Severity:** HIGH.
- **What is fixed at HEAD:**
  - 04-F1. Startup and terminal events now use sourceIndex 1 and 2 (`sdk/src/services/memory-v2/coordinator.ts:1192-1206`, `2339-2353`).
  - 04-F2, caller side. The coordinator no longer sends `taskId` and sets `includeHistorical: true` (`coordinator.ts:1232-1250`). The exact filter still exists in the repository (`bun-sqlite-memory-repository.ts:5206,5308`) for any other caller.
- **Still present:**
  - 04-F3. The V2 observation `summary`/`detail` are generic tool/path/count strings (`coordinator.ts:1757-1765`). The `record_decision` text is used only to derive `claimId` (`:1600-1658`).
  - 04-F5. `sortedByCanonicalJson` re-sorts every category before the 12,000-character clip (`packages/agent-runtime/src/util/memory-v2-context.ts:40-44, 234-367, 369-383`).
  - 04-F9. `applyDegradedState` leaves `active='sqlite-v2-opt-in'` (`coordinator.ts:881-895`). `run-agent-step.ts:2702-2724` compiles V1 `TASK_MEMORY_CONTEXT` whenever no correlated V2 context exists.
- **Impact:**
  - Cross-session memory now reaches the next task, so B12's headline "lifecycle broken" claim is mostly resolved.
  - What arrives is file and count metadata, not the decisions or rationale the model recorded.
  - The highest-ranked item can be clipped away.
  - Since V2 is now the default authority (`cli/src/utils/env.ts:100`), every degraded turn silently mixes stores.
- **Fix:** complete B12 as written. Store `text`/`excerpt` as the observation summary and detail, keep repository order, and suppress V1 under degraded opt-in.
- **Prior:** B12; 04-F1 and 04-F2 fixed, 04-F3, 04-F5 and 04-F9 still present.

### memory-context-03 — Procedural memory: verified rules stop applying, scope is ignored, unrelated reads penalise memories
- **Axis:** reliability. **Severity:** MEDIUM.
- **Evidence:**
  - `listPlaybooks` selects only `status = 'active'` (`bun-sqlite-memory-repository.ts:1622-1640`). The gate skips anything not active (`packages/agent-runtime/src/memory/playbook-gate.ts:290`).
  - The lifecycle promotes rules to `verified` (`cli/src/services/memory-v2/playbook-lifecycle.ts:141-157`), which removes them from both channels.
  - `playbookTriggerMatches` checks only tool, spawn type and terminal action (`playbook-gate.ts:140-170`). It never checks `scope.repos/glob/agentTypes`.
  - Any full read marks every unused injected observation `ignored/reread-despite` (`sdk/src/services/memory-v2/usage-observer.ts:119-150`).
- **Impact:** The "learning agent" goal is undercut. Successful rules disappear, out-of-scope rules fire, and usefulness scores drift down without cause.
- **Fix:** B14 as written.
- **Prior:** B14 (04-F6, 04-F7, 04-F8), all still present.

### memory-context-04 — Instruction files: one file per directory, nested files never reach the prompt without `ROUTER.md`, no `@imports`, and root and user files are injected twice in base2
- **Axis:** completeness, usability, cohesion. **Severity:** MEDIUM.
- **Evidence:**
  - **One file per directory.** Priority is `knowledge.md` > `AGENTS.md` > `CLAUDE.md` (`sdk/src/run-state.ts:78-87, 684-707`). This repo's root has all three, so only `knowledge.md` is auto-loaded. `AGENTS.md` reaches base2 only because `ROUTER.md` lists it.
  - **Nested files are dropped.** They are discovered (`run-state.ts:726-750`), but the `KNOWLEDGE_FILES_CONTENTS` filter keeps only bare root names (`packages/agent-runtime/src/templates/strings.ts:216-233`). The routed fallback applies the same root-only filter (`common/src/util/router.ts:162-166`).
  - **Discovery direction.** There is no parent-directory walk above `cwd` and no path-scoped lazy rules.
  - **No imports.** Content is fenced verbatim (`strings.ts:229-232`), so there is no `@path` import.
  - **User files are hidden dot-files.** Only `~/.knowledge.md`, `~/.AGENTS.md` or `~/.CLAUDE.md` are read (`run-state.ts:615-677`), not `~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md` or `~/.config/...`.
  - **Double injection.** `agents/base2/base2.ts:773-774` renders both `KNOWLEDGE_FILES_CONTENTS` and `ROUTED_KNOWLEDGE_FILES`. Without a `ROUTER.md` row (the normal case in user repos), both render the root knowledge file, and both always append the user knowledge files (`strings.ts:227, 269-275`).
  - **Load-time only.** Files are read once at session-state creation. The system prompt is session-cached (`run-agent-step.ts:2268-2282`), so edits mid-session are not picked up, and nothing shows which files were loaded.
  - **Router depends on the prompt.** `ROUTED_KNOWLEDGE_FILES` depends on `inferKnowledgeTaskType(lastUserInput)` (`strings.ts:241-243`). That contradicts the "session-stable" comment: the first prompt's task type decides the whole session's routed set.
- **Impact:**
  - Users migrating from Claude Code, Codex, Gemini or OpenCode lose their nested and monorepo `AGENTS.md`/`CLAUDE.md` files and their `@imports`.
  - A repo with both `AGENTS.md` and `CLAUDE.md` silently gets one.
  - In base2 the root file and the user file cost tokens twice.
- **Fix:**
  - Load every recognised filename per directory (or concatenate them).
  - Include ancestor directories up to the git root.
  - Inject nested files lazily when the agent reads under that directory.
  - Support `@path` imports with a depth limit.
  - Dedupe the two placeholders.
  - Add `/memory files` or a `/context` section listing loaded files with sizes.
- **Prior:** new. 04-memory only mentions that home and project files are separate paths.

### memory-context-05 — The "semantic" compaction is a heuristic extractive truncation, and comments and UI call it an LLM pass
- **Axis:** usability, reliability. **Severity:** MEDIUM.
- **Evidence:**
  - `agents/context-pruner.ts` is programmatic. `handleSteps` only yields `set_messages` (`:3311-3346`).
  - It applies fixed per-item caps (user 13k tokens, assistant 1.3k, tool entry 2k, agent result 900; `:96-103`) and 40/30/30 budgets (`:113-126`).
  - It drops file bodies and older entries, and keeps images only from the last user message that had images (`:3203-3222`).
  - It estimates tokens as chars/3 (`:107, 739-748`), while the runtime uses BPE.
  - Comments say "expensive LLM pruner pass" (`run-agent-step.ts:2797-2799`) and the governor doc says "semantic (LLM) compaction pass" (`context-pruning.ts:350, 70-95`).
  - The only LLM summariser, background consolidation, is off by default (`run-agent-step.ts:3110-3127`).
- **Impact:**
  - Compared with an LLM summary (Claude Code, Codex trained compaction, Pi's iterative structured summary, OpenCode), the prose is lost and only the `<knowledge_memory>` skeleton plus truncated text survive.
  - It is free and deterministic, which is a strength, but users and maintainers are told something different.
  - Reasoning is preserved only through `knowledge_memory`.
- **Fix:**
  - Rename the pass in comments and events to "extractive".
  - Offer an opt-in LLM summary mode, for example with `/compact` from finding 01 or a config flag, reusing the cache prefix the way OpenCode does.
  - Unify the token estimator.
- **Prior:** B13 covers fidelity oracles (11-F7). The naming and summary mode are new.

### memory-context-06 — Semantic compaction silently skips custom prompt-only agents, and pruner failures are only logged
- **Axis:** reliability. **Severity:** MEDIUM.
- **Evidence:**
  - `runRuntimeSemanticCompaction` returns early at debug log level when a non-base template does not declare `context-pruner` in `spawnableAgents` (`packages/agent-runtime/src/util/runtime-semantic-compaction.ts:120-138`).
  - The "compacting" status is already announced at that point (`run-agent-step.ts:2941-2960`), and the pass is counted against the governor (`recordPassAnnounced`).
  - Pruner exceptions are caught with `logger.warn` (`runtime-semantic-compaction.ts:222-231`). The user sees no failure, and the next brake is the mechanical trim, which drops whole messages.
- **Impact:** User-defined agents in `.agents/` hit the destructive trim with no summary. The governor's cooldown can then block a real pass on the next iterations.
- **Fix:**
  - Default `context-pruner` to permitted for every root agent, or fail loudly at template load.
  - Emit `context_compaction_status: failed` when the pass is skipped or throws.
  - Do not consume governor budget on a skipped pass.
- **Prior:** new.

### memory-context-07 — Overflow recovery recognises only three error wordings and retries once with a mechanical trim
- **Axis:** reliability. **Severity:** MEDIUM.
- **Evidence:**
  - `getProviderContextLimitFromError` matches `tokens > N maximum`, `maximum context length is N tokens` and `context_length is N` (`sdk/src/impl/llm.ts:982-1018`).
  - The retry is single (`promptTooLongRetried`) and is not attempted after content has streamed (`llm.ts:2007-2045`).
  - The retry trims messages and does not archive them or run the pruner.
  - Gemini (`exceeds the maximum number of tokens`), Bedrock, Ollama and llama.cpp messages, and errors without a number, fall through to generic retry or failure.
  - I found no tests for those wordings.
- **Impact:** For a BYOK product with many providers, an overflow on a non-OpenAI/Anthropic route ends the turn instead of compacting. Pi does one compact-and-retry for overflow and early `length` stops.
- **Fix:**
  - Classify overflow by HTTP status and provider error codes as well as wording.
  - When no number is present, fall back to the configured window.
  - Run the semantic pass (archived) before the retry.
  - Add per-provider fixtures.
- **Prior:** new.

### memory-context-08 — No session fork or branch; conversation and code rewind are separate commands and miss untracked files
- **Axis:** completeness, usability. **Severity:** MEDIUM.
- **Evidence:**
  - **Conversation:** `/undo` and `/redo` restore messages and RunState up to 20 deep (`cli/src/state/chat-store.ts:213, 284-330`).
  - **Code:**
    - `/undo-turn`, `/restore` and `/bisect-turn` use git-plumbing snapshots of the **tracked** tree, taken only at the end of a successful turn (`cli/src/hooks/helpers/send-message.ts:567-576`; `turn-snapshots.ts:214-236`).
    - Untracked and new files are never captured or restored (`turn-snapshots.ts:226-229`).
    - Turns that fail or are aborted take no snapshot.
  - **Coupling:** the two features are not linked. No single "rewind to prompt N (code + conversation)" exists.
  - **Fork:** none. `openbuff replay` only inspects journals (`cli/src/cli-args.ts:343-436`).
  - **Resume:** works via `--continue [id]` (`cli-args.ts:549-552`) and `/history` (`slash-commands.ts:171-176`). There is no named or renamed session.
- **Impact:**
  - Claude Code `/rewind` offers code, conversation or both per prompt.
  - Pi `/tree`, `/fork` and `/clone` give branchable sessions with branch summaries.
  - Codex `fork` can fork into a worktree.
  - OpenCode `/undo` reverts files and conversation together and returns the prompt to the editor.
  - In Openbuff, files created by the agent survive `/restore`, and edits from a failed turn cannot be rolled back to the start of that turn.
- **Fix:**
  - Take a pre-turn snapshot too.
  - Include untracked, non-ignored files under a size cap, as OpenCode does with ≤2 MiB.
  - Add `/rewind` that pairs a message index with a snapshot sha.
  - Add `/fork` that copies the chat directory and RunState at a chosen message.
- **Prior:** 01-cli listed snapshot and undo affordances as "unknown". 01-F7 (100-message cap) is related. B13 covers transcript retention, not fork or rewind. Mostly new.

### memory-context-09 — Durable transcript is still capped at 100 messages before save
- **Axis:** reliability. **Severity:** MEDIUM.
- **Evidence:**
  - `send-message.ts:351-353` slices to the last 100 messages, and `saveChatState` persists that array (`run-state-storage.ts:720-835`).
  - The model's RunState is separate. On resume, the visible transcript can therefore be shorter than what the model "remembers".
- **Impact:** Long sessions cannot be reviewed after resume.
- **Prior:** 01-F7 / B13, still present.

### memory-context-10 — A later snapshot can shadow original-body recall by tool-call ID
- **Axis:** reliability. **Severity:** MEDIUM.
- **Evidence:** `recallFromArchiveByToolCallId` returns the first match scanning newest-first across all snapshot kinds (`packages/agent-runtime/src/util/context-archive.ts:525-575`). It does not prefer `tool_result_eviction` records over later copies, which may be tombstones. I did not re-probe this.
- **Prior:** 04-F4 / B13, appears still present.

### memory-context-11 — No prompt-cache warming; every compaction rewrites the cached message prefix
- **Axis:** completeness, performance. **Severity:** LOW.
- **Evidence:**
  - Cache markers exist (`common/src/util/messages.ts:43-67, 540-580`) and are gated per provider (`sdk/src/impl/llm.ts:2220, 2384`; `stripCacheControl` defaults differ across schemas in `sdk/src/provider-config.ts:69,83,94,300`).
  - I found no keep-alive or warming code.
  - Compaction puts the summary at message 0 (`agents/context-pruner.ts:3246-3256`).
  - Eviction rewrites old messages, so only system and tools stay cached.
- **Impact:** Idle gaps over 5 minutes cost a full re-write on Anthropic routes. Pi (`cacheWarming: idle`, with a cost threshold) and OpenCode (session warming) avoid this. Aider has `--cache-keepalive-pings`.
- **Fix:**
  - Add opt-in warming gated on an estimated saving.
  - Make eviction append-only (tombstone new copies) where possible.
- **Prior:** new.

### memory-context-12 — `/memory` is powerful but has no plain-language surface; there is no "remember this" path to a readable file
- **Axis:** usability. **Severity:** LOW.
- **Evidence:**
  - The usage string lists 18 expert subcommands (`cli/src/commands/memory-command.ts:232`), dry-run by default.
  - There is no `disable` subcommand. Authority is switched only through the env var (`memory-command.ts:583`).
  - Nothing writes durable learnings into a markdown instruction file. Gemini `save_memory` and Claude Code auto memory and `#`-to-memory both do.
  - `/init` writes only `knowledge.md` (`prompts.ts:61-71`).
- **Fix:**
  - Add `/memory list|forget|off` aliases.
  - Add an "add to knowledge.md" quick action.
  - Show the memory items injected this turn in `/context`.
- **Prior:** new.

## Competitive gaps

| Capability | Best-in-class CLI and how it does it | Openbuff state | Priority |
|---|---|---|---|
| Manual compaction with instructions | Claude Code `/compact [focus]` with PreCompact/PostCompact hooks; Pi `/compact [instructions]` and an extension override; Codex `/compact` | Only the bare word `compact`; `/compact` is rejected (finding 01) | P0 |
| LLM-quality summary | Codex trained compaction; Pi iterative structured summary that tracks file ops; OpenCode keeps about 15k recent tokens verbatim and reuses the cache | Extractive heuristic plus pinned `knowledge_memory` (finding 05) | P1 |
| Overflow compact-and-retry | Pi: one compact-and-retry on overflow or a `length` stop | One mechanical-trim retry on three wordings (finding 07) | P1 |
| Hierarchical instruction files and imports | Claude Code hierarchical `CLAUDE.md`/`AGENTS.md`, `@imports`, lazy `.claude/rules`; Codex hierarchical `AGENTS.md` with fallback filenames; OpenCode cwd→root walk | One file per directory, root only, no imports, no ancestors (finding 04) | P1 |
| Rewind code + conversation | Claude Code `/rewind` (both, code only or conversation only, plus partial summarise); OpenCode `/undo` (files + chat, prompt back to editor) | Separate `/undo` and `/undo-turn`; tracked files only, end-of-turn snapshots (finding 08) | P1 |
| Session tree and fork | Pi `/tree`, `/fork`, `/clone` with branch summaries; Codex `fork --worktree`, `/rename` | None (finding 08) | P2 |
| Cross-session learned memory | Claude Code auto memory; Gemini `save_memory` to `GEMINI.md` | SQLite V2 with evidence freshness tiers, partly broken (findings 02, 03) | P1 |
| Cache warming | Pi `cacheWarming: idle` with a cost gate; OpenCode session warming; Aider keepalive pings | None (finding 11) | P3 |
| Context-window display | Claude Code statusline; Codex `/status` | ctx% bar with compaction trigger marker, token counts from 70-80%, `/context` ledger | parity (strength) |
| Bisect by turn | none of the reference CLIs | `/bisect-turn` | Openbuff lead |

## Strengths

- **Layered, governed compaction.** A free deterministic eviction layer runs at 70% before any rewrite (`context-pruning.ts:125`). An anti-thrash governor with cooldown, rearm and a turn cap of 3 follows (`context-pruning.ts:111,420-500`), and the mechanical trim plus SDK request-time trim are the last resort. Thresholds scale for small BYOK windows under 128k (`context-pruning.ts:191-228`). No reference CLI documents this level of control.
- **Recoverable loss.** Every rewrite archives its pre-image, and the archive persists to SQLite with a 30-day TTL (`bun-sqlite-memory-repository.ts:127`). `recall_context` gives the model text and exact-ID recall (`context-archive.ts:421-575`). A post-compaction coverage check names what was lost (`run-agent-step.ts:3231-3266`). Pi keeps originals in the session tree but has no model-facing recall tool.
- **Honest compaction UI.** The UI shows before/after tokens, removed categories and recovery guidance per event (`run-agent-step.ts:3239-3268`). The status bar shows progress and a trigger marker on the ctx bar (`status-bar-chips.ts:186-197, 384-392`).
- **Read authorization after compaction.** It is revoked, so the agent must re-read a file before editing it (`run-agent-step.ts:2831,3202`). This prevents edits made against summarised content.
- **Evidence-tiered memory.** V2 classifies memories as verified, needs spot-check or must re-read, using content digests. It frames memory as untrusted evidence (`memory-v2-context.ts:119`). No competitor ties memories to file freshness.
- **Git-ref turn snapshots.** They never touch the user's index or HEAD (`turn-snapshots.ts:214-236`), and `/bisect-turn` can find the turn that broke tests.
- **Crash-safe resume.** Resume uses atomic, versioned envelopes that refuse to downgrade-overwrite (`run-state-storage.ts:778-808`), plus a mid-turn checkpoint (`:705-715`).

## Roadmap mapping

| Finding | Mapping |
|---|---|
| memory-context-01 `/compact` unreachable | not covered |
| memory-context-02 memory V2 lifecycle | covered by B12 (04-F1 and caller-side 04-F2 fixed; 04-F3, 04-F5, 04-F9 open) |
| memory-context-03 procedures | covered by B14 |
| memory-context-04 instruction files | not covered |
| memory-context-05 extractive "semantic" pass | partially (B13 fidelity oracles; the summary mode is not covered) |
| memory-context-06 skipped or failed pruner | not covered |
| memory-context-07 overflow recovery | not covered |
| memory-context-08 fork and rewind | not covered (B13 covers transcript retention only) |
| memory-context-09 100-message cap | covered by B13 (01-F7) |
| memory-context-10 recall shadowing | covered by B13 (04-F4) |
| memory-context-11 cache warming | not covered |
| memory-context-12 `/memory` usability | not covered |
