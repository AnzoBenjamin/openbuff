import { SyntaxStyle, type StyleDefinitionInput } from '@opentui/core'

import type { MarkdownPalette } from './markdown-renderer'

/**
 * Maps our MarkdownPalette onto an OpenTUI 0.5 SyntaxStyle for the native
 * <markdown> renderable (Stage 2 of the OpenTUI 0.5 migration).
 *
 * Every style-entry shape and style NAME below was located in the installed
 * @opentui/core 0.5.12 source, not invented:
 *
 * - Entry shape (fg/bg ColorInput + bold/italic/underline/dim attributes)
 *   comes from node_modules/@opentui/core/syntax-style.d.ts
 *   (StyleDefinitionInput) and is applied via SyntaxStyle.fromStyles().
 * - Style names come from node_modules/@opentui/core/index.bun.js (bundled
 *   src/renderables/Markdown.ts), whose getStyle() consumers use exactly
 *   these groups: "default" (plain text fallback), "markup.raw" (inline
 *   codespans), "markup.strong", "markup.italic", "markup.strikethrough",
 *   "markup.link" / "markup.link.url" / "markup.link.label",
 *   "markup.list" (list bullet markers), "markup.quote" (blockquote content
 *   base highlight), "markup.heading" (table header cells), and "conceal"
 *   (blockquote border color AND thematic-break/hr border color via
 *   getStyle('conceal').fg).
 * - Per-depth headings: getStyle() falls back from "markup.heading.N" to the
 *   "markup.heading" base name, and the tree-sitter markdown highlights
 *   query shipped at node_modules/@opentui/core/assets/markdown/highlights.scm
 *   emits @markup.heading.1 .. @markup.heading.6, so the dotted names are
 *   registered individually.
 *
 * Palette fields with no unambiguous key in the installed source are
 * intentionally NOT mapped (rather than guessed):
 * - codeTextFg: fenced code blocks are rendered by CodeRenderable using
 *   tree-sitter token groups (string/keyword/comment/...), not a single
 *   markdown style key; there is no key for plain code text.
 * - dividerFg: thematic breaks reuse the "conceal" group (see above), which
 *   carries blockquoteBorderFg here; no separate divider key exists.
 *
 * D47 Stage 2: with the legacy renderer removed, the palette argument is
 * optional and accepts a Partial<MarkdownPalette>; every missing field falls
 * back to the former legacy defaults, so both
 * createMarkdownSyntaxStyle(agentPalette ?? {}) and an undefined palette work
 * without throwing.
 */
// Former legacy-renderer defaults (markdown-renderer.tsx before D47 Stage 2).
const DEFAULT_HEADING_FG: Record<number, string> = {
  1: 'magenta',
  2: 'green',
  3: 'green',
  4: 'green',
  5: 'green',
  6: 'green',
}

export function createMarkdownSyntaxStyle(
  palette?: Partial<MarkdownPalette>,
): SyntaxStyle {
  const headingFg = { ...DEFAULT_HEADING_FG, ...palette?.headingFg }
  const codeBackground = palette?.codeMonochrome
    ? undefined
    : palette?.codeBackground ?? '#0d1117'

  return SyntaxStyle.fromStyles({
    // Fallback for unstyled markdown text: leave terminal defaults intact.
    default: {},
    // Markdown.ts renders inline codespans with the "markup.raw" group; our
    // legacy renderer drew them bold on the code background.
    'markup.raw': {
      fg: palette?.inlineCodeFg ?? '#86efac',
      bg: codeBackground,
      bold: true,
    },
    'markup.strong': { bold: true },
    'markup.italic': { italic: true },
    // Legacy strikethrough (mdast "delete") renders with TextAttributes.DIM.
    'markup.strikethrough': { dim: true },
    'markup.link': { fg: palette?.linkFg ?? '#3B82F6' },
    'markup.link.url': { fg: palette?.linkFg ?? '#3B82F6' },
    'markup.link.label': { fg: palette?.linkFg ?? '#3B82F6' },
    'markup.list': { fg: palette?.listBulletFg ?? 'white' },
    'markup.quote': { fg: palette?.blockquoteTextFg ?? 'gray' },
    // Drives blockquote border color (and hr/divider color) in Markdown.ts.
    conceal: { fg: palette?.blockquoteBorderFg ?? 'gray' },
    // Base heading style; Markdown.ts table header cells use "markup.heading"
    // with our headingFg[3] color, falling back to the deepest configured one.
    'markup.heading': {
      bold: true,
      fg: headingFg[3] ?? headingFg[6],
    },
    'markup.heading.1': {
      bold: true,
      fg: headingFg[1] ?? headingFg[6],
    },
    'markup.heading.2': {
      bold: true,
      fg: headingFg[2] ?? headingFg[6],
    },
    'markup.heading.3': {
      bold: true,
      fg: headingFg[3] ?? headingFg[6],
    },
    'markup.heading.4': {
      bold: true,
      fg: headingFg[4] ?? headingFg[6],
    },
    'markup.heading.5': {
      bold: true,
      fg: headingFg[5] ?? headingFg[6],
    },
    'markup.heading.6': {
      bold: true,
      fg: headingFg[6],
    },
  } satisfies Record<string, StyleDefinitionInput>)
}

/**
 * Maps our MarkdownPalette onto an OpenTUI 0.5 SyntaxStyle for the native
 * <code> renderable (CodeRenderable), used when standalone code text is
 * rendered outside markdown (PLAN.md P1-T6).
 *
 * Verified against the installed @opentui/core 0.5.12, not invented:
 * - CodeOptions (node_modules/@opentui/core/renderables/Code.d.ts) takes the
 *   SyntaxStyle via the required `syntaxStyle` option; unstyled spans are
 *   drawn with the renderable's own fg/bg (TextBufferOptions), so the base
 *   codeTextFg/codeBackground look is applied by the <code> element itself
 *   (see components/blocks/code-block.tsx), NOT by a style entry.
 * - Style names below are tree-sitter capture groups emitted by the shipped
 *   highlights queries (node_modules/@opentui/core/assets/typescript/
 *   highlights.scm and the shared ecma query it embeds): comment, string,
 *   number, boolean, constant, keyword, function, type, module, attribute,
 *   label, string.escape. CodeRenderable resolves each highlight's group
 *   name against these registered names.
 *
 * Palette mapping (attribute-only where no palette field is unambiguous,
 * matching createMarkdownSyntaxStyle's don't-guess-colors philosophy):
 * - strings/numbers reuse inlineCodeFg (legacy code-token accent color).
 * - functions/types reuse codeHeaderFg (legacy code header color).
 * - modules/attributes reuse linkFg.
 * - comments/keywords/booleans/constants get attribute-only styling.
 */
export function createCodeSyntaxStyle(palette: MarkdownPalette): SyntaxStyle {
  return SyntaxStyle.fromStyles({
    comment: { dim: true },
    string: { fg: palette.inlineCodeFg },
    'string.escape': { bold: true },
    number: { fg: palette.inlineCodeFg },
    boolean: { bold: true },
    constant: { bold: true },
    keyword: { bold: true },
    function: { fg: palette.codeHeaderFg },
    type: { fg: palette.codeHeaderFg },
    module: { fg: palette.linkFg },
    attribute: { fg: palette.linkFg },
    label: { italic: true },
  } satisfies Record<string, StyleDefinitionInput>)
}
