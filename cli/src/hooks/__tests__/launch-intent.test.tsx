import { expect, test } from 'bun:test'
import React from 'react'
import { createLaunchIntent } from '../../utils/launch-intent'
import { useChatInput } from '../use-chat-input'
import { useChatStore } from '../../state/chat-store'

const renderTest = process.env.NODE_ENV === 'production' ? test.skip : test

test('New Chat discards both launch prompt and explicit continuation', () => {
  const intent = createLaunchIntent('launch', true, 'session-1')
  intent.discard()
  expect(intent.peekPrompt()).toBeNull()
  expect(intent.peekContinuation()).toEqual({ enabled: false, id: undefined })
  expect(intent.claimPrompt('launch')).toBe(false)
})

renderTest(
  'cancelled mount retains launch intent; actual dispatch claims it once across remounts',
  async () => {
    const { testRender } = await import('@opentui/react/test-utils')
    const intent = createLaunchIntent('launch exactly once', false)
    const sends: string[] = []
    const submit = (text: string) => {
      sends.push(text)
    }
    let setView!: React.Dispatch<
      React.SetStateAction<{ show: boolean; generation: number }>
    >
    function Host() {
      const [{ show, generation }, update] = React.useState({
        show: true,
        generation: 1,
      })
      setView = update
      return show ? <Input key={generation} /> : <text>Project picker</text>
    }
    function Input() {
      useChatInput({
        initialPrompt: intent.peekPrompt(),
        claimInitialPrompt: intent.claimPrompt,
        agentMode: 'DEFAULT',
        setAgentMode: () => {},
        separatorWidth: 78,
        isCompactHeight: false,
        isNarrowWidth: false,
        modeWidthAdjustment: 0,
        onSubmitPrompt: submit,
      })
      return <text>Composer</text>
    }
    const setup = await testRender(<Host />, { width: 80, height: 10 })
    try {
      await React.act(async () => setView({ show: false, generation: 1 }))
      await React.act(async () => {
        await Bun.sleep(120)
      })
      expect(sends).toEqual([])
      expect(intent.peekPrompt()).toBe('launch exactly once')
      await React.act(async () => setView({ show: true, generation: 2 }))
      await React.act(async () => {
        await Bun.sleep(120)
      })
      expect(sends).toEqual(['launch exactly once'])
      await React.act(async () => setView({ show: true, generation: 3 }))
      await React.act(async () => {
        await Bun.sleep(120)
      })
      expect(sends).toEqual(['launch exactly once'])
    } finally {
      await React.act(async () => setup.renderer.destroy())
      useChatStore.getState().reset()
    }
  },
)
