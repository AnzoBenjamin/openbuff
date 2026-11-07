# SPEC — Polyglot re-audit 2026-09-28

Requested 2026-09-28 after P0/PR/CQ/P2-T1/P2-T2 progress on `.agents/sessions/polyglot-roadmap-v2/`.

## Questions this audit answers
1. **Polyglot support (POLY):** Is every part of the harness checked against its ability to work with user repositories in *any* language, not only TS/JS? That covers parsing, indexing, import resolution, diagnostics, preflight, tests and build targets, idioms, prompts, tokenization, docs and evals.
2. **Language choice for planned work (LANG):** For every PLAN.md item still to be implemented (`[ ]`/`[~]`), is the chosen language, library and integration mechanism the *best possible* implementation? Complexity and timeframe are explicitly not a ceiling.
3. **Best in current language (BEST):** For every harness part that is *not* slated for a move, is it the best possible version in its current language (algorithms, data structures, APIs, correctness, tests)?

## Method
- Snapshot: `inspect_codebase_structure` snapshotId `49801b44e84d3d8fa583c3ebd9b2855228bf122572b7cdf5f78c77b3389d824d`.
- Shards: one `general-agent` audit shard per subsystem or lens, plus paired `file-picker` discovery. Each shard persists its findings via `write_audit_findings` to `findings/<shardId>.md`.
- Finding titles carry a lens prefix: `[POLY]`, `[LANG]` or `[BEST]`. The `domain` field is the nearest of the 8 standard audit domains.
- Synthesis: `synthesizer` produces `AUDIT-REPORT.md`, and `STATUS.md` holds the coverage matrix and the subsystem enumeration.

## Out of scope
- `agents-graveyard/`: dead code, not shipped.
- `node_modules/`, `rust/target/`, `evals/**/logs` and the judge/error JSON artifacts: generated data.
- `.claude/`, `.vscode/`, `.commandcode/`, `.omx/`, `.sisyphus/`: tool-local config.
- `web/`: the directory is empty.

## Deliverables
- `findings/*.md` from each shard.
- `AUDIT-REPORT.md`, containing:
  - the top findings
  - per-lens sections
  - a plan-item verdict table (keep / change language / change approach)
  - cross-cutting findings
- A proposed set of SPEC/PLAN amendments. This is a proposal only: roadmap files are not edited without user confirmation.
