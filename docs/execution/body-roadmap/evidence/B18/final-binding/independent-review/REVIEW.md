# B18 independent review against frozen current sources

Recommendation: **approve B18 exact command/approval identity within its declared cooperative TypeScript and actual source-consumer tier**. No blocking finding remains. Card acceptance and prerequisite acceptance belong to the leader.

Reviewer: `/root/b02_runtime_outcomes`. The reviewer made no B18 command-identity, approval-service, launcher, policy, bridge, or store implementation/test edits. The reviewer authored consumed B02 runtime cancellation fixes and B08 provider fixes. The current SDK observations exercise those prerequisite boundaries but **do not independently approve the reviewer's own changes**. Their independent source review and acceptance belong to other lanes and the leader. The leader confirmed there was no separate prior B18 independent-review artifact; this is the first full independent B18 review. The original producer evidence remains intact.

## Source binding and authority

Exactly one of the producer's 22 original source/test/fixture bindings changed: `sdk/src/services/local-harness-store.ts`, from `95a219cbfc8175114587a819f37295791d64bd36df2fe6e6c986ec9786b4a91a` to `390668ee7b67ed33d830e72c714ea66d7e43339d78f80a852942af9b0e506ba2`. The delta changes direct corrupt-record reads and persistent quarantine diagnostics. The existing B01 tail/store independent review already binds and approves that current store hash for its bounded subset; its manifest is preserved and referenced here. All other original B18 bindings match the producer exactly.

Source review confirms the command SHA256 covers the original UTF-8 input in `harness-enforcement.ts:185`; display normalization does not define approval authority. The effect roster is evaluated in `harness-enforcement.ts:1143`, and malformed input remains refused even under allow-all. `HarnessApprovalService.consume` holds the kind lock over read/compare/write and checks action, target, command hash, execution-context hash, workspace, root run, snapshot, expiry, and prior consumption before recording consumption. `run.ts:2853` uses the trusted current root run and snapshot, and checks cancellation and snapshot drift after the host's awaited approval. The terminal launcher checks its profile before authorization, mints an internal WeakMap token, consumes it once, verifies the command/context identity, and reevaluates profile policy on the approved rerun (`run-terminal-command.ts:1281`). Public metadata cannot manufacture that token. The ACP bridge preserves command/context hashes while explicitly disclosing capped display (`serve/bridge.ts:1021`).

The selected SDK fixture supplies an explicit programmatic agent. These consumers do not load the shipped base2 implementation. Broader B01 specialist/base2 and integration binding remain leader-owned.

## Current execution and independent replay

All commands use the SHA256-pinned Bun 1.3.5 binary, `--no-env-file`, absolute test paths, a scrubbed parent environment, and owned home/provider configuration. The actual fixtures install a fetch barrier before runtime imports and use child environments with `inheritEnv:false`. No live provider, OAuth endpoint, paid inference, remote Git effect, deployment, or package installation was used.

- **180 affected tests, 0 failures, 1,289 assertions across six files**: exact command identity, approval service, terminal/profile policy, reverse ACP approval bridge, and the changed local store. Current SDK typechecking and selected-source whitespace checks pass.
- **Seven actual serialized SDK cases**: compound declined and approved, force push declined, cancellation during approval, repeated command requiring a fresh decision, routine feature push, and deliberate allow-all. The cancelled case reports `termination: cancelled`, no execution trace and no grant/receipt. Approved/repeated cases each preserve exactly one effect trace and one consumed scoped disk receipt; the repeated command asks twice. All cases have zero fetch calls.
- **13 actual launcher/policy cases and 17 parser corpus cases**: denied commands have no trace; approved/allow-all cases execute only harmless local command doubles. The parser corpus uses `bash -n` only for syntax checks. Current behavior matches the preserved producer observations.
- **Four independently authored corrupt-approval consumers**: invalid JSON, invalid record schema, missing diagnostic sidecar, and corrupt diagnostic sidecar. Each refuses all three consumption attempts across fresh store instances, preserves the corrupt bytes in quarantine, and reports no consumed corrupt record. Both sidecar cases use a valid `.tmp.` approval id; missing-sidecar evidence remains discoverable beside an unfinished atomic sidecar file.
- **Seven independent healthy mismatch controls**: changed quoted-space bytes, reordered compound, workspace, run, snapshot, allowed-path order, and cwd. Every mismatch preserves the record bytes; the matching approval consumes once at revision 1 and a fresh service instance rejects reuse.

`assess.py` independently recomputes command and execution-context hashes with Python, reopens effect traces and persisted approval records, compares all SDK/launcher/parser behavior to preserved historical observations, and rechecks quarantined bytes. It passes all 41 consumer/corpus cases plus seven healthy mismatch controls.

The original **134 passing runtime/handler tests** are preserved and their source and implementation hashes remain identical to the original B18 producer binding. Those unchanged suites were not rerun as a source-delta check; the current SDK cancellation case exercises the actual generator/runtime path. This does not grant independent approval of reviewer-authored B02 code.

## Final evidence and limits

Every command receipt binds argv/cwd, start/end time, exit status, its closed log hash, the owned environment policy, and before/after current source hashes. `final-sweep.json` is written after every subprocess and command log has closed. The final manifest binds all review artifacts, original producer manifest/artifacts, the B01 store review reference, and consumed source/config hashes. No historical producer/review, production, test, generated contract, or ledger artifact was edited by this lane.

The scanner covers a bounded shell subset and recognized command families. The effect roster is conservative and does not assert actual execution order or a complete shell AST. Unsupported interpretation requires approval except deliberate allow-all. The policy, store lock, and internal token mechanisms remain cooperative TypeScript authority; this review establishes neither OS isolation nor universal process-tree or cross-process fencing. Harmless local command doubles establish source consumer behavior, not real remote effects, native parser authority, provider operation, or installed-package compatibility.

Read-only final verification:

```sh
python3 docs/execution/body-roadmap/evidence/B18/final-binding/independent-review/verify.py --check
```
