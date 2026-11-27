import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, expect, mock, spyOn, test } from 'bun:test'
import React from 'react'

import { useChatStore } from '../../state/chat-store'
import { finishBashCommand, registerBashCommand } from '../../utils/bash-command-controller'
import * as snapshots from '../../utils/turn-snapshots'
import { useChatStreaming } from '../use-chat-streaming'
import {
  completedRun,
  completionOf,
  mountRealSend,
  noop,
  valid,
} from './fixtures/mount-send-queue'

import type { CommandResult } from '../../commands/command-registry'
import type { PromptAdmissionResult, SendMessageFn } from '../../types/contracts/send-message'
import type { UseChatStreamingReturn } from '../use-chat-streaming'
import type { Client } from './fixtures/mount-send-queue'
import type { RunState } from '@openbuff/sdk'

const renderTest = process.env.NODE_ENV === 'production' ? test.skip : test
afterEach(() => {
  mock.restore()
  useChatStore.getState().reset()
})

for (const enqueueDuringAbort of [false, true]) {
  renderTest(
    `interrupt pauses queued admission before synchronous abort cleanup (enqueueDuringAbort=${enqueueDuringAbort})`,
    async () => {
      const { testRender } = await import('@opentui/react/test-utils')
      const chain = { current: true }
      const active = { current: 0 }
      const sent: Parameters<SendMessageFn>[0][] = []
      const controller = new AbortController()
      let queue!: UseChatStreamingReturn
      let pauseObservedByAbort: boolean | undefined
      const sendRef = {
        current: async (message: Parameters<SendMessageFn>[0]) => {
          chain.current = true
          sent.push(message)
          return {
            status: 'accepted',
            disposition: 'started',
            completion: Promise.resolve(),
          } as const
        },
      }
      function Host() {
        queue = useChatStreaming({
          agentMode: 'DEFAULT',
          inputValue: '',
          setInputValue: () => {},
          terminalWidth: 80,
          separatorWidth: 78,
          isChainInProgressRef: chain,
          activeAgentStreamsRef: active,
          sendMessageRef: sendRef,
        })
        return <text>{queue.queuePaused ? 'Queue paused' : 'Queue ready'}</text>
      }
      const client = new QueryClient()
      let setup: Awaited<ReturnType<typeof testRender>> | undefined
      try {
        await React.act(async () => {
          setup = await testRender(
            <QueryClientProvider client={client}>
              <Host />
            </QueryClientProvider>,
            { width: 80, height: 8 },
          )
        })
        const interruptFromPreviousRender = queue.interruptStreaming
        controller.signal.addEventListener(
          'abort',
          () => {
            pauseObservedByAbort = queue.isQueuePausedRef.current
            if (enqueueDuringAbort)
              queue.addToQueue('retain this prompt', [], 'PLAN')
            chain.current = false
            queue.stopStreaming()
            // Even a stale completion callback setting the state gate true cannot
            // clear the synchronously published user-pause ref.
            queue.setCanProcessQueue(true)
          },
          { once: true },
        )
        await React.act(async () => {
          if (!enqueueDuringAbort)
            queue.addToQueue('retain this prompt', [], 'PLAN')
          interruptFromPreviousRender(controller)
        })
        await setup!.renderOnce()
        expect(controller.signal.aborted).toBe(true)
        expect(pauseObservedByAbort).toBe(true)
        expect(queue.queuePaused).toBe(true)
        expect(sent).toEqual([])
        expect(queue.queuedMessages.map((message) => message.content)).toEqual([
          'retain this prompt',
        ])
        expect(setup!.captureCharFrame()).toContain('Queue paused')
        await React.act(async () => queue.resumeQueue())
        expect(sent).toEqual([
          { content: 'retain this prompt', agentMode: 'PLAN', attachments: [] },
        ])
        expect(queue.queuedMessages).toEqual([])

        // A later explicit resume is independent of the abort listener and
        // works even if both operations happen before a new render.
        const resumeFromPreviousRender = queue.resumeQueue
        await React.act(async () => {
          queue.interruptStreaming(null)
          resumeFromPreviousRender()
        })
        expect(queue.isQueuePausedRef.current).toBe(false)
      } finally {
        await React.act(async () => setup?.renderer.destroy())
        client.clear()
      }
    },
  )
}

