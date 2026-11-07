import { afterEach, expect, test } from 'bun:test'
import React from 'react'
import { AgentBranchWrapper } from '../blocks/agent-branch-wrapper'
import { AgentBlockGrid } from '../blocks/agent-block-grid'
import { SingleBlock } from '../blocks/single-block'
import { MessageWithAgents } from '../message-with-agents'
import { initializeThemeStore } from '../../hooks/use-theme'
import { useChatStore } from '../../state/chat-store'
import { useMessageBlockStore } from '../../state/message-block-store'
import { useOutputReaderStore } from '../../state/output-reader-store'
import { chatThemes, createMarkdownPalette } from '../../utils/theme-system'
import { legacyAgentDescendantDocument } from '../../utils/legacy-agent-document'
import type { ChatMessage } from '../../types/chat'

initializeThemeStore()
afterEach(() => {
  useChatStore.getState().reset()
  useMessageBlockStore.getState().reset()
  useOutputReaderStore.setState({ views: {}, request: null })
})
const nativeTest = process.env.NODE_ENV === 'production' ? test.skip : test

nativeTest(
  'root and nested annotation views retain literal source and disclose exact raw text',
  async () => {
    const { testRender } = await import('@opentui/react/test-utils')
    const source =
      '  <system_note>FOLDED_ANNOTATION</system_note>\n~~~xml\n<system_note>LITERAL_SOURCE</system_note>\n~~~\nVisible answer  '
    const block = { type: 'text' as const, content: source }
    const common = {
      availableWidth: 60,
      markdownPalette: createMarkdownPalette(chatThemes.dark),
      onToggleCollapsed: () => {},
      onBuildFast: () => {},
      onInsertCommand: () => {},
    }
    for (const nested of [false, true]) {
      const node = nested ? (
        <AgentBranchWrapper
          {...common}
          keyPrefix="annotations"
          agentBlock={{
            type: 'agent',
            agentId: 'annotations',
            agentName: 'Captured agent',
            agentType: 'fixture',
            status: 'complete',
            content: '',
            isCollapsed: false,
            blocks: [block],
          }}
        />
      ) : (
        <SingleBlock
          {...common}
          block={block}
          idx={0}
          messageId="annotations"
          isLoading={false}
          isComplete
          isUser={false}
          textColor="#ffffff"
        />
      )
      const setup = await testRender(node, { width: 60, height: 24 })
      try {
        await setup.renderOnce()
        const lines = setup.captureCharFrame().split('\n')
        expect(lines.join('\n')).toContain('LITERAL_SOURCE')
        expect(lines.join('\n')).not.toContain('FOLDED_ANNOTATION')
        const row = lines.findIndex((line) =>
          line.includes('Annotations folded'),
        )
        expect(row).toBeGreaterThanOrEqual(0)
        await React.act(async () =>
          setup.mockMouse.click(
            lines[row].indexOf('Annotations folded') + 1,
            row,
          ),
        )
        expect(useOutputReaderStore.getState().request?.document?.text).toBe(
          source,
        )
      } finally {
        await React.act(async () => setup.renderer.destroy())
        useOutputReaderStore.getState().close()
      }
    }
  },
)

nativeTest(
  'one throwing agent preserves its sibling and recovers with the same identity',
  async () => {
    const { testRender } = await import('@opentui/react/test-utils')
    let broken = true
    const source = ['failed', 'healthy'].map((id) => ({
      type: 'agent' as const,
      agentId: id,
      agentName: id,
      agentType: 'fixture',
      status: 'complete' as const,
      content: `RETAINED_${id}`,
    }))
    const setup = await testRender(
      <AgentBlockGrid
        keyPrefix="grid"
        availableWidth={60}
        agentBlocks={source}
        renderAgentBranch={(block) => {
          if (block.agentId === 'failed' && broken)
            throw new Error('agent view fixture failure')
          return <text>{block.content}</text>
        }}
      />,
      { width: 60, height: 18 },
    )
    const click = async (label: string) => {
      await setup.renderOnce()
      const lines = setup.captureCharFrame().split('\n')
      const row = lines.findIndex((line) => line.includes(label))
      expect(row).toBeGreaterThanOrEqual(0)
      await React.act(async () =>
        setup.mockMouse.click(lines[row].indexOf(label) + 1, row),
      )
    }
    try {
      await setup.renderOnce()
      expect(setup.captureCharFrame()).toContain('RETAINED_healthy')
      expect(setup.captureCharFrame()).toContain(
        'Could not render agent failed',
      )
      await click('Inspect retained source')
      expect(useOutputReaderStore.getState().request?.document?.text).toContain(
        'RETAINED_failed',
      )
      useOutputReaderStore.getState().close()
      broken = false
      await click('Retry view')
      await setup.renderOnce()
      expect(setup.captureCharFrame()).toContain('RETAINED_failed')
      expect(setup.captureCharFrame()).toContain('RETAINED_healthy')
      expect(source[0].content).toBe('RETAINED_failed')
    } finally {
      await React.act(async () => setup.renderer.destroy())
    }
  },
)

