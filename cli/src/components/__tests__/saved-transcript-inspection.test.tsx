import { afterEach, expect, test } from 'bun:test'
import React from 'react'
import { ChatHistoryScreen } from '../chat-history-screen'
import { initializeThemeStore } from '../../hooks/use-theme'
import { savedTranscriptInspection } from '../../utils/saved-transcript-inspection'
import { useChatStore } from '../../state/chat-store'
import { useOutputReaderStore } from '../../state/output-reader-store'

initializeThemeStore()
afterEach(() => { useChatStore.getState().reset(); useOutputReaderStore.setState({ views: {}, request: null }) })
const nativeTest = process.env.NODE_ENV === 'production' ? test.skip : test
nativeTest('saved capture inspection reaches malformed raw fields and returns without resuming or changing the draft', async () => {
  const { testRender } = await import('@opentui/react/test-utils')
  let resumed = 0
  let cancelled = 0
  useChatStore.getState().setInputValue({ text: 'retain current draft', cursorPosition: 6, lastEditDueToNav: false })
  const setup = await testRender(<ChatHistoryScreen onSelectChat={() => resumed++} onCancel={() => cancelled++} onNewChat={() => {}} dependencies={{
    load: async () => [{ chatId: 'capture', lastPrompt: 'retained prompt', timestamp: new Date(), messageCount: 3 }],
    delete: () => true,
    inspect: async () => savedTranscriptInspection('saved-inspection:capture', [
      { id: 'good', variant: 'user', content: 'healthy retained prompt', timestamp: '', blocks: [] },
      { id: 'bad', variant: 'ai', content: { diagnostic: 'RETAINED_BAD_MESSAGE' }, timestamp: '', blocks: false },
      { id: 'last', variant: 'system', content: 'healthy final message', timestamp: '', blocks: [] },
    ], '/fixture/messages.json'),
  }} />, { width: 80, height: 24 })
  try {
    await React.act(async () => { await Bun.sleep(30); await setup.renderOnce() })
    await React.act(async () => setup.mockInput.pressKey('o', { ctrl: true }))
    await React.act(async () => { await Bun.sleep(30); await setup.renderOnce() })
    expect(setup.captureCharFrame()).toContain('unavailable message')
    expect(setup.captureCharFrame()).toContain('healthy retained prompt')
    await React.act(async () => setup.mockInput.pressKey('g'))
    await React.act(async () => { await setup.mockInput.typeText('row 2'); setup.mockInput.pressEnter() })
    await setup.renderOnce()
    expect(setup.captureCharFrame()).toContain('RETAINED_BAD_MESSAGE')
    await React.act(async () => setup.mockInput.pressEscape())
    await React.act(async () => setup.mockInput.pressEscape())
    expect(resumed).toBe(0)
    expect(cancelled).toBe(0)
    expect(useChatStore.getState().inputValue).toBe('retain current draft')
    expect(useChatStore.getState().cursorPosition).toBe(6)
  } finally {
    await React.act(async () => setup.renderer.destroy())
  }
})
