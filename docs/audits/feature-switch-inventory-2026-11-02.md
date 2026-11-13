# Feature switches and inactive functionality inventory

Snapshot: working tree, 2026-11-02. This inventories product-level feature gates, persisted preferences, disabled implementations, rollout canaries, permissions and noteworthy opt-in mechanisms. It is not an inventory of every boolean, constant, request parameter, credential, timeout, or transient UI state. No readiness assessment or changes are implied by inclusion.

## Principal findings

- `agents/base2/base2.ts:487` pins progressive **tool** disclosure false. Its tier ceiling is dormant for base2, even though static mode-based tool selection remains active. This is distinct from progressive **prompt** disclosure, which defaults on (`agents/base2/base2.ts:291`). Whether to enable the tier mechanism requires evaluating its intended tool exposure and runtime tests.
- `packages/agent-runtime/src/util/context-consolidation-runner.ts:83` requires a template opt-in for background snapshot consolidation. Search found no shipped production template setting it true. It is described as a prototype and makes extra model calls.
- `common/src/constants/chatgpt-oauth.ts:9` pins OAuth on; its OFF comment is stale. Remove the gate only if the feature is intended as permanent; the implementation still labels it experimental.
- `cli/src/utils/settings.ts:12,30` retains ads and legacy billing settings with no product consumers found outside that settings file. `fallbackToALaCarte` also occurs in separate shared subscription types, so that name is not globally unused. Persisted settings compatibility needs review before deletion.
- Semantic indexing, exact token counting, file context collection and diagnostic preflight are opt-in features rather than constants that must be edited. Their dependencies and effects are listed below.
- SCIP has a real CLI caller at `cli/src/commands/index-command.ts:289`; it is user-invoked, not unwired.

## Coverage and method

The working tree has existing changes, so findings describe its current state, not necessarily a clean commit. Parallel source searches covered `cli/src`, `sdk/src`, `common/src`, and `packages` using feature names, boolean defaults, configuration schemas, environment keys, opt-in/disabled language, and callers. Agent definitions and `.agents` templates were searched separately; `scripts`, `rust`, `web`, `.github`, `test`, docs, and examples were searched for feature-switch terminology and environment access. The sections below report the substantive controls found and explicit limitations. Cross-checks traced notable names outside their defining package. This is a comprehensive lexical inventory of these categories, not a formal proof against an arbitrarily named or dynamically constructed gate.

Disposition of top-level directories: `agents`, `cli`, `common`, `packages`, `sdk`: production inventory below; `scripts`, `rust`, `web`, `.github`, `test`, `evals`, `.agents`: searched for relevant controls; `docs`, `openbuff.d.example`: supporting documentation and examples. `agents-graveyard`: archived agents, not shipped product; `node_modules`: third-party dependencies; `.git`, `.codebuff-index`, `.omx`, `.tmp`, `.e2e-scratch`, `debug`, `e2e-traces`, `scratch-logs`: generated, local state or traces; `.aws`, `.codex`, `.openbuff`, `.commandcode`, `.vscode`, `.bin`: local tooling/configuration, not product source. Secrets and local environment values were not inspected. Tests, generated bundled sources and evaluation datasets were excluded as independent product definitions; generated artifacts may need regeneration after a future change.


## Agents and modes

| Control | Behavior | Evidence |
| --- | --- | --- |
| Progressive tool disclosure | Explicitly off in base2; static mode gates remain active | `agents/base2/base2.ts:487`, `agents/base2/tool-tiers.ts:165` |
| Progressive prompt disclosure | On by default; `createBase2` option can disable | `agents/base2/base2.ts:51,291` |
| Unlocked tool tiers | Optional caller-selected static tool surface; default includes non-core tiers | `agents/base2/tool-tiers.ts:146` |
| File picker reasoning | Disabled for that specific agent; file picker remains enabled | `agents/file-explorer/file-picker.ts:14` |
| Fast no-validation and plan modes | Distinct intentional agent modes | `agents/base2/base2-fast-no-validation.ts:4`, `agents/base2/base2-plan.ts:4` |
| Committed-surface review | Explicit per-task opt-in | `agents/base2/gate-state.ts:104` |
| Lightweight reviewer receipts | Optional caller choice; production activation not established | `agents/base2/gate-reviewer.ts:1888` |

# CLI feature-switch inventory

Scope: all 351 non-test, non-generated TypeScript/TSX files under cli/src; systematic textual passes for feature/enabled/disabled/experimental/opt-in; OPENBUFF/CODEBUFF env and feature-like uppercase names; disabled/unavailable/not implemented; CLI arguments and persisted settings. Checked representative consumers and declaration. This is a comprehensive lexical search over that defined scope, not a line-by-line proof against switches expressed without these words. Generated bundled agent code and tests excluded; shared SDK settings covered by other shards.

