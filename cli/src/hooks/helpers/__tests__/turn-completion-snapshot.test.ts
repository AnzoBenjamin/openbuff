import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from 'bun:test'
import { execFile } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import React from 'react'
import { enableMapSet } from 'immer'

import type {
  GitRunner,
  TurnSnapshotOutcome,
} from '../../../utils/turn-snapshots'
import type { ChatMessage } from '../../../types/chat'
import type { StreamStatus } from '../../use-message-queue'

process.env.NEXT_PUBLIC_CB_ENVIRONMENT = 'test'
process.env.NEXT_PUBLIC_CODEBUFF_APP_URL = 'https://app.codebuff.test'
process.env.NEXT_PUBLIC_SUPPORT_EMAIL = 'support@codebuff.test'
process.env.NEXT_PUBLIC_POSTHOG_API_KEY = 'phc_test_key'
process.env.NEXT_PUBLIC_POSTHOG_HOST_URL = 'https://posthog.codebuff.test'
enableMapSet()

const snapshots = await import('../../../utils/turn-snapshots')
const realCreateSnapshot = snapshots.createTurnSnapshot
const { handleRunCompletion } = await import('../send-message')
const { createBatchedMessageUpdater } =
  await import('../../../utils/message-updater')
const { runQueuedMessage } = await import('../../use-message-queue')
const projectFiles = await import('../../../project-files')
const { useSendMessage } = await import('../../use-send-message')
const { useChatStore } = await import('../../../state/chat-store')
const registries = await import('../../../services/deferred-registries')
const clients = await import('../../../utils/codebuff-client')
const providers = await import('../../../utils/openbuff-provider')
const agents = await import('../../../utils/local-agent-registry')
const configs = await import('../../../utils/create-run-config')
const journals = await import('../../../utils/run-journal-path')
const storage = await import('../../../utils/run-state-storage')

const execFileAsync = promisify(execFile)
const noop = () => {}
const runState = { output: { type: 'lastMessage' as const, value: [] } }
const internals = (
  React as unknown as {
    __CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE: {
      H: unknown
    }
  }
).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE
const deferred = <T = void>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}
let repo: string
let originalDispatcher: unknown
let previousConfigDir: string | undefined
const git = (...args: string[]) =>
  execFileAsync('git', args, { cwd: repo, encoding: 'utf8' })

beforeEach(async () => {
  repo = mkdtempSync(path.join(tmpdir(), 'openbuff-turn-completion-'))
  previousConfigDir = process.env.OPENBUFF_CONFIG_DIR
  process.env.OPENBUFF_CONFIG_DIR = path.join(repo, 'config')
  originalDispatcher = internals.H
  await git('init', '-b', 'main')
  await git('config', 'user.email', 'turn-completion@openbuff.invalid')
  await git('config', 'user.name', 'Turn completion fixture')
  writeFileSync(path.join(repo, 'tracked.txt'), 'baseline\n')
  await git('add', 'tracked.txt')
  await git('commit', '-m', 'baseline')
  writeFileSync(path.join(repo, 'tracked.txt'), 'turn-A\n')
  spyOn(projectFiles, 'getProjectRoot').mockReturnValue(repo)
})

afterEach(() => {
  internals.H = originalDispatcher
  mock.restore()
  useChatStore.getState().reset()
  if (previousConfigDir === undefined) delete process.env.OPENBUFF_CONFIG_DIR
  else process.env.OPENBUFF_CONFIG_DIR = previousConfigDir
  rmSync(repo, { recursive: true, force: true })
})

function captureBarrier(failCapture = false) {
  const reached = deferred()
  const release = deferred()
  const settled = deferred<TurnSnapshotOutcome>()
  const runGit: GitRunner = async (args, opts) => {
    if (args[0] === 'add' && args[1] === '-u') {
      reached.resolve()
      await release.promise
      if (failCapture) {
        // A real Git error, rather than an injected snapshot outcome.
        return execFileAsync(
          'git',
          ['add', '--openbuff-invalid-capture-option'],
          opts,
        )
      }
    }
    return execFileAsync('git', args, opts)
  }
  const seam = spyOn(snapshots, 'createTurnSnapshot').mockImplementation(
    (opts) =>
      realCreateSnapshot({ ...opts, projectRoot: repo }, { runGit }).then(
        (outcome) => {
          settled.resolve(outcome)
          return outcome
        },
      ),
  )
  return {
    reached: reached.promise,
    release: () => release.resolve(),
    settled: settled.promise,
    seam,
  }
}

