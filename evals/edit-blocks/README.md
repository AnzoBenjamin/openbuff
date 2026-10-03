# Edit blocks eval

Deterministic `bun:test` scenario for the flag-gated plain-text
SEARCH/REPLACE edit-block surface of `edit_transaction` (PR-T4 / D22
wave 2). No LLM calls, no network: every assertion runs against the real
zod schemas from `@codebuff/common`.

## What it measures

- **EB1 equivalence** — for a fixture corpus of realistic edit payloads
  (multi-replacement single file, multi-file, deletion, quote/brace-heavy
  JSON content, JSX), the block payload and the JSON-encoded equivalent
  edit array parse to deep-equal transactions through
  `editTransactionParams.inputSchema`, and both `inputSchema` and
  `providerInputSchema` accept the block payload string while
  `OPENBUFF_EDIT_BLOCKS` is on.
- **EB2 escaping overhead** — the block payload is never larger than the
  `JSON.stringify`-ed edits array for code-bearing fixtures (JSON must
  escape every newline and quote; blocks carry code verbatim). Measured
  sizes and block/json ratios are logged as a summary line per fixture.
- **EB3 adversarial injection** — marker collisions inside SEARCH bodies
  (`marker_collision`), JSON/block mixtures, and prose outside blocks all
  fail validation on both schema surfaces end to end instead of producing
  a corrupted edit.
- **EB4 flag-off identity** — with the flag forced off at runtime, the
  same JSON payloads parse identically to the canonical expectation and
  block payloads are rejected, pinning that the default path is untouched.

## How to run

```sh
bun --cwd=evals test edit-blocks
```

The edit-transaction tool params read `OPENBUFF_EDIT_BLOCKS` exactly once
at module load, so the scenario sets the variable and dynamically imports
the modules under test (a static import would be hoisted above the env
assignment and build the flag-off surface). Run this scenario in its own
`bun test` invocation: if another test file in the same process has
already imported the module with the flag off, the EB1 probe fails with
that signal instead of a confusing equivalence failure.

## What is NOT measured

- Live completion-rate A/B between the JSON and block formats (does the
  model actually emit valid blocks more often, and does that raise edit
  success rate or reduce payload truncation in practice?). That requires
  agent runs and stays a manual gate per PLAN.
- Parser and preprocess edge cases: pinned by wave 1 in
  `common/src/tools/params/__tests__/edit-blocks.test.ts`; this scenario
  only re-asserts the end-to-end rejection behavior for the injection
  cases.
