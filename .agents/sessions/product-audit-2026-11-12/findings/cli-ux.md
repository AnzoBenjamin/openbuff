# Shard `cli-ux` — CLI user experience

Audit date 2026-11-12, HEAD `f5aba489d`. Read-only. Competitor facts come from `competitors/A.md` and `competitors/B.md`, cited as A§n / B§n.

## Scope

**Inspected**
- `cli/src/`:
  - `app.tsx`, `chat.tsx`, `cli-args.ts`, `index.tsx`, `binary-entry.ts`, `project-files.ts`
  - `commands/`: `command-registry.ts`, `router.ts`, `router-utils.ts`, `help.ts`, `init.ts`, `image.ts`, `run-command.ts`, `snapshot-commands.ts`, `replay-command.ts`, `dash-command.ts`, `mcp-command.ts`
  - `data/slash-commands.ts`
  - `components/`: `multiline-input.tsx`, `help-banner.tsx`, `command-palette-screen.tsx`, `chat-history-screen.tsx`, `queue-screen.tsx`, `review-screen.tsx`, `status-bar.tsx`, `message-list-window.tsx`, `provider-picker-screen.tsx`, `blocks/content-with-markdown.tsx`, `ask-user/`, `tools/registry.ts`
  - `hooks/`: `use-suggestion-engine.ts`, `use-chat-keyboard.ts`, `use-message-queue.ts`, `use-queue-controls.ts`, `use-send-message.ts`, `helpers/send-message.ts`, `use-viewport-window.ts`, `use-input-history.ts`
  - `state/chat-store.ts`
  - `utils/`: `keyboard-actions.ts`, `clipboard-image.ts`, `clipboard.ts`, `pending-attachments.ts`, `image-handler.ts`, `status-bar-chips.ts`, `message-updater.ts`, `theme-system.ts`, `theme-config.ts`, `chat-history.ts`, `conversation-fork.ts`, `run-state-storage.ts`, `output-export.ts`, `turn-snapshots.ts`, `message-history.ts`, `detect-shell.ts`, `terminal-images.ts`, `terminal-notify.ts`, `openbuff-provider.ts`
  - `init/init-app.ts`, `init/init-direnv.ts`, `pre-init/tree-sitter-wasm.ts`, `services/deferred-registries.ts`
- `docs/design/cli-overhaul/`: PLAN.md (read in full), WIREFRAMES.md and REFINEMENT.md (grepped for commands), PERFORMANCE.json
- `.agents/sessions/ui-command-disclosure-2026-11-10/`: STATUS.md, `findings/command-outputs.md`
- `README.md`, `docs/getting-started.md`, `docs/configuration.md` (grepped), `WINDOWS.md` (repo root), and the `.github/workflows/` Windows jobs
- Prior review: `body-capability-review-2026-11-05/findings/01-cli.md` (F1–F8) and `docs/execution/body-roadmap/STATE.md`

**Measured** with the local compiled binary `cli/bin/openbuff`, built 2026-11-10 21:44, so it may lag HEAD by a few commits. I ran it in a scratch git repo `/tmp/ob-startup` (empty, no commits) inside tmux at 120×40.

**Skipped**
- Tool-renderer internals in `components/tools/*` beyond the registry. Tool UX belongs to the feature shards.
- SDK pricing tables (`sdk/src/impl/llm.ts`, `model-discovery.ts`). Cost accuracy belongs to the providers/B09 shard.
- `serve`/ACP protocol internals. That is the orchestration shard.
- Runtime behaviour that would need a provider key. I ran no model turns.

## Feature inventory

