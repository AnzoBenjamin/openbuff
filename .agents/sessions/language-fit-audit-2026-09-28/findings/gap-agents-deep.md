# Audit findings: gap-agents-deep

- Subsystems: agents, .agents
- Features: base2-gate-state-machine, base2-file-classification, base2-command-inference, base2-prompt-assembly, base2-reviewer-routing, base2-repair-loops, base2-handoff-building, base2-todo-plan-tracking, base2-fingerprint-markers, base2-generated-helper-region, base2-state-hydration, base2-telemetry-gate-state-block, reviewer-verdict-parsing, leaf-agent-definitions, cli-tmux-agents, specialist-factory, dependency-command-registry, git-delivery
- Files covered: 25
- Snapshot: 49801b44e84d3d8fa583c3ebd9b2855228bf122572b7cdf5f78c77b3389d824d

## [HIGH] state-mutation — agents/base2/base2.ts:1729 — Gate state machine is an implicit ~5,300-line generator loop; should be a statechart hosted outside the serialized generator (HYBRID)
- **Risk:** Current mechanism: one `while(true)` in handleSteps (1729-7007) mutates `activeWorkState.currentPhase` directly across idle/awaiting_validation/awaiting_review/repair_loop/blocked/final_response_allowed in ~100 sites, with ~60 `continue`/`break` exits that encode transitions implicitly. A runtime-side workflow already exists (`controlPlane.transitionBase2Gate` / `workflowStates['base2-gate-v1']`, emitGateTelemetry 7373+), but it is only fed from telemetry and its illegal-transition throw is swallowed ('Leave the previous workflow state in place'), so the authoritative phase and the checked workflow can silently diverge. Needs: explicit states/events, guard auditability, resumability across turns without a live VM snapshot (quickjs has none; state is rebuilt from base2ActiveWork each turn).
- **Fix:** Verdict HYBRID → STATECHART. Model phases + aux sub-gates (test/doc/security/specialist/final reviewer/committed-surface) as an XState v5 machine whose context IS base2ActiveWork; keep side-effect yields (spawn/hooks/git_status) as actor invocations driven by a thin handleSteps shim. Make transitionBase2Gate authoritative (fail closed on illegal transition instead of swallowing). Unlocks NOW: machine-checked transition table, visualizable gate, test by event sequences instead of 60 e2e drive helpers. NEXT: port the same machine definition (JSON) to a Rust daemon interpreter (statig/rust-fsm) so gate runs host-side for any language agent. Cost: large (≈5k lines re-expressed, heavy e2e suite in agents/__tests__/base2.test.ts must be re-pinned). Confidence: medium-high.
- **Evidence:** base2.ts:1729 `while (true) {`; phase writes e.g. 2159 'blocked', 2248 'awaiting_validation', 3211 'repair_loop', 6631 gate-pass sets 'final_response_allowed'; emitGateTelemetry 7373-7440 inner try/catch 'base2GateWorkflowV1 THROWS on an illegal transition ... must not suppress telemetry'; inferActiveWorkPhase ~7441.

## [HIGH] api-contract — agents/base2/base2.ts:7802 — toString()/new Function serialization forces ~1,525-line generated helper region plus hand-mirrored inline copies (MOVE gate engine host-side)
- **Risk:** Current mechanism: every helper handleSteps needs must be inlined because the generator loses module closure. Result: `<gate-helpers-generated>` 7802-9326 duplicates gate-paths/gate-reviewer/gate-repair/gate-concurrency/gate-fingerprint/gate-committed-surface; plus hand-kept mirrors guarded only by parity tests (selectSpecialistReviewersInline vs common specialist-risk-router, SECURITY_SENSITIVE_GLOBS vs quality-prompt-section, hasEditArtifact 'Trimmed inline gate check' vs gate-files.ts, audit receipt detector in general-agent vs common/src/util/audit-receipt.ts, pruner budgets). ~10 parity/freshness test files exist solely to police this. Needs: one source of truth, importable modules, sandbox portability.
- **Fix:** Verdict MOVE→host (TS module in agent-runtime now, Rust daemon later) exposed as programmatic tools (e.g. `gate_evaluate`, `gate_fingerprint`, `classify_files`) that handleSteps yields. Guest keeps only orchestration yields. Unlocks NOW: delete generated region + ~10 parity tests, normal imports, profiling. NEXT: quickjs-emscripten guest can run a 300-line base2 shim; Rust gate engine shared by CLI/daemon/other-language agents. Cost: medium (tool plumbing + receipt shape contract). Confidence: high.
- **Evidence:** base2.ts:17-21 NOTE 'handleSteps is serialized via .toString() + new Function(...), which loses module closure'; 7802 '<gate-helpers-generated> DO NOT EDIT'; 9326 end marker; 815-821 reliabilityCodeStems 'parity test slices it'; 1040-1048 security globs 'mirror the advisory glob list'; 11625-11642 hasEditArtifact trimmed-copy comment; gate-reviewer.ts:1-15 regeneration instructions; general-agent.ts structuralReceiptPresent 'mirrors common/src/util/audit-receipt.ts'.

