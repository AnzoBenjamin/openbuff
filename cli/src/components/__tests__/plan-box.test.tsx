import { beforeEach, describe, expect, mock, test } from 'bun:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { computeTerminalLayout } from '../../hooks/use-terminal-layout'
import { renderMarkdown } from '../../utils/markdown-renderer'
import { chatThemes, createMarkdownPalette } from '../../utils/theme-system'

type CapturedButton = {
  text: string
  onClick?: (event?: unknown) => void | Promise<unknown>
}

const capturedButtons: CapturedButton[] = []

const textFromReactNode = (node: React.ReactNode): string => {
  if (typeof node === 'string' || typeof node === 'number') {
    return String(node)
  }

  if (Array.isArray(node)) {
    return node.map(textFromReactNode).join('')
  }

  if (React.isValidElement<{ children?: React.ReactNode }>(node)) {
    return textFromReactNode(node.props.children)
  }

  return ''
}

mock.module('../button', () => ({
  Button: ({
    children,
    onClick,
    ...rest
  }: {
    children?: React.ReactNode
    onClick?: (event?: unknown) => void | Promise<unknown>
    [key: string]: unknown
  }) => {
    capturedButtons.push({ text: textFromReactNode(children), onClick })

    return React.createElement('box', rest, children)
  },
}))

mock.module('../../hooks/use-terminal-layout', () => ({
  computeTerminalLayout,
  useTerminalLayout: () => computeTerminalLayout(80, 24),
}))

mock.module('../../hooks/use-theme', () => ({
  useTheme: () => chatThemes.dark,
  initializeThemeStore: () => {},
}))

const { PlanBox } = await import('../renderers/plan-box')

const theme = chatThemes.dark
const markdownPalette = createMarkdownPalette(theme)

