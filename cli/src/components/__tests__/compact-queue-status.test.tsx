import { afterEach, expect, test } from 'bun:test'
import React from 'react'
import { ChatInputBar } from '../chat-input-bar'
import { initializeThemeStore, useThemeStore } from '../../hooks/use-theme'
import { useChatStore } from '../../state/chat-store'
import { formatQueuedPreview } from '../../utils/helpers'

initializeThemeStore()
afterEach(() => useChatStore.getState().reset())
const nativeTest = process.env.NODE_ENV === 'production' ? test.skip : test
const noop = () => {}

for (const width of [50, 80]) {
  for (const paused of [false, true]) {
    for (const draft of ['', 'retained draft']) {
      nativeTest(`compact queue ${width}x15 paused=${paused} draft=${Boolean(draft)} retains count/order in one row`, async () => {
        const { testRender } = await import('@opentui/react/test-utils')
        const title = paused ? '2 queued · Paused · next input sends first' : formatQueuedPreview([
          { content: 'first FIFO prompt', agentMode: 'PLAN', attachments: [] },
          { content: 'second prompt', agentMode: 'DEFAULT', attachments: [] },
        ], width - 2)
        const props: React.ComponentProps<typeof ChatInputBar> = {
          inputValue: draft, cursorPosition: draft.length, setInputValue: noop, inputFocused: true,
          inputRef: { current: null }, inputPlaceholder: 'Enter a coding task', lastEditDueToNav: false,
          agentMode: 'DEFAULT', toggleAgentMode: noop, setAgentMode: noop,
          hasSlashSuggestions: false, hasMentionSuggestions: false, hasSuggestionMenu: false,
          slashSuggestionItems: [], agentSuggestionItems: [], fileSuggestionItems: [], slashSelectedIndex: 0, agentSelectedIndex: 0,
          theme: useThemeStore.getState().theme, terminalHeight: 15, separatorWidth: width,
          shouldCenterInputVertically: false, inputBoxTitle: title, isCompactHeight: true, isNarrowWidth: true,
          inputWidth: width - 2, feedbackMode: false, handleExitFeedback: noop, publishMode: false,
          handleExitPublish: noop, handlePublish: async () => {}, handleSubmit: async () => {}, onPaste: noop,
          onInterruptStream: noop,
        }
        const setup = await testRender(<box flexDirection="column"><ChatInputBar {...props} /></box>, { width, height: 15 })
        try {
          await setup.renderOnce()
          const rows = setup.captureCharFrame().split('\n')
          expect(rows.filter(row => paused ? row.includes('2 queued') : row.includes('Next · Plan'))).toHaveLength(1)
          if (paused) expect(rows.join('\n')).toContain('next input sends first')
          else expect(rows.join('\n')).toContain('(+1)')
          expect(rows.join('\n')).toContain(draft || 'Enter a coding task')
          expect(rows.filter(row => row.trim())).toHaveLength(2)
        } finally {
          await React.act(async () => setup.renderer.destroy())
        }
      })
    }
  }
}
