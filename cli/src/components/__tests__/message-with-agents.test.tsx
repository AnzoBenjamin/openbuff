import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from 'bun:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { enableMapSet } from 'immer'

import { initializeThemeStore } from '../../hooks/use-theme'
import { useChatStore } from '../../state/chat-store'
import { useMessageBlockStore } from '../../state/message-block-store'
import { chatThemes, createMarkdownPalette } from '../../utils/theme-system'

import type { ChatMessage } from '../../types/chat'
import type { TerminalLayout } from '../../hooks/use-terminal-layout'
import type { MarkdownPalette } from '../../utils/markdown-renderer'

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

const realSyntaxStyleModule = (await import(
  '../../utils/opentui-syntax-style?real' as string
)) as unknown as typeof import('../../utils/opentui-syntax-style')

const realTreeSitterModule = (await import(
  '../../utils/tree-sitter-client?real' as string
)) as unknown as typeof import('../../utils/tree-sitter-client')

const { computeTerminalLayout } = realLayoutModule

// Allow per-test override of the terminal layout; when unset, the factory
// falls through to the real hook so no stale layout can leak to later files
// in the same process. beforeEach seeds the fixed 80x24 layout this suite's
// assertions were written against; tests that override it keep their
// override.
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

// Armed at module scope (this suite's own tests capture buttons through the
// stub, and there is no beforeEach arming here — same shape as
// treeSitterArmed below); the top-level afterAll below disarms it so the
// registry-wide override delegates to the real Button for later files in
// the same worker.
let buttonArmed = true

mock.module('../button', () => ({
  // Real exports first: the registry-wide mock must not drop real exports
  // for later files importing this module in the same process.
  ...realButtonModule,
  Button: (props: {
    children?: React.ReactNode
    onClick?: (event?: unknown) => void | Promise<unknown>
    [key: string]: unknown
  }) => {
    // Disarmed: render the real Button through createElement — the real
    // export may be a memo/forwardRef-style object, which must not be called
    // as a plain function. realButtonModule is a `?real` query import — a
    // separate module instance this registry-wide mock cannot patch — so
    // the delegation cannot re-enter this override.
    if (!buttonArmed) {
      return React.createElement(
        realButtonModule.Button as unknown as React.ElementType,
        props,
      )
    }

    const { children, onClick, ...rest } = props

    capturedButtons.push({ text: textFromReactNode(children), onClick })

    return React.createElement('box', rest, children)
  },
}))

mock.module('../../hooks/use-terminal-layout', () => ({
  // Real exports first (registry-wide leak guard); the suite default seeded
  // in beforeEach must keep winning for this suite's assertions, and the
  // unset fall-through delegates to the real hook instead of a fixed layout
  // that would survive this file.
  ...realLayoutModule,
  useTerminalLayout: () => mockLayout ?? realLayoutModule.useTerminalLayout(),
}))

// Native-markdown collaborators are mocked so agent-message tests can force
// native setup failures (mirroring content-with-markdown.test.tsx). Declared
// before the dynamic import below so the mock factory closes over it.
let syntaxStyleSetupError: Error | null = null

// Armed at module scope (every agent-message render that reaches native
// markdown needs the stub; there is no beforeEach arming here — same shape
// as treeSitterArmed below); the top-level afterAll below disarms it so the
// registry-wide override delegates to the real module for later files in
// the same worker.
let syntaxStyleArmed = true

mock.module('../../utils/opentui-syntax-style', () => ({
  // Real exports first so createCodeSyntaxStyle and friends survive for
  // later files; the throwing stub below must keep winning while armed.
  ...realSyntaxStyleModule,
  createMarkdownSyntaxStyle: (palette: MarkdownPalette) => {
    if (!syntaxStyleArmed) {
      // Delegate to the `?real` module instance — a separate module object
      // this registry-wide mock cannot patch, so this cannot re-enter the
      // override.
      return realSyntaxStyleModule.createMarkdownSyntaxStyle(palette)
    }
    if (syntaxStyleSetupError) {
      throw syntaxStyleSetupError
    }
    // String marker so the stub is observable as a native element attribute
    // in the static markup below.
    return '__stub-syntax-style__'
  },
}))

