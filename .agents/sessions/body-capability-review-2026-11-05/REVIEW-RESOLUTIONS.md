# Independent review decisions and resolutions

Both independent gates are complete: a dedicated Architect review followed by a separate Critic review. Review decisions concern the planning artifact and prospective acceptance contracts; they do not establish repaired product behavior or measured model gains. Historical round-1 objections remain in [the review archive](review-rounds).

| Gate | Decision | Reviewed basis |
|---|---|---|
| Requirements advisory | Revisions incorporated | [REQUIREMENTS-REVIEW.md](REQUIREMENTS-REVIEW.md); requirement/feedback mappings in [PLAN.md](PLAN.md) and [SPEC.md](SPEC.md). |
| Dedicated Architect, round 2 | APPROVED | [ARCHITECT-REVIEW.md](ARCHITECT-REVIEW.md), including exact input hashes and reopened current implementation anchors. Exact reviewed plan/spec inputs remain in the round-2 archive. |
| Independent Critic, round 2 | APPROVED | [CRITIC-REVIEW.md](CRITIC-REVIEW.md) verifies the frozen editorially corrected plan/spec, completed Architect result, current implementation/package seams, exact historical declaration preservation and complete lineage. No root self-approval is recorded. |

## Resolved design objections

| Feedback | Resolution and evidence in the plan |
|---|---|
| Competing TS/native authorities | B22/SPEC select one physically bound repository backend/epoch, common participating admission and held authority through effects; skew/outage cannot reactivate TS writes. Unaware binaries and external full-access effects retain explicit conflict/reconciliation limits. |
| Imports before corrected producers | M22-CORE admits only its bounded fresh baseline; M22-TXN requires B05/B07; M22-CHILD also requires B16; B22 requires all three current receipts and populated transition cases. The canonical graph and mechanical validator check all-of dependencies. |
| Unsupported filesystem-wide atomicity | B06 enumerates supported/refused operations and zero-write complete preflight; execution is guarded sequential work with truthful partial/uncertain/recovery/conflict state. |
| Current diagnostic truth delayed by integration | B36 has no prerequisites and is the first worker rotation after B02/B03/B04. B27 consumes its result for deeper language coverage. |
| Replay and arbitrary generator state | B15/B29 require a verified ordered prefix and recorded reconstruction inputs. Changed bundles, missing records or unknown mutable/nondeterministic state refuse automatic replay while ordinary trusted execution remains usable. |
| Limits and uncertain spending | Selected scope deadlines require observed termination; unknown/failed usage retains reservations under strict or explicitly estimated admission, with separate uncapped choice. No exact remote-billing guarantee is inferred. |
| Learning and language proof | Actual authored TS→Rust cooperation is independent of target TS/Rust/Python schema and C/Python ABI tests. Learning requires complete paired held-out evidence, real adoption and rollback. |
| Bootstrap and user choices | Tool acquisition precedes locked/offline assurance; missing tools stay unavailable. Explicit routes, custom strategies, local/BYOK and selected full access remain supported. |

## Editorial changes after the Architect result

[FINALIZATION-CHANGES.json](FINALIZATION-CHANGES.json) records before/after hashes. The root corrected B19's SCIP citation to `packages/indexer/src/scip-runner.ts:322`, corrected current coverage references/counts, and moved review-status wording into this ledger. No task dependencies, acceptance contracts, product source or recovered observations changed. The completed independent Critic verified these exact editorial differences and approved the current frozen hashes. No blocking or additional nonblocking revision remains.

The Architect input renderings are [02-PLAN-REVIEWED.md](review-rounds/02-PLAN-REVIEWED.md) and [02-SPEC-REVIEWED.md](review-rounds/02-SPEC-REVIEWED.md). Their exact reviewed bytes are also retained as [plan input text](evidence/02-PLAN-REVIEWED.md.txt) and [specification input text](evidence/02-SPEC-REVIEWED.md.txt), matching the Architect's input hashes. Delivery rewrites local links in Markdown renderings; the text captures preserve original bytes. Recovery manifests remain frozen records of their earlier restored state; finalization changes and the publication manifest identify later editorial/delivery transformations separately.

## Assurance and delivery boundaries

Mechanical checks validate structure, lineage, selected source bindings and local artifact links. Structural inspection is complete for the declared audit scope; native feature readiness remains `complete=false`. [SOURCE-STABILITY.md](SOURCE-STABILITY.md) retains the missing historical whole-byte map, exact surviving window agreement, and current-binding limits. Planning completion and implementation card acceptance remain independent.

## Final planning decision

The dedicated Architect and independent Critic both APPROVED the planning artifact. The Critic verified 36 cards/39 completion nodes, 120 exact historical declarations and mappings, all 118 finding Trace identities and all 144 vertical catalog keys. Its four frozen input hashes agree with PLAN-VALIDATION.json. Every implementation card remains open until its own acceptance evidence passes; neither review activates execution. Final delivery preparation and the publication receipt record packaging/copy state separately.

The [Critic input manifest](evidence/02-CRITIC-INPUTS.json) binds exact text captures of all four final reviewed inputs. These preserve the original reviewed bytes while delivered Markdown uses canonical names and links. The publication manifest retains original-capture and delivered hashes separately.
