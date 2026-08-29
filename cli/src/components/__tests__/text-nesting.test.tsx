import { describe, expect, test } from 'bun:test'
import { Glob } from 'bun'
import path from 'node:path'
import React from 'react'
import ts from 'typescript'

import { initializeThemeStore } from '../../hooks/use-theme'
import { chatThemes, createMarkdownPalette } from '../../utils/theme-system'
import { BlocksRenderer } from '../blocks/blocks-renderer'
import { CompletionSummaryBox } from '../renderers/completion-summary-box'
import { DoctorBox } from '../renderers/doctor-box'
import { IndexStatusBox } from '../renderers/index-status-box'
import { InfoBox } from '../renderers/info-box'
import { MemoryBox } from '../renderers/memory-box'
import { PlanStatusBox } from '../renderers/plan-status-box'

import type { PlanSessionSummary } from '../../commands/plan-artifacts'
import type {
  ContentBlock,
  DoctorContentBlock,
  IndexStatusContentBlock,
  InfoContentBlock,
  MemoryContentBlock,
  PlanStatusContentBlock,
} from '../../types/chat'

initializeThemeStore()

/**
 * Regression tests for the blank-screen bug.
 *
 * OpenTUI's `TextNodeRenderable.add()` only accepts strings, TextNodeRenderable
 * instances and StyledText, so putting a `<text>` (or any other block element)
 * inside a `<text>` throws during commit. `@opentui/react`'s `createRoot` wraps
 * the app in a single root error boundary, so that throw takes down the WHOLE
 * tree: in a production build the terminal goes blank — no message list, no
 * status line, no input bar. And because the offending block is persisted to
 * chat-messages.json, reopening the session re-renders it and blanks the screen
 * again, which is why the failure looked permanent.
 *
 * `renderToStaticMarkup` (used by the per-renderer tests) cannot catch this:
 * react-dom happily nests the tags. Only the real OpenTUI reconciler rejects
 * them, so these tests go through `testRender`.
 */

// The inline elements OpenTUI maps onto TextNodeRenderable; everything else is
// a block renderable and throws when nested inside a <text>.
const INLINE_TEXT_ELEMENTS = new Set([
  'span',
  'b',
  'i',
  'u',
  'strong',
  'em',
  'br',
  'a',
])

const tagNameOf = (node: ts.Node, source: ts.SourceFile): string | null => {
  if (ts.isJsxElement(node)) return node.openingElement.tagName.getText(source)
  if (ts.isJsxSelfClosingElement(node)) return node.tagName.getText(source)
  return null
}

/** `<box>`/`<text>`/... nested inside a `<text>`, as `file:line <tag>` strings. */
const findBlockElementsInsideText = (
  code: string,
  fileName: string,
): string[] => {
  const source = ts.createSourceFile(
    fileName,
    code,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    ts.ScriptKind.TSX,
  )
  const violations: string[] = []

  const walk = (node: ts.Node, insideText: boolean) => {
    const tag = tagNameOf(node, source)
    // Only intrinsic (lowercase) tags can be resolved statically; a component
    // element's own JSX is checked when that component's file is visited.
    const isIntrinsic = tag !== null && /^[a-z]/.test(tag)

    if (insideText && isIntrinsic && !INLINE_TEXT_ELEMENTS.has(tag)) {
      const { line } = source.getLineAndCharacterOfPosition(
        node.getStart(source),
      )
      violations.push(`${fileName}:${line + 1} <${tag}> inside <text>`)
    }

    if (ts.isJsxElement(node)) {
      // Attributes are evaluated outside the element's own text context, so a
      // `title={<box/>}`-style prop is not a nesting violation.
      walk(node.openingElement, insideText)
      const childContext = insideText || tag === 'text'
      for (const child of node.children) walk(child, childContext)
      return
    }

    node.forEachChild((child) => walk(child, insideText))
  }

  walk(source, false)
  return violations
}

describe('no block elements nested inside <text>', () => {
  test('every cli/src component tree keeps <text> children inline', async () => {
    const srcRoot = path.resolve(import.meta.dir, '../..')
    const glob = new Glob('**/*.tsx')
    const violations: string[] = []

    for await (const relativePath of glob.scan({ cwd: srcRoot })) {
      const code = await Bun.file(path.join(srcRoot, relativePath)).text()
      if (!code.includes('<text')) continue
      violations.push(...findBlockElementsInsideText(code, relativePath))
    }

    expect(violations).toEqual([])
  })
})