| Feature | Entrypoint | Implementation | Tests | Maturity |
|---|---|---|---|---|
| First-run onboarding / BYOK setup | `/setup`, `/provider`, `/models` (`command-registry.ts:949-1041`) | `provider-picker-screen.tsx`, `openbuff-provider.ts:987-1011` | provider-picker tests | partial: no first-run flow, no in-TUI key entry |
| Slash commands (about 45 plus skills/presets) | `/` menu, `data/slash-commands.ts:33-268` | `command-registry.ts:505-1530`, `router.ts:467-517` | `router-input.test.ts` and others | useful, with catalog drift |
| Command palette + MRU | Ctrl+P (`keyboard-actions.ts:174`) | `command-palette-screen.tsx`, `command-mru.ts` | yes | useful |
| `@` file/agent mentions | `@` (`use-suggestion-engine.ts:117-157`) | fuzzy file match `:311-444`; read-on-select `pending-attachments.ts:522` | yes | useful (no line ranges) |
| Image/file paste, drag-drop | Ctrl+V (`use-chat-keyboard.ts:219-266`), `/image` | `clipboard-image.ts`, `image-handler.ts:115-184` | partial (none for clipboard-image) | useful, sync I/O |
| Long text paste collapse | paste over 2000 chars (`utils/strings.ts:69`) | `chat.tsx:1362-1376` | none | useful |
| Keybindings / emacs editing / input undo | `multiline-input.tsx:821-1290, 1404-1416` | hardcoded `keyboard-actions.ts:129-372` | yes | useful; no vim, keymap or `$EDITOR` |
| Message queue (edit/reorder/restore) | Enter while busy (`command-registry.ts:286-304`); palette "Work queue" | `use-message-queue.ts`, `queue-screen.tsx` | yes | useful; **no steer** |
| Interrupt | Esc / Ctrl+C (`keyboard-actions.ts:195-198`) | `chat.tsx:1396-1400` | partial | useful |
| Prompt history + search | Up/Down, Ctrl+R, `/prompts` | `message-history.ts` (global, 1000 entries) | yes | useful |
| `!` bash mode | `!` / `/bash` | `router.ts:378-419`, `bash-context-processor.ts` | partial | useful |
| ask_user | tool | `components/ask-user/` | yes | useful |
| Session resume/history/delete | `--continue [id]`, `/history` | `chat-history.ts`, `run-state-storage.ts` | yes | partial: no rename/export/fork-to-new |
| Edit-and-resend fork | edit a past message | `conversation-fork.ts:61-121` | yes | partial (same chat only) |
| Conversation undo/redo | `/undo`, `/redo` | `chat-store.ts:213,291-325` | yes | useful |
| File checkpoints | `/undo-turn`, `/restore`, `/bisect-turn` | `turn-snapshots.ts` (private ref, 50 kept) | yes | useful (git repos with commits only) |
| Headless | `openbuff run [--json] [--timeout]` | `run-command.ts:74-332` | yes | partial: no stdin/model/resume/schema |
| Replay / dashboard | `openbuff replay`, `openbuff dash` | `replay-command.ts`, `dash-command.ts` | yes | useful (unique) |
| ACP serve / attach / detach | `openbuff serve`, `--attach`, `/detach`, `/attach` | `serve-command.ts`, `attach-session.ts` | yes | useful (unix socket only) |
| Status bar | always on | `status-bar-chips.ts:495-710` | yes | useful, not configurable |
| Cost / usage | status chip (lg width only) | `status-bar-chips.ts:413-420,624-628`; `chat.tsx:611,754` | yes | partial: no `/usage` or `/cost` |
| Context budget | `/context` | `commands/context.ts` | yes | useful |
| Manual compaction | none | n/a | n/a | **absent** |
| Transcript export | output reader "E" only | `output-export.ts:8-21` (plain text) | partial | partial |
| Themes | `/theme:toggle`; OSC/IDE autodetect | `theme-system.ts`; `types/theme-system.ts:1` (dark/light) | yes | partial; custom themes unwired |
| Large transcript render | auto | `message-list-window.tsx` windowing; OpenTUI incremental markdown | partial | useful (100-message cap, see F7) |
| Terminal notify/title/images | auto | `terminal-notify.ts`, `terminal-title.ts`, `terminal-images.ts` | yes | useful |
| Code review picker | `/review` | `review-screen.tsx:19-61` | none | useful |
| Windows | release binary | `cli-release-build.yml:476-620` | build smoke only | partial |

## Findings

### cli-ux-01 · HIGH · First run has no guided setup, and API keys cannot be entered in the TUI
- **Axis:** usability, completeness.
- **Evidence:**
  - The TUI boots straight to the composer. The provider picker renders only when `providerPickerOpen` is set (`chat.tsx:2082-2083`). Only a `/setup` or `/provider` command result sets it (`chat.tsx:1046-1047`, `command-registry.ts:949-958, 1006-1012`).
  - The user first learns that no provider is configured after typing a prompt: readiness is checked in `use-send-message.ts:679`, with the message from `openbuff-provider.ts:987-1011`.
  - The custom-provider form only asks for an env-var *name* (`provider-picker-screen.tsx:47,153,195` "API key env (blank for none)").
  - The docs say to "Export it … and restart" (`docs/getting-started.md:123-127`). The banners have no setup hint: top-banner/help-banner contain no provider wording, and the only pointer is the `--help` epilog (`cli-args.ts:602`).
  - `docs/design/cli-overhaul/PLAN.md` (surface table, "Guided BYOK onboarding") lists this as planned. It is not implemented.
