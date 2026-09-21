# Audit findings: shard-common-schemas

- Subsystems: common-tool-registry, common-tool-params-schemas, common-tool-input-aliases, common-compile-tool-definitions, common-edit-transaction-schema, common-spawn-agents-schema, common-run-terminal-command-schema, common-path-containment, common-sensitive-path-policy, common-session-state-model, common-spawn-types, common-mcp-client, common-agent-template-validation, common-tool-test-suite
- Features: tool-registry-consistency, model-vs-provider-dual-schema, input-alias-normalization, generated-tool-type-definitions, capability-gated-edit-schema, transaction-resource-bounds, transport-truncation-recovery, spawn-catalog-deny-by-default, structured-agent-handoff, terminal-permission-profiles, owned-temp-exception, external-read-allowlist, symlink-aware-containment, win32-alias-guard, mandatory-sensitive-read-policy, agent-session-artifact-allowlist, session-state-resume-contract, mcp-client-cache-key-privacy, mcp-transport-lifecycle, mcp-tool-result-mapping, dynamic-agent-template-validation
- Files covered: 28
- Snapshot: df9b2f192f10abc4503dfdc5a5a30643b0fd9ca84ef8d8cf5cd8988d93669cc1

## [HIGH] correctness — common/src/mcp/client.ts:115 — listMCPTools caches the listTools promise, so one rejection poisons the cache for process lifetime
- **Risk:** A single transient failure (server restart, network blip) permanently caches the rejected promise: every later listMCPTools call for that clientId rethrows the stale rejection until process restart, and a recovered MCP server is never re-listed, so its tools silently vanish from the harness.
- **Fix:** Invalidate the cache entry when the stored promise rejects (p.catch(() => { delete listToolsCache[clientId] })), add a TTL or explicit refresh hook, and consider a stale-while-revalidate read.
- **Evidence:** if (!listToolsCache[clientId]) { listToolsCache[clientId] = client.listTools(...args) } return listToolsCache[clientId]

## [MEDIUM] state-mutation — common/src/mcp/client.ts:86 — getMCPClient check-then-act race spawns duplicate clients and leaks the loser
- **Risk:** Two concurrent getMCPClient calls with the same config both miss the cache, both construct a Client and connect (two stdio child processes for the same server), and the loser overwrites the winner in runningClients, leaking an orphaned transport/child process.
- **Fix:** Memoize the in-flight connect promise per key (Map<string, Promise<string>>) so concurrent callers await one connect, and cache the client only after the shared promise resolves.
- **Evidence:** if (key in runningClients) { return key } ... await client.connect(transport); runningClients[key] = client

## [MEDIUM] error-handling — common/src/mcp/client.ts:88 — No timeouts on client.connect, listTools, or callTool
- **Risk:** A hung MCP server (stdio process wedged, or HTTP peer that never answers) blocks the agent run indefinitely; run_terminal_command grew a timeout_seconds control but MCP connect/list/call are unbounded, so a bad server can stall a paid turn forever.
- **Fix:** Pass per-call timeouts (AbortSignal.timeout or the MCP SDK request timeout option) to connect/listTools/callTool and fail with a structured, retryable timeout error.
- **Evidence:** await client.connect(transport) and const callResult = await client.callTool(...args) carry no AbortSignal or timeout option

## [MEDIUM] correctness — common/src/mcp/client.ts:142 — callMCPTool ignores isError and trusts result.content without validation
- **Risk:** MCP tool errors flagged with isError:true are mapped as ordinary output, so the model cannot distinguish a failed MCP call from success; a non-conforming payload (content undefined) throws a bare TypeError; the `as CallToolResult` cast hides malformed server responses instead of validating them.
- **Fix:** Check result.isError and map it to a structured error output; validate/optional-chain content (fall back to []) before mapping; narrow the cast with a zod parse of the CallToolResult shape.
- **Evidence:** const result = callResult as CallToolResult; const content = result.content; return content.map((c) => ...)

