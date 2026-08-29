import {
  encodeReadCapabilityToken,
  getContentHash,
} from '@codebuff/common/util/content-hash'
import { describe, expect, it } from 'bun:test'

import { processEditTransaction } from '../process-edit-transaction'

import type { Logger } from '@codebuff/common/types/contracts/logger'

const logger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
}

const issuer = { projectId: '/project', runId: 'whole-file-capability-tests' }
const path = 'src/file.ts'
// Two visible lines, three capability lines: the shape every newline-terminated
// file has, and the one the old visibleLineCount bounds check rejected.
const initial = 'a\nb\n'

/**
 * Mints exactly what read_files.paths mints for a complete read: capability
 * space bounds (1..lines.length, which includes the trailing entry past the
 * final newline) hashed over that same slice.
 */
function wholeFileReadCapability(content: string): string {
  return encodeReadCapabilityToken({
    startLine: 1,
    endLine: content.replace(/\r\n?/g, '\n').split('\n').length,
    hash: getContentHash(content),
    scope: { ...issuer, path },
  })
}

/**
 * Mints what a sub-range read mints: the exact observed slice hashed at the
 * bounds it was observed at.
 */
function rangeReadCapability(params: {
  startLine: number
  endLine: number
  content: string
}): string {
  return encodeReadCapabilityToken({
    startLine: params.startLine,
    endLine: params.endLine,
    hash: getContentHash(params.content),
    scope: { ...issuer, path },
  })
}

describe('replace_range with a capability whose lines shifted', () => {
  it('re-anchors a capability minted before an insertion above the target and reports the shift', async () => {
    // Capability was observed at lines 1-2 ('a\nb'); a line was inserted above
    // since, so those exact bytes now live at lines 2-3.
    const result = await processEditTransaction({
      initialContentByPath: new Map([[path, 'x\na\nb\nc\n']]),
      logger,
      readCapabilityIssuer: issuer,
      edits: [
        {
          type: 'replace_range',
          path,
          readCapability: rangeReadCapability({
            startLine: 1,
            endLine: 2,
            content: 'a\nb',
          }),
          newContent: 'A\nB',
        },
      ],
    })

    expect('files' in result).toBe(true)
    if ('files' in result) {
      expect(result.files[0]?.content).toBe('x\nA\nB\nc\n')
      expect(result.files[0]?.messages).toEqual([
        `Replaced lines 2-3 in ${path} (re-anchored +1 lines after content shifted above the target).`,
      ])
    }
  })

  it('fails closed as capability_stale when the observed content now has identical candidates', async () => {
    const result = await processEditTransaction({
      initialContentByPath: new Map([[path, 'x\na\nb\na\nb\n']]),
      logger,
      readCapabilityIssuer: issuer,
      edits: [
        {
          type: 'replace_range',
          path,
          readCapability: rangeReadCapability({
            startLine: 1,
            endLine: 2,
            content: 'a\nb',
          }),
          newContent: 'A\nB',
        },
      ],
    })

    expect('error' in result).toBe(true)
    if ('error' in result) {
      expect(result.failures[0]?.errorMessage).toBe(
        `replace_range blocked for ${path}: the readCapability-covered content is stale. Re-read lines 1-2 and retry with the fresh token. Cause: the observed content now appears at 2 identical candidate spans, so the target is ambiguous.`,
      )
      // The recovery contract is unchanged: a refused re-anchor is still stale.
      expect(result.failures[0]?.failureKind).toBe('capability_stale')
    }
  })

  it('fails closed when the observed content is gone entirely', async () => {
    const result = await processEditTransaction({
      initialContentByPath: new Map([[path, 'x\ny\nz\n']]),
      logger,
      readCapabilityIssuer: issuer,
      edits: [
        {
          type: 'replace_range',
          path,
          readCapability: rangeReadCapability({
            startLine: 1,
            endLine: 2,
            content: 'a\nb',
          }),
          newContent: 'A\nB',
        },
      ],
    })

    expect('error' in result).toBe(true)
    if ('error' in result) {
      expect(result.failures[0]?.errorMessage).toContain(
        'the readCapability-covered content is stale',
      )
      expect(result.failures[0]?.errorMessage).toContain(
        'the observed content was not found anywhere in the file',
      )
      expect(result.failures[0]?.failureKind).toBe('capability_stale')
    }
  })
})

describe('replace_range with a whole-file paths capability', () => {
  it('accepts the capability-space bounds minted by a complete read_files.paths read', async () => {
    const result = await processEditTransaction({
      initialContentByPath: new Map([[path, initial]]),
      logger,
      readCapabilityIssuer: issuer,
      edits: [
        {
          type: 'replace_range',
          path,
          readCapability: wholeFileReadCapability(initial),
          newContent: 'A\nB\n',
        },
      ],
    })

    expect('files' in result).toBe(true)
    if ('files' in result) {
      // A whole-file range consumes the trailing entry, so the result is exactly
      // newContent with no re-appended newline.
      expect(result.files[0]?.content).toBe('A\nB\n')
      expect(result.files[0]?.messages).toContain(
        `Replaced lines 1-3 in ${path}.`,
      )
    }
  })

  it('routes a whole-file range through the same provenance checks as any other range', async () => {
    // The whole-file span now resolves, so the transformation ledger overlap
    // check runs instead of silently taking the un-mapped splice path.
    const result = await processEditTransaction({
      initialContentByPath: new Map([[path, initial]]),
      logger,
      readCapabilityIssuer: issuer,
      edits: [
        {
          type: 'str_replace',
          path,
          replacements: [
            { oldString: 'a', newString: 'A', allowMultiple: false },
          ],
        },
        {
          type: 'replace_range',
          path,
          readCapability: wholeFileReadCapability(initial),
          newContent: 'A\nB\n',
        },
      ],
    })

    expect('error' in result).toBe(true)
    if ('error' in result) {
      expect(result.failures[0]?.errorMessage).toContain(
        'overlap bytes changed earlier in this transaction',
      )
    }
  })

  it('still fails closed on an inverted range, wording the ceilings via describeLineBounds', async () => {
    const result = await processEditTransaction({
      initialContentByPath: new Map([[path, initial]]),
      logger,
      readCapabilityIssuer: issuer,
      edits: [
        {
          type: 'replace_range',
          path,
          startLine: 3,
          endLine: 2,
          readCapability: wholeFileReadCapability(initial),
          newContent: 'X',
        },
      ],
    })

    expect('error' in result).toBe(true)
    if ('error' in result) {
      expect(result.failures[0]?.errorMessage).toBe(
        `replace_range 3-2 is outside ${path} (the file has 2 visible line(s); a read capability may bind up to line 3 (the trailing entry a read reports past the final newline)).`,
      )
      // The bounds error must keep falling through to 'generic'.
      expect(result.failures[0]?.failureKind).toBe('generic')
    }
  })
})
