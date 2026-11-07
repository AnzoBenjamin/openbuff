# STATUS — Polyglot re-audit 2026-09-28

State: all 21 audit shards are persisted under `findings/`. `AUDIT-REPORT.md` has been synthesized: 334 findings after de-duplication (1 CRITICAL, ~58 HIGH, ~170 MEDIUM, ~105 LOW, of which ~45 are confirmations). The roadmap SPEC/PLAN files are **unchanged**. The proposed amendments in AUDIT-REPORT §7 still need user approval.

## Coverage matrix
Snapshot: `49801b44e84d3d8fa583c3ebd9b2855228bf122572b7cdf5f78c77b3389d824d`. Each shard returned a snapshot-bound structuralReceipt.

| Subsystem | Shards | Covered |
|---|---|---|
| packages/code-map | w1-code-map | yes |
| packages/indexer | w1-indexer | yes |
| packages/agent-runtime | w1-runtime-edits-preflight, w2-runtime-core, w3-runtime-tool-handlers, w3-compaction | yes (partial: ~20 small handlers were not read; see the report's Coverage section) |
| packages/internal, build-tools | w2-infra-internal-scripts | partial (openrouter sources and build-tools were not read in full) |
| sdk | w1-sdk-language-tooling, w2-sdk-core, w3-sdk-services | yes |
| common | w1-common-language-registry, w3-common-core | yes |
| agents | w1-agents-prompts, w3-compaction | yes (researcher/thinker/git-committer were grep-scanned only) |
| cli | w2-cli, w3-cli-remaining | yes (partial: some commands, hooks and renderers were listed but not read) |
| evals | w1-evals | yes (logs and error JSON excluded as generated data) |
| docs + root docs | w1-docs | yes |
| rust | w2-plan-p5-p6-rust | yes |
| scripts, .github, .agents templates, openbuff.d.example | w2-infra-internal-scripts | yes (partial) |
| PLAN items P1–P10, X, CQ | w2-plan-p1-p2, w2-plan-p3-p4, w2-plan-p5-p6-rust, w2-plan-p7-p10-x | yes: 96 task verdicts |
| test/ | w3-cli-remaining | yes |

## Subsystem enumeration (top-level dirs)
- **Audited:** `.agents` (templates), `.github`, `agents`, `cli`, `common`, `docs`, `evals`, `openbuff.d.example`, `packages`, `rust`, `scripts`, `sdk`, `test`, and root files.
- **Out of scope:**
  - `agents-graveyard`: dead code.
  - `web`: empty.
  - `node_modules`, `rust/target`, `.codebuff-index`, `debug`, `scratch-logs`, `e2e-traces`, `.tmp`, `.openbuff`: generated or runtime data.
  - `.claude`, `.vscode`, `.commandcode`, `.omx`, `.sisyphus`, `.bin`: tool-local config.
  - `.agents/sessions`: session artifacts.

## Known limits
- `evaluate_audit_coverage` was not run. The parent only has the shards' compact receipts, not the raw structuralReceipt objects. The matrix above is based on each shard's self-reported coverage.
- Several external-library claims came from model knowledge rather than web research: Semgrep licensing, difftastic JSON stability, notify-rust action support, the QuickJS generator-checkpoint limit, and the Landlock ABI scopes. Verify them before locking any decision that depends on them.
- The synthesizer could not read `SPEC.md` because of its sandbox. Its §1 answers follow the lens definitions, which match the audit SPEC's three questions.

## Next checkpoint
The user reviews the Top 15 and the PLAN verdict table. On approval, fold the §7 amendments (D29+ and task changes) into `polyglot-roadmap-v2/SPEC.md` and `PLAN.md`, then start on the Top-15 fixes, the CRITICAL rewrite_symbol finding first.
