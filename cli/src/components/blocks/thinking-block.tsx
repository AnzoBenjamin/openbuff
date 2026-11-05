import { memo, useCallback } from 'react'
import { Thinking } from '../thinking'
import {
  thinkingPreviewTail,
  retainedThinkingText,
} from '../../utils/thinking-preview'
import { createTextDocument } from '../../utils/output-document'
import { useOutputReaderStore } from '../../state/output-reader-store'
import type { ContentBlock } from '../../types/chat'
interface ThinkingBlockProps {
  blocks: Extract<ContentBlock, { type: 'text' }>[]
  onToggleCollapsed: (id: string) => void
  availableWidth: number
  isNested: boolean
  isMessageComplete: boolean
}
export const ThinkingBlock = memo(
  ({
    blocks,
    onToggleCollapsed,
    availableWidth,
    isMessageComplete,
  }: ThinkingBlockProps) => {
    const first = blocks[0]
    const id = first?.thinkingId
    const state = first?.thinkingCollapseState ?? 'preview'
    const toggle = useCallback(() => {
      if (id) onToggleCollapsed(id)
    }, [id, onToggleCollapsed])
    const inspect = useCallback(() => {
      if (!id) return
      useOutputReaderStore
        .getState()
        .open({
          document: createTextDocument({
            id: `thinking:${id}`,
            title: 'Captured reasoning',
            kind: 'markdown',
            text: retainedThinkingText(blocks),
            notice:
              'Complete retained reasoning · body previews do not change captured source',
          }),
        })
    }, [blocks, id])
    if (!id) return null
    // Metadata/header only in hidden state: no join, trim, normalization or wrap.
    const tail = state === 'preview' ? thinkingPreviewTail(blocks) : undefined
    const content =
      state === 'expanded' ? retainedThinkingText(blocks) : (tail?.text ?? '')
    return (
      <box style={{ flexDirection: 'column', minWidth: 0, flexShrink: 0 }}>
        <Thinking
          content={content}
          thinkingCollapseState={state}
          previewLimited={tail?.limited}
          isThinkingComplete={first.thinkingOpen === false || isMessageComplete}
          onToggle={toggle}
          onInspect={inspect}
          availableWidth={Math.max(10, availableWidth)}
          thinkingStartedAt={first.thinkingStartedAt}
          thinkingEndedAt={first.thinkingEndedAt}
        />
      </box>
    )
  },
)
