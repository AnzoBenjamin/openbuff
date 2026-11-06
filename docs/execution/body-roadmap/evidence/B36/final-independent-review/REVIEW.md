# B36 final independent countersignature

**Decision: approve the declared B36 diagnostic-truth tier at the current 15-file source binding.** Card acceptance and ledger integration remain leader-owned. This is an independent countersignature of the implementation-author-affiliated `current-independent-review`, not a claim that its product checks were independently rerun.

Reviewer `/root/b03_mutation_evidence` authored B36's original independent review, not B36's implementation or the root-owned shared `sdk/src/run.ts` approval/cancellation changes. The reviewer separately authored B01 tail/store work; this decision grants no approval to that work, B01 specialist gates, or any other prerequisite/card implementation.

All 15 current source hashes equal B36's prior `final-binding`. Fourteen equal the original independent B36 seal; only `sdk/src/run.ts` changed. The verifier independently reconstructed the original `run.ts` by applying 28 exact-context hunks from the immutable original integration patch to Git blob `19985bd40`. The resulting SHA-256 is `209930b25ff04ff6827e402f457caada8d4dfe4c1b91f22ef745ef5ee4d6829c`, matching the original independent seal and the current producer's supplied snapshot. The independently generated current delta matches the supplied diff exactly, with five unified hunks inside one terminal authorization callback. Current `run.ts` SHA-256 `c80be3b62a436b92b851cde37d00ae569b860b33ffee597016e0462715fa7562` equals B02's current independent seal.

The shared callback now evaluates every classified effect, resolves push branches per effect, displays the complete effect roster, and uses execution-context identity when granting or consuming approvals. Routine risk requires a complete parse and an entirely routine roster without push risks. After awaiting approval it checks cancellation before granting, rejects workspace snapshot drift, and re-evaluates the complete policy. The surrounding terminal launcher checks cancellation before execution and binds its one-shot approval token to the same execution context. The service's receipt comparison includes execution context. These reviewed changes do not alter diagnostic capture, baseline reuse, diagnostic delta/hooks, SDK diagnostic projection, or the CLI diagnostic classifier. This review establishes preservation of B36's declared tier; it does not graduate the general terminal enforcement system.

The fresh `/root/b04_lock_cas` receipts bind the same 15 hashes before and after each command, the pinned Bun 1.3.5 executable and its hash, closed logs, exit statuses, and an explicit replacement environment with empty provider configuration and disabled Bun env-file loading. Independent parsing confirms **22 passing tests, zero failures, 143 assertions, one file**, plus SDK typecheck exit zero. The SDK diagnostic fixture contains 12 cases, with 19 child launches; zero-launch missing-language and unknown cases remain coverage controls rather than claims of actual child execution. The fixture's legacy `toolchain.bun` value is `process.version` (Node ABI), so actual Bun identity comes from the command receipts.

The independent oracle checks each recorded SDK result, CLI classification, launch count, and underlying command metadata rather than trusting the fixture's `expectedStatus` field:

| Case | SDK diagnostic status | CLI classification | Child launches |
| --- | --- | --- | --- |
| empty | passed | passed | 2 |
| preexisting | passed | passed | 2 |
| shifted | passed | passed | 2 |
| severity-escalation | new_errors | failed | 2 |
| timeout | failed | failed | 2 |
| exit127 | unavailable | unknown | 2 |
| cancelled | cancelled | failed | 1 |
| missing-tool | unavailable | unknown | 2 |
| missing-language | unavailable | unknown | 0 |
| capped | incomplete | unknown | 2 |
| partial | unknown | unknown | 2 |
| unknown | unknown | unknown | 0 |

Observed empty results retain complete coverage and zero diagnostics. Pre-existing errors remain present in both observations; harmless line shifts remain passed, while warning-to-error escalation produces a new-error result. Timeout, cancellation, exit 127, missing executable/language, capped streams, partial parser input, and unknown observations retain unsuccessful evidence. No unsuccessful case becomes passed at the CLI consumer. B02's independently sealed actual approval fixture additionally retains seven cases; cancellation produces a cancelled run/action, no effect trace, and no approval grant. Its receipt binds the same current `run.ts`.

The verifier checks **338 sealed artifact hashes** across current/prior B36 and supporting B02 receipts, including the original independent oracles. All **69 pre-existing B36 evidence files** remain unchanged. The original independent 188 tests and ten postimage controls are preserved historical evidence and were not rerun. No production, repository test, old evidence, or ledger files were written by this lane.

Approved scope: real fixed diagnostic children → delta/hooks → source SDK dispatch/JSON → CLI classifier, retained source-SDK client baselines and actual Node bounded reads. Native validators/toolchains, live providers/models, installed-package consumers, OS isolation, descendant-death enforcement, and broader terminal/process guarantees remain outside this recommendation. Descendant enforcement belongs to B20. No provider/model capability or prerequisite implementation receives an approval here.

`verify.py` performs evidence-only integrity and oracle checks and writes only within this new directory. `seal.py` closes the independent artifacts and repeats the source/prior-evidence hash sweep before writing `manifest.json`; neither executes product tests, fixtures, or typechecks.
