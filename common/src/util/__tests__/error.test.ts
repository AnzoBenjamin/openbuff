import { describe, expect, it } from 'bun:test'

import {
  classifyStructuredEditError,
  errorCode,
  getErrorObject,
  isStructuredEditErrorCode,
  structuredEditErrorCodes,
} from '../error'

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

describe('structuredEditErrorCodes', () => {
  it('is the closed, sorted vocabulary of every emitted edit error code', () => {
    // Collected from the actual emitting sites: process-edit-transaction's
    // public errorCode union ('no_match' | 'stale_capability' |
    // 'preflight_failed'), the edit-transaction handler's payload_truncated
    // (PAYLOAD_TRUNCATED_ERROR_CODE), the str-replace handler's
    // 'fresh_read_required' / 'str_replace_circuit_breaker', and the
    // replace-range handler's (replace-range.ts) 'occurrence_not_found'
    // (occurrence targeting resolved 0 matches or an out-of-range index).
    // The result schema's errorCode field is an open z.string(), so this
    // tuple is the closed source of truth — pin it so an accidental change
    // is caught.
    expect(structuredEditErrorCodes).toEqual([
      'fresh_read_required',
      'no_match',
      'occurrence_not_found',
      'payload_truncated',
      'preflight_failed',
      'stale_capability',
      'str_replace_circuit_breaker',
    ])
  })
})

describe('isStructuredEditErrorCode', () => {
  it('accepts exactly the vocabulary codes and nothing else', () => {
    for (const code of structuredEditErrorCodes) {
      expect(isStructuredEditErrorCode(code)).toBe(true)
    }
    expect(isStructuredEditErrorCode('EACCES')).toBe(false)
    expect(isStructuredEditErrorCode(42)).toBe(false)
    expect(isStructuredEditErrorCode(null)).toBe(false)
    expect(isStructuredEditErrorCode(undefined)).toBe(false)
    expect(isStructuredEditErrorCode({ code: 'no_match' })).toBe(false)
  })
})

describe('getErrorObject secret redaction', () => {
  it('redacts API-key assignments and sk- tokens in responseBody', () => {
    // M1-T5: API error bodies can echo request secrets (API keys in
    // headers/body), so getErrorObject must redact them before they reach any
    // log sink or serialized payload.
    const err = Object.assign(new Error('provider rejected request'), {
      responseBody: JSON.stringify({
        error: {
          message: 'invalid OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwx',
        },
      }),
    })
    const result = getErrorObject(err)
    expect(result.responseBody).toBeDefined()
    expect(result.responseBody).toContain('[REDACTED]')
    expect(result.responseBody).not.toContain('sk-proj-abcdefghijklmnopqrstuvwx')
  })

  it('redacts secrets in requestBodyValues', () => {
    // Request bodies carry the prompt/messages, which can embed secret file
    // contents read during the run (M1-T5).
    const err = Object.assign(new Error('request failed'), {
      requestBodyValues: {
        messages: [
          {
            role: 'user',
            content: 'GITHUB_TOKEN="ghp_' + 'x'.repeat(36) + '"',
          },
        ],
      },
    })
    const result = getErrorObject(err)
    expect(result.requestBodyValues).toBeDefined()
    expect(result.requestBodyValues).toContain('[REDACTED]')
    expect(result.requestBodyValues).not.toContain('GITHUB_TOKEN="ghp_')
  })

  it('redacts rawError when includeRawError is set', () => {
    // Raw provider error dumps can carry request payloads; only opt-in
    // inclusion survives, and only redacted (M1-T5).
    const err = Object.assign(new Error('raw dump check'), {
      responseBody: 'authorization: Bearer ' + 'y'.repeat(40),
    })
    const withRaw = getErrorObject(err, { includeRawError: true })
    expect(withRaw.rawError).toBeDefined()
    expect(withRaw.rawError).toContain('[REDACTED]')
    // The redacted raw dump must not retain the bearer token.
    expect(withRaw.rawError).not.toContain('Bearer ' + 'y'.repeat(40))

    const withoutRaw = getErrorObject(new Error('no raw requested'))
    expect(withoutRaw.rawError).toBeUndefined()
  })

  it('leaves secret-free responseBody and requestBodyValues unchanged', () => {
    // Design contract: conservative redaction — normal payload content passes
    // through untouched so debugging info is not mangled.
    const body = JSON.stringify({ error: { message: 'rate limited' } })
    const err = Object.assign(new Error('throttled'), {
      responseBody: body,
      requestBodyValues: { model: 'gpt-4' },
    })
    const result = getErrorObject(err)
    expect(result.responseBody).toBe(body)
    expect(result.requestBodyValues).toContain('"model": "gpt-4"')
  })
})

describe('classifyStructuredEditError', () => {
  it('returns the typed code and message for errors carrying a vocabulary code', () => {
    const err = Object.assign(new Error('edit aborted during preflight'), {
      code: 'no_match',
    })
    expect(classifyStructuredEditError(err)).toEqual({
      code: 'no_match',
      message: 'edit aborted during preflight',
    })
    expect(
      classifyStructuredEditError({
        code: 'stale_capability',
        message: 'stale token',
      }),
    ).toEqual({
      code: 'stale_capability',
      message: 'stale token',
    })
  })

  it('returns undefined (fail-closed) when the code is missing or outside the vocabulary', () => {
    // A Node fs error's EACCES is a real `code` but NOT a structured edit
    // code: the classifier must refuse to classify rather than let a caller
    // guess from the message text.
    expect(
      classifyStructuredEditError(
        Object.assign(new Error('denied'), { code: 'EACCES' }),
      ),
    ).toBeUndefined()
    expect(classifyStructuredEditError(new Error('no code'))).toBeUndefined()
    expect(classifyStructuredEditError(null)).toBeUndefined()
    expect(classifyStructuredEditError(undefined)).toBeUndefined()
    expect(classifyStructuredEditError({ code: 42 })).toBeUndefined()
  })

  it('falls back to String(err) when the throw carries no message property', () => {
    expect(classifyStructuredEditError({ code: 'no_match' })).toEqual({
      code: 'no_match',
      message: '[object Object]',
    })
  })
})