describe('PlanBox', () => {
  beforeEach(() => {
    capturedButtons.length = 0
  })

  test('renders markdown plan content and execute action', () => {
    const markup = renderToStaticMarkup(
      <PlanBox
        // Template literal: a JSX string attribute would pass a literal \n and
        // never reach the markdown renderer as a newline.
        planContent={`# Build Plan

- Ship it`}
        availableWidth={80}
        markdownPalette={markdownPalette}
        onBuildFast={() => {}}
      />,
    )

    expect(markup).toContain('Build Plan')
    expect(markup).toContain('Ship it')
    expect(markup).toContain('Execute Plan')
    // The heading really went through the markdown renderer.
    expect(markup).toContain(markdownPalette.headingFg[1])
    expect(markup).not.toContain('# Build Plan')
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

  test('renders custom artifact commands as clickable buttons', () => {
    const onInsertCommand = mock(() => {})
    const commands = [
      '/review-design .agents/sessions/demo',
      '/validate-tests .agents/sessions/demo',
    ]
    const markup = renderToStaticMarkup(
      <PlanBox
        planContent="Plan body"
        metadata={{
          customArtifactCommands: commands,
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

    // The mocked Button captures every rendered button, including the build-mode
    // actions, so select the command buttons by their text.
    const commandButtons = capturedButtons.filter((button) =>
      commands.includes(button.text),
    )
    expect(commandButtons.length).toBe(2)

    for (const button of commandButtons) {
      button.onClick?.()
    }

    expect(onInsertCommand).toHaveBeenCalledWith(
      '/review-design .agents/sessions/demo',
    )
    expect(onInsertCommand).toHaveBeenCalledWith(
      '/validate-tests .agents/sessions/demo',
    )
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

  test('clamps the markdown code block width to the 10-column minimum for narrow layouts', () => {
    // The clamp under test: PlanBox passes Math.max(10, availableWidth - 8).
    const MIN_CODE_BLOCK_WIDTH = 10
    const NARROW_AVAILABLE_WIDTH = 0
    const UNCLAMPED_WIDTH = NARROW_AVAILABLE_WIDTH - 8
    // Template literal so the fence reaches the markdown renderer as a real
    // code block instead of a single raw text line.
    const codeSource = `\`\`\`ts
const ok = true
\`\`\``
    // Every rendered code segment carries the code background, so counting them
    // measures how many wrapped rows the chosen width produced without
    // depending on where markdown-renderer breaks the line.
    const countCodeSegments = (html: string): number =>
      html.split(markdownPalette.codeBackground).length - 1
    const renderAtWidth = (codeBlockWidth: number): string =>
      renderToStaticMarkup(
        <text>
          {renderMarkdown(codeSource, {
            codeBlockWidth,
            palette: markdownPalette,
          })}
        </text>,
      )

    const markup = renderToStaticMarkup(
      <PlanBox
        planContent={codeSource}
        availableWidth={NARROW_AVAILABLE_WIDTH}
        markdownPalette={markdownPalette}
        onBuildFast={() => {}}
      />,
    )

    // A code block was rendered: language header + code background styling.
    expect(markup).toContain('// ts')
    expect(markup).toContain(markdownPalette.codeBackground)
    expect(markup).not.toContain('```')

    // Without the clamp the width would be -8, which the wrapper floors to a
    // single column and fragments into one segment per character. PlanBox must
    // instead render exactly what an explicit 10-column render produces.
    const clampedSegments = countCodeSegments(
      renderAtWidth(MIN_CODE_BLOCK_WIDTH),
    )
    const unclampedSegments = countCodeSegments(renderAtWidth(UNCLAMPED_WIDTH))

    expect(countCodeSegments(markup)).toBe(clampedSegments)
    expect(clampedSegments).toBeLessThan(unclampedSegments)
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
          customArtifactCommands: [
            '',
            '/valid-command .agents/sessions/demo',
            '',
          ],
        }}
        availableWidth={80}
        markdownPalette={markdownPalette}
        onBuildFast={() => {}}
      />,
    )

    expect(markup).toContain('/valid-command .agents/sessions/demo')
    expect(markup).toContain('Artifacts')
    // Only the single non-empty command became a button. Without the filter the
    // two '' entries would render two extra empty-text command buttons, so this
    // count is what pins the filtering behaviour.
    const commandButtons = capturedButtons.filter((button) =>
      button.text.startsWith('/'),
    )
    expect(commandButtons.length).toBe(1)
    expect(
      capturedButtons.some((button) => button.text.trim().length === 0),
    ).toBe(false)
  })

  test('renders every repeated command and artifact path (keys stay unique via index suffix)', () => {
    // Repeats are intentionally not collapsed: rows and command buttons are
    // keyed by `${value}-${index}`, so duplicates stay uniquely keyed and every
    // supplied entry remains visible. Key uniqueness itself is not observable
    // through renderToStaticMarkup (colliding React keys only warn), so this
    // asserts the visible consequence.
    const markup = renderToStaticMarkup(
      <PlanBox
        planContent="Plan body"
        metadata={{
          customArtifacts: [
            { label: 'DUP.md', path: '.agents/sessions/demo/DUP.md' },
            { label: 'DUP.md', path: '.agents/sessions/demo/DUP.md' },
          ],
          executeCommand: '/mode:execute_plan Go!',
          customArtifactCommands: [
            '/mode:execute_plan Go!',
            '/review-design .agents/sessions/demo',
            '/review-design .agents/sessions/demo',
          ],
        }}
        availableWidth={80}
        markdownPalette={markdownPalette}
        onBuildFast={() => {}}
      />,
    )

    const countIn = (needle: string): number => markup.split(needle).length - 1

    expect(countIn('DUP.md: .agents/sessions/demo/DUP.md')).toBe(2)
    // The known executeCommand plus the identical custom command entry.
    expect(countIn('/mode:execute_plan Go!')).toBe(2)
    expect(countIn('/review-design .agents/sessions/demo')).toBe(2)
    // Both duplicate commands are real, independently clickable buttons.
    expect(
      capturedButtons.filter(
        (button) => button.text === '/review-design .agents/sessions/demo',
      ).length,
    ).toBe(2)
  })

  test('drops empty artifact paths and commands while keeping the Artifacts section', () => {
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
    // Every supplied command ('' executeCommand, ['', '   '] custom commands)
    // was dropped, so no command button was rendered.
    expect(
      capturedButtons.filter((button) => button.text.startsWith('/')).length,
    ).toBe(0)
    expect(
      capturedButtons.some((button) => button.text.trim().length === 0),
    ).toBe(false)
    // The build-mode 'Execute Plan' button is still captured, so the zero count
    // above is a real absence rather than a broken capture.
    expect(
      capturedButtons.some((button) => button.text === 'Execute Plan'),
    ).toBe(true)
  })
})