// Armed at module scope (every agent-message render that reaches native
// markdown needs the stub); the top-level afterAll below disarms it so the
// registry-wide override delegates to the real module for later files in the
// same worker. bun's --isolate REUSES worker processes across test files, so
// an unconditional stub leaked '__stub-tree-sitter-client__' into
// tree-sitter-client.test.ts's null assertions in CI.
let treeSitterArmed = true

mock.module('../../utils/tree-sitter-client', () => ({
  // Real exports first so buildDefaultParsers and friends survive for later
  // files; the stub below must keep winning while armed.
  ...realTreeSitterModule,
  getSharedTreeSitterClient: () =>
    treeSitterArmed
      ? '__stub-tree-sitter-client__'
      : realTreeSitterModule.getSharedTreeSitterClient(),
}))

const { MessageWithAgents } = await import('../message-with-agents')

enableMapSet()
initializeThemeStore()

const theme = chatThemes.light
const basePalette: MarkdownPalette = createMarkdownPalette(theme)

// -----------------------------------------------------------------------------
// Helper factory functions for creating test messages
// -----------------------------------------------------------------------------

const createUserMessage = (id: string, content: string): ChatMessage => ({
  id,
  variant: 'user',
  content,
  timestamp: new Date().toISOString(),
})

const createAiMessage = (id: string, content: string): ChatMessage => ({
  id,
  variant: 'ai',
  content,
  timestamp: new Date().toISOString(),
})

const createAgentMessage = (
  id: string,
  content: string,
  agentName: string,
  options: Partial<ChatMessage> = {},
): ChatMessage => ({
  id,
  variant: 'agent',
  content,
  timestamp: new Date().toISOString(),
  agent: {
    agentName,
    agentType: 'test-agent',
    responseCount: 1,
  },
  ...options,
})

const createErrorMessage = (id: string, content: string): ChatMessage => ({
  id,
  variant: 'error',
  content,
  timestamp: new Date().toISOString(),
})

// Creates an agent message without the required agent info (for error testing)
const createMalformedAgentMessage = (
  id: string,
  content: string,
): ChatMessage =>
  ({
    id,
    variant: 'agent',
    content,
    timestamp: new Date().toISOString(),
    // Intentionally missing agent property
  }) as ChatMessage

const createModeDividerMessage = (id: string, mode: string): ChatMessage => ({
  id,
  variant: 'ai',
  content: 'this content should be ignored',
  timestamp: new Date().toISOString(),
  blocks: [
    {
      type: 'mode-divider',
      mode,
    },
  ],
})

const defaultCallbacks = {
  onToggleCollapsed: () => {},
  onBuildFast: () => {},
  onFeedback: () => {},
  onCloseFeedback: () => {},
  onEditMessage: () => {},
  onInsertCommand: () => {},
}

const planCommand = '/mode:execute_plan Build it!'

const initializeStore = (
  overrides: {
    messageTree?: Map<string, ChatMessage[]>
    isWaitingForResponse?: boolean
    timerStartTime?: number | null
    availableWidth?: number
  } = {},
) => {
  useMessageBlockStore.setState({
    context: {
      theme,
      markdownPalette: basePalette,
      messageTree: overrides.messageTree ?? new Map<string, ChatMessage[]>(),
      isWaitingForResponse: overrides.isWaitingForResponse ?? false,
      timerStartTime: overrides.timerStartTime ?? null,
      availableWidth: overrides.availableWidth ?? 80,
    },
    callbacks: defaultCallbacks,
  })
}

beforeEach(() => {
  // Suite default: the fixed 80x24 layout these assertions were written
  // against; individual tests may override it.
  mockLayout = computeTerminalLayout(80, 24)
  capturedButtons.length = 0
  syntaxStyleSetupError = null
  initializeStore()
  useChatStore.setState({ streamingAgents: new Set<string>() })
})

