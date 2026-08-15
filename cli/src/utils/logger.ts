import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  renameSync,
  statSync,
  unlinkSync,
} from 'fs'
import path, { dirname } from 'path'
import { format as stringFormat } from 'util'

import { AnalyticsEvent } from '@codebuff/common/constants/analytics-events'
import { env, IS_DEV, IS_TEST, IS_CI } from '@codebuff/common/env'
import { createAnalyticsDispatcher } from '@codebuff/common/util/analytics-dispatcher'
import { getAnalyticsEventId } from '@codebuff/common/util/analytics-log'
import {
  isFullTelemetryEnabled,
  summarizeAnalyticsValue,
} from '@codebuff/common/util/analytics-sampling'
import { pino } from 'pino'

import {
  flushAnalytics,
  logError,
  setAnalyticsErrorLogger,
  trackEvent,
} from './analytics'
import { sanitizeForDebugLog } from './payload-sanitizer'
import { getCurrentChatDir, getProjectRoot } from '../project-files'

export interface LoggerContext {
  userId?: string
  userEmail?: string
  clientSessionId?: string
  fingerprintId?: string
  clientRequestId?: string
  [key: string]: any // Allow for future extensions
}

export const loggerContext: LoggerContext = {}

let logPath: string | undefined = undefined
let pinoLogger: any = undefined
let pinoDestination:
  | { flushSync?: () => void; end?: (cb?: () => void) => void; fd?: number }
  | undefined = undefined

/** Live SonicBoom fd, if the dest is still open. Used by tests to prove close. */
export function getLivePinoDestinationFd(): number | undefined {
  const fd = pinoDestination?.fd
  return typeof fd === 'number' && fd >= 0 ? fd : undefined
}

export function endPreviousPinoDestination(): void {
  const previousLogger = pinoLogger
  const previousDestination = pinoDestination
  pinoLogger = undefined
  pinoDestination = undefined
  try {
    previousLogger?.flush?.()
  } catch {
    // Ignore flush errors; destination close must still run
  }
  try {
    previousDestination?.flushSync?.()
  } catch {
    // Ignore flush errors; still try to close the fd
  }
  // SonicBoom.end() does not close dest.fd before returning. Close the fd
  // synchronously so Windows rename/unlink is not EBUSY, then make end() a
  // no-op so a later call cannot double-close.
  if (previousDestination) {
    const destFd = previousDestination.fd
    if (typeof destFd === 'number' && destFd >= 0) {
      try {
        closeSync(destFd)
      } catch {
        // Ignore close errors; logging must never throw
      }
      previousDestination.fd = -1
    }
    previousDestination.end = () => {}
  }
  try {
    previousDestination?.end?.()
  } catch {
    // Ignore close errors; logging must never throw
  }
}

const loggingLevels = ['info', 'debug', 'warn', 'error', 'fatal'] as const
type LogLevel = (typeof loggingLevels)[number]

// Cap log files at 10 MiB. When a log reaches this size we rotate it to a
// `.1` sibling so `log.jsonl` (and dev `debug/cli.jsonl`) cannot grow unbounded.
export const LOG_MAX_BYTES = 10 * 1024 * 1024
const analyticsDispatcher = createAnalyticsDispatcher({
  envName: env.NEXT_PUBLIC_CB_ENVIRONMENT,
  bufferWhenNoUser: true,
})

/**
 * Safely stringify an object, handling circular references.
 * Replaces circular references with '[Circular]' placeholder.
 */
function safeStringify(obj: unknown): string {
  const seen = new WeakSet()
  return JSON.stringify(obj, (_key, value) => {
    if (typeof value === 'object' && value !== null) {
      if (seen.has(value)) {
        return '[Circular]'
      }
      seen.add(value)
    }
    return value
  })
}

function isEmptyObject(value: any): boolean {
  return (
    value != null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).length === 0
  )
}

function createPinoLoggerForPath(p: string): void {
  // Close the previous SonicBoom fd before opening a new destination so
  // rotation / path changes cannot leak file descriptors.
  endPreviousPinoDestination()
  try {
    mkdirSync(dirname(p), { recursive: true })

    // ────────────────────────────────────────────────────────────
    //  pino.destination(..) → SonicBoom stream, no worker thread
    // ────────────────────────────────────────────────────────────
    const fileStream = pino.destination({
      dest: p, // absolute or relative file path
      mkdir: true, // create parent dirs if they don’t exist
      sync: true, // set true if you *must* block on every write
    })
    pinoDestination = fileStream

    pinoLogger = pino(
      {
        level: 'debug',
        formatters: {
          level: (label) => ({ level: label.toUpperCase() }),
        },
        timestamp: () => `,"timestamp":"${new Date().toISOString()}"`,
      },
      fileStream, // <-- no worker thread involved
    )
    // Only pin the path after dest+logger exist. A failed reopen must not make
    // setLogPath(p) no-op (p === logPath) while pinoLogger is still missing.
    logPath = p
  } catch {
    // mkdir / destination / pino() failed. The previous dest is already closed.
    // If dest opened but pino() threw, close that fd so it cannot leak.
    endPreviousPinoDestination()
    // Do not set logPath: setLogPath must retry on the next write.
  }
}

