import { describe, expect, test } from 'bun:test'
import { jsonSchemaToZod } from '@codebuff/common/util/json-schema'
import { isPlanModeRefusedTool } from '@codebuff/common/tools/plan-mode-policy'
import retriever from './knowledge-retriever'
import reviewer from './knowledge-reviewer'
import manager from './memory-manager'
import { createBase2 } from '../base2/base2'

const retrieval = {
  schemaVersion: 1,
  status: 'complete',
  scope: ['knowledge.md'],
  summary: 'One scoped claim.',
  records: [
    {
      id: 'K1',
      statement: 'Use Bun for package commands.',
      sourceKind: 'knowledge-file',
      canonicalCategory: 'none',
      evidence: [
        { kind: 'file', locator: 'knowledge.md', startLine: 1, endLine: 2 },
      ],
      caveats: [],
    },
  ],
  omissions: [],
}
const review = {
  schemaVersion: 1,
  status: 'complete',
  checkedScopes: ['knowledge.md'],
  summary: 'The claim is supported by package scripts.',
  findings: [
    {
      id: 'F1',
      claimId: 'K1',
      status: 'supported',
      detail: 'Current package scripts invoke Bun.',
      evidence: [
        { kind: 'file', locator: 'package.json', startLine: 1, endLine: 10 },
      ],
    },
  ],
  proposals: [
    {
      id: 'P1',
      action: 'retain',
      target: 'knowledge.md',
      reason: 'Still accurate.',
      evidence: [{ kind: 'file', locator: 'package.json' }],
    },
  ],
  omissions: [],
}
const child = (id: string, value: unknown, termination = 'completed') => ({
  toolResult: [
    {
      type: 'json',
      value: [
        {
          agentType: id,
          value: { type: 'structuredOutput', value },
          runOutcome: { termination },
          taskAcceptance: { status: 'unknown' },
        },
      ],
    },
  ],
})
function generator() {
  const source = manager.handleSteps!.toString()
  const fn = new Function(`return (${source})`)() as typeof manager.handleSteps
  return fn!({
    agentState: {} as never,
    prompt: 'Check the knowledge for this task',
    params: { paths: ['knowledge.md'] },
    logger: {} as never,
  })
}

