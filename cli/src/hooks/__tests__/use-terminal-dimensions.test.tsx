import { expect, test } from 'bun:test'
import React from 'react'
import { useTerminalDimensions } from '../use-terminal-dimensions'

const nativeTest = process.env.NODE_ENV === 'production' ? test.skip : test

nativeTest(
  'shares one resize listener, updates every consumer, and releases it on unmount',
  async () => {
    const { testRender } = await import('@opentui/react/test-utils')
    let setCount!: React.Dispatch<React.SetStateAction<number>>
    const sizes = new Map<number, string>()
    function Consumer({ index }: { index: number }) {
      const { terminalWidth, terminalHeight } = useTerminalDimensions()
      sizes.set(index, `${terminalWidth}x${terminalHeight}`)
      return <text>{index}</text>
    }
    function Host() {
      const [count, update] = React.useState(40)
      setCount = update
      return (
        <box>
          {Array.from({ length: count }, (_, index) => (
            <Consumer key={index} index={index} />
          ))}
        </box>
      )
    }
    const setup = await testRender(<Host />, { width: 80, height: 24 })
    try {
      expect(setup.renderer.listenerCount('resize')).toBe(1)
      await React.act(async () => setup.resize(100, 30))
      expect(new Set(sizes.values())).toEqual(new Set(['100x30']))
      await React.act(async () => setCount(0))
      expect(setup.renderer.listenerCount('resize')).toBe(0)
      await React.act(async () => setCount(40))
      expect(setup.renderer.listenerCount('resize')).toBe(1)
      await React.act(async () => setCount(0))
      expect(setup.renderer.listenerCount('resize')).toBe(0)
    } finally {
      await React.act(async () => setup.dispose())
    }
  },
)
