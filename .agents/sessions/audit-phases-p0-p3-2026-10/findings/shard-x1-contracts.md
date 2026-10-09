# Audit findings: shard-x1-contracts

- Subsystems: common-tools-contract-pipeline, common-tools-params-registry, common-protocol-acp-ext-v1, common-tools-results-contracts, common-package-manifest
- Features: x1-golden-vectors, tool-json-schema-pipeline, throw-on-unhandled-shape-mapper, tool-registration-consistency, acp-ext-v1-protocol-contract, acp-ext-v1-golden-fixtures, cap-v3-grammar-vectors, file-mutation-result-v1, commit-receipt-v1, wire-redaction-gv07, gate-state-projection, capability-map-v1, tool-kind-table, find-files-params, find-files-matching-content-params, read-files-schema-inference
- Files covered: 10
- Snapshot: 5c80253b458f8b07b8ca33e50cc3d6ad7e6cda07ef1715ba8adffd8c77905ab7

## [MEDIUM] correctness — common/src/tools/compile-tool-definitions.ts:128 — Object-level composite keys (allOf/patternProperties/$defs/prefixItems) are silently dropped instead of thrown
- **Risk:** The documented throw-on-unhandled-shape contract only fires at leaf level. An object schema that carries `properties` alongside `allOf`, `patternProperties`, `prefixItems` or `$defs` silently drops those keywords, publishing a TypeScript type mirror that is more permissive/less accurate than the wire JSON Schema — exactly the silent-drift class the freeze was meant to eliminate.
- **Fix:** Whitelist the object keys the mapper understands (`type`, `properties`, `required`, `additionalProperties`) and throw on any unrecognized sibling key, mirroring the leaf-level throw contract; or explicitly handle allOf/patternProperties.
- **Evidence:** read of common/src/tools/compile-tool-definitions.ts: jsonSchemaToTypeScript handles only `properties` and `additionalProperties` in the object branch; no check that other schema keywords are absent, while leaf shapes throw via `Unsupported JSON Schema shape`.

## [MEDIUM] correctness — common/src/tools/compile-tool-definitions.ts:160 — Nested object with additionalProperties:false and no properties maps to Record<string, any>
- **Risk:** `if (prop.additionalProperties)` is falsy for `false`, so a strict empty object (`z.object({}).strict()`, which zod emits as `{type:'object',additionalProperties:false}`) maps to `Record<string, any>` — the generated TS mirror advertises arbitrary keys the wire schema rejects. getAdditionalPropertiesType handles `false` correctly at the top level, so the two paths disagree.
- **Fix:** Branch on `prop.additionalProperties === false` and emit a closed type (e.g. `{}` or `Record<never, never>`), reusing getAdditionalPropertiesType for the nested case.
- **Evidence:** read of compile-tool-definitions.ts: `if (prop.additionalProperties) { ... Record<string, ...> } return 'Record<string, any>'` — the truthiness check treats `additionalProperties: false` the same as absent.

## [LOW] error-handling — common/src/tools/compile-tool-definitions.ts:14 — resolveToolParameterSchema blind-casts unknown to $ToolParams; missing registry entry yields a cryptic crash
- **Risk:** Casting `unknown as $ToolParams` with no runtime guard means a publishedTools entry missing from toolParams (the exact 'added here but missing there' failure mode the consistency suite targets) surfaces as a confusing TypeError deep inside z.toJSONSchema rather than an error naming the tool. Double casts (`as $ToolParams`, `as z.ZodType`) also hide real type regressions from the compiler.
- **Fix:** Accept the tool name (or a tagged entry), throw a named error when the registry entry is missing, and drop the `as` casts in favor of a structural check.
- **Evidence:** read of compile-tool-definitions.ts: `const typedToolDef = toolDef as $ToolParams; return (typedToolDef.providerInputSchema ?? typedToolDef.inputSchema) as z.ZodType` with no null check or tool-name context.

