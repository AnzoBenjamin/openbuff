# Audit findings: spawn-permissions

- Subsystems: agent-runtime/spawn
- Features: spawn-permissions, handoff-capability-derivation, spawn-depth, filesystem-scope-narrowing, tool-intersection
- Files covered: 12

## [HIGH] correctness — packages/agent-runtime/src/tools/handlers/tool/spawn-agent-utils.ts:479 — [B] Empty handoff readablePaths narrows a child from unrestricted reads to zero-read (all reads hard-blocked)

- **Risk:** deriveSpawnTemplateCapabilities always rewrites filesystemScope to { read, write } (line 517) whenever a handoff is present. narrowFilesystemPatterns (util/filesystem-scope.ts:56) returns the normalized requested array verbatim, so when handoff.permissions.readablePaths is [] (a common and schema-legal case — e.g. the repair-editor sample handoff in spawn-agents-permissions.test.ts:createVersionedHandoff uses readablePaths: []), the derived child gets filesystemScope.read = []. Critically, if the child template originally had NO filesystemScope.read (undefined = unrestricted reads), derivation CONVERTS that unrestricted child into read: []. In tool-executor.ts:1238-1241 an empty (but defined) array is truthy, so the scope block runs; at 1272-1278 every in-project path is a scopeMismatch because [].some(...) is false; and at 1296-1299 read-access scope mismatches are hard-blocked. Net effect: a child handed an empty readablePaths list cannot read ANY file in the project, silently breaking legitimate repair/review/edit work that depends on reading source. The parent orchestrator rarely enumerates a full read allowlist, so this trap fires on ordinary handoffs.
- **Fix:** Only narrow read scope when the handoff actually requested read paths. In deriveSpawnTemplateCapabilities, compute read as: handoff.permissions.readablePaths.length > 0 ? narrowFilesystemPatterns({requested: readablePaths, staticPatterns: inheritedTemplate.filesystemScope?.read, ...}) : inheritedTemplate.filesystemScope?.read (i.e. preserve the child's static read scope, keeping undefined => unrestricted). Then build filesystemScope conditionally so an undefined static read scope is not clobbered into []. This keeps the child-cannot-exceed-parent guarantee (a non-empty requested set is still validated against staticPatterns) while removing the accidental total read lockout.
- **Evidence:** spawn-agent-utils.ts:479-492 (read/write = narrowFilesystemPatterns(requested: handoff.permissions.readablePaths, staticPatterns: inheritedTemplate.filesystemScope?.read)) and :517 (filesystemScope: { read, write }); util/filesystem-scope.ts:56-79 returns normalized (=[] for empty requested) with staticPatterns undefined only rejecting ../absolute; tool-executor.ts:1238-1241 (allowedPatterns truthy for empty array), :1272-1278 (scopeMismatch when no pattern matches), :1296-1299 (read scope mismatch hard-blocked). Test spawn-agents-permissions.test.ts createVersionedHandoff sets permissions.readablePaths: [].

## [MEDIUM] correctness — packages/agent-runtime/src/tools/handlers/tool/spawn-agent-utils.ts:516 — [B] Any handoff-carrying child has spawnableAgents forcibly emptied, blocking legitimate delegation

- **Risk:** When a handoff is present, the derived template hard-sets spawnableAgents: [] (line 516). Without a handoff the early return at line 460 preserves the child's static spawnableAgents. This asymmetry means the moment an orchestrator issues a structured handoff (the recommended, richer path), the child loses ALL ability to spawn sub-agents it legitimately declares — e.g. a reviewer/debugger/repair-editor handed a task can no longer delegate discovery to file-picker/code-searcher even though its own template authorizes those children. The stated intent (prevent authority widening via delegation) does not require zeroing: a child can never spawn an agent it does not statically declare in spawnableAgents anyway (getMatchingSpawn enforces that against the child's own list), and spawn depth caps bound recursion. Zeroing is redundant with those guards and purely additive friction.
- **Fix:** Preserve the child's own static spawnableAgents instead of forcing []: drop the `spawnableAgents: []` override (let it inherit ...inheritedTemplate.spawnableAgents). If defense-in-depth is desired, intersect with the child's static list rather than empty it — but the static list is already the authoritative ceiling enforced by getMatchingSpawn, so simply preserving it restores parity with the no-handoff path.
- **Evidence:** spawn-agent-utils.ts:460 (`if (!handoff) return inheritedTemplate` preserves spawnableAgents) vs :505-518 return object with `spawnableAgents: []`; getMatchingSpawn (:190-250) already restricts children to the spawner's declared list; executeSubagent depth cap at :~1980 (`currentDepth + 1 > maxSpawnDepth`) bounds recursion independently.

