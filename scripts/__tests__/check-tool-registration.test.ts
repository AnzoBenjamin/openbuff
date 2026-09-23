import { describe, expect, test } from 'bun:test'

import {
  checkTool,
  sourceRegistersHandlerKey,
} from '../check-tool-registration'

describe('tool registration readiness checker', () => {
  test('covers every required registration and presentation layer', () => {
    const checks = checkTool('inspect_environment')
    expect(checks.map((check) => check.label)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('constants.ts'),
        expect.stringContaining('params schema'),
        expect.stringContaining('published SDK'),
        expect.stringContaining('runtime handler'),
        expect.stringContaining('SDK dispatch'),
        expect.stringContaining('generated agent tool type'),
        expect.stringContaining('initial .agents template'),
        expect.stringContaining('CLI generated'),
        expect.stringContaining('CLI renderer metadata'),
        expect.stringContaining('CLI renderer registry'),
        expect.stringContaining('docs/'),
      ]),
    )
    expect(checks.filter((check) => !check.ok)).toEqual([])
  })

  test('runtime handler check matches a real property key (M4-T3)', () => {
    const handlersList = `
import { inspectEnvironment } from './tool/inspect-environment'

export const handlers = {
  inspect_environment: inspectEnvironment,
  overwrite: overwriteHandler,
}
`
    expect(sourceRegistersHandlerKey(handlersList, 'inspect_environment')).toBe(
      true,
    )
  })

  test('runtime handler check rejects prefix-collision substrings (M4-T3)', () => {
    // Regression for the audit finding: the old substring check
    // `fileMentions(path, 'write:')` was satisfied by the longer sibling key
    // `overwrite:`, falsely reporting the runtime layer wired for `write`.
    const handlersList = `
export const handlers = {
  overwrite: overwriteHandler,
}
`
    expect(sourceRegistersHandlerKey(handlersList, 'write')).toBe(false)
  })

  test('runtime handler check ignores commented-out registrations (M4-T3)', () => {
    const handlersList = `
export const handlers = {
  // write: writeHandler,
  overwrite: overwriteHandler,
}
`
    expect(sourceRegistersHandlerKey(handlersList, 'write')).toBe(false)
  })
})
