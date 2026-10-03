import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

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

import type { RunDashDeps } from '../dash-command'
import type {
  JournalEventRow,
  JournalReader,
} from '@codebuff/common/types/contracts/agent-runtime'
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
        // Hermetic: a journal path that never exists, so the live-wiring
        // fallback (absent file → empty data) is exercised deterministically
        // and the real harness journal is never opened from a test.
        journalPath: '/nonexistent-root-for-openbuff-tests/run-journal.db',
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

describe('openbuff dash live journal wiring (P2-T7)', () => {
  /**
   * A real (empty) file so the dash-side existence check passes and the
   * injected opener is actually invoked; the fake opener never touches it.
   */
  const makeExistingJournalFile = async () => {
    const parent = await mkdtemp(path.join(tmpdir(), 'dash-journal-'))
    const journalPath = path.join(parent, 'run-journal.db')
    await writeFile(journalPath, '')
    return { parent, journalPath }
  }

  const makeFakeReader = (
    overrides: {
      runIds?: () => string[]
      events?: () => JournalEventRow[]
    } = {},
  ) => ({
    runIds: overrides.runIds ?? (() => []),
    lastEvent: () => undefined,
    events: overrides.events ?? (() => []),
    toolResultFor: () => undefined,
    toolResultForInput: () => undefined,
  })

  /**
   * Hermetic serving harness: the injected startServer captures the served
   * provider, and the returned `fireShutdown` invokes the SIGINT handler the
   * real command registered (exactly what the OS does on Ctrl+C), so the
   * serve promise resolves instead of awaiting forever.
   */
  const serveWithStub = async (deps: RunDashDeps) => {
    const stdout: string[] = []
    const stderr: string[] = []
    let servedData: unknown
    let shutdownHandler: (() => void) | undefined

    const signalHandlers = new Map<string, () => void>()
    const originalOnce = process.once.bind(process)
    const originalOff = process.off.bind(process)
    spyOn(process, 'once').mockImplementation(
      ((event: string, listener: () => void) => {
        if (event === 'SIGINT' || event === 'SIGTERM') {
          signalHandlers.set(event, listener)
          return process
        }
        return originalOnce(event as never, listener as never)
      }) as unknown as typeof process.once,
    )
    spyOn(process, 'off').mockImplementation(
      ((event: string, listener: () => void) => {
        if (event === 'SIGINT' || event === 'SIGTERM') {
          signalHandlers.delete(event)
          return process
        }
        return originalOff(event as never, listener as never)
      }) as unknown as typeof process.off,
    )

    try {
      const servePromise = runDashCommand(
        { open: true, token: 'explicit-token' },
        {
          ...deps,
          writeStdout: (chunk) => stdout.push(chunk),
          writeStderr: (line) => stderr.push(line),
          startServer: async ({ data }) => {
            servedData = data
            return {
              url: 'http://127.0.0.1:0/?token=x',
              close: async () => {},
            }
          },
        } as RunDashDeps,
      )

      // The promise must stay pending (the server is alive) until the signal:
      // it must never exit early on empty event data.
      let settled = false
      void servePromise.then(
        () => {
          settled = true
        },
        () => {
          settled = true
        },
      )
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(settled).toBe(false)

      // Fire SIGINT the way the OS would.
      shutdownHandler = signalHandlers.get('SIGINT')
      expect(shutdownHandler).toBeDefined()
      shutdownHandler!()
      const code = await servePromise

      return { code, servedData, stdout: stdout.join(''), stderr: stderr.join('') }
    } finally {
      mock.restore()
    }
  }

  test('an injected openJournal reader feeds the dash provider (listRuns sees its runs)', async () => {
    const { parent, journalPath } = await makeExistingJournalFile()
    try {
      const journalRuns = ['run-live-1', 'run-live-2']
      const events: JournalEventRow[] = [
        {
          seq: 0,
          stepNumber: 0,
          eventType: 'llm_request',
          correlation: 'c0',
          createdAt: 1704067200000,
          payload: { model: 'm' },
        },
      ]
      let closeCount = 0
      const { code, servedData, stderr } = await serveWithStub({
        openJournal: () => ({
          reader: makeFakeReader({
            runIds: () => journalRuns,
            events: () => events,
          }) as unknown as JournalReader,
          close: () => {
            closeCount += 1
          },
        }),
        journalPath,
      })

      // The server was started with the OPENED reader's data; on shutdown the
      // journal is closed exactly once.
      expect(code).toBe(0)
      expect(closeCount).toBe(1)
      const provider = servedData as {
        listRuns(): Promise<Array<{ runId: string; eventCount: number }>>
        getRunEvents(runId: string): Promise<Array<{ eventType: string }>>
      }
      const runs = await provider.listRuns()
      expect(runs.map((r) => r.runId)).toEqual(journalRuns)
      expect(runs[0].eventCount).toBe(1)
      const runEvents = await provider.getRunEvents('run-live-1')
      expect(runEvents[0].eventType).toBe('llm_request')
      // The dash never writes: the opener was the ONLY journal touch.
      expect(stderr).not.toContain('run journal unavailable')
    } finally {
      await rm(parent, { recursive: true, force: true })
    }
  })

  test('an absent journal file falls back to empty data with a one-line warning, never creating the db', async () => {
    let openCalled = 0
    const { code, servedData, stderr } = await serveWithStub({
      openJournal: () => {
        openCalled += 1
        throw new Error('should not be called when the file is absent')
      },
      journalPath: '/nonexistent-root-for-openbuff-tests/run-journal.db',
    })

    // Fail-closed: no crash, no db creation, one stderr warning, and the
    // provider serves EMPTY run data (never guessed ids).
    expect(openCalled).toBe(0)
    expect(code).toBe(0)
    expect(stderr).toContain('run journal unavailable')
    expect(stderr.match(/run journal unavailable/g)).toHaveLength(1)
    const provider = servedData as {
      listRuns(): Promise<unknown[]>
      getRunEvents(runId: string): Promise<unknown[]>
    }
    expect(await provider.listRuns()).toEqual([])
    expect(await provider.getRunEvents('anything')).toEqual([])
  })

  test('an unopenable existing journal file warns once and still serves empty data', async () => {
    const { parent, journalPath } = await makeExistingJournalFile()
    try {
      const { code, servedData, stderr } = await serveWithStub({
        openJournal: () => {
          throw new Error('sqlite unavailable')
        },
        journalPath,
      })

      expect(code).toBe(0)
      expect(stderr).toContain('run journal unavailable')
      expect(stderr).toContain('sqlite unavailable')
      expect(
        await (servedData as { listRuns(): Promise<unknown[]> }).listRuns(),
      ).toEqual([])
    } finally {
      await rm(parent, { recursive: true, force: true })
    }
  })

  test('the journal is closed exactly once on shutdown, never written from the dash side', async () => {
    const { parent, journalPath } = await makeExistingJournalFile()
    try {
      let closeCount = 0
      const { code } = await serveWithStub({
        openJournal: () => ({
          reader: makeFakeReader(),
          close: () => {
            closeCount += 1
          },
        }),
        journalPath,
      })
      expect(code).toBe(0)
      expect(closeCount).toBe(1)
      // The file was never created/expanded by the dash side: it is still the
      // empty file we wrote (no append, no pruneRuns, no schema DDL from the
      // fake opener).
      const stats = await import('node:fs/promises').then((fs) =>
        fs.stat(journalPath),
      )
      expect(stats.size).toBe(0)
    } finally {
      await rm(parent, { recursive: true, force: true })
    }
  })

  test('--export opens the journal, exports, and closes it in a finally', async () => {
    const { parent, journalPath } = await makeExistingJournalFile()
    try {
      let closeCount = 0
      const stdout: string[] = []
      const code = await runDashCommand(
        {
          open: true,
          token: 'explicit-token',
          exportDir: path.join(parent, 'site'),
        },
        {
          openJournal: () => ({
            reader: makeFakeReader({ runIds: () => ['run-export-1'] }),
            close: () => {
              closeCount += 1
            },
          }),
          journalPath,
          writeStdout: (chunk) => stdout.push(chunk),
        } as RunDashDeps,
      )

      expect(code).toBe(0)
      expect(stdout.join('')).toContain('index.html')
      // The journal was closed exactly once, even on the success path.
      expect(closeCount).toBe(1)
    } finally {
      await rm(parent, { recursive: true, force: true })
    }
  })
})
