import { previousGrapheme, sliceTextCells } from '../../utils/text-boundaries'
import { TextAttributes } from '@opentui/core'
import { useCallback, useEffect, useRef, useState } from 'react'

import { defineToolComponent } from './types'
import { useTheme } from '../../hooks/use-theme'
import {
  getLatestFollowupToolCallId,
  useChatStore,
} from '../../state/chat-store'
import { Button } from '../button'
import { useOutputReaderStore } from '../../state/output-reader-store'
import { createTextDocument } from '../../utils/output-document'
import {
  requestFollowupSubmission,
  type FollowupSubmissionOutcome,
} from '../../utils/followup-request'

import type { ToolRenderConfig } from './types'
import type { SuggestedFollowup } from '../../types/store'

const EMPTY_CLICKED_SET = new Set<number>()
const inspectedPrompts = new Map<string, string>()
function boundedPreview(text: string, width: number): string {
  let prefix = text.slice(0, 512)
  if (text.length > prefix.length)
    prefix = prefix.slice(0, previousGrapheme(prefix, prefix.length))
  const single = prefix.replace(/\s+/g, ' ').trim()
  const shown = sliceTextCells(single, 0, width)
  return shown + (shown !== single || prefix.length < text.length ? '…' : '')
}

interface FollowupLineProps {
  followup: SuggestedFollowup
  toolCallId: string
  index: number
  isClicked: boolean
  isHovered: boolean
  onSendFollowup: (
    prompt: string,
    index: number,
  ) => Promise<FollowupSubmissionOutcome>
  onHover: (index: number | null) => void
  disabled?: boolean
  /** Width of the label column (for fixed-width alignment) */
  labelColumnWidth: number
  availableWidth: number
}

export const FollowupLine = ({
  followup,
  toolCallId,
  index,
  isClicked,
  isHovered,
  onSendFollowup,
  onHover,
  disabled,
  availableWidth,
}: FollowupLineProps) => {
  const theme = useTheme()
  const pending = useRef(false)
  const accepted = useRef(isClicked)
  const mounted = useRef(true)
  const [state, setState] = useState<
    'idle' | 'pending' | 'accepted' | 'failed'
  >('idle')
  const [error, setError] = useState('')
  useEffect(
    () => {
      mounted.current = true
      return () => {
        mounted.current = false
      }
    },
    [],
  )
  const key = `${toolCallId}:${index}`
  const inspect = useCallback(() => {
    if (inspectedPrompts.size >= 128)
      inspectedPrompts.delete(inspectedPrompts.keys().next().value!)
    inspectedPrompts.set(key, followup.prompt)
    useOutputReaderStore.getState().open({
      document: createTextDocument({
        id: `followup:${key}`,
        title: `Suggested followup ${index + 1}`,
        text: followup.prompt,
        notice:
          'Complete retained suggested prompt · Back returns to the suggestion',
        provenance: {
          source: 'capture',
          identity: toolCallId,
          freshness: 'captured',
          exact: true,
        },
      }),
    })
  }, [followup.prompt, index, key, toolCallId])
  const send = useCallback(async () => {
    if (
      disabled ||
      pending.current ||
      accepted.current ||
      isClicked ||
      !followup.prompt.trim()
    )
      return
    if (
      inspectedPrompts.has(key) &&
      inspectedPrompts.get(key) !== followup.prompt
    ) {
      setError('Suggestion changed · Inspect the current prompt before sending')
      setState('failed')
      return
    }
    pending.current = true
    setState('pending')
    setError('')
    try {
      const result = await onSendFollowup(followup.prompt, index)
      accepted.current = result.accepted === true
      if (mounted.current) {
        setState(result.accepted === true ? 'accepted' : 'failed')
        setError(
          result.accepted
            ? ''
            : (result.error ?? 'Followup was not accepted · try again'),
        )
      }
    } catch {
      if (mounted.current) {
        setState('failed')
        setError('Followup was not accepted · try again')
      }
    } finally {
      pending.current = false
    }
  }, [disabled, followup.prompt, index, isClicked, key, onSendFollowup])
  const done = isClicked || state === 'accepted'
  const label = followup.label
    ? boundedPreview(
        followup.label,
        Math.max(24, Math.min(80, availableWidth * 2)),
      )
    : followup.prompt.length <= availableWidth * 2
      ? boundedPreview(followup.prompt, Math.max(24, availableWidth * 2))
      : `Followup ${index + 1}`
  const preview =
    followup.label || followup.prompt.length > availableWidth * 2
      ? `${boundedPreview(followup.prompt, Math.max(24, Math.min(160, availableWidth * 2)))} · Full prompt available below`
      : ''
  return (
    <box style={{ flexDirection: 'column', width: '100%' }}>
      <Button
        onClick={send}
        onMouseOver={() => onHover(index)}
        onMouseOut={() => onHover(null)}
        style={{ backgroundColor: isHovered ? theme.surface : undefined }}
      >
        <text style={{ wrapMode: 'word' }}>
          <span
            fg={
              done
                ? theme.success
                : state === 'failed'
                  ? theme.warning
                  : theme.muted
            }
          >
            {done ? '✓' : state === 'pending' ? '…' : '→'}{' '}
          </span>
          <span
            fg={theme.foreground}
            attributes={isHovered ? TextAttributes.BOLD : undefined}
          >
            {label}
          </span>
        </text>
      </Button>
      {preview ? (
        <text fg={theme.muted} style={{ wrapMode: 'word' }}>
          {preview}
        </text>
      ) : null}
      {state === 'pending' ? (
        <text fg={theme.muted}>Submitting followup…</text>
      ) : null}
      {done ? <text fg={theme.success}>Followup accepted</text> : null}
      {error ? (
        <text fg={theme.warning} style={{ wrapMode: 'word' }}>
          {error}
        </text>
      ) : null}
      <box style={{ flexDirection: 'row', gap: 2 }}>
        <Button onClick={inspect}>
          <text fg={theme.link}>Inspect full prompt</text>
        </Button>
        {state === 'failed' ? (
          <Button onClick={send}>
            <text fg={theme.link}>Try again</text>
          </Button>
        ) : null}
      </box>
    </box>
  )
}

