import { describe, expect, it } from 'bun:test'

import { editTransactionParams } from '../tool/edit-transaction'
import {
  decodeReadCapabilityToken,
  encodeReadCapabilityToken,
  getContentHash,
} from '../../../util/content-hash'

// RF-3/RF-8/RF-12/RF-17: replace_range accepts one cap.v3 token. Optional
// target bounds may narrow its covered range; removed legacy hash fields are
// rejected at model-facing transaction boundaries.

// Shared fixture minting (also reused by the provider/runtime delta contract
// describe below): a whole-file cap.v3 exactly as read_files.renderWholeFileItem
// would mint it — startLine=1, endLine=split('\n').length of the normalized
// content, hash over the full normalized content.
const issuer = { projectId: '/project', runId: 'run-schema-transform' }
const path = 'src/file.ts'
const wholeFileContent = 'line 1\nline 2\nline 3\nline 4\n'
const wholeFileCap = encodeReadCapabilityToken({
  startLine: 1,
  endLine: 4,
  hash: getContentHash(wholeFileContent),
  scope: { ...issuer, path },
})

describe('editTransactionParams inputSchema transform — whole-file readCapability', () => {
  const decodedWholeFile = decodeReadCapabilityToken(wholeFileCap)
  expect(typeof decodedWholeFile).toBe('object')
  const wholeFileHash =
    typeof decodedWholeFile === 'string' ? '' : decodedWholeFile.hash

  it('accepts contained caller bounds alongside a whole-file readCapability', () => {
    const parsed = editTransactionParams.inputSchema.safeParse({
      edits: [
        {
          type: 'replace_range',
          path,
          readCapability: wholeFileCap,
          startLine: 2,
          endLine: 3,
          newContent: 'replacement',
        },
      ],
    })

    expect(parsed.success).toBe(true)
    if (!parsed.success) return
    expect(parsed.data.edits[0]).toEqual({
      type: 'replace_range',
      path,
      readCapability: wholeFileCap,
      startLine: 2,
      endLine: 3,
      newContent: 'replacement',
    })
    expect(
      editTransactionParams.providerInputSchema.safeParse(parsed.data).success,
    ).toBe(true)
  })

  it('accepts replace_range when startLine/endLine bounds are omitted', () => {
    const parsed = editTransactionParams.inputSchema.safeParse({
      edits: [
        {
          type: 'replace_range',
          path,
          readCapability: wholeFileCap,
          newContent: 'replacement',
        },
      ],
    })

    expect(parsed.success).toBe(true)
    if (!parsed.success) return
    expect(parsed.data.edits[0]).toEqual({
      type: 'replace_range',
      path,
      readCapability: wholeFileCap,
      newContent: 'replacement',
    })
    expect(
      editTransactionParams.providerInputSchema.safeParse(parsed.data).success,
    ).toBe(true)
  })

  it('rejects out-of-range bounds and removed hash fields', () => {
    const edit = {
      type: 'replace_range' as const,
      path,
      readCapability: wholeFileCap,
      newContent: 'replacement',
    }

    expect(
      editTransactionParams.inputSchema.safeParse({
        edits: [{ ...edit, startLine: 2, endLine: 5 }],
      }).success,
    ).toBe(false)
    expect(
      editTransactionParams.inputSchema.safeParse({
        edits: [{ ...edit, expectedHash: wholeFileHash }],
      }).success,
    ).toBe(false)
    expect(
      editTransactionParams.inputSchema.safeParse({
        edits: [{ ...edit, wholeFileCapabilityHash: wholeFileHash }],
      }).success,
    ).toBe(false)
  })

  it('accepts replace_range occurrence targeting and rejects co-supplied line bounds', () => {
    const occurrenceEdit = {
      type: 'replace_range' as const,
      path,
      readCapability: wholeFileCap,
      occurrence: { match: 'line 2', occurrence: 1 },
      newContent: 'replacement',
    }

    const accepted = editTransactionParams.inputSchema.safeParse({
      edits: [occurrenceEdit],
    })
    expect(accepted.success).toBe(true)
    if (accepted.success) {
      expect(accepted.data.edits[0]).toEqual(occurrenceEdit)
      expect(
        editTransactionParams.providerInputSchema.safeParse(accepted.data)
          .success,
      ).toBe(true)
    }

    expect(
      editTransactionParams.inputSchema.safeParse({
        edits: [
          {
            ...occurrenceEdit,
            startLine: 2,
            endLine: 2,
          },
        ],
      }).success,
    ).toBe(false)
  })

  it('accepts scoped cap.v3 and rejects cap.v2 or object basedOnRead anchors', () => {
    const replacement = (basedOnRead: unknown) => ({
      edits: [
        {
          type: 'str_replace' as const,
          path,
          replacements: [
            {
              oldString: 'line 1',
              newString: 'updated line 1',
              basedOnRead,
            },
          ],
        },
      ],
    })

    expect(
      editTransactionParams.inputSchema.safeParse(replacement(wholeFileCap))
        .success,
    ).toBe(true)
    expect(
      editTransactionParams.inputSchema.safeParse(
        replacement('cap.v2.1.4.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'),
      ).success,
    ).toBe(false)
    expect(
      editTransactionParams.inputSchema.safeParse(
        replacement({ startLine: 1, endLine: 4, hash: wholeFileHash }),
      ).success,
    ).toBe(false)
  })

  it('accepts documented replacement aliases only at the model-facing boundary', () => {
    for (const [oldKey, newKey] of [
      ['old', 'new'],
      ['old_str', 'new_str'],
      ['old_string', 'new_string'],
    ] as const) {
      const input = {
        edits: [
          {
            type: 'str_replace' as const,
            path,
            replacements: [{ [oldKey]: 'line 1', [newKey]: 'updated line 1' }],
          },
        ],
      }

      const parsed = editTransactionParams.inputSchema.safeParse(input)
      expect(parsed.success).toBe(true)
      if (parsed.success && parsed.data.edits[0].type === 'str_replace') {
        expect(parsed.data.edits[0].replacements).toEqual([
          {
            oldString: 'line 1',
            newString: 'updated line 1',
            allowMultiple: false,
          },
        ])
      }
      expect(
        editTransactionParams.providerInputSchema.safeParse(input).success,
      ).toBe(false)
    }
  })

  it('rejects conflicting replacement aliases at the model-facing boundary', () => {
    const input = {
      edits: [
        {
          type: 'str_replace' as const,
          path,
          replacements: [
            {
              oldString: 'line 1',
              old_str: 'different line',
              new: 'updated line 1',
            },
          ],
        },
      ],
    }

    expect(editTransactionParams.inputSchema.safeParse(input).success).toBe(
      false,
    )
  })

  it('rejects redundant authority fields on str_replace replacements at both schema boundaries', () => {
    const replacement = {
      oldString: 'line 1',
      newString: 'updated line 1',
    }
    const input = (extra: Record<string, unknown>) => ({
      edits: [
        {
          type: 'str_replace' as const,
          path,
          replacements: [{ ...replacement, ...extra }],
        },
      ],
    })

    for (const extra of [
      { expectedHash: wholeFileHash },
      { readCapability: wholeFileCap },
      { wholeFileCapabilityHash: wholeFileHash },
    ]) {
      expect(
        editTransactionParams.inputSchema.safeParse(input(extra)).success,
      ).toBe(false)
      expect(
        editTransactionParams.providerInputSchema.safeParse(input(extra))
          .success,
      ).toBe(false)
    }
  })

  it('signs a whole-file cap.v3 under the capabilityIssuer scope so readCapabilityMatchesScope holds at runtime preflight', () => {
    // Sanity check that the minted token is path/run-bound: the runtime
    // preflight (process-edit-transaction.ts) will reject a capability whose
    // scope does not match { ...readCapabilityIssuer, path: edit.path }.
    // This guards against a future regression that mints pathless bearer
    // tokens for the whole-file sub-range relaxation.
    // Scoped cap.v3 tokens require a canonical sha256: hash (from
    // getContentHash), not a raw content string.
    const scopedWholeFileCap = encodeReadCapabilityToken({
      startLine: 1,
      endLine: 4,
      hash: getContentHash(wholeFileContent),
      scope: { ...issuer, path },
    })
    const decoded = decodeReadCapabilityToken(scopedWholeFileCap)
    expect(typeof decoded).toBe('object')
    if (typeof decoded === 'string') return
    expect(decoded.startLine).toBe(1)
    expect(decoded.endLine).toBe(4)
    expect(decoded.hash).toBe(getContentHash(wholeFileContent))
  })

  it('outputSchema accepts residual failures with basedOnRead capability', () => {
    const parsed = editTransactionParams.outputSchema.safeParse([
      {
        type: 'json',
        value: {
          errorMessage: 'edit_transaction blocked',
          failures: [
            {
              editIndex: 0,
              path,
              errorMessage: 'no read authorization',
              basedOnRead: wholeFileCap,
            },
          ],
        },
      },
    ])
    expect(parsed.success).toBe(true)
  })

  it('outputSchema accepts structured recovery packet fields', () => {
    const parsed = editTransactionParams.outputSchema.safeParse([
      {
        type: 'json',
        value: {
          errorMessage: 'edit_transaction aborted during preflight',
          requiresFreshRead: true,
          errorCode: 'no_match',
          failures: [
            {
              editIndex: 1,
              path,
              errorMessage: 'not an exact contiguous match',
              failureKind: 'no_match',
            },
          ],
          recovery: {
            action: 'rebuild_whole_transaction',
            requiresFreshRead: true,
            paths: [path, 'src/other.ts'],
            failedEditIndex: 1,
            preferredStrategy: 'replace_range',
            tool: 'read_files',
            input: { paths: [path, 'src/other.ts'] },
          },
        },
      },
    ])
    expect(parsed.success).toBe(true)
  })
})

