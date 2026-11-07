import { expect, test } from 'bun:test'
import React from 'react'
import { ModelRoutePicker } from '../model-route-picker'
import { ChatHistoryScreen } from '../chat-history-screen'
import { PlanSessionPickerScreen } from '../plan-session-picker-screen'
import { initializeThemeStore } from '../../hooks/use-theme'
import type { ProviderConfigFileInput, AgentDefinition } from '@openbuff/sdk'
import type { PlanSessionSummary } from '../../commands/plan-artifacts'

async function renderFixture(
  node: React.ReactNode,
  options: Parameters<typeof import('@opentui/react/test-utils').testRender>[1],
) {
  const { testRender } = await import('@opentui/react/test-utils')
  let setup!: Awaited<ReturnType<typeof testRender>>
  await React.act(async () => {
    setup = await testRender(node, options)
  })
  return setup
}

initializeThemeStore()
const renderTest = process.env.NODE_ENV === 'production' ? test.skip : test

renderTest(
  '250 models are windowed with visible focus, pending identity and preserved reasoning',
  async () => {
    const { testRender } = await import('@opentui/react/test-utils')
    let config: ProviderConfigFileInput = {
      defaultModel: 'p/model-1',
      defaultReasoningEffort: 'high',
    }
    const dependencies = {
      readConfig: () => structuredClone(config),
      models: () =>
        Array.from({ length: 250 }, (_, index) => ({
          model: `p/model-${index + 1}`,
        })),
      agents: () => [] as AgentDefinition[],
      writeConfig: (value: ProviderConfigFileInput) => {
        config = structuredClone(value)
        return '/fixture/openbuff.json'
      },
    }
    let setup!: Awaited<ReturnType<typeof testRender>>
    await React.act(async () => {
      setup = await renderFixture(
        <ModelRoutePicker onClose={() => {}} dependencies={dependencies} />,
        { width: 80, height: 19 },
      )
    })
    try {
      await React.act(async () => setup.mockInput.pressArrow('down'))
      await React.act(async () => setup.mockInput.pressEnter())
      for (let index = 0; index < 249; index++)
        await React.act(async () => setup.mockInput.pressArrow('down'))
      await setup.renderOnce()
      expect(setup.captureCharFrame()).toContain('p/model-250')
      expect(setup.captureCharFrame()).toContain('250/250')
      await React.act(async () => setup.mockInput.pressEnter())
      await setup.renderOnce()
      expect(setup.captureCharFrame()).toContain('p/model-250')
      expect(setup.captureCharFrame()).toContain('High')
      await React.act(async () => setup.mockInput.pressEnter())
      await setup.renderOnce()
      expect(config.defaultModel).toBe('p/model-250')
      expect(config.defaultReasoningEffort).toBe('high')
      expect(setup.captureCharFrame()).toContain('Saved:')
    } finally {
      await React.act(async () => setup.renderer.destroy())
    }
  },
)

renderTest(
  'history exposes loading/failure/retry, confirms deletion and keeps narrow titles intact',
  async () => {
    const { testRender } = await import('@opentui/react/test-utils')
    let settle: (rows: any[]) => void = () => {}
    let attempts = 0,
      deletes = 0
    const rows = [
      {
        chatId: 'session-one',
        lastPrompt: '👩🏽‍💻 修复 é history title',
        timestamp: new Date(),
        messageCount: 3,
      },
    ]
    const dependencies = {
      load: async () => {
        attempts++
        if (attempts === 1)
          return new Promise<any[]>((resolve) => {
            settle = resolve
          })
        throw new Error('History disk unavailable')
      },
      delete: () => {
        deletes++
        return false
      },
    }
    const setup = await renderFixture(
      <ChatHistoryScreen
        dependencies={dependencies}
        onSelectChat={() => {}}
        onCancel={() => {}}
        onNewChat={() => {}}
      />,
      { width: 60, height: 18 },
    )
    try {
      await setup.renderOnce()
      expect(setup.captureCharFrame()).toContain('Loading saved sessions')
      await React.act(async () => settle(rows))
      await setup.renderOnce()
      expect(setup.captureCharFrame()).toContain('👩🏽‍💻 修复 é')
      await React.act(async () => setup.mockInput.pressKey('d', { ctrl: true }))
      await setup.renderOnce()
      expect(deletes).toBe(0)
      expect(setup.captureCharFrame()).toContain('Delete this saved session?')
      await React.act(async () => {
        setup.mockInput.pressEscape()
        await Bun.sleep(120)
      })
      expect(deletes).toBe(0)
      await React.act(async () => setup.mockInput.pressKey('r', { ctrl: true }))
      await setup.renderOnce()
      expect(setup.captureCharFrame()).toContain('unavailable')
      expect(setup.captureCharFrame()).toContain('Ctrl+R retry')
    } finally {
      await React.act(async () => setup.renderer.destroy())
    }
  },
)

