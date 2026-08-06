import { describe, expect, it } from 'bun:test'
import z from 'zod/v4'

import { applyPatchParams } from '../tool/apply-patch'
import {
  MAX_CONTEXT_LINES,
  MAX_READ_BLOCK_BYTES,
  MAX_WINDOW_SIZE,
  readFilesParams,
} from '../tool/read-files'
import {
  encodeReadCapabilityToken,
  getContentHash,
} from '../../../util/content-hash'
import {
  coerceToArray,
  coerceToObject,
  isObviousEditPlaceholder,
  normalizeSpawnAgentList,
  normalizeReplacementAliases,
  normalizeReplacementList,
  normalizeTransactionEditList,
  parseJsonStringWithRepair,
} from '../utils'

describe('coerceToArray', () => {
  it('passes through arrays unchanged', () => {
    expect(coerceToArray(['a', 'b'])).toEqual(['a', 'b'])
    expect(coerceToArray([{ old: 'x', new: 'y' }])).toEqual([
      { old: 'x', new: 'y' },
    ])
    expect(coerceToArray([])).toEqual([])
  })

  it('wraps a single string in an array', () => {
    expect(coerceToArray('file.ts')).toEqual(['file.ts'])
  })

  it('wraps a single object in an array', () => {
    expect(coerceToArray({ old: 'x', new: 'y' })).toEqual([
      { old: 'x', new: 'y' },
    ])
  })

  it('wraps a single number in an array', () => {
    expect(coerceToArray(42)).toEqual([42])
  })

  it('parses a stringified JSON array', () => {
    expect(coerceToArray('["file1.ts", "file2.ts"]')).toEqual([
      'file1.ts',
      'file2.ts',
    ])
  })

  it('repairs malformed separators in a stringified JSON array', () => {
    expect(coerceToArray('["file1.ts",, "file2.ts",]')).toEqual([
      'file1.ts',
      'file2.ts',
    ])
  })

  it('wraps a non-JSON string (does not parse as array)', () => {
    expect(coerceToArray('not-json')).toEqual(['not-json'])
  })

  it('wraps a stringified JSON object (not an array) in an array', () => {
    expect(coerceToArray('{"key": "value"}')).toEqual(['{"key": "value"}'])
  })

  it('passes through null', () => {
    expect(coerceToArray(null)).toBeNull()
  })

  it('passes through undefined', () => {
    expect(coerceToArray(undefined)).toBeUndefined()
  })

  it('recovers a comma-split fragment array by rejoining and re-parsing', () => {
    const array = '[{"a":1},{"b":2}]'
    const fragments = array.split(',')
    expect(fragments.length).toBeGreaterThan(1)
    expect(coerceToArray(fragments)).toEqual([{ a: 1 }, { b: 2 }])
  })

  it('collapses an unrecoverable comma-split fragment array to a single string', () => {
    const truncated = '[{"a":1},{"b":2'
    const fragments = truncated.split(',')
    expect(fragments.length).toBeGreaterThan(1)
    const result = coerceToArray(fragments)
    expect(typeof result).toBe('string')
    expect(result).toBe(truncated)
  })

  it('does not collapse a legitimate string array', () => {
    expect(coerceToArray(['file1.ts', 'file2.ts'])).toEqual([
      'file1.ts',
      'file2.ts',
    ])
  })

  it('passes through arrays of objects unchanged', () => {
    expect(coerceToArray([{ old: 'x' }, { old: 'y' }])).toEqual([
      { old: 'x' },
      { old: 'y' },
    ])
  })
})

describe('coerceToObject', () => {
  it('passes through objects unchanged', () => {
    expect(coerceToObject({ key: 'value' })).toEqual({ key: 'value' })
  })

  it('parses a stringified JSON object', () => {
    expect(coerceToObject('{"key": "value"}')).toEqual({ key: 'value' })
  })

  it('repairs malformed separators without changing string content', () => {
    expect(coerceToObject('{"key":"a,,b",,"enabled":true,}')).toEqual({
      key: 'a,,b',
      enabled: true,
    })
  })

  it('leaves non-JSON strings untouched', () => {
    expect(coerceToObject('not-json')).toBe('not-json')
  })

  it('passes through arrays and primitives so validation can reject them', () => {
    expect(coerceToObject(['a'])).toEqual(['a'])
    expect(coerceToObject(1)).toBe(1)
  })
})

