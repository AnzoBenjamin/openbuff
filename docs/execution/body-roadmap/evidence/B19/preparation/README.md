# B19 execution-context preparation

This is a source-based, read-only mapping requested by the execution leader. It makes no implementation, test-pass, card-acceptance, installed-package or native-enforcement claim. B02/B18 independent reviews are complete; their ledger acceptance was still pending when this preparation was requested. No dependent implementation has started. Proposed changes below are recommendations for the leader, not accepted contracts.

Scope is [PLAN B19](../../../../../../.agents/sessions/body-capability-review-2026-11-05/PLAN.md:668) and the [SPEC process matrix](../../../../../../.agents/sessions/body-capability-review-2026-11-05/SPEC.md:84): SYNC shell, BACKGROUND job, supervised child, configured hook, diagnostic/build/version/SCIP, LSP, MCP stdio, Chrome, Blender/render helper, native role. The mapping includes concrete sublaunchers inside these families. It is not a repository-wide subprocess audit. Query-index/read-files tools were not registered in this session; bounded `rg` searches and source reads supplied the evidence. `source-manifest.json` binds the inspected sources and separates notes from product files.

## Ranked synthesis

| Rank | Finding | Confidence and basis |
|---|---|---|
| 1 | The effective environment is not a common contract. Several launchers inherit the host; terminal strips only canonical credential names; supervised children intentionally receive selected credentials; MCP's dependency merges ambient defaults even with an explicit env. | **Evidence, high:** `sdk/src/env.ts:73,120`; launcher matrix below; installed MCP transport source. |
| 2 | Hooks and MCP have concrete admission gaps, independent of process cleanup. Hook callers omit owner/profile/authorizer. Client-origin MCP tool calls explicitly allow execution when no approval callback exists, while tool discovery can start the transport before that tool-call gate. | **Evidence, high:** `sdk/src/tools/file-change-hooks.ts:1618`; `sdk/src/run.ts:1718,2481,2505`. |
| 3 | Profile labels cannot currently describe OS enforcement. The runtime terminal wrapper deliberately requests full access; most other launchers have no selected-profile input. Native exec is a separate, unintegrated one-shot role. | **Evidence, high:** runtime terminal handler `:38`; SDK native references and Rust ExecPlan/runner. |
| 4 | Merely adding env/signal fields will leave cross-context cache reuse and lifetime errors. Shared version probes, LSP/MCP resources, and supervision retries require explicit resource ownership and deadline scope. | **Inference, high:** existing cache keys, shared waiter controllers and per-attempt timeout behavior show why context must participate in resource identity. Cleanup implementation remains B20. |

## Concrete launcher matrix

Legend: **E** environment; **P** requested/available/active/enforced profile; **O** ownership; **A** approval/admission; **D** deadline; **S** cancellation signal; **R** result provenance. Each current-state statement below is direct source evidence. The resulting B19 gaps are inferences from comparison with the canonical acceptance criteria.

### 1. SYNC shell and its Git preflights

**Entrypoint and producer:** `sdk/src/run.ts:2796` → `sdk/src/tools/run-terminal-command.ts:1164,1593`. The staged-diff and dirty-set helper uses `runGitForSafety` at `:755,781`.

- **E:** terminal snapshots requested env, then merges and scrubs (`:1222,1254`); `inheritEnv:false` is real. Git helpers use that resolved env plus `GIT_OPTIONAL_LOCKS=0`. Canonical denylist only: arbitrary configured `apiKeyEnv` is expressly excluded from `sdk/src/env.ts:73`'s guarantee. Host env is recomputed on an approved recursive rerun, so a final shared context should be captured once and survive the rerun.
- **P:** SDK helper defaults to `workspace-write` (`:1169`); the runtime wrapper actually stamps `full-access` (`packages/agent-runtime/src/tools/handlers/tool/run-terminal-command.ts:38`). The comment in `sdk/src/run.ts:2785` claiming template-clamped profile is stale. Policy is lexical admission, not an OS sandbox. Success receipts do not uniformly publish the effective profile or four assurance states.
- **O/A:** SDK overwrites any input owner with `trustedJobOwner`. B18 exact command/effect/context hashes, private one-shot rerun token and authorizer checks are real. Preserve those controls. `hashTerminalExecutionContext` (`sdk/src/services/harness-enforcement.ts:188`) currently binds profile/cwd/root/paths/process type/detach/mode, not the resolved env or selected enforcement backend.
- **D/S/R:** SYNC gets a timeout and signal; the SDK run deadline only reaches it indirectly through signal. Git preflights have their own timeout/signal. Both the SYNC target (`:1593`) and Git helper (`:781`) spawn before their already-aborted checks (`:1655`, `:840`), so a direct pre-aborted helper call can still create a child; B19's zero-launch control must cover this gap, not only the SDK entry guard. B02 retains action/run outcomes, but no common execution receipt binds every preflight and target to one environment/profile/owner. Descendant cleanup is B20, not satisfied by this mapping.

