**01-cli — Openbuff CLI as a model body**

Pinned snapshot: `ec141833a7efa94cd25b0e2c964fc2c832ce5983b2446c03769515032360deb0`. 60 inventory files, 76 merged inspected sections, 13848 inspected source lines. All 18 picker-selected files / 20 sections were read. This is selected-range inspection, not a full-line or 685-file CLI audit.

The ordinary chat body is real: it mounts SDK dispatch, agent/tool streaming, questionnaires and inspectable single-use approvals, context/compaction status, provider recovery, history/plan pickers and editable queues. The strongest remaining gaps cross entrypoint boundaries: plan artifact reads accept physical path escape, slash prompts bypass destructive-bisection preflight, attached TUI sends require unrelated local provider readiness, and non-ready attachments are consumed without the intended context. These are current implementation traces and provider-free probes, not historical audit claims.

The 100-message cap affects live and subsequently persisted CLI transcript blocks. SDK RunState/model history and compaction archive are separate. The probe does not establish model-context loss.

Nine safe stub probes passed under Bun 1.3.5 (/tmp/openbuff-body-review-2026-11-05/evidence/01-cli-probes.log). They assert observed defects, not desired acceptance. No provider requests, credential reads, source edits, live socket calls or destructive git bisection were performed. Existing native component tests were read; the full CLI/CI suite was not run.

| Capability | Maturity | Assurance |
| --- | --- | --- |
| Interactive chat and mode/model switching | usable | static trace + unit |
| Command palette, skills and game preset discovery | partial | static trace |
| File/folder/text/image attachments and guaranteed file-menu reads | partial | static trace + unit |
| Questionnaire and single-use approval interaction | usable | static trace |
| Root/subagent/tool streaming and completion presentation | usable | static trace |
| Cancellation and queued prompt ownership/recovery | partial | static trace + unit |
| Saved history browsing, restoration and retained conversation output | partial | static trace + unit |
| Durable plan discovery, resume/status and artifact drilldown | partial | static trace + unit |
| ACP attach/detach session UI | partial | static trace + unit |
| Context/compaction/model/status and provider diagnostics | usable | static trace |
| Turn snapshot, conversation undo/redo and tracked-file restore affordances | unknown | static trace of CLI discovery/dispatch only |

**Interactive chat and mode/model switching.** Normal chat is production-wired from the mounted composer to SDK execution. Registry readiness prevents first-turn validation against an empty post-startup registry. Non-renderer dispatch suppresses terminal OSC probing and installs stderr-safe process error handling.

Trace: entrypoint: `cli/src/index.tsx:443`, `cli/src/index.tsx:630` → implementation: `cli/src/chat.tsx:734`, `cli/src/hooks/use-send-message.ts:779` → consumer: `cli/src/chat.tsx:1279`, `cli/src/chat.tsx:1928`, `cli/src/commands/command-registry.ts:1176` → tests: `cli/src/components/__tests__/session-route-recovery.test.tsx:25`, `cli/src/commands/__tests__/prompt-dispatch.test.ts:107` → docs: `docs/request-flow.md:33`, `docs/local-mode.md:106`.

States: failure: Provider-readiness failures produce an inline error; unexpected client construction and empty validation errors have the F5/F6 gaps. loading: Deferred registry reads settle before validation and dispatch; waiting/streaming status starts after client creation. empty: Router permits attachment-only input and otherwise ignores blank prompts; image-only runs receive a nonempty fallback prompt. cancellation: Run signal and ownership are wired; cancellation before client creation has no newly installed controller. retry: Explicit resubmission works on ordinary reported errors; automatic inference retry belongs to SDK/runtime; F5 can block resubmission. permission: Local SDK requestApproval callback is installed through createRunConfig; enforcement is outside this CLI-only assurance.

Gaps: F3: attach uses local routing validation despite remote execution. F5/F6: some pre-run failures do not behave like recoverable rejected submissions. Headless/server/MCP/replay/dashboard command internals were delegated to the execution/durability shards; this assessment proves startup dispatch only.

**Command palette, skills and game preset discovery.** Modes and aliases are generated from a shared modes constant. Engine presets avoid hardcoded shell commands and preserve an editable prompt boundary. Unknown commands fail locally even while an agent is busy.

Trace: entrypoint: `cli/src/data/slash-commands.ts:34` → implementation: `cli/src/data/slash-commands.ts:290`, `cli/src/commands/command-registry.ts:1493` → consumer: `cli/src/chat.tsx:390`, `cli/src/chat.tsx:394`, `cli/src/chat.tsx:1940` → tests: `cli/src/commands/__tests__/prompt-dispatch.test.ts:119`, `cli/src/components/__tests__/session-route-recovery.test.tsx:138` → docs: `docs/agents-and-tools.md:1957`, `docs/agents-and-tools.md:2051`.

States: failure: Unknown slash input returns suggestions as a local input error; malformed local command operations have bounded result/loading surfaces. loading: Registry readiness refreshes skill suggestions once asynchronous scans settle. empty: No engine profiles means no engine presets; empty skill map keeps the ordinary commands. cancellation: Overlays close without running inserted preset text; command-specific cancellation is handled by consumers. retry: Local diagnostic routes can be reinvoked; palette does not own SDK retries. permission: Engine preset selection inserts a prompt for review; executable skill/agent trust is handled by registries, not the menu.