for (const settlement of ['resolve', 'reject'] as const) {
  renderTest(`real send finalizer keeps the interrupt pause when the SDK ${settlement}s`, async () => {
    const terminal = Promise.withResolvers<RunState>()
    const followUp = Promise.withResolvers<void>()
    const preserved: RunState = { output: { type: 'lastMessage', value: [] } }
    const run = mock((request: Parameters<Client['run']>[0]) => {
      if (request.prompt === 'Active prompt') return terminal.promise
      followUp.resolve()
      return Promise.reject(new Error('Offline follow-up fixture'))
    })
    const state = await mountRealSend(run)
    let admission: PromptAdmissionResult | undefined
    try {
      await React.act(async () => {
        admission = await state.send({ content: 'Active prompt', agentMode: 'DEFAULT' })
      })
      const completion = completionOf(admission)
      expect(completion).toBeInstanceOf(Promise)
      expect(run).toHaveBeenCalledTimes(1)
      const controller = state.abort.current!
      await React.act(async () => {
        state.streaming.addToQueue('Unsent follow-up', [], 'PLAN')
        state.streaming.interruptStreaming(controller)
      })
      expect(controller.signal.aborted).toBe(true)
      expect(state.streaming.streamStatus).toBe('cancelling')
      expect(state.chain.current).toBe(true)

      await React.act(async () => {
        if (settlement === 'resolve') terminal.resolve(preserved)
        else terminal.reject(new DOMException('Cancelled', 'AbortError'))
        await completion
      })
      expect(state.streaming.streamStatus).toBe('idle')
      expect(state.chain.current).toBe(false)
      expect(state.streaming.isQueuePausedRef.current).toBe(true)
      expect(state.streaming.queuePaused).toBe(true)
      expect(run).toHaveBeenCalledTimes(1)
      expect(state.streaming.queuedMessages.map(({ content }) => content)).toEqual(['Unsent follow-up'])
      if (settlement === 'resolve') expect(useChatStore.getState().runState).toBe(preserved)

      await React.act(async () => state.streaming.resumeQueue())
      await React.act(async () => { await followUp.promise })
      expect(run).toHaveBeenCalledTimes(2)
      expect(run.mock.calls[1]?.[0].prompt).toBe('Unsent follow-up')
      expect(state.streaming.queuedMessages).toEqual([])
    } finally {
      await React.act(async () => {
        terminal.resolve(preserved)
        await completionOf(admission)
      })
      await state.destroy()
    }
  })
}

renderTest('/bisect-turn cannot launch after a real prompt claims the snapshot-listing gap', async () => {
  const listing = Promise.withResolvers<Awaited<ReturnType<typeof snapshots.listTurnSnapshots>>>()
  const validation = Promise.withResolvers<typeof valid>()
  const list = spyOn(snapshots, 'listTurnSnapshots').mockReturnValue(listing.promise)
  const start = spyOn(snapshots, 'runTurnBisection').mockResolvedValue({ status: 'no-snapshots' })
  const run = mock(async () => { throw new Error('Offline prompt fixture') })
  const state = await mountRealSend(run, () => validation.promise)
  let prompt: ReturnType<SendMessageFn> | undefined
  try {
    await React.act(async () => {
      await state.route('/bisect-turn')
      expect(list).toHaveBeenCalledTimes(1)
      expect(state.chain.current).toBe(false)
      prompt = state.send({ content: 'Claimed during listing', agentMode: 'DEFAULT' })
      expect(state.chain.current).toBe(true)
      expect(state.streaming.streamStatus).toBe('idle')
      listing.resolve([])
      await listing.promise
    })
    expect(start).not.toHaveBeenCalled()
    expect(run).not.toHaveBeenCalled()
    const transcript = useChatStore.getState().messages.map(({ content }) => content).join('\n')
    expect(transcript).toContain('a turn is in progress')
    expect(transcript).not.toContain('bisecting 0 snapshots')
  } finally {
    await React.act(async () => {
      listing.resolve([])
      validation.resolve(valid)
      await completionOf(await prompt)
    })
    await state.destroy()
  }
  expect(run).toHaveBeenCalledTimes(1)
})