nativeTest(
  'nested image metadata and diagnostic blocks remain rendered through shared block handling',
  async () => {
    const { testRender } = await import('@opentui/react/test-utils')
    const setup = await testRender(
      <AgentBranchWrapper
        keyPrefix="nested-fixture"
        availableWidth={60}
        markdownPalette={createMarkdownPalette(chatThemes.dark)}
        onToggleCollapsed={() => {}}
        onBuildFast={() => {}}
        onInsertCommand={() => {}}
        agentBlock={{
          type: 'agent',
          agentId: 'nested',
          agentName: 'Nested verifier',
          agentType: 'fixture',
          status: 'complete',
          content: '',
          isCollapsed: false,
          blocks: [
            {
              type: 'image',
              image: '',
              mediaType: 'image/png',
              filename: 'nested-evidence.png',
              imageRedacted: true,
            },
            {
              type: 'doctor',
              projectRoot: '/captured/project',
              agentsTrusted: false,
              skillsTrusted: false,
              skillCount: 0,
              mcpCount: 0,
              providerStatus: 'Captured provider status',
              diagnostics: [{ message: 'NESTED_STRUCTURED_DIAGNOSTIC' }],
            },
          ],
        }}
      />,
      { width: 60, height: 40 },
    )
    try {
      await setup.renderOnce()
      expect(setup.captureCharFrame()).toContain('nested-evidence.png')
      expect(setup.captureCharFrame()).toContain('Inspect captured image')
      expect(setup.captureCharFrame()).toContain('NESTED_STRUCTURED_DIAGNOSTIC')
    } finally {
      await React.act(async () => setup.renderer.destroy())
    }
  },
)

nativeTest(
  'legacy collapsed failures keep an error and inspector visible',
  async () => {
    const { testRender } = await import('@opentui/react/test-utils')
    useMessageBlockStore.getState().setContext({
      theme: chatThemes.dark,
      markdownPalette: createMarkdownPalette(chatThemes.dark),
    })
    const message: ChatMessage = {
      id: 'legacy-failed',
      variant: 'agent',
      content: 'last retained output',
      timestamp: '',
      userError: 'RETAINED_AGENT_FAILURE',
      metadata: { isCollapsed: true },
      agent: {
        agentName: 'Legacy verifier',
        agentType: 'fixture',
        responseCount: 1,
      },
    }
    const setup = await testRender(
      <MessageWithAgents
        message={message}
        depth={0}
        isLastMessage={false}
        availableWidth={60}
      />,
      { width: 60, height: 18 },
    )
    try {
      await setup.renderOnce()
      const frame = setup.captureCharFrame()
      expect(frame).toContain('Error captured')
      expect(frame).toContain('RETAINED_AGENT_FAILURE')
      expect(frame).toContain('Inspect captured agent')
    } finally {
      await React.act(async () => setup.renderer.destroy())
    }
  },
)

test('depth inspector preserves descendant identity and stops circular legacy trees', () => {
  const first: ChatMessage = {
    id: 'first',
    variant: 'agent',
    content: 'retained first',
    timestamp: '',
    agent: { agentName: 'First', agentType: 'fixture', responseCount: 1 },
  }
  const second: ChatMessage = {
    id: 'second',
    variant: 'agent',
    content: 'retained second',
    timestamp: '',
    userError: 'deep failure',
    agent: { agentName: 'Second', agentType: 'fixture', responseCount: 1 },
  }
  const document = legacyAgentDescendantDocument(
    [first],
    new Map([
      ['first', [second]],
      ['second', [first]],
    ]),
  )
  expect(document.rowCount).toBe(2)
  expect(document.row?.(1)?.value).toBe(second)
  expect(document.detail?.(1)?.text).toContain('deep failure')
  expect(document.notice).toContain('no new inference')
})