- **Impact:** a BYOK-only product is unusable until the user (1) learns a slash command, (2) quits, (3) exports an env var, and (4) relaunches. Pi has `/login` with stored keys and subscriptions (B§3.6), and OpenCode has `/connect` (B§1.6). Both finish in-session.
- **Fix:**
  - When readiness fails at boot, open the provider picker automatically, or show a one-line "No provider: press Enter to set up" banner.
  - Allow pasting a key that is stored in an OS keychain or a 0600 credentials file, keeping `apiKeyEnv` as an option.
  - Re-read the env/config without a restart.
- **Prior review:** new.

### cli-ux-02 · HIGH · Startup takes about 2 s to ready-to-type and about 210 MB idle; `--version` takes 0.83 s
- **Axis:** reliability/performance.
- **Evidence (measured):** three tmux launches of `cli/bin/openbuff --cwd /tmp/ob-startup` showed the composer ("Enter a coding task") after **1,760 / 1,910 / 2,101 ms**. Idle RSS after 5 s was **209–211 MB**. `openbuff --version` took **823–947 ms** and `--help` 830 ms.
- **Comparison:** OpenCode 2.0 ≈ 1,687 ms and Pi-Bolt 41 ms ready-to-type. Pi on Node is 423 ms (B§1.7, B§4.5). Codex is sub-50 ms (A§2).
- **Causes:**
  - Every command module, the SDK, OpenTUI and React are imported statically before argv is even parsed (`index.tsx:9-83`). That is why `--version` costs 0.8 s.
  - About 200 KB of wasm is read synchronously at import (`pre-init/tree-sitter-wasm.ts:35-43, 87-128`).
  - `initializeDirenv()` runs synchronously with `spawnSync` timeouts of up to 2 s plus 10 s (`init-direnv.ts:72-158`).
  - `startProjectIndex` does a synchronous `loadProviderConfigSync()` and index start (`init-app.ts:19-31`).
- `docs/design/cli-overhaul/PERFORMANCE.json` measures reader frames only, not boot.
- **Impact:** every launch, `openbuff run` included, pays about 1 s or more. This is the specific weakness reviewers cite against OpenCode (B§1.9).
- **Fix:**
  - Fast-path `--version`/`--help` before any heavy import.
  - Make the `run`/`serve`/`mcp`/`replay`/`dash` modules dynamic imports.
  - Run direnv with async spawn in parallel with the renderer.
  - Add a boot benchmark (ready-to-type, RSS) to CI and PERFORMANCE.json.
- **Prior review:** new. B32 ("baselines") covers release evidence, not boot budgets.

### cli-ux-03 · HIGH · Headless `openbuff run` lacks the basic scripting surface
- **Axis:** completeness, usability.
- **Evidence:**
  - `run` accepts only `<prompt...>`, `--json`, `--agent`, `--timeout` and `--approval-mode` (`cli-args.ts:280-353`).
  - Nothing reads stdin for the prompt. The only `process.stdin` readers are the OSC probe and a worker (`terminal-color-detection.ts:203,329`, `answer-pattern-process.ts:16`).
  - It has no `--model` (on `replay`, `--model` is only an annotation, `cli-args.ts:378-381`), no `--continue`/`--resume` (always `continue:false`, `cli-args.ts:341-344`), no output-schema option and no `-p` alias.
  - Text mode prints only `text` events (`run-command.ts:153-166`), so a human sees nothing during tool calls.
  - `run` skips the provider-readiness check that the TUI runs (`use-send-message.ts:679` is the only caller), so a missing key surfaces as a raw SDK error.
- **Strength:** the `--json` error line with `runOutcome.termination/cause.code` and exit code 1 is better structured than most CLIs (`run-command.ts:229-282`).
- **Competitors:**
  - Codex: `codex exec` with stdin, `--output-schema`, `-o`, `exec resume|fork` (A§2.2).
  - Claude Code and Gemini: `-p` with stream-json (A§1.2, A§3.2).
  - Pi: `-p` and RPC (B§3.2).
