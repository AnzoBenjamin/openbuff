/**
 * Direct coverage for the ext-v1 ACP extension dispatcher (reviewer
 * requirement RF-10) and the journal capabilities-replay validation (RF-13).
 *
 * RF-10: every known `_openbuff.dev/*` method serves from the LIVE
 * `AcpSessionData` store with schema-validated params (missing/invalid
 * params → -32602), fail-closed errors for unknown methods (-32601) and for
 * sessions/store states with nothing to serve, the §6.2 receipt_not_found
 * error (-32002 with the `openbuff.dev` data key), the §6.3 single-main-lane
 * projection, and the §6.4 gate-state projection — and every served RESULT
 * is re-parsed against the published ext-v1 schema so the wire contract
 * (not just the TS type) is verified end to end.
 *
 * RF-13: `restoreFromJournal` validates replayed `capabilities` lines
 * against the published `capabilityMapV1Schema` before accepting them — but
 * the map is then RE-DERIVED from the serving store's real posture, never
 * served from the replayed bytes: a tampered journal line (the journal lives
 * under the project root, which serve mode treats as untrusted) can never
 * advertise an overstated capability map to clients, even a schema-valid one.
 * Receipt-envelope lines are replayed only when already redaction-clean
 * (GV-07), and `_openbuff.dev/receipts/get` re-validates the full
 * `receiptEnvelopeV1Schema` on every serve path including restored sessions.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'bun:test'

import type { RequestError } from '@agentclientprotocol/sdk'

import {
  capabilityMapV1Schema,
  gateStateV1Schema,
  laneV1Schema,
  receiptEnvelopeV1Schema,
} from '@codebuff/common/protocol/acp-ext-v1'
import type { CapabilityMapV1 } from '@codebuff/common/protocol/acp-ext-v1'
import {
  fileMutationResultV1Schema,
  type FileMutationResultV1,
} from '@codebuff/common/tools/results/filesystem'
import {
  getExactContentHash,
  getContentHash,
} from '@codebuff/common/util/content-hash'

import { createAcpAgent } from '../acp-agent'
import {
  compileExtV1JsonSchemas,
  OPENBUFF_EXT_METHODS,
} from '../ext-methods'
import { AcpSessionData } from '../session-data'

/** The honest P1 serve capability map (same shape the bridge stores). */
const VALID_CAPABILITY_MAP: CapabilityMapV1 = {
  kind: 'openbuff.capabilities',
  version: 1,
  generation: 1,
  sandbox: { tier: 'lexical', enforced: false, network: 'unrestricted' },
  index: { state: 'absent' },
  lsp: [],
  sidecars: [],
  lanes: { supported: false },
  journal: { resume: true, replay: true },
  gate: { enabled: true },
}

const HASH_A = `sha256:${'1'.repeat(64)}`
const HASH_B = `sha256:${'2'.repeat(64)}`

/**
 * A confirmed-mutation event in the exact shape the run loop emits; the
 * store builds the redacted wire mutation from it (so the receipt fixture
 * cannot drift from the projection the GV-06 golden vector pins).
 */
function makeMutationEvent(receiptId: string) {
  return {
    toolName: 'write_file',
    callId: 'call_7',
    operationId: 'op_1',
    receiptId,
    workspaceRevision: 1,
    workspaceSnapshotId: 'ws-1',
    actions: [
      {
        action: 'update' as const,
        path: 'src/a.ts',
        beforeHash: HASH_A,
        afterHash: HASH_B,
      },
    ],
  }
}

function makeAgent(sessionData: AcpSessionData) {
  return createAcpAgent({
    promptHandler: async () => ({ stopReason: 'end_turn' }),
    connection: { sessionUpdate: async () => {} },
    sessionData,
    loadHandler: async () => {},
  })
}

/**
 * An agent whose connection OWNS `sessionId`: `extMethod`'s
 * `assertOwnedSession` gate only forwards sessions this connection created
 * (`newSession`) or restored (`loadSession`) to the ext-v1 dispatcher.
 * `loadSession` registers the caller-supplied id and §6.1-seeds a baseline
 * capability map when the store holds none for it yet.
 */
