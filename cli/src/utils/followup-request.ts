export interface FollowupSubmissionOutcome {
  accepted: boolean
  error?: string
}
export interface FollowupSubmissionDetail {
  prompt: string
  index: number
  toolCallId: string
  complete: (accepted: boolean, error?: string) => void
}
const inFlight = new Map<string, Promise<FollowupSubmissionOutcome>>()
const accepted = new Set<string>()

/** The event owner must preventDefault to claim the request and explicitly acknowledge acceptance. */
export function requestFollowupSubmission(
  prompt: string,
  index: number,
  toolCallId: string,
): Promise<FollowupSubmissionOutcome> {
  const key = `${toolCallId}:${index}`
  if (accepted.has(key)) return Promise.resolve({ accepted: true })
  const pending = inFlight.get(key)
  if (pending) return pending
  let complete!: FollowupSubmissionDetail['complete']
  const result = new Promise<FollowupSubmissionOutcome>((resolve) => {
    let settled = false
    complete = (acceptedResult, error) => {
      if (settled) return
      settled = true
      if (acceptedResult === true) {
        if (accepted.size >= 1000)
          accepted.delete(accepted.values().next().value!)
        accepted.add(key)
      }
      resolve({ accepted: acceptedResult === true, error })
    }
  })
  inFlight.set(key, result)
  try {
    const event = new CustomEvent<FollowupSubmissionDetail>(
      'codebuff:send-followup',
      { cancelable: true, detail: { prompt, index, toolCallId, complete } },
    )
    if (globalThis.dispatchEvent(event))
      complete(
        false,
        'The followup dispatcher is unavailable. Try again after returning to the conversation.',
      )
  } catch {
    complete(false, 'Could not request this followup. Try again.')
  }
  void result.finally(() => {
    if (inFlight.get(key) === result) inFlight.delete(key)
  })
  return result
}
