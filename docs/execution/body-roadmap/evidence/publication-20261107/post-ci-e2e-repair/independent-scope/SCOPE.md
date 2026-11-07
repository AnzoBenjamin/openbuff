# Independent scope of the agents gate E2E fixture repair

The proposed existing-file edits are limited to `agents/e2e/gate-aux-ordering.e2e.test.ts` and `agents/e2e/gate-lifecycle.e2e.test.ts`. The specialist-gate scenarios are a describe group in the auxiliary-ordering file, not a third standalone file.

Both paths have zero effective active file bindings in the frozen validator, are absent from all accepted source contracts, and are absent from the frozen 2,644-path publication inventory. The exact current validator was run with a read-only digest observer that delegates every hash calculation unchanged. Validation passed on live ledger `64bdc49206f2e3efad0393dad82048134c4403e43bef8bdb26696251bbf7b07b`; all nine existing E2E TypeScript files remained stable. `active-bindings.json` records the actual calls and has SHA-256 `d904eff41f734d7241e8c2bb1560a9df6d028d562cfce53ddebfd9b53b5fe4d2`.

Therefore a repair confined to these two fixtures requires no accepted command/review/receipt renewal and no historical inventory override. An optional new dedicated fixture helper is also outside the existing bindings; editing a different existing helper would need its own scope check. Fresh repair tests and the broader agents suite should be recorded as new CI evidence, with normal staged-file verification of the changed test bytes.

Among the existing E2E files, `agents/e2e/reviewer-spawn-conditions.e2e.test.ts` is bound by B01's active scoped command maps. It is outside the proposed repair and should stay unchanged. The incidental generated local tools mirror is not treated as an intended edit; root will retain its committed reviewed bytes.

The earlier agents-suite receipt invoked `bun --no-env-file run --cwd agents test`. The package script expands to `bun test __tests__`, and its raw log records 1,284 passes, zero failures and 45 test-file headers, all in that unit-test scope. It contains no E2E test-file headers or E2E source-input bindings. That result should be described as the agents unit or `__tests__` suite, not the complete agents suite.

The managed pre-push Step K invokes bare `bun test` with the agents directory as cwd. The current tree contains the same 45 unit-test files, eight E2E files and three additional files outside those directories: the browser-use, librarian and root tool-reachability tests. This is a 56-file discovery surface. The historical 1,284-pass check did not exercise the eleven additional files. `coverage-schedules.json` binds the original receipt/log, current package scripts and managed scheduler, and enumerates the current test files.

The newest failure totals of 1,346 passes, five skips and thirteen failures across 56 files were supplied by root; a separate raw-log receipt is needed before treating those totals as independently inspected here. The confirmed scheduling difference does not depend on those reported counts.

This is a binding and coverage analysis only. It does not approve the eventual fixture implementation, changing attestation expectations, skipping failed scenarios, weakening protocol validation, or accepting another card. The lifecycle mismatch-fingerprint expectation requires reproduction and comparison with the current accepted protocol before any assertion change. No source, ledger, historical evidence or Git staging was edited by this reviewer.
