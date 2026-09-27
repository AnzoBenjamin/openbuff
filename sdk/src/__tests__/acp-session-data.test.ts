import { afterEach, describe, expect, test } from 'bun:test'
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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
import {
  AcpSessionData,
  parseGateStateBlock,
  toWireReceipt,
} from '../services/acp/session-data'

const AFTER_CONTENT = 'export const answer = 42\nexport const unused = true\n'
const CAP_TOKEN = 'cap.v3.1.2.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA.BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB'

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
    expect(envelope.mutation.actions[0]?.afterContent).toBeUndefined()
    expect(envelope.mutation.actions[0]?.editAnchor).toBeUndefined()

    // authorityReceipt (ids/hashes/statuses only) is preserved verbatim.
    expect(envelope.mutation.authorityReceipt).toEqual(mutation.authorityReceipt)
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
      workflow: { completedCount: 2, totalCount: 3, nextWorkflowAction: 'wrap up' },
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
  })

  test('parseGateStateBlock projects a non-terminal validation status to validating and failures to blocked', () => {
    const validating = parseGateStateBlock(
      formatGateStateBlock({ gate: 'validation', status: 'running', details: '' }),
    )
    expect(validating?.phase).toBe('validating')

    const reviewing = parseGateStateBlock(
      formatGateStateBlock({ gate: 'reviewer', status: 'running', details: '' }),
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
    expect(
      parseGateStateBlock('<gate-state>["array"]</gate-state>'),
    ).toBeNull()
    expect(
      parseGateStateBlock(
        formatGateStateBlock({ status: 'passed', details: '' }),
      ),
    ).toBeNull()
    expect(
      parseGateStateBlock(
        formatGateStateBlock({ gate: 'nonsense-gate', status: 'passed', details: '' }),
      ),
    ).toBeNull()
  })

  test('updateGateStateFromBlock keeps the previous snapshot on a malformed block', () => {
    const store = new AcpSessionData()
    store.updateGateStateFromBlock(
      's-1',
      formatGateStateBlock({ gate: 'validation', status: 'failed', details: 'boom' }),
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

  test('getReceipts is bounded, newest-first, and flattens paths/actionIds with dedupe', () => {
    const store = new AcpSessionData()
    const moveMutation = buildAppliedMutation({ operationId: 'op-2', receiptId: 'r-2' })
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
    sessionData.recordReceipt('s-live', buildAppliedMutation(), 'tool-9')
    sessionData.updateGateStateFromBlock(
      's-live',
      formatGateStateBlock({ gate: 'validation', status: 'failed', details: 'hook failed' }),
    )

    const agent = createAcpAgent({
      promptHandler: makePromptHandler(),
      connection: makeConnection(),
      sessionData,
    })

    const receipts = await agent.extMethod('openbuff/getReceipts', {
      sessionId: 's-live',
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

    const gate = await agent.extMethod('openbuff/gateState', {
      sessionId: 's-live',
    })
    expect(gate).toEqual({ phase: 'blocked', currentTask: null })

    // Unknown session ids still answer from the empty store, not errors.
    expect(
      await agent.extMethod('openbuff/gateState', { sessionId: 's-none' }),
    ).toEqual({ phase: 'idle', currentTask: null })

    // askUser has no live-data fallback: still method-not-found.
    let failure: unknown
    try {
      await agent.extMethod('openbuff/askUser', {
        sessionId: 's-live',
        question: 'Go?',
        choices: ['y'],
      })
    } catch (error) {
      failure = error
    }
    expect(failure).toBeInstanceOf(Error)
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
    expect(lines.filter((line) => line.includes('"receipt_envelope"'))).toHaveLength(
      256,
    )
    expect(lines.filter((line) => line.includes('"gate_state"'))).toHaveLength(1)

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
})
