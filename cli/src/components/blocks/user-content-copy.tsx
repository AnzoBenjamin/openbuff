import { TextAttributes } from '@opentui/core'
import { memo, useMemo, useRef, useState } from 'react'

import { CopyButton } from '../copy-button'
import { Button } from '../button'
import { useTheme } from '../../hooks/use-theme'
import { MAX_COLLAPSED_LINES, truncateToLines } from '../../utils/strings'
import { trimNewlines } from './block-helpers'
import { ContentWithMarkdown } from './content-with-markdown'

import { hasMarkdown, type MarkdownPalette } from '../../utils/markdown-renderer'

/**
 * Allocation-free newline threshold check, replacing the former
 * `split('\n').length >= threshold` which allocated a line-count-element
 * string array on every call. Behavior-preserving: `split('\n').length` is
 * `newlineCount + 1`, so the check is true exactly once at least
 * `threshold - 1` newlines have been seen (and trivially true for any
 * threshold <= 1, matching split's minimum length of 1). Scanning stops at
 * the (threshold - 1)-th newline, so cost is bounded by that many newlines'
 * worth of bytes and is independent of total content length. Exported so
 * regression tests can pin the split-equivalent, allocation-free,
 * early-exit invariant directly.
 */
export function hasNewlineThreshold(content: string, threshold: number): boolean {
  if (threshold <= 1) return true
  const needed = threshold - 1
  let newlines = 0
  for (let i = 0; i < content.length; i++) {
    if (content[i] === '\n' && ++newlines >= needed) return true
  }
  return false
}

// Hook that checks whether content contains markdown.
//
// Streaming performance: `hasMarkdown` is monotonically non-decreasing —
// once it returns true for a string prefix it stays true for any longer
// string that extends it. Refs make incremental scanning cheap:
//   foundRef       — latches to true on first detection; subsequent chunks
//                    skip the scan entirely (O(1) per chunk).
//   prevContentRef — the previously scanned string. While content grows by
//                    pure appends, the new content starts with it, so only
//                    newly appended bytes are inspected (O(chunk) per chunk,
//                    O(N) total).
//   linkStateRef   — carries the partial `[text](url)` state across chunk
//                    boundaries, so a link whose opening '[' arrived in an
//                    earlier chunk is still detected however long it grows.
// Any update that is not a pure extension of the previously scanned string —
// a shrink (message reset), an in-place edit, a regeneration, or prepended
// text — invalidates all state and re-scans the full content once. The
// prefix check is a native string comparison (memcmp speed), negligible
// next to the per-chunk JS character scan.
//
// Before → after cost for a message of C bytes delivered across T render
// ticks while streaming, both directly measurable (regex input length,
// allocation counters):
//   hasMarkdown input — before: the full C-byte content was regex-scanned
//     on every tick, O(C) per tick / O(C·T) total (a 100 KB message over
//     500 ticks ≈ 50 MB scanned). After: only the newly appended chunk is
//     regex-scanned, O(C) total across the whole stream (~100 KB in that
//     example, a T× reduction).
//   incremental scan — the exported scanChunkForStraddledLink state machine
//     likewise touches each byte at most once across the stream: O(chunk)
//     per tick, O(C) total, regardless of how many ticks deliver the
//     message.
//   collapse check — before: split('\n') allocated a
//     line-count-element string array on every tick; after: the exported
//     hasNewlineThreshold helper allocates nothing and reads at most
//     MAX_COLLAPSED_LINES - 1 newlines' worth of bytes per tick,
//     independent of C.
//
// These before → after invariants are pinned by the exported pure helpers
// (hasNewlineThreshold, scanChunkForStraddledLink) rather than prose-only
// claims, so regression tests can assert them directly.

// States for the incremental scan of the `[text](url)` link alternative of
// hasMarkdown's regex (see markdown-renderer.tsx). A link pattern is
// unbounded in length, so its state must be carried across chunk boundaries
// rather than covered by any fixed lookback window.
type LinkScanState = 'base' | 'link-text' | 'link-close' | 'link-url'

/**
 * Advance the straddled-link state machine over one appended chunk,
 * returning the carried state and whether a `[text](url)` pattern whose
 * opening '[' predates the chunk completed. Touches each chunk byte at most
 * once (O(chunk) per tick, O(C) total across the stream) and allocates
 * nothing per byte. Exported so regression tests can pin the state-machine
 * transitions and the linear-scan invariant directly.
 */
