import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { OpenbuffClient } from '../client'
import { createDirectHostExecution } from '../host-execution'
import { loadHostConfigSnapshot, nodeConfigReadFs } from '../host-config'
import { providerConfigFileSchema } from '../provider-config'
import { createNodeFileSystem } from '../tools/node-filesystem'
import { runTerminalCommand } from '../tools/run-terminal-command'
import {
  getBackgroundJobAdapter,
  killBackgroundJob,
} from '../tools/background-jobs'
import { sdkCallbackOptions } from './sdk-callback-fixture'
import type { AgentDefinition } from '@codebuff/common/templates/initial-agents-dir/types/agent-definition'
import type { OpenbuffClientOptions } from '../run'
import type { TerminalTimeoutPolicy } from '../tools/run-terminal-command'
import type { HostConfigurationInputs } from '../host-config'

let root: string
let fetches = 0
let network: ReturnType<typeof spyOn<typeof globalThis, 'fetch'>>
beforeEach(() => {
  root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'openbuff-terminal-cap-')),
  )
  fetches = 0
  const forbidden = () => {
    fetches++
    throw new Error('No providers in terminal cap controls')
  }
  network = spyOn(globalThis, 'fetch').mockImplementation(
    Object.assign(async () => forbidden(), { preconnect: forbidden }),
  )
})
afterEach(() => {
  network.mockRestore()
  fs.rmSync(root, { recursive: true, force: true })
  expect(fetches).toBe(0)
})

const agent: AgentDefinition = {
  id: 'terminal-cap-program',
  displayName: 'Terminal cap control',
  model: 'unused-fixture',
  toolNames: ['run_terminal_command', 'set_output'],
  terminalPermissionProfile: 'full-access',
  outputMode: 'structured_output',
  handleSteps: function* ({ prompt, params }) {
    if (!prompt) throw new Error('Control requires command')
    const terminal = yield {
      toolName: 'run_terminal_command',
      input: {
        command: prompt,
        process_type: params?.background === true ? 'BACKGROUND' : 'SYNC',
        detach: params?.detach === true,
        ...(typeof params?.timeout === 'number'
          ? { timeout_seconds: params.timeout }
          : {}),
      },
    }
    yield { toolName: 'set_output', input: { terminal: terminal.toolResult } }
  },
}
function clientOptions(
  extra: OpenbuffClientOptions = {},
): OpenbuffClientOptions {
  return {
    ...sdkCallbackOptions(root, { fsSource: createNodeFileSystem() }),
    repositoryIntelligence: false,
    harnessStateDir: path.join(root, 'harness'),
    approvalMode: 'allow-all',
    runTimeoutMs: 600,
    ...extra,
  }
}

function configInputs() {
  const project = path.join(root, 'project'),
    global = path.join(root, 'global')
  fs.mkdirSync(project)
  fs.mkdirSync(global)
  const inputs: HostConfigurationInputs = {
    environment: {},
    platform: process.platform,
    invocationCwd: project,
    projectRoot: project,
    home: { kind: 'path', path: root },
    globals: { kind: 'directory', path: global },
    selection: { kind: 'discover' },
    trust: {
      ancestorConfig: false,
      projectReadableRoots: false,
      projectConfig: 'untrusted',
    },
  }
  return { project, global, inputs }
}

