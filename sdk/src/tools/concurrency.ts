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
  throw abortReason(signal)
}

/** The error an aborted signal represents, preserving a caller-supplied reason. */
export function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException('Operation aborted', 'AbortError')
}

/**
 * Settles like `work`, but rejects with the signal's own reason as soon as that
 * signal aborts.
 *
 * For awaiting a SHARED, already-running operation on behalf of one caller. The
 * caller must stop waiting when it is cancelled, but the shared work must keep
 * running for whoever else is still interested, so `work` is never aborted —
 * only this caller's wait is. `work` keeps its own rejection handling, so the
 * loser of the race can never surface as an unhandled rejection.
 */
export function raceAbort<T>(
  work: Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (!signal) return work
  if (signal.aborted) {
    work.catch(() => {})
    return Promise.reject(abortReason(signal))
  }
  let onAbort = (): void => {}
  const cancelled = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(abortReason(signal))
  })
  signal.addEventListener('abort', onAbort, { once: true })
  return Promise.race([work, cancelled]).finally(() => {
    signal.removeEventListener('abort', onAbort)
    // Whoever loses the race settles with nobody attached.
    cancelled.catch(() => {})
  })
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

/**
 * Process-wide cap on concurrent filesystem syscalls issued by SDK tools.
 *
 * `mapWithConcurrency` bounds ONE call site, which is not the same thing as
 * bounding the process. Several SDK paths deliberately run bounded phases in
 * parallel — `collectManifestSnapshotAsync` starts its dotnet walk alongside its
 * manifest probes, and `inspect_environment` starts discovery alongside its
 * tool probes — so per-call-site widths of 8 add up to 16 or 24 simultaneous
 * requests against libuv's default four-thread pool, the same pool that serves
 * the CLI render loop's own fs work. A per-call-site width therefore cannot
 * deliver the protection its own docblock claims: it caps each phase while
 * leaving the aggregate, which is what the pool actually experiences,
 * unbounded. Only a process-wide bound can.
 *
 * Sized at one call-site width rather than at the pool's four threads: a single
 * phase keeps the width it was tuned for, while overlapping phases share that
 * width instead of multiplying it. The render loop's requests then queue behind
 * at most one batch in userspace, where the queue is FIFO and observable,
 * instead of behind an unbounded wash of discovery reads.
 */
export const FILESYSTEM_FANOUT_CONCURRENCY = 8

/**
 * Slots held back from any single phase, so no one caller can own the pool.
 *
 * A process-wide cap alone still permits the aggregation the gate exists to
 * prevent: one phase that enters at its own tuned width (the discovery walk, the
 * manifest pre-read, the affected-test collector all enter at 8) can occupy
 * EVERY slot, and an overlapping interactive phase then queues behind that whole
 * batch. `inspect_harness_environment` already starts discovery alongside its
 * fourteen tool probes, so the interactive guarantee degraded to "queue behind
 * up to one batch, twice, inside a single tool call".
 *
 * One slot reserved at full width: enough that any single phase always leaves a
 * slot for the render loop's own fs work, small enough that the interactive
 * headroom never serialises the wide phases (they run at 7 instead of 8, which
 * is the same order of magnitude and the same libuv pool behaviour).
 */
export const FILESYSTEM_RESERVED_INTERACTIVE_SLOTS = 1

let filesystemSlotsInUse = 0
let filesystemMaxSlotsInUse = 0
let filesystemMaxPhaseSlots = 0
/** Live slots held per phase label, so the cap can be per phase. */
const filesystemPhaseSlotsInUse: Record<string, number> = {}
/** Widest per-phase occupancy seen, for attribution in tests. */
const filesystemPhaseMaxSlots: Record<string, number> = {}

/**
 * Test seam: how many slots the widest single PHASE held at once since the last
 * reset.
 *
 * `__getFilesystemMaxSlotsInUseForTest` reports the aggregate, which is the
 * right observable for the process-wide bound but cannot tell "four phases of
 * two" apart from "one phase of eight". This one can, and it is what pins the
 * reserved headroom: one phase must never own the whole budget.
 */
export function __getFilesystemMaxPhaseSlotsForTest(): number {
  return filesystemMaxPhaseSlots
}

/**
 * Test seam: the widest number of slots a single phase held, by phase label.
 *
 * Attribution, not just a number: a test can assert that the discovery walk and
 * the manifest pre-read each stayed under the whole budget while running
 * together, which is the property the reserved slot exists to guarantee.
 */
export function __getFilesystemPhaseMaxSlotsForTest(): Record<string, number> {
  return { ...filesystemPhaseMaxSlots }
}

/**
 * Reset every per-phase high-water mark and the live per-phase counts so a test
 * can attribute a peak to one call.
 *
 * Test-only seam, and stricter than `__resetFilesystemMaxSlotsInUseForTest`:
 * unlike that one it also wipes the LIVE per-phase counts, so it must not be
 * called while gated work is in flight. A phase holding slots at the reset
 * would restart its live count at 0 while the process-wide aggregate still
 * counts them, and could then exceed its own `phaseLimit` by the slots it held.
 * Call it before the call under test, when every live count is already back to
 * zero and the reset only clears the recorded marks.
 */
