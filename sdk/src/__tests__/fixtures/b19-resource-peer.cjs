// Real Node peer: lifecycle evidence is separate from MCP stdout.
const fs = require('node:fs')
const readline = require('node:readline')
const [mode, eventsFile] = process.argv.slice(2)
const record = event => fs.appendFileSync(eventsFile, JSON.stringify({ at: Date.now(), pid: process.pid, ...event }) + '\n')
record({ event: 'start', mode })
setInterval(() => record({ event: 'heartbeat' }), 30)
process.on('exit', code => record({ event: 'exit', code }))
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => {
  record({ event: 'signal', signal })
  process.exit(0)
})
process.stdin.on('end', () => record({ event: 'stdin-end' }))
if (mode === 'mcp') {
  const send = value => process.stdout.write(JSON.stringify(value) + '\n')
  const lines = readline.createInterface({ input: process.stdin })
  lines.on('close', () => record({ event: 'readline-close' }))
  lines.on('line', line => {
    const message = JSON.parse(line)
    record({ event: 'message', method: message.method, name: message.params?.name })
    if (message.id === undefined) return
    let result
    if (message.method === 'initialize') result = {
      protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'b19-resource-peer', version: '1' },
    }
    else if (message.method === 'tools/list') result = { tools: [{ name: 'record', inputSchema: { type: 'object' } }] }
    else if (message.method === 'tools/call') result = {
      content: [{ type: 'text', text: JSON.stringify({ pid: process.pid, name: message.params.name }) }],
      structuredContent: { pid: process.pid, name: message.params.name },
    }
    else throw new Error('Unexpected MCP method: ' + message.method)
    send({ jsonrpc: '2.0', id: message.id, result })
  })
}
