# B19 current-source supplement — 2026-11-07

Status: preparation only; no implementation, test execution, dependency acceptance, or card acceptance. Author: `/root/b04_lock_cas`. The date is the workspace's Africa/Kampala date; the manifest records UTC capture times.

This supplements the existing [mapping](README.md), [source manifest](source-manifest.json), and [proposed validation](proposed-validation.json). Those three artifacts are preserved. Scope remains PLAN B19 and SPEC's ten launcher families, with the evaluator, trusted-module, and detached-parent boundaries requested by the leader. This is not another broad subprocess audit. Retrieval tools were not available; bounded source reads and `rg` were used.

## Current binding and ranked findings

**Evidence, high confidence:** all 42 production sources and all eight references in the original manifest match their recorded hashes. The installed MCP stdio transport also matches. Of 29 test bindings, 28 match; only `sdk/src/__tests__/3d-assets.test.ts` changed, from `bcc2938beb2619641aff4079b827148a4b21c34e252c25bcb32b319ecf4f6fd4` to `860625f3470d13a8d1462878cd2fc75878694b5cf3ab642662ca8cc372937447`. Its separately documented fixture timeout correction is in `integration/3d-commit-ci-regression/`. It does not change the Blender launcher mapping or establish B19 acceptance.

| Rank | Finding | Classification and consequence |
|---|---|---|
| 1 | The earlier ten-family context gaps remain current. | Evidence: all mapped production hashes match. Inference: reuse the original mapping and allocate actual adapter work only after prerequisite acceptance. |
| 2 | Evaluator code already distinguishes key-free environment from trusted execution, but does not consume a shared launch context. | Evidence: sources below. Inference: preserve the B30 repairs and add B19 context at the actual setup/worker/final-check/diff boundaries; cleanup proof belongs to B20. |
| 3 | Trusted generators execute in the host, and asynchronous background agents retain parent-linked state. | Evidence: materialization, generator call, allocation and signal composition below. Inference: context propagation must not imply arbitrary-JS confinement or that parent return transfers resource ownership. |

The new manifest binds additional sources and records comparison results. Source binding is a point-in-time preparation record, not a source freeze or independent approval. Evaluator files remain leader-owned and may move while B30 integration finishes.

## Additional source-bound boundaries

### Evaluator commands and isolated SDK worker

**Evidence:** `evals/buffbench/evaluation-environment.ts:8` selects `trusted_task` or `key_free_environment`. Trusted mode merges ambient and supplied env. Key-free mode creates an owned temporary HOME/XDG/TMPDIR and rejects supplied names matching its credential suffix expression; it does not use B19's canonical/configured credential roster. Its header explicitly excludes OS filesystem/network confinement. `agent-runner.ts:183` selects a 60-minute parent signal; `:193` gives setup replacement env and signal; `:224` passes the signal into the runner. Key-free external CLI runners are refused (`:179`).

The concrete sublaunchers inspected are:

| Boundary | Current implementation evidence | B19 acceptance addition |
|---|---|---|
| Repository setup | `evals/subagents/test-repo-utils.ts:92` resolves env; `:99`, `:103`, `:108` launch Git clone/fetch/checkout with env/signal. `:25` prechecks cancellation before the init shell launch. | Bind evaluator owner, admission and requested/available/active/enforced facts to each setup action; consume captured env and remaining parent deadline. |
| Isolated SDK worker | `evals/buffbench/isolated-sdk-client.ts:112` prechecks cancellation; `:113` launches the actual worker with `--no-env-file`, owned cwd, replacement env and a POSIX process group. `:193` subscribes to cancellation and `:202` removes it after close. | Carry the same context identity and truthful environment-only tier across the JSON request/worker boundary. No host callback or arbitrary module serialization is authorized merely by a parsed context. |
| Final checks | `agent-runner.ts:35` actually spawns; `:386` resolves evaluation env; `:418` defaults checks to ten minutes; `:553` forwards parent abort and `:566` passes env/cwd/signal to capture. Results retain passed/failed/timed_out/cancelled (`:583`). | Pre-aborted, expired, denied and unavailable cases must prove zero actual launches; add owner/profile/admission and remaining-budget evidence without replacing typed B30 outcomes. |
| Post-run diff | `evals/buffbench/runners/codebuff.ts:205` and `:210` synchronously run Git add/diff with the selected env. No signal/timeout option is supplied there. | Include these effects in the evaluator roster. Select a cancellable route or report the synchronous cancellation limitation; an unused signal field is not acceptance. |

