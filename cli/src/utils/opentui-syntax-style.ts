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
 */
export function createMarkdownSyntaxStyle(
  palette: MarkdownPalette,
): SyntaxStyle {
  const codeBackground = palette.codeMonochrome
    ? undefined
    : palette.codeBackground

  return SyntaxStyle.fromStyles({
    // Fallback for unstyled markdown text: leave terminal defaults intact.
    default: {},
    // Markdown.ts renders inline codespans with the "markup.raw" group; our
    // legacy renderer draws them bold on the code background.
    'markup.raw': {
      fg: palette.inlineCodeFg,
      bg: codeBackground,
      bold: true,
    },
    'markup.strong': { bold: true },
    'markup.italic': { italic: true },
    // Legacy strikethrough (mdast "delete") renders with TextAttributes.DIM.
    'markup.strikethrough': { dim: true },
    'markup.link': { fg: palette.linkFg },
    'markup.link.url': { fg: palette.linkFg },
    'markup.link.label': { fg: palette.linkFg },
    'markup.list': { fg: palette.listBulletFg },
    'markup.quote': { fg: palette.blockquoteTextFg },
    // Drives blockquote border color (and hr/divider color) in Markdown.ts.
    conceal: { fg: palette.blockquoteBorderFg },
    // Base heading style; Markdown.ts table header cells use "markup.heading"
    // with our headingFg[3] color, falling back to the deepest configured one.
    'markup.heading': {
      bold: true,
      fg: palette.headingFg[3] ?? palette.headingFg[6],
    },
    'markup.heading.1': {
      bold: true,
      fg: palette.headingFg[1] ?? palette.headingFg[6],
    },
    'markup.heading.2': {
      bold: true,
      fg: palette.headingFg[2] ?? palette.headingFg[6],
    },
    'markup.heading.3': {
      bold: true,
      fg: palette.headingFg[3] ?? palette.headingFg[6],
    },
    'markup.heading.4': {
      bold: true,
      fg: palette.headingFg[4] ?? palette.headingFg[6],
    },
    'markup.heading.5': {
      bold: true,
      fg: palette.headingFg[5] ?? palette.headingFg[6],
    },
    'markup.heading.6': {
      bold: true,
      fg: palette.headingFg[6],
    },
  } satisfies Record<string, StyleDefinitionInput>)
}