async function ownedAgent(sessionData: AcpSessionData, sessionId: string) {
  const agent = makeAgent(sessionData)
  await agent.loadSession({ cwd: '/tmp/acp-ext', mcpServers: [], sessionId })
  return agent
}

/**
 * A real, fully-applied mutation carrying the content-bearing fields the
 * §6.2 wire projection must drop — the payload a caller hands the store's
 * PUBLIC `recordReceipt` path (the path the wire-schema-drift finding named:
 * the store previously kept the internal shape via spread, so any field
 * outside the strict wire allowlist collapsed the serve to
 * receipt_not_found).
 */
function makeAppliedMutation(receiptId: string): FileMutationResultV1 {
  const operationId = 'op_recorded'
  const afterContent = 'export const answer = 42\n'
  const afterHash = getExactContentHash(afterContent)
  return {
    kind: 'file_mutation_result',
    version: 1,
    operationId,
    outcome: 'applied',
    actions: [
      {
        actionId: 'act-1',
        index: 0,
        action: 'create',
        path: 'src/new.ts',
        outcome: 'applied',
        beforeHash: null,
        afterHash,
        afterContent,
        editAnchor: {
          startLine: 1,
          endLine: afterContent.split('\n').length,
          contentHash: getContentHash(afterContent),
          readCapability: 'cap.v3.1.2.AAAA.BBBB',
        },
      },
    ],
    authorityTier: 'conditional_commit',
    receiptId,
    workspaceRevision: 1,
    workspaceSnapshotId: 'ws-1',
    authorityReceipt: {
      kind: 'commit_receipt',
      version: 1,
      receiptId,
      operationId,
      callId: 'call_7',
      authorityTier: 'conditional_commit',
      status: 'committed',
      actions: [
        {
          actionId: 'act-1',
          index: 0,
          action: 'create',
          path: 'src/new.ts',
          status: 'committed',
          beforeHash: null,
          afterHash,
        },
      ],
      finalHashes: { 'src/new.ts': afterHash },
      workspaceRevision: 1,
      workspaceSnapshotId: 'ws-1',
    },
    errors: [],
    freshCapabilities: [
      {
        kind: 'whole_file',
        version: 1,
        token: 'cap.v3.1.2.AAAA.BBBB',
        snapshot: {
          kind: 'file_snapshot',
          version: 1,
          canonicalPath: 'src/new.ts',
          contentHash: getContentHash(afterContent),
          sizeBytes: new TextEncoder().encode(afterContent).byteLength,
          encoding: 'utf8',
          readGeneration: 0,
        },
      },
    ],
  }
}

/**
 * Settles a call into `{ code, data }` or fails when it resolves. The
 * parameter is `unknown` on purpose: `extMethod` returns
 * `MaybePromise<Record<string, unknown>>`, and `await` accepts both shapes.
 */
async function errorOf(
  promise: unknown,
): Promise<{ code: number; data: unknown }> {
  try {
    await promise
  } catch (failure) {
    const err = failure as RequestError & { data?: unknown }
    return { code: err.code, data: (failure as unknown as { data?: unknown }).data }
  }
  throw new Error('expected the ext-method call to reject')
}

const tmpDirs: string[] = []
function makeJournalDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'acp-ext-methods-'))
  tmpDirs.push(dir)
  return dir
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop()
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true })
  }
})

