# Audit findings: p2-d-transactions-workflow

- Subsystems: sdk-filesystem-tools, sdk-run-lifecycle, common-tool-contracts, agent-runtime-orchestration, agents-base2-gate, scripts-determinism-guard
- Features: P2-T5, P2-T6, EV-5, ORCH-7
- Files covered: 15

## [MEDIUM] state-mutation — sdk/src/tools/change-file.ts:752 — Failed tx_commit append after a successful file commit leaves a tx_begin-only record that startup recovery will revert, destroying committed work
- **Risk:** A rare intent-log append failure (lock timeout >5s, IO error) after files were committed silently converts a committed multi-file transaction into a reverted one at next process start: startup recovery reverts every path to its durable pre-image, destroying the user's committed work while the issued receipt says committed. The fail-open logging direction chosen for tx_begin/tx_abort is safe, but for tx_commit the fail-open direction loses data.
- **Fix:** On tx_commit append failure, retry the append (bounded), or record a compensating resolved-marker before returning the committed receipt; alternatively make recoverAndRevertInterruptedTransactions verify current file hashes against the tx_begin beforeHashes before reverting (only revert paths whose current hash matches the AFTER-image implied by a lost commit).
- **Evidence:** change-file.ts:749-761 warns and proceeds; transaction-intent-log.ts:1034 (`lastEvents.get(transactionId)?.kind !== 'tx_begin'` → continue) makes a begin-only record recoverable; :994-999 a dead owner never blocks revert; revertPathToPreImage :1193 overwrites with beforeBytes. Recovery idempotence tests (transaction-intent-log.test.ts) do not cover this direction.

## [LOW] error-handling — sdk/src/run.ts:890 — Startup recovery runs once per process per workspace, not once per run; a second run() in the same process skips recovery of sibling-crash transactions
- **Risk:** PLAN P2-T5 says recovery is 'wired once per run', but the module-level transactionRecoveryPerformed Set keys on stateDir+log file, so a second run() in the same long-lived process (attach/detach, sequential runs) skips recovery: a transaction half-applied by a crashed SIBLING process is never re-examined for the life of the process. The in-code docstring honestly says 'once-per-process', so this is a PLAN-wording looseness plus a small recovery-latency gap, not a false implementation claim. The pre-aborted-signal early return in run() also skips recovery (trivial).
- **Fix:** Re-run recovery on every runOnce entry (it is idempotent and cheap: readEvents + classify) or move the Set guard to per-run scope; document the actual cadence in the PLAN entry.
- **Evidence:** run.ts:690 `const transactionRecoveryPerformed = new Set<string>()`; :692-707 run() delegates to runOnce; :695-704 aborted-signal early return precedes runOnce; :894 `if (!transactionRecoveryPerformed.has(recoveryKey))`; :685-689 docstring says 'once-per-process'.

## [LOW] correctness — .agents/sessions/polyglot-roadmap-v2/PLAN.md:91 — PLAN text mis-describes beginTransaction durability mechanics: claims 'atomic tmp+rename append', actual common path is fsynced append-only write; tmp+rename is only the trim path
- **Risk:** The landed mechanism is an append-only JSONL line write with handle.sync() plus torn-line closure, with atomic tmp+rename (writeAtomic) reserved for the bounded-trim whole-log rewrite. The landed semantics are at least as strong as described (append-only is the safer primitive), but the PLAN's mechanism description does not match the code, which matters because the PLAN is the audit normative text.
- **Fix:** Reword the PLAN note to 'fsynced append-only JSONL append; atomic tmp+rename reserved for the bounded trim rewrite'.
- **Evidence:** PLAN.md P2-T5 entry (transaction-intent-log.ts:711-769 appendEventLine appends one line + handle.sync() + torn-line newline closure; :771-801 writeAtomic tmp+fsync+rename used only when boundedLines !== candidateLines).

