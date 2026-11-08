import { appendFileSync } from 'node:fs'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod/v4'

const callSchema = z.object({
  method: z.literal('tools/call'),
  params: z.object({
    name: z.string(),
    arguments: z.record(z.string(), z.unknown()).optional(),
  }),
})

const mode = process.argv[2] ?? 'paged'
const logPath = process.argv[3]
const record = (event) => {
  if (logPath)
    appendFileSync(logPath, `${JSON.stringify({ event, pid: process.pid })}\n`)
}
let version = 0
let requests = 0
let notified = false
const server = new Server(
  { name: 'openbuff-catalog-fixture', version: '1.0.0' },
  { capabilities: { tools: { listChanged: true } } },
)
const tool = (
  name,
  schema = {
    type: 'object',
    properties: { path: { type: 'string', pattern: '^/api/v1$' } },
    additionalProperties: false,
  },
) => ({
  name: version ? `${name}-v${version}` : name,
  description: 'Fixture catalog tool.',
  inputSchema: schema,
})

server.setRequestHandler(ListToolsRequestSchema, async (request) => {
  requests++
  const cursor = request.params?.cursor
  record(`list:${cursor ?? 'first'}`)
  if (mode === 'slow') await new Promise((resolve) => setTimeout(resolve, 80))
  if (mode === 'slow-page' && cursor !== undefined)
    await new Promise((resolve) => setTimeout(resolve, 120))
  if (mode === 'fail' && cursor !== undefined)
    throw new Error('fixture page failed')
  if (mode === 'disconnect' && cursor !== undefined) {
    await server.close()
    process.exit(0)
  }
  if (mode === 'notify-page' && cursor !== undefined && !notified) {
    notified = true
    version++
    await server.sendToolListChanged()
  }
  if (mode === 'conflict' && cursor !== undefined)
    return {
      tools: [tool('first', { type: 'object', additionalProperties: true })],
    }
  if (mode === 'identical' && cursor !== undefined)
    return { tools: [tool('first'), tool('last')] }
  if (mode === 'output-schema') {
    return {
      tools: [
        {
          ...tool(cursor === undefined ? 'first' : 'last'),
          outputSchema: {
            type: 'object',
            properties: { value: { type: 'number', multipleOf: 0.1 } },
            required: ['value'],
            additionalProperties: false,
          },
        },
      ],
      ...(cursor === undefined ? { nextCursor: 'second' } : {}),
    }
  }
  if (mode === 'reserved-step') {
    const reserved = {
      type: 'object',
      properties: { cb_easp: { type: 'boolean' } },
    }
    return {
      tools: [
        tool('required', { ...reserved, required: ['cb_easp'] }),
        tool('optional', reserved),
        tool('required-only', { type: 'object', required: ['cb_easp'] }),
        tool('pattern', {
          type: 'object',
          patternProperties: { '^cb_easp$': { type: 'boolean' } },
        }),
        tool('composed', { type: 'object', allOf: [reserved] }),
        tool('referenced', {
          type: 'object',
          definitions: { input: reserved },
          allOf: [{ $ref: '#/definitions/input' }],
        }),
        {
          ...tool('nested', {
            type: 'object',
            properties: {
              payload: {
                ...reserved,
                required: ['cb_easp'],
                additionalProperties: false,
              },
            },
            required: ['payload'],
            additionalProperties: false,
          }),
          outputSchema: {
            ...reserved,
            required: ['cb_easp'],
            additionalProperties: false,
          },
        },
      ],
    }
  }
  return {
    tools: [tool(cursor === undefined ? 'first' : 'last')],
    ...(cursor === undefined || mode === 'loop'
      ? { nextCursor: 'second' }
      : {}),
    _meta: { requests },
  }
})

server.setRequestHandler(callSchema, async (request) => {
  if (mode === 'output-schema') return request.params.arguments.result
  if (mode === 'reserved-step')
    return {
      content: [],
      structuredContent: { cb_easp: request.params.arguments.payload.cb_easp },
    }
  if (request.params.name === 'notify') {
    version++
    await server.sendToolListChanged()
  }
  return { content: [{ type: 'text', text: 'ok' }] }
})
if (mode === 'early-notify')
  server.oninitialized = () => {
    version++
    void server.sendToolListChanged()
  }
record('started')
process.on('exit', () => record('closed'))
process.stdin.on('end', () => process.exit(0))
process.on('SIGTERM', () => process.exit(0))
await server.connect(new StdioServerTransport())