function completionState() {
  let messages: ChatMessage[] = [
    { id: 'ai-A', variant: 'ai', content: 'A', blocks: [], timestamp: 'now' },
  ]
  const updater = createBatchedMessageUpdater('ai-A', (fn) => {
    messages = fn(messages)
  })
  let streamStatus: StreamStatus = 'streaming'
  let canProcessQueue = false
  let chainInProgress = true
  const isProcessingQueueRef = { current: true }
  const isQueuePausedRef = { current: false }
  const stopped: string[] = []
  return {
    isProcessingQueueRef,
    isQueuePausedRef,
    complete: () => messages[0]?.isComplete === true,
    stopped,
    eligible: () =>
      canProcessQueue &&
      streamStatus === 'idle' &&
      !chainInProgress &&
      !isProcessingQueueRef.current,
    params: {
      runState,
      actualCredits: 1,
      agentMode: 'DEFAULT' as const,
      updater,
      aiMessageId: 'ai-A',
      wasAbortedByUser: false,
      timerController: {
        start: noop,
        pause: noop,
        resume: noop,
        isActive: () => true,
        stop(result: 'success' | 'error' | 'aborted') {
          stopped.push(result)
          return { finishedAt: Date.now(), elapsedMs: 100 }
        },
      },
      setStreamStatus(value: StreamStatus) {
        streamStatus = value
      },
      setCanProcessQueue(value: boolean) {
        canProcessQueue = value
      },
      updateChainInProgress(value: boolean) {
        chainInProgress = value
      },
      setHasReceivedPlanResponse: noop,
      resumeQueue() {
        canProcessQueue = true
      },
      isProcessingQueueRef,
      isQueuePausedRef,
    },
  }
}

describe('successful turn snapshot settlement', () => {
  test('holds the queue until real tracked-tree capture completes', async () => {
    const barrier = captureBarrier()
    const state = completionState()
    const pending = handleRunCompletion(state.params)
    try {
      await barrier.reached
      expect(barrier.seam).toHaveBeenCalledTimes(1)
      expect(state.complete()).toBe(true)
      expect(state.stopped).toEqual(['success'])
      expect(state.eligible()).toBe(false)
      expect(state.isProcessingQueueRef.current).toBe(true)
    } finally {
      barrier.release()
      await pending
    }
    const outcome = await barrier.settled
    expect(outcome.status).toBe('created')
    expect(state.eligible()).toBe(true)
    let dispatched = false
    runQueuedMessage({
      messageToProcess: {
        content: 'queued B',
        attachments: [],
        agentMode: 'DEFAULT',
      },
      isProcessingQueueRef: state.isProcessingQueueRef,
      isQueuePausedRef: state.isQueuePausedRef,
      queueProcessingOwnerRef: { current: null },
      setCanProcessQueue: noop,
      sendMessage: async () => {
        dispatched = true
        writeFileSync(path.join(repo, 'tracked.txt'), 'turn-B\n')
        return {
          status: 'accepted',
          disposition: 'started',
          completion: Promise.resolve(),
        }
      },
    })
    expect(dispatched).toBe(true)
    if (outcome.status !== 'created')
      throw new Error('snapshot was not created')
    expect(outcome.label).toBe('turn')
    expect((await git('show', `${outcome.sha}:tracked.txt`)).stdout).toBe(
      'turn-A\n',
    )
    expect(readFileSync(path.join(repo, 'tracked.txt'), 'utf8')).toBe(
      'turn-B\n',
    )
  })

  test('logs a settled real Git failure and then unblocks the queue', async () => {
    const barrier = captureBarrier(true)
    const state = completionState()
    const logged = spyOn(snapshots, 'logTurnSnapshotFailure')
    const pending = handleRunCompletion(state.params)
    try {
      await barrier.reached
      expect(state.eligible()).toBe(false)
    } finally {
      barrier.release()
      await pending
    }
    const outcome = await barrier.settled
    expect(outcome.status).toBe('error')
    expect(logged).toHaveBeenCalledWith(outcome, 'turn')
    expect(state.eligible()).toBe(true)
  })

  test('preserves an actual busy-gate refusal and unblocks after it settles', async () => {
    expect(snapshots.acquireTurnBisectionLock(repo)).toBe(true)
    const state = completionState()
    const logged = spyOn(snapshots, 'logTurnSnapshotFailure')
    try {
      const pending = handleRunCompletion(state.params)
      expect(state.eligible()).toBe(false)
      await pending
      expect(logged).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'skipped' }),
        'turn',
      )
      expect(state.eligible()).toBe(true)
    } finally {
      snapshots.releaseTurnBisectionLock(repo)
    }
  })
})