describe('normalizeSpawnAgentList', () => {
  const entry = { agent_type: 'editor', prompt: 'Implement the change' }

  it('repairs one-level and double-stringified arrays', () => {
    expect(normalizeSpawnAgentList(JSON.stringify([entry]))).toEqual([entry])
    expect(
      normalizeSpawnAgentList(JSON.stringify(JSON.stringify([entry]))),
    ).toEqual([entry])
  })

  it('repairs stringified entries without fabricating malformed objects', () => {
    expect(normalizeSpawnAgentList([JSON.stringify(entry)])).toEqual([entry])
    expect(normalizeSpawnAgentList('[{"agent_type":')).toEqual([
      '[{"agent_type":',
    ])
  })

  it('repairs malformed nested params and handoff objects', () => {
    expect(
      normalizeSpawnAgentList([
        {
          agent_type: 'basher',
          params: '{"command":"bun test",,"timeout_seconds":30}',
          handoff: '{"schemaVersion":1,,"taskId":"validate"}',
        },
      ]),
    ).toEqual([
      {
        agent_type: 'basher',
        params: { command: 'bun test', timeout_seconds: 30 },
        handoff: { schemaVersion: 1, taskId: 'validate' },
      },
    ])
  })

  it('recovers a comma-split fragment array by rejoining and re-parsing', () => {
    const agents = [
      {
        agent_type: 'basher',
        prompt: 'Run tests',
        params: { command: 'bun test' },
      },
      { agent_type: 'thinker', prompt: 'Think about architecture' },
    ]
    // Simulate a transport that stringified the array then split on commas.
    const stringified = JSON.stringify(agents)
    const fragments = stringified.split(',')
    expect(fragments.length).toBeGreaterThan(2) // sanity: it was actually split
    expect(normalizeSpawnAgentList(fragments)).toEqual(agents)
  })

  it('collapses an unrecoverable comma-split fragment array to a single string', () => {
    // Fragments of a truncated JSON array with commas — none parse as
    // standalone objects, and rejoining doesn't produce valid JSON either.
    const truncated = '[{"agent_type":"basher","prompt":"test"'
    const fragments = truncated.split(',')
    expect(fragments.length).toBeGreaterThan(1) // sanity: actually split
    const result = normalizeSpawnAgentList(fragments)
    expect(typeof result).toBe('string')
    expect(result).toBe(truncated)
  })

  it('does not treat an array of standalone stringified entries as comma-split', () => {
    const entry1 = { agent_type: 'basher', prompt: 'Run tests' }
    const entry2 = { agent_type: 'thinker', prompt: 'Think' }
    // Each element is a complete stringified object — should be repaired
    // per-entry, not rejoined.
    expect(
      normalizeSpawnAgentList([JSON.stringify(entry1), JSON.stringify(entry2)]),
    ).toEqual([entry1, entry2])
  })

  it('moves an explicit top-level Basher command into params', () => {
    expect(
      normalizeSpawnAgentList([
        { agent_type: 'basher', command: 'bun test', params: {} },
      ]),
    ).toEqual([
      {
        agent_type: 'basher',
        command: 'bun test',
        params: { command: 'bun test' },
      },
    ])
  })

  it('repairs a Basher command serialized with provider argument tags', () => {
    const command =
      'ls -la /tmp/garden-rose-evidence/ 2>/dev/null; echo "---"; ls -la assets/garden/'
    expect(
      normalizeSpawnAgentList([
        {
          agent_type: 'basher',
          params: `command</arg_key><arg_value>${command}`,
        },
      ]),
    ).toEqual([{ agent_type: 'basher', params: { command } }])
  })

  it('repairs balanced provider argument tags around a Basher command', () => {
    expect(
      normalizeSpawnAgentList([
        {
          agent_type: 'basher',
          params: '<arg_key>command</arg_key><arg_value>bun test</arg_value>',
        },
      ]),
    ).toEqual([{ agent_type: 'basher', params: { command: 'bun test' } }])
  })

  it('rejects tagged params for other agents and multi-field fragments', () => {
    const nonBasher = {
      agent_type: 'editor',
      params: 'command</arg_key><arg_value>bun test',
    }
    const multiField = {
      agent_type: 'basher',
      params:
        'command</arg_key><arg_value>bun test</arg_value><arg_key>timeout_seconds</arg_key><arg_value>30',
    }
    expect(normalizeSpawnAgentList([nonBasher, multiField])).toEqual([
      nonBasher,
      multiField,
    ])
  })

  it('does not derive a Basher command from prompt prose', () => {
    expect(
      normalizeSpawnAgentList([
        { agent_type: 'basher', prompt: 'Run bun test', params: {} },
      ]),
    ).toEqual([{ agent_type: 'basher', prompt: 'Run bun test', params: {} }])
  })

  it('preserves an explicitly nested command over a top-level alias', () => {
    expect(
      normalizeSpawnAgentList([
        {
          agent_type: 'basher',
          command: 'bun test',
          params: '{"command":"bun run typecheck"}',
        },
      ]),
    ).toEqual([
      {
        agent_type: 'basher',
        command: 'bun test',
        params: { command: 'bun run typecheck' },
      },
    ])
  })

  it('does not move a top-level command for non-Basher agents', () => {
    const entry = {
      agent_type: 'release-manager',
      command: 'git status',
      params: {},
    }
    expect(normalizeSpawnAgentList([entry])).toEqual([entry])
  })

  it('moves a top-level code-searcher pattern into params.searchQueries', () => {
    expect(
      normalizeSpawnAgentList([
        {
          agent_type: 'code-searcher',
          pattern: 'foo',
          flags: '-g *.ts',
          params: {},
        },
      ]),
    ).toEqual([
      {
        agent_type: 'code-searcher',
        pattern: 'foo',
        flags: '-g *.ts',
        params: {
          searchQueries: [{ pattern: 'foo', flags: '-g *.ts' }],
        },
      },
    ])
  })

  it('builds code-searcher searchQueries from params.pattern', () => {
    expect(
      normalizeSpawnAgentList([
        {
          agent_type: 'code-searcher',
          params: { pattern: 'bar', cwd: 'src', maxResults: 12 },
        },
      ]),
    ).toEqual([
      {
        agent_type: 'code-searcher',
        params: {
          pattern: 'bar',
          cwd: 'src',
          maxResults: 12,
          searchQueries: [{ pattern: 'bar', cwd: 'src', maxResults: 12 }],
        },
      },
    ])
  })

  it('builds code-searcher searchQueries from a patterns array', () => {
    expect(
      normalizeSpawnAgentList([
        {
          agent_type: 'code-searcher',
          patterns: ['one', 'two'],
          params: {},
        },
      ]),
    ).toEqual([
      {
        agent_type: 'code-searcher',
        patterns: ['one', 'two'],
        params: {
          searchQueries: [{ pattern: 'one' }, { pattern: 'two' }],
        },
      },
    ])
  })

  it('moves a top-level code-searcher searchQueries array into params', () => {
    expect(
      normalizeSpawnAgentList([
        {
          agent_type: 'code-searcher',
          searchQueries: [{ pattern: 'top' }],
          params: {},
        },
      ]),
    ).toEqual([
      {
        agent_type: 'code-searcher',
        searchQueries: [{ pattern: 'top' }],
        params: { searchQueries: [{ pattern: 'top' }] },
      },
    ])
  })

  it('wraps a single code-searcher searchQueries object into an array', () => {
    expect(
      normalizeSpawnAgentList([
        {
          agent_type: 'code-searcher',
          params: { searchQueries: { pattern: 'solo' } },
        },
      ]),
    ).toEqual([
      {
        agent_type: 'code-searcher',
        params: { searchQueries: [{ pattern: 'solo' }] },
      },
    ])
  })

  it('prefers nested code-searcher searchQueries over a top-level pattern', () => {
    expect(
      normalizeSpawnAgentList([
        {
          agent_type: 'code-searcher',
          pattern: 'top-level',
          params: { searchQueries: [{ pattern: 'nested' }] },
        },
      ]),
    ).toEqual([
      {
        agent_type: 'code-searcher',
        pattern: 'top-level',
        params: { searchQueries: [{ pattern: 'nested' }] },
      },
    ])
  })

  it('does not invent code-searcher patterns from prompt prose', () => {
    expect(
      normalizeSpawnAgentList([
        {
          agent_type: 'code-searcher',
          prompt: 'Search for normalizeSpawnAgentList',
          params: {},
        },
      ]),
    ).toEqual([
      {
        agent_type: 'code-searcher',
        prompt: 'Search for normalizeSpawnAgentList',
        params: {},
      },
    ])
  })

  it('does not move pattern fields for non-code-searcher agents', () => {
    const entry = {
      agent_type: 'editor',
      pattern: 'should-not-move',
      patterns: ['a', 'b'],
      params: {},
    }
    expect(normalizeSpawnAgentList([entry])).toEqual([entry])
  })

  it('repairs a stringified handoff object without decoding nested strings', () => {
    expect(
      normalizeSpawnAgentList([
        {
          agent_type: 'editor',
          handoff: JSON.stringify({
            summary: '{"keep":"this as text"}',
          }),
        },
      ]),
    ).toEqual([
      {
        agent_type: 'editor',
        handoff: { summary: '{"keep":"this as text"}' },
      },
    ])
  })

  it('recovers an explicitly labelled specialist snapshot into params', () => {
    const snapshot = 'a'.repeat(64)
    expect(
      normalizeSpawnAgentList([
        {
          agent_type: 'compatibility-reviewer',
          prompt: `Perform the review.\nSnapshot ID (echo exactly): ${snapshot}`,
          params: { timeout_seconds: 300 },
        },
      ]),
    ).toEqual([
      {
        agent_type: 'compatibility-reviewer',
        prompt: `Perform the review.\nSnapshot ID (echo exactly): ${snapshot}`,
        params: { timeout_seconds: 300, snapshot_id: snapshot },
      },
    ])
  })

  it('recovers short and dotted explicitly labelled snapshot fingerprints', () => {
    for (const snapshot of ['v2', 'cap.v2.1.463.d6zLuTEuk7zcau68MhYD84qL']) {
      const normalized = normalizeSpawnAgentList([
        {
          agent_type: 'compatibility-reviewer',
          prompt: `Snapshot fingerprint (echo exactly): ${snapshot}`,
          params: {},
        },
      ]) as Array<{ params: { snapshot_id: string } }>
      expect(normalized[0].params.snapshot_id).toBe(snapshot)
    }
  })

  it('does not invent snapshot params from unlabelled prose', () => {
    const snapshot = 'b'.repeat(64)
    const entry = {
      agent_type: 'compatibility-reviewer',
      prompt: `Review commit ${snapshot}`,
      params: { timeout_seconds: 300 },
    }
    expect(normalizeSpawnAgentList([entry])).toEqual([entry])
  })

  it('decodes stringified-array values for known array param keys', () => {
    expect(
      normalizeSpawnAgentList([
        {
          agent_type: 'code-search',
          prompt: 'Search the codebase',
          params: { searchQueries: '["q1","q2"]' },
        },
      ]),
    ).toEqual([
      {
        agent_type: 'code-search',
        prompt: 'Search the codebase',
        params: { searchQueries: ['q1', 'q2'] },
      },
    ])
  })

  it('decodes stringified-array values inside a stringified params object', () => {
    expect(
      normalizeSpawnAgentList([
        {
          agent_type: 'file-picker',
          prompt: 'Find files',
          params: JSON.stringify({ filePaths: '["a.ts","b.ts"]' }),
        },
      ]),
    ).toEqual([
      {
        agent_type: 'file-picker',
        prompt: 'Find files',
        params: { filePaths: ['a.ts', 'b.ts'] },
      },
    ])
  })

  it('leaves non-array values and unknown keys untouched', () => {
    expect(
      normalizeSpawnAgentList([
        {
          agent_type: 'editor',
          prompt: 'Edit',
          params: { searchQueries: 'not-an-array', custom: '["x"]' },
        },
      ]),
    ).toEqual([
      {
        agent_type: 'editor',
        prompt: 'Edit',
        params: { searchQueries: 'not-an-array', custom: '["x"]' },
      },
    ])
  })

  it('terminates on a triple-stringified comma-split array without stack overflow (depth guard)', () => {
    const agents = [{ agent_type: 'editor', prompt: 'Edit' }]
    const tripleStringified = JSON.stringify(
      JSON.stringify(JSON.stringify(agents)),
    )
    // The comma-split path splits on every comma; a triple-stringified
    // payload re-parses on each recursion. The depth guard must bound this.
    const fragments = tripleStringified.split(',')
    expect(fragments.length).toBeGreaterThan(1)
    const result = normalizeSpawnAgentList(fragments)
    // Must return an array (repaired) without throwing or looping.
    expect(Array.isArray(result)).toBe(true)
  })

  it('does not do unbounded CPU work on an implausibly large fragment array', () => {
    // 300 fragments (above MAX_FRAGMENT_COUNT=256) of a malformed string.
    // repairCommaSplitFragments must fail fast and return the array unchanged.
    const largeFragmentArray = Array.from({ length: 300 }, (_, i) => `frag${i}`)
    const result = normalizeSpawnAgentList(largeFragmentArray)
    // Should return the same fragment strings unchanged — Zod will emit
    // per-element errors. Use toEqual (deep equality) because
    // normalizeSpawnAgentList maps over the array, producing a new array.
    expect(result).toEqual(largeFragmentArray)
  })

  it('does not do unbounded CPU work on an implausibly long rejoined string', () => {
    // A 2-fragment array where the rejoined string exceeds 64KB.
    // repairCommaSplitFragments must fail fast and return the array unchanged.
    const twoFragments = ['[' + 'x'.repeat(40_000), 'y'.repeat(40_000) + ']']
    const result = coerceToArray(twoFragments)
    // The rejoined string is > 64KB so repairCommaSplitFragments fails fast.
    expect(result).toBe(twoFragments)
  })
})

