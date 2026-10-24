# Audit findings: shard-agents

- Subsystems: agents.tmux-cli, agents.basher, agents.librarian, agents.editor, agents.base2-gate, agents.context-pruner, agents.specialists, agents.researchers, agents.browser-use, agents.thinker, agents.patterns
- Features: agents.tmux-cli.shell-glue, agents.tmux-cli.tmp-state, agents.tmux-cli.plan-alignment, agents.basher.shell-glue, agents.librarian.clone-glue, agents.editor.wire-format-prompt, agents.base2.spawn-contract-prompt, agents.base2.serialized-handlesteps, agents.base2.gate-machinery, agents.thinker.harvest-duplication, agents.context-pruner.roster-coupling, agents.create-specialist.declarative-precursor, agents.researchers.ts-prompts-fit, agents.browser-use.ts-prompts-fit, agents.patterns-index.prompt-medium, P5-T4, P9-T1, P9-T2, P9-T4, P1-T1, P5-T3
- Files covered: 24
- Snapshot: 4fc76b0bd48a0b11d651b8f4647bb302dc95344c8b5749411ed1f5fcc3e7a0ba

## [MEDIUM] correctness — agents/tmux-cli.ts:424 — tmux-cli embeds a ~190-line bash PTY-shim helper script as an inline template string
- **Risk:** The tmux-cli agent embeds a ~190-line bash helper (send/capture/wait-idle/status/stop) as a TS template string, written to /tmp via heredoc at spawn time. Interactive TUI driving is faked through tmux send-keys plus bash polling loops (sleep 0.25 re-capture cycles, 120s caps), ANSI stripping via a perl one-liner, and prompt-injection defense via a hand-rolled fence wrapper (wrapUntrustedCapture). Every timing, ANSI, and quoting edge case lives in generated bash text the LLM must operate correctly; helper-script failures are a first-class output field (scriptIssues) because they are expected to break.
- **Fix:** After P5-T4 lands, replace the helper-script workflow with terminal_session tool calls (open/sid/read/idle/key/stop) and rewrite the agent's systemPrompt/instructionsPrompt tool reference accordingly; keep tmux-cli as the smoke harness only where terminal_session is unavailable (graceful-degradation tier reporting per SPEC principle 6).
- **Evidence:** agents/tmux-cli.ts:424-610 helperScript bash template (send/capture/wait-idle/status/stop); agents/tmux-cli.ts:540-560 bash sleep 0.25 polling loop; agents/tmux-cli.ts:595 perl ANSI strip; agents/tmux-cli.ts:630-649 wrapUntrustedCapture; agents/tmux-cli.ts:712-760 heredoc setup script. SPEC.md R-D lists 'PTY host with terminal_session' (P5-T4); SPEC acceptance keeps tmux-cli as TUI smoke vehicle.

## [MEDIUM] state-mutation — agents/tmux-cli.ts:715 — tmux-cli hand-manages /tmp lifecycle: capture dirs, 24h rm -rf sweep, helper script, teardown in generator finally
- **Risk:** Setup writes the helper to /tmp/tmux-helper-<uuid>.sh, creates /tmp/tmux-captures-<session>/ with a .seq counter file, and sweeps tmux-captures-* older than 24h via find -maxdepth 1 -exec rm -rf. Teardown runs in a generator finally block via one more shell command. This is hand-rolled temp-state lifecycle (sweep, counter validation against bash arithmetic injection, best-effort rm) duplicated outside the runtime's own job/orchestration state machinery, and it only works while the agent's shell can write /tmp — it silently degrades under a sandboxed workspace.
- **Fix:** Plan gap: P5-T4's task description should explicitly name tmux-cli.ts as the first consumer of terminal_session and budget a prompt+helper rewrite; runtime-owned capture artifacts (run journal, R-B) should replace /tmp capture dirs so evidence survives in the journal rather than a swept temp namespace.
- **Evidence:** agents/tmux-cli.ts:715-724 setup sweep script; agents/tmux-cli.ts:726-760 heredoc write + chmod; agents/tmux-cli.ts:566-580 .seq counter validation inside bash; agents/tmux-cli.ts:762-774 finally teardown. Unresolved plan gap: no PLAN task maps tmux-cli helper retirement to P5-T4.