export function __resetFilesystemPhaseStatsForTest(): void {
  filesystemMaxPhaseSlots = 0
  for (const phase of Object.keys(filesystemPhaseMaxSlots)) {
    delete filesystemPhaseMaxSlots[phase]
  }
  for (const phase of Object.keys(filesystemPhaseSlotsInUse)) {
    delete filesystemPhaseSlotsInUse[phase]
  }
}

/**
 * A caller queued for a slot. Boxed (rather than a bare resolve function) so a
 * waiter that aborts can find and splice ITSELF out of the FIFO queue instead
 * of being handed a slot it will never use.
 *
 * `cancelled` is the one-shot latch that makes the abort authoritative even
 * after a `releaseFilesystemSlot` has already shifted this waiter off the
 * queue: once its caller has observed an abort rejection, a `grant` that runs
 * afterwards must never take (or re-queue for) a slot, because the matching
 * `withFilesystemSlot` finally block will never run to release it. Without the
 * latch that late grant permanently shrank the process-wide budget.
 */
interface FilesystemSlotWaiter {
  cancelled: boolean
  grant: () => void
}

const filesystemSlotWaiters: FilesystemSlotWaiter[] = []

/**
 * Test seam: the widest number of filesystem syscalls the process had in flight
 * at once since the last reset, across EVERY gated call site.
 *
 * The per-module high-water marks in `harness-intelligence` and
 * `file-change-hooks` cannot see an aggregate regression: each of those
 * counters saturates at its own call-site width even when two overlapping
 * phases together put twice that many requests on the shared pool. This is the
 * observable that can, and it is what pins the process-wide bound.
 */
export function __getFilesystemMaxSlotsInUseForTest(): number {
  return filesystemMaxSlotsInUse
}

/** Test seam: slots currently held, so a probe that throws cannot leak one. */
export function __getFilesystemSlotsInUseForTest(): number {
  return filesystemSlotsInUse
}

/**
 * Reset the high-water mark (never the live count) so a test can attribute the
 * peak to one call.
 */
export function __resetFilesystemMaxSlotsInUseForTest(): void {
  filesystemMaxSlotsInUse = 0
}

/**
 * Whether this phase may take another slot right now.
 *
 * Two conditions, and the second is the whole point of the phase cap:
 * the process still has a free slot, AND this phase is below `phaseLimit`.
 * `phaseLimit` is the per-phase width the call site was tuned for, already
 * reduced by the reserved interactive headroom (see
 * `FILESYSTEM_RESERVED_INTERACTIVE_SLOTS`), so a phase that would like to run 8
 * wide can never hold every one of the 8 process slots.
 */
function canAcquireFilesystemSlot(
  phase: string | undefined,
  phaseLimit: number | undefined,
): boolean {
  if (filesystemSlotsInUse >= FILESYSTEM_FANOUT_CONCURRENCY) return false
  if (phase === undefined || phaseLimit === undefined) return true
  return (filesystemPhaseSlotsInUse[phase] ?? 0) < phaseLimit
}

function takeFilesystemSlot(phase: string | undefined): void {
  filesystemSlotsInUse += 1
  if (filesystemSlotsInUse > filesystemMaxSlotsInUse) {
    filesystemMaxSlotsInUse = filesystemSlotsInUse
  }
  if (phase === undefined) return
  const held = (filesystemPhaseSlotsInUse[phase] ?? 0) + 1
  filesystemPhaseSlotsInUse[phase] = held
  if (held > filesystemMaxPhaseSlots) filesystemMaxPhaseSlots = held
  if (held > (filesystemPhaseMaxSlots[phase] ?? 0)) {
    filesystemPhaseMaxSlots[phase] = held
  }
}

