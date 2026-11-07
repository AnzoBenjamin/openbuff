# Managed agents CI repair

The managed pre-push Step K runs bare `bun test` from `agents`, discovering
56 test files. The historical package-script check runs `bun test __tests__`:
its 1,284-pass receipt covers 45 unit files and is preserved unchanged.

The only product edits are the two fixtures documented in [REPORT.md](REPORT.md):

- `agents/e2e/gate-aux-ordering.e2e.test.ts`, SHA-256
  `55025516bc70e95b004eeebc63edf02960cb7a77b6d37995620556c0d33bb890`.
- `agents/e2e/gate-lifecycle.e2e.test.ts`, SHA-256
  `18b520dac8e37ba860f3c3b0eab0574a12493f481054748807456d3de085ae87`.

Their valid synthetic reviews now include all five assessments and requirement
evidence. Adverse stale/false-attestation controls retain the required retry
sequence and prove no premature finding or gate credit. The final targeted
control passes 32 tests and 787 assertions; agents typecheck, formatting and
whitespace checks pass. [Independent semantic review](independent-fixture-review/REVIEW.md)
approves these exact fixture bytes. Neither fixture has an active acceptance
binding or a frozen inventory entry, so the live ledger and historical proofs
require no renewal for this repair.

The first full-suite recorder returned 1,358 pass, 5 skip and 1 fail. A second
recorder with explicit empty provider configuration and a parent fetch barrier
returned the same result. Both complete failed logs/receipts remain unchanged.
Only `file-explorer.e2e.test.ts` failed; both repaired gate files passed.

The [diagnostic](diagnostic/observations.jsonl) identifies the actual rejected
boundary: the supervised file-lister cannot listen on its local Unix socket
inside the filesystem sandbox. The preliminary default-model hypothesis was
disproved: both original and explicit-model diagnostic controls reach this same
socket failure with zero fetches. The failed diagnostic assertions are retained
and receive no positive test credit.

The [unchanged original file-picker replay](after-file-picker/receipt.json),
executed with required sandbox escalation, passes all four tests and 15
assertions. No model, import, assertion or other source byte in that fixture was
edited; its SHA-256 remains
`b7ac93cac7f1fd2e1d38334ffaf483c473b9e1e5cb7b1a97a1f78c2238d8c48b`.

The [complete replay outside the sandbox](full-agents-unrestricted/full-agents.json)
passes **1,359 tests, 5 skips, zero failures and 9,109 assertions across 56
files**, using pinned Bun 1.3.5 and all source hashes unchanged during execution.
Its parent fetch barrier reports zero requests. This observation covers that
barrier's process; it does not claim universal child-network confinement. The
five skips are the existing slow base-deep integration scenarios. The
[independent full-suite review](full-suite-review/REVIEW.md) verifies all 56
discovered paths, counts, raw logs and 135 stable/current declared inputs. This
is fresh CI validation, not acceptance of an additional body card.

Earlier push output in `push-capture.partial.log` is explicitly incomplete and
does not replace the complete targeted or full-suite logs. Frozen plan,
specification, validator, ledger, archives and publication inventory remain
unchanged. The installed CLI and its accepted bundle were not rebuilt.
