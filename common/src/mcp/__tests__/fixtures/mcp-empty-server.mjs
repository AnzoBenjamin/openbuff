// Lightweight real MCP peers for exercising the registry's 64-transport cap.
// Catalog behavior itself is exercised by the SDK-backed catalog fixture.
import { createInterface } from 'node:readline'

createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line)
  if (message.id === undefined) return
  const result =
    message.method === 'initialize'
      ? {
          protocolVersion: message.params.protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: 'empty-fixture', version: '1.0.0' },
        }
      : { tools: [] }
  process.stdout.write(
    `${JSON.stringify({ jsonrpc: '2.0', id: message.id, result })}\n`,
  )
})
process.stdin.on('end', () => process.exit(0))
