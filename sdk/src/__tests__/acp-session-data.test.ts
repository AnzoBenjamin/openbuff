import { afterEach, describe, expect, test } from 'bun:test'
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { gateStateV1Schema } from '@codebuff/common/protocol/acp-ext-v1'
import {
  fileMutationResultV1Schema,
  type FileMutationResultV1,
} from '@codebuff/common/tools/results/filesystem'
import {
  getContentHash,
  getExactContentHash,
} from '@codebuff/common/util/content-hash'

import { createAcpAgent } from '../services/acp/acp-agent'
import type {
  AcpPromptHandler,
  AcpSessionUpdateSink,
} from '../services/acp/acp-agent'
import { defaultCapabilityMapV1 } from '../services/acp/ext-methods'
import {
  AcpSessionData,
  parseGateStateBlock,
  toWireReceipt,
} from '../services/acp/session-data'
import { RequestError } from '@agentclientprotocol/sdk'

const AFTER_CONTENT = 'export const answer = 42\nexport const unused = true\n'
const CAP_TOKEN =
  'cap.v3.1.2.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA.BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB'

/**
 * Builds a real, schema-valid fully-applied mutation carrying the
 * content-bearing fields the wire projection must drop: `afterContent`,
 * `editAnchor`, and a non-empty `freshCapabilities` (a whole-file capability
 * whose token matches the action's edit anchor, per the common schema's
 * superRefine).
 */
function buildAppliedMutation(overrides?: {
  operationId?: string
  receiptId?: string
}): FileMutationResultV1 {
  const operationId = overrides?.operationId ?? 'op-1'
  const receiptId = overrides?.receiptId ?? 'r-1'
  const afterHash = getExactContentHash(AFTER_CONTENT)
  const lineCount = AFTER_CONTENT.split('\n').length
  const action = {
    actionId: 'act-1',
    index: 0,
    action: 'create' as const,
    path: 'src/new.ts',
    outcome: 'applied' as const,
    beforeHash: null,
    afterHash,
    afterContent: AFTER_CONTENT,
    editAnchor: {
      startLine: 1,
      endLine: lineCount,
      contentHash: getContentHash(AFTER_CONTENT),
      readCapability: CAP_TOKEN,
    },
  }
  return {
    kind: 'file_mutation_result',
    version: 1,
    operationId,
    outcome: 'applied',
    actions: [action],
    authorityTier: 'conditional_commit',
    receiptId,
    workspaceRevision: 3,
    workspaceSnapshotId: 'ws-1',
    authorityReceipt: {
      kind: 'commit_receipt',
      version: 1,
      receiptId,
      operationId,
      callId: 'call-1',
      authorityTier: 'conditional_commit',
      status: 'committed',
      actions: [
        {
          actionId: 'act-1',
          index: 0,
          action: 'create' as const,
          path: 'src/new.ts',
          status: 'committed' as const,
          beforeHash: null,
          afterHash,
        },
      ],
      finalHashes: { 'src/new.ts': afterHash },
      workspaceRevision: 3,
      workspaceSnapshotId: 'ws-1',
    },
    errors: [],
    freshCapabilities: [
      {
        kind: 'whole_file' as const,
        version: 1 as const,
        token: CAP_TOKEN,
        snapshot: {
          kind: 'file_snapshot' as const,
          version: 1 as const,
          canonicalPath: 'src/new.ts',
          contentHash: getContentHash(AFTER_CONTENT),
          sizeBytes: new TextEncoder().encode(AFTER_CONTENT).byteLength,
          encoding: 'utf8' as const,
          readGeneration: 0,
        },
      },
    ],
  }
}

/** Serializes a gate payload exactly the way formatGateStateBlock does. */
function formatGateStateBlock(payload: Record<string, unknown>): string {
  return `<gate-state>${JSON.stringify(payload).replace(/<\//g, '<\\/')}</gate-state>`
}

function makeConnection(): AcpSessionUpdateSink {
  return { sessionUpdate: async () => {} }
}

function makePromptHandler(): AcpPromptHandler {
  return async () => ({ stopReason: 'end_turn' })
}

