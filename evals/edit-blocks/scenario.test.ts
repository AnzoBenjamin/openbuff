/**
 * Edit-blocks eval (deterministic, no LLM, no network).
 *
 * PR-T4 (D22) wave 2: pins the flag-gated plain-text SEARCH/REPLACE
 * edit-block surface of edit_transaction against the real zod schemas from
 * @codebuff/common. Companion to the wave-1 parser unit tests in
 * common/src/tools/params/__tests__/edit-blocks.test.ts: those pin the
 * parser and the preprocess seam; this scenario pins the end-to-end
 * provider contract and the motivating payload-size economics.
 *
 * Metrics:
 *  - EB1 equivalence: for a fixture corpus of realistic edit payloads, the
 *    block payload and the JSON-encoded equivalent edit array parse to
 *    deep-equal transactions through editTransactionParams.inputSchema, and
 *    both surfaces (inputSchema and providerInputSchema) accept the block
 *    payload string while the flag is on.
 *  - EB2 escaping overhead: the block payload is never larger than the
 *    JSON.stringify-ed edits array for code-bearing fixtures (JSON must
 *    escape every newline and quote; blocks carry code verbatim). Measured
 *    sizes and ratios are logged as a summary.
 *  - EB3 adversarial injection: marker collisions inside SEARCH bodies,
 *    JSON/block mixtures, and prose outside blocks all FAIL schema
 *    validation end to end instead of producing a corrupted edit.
 *  - EB4 flag-off identity: with the flag forced off at runtime, the same
 *    JSON payloads parse identically and block payloads are rejected, so
 *    the default path stays untouched.
 */
import { afterEach, describe, expect, test } from 'bun:test'

// The edit-transaction tool params read OPENBUFF_EDIT_BLOCKS exactly once,
// at module load, to decide whether the block-format schema arms and the
// description section exist at all. The env var therefore must be set
// before the (dynamic) imports below: a static import would be hoisted
// above this line and build the flag-off surface instead. If another test
// file in the same process has already imported the module with the flag
// off, the EB1 probe below fails with that signal.
process.env.OPENBUFF_EDIT_BLOCKS = '1'

const { __setEditBlocksEnabledForTest, parseEditBlocks } = await import(
  '@codebuff/common/tools/params/edit-blocks'
)
// Force the cached flag on before the tool params module loads: the cache
// may already hold a stale value if another test file ran first in this
// process.
__setEditBlocksEnabledForTest(true)
const { editTransactionParams } = await import(
  '@codebuff/common/tools/params/tool/edit-transaction'
)

// The flag is cached inside the module at first use (module load above);
// restore the environment immediately so test files loaded later in the
// same process keep building the default flag-off surface.
delete process.env.OPENBUFF_EDIT_BLOCKS

/** Builds one SEARCH/REPLACE block; body strings may contain \n. */
const block = (path: string, search: string, replace: string): string =>
  [
    path,
    '<<<<<<< SEARCH',
    search,
    '=======',
    replace,
    '>>>>>>> REPLACE',
  ].join('\n')

type EditBlocksFixture = {
  name: string
  /** Files in payload order; each file's replacements stay in order. */
  files: Array<{
    path: string
    replacements: Array<{ search: string; replace: string }>
  }>
}