Gaps: F8: /plans and /plan-use handlers and aliases are missing from the static suggestion/palette catalog. Engine build/run/test/watch rows are prompt scaffolds, not independent native engine execution adapters. Skill loading/execution policy was not audited as a language/runtime capability in this shard.

**File/folder/text/image attachments and guaranteed file-menu reads.** File-menu selection performs a real source read instead of leaving @path as an instruction for the model to notice. Provenance and incomplete-context warnings are delivered to the model. Recovery tracks identity/revisions and preserves the composer draft.

Trace: entrypoint: `cli/src/chat.tsx:2026`, `cli/src/hooks/use-chat-keyboard.ts:219` → implementation: `cli/src/utils/pending-attachments.ts:522`, `cli/src/utils/pending-attachments.ts:317`, `cli/src/hooks/helpers/send-message.ts:263` → consumer: `cli/src/chat.tsx:1946`, `cli/src/hooks/helpers/send-message.ts:171`, `cli/src/components/__tests__/attachment-recovery.test.tsx:166` → tests: `cli/src/components/__tests__/attachment-recovery.test.tsx:82`, `cli/src/components/__tests__/attachment-recovery.test.tsx:157`, `cli/src/components/__tests__/attachment-recovery.test.tsx:252` → docs: `docs/request-flow.md:39`, `docs/agents-and-tools.md:2000`.

States: failure: Read failures remain error attachments with retained earlier capture during retry; F4 consumes non-ready files on submission instead of preserving/recovering them. loading: Async reads expose processing status; ordinary prompts wait, prompt-producing slash commands bypass that check. empty: Empty files/directories receive explicit markers; metadata-only and binary files are not falsely labelled full source. cancellation: Recovery retries use revision/identity checks; removing/undoing a pending item cannot accept a stale result. retry: Recovery screen can retry/remove/undo, but a file drained by F4 is no longer available there. permission: Initial file attachment and retry check mandatory sensitive-file paths; project file selection uses project containment. General user-selected attachments may intentionally originate outside the project.

Gaps: F4: pending processing files and failed files can disappear without model context or a stored file attachment. The content capture is bounded and can be shallow or metadata-only; selecting a directory does not read every source file. The file preview's character cap and displayed byte-size label are not a complete active-read guarantee.

**Questionnaire and single-use approval interaction.** Question/approval identity is carried through mounted UI callbacks. Draft input is preserved during submit/skip. Complete approval target is inspectable even when question labels are truncated.

Trace: entrypoint: `cli/src/utils/create-run-config.ts:259`, `cli/src/utils/codebuff-client.ts:229` → implementation: `common/src/utils/ask-user-bridge.ts:37`, `cli/src/hooks/use-ask-user-bridge.ts:69`, `cli/src/utils/create-run-config.ts:189` → consumer: `cli/src/chat.tsx:246`, `cli/src/components/chat-input-bar.tsx:189`, `cli/src/components/chat-input-bar.tsx:285` → tests: `cli/src/components/__tests__/provider-recovery.test.tsx:47`, `cli/src/components/__tests__/provider-recovery.test.tsx:220`, `cli/src/__tests__/unit/create-run-config.test.ts:9`, `cli/src/hooks/__tests__/use-ask-user-bridge.test.ts:7` → docs: `docs/request-flow.md:377`, `docs/agents-and-tools.md:101`.

States: failure: Deny/custom/skip returns false for harness approval; form validation keeps input editable with visible error. loading: Question state pauses main elapsed timer while waiting for user input. empty: Custom text is always offered; duplicate 'other' options are filtered. cancellation: Form stop interrupts run and skips; bridge resolves pending/waiting requests as skipped on their abort signal. retry: Invalid form answers remain editable; a denied action requires a new request rather than replaying approval. permission: Approval display preserves complete target; callback checks stable Allow once label. This is UI wiring assurance only, not proof of the runtime's policy/receipt enforcement.

Gaps: Actual hook mount, request-ID scoping and subscriber cleanup are not exercised by the legacy use-ask-user-bridge named test file. No live runtime approval or external connector flow was performed. Remote ACP permission requests are delegated to the SDK/execution shard.

**Root/subagent/tool streaming and completion presentation.** Direct-child reasoning and text remain in the same agent destination. Specialized and generic tool renderers are actually consumed. Per-agent rendering failure does not have to destroy the rest of the chat view.

Trace: entrypoint: `cli/src/utils/create-run-config.ts:251` → implementation: `cli/src/utils/stream-chunk-processor.ts:13`, `cli/src/hooks/helpers/send-message.ts:401` → consumer: `cli/src/components/blocks/blocks-renderer.tsx:196`, `cli/src/components/blocks/blocks-renderer.tsx:229`, `cli/src/components/blocks/agent-block-grid.tsx:50` → tests: `cli/src/hooks/__tests__/use-send-message-ownership.test.ts:96`, `cli/src/components/__tests__/attachment-recovery.test.tsx:252` → docs: `docs/agents-and-tools.md:288`.

