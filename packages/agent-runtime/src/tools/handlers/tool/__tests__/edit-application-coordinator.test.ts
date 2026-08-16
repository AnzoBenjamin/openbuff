import { describe, expect, it } from 'bun:test'
import {
  decodeReadCapabilityToken,
  encodeReadCapabilityToken,
  getContentHash,
  getExactContentHash,
  readCapabilityMatchesScope,
} from '@codebuff/common/util/content-hash'

import {
  commitAppliedEditPaths,
  coordinateEditApplication,
  editOutputHasError,
} from '../edit-application-coordinator'
import { getFileProcessingValues } from '../write-file'

const applicationScope = { projectId: '/project', runId: 'run' }

function canonicalAppliedOutput(
  path: string,
  content: string,
  capabilityScope = { ...applicationScope, path },
) {
  const afterHash = getExactContentHash(content)
  const editAnchor = {
    startLine: 1,
    endLine: content.split('\n').length,
    contentHash: getContentHash(content),
    readCapability: encodeReadCapabilityToken({
      startLine: 1,
      endLine: content.split('\n').length,
      hash: getContentHash(content),
      scope: capabilityScope,
    }),
  }
  const receipt = {
    kind: 'commit_receipt' as const,
    version: 1 as const,
    receiptId: 'receipt',
    operationId: 'operation',
    callId: 'call',
    authorityTier: 'portable_path' as const,
    status: 'committed' as const,
    actions: [
      {
        actionId: 'action',
        index: 0,
        action: 'update' as const,
        path,
        status: 'committed' as const,
        beforeHash: 'before',
        afterHash,
        afterContent: content,
        editAnchor,
      },
    ],
    finalHashes: { [path]: afterHash },
  }
  return [
    {
      type: 'json' as const,
      value: {
        kind: 'file_mutation_result' as const,
        version: 1 as const,
        operationId: 'operation',
        outcome: 'applied' as const,
        actions: [
          {
            actionId: 'action',
            index: 0,
            action: 'update' as const,
            path,
            outcome: 'applied' as const,
            beforeHash: 'before',
            afterHash,
            afterContent: content,
            editAnchor,
          },
        ],
        authorityTier: 'portable_path' as const,
        receiptId: 'receipt',
        authorityReceipt: receipt,
        errors: [],
        freshCapabilities: [],
      },
    },
  ]
}