## [MEDIUM] correctness — agents/base2/base2.ts:9731 — File classification tables are inline regexes with polyglot gaps: test-file detection is JS/TS-only and reviewable extensions omit several languages (DECLARATIVE from language registry)
- **Risk:** isNonTestSourceFile/isPublicApiSourceFile treat only `__tests__/` and `.test|spec.tsx?` as tests, so Python `test_*.py`/`*_test.py`, Go `*_test.go`, Rust `tests/`, Java `src/test/` are classified as non-test source → test-writer targets test files and doc-writer treats them as public API. isReviewableGateFile/ isCoverageEvidenceFile list tsx?/jsx?/py/go/rs/java/kt/cs/fs/vb but omit rb/php/swift/c/cpp/scala/dart, while reliabilityCodeExtension (≈857) includes rb/php/swift/c/cpp — inconsistent sets, so a Ruby/Swift change is never reviewed by the final gate yet can route a reliability specialist. Needs: one per-language table (source exts, test globs, generated patterns).
- **Fix:** Verdict DECLARATIVE: generate `gate-file-classes.json` (schema-validated) from the common language registry: {language, sourceExts, testGlobs, generatedGlobs, docGlobs, publicApiHints}. Gate/tool reads it. Unlocks NOW: fixes the misclassification bugs and aligns the 4 divergent extension lists. NEXT: new language support is a registry row, not a base2 edit+regenerate. Cost: small-medium. Confidence: high.
- **Evidence:** base2.ts isReviewableGateFile (generated, ~7905-7920) ext list `tsx?|jsx?|mjs|cjs|py|go|rs|java|kt|kts|cs|fs|vb`; isCoverageEvidenceFile `__tests__\/|\.(test|spec)\.(?:tsx?|jsx?|mjs|cjs)$`; isNonTestSourceFile ~9731 `\.(test|spec)\.tsx?$`; reliabilityCodeExtension ~857 includes rb|php|swift|c|cc|cpp|h|hpp.

## [MEDIUM] correctness — agents/base2/base2.ts:9694 — Test-command inference hardcodes this monorepo's layout into the product agent (DECLARATIVE + CONSUME get_build_targets)
- **Risk:** inferPackageTestCommand returns `cd packages/<x> && bun run typecheck && bun test`, `cd agents && ...`, `cd common && ...`, `cd cli && ...` before extension fallbacks (pytest, go test ./..., cargo test, ./gradlew test, dotnet test, bun test). In a user repo with a `cli/src/` or `packages/*/src` dir these Openbuff-specific commands are emitted and fail; fallbacks ignore workspace roots (pytest from repo root, `./gradlew` for Kotlin without wrapper). selectProjectAwareTestWriterTargets already consumes get_affected_tests/get_build_targets but falls back to this table. selectAuxRelevantFiles also depends on it (inferPackageTestCommand !== null), so aux relevance itself is repo-shaped.
- **Fix:** Verdict CONSUME + DECLARATIVE: make get_build_targets (language registry–backed) the only source; move the repo-specific rows to this repo's openbuff.json/hooks config. Unlocks NOW: correct commands in user repos; NEXT: Rust daemon owns build-target detection for all languages. Cost: small. Confidence: high.
- **Evidence:** base2.ts:9694-9722 inferPackageTestCommand (`/^packages\/([^/]+)\/(?:src|__tests__)\//`, 'cd agents && bun run typecheck && bun test', 9715 pytest); 9815 selectProjectAwareTestWriterTargets falls back to inferPackageTestCommand; 10026 selectAuxRelevantFiles.

