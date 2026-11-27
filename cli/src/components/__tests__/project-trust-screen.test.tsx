import { afterEach, expect, test } from 'bun:test'
import React from 'react'

import { ProjectTrustScreen } from '../project-trust-screen'
import { initializeThemeStore, useThemeStore } from '../../hooks/use-theme'

initializeThemeStore()
const nativeTest = process.env.NODE_ENV === 'production' ? test.skip : test
afterEach(() => useThemeStore.getState().setThemeName('dark'))

async function mount(node: React.ReactNode, width = 80, height = 20) {
  const { testRender } = await import('@opentui/react/test-utils')
  let setup!: Awaited<ReturnType<typeof testRender>>
  await React.act(async () => {
    setup = await testRender(node, { width, height })
  })
  await setup.renderOnce()
  return setup
}

const gatedItems = [
  'set provider with apiKeyEnv (openbuff.json)',
  'load project skills from .agents/skills/',
]

nativeTest('shows the exact gated items and defaults to deny', async () => {
  const decisions: boolean[] = []
  const setup = await mount(
    <ProjectTrustScreen
      lines={gatedItems}
      onDecision={(value) => decisions.push(value)}
    />,
  )
  try {
    const frame = setup.captureCharFrame()
    for (const text of [
      'Project trust',
      'set provider with apiKeyEnv (openbuff.json)',
      'load project skills from .agents/skills/',
      'Keep untrusted (N)',
      'Trust project (Y)',
      'Esc keeps untrusted',
    ])
      expect(frame).toContain(text)

    await React.act(async () => setup.mockInput.pressEnter())
    expect(decisions).toEqual([false])
  } finally {
    await React.act(async () => setup.renderer.destroy())
  }
})

nativeTest(
  'requires an explicit selection to approve the project',
  async () => {
    const decisions: boolean[] = []
    const setup = await mount(
      <ProjectTrustScreen
        lines={gatedItems}
        onDecision={(value) => decisions.push(value)}
      />,
    )
    try {
      await React.act(async () => {
        setup.mockInput.pressArrow('right')
        setup.mockInput.pressEnter()
        setup.mockInput.pressEnter()
      })
      expect(decisions).toEqual([true])
    } finally {
      await React.act(async () => setup.renderer.destroy())
    }
  },
)

nativeTest('Y and N shortcuts settle the trust decision directly', async () => {
  for (const [input, expected] of [
    ['y', true],
    ['n', false],
  ] as const) {
    const decisions: boolean[] = []
    const setup = await mount(
      <ProjectTrustScreen
        lines={gatedItems}
        onDecision={(value) => decisions.push(value)}
      />,
    )
    try {
      await React.act(async () => setup.mockInput.pressKey(input))
      expect(decisions).toEqual([expected])
    } finally {
      await React.act(async () => setup.renderer.destroy())
    }
  }
})