renderTest('/bisect-turn cannot start while a shell command owns dispatch', async () => {
  const listing = Promise.withResolvers<Awaited<ReturnType<typeof snapshots.listTurnSnapshots>>>()
  const list = spyOn(snapshots, 'listTurnSnapshots').mockReturnValue(listing.promise)
  const start = spyOn(snapshots, 'runTurnBisection').mockResolvedValue({ status: 'no-snapshots' })
  const state = await mountRealSend(async () => completedRun)
  const id = 'bisection-shell-owner-fixture'
  try {
    await React.act(async () => {
      await state.route('/bisect-turn')
      expect(list).toHaveBeenCalledTimes(1)
      registerBashCommand(id)
      listing.resolve([])
    })
    expect(start).not.toHaveBeenCalled()
    expect(useChatStore.getState().messages.at(-1)?.content).toContain('a shell command is in progress')
  } finally {
    listing.resolve([])
    finishBashCommand(id)
    await state.destroy()
  }
})

renderTest('the completion edge can start the next prompt without using a stale render or abort controller', async () => {
  const oldRun = Promise.withResolvers<RunState>()
  const newRun = Promise.withResolvers<RunState>()
  const run = mock(({ prompt }: Parameters<Client['run']>[0]) =>
    prompt === 'Old turn' ? oldRun.promise : newRun.promise,
  )
  const state = await mountRealSend(run)
  let oldAdmission: CommandResult = undefined
  let next: ReturnType<typeof state.route> | undefined
  let unsubscribe = noop
  try {
    await React.act(async () => { oldAdmission = await state.route('Old turn') })
    const staleController = state.abort.current!
    expect(state.streaming.isStreaming).toBe(true)
    unsubscribe = useChatStore.subscribe((current, previous) => {
      if (previous.isChainInProgress && !current.isChainInProgress && !next)
        next = state.route('New turn')
    })
    await React.act(async () => {
      oldRun.resolve(completedRun)
      await completionOf(oldAdmission)
      expect(await next).toMatchObject({ status: 'accepted', disposition: 'started' })
      staleController.abort()
    })
    expect(run).toHaveBeenCalledTimes(2)
    expect(state.chain.current).toBe(true)
    expect(state.streaming.streamStatus).toBe('waiting')
    expect(state.abort.current?.signal.aborted).toBe(false)
  } finally {
    unsubscribe()
    await React.act(async () => {
      oldRun.resolve(completedRun)
      newRun.resolve(completedRun)
      await completionOf(oldAdmission)
      await completionOf(await next)
    })
    await state.destroy()
  }
})

renderTest('common send refuses an active bisection without consuming prompt context', async () => {
  const run = mock(async () => { throw new Error('Offline prompt fixture') })
  const validate = mock(async () => valid)
  const state = await mountRealSend(run, validate)
  spyOn(snapshots, 'isTurnBisectionRunning').mockReturnValue(true)
  const onAccepted = mock(noop)
  const pendingAttachments = [
    { kind: 'text' as const, id: 'attachment', content: 'keep', preview: 'keep', charCount: 4 },
  ]
  const pendingBashMessages = [
    { id: 'shell', command: 'echo context', stdout: 'context', stderr: '', exitCode: 0, isRunning: false },
  ]
  useChatStore.setState({ inputValue: 'Unsent draft', pendingAttachments, pendingBashMessages })
  try {
    let result: PromptAdmissionResult | undefined
    await React.act(async () => {
      result = await state.send({ content: 'Unsent draft', agentMode: 'DEFAULT', onAccepted })
      await completionOf(result)
    })
    expect(result).toEqual({ status: 'not-started', reason: 'bisection-active' })
    expect(state.chain.current).toBe(false)
    expect(validate).not.toHaveBeenCalled()
    expect(state.getClient).not.toHaveBeenCalled()
    expect(run).not.toHaveBeenCalled()
    expect(onAccepted).not.toHaveBeenCalled()
    expect(useChatStore.getState()).toMatchObject({
      inputValue: 'Unsent draft', pendingAttachments, pendingBashMessages, messages: [],
    })
    expect(useChatStore.getState().messages).toHaveLength(0)
  } finally {
    await state.destroy()
  }
})

