import { describe, expect, it } from 'bun:test'
import {
  encodeReadCapabilityToken,
  getContentHash,
  getExactContentHash,
} from '@codebuff/common/util/content-hash'

import {
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

  it('does not grant reusable state from a malformed action-local anchor', async () => {
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

    expect(result.status).toBe('applied')
    expect(state.readAuthorizationsByPath?.['a.ts']).toBeUndefined()
    expect(state.confirmedPostEditAnchorsByPath?.['a.ts']).toBeUndefined()
  })

  it('retains no reusable authority from same-content anchors for another path or run', async () => {
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

      expect(result.status).toBe('applied')
      expect(committed).toBe(true)
      expect(state.readAuthorizationsByPath).toEqual({})
      expect(state.readAuthorizationHashesByPath).toEqual({})
      expect(state.confirmedPostEditAnchorsByPath).toEqual({})
    }
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
})
