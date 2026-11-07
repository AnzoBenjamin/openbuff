# Reviewer E2E CI fixture repair scope

Owner: `/root/b02_runtime_outcomes`. Production edits are not authorized.
Root confirmed exactly the two fixture paths before source edits. No new
helper or other source edits were authorized or made.

The three failed scenario families occupy two current files:

- `agents/e2e/gate-aux-ordering.e2e.test.ts`: pre-reviewer aux ordering and
  specialist reviewer-gate state machine.
- `agents/e2e/gate-lifecycle.e2e.test.ts`: deterministic gate lifecycle.

The pinned Bun 1.3.5 targeted baseline reproduces 19 pass, 13 fail, 647
assertions across two files. Exact commands, failure log, source hashes and
before images are retained. Replacement env, owned empty home/XDG/TMP, empty
provider config and pre-import fetch refusal observed zero fetch attempts.

Current reviewer evidence requires five nonempty assessments and nonempty
requirement evidence. Synthetic passing/blocking helper values still omit
these fields. The lifecycle helper has five assessments but defaults to an
empty requirement list; two explicit parent-owned requirement rows also omit
evidence. Update fixture evidence faithfully while retaining each scenario's
verdict, findings, coverage, scope membership, parent ownership and assertions.

An additional lifecycle scenario expected a nonmatching v3 fingerprint to
pass. The evidence-only rerun proved the accepted gate requires equality,
despite historical drift-tolerated comments. Root authorized updating that
scenario to stale → corrected reviewer-only retry, with no credit before the
matching review. The batch case explicitly drives its missing sibling's
protocol retry while preserving the original finding-credit assertions.

`reviewer-spawn-conditions.e2e.test.ts` has active B01 bindings and stays
untouched. B04 reports zero effective live accepted bindings for the two
proposed fixture paths, which are absent from the historical required inventory.
No new shared helper is necessary: local helpers can supply the evidence.

CI verification must include bare `bun test` with cwd `agents`, matching the
managed Step K discovery. `bun run --cwd agents test` only invokes
`bun test __tests__` and does not cover these E2E scenarios.
