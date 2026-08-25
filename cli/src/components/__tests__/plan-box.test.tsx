import { describe, expect, mock, test } from 'bun:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { initializeThemeStore } from '../../hooks/use-theme'
import { computeTerminalLayout } from '../../hooks/use-terminal-layout'
import { chatThemes, createMarkdownPalette } from '../../utils/theme-system'

mock.module('../../hooks/use-terminal-layout', () => ({
  computeTerminalLayout,
  useTerminalLayout: () => computeTerminalLayout(80, 24),
}))

mock.module('../../hooks/use-theme', () => ({
  useTheme: () => chatThemes.dark,
  initializeThemeStore: () => {},
}))

const { PlanBox } = await import('../renderers/plan-box')

initializeThemeStore()

const theme = chatThemes.dark
const markdownPalette = createMarkdownPalette(theme)

describe('PlanBox', () => {
  test('renders markdown plan content and execute action', () => {
    const markup = renderToStaticMarkup(
      <PlanBox
        planContent="# Build Plan\n\n- Ship it"
        availableWidth={80}
        markdownPalette={markdownPalette}
        onBuildFast={() => {}}
      />,
    )

    expect(markup).toContain('Build Plan')
    expect(markup).toContain('Ship it')
    expect(markup).toContain('Execute Plan')
  })

  test('renders artifact metadata and commands when present', () => {
    const markup = renderToStaticMarkup(
      <PlanBox
        planContent="Plan body"
        metadata={{
          sessionPath: '.agents/sessions/demo',
          specPath: '.agents/sessions/demo/SPEC.md',
          planPath: '.agents/sessions/demo/PLAN.md',
          statusPath: '.agents/sessions/demo/STATUS.md',
          lessonsPath: '.agents/sessions/demo/LESSONS.md',
          executeCommand: '/mode:execute_plan Build it!',
          resumeCommand: '/resume-plan .agents/sessions/demo',
          updateCommand: '/update-plan .agents/sessions/demo',
          statusCommand: '/plan-status .agents/sessions/demo',
          lessonsCommand: '/lessons .agents/sessions/demo',
        }}
        availableWidth={80}
        markdownPalette={markdownPalette}
        onBuildFast={() => {}}
      />,
    )

    expect(markup).toContain('Artifacts')
    expect(markup).toContain('Session: .agents/sessions/demo')
    expect(markup).toContain('SPEC.md: .agents/sessions/demo/SPEC.md')
    expect(markup).toContain('/mode:execute_plan Build it!')
    expect(markup).toContain('/lessons .agents/sessions/demo')
  })

  test('renders custom artifacts as readable label: path list', () => {
    const markup = renderToStaticMarkup(
      <PlanBox
        planContent="Plan body"
        metadata={{
          customArtifacts: [
            { label: 'DESIGN.md', path: '.agents/sessions/demo/DESIGN.md' },
            {
              label: 'Test Results',
              path: '.agents/sessions/demo/test-results.json',
            },
          ],
        }}
        availableWidth={80}
        markdownPalette={markdownPalette}
        onBuildFast={() => {}}
      />,
    )

    expect(markup).toContain('Artifacts')
    expect(markup).toContain('DESIGN.md: .agents/sessions/demo/DESIGN.md')
    expect(markup).toContain(
      'Test Results: .agents/sessions/demo/test-results.json',
    )
  })

  test('renders custom artifact commands as clickable buttons', async () => {
    const onInsertCommand = mock(() => {})
    const markup = renderToStaticMarkup(
      <PlanBox
        planContent="Plan body"
        metadata={{
          customArtifactCommands: [
            '/review-design .agents/sessions/demo',
            '/validate-tests .agents/sessions/demo',
          ],
        }}
        availableWidth={80}
        markdownPalette={markdownPalette}
        onBuildFast={() => {}}
        onInsertCommand={onInsertCommand}
      />,
    )

    // Both custom artifact commands appear in the rendered output
    expect(markup).toContain('/review-design .agents/sessions/demo')
    expect(markup).toContain('/validate-tests .agents/sessions/demo')

    // Verify onInsertCommand wiring by invoking the PlanBox function and simulating Button clicks
    const { Button } = await import('../button')
    const inner = (PlanBox as unknown as { type?: (...args: unknown[]) => unknown }).type ?? PlanBox
    const tree = (inner as (props: unknown) => unknown)({
      planContent: 'Plan body',
      metadata: {
        customArtifactCommands: [
          '/review-design .agents/sessions/demo',
          '/validate-tests .agents/sessions/demo',
        ],
      },
      availableWidth: 80,
      markdownPalette,
      onBuildFast: () => {},
      onInsertCommand,
    })
    const buttons: Array<{ onClick?: () => void }> = []
    const traverse = (node: unknown): void => {
      if (!node || typeof node !== 'object') return
      if (Array.isArray(node)) {
        node.forEach(traverse)
        return
      }
      const el = node as { type?: unknown; props?: { children?: unknown; onClick?: () => void } }
      if (el.type === Button && el.props?.onClick) {
        buttons.push(el.props as { onClick: () => void })
      }
      if (el.props?.children) traverse(el.props.children)
    }
    traverse(tree)
    expect(buttons.length).toBe(2)
    buttons[0].onClick?.()
    expect(onInsertCommand).toHaveBeenCalledWith('/review-design .agents/sessions/demo')
    buttons[1].onClick?.()
    expect(onInsertCommand).toHaveBeenCalledWith('/validate-tests .agents/sessions/demo')
    expect(onInsertCommand).toHaveBeenCalledTimes(2)
  })

  test('renders known artifact paths and commands together with custom artifacts', () => {
    const markup = renderToStaticMarkup(
      <PlanBox
        planContent="Plan body"
        metadata={{
          sessionPath: '.agents/sessions/demo',
          planPath: '.agents/sessions/demo/PLAN.md',
          customArtifacts: [
            { label: 'DESIGN.md', path: '.agents/sessions/demo/DESIGN.md' },
          ],
          executeCommand: '/mode:execute_plan Go!',
          customArtifactCommands: ['/review-design .agents/sessions/demo'],
        }}
        availableWidth={80}
        markdownPalette={markdownPalette}
        onBuildFast={() => {}}
      />,
    )

    // Known artifact paths render as static text
    expect(markup).toContain('Session: .agents/sessions/demo')
    expect(markup).toContain('PLAN.md: .agents/sessions/demo/PLAN.md')
    // Custom artifact label: path renders as static text
    expect(markup).toContain('DESIGN.md: .agents/sessions/demo/DESIGN.md')
    // Both known and custom commands render in the output
    expect(markup).toContain('/mode:execute_plan Go!')
    expect(markup).toContain('/review-design .agents/sessions/demo')
  })

  test('works without onInsertCommand prop (defaults to noop)', () => {
    const markup = renderToStaticMarkup(
      <PlanBox
        planContent="Plan body"
        metadata={{
          executeCommand: '/mode:execute_plan Go!',
        }}
        availableWidth={80}
        markdownPalette={markdownPalette}
        onBuildFast={() => {}}
      />,
    )

    // Command still renders even without onInsertCommand prop
    expect(markup).toContain('/mode:execute_plan Go!')
    expect(markup).toContain('Execute Plan')
  })

  test('shows Artifacts section when only commands are present (no artifact paths)', () => {
    const markup = renderToStaticMarkup(
      <PlanBox
        planContent="Plan body"
        metadata={{
          executeCommand: '/mode:execute_plan Go!',
        }}
        availableWidth={80}
        markdownPalette={markdownPalette}
        onBuildFast={() => {}}
      />,
    )

    expect(markup).toContain('Artifacts')
    expect(markup).toContain('/mode:execute_plan Go!')
  })

  test('shows Artifacts section when only artifact paths are present (no commands)', () => {
    const markup = renderToStaticMarkup(
      <PlanBox
        planContent="Plan body"
        metadata={{
          sessionPath: '.agents/sessions/demo',
          specPath: '.agents/sessions/demo/SPEC.md',
        }}
        availableWidth={80}
        markdownPalette={markdownPalette}
        onBuildFast={() => {}}
      />,
    )

    expect(markup).toContain('Artifacts')
    expect(markup).toContain('Session: .agents/sessions/demo')
    expect(markup).toContain('SPEC.md: .agents/sessions/demo/SPEC.md')
  })

  test('omits artifact section for empty metadata', () => {
    const markup = renderToStaticMarkup(
      <PlanBox
        planContent="Plan body"
        metadata={{}}
        availableWidth={80}
        markdownPalette={markdownPalette}
        onBuildFast={() => {}}
      />,
    )

    expect(markup).not.toContain('Artifacts')
    expect(markup).toContain('Execute Plan')
  })

  test('uses minimum markdown code block width for narrow layouts', () => {
    const markup = renderToStaticMarkup(
      <PlanBox
        planContent="```ts\nconst ok = true\n```"
        availableWidth={0}
        markdownPalette={markdownPalette}
        onBuildFast={() => {}}
      />,
    )

    expect(markup).toContain('const')
    expect(markup).toContain('ok')
    expect(markup).toContain('true')
  })

  test('filters out customArtifacts with empty label', () => {
    const markup = renderToStaticMarkup(
      <PlanBox
        planContent="Plan body"
        metadata={{
          sessionPath: '.agents/sessions/demo',
          customArtifacts: [
            { label: '', path: '.agents/sessions/demo/EMPTY.md' },
            { label: 'VALID.md', path: '.agents/sessions/demo/VALID.md' },
          ],
        }}
        availableWidth={80}
        markdownPalette={markdownPalette}
        onBuildFast={() => {}}
      />,
    )

    expect(markup).toContain('VALID.md: .agents/sessions/demo/VALID.md')
    expect(markup).not.toContain('EMPTY.md')
    expect(markup).toContain('Session: .agents/sessions/demo')
  })

  test('filters out customArtifacts with empty path', () => {
    const markup = renderToStaticMarkup(
      <PlanBox
        planContent="Plan body"
        metadata={{
          customArtifacts: [
            { label: 'ORPHAN.md', path: '' },
            { label: 'KEEP.md', path: '.agents/sessions/demo/KEEP.md' },
          ],
        }}
        availableWidth={80}
        markdownPalette={markdownPalette}
        onBuildFast={() => {}}
      />,
    )

    expect(markup).toContain('KEEP.md: .agents/sessions/demo/KEEP.md')
    expect(markup).not.toContain('ORPHAN.md')
  })

  test('filters out customArtifacts with whitespace-only label or path', () => {
    const markup = renderToStaticMarkup(
      <PlanBox
        planContent="Plan body"
        metadata={{
          customArtifacts: [
            { label: '   ', path: '.agents/sessions/demo/WS1.md' },
            { label: 'WS2.md', path: '   ' },
            { label: 'REAL.md', path: '.agents/sessions/demo/REAL.md' },
          ],
        }}
        availableWidth={80}
        markdownPalette={markdownPalette}
        onBuildFast={() => {}}
      />,
    )

    expect(markup).toContain('REAL.md: .agents/sessions/demo/REAL.md')
    expect(markup).not.toContain('WS1.md')
    expect(markup).not.toContain('WS2.md')
  })

  test('omits artifact section when all customArtifacts are empty', () => {
    const markup = renderToStaticMarkup(
      <PlanBox
        planContent="Plan body"
        metadata={{
          customArtifacts: [
            { label: '', path: '' },
            { label: ' ', path: ' ' },
          ],
        }}
        availableWidth={80}
        markdownPalette={markdownPalette}
        onBuildFast={() => {}}
      />,
    )

    expect(markup).not.toContain('Artifacts')
  })

  test('filters empty strings from customArtifactCommands', () => {
    const markup = renderToStaticMarkup(
      <PlanBox
        planContent="Plan body"
        metadata={{
          customArtifactCommands: ['', '/valid-command .agents/sessions/demo', ''],
        }}
        availableWidth={80}
        markdownPalette={markdownPalette}
        onBuildFast={() => {}}
      />,
    )

    expect(markup).toContain('/valid-command .agents/sessions/demo')
    expect(markup).toContain('Artifacts')
  })

  test('renders duplicate custom artifact commands without key collision (both appear)', () => {
    const markup = renderToStaticMarkup(
      <PlanBox
        planContent="Plan body"
        metadata={{
          customArtifactCommands: [
            '/review-design .agents/sessions/demo',
            '/review-design .agents/sessions/demo',
          ],
        }}
        availableWidth={80}
        markdownPalette={markdownPalette}
        onBuildFast={() => {}}
      />,
    )

    const occurrences = (markup.match(/\/review-design \.agents\/sessions\/demo/g) ?? []).length
    expect(occurrences).toBe(2)
  })

  test('renders duplicate artifact paths without key collision (both appear)', () => {
    const markup = renderToStaticMarkup(
      <PlanBox
        planContent="Plan body"
        metadata={{
          customArtifacts: [
            { label: 'DUP.md', path: '.agents/sessions/demo/DUP.md' },
            { label: 'DUP.md', path: '.agents/sessions/demo/DUP.md' },
          ],
        }}
        availableWidth={80}
        markdownPalette={markdownPalette}
        onBuildFast={() => {}}
      />,
    )

    const occurrences = (markup.match(/DUP\.md: \.agents\/sessions\/demo\/DUP\.md/g) ?? []).length
    expect(occurrences).toBe(2)
  })

  test('renders duplicate known and custom commands together (key collision safe)', () => {
    const markup = renderToStaticMarkup(
      <PlanBox
        planContent="Plan body"
        metadata={{
          executeCommand: '/mode:execute_plan Go!',
          customArtifactCommands: ['/mode:execute_plan Go!'],
        }}
        availableWidth={80}
        markdownPalette={markdownPalette}
        onBuildFast={() => {}}
      />,
    )

    const occurrences = (markup.match(/\/mode:execute_plan Go!/g) ?? []).length
    expect(occurrences).toBe(2)
  })

  test('formatArtifactRows and formatCommandRows omits empty entries end-to-end', () => {
    const markup = renderToStaticMarkup(
      <PlanBox
        planContent="Plan body"
        metadata={{
          sessionPath: '.agents/sessions/demo',
          specPath: '',
          customArtifacts: [{ label: '', path: '' }],
          executeCommand: '',
          customArtifactCommands: ['', '   '],
        }}
        availableWidth={80}
        markdownPalette={markdownPalette}
        onBuildFast={() => {}}
      />,
    )

    expect(markup).toContain('Session: .agents/sessions/demo')
    expect(markup).not.toContain('SPEC.md')
    expect(markup).toContain('Artifacts')
  })
})
