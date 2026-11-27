# Shard `write-edit`: mutation tools, diff UX, undo and post-edit feedback

Audit date 2026-11-12, HEAD `f5aba489d`. Read-only. The only commands run were read-only `rg`/`sed`/`git log` and two in-memory `bun -e` measurements; neither wrote to the repository. No test suites were run, so every finding below is static evidence unless it says otherwise.

## Scope

**Inspected**
- Schemas in `common/src/tools/params/tool/`: `edit-transaction.ts` (read in full where model-visible), `write-file.ts`, `str-replace.ts`, `replace-range.ts`, `run-file-change-hooks.ts`, `rewrite-symbol.ts`, `rename-symbol.ts`, `extract-symbol.ts`, `code-action.ts`. For the last four, size and description only.
- Runtime handlers in `packages/agent-runtime/src/tools/handlers/tool/`: `edit-transaction.ts`, `edit-read-state.ts`, `str-replace.ts` (auto-reread section), `write-file.ts` (authorization section), `edit-application-coordinator.ts` (through a sub-agent trace), plus the thin forwarders `rename-symbol.ts`, `code-action.ts`, `extract-symbol.ts` and `run-file-change-hooks.ts`.
- Runtime processors:
  - `packages/agent-runtime/src/process-str-replace.ts`: the matching cascade at 2285–2502, diagnostics at 1607–1720, EOL restore at 1337–1419, near-match at 1730–1930.
  - `process-edit-transaction.ts`: preflight loop at 183–457 and per-variant apply at 1077–1388.
  - `process-file-block.ts` (full) and `generate-diffs-prompt.ts`.
- Tool tiers: `agents/base2/tool-tiers.ts` and `packages/agent-runtime/src/util/base2-tool-tiers.ts`. Edit guidance in `agents/base2/base2.ts:606-608`.
- Editor agents: `agents/editor/editor.ts` (variants and instructions) and `repair-editor.ts`.
- SDK:
  - `sdk/src/tools/change-file.ts` (decode at 1009–1025, limits at 1384–1420, single-file commit at 1594–1845).
  - `sdk/src/services/workspace-mutation-broker.ts` (commit at 247–375, lock and recovery at 575–840, path resolution and fsync at 905–1094).
  - `sdk/src/tools/transaction-intent-log.ts` (header, caps, `appendEvent`).
  - `sdk/src/tools/file-change-hooks.ts` (1494–1885).
  - `sdk/src/provider-config.ts:500-518,785-792`.
  - `common/src/util/content-hash.ts:125-225` and `common/src/util/raw-read-basis.ts`.
- CLI:
  - `cli/src/components/tools/diff-viewer.tsx`, `str-replace.tsx`, `edit-transaction.tsx`, and `registry.ts` (through a sub-agent trace).
  - `cli/src/utils/turn-snapshots.ts`, `cli/src/commands/snapshot-commands.ts`, `cli/src/hooks/helpers/send-message.ts:550-590`, `cli/src/data/slash-commands.ts`, and `cli/src/utils/command-approvals.ts` (through a sub-agent trace).
- Docs: `docs/deterministic-edit-system.md` (the edit sections), `docs/configuration.md:655-700`, `docs/agents-and-tools.md:98-108`, and `docs/environment-variables.md:39`.
- Prior review: `.agents/sessions/body-capability-review-2026-11-05/findings/06-edits.md` and `12-audit-docs.md` (12-F5), the PLAN card table, and `docs/execution/body-roadmap/STATE.md`. B03, B04 and B05 are accepted. B06 and B07 are not.

**Skipped or partial**
- The body of `processStrReplace` at `process-str-replace.ts` lines 239–1088 was covered by grep only.
- The `extract_symbol`/`code_action` SDK backends and the LSP multiplexer were not re-audited. They are owned by 06-F2/F6/F9 and B06/B25.
- The `rewrite_symbol` slicer internals were not read.
- `index-workspace-watcher` was not read.
- `cli/src/commands/help.ts` was not read, so whether the snapshot commands appear in `/help` is unverified.
- No live TUI or model runs were made, and no failure-rate measurements were taken.

## Feature inventory

