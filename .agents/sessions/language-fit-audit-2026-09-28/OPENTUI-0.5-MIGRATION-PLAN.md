# OpenTUI 0.2.2 → 0.5.x staged migration plan (2026-09-28)

Evidence: OpenTUI source verified via a shallow clone of anomalyco/opentui at HEAD 8742fa7 (librarian; clone retained at /tmp/librarian-opentui-1790720194956). Repo pins @opentui/core 0.2.2 (cli/package.json:37-38). SPEC D47 locks the decision.

## Verified 0.5.12 API (source-cited)

- **Markdown**: `MarkdownRenderable` (packages/core/src/renderables/Markdown.ts). Options: `content`, required `syntaxStyle`, `conceal/concealCode`, `treeSitterClient`, `streaming?: boolean`, `tableOptions?: MarkdownTableOptions` (style grid|columns, wrapMode, borders, selectable), `internalBlockMode: 'coalesced'|'top-level'`, `renderNode` + `createMarkdownCodeBlockRenderer()` for per-language fenced-code overrides. Parses with marked 17.0.1; incremental parsing exists (markdown-parser.ts). React element: `<markdown>`.
- **Code**: `CodeRenderable` (renderables/Code.ts). Options: `content`, `filetype`, `syntaxStyle` (required), `treeSitterClient` (defaults to the `getTreeSitterClient()` singleton), `conceal` (default true), `streaming?`, `onHighlight`, `onChunks`. React element: `<code>`.
- **TreeSitterClient** (lib/tree-sitter/client.ts): `new TreeSitterClient({ dataPath, workerPath?, initTimeout? })`, auto-starts its worker. `addDefaultParsers(parsers)` installs `FiletypeParserOptions` = `{ filetype, aliases?, queries: { highlights: string[] }, wasm: string }` where each entry is a URL or file path. Worker path precedence: option → `OTUI_TREE_SITTER_WORKER_PATH` env → compile-time global → `@opentui/core/parser.worker` package export. Default parsers ship for JS/TS/markdown(+injections)/zig.
- **Diff**: `DiffRenderable` (renderables/Diff.ts). Options: `diff?` (unified text, parsed with diff@9 parsePatch), `view: 'unified'|'split'`, `syncScroll`, line numbers, added/removed bg colors, code passthrough incl. `wrapMode`. React element: `<diff>` (React example packages/react/examples/diff.tsx).
- **TextTable**: `TextTableRenderable` — **core-only, NO React element** (docs: text-table.mdx "React Unavailable"); must be mounted via a custom renderable wrapper if used from React.
- **ScrollBox**: `stickyScroll`, `stickyStart`, `scrollX/Y`, `scrollAcceleration` (ScrollAcceleration interface; LinearScrollAccel default, MacOSScrollAccel provided), `viewportCulling` (default true), root/wrapper/viewport/content BoxOptions overrides. React element: `<scrollbox>`.
- **Width/graphemes**: `WidthMethod = 'wcwidth' | 'unicode' | 'unicode-wide'` on the renderer (`capabilities.unicode` or forced via `OPENTUI_FORCE_WCWIDTH`); native Zig grapheme pool with wide-cell continuation cells; `wrapMode: 'none'|'char'|'word'` on TextBuffer/Code/Diff/TextTable/Markdown tables. Caveat from docs: `cursorCharacterOffset` unreliable for wide text.
- **createCliRenderer**: `ScreenMode = 'alternate-screen'|'main-screen'|'split-footer'` (split-footer + `externalOutputMode: 'capture-stdout'|'passthrough'` + `footerHeight` are NEW in 0.5.x and directly relevant to our OSC passthrough needs). `kittyImageTransport: 'raw'|'zlib'|'file'`. Only documented rename: Solid `useKeyHandler` → `useKeyboard`.
- **Packaging**: native lib moved from single .so loading to eight optional platform packages `@opentui/core-<platform>-<arch>[-musl]` resolved at runtime. Bun `--compile` can embed the native lib, parser.worker.js, default grammars and tree-sitter.wasm directly (docs: reference/standalone-executables.mdx); Linux needs build-time `OPENTUI_LIBC`; install targets with `bun install --os="*" --cpu="*"`. Node SEA path also exists. End-to-end acceptance: packages/core/scripts/standalone-test.ts.
- **Peers**: `web-tree-sitter` 0.25.10 (exact), `react >=19.2.0`, bun >=1.3.0 (repo uses bun 1.4.1), node >=26.4.0. **No CHANGELOG and no migration guide exist** — the release-notes gap is real; migration must be driven by our own typecheck + tests.