function setLogPath(p: string): void {
  // A missing pinoLogger means the last open failed or the dest was closed;
  // treat that path as stale even when p === logPath so the session can recover.
  if (p === logPath && pinoLogger !== undefined) return
  createPinoLoggerForPath(p)
}

/**
 * Force-recreate the pino stream for `p`, even when `p === logPath`.
 * Used only after rotation: the old SonicBoom stream holds an fd to the
 * renamed-away file and must be abandoned so subsequent writes go to the
 * fresh (post-rename) file at `logPath`.
 */
export function resetLogStream(p: string): void {
  createPinoLoggerForPath(p)
}

/**
 * Rotate a log file to a `.1` sibling once it reaches LOG_MAX_BYTES.
 * Keeps exactly one prior rotated file: unlink any existing `.1`, then rename.
 * All fs operations are swallowed so logging never throws.
 */
export function rotateLogIfNeeded(targetLogPath: string): void {
  try {
    if (!existsSync(targetLogPath)) return
    if (statSync(targetLogPath).size < LOG_MAX_BYTES) return

    const rotatedPath = `${targetLogPath}.1`
    try {
      if (existsSync(rotatedPath)) {
        unlinkSync(rotatedPath)
      }
    } catch {
      // Ignore unlink errors; rename may still fail harmlessly below
    }
    renameSync(targetLogPath, rotatedPath)
  } catch {
    // Ignore rotation errors; logging must never throw
  }
}

export function clearLogFile(): void {
  const projectRoot = getProjectRoot()
  const defaultLog = path.join(projectRoot, 'debug', 'cli.jsonl')
  const targets = new Set<string>()

  if (logPath) {
    targets.add(logPath)
  }
  targets.add(defaultLog)

  // Also reclaim the production per-chat log: always delete live log.jsonl
  // (including under-cap files). Rotation-only would leave an under-cap chat
  // log, contradicting --clear-logs.
  try {
    const productionLog = path.join(getCurrentChatDir(), 'log.jsonl')
    targets.add(productionLog)
  } catch {
    // Ignore errors resolving the chat dir
  }

  // Release the live SonicBoom fd before unlink: an open dest fails
  // closed-as-no-op on Windows (EBUSY) and would leave the active file.
  endPreviousPinoDestination()
  logPath = undefined

  for (const target of targets) {
    try {
      if (existsSync(target)) {
        unlinkSync(target)
      }
    } catch {
      // Ignore errors when clearing logs
    }
    try {
      const rotatedPath = `${target}.1`
      if (existsSync(rotatedPath)) {
        unlinkSync(rotatedPath)
      }
    } catch {
      // Ignore unlink errors for rotated siblings
    }
  }
}

