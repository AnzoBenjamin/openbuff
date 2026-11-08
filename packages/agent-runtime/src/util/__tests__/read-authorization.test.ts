import { describe, expect, it } from 'bun:test'

import {
  remintConfirmedPostEditAnchors,
  revokeImplicitReadAuthorizationsAfterCompaction,
} from '../read-authorization'

import {
  decodeReadCapabilityToken,
  encodeReadCapabilityToken,
  getContentHash,
  getObservationContentHash,
} from '@codebuff/common/util/content-hash'
import {
  captureTextDocument,
  getRawReadBasis,
} from '@codebuff/common/util/byte-text'

import type { AgentState } from '@codebuff/common/types/session-state'

describe('revokeImplicitReadAuthorizationsAfterCompaction', () => {
  it('keeps sticky whole-file authority and records a typed reread reason', () => {
    const contentHash = getContentHash('export const a = 1\n')
    const rawBasis = getRawReadBasis(
      captureTextDocument('export const a = 1\n'),
      1,
      2,
      'whole',
    )
    const readCapability = encodeReadCapabilityToken({
      startLine: 1,
      endLine: 2,
      hash: contentHash,
      scope: { projectId: '/project', path: 'src/a.ts', runId: 'run' },
      rawBasis,
    })
    const state = {
      readAuthorizationsByPath: { 'src/a.ts': true },
      readAuthorizationHashesByPath: {
        'src/a.ts': contentHash,
        'src/hash-only.ts': getContentHash('hash-only\n'),
      },
      rawReadAuthorizationHashesByPath: { 'src/a.ts': rawBasis.rawHash },
      confirmedPostEditAnchorsByPath: {
        'src/a.ts': {
          startLine: 1,
          endLine: 2,
          contentHash,
          readCapability,
          rawBasis,
        },
      },
      editRereadRequirementsByPath: {
        'src/existing.ts': {
          reason: 'stale_snapshot',
          sourceTool: 'str_replace',
        },
      },
    } as unknown as AgentState

    revokeImplicitReadAuthorizationsAfterCompaction(state)

    // Sticky maps are preserved; edit-time hash freshness still gates edits.
    expect(state.readAuthorizationsByPath).toEqual({ 'src/a.ts': true })
    expect(state.readAuthorizationHashesByPath).toEqual({
      'src/a.ts': contentHash,
      'src/hash-only.ts': getContentHash('hash-only\n'),
    })
    expect(state.confirmedPostEditAnchorsByPath).toEqual({
      'src/a.ts': {
        startLine: 1,
        endLine: 2,
        contentHash,
        readCapability,
        rawBasis,
      },
    })
    expect(state.rawReadAuthorizationHashesByPath).toEqual({
      'src/a.ts': rawBasis.rawHash,
    })
    expect(state.editRereadRequirementsByPath).toEqual({
      'src/a.ts': {
        reason: 'context_compacted',
        sourceTool: 'context compaction',
      },
      'src/hash-only.ts': {
        reason: 'context_compacted',
        sourceTool: 'context compaction',
      },
      // Non-context_compacted requirements are preserved.
      'src/existing.ts': {
        reason: 'stale_snapshot',
        sourceTool: 'str_replace',
      },
    })
  })
})

