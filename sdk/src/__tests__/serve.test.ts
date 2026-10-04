import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { connect } from 'node:net'
import type { Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable, Writable } from 'node:stream'

import {
  ClientSideConnection,
  PROTOCOL_VERSION,
  ndJsonStream,
} from '@agentclientprotocol/sdk'
import type { Client, Stream } from '@agentclientprotocol/sdk'

import { runServe } from '../serve/serve'
import type { ServeBridgeClient } from '../serve/bridge'
import { AcpSessionData } from '../services/acp/session-data'

import type { Logger } from '@codebuff/common/types/contracts/logger'
import type { RunState } from '../run-state'

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error('Timed out waiting for condition.')
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 5))
  }
}

// process.geteuid is undefined on Windows: the socket transport is unix-only.
const describeUnix =
  typeof process.geteuid === 'function' ? describe : describe.skip

describeUnix('runServe SEC-7 containment wiring', () => {
  const tempDirs: string[] = []
  const servers: Array<{ close: () => Promise<void> }> = []
  const sockets: Socket[] = []

  const makeTempDir = (prefix: string): string => {
    const dir = mkdtempSync(join(tmpdir(), prefix))
    tempDirs.push(dir)
    return dir
  }

  afterEach(async () => {
    for (const socket of sockets.splice(0)) {
      socket.destroy()
    }
    for (const server of servers.splice(0)) {
      await server.close()
    }
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop()
      if (dir) rmSync(dir, { recursive: true, force: true })
    }
  })

  const DONE_STATE: RunState = { output: { type: 'error', message: 'done' } }
  const fakeServeClient = (): ServeBridgeClient => ({
    run: async () => DONE_STATE,
  })

  function startServe(params: {
    socketDir: string
    projectRoot?: string
    allowedAdditionalDirectories?: string[]
    logger?: Logger
  }): { socketPath: string; token: string } {
    const socketPath = join(params.socketDir, 'serve.sock')
    const token = 'containment-token'
    servers.push(
      runServe({
        client: fakeServeClient(),
        sessionData: new AcpSessionData(),
        transport: { kind: 'socket', socketPath, token },
        logger: params.logger,
        ...(params.projectRoot !== undefined
          ? { projectRoot: params.projectRoot }
          : {}),
        ...(params.allowedAdditionalDirectories !== undefined
          ? {
              allowedAdditionalDirectories:
                params.allowedAdditionalDirectories,
            }
          : {}),
      }),
    )
    return { socketPath, token }
  }

  function connectAuthedClient(
    socketPath: string,
    token: string,
  ): ClientSideConnection {
    const socket = connect(socketPath)
    sockets.push(socket)
    // Auth line first, then ACP framing on the same socket (SEC-4).
    socket.write(`${JSON.stringify({ type: 'openbuff.serve.auth', token })}\n`)
    const stream: Stream = ndJsonStream(
      Writable.toWeb(socket) as unknown as WritableStream<Uint8Array>,
      Readable.toWeb(socket) as unknown as ReadableStream<Uint8Array>,
    )
    const fakeClient: Client = {
      requestPermission: async () => {
        throw new Error('requestPermission is not expected in these tests')
      },
      sessionUpdate: async () => {},
    }
    return new ClientSideConnection(() => fakeClient, stream)
  }

  test(
    'options accepted: projectRoot + allowedAdditionalDirectories are threaded ' +
      'into SEC-7 (out-of-root cwd and unlisted additionalDirectories rejected)',
    async () => {
      const socketDir = makeTempDir('serve-sec7-sock-')
      const projectRoot = makeTempDir('serve-sec7-root-')
      const allowedDir = makeTempDir('serve-sec7-allowed-')
      const outsiderDir = makeTempDir('serve-sec7-out-')

      const { socketPath, token } = startServe({
        socketDir,
        projectRoot,
        allowedAdditionalDirectories: [allowedDir],
      })
      await waitFor(() => existsSync(socketPath))

      const client = connectAuthedClient(socketPath, token)
      await client.initialize({ protocolVersion: PROTOCOL_VERSION })

      // Options accepted AND enforced: a cwd equal to the containment root
      // is admitted.
      const session = await client.newSession({
        cwd: projectRoot,
        mcpServers: [],
      })
      expect(typeof session.sessionId).toBe('string')

      // A cwd outside the containment root is rejected (-32602).
      await expect(
        client.newSession({ cwd: outsiderDir, mcpServers: [] }),
      ).rejects.toThrow(/inside the server project root/)

      // The additionalDirectories allowlist: an entry the host did not
      // allow is rejected; a listed entry is admitted.
      await expect(
        client.newSession({
          cwd: projectRoot,
          mcpServers: [],
          additionalDirectories: [outsiderDir],
        }),
      ).rejects.toThrow(/not in the server's allowed additional directories/)

      const allowed = await client.newSession({
        cwd: projectRoot,
        mcpServers: [],
        additionalDirectories: [allowedDir],
      })
      expect(typeof allowed.sessionId).toBe('string')
    },
  )

  test(
    'projectRoot omitted: warns via the injected logger and defaults the ' +
      'containment root to process.cwd() (never silently permissive)',
    async () => {
      const socketDir = makeTempDir('serve-sec7-default-sock-')
      const outsiderDir = makeTempDir('serve-sec7-default-out-')
      const warnings: Array<{ data: unknown; message?: string }> = []
      const logger: Logger = {
        debug: () => {},
        info: () => {},
        warn: (data, message) => {
          warnings.push({ data, message })
        },
        error: () => {},
      }

      const { socketPath, token } = startServe({ socketDir, logger })
      await waitFor(() => existsSync(socketPath))

      const client = connectAuthedClient(socketPath, token)
      await client.initialize({ protocolVersion: PROTOCOL_VERSION })

      // The omission was logged loudly through the injected logger.
      expect(warnings.length).toBeGreaterThan(0)
      expect(
        warnings.some((warning) =>
          (warning.message ?? '').includes('projectRoot'),
        ),
      ).toBe(true)

      // Containment still applies against the DEFAULT root: a cwd outside
      // process.cwd() is rejected, so the default is not permissive.
      await expect(
        client.newSession({ cwd: outsiderDir, mcpServers: [] }),
      ).rejects.toThrow(/inside the server project root/)

      // And the defaulted root IS process.cwd(): a session anchored there
      // is admitted.
      const session = await client.newSession({
        cwd: process.cwd(),
        mcpServers: [],
      })
      expect(typeof session.sessionId).toBe('string')
    },
  )
})