describe('parseJsonStringWithRepair', () => {
  it('repairs only separators outside strings', () => {
    expect(
      parseJsonStringWithRepair('{"value":"a,,b,}",,"items":[1,,2,]}'),
    ).toEqual({ value: 'a,,b,}', items: [1, 2] })
  })

  it('rejects truncated JSON without guessing', () => {
    expect(() => parseJsonStringWithRepair('{"items":[1,,2')).toThrow()
  })
})

describe('isObviousEditPlaceholder', () => {
  it('detects explicit patch placeholders but preserves real bracketed code', () => {
    expect(isObviousEditPlaceholder('[see patch above]')).toBe(true)
    expect(isObviousEditPlaceholder('<insert current code here>')).toBe(true)
    expect(isObviousEditPlaceholder('[index]')).toBe(false)
    expect(isObviousEditPlaceholder('const value = [1, 2]')).toBe(false)
  })
})

describe('coerceToArray with Zod schemas', () => {
  it('coerces a single string into an array for z.array(z.string())', () => {
    const schema = z.object({
      paths: z.preprocess(coerceToArray, z.array(z.string())),
    })
    const result = schema.safeParse({ paths: 'file.ts' })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.paths).toEqual(['file.ts'])
    }
  })

  it('coerces a single object into an array for z.array(z.object(...))', () => {
    const schema = z.object({
      replacements: z.preprocess(
        coerceToArray,
        z.array(z.object({ old: z.string(), new: z.string() })),
      ),
    })
    const result = schema.safeParse({ replacements: { old: 'x', new: 'y' } })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.replacements).toEqual([{ old: 'x', new: 'y' }])
    }
  })

  it('still validates correctly when already an array', () => {
    const schema = z.object({
      paths: z.preprocess(coerceToArray, z.array(z.string())),
    })
    const result = schema.safeParse({ paths: ['a.ts', 'b.ts'] })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.paths).toEqual(['a.ts', 'b.ts'])
    }
  })

  it('still rejects invalid inner types after coercion', () => {
    const schema = z.object({
      paths: z.preprocess(coerceToArray, z.array(z.string())),
    })
    const result = schema.safeParse({ paths: 123 })
    expect(result.success).toBe(false)
  })

  it('works with optional arrays', () => {
    const schema = z.object({
      paths: z.preprocess(coerceToArray, z.array(z.string())).optional(),
    })
    const withValue = schema.safeParse({ paths: 'file.ts' })
    expect(withValue.success).toBe(true)
    if (withValue.success) {
      expect(withValue.data.paths).toEqual(['file.ts'])
    }

    const withoutValue = schema.safeParse({})
    expect(withoutValue.success).toBe(true)
    if (withoutValue.success) {
      expect(withoutValue.data.paths).toBeUndefined()
    }
  })

  it('produces identical JSON schema with or without preprocess', () => {
    const plain = z.object({ paths: z.array(z.string()) })
    const coerced = z.object({
      paths: z.preprocess(coerceToArray, z.array(z.string())),
    })

    const plainSchema = z.toJSONSchema(plain, { io: 'input' })
    const coercedSchema = z.toJSONSchema(coerced, { io: 'input' })
    expect(coercedSchema).toEqual(plainSchema)
  })
})

