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
 * element setup throwing) degrades to a bare <text> element (native
 * wrapMode handles wrapping) instead of falling back to a legacy renderer.
 * Prop names verified against
 * node_modules/@opentui/react/src/types/components.d.ts
 * (MarkdownProps = ComponentProps<MarkdownOptions, MarkdownRenderable>).
 */
const renderNativeMarkdown = (
  content: string,
  isStreaming: boolean,
  palette: MarkdownPalette,
): ReactNode => {
  try {
    // createMarkdownSyntaxStyle memoizes one native SyntaxStyle handle per
    // palette object (WeakMap inside opentui-syntax-style.ts), so this
    // per-render call hits the cache during streaming re-renders instead of
    // allocating a native handle per chunk. No useMemo is needed here: the
    // factory is the single choke point covering every call site (this
    // component and message-with-agents.tsx).
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
    // D47 Stage 4: degrade contract kept — no <markdown> element and the raw
    // content stays visible — but the <text> element's native wrapMode:
    // 'word' handles wrapping instead of JS pre-wrap.
    return <text style={{ wrapMode: 'word' }}>{content}</text>
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

    // renderNativeMarkdown cannot return null: its catch degrades to a plain
    // <text> element, so the result is used directly.
    return renderNativeMarkdown(content, isStreaming, palette)
  },
)