// Fall through to the real hook + disarm the stubs: the registry-wide
// mocks survive this file, so neither a stale layout nor the Button /
// syntax-style / tree-sitter stubs must ever leak to sibling files.
afterAll(() => {
  mockLayout = undefined
  treeSitterArmed = false
  syntaxStyleArmed = false
  buttonArmed = false
})

afterEach(() => {
  capturedButtons.length = 0
  useMessageBlockStore.getState().reset()
  useChatStore.setState({ streamingAgents: new Set<string>() })
})

const baseMessageWithAgentsProps = {
  depth: 0,
  isLastMessage: false,
  availableWidth: 80,
}

// =============================================================================
// MessageBlockStore Tests - store behavior, not JS built-ins
// =============================================================================

describe('MessageBlockStore', () => {
  describe('setContext', () => {
    test('performs partial merge, preserving unspecified values', () => {
      // Set initial state with specific values
      initializeStore({
        isWaitingForResponse: true,
        timerStartTime: 12345,
        availableWidth: 100,
      })

      // Update only one value
      useMessageBlockStore.getState().setContext({
        isWaitingForResponse: false,
      })

      const state = useMessageBlockStore.getState()
      // Updated value should change
      expect(state.context.isWaitingForResponse).toBe(false)
      // Other values should be preserved
      expect(state.context.timerStartTime).toBe(12345)
      expect(state.context.availableWidth).toBe(100)
      expect(state.context.theme).toBe(theme)
    })

    test('updates messageTree without affecting other context values', () => {
      const child1 = createAgentMessage('child-1', 'Content 1', 'Agent One')
      const child2 = createAgentMessage('child-2', 'Content 2', 'Agent Two')
      const newTree = new Map<string, ChatMessage[]>([
        ['parent-1', [child1, child2]],
      ])

      useMessageBlockStore.getState().setContext({
        messageTree: newTree,
      })

      const state = useMessageBlockStore.getState()
      expect(state.context.messageTree).toBe(newTree)
      expect(state.context.messageTree?.get('parent-1')).toHaveLength(2)
      // Theme should be unchanged
      expect(state.context.theme).toBe(theme)
    })

    test('can update multiple context values at once', () => {
      useMessageBlockStore.getState().setContext({
        isWaitingForResponse: true,
        timerStartTime: 99999,
        availableWidth: 200,
      })

      const state = useMessageBlockStore.getState()
      expect(state.context.isWaitingForResponse).toBe(true)
      expect(state.context.timerStartTime).toBe(99999)
      expect(state.context.availableWidth).toBe(200)
    })
  })

  describe('setCallbacks', () => {
    test('replaces entire callbacks object', () => {
      const mockToggle = () => {}
      const mockBuildFast = () => {}
      const mockFeedback = () => {}
      const mockCloseFeedback = () => {}
      const mockInsertCommand = () => {}

      useMessageBlockStore.getState().setCallbacks({
        onToggleCollapsed: mockToggle,
        onBuildFast: mockBuildFast,
        onFeedback: mockFeedback,
        onCloseFeedback: mockCloseFeedback,
        onEditMessage: () => {},
        onInsertCommand: mockInsertCommand,
      })

      const state = useMessageBlockStore.getState()
      expect(state.callbacks.onToggleCollapsed).toBe(mockToggle)
      expect(state.callbacks.onBuildFast).toBe(mockBuildFast)
      expect(state.callbacks.onFeedback).toBe(mockFeedback)
      expect(state.callbacks.onCloseFeedback).toBe(mockCloseFeedback)
      expect(state.callbacks.onInsertCommand).toBe(mockInsertCommand)
    })

    test('onInsertCommand callback receives the command string', () => {
      let insertedCommand: string | undefined
      const mockInsertCommand = (command: string) => {
        insertedCommand = command
      }

      useMessageBlockStore.getState().setCallbacks({
        ...defaultCallbacks,
        onInsertCommand: mockInsertCommand,
      })

      const storedCallback =
        useMessageBlockStore.getState().callbacks.onInsertCommand
      storedCallback('/mode:execute_plan Build it!')

      expect(insertedCommand).toBe('/mode:execute_plan Build it!')
    })

    test('callbacks are independent from context', () => {
      const originalTheme = useMessageBlockStore.getState().context.theme

      useMessageBlockStore.getState().setCallbacks({
        ...defaultCallbacks,
        onToggleCollapsed: () => console.log('new toggle'),
      })

      // Context should be unchanged
      expect(useMessageBlockStore.getState().context.theme).toBe(originalTheme)
    })
  })

  describe('reset', () => {
    test('restores context to initial state', () => {
      // Modify state significantly
      useMessageBlockStore.getState().setContext({
        isWaitingForResponse: true,
        timerStartTime: 12345,
        availableWidth: 200,
        messageTree: new Map([['key', [createAgentMessage('a', 'b', 'c')]]]),
      })

      useMessageBlockStore.getState().reset()

      const state = useMessageBlockStore.getState()
      expect(state.context.theme).toBeNull()
      expect(state.context.isWaitingForResponse).toBe(false)
      expect(state.context.timerStartTime).toBeNull()
      expect(state.context.availableWidth).toBe(80)
    })

    test('restores callbacks to noop functions', () => {
      const mockFn = () => console.log('test')
      useMessageBlockStore.getState().setCallbacks({
        onToggleCollapsed: mockFn,
        onBuildFast: mockFn,
        onFeedback: mockFn,
        onCloseFeedback: mockFn,
        onEditMessage: () => {},
        onInsertCommand: () => {},
      })

      useMessageBlockStore.getState().reset()

      const state = useMessageBlockStore.getState()
      // Callbacks should be noop functions (not undefined)
      expect(typeof state.callbacks.onToggleCollapsed).toBe('function')
      expect(typeof state.callbacks.onBuildFast).toBe('function')
      expect(typeof state.callbacks.onInsertCommand).toBe('function')
      // They should not throw when called
      expect(() => state.callbacks.onToggleCollapsed('test-id')).not.toThrow()
      expect(() =>
        state.callbacks.onInsertCommand('test-command'),
      ).not.toThrow()
    })
  })
})

