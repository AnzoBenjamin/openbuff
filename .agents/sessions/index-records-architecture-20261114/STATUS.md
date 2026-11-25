# Scope and coverage

Implementation follow-up: the approved redesign is implemented and installed. See [IMPLEMENTATION.md](IMPLEMENTATION.md) for final validation, deployment and measured limits. The original audit/recommendation below is retained as historical evidence.

Review date: 2026-11-14. Objective: explain weak cross-session repository reuse and role-inappropriate procedural context, and recommend the strongest local-first implementation architecture. This is a scoped architectural review, not a whole-repository defect audit or an implemented overhaul.

The current runtime's `query_index`, structural inventory, feature-receipt, and audit-coverage tools are unavailable in this Codex tool surface. Source discovery used `rg`/filesystem reads and five bounded discovery/auditor pairs. Findings are durable Markdown reports; no native structural receipt or formal runtime coverage attestation is claimed.

## Coverage matrix

| Domain                                                                  | Discovery lane      | Audit lane/report                                          | Coverage                     |
| ----------------------------------------------------------------------- | ------------------- | ---------------------------------------------------------- | ---------------------------- |
| Index storage, reconciliation, ranking, CLI index lifecycle             | discover_index      | audit_index / [index.md](findings/index.md)                | Complete within stated scope |
| Parsing, structural inventory, graph precision and reuse                | discover_codemap    | audit_codemap / [code-map.md](findings/code-map.md)        | Complete within stated scope |
| Playbook scope, prompt delivery, gates, evidence, lifecycle             | discover_books      | audit_books / [books.md](findings/books.md)                | Complete within stated scope |
| Fresh-session and child context, memory injection, reuse tests          | discover_cold_start | audit_cold_start / [cold-start.md](findings/cold-start.md) | Complete within stated scope |
| Canonical records, query projections, validity, consolidation, archives | discover_records    | audit_records / [records.md](findings/records.md)          | Complete within stated scope |

Each audit lane covers security, correctness, state mutation, error handling, performance, dependency hygiene, test coverage, and API/ABI contracts within its assigned surface. Their reports enumerate inspected files, evidence/inference distinctions, and unknowns. All findings were inspected before synthesis; no source-performance or model-cost improvement is claimed from source inspection alone.

## Top-level subsystem enumeration

| Directory                                    | Disposition                                                                                                                                                                   |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| agents                                       | In scope: base2/general-agent bootstrap, editor/committer contracts, relevant tests. Other specialist implementations out of scope.                                           |
| cli                                          | In scope: index lifecycle, memory backend/provider/archive, run composition and related tests. Unrelated TUI/product features out of scope.                                   |
| sdk                                          | In scope: session construction, source discovery, memory coordinator, operator/record contracts and structural inventory. Unrelated provider/connector features out of scope. |
| packages/agent-runtime                       | In scope: child construction, memory/policy context, procedural gate/evidence and structural read consumers. Other execution/tool features out of scope.                      |
| packages/indexer                             | In scope: index persistence, reconciliation, querying, precise graph layers and representative evaluations/tests.                                                             |
| packages/code-map                            | In scope: parser/structural contracts, reuse, graph consumers and representative tests.                                                                                       |
| packages/build-tools                         | Out of scope: unrelated packaging infrastructure.                                                                                                                             |
| packages/internal                            | Out of scope: unrelated provider/internal utilities.                                                                                                                          |
| common                                       | In scope: memory/playbook/source contracts and lifecycle/identity helpers. Unrelated utilities out of scope.                                                                  |
| docs                                         | In scope: architecture/request-flow/local mode, relevant historical indexing findings and memory migration requirements. Other documentation out of scope.                    |
| evals                                        | In scope: sharding guidance and retrieval/reuse evaluation surfaces. Unrelated model/product evaluations out of scope.                                                        |
| rust                                         | Limited inspection: existing native boundaries/manifests establish that a Rust memory service would be new work. Execution harness implementation out of scope.               |
| scripts                                      | Relevant startup/warming/structural-renderer documentation examined; unrelated tooling out of scope.                                                                          |
| .agents                                      | In scope: supplied instructions, applicable meta skill, and this review's findings/recommendation. Existing unrelated session artifacts out of scope.                         |
| .openbuff                                    | In scope: read-only local memory SQLite schema/counts/storage accounting. Other local state out of scope.                                                                     |
| .codebuff-index                              | In scope: read-only saved metadata size/count and parse/query-data presence. No cache changed.                                                                                |
| agents-graveyard                             | Out of scope: archived agent implementations.                                                                                                                                 |
| debug                                        | Out of scope: general logs; no live provider trace needed for source/probe findings.                                                                                          |
| e2e-traces                                   | Out of scope: unrelated trace archives.                                                                                                                                       |
| node_modules                                 | Out of scope: installed dependency bodies; relevant package manifests were examined.                                                                                          |
| openbuff.d.example                           | Out of scope: unrelated example deployment/configuration.                                                                                                                     |
| scratch-logs                                 | Out of scope: unrelated scratch captures.                                                                                                                                     |
| test                                         | Out of scope: unrelated top-level test assets; relevant colocated tests inspected.                                                                                            |
| web                                          | Out of scope: website/hosted application features.                                                                                                                            |
| .git and other local tool/config directories | Out of scope: unrelated metadata; working-tree state inspected to preserve prior work.                                                                                        |

## Verification and limits

- Pure/runtime hermetic probes establish scope leakage, procedure clipping, command-text evidence mismatch, verified-rule disappearance, child factual/procedural asymmetry, and precise-edge loss on unchanged refresh.
- Records lane probes establish old anchor exclusion beyond query admission and unrelated-revision invalidation while content remains unchanged.
- Local SQLite was opened read-only with query-only enabled. Measurements expose counts/schema/storage sizes, not transcript payloads or credentials.
- Current code-index JSON was read without modification. Both parse summaries and query accelerators were present.
- Recommendation received an independent critique for user instruction precedence, permission burdens, stale knowledge, dependency uncertainty, and unmeasured Rust claims; material clarifications were incorporated.
- Product source and installed binaries are unchanged by this architectural review. Previous session repairs and unrelated dirty files were preserved.
- Live paired-conversation reuse, latency, token savings, and backend comparison remain measurement work; proposed acceptance criteria specify those tests.