describe('apply_patch basedOnRead coercion', () => {
  const readCapability = encodeReadCapabilityToken({
    startLine: 1,
    endLine: 2,
    hash: getContentHash('fresh range'),
    scope: {
      projectId: '/project',
      path: 'src/file.ts',
      runId: 'run-123',
    },
  })

  it('coerces one scoped cap.v3 token to an array', () => {
    const parsed = applyPatchParams.inputSchema.safeParse({
      operation: {
        type: 'update_file',
        path: 'src/file.ts',
        diff: '@@\n-old\n+new\n',
        basedOnRead: readCapability,
      },
    })

    expect(parsed.success).toBe(true)
    if (parsed.success && parsed.data.operation.type === 'update_file') {
      expect(parsed.data.operation.basedOnRead).toEqual([readCapability])
    }
  })

  it('rejects cap.v2 and object anchors after coercion', () => {
    const legacyValues = [
      'cap.v2.1.2.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      { startLine: 1, endLine: 2, hash: getContentHash('fresh range') },
    ]

    for (const basedOnRead of legacyValues) {
      expect(
        applyPatchParams.inputSchema.safeParse({
          operation: {
            type: 'update_file',
            path: 'src/file.ts',
            diff: '@@\n-old\n+new\n',
            basedOnRead,
          },
        }).success,
      ).toBe(false)
    }
  })
})

