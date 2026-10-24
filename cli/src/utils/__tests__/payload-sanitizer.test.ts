import { describe, expect, test } from 'bun:test'

import {
  sanitizeForChatPersistence,
  sanitizeForDebugLog,
  sanitizeMediaForUiState,
} from '../payload-sanitizer'

describe('payload-sanitizer', () => {
  test('redacts media tool results into json placeholders for persisted chat state', () => {
    const payload = [
      {
        type: 'json',
        value: { images: [{ path: 'current.png', status: 'attached' }] },
      },
      {
        type: 'media',
        data: 'a'.repeat(120_000),
        mediaType: 'image/png',
      },
    ]

    const sanitized = sanitizeForChatPersistence(payload) as any[]

    expect(sanitized[0].value.images[0].path).toBe('current.png')
    expect(sanitized[1].type).toBe('json')
    expect(sanitized[1].value.mediaRedacted).toBe(true)
    expect(sanitized[1].value.dataLength).toBe(120_000)
    expect(JSON.stringify(sanitized)).not.toContain('a'.repeat(1_000))
  })

  test('turns persisted model file and image parts into text placeholders', () => {
    const payload = {
      messageHistory: [
        {
          role: 'user',
          content: [
            {
              type: 'file',
              data: 'b'.repeat(90_000),
              mediaType: 'image/png',
            },
            {
              type: 'image',
              image: 'c'.repeat(90_000),
              mediaType: 'image/jpeg',
            },
          ],
        },
      ],
    }

    const sanitized = sanitizeForChatPersistence(payload) as any
    const content = sanitized.messageHistory[0].content

    expect(content[0].type).toBe('text')
    expect(content[0].text).toContain(
      'omitted persisted file image/png payload',
    )
    expect(content[1].type).toBe('text')
    expect(content[1].text).toContain(
      'omitted persisted image image/jpeg payload',
    )
    expect(JSON.stringify(sanitized)).not.toContain('b'.repeat(1_000))
    expect(JSON.stringify(sanitized)).not.toContain('c'.repeat(1_000))
  })

  test('keeps UI image block metadata while dropping base64 image data', () => {
    const payload = {
      type: 'image',
      image: 'd'.repeat(90_000),
      mediaType: 'image/png',
      filename: 'current.png',
      size: 1234,
      width: 640,
      height: 480,
    }

    const sanitized = sanitizeForChatPersistence(payload) as any

    expect(sanitized.type).toBe('image')
    expect(sanitized.image).toBe('')
    expect(sanitized.imageRedacted).toBe(true)
    expect(sanitized.imageLength).toBe(90_000)
    expect(sanitized.filename).toBe('current.png')
  })

  test('truncates very large persisted strings', () => {
    const payload = {
      blocks: [
        {
          type: 'tool',
          toolName: 'read_files',
          output: 'x'.repeat(90_000),
        },
      ],
    }

    const sanitized = sanitizeForChatPersistence(payload) as any
    const output = sanitized.blocks[0].output

    expect(output.length).toBeLessThan(10_000)
    expect(output).toContain('Openbuff truncated')
  })

  test('debug log sanitizer caps arrays, strings, and circular references', () => {
    const payload: any = {
      values: Array.from({ length: 130 }, (_, index) => index),
      output: 'z'.repeat(20_000),
    }
    payload.self = payload

    const sanitized = sanitizeForDebugLog(payload) as any

    expect(sanitized.values).toHaveLength(121)
    expect(sanitized.values[120]).toContain('omitted 10 array items')
    expect(sanitized.output.length).toBeLessThan(9_000)
    expect(sanitized.self).toBe('[Circular]')
  })
})

