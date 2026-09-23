import { describe, expect, test } from 'bun:test'

import {
  getInitialAgentState,
  sanitizeAgentStateSecurityMaps,
  type AgentState,
  type ConfirmedPostEditAnchor,
} from '../session-state'

const validContentHash = `sha256:${'a'.repeat(64)}`
const validCapability = [
  'cap.v3.1.4',
  'A'.repeat(43),
  'B'.repeat(43),
  'C'.repeat(43),
].join('.')

const validAnchor: ConfirmedPostEditAnchor = {
  startLine: 1,
  endLine: 4,
  contentHash: validContentHash,
  readCapability: validCapability,
}

/**
 * Simulates the persisted-session restore path: mainAgentState reaches
 * applyOverridesToSessionState as a JSON.parse-and-cast, so its static field
 * types are unverified claims. Forged fixtures are built the same way.
 */
const asRestoredAgentState = (forged: Record<string, unknown>): AgentState =>
  JSON.parse(JSON.stringify(forged)) as AgentState

describe('sanitizeAgentStateSecurityMaps (M2-T3 restore boundary)', () => {
  test('strips non-object security maps wholesale', () => {
    const state = asRestoredAgentState({
      ...getInitialAgentState(),
      readAuthorizationsByPath: 'forged-authority-map',
      readAuthorizationHashesByPath: ['not', 'an', 'object'],
      confirmedPostEditAnchorsByPath: 42,
    })

    const sanitized = sanitizeAgentStateSecurityMaps(state)

    expect(sanitized.readAuthorizationsByPath).toBeUndefined()
    expect(sanitized.readAuthorizationHashesByPath).toBeUndefined()
    expect(sanitized.confirmedPostEditAnchorsByPath).toBeUndefined()
  })

  test('drops individually forged entries while keeping valid ones', () => {
    const state = asRestoredAgentState({
      ...getInitialAgentState(),
      readAuthorizationsByPath: {
        'src/read.ts': true,
        'src/forged.ts': 'yes',
        'src/numeric.ts': 1,
        '': true,
      },
      readAuthorizationHashesByPath: {
        'src/read.ts': validContentHash,
        'src/numeric-hash.ts': 42,
        'src/wrong-prefix.ts': `md5:${'b'.repeat(64)}`,
        '': validContentHash,
      },
      confirmedPostEditAnchorsByPath: {
        'src/edited.ts': validAnchor,
        'src/missing-hash.ts': {
          startLine: 1,
          endLine: 4,
          readCapability: validCapability,
        },
        'src/cap-v2.ts': {
          ...validAnchor,
          readCapability: validAnchor.readCapability.replace(
            'cap.v3.',
            'cap.v2.',
          ),
        },
        'src/inverted-bounds.ts': { ...validAnchor, startLine: 5, endLine: 4 },
      },
    })

    const sanitized = sanitizeAgentStateSecurityMaps(state)

    // Non-true values and empty-path keys are stripped from the boolean map.
    expect(sanitized.readAuthorizationsByPath).toEqual({
      'src/read.ts': true,
    })
    // Non-sha256 values and empty-path keys are stripped from the hash map.
    expect(sanitized.readAuthorizationHashesByPath).toEqual({
      'src/read.ts': validContentHash,
    })
    // Anchors missing contentHash, carrying a cap.v2-prefixed capability, or
    // with endLine < startLine are stripped from the anchor map.
    expect(sanitized.confirmedPostEditAnchorsByPath).toEqual({
      'src/edited.ts': validAnchor,
    })
  })

  test('keeps legitimate maps unchanged through a round-trip', () => {
    const state = getInitialAgentState()
    state.readAuthorizationsByPath = { 'src/read.ts': true }
    state.readAuthorizationHashesByPath = { 'src/read.ts': validContentHash }
    state.confirmedPostEditAnchorsByPath = {
      'src/edited.ts': {
        ...validAnchor,
        projectId: 'project:demo',
        runId: 'run:1',
      },
    }
    const expectedMaps = {
      readAuthorizationsByPath: state.readAuthorizationsByPath,
      readAuthorizationHashesByPath: state.readAuthorizationHashesByPath,
      confirmedPostEditAnchorsByPath: state.confirmedPostEditAnchorsByPath,
    }

    const sanitized = sanitizeAgentStateSecurityMaps(state)

    expect(sanitized).not.toBe(state)
    expect(sanitized.readAuthorizationsByPath).toEqual(
      expectedMaps.readAuthorizationsByPath,
    )
    expect(sanitized.readAuthorizationHashesByPath).toEqual(
      expectedMaps.readAuthorizationHashesByPath,
    )
    expect(sanitized.confirmedPostEditAnchorsByPath).toEqual(
      expectedMaps.confirmedPostEditAnchorsByPath,
    )
  })

  test('does not mutate the input state', () => {
    const state = asRestoredAgentState({
      ...getInitialAgentState(),
      readAuthorizationsByPath: { 'src/forged.ts': 42 },
      readAuthorizationHashesByPath: 'forged-hash-map',
      confirmedPostEditAnchorsByPath: {
        'src/forged.ts': { startLine: 0, endLine: 0, contentHash: 'x' },
      },
    })
    const snapshotBefore = JSON.parse(JSON.stringify(state))

    sanitizeAgentStateSecurityMaps(state)

    expect(state).toEqual(snapshotBefore)
  })
})