| Feature | Entrypoint | Implementation | Tests | Maturity |
|---|---|---|---|---|
| `edit_transaction` (9 variants: str_replace, structured, create, delete, move, replace_range, rewrite_symbol, patch, write_file) | `common/src/tools/params/tool/edit-transaction.ts`; the only mutation tool base2 and editor expose (`base2-tool-tiers.ts:70`, `editor.ts:138`) | `handlers/tool/edit-transaction.ts`, `process-edit-transaction.ts`, `edit-application-coordinator.ts`, SDK `change-file.ts` | `process-edit-transaction.test.ts` (49 tests), `edit-application-coordinator.test.ts` (41), `edit-transaction-capability-guard.test.ts` (18), multi-file recovery e2e (2) | useful |
| SEARCH/REPLACE edit-block payload | `OPENBUFF_EDIT_BLOCKS`, default on (`edit-transaction.ts:600-616`) | `common/src/tools/params/edit-blocks.ts` | `edit-blocks.test.ts`, `evals/edit-blocks/scenario.test.ts` (parser only) | useful (str_replace only) |
| Standalone `str_replace` / `write_file` / `replace_range` / `rewrite_symbol` | Registered but not in any base2 tier. Listed only in MODE_NEUTRAL (`agents/base2/tool-tiers.ts:83-101`) and in test-writer handoffs | `handlers/tool/*.ts`, `process-str-replace.ts`, `process-file-block.ts` | `process-str-replace.test.ts` (108), `write-file.test.ts` (5), replace-range tests | compatibility-only (unwired for root) |
| `rename_symbol` / `code_action` / `extract_symbol` | base2 `implement` tier (`base2-tool-tiers.ts:71-73`) | Runtime forwarders call SDK LSP services | SDK LSP tests | partial (see 06-F2/F6/F9) |
| `apply_patch` (Codex envelope) | Removed. `stream-parser.ts:375-394` shims old calls | Runs through edit_transaction `patch` | `apply-patch.test.tsx` (legacy renderer) | absent (unified diff only) |
| Fuzzy matching | Inside str_replace | Indentation, comment-prefix, `...` elision, and Levenshtein near-match ≥0.92 (`process-str-replace.ts:1752,2285-2502`) | `process-str-replace.test.ts` | useful, risky (F04) |
| Read-before-edit / stale detection | Strict by default (`stream-parser.ts:268`) | `edit-read-state.ts:72-188`, cap.v4 tokens (`content-hash.ts:131-183`), SDK CAS (`change-file.ts:1617-1680`, broker `:268-275`) | capability-guard and coordinator tests | useful, costly (F01) |
| Atomic multi-file | Preflight all edits in memory, then a guarded sequential commit with best-effort rollback | `process-edit-transaction.ts:358-376`, `change-file.ts` | multi-file e2e (2 tests) | partial (B06/B07) |
| Byte fidelity (BOM/CRLF/UTF-8) | n/a | `byte-text.ts` captureTextDocument and splice helpers; `restoreLineEndingsFromOriginal`; `UNSUPPORTED_BINARY` (`change-file.ts:1009-1025`) | `process-str-replace.test.ts`, `change-file.test.ts`, `line-coordinates.test.ts` | useful for localized edits; whole-file writes lossy (F06) |
| Large-file edits | 16 MiB/file, 64 MiB/transaction (`change-file.ts:1391-1420`); write_file shrink guard (`process-file-block.ts:24-66`) | the same files | partial | useful |
| Diff rendering | `cli/src/components/tools/diff-viewer.tsx` | Native OpenTUI `<diff>`, collapse past 80 lines / 8 hunks (`:62-80`) | CLI renderer tests | useful |
| Edit approval / diff preview before write | none | Approval modes cover commands and MCP only (`command-approvals.ts:3-19`) | n/a | absent (F03) |
| Turn snapshots / undo | `/undo-turn`, `/restore`, `/bisect-turn` (`slash-commands.ts:246-260`) | Shadow ref `refs/openbuff/turns` (`turn-snapshots.ts:35,423-528`) | `turn-snapshots.test.ts`, `snapshot-preview.test.ts`, `restore-shape-and-identity.test.ts` | partial (F02) |
| Conversation undo | `/undo`, `/redo` (`slash-commands.ts:112-122`) | chat store | — | useful, but unlinked from files (F02) |
| Post-edit lint/format/diagnostics | `run_file_change_hooks`; base2 gate calls it programmatically (`base2.ts:5727`) | `sdk/src/tools/file-change-hooks.ts:1574-1840` | gate e2e tests | partial: off by default, gate-only (F05) |
| Editor subagent | `agents/editor/editor.ts` (6 model variants) | `edit_transaction` only | `agents` suite | useful |