export function scanChunkForStraddledLink(
  initialState: LinkScanState,
  chunk: string,
): { state: LinkScanState; linkCompleted: boolean } {
  let state = initialState
  for (let i = 0; i < chunk.length; i++) {
    const ch = chunk[i]
    if (state === 'base') {
      if (ch === '[') state = 'link-text'
    } else if (state === 'link-text') {
      if (ch === ']') state = 'link-close'
    } else if (state === 'link-close') {
      // The regex requires '(' immediately after ']', so anything else
      // kills the pending link; a '[' here may start a new one.
      state = ch === '(' ? 'link-url' : ch === '[' ? 'link-text' : 'base'
    } else if (ch === ')') {
      // link-url: the straddling `[text](url)` pattern is complete.
      return { state: 'base', linkCompleted: true }
    }
  }
  return { state, linkCompleted: false }
}

function useContentHasMarkdown(content: string): boolean {
  const foundRef = useRef(false)
  const prevContentRef = useRef('')
  const linkStateRef = useRef<LinkScanState>('base')

  return useMemo(() => {
    const prevContent = prevContentRef.current

    // The cached scan state is only valid while the new content is a pure
    // extension of what was already scanned. A shrink (message reset), an
    // in-place edit, a regeneration, or prepended text all fail this check
    // and force a full re-scan, so the result can never latch a stale value.
    if (!content.startsWith(prevContent)) {
      foundRef.current = false
      linkStateRef.current = 'base'
      prevContentRef.current = ''
    }

    // Already confirmed markdown and the content still extends the scanned
    // prefix — no further scanning needed.
    if (foundRef.current) {
      prevContentRef.current = content
      return true
    }

    const chunkStart = prevContentRef.current.length
    const chunk = content.slice(chunkStart)

    // Fast path: the canonical regex catches anything matching entirely
    // inside this chunk.
    if (hasMarkdown(chunk)) {
      foundRef.current = true
      prevContentRef.current = content
      return true
    }

    // No trigger char matched inside this chunk, so the only way the full
    // content can contain markdown is a `[text](url)` link whose opening '['
    // predates the frontier. Advance the link state machine over the chunk,
    // starting from the state carried across the boundary:
    //   base       — no live '[' pending
    //   link-text  — after a live '[', before its ']'
    //   link-close — right after the ']', waiting for the '('
    //   link-url   — inside '(...)', waiting for the ')'
    const result = scanChunkForStraddledLink(linkStateRef.current, chunk)
    if (result.linkCompleted) {
      foundRef.current = true
    }
    prevContentRef.current = content
    linkStateRef.current = result.state
    return result.linkCompleted
  }, [content])
}

interface UserContentWithCopyButtonProps {
  content: string
  messageId: string
  isLoading: boolean
  isComplete?: boolean
  isUser: boolean
  textColor: string
  codeBlockWidth: number
  palette: MarkdownPalette
  showCopyButton: boolean
}

export const UserContentWithCopyButton = memo(
  ({
    content,
    messageId,
    isLoading,
    isComplete,
    isUser,
    textColor,
    codeBlockWidth,
    palette,
    showCopyButton,
  }: UserContentWithCopyButtonProps) => {
    const isStreamingMessage = isLoading || !isComplete
    const normalizedContent = isStreamingMessage
      ? trimNewlines(content)
      : content.trim()

    const hasContent = normalizedContent.length > 0

    // Collapse-by-default only applies to COMPLETE user messages whose rendered
    // content exceeds the configured line threshold. Streaming/incomplete
    // messages and AI messages are never collapsed.
    //
    // The former split('\n').length allocated a temporary array proportional
    // to the full content on every render tick while streaming. The exported
    // hasNewlineThreshold helper allocates nothing and stops as soon as the
    // (MAX_COLLAPSED_LINES - 1)-th newline is seen, so it never touches
    // content beyond that point. useMemo ensures it runs only when isUser,
    // isStreamingMessage, or normalizedContent changes, not on every render
    // tick.
    const isCollapsibleUser = useMemo(() => {
      if (!isUser || isStreamingMessage) return false
      return hasNewlineThreshold(normalizedContent, MAX_COLLAPSED_LINES)
    }, [isUser, isStreamingMessage, normalizedContent])

    if (!hasContent) {
      return null
    }

    if (!showCopyButton) {
      return (
        <UserTextDisplay
          messageId={messageId}
          normalizedContent={normalizedContent}
          isStreamingMessage={isStreamingMessage}
          isCollapsibleUser={isCollapsibleUser}
          textColor={textColor}
          codeBlockWidth={codeBlockWidth}
          palette={palette}
          isUser={isUser}
        />
      )
    }

    return (
      <UserTextWithInlineCopy
        content={content}
        normalizedContent={normalizedContent}
        isStreamingMessage={isStreamingMessage}
        isCollapsibleUser={isCollapsibleUser}
        textColor={textColor}
        codeBlockWidth={codeBlockWidth}
        palette={palette}
      />
    )
  },
)