| Item | Current behavior and evidence | Classification / decision |
|---|---|---|
| CHATGPT_OAUTH_ENABLED | true in common/src/constants/chatgpt-oauth.ts:9, gates cli/src/init/init-app.ts:71, cli/src/commands/command-registry.ts:1362, cli/src/commands/router.ts:446, cli/src/index.tsx:384, cli/src/data/slash-commands.ts:73, cli/src/components/input-mode-banner.tsx:27. OFF comment contradicts code. | Hardcoded release gate, candidate to remove once OAuth supported; CLI comment cli/src/utils/chatgpt-oauth.ts:3 still labels experimental. |
| adsEnabled | cli/src/utils/settings.ts:12 defaults true, validation line 103; no other cli/src consumers. | Apparent inert persisted setting; check outside CLI and compatibility before removal. |
| alwaysUseALaCarte, fallbackToALaCarte | cli/src/utils/settings.ts:30-33 deprecated, validated at 113-120; no other cli/src consumers. | Apparently inert legacy persisted settings; check SDK/outside CLI before removal. |
| feedback | cli/src/components/feedback-container.tsx:18,34 explicitly unavailable; no cloud backend. | Feature absent, enabling requires implementation. |
| publishing | cli/src/hooks/use-publish-mutation.ts:27 and cli/src/index.tsx:568 explicitly unavailable in local mode. | Feature absent, enabling requires local/backend design. |
| indexing and semantic indexing | cli/src/commands/index-command.ts:83-92 and cli/src/init/init-app.ts:22-24 consume config; indexing default on, semantic default off in sdk/src/provider-config.ts:354-358. | Configurable opt-in: semantic requires model and may transmit repository content; don't hardcode on. |
| SCIP precise references | cli/src/commands/index-command.ts:289-300 only on explicit /index scip, executes external indexers. | Explicit user action, not release gate. |
| MCP mutations | cli/src/cli-args.ts:215-234 defaults false; cli/src/commands/mcp-command.ts:61,120 sets server read-only unless --mutations. | Permission boundary, keep explicit. |
| Project agent and skill trust | cli/src/cli-args.ts:143-157, cli/src/utils/local-agent-registry.ts:112-115,153; default false unless --trust-project-agents. | Trust boundary; preserve. |
| Memory authority | cli/src/utils/env.ts:97-103 defaults sqlite-v2-opt-in despite name; cli/src/commands/memory-command.ts:233 says json-v1/shadow-v2 deprecated. | Active modern default; legacy choices are migration/compatibility candidates; readiness not assessed. |
| Memory semantic search / compaction / event deletion | cli/src/services/memory-v2/bun-sqlite-memory-repository.ts:2264-2265,2630-2635 explicitly return unsupported. | Missing implementations, not switches to flip. |
| Linux Bun recursive watching | cli/src/utils/index-workspace-watcher.ts:37,155 disabled for runtime reliability; integrity sweeps remain. | Platform fallback, not dormant feature. |
| automatic clipboard copying | cli/src/utils/settings.ts:13,26-29; cli/src/hooks/use-clipboard.ts:37,87; on by default with user opt-out. | Privacy preference, preserve. |
| bisect keep-best | cli/src/commands/command-registry.ts:882; cli/src/utils/turn-snapshots.ts:619,1040; only when --keep-best. | Explicit destructive-state preference, preserve. |
| PERF_TEST | cli/src/components/message-block.tsx:195 and cli/src/components/blocks/agent-branch-item.tsx:68 compare CODEBUFF_PERF_TEST to true. | Developer performance instrumentation, off by default. |
| Theme autodetect | cli/src/utils/theme-system.ts:330-359 checks editor settings and availability. | User/environment preference, not hardcoded feature gate. |
| native ripgrep selection | cli/src/native/ripgrep.ts:107,118 uses CODEBUFF_IS_BINARY and CODEBUFF_CLI_LEGACY_MACOS to choose binary. | Runtime/platform routing. |
| OPENBUFF_MAX_MISSING_OUTPUT_RETRIES | cli/src/utils/create-run-config.ts:136-148 fallback numeric override. | Limit override, not a boolean gate. |

Other CLI environment keys are paths, credentials, terminal/IDE detection, version, and numeric tuning (cli/src/utils/env.ts:20-87); they are not feature switches. Interactive disabled states (keyboard navigation, UI controls, query activation) are transient state, not dormant features. SDK, common, agents, package defaults and tests require their respective shard inventories for repo-wide coverage.


