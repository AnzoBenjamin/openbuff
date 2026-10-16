# Audit findings: r7-agents-contracts

- Subsystems: agents-base2, agents-editor, agents-context-pruner, agents-specialists, common-mcp, common-tools-edit-transaction, common-util, common-agents-router, common-templates
- Features: base2-gate-fingerprint, plan-task-gate-receipts, reviewer-attestation-condone, edit-blocks-parser, edit-transaction-bounds, mcp-origin-registry, mcp-dns-rebinding-pinning, secret-redaction-corpus, base2-tool-tiers, spawn-contract-derivation, specialist-risk-router, language-capability-manifest, prompt-section-budget, d53-handlesteps-bundling, d15-d31-secret-rule-codegen, p9-t1-agent-yaml, p9-t4-quickjs-isolate, p2-t6-gate-statechart
- Files covered: 17
- Snapshot: d2df71d608d67a3324faf6271f018ab600c00fab18ad1a67b7964172d6289935

## [HIGH] security — common/src/util/redact-secrets.ts:15 — Secret-redaction corpus is 5 hand-written shapes; D15/D31 gitleaks codegen not implemented, with a char-class typo
- **Risk:** D15/D31 call for a codegen'd gitleaks-backed rule authority, but TOKEN_SHAPES is still 5 hand-written shapes: sk-, ghp_, gh[o rus]_, AKIA, Bearer. The char class `gh[o rus]_` contains a literal SPACE (a typo matching 'gh _') instead of gh[ours]_. Credentials outside KEY= assignments pass through for major ecosystems: npm_, pypi-AgEI..., glpat-, github_pat_, dckr_pat_, rubygems_, cio (crates.io), ASIA (AWS temporary), Stripe sk_live_ (underscore, so the sk- rule misses it), PEM private-key blocks and JWTs. The assignment regex also fails on declaration-prefixed assignments (`const API_KEY = ...`) because the leading-name group captures 'const' and then finds no separator, and on quoted JSON keys ("apiKey": "..."). Tool results and logs carrying these secrets reach prompts/telemetry unredacted.
- **Fix:** Implement the D15/D31 codegen: vendor a pinned gitleaks.toml, emit the TS TOKEN_SHAPES table (with regex-dialect translation and a keyword prefilter) plus the Rust table, pin the [REDACTED] contract with golden vectors, and list any non-translating rules. Short term: fix the class to gh[ours]_, add github_pat_, glpat-, npm_, pypi-, dckr_pat_, rubygems_, cio, ASIA, Stripe sk_live_, PEM and JWT shapes, and accept declaration keywords + quoted keys in the assignment regex.
- **Evidence:** TOKEN_SHAPES has 5 entries; /(?:gh[o rus]_[A-Za-z0-9]{20,})/ at :18; SENSITIVE_KEYWORD and assignment regex at :11/:38-46; test corpus redact-secrets.test.ts covers only 4 token scenarios; SPEC.md D15/D31 name ~200 gitleaks rules and the three-mirror codegen step.

## [MEDIUM] security — common/src/mcp/client.ts:207 — MCP origin registry blanket-mark upgrades unmarked untrusted configs that reach a trusted loader's record
- **Risk:** markAllMCPConfigOrigins stamps EVERY entry of a server map as 'user'/'project' unconditionally; the NEW-1 no-upgrade guard protects only configs already marked 'client'. An unmarked untrusted config object that reaches a record later blanket-marked by a trusted loader (e.g. agent assembly merging fileContext.agentTemplates entries into mcpServers) is silently upgraded to trusted and regains $VAR expansion from process.env. The soundness of the whole origin registry therefore rests on a caller discipline that nothing enforces; spread/structuredClone also drops marks (fail closed, safe direction), but the blanket-mark direction is fail-open.
- **Fix:** Make blanket marking provenance-checked: only stamp configs that the loader itself deserialized from the trusted file (carry a loading receipt), or replace the blanket call with markMCPConfigOrigin per loaded entry. Alternatively derive origin from a loader-supplied config bag that never contains foreign objects. Document the residual hole in the NEW-1 docblock so reviewers know the invariant is caller-enforced.
- **Evidence:** client.ts:207-217 markAllMCPConfigOrigins stamps Object.values(servers) with no provenance check (docblock admits 'unconditionally'); :186-194 markMCPConfigOrigin's guard fires only for configs already marked 'client'; :264-266 originOf is undefined for any fresh/spread object.