## [MEDIUM] api-contract — packages/agent-runtime/src/tools/handlers/tool/spawn-agent-utils.ts:513 — [B] Trusted, model-hidden programmaticToolNames are intersected with the model-authored handoff allowedTools and silently stripped

- **Risk:** programmaticToolNames are hidden capabilities callable only from the trusted handleSteps generator (agent-template.ts:~168 doc), never exposed to the model. Line 513-515 filters them to only those present in handoff.permissions.allowedTools. Because the model authoring a handoff has no visibility into hidden programmatic tools, it will essentially never list them, so this intersection strips ALL of a child's programmatic tools whenever a handoff is present. That can break a child whose handleSteps generator depends on a programmatic tool (the generator yields a tool call that the executor then rejects as unavailable), turning a capability-scoping mechanism meant for model-facing tools into a silent breakage of trusted internal wiring.
- **Fix:** Do not gate programmaticToolNames on the model-authored handoff allowedTools. Preserve inheritedTemplate.programmaticToolNames unchanged (they are already bounded by the template author and unreachable by the model). If scoping is ever needed, gate on an explicit programmatic allowlist field, not the model-visible allowedTools set.
- **Evidence:** spawn-agent-utils.ts:513-515 (`programmaticToolNames: (inheritedTemplate.programmaticToolNames ?? []).filter((toolName) => requestedTools.has(toolName))`); requestedTools derives from handoff.permissions.allowedTools (:462); agent-template.ts programmaticToolNames doc 'Hidden capabilities callable only from the trusted handleSteps generator'.

## [LOW] correctness — packages/agent-runtime/src/tools/handlers/tool/spawn-agent-utils.ts:507 — [B] Model-facing toolNames intersection with handoff allowedTools can silently drop tools the child legitimately needs

- **Risk:** Line 507-510 intersects the child's static toolNames with handoff.permissions.allowedTools. This is the intended 'handoff scopes down' contract and correctly prevents widening, but the failure mode is silent under-provisioning: if the orchestrator's handoff omits a tool the child genuinely needs (e.g. forgets set_output or a required discovery tool), the child loses it with no diagnostic, and the model only discovers the gap when a tool call is rejected mid-run. getEffectiveAgentToolNames adds set_output back for structured_output agents at the executor layer, but the derived toolNames array here does not, so the reported/effective set can be narrower than needed.
- **Fix:** Keep the intersection (it is the child-cannot-exceed-parent contract) but reduce friction: (a) always retain set_output when outputMode is structured_output regardless of the handoff list, mirroring getEffectiveAgentToolNames; and (b) when the intersection drops a statically-declared tool, emit a debug/warning log in logAgentSpawn so under-provisioned handoffs are diagnosable rather than silent.
- **Evidence:** spawn-agent-utils.ts:507-510 (toolNames filtered by requestedTools.has); util/agent-tool-names.ts:12-24 adds set_output only at effective-tools computation, not in the derived array; selectAgentAttempt uses getEffectiveAgentToolNames so it re-adds set_output for the requiredTools check but the child's runtime toolNames array stays narrowed.

## [LOW] correctness — packages/agent-runtime/src/tools/handlers/tool/spawn-agents.ts:116 — [B] MAX_SPAWN_BATCH_SIZE=8 sibling cap forces wave-splitting for legitimate wide fan-out

- **Risk:** A single spawn_agents call is capped at 8 sibling agents (constants/agents.ts MAX_SPAWN_BATCH_SIZE = 8; enforced spawn-agents.ts:116-120). Legitimate breadth-first work (e.g. sharding 10-12 files or audit shards across a codebase) must be artificially split into multiple waves, adding orchestration round-trips. The cap protects against runaway fan-out, but 8 is a low ceiling for the sharding/audit patterns this runtime explicitly supports (evals/buffbench plan-sharding).
- **Fix:** Raise MAX_SPAWN_BATCH_SIZE to 12-16, or make it configurable per-template (like maxSpawnDepth). The background-agent scheduling quota (maxRunningForRoot=8 in select-agent-attempt) already bounds concurrent resource use, so a larger batch of foreground/queued siblings does not meaningfully increase blast radius.
- **Evidence:** common/src/constants/agents.ts (`MAX_SPAWN_BATCH_SIZE = 8`); spawn-agents.ts:116-120 (`if (agents.length > MAX_SPAWN_BATCH_SIZE) throw ... 'Split the work into bounded waves.'`); spawn-agents.ts selection uses maxRunningForRoot: 8 as an independent concurrency guard.

