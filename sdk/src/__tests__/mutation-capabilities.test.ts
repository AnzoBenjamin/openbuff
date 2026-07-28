import { describe, expect, it } from 'bun:test'

import {
  decodeReadCapabilityToken,
  getContentHash,
  getExactContentHash,
  readCapabilityMatchesScope,
} from '@codebuff/common/util/content-hash'

import {
  buildFreshWholeFileCapability,
  buildFreshWholeFileMutationAuthority,
} from '../tools/mutation-capabilities'

describe('mutation capabilities', () => {
  it('emits a scoped cap.v3 token while snapshotting exact committed bytes', () => {
    const capabilityIssuer = {
      projectId: '/project',
      runId: 'run-mutation-1',
    }
    const content = 'const first = 1\r\nconst second = 2\r\n'
    const capability = buildFreshWholeFileCapability({
      canonicalPath: '/project/src/example.ts',
      path: 'src/example.ts',
      content,
      capabilityIssuer,
    })

    expect(capability.token).toStartWith('cap.v3.')
    const decoded = decodeReadCapabilityToken(capability.token)
    if (typeof decoded === 'string') throw new Error(decoded)
    expect(decoded).toMatchObject({
      startLine: 1,
      endLine: 3,
      hash: getContentHash(content),
      tokenVersion: 'v3',
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
      capabilityIssuer,
    })

    expect(authority).toBeDefined()
    if (!authority) throw new Error('Expected mutation authority')
    expect(authority.editAnchor).toEqual({
      startLine: 1,
      endLine: 3,
      contentHash: getContentHash(content),
      readCapability: authority.capability.token,
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
})