describe('payload-sanitizer token redaction', () => {
  test('redacts OAuth token fields across casing variants in debug logs', () => {
    const secret = 'sk-very-long-secret-oauth-token-value-1234567890'
    const payload = {
      chatgptOAuth: {
        accessToken: secret,
        refresh_token: secret,
        id_token: secret,
      },
      headers: { Authorization: `Bearer ${secret}` },
      apiKey: secret,
      api_key: secret,
      APIKEY: secret,
      normal: 'kept',
    }

    const sanitized = sanitizeForDebugLog(payload) as any

    expect(sanitized.chatgptOAuth.accessToken).toBe('[REDACTED]')
    expect(sanitized.chatgptOAuth.refresh_token).toBe('[REDACTED]')
    expect(sanitized.chatgptOAuth.id_token).toBe('[REDACTED]')
    expect(sanitized.headers.Authorization).toBe('[REDACTED]')
    expect(sanitized.apiKey).toBe('[REDACTED]')
    expect(sanitized.api_key).toBe('[REDACTED]')
    expect(sanitized.APIKEY).toBe('[REDACTED]')
    expect(sanitized.normal).toBe('kept')
    expect(JSON.stringify(sanitized)).not.toContain(secret)
  })

  test('redacts token values in persisted chat state too', () => {
    const secret = 'sk-secret-access-token-xyz'
    const payload = {
      credentials: { accessToken: secret, refreshToken: secret },
      meta: { token: secret },
    }

    const sanitized = sanitizeForChatPersistence(payload) as any

    expect(sanitized.credentials.accessToken).toBe('[REDACTED]')
    expect(sanitized.credentials.refreshToken).toBe('[REDACTED]')
    expect(sanitized.meta.token).toBe('[REDACTED]')
    expect(JSON.stringify(sanitized)).not.toContain(secret)
  })

  test('preserves object shape under sensitive keys; nested non-sensitive string keys are kept', () => {
    const secret = 'sk-nested-secret-token'
    const payload = {
      token: { value: secret, type: 'bearer', safe: 'keep' },
    }

    const sanitized = sanitizeForDebugLog(payload) as any

    // The outer key 'token' is sensitive, but its value is an object. We
    // recurse to preserve the shape. Inner keys are NOT redacted by the
    // outer key name — redaction is keyed on field name, not value content —
    // so 'value' (a non-sensitive key) keeps its string. This documents the
    // contract: nest credentials under a sensitive key name to protect them,
    // or use a sensitive key name directly.
    expect(typeof sanitized.token).toBe('object')
    expect(sanitized.token.value).toBe(secret)
    expect(sanitized.token.type).toBe('bearer')
    expect(sanitized.token.safe).toBe('keep')
  })

  test('redacts nested strings when the nested key is itself sensitive', () => {
    const secret = 'sk-nested-secret-token'
    const payload = {
      config: { access_token: secret, description: 'keep this text' },
    }

    const sanitized = sanitizeForDebugLog(payload) as any

    expect(sanitized.config.access_token).toBe('[REDACTED]')
    expect(sanitized.config.description).toBe('keep this text')
    expect(JSON.stringify(sanitized)).not.toContain(secret)
  })

  test('redacts URL values under sensitive keys', () => {
    const secret = 'abcdef-secret-token-in-url'
    const payload = {
      tokenUrl: new URL(`https://example.com/auth?access_token=${secret}`),
      normalUrl: new URL('https://example.com/safe'),
    }

    const sanitized = sanitizeForDebugLog(payload) as any

    expect(sanitized.tokenUrl).toBe('[REDACTED]')
    expect(sanitized.normalUrl).toBe('https://example.com/safe')
    expect(JSON.stringify(sanitized)).not.toContain(secret)
  })

  test('redacts the added credential words (auth, passphrase, pwd) and credentialsJson', () => {
    const addedSecret = 'sk-newly-covered-credential-value'
    const payload = {
      auth: addedSecret,
      authHeader: addedSecret,
      authorizationHeader: addedSecret,
      passphrase: addedSecret,
      sudoPassphrase: addedSecret,
      pwd: addedSecret,
      dbPwd: addedSecret,
      credentialsJson: addedSecret,
      api_key_json: addedSecret,
      // Metadata keys that merely CONTAIN the new words stay kept.
      authorized: 'kept',
      pwdLength: 'kept',
      authAttemptCount: 'kept',
      passphraseHintQuestion: 'kept',
    }

    const sanitized = sanitizeForDebugLog(payload) as any

    expect(sanitized.auth).toBe('[REDACTED]')
    expect(sanitized.authHeader).toBe('[REDACTED]')
    expect(sanitized.authorizationHeader).toBe('[REDACTED]')
    expect(sanitized.passphrase).toBe('[REDACTED]')
    expect(sanitized.sudoPassphrase).toBe('[REDACTED]')
    expect(sanitized.pwd).toBe('[REDACTED]')
    expect(sanitized.dbPwd).toBe('[REDACTED]')
    expect(sanitized.credentialsJson).toBe('[REDACTED]')
    expect(sanitized.api_key_json).toBe('[REDACTED]')
    expect(sanitized.authorized).toBe('kept')
    expect(sanitized.pwdLength).toBe('kept')
    expect(sanitized.authAttemptCount).toBe('kept')
    expect(sanitized.passphraseHintQuestion).toBe('kept')
    expect(JSON.stringify(sanitized)).not.toContain(addedSecret)
  })

  test('added credential words redact in persisted chat state too', () => {
    const addedSecret = 'sk-chat-persist-credential-value'
    const sanitized = sanitizeForChatPersistence({
      passphrase: addedSecret,
      credentialsJson: addedSecret,
    }) as any

    expect(sanitized.passphrase).toBe('[REDACTED]')
    expect(sanitized.credentialsJson).toBe('[REDACTED]')
    expect(JSON.stringify(sanitized)).not.toContain(addedSecret)
  })

  test('sanitizeMediaForUiState caps deep recursion instead of crashing', () => {
    // Build a payload nested far deeper than MAX_SANITIZE_DEPTH.
    let deep: any = { leaf: 'bottom' }
    for (let i = 0; i < 200; i += 1) deep = { nested: deep }

    const sanitized = sanitizeMediaForUiState({ root: deep }) as any

    // Walk down to the depth cutoff: the branch below the bound is replaced
    // with a truncation marker rather than walking (and crashing) further.
    let node = sanitized.root
    let depth = 0
    while (node && typeof node === 'object' && node.nested) {
      node = node.nested
      depth += 1
    }
    expect(depth).toBeLessThanOrEqual(32)
    expect(typeof node === 'string' || node.leaf === 'bottom').toBe(true)
    expect(JSON.stringify(sanitized)).toContain('nested deeper than 32 levels')
  })

  test('sanitizeMediaForUiState caps array and object element counts', () => {
    const payload = {
      items: Array.from({ length: 500 }, (_, i) => `item-${i}`),
      wide: Object.fromEntries(
        Array.from({ length: 500 }, (_, i) => [`k${i}`, `v${i}`]),
      ),
    }

    const sanitized = sanitizeMediaForUiState(payload) as any

    expect(sanitized.items.length).toBeLessThanOrEqual(201)
    expect(JSON.stringify(sanitized)).toContain('omitted')
    expect(Object.keys(sanitized.wide).length).toBeLessThanOrEqual(201)
    expect(sanitized.wide.__openbuff_omitted_keys).toBeGreaterThan(0)
  })
})

