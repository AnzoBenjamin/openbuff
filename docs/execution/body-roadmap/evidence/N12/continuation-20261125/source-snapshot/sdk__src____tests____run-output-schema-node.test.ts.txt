import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { pathToFileURL } from 'node:url'

// Actual Node consumers of the final public bundles, not source imports.
for (const format of ['cjs', 'esm'] as const)
  test(`Node ${format} consumes per-run model, schema, usage and previousRun`, async () => {
    const root = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'n12-node-consumer-')),
    )
    const sdk = path.resolve(
      import.meta.dir,
      `../../dist/index.${format === 'cjs' ? 'cjs' : 'mjs'}`,
    )
    const requests: Record<string, unknown>[] = []
    const server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      async fetch(request) {
        const body = (await request.json()) as Record<string, unknown>
        requests.push(body)
        const value = { answer: 'node-confirmed' }
        const packet = (
          delta: unknown,
          finish_reason: string | null,
          usage?: unknown,
        ) =>
          `data: ${JSON.stringify({
            id: 'node-fixture',
            object: 'chat.completion.chunk',
            created: 0,
            model: body.model,
            choices: [{ index: 0, delta, finish_reason }],
            ...(usage ? { usage } : {}),
          })}\n\n`
        return new Response(
          packet(
            {
              tool_calls: [
                {
                  index: 0,
                  id: `output-${requests.length}`,
                  type: 'function',
                  function: {
                    name: 'set_output',
                    arguments: JSON.stringify(value),
                  },
                },
              ],
            },
            null,
          ) +
            packet({}, 'tool_calls', {
              prompt_tokens: 50,
              completion_tokens: 5,
              total_tokens: 55,
            }) +
            'data: [DONE]\n\n',
          { headers: { 'content-type': 'text/event-stream' } },
        )
      },
    })
    const config = path.join(root, 'config.json')
    fs.writeFileSync(
      config,
      JSON.stringify({
        defaultModel: 'fixture/default',
        indexing: { enabled: false },
        providers: {
          fixture: {
            type: 'openai-compatible',
            baseURL: `http://127.0.0.1:${server.port}/v1`,
            models: ['default', 'selected'],
          },
        },
      }),
    )
    const script = path.join(
      root,
      `consumer.${format === 'cjs' ? 'cjs' : 'mjs'}`,
    )
    fs.writeFileSync(
      script,
      `
console.log = console.error; console.info = console.error; console.debug = console.error;
async function main() {
  const origin = ${JSON.stringify(`http://127.0.0.1:${server.port}`)};
  const actualFetch = globalThis.fetch; let blocked = 0;
  globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin !== origin) { blocked++; throw new Error('External fetch forbidden'); }
    return actualFetch(input, init);
  };
  const { OpenbuffClient } = ${format === 'cjs' ? `require(${JSON.stringify(sdk)})` : `await import(${JSON.stringify(pathToFileURL(sdk).href)})`};
  const cwd = ${JSON.stringify(root)}, events = [];
  const client = new OpenbuffClient({ cwd, projectFiles: {}, knowledgeFiles: {}, userKnowledgeFiles: {},
    repositoryIntelligence: false, harnessStateDir: cwd + '/harness', runTimeoutMs: 10000,
    agentDefinitions: [{ id: 'n12-node', displayName: 'Node consumer', toolNames: [], systemPrompt: 'Report the requested JSON.' }],
    handleEvent(event) { events.push(event); }, logger: { debug() {}, info() {}, warn() {}, error() {} },
    hostConfiguration: { environment: { PATH: process.env.PATH, OPENBUFF_PROCESS_SUPERVISION: '0', OPENBUFF_TELEMETRY: '0' },
      platform: process.platform, invocationCwd: cwd, projectRoot: cwd, home: { kind: 'none' }, globals: { kind: 'disabled' },
      selection: { kind: 'explicit', path: ${JSON.stringify(config)}, required: true }, trust: { ancestorConfig: false, projectReadableRoots: false } }
  });
  const schema = { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'], additionalProperties: false };
  const first = await client.run({ agent: 'n12-node', model: 'fixture/selected', prompt: 'Remember NODE_CONTINUATION_CANARY.', outputSchema: schema });
  if (first.runOutcome?.termination !== 'completed') throw new Error(JSON.stringify(first.output));
  const next = await client.run({ agent: 'n12-node', prompt: 'Continue the conversation.', outputSchema: schema, previousRun: first });
  if (next.runOutcome?.termination !== 'completed') throw new Error(JSON.stringify(next.output));
  process.stdout.write(JSON.stringify({ first: first.output, next: next.output, blocked, usages: events.filter(event => event.type === 'usage') }));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
`,
    )
    const child = spawn('node', [script], {
      cwd: root,
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        OPENBUFF_PROCESS_SUPERVISION: '0',
        OPENBUFF_TELEMETRY: '0',
        DO_NOT_TRACK: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_NOSYSTEM: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const out: Buffer[] = [],
      err: Buffer[] = []
    child.stdout.on('data', (value) => out.push(Buffer.from(value)))
    child.stderr.on('data', (value) => err.push(Buffer.from(value)))
    const timer = setTimeout(() => child.kill('SIGKILL'), 20_000)
    try {
      const code = await new Promise<number | null>((resolve, reject) => {
        child.once('close', resolve)
        child.once('error', reject)
      })
      expect(code, Buffer.concat(err).toString('utf8')).toBe(0)
      expect(child.signalCode).toBeNull()
      const result = JSON.parse(Buffer.concat(out).toString('utf8'))
      expect(result.first).toEqual({
        type: 'structuredOutput',
        value: { answer: 'node-confirmed' },
      })
      expect(result.next).toEqual(result.first)
      expect(result.blocked).toBe(0)
      expect(result.usages).toHaveLength(2)
      expect(result.usages[0]).toMatchObject({
        inputTokens: 50,
        outputTokens: 5,
        complete: true,
      })
      expect(requests.map((request) => request.model)).toEqual([
        'selected',
        'default',
      ])
      expect(JSON.stringify(requests[1].messages)).toContain(
        'NODE_CONTINUATION_CANARY',
      )
    } finally {
      clearTimeout(timer)
      if (child.exitCode === null && child.signalCode === null)
        child.kill('SIGKILL')
      server.stop(true)
      fs.rmSync(root, { recursive: true, force: true })
    }
  }, 25_000)