interface SuggestFollowupsItemProps {
  toolCallId: string
  followups: SuggestedFollowup[]
  onSendFollowup: (
    prompt: string,
    index: number,
  ) => Promise<FollowupSubmissionOutcome>
  availableWidth: number
}

interface PastFollowupItemProps {
  followup: SuggestedFollowup
  isClicked: boolean
}

const PastFollowupItem = ({ followup, isClicked }: PastFollowupItemProps) => {
  const theme = useTheme()
  const displayLabel = followup.label || followup.prompt
  const showFullPrompt = followup.label && followup.label !== followup.prompt

  return (
    <box style={{ flexDirection: 'column', marginLeft: 2 }}>
      <text style={{ wrapMode: 'word' }}>
        <span fg={isClicked ? theme.success : theme.muted}>
          {isClicked ? '✓' : '→'}
        </span>
        <span fg={isClicked ? theme.muted : theme.foreground}>
          {' '}
          {displayLabel}
        </span>
      </text>
      {showFullPrompt && (
        <text style={{ marginLeft: 2, wrapMode: 'word' }}>
          <span fg={theme.muted} attributes={TextAttributes.ITALIC}>
            {followup.prompt}
          </span>
        </text>
      )}
    </box>
  )
}

interface PastFollowupsToggleProps {
  toolCallId: string
  followups: SuggestedFollowup[]
}

const PastFollowupsToggle = ({
  toolCallId,
  followups,
}: PastFollowupsToggleProps) => {
  const theme = useTheme()
  const [isExpanded, setIsExpanded] = useState(false)
  const clickedIndices = useChatStore(
    (state) => state.clickedFollowupsMap.get(toolCallId) ?? EMPTY_CLICKED_SET,
  )

  const handleToggle = useCallback(() => {
    setIsExpanded((prev) => !prev)
  }, [])

  const toggleIndicator = isExpanded ? '▾' : '▸'

  return (
    <box style={{ flexDirection: 'column' }}>
      <Button onClick={handleToggle}>
        <text>
          <span fg={theme.muted}>{toggleIndicator}</span>
          <span fg={theme.muted} attributes={TextAttributes.ITALIC}>
            {' '}
            Previously suggested followups
          </span>
        </text>
      </Button>
      {isExpanded && (
        <box style={{ flexDirection: 'column', marginTop: 0 }}>
          {followups.map((followup, index) => (
            <PastFollowupItem
              key={`past-followup-${index}`}
              followup={followup}
              isClicked={clickedIndices.has(index)}
            />
          ))}
        </box>
      )}
    </box>
  )
}