describe('acp session data store', () => {
  test('toWireReceipt emits the §6.2 envelope with a schema-valid redacted mutation', () => {
    const mutation = buildAppliedMutation()
    // The input itself must be a real FileMutationResultV1, not a hand-wave.
    expect(fileMutationResultV1Schema.safeParse(mutation).success).toBe(true)

    const envelope = toWireReceipt(mutation, 's-1', 'tool-1')

    expect(envelope).toEqual({
      kind: 'openbuff.receipt_envelope',
      version: 1,
      sessionId: 's-1',
      toolCallId: 'tool-1',
      laneId: 'main',
      mutation: expect.any(Object),
    })

    // The redacted mutation still parses against the real result schema.
    const parsed = fileMutationResultV1Schema.safeParse(envelope.mutation)
    expect(parsed.success).toBe(true)

    // Redaction is normative: content-bearing fields are gone at every depth
    // and cap.v3 tokens never leave the core.
    const wireJson = JSON.stringify(envelope)
    expect(wireJson).not.toContain('"afterContent"')
    expect(wireJson).not.toContain('"editAnchor"')
    expect(wireJson).not.toContain('"patch"')
    expect(wireJson).not.toContain(CAP_TOKEN)
    expect(envelope.mutation.freshCapabilities).toEqual([])
    // The wire action type no longer carries content-bearing keys, so assert
    // their ABSENCE by key (a property read would not typecheck).
    expect(envelope.mutation.actions[0]).not.toHaveProperty('afterContent')
    expect(envelope.mutation.actions[0]).not.toHaveProperty('editAnchor')

    // authorityReceipt (ids/hashes/statuses only) is preserved verbatim.
    expect(envelope.mutation.authorityReceipt).toEqual(
      mutation.authorityReceipt,
    )
    expect(envelope.mutation.operationId).toBe('op-1')
    expect(envelope.mutation.receiptId).toBe('r-1')
    expect(envelope.mutation.actions[0]?.afterHash).toBeDefined()
  })

  test('toWireReceipt omits toolCallId when none is given', () => {
    const envelope = toWireReceipt(buildAppliedMutation(), 's-1')
    expect('toolCallId' in envelope).toBe(false)
  })

  test('parseGateStateBlock projects a real-shaped passed block to final_response_allowed', () => {
    const block = formatGateStateBlock({
      gate: 'validation/reviewer',
      status: 'passed',
      details: 'All gates passed.',
      advisories: ['minor nit in foo.ts'],
      workflow: {
        completedCount: 2,
        totalCount: 3,
        nextWorkflowAction: 'wrap up',
      },
      reviewers: ['reliability-reviewer'],
    })

    const snapshot = parseGateStateBlock(`context before\n${block}\nafter`)
    expect(snapshot).not.toBeNull()
    expect(snapshot?.phase).toBe('final_response_allowed')
    expect(snapshot?.gate).toBe('validation/reviewer')
    expect(snapshot?.status).toBe('passed')
    expect(snapshot?.advisories).toEqual(['minor nit in foo.ts'])
    expect(snapshot?.workflow).toEqual({
      completedCount: 2,
      totalCount: 3,
      nextWorkflowAction: 'wrap up',
    })
    expect(snapshot?.reviewers).toEqual(['reliability-reviewer'])
    // Absent additive keys stay absent: legacy blocks replay unchanged.
    expect(snapshot?.skipReason).toBeUndefined()
  })

  test('parseGateStateBlock drops out-of-bounds reviewers/skipReason whole and keeps them at the cap', () => {
    const expectedBase = {
      gate: 'reviewer',
      status: 'skipped',
      details: 'specialist quota exhausted',
    }
    // Malformed reviewer lists are dropped whole: never partially accepted.
    const invalidReviewers: unknown[] = [
      // Not an array.
      'reliability-reviewer',
      // Mixed / non-string entries.
      ['reliability-reviewer', 42],
      // Empty entry.
      ['reliability-reviewer', ''],
      // Over the 4-entry cap.
      Array.from({ length: 5 }, (_, index) => `reviewer-${index}`),
      // Over the 64-char per-entry cap.
      ['a'.repeat(65)],
    ]
    for (const reviewers of invalidReviewers) {
      const snapshot = parseGateStateBlock(
        formatGateStateBlock({ ...expectedBase, reviewers }),
      )
      expect(snapshot?.reviewers).toBeUndefined()
    }
    // Malformed skip reasons are dropped whole.
    const invalidSkipReasons: unknown[] = [
      // Not a string.
      42,
      ['specialist-rate-limited'],
      // Empty.
      '',
      // Over the 120-char cap.
      'a'.repeat(121),
    ]
    for (const skipReason of invalidSkipReasons) {
      const snapshot = parseGateStateBlock(
        formatGateStateBlock({ ...expectedBase, skipReason }),
      )
      expect(snapshot?.skipReason).toBeUndefined()
    }
    // Exactly at the producer cap: 4 reviewers (last 64 chars) + 120 chars.
    const atCap = parseGateStateBlock(
      formatGateStateBlock({
        ...expectedBase,
        reviewers: [
          ...Array.from({ length: 3 }, (_, index) => `reviewer-${index}`),
          'b'.repeat(64),
        ],
        skipReason: 'c'.repeat(120),
      }),
    )
    expect(atCap?.reviewers).toHaveLength(4)
    expect(atCap?.reviewers?.[3]).toBe('b'.repeat(64))
    expect(atCap?.skipReason).toBe('c'.repeat(120))
  })

  test('parseGateStateBlock sanitizes reviewers and skipReason before the bounds checks', () => {
    // Mirrors the CLI parser's sanitize-then-cap contract — the full published
    // block contract, not just its count/length half: control bytes are
    // stripped at capture so they can never ride a stored snapshot onto the
    // ext-v1 wire, and an entry made only of control characters collapses to
    // the empty string and drops the field whole.
    const cleaned = parseGateStateBlock(
      formatGateStateBlock({
        gate: 'reviewer',
        status: 'skipped',
        details: 'legit',
        reviewers: [
          '\u001b[31mreliability\u0007 reviewer\u0000',
          '\n\tcompatibility\n',
        ],
        skipReason: 'specialist\u001b[31m-rate-limited\u0000',
      }),
    )
    expect(cleaned?.reviewers).toEqual([
      '[31mreliability reviewer',
      'compatibility',
    ])
    expect(cleaned?.skipReason).toBe('specialist[31m-rate-limited')

    // A controls-only entry sanitizes to empty, so the whole field is dropped
    // (never partially accepted) — same for a controls-only skip reason.
    const controlsOnly = parseGateStateBlock(
      formatGateStateBlock({
        gate: 'reviewer',
        status: 'skipped',
        details: 'legit',
        reviewers: ['\u001b\u0007\u0000'],
        skipReason: '\u001b\u0007',
      }),
    )
    expect(controlsOnly?.reviewers).toBeUndefined()
    expect(controlsOnly?.skipReason).toBeUndefined()
  })

  test('getGateStateV1 sanitizes and caps the details fallback skipReason at 120 chars', () => {
    // A skipped block with NO machine skipReason token surfaces the
    // producer's `details` line as the contract's optional skipReason. That
    // fallback is arbitrary assistant-authored text, so it must be sanitized
    // (whitespace collapsed, C0/DEL stripped) and capped at the published
    // 120-char machine-token bound — an over-long token has no wire
    // representation, which the tightened gateStateV1Schema also enforces.
    const store = new AcpSessionData()
    const longDetails =
      '  no reviewable diff in the pending set;   the working tree is fully clean ' +
      'x'.repeat(200)
    store.updateGateStateFromBlock(
      's-long-details',
      formatGateStateBlock({
        gate: 'reviewer',
        status: 'skipped',
        details: longDetails,
      }),
    )
    const projected = store.getGateStateV1('s-long-details')
    expect(projected.status).toBe('skipped')
    expect(projected.skipReason).toBeDefined()
    expect(projected.skipReason).toHaveLength(120)
    // Sanitized: no control bytes and no uncollapsed whitespace runs survive.
    expect(projected.skipReason).not.toMatch(/[\u0000-\u001f\u007f]/)
    expect(projected.skipReason).not.toMatch(/\s{2,}/)
    // The sanitized, capped token re-parses against the tightened wire schema.
    expect(gateStateV1Schema.parse(projected)).toEqual(projected)
    // The same tightening rejects an over-long token on the wire.
    expect(
      gateStateV1Schema.safeParse({
        ...projected,
        skipReason: 'y'.repeat(121),
      }).success,
    ).toBe(false)

    // A details line that sanitizes to nothing (control bytes only) omits
    // the key entirely rather than surfacing an empty token.
    const controlsOnly = new AcpSessionData()
    controlsOnly.updateGateStateFromBlock(
      's-controls-details',
      formatGateStateBlock({
        gate: 'reviewer',
        status: 'skipped',
        details: '\u001b\u0007',
      }),
    )
    const controlsProjected = controlsOnly.getGateStateV1('s-controls-details')
    expect(controlsProjected.status).toBe('skipped')
    expect('skipReason' in controlsProjected).toBe(false)
    expect(gateStateV1Schema.parse(controlsProjected)).toEqual(
      controlsProjected,
    )
  })

  test('parseGateStateBlock projects a non-terminal validation status to validating and failures to blocked', () => {
    const validating = parseGateStateBlock(
      formatGateStateBlock({
        gate: 'validation',
        status: 'running',
        details: '',
      }),
    )
    expect(validating?.phase).toBe('validating')

    const reviewing = parseGateStateBlock(
      formatGateStateBlock({
        gate: 'reviewer',
        status: 'running',
        details: '',
      }),
    )
    expect(reviewing?.phase).toBe('reviewing')

    const blocked = parseGateStateBlock(
      formatGateStateBlock({
        gate: 'validation/reviewer',
        status: 'failed',
        details: 'edits-detected-without-pending-gate-files',
        repairRound: 1,
        maxRepairRounds: 2,
      }),
    )
    expect(blocked?.phase).toBe('blocked')
    expect(blocked?.repairRound).toBe(1)
    expect(blocked?.maxRepairRounds).toBe(2)
  })

  test('parseGateStateBlock returns null for malformed payloads (fail closed)', () => {
    expect(parseGateStateBlock('no block here')).toBeNull()
    expect(parseGateStateBlock('<gate-state>not json</gate-state>')).toBeNull()
    expect(parseGateStateBlock('<gate-state>["array"]</gate-state>')).toBeNull()
    expect(
      parseGateStateBlock(
        formatGateStateBlock({ status: 'passed', details: '' }),
      ),
    ).toBeNull()
    expect(
      parseGateStateBlock(
        formatGateStateBlock({
          gate: 'nonsense-gate',
          status: 'passed',
          details: '',
        }),
      ),
    ).toBeNull()
  })

  test('updateGateStateFromBlock keeps the previous snapshot on a malformed block', () => {
    const store = new AcpSessionData()
    store.updateGateStateFromBlock(
      's-1',
      formatGateStateBlock({
        gate: 'validation',
        status: 'failed',
        details: 'boom',
      }),
    )
    expect(store.getGateState('s-1')).toEqual({
      phase: 'blocked',
      currentTask: null,
    })

    // Malformed blocks must not throw and must not clobber the snapshot.
    expect(() =>
      store.updateGateStateFromBlock('s-1', '<gate-state>{oops}</gate-state>'),
    ).not.toThrow()
    expect(store.getGateState('s-1')).toEqual({
      phase: 'blocked',
      currentTask: null,
    })
  })

  test('updateGateStateFromBlock keeps the previous snapshot when the new fields are malformed', () => {
    const store = new AcpSessionData()
    store.updateGateStateFromBlock(
      's-keep',
      formatGateStateBlock({
        gate: 'validation',
        status: 'failed',
        details: 'boom',
      }),
    )
    expect(store.getGateState('s-keep')).toEqual({
      phase: 'blocked',
      currentTask: null,
    })

    // An out-of-bounds reviewers list must not throw and must not clobber
    // the existing snapshot (the whole SNAPSHOT is replaced only when the
    // block parses; the malformed FIELD is dropped, the block still parses).
    expect(() =>
      store.updateGateStateFromBlock(
        's-keep',
        formatGateStateBlock({
          gate: 'validation',
          status: 'failed',
          details: 'still failing',
          reviewers: ['reliability-reviewer', 42],
        }),
      ),
    ).not.toThrow()
    expect(store.getGateState('s-keep')).toEqual({
      phase: 'blocked',
      currentTask: null,
    })
  })

  test('getReceipts is bounded, newest-first, and flattens paths/actionIds with dedupe', () => {
    const store = new AcpSessionData()
    const moveMutation = buildAppliedMutation({
      operationId: 'op-2',
      receiptId: 'r-2',
    })
    // Rewrite the action to a move carrying a destinationPath so flattening
    // must include both the source and destination paths.
    const movedAction = { ...moveMutation.actions[0]! }
    const moveMutationWithMove: FileMutationResultV1 = {
      ...moveMutation,
      actions: [
        {
          ...movedAction,
          action: 'move',
          path: 'src/a.ts',
          destinationPath: 'src/b.ts',
        },
      ],
      authorityReceipt: undefined,
    }
    // Same path twice within one mutation: dedupe must collapse it.
    const duplicated: FileMutationResultV1 = {
      ...buildAppliedMutation({ operationId: 'op-3', receiptId: 'r-3' }),
      // Two actions no longer correlate to the single-action inherited
      // authority receipt, so drop it like the move fixture above does.
      authorityReceipt: undefined,
      actions: [
        moveMutationWithMove.actions[0]!,
        moveMutationWithMove.actions[0]!,
      ].map((action, index) => ({ ...action, index })),
    }
    // An empty actions array must not crash the flattening. A no-action
    // mutation is only schema-valid as 'not_applied' with no fresh
    // capabilities and no authority receipt, so build it that way.
    const emptyMutation: FileMutationResultV1 = {
      ...buildAppliedMutation({ operationId: 'op-4', receiptId: 'r-4' }),
      actions: [],
      outcome: 'not_applied',
      freshCapabilities: [],
      authorityReceipt: undefined,
    }
    expect(fileMutationResultV1Schema.safeParse(emptyMutation).success).toBe(
      true,
    )

    store.recordReceipt('s-1', moveMutationWithMove, 'tool-1')
    store.recordReceipt('s-1', duplicated)
    store.recordReceipt('s-1', emptyMutation)

    const { receipts } = store.getReceipts('s-1')
    expect(receipts).toHaveLength(3)
    // Newest first.
    expect(receipts[0]).toEqual({
      operationId: 'op-4',
      receiptId: 'r-4',
      paths: [],
      actionIds: [],
    })
    expect(receipts[1]).toEqual({
      operationId: 'op-3',
      receiptId: 'r-3',
      paths: ['src/a.ts', 'src/b.ts'],
      actionIds: ['act-1'],
    })
    expect(receipts[2]?.operationId).toBe('op-2')

    // limit is respected.
    expect(store.getReceipts('s-1', 1).receipts).toHaveLength(1)
    expect(store.getReceipts('s-unknown').receipts).toEqual([])
  })

  test('recordReceipt keeps only the newest 256 receipts per session', () => {
    const store = new AcpSessionData()
    for (let i = 0; i < 300; i++) {
      store.recordReceipt(
        's-cap',
        buildAppliedMutation({ operationId: `op-${i}`, receiptId: `r-${i}` }),
      )
    }
    const { receipts } = store.getReceipts('s-cap', 300)
    expect(receipts).toHaveLength(256)
    expect(receipts[0]?.operationId).toBe('op-299')
    expect(receipts.at(-1)?.operationId).toBe('op-44')
  })

  test('getGateState reports idle with a null currentTask before any snapshot', () => {
    const store = new AcpSessionData()
    expect(store.getGateState('s-fresh')).toEqual({
      phase: 'idle',
      currentTask: null,
    })
  })
})