**Existing controls:** `env.test.ts`, `terminal-environment.test.ts` (real SYNC/BACKGROUND replacement env), `run-terminal-command.test.ts`, runtime terminal handler tests, B18's actual SDK approval fixture. Add dynamic configured-secret scrubbing, override reinjection, captured-context rerun, full-access success metadata and required-unavailable zero-launch cases.

### 2. BACKGROUND job

**Producer:** terminal branch `run-terminal-command.ts:1480` → `sdk/src/tools/background-jobs.ts:674,716`.

- **E/P/A:** gets terminal's explicit resolved env after the same policy/approval gate. Background start itself has no profile/approval contract; inherited result metadata is incomplete.
- **O:** `JobOwner` and registry ownership already exist (`common/src/util/job-registry.ts:66`); direct ownerless callers get the explicit unknown owner. Do not mint a fake run for CLI-only operation.
- **D/S:** `startBackgroundJob` has no signal or timeout parameter. The terminal wrapper subscribes to abort unless `detach:true`; `timeout_seconds` does not create a background lifetime deadline. Distinguish a return/poll wait from a lifetime limit. Explicit detach needs a recorded ownership transfer, not disappearance of the original owner.
- **R:** durable job/log identity exists; selected context/deadline/profile and transfer identity are not included. B20 owns observed process-scope cleanup and retained kill authority.

**Existing controls:** terminal environment, run-terminal-command, check-job, kill-job, read-logs and job-registry tests. Add capture assertions that the registry/job receipt matches admission and that missing deadline means unbounded, not an implied limit.

### 3. Supervised child

**Producer:** `sdk/src/impl/agent-runtime.ts:119,288` → `supervision/supervised-spawn.ts:665` → `process-supervisor.ts:224`.

- **E:** the SDK explicitly reads the host and seeds a closed allowlist, so this is not wholesale inheritance. It nevertheless automatically forwards Openbuff/BYOK/OAuth credentials (`process-supervisor.ts:639`); it does not use the run's env/inheritEnv choice, configured-secret roster or per-destination delegation. Parent RPC already proxies provider calls, so credential necessity must be decided, not presumed.
- **P/O/A:** parent/child IDs and bridge request state exist, but no common execution-profile/admission receipt governs the process. The 0700 temporary working directory is not OS isolation. Do not replace child/session identity or the bridge nonce with model-supplied context.
- **D/S:** per-call abort is threaded. Explicit `request.timeoutMs` bounds each attempt; omitted means unbounded in real code (`supervised-spawn.ts:634`). Its contract comment still claims a ten-minute default (`common/src/types/contracts/agent-runtime.ts:155`). Restarts currently get fresh full timeout windows (`supervised-spawn.ts:86`), rather than consuming one parent deadline.
- **R:** supervised settlement tracks exit/duration/stdout/killed/stderr and typed child outcome. Add execution-context identity without changing task acceptance or claiming killed means all descendants are gone.

**Existing seams/tests:** injected `_spawnSettledSubagent`, `buildSupervisedChildEnv`, `SupervisedSpawnRequest`, process-supervisor, supervised-restart, supervised-bridge-e2e, spawn-process-supervision and SDK process-supervision-flag tests.

### 4. Configured hooks and targeted validation

**Composition:** `sdk/src/run.ts:3100,3174` → `run-targeted-validation.ts:68` → `file-change-hooks.ts:1537,1618` → terminal SYNC.