States: failure: Per-block/agent render boundaries preserve inspection and retry; run errors are rendered through userError. loading: AI shell begins waiting then stream handlers update blocks; agent/tool cards carry ongoing state. empty: Empty text chunks are no-ops; empty agent groups render nothing. cancellation: Abort marks running agents/tools cancelled, interrupts compaction state and appends interruption notice before completion. retry: Render retry/inspect is separate from inference retry; SDK/runtime owns provider retries. permission: Tool output is evidence for display; a successful renderer is not a permission attestation.

Gaps: The full 2,000+ line event handler and all block implementations were sampled, not audited line-by-line. No provider-driven nested streaming run was performed.

**Cancellation and queued prompt ownership/recovery.** Run-owner and execution-owner identities separate conversation replacement from cooperative SDK cancellation. Queue rejection recovery retains user data and prevents automatic retry loops. Abort terminal block writes settle before reopening normal queue gates.

Trace: entrypoint: `cli/src/hooks/use-chat-keyboard.ts:146`, `cli/src/chat.tsx:2212`, `cli/src/hooks/use-chat-streaming.ts:208` → implementation: `cli/src/hooks/use-send-message.ts:448`, `cli/src/hooks/helpers/send-message.ts:408`, `cli/src/hooks/use-send-message.ts:819` → consumer: `cli/src/chat.tsx:1984`, `cli/src/hooks/use-message-queue.ts:519`, `cli/src/chat.tsx:575` → tests: `cli/src/hooks/__tests__/use-send-message-ownership.test.ts:24`, `cli/src/hooks/__tests__/use-send-message-ownership.test.ts:96`, `cli/src/components/__tests__/attachment-recovery.test.tsx:18` → docs: `docs/request-flow.md:379`.

States: failure: True send rejections restore/pause queue; F5 holds chain occupancy after client creation rejection; resolved pre-run failure does not trigger the queue's rejection recovery. loading: Queue exposes busy/paused/processing status and retained attachment read state. empty: Empty queued item is explicitly paused rather than dispatched. cancellation: SDK abort preserves run state and occupancy; queue editing/removal cancels stale pending attachment retries. retry: Queue UI supports restore/edit/reorder/remove/undo and resume; a failed send must communicate rejection/acceptance for that recovery to work. permission: Queue insertion records prompt/attachment/mode identity; it is not authorization for a classified high-impact action.

Gaps: F2: bisection occupancy is not part of the shared send gate for prompt-producing commands. F5: client initialization rejection can leave ordinary retries queued indefinitely. F6 and provider-readiness early returns resolve void, so unstarted queued work is removed without entering onRejected recovery. Queued attachment images cannot round-trip binary payload through the text prompt journal; exit drain records a locating note.

**Saved history browsing, restoration and retained conversation output.** History scans use bounded parallel I/O and preserve unavailable captures for recovery inspection. Deleted IDs prevent background scan results from resurrecting deleted rows. Restore and archive hydration guard late results against changed run/session identity.

Trace: entrypoint: `cli/src/commands/command-registry.ts:1229`, `cli/src/app.tsx:172` → implementation: `cli/src/utils/chat-history.ts:144`, `cli/src/hooks/use-send-message.ts:184`, `cli/src/hooks/helpers/send-message.ts:350` → consumer: `cli/src/components/chat-history-screen.tsx:96`, `cli/src/hooks/use-chat-messages.ts:206`, `cli/src/utils/run-state-storage.ts:897` → tests: `cli/src/components/__tests__/session-route-recovery.test.tsx:76` → docs: `docs/request-flow.md:372`, `docs/architecture.md:41`.

States: failure: History list reports partial/unavailable rows; actual restore loader returns null on failure and the mounted continue effect silently returns after App already reset/closed history. loading: History list has two-phase loading; prompt dispatch waits for restore promise. The restore effect has no exposed loading/error route of its own. empty: No saved sessions yields empty history; unavailable capture rows remain discoverable for inspection. cancellation: List and restore use abort/cancel identities to avoid writes after unmount or replacement. retry: History list offers retry; there is no explicit retry outcome from a failed selected-session restore. permission: Delete requires confirmation and chat ID validation; this shard did not audit all storage containment/redaction paths.

Gaps: F7: 100-message truncation deletes older CLI transcript blocks and those capped blocks are later persisted; visual paging cannot fetch discarded blocks. This establishes CLI transcript retention loss only. SDK RunState, model history and compaction archive are separate; model-context loss is not established by the probe. Selected-session restore failure is conflated with absent history: app.tsx:178 resets, use-send-message.ts:195 returns on null, run-state-storage.ts:612 catches to null. History list searches up to 500 saved sessions; it is not a paginated unbounded catalog.

**Durable plan discovery, resume/status and artifact drilldown.** Local status and page inspection need no model. 64 KiB actual reads bound allocation, expose truncation and preserve UTF-8 page boundaries. Resume mode change is consistent between picker UI, persistent mode and submitted run.