## [MEDIUM] api-contract — agents/base2/base2.ts:862 — Specialist reviewer routing is a regex policy table duplicated inline with a runtime-router escape hatch (DECLARATIVE)
- **Risk:** selectSpecialistReviewersInline (862-~1000) prefers params.orchestrationControlPlane.selectSpecialistReviewers, else runs its own copy of manifest regex (package.json…package.swift), migration/compat/reliability/perf/a11y/ux/product/evaluator keyword regexes. Two implementations of one policy with parity only by test; manifest list diverges from dependency-manager's manager enum (no mix/dart pubspec/flutter). Needs: shared, versioned routing rules.
- **Fix:** Verdict DECLARATIVE: specialist-routing.yaml {specialist, pathPatterns, requirementKeywords, requiresUiFiles} generated/validated against language registry manifests; evaluator in host (TS now, Rust later). Guest fallback deleted once runtime router is mandatory. Unlocks NOW: one router, explainable routing decisions in telemetry. NEXT: user-extensible specialists. Cost: small. Confidence: high.
- **Evidence:** base2.ts:862-872 runtimeRouter preference; 874-990 inline regex rules; returned order list; agents/__tests__/specialist-router-parity.test.ts exists; dependency-manager.ts manager enum includes dart/flutter/mix not in router manifest regex.

## [MEDIUM] correctness — agents/base2/base2.ts:4720 — Three repair loops (validation, reviewer, specialist, plus security) are near-copies with divergent guards (STATECHART sub-machine + shared helper)
- **Risk:** Validation repair (≈4720-5400), security repair (≈3050-3250), specialist repair (≈3700-4150) and reviewer repair (≈5700-6620) each re-implement: round counter, optional cap, receipt-addresses-open-finding check (M1-T4c), git_status re-absorb, pre/post fingerprint no-progress + cycle sets, hook re-run. Differences are accidental: security repair has no no-progress/cycle guard; validation repair uses fromRepair filter `!initialGitStatusFiles.includes` while others filter `pendingGateFiles.has`; debugger escalation only exists in validation loop; buildEscalationEditorPrompt (12440) is defined but never called (dead). Needs: one parameterized repair actor.
- **Fix:** Verdict STATECHART (repair sub-machine: requestRepair→awaitReceipt→verifyProgress→revalidate) with a single `runRepairRound(family, findings)` host helper; delete buildEscalationEditorPrompt or wire it. Unlocks NOW: uniform no-progress/cycle safety for security loop, ~800 lines removed. NEXT: repair policy (caps, escalation to debugger) as config. Cost: medium. Confidence: medium-high.
- **Evidence:** base2.ts seenReviewerRepairFingerprints/seenSpecialistRepairFingerprints declared ~1712-1714 (no security set); 4896 `if (repairRound >= 1)` debugger spawn only in validation path; security repair receipt check then `continue` without fingerprint guard (~3230-3280); code_search shows buildEscalationEditorPrompt only at 12440 (definition).

## [MEDIUM] api-contract — agents/base2/base2.ts:2465 — Typed handoff packets are hand-built object literals ~7 times (DECLARATIVE template + typed builder)
- **Risk:** test-writer (≈2465-2545), doc-writer (≈2640-2710), security repair, specialist repair, validation repair, reviewer test-writer and reviewer repair-editor handoffs each spell out schemaVersion/taskId (Date.now()+Math.random)/objective/requirements/acceptanceCriteria/invariants/nonGoals/risks/permissions/allowedTools. allowedTools drift: writer handoffs list 'str_replace'/'write_file' (≈2529, 2693, 6043) while test-writer/doc-writer agents expose only edit_transaction (test-writer.ts toolNames), so handoff permissions name tools the child cannot call. Non-deterministic taskIds hurt replay.
- **Fix:** Verdict DECLARATIVE: handoff templates (YAML/JSON per role) + one `buildHandoff(role, findings, scope)` host function validated against the common handoff schema and the child agent's toolNames; deterministic ids from gate fingerprint. Unlocks NOW: removes tool-name drift, ~500 lines. NEXT: other-language agents emit identical handoffs. Cost: small-medium. Confidence: high.
- **Evidence:** base2.ts:2529/2693/6043 `'str_replace',` in allowedTools; test-writer.ts toolNames ['read_files','read_outline','edit_transaction','set_output']; doc-writer.ts toolNames lacks str_replace/write_file; taskId `${Date.now()}-${Math.random()...}` in each handoff.