- **E:** env is forwarded, but `inheritEnv` is not; the terminal default therefore reintroduces host ordinary variables even when the SDK selected replacement env. Config loading also occurs independently of the run's chosen env (`file-change-hooks.ts:1556`).
- **P/O/A:** hook params expose none of owner, profile, authorizer or resolved admission. Commands default to the terminal helper's workspace-write profile, which differs from the runtime wrapper's actual full-access choice. A high-impact hook encounters a missing authorizer rather than the host's explicit approval decision.
- **Trust:** `autoFileChangeHooks === false` is the only off branch (`:1559`); undefined enables inference. `provider-config.ts:514` documents disabled-by-default. Require exactly `true` to infer; an explicitly configured hook remains distinguishable from an inferred one. Preserve existing origin/trust policy, not a blanket denial of user-configured scripts.
- **D/S:** actual omitted hook timeout is 300 seconds (`:41,1625`), despite interface/schema comments saying unbounded. Direct `-1` is tested as unbounded, while config schema only accepts positive integers up to 3600 (`provider-config.ts:506`). Choose and document one representable contract; recommended preserve actual 300s default plus explicit `-1` opt-out, clamped by any stricter run deadline.
- **R:** hook mapping spreads the terminal result and adds diagnostics; targeted validation preserves results and snapshot checks. Keep B36 unavailable/failed diagnostic truth. Add execution metadata to every granted/denied/unavailable hook outcome, including no-launch results.

**Existing seams/tests:** `runCommand`, injected `hooks`, `DiagnosticDeltaHook`, file-change-hooks timeout/cancel/parallel-order tests, targeted-validation, run-mutation-dispatch and diagnostic-delta tests. Rewrite only tests whose assumption is implicit inference; keep explicit opt-in inference coverage.

### 5. Diagnostic/build/version/SCIP family (six distinct sites)

| Concrete producer | E / P / O / A | D / S / R and B19 seam |
|---|---|---|
| `diagnostic-delta-runner.ts:94,139` | Explicit env is merged with **raw** host env; omitted env implicitly inherits. No common profile/owner/admission. | Has timeout, abort and bounded streams; B36 returns typed coverage and unavailable/failed states. Extend `DiagnosticCommandRunner` context and `createDiagnosticDeltaHook` binding, preserving B36 semantics. Its early result vs later kill is B20. |
| `semgrep-baseline.ts:111,129` (both version probe and scan) | spawn omits env; no selected profile/owner/authorizer. | Has signal, timeout and bounded result. Inject context through `makeSpawnRunner` and the producer; command/version cache must separate effective executable/env/profile contexts. |
| `harness-intelligence.ts:532,552,861` (14 version tools) | `ToolProbeSpawn` accepts only command/args; raw host cwd/env inherited. One global TTL cache ignores PATH/env changes. | 3s timeout and 64KiB output; shared probe-group controller uses waiter release. Keep shared-resource owner distinct from caller signal; add context to probe seam/cache key and preserve unavailable reasons rather than reducing every refusal to missing binary. |
| `build-graph.ts:64,81` (`cargo metadata`, `go list`) | `BuildGraphRunner(argv,cwd)` omits env/profile/owner/admission. | Blocking `spawnSync`, 10s cap, 16MiB bound. `get-build-targets.ts:17` calls it before async signal-aware discovery and passes no signal. A context field alone cannot make a sync child promptly cancellable: decide off-thread execution or an explicitly unavailable selected cancellation tier. Do not claim active cancellation works. |
| `scip-runner.ts:229,231` (legacy sync) | `ScipRunnerInvocation:60` has command/argv/cwd/timeout/buffer only. Implicit env, no ownership/profile/admission. | Timeout only, no signal; sync compatibility must be explicit about unavailable cancellation. Context must reach probe and index invocation, not only top-level options. |
| `scip-runner.ts:318,322` (default async) | Same missing fields. | Async child has timeout but no signal. Detection is separately cached; cache identity must bind context. Live CLI entry is `cli/src/commands/index-command.ts:313`, passing only index/indexers. SDK-only propagation would miss this production consumer. |

**Existing controls:** diagnostic-delta (including real command runner), semgrep-baseline, harness-intelligence probe concurrency/cancellation/cache tests, build-graph injected runner tests, scip-runner sync/async/detection/timeout tests and CLI index-command tests. The SCIP parse worker processes data and is not another external executable launcher; its lifetime is not expanded here. Other repository grep/search helpers outside this finite family are out of scope.

### 6. LSP

**Producer:** `sdk/src/run.ts:1197` and fallback `:2432` → `language-intelligence.ts:581,615`; `LspSpawnSpec` at `lsp-multiplexer.ts:159` only has argv/cwd.