## [MEDIUM] correctness — agents/basher.ts:213 — basher generates POSIX-bash glue (pipefail/tee/PIPESTATUS/grep/head) in TS to fake log capture
- **Risk:** When save_full_log is set, handleSteps assembles a multi-line bash pipeline: 'set -o pipefail', '(cmd) 2>&1 | tee <quoted /tmp path> >/dev/null', PIPESTATUS capture, grep -n -E failure extraction piped to head -N, rm -f cleanup, exit "$status". The shellQuote helper implements POSIX single-quote escaping only. This breaks on non-bash /bin/sh, Windows, and any environment where the terminal tool's shell differs; the failure-extraction policy (grep pattern, head cap) is reimplemented in shell text instead of living beside the structured fields the runtime already returns.
- **Fix:** Move save_full_log/retention/failure-extraction into the terminal tool or jobd sidecar as structured options (log artifact id, exit code, bounded failure lines), leaving basher's handleSteps as pure param validation and output shaping; the TS prompt glue then shrinks to prompt text, matching the P9-T1/T2 direction.
- **Evidence:** agents/basher.ts:213-216 fullLogPath construction; agents/basher.ts:222-236 shellQuote + commandToRun assembly (set -o pipefail, PIPESTATUS, tee, grep -n -E, head, rm -f); agents/basher.ts:238-253 run_terminal_command yield. SPEC R-B jobd (P5-T3) and R-D PTY host are the native homes for this.

## [MEDIUM] security — agents/librarian/librarian.ts:206 — librarian requires shell-only repo exploration because /tmp is outside tool scope; timestamped clone dir
- **Risk:** The librarian clones GitHub repos into /tmp/librarian-<name>-<Date.now()> via a shell command built with a POSIX-only shellQuote and a hand-written URL allowlist regex, then instructs the model to explore exclusively with cat/grep/find/tree through run_terminal_command because read_files/list_directory/glob/code_search 'cannot access /tmp paths'. Shell-driven exploration of untrusted cloned code is strictly weaker than the audited read tools (no structured caps, no binary handling), and the Date.now() directory name is far lower-entropy than basher's crypto.randomUUID rationale for the same /tmp-symlink threat.
- **Fix:** Either (a) let the runtime own cloning into a tracked sandbox workspace so normal read tools apply (protocol-first), or (b) as an interim, give the librarian a scoped read profile over the clone dir; in both cases derive the clone dir name from crypto.randomUUID() to match basher's entropy rationale, and drop the shell-exploration mandate once tools can reach the clone.
- **Evidence:** agents/librarian/librarian.ts:206-212 GITHUB_URL_RE allowlist; agents/librarian/librarian.ts:214-220 shellQuote; agents/librarian/librarian.ts:264-286 clone + timestamped dir; agents/librarian/librarian.ts:327-338 add_message forbidding read_files/glob/code_search on /tmp. SPEC R-B 'single shared workspace' ceiling is the driver.

## [MEDIUM] api-contract — agents/editor/editor.ts:180 — editor.ts instructionsPrompt hardcodes the raw transport wire shape (<codebuff_tool_call>/cb_tool_name)
- **Risk:** The editor's ~1300-line instructionsPrompt ends with a literal wire-format example: '<codebuff_tool_call> { "cb_tool_name": "edit_transaction", ... }'. Under the ACP v1 protocol split (P1-T1) tool invocation no longer travels as in-band codebuff markers; this prompt section is a second, hand-maintained copy of the transport encoding that will silently teach a stale format after the switch. The same prompt also restates the entire edit_transaction contract (edit modes, cap.v3/basedOnRead rules, recovery packets) that the runtime already enforces.
- **Fix:** Replace the hand-written wire example with a generated, schema-derived tool-descriptor section (the three-mirror codegen the SPEC already mandates for tool schemas) so the prompt re-renders automatically when the tool schema or transport changes; keep the prose guidance about edit strategy.
- **Evidence:** agents/editor/editor.ts:144-178 instruction prose; agents/editor/editor.ts:180-200 literal <codebuff_tool_call> / cb_tool_name / edits[] example; agents/editor/editor.ts:39-51 createCodeEditor model/maxOutputTokens. SPEC R-F 'JSON Schema tool descriptors' and principle 1 (schema generated from Zod) are the fix.

