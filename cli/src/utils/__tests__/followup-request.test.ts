import { expect, test } from 'bun:test'
import {
  requestFollowupSubmission,
  type FollowupSubmissionDetail,
} from '../followup-request'

test('followup dispatch requires explicit acceptance, shares a pending request and never treats undefined as accepted', async () => {
  let requests = 0
  let complete!: FollowupSubmissionDetail['complete']
  const listener = (event: Event) => {
    const request = event as CustomEvent<FollowupSubmissionDetail>
    if (request.detail.toolCallId !== 'request-contract') return
    event.preventDefault()
    requests++
    complete = request.detail.complete
  }
  globalThis.addEventListener('codebuff:send-followup', listener)
  try {
    const first = requestFollowupSubmission(
      'exact prompt',
      0,
      'request-contract',
    )
    const second = requestFollowupSubmission(
      'exact prompt',
      0,
      'request-contract',
    )
    expect(first).toBe(second)
    expect(requests).toBe(1)
    complete(undefined as never, 'Missing acceptance receipt')
    expect((await first).accepted).toBe(false)
    const retry = requestFollowupSubmission(
      'exact prompt',
      0,
      'request-contract',
    )
    expect(requests).toBe(2)
    complete(true)
    expect((await retry).accepted).toBe(true)
    expect(
      (await requestFollowupSubmission('exact prompt', 0, 'request-contract'))
        .accepted,
    ).toBe(true)
    expect(requests).toBe(2)
  } finally {
    globalThis.removeEventListener('codebuff:send-followup', listener)
  }
})

test('missing followup event owner is an explicit unavailable dispatcher', async () => {
  expect(
    await requestFollowupSubmission('exact prompt', 0, 'missing-owner'),
  ).toEqual({
    accepted: false,
    error:
      'The followup dispatcher is unavailable. Try again after returning to the conversation.',
  })
})