// =============================================================================
// MessageWithAgents Component Tests - behavior across variants
// =============================================================================

describe('MessageWithAgents', () => {
  describe('message variant rendering', () => {
    test('renders user message content', () => {
      const message = createUserMessage('user-1', 'Hello from user')

      const markup = renderToStaticMarkup(
        <MessageWithAgents {...baseMessageWithAgentsProps} message={message} />,
      )

      expect(markup).toContain('Hello from user')
    })

    test('renders AI message content', () => {
      const message = createAiMessage('ai-1', 'Hello from AI')

      const markup = renderToStaticMarkup(
        <MessageWithAgents {...baseMessageWithAgentsProps} message={message} />,
      )

      expect(markup).toContain('Hello from AI')
    })

    test('renders error message content', () => {
      const message = createErrorMessage('error-1', 'An error occurred')

      const markup = renderToStaticMarkup(
        <MessageWithAgents {...baseMessageWithAgentsProps} message={message} />,
      )

      expect(markup).toContain('An error occurred')
    })

    test('renders agent message with agent name displayed', () => {
      const message = createAgentMessage(
        'agent-1',
        'Agent response',
        'Code Searcher',
      )

      const markup = renderToStaticMarkup(
        <MessageWithAgents {...baseMessageWithAgentsProps} message={message} />,
      )

      expect(markup).toContain('Code Searcher')
      expect(markup).toContain('Agent response')
    })

    test('handles message with markdown content', () => {
      const message = createAiMessage('ai-md', '**Bold** and *italic*')

      const markup = renderToStaticMarkup(
        <MessageWithAgents {...baseMessageWithAgentsProps} message={message} />,
      )

      // Content should be present (markdown rendering may transform it)
      expect(markup).toContain('Bold')
      expect(markup).toContain('italic')
    })

    test('handles empty content without crashing', () => {
      const message = createAiMessage('ai-empty', '')

      const markup = renderToStaticMarkup(
        <MessageWithAgents {...baseMessageWithAgentsProps} message={message} />,
      )

      expect(markup).toBeDefined()
    })
  })

  describe('long user message collapse behavior', () => {
    // A user message with more than MAX_COLLAPSED_LINES (3) lines should be
    // rendered collapsed-by-default with a "Show more" toggle.
    const longUserContent = Array.from(
      { length: 10 },
      (_, i) => `Line ${i + 1}`,
    ).join('\n')

    test('renders a "Show more" toggle for a long complete user message', () => {
      const message: ChatMessage = {
        ...createUserMessage('user-long', longUserContent),
        isComplete: true,
      }

      const markup = renderToStaticMarkup(
        <MessageWithAgents {...baseMessageWithAgentsProps} message={message} />,
      )

      expect(markup).toContain('Show more')
      // Collapsed preview shows only the first few lines plus the truncation marker.
      expect(markup).toContain('Line 1')
      expect(markup).toContain('Line 2')
      expect(markup).toContain('Line 3')
      // Lines beyond the threshold are hidden while collapsed.
      expect(markup).not.toContain('Line 10')
    })

    test('does not collapse a short user message', () => {
      const message: ChatMessage = {
        ...createUserMessage('user-short', 'just one line'),
        isComplete: true,
      }

      const markup = renderToStaticMarkup(
        <MessageWithAgents {...baseMessageWithAgentsProps} message={message} />,
      )

      expect(markup).not.toContain('Show more')
      expect(markup).not.toContain('Show less')
      expect(markup).toContain('just one line')
    })

    test('does not collapse a long AI message (collapse is user-only)', () => {
      const message: ChatMessage = {
        ...createAiMessage('ai-long', longUserContent),
        isComplete: true,
      }

      const markup = renderToStaticMarkup(
        <MessageWithAgents {...baseMessageWithAgentsProps} message={message} />,
      )

      expect(markup).not.toContain('Show more')
      expect(markup).toContain('Line 10')
    })

    test('does not collapse an incomplete (streaming) long user message', () => {
      // An incomplete user message (isComplete: false) is still streaming and
      // should not be collapsed.
      const message: ChatMessage = {
        ...createUserMessage('user-incomplete', longUserContent),
        isComplete: false,
      }

      const markup = renderToStaticMarkup(
        <MessageWithAgents
          {...baseMessageWithAgentsProps}
          message={message}
          isLastMessage={true}
        />,
      )

      // While incomplete, all lines render and no toggle appears.
      expect(markup).not.toContain('Show more')
      expect(markup).toContain('Line 10')
    })
  })

  describe('mode divider block rendering', () => {
    test('renders ModeDivider when message contains only a mode-divider block and ignores content', () => {
      const message = createModeDividerMessage('mode-1', 'Edit Mode')

      const markup = renderToStaticMarkup(
        <MessageWithAgents {...baseMessageWithAgentsProps} message={message} />,
      )

      // Mode text should appear
      expect(markup).toContain('Edit Mode')
      // Original message content should not be rendered
      expect(markup).not.toContain('this content should be ignored')
    })
  })

  describe('error handling', () => {
    test('shows error message when agent message is missing agent info', () => {
      const malformedMessage = createMalformedAgentMessage(
        'bad-agent',
        'This should fail',
      )

      const markup = renderToStaticMarkup(
        <MessageWithAgents
          {...baseMessageWithAgentsProps}
          message={malformedMessage}
        />,
      )

      expect(markup).toContain('Error')
      expect(markup).toContain('Missing agent info')
    })
  })

  describe('collapsed vs expanded agent state', () => {
    test('renders collapsed agent with preview and collapsed indicator', () => {
      const collapsedMessage = createAgentMessage(
        'collapsed-agent',
        'This is the full content\nwith multiple lines\nand the last line is shown',
        'Collapsed Agent',
        {
          metadata: { isCollapsed: true },
        },
      )

      const markup = renderToStaticMarkup(
        <MessageWithAgents
          {...baseMessageWithAgentsProps}
          message={collapsedMessage}
        />,
      )

      expect(markup).toContain('Collapsed Agent')
      // When collapsed, should show the collapsed indicator
      expect(markup).toContain('▸')
      // Preview should be the last line
      expect(markup).toContain('and the last line is shown')
      // First line of full content should not be present as a full block
      expect(markup).not.toContain('This is the full content')
    })

    test('renders expanded agent with full content and expanded indicator', () => {
      const expandedMessage = createAgentMessage(
        'expanded-agent',
        'Full expanded content here',
        'Expanded Agent',
        {
          metadata: { isCollapsed: false },
        },
      )

      const markup = renderToStaticMarkup(
        <MessageWithAgents
          {...baseMessageWithAgentsProps}
          message={expandedMessage}
        />,
      )

      expect(markup).toContain('Expanded Agent')
      expect(markup).toContain('Full expanded content here')
      // When expanded, should show the expanded indicator
      expect(markup).toContain('▾')
    })
  })

  describe('agent markdown rendering', () => {
    test('renders expanded agent markdown content through the native <markdown> renderable', () => {
      const message = createAgentMessage(
        'agent-md',
        '# Agent heading\n\nSome **bold** body',
        'MD Agent',
        {
          metadata: { isCollapsed: false },
        },
      )

      const markup = renderToStaticMarkup(
        <MessageWithAgents
          {...baseMessageWithAgentsProps}
          message={message}
        />,
      )

      // The native renderable is selected with our syntax style and shared
      // tree-sitter client wired in (observable via the stub attributes).
      expect(markup).toContain('<markdown')
      expect(markup).toContain('Agent heading')
      expect(markup).toContain('Some **bold** body')
      expect(markup).toContain('__stub-syntax-style__')
      expect(markup).toContain('__stub-tree-sitter-client__')
    })

    test('renders non-markdown agent content as plain text without the native renderable', () => {
      const message = createAgentMessage(
        'agent-plain',
        'Plain agent output',
        'Plain Agent',
        {
          metadata: { isCollapsed: false },
        },
      )

      const markup = renderToStaticMarkup(
        <MessageWithAgents
          {...baseMessageWithAgentsProps}
          message={message}
        />,
      )

      // The plain-text path keeps the wrapped text and never mounts the
      // native renderable.
      expect(markup).toContain('Plain agent output')
      expect(markup).not.toContain('<markdown')
    })

    test('degrades agent markdown content to plain text when native setup throws', () => {
      syntaxStyleSetupError = new Error('syntax style setup failed')

      const message = createAgentMessage(
        'agent-md-degrade',
        '## Degrading agent body',
        'Degrading Agent',
        {
          metadata: { isCollapsed: false },
        },
      )

      const markup = renderToStaticMarkup(
        <MessageWithAgents
          {...baseMessageWithAgentsProps}
          message={message}
        />,
      )

      // Degrade-to-plain-text contract: a native setup throw falls back to
      // the wrapped plain-text path instead of crashing the render.
      expect(markup).toContain('Degrading agent body')
      expect(markup).not.toContain('<markdown')
    })
  })
})

