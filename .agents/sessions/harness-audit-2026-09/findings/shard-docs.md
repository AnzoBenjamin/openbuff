# Audit findings: shard-docs

- Subsystems: docs-pages, readme-agents-md-security-md, contributing-md, knowledge-files, package-graph-manifests, env-schema-and-env-docs, tool-registry-list-ts, agent-selection-main-prompt, gate-state-and-aux-gates, slash-command-registry, ci-local-tooling
- Features: docs-accuracy-verification, knowledge-file-audit, env-var-documentation, gate-semantics-documentation, tool-registry-documentation, package-graph-documentation
- Files covered: 50
- Snapshot: df9b2f192f10abc4503dfdc5a5a30643b0fd9ca84ef8d8cf5cd8988d93669cc1

## [MEDIUM] api-contract — docs/architecture.md:265 — architecture.md claims @openbuff/cli (v0.1.0) is published; the workspace CLI is private @codebuff/cli v1.0.0
- **Risk:** Contributors and release-tooling readers are told an npm package @openbuff/cli v0.1.0 exists and is published; the workspace package is actually named @codebuff/cli, marked private, at version 1.0.0, exposing only a local bin `openbuff`. Anyone wiring installs, release automation, or version bumps from this doc targets a package that is never published, and the documented version is already wrong.
- **Fix:** Correct the sentence to state the CLI ships only as the local `openbuff` bin from the private @codebuff/cli workspace package, or actually publish @openbuff/cli and keep the version in the doc in sync. Best: derive this closing line from the two package.json files at build time.
- **Evidence:** docs/architecture.md:265 "Only `@openbuff/cli` (v0.1.0) and `@openbuff/sdk` (v0.11.0) are published" vs cli/package.json:2-4 "name: @codebuff/cli, version: 1.0.0, private: true" and :7-8 bin openbuff->./bin/openbuff; sdk/package.json:2-4 confirms @openbuff/sdk 0.11.0 is the one real published package.

## [LOW] api-contract — docs/architecture.md:129 — Package dependency lists in architecture.md understate real dependencies (indexer, agent-runtime, evals)
- **Risk:** Readers reasoning about layering or pruning dependencies will miss real workspace edges: @codebuff/indexer also depends on @codebuff/common, @codebuff/agent-runtime depends on @codebuff/common (docs list only code-map), and evals additionally depends on @codebuff/agent-runtime plus several third-party packages. Layering decisions based on the doc can silently drop needed edges.
- **Fix:** Regenerate the per-package Depends-on bullets from each package.json dependencies block (small script or CI check), or minimally add @codebuff/common to the indexer and agent-runtime entries and agent-runtime + third-party deps to the evals entry.
- **Evidence:** docs/architecture.md:129 "Depends on: code-map (@codebuff/code-map), ignore" vs packages/indexer/package.json:28-32 listing @codebuff/code-map + @codebuff/common + ignore; docs/architecture.md:68 vs packages/agent-runtime/package.json:33-39; docs/architecture.md:151 vs evals/package.json:33-44.