describe('ext-v1 dispatcher serves the live store (RF-10)', () => {
  test('capabilities/get returns the stored map, which re-parses against the published schema', async () => {
    const sessionData = new AcpSessionData()
    sessionData.setCapabilities('s1', VALID_CAPABILITY_MAP)
    const agent = await ownedAgent(sessionData, 's1')
    const result = await agent.extMethod('_openbuff.dev/capabilities/get', {
      sessionId: 's1',
    })
    expect(capabilityMapV1Schema.parse(result)).toEqual(VALID_CAPABILITY_MAP)
  })

  // §6.1 seeds a baseline capability map for every session this connection
  // registers (newSession/loadSession), so "registered + no stored map" is
  // unreachable and -32601 can never fire here. The reachable fail-closed for
  // a session this connection does not own is `assertOwnedSession`'s -32602.
  test('capabilities/get fails closed with -32602 for a session this connection does not own', async () => {
    const sessionData = new AcpSessionData()
    const failure = await errorOf(
      makeAgent(sessionData).extMethod('_openbuff.dev/capabilities/get', {
        sessionId: 's-none',
      }),
    )
    expect(failure.code).toBe(-32602)
  })

  test('params are schema-validated: missing sessionId and extra keys are both -32602', async () => {
    const sessionData = new AcpSessionData()
    const agent = makeAgent(sessionData)
    const missing = await errorOf(
      agent.extMethod('_openbuff.dev/capabilities/get', {}),
    )
    expect(missing.code).toBe(-32602)
    const extra = await errorOf(
      agent.extMethod('_openbuff.dev/capabilities/get', {
        sessionId: 's1',
        extra: true,
      }),
    )
    expect(extra.code).toBe(-32602)
  })

  test('receipts/get returns a redacted envelope that re-parses against the published schema', async () => {
    const sessionData = new AcpSessionData()
    sessionData.recordReceiptFromMutationEvent(
      's1',
      makeMutationEvent('rcpt_1'),
      'call_7',
    )
    const agent = await ownedAgent(sessionData, 's1')
    const result = await agent.extMethod('_openbuff.dev/receipts/get', {
      sessionId: 's1',
      receiptId: 'rcpt_1',
    })
    const receipt = receiptEnvelopeV1Schema.parse(
      (result as { receipt: unknown }).receipt,
    )
    // The redaction invariant holds on the served wire shape: no fresh
    // capability and no content-bearing action fields ever leave the core.
    expect(receipt.mutation.freshCapabilities).toEqual([])
    for (const action of receipt.mutation.actions) {
      expect(action).not.toHaveProperty('afterContent')
      expect(action).not.toHaveProperty('patch')
      expect(action).not.toHaveProperty('editAnchor')
    }
  })

  test('receipts/get: an unknown receipt id is -32002 with the openbuff.dev data key', async () => {
    const sessionData = new AcpSessionData()
    const agent = await ownedAgent(sessionData, 's1')
    const failure = await errorOf(
      agent.extMethod('_openbuff.dev/receipts/get', {
        sessionId: 's1',
        receiptId: 'nope',
      }),
    )
    expect(failure.code).toBe(-32002)
    const data = failure.data as Record<string, Record<string, unknown>>
    expect(data['openbuff.dev']).toEqual({
      code: 'receipt_not_found',
      receiptId: 'nope',
    })
  })

  test('receipts/get: a tool-less envelope has no wire representation and is not fetchable', async () => {
    const sessionData = new AcpSessionData()
    // No toolCallId: the published receiptEnvelopeV1Schema requires one, so
    // the store must not serve this envelope by id.
    sessionData.recordReceiptFromMutationEvent(
      's1',
      makeMutationEvent('rcpt_toolless'),
    )
    const agent = await ownedAgent(sessionData, 's1')
    const failure = await errorOf(
      agent.extMethod('_openbuff.dev/receipts/get', {
        sessionId: 's1',
        receiptId: 'rcpt_toolless',
      }),
    )
    expect(failure.code).toBe(-32002)
  })

  test('lanes/list serves the single main lane; lanes/create and lanes/land are capability_disabled (GV-10)', async () => {
    const sessionData = new AcpSessionData()
    sessionData.recordReceiptFromMutationEvent(
      's1',
      makeMutationEvent('rcpt_lane'),
    )
    const agent = await ownedAgent(sessionData, 's1')
    const result = (await agent.extMethod('_openbuff.dev/lanes/list', {
      sessionId: 's1',
    })) as { lanes: unknown[] }
    expect(result.lanes).toHaveLength(1)
    const lane = laneV1Schema.parse(result.lanes[0])
    expect(lane.laneId).toBe('main')
    expect(lane.status).toBe('active')
    expect(lane.baseRevision).toBe(1)

    for (const method of [
      '_openbuff.dev/lanes/create',
      '_openbuff.dev/lanes/land',
    ] as const) {
      const failure = await errorOf(agent.extMethod(method, { sessionId: 's1' }))
      expect(failure.code).toBe(-32601)
      const data = failure.data as Record<string, Record<string, unknown>>
      expect(data['openbuff.dev']).toEqual({
        code: 'capability_disabled',
        capability: 'lanes',
      })
    }
  })

  test('gate_state/get returns a state that re-parses against the published schema; idle before any block', async () => {
    const sessionData = new AcpSessionData()
    const agent = await ownedAgent(sessionData, 's1')
    const result = await agent.extMethod('_openbuff.dev/gate_state/get', {
      sessionId: 's1',
    })
    const state = gateStateV1Schema.parse(result)
    expect(state.status).toBe('idle')
  })

  test('an unknown _openbuff.dev/* method fails closed with -32601', async () => {
    const sessionData = new AcpSessionData()
    const failure = await errorOf(
      makeAgent(sessionData).extMethod('_openbuff.dev/future/verb', {
        sessionId: 's1',
      }),
    )
    expect(failure.code).toBe(-32601)
  })

  test('receipts/get serves a receipt recorded via the public recordReceipt path', async () => {
    const sessionData = new AcpSessionData()
    const mutation = makeAppliedMutation('rcpt_recorded')
    expect(fileMutationResultV1Schema.safeParse(mutation).success).toBe(true)
    sessionData.recordReceipt('s1', mutation, 'call_7')

    const agent = await ownedAgent(sessionData, 's1')
    const result = await agent.extMethod('_openbuff.dev/receipts/get', {
      sessionId: 's1',
      receiptId: 'rcpt_recorded',
    })
    // The recorded envelope is built with the §6.2 wire projection, so it
    // conforms to the published ext-v1 schema and IS served — not collapsed
    // to receipt_not_found by a strict re-validation the stored shape cannot
    // pass.
    const receipt = receiptEnvelopeV1Schema.parse(
      (result as { receipt: unknown }).receipt,
    )
    expect(receipt.mutation.receiptId).toBe('rcpt_recorded')
    expect(receipt.mutation.freshCapabilities).toEqual([])
    for (const action of receipt.mutation.actions) {
      expect(action).not.toHaveProperty('afterContent')
      expect(action).not.toHaveProperty('patch')
      expect(action).not.toHaveProperty('editAnchor')
    }
  })

  test('receipts/get serves an envelope whose internal mutation carried a field outside the strict wire allowlist', async () => {
    const sessionData = new AcpSessionData()
    // The internal FileMutationResultV1 contract is non-strict, so a runtime
    // mutation can carry fields the strict wire schema has no slot for; the
    // §6.2 projection rebuilds the mutation field-by-field, so such an
    // envelope is still stored wire-clean and served.
    const driftMutation = {
      ...makeAppliedMutation('rcpt_drift'),
      futureField: 'not-in-the-wire-allowlist',
    } as unknown as FileMutationResultV1
    sessionData.recordReceipt('s1', driftMutation, 'call_7')

    const agent = await ownedAgent(sessionData, 's1')
    const result = await agent.extMethod('_openbuff.dev/receipts/get', {
      sessionId: 's1',
      receiptId: 'rcpt_drift',
    })
    const receipt = receiptEnvelopeV1Schema.parse(
      (result as { receipt: unknown }).receipt,
    )
    expect(
      (receipt.mutation as Record<string, unknown>).futureField,
    ).toBeUndefined()
  })

  test('gate_state/get reports a skipped gate as skipped with its reason, not as failed', async () => {
    const sessionData = new AcpSessionData()
    sessionData.updateGateStateFromBlock(
      's1',
      `<gate-state>${JSON.stringify({
        gate: 'reviewer',
        status: 'skipped',
        details: 'no reviewable diff in the pending set',
      })}</gate-state>`,
    )
    const agent = await ownedAgent(sessionData, 's1')
    const result = await agent.extMethod('_openbuff.dev/gate_state/get', {
      sessionId: 's1',
    })
    const state = gateStateV1Schema.parse(result)
    expect(state.status).toBe('skipped')
    expect(state.skipReason).toBe('no reviewable diff in the pending set')
  })

  test('without the live store, every ext-v1 method fails closed with -32601', async () => {
    const agent = createAcpAgent({
      promptHandler: async () => ({ stopReason: 'end_turn' }),
      connection: { sessionUpdate: async () => {} },
    })
    const failure = await errorOf(
      agent.extMethod('_openbuff.dev/capabilities/get', { sessionId: 's1' }),
    )
    expect(failure.code).toBe(-32601)
  })
})

