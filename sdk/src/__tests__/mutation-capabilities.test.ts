import { describe, expect, it } from 'bun:test'
import { createMockFs } from '@codebuff/common/testing/mocks/filesystem'
import { applySemanticEdit } from '../tools/semantic-edit-apply'

import {
  decodeReadCapabilityToken,
  getContentHash,
  getExactContentHash,
  getObservationContentHash,
  readCapabilityMatchesScope,
} from '@codebuff/common/util/content-hash'
import {
  captureTextDocument,
  getRawReadBasis,
} from '@codebuff/common/util/byte-text'

import {
  buildFreshWholeFileCapability,
  buildFreshWholeFileMutationAuthority,
} from '../tools/mutation-capabilities'

describe('mutation capabilities', () => {
  it('[B03] semantic compact projection preserves refused evidence and does not report applied', async () => {
    const fs = createMockFs({ files: { '/repo/a.txt': 'before\n' } })
    let attempts = 0
    fs.conditionalCommit = async () => {
      attempts++
      await fs.writeFile('/repo/a.txt', 'foreign\n')
      return { applied: false, actualHash: getExactContentHash('foreign\n') }
    }
    const result = await applySemanticEdit(
      { changedFiles: [{ path: '/repo/a.txt', newContent: 'after\n' }] },
      { cwd: '/repo', fs },
    )
    expect(result.output[0]?.value).toMatchObject({
      applied: false,
      results: [{ path: 'a.txt', applied: false }],
    })
    expect(result.mutation?.actions[0]?.forward?.outcome).toBe('not_applied')
    expect(result.mutation?.authorityReceipt?.status).toBe('failed')
    expect(attempts).toBe(1)
    expect(await fs.readFile('/repo/a.txt', 'utf8')).toBe('foreign\n')
  })

  it('emits a cap.v4 token binding the confirmed exact committed bytes', () => {
    const capabilityIssuer = {
      projectId: '/project',
      runId: 'run-mutation-1',
    }
    const content = 'const first = 1\r\nconst second = 2\r\n'
    const capability = buildFreshWholeFileCapability({
      canonicalPath: '/project/src/example.ts',
      path: 'src/example.ts',
      content,
      confirmedAfterHash: getExactContentHash(content),
      capabilityIssuer,
    })

    expect(capability.token).toStartWith('cap.v4.')
    const decoded = decodeReadCapabilityToken(capability.token)
    if (typeof decoded === 'string') throw new Error(decoded)
    expect(decoded).toMatchObject({
      startLine: 1,
      endLine: 3,
      hash: getContentHash(content),
      tokenVersion: 'v4',
      rawBasis: getRawReadBasis(captureTextDocument(content), 1, 3, 'whole'),
    })
    expect(capability.snapshot.contentHash).toBe(getExactContentHash(content))
    expect(capability.snapshot.contentHash).not.toBe(decoded.hash)
    expect(
      readCapabilityMatchesScope(decoded, {
        ...capabilityIssuer,
        path: 'src/example.ts',
      }),
    ).toBe(true)
  })

  it.each([
    ['projectId', { projectId: './', runId: 'run-1' }, 'src/example.ts'],
    ['path', { projectId: '/project', runId: 'run-1' }, './/'],
    ['runId', { projectId: '/project', runId: '.' }, 'src/example.ts'],
  ])(
    'fails closed for an empty normalized %s at SDK mint boundaries',
    (_, capabilityIssuer, path) => {
      const params = {
        canonicalPath: '/project/src/example.ts',
        path,
        content: 'value\n',
        confirmedAfterHash: getExactContentHash('value\n'),
        capabilityIssuer,
      }

      expect(() => buildFreshWholeFileCapability(params)).toThrow(
        'nonempty normalized projectId, path, and runId',
      )
      expect(buildFreshWholeFileMutationAuthority(params)).toBeUndefined()
    },
  )

  it('builds a bounded action-local anchor and omits oversized authority', () => {
    const capabilityIssuer = {
      projectId: '/project',
      runId: 'run-mutation-2',
    }
    const content = 'first\r\nsecond\r\n'
    const authority = buildFreshWholeFileMutationAuthority({
      canonicalPath: '/project/src/example.ts',
      path: 'src/example.ts',
      content,
      confirmedAfterHash: getExactContentHash(content),
      capabilityIssuer,
    })

    expect(authority).toBeDefined()
    if (!authority) throw new Error('Expected mutation authority')
    expect(authority.editAnchor).toEqual({
      startLine: 1,
      endLine: 3,
      contentHash: getContentHash(content),
      readCapability: authority.capability.token,
      rawBasis: getRawReadBasis(captureTextDocument(content), 1, 3, 'whole'),
    })
    expect(
      buildFreshWholeFileMutationAuthority({
        canonicalPath: '/project/src/large.txt',
        path: 'src/large.txt',
        content: 'x'.repeat(10 * 1024 * 1024 + 1),
        capabilityIssuer,
      }),
    ).toBeUndefined()
  })

  it('refuses fresh authority for unconfirmed or divergent after-bytes', () => {
    const params = {
      canonicalPath: '/project/bom.txt',
      path: 'bom.txt',
      content: '\uFEFFone\r\ntwo\n',
      capabilityIssuer: { projectId: '/project', runId: 'raw-after' },
    }
    expect(buildFreshWholeFileMutationAuthority(params)).toBeUndefined()
    expect(
      buildFreshWholeFileMutationAuthority({
        ...params,
        confirmedAfterHash: getExactContentHash('one\r\ntwo\n'),
      }),
    ).toBeUndefined()
    const authority = buildFreshWholeFileMutationAuthority({
      ...params,
      confirmedAfterHash: getExactContentHash(params.content),
    })!
    expect(authority.afterContent).toBe(params.content)
    expect(authority.editAnchor.contentHash).toBe(
      getObservationContentHash(params.content),
    )
    expect(authority.editAnchor.rawBasis).toMatchObject({
      scope: 'whole',
      documentBom: 'utf8',
      includesBom: true,
    })
    expect(
      buildFreshWholeFileMutationAuthority({
        ...params,
        content: '\ud800',
        confirmedAfterHash: getExactContentHash('\ud800'),
      }),
    ).toBeUndefined()
  })
})