# SDK and common feature-switch inventory

Scope: production `sdk/src` and `common/src`, including schemas, environment access, constants, and API options; excludes tests, generated files, historical fixtures, and non-code docs. Method: searched all TypeScript/TSX for boolean schema defaults and assignments, feature/experimental/opt-in/default-on/default-off terminology, environment access and named trust, enable, mode, telemetry, mutation and diagnostic variables; inspected candidate definitions and consumers. This is a systematic lexical inventory, not a proof that opaque or dynamically constructed switches cannot exist. Counts: 174 initial hits in /tmp/sdk-switch-hits.txt. All paths below are relative to repository root.

| Switch / feature | Default or current behavior | Evidence / interpretation |
| --- | --- | --- |
| CHATGPT_OAUTH_ENABLED | hardcoded true | common/src/constants/chatgpt-oauth.ts:9; CLI uses it for registration and routing. Comment says default OFF despite true; cleanup candidate if feature is graduated. |
| indexing.enabled | true | sdk/src/provider-config.ts:354,366; local metadata index. User setting, not a hardcoded gate. |
| indexing.semantic.enabled | false | sdk/src/provider-config.ts:358,383; model required and embedding provider may receive content. Configurable user setting. |
| OPENBUFF_PROCESS_SUPERVISION | on if supported; opt-out | sdk/src/impl/agent-runtime.ts:56-90; compiled binary, Node and Windows fallback in-process. Configurable launch behavior. |
| OPENBUFF_EDIT_BLOCKS | on; opt-out | common/src/tools/params/edit-blocks.ts:63-99. Comment at common/src/tools/params/utils.ts:888 incorrectly says default-off. |
| OPENBUFF_EXACT_TOKENS | off unless enabled | sdk/src/run.ts:793-806; runtime tokenizer gate; requires tokenizer registration. |
| OPENBUFF_DIAGNOSTIC_PREFLIGHT | off unless truthy | sdk/src/tools/file-change-hooks.ts:1476-1495; requires injected diagnostic delta hook, not simply a switch flip. |
| OPENBUFF_DIAGNOSTIC_DELTA_MODE | normal unless `strict` | sdk/src/services/diagnostic-delta.ts:86,100,325-335; strict mode changes policy. |
| autoFileChangeHooks | disabled unless true | sdk/src/provider-config.ts:511; trust boundary for running manifest-inferred commands. |
| OPENBUFF_TRUST_ANCESTOR_CONFIG | off unless `1` | sdk/src/provider-config.ts:1103,1442; trust boundary for ancestor config and credentials. |
| OPENBUFF_TRUST_PROJECT_READABLE_ROOTS | off unless `1` | sdk/src/run.ts:551,863-891; permits project-configured external readable roots. |
| MCP server mutation tools | off unless explicitly requested | sdk/src/mcp/server.ts:391,406,516; write-capability boundary. |
| allowClientMcp on socket ACP | false | sdk/src/serve/serve.ts:63-72; client-supplied MCP servers rejected on socket by default; stdio differs. |
| OPENBUFF_TELEMETRY / DO_NOT_TRACK | explicit opt-out | common/src/analytics.ts:12-21; telemetry needs separate client configuration; do not infer actual sending merely from this resolver. |
| CODEBUFF_FULL_TELEMETRY / CODEBUFF_FULL_TELEMETRY_IDS | opt in to full sampling | common/src/util/analytics-sampling.ts:79-85; telemetry sampling policy. |
| adaptiveReasoning | optional | sdk/src/provider-config.ts:489; requests phase-specific reasoning when no explicit choice exists. Consumer/default must be traced before activating. |
| agent includeMessageHistory, includeReasoningInMessageHistory, inheritParentSystemPrompt | false by schema default | common/src/types/dynamic-agent-template.ts:224-228; per-agent information-sharing choices, not global disabled features. |
| provider compatibility and capability booleans | vary per provider | sdk/src/provider-config.ts:93-103,250,297-302; represent provider behavior/capabilities, not globally safe to enable. |
| tool input booleans | vary by operation | common/src/tools/params/tool/ e.g. git-status.ts:13, edit-transaction.ts:49, run-terminal-command.ts:112; caller options, not release gates. |
| memory authority | CLI-selected | common/src/types/memory-v2.ts:11; sdk/src/services/memory-v2/types.ts:41-65 and coordinator.ts:816; modes remain conditional, determine effective default in CLI. |
| model recommendation | explicitly requested | sdk/src/provider-config.ts:1861; recommendation layer deliberately does not participate in automatic provider routing. |
| OPENBUFF_LOCAL_MODE | environment selector | common/src/env-process.ts:36; semantics must be traced at consumers, not a universal feature flag. |

