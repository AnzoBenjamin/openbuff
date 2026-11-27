import { expect, test } from 'bun:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { initializeThemeStore } from '../../../hooks/use-theme'
import { chatThemes } from '../../../utils/theme-system'
import { SpawnAgentsComponent } from '../spawn-agents'
import type { ToolBlock } from '../types'

initializeThemeStore()
const options = { availableWidth: 100, indentationOffset: 0, labelWidth: 0 }
const launch = { agentId: 'child-b', agentName: 'Researcher', agentType: 'researcher', value: { background: true, jobId: 'job-real-42', message: 'Agent launched in background. Poll progress with check_background_agent.' } }
const completed = { agentId: 'child-a', agentName: 'Reviewer', agentType: 'reviewer', value: { verdict: 'BLOCKING', summary: 'missing regression' }, agentReceipt: { status: 'completed' } }
function block(reports: unknown[]): ToolBlock & { toolName: 'spawn_agents' } {
  return { type: 'tool', toolName: 'spawn_agents', toolCallId: 'spawn-repair', lifecycle: 'succeeded', input: { agents: reports.map(() => ({ agent_type: 'requested' })) }, outputRaw: [{ type: 'json', value: reports }] }
}
function Card({ reports }: { reports: unknown[] }) {
  return SpawnAgentsComponent.render(block(reports), chatThemes.dark, options).content as React.ReactElement
}
test('production background launch shows its job ID without claiming child completion; mixed foreground verdict stays blocking', () => {
  const launched = renderToStaticMarkup(<Card reports={[launch]} />)
  expect(launched).toContain('Agents launched (1)')
  expect(launched).toContain('job-real-42')
  expect(launched).not.toContain('Agents completed')
  const mixed = renderToStaticMarkup(<Card reports={[completed, launch]} />)
  expect(mixed).toContain('Agent results (2)')
  expect(mixed).toContain('missing regression')
  expect(mixed).toContain('✗')
  expect(mixed).toContain('researcher')
  expect(mixed).toContain('job-real-42')
  expect(mixed).not.toContain('Agents completed')
  expect(renderToStaticMarkup(<Card reports={[completed]} />)).toContain('Agents completed (1)')
})
test('scheduling reasons stay beside their original requested entry when earlier reports are absent or lack reasons', () => {
  const reports = [undefined, { ...completed, schedulingReasons: ['second request capability', '', null] }, { ...completed, schedulingReasons: ['third request context'] }]
  const Render = () => {
    const tool = block(reports)
    tool.input = { agents: [{ agent_type: 'first' }, { agent_type: 'reviewer@requested-2' }, { agent_type: 'reviewer@requested-3' }] }
    return SpawnAgentsComponent.render(tool, chatThemes.dark, options).content as React.ReactElement
  }
  const markup = renderToStaticMarkup(<Render />)
  expect(markup).toContain('request 2 · reviewer@requested-2: second request capability')
  expect(markup).toContain('request 3 · reviewer@requested-3: third request context')
  expect(markup).not.toContain('request 1 · first:')
  expect(markup.indexOf('second request capability')).toBeLessThan(markup.indexOf('third request context'))
  const missingFirstReasons = renderToStaticMarkup(<Card reports={[completed, { ...completed, schedulingReasons: ['later-only reason'] }]} />)
  expect(missingFirstReasons).toContain('request 2 · requested: later-only reason')
})
const nativeTest = process.env.NODE_ENV === 'production' ? test.skip : test
nativeTest('native scheduling line names its original requested position at 60 columns', async () => {
  const { testRender } = await import('@opentui/react/test-utils')
  const setup = await testRender(<Card reports={[completed, { ...completed, schedulingReasons: ['native second reason'] }]} />, { width: 60, height: 18 })
  try {
    await setup.renderOnce()
    const frame = setup.captureCharFrame()
    expect(frame).toContain('request 2 · requested: native second reason')
    expect(frame).not.toContain('request 1 · requested:')
  } finally {
    await React.act(async () => setup.renderer.destroy())
  }
})
nativeTest('native background launch retains job identity at narrow width', async () => {
  const { testRender } = await import('@opentui/react/test-utils')
  const setup = await testRender(<Card reports={[launch]} />, { width: 60, height: 18 })
  try {
    await setup.renderOnce()
    const frame = setup.captureCharFrame()
    expect(frame).toContain('Agents launched')
    expect(frame).toContain('job-real-42')
    expect(frame).not.toContain('Agents completed')
  } finally {
    await React.act(async () => setup.renderer.destroy())
  }
})
