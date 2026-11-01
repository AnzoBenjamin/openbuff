import { describe, expect, it } from 'bun:test'
import { toolParams } from '@codebuff/common/tools/list'
import { convertJsonSchemaToZod } from 'zod-from-json-schema'
import z from 'zod/v4'
import { hasDecisionRationale } from '@codebuff/common/util/decision-rationale'
import { compactToolInputSchemaForProvider, getToolSet } from '../tools/prompts'

describe('provider tool input contracts', () => {
  it('preserves declared property names across every convertible built-in schema', () => {
    const skipped: string[] = []
    let checked = 0
    const verify = (original: unknown, compacted: unknown, path: string) => {
      if (!original || typeof original !== 'object' || Array.isArray(original))
        return
      if (
        !compacted ||
        typeof compacted !== 'object' ||
        Array.isArray(compacted)
      )
        return
      const source = original as Record<string, unknown>
      const target = compacted as Record<string, unknown>
      if (
        source.properties &&
        typeof source.properties === 'object' &&
        !Array.isArray(source.properties)
      ) {
        const sourceProperties = source.properties as Record<string, unknown>
        const targetProperties = target.properties as Record<string, unknown>
        expect(Object.keys(targetProperties ?? {}).sort(), path).toEqual(
          Object.keys(sourceProperties).sort(),
        )
        for (const key of Object.keys(sourceProperties)) {
          verify(sourceProperties[key], targetProperties[key], `${path}.${key}`)
        }
      }
      for (const key of [
        'items',
        'additionalProperties',
        'not',
        'if',
        'then',
        'else',
      ]) {
        if (source[key]) verify(source[key], target[key], `${path}.${key}`)
      }
      for (const key of ['anyOf', 'oneOf', 'allOf', 'prefixItems']) {
        if (Array.isArray(source[key]) && Array.isArray(target[key])) {
          source[key].forEach((item, index) =>
            verify(
              item,
              (target[key] as unknown[])[index],
              `${path}.${key}[${index}]`,
            ),
          )
        }
      }
    }
    for (const [name, definition] of Object.entries(toolParams)) {
      let original: unknown
      try {
        original = z.toJSONSchema(definition.inputSchema, { io: 'input' })
      } catch {
        skipped.push(name)
        continue
      }
      checked++
      verify(
        original,
        compactToolInputSchemaForProvider(definition.inputSchema).jsonSchema,
        name,
      )
    }
    expect(checked).toBeGreaterThan(50)
    expect(skipped).toEqual([])
  })

  it('preserves input properties that have the same names as schema annotations', () => {
    const input = z.object({
      title: z.string().describe('a title'),
      description: z.string().describe('a description'),
      default: z.boolean(),
      nested: z.object({
        examples: z.array(z.string()),
        errorMessage: z.string(),
      }),
    })
    const schema = compactToolInputSchemaForProvider(input)
      .jsonSchema as Record<string, unknown>
    const validator = convertJsonSchemaToZod(schema)
    const payload = {
      title: 'a finding',
      description: 'details',
      default: false,
      nested: { examples: ['example'], errorMessage: 'reason' },
    }
    const properties = schema.properties as Record<string, unknown>
    expect(Object.keys(properties)).toEqual([
      'title',
      'description',
      'default',
      'nested',
    ])
    expect(
      (properties.title as Record<string, unknown>).description,
    ).toBeUndefined()
    expect(validator.safeParse(payload).success).toBe(true)
    expect(validator.safeParse({ ...payload, title: undefined }).success).toBe(
      false,
    )
  })

  it('advertises and accepts the required title in an audit finding', async () => {
    const tools = await getToolSet({
      toolNames: ['write_audit_findings'],
      additionalToolDefinitions: async () => ({}),
      agentTools: {},
      skills: {},
    })
    const schema = (
      tools.write_audit_findings.inputSchema as unknown as {
        jsonSchema: Record<string, unknown>
      }
    ).jsonSchema
    const finding = {
      severity: 'HIGH',
      domain: 'correctness',
      path: 'src/a.ts',
      title: 'Missing validation',
      risk: 'Invalid inputs are accepted',
      fix: 'Validate the input',
      evidence: 'No check precedes the write',
    }
    const payload = {
      sessionSlug: 'audit',
      shardId: 'one',
      findings: [finding],
      coverage: { subsystemIds: [], featureIds: [], files: [] },
    }
    const findingSchema = (schema.properties as any).findings.items
    expect(findingSchema.required).toContain('title')
    expect(findingSchema.properties.title).toMatchObject({ type: 'string' })
    expect(
      toolParams.write_audit_findings.inputSchema.safeParse(payload).success,
    ).toBe(true)
    expect(convertJsonSchemaToZod(schema).safeParse(payload).success).toBe(true)
  })

  it('uses a record_decision example that satisfies its documented rationale rule', () => {
    const example =
      'Use Postgres for session storage because sessions must survive restarts'
    expect(toolParams.record_decision.description).toContain(example)
    expect(hasDecisionRationale(example)).toBe(true)
  })

  it('publishes both plan-update selector and action requirements', async () => {
    const tools = await getToolSet({
      toolNames: ['update_plan_status'],
      additionalToolDefinitions: async () => ({}),
      agentTools: {},
      skills: {},
    })
    const schema = (
      tools.update_plan_status.inputSchema as unknown as {
        jsonSchema: Record<string, unknown>
      }
    ).jsonSchema
    const providerValidator = convertJsonSchemaToZod(schema)
    const path = '.agents/sessions/example/PLAN.md'
    for (const input of [
      { path, updates: [{ taskId: 'P1', status: 'in_progress' }] },
      { path, updates: [{ task: 'example', completed: true }] },
      { path, currentTask: '' },
      { path, requestCommittedSurfaceReview: true },
    ]) {
      expect(
        toolParams.update_plan_status.inputSchema.safeParse(input).success,
      ).toBe(true)
      expect(providerValidator.safeParse(input).success).toBe(true)
    }
    for (const input of [
      { path },
      { path, updates: [] },
      { path, updates: [{ status: 'done' }] },
      { path, requestCommittedSurfaceReview: false },
    ]) {
      expect(
        toolParams.update_plan_status.inputSchema.safeParse(input).success,
      ).toBe(false)
      expect(providerValidator.safeParse(input).success).toBe(false)
    }
  })

  it.each([
    ['code_search', { pattern: 'authenticate', flags: ['-i', '-g', '*.ts'] }],
    ['go_to_definition', { path: 'src/a.ts', line: 1, character: 0 }],
    ['hover_type', { path: 'src/a.ts', line: 1, character: 0 }],
    ['find_references', { path: 'src/a.ts', line: 1, character: 0 }],
    ['workspace_symbol', { query: 'authenticate' }],
    ['get_affected_tests', { files: ['src/a.ts'] }],
    ['get_build_targets', { files: ['src/a.ts'] }],
    ['inspect_environment', {}],
    ['inspect_workspace', {}],
    ['get_change_review_bundle', { max_chars: 1000 }],
    [
      'run_targeted_validation',
      { snapshot_id: 'snapshot', files: ['src/a.ts'] },
    ],
    [
      'spawn_agents',
      { agents: [{ agent_type: 'basher', params: { command: 'pwd' } }] },
    ],
  ] as const)(
    'accepts a representative %s call at both schema boundaries',
    async (name, input) => {
      const tools = await getToolSet({
        toolNames: [name],
        additionalToolDefinitions: async () => ({}),
        agentTools: {},
        skills: {},
        spawnableAgentTypes: ['basher'],
      })
      const schema = (
        tools[name].inputSchema as unknown as {
          jsonSchema: Record<string, unknown>
        }
      ).jsonSchema
      expect(toolParams[name].inputSchema.safeParse(input).success).toBe(true)
      expect(convertJsonSchemaToZod(schema).safeParse(input).success).toBe(true)
    },
  )
  it.each([
    [
      'read_files',
      [{ paths: ['src/a.ts'] }, { windows: [{ path: 'src/a.ts' }] }],
    ],
    ['read_logs', [{ path: 'app.log' }, { jobId: 'job-1' }]],
    ['recall_context', [{ query: 'some context' }, { toolCallId: 'call-1' }]],
    [
      'query_index',
      [
        { query: 'authentication' },
        { mode: 'commands' },
        { mode: 'search', query: 'authentication' },
        { mode: 'explain', query: 'authentication' },
        { mode: 'neighbors', from: 'src/a.ts' },
        { mode: 'neighbors', query: 'authentication' },
        { mode: 'path', from: 'src/a.ts', to: 'src/b.ts' },
        { mode: 'path', query: 'authentication' },
        { mode: 'path', from: 'src/a.ts', query: 'authentication' },
        { mode: 'references', to: 'src/a.ts' },
        { mode: 'references', from: 'src/a.ts', to: 'src/b.ts' },
        { mode: 'references', query: 'authentication' },
      ],
    ],
  ] as const)(
    '%s rejects empty input and accepts supported forms',
    async (name, validInputs) => {
      const params = toolParams[name]
      const tools = await getToolSet({
        toolNames: [name],
        additionalToolDefinitions: async () => ({}),
        agentTools: {},
        skills: {},
      })
      const schema = (
        tools[name].inputSchema as unknown as {
          jsonSchema: Record<string, unknown>
        }
      ).jsonSchema
      const providerValidator = convertJsonSchemaToZod(
        schema as Record<string, unknown>,
      )
      expect(providerValidator.safeParse({}).success).toBe(false)
      for (const input of validInputs) {
        expect(params.inputSchema.safeParse(input).success).toBe(true)
        expect(providerValidator.safeParse(input).success).toBe(true)
      }
      if (name === 'read_files')
        expect(providerValidator.safeParse({ paths: [] }).success).toBe(false)
      if (name === 'query_index')
        expect(providerValidator.safeParse({ mode: 'search' }).success).toBe(
          false,
        )
    },
  )
})
