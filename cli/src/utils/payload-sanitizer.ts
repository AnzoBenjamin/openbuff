const CHAT_STATE_MAX_STRING_LENGTH = 8_000
const DEBUG_LOG_MAX_STRING_LENGTH = 8_000
const DEBUG_LOG_MAX_ARRAY_LENGTH = 120
const DEBUG_LOG_MAX_OBJECT_KEYS = 160

/**
 * Hard bound on sanitizeValue recursion so a hostile deep payload cannot
 * crash the sanitizer (or its host) with a RangeError. Nesting deeper than
 * this is replaced with a truncation marker instead of being walked.
 */
const MAX_SANITIZE_DEPTH = 32

/**
 * Element/count caps for {@link sanitizeMediaForUiState}: UI state previously
 * used an unbounded string length with no array/key caps, so a huge tool
 * payload could be walked and serialized in full.
 */
const UI_STATE_MAX_ARRAY_LENGTH = 200
const UI_STATE_MAX_OBJECT_KEYS = 200

// Keys whose string values are credentials (OAuth tokens, API keys, bearer
// auth headers). When sanitizing an object, any value under a matching key is
// replaced with '[REDACTED]' so tokens never reach the debug log
// (debug/cli.jsonl) or persisted chat state. Redaction is keyed on the field
// NAME, not the value content, and is case-insensitive.
//
// Matching uses a word-boundary rule instead of a substring test so metadata
// keys that merely CONTAIN a credential substring (refreshTokenCount,
// maxTokens, tokenizer, secretSantaName) are kept. The key is tokenized into
// words across camelCase, PascalCase, snake_case, kebab-case, and
// SCREAMING_CASE, then classified SENSITIVE only when a credential word is
// either the terminal word (accessToken, apiKey) or immediately followed by a
// carrier-suffix word that still holds the secret (tokenUrl, tokenValue). A
// credential word followed by any other (descriptor) word is metadata (kept).
//
// Two common shapes still slip past that per-word rule and are handled by a
// normalized whole-key fallback below: the credential word itself is split by
// tokenization (privateKey becomes private + key, so the compound 'privatekey'
// entry never matches), and a credential word is followed by a non-carrier
// descriptor before a terminal 'key' (awsSecretAccessKey becomes aws + secret
// + access + key). The fallback matches the WHOLE normalized key against
// multi-word credential shapes and treats a terminal 'key'/'token' backed by
// a secret-holder word as sensitive. This is still whole-token/whole-key
// logic, so monkey, keyboard, and tokenize are never classified sensitive.

// Words that denote a credential itself.
const CREDENTIAL_WORDS = new Set([
  'token', 'secret', 'password', 'passwd', 'credential', 'credentials',
  'authorization', 'bearer', 'apikey', 'jwt', 'oauth', 'privatekey',
  'auth', 'passphrase', 'pwd',
])
// When one of these immediately FOLLOWS a credential word, the key still
// carries the secret value (tokenUrl, tokenValue, tokenString, ...). Anything
// else following a credential word (count, name, id, type, santa, ...) makes
// the key metadata about the credential, not the credential, so it is kept.
const CREDENTIAL_CARRIER_SUFFIXES = new Set([
  'url', 'uri', 'value', 'string', 'header', 'headers', 'secret', 'token',
  'key', 'hash', 'jwt', 'digest',
  // Serialized credential blobs (credentialsJson, api_key_json, ...).
  'json',
])

// Multi-word credential key shapes that the per-word scan misses: the
// credential word is split by tokenization (privateKey becomes private + key,
// so the compound 'privatekey' entry above never matches) or followed by a
// non-carrier descriptor before a terminal 'key' (awsSecretAccessKey becomes
// aws + secret + access + key). Matched against the WHOLE normalized key
// (lowercased, separators stripped) with exact equality, so benign keys that
// merely contain a credential substring (monkey, keyboard, tokenize) are
// never classified sensitive.
const SENSITIVE_KEY_SHAPES = new Set([
  'privatekey',
  'secretaccesskey',
  'awssecretaccesskey',
  'accesskey',
  'clientsecret',
])
// Words that name the secret a terminal 'key'/'token' holds
// (secretAccessKey, privateSigningKey, credentialAuthToken).
const SECRET_HOLDER_WORDS = new Set([
  'secret', 'private', 'credential', 'credentials', 'auth',
])
const TERMINAL_SECRET_SUFFIXES = new Set(['key', 'token'])

const normalizedKeyShape = (key: string): string =>
  key.toLowerCase().replace(/[^a-z0-9]/g, '')

