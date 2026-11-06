# Source-bound acceptance proof normalization

This directory mechanically normalizes the already approved bounded review and its current closed command receipts. It runs no product checks and preserves every historical evidence file. `review.json` is the authoritative identity/decision/source record; `commands/` contains exact original argv, exit, log identity and frozen source maps. Historical failed attempts remain sealed and receive no passing-command credit.

The B01 record remains TAIL/STORE-only. B02/B08 own-author prerequisites and broader B01 integration remain excluded where stated. B01 shared SDK typecheck preserves all original input rows while limiting implementation credit to the reviewed source map. B04 original command-array selection and frozen manifest/stability provenance are explicit.

Run `python3 docs/execution/body-roadmap/evidence/B18/post-route/acceptance-proof/normalize.py --check` for a read-only integrity and exact-origin comparison.

The two earlier B02/B08 prerequisite manifests contain stale internal runner-log seals. `uncreditedHistoricalContext` preserves their manifest identities, declared stale hashes and actual current closed-log hashes. These archives receive no command or prerequisite approval credit. The current normalized flat artifact seal uses actual current bytes.