## Findings

### write-edit-01 · Read-capability protocol is the dominant model-facing cost and failure mode
- **Axis:** usability / cohesion. **Severity:** HIGH.
- **Evidence:**
  - A `cap.v4` token is base64url JSON with an HMAC (`common/src/util/content-hash.ts:160-181`). For a 50-line scoped read I measured **795 characters**, and the code allows up to 4,096 (`:178`). Every complete read mints one; every edit result appends `postEditCapabilities` (`docs/deterministic-edit-system.md`, "Staged read-before-edit enforcement").
  - Models must copy these high-entropy tokens verbatim into `basedOnRead`/`readCapability`. Strict mode is on by default (`packages/agent-runtime/src/tools/stream-parser.ts:268`).
  - The recovery protocol has three authorization tiers, `context_compacted` stickiness, auto-reread exceptions and capability-first retry rules. It needs about 9 KB of editor prompt (`agents/editor/editor.ts:150-200`) and about 500 lines of docs.
  - The editor code itself records the cost: non-Opus variants "are more prone to landing zero committed edits from a strict read-before-edit harness" (`agents/editor/editor.ts:24-29`).
  - The `edit_transaction` model-facing description plus provider schema is about 11.3k characters (4,248 description + 7,021 JSON schema, measured). That is roughly 2.8k tokens per request, before base2's own edit contract (`base2.ts:606-608`).
- **Impact:**
  - Each scoped read or edit adds about 250–350 tokens of opaque text to context.
  - Weaker BYOK models fail to reproduce tokens or follow the protocol, which shows up as blocked or zero-edit runs.
  - By comparison, hash-anchored designs (oh-my-pi hashline: a short per-line content hash) get the same staleness protection with tokens of a few characters, and Claude Code needs no token at all (exact match on current content).
- **Fix:**
  - Keep the HMAC binding server-side. Hand the model a short handle (for example `r12`) that maps to the full capability in runtime state. Alternatively, make line-hash anchors in `read_files` output the edit address.
  - Measure edit-commit rate per model before and after the change.
- **Prior review:** new. B05 accepted the byte authority, not its model ergonomics.

### write-edit-02 · Turn snapshots miss pre-turn state, agent-created files and cancelled turns, so `/undo-turn` can revert the wrong turn
- **Axis:** reliability / completeness. **Severity:** HIGH.
- **Evidence:**
  - Snapshots are taken only after a *successful* turn (`cli/src/hooks/helpers/send-message.ts:564-576`; "Aborts and errors return above"). User `!` commands also get one (`cli/src/commands/router.ts:109`).
  - No baseline is captured before the agent's first edit. On a fresh repository, `/undo-turn` after turn 1 finds no `snapshots[1]`.
  - `/undo-turn` always targets `snapshots[1]` (`cli/src/commands/snapshot-commands.ts:79`). Consider turn N committed (S_N), then turn N+1 errors or is cancelled after editing. `/undo-turn` restores S_{N-1}, which also reverts turn N. The preview diff (`turn-snapshots.ts:97-196`) is the only safeguard.
  - Only tracked files are captured (`git add -u`, `turn-snapshots.ts:233-234,462-498`). Files the agent creates are untracked, so they are never captured and never removed: "Files absent from the target are not deleted" (`snapshot-commands.ts:61`).
  - Restore uses `checkout-index -a -f` over tracked files. Manual edits the user made after the last snapshot are overwritten without being captured, though the preview shows them.
  - Outside a git repo the feature is `unavailable`.
  - Pruning writes repo-global `refs/replace/*` (`turn-snapshots.ts:584-607`).
- **Impact:** The headline "undo what the agent just did" flow is unreliable in exactly the cases where users need it: the first turn, a failed turn, and newly created files. Claude Code checkpoints every prompt, keeps 100 checkpoints, and restores code, conversation or both. Gemini snapshots before every approved file-modifying tool call, in a shadow repo outside the user's `.git`.
- **Fix:**
  - Snapshot *before* each turn and before each mutating tool batch, keyed by turn ID. Include agent-created paths using the receipts the broker already has (`changeFiles` actions).
  - Make `/undo-turn` target "state before turn X", not "previous snapshot".
  - Store snapshots in a shadow repo outside `.git` so they are not mirror-pushed and do not touch `refs/replace`.
  - Link file restore to `/undo` (conversation) as a single rewind menu.
