import { describe, test, expect, mock, afterEach } from 'bun:test'

import {
  attachSession,
  detachSession,
  getLastDetachedSessionId,
  setLastDetachedSessionId,
} from '../attach-session'
import { setAttachTarget } from '../codebuff-client'

import type { OpenbuffClient } from '@openbuff/sdk'

/**
 * Minimal structural backend double. detachSession/attachSession only read
 * `client.backend`, so the client stub is cast through unknown — the real
 * OpenbuffClient's remaining surface is irrelevant here.
 */
type FakeBackend = {
  detach?: () => Promise<string | undefined>
  attach?: (sessionId: string) => Promise<void>
}

const fakeClient = (backend: FakeBackend): OpenbuffClient =>
  ({ backend }) as unknown as OpenbuffClient

describe('attach-session', () => {
  afterEach(() => {
    setAttachTarget(undefined)
    setLastDetachedSessionId(undefined)
  })

  describe('detachSession', () => {
    test('is unavailable outside attach mode without building a client', async () => {
      const getClient = mock(() => {
        throw new Error('client must not be built outside attach mode')
      })

      expect(await detachSession({ getClient })).toEqual({
        status: 'unavailable',
      })
      expect(getClient).not.toHaveBeenCalled()
    })

    test('is unavailable when the backend has no detach (in-process)', async () => {
      setAttachTarget({ socketPath: '/tmp/openbuff-test.sock' })
      const getClient = mock(async () => fakeClient({}))

      expect(await detachSession({ getClient })).toEqual({
        status: 'unavailable',
      })
    })

    test('persists the session id returned by the backend', async () => {
      setAttachTarget({ socketPath: '/tmp/openbuff-test.sock' })
      const detach = mock(async () => 'sess-1')
      const getClient = mock(async () => fakeClient({ detach }))

      expect(await detachSession({ getClient })).toEqual({
        status: 'detached',
        sessionId: 'sess-1',
      })
      expect(getLastDetachedSessionId()).toBe('sess-1')
    })

    test('reports no-session when the backend has nothing to detach', async () => {
      setAttachTarget({ socketPath: '/tmp/openbuff-test.sock' })
      const detach = mock(async () => undefined)
      const getClient = mock(async () => fakeClient({ detach }))

      expect(await detachSession({ getClient })).toEqual({
        status: 'no-session',
      })
      expect(getLastDetachedSessionId()).toBeUndefined()
    })

    test('never rejects when the backend detach throws', async () => {
      setAttachTarget({ socketPath: '/tmp/openbuff-test.sock' })
      const getClient = mock(async () =>
        fakeClient({
          detach: async () => {
            throw new Error('socket closed')
          },
        }),
      )

      expect(await detachSession({ getClient })).toEqual({
        status: 'error',
        message: 'socket closed',
      })
      expect(getLastDetachedSessionId()).toBeUndefined()
    })
  })

  describe('attachSession', () => {
    test('fails closed with no persisted session id, without a client', async () => {
      const getClient = mock(() => {
        throw new Error('client must not be built without a session id')
      })

      expect(await attachSession({ getClient })).toEqual({
        status: 'no-session-id',
      })
      expect(getClient).not.toHaveBeenCalled()
    })

    test('calls backend.attach with the persisted session id', async () => {
      setAttachTarget({ socketPath: '/tmp/openbuff-test.sock' })
      setLastDetachedSessionId('sess-1')
      const attach = mock(async (_sessionId: string) => {})
      const getClient = mock(async () => fakeClient({ attach }))

      expect(await attachSession({ getClient })).toEqual({
        status: 'attached',
        sessionId: 'sess-1',
      })
      expect(attach).toHaveBeenCalledWith('sess-1')
    })

    test('is unavailable when the backend has no attach (in-process)', async () => {
      setAttachTarget({ socketPath: '/tmp/openbuff-test.sock' })
      setLastDetachedSessionId('sess-1')
      const getClient = mock(async () => fakeClient({}))

      expect(await attachSession({ getClient })).toEqual({
        status: 'unavailable',
      })
    })

    test('is unavailable outside attach mode even with a persisted id', async () => {
      setLastDetachedSessionId('sess-1')
      const getClient = mock(() => {
        throw new Error('client must not be built outside attach mode')
      })

      expect(await attachSession({ getClient })).toEqual({
        status: 'unavailable',
      })
      expect(getClient).not.toHaveBeenCalled()
    })

    test('never rejects when the backend attach throws', async () => {
      setAttachTarget({ socketPath: '/tmp/openbuff-test.sock' })
      setLastDetachedSessionId('sess-1')
      const getClient = mock(async () =>
        fakeClient({
          attach: async () => {
            throw new Error('loadSession failed')
          },
        }),
      )

      expect(await attachSession({ getClient })).toEqual({
        status: 'error',
        message: 'loadSession failed',
      })
    })
  })
})