- **E/P/O/A:** selected env/profile/owner/admission are absent at both SDK construction paths. Passing a new option at only one construction site leaves the fallback hole.
- **D/S:** multiplexer has request timeouts and server teardown, but no per-run signal/deadline in spawn spec. A reusable server is a resource with an owner and request leases; do not bind server lifetime to the first caller and kill unrelated requests.
- **R:** typed unavailable/server errors and document/version checks exist. Context admission must remain distinguishable from missing server or protocol failure. B25 owns deeper lifecycle/document-state proof.

**Existing controls:** `CodebuffSpawn` DI, `LspSpawner`, injected multiplexer, language-intelligence and lsp-multiplexer tests. Require actual spawn-option capture through production `createLanguageIntelligence`, not only a fake multiplexer.

### 7. MCP stdio transport

**Producer:** `sdk/src/run.ts:1718` (tool discovery) and `:2511` (call) → `common/src/mcp/client.ts:715,721` → installed `@modelcontextprotocol/sdk/dist/esm/client/stdio.js:67`.

- **E:** trusted `$VAR` substitution reads `process.env` (`common/src/mcp/client.ts:103`); client origin deliberately does not substitute. `resolved.env` is passed, but the installed transport prepends its ambient default HOME/LOGNAME/PATH/SHELL/TERM/USER (Windows has another closed set), even when env is explicit. Passing `{}` therefore does not mean replacement env. A strict replacement needs an upstream-supported exact-env transport path or a small owned transport adapter; do not patch dependency files or lie in the receipt.
- **P/O/A:** cache identity has config/origin/effective config values but no resource owner, selected profile or common context. Discovery starts a server before first-tool approval. The SDK's client-origin call gate adds an approval key even when the host callback is absent (`run.ts:2505`, explicitly labeled fail-open). An absent authorizer cannot become approval. Explicit allow-all/full-access policy is a distinct authorized outcome and must remain usable. Stdio process admission must happen before discovery spawn as well as call dispatch.
- **D/S:** tool requests pass signal to `callMCPTool`; transport construction/connect lacks caller deadline/signal, using its own lifecycle controller. B20 owns leases/eviction/close and B28 owns complete MCP result semantics. Scope B19 to correctly threaded execution/admission metadata and real delegation, not a second MCP result rewrite.
- **R:** preserve existing host-owned origin marks and secret-redaction boundaries. Do not serialize host callbacks or treat peer `_meta` as delegated authority. Explicit per-server delegated credential keys/values are exceptions for that destination only; denial elsewhere is unchanged.

**Existing controls:** common MCP client tests for origin/substitution/cache; SDK client-origin MCP controls and protocol GV-17/GV-30 fixtures. Add a local stdio recorder for actual env and zero-launch missing/denied/unavailable admission; injected constructor assertions alone miss upstream ambient merging.

### 8. Chrome (three actual launches)

**Producer:** `sdk/src/run.ts:3041` → `browserLogs(action, trustedOwner)`; pipe-support probe `browser-logs.ts:1227`, pipe connection `:1464`, port fallback `:1508`.

- **E/P/O/A:** all three spawn without env/cwd/context. Main browser session has trusted session/run/agent owner (`:114,1564`); probe children do not carry that ownership. Native Chromium sandbox enable/disable detection is separate from an Openbuff execution profile; root/userns fallback may pass `--no-sandbox`. Do not describe a browser profile as enforced solely from selected flags.
- **D/S:** `browserLogs` has no run signal. Action/probe/WebSocket waits have local timeouts; SDK cancellation and selected absolute execution deadline do not propagate to the process paths. All three branches need coverage, including a failed probe and fallback.
- **R:** owner registry and protocol failure handling exist; common execution metadata and admission unavailable states do not. B33 retains media/session/task-specific work; B20 owns cleanup guarantees.

**Existing controls:** browser-logs, browser-logs-sandbox, pipe probe/test hooks, transport setup/rollback tests. Capture actual options for all three launches, with required-unavailable profile proving zero process creation.

### 9. Blender/render helpers

**Producer:** `sdk/src/tools/3d-assets.ts:336,346`; used by `.blend` inspect (`:671`), imported format inspect (`:691`), preview (`:821`), edit (`:1173`) and validation (`:1212`).