Trace: entrypoint: `cli/src/commands/command-registry.ts:1265`, `cli/src/commands/command-registry.ts:1333`, `cli/src/commands/command-registry.ts:1359` → implementation: `cli/src/commands/plan-artifacts.ts:31`, `cli/src/commands/plan-artifacts.ts:137`, `cli/src/commands/plan-artifacts.ts:495` → consumer: `cli/src/components/plan-session-picker-screen.tsx:73`, `cli/src/chat.tsx:1897`, `cli/src/chat.tsx:2070` → tests: `cli/src/components/__tests__/session-route-recovery.test.tsx:138` → docs: `docs/local-mode.md:67`, `docs/agents-and-tools.md:321`.

States: failure: Missing target opens picker; missing/malformed artifacts give local message; F1 defeats physical path containment. One unreadable candidate in listPlanSessionsAsync rejects its whole Promise.all batch. loading: Picker loading state and bounded parallel scans are production-wired. empty: Missing sessions directory returns empty list; sessions without known regular-file artifacts are omitted. cancellation: Picker aborts list on unmount; list checks signals between batches. retry: Picker failure supports explicit retry; raw artifact reads propagate to local command operation error surface. permission: Lexical path resolver rejects ../ escape; it does not resolve symlink targets. Plan artifacts are read into prompts without the general active-read policy.

Gaps: F1: prefix/page readers can follow a session or artifact symlink outside the workspace. F8: plans/plan-use discovery is missing from menu catalog despite live handlers. Bounded/truncated artifact preflight is weaker than complete plan readiness; actual state execution/gate semantics are delegated to durability/orchestration shards. Plan listing has no per-session partial failure isolation; unreadable/deleted candidate can fail otherwise readable catalog.

**ACP attach/detach session UI.** Remote backend choice occurs before singleton creation. Attach/detach hide backend internals behind structural SDK methods. Exit detach and unavailable state are explicit, bounded UI contracts.

Trace: entrypoint: `cli/src/cli-args.ts:78`, `cli/src/index.tsx:553` → implementation: `cli/src/utils/codebuff-client.ts:175`, `cli/src/utils/attach-session.ts:50`, `cli/src/utils/attach-session.ts:106` → consumer: `cli/src/data/slash-commands.ts:228`, `cli/src/hooks/use-send-message.ts:679`, `cli/src/commands/command-registry.ts:264` → tests: `cli/src/utils/__tests__/attach-session.test.ts:54`, `cli/src/utils/__tests__/attach-session.test.ts:96` → docs: `cli/src/cli-args.ts:78`, `docs/architecture.md:49`.

States: failure: Detach/attach return structured never-reject outcomes; F3 prevents remote run if local config is empty/unroutable. loading: Remote connection/session loading is SDK/backend-owned; this shard did not perform a real socket attach. empty: No attach target/backend support or no detached ID has explicit unavailable/no-session outcomes. cancellation: Exit detach is bounded and preserves remote run by closing client transport; cooperative run abort policy belongs to ACP backend. retry: /attach retries the same remembered ID in the same process. permission: Socket path/token flags are recorded; token verification and server trust/session authorization are delegated.

Gaps: F3: intended server-side inference still requires client-side provider configuration. lastDetachedSessionId is module-only; /attach after process restart has no persisted session selector in this slice. This is an explicit partial feature, not a hidden default-mode defect. Passive resumed streaming and actual socket failure semantics remain unknown here; unit stubs do not establish them.

**Context/compaction/model/status and provider diagnostics.** Context/compaction is event-driven rather than inferred from UI text. Diagnostic partial results survive a hung sibling check. Null/unavailable states are visible and cancellation discards late results.

Trace: entrypoint: `cli/src/chat.tsx:591`, `cli/src/commands/command-registry.ts:1097` → implementation: `cli/src/utils/sdk-event-handlers.ts:1469`, `cli/src/components/provider-picker-screen.tsx:330` → consumer: `cli/src/chat.tsx:2198`, `cli/src/components/status-bar.tsx:181`, `cli/src/chat.tsx:2065` → tests: `cli/src/components/__tests__/provider-recovery.test.tsx:321`, `cli/src/components/__tests__/provider-recovery.test.tsx:356` → docs: `docs/request-flow.md:193`, `docs/local-mode.md:64`.

States: failure: Invalid config/connection checks render errors; malformed diagnostic enumeration stays in mounted picker with retry. loading: Waiting/working/retrying/connecting indicators and diagnostics running rows are explicit. empty: Unreported context/compaction stays null/Not reported rather than fabricated numeric state. cancellation: Diagnostics abort on cancel/unmount and reject late rows; status Stop uses run interrupt. retry: Diagnostic all/provider retry is UI-owned; inference retries are observed via events. permission: Diagnostic checks test configured providers; no secret values were read or provider tests performed during this audit.

Gaps: Displayed model is configured for the selected mode, not a verified receipt for every currently running subagent/provider call. Status and diagnostic component code/tests were inspected; live model telemetry was not exercised. Cost/compaction accounting accuracy and runtime event production are separate shard responsibilities.

**Turn snapshot, conversation undo/redo and tracked-file restore affordances.** User-facing labels clearly separate transcript undo from file restore. Snapshot creation has real normal-turn and shell entrypoint calls rather than only a planned menu row.

