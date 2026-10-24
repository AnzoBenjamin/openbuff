# Audit findings: cb-agents

- Subsystems: agents, scripts
- Features: handleSteps-serialization-and-inline-helper-codegen, specialist-risk-router, validation-command-inference, gate-file-classification, base2-gate-orchestration-state-machine, tool-tier-mode-gating, spawn-contract-derivation, guide-pointer-table, basher-deterministic-summary, tmux-cli-embedded-helper-script, browser-use-interaction-policy, librarian-clone-and-harvest, reviewer-family-output-contract, file-picker-post-processing, agent-definition-type-surface, pruner-budget-codegen, language-idioms
- Files covered: 25
- Snapshot: 49801b44e84d3d8fa583c3ebd9b2855228bf122572b7cdf5f78c77b3389d824d

## [HIGH] api-contract — scripts/generate-gate-helpers.ts:1 — handleSteps serialization + inline helper splicing: HYBRID (keep TS authoring, replace toString/new Function with bundled guest modules)
- **Risk:** handleSteps is serialized via toString() and rebuilt with new Function, losing module closure. Result: gate helpers are spliced into base2.ts (marker region at base2.ts:7802), gate-files helpers exist in FOUR copies (gate-files.ts header: base2, editor, tool-executor), editor re-declares its own isFileChangingTool/hasEditArtifact (editor.ts:944-1099), pruner budgets are codegen'd, and every agent inlines helpers (librarian harvest, file-picker). Parity is enforced only by freshness/parity tests. This mechanism is not portable to non-TS authors, not sandbox-friendly (new Function in host realm), and blocks third-party/marketplace agents from sharing libraries.
- **Fix:** Keep TS as the authoring language for first-party agents, but change the artifact: bundle each handleSteps entry with its imports (esbuild/Bun.build to a single ESM/IIFE string) at build time, or expose the pure gate/file helpers as a runtime-provided host module (ctx.lib.gate.*). For untrusted agents, run the same bundle in QuickJS (per D-context) with only yield-protocol I/O. Then delete generate-gate-helpers.ts, the marker region, and the parity tests. NOW: removes ~1.4k duplicated lines in base2 and the 4-copy drift. LATER: identical bundle format for QuickJS-sandboxed marketplace agents; any language compiling to JS/WASM can target the yield protocol.
- **Evidence:** scripts/generate-gate-helpers.ts:1-26 (rationale); agents/base2/base2.ts:7802 (<gate-helpers-generated> region through ~9325); agents/base2/gate-files.ts:1-27 (four copies incl. packages/agent-runtime tool-executor); agents/editor/editor.ts:944-1099; scripts/generate-pruner-budgets.ts:1-28. Cost: M (build step + runtime loader change + test migration, ~1-2 wk). Confidence: high on mechanism; medium that QuickJS can host the bundled generator protocol unchanged (needs verification of QuickJS generator/yield support and host-call bridging perf).

## [MEDIUM] correctness — agents/base2/base2.ts:862 — Specialist risk router: DECLARATIVE (rule registry data: path globs + requirement keywords → reviewer id)
- **Risk:** selectSpecialistReviewersInline is ~125 lines of hand-written regex policy duplicated from @codebuff/common/agents/specialist-risk-router (re-exported at specialist-risk-router.ts:1-4), only bypassed when params.orchestrationControlPlane injects a router. Policy lives in code twice, so tuning a keyword requires editing TS in two places, and third-party specialist reviewers cannot register their own triggers.
- **Fix:** Define a routing registry (JSON/YAML: {agentId, fileGlobs[], filenameStems[], requirementKeywords[], requiresUiFiles?, order}) owned by common; generate/load it in both the runtime router and the inline fallback (or pass it via params). Each specialist agent.yaml (P9-T1) can contribute its own trigger block. NOW: single source of truth, no drift. LATER: marketplace specialists self-register routing; routing decisions become replayable data in the D35 journal.
- **Evidence:** agents/base2/base2.ts:862-986 (inline regexes and fixed order list); agents/base2/specialist-risk-router.ts:1-4. Cost: S-M (3-5 days incl. regex→glob fidelity tests). Confidence: high; verify common router is byte-equivalent before consolidating.