- **E:** canonical-scrubbed host env is merged with helper vars **after** scrub (`:349`). Current callers supply fixed `OPENBUFF_3D_*` fields, so arbitrary caller credential reinjection is not established here; nevertheless selected SDK env/inheritEnv and configured-secret names never reach it. No explicit cwd is supplied.
- **P/O/A:** no common profile, process owner or admission callback. Source/artifact/operation identities already exist and must be retained.
- **D/S:** pre-abort and runtime listener exist; ordinary timeout is 120s, render max(120s, views×90s). Neither is bounded by a transported absolute parent deadline. Child-only kill is B20.
- **R:** clean zero exit is required before edit validation/commit; errors and artifact provenance exist. Add execution receipt without weakening those checks or claiming a preview proves scene semantics (B35).

**Existing controls:** 3d-assets tests for payload file, bounds, pre-cancel, cleanup and failed edits. Add injected runBlender/spawn seam and record all five callers, not just render.

### 10. Native role and generic sidecar adapter

**Current native role:** `rust/crates/openbuff-native/src/exec/plan.rs:11` and `runner.rs:16`; executable dispatch in `main.rs`. ExecPlan carries cmd/args, optional env and Landlock read/write lists. `env:None` inherits; `Some` clears and sets exact pairs. It does not carry cwd/owner/action/basis/deadline/cancel/control identity. Unix replaces itself with target; non-Unix spawns/waits. A pre-exec status line on stderr and the handshake on stdout are not a target-result framing contract.

**Callable but unintegrated SDK helper:** `sdk/src/services/sidecar-supervisor.ts:40,285` has persistent JSON-RPC, request timeout/restarts, and env merge after canonical scrub; no cwd/owner/profile/signal context. Searches found no production `new SidecarSupervisor` consumer. `sidecar-artifact.ts` validates hashes but uses materialized mode 0600; executable validation/adoption belongs to B21.

**B19 disposition:** retain this family explicitly as `native-role-unavailable-to-SDK`, define the portable context/receipt required by B21, and refuse required native/enforced selection before a target is launched. Do not accept native adoption from a synthetic capture of an unused context field. B21 must wire/verify the checksummed installed role, exact environment and dedicated control/pre-exec protocol. Generic persistent RPC cannot simply wrap current exec: after exec, target JSON-shaped stdout is ordinary target bytes. Native smoke still expects the old stub (`rust/scripts/smoke-test-sidecar.sh:42`) and is a B21 correction.

## Minimal shared contract proposal (leader decision, not implementation)

The existing SDK `spawnSource` is resolved at `run.ts:1000` and reaches diagnostics/LSP, but terminal, background, Chrome, Blender, build/version/SCIP and MCP use separate imported spawn/transport functions. Capturing `spawnSource` alone cannot verify the matrix. Each adapter needs a narrow actual-launch seam or a real child control.

1. **One host-created effective context per admitted action/launch.** Add a leaf common contract, for example `ExecutionContextV1`, plus a serializable description and receipt. Reuse `JobOwner` and original B02 action/attempt/run IDs; attach launcher kind, captured cwd/root/basis, adapter generation and an optional explicitly unavailable backend/epoch field. SDK composition root resolves this once. Lower adapters accept the effective context, not another bag of defaults that rereads ambient env.
2. **Keep data separate from authority.** Raw env and admission callbacks stay in the host-only context. Serializable wire context contains the fields needed for execution, without granting authority merely because it parsed. Receipts contain identity/digests, selected env key names/delegation provenance and outcomes, never credential values. Native/child wires are validated at an authenticated parent boundary. Root owns any shared strict-schema extensions and SDK/client projection.
3. **Merge, then scrub, then apply only explicit destination-bound delegation.** Root captures host env only if selected, merges run overrides, strips canonical plus loaded configured `apiKeyEnv` names (respect existing platform case rules), and retains ordinary project vars. Resolve delegation from the same captured source/configuration, with destination/config-origin/purpose binding. Move or reuse the pure configured-key extraction logic from `serve/outbound.ts:87` without importing serve or provider-config into the credential leaf. Explicit delegated server credentials are the only intentional readdition; generic overrides are not delegation.
4. **Represent profile selection separately from assurance.** Required/optional request; actual available capabilities; active backend/profile; and individually enforced filesystem/network/process/limit claims. Full access remains a valid deliberate selection and reports actual full access. Unsupported required capability returns unavailable with zero launch; optional degradation must be explicit. Existing lexical permission profiles are policy, not native enforcement.
5. **Admission is a tagged result.** `allowed` with explicit policy/approval basis, `denied`, or `unavailable`; no callback means unavailable when approval is required. Existing B18 exact-command and private-token authority remains authoritative. Decide whether a new version of execution-context hash also binds env/profile backend/deadline/delegation digest; do not silently change the meaning of existing v1 approvals. Approval checks and cancellation rechecks occur before every actual spawn, including discovery/probes and retry.
6. **One absolute deadline plus an explicit clock basis.** Combine local command cap with the parent's remaining budget; retries do not restart an action's budget. Host monotonic timing enforces remaining duration, with a defined wall-time/remaining-budget wire conversion for another process. Omitted limit stays explicitly unbounded. Live signal is host-only; child/native cancellation uses an owned channel. The choice of cross-process clock conversion needs root agreement before B20/B21 consumes it.
7. **Execution result is not task success or cleanup proof.** Preserve B02 action/run/task distinctions. Add context identity, admission/profile facts, actual exit/cancel/timeout/spawn failure, bounded stdout/stderr/artifact references and cleanup state (`unobserved` until observed). B20 later proves scope exit/reap; B19 cannot emit `cleanupComplete` from a signal sent or leader exit. Shared servers/probes use a registered resource owner with per-request leases and context-compatible cache keys.