describe('remintConfirmedPostEditAnchors', () => {
  const content = '\uFEFFexport const value = 1\r\n'
  const contentHash = getObservationContentHash(content)
  const rawBasis = getRawReadBasis(captureTextDocument(content), 1, 2, 'whole')
  const sameScopeCapability = encodeReadCapabilityToken({
    startLine: 1,
    endLine: 2,
    hash: contentHash,
    scope: { projectId: '/project', path: 'src/a.ts', runId: 'run' },
    rawBasis,
  })
  const signatureStart = sameScopeCapability.lastIndexOf('.') + 1
  const tamperedSameScopeCapability =
    sameScopeCapability.slice(0, signatureStart) +
    (sameScopeCapability[signatureStart] === 'A' ? 'B' : 'A') +
    sameScopeCapability.slice(signatureStart + 1)
  const crossScopeCapability = encodeReadCapabilityToken({
    startLine: 1,
    endLine: 2,
    hash: contentHash,
    scope: { projectId: '/old-project', path: 'src/a.ts', runId: 'old-run' },
    rawBasis,
  })
  const wellFormedSameScope = {
    startLine: 1,
    endLine: 2,
    contentHash,
    readCapability: sameScopeCapability,
    rawBasis,
  }
  const wellFormedOkPathScope = {
    startLine: 1,
    endLine: 2,
    contentHash,
    readCapability: encodeReadCapabilityToken({
      startLine: 1,
      endLine: 2,
      hash: contentHash,
      scope: { projectId: '/project', path: 'src/ok.ts', runId: 'run' },
      rawBasis,
    }),
    rawBasis,
  }
  const wellFormedCrossScope = {
    startLine: 1,
    endLine: 2,
    contentHash,
    readCapability: crossScopeCapability,
    rawBasis,
  }

  it('remints cap.v4 with its original raw basis for the same project/run', () => {
    const reminted = remintConfirmedPostEditAnchors({
      anchors: { 'src/a.ts': wellFormedSameScope },
      projectId: '/project',
      runId: 'run',
    })

    expect(reminted['src/a.ts']?.startLine).toBe(1)
    expect(reminted['src/a.ts']?.endLine).toBe(2)
    expect(reminted['src/a.ts']?.contentHash).toBe(contentHash)
    expect(reminted['src/a.ts']?.projectId).toBe('/project')
    expect(reminted['src/a.ts']?.runId).toBe('run')
    const decoded = decodeReadCapabilityToken(
      reminted['src/a.ts']!.readCapability,
    )
    expect(typeof decoded).not.toBe('string')
    if (typeof decoded !== 'string') {
      expect(decoded.hash).toBe(contentHash)
      expect(decoded.startLine).toBe(1)
      expect(decoded.endLine).toBe(2)
      expect(decoded.tokenVersion).toBe('v4')
      expect(decoded.rawBasis).toEqual(rawBasis)
    }
  })

  it('remints from stamped issuer when stored token no longer authenticates (restart path, opted in)', () => {
    expect(typeof decodeReadCapabilityToken(tamperedSameScopeCapability)).toBe(
      'string',
    )
    const reminted = remintConfirmedPostEditAnchors({
      anchors: {
        'src/a.ts': {
          startLine: 1,
          endLine: 2,
          contentHash,
          // Unauthenticated after process restart (HMAC key rotated).
          readCapability: tamperedSameScopeCapability,
          rawBasis,
          projectId: '/project',
          runId: 'run',
        },
      },
      projectId: '/project',
      runId: 'run',
      // Path 4 is opt-in (M1-T4b): the caller must accept the issuer-stamp
      // trust model explicitly.
      allowUnauthenticatedIssuerRestamp: true,
    })

    expect(reminted['src/a.ts']?.contentHash).toBe(contentHash)
    expect(reminted['src/a.ts']?.projectId).toBe('/project')
    expect(reminted['src/a.ts']?.runId).toBe('run')
    const decoded = decodeReadCapabilityToken(
      reminted['src/a.ts']!.readCapability,
    )
    expect(typeof decoded).not.toBe('string')
    if (typeof decoded !== 'string') expect(decoded.rawBasis).toEqual(rawBasis)
  })

  it('drops stamped-issuer anchors by default (fail closed, M1-T4b)', () => {
    // Same shape as the restart-path test above, but WITHOUT the opt-in: the
    // stamps are unauthenticated persisted state, so the default must drop
    // the anchor instead of minting a fresh authenticated cap.v4 from them.
    expect(typeof decodeReadCapabilityToken(tamperedSameScopeCapability)).toBe(
      'string',
    )
    const reminted = remintConfirmedPostEditAnchors({
      anchors: {
        'src/a.ts': {
          startLine: 1,
          endLine: 2,
          contentHash,
          readCapability: tamperedSameScopeCapability,
          rawBasis,
          projectId: '/project',
          runId: 'run',
        },
      },
      projectId: '/project',
      runId: 'run',
    })

    expect(reminted).toEqual({})
  })

  it('drops cross-project/cross-run remint even with well-formed hash/bounds', () => {
    const reminted = remintConfirmedPostEditAnchors({
      anchors: {
        'src/a.ts': wellFormedCrossScope,
        'src/stamped.ts': {
          ...wellFormedCrossScope,
          projectId: '/old-project',
          runId: 'old-run',
        },
      },
      projectId: '/project',
      runId: 'run',
    })

    expect(reminted).toEqual({})
  })

  it('drops malformed entries without throwing', () => {
    const reminted = remintConfirmedPostEditAnchors({
      anchors: {
        '': wellFormedSameScope,
        'src/bad-start.ts': { ...wellFormedSameScope, startLine: 2 },
        'src/bad-end.ts': { ...wellFormedSameScope, endLine: 0 },
        'src/bad-hash.ts': {
          ...wellFormedSameScope,
          contentHash: 'not-a-hash',
        },
        'src/missing-cap.ts': {
          startLine: 1,
          endLine: 2,
          contentHash,
          readCapability: '',
        },
        'src/ok.ts': wellFormedOkPathScope,
      },
      projectId: '/project',
      runId: 'run',
    })

    expect(Object.keys(reminted)).toEqual(['src/ok.ts'])
  })

  it('drops well-formed entries when scope is empty (no unauthenticated keep)', () => {
    const reminted = remintConfirmedPostEditAnchors({
      anchors: { 'src/a.ts': wellFormedSameScope },
      projectId: '',
      runId: '',
    })

    expect(reminted).toEqual({})
  })

  it('drops empty-scope entries that are not well-formed objects', () => {
    const reminted = remintConfirmedPostEditAnchors({
      anchors: {
        'src/a.ts': {
          startLine: 1,
          endLine: 2,
          contentHash,
          readCapability: '',
        },
      },
      projectId: '',
      runId: '',
    })

    expect(reminted).toEqual({})
  })

  it('drops hostile and non-canonical path keys without assigning them', () => {
    const anchors: Record<string, typeof wellFormedSameScope> = {
      constructor: wellFormedSameScope,
      prototype: wellFormedSameScope,
      '../escape.ts': wellFormedSameScope,
      '/abs.ts': wellFormedSameScope,
      'src/ok.ts': wellFormedOkPathScope,
    }
    // Object-literal `__proto__` sets the prototype; define an own key instead.
    Object.defineProperty(anchors, '__proto__', {
      value: wellFormedSameScope,
      enumerable: true,
      configurable: true,
      writable: true,
    })

    const reminted = remintConfirmedPostEditAnchors({
      anchors,
      projectId: '/project',
      runId: 'run',
    })

    expect(Object.keys(reminted)).toEqual(['src/ok.ts'])
    expect(Object.prototype.hasOwnProperty.call(reminted, '__proto__')).toBe(
      false,
    )
  })

  it('never upgrades authenticated or stamped v3 data using an unsigned claimed basis', () => {
    const legacy = encodeReadCapabilityToken({
      startLine: 1,
      endLine: 2,
      hash: contentHash,
      scope: { projectId: '/project', path: 'src/a.ts', runId: 'run' },
    })
    const reminted = remintConfirmedPostEditAnchors({
      anchors: {
        'src/a.ts': {
          startLine: 1,
          endLine: 2,
          contentHash,
          readCapability: legacy,
          rawBasis,
          projectId: '/project',
          runId: 'run',
        },
      },
      projectId: '/project',
      runId: 'run',
      allowUnauthenticatedIssuerRestamp: true,
    })
    expect(reminted).toEqual({})
    const compatible = remintConfirmedPostEditAnchors({
      anchors: {
        'src/a.ts': {
          startLine: 1,
          endLine: 2,
          contentHash,
          readCapability: legacy,
        },
      },
      projectId: '/project',
      runId: 'run',
    })
    const decoded = decodeReadCapabilityToken(
      compatible['src/a.ts']!.readCapability,
    )
    if (typeof decoded === 'string') throw new Error(decoded)
    expect(decoded.tokenVersion).toBe('v3')
    expect(decoded.rawBasis).toBeUndefined()
  })

  it('cannot remint a full-looking line scope as whole-file post-edit authority', () => {
    const lines = getRawReadBasis(captureTextDocument(content), 1, 2, 'lines')
    const readCapability = encodeReadCapabilityToken({
      startLine: 1,
      endLine: 2,
      hash: contentHash,
      scope: { projectId: '/project', path: 'src/a.ts', runId: 'run' },
      rawBasis: lines,
    })
    expect(
      remintConfirmedPostEditAnchors({
        anchors: {
          'src/a.ts': {
            startLine: 1,
            endLine: 2,
            contentHash,
            readCapability,
            rawBasis: lines,
          },
        },
        projectId: '/project',
        runId: 'run',
      }),
    ).toEqual({})
  })
})