- **Fix:**
  - Read stdin when it is not a TTY and append it as a `<stdin>` block.
  - Add `--model`, `--continue [id]` and `--output-schema <file>`.
  - Make `-p` an alias.
  - Print one-line tool progress to stderr in text mode.
  - Run the readiness check up front, with a distinct exit code.
- **Prior review:** B02 (accepted) covers run-termination truth. These gaps are new.

### cli-ux-04 · MEDIUM · Messages cannot steer a running turn; Enter always queues
- **Axis:** completeness.
- **Evidence:**
  - The guarded submit always calls `addToQueue` while streaming or chaining (`command-registry.ts:286-304`).
  - "steer" does not appear anywhere in `cli/src`.
  - Interrupt aborts and pauses the queue (`chat.tsx:1396-1400`), so the user must stop the run to redirect it.
- **Competitors:** Codex: Enter steers, Tab queues (A§2.6). OpenCode: Enter steers, Ctrl+X Enter queues (B§1.6). Pi: steering vs follow-up queues (B§3.2).
- **Impact:** a user who sees the agent going wrong must either wait for the turn to finish or kill it and lose work in progress.
- **Fix:** add a steer action that injects a user message at the next tool-batch boundary through the SDK. Keep the current queue as "follow-up" on a second key, and show both in the help banner.
- **Prior review:** new. B10 (input transaction) only partly overlaps.

### cli-ux-05 · MEDIUM · Session management is thin, and the 100-message transcript cap is still present
- **Axis:** completeness, reliability.
- **Evidence:**
  - **01-F7 still present at HEAD:** `hooks/helpers/send-message.ts:352-353` (`next.slice(-100)`). Older CLI transcript rows are dropped before persistence.
  - **No rename or title:** `ChatHistoryEntry` has no name field, and the label is the first prompt cut to 100 chars (`chat-history.ts:9-37`).
  - **Fork stays in the current chat:** fork works only by editing a past message, and it truncates the current chat (`conversation-fork.ts:61-121`). There is no "fork to new session" and no tree.
  - **No transcript export:** the only export is plain text from the output reader to a temp dir (`output-export.ts:8-21`). There is no Markdown/JSON/HTML chat export, and no `/export` (`grep name: '(export|fork|rename)'` matches nothing in `cli/src`).
  - **Global prompt history:** history is shared across projects (`message-history.ts:145-153`).
- **Competitors:**
  - Pi: `/tree`, `/fork`, `/clone`, `/export` HTML/JSONL, `/share` (B§3.3).
  - Codex: `/rename`, `codex fork --worktree`, `/export` (A§2.3, A§2.5).
  - Claude Code: `--resume`/fork (A§1.3).
- **Fix:**
  - Separate the render working set from durable retention, as 01-F7 suggests.
  - Add `/rename`, `/fork` (to a new chat id) and `/export [md|json]`.
- **Prior review:** 01-F7 (still present); B13.

### cli-ux-06 · MEDIUM · No manual `/compact`, no `/usage` or `/cost`, and the cost display hides itself
- **Axis:** completeness, usability.
- **Evidence:**
  - `compact` appears in `chat.tsx` only as status-chip state (`chat.tsx:598-605`). No command or palette entry triggers compaction.
  - The cost chip is pushed only at `widthSize === 'lg'` and only when the cost is above 0 (`status-bar-chips.ts:624-628`), and it is the first chip dropped on overflow (`:652-659`). An unpriced BYOK model therefore looks free, with no "unknown" state.
  - Session cost lives in memory only (`chat.tsx:611,754`). There is no per-turn token or cost view; `/context` shows the token budget, not spend.
- **Competitors:**
  - `/compact` exists in Claude Code, Codex, Kiro and Pi (A§1.3, A§2.3, A§4.3, B§3.3).
  - Cost/usage: Claude Code `/usage`, Gemini `/stats` (A§1.6, A§3.6), Aider per-message cost (B§2.6), Pi footer plus `/session` (B§3.6).
- **Fix:**
  - Add `/compact [instructions]` that calls the runtime compaction.
  - Add `/usage` with per-turn tokens, cache hits and cost, and show "cost unknown" for unpriced models.
  - Persist the session total in chat-state.
- **Prior review:** B09 (usage/spend fidelity, not accepted) covers accuracy. The commands themselves are not covered.

