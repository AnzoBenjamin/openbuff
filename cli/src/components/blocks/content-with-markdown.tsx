import { memo } from 'react'

import { logger } from '../../utils/logger'
import {
  hasMarkdown,
  type MarkdownPalette,
} from '../../utils/markdown-renderer'
import { createMarkdownSyntaxStyle } from '../../utils/opentui-syntax-style'
import { wrapTextPreservingNewlines } from '../../utils/text-layout'
import { getSharedTreeSitterClient } from '../../utils/tree-sitter-client'

import type { ReactNode } from 'react'

interface ContentWithMarkdownProps {
  content: string
  isStreaming: boolean
  codeBlockWidth: number
  palette: MarkdownPalette
}

/**
 * Renders chat content with OpenTUI 0.5's native <markdown> renderable
 * (jsx-namespace.d.ts declares `markdown: MarkdownProps`). The legacy
 * remark-based renderer was removed in D47 Stage 2, so a native setup
 * failure (syntax style construction, shared tree-sitter client creation, or
 * element setup throwing) degrades to plain text via
 * wrapTextPreservingNewlines instead of falling back to a legacy renderer.
 * Prop names verified against
 * node_modules/@opentui/react/src/types/components.d.ts
 * (MarkdownProps = ComponentProps<MarkdownOptions, MarkdownRenderable>).
 */
const renderNativeMarkdown = (
  content: string,
  isStreaming: boolean,
  palette: MarkdownPalette,
  safeCodeBlockWidth: number,
): ReactNode => {
  try {
    const syntaxStyle = createMarkdownSyntaxStyle(palette)
    const treeSitterClient = getSharedTreeSitterClient()
    // treeSitterClient is optional on MarkdownOptions, so a null client still
    // renders (code fences just lose tree-sitter highlighting). conceal=true
    // hides markdown markers while concealCode={false} keeps fenced code
    // visible, matching the removed legacy renderer's output style.
    return (
      <markdown
        content={content}
        syntaxStyle={syntaxStyle}
        treeSitterClient={treeSitterClient ?? undefined}
        streaming={isStreaming}
        conceal
        concealCode={false}
        internalBlockMode="top-level"
      />
    )
  } catch (error) {
    logger.error(
      error,
      'Native markdown rendering failed to set up; degrading to plain text',
    )
    return wrapTextPreservingNewlines(content, safeCodeBlockWidth)
  }
}

export const ContentWithMarkdown = memo(
  ({
    content,
    isStreaming,
    codeBlockWidth,
    palette,
  }: ContentWithMarkdownProps) => {
    const safeCodeBlockWidth = Math.max(10, codeBlockWidth)

    if (!hasMarkdown(content)) {
      return wrapTextPreservingNewlines(content, safeCodeBlockWidth)
    }

    // renderNativeMarkdown cannot return null: its catch degrades to wrapped
    // plain text, so the result is used directly.
    return renderNativeMarkdown(
      content,
      isStreaming,
      palette,
      safeCodeBlockWidth,
    )
  },
)
