# B21 packed Node native consumers

The runner uses Node 26.1.0 and checks the selected Bun 1.4.4, candidate native
artifact/build inputs, and guarded SDK build. It packs the current SDK dist
offline with npm 11.13.0 and lifecycle scripts disabled, extracts the tarball
into a fresh host outside the checkout, and copies the already installed
manifest-declared third-party dependency graph. Dependency links remain inside
that host; CJS and ESM loaders reject all checkout imports.

Each export runs the public `OpenbuffClient.run` programmatic agent with native
selection supplied exclusively through its explicitly selected configuration.
The source artifact is copied to an installed executable and checksummed before
and after consumption. Observed descriptor spawns bind the actual invoked native
bytes. No provider/network fetch or Python execution prerequisite is allowed.

The bounded cases preserve adverse target outputs: synchronous exit 7 with exact
env/cwd, allowed and excluded reads, and ordinary JSON-RPC-shaped stdout;
background exit 7 through `check_job`; direct target signal 11. Assertions cover
genuine `native-target-wait`, actual-target wait4 usage, committed native entry,
and returned physical native/setup cleanup. A failing case remains in its raw
result and command logs and does not disappear behind a successful model run.

Execution requires the root coordinator's exact current native candidate and
independent I2 admission. The flag records that admission; it does not replace
independent interpretation of the linked review.

```sh
/home/ben/.local/share/mise/installs/node/26/bin/node sdk/scripts/fixtures/b21-package-consumers/run-installed.mjs \
  --manifest CANDIDATE --manifest-sha256 CANDIDATE_SHA256 \
  --native-binary NATIVE_BINARY \
  --sdk-build SDK_BUILD_RESULT --sdk-build-sha256 SDK_BUILD_SHA256 \
  --i2-review REVIEW --i2-review-sha256 REVIEW_SHA256 --i2-approved \
  --evidence-dir docs/execution/body-roadmap/evidence/B21/packed-native-consumers-20261112-r1/attempt-r1
```

The owned evidence parent must exist; each attempt directory must be new.
All existing build inputs must still match; newly authored helper inputs are
separately inventoried. Failed scratch hosts are retained for reconciliation.
Passing scratch hosts are removed only after all consumer and stability oracles.
This evidence gives scoped packed Node native consumption credit. Authored
negative controls, installed CLI, host-native CI, other platforms and independent
whole-card composition remain separate B21 obligations; `accepted` stays false.

For a bounded local-current behavior check when strict candidate and independent
I2 receipts are unavailable, use the existing SDK package snapshot and release
binary explicitly:

```sh
/home/ben/.local/share/mise/installs/node/26/bin/node sdk/scripts/fixtures/b21-package-consumers/run-installed.mjs \
  --local-current \
  --sdk-package docs/execution/body-roadmap/evidence/B21/continuation-20261124-local-verification-r1/sdk-build \
  --native-binary rust/target/release/openbuff-native \
  --bwrap /usr/bin/bwrap \
  --evidence-dir docs/execution/body-roadmap/evidence/B21/continuation-20261124-local-current-r1/packed-installed-consumer-r3
```

Local-current mode is mutually exclusive with strict admission flags. It hashes
the SDK package manifest, shipped documentation and full `dist/` payload, plus
the native artifact and bwrap, before and after the run. It packs from that
package snapshot with lifecycle scripts disabled, and
copies the already-installed third-party dependencies into an evidence-owned
host inside the checkout. `HOME` is inherited unchanged; only credential-free
runtime variables and an evidence-owned `TMPDIR` are passed to consumers. The
CJS/ESM guards allow checkout paths only beneath that exact host and still
reject workspace aliases and symlink-resolved imports elsewhere in the tree.
The SDK source/build relationship is not re-proven by this local inventory;
this is not source-bound build provenance, a fresh registry install, I2
approval or whole-card acceptance; the result remains
`accepted: false`.