### cli-ux-07 · MEDIUM · The slash catalog has drifted from the registry, and inline discovery is weaker than the palette
- **Axis:** cohesion, usability.
- **Evidence:**
  - **01-F8 still present:** `plans` and `plan-use` are registered (`command-registry.ts:1373,1423`) but absent from `data/slash-commands.ts`.
  - `publish` is registered (`:1207`) while its metadata is commented out (`slash-commands.ts:219-221`).
  - The menu id `agent:general` inserts `@general-agent ` (`slash-commands.ts:184`), but the registered `/general-agent` inserts `@General Agent ` (`command-registry.ts:1216-1221`). Typing `/agent:general` returns "Command not found".
  - **Inline menu is not fuzzy.** It matches prefix, then substring, then description (`use-suggestion-engine.ts:186-283`), even though `fuzzyMatch` is imported for files. The Ctrl+P palette does fuzzy-match (`command-palette-screen.tsx:105-166`).
  - **No argument hints.** `SlashCommand` has no usage field (`slash-commands.ts:9-24`). Many commands take subcommands (`/provider add|status|connect`, `/restore <sha> --apply <token>`, `/bisect-turn list|stop|--keep-best`).
  - **`/help` lists no commands.** It shows keys only (`help-banner.tsx:31-71`), while WIREFRAMES.md:288 describes `/help` as a directory.
  - Registry and metadata are parallel arrays.
- **Impact:** advanced features (snapshots, bisect, plans) exist but users can't discover how to call them.
- **Fix:**
  - Merge to one `CommandDefinition` with `description`, `usage` and `hidden`.
  - Use the palette's fuzzy scorer in the inline menu.
  - Render `usage` as ghost text after the command name.
  - Make `/help` a searchable command directory.
- **Prior review:** 01-F8 (still present); B11 (not accepted).

### cli-ux-08 · MEDIUM · Composer gaps: no `@file:line`, no `$EDITOR`, no vim mode, no keymap, and Tab does two jobs
- **Axis:** completeness, usability.
- **Evidence:**
  - **No line ranges:** `parseAtInLine` rejects `@` after `:` and does not parse `#`/`:` suffixes (`use-suggestion-engine.ts:117-157`). Mentions attach whole files, capped at 1 MB / 100 KB text (`pending-attachments.ts:248-250`).
  - **No `$EDITOR` binding and no vim mode:** the bindings are hardcoded in `resolveChatKeyboardAction` (`keyboard-actions.ts:129-372`), with no Ctrl+G handler. `CODEBUFF_EDITOR` (`open-file.ts:39`) only opens files.
  - **Tab is overloaded:** Tab opens the file menu (`:297-304`) and otherwise toggles agent mode (`:338-343`), so a stray Tab silently switches modes.
  - **Linear file scan:** each keystroke scans up to 10k paths (`common/src/project-file-tree.ts:148`).
- **Competitors:**
  - `@file:line`: Claude Code and Gemini v0.64 (A§1.6, A§3.1). `@file#20-45`: OpenCode (B§1.6).
  - Ctrl+G `$EDITOR` and vim composer: Codex (A§2.6).
  - Vim mode: Claude Code and Gemini.
- **Fix:**
  - Parse `@path:L1-L2` / `#L1-L2` into ranged attachments.
  - Add Ctrl+G to open `$EDITOR` on the draft.
  - Make Shift+Tab the only mode toggle.
  - Add a keymap override file.
  - Add vim mode later.
- **Prior review:** new.

### cli-ux-09 · MEDIUM · Ctrl+V runs up to four synchronous clipboard subprocesses on the UI thread
- **Axis:** reliability (performance, error handling).
- **Evidence:**
  - The paste handler calls, in sequence, `readClipboardFilePath()`, `readClipboardText()` and `hasClipboardImage()`, and then `readClipboardImage()` (`use-chat-keyboard.ts:219-266`).
  - Every one of them uses `spawnSync`, with timeouts of 1 s (osascript, text), 5 s (xclip/wl-paste TARGETS, each tried in turn) and 10 s (osascript save, PowerShell save) (`clipboard-image.ts:75-80,176-227,258,289,604-624`).
  - Windows starts PowerShell with System.Windows.Forms twice per image paste.
  - Linux text read has no `wl-paste` fallback (`clipboard-image.ts:622-624`).
  - The failure message does not name the missing tool ("No image found in clipboard or failed to read", `:235`).
  - No tests cover `clipboard-image.ts`.
