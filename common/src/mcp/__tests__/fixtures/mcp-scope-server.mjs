import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

const mode = process.argv[2]
const directory = process.argv[3]
const record = (event, details = {}) =>
  appendFileSync(
    join(directory, 'events.jsonl'),
    `${JSON.stringify({ event, pid: process.pid, atMs: Date.now(), ...details })}\n`,
  )

if (mode === 'descendant') {
  process.on('SIGTERM', () => record('descendant-ignored-term'))
  record('descendant-started')
  writeFileSync(
    join(directory, 'descendant-ready.json'),
    JSON.stringify({ pid: process.pid }),
  )
  setInterval(() => {
    if (process.argv[4] === 'pipe')
      process.stdout.write(
        `${JSON.stringify({ jsonrpc: '2.0', method: 'fixture/alive', params: { pid: process.pid } })}\n`,
      )
  }, 25)
} else {
  process.on('exit', () => {
    record('leader-exited')
    writeFileSync(join(directory, 'leader-exited'), '')
  })
  process.on('SIGTERM', () => {
    record('leader-term')
    process.exit(0)
  })
  const child = spawn(
    process.execPath,
    [
      '--no-env-file',
      fileURLToPath(import.meta.url),
      'descendant',
      directory,
      mode === 'inherited-pipe' ? 'pipe' : 'redirected',
    ],
    {
      detached: false,
      shell: false,
      stdio: [
        'ignore',
        mode === 'inherited-pipe' ? 'inherit' : 'ignore',
        'ignore',
      ],
    },
  )
  const ready = (async () => {
    const deadline = Date.now() + 5000
    while (
      !existsSync(join(directory, 'descendant-ready.json')) &&
      Date.now() < deadline
    )
      await new Promise((resolve) => setTimeout(resolve, 5))
    if (!existsSync(join(directory, 'descendant-ready.json')))
      throw new Error('Descendant did not become ready')
    record('leader-ready', { descendantPid: child.pid })
    writeFileSync(
      join(directory, 'leader-ready.json'),
      JSON.stringify({ pid: process.pid, descendantPid: child.pid }),
    )
  })()
  const input = createInterface({ input: process.stdin })
  input.on('line', async (line) => {
    const message = JSON.parse(line)
    if (message.id === undefined) return
    await ready
    let result
    if (message.method === 'initialize') {
      result = {
        protocolVersion: message.params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: 'mcp-scope-fixture', version: '1' },
      }
    } else if (message.method === 'tools/list') {
      result = {
        tools: [
          { name: 'record', inputSchema: { type: 'object' } },
          { name: 'hold', inputSchema: { type: 'object' } },
        ],
      }
    } else if (message.params?.name === 'exit-leader') {
      process.exit(0)
    } else {
      if (message.params?.name === 'hold') {
        record('call-started')
        const deadline = Date.now() + 10_000
        while (
          !existsSync(join(directory, 'release-call')) &&
          Date.now() < deadline
        )
          await new Promise((resolve) => setTimeout(resolve, 5))
        if (!existsSync(join(directory, 'release-call')))
          throw new Error('Held call was not released')
        record('call-released')
      }
      result = {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              pid: process.pid,
              descendantPid: child.pid,
            }),
          },
        ],
      }
    }
    process.stdout.write(
      `${JSON.stringify({ jsonrpc: '2.0', id: message.id, result })}\n`,
    )
  })
  await ready
}
