import { describe, expect, test } from 'bun:test'
import { spawn } from 'node:child_process'
import {
  captureMcpConfig,
  closeMCPClient,
  getMediatedMCPClient,
  listMCPToolCatalog,
} from '../client'
import { executionFixture, value } from './execution-fixture'
import type { CodebuffSpawn } from '../../types/spawn'
import { OwnedStdioTransport } from '../stdio-transport'
import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'

const server = `
const readline = require('node:readline');
readline.createInterface({ input: process.stdin }).on('line', line => {
 const m = JSON.parse(line); if (m.id === undefined) return;
 if (m.method === 'tools/call' && m.params.name === 'exit') { process.exit(0); return; }
 let result;
 if (m.method === 'initialize') result = {protocolVersion:m.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}};
 else if (m.method === 'tools/list') result = {tools:[{name:'record',description:'local recorder',inputSchema:{type:'object'}}]};
 else result = {content:[{type:'text',text:JSON.stringify({pid:process.pid,value:process.env.PROJECT_VALUE,canonical:!!process.env.OPENAI_API_KEY,configured:!!process.env.CUSTOM_PROVIDER_KEY})}]};
 process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');
});`

function fixtureTarget(
  context: ReturnType<ReturnType<typeof executionFixture>['context']>,
  args: string[],
  overlay = {},
) {
  return {
    executable: process.execPath,
    argv: args,
    cwd: process.cwd(),
    projectRoot: context.projectRoot,
    allowedPaths: context.allowedPaths,
    mode: context.mode,
    processType: 'BACKGROUND' as const,
    profile: context.profile,
    family: 'mcp-stdio' as const,
    branchId: 'mcp.discovery-start',
    environmentOverlay: overlay,
    adapterOptions: {
      runtime: 'node',
      shell: false,
      stdio: 'pipe,pipe,ignore',
      windowsHide: false,
    },
  }
}