const FIXTURES: EditBlocksFixture[] = [
  {
    name: 'multi-replacement-single-file',
    files: [
      {
        path: 'src/services/session-store.ts',
        replacements: [
          {
            search: `export function loadSession(id: string): StoredSession | null {
  const raw = this.sessions.get(id)
  if (!raw) {
    return null
  }
  if (isExpired(raw)) {
    this.sessions.delete(id)
    return null
  }
  return deserializeSession(raw)
}`,
            replace: `export function loadSession(id: string): StoredSession | null {
  const raw = this.sessions.get(id)
  if (!raw) {
    metrics.count("session.miss")
    return null
  }
  if (isExpired(raw)) {
    this.sessions.delete(id)
    metrics.count("session.expired")
    return null
  }
  return deserializeSession(raw)
}`,
          },
          {
            search: `  touch(id: string): void {
    const session = this.sessions.get(id)
    if (session) {
      session.lastSeenAt = Date.now()
    }
  }`,
            replace: `  touch(id: string): void {
    const session = this.sessions.get(id)
    if (session) {
      session.lastSeenAt = Date.now()
      session.touchCount = (session.touchCount ?? 0) + 1
    }
  }`,
          },
        ],
      },
    ],
  },
  {
    name: 'multi-file',
    files: [
      {
        path: 'src/auth/token-refresh.ts',
        replacements: [
          {
            search: `export function isTokenExpired(token: AuthToken): boolean {
  if (!token.expiresAt) {
    return true
  }
  return token.expiresAt <= Date.now()
}`,
            replace: `export function isTokenExpired(token: AuthToken): boolean {
  if (!token.expiresAt) {
    metrics.count("token.missing-expiry")
    return true
  }
  return token.expiresAt <= Date.now()
}`,
          },
        ],
      },
      {
        path: 'src/auth/retry-policy.ts',
        replacements: [
          {
            search: `export function shouldRetry(error: unknown): boolean {
  if (error instanceof NetworkError) {
    return true
  }
  if (error instanceof RateLimitError) {
    return true
  }
  return false
}`,
            replace: `export function shouldRetry(error: unknown): boolean {
  if (error instanceof NetworkError) {
    return !isFatalNetworkError(error)
  }
  if (error instanceof RateLimitError) {
    return true
  }
  if (error instanceof AuthError) {
    return false
  }
  return false
}`,
          },
        ],
      },
    ],
  },
  {
    name: 'deletion',
    files: [
      {
        path: 'src/scripts/migrate-legacy-flags.ts',
        replacements: [
          {
            search: `// Legacy flag migration: remove after 2026-06-01.
if (process.env.ENABLE_LEGACY_FLAGS) {
  console.warn("legacy flags enabled")
  applyLegacyFlags(process.env)
}`,
            replace: '',
          },
        ],
      },
    ],
  },
  {
    name: 'json-content-braces-and-quotes',
    files: [
      {
        path: 'config/service.json',
        replacements: [
          {
            search: `{
  "name": "session-store",
  "retries": 3,
  "backoff": {
    "baseMs": 1500,
    "maxMs": 30000
  },
  "flags": {
    "verbose": false,
    "dryRun": true
  }
}`,
            replace: `{
  "name": "session-store",
  "retries": 5,
  "backoff": {
    "baseMs": 1500,
    "maxMs": 60000
  },
  "flags": {
    "verbose": false,
    "dryRun": false
  }
}`,
          },
        ],
      },
    ],
  },
  {
    name: 'three-replacement-refactor',
    files: [
      {
        path: 'src/util/retry-policy.ts',
        replacements: [
          {
            search: `export function computeBackoff(attempt: number): number {
  const base = 1500
  const exponent = Math.min(attempt, 6)
  const jitter = Math.random()
  const delay = base * 2 ** exponent
  return Math.min(delay + jitter * base, 30000)
}`,
            replace: `export function computeBackoff(attempt: number): number {
  const base = BACKOFF_BASE_MS
  const exponent = Math.min(attempt, MAX_BACKOFF_ATTEMPTS)
  const jitter = 1 + Math.random() * JITTER_RATIO
  const delay = base * 2 ** exponent * jitter
  metrics.record("backoff.ms", delay)
  return Math.min(Math.round(delay), BACKOFF_MAX_MS)
}`,
          },
          {
            search: `export async function withRetries<T>(
  operation: () => Promise<T>,
  options: RetryOptions = DEFAULT_OPTIONS,
): Promise<T> {
  let lastError: unknown
  for (let attempt = 0; attempt < options.maxAttempts; attempt++) {
    try {
      return await operation()
    } catch (error) {
      lastError = error
    }
  }
  throw lastError
}`,
            replace: `export async function withRetries<T>(
  operation: () => Promise<T>,
  options: RetryOptions = DEFAULT_OPTIONS,
): Promise<T> {
  let lastError: unknown
  for (let attempt = 0; attempt < options.maxAttempts; attempt++) {
    try {
      return await operation()
    } catch (error) {
      lastError = error
      if (attempt + 1 < options.maxAttempts) {
        const delay = computeBackoff(attempt)
        log.warn("retry.attempt", { attempt, delay })
        await sleep(delay)
      }
    }
  }
  throw lastError
}`,
          },
          {
            search: `const DEFAULT_OPTIONS: RetryOptions = {
  maxAttempts: 3,
  baseDelayMs: 1500,
  maxDelayMs: 30000,
}`,
            replace: `const DEFAULT_OPTIONS: RetryOptions = {
  maxAttempts: 4,
  baseDelayMs: BACKOFF_BASE_MS,
  maxDelayMs: BACKOFF_MAX_MS,
  jitterRatio: JITTER_RATIO,
}`,
          },
        ],
      },
    ],
  },
  {
    name: 'jsx-with-quotes',
    files: [
      {
        path: 'src/components/SettingsDialog.tsx',
        replacements: [
          {
            search: `        <Dialog open={open} onOpenChange={setOpen}>
          <DialogContent className="max-w-lg">
            <DialogHeader>
              <DialogTitle>Delete session</DialogTitle>
            </DialogHeader>
            <DialogFooter>
              <Button variant="outline" onClick={() => setOpen(false)}>
                Cancel
              </Button>
            </DialogFooter>`,
            replace: `        <Dialog open={open} onOpenChange={setOpen}>
          <DialogContent className="max-w-lg">
            <DialogHeader>
              <DialogTitle>Delete session</DialogTitle>
            </DialogHeader>
            <p className="text-sm text-muted-foreground">
              This signs you out of the current device.
            </p>
            <DialogFooter>
              <Button variant="outline" onClick={() => setOpen(false)}>
                Cancel
              </Button>
            </DialogFooter>`,
          },
        ],
      },
    ],
  },
]

