export type ProviderDiagnostic = {
  id: string
  state: 'running' | 'succeeded' | 'failed' | 'cancelled'
  message: string
}

/** A small worker pool reports settled rows immediately; abort also releases hung callers. */
export async function runProviderDiagnostics({
  ids,
  signal,
  check,
  onResult,
  concurrency = 3,
}: {
  ids: string[]
  signal: AbortSignal
  check: (
    id: string,
    signal: AbortSignal,
  ) => Promise<{ ok: boolean; message: string }>
  onResult: (result: ProviderDiagnostic) => void
  concurrency?: number
}): Promise<void> {
  let cursor = 0
  const workers = Array.from(
    { length: Math.min(ids.length, Math.max(1, concurrency)) },
    async () => {
      while (!signal.aborted && cursor < ids.length) {
        const id = ids[cursor++]
        onResult({ id, state: 'running', message: `Checking ${id}…` })
        let listener: (() => void) | undefined
        const cancelled = new Promise<null>((resolve) => {
          listener = () => resolve(null)
          signal.addEventListener('abort', listener, { once: true })
          if (signal.aborted) resolve(null)
        })
        try {
          const result = await Promise.race([check(id, signal), cancelled])
          if (!signal.aborted && result)
            onResult({
              id,
              state: result.ok ? 'succeeded' : 'failed',
              message: result.message,
            })
        } catch (error) {
          if (!signal.aborted)
            onResult({
              id,
              state: 'failed',
              message: `${id}: ${error instanceof Error ? error.message : String(error)}`,
            })
        } finally {
          if (listener) signal.removeEventListener('abort', listener)
        }
      }
    },
  )
  await Promise.all(workers)
}