describe('acp agent live session-data extension handlers', () => {
  test('extMethod serves live recorded data when only sessionData is injected', async () => {
    const sessionData = new AcpSessionData()
    const agent = createAcpAgent({
      promptHandler: makePromptHandler(),
      connection: makeConnection(),
      sessionData,
    })

    // The live store answers only for sessions THIS connection created
    // (per-connection session ownership, verified in acp-agent.test.ts):
    // mint the id via session/new first, then record live data for it.
    const { sessionId } = await agent.newSession({
      cwd: '/tmp/openbuff-live',
      mcpServers: [],
    })
    sessionData.recordReceipt(sessionId, buildAppliedMutation(), 'tool-9')
    sessionData.updateGateStateFromBlock(
      sessionId,
      formatGateStateBlock({
        gate: 'validation',
        status: 'failed',
        details: 'hook failed',
      }),
    )

    const receipts = await agent.extMethod('openbuff/getReceipts', {
      sessionId,
    })
    expect(receipts).toEqual({
      receipts: [
        {
          operationId: 'op-1',
          receiptId: 'r-1',
          paths: ['src/new.ts'],
          actionIds: ['act-1'],
        },
      ],
    })

    const gate = await agent.extMethod('openbuff/gateState', { sessionId })
    expect(gate).toEqual({ phase: 'blocked', currentTask: null })

    // A session id this connection never created fails closed with the
    // protocol's invalid-params error instead of answering from the store.
    let unknownFailure: unknown
    try {
      await agent.extMethod('openbuff/gateState', { sessionId: 's-none' })
    } catch (error) {
      unknownFailure = error
    }
    expect(unknownFailure).toBeInstanceOf(RequestError)
    expect((unknownFailure as RequestError).code).toBe(-32602)

    // askUser has no live-data fallback: still method-not-found, even for a
    // session this connection owns and the store has data for.
    let failure: unknown
    try {
      await agent.extMethod('openbuff/askUser', {
        sessionId,
        question: 'Go?',
        choices: ['y'],
      })
    } catch (error) {
      failure = error
    }
    expect(failure).toBeInstanceOf(RequestError)
    expect((failure as RequestError).code).toBe(-32601)
  })

  test('an explicitly injected extensionHandler still wins over sessionData', async () => {
    const sessionData = new AcpSessionData()
    sessionData.recordReceipt('s-both', buildAppliedMutation())
    const dispatched: string[] = []
    const agent = createAcpAgent({
      promptHandler: makePromptHandler(),
      connection: makeConnection(),
      sessionData,
      extensionHandler: async (input) => {
        dispatched.push(input.method)
        if (input.method === 'openbuff/gateState') {
          return { phase: 'gated', currentTask: null }
        }
        return { receipts: [] }
      },
    })

    expect(
      await agent.extMethod('openbuff/gateState', { sessionId: 's-both' }),
    ).toEqual({ phase: 'gated', currentTask: null })
    expect(
      await agent.extMethod('openbuff/getReceipts', { sessionId: 's-both' }),
    ).toEqual({ receipts: [] })
    // The static handler answered both; the store was never read.
    expect(dispatched).toEqual(['openbuff/gateState', 'openbuff/getReceipts'])
  })

  test('invalid extension params still fail closed as invalid-params with sessionData', async () => {
    const agent = createAcpAgent({
      promptHandler: makePromptHandler(),
      connection: makeConnection(),
      sessionData: new AcpSessionData(),
    })

    let failure: unknown
    try {
      await agent.extMethod('openbuff/getReceipts', {})
    } catch (error) {
      failure = error
    }
    expect(failure).toBeInstanceOf(Error)
    expect(String(failure)).toContain('sessionId')
  })
})