Trace: entrypoint: `cli/src/data/slash-commands.ts:106`, `cli/src/data/slash-commands.ts:240` → implementation: `cli/src/hooks/helpers/send-message.ts:548`, `cli/src/commands/router.ts:108`, `cli/src/commands/command-registry.ts:15` → consumer: `cli/src/hooks/use-send-message.ts:848`, `cli/src/commands/router.ts:113` → tests: `cli/src/commands/__tests__/prompt-dispatch.test.ts:181` → docs: `docs/request-flow.md:96`, `docs/local-mode.md:67`.

States: failure: Snapshot failure logs structured warning; exact restore failure/apply receipt semantics were not inspected in this shard. loading: Pre-shell snapshot is awaited with a bounded helper; turn-end snapshot is fire-and-forget. empty: Menu descriptions expose preview/confirmation intent, but actual empty snapshot response is delegated. cancellation: Bisection has stop state and cleanup; F2 lets prompt-producing commands bypass its admission guard. retry: Snapshot/backend restore retry semantics are unknown here. permission: Labels distinguish conversation edits from tracked-file restore and require exact displayed apply action; backend permission/restore receipt enforcement is not established by labels.

Gaps: Full tracked-file snapshot/restore/bisection correctness belongs to the durability/execution shards and is unknown here. F2 is a verified CLI admission gap, not a claim that snapshot storage itself is absent. Successful-turn fire-and-forget capture ordering and omitted/untracked files require backend review before rating restore usable.

**Ranked current findings**

**01-F1 · HIGH · Plan artifact readers follow symlinks outside the project boundary** (security, api-contract; high confidence; evidence).

Trigger: Open a project whose .agents/sessions/<slug> directory, or known PLAN.md artifact, is a symlink to a readable file/directory outside the project, then run /resume-plan <slug> or /plan-artifact <slug> PLAN.md.

Consequence: The declared project boundary is bypassed. Resume can send outside file bytes to the configured model without general active-read sensitive-path policy. Private-file disclosure is a conditional consequence of such a target; the audit used harmless fixture text and did not read credentials.

Evidence: `cli/src/commands/plan-artifacts.ts:397` — resolvePlanSessionDir normalizes/path.resolves and only compares lexical prefix, with no physical path check. `cli/src/commands/plan-artifacts.ts:96` — Paged artifact reader opens the resolved path with ordinary fs.open, following symlinks. `cli/src/commands/plan-artifacts.ts:476` — Prompt artifact reader opens known artifact names through the same lexical directory. `cli/src/commands/command-registry.ts:1291` — Resume embeds read artifact bodies into agent prompt. `/tmp/openbuff-body-review-2026-11-05/evidence/01-cli-probes.test.ts:196` — Safe fixture probe confirms a session symlink outside the project is accepted and both readers include outside bytes; see probe log.

Suggested fix: Resolve and validate physical project/session/artifact paths before reading, reject paths outside intended workspace/session scope, and apply mandatory sensitive-read policy to the actual target. Keep the check coupled to the opened file to address replacement races.

Acceptance probe: Create a harmless outside file plus session-directory and artifact-file symlinks; prefix read, page read and resume must reject outside targets while ordinary in-project artifacts still work. The existing safe probe currently shows rejection is absent.

**01-F2 · HIGH · Prompt-producing slash commands bypass the active bisection admission guard** (correctness, state-mutation; high confidence; evidence).

Trigger: Start /bisect-turn while no agent chain is running, then submit /mode:default <mutating request>, /resume-plan <slug>, /interview <request> or another prompt-producing registered command.

Consequence: The CLI admits an agent run while bisection is rewriting the tracked tree. A later snapshot checkout can replace edits from that concurrent run. The probe establishes admission bypass; real destructive concurrent git execution was not performed.

Evidence: `cli/src/commands/router.ts:488` — Registered command handler returns before ordinary prompt preflight. `cli/src/commands/router.ts:526` — Bisection guard is only after registered command dispatch. `cli/src/commands/command-registry.ts:289` — sendPromptCommand checks stream/message/chain occupancy but not active bisection. `cli/src/commands/command-registry.ts:1187` — Mode trailing prompt calls shared helper directly. `cli/src/utils/turn-snapshots.ts:1217` — Cancelled bisection checks out newest snapshot tree before releasing its lock. `/tmp/openbuff-body-review-2026-11-05/evidence/01-cli-probes.log:1` — isTurnBisectionRunning=true probe blocks an ordinary prompt and dispatches /mode:default with the same prompt.

Suggested fix: Put bisection/attachment preflight in the common prompt admission helper or a single lower transaction boundary used by every user, command, picker, action and queue path; preserve bisection stop/list local controls.

Acceptance probe: With bisection active, table-test every prompt-producing entrypoint and assert no send/queue admission capable of starting a turn; keep /bisect-turn stop/list reachable. After stopping, the same prompt must dispatch normally.

**01-F3 · MEDIUM · Attached TUI validates local providers before invoking its remote backend** (correctness, api-contract; high confidence; evidence).

Trigger: Start a configured serve process, then attach from a TUI process that has no local provider config (or whose local routes differ from the server).

Consequence: The remote backend never receives the prompt despite being ready; users are told to configure a local provider for server-side execution.

