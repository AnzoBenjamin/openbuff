import { AskUserBridge } from '@codebuff/common/utils/ask-user-bridge'
import { afterEach, beforeEach, expect, test } from 'bun:test'
import React from 'react'

import { useChatStore } from '../../state/chat-store'
import { useAskUserBridge } from '../use-ask-user-bridge'

const mountedTest = process.env.NODE_ENV === 'production' ? test.skip : test
const questions = [
  {
    question: 'Choose',
    options: [{ label: 'A' }, { label: 'B' }],
    multiSelect: false,
  },
]

type HookValue = ReturnType<typeof useAskUserBridge>

beforeEach(() => {
  AskUserBridge.cancelAll()
  useChatStore.getState().reset()
  useChatStore.setState({
    inputValue: 'draft @file evidence\nsecond line',
    cursorPosition: 11,
    lastEditDueToNav: false,
    askUserState: null,
  })
})

afterEach(() => {
  AskUserBridge.cancelAll()
  useChatStore.getState().reset()
})

async function mountHook() {
  const { testRender } = await import('@opentui/react/test-utils')
  let hook!: HookValue
  function Host() {
    hook = useAskUserBridge()
    const requestId = useChatStore((state) => state.askUserState?.toolCallId)
    return React.createElement('text', null, requestId ?? 'none')
  }
  let setup!: Awaited<ReturnType<typeof testRender>>
  await React.act(async () => {
    setup = await testRender(React.createElement(Host), {
      width: 50,
      height: 4,
      exitOnCtrlC: false,
    })
  })
  return {
    setup,
    get hook() {
      return hook
    },
  }
}

mountedTest(
  'mounted hook binds submissions to the rendered request identity and preserves the draft',
  async () => {
    const mounted = await mountHook()
    try {
      let first!: Promise<unknown>
      let second!: Promise<unknown>
      await React.act(async () => {
        first = AskUserBridge.request('tool-first', questions)
        second = AskUserBridge.request('tool-second', questions)
      })
      const firstRequest = AskUserBridge.getPendingRequest()!
      expect(useChatStore.getState().askUserState?.toolCallId).toBe(
        firstRequest.requestId,
      )
      const staleSubmit = mounted.hook.submitAnswers
      const firstId = firstRequest.requestId

      await React.act(async () => {
        AskUserBridge.submit(
          { answers: [{ questionIndex: 0, selectedOption: 'A' }] },
          firstId,
        )
        await first
      })
      const secondRequest = AskUserBridge.getPendingRequest()!
      expect(secondRequest.toolCallId).toBe('tool-second')
      expect(useChatStore.getState().askUserState?.toolCallId).toBe(
        secondRequest.requestId,
      )

      staleSubmit([{ questionIndex: 0, selectedOption: 'stale' }])
      expect(AskUserBridge.getPendingRequest()?.toolCallId).toBe('tool-second')

      await React.act(async () => {
        mounted.hook.submitAnswers([{ questionIndex: 0, selectedOption: 'B' }])
        await second
      })
      expect(useChatStore.getState().askUserState).toBeNull()
      expect(useChatStore.getState().inputValue).toBe(
        'draft @file evidence\nsecond line',
      )
      expect(useChatStore.getState().cursorPosition).toBe(11)
    } finally {
      await React.act(async () => mounted.setup.renderer.destroy())
    }
  },
)

mountedTest(
  'mounted hook follows active and queued aborts and unsubscribes without cancelling legitimate requests',
  async () => {
    const mounted = await mountHook()
    const activeController = new AbortController()
    const queuedController = new AbortController()
    try {
      let active!: Promise<unknown>
      let queued!: Promise<unknown>
      await React.act(async () => {
        active = AskUserBridge.request(
          'tool-active',
          questions,
          activeController.signal,
        )
        queued = AskUserBridge.request(
          'tool-queued',
          questions,
          queuedController.signal,
        )
      })
      expect(AskUserBridge.getPendingRequest()?.toolCallId).toBe('tool-active')
      expect(useChatStore.getState().askUserState?.toolCallId).toBe(
        AskUserBridge.getPendingRequest()?.requestId,
      )

      queuedController.abort()
      expect(await queued).toEqual({ skipped: true })
      expect(AskUserBridge.getPendingRequest()?.toolCallId).toBe('tool-active')
      expect(useChatStore.getState().askUserState?.toolCallId).toBe(
        AskUserBridge.getPendingRequest()?.requestId,
      )

      await React.act(async () => activeController.abort())
      expect(await active).toEqual({ skipped: true })
      expect(useChatStore.getState().askUserState).toBeNull()

      await React.act(async () => mounted.setup.renderer.destroy())
      useChatStore.getState().setAskUserState(null)
      const afterUnmount = AskUserBridge.request(
        'tool-after-unmount',
        questions,
      )
      expect(useChatStore.getState().askUserState).toBeNull()
      // Unmount removes only this listener; it does not cancel bridge-owned work.
      expect(AskUserBridge.getPendingRequest()?.toolCallId).toBe(
        'tool-after-unmount',
      )
      AskUserBridge.cancelAll()
      expect(await afterUnmount).toEqual({ skipped: true })
    } finally {
      AskUserBridge.cancelAll()
      try {
        await React.act(async () => mounted.setup.renderer.destroy())
      } catch {
        // The assertion path may already have destroyed the renderer.
      }
    }
  },
)