describe('coerceToObject with Zod schemas', () => {
  it('produces identical JSON schema with or without preprocess', () => {
    const plain = z.object({
      params: z.record(z.string(), z.any()).optional(),
    })
    const coerced = z.object({
      params: z
        .preprocess(coerceToObject, z.record(z.string(), z.any()))
        .optional(),
    })

    const plainSchema = z.toJSONSchema(plain, { io: 'input' })
    const coercedSchema = z.toJSONSchema(coerced, { io: 'input' })
    expect(coercedSchema).toEqual(plainSchema)
  })
})

describe('normalizeReplacementAliases', () => {
  it('consumes documented aliases after canonicalization', () => {
    for (const [oldKey, newKey] of [
      ['old', 'new'],
      ['old_str', 'new_str'],
      ['old_string', 'new_string'],
    ] as const) {
      const input = {
        [oldKey]: 'before',
        [newKey]: 'after',
        allowMultiple: true,
      }

      expect(normalizeReplacementAliases(input)).toEqual({
        oldString: 'before',
        newString: 'after',
        allowMultiple: true,
      })
      expect(input).toEqual({
        [oldKey]: 'before',
        [newKey]: 'after',
        allowMultiple: true,
      })
    }
  })

  it('consumes equivalent canonical and alias values', () => {
    expect(
      normalizeReplacementAliases({
        oldString: 'before',
        old: 'before',
        old_str: 'before',
        newString: 'after',
        new_string: 'after',
      }),
    ).toEqual({ oldString: 'before', newString: 'after' })
  })

  it('preserves aliases that conflict with canonical values', () => {
    expect(
      normalizeReplacementAliases({
        oldString: 'before',
        old_str: 'different before',
        newString: 'after',
        new_str: 'different after',
      }),
    ).toEqual({
      oldString: 'before',
      old_str: 'different before',
      newString: 'after',
      new_str: 'different after',
    })
  })

  it('preserves conflicting aliases while consuming equivalent duplicates', () => {
    expect(
      normalizeReplacementAliases({
        old: 'before',
        old_str: 'before',
        old_string: 'different before',
        new: 'after',
        new_str: 'different after',
        new_string: 'after',
      }),
    ).toEqual({
      oldString: 'before',
      old_string: 'different before',
      newString: 'after',
      new_str: 'different after',
    })
  })
})