## [MEDIUM] correctness — agents/base2/base2.ts:9694 — Validation command inference: DECLARATIVE (ecosystem/workspace registry, prefer get_build_targets)
- **Risk:** inferPackageTestCommand (base2.ts:9694) and inferValidationCommands (editor.ts:1308) are duplicated, diverge (editor lacks .pyi/java/kotlin/dotnet, has a 6-command cap), and hardcode this monorepo's layout (packages/*, agents/, common/src, cli/src → 'bun run typecheck && bun test') that is wrong for user projects that happen to have those paths. Ecosystem fallback maps (.py→pytest, .go→go test) are policy embedded in code rather than data.
- **Fix:** Move to a data registry: [{match: glob|ext, command, cwd}] with repo-local overrides loaded from project config (openbuff.json) and ecosystem defaults shipped as JSON. Prefer the existing programmatic get_build_targets/get_affected_tests results when available, falling back to the registry. NOW: one table, polyglot-extensible, no self-repo leakage into user repos. LATER: language packs add runners (rspec, phpunit, swift test, ctest) without TS edits.
- **Evidence:** agents/base2/base2.ts:9694-9722; agents/editor/editor.ts:1308-1350; get_build_targets listed in spawn-contract.ts BASE2_PROGRAMMATIC_TOOL_NAMES. Cost: S (2-3 days). Confidence: high.

## [MEDIUM] correctness — agents/base2/gate-paths.ts:74 — Gate file classification (reviewable/source/test/security-sensitive): DECLARATIVE (language registry)
- **Risk:** Extension lists are regexes scattered across isReviewableGateFile (gate-paths.ts:74-83), isNonTestSourceFile (base2.ts:9724-9738), isCoverageEvidenceFile (gate-paths.ts:101-105, TS/JS-only test patterns), matchesSecuritySensitiveGlob (base2.ts:9666). They omit languages the project explicitly supports via agents/idioms (ruby, php, swift, cpp, gdscript): .rb/.php/.swift/.c/.cpp/.h/.gd edits are NOT reviewable, so the reviewer gate silently skips them — a polyglot correctness gap. Test detection ignores test_*.py, *_test.go, *_spec.rb, etc.
- **Fix:** Create one language registry (JSON, likely co-located with idioms): {id, extensions[], testPatterns[], idiomsFile, testCommand}. Generate isReviewable/isTest/isSource predicates from it (codegen or runtime-provided lib per the serialization finding). NOW: closes the ruby/php/swift/cpp/gdscript review gap and unifies test detection. LATER: adding a language = adding one registry row + idioms md.
- **Evidence:** agents/base2/gate-paths.ts:74-83, 101-105; agents/base2/base2.ts:9666-9692, 9724-9738; agents/idioms/{ruby,php,swift,cpp,gdscript,kotlin,csharp}.md exist (glob). Cost: S (2-4 days). Confidence: high on the gap (regex read directly).

## [MEDIUM] state-mutation — agents/base2/base2.ts:243 — base2 gate orchestration (review/repair/aux-writer loop): HYBRID (explicit statechart data + TS guards/actions)
- **Risk:** createBase2 spans lines 243-12508 (~12k lines) with the gate lifecycle (pending files → validation hooks → reviewer → repair rounds → specialists → aux writers → finalization, bypass challenges, committed-surface receipts, owed reviewers) encoded as imperative generator control flow plus mutable Base2AgentState. States/transitions are implicit, making it hard to audit, visualize, test exhaustively, or replay deterministically (D35) and impossible for others to author variants without forking 12k lines.
- **Fix:** Extract the gate lifecycle into an explicit statechart (XState v5 machine config or SCXML-like JSON) whose states/events/transitions are data, with guards and actions remaining typed TS pure functions (the gate-*.ts modules). The handleSteps generator becomes a thin interpreter: each yield result is an event; state snapshots are journaled for D35 replay. Do NOT move guards to Starlark/Lua — they are dense string/regex logic best kept in TS. NOW: visualizable, exhaustively testable transitions; replay = re-feed journaled events. LATER: alternate gate policies (fast, plan-only, org-custom) as machine variants rather than boolean options; third-party orchestrators reuse guards.
- **Evidence:** agents/base2/base2.ts:243-266 (createBase2 options), 999-1027 (Base2AgentState), 7008-7438 (gate progress/state block/telemetry), 9328-10450 (receipts, bypass, aux targets), outline end 12508. Cost: L (3-6 wk, high regression risk; do incrementally per sub-loop). Confidence: medium — did not read full handleSteps body; XState serializable-snapshot/replay behavior needs web verification.