## [MEDIUM] security — common/src/mcp/client.ts:15 — No per-server tool allowlist, argument caps, or result sandboxing for MCP tools
- **Risk:** Every tool a configured MCP server lists is immediately agent-callable with arbitrary arguments: a compromised or malicious server can steer file mutations, exfiltrate project content, or return prompt-injection payloads with no harness-side allowlist, argument-size cap, or result scanning/redaction.
- **Fix:** Add deny-by-default per-server tool allowlists from config, per-call argument byte caps, an output scanning/redaction hook, and a runtime kill switch to disable a misbehaving server mid-run.
- **Evidence:** listMCPTools returns whatever the server advertises and callMCPTool forwards args verbatim; no allowlist, byte cap, or output filter exists in the module

## [MEDIUM] state-mutation — common/src/mcp/client.ts:15 — runningClients/listToolsCache are never closed, evicted, or error-watched
- **Risk:** Stdio transports leak child processes for the life of the host process; listToolsCache entries pin resolved promises forever; a crashed server leaves a zombie client whose subsequent calls fail opaquely; changing an MCP config cannot take effect without a restart.
- **Fix:** Expose closeMCPClient(clientId) (client.close() plus cache eviction), register transport onerror/onclose handlers that evict dead clients, and bound the maps.
- **Evidence:** const runningClients: Record<string, Client> = {} has no close/delete path in the module

## [MEDIUM] security — common/src/tools/params/tool/run-terminal-command.ts:73 — Runtime-injected `owner` field is accepted (not stripped/rejected) in the model-facing input schema
- **Risk:** The documented trust boundary ('NEVER from model input' per RuntimeJobOwner in list.ts) is enforced only by handler discipline: the model-facing schema happily parses a model-supplied owner object, so any future handler that reads input.owner instead of the injected value trusts model-controlled run identity for job ownership asserts.
- **Fix:** Reject or strip `owner` at the model-facing inputSchema (strict object without the key) and accept it only in the client wire schema / handler injection, mirroring the ProcessJobClientToolCall pattern documented in list.ts.
- **Evidence:** owner: z.object({ clientSessionId: z.string(), rootRunId: z.string(), parentRunId: z.string(), parentAgentId: z.string() }).optional().describe('Runtime-managed background job owner; agents must omit.')

## [MEDIUM] error-handling — common/src/tools/params/tool/run-terminal-command.ts:64 — SYNC commands default to no timeout (timeout_seconds default -1)
- **Risk:** An accidental foreground hang (missing -y flag, interactive prompt, network wait) consumes the step indefinitely by default; the schema's own Do/Don't list warns commands 'will hang if you don't use the flags' yet the default posture is unbounded.
- **Fix:** Default to a finite budget (e.g. 120s) with -1 as an explicit opt-out, and echo the effective timeout in the result for diagnostics.
- **Evidence:** timeout_seconds: z.number().default(-1).optional() ... 'Omit or use -1 for no timeout (the default).'

## [MEDIUM] security — common/src/util/sensitive-paths.ts:14 — Cloud service-account keys and .git-credentials are not in the mandatory sensitive set
- **Risk:** A gcloud service-account key (private-key material with basenames like `service-account-key.json` or `sa-key.json`) or a `.git-credentials` store inside an allowlisted external-read root or the OS temp root is agent-readable despite the fail-closed resolver refusals, because isMandatorySensitiveReadPath only matches the 'credentials' substring with a structured extension.
- **Fix:** Add service-account/gcloud-key patterns (e.g. /^service[-_]?account.*\.json$/), `.git-credentials`, and a `secrets.<structured>` family to the mandatory set with matching test cases.
- **Evidence:** SENSITIVE_BASENAMES contains credentials/auth.json/.pypirc/.npmrc/.terraformrc/terraform.tfvars; no pattern matches `service-account-key.json`, `service-account-*.json`, or `.git-credentials`

## [MEDIUM] security — common/src/util/project-path-containment.ts:925 — Win32-aliased sensitive paths are guarded in temp/external resolvers but not for scope 'project'
- **Risk:** On Windows, reading `<project>/.env ` resolves the OS to the real `.env` while the raw basename fails the exact sensitive match; the alias guard protects the temp/external scopes but in-project reads rely on each handler checking the right path form, so the mandatory policy is not centrally enforced for the scope that carries the most traffic.
- **Fix:** Apply refusesWin32AliasedSensitivePath (or normalize segments before the sensitive check) inside resolveProjectPath/ForFileSystem so all three scopes agree.
- **Evidence:** refusesWin32AliasedSensitivePath is called only in resolveOwnedTempRealPath/resolveExternalReadRealPath; resolveProjectPath returns scope:'project' without consulting it

