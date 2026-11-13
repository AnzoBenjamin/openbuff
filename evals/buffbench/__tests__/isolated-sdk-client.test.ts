import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, test } from 'bun:test'
import {
  createIsolatedEvaluationClient,
  isIsolatedEvaluationClient,
} from '../isolated-sdk-client'
import { runEvaluatorIsolationFixture } from '../../../scripts/body-fixtures/evaluator-isolation'
import { runBuffBench, runTask } from '../run-buffbench'

describe('actual source SDK evaluator process isolation', () => {
  test('task, init, final checks and every auxiliary SDK call exclude controller state', async () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), 'buffbench-isolation-test-'),
    )
    try {
      const report = await runEvaluatorIsolationFixture(root)
      expect(report.observations).toHaveLength(7)
      expect(report.output.controller).toBeNull()
      expect(report.unavailable.output.type).toBe('error')
      expect((report.unavailable.output as any).message).toBe(
        report.unavailable.expectedMissingCredential,
      )
      expect((report.unavailable.observations[1] as any).fetch.attempted).toBe(
        0,
      )
      expect((report.unavailable.observations[1] as any).fetch.forwarded).toBe(
        0,
      )
      expect((report.missingAgent.output as any).message).toContain(
        'Invalid agent ID: "base2"',
      )
      expect((report.fetchGuardControl.observation as any).fetch).toMatchObject(
        { attempted: 1, refused: 1, forwarded: 0 },
      )
      expect(report.rejectedCallback).toBe(true)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  }, 30_000)

  test('refuses host execution seams and non-JSON definitions before starting a child', async () => {
    const adapter = createIsolatedEvaluationClient()
    expect(isIsolatedEvaluationClient(adapter.client)).toBe(true)
    expect(isIsolatedEvaluationClient({ run: async () => ({}) })).toBe(false)
    const cyclic: any = {}
    cyclic.self = cyclic
    for (const input of [
      { requestApproval: async () => true },
      { overrideTools: {} },
      { agentDefinitions: [{ id: 'bad', handleSteps: () => {} }] },
      { prompt: cyclic },
      { prompt: BigInt(1) },
      { prompt: new Date() },
      { maxAgentSteps: NaN },
      { prompt: 'x'.repeat(2 * 1024 * 1024) },
      { env: { OPENAI_API_KEY: 'nonsecret-refusal-fixture' } },
    ]) {
      await expect(
        adapter.client.run({
          agent: 'fixture',
          prompt: 'fixture',
          ...input,
        } as any),
      ).rejects.toThrow()
    }
    expect(adapter.observations).toHaveLength(0)
    for (const execute of [runTask, runBuffBench]) {
      await expect(
        (execute as any)({
          executionScope: 'key_free_environment',
          client: adapter.client,
          runAgentOnCommitImpl: async () => ({}),
        }),
      ).rejects.toThrow('execution overrides')
    }
  })

  test('replays live event prefixes before signal cancellation and removes owned roots', async () => {
    const adapter = createIsolatedEvaluationClient()
    const controller = new AbortController()
    let observed = 0
    await expect(
      adapter.client.run({
        agent: 'cancel-fixture',
        prompt: 'fixture',
        signal: controller.signal,
        agentDefinitions: [
          {
            id: 'cancel-fixture',
            displayName: 'cancel fixture',
            model: 'openai/gpt-4.1',
            toolNames: ['run_terminal_command'],
            handleSteps: `function* () { yield {toolName:'run_terminal_command',input:{command:'sleep 60',process_type:'SYNC'}} }`,
          },
        ],
        handleEvent: (event: any) => {
          observed++
          if (event.type === 'tool_call')
            controller.abort(new Error('fixture cancellation'))
        },
      } as any),
    ).rejects.toThrow('fixture cancellation')
    expect(observed).toBeGreaterThan(0)
    const evidence = adapter.observations[0]!
    expect(evidence.cancelled).toBe(true)
    expect(evidence.eventsReplayed).toBe(observed)
    expect((evidence.processCleanup as any).status).toBe('complete')
    expect((evidence.processCleanup as any).finalObservation.leader).toBe(
      'exited-reaped',
    )
    expect((evidence.outputCapture as any).complete).toBe(true)
    expect(fs.existsSync(String(evidence.cwd))).toBe(false)
    expect(fs.existsSync(String(evidence.home))).toBe(false)
    expect(() => process.kill(Number(evidence.pid), 0)).toThrow()
  }, 15_000)

  test('declines oversized event evidence and retains the complete preceding prefix', async () => {
    const adapter = createIsolatedEvaluationClient()
    const events: unknown[] = []
    await expect(
      adapter.client.run({
        agent: 'large-fixture',
        prompt: 'fixture',
        agentDefinitions: [
          {
            id: 'large-fixture',
            displayName: 'large fixture',
            model: 'openai/gpt-4.1',
            toolNames: ['set_output'],
            outputMode: 'structured_output',
            handleSteps: `function* () { yield {toolName:'set_output',input:{value:'x'.repeat(9*1024*1024)}} }`,
          },
        ],
        handleEvent: (event: any) => events.push(event),
      } as any),
    ).rejects.toThrow('8 MiB')
    expect(events.length).toBeGreaterThan(0)
    expect(Number(adapter.observations[0]?.eventBytes)).toBeLessThanOrEqual(
      8 * 1024 * 1024,
    )
  }, 15_000)
})
