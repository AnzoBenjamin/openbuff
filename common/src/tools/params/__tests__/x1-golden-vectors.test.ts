import { describe, expect, it } from 'bun:test'

import { publishedTools } from '../../constants'
import {
  compileToolJsonSchemas,
  jsonSchemaToTypeScript,
} from '../../compile-tool-definitions'
import {
  commitReceiptV1Schema,
  fileMutationResultV1Schema,
} from '../../results/filesystem'
import {
  decodeReadCapabilityToken,
  encodeReadCapabilityToken,
  getExactContentHash,
  getContentHash,
  readCapabilityMatchesScope,
} from '../../../util/content-hash'

/**
 * X-1 (DEPTH-2026-09-27 D17) golden vectors for frozen contracts.
 *
 * Scope of this file, relative to the existing suites it must not duplicate:
 * - Schema-artifact determinism and coverage over every published tool
 *   (registration/drift invariants live in
 *   common/src/tools/__tests__/tool-registration-consistency.test.ts; the
 *   generated TS type mirror is pinned by scripts/generate-tool-definitions.ts
 *   and common/src/tools/__tests__/compile-tool-definitions.test.ts).
 * - The mapper's throw-on-unhandled-shape contract (the silent `any` fallback
 *   was removed; compileToolDefinitions no longer swallows conversion errors).
 * - Byte-stable cap.v3 grammar vectors (round-trip, normalization, and
 *   tampering matrices live in common/src/util/__tests__/content-hash.test.ts;
 *   only the stable non-secret parts are pinned here — tokens are HMAC-signed
 *   with a per-process key, so token STRINGS must never be pinned).
 * - FileMutationResultV1 / CommitReceiptV1 wire round-trip vectors
 *   (reconciliation semantics live in
 *   common/src/tools/results/__tests__/filesystem.test.ts).
 */

describe('compileToolJsonSchemas golden vectors', () => {
  it('pins the exact serialized JSON Schema for the glob tool', () => {
    // Fixture produced by the real pipeline: z.toJSONSchema(glob
    // providerInputSchema, { io: 'input' }) serialized with JSON.stringify(
    // schema, null, 2). zod v4 resolves `.describe()` metadata on a clone
    // whose parent schema is flattened back into it at finalize time, so the
    // registry description precedes the processor-emitted keys at every level
    // ($schema is prepended at the root by finalize); io:'input' omits
    // additionalProperties for plain objects and leaves optional keys out of
    // `required`.
    const schema = compileToolJsonSchemas()['glob']

    expect(JSON.stringify(schema, null, 2)).toBe(`{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "description": "Search for files matching a glob pattern. Returns matching file paths sorted by modification time (newest first, then path for deterministic ties).",
  "type": "object",
  "properties": {
    "pattern": {
      "description": "Glob pattern to match files against (e.g., *.js, src/glob/*.ts, glob/test/glob/*.go).",
      "type": "string",
      "minLength": 1
    },
    "cwd": {
      "description": "Optional working directory or file path, relative to project root. If a directory, the glob pattern is matched against paths relative to this cwd, while returned files remain project-relative. If a file path, the pattern is matched against that file only (full path or basename). If not provided, searches from project root.",
      "type": "string"
    }
  },
  "required": [
    "pattern"
  ]
}`)
  })

  it('produces a top-level object schema for every published tool', () => {
    const artifacts = compileToolJsonSchemas()

    for (const [toolName, schema] of Object.entries(artifacts)) {
      expect(schema).toMatchObject({ type: 'object' })
      expect(toolName.length).toBeGreaterThan(0)
    }
  })

  it('covers exactly the publishedTools list', () => {
    const artifacts = compileToolJsonSchemas()
    const names = Object.keys(artifacts)

    expect([...names].sort()).toEqual([...publishedTools].sort())
    expect(names).toHaveLength(publishedTools.length)
  })

  it('is deterministic across consecutive builds', () => {
    const first = JSON.stringify(compileToolJsonSchemas())
    const second = JSON.stringify(compileToolJsonSchemas())

    expect(second).toBe(first)
  })
})