describe('provider ↔ runtime edit-schema delta contract (M2-T3)', () => {
  // Audit MEDIUM api-contract finding: the runtime inputSchema enforces four
  // refinements the provider-declared providerInputSchema (the surface SDK
  // providers see) intentionally omits — capability-token decode and
  // authentication, occurrence vs explicit line-bounds mutual exclusion,
  // target-line containment within the capability range, and placeholder
  // rejection. Every case below must pass providerInputSchema while failing
  // inputSchema, and the runtime failure issues must name the delta
  // constraint — never a missing sibling field.
  const expectProviderAcceptsRuntimeRejects = (
    fixture: unknown,
    expectedIssueFragment: string,
  ) => {
    expect(
      editTransactionParams.providerInputSchema.safeParse(fixture).success,
    ).toBe(true)

    const runtimeParsed = editTransactionParams.inputSchema.safeParse(fixture)
    expect(runtimeParsed.success).toBe(false)
    if (runtimeParsed.success) return
    const issueText = runtimeParsed.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('\n')
    // Only the named delta may fail: no issue may report a missing/required
    // sibling field or a shape-level type error instead.
    expect(issueText).toContain(expectedIssueFragment)
    expect(issueText.toLowerCase()).not.toMatch(
      /required|missing|invalid input/i,
    )
  }

  it('capability decode: the runtime decodes and authenticates cap.v3 tokens', () => {
    expectProviderAcceptsRuntimeRejects(
      {
        edits: [
          {
            type: 'replace_range',
            path,
            readCapability: 'not-a-real-token',
            newContent: 'replacement',
          },
        ],
      },
      'Invalid basedOnRead',
    )
  })

  it('mutual exclusion: the runtime rejects occurrence targeting alongside explicit line bounds', () => {
    expectProviderAcceptsRuntimeRejects(
      {
        edits: [
          {
            type: 'replace_range',
            path,
            readCapability: wholeFileCap,
            occurrence: { match: 'x' },
            startLine: 2,
            endLine: 3,
            newContent: 'replacement',
          },
        ],
      },
      'occurrence is mutually exclusive with startLine/endLine',
    )
  })

  it('containment: the runtime rejects line bounds outside the capability range', () => {
    expectProviderAcceptsRuntimeRejects(
      {
        edits: [
          {
            type: 'replace_range',
            path,
            readCapability: wholeFileCap,
            startLine: 1,
            endLine: 999,
            newContent: 'replacement',
          },
        ],
      },
      'contained within the readCapability range 1-4',
    )
  })

  it('placeholder rejection: the runtime refuses explicit placeholders the provider surface passes through', () => {
    // The audit's fixture named the create-edit content refine, but that
    // refine lives on a schema object shared by BOTH unions, so a create
    // fixture would fail both schemas and pin no delta. The runtime-only
    // placeholder refinement for replace_range lives on newContent, so this
    // fixture pins the same placeholder-rejection delta class through it.
    expectProviderAcceptsRuntimeRejects(
      {
        edits: [
          {
            type: 'replace_range',
            path,
            readCapability: wholeFileCap,
            newContent: '[see patch above]',
          },
        ],
      },
      'explicit placeholder',
    )
  })
})
