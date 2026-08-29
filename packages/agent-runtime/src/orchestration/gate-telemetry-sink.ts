import { errorCode } from '@codebuff/common/util/error'
import {
  appendGateTelemetryEvent,
  createGateTelemetryPreflight,
} from '@codebuff/common/util/gate-telemetry'

import { createWarnLatch } from '../util/warn-latch'

import type { Logger } from '@codebuff/common/types/contracts/logger'

/**
 * Latch key for one warning: its message, the filesystem error `code` (via the
 * shared `errorCode`, so it cannot drift from what `appendGateTelemetryEvent`
 * logs) and the symlinked path segment it refuses. The segment belongs in the key
 * because a symlink refusal carries no `err`, so a symlink moved mid-run to
 * another segment would otherwise stay silent for the recorder's lifetime.
 */
function warnLatchKey(data: unknown, msg?: string): string {
  const meta = typeof data === 'object' && data !== null ? data : undefined
  const err = meta && 'err' in meta ? meta.err : undefined
  const segment =
    meta && 'symlinkedSegment' in meta ? String(meta.symlinkedSegment) : ''
  // A string first argument IS the message for pino-style callers.
  const message = typeof data === 'string' ? data : (msg ?? '')
  return `${message}|${errorCode(err) ?? ''}|${segment}`
}

/**
 * Cap on how many DISTINCT reports one recorder's warn latch tracks, exported so
 * the sink test derives its key count from the bound. Because `warnLatchKey`
 * includes the refused `symlinkedSegment`, someone able to plant symlinks at many
 * distinct paths under `projectRoot` can spend every key and silence each LATER
 * distinct report for the recorder's lifetime. That is log suppression ONLY —
 * such an append still fails closed — and is accepted in exchange for reporting a
 * symlink moved mid-run to another segment.
 */
export const GATE_TELEMETRY_WARN_LATCH_MAX_KEYS = 64

/**
 * A logger that may ALSO expose pino's `child`, which the `Logger` contract does
 * not declare but prototype delegation still hands through.
 */
type LoggerWithChild = Logger & {
  child?: (...args: unknown[]) => LoggerWithChild
}

/**
 * Wrap `logger` so each distinct report (see `warnLatchKey`) is forwarded at most
 * once until `clearLatch` re-arms it. `warnCount` reports HOW MANY reports were
 * actually forwarded since the last re-arm, so a caller can tell a reported
 * failure from one the key cap suppressed.
 *
 * Prototype delegation rather than a spread, because a prototype-based logger
 * (pino) has no own enumerable methods. Delegation also exposes the wrapped
 * logger's `child`, which is re-wrapped through this same latch so a child shares
 * one latch and one `warnCount` with its parent. `warn` is the only latched
 * level, because it is the only one `appendGateTelemetryEvent` reports through.
 *
 * Exported for the sink test; production sinks go through
 * `createGateTelemetryRecorder`, which owns the re-arm policy `warnCount` serves.
 */
export function createWarnLatchedLogger(logger: Logger): {
  logger: Logger
  clearLatch: () => void
  warnCount: () => number
} {
  const latch = createWarnLatch({
    maxKeys: GATE_TELEMETRY_WARN_LATCH_MAX_KEYS,
  })
  let forwardedWarnings = 0
  const latchLogger = (target: Logger): LoggerWithChild => {
    const latchedLogger: LoggerWithChild = Object.create(target)
    latchedLogger.warn = (data: unknown, msg?: string, ...args: unknown[]) => {
      if (!latch.shouldWarn(warnLatchKey(data, msg))) return
      // A pino-style `warn('message')` must not arrive as `warn('message',
      // undefined)`, so the `msg` slot collapses only when nothing follows it.
      // With trailing args it is forwarded positionally, or an interpolation arg
      // would slide into pino's message slot.
      const forwarded =
        msg === undefined && args.length === 0
          ? target.warn(data)
          : target.warn(data, msg, ...args)
      // Counted only AFTER the delegate returned, so `warnCount()` means
      // "actually emitted": a delegate that throws must not look like a report
      // that went out and reset the recorder's clean-append streak.
      forwardedWarnings += 1
      return forwarded
    }
    const parentChild = (target as LoggerWithChild).child
    if (typeof parentChild === 'function') {
      latchedLogger.child = (...childArgs: unknown[]) =>
        latchLogger(parentChild.apply(target, childArgs))
    }
    return latchedLogger
  }
  return {
    logger: latchLogger(logger),
    clearLatch: () => {
      forwardedWarnings = 0
      latch.clear()
    },
    warnCount: () => forwardedWarnings,
  }
}

/**
 * Consecutive CLEAN successful appends — successful and reporting nothing of
 * their own — required before the warn latch is re-armed, so an alternating
 * success/failure sink does not re-warn on every flip. Exported so the sink test
 * derives its success count from the threshold.
 */
export const GATE_TELEMETRY_WARN_RELATCH_SUCCESSES = 3

/**
 * Bind the durable gate-telemetry sink to one run's project root.
 *
 * base2's `handleSteps` is serialized via `.toString()` + `new Function(...)`, so
 * it cannot import the shared helper; the recorder is injected through
 * `params.orchestrationControlPlane` instead. The returned function is
 * best-effort and never throws (see `appendGateTelemetryEvent`). Both per-run
 * memos — the mkdir/rotation pre-flight and the warn latch — are per-recorder, so
 * they cannot suppress another caller's FIRST failure.
 *
 * Each recorded event costs a synchronous `lstat` scan plus
 * `openSync`/`appendFileSync`/`closeSync` on the calling event loop: fine at
 * base2 gate frequency, NOT safe to reuse for a high-rate event stream.
 */
export function createGateTelemetryRecorder(params: {
  projectRoot: string
  logger: Logger
}): (payload: Record<string, unknown>) => void {
  const { projectRoot, logger } = params
  const preflight = createGateTelemetryPreflight()
  const {
    logger: latchedLogger,
    clearLatch,
    warnCount,
  } = createWarnLatchedLogger(logger)
  let consecutiveCleanAppends = 0
  return (payload: Record<string, unknown>) => {
    // Snapshotted BEFORE the append: a SUCCESSFUL append can report something of
    // its own (the owner-only mode repair), and that is not evidence the latched
    // failure mode is gone.
    const warningsBefore = warnCount()
    const appended = appendGateTelemetryEvent({
      projectRoot,
      payload,
      logger: latchedLogger,
      preflight,
    })
    if (!appended) {
      consecutiveCleanAppends = 0
      return
    }
    // Nothing the latch is holding, so counting toward a re-arm is pointless.
    // Asking the latch keeps a failure whose warning never went out (a blank
    // `projectRoot`, or one past `GATE_TELEMETRY_WARN_LATCH_MAX_KEYS`) from
    // spending successes.
    if (warningsBefore === 0) return
    // The append landed but forwarded a NEW report, so the clean streak restarts.
    if (warnCount() !== warningsBefore) {
      consecutiveCleanAppends = 0
      return
    }
    consecutiveCleanAppends += 1
    if (consecutiveCleanAppends >= GATE_TELEMETRY_WARN_RELATCH_SUCCESSES) {
      clearLatch()
      consecutiveCleanAppends = 0
    }
  }
}