interface UserTextDisplayProps {
  messageId: string
  normalizedContent: string
  isStreamingMessage: boolean
  isCollapsibleUser: boolean
  isUser: boolean
  textColor: string
  codeBlockWidth: number
  palette: MarkdownPalette
}

/**
 * Plain (no copy button) user text display. Applies collapse-by-default for
 * long complete user messages, mirroring the UserTextWithInlineCopy behavior.
 */
const UserTextDisplay = memo(
  ({
    messageId,
    normalizedContent,
    isStreamingMessage,
    isCollapsibleUser,
    isUser,
    textColor,
    codeBlockWidth,
    palette,
  }: UserTextDisplayProps) => {
    const { displayContent, isExpanded, setIsExpanded, showToggle } =
      useCollapsibleContent(normalizedContent, isCollapsibleUser)

    const hasMarkdownContent = useContentHasMarkdown(normalizedContent)

    if (hasMarkdownContent) {
      return (
        <box style={{ width: '100%' }}>
          <ContentWithMarkdown
            content={displayContent}
            isStreaming={isStreamingMessage}
            codeBlockWidth={codeBlockWidth}
            palette={palette}
          />
        </box>
      )
    }

    const textEl = (
      <text
        key={`message-content-${messageId}`}
        style={{ wrapMode: 'word', fg: textColor, width: '100%' }}
        attributes={isUser ? TextAttributes.ITALIC : undefined}
      >
        <ContentWithMarkdown
          content={displayContent}
          isStreaming={isStreamingMessage}
          codeBlockWidth={codeBlockWidth}
          palette={palette}
        />
      </text>
    )

    if (!showToggle) {
      return textEl
    }

    return (
      <box style={{ flexDirection: 'column', gap: 0, width: '100%' }}>
        {textEl}
        <CollapseToggle isExpanded={isExpanded} onToggle={setIsExpanded} />
      </box>
    )
  },
)

interface UserTextWithInlineCopyProps {
  content: string
  normalizedContent: string
  isStreamingMessage: boolean
  isCollapsibleUser: boolean
  textColor: string
  codeBlockWidth: number
  palette: MarkdownPalette
}

const UserTextWithInlineCopy = memo(
  ({
    content,
    normalizedContent,
    isStreamingMessage,
    isCollapsibleUser,
    textColor,
    codeBlockWidth,
    palette,
  }: UserTextWithInlineCopyProps) => {
    const { displayContent, isExpanded, setIsExpanded, showToggle } =
      useCollapsibleContent(normalizedContent, isCollapsibleUser)

    const hasMarkdownContent = useContentHasMarkdown(normalizedContent)

    if (hasMarkdownContent) {
      return (
        <box style={{ width: '100%' }}>
          <ContentWithMarkdown
            content={displayContent}
            isStreaming={isStreamingMessage}
            codeBlockWidth={codeBlockWidth}
            palette={palette}
          />
        </box>
      )
    }

    const copyEl = (
      <CopyButton
        textToCopy={content}
        style={{ wrapMode: 'word', fg: textColor, width: '100%' }}
      >
        <span attributes={TextAttributes.ITALIC}>
          <ContentWithMarkdown
            content={displayContent}
            isStreaming={isStreamingMessage}
            codeBlockWidth={codeBlockWidth}
            palette={palette}
          />
        </span>
      </CopyButton>
    )

    if (!showToggle) {
      return copyEl
    }

    return (
      <box style={{ flexDirection: 'column', gap: 0, width: '100%' }}>
        {copyEl}
        <CollapseToggle isExpanded={isExpanded} onToggle={setIsExpanded} />
      </box>
    )
  },
)

interface UserBlockTextWithInlineCopyProps {
  content: string
  contentToCopy: string
  isStreaming: boolean
  textColor: string
  codeBlockWidth: number
  palette: MarkdownPalette
  marginTop: number
  marginBottom: number
}

