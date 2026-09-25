# Harness Deep Audit — 2026-09 (fresh rediscovery)

<!-- current-task: Wave 1 — discovery -->

## Mandate
Audit EVERY part of the Openbuff harness from live source (no reliance on prior audit docs, stored memory, or git archaeology). For each part: verdict on whether it is the best possible implementation, what is missing, and what a best-in-class coding-agent harness should have that is absent. Read-only audit — no source mutations.

## Snapshot
- Structure snapshotId: 12dc472618eabdec247fe2e58e18591cb5ab85e13f6f8e9775b3beaaf6dd953d
- 24 top-level subsystems; in-scope code subsystems: agents, .agents, cli, common, packages/{agent-runtime,indexer,code-map,internal,build-tools}, sdk, evals, scripts, .github, docs, root configs, test/
- Out-of-scope (recorded, not silently dropped): agents-graveyard (archived experiments — verify excluded from build only), debug/, .omx/, .openbuff/, .codebuff-index/, .tmp/, scratch-logs/, node_modules, .git, *.log

## Shard plan (18 audit shards, 8-domain rubric + best-possible verdict + missing-capabilities per shard)
1. runtime-loop — agent-runtime main loop, stream parsing, llm-api, templates, system-prompt
2. tools-editing — deterministic edit pipeline (str_replace/edit_transaction/replace_range/rewrite_symbol/write_file, preflight, application coordinator)
3. tools-orchestration — spawn-agents family, tool-executor, plan/todo/decision/handoff tools, orchestration/*, subgoal/end-turn/skill/ask-user
4. tools-io-jobs — terminal/jobs/discovery/filesystem handlers, web/docs/image/3d/browser tools, audit tools
5. context-engine — pruning, budget, archive, consolidation, token counting, eviction, semantic compaction
6. runtime-state — messages, plan-execution-state, orchestration-ledger, workspace-path-leases, read-authorization, project-path-policy, warn-latch, budgets
7. sdk-core — client/run/run-state/provider-config/credentials/impl (llm, failover, model-provider), agents/skills loading
8. sdk-mutation — sdk tools + mutation broker/journal/filesystem-authority/terminal-policy/hooks/validation services
9. memory-v2 — cli + sdk memory-v2 services, types, migration, scoring
10. common — tool schemas/params, types, util, constants, templates, mcp client
11. indexer-codemap — packages/indexer, packages/code-map
12. internal-providers — packages/internal openai-compatible + openrouter-ai-sdk
13. agents-defs — agents/ definitions, base2 family + gate modules, specialists, guides/patterns/idioms, agents tests, .agents/
14. cli-app — cli app/chat/hooks/state/types/core utils
15. cli-ui — components, tool renderers, commands, services (non-memory), init/native/pre-init
16. evals-ci-scripts — evals, scripts, .github workflows, root configs
17. security-crosscut — cross-package security sweep of highest-risk files
18. docs-contracts — docs vs implementation contracts, README/knowledge, openbuff.d.example, graveyard build-exclusion verification

## Tasks
- [~] Wave 0: scope + session bootstrap
- [ ] Wave 1: 8 discovery file-pickers (entry points, per-area risk list)
- [ ] Wave 2: audit shards 1–8 (write_audit_findings to session)
- [ ] Wave 3: audit shards 9–16
- [ ] Wave 4: audit shards 17–18 + feature-completeness probes (inspect_feature_completeness on ~10 flagship features)
- [ ] Coverage machine-check (evaluate_audit_coverage) + subsystem enumeration guard
- [ ] Synthesis (synthesizer → AUDIT-REPORT.md)
- [ ] Best-possible gap analysis (thinker/architect on synthesized findings + missing-capability lists)
- [ ] Final user report

## Constraints
- No check_job / check_background_agent / background spawns (user directive: those are broken).
- No git-history archaeology; judge current tree only.
- No stored-memory reuse; all conclusions from fresh reads in this session.
- Each shard: write findings via write_audit_findings (sessionSlug harness-deep-audit-2026-09), fallback: create findings/<shard>.md directly. Parent receives receipts only.
