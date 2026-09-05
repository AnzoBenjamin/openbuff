// Shared bounded fan-out for SDK tools. A tool that maps over N paths must not
// open N concurrent filesystem operations, so every such tool routes through
// this one helper instead of carrying its own copy of the loop.

/**
 * Rethrows the signal's own `reason` when it carries one, so a caller-supplied
 * cancellation error reaches the caller unchanged instead of being replaced by
 * a generic abort. Lives next to the bounded loop below because that loop is
 * what has to observe cancellation between items.
 */
export function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return
  throw signal.reason instanceof Error
    ? signal.reason
    : new DOMException('Operation aborted', 'AbortError')
}

/**
 * Applies `map` over `values` with at most `concurrency` calls in flight.
 *
 * Results are index-aligned with `values`, so a caller may keep accounting that
 * depends on input order. Abort is checked between items rather than mid-flight:
 * an already-started operation settles, and the next one throws.
 *
 * Failure is bounded the same way, and is part of the contract: the first
 * mapper rejection (or abort) wins, no further item is handed out, every
 * already-started call is awaited, and only then is that first error rethrown.
 * So a rejection never leaves workers issuing filesystem work in the background
 * that the caller can no longer observe or await, and items past the failure
 * point are never started at all.
 *
 * Precondition: `concurrency` must be a positive integer. A value below 1, a
 * non-integer, or a non-finite one would size the worker pool at zero (or NaN)
 * and resolve a full-length array of holes with no mapper having run, so it
 * throws a `RangeError` naming the received value before anything is allocated
 * or scheduled — including when `values` is empty, since an invalid limit is a
 * caller bug whether or not there is work to do.
 */
export async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  map: (value: T, index: number) => Promise<R>,
  signal?: AbortSignal,
): Promise<R[]> {
  // Checked before `results` is allocated and before anything is scheduled: a
  // limit below 1 (or a non-integer/non-finite one) spawns zero workers, which
  // would silently resolve an array of holes instead of failing. Validated
  // regardless of `values.length`, because an invalid limit is a caller bug
  // whether or not there is work to do.
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new RangeError(
      `mapWithConcurrency requires a positive integer concurrency, received ${concurrency}: a limit below 1 spawns no workers, so no mapper would run and the call would resolve with holes.`,
    )
  }
  const results = new Array<R>(values.length)
  let nextIndex = 0
  // Boxed so a thrown `undefined` still registers as a failure. Workers settle
  // normally and the error is rethrown below, which is what lets every started
  // call finish before this function returns.
  let failure: { error: unknown } | undefined
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, async () => {
      while (!failure && nextIndex < values.length) {
        try {
          throwIfAborted(signal)
          const index = nextIndex++
          results[index] = await map(values[index]!, index)
        } catch (error) {
          failure ??= { error }
        }
      }
    }),
  )
  if (failure) throw failure.error
  return results
}
