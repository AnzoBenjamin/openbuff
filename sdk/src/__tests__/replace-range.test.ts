import { describe, expect, test } from 'bun:test'

import { MAX_TRANSACTION_FILE_BYTES } from '@codebuff/common/actions'
import { createMockFs } from '@codebuff/common/testing/mocks/filesystem'
import {
  encodeReadCapabilityToken,
  getContentHash,
} from '@codebuff/common/util/content-hash'

import { replaceRange } from '../tools/replace-range'

const capabilityIssuer = { projectId: '/repo', runId: 'replace-range-test' }

function capability(params: {
  path?: string
  startLine: number
  endLine: number
  content: string
  runId?: string
}): string {
  return encodeReadCapabilityToken({
    startLine: params.startLine,
    endLine: params.endLine,
    hash: getContentHash(params.content),
    scope: {
      projectId: '/repo',
      path: params.path ?? 'src/file.ts',
      runId: params.runId ?? capabilityIssuer.runId,
    },
  })
}

describe('replaceRange', () => {
  test('replaces a cap.v3-verified line range', async () => {
    const fs = createMockFs({
      files: { '/repo/src/file.ts': 'line 1\nline 2\nline 3\n' },
    })

    const result = await replaceRange({
      parameters: {
        path: 'src/file.ts',
        readCapability: capability({
          startLine: 2,
          endLine: 2,
          content: 'line 2',
        }),
        newContent: 'updated line 2',
      },
      cwd: '/repo',
      fs,
      capabilityIssuer,
    })

    expect(result[0].type).toBe('json')
    if (result[0].type === 'json') {
      expect(result[0].value).toMatchObject({
        kind: 'file_mutation_result',
        outcome: 'applied',
        actions: [
          expect.objectContaining({
            action: 'update',
            path: 'src/file.ts',
            outcome: 'applied',
          }),
        ],
      })
    }
    expect(await fs.readFile('/repo/src/file.ts', 'utf-8')).toBe(
      'line 1\nupdated line 2\nline 3\n',
    )
  })

  test('returns a fresh capability that authorizes an immediate follow-up edit', async () => {
    const fs = createMockFs({
      files: { '/repo/src/file.ts': 'line 1\nline 2\nline 3\n' },
    })

    const first = await replaceRange({
      parameters: {
        path: 'src/file.ts',
        readCapability: capability({
          startLine: 2,
          endLine: 2,
          content: 'line 2',
        }),
        newContent: 'updated line 2',
      },
      cwd: '/repo',
      fs,
      capabilityIssuer,
    })
    const firstValue = first[0]?.type === 'json' ? first[0].value : undefined
    if (
      !firstValue ||
      typeof firstValue !== 'object' ||
      !('freshCapabilities' in firstValue) ||
      !Array.isArray(firstValue.freshCapabilities)
    ) {
      throw new Error('expected a fresh post-edit capability')
    }
    const freshCapability = firstValue.freshCapabilities[0]
    if (
      !freshCapability ||
      typeof freshCapability !== 'object' ||
      !('token' in freshCapability) ||
      typeof freshCapability.token !== 'string'
    ) {
      throw new Error('expected a fresh post-edit capability token')
    }

    const second = await replaceRange({
      parameters: {
        path: 'src/file.ts',
        readCapability: freshCapability.token,
        startLine: 3,
        endLine: 3,
        newContent: 'updated line 3',
      },
      cwd: '/repo',
      fs,
      capabilityIssuer,
    })

    expect(second[0]).toMatchObject({
      type: 'json',
      value: { kind: 'file_mutation_result', outcome: 'applied' },
    })
    expect(await fs.readFile('/repo/src/file.ts', 'utf-8')).toBe(
      'line 1\nupdated line 2\nupdated line 3\n',
    )
  })

  test('uses a whole-file capability to authorize a contained target', async () => {
    const fs = createMockFs({
      files: { '/repo/src/file.ts': 'line 1\nline 2\nline 3\n' },
    })

    await replaceRange({
      parameters: {
        path: 'src/file.ts',
        readCapability: capability({
          startLine: 1,
          endLine: 3,
          content: 'line 1\nline 2\nline 3',
        }),
        startLine: 2,
        endLine: 2,
        newContent: 'updated line 2',
      },
      cwd: '/repo',
      fs,
      capabilityIssuer,
    })

    expect(await fs.readFile('/repo/src/file.ts', 'utf-8')).toBe(
      'line 1\nupdated line 2\nline 3\n',
    )
  })

  test('re-anchors a capability whose span moved down after an insertion above it', async () => {
    // The capability was observed at line 2 of 'line 1\nline 2\nline 3\n'; a
    // line has since been inserted above, so those bytes are now at line 3.
    const fs = createMockFs({
      files: { '/repo/src/file.ts': 'line 0\nline 1\nline 2\nline 3\n' },
    })

    const result = await replaceRange({
      parameters: {
        path: 'src/file.ts',
        readCapability: capability({
          startLine: 2,
          endLine: 2,
          content: 'line 2',
        }),
        newContent: 'updated line 2',
      },
      cwd: '/repo',
      fs,
      capabilityIssuer,
    })

    expect(result[0]).toMatchObject({
      type: 'json',
      value: { kind: 'file_mutation_result', outcome: 'applied' },
    })
    // The shifted target is edited; line 1 (which now sits at the capability's
    // stale bounds) is untouched.
    expect(await fs.readFile('/repo/src/file.ts', 'utf-8')).toBe(
      'line 0\nline 1\nupdated line 2\nline 3\n',
    )
  })

  test('re-anchors a capability whose span moved up after a deletion above it', async () => {
    const fs = createMockFs({
      files: { '/repo/src/file.ts': 'line 2\nline 3\n' },
    })

    await replaceRange({
      parameters: {
        path: 'src/file.ts',
        readCapability: capability({
          startLine: 2,
          endLine: 2,
          content: 'line 2',
        }),
        newContent: 'updated line 2',
      },
      cwd: '/repo',
      fs,
      capabilityIssuer,
    })

    expect(await fs.readFile('/repo/src/file.ts', 'utf-8')).toBe(
      'updated line 2\nline 3\n',
    )
  })

  test('fails closed instead of re-anchoring onto one of two identical spans', async () => {
    const original = 'header\nline 2\nline 2\n'
    const fs = createMockFs({ files: { '/repo/src/file.ts': original } })

    const result = await replaceRange({
      parameters: {
        path: 'src/file.ts',
        readCapability: capability({
          startLine: 1,
          endLine: 1,
          content: 'line 2',
        }),
        newContent: 'updated line 2',
      },
      cwd: '/repo',
      fs,
      capabilityIssuer,
    })

    expect(result[0]).toMatchObject({
      type: 'json',
      value: {
        file: 'src/file.ts',
        errorMessage: expect.stringContaining(
          '2 identical candidate spans, so the target is ambiguous',
        ),
      },
    })
    expect(await fs.readFile('/repo/src/file.ts', 'utf-8')).toBe(original)
  })

  test('rejects stale capability-covered content before editing', async () => {
    const fs = createMockFs({
      files: { '/repo/src/file.ts': 'line 1\nline 2\nline 3\n' },
    })

    const result = await replaceRange({
      parameters: {
        path: 'src/file.ts',
        readCapability: capability({
          startLine: 2,
          endLine: 2,
          content: 'old line 2',
        }),
        newContent: 'updated line 2',
      },
      cwd: '/repo',
      fs,
      capabilityIssuer,
    })

    expect(result[0]).toMatchObject({
      type: 'json',
      value: { errorMessage: expect.stringContaining('changed after') },
    })
    expect(await fs.readFile('/repo/src/file.ts', 'utf-8')).toBe(
      'line 1\nline 2\nline 3\n',
    )
  })

  test('rejects a capability range beyond a shortened file without mutating it', async () => {
    const original = 'line 1\nline 2\n'
    const fs = createMockFs({
      files: { '/repo/src/file.ts': original },
    })

    const result = await replaceRange({
      parameters: {
        path: 'src/file.ts',
        readCapability: capability({
          startLine: 1,
          endLine: 5,
          content: 'line 1\nline 2\nline 3\nline 4\nline 5',
        }),
        newContent: 'replacement',
      },
      cwd: '/repo',
      fs,
      capabilityIssuer,
    })

    expect(result[0]).toMatchObject({ type: 'json' })
    const { errorMessage } = (result[0] as { value: { errorMessage: string } })
      .value
    expect(errorMessage).toContain(
      'the capability-covered range 1-5 is beyond the current file length (2 lines)',
    )
    // The guard itself accepts the phantom trailing entry, so the diagnostic
    // names the highest line a capability may legally bind (3 here) instead of
    // only the visible count.
    expect(errorMessage).toContain('Capability bounds may extend to line 3')
    expect(await fs.readFile('/repo/src/file.ts', 'utf-8')).toBe(original)
  })

  test('re-anchors a capability whose bounds now exceed a shortened file', async () => {
    // The capability observed line 5 of 'a\nb\nc\nd\ne\n'; the two lines above
    // it have since been deleted, so its recorded endLine is past the file
    // while the observed content still sits uniquely at line 3. Stale bounds
    // alone must not pre-empt relocation.
    const fs = createMockFs({
      files: { '/repo/src/file.ts': 'c\nd\ne\n' },
    })

    const result = await replaceRange({
      parameters: {
        path: 'src/file.ts',
        readCapability: capability({
          startLine: 5,
          endLine: 5,
          content: 'e',
        }),
        newContent: 'updated e',
      },
      cwd: '/repo',
      fs,
      capabilityIssuer,
    })

    expect(result[0]).toMatchObject({
      type: 'json',
      value: { kind: 'file_mutation_result', outcome: 'applied' },
    })
    expect(await fs.readFile('/repo/src/file.ts', 'utf-8')).toBe(
      'c\nd\nupdated e\n',
    )
  })

  test('reports stale bounds when the observed content is gone from a shortened file', async () => {
    const original = 'c\nd\n'
    const fs = createMockFs({ files: { '/repo/src/file.ts': original } })

    const result = await replaceRange({
      parameters: {
        path: 'src/file.ts',
        readCapability: capability({
          startLine: 5,
          endLine: 5,
          content: 'e',
        }),
        newContent: 'updated e',
      },
      cwd: '/repo',
      fs,
      capabilityIssuer,
    })

    expect(result[0]).toMatchObject({ type: 'json' })
    const { errorMessage } = (result[0] as { value: { errorMessage: string } })
      .value
    // Relocation found nothing, so the bounds diagnostic is the actionable one.
    expect(errorMessage).toContain(
      'the capability-covered range 5-5 is beyond the current file length (2 lines)',
    )
    expect(errorMessage).toContain('Capability bounds may extend to line 3')
    expect(await fs.readFile('/repo/src/file.ts', 'utf-8')).toBe(original)
  })

  test('fails closed for out-of-range bounds whose observed content is ambiguous', async () => {
    // Two identical candidate spans, so relocation refuses to pick one; the
    // stale bounds are the reported cause because they are also true and name
    // the range to re-read.
    const original = 'e\nd\ne\n'
    const fs = createMockFs({ files: { '/repo/src/file.ts': original } })

    const result = await replaceRange({
      parameters: {
        path: 'src/file.ts',
        readCapability: capability({
          startLine: 5,
          endLine: 5,
          content: 'e',
        }),
        newContent: 'updated e',
      },
      cwd: '/repo',
      fs,
      capabilityIssuer,
    })

    expect(result[0]).toMatchObject({
      type: 'json',
      value: {
        file: 'src/file.ts',
        errorMessage: expect.stringContaining(
          'the capability-covered range 5-5 is beyond the current file length (3 lines)',
        ),
      },
    })
    expect(await fs.readFile('/repo/src/file.ts', 'utf-8')).toBe(original)
  })

  test('reports zero lines for an empty file without mutating it', async () => {
    const fs = createMockFs({ files: { '/repo/src/file.ts': '' } })

    const result = await replaceRange({
      parameters: {
        path: 'src/file.ts',
        readCapability: capability({
          startLine: 1,
          endLine: 2,
          content: '',
        }),
        newContent: 'replacement',
      },
      cwd: '/repo',
      fs,
      capabilityIssuer,
    })

    expect(result[0]).toMatchObject({
      type: 'json',
      value: {
        errorMessage: expect.stringContaining(
          'the capability-covered range 1-2 is beyond the current file length (0 lines)',
        ),
      },
    })
    expect(await fs.readFile('/repo/src/file.ts', 'utf-8')).toBe('')
  })

  test('applies a single-line edit to an empty file', async () => {
    // Pins the empty-file applied path: start === end === 0 splices in exactly
    // the newContent with no added terminator.
    const fs = createMockFs({ files: { '/repo/src/file.ts': '' } })

    const result = await replaceRange({
      parameters: {
        path: 'src/file.ts',
        readCapability: capability({
          startLine: 1,
          endLine: 1,
          content: '',
        }),
        newContent: 'first line',
      },
      cwd: '/repo',
      fs,
      capabilityIssuer,
    })

    expect(result[0]).toMatchObject({
      type: 'json',
      value: { kind: 'file_mutation_result', outcome: 'applied' },
    })
    expect(await fs.readFile('/repo/src/file.ts', 'utf-8')).toBe('first line')
  })

  test('applies a multi-line edit to an empty file with the LF fallback', async () => {
    const fs = createMockFs({ files: { '/repo/src/file.ts': '' } })

    const result = await replaceRange({
      parameters: {
        path: 'src/file.ts',
        readCapability: capability({
          startLine: 1,
          endLine: 1,
          content: '',
        }),
        newContent: 'first line\nsecond line',
      },
      cwd: '/repo',
      fs,
      capabilityIssuer,
    })

    expect(result[0]).toMatchObject({
      type: 'json',
      value: { kind: 'file_mutation_result', outcome: 'applied' },
    })
    // The single empty line spans bytes 0-0, and no terminator exists anywhere
    // in the file, so the inserted terminator comes from the LF fallback.
    expect(await fs.readFile('/repo/src/file.ts', 'utf-8')).toBe(
      'first line\nsecond line',
    )
  })

  test('does not echo an unbounded raw path for invalid parameters', async () => {
    const original = 'line 1\nline 2\n'
    const fs = createMockFs({ files: { '/repo/src/file.ts': original } })
    // Longer than the bound on the echoed path, so the error message cannot be
    // amplified by unparsed model input.
    const longPath = `src/${'a'.repeat(600)}.ts`

    const result = await replaceRange({
      parameters: {
        path: longPath,
        readCapability: capability({
          path: longPath,
          startLine: 1,
          endLine: 2,
          content: 'line 1\nline 2',
        }),
        // startLine after endLine, so the input never parses.
        startLine: 2,
        endLine: 1,
        newContent: 'replacement',
      },
      cwd: '/repo',
      fs,
      capabilityIssuer,
    })

    expect(result[0]).toMatchObject({
      type: 'json',
      value: {
        // Reported as the shared sentinel rather than the empty path, so the
        // agent can tell an unusable path from a missing one.
        file: '(unparsed)',
        errorMessage: 'Missing or invalid replace_range parameters.',
      },
    })
    expect(await fs.readFile('/repo/src/file.ts', 'utf-8')).toBe(original)
  })

  test('does not echo an unbounded parsed path for a target outside the project', async () => {
    const original = 'line 1\nline 2\n'
    const fs = createMockFs({ files: { '/repo/src/file.ts': original } })
    // Parses cleanly (the schema does not bound `path`) but resolves outside
    // the project, so the echo must be bounded here too.
    const outsidePath = `/outside/${'a'.repeat(600)}.ts`

    const result = await replaceRange({
      parameters: {
        path: outsidePath,
        readCapability: capability({
          path: outsidePath,
          startLine: 1,
          endLine: 2,
          content: 'line 1\nline 2',
        }),
        newContent: 'replacement',
      },
      cwd: '/repo',
      fs,
      capabilityIssuer,
    })

    expect(result[0]).toMatchObject({
      type: 'json',
      value: {
        file: '(unparsed)',
        errorMessage: 'file path is outside the project directory',
      },
    })
    expect(await fs.readFile('/repo/src/file.ts', 'utf-8')).toBe(original)
  })

  test('surfaces a read failure code without mutating the file', async () => {
    const original = 'line 1\nline 2\n'
    const files: Record<string, string> = { '/repo/src/file.ts': original }
    const fs = createMockFs({
      files,
      readFileImpl: async () => {
        throw Object.assign(new Error('permission denied'), { code: 'EACCES' })
      },
      writeFileImpl: async (path, content) => {
        files[path] = content
      },
    })

    const result = await replaceRange({
      parameters: {
        path: 'src/file.ts',
        readCapability: capability({
          startLine: 1,
          endLine: 2,
          content: 'line 1\nline 2',
        }),
        newContent: 'updated line 1\nupdated line 2',
      },
      cwd: '/repo',
      fs,
      capabilityIssuer,
    })

    expect(result[0]).toMatchObject({
      type: 'json',
      value: {
        errorMessage: 'replace_range failed with EACCES: permission denied',
      },
    })
    expect(files['/repo/src/file.ts']).toBe(original)
  })

  test('rejects a capability from another run', async () => {
    const fs = createMockFs({
      files: { '/repo/src/file.ts': 'line 1\nline 2\n' },
    })

    const result = await replaceRange({
      parameters: {
        path: 'src/file.ts',
        readCapability: capability({
          startLine: 1,
          endLine: 1,
          content: 'line 1',
          runId: 'other-run',
        }),
        newContent: 'updated line 1',
      },
      cwd: '/repo',
      fs,
      capabilityIssuer,
    })

    expect(result[0]).toMatchObject({
      type: 'json',
      value: {
        errorMessage: expect.stringContaining(
          'different project, path, or agent run',
        ),
      },
    })
  })

  test('rejects no-op range replacements', async () => {
    const fs = createMockFs({
      files: { '/repo/src/file.ts': 'line 1\nline 2\n' },
    })

    const result = await replaceRange({
      parameters: {
        path: 'src/file.ts',
        readCapability: capability({
          startLine: 1,
          endLine: 1,
          content: 'line 1',
        }),
        newContent: 'line 1',
      },
      cwd: '/repo',
      fs,
      capabilityIssuer,
    })

    expect(result[0]).toMatchObject({
      type: 'json',
      value: {
        errorMessage: expect.stringContaining('identical to the current range'),
      },
    })
  })

  test('supports direct whole-file cap-only replacement with a trailing newline', async () => {
    const fs = createMockFs({
      files: { '/repo/src/file.ts': 'old content\n' },
    })

    const result = await replaceRange({
      parameters: {
        path: 'src/file.ts',
        readCapability: capability({
          startLine: 1,
          endLine: 2,
          content: 'old content\n',
        }),
        startLine: 1,
        endLine: 2,
        newContent: 'new content\n',
      },
      cwd: '/repo',
      fs,
      capabilityIssuer,
    })

    expect(result[0]).toMatchObject({
      type: 'json',
      value: { kind: 'file_mutation_result', outcome: 'applied' },
    })
    expect(await fs.readFile('/repo/src/file.ts', 'utf-8')).toBe(
      'new content\n',
    )
  })

  test('preserves CRLF line endings', async () => {
    const fs = createMockFs({
      files: { '/repo/src/file.ts': 'line 1\r\nline 2\r\nline 3\r\n' },
    })

    await replaceRange({
      parameters: {
        path: 'src/file.ts',
        readCapability: capability({
          startLine: 2,
          endLine: 2,
          content: 'line 2',
        }),
        newContent: 'updated line 2',
      },
      cwd: '/repo',
      fs,
      capabilityIssuer,
    })

    expect(await fs.readFile('/repo/src/file.ts', 'utf-8')).toBe(
      'line 1\r\nupdated line 2\r\nline 3\r\n',
    )
  })

  test('keeps original line endings outside the edited range in a mixed-ending file', async () => {
    const fs = createMockFs({
      files: { '/repo/src/file.ts': 'a\r\nb\nc\n' },
    })

    const result = await replaceRange({
      parameters: {
        path: 'src/file.ts',
        readCapability: capability({
          startLine: 2,
          endLine: 2,
          content: 'b',
        }),
        newContent: 'B',
      },
      cwd: '/repo',
      fs,
      capabilityIssuer,
    })

    expect(result[0]).toMatchObject({
      type: 'json',
      value: { kind: 'file_mutation_result', outcome: 'applied' },
    })
    // Only line 2 was authorized: line 1 keeps CRLF and line 3 keeps LF.
    expect(await fs.readFile('/repo/src/file.ts', 'utf-8')).toBe('a\r\nB\nc\n')
  })

  test('keeps an LF-only edited range LF-only for multi-line newContent in a mixed-ending file', async () => {
    const fs = createMockFs({
      files: { '/repo/src/file.ts': 'a\r\nb\nc\n' },
    })

    const result = await replaceRange({
      parameters: {
        path: 'src/file.ts',
        readCapability: capability({
          startLine: 2,
          endLine: 2,
          content: 'b',
        }),
        newContent: 'B1\nB2',
      },
      cwd: '/repo',
      fs,
      capabilityIssuer,
    })

    expect(result[0]).toMatchObject({
      type: 'json',
      value: { kind: 'file_mutation_result', outcome: 'applied' },
    })
    // The replaced span ends with LF, so the inserted terminator is LF even
    // though line 1 elsewhere in the file uses CRLF.
    expect(await fs.readFile('/repo/src/file.ts', 'utf-8')).toBe(
      'a\r\nB1\nB2\nc\n',
    )
  })

  test('uses CRLF for multi-line newContent when the replaced span is CRLF', async () => {
    const fs = createMockFs({
      files: { '/repo/src/file.ts': 'a\nb\r\nc\n' },
    })

    await replaceRange({
      parameters: {
        path: 'src/file.ts',
        readCapability: capability({
          startLine: 2,
          endLine: 2,
          content: 'b',
        }),
        newContent: 'B1\nB2',
      },
      cwd: '/repo',
      fs,
      capabilityIssuer,
    })

    expect(await fs.readFile('/repo/src/file.ts', 'utf-8')).toBe(
      'a\nB1\r\nB2\r\nc\n',
    )
  })

  test('falls back to the file-wide CRLF style for the final line of a file with no trailing newline', async () => {
    const fs = createMockFs({
      files: { '/repo/src/file.ts': 'a\r\nb' },
    })

    const result = await replaceRange({
      parameters: {
        path: 'src/file.ts',
        readCapability: capability({
          startLine: 1,
          endLine: 2,
          content: 'a\nb',
        }),
        startLine: 2,
        endLine: 2,
        newContent: 'B1\nB2',
      },
      cwd: '/repo',
      fs,
      capabilityIssuer,
    })

    expect(result[0]).toMatchObject({
      type: 'json',
      value: { kind: 'file_mutation_result', outcome: 'applied' },
    })
    // The replaced span is the unterminated final line, and nothing follows
    // it, so the terminator comes from the CRLF already observed while walking
    // to endLine. The file keeps its missing trailing newline.
    expect(await fs.readFile('/repo/src/file.ts', 'utf-8')).toBe(
      'a\r\nB1\r\nB2',
    )
  })

  test('falls back to LF for an unterminated final line when the walk to endLine saw no CRLF', async () => {
    const fs = createMockFs({
      files: { '/repo/src/file.ts': 'a\nb' },
    })

    const result = await replaceRange({
      parameters: {
        path: 'src/file.ts',
        readCapability: capability({
          startLine: 1,
          endLine: 2,
          content: 'a\nb',
        }),
        startLine: 2,
        endLine: 2,
        newContent: 'B1\nB2',
      },
      cwd: '/repo',
      fs,
      capabilityIssuer,
    })

    expect(result[0]).toMatchObject({
      type: 'json',
      value: { kind: 'file_mutation_result', outcome: 'applied' },
    })
    // Every terminator seen up to endLine is LF, so the bounded fallback stays
    // LF and the missing trailing newline is preserved.
    expect(await fs.readFile('/repo/src/file.ts', 'utf-8')).toBe('a\nB1\nB2')
  })

  test('uses the lone LF that terminates the replaced span over the file-wide CRLF style', async () => {
    const fs = createMockFs({
      files: { '/repo/src/file.ts': 'a\r\nb\nc\r\n' },
    })

    const result = await replaceRange({
      parameters: {
        path: 'src/file.ts',
        readCapability: capability({
          startLine: 2,
          endLine: 2,
          content: 'b',
        }),
        newContent: 'B1\nB2',
      },
      cwd: '/repo',
      fs,
      capabilityIssuer,
    })

    expect(result[0]).toMatchObject({
      type: 'json',
      value: { kind: 'file_mutation_result', outcome: 'applied' },
    })
    // The span itself contains no newline, but it is followed by a lone LF, so
    // the edited range stays LF instead of being promoted to the file-wide
    // CRLF style used by lines 1 and 3.
    expect(await fs.readFile('/repo/src/file.ts', 'utf-8')).toBe(
      'a\r\nB1\nB2\nc\r\n',
    )
  })

  test('treats a lone CR as line content, not a terminator', async () => {
    // `normalizeLineEndings` collapses only \r\n, so this whole fixture is a
    // SINGLE line as far as this tool's line numbering is concerned — a
    // capability for line 2 would be rejected as beyond the file length.
    const fs = createMockFs({
      files: { '/repo/src/file.ts': 'a\rb\rc' },
    })

    const result = await replaceRange({
      parameters: {
        path: 'src/file.ts',
        readCapability: capability({
          startLine: 1,
          endLine: 1,
          content: 'a\rb\rc',
        }),
        newContent: 'B1\nB2',
      },
      cwd: '/repo',
      fs,
      capabilityIssuer,
    })

    expect(result[0]).toMatchObject({
      type: 'json',
      value: { kind: 'file_mutation_result', outcome: 'applied' },
    })
    // The CRs were part of the replaced line's content, and the terminator
    // inserted between the two newContent lines is LF.
    expect(await fs.readFile('/repo/src/file.ts', 'utf-8')).toBe('B1\nB2')
  })

  test('applies resolved absolute lines for the second literal occurrence', async () => {
    // The post-runtime shape: the agent-runtime handler already resolved
    // occurrence targeting into absolute lines, so the applicator only sees
    // startLine/endLine. Lines 4-4 are the SECOND "repeat();".
    const original =
      'const a = 1\nrepeat();\nconst b = 2\nrepeat();\nconst c = 3\n'
    const fs = createMockFs({ files: { '/repo/src/file.ts': original } })

    const result = await replaceRange({
      parameters: {
        path: 'src/file.ts',
        readCapability: capability({
          startLine: 1,
          endLine: 5,
          content:
            'const a = 1\nrepeat();\nconst b = 2\nrepeat();\nconst c = 3',
        }),
        startLine: 4,
        endLine: 4,
        newContent: 'repeat(2);',
      },
      cwd: '/repo',
      fs,
      capabilityIssuer,
    })

    expect(result[0]).toMatchObject({
      type: 'json',
      value: { kind: 'file_mutation_result', outcome: 'applied' },
    })
    // Only the second occurrence changed; the first is untouched.
    expect(await fs.readFile('/repo/src/file.ts', 'utf-8')).toBe(
      'const a = 1\nrepeat();\nconst b = 2\nrepeat(2);\nconst c = 3\n',
    )
  })

  test('rejects unresolved occurrence targeting before reading the file', async () => {
    // occurrence alone (no startLine/endLine) is schema-valid, but the SDK
    // applicator deliberately does not resolve occurrence: only the agent
    // runtime does, against the content it just read. Reading throws here, so
    // the guard is proven to run before the file read rather than only
    // asserting the message text.
    const original =
      'const a = 1\nrepeat();\nconst b = 2\nrepeat();\nconst c = 3\n'
    const files: Record<string, string> = { '/repo/src/file.ts': original }
    const fs = createMockFs({
      files,
      readFileImpl: async () => {
        throw new Error('replace_range read the file before the guard')
      },
      writeFileImpl: async (path, content) => {
        files[path] = content
      },
    })

    const result = await replaceRange({
      parameters: {
        path: 'src/file.ts',
        readCapability: capability({
          startLine: 1,
          endLine: 5,
          content:
            'const a = 1\nrepeat();\nconst b = 2\nrepeat();\nconst c = 3',
        }),
        occurrence: { match: 'repeat();', occurrence: 2 },
        newContent: 'repeat(2);',
      },
      cwd: '/repo',
      fs,
      capabilityIssuer,
    })

    expect(result[0]).toMatchObject({
      type: 'json',
      value: {
        errorMessage: expect.stringContaining(
          'must be resolved to absolute lines',
        ),
      },
    })
    expect(files['/repo/src/file.ts']).toBe(original)
  })

  test('rejects occurrence combined with startLine/endLine without mutating the file', async () => {
    // Mutual exclusion is enforced by the schema refine, so the applicator
    // never reaches its own occurrence guard.
    const original =
      'const a = 1\nrepeat();\nconst b = 2\nrepeat();\nconst c = 3\n'
    const fs = createMockFs({ files: { '/repo/src/file.ts': original } })

    const result = await replaceRange({
      parameters: {
        path: 'src/file.ts',
        readCapability: capability({
          startLine: 1,
          endLine: 5,
          content:
            'const a = 1\nrepeat();\nconst b = 2\nrepeat();\nconst c = 3',
        }),
        startLine: 4,
        endLine: 4,
        occurrence: { match: 'repeat();', occurrence: 2 },
        newContent: 'repeat(2);',
      },
      cwd: '/repo',
      fs,
      capabilityIssuer,
    })

    expect(result[0]).toMatchObject({
      type: 'json',
      value: {
        // The raw path is echoed back so the agent can tell which call failed.
        file: 'src/file.ts',
        errorMessage: 'Missing or invalid replace_range parameters.',
      },
    })
    expect(await fs.readFile('/repo/src/file.ts', 'utf-8')).toBe(original)
  })

  test('reports the unreportable-path sentinel for invalid parameters with a non-string path', async () => {
    const original = 'line 1\nline 2\n'
    const fs = createMockFs({ files: { '/repo/src/file.ts': original } })

    const result = await replaceRange({
      parameters: {
        path: 42,
        readCapability: capability({
          startLine: 1,
          endLine: 2,
          content: 'line 1\nline 2',
        }),
        newContent: 'replacement',
      },
      cwd: '/repo',
      fs,
      capabilityIssuer,
    })

    expect(result[0]).toMatchObject({
      type: 'json',
      value: {
        file: '(unparsed)',
        errorMessage: 'Missing or invalid replace_range parameters.',
      },
    })
    expect(await fs.readFile('/repo/src/file.ts', 'utf-8')).toBe(original)
  })

  test('reports an empty file for invalid parameters with no path supplied', async () => {
    // The counterpart to the sentinel cases above: a missing `path` key is the
    // one input that still echoes the empty path.
    const original = 'line 1\nline 2\n'
    const fs = createMockFs({ files: { '/repo/src/file.ts': original } })

    const result = await replaceRange({
      parameters: {
        readCapability: capability({
          startLine: 1,
          endLine: 2,
          content: 'line 1\nline 2',
        }),
        newContent: 'replacement',
      },
      cwd: '/repo',
      fs,
      capabilityIssuer,
    })

    expect(result[0]).toMatchObject({
      type: 'json',
      value: {
        file: '',
        errorMessage: 'Missing or invalid replace_range parameters.',
      },
    })
    expect(await fs.readFile('/repo/src/file.ts', 'utf-8')).toBe(original)
  })

  test('reports an empty file for parameters that are not an object', async () => {
    // The echo reads `path` straight off the raw parameters, so a payload that
    // is not an object at all must still resolve to the empty path instead of
    // throwing on the property access.
    const original = 'line 1\nline 2\n'
    const fs = createMockFs({ files: { '/repo/src/file.ts': original } })

    for (const parameters of [null, undefined, 'src/file.ts', 42]) {
      const result = await replaceRange({
        parameters,
        cwd: '/repo',
        fs,
        capabilityIssuer,
      })

      expect(result[0]).toMatchObject({
        type: 'json',
        value: {
          file: '',
          errorMessage: 'Missing or invalid replace_range parameters.',
        },
      })
    }
    expect(await fs.readFile('/repo/src/file.ts', 'utf-8')).toBe(original)
  })

  test('replaces a resolved multi-line block and preserves surrounding lines', async () => {
    const original =
      'function a() {\n  return 1\n}\nfunction b() {\n  return 2\n}\n'
    const fs = createMockFs({ files: { '/repo/src/file.ts': original } })

    const result = await replaceRange({
      parameters: {
        path: 'src/file.ts',
        readCapability: capability({
          startLine: 1,
          endLine: 6,
          content:
            'function a() {\n  return 1\n}\nfunction b() {\n  return 2\n}',
        }),
        startLine: 4,
        endLine: 6,
        newContent: 'function b() {\n  return 20\n}',
      },
      cwd: '/repo',
      fs,
      capabilityIssuer,
    })

    expect(result[0]).toMatchObject({
      type: 'json',
      value: { kind: 'file_mutation_result', outcome: 'applied' },
    })
    expect(await fs.readFile('/repo/src/file.ts', 'utf-8')).toBe(
      'function a() {\n  return 1\n}\nfunction b() {\n  return 20\n}\n',
    )
  })

  test('defaults an omitted target to the whole capability-covered range', async () => {
    // Both `??` defaults at the applicator's single call site: startLine and
    // endLine are omitted, so the complete multi-line observed range is
    // replaced and the lines outside it are untouched.
    const fs = createMockFs({
      files: { '/repo/src/file.ts': 'a\nb\nc\nd\n' },
    })

    const result = await replaceRange({
      parameters: {
        path: 'src/file.ts',
        readCapability: capability({
          startLine: 2,
          endLine: 3,
          content: 'b\nc',
        }),
        newContent: 'B\nC\nextra',
      },
      cwd: '/repo',
      fs,
      capabilityIssuer,
    })

    expect(result[0]).toMatchObject({
      type: 'json',
      value: { kind: 'file_mutation_result', outcome: 'applied' },
    })
    expect(await fs.readFile('/repo/src/file.ts', 'utf-8')).toBe(
      'a\nB\nC\nextra\nd\n',
    )
  })

  test('rejects a capability issued for another path with the single scope message', async () => {
    const original = 'line 1\nline 2\n'
    const fs = createMockFs({ files: { '/repo/src/file.ts': original } })

    const result = await replaceRange({
      parameters: {
        path: 'src/file.ts',
        readCapability: capability({
          path: 'src/other.ts',
          startLine: 1,
          endLine: 1,
          content: 'line 1',
        }),
        newContent: 'updated line 1',
      },
      cwd: '/repo',
      fs,
      capabilityIssuer,
    })

    expect(result[0]).toMatchObject({
      type: 'json',
      value: {
        file: 'src/file.ts',
        errorMessage: expect.stringContaining(
          'different project, path, or agent run',
        ),
      },
    })
    expect(await fs.readFile('/repo/src/file.ts', 'utf-8')).toBe(original)
  })

  test('rejects an undecodable readCapability at the schema boundary', async () => {
    // The schema's superRefine rejects any token that fails to decode, so the
    // applicator's scope guard only ever sees a decodable cap.v3 token: a
    // decode failure surfaces as an invalid-parameters result, never as a
    // decode message from the guard.
    const original = 'line 1\nline 2\n'
    const fs = createMockFs({ files: { '/repo/src/file.ts': original } })

    const result = await replaceRange({
      parameters: {
        path: 'src/file.ts',
        readCapability: 'cap.v3.not-a-real-token',
        newContent: 'updated line 1',
      },
      cwd: '/repo',
      fs,
      capabilityIssuer,
    })

    expect(result[0]).toMatchObject({
      type: 'json',
      value: {
        file: 'src/file.ts',
        errorMessage: 'Missing or invalid replace_range parameters.',
      },
    })
    expect(await fs.readFile('/repo/src/file.ts', 'utf-8')).toBe(original)
  })

  test('collapses a newline-bearing raw path into the single-line sentinel', async () => {
    const original = 'line 1\nline 2\n'
    const fs = createMockFs({ files: { '/repo/src/file.ts': original } })
    // A short enough path to pass the length bound, but it carries a newline
    // that would otherwise forge an extra line in the agent-facing diagnostic.
    const injectedPath = 'src/a\nfake: line.ts'

    const result = await replaceRange({
      parameters: {
        path: injectedPath,
        readCapability: capability({
          path: injectedPath,
          startLine: 1,
          endLine: 2,
          content: 'line 1\nline 2',
        }),
        // startLine after endLine, so the input never parses.
        startLine: 2,
        endLine: 1,
        newContent: 'replacement',
      },
      cwd: '/repo',
      fs,
      capabilityIssuer,
    })

    expect(result[0]).toMatchObject({ type: 'json' })
    const { file, errorMessage } = (
      result[0] as { value: { file: string; errorMessage: string } }
    ).value
    expect(file).toBe('(unparsed)')
    expect(file).not.toContain('\n')
    expect(errorMessage).toBe('Missing or invalid replace_range parameters.')
    expect(await fs.readFile('/repo/src/file.ts', 'utf-8')).toBe(original)
  })

  test('surfaces a read failure without a code unprefixed', async () => {
    const original = 'line 1\nline 2\n'
    const files: Record<string, string> = { '/repo/src/file.ts': original }
    const fs = createMockFs({
      files,
      readFileImpl: async () => {
        throw new Error('boom')
      },
      writeFileImpl: async (path, content) => {
        files[path] = content
      },
    })

    const result = await replaceRange({
      parameters: {
        path: 'src/file.ts',
        readCapability: capability({
          startLine: 1,
          endLine: 2,
          content: 'line 1\nline 2',
        }),
        newContent: 'updated line 1\nupdated line 2',
      },
      cwd: '/repo',
      fs,
      capabilityIssuer,
    })

    // No `code` on the thrown error, so the message is reported as-is with no
    // `replace_range failed with ...` prefix.
    expect(result[0]).toMatchObject({
      type: 'json',
      value: { file: 'src/file.ts', errorMessage: 'boom' },
    })
    expect(files['/repo/src/file.ts']).toBe(original)
  })

  test('rejects a line-endings-only edit as a no-op without rewriting the file', async () => {
    const original = 'a\r\n'
    const fs = createMockFs({ files: { '/repo/src/file.ts': original } })

    const result = await replaceRange({
      parameters: {
        path: 'src/file.ts',
        readCapability: capability({
          startLine: 1,
          endLine: 2,
          content: 'a\n',
        }),
        newContent: 'a\r\n',
      },
      cwd: '/repo',
      fs,
      capabilityIssuer,
    })

    // The capability covers the whole file, including the phantom trailing
    // entry a read reports past the final terminator, so the target range text
    // is 'a\n'. Both sides are compared LF-normalized, so re-terminating that
    // line is a no-op here rather than an LF->CRLF rewrite.
    expect(result[0]).toMatchObject({
      type: 'json',
      value: {
        file: 'src/file.ts',
        errorMessage: expect.stringContaining('identical to the current range'),
      },
    })
    expect(await fs.readFile('/repo/src/file.ts', 'utf-8')).toBe(original)
  })

  test('refuses to commit when only the line terminators changed after the read', async () => {
    // The splice is computed from the raw bytes of the pre-read, while
    // `expectedHash` is LF-normalized: a concurrent CRLF->LF-only external
    // rewrite passes that guard, so the byte-exact expectation must stop the
    // commit instead of resurrecting the CRLF terminators file-wide.
    const crlf = 'line 1\r\nline 2\r\n'
    const lf = 'line 1\nline 2\n'
    const files: Record<string, string> = { '/repo/src/file.ts': crlf }
    const fs = createMockFs({
      files,
      readFileImpl: async (path) => {
        const current = files[path]!
        // The external CRLF->LF-only rewrite lands right after
        // replace_range's own pre-check read, so every read taken inside
        // changeFile's lock observes the LF-only file.
        if (current === crlf) files[path] = lf
        return current
      },
      writeFileImpl: async (path, content) => {
        files[path] = content
      },
    })

    const result = await replaceRange({
      parameters: {
        path: 'src/file.ts',
        readCapability: capability({
          startLine: 2,
          endLine: 2,
          content: 'line 2',
        }),
        newContent: 'updated line 2',
      },
      cwd: '/repo',
      fs,
      capabilityIssuer,
    })

    expect(result[0]).toMatchObject({
      type: 'json',
      value: {
        kind: 'file_mutation_result',
        outcome: 'not_applied',
        errors: [
          expect.objectContaining({
            code: 'stale_state',
            message: expect.stringContaining('exact bytes changed'),
          }),
        ],
      },
    })
    expect(files['/repo/src/file.ts']).toBe(lf)
  })

  test('rejects an already-oversize target before normalizing or splitting it', async () => {
    const original = 'x'.repeat(MAX_TRANSACTION_FILE_BYTES + 1)
    const files: Record<string, string> = { '/repo/src/file.ts': original }
    const fs = createMockFs({
      files,
      writeFileImpl: async (path, content) => {
        files[path] = content
      },
    })

    const result = await replaceRange({
      parameters: {
        path: 'src/file.ts',
        readCapability: capability({
          startLine: 1,
          endLine: 1,
          content: 'line 1',
        }),
        newContent: 'replacement',
      },
      cwd: '/repo',
      fs,
      capabilityIssuer,
    })

    // The early guard runs before the capability-freshness check, so an
    // oversize file is refused even though the capability content no longer
    // matches it.
    expect(result[0]).toMatchObject({
      type: 'json',
      value: {
        file: 'src/file.ts',
        errorMessage: expect.stringContaining(
          `is already ${MAX_TRANSACTION_FILE_BYTES + 1} bytes, over the ${MAX_TRANSACTION_FILE_BYTES}-byte per-file limit`,
        ),
      },
    })
    expect(files['/repo/src/file.ts']).toBe(original)
  })

  test('rejects an oversize result with the declared error shape and leaves the file unchanged', async () => {
    // `newContent` is unbounded in the schema, so without the applicator's own
    // byte check `changeFile`'s per-file refine would throw a ZodError and the
    // caller would lose the `file` key this tool declares.
    const original = 'line 1\nline 2\n'
    const fs = createMockFs({ files: { '/repo/src/file.ts': original } })

    const result = await replaceRange({
      parameters: {
        path: 'src/file.ts',
        readCapability: capability({
          startLine: 1,
          endLine: 1,
          content: 'line 1',
        }),
        newContent: 'x'.repeat(MAX_TRANSACTION_FILE_BYTES + 1),
      },
      cwd: '/repo',
      fs,
      capabilityIssuer,
    })

    expect(result[0]).toMatchObject({
      type: 'json',
      value: {
        file: 'src/file.ts',
        errorMessage: expect.stringContaining(
          `over the ${MAX_TRANSACTION_FILE_BYTES}-byte per-file limit`,
        ),
      },
    })
    expect(await fs.readFile('/repo/src/file.ts', 'utf-8')).toBe(original)
  })
})
