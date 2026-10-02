import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from 'bun:test'

import { useChatStore } from '../../state/chat-store'
import { INPUT_MODE_CONFIGS, getInputModeConfig } from '../../utils/input-modes'
import * as turnSnapshots from '../../utils/turn-snapshots'
import { runDashCommand } from '../dash-command'
import { findCommand } from '../command-registry'
import { routeUserPrompt, runBashCommand } from '../router'

import type { RouterParams } from '../command-registry'
import type { ChatMessage } from '../../types/chat'

/**
 * Tests for bash command execution logic.
 *
 * These tests cover:
 * 1. runBashCommand - ghost vs direct mode selection based on store state
 * 2. /bash slash command handler - immediate execution vs entering bash mode
 */

describe('bash command', () => {
  // Reset store state before each test
  beforeEach(() => {
    useChatStore.getState().reset()
  })

  // runBashCommand calls through the turn-snapshots module namespace, so a
  // spyOn keeps the suite hermetic (no real git snapshots from dispatch
  // tests) and mock.restore() in afterEach undoes it — no mock.module, so
  // nothing leaks to sibling test files in the same process.
  beforeEach(() => {
    spyOn(turnSnapshots, 'createTurnSnapshot').mockImplementation(() =>
      Promise.resolve({
        status: 'skipped',
        reason: 'test',
      }),
    )
  })

  afterEach(() => {
    mock.restore()
  })

  describe('/bash slash command handler', () => {
    const createMockParams = (
      overrides: Partial<RouterParams> = {},
    ): RouterParams => ({
      abortControllerRef: { current: null },
      agentMode: 'DEFAULT',
      inputRef: { current: null },
      inputValue: '/bash',
      isChainInProgressRef: { current: false },
      isStreaming: false,
      streamMessageIdRef: { current: null },
      addToQueue: mock(() => {}),
      clearMessages: mock(() => {}),
      saveToHistory: mock(() => {}),
      scrollToLatest: mock(() => {}),
      sendMessage: mock(async () => {}),
      setCanProcessQueue: mock(() => {}),
      setInputFocused: mock(() => {}),
      setInputValue: mock(() => {}),
      setMessages: mock(() => {}),
      stopStreaming: mock(() => {}),
      ...overrides,
    })

    test('/bash command exists in registry', () => {
      const bashCommand = findCommand('bash')
      expect(bashCommand).toBeDefined()
      expect(bashCommand?.name).toBe('bash')
    })

    test('/bash with no args enters bash mode', () => {
      const bashCommand = findCommand('bash')
      const params = createMockParams()

      // Execute with empty args
      bashCommand?.handler(params, '')

      // Should enter bash mode
      expect(useChatStore.getState().inputMode).toBe('bash')
    })

    test('/bash with args does NOT enter bash mode', () => {
      const bashCommand = findCommand('bash')
      const params = createMockParams()

      // Execute with args - this will call runBashCommand which tries to run a real command
      // We just verify it doesn't enter bash mode
      bashCommand?.handler(params, 'echo test')

      // Should NOT enter bash mode - command is executed immediately
      expect(useChatStore.getState().inputMode).toBe('default')
    })

    test('/bash with args saves command WITH ! prefix to history', () => {
      const saveToHistory = mock(() => {})
      const bashCommand = findCommand('bash')
      const params = createMockParams({ saveToHistory })

      bashCommand?.handler(params, 'ls -la')

      // Should save with ! prefix
      expect(saveToHistory).toHaveBeenCalledWith('!ls -la')
    })

    test('/bash with no args saves original input to history', () => {
      const saveToHistory = mock(() => {})
      const bashCommand = findCommand('bash')
      const params = createMockParams({
        inputValue: '/bash',
        saveToHistory,
      })

      bashCommand?.handler(params, '')

      // Should save the original input
      expect(saveToHistory).toHaveBeenCalledWith('/bash')
    })

    test('/bash with args clears input', () => {
      const setInputValue = mock(() => {})
      const bashCommand = findCommand('bash')
      const params = createMockParams({ setInputValue })

      bashCommand?.handler(params, 'pwd')

      expect(setInputValue).toHaveBeenCalledWith({
        text: '',
        cursorPosition: 0,
        lastEditDueToNav: false,
      })
    })

    test('/bash with whitespace-only args enters bash mode', () => {
      const bashCommand = findCommand('bash')
      const params = createMockParams()

      bashCommand?.handler(params, '   ')

      // Whitespace-only should be treated as no args
      expect(useChatStore.getState().inputMode).toBe('bash')
    })

    test('"!" is an alias for /bash', () => {
      const bangCommand = findCommand('!')
      expect(bangCommand).toBeDefined()
      expect(bangCommand?.name).toBe('bash')
    })
  })

  describe('runBashCommand mode selection', () => {
    test('uses direct mode when not busy (no streaming agents, no chain in progress)', () => {
      // Ensure store is in non-busy state
      const state = useChatStore.getState()
      expect(state.streamingAgents.size).toBe(0)
      expect(state.isChainInProgress).toBe(false)

      // The isBusy calculation should be false
      const isBusy = state.streamingAgents.size > 0 || state.isChainInProgress
      expect(isBusy).toBe(false)
    })

    test('uses ghost mode when streaming agents present', () => {
      // Set up streaming agents
      useChatStore.getState().setStreamingAgents(new Set(['agent-1']))

      const state = useChatStore.getState()
      const isBusy = state.streamingAgents.size > 0 || state.isChainInProgress
      expect(isBusy).toBe(true)
    })

    test('uses ghost mode when chain in progress', () => {
      // Set chain in progress
      useChatStore.getState().setIsChainInProgress(true)

      const state = useChatStore.getState()
      const isBusy = state.streamingAgents.size > 0 || state.isChainInProgress
      expect(isBusy).toBe(true)
    })

    test('uses ghost mode when both streaming and chain in progress', () => {
      useChatStore.getState().setStreamingAgents(new Set(['agent-1']))
      useChatStore.getState().setIsChainInProgress(true)

      const state = useChatStore.getState()
      const isBusy = state.streamingAgents.size > 0 || state.isChainInProgress
      expect(isBusy).toBe(true)
    })
  })

  describe('runBashCommand turn snapshots', () => {
    test('fires a fire-and-forget createTurnSnapshot with label shell', async () => {
      runBashCommand('echo openbuff-snapshot-test')

      // The snapshot is fire-and-forget: one macrotask turn is enough for
      // the call to have been made, and dispatch never awaits it.
      await new Promise((resolve) => setTimeout(resolve, 0))

      expect(turnSnapshots.createTurnSnapshot).toHaveBeenCalledTimes(1)
      expect(turnSnapshots.createTurnSnapshot).toHaveBeenCalledWith({
        label: 'shell',
      })
    })
  })

  describe('bash dispatch during a bisection', () => {
    const createRouteParams = (
      overrides: Partial<RouterParams> = {},
    ): RouterParams => ({
      abortControllerRef: { current: null },
      agentMode: 'DEFAULT',
      inputRef: { current: null },
      inputValue: 'ls',
      isChainInProgressRef: { current: false },
      isStreaming: false,
      streamMessageIdRef: { current: null },
      addToQueue: mock(() => {}),
      clearMessages: mock(() => {}),
      saveToHistory: mock(() => {}),
      scrollToLatest: mock(() => {}),
      sendMessage: mock(async () => {}),
      setCanProcessQueue: mock(() => {}),
      setInputFocused: mock(() => {}),
      setInputValue: mock(() => {}),
      setMessages: mock(() => {}),
      stopStreaming: mock(() => {}),
      ...overrides,
    })

    test('a bang-prefixed command is blocked while a bisection is running', async () => {
      // The updater arg is typed so bun's mock.calls tuples carry an element
      // (a bare mock(() => {}) infers a zero-length tuple and
      // calls[0]?.[0] does not typecheck).
      const setMessages = mock((_updater: unknown) => {})
      spyOn(turnSnapshots, 'isTurnBisectionRunning').mockReturnValue(true)

      await routeUserPrompt(
        createRouteParams({ inputValue: '!rm -rf build', setMessages }),
      )

      // The command was never dispatched: no pre-command shell snapshot ran.
      expect(turnSnapshots.createTurnSnapshot).not.toHaveBeenCalled()

      // The block is surfaced in chat history as a system message.
      expect(setMessages).toHaveBeenCalledTimes(1)
      const updater = setMessages.mock.calls[0]?.[0] as
        | ((prev: ChatMessage[]) => ChatMessage[])
        | undefined
      expect(typeof updater).toBe('function')
      const blocked = updater ? updater([]) : []
      expect(
        blocked.some(
          (message) =>
            typeof message.content === 'string' &&
            message.content.includes('/bisect-turn'),
        ),
      ).toBe(true)
    })

    test('bash mode input is blocked while a bisection is running, and the mode resets', async () => {
      const setMessages = mock(() => {})
      useChatStore.getState().setInputMode('bash')
      spyOn(turnSnapshots, 'isTurnBisectionRunning').mockReturnValue(true)

      await routeUserPrompt(
        createRouteParams({ inputValue: 'git reset --hard', setMessages }),
      )

      // The command was never dispatched: no pre-command shell snapshot ran.
      expect(turnSnapshots.createTurnSnapshot).not.toHaveBeenCalled()
      // Bash mode did not stay stuck on the blocked command.
      expect(useChatStore.getState().inputMode).toBe('default')
      expect(setMessages).toHaveBeenCalledTimes(1)
    })

    test('runBashCommand fails closed while a bisection is running', () => {
      spyOn(turnSnapshots, 'isTurnBisectionRunning').mockReturnValue(true)

      runBashCommand('echo blocked-during-bisect')

      expect(turnSnapshots.createTurnSnapshot).not.toHaveBeenCalled()
      const messages = useChatStore.getState().messages
      expect(
        messages.some(
          (message) =>
            typeof message.content === 'string' &&
            message.content.includes('/bisect-turn'),
        ),
      ).toBe(true)
    })

    test('bash dispatch still proceeds when no bisection is running', async () => {
      await routeUserPrompt(createRouteParams({ inputValue: '!echo hello' }))

      // The fire-and-forget pre-command snapshot is the dispatch marker.
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(turnSnapshots.createTurnSnapshot).toHaveBeenCalledWith({
        label: 'shell',
      })
    })

    test('/bisect-turn stop stays reachable while a bisection is running', () => {
      // `stop` is the escape hatch: it must work EXACTLY when a bisection is
      // in flight, so the spy keeps the flag state hermetic.
      const cancelSpy = spyOn(turnSnapshots, 'cancelTurnBisection')
      spyOn(turnSnapshots, 'isTurnBisectionRunning').mockReturnValue(true)

      findCommand('bisect-turn')?.handler(
        createRouteParams({ inputValue: '/bisect-turn stop' }),
        'stop',
      )

      expect(cancelSpy).toHaveBeenCalledTimes(1)
    })

    test('/bisect-turn list stays reachable while a bisection is running', async () => {
      // `list` is read-only: it must work during a run so the user can see
      // what is being probed.
      const listSpy = spyOn(
        turnSnapshots,
        'listTurnSnapshots',
      ).mockResolvedValue([])
      spyOn(turnSnapshots, 'isTurnBisectionRunning').mockReturnValue(true)

      findCommand('bisect-turn')?.handler(
        createRouteParams({ inputValue: '/bisect-turn list' }),
        'list',
      )
      await new Promise((resolve) => setTimeout(resolve, 0))

      expect(listSpy).toHaveBeenCalled()
    })

    test('/bisect-turn without a subcommand reports the live stop escape hatch while a bisection runs', () => {
      // appendLocalMessage routes through the setMessages updater, so capture
      // it (typed arg keeps bun's mock.calls tuple non-empty).
      const setMessages = mock((_updater: unknown) => {})
      spyOn(turnSnapshots, 'isTurnBisectionRunning').mockReturnValue(true)
      const startSpy = spyOn(turnSnapshots, 'runTurnBisection').mockResolvedValue(
        { status: 'no-snapshots' },
      )

      findCommand('bisect-turn')?.handler(
        createRouteParams({ inputValue: '/bisect-turn', setMessages }),
        '',
      )

      // No new bisection started while one is in flight...
      expect(startSpy).not.toHaveBeenCalled()
      // ...and the in-flight message names the now-LIVE stop escape hatch.
      const updater = setMessages.mock.calls[0]?.[0] as
        | ((prev: ChatMessage[]) => ChatMessage[])
        | undefined
      const blocked = updater ? updater([]) : []
      expect(
        blocked.some(
          (message) =>
            typeof message.content === 'string' &&
            message.content.includes('/bisect-turn stop'),
        ),
      ).toBe(true)
    })

    test('parse: --keep-best is stripped from the command and passed to runTurnBisection', async () => {
      spyOn(turnSnapshots, 'listTurnSnapshots').mockResolvedValue([])
      const startSpy = spyOn(
        turnSnapshots,
        'runTurnBisection',
      ).mockResolvedValue({ status: 'no-snapshots' })

      findCommand('bisect-turn')?.handler(
        createRouteParams({
          inputValue: '/bisect-turn --keep-best bun test --filter foo',
        }),
        '--keep-best bun test --filter foo',
      )
      await new Promise((resolve) => setTimeout(resolve, 0))

      expect(startSpy).toHaveBeenCalledWith({
        command: 'bun test --filter foo',
        keepBestState: true,
      })
    })

    test('parse: bare /bisect-turn passes keepBestState false with the default command', async () => {
      // Stub the listing too: the handler awaits the real listTurnSnapshots
      // (a git subprocess) before calling runTurnBisection, and one
      // macrotask tick is not enough for a real git spawn under full-suite
      // load.
      spyOn(turnSnapshots, 'listTurnSnapshots').mockResolvedValue([])
      const startSpy = spyOn(
        turnSnapshots,
        'runTurnBisection',
      ).mockResolvedValue({ status: 'no-snapshots' })

      findCommand('bisect-turn')?.handler(
        createRouteParams({ inputValue: '/bisect-turn' }),
        '',
      )
      await new Promise((resolve) => setTimeout(resolve, 0))

      expect(startSpy).toHaveBeenCalledWith({
        command: 'bun test',
        keepBestState: false,
      })
    })
  })

  describe('pending bash messages', () => {
    test('addPendingBashMessage adds message to store', () => {
      const { addPendingBashMessage } = useChatStore.getState()

      addPendingBashMessage({
        id: 'test-id',
        command: 'ls -la',
        stdout: '',
        stderr: '',
        exitCode: 0,
        isRunning: true,
        cwd: '/test',
      })

      const messages = useChatStore.getState().pendingBashMessages
      expect(messages.length).toBe(1)
      expect(messages[0].command).toBe('ls -la')
      expect(messages[0].isRunning).toBe(true)
    })

    test('updatePendingBashMessage updates existing message', () => {
      const { addPendingBashMessage, updatePendingBashMessage } =
        useChatStore.getState()

      addPendingBashMessage({
        id: 'test-id',
        command: 'ls -la',
        stdout: '',
        stderr: '',
        exitCode: 0,
        isRunning: true,
        cwd: '/test',
      })

      updatePendingBashMessage('test-id', {
        stdout: 'file1.txt\nfile2.txt',
        exitCode: 0,
        isRunning: false,
      })

      const messages = useChatStore.getState().pendingBashMessages
      expect(messages[0].stdout).toBe('file1.txt\nfile2.txt')
      expect(messages[0].isRunning).toBe(false)
    })

    test('removePendingBashMessage removes message from store', () => {
      const { addPendingBashMessage, removePendingBashMessage } =
        useChatStore.getState()

      addPendingBashMessage({
        id: 'test-id',
        command: 'ls',
        stdout: '',
        stderr: '',
        exitCode: 0,
        isRunning: false,
        cwd: '/test',
      })

      expect(useChatStore.getState().pendingBashMessages.length).toBe(1)

      removePendingBashMessage('test-id')

      expect(useChatStore.getState().pendingBashMessages.length).toBe(0)
    })

    test('clearPendingBashMessages removes all messages', () => {
      const { addPendingBashMessage, clearPendingBashMessages } =
        useChatStore.getState()

      addPendingBashMessage({
        id: 'test-1',
        command: 'ls',
        stdout: '',
        stderr: '',
        exitCode: 0,
        isRunning: false,
        cwd: '/test',
      })
      addPendingBashMessage({
        id: 'test-2',
        command: 'pwd',
        stdout: '',
        stderr: '',
        exitCode: 0,
        isRunning: false,
        cwd: '/test',
      })

      expect(useChatStore.getState().pendingBashMessages.length).toBe(2)

      clearPendingBashMessages()

      expect(useChatStore.getState().pendingBashMessages.length).toBe(0)
    })
  })

  describe('bash mode state transitions', () => {
    test('entering bash mode sets inputMode to bash', () => {
      useChatStore.getState().setInputMode('bash')
      expect(useChatStore.getState().inputMode).toBe('bash')
    })

    test('exiting bash mode sets inputMode to default', () => {
      useChatStore.getState().setInputMode('bash')
      useChatStore.getState().setInputMode('default')
      expect(useChatStore.getState().inputMode).toBe('default')
    })

    test('reset clears inputMode to default', () => {
      useChatStore.getState().setInputMode('bash')
      useChatStore.getState().reset()
      expect(useChatStore.getState().inputMode).toBe('default')
    })
  })

  describe('/bash with special characters in args', () => {
    const createMockParams = (
      overrides: Partial<RouterParams> = {},
    ): RouterParams => ({
      abortControllerRef: { current: null },
      agentMode: 'DEFAULT',
      inputRef: { current: null },
      inputValue: '/bash',
      isChainInProgressRef: { current: false },
      isStreaming: false,
      streamMessageIdRef: { current: null },
      addToQueue: mock(() => {}),
      clearMessages: mock(() => {}),
      saveToHistory: mock(() => {}),
      scrollToLatest: mock(() => {}),
      sendMessage: mock(async () => {}),
      setCanProcessQueue: mock(() => {}),
      setInputFocused: mock(() => {}),
      setInputValue: mock(() => {}),
      setMessages: mock(() => {}),
      stopStreaming: mock(() => {}),
      ...overrides,
    })

    test('/bash with pipe characters preserves them', () => {
      const saveToHistory = mock(() => {})
      const bashCommand = findCommand('bash')
      const params = createMockParams({ saveToHistory })

      bashCommand?.handler(params, 'ls | grep foo')

      expect(saveToHistory).toHaveBeenCalledWith('!ls | grep foo')
    })

    test('/bash with quoted arguments preserves them', () => {
      const saveToHistory = mock(() => {})
      const bashCommand = findCommand('bash')
      const params = createMockParams({ saveToHistory })

      bashCommand?.handler(params, 'echo "hello world"')

      expect(saveToHistory).toHaveBeenCalledWith('!echo "hello world"')
    })

    test('/bash with redirection operators preserves them', () => {
      const saveToHistory = mock(() => {})
      const bashCommand = findCommand('bash')
      const params = createMockParams({ saveToHistory })

      bashCommand?.handler(params, 'echo test > debug/output.txt')

      expect(saveToHistory).toHaveBeenCalledWith(
        '!echo test > debug/output.txt',
      )
    })

    test('/bash with environment variables preserves them', () => {
      const saveToHistory = mock(() => {})
      const bashCommand = findCommand('bash')
      const params = createMockParams({ saveToHistory })

      bashCommand?.handler(params, 'echo $HOME')

      expect(saveToHistory).toHaveBeenCalledWith('!echo $HOME')
    })

    test('/bash with semicolon command chaining preserves it', () => {
      const saveToHistory = mock(() => {})
      const bashCommand = findCommand('bash')
      const params = createMockParams({ saveToHistory })

      bashCommand?.handler(params, 'cd /tmp; ls')

      expect(saveToHistory).toHaveBeenCalledWith('!cd /tmp; ls')
    })

    test('/bash with && command chaining preserves it', () => {
      const saveToHistory = mock(() => {})
      const bashCommand = findCommand('bash')
      const params = createMockParams({ saveToHistory })

      bashCommand?.handler(params, 'mkdir test && cd test')

      expect(saveToHistory).toHaveBeenCalledWith('!mkdir test && cd test')
    })
  })

  describe('bang prefix handling in queue', () => {
    test('command starting with ! and length > 1 is recognized as bash command', () => {
      const input = '!ls -la'
      const isBashFromQueue = input.startsWith('!') && input.length > 1
      expect(isBashFromQueue).toBe(true)
    })

    test('single ! character is NOT recognized as bash command from queue', () => {
      const input = '!'
      const isBashFromQueue = input.startsWith('!') && input.length > 1
      expect(isBashFromQueue).toBe(false)
    })

    test('command extracts correctly without ! prefix', () => {
      const input = '!git status'
      const command = input.slice(1)
      expect(command).toBe('git status')
    })

    test('empty string is not a bash command from queue', () => {
      const input = ''
      const isBashFromQueue = input.startsWith('!') && input.length > 1
      expect(isBashFromQueue).toBe(false)
    })

    test('regular text without ! is not a bash command from queue', () => {
      const input = 'help me with this'
      const isBashFromQueue = input.startsWith('!') && input.length > 1
      expect(isBashFromQueue).toBe(false)
    })
  })

  describe('bash mode configuration', () => {
    test('bash mode has correct label', () => {
      const config = getInputModeConfig('bash')
      expect(config.icon).toBe(null)
      expect(config.label).toBe('!')
    })

    test('bash mode uses info color', () => {
      const config = getInputModeConfig('bash')
      expect(config.color).toBe('info')
    })

    test('bash mode has correct placeholder', () => {
      const config = getInputModeConfig('bash')
      expect(config.placeholder).toBe('enter bash command...')
    })

    test('bash mode has width adjustment of 4', () => {
      const config = getInputModeConfig('bash')
      expect(config.widthAdjustment).toBe(4)
    })

    test('bash mode hides agent mode toggle', () => {
      const config = getInputModeConfig('bash')
      expect(config.showAgentModeToggle).toBe(false)
    })

    test('bash mode disables slash command suggestions', () => {
      const config = getInputModeConfig('bash')
      expect(config.disableSlashSuggestions).toBe(true)
    })

    test('bash mode config exists in INPUT_MODE_CONFIGS', () => {
      expect(INPUT_MODE_CONFIGS.bash).toBeDefined()
    })
  })
})