## [MEDIUM] security — common/src/mcp/client.ts:551 — Repo-supplied 'project' MCP configs get process-env $VAR expansion and unrestricted egress
- **Risk:** A 'project' config comes from the checked-out repo's mcp.json/openbuff.json, i.e. content an attacker controls in any cloned hostile repo. Yet project origin gets full $VAR expansion from process.env (substituteEnvInRecord at :557/:565-567) AND bypasses both the SSRF literal guard and the NEW-7 DNS pinning (both gated on origin === 'client' at :736/:753). A malicious project config can therefore send `Authorization: $OPENROUTER_API_KEY` to an attacker URL and read process-env secrets, with no pinning and no prompt. The trust boundary 'anything on disk is trusted' is weaker than the client-origin work implies.
- **Fix:** Treat 'project' as semi-trusted: restrict substitution to an allowlist of variable names the config declares, or gate first connection to a project-origin remote server behind the same permission prompt used for terminal commands; optionally route project-origin remote traffic through the same SSRF allowlist used for client origin. At minimum document that a cloned repo's mcp.json is env-substituted and unrestricted.
- **Evidence:** client.ts:141-165 origin docblock; :268-270 originAllowsEnvSubstitution returns true for 'project'; :547-572 resolveMCPConfigValues substitutes at 'project'; :727-801 SSRF guard and DNS pinning are applied only when origin === 'client'.

## [MEDIUM] correctness — agents/base2/base2.ts:11835 — Gate snapshot fingerprint format is ambiguous for paths containing tab/newline characters
- **Risk:** buildGateSnapshotDetails composes `files-v4\n` + `${file}\t${contentMarker}` lines joined by '\n'. File paths containing a tab or newline are legal on POSIX and attacker-controllable in an adversarial repo; such a path can inject a synthetic part line (e.g. `victim.ts\tsha256:<forged>` embedded inside a name) into the hashed string and into collectDeletedFilesFromSnapshotDetails' text parsing, so two different snapshots can produce identical details or mis-attribute deletion detection. Markers themselves are hex:len shaped, so the ambiguity is one-directional but real. Fingerprint v4 has no disambiguation between path and marker columns.
- **Fix:** Encode each part line unambiguously (JSON-encode the path, or length-prefix `len:path\tmarker`), bump the files-v5 prefix, and add a golden vector with an adversarial filename. Keep normalizationGateFileList as the single normalizer for both mint and supersede.
- **Evidence:** base2.ts:11835-11850 buildGateSnapshotDetails; :11987-12168 readGateFileContentMarkerUncached produces `sha256:<hex>:<len>` markers; supersedePlanTaskGateReceiptsForChangedFiles (:9515-9556) and collectDeletedFilesFromSnapshotDetails (:11861) consume the same details string.

## [LOW] correctness — common/src/tools/params/edit-blocks.ts:109 — EB-SEC-1 edit-blocks size gate compares UTF-16 length against a byte cap
- **Risk:** The EB-SEC-1 pre-gate rejects when `text.length > MAX_TRANSACTION_INPUT_BYTES`, but text.length counts UTF-16 code units while the constant is a byte bound used with Buffer.byteLength elsewhere (transactionEditInputBytes). A multibyte payload can pass the pre-gate while exceeding the byte cap, deferring rejection to the downstream schema bounds. Impact is bounded (still rejected, and the JSON pipeline stays authoritative), so this is a diagnostic-consistency gap, not a bypass.
- **Fix:** Use Buffer.byteLength(text) for the EB-SEC-1 gate (or document the char approximation) so the pre-gate and the schema bound measure the same quantity.
- **Evidence:** edit-blocks.ts:107-118 uses `text.length > MAX_TRANSACTION_INPUT_BYTES`; MAX_TRANSACTION_INPUT_BYTES is imported from common/src/actions (a byte-typed bound used with Buffer.byteLength at edit-transaction.ts:460-470).

