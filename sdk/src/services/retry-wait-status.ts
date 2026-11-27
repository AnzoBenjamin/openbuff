type RetryWaitScheduler = Readonly<{
  now(): number
  set(delayMs: number, callback: () => void): unknown
  clear(timer: unknown): void
}>
const defaultScheduler: RetryWaitScheduler = {
  now: () => performance.now(),
  set(delay, callback) {
    const timer = setTimeout(callback, delay)
    timer.unref?.()
    return timer
  },
  clear(timer) {
    clearTimeout(timer as ReturnType<typeof setTimeout>)
  },
}

/** Observational only: one timer and one original sleep, with no renewed attempt or delay budget. */
export async function observeRetryWait(
  params: Readonly<{
    delayMs: number
    signal?: AbortSignal
    sleep(delayMs: number, signal?: AbortSignal): Promise<void>
    onRemaining(remainingMs: number): void
    scheduler?: RetryWaitScheduler
  }>,
): Promise<void> {
  const scheduler = params.scheduler ?? defaultScheduler
  const start = scheduler.now()
  let active = !params.signal?.aborted,
    timer: unknown,
    observed = false
  const clear = () => {
    if (timer !== undefined) scheduler.clear(timer)
    timer = undefined
  }
  const stop = () => {
    active = false
    clear()
  }
  const report = (remaining: number) => {
    try {
      params.onRemaining(remaining)
    } catch {
      /* Display observers cannot change retry behavior. */
    }
  }
  const tick = () => {
    timer = undefined
    if (!active || params.signal?.aborted) return
    const remaining = Math.max(
      0,
      params.delayMs - Math.max(0, scheduler.now() - start),
    )
    observed = true
    report(remaining)
    if (remaining > 0 && active && !params.signal?.aborted)
      timer = scheduler.set(Math.min(1_000, remaining), tick)
  }
  if (active && params.delayMs >= 1_000) timer = scheduler.set(1_000, tick)
  params.signal?.addEventListener('abort', stop, { once: true })
  try {
    await params.sleep(params.delayMs, params.signal)
    if (active && observed && !params.signal?.aborted) report(0)
  } finally {
    stop()
    params.signal?.removeEventListener('abort', stop)
  }
}
