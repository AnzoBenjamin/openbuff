# Lessons — json-overhaul

## Decisions
- Reader-side consolidation (Phase 1, C1–C3): all JSON decode/envelope-recovery now lives in `common/src/util/model-payload-recovery.ts` with ONE bound (`MODEL_PAYLOAD_JSON_CHAR_LIMIT`, 1M) and ONE content rule (`isReceiptShape` + `unwrapArbitraryEnvelope`). Importer paths preserved via re-exports.
- Writer-side policy (Phase 2, user-decided): **option b — receipt-only replacement**, not first-write-wins, so legitimate corrected receipts still land while verdict-less echoes cannot downgrade a published review.
- Test reconciliation over logic change: when moved-verbatim code failed new tests, the pre-move original (`git show <commit>:<path>`) was the arbiter; the four divergent expectations were rewritten to pinned legacy behavior rather than "fixing" correct code.

## Gotchas
- Relative import depth in common is 3 levels from `common/src/tools/params/tool/` → `../../../util/...`; a 2-level import `TS2307`s and cascades `TS7006` implicit-any errors downstream.
- `{jsonKey, value}` and `{message:'Output set'}` are model-invented shapes; keying unwraps on FIELD NAMES chases the bug forever — key on CONTENT.
- The runtime reviewer/receipt pipeline itself is a live reproduction ground: degenerate `{"message":"string."}` receipts from spawned agents were observed in this very session, which is the class Phase 2's ack-echo rejection addresses.
- A coder's `No output generated` child failure (twice on the same slice) is the loop-detection signal to switch to direct bounded edits, not retry #3.
- `bun --cwd` does not run scripts from the repo root reliably; `cd <pkg>` chain works.

## Follow-ups
- Phase 2 implementation (D1.2 guard, D2.1 description, D3 tests, D4 commit) — DONE (79cd33a85).
- Tool-executor convergence — DONE (final form): its parse chain stays a deliberately SEPARATE fail-closed family (tool args must never be silently repaired into calls), but its `decodeJsonObjectString` import now points at the canonical module, and the two-family boundary is documented in the recovery module's header comment.