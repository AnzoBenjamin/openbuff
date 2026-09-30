import { readFileSync } from 'node:fs'

import { join } from 'node:path'

import { describe, expect, it } from 'bun:test'

import {
  OPENBUFF_ACP_EXT_VERSION,
  OPENBUFF_ACP_NS,
  capabilityMapV1Schema,
  gateStateV1Schema,
  laneV1Schema,
  projectGateState,
  receiptEnvelopeV1Schema,
  toWireMutation,
  toolKind,
  wireFileMutationResultV1Schema,
  type GateStateV1,
  type WireFileMutationResultV1,
} from '../acp-ext-v1'

/**
 * Golden vectors for the Openbuff ACP extension contract, ext v1 (design
 * §8). For every vector the suite asserts:
 *
 * (a) the ext-owned payload parses with the matching ext schema,
 * (b) the parsed value re-serializes byte-exactly to the on-disk fixture
 *     (JSON.stringify(value, null, 2) plus trailing newline), which pins the
 *     schema key order against the fixture key order, and
 * (c) for GV-06 and GV-09 the emitted payload equals the projection-function
 *     output computed from the corresponding `-source` fixture.
 *
 * GV-07 is the redaction-invariant negative: a leaked cap.v3 authority via
 * `freshCapabilities` or an action `editAnchor` must fail
 * `wireFileMutationResultV1Schema` (the `.strict()` schemas make the leaked
 * keys unrecognized instead of silently dropped).
 *
 * The JSON-RPC envelope fields (`jsonrpc`, `id`, `method`) belong to the ACP
 * SDK contract and are not re-parsed here; fixtures that carry only envelope
 * data (GV-01, GV-03, GV-04, GV-05, GV-08, GV-12, GV-13, GV-14) are pinned
 * byte-stable and spot-checked on their protocol-visible fields.
 */

const SESSION_ID = 'obs_01J8Z3Q4R5S6T7V8W9X0Y1Z2A3'

const FIXTURE_DIR = join(import.meta.dir, '../__fixtures__/acp-ext-v1')

const FIXTURE_NAMES = [
  'GV-01',
  'GV-02',
  'GV-03',
  'GV-04',
  'GV-05',
  'GV-06',
  'GV-06-source',
  'GV-07',
  'GV-08',
  'GV-09',
  'GV-09-source',
  'GV-10',
  'GV-11',
  'GV-12',
  'GV-13',
  'GV-14',
] as const

type Fixture = Record<string, unknown>

const loadFixture = (name: string): Fixture =>
  JSON.parse(readFileSync(join(FIXTURE_DIR, `${name}.json`), 'utf8')) as Fixture

/** The fixture file is canonical: 2-space indent, trailing newline. */
const expectByteStable = (value: unknown, name: string): void => {
  const onDisk = readFileSync(join(FIXTURE_DIR, `${name}.json`), 'utf8')
  expect(JSON.stringify(value, null, 2) + '\n').toBe(onDisk)
}

/**
 * Asserts (a) parse and (b) byte-exact re-serialization: the schema output
 * order must equal the fixture key order at the payload subtree, and parsing
 * must be lossless.
 */
const expectGoldenPayload = <T>(
  schema: { parse: (value: unknown) => T },
  payload: unknown,
): T => {
  const parsed = schema.parse(payload)
  expect(JSON.stringify(parsed, null, 2)).toBe(
    JSON.stringify(payload, null, 2),
  )
  return parsed
}

const asRecord = (value: unknown): Record<string, unknown> =>
  value as Record<string, unknown>

it('exposes the frozen namespace and version constants', () => {
  expect(OPENBUFF_ACP_NS).toBe('openbuff.dev')
  expect(OPENBUFF_ACP_EXT_VERSION).toBe(1)
})

it('every fixture file is canonical JSON with a trailing newline', () => {
  for (const name of FIXTURE_NAMES) {
    expectByteStable(loadFixture(name), name)
  }
})