/**
 * `@opentui/react/test-utils` imports `act` from react, which the production
 * build does not export, so anything going through the real reconciler cannot
 * even be imported under `NODE_ENV=production` — which is how this package's
 * `bun run test` script invokes bun test. The static guard above needs no
 * reconciler and keeps running there, so the nesting defect itself stays covered
 * in a production run; these tests are the dev-run confirmation that the guard's
 * rule is the one OpenTUI actually enforces. Same convention as
 * agent-branch-overflow.test.tsx.
 */
const renderTest = process.env.NODE_ENV === 'production' ? test.skip : test

const renderFrame = async (node: React.ReactNode): Promise<string> => {
  const { testRender } = await import('@opentui/react/test-utils')
  const setup = await testRender(
    <box style={{ flexDirection: 'column', width: 100 }}>{node}</box>,
    { width: 100, height: 40 },
  )
  await setup.renderOnce()
  const frame: string = setup.captureCharFrame()
  setup.renderer.destroy()
  return frame
}

/**
 * Asserts the renderer survived commit: the root error boundary's fallback
 * (which in a dev build paints the stack trace and in a production build paints
 * nothing at all) replaces the frame, so a live frame is one that still shows
 * the renderer's own content and carries no OpenTUI throw.
 */
const expectRendered = (frame: string, expectedContent: string[]) => {
  expect(frame).not.toContain('TextNodeRenderable')
  for (const content of expectedContent) expect(frame).toContain(content)
}

const makeSession = (
  overrides: Partial<PlanSessionSummary> = {},
): PlanSessionSummary => ({
  slug: 'alpha',
  sessionDir: '.agents/sessions/alpha',
  absSessionDir: '/tmp/.agents/sessions/alpha',
  artifacts: ['PLAN.md'],
  status: 'active',
  currentTask: 'task one',
  updatedAt: '2024-01-01T00:00:00.000Z',
  progress: { done: 1, total: 3 },
  isActive: true,
  ...overrides,
})

describe('harness box renderers survive the real OpenTUI reconciler', () => {
  renderTest('CompletionSummaryBox renders every populated row', async () => {
    const frame = await renderFrame(
      <CompletionSummaryBox
        block={{
          type: 'completion-summary',
          summary: {
            filesEdited: 3,
            filesFailed: 0,
            filesUnconfirmed: 0,
            filesRolledBack: 0,
            rollbackIncomplete: 0,
            reviewVerdict: 'LOOKS_GOOD',
            testPassed: 2,
            testFailed: 0,
            hooksPassed: 1,
            hooksFailed: 0,
            hooksSkipped: 0,
            auxiliaryCompleted: 1,
            auxiliaryFailed: 0,
            errors: 1,
          },
        }}
      />,
    )

    expectRendered(frame, [
      '3 files edited',
      'Hooks: 1 passed',
      'Reviewed:',
      'LOOKS_GOOD',
      'Tests: 2 passed',
      'auxiliary agent',
      '1 error',
    ])
  })

  renderTest('DoctorBox renders its label/value rows', async () => {
    const block: DoctorContentBlock = {
      type: 'doctor',
      projectRoot: '/repo/project',
      agentsTrusted: true,
      skillsTrusted: false,
      skillCount: 3,
      mcpCount: 2,
      diagnostics: [{ filePath: 'src/a.ts', message: 'missing export' }],
      providerStatus: 'Provider: openai',
    }
    const frame = await renderFrame(<DoctorBox block={block} />)

    expectRendered(frame, [
      'Project root:',
      '/repo/project',
      'Project agents:',
      'Loaded MCP servers:',
    ])
  })

  renderTest('IndexStatusBox renders its label/value rows', async () => {
    const block: IndexStatusContentBlock = {
      type: 'index-status',
      statusLine: 'Index status: ready.',
      messageLine: 'Index ready.',
      corpusLine: '42 indexed files.',
      ageLine: '1m',
      vectorLine: 'ready',
      hintLine: 'Run /index to refresh.',
      lines: ['Index status: ready.'],
    }
    const frame = await renderFrame(<IndexStatusBox block={block} />)

    expectRendered(frame, ['Corpus:', '42 indexed files.', 'Age:', 'Vector:'])
  })

  renderTest('InfoBox renders its label/value rows', async () => {
    const block: InfoContentBlock = {
      type: 'info',
      version: '1.2.3',
      workspace: '/tmp/workspace',
    }
    const frame = await renderFrame(<InfoBox block={block} />)

    expectRendered(frame, [
      'Version:',
      '1.2.3',
      'Workspace:',
      'Local/BYOK Mode',
    ])
  })

  renderTest('MemoryBox renders the status counters', async () => {
    const block: MemoryContentBlock = {
      type: 'memory',
      state: 'status',
      revision: 7,
      updatedAt: Date.now() - 45_000,
      goal: 'Build a cool feature',
      goalPreview: 'Build a cool feature',
      isGoalTruncated: false,
      counts: {
        decisions: 1,
        requirements: 2,
        editsMade: 3,
        validationResults: 4,
        blockers: 5,
        nextActions: 6,
      },
      evidence: { fresh: 3, stale: 1, total: 4 },
      stalePaths: ['src/old.ts'],
      totalStaleCount: 1,
    }
    const frame = await renderFrame(<MemoryBox block={block} />)

    expectRendered(frame, [
      'Decisions: 1',
      'Requirements: 2',
      'Validations: 4',
      'Evidence:',
      '3 fresh',
      '1 stale',
    ])
  })

  renderTest(
    'PlanStatusBox renders session rows and badge-carrying report lines',
    async () => {
      // Both fixtures carry the field set the real `/plans` and `/plan-status`
      // blocks carry, so the rendered shape here is the persisted one.
      const listBlock: PlanStatusContentBlock = {
        type: 'plan-status-list',
        mode: 'list',
        reportText: '',
        sessions: [makeSession()],
        isStatusReport: false,
      }
      const listFrame = await renderFrame(<PlanStatusBox block={listBlock} />)
      expectRendered(listFrame, ['alpha 1/3 done', 'current: "task one"'])

      const reportBlock: PlanStatusContentBlock = {
        type: 'plan-status',
        mode: 'status',
        reportText: 'session alpha [active] 1/3 done\n  current: task one',
        isStatusReport: true,
      }
      const reportFrame = await renderFrame(
        <PlanStatusBox block={reportBlock} />,
      )
      expectRendered(reportFrame, ['session alpha', '[active]', '1/3 done'])
    },
  )
})