**Evidence:** the current final-check helper waits for child `close`, reads file-backed output, and then checks a 10 MiB string-length limit (`agent-runner.ts:43–51`). This is a post-exit capture check, not evidence of a live output/storage limit. The isolated worker clears escalation after leader close (`isolated-sdk-client.ts:203`).

**Inference, high confidence:** neither leader-close observation nor temporary-directory cleanup establishes descendant termination. B19 must retain separate cleanup state; B20 owns surviving-descendant, no-late-write, drained-output and retained-kill-authority controls. Do not revive the canonical PLAN's older line-specific evaluator allegation as if it describes the now-edited helper. This supplement executed no process experiment and makes no claim about actual descendants.

**Boundary:** external CLI internals and the separate `withTestRepoAndParent` path were not analyzed as a new evaluator-wide audit. Any expanded evaluator implementation must name those additional producers explicitly instead of treating this selected path as full coverage.

### Trusted modules and the real custom-strategy consumer

**Evidence:** `sdk/src/agents/load-agents.ts:168` defaults project-agent loading off. Loaded modules are dynamically imported (`:329`); `handleSteps` is stringified (`:221`) and default provenance stamped local (`:234`). `packages/agent-runtime/src/run-programmatic-step.ts:396` checks permitted string provenance, `:411` reconstructs via `new Function`, and `:508` calls the generator with agent state, prompt, params, logger and config. Tool execution remains mediated through the runtime (`:1088`). `sdk/src/custom-tool.ts:5` exposes only optional signal; override v1 at `sdk/src/run.ts:291` contains ABI version and signal.

**Inference, high confidence:** the phrase "secure sandbox" in `docs/agents-and-tools.md:11` is not proof of OS confinement of trusted host JavaScript. A declared-tool allowlist governs yielded tool dispatch; it does not intercept direct host operations. Document actual full access and any unavailable requested enforcement. B19 must not narrow or prescribe a custom strategy's next task action.

The smallest B19 control uses a self-contained trusted custom strategy through the real `OpenbuffClient.run` path, chooses ordinary read/edit/terminal actions itself, and proves effects and SDK receipts under explicit full access with zero provider calls. A second run requires an unavailable enforcement capability and must refuse before the affected target launch. Give the fixture a selected model/agent route and a conflicting recommendation; assert the actual selected route wins. `sdk/src/provider-config.ts:1867` explicitly keeps recommendation outside configured route resolution.

**Boundary:** imported helpers, captured closures, compiled/supervised bundle reconstruction and replay eligibility belong to B29/B15. This B19 control cannot establish bundle fidelity. The leader owns public context/schema changes and `sdk/src/run.ts`; adapter work must not edit them independently.

### Detached work and parent cleanup

**Evidence:** `packages/agent-runtime/src/tools/handlers/tool/spawn-agents.ts:513` allocates background jobs with trusted session/root/parent ownership. `:567` combines parent and job signals; `:610` launches the coroutine without awaiting it and threads `backgroundJobLink`. Settling cleans combined-signal listeners (`:698`, `:808`) and releases path leases (`:784`, `:870`). The background adapter uses the common registry and declares process-scoped, non-disk-recovered state (`util/background-agent-jobs.ts:34`); its owner extends `JobOwner` (`:140`).

The terminal path is distinct: `sdk/src/tools/run-terminal-command.ts:1512` starts a background shell with owner/env and `:1523` subscribes to parent abort only when `detach` is false. A background shell is a process group; a background agent is an asynchronous coroutine that may itself use the supervised process seam. These are different lifetime boundaries.

`sdk/src/run.ts:1992` waits for prompt execution, disables callbacks, unsubscribes job events, stops session-owned browser sessions (`:2010`) and disposes language intelligence (`:2017`). Runtime generator cleanup clears that run's registry entry (`run-agent-step.ts:3959`). None of these facts alone proves that another detached child's resources are no longer in use.