describe('payload-sanitizer word-boundary key redaction', () => {
  const secret = 'sk-planted-secret-credential-value-should-never-leak'

  const REDACT_KEYS = [
    'accessToken',
    'refresh_token',
    'id_token',
    'Authorization',
    'apiKey',
    'api_key',
    'APIKEY',
    'token',
    'refreshToken',
    'access_token',
    'secret',
    'clientSecret',
    'x-api-key',
    'password',
    'oldPassword',
    'credentials',
    'tokenUrl',
    'tokenValue',
  ]

  const KEEP_KEYS = [
    'normalUrl',
    'refreshTokenCount',
    'tokenCount',
    'maxTokens',
    'tokenizer',
    'tokenizerName',
    'secretSantaName',
    'secretSantaAssignment',
    'description',
    'normal',
    'safe',
    'value',
  ]

  test('redacts every real credential key in debug logs', () => {
    for (const key of REDACT_KEYS) {
      const sanitized = sanitizeForDebugLog({ [key]: secret }) as any
      expect(sanitized[key]).toBe('[REDACTED]')
      expect(JSON.stringify(sanitized)).not.toContain(secret)
    }
  })

  test('keeps metadata keys verbatim in debug logs', () => {
    for (const key of KEEP_KEYS) {
      const sanitized = sanitizeForDebugLog({ [key]: secret }) as any
      expect(sanitized[key]).toBe(secret)
      expect(JSON.stringify(sanitized)).toContain(secret)
    }
  })

  test('redacts every real credential key in persisted chat state', () => {
    for (const key of REDACT_KEYS) {
      const sanitized = sanitizeForChatPersistence({ [key]: secret }) as any
      expect(sanitized[key]).toBe('[REDACTED]')
      expect(JSON.stringify(sanitized)).not.toContain(secret)
    }
  })

  test('keeps metadata keys verbatim in persisted chat state', () => {
    for (const key of KEEP_KEYS) {
      const sanitized = sanitizeForChatPersistence({ [key]: secret }) as any
      expect(sanitized[key]).toBe(secret)
      expect(JSON.stringify(sanitized)).toContain(secret)
    }
  })

  test('classifies a mixed payload of redacted and kept keys in one pass', () => {
    const payload: Record<string, string> = {}
    for (const key of REDACT_KEYS) payload[key] = secret
    for (const key of KEEP_KEYS) payload[key] = `kept-${key}`

    const sanitized = sanitizeForDebugLog(payload) as any

    for (const key of REDACT_KEYS) {
      expect(sanitized[key]).toBe('[REDACTED]')
    }
    for (const key of KEEP_KEYS) {
      expect(sanitized[key]).toBe(`kept-${key}`)
    }
    expect(JSON.stringify(sanitized)).not.toContain(secret)
  })
})