## [MEDIUM] state-mutation — common/src/util/project-path-containment.ts:510 — Project switch replaces the process-global external-read boundary while other runs may still be using it
- **Risk:** The registry is process-global with a single owner: two concurrent runs for different projects in one process flip the shared allowlist, so project A's in-flight external reads are silently re-validated against project B's boundary (widening or narrowing retroactively mid-run).
- **Fix:** Scope the registry per projectRoot (Map keyed by resolved owner) or return per-run boundary handles instead of one global pair, so concurrent projects cannot mutate each other's allowlist.
- **Evidence:** if (projectSwitched) replaces the boundary; externalReadRoots = normalized (single module-global pair)

## [MEDIUM] error-handling — common/src/tools/compile-tool-definitions.ts:23 — Schema conversion failures are swallowed with console.warn and degrade generated types to any
- **Risk:** A schema that fails z.toJSONSchema silently downgrades that tool's published params type to `{ [key: string]: any }`, so custom agents lose all compile-time checking for the affected tool; the only signal is a console.warn in build output.
- **Fix:** Fail the generation script (non-zero exit) or collect all conversion errors and throw after listing them; at minimum add a CI assertion that no tool falls back to the any-typed branch.
- **Evidence:** catch (error) { console.warn(`Failed to convert schema for ${toolName}:`, error); typeDefinition = '{ [key: string]: any }' }

## [MEDIUM] security — common/src/tools/params/tool/spawn-agents.ts:24 — Legacy unversioned handoff branch accepts arbitrary records with no validation
- **Risk:** Any key/value payload without schemaVersion flows into the spawned agent's handoff unvalidated (no size, shape, or key constraints), so a spawning model can smuggle arbitrarily large or prompt-injecting content past schema checking that versioned handoffs must satisfy.
- **Fix:** Bound the legacy record (max keys/bytes, string values only, known advisory keys) or gate it behind an explicit capability and a deprecation window.
- **Evidence:** legacyUnversionedHandoffSchema = z.record(z.string(), z.unknown()).refine((value) => value.schemaVersion === undefined, ...)

