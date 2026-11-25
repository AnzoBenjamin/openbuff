# B21 reduced local acceptance — 2026-11-24

B21 is **accepted under a narrower, user-authorized local Linux behavior
scope** recorded in [B21-ACCEPTANCE-20261124.json](B21-ACCEPTANCE-20261124.json).
This does not satisfy or imply acceptance under the original full source-bound,
independently reviewed gate. The original behavior-only receipts remain
`accepted: false`; the new, separately validated decision records the reduced
scope without altering those receipts or the frozen plan/specification.

The accepted scope is limited to the recorded local Linux behavior of Fixture A
and the packed SDK CJS/ESM consumers, together with the focused local SDK/Rust
checks below. It does not claim clean registry installation, cross-platform or
hosted behavior, full original B21 guarantees, source-bound native/build
provenance, or independent approval. B21's existing graph prerequisites B19
and B20 are retained unchanged.

## Completed local checks

- The previously recorded focused SDK run passed **174 tests**: native execution (49), native-host
  integration (27), Node-scope clock integration (11), execution-launch timers
  (21), search execution (41), and terminal caller cancellation (25). SDK
  typecheck passed. The test commands unset `TMPDIR` and credential-like API
  variables; none of these selected test files assigns process `HOME`.
- The recorded Rust 1.99.1 locked offline workspace build passed. The serial
  locked offline workspace test run passed **30 tests** (4 intelligence, 15
  native library, 10 exec-control integration, and 1 workspace-harness test).
  The compiler reported the existing `function_casts_as_integer` warning in
  `entry_waiter.rs:249`. The native sidecar smoke passed all four CLI checks:
  version output, unknown-role status, the structured unimplemented-role
  response, and refusal when private exec control descriptors are absent. A
  locked offline optimized `openbuff-native` release build also passed; its
  SHA-256 and build log are retained with the evidence.
- The recorded Fixture A run passed explicit `--local-current` mode using the source SDK,
  the release binary (`e17d68e083d5610663424bb85cbcba182108f7e834ed850059cbda8b6b80e92d`),
  and `/usr/bin/bwrap` 0.13.1. The fresh
  receipt records three actual cases: synchronous target exit 7, background
  target exit 7, and direct target signal 11. Both workspace-write cases report
  exact-environment, filesystem/network isolation, process-tree containment,
  and deadline enforcement; cleanup completes at the Linux PID-namespace
  tier, and native target wait/usage data is present. The fixture confirms
  allowed-file access and denial of the excluded sibling path. Optional memory
  enforcement was unavailable, and no network attempt was made. All 35
  selected SDK/native source hashes, the release ELF, and bwrap stayed stable;
  provider calls were zero. The receipt is explicitly
  `local-current-behavior-only`, has no build/bootstrap receipt, and says
  `accepted: false`. The earlier debug ELF attempt expired during its bounded
  self-hash before target dispatch; it remains retained as an adverse attempt.
- A recorded SDK build from a source snapshot in the evidence directory passed
  CJS/ESM bundling, declaration generation and public-consumer verification;
  its copied WASM and vendored ripgrep assets are included. The original
  `sdk/dist` was not touched.
- The built SDK tarball was unpacked into a new consumer package path. CJS and
  ESM each resolve `@openbuff/sdk` and expose the same eight checked exports
  (342 total). This is a package-layout smoke check, **not** an isolated
  dependency install: its 21 declared runtime dependencies link to the existing
  workspace `node_modules`.
- The recorded local-current packed-consumer attempt at
  `evidence/B21/continuation-20261124-local-current-r1/packed-installed-consumer-r3/`
  passed in both Node CJS and ESM using that SDK snapshot and the release native
  binary. Each format passes all three real target scenarios: synchronous exit
  7, background exit 7, and direct target signal 11. Native target wait status
  and usage are recorded; workspace-write cleanup completes at the Linux
  PID-namespace tier, and signal-case cleanup completes at the direct-child
  tier. Both consumers pass their exact environment, allowed/excluded-file,
  target-output and cleanup assertions, with zero fetches. Pre/post package,
  `dist`, source-helper, native, bwrap, runtime and copied-dependency identities
  remain stable; the evidence-owned host is removed after the checks. The
  runner passes inherited `HOME` unchanged and records only a redacted policy
  marker. This is local installed-consumer behavior, not a clean registry
  install, source-bound build provenance, or independent I2 admission. The
  first two attempts are retained with their pre-dispatch inventory failures
  (development `node_modules` and `vendor` symlinks); they are not consumer
  failures.
  The passing invocation was:

  ```sh
  /home/ben/.local/share/mise/installs/node/26/bin/node sdk/scripts/fixtures/b21-package-consumers/run-installed.mjs \
    --local-current \
    --sdk-package docs/execution/body-roadmap/evidence/B21/continuation-20261124-local-verification-r1/sdk-build \
    --native-binary rust/target/release/openbuff-native \
    --bwrap /usr/bin/bwrap \
    --evidence-dir docs/execution/body-roadmap/evidence/B21/continuation-20261124-local-current-r1/packed-installed-consumer-r3
  ```

- Two test-fixture corrections were needed for the controls to reach the
  intended paths. The diagnostic timer test now asserts that completion remains
  pending until the fake child closes after termination. The synthetic native
  fixture completes its Git safety reads, so the cleanup-refusal test reaches
  the target command; assertions distinguish that target from helper launches.
  These edits are test-only and the affected suites pass.

Logs, the SDK build snapshot, tarball, and consumer outputs are under
`evidence/B21/continuation-20261124-local-verification-r1/`. The release build,
debug failure, and fresh local-current receipt/log are under
`evidence/B21/continuation-20261124-local-current-r1/`. These evidence
directories are ignored by `.gitignore`; this tracked report and the `STATE.md`
entry preserve a summary, while the logs remain local.

## Gates waived for this B21-only reduced scope

- The fresh full approved SDK schedule was not run for this acceptance: its documented `env.test.ts` fixture
  overwrites `process.env.HOME`, which is prohibited in this session. The
  existing CJS/ESM compatibility fixture directories were also left untouched
  because they contain pre-existing worktree changes.
- `test/fixtures/body/toolchain-manifest.json` cannot establish current-source
  fixture evidence. It expects `common/src/util/owned-process-scope.ts` hash
  `04a37cac…` (current: `95c1ec7e…`) and `sdk/package.json` hash
  `a4dcb219…` (current: `3669c541…`), and selects an unavailable absolute Rust
  1.87.0 cargo path; the current local toolchain is Rust 1.99.1. The strict
  manifest-backed fixture route was not run and no stale or synthetic manifest
  receipt was produced. The separate local-current route above does not create
  source-bound build provenance.
- The local-current fixture and packed CJS/ESM consumers demonstrate the stated
  Linux behavior on this host only. They are not a clean registry install, the
  strict packed B21 consumer's I2 admission, installed CLI evidence, or proof of
  untested behavior.
- The twelve missing historical prerequisite replacement receipts were not
  reconstructed. The independent composition review was not performed. These
  gates are explicitly waived only for the reduced B21 scope; no independent
  approval is claimed.

The retained local evidence directories are ignored by Git. This tracked report
and the decision artifact preserve the scope and outcomes, but raw logs and
receipts are local to this checkout and are not portable acceptance evidence.

**Decision:** B21 is accepted only for the bounded local Linux behavior scope
above. Every broader assurance listed as not established in the decision file
remains unverified and is not inferred by this status.

The probe installed Rust 1.99.1 under the existing user-managed mise data
directory; process `HOME` was not changed. No live provider credentials were
used, and no historical ledger or receipt was altered.
