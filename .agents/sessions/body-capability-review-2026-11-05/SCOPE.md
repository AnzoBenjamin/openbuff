# Review scope and coverage ledger

Started 2026-11-05, continuing 2026-11-06. User requested a large macro/micro capability review and replacement polyglot plan. Pinned source inventory: `ec141833a7efa94cd25b0e2c964fc2c832ce5983b2446c03769515032360deb0`, Git HEAD `e65c06c0ae783130998bd9ab18c8d35320e40ea8`, with the user's existing knowledge-file edits preserved.

This is a feature-oriented code review with bounded deep traces, broad search, selected existing suites, and targeted offline diagnostic probes. It does not claim every source line was audited, every provider API was exercised, or the maximum achievable model task quality was measured.

## Paired shard allocation

Every pair has an independent explorer acting as file-picker, then a general auditor that reads those files and writes structured findings. Three child slots limit concurrency; pairs run in successive bounded waves. The broad-audit classifier finds seven request domains; the minimum is seven pairs. Thirteen planned pairs exceed that minimum.

| Pair | Feature scope | Primary subsystem coverage | Status |
|---|---|---|---|
| 01 | CLI/TUI interaction, discovery, state and failure UX | cli, SDK consumer edges | paired audit completed; restored |
| 02 | BYOK/provider routing, stream/usage/error contracts | sdk, internal, common | paired audit completed; restored |
| 03 | Agent orchestration, supervision, budgets and completion | agents, runtime, common | paired audit completed; restored |
| 04 | Context, archives, compaction, memory and lessons | cli, sdk, runtime, common, evals | paired audit completed; restored |
| 05 | Durability, journals/resume, protocol sessions, leases | sdk, runtime, cli, scripts | paired audit completed; restored |
| 06 | Read/edit preconditions, bytes, mutations, semantic edits | sdk, runtime, common | paired audit completed; restored |
| 07 | Language registry/grammars, LSP/SCIP, diagnostics/build/test | code-map, sdk, common | paired audit completed; restored |
| 08 | Index/search/semantic graph freshness and scale | indexer, sdk, cli | paired audit completed; restored |
| 09 | Execution, permissions/secrets, jobs and Rust enforcement | sdk, runtime, common, rust | paired audit completed; restored |
| 10 | MCP/custom tools, hooks, agent/plugin isolation and local templates | sdk, runtime, common, .agents | paired audit completed; restored |
| 11 | Evaluations, learning/promotion, CI, performance, packaging | evals, scripts, .github, build-tools | paired audit completed; restored |
| 12 | Audit/control-plane quality, macro catalog, plan fidelity and docs | common, sdk, agents, docs, root examples | paired audit completed; restored |
| 13 | Browser/image/3D/computer interaction and optional perception | sdk, runtime, agents, cli | paired audit completed; restored |

All eight audit domains are considered by every auditor; a coverage receipt is a record of inspection, not a product readiness claim. Reports record read ranges, search surfaces, and unknowns. [Recovery provenance](AUDIT-RECOVERY-MANIFEST.json) distinguishes exact captures from reconstructed range metadata, and [source assurance](SOURCE-STABILITY.md) records the unavailable original whole-file map and fresh excerpt checks. The final [review validation](REVIEW-VALIDATION.json) reports current reconstructed coverage; historical coverage counts remain separately identified.

## Every top-level directory

| Directory | Disposition |
|---|---|
| .agents | source templates in pair 10; prior plan artifacts read by root/pair 12; previous session findings not treated as current evidence |
| .aws | out of scope: local credentials; not read |
| .bin | out of scope: local generated/helper executables; source owners are reviewed |
| .codebuff-index | retrieval cache used read-only; storage/maintenance implementations in pair 08 |
| .codex | out of scope: local agent configuration/runtime state |
| .commandcode | out of scope: local integration preferences, not shipped Openbuff code |
| .e2e-scratch | out of scope: disposable prior probe state; new probes isolated in /tmp |
| .git | read-only status/HEAD baseline; repository storage not audited |
| .github | pair 11 CI/release/validation contracts |
| .omx | out of scope: agent workflow state; final plan launcher may reference the new canonical plan |
| .openbuff | out of scope: existing local runtime data; persistence implementations and fresh fixtures in pairs 04/05 |
| .tmp | out of scope: temporary prior artifacts |
| .vscode | out of scope: contributor editor preferences |
| agents | pairs 03/10/12/13; shipped policy/agent consumers |
| agents-graveyard | out of scope: archived templates outside active workspaces; active template loading is reviewed |
| cli | pairs 01/04/05/08/13; generated mirrors checked through source and release gates |
| common | pairs 02/03/04/06/07/09/10/12; contracts and shared policies |
| debug | out of scope: prior logs (may contain private content); telemetry implementations reviewed |
| docs | root and pairs 07/11/12: claims checked against source; prior audit directories treated as historical context |
| e2e-traces | out of scope: historical raw run recordings; fresh probes persisted with this review |
| evals | pair 11 plus memory/retention checks in pair 04; large benchmark fixtures are data, not each line audited |
| node_modules | out of scope: vendored implementation; manifests/lockfiles/provenance and installed-asset behavior checked |
| openbuff.d.example | pair 12 config/feature documentation contract |
| packages | every active child package assigned: runtime 03/04/05/06/09/10, code-map 07, indexer 08, internal 02, build-tools 11 |
| rust | pair 09 native roles, Linux exec enforcement, packaging/supervision integration; tests cross-checked in pair 11 |
| scratch-logs | out of scope: historical logs; not read |
| scripts | pairs 05/11/12, including task validation and build/bench helpers |
| sdk | pairs 02/04/05/06/07/08/09/10/12/13; public/runtime entrypoints and adapters |
| test | pair 11 root test-loader/setup compatibility |
| web | out of scope: leftover local configuration, no active hosted product workspace (docs/architecture.md:7) |

Root public manifests, README/architecture/request-flow/testing/security docs, and configuration examples are reviewed. Private environment/provider values and old full logs are excluded.

## Verification to date

| Check | Result | Evidence |
|---|---|---|
| CLI `--help`, cached Bun 1.3.5 | exit 0, real entrypoint | evidence/cli-help.log |
| audit/control-plane/receipt suites | 28 pass / 0 fail | evidence/audit-tests.log |
| full indexer suites, Bun 1.3.5 + isolate | 413 pass / 0 fail | evidence/indexer-tests.log |
| code-map suite, Bun 1.3.5 | 154 pass / 4 fail | evidence/code-map-tests.log |
| isolated structure suite | 17 pass / 3 fail; confirms failure is not only cross-file contamination | evidence/code-map-structure-alone.log |
| unimplemented-feature completeness probe | heuristic complete -> verified complete -> coverage complete, despite unimplemented fixture | evidence/completeness-probe.{ts,json} |
| CLI behavioral probes | 8 current-behavior assertions pass, demonstrating defects | evidence/01-cli-probes.* |
| provider real AI SDK + injected SSE/HTTP probes | 9 current-behavior assertions pass, zero external requests | evidence/02-providers-probes.* |
| orchestration DI probes | 3 current-behavior assertions pass, zero provider requests | evidence/03-orchestration-probes.* |

Diagnostic probe passes assert the observed failure behavior; they are not green regressions proving the feature correct. No source fixes have been applied.