## [LOW] api-contract — .agents/sessions/polyglot-roadmap-v2/PLAN.md:92 — P2-T6 checked [x] on a headline ('drives the gate') the bounded slice deliberately did not achieve; transitionBase2GateSafe is production-unconsumed and base2 still swallows via the old local-catch path
- **Risk:** The bounded-slice scope note and the workflow-engine.ts:1-15 ADVISORY/TELEMETRY-ONLY header are honest and mutually consistent (promotion 'would require moving the gate decision here'), but the checked headline still reads 'drives the gate', which the slice explicitly did not do. Also transitionBase2GateSafe is exported but production-unconsumed (only workflow-engine.test.ts references it); base2.ts:7389-7404 still calls the throwing controlPlane.transitionBase2Gate inside its own local try/catch, leaving the prior state in place on illegal transitions — exactly the 'wiring rides a later slice' state the PLAN declares, so the PLAN is honest about base2, but the [x] on the unachieved headline is generous.
- **Fix:** Either keep the checkbox unchecked until the gate moves (separate sub-slice id), or retitle the headline to the bounded slice's actual deliverable; optionally adopt transitionBase2GateSafe in base2's telemetry path in the later wiring slice as planned.
- **Evidence:** workflow-engine.ts:1-15 header ('Do not reroute the base2 gate through this engine... promotion... would require moving the gate decision here'); :170-186 transitionBase2GateSafe + referencedBy showing only the test consumer; base2.ts:7383-7404 emitGateTelemetry's local try/catch; PLAN.md:92 scope note matches the header honestly.

## [LOW] correctness — sdk/src/tools/change-file.ts:607 — Durable pre-image vs in-memory rollback divergence verified closed for bytes+mode; residual scope is metadata beyond stat mode
- **Risk:** The prompt-asked divergence is closed for the documented scope: tx_begin entries carry beforeBytes AND beforeMode (with an explicit +x-bit comment), move destinations are recorded with beforeHash:null so revert deletes them, and revertPathToPreImage restores content then mode via fs.setMode with a fail-closed containment guard (resolveProjectPath scope:'project' refusal). Residual: metadata beyond permission bits (symlink targets, extended attributes, directory metadata) is carried by neither the durable pre-image nor the documented in-memory rollback scope; rollbackPreparedTransactionChange internals were not line-verified in this shard.
- **Fix:** None required for the audited scope; if rollbackPreparedTransactionChange ever grows metadata restoration (symlink targets, ACLs), mirror it into TransactionIntentEntry in the same slice.
- **Evidence:** change-file.ts:617-627 ('MODE IS PART OF THE PRE-IMAGE') and :646-651 (beforeMode on non-move entries); :630-635 move destination `{ path: change.destinationPath!, beforeHash: null }`; transaction-intent-log.ts:1149-1174 containment guard docblock + :1169-1173 refusal; :1193-1201 writeFile then setMode best-effort.

## Coverage receipt

### Subsystems
- sdk-filesystem-tools
- sdk-run-lifecycle
- common-tool-contracts
- agent-runtime-orchestration
- agents-base2-gate
- scripts-determinism-guard

### Features
- P2-T5
- P2-T6
- EV-5
- ORCH-7

### Files
- .agents/sessions/polyglot-roadmap-v2/PLAN.md
- common/src/tools/results/filesystem.ts
- common/src/tools/results/__tests__/filesystem.test.ts
- common/src/tools/params/__tests__/x1-golden-vectors.test.ts
- sdk/src/tools/transaction-intent-log.ts
- sdk/src/tools/change-file.ts
- sdk/src/tools/filesystem-authority.ts
- sdk/src/run.ts
- sdk/src/services/acp/session-data.ts
- sdk/src/tools/__tests__/transaction-intent-log.test.ts
- sdk/src/__tests__/change-file.test.ts
- packages/agent-runtime/src/orchestration/workflow-engine.ts
- packages/agent-runtime/src/orchestration/__tests__/workflow-engine.test.ts
- agents/base2/base2.ts
- scripts/determinism-guard-baseline.json

### Domains
- correctness
- state-mutation
- error-handling
- api-contract
- test-coverage
