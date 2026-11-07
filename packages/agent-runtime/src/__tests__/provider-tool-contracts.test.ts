import { describe, expect, it } from 'bun:test'
import { toolParams } from '@codebuff/common/tools/list'
import {
  compileToolJsonSchemas,
  resolveToolParameterSchema,
} from '@codebuff/common/tools/compile-tool-definitions'
import { convertJsonSchemaToZod } from 'zod-from-json-schema'
import z from 'zod/v4'
import { hasDecisionRationale } from '@codebuff/common/util/decision-rationale'
import { compactToolInputSchemaForProvider, getToolSet } from '../tools/prompts'

describe('provider tool input contracts', () => {
  it('publishes the same built-in constraints in generated artifacts and provider schemas', async () => {
    const artifacts = compileToolJsonSchemas()
    const tools = await getToolSet({
      toolNames: Object.keys(artifacts),
      additionalToolDefinitions: async () => ({}),
      agentTools: {},
      skills: {},
    })
    // `description` is an ANNOTATION, not a constraint: getToolSet keeps it
    // only for mutation tools and read_files (see
    // shouldPreserveProviderSchemaDescriptions in prompts.ts), so parity here
    // is asserted over the data-bearing constraints both sides must share.
    const clean = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(clean)
      if (!value || typeof value !== 'object') return value
      return Object.fromEntries(
        Object.entries(value)
          .filter(
            ([key]) =>
              ![
                '$schema',
                'description',
                'errorMessage',
                'markdownDescription',
              ].includes(key),
          )
          .map(([key, entry]) => [key, clean(entry)]),
      )
    }
    for (const [name, artifact] of Object.entries(artifacts)) {
      const schema = (tools[name].inputSchema as { jsonSchema: unknown })
        .jsonSchema
      expect(clean(schema), name).toEqual(clean(artifact))
    }
  })
  it('preserves nested types and constraints across every built-in provider schema', () => {
    const skipped: string[] = []
    let checked = 0
    const verify = (original: unknown, compacted: unknown, path: string) => {
      if (!original || typeof original !== 'object' || Array.isArray(original))
        return
      expect(compacted, path).toBeObject()
      expect(Array.isArray(compacted), path).toBe(false)
      const source = original as Record<string, unknown>
      const target = compacted as Record<string, unknown>
      for (const key of [
        'type',
        'required',
        'enum',
        'const',
        'minimum',
        'maximum',
        'exclusiveMinimum',
        'exclusiveMaximum',
        'minLength',
        'maxLength',
        'minItems',
        'maxItems',
        'pattern',
        'format',
      ]) {
        if (key in source)
          expect(target[key], `${path}.${key}`).toEqual(source[key])
      }
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
        if (source[key] && typeof source[key] === 'object') {
          verify(source[key], target[key], `${path}.${key}`)
        } else if (key in source) {
          expect(target[key], `${path}.${key}`).toEqual(source[key])
        }
      }
      for (const key of ['anyOf', 'oneOf', 'allOf', 'prefixItems']) {
        if (Array.isArray(source[key])) {
          expect(Array.isArray(target[key]), `${path}.${key}`).toBe(true)
          expect((target[key] as unknown[]).length, `${path}.${key}`).toBe(
            (source[key] as unknown[]).length,
          )
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
        original = z.toJSONSchema(resolveToolParameterSchema(definition), {
          io: 'input',
        })
      } catch {
        skipped.push(name)
        continue
      }
      checked++
      verify(
        original,
        compactToolInputSchemaForProvider(
          resolveToolParameterSchema(definition),
        ).jsonSchema,
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
    // preserveDescriptions is opt-in now, so request it explicitly: this case
    // is about NAME-MAP safety (a field literally named `title`/`description`
    // must survive as data), which is only observable while annotations are
    // being preserved.
    const schema = compactToolInputSchemaForProvider(input, {
      preserveDescriptions: true,
    }).jsonSchema as Record<string, unknown>
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
    expect((properties.title as Record<string, unknown>).description).toBe(
      'a title',
    )
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