## [LOW] api-contract — common/src/tools/list.ts:283 — run_terminal_command permission_profile enum duplicated in three hand-maintained copies
- **Risk:** The 8-value permission-profile enum is hand-copied into the client wire schema (and again in the tool's outputSchema and the sdk enforcement); adding a profile in one copy silently diverges validation from enforcement and diagnostics.
- **Fix:** Export a single permissionProfileSchema constant and reuse it in the input, output, and client wire schemas.
- **Evidence:** clientToolCallSchema re-declares z.enum(['read-only','librarian-read-only','git-commit','dependency-mutation','validation-diagnosis','tmux-test','workspace-write','full-access']) also present in terminalCommandOutputSchema

## [LOW] correctness — common/src/tools/params/tool/run-terminal-command.ts:33 — Stale comment claims command may be empty while the schema enforces min(1)
- **Risk:** The comment documents an impossible usage; maintainers and model-facing docs disagree with the schema, inviting either a wrong removal of min(1) or confusion about the timeout-only invocation.
- **Fix:** Update the comment to match the schema, or explicitly implement and document the empty-command usage.
- **Evidence:** // Can be empty to use it for a timeout. directly precedes command: z.string().min(1, 'Command cannot be empty')

## [LOW] security — common/src/tools/params/tool/spawn-agents.ts:291 — Empty visible-catalog silently degrades spawn agent_type to a free-form string
- **Risk:** An empty visible catalog (catalog-rendering bug, failed template load) removes the deny-by-default enum instead of failing closed, so hallucinated agent types pass schema validation exactly when the system is in its least trustworthy state.
- **Fix:** Keep the enum even when empty (forcing rejection), or return an explicit cannot-spawn surface rather than a free-form fallback.
- **Evidence:** if (uniqueValues.length === 0) { return buildSpawnAgentsProviderSchema(z.string().describe(...)) }

## [LOW] security — common/src/tools/params/tool/spawn-agents.ts:104 — timeout_seconds and browser url params lack numeric/URL bounds at the schema
- **Risk:** A schema-level unbounded timeout (e.g. 1e9 seconds) or a non-URL string is deferred entirely to runtime enforcement; bounding resource fields and URL shape at the schema would catch misuse before an agent process is spawned or a browser navigates.
- **Fix:** Add .max() (e.g. 3600) and .url() with an http/https scheme allowlist; leave SSRF policy enforcement at runtime but bound the shape at the schema.
- **Evidence:** timeout_seconds: z.number().optional() has no .max(); url: z.string().optional() has no .url() or scheme constraint

## [LOW] security — common/src/tools/params/tool/spawn-agents.ts:305 — snapshot_id accepted in model-facing schema; gate-token authority is advisory at this layer
- **Risk:** The schema accepts snapshot_id from any model and normalizeSpawnAgentList actively extracts v3 tokens from prose; downstream createSpecialist verifies the fingerprint, but the schema-level contract relies entirely on that runtime check, and a future consumer that trusts the field directly would accept a model-chosen capability token.
- **Fix:** Keep the recovery but add a schema-level marker (e.g. transform that flags snapshot_id as untrusted), or move snapshot_id out of the model-facing schema entirely into the runtime-owned injection channel.
- **Evidence:** paramsRecord.snapshot_id = explicitSnapshot after matching 'Snapshot ... :' prose; schema accepts snapshot_id: z.string().optional() with 'Runtime-owned spawns pass the gate-assigned v3:... token'

## [LOW] test-coverage — common/src/tools/__tests__/spawn-agents-schema.test.ts:1 — spawn_agents tests never exercise the batch cap, legacy handoff branch, or v3-token prose recovery
- **Risk:** The security-relevant boundaries of this tool (batch cap, unversioned-handoff passthrough, snapshot-token recovery) can regress without any failing test, while only the happy-path repairs are pinned.
- **Fix:** Add boundary tests: batch size +1 rejection, legacy record acceptance + size, and the v3-token prose recovery regex (positive and negative).
- **Evidence:** tests cover handoff acceptance/repair and the catalog enum but no test parses MAX_SPAWN_BATCH_SIZE+1 agents, a schemaVersion-less handoff record, or a prompt containing a v3: token for recovery

## [LOW] correctness — common/src/tools/params/utils.ts:68 — 256KB repair/scan cap sits far below the 64MB transaction input cap, so large payloads lose truncation classification
- **Risk:** Legal-but-large edit transactions beyond 256KB never get truncation classification or separator repair: a legitimately oversized payload cut in transport surfaces a generic syntax error instead of the structured payload_truncated code the tool description promises.
- **Fix:** Document the cap in the tool description, or scale the scan cap with the transaction limit and use a streaming/bounded-index scan so classification works for legal large payloads.
- **Evidence:** const MAX_REPAIRABLE_JSON_LENGTH = 256_000 (also MAX_TRUNCATION_SCAN_LENGTH) vs MAX_TRANSACTION_INPUT_BYTES = 64 * 1024 * 1024

## [LOW] correctness — common/src/tools/params/tool/edit-transaction.ts:520 — Unique-path cap compares raw path spellings, so equivalent paths evade the 128-path bound
- **Risk:** `a.ts`, `./a.ts`, and `a//b/../a.ts` count as three distinct paths, so the MAX_TRANSACTION_UNIQUE_PATHS resource bound is advisory; real containment still applies at write time, so this is a bound-accuracy gap rather than a security hole.
- **Fix:** Normalize paths (posix separators, collapse dots) before building the Set, or document the bound as lexical-only.
- **Evidence:** const paths = new Set(edits.flatMap((edit) => edit.type === 'move' ? [edit.path, edit.destinationPath] : [edit.path]))

## [LOW] correctness — common/src/types/session-state.ts:598 — AgentTemplateType union erases enum narrowing via (string & {})
- **Risk:** The `(string & {})` escape makes every string assignable to AgentTemplateType, so typos in built-in agent type references type-check and the enumerated list is documentation-only; any switch/narrowing on the type is unchecked.
- **Fix:** Keep the strict enum for internal template types and introduce a separate string-typed DynamicAgentTemplateType for user templates.
- **Evidence:** export type AgentTemplateType = z.infer<typeof agentTemplateTypeSchema> | (string & {})

## [LOW] performance — common/src/types/session-state.ts:240 — Read-authorization registries have no eviction cap on long runs
- **Risk:** readAuthorizationsByPath, readAuthorizationHashesByPath, confirmedPostEditAnchorsByPath and editRereadRequirementsByPath grow monotonically for long-lived runs over large trees; the growth is documented but unbounded, and serialized checkpoints grow with it.
- **Fix:** Add an LRU cap (e.g. 1000 entries) with stale-oldest eviction shared across the three per-path maps so memory is bounded deterministically.
- **Evidence:** Entries are revoked when their paired content hash is stale or an edit application fails. The registry is otherwise bounded by the distinct paths touched during a run; no separate eviction policy is implemented.

## [LOW] state-mutation — common/src/types/session-state.ts:601 — Persisted AgentState has no runtime schema validation on resume
- **Risk:** Corrupted or hand-edited session state (invalid status unions, non-string runIds, wrong array element shapes) silently flows into the runtime and can break invariants far from the deserialization site, since nothing validates the shape of a resumed state.
- **Fix:** Define an AgentStateSchema (loose-but-typed: validate unions/enums, strip unknown keys) and validate at the resume boundary, dropping malformed optional fields with a warning.
- **Evidence:** AgentState is a plain type; fields document 'optional so old sessions parse cleanly' but there is no zod schema validating a deserialized AgentState anywhere in common

## [LOW] test-coverage — common/src/__tests__/agent-validation.test.ts:1 — agent-validation tests omit duplicate-ID rejection and generator-variant edge cases
- **Risk:** The duplicate-agent-ID rejection and the generator sniff can regress silently; `function *(...)` with a space before the star is falsely rejected today, and the untested duplicate path protects against template shadowing.
- **Fix:** Add cases for duplicate ids, 'function * (params)', 'async function*', and non-generator strings; relax the check to /^function\s*\*/ and decide explicitly how async generators are treated.
- **Evidence:** no test creates two templates with the same id; isValidGeneratorFunction('function * (params) { ... }') style inputs are unexercised

## [LOW] api-contract — common/src/tools/list.ts:330 — Client wire schema for edit_transaction/str_replace/write_file uses CHANGES/FileChangeSchema, not the tool's own schemas
- **Risk:** Two validation surfaces exist for the same tools (the capability-era transaction schema vs the legacy FileChange wire schema); drift between them yields client-accepted payloads that the SDK re-validator rejects with confusing errors.
- **Fix:** Document the translation contract in list.ts, or converge the client schema on providerInputSchema the way replace_range already does.
- **Evidence:** clientToolCallSchema: z.object({ toolName: z.literal('edit_transaction'), input: CHANGES }) and str_replace/write_file use FileChangeSchema

## [LOW] correctness — common/src/tools/list.ts:358 — clientToolNames extracts names via zod .def internals
- **Risk:** .def is not public zod API and .value assumes the literal shape; a zod upgrade or a refactoring of the union breaks name extraction at runtime rather than at compile time.
- **Fix:** Derive the names from a maintained literal array or registry rather than schema introspection.
- **Evidence:** export const clientToolNames = clientToolCallSchema.def.options.map((opt) => opt.shape.toolName.value)

## [LOW] dependency-hygiene — common/package.json:37 — Mixed version pinning and a duplicated stableHash implementation
- **Risk:** Caret ranges for the MCP SDK and zod let minor upgrades silently change transport/validation behavior, while zod-from-json-schema is exact-pinned; the duplicated stableHash implementation can drift from the canonical one used elsewhere for identity decisions.
- **Fix:** Align the pinning policy (lockfile-enforced ranges) and import the canonical stableHash instead of the private copy.
- **Evidence:** "@modelcontextprotocol/sdk": "^1.18.2", "zod": "^4.2.1", "zod-from-json-schema": "0.4.2"; mcp/client.ts defines a local stableHash (sha256 of JSON) while util/stable-hash.ts exports stableHash

## [LOW] state-mutation — common/src/util/project-path-containment.ts:370 — Owned-temp root cache has no reset hook, unlike the external-read registry
- **Risk:** os.tmpdir() is captured on first use and never refreshed; a test or host that changes TMPDIR after the first containment check validates against the stale root, and there is no way to invalidate short of a process restart.
- **Fix:** Export a matching resetOwnedTempRootsForTesting (or key the memoization on the current tmpdir) so host/test changes recompute the roots.
- **Evidence:** ownedTempRootsCache = [path.resolve(os.tmpdir()), ...(win32 ? [] : [path.resolve('/tmp')])] memoized with no reset export, unlike resetExternalReadRootsForTesting

## [LOW] error-handling — common/src/mcp/client.ts:196 — getResourceData silently returns '' for unrecognized resource shapes
- **Risk:** An unexpected resource shape becomes an empty media payload with no diagnostic, so server contract drift presents as mysteriously blank tool results instead of a structured error the model can react to.
- **Fix:** Return a typed unknown/error marker (or include the resource uri and a diagnostic note) instead of an empty payload.
- **Evidence:** if ('text' in resource) return resource.text; if ('blob' in resource) return resource.blob; return ''

## Coverage receipt

### Subsystems
- common-tool-registry
- common-tool-params-schemas
- common-tool-input-aliases
- common-compile-tool-definitions
- common-edit-transaction-schema
- common-spawn-agents-schema
- common-run-terminal-command-schema
- common-path-containment
- common-sensitive-path-policy
- common-session-state-model
- common-spawn-types
- common-mcp-client
- common-agent-template-validation
- common-tool-test-suite

### Features
- tool-registry-consistency
- model-vs-provider-dual-schema
- input-alias-normalization
- generated-tool-type-definitions
- capability-gated-edit-schema
- transaction-resource-bounds
- transport-truncation-recovery
- spawn-catalog-deny-by-default
- structured-agent-handoff
- terminal-permission-profiles
- owned-temp-exception
- external-read-allowlist
- symlink-aware-containment
- win32-alias-guard
- mandatory-sensitive-read-policy
- agent-session-artifact-allowlist
- session-state-resume-contract
- mcp-client-cache-key-privacy
- mcp-transport-lifecycle
- mcp-tool-result-mapping
- dynamic-agent-template-validation

### Files
- common/src/tools/list.ts
- common/src/tools/compile-tool-definitions.ts
- common/src/tools/constants.ts
- common/src/tools/params/tool/spawn-agents.ts
- common/src/tools/params/tool/edit-transaction.ts
- common/src/tools/params/tool/run-terminal-command.ts
- common/src/tools/params/input-aliases.ts
- common/src/tools/params/utils.ts
- common/src/types/session-state.ts
- common/src/types/spawn.ts
- common/src/types/mcp.ts
- common/src/util/sensitive-paths.ts
- common/src/util/project-path-containment.ts
- common/src/templates/agent-validation.ts
- common/src/mcp/client.ts
- common/src/actions.ts
- common/src/tools/__tests__/spawn-agents-schema.test.ts
- common/src/tools/__tests__/input-aliases.test.ts
- common/src/tools/__tests__/tool-registration-consistency.test.ts
- common/src/tools/__tests__/compile-tool-definitions.test.ts
- common/src/tools/__tests__/edit-transaction-limits.test.ts
- common/src/tools/params/__tests__/truncation-recovery.test.ts
- common/src/tools/params/__tests__/edit-transaction.schema.test.ts
- common/src/tools/params/__tests__/range-capability-input.test.ts
- common/src/util/__tests__/sensitive-paths.test.ts
- common/src/util/__tests__/project-path-containment.test.ts
- common/src/mcp/__tests__/client.test.ts
- common/src/__tests__/agent-validation.test.ts

### Domains
- security
- correctness
- state-mutation
- error-handling
- performance
- dependency-hygiene
- test-coverage
- api-contract