// =============================================================================
// Callback Integration Tests
// =============================================================================

describe('callback invocation', () => {
  test('callbacks are retrievable from store and callable', () => {
    let toggleCalledWith: string | undefined
    const mockToggle = (id: string) => {
      toggleCalledWith = id
    }

    useMessageBlockStore.getState().setCallbacks({
      ...defaultCallbacks,
      onToggleCollapsed: mockToggle,
    })

    // Verify callback is stored and retrievable
    const storedCallback =
      useMessageBlockStore.getState().callbacks.onToggleCollapsed
    storedCallback('test-message-id')

    expect(toggleCalledWith).toBe('test-message-id')
  })

  test('onFeedback callback receives messageId and options', () => {
    let feedbackMessageId: string | undefined
    let feedbackOptions: object | undefined
    const mockFeedback = (messageId: string, options?: object) => {
      feedbackMessageId = messageId
      feedbackOptions = options
    }

    useMessageBlockStore.getState().setCallbacks({
      ...defaultCallbacks,
      onFeedback: mockFeedback,
    })

    const storedCallback = useMessageBlockStore.getState().callbacks.onFeedback
    storedCallback('msg-123', { category: 'app_bug' })

    expect(feedbackMessageId).toBe('msg-123')
    expect(feedbackOptions).toEqual({ category: 'app_bug' })
  })

  test('plan command button invokes onInsertCommand through MessageWithAgents', () => {
    let insertedCommand: string | undefined
    const onInsertCommand = (command: string) => {
      insertedCommand = command
    }
    const message: ChatMessage = {
      ...createAiMessage('ai-plan', ''),
      blocks: [
        {
          type: 'plan',
          content: 'Plan body',
          metadata: {
            executeCommand: planCommand,
          },
        },
      ],
    }

    initializeStore()
    useMessageBlockStore.getState().setCallbacks({
      ...defaultCallbacks,
      onInsertCommand,
    })

    // renderToStaticMarkup reads Zustand's server snapshot, so mirror the test
    // callback there before rendering and restore both snapshots before asserting.
    const initialCallbacks = useMessageBlockStore.getInitialState().callbacks
    const previousInitialInsertCommand = initialCallbacks.onInsertCommand
    const previousLiveInsertCommand =
      useMessageBlockStore.getState().callbacks.onInsertCommand
    initialCallbacks.onInsertCommand = onInsertCommand

    try {
      renderToStaticMarkup(
        <MessageWithAgents {...baseMessageWithAgentsProps} message={message} />,
      )

      const commandButton = capturedButtons.find(
        (button) =>
          button.text === planCommand && typeof button.onClick === 'function',
      )
      expect(commandButton).toBeDefined()

      commandButton?.onClick?.()
    } finally {
      initialCallbacks.onInsertCommand = previousInitialInsertCommand
      useMessageBlockStore.getState().setCallbacks({
        ...useMessageBlockStore.getState().callbacks,
        onInsertCommand: previousLiveInsertCommand,
      })
    }

    expect(insertedCommand).toBe(planCommand)
  })
})