renderTest(
  'plan picker loads asynchronously and exposes the full selected path through details',
  async () => {
    const { testRender } = await import('@opentui/react/test-utils')
    const rows = [
      {
        slug: 'long-plan-name',
        sessionDir: '.agents/sessions/long-plan-name',
        artifacts: ['PLAN.md'],
        status: 'unknown',
        updatedAt: null,
      },
    ] as PlanSessionSummary[]
    const setup = await renderFixture(
      <PlanSessionPickerScreen
        command="resume-plan"
        loadSessions={async () => rows}
        onSelectSession={() => {}}
        onCancel={() => {}}
      />,
      { width: 60, height: 18 },
    )
    try {
      await React.act(async () => Bun.sleep(10))
      await setup.renderOnce()
      expect(setup.captureCharFrame()).toContain('long-plan-name')
      await React.act(async () => setup.mockInput.pressKey('o', { ctrl: true }))
      await setup.renderOnce()
      expect(setup.captureCharFrame()).toContain(
        '.agents/sessions/long-plan-name',
      )
      expect(setup.captureCharFrame()).toContain('Updated: unknown')
    } finally {
      await React.act(async () => setup.renderer.destroy())
    }
  },
)

renderTest(
  'registered agents can create and clear an override while compact write failures stay visible',
  async () => {
    const { testRender } = await import('@opentui/react/test-utils')
    let config: ProviderConfigFileInput = { defaultModel: 'p/default' }
    let failWrite = true
    const dependencies = {
      readConfig: () => structuredClone(config),
      models: () => [{ model: 'p/override' }],
      agents: () => [{ id: 'reviewer' }] as AgentDefinition[],
      writeConfig: (next: ProviderConfigFileInput) => {
        if (failWrite) throw new Error('Disk denied')
        config = structuredClone(next)
        return '/fixture/config'
      },
    }
    const setup = await renderFixture(
      <ModelRoutePicker onClose={() => {}} dependencies={dependencies} />,
      { width: 50, height: 12 },
    )
    try {
      await React.act(async () => setup.mockInput.typeText('agent:reviewer'))
      await React.act(async () => setup.mockInput.pressEnter())
      await React.act(async () => setup.mockInput.pressArrow('down'))
      await React.act(async () => setup.mockInput.pressEnter())
      await React.act(async () => setup.mockInput.pressEnter())
      await setup.renderOnce()
      expect(setup.captureCharFrame()).toContain('Disk denied')
      expect(config.agents).toBeUndefined()
      failWrite = false
      await React.act(async () => setup.mockInput.pressEnter())
      await setup.renderOnce()
      expect(config.agents?.reviewer).toBe('p/override')
      await React.act(async () => setup.mockInput.pressEnter())
      await React.act(async () => setup.mockInput.pressEnter())
      await setup.renderOnce()
      expect(config.agents?.reviewer).toBeUndefined()
      expect(config.defaultModel).toBe('p/default')
      expect(setup.captureCharFrame()).toContain('inherited')
    } finally {
      await React.act(async () => setup.renderer.destroy())
    }
  },
)

renderTest(
  'mouse route/model/reasoning activation shares the keyboard target',
  async () => {
    const { testRender } = await import('@opentui/react/test-utils')
    let config: ProviderConfigFileInput = {
      defaultModel: 'p/old',
      defaultReasoningEffort: 'high',
    }
    const dependencies = {
      readConfig: () => structuredClone(config),
      models: () => [{ model: 'p/new' }],
      agents: () => [] as AgentDefinition[],
      writeConfig: (next: ProviderConfigFileInput) => {
        config = structuredClone(next)
        return '/fixture/config'
      },
    }
    const setup = await renderFixture(
      <ModelRoutePicker onClose={() => {}} dependencies={dependencies} />,
      { width: 80, height: 19 },
    )
    const clickText = async (text: string) => {
      await setup.renderOnce()
      const lines = setup.captureCharFrame().split('\n')
      const row = lines.findIndex((line) => line.includes(text))
      expect(row).toBeGreaterThanOrEqual(0)
      const col = lines[row].indexOf(text)
      await React.act(async () => setup.mockMouse.click(col + 1, row))
      await setup.renderOnce()
    }
    try {
      await clickText('default →')
      await clickText('p/new')
      await clickText('High')
      expect(config.defaultModel).toBe('p/new')
      expect(config.defaultReasoningEffort).toBe('high')
    } finally {
      await React.act(async () => setup.renderer.destroy())
    }
  },
)
