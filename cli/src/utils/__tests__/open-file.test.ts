import { describe, expect, test } from 'bun:test'

import { buildEditorCommands } from '../open-file'

import type { CliEnv } from '../../types/env'

const makeEnv = (overrides: Partial<CliEnv> = {}): CliEnv =>
  ({ TERM_PROGRAM: '', ...overrides }) as CliEnv

describe('buildEditorCommands', () => {
  test('shell-escapes the path substituted for %f', () => {
    const commands = buildEditorCommands('a.ts; rm -rf ~', makeEnv({ EDITOR: 'vim %f' }))

    expect(commands[0]).toBe("vim 'a.ts; rm -rf ~'")
  })

  test('escapes single quotes in the path for POSIX shells', () => {
    const commands = buildEditorCommands("it's here.md", makeEnv({ EDITOR: 'vim %f' }))

    expect(commands[0]).toContain("it'\\''s here.md")
  })

  test('keeps shell metacharacters inside quotes for {file}', () => {
    const commands = buildEditorCommands(
      '$(touch pwned).ts',
      makeEnv({ EDITOR: 'code {file}' }),
    )

    expect(commands[0]).toBe("code '$(touch pwned).ts'")
  })

  test('appends the escaped path when the editor command has no placeholder', () => {
    const commands = buildEditorCommands('x.ts', makeEnv({ EDITOR: 'code' }))

    expect(commands[0]).toBe("code 'x.ts'")
  })

  test('falls back to the platform opener when no editor is configured', () => {
    const commands = buildEditorCommands('x.ts', makeEnv())
    const last = commands[commands.length - 1]

    if (process.platform === 'darwin') {
      expect(last.startsWith('open ')).toBe(true)
    } else {
      expect(last).toBe("xdg-open 'x.ts'")
    }
  })

  test('substitutes every occurrence of %f', () => {
    const commands = buildEditorCommands(
      'x.ts',
      makeEnv({ EDITOR: 'vim %f --open %f' }),
    )

    expect(commands[0]).toBe("vim 'x.ts' --open 'x.ts'")
  })
})