## [HIGH] api-contract — agents/base2/base2.ts:580 — base2 systemPrompt encodes the whole spawn/tool contract as prose; tool and roster lists hardcoded
- **Risk:** The base2 systemPrompt (line ~580) restates exact per-agent spawn contracts as prose: basher needs params.command, general-agent needs filePaths/directoryPaths, reviewer-family manual spawns omit params.snapshot_id, the exact spawn_agents JSON shape, plus a full inline catalogue of tool names and edit-mode semantics. toolNames/programmaticToolNames (spawn_agent_inline, git_status, run_file_change_hooks, get_change_review_bundle, ...) and the ~40-entry spawnableAgents roster are hardcoded arrays with mode-gated boolean expressions. A large family of parity/drift tests (roster-drift, gate-*-parity, review-rubric-parity, specialist-router-parity) exists precisely because this prompt-encoded contract drifts from the runtime; under ACP namespacing these names become wire-visible and every rename forces prompt edits.
- **Fix:** Emit the spawn-contract paragraph and tool-name lists from the same Zod/JSON-Schema descriptors as the runtime (R-F), parameterized per mode; the roster lists become data (agent.yaml candidates). Keep only behavioral prose hand-written.
- **Evidence:** agents/base2/base2.ts:580 spawn-contract paragraph; agents/base2/base2.ts:459-468 programmaticToolNames; agents/base2/base2.ts:504-545 spawnableAgents roster; agents/base2/tool-tiers.ts MODE_*_TOOL_NAMES; drift guards in agents/__tests__/{roster-drift,review-rubric-parity,specialist-router-parity,gate-*-parity}.test.ts.

## [HIGH] test-coverage — agents/base2/gate-paths.ts:1 — handleSteps toString/new Function serialization forces duplicated inline gate helpers and blocks module reuse
- **Risk:** handleSteps generators are serialized via handleSteps.toString() and reconstructed with new Function(...), so they lose module closure: every helper they use must be duplicated inline. gate-paths.ts and gate-reviewer.ts headers explicitly document 'keep the two implementations in sync' with a codegen script and freshness checks; context-pruner, thinker, librarian, and researcher-web each carry the same 'must be inside handleSteps since it is serialized' constraint, forcing ~3000-line inline generator bodies (context-pruner.ts is 3166 lines) and an entire test suite of inline-extraction parity checks.
- **Fix:** P9-T4's QuickJS handleSteps removes the need for .toString() round-tripping: helpers can be closed over normally or the generator body shipped as an isolated source artifact with a real module scope, deleting the generated inline region and its freshness/parity test family. This is the single highest-leverage language-adjacent change in the subsystem.
- **Evidence:** agents/base2/gate-paths.ts:1-10 sync note; agents/base2/gate-reviewer.ts:1-15 regeneration note; agents/context-pruner.ts:74-77 'must be inside handleSteps'; agents/thinker/thinker.ts:105-107 and agents/librarian/librarian.ts:312-315 and agents/researcher/researcher-web.ts:106-107 same serialization comments; agents/__tests__/gate-helpers-freshness.test.ts and scripts/generate-gate-helpers.ts.

## [MEDIUM] correctness — agents/thinker/thinker.ts:100 — thinker and librarian reimplement runtime harvest/step semantics inside their generators
- **Risk:** thinker.ts and librarian.ts each reimplement runtime harvest behavior inside their serialized generators: think-tag stripping regexes (<think>...</think> plus unclosed tail), trailing-assistant-turn harvesting, set_output payload extraction from tool-call parts, and set_output validation-error recovery. Any change to message part shapes, tag names, or set_output semantics under the protocol split must be replicated in every such generator or harvest silently degrades — exactly the drift class the parity tests elsewhere in the repo guard against.
- **Fix:** Move think-tag stripping, set_output-payload recovery, and set_output validation-error surfacing into the runtime step lifecycle (a harvest hook all agents share), leaving agent generators only agent-specific shaping; under P9-T4 the QuickJS sandbox should expose this as a runtime-provided API, not per-agent reimplementation.
- **Evidence:** agents/thinker/thinker.ts:100-118 cleanedTextFromContent think-tag stripping; agents/thinker/thinker.ts:150-255 set_output payload harvest loop; agents/librarian/librarian.ts:316-424 harvestedAnswerText/hasSuccessfulOutput/lastSetOutputErrorText/agentHarvestedFallback; compare agents/base2/base2.ts:10422-10512 extractGateStateBlocksFromMessage/collectMessageText.

## [MEDIUM] api-contract — agents/context-pruner.ts:80 — context-pruner hardcodes agent-ID blacklists and reviewer types; 3.1k-line serialized summarization kernel
- **Risk:** The pruner's serialized handleSteps hardcodes SPAWN_AGENTS_OUTPUT_BLACKLIST ('file-picker', 'code-reviewer', 'security-reviewer') and REVIEWER_AGENT_TYPES as string arrays, so adding a reviewer-family agent (the specialist factory already produces many) requires editing the pruner or losing correct summarization. The whole 3166-line summarization/knowledge-memory pipeline also lives inline in one generator purely because of the serialization constraint, making it the least maintainable hot spot in agents/.
- **Fix:** Derive reviewer/discovery agent classifications from agent metadata (a declared role/family field — already present in specialist outputSchema 'family') instead of ID string lists, and extract the pure pruning/summarization functions out of the serialized generator into a normal module (possible once P9-T4 removes the toString constraint).
- **Evidence:** agents/context-pruner.ts:80-85 hardcoded agent ID lists; agents/context-pruner.ts:74-90 serialized-generator constants; outline shows definition spanning lines 13-3166; e2e coverage in agents/e2e/context-pruner*.e2e.test.ts.

