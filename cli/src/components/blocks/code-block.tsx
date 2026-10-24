import { memo, type ReactNode } from 'react'

import { logger } from '../../utils/logger'
import { type MarkdownPalette } from '../../utils/markdown-renderer'
import { createCodeSyntaxStyle } from '../../utils/opentui-syntax-style'
import { getSharedTreeSitterClient } from '../../utils/tree-sitter-client'

interface CodeBlockProps {
  content: string
  /**
   * Code-fence language tag or file extension (e.g. "ts", "tsx", ".py").
   * Mapped through resolveCodeFiletype; unknown languages are omitted so the
   * native <code> renderable draws unhighlighted text instead of throwing.
   */
  filetype?: string
  palette: MarkdownPalette
  /**
   * Width available to the block. Forwarded as the renderable's layout width
   * so the native word-wrap has a bound (CodeOptions extends
   * RenderableOptions, whose `width` accepts a number; the same pattern is
   * used by DiffRenderable's internal code renderables).
   */
  availableWidth: number
}

/**
 * Maps a code-fence language tag or file extension onto a filetype string
 * registered by buildDefaultParsers in utils/tree-sitter-client.ts (the
 * filetypes whose grammar wasm + highlights query @opentui/core 0.5.12
 * actually ships). Aliases mirror the markdown injection infoStringMap in
 * tree-sitter-client.ts; anything unrecognized maps to undefined so the
 * native renderable renders unhighlighted rather than throwing.
 */
const FILETYPE_MAP: Record<string, string> = {
  js: 'javascript',
  javascript: 'javascript',
  jsx: 'javascriptreact',
  javascriptreact: 'javascriptreact',
  ts: 'typescript',
  typescript: 'typescript',
  tsx: 'typescriptreact',
  typescriptreact: 'typescriptreact',
  markdown: 'markdown',
  md: 'markdown',
}

export const resolveCodeFiletype = (
  language?: string,
): string | undefined => {
  if (!language) {
    return undefined
  }
  const normalized = language.trim().toLowerCase().replace(/^\./, '')
  return FILETYPE_MAP[normalized]
}

/**
 * Renders standalone code through OpenTUI 0.5's native <code> renderable
 * (jsx-namespace.d.ts declares `code: CodeProps`). A native setup failure
 * (syntax style construction or shared tree-sitter client creation throwing)
 * degrades to a bare <text> element with the raw content — the same
 * fail-closed contract as content-with-markdown.tsx. Wrapping is handled by
 * the element's native wrapMode; no JS pre-wrap (D47 Stage 4 decision).
 */
const renderNativeCode = (
  content: string,
  filetype: string | undefined,
  palette: MarkdownPalette,
  availableWidth: number,
): ReactNode => {
  try {
    const syntaxStyle = createCodeSyntaxStyle(palette)
    const treeSitterClient = getSharedTreeSitterClient()
    // treeSitterClient is optional on CodeOptions, so a null client still
    // renders (the code just loses tree-sitter highlighting). The base
    // codeTextFg/codeBackground look rides on TextBufferOptions fg/bg;
    // token colors come from the syntax style. width bounds the native
    // word-wrap layout (same option DiffRenderable passes its code
    // renderables).
    return (
      <code
        content={content}
        filetype={filetype}
        syntaxStyle={syntaxStyle}
        treeSitterClient={treeSitterClient ?? undefined}
        width={Math.max(10, availableWidth)}
        fg={palette.codeTextFg}
        bg={palette.codeMonochrome ? undefined : palette.codeBackground}
        style={{ wrapMode: 'word' }}
      />
    )
  } catch (error) {
    logger.error(
      error,
      'Native code rendering failed to set up; degrading to plain text',
    )
    return <text style={{ wrapMode: 'word' }}>{content}</text>
  }
}

export const CodeBlock = memo(
  ({ content, filetype, palette, availableWidth }: CodeBlockProps) =>
    renderNativeCode(
      content,
      resolveCodeFiletype(filetype),
      palette,
      availableWidth,
    ),
)
