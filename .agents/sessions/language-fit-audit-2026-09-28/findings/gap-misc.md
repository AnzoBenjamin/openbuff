# Audit findings: gap-misc

- Subsystems: packages, scripts, test, agents-graveyard, docs, openbuff.d.example, ., common
- Features: openai-compatible-fork, openrouter-ai-sdk-fork, build-tools-infisical, root-build-config, scm-test-loader, dev-services-scripts, check-env-architecture, generate-ci-env, saxy, xml-parser, job-registry, tool-param-repair, edit-blocks, partial-json-delta, agent-validation, agents-graveyard, architecture-docs, openbuff-d-example, internal-knowledge-md
- Files covered: 31
- Snapshot: 49801b44e84d3d8fa583c3ebd9b2855228bf122572b7cdf5f78c77b3389d824d

## [MEDIUM] dependency-hygiene — packages/internal/src/openai-compatible/chat/openai-compatible-chat-language-model.ts:700 — openai-compatible fork: KEEP as a thin patched fork (TS), rebase against upstream; do not CONSUME wholesale yet
- **Risk:** The fork carries load-bearing behavior that upstream @ai-sdk/openai-compatible lacks. It merges phantom tool-call continuations with empty names (~L700-760). It emits finish and terminate on finish_reason=tool-calls for providers that never send [DONE] (~L870). It ignores `data: null` heartbeats and billing.summary chunks, generates ids for GLM tool calls, and adds stringifyTextContent. Swapping to upstream would regress every provider in openbuff.d.example/providers.json. Keeping it has a cost: version.ts reports '0.0.0-test' unless a build define is present, so the User-Agent `ai-sdk/openai-compatible/<ver>` is wrong in dev. The fork is also pinned to the V2 spec (`@ai-sdk/provider ^2`, `ai ^5` in packages/internal/package.json), which blocks upgrading to AI SDK v6/V3 without redoing the fork.
- **Fix:** Verdict HYBRID. Keep it in TS; it is TransformStream/SSE glue bound to the AI SDK LanguageModelV2 contract, and Rust would gain nothing. Cut the fork down to the diff: depend on upstream @ai-sdk/openai-compatible for the provider factory, embedding, image, and completion models. Keep only the patched chat model, or move the patches to a fetch/stream middleware wrapped around upstream's chat model. Keep a PATCHES.md listing each deviation with its test. Unlocks now: roughly 20 fewer vendored files and upstream bugfixes. Unlocks later: a mechanical AI SDK v6 upgrade. Cost: 2-4 days. Confidence: medium-high.
- **Evidence:** sdk/src/impl/model-provider.ts:23 and sdk/src/impl/embeddings.ts:13 import @codebuff/internal/openai-compatible/index. The chat model patch comments are at the phantom tool-call block ('Some OpenAI-compatible providers (e.g. certain Bedrock proxies)...') and the 'keep the SSE connection open instead of closing with [DONE]' block. version.ts:1-5 falls back to '0.0.0-test'. scripts/fat-sdk-openrouter-example.ts:6 already imports upstream '@ai-sdk/openai-compatible', so both are already in the tree.

## [MEDIUM] dependency-hygiene — packages/internal/src/openrouter-ai-sdk/provider.ts:97 — openrouter-ai-sdk fork: runtime is effectively unused; keep only types or CONSUME @openrouter/ai-sdk-provider
- **Risk:** The only production imports are the TYPE OpenRouterProviderOptions (sdk/src/impl/llm.ts:64, packages/agent-runtime/src/prompt-agent-stream.ts:15). createOpenRouter and OpenRouterChatLanguageModel are referenced only by their own tests and facade.ts. OpenRouter is configured as type 'openai-compatible' in openbuff.d.example/providers.json, so it runs through the other fork. That leaves about 25 files of dead vendored runtime and tests, including a strict-throwing tool-call parser (chat/index.ts ~L640-665 throws on a missing id or name) that diverges from the hardened openai-compatible path.
- **Fix:** Verdict DELETE the runtime and keep the type. Move OpenRouterProviderOptions (reasoning/provider routing shapes) into common/src/types, or import the type from upstream @openrouter/ai-sdk-provider as a dev/type-only dependency. Delete chat/, completion/, facade.ts, provider.ts, and their tests. Unlocks now: a smaller packages/internal and one less divergent SSE parser to maintain. Unlocks later: a native OpenRouter provider can be added by consuming upstream if OpenRouter-only features (reasoning_details, usage.cost) are needed. Cost: under 1 day. Confidence: high.
- **Evidence:** code_search '@codebuff/internal/openrouter-ai-sdk' non-eval hits: sdk/src/impl/llm.ts:64 (import type), packages/agent-runtime/src/prompt-agent-stream.ts:15 (import type). referencedBy for createOpenRouter lists only openrouter-ai-sdk tests. providers.json has an 'openrouter' entry with type 'openai-compatible'.