## [LOW] api-contract — docs/agents-and-tools.md:19 — docs/agents-and-tools.md says context-pruner is 'not publicly spawnable' while base2 lists it first in spawnableAgents
- **Risk:** Agent authors copying the documented pattern will omit context-pruner from spawnableAgents; base2.ts's own comment says the entry is required for derived orchestrator IDs (base2-execute-plan) to receive the inline pruner spawn, so following the doc breaks the compaction loop for derived agents.
- **Fix:** Reword to match base2.ts: context-pruner must stay declared in spawnableAgents because handleSteps spawns it via spawn_agent_inline on every loop; the accurate nuance is that it is not a phase-delegated specialist, not that it is unlisted.
- **Evidence:** docs/agents-and-tools.md:19 "`context-pruner` is runtime-internal and is not publicly spawnable" vs agents/base2/base2.ts:504-509: spawnableAgents: buildArray( ... 'context-pruner', ... with the comment "handleSteps invokes this automatically through spawn_agent_inline on every loop. It must still be declared for derived IDs such as base2-execute-plan".

## [LOW] api-contract — docs/agents-and-tools.md:75 — code_search maxResults documented as a kept 30 backstop, but the tool schema default is 15
- **Risk:** Agents and SDK consumers tuning search budgets from the doc expect a 30-result default; the tool schema defaults to 15 and its own description says 'Defaults to 15', so documented and enforced budgets disagree and searches return half the documented volume by default.
- **Fix:** Align the doc with the schema default (15) or raise the schema default to 30; if 30 refers to a distinct runtime cap, name that cap explicitly. A doc-parity check for documented tool defaults would prevent recurrence.
- **Evidence:** docs/agents-and-tools.md:75 "`code_search` `maxResults` 30" vs common/src/tools/params/tool/code-search.ts:38 ".default(15)" and :40 "Maximum number of results to return per file. Defaults to 15."

## [LOW] api-contract — docs/architecture.md:141 — .agents/ inventory names an openbuff-local-cli template and cleanup/review skills that do not exist
- **Risk:** Developers extending .agents/ will look for the openbuff-local-cli template and the cleanup/review skills to copy and find neither; the actual CLI-template id is codebuff-local-cli (a legacy brand name the BYOK-purge docs elsewhere say to avoid), and .agents/skills/ contains only meta/.
- **Fix:** Update the bullet to the real set (claude-code-cli, codex-cli, gemini-cli, codebuff-local-cli; skills: meta), rename the template id if the legacy name is unwanted, or add the missing skills.
- **Evidence:** docs/architecture.md:141 "CLI agent templates (claude-code-cli, codex-cli, gemini-cli, openbuff-local-cli)" and :143 "Skills (cleanup, meta, review)" vs .agents/codebuff-local-cli.ts:6 "id: 'codebuff-local-cli'" and .agents/skills/ containing only meta/SKILL.md.

## [LOW] api-contract — docs/environment-variables.md:8 — IPINFO_TOKEN called legacy-only in the env docs while packages/internal env schema still hard-requires it
- **Risk:** A contributor validating serverEnvSchema or wiring a new integration on it fails on a missing IPINFO_TOKEN even though the docs say local/BYOK usage does not require it; doc and schema disagree about whether the variable is still load-bearing.
- **Fix:** Make IPINFO_TOKEN optional in packages/internal/src/env-schema.ts to match the doc, or annotate the doc entry that the legacy schema still declares it required.
- **Evidence:** docs/environment-variables.md:8 "`IPINFO_TOKEN` is only relevant to legacy/upstream hosted flows. Openbuff local/BYOK CLI usage does not require it" vs packages/internal/src/env-schema.ts:34 "IPINFO_TOKEN: z.string().min(1)" (non-optional member of serverEnvSchema).

## [LOW] api-contract — docs/configuration.md:44 — configuration.md says 'This repo uses this pattern' for openbuff.json/openbuff.d/, but only .example variants are tracked
- **Risk:** A fresh clone has no openbuff.json or openbuff.d/ to inspect; the fragmented-config layout the doc presents as committed exists only as openbuff.json.example and openbuff.d.example/. Developers copying 'the repo's' hooks/routes start from an example and may not realize live config files are untracked.
- **Fix:** Reword to 'this repo's tracked example (openbuff.json.example + openbuff.d.example/) mirrors the pattern; live openbuff.json / openbuff.d/ are untracked local config'.
- **Evidence:** docs/configuration.md:44-51 "This repo uses this pattern: openbuff.json # root (minimal / pointer) / openbuff.d/ providers.json routes.json indexing.json hooks.json" vs glob 'openbuff*' resolving only openbuff.json.example, with openbuff.d.example/ holding routes.json, indexing.json, hooks.json, providers.json.

## [LOW] api-contract — AGENTS.md:43 — AGENTS.md docs index describes development.md as covering 'DB migrations', which the page does not contain
- **Risk:** Contributors land on docs/development.md expecting a database-migration workflow and find none; the stale index description erodes trust in the AGENTS.md doc map exactly where agents are instructed to always read docs before implementing changes.
- **Fix:** Drop 'DB migrations' from AGENTS.md:43, or add the migrations section if one should exist post-BYOK-purge.
- **Evidence:** AGENTS.md:43 "docs/development.md — Dev setup, worktrees, logs, package management, DB migrations" vs docs/development.md:1-110 (sections: Getting Started, Optional Local Integration Services, Package Management, Running Tests, CI-local / pre-push checks, tree-sitter release assets, CLI Command References).

## [LOW] api-contract — README.md:198 — README and CONTRIBUTING present a CLI-only test command as the project test suite
- **Risk:** New contributors follow README.md's `cd cli && bun test` and validate only the CLI package while believing they ran the suite; the root `bun test` script runs the eight workspace test suites, so PRs can pass on the README's command while breaking other packages. CONTRIBUTING.md's 'bun test # Run all tests' describes root behavior without saying root is required.
- **Fix:** Point README.md and CONTRIBUTING.md at root `bun test` first (the actual workspace suite) and keep the per-package command as a secondary note.
- **Evidence:** README.md:198-206 "### Running Tests ... cd cli / bun test" and CONTRIBUTING.md:135-138 "bun test # Run all tests" vs package.json:26 "test": "bun --filter='{@codebuff/common,...,@codebuff/cli,@codebuff/evals,@codebuff/scripts}' run test" and docs/development.md:57-62 documenting the same cd-cli form.

## [LOW] test-coverage — docs/request-flow.md:217 — Documented consumer contract (dependency-manager set_output schemaVersion 2) cites no regression test, and doc-numeric claims have no parity pin
- **Risk:** The doc promises exact v2 semantics (deletedCreatedFiles only lists applied deletes; undeletedCreatedFiles carries refused/unauthorized deletes; non-empty undeleted forces status incomplete + rollbackRequired) for an external spawner-facing payload, but no test is cited and a v2 field-split pin was not verified; a refactor could silently break the published contract. Relatedly, doc-numeric claims (code_search maxResults 30 vs schema default 15) drift because no test pins documented defaults to schemas.
- **Fix:** Add a test pinning the v2 dependency-manager receipt split and the envelope/receipt schemaVersion lockstep, then cite it in docs/request-flow.md as sibling sections do. Consider a doc-parity test for documented tool defaults (maxResults, caps) so numeric claims cannot drift from schemas.
- **Evidence:** docs/request-flow.md:217-245 defines the v2 contract ("deletedCreatedFiles now lists only the lockfile deletes whose edit_transaction delete actually applied", "A non-empty undeletedCreatedFiles forces rollbackReceipt.status incomplete and rollbackRequired: true") and cites no test, vs docs/agents-and-tools.md gate sections citing agents/e2e/gate-lifecycle.e2e.test.ts and agents/e2e/reviewer-spawn-conditions.e2e.test.ts (both verified present); agents/__tests__/dependency-manager.test.ts exists but its v2 field-split pin was not verified in this shard.

## [LOW] api-contract — knowledge.md:5 — Root knowledge.md is unfilled template boilerplate; evals knowledge file is a 6-line note beside stale script references
- **Risk:** The file agents read first for project context (Quickstart/Architecture/Conventions) is entirely empty placeholders, so root-level knowledge retrieval yields nothing. evals/knowledge.md coexists with evals package scripts referencing a git-evals/ layout that does not exist (the runners live in evals/buffbench/), so onboarding guidance and scripts disagree about the package layout.
- **Fix:** Fill or replace root knowledge.md with a pointer to AGENTS.md (the pattern docs/goal.md already uses), and refresh evals knowledge/scripts to the buffbench/ layout.
- **Evidence:** knowledge.md:5-21 ("## Quickstart / - Setup: / - Dev: / - Test:" ... "- Key directories: / - Data flow:" all empty) vs docs/goal.md:1-6 which already delegates to AGENTS.md and docs/architecture.md; evals/knowledge.md:1-6 vs evals/package.json:17-23 scripts pointing at git-evals/gen-repo-eval.ts, git-evals/eval-manifold.json, manifold.test.ts while the evals tree shows evals/buffbench/ (main.ts, run-buffbench.ts, eval-manifold.json) and no git-evals/ directory.

## Coverage receipt

### Subsystems
- docs-pages
- readme-agents-md-security-md
- contributing-md
- knowledge-files
- package-graph-manifests
- env-schema-and-env-docs
- tool-registry-list-ts
- agent-selection-main-prompt
- gate-state-and-aux-gates
- slash-command-registry
- ci-local-tooling

### Features
- docs-accuracy-verification
- knowledge-file-audit
- env-var-documentation
- gate-semantics-documentation
- tool-registry-documentation
- package-graph-documentation

### Files
- docs/architecture.md
- docs/request-flow.md
- docs/agents-and-tools.md
- docs/local-mode.md
- docs/deterministic-edit-system.md
- docs/environment-variables.md
- docs/development.md
- docs/testing.md
- docs/configuration.md
- docs/getting-started.md
- docs/authentication.md
- docs/README.md
- docs/goal.md
- README.md
- AGENTS.md
- SECURITY.md
- CONTRIBUTING.md
- knowledge.md
- cli/knowledge.md
- common/knowledge.md
- .github/knowledge.md
- evals/knowledge.md
- cli/package.json
- sdk/package.json
- common/package.json
- packages/indexer/package.json
- packages/code-map/package.json
- packages/agent-runtime/package.json
- evals/package.json
- scripts/package.json
- package.json
- common/src/tools/list.ts
- common/src/env-schema.ts
- common/src/constants/chatgpt-oauth.ts
- common/src/constants/agents.ts
- common/src/util/analytics-sampling.ts
- packages/internal/src/env-schema.ts
- packages/agent-runtime/src/main-prompt.ts
- agents/base2/gate-state.ts
- agents/base2/base2.ts
- agents/base2/gate-fingerprint.ts
- sdk/src/env.ts
- sdk/src/tools/run-terminal-command.ts
- sdk/src/provider-config.ts
- cli/scripts/release.ts
- scripts/check-ci-local.ts
- cli/src/data/slash-commands.ts
- openbuff.d.example/providers.json
- .agents/codebuff-local-cli.ts
- .agents/skills

### Domains
- api-contract
- test-coverage