const SuggestFollowupsItem = ({
  toolCallId,
  followups,
  onSendFollowup,
  availableWidth,
}: SuggestFollowupsItemProps) => {
  const theme = useTheme()
  const setSuggestedFollowups = useChatStore(
    (state) => state.setSuggestedFollowups,
  )
  const latestFollowupToolCallId = useChatStore((state) =>
    getLatestFollowupToolCallId(state.messages),
  )
  const clickedIndices = useChatStore(
    (state) => state.clickedFollowupsMap.get(toolCallId) ?? EMPTY_CLICKED_SET,
  )
  const currentSuggestedFollowups = useChatStore(
    (state) => state.suggestedFollowups,
  )

  const isActive = latestFollowupToolCallId === toolCallId

  useEffect(() => {
    if (!isActive) return

    const hasSameTool = currentSuggestedFollowups?.toolCallId === toolCallId
    const hasSameFollowups =
      hasSameTool &&
      currentSuggestedFollowups?.followups.length === followups.length &&
      currentSuggestedFollowups.followups.every((f, idx) => {
        const next = followups[idx]
        return f?.prompt === next?.prompt && f?.label === next?.label
      })
    const hasSameClicks =
      hasSameTool &&
      currentSuggestedFollowups?.clickedIndices.size === clickedIndices.size &&
      Array.from(currentSuggestedFollowups.clickedIndices).every((idx) =>
        clickedIndices.has(idx),
      )

    if (hasSameFollowups && hasSameClicks) return

    // Track the currently active followups set so we can persist clicked state and avoid races
    setSuggestedFollowups({
      toolCallId,
      followups,
      clickedIndices: new Set(clickedIndices),
    })
  }, [
    clickedIndices,
    currentSuggestedFollowups,
    followups,
    isActive,
    setSuggestedFollowups,
    toolCallId,
  ])

  // Track which item is hovered (for passing to children)
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null)

  // For past messages, show collapsed toggle view
  if (!isActive) {
    return <PastFollowupsToggle toolCallId={toolCallId} followups={followups} />
  }

  const labelColumnWidth = Math.max(10, availableWidth - 4)

  return (
    <box style={{ flexDirection: 'column' }}>
      <text style={{ fg: theme.muted }}>Suggested followups:</text>
      <box style={{ flexDirection: 'column' }}>
        {followups.map((followup, index) => (
          <FollowupLine
            key={`followup-${index}`}
            followup={followup}
            toolCallId={toolCallId}
            index={index}
            isClicked={clickedIndices.has(index)}
            isHovered={hoveredIndex === index}
            onSendFollowup={onSendFollowup}
            onHover={setHoveredIndex}
            disabled={false}
            labelColumnWidth={labelColumnWidth}
            availableWidth={availableWidth}
          />
        ))}
      </box>
    </box>
  )
}

/**
 * UI component for suggest_followups tool.
 * Displays clickable cards that send the followup prompt as a user message when clicked.
 */
export const SuggestFollowupsComponent = defineToolComponent({
  toolName: 'suggest_followups',

  render(toolBlock, _theme, options): ToolRenderConfig {
    const { input, toolCallId } = toolBlock

    // Extract followups from input
    let followups: SuggestedFollowup[] = []

    if (Array.isArray(input?.followups)) {
      followups = input.followups.filter(
        (f: unknown): f is SuggestedFollowup =>
          typeof f === 'object' &&
          f !== null &&
          typeof (f as SuggestedFollowup).prompt === 'string',
      )
    }

    if (followups.length === 0) {
      return { content: null }
    }

    // The actual click handling is done in chat.tsx via the global handler
    // Here we just pass a placeholder that will be replaced
    const handleSendFollowup = (prompt: string, index: number) =>
      requestFollowupSubmission(prompt, index, toolCallId)

    return {
      content: (
        <SuggestFollowupsItem
          toolCallId={toolCallId}
          followups={followups}
          onSendFollowup={handleSendFollowup}
          availableWidth={options.availableWidth}
        />
      ),
    }
  },
})