Evidence: `cli/src/index.tsx:555` — Attach target is recorded before client creation. `cli/src/utils/codebuff-client.ts:175` — Attach mode selects AcpRemoteBackend, leaving inference to live serve. `cli/src/hooks/use-send-message.ts:679` — Provider readiness runs unconditionally for both in-process and attached clients. `cli/src/utils/openbuff-provider.ts:1001` — No local config/providers returns not-configured failure. `/tmp/openbuff-body-review-2026-11-05/evidence/01-cli-probes.log:1` — Real hook + ready remote stub + empty local config yields remoteRuns=0 and inline provider-not-configured error.

Suggested fix: Make readiness validation backend-owned. Check local provider routing only for in-process execution; expose and consume ACP server/session readiness/allowed models for remote runs.

Acceptance probe: Use a ready injected ACP backend with empty/unroutable client-local config and assert its run receives the prompt. Keep fail-closed local readiness tests for in-process execution and explicit remote connection/auth errors.

**01-F4 · MEDIUM · Submission drains non-ready file attachments without including or retaining them** (correctness, state-mutation, error-handling; high confidence; evidence).

Trigger: Select a file and submit a prompt-producing slash command before its async read finishes; or submit an ordinary prompt after a selected file entered error state.

Consequence: The model receives no file bytes or failure note and the file disappears from attachment recovery/message display. A late read result cannot restore the removed item. This defeats guaranteed file-menu context at the send boundary.

Evidence: `cli/src/commands/router.ts:488` — Slash command execution precedes processing attachment check. `cli/src/commands/router.ts:520` — Ordinary prompt preflight checks processing status, not failed status. `cli/src/hooks/helpers/send-message.ts:263` — All pending attachments are drained. `cli/src/hooks/helpers/send-message.ts:290` — Only ready file attachments enter model context. `cli/src/hooks/helpers/send-message.ts:321` — Only ready file attachments are preserved for message display. `cli/src/utils/pending-attachments.ts:496` — Initial asynchronous completion updates only current composer attachments, so a drained processing item cannot settle there. `/tmp/openbuff-body-review-2026-11-05/evidence/01-cli-probes.log:1` — Processing slash-file and ordinary failed-file probes both remove the pending file and send only bare prompt text.

Suggested fix: Validate all captured attachments at a single admission boundary. Keep processing/failed items in recoverable state until an explicit retry/remove/approved metadata-only disposition; reserve and commit attachment drains only once an accepted send has the intended context.

Acceptance probe: For ordinary/slash/picker/queued sends, inject processing, ready, failed and metadata-only files. Processing/failed files must remain recoverable with visible status and no silent dispatch; ready/approved metadata captures must carry provenance and matching content exactly once.

**01-F5 · MEDIUM · Client initialization rejection leaves the turn and queue locked** (state-mutation, error-handling, test-coverage; high confidence; evidence).

Trigger: getCodebuffClient rejects during initialization or lease/backend setup after message preparation.

Consequence: UI displays 'Please try again', but retries observe busy occupancy and queue behind a turn that never started. Resetting the conversation or exiting is needed to release this state. A real factory outage was not caused; the failure contract was exercised through its existing seam.

Evidence: `cli/src/hooks/use-send-message.ts:448` — Send claims chain/queue occupancy before async setup. `cli/src/hooks/use-send-message.ts:598` — getCodebuffClient is awaited outside the run try/finally. `cli/src/hooks/use-send-message.ts:890` — Owner release/safety reset begins only in the later run finally. `cli/src/utils/codebuff-client.ts:366` — Factory can propagate errors; returned promise is not a never-reject contract. `cli/src/chat.tsx:856` — Mounted submit catch appends generic error without releasing send ownership. `/tmp/openbuff-body-review-2026-11-05/evidence/01-cli-probes.log:1` — Fault-injected client factory rejection preserves chainBusy=true and canQueue=false.

Suggested fix: Wrap the complete owned send transaction, including client creation and streaming setup, in one owner-aware cleanup boundary; release only this send's chain/queue occupancy and retain rejected prompt/context for retry.

Acceptance probe: Inject a client factory rejection and assert chain/queue locks are released, visible failure is retained, attachments/draft are recoverable and the next normal submit is admitted; keep late-old-failure/new-owner tests passing.

**01-F6 · MEDIUM · Validation exceptions become silent resolved submissions** (error-handling, correctness, test-coverage; high confidence; evidence).

Trigger: Local validation unexpectedly throws; the real validator catch converts it to a false result with an empty error list.

Consequence: The user's cleared prompt appears in history and then work stops without a reason or retry state. For queued prompts, this resolves as successful processing, so unstarted work does not enter rejection restoration.

Evidence: `cli/src/hooks/use-agent-validation.ts:187` — Validation catch logs and returns {success:false, errors:[]}. `cli/src/hooks/use-send-message.ts:531` — Empty failure errors intentionally produce an empty validationErrors array. `cli/src/hooks/use-send-message.ts:561` — The failed submission returns void after release, with no user-visible error. `cli/src/hooks/use-message-queue.ts:511` — Queue item is removed before sending. `cli/src/hooks/use-message-queue.ts:111` — Queue restoration sees only rejected send promises. `/tmp/openbuff-body-review-2026-11-05/evidence/01-cli-probes.log:1` — Production-shaped empty validation failure returns with user/mode messages but no visibleFailure.