## [MEDIUM] performance — agents/base2/base2.ts:11872 — Content-marker hashing and fingerprints run in-guest via process.getBuiltinModule fs/crypto (MOVE→Rust daemon / CONSUME tool)
- **Risk:** readGateFileContentMarker/Uncached (11872-12140) and hashGateSnapshotDetails resolve node:fs/node:crypto at call time, walk symlink components, hash 64KiB chunks; called repeatedly per iteration (eviction ledger, security/specialist freshness, snapshot details, receipts). This hard-binds the 'sandboxable' generator to Node built-ins—incompatible with a quickjs-emscripten guest (no fs) and falls back to 'unreadable:no-crypto', which fail-closes the whole gate. Per-turn cache is 250 entries, reset each turn.
- **Fix:** Verdict MOVE→lang: a daemon `snapshot_fingerprint(files)` / `content_markers(files)` tool in Rust (blake3/sha256, persistent mtime/size cache across turns, watcher invalidation). Guest yields it. Unlocks NOW: quickjs sandboxing of base2 without fs capability; NEXT: cross-turn cache, parallel hashing on large diffs. Cost: medium (marker string format must stay byte-identical: 'sha256:<hex>:<len>', 'missing', 'unreadable:*'). Confidence: high.
- **Evidence:** base2.ts:11872 readGateFileContentMarker cached wrapper; 11946 Uncached uses getBuiltinModule('node:fs'/'node:path'/'node:crypto'); GATE_MARKER_CACHE_MAX=250 (~1068); hashGateSnapshotDetails generated copy returns 'unreadable:no-crypto' without crypto.

## [MEDIUM] state-mutation — agents/base2/base2.ts:1175 — Serialized-state hydration/migration is ~325 lines of ad-hoc ??= defaults and legacy-shape carve-outs (DECLARATIVE schema with versioned migrations)
- **Risk:** Because there is no live VM snapshot, every turn rebuilds from base2ActiveWork with ~50 `??=` defaults, deliberately-absent keys (securityReviewFileMarkers/specialistReviewFileMarkers absence = legacy signal), presence-semantics keys (planTaskGateReceipts present ⇔ gate active, deleted otherwise), write-only fields kept for compatibility (reviewedReviewableFingerprint), legacy scalar mirrors (requiredReviewerRevalidation vs owedReviewerRevalidations). Semantics live in comments; a missed default throws TypeError mid-turn (comment at planTaskGateReceipts normalization documents such a crash).
- **Fix:** Verdict DECLARATIVE: a zod/JSON-Schema `Base2ActiveWorkState` with schemaVersion and explicit migration functions (host-side), producing a normalized state before handleSteps runs. Unlocks NOW: remove presence-as-signal hacks, drop write-only fields via migration. NEXT: state readable by the Rust daemon/CLI with the same schema. Cost: medium. Confidence: high.
- **Evidence:** base2.ts:1175-1230 default object; 1231-1290 `??=` chain; 1291-1330 planTaskGateReceipts present/delete invariant; 1340-1440 deleted-file prune and owed-set rehydration; 6700-6710 'Soft-deprecated WRITE-ONLY field' reviewedReviewableFingerprint.