- **Prior review:** new. B34 (isolated work/landing) is adjacent but does not cover undo.

### write-edit-03 · No approval, preview or protected paths for file mutations
- **Axis:** completeness / security. **Severity:** MEDIUM.
- **Evidence:**
  - Approval modes `balanced`/`strict`/`allow-all` cover commands only (`cli/src/utils/command-approvals.ts:3-19`). `requestApproval` is called for shell (`sdk/src/host-execution.ts:~200`) and MCP (`sdk/src/run.ts:~3003`), never on the `change-file.ts` path.
  - No write-time guard for `.git/**`, `.env*` or keys was found in `change-file.ts`, `filesystem-authority.ts` or `workspace-mutation-broker.ts`. `isSensitivePath` in `sdk/src/serve/event-bridge.ts:168-173` only redacts display output.
  - The CLI cannot show a pending diff: `shouldShowEditDiff` hides diffs until the result exists (`cli/src/utils/implementor-helpers.ts:606-616`).
- **Impact:** Users cannot run in a "review each edit" mode (Claude Code default/acceptEdits, Gemini `default`/`autoEdit`, Kiro "Supervised" with `.git/**` always-ask). Plan mode is the only write gate (`agents/base2/tool-tiers.ts:130-134`).
- **Fix:**
  - Add an `edits: ask|allow` axis to the approval mode, with the prepared preflight diff as the approval payload. Preflight already computes per-file patches (`process-edit-transaction.ts:400-412`).
  - Add hard-ask protected globs (`.git/**`, `.env*`, the agent's own config).
- **Prior review:** B18 (approval identity) covers commands; edits are not covered.

### write-edit-04 · Near-match auto-correct applies 92%-similar edits silently from the user's view
- **Axis:** reliability. **Severity:** MEDIUM.
- **Evidence:**
  - When exact, indentation and comment matching fail, `tryNearMatchAutoCorrect` applies `newStr` over the closest block at Levenshtein similarity ≥0.92 with a 0.05 margin (`process-str-replace.ts:1752-1770,2427-2457`). The code comment says this is meant to absorb "content remembered from a slightly-stale read" (`:1747-1750`).
  - The result is a model-facing warning: "INHERENTLY RISKY … VERIFY the result" (`:2446-2455`). `hadAutoCorrect` is dropped on the `edit_transaction` path (`process-edit-transaction.ts` returns only `content`/`messages`). The CLI has no auto-correct indicator: no `auto-correct` or `hadAutoCorrect` match in `cli/src`, and the row renders as `applied` (`cli/src/components/tools/str-replace.tsx:200`).
- **Impact:** If an external writer changed a few characters inside the target block, the near-match overwrites that change. The CAS check passes because the preimage is the current file. Claude Code deliberately has no fuzzy matching. OpenCode and Pi limit fuzz to quote, dash and whitespace normalization.
- **Fix:**
  - Limit auto-apply to normalization-only differences (Unicode quotes and dashes, trailing whitespace, CRLF).
  - Turn the Levenshtein tier into a diagnostic with a ready `replace_range` retry.
  - Otherwise surface `auto-corrected` in the CLI row and receipt.
- **Prior review:** new.

### write-edit-05 · Post-edit feedback is opt-in, gate-only, and the docs contradict the code
- **Axis:** completeness / cohesion. **Severity:** MEDIUM.
- **Evidence:**
  - The defaults are `fileChangeHooks: []` and `autoFileChangeHooks: undefined` (`sdk/src/provider-config.ts:789-790`). Inference runs only when the value `=== true` (`sdk/src/tools/file-change-hooks.ts:1605,1619`), so a default project returns `no_hooks_configured` (`:1633-1645`).
  - `docs/configuration.md:667` still says "When `autoFileChangeHooks` is unset or `true`, Openbuff also infers…". `docs/agents-and-tools.md:103-105` and the schema comment (`provider-config.ts:514`) say explicit true.
  - Timeout: the docs say "default 180" (`docs/configuration.md:699`), the schema comment says "Omitted means no timeout" (`provider-config.ts:508`), and the code uses 300 (`file-change-hooks.ts:51`).
  - The diagnostic delta needs `OPENBUFF_DIAGNOSTIC_PREFLIGHT` and at least one matching hook (`:1495-1503,1761-1768`).
  - `run_file_change_hooks` is not in base2's model-visible tiers (`base2-tool-tiers.ts:29-78`). It runs only in base2's programmatic end gate (`agents/base2/base2.ts:5727,5989,7340`).
  - The tool's own description promises "client-configured and manifest-inferred native validation" (`common/src/tools/params/tool/run-file-change-hooks.ts:19`).
  - Formatter hooks rewrite files outside the broker and report no new hashes, so the next edit hits `stale_state` instead of an informed re-read.
- **Impact:** Out of the box, the model gets no lint or type feedback after an edit, unlike Claude Code (LSP diagnostics after edits), Aider (`--auto-lint`/`--auto-test`) and OpenCode V1. Users who follow the docs expect inference that is not on.
- **Fix:**
  - Correct the docs and the timeout comment.
  - Offer a one-command trust opt-in (`/hooks trust`) that the CLI suggests when a manifest is detected.
  - Attach cheap per-file diagnostics, such as the existing tree-sitter syntax gate or LSP pull diagnostics where already running, to every `edit_transaction` result.
  - After a hook runs, refresh read authority for files it changed.
- **Prior review:** 12-F5. The inference default is **fixed** at HEAD. The timeout contract mismatch is **still present**, and the docs regression is new. B36 and B27 are partial.

### write-edit-06 · Whole-file writes drop the BOM and convert CRLF to LF
- **Axis:** reliability. **Severity:** MEDIUM. The behaviour is likely; no fixture was executed.
- **Evidence:**
  - The observation text the model sees "uses LF and excludes a leading UTF-8 BOM" (`docs/deterministic-edit-system.md`, byte-identity paragraph).
  - The `write_file` transaction variant takes `edit.content` verbatim (`process-edit-transaction.ts:1376-1380`). The SDK writes `type==='file'` content as given (`sdk/src/tools/change-file.ts:1700`). `process-file-block.ts:137-145` says the same for standalone writes.
  - Localized variants restore endings: str_replace through `restoreLineEndingsFromOriginal` (`process-str-replace.ts:1350-1419`), range and symbol edits through `spliceDocumentRange`.
- **Impact:** A whole-file rewrite of a CRLF or BOM file produces a diff touching every line, plus a silent encoding change. That is noisy for reviews and breaks Windows-sensitive files.
- **Fix:** Apply the original document's dominant terminator and BOM to `write_file`/`create`-over-existing content unless the model opts out. Add a fixture.
- **Prior review:** 06-F7 (BOM preimage) is fixed for localized edits (`byte-text.ts` `ignoreBOM:true`). 06-F8 (range/symbol CRLF) is **fixed** (`spliceDocumentRange`). This whole-file variant is new and falls under B05's acceptance scope.

### write-edit-07 · Many edit surfaces, one exposed; stale names in model-visible guidance
- **Axis:** cohesion / usability. **Severity:** LOW.
- **Evidence:**
  - Nine registered mutation tools plus nine `edit_transaction` variants. base2 exposes `edit_transaction` plus three LSP tools (`base2-tool-tiers.ts:65-78`). The standalone `str_replace`/`write_file`/`replace_range`/`rewrite_symbol` remain registered with full descriptions (`str-replace.ts` 10.8 KB, `replace-range.ts` 7.5 KB) for compatibility.
  - The editor prompt says `cap.v3` five times and its example uses `"cap.v3.from-editAnchor"` (`agents/editor/editor.ts:155-158,204-217`). The runtime mints `cap.v4`, and v3 "supplies no fresh raw edit authority" (`docs/deterministic-edit-system.md`).
  - The apply_patch shim tells models to use `write_file({ path, instructions, content })` (`stream-parser.ts:389-394`, `write-file.ts:51`). base2 cannot call `write_file` directly, and `instructions` is not part of the transaction `write_file` variant.
- **Impact:** Mixed signals in prompts. A model that sees a v3 example may hallucinate v3-shaped tokens.
- **Fix:** Replace the v3 wording with the version-agnostic "readCapability". Point the shim at `edit_transaction`. Consider unregistering the standalone tools for new sessions.
- **Prior review:** new.

### write-edit-08 · No per-model edit format
- **Axis:** completeness. **Severity:** MEDIUM.
- **Evidence:**
  - All six editor variants, including `gpt-5` → `openai/gpt-5.3`, use the same `edit_transaction` JSON or SEARCH/REPLACE surface (`agents/editor/editor.ts:10-37,155`).
  - `OPENBUFF_EDIT_BLOCKS` is a global flag, not keyed to a model (`edit-transaction.ts:600-616`). The edit-blocks eval only pins the parser (`evals/edit-blocks/scenario.test.ts`).
  - No eval measures edit commit or no-match rate per model. `evals/buffbench/retrieval-flow-metrics.ts:5-12` only classifies edit tool calls.
  - The Codex `*** Begin Patch` envelope has no native surface. The `patch` variant is a unified diff applied through `diff.applyPatch` (`process-edit-transaction.ts:1342-1375`).
- **Impact:** BYOK users run many model families. Aider's per-model format table and the hashline result (+15 points on average; competitors/B.md §3.8) show that format choice changes edit success by large margins. OpenCode gives `patch` to GPT models only.
- **Fix:** Add a model-family format registry: apply_patch envelope for GPT/Codex, SEARCH/REPLACE for Gemini and DeepSeek, JSON for Claude. Add a buffbench metric for committed-edit rate and first-try match rate per model.
- **Prior review:** new.

### write-edit-09 · Snapshot ref and intent log store plaintext user content; receipts grow unbounded
- **Axis:** reliability / security. **Severity:** LOW.
- **Evidence:**
  - `refs/openbuff/turns` holds uncommitted tracked content and is pushed by `git push --mirror` (`turn-snapshots.ts:240-245`, disclosed in code).
  - The intent log keeps plaintext pre-images (`transaction-intent-log.ts` header, "RESIDUAL PLAINTEXT RISK").
  - Broker receipts accumulate in `receiptsDir`; listing is capped, storage is not (sub-agent trace, `workspace-mutation-broker.ts:528-548`).
- **Impact:** Possible secret leak through a mirror push, and disk growth.
- **Fix:** Move snapshots to a shadow repo under the state directory (same fix as F02). Add receipt retention.
- **Prior review:** new (disclosed in code, untracked).

### write-edit-10 · Prior edit-authority findings at HEAD
- **Axis:** reliability. **Severity:** MEDIUM for the residuals.
- **Evidence:**
  - **06-F1: fixed.** Contenders never reclaim the lock; a dead or unknown owner raises a recovery error (`workspace-mutation-broker.ts:600-611,636-643`). Residual: a crash leaves a lock that needs manual recovery, and no user-facing recovery command was found.
  - **06-F3: narrowed.** `rollback_failed` maps to applied only with a proven retained forward effect (`common/src/tools/results/filesystem.ts:~1243-1350`, sub-agent trace).
  - **06-F10:** still an 8 MiB versus 64 MiB mismatch (`transaction-intent-log.ts:128` versus `common/src/actions.ts:44`). It now fails closed (`transaction-intent-log.ts:935-945`), so valid 8–64 MiB transactions are refused. The model-facing message ("Split the work") is acceptable.
  - **06-F11:** fixed (bounded reader).
  - **06-F12: partly present.** `absoluteFromRelative` is still lexical-only on recovery (`workspace-mutation-broker.ts:932-944`). `resolvePath` realpaths only the parent (`:905-930`).
  - **06-F2/F6/F9** (semantic and LSP edits): not re-verified here; owned by B06.
- **Impact:** Ordinary edits are well guarded. Crash-recovery and semantic-refactor edge cases remain open.
- **Fix:** Continue with B06/B07. Add a `/doctor`-style "mutation lock/receipt recovery" action.
- **Prior review:** 06-F1/F3/F10/F11/F12. B04 is accepted; B07 is not.

## Competitive gaps

| Capability | Best in class and how | Openbuff state | Priority |
|---|---|---|---|
| Undo / rewind | Claude Code: per-prompt checkpoints (100 kept, survive `--resume`), `/rewind` restoring code, conversation or both, plus summarize-from-here. Gemini: shadow git before every approved file-modifying tool, `/restore` re-proposes the call. OpenCode: per-step git snapshots, `/undo` restores files and conversation and puts the prompt back | Post-turn tracked-only snapshots, a separate `/undo` for conversation, no baseline or agent-created files (F02) | P0 |
| Per-edit approval and preview | Claude Code default/acceptEdits; Gemini autoEdit; Kiro Supervised, with `.git/**` always-ask | None (F03) | P1 |
| Post-edit diagnostics | Claude Code LSP diagnostics after every edit; Aider auto-lint/test; OpenCode V1 LSP | Opt-in hooks, end-of-turn gate only (F05) | P1 |
| Cheap stale-safe anchors | oh-my-pi hashline (short per-line hash); Claude Code exact match on current content after a read | About 800-character HMAC tokens (F01) | P1 |
| Per-model edit format | Aider per-model `edit_format`; OpenCode `patch` for GPT only; Codex apply_patch | One surface for all models (F08) | P1 |
| Multi-file atomic edit | Codex `apply_patch` (multi-file per call) | Equal or better: `edit_transaction` preflights everything, commits sequentially with rollback and receipts | — |
| Conservative fuzz | Pi/OpenCode: NFKC, quotes, dashes, trailing whitespace only | Levenshtein ≥0.92 auto-apply (F04) | P2 |
| Encoding refusal | Claude Code refuses U+FFFD writes and non-UTF-8 edits | Equal: `UNSUPPORTED_BINARY` refusal for invalid UTF-8 (`change-file.ts:1009-1025`) | — |
| Formatter integration | OpenCode runs a configured formatter after edit/write | Hooks are validation-only, and formatter rewrites invalidate read authority without notice (F05) | P2 |

## Strengths

- **Preflight-all, commit-guarded multi-file transactions with structured recovery.**
  - Any preflight failure changes no files and returns `failures[]`, an `errorCode` and a `recovery` packet naming only the failing paths (`process-edit-transaction.ts:358-376`).
  - The commit uses a CAS staging file, fsync, rename and a post-commit hash check (`workspace-mutation-broker.ts:248-325`).
  - No reference CLI combines atomic preflight with durable per-file receipts. Codex is atomic per call but has no receipts; Claude Code and Gemini edit one file at a time.
- **Stale-file protection is stronger than every competitor's.** It has three hash layers: normalized, raw and exact (`change-file.ts:1617-1680`). Broker CAS sits under a cross-process lock. str_replace gets a one-shot auto-reread on an authorization miss (`handlers/tool/str-replace.ts:211-234`), which roughly matches Claude Code's "apply if still matches".
- **Actionable no-match diagnostics.** Errors list closest candidate ranges with similarity scores and a ready `read_files` call (`process-str-replace.ts:1623-1694`). Ambiguous matches list every occurrence with `occurrenceIndex` guidance (`:1705-1720`). A tiny-anchor guard refuses short anchors that match in several places even under `allowMultiple` (`:2327-2349`). Claude Code reports only "not unique" or "not found".
- **Byte fidelity on localized edits.** BOM and mixed EOL are preserved on str_replace, range and symbol edits (`process-str-replace.ts:989-991,1350-1419`; `byte-text.ts` splice). Invalid UTF-8 and unpaired surrogates are refused.
- **Large-file safety.** A write_file shrink guard blocks truncated-context overwrites (`process-file-block.ts:24-66`). Windowed, around and symbol reads mint complete-block capabilities. Explicit 16/64 MiB limits return split guidance.
- **Diff UX.** Native unified diffs show line numbers, per-hunk collapse and `+N -M` summaries (`diff-viewer.tsx:62-80,431-485`). Ten mutation states are distinguished, including `rolled_back`, `rollback_incomplete` and `unconfirmed` (`str-replace.tsx:191-309`). Capability tokens are redacted from the UI.
- **`/restore` is safe.** It shows a preview and requires a token-bound apply that is revalidated before writing (`turn-snapshots.ts:97-215`). `/bisect-turn` finds the first snapshot that breaks a test command, which no competitor offers.

## Roadmap mapping

| Finding | Coverage |
|---|---|
| write-edit-01 capability token cost | not covered (B05 covers byte authority only) |
| write-edit-02 snapshot/undo gaps | not covered (B34 adjacent) |
| write-edit-03 edit approval / protected paths | partially (B18 covers command approval identity only) |
| write-edit-04 near-match auto-correct | not covered |
| write-edit-05 post-edit feedback and docs | partially (12-F5 → B36/B27; the inference default is fixed, the docs and timeout are not) |
| write-edit-06 whole-file EOL/BOM | partially (B05 scope; whole-file case not in acceptance) |
| write-edit-07 stale names / surface sprawl | not covered |
| write-edit-08 per-model edit format and evals | not covered (B30/B31 evaluation could host the metric) |
| write-edit-09 plaintext snapshot/receipt retention | not covered |
| write-edit-10 prior 06-F* residuals | covered by B06/B07 (B04 accepted; 06-F12 residual under B07) |