const splitKeyWords = (key: string): string[] =>
  key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2') // camelCase boundary
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2') // ACRONYMWord boundary
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 0)

const mergeApiKeyWords = (words: string[]): string[] => {
  const merged: string[] = []
  for (let i = 0; i < words.length; i += 1) {
    if (words[i] === 'api' && words[i + 1] === 'key') {
      merged.push('apikey')
      i += 1
    } else {
      merged.push(words[i])
    }
  }
  return merged
}

const isSensitiveKey = (key: string): boolean => {
  const words = mergeApiKeyWords(splitKeyWords(key))
  for (let i = 0; i < words.length; i += 1) {
    if (!CREDENTIAL_WORDS.has(words[i])) continue
    const next = words[i + 1]
    // Terminal credential word, or a credential word whose following word is a
    // carrier suffix, means this key holds the secret itself.
    if (next === undefined || CREDENTIAL_CARRIER_SUFFIXES.has(next)) {
      return true
    }
    // Otherwise this occurrence is a descriptor (e.g. tokenCount); keep scanning
    // for another credential word before deciding the key is safe.
  }
  // Multi-word credential shapes the per-word scan misses: the credential
  // word is split by tokenization (privateKey becomes private + key) or
  // followed by a non-carrier descriptor before a terminal 'key'
  // (awsSecretAccessKey becomes aws + secret + access + key). The shape set
  // is matched against the WHOLE normalized key, so keys that merely contain
  // a credential substring (monkey, keyboard, tokenize) stay non-sensitive.
  if (SENSITIVE_KEY_SHAPES.has(normalizedKeyShape(key))) {
    return true
  }
  // A terminal 'key'/'token' backed by a secret-holder word holds the secret
  // itself (privateSigningKey, credentialAuthToken).
  const last = words[words.length - 1]
  if (
    last !== undefined &&
    TERMINAL_SECRET_SUFFIXES.has(last) &&
    words.slice(0, -1).some((word) => SECRET_HOLDER_WORDS.has(word))
  ) {
    return true
  }
  return false
}

type SanitizeOptions = {
  maxStringLength: number
  maxArrayLength?: number
  maxObjectKeys?: number
  purpose: string
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

const byteLengthOfBinary = (value: ArrayBuffer | ArrayBufferView): number =>
  value instanceof ArrayBuffer ? value.byteLength : value.byteLength

const truncateString = (value: string, options: SanitizeOptions): string => {
  if (value.length <= options.maxStringLength) {
    return value
  }

  const omitted = value.length - options.maxStringLength
  return `${value.slice(0, options.maxStringLength)}\n\n[Openbuff truncated ${omitted} chars while ${options.purpose}. Re-run the tool if the full output is needed.]`
}

const omittedMediaText = (params: {
  kind: 'file' | 'image' | 'media'
  mediaType?: unknown
  length: number
}): string => {
  const mediaType =
    typeof params.mediaType === 'string' ? ` ${params.mediaType}` : ''
  return `[Openbuff omitted persisted ${params.kind}${mediaType} payload (${params.length} base64 chars). Re-run read_image or reattach the image if needed.]`
}

const sanitizeObject = (
  value: Record<string, unknown>,
  options: SanitizeOptions,
  seen: WeakSet<object>,
  depth: number,
): unknown => {
  const type = typeof value.type === 'string' ? value.type : undefined

  if (type === 'media' && typeof value.data === 'string') {
    return {
      type: 'json',
      value: {
        mediaRedacted: true,
        mediaType: value.mediaType,
        dataLength: value.data.length,
        message: omittedMediaText({
          kind: 'media',
          mediaType: value.mediaType,
          length: value.data.length,
        }),
      },
    }
  }

  if (type === 'file' && typeof value.data === 'string') {
    return {
      type: 'text',
      text: omittedMediaText({
        kind: 'file',
        mediaType: value.mediaType,
        length: value.data.length,
      }),
    }
  }

  if (type === 'image' && typeof value.image === 'string') {
    const hasChatImageMetadata =
      'filename' in value ||
      'size' in value ||
      'width' in value ||
      'height' in value ||
      'isCollapsed' in value ||
      'userOpened' in value

    if (!hasChatImageMetadata) {
      return {
        type: 'text',
        text: omittedMediaText({
          kind: 'image',
          mediaType: value.mediaType,
          length: value.image.length,
        }),
      }
    }

    const redactedImageBlock: Record<string, unknown> = {}
    for (const [key, child] of Object.entries(value)) {
      redactedImageBlock[key] =
        key === 'image' ? '' : sanitizeValue(child, options, seen, depth + 1)
    }
    redactedImageBlock.imageRedacted = true
    redactedImageBlock.imageLength = value.image.length
    return redactedImageBlock
  }

  const entries = Object.entries(value)
  const maxObjectKeys = options.maxObjectKeys ?? entries.length
  const sanitized: Record<string, unknown> = {}

  for (const [index, [key, child]] of entries.entries()) {
    if (index >= maxObjectKeys) {
      sanitized.__openbuff_omitted_keys = entries.length - maxObjectKeys
      break
    }
    // Redact credential values by key name so OAuth tokens, API keys, and
    // bearer/authorization headers never reach the debug log or persisted
    // chat state. Objects under a sensitive key are still recursed into so
    // the *shape* (and any nested sensitive keys) is preserved, but their
    // string/URL values are replaced wholesale.
    if (isSensitiveKey(key)) {
      sanitized[key] = redactSensitiveValue(child, options, seen, depth + 1)
    } else {
      sanitized[key] = sanitizeValue(child, options, seen, depth + 1)
    }
  }

  return sanitized
}

const redactSensitiveValue = (
  value: unknown,
  options: SanitizeOptions,
  seen: WeakSet<object>,
  depth: number,
): unknown => {
  if (typeof value === 'string') {
    return '[REDACTED]'
  }
  if (value instanceof URL) {
    return '[REDACTED]'
  }
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
    return '[REDACTED]'
  }
  return sanitizeValue(value, options, seen, depth)
}