- **Impact:** a paste can freeze rendering and input for seconds. On Wayland-only systems Ctrl+V text paste does nothing.
- **Fix:**
  - Use async `Bun.spawn` with a single combined probe per platform.
  - Add the wl-paste text fallback.
  - Name the missing tool (`install xclip or wl-clipboard`).
  - Add DI tests for missing binaries and timeouts.
- **Prior review:** new.

### cli-ux-10 · LOW · Only two themes, custom-theme code unwired, status line not configurable
- **Axis:** completeness, cohesion.
- **Evidence:**
  - `ThemeName = 'dark' | 'light'` (`types/theme-system.ts:1`). The only command is `/theme:toggle` (`command-registry.ts:1490-1503`).
  - `parseThemeOverrides` (`theme-system.ts:685`), `setThemeConfig` and `registerThemePlugin` (`theme-config.ts:53-65`) have no non-test callers.
  - Status chips are hardcoded (`status-bar-chips.ts:495-710`).
- **Competitors:** Claude Code has a scriptable statusline (A§1.6). Codex has `tui.status_line` and syntax themes (A§2.6). OpenCode and Pi have theme packages (B§1.5, B§3.5).
- **Fix:**
  - Wire `parseThemeOverrides` to a config key or `OPENBUFF_THEME_OVERRIDES`.
  - Allow a statusline command whose stdout replaces the right-hand chips.
  - Otherwise delete the dead plugin API.
- **Prior review:** new.

### cli-ux-11 · LOW · Possible auto-send of a just-queued prompt after interrupt
- **Axis:** reliability. Downgraded because it is unverified at runtime.
- **Evidence:**
  - `onInterruptStream` checks `queuedMessages.length` from the render closure, not `queuedMessagesRef` (`chat.tsx:1396-1400`). A prompt queued in the same tick may not trigger `pauseQueue()`.
  - `stopStreaming` sets idle and re-enables the queue without the `stillCancelling` guard that `clearMessages` uses (`use-message-queue.ts:715-718` vs `use-send-message.ts:383-393`).
  - There is no `use-message-queue` test for interrupt-then-pause.
- **Impact:** after Esc, a prompt can start that the user expected to be held.
- **Fix:** read the ref in the interrupt handler, guard `stopStreaming`, and add a DI test.
- **Prior review:** related to 01-cli "Cancellation and queued prompt ownership" (B10, not accepted). This specific path is new.

### cli-ux-12 · LOW · Windows support is build-smoke only
- **Axis:** completeness, reliability.
- **Evidence:**
  - PR CI runs only on `ubuntu-latest` (`.github/workflows/ci.yml:21,181,336`). Windows appears only as `build-windows-binary` plus `smoke-binary.ts` (`cli-release-build.yml:476-620`).
  - `WINDOWS.md` is a shadow.tech dev-machine guide that still covers a legacy browser-login issue (`WINDOWS.md:169`).
  - `detect-shell.ts:58-66` falls back to deprecated `wmic`.
  - `serve --socket`/`--attach` are unix-socket only (`cli-args.ts:160-162`).
  - The OSC theme probe and direnv are disabled on win32 (`index.tsx:544`, `init-direnv.ts:73`).
  - Embedded `rg.exe` is x64 only (`native/ripgrep.ts:27,113,147`).
  - Bash is required (`sdk/src/tools/run-terminal-command.ts:1068-1080`), with no PowerShell tool.
- **Competitors:** Claude Code (native PowerShell tool), Codex (Windows sandbox) and Pi-Bolt (Windows x64 native build, 78 ms start) (A§1.1, A§2.4, B§4.5).
- **Fix:**
  - Add a `windows-latest` CLI unit-test job.
  - Replace `wmic` with `Get-CimInstance`.
  - Support a named pipe for serve.
  - Rewrite WINDOWS.md as a user guide.
- **Prior review:** B32 partially (release evidence).

### cli-ux-13 · LOW · `openbuff init` is advertised as a subcommand but is not parsed as one
- **Axis:** cohesion. Behaviour inferred from code, not run.
- **Evidence:**
  - The `--help` epilog lists `init  Create local project context: openbuff init` (`cli-args.ts:602`).
  - No `'init'` branch exists in `cli-args.ts`, `index.tsx` or `binary-entry.ts`. The word becomes the positional `initialPrompt`.
  - `init` is a slashless implicit command (`slash-commands.ts:85-88`), so it opens the TUI and runs `/init`. `/init` writes `knowledge.md` and then *sends a model prompt* (`command-registry.ts:932-947`), which fails without a provider.
  - The competitor convention is `AGENTS.md` (A§2.3).
