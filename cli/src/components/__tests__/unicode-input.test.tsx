import { expect, test } from 'bun:test'
import React from 'react'
import { MultilineInput } from '../multiline-input'
import { initializeThemeStore } from '../../hooks/use-theme'
import { createTextPasteHandler } from '../../utils/strings'
import type { InputValue } from '../../types/store'

initializeThemeStore()
const renderTest = process.env.NODE_ENV === 'production' ? test.skip : test
renderTest(
  'real editor arrows and backspace keep ZWJ emoji and combining marks intact',
  async () => {
    const { testRender } = await import('@opentui/react/test-utils')
    let draft: InputValue = {
      text: 'a👩🏽‍💻e\u0301b',
      cursorPosition: 'a👩🏽‍💻e\u0301'.length,
      lastEditDueToNav: false,
    }
    function Host() {
      const [input, setInput] = React.useState(draft)
      draft = input
      return (
        <MultilineInput
          value={input.text}
          cursorPosition={input.cursorPosition}
          focused={true}
          onChange={setInput}
          onSubmit={() => {}}
          onPaste={() => {}}
        />
      )
    }
    const setup = await testRender(<Host />, { width: 60, height: 18 })
    try {
      await React.act(async () => setup.mockInput.pressArrow('left'))
      expect(draft.cursorPosition).toBe('a👩🏽‍💻'.length)
      await React.act(async () => setup.mockInput.pressBackspace())
      expect(draft.text).toBe('ae\u0301b')
      expect(draft.cursorPosition).toBe(1)
      await React.act(async () => setup.mockInput.pressKey('DELETE'))
      expect(draft.text).toBe('ab')
    } finally {
      await React.act(async () => setup.renderer.destroy())
    }
  },
)

renderTest('literal and Kitty protocol Enter submit while Shift+Enter inserts a newline', async () => {
  const { testRender } = await import('@opentui/react/test-utils')
  for (const kittyKeyboard of [false, true]) {
    let submitted: InputValue | undefined
    function Host() {
      const [draft, setDraft] = React.useState<InputValue>({ text: 'line', cursorPosition: 4, lastEditDueToNav: false })
      return <MultilineInput value={draft.text} cursorPosition={draft.cursorPosition} focused={true}
        onChange={setDraft} onSubmit={(value) => { submitted = value }}
        onPaste={createTextPasteHandler(draft.text, draft.cursorPosition, setDraft)} />
    }
    const setup = await testRender(<Host />, {width: 60, height: 18, kittyKeyboard})
    try {
      await React.act(async () => setup.mockInput.pressEnter())
      expect(submitted?.text).toBe('line')
      submitted = undefined
      await React.act(async () => setup.mockInput.pressKeys(['\x1b[13;2u']))
      expect(submitted).toBeUndefined()
      await React.act(async () => setup.mockInput.pressEnter())
      expect((submitted as InputValue | undefined)?.text).toBe('line\n')
    } finally { await React.act(async () => setup.renderer.destroy()) }
  }
})

renderTest(
  'batched Unicode pastes submit the latest value without editing an input under the overlay',
  async () => {
    const { testRender } = await import('@opentui/react/test-utils')
    const preserved: InputValue = {
      text: 'keep my draft',
      cursorPosition: 4,
      lastEditDueToNav: false,
    }
    let hidden = preserved
    let submitted: InputValue | undefined
    function Host() {
      const [draft, setDraft] = React.useState<InputValue>({
        text: 'Find ',
        cursorPosition: 5,
        lastEditDueToNav: false,
      })
      const [background, setBackground] = React.useState(preserved)
      hidden = background
      return (
        <box style={{ flexDirection: 'column' }}>
          <MultilineInput
            value={background.text}
            cursorPosition={background.cursorPosition}
            focused={false}
            pasteEnabled={false}
            onChange={setBackground}
            onSubmit={() => {}}
            onPaste={createTextPasteHandler(
              background.text,
              background.cursorPosition,
              setBackground,
            )}
          />
          <MultilineInput
            value={draft.text}
            cursorPosition={draft.cursorPosition}
            focused={true}
            onChange={setDraft}
            onSubmit={(value) => {
              submitted = value
            }}
            onPaste={createTextPasteHandler(
              draft.text,
              draft.cursorPosition,
              setDraft,
            )}
          />
        </box>
      )
    }
    const setup = await testRender(<Host />, { width: 60, height: 18 })
    try {
      await React.act(async () => {
        await setup.mockInput.pasteBracketedText('👩🏽‍💻')
        await setup.mockInput.pasteBracketedText(' e\u0301vidence')
        setup.mockInput.pressEnter()
      })
      expect(submitted?.text).toBe('Find 👩🏽‍💻 e\u0301vidence')
      expect(submitted?.cursorPosition).toBe('Find 👩🏽‍💻 e\u0301vidence'.length)
      expect(hidden).toEqual(preserved)
    } finally {
      await React.act(async () => setup.renderer.destroy())
    }
  },
)