function sendAnalyticsAndLog(
  level: LogLevel,
  data: any,
  msg?: string,
  ...args: any[]
): void {
  if (!IS_CI && !IS_TEST) {
    let projectRoot: string | undefined
    try {
      projectRoot = getProjectRoot()
    } catch {
      projectRoot = undefined
    }
    if (projectRoot) {
      const logTarget = IS_DEV
        ? path.join(projectRoot, 'debug', 'cli.jsonl')
        : path.join(getCurrentChatDir(), 'log.jsonl')

      if (IS_DEV) {
        // Dev writes via appendFileSync (Bun has issues with pino sync).
        // Do not open SonicBoom: an open dest makes Windows rename EBUSY
        // so debug/cli.jsonl can grow past LOG_MAX_BYTES.
        if (logPath !== logTarget) {
          endPreviousPinoDestination()
          logPath = logTarget
        }
      } else {
        setLogPath(logTarget)
      }
    }
  }

  const isStringOnly = typeof data === 'string' && msg === undefined
  const normalizedData = isStringOnly ? undefined : data
  const normalizedMsg = isStringOnly ? (data as string) : msg
  const includeData = normalizedData != null && !isEmptyObject(normalizedData)
  const sanitizedData = includeData
    ? sanitizeForDebugLog(normalizedData)
    : undefined
  const formattedMsg = sanitizeForDebugLog(
    stringFormat(normalizedMsg ?? '', ...args),
  )

  const toTrack = {
    ...(includeData ? { data: sanitizedData } : {}),
    level,
    loggerContext,
    msg: formattedMsg,
  }

  logAsErrorIfNeeded(toTrack)

  if (!IS_DEV && includeData && typeof normalizedData === 'object') {
    const analyticsPayloads = analyticsDispatcher.process({
      data: sanitizedData,
      level,
      msg: formattedMsg,
      fallbackUserId: loggerContext.userId,
    })

    analyticsPayloads.forEach((payload) => {
      trackEvent(payload.event, payload.properties)
    })
  }

  // Send all log events to PostHog in production for better observability
  // Skip if the log already has an eventId (to avoid duplicate tracking)
  const hasEventId = includeData && getAnalyticsEventId(normalizedData) !== null
  if (!IS_DEV && !IS_TEST && !IS_CI && !hasEventId) {
    const fullTelemetry = isFullTelemetryEnabled({
      distinctId: loggerContext.userId,
      properties: loggerContext,
    })
    const includeRawData =
      fullTelemetry || level === 'error' || level === 'fatal'
    const dataProperties =
      includeData && includeRawData
        ? { data: sanitizedData }
        : includeData
          ? { dataSummary: summarizeAnalyticsValue(sanitizedData) }
          : {}

    trackEvent(AnalyticsEvent.CLI_LOG, {
      level,
      msg: formattedMsg,
      ...dataProperties,
      ...loggerContext,
    })
  }

  // Skip file I/O in test/CI so other files cannot steal/rotate a pinned logPath.
  if (IS_TEST || IS_CI) {
    return
  }

  // In dev mode, use appendFileSync for real-time logging (Bun has issues with pino sync)
  // In prod mode, use pino for better performance
  if (IS_DEV && logPath) {
    const logEntry = safeStringify({
      level: level.toUpperCase(),
      timestamp: new Date().toISOString(),
      ...loggerContext,
      ...(includeData ? { data: sanitizedData } : {}),
      msg: formattedMsg,
    })
    // Close any leftover dest before rotate so Windows rename is not EBUSY.
    endPreviousPinoDestination()
    rotateLogIfNeeded(logPath)
    try {
      mkdirSync(dirname(logPath), { recursive: true })
      appendFileSync(logPath, logEntry + '\n')
    } catch {
      // Ignore write errors
    }
  } else if (pinoLogger !== undefined || logPath !== undefined) {
    // Enforce the size cap on the production write path: when `log.jsonl`
    // reaches LOG_MAX_BYTES, rotate it to `.1` and reopen a fresh stream at
    // `logPath` so the live session stays bounded. Failures must not throw:
    // endPreviousPinoDestination() clears pinoLogger before resetLogStream,
    // so a mkdir/destination failure cannot fall through to pinoLogger[level].
    if (logPath !== undefined) {
      try {
        if (existsSync(logPath) && statSync(logPath).size >= LOG_MAX_BYTES) {
          // Close SonicBoom before rename: an open live fd makes
          // rename/unlink fail closed-as-no-op on Windows (EBUSY).
          endPreviousPinoDestination()
          rotateLogIfNeeded(logPath)
        }
        // Reopen after rotate, and retry after a previous failed reset so a
        // later write can restore a live dest (setLogPath is skipped in tests).
        if (pinoLogger === undefined) {
          resetLogStream(logPath)
        }
      } catch {
        // Ignore rotation/reopen errors; logging must never throw
      }
    }
    try {
      if (pinoLogger !== undefined) {
        const base = { ...loggerContext }
        const obj = includeData ? { ...base, data: sanitizedData } : base
        pinoLogger[level](obj, formattedMsg as any)
      }
    } catch {
      // Ignore write errors after dest close/reopen, including reset failure
    }
  }
}

function logAsErrorIfNeeded(toTrack: {
  data?: any
  level: LogLevel
  loggerContext: LoggerContext
  msg: string
}) {
  if (toTrack.level === 'error' || toTrack.level === 'fatal') {
    logError(
      new Error(toTrack.msg),
      toTrack.loggerContext.userId ?? 'unknown',
      { ...(toTrack.data ?? {}), context: toTrack.loggerContext },
    )
    flushAnalytics()
  }
}

/**
 * Wrapper around Pino logger.
 *
 * To also send to Posthog, set data.eventId to type AnalyticsEvent
 *
 * e.g. logger.info({eventId: AnalyticsEvent.SOME_EVENT, field: value}, 'some message')
 */
export const logger: Record<LogLevel, pino.LogFn> = Object.fromEntries(
  loggingLevels.map((level) => {
    return [
      level,
      (data: any, msg?: string, ...args: any[]) =>
        sendAnalyticsAndLog(level, data, msg, ...args),
    ]
  }),
) as Record<LogLevel, pino.LogFn>

setAnalyticsErrorLogger((error, context) => {
  const err =
    error instanceof Error
      ? error
      : new Error(typeof error === 'string' ? error : 'Unknown analytics error')

  logger.warn(
    {
      analyticsError: true,
      error: {
        name: err.name,
        message: err.message,
        stack: err.stack,
      },
      context,
    },
    '[analytics] error',
  )
})