const sanitizeArray = (
  value: unknown[],
  options: SanitizeOptions,
  seen: WeakSet<object>,
  depth: number,
): unknown[] => {
  const maxArrayLength = options.maxArrayLength ?? value.length
  const sanitized = value
    .slice(0, maxArrayLength)
    .map((child) => sanitizeValue(child, options, seen, depth + 1))

  if (value.length > maxArrayLength) {
    sanitized.push(
      `[Openbuff omitted ${value.length - maxArrayLength} array items while ${options.purpose}.]`,
    )
  }

  return sanitized
}

const sanitizeValue = (
  value: unknown,
  options: SanitizeOptions,
  seen: WeakSet<object>,
  depth: number = 0,
): unknown => {
  if (depth >= MAX_SANITIZE_DEPTH) {
    return `[Openbuff omitted payload nested deeper than ${MAX_SANITIZE_DEPTH} levels while ${options.purpose}.]`
  }
  if (typeof value === 'string') {
    return truncateString(value, options)
  }

  if (!isRecord(value)) {
    return value
  }

  if (value instanceof Date) {
    return value.toISOString()
  }

  if (value instanceof URL) {
    return value.toString()
  }

  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
    return `[Openbuff redacted binary payload (${byteLengthOfBinary(value)} bytes) while ${options.purpose}.]`
  }

  if (seen.has(value)) {
    return '[Circular]'
  }

  seen.add(value)
  try {
    if (Array.isArray(value)) {
      return sanitizeArray(value, options, seen, depth)
    }

    return sanitizeObject(value, options, seen, depth)
  } finally {
    seen.delete(value)
  }
}

export function sanitizeForChatPersistence<T>(value: T): T {
  return sanitizeValue(
    value,
    {
      maxStringLength: CHAT_STATE_MAX_STRING_LENGTH,
      purpose: 'saving chat state',
    },
    new WeakSet(),
  ) as T
}

export function sanitizeForDebugLog<T>(value: T): T {
  return sanitizeValue(
    value,
    {
      maxStringLength: DEBUG_LOG_MAX_STRING_LENGTH,
      maxArrayLength: DEBUG_LOG_MAX_ARRAY_LENGTH,
      maxObjectKeys: DEBUG_LOG_MAX_OBJECT_KEYS,
      purpose: 'writing the debug log',
    },
    new WeakSet(),
  ) as T
}

export function sanitizeMediaForUiState<T>(value: T): T {
  return sanitizeValue(
    value,
    {
      // Bounded even for UI state: an unbounded string length let a huge tool
      // payload walk and serialize in full (and the recursion caps still apply
      // independently). Array/key caps bound the element count so deep/wide
      // payloads cannot crash the UI with a RangeError.
      maxStringLength: Number.MAX_SAFE_INTEGER,
      maxArrayLength: UI_STATE_MAX_ARRAY_LENGTH,
      maxObjectKeys: UI_STATE_MAX_OBJECT_KEYS,
      purpose: 'rendering tool output',
    },
    new WeakSet(),
  ) as T
}
