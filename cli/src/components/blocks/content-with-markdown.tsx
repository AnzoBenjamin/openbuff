import { memo } from 'react'

import { logger } from '../../utils/logger'
import {
  renderMarkdown,
  renderStreamingMarkdown,
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
 * remark-based renderer stays as the fallback for any native setup failure:
 * syntax style construction, shared tree-sitter client creation, or element
 * setup throwing. Prop names verified against
 * node_modules/@opentui/react/src/types/components.d.ts
 * (MarkdownProps = ComponentProps<MarkdownOptions, MarkdownRenderable>).
 */
const renderNativeMarkdown = (
  content: string,
  isStreaming: boolean,
  palette: MarkdownPalette,
): ReactNode | null => {
  try {
    const syntaxStyle = createMarkdownSyntaxStyle(palette)
    const treeSitterClient = getSharedTreeSitterClient()
    // treeSitterClient is optional on MarkdownOptions, so a null client still
    // renders (code fences just lose tree-sitter highlighting). conceal=true
    // hides markdown markers while concealCode={false} keeps fenced code
    // visible, matching the legacy renderer's output style.
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
      'Native markdown rendering failed to set up; using legacy renderer',
    )
    return null
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

    const native = renderNativeMarkdown(content, isStreaming, palette)
    if (native !== null) {
      return native
    }

    const options = { codeBlockWidth: safeCodeBlockWidth, palette }
    if (isStreaming) {
      return renderStreamingMarkdown(content, options)
    }
    return renderMarkdown(content, options)
  },
)