describe('§6.1 baseline capability map is available before the first prompt', () => {
  test('newSession seeds the baseline so capabilities/get works between session/new and the first prompt', async () => {
    const sessionData = new AcpSessionData()
    const agent = makeAgent(sessionData)
    const { sessionId } = await agent.newSession({
      cwd: '/tmp/openbuff-preprompt',
      mcpServers: [],
    })

    // No prompt has run yet: the map must already be served, never -32601.
    const result = await agent.extMethod('_openbuff.dev/capabilities/get', {
      sessionId,
    })
    const map = capabilityMapV1Schema.parse(result)
    // A purely in-memory store advertises NO journal resume/replay: the
    // flags are derived from the store's real posture, not hardcoded.
    expect(map.journal).toEqual({ resume: false, replay: false })
    expect(map.sandbox).toEqual({
      tier: 'lexical',
      enforced: false,
      network: 'unrestricted',
    })
  })

  test('loadSession seeds the baseline for a restored session whose journal carried no capabilities line', async () => {
    const dir = makeJournalDir()
    writeFileSync(
      join(dir, 's-restored.jsonl'),
      `${JSON.stringify({
        kind: 'gate_state',
        snapshot: {
          gate: 'validation',
          status: 'running',
          details: '',
          phase: 'validating',
        },
      })}\n`,
      'utf8',
    )
    const sessionData = new AcpSessionData({ journalDir: dir })
    const agent = createAcpAgent({
      promptHandler: async () => ({ stopReason: 'end_turn' }),
      connection: { sessionUpdate: async () => {} },
      sessionData,
      loadHandler: async () => {},
    })
    await agent.loadSession({
      cwd: '/tmp/openbuff-restored',
      mcpServers: [],
      sessionId: 's-restored',
    })

    const result = await agent.extMethod('_openbuff.dev/capabilities/get', {
      sessionId: 's-restored',
    })
    const map = capabilityMapV1Schema.parse(result)
    // A journal-backed store honestly advertises resume/replay.
    expect(map.journal).toEqual({ resume: true, replay: true })
  })
})

