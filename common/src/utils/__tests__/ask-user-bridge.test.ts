import { afterEach, expect, test } from 'bun:test'
import { AskUserBridge } from '../ask-user-bridge'

const questions = [
  {
    question: 'Choose',
    options: [{ label: 'A' }, { label: 'B' }],
    multiSelect: false,
  },
]
afterEach(() => AskUserBridge.cancelAll())
test('concurrent questions remain FIFO and stale submissions cannot answer the next request', async () => {
  const first = AskUserBridge.request('child-1', questions)
  const firstId = AskUserBridge.getPendingRequest()!.requestId
  const second = AskUserBridge.request('child-2', questions)
  AskUserBridge.submit(
    { answers: [{ questionIndex: 0, selectedOption: 'A' }] },
    firstId,
  )
  expect(await first).toEqual({
    answers: [{ questionIndex: 0, selectedOption: 'A' }],
  })
  expect(AskUserBridge.getPendingRequest()?.toolCallId).toBe('child-2')
  AskUserBridge.submit({ skipped: true }, firstId)
  expect(AskUserBridge.getPendingRequest()?.toolCallId).toBe('child-2')
  AskUserBridge.submit(
    { answers: [{ questionIndex: 0, selectedOption: 'B' }] },
    AskUserBridge.getPendingRequest()!.requestId,
  )
  expect(await second).toEqual({
    answers: [{ questionIndex: 0, selectedOption: 'B' }],
  })
})
test('aborting queued or active requests releases their promises and preserves other owners', async () => {
  const activeController = new AbortController()
  const waitingController = new AbortController()
  const first = AskUserBridge.request(
    'active',
    questions,
    activeController.signal,
  )
  const cancelled = AskUserBridge.request(
    'cancelled',
    questions,
    waitingController.signal,
  )
  const third = AskUserBridge.request('third', questions)
  waitingController.abort()
  expect(await cancelled).toEqual({ skipped: true })
  expect(AskUserBridge.getPendingRequest()?.toolCallId).toBe('active')
  activeController.abort()
  expect(await first).toEqual({ skipped: true })
  expect(AskUserBridge.getPendingRequest()?.toolCallId).toBe('third')
  AskUserBridge.cancelAll()
  expect(await third).toEqual({ skipped: true })
  expect(AskUserBridge.getPendingRequest()).toBeNull()
})
