# B36 current integration reattestation

The original B36 implementation author (`/root/b04_lock_cas`) produced this evidence-only reattestation. This is **not a new independent review of that author's diagnostic implementation**. The diagnostic truth approval belongs to `/root/b03_mutation_evidence` at `../independent-review/manifest-check.json`. The current reviewer independently reviewed the later shared SDK terminal-approval/cancellation integration through B02 and now preserves that review together with the original diagnostic approval. Card acceptance remains leader-owned. If the acceptance gate requires a wholly independent current-card reviewer, this bundle is ready for that review and cannot substitute for the reviewer.

All 15 original B36 source hashes were compared. Only `sdk/src/run.ts` differs from the original independent review; all 14 diagnostic/helper/test/schema/CLI files retain their reviewed bytes. No source differs from the existing author-written `../final-binding/manifest.json`. Current B02 independent evidence seals the same shared SDK source hash. The new verifier checks the original producer artifacts, original independent artifacts, previous author refresh and B02 artifacts without changing them.

`prior-reviewed-run.ts` is an inert reconstructed source snapshot, never executed. It was reconstructed from the original independent review's immutable integration patch and its Git preimage blob; its SHA-256 equals the reviewed source hash. `shared-integration-delta.diff` is the exact difference from that snapshot to current `sdk/src/run.ts`. Its hunks only change terminal approval handling: complete effect roster, push branch resolution, execution-context-bound grant/consume, complete-parser risk classification, post-approval cancellation and workspace-staleness refusal. No diagnostic baseline, hook dispatch, mutation retention or CLI classification hunk changed.

Fresh checks pass against current sources:

- SDK mutation dispatch: **22 tests, 143 assertions**, including six actual SDK baseline retention/invalidation controls.
- Diagnostic fixture: **12 actual child→delta→hooks→SDK JSON→CLI cases**.
- SDK typecheck: **exit 0** with actual `tsc --noEmit -p .` output.

The fixture's only passed classifications are complete empty/pre-existing/shifted observations. Severity escalation remains `new_errors`/failed; timeout and cancellation remain failed; missing tool/language and exit127 remain unavailable/unknown; capped output is incomplete/unknown; partial and opaque output remain unknown. The verifier checks each named case and its expected SDK status and CLI classification. The existing fixture replaces diagnostic commands with fixed local programs; it does not run ecosystem validators or provider requests.

Every new command uses pinned Bun 1.3.5 by exact executable/hash, `--no-env-file`, absolute source paths, a replacement environment with an empty temporary HOME/XDG directory and an explicit empty provider configuration. No inherited credentials or external forwarding environment enters these runs. Receipts retain argv, times, exit, log digest and equal before/after source hashes. The fixture's legacy `toolchain.bun` field is Node ABI `process.version`; command receipts establish the actual Bun version.

The earlier 188-test independent review and ten independent postimage controls remain historical evidence for unchanged code. They were not rerun here or relabeled as fresh. The declared tier remains real fixed diagnostic children through source SDK/CLI consumers and baseline retention. No installed-package, actual ecosystem-validator, model/provider, native/OS fencing, full descendant cleanup or universal execution-context assurance is added.

Run `python3 run-verification.py integration-tests`, `fixture`, and `sdk-typecheck`, then `python3 verify-artifacts.py` from this directory. The verifier checks current source equality and prior artifact integrity before recording the recommendation to preserve the declared diagnostic truth tier with the stated authorship boundary.
