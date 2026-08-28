import { describe, expect, it } from 'bun:test'

import { errorCode } from '../error'

describe('errorCode', () => {
  it('returns a string `code` and undefined for anything else', () => {
    // The gate-telemetry sink's ENOENT narrowing and the runtime sink's warn
    // latch both key off this helper, so a non-string `code` and a non-object
    // throw must both report "no code" rather than leak a non-string value.
    const fsError = Object.assign(new Error('denied'), { code: 'EACCES' })
    expect(errorCode(fsError)).toBe('EACCES')
    expect(errorCode({ code: 42 })).toBeUndefined()
    expect(errorCode('EACCES')).toBeUndefined()
    expect(errorCode(null)).toBeUndefined()
    expect(errorCode(new Error('no code'))).toBeUndefined()
  })
})