## [LOW] api-contract — agents/base2/base2.ts:546 — Prompt assembly: system prompt is a ~230-line template literal with ~20 mode conditionals (DECLARATIVE fragments; guide table already good)
- **Risk:** systemPrompt (546-777) and instruction/step builders (12509-12726, ~220 lines) interleave prose with isDefault/isFast/planOnly/noAskUser ternaries, making per-mode surfaces hard to diff; GUIDE_POINTER_TABLE (137-218) is already a declarative, compile-checked table and a good pattern. Duplicated prose: tool-choice/tiered-read policy appears twice in systemPrompt (Core Mandates bullet and Tool choice bullet); 'Code Editing Mandates' intentionally restates the craftsmanship guide.
- **Fix:** Verdict DECLARATIVE: move prose into markdown fragments with front-matter `modes:` selectors (same pattern as agents/guides), assembled by a tiny renderer; keep snapshot tests (quality-prompt-snapshot.test.ts). Unlocks NOW: per-mode prompt diffs, dedup of repeated tool policy. NEXT: localized/model-specific prompt packs, non-TS agents reuse fragments. Cost: small-medium. Confidence: medium.
- **Evidence:** base2.ts:137 GUIDE_POINTER_TABLE; 546 systemPrompt start; 'Prefer dedicated harness tools' bullet and '**Tool choice:**' bullet both carry tiered read policy; 12509 EXPLORE_PROMPT; 12511/12645 builders; 12727 definition.

## [LOW] api-contract — agents/base2/base2.ts:503 — Spawnable roster and budget options are policy data embedded in createBase2 (DECLARATIVE)
- **Risk:** spawnableAgents buildArray (503-545) encodes per-mode deltas asserted by roster-drift.test; five max*Rounds options are resolved at module load (resolveMax*), then re-clamped inline with literal caps 10/20 inside handleSteps (1115-1172) because the generator cannot import the resolvers—two clamp implementations.
- **Fix:** Verdict DECLARATIVE: agent-roster.yaml {agent, modes} and gate-budgets schema (min/max/default) consumed by both createBase2 and the host gate. Unlocks NOW: single clamp source; NEXT: user-configurable roster via openbuff.json. Cost: small. Confidence: high.
- **Evidence:** base2.ts:503-545 roster with `!planOnly &&`/`isDefault &&`; 280-330 resolveMax* with process.env; 1110-1172 MAX_* re-clamp `Math.min(Math.floor(x), 20)` with comment 'cannot call module-scope resolve helpers'.

## [LOW] correctness — agents/base2/base2.ts:1500 — Prompt-intent classifiers (git delivery, tests/docs required, conversation-only) are English-only regexes (KEEP short-term; CONSUME structured intent later)
- **Risk:** hasExplicitGitDeliveryIntent (1500-1545), requestRequiresTests/Docs (2392-2405) and isConversationOnlyPrompt drive gate behavior (adopting dirty files, spawning writers) from English regex over the user prompt; non-English prompts silently disable test/doc aux gates; 'no tests' negation window is 32 chars.
- **Fix:** Verdict KEEP now (bounded, tested by git-delivery-intent.test.ts); NEXT CONSUME: have the model declare intent via a structured tool/param (e.g. write_todos tags or a `declare_intent` tool) and fall back to regex. Cost: small. Confidence: medium.
- **Evidence:** base2.ts:1500 hasExplicitGitDeliveryIntent; 2392-2405 requestRequiresTests/requestRequiresDocs regexes; isConversationOnlyPrompt greeting regex ~990.

## [LOW] state-mutation — agents/base2/base2.ts:11234 — Todo / plan-task / committed-surface / COMMIT ANYWAY tracking re-parses full message history every step (CONSUME runtime-structured state)
- **Risk:** extractLatestWorkflowTodoProgress (11234-11416), extractActivePlanTaskIdFromMessages (10952), extractCommittedSurfaceReviewRequest (11113, with a history-length watermark that breaks on compaction), updateCommitScopeBypassFromMessages (11205) all scan messageHistory and infer tool success via toolCallSucceeded success-verb regexes (11417) — including an opt-in `/\bcurrent task\b/` pattern to recognize handler messages. Tool result text is the API contract; context compaction can drop the evidence.
- **Fix:** Verdict CONSUME: runtime handlers for write_todos/update_plan_status should publish structured results into agentState (e.g. agentState.workflowTodos, activePlanTask, committedSurfaceRequest) that handleSteps reads directly. Unlocks NOW: delete ~600 lines and the success-verb heuristics; NEXT: CLI renders the same state. Cost: small-medium. Confidence: high.
- **Evidence:** base2.ts:10952, 11113 watermark docblock ('history SHRANK (context compaction)'), 11205, 11234, 11417 toolCallSucceeded extraSuccessPattern comment.

