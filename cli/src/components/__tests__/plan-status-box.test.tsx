import { describe, expect, test } from 'bun:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { initializeThemeStore } from '../../hooks/use-theme'
import { chatThemes } from '../../utils/theme-system'
import { PlanStatusBox } from '../renderers/plan-status-box'

import type { PlanStatusContentBlock } from '../../types/chat'

initializeThemeStore()

const theme = chatThemes.dark

const makeStatusBlock = (overrides: Partial<PlanStatusContentBlock> = {}): PlanStatusContentBlock => ({
  type: 'plan-status',
  mode: 'status',
  reportText: 'Plan status header\n[active] my-plan 1/3 done\n  current: "task one"',
  isStatusReport: true,
  ...overrides,
})

const makeListBlock = (overrides: Partial<PlanStatusContentBlock> = {}): PlanStatusContentBlock => ({
  type: 'plan-status-list',
  mode: 'list',
  reportText: '',
  isStatusReport: false,
  sessions: [
    {
      slug: 'alpha',
      sessionDir: '.agents/sessions/alpha',
      absSessionDir: '/tmp/.agents/sessions/alpha',
      artifacts: ['PLAN.md'],
      status: 'active',
      currentTask: 'task one',
      updatedAt: new Date().toISOString(),
      progress: { done: 1, total: 3 },
      isActive: true,
    },
    {
      slug: 'beta',
      sessionDir: '.agents/sessions/beta',
      absSessionDir: '/tmp/.agents/sessions/beta',
      artifacts: ['SPEC.md'],
      status: 'paused',
      currentTask: null,
      updatedAt: new Date().toISOString(),
      progress: { done: 0, total: 0 },
      isActive: false,
    },
  ],
  ...overrides,
})

describe('PlanStatusBox', () => {
  test('smoke renders status mode title Plan status and key lines with theme tokens', () => {
    const markup = renderToStaticMarkup(<PlanStatusBox block={makeStatusBlock()} />)

    expect(markup).toContain('Plan status')
    expect(markup).toContain('Plan status header')
    expect(markup).toContain('[active]')
    expect(markup).toContain(theme.foreground)
  })

  test('status mode renders current task with muted color', () => {
    const markup = renderToStaticMarkup(<PlanStatusBox block={makeStatusBlock()} />)
    expect(markup).toContain('current:')
    expect(markup).toContain(theme.muted)
  })

  test('smoke renders list mode title Plan sessions and sessions', () => {
    const markup = renderToStaticMarkup(<PlanStatusBox block={makeListBlock()} />)

    expect(markup).toContain('Plan sessions')
    expect(markup).toContain('alpha')
    expect(markup).toContain('[active]')
    expect(markup).toContain('1/3 done')
    expect(markup).toContain('current: "task one"')
    expect(markup).toContain('beta')
    expect(markup).toContain('[paused]')
  })

  test('list mode uses badge colors success/warning and muted for current', () => {
    const markup = renderToStaticMarkup(<PlanStatusBox block={makeListBlock()} />)
    expect(markup).toContain(theme.success)
    expect(markup).toContain(theme.warning)
    expect(markup).toContain(theme.muted)
  })

  test('list mode active marker for active session', () => {
    const markup = renderToStaticMarkup(<PlanStatusBox block={makeListBlock()} />)
    expect(markup).toContain('*')
  })

  test('handles empty sessions list still renders title', () => {
    const markup = renderToStaticMarkup(<PlanStatusBox block={makeListBlock({ sessions: [] })} />)
    expect(markup).toContain('Plan sessions')
  })

  test('handles empty reportText boundary', () => {
    const markup = renderToStaticMarkup(<PlanStatusBox block={makeStatusBlock({ reportText: '' })} />)
    expect(markup).toContain('Plan status')
  })

  test('list mode completed and archived badges use secondary/muted', () => {
    const markup = renderToStaticMarkup(
      <PlanStatusBox
        block={makeListBlock({
          sessions: [
            {
              slug: 'gamma',
              sessionDir: '.agents/sessions/gamma',
              absSessionDir: '/tmp/.agents/sessions/gamma',
              artifacts: [],
              status: 'completed',
              currentTask: null,
              updatedAt: new Date().toISOString(),
              progress: { done: 2, total: 2 },
              isActive: false,
            },
            {
              slug: 'delta',
              sessionDir: '.agents/sessions/delta',
              absSessionDir: '/tmp/.agents/sessions/delta',
              artifacts: [],
              status: 'archived',
              currentTask: null,
              updatedAt: new Date().toISOString(),
              progress: { done: 0, total: 1 },
              isActive: false,
            },
          ],
        })}
      />,
    )
    expect(markup).toContain('[completed]')
    expect(markup).toContain('[archived]')
    expect(markup).toContain(theme.secondary)
    expect(markup).toContain(theme.muted)
  })
})