describe('GV-01/GV-03 negotiation envelopes', () => {
  it('GV-01 carries the client ext negotiation under the openbuff.dev _meta key', () => {
    const gv01 = loadFixture('GV-01')
    expectByteStable(gv01, 'GV-01')
    const params = asRecord(gv01.params)
    const clientCapabilities = asRecord(params.clientCapabilities)
    const meta = asRecord(clientCapabilities._meta)
    expect(meta[OPENBUFF_ACP_NS]).toEqual({
      extVersion: 1,
      extensions: ['capabilities', 'receipts', 'lanes', 'gate', 'events'],
      events: 'acp',
    })
  })

  it('GV-03: no ext _meta is echoed when the client did not negotiate', () => {
    const gv03 = loadFixture('GV-03')
    expectByteStable(gv03, 'GV-03')
    const result = asRecord(gv03.result)
    const agentCapabilities = asRecord(result.agentCapabilities)
    expect(agentCapabilities._meta).toBeUndefined()

    // Otherwise identical to GV-02's result with _meta removed.
    const gv02 = loadFixture('GV-02')
    const gv02Result = structuredClone(asRecord(gv02.result))
    delete asRecord(gv02Result.agentCapabilities)._meta
    expect(result).toEqual(gv02Result)
  })
})

describe('GV-02/GV-11 capability map', () => {
  it('GV-02 parses the initialize-result capability map and round-trips byte-exactly', () => {
    const gv02 = loadFixture('GV-02')
    const ext = asRecord(
      asRecord(asRecord(gv02.result).agentCapabilities)._meta,
    )[OPENBUFF_ACP_NS] as Fixture
    const capabilities = expectGoldenPayload(capabilityMapV1Schema, ext.capabilities)

    // The P1 baseline claims exactly what the design pins: lexical sandbox,
    // lanes and journal off, gate on.
    expect(capabilities).toEqual({
      kind: 'openbuff.capabilities',
      version: 1,
      generation: 1,
      sandbox: { tier: 'lexical', enforced: false, network: 'unrestricted' },
      index: { state: 'ready', files: 4213 },
      lsp: [],
      sidecars: [],
      lanes: { supported: false },
      journal: { resume: false, replay: false },
      gate: { enabled: true },
    })
  })

  it('GV-11 parses the capabilities_changed push after the sandbox upgrade', () => {
    const gv11 = loadFixture('GV-11')
    const capabilities = expectGoldenPayload(
      capabilityMapV1Schema,
      asRecord(asRecord(gv11.notification).params).capabilities,
    )

    expect(capabilities.generation).toBe(2)
    expect(capabilities.sandbox).toEqual({
      tier: 'landlock+seccomp',
      enforced: true,
      network: 'allowlist',
    })
    expect(capabilities.lsp).toEqual([
      { language: 'typescript', server: 'tsserver', state: 'ready' },
    ])
    expect(capabilities.sidecars).toEqual([
      { id: 'openbuff-sandbox', version: '0.1.0', state: 'ready' },
    ])
  })
})

describe('GV-06 receipt envelope and redacted wire mutation', () => {
  const gv06 = loadFixture('GV-06')
  const gv06Source = loadFixture('GV-06-source')

  /** The receipt envelope attached to the GV-06 tool_call_update. */
  const gv06Envelope = (): unknown => {
    const update = asRecord(
      asRecord(asRecord(gv06.toolCallUpdate).params).update,
    )
    return asRecord(asRecord(update._meta)[OPENBUFF_ACP_NS]).receipt
  }

  it('the tool_call pending frame declares kind edit and laneId main', () => {
    const update = asRecord(asRecord(asRecord(gv06.toolCall).params).update)
    expect(update.kind).toBe('edit')
    expect(update.sessionUpdate).toBe('tool_call')
    expect(asRecord(asRecord(update._meta)[OPENBUFF_ACP_NS])).toEqual({
      laneId: 'main',
    })
  })

  it('parses the receipt envelope and round-trips it byte-exactly', () => {
    const envelope = expectGoldenPayload(receiptEnvelopeV1Schema, gv06Envelope())
    expect(envelope.laneId).toBe('main')
    expect(envelope.toolCallId).toBe('call_7')
    expect(envelope.sessionId).toBe(SESSION_ID)
  })

  it('the wire mutation carries no afterContent, patch, editAnchor or cap.v3 token', () => {
    const envelope = receiptEnvelopeV1Schema.parse(gv06Envelope())
    const serialized = JSON.stringify(envelope)
    expect(serialized).not.toContain('afterContent')
    expect(serialized).not.toContain('"patch"')
    expect(serialized).not.toContain('editAnchor')
    expect(serialized).not.toContain('cap.v3.')
    expect(envelope.mutation.freshCapabilities).toEqual([])
  })

  it('(c) toWireMutation(GV-06-source) equals the emitted mutation object', () => {
    const source = asRecord(gv06Source.mutation)
    const wire = toWireMutation(source as Parameters<typeof toWireMutation>[0])

    const emitted = receiptEnvelopeV1Schema.parse(gv06Envelope()).mutation
    expect(wire).toEqual(emitted)

    // And the projection output re-parses and round-trips byte-exactly.
    expectGoldenPayload(wireFileMutationResultV1Schema, wire)
  })

  it('keeps authorityReceipt verbatim through the projection', () => {
    const source = asRecord(gv06Source.mutation)
    const wire = toWireMutation(source as Parameters<typeof toWireMutation>[0])
    expect(wire.authorityReceipt).toEqual(source.authorityReceipt)
  })
})