## [LOW] performance — agents/base2/base2.ts:10219 — Reviewer result trees are re-walked by 6+ collectors per review (performance, acknowledged)
- **Risk:** collectStructuredReviewerOutputs is invoked independently by blockers, hard blockers, parent-owned classification, finalization verdict, finding records, attestation, drift, advisories, receipts and stale checks for the same toolResult (depth-8 walk each). Comment in gate-reviewer.ts collectParentOwnedRequirementBlockers acknowledges this.
- **Fix:** Verdict KEEP TS but parse once: `parseReviewerResult(toolResult) -> NormalizedReview` then pure functions over it (fits the host-side gate engine move). Cost: small. Confidence: high.
- **Evidence:** gate-reviewer.ts collectParentOwnedRequirementBlockers docblock 'every other gate collector ... re-walks the same reviewer result'; base2.ts final reviewer block ~5480-5560 calls collectReviewerBlockers, collectReviewerHardBlockers, collectParentOwnedRequirementBlockers, collectReviewerFindingRecords separately; recordSuccessfulReviewReceipt 10219 re-collects.

## [LOW] api-contract — agents/base2/gate-reviewer.ts:557 — Reviewer verdict/hard-rule semantics: pure TS module is the right shape; hard-rule strings should be declarative (KEEP + DECLARATIVE rule ids)
- **Risk:** collectReviewerBlockers and collectReviewerHardBlockers must emit byte-identical strings (SYNC CONTRACT) because condoning compares via Set.has on prose; parent-owned requirement detection is an English regex list. String identity as API is fragile across languages/renderers.
- **Fix:** Verdict KEEP (pure, well-tested) but switch hard rules to structured {ruleId, dimension, requirement} records with rendered text derived; condone by ruleId. NEXT: port the pure module to Rust alongside the gate engine (it is dependency-free). Cost: small. Confidence: medium-high.
- **Evidence:** gate-reviewer.ts collectReviewerBlockers docblock 'SYNC CONTRACT ... byte-identical'; collectReviewerHardBlockers docblock; isParentOwnedOrOutOfScopeRequirement regex list.

## [MEDIUM] correctness — agents/dependency-manager/dependency-manager.ts:408 — Manager×operation→command table is a 150-line if/else chain building shell strings inside the generator (DECLARATIVE registry + argv execution)
- **Risk:** supportedOperations map (≈302-321) and the per-manager command builder (≈408-560) are policy data coded as string concatenation executed via run_terminal_command (shell). Quoting is hand-rolled; mismatches exist vs the language registry (e.g. `cargo rm` alias, `./gradlew dependencies` for sync, pip has no workspace/venv notion). Rollback (restore snapshots, delete created lockfiles) is multi-yield best-effort, not transactional.
- **Fix:** Verdict DECLARATIVE + MOVE→lang: `package-managers.yaml` {manager, detectManifests, ops:{add:[argv...]}} generated from the language registry; execution by a daemon tool taking argv arrays (no shell) with journaled rollback in Rust. Unlocks NOW: shared table with router/manifests, no shell quoting; NEXT: atomic rollback. Cost: medium. Confidence: high.
- **Evidence:** dependency-manager.ts supportedOperations record; `const quote = (value: string) => ...` shell quoting; npm/pnpm/yarn/.../gradle branch chain; `commands.push('./gradlew dependencies')`; rollback loop with write_file restore + edit_transaction delete.