## [LOW] dependency-hygiene — packages/build-tools/executors/infisical-run/executor.ts:22 — build-tools Nx infisical executor is orphaned in a Bun-workspaces repo
- **Risk:** The executor depends on @nx/devkit (package.json:12, which pulls the whole nx native binary set into bun.lock), but the repo has no nx dependency and no root nx config referencing 'infisical-run'. Its only consumer is its own executors.json. The BYOK/local architecture (docs/architecture.md) does not use Infisical at runtime.
- **Fix:** Verdict DELETE the packages/build-tools workspace, or, if Infisical is still wanted for maintainers, replace it with a 10-line `infisical run -- ...` note in a bun script. Unlocks now: @nx/* is dropped from the lockfile, install gets faster, and there is one less workspace to typecheck. Cost: under 1 hour. Confidence: medium; scripts/init-worktree.ts still has syncInfisicalSecrets, and I did not verify whether it calls this package.
- **Evidence:** code_search 'infisical-run|@nx/' found only packages/build-tools/*, bun.lock, and eval fixtures. project.json build target only runs tsc. docs/architecture.md describes build-tools only vaguely as '(workspace-internal tooling)'.

## [MEDIUM] correctness — scripts/start-services.ts:106 — bun up/down/ps scripts call packages/internal db:start/db:studio scripts that no longer exist
- **Risk:** start-services.ts runs `bun --cwd packages/internal db:start` and `db:studio` (L106, L155), but packages/internal/package.json defines only `typecheck` and `test`. `bun up` therefore always fails at startDb and exits 1. stop-services.ts kills drizzle-kit processes that nothing starts. This is leftover hosted-backend (Postgres/Drizzle) scaffolding in a BYOK-only product.
- **Fix:** Verdict DELETE start/stop/status-services.ts and the up/down/ps root scripts (package.json:21-25), or cut them down to just the SDK build. dev.ts is fine to KEEP, though it hardcodes .bin/bun (L21). Everything stays TS/Bun; nothing here benefits from another language. Unlocks now: removes broken developer entry points. Cost: under 1 hour. Confidence: high.
- **Evidence:** packages/internal/package.json scripts: {typecheck, test}. start-services.ts:104-107 and :153-157 spawn db:start/db:studio. stop-services.ts:73 pkill drizzle-kit.

## [LOW] correctness — scripts/check-env-architecture.ts:518 — check-env-architecture scans a deleted web/ tree; generate-ci-env emits server env vars for a backend-less product
- **Risk:** The 'web: prevent Client Components...' block walks web/src, which the docs say was removed, so it is a silent no-op that suggests coverage it does not provide. It runs on every `bun typecheck` (package.json:28). generate-ci-env.ts:11 still derives CI secrets from @codebuff/internal/env-schema serverEnvVars, which keeps the internal env schema alive only for CI.
- **Fix:** Verdict KEEP both in TS; they are AST checks that use the TypeScript compiler API, so TS is the right language. Delete the web/ block, and add packages/agent-runtime to packageConfigs. Audit serverEnvVars to shrink it to the BYOK test keys. Cost: under 2 hours. Confidence: high.
- **Evidence:** check-env-architecture.ts web block uses path.join(cwd,'web','src'). docs/architecture.md:7 says hosted web surfaces were removed. generate-ci-env.ts:10-11 imports clientEnvVars/serverEnvVars.

## [LOW] dependency-hygiene — package.json:46 — Root build config: canvas/gif-encoder-2 as root runtime deps; TS 5.5.4 pinned alongside loose ranges
- **Risk:** canvas and gif-encoder-2 are root `dependencies` (L46-48) but are used only by scripts/tmux/tmux-viewer/gif-exporter.ts. canvas is a native node-gyp addon, so every contributor install pays that cost. Devdeps mix exact pins (typescript 5.5.4, lodash 4.17.23) with caret ranges (eslint 6 vs typescript-eslint 7, which is itself a mismatch). bunfig.toml and tsconfig.base.json are sound (hoisted linker, bundler resolution, strict).
- **Fix:** Verdict KEEP the config and move the deps. Put canvas/gif-encoder-2 into scripts/tmux/tmux-viewer/package.json and make that a workspace, or make them optional. Align @typescript-eslint/eslint-plugin with typescript-eslint. Adding Rust later needs a Cargo workspace root, and adding Python needs a uv/pyproject tree; neither conflicts with the Bun workspaces list. Cost: under 1 hour. Confidence: high.
- **Evidence:** package.json:45-49 dependencies. package.json:63 '@typescript-eslint/eslint-plugin: ^6.17' vs :78 'typescript-eslint: ^7.17.0'. tmux-viewer/package.json has no deps. bunfig.toml:3 linker=hoisted.

## [LOW] correctness — test/setup-scm-loader.ts:4 — Bun .scm text-loader preload: KEEP (Bun-specific, tiny)
- **Risk:** This is a global test preload (bunfig.toml:10) that is needed because code-map imports tree-sitter .scm query files as text. It is Bun-specific: if code-map's parsing moves to Rust (tree-sitter native), the .scm imports and this plugin become unnecessary.
- **Fix:** Verdict KEEP. If code-map moves to Rust, delete this file and the preload entry together with that move. Cost: none now. Confidence: high.
- **Evidence:** setup-scm-loader.ts:4-15 plugin onLoad filter /\.scm$/. bunfig.toml:10 preload list.

## [LOW] dependency-hygiene — common/src/util/saxy.ts:1 — saxy.ts (742 LOC) and partial-json-delta.ts have no production importers
- **Risk:** code_search found Saxy used only in common/src/util/__tests__/saxy.test.ts, and getPartialJsonDelta/parsePartialJsonObjectSingle used only in their own test. Streaming tool parsing now runs through packages/agent-runtime stream-xml-parser/tool-stream-parser, which call parseJsonStringWithRepair from tools/params/utils.ts. The dead code imports node:stream and string_decoder, which contradicts common's 'pure TS / any runtime' intent (job-registry.ts header).
- **Fix:** Verdict DELETE both, and their tests, after confirming with a repo-wide import check including cli/. Unlocks now: about 850 LOC less and a Node-builtin-free common. Cost: under 1 hour. Confidence: medium-high; I did not check whether tool-stream-parser.old.ts is itself dead.
- **Evidence:** code_search 'Saxy|getPartialJsonDelta|parsePartialJsonObjectSingle' -t ts found only saxy.ts, partial-json-delta.ts, and their __tests__. saxy.ts:4-5 imports node:stream and string_decoder.

## [LOW] api-contract — common/src/util/xml-parser.ts:8 — parseToolCallXml is a regex parser re-exported via packages/internal/src/utils/xml-parser.ts
- **Risk:** The non-greedy regex `<(\w+)>([\s\S]*?)<\/\1>` truncates values that contain the same nested tag, and it is a legacy XML tool-call format. Its only visible consumer is a re-export shim.
- **Fix:** Verdict DELETE if the internal re-export has no importers (I did not verify internal utils importers); otherwise KEEP in TS. Cost: minutes. Confidence: medium.
- **Evidence:** xml-parser.ts:12 tagPattern. packages/internal/src/utils/xml-parser.ts:2 re-export.

## [LOW] correctness — common/src/util/job-registry.ts:335 — job-registry: KEEP in TS; good design, minor id and clock nits
- **Risk:** This is an in-process state machine with a ring buffer, waiters, and async iterators. It is shared by the SDK and agent-runtime, so it has to live in the JS runtime; Rust would add IPC with no gain. Two nits. allocateJobId uses Math.random (L335) despite the determinism-guard effort. sweep() defaults to Date.now() (around L720) instead of the injected clock, so a test clock and the sweep disagree.
- **Fix:** Verdict KEEP. Use this.clock.now() in sweep, and inject an id source. Cost: under 1 hour. Confidence: high.
- **Evidence:** job-registry.ts allocateJobId uses Math.random().toString(16). sweep(now = Date.now()). Constructor stores this.clock = options.clock ?? realClock.

## [LOW] correctness — common/src/tools/params/utils.ts:60 — Tool-arg repair/truncation recovery and edit-blocks: KEEP in TS
- **Risk:** These run synchronously on every tool call inside Zod preprocess, so an FFI or process hop to Rust would cost more than the linear scans save. The 1 MiB bound (L60) and the 64-candidate cap already bound CPU. edit-blocks.ts has a documented CRLF divider mis-segmentation (EB-SEC-2, header) and is behind the default-off OPENBUFF_EDIT_BLOCKS flag, which is cached at first read.
- **Fix:** Verdict KEEP. Later, the same repair logic may be needed in a Rust harness; share it through golden fixture tests (JSON corpus) rather than porting it now. Confidence: high.
- **Evidence:** utils.ts:60 MAX_REPAIRABLE_JSON_LENGTH=1_048_576, MAX_TRUNCATION_RECOVERY_CANDIDATES=64. edit-blocks.ts:24-31 EB-SEC-2 note, :62-83 cached env flag.

## [LOW] api-contract — common/src/templates/agent-validation.ts:183 — agent-validation serializes handleSteps via Function.toString and checks only a 'function*' prefix
- **Risk:** This must be TS because agent definitions are JS modules. The generator check (isValidGeneratorFunction) is a string prefix test, so `async function*` and method-shorthand generators are rejected. It depends on zod-from-json-schema for input/output schemas. The only importer is sdk/src/impl/database.ts.
- **Fix:** Verdict KEEP in TS. Accept `async function*` if the runtime supports it, or document the restriction. Confidence: medium.
- **Evidence:** agent-validation.ts:183 template.handleSteps.toString(); isValidGeneratorFunction uses trimmed.startsWith('function*'). referencedBy: sdk/src/impl/database.ts.

## [LOW] dependency-hygiene — agents-graveyard — agents-graveyard is dead but still imported by evals/buffbench/eval-task-generator.ts
- **Risk:** It is ESLint-ignored (eslint.config.js:15) and has about 120 archived agent files. It is not dead-unreferenced: evals/buffbench/eval-task-generator.ts:8-9 imports file-explorer and find-all-referencer from it. Deleting the directory outright breaks that eval script at runtime. Test fixtures (agents/__tests__/data/run-state-context-overflow*.json) only mention the paths as data.
- **Fix:** Verdict DELETE after moving the two imported definitions into evals/buffbench/ (or deleting eval-task-generator if unused). Git history preserves the rest. Unlocks now: less index and search noise for query_index/code_search, and no untyped, unlinted TS in the tree. Cost: under 2 hours. Confidence: high.
- **Evidence:** code_search 'agents-graveyard': eval-task-generator.ts:8-9 imports; eslint.config.js:15 ignore; the remaining hits are eval JSON and test fixture data.

## [LOW] api-contract — docs/architecture.md:95 — Docs describe mechanisms mostly accurately but omit the vendored provider forks and stale internal knowledge.md
- **Risk:** architecture.md:95-97 says packages/internal holds 'provider wrappers', but not that they are forks of @ai-sdk/openai-compatible and the OpenRouter provider, or why. architecture.md:143 lists build-tools vaguely. The Postgres/Drizzle services path is undocumented and broken. packages/internal/src/knowledge.md describes Loops email, admin auth, and @t3-oss/env-nextjs, none of which exist in the current tree. The docs say nothing about the polyglot direction; 'TypeScript monorepo (Bun workspaces)' (L3) is accurate today. I did not read request-flow.md or local-mode.md in full; their OpenAI-compatible provider descriptions (request-flow.md:155, local-mode.md:121-168) match providers.json.
- **Fix:** Update architecture.md's internal section to name the forks, their patches, and the upgrade policy. Delete or rewrite packages/internal/src/knowledge.md. Once the Rust/Python pieces land, add a 'Languages' section. Confidence: high for architecture.md and knowledge.md, medium for the other two docs.
- **Evidence:** architecture.md:95-97 and :141-145. packages/internal/src/knowledge.md:9-27 (loops/, utils/auth.ts, env-nextjs).

## [MEDIUM] correctness — openbuff.d.example/providers.json — Example provider config embeds a real-looking GCP project id and duplicate provider entries
- **Risk:** The 'agent-platform' baseURL contains a concrete project path (projects/project-7a6f8b41-...), which leaks a maintainer's project identifier into a shipped example. 'agentrouter' and 'AGENT_ROUTER' duplicate the same endpoint and key env. Many third-party reseller endpoints are listed in an example that roster-drift.test.ts and check-doc-citations treat as canonical. routes.json sends every agent to agentrouter/gpt-5.5, which is a personal setup rather than a neutral example. hooks.json and indexing.json are fine, though indexing cacheDir still uses the legacy '.codebuff-index'.
- **Fix:** Verdict KEEP as JSON and scrub it. Replace the project id with <PROJECT_ID>, drop AGENT_ROUTER, and reduce the list to 3-4 well-known providers (openrouter, local Ollama, gemini, codex). Keep a neutral routes.json. Rename cacheDir to '.openbuff-index' if the code supports it. Confidence: high.
- **Evidence:** providers.json agent-platform.baseURL value; providers.json 'agentrouter' and 'AGENT_ROUTER' blocks; routes.json:2-67 all agentrouter/gpt-5.5; indexing.json:4 cacheDir '.codebuff-index'; agents/__tests__/roster-drift.test.ts:130 reads routes.json.

## Coverage receipt

### Subsystems
- packages
- scripts
- test
- agents-graveyard
- docs
- openbuff.d.example
- .
- common

### Features
- openai-compatible-fork
- openrouter-ai-sdk-fork
- build-tools-infisical
- root-build-config
- scm-test-loader
- dev-services-scripts
- check-env-architecture
- generate-ci-env
- saxy
- xml-parser
- job-registry
- tool-param-repair
- edit-blocks
- partial-json-delta
- agent-validation
- agents-graveyard
- architecture-docs
- openbuff-d-example
- internal-knowledge-md

### Files
- package.json
- bunfig.toml
- tsconfig.base.json
- common/src/util/saxy.ts
- common/src/util/xml-parser.ts
- common/src/util/job-registry.ts
- common/src/tools/params/utils.ts
- common/src/tools/params/edit-blocks.ts
- common/src/util/partial-json-delta.ts
- common/src/templates/agent-validation.ts
- docs/architecture.md
- packages/internal/src/openai-compatible/chat/openai-compatible-chat-language-model.ts
- packages/internal/src/openai-compatible/openai-compatible-provider.ts
- packages/internal/src/openai-compatible/version.ts
- packages/internal/src/openrouter-ai-sdk/chat/index.ts
- packages/internal/src/openrouter-ai-sdk/provider.ts
- packages/internal/package.json
- packages/internal/src/knowledge.md
- packages/build-tools/executors/infisical-run/executor.ts
- packages/build-tools/package.json
- packages/build-tools/project.json
- test/setup-scm-loader.ts
- scripts/dev.ts
- scripts/start-services.ts
- scripts/check-env-architecture.ts
- scripts/generate-ci-env.ts
- scripts/tmux/tmux-viewer/package.json
- openbuff.d.example/providers.json
- openbuff.d.example/routes.json
- openbuff.d.example/hooks.json
- openbuff.d.example/indexing.json

### Domains
- dependency-hygiene
- correctness
- api-contract