## [MEDIUM] security — common/src/protocol/acp-ext-v1.ts:100 — wireFilesystemErrorV1Schema.message is free-form and unredacted — leak channel for cap.v3 tokens/paths/credentials
- **Risk:** The module's redaction invariant (GV-07) is structural only: freshCapabilities/editAnchor/afterContent are dropped, but `error.message` is a free-form string that flows to the ACP client verbatim. Any internal message embedding a cap.v3 token, an absolute host path, or a credential passes the strict schema, and no golden vector asserts message-content redaction (GV-15/GV-27/GV-28 check only the pre-serialized fixtures).
- **Fix:** Constrain or sanitize `message` at the projection boundary (strip cap.v3 tokens, collapse absolute host paths to project-relative, cap length) and add a golden vector whose source error message embeds a cap.v3 token plus a credential to assert the wire output is redacted.
- **Evidence:** read of common/src/protocol/acp-ext-v1.ts and acp-ext-v1.golden.test.ts: wireFilesystemErrorV1Schema is `{code,message,retryable,...}.strict()`; GV-07/GV-15 assert structural key absence but no vector inspects message text.

## [LOW] security — common/src/tools/params/tool/find-files-matching-content.ts:40 — find_files_matching_content cwd explicitly allows absolute paths outside the project
- **Risk:** The param schema and description explicitly permit `cwd` to point outside the project root, letting the model enumerate file names and match metadata anywhere the process can read. It is read-only, but on a non-sandboxed ('lexical', enforced:false per defaultCapabilityMapV1) host this is an uncontained filesystem-listing surface.
- **Fix:** Document (in code, not just prose) where the out-of-project boundary is enforced, and gate absolute-outside-project cwd on the sandbox/authority tier so weaker tiers cannot enumerate paths outside the workspace.
- **Evidence:** read of find-files-matching-content.ts: cwd .describe text says 'Absolute paths may be outside the project'; no schema-level constraint is possible or present.

## [LOW] security — common/src/tools/__tests__/read-files-schema.test.ts:138 — Provider-fragmented symbol selectors are JSON-deserialized inside the schema preprocessor
- **Risk:** The tested preprocessor JSON.parse's an arbitrary number of provider-supplied string fragments and splices them into a selector. JSON.parse itself is prototype-pollution-safe, but the schema-level path places no bound on fragment count or total size, so a malformed/hostile payload is decoded before any validation, and only the happy path is tested.
- **Fix:** Cap fragment count and total decoded length in the schema (e.g. max ~8 fragments, ~2KB total), and add a negative test for oversized/malformed fragments.
- **Evidence:** read of read-files-schema.test.ts: 'decodes provider-fragmented symbol selectors before inferring the path' test; no maxItems/max length constraints are visible on the symbols selector in the exercised schema.

## [MEDIUM] test-coverage — common/src/protocol/__tests__/acp-ext-v1.golden.test.ts:660 — §12.7/§12.8 vectors (GV-15..GV-30) largely pin fixture-declared expectations, not implemented behavior
- **Risk:** Many security vectors assert the fixture's own declared expectation fields (GV-16 `expectedFrames`, GV-18 `expectedSpawnedProcesses`, GV-23 `expectedCommandExecutions`, GV-29 `expectedLoadedMcpServers`/`expectedConnectionAttempts`) rather than exercising implementation code. A runtime regression that redacts nothing or spawns forbidden processes keeps these tests green, so the 'frozen security contract' claim is weaker than it reads.
- **Fix:** Either drive these vectors through the real serve/bridge code paths (spawn counts, connection attempts, emitted frames captured from the implementation) or annotate the suite so the parent audit does not count GV-15..30 as executable security regression tests.
- **Evidence:** read of acp-ext-v1.golden.test.ts: `expect(gv16.expectedFrames).toEqual([])`, `expect(gv18.expectedSpawnedProcesses).toBe(0)`, `expect(gv29.expectedConnectionAttempts).toBe(0)` — all operands come from the fixture object.

## [LOW] test-coverage — common/src/tools/params/__tests__/x1-golden-vectors.test.ts:240 — No vector for the dedicated $ref throw branch or getAdditionalPropertiesType true→any path
- **Risk:** The suite pins the generic throw (`{ not: {} }`) and empty-object→any, but the $ref branch has its own distinct error message and the getAdditionalPropertiesType `true→'any'` and allOf-intersection branches are only exercised incidentally through full compiles. A future edit could break the $ref contract without any test failing.
- **Fix:** Add golden vectors for the $ref throw (pinning its distinct message), `additionalProperties: true`, and the allOf intersection mapping.
- **Evidence:** read of x1-golden-vectors.test.ts: throw assertions cover only `{ not: {} }`; no `expect(...$ref...).toThrow()` and no assertion for `additionalProperties: true` → `[key: string]: any`.

