# Status — json-overhaul

## Completed (Phase 1, committed on feat/polyglot-reaudit-roadmap, ~ahead 7)
- C1 `84ce821e5` — shared `common/src/util/model-payload-recovery.ts` (receipt-shape constants, `isReceiptShape`, `unwrapArbitraryEnvelope`, bound alias), params file re-imports.
- C2 `499d7552e` — decode layer (`recoverTruncatedJsonObject`, `decodeJsonObjectString`, scan helpers) moved verbatim; re-exports keep importer paths; 4 divergent new tests reconciled to pinned legacy behavior; 41/41 green.
- C3 `b7183d697` — spawn-agent-utils settle path: 1M/2M bound drift unified; three inline bounded-parse blocks → one `parseBoundedReceiptCandidate` helper; 75/75 green. All reviewer gates LOOKS_GOOD.
- Test binary rebuilt + installed to `~/.local/share/openbuff-test/openbuff-branch` (--version 1.0.0, OpenTUI smoke pass).

## Current phase: Phase 2 — receipt-overwrite rework (planned, not implemented)
- SPEC/PLAN written for Phase 2 (D1–D4).
- User decision locked: option **b — receipt-only replacement** policy for the writer-side downgrade guard (R1) + ack-echo rejection (R2) + tool-description guidance (R3) + regression tests (R5) → D4 commit.
- Blocked from implementation in plan mode; first execute-mode action = PLAN task D1.2.

## Phase 2 COMPLETE (gate LOOKS_GOOD at rev 7739; pending commit)
- D1.2/D1.3 writer-side receipt-overwrite guard landed: reviewer-family verdict-less second call can no longer destroy a published verdict-bearing receipt; `RECEIPT_GUARD_ACK` exported; content-addressed via shared `isReceiptShape`; corrected full receipts still replace; non-reviewer replace-always intact.
- D2.1 tool-description paragraph added (ack-is-confirmation guidance).
- D3 regression tests: four guard cases green in set-output.test.ts (27/27 total); common suites 41/41; full workspace typecheck green; test binary rebuilt + installed (Phase 2 included).

## Next checkpoint
- Commit Phase 2 changeset (D4.3), then update PLAN checklist.

## Resume instructions
- Session: `.agents/sessions/json-overhaul-2026-10/`; read PLAN.md tasks D1.2 onward; the handler to edit is `packages/agent-runtime/src/tools/handlers/tool/set-output.ts`; use shared `isReceiptShape` (NOT key-name matching).