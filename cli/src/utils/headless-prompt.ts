export const HEADLESS_STDIN_MAX_BYTES = 1_000_000

export type HeadlessPromptInput = AsyncIterable<Uint8Array | string> & {
  destroy?: () => unknown
}

/** Read bounded UTF-8 input without taking over an interactive terminal. */
export async function readHeadlessPrompt(params: {
  input: HeadlessPromptInput
  isTTY: boolean | undefined
  signal?: AbortSignal
}): Promise<string> {
  if (params.isTTY === true)
    throw new Error(
      'A prompt is required: pass text, use -p <prompt>, or pipe UTF-8 text to stdin.',
    )
  const { signal, input } = params
  const abortReason = () =>
    signal?.reason instanceof Error
      ? signal.reason
      : new Error(String(signal?.reason ?? 'Reading stdin was cancelled'))
  const iterator = input[Symbol.asyncIterator]()
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let complete = false
  let onAbort: (() => void) | undefined
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(abortReason())
    signal?.addEventListener('abort', onAbort, { once: true })
  })
  let bytes = 0
  let prompt = ''
  try {
    if (signal?.aborted) throw abortReason()
    while (true) {
      const next = await Promise.race([iterator.next(), aborted])
      if (next.done) {
        complete = true
        break
      }
      const chunk =
        typeof next.value === 'string'
          ? new TextEncoder().encode(next.value)
          : next.value
      bytes += chunk.byteLength
      if (bytes > HEADLESS_STDIN_MAX_BYTES)
        throw new Error(
          `stdin prompt exceeds the ${HEADLESS_STDIN_MAX_BYTES}-byte limit; pass a smaller task and refer to project files instead.`,
        )
      try {
        prompt += decoder.decode(chunk, { stream: true })
      } catch {
        throw new Error('stdin prompt must contain valid UTF-8 text.')
      }
    }
    try {
      prompt += decoder.decode()
    } catch {
      throw new Error('stdin prompt must contain valid UTF-8 text.')
    }
    if (!prompt.trim())
      throw new Error(
        'stdin contained no prompt text; pass a prompt or use -p <prompt>.',
      )
    if (signal?.aborted) throw abortReason()
    return prompt
  } finally {
    if (onAbort) signal?.removeEventListener('abort', onAbort)
    if (!complete) {
      input.destroy?.()
      // An arbitrary injected iterator may ignore cancellation. Do not wait
      // forever for its return path; Node stdin is destroyed above.
      try {
        void Promise.resolve(iterator.return?.()).catch(() => {})
      } catch {
        /* best effort */
      }
    }
  }
}
