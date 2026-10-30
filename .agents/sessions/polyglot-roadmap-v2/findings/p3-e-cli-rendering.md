# Audit findings: p3-e-cli-rendering

- Subsystems: cli-tool-renderers, cli-tool-registry, cli-renderer-tests, opentui-text-constraints
- Features: p3-t2-cli-language-intelligence-renderers, discovery-results-shared-renderer, tool-renderer-registry
- Files covered: 9
- Snapshot: f6f2d4aa162b3cc09c6d64e96f8e03bb4b430c5444981de1b88a548d1690980a

## [HIGH] test-coverage — cli/src/components/tools/__tests__/discovery-tools.test.tsx:1 — Four language-intelligence renderers have zero dedicated test coverage
- **Risk:** A render regression in the new renderer (bad nesting, thrown parse error, wrong glyph) ships silently; the generic fallback renderer would render these tool results with no signal, and registry-metadata.test.ts [DEP-M02] cannot catch it because the four tools are metadata-'fallback' (common/src/tools/metadata.ts:90-101 does not list them), so deleting all four registry entries (registry.ts:89-92) would keep the suite green.
- **Fix:** Add a language-intelligence render suite in cli/src/components/tools/__tests__ following the discovery-tools.test.tsx pattern (renderToStaticMarkup over GoToDefinition/FindReferences/HoverType/WorkspaceSymbolComponent.render) covering ready/error/unavailable/empty states, and either add the four names to CUSTOM_RENDERERS or assert them in getRegisteredToolNames() in registry-metadata.test.ts.
- **Evidence:** Read of cli/src/components/tools/__tests__/discovery-tools.test.tsx shows describes only 'glob' and 'list_directory' cases; repo-wide search for 'language-intelligence|GoToDefinitionComponent|HoverTypeComponent' matched only registry.ts and language-intelligence.tsx itself, no test file. registry-metadata.test.ts:12-14 only requires registration for tools whose metadata is 'custom', and common/src/tools/metadata.ts:90-101 CUSTOM_RENDERERS does not list the four new tools, so their registrations are unpinned.

## [MEDIUM] correctness — cli/src/components/tools/language-intelligence.tsx:150 — 'unavailable' status falls through statusGlyph to the ⟳ spinner glyph
- **Risk:** A settled 'no language server' result is terminal, yet the glanceable status glyph is the indistinguishable-from-in-progress ⟳ in theme.primary, so users read a finished unavailable result as still running.
- **Fix:** Either map 'unavailable' in statusGlyph (e.g. a '–'/muted glyph), or pass a distinct status string that resolves to a settled glyph; add a test asserting a settled unavailable block does not render ⟳.
- **Evidence:** language-intelligence.tsx:146-152 sets status='unavailable' when unavailableReason is set and the block is settled; discovery-results.tsx:27-36 statusGlyph only special-cases 'failed' and status.startsWith('complete')/'ready', everything else (queued, running, unavailable) maps to {glyph:'⟳', color:theme.primary}.

## [HIGH] correctness — cli/src/components/tools/language-intelligence.tsx:177 — description fragment uses the documented-forbidden {' '} JSX whitespace expression inside a <text> subtree
- **Risk:** Per cli/knowledge.md 'OpenTUI Text Rendering Constraints / JSX Content Rules' (knowledge.md:298-312), a standalone JSX whitespace expression inside a <text> tree can blank the entire app; this description is embedded by SimpleToolCallItem (tool-call-item.tsx:107-125) inside a <text>, and since tool blocks persist to chat-messages.json and replay on reload, one bad block would blank that session permanently.
- **Fix:** Move the space into the preceding string (wrapTextPreservingNewlines(summary, colWidth) + ' ') or into the span content (` {glyph}` template literal), removing the standalone {' '} expression, then add a reconciler-backed render case for a ready block.
- **Evidence:** language-intelligence.tsx:174-180 description={<>{wrapTextPreservingNewlines(summary, colWidth)}{' '}<span fg={color}>{glyph}</span></>}; cli/knowledge.md:298-310 marks {' '} as the documented blank-app pattern; tool-call-item.tsx:107-135 embeds the description fragment directly inside <text> with the bullet/name spans. renderToStaticMarkup accepts this silently (knowledge.md:336), so only text-nesting.test.tsx-style guards or the real reconciler would catch it.

## [MEDIUM] api-contract — cli/src/components/tools/language-intelligence.tsx:209 — Renderer is not 'grouped discovery output': CollapsibleGroup/shortenPath/HighlightedContent unused despite STATUS.md/knowledge.md claim
- **Risk:** The documented repo claim is not implemented: results render as a flat list silently truncated at 30 entries with no expansion affordance (CollapsibleGroup's '… N more' pattern, discovery-results.tsx:216-225, is not used), paths are not shortened relative to any cwd, and hover/query matches get no HighlightedContent emphasis — inconsistent with the sibling discovery renderers the commit claims to follow.
- **Fix:** Either adopt CollapsibleGroup with a count badge and '… N more' affordance (plus shortenPath for location rows) to match the claimed convention, or correct the STATUS.md/knowledge.md wording to 'flat capped discovery list reusing statusGlyph'.
- **Evidence:** language-intelligence.tsx:11 imports only statusGlyph from './discovery-results'; the content tree (lines 168-244) renders flat <text> rows from locations.slice(0, 30) / symbols.slice(0, 30) with no Button/toggle and no '… N more' line; formatLocation (line 61-72) uses location.path verbatim with no shortenPath-style cwd relativization; knowledge.md 2026-10-03 entry claims the component 'renders the four language-intelligence tool results ... as grouped discovery output'.

## [LOW] error-handling — cli/src/components/tools/language-intelligence.tsx:166 — Empty location/symbol result sets have no distinct empty-state message
- **Risk:** Minor UX coherence gap with the sibling discovery renderers, which distinguish empty states; a definition/reference query that legitimately found nothing looks identical to one that returned results (only the count text differs).
- **Fix:** Add an explicit empty branch ('no results' muted summary and/or a muted glyph) mirroring the hover 'no type info' handling.
- **Evidence:** language-intelligence.tsx:157-166 summary ternary: unavailable→'no language server (...)', error→'error', hover-empty→'no type info', otherwise `${target} — ${resultCount} location(s)` — so resultCount 0 renders '0 locations' with the same ✓ ready glyph as a successful non-empty result.

## Coverage receipt

### Subsystems
- cli-tool-renderers
- cli-tool-registry
- cli-renderer-tests
- opentui-text-constraints

### Features
- p3-t2-cli-language-intelligence-renderers
- discovery-results-shared-renderer
- tool-renderer-registry

### Files
- cli/src/components/tools/language-intelligence.tsx
- cli/src/components/tools/registry.ts
- cli/src/components/tools/discovery-results.tsx
- cli/src/components/tools/types.ts
- cli/src/components/tools/__tests__/discovery-tools.test.tsx
- cli/src/components/tools/__tests__/registry-metadata.test.ts
- cli/src/components/tools/tool-call-item.tsx
- common/src/tools/metadata.ts
- cli/knowledge.md

### Domains
- correctness
- api-contract
- error-handling
- test-coverage
