import { describe, expect, test } from 'bun:test'

import { createGeneralAgent } from '../general-agent/general-agent'

describe('general-agent programmatic tools', () => {
  test('declares the hidden context-pruner tool used by handleSteps', () => {
    const agent = createGeneralAgent({ model: 'opus' })

    expect(agent.programmaticToolNames).toContain('spawn_agent_inline')
    expect(agent.spawnableAgents).toContain('context-pruner')
    expect(agent.toolNames).toContain('task_completed')
  })

  test('gpt-5 branch adds reasoningOptions and drops file-picker from spawnableAgents', () => {
    const agent = createGeneralAgent({ model: 'gpt-5' })

    expect(agent.reasoningOptions).toEqual({ effort: 'high' })
    expect(agent.spawnableAgents).not.toContain('file-picker')
    expect(agent.displayName).toBe('Deep Reasoning General Agent')

    // The shared (opus) surface must remain intact so the two branches do not
    // silently converge or regress.
    expect(agent.spawnableAgents).toContain('researcher-web')
    expect(agent.spawnableAgents).toContain('context-pruner')
    expect(agent.programmaticToolNames).toContain('spawn_agent_inline')
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

  test('does not fire query_index proactively on a qualifying prompt with no paths', () => {
    const agent = createGeneralAgent({ model: 'opus' })
    const generator = agent.handleSteps!({
      prompt: 'Audit and fix the codebase for test coverage gaps',
      params: {},
    } as any)

    // Path-less prompts no longer auto-inject query_index; first yield is the
    // pruner/STEP path as appropriate when no paths are provided.
    expect(generator.next().value).toMatchObject({
      toolName: 'spawn_agent_inline',
      input: { agent_type: 'context-pruner' },
    })
  })

  test('calls code_search directly instead of delegating search', () => {
    // general-agent owns ripgrep-style content search itself: code_search is
    // granted directly and the code-searcher agent no longer exists, so
    // several patterns mean several code_search calls.
    const agent = createGeneralAgent({ model: 'opus' })

    expect(agent.toolNames).toContain('code_search')
    expect(agent.instructionsPrompt).toContain('code_search')
    expect(agent.instructionsPrompt).not.toContain('not granted to you')
    expect(agent.spawnableAgents).not.toContain('code-searcher')
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

    // The receipt gate passes, so the always-on harvest runs: a
    // structured_output agent must never leave the parent with value: null.
    expect(completion.done).toBe(false)
    expect(completion.value).toMatchObject({
      toolName: 'set_output',
      input: { harvestedFromFallback: true },
    })
    const afterHarvest = generator.next({ toolResult: [] } as any)
    expect(afterHarvest.done).toBe(true)
    expect((afterHarvest.value as any)?.toolName).not.toBe('add_message')
  })

  test('keeps rejecting when the present receipt is for a different snapshot', () => {
    const agent = createGeneralAgent({ model: 'opus' })
    const generator = agent.handleSteps!({
      prompt: 'Audit service completeness',
      params: {
        sessionSlug: 'readiness',
        shardId: 'services',
        snapshotId: 'snapshot-2',
      },
    } as any)

    expect(generator.next().value).toMatchObject({
      toolName: 'spawn_agent_inline',
    })
    expect(generator.next({ toolResult: [] } as any).value).toBe('STEP')

    const mismatchReceipt = generator.next({
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

    expect(mismatchReceipt.value).toMatchObject({
      toolName: 'add_message',
    })
  })

  test('unbound shard without snapshotId skips the audit gate even when a receipt exists', () => {
    const agent = createGeneralAgent({ model: 'opus' })
    const generator = agent.handleSteps!({
      prompt: 'Audit service completeness',
      params: {
        sessionSlug: 'readiness',
        shardId: 'services',
      },
    } as any)

    expect(generator.next().value).toMatchObject({
      toolName: 'spawn_agent_inline',
    })
    expect(generator.next({ toolResult: [] } as any).value).toBe('STEP')

    const unbound = generator.next({
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

    expect(unbound.value).toMatchObject({
      toolName: 'set_output',
      input: { harvestedFromFallback: true },
    })
    expect(generator.next({ toolResult: [] } as any).done).toBe(true)
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

    // Second completion step: pruner suppressed after first run, so next yield is STEP directly.
    expect(generator.next({ toolResult: [] } as any).value).toBe('STEP')
    expect(generator.next(noReceiptStep).value).toMatchObject({
      toolName: 'add_message',
    })

    // Third completion step: retries exhausted -> harvest fallback, then break
    // without add_message.
    expect(generator.next({ toolResult: [] } as any).value).toBe('STEP')
    const final = generator.next(noReceiptStep)
    expect(final.value).toMatchObject({
      toolName: 'set_output',
      input: { harvestedFromFallback: true },
    })
    const afterFinalHarvest = generator.next({ toolResult: [] } as any)
    expect(afterFinalHarvest.done).toBe(true)
    expect((afterFinalHarvest.value as any)?.toolName).not.toBe('add_message')
  })

  test('grants the path-discovery and structured-output tools it names', () => {
    const agent = createGeneralAgent({ model: 'opus' })

    expect(agent.toolNames).toContain('glob')
    expect(agent.toolNames).toContain('list_directory')
    expect(agent.toolNames).toContain('read_outline')
    expect(agent.toolNames).toContain('set_output')
  })

  test('reports through structured output instead of a truncated last message', () => {
    const agent = createGeneralAgent({ model: 'opus' })

    expect(agent.outputMode).toBe('structured_output')
    expect(agent.outputSchema?.required).toContain('summary')
    // The runtime harvest flag must be declared or set_output would reject it.
    expect(agent.outputSchema?.properties).toHaveProperty(
      'harvestedFromFallback',
    )
    expect(agent.instructionsPrompt).toContain('set_output')
  })

  test('persists audit findings even when snapshotId is absent', () => {
    const agent = createGeneralAgent({ model: 'opus' })
    const snapshotIdParam = JSON.stringify(
      agent.inputSchema?.params?.properties?.snapshotId,
    )

    expect(agent.instructionsPrompt).toContain(
      'with or without params.snapshotId',
    )
    expect(agent.instructionsPrompt).toContain('still write the artifact')
    expect(agent.instructionsPrompt).toContain('carries no structuralReceipt')
    // Only the snapshot-bound receipt claim is conditional now; the artifact
    // itself is never skipped.
    expect(agent.instructionsPrompt).not.toContain(
      'do not call write_audit_findings',
    )
    expect(snapshotIdParam).not.toContain('fail closed')
  })

  test('harvests a text-only final answer into set_output', () => {
    const agent = createGeneralAgent({ model: 'opus' })
    const generator = agent.handleSteps!({
      prompt: 'Explain how the runtime bounds child output',
      params: {},
    } as any)

    expect(generator.next().value).toMatchObject({
      toolName: 'spawn_agent_inline',
    })
    expect(generator.next({ toolResult: [] } as any).value).toBe('STEP')

    const harvest = generator.next({
      stepsComplete: true,
      agentState: {
        output: undefined,
        messageHistory: [
          {
            role: 'assistant',
            content: [
              { type: 'text', text: '<think>hidden</think>Final answer.' },
            ],
          },
        ],
      },
      toolResult: [],
    } as any)

    expect(harvest.done).toBe(false)
    expect(harvest.value).toEqual({
      toolName: 'set_output',
      input: { summary: 'Final answer.', harvestedFromFallback: true },
      includeToolCall: false,
    })
    expect(generator.next({ toolResult: [] } as any).done).toBe(true)
  })

  test('harvests a text-only answer on the step-cap exit too', () => {
    const agent = createGeneralAgent({ model: 'opus' })
    const generator = agent.handleSteps!({
      prompt: 'Explain how the runtime bounds child output',
      params: {},
    } as any)

    expect(generator.next().value).toMatchObject({
      toolName: 'spawn_agent_inline',
    })
    expect(generator.next({ toolResult: [] } as any).value).toBe('STEP')

    const harvest = generator.next({
      stepsComplete: false,
      hitStepCap: true,
      agentState: {
        output: undefined,
        messageHistory: [
          {
            role: 'assistant',
            content: [{ type: 'text', text: 'Partial answer at the cap.' }],
          },
        ],
      },
      toolResult: [],
    } as any)

    expect(harvest.value).toEqual({
      toolName: 'set_output',
      input: {
        summary: 'Partial answer at the cap.',
        harvestedFromFallback: true,
      },
      includeToolCall: false,
    })
    expect(generator.next({ toolResult: [] } as any).done).toBe(true)
  })

  test('does not harvest when the agent already produced structured output', () => {
    const agent = createGeneralAgent({ model: 'opus' })
    const generator = agent.handleSteps!({
      prompt: 'Explain how the runtime bounds child output',
      params: {},
    } as any)

    expect(generator.next().value).toMatchObject({
      toolName: 'spawn_agent_inline',
    })
    expect(generator.next({ toolResult: [] } as any).value).toBe('STEP')

    // An explicit set_output must never be clobbered by the fallback.
    const completion = generator.next({
      stepsComplete: true,
      agentState: {
        output: { summary: 'Explicit answer.' },
        messageHistory: [
          {
            role: 'assistant',
            content: [{ type: 'text', text: 'Stale prose.' }],
          },
        ],
      },
      toolResult: [],
    } as any)

    expect(completion.done).toBe(true)
    expect((completion.value as any)?.toolName).toBeUndefined()
  })

  test('harvests the whole contiguous trailing assistant turn', () => {
    const agent = createGeneralAgent({ model: 'opus' })
    const generator = agent.handleSteps!({
      prompt: 'Explain how the runtime bounds child output',
      params: {},
    } as any)

    expect(generator.next().value).toMatchObject({
      toolName: 'spawn_agent_inline',
    })
    expect(generator.next({ toolResult: [] } as any).value).toBe('STEP')

    const harvest = generator.next({
      stepsComplete: true,
      agentState: {
        output: undefined,
        messageHistory: [
          {
            role: 'assistant',
            content: [
              { type: 'text', text: 'An earlier turn, must be excluded.' },
            ],
          },
          { role: 'user', content: [{ type: 'text', text: 'Continue.' }] },
          {
            role: 'assistant',
            content: [{ type: 'text', text: 'First half of the answer.' }],
          },
          // Plain-string content must be harvested alongside text parts.
          { role: 'assistant', content: 'Second half of the answer.' },
        ],
      },
      toolResult: [],
    } as any)

    // Mirrors getLastAssistantTurnMessages: the whole contiguous trailing
    // assistant run, oldest-first, and nothing from before the user message.
    expect(harvest.value).toEqual({
      toolName: 'set_output',
      input: {
        summary: 'First half of the answer.\nSecond half of the answer.',
        harvestedFromFallback: true,
      },
      includeToolCall: false,
    })
    expect(generator.next({ toolResult: [] } as any).done).toBe(true)
  })

  test('never harvests a runtime terminal notice as the answer', () => {
    const agent = createGeneralAgent({ model: 'opus' })
    const generator = agent.handleSteps!({
      prompt: 'Explain how the runtime bounds child output',
      params: {},
    } as any)

    expect(generator.next().value).toMatchObject({
      toolName: 'spawn_agent_inline',
    })
    expect(generator.next({ toolResult: [] } as any).value).toBe('STEP')

    // run-agent-step appends the STEP_CAP_REACHED notice as the last assistant
    // message before returning hitStepCap, so it would otherwise be reported as
    // the model's answer.
    const harvest = generator.next({
      stepsComplete: false,
      hitStepCap: true,
      agentState: {
        output: undefined,
        messageHistory: [
          {
            role: 'assistant',
            content: [{ type: 'text', text: 'Partial answer at the cap.' }],
          },
          {
            role: 'assistant',
            content: [{ type: 'text', text: 'A tool call failed.' }],
            tags: ['TOOL_CALL_ERROR'],
          },
          {
            role: 'assistant',
            content: [
              { type: 'text', text: 'Maximum number of steps reached.' },
            ],
            tags: ['STEP_CAP_REACHED'],
          },
        ],
      },
      toolResult: [],
    } as any)

    expect(harvest.value).toEqual({
      toolName: 'set_output',
      input: {
        summary: 'Partial answer at the cap.',
        harvestedFromFallback: true,
      },
      includeToolCall: false,
    })
    expect(generator.next({ toolResult: [] } as any).done).toBe(true)
  })

  test('emits set_output with a non-empty summary when the harvest is empty', () => {
    const agent = createGeneralAgent({ model: 'opus' })
    const generator = agent.handleSteps!({
      prompt: 'Explain how the runtime bounds child output',
      params: {},
    } as any)

    expect(generator.next().value).toMatchObject({
      toolName: 'spawn_agent_inline',
    })
    expect(generator.next({ toolResult: [] } as any).value).toBe('STEP')

    // A trailing assistant turn with no text part must still reach the parent
    // as structured output rather than as value: null.
    const harvest = generator.next({
      stepsComplete: true,
      agentState: {
        output: undefined,
        messageHistory: [
          {
            role: 'assistant',
            content: [{ type: 'tool-call', toolName: 'read_files', input: {} }],
          },
        ],
      },
      toolResult: [],
    } as any)

    expect(harvest.done).toBe(false)
    const harvestInput = (harvest.value as any).input
    expect((harvest.value as any).toolName).toBe('set_output')
    expect(harvestInput.harvestedFromFallback).toBe(true)
    expect(typeof harvestInput.summary).toBe('string')
    expect(harvestInput.summary.length).toBeGreaterThan(0)
    expect(harvestInput.summary).toContain('No answer text was produced')
    // The placeholder is not an answer: this marker is what keeps the parent's
    // receipt a retryable partial instead of completed with zero errors.
    expect(harvestInput.noHarvestedAnswer).toBe(true)
    expect(generator.next({ toolResult: [] } as any).done).toBe(true)
  })

  test('emits set_output at the step cap even when only a runtime notice remains', () => {
    const agent = createGeneralAgent({ model: 'opus' })
    const generator = agent.handleSteps!({
      prompt: 'Explain how the runtime bounds child output',
      params: {},
    } as any)

    expect(generator.next().value).toMatchObject({
      toolName: 'spawn_agent_inline',
    })
    expect(generator.next({ toolResult: [] } as any).value).toBe('STEP')

    const harvest = generator.next({
      stepsComplete: false,
      hitStepCap: true,
      agentState: {
        output: undefined,
        messageHistory: [
          {
            role: 'assistant',
            content: [
              { type: 'text', text: 'Maximum number of steps reached.' },
            ],
            tags: ['STEP_CAP_REACHED'],
          },
        ],
      },
      toolResult: [],
    } as any)

    const harvestInput = (harvest.value as any).input
    expect((harvest.value as any).toolName).toBe('set_output')
    expect(harvestInput.harvestedFromFallback).toBe(true)
    expect(harvestInput.summary).toContain('No answer text was produced')
    expect(harvestInput.summary).toContain('step cap')
    // A step-capped run recovered no answer, so the marker must travel with it.
    expect(harvestInput.noHarvestedAnswer).toBe(true)
    expect(generator.next({ toolResult: [] } as any).done).toBe(true)
  })

  test('treats an already-existing audit artifact as an idempotent success', () => {
    const agent = createGeneralAgent({ model: 'opus' })

    // write_audit_findings only reports a collision as already persisted when
    // the artifact on disk is BYTE-IDENTICAL to this call's rendered findings.
    // In that one case the receipt gate is already satisfied by the marker, so
    // a suffixed-shard retry would persist a duplicate for a shard whose
    // findings are already on disk.
    expect(agent.instructionsPrompt).toContain('byte-identical')
    expect(agent.instructionsPrompt).toContain(
      'treat it as an idempotent success',
    )
    expect(agent.instructionsPrompt).toContain(
      'do NOT write a second artifact under a suffixed shard id',
    )
    // A collision whose contents are NOT this call's findings persists nothing,
    // so the recovery is a distinct shard id, not an idempotent success.
    expect(agent.instructionsPrompt).toContain("are not this call's findings")
    expect(agent.instructionsPrompt).toContain(
      'persist these findings under a distinct shard id to obtain a composable coverage receipt',
    )
    // The old text told the shard that any collision cleared the gate and that
    // a distinct shard id was only for an intentionally different artifact.
    expect(agent.instructionsPrompt).not.toContain(
      'satisfies the coverage gate',
    )
    expect(agent.instructionsPrompt).not.toContain(
      'intentionally writing an additional, different artifact',
    )
    expect(agent.instructionsPrompt).not.toContain(
      'retry once with a suffixed shard id',
    )
    expect(agent.instructionsPrompt).not.toContain('<shardId>-2')
  })

  test('breaks the audit loop on an already-persisted collision result', () => {
    const agent = createGeneralAgent({ model: 'opus' })
    const artifactPath = '.agents/sessions/readiness/findings/services.md'
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

    // The artifact is created exclusively, so this rejection means the shard's
    // findings are already durably on disk. There is no structuralReceipt in
    // this history, so without the snapshot-bound already-persisted marker the
    // gate would burn both retries and exit partial.
    const completion = generator.next({
      stepsComplete: true,
      agentState: {
        messageHistory: [
          {
            role: 'tool',
            content: [
              {
                type: 'json',
                value: {
                  artifactPath,
                  errorMessage: `Failed to create file: the file already exists. Shard id "services": this shard's findings are already persisted at ${artifactPath}; treat this as already written and do not write a duplicate.`,
                  alreadyPersisted: {
                    schema_version: 1,
                    shardId: 'services',
                    artifactPath,
                    snapshot_id: 'snapshot-1',
                  },
                },
              },
            ],
          },
        ],
      },
      toolResult: [],
    } as any)

    // No add_message retry: the gate cleared, so the only remaining yield is
    // the always-on harvest.
    expect(completion.value).toMatchObject({
      toolName: 'set_output',
      input: { harvestedFromFallback: true },
    })
    const afterHarvest = generator.next({ toolResult: [] } as any)
    expect(afterHarvest.done).toBe(true)
    expect((afterHarvest.value as any)?.toolName).not.toBe('add_message')
  })

  test('keeps rejecting an already-persisted marker for a different snapshot', () => {
    const agent = createGeneralAgent({ model: 'opus' })
    const generator = agent.handleSteps!({
      prompt: 'Audit service completeness',
      params: {
        sessionSlug: 'readiness',
        shardId: 'services',
        snapshotId: 'snapshot-2',
      },
    } as any)

    expect(generator.next().value).toMatchObject({
      toolName: 'spawn_agent_inline',
    })
    expect(generator.next({ toolResult: [] } as any).value).toBe('STEP')

    // The snapshot binding is what stops a colliding write from claiming
    // coverage for a snapshot it never evaluated.
    const mismatch = generator.next({
      stepsComplete: true,
      agentState: {
        messageHistory: [
          {
            role: 'tool',
            content: [
              {
                type: 'json',
                value: {
                  artifactPath:
                    '.agents/sessions/readiness/findings/services.md',
                  errorMessage: 'the file already exists',
                  alreadyPersisted: {
                    schema_version: 1,
                    shardId: 'services',
                    artifactPath:
                      '.agents/sessions/readiness/findings/services.md',
                    snapshot_id: 'snapshot-1',
                  },
                },
              },
            ],
          },
        ],
      },
      toolResult: [],
    } as any)

    expect(mismatch.value).toMatchObject({ toolName: 'add_message' })
  })

  test('harvests over an error-only output and preserves the recorded error', () => {
    const agent = createGeneralAgent({ model: 'opus' })
    const generator = agent.handleSteps!({
      prompt: 'Explain how the runtime bounds child output',
      params: {},
    } as any)

    expect(generator.next().value).toMatchObject({
      toolName: 'spawn_agent_inline',
    })
    expect(generator.next({ toolResult: [] } as any).value).toBe('STEP')

    // run-programmatic-step's failure path stamps
    // `agentState.output = { ...output, error }`, so the output is defined but
    // carries no summary. structured_output requires summary, so the parent
    // would otherwise receive a summary-less object and no harvested text.
    const harvest = generator.next({
      stepsComplete: true,
      agentState: {
        output: {
          error:
            'Error executing handleSteps for agent general-agent: read_files failed',
        },
        messageHistory: [
          {
            role: 'assistant',
            content: [{ type: 'text', text: 'Partial answer before failure.' }],
          },
        ],
      },
      toolResult: [],
    } as any)

    expect(harvest.done).toBe(false)
    expect(harvest.value).toEqual({
      toolName: 'set_output',
      input: {
        summary: 'Partial answer before failure.',
        harvestedFromFallback: true,
        error:
          'Error executing handleSteps for agent general-agent: read_files failed',
      },
      includeToolCall: false,
    })
    expect(generator.next({ toolResult: [] } as any).done).toBe(true)
  })

  test('harvests over an error-only output on the step-cap exit too', () => {
    const agent = createGeneralAgent({ model: 'opus' })
    const generator = agent.handleSteps!({
      prompt: 'Explain how the runtime bounds child output',
      params: {},
    } as any)

    expect(generator.next().value).toMatchObject({
      toolName: 'spawn_agent_inline',
    })
    expect(generator.next({ toolResult: [] } as any).value).toBe('STEP')

    const harvest = generator.next({
      stepsComplete: false,
      hitStepCap: true,
      agentState: {
        output: {
          error: 'Error executing handleSteps for agent general-agent: boom',
        },
        messageHistory: [
          {
            role: 'assistant',
            content: [{ type: 'text', text: 'Partial answer at the cap.' }],
          },
        ],
      },
      toolResult: [],
    } as any)

    expect(harvest.value).toEqual({
      toolName: 'set_output',
      input: {
        summary: 'Partial answer at the cap.',
        harvestedFromFallback: true,
        error: 'Error executing handleSteps for agent general-agent: boom',
      },
      includeToolCall: false,
    })
    expect(generator.next({ toolResult: [] } as any).done).toBe(true)
  })

  test('harvests when the output object has a blank or non-string summary', () => {
    const agent = createGeneralAgent({ model: 'opus' })

    // Only a non-empty string summary is a real answer; a blank or wrong-typed
    // one would reach the parent as no answer at all.
    for (const output of [
      { summary: '   ' },
      { summary: 42 },
      { artifacts: ['a.md'] },
      'not an object',
    ]) {
      const generator = agent.handleSteps!({
        prompt: 'Explain how the runtime bounds child output',
        params: {},
      } as any)
      expect(generator.next().value).toMatchObject({
        toolName: 'spawn_agent_inline',
      })
      expect(generator.next({ toolResult: [] } as any).value).toBe('STEP')

      const harvest = generator.next({
        stepsComplete: true,
        agentState: {
          output,
          messageHistory: [
            {
              role: 'assistant',
              content: [{ type: 'text', text: 'Recovered answer.' }],
            },
          ],
        },
        toolResult: [],
      } as any)

      expect(harvest.value).toEqual({
        toolName: 'set_output',
        input: {
          summary: 'Recovered answer.',
          harvestedFromFallback: true,
        },
        includeToolCall: false,
      })
      expect(generator.next({ toolResult: [] } as any).done).toBe(true)
    }
  })

  test('declares the harvest error field so set_output accepts it', () => {
    const agent = createGeneralAgent({ model: 'opus' })

    // The harvest emits `error` alongside `summary`, so it must be declared
    // exactly like harvestedFromFallback or set_output would reject the value.
    expect(agent.outputSchema?.properties).toHaveProperty('error')
    expect(agent.outputSchema?.properties?.error).toMatchObject({
      type: 'string',
    })
    expect(agent.outputSchema?.required).not.toContain('error')
  })

  test('declares the no-answer marker and omits it from a real-text harvest', () => {
    const agent = createGeneralAgent({ model: 'opus' })

    // The empty-harvest exits emit `noHarvestedAnswer`, so it must be declared
    // exactly like harvestedFromFallback or set_output would reject the value.
    expect(agent.outputSchema?.properties).toHaveProperty('noHarvestedAnswer')
    expect(agent.outputSchema?.properties?.noHarvestedAnswer).toMatchObject({
      type: 'boolean',
    })
    expect(agent.outputSchema?.required).not.toContain('noHarvestedAnswer')

    // A harvest that recovered real answer text is a genuine completion, so it
    // must NOT carry the marker — that absence is what keeps the runtime
    // crediting it instead of emitting the retryable task_completed error.
    const generator = agent.handleSteps!({
      prompt: 'Explain how the runtime bounds child output',
      params: {},
    } as any)

    expect(generator.next().value).toMatchObject({
      toolName: 'spawn_agent_inline',
    })
    expect(generator.next({ toolResult: [] } as any).value).toBe('STEP')

    const harvest = generator.next({
      stepsComplete: true,
      agentState: {
        output: undefined,
        messageHistory: [
          {
            role: 'assistant',
            content: [{ type: 'text', text: 'Recovered real answer.' }],
          },
        ],
      },
      toolResult: [],
    } as any)

    expect((harvest.value as any).input).toEqual({
      summary: 'Recovered real answer.',
      harvestedFromFallback: true,
    })
    expect(generator.next({ toolResult: [] } as any).done).toBe(true)
  })
})