describe('GV-07 negative: leaked capabilities are rejected', () => {
  const gv06 = loadFixture('GV-06')
  const gv06Source = loadFixture('GV-06-source')
  const gv07 = loadFixture('GV-07')

  const emittedMutation = (): WireFileMutationResultV1 => {
    const update = asRecord(
      asRecord(asRecord(gv06.toolCallUpdate).params).update,
    )
    const envelope = receiptEnvelopeV1Schema.parse(
      asRecord(asRecord(update._meta)[OPENBUFF_ACP_NS]).receipt,
    )
    return envelope.mutation
  }

  it('the GV-07 fixture mutation (freshCapabilities leak) fails to parse', () => {
    expect(
      wireFileMutationResultV1Schema.safeParse(gv07.mutation).success,
    ).toBe(false)
  })

  it('a wire mutation with a leaked action editAnchor fails to parse', () => {
    const sourceAction = asRecord(
      asRecord(gv06Source.mutation).actions,
    )[0] as Fixture
    const leaked = {
      ...emittedMutation(),
      actions: emittedMutation().actions.map((action, index) => ({
        ...action,
        ...(index === 0 ? { editAnchor: sourceAction.editAnchor } : {}),
      })),
    }
    const result = wireFileMutationResultV1Schema.safeParse(leaked)
    expect(result.success).toBe(false)
  })

  it('a wire mutation with non-empty freshCapabilities fails to parse', () => {
    const leaked = {
      ...emittedMutation(),
      freshCapabilities: [
        {
          kind: 'whole_file',
          version: 1,
          token: 'cap.v3.1.1.AAA.BBB.CCC',
          snapshot: {
            kind: 'file_snapshot',
            version: 1,
            canonicalPath: 'proj-x/src/a.ts',
            contentHash:
              'sha256:2222222222222222222222222222222222222222222222222222222222222222',
            sizeBytes: 21,
            encoding: 'utf8',
            readGeneration: 1,
          },
        },
      ],
    }
    expect(wireFileMutationResultV1Schema.safeParse(leaked).success).toBe(false)
  })
})

describe('GV-09 gate state', () => {
  const gv09 = loadFixture('GV-09')
  const gv09Source = loadFixture('GV-09-source')

  const emittedState = (): unknown =>
    asRecord(asRecord(gv09.notification).params).state

  it('parses the notification state and round-trips it byte-exactly', () => {
    const state = expectGoldenPayload(gateStateV1Schema, emittedState())
    expect(state.status).toBe('passed')
    expect(state.passedFiles).toEqual(['src/a.ts'])
    expect(state.pendingFiles).toEqual([])
  })

  it('(c) projectGateState(GV-09-source) equals the emitted state object', () => {
    const projected = projectGateState({
      state: gv09Source.state as Parameters<typeof projectGateState>[0]['state'],
      phase: gv09Source.phase as string,
      sessionId: gv09Source.sessionId as string,
    })

    const emitted = gateStateV1Schema.parse(emittedState())
    expect(projected).toEqual(emitted)
    expectGoldenPayload(gateStateV1Schema, projected)
  })

  it('maps every recorded phase to its status and unknown phases to idle', () => {
    const state = gv09Source.state as Parameters<
      typeof projectGateState
    >[0]['state']
    const phaseToStatus: Array<[string, GateStateV1['status']]> = [
      ['idle', 'idle'],
      ['awaiting_validation', 'pending'],
      ['validating', 'validating'],
      ['reviewing', 'reviewing'],
      ['repair_loop', 'idle'],
      ['blocked', 'idle'],
      ['final_response_allowed', 'passed'],
      ['something_unrecognized', 'idle'],
    ]
    for (const [phase, status] of phaseToStatus) {
      expect(
        projectGateState({ state, phase, sessionId: SESSION_ID }).status,
      ).toBe(status)
    }
  })

  it('a final_response_allowed phase without a verdict maps to skipped', () => {
    const state = {
      ...(gv09Source.state as Record<string, unknown>),
      gatePassedReviewerVerdict: '',
      lastReviewerGateSkipReason: 'reviewer not configured',
    } as Parameters<typeof projectGateState>[0]['state']
    const projected = projectGateState({
      state,
      phase: 'final_response_allowed',
      sessionId: SESSION_ID,
    })
    expect(projected.status).toBe('skipped')
    expect(projected.skipReason).toBe('reviewer not configured')
  })
})

