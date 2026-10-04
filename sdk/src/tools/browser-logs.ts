import { spawn, type ChildProcess } from 'child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import type { Readable, Writable } from 'node:stream'
import { PNG } from 'pngjs'
import pixelmatch from 'pixelmatch'
import WebSocket from 'ws'

import type { CodebuffToolOutput } from '@codebuff/common/tools/list'
import type {
  BrowserAction,
  BrowserResponse,
} from '@codebuff/common/browser-actions'
import type { Log, NetworkEvent } from '@codebuff/common/browser-actions'
import type { JSONValue } from '@codebuff/common/types/json'
import { getSdkEnv } from '../env'
import {
  CdpPipeTransport,
  createWebSocketPipeBridge,
  type CdpPipeMessage,
  type CdpWebSocket,
} from './cdp-pipe-transport'
import { resolveFilePathForOperation } from './path-utils'

type BrowserPage = {
  targetId: string
  /** CDP flatten-mode sessionId routing this page's commands on the pipe. */
  sessionId: string
  /** Owning session transport used for every command sent from this page. */
  transport: CdpPipeTransport
  eventWaiters: Map<string, Array<() => void>>
  executionContexts: Map<string, number>
}

type RecordingState = {
  targetId: string
  startedAt: number
  frameCount: number
  frames: Array<{ data: string; timestamp: number }>
}

type BrowserSession = {
  owner?: BrowserSessionOwner
  projectRoot?: string
  child: ChildProcess
  transport: CdpPipeTransport
  userDataDir: string
  /**
   * For sessions spawned on the WebSocket fallback
   * (--remote-debugging-port=0), closes the underlying ws socket
   * deterministically at explicit teardown; the pipe transport needs no
   * extra disposal.
   */
  disposeTransport?: () => void
  pages: Map<string, BrowserPage>
  /**
   * Pages keyed by flatten-mode sessionId so routeEvent resolves the owning
   * page with a single map lookup per inbound event instead of allocating a
   * spread array and scanning every page. Kept in sync with the targetId-keyed
   * `pages` map at every mutation site.
   */
  pagesBySessionId: Map<string, BrowserPage>
  activeTargetId: string
  logs: Log[]
  networks: NetworkEvent[]
  networkRequests: Map<string, { method: string; url: string }>
  logOffset: number
  networkOffset: number
  recording: RecordingState | null
  /**
   * CDP events buffered for targets whose page is not registered yet (the
   * window between Target.attachToTarget resolving and connectPage registering
   * the page). Keyed by flatten-mode sessionId and drained in order on
   * registration so no event is dropped or misrouted.
   */
  pendingEvents: Map<string, CdpPipeMessage[]>
  /**
   * Running total of events buffered across every pendingEvents entry. Kept in
   * sync by queuePendingEvent and flushPendingEvents so the pending-buffer cap
   * check is a counter comparison per enqueue instead of rescanning every
   * buffered sessionId.
   */
  pendingEventCount: number
}

type FrameTarget = {
  frameSelector?: string
  frameId?: string
  frameUrl?: string
  frameName?: string
}

type ElementPoint = {
  x: number
  y: number
  text?: string
  selector?: string
}

const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
])
const CRC_TABLE = makeCrcTable()

const browserSessions = new Map<string, BrowserSession>()
const DEFAULT_BROWSER_SESSION_KEY = 'default'

const MAX_RECORDING_FRAMES = 600
const MAX_SESSION_LOG_ENTRIES = 5000
const MAX_SESSION_NETWORK_EVENTS = 5000
const MAX_TRACKED_NETWORK_REQUESTS = 2000

export type BrowserSessionOwner = {
  clientSessionId: string
  rootRunId: string
  parentRunId: string
  parentAgentId: string
  projectRoot?: string
}

export function getBrowserSessionKey(owner: BrowserSessionOwner): string {
  return [
    owner.clientSessionId,
    owner.rootRunId,
    owner.parentRunId,
    owner.parentAgentId,
  ]
    .map((value) => encodeURIComponent(value))
    .join('::')
}

/**
 * Maximum nesting depth for 'diagnose' actions. A step whose action is itself
 * a 'diagnose' recurses into browserLogs, so model-controlled or malformed
 * input without a depth bound would drive unbounded recursion and end in
 * stack exhaustion surfaced only as the generic catch-all error.
 */
export const MAX_DIAGNOSE_NESTING_DEPTH = 3

/**
 * Whether a diagnose action tree nests deeper than MAX_DIAGNOSE_NESTING_DEPTH.
 * Checked structurally up front so an over-deep tree is rejected before any
 * browser session work, and so the diagnose branch's recursion into
 * browserLogs can never outrun the bound (each nested call re-validates its
 * own, strictly smaller subtree). The walk itself stops as soon as the bound
 * is exceeded, so hostile deeply-nested input cannot exhaust the stack here
 * either. Tolerates malformed step entries (a non-object step yields a
 * bounded catch-all error instead of a crash).
 */
export function diagnoseNestingExceedsLimit(
  action: BrowserAction,
  depth: number,
): boolean {
  if (action.type !== 'diagnose') return false
  if (depth > MAX_DIAGNOSE_NESTING_DEPTH) return true
  if (!Array.isArray(action.steps)) return false
  return action.steps.some(
    (step) =>
      isRecord(step) && diagnoseNestingExceedsLimit(step.action, depth + 1),
  )
}

export async function browserLogs(
  action: BrowserAction,
  sessionOwnerOrKey: BrowserSessionOwner | string = DEFAULT_BROWSER_SESSION_KEY,
): Promise<CodebuffToolOutput<'browser_logs'>> {
  const owner =
    typeof sessionOwnerOrKey === 'string' ? undefined : sessionOwnerOrKey
  const projectRoot =
    typeof sessionOwnerOrKey === 'string'
      ? undefined
      : sessionOwnerOrKey.projectRoot
  const sessionKey =
    typeof sessionOwnerOrKey === 'string'
      ? sessionOwnerOrKey
      : getBrowserSessionKey(sessionOwnerOrKey)
  try {
    // Reject an over-deep diagnose tree before any session work: a step whose
    // action is itself a 'diagnose' recurses into browserLogs, so without this
    // bound hostile or malformed input could drive unbounded recursion.
    if (
      action.type === 'diagnose' &&
      diagnoseNestingExceedsLimit(action, 1)
    ) {
      return [
        jsonResult({
          success: false,
          action: 'diagnose',
          error: `diagnose actions may nest at most ${MAX_DIAGNOSE_NESTING_DEPTH} levels deep`,
          logs: [],
        }),
      ]
    }

    if (action.type === 'stop') {
      await stopBrowserSession(sessionKey)
      return [jsonResult({ success: true, action: action.type, logs: [] })]
    }

    const session = await ensureBrowserSession(sessionKey, owner)
    if (owner) session.projectRoot = projectRoot
    const page = await getActivePage(session)
    await enablePageDomains(page)

    if (action.type === 'start' || action.type === 'navigate') {
      const url = normalizeBrowserUrl(action.url)
      const waitUntil =
        action.type === 'navigate' ? action.waitUntil : undefined
      await waitForCommand(
        page,
        'Page.navigate',
        { url },
        action.timeout ?? 15_000,
      )
      await waitForLoad(page, waitUntil, action.timeout ?? 15_000)
      return [jsonResult(await buildResponse(session, page, action.type))]
    }

    if (action.type === 'snapshot') {
      const snapshot = await evaluateInTarget(
        page,
        snapshotScript(),
        action,
        action.timeout,
      )
      const response = await buildResponse(session, page, action.type, snapshot)
      if (isRecord(snapshot)) {
        response.text =
          typeof snapshot.text === 'string' ? snapshot.text : undefined
        response.elements = Array.isArray(snapshot.elements)
          ? (snapshot.elements as BrowserResponse['elements'])
          : undefined
      }
      return [jsonResult(response)]
    }

    if (action.type === 'screenshot') {
      const designMode = action.screenshotPurpose === 'design'
      const format =
        action.screenshotCompression ?? (designMode ? 'png' : 'jpeg')
      const quality =
        format === 'png'
          ? undefined
          : (action.screenshotCompressionQuality ?? (designMode ? 90 : 70))
      const result = await captureScreenshot(page, {
        format,
        quality,
        fullPage: action.fullPage ?? false,
        timeout: action.timeout,
      })
      const mediaType = format === 'png' ? 'image/png' : 'image/jpeg'
      return [
        jsonResult({
          ...(await buildResponse(session, page, action.type)),
          screenshotAttached: result.length > 0,
        }),
        ...(result
          ? [{ type: 'media' as const, data: result, mediaType }]
          : []),
      ]
    }

    if (action.type === 'click') {
      const result = await clickElement(page, action)
      if (action.waitForNavigation) {
        await waitForLoad(page, 'load', action.timeout ?? 15_000)
      }
      return [
        jsonResult(await buildResponse(session, page, action.type, result)),
      ]
    }

    if (action.type === 'type') {
      const result = await typeIntoElement(page, action)
      return [
        jsonResult(await buildResponse(session, page, action.type, result)),
      ]
    }

    if (action.type === 'key') {
      await dispatchKey(page, action.key, {
        text: action.text,
        command: action.command ?? 'press',
        modifiers: action.modifiers ?? [],
        timeout: action.timeout,
      })
      return [
        jsonResult(
          await buildResponse(session, page, action.type, {
            key: action.key,
            command: action.command ?? 'press',
          }),
        ),
      ]
    }

    if (action.type === 'mouse') {
      const point = action.selector
        ? await elementPoint(page, action.selector, action)
        : await pointInTarget(page, requirePoint(action.x, action.y), action)
      await dispatchMouse(page, action.event, point, {
        button: action.button ?? 'left',
        clickCount: action.clickCount ?? 1,
        timeout: action.timeout,
      })
      return [
        jsonResult(
          await buildResponse(session, page, action.type, {
            event: action.event,
            ...point,
          }),
        ),
      ]
    }

    if (action.type === 'hover') {
      const point = await elementPoint(page, action.selector, action)
      await dispatchMouse(page, 'move', point, {
        button: 'left',
        clickCount: 0,
        timeout: action.timeout,
      })
      return [
        jsonResult(await buildResponse(session, page, action.type, point)),
      ]
    }

    if (action.type === 'drag') {
      const result = await drag(page, action)
      return [
        jsonResult(await buildResponse(session, page, action.type, result)),
      ]
    }

    if (action.type === 'select') {
      const result = await evaluateInTarget(
        page,
        selectScript(action.selector, {
          value: action.value,
          label: action.label,
          index: action.index,
          frameSelector: action.frameSelector,
        }),
        action,
        action.timeout,
      )
      return [
        jsonResult(await buildResponse(session, page, action.type, result)),
      ]
    }

    if (action.type === 'scroll') {
      const amount = action.amount ?? 600
      const axis =
        action.direction === 'left' || action.direction === 'right'
          ? 'left'
          : 'top'
      const sign =
        action.direction === 'up' || action.direction === 'left' ? -1 : 1
      const result = await evaluateInTarget(
        page,
        scrollScript({
          selector: action.selector,
          frameSelector: action.frameSelector,
          axis,
          delta: sign * amount,
        }),
        action,
        action.timeout,
      )
      return [
        jsonResult(await buildResponse(session, page, action.type, result)),
      ]
    }

    if (action.type === 'evaluate') {
      const result = await evaluateInTarget(
        page,
        action.script,
        action,
        action.timeout,
      )
      return [
        jsonResult(await buildResponse(session, page, action.type, result)),
      ]
    }

    if (action.type === 'design_tokens') {
      const result = await evaluateInTarget(
        page,
        designTokensScript(action.selector, action.maxElements),
        action,
        action.timeout,
      )
      return [
        jsonResult(await buildResponse(session, page, action.type, result)),
      ]
    }

    if (action.type === 'wait_for') {
      const result = await evaluateInTarget(
        page,
        waitForScript({
          selector: action.selector,
          text: action.text,
          visible: action.visible ?? true,
          pollInterval: action.pollInterval ?? 100,
          timeout: action.timeout ?? 15_000,
          frameSelector: action.frameSelector,
        }),
        action,
        action.timeout ?? 15_000,
      )
      return [
        jsonResult(await buildResponse(session, page, action.type, result)),
      ]
    }

    if (action.type === 'upload') {
      const result = await uploadFiles(
        page,
        action.selector,
        action.paths,
        action,
        session.projectRoot,
      )
      return [
        jsonResult(await buildResponse(session, page, action.type, result)),
      ]
    }

    if (action.type === 'cookie') {
      const result = await handleCookieAction(page, action)
      return [
        jsonResult(await buildResponse(session, page, action.type, result)),
      ]
    }

    if (action.type === 'storage') {
      const result = await evaluateInTarget(
        page,
        storageScript(
          action.storage,
          action.operation,
          action.key,
          action.value,
        ),
        action,
        action.timeout,
      )
      return [
        jsonResult(await buildResponse(session, page, action.type, result)),
      ]
    }

    if (action.type === 'viewport') {
      await waitForCommand(
        page,
        'Emulation.setDeviceMetricsOverride',
        {
          width: action.width,
          height: action.height,
          deviceScaleFactor: action.deviceScaleFactor ?? 1,
          mobile: action.isMobile ?? false,
          screenWidth: action.width,
          screenHeight: action.height,
          dontSetVisibleSize: false,
        },
        action.timeout ?? 15_000,
      )
      if (action.userAgent) {
        await waitForCommand(
          page,
          'Network.setUserAgentOverride',
          { userAgent: action.userAgent },
          action.timeout ?? 15_000,
        )
      }
      if (action.hasTouch !== undefined) {
        await waitForCommand(
          page,
          'Emulation.setTouchEmulationEnabled',
          { enabled: action.hasTouch },
          action.timeout ?? 15_000,
        )
      }
      return [
        jsonResult(
          await buildResponse(session, page, action.type, {
            width: action.width,
            height: action.height,
          }),
        ),
      ]
    }

    if (action.type === 'network') {
      const offline = action.offline ?? false
      await waitForCommand(
        page,
        'Network.emulateNetworkConditions',
        {
          offline,
          latency: action.latency ?? 0,
          downloadThroughput: offline ? 0 : (action.downloadThroughput ?? -1),
          uploadThroughput: offline ? 0 : (action.uploadThroughput ?? -1),
        },
        action.timeout ?? 15_000,
      )
      return [
        jsonResult(
          await buildResponse(session, page, action.type, {
            offline,
            latency: action.latency ?? 0,
          }),
        ),
      ]
    }

    if (action.type === 'tab') {
      const result = await handleTabAction(session, action)
      const activePage = await getActivePage(session)
      return [
        jsonResult(
          await buildResponse(session, activePage, action.type, result),
        ),
      ]
    }

    if (action.type === 'recording') {
      const output = await handleRecordingAction(session, page, action)
      return output
    }

    if (action.type === 'pdf') {
      const result = await waitForCommand(
        page,
        'Page.printToPDF',
        {
          landscape: action.landscape ?? false,
          printBackground: action.printBackground ?? true,
          scale: action.scale ?? 1,
          paperWidth: action.paperWidth,
          paperHeight: action.paperHeight,
        },
        action.timeout ?? 15_000,
      )
      const data =
        isRecord(result) && typeof result.data === 'string' ? result.data : ''
      return [
        jsonResult({
          ...(await buildResponse(session, page, action.type)),
          ...buildPdfAttachmentMetadata(data),
        }),
      ]
    }

    if (action.type === 'pixel_diff') {
      const output = await pixelDiff(session, page, action)
      return output
    }

    if (action.type === 'diagnose') {
      const results = []
      for (const step of action.steps.slice(
        0,
        action.maxSteps ?? action.steps.length,
      )) {
        const stepOutput = await browserLogs(step.action, sessionKey)
        const json = stepOutput.find((item) => item.type === 'json')
        results.push({
          label: step.label,
          response: json?.value ?? null,
          expectedLogs: step.expectedLogs,
          noJsErrors: step.noJsErrors,
          noNetworkErrors: step.noNetworkErrors,
          customCondition: step.customCondition,
        })
      }
      const activePage = await getActivePage(session)
      return [
        jsonResult(
          await buildResponse(session, activePage, action.type, { results }),
        ),
      ]
    }

    const unsupportedAction = action as BrowserAction
    return [
      jsonResult({
        success: false,
        action: unsupportedAction.type,
        error: `Unsupported browser action: ${unsupportedAction.type}`,
        logs: [],
      }),
    ]
  } catch (error) {
    return [
      jsonResult({
        success: false,
        action: action.type,
        error: error instanceof Error ? error.message : String(error),
        logs: [],
      }),
    ]
  }
}

