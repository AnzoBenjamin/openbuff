# Plan design review — are the specified solutions still the best ones?

2026-10-24. Scope: the LIVE plans after the reconciliation/retirement waves.
Question asked of each open item: given everything that has landed since the
plan was written, is the SPECIFIED MECHANISM still the right one? Verdicts:
KEEP (spec still best), RE-SPEC (goal stands, mechanism should change),
CONSOLIDATE (fold into another plan), DEFER (right idea, wrong time).

## polyglot-roadmap-v2 (the master)

- **P3-T10 exact tokenizers — RE-SPEC.** The spec chases per-model local
  tokenizers (tiktoken napi, HF tokenizer.json) and admits Anthropic/Gemini
  are un-coverable locally. Better mechanism now available: the runtime
  already sees `usage` from every provider (7 usage touchpoints in
  `sdk/src/impl/llm.ts`) and `scripts/calibrate-openai-tokens.ts` exists. A
  **usage-feedback calibration loop** (record estimator-vs-actual per model
  family, auto-correct the fudge factors) covers ALL providers uniformly,
  needs no kernel acquisition, and directly serves the actual consumers
  (budget + compaction decisions). Keep local exact counting ONLY for the
  pre-flight truncation path and open-weight models we serve ourselves.
  The dependency-provenance guard built this week is the vetting path for
  any kernel we still adopt.
- **P4-T1..T4 (ast-grep, rename_symbol/LSP, compiler fixes, codemods) —
  RE-SPEC from BUILD to INTEGRATE.** The tree now ships MCP + ACP SDKs as
  live dependencies and tree-sitter infrastructure everywhere. Building
  13-grammar structural edit kernels in-tree duplicates what external LSP
  servers and ast-grep already do; the better arc is sidecar integration
  over the existing substrate, with the broker-receipt/capability contracts
  (P0-T8 machinery) as the seam. Same goals, a fraction of the ownership.
- **P2-T2b resume-from-own-journal — KEEP.** Sound; no better mechanism has
  appeared. Still blocked on replay semantics, not design.

## memory-overhaul-2026-10 Phases 2–4 (already flagged needs-rewrite)

- **Phase 2 (reserved band + decision-point injection) — RE-SPEC via the
  compaction budget system.** The "reserved band" predates the compaction
  budget chips + context-archive + consolidation that now manage context
  pressure. Express memory guarantees as a reserved slice of the EXISTING
  compaction budget rather than a parallel reservation mechanism. The
  decision-injection half already landed (decisionCapturePolicySection +
  record_decision + decision-rationale.ts).
- **Phase 3 (write hygiene) — CONSOLIDATE as done.** Tier 1D landed its
  substance (sessionScoped reads, rationale clauses, content-hash dedup).
  Whatever remains should be enumerated fresh, not executed from the old
  text.
- **Phase 4 (evals loop) — CONSOLIDATE into buffbench.** A bespoke memory
  eval loop duplicates the buffbench substrate; wire retention/noise
  metrics (already computed in retrieval-quality's harness) into it.

## harness-remediation-2026-09 (open remainder)

- **P7.1–P7.3 (SQLite projections, IN-chunking, cursor scans) —
  CONSOLIDATE into the memory rewrite.** These target the same
  bun-sqlite repository the memory overhaul Phases 2–4 must re-derive
  against (json_extract scans confirmed still live), and
  `docs/memory-v1-removal-readiness.md` already owns the schema-arc
  sequencing. Executing P7 standalone would fight that plan.
- **P8.5 (sharded Float32 vector cache) — DEFER pending an inventory.**
  The semantic layer already exists (indexer semantic tests, query-index
  renders embedding readiness). Size the actual cache problem before
  building a sharded one.
- **P4.3 (broker retention cap), P6.1 (top-level rejection guard), P6.3
  (transcript cap investigation), P5.4–P5.6 — KEEP.** Small, still-correct
  hardening; no better mechanism has appeared.

## harness-remediation-2026-09-22

- **Verdict: verification pass first, design review after.** 38 unverified
  items whose paths moved; judging mechanisms for work that may already
  exist would repeat the json-guard lesson in reverse. The M1 security
  wave's CONCEPTS (kill eval sinks, normalize-then-check containment,
  config trust boundary) remain correct regardless; partial evidence
  (errorCode union, containment helpers) suggests partial landing.

## subagent-streaming P2-T1/T2 (routing + skip reason)

- **KEEP, with one modernization:** implement the skip reason as a
  structured field on the spawn result the new per-child verdict lines can
  render (spawn-agents renderer from the UX wave), rather than a log line
  as the Sept spec implies.

## language-fit-audit NOW item (browser-use tool-layer enforcement)

- **RE-SPEC: decouple the two agendas.** The spec bundles (a) real
  enforcement of interactionPolicy via an action allowlist and (b) the
  first agent.yaml declarative pilot. Enforcement is small, security-
  relevant, and now has a better home: the tool-metadata layer
  (renderer-intent precedent in common/src/tools/metadata.ts) + the
  browser_logs handler keyed off spawn params — mirroring how
  terminalPermissionProfile flows. The yaml pilot is a format-migration
  decision that should stand or fall on its own.

## Bottom line

Five concrete re-specs (tokenizers → usage calibration; P4 → integrate over
MCP/ACP; memory band → compaction budget; browser-use → decoupled tool-layer
enforcement; P7 → fold into the memory rewrite), two consolidations (memory
Phases 3/4), one defer-with-inventory (P8.5), and the rest keep. No open
item was found where the original spec is actively wrong — the recurring
drift is plans specifying BUILD where the substrate now supports INTEGRATE.
