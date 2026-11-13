export type LaunchIntent = ReturnType<typeof createLaunchIntent>

export function createLaunchIntent(
  prompt: string | null,
  enabled: boolean,
  id?: string,
) {
  let pendingPrompt = prompt
  let continuation = { enabled, id }
  return {
    peekPrompt: () => pendingPrompt,
    claimPrompt: (expected: string) => {
      if (pendingPrompt !== expected) return false
      pendingPrompt = null
      return true
    },
    peekContinuation: () => continuation,
    consumeContinuation: () => {
      continuation = { enabled: false, id: undefined }
    },
    discard: () => {
      pendingPrompt = null
      continuation = { enabled: false, id: undefined }
    },
  }
}