describe('payload-sanitizer multi-word credential key shapes (PS-1)', () => {
  const secret = 'sk-multiword-credential-value-should-never-leak'

  // Keys whose credential word is split by tokenization (privateKey becomes
  // private + key) or followed by a non-carrier descriptor before a terminal
  // 'key' (awsSecretAccessKey becomes aws + secret + access + key,
  // access_key becomes access + key). privateSigningKey is covered by the
  // terminal-'key'-backed-by-secret-holder rule instead of a shape entry.
  const MULTI_WORD_REDACT_KEYS = [
    'privateKey',
    'private_key',
    'PRIVATE_KEY',
    'awsSecretAccessKey',
    'aws_secret_access_key',
    'access_key',
    'secretAccessKey',
    'clientSecret',
    'privateSigningKey',
  ]

  // Innocuous keys that merely contain credential-ish substrings or use a
  // credential word as a descriptor must stay kept: classification is
  // whole-token/whole-key, never substring matching.
  const SHAPE_KEEP_KEYS = [
    'monkey',
    'keyboard',
    'tokenize',
    'tokenizerName',
    'publicKey',
    'accessKeyCount',
    'privateKeyCount',
    'secretSantaName',
    'awsAccessKeyId',
  ]

  test('redacts split multi-word credential keys in debug logs', () => {
    for (const key of MULTI_WORD_REDACT_KEYS) {
      const sanitized = sanitizeForDebugLog({ [key]: secret }) as any
      expect(sanitized[key]).toBe('[REDACTED]')
      expect(JSON.stringify(sanitized)).not.toContain(secret)
    }
  })

  test('redacts split multi-word credential keys in persisted chat state', () => {
    for (const key of MULTI_WORD_REDACT_KEYS) {
      const sanitized = sanitizeForChatPersistence({ [key]: secret }) as any
      expect(sanitized[key]).toBe('[REDACTED]')
      expect(JSON.stringify(sanitized)).not.toContain(secret)
    }
  })

  test('keeps innocuous substring and descriptor keys verbatim in debug logs', () => {
    for (const key of SHAPE_KEEP_KEYS) {
      const sanitized = sanitizeForDebugLog({ [key]: secret }) as any
      expect(sanitized[key]).toBe(secret)
      expect(JSON.stringify(sanitized)).toContain(secret)
    }
  })

  test('keeps innocuous substring and descriptor keys verbatim in chat state', () => {
    for (const key of SHAPE_KEEP_KEYS) {
      const sanitized = sanitizeForChatPersistence({ [key]: secret }) as any
      expect(sanitized[key]).toBe(secret)
      expect(JSON.stringify(sanitized)).toContain(secret)
    }
  })

  test('classifies mixed multi-word shapes and innocuous keys in one pass', () => {
    const payload: Record<string, string> = {}
    for (const key of MULTI_WORD_REDACT_KEYS) payload[key] = secret
    for (const key of SHAPE_KEEP_KEYS) payload[key] = `kept-${key}`

    const sanitized = sanitizeForDebugLog(payload) as any

    for (const key of MULTI_WORD_REDACT_KEYS) {
      expect(sanitized[key]).toBe('[REDACTED]')
    }
    for (const key of SHAPE_KEEP_KEYS) {
      expect(sanitized[key]).toBe(`kept-${key}`)
    }
    expect(JSON.stringify(sanitized)).not.toContain(secret)
  })
})