## [MEDIUM] api-contract — agents/base2/gate-files.ts:8 — Gate file-classification helpers exist in four copies plus ~10 parity/freshness tests; D53 bundling is the correct fix
- **Risk:** The module header documents that base2.ts and editor.ts keep parallel inline copies of isFileChangingTool/hasEditArtifact/collectToolInputFiles/visitToolValue because handleSteps is serialized via toString() + new Function, plus a fourth copy in packages/agent-runtime tool-executor.ts; base2 also carries the ~1.5k-line generated gate-helper region and a parity/freshness test family (gate-files-parity, gate-paths-parity, gate-reviewer-parity, gate-repair-parity, gate-fingerprint-parity, pruner-budgets-freshness, gate-helpers-freshness, security-glob-parity, specialist-router-parity) existing solely to police drift. Verdict on question (A): the SPEC direction (D53 Bun.build bundles; trusted first-party agents as host modules with journal replay; QuickJS only for untrusted; agent.yaml P9-T1 for config-shaped definitions like create-specialist) is correct and this duplication is its strongest justification; the current TS-template mechanism is a transitional tax, not a destination.
- **Fix:** Proceed with D53 in the planned order: (1) Bun.build bundle per handleSteps, (2) trusted first-party agents as host modules with P2-T2 journal replay for resume, (3) QuickJS (existing @jitl/quickjs-wasmfile-release-sync) only for untrusted bundles with CPU interrupt + memory caps, (4) delete generate-gate-helpers, the inline copies, and the parity-test family. agent.yaml (P9-T1) stays JSON-Schema-first for config-shaped agents only; do not force programmatic gate logic into YAML.
- **Evidence:** gate-files.ts:1-27 (three-copies note + tool-executor fourth); base2.ts:11604-11696 inline copies; editor.ts:944-1099; parity test family in agents/__tests__/gate-files-parity.ts etc.; SPEC.md:254 D53.

## [MEDIUM] api-contract — agents/base2/spawn-contract.ts:186 — Spawn-contract family rosters and SpecialistReviewerAgent are two hand-synced lists over overlapping populations
- **Risk:** The spawn contract's 'architect/advisory' family clause hand-enumerates 14 agent ids (architect, product-reviewer, performance-specialist, reliability-reviewer, migration-reviewer, accessibility-reviewer, ux-visual-reviewer, compatibility-reviewer, dependency-reviewer, incident-coordinator, release-manager, docs-architect, evaluator, integration-agent), while common's SpecialistReviewerAgent union names a 9-id subset and the base2 inline router (selectSpecialistReviewersInline) parity-matches the common router. Two overlapping hand-synced rosters over the same population means adding a specialist agent requires edits in at least three places (definition, router union/parity, spawn-contract family clause); a miss yields a derived clause with different wording (byte-compat test catches it late) or a reviewer family the router never routes to.
- **Fix:** Derive both rosters from one descriptor (a roster table keyed by agent id with {family, isSpecialistReviewer} fields, or the agent.yaml v0 roster field). The spawn-contract family clauses then enumerate from the same source as the router union, and roster-coverage tests assert against the descriptor instead of two literals.
- **Evidence:** spawn-contract.ts:164-214 SPAWN_CONTRACT_CLAUSES; common/src/agents/specialist-risk-router.ts:1-9 union; base2.ts:862-986 selectSpecialistReviewersInline (parity-tested against common).

## [LOW] api-contract — agents/base2/base2.ts:7293 — Prompt-section budget enforcement is ad-hoc per-site bounding with no shared budget contract
- **Risk:** Prompt-section budgeting is enforced by independent per-site mechanisms: boundAdvisoryLines, boundWorkflowProgress, fitReceiptToStorageBound (receipt compaction slicing), boundCondonedEntries (200-entry cap), progressive GUIDE_POINTERS disclosure for the system prompt, and a byte-frozen qualitySection snapshot. There is no shared section-budget contract or token-measured clamp; each bound is a magic number in an inline helper that must keep its own invariant, and adding a new prompt section has no default budget behavior. The gate-state block emitter (formatGateStateBlock) relies on these scattered bounds rather than a single budgeted renderer.
- **Fix:** Centralize per-surface budget constants in one module (or in the D17 descriptor emission) so section budgets are data next to the section text, with a single boundAndEmit helper; keep the byte-frozen quality snapshot as the regression pin.
- **Evidence:** base2.ts:7293-7308, 7354-7381, 10297-10374, 7747-7749; base2.ts:64-202 GUIDE_POINTERS + discloseGuide; quality-prompt-section.ts byte-frozen note; no shared budget constant in common/src/constants/prompt-sections.

