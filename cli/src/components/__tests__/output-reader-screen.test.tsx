import { expect, test } from 'bun:test'
import React from 'react'
import { OutputReaderScreen } from '../output-reader-screen'
import { createTextDocument } from '../../utils/output-document'
import { useChatStore } from '../../state/chat-store'
import { initializeThemeStore } from '../../hooks/use-theme'

initializeThemeStore()

const renderTest = process.env.NODE_ENV === 'production' ? test.skip : test

renderTest(
  'find line 9800, resize and return leave the exact draft and cursor untouched',
  async () => {
    const { testRender } = await import('@opentui/react/test-utils')
    const text = Array.from({ length: 10_000 }, (_, index) =>
      index === 9799 ? 'FAILURE unique evidence' : `log ${index + 1}`,
    ).join('\n')
    const document = createTextDocument({
      id: 'log',
      title: 'Build log',
      kind: 'log',
      text,
    })
    const store = useChatStore.getState()
    store.setInputValue({
      text: 'keep 👩🏽‍💻 draft',
      cursorPosition: 5,
      lastEditDueToNav: false,
    })
    let closed = false
    const setup = await testRender(
      <OutputReaderScreen
        messages={[]}
        initialDocument={document}
        onClose={() => {
          closed = true
        }}
      />,
      { width: 160, height: 40 },
    )
    try {
      await React.act(async () => setup.mockInput.pressKey('/'))
    // A terminal can deliver text and Enter in the same input batch.
    await React.act(async () => { await setup.mockInput.typeText('FAILURE'); setup.mockInput.pressEnter() })
      await setup.renderOnce()
      expect(setup.captureCharFrame()).toContain('Line 9800/10000')
      expect(setup.captureCharFrame()).toContain('FAILURE unique evidence')
      await React.act(async () => setup.resize(60, 18))
      await setup.renderOnce()
      expect(setup.captureCharFrame()).toContain('Line 9800/10000')
      expect(setup.captureCharFrame()).toContain('Back (Esc)')
      await React.act(async () => {
        setup.mockInput.pressEscape()
        await Bun.sleep(70)
      })
      expect(closed).toBe(true)
      expect(useChatStore.getState().inputValue).toBe('keep 👩🏽‍💻 draft')
      expect(useChatStore.getState().cursorPosition).toBe(5)
    } finally {
      await React.act(async () => setup.renderer.destroy())
      store.reset()
    }
  },
)

renderTest('Escape leaves find scope before closing the reader', async () => {
  const { testRender } = await import('@opentui/react/test-utils')
  let closed = false
  const setup = await testRender(
    <OutputReaderScreen
      messages={[]}
      initialDocument={createTextDocument({
        id: 'text',
        title: 'Text',
        text: 'retained',
      })}
      onClose={() => {
        closed = true
      }}
    />,
    { width: 80, height: 24 },
  )
  try {
    await React.act(async () => setup.mockInput.pressKey('/'))
    await React.act(async () => {
      setup.mockInput.pressEscape()
      await Bun.sleep(70)
    })
    expect(closed).toBe(false)
    await React.act(async () => {
      setup.mockInput.pressEscape()
      await Bun.sleep(70)
    })
    expect(closed).toBe(true)
  } finally {
    await React.act(async () => setup.renderer.destroy())
  }
})