Suggested fix: Return a visible sanitized validation failure with nonempty error content and communicate a rejected/not-accepted send outcome to queue ownership. Distinguish preparation/validation rejection from accepted run completion rather than using Promise<void> fulfillment for both.

Acceptance probe: Inject a validator exception in the mounted send/queue path. Assert visible failure reason, queue/draft/attachments retained or recoverable, no SDK invocation, correct ownership release and successful explicit retry after validator recovery.

**01-F7 · MEDIUM · The 100-message cap discards durable CLI transcript before paging can reach it** (state-mutation, correctness, performance; high confidence; evidence).

Trigger: Continue a conversation whose CLI transcript exceeds 100 messages (including mode/system/bash rows), then send another prompt and allow it to persist.

Consequence: Older visible CLI output and prior tool/agent presentation are removed from live and later saved CLI transcript; paging/searching that transcript cannot reach them. This is a bounded-retention design gap, not evidence of SDK model-history loss: RunState/model history and compaction archive are separate and unchanged by this line.

Evidence: `cli/src/hooks/helpers/send-message.ts:350` — Preparation truncates complete live ChatMessage[] to next.slice(-100). `cli/src/hooks/use-chat-messages.ts:206` — Load previous only increases visibleMessageCount; it does not read discarded history. `cli/src/hooks/use-send-message.ts:839` — Completion persists currentMessages after this truncation. `cli/src/utils/run-state-storage.ts:847` — Serialization persists the supplied message array rather than retaining older blocks. `cli/src/utils/run-state-storage.ts:897` — Envelope and chat-messages sidecar are updated from the same serialized retained messages. `docs/request-flow.md:372` — Model continuation history is a separate RunState field. `/tmp/openbuff-body-review-2026-11-05/evidence/01-cli-probes.log:1` — 105 seeded CLI messages plus preparation retain 100 and remove old-0; model history was not involved.

Suggested fix: Separate rendering/working-set limits from durable transcript retention. Keep a paged archive or explicitly documented retention policy with export/recovery before trimming; do not grow the renderer's hot working set without a measured bound.

Acceptance probe: After >150 CLI messages and a save/reload, the oldest retained-by-policy message must be accessible through archive paging/export or the UI must explicitly disclose the retention cutoff. Separately assert SDK RunState continuity to prevent conflating the two stores.

**01-F8 · LOW · Live plan list/active-session commands are absent from the advertised command catalog** (api-contract, test-coverage; high confidence; evidence).

Trigger: Search slash suggestions or command palette for the documented plan listing or active-session selection command.

Consequence: Functional local controls are unavailable through their ordinary discovery surface; users must know hidden typed command names. Registry and catalog have drifted.

Evidence: `cli/src/commands/command-registry.ts:1359` — Executable registry defines /plans and alias plan-ls. `cli/src/commands/command-registry.ts:1410` — Executable registry defines /plan-use and plan-active/use-plan aliases. `cli/src/data/slash-commands.ts:124` — Static menu lists resume/update/status/artifact/lessons but its complete array has no plans or plan-use entries. `cli/src/chat.tsx:394` — Suggestions are derived from that menu array plus skills/presets. `cli/src/chat.tsx:1941` — Command palette is passed the same array. `docs/agents-and-tools.md:1957` — Docs call the menu array authoritative for every registered command. `docs/local-mode.md:78` — Docs advertise /plans and /plan-use as ordinary local controls.

Suggested fix: Add the missing discoverable plan commands and aliases, then derive executable and menu metadata from one command contract with explicit hidden entries rather than maintaining parallel arrays.

Acceptance probe: Every intended discoverable executable command, including plans/plan-use, must appear in slash suggestions and palette, resolve each alias and retain its real local dispatch behavior; explicitly exempt insertion-only or intentionally hidden commands.

**Eight-domain assessment**