describe('GV-10 lanes in P1', () => {
  it('parses the main lane from the lanes/list result and round-trips it', () => {
    const gv10 = loadFixture('GV-10')
    const lanes = asRecord(asRecord(gv10.lanesListResult).result)
      .lanes as unknown[]
    const lane = expectGoldenPayload(laneV1Schema, lanes[0])
    expect(lane).toEqual({
      kind: 'openbuff.lane',
      version: 1,
      laneId: 'main',
      status: 'active',
      baseRevision: 12,
      agentIds: ['run_root_1'],
    })
  })

  it('the lanes/create error is capability_disabled under the openbuff.dev data key', () => {
    const gv10 = loadFixture('GV-10')
    const error = asRecord(gv10.lanesCreateError).error as Fixture
    expect(error.code).toBe(-32601)
    expect(asRecord(error.data)[OPENBUFF_ACP_NS]).toEqual({
      code: 'capability_disabled',
      capability: 'lanes',
    })
  })
})

describe('envelope-only vectors', () => {
  it('GV-04 session/new result pins the obs_ session id and config option ids', () => {
    const gv04 = loadFixture('GV-04')
    expectByteStable(gv04, 'GV-04')
    const result = asRecord(asRecord(gv04.result).result)
    expect(result.sessionId).toBe(SESSION_ID)
    const configOptions = result.configOptions as Array<Fixture>
    expect(configOptions.map((option) => option.id)).toEqual([
      'mode',
      'model',
      'thought_level',
    ])
    expect(asRecord(result.modes).currentModeId).toBe('default')
  })

  it('GV-05 pins the prompt request and the streamed agent_message_chunk', () => {
    const gv05 = loadFixture('GV-05')
    expectByteStable(gv05, 'GV-05')
    const params = asRecord(gv05.request as Fixture).params as Fixture
    expect(params.sessionId).toBe(SESSION_ID)
    const update = asRecord(asRecord(gv05.update).params).update as Fixture
    expect(update.sessionUpdate).toBe('agent_message_chunk')
    expect(update.messageId).toBe('run_root_1')
  })

  it('GV-08 offers exactly allow_once and reject_once, never allow_always', () => {
    const gv08 = loadFixture('GV-08')
    expectByteStable(gv08, 'GV-08')
    const params = asRecord(asRecord(gv08.request).params)
    const options = params.options as Array<Fixture>
    expect(options.map((option) => option.optionId)).toEqual([
      'allow_once',
      'reject_once',
    ])
    const serialized = JSON.stringify(gv08)
    expect(serialized).not.toContain('allow_always')
    // The allow-once response maps to true; cancelled and reject_once, which
    // map to false, are pinned in the same fixture.
    expect(asRecord(asRecord(gv08.allowOnceResponse).result).outcome).toEqual({
      outcome: 'selected',
      optionId: 'allow_once',
    })
    expect(asRecord(asRecord(gv08.cancelResponse).result).outcome).toEqual({
      outcome: 'cancelled',
    })
    expect(
      asRecord(asRecord(gv08.rejectOnceResponse).result).outcome,
    ).toEqual({ outcome: 'selected', optionId: 'reject_once' })
  })

  it('GV-12 cancel yields stopReason cancelled on the pending prompt', () => {
    const gv12 = loadFixture('GV-12')
    expectByteStable(gv12, 'GV-12')
    expect(
      asRecord(asRecord(gv12.cancel).params).sessionId,
    ).toBe(SESSION_ID)
    expect(asRecord(asRecord(gv12.promptResult).result)).toEqual({
      stopReason: 'cancelled',
    })
  })

  it('GV-13 pins the plan update entries', () => {
    const gv13 = loadFixture('GV-13')
    expectByteStable(gv13, 'GV-13')
    const update = asRecord(asRecord(gv13.notification).params).update as Fixture
    expect(update.sessionUpdate).toBe('plan')
    const entries = update.entries as Array<Fixture>
    expect(entries.map((entry) => entry.status)).toEqual([
      'completed',
      'in_progress',
      'pending',
    ])
    expect(entries.every((entry) => entry.priority === 'medium')).toBe(true)
  })

  it('GV-14 pins the prompt_in_flight error shape', () => {
    const gv14 = loadFixture('GV-14')
    expectByteStable(gv14, 'GV-14')
    const error = asRecord(gv14.error).error as Fixture
    expect(error.code).toBe(-32600)
    expect(asRecord(error.data)[OPENBUFF_ACP_NS]).toEqual({
      code: 'prompt_in_flight',
    })
  })
})

