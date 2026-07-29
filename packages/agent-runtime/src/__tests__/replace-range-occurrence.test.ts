import { replaceRangeParams } from '@codebuff/common/tools/params/tool/replace-range'
import { transactionEditSchema } from '@codebuff/common/tools/params/tool/edit-transaction'
import {
  encodeReadCapabilityToken,
  getContentHash,
} from '@codebuff/common/util/content-hash'
import { describe, expect, it } from 'bun:test'

import { processEditTransaction } from '../process-edit-transaction'
import { resolveOccurrenceRangeInCapabilityRange } from '../structural-read'

import type { Logger } from '@codebuff/common/types/contracts/logger'

const logger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
}

const defaultReadCapabilityIssuer = {
  projectId: '/project',
  runId: 'occurrence-tests',
}

function readAuthorization(params: {
  path: string
  startLine: number
  endLine: number
  content: string
  issuer?: { projectId: string; runId: string }
}) {
  const {
    path,
    startLine,
    endLine,
    content,
    issuer = defaultReadCapabilityIssuer,
  } = params
  const capabilityHash = getContentHash(content)
  return {
    capabilityStartLine: startLine,
    capabilityEndLine: endLine,
    capabilityHash,
    readCapability: encodeReadCapabilityToken({
      startLine,
      endLine,
      hash: capabilityHash,
      scope: { ...issuer, path },
    }),
  }
}

function capToken(params: {
  path: string
  startLine: number
  endLine: number
  content: string
}): string {
  return readAuthorization(params).readCapability
}

describe('resolveOccurrenceRangeInCapabilityRange', () => {
  it('returns absolute file lines as slice-relative lines plus capabilityStartLine - 1', () => {
    const content = ['alpha', 'beta', 'target', 'gamma', 'delta'].join('\n')
    const result = resolveOccurrenceRangeInCapabilityRange({
      content,
      match: 'target',
      capabilityStartLine: 2,
      capabilityEndLine: 5,
    })

    // Within the authorized slice (lines 2-5), "target" is at slice line 2,
    // which maps to absolute file line 2 + (2 - 1) = 3.
    expect(result.range).toEqual({ startLine: 3, endLine: 3 })
    expect(result.found).toBe(1)
  })

  it('ignores a match that lies outside the authorized range', () => {
    // "target" appears on line 1 (outside the authorized 3-5 window) and on
    // line 4 (inside). The resolver must only see the in-range occurrence.
    const content = ['target', 'filler', 'filler', 'target', 'filler'].join(
      '\n',
    )
    const result = resolveOccurrenceRangeInCapabilityRange({
      content,
      match: 'target',
      capabilityStartLine: 3,
      capabilityEndLine: 5,
    })

    expect(result.range).toEqual({ startLine: 4, endLine: 4 })
    expect(result.found).toBe(1)
  })

  it('returns { range: null, found } when the Nth occurrence is absent', () => {
    const content = ['target', 'one', 'two', 'target', 'three'].join('\n')
    const result = resolveOccurrenceRangeInCapabilityRange({
      content,
      match: 'target',
      occurrence: 3,
      capabilityStartLine: 1,
      capabilityEndLine: 5,
    })

    expect(result.range).toBeNull()
    expect(result.found).toBe(2)
  })

  it('maps CRLF content to correct 1-indexed lines', () => {
    const content = 'one\r\ntwo\r\ntarget\r\nfour'
    const result = resolveOccurrenceRangeInCapabilityRange({
      content,
      match: 'target',
      capabilityStartLine: 1,
      capabilityEndLine: 4,
    })

    expect(result.range).toEqual({ startLine: 3, endLine: 3 })
    expect(result.found).toBe(1)
  })

  it('defaults to the first occurrence when occurrence is omitted', () => {
    const content = ['target', 'x', 'target'].join('\n')
    const result = resolveOccurrenceRangeInCapabilityRange({
      content,
      match: 'target',
      capabilityStartLine: 1,
      capabilityEndLine: 3,
    })

    expect(result.range).toEqual({ startLine: 1, endLine: 1 })
  })
})