function jsonResult(value: BrowserResponse) {
  return { type: 'json' as const, value }
}

export function buildPdfAttachmentMetadata(data: string) {
  return {
    pdfAttached: data.length > 0,
    pdfBase64Length: data.length,
    pdfByteLength: data.length > 0 ? Buffer.byteLength(data, 'base64') : 0,
  }
}

/**
 * Probe seam for the /proc files chromeSandboxArgs reads. Unit tests replace
 * it to model kernel states (Ubuntu 24.04's apparmor userns restriction,
 * unreadable procfs, ...) without touching the real filesystem — the same
 * seam pattern as removeUserDataDirImpl below.
 */
export type ChromeSandboxProbe = {
  existsSync: (path: string) => boolean
  readFileSync: (path: string, encoding: 'utf8') => string
}

let sandboxProbeImpl: ChromeSandboxProbe = { existsSync, readFileSync }

/** Test seam: restores the real /proc probes between tests. */
export function __setChromeSandboxProbeForTest(
  probe: ChromeSandboxProbe | null,
): void {
  sandboxProbeImpl = probe ?? { existsSync, readFileSync }
}

/**
 * Diagnostic sink for undeterminable sandbox probes. chromeSandboxArgs has
 * no logger in scope, so the warn diagnostic goes to console.warn by
 * default; tests swap in a capturing sink here.
 */
let sandboxDiagnosticImpl: (message: string) => void = (message) => {
  console.warn(message)
}

/** Test seam: captures (or silences) sandbox-probe diagnostics. */
export function __setChromeSandboxDiagnosticForTest(
  sink: ((message: string) => void) | null,
): void {
  sandboxDiagnosticImpl =
    sink ??
    ((message) => {
      console.warn(message)
    })
}

function warnUndeterminableSandbox(reason: string): void {
  sandboxDiagnosticImpl(
    `chromeSandboxArgs: sandbox state undeterminable (${reason}); failing open to --no-sandbox`,
  )
}

/**
 * Decide whether Chrome must be launched with `--no-sandbox`.
 *
 * `--no-sandbox` disables Chrome's own OS-level sandbox and is a last resort:
 * we only pass it when the sandbox genuinely cannot function in the current
 * environment, otherwise Chrome runs sandboxed. Non-Linux platforms (macOS,
 * Windows) never need it — Chrome's sandbox works out of the box there, so we
 * return `[]`. On Linux we probe: running as root can't use the setuid
 * sandbox without extra setup (common in CI/containers), and unprivileged
 * user namespaces must be available for the namespace sandbox. Ubuntu 24.04
 * additionally restricts unprivileged user namespaces with AppArmor
 * (apparmor_restrict_unprivileged_userns=1) even while max_user_namespaces
 * stays positive, so that knob is checked FIRST: when it reads '1' the
 * namespace sandbox cannot create its userns and we treat the host exactly
 * like one without userns. When the sandbox can't work we fail open with
 * `['--no-sandbox']`, since a broken sandbox launch would hang the tool; when
 * availability is UNDETERMINABLE (a probe threw, or no probe file was
 * readable) the same documented fallback applies but a warn diagnostic names
 * the reason instead of disabling the sandbox silently.
 *
 * Note: no `CHROME_DISABLE_SANDBOX` env escape hatch is wired up here. Adding
 * one would require surfacing a new key from getSdkEnv() and editing the
 * SdkEnv type in sdk/src/types/env.ts, which is out of scope per the task
 * constraints (prefer skipping the hatch over a multi-file change).
 */
export function chromeSandboxArgs(): string[] {
  // Chrome's sandbox works out of the box on macOS/Windows.
  if (process.platform !== 'linux') return []

  // The setuid sandbox won't work as root without extra setup; disable it.
  // This matches common CI/container reality. process.getuid is undefined on
  // non-POSIX platforms, so guard with a typeof check.
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    return ['--no-sandbox']
  }

  // Linux, non-root: probe unprivileged user-namespace availability.
  // apparmor_restrict_unprivileged_userns first: on Ubuntu 24.04 it is the
  // deciding knob and the probes below would otherwise report 'available'.
  const apparmorPath =
    '/proc/sys/kernel/apparmor_restrict_unprivileged_userns'
  try {
    if (sandboxProbeImpl.existsSync(apparmorPath)) {
      if (
        sandboxProbeImpl.readFileSync(apparmorPath, 'utf8').trim() === '1'
      ) {
        // AppArmor restricts unprivileged userns: the namespace sandbox
        // cannot work, so treat the host as no-userns.
        return ['--no-sandbox']
      }
    }
  } catch (error) {
    warnUndeterminableSandbox(
      `could not read ${apparmorPath} (${error instanceof Error ? error.message : String(error)})`,
    )
    return ['--no-sandbox']
  }

  const clonePath = '/proc/sys/kernel/unprivileged_userns_clone'
  try {
    if (sandboxProbeImpl.existsSync(clonePath)) {
      return sandboxProbeImpl.readFileSync(clonePath, 'utf8').trim() === '1'
        ? []
        : ['--no-sandbox']
    }
  } catch (error) {
    warnUndeterminableSandbox(
      `could not read ${clonePath} (${error instanceof Error ? error.message : String(error)})`,
    )
    return ['--no-sandbox']
  }

  const maxPath = '/proc/sys/user/max_user_namespaces'
  try {
    if (sandboxProbeImpl.existsSync(maxPath)) {
      const max = parseInt(
        sandboxProbeImpl.readFileSync(maxPath, 'utf8').trim(),
        10,
      )
      return Number.isFinite(max) && max > 0 ? [] : ['--no-sandbox']
    }
  } catch (error) {
    warnUndeterminableSandbox(
      `could not read ${maxPath} (${error instanceof Error ? error.message : String(error)})`,
    )
    return ['--no-sandbox']
  }

  // Undeterminable: fail open so the tool doesn't hang on a broken sandbox,
  // and name the reason instead of disabling the sandbox silently.
  warnUndeterminableSandbox(
    'none of the /proc probes (apparmor_restrict_unprivileged_userns, unprivileged_userns_clone, max_user_namespaces) was present or readable',
  )
  return ['--no-sandbox']
}

/**
 * Best-effort rollback for a failed browser spawn attempt: closes the pipe
 * transport (rejecting every pending request), kills the Chrome child, and
 * removes the temp user-data dir. Each step is individually guarded so the
 * original spawn failure is what propagates to the caller.
 *
 * The user-data dir removal follows the same deferral contract as the stop
 * path (teardownBrowserSessionResources): the kill above is asynchronous, so
 * on Windows the dying child can still hold the dir open and an immediate
 * removal can fail (EBUSY/EPERM). The removal therefore goes through the
 * shared remover seam, and a failed dir is deferred to
 * sweepDeferredBrowserUserDataDirs — reclaimed on the next session activity
 * — instead of leaking one temp dir per failed spawn/probe with no sweep.
 */
export function rollbackBrowserSpawn(attempt: {
  child: Pick<ChildProcess, 'kill'>
  transport?: Pick<CdpPipeTransport, 'close'>
  userDataDir: string
  /** For the WebSocket fallback: closes the underlying socket. */
  dispose?: () => void
}): void {
  try {
    attempt.dispose?.()
  } catch {
    // ignore
  }
  try {
    attempt.transport?.close()
  } catch {
    // ignore
  }
  try {
    attempt.child.kill()
  } catch {
    // ignore
  }
  if (!removeUserDataDirImpl(attempt.userDataDir)) {
    // The dying child can still hold the dir open (EBUSY/EPERM on Windows):
    // defer it to the sweep instead of losing the removal silently. The set
    // dedupes, so a dir deferred by both this rollback and a later teardown
    // is only swept once.
    deferredUserDataDirCleanups.add(attempt.userDataDir)
  }
}

const pendingBrowserSessions = new Map<string, Promise<unknown>>()

/**
 * Collapse concurrent spawns for the same sessionKey into a single in-flight
 * attempt. Without this guard, two concurrent callers that both observe no
 * live session each spawn a Chrome process; only one wins the registry entry
 * and the loser's child/transport/user-data dir would leak. Every concurrent
 * caller shares the winner's promise, and the entry is cleared once it
 * settles so a failed spawn can be retried.
 */
export function shareInFlightBrowserSpawn<T>(
  sessionKey: string,
  spawnSession: () => Promise<T>,
): Promise<T> {
  const inFlight = pendingBrowserSessions.get(sessionKey)
  // Every promise stored under a key comes from that key's own spawnSession,
  // so the assertion preserves the caller's session type.
  if (inFlight) return inFlight as Promise<T>
  const spawnPromise = spawnSession()
  pendingBrowserSessions.set(sessionKey, spawnPromise)
  const clearIfCurrent = () => {
    // Only clear our own entry: a newer attempt may already have replaced it.
    if (pendingBrowserSessions.get(sessionKey) === spawnPromise) {
      pendingBrowserSessions.delete(sessionKey)
    }
  }
  // Handle both outcomes here so the cleanup chain never rejects unhandled;
  // callers observe the original promise directly.
  spawnPromise.then(clearIfCurrent, clearIfCurrent)
  return spawnPromise
}

/**
 * Session keys whose `stop` was requested while a spawn for the same key was
 * still in flight. The in-flight spawn consults this before registering: a
 * marked key means the spawn must roll itself back instead of registering a
 * live session that the already-returned `stop` will never reap.
 */
const stoppingSessionKeys = new Set<string>()

/**
 * Refcount of `stop` calls for each key whose teardown is still in flight.
 * A stop arms its marker at entry and releases its count only after the
 * multi-second teardown await, so the fresh-spawn path can tell a stop that
 * is still tearing the previous session down — whose marker must stay
 * armed — from a stale marker left behind by a stop that already returned.
 */
const activeStopSessionCounts = new Map<string, number>()

/**
 * Clear a stale stop marker before initiating a fresh spawn. A marker is
 * stale — and safe to clear — only when nothing is in flight for the key:
 * no pending spawn (the marker is that spawn's rollback guard) and no stop
 * still awaiting teardown. Clearing a marker whose stop is inside its
 * teardown window would let a spawn racing that teardown register a live
 * session the already-returning stop never reaps (the caller is told the
 * session stopped while the Chrome child, its transport, and its temp
 * user-data dir stay live), so the marker is held through the whole
 * teardown window and a racing spawn is rolled back by
 * honorStopRequestedDuringSpawn instead. Exported for unit tests, like
 * rollbackBrowserSpawn.
 */
export function clearStaleStopMarkerForFreshSpawn(sessionKey: string): void {
  if (
    !pendingBrowserSessions.has(sessionKey) &&
    !activeStopSessionCounts.has(sessionKey)
  ) {
    stoppingSessionKeys.delete(sessionKey)
  }
}

/**
 * Stop-vs-spawn race guard, called by the spawn path just before registering
 * a freshly assembled session. Returns true when a `stop` was requested while
 * the spawn was in flight: the session's resources are rolled back (Chrome
 * child, transport, temp user-data dir, ws disposal) and the caller must not
 * register it. Returns false when no stop is pending and the session should
 * be registered normally. Exported for unit tests, like routeEvent and
 * rollbackBrowserSpawn.
 */
export function honorStopRequestedDuringSpawn(
  sessionKey: string,
  session: {
    // Narrowed to exactly the surfaces rollbackBrowserSpawn consumes, so this
    // guard is unit-testable with a minimal mock (the file's existing
    // "narrowed for unit tests" pattern, like PageConnectSession).
    child: Pick<ChildProcess, 'kill'>
    transport: Pick<CdpPipeTransport, 'close'>
    userDataDir: string
    disposeTransport?: () => void
  },
): boolean {
  if (!stoppingSessionKeys.has(sessionKey)) return false
  rollbackBrowserSpawn({
    child: session.child,
    transport: session.transport,
    userDataDir: session.userDataDir,
    dispose: session.disposeTransport,
  })
  // Consume the marker only once no stop is still awaiting teardown: while
  // a stop's teardown window is open, EVERY spawn racing it must be rolled
  // back, so the marker stays armed for the next racing spawn too — a
  // one-shot consumption here would let a second spawn register live during
  // the same window and outlive the stop that reported success. The stop's
  // own completion resolves the marker instead: it is kept while a spawn is
  // still in flight (that spawn consumes it at registration) and cleared
  // otherwise, so it can never poison a later legitimate start.
  if (!activeStopSessionCounts.has(sessionKey)) {
    stoppingSessionKeys.delete(sessionKey)
  }
  return true
}

/**
 * Roll back a dead/stale session's resources and drop its registry entry (only
 * when `session` is still the entry registered under `sessionKey` — a respawn
 * may already have replaced it). Exported for unit tests, like routeEvent and
 * rollbackBrowserSpawn.
 */
export function rollbackStaleBrowserSession(
  sessionKey: string,
  session: Pick<
    BrowserSession,
    'child' | 'transport' | 'userDataDir' | 'disposeTransport'
  >,
): void {
  if (browserSessions.get(sessionKey) === session) {
    browserSessions.delete(sessionKey)
  }
  rollbackBrowserSpawn({
    child: session.child,
    transport: session.transport,
    userDataDir: session.userDataDir,
    dispose: session.disposeTransport,
  })
}

async function ensureBrowserSession(
  sessionKey: string,
  owner?: BrowserSessionOwner,
): Promise<BrowserSession> {
  // Reclaim any user-data dirs whose teardown-time removal was deferred (the
  // dying Chrome child still held them open) before possibly spawning a
  // fresh session, so a leaked dir is retried on the next session activity.
  sweepDeferredBrowserUserDataDirs()
  const existingSession = browserSessions.get(sessionKey)
  if (existingSession) {
    if (existingSession.child.exitCode === null) {
      return existingSession
    }
    // The Chrome child already exited: roll back everything the dead session
    // still held (temp user-data dir, pipe transport, and on the port
    // fallback the ws disposal) before respawning, so each crash/respawn
    // cycle reclaims rather than leaks the previous session's resources.
    rollbackStaleBrowserSession(sessionKey, existingSession)
  }
  // A fresh spawn attempt cancels a stale stop marker (a stop issued when
  // nothing was in flight). A stop issued during an already-in-flight spawn
  // arms the marker at stop entry — before this check runs — and that spawn
  // is still honored by it, so the guard only ever suppresses spawns the
  // stop actually raced against. A marker whose stop is STILL inside its
  // teardown window must not be cleared here: clearing it would let a spawn
  // racing that teardown register a live session the already-returning stop
  // never reaps, so clearStaleStopMarkerForFreshSpawn holds the marker for
  // the whole teardown window and the racing spawn is rolled back instead.
  clearStaleStopMarkerForFreshSpawn(sessionKey)
  return shareInFlightBrowserSpawn(sessionKey, () =>
    spawnBrowserSession(sessionKey, owner),
  )
}