## [LOW] correctness — agents/git-committer/git-committer.ts:90 — Git delivery pre-flight is sequenced shell commands with manual quoting (KEEP orchestration; CONSUME typed git tools)
- **Risk:** handleSteps runs ~12 run_terminal_command git calls, parses stdout, quotes owned_paths POSIX-style, regex-guards branch/remote names, and restores via `git restore --staged` only for regex-safe paths. Correct but string-protocol-bound; default-branch detection depends on remote HEAD. Terminal policy profile is the real guard.
- **Fix:** Verdict KEEP flow as generator (it is linear), but CONSUME structured tools (git_status already exists; add git_stage/git_commit/git_push via gix in daemon) to drop quoting and stdout parsing. Cost: small-medium. Confidence: medium.
- **Evidence:** git-committer.ts shellQuote; `git add -- ${ownedPaths.map(shellQuote)}`; unstageTargets regex filter; branchRefSafe guard; `git rev-parse --abbrev-ref ${remote}/HEAD` fail-closed.

## [LOW] api-contract — .agents/claude-code-cli.ts:16 — Four CLI-tmux agents copy-paste an identical ~110-line handleSteps because constants cannot close over config (DECLARATIVE config + one generic generator)
- **Risk:** claude-code/codex/gemini/codebuff-local re-declare START_COMMAND/CLI_NAME inside handleSteps ('Constants must be inside handleSteps since it gets serialized via .toString()') and duplicate session-start parsing, failure set_output, and stop. startCommand is interpolated inside shell double quotes. createCliAgent already produces prompts/schemas from CliAgentConfig.
- **Fix:** Verdict DECLARATIVE: pass startCommand/cliName/skipPrepPhase via programmaticConfig (as base2 does with `config`) and ship one generic handleSteps in createCliAgent. Unlocks NOW: 3×110 lines removed, single fix site. Cost: small. Confidence: high.
- **Evidence:** .agents/claude-code-cli.ts:15 comment + 18-137; codex-cli.ts:95-217; gemini-cli.ts:21-143; codebuff-local-cli.ts:37-148; create-cli-agent.ts:78-80 'handleSteps is NOT defined here'.

## [LOW] api-contract — agents/specialists/create-specialist.ts:33 — Specialist factory is already data-driven; target shape for all reviewer/leaf agents (DECLARATIVE)
- **Risk:** createSpecialist turns {id, focus[], terminal, advisory, intelligence[]} into schema/tools/prompts; 14 specialists are one-call configs. security-reviewer, debugger, doc-writer, test-writer, researcher-docs are hand-written objects of the same shape (static schema + prompt + trivial handleSteps: debugger/doc-writer prefetch reads from params; test-writer/synthesizer just STEP_ALL).
- **Fix:** Verdict DECLARATIVE: express leaf agents as YAML/JSON manifests (schema, tools, filesystemScope, prompt fragments, optional `prefetch: [{tool: read_files, from: params.suspect_files}]`) validated by the SecretAgentDefinition schema; keep TS only for agents with real control flow (base2, thinker harvest, general-agent, git-committer, dependency-manager, researcher-web). Unlocks NOW: agents authorable without TS; NEXT: registry-generated per-language agents. Cost: small. Confidence: high.
- **Evidence:** create-specialist.ts:33-255; debugger.ts:62-79 handleSteps prefetch only; doc-writer.ts:138-148; test-writer.ts:131-133 `yield 'STEP_ALL'`; synthesizer.ts:189-203; security-reviewer.ts no handleSteps.

## [LOW] correctness — agents/thinker/thinker.ts:66 — Final-answer harvest logic duplicated across thinker, general-agent and runtime (CONSUME runtime harvest)
- **Risk:** thinker handleSteps (66-252) and general-agent harvestedAnswerText/needsHarvestedAnswer re-implement <think> stripping, last-assistant-turn selection and 'never clobber prior set_output' rules that the runtime (run-agent-step) also applies; divergence risk (general-agent skips STEP_CAP_REACHED/TOOL_CALL_ERROR tags, thinker does not).
- **Fix:** Verdict CONSUME: a runtime option `outputHarvest: 'assistant-text'` on the definition; delete generator copies. Cost: small. Confidence: medium.
- **Evidence:** thinker.ts:84-102 cleanedTextFromContent 'Matches run-agent-step'; general-agent.ts harvestedAnswerText tag filter for STEP_CAP_REACHED/TOOL_CALL_ERROR; thinker lacks that filter.