export const UserBlockTextWithInlineCopy = memo(
  ({
    content,
    contentToCopy,
    isStreaming,
    textColor,
    codeBlockWidth,
    palette,
    marginTop,
    marginBottom,
  }: UserBlockTextWithInlineCopyProps) => {
    // Collapse-by-default only for complete (non-streaming) user block text
    // exceeding the configured line threshold.
    //
    // The former split('\n').length allocated a temporary array proportional
    // to the full content on every render tick while streaming. The exported
    // hasNewlineThreshold helper allocates nothing and stops as soon as the
    // (MAX_COLLAPSED_LINES - 1)-th newline is seen. useMemo ensures it
    // runs only when isStreaming or content changes, not on every render
    // tick.
    const isCollapsibleUser = useMemo(() => {
      if (isStreaming) return false
      return hasNewlineThreshold(content, MAX_COLLAPSED_LINES)
    }, [isStreaming, content])

    const { displayContent, isExpanded, setIsExpanded, showToggle } =
      useCollapsibleContent(content, isCollapsibleUser)

    const hasMarkdownContent = useContentHasMarkdown(content)

    if (hasMarkdownContent) {
      return (
        <box style={{ width: '100%', marginTop, marginBottom }}>
          <ContentWithMarkdown
            content={displayContent}
            isStreaming={isStreaming}
            codeBlockWidth={codeBlockWidth}
            palette={palette}
          />
        </box>
      )
    }

    const copyEl = (
      <CopyButton
        textToCopy={contentToCopy}
        style={{
          wrapMode: 'word',
          fg: textColor,
          marginTop,
          marginBottom,
          width: '100%',
        }}
      >
        <span attributes={TextAttributes.ITALIC}>
          <ContentWithMarkdown
            content={displayContent}
            isStreaming={isStreaming}
            codeBlockWidth={codeBlockWidth}
            palette={palette}
          />
        </span>
      </CopyButton>
    )

    if (!showToggle) {
      return copyEl
    }

    return (
      <box style={{ flexDirection: 'column', gap: 0, width: '100%' }}>
        {copyEl}
        <CollapseToggle isExpanded={isExpanded} onToggle={setIsExpanded} />
      </box>
    )
  },
)

// ============================================================================
// Shared collapse helpers
// ============================================================================

interface CollapsibleContent {
  /** The content to render: truncated preview when collapsed, full when expanded */
  displayContent: string
  isExpanded: boolean
  setIsExpanded: (value: boolean) => void
  /** Whether the collapse toggle should be shown (persistent across collapsed/expanded states) */
  showToggle: boolean
}

/**
 * Hook encapsulating the collapse-by-default behavior for long user messages.
 *
 * - `normalizedContent` is what gets rendered; it is truncated via
 *   `truncateToLines` when collapsed.
 * - Collapse only applies when `isCollapsible` is true (i.e. a complete user
 *   message exceeding MAX_COLLAPSED_LINES). Streaming / short messages are
 *   always shown in full.
 */
function useCollapsibleContent(
  normalizedContent: string,
  isCollapsible: boolean,
): CollapsibleContent {
  const [isExpanded, setIsExpanded] = useState(false)

  // The toggle stays visible in both collapsed and expanded states so that
  // users can always re-collapse ("Show less") after expanding.
  const showToggle = isCollapsible
  const displayContent = useMemo(() => {
    if (!isCollapsible || isExpanded) return normalizedContent
    return truncateToLines(normalizedContent, MAX_COLLAPSED_LINES) ?? normalizedContent
  }, [normalizedContent, isCollapsible, isExpanded])

  return {
    displayContent,
    isExpanded,
    setIsExpanded,
    showToggle,
  }
}

interface CollapseToggleProps {
  isExpanded: boolean
  onToggle: (value: boolean) => void
}

/**
 * Show more / Show less toggle for collapsed user messages.
 * Mirrors the terminal-command-display.tsx affordance.
 */
const CollapseToggle = memo(({ isExpanded, onToggle }: CollapseToggleProps) => {
  const theme = useTheme()

  return (
    <Button style={{ marginTop: 0 }} onClick={() => onToggle(!isExpanded)}>
      <text
        fg={theme.secondary}
        style={{ wrapMode: 'word' }}
        attributes={TextAttributes.UNDERLINE}
      >
        {isExpanded ? '▴ Show less' : '▾ Show more'}
      </text>
    </Button>
  )
})