/** The block payload for a fixture: one block per replacement, grouped by path. */
const toBlockPayload = (fixture: EditBlocksFixture): string =>
  fixture.files
    .map((file) =>
      file.replacements
        .map((replacement) =>
          block(file.path, replacement.search, replacement.replace),
        )
        .join('\n'),
    )
    .join('\n\n')

/** The equivalent canonical JSON edits array for a fixture. */
const toJsonEdits = (fixture: EditBlocksFixture) =>
  fixture.files.map((file) => ({
    type: 'str_replace' as const,
    path: file.path,
    replacements: file.replacements.map((replacement) => ({
      oldString: replacement.search,
      newString: replacement.replace,
    })),
  }))

/**
 * The canonical parsed transaction for a fixture: the JSON edits with the
 * schema defaults applied. Both the flag-on block path (EB1) and the
 * flag-off JSON path (EB4) must produce exactly this.
 */
const canonicalParsedEdits = (fixture: EditBlocksFixture) => ({
  edits: toJsonEdits(fixture).map((edit) => ({
    ...edit,
    replacements: edit.replacements.map((replacement) => ({
      ...replacement,
      allowMultiple: false,
    })),
  })),
})

describe('EB1: equivalence of the block path and the JSON path', () => {
  test('the module under test exposes the flag-on provider surface', () => {
    // A stale module instance (already imported with the flag off by another
    // test file in the same process) fails here with a clear signal instead
    // of a confusing equivalence failure below.
    const probe = block('probe.ts', 'old', 'new')
    expect(
      editTransactionParams.providerInputSchema.safeParse({ edits: probe })
        .success,
    ).toBe(true)
  })

  test('block payloads and their JSON equivalents parse to deep-equal transactions', () => {
    for (const fixture of FIXTURES) {
      const jsonResult = editTransactionParams.inputSchema.safeParse({
        edits: toJsonEdits(fixture),
      })
      if (!jsonResult.success) console.error(jsonResult.error.issues)
      expect(jsonResult.success).toBe(true)

      const blockResult = editTransactionParams.inputSchema.safeParse({
        edits: toBlockPayload(fixture),
      })
      if (!blockResult.success) console.error(blockResult.error.issues)
      expect(blockResult.success).toBe(true)

      if (jsonResult.success && blockResult.success) {
        expect(blockResult.data).toEqual(jsonResult.data)
      }
      // Canonical expectation shared with the flag-off run (EB4).
      if (jsonResult.success) {
        expect(jsonResult.data).toEqual(canonicalParsedEdits(fixture))
      }
    }
  })

  test('providerInputSchema accepts both the block payload string and the JSON array', () => {
    for (const fixture of FIXTURES) {
      expect(
        editTransactionParams.providerInputSchema.safeParse({
          edits: toBlockPayload(fixture),
        }).success,
      ).toBe(true)
      expect(
        editTransactionParams.providerInputSchema.safeParse({
          edits: toJsonEdits(fixture),
        }).success,
      ).toBe(true)
    }
  })

  test('the provider-validated block payload round-trips into the runtime input schema', () => {
    // providerInputSchema validates but does not translate: it hands the
    // string to the runtime, whose inputSchema preprocess translates it.
    for (const fixture of FIXTURES) {
      const providerResult =
        editTransactionParams.providerInputSchema.safeParse({
          edits: toBlockPayload(fixture),
        })
      expect(providerResult.success).toBe(true)
      if (!providerResult.success) continue
      const runtimeResult = editTransactionParams.inputSchema.safeParse(
        providerResult.data,
      )
      if (!runtimeResult.success) console.error(runtimeResult.error.issues)
      expect(runtimeResult.success).toBe(true)
      if (runtimeResult.success) {
        expect(runtimeResult.data).toEqual(canonicalParsedEdits(fixture))
      }
    }
  })
})