/**
 * SB-7 compatibility: not every Chromium build honors
 * `--remote-debugging-pipe` (or flatten-mode attach). Launching such a build
 * with the pipe flag silently produces no CDP channel at all: without
 * detection the launch hangs for the full 10s target-discovery budget and
 * then fails with a generic "did not become ready" error, even though the
 * pre-SB-7 `--remote-debugging-port` transport would have worked.
 *
 * detectPipeSupport probes the installed browser with short, bounded CDP
 * round-trips over the pipe fds: a Target.getTargets round-trip whose result
 * carries a usable `targetInfos` entry, then a flatten-mode
 * Target.attachToTarget round-trip that returns a `sessionId` — the two shapes
 * the pipe session path actually relies on. Only a successful probe is cached
 * — as a positive verdict keyed by the resolved browser executable — because a
 * timeout or failure is not evidence that the browser lacks pipe support (a
 * slow cold start or contended tmpdir can blow the probe budget on a fully
 * capable browser), and a cached hard negative would silently route every
 * session in the TTL window to the fallback. When the probe does not confirm
 * support, spawnBrowserSession instead launches the session over
 * `--remote-debugging-port=0` (Chrome binds the debugging listener to
 * 127.0.0.1 unless --remote-debugging-address says otherwise), reads the
 * `DevTools listening on ws://...` line from stderr, and drives the same
 * CdpPipeTransport over a WebSocket bridge — so framing, pending-request
 * correlation, event routing, and timeouts are shared with the pipe path.
 */

export type PipeProbeAttempt = {
  child: Pick<ChildProcess, 'kill'>
  transport: Pick<CdpPipeTransport, 'send' | 'close'>
  userDataDir: string
}

export type PipeProbeHooks = {
  /**
   * Resolves the browser binary to probe. The resolved path also keys the
   * probe cache, so a cached verdict can never be applied to a different
   * binary than the one that produced it.
   */
  executablePath: () => string
  spawn: (executablePath: string) => PipeProbeAttempt
  probeTimeoutMs: number
  cacheTtlMs: number
  now: () => number
}

const PIPE_PROBE_TIMEOUT_MS = 3_000
const PIPE_PROBE_CACHE_TTL_MS = 60_000

/**
 * Positive-only, per-executable cache: a present entry means "this binary
 * answered the full pipe probe — a Target.getTargets round-trip carrying
 * targetInfos plus a flatten-mode Target.attachToTarget round-trip returning
 * a sessionId". Failed or timed-out probes are
 * deliberately not cached — a timeout is not evidence that the browser lacks
 * pipe support, so caching a negative would pin the port fallback for the
 * whole TTL window on slow machines/CI.
 */
const pipeProbeCache = new Map<string, { probedAt: number }>()

/**
 * Per-executable in-flight probes: a present entry is the single probe
 * promise every concurrent caller for that binary shares until it settles.
 */
const inFlightPipeProbes = new Map<string, Promise<boolean>>()

/**
 * Collapse concurrent probes for the same executable into a single in-flight
 * probe, mirroring shareInFlightBrowserSpawn for spawns. Without this guard,
 * concurrent ensureBrowserSession calls for different session keys (before a
 * positive verdict is cached) each launch a full probe Chrome and each absorb
 * up to the probe budget. Every concurrent caller shares the winner's probe
 * promise; the entry is cleared once it settles so a failed or inconclusive
 * probe is retried by the next session, exactly like the cache contract.
 */
function shareInFlightPipeProbe(
  executablePath: string,
  runProbe: () => Promise<boolean>,
): Promise<boolean> {
  const inFlight = inFlightPipeProbes.get(executablePath)
  if (inFlight) return inFlight
  const probePromise = runProbe()
  inFlightPipeProbes.set(executablePath, probePromise)
  const clearIfCurrent = () => {
    // Only clear our own entry: a newer probe may already have replaced it.
    if (inFlightPipeProbes.get(executablePath) === probePromise) {
      inFlightPipeProbes.delete(executablePath)
    }
  }
  // Handle both outcomes here so the cleanup chain never rejects unhandled;
  // callers observe the original promise directly.
  probePromise.then(clearIfCurrent, clearIfCurrent)
  return probePromise
}

/**
 * Only the CdpPipeTransport's own per-request timeout rejection
 * ("<method> timed out after <N>ms") counts as a probe timeout. A timeout is
 * NOT evidence that the binary lacks pipe support, so it must not trigger the
 * port fallback: the verdict is inconclusive and the session fails closed
 * instead of silently reopening an unauthenticated DevTools listener.
 */
function isProbeTimeoutError(error: unknown): boolean {
  return (
    error instanceof Error && / timed out after \d+ms$/.test(error.message)
  )
}

/**
 * The targetId the flatten-attach probe attaches to, read from
 * Target.getTargets' `targetInfos` the same way the session path's
 * listTargets narrows it. Page-type targets are preferred (that is what the
 * session path attaches to); any entry with a string targetId is accepted so
 * a probe browser without a page target still exercises the attach
 * round-trip.
 */
function firstAttachableTargetId(result: unknown): string | undefined {
  if (!isRecord(result) || !Array.isArray(result.targetInfos)) return undefined
  let fallback: string | undefined
  for (const info of result.targetInfos) {
    if (!isRecord(info) || typeof info.targetId !== 'string') continue
    if (info.type === 'page') return info.targetId
    fallback ??= info.targetId
  }
  return fallback
}

export async function detectPipeSupport(
  overrides?: Partial<PipeProbeHooks>,
): Promise<boolean> {
  const hooks: PipeProbeHooks = {
    executablePath: findChromeExecutable,
    spawn: spawnPipeProbeAttempt,
    probeTimeoutMs: PIPE_PROBE_TIMEOUT_MS,
    cacheTtlMs: PIPE_PROBE_CACHE_TTL_MS,
    now: Date.now,
    ...overrides,
  }
  // Key the cache by the resolved executable: if findChromeExecutable()
  // resolves a different Chromium binary within the TTL, the first binary's
  // verdict must not drive the second one.
  const executablePath = hooks.executablePath()
  const cached = pipeProbeCache.get(executablePath)
  if (cached && hooks.now() - cached.probedAt < hooks.cacheTtlMs) {
    return true
  }
  // Concurrent callers for the same binary share one probe (deduped by
  // executable) instead of each launching a probe Chrome and each absorbing
  // the probe budget.
  return shareInFlightPipeProbe(executablePath, () =>
    probePipeSupportOnce(hooks, executablePath),
  )
}

/**
 * One full probe attempt for `executablePath`: spawns a probe browser, runs
 * the two CDP round-trips the pipe session path relies on, caches a positive
 * verdict, and always rolls the probe browser back. Only reached through
 * shareInFlightPipeProbe, so concurrent callers share a single attempt.
 */
async function probePipeSupportOnce(
  hooks: PipeProbeHooks,
  executablePath: string,
): Promise<boolean> {
  let attempt: PipeProbeAttempt
  try {
    attempt = hooks.spawn(executablePath)
  } catch {
    // A synchronous spawn throw (e.g. the pipe fds were missing after spawn,
    // or the browser exited immediately) is demonstrable evidence the pipe
    // path cannot work for this binary: fall back to the port transport for
    // THIS session only. The negative is never cached, so the next session
    // re-probes.
    return false
  }
  try {
    const getTargetsResult = await attempt.transport.send(
      'Target.getTargets',
      {},
      { timeoutMs: hooks.probeTimeoutMs },
    )
    // Flatten-mode attach needs a real targetId, which the session path reads
    // from Target.getTargets' `targetInfos`. A build that answers the command
    // but never returns a usable targetInfos entry cannot support the pipe
    // session path (listTargets/waitForPageTarget would never find a page),
    // so this is a demonstrable pipe failure — not a timeout — and the
    // session falls back to the port transport.
    const targetId = firstAttachableTargetId(getTargetsResult)
    if (targetId === undefined) {
      return false
    }
    // Probe the flatten-mode session attach the session path relies on
    // (connectPage's Target.attachToTarget {flatten:true}): a build that
    // round-trips Target.getTargets but does not honor flatten attach would
    // otherwise pass this probe and only fail later, at connectPage, with
    // "Chrome did not attach to target" and no fallback.
    const attached = await attempt.transport.send(
      'Target.attachToTarget',
      { targetId, flatten: true },
      { timeoutMs: hooks.probeTimeoutMs },
    )
    if (!isRecord(attached) || typeof attached.sessionId !== 'string') {
      // The attach answered without the sessionId connectPage requires: a
      // demonstrable flatten-attach failure, not a timeout.
      return false
    }
    // A successful CDP round-trip is durable proof this binary supports
    // --remote-debugging-pipe (and flatten-mode attach): cache the positive
    // verdict per executable.
    pipeProbeCache.set(executablePath, { probedAt: hooks.now() })
    return true
  } catch (error) {
    if (isProbeTimeoutError(error)) {
      // No framed CDP response within the probe budget. A timeout is NOT
      // evidence the browser lacks pipe support (a slow start is common on
      // loaded machines/CI), so fail closed instead of routing this session
      // to the unauthenticated --remote-debugging-port=0 fallback. The
      // negative is never cached, so the next session re-probes.
      throw new Error(
        `Browser pipe-support probe timed out after ${hooks.probeTimeoutMs}ms without a CDP response; the pipe transport could not be confirmed and the unauthenticated port fallback was not used. Retry the browser action.`,
      )
    }
    // A demonstrable failure (the browser exited without answering, the pipe
    // errored or closed, or the flatten attach was refused) proves the pipe
    // path is unusable for this binary:
    // treat the pipe as unsupported for THIS session only. The negative is
    // never cached, so a transient failure re-probes on the next session
    // instead of silently routing every session in the window to the port
    // fallback.
    return false
  } finally {
    rollbackBrowserSpawn({
      child: attempt.child,
      transport: attempt.transport,
      userDataDir: attempt.userDataDir,
    })
  }
}

/** Test seam: clears the cached pipe-support verdicts between tests. */
export function __resetPipeSupportProbeCacheForTest(): void {
  pipeProbeCache.clear()
}

function spawnPipeProbeAttempt(executablePath: string): PipeProbeAttempt {
  const userDataDir = mkdtempSync(
    path.join(tmpdir(), 'openbuff-browser-probe-'),
  )
  const child = spawn(
    // The probed binary is exactly the executable the cache key was derived
    // from, so the verdict cannot describe a different binary than the one
    // that was actually probed.
    executablePath,
    [
      '--headless=new',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--no-first-run',
      '--no-default-browser-check',
      ...chromeSandboxArgs(),
      '--remote-debugging-pipe',
      `--user-data-dir=${userDataDir}`,
      'about:blank',
    ],
    { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] },
  )
  const commandWritable = child.stdio[3]
  const responseReadable = child.stdio[4]
  if (!commandWritable || !responseReadable) {
    rollbackBrowserSpawn({ child, userDataDir })
    throw new Error(
      'Chrome did not expose the remote debugging pipe file descriptors',
    )
  }
  return {
    child,
    transport: new CdpPipeTransport({
      writable: commandWritable as Writable,
      readable: responseReadable as Readable,
    }),
    userDataDir,
  }
}

type BrowserConnection = {
  child: ChildProcess
  userDataDir: string
  writable: Writable
  readable: Readable
  /** For the WebSocket fallback: closes the underlying socket. */
  dispose?: () => void
}

const DEVTOOLS_URL_TIMEOUT_MS = 5_000
const WEBSOCKET_CONNECT_TIMEOUT_MS = 5_000
const MAX_DEVTOOLS_STDERR_BYTES = 64 * 1024

const DEVTOOLS_LISTENING_PATTERN = /DevTools listening on (ws:\/\/\S+)/

/** Exported for unit tests, like routeEvent and rollbackBrowserSpawn. */
export function extractDevtoolsWebSocketUrl(
  stderrText: string,
): string | undefined {
  return stderrText.match(DEVTOOLS_LISTENING_PATTERN)?.[1]
}

/**
 * Structural shape readDevtoolsWebSocketUrl needs. Narrowed instead of
 * Pick<ChildProcess, ...> so a fake child can satisfy it without inheriting
 * ChildProcess's `this`-returning on/off signatures.
 */
type DevtoolsReportingChild = {
  stderr: Readable | null
  on(event: string | symbol, listener: (...args: any[]) => void): unknown
  off(event: string | symbol, listener: (...args: any[]) => void): unknown
}

/**
 * Read the `DevTools listening on ws://...` line Chrome prints on stderr when
 * launched with `--remote-debugging-port=0`. Bounded: resolves with the URL
 * as soon as the line appears, and rejects on the timeout, on stderr growing
 * past the accumulation cap, or on the child exiting or erroring first.
 * Exported for unit tests, like routeEvent and rollbackBrowserSpawn.
 */
export async function readDevtoolsWebSocketUrl(
  child: DevtoolsReportingChild,
  timeoutMs: number,
): Promise<string> {
  const stderr = child.stderr
  if (!stderr) {
    throw new Error(
      'Chrome stderr is not piped; cannot read the DevTools WebSocket URL',
    )
  }
  return new Promise<string>((resolve, reject) => {
    let accumulated = ''
    let settled = false
    const onData = (chunk: Buffer | string) => {
      accumulated += typeof chunk === 'string' ? chunk : chunk.toString('utf8')
      if (accumulated.length > MAX_DEVTOOLS_STDERR_BYTES) {
        settle(
          new Error(
            'Chrome stderr grew past the bounded window before a DevTools WebSocket URL appeared',
          ),
        )
        return
      }
      const url = extractDevtoolsWebSocketUrl(accumulated)
      if (url !== undefined) settle(undefined, url)
    }
    const onExit = () => {
      settle(
        new Error('Chrome exited before reporting a DevTools WebSocket URL'),
      )
    }
    const onError = (error: Error) => {
      settle(error)
    }
    const settle = (error: Error | undefined, url?: string) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      stderr.off('data', onData)
      child.off('exit', onExit)
      child.off('error', onError)
      if (error !== undefined || url === undefined) {
        reject(
          error ?? new Error('Chrome did not report a DevTools WebSocket URL'),
        )
      } else {
        resolve(url)
      }
    }
    const timer = setTimeout(
      () =>
        settle(
          new Error(
            `Chrome did not report a DevTools WebSocket URL within ${timeoutMs}ms`,
          ),
        ),
      timeoutMs,
    )
    stderr.on('data', onData)
    child.on('exit', onExit)
    child.on('error', onError)
  })
}

function cdpWebSocketAdapter(ws: WebSocket): CdpWebSocket {
  return {
    send: (data) => ws.send(data),
    close: () => ws.close(),
    on: (event, listener) => {
      if (event === 'message') {
        ws.on('message', (data) => listener(webSocketFrameText(data)))
      } else if (event === 'open') {
        ws.on('open', () => listener(undefined))
      } else if (event === 'close') {
        ws.on('close', () => listener(undefined))
      } else {
        ws.on('error', (error) => listener(error))
      }
    },
  }
}

function webSocketFrameText(data: unknown): string {
  if (typeof data === 'string') return data
  if (Buffer.isBuffer(data)) return data.toString('utf8')
  if (Array.isArray(data)) {
    return Buffer.concat(
      data.map((part) =>
        Buffer.isBuffer(part)
          ? part
          : Buffer.from(part as ArrayBufferLike),
      ),
    ).toString('utf8')
  }
  return Buffer.from(data as ArrayBufferLike).toString('utf8')
}

/**
 * Redacted scheme+host form of a DevTools ws URL for error messages: the full
 * URL embeds the /devtools/browser/<guid> capability token, which must never
 * appear in errors surfaced to the model. Exported for unit tests, like
 * extractDevtoolsWebSocketUrl.
 */
export function redactDevtoolsUrl(url: string): string {
  try {
    return new URL(url).origin
  } catch {
    return '(redacted DevTools endpoint)'
  }
}

