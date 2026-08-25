import { describe, expect, test } from 'bun:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { initializeThemeStore } from '../../hooks/use-theme'
import { chatThemes } from '../../utils/theme-system'
import { DoctorBox } from '../renderers/doctor-box'

import type { DoctorContentBlock } from '../../types/chat'

initializeThemeStore()

const theme = chatThemes.dark

const makeBlock = (overrides: Partial<DoctorContentBlock> = {}): DoctorContentBlock => ({
  type: 'doctor',
  projectRoot: '/repo/project',
  agentsTrusted: true,
  skillsTrusted: false,
  skillCount: 3,
  mcpCount: 2,
  diagnostics: [
    { filePath: 'src/a.ts', message: 'missing export' },
    { agentId: 'agent-1', message: 'agent failed' },
  ],
  providerStatus: 'Provider: openai\nStatus: ok',
  ...overrides,
})

describe('DoctorBox', () => {
  test('smoke renders title Doctor and key lines with theme tokens', () => {
    const markup = renderToStaticMarkup(<DoctorBox block={makeBlock()} />)

    expect(markup).toContain('Doctor')
    expect(markup).toContain('Project root:')
    expect(markup).toContain('/repo/project')
    expect(markup).toContain('Project agents:')
    expect(markup).toContain('trusted and enabled')
    expect(markup).toContain('Project skills:')
    expect(markup).toContain('Loaded skills:')
    expect(markup).toContain('3')
    expect(markup).toContain('Loaded MCP servers:')
    expect(markup).toContain('2')
    expect(markup).toContain('Agent diagnostics:')
    expect(markup).toContain(theme.secondary)
  })

  test('shows disabled badge when agents not trusted with warning color', () => {
    const markup = renderToStaticMarkup(<DoctorBox block={makeBlock({ agentsTrusted: false })} />)
    expect(markup).toContain('disabled (use --trust-project-agents to enable)')
    expect(markup).toContain(theme.warning)
  })

  test('shows skills disabled badge with warning when not trusted', () => {
    const markup = renderToStaticMarkup(<DoctorBox block={makeBlock({ skillsTrusted: false })} />)
    expect(markup).toContain('disabled with project-agent trust policy')
    expect(markup).toContain(theme.warning)
  })

  test('shows success color when trusted', () => {
    const markup = renderToStaticMarkup(
      <DoctorBox block={makeBlock({ agentsTrusted: true, skillsTrusted: true })} />,
    )
    expect(markup).toContain(theme.success)
  })

  test('renders diagnostics capped at 10 and provider lines', () => {
    const manyDiagnostics = Array.from({ length: 15 }, (_, i) => ({
      filePath: `src/file-${i}.ts`,
      message: `err ${i}`,
    }))
    const markup = renderToStaticMarkup(<DoctorBox block={makeBlock({ diagnostics: manyDiagnostics })} />)
    expect(markup).toContain('src/file-0.ts: err 0')
    expect(markup).toContain('src/file-9.ts: err 9')
    expect(markup).not.toContain('src/file-10.ts: err 10')
    expect(markup).toContain('Provider: openai')
    expect(markup).toContain(theme.muted)
  })

  test('handles zero diagnostics and empty providerStatus', () => {
    const markup = renderToStaticMarkup(
      <DoctorBox block={makeBlock({ diagnostics: [], providerStatus: '' })} />,
    )
    expect(markup).toContain('Doctor')
    expect(markup).toContain('Agent diagnostics:')
    expect(markup).toContain('0')
  })

  test('handles boundary counts zero', () => {
    const markup = renderToStaticMarkup(<DoctorBox block={makeBlock({ skillCount: 0, mcpCount: 0 })} />)
    expect(markup).toContain('Loaded skills:')
    expect(markup).toContain('Loaded MCP servers:')
  })
})