describe('EB2: escaping overhead', () => {
  test('block payloads are never larger than the JSON encodings for code-bearing fixtures', () => {
    const summary: string[] = []
    FIXTURES.forEach((fixture, index) => {
      const jsonPayload = JSON.stringify(toJsonEdits(fixture))
      const blockPayload = toBlockPayload(fixture)
      const ratio = blockPayload.length / jsonPayload.length
      summary.push(
        `${index + 1}. ${fixture.name}: json=${jsonPayload.length} block=${blockPayload.length} block/json=${ratio.toFixed(3)}`,
      )
      // The motivating claim: JSON must escape every newline and quote in
      // code while blocks carry it verbatim, so the block payload must not
      // be larger for any code-bearing fixture.
      expect(blockPayload.length).toBeLessThanOrEqual(jsonPayload.length)
    })
    console.log(`[edit-blocks] payload size summary:\n${summary.join('\n')}`)
  })
})

describe('EB3: adversarial injection fails closed end to end', () => {
  test('a SEARCH body containing marker-like lines is rejected, not corrupted', () => {
    const payload = block(
      'src/a.ts',
      'const value = 1\n<<<<<<< SEARCH\nconst value = 2',
      'const value = 3',
    )
    const parsed = parseEditBlocks(payload)
    expect('error' in parsed && parsed.error.code).toBe('marker_collision')

    expect(
      editTransactionParams.inputSchema.safeParse({ edits: payload }).success,
    ).toBe(false)
    expect(
      editTransactionParams.providerInputSchema.safeParse({ edits: payload })
        .success,
    ).toBe(false)
  })

  test('a payload mixing JSON and blocks is rejected', () => {
    const payload = `${JSON.stringify(toJsonEdits(FIXTURES[0]!))}\n${block(
      'src/injected.ts',
      'old',
      'new',
    )}`
    expect(
      editTransactionParams.inputSchema.safeParse({ edits: payload }).success,
    ).toBe(false)
    expect(
      editTransactionParams.providerInputSchema.safeParse({ edits: payload })
        .success,
    ).toBe(false)
  })

  test('prose outside the blocks makes the whole payload invalid', () => {
    const before = `Sure, here are the edits:\n${block('src/a.ts', 'old', 'new')}`
    const after = `${block('src/a.ts', 'old', 'new')}\nDone.`
    for (const payload of [before, after]) {
      expect(
        editTransactionParams.inputSchema.safeParse({ edits: payload }).success,
      ).toBe(false)
      expect(
        editTransactionParams.providerInputSchema.safeParse({ edits: payload })
          .success,
      ).toBe(false)
    }
  })
})

describe('EB4: flag-off identity (default path untouched)', () => {
  afterEach(() => {
    // undefined re-reads OPENBUFF_EDIT_BLOCKS (deleted above) on next use.
    __setEditBlocksEnabledForTest(undefined)
  })

  test('the same JSON payloads parse identically with the flag off', () => {
    __setEditBlocksEnabledForTest(false)
    for (const fixture of FIXTURES) {
      const jsonEdits = toJsonEdits(fixture)
      const arrayResult = editTransactionParams.inputSchema.safeParse({
        edits: jsonEdits,
      })
      expect(arrayResult.success).toBe(true)
      const stringResult = editTransactionParams.inputSchema.safeParse({
        edits: JSON.stringify(jsonEdits),
      })
      expect(stringResult.success).toBe(true)
      if (arrayResult.success && stringResult.success) {
        expect(stringResult.data).toEqual(arrayResult.data)
      }
      // Same canonical expectation the flag-on run satisfies (EB1), so the
      // flag-off parse is identical to the flag-on parse.
      if (arrayResult.success) {
        expect(arrayResult.data).toEqual(canonicalParsedEdits(fixture))
      }
    }
  })

  test('block payloads fail with the flag off', () => {
    __setEditBlocksEnabledForTest(false)
    for (const fixture of FIXTURES) {
      const blockPayload = toBlockPayload(fixture)
      expect(
        editTransactionParams.inputSchema.safeParse({ edits: blockPayload })
          .success,
      ).toBe(false)
      expect(
        editTransactionParams.providerInputSchema.safeParse({
          edits: blockPayload,
        }).success,
      ).toBe(false)
    }
  })
})
