# SPEC — Language-fit audit (2026-09-28)

## Question
For every existing subsystem and every roadmap requirement (polyglot-roadmap-v2 R-A..R-G): is the current/planned language the best implementation? If not, what is the best language, what does it unlock now, and what further features does that move unlock?

## Inputs
- Codebase snapshot: inspect_codebase_structure 49801b44e84d3d8fa583c3ebd9b2855228bf122572b7cdf5f78c77b3389d824d
- Plan: .agents/sessions/polyglot-roadmap-v2/SPEC.md, PLAN.md
- Prior: .agents/sessions/polyglot-reaudit-2026-09-28/AUDIT-REPORT.md
- Provisional proposals under test: SPEC.md D38–D46 (PROPOSED)

## Per-feature rubric (every row)
1. Feature + files (file:line evidence)
2. Current/planned language + mechanism (in-process TS, sidecar, napi, WASM, consumed binary, native client)
3. Needs: latency/throughput, memory, isolation/crash containment, OS APIs, concurrency, determinism, distribution/footprint
4. Ecosystem fit: best-in-class library per candidate language (TS, Rust, Go, Python, Zig, C/C++, Swift/Kotlin, other)
5. Verdict: KEEP (TS best) / MOVE→<lang> / CONSUME (use upstream binary/lib) / HYBRID
6. Unlocks now; unlocks next (downstream features enabled)
7. Cost: toolchain, CI, release artifacts, boundary overhead, migration size
8. Confidence + unverified claims needing web check

## Shards
Codebase: sdk-core, sdk-tools, sdk-services, rt-loop, rt-edits, rt-util, codemap-indexer, cli-tui, cli-services, common, agents, evals, infra-scripts.
Plan: plan-RA, plan-RB, plan-RC, plan-RD, plan-RE, plan-RFG.
Web: verification researchers over the claims list.

## Output
findings/<shard>.md (write_audit_findings) → LANGUAGE-FIT-REPORT.md: per-feature table, portfolio decision, unlock graph, revisions to D38–D46.