describe('normalizeReplacementList', () => {
  it('drops a trailing empty placeholder but keeps real replacements', () => {
    expect(
      normalizeReplacementList([
        { oldString: 'before', newString: 'after' },
        {},
      ]),
    ).toEqual([{ oldString: 'before', newString: 'after' }])
  })

  it('drops a placeholder with only allowMultiple', () => {
    expect(
      normalizeReplacementList([
        { oldString: 'a', newString: 'b' },
        { allowMultiple: false },
      ]),
    ).toEqual([{ oldString: 'a', newString: 'b' }])
  })

  it('preserves an entry with an unknown key for normal validation', () => {
    const entry = { oldString: 'a', newString: 'b', unknownKey: 'value' }
    expect(normalizeReplacementList([entry])).toEqual([entry])
  })

  it('keeps a placeholder that carries a payload alias', () => {
    expect(
      normalizeReplacementList([
        { old_str: 'before', new_str: 'after' },
        { allowMultiple: true },
      ]),
    ).toEqual([{ old_str: 'before', new_str: 'after' }])
  })

  it('drops an empty->empty placeholder carrying only basedOnRead but keeps a sibling real replacement', () => {
    expect(
      normalizeReplacementList([
        { oldString: 'before', newString: 'after' },
        { oldString: '', newString: '', basedOnRead: 'cap.v3.x' },
      ]),
    ).toEqual([{ oldString: 'before', newString: 'after' }])
  })

  it('drops a lone empty->empty placeholder leaving an empty array', () => {
    expect(
      normalizeReplacementList([
        { oldString: '', newString: '', basedOnRead: 'cap.v3.x' },
      ]),
    ).toEqual([])
  })

  it('keeps a malformed empty-oldString-with-content edit for validation', () => {
    expect(
      normalizeReplacementList([{ oldString: '', newString: 'content' }]),
    ).toEqual([{ oldString: '', newString: 'content' }])
  })

  it('keeps a real deletion with an empty newString', () => {
    expect(
      normalizeReplacementList([{ oldString: 'x', newString: '' }]),
    ).toEqual([{ oldString: 'x', newString: '' }])
  })

  it('coerces a single replacement object into an array before filtering', () => {
    expect(
      normalizeReplacementList({ oldString: 'a', newString: 'b' }),
    ).toEqual([{ oldString: 'a', newString: 'b' }])
  })

  it('passes through null without wrapping', () => {
    expect(normalizeReplacementList(null)).toBeNull()
  })

  it('recovers a comma-split fragment array via coerceToArray', () => {
    const replacements = [{ oldString: 'a', newString: 'b' }]
    const stringified = JSON.stringify(replacements)
    const fragments = stringified.split(',')
    expect(fragments.length).toBeGreaterThan(1)
    expect(normalizeReplacementList(fragments)).toEqual(replacements)
  })
})