/**
 * Defense in depth for the same failure. The static guard above and the
 * per-renderer tests only cover nestings that exist today; a future one — or any
 * other throw while rendering a persisted block — must not be able to blank the
 * whole app again, because the block is replayed from chat-messages.json every
 * time the session is reopened.
 */
describe('a block whose render throws does not blank the app', () => {
  /**
   * The exact defect that caused the bug: a `<text>` nested inside a `<text>`.
   * Built with `createElement` rather than JSX so the static guard above — which
   * scans every `.tsx` under `cli/src`, this file included — does not flag this
   * deliberate violation.
   */
  const throwingBlock: ContentBlock = {
    type: 'html',
    render: () =>
      React.createElement(
        'text',
        { style: { wrapMode: 'word' } },
        React.createElement('text', null, 'nested block element'),
      ),
  }

  const renderTranscript = (blocks: ContentBlock[]): React.ReactNode => (
    <box style={{ flexDirection: 'column' }}>
      <text>STATUS LINE ABOVE</text>
      <BlocksRenderer
        sourceBlocks={blocks}
        messageId="msg-1"
        isLoading={false}
        isComplete
        isUser={false}
        textColor={chatThemes.dark.foreground}
        availableWidth={100}
        markdownPalette={createMarkdownPalette(chatThemes.dark)}
        onToggleCollapsed={() => {}}
        onBuildFast={() => {}}
        onInsertCommand={() => {}}
      />
      <text>INPUT BAR BELOW</text>
    </box>
  )

  renderTest(
    'the surrounding UI and the sibling blocks still render',
    async () => {
      const frame = await renderFrame(
        renderTranscript([
          { type: 'text', content: 'first good block' },
          throwingBlock,
          { type: 'text', content: 'last good block' },
        ]),
      )

      // The app chrome survives — this is the blank screen the user reported.
      expect(frame).toContain('STATUS LINE ABOVE')
      expect(frame).toContain('INPUT BAR BELOW')
      // So do the throwing block's siblings, before and after it.
      expect(frame).toContain('first good block')
      expect(frame).toContain('last good block')
      // Only the bad block is replaced, and it says so instead of rendering blank.
      expect(frame).toContain('Could not render this html block.')
    },
  )

  renderTest(
    'a control transcript of the same shape renders the block normally',
    async () => {
      // Without this the assertions above could pass on a BlocksRenderer that
      // renders nothing at all for every block it is given.
      const frame = await renderFrame(
        renderTranscript([
          { type: 'text', content: 'first good block' },
          {
            type: 'html',
            render: () => <text>inner html content</text>,
          },
          { type: 'text', content: 'last good block' },
        ]),
      )

      expect(frame).toContain('inner html content')
      expect(frame).not.toContain('Could not render')
    },
  )
})