## [MEDIUM] test-coverage — common/src/tools/__tests__/tool-registration-consistency.test.ts:160 — Unrepresentable-schema tool list is collected but never asserted
- **Risk:** The portable-regex test catches toJSONSchema conversion failures per tool and stores them in `unrepresentable`, but never asserts the set. Any tool other than write_audit_findings can silently become non-JSON-Schema-representable, meaning its provider-facing schema stops being compiled/validated without CI noticing — the same class of silent drift the freeze targets.
- **Fix:** Assert `expect(unrepresentable.sort()).toEqual(<frozen allowlist>)` so any new non-representable tool fails CI until explicitly accepted.
- **Evidence:** read of tool-registration-consistency.test.ts: `unrepresentable.push(name)` inside catch, followed by assertions only on converted/unrepresentable containing/not-containing 'write_audit_findings'.

## [LOW] api-contract — common/src/tools/__tests__/tool-registration-consistency.test.ts:146 — Test duplicates the providerInputSchema ?? inputSchema resolution rule instead of importing the shared resolver
- **Risk:** The test re-implements `providerInputSchema ?? inputSchema` inline instead of calling the shared resolveToolParameterSchema, so a future change to resolution precedence (or additional fallback) would update the pipeline while this guard keeps validating a stale rule — the suite would then certify a contract it no longer exercises.
- **Fix:** Import and use resolveToolParameterSchema from compile-tool-definitions so the consistency test tracks the single resolution contract.
- **Evidence:** read of tool-registration-consistency.test.ts: `const schema = (params.providerInputSchema ?? params.inputSchema) as z.ZodType` — a re-implementation of the shared helper.

## [MEDIUM] dependency-hygiene — common/package.json:45 — zod pinned with caret (^4.2.1) while the contract freeze byte-pins z.toJSONSchema output
- **Risk:** compileToolJsonSchemas/compileToolDefinitions pin byte-exact z.toJSONSchema output (key order, $schema placement) in golden fixtures, but zod is caret-floating. A zod minor that changes JSON Schema emission order or shape breaks the frozen artifacts; the golden tests would catch it, but the 'freeze' is only as stable as the floating dep. Mixed pinning policy (exact for ignore/lodash, caret for zod/ai/pg) adds inconsistency.
- **Fix:** Pin zod to an exact version for the freeze window (or add a lockfile-verified version check to the golden suite) and adopt one consistent pinning policy.
- **Evidence:** read of common/package.json: "zod": "^4.2.1" alongside exact pins like "lodash": "4.17.23" and "ignore": "5.3.2".

## [LOW] correctness — common/package.json:8 — Broken exports map: wildcard default condition is './src*.ts' instead of './src/*.ts'
- **Risk:** The wildcard export's `default` condition is `./src*.ts` (missing `/`). Non-bun resolvers that fall through to the default condition (bundler/node CJS consumers) resolve `@codebuff/common/tools/foo` to `./srctools/foo` and fail, so subpath imports silently work only under bun/import conditions.
- **Fix:** Correct the default condition to `./src/*.ts`.
- **Evidence:** read of common/package.json: "exports": { "./*": { "bun": "./src/*.ts", "import": "./src/*.ts", "types": "./src/*.ts", "default": "./src*.ts" } }.

## [LOW] performance — common/src/tools/params/tool/find-files.ts:54 — find_files output schema allows an unbounded fileContents array
- **Risk:** The declared output schema is `fileContentsSchema.array()` with no maxItems, so the wire contract permits an unbounded list of full file-content payloads, while the sibling search tool caps maxFiles at 100. Unbounded arrays inflate validation memory and context size for pathological results.
- **Fix:** Add a bounded maxItems to the declared output schema consistent with the runtime result cap.
- **Evidence:** read of find-files.ts: `z.union([fileContentsSchema.array(), z.object({message})])` — no `.max()` on the array.