function callerHarness(run: () => Promise<unknown>) {
  internals.H = {
    useRef: (value: unknown) => ({ current: value }),
    useCallback: (fn: unknown) => fn,
    useEffect: noop,
  }
  useChatStore.getState().reset()
  spyOn(registries, 'whenRegistriesReady').mockResolvedValue(undefined)
  spyOn(clients, 'getCodebuffClient').mockImplementation(
    async () =>
      ({ run }) as unknown as Awaited<
        ReturnType<typeof clients.getCodebuffClient>
      >,
  )
  spyOn(providers, 'getOpenbuffProviderReadiness').mockReturnValue({ ok: true })
  spyOn(agents, 'loadAgentDefinitions').mockReturnValue([])
  spyOn(configs, 'createRunConfig').mockReturnValue(
    {} as ReturnType<typeof configs.createRunConfig>,
  )
  spyOn(journals, 'openRunJournalForRun').mockReturnValue(undefined)
  spyOn(storage, 'saveChatState').mockImplementation(noop)
  spyOn(storage, 'clearCheckpoint').mockResolvedValue(undefined)
  const chain = { current: false }
  const processing = { current: true }
  let canQueue = true
  const hook = useSendMessage({
    inputRef: { current: null },
    activeSubagentsRef: { current: new Set<string>() },
    isChainInProgressRef: chain,
    setStreamStatus: noop,
    setContextWindowUsage: noop,
    setCompactionNotice: noop,
    setCanProcessQueue: (value) => {
      canQueue = value
    },
    abortControllerRef: { current: null },
    onBeforeMessageSend: async () => ({ success: true, errors: [] }),
    mainAgentTimer: {
      start: noop,
      stop: noop,
      pause: noop,
      resume: noop,
      elapsedSeconds: 0,
      startTime: null,
      isPaused: false,
    },
    scrollToLatest: noop,
    continueChat: false,
    isProcessingQueueRef: processing,
    isQueuePausedRef: { current: false },
    resumeQueue: () => {
      canQueue = true
    },
  })
  return { hook, chain, processing, canQueue: () => canQueue }
}

describe('send caller snapshot ownership', () => {
  test('replacement cannot mutate the tree before the old snapshot settles', async () => {
    const barrier = captureBarrier()
    const newerStarted = deferred()
    const newerRun = deferred<typeof runState>()
    let runs = 0
    let started = false
    const state = callerHarness(async () => {
      if (++runs === 1) return runState
      started = true
      writeFileSync(path.join(repo, 'tracked.txt'), 'turn-B\n')
      newerStarted.resolve()
      return newerRun.promise
    })
    const oldPending = state.hook.sendMessage({
      content: 'turn A',
      agentMode: 'DEFAULT',
    })
    let newerPending: Promise<unknown> | undefined
    try {
      await barrier.reached
      state.hook.clearMessages()
      useChatStore.getState().setMessages([])
      newerPending = state.hook.sendMessage({
        content: 'turn B',
        agentMode: 'DEFAULT',
      })
      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(started).toBe(false)
      barrier.release()
      await newerStarted.promise
      const outcome = await barrier.settled
      expect(outcome.status).toBe('created')
      if (outcome.status !== 'created')
        throw new Error('Missing turn A snapshot')
      expect((await git('show', `${outcome.sha}:tracked.txt`)).stdout).toBe(
        'turn-A\n',
      )
      expect(readFileSync(path.join(repo, 'tracked.txt'), 'utf8')).toBe(
        'turn-B\n',
      )
    } finally {
      barrier.release()
      newerRun.resolve(runState)
      await oldPending
      await newerPending
    }
  })

  test('admission resolves before snapshot completion while execution ownership keeps the queue closed', async () => {
    const barrier = captureBarrier()
    const state = callerHarness(async () => runState)
    const admission = await state.hook.sendMessage({
      content: 'turn A',
      agentMode: 'DEFAULT',
    })
    expect(admission).toMatchObject({
      status: 'accepted',
      disposition: 'started',
    })
    if (admission.status !== 'accepted' || admission.disposition !== 'started')
      throw new Error('started admission did not expose execution completion')
    let completed = false
    const completion = admission.completion.then(() => {
      completed = true
    })
    try {
      await barrier.reached
      expect(completed).toBe(false)
      expect(state.chain.current).toBe(true)
      expect(state.processing.current).toBe(true)
      expect(state.canQueue()).toBe(false)
    } finally {
      barrier.release()
      await completion
    }
    expect(state.chain.current).toBe(false)
    expect(state.canQueue()).toBe(true)
  })

  test('superseded completion cannot release a newer send during snapshot capture', async () => {
    const barrier = captureBarrier()
    const newerStarted = deferred()
    const newerRun = deferred<typeof runState>()
    let runs = 0
    const state = callerHarness(async () => {
      if (++runs === 1) return runState
      newerStarted.resolve()
      return newerRun.promise
    })
    const oldPending = state.hook.sendMessage({
      content: 'turn A',
      agentMode: 'DEFAULT',
    })
    let newerPending: Promise<unknown> | undefined
    try {
      await barrier.reached
      state.hook.clearMessages()
      useChatStore.getState().setMessages([])
      newerPending = state.hook.sendMessage({
        content: 'turn B',
        agentMode: 'DEFAULT',
      })
      barrier.release()
      await newerStarted.promise
      await oldPending
      expect(state.chain.current).toBe(true)
      expect(state.canQueue()).toBe(false)
      expect(state.processing.current).toBe(true)
    } finally {
      barrier.release()
      newerRun.resolve(runState)
      await oldPending
      await newerPending
    }
  })
})