async function connectWebSocketTransport(url: string): Promise<{
  writable: Writable
  readable: Readable
  dispose: () => void
}> {
  // Only the scheme+host form may appear in surfaced errors: the full URL
  // carries the browser capability token.
  const redactedEndpoint = redactDevtoolsUrl(url)
  const ws = new WebSocket(url)
  try {
    await new Promise<void>((resolve, reject) => {
      let settled = false
      const settle = (error: Error | undefined) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (error !== undefined) reject(error)
        else resolve()
      }
      const timer = setTimeout(
        () =>
          settle(
            new Error(
              `Timed out connecting to the Chrome DevTools WebSocket at ${redactedEndpoint}`,
            ),
          ),
        WEBSOCKET_CONNECT_TIMEOUT_MS,
      )
      ws.once('open', () => settle(undefined))
      ws.once('error', (error: Error) =>
        settle(
          new Error(
            `Failed to connect to the Chrome DevTools WebSocket at ${redactedEndpoint}: ${error.message}`,
          ),
        ),
      )
    })
  } catch (error) {
    try {
      ws.close()
    } catch {
      // ignore
    }
    throw error
  }
  return createWebSocketPipeBridge(cdpWebSocketAdapter(ws))
}

function spawnPipeConnection(): BrowserConnection {
  const userDataDir = mkdtempSync(path.join(tmpdir(), 'openbuff-browser-'))
  const child = spawn(
    findChromeExecutable(),
    [
      '--headless=new',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--no-first-run',
      '--no-default-browser-check',
      ...chromeSandboxArgs(),
      // SB-7: drive the DevTools protocol over the stdio pipe file
      // descriptors instead of `--remote-debugging-port`. The old flag opened
      // an UNAUTHENTICATED HTTP+WebSocket listener on 127.0.0.1 that any
      // local process could enumerate and drive; the pipe fds are only
      // reachable by this parent process, so the debugging channel is
      // private by construction.
      '--remote-debugging-pipe',
      `--user-data-dir=${userDataDir}`,
      '--window-size=1280,720',
      'about:blank',
    ],
    {
      // fd 3 carries parent->Chrome commands, fd 4 carries Chrome->parent
      // responses and events. fds 0-2 stay ignored.
      stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'],
    },
  )
  const commandWritable = child.stdio[3]
  const responseReadable = child.stdio[4]
  if (!commandWritable || !responseReadable) {
    rollbackBrowserSpawn({ child, userDataDir })
    throw new Error(
      'Chrome did not expose the remote debugging pipe file descriptors',
    )
  }
  return {
    child,
    userDataDir,
    writable: commandWritable as Writable,
    readable: responseReadable as Readable,
  }
}

