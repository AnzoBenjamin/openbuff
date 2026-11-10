import { describe, expect, test } from 'bun:test'
import React from 'react'

import { Button, isButtonActivationKey } from '../button'

describe('Button keyboard activation', () => {
  test.each(['return', 'enter', 'space'])('activates for %s', (name) => {
    expect(isButtonActivationKey({ name } as never)).toBe(true)
  })

  test.each(['tab', 'escape', 'left'])('does not activate for %s', (name) => {
    expect(isButtonActivationKey({ name } as never)).toBe(false)
  })
})

const nativeTest = process.env.NODE_ENV === 'production' ? test.skip : test

nativeTest(
  'focus redraw keeps a pressed button active, while leaving cancels its press',
  async () => {
    const { testRender } = await import('@opentui/react/test-utils')
    let activated = 0
    function Host() {
      const [focused, setFocused] = React.useState(false)
      return React.createElement(
        Button,
        {
          width: 12,
          height: 1,
          onFocused: () => setFocused(true),
          onClick: () => {
            activated++
          },
        },
        React.createElement(
          'text',
          null,
          focused ? React.createElement('b', null, 'Action') : 'Action',
        ),
      )
    }
    const setup = await testRender(React.createElement(Host), {
      width: 40,
      height: 8,
    })
    try {
      await React.act(async () => setup.renderOnce())
      await React.act(async () => setup.mockMouse.pressDown(2, 0))
      await React.act(async () => setup.flush())
      await React.act(async () => setup.mockMouse.release(2, 0))
      expect(activated).toBe(1)

      await React.act(async () => setup.mockMouse.pressDown(2, 0))
      await React.act(async () => setup.mockMouse.moveTo(25, 2))
      await React.act(async () => setup.mockMouse.release(25, 2))
      expect(activated).toBe(1)

      await React.act(async () => setup.mockMouse.moveTo(2, 0))
      await React.act(async () => setup.mockMouse.release(2, 0))
      expect(activated).toBe(1)
      await React.act(async () => setup.mockMouse.click(2, 0))
      expect(activated).toBe(2)
    } finally {
      await React.act(async () => setup.dispose())
    }
  },
)