renderTest('the real bisection gate stops mounted prompt paths while exact stop and list stay local', async () => {
  const root = mkdtempSync(join(tmpdir(), 'openbuff-b10-bisect-'))
  const rows = ['c', 'b', 'a'].map((hex, index) => `${hex.repeat(40)} ${3 - index} fixture-${hex}`)
  const checkouts: string[] = []
  const runGit: snapshots.GitRunner = async (args, { cwd }) => {
    expect(cwd).toBe(root)
    switch (args[0]) {
      case 'rev-parse': return { stdout: 'fixture-ref', stderr: '' }
      case 'log': return { stdout: rows.join('\n'), stderr: '' }
      case 'read-tree': checkouts.push(args[1]!); break
      case 'checkout-index': break
      default: throw new Error(`Unexpected git operation: ${args.join(' ')}`)
    }
    return { stdout: '', stderr: '' }
  }
  const probeEntered = Promise.withResolvers<void>()
  const probe = Promise.withResolvers<boolean>()
  const run = mock((_request: Parameters<Client['run']>[0]) => Promise.resolve(completedRun))
  const validate = mock(async () => valid)
  const state = await mountRealSend(run, validate, root)
  const originalList = snapshots.listTurnSnapshots
  const list = spyOn(snapshots, 'listTurnSnapshots').mockImplementation(() =>
    originalList({ projectRoot: root }, { runGit }),
  )
  const cancel = spyOn(snapshots, 'cancelTurnBisection')
  const bisection = snapshots.runTurnBisection({ projectRoot: root }, {
    runGit,
    runTestSuite: async () => {
      probeEntered.resolve()
      return probe.promise
    },
  })
  const source = { kind: 'text' as const, id: 'retained', content: 'source', preview: 'source', charCount: 6 }
  const originalDraft = { text: 'Unsent draft', cursorPosition: 5, lastEditDueToNav: true }
  const transcript = () => useChatStore.getState().messages.map(({ content }) => content).join('\n')
  try {
    await probeEntered.promise
    expect(snapshots.isTurnBisectionRunning()).toBe(true)
    expect(snapshots.isTurnBisectionLockHeld(root)).toBe(true)
    expect(checkouts).toEqual([`${'a'.repeat(40)}^{tree}`])
    const store = useChatStore.getState()
    store.setAgentMode('DEFAULT')
    store.setInputValue(originalDraft)
    store.addPendingAttachment(source)
    await React.act(async () => {
      for (const [input, overrides] of [
        [originalDraft.text, {}],
        ['/mode:plan inspect', { preserveInputValue: true }],
        ['/resume-plan selected-session', { preserveInputValue: true }],
        ['Build it!', { preserveInputValue: true, agentMode: 'EXECUTE_PLAN' }],
      ] as const) {
        expect(await state.route(input, overrides)).toEqual({ status: 'not-started', reason: 'bisection-active' })
      }
      store.setInputMode('review')
      expect(await state.route(originalDraft.text)).toEqual({ status: 'not-started', reason: 'bisection-active' })
      store.setInputMode('default')
      state.streaming.addToQueue('Queued during the probe', [source], 'PLAN')
    })
    expect(state.streaming.queueError).toContain('bisection is active')
    const queueHead = state.streaming.queuedMessages[0]
    expect(queueHead?.attachments[0]).toBe(source)
    expect(useChatStore.getState()).toMatchObject({
      inputValue: originalDraft.text, cursorPosition: 5, lastEditDueToNav: true,
      pendingAttachments: [source], agentMode: 'DEFAULT',
    })
    expect(state.getClient).not.toHaveBeenCalled()
    expect(validate).not.toHaveBeenCalled()
    expect(run).not.toHaveBeenCalled()

    await React.act(async () => {
      await state.route('/bisect-turn stop-now', { preserveInputValue: true })
      expect(cancel).not.toHaveBeenCalled()
      await state.route('  /BISECT-TURN\tlist  ', { preserveInputValue: true })
    })
    expect(list).toHaveBeenCalled()
    expect(transcript()).toContain('fixture-a')
    expect(snapshots.isTurnBisectionRunning()).toBe(true)
    await React.act(async () => {
      await state.route('  /BISECT-TURN\tstop  ', { preserveInputValue: true })
    })
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(snapshots.isTurnBisectionRunning()).toBe(true)
    probe.resolve(false)
    expect(await bisection).toEqual({ status: 'cancelled' })
    expect(checkouts.at(-1)).toBe(`${'c'.repeat(40)}^{tree}`)
    expect(snapshots.isTurnBisectionLockHeld(root)).toBe(false)
    expect(state.streaming.queuedMessages[0]).toBe(queueHead)
    expect(state.streaming.queuePaused).toBe(true)
    await React.act(async () => { await completionOf(await state.route(originalDraft.text)) })
    expect(run.mock.calls[0]?.[0]?.prompt).toBe('Unsent draft\n\n[Pasted Text]\nsource')
    expect(state.streaming.queuedMessages[0]).toBe(queueHead)
  } finally {
    probe.resolve(false)
    await bisection
    await state.destroy()
    rmSync(root, { recursive: true, force: true })
  }
})