## [LOW] api-contract — agents/specialists/create-specialist.ts:47 — create-specialist is a config-driven factory — a direct precursor to declarative agent.yaml
- **Risk:** createSpecialist(config) builds each specialist purely from a data object (id, displayName, purpose, focus[], terminal/advisory/intelligence flags) plus generated schemas and prompts. This is already a declarative DSL expressed in TS: mapping it to agent.yaml is mechanical, and it would let non-TS users author and ship specialist reviewers (and later hook them to Python/Rust/Go validation via P9-T2 hooks-in-any-language) without touching the bundle.
- **Fix:** Extend agent.yaml (P9-T1) with the SpecialistConfig vocabulary (purpose, focus, dimensions, bounded schemas, intelligence tool flags) and generate these definitions; add-an-agent.md and the INDEX row then describe authoring YAML rather than TS.
- **Evidence:** agents/specialists/create-specialist.ts:12-45 SpecialistConfig; agents/specialists/create-specialist.ts:47-255 factory; agents/specialists/*.ts all call createSpecialist; SPEC.md R-F 'Declarative agent.yaml'; agents/patterns/add-an-agent.md documents the manual TS path.

## [LOW] api-contract — agents/researcher/researcher-web.ts:112 — researcher-web prompt-decomposition and basher output-summarization are pure functions ideal for QuickJS-isolated handleSteps
- **Risk:** The decomposition heuristics (stripMetaInstructions, extractTopics, four split strategies, MAX_SUBQUERIES) and basher's stopword/semantic/pathRegex line filtering are pure string-processing kernels trapped in serialized TS generators. Under P9-T4 (QuickJS-isolated handleSteps) these become isolated, testable scripts; the same contract could later be satisfied by a WASM plugin, and hook-style pre/post steps in any language can replace ad-hoc shell preambles for search/summarization pipelines.
- **Fix:** Under P9-T4, keep these as sandboxed scripts (language-agnostic: TS today, WASM component plugins later per R-F); have P9-T2 hooks return structured JSON-RPC results so base2's summarizeHookResults stops parsing stdout text. This is where non-TS authors gain the most: the same hook contract can carry a Python or Go implementation.
- **Evidence:** agents/researcher/researcher-web.ts:112-213 TS heuristics; agents/researcher/researcher-web.ts:240-261 seeding; agents/basher.ts:236-350 stopword/regex summarization; SPEC.md R-F 'QuickJS isolate for string handleSteps'; P9-T2 hooks-in-any-language for structured hook results.

## [MEDIUM] state-mutation — agents/base2/base2.ts:11793 — base2 gate machinery parses receipts and gate markers out of tool-result strings and builtin FS
- **Risk:** The gate machinery (12.6k-line createBase2) reads gate file markers through a builtin-FS shim (readGateMarkerBuiltinFs), parses git-status lines, terminal stdout, hook failure summaries, and reviewer receipts out of message text, and hashes snapshot details for fingerprints. This is runtime-state reconstruction from stringified artifacts — the exact boundary the protocol-first split (R-B run journal, persisted workflow statechart, message-passing subagents) is meant to replace. It must remain TS (it is openbuff-core-adjacent logic and the SPEC locks the agent loop in TS), so the opportunity is contract cleanup, not a rewrite.
- **Fix:** Plan gap: P9-T2 should specify structured hook results (JSON-RPC over stdio per SPEC integration mechanism (b)) so collectHookFailures parses receipts instead of text; P5-T4 terminal_session should return structured stdout blocks so extractTerminalStdout is retired. Gate state itself belongs in the run journal/statechart (R-B), not parsed from message text.
- **Evidence:** agents/base2/base2.ts:11793-12075 readGateMarker*; agents/base2/base2.ts:12298-12359 collectHookFailures/summarizeHookResults/extractHookResults; gate-fingerprint.ts:1-20; SPEC.md R-B 'run journal', 'persisted workflow statechart'; SPEC.md locked non-goal 'replacing agents/ templates'.

## [LOW] correctness — agents/browser-use/browser-use.ts:105 — Pure-prompt agents (browser-use, researcher-docs, patterns) are the confirmed TS-prompts-are-right surface
- **Risk:** browser-use, researcher-docs, researcher-web (post-bootstrap), and the pattern guides are prompt+schema definitions with no shell glue, no serialization workarounds, and no transport assumptions beyond declared toolNames. The TS template-literal medium is clearly right for them: multiline prompt prose with interpolation is a strength, the SPEC explicitly locks 'replacing agents/ templates' as a non-goal, and rewriting them in any other language would add a build step without capability gain. Residual protocol risk is limited to the hardcoded toolNames arrays, which the declarative descriptor work covers.
- **Fix:** Keep these as authored TS prompts (per the locked non-goal), but factor the tool-name/contract sections into generated descriptors so they survive the protocol split; convert only the pure-config definitions (researcher-docs, browser-use, specialists) to agent.yaml, keeping their markdown prose as data.
- **Evidence:** agents/browser-use/browser-use.ts:105-113 toolNames; agents/browser-use/browser-use.ts:115-283 prompts; agents/researcher/researcher-docs.ts:22-42; agents/editor/editor.ts:180-200; agents/base2/base2.ts:580; SPEC.md non-goals 'replacing agents/ templates'; SPEC.md R-F declarative surface.

## [MEDIUM] api-contract — agents/tmux-cli.ts:124 — Agent spawn surfaces (toolNames, terminalPermissionProfile, spawnableAgents) are name-string coupled to the runtime
- **Risk:** Every audited agent declares toolNames/terminalPermissionProfile as string arrays (tmux-cli: run_terminal_command/read_files/set_output/add_message with profile 'tmux-test'; editor: read_files/read_outline/edit_transaction; specialists: a composed list including get_change_review_bundle and inspect_environment). Under ACP v1 with namespaced Openbuff extensions these strings become protocol-level identifiers; a rename or namespace addition currently requires touching every definition plus the base2 prompt prose that repeats them.
- **Fix:** Generate toolNames/programmaticToolNames and profile bindings from the versioned tool-schema descriptors (R-F) so the ACP namespacing renames once, in the descriptor source; agent definitions reference symbolic tool ids.
- **Evidence:** agents/tmux-cli.ts:124-135 toolNames; agents/tmux-cli.ts:141-143 terminalPermissionProfile 'tmux-test'; agents/base2/base2.ts:504-545 mode-gated roster; agents/editor/editor.ts:138 toolNames; agents/specialists/create-specialist.ts:168-195 conditional toolNames; SPEC.md R-F JSON Schema tool descriptors.

## Coverage receipt

### Subsystems
- agents.tmux-cli
- agents.basher
- agents.librarian
- agents.editor
- agents.base2-gate
- agents.context-pruner
- agents.specialists
- agents.researchers
- agents.browser-use
- agents.thinker
- agents.patterns

### Features
- agents.tmux-cli.shell-glue
- agents.tmux-cli.tmp-state
- agents.tmux-cli.plan-alignment
- agents.basher.shell-glue
- agents.librarian.clone-glue
- agents.editor.wire-format-prompt
- agents.base2.spawn-contract-prompt
- agents.base2.serialized-handlesteps
- agents.base2.gate-machinery
- agents.thinker.harvest-duplication
- agents.context-pruner.roster-coupling
- agents.create-specialist.declarative-precursor
- agents.researchers.ts-prompts-fit
- agents.browser-use.ts-prompts-fit
- agents.patterns-index.prompt-medium
- P5-T4
- P9-T1
- P9-T2
- P9-T4
- P1-T1
- P5-T3

### Files
- agents/tmux-cli.ts
- agents/basher.ts
- agents/librarian/librarian.ts
- agents/editor/editor.ts
- agents/editor/repair-editor.ts
- agents/base2/base2.ts
- agents/base2/base2-plan.ts
- agents/base2/base2-execute-plan.ts
- agents/base2/gate-paths.ts
- agents/base2/gate-reviewer.ts
- agents/base2/gate-fingerprint.ts
- agents/base2/gate-files.ts
- agents/base2/gate-repair.ts
- agents/base2/gate-committed-surface.ts
- agents/base2/gate-concurrency.ts
- agents/base2/tool-tiers.ts
- agents/context-pruner.ts
- agents/browser-use/browser-use.ts
- agents/researcher/researcher-web.ts
- agents/researcher/researcher-docs.ts
- agents/specialists/create-specialist.ts
- agents/thinker/thinker.ts
- agents/patterns/INDEX.md
- .agents/sessions/polyglot-roadmap-v2/SPEC.md

### Domains
- correctness
- api-contract
- state-mutation
- error-handling
- test-coverage
- security
