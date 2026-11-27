import type { AskUserQuestion } from '../tools/params/tool/ask-user'

export type AskUserApproval = {
  action: string
  target: string
  reason: string
  risk: 'routine' | 'high'
}

/** Local inspection text is retained independently of bounded question labels. */
export type InspectableAskUserQuestion = AskUserQuestion & {
  inspectionText?: string
}

export type AskUserRequest = {
  toolCallId: string
  requestId: string
  questions: InspectableAskUserQuestion[]
  approval?: AskUserApproval
  resolve: (response: any) => void
}

type Listener = (request: AskUserRequest | null) => void

let pendingRequest: AskUserRequest | null = null
const waiting: AskUserRequest[] = []
const listeners: Listener[] = []

export const AskUserBridge = {
  request: (
    toolCallId: string,
    questions: InspectableAskUserQuestion[],
    signal?: AbortSignal,
    approval?: AskUserApproval,
  ) => {
    return new Promise((resolve) => {
      const requestId = crypto.randomUUID()
      const request: AskUserRequest = {
        toolCallId,
        requestId,
        questions,
        approval: approval ? { ...approval } : undefined,
        resolve: (response) => {
          signal?.removeEventListener('abort', cancel)
          resolve(response)
        },
      }
      const cancel = () => {
        if (pendingRequest?.requestId === requestId) {
          pendingRequest = waiting.shift() ?? null
          request.resolve({ skipped: true })
          notifyListeners()
        } else {
          const index = waiting.findIndex(
            (item) => item.requestId === requestId,
          )
          if (index >= 0) waiting.splice(index, 1)
          request.resolve({ skipped: true })
        }
      }
      if (signal?.aborted) {
        resolve({ skipped: true })
        return
      }
      signal?.addEventListener('abort', cancel, { once: true })
      if (pendingRequest) waiting.push(request)
      else {
        pendingRequest = request
        notifyListeners()
      }
    })
  },

  submit: (response: any, requestId?: string) => {
    if (
      pendingRequest &&
      (!requestId || requestId === pendingRequest.requestId)
    ) {
      const completed = pendingRequest
      pendingRequest = waiting.shift() ?? null
      completed.resolve(response)
      notifyListeners()
    }
  },

  getPendingRequest: () => pendingRequest,
  cancelAll: () => {
    const requests = [...(pendingRequest ? [pendingRequest] : []), ...waiting]
    pendingRequest = null
    waiting.length = 0
    requests.forEach((request) => request.resolve({ skipped: true }))
    notifyListeners()
  },

  subscribe: (listener: Listener) => {
    listeners.push(listener)
    listener(pendingRequest)
    return () => {
      const idx = listeners.indexOf(listener)
      if (idx !== -1) listeners.splice(idx, 1)
    }
  },
}

function notifyListeners() {
  listeners.forEach((l) => l(pendingRequest))
}