async function spawnPortConnection(): Promise<BrowserConnection> {
  const userDataDir = mkdtempSync(path.join(tmpdir(), 'openbuff-browser-'))
  const child = spawn(
    findChromeExecutable(),
    [
      '--headless=new',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--no-first-run',
      '--no-default-browser-check',
      ...chromeSandboxArgs(),
      // Compatibility fallback for browsers without --remote-debugging-pipe:
      // port 0 makes Chrome pick a free port and print the DevTools WebSocket
      // URL on stderr. Chrome binds the debugging listener to 127.0.0.1
      // (unless --remote-debugging-address overrides it), so the channel stays
      // local like the pipe fds, though it is not single-process-restricted
      // the way the pipe is.
      '--remote-debugging-port=0',
      `--user-data-dir=${userDataDir}`,
      '--window-size=1280,720',
      'about:blank',
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  )
  try {
    const webSocketUrl = await readDevtoolsWebSocketUrl(
      child,
      DEVTOOLS_URL_TIMEOUT_MS,
    )
    return {
      child,
      userDataDir,
      ...(await connectWebSocketTransport(webSocketUrl)),
    }
  } catch (error) {
    rollbackBrowserSpawn({ child, userDataDir })
    throw error
  }
}

async function spawnBrowserSession(
  sessionKey: string,
  owner?: BrowserSessionOwner,
): Promise<BrowserSession> {
  // One bounded probe decides the transport for this browser binary; a
  // positive verdict is cached per executable so repeated sessions do not
  // re-launch a probe browser. A demonstrable pipe failure falls back to the
  // port transport for this session, while a probe timeout fails closed (and
  // nothing negative is cached, so the next session re-probes).
  const usePipe = await detectPipeSupport()
  const connection = usePipe
    ? spawnPipeConnection()
    : await spawnPortConnection()
  return assembleBrowserSession(sessionKey, owner, connection)
}

async function assembleBrowserSession(
  sessionKey: string,
  owner: BrowserSessionOwner | undefined,
  connection: BrowserConnection,
): Promise<BrowserSession> {
  const { child, userDataDir, writable, readable } = connection
  // Register the child exit handler before any await or failure path: if
  // Chrome dies at any point, the session is reaped from the registry instead
  // of leaking as an orphan no handler could clean up later.
  let session: BrowserSession | undefined
  child.on('exit', () => {
    if (session && browserSessions.get(sessionKey) === session) {
      // The session is being reaped because Chrome died: roll back the
      // resources it still held (temp user-data dir, pipe transport, and on
      // the port fallback the ws disposal) instead of leaving them to OS tmp
      // cleanup — once this registry entry is gone, the respawn path can no
      // longer reclaim them.
      rollbackStaleBrowserSession(sessionKey, session)
    }
  })
  let transport: CdpPipeTransport | undefined
  try {
    transport = new CdpPipeTransport({
      writable,
      readable,
      // Events only start flowing after Target.setDiscoverTargets below;
      // before the session object exists there is no router yet.
      onEvent: (message) => {
        if (session) routeEvent(session, message)
      },
      onClose: () => {
        // The transport already rejected every pending request; the child
        // 'exit' handler above removes the session from the registry.
      },
    })
    await transport.send('Target.setDiscoverTargets', { discover: true })
    const targetId = await waitForPageTarget(transport)
    session = {
      ...(owner ? { owner } : {}),
      ...(owner?.projectRoot !== undefined
        ? { projectRoot: owner.projectRoot }
        : {}),
      child,
      transport,
      userDataDir,
      ...(connection.dispose ? { disposeTransport: connection.dispose } : {}),
      pages: new Map(),
      pagesBySessionId: new Map(),
      activeTargetId: targetId,
      logs: [],
      networks: [],
      networkRequests: new Map(),
      logOffset: 0,
      networkOffset: 0,
      recording: null,
      pendingEvents: new Map(),
      pendingEventCount: 0,
    }
    const page = await connectPage(session, targetId)
    session.pages.set(targetId, page)
    session.pagesBySessionId.set(page.sessionId, page)
    // Stop-vs-spawn race guard: a `stop` issued while this spawn was in
    // flight must win over this registration, otherwise the freshly spawned
    // Chrome child, transport, and temp user-data dir would leak past a stop
    // that already returned success.
    if (honorStopRequestedDuringSpawn(sessionKey, session)) {
      throw new Error(
        `Browser session ${sessionKey} was stopped during startup`,
      )
    }
    browserSessions.set(sessionKey, session)
    return session
  } catch (error) {
    // Roll back everything this attempt created: the open transport, the
    // spawned Chrome child, and the temp user-data dir. The exit handler above
    // is already registered, so the child cannot survive as an untracked
    // orphan either way. For the WebSocket fallback, dispose also closes the
    // underlying socket before the child is killed. A stop that was requested
    // during this failed spawn is cleared through the same guarded path the
    // fresh-spawn entry uses, so a marker held by a stop still inside its
    // teardown window is never force-cleared here.
    clearStaleStopMarkerForFreshSpawn(sessionKey)
    rollbackBrowserSpawn({
      child,
      transport,
      userDataDir,
      dispose: connection.dispose,
    })
    throw error
  }
}

/**
 * The slice of BrowserSession connectPage needs. Narrowed so the reconnect
 * and domain-enable failure paths can be unit-tested without a live Chrome
 * child, like RoutableSession for routeEvent.
 */
export type PageConnectSession = RoutableSession &
  Pick<BrowserSession, 'transport'>

/**
 * In-flight connectPage promises keyed by session object and then targetId.
 * Two concurrent calls that reconnect the same dead target would otherwise
 * both pass the existing-page check and each issue a flatten attach: Chrome
 * hands back two distinct sessionIds, only the last-registered page wins,
 * and the loser's sessionId stays attached in Chrome — its events then drain
 * into the bounded pendingEvents buffer until the browser exits. Sharing one
 * in-flight attach collapses those callers onto a single session, the same
 * way shareInFlightBrowserSpawn collapses concurrent spawns. Entries clear
 * on settlement so a failed attach can be retried.
 */
const inFlightPageConnects = new WeakMap<
  PageConnectSession,
  Map<string, Promise<BrowserPage>>
>()

export async function connectPage(
  session: PageConnectSession,
  targetId: string,
): Promise<BrowserPage> {
  const existing = session.pages.get(targetId)
  if (existing && !session.transport.isClosed) return existing

  let inFlightMap = inFlightPageConnects.get(session)
  if (!inFlightMap) {
    inFlightMap = new Map<string, Promise<BrowserPage>>()
    inFlightPageConnects.set(session, inFlightMap)
  }
  const inFlight = inFlightMap
  const pending = inFlight.get(targetId)
  if (pending) return pending

  const connectPromise = attachPage(session, targetId)
  inFlight.set(targetId, connectPromise)
  const clearIfCurrent = () => {
    // Only clear our own entry: a newer attempt may already have replaced it.
    if (inFlight.get(targetId) === connectPromise) {
      inFlight.delete(targetId)
    }
  }
  // Handle both outcomes here so the cleanup chain never rejects unhandled;
  // callers observe the original promise directly.
  connectPromise.then(clearIfCurrent, clearIfCurrent)
  return connectPromise
}

/**
 * Issue the flatten attach, register the page, and enable its domains. The
 * guarded body of connectPage, split out so concurrent callers reconnecting
 * the same target share a single in-flight attach instead of each issuing
 * their own.
 */
async function attachPage(
  session: PageConnectSession,
  targetId: string,
): Promise<BrowserPage> {
  // Attach in flatten mode: the returned sessionId routes every command and
  // event for this target over the single pipe connection.
  const attached = await session.transport.send('Target.attachToTarget', {
    targetId,
    flatten: true,
  })
  const sessionId =
    isRecord(attached) && typeof attached.sessionId === 'string'
      ? attached.sessionId
      : undefined
  if (!sessionId) {
    throw new Error(`Chrome did not attach to target: ${targetId}`)
  }
  const page: BrowserPage = {
    targetId,
    sessionId,
    transport: session.transport,
    eventWaiters: new Map(),
    executionContexts: new Map(),
  }
  // Register the page BEFORE enabling domains: session-scoped events can
  // arrive as soon as Target.attachToTarget completes, and routeEvent must
  // find the owning page instead of dropping the event or misrouting it to
  // the previously active page. Events that arrived during that window are
  // drained here, in order.
  session.pages.set(targetId, page)
  session.pagesBySessionId.set(page.sessionId, page)
  flushPendingEvents(session, page)
  try {
    await enablePageDomains(page)
  } catch (error) {
    // The flatten session this attach created is now orphaned: without a
    // detach Chrome keeps routing its events to a sessionId no page will ever
    // register again (a reconnect attaches under a fresh sessionId), and
    // those permanently-unroutable events would fill the bounded pendingEvents
    // buffer and evict useful buffered events. Drop this session's buffered
    // events and ask Chrome to detach. The detach is fire-and-forget: if it
    // fails (e.g. the transport is closing) the original enable error is what
    // propagates. As before, a page whose domains could not be enabled is not
    // registered, so the next attempt reconnects cleanly.
    discardPendingEvents(session, page.sessionId)
    void session.transport
      .send('Target.detachFromTarget', { sessionId: page.sessionId })
      .catch(() => undefined)
    session.pages.delete(targetId)
    session.pagesBySessionId.delete(page.sessionId)
    throw error
  }
  return page
}

async function getActivePage(session: BrowserSession): Promise<BrowserPage> {
  const existing = session.pages.get(session.activeTargetId)
  if (existing && !session.transport.isClosed) return existing

  const target = (await listTargets(session.transport)).find(
    (candidate) => candidate.targetId === session.activeTargetId,
  )
  if (!target) {
    throw new Error(
      `Active browser target not found: ${session.activeTargetId}`,
    )
  }
  const page = await connectPage(session, target.targetId)
  session.pages.set(target.targetId, page)
  session.pagesBySessionId.set(page.sessionId, page)
  return page
}

async function enablePageDomains(page: BrowserPage) {
  await Promise.all([
    waitForCommand(page, 'Page.enable'),
    waitForCommand(page, 'Runtime.enable'),
    waitForCommand(page, 'Log.enable'),
    waitForCommand(page, 'Network.enable'),
    waitForCommand(page, 'DOM.enable'),
  ])
}

const browserTeardownTiming = {
  /** Bounded wait for the killed Chrome child to finish exiting. */
  childExitTimeoutMs: 2_000,
  childExitPollMs: 10,
  /** Retry cadence for removing a user-data dir that is still held open. */
  userDataDirRetryDelayMs: 25,
  userDataDirRetries: 4,
}

export function __setBrowserTeardownTimingForTest(
  overrides: Partial<typeof browserTeardownTiming>,
): void {
  Object.assign(browserTeardownTiming, overrides)
}

function defaultRemoveUserDataDir(userDataDir: string): boolean {
  try {
    rmSync(userDataDir, { recursive: true, force: true })
    return true
  } catch {
    // The dying child can still hold the dir open (EBUSY/EPERM on Windows):
    // the caller retries and defers rather than leaking silently.
    return false
  }
}

/**
 * Remover seam for teardown paths: unit tests swap it to simulate a removal
 * that fails because the dying Chrome child still holds the directory open.
 */
let removeUserDataDirImpl: (userDataDir: string) => boolean =
  defaultRemoveUserDataDir

export function __setBrowserUserDataDirRemoverForTest(
  remover: ((userDataDir: string) => boolean) | null,
): void {
  removeUserDataDirImpl = remover ?? defaultRemoveUserDataDir
}

/**
 * Bounded wait for the killed Chrome child to finish exiting. The child's
 * temp user-data dir cannot be removed while it still holds files open, so
 * teardown waits for exit before removing. Returns whether the child was
 * observed to exit within the timeout.
 */
async function waitForChildExit(
  child: Pick<ChildProcess, 'exitCode'>,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (child.exitCode === null && Date.now() < deadline) {
    await new Promise((resolve) =>
      setTimeout(resolve, browserTeardownTiming.childExitPollMs),
    )
  }
  return child.exitCode !== null
}

/**
 * Temp user-data dirs whose teardown-time removal failed. Swept on session
 * activity so a dir the dying child held open is reclaimed by a later
 * spawn/stop instead of leaking one temp dir per stop.
 */
const deferredUserDataDirCleanups = new Set<string>()

/**
 * Retry removal of user-data dirs deferred by failed teardown removals (the
 * stop path) and failed spawn/probe rollback removals (rollbackBrowserSpawn).
 * Called from ensureBrowserSession (the respawn path) so a dir that leaked
 * past either path is reclaimed on the next session activity; exported for
 * unit tests, like rollbackBrowserSpawn.
 */
export function sweepDeferredBrowserUserDataDirs(): void {
  for (const userDataDir of [...deferredUserDataDirCleanups]) {
    if (removeUserDataDirImpl(userDataDir)) {
      deferredUserDataDirCleanups.delete(userDataDir)
    }
  }
}

/**
 * Tear down one session's resources: dispose/close the transport, kill the
 * Chrome child, and remove the temp user-data dir — but only after waiting
 * (bounded) for the child to exit. Removing the dir while the dying child
 * still holds it open fails with EBUSY/EPERM on Windows and would leak one
 * temp dir per stop, so the removal retries briefly and, if it still fails,
 * defers the dir to sweepDeferredBrowserUserDataDirs instead of losing it:
 * the registry entry is already gone by then, so the respawn-time
 * rollbackStaleBrowserSession cleanup can never run for this session.
 */
async function teardownBrowserSessionResources(session: {
  child: ChildProcess
  transport: Pick<CdpPipeTransport, 'close'>
  userDataDir: string
  disposeTransport?: () => void
}): Promise<void> {
  try {
    session.disposeTransport?.()
  } catch {
    // ignore
  }
  try {
    session.transport.close()
  } catch {
    // ignore
  }
  try {
    session.child.kill()
  } catch {
    // ignore
  }
  await waitForChildExit(
    session.child,
    browserTeardownTiming.childExitTimeoutMs,
  )
  let removed = false
  for (
    let attempt = 0;
    attempt < browserTeardownTiming.userDataDirRetries && !removed;
    attempt++
  ) {
    if (attempt > 0) {
      await new Promise((resolve) =>
        setTimeout(resolve, browserTeardownTiming.userDataDirRetryDelayMs),
      )
    }
    removed = removeUserDataDirImpl(session.userDataDir)
  }
  if (!removed) {
    deferredUserDataDirCleanups.add(session.userDataDir)
  }
}

export async function stopBrowserSession(sessionKey: string) {
  // Stop-vs-spawn race guard, armed BEFORE the multi-second teardown await:
  // an in-flight spawn for this key that completes while this stop is still
  // tearing the previous session down must roll itself back instead of
  // registering a live session this stop — which only returns once teardown
  // finishes — will never reap. A stop issued when nothing is in flight also
  // arms the marker here. The marker is held for the WHOLE teardown window
  // (tracked by activeStopSessionCounts): the fresh-spawn path cannot clear
  // it mid-window, and every spawn racing the window is rolled back by
  // honorStopRequestedDuringSpawn, so no live session can outlive this stop.
  // When the last stop's teardown finishes, the marker is resolved: kept if
  // a spawn is still in flight (its registration consumes it — the same
  // one-shot contract a stop racing an in-flight spawn has always had) and
  // cleared otherwise, so it cannot poison a later legitimate start.
  stoppingSessionKeys.add(sessionKey)
  activeStopSessionCounts.set(
    sessionKey,
    (activeStopSessionCounts.get(sessionKey) ?? 0) + 1,
  )
  try {
    const session = browserSessions.get(sessionKey)
    browserSessions.delete(sessionKey)
    if (session) {
      // Closing the transport rejects every pending request (its destroy path
      // handles that), so there is no per-page teardown left to do: one pipe
      // connection multiplexes all targets. For sessions spawned on the
      // WebSocket fallback (--remote-debugging-port=0), disposeTransport also
      // closes the underlying ws socket deterministically here; the pipe
      // transport needs no extra disposal.
      await teardownBrowserSessionResources(session)
    }
  } finally {
    const activeStops = (activeStopSessionCounts.get(sessionKey) ?? 1) - 1
    if (activeStops <= 0) {
      activeStopSessionCounts.delete(sessionKey)
      // The last stop's teardown finished. The marker is stale unless a
      // spawn is still in flight — that spawn consumes it at registration.
      if (!pendingBrowserSessions.has(sessionKey)) {
        stoppingSessionKeys.delete(sessionKey)
      }
    } else {
      activeStopSessionCounts.set(sessionKey, activeStops)
    }
  }
}

/**
 * Test seam: registers a teardown-shaped session under `sessionKey` so
 * stopBrowserSession's teardown can be unit-tested without a live Chrome
 * child. Only the teardown-relevant slice is required; the registry stores the
 * full session type, so the narrowing cast is contained here.
 */
export function __registerBrowserSessionForTest(
  sessionKey: string,
  session: Pick<
    BrowserSession,
    'owner' | 'child' | 'transport' | 'userDataDir' | 'disposeTransport'
  >,
): void {
  browserSessions.set(sessionKey, session as BrowserSession)
}

export async function stopBrowserSessionsByPrefix(prefix: string) {
  const keys = [...browserSessions.keys()].filter((key) =>
    key.startsWith(prefix),
  )
  await Promise.all(keys.map((key) => stopBrowserSession(key)))
}

export async function stopBrowserSessionsByOwner(
  owner: Pick<BrowserSessionOwner, 'clientSessionId'>,
) {
  const keys = [...browserSessions.entries()]
    .filter(
      ([, session]) =>
        session.owner?.clientSessionId === owner.clientSessionId ||
        // Ownerless sessions (bare-string keys such as the default session)
        // store no owner, so without this branch they would never be reaped
        // at run end and would leak fds, processes, and temp dirs.
        session.owner === undefined,
    )
    .map(([key]) => key)
  await Promise.all(keys.map((key) => stopBrowserSession(key)))
}

/**
 * Upper bound on CDP events buffered for not-yet-registered targets. If a
 * sessionId never gets a registered page (e.g. a target destroyed before
 * connectPage finishes), its buffered events are dropped oldest-first instead
 * of growing without bound.
 */
export const MAX_PENDING_ROUTED_EVENTS = 1000

/**
 * The slice of BrowserSession the multiplexed event router needs. Narrowed so
 * the routing-window behavior can be unit-tested without a live Chrome child.
 */
export type RoutableSession = Pick<
  BrowserSession,
  | 'pages'
  | 'pagesBySessionId'
  | 'activeTargetId'
  | 'logs'
  | 'networks'
  | 'networkRequests'
  | 'logOffset'
  | 'networkOffset'
  | 'recording'
  | 'pendingEvents'
  | 'pendingEventCount'
>

export function routeEvent(session: RoutableSession, message: CdpPipeMessage) {
  if (!message.method) return
  // One pipe connection multiplexes every attached target: resolve the owning
  // page by sessionId with a single map lookup — no per-event spread array or
  // linear scan. Browser-level events (e.g.
  // Target.targetCreated) carry no sessionId and fall back to the active page,
  // never crashing the router.
  const page = message.sessionId
    ? session.pagesBySessionId.get(message.sessionId)
    : undefined
  if (page) {
    deliverEvent(session, page, message)
    return
  }
  if (message.sessionId) {
    // The page for this sessionId is not registered yet: routeEvent can run
    // between Target.attachToTarget resolving and connectPage registering the
    // page. Buffer the event (bounded) so it is delivered in order once the
    // page registers, instead of being dropped or misrouted to the previously
    // active page.
    queuePendingEvent(session, message.sessionId, message)
    return
  }
  const fallback = session.pages.get(session.activeTargetId)
  if (fallback) deliverEvent(session, fallback, message)
}

/**
 * Delivers every event buffered for a page that just registered, in arrival
 * order. Called by connectPage before domains are enabled so events that
 * landed in the attach-to-registration window are not lost.
 */
export function flushPendingEvents(
  session: RoutableSession,
  page: BrowserPage,
): void {
  const queued = session.pendingEvents.get(page.sessionId)
  if (!queued) return
  session.pendingEvents.delete(page.sessionId)
  session.pendingEventCount -= queued.length
  for (const message of queued) deliverEvent(session, page, message)
}

/**
 * Drop every event buffered for a sessionId without delivering it, keeping
 * the running pendingEventCount in sync. Called when a flatten session is
 * orphaned (e.g. enablePageDomains failed in connectPage): the sessionId will
 * never get a registered page again, so its buffered events are permanently
 * unroutable and would otherwise fill the bounded pendingEvents buffer and
 * evict useful buffered events for live sessions.
 */
export function discardPendingEvents(
  session: Pick<RoutableSession, 'pendingEvents' | 'pendingEventCount'>,
  sessionId: string,
): void {
  const queued = session.pendingEvents.get(sessionId)
  if (!queued) return
  session.pendingEvents.delete(sessionId)
  session.pendingEventCount -= queued.length
}

function queuePendingEvent(
  session: RoutableSession,
  sessionId: string,
  message: CdpPipeMessage,
): void {
  const queued = session.pendingEvents.get(sessionId) ?? []
  queued.push(message)
  session.pendingEvents.set(sessionId, queued)
  session.pendingEventCount++

  // Bound the total buffered events; drop the oldest (first-registered
  // sessionId, then FIFO within it) once the cap is exceeded. The running
  // pendingEventCount keeps this check to a counter comparison per enqueue
  // instead of rescanning every buffered sessionId on each event.
  while (session.pendingEventCount > MAX_PENDING_ROUTED_EVENTS) {
    for (const [key, entries] of session.pendingEvents) {
      entries.shift()
      if (entries.length === 0) session.pendingEvents.delete(key)
      session.pendingEventCount--
      break
    }
  }
}

function deliverEvent(
  session: RoutableSession,
  page: BrowserPage,
  message: CdpPipeMessage,
): void {
  recordEvent(session, page, message)
  // deliverEvent is only invoked for messages that carry a `method` (events);
  // response messages resolve through the transport's pending map instead.
  if (typeof message.method !== 'string') return
  const waiters = page.eventWaiters.get(message.method)
  if (waiters) {
    page.eventWaiters.delete(message.method)
    for (const resolve of waiters) resolve()
  }
}

function trimSessionBuffer(
  session: RoutableSession,
  kind: 'logs' | 'networks',
): void {
  if (kind === 'logs') {
    const overflow = session.logs.length - MAX_SESSION_LOG_ENTRIES
    if (overflow > 0) {
      session.logs.splice(0, overflow)
      session.logOffset = Math.max(0, session.logOffset - overflow)
    }
  } else {
    const overflow = session.networks.length - MAX_SESSION_NETWORK_EVENTS
    if (overflow > 0) {
      session.networks.splice(0, overflow)
      session.networkOffset = Math.max(0, session.networkOffset - overflow)
    }
  }
}

function recordEvent(
  session: RoutableSession,
  page: BrowserPage,
  message: CdpPipeMessage,
) {
  const params = message.params ?? {}
  const timestamp = Date.now()
  if (message.method === 'Runtime.executionContextCreated') {
    const context = isRecord(params.context) ? params.context : {}
    const auxData = isRecord(context.auxData) ? context.auxData : {}
    if (typeof context.id === 'number' && typeof auxData.frameId === 'string') {
      page.executionContexts.set(auxData.frameId, context.id)
    }
  }
  if (message.method === 'Runtime.executionContextDestroyed') {
    const id =
      typeof params.executionContextId === 'number'
        ? params.executionContextId
        : undefined
    if (id !== undefined) {
      for (const [frameId, contextId] of page.executionContexts) {
        if (contextId === id) page.executionContexts.delete(frameId)
      }
    }
  }
  if (message.method === 'Runtime.consoleAPICalled') {
    const args = Array.isArray(params.args) ? params.args : []
    session.logs.push({
      type: params.type === 'error' ? 'error' : 'info',
      message: args.map(formatRuntimeValue).join(' '),
      timestamp,
      source: 'browser',
    })
    trimSessionBuffer(session, 'logs')
  }
  if (message.method === 'Runtime.exceptionThrown') {
    const details = isRecord(params.exceptionDetails)
      ? params.exceptionDetails
      : {}
    session.logs.push({
      type: 'error',
      message:
        typeof details.text === 'string' ? details.text : 'Runtime exception',
      timestamp,
      source: 'browser',
    })
    trimSessionBuffer(session, 'logs')
  }
  if (message.method === 'Log.entryAdded' && isRecord(params.entry)) {
    const entry = params.entry
    session.logs.push({
      type: entry.level === 'error' ? 'error' : 'info',
      message: typeof entry.text === 'string' ? entry.text : 'Log entry',
      timestamp,
      source: 'browser',
      location: typeof entry.url === 'string' ? entry.url : undefined,
    })
    trimSessionBuffer(session, 'logs')
  }
  if (
    message.method === 'Network.requestWillBeSent' ||
    message.method === 'Network.responseReceived' ||
    message.method === 'Network.loadingFailed'
  ) {
    recordNetworkEvent(
      session.networks,
      session.networkRequests,
      message,
      timestamp,
    )
    trimSessionBuffer(session, 'networks')
  }
  if (message.method === 'Page.screencastFrame' && session.recording) {
    const data = typeof params.data === 'string' ? params.data : undefined
    if (data && session.recording.targetId === page.targetId) {
      session.recording.frames.push({ data, timestamp })
      session.recording.frameCount++
      if (session.recording.frames.length > MAX_RECORDING_FRAMES) {
        session.recording.frames.shift()
      }
    }
    if (typeof params.sessionId === 'number') {
      void waitForCommand(page, 'Page.screencastFrameAck', {
        sessionId: params.sessionId,
      }).catch(() => undefined)
    }
  }
}

/**
 * Maps Chrome DevTools Protocol network events into NetworkEvent diagnostics.
 *
 * The HTTP request method and URL are only carried by `Network.requestWillBeSent`
 * (via `request.method` / `request.url`), so we remember them keyed by
 * `requestId` and resolve the correct values when the response arrives or the
 * request fails. `Network.responseReceived` params only expose the resource
 * `type` (e.g. "Document"/"XHR"), not the HTTP method, and `Network.loadingFailed`
 * exposes neither the method nor the URL.
 */
export function recordNetworkEvent(
  networks: NetworkEvent[],
  requests: Map<string, { method: string; url: string }>,
  message: Pick<CdpPipeMessage, 'method' | 'params'>,
  timestamp: number,
): void {
  const params = message.params ?? {}
  const requestId =
    typeof params.requestId === 'string' ? params.requestId : undefined

  if (
    message.method === 'Network.requestWillBeSent' &&
    isRecord(params.request)
  ) {
    const request = params.request
    if (requestId) {
      requests.set(requestId, {
        method: typeof request.method === 'string' ? request.method : 'GET',
        url: typeof request.url === 'string' ? request.url : '',
      })
      if (requests.size > MAX_TRACKED_NETWORK_REQUESTS) {
        const oldestKey = requests.keys().next().value
        if (oldestKey !== undefined) requests.delete(oldestKey)
      }
    }
    return
  }

  if (
    message.method === 'Network.responseReceived' &&
    isRecord(params.response)
  ) {
    const response = params.response
    const tracked = requestId ? requests.get(requestId) : undefined
    networks.push({
      url: String(response.url ?? tracked?.url ?? ''),
      method: tracked?.method ?? 'GET',
      status: typeof response.status === 'number' ? response.status : undefined,
      timestamp,
    })
    if (requestId) requests.delete(requestId)
    return
  }

  if (message.method === 'Network.loadingFailed') {
    const tracked = requestId ? requests.get(requestId) : undefined
    networks.push({
      url: tracked?.url ?? '',
      method: tracked?.method ?? 'GET',
      errorText: String(params.errorText ?? 'Network request failed'),
      timestamp,
    })
    if (requestId) requests.delete(requestId)
  }
}

function waitForCommand(
  page: BrowserPage,
  method: string,
  params: Record<string, unknown> = {},
  timeoutMs = 15_000,
): Promise<unknown> {
  // The pipe transport owns id allocation, framing, and pending correlation;
  // the page's sessionId routes the command to its attached target.
  return page.transport.send(method, params, {
    sessionId: page.sessionId,
    timeoutMs,
  })
}

async function waitForLoad(
  page: BrowserPage,
  waitUntil: 'load' | 'domcontentloaded' | 'networkidle0' | undefined,
  timeoutMs: number,
) {
  const event =
    waitUntil === 'domcontentloaded'
      ? 'Page.domContentEventFired'
      : 'Page.loadEventFired'
  await waitForEvent(page, event, timeoutMs).catch(() => undefined)
  if (waitUntil === 'networkidle0') {
    await new Promise((resolve) => setTimeout(resolve, 750))
  }
}

/**
 * Exported for unit tests (like routeEvent and rollbackBrowserSpawn) so the
 * waiter-cleanup contract can be exercised without a live Chrome session.
 */
export function waitForEvent(
  page: BrowserPage,
  eventName: string,
  timeoutMs: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false
    const waiter = () => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      resolve()
    }
    const timeout = setTimeout(() => {
      if (settled) return
      settled = true
      // Remove this waiter on timeout: a waiter left behind would leak its
      // closure in page.eventWaiters until the same event name happened to
      // fire later (deliverEvent resolves and clears the whole array then),
      // keeping every timed-out wait alive for the lifetime of the page.
      const waiters = page.eventWaiters.get(eventName)
      if (waiters) {
        const index = waiters.indexOf(waiter)
        if (index !== -1) waiters.splice(index, 1)
        if (waiters.length === 0) page.eventWaiters.delete(eventName)
      }
      reject(new Error(`${eventName} timed out after ${timeoutMs}ms`))
    }, timeoutMs)
    const waiters = page.eventWaiters.get(eventName) ?? []
    waiters.push(waiter)
    page.eventWaiters.set(eventName, waiters)
  })
}