describe('jsonSchemaToTypeScript unhandled-shape contract', () => {
  it('throws a descriptive error for unrecognized shapes instead of silent any', () => {
    expect(() => jsonSchemaToTypeScript({ not: {} })).toThrow(
      'Unsupported JSON Schema shape for TS mapping',
    )
  })

  it('maps the empty JSON Schema {} (z.any/z.unknown) to any explicitly', () => {
    expect(jsonSchemaToTypeScript({})).toBe('any')
  })

  it('maps prefixItems tuples to fixed TypeScript tuples', () => {
    expect(
      jsonSchemaToTypeScript({
        type: 'array',
        prefixItems: [{ type: 'string' }, { type: 'number' }],
      }),
    ).toBe('[string, number]')
    expect(
      jsonSchemaToTypeScript({
        type: 'array',
        prefixItems: [{ type: 'string' }],
        items: { type: 'number' },
      }),
    ).toBe('[string, ...(number)[]]')
  })
})

const capabilityScope = {
  projectId: 'proj-x',
  path: 'src/a.ts',
  runId: 'run-1',
}

describe('cap.v3 grammar golden vectors', () => {
  it('pins the well-known empty-content sha256 vector', () => {
    // Computed against getExactContentHash, not trusted: sha256("").
    expect(getExactContentHash('')).toBe(
      'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    )
  })

  it('hashes CRLF content through LF normalization and keeps exact hashes distinct', () => {
    const normalized = getContentHash('a\r\nb')

    expect(normalized).toBe(getContentHash('a\nb'))
    expect(normalized).not.toBe(getExactContentHash('a\r\nb'))
  })

  it('round-trips a minted cap.v3 token through the frozen grammar', () => {
    const hash = getContentHash('golden vector content\n')
    const token = encodeReadCapabilityToken({
      startLine: 3,
      endLine: 7,
      hash,
      scope: capabilityScope,
    })

    // Grammar: cap.v3.<start>.<end>.<digest>.<scopeFingerprint>.<hmac> with
    // 43-char base64url components. Token strings are per-process HMAC
    // signatures and must never be pinned byte-for-byte.
    expect(token).toMatch(
      /^cap\.v3\.3\.7\.[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{43}$/,
    )

    const decoded = decodeReadCapabilityToken(token)
    expect(typeof decoded).toBe('object')
    if (typeof decoded !== 'string') {
      expect(decoded.startLine).toBe(3)
      expect(decoded.endLine).toBe(7)
      expect(decoded.hash).toBe(hash)
      expect(decoded.tokenVersion).toBe('v3')
      expect(decoded.scopeFingerprint).toHaveLength(43)
      expect(readCapabilityMatchesScope(decoded, capabilityScope)).toBe(true)
    }
  })

  it('does not validate a token against a different scope', () => {
    const token = encodeReadCapabilityToken({
      startLine: 1,
      endLine: 2,
      hash: getContentHash('scoped content'),
      scope: capabilityScope,
    })
    const decoded = decodeReadCapabilityToken(token)
    expect(typeof decoded).toBe('object')
    if (typeof decoded !== 'string') {
      // The projectId dimension; path/runId mismatch, path normalization,
      // and tampering matrices are pinned in
      // common/src/util/__tests__/content-hash.test.ts.
      expect(
        readCapabilityMatchesScope(decoded, {
          ...capabilityScope,
          projectId: 'proj-y',
        }),
      ).toBe(false)
    }
  })
})

const beforeHash = getExactContentHash('const value = 0\n')
const afterHash = getExactContentHash('const value = 1\n')

const goldenMutationResult = {
  kind: 'file_mutation_result',
  version: 1,
  operationId: 'operation-golden',
  outcome: 'applied',
  actions: [
    {
      actionId: 'action-1',
      index: 0,
      action: 'update',
      path: 'src/golden.ts',
      outcome: 'applied',
      beforeHash,
      afterHash,
    },
  ],
  authorityTier: 'portable_path',
  errors: [],
  freshCapabilities: [],
}

const goldenReceipt = {
  kind: 'commit_receipt',
  version: 1,
  receiptId: 'receipt-golden',
  operationId: 'operation-golden',
  callId: 'call-golden',
  authorityTier: 'portable_path',
  status: 'committed',
  actions: [
    {
      actionId: 'action-1',
      index: 0,
      action: 'update',
      path: 'src/golden.ts',
      status: 'committed',
      beforeHash,
      afterHash,
    },
  ],
  finalHashes: { 'src/golden.ts': afterHash },
}

const expectJsonRoundTrip = <T>(schema: { parse: (v: unknown) => T }, fixture: unknown): void => {
  const parsed = schema.parse(fixture)
  expect(JSON.parse(JSON.stringify(parsed))).toEqual(fixture)
  expect(
    JSON.stringify(schema.parse(JSON.parse(JSON.stringify(parsed)))),
  ).toBe(JSON.stringify(parsed))
}

describe('FileMutationResultV1 golden vectors', () => {
  it('parses a minimal applied update and round-trips it JSON-identically', () => {
    expectJsonRoundTrip(fileMutationResultV1Schema, goldenMutationResult)
  })

  it('parses an applied update exposing paired afterContent and editAnchor', () => {
    const content = 'const value = 1\n'
    const fixture = {
      ...goldenMutationResult,
      operationId: 'operation-anchor',
      actions: [
        {
          ...goldenMutationResult.actions[0],
          afterHash: getExactContentHash(content),
          afterContent: content,
          editAnchor: {
            startLine: 1,
            endLine: 2,
            contentHash: getContentHash(content),
            readCapability: 'cap.v3.golden',
          },
        },
      ],
    }

    expectJsonRoundTrip(fileMutationResultV1Schema, fixture)
  })

  it('rejects an editAnchor whose contentHash is not a canonical sha256 digest', () => {
    // The beforeHash/afterHash fields are plain nonempty strings in this
    // schema; the sha256:… format is enforced where a hash anchors editable
    // content, via the readFilesEditAnchorSchema regex.
    const content = 'const value = 1\n'
    const action = {
      ...goldenMutationResult.actions[0],
      afterHash: getExactContentHash(content),
      afterContent: content,
      editAnchor: {
        startLine: 1,
        endLine: 2,
        contentHash: 'sha256:not-a-canonical-digest',
        readCapability: 'cap.v3.golden',
      },
    }

    expect(
      fileMutationResultV1Schema.safeParse({
        ...goldenMutationResult,
        operationId: 'operation-anchor',
        actions: [action],
      }).success,
    ).toBe(false)
  })

  it('rejects afterContent that does not hash to afterHash', () => {
    const action = {
      ...goldenMutationResult.actions[0],
      afterHash: getExactContentHash('different content'),
      afterContent: 'const value = 1\n',
    }

    expect(
      fileMutationResultV1Schema.safeParse({
        ...goldenMutationResult,
        actions: [action],
      }).success,
    ).toBe(false)
  })

  it('rejects an unknown action kind', () => {
    expect(
      fileMutationResultV1Schema.safeParse({
        ...goldenMutationResult,
        actions: [
          { ...goldenMutationResult.actions[0], action: 'truncate' },
        ],
      }).success,
    ).toBe(false)
  })

  it('rejects aggregate outcome drift from the action outcomes', () => {
    expect(
      fileMutationResultV1Schema.safeParse({
        ...goldenMutationResult,
        outcome: 'not_applied',
      }).success,
    ).toBe(false)
  })
})

describe('CommitReceiptV1 golden vectors', () => {
  it('parses a committed receipt with authorityTier and round-trips it JSON-identically', () => {
    expectJsonRoundTrip(commitReceiptV1Schema, goldenReceipt)
  })

  it('rejects a receipt missing status', () => {
    expect(
      commitReceiptV1Schema.safeParse({
        ...goldenReceipt,
        status: undefined,
      }).success,
    ).toBe(false)
  })

  it('rejects an unknown commit action kind', () => {
    expect(
      commitReceiptV1Schema.safeParse({
        ...goldenReceipt,
        actions: [
          { ...goldenReceipt.actions[0], action: 'rename' },
        ],
      }).success,
    ).toBe(false)
  })
})