## [LOW] api-contract — agents/base2/tool-tiers.ts:40 — Tool tier / mode gating: KEEP
- **Risk:** Already a data table (MODE_NEUTRAL_TOOL_NAMES / MODE_GATED_TOOL_NAMES) with fail-closed default and exhaustiveness test; tier membership owned by agent-runtime. The only code-shaped policy is the 6-case modeAllowsTool switch.
- **Fix:** Keep in TS. Optionally express the mode-gated cases as a small table {tool: {deniedWhen: ['planOnly', ...]}} when agent.yaml lands so declarative agents can declare mode gates the same way.
- **Evidence:** agents/base2/tool-tiers.ts:40-135, 153-190. Cost: XS. Confidence: high.

## [LOW] api-contract — agents/base2/spawn-contract.ts:159 — Spawn contract clauses: KEEP (retire legacy prose when agent.yaml lands)
- **Risk:** Already derives clauses from inputSchema; residual SPAWN_CONTRACT_CLAUSES legacy prose and hand-maintained SPAWN_CONTRACT_DELEGATED_PARAMS / architect family id list are policy-in-prose kept for byte-compat.
- **Fix:** Keep. When agents become agent.yaml, derive family grouping from a `family:` field and drop legacyText byte-compat. Unlocks roster-wide contract generation for third-party agents.
- **Evidence:** agents/base2/spawn-contract.ts:88-111 (derivation), 159-213 (legacy clauses), 222-227 (delegated). Cost: S. Confidence: high.

## [LOW] api-contract — agents/base2/base2.ts:137 — Guide pointer / progressive disclosure table: KEEP
- **Risk:** Already a typed registry keyed by GuidePath with compile-time one-row-per-guide; bodies are TS string constants.
- **Fix:** Keep. Optionally move section bodies to .md guide files (they already exist as the disclosure targets) and inline them at build time so prose isn't authored in TS template strings.
- **Evidence:** agents/base2/base2.ts:106-229. Cost: XS-S. Confidence: high.

## [LOW] correctness — agents/basher.ts:95 — Basher command wrapper + deterministic summary: KEEP
- **Risk:** Deterministic handleSteps (timeout clamps, pipefail/tee log wrapper, keyword line extraction) is appropriate TS; shell script built by string join is small and quoted. Metadata/inputSchema portion is declarative-ready.
- **Fix:** Keep handleSteps in TS; move metadata+schema+prompts to agent.yaml under P9-T1. Consider promoting the log-extraction wrapper to a runtime run_terminal_command option so it is replay-journaled as one tool call.
- **Evidence:** agents/basher.ts:9-93 (metadata/schema), 95-353 (handleSteps). Cost: XS. Confidence: high.

## [LOW] correctness — agents/tmux-cli.ts:290 — tmux helper script embedded as TS template string: MOVE→bash asset file
- **Risk:** A ~150-line bash helper lives inside a JS template literal with double escaping (\${SEQ_PAD}, $'\\x1b[200~', perl regex escapes), written to /tmp via heredoc each run and echoed into the prompt. Escaping bugs are invisible to shellcheck and to bash authors.
- **Fix:** Ship tmux-helper.sh as a real asset (shellcheck-able, testable with bats), and have the runtime materialize agent assets (agent.yaml `assets:`) or pass its content via config. handleSteps stays TS. NOW: shellcheck/bats coverage, no escaping. LATER: general agent-asset mechanism for marketplace agents.
- **Evidence:** agents/tmux-cli.ts handleSteps helperScript const (start of handleSteps, after instructionsPrompt) and setupScript heredoc; comment 'Must be defined inside handleSteps because the function is serialized'. Cost: S. Confidence: high.

