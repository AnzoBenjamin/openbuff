import { describe, expect, test } from 'bun:test'

import { toolParams } from '@codebuff/common/tools/list'
import {
  captureTextDocument,
  getRawReadBasis,
} from '@codebuff/common/util/byte-text'
import {
  encodeReadCapabilityToken,
  getExactContentHash,
} from '@codebuff/common/util/content-hash'
import {
  buildFileMutationResultFromReceiptV1,
  buildNativeToolResultErrorOutputV1,
  commitReceiptV1Schema,
  fileMutationResultV1Schema,
} from '@codebuff/common/tools/results/filesystem'
import type { CodebuffToolOutput } from '@codebuff/common/tools/list'

import { normalizeNativeToolOutput } from '../tools/tool-executor'

const scope = { projectId: '/project', runId: 'run-1' }
const content = '\uFEFFa😀e\u0301\r\nb\n'

function capability(path = 'a.txt', issuer = scope, source = content) {
  const document = captureTextDocument(source)
  return {
    path,
    contentHash: document.observationHash,
    readCapability: encodeReadCapabilityToken({
      startLine: 1,
      endLine: document.maxCapabilityLine,
      hash: document.observationHash,
      scope: { ...issuer, path },
      rawBasis: getRawReadBasis(
        document,
        1,
        document.maxCapabilityLine,
        'whole',
      ),
    }),
  }
}

function output() {
  const document = captureTextDocument(content)
  const granted = capability()
  const receipt = commitReceiptV1Schema.parse({
    kind: 'commit_receipt',
    version: 1,
    receiptId: 'receipt-1',
    operationId: 'operation-1',
    callId: 'call-1',
    authorityTier: 'conditional_commit',
    status: 'committed',
    workspaceRevision: 1,
    workspaceSnapshotId: 'snapshot-1',
    actions: [
      {
        actionId: 'action-1',
        index: 0,
        action: 'update',
        path: 'a.txt',
        status: 'committed',
        beforeHash: getExactContentHash('before'),
        afterHash: document.rawHash,
      },
    ],
    finalHashes: { 'a.txt': document.rawHash },
  })
  const mutation = buildFileMutationResultFromReceiptV1(
    receipt,
    [],
    [
      {
        kind: 'whole_file',
        version: 1,
        token: granted.readCapability,
        snapshot: {
          kind: 'file_snapshot',
          version: 1,
          canonicalPath: '/project/a.txt',
          contentHash: document.rawHash,
          sizeBytes: document.byteLength,
          encoding: 'utf8',
          readGeneration: 1,
        },
      },
    ],
    new Map([[0, content]]),
    new Map([
      [
        0,
        {
          startLine: 1,
          endLine: document.maxCapabilityLine,
          contentHash: document.observationHash,
          readCapability: granted.readCapability,
          rawBasis: getRawReadBasis(
            document,
            1,
            document.maxCapabilityLine,
            'whole',
          ),
        },
      ],
    ]),
  )
  const parts: CodebuffToolOutput<'replace_range'> = [
    { type: 'json', value: mutation },
    { type: 'json', value: { postEditCapabilities: [granted] } },
  ]
  return { parts, receipt, granted }
}

function normalize(
  parts: unknown,
  canonicalReceipt: unknown,
  confirmedPostEditAnchorsByPath?: Parameters<
    typeof normalizeNativeToolOutput
  >[0]['confirmedPostEditAnchorsByPath'],
) {
  return normalizeNativeToolOutput({
    toolName: 'replace_range',
    toolCallId: 'call-1',
    output: parts as CodebuffToolOutput<'replace_range'>,
    canonicalReceipt,
    capabilityScope: scope,
    confirmedPostEditAnchorsByPath,
  })
}

const document = captureTextDocument(content)
const wholeBasis = getRawReadBasis(
  document,
  1,
  document.maxCapabilityLine,
  'whole',
)

function signedClaim(
  startLine: number,
  endLine: number,
  rawBasis = wholeBasis,
  hash = document.observationHash,
) {
  return {
    path: 'a.txt',
    contentHash: hash,
    readCapability: encodeReadCapabilityToken({
      startLine,
      endLine,
      hash,
      rawBasis,
      scope: { ...scope, path: 'a.txt' },
    }),
  }
}

const contradictoryWholeClaims = [
  ['start after the first line', signedClaim(2, document.maxCapabilityLine)],
  ['end past the document', signedClaim(1, document.maxCapabilityLine + 1)],
  [
    'wrong ending terminator',
    signedClaim(1, document.maxCapabilityLine, {
      ...wholeBasis,
      endTerminator: 'crlf',
    }),
  ],
  [
    'wrong document byte count',
    signedClaim(1, document.maxCapabilityLine, {
      ...wholeBasis,
      documentBytes: wholeBasis.documentBytes + 1,
      endByteExclusive: wholeBasis.endByteExclusive + 1,
    }),
  ],
  [
    'wrong observation hash',
    signedClaim(
      1,
      document.maxCapabilityLine,
      wholeBasis,
      getExactContentHash('different observation'),
    ),
  ],
] as const