describe('compileExtV1JsonSchemas emits params AND result per method (RF-3)', () => {
  test('every ext-v1 method artifact carries both params and result', () => {
    const artifacts = compileExtV1JsonSchemas()
    for (const method of OPENBUFF_EXT_METHODS) {
      const artifact = artifacts[method] as Record<string, unknown> | undefined
      expect(artifact).toBeDefined()
      expect(artifact?.params).toBeDefined()
      expect(artifact?.result).toBeDefined()
    }
  })

  test('the receipts/get result artifact names the receipt property', () => {
    const artifacts = compileExtV1JsonSchemas()
    const artifact = artifacts['_openbuff.dev/receipts/get'] as {
      result: unknown
    }
    expect(JSON.stringify(artifact.result)).toContain('"receipt"')
  })
})

describe('journal capabilities replay is schema-validated (RF-13)', () => {
  test('a valid capabilities line restores the stored map', async () => {
    const dir = makeJournalDir()
    writeFileSync(
      join(dir, 's-journal.jsonl'),
      `${JSON.stringify({ kind: 'capabilities', capabilities: VALID_CAPABILITY_MAP })}\n`,
      'utf8',
    )
    const sessionData = new AcpSessionData({ journalDir: dir })
    await expect(sessionData.restoreFromJournal('s-journal')).resolves.toBe(true)
    expect(sessionData.getCapabilities('s-journal')).toEqual(VALID_CAPABILITY_MAP)
  })

  test('a tampered capabilities line (unknown key) is skipped fail-closed', async () => {
    const dir = makeJournalDir()
    const tampered = {
      ...VALID_CAPABILITY_MAP,
      injected: 'overstated',
    } as unknown as CapabilityMapV1
    writeFileSync(
      join(dir, 's-journal.jsonl'),
      [
        JSON.stringify({ kind: 'capabilities', capabilities: VALID_CAPABILITY_MAP }),
        JSON.stringify({ kind: 'capabilities', capabilities: tampered }),
      ].join('\n') + '\n',
      'utf8',
    )
    const sessionData = new AcpSessionData({ journalDir: dir })
    await sessionData.restoreFromJournal('s-journal')
    const stored = sessionData.getCapabilities('s-journal')
    expect(stored).toEqual(VALID_CAPABILITY_MAP)
    expect((stored as unknown as Record<string, unknown>).injected).toBeUndefined()
  })

  test('a journal with only tampered capability lines leaves no stored map', async () => {
    const dir = makeJournalDir()
    const tampered = {
      ...VALID_CAPABILITY_MAP,
      version: 2,
    } as unknown as CapabilityMapV1
    writeFileSync(
      join(dir, 's-journal.jsonl'),
      `${JSON.stringify({ kind: 'capabilities', capabilities: tampered })}\n`,
      'utf8',
    )
    const sessionData = new AcpSessionData({ journalDir: dir })
    await sessionData.restoreFromJournal('s-journal')
    expect(sessionData.getCapabilities('s-journal')).toBeUndefined()
  })

  test('a schema-valid but OVERSTATED replayed map is re-derived, never served verbatim', async () => {
    const dir = makeJournalDir()
    const overstated = {
      ...VALID_CAPABILITY_MAP,
      generation: 99,
      sandbox: {
        tier: 'landlock+seccomp',
        enforced: true,
        network: 'none',
      },
      lanes: { supported: true },
    } as unknown as CapabilityMapV1
    // The tampered line is itself schema-valid: only the honest re-derivation
    // defends the wire against this shape of lie.
    expect(capabilityMapV1Schema.safeParse(overstated).success).toBe(true)
    writeFileSync(
      join(dir, 's-journal.jsonl'),
      `${JSON.stringify({ kind: 'capabilities', capabilities: overstated })}\n`,
      'utf8',
    )
    const sessionData = new AcpSessionData({ journalDir: dir })
    await sessionData.restoreFromJournal('s-journal')

    // Register the queried id AFTER the restore so the replayed (re-derived)
    // map is what the dispatcher serves.
    const agent = await ownedAgent(sessionData, 's-journal')
    const result = await agent.extMethod('_openbuff.dev/capabilities/get', {
      sessionId: 's-journal',
    })
    const served = capabilityMapV1Schema.parse(result)
    // The served map is the honest P1 serve default derived from THIS
    // store's posture — not the overstated replayed bytes.
    expect(served).toEqual({
      ...VALID_CAPABILITY_MAP,
      journal: { resume: true, replay: true },
    })
    expect(served.sandbox.enforced).toBe(false)
    expect(served.lanes.supported).toBe(false)
  })

  test('a receipt_envelope line carrying content-bearing fields is skipped fail-closed (GV-07)', async () => {
    const dir = makeJournalDir()
    const envelope = {
      kind: 'openbuff.receipt_envelope',
      version: 1,
      sessionId: 's-tamper',
      toolCallId: 'call_7',
      laneId: 'main',
      mutation: {
        kind: 'file_mutation_result',
        version: 1,
        operationId: 'op_1',
        outcome: 'applied',
        actions: [
          {
            actionId: 'op_1:0',
            index: 0,
            action: 'update',
            path: 'src/a.ts',
            outcome: 'applied',
            beforeHash: HASH_A,
            afterHash: HASH_B,
            // The leak the GV-07 replay gate must refuse.
            afterContent: 'SECRET FILE CONTENT',
          },
        ],
        authorityTier: 'conditional_commit',
        receiptId: 'rcpt_tampered',
        workspaceRevision: 1,
        workspaceSnapshotId: 'ws-1',
        errors: [],
        freshCapabilities: [],
      },
    }
    writeFileSync(
      join(dir, 's-tamper.jsonl'),
      `${JSON.stringify({ kind: 'receipt_envelope', envelope })}\n`,
      'utf8',
    )
    const sessionData = new AcpSessionData({ journalDir: dir })
    await expect(sessionData.restoreFromJournal('s-tamper')).resolves.toBe(true)
    // The tampered envelope never entered the store...
    expect(sessionData.getReceipts('s-tamper').receipts).toEqual([])
    // ...so it is not addressable by id on the wire either. Register the
    // queried id after the restore so the replayed store state is what the
    // dispatcher sees.
    const agent = await ownedAgent(sessionData, 's-tamper')
    const failure = await errorOf(
      agent.extMethod('_openbuff.dev/receipts/get', {
        sessionId: 's-tamper',
        receiptId: 'rcpt_tampered',
      }),
    )
    expect(failure.code).toBe(-32002)
  })

  test('a receipt_envelope line carrying freshCapabilities is skipped fail-closed (GV-07)', async () => {
    const dir = makeJournalDir()
    const envelope = {
      kind: 'openbuff.receipt_envelope',
      version: 1,
      sessionId: 's-caps',
      toolCallId: 'call_7',
      laneId: 'main',
      mutation: {
        kind: 'file_mutation_result',
        version: 1,
        operationId: 'op_1',
        outcome: 'applied',
        actions: [
          {
            actionId: 'op_1:0',
            index: 0,
            action: 'update',
            path: 'src/a.ts',
            outcome: 'applied',
            beforeHash: HASH_A,
            afterHash: HASH_B,
          },
        ],
        authorityTier: 'conditional_commit',
        receiptId: 'rcpt_caps',
        workspaceRevision: 1,
        workspaceSnapshotId: 'ws-1',
        errors: [],
        // A replayed cap.v3 token must never survive replay.
        freshCapabilities: [
          { kind: 'whole_file', version: 1, token: 'cap.v3.1.2.LEAKED' },
        ],
      },
    }
    writeFileSync(
      join(dir, 's-caps.jsonl'),
      `${JSON.stringify({ kind: 'receipt_envelope', envelope })}\n`,
      'utf8',
    )
    const sessionData = new AcpSessionData({ journalDir: dir })
    await expect(sessionData.restoreFromJournal('s-caps')).resolves.toBe(true)
    expect(sessionData.getReceipts('s-caps').receipts).toEqual([])
  })

  test('a redaction-clean receipt_envelope line replays and serves schema-valid (RF-12)', async () => {
    const dir = makeJournalDir()
    const envelope = {
      kind: 'openbuff.receipt_envelope',
      version: 1,
      sessionId: 's-clean',
      toolCallId: 'call_7',
      laneId: 'main',
      mutation: {
        kind: 'file_mutation_result',
        version: 1,
        operationId: 'op_1',
        outcome: 'applied',
        actions: [
          {
            actionId: 'op_1:0',
            index: 0,
            action: 'update',
            path: 'src/a.ts',
            outcome: 'applied',
            beforeHash: HASH_A,
            afterHash: HASH_B,
          },
        ],
        authorityTier: 'conditional_commit',
        receiptId: 'rcpt_clean',
        workspaceRevision: 1,
        workspaceSnapshotId: 'ws-1',
        errors: [],
        freshCapabilities: [],
      },
    }
    writeFileSync(
      join(dir, 's-clean.jsonl'),
      `${JSON.stringify({ kind: 'receipt_envelope', envelope })}\n`,
      'utf8',
    )
    const sessionData = new AcpSessionData({ journalDir: dir })
    await expect(sessionData.restoreFromJournal('s-clean')).resolves.toBe(true)

    // The journal-restored envelope IS addressable by id, and the served
    // wire shape re-parses against the redaction-enforcing ext-v1 schema.
    // Register the queried id after the restore so the replayed envelope is
    // what the dispatcher serves.
    const agent = await ownedAgent(sessionData, 's-clean')
    const result = await agent.extMethod('_openbuff.dev/receipts/get', {
      sessionId: 's-clean',
      receiptId: 'rcpt_clean',
    })
    const receipt = receiptEnvelopeV1Schema.parse(
      (result as { receipt: unknown }).receipt,
    )
    expect(receipt.mutation.receiptId).toBe('rcpt_clean')
    expect(receipt.mutation.freshCapabilities).toEqual([])
    for (const action of receipt.mutation.actions) {
      expect(action).not.toHaveProperty('afterContent')
      expect(action).not.toHaveProperty('patch')
      expect(action).not.toHaveProperty('editAnchor')
    }
  })
})
