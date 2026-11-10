import React, { createContext, useContext, useRef, useState } from 'react'
import type { BoxRenderable } from '@opentui/core'

import { Button } from '../button'
import { useTheme } from '../../hooks/use-theme'
import { useMessageBlockStore } from '../../state/message-block-store'

/** Keep a large captured list navigable without mounting every row at once. */
export const INLINE_RESULT_PAGE_SIZE = 50

const InlineResultContext = createContext<{
  messageId: string
  scope: string
} | null>(null)

/** Bind list views to retained message identity, surviving viewport remounts. */
export function InlineResultScope({
  messageId,
  scope,
  children,
}: {
  messageId: string
  scope: string
  children: React.ReactNode
}) {
  const parent = useContext(InlineResultContext)
  return (
    <InlineResultContext.Provider
      value={{ messageId: parent?.messageId ?? messageId, scope }}
    >
      {children}
    </InlineResultContext.Provider>
  )
}

export function InlineResults<T>({
  items,
  renderItem,
  previewCount = 6,
  noun = 'result',
  pluralNoun = `${noun}s`,
  fromEnd = false,
  expanded: controlledExpanded,
  onExpandedChange,
  scope = noun,
  renderHeader,
}: {
  items: readonly T[]
  renderItem: (item: T, index: number) => React.ReactNode
  previewCount?: number
  noun?: string
  pluralNoun?: string
  /** Event tails initially show the latest entries, in source order. */
  fromEnd?: boolean
  expanded?: boolean
  onExpandedChange?: (expanded: boolean) => void
  /** Distinguishes multiple lists within the same tool or command block. */
  scope?: string
  renderHeader?: (expanded: boolean, toggle: () => void) => React.ReactNode
}) {
  const theme = useTheme()
  const identity = useContext(InlineResultContext)
  const viewScope = `${identity?.scope ?? ''}:list:${scope}`
  const retained = useMessageBlockStore((state) =>
    identity ? state.listViews[identity.messageId]?.[viewScope] : undefined,
  )
  const [localExpanded, setLocalExpanded] = useState(false)
  const [localPage, setLocalPage] = useState(0)
  const localPageRef = useRef(0)
  const previousButtonRef = useRef<BoxRenderable | null>(null)
  const nextButtonRef = useRef<BoxRenderable | null>(null)
  const disclosureButtonRef = useRef<BoxRenderable | null>(null)
  const expanded = controlledExpanded ?? retained?.expanded ?? localExpanded
  const page = retained?.page ?? localPage
  const preview = Math.min(
    INLINE_RESULT_PAGE_SIZE,
    Number.isFinite(previewCount) ? Math.max(1, Math.trunc(previewCount)) : 6,
  )
  const pageCount = Math.ceil(items.length / INLINE_RESULT_PAGE_SIZE)
  const currentPage = Math.max(0, Math.min(page, pageCount - 1))
  const start = expanded
    ? currentPage * INLINE_RESULT_PAGE_SIZE
    : fromEnd
      ? Math.max(0, items.length - preview)
      : 0
  const end = expanded
    ? Math.min(items.length, start + INLINE_RESULT_PAGE_SIZE)
    : Math.min(items.length, start + preview)
  const hidden = items.length - (end - start)
  const setExpanded = (next: boolean) => {
    setLocalExpanded(next)
    onExpandedChange?.(next)
    const nextPage = next && fromEnd ? Math.max(0, pageCount - 1) : 0
    localPageRef.current = nextPage
    setLocalPage(nextPage)
    if (identity)
      useMessageBlockStore
        .getState()
        .setListView(identity.messageId, viewScope, {
          expanded: next,
          page: nextPage,
        })
  }
  const movePage = (delta: number) => {
    const state = useMessageBlockStore.getState()
    const previous = identity
      ? (state.listViews[identity.messageId]?.[viewScope]?.page ?? page)
      : localPageRef.current
    const nextPage = Math.max(
      0,
      Math.min(pageCount - 1, Math.min(pageCount - 1, previous) + delta),
    )
    const activatedButton =
      delta < 0 ? previousButtonRef.current : nextButtonRef.current
    // Keep keyboard activation available when the boundary button unmounts.
    if (
      activatedButton?.focused &&
      ((delta < 0 && nextPage === 0) ||
        (delta > 0 && nextPage === pageCount - 1))
    )
      disclosureButtonRef.current?.focus()
    if (identity) {
      state.setListView(identity.messageId, viewScope, {
        expanded,
        page: nextPage,
      })
    } else {
      localPageRef.current = nextPage
      setLocalPage(nextPage)
    }
  }

  return (
    <box style={{ flexDirection: 'column', gap: 0, width: '100%' }}>
      {renderHeader?.(expanded, () => setExpanded(!expanded))}
      {items.slice(start, end).map((item, index) => (
        <React.Fragment key={start + index}>
          {renderItem(item, start + index)}
        </React.Fragment>
      ))}
      {expanded && pageCount > 1 ? (
        <text fg={theme.muted} style={{ wrapMode: 'word' }}>
          {`Showing ${start + 1}–${end} of ${items.length} captured ${pluralNoun}`}
        </text>
      ) : null}
      {hidden > 0 || (expanded && items.length > preview) ? (
        <box style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 2 }}>
          {expanded && currentPage > 0 ? (
            <Button
              key="previous"
              ref={previousButtonRef}
              onClick={() => movePage(-1)}
            >
              <text fg={theme.primary}>Previous results</text>
            </Button>
          ) : null}
          {expanded && currentPage + 1 < pageCount ? (
            <Button key="next" ref={nextButtonRef} onClick={() => movePage(1)}>
              <text fg={theme.primary}>Next results</text>
            </Button>
          ) : null}
          <Button
            key="disclosure"
            ref={disclosureButtonRef}
            onClick={() => setExpanded(!expanded)}
          >
            <text fg={theme.primary} style={{ wrapMode: 'word' }}>
              {expanded
                ? 'Show less'
                : `Show more · ${hidden} ${hidden === 1 ? noun : pluralNoun} hidden`}
            </text>
          </Button>
        </box>
      ) : null}
    </box>
  )
}