renderTest('parser-approved reset pauses retained work; a lookalike or busy reset-with-prompt cannot cancel the turn', async () => {
  const terminal = Promise.withResolvers<RunState>()
  const run = mock(() => terminal.promise)
  const state = await mountRealSend(run)
  let started: CommandResult = undefined
  const initial = { text: '/new First message', cursorPosition: 4, lastEditDueToNav: true }
  try {
    await React.act(async () => {
      started = await state.route('Active turn')
      state.streaming.addToQueue('Existing work', [], 'PLAN')
    })
    const controller = state.abort.current!
    const existing = state.streaming.queuedMessages[0]
    expect(existing?.content).toBe('Existing work')
    await React.act(async () => {
      await state.route('/newer', { preserveInputValue: true })
      const ordinary = await state.route('new plus words', { preserveInputValue: true })
      expect(ordinary).toEqual({ status: 'accepted', disposition: 'queued' })
      useChatStore.getState().setInputValue(initial)
      expect(await state.route(initial.text)).toMatchObject({ status: 'not-started' })
    })
    expect(controller.signal.aborted).toBe(false)
    expect(useChatStore.getState()).toMatchObject({ inputValue: initial.text, cursorPosition: 4, lastEditDueToNav: true })
    expect(state.streaming.queuedMessages[0]).toBe(existing)
    expect(state.streaming.queuePaused).toBe(false)

    await React.act(async () => { await state.route('  /ReSeT  ', { preserveInputValue: true }) })
    expect(controller.signal.aborted).toBe(true)
    expect(state.chain.current).toBe(true)
    expect(state.streaming.queuePaused).toBe(true)
    await React.act(async () => {
      terminal.resolve(completedRun)
      await completionOf(started)
    })
    expect(state.chain.current).toBe(false)
    expect(run).toHaveBeenCalledTimes(1)
    expect(state.streaming.queuedMessages.map(({ content }) => content)).toEqual(['Existing work', 'new plus words'])
    expect(useChatStore.getState()).toMatchObject({ inputValue: initial.text, cursorPosition: 4 })
    expect(useChatStore.getState().runState).toBeNull()
  } finally {
    terminal.resolve(completedRun)
    await completionOf(started)
    await state.destroy()
  }
})
