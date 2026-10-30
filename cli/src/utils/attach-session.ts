import { getAttachTarget, getCodebuffClient } from './codebuff-client'

import type { OpenbuffClient } from '@openbuff/sdk'

/**
 * Injectable client seam (mirrors RunHeadlessDeps in run-command.ts):
 * production callers pass nothing and the real `getCodebuffClient()` is used;
 * tests inject a hermetic fake client and never touch a real backend.
 */
export type DetachAttachDeps = {
  getClient?: () => Promise<OpenbuffClient>
}

export type DetachOutcome =
  | { status: 'detached'; sessionId: string }
  | { status: 'no-session' }
  | { status: 'unavailable' }
  | { status: 'error'; message: string }

export type AttachOutcome =
  | { status: 'attached'; sessionId: string }
  | { status: 'no-session-id' }
  | { status: 'unavailable' }
  | { status: 'error'; message: string }

/**
 * The session id returned by the last successful detach, kept in module scope
 * ONLY (no disk persistence this slice) so /attach can reattach to it.
 */
let lastDetachedSessionId: string | undefined

export function getLastDetachedSessionId(): string | undefined {
  return lastDetachedSessionId
}

export function setLastDetachedSessionId(sessionId: string | undefined): void {
  lastDetachedSessionId = sessionId
}

/**
 * Detach from the live attach-mode session: calls the backend's optional
 * `detach()` (the remote run keeps going; the backend closes the transport)
 * and persists the returned session id for a later `attachSession()`. The
 * backend is reached structurally through `client.backend` (detach/attach are
 * optional on the type), so no ACP internals are imported into the cli layer.
 *
 * Total (never rejects): every failure becomes a structured outcome, so the
 * /detach command handler stays fire-and-forget and fail-closed.
 */
export async function detachSession(
  deps?: DetachAttachDeps,
): Promise<DetachOutcome> {
  // Only meaningful in attach mode; this also keeps non-attach runs from ever
  // building a client for this command.
  if (!getAttachTarget()) {
    return { status: 'unavailable' }
  }
  try {
    const client = await (deps?.getClient ?? getCodebuffClient)()
    const backend = client.backend
    if (typeof backend.detach !== 'function') {
      return { status: 'unavailable' }
    }
    const sessionId = await backend.detach()
    if (!sessionId) {
      return { status: 'no-session' }
    }
    lastDetachedSessionId = sessionId
    return { status: 'detached', sessionId }
  } catch (error) {
    return {
      status: 'error',
      message: error instanceof Error ? error.message : String(error),
    }
  }
}

/**
 * Exit-time detach for /exit and Ctrl-C/SIGINT: same delegation as
 * detachSession (the remote run KEEPS RUNNING; only the client transport is
 * released) but framed for the shutdown path. Never rejects — every failure
 * becomes a structured outcome — and never surfaces user-visible messages:
 * it is a silent exit-time step whose promise is only awaited (bounded) by
 * the exit chains in command-registry.ts and use-exit-handler.ts.
 */
export async function detachOnExit(
  deps?: DetachAttachDeps,
): Promise<DetachOutcome> {
  try {
    return await detachSession(deps)
  } catch (error) {
    return {
      status: 'error',
      message: error instanceof Error ? error.message : String(error),
    }
  }
}

/**
 * Reattach to the last detached session by calling the backend's optional
 * `attach(sessionId)`. The NEXT `run()` auto-resumes the detached session
 * (acp-client.ts run() sees the detached session id and calls
 * connection.loadSession), so this only re-establishes the connection/session
 * binding. Total (never rejects), like detachSession.
 */
export async function attachSession(
  deps?: DetachAttachDeps,
): Promise<AttachOutcome> {
  const sessionId = lastDetachedSessionId
  if (!sessionId) {
    return { status: 'no-session-id' }
  }
  if (!getAttachTarget()) {
    return { status: 'unavailable' }
  }
  try {
    const client = await (deps?.getClient ?? getCodebuffClient)()
    const backend = client.backend
    if (typeof backend.attach !== 'function') {
      return { status: 'unavailable' }
    }
    await backend.attach(sessionId)
    return { status: 'attached', sessionId }
  } catch (error) {
    return {
      status: 'error',
      message: error instanceof Error ? error.message : String(error),
    }
  }
}
