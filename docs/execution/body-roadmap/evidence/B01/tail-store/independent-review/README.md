# Independent B01 tail/store review

This review covers full tail identity, bounded Git stdout identity, complete status membership, and persistent corrupt-record diagnostics. It does not accept B01's wider specialist/gate behavior. The reviewer authored no production or test changes in this subset.

The original producer manifest, all source bindings, and all producer artifacts were checked before review. All matched. Its failed typecheck receipts remain unchanged; the final independent verifier uses a separate successful current SDK typecheck in this independent-review directory, which also binds every B01 tail/store source.

Source review confirmed full incremental SHA-256 over Git stdout beyond presentation retention; complete regular-file hashing with bounded chunks/concurrency; before/open/after bigint metadata checks; NUL-delimited membership; explicit overflow refusal; and durable discovery of corrupt raw records when sidecars are missing or corrupt. These are observed consistency checks and local persistence, not an atomic filesystem snapshot or OS fence.

The independent probe found a blocker missed by the original suite: a permitted record ID containing `.tmp.` lost every diagnostic after sidecar loss because raw quarantine discovery treated its name as temporary. A real restarted store then returned absent, and a real review bundle published an empty finding list while corrupt raw bytes remained. `initial-quarantine-counterexample.*` and `initial-quarantine-observations.json` preserve the failure.

The root's narrow correction excludes only the exact atomic diagnostic-sidecar temporary suffix. Its existing regression now covers both ordinary and `.tmp.` IDs and a genuine orphan temporary sidecar. The unchanged independent two-case probe now requires a persistent diagnostic, a failing direct read, an unavailable bundle and preserved corrupt bytes for both IDs. No other blocking finding was identified in the assigned subset.

Fresh independent commands rerun the four focused suites, the five producer real-source controls, and the two independently built quarantine controls. The producer fixture is copied into this directory with only relative import depth changed; its report is written here, leaving implementation-author receipts untouched. `producer-fixture-copy.json` records this transformation. The fixtures observe zero fetch requests.

Every new command runs the exact Bun 1.3.5 executable with `--no-env-file`, absolute paths and replacement empty HOME/XDG directories. Receipts include actual argv, timing, exit, log hash and before/after source hashes. Run `run-verification.py tests`, `fixture`, and `counterexamples`, then `verify-artifacts.py` through Python. The final verifier requires the current shared SDK typecheck and validates all preserved producer artifacts before writing an approval recommendation for this subset only.

No provider execution, installed-package, native authority, process-tree guarantee or automatic corruption repair is claimed. The leader owns card acceptance and the ledger.
