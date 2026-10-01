import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { chatThemes, createMarkdownPalette } from '../../utils/theme-system'

import type { TerminalLayout } from '../../hooks/use-terminal-layout'

type CapturedButton = {
  text: string
  onClick?: (event?: unknown) => void | Promise<unknown>
}

// bun's mock.module is registry-wide for the whole test process (afterAll
// mock.restore does not undo it), so capture the REAL modules before any
// mock.module registration. The `?real` query bypasses the registry so a
// previously leaked mock cannot shadow the real module.
const realLayoutModule = (await import(
  '../../hooks/use-terminal-layout?real' as string
)) as unknown as typeof import('../../hooks/use-terminal-layout')

const realButtonModule = (await import(
  '../button?real' as string
)) as unknown as typeof import('../button')

const realThemeModule = (await import(
  '../../hooks/use-theme?real' as string
)) as unknown as typeof import('../../hooks/use-theme')

const realSyntaxStyleModule = (await import(
  '../../utils/opentui-syntax-style?real' as string
)) as unknown as typeof import('../../utils/opentui-syntax-style')

const realTreeSitterModule = (await import(
  '../../utils/tree-sitter-client?real' as string
)) as unknown as typeof import('../../utils/tree-sitter-client')

const { computeTerminalLayout } = realLayoutModule

// Allow per-test override of the terminal layout; when unset, fall through to
// the fixed 80x24 layout this suite's assertions were written against. The
// mock is registry-wide, so resetting mockLayout keeps a stale layout from
// leaking to later files in the same process.
let mockLayout: TerminalLayout | undefined

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
  // Real exports first: the registry-wide mock must not drop real exports
  // for later files importing this module in the same process.
  ...realButtonModule,
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
  // Real exports first (registry-wide leak guard); the fixed 80x24 override
  // below must keep winning for this suite's assertions.
  ...realLayoutModule,
  useTerminalLayout: () => mockLayout ?? computeTerminalLayout(80, 24),
}))

mock.module('../../hooks/use-theme', () => ({
  // Real exports first so useThemeStore and other real exports survive for
  // later files; these overrides must keep winning.
  ...realThemeModule,
  useTheme: () => chatThemes.dark,
  initializeThemeStore: () => {},
}))

// PlanBox routes markdown content through ContentWithMarkdown, whose native
// setup collaborators are mocked here so plan degradation can be forced
// (mirroring content-with-markdown.test.tsx). Declared before the dynamic
// import below so the mock factory closes over the variable.
let syntaxStyleSetupError: Error | null = null

mock.module('../../utils/opentui-syntax-style', () => ({
  // Real exports first so createCodeSyntaxStyle and friends survive for
  // later files; the throwing stub below must keep winning.
  ...realSyntaxStyleModule,
  createMarkdownSyntaxStyle: () => {
    if (syntaxStyleSetupError) {
      throw syntaxStyleSetupError
    }
    return '__stub-syntax-style__'
  },
}))

mock.module('../../utils/tree-sitter-client', () => ({
  // Real exports first so buildDefaultParsers and friends survive for later
  // files; the stub below must keep winning.
  ...realTreeSitterModule,
  getSharedTreeSitterClient: () => '__stub-tree-sitter-client__',
}))

const { PlanBox } = await import('../renderers/plan-box')

const theme = chatThemes.dark
const markdownPalette = createMarkdownPalette(theme)

describe('PlanBox', () => {
  beforeEach(() => {
    capturedButtons.length = 0
    syntaxStyleSetupError = null
  })

  // Fall through to the real hook: the registry-wide mock survives this
  // file, so a stale layout must never leak to sibling files.
  afterAll(() => {
    mockLayout = undefined
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
    // The plan content renders through the native <markdown> renderable.
    // react-dom/server serializes the content prop verbatim into the element
    // attribute, so the raw source text (including the heading marker) is
    // present in static markup; the native renderer conceals it at render
    // time, which static markup cannot observe.
    expect(markup).toContain('<markdown')
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

  test('renders markdown plan content through the native <markdown> element', () => {
    // Markdown syntax (a heading) is required so hasMarkdown() routes the
    // content through the native renderable rather than the plain-text path.
    const markup = renderToStaticMarkup(
      <PlanBox
        planContent="## Plan body"
        availableWidth={80}
        markdownPalette={markdownPalette}
        onBuildFast={() => {}}
      />,
    )

    // Markdown content renders inside the native renderable, not a legacy
    // span pipeline.
    expect(markup).toContain('<markdown')
    expect(markup).toContain('Plan body')
  })

  test('renders fenced code content through the native <markdown> element', () => {
    // Template literal so the fence reaches the component as a real
    // multi-line code block instead of a single raw text line.
    const codeSource = `\`\`\`ts
const ok = true
\`\`\``
    const markup = renderToStaticMarkup(
      <PlanBox
        planContent={codeSource}
        availableWidth={80}
        markdownPalette={markdownPalette}
        onBuildFast={() => {}}
      />,
    )

    // A code block was rendered through the native renderable. react-dom/
    // server serializes the content prop verbatim (fence markers included),
    // so only the presence of the native element and the code source is
    // observable here; concealment happens at native render time.
    expect(markup).toContain('<markdown')
    expect(markup).toContain('const ok = true')
  })

  test('degrades markdown plan content to plain text when native setup throws', () => {
    syntaxStyleSetupError = new Error('syntax style setup failed')

    const markup = renderToStaticMarkup(
      <PlanBox
        planContent="## Plan body"
        availableWidth={80}
        markdownPalette={markdownPalette}
        onBuildFast={() => {}}
      />,
    )

    // Degrade-to-plain-text contract inherited from ContentWithMarkdown: the
    // raw source text reaches the plain-text path and no native element is
    // rendered.
    expect(markup).toContain('Plan body')
    expect(markup).not.toContain('<markdown')
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