describe('replace_range occurrence schema mutual exclusion', () => {
  const validCapability = capToken({
    path: 'src/file.ts',
    startLine: 1,
    endLine: 5,
    content: 'one\ntwo\nthree\nfour\nfive',
  })

  it('rejects occurrence together with startLine/endLine in the transaction schema', () => {
    const parsed = transactionEditSchema.safeParse({
      type: 'replace_range',
      path: 'src/file.ts',
      readCapability: validCapability,
      startLine: 1,
      endLine: 2,
      occurrence: { match: 'two' },
      newContent: 'replacement',
    })

    expect(parsed.success).toBe(false)
    if (!parsed.success) {
      const messages = parsed.error.issues.map((issue) => issue.message)
      expect(
        messages.some((message) =>
          message.includes('mutually exclusive with startLine/endLine'),
        ),
      ).toBe(true)
    }
  })

  it('rejects occurrence together with startLine/endLine in the standalone schema', () => {
    const parsed = replaceRangeParams.providerInputSchema.safeParse({
      path: 'src/file.ts',
      readCapability: validCapability,
      startLine: 1,
      endLine: 2,
      occurrence: { match: 'two' },
      newContent: 'replacement',
    })

    expect(parsed.success).toBe(false)
    if (!parsed.success) {
      const messages = parsed.error.issues.map((issue) => issue.message)
      expect(
        messages.some((message) =>
          message.includes('mutually exclusive with startLine/endLine'),
        ),
      ).toBe(true)
    }
  })

  it('accepts occurrence alone in the transaction schema', () => {
    const parsed = transactionEditSchema.safeParse({
      type: 'replace_range',
      path: 'src/file.ts',
      readCapability: validCapability,
      occurrence: { match: 'two', occurrence: 1 },
      newContent: 'replacement',
    })

    expect(parsed.success).toBe(true)
  })

  it('accepts occurrence alone in the standalone schema', () => {
    const parsed = replaceRangeParams.providerInputSchema.safeParse({
      path: 'src/file.ts',
      readCapability: validCapability,
      occurrence: { match: 'two' },
      newContent: 'replacement',
    })

    expect(parsed.success).toBe(true)
  })
})

