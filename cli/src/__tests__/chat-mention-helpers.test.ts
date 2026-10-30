import { describe, expect, test } from 'bun:test'

import {
  buildMentionReplacement,
  resolveMentionReplacement,
} from '../utils/mention-helpers'

const agents = [{ id: 'agent-a' }, { id: 'agent-b' }]
const files = [
  { filePath: 'src/foo.ts', isDirectory: false },
  { filePath: 'src/bar.ts', isDirectory: false },
]

describe('resolveMentionReplacement', () => {
  test('returns null for out-of-range index when useFallback is false', () => {
    // index beyond both agent and file lists
    expect(resolveMentionReplacement(5, agents, files, false)).toBeNull()
  })

  test('returns null for out-of-range index in empty lists when useFallback is false', () => {
    expect(resolveMentionReplacement(0, [], [], false)).toBeNull()
  })

  test('falls back to first file entry when file index is out of range with useFallback true', () => {
    // index 99 puts us in the file branch (>= agents.length) with a huge fileIndex
    expect(
      resolveMentionReplacement(agents.length + 99, agents, files, true),
    ).toEqual({
      selectedFile: { filePath: 'src/foo.ts', isDirectory: false },
      replacement: '@src/foo.ts ',
    })
  })

  test('returns null when fallback list is also empty', () => {
    // file branch, no files to fall back to
    expect(resolveMentionReplacement(agents.length, agents, [], true)).toBeNull()
  })

  test('selects the correct agent when index is within agentMatches.length', () => {
    expect(resolveMentionReplacement(0, agents, files, false)).toEqual({
      replacement: '@agent-a ',
    })
    expect(resolveMentionReplacement(1, agents, files, false)).toEqual({
      replacement: '@agent-b ',
    })
  })

  test('agent/file split: last agent index is agentMatches.length - 1', () => {
    expect(
      resolveMentionReplacement(agents.length - 1, agents, files, false),
    ).toEqual({ replacement: '@agent-b ' })
  })

  test('agent/file split: first file index is agentMatches.length', () => {
    expect(
      resolveMentionReplacement(agents.length, agents, files, false),
    ).toEqual({
      selectedFile: { filePath: 'src/foo.ts', isDirectory: false },
      replacement: '@src/foo.ts ',
    })
  })

  test('selects second file at agentMatches.length + 1', () => {
    expect(
      resolveMentionReplacement(agents.length + 1, agents, files, false),
    ).toEqual({
      selectedFile: { filePath: 'src/bar.ts', isDirectory: false },
      replacement: '@src/bar.ts ',
    })
  })
})

describe('buildMentionReplacement', () => {
  test('cursor position is placed just after the inserted replacement', () => {
    const replacement = '@my-agent '
    const { cursorPosition } = buildMentionReplacement(
      '@partial',
      0,
      'partial',
      replacement,
    )
    expect(cursorPosition).toBe(replacement.length)
  })

  test('splices replacement into input, preserving text before and after the token', () => {
    const { text, cursorPosition } = buildMentionReplacement(
      'say @hi there',
      4,
      'hi',
      '@bot ',
    )
    // before='say ', replacement='@bot ', after=' there'
    expect(text).toBe('say @bot  there')
    expect(cursorPosition).toBe(4 + '@bot '.length)
  })

  test('handles mention at start of input', () => {
    const { text, cursorPosition } = buildMentionReplacement(
      '@abc rest',
      0,
      'abc',
      '@xyz ',
    )
    expect(text).toBe('@xyz  rest')
    expect(cursorPosition).toBe('@xyz '.length)
  })

  test('handles empty query (cursor positioned right after @)', () => {
    const { text, cursorPosition } = buildMentionReplacement(
      'foo @ end',
      4,
      '',
      '@bot ',
    )
    // before='foo ', after=' end', replacement='@bot '
    expect(text).toBe('foo @bot  end')
    expect(cursorPosition).toBe(4 + '@bot '.length)
  })

  test('handles mention at end of input with no trailing text', () => {
    const { text, cursorPosition } = buildMentionReplacement(
      '@query',
      0,
      'query',
      '@agent-a ',
    )
    expect(text).toBe('@agent-a ')
    expect(cursorPosition).toBe('@agent-a '.length)
  })
})
