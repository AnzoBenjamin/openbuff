import { expect, test } from 'bun:test'
import React from 'react'
import { MultilineInput } from '../multiline-input'
import { initializeThemeStore } from '../../hooks/use-theme'
import { createTextPasteHandler } from '../../utils/strings'
import type { InputValue } from '../../types/store'

initializeThemeStore()
const renderTest = process.env.NODE_ENV === 'production' ? test.skip : test

renderTest(
  'native clicks after the cursor cell retain tab/newline and Unicode coordinates',
  async () => {
    const { testRender } = await import('@opentui/react/test-utils')
    for (const text of ['A😀\tZ', 'A😀\nZ']) {
      let draft: InputValue = {
        text,
        cursorPosition: 3,
        lastEditDueToNav: false,
      }
      function Host() {
        const [input, setInput] = React.useState(draft)
        draft = input
        return (
          <box width={60} height={18}>
            <MultilineInput
              value={input.text}
              cursorPosition={input.cursorPosition}
              onChange={setInput}
              onSubmit={() => {}}
              onPaste={() => {}}
              wrapWidth={60}
              focused
            />
          </box>
        )
      }
      const setup = await testRender(<Host />, { width: 60, height: 18 })
      try {
        await React.act(async () => setup.renderOnce())
        const rows = setup.captureCharFrame().split('\n')
        const y = rows.findIndex((row) => row.includes('Z'))
        const x = text.includes('\t') ? 9 : 1
        expect(y).toBeGreaterThanOrEqual(0)
        await React.act(async () => setup.mockMouse.click(x, y))
        expect(draft.cursorPosition).toBe(4)
        await React.act(async () => setup.mockInput.typeText('x'))
        expect(draft.text).toBe(text.slice(0, 4) + 'xZ')
      } finally {
        await React.act(async () => setup.renderer.destroy())
      }
    }
  },
)

renderTest(
  'batched typing and paste support Undo/Redo without resurrecting a submitted draft',
  async () => {
    const { testRender } = await import('@opentui/react/test-utils')
    let draft: InputValue = {
      text: 'A',
      cursorPosition: 1,
      lastEditDueToNav: false,
    }
    function Host() {
      const [input, setInput] = React.useState(draft)
      draft = input
      return (
        <MultilineInput
          value={input.text}
          cursorPosition={input.cursorPosition}
          onChange={setInput}
          onSubmit={() =>
            setInput({ text: '', cursorPosition: 0, lastEditDueToNav: false })
          }
          onPaste={createTextPasteHandler(
            input.text,
            input.cursorPosition,
            setInput,
          )}
          focused
        />
      )
    }
    const setup = await testRender(<Host />, { width: 60, height: 18 })
    try {
      await React.act(async () => setup.mockInput.typeText('B'))
      expect(draft.text).toBe('AB')
      await React.act(async () => setup.mockInput.pressKeys(['\x1a']))
      expect(draft.text).toBe('A')
      await React.act(async () => setup.mockInput.pressKeys(['\x19']))
      expect(draft.text).toBe('AB')
      await React.act(async () => setup.mockInput.pasteBracketedText('👩🏽‍💻'))
      expect(draft.text).toBe('AB👩🏽‍💻')
      await React.act(async () => setup.mockInput.pressKeys(['\x1a']))
      expect(draft.text).toBe('AB')
      await React.act(async () => setup.mockInput.pressEnter())
      expect(draft.text).toBe('')
      await React.act(async () => setup.mockInput.pressKeys(['\x1a']))
      expect(draft.text).toBe('')
    } finally {
      await React.act(async () => setup.renderer.destroy())
    }
  },
)

renderTest(
  'Undo restores a native selection so the next edit replaces that selection',
  async () => {
    const { testRender } = await import('@opentui/react/test-utils')
    let draft: InputValue = {
      text: 'ABCDE',
      cursorPosition: 5,
      lastEditDueToNav: false,
    }
    function Host() {
      const [input, setInput] = React.useState(draft)
      draft = input
      return (
        <box width={60} height={18}>
          <MultilineInput
            value={input.text}
            cursorPosition={input.cursorPosition}
            onChange={setInput}
            onSubmit={() => {}}
            onPaste={() => {}}
            wrapWidth={60}
            focused
          />
        </box>
      )
    }
    const setup = await testRender(<Host />, { width: 60, height: 18 })
    try {
      await React.act(async () => setup.renderOnce())
      await React.act(async () => setup.mockMouse.drag(2, 0, 4, 0))
      await React.act(async () => setup.mockInput.typeText('x'))
      const replaced = draft.text
      expect(replaced).not.toBe('ABCDE')
      expect(replaced.length).toBeLessThan(6)
      await React.act(async () => setup.mockInput.pressKeys(['\x1a']))
      expect(draft.text).toBe('ABCDE')
      await React.act(async () => setup.mockInput.typeText('y'))
      expect(draft.text).toBe(replaced.replace('x', 'y'))
    } finally {
      await React.act(async () => setup.renderer.destroy())
    }
  },
)

renderTest(
  'paste replaces an undo-restored selection and later typing cannot reuse stale offsets',
  async () => {
    const { testRender } = await import('@opentui/react/test-utils')
    let draft: InputValue = {
      text: 'ABCDE',
      cursorPosition: 5,
      lastEditDueToNav: false,
    }
    function Host() {
      const [input, setInput] = React.useState(draft)
      draft = input
      return (
        <box width={60} height={18}>
          <MultilineInput
            value={input.text}
            cursorPosition={input.cursorPosition}
            onChange={setInput}
            onSubmit={() => {}}
            onPaste={createTextPasteHandler(
              input.text,
              input.cursorPosition,
              setInput,
            )}
            wrapWidth={60}
            focused
          />
        </box>
      )
    }
    const setup = await testRender(<Host />, { width: 60, height: 18 })
    try {
      await React.act(async () => setup.renderOnce())
      await React.act(async () => setup.mockMouse.drag(2, 0, 4, 0))
      await React.act(async () => setup.mockInput.typeText('x'))
      expect(draft.text).toBe('AxE')
      await React.act(async () => setup.mockInput.pressKeys(['\x1a']))
      await React.act(async () => {
        await setup.mockInput.pasteBracketedText('P😀')
        await setup.mockInput.typeText('y')
      })
      expect(draft.text).toBe('AP😀yE')
    } finally {
      await React.act(async () => setup.renderer.destroy())
    }
  },
)