- **Fix:** add a real headless `init` subcommand, or reword the help text. Consider generating `AGENTS.md`.
- **Prior review:** new.

### cli-ux-14 · LOW · Non-prod builds print `Using environment: dev` on stdout
- **Axis:** cohesion, reliability.
- **Evidence:**
  - `common/src/env.ts:13-16` and `packages/internal/src/env.ts:30-33` call `console.log` at import whenever the environment is not prod. Observed on `cli/bin/openbuff --version`.
  - Release workflows set prod (`cli-release-prod.yml:108`), so installed users are unaffected.
  - Source and dev `openbuff run --json` output is not clean NDJSON. The prior review had to strip this line from evidence (`body-capability-review-2026-11-05/EVIDENCE-RECOVERY-MANIFEST.json:947`).
- **Fix:** write it to stderr, or only behind a debug env var.
- **Prior review:** observed in prior evidence but never filed. New.

### cli-ux-15 · LOW · Unwired components and code
- **Axis:** cohesion.
- **Evidence:**
  - `components/feedback-input-mode.tsx` and `components/raised-pill.tsx` have no production importer.
  - The DA1 image-capability parser is unwired (`terminal-images.ts:221-240`).
  - `index-05.tsx` is reachable only through the `smoke:opentui-05` script (`cli/package.json:25`).
  - The theme plugin API is unwired (see cli-ux-10).
- **Fix:** delete them, or wire them in.
- **Prior review:** new.

### cli-ux-16 · LOW · The alternate screen gives up native scrollback, and per-chunk work is O(messages)
- **Axis:** usability, performance.
- **Evidence:**
  - `screenMode: 'alternate-screen'` (`index.tsx:922-925`) means terminal search and scrollback do not see the transcript. The in-app output reader and find partly make up for this.
  - Each batched flush maps the whole message array (`message-updater.ts:35-39,141-143`), and `hasIncompleteCodeFence` scans the full text (`markdown-renderer.tsx:27-34`). This is bounded today only because of the 100-message cap that cli-ux-05 criticises. Raising the cap needs an id-indexed store.
- **Positive:** windowing (`message-list-window.tsx:32-46,202-243`) and OpenTUI incremental markdown (re-lexes the trailing 2 tokens) already avoid Pi's quadratic re-render (B§4.4).
- **Fix:** offer an inline (non-alternate) mode like pi-tui (B§3.6), and key message updates by id.
- **Prior review:** 01-F7 related.

## Competitive gaps

| Capability | Best-in-class and how | Openbuff state | Priority |
|---|---|---|---|
| In-session credential setup | Pi `/login` (keys and subscriptions); OpenCode `/connect` (B§3.6, B§1.6) | env var plus restart (cli-ux-01) | P0 |
| Boot time | Pi-Bolt 41 ms; Codex <50 ms (B§4.5, A§2) | ≈1.8–2.1 s, 210 MB (cli-ux-02) | P0 |
| Headless stdin/model/resume/schema | Codex `exec` with stdin, `--output-schema`, `exec resume` (A§2.2) | none (cli-ux-03) | P0 |
| Steer vs queue | Codex Enter/Tab; Pi steering/follow-up (A§2.6, B§3.2) | queue only (cli-ux-04) | P1 |
| Manual compact | `/compact` in Claude, Codex, Kiro, Pi | absent (cli-ux-06) | P1 |
| Usage/cost view | Claude `/usage`; Gemini `/stats`; Aider per-message (A§1.6, A§3.6, B§2.6) | lg-width chip only (cli-ux-06) | P1 |
| Session tree/fork/export | Pi `/tree` `/fork` `/clone` `/export` `/share` (B§3.3) | edit-fork in place; text export (cli-ux-05) | P1 |
| Rename sessions | Codex `/rename` (A§2.3) | absent | P2 |
| `@file:line` mentions | Gemini v0.64; OpenCode `@file#20-45` (A§3.1, B§1.6) | whole-file only (cli-ux-08) | P2 |
| `$EDITOR` / vim / keymap | Codex Ctrl+G, vim, `/keymap` (A§2.6) | none (cli-ux-08) | P2 |
| Configurable status line | Claude scriptable statusline (A§1.6) | hardcoded (cli-ux-10) | P3 |
| Themes | Codex syntax themes; Pi/OpenCode theme packages | dark/light (cli-ux-10) | P3 |
| Native scrollback | pi-tui differential render into scrollback (B§3.6) | alternate screen (cli-ux-16) | P3 |
| Combined code+conversation rewind | Claude `/rewind` code/convo/both; OpenCode `/undo` restores prompt (A§1.3, B§1.3) | separate `/undo` (convo) and `/restore` (files) | P2 |
| Windows CI and native shell | Claude PowerShell tool; Pi-Bolt Windows build (A§1.1, B§4.6) | build smoke only (cli-ux-12) | P2 |
| Voice input | Codex, Kiro, Aider `/voice` | absent | P3 |