describe('occurrence-scoped replace_range in processEditTransaction', () => {
  it('resolves the Nth literal occurrence within the capability range and replaces exactly those lines', async () => {
    const initial = [
      'const x = 1',
      'repeat();',
      'const y = 2',
      'repeat();',
      'const z = 3',
    ].join('\n')
    const issuer = { projectId: '/project', runId: 'occurrence-resolve' }
    // Authorize the whole 5-line file; target the 2nd "repeat();" (line 4).
    const authorization = readAuthorization({
      path: 'src/file.ts',
      startLine: 1,
      endLine: 5,
      content: initial,
      issuer,
    })

    const result = await processEditTransaction({
      initialContentByPath: new Map([['src/file.ts', initial]]),
      logger,
      readCapabilityIssuer: issuer,
      edits: [
        {
          type: 'replace_range',
          path: 'src/file.ts',
          ...authorization,
          occurrence: { match: 'repeat();', occurrence: 2 },
          newContent: 'repeat(2);',
        },
      ],
    })

    expect('files' in result).toBe(true)
    if ('files' in result) {
      expect(result.files[0]?.content).toBe(
        [
          'const x = 1',
          'repeat();',
          'const y = 2',
          'repeat(2);',
          'const z = 3',
        ].join('\n'),
      )
      expect(result.files[0]?.messages).toContain(
        'Replaced lines 4-4 in src/file.ts within the readCapability-covered range.',
      )
    }
  })

  it('leaves an identical non-occurrence edit byte-for-byte unchanged while replacing only the occurrence edit', async () => {
    const initial = ['alpha', 'target', 'beta', 'target', 'gamma'].join('\n')
    const issuer = { projectId: '/project', runId: 'occurrence-mixed' }
    const wholeAuthorization = readAuthorization({
      path: 'src/file.ts',
      startLine: 1,
      endLine: 5,
      content: initial,
      issuer,
    })

    const result = await processEditTransaction({
      initialContentByPath: new Map([
        ['src/file.ts', initial],
        ['src/other.ts', 'unchanged\n'],
      ]),
      logger,
      readCapabilityIssuer: issuer,
      edits: [
        {
          type: 'replace_range',
          path: 'src/file.ts',
          ...wholeAuthorization,
          occurrence: { match: 'target', occurrence: 2 },
          newContent: 'TARGET',
        },
        {
          type: 'replace_range',
          path: 'src/other.ts',
          ...readAuthorization({
            path: 'src/other.ts',
            startLine: 1,
            endLine: 1,
            content: 'unchanged',
            issuer,
          }),
          startLine: 1,
          endLine: 1,
          // Replaces line 1 with its exact current bytes: a content no-op.
          newContent: 'unchanged',
        },
      ],
    })

    expect('files' in result).toBe(true)
    if ('files' in result) {
      // The occurrence edit replaced only the 2nd "target" (line 4).
      expect(result.files[0]?.content).toBe(
        ['alpha', 'target', 'beta', 'TARGET', 'gamma'].join('\n'),
      )
      // The byte-for-byte identical replacement produces no file change entry.
      const other = result.files.find((file) => file.path === 'src/other.ts')
      expect(other).toBeUndefined()
    }
  })

  it('fails with no file mutation when the occurrence is not found in a transaction', async () => {
    const initial = ['one', 'two', 'three'].join('\n')
    const issuer = { projectId: '/project', runId: 'occurrence-not-found' }
    const authorization = readAuthorization({
      path: 'src/file.ts',
      startLine: 1,
      endLine: 3,
      content: initial,
      issuer,
    })

    const result = await processEditTransaction({
      initialContentByPath: new Map([['src/file.ts', initial]]),
      logger,
      readCapabilityIssuer: issuer,
      edits: [
        {
          type: 'replace_range',
          path: 'src/file.ts',
          ...authorization,
          occurrence: { match: 'two', occurrence: 5 },
          newContent: 'replacement',
        },
      ],
    })

    expect('error' in result).toBe(true)
    if ('error' in result) {
      expect(result.error).toContain('edit_transaction aborted')
      expect(result.failures).toEqual([
        expect.objectContaining({ editIndex: 0, path: 'src/file.ts' }),
      ])
      expect(result.failures[0]?.errorMessage).toContain(
        'occurrence 5 does not exist',
      )
      expect(result.failures[0]?.errorMessage).toContain(
        'found 1 occurrence(s)',
      )
    }
    // No files entry means no mutation was prepared.
    expect('files' in result).toBe(false)
  })

  it('confines occurrence resolution to the authorized sub-range of the file', async () => {
    // "target" appears on lines 1 and 4, but the capability only covers
    // lines 3-5, so occurrence 1 within the capability resolves to line 4.
    const initial = ['target', 'x', 'y', 'target', 'z'].join('\n')
    const issuer = { projectId: '/project', runId: 'occurrence-subrange' }
    const authorization = readAuthorization({
      path: 'src/file.ts',
      startLine: 3,
      endLine: 5,
      content: ['y', 'target', 'z'].join('\n'),
      issuer,
    })

    const result = await processEditTransaction({
      initialContentByPath: new Map([['src/file.ts', initial]]),
      logger,
      readCapabilityIssuer: issuer,
      edits: [
        {
          type: 'replace_range',
          path: 'src/file.ts',
          ...authorization,
          occurrence: { match: 'target', occurrence: 1 },
          newContent: 'TARGET',
        },
      ],
    })

    expect('files' in result).toBe(true)
    if ('files' in result) {
      expect(result.files[0]?.content).toBe(
        ['target', 'x', 'y', 'TARGET', 'z'].join('\n'),
      )
    }
  })
})