describe('openbuff dash command (--no-open URL contract)', () => {
  // The real URL embeds the auth token as ?token=..., which is exactly what
  // the --no-open contract forbids printing on any channel.
  const URL_WITH_TOKEN = 'http://127.0.0.1:4567/?token=sekrit-token'

  // A zero-arg stub is assignable to `typeof startDashServer`; the real one
  // binds a TCP port, so tests inject this hermetic seam instead.
  const startServerStub = () =>
    Promise.resolve({
      url: URL_WITH_TOKEN,
      close: () => Promise.resolve(),
    })

  const runServingDash = async (args: { open: boolean }) => {
    const stdout: string[] = []
    const stderr: string[] = []
    // Serve mode never resolves (it awaits "forever" until Ctrl+C), so the
    // promise is intentionally not awaited; one macrotask tick is enough for
    // the stubbed startup to have produced its output.
    void runDashCommand(
      { open: args.open, token: 'explicit-token' },
      {
        startServer: startServerStub,
        writeStdout: (chunk) => {
          stdout.push(chunk)
        },
        writeStderr: (line) => {
          stderr.push(line)
        },
      },
    )
    await new Promise((resolve) => setTimeout(resolve, 0))
    return { stdout: stdout.join(''), stderr: stderr.join('') }
  }

  test('default mode prints the token-bearing URL to stdout only', async () => {
    const { stdout, stderr } = await runServingDash({ open: true })
    expect(stdout).toBe(`${URL_WITH_TOKEN}\n`)
    expect(stderr).not.toContain(URL_WITH_TOKEN)
  })

  test('--no-open prints the token-bearing URL nowhere (stderr included)', async () => {
    const { stdout, stderr } = await runServingDash({ open: false })
    expect(stdout).toBe('')
    // The URL embeds the auth token (?token=...): with --no-open it must not
    // ride ANY channel, stderr included (the old behavior leaked it there).
    expect(stderr).not.toContain(URL_WITH_TOKEN)
    expect(stderr).not.toContain('serving at')
    expect(stderr).toContain('press Ctrl+C to stop')
  })
})