**Inference, high confidence:** B19 needs an explicit launch owner plus resource owner/lease or ownership-transfer description. It must retain original root/action correlation and distinguish return from cancellation and cleanup. A deliberate handoff must name the receiving owner and applicable deadline, not merely omit a listener. B16/B20/B25/B28 and M22-CHILD own durable result retention, lifetime/leases, server closure and authority migration. Existing settle/reconciliation must remain intact; do not retrofit those cards into B19 or release leases at parent return.

## Smallest implementation sequence after leader authorization

1. **Leader publishes the contract and prerequisites.** Record accepted B02/B18 source/consumer bindings, then agree host-only effective context, serializable facts, receipt fields, approval authority, configured credential roster/delegation, profile tiers, deadline clock and resource-owner semantics. The leader owns shared/public schemas, SDK options/custom-tool ABI and `sdk/src/run.ts`. Data crossing a wire never creates approval authority. Preserve B18 private one-shot tokens and exact-byte/profile/basis binding; version any changed context-hash meaning.
2. **One executable vertical slice.** Resolve one captured env by merge, canonical/configured scrub, then explicit destination-bound delegation. Thread it through terminal, Git preflight and hooks/targeted validation/diagnostic execution. Fix omitted/false hook inference and document the actual default/explicit timeout. Prove actual env/options plus real key-free child observations and denied/unavailable/pre-abort zero launches before extending the shape.
3. **Adapt the remaining mapped launchers without inventing another contract.** Use the existing lane table: toolchain/LSP/SCIP; external MCP/Chrome/Blender/supervised adapters; terminal/background. Name every Chrome branch, probe, sync/async SCIP path, MCP discovery/tool transport, supervised retry and background handoff. Context-compatible cache/resource identity and synchronous cancellation disposition are part of this step. Evaluator adapters are a separate small leader/Q handoff after B30 source settles. Native remains explicitly unavailable to SDK until B21; its requested portable fields are design inputs, not adopted enforcement.
4. **Complete actual consumer controls.** Run the real custom strategy and route-precedence control, then check consumer receipts for all ten launcher families and the additional evaluator/detached boundaries. Record requested, available, active and enforced independently. A synthetic launch capture can establish threading; only an executed child establishes observed child env. Neither establishes OS enforcement or B20 cleanup.
5. **Verify the changed source as one reviewable candidate.** Run affected focused regressions and package typechecks, then affected packages' actual sorted CI invocation. Preserve failures and repair provenance. Bind source/toolchain/fixture hashes and logs, and request independent review from a non-author. Do not mark B19 accepted from these preparation artifacts or from pre-B19 passing CI.

These steps allocate no code and start no agents. Each worker must receive explicit file ownership, preserve other workers' changes, and consume the leader-owned contract. The existing three preparation files remain the detailed ten-family map and initial command roster.

## Acceptance-control supplement and exclusions

`acceptance-controls-supplement-2026-11-07.json` is a proposed, unexecuted control roster. It adds concrete evaluator, trusted-module, detached-parent and source-drift controls to the existing validation proposal. Its required matrix fields make an unused context property or missing branch a failure, not an inferred pass.

Freeze the fixture roster before execution. Use the pinned Bun recorded in first-wave evidence, replacement env, owned empty HOME/XDG and synthetic credentials only; assert zero provider requests. Include inherited/cleared env, custom configured key name, override reinjection, ordinary project variable, PATH override and one destination-only delegation. Capture once across delayed approval/retry and prove ambient changes do not alter the admitted action. Include absent/denied/unavailable authorizer and explicit allow-all as distinct cases.

No B19 control here claims descendant cleanup, hard-limit termination, native execution, universal trusted-JS mediation, bundle fidelity, durable detached ownership or task acceptance. SPEC's D=250 ms, G=200 ms, K=200 ms and J=1 s remain downstream selected fault-fixture inputs; a living covered descendant still fails the corresponding B20/B21 enforcement acceptance. Required unavailable profiles must fail before launch. Full access remains a valid deliberate user choice.
