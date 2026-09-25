# Harness deep audit — STATUS

- Session slug: `harness-audit-2026-09-22`
- Structural snapshot: `1c40013c1c36bb39f4bf465efc2b88158b0364582859da0692ee012a6f3aff0c`
- Fresh evidence only: no prior audit artifacts and no stored memory were consulted.
- Scope question per feature: is the current implementation the BEST POSSIBLE implementation
  of that feature? If not: what is missing, what to do. Plus: what a best-possible harness
  should have that is entirely absent here.

# Coverage matrix

| Shard | Subsystem | Domains | structuralReceipt | Covered |
|-------|-----------|---------|-------------------|---------|
| shard-runtime-loop | packages/agent-runtime (loop/streaming/LLM API) | all 8 | (pending) | NO |
| shard-tools-edit | packages/agent-runtime (tool dispatch/deterministic edits) | all 8 | (pending) | NO |
| shard-spawn-subagents | packages/agent-runtime + common (spawn/handoffs/templates) | all 8 | (pending) | NO |
| shard-memory-context | memory/context (runtime + cli + sdk + pruner) | all 8 | (pending) | NO |
| shard-gate-review | agents/base2 + orchestration (gate/reviewer) | all 8 | (pending) | NO |
| shard-sdk-core | sdk (client/provider routing/failover) | all 8 | (pending) | NO |
| shard-sdk-tool-exec | sdk (tool execution/filesystem authority) | all 8 | (pending) | NO |
| shard-jobs-ipc | jobs/IPC (sdk + runtime + common) | all 8 | (pending) | NO |
| shard-cli-tui | cli | all 8 | (pending) | NO |
| shard-common-contracts | common | all 8 | (pending) | NO |
| shard-indexing-retrieval | packages/indexer + code-map + internal | all 8 | (pending) | NO |
| shard-agent-roster | agents (roster/guides + graveyard isolation) | all 8 | (pending) | NO |
| shard-templates-evals | .agents + evals | all 8 | (pending) | NO |
| shard-tooling-ci | scripts + .github + docs + config | all 8 | (pending) | NO |

# Subsystem enumeration

| Top-level | Disposition |
|-----------|-------------|
| packages | audited (S1-S4, S11) |
| sdk | audited (S6-S8) |
| cli | audited (S9) |
| common | audited (S10) |
| agents | audited (S5, S12) |
| agents-graveyard | audited (S12 isolation check: must not be loaded/registered/shipped) |
| .agents | audited (S13) |
| evals | audited (S13) |
| scripts | audited (S14) |
| docs | audited (S14) |
| .github | audited (S14) |
| openbuff.d.example | audited (S14) |
| test | audited (S14) |
| web | out-of-scope (verification pending) |
| e2e-traces | out-of-scope (verification pending) |
| debug | out-of-scope (debug logs and trace dumps, not harness code) |
| scratch-logs | out-of-scope (scratch logs) |
| .omx | out-of-scope (third-party tool state) |
| .openbuff | out-of-scope (runtime memory/state data) |
| .codebuff-index | out-of-scope (generated index) |
| .tmp | out-of-scope (temp files) |
| .bin | out-of-scope (bundled bun binary) |
| .vscode | out-of-scope (editor config) |
| .claude | out-of-scope (third-party tool config) |
| .commandcode | out-of-scope (third-party tool docs) |
| .sisyphus | out-of-scope (third-party tool state) |
| .git | out-of-scope (VCS internals) |
| node_modules | out-of-scope (dependencies) |