| Domain | Assessment |
| --- | --- |
| security | Physical containment gap F1 is verified with harmless outside-project bytes. Strengths: project file-menu reads use project containment; initial attachments/retries check mandatory sensitive path policy; approvals preserve complete targets and UUID request identity. Runtime policy, token auth, connector authorization, credential storage/redaction and terminal permission enforcement were delegated and are not proven by UI wiring. |
| correctness | F2/F3/F4/F6/F7/F8 are concrete current trigger/consumer mismatches. Ordinary in-process chat, registry readiness, mode/picker routing and local diagnostic controls are mounted and production-wired. Headless/server/replay internals remain delegated. |
| state-mutation | Symbol run ownership, separate SDK execution occupancy, identity-guarded archive hydration, atomic normal attachment drain, stale attachment retry rejection and deleted-history filtering are valuable existing guards. F2/F4/F5/F7 identify boundaries not covered by those guards; queue restoration only sees actual promise rejection. |
| error-handling | Read/load/provider/diagnostic/render error and retry surfaces are substantial. F5 leaks occupancy after client factory rejection; F6 turns validator exceptions into silent success-shaped processing. Selected-session restore null is silent after App reset. Plan list has batch-level rather than per-session failure isolation. |
| performance | Inspected bounds are explicit: 64 KiB plan prefix/pages, batches of 12 plan reads and 32/16 history stats/transcript reads, file preview max 1 MiB/read and 100 KiB characters, 100 shallow directory entries, memoized renderer handler refs and visual message paging. F7 shows an unmeasured retention tradeoff implemented as transcript deletion. No latency/memory benchmark, O(n^2) claim or 'best possible' comparison is made. |
| dependency-hygiene | cli/package.json declares the external libraries imported by selected CLI paths and pins Bun 1.3.5, React 19.2.0, and matching OpenTUI core/react 0.5.12. Other dependency ranges and root React overrides exist; full lock/advisory/pruned-install audit was not done here. SDK imports resolve to dist per sdk/package.json, so source-only review is not proof of shipped SDK parity. PATH Bun 1.3.14 FFI failure is a documented toolchain mismatch, not a new product finding. |
| test-coverage | Picker-selected tests and bounded adjacent native component/ownership/router cases were read. Nine provider-free safe probe assertions executed under Bun 1.3.5 with the supported OpenTUI preload, 9 pass/0 fail; they assert observed failures, not desired acceptance. Legacy use-ask-user-bridge tests copy helper bodies instead of importing/mounting the hook and do not establish request-ID scope/cleanup. Existing entire CLI/CI schedule, real socket attach and live-provider flows were not run. |
| api-contract | Parser/backend dispatch is explicit and protocol paths return before renderer. F1 violates physical project-boundary intent; F3 violates remote execution's client-provider independence; F8 separates executable plan handlers from advertised command catalog. /undo and /redo explicitly preserve files; tracked-file restore is separately labelled preview/exact apply. Full restore/backend contract assurance is delegated. |

**Grounded plan inputs**

1. **P0: Close physical artifact-read containment.** Covers 01-F1. Prefix/page/resume reject session/artifact symlink escapes and mandatory sensitive targets; normal local artifacts remain usable.

2. **P0: Unify prompt admission across CLI entrypoints.** Covers 01-F2, 01-F4. Ordinary input, command arguments, mode input, plan picker, execution action and queue share bisection and attachment-state checks; none silently loses context or admits concurrent bisection mutation.

3. **P1: Make send acceptance/failure an explicit owned transaction.** Covers 01-F5, 01-F6. Client/validation/preparation failure releases its own occupancy, displays a reason, preserves retriable prompt/context and restores unaccepted queue work without disturbing newer owners.

4. **P1: Make attach readiness and session selection backend-owned.** Covers 01-F3. Ready serve receives prompt with empty client-local provider config; backend connection/auth/readiness errors are surfaced; decide explicitly whether reattach survives process restart.

5. **P1: Separate transcript retention from render paging and restore outcome.** Covers 01-F7. Long saved transcript remains browsable under an explicit archive/retention policy; failed selected-session restore has loading/error/retry/cancel without silently presenting a fresh conversation; SDK RunState is independently validated.

6. **P2: Unify discoverable command metadata and behavioral tests.** Covers 01-F8. Documented plan commands are discoverable with aliases; actual ask-user hook mount/identity/abort/cleanup receives behavioral coverage instead of duplicated helper bodies.

7. **P2: Keep capability maturity grounded in backend evidence.** Rate game presets as prompt scaffolds until real detected build targets/job receipts and error/cancellation states are proven. Resolve snapshot/ACP/headless semantics with their owning shards before marking those flows usable; implementation-language expansion should follow measured subsystem needs.

**Inspection limits**

- Picker selected 18 distinct CLI files / 20 sections / 4,849 lines; every selected section was read. Adjacent evidence expands this receipt to 60 inventory files / 76 merged source sections / 13,848 inspected lines. This is selected-range inspection, not full coverage of all 685 CLI inventory files or every line of these files.
- Native query_index/read_files/read_subtree audit tools are repository code and unavailable in this session; actual source inspection used shell numbered exact reads and bounded rg discovery.
- Large chat.tsx, SDK event handlers, message persistence, provider and snapshot files were sampled at recorded ranges. Permission policy, credential stores, provider runtime, storage/crash recovery and snapshot restore semantics belong to other shards.
- Source files and repository configuration were not changed; credentials and private config values were not read. No external models/providers, live ACP sockets or real destructive git bisection were invoked. Artifacts and harmless probe fixtures were written only under the assigned /tmp evidence/findings paths.
- The safe probes use the existing legacy React hook-dispatcher/testing seam and injected SDK/provider results. They prove specific local branches, not full rendered-app/network behavior. Existing native UI tests were read, not executed as a complete suite.
- CLI transcript trimming is distinguished from model continuation. No model-context loss follows from the 100-ChatMessage cap alone.
- No full advisory database/lockfile/install graph or measured performance comparison was performed.
- Attach/detach and inference are opt-in backend choices. Module-only reattach ID and unknown passive stream resume are partial capability boundaries, not an allegation that ordinary in-process chat is broken.

Exact read ranges and the machine-readable structural receipt are in `01-cli.json`; all receipt files are members of the pinned inventory. The probe source and harmless fixtures are retained under `evidence/01-*` for reproducibility.