## Impact on our code

Upgrading deletes ~1,500 hand-rolled lines (gap-cli-deep finding):
- cli/src/utils/syntax-highlighter.tsx (20-line stub) → `<code filetype>` / TreeSitterClient.
- cli/src/utils/markdown-renderer.tsx (~1,100 of 1,269 lines: remark pipeline, inline fallback formatting, per-char wrapping, code/table render) → `<markdown>` (+ `createMarkdownCodeBlockRenderer` for our diff fences).
- cli/src/components/tools/diff-viewer.tsx (~300 of 548 lines: parser + hunk layout) → `<diff>`; keep our caps/collapse wrapper around it.
- cli/src/utils/text-layout.ts wrapping paths (~110 lines) → native `wrapMode`; keep JS measurement only where row counts must be known up front (switch to Intl.Segmenter there).
- Dependencies we may drop: remark/unified/mdast chain, possibly string-width in the wrap path.

Risks confirmed by source: three pre-1.0 minor versions of React binding churn; per-platform native binaries added to release; direct ScrollBox API use; snapshot tests tied to hand-rolled output (markdown-renderer.test.tsx, diff-viewer.test.tsx); theme palette remap into `syntaxStyle` (0.5 requires an explicit SyntaxStyle everywhere).

## Staged plan

**Stage 0 — probe (0.5–1 day).** Add @opentui/core@0.5.12 + @opentui/react@0.5.12 alongside 0.2.2 (separate entrypoint `cli/src/index-05.tsx` or a branch). Verify: createCliRenderer boots under our Bun version, `<box>/<text>` render, --smoke-opentui equivalent passes, native package resolves on our 3 CI targets. No product code changes.

**Stage 1 — renderer + primitives (1–2 days).** Move index.tsx/app.tsx onto 0.5 APIs: createCliRenderer config (screenMode), useKeyboard/useRenderer/useTerminalDimensions, ScrollBox (adopt `stickyScroll` + `scrollAcceleration` to replace our use-scroll-management listeners — the effect-without-deps resubscribe bug dies here). Typecheck + component tests green.

**Stage 2 — markdown + code (2–3 days).** Replace content-with-markdown path with `<markdown streaming>`; wire TreeSitterClient with `addDefaultParsers` built from the grammar wasm + highlights.scm we already ship (build-binary.ts manifest; dataPath → our cache dir). Delete markdown-renderer internals + syntax-highlighter. Keep block memoization only for pre-render paths that still need text. Snapshot tests rewritten against marked output.

**Stage 3 — diff + tables (1–2 days).** Adopt `<diff>` in diff-viewer (keep collapse/caps wrapper; evaluate `view:'split'` for the side-by-side mode we hand-rolled). Tables: wrap TextTableRenderable via a custom React renderable (no JSX element exists).

**Stage 4 — text layout + images (1–2 days).** Drop JS pre-wrap where native wrapMode applies; keep Intl.Segmenter measurement for input height/tables. Terminal images: adopt renderer `kittyImageTransport` + postProcessFns hook for cell reservation (replaces raw escape emission; keep our protocol detection).

**Stage 5 — packaging + release (1–2 days).** build-binary.ts: pin 0.5.12, verify the sha256 manifest pattern covers the new platform optionalDependencies, set OPENTUI_LIBC per Linux target, add the standalone-test.ts pattern to our smoke. tmux visual smoke + rerender-perf integration test.

Total ≈ 7–10 engineer-days. Gate per stage: cli typecheck + affected bun test; final stage adds tmux-cli smoke and the rerender-perf regression test.

Open items to verify during Stage 0: exact prop parity of our TextAttributes/theme usage against 0.5 SyntaxStyle; whether `useTerminalDimensions` replaced our use-terminal-dimensions hook shape; marked-vs-remark output differences for our tables/checklists.