describe('confirmed capability output contract', () => {
  for (const name of [
    'replace_range',
    'str_replace',
    'write_file',
    'edit_transaction',
    'rewrite_symbol',
    'create_plan',
  ] as const) {
    test(`${name} accepts and retains exactly one confirmed capability part`, () => {
      const value = output()
      expect(toolParams[name].outputSchema.safeParse(value.parts).success).toBe(
        true,
      )
      const result = normalizeNativeToolOutput({
        toolName: name,
        toolCallId: 'call-1',
        output: value.parts as CodebuffToolOutput<typeof name>,
        canonicalReceipt: value.receipt,
        capabilityScope: scope,
      })
      expect(result.valid).toBe(true)
      expect(result.output).toHaveLength(2)
      expect(result.output[1]).toEqual(value.parts[1])
    })

    for (const [claimName, granted] of contradictoryWholeClaims) {
      test(`${name} rejects a signed whole claim with ${claimName}`, () => {
        const value = output()
        const parts = [
          value.parts[0],
          { type: 'json', value: { postEditCapabilities: [granted] } },
        ]
        expect(toolParams[name].outputSchema.safeParse(parts).success).toBe(
          true,
        )
        const result = normalizeNativeToolOutput({
          toolName: name,
          toolCallId: 'call-1',
          output: parts as CodebuffToolOutput<typeof name>,
          canonicalReceipt: value.receipt,
          capabilityScope: scope,
        })
        expect(result.valid).toBe(false)
        expect(result.output).toHaveLength(1)
      })
    }
  }

  test('omitted after-content requires the separately confirmed coordinator anchor', () => {
    const value = output()
    const parts = [
      {
        type: 'json',
        value: buildFileMutationResultFromReceiptV1(value.receipt),
      },
      value.parts[1],
    ]
    expect(normalize(parts, value.receipt).valid).toBe(false)
    const anchor = {
      ...scope,
      startLine: 1,
      endLine: document.maxCapabilityLine,
      contentHash: document.observationHash,
      readCapability: value.granted.readCapability,
      rawBasis: wholeBasis,
    }
    const result = normalize(parts, value.receipt, { 'a.txt': anchor })
    expect(result.valid).toBe(true)
    expect(result.output[1]).toEqual(value.parts[1])
    expect(
      normalize(parts, value.receipt, {
        'a.txt': { ...anchor, runId: 'different-run' },
      }).valid,
    ).toBe(false)
    expect(
      normalize(parts, value.receipt, {
        'a.txt': {
          ...anchor,
          readCapability: contradictoryWholeClaims[0][1].readCapability,
        },
      }).valid,
    ).toBe(false)
  })

  for (const [name, part] of [
    ['empty capabilities', { postEditCapabilities: [] }],
    ['malformed entry', { postEditCapabilities: [{ path: 'a.txt' }] }],
    [
      'extra envelope field',
      { postEditCapabilities: [capability()], forged: true },
    ],
    [
      'duplicate path/token',
      { postEditCapabilities: [capability(), capability()] },
    ],
    [
      'over-limit capabilities',
      { postEditCapabilities: Array.from({ length: 129 }, () => capability()) },
    ],
    [
      'noncanonical hash',
      {
        postEditCapabilities: [
          { ...capability(), contentHash: 'sha256:short' },
        ],
      },
    ],
    [
      'unsigned token',
      {
        postEditCapabilities: [
          { ...capability(), readCapability: 'cap.v4.unsigned' },
        ],
      },
    ],
  ] as const) {
    test(`rejects ${name} before output publication`, () => {
      const value = output()
      const parts = [value.parts[0], { type: 'json', value: part }]
      expect(
        toolParams.replace_range.outputSchema.safeParse(parts).success,
      ).toBe(false)
      expect(normalize(parts, value.receipt).valid).toBe(false)
    })
  }

  for (const [name, granted] of [
    ['wrong path binding', { ...capability(), path: 'other.txt' }],
    [
      'wrong run binding',
      capability('a.txt', { ...scope, runId: 'other-run' }),
    ],
    [
      'wrong project binding',
      capability('a.txt', { ...scope, projectId: '/other' }),
    ],
    [
      'raw-only after-state mismatch',
      capability('a.txt', scope, content.replaceAll('\r\n', '\n')),
    ],
  ] as const) {
    test(`rejects structurally valid ${name} against independent receipt and issuer`, () => {
      const value = output()
      const parts = [
        value.parts[0],
        { type: 'json', value: { postEditCapabilities: [granted] } },
      ]
      expect(
        toolParams.replace_range.outputSchema.safeParse(parts).success,
      ).toBe(true)
      expect(normalize(parts, value.receipt).valid).toBe(false)
    })
  }

  test('refuses missing or mismatched independent receipts', () => {
    const value = output()
    for (const receipt of [
      undefined,
      { ...value.receipt, callId: 'other-call' },
      { ...value.receipt, operationId: 'other-operation' },
    ]) {
      expect(normalize(value.parts, receipt).valid).toBe(false)
    }
  })

  test('failed, unconfirmed and legacy results cannot carry additive authority', () => {
    const value = output()
    const failure = buildNativeToolResultErrorOutputV1({
      toolName: 'replace_range',
      callId: 'call-1',
      issueCount: 1,
    })[0]!
    const unconfirmed = {
      type: 'json',
      value: fileMutationResultV1Schema.parse({
        kind: 'file_mutation_result',
        version: 1,
        operationId: 'operation-1',
        outcome: 'unconfirmed',
        actions: [],
        authorityTier: null,
        errors: [],
        freshCapabilities: [],
      }),
    }
    const legacy = {
      type: 'json',
      value: { file: 'a.txt', message: 'updated' },
    }
    for (const primary of [failure, unconfirmed, legacy]) {
      expect(normalize([primary, value.parts[1]], value.receipt).valid).toBe(
        false,
      )
    }
  })

  test('rejects arbitrary third parts even beside genuine confirmed authority', () => {
    const value = output()
    const result = normalize(
      [...value.parts, { type: 'json', value: { arbitrary: true } }],
      value.receipt,
    )
    expect(result.valid).toBe(false)
    expect(result.output).toHaveLength(1)
  })
})
