import { expect, test } from 'bun:test'
import React from 'react'
import { PlanSessionPickerScreen } from '../plan-session-picker-screen'
import { initializeThemeStore } from '../../hooks/use-theme'
import type { PlanSessionCatalog } from '../../commands/plan-artifacts'

initializeThemeStore()
const renderTest = process.env.NODE_ENV === 'production' ? test.skip : test
renderTest(
  'a partial plan catalog stays selectable and exposes the skipped-row warning',
  async () => {
    const { testRender } = await import('@opentui/react/test-utils')
    const rows: PlanSessionCatalog = [
      {
        slug: 'retained-plan',
        sessionDir: '.agents/sessions/retained-plan',
        absSessionDir: '/owned/.agents/sessions/retained-plan',
        artifacts: ['PLAN.md'],
        status: 'unknown',
        currentTask: null,
        updatedAt: null,
        progress: { done: 0, total: 1 },
        isActive: false,
      },
    ]
    rows.partial = true
    rows.skipped = 1
    let selected = ''
    let setup!: Awaited<ReturnType<typeof testRender>>
    await React.act(async () => {
      setup = await testRender(
        <PlanSessionPickerScreen
          command="resume-plan"
          loadSessions={async () => rows}
          onSelectSession={(session) => {
            selected = session
          }}
          onCancel={() => {}}
        />,
        { width: 100, height: 22 },
      )
    })
    try {
      await React.act(async () => Bun.sleep(10))
      await setup.renderOnce()
      const frame = setup.captureCharFrame()
      expect(frame).toContain('retained-plan')
      expect(frame).toContain('Plan sessions partial: skipped 1')
      await React.act(async () => setup.mockInput.pressEnter())
      expect(selected).toBe('.agents/sessions/retained-plan')
    } finally {
      await React.act(async () => setup.renderer.destroy())
    }
  },
)