// =============================================================================
// Layout and visual structure tests
// =============================================================================

describe('layout handling', () => {
  test('renders correctly across different terminal widths', () => {
    const widths = [20, 80, 120, 300]

    for (const width of widths) {
      const message = createAiMessage(
        `width-${width}`,
        `Content at width ${width}`,
      )
      const markup = renderToStaticMarkup(
        <MessageWithAgents
          message={message}
          depth={0}
          isLastMessage={false}
          availableWidth={width}
        />,
      )
      expect(markup.replace(/\n/g, '')).toContain(`Content at width ${width}`)
    }
  })

  test('renders correctly with isLastMessage true and false', () => {
    const message = createAiMessage('last-msg-test', 'Test content')

    const lastMarkup = renderToStaticMarkup(
      <MessageWithAgents
        message={message}
        depth={0}
        isLastMessage={true}
        availableWidth={80}
      />,
    )

    const notLastMarkup = renderToStaticMarkup(
      <MessageWithAgents
        message={message}
        depth={0}
        isLastMessage={false}
        availableWidth={80}
      />,
    )

    expect(lastMarkup).toContain('Test content')
    expect(notLastMarkup).toContain('Test content')
  })
})

describe('vertical line for user messages', () => {
  test('renders vertical line box for user messages only', () => {
    const userMessage = createUserMessage('user-line', 'User content')
    const aiMessage = createAiMessage('ai-no-line', 'AI content')

    const userMarkup = renderToStaticMarkup(
      <MessageWithAgents
        message={userMessage}
        depth={0}
        isLastMessage={false}
        availableWidth={80}
      />,
    )

    const aiMarkup = renderToStaticMarkup(
      <MessageWithAgents
        message={aiMessage}
        depth={0}
        isLastMessage={false}
        availableWidth={80}
      />,
    )

    // Vertical line uses style={{ width: 1, backgroundColor: lineColor }}
    // which becomes width:1px in the style string.
    expect(userMarkup).toContain('width:1px')
    expect(aiMarkup).not.toContain('width:1px')
  })
})