## [LOW] correctness — agents/general-agent/general-agent.ts:430 — Audit-shard completion enforcement only engages when snapshotId is present, contrary to its own instructions
- **Risk:** auditRequested = sessionSlug && shardId && snapshotId, so a shard given slug+shardId but no snapshotId is never re-prompted nor marked unresolved when it skips write_audit_findings, although instructionsPrompt says the write is required 'with or without params.snapshotId'.
- **Fix:** Verdict KEEP TS; gate on sessionSlug&&shardId and accept an unbound artifact receipt when snapshotId is blank. Cost: trivial. Confidence: high.
- **Evidence:** general-agent.ts `const auditRequested = Boolean(sessionSlug && shardId && snapshotId)`; instructionsPrompt 'That is required with or without params.snapshotId'.

## [LOW] performance — agents/base2/base2.ts:810 — Line-budget breakdown of base2.ts (12,729 lines): ~72% orchestration, ~12% generated duplicate helpers, ~9% prompt text, ~7% policy tables
- **Risk:** Estimates from symbol/line anchors (not a tooled token count): prompt text ≈1,150 (module guide pointers ~60, systemPrompt 546-777 ~230, builders 12509-12726 ~220, in-loop add_message/handoff prose ~650); policy tables ≈850 (roster 503-545, specialist router 815-~990, security globs+budget clamps 1049-1172, file-class/test-command/tool-name tables ~9660-10050 and isFileChangingTool, parse regexes); generated region 7802-9326 ≈1,525 (pure duplication of gate-*.ts); orchestration/state ≈9,200 (hydration 1175-1498, turn start 1540-1728, loop 1729-7007: committed-surface ~290, aux writers ~310, security ~530, specialist ~1,215, reuse paths ~140, validation+repair ~680, final reviewer+condone+repair ~1,220, gate pass ~375; post-loop helpers 7008-7801 and 9328-12507 ~3,970). Comments are roughly 35-40% of orchestration lines.
- **Fix:** Use as sizing input: moving generated region + tables + hashing host-side and templating prompts shrinks the serialized guest to the ~5k-line gate machine; statechart conversion targets that remainder. Confidence: medium (±10% on buckets).
- **Evidence:** Anchors from code_search on base2.ts: 137, 243, 503, 546, 810, 862, 1049, 1175, 1500, 1729, 2085, 2448, 2619, 2756, 3285, 4535, 4676, 5410, 6631, 7008, 7802, 9326, 9328, 12440, 12509, 12727.

## Coverage receipt

### Subsystems
- agents
- .agents

### Features
- base2-gate-state-machine
- base2-file-classification
- base2-command-inference
- base2-prompt-assembly
- base2-reviewer-routing
- base2-repair-loops
- base2-handoff-building
- base2-todo-plan-tracking
- base2-fingerprint-markers
- base2-generated-helper-region
- base2-state-hydration
- base2-telemetry-gate-state-block
- reviewer-verdict-parsing
- leaf-agent-definitions
- cli-tmux-agents
- specialist-factory
- dependency-command-registry
- git-delivery

### Files
- agents/base2/base2.ts
- agents/base2/gate-reviewer.ts
- agents/security-reviewer/security-reviewer.ts
- agents/debugger/debugger.ts
- agents/doc-writer/doc-writer.ts
- agents/test-writer/test-writer.ts
- agents/thinker/thinker.ts
- agents/synthesizer/synthesizer.ts
- agents/git-committer/git-committer.ts
- agents/dependency-manager/dependency-manager.ts
- agents/researcher/researcher-docs.ts
- agents/researcher/researcher-web.ts
- agents/general-agent/general-agent.ts
- agents/specialists/create-specialist.ts
- .agents/claude-code-cli.ts
- .agents/codebuff-local-cli.ts
- .agents/codex-cli.ts
- .agents/gemini-cli.ts
- .agents/notion-agent.ts
- .agents/notion-researcher.ts
- .agents/constants.ts
- .agents/lib/cli-agent-prompts.ts
- .agents/lib/cli-agent-schemas.ts
- .agents/lib/cli-agent-types.ts
- .agents/lib/create-cli-agent.ts

### Domains
- correctness
- api-contract
- state-mutation
- performance