describe('read-only memory-management agents', () => {
  const allowed = new Set([
    'read_files',
    'read_outline',
    'read_subtree',
    'query_index',
    'code_search',
    'glob',
    'list_directory',
    'inspect_workspace',
    'get_task',
    'recall_context',
    'spawn_agents',
    'set_output',
  ])
  for (const agent of [retriever, reviewer, manager]) {
    test(`${agent.id} has a usable schema and no source/canonical mutation tools`, () => {
      expect(agent.outputMode).toBe('structured_output')
      expect(agent.includeMessageHistory).toBe(false)
      expect(agent.model).toBeUndefined()
      expect(agent).not.toHaveProperty('maxSteps')
      for (const tool of [
        ...(agent.toolNames ?? []),
        ...(agent.programmaticToolNames ?? []),
      ]) {
        expect(allowed.has(tool), tool).toBe(true)
        expect(isPlanModeRefusedTool(tool)).toBe(false)
        expect(
          [
            'record_decision',
            'write_audit_findings',
            'run_terminal_command',
            'browser_logs',
            'kill_job',
          ].includes(tool),
        ).toBe(false)
      }
      expect(agent.filesystemScope?.write).toEqual([])
      expect(agent.programmaticConfig?.strictProjectReads).toBe(true)
      for (const unsupported of [
        'query_index',
        'code_search',
        'read_subtree',
        'inspect_workspace',
        'get_task',
        'recall_context',
      ])
        expect(agent.toolNames).not.toContain(unsupported)
      expect(() => jsonSchemaToZod(agent.outputSchema)).not.toThrow()
    })
  }
  test('all root modes can discover the read-only roles', () => {
    for (const definition of [
      createBase2('default'),
      createBase2('fast'),
      createBase2('default', { planOnly: true }),
      createBase2('default', { executePlan: true }),
    ]) {
      for (const agent of [retriever, reviewer, manager])
        expect(definition.spawnableAgents).toContain(agent.id)
    }
  })
  test('the leaf roles cannot spawn a writer and the manager has an exact read-only ceiling', () => {
    expect(retriever.spawnableAgents ?? []).toEqual([])
    expect(reviewer.spawnableAgents ?? []).toEqual([])
    expect(manager.spawnableAgents).toEqual([
      'knowledge-retriever',
      'knowledge-reviewer',
    ])
    expect(manager.toolNames).toEqual(['spawn_agents', 'set_output'])
  })
  test('reports are untrusted suggestions, not a forged verification or application receipt', () => {
    expect(
      jsonSchemaToZod(retriever.outputSchema).safeParse(retrieval).success,
    ).toBe(true)
    expect(
      jsonSchemaToZod(reviewer.outputSchema).safeParse(review).success,
    ).toBe(true)
    expect(
      jsonSchemaToZod(reviewer.outputSchema).safeParse({
        ...review,
        verified: true,
      }).success,
    ).toBe(false)
    expect(
      jsonSchemaToZod(reviewer.outputSchema).safeParse({
        ...review,
        findings: [{ ...review.findings[0], status: 'verified' }],
      }).success,
    ).toBe(false)
  })
  test('unsafe targets, uncited verification and false completeness are rejected', () => {
    const retrievalSchema = jsonSchemaToZod(retriever.outputSchema)
    const reviewSchema = jsonSchemaToZod(reviewer.outputSchema)
    expect(
      retrievalSchema.safeParse({
        ...retrieval,
        records: [
          { ...retrieval.records[0], canonicalCategory: 'verifiedKnowledge' },
        ],
      }).success,
    ).toBe(false)
    expect(
      retrievalSchema.safeParse({
        ...retrieval,
        omissions: [{ scope: 'memory', reason: 'Not available' }],
      }).success,
    ).toBe(false)
    expect(
      reviewSchema.safeParse({
        ...review,
        findings: [{ ...review.findings[0], evidence: [] }],
      }).success,
    ).toBe(false)
    for (const target of [
      '/etc/shadow',
      '../outside.md',
      'a/../outside.md',
      'C:\\private\\secret',
      '\\\\server\\share\\secret',
    ]) {
      expect(
        reviewSchema.safeParse({
          ...review,
          proposals: [{ ...review.proposals[0], target }],
        }).success,
        target,
      ).toBe(false)
    }
  })

  test('reviewed schema gaps reject multiline traversal and blank host references', () => {
    const readSchema = jsonSchemaToZod(retriever.outputSchema)
    const reviewSchema = jsonSchemaToZod(reviewer.outputSchema)
    for (const refs of [[''], ['  '], ['\t\n']]) {
      expect(
        readSchema.safeParse({
          ...retrieval,
          records: [
            {
              ...retrieval.records[0],
              canonicalCategory: 'verifiedKnowledge',
              hostEvidenceRefs: refs,
            },
          ],
        }).success,
      ).toBe(false)
    }
    for (const target of [
      'dir\n/../../outside.md',
      'dir\r/../../outside.md',
      'dir\u2028/../../outside.md',
    ]) {
      expect(
        reviewSchema.safeParse({
          ...review,
          proposals: [{ ...review.proposals[0], target }],
        }).success,
      ).toBe(false)
    }
  })

  test('serialized manager always retrieves before review and only publishes joined suggestions', () => {
    const run = generator()
    const first = run.next().value as {
      toolName: string
      input: { agents: Array<{ agent_type: string }> }
    }
    expect(first.toolName).toBe('spawn_agents')
    expect(first.input.agents.map((agent) => agent.agent_type)).toEqual([
      'knowledge-retriever',
    ])
    const second = run.next(child('knowledge-retriever', retrieval) as never)
      .value as {
      toolName: string
      input: {
        agents: Array<{ agent_type: string; params: Record<string, unknown> }>
      }
    }
    expect(second.input.agents.map((agent) => agent.agent_type)).toEqual([
      'knowledge-reviewer',
    ])
    expect(second.input.agents[0].params.retrieval).toEqual(retrieval)
    const final = run.next(child('knowledge-reviewer', review) as never)
      .value as { toolName: string; input: Record<string, unknown> }
    expect(final.toolName).toBe('set_output')
    expect(final.input).toMatchObject({
      status: 'complete',
      requiresUserApproval: true,
      applied: false,
      untrustedSuggestions: true,
      proposals: review.proposals,
    })
    expect(
      jsonSchemaToZod(manager.outputSchema).safeParse(final.input).success,
    ).toBe(true)
    expect(
      jsonSchemaToZod(manager.outputSchema).safeParse({
        ...final.input,
        applied: true,
      }).success,
    ).toBe(false)
    expect(
      jsonSchemaToZod(manager.outputSchema).safeParse({
        ...final.input,
        requiresUserApproval: false,
      }).success,
    ).toBe(false)
    expect(run.next().done).toBe(true)
  })
  for (const failure of ['failed', 'cancelled', 'step_exhausted'])
    test(`a ${failure} child cannot turn its complete prose into success`, () => {
      const run = generator()
      run.next()
      const final = run.next(
        child('knowledge-retriever', retrieval, failure) as never,
      ).value as { toolName: string; input: Record<string, unknown> }
      expect(final.toolName).toBe('set_output')
      expect(final.input.status).toBe('unavailable')
      expect(final.input.proposals).toEqual([])
      expect(JSON.stringify(final.input.retrieval)).toContain(failure)
    })
  test('nested failure causes and rejected review acceptance remain visible and bounded', () => {
    const run = generator()
    run.next()
    run.next(child('knowledge-retriever', retrieval) as never)
    const response = {
      toolResult: [
        {
          type: 'json',
          value: [
            {
              agentType: 'knowledge-reviewer',
              value: { type: 'structuredOutput', value: review },
              agentReceipt: {
                runOutcome: {
                  termination: 'failed',
                  cause: { code: 'review_failure', message: 'x'.repeat(6000) },
                },
                taskAcceptance: { status: 'unknown' },
              },
            },
          ],
        },
      ],
    }
    const final = run.next(response as never).value as unknown as {
      input: {
        status: string
        review: { omissions: Array<{ reason: string }> }
        proposals: unknown[]
      }
    }
    expect(final.input.status).toBe('partial')
    expect(final.input.proposals).toEqual([])
    expect(final.input.review.omissions[0].reason).toContain('review_failure')
    expect(final.input.review.omissions[0].reason.length).toBeLessThanOrEqual(
      1900,
    )
    const rejectedRun = generator()
    rejectedRun.next()
    rejectedRun.next(child('knowledge-retriever', retrieval) as never)
    const rejected = child('knowledge-reviewer', review)
    rejected.toolResult[0].value[0].taskAcceptance = { status: 'rejected' }
    const rejectedFinal = rejectedRun.next(rejected as never)
      .value as unknown as {
      input: {
        review: { omissions: Array<{ reason: string }> }
        proposals: unknown[]
      }
    }
    expect(rejectedFinal.input.proposals).toEqual([])
    expect(rejectedFinal.input.review.omissions[0].reason).toContain('rejected')
  })

  test('partial retrieval stays partial even after a complete review', () => {
    const run = generator()
    run.next()
    run.next(
      child('knowledge-retriever', {
        ...retrieval,
        status: 'partial',
        omissions: [{ scope: 'code-map', reason: 'Unavailable index' }],
      }) as never,
    )
    const final = run.next(child('knowledge-reviewer', review) as never)
      .value as { input: Record<string, unknown> }
    expect(final.input.status).toBe('partial')
  })
  test('missing or wrong-child output is not fabricated into a complete report', () => {
    for (const result of [undefined, child('editor', retrieval)]) {
      const run = generator()
      run.next()
      const final = run.next(result as never).value as {
        input: Record<string, unknown>
      }
      expect(final.input.status).toBe('unavailable')
      expect(final.input.proposals).toEqual([])
    }
  })
})