describe('read_files block selector input schema', () => {
  const parse = (input: unknown) => readFilesParams.inputSchema.safeParse(input)

  it('accepts window/around/symbol selectors at their documented caps', () => {
    const parsed = parse({
      windows: [{ path: 'a.ts', windowSize: MAX_WINDOW_SIZE, window: 2 }],
      around: [
        { path: 'a.ts', match: 'loadConfig', contextLines: MAX_CONTEXT_LINES },
      ],
      symbol: [{ path: 'a.ts', name: 'loadConfig', occurrence: 2 }],
    })

    expect(parsed.success).toBe(true)
    if (parsed.success) {
      expect(parsed.data.windows).toEqual([
        { path: 'a.ts', windowSize: MAX_WINDOW_SIZE, window: 2 },
      ])
      expect(parsed.data.symbol).toEqual([
        { path: 'a.ts', name: 'loadConfig', occurrence: 2 },
      ])
    }
  })

  it('rejects selector values beyond the window/context caps and below occurrence 1', () => {
    expect(
      parse({ windows: [{ path: 'a.ts', windowSize: MAX_WINDOW_SIZE + 1 }] })
        .success,
    ).toBe(false)
    expect(
      parse({
        around: [
          { path: 'a.ts', match: 'x', contextLines: MAX_CONTEXT_LINES + 1 },
        ],
      }).success,
    ).toBe(false)
    expect(parse({ windows: [{ path: 'a.ts', window: 0 }] }).success).toBe(false)
    expect(
      parse({ around: [{ path: 'a.ts', match: 'x', occurrence: 0 }] }).success,
    ).toBe(false)
    expect(
      parse({ symbol: [{ path: 'a.ts', name: 'run', occurrence: 0 }] }).success,
    ).toBe(false)
  })

  it('requires at least one selector and names every selector kind in the message', () => {
    const parsed = parse({})
    expect(parsed.success).toBe(false)
    if (!parsed.success) {
      expect(parsed.error.issues[0]?.message).toBe(
        'read_files requires at least one path, range, window, around, symbol, or symbols selector.',
      )
    }
    expect(parse({ windows: [{ path: 'a.ts' }] }).success).toBe(true)
    expect(parse({ around: [{ path: 'a.ts', match: 'x' }] }).success).toBe(true)
    expect(parse({ symbol: [{ path: 'a.ts', name: 'run' }] }).success).toBe(true)
  })

  it('infers the sole paths entry into window/around/symbol selectors', () => {
    const parsed = parse({
      paths: ['src/large.ts'],
      windows: [{ window: 2 }],
      around: [{ match: 'loadConfig' }],
      symbol: [{ name: 'loadConfig' }],
    })

    expect(parsed.success).toBe(true)
    if (parsed.success) {
      expect(parsed.data.paths).toEqual([])
      expect(parsed.data.windows).toEqual([{ path: 'src/large.ts', window: 2 }])
      expect(parsed.data.around).toEqual([
        { path: 'src/large.ts', match: 'loadConfig' },
      ])
      expect(parsed.data.symbol).toEqual([
        { path: 'src/large.ts', name: 'loadConfig' },
      ])
    }
  })

  it('does not infer a path when several paths are supplied', () => {
    expect(
      parse({ paths: ['a.ts', 'b.ts'], windows: [{ window: 1 }] }).success,
    ).toBe(false)
  })

  it('coerces single-object window/around/symbol selectors into arrays', () => {
    const parsed = parse({
      windows: { path: 'src/large.ts', window: 2 },
      around: { path: 'src/large.ts', match: 'loadConfig' },
      symbol: { path: 'src/large.ts', name: 'loadConfig' },
    })

    expect(parsed.success).toBe(true)
    if (parsed.success) {
      expect(parsed.data.windows).toEqual([{ path: 'src/large.ts', window: 2 }])
      expect(parsed.data.around).toEqual([
        { path: 'src/large.ts', match: 'loadConfig' },
      ])
      expect(parsed.data.symbol).toEqual([
        { path: 'src/large.ts', name: 'loadConfig' },
      ])
    }
  })

  it('repairs comma-split fragmented symbol and window selector arrays', () => {
    const symbol = [{ path: 'src/large.ts', name: 'loadConfig' }]
    const windows = [{ path: 'src/large.ts', window: 2 }]
    const symbolFragments = JSON.stringify(symbol).split(',')
    const windowFragments = JSON.stringify(windows).split(',')
    expect(symbolFragments.length).toBeGreaterThan(1)
    expect(windowFragments.length).toBeGreaterThan(1)

    const parsed = parse({
      symbol: symbolFragments,
      windows: windowFragments,
    })
    expect(parsed.success).toBe(true)
    if (parsed.success) {
      expect(parsed.data.symbol).toEqual(symbol)
      expect(parsed.data.windows).toEqual(windows)
    }
  })

  it('documents the per-block byte budget and its too_large outcome', () => {
    expect(readFilesParams.description).toContain(String(MAX_READ_BLOCK_BYTES))
    expect(readFilesParams.description).toContain('too_large')
  })
})

