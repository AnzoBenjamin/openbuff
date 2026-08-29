import { describe, expect, it } from 'bun:test'

import {
  remintConfirmedPostEditAnchors,
  revokeImplicitReadAuthorizationsAfterCompaction,
} from '../read-authorization'

import {
  decodeReadCapabilityToken,
  encodeReadCapabilityToken,
  getContentHash,
} from '@codebuff/common/util/content-hash'

import type { AgentState } from '@codebuff/common/types/session-state'

describe('revokeImplicitReadAuthorizationsAfterCompaction', () => {
  it('keeps sticky whole-file authority and records a typed reread reason', () => {
    const contentHash = getContentHash('export const a = 1\n')
    const readCapability = encodeReadCapabilityToken({
      startLine: 1,
      endLine: 1,
      hash: contentHash,
      scope: { projectId: '/project', path: 'src/a.ts', runId: 'run' },
    })
    const state = {
      readAuthorizationsByPath: { 'src/a.ts': true },
      readAuthorizationHashesByPath: {
        'src/a.ts': 'sha256:a',
        'src/hash-only.ts': 'sha256:b',
      },
      confirmedPostEditAnchorsByPath: {
        'src/a.ts': {
          startLine: 1,
          endLine: 1,
          contentHash,
          readCapability,
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
      'src/a.ts': 'sha256:a',
      'src/hash-only.ts': 'sha256:b',
    })
    expect(state.confirmedPostEditAnchorsByPath).toEqual({
      'src/a.ts': {
        startLine: 1,
        endLine: 1,
        contentHash,
        readCapability,
      },
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
  const contentHash = getContentHash('export const value = 1\n')
  const sameScopeCapability = encodeReadCapabilityToken({
    startLine: 1,
    endLine: 2,
    hash: contentHash,
    scope: { projectId: '/project', path: 'src/a.ts', runId: 'run' },
  })
  const crossScopeCapability = encodeReadCapabilityToken({
    startLine: 1,
    endLine: 2,
    hash: contentHash,
    scope: { projectId: '/old-project', path: 'src/a.ts', runId: 'old-run' },
  })
  const wellFormedSameScope = {
    startLine: 1,
    endLine: 2,
    contentHash,
    readCapability: sameScopeCapability,
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
    }),
  }
  const wellFormedCrossScope = {
    startLine: 1,
    endLine: 2,
    contentHash,
    readCapability: crossScopeCapability,
  }

  it('remints cap.v3 when stored token authenticates for the same project/run', () => {
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
    }
  })

  it('remints from stamped issuer when stored token no longer authenticates (restart path)', () => {
    const reminted = remintConfirmedPostEditAnchors({
      anchors: {
        'src/a.ts': {
          startLine: 1,
          endLine: 2,
          contentHash,
          // Unauthenticated after process restart (HMAC key rotated).
          readCapability: 'cap.v3.1.2.invalid-token-payload-for-restart',
          projectId: '/project',
          runId: 'run',
        },
      },
      projectId: '/project',
      runId: 'run',
    })

    expect(reminted['src/a.ts']?.contentHash).toBe(contentHash)
    expect(reminted['src/a.ts']?.projectId).toBe('/project')
    expect(reminted['src/a.ts']?.runId).toBe('run')
    const decoded = decodeReadCapabilityToken(
      reminted['src/a.ts']!.readCapability,
    )
    expect(typeof decoded).not.toBe('string')
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
})
