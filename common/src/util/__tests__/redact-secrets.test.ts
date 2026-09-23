import { describe, expect, it } from 'bun:test'

import { redactSecretValues } from '../redact-secrets'

describe('redactSecretValues', () => {
  it('redacts sensitive-keyword assignments in shell/ini forms', () => {
    expect(redactSecretValues('export OPENAI_API_KEY=sk-abc123'))
      .toBe('export OPENAI_API_KEY=[REDACTED]')
    expect(redactSecretValues('AUTH_TOKEN="super-secret-value"'))
      .toBe('AUTH_TOKEN=[REDACTED]')
    expect(redactSecretValues('set MY_PASSWORD=hunter2'))
      .toBe('set MY_PASSWORD=[REDACTED]')
    expect(redactSecretValues('aws_secret_access_key: wJalrXUtnFEMI'))
      .toBe('aws_secret_access_key: [REDACTED]')
  })

  it('redacts well-known token shapes anywhere', () => {
    const sk = `sk-${'a'.repeat(24)}`
    expect(redactSecretValues(`curl -H "Authorization: ${sk}"`)).toBe(
      'curl -H "Authorization: [REDACTED]"',
    )
    expect(redactSecretValues(`token: ghp_${'b'.repeat(30)}`)).toBe(
      'token: [REDACTED]',
    )
    expect(redactSecretValues(`key = AKIA${'A1B2C3D4E5F6G7H8'}`)).toBe(
      'key = [REDACTED]',
    )
    expect(
      redactSecretValues(`Authorization: Bearer ${'c'.repeat(40)}`),
    ).toBe('Authorization: Bearer [REDACTED]')
  })

  it('redacts URL-embedded credentials', () => {
    expect(
      redactSecretValues('postgres://admin:s3cret@db.example.com:5432/app'),
    ).toBe('postgres://[REDACTED]@db.example.com:5432/app')
  })

  it('passes normal code and prose through unchanged', () => {
    const normal = [
      'export function formatName(first: string, last: string) {',
      '  return `${first} ${last}`',
      '}',
      'const retries = 3 // plain comment',
      'const apiKeyName = "OPENAI_API_KEY" // name mention is fine',
    ].join('\n')
    expect(redactSecretValues(normal)).toBe(normal)
  })

  it('handles empty input', () => {
    expect(redactSecretValues('')).toBe('')
  })
})