## [LOW] correctness — common/src/constants/agents.ts:243 — [C] Spawn depth default of 3 is shallow for deep orchestration but is per-template configurable — KEEP

- **Risk:** MAX_SPAWN_DEPTH_DEFAULT = 3 permits root -> specialist -> leaf tool-runner. A 4-level orchestration (orchestrator -> sub-orchestrator -> specialist -> tool-runner) is rejected by executeSubagent's depth check. This is a genuine recursion-safety guard and is overridable per template via maxSpawnDepth (agent-template.ts maxSpawnDepth; spawn-depth.test.ts confirms overrides both raise and lower the cap), so it is not clearly broken.
- **Fix:** KEEP. No change required; the cap is configurable per-template and the default prevents unbounded file-picker -> file-picker recursion. If deeper orchestration becomes common, raise the default to 4 in one edit, but do not remove the cap.
- **Evidence:** constants/agents.ts MAX_SPAWN_DEPTH_DEFAULT = 3 (doc: 'root -> specialist -> leaf tool-runner'); spawn-agent-utils.ts executeSubagent depth guard (`currentDepth + 1 > maxSpawnDepth ... 'Maximum spawn depth reached'`); spawn-depth.test.ts covers default, per-template higher (5) and lower (1) overrides.

## [LOW] security — packages/agent-runtime/src/tools/handlers/tool/spawn-agent-utils.ts:444 — [C] Plan-only ancestry attenuates child run_terminal_command to read-only — KEEP

- **Risk:** When the parent runs planOnly, a child that has run_terminal_command has its terminalPermissionProfile forced to 'read-only' (lines 449-453) and planOnly is propagated. This is correct, high-value defense: it prevents a plan-mode session from acquiring terminal write authority by spawning a bashing child. spawn-agents-permissions.test.ts verifies both the attenuation under plan-only ancestry and that normal ancestry preserves workspace-write, and confirms the shared template is not mutated.
- **Fix:** KEEP. This is a real child-cannot-exceed-parent enforcement and should not be relaxed.
- **Evidence:** spawn-agent-utils.ts:444-459 (inheritsPlanOnlyAuthority downgrade to 'read-only'); tests 'attenuates terminal authority throughout plan-only spawn ancestry' and 'preserves normal child terminal authority outside plan-only ancestry'.

## [LOW] security — packages/agent-runtime/src/tools/handlers/tool/spawn-agent-utils.ts:469 — [C] Tool-widening throw + closed read-only discovery carve-out — KEEP

- **Risk:** A handoff may only grant the closed HANDOFF_GRANTABLE_READ_ONLY_TOOLS allowlist (code_search, glob, read_outline, read_subtree, list_directory, query_index, find_files, find_files_matching_content) beyond the child's static tools; anything else (mutation/network/process/delegation, and deliberately read_files) throws (lines 469-477). This is the core child-cannot-exceed-parent invariant with a well-scoped, security-reasoned exception for no-authority discovery tools. narrowFilesystemPatterns similarly throws on any requested path outside the static scope or that escapes the project root.
- **Fix:** KEEP. The carve-out is explicit, closed, and documented (read_files intentionally excluded because it issues read authorizations edit tools can consume). No relaxation warranted.
- **Evidence:** spawn-agent-utils.ts:415-433 HANDOFF_GRANTABLE_READ_ONLY_TOOLS with the explicit 'do NOT add read_files' rationale; :469-477 disallowedTools throw; util/filesystem-scope.ts:66-78 widen/escape throw; tests 'still throws the widen error for a mutation tool', 'does not grant read_files through the discovery carve-out'.

## Coverage receipt

### Subsystems

- agent-runtime/spawn

### Features

- spawn-permissions
- handoff-capability-derivation
- spawn-depth
- filesystem-scope-narrowing
- tool-intersection

### Files

- packages/agent-runtime/src/tools/handlers/tool/spawn-agent-utils.ts
- packages/agent-runtime/src/tools/handlers/tool/spawn-agents.ts
- packages/agent-runtime/src/tools/handlers/tool/spawn-agent-inline.ts
- packages/agent-runtime/src/util/agent-tool-names.ts
- packages/agent-runtime/src/util/filesystem-scope.ts
- packages/agent-runtime/src/orchestration/select-agent-attempt.ts
- packages/agent-runtime/src/tools/tool-executor.ts
- common/src/constants/agents.ts
- common/src/types/agent-template.ts
- agents/types/agent-definition.ts
- packages/agent-runtime/src/**tests**/spawn-agents-permissions.test.ts
- packages/agent-runtime/src/**tests**/spawn-depth.test.ts