describe('edit application coordinator', () => {
  it('detects explicit errors in later and nested output parts', () => {
    expect(
      editOutputHasError([
        { type: 'json', value: { message: 'prepared' } },
        {
          type: 'json',
          value: { nested: { applied: false, message: 'rejected' } },
        },
      ] as any),
    ).toBe(true)
    expect(
      editOutputHasError([
        { type: 'json', value: { message: 'applied', error: null } },
      ] as any),
    ).toBe(false)
  })

  it('walks deeply nested and cyclic tool output iteratively without overflowing', async () => {
    const nest = (value: unknown, depth: number): unknown => {
      let current = value
      for (let i = 0; i < depth; i++) {
        current = { wrap: current }
      }
      return current
    }

    // 200 object wrappers would blow a recursive walker; the iterative walk
    // must return (and still honor the depth bound: a hit past depth 6 is
    // ignored, same as the previous helpers).
    expect(() =>
      editOutputHasError([
        { type: 'json', value: nest({ applied: false }, 200) },
      ] as any),
    ).not.toThrow()
    expect(
      editOutputHasError([
        { type: 'json', value: nest({ applied: false }, 200) },
      ] as any),
    ).toBe(false)
    expect(
      editOutputHasError([
        { type: 'json', value: nest({ applied: false }, 3) },
      ] as any),
    ).toBe(true)

    const cyclic: { type: string; value: { self?: unknown } } = {
      type: 'json',
      value: {},
    }
    cyclic.value.self = cyclic
    expect(() => editOutputHasError([cyclic] as any)).not.toThrow()
    expect(editOutputHasError([cyclic] as any)).toBe(false)

    const deepUnconfirmedState = getFileProcessingValues({
      promisesByPath: { 'a.ts': [] },
    })
    const deepUnconfirmed = await coordinateEditApplication({
      toolName: 'str_replace',
      fileProcessingState: deepUnconfirmedState,
      ...applicationScope,
      paths: ['a.ts'],
      apply: async () =>
        [
          {
            type: 'json',
            value: nest(
              canonicalAppliedOutput('a.ts', 'new content')[0]!.value,
              200,
            ),
          },
        ] as any,
    })
    expect(deepUnconfirmed.status).toBe('rejected')
    expect(deepUnconfirmedState.failedEditRequiresReadByPath['a.ts']).toBe(true)

    const deepStaleState = getFileProcessingValues({
      promisesByPath: { 'a.ts': [] },
      readAuthorizationsByPath: { 'a.ts': true },
      readAuthorizationHashesByPath: { 'a.ts': getContentHash('current') },
    })
    const deepStale = await coordinateEditApplication({
      toolName: 'str_replace',
      fileProcessingState: deepStaleState,
      ...applicationScope,
      paths: ['a.ts'],
      rejectionRequiresRead: false,
      apply: async () =>
        [
          {
            type: 'json',
            value: {
              errorMessage: 'client rejected',
              deep: nest(
                {
                  path: 'a.ts',
                  errorCode: 'stale_snapshot',
                  errorMessage: 'stale snapshot',
                },
                200,
              ),
            },
          },
        ] as any,
    })
    expect(deepStale.status).toBe('rejected')
    // Structured stale past the walk bound is ignored; this is a generic
    // rejection, so rejectionRequiresRead:false keeps authorization.
    expect(deepStaleState.failedEditRequiresReadByPath['a.ts']).toBeUndefined()
    expect(deepStaleState.readAuthorizationsByPath?.['a.ts']).toBe(true)
  })

  it('invalidates every path and authorization when client application rejects', async () => {
    const state = getFileProcessingValues({
      promisesByPath: { 'a.ts': [], 'b.ts': [] },
      readAuthorizationsByPath: { 'a.ts': true, 'b.ts': true },
      readAuthorizationHashesByPath: {
        'a.ts': getContentHash('old a'),
        'b.ts': getContentHash('old b'),
      },
    })

    const result = await coordinateEditApplication({
      toolName: 'edit_transaction',
      fileProcessingState: state,
      ...applicationScope,
      paths: ['a.ts', 'b.ts'],
      apply: async () =>
        [
          { type: 'json', value: { errorMessage: 'client rejected batch' } },
        ] as any,
    })

    expect(result.status).toBe('rejected')
    expect(state.promisesByPath['a.ts']).toBeUndefined()
    expect(state.promisesByPath['b.ts']).toBeUndefined()
    expect(state.failedEditRequiresReadByPath).toEqual({
      'a.ts': true,
      'b.ts': true,
    })
    expect(state.readAuthorizationsByPath).toEqual({})
    expect(state.readAuthorizationHashesByPath).toEqual({})
  })

  it('commits only after positive client output', async () => {
    const state = getFileProcessingValues({
      failedEditRequiresReadByPath: { 'a.ts': true },
    })
    let committed = false

    const result = await coordinateEditApplication({
      toolName: 'str_replace',
      fileProcessingState: state,
      ...applicationScope,
      paths: ['a.ts'],
      wholeFileContentByPath: new Map([['a.ts', 'new content']]),
      apply: async () => canonicalAppliedOutput('a.ts', 'new content') as any,
      onApplied: () => {
        committed = true
      },
    })

    expect(result.status).toBe('applied')
    expect(committed).toBe(true)
    expect(state.failedEditRequiresReadByPath['a.ts']).toBeUndefined()
    expect(state.readAuthorizationsByPath?.['a.ts']).toBe(true)
    expect(state.readAuthorizationHashesByPath?.['a.ts']).toBe(
      getContentHash('new content'),
    )
    expect(state.confirmedPostEditAnchorsByPath?.['a.ts']).toMatchObject({
      contentHash: getContentHash('new content'),
      readCapability: expect.stringMatching(/^cap\.v3\./),
    })
  })

  it('applied output surfaces postEditCapabilities for granted paths', async () => {
    const state = getFileProcessingValues({ promisesByPath: { 'a.ts': [] } })
    const clientOutput = canonicalAppliedOutput('a.ts', 'new content') as any

    const result = await coordinateEditApplication({
      toolName: 'str_replace',
      fileProcessingState: state,
      ...applicationScope,
      paths: ['a.ts'],
      wholeFileContentByPath: new Map([['a.ts', 'new content']]),
      apply: async () => clientOutput,
    })

    expect(result.status).toBe('applied')
    const output = (result.status === 'applied' ? result.output : []) as any[]
    // The capabilities part is purely additive: the original applied
    // envelope is preserved unchanged as the first part.
    expect(output).toHaveLength(2)
    expect(output[0]).toEqual(clientOutput[0])
    const last = output[output.length - 1]
    expect(last.type).toBe('json')
    expect(last.value.postEditCapabilities).toEqual([
      {
        path: 'a.ts',
        contentHash: getContentHash('new content'),
        readCapability: expect.stringMatching(/^cap\.v3\./),
      },
    ])
  })

  it('applied output omits postEditCapabilities when no anchor is granted', async () => {
    // wholeFileContentByPath is empty, so the confirmed apply cannot mint an
    // anchor (matching the 'grants no anchor or authorization' scenario).
    const state = getFileProcessingValues({
      promisesByPath: { 'a.ts': [] },
      readAuthorizationsByPath: { 'a.ts': true },
      readAuthorizationHashesByPath: { 'a.ts': getContentHash('stale') },
    })

    const result = await coordinateEditApplication({
      toolName: 'edit_transaction',
      fileProcessingState: state,
      ...applicationScope,
      paths: ['a.ts'],
      wholeFileContentByPath: new Map(),
      apply: async () => canonicalAppliedOutput('a.ts', 'forged content') as any,
    })

    expect(result.status).toBe('applied')
    const output = (result.status === 'applied' ? result.output : []) as any[]
    for (const part of output) {
      expect(part.value).not.toHaveProperty('postEditCapabilities')
    }
  })

  it('confirms an applied transaction when a no-op path is excluded from confirmationPaths', async () => {
    const clientOutput = canonicalAppliedOutput('a.ts', 'new content') as any

    // b.ts resolved to a no-op and was excluded from client changes, so the
    // client never emits an `applied` action for it. Scoping confirmation to
    // only the paths that actually changed lets the transaction be confirmed.
    const state = getFileProcessingValues({
      promisesByPath: { 'a.ts': [], 'b.ts': [] },
    })
    let committed = false
    const result = await coordinateEditApplication({
      toolName: 'edit_transaction',
      fileProcessingState: state,
      ...applicationScope,
      paths: ['a.ts', 'b.ts'],
      confirmationPaths: ['a.ts'],
      rejectionRequiresRead: false,
      apply: async () => clientOutput,
      onApplied: () => {
        committed = true
      },
    })

    expect(result.status).toBe('applied')
    expect(committed).toBe(true)

    // Without confirmationPaths the default requires BOTH paths, so the same
    // output is wrongly reported as rejected — this locks in that the scoping
    // is what fixes the false-negative.
    const defaultState = getFileProcessingValues({
      promisesByPath: { 'a.ts': [], 'b.ts': [] },
    })
    const defaultResult = await coordinateEditApplication({
      toolName: 'edit_transaction',
      fileProcessingState: defaultState,
      ...applicationScope,
      paths: ['a.ts', 'b.ts'],
      rejectionRequiresRead: false,
      apply: async () => clientOutput,
    })

    expect(defaultResult.status).toBe('rejected')
  })

  it('confirms confirmationPaths when wholeFileContentByPath includes an excluded no-op snapshot', async () => {
    // b.ts is a no-op excluded from confirmationPaths, but the runtime still
    // snapshots it in wholeFileContentByPath. The afterHash / covering-action
    // loop must skip that extra snapshot so a.ts's applied envelope can
    // confirm the transaction.
    const clientOutput = canonicalAppliedOutput('a.ts', 'new content') as any
    const state = getFileProcessingValues({
      promisesByPath: { 'a.ts': [], 'b.ts': [] },
    })
    let committed = false
    const result = await coordinateEditApplication({
      toolName: 'edit_transaction',
      fileProcessingState: state,
      ...applicationScope,
      paths: ['a.ts', 'b.ts'],
      confirmationPaths: ['a.ts'],
      wholeFileContentByPath: new Map([
        ['a.ts', 'new content'],
        ['b.ts', 'unchanged no-op'],
      ]),
      apply: async () => clientOutput,
      onApplied: () => {
        committed = true
      },
    })

    expect(result.status).toBe('applied')
    expect(committed).toBe(true)
  })

  it('rejects forged applied evidence before invoking onApplied or granting state', async () => {
    const state = getFileProcessingValues({ promisesByPath: { 'a.ts': [] } })
    let committed = false
    const forged = canonicalAppliedOutput('a.ts', 'new content')
    const value = forged[0]!.value
    const result = await coordinateEditApplication({
      toolName: 'str_replace',
      fileProcessingState: state,
      ...applicationScope,
      paths: ['a.ts'],
      wholeFileContentByPath: new Map([['a.ts', 'new content']]),
      apply: async () =>
        [
          {
            ...forged[0]!,
            value: { ...value, authorityReceipt: undefined },
          },
        ] as any,
      onApplied: () => {
        committed = true
      },
    })

    expect(result.status).toBe('rejected')
    expect(committed).toBe(false)
    expect(state.readAuthorizationsByPath?.['a.ts']).toBeUndefined()
    expect(state.confirmedPostEditAnchorsByPath?.['a.ts']).toBeUndefined()
    expect(state.failedEditRequiresReadByPath['a.ts']).toBe(true)
  })

  it('drops syntax-rejected prepared state without revoking fresh authorization', async () => {
    const state = getFileProcessingValues({
      promisesByPath: { 'a.ts': [] },
      readAuthorizationsByPath: { 'a.ts': true },
      readAuthorizationHashesByPath: {
        'a.ts': getContentHash('current'),
      },
    })

    const result = await coordinateEditApplication({
      toolName: 'str_replace',
      fileProcessingState: state,
      ...applicationScope,
      paths: ['a.ts'],
      rejectionRequiresRead: false,
      apply: async () =>
        [{ type: 'json', value: { errorMessage: 'syntax error' } }] as any,
    })

    expect(result.status).toBe('rejected')
    expect(state.promisesByPath['a.ts']).toBeUndefined()
    expect(state.failedEditRequiresReadByPath['a.ts']).toBeUndefined()
    expect(state.readAuthorizationsByPath?.['a.ts']).toBe(true)
  })

  it('treats an empty client response as unconfirmed and revokes prepared state', async () => {
    const state = getFileProcessingValues({
      promisesByPath: { 'a.ts': [] },
      readAuthorizationsByPath: { 'a.ts': true },
      readAuthorizationHashesByPath: {
        'a.ts': getContentHash('current'),
      },
    })

    const result = await coordinateEditApplication({
      toolName: 'str_replace',
      fileProcessingState: state,
      ...applicationScope,
      paths: ['a.ts'],
      apply: async () => [] as any,
    })

    expect(result.status).toBe('rejected')
    expect(result.status === 'rejected' ? result.output : []).toMatchObject([
      { value: { file: 'a.ts', errorMessage: expect.any(String) } },
    ])
    expect(state.failedEditRequiresReadByPath['a.ts']).toBe(true)
    expect(state.readAuthorizationsByPath?.['a.ts']).toBeUndefined()
  })

  it('rejects non-empty output without positive application evidence', async () => {
    const state = getFileProcessingValues({ promisesByPath: { 'a.ts': [] } })
    const result = await coordinateEditApplication({
      toolName: 'str_replace',
      fileProcessingState: state,
      ...applicationScope,
      paths: ['a.ts'],
      apply: async () =>
        [{ type: 'json', value: { metadata: 'unknown' } }] as any,
    })

    expect(result.status).toBe('rejected')
    expect(state.failedEditRequiresReadByPath['a.ts']).toBe(true)
  })

  it('rejects ambiguous client messages and preserves the client diagnostic', async () => {
    const state = getFileProcessingValues({ promisesByPath: { 'a.ts': [] } })
    const clientOutput = [
      {
        type: 'json' as const,
        value: { file: 'a.ts', message: 'Queued for approval' },
      },
    ]
    const result = await coordinateEditApplication({
      toolName: 'str_replace',
      fileProcessingState: state,
      ...applicationScope,
      paths: ['a.ts'],
      apply: async () => clientOutput as any,
    })

    expect(result.status).toBe('rejected')
    const output = (result.status === 'rejected' ? result.output : []) as any[]
    expect(output[0]).toEqual(clientOutput[0])
    expect(output[1]).toMatchObject({
      type: 'json',
      value: {
        file: 'a.ts',
        errorMessage: expect.stringContaining(
          'no positive edit application evidence',
        ),
      },
    })
    expect(state.failedEditRequiresReadByPath['a.ts']).toBe(true)
  })

  it('mints its own anchor from known content when the client anchor is malformed (does not trust the malformed token)', async () => {
    const state = getFileProcessingValues({ promisesByPath: { 'a.ts': [] } })
    const output = canonicalAppliedOutput('a.ts', 'new content') as any
    output[0].value.actions[0].editAnchor.readCapability = 'malformed'

    const result = await coordinateEditApplication({
      toolName: 'str_replace',
      fileProcessingState: state,
      ...applicationScope,
      paths: ['a.ts'],
      wholeFileContentByPath: new Map([['a.ts', 'new content']]),
      apply: async () => output,
    })

    // The malformed client token is never reused, but the runtime-known
    // post-edit content in wholeFileContentByPath still authorizes: the
    // runtime mints its own cap.v3 anchor from the known bytes.
    expect(result.status).toBe('applied')
    expect(state.readAuthorizationsByPath?.['a.ts']).toBe(true)
    expect(state.readAuthorizationHashesByPath?.['a.ts']).toBe(
      getContentHash('new content'),
    )
    const anchor = state.confirmedPostEditAnchorsByPath?.['a.ts']
    expect(anchor).toBeDefined()
    expect(anchor?.contentHash).toBe(getContentHash('new content'))
    expect(anchor?.readCapability).toMatch(/^cap\.v3\./)
    expect(anchor?.readCapability).not.toBe('malformed')
  })

  it('grants sticky auth from known content even when the client anchor is scoped to another path or run', async () => {
    for (const capabilityScope of [
      { ...applicationScope, path: 'other.ts' },
      { ...applicationScope, path: 'a.ts', runId: 'other-run' },
    ]) {
      const state = getFileProcessingValues({ promisesByPath: { 'a.ts': [] } })
      let committed = false

      const result = await coordinateEditApplication({
        toolName: 'str_replace',
        fileProcessingState: state,
        ...applicationScope,
        paths: ['a.ts'],
        wholeFileContentByPath: new Map([['a.ts', 'new content']]),
        apply: async () =>
          canonicalAppliedOutput(
            'a.ts',
            'new content',
            capabilityScope,
          ) as any,
        onApplied: () => {
          committed = true
        },
      })

      // The foreign-scoped client anchor is not trusted, but the runtime
      // still grants sticky auth from the known post-edit content.
      expect(result.status).toBe('applied')
      expect(committed).toBe(true)
      expect(state.readAuthorizationsByPath?.['a.ts']).toBe(true)
      expect(state.readAuthorizationHashesByPath?.['a.ts']).toBe(
        getContentHash('new content'),
      )
      const anchor = state.confirmedPostEditAnchorsByPath?.['a.ts']
      expect(anchor).toBeDefined()
      expect(anchor?.contentHash).toBe(getContentHash('new content'))
      expect(anchor?.readCapability).toMatch(/^cap\.v3\./)
      // The synthesized token is bound to the REAL scope (applicationScope
      // + path 'a.ts'), not to the foreign path/run of the untrusted client
      // anchor.
      const decoded = decodeReadCapabilityToken(anchor!.readCapability)
      expect(typeof decoded).not.toBe('string')
      if (typeof decoded !== 'string') {
        expect(
          readCapabilityMatchesScope(decoded, {
            ...applicationScope,
            path: 'a.ts',
          }),
        ).toBe(true)
      }
    }
  })

  it('rejects an applied envelope whose authorityReceipt status is not committed', async () => {
    const state = getFileProcessingValues({ promisesByPath: { 'a.ts': [] } })
    let committed = false
    const output = canonicalAppliedOutput('a.ts', 'new content') as any
    output[0].value.authorityReceipt.status = 'not_started'
    output[0].value.authorityReceipt.actions[0].status = 'not_started'

    const result = await coordinateEditApplication({
      toolName: 'str_replace',
      fileProcessingState: state,
      ...applicationScope,
      paths: ['a.ts'],
      wholeFileContentByPath: new Map([['a.ts', 'new content']]),
      apply: async () => output,
      onApplied: () => {
        committed = true
      },
    })

    // A non-committed receipt contributes no confirmation even though the
    // envelope outcome is 'applied'.
    expect(result.status).toBe('rejected')
    expect(committed).toBe(false)
    expect(state.readAuthorizationsByPath?.['a.ts']).toBeUndefined()
    expect(state.failedEditRequiresReadByPath['a.ts']).toBe(true)
  })

  it('confirms a batched output when two envelopes together cover all confirmation paths', async () => {
    const state = getFileProcessingValues({
      promisesByPath: { 'a.ts': [], 'b.ts': [] },
    })
    let committed = false
    const envelopeA = canonicalAppliedOutput('a.ts', 'content a') as any
    const envelopeB = canonicalAppliedOutput('b.ts', 'content b') as any

    const result = await coordinateEditApplication({
      toolName: 'edit_transaction',
      fileProcessingState: state,
      ...applicationScope,
      paths: ['a.ts', 'b.ts'],
      wholeFileContentByPath: new Map([
        ['a.ts', 'content a'],
        ['b.ts', 'content b'],
      ]),
      apply: async () => [...envelopeA, ...envelopeB] as any,
      onApplied: () => {
        committed = true
      },
    })

    // Under first-envelope-wins behavior envelope A alone cannot cover b.ts,
    // so this would be rejected; union coverage across envelopes confirms.
    expect(result.status).toBe('applied')
    expect(committed).toBe(true)
    expect(state.readAuthorizationsByPath?.['a.ts']).toBe(true)
    expect(state.readAuthorizationsByPath?.['b.ts']).toBe(true)
    expect(state.readAuthorizationHashesByPath?.['a.ts']).toBe(
      getContentHash('content a'),
    )
    expect(state.readAuthorizationHashesByPath?.['b.ts']).toBe(
      getContentHash('content b'),
    )
  })

  it('rejects when the union of collected envelopes does not cover every confirmation path', async () => {
    const state = getFileProcessingValues({
      promisesByPath: { 'a.ts': [], 'b.ts': [], 'c.ts': [] },
    })
    let committed = false
    const envelopeA = canonicalAppliedOutput('a.ts', 'content a') as any
    const envelopeB = canonicalAppliedOutput('b.ts', 'content b') as any

    const result = await coordinateEditApplication({
      toolName: 'edit_transaction',
      fileProcessingState: state,
      ...applicationScope,
      paths: ['a.ts', 'b.ts', 'c.ts'],
      wholeFileContentByPath: new Map([
        ['a.ts', 'content a'],
        ['b.ts', 'content b'],
      ]),
      apply: async () => [...envelopeA, ...envelopeB] as any,
      onApplied: () => {
        committed = true
      },
    })

    // Both envelopes are collected, but their union covers only a.ts and
    // b.ts; c.ts has no positive evidence anywhere, so confirmation fails
    // closed and nothing is committed or authorized.
    expect(result.status).toBe('rejected')
    expect(committed).toBe(false)
    expect(state.readAuthorizationsByPath?.['a.ts']).toBeUndefined()
    expect(state.readAuthorizationsByPath?.['b.ts']).toBeUndefined()
    expect(state.failedEditRequiresReadByPath).toEqual({
      'a.ts': true,
      'b.ts': true,
      'c.ts': true,
    })
  })

  it('ignores an applied envelope with a non-committed authorityReceipt when collecting union coverage', async () => {
    const state = getFileProcessingValues({
      promisesByPath: { 'a.ts': [], 'b.ts': [] },
    })
    let committed = false
    const envelopeA = canonicalAppliedOutput('a.ts', 'content a') as any
    const envelopeB = canonicalAppliedOutput('b.ts', 'content b') as any
    envelopeB[0].value.authorityReceipt.status = 'not_started'
    envelopeB[0].value.authorityReceipt.actions[0].status = 'not_started'

    const result = await coordinateEditApplication({
      toolName: 'edit_transaction',
      fileProcessingState: state,
      ...applicationScope,
      paths: ['a.ts', 'b.ts'],
      wholeFileContentByPath: new Map([
        ['a.ts', 'content a'],
        ['b.ts', 'content b'],
      ]),
      apply: async () => [...envelopeA, ...envelopeB] as any,
      onApplied: () => {
        committed = true
      },
    })

    // envelopeB's receipt is not committed, so it contributes no evidence;
    // the union then covers only a.ts and the batch must be rejected even
    // though envelopeA alone is genuine.
    expect(result.status).toBe('rejected')
    expect(committed).toBe(false)
    expect(state.readAuthorizationsByPath?.['a.ts']).toBeUndefined()
    expect(state.failedEditRequiresReadByPath).toEqual({
      'a.ts': true,
      'b.ts': true,
    })
  })

  it('collects envelopes nested inside wrapper objects when computing union coverage', async () => {
    const state = getFileProcessingValues({
      promisesByPath: { 'a.ts': [], 'b.ts': [] },
    })
    const envelopeA = canonicalAppliedOutput('a.ts', 'content a') as any
    const envelopeB = canonicalAppliedOutput('b.ts', 'content b') as any

    const result = await coordinateEditApplication({
      toolName: 'edit_transaction',
      fileProcessingState: state,
      ...applicationScope,
      paths: ['a.ts', 'b.ts'],
      wholeFileContentByPath: new Map([
        ['a.ts', 'content a'],
        ['b.ts', 'content b'],
      ]),
      apply: async () =>
        [
          {
            type: 'json',
            value: {
              batch: {
                results: [envelopeA[0].value, envelopeB[0].value],
              },
            },
          },
        ] as any,
    })

    // Collection is not limited to top-level output parts: both nested
    // envelopes are found and their union covers every confirmation path.
    expect(result.status).toBe('applied')
    expect(state.readAuthorizationsByPath?.['a.ts']).toBe(true)
    expect(state.readAuthorizationsByPath?.['b.ts']).toBe(true)
  })

  it('treats the exact legacy SDK success envelope as unconfirmed', async () => {
    const state = getFileProcessingValues({ promisesByPath: { 'a.ts': [] } })
    const result = await coordinateEditApplication({
      toolName: 'str_replace',
      fileProcessingState: state,
      ...applicationScope,
      paths: ['a.ts'],
      apply: async () =>
        [
          {
            type: 'json',
            value: {
              file: 'a.ts',
              message: 'String replace applied successfully.',
            },
          },
        ] as any,
    })

    expect(result.status).toBe('rejected')
  })

  it('does not treat errorMessage: null or an empty string as an explicit error', () => {
    expect(
      editOutputHasError([
        { type: 'json', value: { message: 'applied', errorMessage: null } },
      ] as any),
    ).toBe(false)
    expect(
      editOutputHasError([
        { type: 'json', value: { message: 'applied', errorMessage: '' } },
      ] as any),
    ).toBe(false)
    expect(
      editOutputHasError([
        { type: 'json', value: { message: 'applied', error: null } },
      ] as any),
    ).toBe(false)
    expect(
      editOutputHasError([
        { type: 'json', value: { message: 'rejected', errorMessage: 'boom' } },
      ] as any),
    ).toBe(true)
  })

  it('authorizes a delete edit through handleEditTransaction when a confirmed post-edit anchor hash matches the snapshotted content', async () => {
    // handleEditTransaction authorizes delete/move edits by hash-matching a
    // fresh confirmed post-edit anchor (confirmedPostEditAnchorsByPath)
    // against the runtime-snapshotted content. The runtime-known content is
    // threaded as wholeFileContentByPath; a hash match authorizes.
    const state = getFileProcessingValues({ promisesByPath: { 'a.ts': [] } })
    const result = await coordinateEditApplication({
      toolName: 'edit_transaction',
      fileProcessingState: state,
      ...applicationScope,
      paths: ['a.ts'],
      wholeFileContentByPath: new Map([['a.ts', 'deleted snapshot']]),
      apply: async () => canonicalAppliedOutput('a.ts', 'deleted snapshot') as any,
    })

    expect(result.status).toBe('applied')
    const anchor = state.confirmedPostEditAnchorsByPath?.['a.ts']
    expect(anchor).toBeDefined()
    expect(anchor?.contentHash).toBe(getContentHash('deleted snapshot'))
  })

  it('grants no anchor or authorization when the runtime has no known post-edit content to mint from', async () => {
    // wholeFileContentByPath omits 'a.ts': the runtime has no known-good
    // content, so even though the genuine committed receipt still confirms the
    // apply, no anchor or sticky authorization can be minted. The prior stale
    // authorization remains untouched (it is only revoked by an explicit
    // rejection or a fresh read), but nothing new is granted — fail-closed on
    // the grant side.
    const state = getFileProcessingValues({
      promisesByPath: { 'a.ts': [] },
      readAuthorizationsByPath: { 'a.ts': true },
      readAuthorizationHashesByPath: { 'a.ts': getContentHash('stale') },
    })
    let committed = false
    const result = await coordinateEditApplication({
      toolName: 'edit_transaction',
      fileProcessingState: state,
      ...applicationScope,
      paths: ['a.ts'],
      wholeFileContentByPath: new Map(),
      apply: async () => canonicalAppliedOutput('a.ts', 'forged content') as any,
      onApplied: () => {
        committed = true
      },
    })

    expect(result.status).toBe('applied')
    expect(committed).toBe(true)
    // No anchor is minted without runtime-known content.
    expect(state.confirmedPostEditAnchorsByPath?.['a.ts']).toBeUndefined()
    // The stale hash is NOT overwritten with the unverified client content.
    expect(state.readAuthorizationHashesByPath?.['a.ts']).toBe(
      getContentHash('stale'),
    )
  })

  it('honors rejectionRequiresRead:false on deterministic client rejection through handleEditTransaction so read authorization is preserved', async () => {
    const state = getFileProcessingValues({
      promisesByPath: { 'a.ts': [] },
      readAuthorizationsByPath: { 'a.ts': true },
      readAuthorizationHashesByPath: { 'a.ts': getContentHash('current') },
    })

    const result = await coordinateEditApplication({
      toolName: 'edit_transaction',
      fileProcessingState: state,
      ...applicationScope,
      paths: ['a.ts'],
      rejectionRequiresRead: false,
      apply: async () =>
        [{ type: 'json', value: { errorMessage: 'syntax error' } }] as any,
    })

    expect(result.status).toBe('rejected')
    expect(state.promisesByPath['a.ts']).toBeUndefined()
    expect(state.failedEditRequiresReadByPath['a.ts']).toBeUndefined()
    expect(state.readAuthorizationsByPath?.['a.ts']).toBe(true)
    expect(state.readAuthorizationHashesByPath?.['a.ts']).toBe(
      getContentHash('current'),
    )
  })

  it('does not classify unstructured expected-hash text as stale_snapshot when rejectionRequiresRead is false', async () => {
    const state = getFileProcessingValues({
      promisesByPath: { 'a.ts': [] },
      readAuthorizationsByPath: { 'a.ts': true },
      readAuthorizationHashesByPath: { 'a.ts': getContentHash('current') },
    })

    const result = await coordinateEditApplication({
      toolName: 'str_replace',
      fileProcessingState: state,
      ...applicationScope,
      paths: ['a.ts'],
      rejectionRequiresRead: false,
      apply: async () =>
        [
          {
            type: 'json',
            value: {
              errorMessage:
                'client rejected: expected hash / content changed',
            },
          },
        ] as any,
    })

    expect(result.status).toBe('rejected')
    expect(state.promisesByPath['a.ts']).toBeUndefined()
    expect(state.failedEditRequiresReadByPath['a.ts']).toBeUndefined()
    expect(state.editRereadRequirementsByPath?.['a.ts']).toBeUndefined()
    expect(state.readAuthorizationsByPath?.['a.ts']).toBe(true)
    expect(state.readAuthorizationHashesByPath?.['a.ts']).toBe(
      getContentHash('current'),
    )
  })

  it('revokes only the structured stale path in a two-path batch while clearing every promisesByPath entry', async () => {
    const state = getFileProcessingValues({
      promisesByPath: { 'a.ts': [], 'b.ts': [] },
      readAuthorizationsByPath: { 'a.ts': true, 'b.ts': true },
      readAuthorizationHashesByPath: {
        'a.ts': getContentHash('old a'),
        'b.ts': getContentHash('old b'),
      },
    })

    const result = await coordinateEditApplication({
      toolName: 'edit_transaction',
      fileProcessingState: state,
      ...applicationScope,
      paths: ['a.ts', 'b.ts'],
      rejectionRequiresRead: false,
      apply: async () =>
        [
          {
            type: 'json',
            value: {
              errorMessage: 'client rejected batch',
              failures: [
                {
                  path: 'a.ts',
                  errorCode: 'stale_snapshot',
                  errorMessage: 'stale snapshot',
                },
              ],
            },
          },
        ] as any,
    })

    expect(result.status).toBe('rejected')
    expect(state.promisesByPath['a.ts']).toBeUndefined()
    expect(state.promisesByPath['b.ts']).toBeUndefined()
    expect(state.failedEditRequiresReadByPath['a.ts']).toBe(true)
    expect(state.failedEditRequiresReadByPath['b.ts']).toBeUndefined()
    expect(state.editRereadRequirementsByPath?.['a.ts']).toMatchObject({
      reason: 'stale_snapshot',
    })
    expect(state.editRereadRequirementsByPath?.['b.ts']).toBeUndefined()
    expect(state.readAuthorizationsByPath?.['a.ts']).toBeUndefined()
    expect(state.readAuthorizationsByPath?.['b.ts']).toBe(true)
    expect(state.readAuthorizationHashesByPath?.['b.ts']).toBe(
      getContentHash('old b'),
    )
  })

  it('still classifies structured stale hits inside failures[] after the iterative walk', async () => {
    const state = getFileProcessingValues({
      promisesByPath: { 'a.ts': [] },
      readAuthorizationsByPath: { 'a.ts': true },
      readAuthorizationHashesByPath: { 'a.ts': getContentHash('old a') },
    })

    const result = await coordinateEditApplication({
      toolName: 'str_replace',
      fileProcessingState: state,
      ...applicationScope,
      paths: ['a.ts'],
      rejectionRequiresRead: false,
      apply: async () =>
        [
          {
            type: 'json',
            value: {
              errorMessage: 'client rejected',
              failures: [
                {
                  path: 'a.ts',
                  errorCode: 'stale_snapshot',
                  errorMessage: 'stale snapshot',
                },
              ],
            },
          },
        ] as any,
    })

    expect(result.status).toBe('rejected')
    expect(state.failedEditRequiresReadByPath['a.ts']).toBe(true)
    expect(state.editRereadRequirementsByPath?.['a.ts']).toMatchObject({
      reason: 'stale_snapshot',
    })
    expect(state.readAuthorizationsByPath?.['a.ts']).toBeUndefined()
  })

  it('revokes every coordinated path when a nameless structured stale_snapshot has no path or file', async () => {
    const state = getFileProcessingValues({
      promisesByPath: { 'a.ts': [], 'b.ts': [] },
      readAuthorizationsByPath: { 'a.ts': true, 'b.ts': true },
      readAuthorizationHashesByPath: {
        'a.ts': getContentHash('old a'),
        'b.ts': getContentHash('old b'),
      },
    })

    const result = await coordinateEditApplication({
      toolName: 'edit_transaction',
      fileProcessingState: state,
      ...applicationScope,
      paths: ['a.ts', 'b.ts'],
      rejectionRequiresRead: false,
      apply: async () =>
        [
          {
            type: 'json',
            value: {
              errorCode: 'stale_snapshot',
              errorMessage: 'stale snapshot',
            },
          },
        ] as any,
    })

    expect(result.status).toBe('rejected')
    expect(state.promisesByPath['a.ts']).toBeUndefined()
    expect(state.promisesByPath['b.ts']).toBeUndefined()
    expect(state.failedEditRequiresReadByPath).toEqual({
      'a.ts': true,
      'b.ts': true,
    })
    expect(state.editRereadRequirementsByPath?.['a.ts']).toMatchObject({
      reason: 'stale_snapshot',
    })
    expect(state.editRereadRequirementsByPath?.['b.ts']).toMatchObject({
      reason: 'stale_snapshot',
    })
    expect(state.readAuthorizationsByPath?.['a.ts']).toBeUndefined()
    expect(state.readAuthorizationsByPath?.['b.ts']).toBeUndefined()
    expect(state.readAuthorizationHashesByPath?.['a.ts']).toBeUndefined()
    expect(state.readAuthorizationHashesByPath?.['b.ts']).toBeUndefined()
  })

  it('revokes only the named stale_state action in a file_mutation_result envelope', async () => {
    const state = getFileProcessingValues({
      promisesByPath: { 'a.ts': [], 'b.ts': [] },
      readAuthorizationsByPath: { 'a.ts': true, 'b.ts': true },
      readAuthorizationHashesByPath: {
        'a.ts': getContentHash('old a'),
        'b.ts': getContentHash('old b'),
      },
    })

    const result = await coordinateEditApplication({
      toolName: 'edit_transaction',
      fileProcessingState: state,
      ...applicationScope,
      paths: ['a.ts', 'b.ts'],
      rejectionRequiresRead: false,
      apply: async () =>
        [
          {
            type: 'json',
            value: {
              kind: 'file_mutation_result',
              version: 1,
              outcome: 'not_applied',
              errors: [
                {
                  code: 'stale_state',
                  message: 'file changed since last read',
                },
              ],
              actions: [
                {
                  path: 'a.ts',
                  outcome: 'not_applied',
                  error: {
                    code: 'stale_state',
                    message: 'file changed since last read',
                  },
                },
                {
                  path: 'b.ts',
                  outcome: 'not_applied',
                },
              ],
            },
          },
        ] as any,
    })

    expect(result.status).toBe('rejected')
    expect(state.promisesByPath['a.ts']).toBeUndefined()
    expect(state.promisesByPath['b.ts']).toBeUndefined()
    expect(state.failedEditRequiresReadByPath['a.ts']).toBe(true)
    expect(state.failedEditRequiresReadByPath['b.ts']).toBeUndefined()
    expect(state.editRereadRequirementsByPath?.['a.ts']).toMatchObject({
      reason: 'stale_snapshot',
    })
    expect(state.editRereadRequirementsByPath?.['b.ts']).toBeUndefined()
    expect(state.readAuthorizationsByPath?.['a.ts']).toBeUndefined()
    expect(state.readAuthorizationsByPath?.['b.ts']).toBe(true)
    expect(state.readAuthorizationHashesByPath?.['b.ts']).toBe(
      getContentHash('old b'),
    )
  })

  it('threads confirmationPaths through handleEditTransaction so no-op content edits are excluded from positive-evidence confirmation', async () => {
    // b.ts was a no-op and is excluded from confirmationPaths, so the
    // transaction is confirmed by a.ts's positive evidence alone.
    const clientOutput = canonicalAppliedOutput('a.ts', 'new content') as any
    const state = getFileProcessingValues({
      promisesByPath: { 'a.ts': [], 'b.ts': [] },
    })
    let committed = false
    const result = await coordinateEditApplication({
      toolName: 'edit_transaction',
      fileProcessingState: state,
      ...applicationScope,
      paths: ['a.ts', 'b.ts'],
      confirmationPaths: ['a.ts'],
      rejectionRequiresRead: false,
      apply: async () => clientOutput,
      onApplied: () => {
        committed = true
      },
    })

    expect(result.status).toBe('applied')
    expect(committed).toBe(true)
  })

  it('keeps a failed-edit reread marker on a blind allowMultiple apply while a unique apply may clear that marker and mint an anchor', async () => {
    // allowMultiple (replace-all) str_replace must NOT clear a failed-edit
    // reread marker (failedEditRequiresReadByPath), so a subsequent write_file
    // stays blocked. This case does not set context_compacted; that reason is
    // independently preserved even on unique apply (see the next test).
    const blindState = getFileProcessingValues({
      promisesByPath: { 'a.ts': [] },
      failedEditRequiresReadByPath: { 'a.ts': true },
    })
    const blindResult = await coordinateEditApplication({
      toolName: 'edit_transaction',
      fileProcessingState: blindState,
      ...applicationScope,
      paths: ['a.ts'],
      wholeFileContentByPath: new Map([['a.ts', 'replaced all']]),
      preserveRereadRequirementsForPaths: new Set(['a.ts']),
      apply: async () => canonicalAppliedOutput('a.ts', 'replaced all') as any,
    })

    expect(blindResult.status).toBe('applied')
    // The allowMultiple apply keeps the reread marker (write_file stays blocked).
    expect(blindState.failedEditRequiresReadByPath['a.ts']).toBe(true)
    // The minted anchor is still stored for the applied path.
    expect(
      blindState.confirmedPostEditAnchorsByPath?.['a.ts'],
    ).toMatchObject({
      contentHash: getContentHash('replaced all'),
      readCapability: expect.stringMatching(/^cap\.v3\./),
    })

    // A unique str_replace apply may clear a generic failed-edit marker and
    // mint an anchor. context_compacted is not set here and must not be
    // inferred from this case.
    const uniqueState = getFileProcessingValues({
      promisesByPath: { 'a.ts': [] },
      failedEditRequiresReadByPath: { 'a.ts': true },
    })
    const uniqueResult = await coordinateEditApplication({
      toolName: 'str_replace',
      fileProcessingState: uniqueState,
      ...applicationScope,
      paths: ['a.ts'],
      wholeFileContentByPath: new Map([['a.ts', 'replaced once']]),
      apply: async () => canonicalAppliedOutput('a.ts', 'replaced once') as any,
    })

    expect(uniqueResult.status).toBe('applied')
    expect(uniqueState.failedEditRequiresReadByPath['a.ts']).toBeUndefined()
    expect(
      uniqueState.confirmedPostEditAnchorsByPath?.['a.ts'],
    ).toMatchObject({
      contentHash: getContentHash('replaced once'),
      readCapability: expect.stringMatching(/^cap\.v3\./),
    })
  })

  it('commitAppliedEditPaths keeps context_compacted when preserveRereadRequirementsForPaths is omitted', async () => {
    // Unlike the allowMultiple case (failedEditRequiresReadByPath + preserve set),
    // context_compacted is authoritative on its own: a unique apply must keep it
    // even when the caller does not pass preserveRereadRequirementsForPaths.
    const path = 'a.ts'
    const content = 'replaced once'
    const state = getFileProcessingValues({
      promisesByPath: { [path]: [] },
      failedEditRequiresReadByPath: { [path]: true },
      editRereadRequirementsByPath: {
        [path]: {
          reason: 'context_compacted',
          sourceTool: 'context compaction',
        },
      },
    })

    const granted = commitAppliedEditPaths({
      fileProcessingState: state,
      paths: [path],
      wholeFileContentByPath: new Map([[path, content]]),
      projectId: applicationScope.projectId,
      runId: applicationScope.runId,
    })

    expect(state.editRereadRequirementsByPath?.[path]?.reason).toBe(
      'context_compacted',
    )
    expect(state.editRereadRequirementsByPath?.[path]?.sourceTool).toBe(
      'context compaction',
    )
    expect(state.failedEditRequiresReadByPath[path]).toBe(true)
    expect(granted.get(path)).toMatchObject({
      contentHash: getContentHash(content),
      readCapability: expect.stringMatching(/^cap\.v3\./),
    })

    const coordinated = await coordinateEditApplication({
      toolName: 'str_replace',
      fileProcessingState: state,
      ...applicationScope,
      paths: [path],
      wholeFileContentByPath: new Map([[path, content]]),
      apply: async () => canonicalAppliedOutput(path, content) as any,
    })

    expect(coordinated.status).toBe('applied')
    expect(state.editRereadRequirementsByPath?.[path]?.reason).toBe(
      'context_compacted',
    )
  })

  it('rejects when two same-content committed envelopes for the same path carry differing readCapability tokens', async () => {
    // Same afterContent/afterHash so both anchors pass the content-pinned
    // 7-point check. The second token is a quoted copy of the first: decode
    // strips the wrapper so both authenticate, then merge fails closed on
    // existing.readCapability !== candidate.readCapability.
    const state = getFileProcessingValues({ promisesByPath: { 'a.ts': [] } })
    let committed = false
    const envelopeA = canonicalAppliedOutput('a.ts', 'same content') as any
    const envelopeB = canonicalAppliedOutput('a.ts', 'same content') as any
    const token = envelopeB[0].value.actions[0].editAnchor.readCapability
    const quotedToken = `"${token}"`
    envelopeB[0].value.actions[0].editAnchor.readCapability = quotedToken
    envelopeB[0].value.authorityReceipt.actions[0].editAnchor.readCapability =
      quotedToken

    const result = await coordinateEditApplication({
      toolName: 'edit_transaction',
      fileProcessingState: state,
      ...applicationScope,
      paths: ['a.ts'],
      wholeFileContentByPath: new Map([['a.ts', 'same content']]),
      apply: async () => [...envelopeA, ...envelopeB] as any,
      onApplied: () => {
        committed = true
      },
    })

    expect(result.status).toBe('rejected')
    expect(committed).toBe(false)
  })

  it("rejects when a committed envelope's afterHash disagrees with the runtime-known content", async () => {
    // Tamper the envelope action's afterHash so it no longer equals
    // getExactContentHash('new content'). getConfirmedAppliedActionsV1 reads
    // the envelope actions (filtered to outcome 'applied') and the union
    // afterHash check compares each covering action's afterHash against
    // getExactContentHash of the runtime-known content — a forged value fails
    // closed to null. The receipt is NOT cross-checked for this field, so
    // tampering the action-level afterHash alone is sufficient.
    const state = getFileProcessingValues({ promisesByPath: { 'a.ts': [] } })
    let committed = false
    const output = canonicalAppliedOutput('a.ts', 'new content') as any
    output[0].value.actions[0].afterHash = 'sha256:forged'

    const result = await coordinateEditApplication({
      toolName: 'str_replace',
      fileProcessingState: state,
      ...applicationScope,
      paths: ['a.ts'],
      wholeFileContentByPath: new Map([['a.ts', 'new content']]),
      apply: async () => output,
      onApplied: () => {
        committed = true
      },
    })

    expect(result.status).toBe('rejected')
    expect(committed).toBe(false)
    // Fail-closed: no sticky grant is minted from a forged afterHash.
    expect(state.readAuthorizationsByPath?.['a.ts']).toBeUndefined()
  })

  it('does not grant sticky or store an anchor when the authoritative scope is empty', async () => {
    // projectId '' and runId '' are NOT authoritative. canonicalAppliedOutput
    // builds its editAnchor with the default scope { '/project', path, 'run' },
    // which does NOT match the empty runtime scope, so the client anchor is
    // rejected by the 7-point scope check. synthesizePostEditAnchor also
    // returns null for an empty scope (hasAuthoritativeReadCapabilityScope
    // fails), so NO whole-file cap can be minted. The apply still confirms
    // (the union afterHash check passes since content matches), but sticky
    // maps, stored anchors, and postEditCapabilities stay empty.
    const state = getFileProcessingValues({ promisesByPath: { 'a.ts': [] } })

    const result = await coordinateEditApplication({
      toolName: 'str_replace',
      fileProcessingState: state,
      projectId: '',
      runId: '',
      paths: ['a.ts'],
      wholeFileContentByPath: new Map([['a.ts', 'new content']]),
      apply: async () => canonicalAppliedOutput('a.ts', 'new content') as any,
    })

    expect(result.status).toBe('applied')
    expect(state.readAuthorizationsByPath?.['a.ts']).toBeUndefined()
    expect(state.readAuthorizationHashesByPath?.['a.ts']).toBeUndefined()
    expect(state.confirmedPostEditAnchorsByPath?.['a.ts']).toBeUndefined()
    const output = (result.status === 'applied' ? result.output : []) as any[]
    for (const part of output) {
      expect(part.value).not.toHaveProperty('postEditCapabilities')
    }
  })
})
