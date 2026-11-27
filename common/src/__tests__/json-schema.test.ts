import { describe, expect, test } from 'bun:test'
import Ajv from 'ajv'
import { z } from 'zod/v4'

import {
  assertExternalToolInputSchema,
  assertZodSchemaTransportable,
  jsonSchemaAllowsString,
  jsonSchemaToZod,
  projectZodSchema,
  projectHostToolInputSchema,
} from '../util/json-schema'

describe('exact JSON Schema boundaries', () => {
  test('tuple projections preserve native length and item acceptance, including empty and rest tuples', () => {
    const schemas = [
      z.tuple([z.number(), z.number(), z.number()]),
      z.tuple([z.number(), z.number().optional()]),
      z.tuple([z.number(), z.unknown()]),
      z.tuple([z.unknown(), z.unknown(), z.unknown()]),
      z.tuple([]),
      z.tuple([]).rest(z.number()),
      z.tuple([z.number()]).rest(z.number()),
    ]
    const values = [
      [],
      [1],
      [1, 2],
      [1, 2, 3],
      [1, 2, 3, 4],
      ['x'],
      [1, 'x'],
      [1, 2, 'x'],
    ]
    for (const schema of schemas) {
      for (const projection of [
        projectZodSchema(schema, 'input'),
        projectHostToolInputSchema(schema),
      ]) {
        const restored = jsonSchemaToZod(projection)
        for (const value of values) {
          expect(restored.safeParse(value).success).toBe(
            schema.safeParse(value).success,
          )
        }
      }
    }
  })

  test('advisory tuples retain short inputs accepted by executable host members', () => {
    for (const schema of [
      z.tuple([z.number(), z.coerce.string()]),
      z.tuple([z.number(), z.string().catch('fallback')]),
    ]) {
      const restored = jsonSchemaToZod(projectHostToolInputSchema(schema))
      expect(schema.safeParse([1]).success).toBe(true)
      expect(restored.safeParse([1]).success).toBe(true)
      expect(() => assertZodSchemaTransportable(schema)).toThrow(
        'Cannot transport',
      )
    }
  })

  test('reserved external root fields refuse without treating nested or output fields as control', () => {
    const reserved = {
      type: 'object',
      properties: { cb_easp: { type: 'boolean' } },
    }
    const cases = [
      reserved,
      { type: 'object', required: ['cb_easp'] },
      {
        type: 'object',
        patternProperties: { '^cb_easp$': { type: 'boolean' } },
      },
      { type: 'object', dependencies: { value: ['cb_easp'] } },
      { type: 'object', dependencies: { value: reserved } },
      { type: 'object', propertyNames: { enum: ['cb_easp'] } },
      { const: { cb_easp: true } },
      { enum: [{ cb_easp: true }] },
      { allOf: [reserved] },
      { anyOf: [reserved, { type: 'object' }] },
      { oneOf: [reserved] },
      { if: { required: ['value'] }, then: reserved },
      { not: reserved },
      {
        definitions: { input: reserved },
        allOf: [{ $ref: '#/definitions/input' }],
      },
    ]
    for (const schema of cases)
      expect(() => assertExternalToolInputSchema(schema)).toThrow(
        'reserved tool input field cb_easp',
      )
    const nested = {
      type: 'object',
      properties: { payload: reserved },
      definitions: { unused: reserved },
    }
    expect(() => assertExternalToolInputSchema(nested)).not.toThrow()
    expect(jsonSchemaToZod(reserved).safeParse({ cb_easp: true }).success).toBe(
      true,
    )
    expect(() =>
      assertExternalToolInputSchema({
        type: 'object',
        properties: { value: { type: 'string' } },
      }),
    ).not.toThrow()
  })

  test('required prototype names need actual own JSON members', () => {
    for (const name of [
      'constructor',
      'toString',
      'hasOwnProperty',
      '__proto__',
    ]) {
      const requiredOnly = jsonSchemaToZod({ type: 'object', required: [name] })
      expect(requiredOnly.safeParse({}).success).toBe(false)
      expect(
        requiredOnly.safeParse(Object.fromEntries([[name, 'own']])).success,
      ).toBe(true)
      if (name === '__proto__') continue
      const schema = {
        type: 'object',
        properties: { [name]: { type: 'string' } },
        required: [name],
        additionalProperties: false,
      }
      const validator = jsonSchemaToZod(schema)
      expect(validator.safeParse({}).success).toBe(false)
      expect(
        validator.safeParse(Object.fromEntries([[name, 'own']])).success,
      ).toBe(true)
      expect(
        validator.safeParse(Object.fromEntries([[name, 42]])).success,
      ).toBe(false)
    }
  })

  test('refuses prototype map entries that the compiler silently omits at every schema scope', () => {
    for (const keyword of ['properties', 'patternProperties', 'dependencies']) {
      const member = keyword === 'dependencies' ? ['other'] : { type: 'string' }
      const map = Object.fromEntries([['__proto__', member]])
      const schema = {
        type: 'object',
        [keyword]: map,
      }
      for (const container of [
        schema,
        { allOf: [schema] },
        {
          definitions: { nested: schema },
          $ref: '#/definitions/nested',
        },
      ]) {
        expect(() => jsonSchemaToZod(container)).toThrow(
          `${keyword}/__proto__ is unsupported`,
        )
      }
      expect(Object.hasOwn(map, '__proto__')).toBe(true)
    }
  })

  test('optional prototype properties stay optional with empty and unrelated required arrays', () => {
    for (const name of ['constructor', 'toString', 'hasOwnProperty']) {
      for (const required of [undefined, [], ['value']]) {
        const schema = {
          type: 'object',
          properties: { [name]: { type: 'string' }, value: { type: 'string' } },
          ...(required !== undefined ? { required } : {}),
          additionalProperties: false,
        }
        const validator = jsonSchemaToZod(schema)
        const input = required?.length ? { value: 'present' } : {}
        expect(validator.safeParse(input).success).toBe(true)
        expect(validator.safeParse({ ...input, [name]: 'own' }).success).toBe(
          true,
        )
        expect(validator.safeParse({ ...input, [name]: 42 }).success).toBe(
          false,
        )
        if (required?.length)
          expect(validator.safeParse({}).success).toBe(false)
        expect(projectZodSchema(validator, 'input')).toEqual(schema)
      }
    }
  })

  test('refuses large closed maps whose hasOwnProperty schema would crash validation', () => {
    const properties = Object.fromEntries(
      [
        'hasOwnProperty',
        ...Array.from({ length: 8 }, (_, i) => `field${i}`),
      ].map((name) => [name, { type: 'string' }]),
    )
    for (const additionalProperties of [false, { type: 'string' }]) {
      expect(() =>
        jsonSchemaToZod({ properties, additionalProperties }),
      ).toThrow('properties/hasOwnProperty is unsupported')
    }
    const open = jsonSchemaToZod({ properties, additionalProperties: true })
    expect(open.safeParse({ hasOwnProperty: 'own', extra: 42 }).success).toBe(
      true,
    )
    expect(open.safeParse({ hasOwnProperty: 42 }).success).toBe(false)
    const small = jsonSchemaToZod({
      properties: { hasOwnProperty: { type: 'string' } },
      additionalProperties: false,
    })
    expect(small.safeParse({ hasOwnProperty: 'own' }).success).toBe(true)
    expect(small.safeParse({ extra: 'value' }).success).toBe(false)
  })

  test('fractional multipleOf uses exact decimal divisibility, including exponents', () => {
    const cases = [
      {
        divisor: 0.1,
        good: [0, 0.3, -0.3, 1e20],
        bad: [0.31, 0.30000000000000004],
      },
      { divisor: 0.02, good: [0.06, 0.3, -0.06], bad: [0.061] },
      { divisor: 3, good: [0, 9, -9], bad: [1, 1.5] },
      { divisor: 1e-300, good: [2e-300, 1e100], bad: [2.1e-300] },
      { divisor: 1e-323, good: [2e-323], bad: [Number.MIN_VALUE] },
    ]
    for (const { divisor, good, bad } of cases) {
      const validator = jsonSchemaToZod({ type: 'number', multipleOf: divisor })
      for (const input of good)
        expect(validator.safeParse(input).success).toBe(true)
      for (const input of [...bad, Infinity, NaN])
        expect(validator.safeParse(input).success).toBe(false)
    }
  })

  const cases = [
    {
      name: 'closed required objects',
      schema: {
        type: 'object',
        properties: { name: { type: 'string' } },
        required: ['name'],
        additionalProperties: false,
      },
      good: { name: 'yes' },
      bad: [{}, { name: 1 }, { name: 'yes', extra: true }],
    },
    {
      name: 'schema-valued additional properties',
      schema: { type: 'object', additionalProperties: { type: 'integer' } },
      good: { extra: 1 },
      bad: [{ extra: 1.5 }, { extra: '1' }],
    },
    {
      name: 'enum siblings',
      schema: {
        type: 'string',
        enum: ['allowed', 'x'],
        minLength: 4,
        pattern: '^allow',
      },
      good: 'allowed',
      bad: ['x', 'not allowed', 1],
    },
    {
      name: 'not',
      schema: { type: 'object', not: { required: ['forbidden'] } },
      good: { yes: 1 },
      bad: [{ forbidden: 1 }],
    },
    {
      name: 'allOf required closed objects',
      schema: {
        allOf: [
          {
            type: 'object',
            properties: { name: { type: 'string' } },
            required: ['name'],
            additionalProperties: false,
          },
        ],
      },
      good: { name: 'yes' },
      bad: [{}, { name: 'yes', extra: 1 }],
    },
    {
      name: 'oneOf exclusivity',
      schema: { oneOf: [{ type: 'number' }, { type: 'integer' }] },
      good: 1.5,
      bad: [1, '1'],
    },
    {
      name: 'conditional schemas',
      schema: {
        type: 'object',
        if: { required: ['flag'] },
        then: { required: ['answer'] },
        else: { not: { required: ['answer'] } },
      },
      good: { flag: true, answer: 'yes' },
      bad: [{ flag: true }, { answer: 'yes' }],
    },
    {
      name: 'unique and contains',
      schema: {
        type: 'array',
        uniqueItems: true,
        contains: { const: '/api/v1' },
      },
      good: ['/api/v1', 'other'],
      bad: [['/api/v1', '/api/v1'], ['other']],
    },
    {
      name: 'Unicode code point length',
      schema: { type: 'string', minLength: 2 },
      good: '🤖x',
      bad: ['🤖'],
    },
    {
      name: 'tuple constraints',
      schema: {
        type: 'array',
        items: [{ type: 'string' }, { type: 'integer' }],
        additionalItems: false,
        minItems: 2,
      },
      good: ['yes', 1],
      bad: [['yes'], ['yes', 1, true], ['yes', '1']],
    },
  ]
  for (const { name, schema, good, bad } of cases) {
    test(`preserves ${name} in validation, transport and nested projection`, () => {
      const validator = jsonSchemaToZod(schema)
      const restored = jsonSchemaToZod(
        JSON.parse(JSON.stringify(projectZodSchema(validator, 'input'))),
      )
      const nested = new Ajv().compile(
        z.toJSONSchema(z.object({ value: validator }), {
          target: 'draft-7',
          io: 'input',
        }),
      )
      for (const candidate of [validator, restored]) {
        expect(candidate.safeParse(good).success).toBe(true)
        for (const value of bad)
          expect(candidate.safeParse(value).success).toBe(false)
      }
      expect(nested({ value: good })).toBe(true)
      for (const value of bad) expect(nested({ value })).toBe(false)
      expect(projectZodSchema(validator, 'input')).toEqual(schema)
    })
  }

  test('supports boolean schemas and never under composition', () => {
    for (const [schema, valid] of [
      [true, true],
      [false, false],
      [{ not: {} }, false],
    ] as const) {
      const validator = jsonSchemaToZod(schema)
      expect(projectZodSchema(validator, 'input')).toEqual(schema)
      const nested = new Ajv().compile(
        z.toJSONSchema(z.object({ value: validator }), { target: 'draft-7' }),
      )
      for (const value of [null, {}, [], 'text', 1, false]) {
        expect(validator.safeParse(value).success).toBe(valid)
        expect(nested({ value })).toBe(valid)
      }
    }
  })

  test('preserves literal values, descriptions and nonmutating defaults', () => {
    const schema = {
      type: 'object',
      properties: {
        description: { const: { description: '/api/v1', pattern: '^[/]$' } },
        value: { type: 'string', default: 'fallback' },
      },
      required: ['description'],
      additionalProperties: false,
    }
    const validator = jsonSchemaToZod(schema)
    const value = { description: { description: '/api/v1', pattern: '^[/]$' } }
    const parsed = validator.parse(value)
    expect(parsed).toBe(value)
    expect(parsed).toEqual(value)
    expect(projectZodSchema(validator, 'input')).toEqual(schema)
    schema.properties.value.default = 'changed after registration'
    expect(
      (projectZodSchema(validator, 'input') as typeof schema).properties.value
        .default,
    ).toBe('fallback')
  })

  test('resolves local references without leaking their root into nested provider schemas', () => {
    const schema = {
      definitions: {
        'a/b~c': { type: 'string', minLength: 8, pattern: '^/api/v1/' },
      },
      type: 'object',
      properties: { path: { $ref: '#/definitions/a~1b~0c' } },
      required: ['path'],
      additionalProperties: false,
    }
    const validator = jsonSchemaToZod(schema)
    const nested = new Ajv().compile(
      z.toJSONSchema(z.object({ value: validator }), {
        io: 'input',
        target: 'draft-7',
      }),
    )
    expect(nested({ value: { path: '/api/v1/x' } })).toBe(true)
    expect(nested({ value: { path: '/wrong' } })).toBe(false)
    expect(projectZodSchema(validator, 'input')).toEqual(schema)
  })

  for (const schema of [
    { $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'string' },
    { type: 'object', unevaluatedProperties: false },
    { type: 'string', format: 'not-a-known-format' },
    { $ref: 'https://example.test/schema.json' },
    { $ref: '#/definitions/missing' },
    { definitions: { '': { type: 'string' } }, $ref: '#/definitions/' },
    {
      definitions: {
        alias: {
          $ref: '#/definitions/target',
          properties: { value: { type: 'number' } },
        },
        target: { properties: { value: { type: 'string' } } },
      },
      $ref: '#/definitions/alias/properties/value',
    },
    { $ref: '#' },
    { $async: true, type: 'string' },
    { type: 'integer', minimum: Number.NaN },
    { type: 'string', default: undefined },
  ]) {
    test(`refuses unsupported schemas explicitly: ${JSON.stringify(schema)}`, () => {
      expect(() => jsonSchemaToZod(schema)).toThrow('Unsupported JSON Schema')
    })
  }

  test('checks prompt type declarations without evaluating a sentinel', () => {
    for (const schema of [
      { type: 'string', enum: ['allowed'] },
      { type: 'string', minLength: 8 },
      { type: 'string', pattern: '^/api/v1$' },
      { allOf: [{ type: 'string' }, { minLength: 8 }] },
    ])
      expect(jsonSchemaAllowsString(schema)).toBe(true)
    for (const schema of [
      false,
      { type: 'number' },
      { const: 1 },
      { not: { type: 'string' } },
      { allOf: [{ type: 'string' }, { type: 'number' }] },
    ])
      expect(jsonSchemaAllowsString(schema)).toBe(false)
  })
})