## Strengths

- **File checkpoints with bisect.** Snapshots go to a private git ref through a temp index, so HEAD and the real index are never touched (`turn-snapshots.ts:35,228-251,423-511`). `/restore` previews and requires an exact `--apply <token>` (`snapshot-commands.ts:15-121`). `/bisect-turn` finds the first turn that broke the test suite (`command-registry.ts:740-875`). Codex and Kiro V3 have no file rewind (A§2.3, A§4.3), and none of the reference CLIs bisects turns.
- **Editable queue.** Queued prompts keep attachments and mode captured at enqueue. They can be edited, reordered, removed with undo, and are restored on send failure (`use-message-queue.ts:518-532`, `queue-screen.tsx`). Codex and Pi only queue or steer.
- **Headless failure contract.** `--json` ends with one machine-readable error line carrying `termination`/`cause.code`, `--timeout` is validated fail-closed, and runs are journaled for `openbuff replay` and `openbuff dash` (`run-command.ts:229-282`, `cli-args.ts:359-563`). No reference CLI has offline replay of recorded runs.
- **Attach/detach to a running ACP session.** `/detach` keeps the run going and `/attach` rejoins it (`command-registry.ts:640-722`). Only OpenCode's server model is comparable (B§1.6).
- **Streaming render is already incremental.** Viewport windowing with measured spacers (`message-list-window.tsx:32-46`) plus OpenTUI's 2-trailing-token incremental markdown lexing avoid the quadratic cost Pi-Bolt had to patch into Pi (B§4.4). Streaming updates are batched every 100 ms (`message-updater.ts:28`).
- **Discovery aids.** The Ctrl+P fuzzy palette has a per-project MRU (`command-mru.ts:20-64`). Ctrl+R searches prompt history. Unknown commands get "Did you mean" suggestions (`router.ts:493-517`). Skills become `/skill:*` commands.
- **Input robustness.** Pastes over 2000 chars collapse into attachments. Drag-dropped paths are detected (`clipboard-image.ts:350-396`). Emacs editing is grapheme-safe, with a 100-step undo (`multiline-input.tsx:366-474`). Keystrokes typed during boot are captured and replayed (`index.tsx:515-530`). ask_user answers are validated with a regex timeout (`ask-user/utils/validation.ts:21-40`).
- **Multi-model by design.** `/models` routes per mode and agent, and `/provider` handles BYOK, which Claude, Gemini and Kiro lack (A§1.6, A§3.6, A§4.6).

## Roadmap mapping

| Finding | Mapping |
|---|---|
| cli-ux-01 onboarding/credentials | not covered (cli-overhaul PLAN.md group 02 planned, not implemented) |
| cli-ux-02 startup time/memory | not covered (B32 partial: release baselines only) |
| cli-ux-03 headless surface | not covered (B02 accepted covers termination truth only) |
| cli-ux-04 steer | not covered (B10 partial) |
| cli-ux-05 sessions + 100-message cap | partially: B13 (01-F7 still present at `send-message.ts:352-353`) |
| cli-ux-06 compact/usage/cost | partially: B09 (spend accuracy); commands not covered |
| cli-ux-07 catalog drift/discovery | partially: B11 (01-F8 still present) |
| cli-ux-08 composer gaps | not covered |
| cli-ux-09 sync clipboard | not covered |
| cli-ux-10 themes/statusline | not covered |
| cli-ux-11 interrupt/queue race | partially: B10 |
| cli-ux-12 Windows | partially: B32 |
| cli-ux-13 `openbuff init` | not covered |
| cli-ux-14 stdout env banner | not covered |
| cli-ux-15 unwired code | not covered |
| cli-ux-16 alternate screen / O(n) updates | partially: B13 (via 01-F7) |