No exhaustive readiness or safety verdict follows from presence of a switch; tests, runtime prerequisites, callers and intentional compatibility/security contracts must be checked before changing it. Search scope excluded test fixtures and generated code so it is not a literal inventory of every boolean in the two trees.


# Packages switch inventory

Scope: all production TypeScript/TSX/JS/Rust under packages/{agent-runtime,indexer,code-map,internal}; searched flag/enable/disable/experimental/opt-in/default and environment access (130 matching lines), and boolean comparisons/default expressions (96 matching lines in agent-runtime, indexer, code-map); traced key symbols repo-wide including agents and SDK. Excluded tests, generated artifacts, fixtures, and ordinary transient UI/state booleans. This is a systematic lexical inventory, not a proof against semantically equivalent controls with unrelated names; matches in /tmp/pkg-switch-search.txt and /tmp/pkg-bools.txt.

| Control | Actual behavior/default | Classification / consequence |
| --- | --- | --- |
| agents/base2/base2.ts:487; packages/agent-runtime/src/util/base2-tool-tiers.ts:19 | progressiveToolDisclosure explicitly false for base2, tier machinery dormant. | Hardcoded inactive feature; verify intended full tool surface before enabling. Prior claim default-on was incorrect for base2. |
| packages/agent-runtime/src/util/context-consolidation-runner.ts:42,83 | backgroundSnapshotConsolidation false unless template opts in; no production assignment true found in repo-wide search. | Dormant canary; background LLM call costs resources, needs readiness decision. |
| packages/agent-runtime/src/tools/handlers/tool/find-files.ts:30,43,153 | OPENBUFF_COLLECT_FULL_FILE_CONTEXT or experimental.collectFullFileContext enables, default off. | Experimental context retrieval; adds model/file context work. |
| packages/agent-runtime/src/util/token-counter.ts:259,265,470; sdk/src/run.ts:793 | OPENBUFF_EXACT_TOKENS off unless truthy; registered exact tokenizer required, otherwise fallback. | Opt-in functionality, not hardcoded false. |
| packages/indexer/src/index-manager.ts:142,146,176 | indexing enabled by default; semantic indexing off by default and requires embedder. | User config; changing semantic default triggers embeddings/network and model requirement. |
| packages/indexer/src/index-store.ts:42,48,51,1365 | writeGitExcludeDefault false; setWriteGitExclude can opt in, no non-test production call found. | Dormant optional Git metadata side effect; purposeful default off. |
| packages/indexer/src/query.ts:35,41,250 | pageRankWeight defaults 0, direct query option can set. | Ranking enhancement opt-in; no production assignment to nonzero found. |
| packages/indexer/src/scip-runner.ts:20,27,647; packages/indexer/src/index-manager.ts:934,947 | SCIP ingestion runs only on explicit API invocation; CLI invokes it on explicit `/index scip` (cli/src/commands/index-command.ts:289). | Dormant-by-default expensive external compile-scale indexers; explicit caller controls. |
| packages/agent-runtime/src/util/agent-tool-names.ts:39,70 | progressive disclosure can be opted out per template; base2 does opt out above. | Programmatic agent behavior, distinct from global flag. |
| packages/agent-runtime/src/supervision/supervised-spawn.ts:188,733 | child restart policy absent unless provided. | Optional API behavior; not dormant globally demonstrated. |
| packages/agent-runtime/src/supervision/process-supervisor.ts:426 | absolute lifetime limit absent by default. | Optional resource bound, not feature switch. |
| packages/agent-runtime/src/run-programmatic-step.ts:554,924; packages/agent-runtime/src/util/read-authorization.ts:60 | read-authority restamping / provider-native tool-call history explicitly opted into per call. | Contract/security scoped behaviors. |
| packages/agent-runtime/src/util/run-journal.ts:27,472 | journaling features and retention caps opt-in via factory params. | SDK API choices; does not prove journal unused. |
| packages/agent-runtime/src/tools/handlers/tool/spawn-agent-utils.ts:3984,4009 | process supervision runs when supplied true and seam exists; otherwise in-process. | SDK resolver controls default; supported runtime required. |
| packages/agent-runtime/src/process-str-replace.ts:320 | atomic edit grouping available via option. | Per-operation semantics, not release gate. |

Package environment variables for parser budgets, WASM location, credentials, CI, binary identification and model keys are configuration/availability, not feature flags. Runtime state and safety checks (strict read-before-edit, permissions, aborts, plans and invalid arguments) are not grounds for blanket activation. Some options above may also be exposed via SDK or tool schemas; traces describe observed runtime contract, not public reachability guarantees. No source was changed.

