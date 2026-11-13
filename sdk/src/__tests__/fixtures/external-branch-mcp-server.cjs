// Local protocol/env recorder. Executed only after the root authorizes the test lane.
const fs = require('node:fs')
const readline = require('node:readline')
fs.writeFileSync(process.env.EXTERNAL_RECORD_FILE, JSON.stringify({ pid: process.pid, env: process.env }))
readline.createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line)
  if (message.id === undefined) return
  const result = message.method === 'initialize'
    ? { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'b19-branch-peer', version: '1' } }
    : message.method === 'tools/list'
      ? { tools: [{ name: 'record', inputSchema: { type: 'object' } }] }
      : { content: [{ type: 'text', text: 'branch-mcp-peer' }] }
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\n')
})