## [MEDIUM] api-contract — agents/browser-use/browser-use.ts:45 — browser-use agent + interactionPolicy: DECLARATIVE (agent.yaml + runtime-enforced action allowlist)
- **Risk:** Agent has no handleSteps — pure metadata + prose, ideal for agent.yaml. But the read-only interactionPolicy is enforced only by prompt text (systemPrompt guardrails and instructionsPrompt); nothing stops the model from calling browser_logs click/type/evaluate under read-only. Policy that should be data is embedded in prose.
- **Fix:** Convert to agent.yaml with prompts in .md. Express interactionPolicy as data mapping to allowed browser_logs action types ({read-only: [navigate, snapshot, screenshot, ...]}) enforced by the runtime tool layer, the same way terminalPermissionProfile is enforced. NOW: real enforcement, first declarative agent pilot for P9-T1. LATER: marketplace agents declare tool-action allowlists.
- **Evidence:** agents/browser-use/browser-use.ts:45-52 (interactionPolicy param), 171 (prose guard), 239 (instructions restate). Cost: S (yaml) + S-M (runtime action allowlist). Confidence: high that enforcement is prompt-only in this file; runtime enforcement elsewhere not verified.

## [LOW] state-mutation — agents/librarian/librarian.ts:107 — Librarian clone + output-harvest fallback: HYBRID (keep clone logic in TS, move harvest to runtime)
- **Risk:** URL allowlist and clone are correct TS. The ~150-line harvestedAnswerText / retry / terminal-harvest block is generic (comments cite general-agent.ts precedent), duplicated per agent because of serialization, and re-implements runtime message-turn semantics (getLastAssistantTurnMessages).
- **Fix:** Provide a runtime-level 'guaranteed structured output' policy (agent.yaml `outputFallback: {retries: 1, harvest: lastAssistantTurn}`) and delete per-agent copies. Clone cleanup is already runtime-owned. NOW: removes duplication; LATER: every declarative agent gets the guarantee for free.
- **Evidence:** agents/librarian/librarian.ts:107-146 (validation/clone), 219-411 (harvest + retry loop). Cost: S. Confidence: high.

## [MEDIUM] api-contract — agents/reviewer/code-reviewer.ts:39 — Reviewer-family output contract & verdict rules: DECLARATIVE (shared JSON Schema + generated prompt contract)
- **Risk:** code-reviewer and security-reviewer declare divergent inline output schemas (string|object findings vs required-object findings; advisories only on code-reviewer) and restate gate semantics in prose (LOOKS_GOOD-only finalization, 'block' prefix on dimensions, BLOCKING on missing requirementCoverage), which gate-reviewer.ts parses independently. Contract lives three times: schema, prose, parser.
- **Fix:** Define one versioned reviewer-family JSON Schema (e.g. reviewer-receipt.v1.json) in common; agents reference it, gate-reviewer validates against it, and the 'Output contract' prompt section is generated from it. Replace the 'first word must be block' prose convention with a structured dimension status enum. NOW: eliminates schema/prose/parser drift. LATER: third-party reviewers conform by referencing the schema id; receipts are replay-verifiable.
- **Evidence:** agents/reviewer/code-reviewer.ts:39-162 (schema), 164-258 (prose contract incl. dimension prefix rule); agents/security-reviewer/security-reviewer.ts:36-60 (divergent schema); agents/base2/gate-reviewer.ts:561-925 (collectReviewerBlockers/verdict resolution). Cost: M (1 wk). Confidence: high.

