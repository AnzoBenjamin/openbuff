# Audit findings: p3-a-tool-surface

- Subsystems: common-tool-registry, agent-runtime-tool-handlers, agents-base2-surface, agents-type-mirrors, cli-tool-renderers, sdk-language-intelligence
- Features: P3-T2, LI-01
- Files covered: 22
- Snapshot: f6f2d4aa162b3cc09c6d64e96f8e03bb4b430c5444981de1b88a548d1690980a

## [HIGH] correctness — agents/base2/base2.ts:420 — Four P3 LSP tools are mode-neutral but unreachable from base2's model-visible tool list
- **Risk:** The flagship base2 agent template can never call go_to_definition, find_references, hover_type, or workspace_symbol: the P3-T2 tools are registered, published, and mode-neutral, but invisible to base2's model, so the plan's LI-01 goal (definition/references/hover reachable from the main agent) is not met end-to-end. MODE_NEUTRAL_TOOL_NAMES membership is necessary but not sufficient, which also makes the fail-closed mode policy misleading.
- **Fix:** Decide and document intent: either add the four LSP tools to BASE2_CORE_TOOL_NAMES (they are read-only discovery tools, like read_outline) or to an appropriate BASE2_TIER_TOOL_NAMES entry, or document that the base2 template deliberately withholds them pending fixture-test gate completion. Whatever is chosen, keep MODE_NEUTRAL_TOOL_NAMES consistent with the actual reachability so the fail-closed policy is not misleading.
- **Evidence:** agents/base2/base2.ts:419-426 `const modelToolNames = resolveModelToolNames({...})` then line 462 `toolNames: modelToolNames`; packages/agent-runtime/src/util/base2-tool-tiers.ts:30-48 BASE2_CORE_TOOL_NAMES has no go_to_definition/find_references/hover_type/workspace_symbol; lines 61-90 BASE2_TIER_TOOL_NAMES (implement/audit/media_3d/job_extra) likewise contain none of the four; agents/base2/tool-tiers.ts:96-98 resolveModelToolNames docstring "CORE first, then one block per unlocked tier" confirms combined list construction; agents/base2/tool-tiers.ts:54 lists go_to_definition in MODE_NEUTRAL_TOOL_NAMES, :117 hover_type, :125 workspace_symbol.

## [LOW] api-contract — common/src/tools/metadata.ts:130 — metadata.ts PATH_INPUTS omits the `path` input of the three position-based LSP tools
- **Risk:** Any consumer that relies on toolMetadata[t].pathInputs to account for which read tools consume project paths (auditing, scheduling scopes, mutation/impact tooling) under-counts the three position-based LSP tools, making the metadata contract incomplete relative to sibling read tools like read_outline/read_subtree.
- **Fix:** Add `go_to_definition: ['path']`, `find_references: ['path']`, and `hover_type: ['path']` to PATH_INPUTS (workspace_symbol takes only `query`, correctly absent) so path-input accounting stays total for read tools.
- **Evidence:** common/src/tools/metadata.ts PATH_INPUTS map (read_outline: ['path'], read_files with path arrays, etc.) has no entries for go_to_definition, find_references, hover_type, or workspace_symbol, although each params file declares `path: z.string().min(1).describe('Project-relative file path.')` (go-to-definition.ts:31-33, find-references.ts:29-31, hover-type.ts:31-33).

## [LOW] api-contract — common/src/tools/params/tool/go-to-definition.ts:33 — LSP position params have no upper bounds, unlike bounded sibling numeric params
- **Risk:** A model emitting a huge line/character value (e.g. line: 1e9) passes validation and is forwarded to the LSP multiplexer, where behavior depends entirely on runtime clamping; sibling read tools (get_change_review_bundle max_chars 500..200000) consistently bound numeric inputs. Low practical risk since handlers convert 1-based to 0-based and can clamp, but the contract differs from the codebase norm.
- **Fix:** Add a generous integer ceiling (e.g. .max(10_000_000) for line, .max(100_000) for character/query length) or document in the description that the runtime clamps out-of-range positions to the file bounds, so the schema matches the bounded style of sibling tools.
- **Evidence:** go-to-definition.ts:33-42 `line: z.number().int().min(1)`, `character: z.number().int().min(0)` (no .max()); identical in find-references.ts and hover-type.ts; compare get-change-review-bundle.ts:27 `max_chars: z.number().int().min(500).max(200_000)`. workspace-symbol.ts:28-31 `query: z.string().min(1)` likewise unbounded above.

## [LOW] test-coverage — common/src/tools/__tests__/client-tool-call-schema.test.ts:1 — No test asserts the four LSP tools parse through clientToolCallSchema or that clientToolNames stays within publishedTools
- **Risk:** The four clientToolCallSchema entries for the LSP tools are hand-maintained literals in list.ts; if one is later dropped or drifts from its toolParams schema, no test in common fails, so the client wire contract for P3-T2 could regress silently.
- **Fix:** Extend tool-registration-consistency.test.ts with: (a) an assertion that clientToolNames is a subset of publishedTools, and (b) a parse round-trip for one representative input of each of the four LSP tools through clientToolCallSchema; or add cases to client-tool-call-schema.test.ts.
- **Evidence:** client-tool-call-schema.test.ts contains exactly two tests, both about run_terminal_command approval_receipt_id; tool-registration-consistency.test.ts checks list.ts keys vs toolNames (line 34), generated unions (lines 72-101), and wire regex portability, but never intersects clientToolNames with publishedTools or asserts the four literal entries at list.ts:314-329 exist.

## Coverage receipt

### Subsystems
- common-tool-registry
- agent-runtime-tool-handlers
- agents-base2-surface
- agents-type-mirrors
- cli-tool-renderers
- sdk-language-intelligence

### Features
- P3-T2
- LI-01

### Files
- common/src/tools/constants.ts
- common/src/tools/list.ts
- common/src/tools/metadata.ts
- common/src/tools/params/tool/go-to-definition.ts
- common/src/tools/params/tool/find-references.ts
- common/src/tools/params/tool/hover-type.ts
- common/src/tools/params/tool/workspace-symbol.ts
- common/src/tools/params/tool/get-affected-tests.ts
- common/src/tools/params/tool/get-change-review-bundle.ts
- common/src/tools/__tests__/tool-registration-consistency.test.ts
- common/src/tools/__tests__/client-tool-call-schema.test.ts
- agents/types/tools.ts
- common/src/templates/initial-agents-dir/types/tools.ts
- .agents/types/tools.ts
- cli/src/data/initial-agent-type-sources.generated.ts
- agents/base2/tool-tiers.ts
- agents/base2/base2.ts
- packages/agent-runtime/src/util/base2-tool-tiers.ts
- packages/agent-runtime/src/tools/handlers/list.ts
- cli/src/components/tools/registry.ts
- cli/src/components/tools/language-intelligence.tsx
- .agents/sessions/polyglot-roadmap-v2/PLAN.md

### Domains
- correctness
- api-contract
- test-coverage
