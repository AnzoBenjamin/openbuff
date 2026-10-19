# JSON Overhaul — «Structured at boundaries, stringified once at the edge»

## Goal
Eliminate the recurring class of harness failures caused by double-stringified JSON (models calling set_output with `{jsonKey, value}`-style envelopes, stringified receipts inside stringified tool calls, degenerate `{"message": "Output set"}` ack overwrites). Fix structurally, not per-shape patches.

## Non-goals
- No change of wire format away from JSON (every provider emits JSON natively; not going away).
- No schema loosening that lets genuinely invalid receipts settle (fail-closed verdict guards stay).
- No behavior drift beyond the boundary contract.

## Requirements (acceptance criteria)
1. Writers: where the harness PRODUCES a payload for a model/subagent, emit native structure (no pre-stringified JSON字段) except at a single serialization point.
2. Readers: where the harness CONSUMES model-produced payloads, one shared bounded recovery path (content-addressed, envelope-name agnostic) — no per-key-name branches scattered in handlers/settle paths.
3. Regression tests pin: native receipts, stringified envelopes (any name), malformed (fail-closed), and over-bound (rejection diagnostic).
4. Typechecks + targeted suites green; commit on feature branch.

## Known relevant surfaces (from prior session evidence)
- writer: handlers/tool/set-output.ts (unwrap edge — to be replaced by shared util)
- reader: spawn-agent-utils.ts normalizeSpawnedAgentOutput / compactReviewerOutput
- decode util: decodeJsonObjectString (fencing/truncation recovery), MAX_SET_OUTPUT_JSON_CHARS
- persisted history boundaries: toToolCallStreamChunkPayload; transport truncation marker