async function evaluate(
  page: BrowserPage,
  expression: string,
  timeoutMs = 15_000,
  contextId?: number,
): Promise<unknown> {
  const result = await waitForCommand(
    page,
    'Runtime.evaluate',
    {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
      contextId,
    },
    timeoutMs,
  )
  if (!isRecord(result) || !isRecord(result.result)) return result
  if (result.exceptionDetails) {
    throw new Error(JSON.stringify(result.exceptionDetails))
  }
  return result.result.value
}

async function evaluateInTarget(
  page: BrowserPage,
  expression: string,
  target: FrameTarget,
  timeoutMs = 15_000,
): Promise<unknown> {
  const contextId = await resolveExecutionContext(page, target, timeoutMs)
  return evaluate(page, expression, timeoutMs, contextId)
}

async function resolveExecutionContext(
  page: BrowserPage,
  target: FrameTarget,
  timeoutMs: number,
): Promise<number | undefined> {
  const frameId = await resolveFrameId(page, target, timeoutMs)
  if (!frameId) return undefined
  const context = page.executionContexts.get(frameId)
  if (context !== undefined) return context
  await waitForEvent(page, 'Runtime.executionContextCreated', timeoutMs).catch(
    () => undefined,
  )
  const contextAfterWait = page.executionContexts.get(frameId)
  if (contextAfterWait === undefined) {
    throw new Error(`No execution context found for frame: ${frameId}`)
  }
  return contextAfterWait
}

async function resolveFrameId(
  page: BrowserPage,
  target: FrameTarget,
  timeoutMs: number,
): Promise<string | undefined> {
  if (target.frameSelector) return undefined
  if (!target.frameId && !target.frameUrl && !target.frameName) return undefined
  const frameId =
    target.frameId ??
    (await findFrameId(page, target.frameUrl, target.frameName, timeoutMs))
  if (!frameId) throw new Error('No matching frame found')
  return frameId
}

async function findFrameId(
  page: BrowserPage,
  frameUrl: string | undefined,
  frameName: string | undefined,
  timeoutMs: number,
): Promise<string | undefined> {
  const result = await waitForCommand(page, 'Page.getFrameTree', {}, timeoutMs)
  const frames: Record<string, unknown>[] = []
  collectFrames(isRecord(result) ? result.frameTree : undefined, frames)
  const match = frames.find((frame) => {
    const urlMatches = frameUrl
      ? String(frame.url ?? '').includes(frameUrl)
      : true
    const nameMatches = frameName
      ? String(frame.name ?? '') === frameName
      : true
    return urlMatches && nameMatches
  })
  return typeof match?.id === 'string' ? match.id : undefined
}

function collectFrames(value: unknown, frames: Record<string, unknown>[]) {
  if (!isRecord(value)) return
  if (isRecord(value.frame)) frames.push(value.frame)
  if (Array.isArray(value.childFrames)) {
    for (const child of value.childFrames) collectFrames(child, frames)
  }
}

/**
 * Builds the BrowserResponse for one action and consumes the session's
 * pending log/network window. Exported for unit tests (like routeEvent and
 * rollbackBrowserSpawn) so the window-consumption contract can be exercised
 * without a live Chrome session.
 */
export async function buildResponse(
  session: BrowserSession,
  page: BrowserPage,
  action: string,
  result?: unknown,
): Promise<BrowserResponse> {
  // Capture the window cursors synchronously BEFORE the first await: the
  // slice of log/network events this response will report is fixed here, so
  // a concurrent browserLogs action on the same session cannot advance the
  // shared cursors between this capture and the slice below and empty (or
  // steal) this response's window. The advance below only ever moves a
  // cursor forward and is clamped to the current buffer length, so it can
  // never regress behind a concurrent consumer or a buffer trim.
  const startLogOffset = session.logOffset
  const startNetworkOffset = session.networkOffset
  const pageInfo = await evaluate(
    page,
    '({ url: location.href, title: document.title })',
  ).catch(() => ({}))
  const nextLogOffset = session.logs.length
  const nextNetworkOffset = session.networks.length
  // A concurrent trimSessionBuffer during the await above splices overflow
  // entries off the front of the buffers and pulls the shared cursor down by
  // exactly the number of spliced entries, so the CURRENT cursor is the
  // trim-corrected image of the captured one whenever it is lower — slicing
  // from the stale captured offset would silently skip the unconsumed events
  // the trim shifted toward the front. min() adopts that corrected start
  // without ever letting a concurrent consumer's forward cursor advance
  // (which can only raise the cursor) move this response's start past its
  // own captured window.
  const effectiveLogStart = Math.min(startLogOffset, session.logOffset)
  const effectiveNetworkStart = Math.min(
    startNetworkOffset,
    session.networkOffset,
  )
  const newLogs = session.logs.slice(effectiveLogStart, nextLogOffset)
  const newNetworks = session.networks.slice(
    effectiveNetworkStart,
    nextNetworkOffset,
  )
  session.logOffset = Math.min(
    Math.max(session.logOffset, nextLogOffset),
    session.logs.length,
  )
  session.networkOffset = Math.min(
    Math.max(session.networkOffset, nextNetworkOffset),
    session.networks.length,
  )

  const response: BrowserResponse = {
    success: true,
    action,
    url: isRecord(pageInfo) ? String(pageInfo.url ?? '') : undefined,
    title: isRecord(pageInfo) ? String(pageInfo.title ?? '') : undefined,
    logs: newLogs,
    networkEvents: newNetworks,
  }
  if (result !== undefined) {
    response.result = toJsonValue(result)
  }
  return response
}