Public custom-tool context currently carries only optional signal (`sdk/src/custom-tool.ts:5`), and override v1 carries only ABI/signal (`sdk/src/run.ts:291`). Extend these additively with read-only context facts and an explicitly supported mediated-launch capability if needed. A trusted custom module remains arbitrary full-access JS: B19 cannot intercept its direct filesystem/process calls or claim universal isolation. The requested real custom-strategy test should exercise SDK read/edit/terminal consumers under deliberate full access, plus unsupported required-profile refusal. The model recommendation layer is currently opt-in and explicitly separate from configured route resolution (`provider-config.ts:1868`); preserve and test that precedence through the actual SDK run.

## Proposed ownership after dependency acceptance

| Lane | Exclusive production responsibility | Coordination boundary |
|---|---|---|
| Root/C | `sdk/src/run.ts`, public SDK/client/custom-tool options, shared common context/result/schema contracts, approval decision factory, provider-config trust/timeout schema and configured credential roster | Publish type/authority decisions first; own B02/B18/B36 integration effects and final receipt projection. |
| Terminal/hooks lane | `sdk/src/env.ts`, credential leaf, terminal command/background context plumbing, hooks/targeted validation/diagnostic runner and corresponding tests | Consume root callback/context, preserve B18 token/hash behavior and B36 diagnostic truth. Root retains shared schema edits. |
| Language/toolchain lane | harness version probes, semgrep, build-graph, LSP/multiplexer, SCIP runners and CLI index caller; corresponding tests | Agree on blocking sync compatibility disposition and cache context identity; no SDK run.ts edits. |
| External/process lane | common MCP adapter (outside root-owned schemas), Chrome, Blender, supervised-env/spawn adapters, generic sidecar context surface and corresponding tests | Coordinate MCP exact-env transport and resource owner with root; native implementation remains B21. |

These are responsibility groups, not spawned agents or an implementation start. With four slots including root, stage the largest external/process group if review bandwidth is inadequate. Every lane must preserve others' edits. Root can instead keep terminal/B18 work in its lane and split external adapters, without changing the contracts.

## Acceptance controls and commands to prepare

The finite capture matrix must enumerate all 10 families and each concrete branch above. Every row records requested context, the **actual** spawn/transport options, owner/admission, effective deadline/signal behavior and the consumer receipt. Add a zero-launch oracle for denied/unavailable/pre-aborted cases. A context property never read by a launcher is failure.

