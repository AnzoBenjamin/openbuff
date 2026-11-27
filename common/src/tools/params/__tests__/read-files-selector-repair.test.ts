import { beforeEach, describe, expect, it } from 'bun:test'

import {
  MAX_REPAIRABLE_SELECTOR_STRING_LENGTH,
  __resetReadFilesSelectorRepairStatsForTest,
  getReadFilesSelectorRepairStats,
  readFilesParams,
} from '../tool/read-files'

describe('read_files selector shape repair', () => {
  const parse = (input: unknown) => readFilesParams.inputSchema.safeParse(input)

  beforeEach(() => {
    __resetReadFilesSelectorRepairStatsForTest()
  })

  it('wraps a bare string around selector and infers the sole paths entry', () => {
    const parsed = parse({
      paths: ['src/file.ts'],
      around: 'function handleSpawnAgents',
    })

    expect(parsed.success).toBe(true)
    if (parsed.success) {
      expect(parsed.data.paths).toEqual([])
      expect(parsed.data.around).toEqual([
        { path: 'src/file.ts', match: 'function handleSpawnAgents' },
      ])
    }

    // Without a sole paths entry the wrapped anchor still fails closed: the
    // repair never fabricates a path.
    expect(parse({ around: 'function handleSpawnAgents' }).success).toBe(
      false,
    )
  })

  it('repairs only the plain string entry of a mixed around array', () => {
    const parsed = parse({
      paths: ['src/file.ts'],
      around: [{ path: 'src/file.ts', match: 'keep' }, 'bare string'],
    })

    expect(parsed.success).toBe(true)
    if (parsed.success) {
      expect(parsed.data.around).toEqual([
        { path: 'src/file.ts', match: 'keep' },
        { path: 'src/file.ts', match: 'bare string' },
      ])
    }
  })

  it('wraps plain string symbols entries and leaves object entries alone', () => {
    const parsed = parse({
      paths: ['a.ts'],
      symbols: ['foo', { path: 'a.ts', names: ['bar'] }],
    })

    expect(parsed.success).toBe(true)
    if (parsed.success) {
      expect(parsed.data.symbols).toEqual([
        { path: 'a.ts', names: ['foo'] },
        { path: 'a.ts', names: ['bar'] },
      ])
    }
  })

  it('wraps a field-level plain symbols string', () => {
    const parsed = parse({ paths: ['a.ts'], symbols: 'foo' })

    expect(parsed.success).toBe(true)
    if (parsed.success) {
      expect(parsed.data.symbols).toEqual([{ path: 'a.ts', names: ['foo'] }])
    }
  })

  it('wraps a field-level plain symbol string as a name entry', () => {
    const parsed = parse({ paths: ['a.ts'], symbol: 'foo' })

    expect(parsed.success).toBe(true)
    if (parsed.success) {
      expect(parsed.data.symbol).toEqual([{ path: 'a.ts', name: 'foo' }])
    }
  })

  it('clamps zero window and occurrence indices to 1', () => {
    const parsed = parse({
      paths: ['a.ts'],
      windows: [{ path: 'a.ts', window: 0 }],
      around: [{ match: 'x', occurrence: 0 }],
      symbol: [{ name: 'run', occurrence: 0 }],
    })

    expect(parsed.success).toBe(true)
    if (parsed.success) {
      expect(parsed.data.windows).toEqual([{ path: 'a.ts', window: 1 }])
      expect(parsed.data.around).toEqual([
        { path: 'a.ts', match: 'x', occurrence: 1 },
      ])
      expect(parsed.data.symbol).toEqual([
        { path: 'a.ts', name: 'run', occurrence: 1 },
      ])
    }
  })

  it('clamps zero indices on single-object selector values too', () => {
    const parsed = parse({
      paths: ['a.ts'],
      windows: { path: 'a.ts', window: 0 },
      around: { match: 'x', occurrence: 0 },
    })

    expect(parsed.success).toBe(true)
    if (parsed.success) {
      expect(parsed.data.windows).toEqual([{ path: 'a.ts', window: 1 }])
      expect(parsed.data.around).toEqual([
        { path: 'a.ts', match: 'x', occurrence: 1 },
      ])
    }
  })

  it('decodes comma-split fragments before repairing the decoded entries', () => {
    // The fragment array is rejoined FIRST; repairing before decoding would
    // wrap the fragment strings and break the rejoin.
    const selectors = [{ path: 'a.ts', match: 'keep' }, 'bare']
    const fragments = JSON.stringify(selectors).split(',')
    expect(fragments.length).toBeGreaterThan(1)
    expect(fragments.every((entry) => typeof entry === 'string')).toBe(true)

    const parsed = parse({ paths: ['a.ts'], around: fragments })

    expect(parsed.success).toBe(true)
    if (parsed.success) {
      expect(parsed.data.around).toEqual([
        { path: 'a.ts', match: 'keep' },
        { path: 'a.ts', match: 'bare' },
      ])
    }
  })

  it('does not wrap JSON-fragment-looking selector strings', () => {
    // A comma-split truncated container never becomes a match anchor: the
    // bracket-leading fragment stays a string, so the field still fails.
    const fragments = '[{"path":"a.ts","match":"x"'.split(',')
    expect(fragments.length).toBeGreaterThan(1)
    expect(parse({ paths: ['a.ts'], around: fragments }).success).toBe(false)
    expect(parse({ paths: ['a.ts'], around: ['[draft]'] }).success).toBe(
      false,
    )
    expect(
      parse({ paths: ['a.ts'], around: ['{"path": "a.ts"'] }).success,
    ).toBe(false)
  })

  it('leaves parseable-JSON selector strings for coerceToArray', () => {
    // A stringified selector ARRAY parses back into real entries instead of
    // being wrapped as one giant match anchor.
    const parsed = parse({
      paths: ['a.ts'],
      around: '[{"path": "a.ts", "match": "x"}]',
    })

    expect(parsed.success).toBe(true)
    if (parsed.success) {
      expect(parsed.data.around).toEqual([{ path: 'a.ts', match: 'x' }])
    }

    // A stringified single selector OBJECT does not parse as an array, so it
    // fails closed rather than being wrapped as an anchor.
    expect(
      parse({ paths: ['a.ts'], around: '{"path": "a.ts", "match": "x"}' })
        .success,
    ).toBe(false)
  })

  it('does not wrap oversized plain selector strings', () => {
    const oversized = 'x'.repeat(MAX_REPAIRABLE_SELECTOR_STRING_LENGTH + 1)
    expect(parse({ paths: ['a.ts'], around: [oversized] }).success).toBe(
      false,
    )
    expect(parse({ paths: ['a.ts'], symbols: oversized }).success).toBe(false)
  })

  it('does not clamp negative or non-integer selector indices', () => {
    expect(parse({ windows: [{ path: 'a.ts', window: -1 }] }).success).toBe(
      false,
    )
    expect(
      parse({ around: [{ path: 'a.ts', match: 'x', occurrence: -1 }] }).success,
    ).toBe(false)
    expect(parse({ windows: [{ path: 'a.ts', window: 0.5 }] }).success).toBe(
      false,
    )
  })

  it('leaves ranges and windows string entries untouched', () => {
    expect(parse({ paths: ['a.ts'], ranges: ['a.ts'] }).success).toBe(false)
    expect(parse({ paths: ['a.ts'], windows: ['a.ts'] }).success).toBe(false)
  })

  it('parses already-valid selector inputs without incrementing stats', () => {
    const parsed = parse({
      paths: ['src/a.ts'],
      windows: [{ path: 'src/a.ts', window: 2 }],
      around: [{ path: 'src/a.ts', match: 'x', occurrence: 2 }],
      symbol: [{ path: 'src/a.ts', name: 'run' }],
      symbols: [{ path: 'src/a.ts', names: ['run'] }],
    })

    expect(parsed.success).toBe(true)
    expect(getReadFilesSelectorRepairStats().total).toBe(0)
    expect(getReadFilesSelectorRepairStats().byKind).toEqual({})
  })

  it('counts each applied repair by kind', () => {
    const parsed = parse({
      paths: ['src/a.ts'],
      around: 'anchor',
      windows: [{ path: 'src/a.ts', window: 0 }],
    })

    expect(parsed.success).toBe(true)
    expect(getReadFilesSelectorRepairStats().total).toBe(2)
    expect(getReadFilesSelectorRepairStats().byKind).toEqual({
      around_string: 1,
      window_zero_index: 1,
    })
  })

  it('counts a clamped zero occurrence under its own kind', () => {
    const parsed = parse({
      paths: ['src/a.ts'],
      around: [{ match: 'x', occurrence: 0 }],
    })

    expect(parsed.success).toBe(true)
    expect(getReadFilesSelectorRepairStats().byKind).toEqual({
      occurrence_zero_index: 1,
    })
  })
})
