import { describe, expect, it } from 'bun:test'
import z from 'zod/v4'

import { findFilesMatchingContentParams } from '../find-files-matching-content'

/**
 * Direct schema-bounds tests for find_files_matching_content: the output
 * `count` field is int-bounded and the `flags` allowlist is declared
 * structurally (not prose-only), so a runaway or unsafe payload fails at
 * validation time instead of reaching the ripgrep child.
 */
describe('find_files_matching_content schema bounds', () => {
  const outputParse = (value: unknown) =>
    findFilesMatchingContentParams.outputSchema.safeParse([
      { type: 'json', value },
    ])

  it('accepts a well-formed result payload', () => {
    expect(
      outputParse({
        files: ['src/a.ts'],
        count: 1,
        message: 'ok',
      }).success,
    ).toBe(true)
  })

  it('rejects a non-integer count', () => {
    expect(
      outputParse({ files: [], count: 1.5, message: 'ok' }).success,
    ).toBe(false)
  })

  it('rejects a negative count', () => {
    expect(
      outputParse({ files: [], count: -1, message: 'ok' }).success,
    ).toBe(false)
  })

  it('rejects a count above the 500 schema cap', () => {
    expect(
      outputParse({ files: [], count: 500, message: 'ok' }).success,
    ).toBe(true)
    expect(
      outputParse({ files: [], count: 501, message: 'ok' }).success,
    ).toBe(false)
  })

  it('normalizes a single-string flags payload into argv tokens', () => {
    const parsed = findFilesMatchingContentParams.inputSchema.parse({
      pattern: 'foo',
      flags: '-F -g *.ts -g *.tsx',
    })
    expect(parsed.flags).toEqual(['-F', '-g', '*.ts', '-g', '*.tsx'])
  })

  it('accepts an argv-tokens flags payload unchanged', () => {
    const parsed = findFilesMatchingContentParams.inputSchema.parse({
      pattern: 'foo',
      flags: ['-g', '*.ts', '-t', 'ts'],
    })
    expect(parsed.flags).toEqual(['-g', '*.ts', '-t', 'ts'])
  })

  it('accepts every documented allowlisted flag in both spellings', () => {
    // Value flags (-g/--glob, -t/--type, -T/--type-not) REQUIRE a following
    // non-dash value token, so they are exercised separately with values; the
    // bare flags here are exactly the non-value allowlisted spellings.
    const parsed = findFilesMatchingContentParams.inputSchema.parse({
      pattern: 'foo',
      flags: [
        '-i',
        '--ignore-case',
        '-S',
        '--smart-case',
        '-s',
        '--case-sensitive',
        '-w',
        '--word-regexp',
        '-F',
        '--fixed-strings',
        '-U',
        '--multiline',
        '--multiline-dotall',
        // Accepted-and-ignored: line numbers are forced by the tool itself.
        '-n',
        '--line-number',
      ],
    })
    expect(parsed.flags).toHaveLength(15)
  })

  it('accepts the value-flag spellings each followed by their value', () => {
    const parsed = findFilesMatchingContentParams.inputSchema.parse({
      pattern: 'foo',
      flags: ['-g', '*.ts', '--glob', '*.tsx', '-t', 'ts', '--type', 'py', '-T', 'md', '--type-not', 'json'],
    })
    expect(parsed.flags).toHaveLength(12)
  })

  it('accepts a flag=value compound for a value flag', () => {
    const parsed = findFilesMatchingContentParams.inputSchema.parse({
      pattern: 'foo',
      flags: ['--glob=*.ts'],
    })
    expect(parsed.flags).toEqual(['--glob=*.ts'])
  })

  it('accepts a value token following a value flag', () => {
    const parsed = findFilesMatchingContentParams.inputSchema.parse({
      pattern: 'foo',
      flags: ['-t', 'ts'],
    })
    expect(parsed.flags).toEqual(['-t', 'ts'])
  })

  it('rejects a rejected output-shape flag', () => {
    for (const flag of ['-c', '--count-matches', '-l', '-v', '--exec', '-z']) {
      expect(
        findFilesMatchingContentParams.inputSchema.safeParse({
          pattern: 'foo',
          flags: [flag],
        }).success,
      ).toBe(false)
    }
  })

  it('rejects context flags this tool does not support', () => {
    for (const flag of ['-A', '-B', '-C', '-r', '--replace']) {
      expect(
        findFilesMatchingContentParams.inputSchema.safeParse({
          pattern: 'foo',
          flags: [flag, '2'],
        }).success,
      ).toBe(false)
    }
  })

  it('rejects an unknown flag token', () => {
    expect(
      findFilesMatchingContentParams.inputSchema.safeParse({
        pattern: 'foo',
        flags: ['--definitely-not-a-flag'],
      }).success,
    ).toBe(false)
  })

  it('rejects a non-string flags entry', () => {
    expect(
      findFilesMatchingContentParams.inputSchema.safeParse({
        pattern: 'foo',
        flags: [42],
      }).success,
    ).toBe(false)
  })

  it('stays JSON-Schema representable for the provider wire surface', () => {
    // The flags field is validated by a superRefine over a preprocessed argv
    // array, so the wire schema must still convert. Mirrors the portable-
    // wire-schema contract asserted registry-wide by
    // common/src/tools/__tests__/tool-registration-consistency.test.ts.
    expect(() =>
      z.toJSONSchema(findFilesMatchingContentParams.inputSchema, {
        io: 'input',
      }),
  ).not.toThrow()
  })
})
