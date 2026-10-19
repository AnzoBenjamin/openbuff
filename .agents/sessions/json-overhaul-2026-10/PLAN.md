# JSON overhaul — implementation plan

## Milestone 1: Discovery
- Map all double-stringified JSON boundaries: tool-call inputs (parseRawToolCall), set_output handler (`set-output.ts`), spawn receipt settle (`spawn-agent-utils.ts` normalizeSpawnedAgentOutput / compactReviewerOutput), message-history producers, and decode helpers (`decodeJsonObjectString`, bounds).
- Output: exact file:line inventory of (a) writer-side serialization points, (b) reader-side unwrap/coercion branches, (c) existing shared helpers.

## Milestone 2: Design
- One shared content-addressed recovery module (`common/src/util/json-envelope-recovery.ts` candidate): single decomposition of "model-supplied payload may wrap receipt/data in an invented envelope" with bounded decode, receipt-shape detection, fail-closed verdict guards.
- Writers stop producing pre-stringified fields where the runtime owns the payload shape.

## Milestone 3: Implementation slices
1. Extract shared recovery util; set-output.ts consumes it (replace local unwrapArbitraryEnvelope).
2. spawn-agent-utils.ts consumes it (replace local jsonKey/structuredOutput branches).
3. Regression tests combined per slice.

## Milestone 4: Validation + commit
- typechecks (common, agents, agent-runtime) + targeted suites; gate cycle; git-committer (no push).

## Status
- [ ] M1 discovery
- [ ] M2 design
- [ ] M3 slices
- [ ] M4 validation/commit