## [LOW] api-contract — common/src/tools/params/tool/find-files-matching-content.ts:122 — find_files_matching_content wire contract looser than documented: count not int-bounded, flag allowlist unenforceable at schema level
- **Risk:** `count: z.number()` accepts floats and negatives, so the published output contract is looser than the documented 'Number of unique files matched'. Likewise the flags allowlist/denylist is prose-only: the wire schema advertises accepting `--exec`/`-c` etc., with rejection deferred entirely to runtime enforcement not visible from the contract surface.
- **Fix:** Tighten count to `.int().nonnegative()`, and either encode the allowlist structurally (e.g. typed flag tokens) or add a schema-level refine so the wire contract matches the documented enforcement.
- **Evidence:** read of find-files-matching-content.ts: `count: z.number().describe(...)` and the flags description listing runtime-rejected flags with no schema-level constraint.

## [LOW] correctness — common/src/protocol/acp-ext-v1.ts:470 — projectGateState uses inconsistent empty-value guards; a null progress crashes the wire schema
- **Risk:** progress guards on `!== undefined && !== ''` while reviewerVerdict/validationSummary/fingerprint/skipReason guard only on `!== ''`. A JS caller passing null (Base2GateState fields are untyped at runtime boundaries) yields `progress: null` or `reviewerVerdict: null`, which fails gateStateV1Schema's `z.string().min(1)` at the wire instead of being omitted.
- **Fix:** Normalize the guard to a single nonEmptyString helper for all optional fields, or add `?? ''` coercion at entry.
- **Evidence:** read of acp-ext-v1.ts projectGateState: `...(state.gateProgressLine !== undefined && state.gateProgressLine !== '' ? { progress: ... } : {})` vs `...(state.gatePassedReviewerVerdict !== '' ? ... : {})`.

## [LOW] api-contract — common/src/protocol/acp-ext-v1.ts:430 — toWireMutation forwards error/rollback/errors verbatim instead of projecting to the strict wire error schema
- **Risk:** toWireMutation maps every field explicitly except `error`, `rollback` and top-level `errors`, which are passed through by reference. wireFilesystemErrorV1Schema is `.strict()`, so any field added to the internal FileMutationActionV1 error shape (or any extra property on a passed-through rollback/error) makes the projection output fail its own wire schema at the boundary — the projection and the wire schema can drift with no compile-time check.
- **Fix:** Project errors through an explicit toWireError function (or derive wireFilesystemErrorV1Schema's keys from the internal error schema) so the projection is total and drift fails at compile time.
- **Evidence:** read of acp-ext-v1.ts toWireMutation: `error: action.error`, `rollback: action.rollback`, `errors: mutation.errors` copied directly into an object validated by `.strict()` wire schemas.

## Coverage receipt

### Subsystems
- common-tools-contract-pipeline
- common-tools-params-registry
- common-protocol-acp-ext-v1
- common-tools-results-contracts
- common-package-manifest

### Features
- x1-golden-vectors
- tool-json-schema-pipeline
- throw-on-unhandled-shape-mapper
- tool-registration-consistency
- acp-ext-v1-protocol-contract
- acp-ext-v1-golden-fixtures
- cap-v3-grammar-vectors
- file-mutation-result-v1
- commit-receipt-v1
- wire-redaction-gv07
- gate-state-projection
- capability-map-v1
- tool-kind-table
- find-files-params
- find-files-matching-content-params
- read-files-schema-inference

### Files
- common/src/tools/compile-tool-definitions.ts
- common/src/tools/params/__tests__/x1-golden-vectors.test.ts
- common/src/tools/__tests__/compile-tool-definitions.test.ts
- common/src/tools/__tests__/tool-registration-consistency.test.ts
- common/src/protocol/acp-ext-v1.ts
- common/src/protocol/__tests__/acp-ext-v1.golden.test.ts
- common/src/tools/params/tool/find-files.ts
- common/src/tools/params/tool/find-files-matching-content.ts
- common/src/tools/__tests__/read-files-schema.test.ts
- common/package.json

### Domains
- security
- correctness
- state-mutation
- error-handling
- performance
- dependency-hygiene
- test-coverage
- api-contract
