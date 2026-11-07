# Fresh-checkout and native CI repair

The first checkpoint push reached `0f34d0f77`; its managed pre-push hook passed
all agents/common suites. GitHub then exposed two distinct failures: the
documentation guard referenced build outputs absent before generation, and
Windows checkout rejected twelve long evidence paths. Original logs and source
images are preserved in [guard](guard/before.json) and [Windows](windows/REPORT.md)
evidence.

The documentation guard admits exactly three declared output references when
their regular producer file exists: the CLI bundled-agent source and SDK ESM
bundle/type declarations. It continues to reject unknown neighboring output
and source paths, and known outputs without a regular producer. This validates
pre-build references; build/release checks still verify output availability and
bytes. No generated bundle, frozen Markdown, archive or original inventory was
rewritten for this repair.

The guard suite passes **71 tests, zero failures and 164 assertions**. The live
guard reports zero findings across 12 checkers. The
[real unbuilt checkout](guard/fresh-checkout-v3/report.json) reproduces the four
original findings with the old guard, passes with the repaired guard while all
three outputs remain physically absent, and rejects two unlisted outputs.
[Independent review](independent-review/REVIEW.md) also checks direct/shared
snapshot behavior, missing/directory/removed producers and existing outputs.
The first two checkout recorders failed parsing the success banner; their
scripts and partial logs remain historical failures. The complete v3 receipt
supplies the positive control.

The Windows workflow enables Git long paths before checkout using the runner's
temporary directory. Native test and smoke selection now consumes boolean
matrix flags directly. The five-target roster, build/test job, toolchains,
linkers, builds and uploads remain intact.

Enabling smoke revealed two further defects in that path: the script lacked
the executable bit and still treated `exec` as an unimplemented role. The
[corrected smoke](windows/smoke-mode/script-repair/REPORT.md) is executable and
probes the remaining `daemon` placeholder, preserving version and unknown-role
controls. It passes against the matching current-source Linux binary built
with Rust 1.87.0. Original `exec` and direct-smoke failures are retained.
[Independent smoke review](independent-review/smoke-script-review/REVIEW.md)
approves exact script bytes and mode. No Rust runtime or role payload changed;
these controls carry no downstream native/body-card acceptance.

The [fresh root typecheck](commands/typecheck/typecheck.json) passes all 11
workspaces with **193 unchanged/current declared inputs**: the previous 187
plus both output producers, two earlier E2E fixture repairs, the Rust workflow
and the recorder. The smoke script has no active acceptance or inventory
binding and is outside that declared typecheck scope.

The renewed [B01](independent-node-review/B01/review.json) and
[B36](independent-node-review/B36/review.json) evidence replaces only each
node's shared typecheck credit. B01 retains all 11 required checks, including
its untouched tail/store authority; B36 retains three. Other 37 nodes,
implementation contracts, behavior evidence, prerequisite declarations and
accepted timestamps remain unchanged. The
[exact candidate approval](acceptance-independent-review/REVIEW.md) and
[promotion](promotion.json) bind the new live ledger
`fe0e337cb0675613310f1b86dd58d823f187e0672b0ea5b8a4a8060121f7e83c`.
Eight completion nodes remain accepted and 31 remain pending.

The [current inventory delta](required-path-delta.json) replaces only the
original guard, regression-test and ledger hashes. The other 2,641 required
paths and both archives remain unchanged. The original inventory and earlier
repair delta remain historical records; the current staged checkout is checked
by [materialize-index.py](materialize-index.py).

The [staged checkout receipt](checkouts/cfbcbbb500db/report.json) and
[independent publication review](fresh-checkout-independent-review/REVIEW.md)
verify 5,146 Git blobs/modes, all 2,644 required hashes and both restorations
(186 base files plus 27 Git-fixture files). Restored bytes and executable bits
match. Two toolchain-context creation permissions reflect the process umask:
TypeScript's `bin/tsc` changes from archive mode `0777` to `0755`, and
`lib/tsc.js` from `0666` to `0644`. Full archive permission equality is not
claimed. Final added publication metadata is checked separately when staged.

The researcher/agent-browser plan and RWEB-0 feasibility approval remain
unchanged. No researcher/provider run or installed CLI rebuild occurred.
Windows/Darwin execution and the complete published CI outcome require the
actual GitHub run, separate from the local and structural checks above.