describe('§4.6 tool kind table', () => {
  it('pins the representative tool-name mapping', () => {
    const cases: Array<[string, ReturnType<typeof toolKind>]> = [
      ['read_files', 'read'],
      ['read_outline', 'read'],
      ['read_subtree', 'read'],
      ['read_image', 'read'],
      ['read_logs', 'read'],
      ['list_directory', 'read'],
      ['git_status', 'read'],
      ['inspect_environment', 'read'],
      ['code_search', 'search'],
      ['glob', 'search'],
      ['query_index', 'search'],
      ['find_files', 'search'],
      ['find_files_matching_content', 'search'],
      ['str_replace', 'edit'],
      ['write_file', 'edit'],
      ['edit_transaction', 'edit'],
      ['replace_range', 'edit'],
      ['rewrite_symbol', 'edit'],
      ['create_plan', 'edit'],
      ['update_plan_status', 'edit'],
      ['run_terminal_command', 'execute'],
      ['run_file_change_hooks', 'execute'],
      ['run_targeted_validation', 'execute'],
      ['kill_job', 'execute'],
      ['web_search', 'fetch'],
      ['read_docs', 'fetch'],
      ['browser_logs', 'fetch'],
      ['think_deeply', 'think'],
      ['spawn_agents', 'other'],
      ['some_mcp_tool', 'other'],
      ['totally_unknown', 'other'],
    ]
    for (const [toolName, expected] of cases) {
      expect(toolKind(toolName)).toBe(expected)
    }
  })

  it('refines edit tools by mutation action: delete-only and move-only', () => {
    expect(
      toolKind('edit_transaction', { actions: [{ action: 'delete' }] }),
    ).toBe('delete')
    expect(
      toolKind('edit_transaction', {
        actions: [{ action: 'move' }, { action: 'move' }],
      }),
    ).toBe('move')
    // Mixed or empty action sets fall back to the name-based kind.
    expect(
      toolKind('edit_transaction', {
        actions: [{ action: 'update' }, { action: 'delete' }],
      }),
    ).toBe('edit')
    expect(toolKind('edit_transaction', { actions: [] })).toBe('edit')
    expect(toolKind('str_replace')).toBe('edit')
    expect(
      toolKind('run_terminal_command', { actions: [{ action: 'delete' }] }),
    ).toBe('delete')
  })
})

/**
 * GV-06's redacted wire mutation, rebuilt as an object literal in fixture key
 * order. Pins the emitted fixture against an independently written literal
 * (not just parse-of-itself) and serves as the clean GV-07 baseline.
 */
const GV06_WIRE_MUTATION: WireFileMutationResultV1 = {
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
      beforeHash:
        'sha256:1111111111111111111111111111111111111111111111111111111111111111',
      afterHash:
        'sha256:2222222222222222222222222222222222222222222222222222222222222222',
    },
  ],
  authorityTier: 'conditional_commit',
  receiptId: 'rcpt_1',
  authorityReceipt: {
    kind: 'commit_receipt',
    version: 1,
    receiptId: 'rcpt_1',
    operationId: 'op_1',
    callId: 'call_7',
    authorityTier: 'conditional_commit',
    status: 'committed',
    actions: [
      {
        actionId: 'op_1:0',
        index: 0,
        action: 'update',
        path: 'src/a.ts',
        status: 'committed',
        beforeHash:
          'sha256:1111111111111111111111111111111111111111111111111111111111111111',
        afterHash:
          'sha256:2222222222222222222222222222222222222222222222222222222222222222',
      },
    ],
    finalHashes: {
      'src/a.ts':
        'sha256:2222222222222222222222222222222222222222222222222222222222222222',
    },
  },
  errors: [],
  freshCapabilities: [],
}

it('GV-06 wire mutation equals the independently written literal and parses', () => {
  const gv06 = loadFixture('GV-06')
  const update = asRecord(asRecord(asRecord(gv06.toolCallUpdate).params).update)
  const envelope = receiptEnvelopeV1Schema.parse(
    asRecord(asRecord(update._meta)[OPENBUFF_ACP_NS]).receipt,
  )

  expect(envelope.mutation).toEqual(GV06_WIRE_MUTATION)
  expect(wireFileMutationResultV1Schema.parse(GV06_WIRE_MUTATION)).toEqual(
    GV06_WIRE_MUTATION,
  )
})