describe('captured terminal timeout policy', () => {
  for (const timeout of [-1, 600])
    test(`client cap bounds original action admission for timeout ${timeout}`, async () => {
      let entered = false,
        aborted = false
      const policy: TerminalTimeoutPolicy = { maxSeconds: 0.05 }
      const client = new OpenbuffClient(
        clientOptions({
          terminalTimeoutPolicy: policy,
          overrideTools: {
            run_terminal_command: {
              version: 'v1',
              execute: async (_input, context) => {
                entered = true
                const signal = context.signal
                signal.addEventListener(
                  'abort',
                  () => {
                    aborted = true
                  },
                  { once: true },
                )
                return new Promise(() => {})
              },
            },
          },
        }),
      )
      const started = performance.now()
      const result = await client.run({
        agent,
        prompt: 'printf cap-control',
        params: { timeout },
      })
      expect(entered).toBe(true)
      expect(aborted).toBe(true)
      expect(performance.now() - started).toBeLessThan(450)
      expect(result.runOutcome?.cause?.code).not.toBe('run_deadline_exhausted')
      expect(result.output.type).toBe('error')
    })

  test('per-run policy wins and its captured copy cannot be changed by the override', async () => {
    const policy: { maxSeconds: number } = { maxSeconds: 0.05 }
    const client = new OpenbuffClient(
      clientOptions({
        terminalTimeoutPolicy: { maxSeconds: 5 },
        overrideTools: {
          run_terminal_command: {
            version: 'v1',
            execute: async () => {
              policy.maxSeconds = 5
              return new Promise(() => {})
            },
          },
        },
      }),
    )
    const started = performance.now()
    const result = await client.run({
      agent,
      prompt: 'printf cap-control',
      params: { timeout: -1 },
      terminalTimeoutPolicy: policy,
    })
    expect(performance.now() - started).toBeLessThan(450)
    expect(result.runOutcome?.cause?.code).not.toBe('run_deadline_exhausted')
  })

  for (const policy of [
    { maxSeconds: -1 },
    { maxSeconds: Infinity },
    { defaultSyncSeconds: 0 },
    { maxSeconds: 0.0001 },
    { allowUnbounded: 'yes' },
  ])
    test(`invalid host policy ${JSON.stringify(policy)} is refused before execution`, async () => {
      let entered = false
      const result = await new OpenbuffClient(
        clientOptions({
          terminalTimeoutPolicy: policy as TerminalTimeoutPolicy,
          overrideTools: {
            run_terminal_command: async () => {
              entered = true
              return [
                {
                  type: 'json',
                  value: { command: 'printf cap-control', exitCode: 0 },
                },
              ]
            },
          },
        }),
      ).run({ agent, prompt: 'printf cap-control' })
      expect(entered).toBe(false)
      expect(result.output.type).toBe('error')
      expect(result.runOutcome?.cause?.code).toBe('execution_invalid_context')
    })

  test('configured omitted-SYNC default reaches execution and retains partial output', async () => {
    const file = path.join(root, 'owned-config.json')
    fs.writeFileSync(
      file,
      JSON.stringify({ terminalTimeoutPolicy: { defaultSyncSeconds: 0.05 } }),
    )
    const values: unknown[] = []
    const options = clientOptions({
      runTimeoutMs: 1_500,
      handleEvent: (event) => {
        if (event.type === 'tool_result') values.push(event.output)
      },
    })
    options.hostConfiguration = {
      ...options.hostConfiguration!,
      selection: { kind: 'explicit', path: file, required: true },
    }
    const result = await new OpenbuffClient(options).run({
      agent,
      prompt: 'printf before-cap; sleep 0.7; printf late-cap',
    })
    const text = JSON.stringify({ result, values })
    expect(text).toContain('"stdout":"before-cap"')
    expect(text).toContain('deadline-exhausted')
    expect(text).not.toContain('before-caplate-cap')
    expect(result.output.type).toBe('error')
  })

  for (const timeout of [undefined, -1])
    test(`captured cap stops a detached background job for timeout ${timeout}`, async () => {
      const result = await new OpenbuffClient(
        clientOptions({
          terminalTimeoutPolicy: { maxSeconds: 0.25 },
          runTimeoutMs: 1_500,
        }),
      ).run({
        agent,
        prompt: 'printf bg-ready; sleep 0.8; printf bg-late',
        params: { background: true, detach: true, timeout },
      })
      expect(result.output.type, JSON.stringify(result.output)).toBe(
        'structuredOutput',
      )
      if (result.output.type !== 'structuredOutput' || !result.output.value)
        throw new Error('Background control failed to start')
      const start = (
        result.output.value.terminal as Array<{ value: { jobId?: string } }>
      )[0].value
      if (!start.jobId) throw new Error('No captured background job')
      const job = getBackgroundJobAdapter(start.jobId)
      if (!job?.nodeLaunch) throw new Error('No owned background launch')
      try {
        if (job.child.exitCode === null && job.child.signalCode === null)
          await new Promise<void>((resolve) => {
            job.child.once('close', () => resolve())
            // Node reports an AbortError when the registered resource expires;
            // close plus the owned refusal/cleanup below are the result oracle.
            job.child.once('error', () => {})
          })
        const deadline = job.nodeLaunch.facts().deadlines.resourceLifetime
        expect(deadline.kind).toBe('finite')
        expect(job.nodeLaunch.resourceRefusal()?.reason).toBe(
          'deadline-exhausted',
        )
        const log = fs.readFileSync(job.logFile, 'utf8')
        expect(log).toContain('bg-ready')
        expect(log).not.toContain('bg-late')
        const cleanup = await job.nodeLaunch.scope.requestStop('owner-shutdown')
        expect(cleanup.status).toBe('complete')
      } finally {
        killBackgroundJob(start.jobId)
        await job.nodeLaunch.scope.requestStop('owner-shutdown')
        fs.rmSync(job.logFile, { force: true })
        fs.rmSync(job.metadataFile, { force: true })
      }
    }, 5_000)

  test('a tool payload cannot replace the captured host timeout policy', async () => {
    const payloadAgent: AgentDefinition = {
      ...agent,
      handleSteps: function* () {
        const terminal = yield {
          toolName: 'run_terminal_command',
          input: {
            command: 'printf payload-before; sleep 0.7; printf payload-late',
            process_type: 'SYNC',
            timeout_seconds: -1,
            timeoutPolicy: { maxSeconds: 99, allowUnbounded: true },
          } as never,
        }
        yield {
          toolName: 'set_output',
          input: { terminal: terminal.toolResult },
        }
      },
    }
    const result = await new OpenbuffClient(
      clientOptions({
        terminalTimeoutPolicy: { maxSeconds: 0.1 },
        runTimeoutMs: 1_500,
      }),
    ).run({ agent: payloadAgent, prompt: 'Do not honor the injected policy' })
    expect(result.output.type).toBe('error')
    expect(result.runOutcome?.cause?.code).not.toBe('run_deadline_exhausted')
  })

  test('policy survives parsed config and sparse include layering', () => {
    expect(
      providerConfigFileSchema.parse({
        terminalTimeoutPolicy: { maxSeconds: 7 },
      }).terminalTimeoutPolicy,
    ).toEqual({ maxSeconds: 7 })
    fs.writeFileSync(
      path.join(root, 'base.json'),
      JSON.stringify({
        terminalTimeoutPolicy: { maxSeconds: 7, allowUnbounded: false },
      }),
    )
    const file = path.join(root, 'config.json')
    fs.writeFileSync(
      file,
      JSON.stringify({
        include: 'base.json',
        terminalTimeoutPolicy: { defaultSyncSeconds: 2 },
      }),
    )
    const inputs = clientOptions().hostConfiguration!
    const captured = loadHostConfigSnapshot({
      inputs: {
        ...inputs,
        selection: { kind: 'explicit', path: file, required: true },
      },
      fs: nodeConfigReadFs,
    })
    if (captured.status !== 'complete') throw new Error(captured.cause)
    expect(captured.snapshot.loaded.config.terminalTimeoutPolicy).toEqual({
      maxSeconds: 7,
      allowUnbounded: false,
      defaultSyncSeconds: 2,
    })
    expect(
      Object.isFrozen(captured.snapshot.loaded.config.terminalTimeoutPolicy),
    ).toBe(true)
  })

  test('untrusted project timeout declarations cannot loosen the user policy', () => {
    const f = configInputs()
    fs.writeFileSync(
      path.join(f.global, 'openbuff.json'),
      JSON.stringify({
        terminalTimeoutPolicy: {
          defaultSyncSeconds: 2,
          maxSeconds: 7,
          allowUnbounded: false,
        },
      }),
    )
    fs.writeFileSync(
      path.join(f.project, 'openbuff.json'),
      JSON.stringify({
        terminalTimeoutPolicy: {
          defaultSyncSeconds: 120,
          maxSeconds: 700,
          allowUnbounded: true,
        },
      }),
    )
    const captured = loadHostConfigSnapshot({
      inputs: f.inputs,
      fs: nodeConfigReadFs,
    })
    if (captured.status !== 'complete') throw new Error(captured.cause)
    expect(captured.snapshot.loaded.config.terminalTimeoutPolicy).toEqual({
      defaultSyncSeconds: 2,
      maxSeconds: 7,
      allowUnbounded: false,
    })
  })

  test('untrusted project timeout declarations can tighten a sparse policy', () => {
    const f = configInputs()
    fs.writeFileSync(
      path.join(f.global, 'openbuff.json'),
      JSON.stringify({ terminalTimeoutPolicy: { maxSeconds: 7 } }),
    )
    fs.writeFileSync(
      path.join(f.project, 'openbuff.json'),
      JSON.stringify({
        terminalTimeoutPolicy: {
          defaultSyncSeconds: 2,
          maxSeconds: 3,
          allowUnbounded: false,
        },
      }),
    )
    const captured = loadHostConfigSnapshot({
      inputs: f.inputs,
      fs: nodeConfigReadFs,
    })
    if (captured.status !== 'complete') throw new Error(captured.cause)
    expect(captured.snapshot.loaded.config.terminalTimeoutPolicy).toEqual({
      defaultSyncSeconds: 2,
      maxSeconds: 3,
      allowUnbounded: false,
    })
  })

  test('direct host policy selection includes trusted config and rejects invalid API policy', () => {
    const file = path.join(root, 'config.json')
    fs.writeFileSync(
      file,
      JSON.stringify({ terminalTimeoutPolicy: { maxSeconds: 7 } }),
    )
    const options = {
      cwd: root,
      hostConfiguration: {
        ...clientOptions().hostConfiguration!,
        selection: {
          kind: 'explicit' as const,
          path: file,
          required: true as const,
        },
      },
    }
    const host = createDirectHostExecution(options)
    if (!host.ok) throw new Error(host.cause)
    expect(host.value.hostServices.terminalTimeoutPolicy).toEqual({
      maxSeconds: 7,
    })
    expect(
      createDirectHostExecution({
        ...options,
        terminalTimeoutPolicy: { maxSeconds: -1 },
      }),
    ).toMatchObject({ ok: false, reason: 'invalid-context' })
  })

  test('direct terminal calls refuse invalid policy instead of silently treating it as no cap', async () => {
    const host = createDirectHostExecution({
      cwd: root,
      hostConfiguration: clientOptions().hostConfiguration,
    })
    if (!host.ok) throw new Error(host.cause)
    const result = await runTerminalCommand({
      command: 'printf cap-control',
      process_type: 'SYNC',
      cwd: root,
      executionContext: host.value.executionContext,
      timeoutPolicy: { maxSeconds: -1 },
    })
    expect(result[0].value).toMatchObject({
      executionRefusal: { reason: 'invalid-context' },
    })
  })
})