async function waitForPageTarget(
  transport: CdpPipeTransport,
): Promise<string> {
  const started = Date.now()
  let lastError: unknown
  while (Date.now() - started < 10_000) {
    try {
      const targetId = (await listTargets(transport)).find(
        (candidate) => candidate.type === 'page',
      )?.targetId
      if (targetId) return targetId
    } catch (error) {
      lastError = error
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(
    `Chrome DevTools did not become ready: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
  )
}

type BrowserTarget = {
  targetId: string
  type?: string
  url?: string
  title?: string
}

/**
 * Target discovery over the CDP pipe. `Target.getTargets` replaces the old
 * unauthenticated `http://127.0.0.1:<port>/json/list` HTTP endpoint; note that
 * the CDP shape uses `targetId` (not `id`) and carries no
 * `webSocketDebuggerUrl`, since attach happens over the same pipe.
 */
async function listTargets(
  transport: CdpPipeTransport,
): Promise<BrowserTarget[]> {
  const result = await transport.send('Target.getTargets')
  const rawInfos =
    isRecord(result) && Array.isArray(result.targetInfos)
      ? result.targetInfos
      : []
  const targets: BrowserTarget[] = []
  for (const info of rawInfos) {
    if (!isRecord(info)) continue
    if (typeof info.targetId !== 'string') continue
    targets.push({
      targetId: info.targetId,
      type: typeof info.type === 'string' ? info.type : undefined,
      url: typeof info.url === 'string' ? info.url : undefined,
      title: typeof info.title === 'string' ? info.title : undefined,
    })
  }
  return targets
}

function findChromeExecutable(): string {
  const env = getSdkEnv()
  const candidates = [
    env.CHROME_PATH,
    env.CHROMIUM_PATH,
    '/usr/bin/google-chrome-stable',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
  ].filter(Boolean) as string[]

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  throw new Error(
    'Chrome or Chromium was not found. Set CHROME_PATH to the browser executable.',
  )
}

export function normalizeBrowserUrl(url: string): string {
  const trimmed = url.trim()
  if (
    /^(localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0|\[::1\])(?::\d+)?(?:[/?#]|$)/i.test(
      trimmed,
    )
  ) {
    return `http://${trimmed}`
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return trimmed
  return `https://${trimmed}`
}

async function captureScreenshot(
  page: BrowserPage,
  params: {
    format: 'jpeg' | 'png'
    quality: number | undefined
    fullPage: boolean
    timeout: number | undefined
  },
): Promise<string> {
  const result = await waitForCommand(
    page,
    'Page.captureScreenshot',
    {
      format: params.format,
      quality: params.format === 'png' ? undefined : params.quality,
      captureBeyondViewport: params.fullPage,
    },
    params.timeout ?? 15_000,
  )
  return isRecord(result) && typeof result.data === 'string' ? result.data : ''
}

async function clickElement(
  page: BrowserPage,
  action: Extract<BrowserAction, { type: 'click' }>,
): Promise<unknown> {
  if (action.x !== undefined || action.y !== undefined) {
    const point = await pointInTarget(
      page,
      requirePoint(action.x, action.y),
      action,
    )
    await dispatchMouse(page, 'click', point, {
      button: action.button ?? 'left',
      clickCount: action.clickCount ?? 1,
      timeout: action.timeout,
    })
    return { clicked: point }
  }
  if (!action.selector) throw new Error('click requires selector or x/y')
  const point = await elementPoint(page, action.selector, action)
  await dispatchMouse(page, 'click', point, {
    button: action.button ?? 'left',
    clickCount: action.clickCount ?? 1,
    timeout: action.timeout,
  })
  return { clicked: action.selector, ...point }
}

async function typeIntoElement(
  page: BrowserPage,
  action: Extract<BrowserAction, { type: 'type' }>,
): Promise<unknown> {
  await evaluateInTarget(
    page,
    focusScript(action.selector, action.frameSelector),
    action,
    action.timeout,
  )
  if (action.clear) {
    await dispatchKey(page, 'a', {
      command: 'press',
      modifiers: process.platform === 'darwin' ? ['Meta'] : ['Control'],
      timeout: action.timeout,
    })
    await dispatchKey(page, 'Backspace', {
      command: 'press',
      modifiers: [],
      timeout: action.timeout,
    })
  }
  if (action.inputMode === 'setValue') {
    return evaluateInTarget(
      page,
      typeScript(action.selector, action.text, action.frameSelector),
      action,
      action.timeout,
    )
  }
  await waitForCommand(
    page,
    'Input.insertText',
    { text: action.text },
    action.timeout ?? 15_000,
  )
  if (action.pressEnter) {
    await dispatchKey(page, 'Enter', {
      command: 'press',
      modifiers: [],
      timeout: action.timeout,
    })
  }
  return evaluateInTarget(
    page,
    `(() => {
      const el = ${queryExpression(action.selector, action.frameSelector)};
      return { typed: ${JSON.stringify(action.selector)}, value: 'value' in el ? el.value : el.textContent };
    })()`,
    action,
    action.timeout,
  )
}

async function dispatchKey(
  page: BrowserPage,
  key: string,
  params: {
    text?: string
    command: 'press' | 'down' | 'up'
    modifiers: Array<'Alt' | 'Control' | 'Meta' | 'Shift'>
    timeout?: number
  },
) {
  const definition = keyDefinition(key, params.text)
  const modifiers = modifierBitmask(params.modifiers)
  if (params.command === 'press' || params.command === 'down') {
    await waitForCommand(
      page,
      'Input.dispatchKeyEvent',
      {
        type: definition.text ? 'keyDown' : 'rawKeyDown',
        key: definition.key,
        code: definition.code,
        text: definition.text,
        unmodifiedText: definition.text,
        windowsVirtualKeyCode: definition.keyCode,
        nativeVirtualKeyCode: definition.keyCode,
        modifiers,
      },
      params.timeout ?? 15_000,
    )
  }
  if (params.command === 'press' || params.command === 'up') {
    await waitForCommand(
      page,
      'Input.dispatchKeyEvent',
      {
        type: 'keyUp',
        key: definition.key,
        code: definition.code,
        windowsVirtualKeyCode: definition.keyCode,
        nativeVirtualKeyCode: definition.keyCode,
        modifiers,
      },
      params.timeout ?? 15_000,
    )
  }
}

async function dispatchMouse(
  page: BrowserPage,
  event: 'move' | 'down' | 'up' | 'click',
  point: { x: number; y: number },
  params: {
    button: 'left' | 'right' | 'middle'
    clickCount: number
    timeout?: number
  },
) {
  const timeout = params.timeout ?? 15_000
  if (event === 'move' || event === 'click') {
    await waitForCommand(
      page,
      'Input.dispatchMouseEvent',
      {
        type: 'mouseMoved',
        x: point.x,
        y: point.y,
        button: 'none',
        clickCount: 0,
      },
      timeout,
    )
  }
  if (event === 'down' || event === 'click') {
    await waitForCommand(
      page,
      'Input.dispatchMouseEvent',
      {
        type: 'mousePressed',
        x: point.x,
        y: point.y,
        button: params.button,
        clickCount: params.clickCount,
      },
      timeout,
    )
  }
  if (event === 'up' || event === 'click') {
    await waitForCommand(
      page,
      'Input.dispatchMouseEvent',
      {
        type: 'mouseReleased',
        x: point.x,
        y: point.y,
        button: params.button,
        clickCount: params.clickCount,
      },
      timeout,
    )
  }
}

async function drag(
  page: BrowserPage,
  action: Extract<BrowserAction, { type: 'drag' }>,
): Promise<unknown> {
  const start = action.fromSelector
    ? await elementPoint(page, action.fromSelector, action)
    : await pointInTarget(
        page,
        requirePoint(action.fromX, action.fromY),
        action,
      )
  const end = action.toSelector
    ? await elementPoint(page, action.toSelector, action)
    : await pointInTarget(page, requirePoint(action.toX, action.toY), action)
  const steps = action.steps ?? 12
  await dispatchMouse(page, 'move', start, {
    button: 'left',
    clickCount: 0,
    timeout: action.timeout,
  })
  await dispatchMouse(page, 'down', start, {
    button: 'left',
    clickCount: 1,
    timeout: action.timeout,
  })
  for (let i = 1; i <= steps; i++) {
    const point = {
      x: start.x + ((end.x - start.x) * i) / steps,
      y: start.y + ((end.y - start.y) * i) / steps,
    }
    await dispatchMouse(page, 'move', point, {
      button: 'left',
      clickCount: 0,
      timeout: action.timeout,
    })
  }
  await dispatchMouse(page, 'up', end, {
    button: 'left',
    clickCount: 1,
    timeout: action.timeout,
  })
  return { from: start, to: end, steps }
}

async function elementPoint(
  page: BrowserPage,
  selector: string,
  target: FrameTarget & { timeout?: number },
): Promise<ElementPoint> {
  const result = await evaluateInTarget(
    page,
    elementPointScript(selector, target.frameSelector),
    target,
    target.timeout,
  )
  if (!isRecord(result))
    throw new Error(`Could not locate element: ${selector}`)
  const frameId = await resolveFrameId(page, target, target.timeout ?? 15_000)
  const frameOffset = frameId
    ? await frameViewportOffset(page, frameId, target.timeout ?? 15_000)
    : { x: 0, y: 0 }
  const point = translateFramePoint(
    { x: Number(result.x), y: Number(result.y) },
    frameOffset,
  )
  return {
    ...point,
    text: typeof result.text === 'string' ? result.text : undefined,
    selector,
  }
}

async function pointInTarget(
  page: BrowserPage,
  point: { x: number; y: number },
  target: FrameTarget & { timeout?: number },
): Promise<{ x: number; y: number }> {
  const timeoutMs = target.timeout ?? 15_000
  if (target.frameSelector) {
    return translateFramePoint(
      point,
      await frameSelectorViewportOffset(page, target.frameSelector, timeoutMs),
    )
  }

  const frameId = await resolveFrameId(page, target, timeoutMs)
  if (!frameId) return point
  return translateFramePoint(
    point,
    await frameViewportOffset(page, frameId, timeoutMs),
  )
}

async function frameSelectorViewportOffset(
  page: BrowserPage,
  frameSelector: string,
  timeoutMs: number,
): Promise<{ x: number; y: number }> {
  const result = await evaluate(
    page,
    frameSelectorOffsetScript(frameSelector),
    timeoutMs,
  )
  if (
    !isRecord(result) ||
    typeof result.x !== 'number' ||
    typeof result.y !== 'number'
  ) {
    throw new Error('Could not resolve frame viewport offset')
  }
  return { x: result.x, y: result.y }
}

async function frameViewportOffset(
  page: BrowserPage,
  frameId: string,
  timeoutMs: number,
): Promise<{ x: number; y: number }> {
  const owner = await waitForCommand(
    page,
    'DOM.getFrameOwner',
    { frameId },
    timeoutMs,
  )
  const backendNodeId =
    isRecord(owner) && typeof owner.backendNodeId === 'number'
      ? owner.backendNodeId
      : undefined
  if (backendNodeId === undefined)
    throw new Error('Could not resolve frame owner')
  const model = await waitForCommand(
    page,
    'DOM.getBoxModel',
    { backendNodeId },
    timeoutMs,
  )
  const content =
    isRecord(model) &&
    isRecord(model.model) &&
    Array.isArray(model.model.content)
      ? model.model.content
      : undefined
  if (
    !content ||
    typeof content[0] !== 'number' ||
    typeof content[1] !== 'number'
  ) {
    throw new Error('Could not resolve frame viewport offset')
  }
  return { x: content[0], y: content[1] }
}

export function translateFramePoint(
  point: { x: number; y: number },
  offset: { x: number; y: number },
): { x: number; y: number } {
  return { x: offset.x + point.x, y: offset.y + point.y }
}

function requirePoint(
  x: number | undefined,
  y: number | undefined,
): { x: number; y: number } {
  if (x === undefined || y === undefined)
    throw new Error('x and y are required')
  return { x, y }
}

async function uploadFiles(
  page: BrowserPage,
  selector: string,
  paths: string[],
  target: FrameTarget & { timeout?: number },
  projectRoot: string | undefined,
): Promise<unknown> {
  if (
    target.frameSelector ||
    target.frameId ||
    target.frameUrl ||
    target.frameName
  ) {
    throw new Error('upload currently supports top-level file inputs only')
  }
  const documentResult = await waitForCommand(
    page,
    'DOM.getDocument',
    { depth: -1, pierce: true },
    target.timeout ?? 15_000,
  )
  const root =
    isRecord(documentResult) && isRecord(documentResult.root)
      ? documentResult.root
      : null
  const nodeId = typeof root?.nodeId === 'number' ? root.nodeId : undefined
  if (nodeId === undefined) throw new Error('Could not resolve DOM document')
  const nodeResult = await waitForCommand(
    page,
    'DOM.querySelector',
    { nodeId, selector },
    target.timeout ?? 15_000,
  )
  const inputNodeId =
    isRecord(nodeResult) && typeof nodeResult.nodeId === 'number'
      ? nodeResult.nodeId
      : 0
  if (!inputNodeId) throw new Error(`No element matches selector: ${selector}`)
  await waitForCommand(
    page,
    'DOM.setFileInputFiles',
    {
      nodeId: inputNodeId,
      files: paths.map((filePath) => {
        if (projectRoot === undefined) {
          throw new Error(
            'upload requires a project root to confine file paths',
          )
        }
        const resolved = resolveFilePathForOperation(projectRoot, filePath)
        if (resolved === null) {
          throw new Error('upload path escapes project root: ' + filePath)
        }
        return resolved.operationPath
      }),
    },
    target.timeout ?? 15_000,
  )
  return { uploaded: paths.length, selector }
}

async function handleCookieAction(
  page: BrowserPage,
  action: Extract<BrowserAction, { type: 'cookie' }>,
): Promise<unknown> {
  if (action.operation === 'get') {
    return waitForCommand(
      page,
      'Network.getCookies',
      { urls: action.url ? [action.url] : undefined },
      action.timeout ?? 15_000,
    )
  }
  if (action.operation === 'set') {
    if (!action.name || action.value === undefined) {
      throw new Error('cookie set requires name and value')
    }
    return waitForCommand(
      page,
      'Network.setCookie',
      {
        name: action.name,
        value: action.value,
        url: action.url,
        domain: action.domain,
        path: action.path,
        expires: action.expires,
        httpOnly: action.httpOnly,
        secure: action.secure,
        sameSite: action.sameSite,
      },
      action.timeout ?? 15_000,
    )
  }
  if (action.operation === 'delete') {
    if (!action.name) throw new Error('cookie delete requires name')
    return waitForCommand(
      page,
      'Network.deleteCookies',
      {
        name: action.name,
        url: action.url,
        domain: action.domain,
        path: action.path,
      },
      action.timeout ?? 15_000,
    )
  }
  return waitForCommand(
    page,
    'Network.clearBrowserCookies',
    {},
    action.timeout ?? 15_000,
  )
}

async function handleTabAction(
  session: BrowserSession,
  action: Extract<BrowserAction, { type: 'tab' }>,
): Promise<unknown> {
  if (action.operation === 'list') {
    return { tabs: await tabsResult(session) }
  }
  if (action.operation === 'create') {
    const created = await session.transport.send('Target.createTarget', {
      url: normalizeBrowserUrl(action.url ?? 'about:blank'),
    })
    const createdId =
      isRecord(created) && typeof created.targetId === 'string'
        ? created.targetId
        : undefined
    if (!createdId) {
      throw new Error('Chrome did not return a new tab target')
    }
    const page = await connectPage(session, createdId)
    session.pages.set(createdId, page)
    session.pagesBySessionId.set(page.sessionId, page)
    session.activeTargetId = createdId
    return { targetId: createdId, tabs: await tabsResult(session) }
  }
  const targetId = await resolveTabId(session, action)
  if (!targetId) throw new Error('No matching tab found')
  if (action.operation === 'switch') {
    const page = await connectPage(session, targetId)
    session.pages.set(targetId, page)
    session.pagesBySessionId.set(page.sessionId, page)
    session.activeTargetId = targetId
    await session.transport
      .send('Target.activateTarget', { targetId })
      .catch(() => undefined)
    return { targetId, tabs: await tabsResult(session) }
  }
  if (action.operation === 'close') {
    if (session.pages.size <= 1)
      throw new Error('Cannot close the last browser tab')
    await session.transport
      .send('Target.closeTarget', { targetId })
      .catch(() => undefined)
    const removed = session.pages.get(targetId)
    session.pages.delete(targetId)
    if (removed) session.pagesBySessionId.delete(removed.sessionId)
    if (session.activeTargetId === targetId) {
      const nextTarget = (await listTargets(session.transport)).find(
        (item) => item.type === 'page',
      )
      if (!nextTarget) throw new Error('No browser tabs remain')
      session.activeTargetId = nextTarget.targetId
    }
    return { closed: targetId, tabs: await tabsResult(session) }
  }
  return { tabs: await tabsResult(session) }
}

async function tabsResult(session: BrowserSession) {
  return (await listTargets(session.transport))
    .filter((target) => target.type === 'page')
    .map((target) => ({
      targetId: target.targetId,
      url: target.url,
      title: target.title,
      active: target.targetId === session.activeTargetId,
    }))
}

async function resolveTabId(
  session: BrowserSession,
  action: Extract<BrowserAction, { type: 'tab' }>,
): Promise<string | undefined> {
  if (action.targetId) return action.targetId
  const tabs = await listTargets(session.transport)
  return tabs.find((target) => {
    const titleMatches = action.titleIncludes
      ? (target.title ?? '').includes(action.titleIncludes)
      : true
    const urlMatches = action.urlIncludes
      ? (target.url ?? '').includes(action.urlIncludes)
      : true
    return target.type === 'page' && titleMatches && urlMatches
  })?.targetId
}

/**
 * Exported for unit tests (like routeEvent and rollbackBrowserSpawn) so the
 * recording state-machine contract can be exercised without a live Chrome
 * session.
 */
export async function handleRecordingAction(
  session: BrowserSession,
  page: BrowserPage,
  action: Extract<BrowserAction, { type: 'recording' }>,
): Promise<CodebuffToolOutput<'browser_logs'>> {
  if (action.operation === 'start') {
    if (session.recording)
      throw new Error('A browser recording is already active')
    session.recording = {
      targetId: page.targetId,
      startedAt: Date.now(),
      frameCount: 0,
      frames: [],
    }
    try {
      await waitForCommand(
        page,
        'Page.startScreencast',
        {
          format: 'png',
          everyNthFrame: action.everyNthFrame ?? 1,
          quality: action.quality ?? 80,
        },
        action.timeout ?? 15_000,
      )
    } catch (error) {
      // Page.startScreencast never started: roll the recording state back so
      // a future 'start' is not permanently blocked by a phantom active
      // recording that only a compensating 'stop' could clear.
      session.recording = null
      throw error
    }
    return [
      jsonResult(
        await buildResponse(session, page, action.type, {
          recording: 'started',
        }),
      ),
    ]
  }

  const recording = session.recording
  if (!recording) throw new Error('No browser recording is active')
  session.recording = null
  await waitForCommand(
    page,
    'Page.stopScreencast',
    {},
    action.timeout ?? 15_000,
  ).catch(() => undefined)
  const apng = buildApng(
    recording.frames.map((frame) => ({
      buffer: Buffer.from(frame.data, 'base64'),
      timestamp: frame.timestamp,
    })),
  )
  return [
    jsonResult({
      ...(await buildResponse(session, page, action.type, {
        recording: 'stopped',
        frameCount: recording.frameCount,
        durationMs: Date.now() - recording.startedAt,
      })),
      recordingAttached: apng.length > 0,
    }),
    ...(apng.length > 0
      ? [
          {
            type: 'media' as const,
            data: apng.toString('base64'),
            mediaType: 'image/apng',
          },
        ]
      : []),
  ]
}

async function pixelDiff(
  session: BrowserSession,
  page: BrowserPage,
  action: Extract<BrowserAction, { type: 'pixel_diff' }>,
): Promise<CodebuffToolOutput<'browser_logs'>> {
  const actualBase64 = await captureScreenshot(page, {
    format: 'png',
    quality: undefined,
    fullPage: action.fullPage ?? false,
    timeout: action.timeout,
  })
  let expectedBuffer: Buffer | undefined
  if (action.expectedImageBase64) {
    expectedBuffer = Buffer.from(action.expectedImageBase64, 'base64')
  } else if (action.expectedImagePath) {
    const projectRoot = session.projectRoot
    if (projectRoot === undefined) {
      throw new Error(
        'pixel_diff expectedImagePath requires a project root to confine file paths',
      )
    } else {
      const resolved = resolveFilePathForOperation(
        projectRoot,
        action.expectedImagePath,
      )
      if (resolved === null) {
        throw new Error(
          'pixel_diff expectedImagePath escapes project root: ' +
            action.expectedImagePath,
        )
      }
      expectedBuffer = readFileSync(resolved.operationPath)
    }
  }
  if (!expectedBuffer) {
    throw new Error(
      'pixel_diff requires expectedImagePath or expectedImageBase64',
    )
  }
  const actual = PNG.sync.read(Buffer.from(actualBase64, 'base64'))
  const expected = PNG.sync.read(expectedBuffer)
  const width = Math.min(actual.width, expected.width)
  const height = Math.min(actual.height, expected.height)
  const diff = new PNG({ width, height })
  const mismatchedPixels = pixelmatch(
    cropPngData(actual, width, height),
    cropPngData(expected, width, height),
    diff.data,
    width,
    height,
    { threshold: action.threshold ?? 0.1 },
  )
  const totalPixels = width * height
  const mismatchRatio = totalPixels === 0 ? 0 : mismatchedPixels / totalPixels
  const diffBase64 = PNG.sync.write(diff).toString('base64')
  return [
    jsonResult({
      ...(await buildResponse(session, page, action.type, {
        width,
        height,
        actualWidth: actual.width,
        actualHeight: actual.height,
        expectedWidth: expected.width,
        expectedHeight: expected.height,
        mismatchedPixels,
        totalPixels,
        mismatchRatio,
      })),
      diffAttached: true,
    }),
    { type: 'media' as const, data: diffBase64, mediaType: 'image/png' },
  ]
}

function cropPngData(png: PNG, width: number, height: number): Uint8Array {
  if (png.width === width && png.height === height) return png.data
  const data = Buffer.alloc(width * height * 4)
  for (let y = 0; y < height; y++) {
    const sourceStart = y * png.width * 4
    const targetStart = y * width * 4
    png.data.copy(data, targetStart, sourceStart, sourceStart + width * 4)
  }
  return data
}

function snapshotScript(): string {
  return `(() => {
    function selectorFor(el) {
      if (el.id) return '#' + CSS.escape(el.id);
      const testId = el.getAttribute('data-testid');
      if (testId) return '[data-testid="' + CSS.escape(testId) + '"]';
      const aria = el.getAttribute('aria-label');
      if (aria) return el.tagName.toLowerCase() + '[aria-label="' + CSS.escape(aria) + '"]';
      const name = el.getAttribute('name');
      if (name) return el.tagName.toLowerCase() + '[name="' + CSS.escape(name) + '"]';
      const parts = [];
      let node = el;
      while (node && node.nodeType === Node.ELEMENT_NODE && parts.length < 4) {
        let part = node.tagName.toLowerCase();
        const parent = node.parentElement;
        if (parent) {
          const siblings = Array.from(parent.children).filter((child) => child.tagName === node.tagName);
          if (siblings.length > 1) part += ':nth-of-type(' + (siblings.indexOf(node) + 1) + ')';
        }
        parts.unshift(part);
        node = parent;
      }
      return parts.join(' > ');
    }
    const elements = Array.from(document.querySelectorAll('a,button,input,textarea,select,[role],h1,h2,h3,p,li,label')).slice(0, 200).map((el, index) => ({
      index,
      tag: el.tagName.toLowerCase(),
      selector: selectorFor(el),
      text: (el.innerText || el.textContent || '').trim().slice(0, 300) || undefined,
      role: el.getAttribute('role') || undefined,
      label: el.getAttribute('aria-label') || el.getAttribute('alt') || undefined,
      placeholder: el.getAttribute('placeholder') || undefined,
    }));
    return {
      url: location.href,
      title: document.title,
      text: document.body.innerText.slice(0, 12000),
      elements,
    };
  })()`
}

export function frameSelectorOffsetScript(frameSelector: string): string {
  return `(() => {
    const frame = document.querySelector(${JSON.stringify(frameSelector)});
    if (!frame) throw new Error('No frame matches selector: ${escapeForJs(frameSelector)}');
    const rect = frame.getBoundingClientRect();
    return { x: rect.left, y: rect.top };
  })()`
}

function designTokensScript(
  selector: string | undefined,
  maxElements: number | undefined,
): string {
  const cap = maxElements ?? 400
  return `(() => {
    const root = ${selector ? `document.querySelector(${JSON.stringify(selector)})` : 'document.body'};
    if (!root) throw new Error('No element matches selector: ${selector ? escapeForJs(selector) : 'document.body'}');
    const elements = Array.from(root.querySelectorAll('*')).slice(0, ${cap});
    const colors = new Set();
    const fontFamilies = new Set();
    const fontSizes = new Set();
    const fontWeights = new Set();
    const lineHeights = new Set();
    const spacing = new Set();
    const addColor = (value) => {
      if (!value) return;
      if (value === 'transparent' || value === 'rgba(0, 0, 0, 0)') return;
      colors.add(value);
    };
    const addSpacing = (value) => {
      if (!value || value === '0px') return;
      spacing.add(value);
    };
    let sampledElements = 0;
    for (const el of elements) {
      const style = window.getComputedStyle(el);
      if (!style) continue;
      sampledElements++;
      addColor(style.color);
      addColor(style.backgroundColor);
      addColor(style.borderColor);
      if (style.fontFamily) fontFamilies.add(style.fontFamily);
      if (style.fontSize) fontSizes.add(style.fontSize);
      if (style.fontWeight) fontWeights.add(style.fontWeight);
      if (style.lineHeight) lineHeights.add(style.lineHeight);
      addSpacing(style.marginTop);
      addSpacing(style.marginRight);
      addSpacing(style.marginBottom);
      addSpacing(style.marginLeft);
      addSpacing(style.paddingTop);
      addSpacing(style.paddingRight);
      addSpacing(style.paddingBottom);
      addSpacing(style.paddingLeft);
    }
    const cap = (set) => Array.from(set).sort().slice(0, 60);
    return {
      colors: cap(colors),
      fontFamilies: cap(fontFamilies),
      fontSizes: cap(fontSizes),
      fontWeights: cap(fontWeights),
      lineHeights: cap(lineHeights),
      spacing: cap(spacing),
      sampledElements,
    };
  })()`
}

function elementPointScript(
  selector: string,
  frameSelector: string | undefined,
): string {
  return `(() => {
    const frame = ${frameSelector ? `document.querySelector(${JSON.stringify(frameSelector)})` : 'null'};
    const doc = frame ? frame.contentDocument : document;
    if (!doc) throw new Error('Cannot access frame document');
    const el = doc.querySelector(${JSON.stringify(selector)});
    if (!el) throw new Error('No element matches selector: ${escapeForJs(selector)}');
    el.scrollIntoView({ block: 'center', inline: 'center' });
    const rect = el.getBoundingClientRect();
    const frameRect = frame ? frame.getBoundingClientRect() : { left: 0, top: 0 };
    return {
      x: frameRect.left + rect.left + rect.width / 2,
      y: frameRect.top + rect.top + rect.height / 2,
      text: (el.innerText || el.textContent || '').trim(),
    };
  })()`
}

function focusScript(
  selector: string,
  frameSelector: string | undefined,
): string {
  return `(() => {
    const el = ${queryExpression(selector, frameSelector)};
    el.scrollIntoView({ block: 'center', inline: 'center' });
    el.focus();
    return true;
  })()`
}

function typeScript(
  selector: string,
  text: string,
  frameSelector: string | undefined,
): string {
  return `(() => {
    const el = ${queryExpression(selector, frameSelector)};
    el.scrollIntoView({ block: 'center', inline: 'center' });
    el.focus();
    el.value = ${JSON.stringify(text)};
    el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: ${JSON.stringify(text)} }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { typed: ${JSON.stringify(selector)}, value: el.value };
  })()`
}

function selectScript(
  selector: string,
  params: {
    value: string | undefined
    label: string | undefined
    index: number | undefined
    frameSelector: string | undefined
  },
): string {
  return `(() => {
    const el = ${queryExpression(selector, params.frameSelector)};
    if (!(el instanceof HTMLSelectElement)) throw new Error('Element is not a <select>: ${escapeForJs(selector)}');
    const options = Array.from(el.options);
    const option = ${params.value !== undefined ? `options.find((item) => item.value === ${JSON.stringify(params.value)})` : params.label !== undefined ? `options.find((item) => item.label === ${JSON.stringify(params.label)} || item.text === ${JSON.stringify(params.label)})` : params.index !== undefined ? `options[${params.index}]` : 'undefined'};
    if (!option) throw new Error('No matching option found');
    el.value = option.value;
    option.selected = true;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { selected: option.value, label: option.label || option.text };
  })()`
}

function scrollScript(params: {
  selector: string | undefined
  frameSelector: string | undefined
  axis: 'top' | 'left'
  delta: number
}): string {
  return `(() => {
    const target = ${params.selector ? queryExpression(params.selector, params.frameSelector) : params.frameSelector ? `document.querySelector(${JSON.stringify(params.frameSelector)}).contentWindow` : 'window'};
    if (!target) throw new Error('Scroll target not found');
    if (target.scrollBy) target.scrollBy({ ${params.axis}: ${params.delta}, behavior: 'instant' });
    else target.scroll${params.axis === 'top' ? 'Top' : 'Left'} += ${params.delta};
    return { scrollY: window.scrollY, scrollX: window.scrollX, targetScrollTop: target.scrollTop, targetScrollLeft: target.scrollLeft };
  })()`
}

function waitForScript(params: {
  selector: string | undefined
  text: string | undefined
  visible: boolean
  pollInterval: number
  timeout: number
  frameSelector: string | undefined
}): string {
  return `new Promise((resolve, reject) => {
    const started = Date.now();
    const getDoc = () => {
      const frame = ${params.frameSelector ? `document.querySelector(${JSON.stringify(params.frameSelector)})` : 'null'};
      return frame ? frame.contentDocument : document;
    };
    const check = () => {
      const doc = getDoc();
      if (!doc) return false;
      const selectorMatch = ${params.selector ? `(() => { const el = doc.querySelector(${JSON.stringify(params.selector)}); if (!el) return false; if (${params.visible}) { const rect = el.getBoundingClientRect(); return rect.width > 0 && rect.height > 0; } return true; })()` : 'true'};
      const textMatch = ${params.text ? `doc.body && doc.body.innerText.includes(${JSON.stringify(params.text)})` : 'true'};
      return selectorMatch && textMatch;
    };
    const tick = () => {
      if (check()) return resolve({ found: true, selector: ${JSON.stringify(params.selector)}, text: ${JSON.stringify(params.text)} });
      if (Date.now() - started >= ${params.timeout}) return reject(new Error('wait_for timed out after ${params.timeout}ms'));
      setTimeout(tick, ${params.pollInterval});
    };
    tick();
  })`
}

function storageScript(
  storage: 'local' | 'session',
  operation: 'get' | 'set' | 'remove' | 'clear',
  key: string | undefined,
  value: string | undefined,
): string {
  const storageName = storage === 'local' ? 'localStorage' : 'sessionStorage'
  return `(() => {
    const store = window.${storageName};
    if (${JSON.stringify(operation)} === 'get') {
      if (${JSON.stringify(key)} === undefined) return Object.fromEntries(Array.from({ length: store.length }, (_, i) => { const k = store.key(i); return [k, k ? store.getItem(k) : null]; }));
      return { key: ${JSON.stringify(key)}, value: store.getItem(${JSON.stringify(key ?? '')}) };
    }
    if (${JSON.stringify(operation)} === 'set') {
      store.setItem(${JSON.stringify(key ?? '')}, ${JSON.stringify(value ?? '')});
      return { key: ${JSON.stringify(key)}, value: ${JSON.stringify(value)} };
    }
    if (${JSON.stringify(operation)} === 'remove') {
      store.removeItem(${JSON.stringify(key ?? '')});
      return { removed: ${JSON.stringify(key)} };
    }
    store.clear();
    return { cleared: ${JSON.stringify(storage)} };
  })()`
}

function queryExpression(
  selector: string,
  frameSelector: string | undefined,
): string {
  return `(() => {
    const frame = ${frameSelector ? `document.querySelector(${JSON.stringify(frameSelector)})` : 'null'};
    const doc = frame ? frame.contentDocument : document;
    if (!doc) throw new Error('Cannot access frame document');
    const el = doc.querySelector(${JSON.stringify(selector)});
    if (!el) throw new Error('No element matches selector: ${escapeForJs(selector)}');
    return el;
  })()`
}

function keyDefinition(key: string, text: string | undefined) {
  const named: Record<string, { key: string; code: string; keyCode: number }> =
    {
      Enter: { key: 'Enter', code: 'Enter', keyCode: 13 },
      Tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
      Escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
      Backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
      Delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
      ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
      ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
      ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
      ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
    }
  const match = named[key]
  if (match) return { ...match, text: text ?? '' }
  const char = text ?? (key.length === 1 ? key : '')
  const code = key.length === 1 ? `Key${key.toUpperCase()}` : key
  return {
    key,
    code,
    keyCode: key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0,
    text: char,
  }
}

function modifierBitmask(
  modifiers: Array<'Alt' | 'Control' | 'Meta' | 'Shift'>,
): number {
  let bitmask = 0
  if (modifiers.includes('Alt')) bitmask |= 1
  if (modifiers.includes('Control')) bitmask |= 2
  if (modifiers.includes('Meta')) bitmask |= 4
  if (modifiers.includes('Shift')) bitmask |= 8
  return bitmask
}

function escapeForJs(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
}

function toJsonValue(value: unknown, seen = new WeakSet<object>()): JSONValue {
  if (value === null) return null
  if (typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'bigint') return value.toString()
  if (
    value === undefined ||
    typeof value === 'function' ||
    typeof value === 'symbol'
  ) {
    return null
  }
  if (typeof value !== 'object') return String(value)
  if (seen.has(value)) return '[Circular]'
  seen.add(value)

  if (Array.isArray(value)) {
    const result = value.map((item) => toJsonValue(item, seen))
    seen.delete(value)
    return result
  }

  const result: Record<string, JSONValue> = {}
  for (const [key, child] of Object.entries(value)) {
    if (
      child === undefined ||
      typeof child === 'function' ||
      typeof child === 'symbol'
    ) {
      continue
    }
    result[key] = toJsonValue(child, seen)
  }
  seen.delete(value)
  return result
}

function formatRuntimeValue(value: unknown): string {
  if (!isRecord(value)) return String(value)
  if ('value' in value) return String(value.value)
  if (typeof value.description === 'string') return value.description
  return JSON.stringify(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

const DEFAULT_FRAME_DELAY_MS = 100

function frameDelayMs(
  frames: Array<{ timestamp: number }>,
  index: number,
): number {
  // Non-final frame: delay is the gap until the next captured frame.
  if (index < frames.length - 1) {
    const delta = frames[index + 1].timestamp - frames[index].timestamp
    if (Number.isFinite(delta) && delta > 0) return Math.min(delta, 65535)
    return DEFAULT_FRAME_DELAY_MS
  }
  // Final frame has no successor: reuse the previous inter-frame delay.
  if (index > 0) {
    const delta = frames[index].timestamp - frames[index - 1].timestamp
    if (Number.isFinite(delta) && delta > 0) return Math.min(delta, 65535)
  }
  return DEFAULT_FRAME_DELAY_MS
}

// Exported for unit tests (like routeEvent and rollbackBrowserSpawn).
export function buildApng(
  frames: Array<{ buffer: Buffer; timestamp: number }>,
): Buffer {
  if (frames.length === 0) return Buffer.alloc(0)
  const parsed = frames.map((frame) => parsePngChunks(frame.buffer))
  const first = parsed[0]
  const ihdr = first.find((chunk) => chunk.type === 'IHDR')
  const iend = first.find((chunk) => chunk.type === 'IEND')
  if (!ihdr || !iend) return frames[0].buffer
  const width = ihdr.data.readUInt32BE(0)
  const height = ihdr.data.readUInt32BE(4)
  // The global canvas is frame 0's size, so every emitted fcTL must carry
  // dimensions that match the image data following it. When the viewport
  // resized between captures, a frame's own IHDR disagrees with frame 0's,
  // and reusing frame 0's dimensions for its fcTL produces corrupt APNG that
  // decoders reject or misrender. Skip such frames (and frames without an
  // IHDR, whose dimensions cannot be checked) instead of emitting them:
  // dropped frames must not consume fcTL sequence numbers, and acTL counts
  // only kept frames. When every frame matches, the output is unchanged.
  const keptFrames: Array<{ frame: PngChunk[]; index: number }> = []
  parsed.forEach((frame, index) => {
    if (index === 0) {
      keptFrames.push({ frame, index })
      return
    }
    const frameIhdr = frame.find((chunk) => chunk.type === 'IHDR')
    if (
      !frameIhdr ||
      frameIhdr.data.readUInt32BE(0) !== width ||
      frameIhdr.data.readUInt32BE(4) !== height
    ) {
      return
    }
    keptFrames.push({ frame, index })
  })
  // Each kept frame's fcTL delay must cover the wall-clock span up to the
  // next KEPT frame: dropped frames (dimension mismatches) occupy real time,
  // and computing the delay from the gap to the next ORIGINAL frame would
  // lose that span and make the animation play compressed at resize
  // boundaries.
  const keptFrameTimings = keptFrames.map(({ index }) => ({
    timestamp: frames[index]!.timestamp,
  }))
  const chunks: Buffer[] = [
    PNG_SIGNATURE,
    writePngChunk('IHDR', ihdr.data),
    writePngChunk('acTL', uint32Pair(keptFrames.length, 0)),
  ]
  let sequence = 0
  keptFrames.forEach(({ frame, index }, keptIndex) => {
    // Kept frames' own IHDR dimensions equal the global IHDR dimensions by
    // the filter above, so each fcTL carries that frame's own dimensions.
    // Delay is computed over the kept-frame timeline so dropped frames' time
    // span is preserved rather than collapsed.
    chunks.push(
      writePngChunk(
        'fcTL',
        frameControlData({
          sequenceNumber: sequence++,
          width,
          height,
          delayNum: frameDelayMs(keptFrameTimings, keptIndex),
          delayDen: 1000,
        }),
      ),
    )
    const imageDataParts = frame
      .filter((chunk) => chunk.type === 'IDAT')
      .map((chunk) => chunk.data)
    if (index === 0) {
      chunks.push(writePngChunk('IDAT', ...imageDataParts))
    } else {
      chunks.push(writePngChunk('fdAT', uint32(sequence++), ...imageDataParts))
    }
  })
  chunks.push(writePngChunk('IEND', Buffer.alloc(0)))
  return Buffer.concat(chunks)
}

type PngChunk = { type: string; data: Buffer }

export function parsePngChunks(buffer: Buffer): PngChunk[] {
  const chunks: PngChunk[] = []
  let offset = PNG_SIGNATURE.length
  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset)
    const type = buffer.subarray(offset + 4, offset + 8).toString('ascii')
    const data = buffer.subarray(offset + 8, offset + 8 + length)
    chunks.push({ type, data })
    offset += 12 + length
    if (type === 'IEND') break
  }
  return chunks
}

export function writePngChunk(
  type: string,
  ...dataParts: Buffer[]
): Buffer {
  const dataLength = dataParts.reduce((sum, part) => sum + part.length, 0)
  // allocUnsafe skips the zero-fill: every byte of the chunk below is
  // overwritten before the buffer is returned (length, type, payload, CRC),
  // so zeroing a potentially multi-MB frame payload first would be pure
  // overhead in the APNG assembly path.
  const output = Buffer.allocUnsafe(12 + dataLength)
  output.writeUInt32BE(dataLength, 0)
  // Pad the type to exactly 4 bytes so the type field is fully written even
  // if a caller ever passes a shorter type string.
  output.write(type.padEnd(4, '\0'), 4, 'ascii')
  let offset = 8
  for (const part of dataParts) {
    part.copy(output, offset)
    offset += part.length
  }
  // The type and payload bytes are already assembled in `output`: compute the
  // CRC over that subarray view instead of concatenating a transient copy of
  // the (potentially multi-megabyte) frame payload.
  output.writeUInt32BE(
    crc32(output.subarray(4, 8 + dataLength)),
    8 + dataLength,
  )
  return output
}

function uint32(value: number): Buffer {
  const buffer = Buffer.alloc(4)
  buffer.writeUInt32BE(value, 0)
  return buffer
}

function uint32Pair(first: number, second: number): Buffer {
  const buffer = Buffer.alloc(8)
  buffer.writeUInt32BE(first, 0)
  buffer.writeUInt32BE(second, 4)
  return buffer
}

function frameControlData(params: {
  sequenceNumber: number
  width: number
  height: number
  delayNum: number
  delayDen: number
}): Buffer {
  const buffer = Buffer.alloc(26)
  buffer.writeUInt32BE(params.sequenceNumber, 0)
  buffer.writeUInt32BE(params.width, 4)
  buffer.writeUInt32BE(params.height, 8)
  buffer.writeUInt32BE(0, 12)
  buffer.writeUInt32BE(0, 16)
  buffer.writeUInt16BE(params.delayNum, 20)
  buffer.writeUInt16BE(params.delayDen, 22)
  buffer.writeUInt8(0, 24)
  buffer.writeUInt8(0, 25)
  return buffer
}

function makeCrcTable(): number[] {
  const table: number[] = []
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    }
    table[n] = c >>> 0
  }
  return table
}

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff
  for (const byte of buffer) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}
