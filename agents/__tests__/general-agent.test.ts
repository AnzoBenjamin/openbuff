import { describe, expect, test } from 'bun:test'

import { createGeneralAgent } from '../general-agent/general-agent'

describe('general-agent programmatic tools', () => {
  test('declares the hidden context-pruner tool used by handleSteps', () => {
    const agent = createGeneralAgent({ model: 'opus' })

    expect(agent.programmaticToolNames).toContain('spawn_agent_inline')
    expect(agent.spawnableAgents).toContain('context-pruner')
    expect(agent.toolNames).toContain('task_completed')
  })

  test('routes directory-like bootstrap paths through read_subtree', () => {
    const agent = createGeneralAgent({ model: 'opus' })
    const generator = agent.handleSteps!({
      prompt: 'Audit the server subsystem',
      params: {
        filePaths: ['server/src/services', 'server/src/worker.ts'],
        directoryPaths: ['server/src/integrations'],
      },
    } as any)

    expect(generator.next().value).toEqual({
      toolName: 'read_subtree',
      input: {
        paths: ['server/src/integrations', 'server/src/services'],
        maxTokens: 10_000,
      },
    })
    expect(generator.next({ toolResult: [] } as any).value).toEqual({
      toolName: 'read_files',
      input: { paths: ['server/src/worker.ts'] },
    })
  })

  test('routes ripgrep-style search through code-searcher with required params', () => {
    // general-agent is not granted code_search directly; its prompt must tell
    // it to spawn code-searcher and to pass the required params.searchQueries,
    // otherwise the runtime rejects the direct code_search call and an empty
    // code-searcher spawn fails with "Missing required: searchQueries".
    const agent = createGeneralAgent({ model: 'opus' })

    expect(agent.toolNames).not.toContain('code_search')
    expect(agent.instructionsPrompt).toContain('code_search')
    expect(agent.instructionsPrompt).toContain('not granted to you')
    expect(agent.instructionsPrompt).toContain('params.searchQueries')
  })

  test('binds durable audit shards to composable snapshot receipts', () => {
    const agent = createGeneralAgent({ model: 'opus' })
    const params = agent.inputSchema?.params?.properties

    expect(params).toHaveProperty('snapshotId')
    expect(agent.instructionsPrompt).toContain(
      'copy it into write_audit_findings.snapshotId',
    )
    expect(agent.instructionsPrompt).toContain('structuralReceipt')
  })

  test('rejects audit completion without a structural receipt', () => {
    const agent = createGeneralAgent({ model: 'opus' })
    const generator = agent.handleSteps!({
      prompt: 'Audit service completeness',
      params: {
        sessionSlug: 'readiness',
        shardId: 'services',
        snapshotId: 'snapshot-1',
      },
    } as any)

    expect(generator.next().value).toMatchObject({
      toolName: 'spawn_agent_inline',
    })
    expect(generator.next({ toolResult: [] } as any).value).toBe('STEP')
    const completionCheck = generator.next({
      stepsComplete: true,
      agentState: { messageHistory: [] },
      toolResult: [],
    } as any).value as any

    expect(completionCheck.toolName).toBe('add_message')
    expect(completionCheck.input.content).toContain(
      'Audit completion was rejected',
    )
  })

  test('breaks the audit loop once a matching structural receipt is present', () => {
    const agent = createGeneralAgent({ model: 'opus' })
    const generator = agent.handleSteps!({
      prompt: 'Audit service completeness',
      params: {
        sessionSlug: 'readiness',
        shardId: 'services',
        snapshotId: 'snapshot-1',
      },
    } as any)

    expect(generator.next().value).toMatchObject({
      toolName: 'spawn_agent_inline',
    })
    expect(generator.next({ toolResult: [] } as any).value).toBe('STEP')

    const completion = generator.next({
      stepsComplete: true,
      agentState: {
        messageHistory: [
          {
            role: 'tool',
            content: [
              {
                type: 'json',
                value: { structuralReceipt: { snapshot_id: 'snapshot-1' } },
              },
            ],
          },
        ],
      },
      toolResult: [],
    } as any)

    expect(completion.done).toBe(true)
    expect((completion.value as any)?.toolName).not.toBe('add_message')
  })

  test('breaks the audit loop after exhausting completion retries', () => {
    const agent = createGeneralAgent({ model: 'opus' })
    const generator = agent.handleSteps!({
      prompt: 'Audit service completeness',
      params: {
        sessionSlug: 'readiness',
        shardId: 'services',
        snapshotId: 'snapshot-1',
      },
    } as any)

    const noReceiptStep = {
      stepsComplete: true,
      agentState: { messageHistory: [] },
      toolResult: [],
    } as any

    // First completion step: rejected -> add_message (retries 0 -> 1).
    expect(generator.next().value).toMatchObject({
      toolName: 'spawn_agent_inline',
    })
    expect(generator.next({ toolResult: [] } as any).value).toBe('STEP')
    expect(generator.next(noReceiptStep).value).toMatchObject({
      toolName: 'add_message',
    })

    // Second completion step: rejected -> add_message (retries 1 -> 2).
    expect(generator.next().value).toMatchObject({
      toolName: 'spawn_agent_inline',
    })
    expect(generator.next({ toolResult: [] } as any).value).toBe('STEP')
    expect(generator.next(noReceiptStep).value).toMatchObject({
      toolName: 'add_message',
    })

    // Third completion step: retries exhausted -> break without add_message.
    expect(generator.next().value).toMatchObject({
      toolName: 'spawn_agent_inline',
    })
    expect(generator.next({ toolResult: [] } as any).value).toBe('STEP')
    const final = generator.next(noReceiptStep)
    expect(final.done).toBe(true)
    expect((final.value as any)?.toolName).not.toBe('add_message')
  })
})