## [LOW] correctness — agents/file-explorer/file-picker.ts:81 — file-picker post-processing: KEEP
- **Risk:** Small deterministic TS (path parsing, containment, keyword scoring) is a good fit. Duplicated path-containment logic mirrors normalizeGateFilePath due to serialization.
- **Fix:** Keep; dedupe containment via the runtime-provided lib once the serialization finding is addressed. Metadata/schema to agent.yaml.
- **Evidence:** agents/file-explorer/file-picker.ts:81-367. Cost: XS. Confidence: high.

## [LOW] api-contract — agents/types/agent-definition.ts:21 — AgentDefinition type surface: HYBRID (generate JSON Schema for agent.yaml from a single source)
- **Risk:** The public agent contract exists only as TS interfaces; a declarative agent.yaml (P9-T1) or non-TS authors need a JSON Schema. The ModelName union is a stale hardcoded list despite docs saying model is routing-controlled and vestigial.
- **Fix:** Make a zod/JSON Schema the single source (or generate JSON Schema from these types via ts-json-schema-generator) and publish it for agent.yaml validation/IDE completion; keep TS types generated from it. Replace the ModelName literal union with string + routes registry lookup.
- **Evidence:** agents/types/agent-definition.ts:21-320 (AgentDefinition), 34-41 (model vestigial), 425-501 (ModelName list). Cost: S. Confidence: high.

## [LOW] correctness — scripts/generate-pruner-budgets.ts:56 — Pruner budget codegen: DECLARATIVE (budgets JSON consumed by runtime and pruner)
- **Risk:** AST-scraping numeric literals from a TS module and splicing them into another TS file is heavyweight for 15 constants; exists only because of handleSteps serialization.
- **Fix:** Store budgets in a JSON file imported by context-pruning.ts and injected into the pruner via config/params (or resolved by the bundler). Delete the generator and freshness test.
- **Evidence:** scripts/generate-pruner-budgets.ts:1-28, 56-72, 196-221. Cost: XS-S. Confidence: high.

## [LOW] api-contract — agents/idioms/python.md:1 — Language idioms: KEEP (Markdown)
- **Risk:** Markdown is the right format for model-facing guidance; only gap is no machine-readable link to the language registry.
- **Fix:** Keep; reference each idioms file from the proposed language registry row so classification, test commands, and idioms stay in lockstep.
- **Evidence:** agents/idioms/python.md:1-8; agents/idioms/*.md (12 languages via glob). Cost: XS. Confidence: high.

## Coverage receipt

### Subsystems
- agents
- scripts

### Features
- handleSteps-serialization-and-inline-helper-codegen
- specialist-risk-router
- validation-command-inference
- gate-file-classification
- base2-gate-orchestration-state-machine
- tool-tier-mode-gating
- spawn-contract-derivation
- guide-pointer-table
- basher-deterministic-summary
- tmux-cli-embedded-helper-script
- browser-use-interaction-policy
- librarian-clone-and-harvest
- reviewer-family-output-contract
- file-picker-post-processing
- agent-definition-type-surface
- pruner-budget-codegen
- language-idioms

### Files
- agents/base2/base2.ts
- agents/base2/gate-paths.ts
- agents/base2/gate-reviewer.ts
- agents/base2/gate-repair.ts
- agents/base2/gate-concurrency.ts
- agents/base2/gate-fingerprint.ts
- agents/base2/gate-committed-surface.ts
- agents/base2/gate-files.ts
- agents/base2/spawn-contract.ts
- agents/base2/specialist-risk-router.ts
- agents/base2/tool-tiers.ts
- agents/editor/editor.ts
- agents/editor/repair-editor.ts
- agents/reviewer/code-reviewer.ts
- agents/security-reviewer/security-reviewer.ts
- agents/file-explorer/file-picker.ts
- agents/basher.ts
- agents/tmux-cli.ts
- agents/browser-use/browser-use.ts
- agents/librarian/librarian.ts
- agents/types/agent-definition.ts
- agents/package.json
- scripts/generate-gate-helpers.ts
- scripts/generate-pruner-budgets.ts
- agents/idioms/python.md

### Domains
- correctness
- api-contract
- state-mutation