describe('normalizeTransactionEditList', () => {
  it('infers omitted discriminators for unambiguous transaction edits', () => {
    expect(
      normalizeTransactionEditList([
        { path: 'a.ts', replacements: [{ oldString: 'a', newString: 'b' }] },
        { path: 'b.ts', operation: { kind: 'insert_text' } },
        { path: 'c.ts', destinationPath: 'd.ts' },
        { path: 'e.ts', diff: '@@ patch' },
        { path: 'f.ts', symbol: 'run', content: 'function run() {}' },
        {
          path: 'g.ts',
          startLine: 1,
          endLine: 2,
          expectedHash: 'sha256:test',
          newContent: 'replacement',
        },
      ]),
    ).toMatchObject([
      { type: 'str_replace' },
      { type: 'structured' },
      { type: 'move' },
      { type: 'patch' },
      { type: 'rewrite_symbol' },
      { type: 'replace_range' },
    ])
  })

  it('preserves explicit, ambiguous, and conflicting shapes for validation', () => {
    const explicit = { type: 'delete', path: 'a.ts' }
    const contentOnly = { path: 'b.ts', content: 'bytes' }
    const conflicting = {
      path: 'c.ts',
      replacements: [{ oldString: 'a', newString: 'b' }],
      operation: { kind: 'insert_text' },
    }

    expect(
      normalizeTransactionEditList([explicit, contentOnly, conflicting]),
    ).toEqual([explicit, contentOnly, conflicting])
  })

  it('overrides an invalid-but-unambiguous edit type from shape', () => {
    expect(
      normalizeTransactionEditList([
        {
          path: 'a.ts',
          type: 'edit',
          replacements: [{ oldString: 'a', newString: 'b' }],
        },
      ]),
    ).toMatchObject([{ type: 'str_replace' }])
  })

  it('canonicalizes case/separator variants of a valid edit type', () => {
    expect(
      normalizeTransactionEditList([
        {
          path: 'a.ts',
          type: 'Str-Replace',
          replacements: [{ oldString: 'a', newString: 'b' }],
        },
      ]),
    ).toMatchObject([{ type: 'str_replace' }])
  })

  it('leaves an invalid type with an ambiguous shape unchanged', () => {
    expect(
      normalizeTransactionEditList([{ path: 'a.ts', type: 'bogus', content: 'x' }]),
    ).toEqual([{ path: 'a.ts', type: 'bogus', content: 'x' }])
  })

  it('repairs a JSON-stringified transaction array', () => {
    expect(
      normalizeTransactionEditList(
        JSON.stringify([{ path: 'a.ts', replacements: [] }]),
      ),
    ).toEqual([{ path: 'a.ts', replacements: [], type: 'str_replace' }])
  })

  it('repairs double-stringified arrays and stringified edit entries', () => {
    const entry = JSON.stringify({
      path: 'a.ts',
      replacements: [{ oldString: 'a', newString: 'b' }],
    })
    expect(
      normalizeTransactionEditList(JSON.stringify(JSON.stringify([entry]))),
    ).toEqual([
      {
        path: 'a.ts',
        replacements: [{ oldString: 'a', newString: 'b' }],
        type: 'str_replace',
      },
    ])
  })

  it('leaves malformed serialized transaction arrays at the field boundary', () => {
    const malformed = '[{"path":"a.ts","replacements":['
    expect(normalizeTransactionEditList(malformed)).toBe(malformed)
  })

  it('recovers a comma-split fragment array via coerceToArray', () => {
    const edits = [
      { path: 'a.ts', replacements: [{ oldString: 'a', newString: 'b' }] },
    ]
    const stringified = JSON.stringify(edits)
    const fragments = stringified.split(',')
    expect(fragments.length).toBeGreaterThan(1)
    expect(normalizeTransactionEditList(fragments)).toEqual([
      {
        path: 'a.ts',
        replacements: [{ oldString: 'a', newString: 'b' }],
        type: 'str_replace',
      },
    ])
  })
})