function acquireFilesystemSlot(
  phase: string | undefined,
  phaseLimit: number | undefined,
  signal?: AbortSignal,
): Promise<void> {
  throwIfAborted(signal)
  if (canAcquireFilesystemSlot(phase, phaseLimit)) {
    takeFilesystemSlot(phase)
    return Promise.resolve()
  }
  // A caller queued here has issued no syscall yet, so waiting costs the pool
  // nothing; the queue stays FIFO so no phase can starve another. An abort
  // while queued removes the waiter and rejects, so a cancelled run neither
  // keeps issuing filesystem work nor delays the callers behind it.
  //
  // The grant re-checks the PHASE limit as well as the process cap: the queue is
  // shared, so a slot released by another phase may still be unusable for a
  // phase already at its own width, and handing it over regardless is exactly
  // the "one phase owns the budget" failure this gate exists to prevent. A
  // waiter that cannot take the freed slot is re-queued behind the others.
  return new Promise<void>((resolve, reject) => {
    // The waiter is ONE-SHOT. Once it has settled — granted, or rejected on
    // abort — no later `grant` may resolve it or take a slot on its behalf.
    // That is not tidiness: `grant` is a closure that outlives the caller's
    // await, and `releaseFilesystemSlot` can already have shifted this waiter
    // off the queue before an abort lands. Without the `settled` latch, that
    // grant would take a slot whose `withFilesystemSlot` `finally` has already
    // been skipped, permanently shrinking the process budget.
    let settled = false
    const onAbort = () => {
      // Latched BEFORE the splice so a grant already in flight observes it and
      // declines the slot, instead of taking one nobody will ever release.
      waiter.cancelled = true
      if (settled) return
      settled = true
      const index = filesystemSlotWaiters.indexOf(waiter)
      if (index !== -1) filesystemSlotWaiters.splice(index, 1)
      reject(abortReason(signal!))
    }
    const waiter: FilesystemSlotWaiter = {
      cancelled: false,
      grant: () => {
        if (settled || waiter.cancelled) {
          // The caller already saw the abort rejection, so `withFilesystemSlot`
          // has no `finally` left to release anything: never take this slot or
          // re-queue for one. `releaseFilesystemSlot` already decremented the
          // counter, so hand the still-free slot to the next head waiter. Each
          // pass consumes a waiter, so this cannot recurse without bound.
          const next = filesystemSlotWaiters.shift()
          if (next) next.grant()
          return
        }
        if (!canAcquireFilesystemSlot(phase, phaseLimit)) {
          filesystemSlotWaiters.push(waiter)
          return
        }
        settled = true
        signal?.removeEventListener('abort', onAbort)
        takeFilesystemSlot(phase)
        resolve()
      },
    }
    // Registered before the waiter is enqueued so an abort can never be missed
    // between the enqueue and the listener being installed.
    signal?.addEventListener('abort', onAbort, { once: true })
    filesystemSlotWaiters.push(waiter)
  })
}

function releaseFilesystemSlot(phase: string | undefined): void {
  filesystemSlotsInUse -= 1
  if (phase !== undefined) {
    const held = (filesystemPhaseSlotsInUse[phase] ?? 1) - 1
    if (held <= 0) delete filesystemPhaseSlotsInUse[phase]
    else filesystemPhaseSlotsInUse[phase] = held
  }
  // Hand the slot straight to the next waiter instead of letting a fresh arrival
  // race the queue: the transfer keeps the wait ordered. The waiter re-accounts
  // for the slot itself (see `grant`), so this only needs to wake the head. A
  // head that was cancelled after being shifted forwards the still-free slot on
  // (again inside `grant`), so a late abort can never swallow it.
  const next = filesystemSlotWaiters.shift()
  if (next) next.grant()
}

/**
 * Runs one filesystem syscall under the process-wide fan-out gate.
 *
 * MUST wrap a leaf probe only. A gated probe that awaited another gated probe
 * would hold one slot while queueing for a second, so a saturated queue could
 * never drain. Every call site maps over leaves (readdir/stat/readFile/
 * realpath) and joins them OUTSIDE the gate.
 *
 * The slot is released on both settlement paths, so a rejected probe cannot
 * permanently shrink the process's capacity.
 *
 * `signal` makes the wait cancellable: an already-aborted signal never queues,
 * an abort while queued splices the waiter back out, and a signal that is
 * aborted between being granted a slot and running the probe releases the slot
 * without issuing the syscall. Call sites thread their tool's signal through so
 * a cancelled run stops draining queued filesystem work.
 *
 * `phase` / `phaseLimit` give the caller its RESERVED SHARE of the shared
 * budget. The process-wide cap alone prevented the aggregate from being
 * unbounded, but a single phase entering at its own tuned width could still take
 * every slot, leaving the render loop (and any overlapping interactive phase)
 * queueing behind a whole batch. Naming the phase and its width means no phase
 * can own the budget: `phaseLimit` is capped at
 * `FILESYSTEM_FANOUT_CONCURRENCY - FILESYSTEM_RESERVED_INTERACTIVE_SLOTS`, so at
 * least one slot stays available while any wide phase saturates.
 *
 * Both parameters are optional and default to the previous behaviour (no phase
 * attribution, only the process cap), so an ungated call site keeps working.
 */
export async function withFilesystemSlot<T>(
  probe: () => Promise<T>,
  signal?: AbortSignal,
  phase?: string,
  phaseLimit?: number,
): Promise<T> {
  const effectiveLimit =
    phaseLimit === undefined
      ? undefined
      : Math.max(
          1,
          Math.min(
            Math.floor(phaseLimit),
            FILESYSTEM_FANOUT_CONCURRENCY -
              FILESYSTEM_RESERVED_INTERACTIVE_SLOTS,
          ),
        )
  await acquireFilesystemSlot(phase, effectiveLimit, signal)
  try {
    throwIfAborted(signal)
    return await probe()
  } finally {
    releaseFilesystemSlot(phase)
  }
}
