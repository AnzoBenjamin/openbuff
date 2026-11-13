import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import z from 'zod/v4'

import { OpenbuffClient } from '../client'
import { getCustomToolDefinition } from '../custom-tool'
import type {
  AgentDefinition,
  ToolCall,
} from '@codebuff/common/templates/initial-agents-dir/types/agent-definition'

test('the actual SDK admits zero budgets and refuses dispatch before work', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'openbuff-zero-budget-'))
  const agent: AgentDefinition = {
    id: 'budget-fixture',
    displayName: 'Budget fixture',
    model: 'fixture-model',
    toolNames: [],
    handleSteps: function* () {
      throw new Error('zero-budget generator must not execute')
    },
  }
  try {
    const client = new OpenbuffClient({
      cwd: root,
      harnessStateDir: path.join(root, 'harness'),
      projectFiles: {},
      knowledgeFiles: {},
      handleEvent: () => {},
    })
    for (const options of [
      { maxAgentSteps: 0 },
      { agent: { ...agent, maxCostCents: 0 } },
    ]) {
      const result = await client.run({
        agent,
        prompt: 'fixed budget fixture',
        ...options,
      })
      expect(result.runOutcome?.termination).toBe(
        'maxAgentSteps' in options ? 'step_exhausted' : 'budget_exhausted',
      )
      expect(result.output.type).toBe('error')
      expect(result.actionOutcomes).toEqual([])
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('serialized programmatic custom tools reach the SDK and preserve rejection and cancellation', async () => {
  const root = mkdtempSync(
    path.join(tmpdir(), 'openbuff-programmatic-outcome-'),
  )
  const agent: AgentDefinition = {
    id: 'await-fixture',
    displayName: 'Await fixture',
    model: 'fixture-model',
    toolNames: ['fixture_await'],
    handleSteps: function* () {
      // Custom calls reach the runtime; their public generator typing is tracked by B28.
      yield { toolName: 'fixture_await', input: {} } as unknown as ToolCall
      throw new Error(
        'an unhandled rejected await must not resume the generator',
      )
    },
  }
  try {
    for (const cancel of [false, true]) {
      let calls = 0
      const controller = new AbortController()
      const client = new OpenbuffClient({
        cwd: root,
        harnessStateDir: path.join(root, `harness-${cancel}`),
        projectFiles: {},
        knowledgeFiles: {},
        handleEvent: () => {},
        customToolDefinitions: [
          getCustomToolDefinition({
            toolName: 'fixture_await',
            description: 'fixture',
            inputSchema: z.object({}),
            execute: async () => {
              calls++
              await Promise.resolve()
              if (cancel) controller.abort(new Error('fixture cancelled'))
              throw new Error('fixture rejected await')
            },
          }),
        ],
      })
      const result = await client.run({
        agent,
        prompt: 'fixed await fixture',
        signal: controller.signal,
      })
      expect(calls).toBe(1)
      expect(result.runOutcome?.termination).toBe(
        cancel ? 'cancelled' : 'failed',
      )
      expect(result.actionOutcomes).toHaveLength(1)
      expect(result.actionOutcomes?.[0]).toMatchObject({
        toolName: 'fixture_await',
        outcome: cancel ? 'cancelled' : 'failed',
      })
      if (result.output.type === 'error')
        expect(result.output.message).not.toContain('must not resume')
      else throw new Error('rejected await became successful output')
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