describe('owned MCP actual stdio boundary', () => {
  test('an exited MCP child requires a newly admitted resource generation', async () => {
    const fixture = executionFixture()
    const context = fixture.context()
    const args = ['--no-env-file', '-e', server]
    const captured = captureMcpConfig(
      { type: 'stdio', command: process.execPath, args, env: {} },
      { origin: 'project', environment: {} },
    )
    const resource = value(fixture.resources(fixtureTarget(context, args)))
    let clientId: string | undefined
    try {
      const first = await getMediatedMCPClient(captured, {
        resource,
        execution: context.execution,
      })
      const oldId = first.id
      await expect(
        first.callTool({ name: 'exit', arguments: {} }),
      ).rejects.toThrow()
      first.release()
      const second = await getMediatedMCPClient(captured, {
        resource,
        execution: fixture.context().execution,
      })
      clientId = second.id
      try {
        expect((await second.listToolCatalog()).complete).toBe(true)
        expect(second.id).not.toBe(oldId)
        const observed = fixture.events.filter(
          (event) => event.phase === 'spawn-observed',
        )
        expect(observed).toHaveLength(2)
        expect(observed[0].facts.resourceGeneration).not.toBe(
          observed[1].facts.resourceGeneration,
        )
      } finally {
        second.release()
      }
    } finally {
      if (clientId) await closeMCPClient(clientId)
      fixture.close()
    }
  }, 10_000)

  test('close while admission waits cannot dispatch a child later', async () => {
    let allow: (() => void) | undefined
    const fixture = executionFixture({
      authorizeAsync: async () => {
        await new Promise<void>((resolve) => {
          allow = resolve
        })
        return { ok: true, basis: 'explicit-policy', decisionId: 'deferred' }
      },
    })
    const context = fixture.context()
    const access = value(
      value(fixture.resources(fixtureTarget(context, []))).request(
        context.execution,
      ),
    )
    let launches = 0
    const transport = new OwnedStdioTransport({
      prepareLaunch: () => access.prepareLaunch(),
      spawn: () => {
        launches++
        throw new Error('must not launch')
      },
    })
    try {
      const pending = transport.start()
      await transport.close()
      allow?.()
      await expect(pending).rejects.toThrow('closed before dispatch')
      expect(launches).toBe(0)
    } finally {
      access.release()
      fixture.close()
    }
  })

  test('a child lacking an actual runtime PID cannot activate the resource', async () => {
    const fixture = executionFixture()
    const context = fixture.context()
    const access = value(
      value(fixture.resources(fixtureTarget(context, []))).request(
        context.execution,
      ),
    )
    let terminations = 0
    const transport = new OwnedStdioTransport({
      prepareLaunch: () => access.prepareLaunch(),
      spawn: () => {
        const child = new EventEmitter() as ChildProcess
        child.kill = () => {
          terminations++
          return true
        }
        queueMicrotask(() => child.emit('spawn'))
        return child
      },
    })
    try {
      await expect(transport.start()).rejects.toThrow('no valid runtime PID')
      expect(terminations).toBe(1)
      expect(
        fixture.events.some((event) => event.phase === 'spawn-observed'),
      ).toBe(false)
    } finally {
      await transport.close()
      access.release()
      fixture.close()
    }
  })

  test('captured env reaches a real child; a fresh request reuses its observed process', async () => {
    const fixture = executionFixture()
    const controller = new AbortController()
    const firstContext = fixture.context(controller.signal)
    const config = {
      type: 'stdio' as const,
      command: process.execPath,
      args: ['--no-env-file', '-e', server],
      env: { PROJECT_VALUE: '$CHOICE' },
    }
    const environment = { CHOICE: 'captured' }
    const captured = captureMcpConfig(config, {
      origin: 'project',
      environment,
    })
    environment.CHOICE = 'changed'
    config.env.PROJECT_VALUE = 'changed-again'
    const resource = value(
      fixture.resources({
        ...fixtureTarget(
          firstContext,
          config.args,
          captured.resolved.type === 'stdio' ? captured.resolved.env : {},
        ),
        branchId: 'mcp.call-start',
      }),
    )
    let launches = 0
    const recorder: CodebuffSpawn = (command, args, options) => {
      launches++
      return spawn(command, args ?? [], options ?? {})
    }
    let clientId: string | undefined
    try {
      const first = await getMediatedMCPClient(captured, {
        resource,
        execution: firstContext.execution,
        signal: controller.signal,
        spawn: recorder,
      })
      clientId = first.id
      const output = await first.callTool({ name: 'record', arguments: {} })
      expect((await first.listToolCatalog()).complete).toBe(true)
      expect(() => listMCPToolCatalog(first.id)).toThrow(
        'current request lease',
      )
      expect(output[0]?.type).toBe('json')
      if (output[0]?.type !== 'json') throw new Error('Missing fixture output')
      const envelope = output[0].value as { content: { text: string }[] }
      expect(JSON.parse(envelope.content[0].text)).toMatchObject({
        value: 'captured',
        canonical: false,
        configured: false,
      })
      first.release()
      controller.abort()
      const secondContext = fixture.context()
      const second = await getMediatedMCPClient(captured, {
        resource,
        execution: secondContext.execution,
        spawn: recorder,
      })
      try {
        expect((await second.listToolCatalog()).complete).toBe(true)
        expect(launches).toBe(1)
        expect(
          fixture.events.filter((e) => e.phase === 'spawn-observed'),
        ).toHaveLength(1)
        expect(fixture.events.some((e) => e.phase === 'resource-reused')).toBe(
          true,
        )
      } finally {
        second.release()
      }
    } finally {
      if (clientId) await closeMCPClient(clientId)
      fixture.close()
    }
  }, 10_000)

  test.each(['mcp.discovery-start', 'mcp.call-start'])(
    'denied %s invokes no actual spawn',
    async (branchId) => {
      const fixture = executionFixture({
        authorizeAsync: async () => ({
          ok: false,
          reason: 'denied',
          cause: 'fixture denial',
        }),
      })
      const context = fixture.context()
      const args = ['--no-env-file', '-e', server]
      const captured = captureMcpConfig(
        { type: 'stdio', command: process.execPath, args, env: {} },
        { origin: 'project', environment: {} },
      )
      const resource = value(
        fixture.resources({ ...fixtureTarget(context, args), branchId }),
      )
      let launches = 0
      try {
        await expect(
          getMediatedMCPClient(captured, {
            resource,
            execution: context.execution,
            spawn: () => {
              launches++
              throw new Error('must not spawn')
            },
          }),
        ).rejects.toThrow('fixture denial')
        expect(launches).toBe(0)
        expect(fixture.events.some((e) => e.phase === 'no-launch')).toBe(true)
        expect(fixture.events.some((e) => e.phase === 'spawn-observed')).toBe(
          false,
        )
      } finally {
        fixture.close()
      }
    },
  )
})