describe('acp session data journal', () => {
  const tempDirs: string[] = []

  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop()
      if (dir) rmSync(dir, { recursive: true, force: true })
    }
  })

  function makeJournalDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'acp-journal-'))
    tempDirs.push(dir)
    return dir
  }

  function journalFilePath(dir: string, sessionId: string): string {
    return `${dir}/${sessionId}.jsonl`
  }

  /**
   * Journal writes are fire-and-forget, so tests poll for the expected
   * settled line count instead of awaiting store internals. `mustContain`
   * guards against sampling a transient interleaving mid-queue.
   */
  async function waitForJournalLines(
    filePath: string,
    expectedLines: number,
    mustContain?: string,
  ): Promise<void> {
    for (let attempt = 0; attempt < 500; attempt++) {
      const text = existsSync(filePath) ? readFileSync(filePath, 'utf8') : ''
      const lineCount = text
        .split('\n')
        .filter((line) => line.trim().length > 0).length
      if (
        lineCount >= expectedLines &&
        (mustContain === undefined || text.includes(mustContain))
      ) {
        return
      }
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    throw new Error(`journal ${filePath} never reached ${expectedLines} lines`)
  }

  test('recording receipts and gate state writes a replayable JSONL journal', async () => {
    const dir = makeJournalDir()
    const store = new AcpSessionData({ journalDir: dir })
    store.recordReceipt('s-j', buildAppliedMutation(), 'tool-1')
    store.updateGateStateFromBlock(
      's-j',
      formatGateStateBlock({
        gate: 'validation/reviewer',
        status: 'passed',
        details: 'All gates passed.',
        // Additive fields the journal must round-trip. The parse path is
        // status-agnostic by contract, so a well-formed pair on any snapshot
        // exercises the replay acceptance for both fields.
        reviewers: ['reliability-reviewer'],
        skipReason: 'specialist-rate-limited',
      }),
    )
    const filePath = journalFilePath(dir, 's-j')
    // Journal writes are fire-and-forget (lazy mkdir + appendFile), so file
    // existence is only guaranteed once the polled line count has settled.
    await waitForJournalLines(filePath, 2)
    expect(existsSync(filePath)).toBe(true)

    const restored = new AcpSessionData({ journalDir: dir })
    expect(await restored.restoreFromJournal('s-j')).toBe(true)
    expect(restored.getReceipts('s-j')).toEqual(store.getReceipts('s-j'))
    expect(restored.getGateState('s-j')).toEqual({
      phase: 'final_response_allowed',
      currentTask: null,
    })
    // The additive fields survive journal replay (well-formed values pass
    // the isGateStateSnapshot structural validation) and project onto the
    // published ext-v1 wire shape.
    const restoredV1 = restored.getGateStateV1('s-j')
    expect(restoredV1.reviewers).toEqual(['reliability-reviewer'])
    expect(restoredV1.skipReason).toBe('specialist-rate-limited')
  })

  test('persisted journal bytes stay redacted', async () => {
    const dir = makeJournalDir()
    const store = new AcpSessionData({ journalDir: dir })
    store.recordReceipt('s-redact', buildAppliedMutation(), 'tool-2')
    store.updateGateStateFromBlock(
      's-redact',
      formatGateStateBlock({
        gate: 'validation',
        status: 'running',
        details: 'working',
      }),
    )
    const filePath = journalFilePath(dir, 's-redact')
    await waitForJournalLines(filePath, 2)

    const raw = readFileSync(filePath, 'utf8')
    expect(raw).toContain('"receipt_envelope"')
    expect(raw).toContain('"gate_state"')
    // Redaction is normative on disk too: the content payload and the cap
    // token must never appear in the journal bytes.
    expect(raw).not.toContain(AFTER_CONTENT)
    expect(raw).not.toContain('"afterContent"')
    expect(raw).not.toContain(CAP_TOKEN)
  })

  test('restoreFromJournal skips malformed lines without throwing', async () => {
    const dir = makeJournalDir()
    const store = new AcpSessionData({ journalDir: dir })
    store.recordReceipt('s-corrupt', buildAppliedMutation(), 'tool-3')
    store.updateGateStateFromBlock(
      's-corrupt',
      formatGateStateBlock({
        gate: 'validation',
        status: 'failed',
        details: 'boom',
      }),
    )
    const filePath = journalFilePath(dir, 's-corrupt')
    await waitForJournalLines(filePath, 2)

    const good = readFileSync(filePath, 'utf8')
    writeFileSync(
      filePath,
      `not json at all\n{"kind":"unknown_kind"}\n{truncated json\n${good}`,
      'utf8',
    )

    const restored = new AcpSessionData({ journalDir: dir })
    expect(await restored.restoreFromJournal('s-corrupt')).toBe(true)
    expect(restored.getReceipts('s-corrupt')).toEqual(
      store.getReceipts('s-corrupt'),
    )
    expect(restored.getGateState('s-corrupt')).toEqual({
      phase: 'blocked',
      currentTask: null,
    })
  })

  test('a tampered gate_state snapshot is treated as ABSENT (no gate state) with a warn diagnostic', async () => {
    const dir = makeJournalDir()
    const store = new AcpSessionData({ journalDir: dir })
    store.recordReceipt('s-tamper', buildAppliedMutation(), 'tool-4')
    store.updateGateStateFromBlock(
      's-tamper',
      formatGateStateBlock({
        gate: 'validation/reviewer',
        status: 'failed',
        details: 'legit',
      }),
    )
    const filePath = journalFilePath(dir, 's-tamper')
    await waitForJournalLines(filePath, 2)

    // A tampered journal forges a 'passed' gate state on the wire: the
    // tamperer copies the WIRE vocabulary (status 'passed', phase 'passed')
    // straight into the journal snapshot. Stored snapshots only ever carry
    // the internal phases parseGateStateBlock projects (validating/
    // reviewing/blocked/skipped/final_response_allowed), so an invented
    // phase is structurally invalid and must be treated as ABSENT — never
    // serving the forged phase.
    const warn = console.warn
    // Each captured call is an args array; type it so `warnings[0]?.[0]`
    // typechecks (production warns with a single formatted string).
    const warnings: unknown[][] = []
    console.warn = (...args: unknown[]) => {
      warnings.push(args)
    }
    try {
      writeFileSync(
        filePath,
        `${JSON.stringify({
          kind: 'gate_state',
          snapshot: {
            gate: 'validation/reviewer',
            status: 'passed',
            details: 'forged',
            phase: 'passed',
          },
        })}\n`,
        'utf8',
      )
      const restored = new AcpSessionData({ journalDir: dir })
      expect(await restored.restoreFromJournal('s-tamper')).toBe(true)
      // The forged 'passed' gate never reaches the wire: the tampered
      // snapshot is treated as ABSENT, so gateState reports 'idle'.
      expect(restored.getGateState('s-tamper')).toEqual({
        phase: 'idle',
        currentTask: null,
      })
      // A warn diagnostic identifies the rejected snapshot.
      expect(warnings).toHaveLength(1)
      expect(String(warnings[0]?.[0])).toContain('gate_state')
      expect(String(warnings[0]?.[0])).toContain('s-tamper')
    } finally {
      console.warn = warn
    }

    // Control: a well-formed gate_state snapshot the store itself wrote
    // restores normally (the gate is not blanket-refusing gate_state lines,
    // only shape-invalid ones).
    store.updateGateStateFromBlock(
      's-tamper-2',
      formatGateStateBlock({
        gate: 'validation',
        status: 'running',
        details: 'in progress',
      }),
    )
    await waitForJournalLines(journalFilePath(dir, 's-tamper-2'), 1)
    const control = new AcpSessionData({ journalDir: dir })
    expect(await control.restoreFromJournal('s-tamper-2')).toBe(true)
    expect(control.getGateState('s-tamper-2')).toEqual({
      phase: 'validating',
      currentTask: null,
    })
  })

  test('a gate_state snapshot with malformed reviewers or skipReason is treated as ABSENT (no gate state)', async () => {
    const dir = makeJournalDir()
    const warn = console.warn
    const warnings: unknown[][] = []
    console.warn = (...args: unknown[]) => {
      warnings.push(args)
    }
    try {
      // Each tampered shape is otherwise a perfectly valid snapshot; only
      // the new additive field violates a producer bound, so the WHOLE
      // snapshot must be rejected (mirroring the advisories gate), never
      // partially accepted.
      const tamperedSnapshots: Array<Record<string, unknown>> = [
        // Non-string reviewer entry.
        {
          gate: 'reviewer',
          status: 'skipped',
          details: 'legit',
          phase: 'skipped',
          reviewers: ['reliability-reviewer', 42],
        },
        // Over the 4-entry cap.
        {
          gate: 'reviewer',
          status: 'skipped',
          details: 'legit',
          phase: 'skipped',
          reviewers: Array.from(
            { length: 5 },
            (_, index) => `reviewer-${index}`,
          ),
        },
        // Over the 120-char skipReason cap.
        {
          gate: 'reviewer',
          status: 'skipped',
          details: 'legit',
          phase: 'skipped',
          skipReason: 'a'.repeat(121),
        },
        // Empty skipReason.
        {
          gate: 'reviewer',
          status: 'skipped',
          details: 'legit',
          phase: 'skipped',
          skipReason: '',
        },
        // ANSI/control bytes in a reviewer entry, within the 64-char cap. The
        // store only ever writes already-sanitized bytes (parseGateStateBlock
        // sanitizes at capture), so replay must reject the snapshot as ABSENT
        // instead of restoring bytes that would project onto the ext-v1 wire.
        {
          gate: 'reviewer',
          status: 'skipped',
          details: 'legit',
          phase: 'skipped',
          reviewers: ['\u001b[31mreliability\u0000'],
        },
        // Uncollapsed whitespace in a reviewer entry: the producer's sanitize
        // step would have collapsed it before the bytes were journaled, so the
        // raw form is not a storable shape.
        {
          gate: 'reviewer',
          status: 'skipped',
          details: 'legit',
          phase: 'skipped',
          reviewers: ['reliability\nreviewer'],
        },
        // ANSI/control bytes in the skip reason, within the 120-char cap.
        {
          gate: 'reviewer',
          status: 'skipped',
          details: 'legit',
          phase: 'skipped',
          skipReason: 'specialist\u001b[31m-rate-limited',
        },
      ]
      for (const [index, snapshot] of tamperedSnapshots.entries()) {
        const sessionId = `s-newfields-${index}`
        writeFileSync(
          journalFilePath(dir, sessionId),
          `${JSON.stringify({ kind: 'gate_state', snapshot })}\n`,
          'utf8',
        )
        const restored = new AcpSessionData({ journalDir: dir })
        expect(await restored.restoreFromJournal(sessionId)).toBe(true)
        expect(restored.getGateState(sessionId)).toEqual({
          phase: 'idle',
          currentTask: null,
        })
      }
      // Each rejected snapshot produced exactly one warn diagnostic.
      expect(warnings).toHaveLength(tamperedSnapshots.length)
    } finally {
      console.warn = warn
    }

    // Control: the SAME snapshot shape with well-formed additive values
    // restores normally, proving the rejection was bound-driven, not a
    // blanket refusal of the new keys.
    writeFileSync(
      journalFilePath(dir, 's-newfields-ok'),
      `${JSON.stringify({
        kind: 'gate_state',
        snapshot: {
          gate: 'reviewer',
          status: 'skipped',
          details: 'legit',
          phase: 'skipped',
          reviewers: ['reliability-reviewer'],
          skipReason: 'specialist-rate-limited',
        },
      })}\n`,
      'utf8',
    )
    const ok = new AcpSessionData({ journalDir: dir })
    expect(await ok.restoreFromJournal('s-newfields-ok')).toBe(true)
    expect(ok.getGateState('s-newfields-ok')).toEqual({
      phase: 'skipped',
      currentTask: null,
    })
    const okV1 = ok.getGateStateV1('s-newfields-ok')
    expect(okV1.reviewers).toEqual(['reliability-reviewer'])
    expect(okV1.skipReason).toBe('specialist-rate-limited')
  })

  test('cap overflow rewrites the journal to the newest 256 receipts plus the snapshot', async () => {
    const dir = makeJournalDir()
    const store = new AcpSessionData({ journalDir: dir })
    for (let i = 0; i < 300; i++) {
      store.recordReceipt(
        's-cap',
        buildAppliedMutation({ operationId: `op-${i}`, receiptId: `r-${i}` }),
      )
    }
    store.updateGateStateFromBlock(
      's-cap',
      formatGateStateBlock({
        gate: 'validation/reviewer',
        status: 'passed',
        details: 'done',
      }),
    )
    const filePath = journalFilePath(dir, 's-cap')
    await waitForJournalLines(filePath, 257, '"gate_state"')

    const lines = readFileSync(filePath, 'utf8')
      .split('\n')
      .filter((line) => line.trim().length > 0)
    expect(lines).toHaveLength(257)
    expect(
      lines.filter((line) => line.includes('"receipt_envelope"')),
    ).toHaveLength(256)
    expect(lines.filter((line) => line.includes('"gate_state"'))).toHaveLength(
      1,
    )

    const restored = new AcpSessionData({ journalDir: dir })
    expect(await restored.restoreFromJournal('s-cap')).toBe(true)
    const { receipts } = restored.getReceipts('s-cap', 300)
    expect(receipts).toHaveLength(256)
    expect(receipts[0]?.operationId).toBe('op-299')
    expect(receipts.at(-1)?.operationId).toBe('op-44')
  })

  test('without journalDir restore returns false and nothing is written', async () => {
    const store = new AcpSessionData()
    store.recordReceipt('s-plain', buildAppliedMutation())
    expect(await store.restoreFromJournal('s-plain')).toBe(false)
    expect(store.getReceipts('s-plain').receipts).toHaveLength(1)
  })

  test('traversal session ids never escape the journal directory on writes', async () => {
    const dir = makeJournalDir()
    const store = new AcpSessionData({ journalDir: dir })

    // The ACP client fully controls sessionId via session/load and the id is
    // interpolated into the journal path — a `../` id must never become an
    // append/create write outside the journal directory.
    const evilId = '../evil'
    store.recordReceipt(evilId, buildAppliedMutation(), 'tool-1')
    store.updateGateStateFromBlock(
      evilId,
      formatGateStateBlock({
        gate: 'validation',
        status: 'failed',
        details: 'x',
      }),
    )
    store.setCapabilities(
      evilId,
      defaultCapabilityMapV1({ journalAvailable: true }),
    )

    // Positive control in the SAME store: a safe id journals fine, proving
    // the skipped writes above were gated by the id, not a dead journal.
    // Journal writes are serialized through one queue, so once this line
    // lands every earlier (skipped) write has been processed.
    store.recordReceipt('s-safe', buildAppliedMutation(), 'tool-2')
    await waitForJournalLines(journalFilePath(dir, 's-safe'), 1)

    // The exact path the unguarded interpolation would have written.
    expect(existsSync(journalFilePath(dir, evilId))).toBe(false)
    expect(readdirSync(dir)).toEqual(['s-safe.jsonl'])

    // Fail closed means skipping the durable journal only — the in-memory
    // store still works for the unsafe id.
    expect(store.getReceipts(evilId).receipts).toHaveLength(1)
    expect(store.getGateState(evilId).phase).toBe('blocked')
    expect(store.getCapabilities(evilId)).toBeDefined()
  })

  test('restoreFromJournal refuses traversal session ids without reading outside the journal dir', async () => {
    // Plant a decoy journal at the traversal target: replay must never
    // resolve `../evil` against it.
    const sibling = makeJournalDir()
    writeFileSync(
      `${sibling}/evil.jsonl`,
      `${JSON.stringify({
        kind: 'gate_state',
        snapshot: {
          gate: 'validation',
          status: 'failed',
          details: 'planted',
          phase: 'blocked',
        },
      })}\n`,
      'utf8',
    )
    const store = new AcpSessionData({ journalDir: `${sibling}/inner` })
    expect(await store.restoreFromJournal('../evil')).toBe(false)
    expect(store.getGateState('../evil').phase).toBe('idle')

    // Other unsafe shapes fail closed the same way.
    expect(await store.restoreFromJournal('../../etc/passwd')).toBe(false)
    expect(await store.restoreFromJournal('a/b')).toBe(false)
    expect(await store.restoreFromJournal('a\\b')).toBe(false)
    expect(await store.restoreFromJournal('')).toBe(false)

    // UUID-shaped ids (what session/new actually issues) still journal and
    // replay normally.
    const dir = makeJournalDir()
    const goodId = '3f6b1f5e-2c9a-4f5b-8c0d-1a2b3c4d5e6f'
    const good = new AcpSessionData({ journalDir: dir })
    good.recordReceipt(goodId, buildAppliedMutation(), 'tool-1')
    await waitForJournalLines(journalFilePath(dir, goodId), 1)
    const reloaded = new AcpSessionData({ journalDir: dir })
    expect(await reloaded.restoreFromJournal(goodId)).toBe(true)
  })

  test('restoreFromJournal keeps a receipt recorded while the journal is being read', async () => {
    const dir = makeJournalDir()
    const sessionId = 's-receipt-race'
    const filePath = journalFilePath(dir, sessionId)
    writeFileSync(
      filePath,
      `${JSON.stringify({
        kind: 'receipt_envelope',
        envelope: toWireReceipt(
          buildAppliedMutation({ operationId: 'op-old', receiptId: 'r-old' }),
          sessionId,
          'tool-old',
        ),
      })}\n`,
      'utf8',
    )
    const store = new AcpSessionData({ journalDir: dir })
    // restoreFromJournal runs synchronously up to its `readFile` and then
    // yields, so recording for the same session inside that window is the
    // exact lost-update interleaving the store must survive.
    const restoring = store.restoreFromJournal(sessionId)
    store.recordReceipt(
      sessionId,
      buildAppliedMutation({ operationId: 'op-live', receiptId: 'r-live' }),
      'tool-live',
    )
    expect(await restoring).toBe(true)
    // Settle the queued append (whether or not it raced ahead of the read)
    // so the test leaves no pending journal write behind.
    await waitForJournalLines(filePath, 2, '"op-live"')

    const { receipts } = store.getReceipts(sessionId, 10)
    // The live receipt survives the replay with no duplication, newest
    // first — and stays addressable on the receipts wire.
    expect(receipts.map((receipt) => receipt.operationId)).toEqual([
      'op-live',
      'op-old',
    ])
    expect(store.getReceipt(sessionId, 'r-live')?.mutation.operationId).toBe(
      'op-live',
    )
  })

  test('restoreFromJournal merges replayed receipts into the live bucket instead of replacing it', async () => {
    const dir = makeJournalDir()
    const store = new AcpSessionData({ journalDir: dir })
    store.recordReceipt(
      's-merge',
      buildAppliedMutation({ operationId: 'op-a', receiptId: 'r-a' }),
      'tool-a',
    )
    store.recordReceipt(
      's-merge',
      buildAppliedMutation({ operationId: 'op-b', receiptId: 'r-b' }),
      'tool-b',
    )
    const filePath = journalFilePath(dir, 's-merge')
    await waitForJournalLines(filePath, 2)

    // The read snapshot predates op-b — the window the race exposes — so
    // the file the replay sees holds only op-a, while op-b is live in
    // memory with its append already flushed (and dropped from the file).
    const opALine = readFileSync(filePath, 'utf8')
      .split('\n')
      .find((line) => line.includes('"op-a"'))
    if (opALine === undefined) {
      throw new Error('journal never wrote the op-a receipt line')
    }
    writeFileSync(filePath, `${opALine}\n`, 'utf8')

    expect(await store.restoreFromJournal('s-merge')).toBe(true)
    const { receipts } = store.getReceipts('s-merge', 10)
    // The replay restored op-a AND kept the live op-b: no duplication,
    // newest first.
    expect(receipts.map((receipt) => receipt.operationId)).toEqual([
      'op-b',
      'op-a',
    ])
  })

  test('restoring a session whose live receipts are already journaled never duplicates them', async () => {
    const dir = makeJournalDir()
    const store = new AcpSessionData({ journalDir: dir })
    store.recordReceipt(
      's-reload',
      buildAppliedMutation({ operationId: 'op-1', receiptId: 'r-1' }),
      'tool-1',
    )
    store.recordReceipt(
      's-reload',
      buildAppliedMutation({ operationId: 'op-2', receiptId: 'r-2' }),
      'tool-2',
    )
    await waitForJournalLines(journalFilePath(dir, 's-reload'), 2)

    // session/load for a session this process is already recording replays
    // the very envelopes that are live in memory: the merge must recognize
    // them as already present instead of appending a second copy.
    expect(await store.restoreFromJournal('s-reload')).toBe(true)
    const { receipts } = store.getReceipts('s-reload', 10)
    expect(receipts.map((receipt) => receipt.operationId)).toEqual([
      'op-2',
      'op-1',
    ])
  })

  test('restoreFromJournal keeps a gate-state block published while the journal is being read', async () => {
    const dir = makeJournalDir()
    const sessionId = 's-gate-race'
    const filePath = journalFilePath(dir, sessionId)
    writeFileSync(
      filePath,
      `${JSON.stringify({
        kind: 'gate_state',
        snapshot: {
          gate: 'validation',
          status: 'running',
          details: 'replaying',
          phase: 'validating',
        },
      })}\n`,
      'utf8',
    )
    const store = new AcpSessionData({ journalDir: dir })
    const restoring = store.restoreFromJournal(sessionId)
    // A block published during the read window is newer than anything the
    // journal can replay, so it must survive the restore.
    store.updateGateStateFromBlock(
      sessionId,
      formatGateStateBlock({
        gate: 'validation/reviewer',
        status: 'failed',
        details: 'live failure',
      }),
    )
    expect(await restoring).toBe(true)
    await waitForJournalLines(filePath, 2, '"blocked"')

    expect(store.getGateState(sessionId)).toEqual({
      phase: 'blocked',
      currentTask: null,
    })
  })

  test('restoreFromJournal keeps a capability map set while the journal is being read', async () => {
    const dir = makeJournalDir()
    const sessionId = 's-capabilities-race'
    const filePath = journalFilePath(dir, sessionId)
    writeFileSync(
      filePath,
      `${JSON.stringify({
        kind: 'capabilities',
        capabilities: defaultCapabilityMapV1({ journalAvailable: true }),
      })}\n`,
      'utf8',
    )
    const store = new AcpSessionData({ journalDir: dir })
    const liveMap = defaultCapabilityMapV1({ journalAvailable: true })
    const restoring = store.restoreFromJournal(sessionId)
    store.setCapabilities(sessionId, liveMap)
    expect(await restoring).toBe(true)
    await waitForJournalLines(filePath, 2)

    // The concurrently set map wins: the replay must not replace it, not
    // even with an equal-valued re-derived object.
    expect(store.getCapabilities(sessionId)).toBe(liveMap)
  })

  test('restore merge re-caps at 256, keeping the live receipt and dropping the oldest replayed one', async () => {
    const dir = makeJournalDir()
    const sessionId = 's-cap-race'
    const filePath = journalFilePath(dir, sessionId)
    // 300 replayed envelopes written directly, so the file is the replay's
    // only source of history.
    const replayedLines: string[] = []
    for (let index = 0; index < 300; index++) {
      replayedLines.push(
        JSON.stringify({
          kind: 'receipt_envelope',
          envelope: toWireReceipt(
            buildAppliedMutation({
              operationId: `op-${index}`,
              receiptId: `r-${index}`,
            }),
            sessionId,
            `tool-${index}`,
          ),
        }),
      )
    }
    writeFileSync(filePath, `${replayedLines.join('\n')}\n`, 'utf8')
    const store = new AcpSessionData({ journalDir: dir })
    const restoring = store.restoreFromJournal(sessionId)
    store.recordReceipt(
      sessionId,
      buildAppliedMutation({ operationId: 'op-live', receiptId: 'r-live' }),
      'tool-live',
    )
    expect(await restoring).toBe(true)
    await waitForJournalLines(filePath, 301, '"op-live"')

    // The per-session bound still holds with the LIVE receipt newest: the
    // replay kept its newest 256 and the merge re-capped by dropping the
    // oldest replayed envelope, never the live one. Both flush orders of
    // the in-window append converge on this exact bucket.
    const { receipts } = store.getReceipts(sessionId, 300)
    expect(receipts).toHaveLength(256)
    expect(receipts[0]?.operationId).toBe('op-live')
    expect(receipts[1]?.operationId).toBe('op-299')
    expect(receipts.at(-1)?.operationId).toBe('op-45')
  })

  test('restoreFromJournal never rewinds a live gate snapshot whose journal line has not been written', async () => {
    const dir = makeJournalDir()
    const sessionId = 's-gate-lag'
    const filePath = journalFilePath(dir, sessionId)
    const store = new AcpSessionData({ journalDir: dir })
    store.updateGateStateFromBlock(
      sessionId,
      formatGateStateBlock({
        gate: 'validation/reviewer',
        status: 'failed',
        details: 'live failure',
      }),
    )
    await waitForJournalLines(filePath, 1, '"blocked"')

    // The restore's readFile runs outside the store's write queue, so the
    // journal it observes can legitimately lag memory. Simulate the queued
    // append not having landed: leave only an OLDER durable snapshot in
    // the file while memory already holds the newer live one.
    writeFileSync(
      filePath,
      `${JSON.stringify({
        kind: 'gate_state',
        snapshot: {
          gate: 'validation',
          status: 'running',
          details: 'stale',
          phase: 'validating',
        },
      })}\n`,
      'utf8',
    )

    expect(await store.restoreFromJournal(sessionId)).toBe(true)
    // Memory is never older than the journal, so the live snapshot wins
    // and the replay must not rewind it to the stale durable one.
    expect(store.getGateState(sessionId)).toEqual({
      phase: 'blocked',
      currentTask: null,
    })
  })

  test('restoreFromJournal never rewinds a live capability map whose journal line has not been written', async () => {
    const dir = makeJournalDir()
    const sessionId = 's-capabilities-lag'
    const filePath = journalFilePath(dir, sessionId)
    const store = new AcpSessionData({ journalDir: dir })
    const liveMap = defaultCapabilityMapV1({ journalAvailable: true })
    store.setCapabilities(sessionId, liveMap)
    await waitForJournalLines(filePath, 1)

    // Same lag as the gate-state case: a valid durable capabilities line is
    // all the replay sees, while memory already holds the live map.
    writeFileSync(
      filePath,
      `${JSON.stringify({
        kind: 'capabilities',
        capabilities: defaultCapabilityMapV1({ journalAvailable: true }),
      })}\n`,
      'utf8',
    )

    expect(await store.restoreFromJournal(sessionId)).toBe(true)
    // The live map object survives the replay — it is not replaced by the
    // re-derived one, not even with an equal-valued object.
    expect(store.getCapabilities(sessionId)).toBe(liveMap)
  })
})
