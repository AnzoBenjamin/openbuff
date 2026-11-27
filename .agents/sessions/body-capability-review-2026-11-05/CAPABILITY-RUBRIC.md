# Capability review rubric

## Product question

Can a configured model observe the relevant state, choose an action, execute it, inspect the result, recover from failure, retain useful knowledge, and improve on subsequent tasks without the harness silently losing state or pretending an incomplete operation succeeded?

The model owns reasoning and action selection. The body owns deterministic execution, observations, lifecycle and resource limits, evidence, persistence, policy enforcement, and usable human controls. Agent prompts can suggest workflows but cannot substitute for those runtime guarantees.

## Macro inventory axes

| Body responsibility | Present capabilities to trace | Missing capability questions |
|---|---|---|
| Observe | filesystem, outlines, retrieval/graph, environment/build intelligence, diagnostics, image/browser/3D observations | Are observations fresh, provenance-bound, complete or explicitly limited? Can the model inspect a large result later? |
| Act | transactional edits/refactors, shell/jobs, hooks, Git, browser/MCP/custom tools | Do actions preserve bytes and verify exact preconditions? Are interactive and persistent processes real supervised capabilities? |
| Control a run | streaming, budgets, cancellation, typed errors/retries, approvals | Can every operation terminate, be cancelled, and explain what happened? Does the human see real state? |
| Continue | journals, checkpoints, replay/resume, snapshots/undo, attach | Does an actual killed run resume safely? Are uncertain external effects replayed or reconciled? |
| Coordinate | subagents, task records, workspace leases, supervision/lanes | Do ownership and cancellation survive process boundaries? Does a child result represent committed truth? |
| Remember | compaction retention, archive recall, memory/lessons, semantic retrieval | Do relevant constraints and evidence survive repeated compactions and a process restart? |
| Learn | task/outcome traces, evaluations, statistics, promotions, routing | Does any closed loop change behavior and prove held-out improvement? Is memory accumulation being mistaken for learning? |
| Govern | explicit policy, process environments, sandbox, secret controls, provenance | What is enforced by an OS boundary, by cooperative code, or merely by a prompt? Are all effect paths covered? |
| Connect | CLI/TUI, SDK/headless, ACP/MCP, plugins/hooks/sidecars | Do clients use one canonical session and capability truth? Are errors/lifecycle consistent across transports? |
| Cooperate across languages | registry/grammars, LSP/SCIP, build/test graph, foreign capabilities, schema/ABI boundaries | Can one task cross component/language boundaries with correct interface and validation evidence? Is 'generic' coverage honest? |

## Maturity is not assurance

Maturity: usable / partial / unwired / absent / unknown. Assurance: static trace / unit test / integration / live task. A usable helper can have only static assurance; a unit-tested helper can still be unwired. A green file inventory does not prove a usable feature.

For each capability, assess discovery, runtime wiring, semantic correctness, failure/loading/empty/cancellation/retry/permission states, durability/ownership, scale, test adequacy, public contracts, and cross-language cooperation. Cite evidence, mark inference, and say what remains unknown.

## Meaning of 'best possible'

An implementation is good enough to graduate only against a declared workload and quality envelope: deterministic correctness and byte preservation; failure and cancellation guarantees; successful task rate; unnecessary human interruptions; latency/cost/memory; recoverability; maintainability; installation/platform compatibility. Use baselines and comparable tasks. Do not treat complexity, more languages, or more unit tests as quality metrics.

## Polyglot distinctions

Implementation languages: choose language to unlock a concrete capability or measured advantage; one authority for the run and effects; existing ecosystem tools before new ports. Source fixture extensions do not count as authored implementation.

Target languages: generic text/shell fallback is broad but shallow. Advertise separately: read/edit/execute, syntax, semantic navigation/refactors, diagnostics/build/test, cross-language interface validation. A grammar is not a compiler; a language server is not a full project validation strategy. Unsupported capabilities must be observable and extendable.

Cross-language cooperation: prove tasks that change a contract and follow its consumers, e.g. TypeScript host ↔ Rust sidecar ↔ Python analyzer over a versioned protocol, and target projects whose TypeScript/Python/Rust components share generated schemas or ABI contracts. Use immutable artifact/diagnostic references, document versions, agreed position/byte encodings, cancellation, typed errors, capability negotiation, and effect receipts across every boundary.

## Plan completion rules

Every work package needs a current trigger/problem, source anchors, intended behavior, smallest implementation/integration scope, prerequisites, relevant language decision, behavioral acceptance probes, regression checks, observable completion evidence, and a stop/defer rule. No 'done' for a scaffold, unused helper, skipped native path, optional feature never exercised, or historical prose claim.

Keep a short ready queue and explicit dependency graph. Map all 120 historical tasks to verify/retain, integrate, split, consolidate, defer, or retire. Preserve working machinery. Resolve root causes before adding surfaces that multiply them. Strong runtime behavior can be repaired in TS immediately without waiting for a language migration.
