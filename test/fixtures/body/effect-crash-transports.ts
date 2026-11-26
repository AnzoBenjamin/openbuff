import assert from 'node:assert/strict'

/** Fixed commands in the runner-owned directory only. Both subprocesses are
 * joined before the worker can announce a crash boundary. */
export function appendOwnedShellMarker(
  cwd: string,
  marker: 'effect' | 'finished',
): void {
  const script =
    marker === 'effect'
      ? "printf '%s\\n' effect >> counter.txt"
      : "printf '%s\\n' finished >> finished.txt"
  const result = Bun.spawnSync(['/bin/sh', '-c', script], {
    cwd,
    env: { PATH: '/usr/bin:/bin' },
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: 2_000,
  })
  assert.equal(result.exitCode, 0, result.stderr.toString())
}

/** Minimal owned Streamable HTTP peer; no redirects, remote calls or children. */
export function openOwnedEffectPeer(effect: () => Promise<void>) {
  let calls = 0
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    idleTimeout: 0,
    async fetch(request) {
      if (
        request.method !== 'POST' ||
        new URL(request.url).pathname !== '/mcp'
      ) {
        return new Response(null, { status: 405 })
      }
      const message = (await request.json()) as {
        id?: string | number
        method: string
        params?: {
          protocolVersion?: string
          name?: string
          arguments?: { canary?: string }
        }
      }
      if (message.id === undefined) return new Response(null, { status: 202 })
      const response = (result: unknown) =>
        Response.json({ jsonrpc: '2.0', id: message.id, result })
      switch (message.method) {
        case 'initialize':
          return response({
            protocolVersion: message.params?.protocolVersion,
            capabilities: { tools: {} },
            serverInfo: { name: 'b15-owned-effect', version: '1' },
          })
        case 'tools/list':
          return response({
            tools: [
              {
                name: 'owned_effect',
                description: 'Write an owned fixture canary',
                inputSchema: {
                  type: 'object',
                  properties: { canary: { type: 'string' } },
                  required: ['canary'],
                  additionalProperties: false,
                },
              },
            ],
          })
        case 'tools/call':
          assert.equal(message.params?.name, 'owned_effect')
          assert.equal(message.params?.arguments?.canary, 'owned')
          calls++
          await effect()
          return response({
            content: [{ type: 'text', text: 'Owned effect finished' }],
            structuredContent: { finished: true },
          })
        default:
          return Response.json({
            jsonrpc: '2.0',
            id: message.id,
            error: { code: -32601, message: 'Unsupported fixture request' },
          })
      }
    },
  })
  return {
    url: `http://127.0.0.1:${server.port}/mcp`,
    calls: () => calls,
    stop: () => server.stop(true),
  }
}
