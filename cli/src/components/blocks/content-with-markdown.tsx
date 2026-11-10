import { CodeRenderable } from '@opentui/core'
import { memo, useEffect, useRef, useState } from 'react'
import { useRenderer } from '@opentui/react'

import { logger } from '../../utils/logger'
import {
  hasMarkdown,
  type MarkdownPalette,
} from '../../utils/markdown-renderer'
import { createMarkdownSyntaxStyle } from '../../utils/opentui-syntax-style'
import { wrapTextPreservingNewlines } from '../../utils/text-layout'
import { getSharedTreeSitterClient } from '../../utils/tree-sitter-client'

import type { MarkdownRenderable, Renderable } from '@opentui/core'
import type { ReactNode, Ref } from 'react'

interface ContentWithMarkdownProps {
  content: string
  isStreaming: boolean
  /** Supply immediate prose on mount while still finalizing completed content. */
  eagerProse?: boolean
  codeBlockWidth: number
  palette: MarkdownPalette
}

/**
 * Renders chat content with OpenTUI's native <markdown> renderable
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
  owner: ReturnType<typeof useRenderer>['nativeScene'],
  ref: Ref<MarkdownRenderable>,
): ReactNode => {
  try {
    // Styles belong to this renderer's native scene. The shared factory caches
    // equivalent palettes within the owner, including streaming re-renders.
    const syntaxStyle = createMarkdownSyntaxStyle(palette, owner)
    const treeSitterClient = getSharedTreeSitterClient()
    // treeSitterClient is optional on MarkdownOptions, so a null client still
    // renders (code fences just lose tree-sitter highlighting). conceal=true
    // hides markdown markers while concealCode={false} keeps fenced code
    // visible, matching the removed legacy renderer's output style.
    return (
      <markdown
        ref={ref}
        width="100%"
        content={content}
        fg={palette?.codeTextFg}
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
    return (
      <text fg={palette?.codeTextFg} style={{ wrapMode: 'word' }}>
        {content}
      </text>
    )
  }
}

export const ContentWithMarkdown = memo(
  ({
    content,
    isStreaming,
    eagerProse = false,
    codeBlockWidth,
    palette,
  }: ContentWithMarkdownProps) => {
    const safeCodeBlockWidth = Math.max(10, codeBlockWidth)

    if (!hasMarkdown(content)) {
      return wrapTextPreservingNewlines(content, safeCodeBlockWidth)
    }

    // renderNativeMarkdown cannot return null: its catch degrades to a plain
    // <text> element, so the result is used directly.
    return (
      <NativeMarkdown
        content={content}
        isStreaming={isStreaming}
        eagerProse={eagerProse}
        palette={palette}
      />
    )
  },
)

/** Plain text can render without allocating or looking up native resources. */
function NativeMarkdown({
  content,
  isStreaming,
  eagerProse,
  palette,
}: Pick<
  ContentWithMarkdownProps,
  'content' | 'isStreaming' | 'eagerProse' | 'palette'
>) {
  const renderer = useRenderer()
  const markdown = useRef<MarkdownRenderable | null>(null)
  // Seed readable prose for the first paint, then finalize completed content
  // after native highlighting has retained that prose. Finalizing before the
  // first highlighting pass hides the preview until the worker responds.
  const [initialPreview, setInitialPreview] = useState(eagerProse ?? false)
  useEffect(() => {
    if (!initialPreview || isStreaming) return
    let cancelled = false
    let awaitingHighlight = false
    const afterPaint = () => {
      if (awaitingHighlight) return
      awaitingHighlight = true
      const highlights: Promise<void>[] = []
      const collect = (node: Renderable) => {
        if (node instanceof CodeRenderable)
          highlights.push(node.highlightingDone)
        for (const child of node.getChildren()) collect(child)
      }
      if (markdown.current) collect(markdown.current)
      void Promise.all(highlights).then(() => {
        renderer.removePostProcessFn(afterPaint)
        if (!cancelled) setInitialPreview(false)
      })
    }
    renderer.addPostProcessFn(afterPaint)
    return () => {
      cancelled = true
      renderer.removePostProcessFn(afterPaint)
    }
  }, [renderer, initialPreview, isStreaming, content])
  return renderNativeMarkdown(
    content,
    isStreaming || initialPreview,
    palette,
    renderer.nativeScene,
    markdown,
  )
}