- **Env:** unique canonical provider sentinel, custom configured apiKeyEnv sentinel, ordinary project var, PATH override, explicit inheritance off/on, override reinjection attempt, and one delegated credential scoped to one trusted MCP destination. Use synthetic values only. Capture env before approved retries and prove it does not change with later ambient mutations.
- **Profile/admission:** full-access ordinary work, narrower policy, allowed/denied/unavailable/absent approval, explicit allow-all choice, required unavailable enforcement and optional reported degradation. Existing B18 approval byte/profile/basis controls remain green.
- **Ownership/deadline/signal:** spoofed tool owner/context rejected, original SDK identity retained, pre-abort zero launch, delayed admission abort zero launch, finite remaining budget propagated to probes/target/retries, unbounded default, explicit background ownership transfer. Shared probe/LSP/MCP reuse must not reuse incompatible env/profile/owner context or let one request cancel another resource owner.
- **Hook truth:** omitted/false inference disabled and true enabled; configured hook trust and authorizer preserved; 300s default and explicit -1/config representation decision tested; tighter parent deadline wins. Actual diagnostic failures/unavailable observations still fail or report unavailable under B36.
- **Real controls:** harmless local terminal, diagnostic and configured hook print only synthetic allowed variables and identity markers; actual SDK custom strategy performs read/edit/command without provider requests, then exercises required-unavailable profile. Local stdio fixture verifies transport-level env. Chrome/Blender/LSP/native may use injected launch captures for B19, but that is labeled capture evidence; missing installed binaries do not count as executed enforcement.
- **Routing:** a configured explicit model/agent route remains selected even when a stronger recommendation is supplied. Host lifecycle controls admission/limits and reports results; it does not choose the strategy's next task action.

Use pinned Bun 1.3.5, `--no-env-file`, absolute selected suite paths, owned empty HOME/XDG and an explicit synthetic provider config. A replacement env must be constructed as a subprocess env object, not inherited shell variables. No provider/network calls are necessary. The following are proposed selections, not commands run in this preparation:

```text
sdk: env, terminal-environment, run-terminal-command, file-change-hooks,
     run-targeted-validation, diagnostic-delta, run-mutation-dispatch,
     harness-intelligence, semgrep-baseline, build-graph,
     language-intelligence, lsp-multiplexer, browser-logs,
     browser-logs-sandbox, 3d-assets, sidecar-supervisor, provider-config,
     process-supervision-flag, custom-tool-dispatch and affected SDK/client approval suites
common: src/mcp/__tests__/client.test.ts; new shared execution-context tests
runtime: spawn-process-supervision; supervision process-supervisor,
         supervised-restart, supervised-bridge-e2e; terminal handler parity
indexer: src/scip-runner.test.ts
cli: index-command and new execution-receipt projections
```

Run each selected command as `BODY_BUN --no-env-file test --isolate <absolute files>` using the exact Bun path/hash recorded by first-wave evidence. Also run affected package typechecks with `BODY_BUN --no-env-file run --cwd <absolute package> typecheck`. Before acceptance, run CI's actual sorted package discovery/invocation for modified packages; independent per-file tests alone do not establish cross-file mock isolation (the preserved B02 counterexample remains relevant). Add a dedicated real launcher matrix fixture with JSON receipts, zero-provider-call assertion, source/toolchain hashes and stdout/stderr logs; freeze its roster before running it. These notes add no fixture implementation.

## B20/B21 decisions to settle before code allocation

1. **Resource lifetime:** define action owner vs session/service-owned shared resource and explicit detach transfer; B20 owns close/lease/eviction and TERM/KILL/reap. Preserve root-run identity without inventing an authoritative SessionAuthority ahead of B15.
2. **Deadline clock/protocol:** define absolute deadline and remaining-budget conversion, cancellation channel, per-attempt generation and result/cleanup separation. Use SPEC D=250ms/G=200ms/K=200ms/J=1s only for the future fault fixture, not as production defaults or B19 cleanup evidence.
3. **Native capability contract:** unavailable native adapter is an honest B19 cell. B21 needs a one-shot versioned exec plan carrying exact env, cwd, basis, owner, profile and limit request; required capabilities must be negotiated before target exec. Linux Landlock-only is not the selected full bubblewrap+seccomp/process/network guarantee; macOS/Windows unimplemented cells remain unavailable.
4. **Control channel:** a dedicated fd or rigorously delimited pre-exec phase separates status from target stdout/stderr. Existing persistent SidecarSupervisor is not that protocol. Target JSON-RPC-shaped output must remain raw target bytes.
5. **Credential delegation:** decide whether supervised children need any provider secret with parent RPC in use; MCP delegation must be origin/destination-bound. Absence of a callback is never a grant, while the user's explicit full-access/allow-all preference remains supported.
6. **Sync compatibility:** define a tested off-thread route or unavailable cancellation tier for build-graph/legacy SCIP; an ignored `signal` field is not a compliant B19 implementation.

Unknowns are deliberately retained: no actual child environments, cleanup envelopes, installed native artifacts or OS enforcement were executed in this preparation; the proposed contract shape and field names need leader agreement. No universal mediation of trusted JS, full-access shell, external editors or unaware binaries is claimed.