## [LOW] state-mutation — agents/base2/gate-state.ts:554 — planTaskGateReceipts presence-is-gate-active invariant and supersession normalization assumption are cross-site invariants
- **Risk:** planTaskGateReceipts' verification rests on two invariants enforced at a distance: (1) key PRESENCE (including an empty array) means gate-issued verification is active, and base2 must DELETE an inherited key on gate-disabled turns — any accidental key write on a gate-disabled path would brick plan-task completion; (2) supersedePlanTaskGateReceiptsForChangedFiles intersects normalized changed paths against receipt.files, which is sound only if the mint site stored paths through the same normalizeGateFileList; a differently-spelled stored path silently survives a superseding change. The prune/supersede bodies themselves correctly fail closed on structural garbage and non-attestable fingerprints (verified).
- **Fix:** Normalize receipt.files with normalizeGateFileList at the mint site (or assert it in the gate-lifecycle tests) so supersession cannot miss an intersection; keep the presence-key invariant as a named export/enforcer rather than a documented convention.
- **Evidence:** gate-state.ts:540-623 planTaskGateReceipts docblock; base2.ts:9477-9556 prune/supersede bodies (verified fail-closed on structure and attestability); mint-site normalization not read in this shard.

## [LOW] performance — agents/context-pruner.ts:13 — context-pruner.ts is a 3,347-line single definition with ~80 inline helpers, blocked from extraction by handleSteps serialization
- **Risk:** The pruner definition is a single 3,347-line `definition` const with ~80 inline helper functions (summarizeToolCall 284-532, collectFailureTexts 1036-1132, enforceKnowledgeMemoryBudgets 1591-1798, extractGoalFromMessages 1801-1935, sanitizeOperationalStateText 2352-2477) — forced inline by the same toString()/new Function serialization constraint as base2's gate helpers, and policed by its own freshness test (pruner-budgets-freshness). It cannot be unit-tested per helper or shared with the runtime without a copy.
- **Fix:** Sequence after the D53 bundling step: once handleSteps is a bundled host module, extract the pruner helpers into context-pruner/*.ts modules with direct unit tests, and delete any pruner-budget codegen in favor of a JSON budgets table.
- **Evidence:** context-pruner.ts:13-3347; same serialization constraint documented at gate-files.ts:8-11 and scripts/generate-gate-helpers.ts rationale; language-fit report line-count table (base2 ~72% orchestration).

## Coverage receipt

### Subsystems
- agents-base2
- agents-editor
- agents-context-pruner
- agents-specialists
- common-mcp
- common-tools-edit-transaction
- common-util
- common-agents-router
- common-templates

### Features
- base2-gate-fingerprint
- plan-task-gate-receipts
- reviewer-attestation-condone
- edit-blocks-parser
- edit-transaction-bounds
- mcp-origin-registry
- mcp-dns-rebinding-pinning
- secret-redaction-corpus
- base2-tool-tiers
- spawn-contract-derivation
- specialist-risk-router
- language-capability-manifest
- prompt-section-budget
- d53-handlesteps-bundling
- d15-d31-secret-rule-codegen
- p9-t1-agent-yaml
- p9-t4-quickjs-isolate
- p2-t6-gate-statechart

### Files
- agents/base2/base2.ts
- agents/base2/gate-state.ts
- agents/base2/gate-files.ts
- agents/base2/spawn-contract.ts
- agents/base2/tool-tiers.ts
- agents/base2/quality-prompt-section.ts
- agents/base2/specialist-risk-router.ts
- agents/context-pruner.ts
- agents/editor/editor.ts
- common/src/agents/specialist-risk-router.ts
- common/src/tools/params/tool/edit-transaction.ts
- common/src/tools/params/edit-blocks.ts
- common/src/mcp/client.ts
- common/src/mcp/dns-pinning.ts
- common/src/util/language-capability-manifest.ts
- common/src/util/redact-secrets.ts
- common/src/util/__tests__/redact-secrets.test.ts

### Domains
- security
- correctness
- state-mutation
- error-handling
- performance
- dependency-hygiene
- test-coverage
- api-contract
