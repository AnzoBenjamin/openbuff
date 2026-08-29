import { describe, expect, test } from 'bun:test'

import {
  collectAgentReceiptChangedFiles,
  collectToolInputFiles,
  hasEditArtifact,
  isFileChangingTool,
  visitToolValue,
} from '../base2/gate-files'

/**
 * Canonical `file_mutation_result` receipt — the exact production edit-artifact
 * shape the editor agent uses (shared as `editReceipt` in
 * agents/e2e/gate-aux-ordering.e2e.test.ts). It must satisfy
 * fileMutationResultV1Schema exactly so `hasEditArtifact` returns true:
 * operationId/receiptId/authorityTier at the top level, a full
 * `commitReceiptV1Schema` `authorityReceipt`, actions with index/outcome
 * 'applied', matching before/after hashes across the action and its authority
 * receipt, errors: [], and freshCapabilities: [].
 */
function editReceipt(path: string): Record<string, unknown> {
  const operationId = `op-${path}`
  const receiptId = `receipt-${path}`
  const actionId = `action-${path}`
  const hash = 'sha256:' + 'a'.repeat(64)
  return {
    kind: 'file_mutation_result',
    version: 1,
    operationId,
    receiptId,
    outcome: 'applied',
    authorityTier: 'conditional_commit',
    actions: [
      {
        actionId,
        index: 0,
        action: 'update',
        path,
        outcome: 'applied',
        beforeHash: hash,
        afterHash: hash,
      },
    ],
    authorityReceipt: {
      kind: 'commit_receipt',
      version: 1,
      receiptId,
      operationId,
      callId: `call-${path}`,
      authorityTier: 'conditional_commit',
      status: 'committed',
      actions: [
        {
          actionId,
          index: 0,
          action: 'update',
          path,
          status: 'committed',
          beforeHash: hash,
          afterHash: hash,
        },
      ],
      finalHashes: { [path]: hash },
    },
    errors: [],
    freshCapabilities: [],
  }
}

function collectToolInputs(input: unknown): string[] {
  const out = new Set<string>()
  collectToolInputFiles(input, out)
  return [...out].sort()
}

function collectReceipt(record: Record<string, unknown>): string[] {
  const out = new Set<string>()
  collectAgentReceiptChangedFiles(record, out)
  return [...out].sort()
}

function collectVisited(value: unknown): string[] {
  const out = new Set<string>()
  visitToolValue(value, out)
  return [...out].sort()
}

describe('isFileChangingTool', () => {
  test('returns true for file-changing tools, including removed legacy tools', () => {
    for (const toolName of [
      'apply_patch',
      'apply_smart_patch',
      'edit_transaction',
      'replace_range',
      'rewrite_symbol',
      'str_replace',
      'write_file',
    ]) {
      expect(isFileChangingTool(toolName)).toBe(true)
    }
  })

  test('returns false for non-mutating or malformed tool names', () => {
    for (const toolName of [
      'read_files',
      'run_terminal_command',
      'list_directory',
      '',
      'APPLY_PATCH',
      'str_replace_extra',
    ]) {
      expect(isFileChangingTool(toolName)).toBe(false)
    }
  })
})

describe('hasEditArtifact', () => {
  test('confirms a production-canonical file_mutation_result receipt', () => {
    expect(hasEditArtifact(editReceipt('src/a.ts'))).toBe(true)
  })

  test('rejects a bare commit_receipt (not a file_mutation_result)', () => {
    const afterHash = `sha256:${'b'.repeat(64)}`
    const receipt = {
      kind: 'commit_receipt',
      version: 1,
      operationId: 'op-b',
      receiptId: 'receipt-b',
      callId: 'call_b',
      authorityTier: 'conditional_commit',
      status: 'committed',
      actions: [
        {
          actionId: 'action-b:0',
          index: 0,
          action: 'write',
          path: 'src/b.ts',
          status: 'committed',
          beforeHash: 'before',
          afterHash,
        },
      ],
      finalHashes: { 'src/b.ts': afterHash },
    }
    // A commit_receipt is only valid as an `authorityReceipt` slot inside a
    // file_mutation_result; it is not itself a file_mutation_result.
    expect(hasEditArtifact(receipt)).toBe(false)
  })

  test('rejects a diff-only or legacy mutation-shaped record', () => {
    for (const record of [
      { unifiedDiff: 'diff --git a b' },
      { diff: '@@ -1 +1 @@' },
      { patch: '*** Begin Patch' },
      { file: 'src/a.ts', success: true },
      { path: 'src/a.ts', message: 'File written successfully' },
      { changedFiles: ['src/a.ts'] },
    ]) {
      expect(hasEditArtifact(record)).toBe(false)
    }
  })

  test('rejects success/message prose without a schema-valid receipt', () => {
    for (const record of [
      { success: true },
      { success: false },
      { error: 'strict read-before-edit blocked' },
      { errorMessage: 'something went wrong' },
      { message: 'File written successfully' },
      { message: 'edited 3 lines' },
      { success: true, message: 'failed on a sub-step' },
    ]) {
      expect(hasEditArtifact(record)).toBe(false)
    }
  })

  test('rejects a failed outcome even when the receipt is otherwise valid', () => {
    const receipt = editReceipt('src/failed.ts')
    receipt.outcome = 'failed'
    receipt.actions = [
      {
        ...(receipt.actions as Array<Record<string, unknown>>)[0],
        outcome: 'failed',
      },
    ]
    expect(hasEditArtifact(receipt)).toBe(false)
  })

  test('rejects an empty actions array', () => {
    const receipt = { ...editReceipt('src/empty.ts'), actions: [] }
    expect(hasEditArtifact(receipt)).toBe(false)
  })

  test('rejects a receipt missing its authority fields', () => {
    const receipt = editReceipt('src/missing-authority.ts')
    delete receipt.authorityReceipt
    expect(hasEditArtifact(receipt)).toBe(false)

    const noAuthorityTier = editReceipt('src/no-tier.ts')
    delete noAuthorityTier.authorityTier
    expect(hasEditArtifact(noAuthorityTier)).toBe(false)

    const noOperationId = editReceipt('src/no-op-id.ts')
    delete noOperationId.operationId
    expect(hasEditArtifact(noOperationId)).toBe(false)
  })
})

describe('collectToolInputFiles', () => {
  test('collects a top-level path', () => {
    expect(collectToolInputs({ path: 'src/a.ts' })).toEqual(['src/a.ts'])
  })

  test('collects a path inside an operation wrapper', () => {
    expect(collectToolInputs({ operation: { path: 'src/b.ts' } })).toEqual([
      'src/b.ts',
    ])
  })

  test('collects paths from an operation array (legacy apply_patch multi-operation payloads)', () => {
    expect(
      collectToolInputs({
        operation: [{ path: 'src/x.ts' }, { path: 'src/y.ts' }, null],
      }),
    ).toEqual(['src/x.ts', 'src/y.ts'])
  })

  test('collects paths from an edits array, skipping malformed items', () => {
    const result = collectToolInputs({
      edits: [
        { path: 'src/c.ts' },
        { path: 'src/d.ts' },
        { notPath: 'x' },
        null,
        'src/bare.ts',
      ],
    })
    expect(result).toEqual(['src/c.ts', 'src/d.ts'])
  })

  test('collects combined top-level, operation, and edits shapes', () => {
    const result = collectToolInputs({
      path: 'src/e.ts',
      operation: { path: 'src/f.ts' },
      edits: [{ path: 'src/g.ts' }],
    })
    expect(result).toEqual(['src/e.ts', 'src/f.ts', 'src/g.ts'])
  })

  test('ignores malformed and empty inputs', () => {
    for (const input of [
      null,
      undefined,
      'not-an-object',
      42,
      {},
      { path: 123 },
      { operation: 'no-path' },
      { edits: 'not-an-array' },
      { operation: { file: 'x' } },
    ]) {
      expect(collectToolInputs(input)).toEqual([])
    }
  })
})

describe('collectAgentReceiptChangedFiles', () => {
  test('collects string and {path} items from a schemaVersion=1 receipt', () => {
    const record = {
      schemaVersion: 1,
      receiptId: 'r1',
      changedFiles: ['src/a.ts', { path: 'src/b.ts' }],
    }
    expect(collectReceipt(record)).toEqual(['src/a.ts', 'src/b.ts'])
  })

  test('drops blank-string and non-path items', () => {
    const record = {
      schemaVersion: 1,
      receiptId: 'r2',
      changedFiles: ['  ', { path: 'src/b.ts' }, { file: 'nope' }, 42],
    }
    expect(collectReceipt(record)).toEqual(['src/b.ts'])
  })

  test('collects from a nested agentReceipt.changedFiles', () => {
    const record = {
      agentId: 'aux-1',
      agentReceipt: {
        schemaVersion: 1,
        receiptId: 'r3',
        changedFiles: [{ path: 'src/c.ts' }, 'src/d.ts'],
      },
    }
    expect(collectReceipt(record)).toEqual(['src/c.ts', 'src/d.ts'])
  })

  test('collects from a nested agentReceipt that omits schemaVersion', () => {
    const record = {
      agentReceipt: { changedFiles: ['src/e.ts', { path: 'src/f.ts' }] },
    }
    expect(collectReceipt(record)).toEqual(['src/e.ts', 'src/f.ts'])
  })

  test('collects nothing from records without changedFiles or receipts', () => {
    for (const record of [
      {},
      { schemaVersion: 1, receiptId: 'r', changedFiles: 'not-an-array' },
      { config: 'x' },
      { agentReceipt: { status: 'completed' } },
    ]) {
      expect(collectReceipt(record)).toEqual([])
    }
  })
})

describe('visitToolValue', () => {
  test('collects applied action paths from a canonical edit artifact', () => {
    const receipt = editReceipt('src/c.ts')
    expect(collectVisited(receipt)).toEqual(['src/c.ts'])
  })

  test('collects the move destinationPath from a canonical move action', () => {
    const receipt = editReceipt('src/old.ts')
    const action = (receipt.actions as Array<Record<string, unknown>>)[0]!
    const authorityReceipt = receipt.authorityReceipt as Record<string, unknown>
    const authorityAction = (
      authorityReceipt.actions as Array<Record<string, unknown>>
    )[0]!
    ;(receipt.actions as Array<Record<string, unknown>>)[0] = {
      ...action,
      action: 'move',
      destinationPath: 'src/new.ts',
    }
    ;(authorityReceipt.actions as Array<Record<string, unknown>>)[0] = {
      ...authorityAction,
      action: 'move',
      destinationPath: 'src/new.ts',
    }
    authorityReceipt.finalHashes = {
      'src/old.ts': action.afterHash as string,
      'src/new.ts': action.afterHash as string,
    }
    expect(collectVisited(receipt)).toEqual(['src/new.ts', 'src/old.ts'])
  })

  test('collects action paths nested inside a json envelope', () => {
    const value = {
      type: 'json',
      value: {
        nested: [editReceipt('src/d.ts')],
      },
    }
    expect(collectVisited(value)).toEqual(['src/d.ts'])
  })

  test('ignores failed edits that are not schema-valid artifacts', () => {
    const value = {
      file: 'src/failed.ts',
      success: false,
    }
    expect(collectVisited(value)).toEqual([])
  })

  test('does not extract bare tool-call input paths (collectToolInputFiles does)', () => {
    const value = {
      toolName: 'edit_transaction',
      input: { edits: [{ path: 'src/toolcall.ts' }] },
    }
    expect(collectVisited(value)).toEqual([])
  })

  test('does not extract input.path from a tool-call inside a json envelope', () => {
    const value = {
      type: 'json',
      value: {
        nested: [
          { toolName: 'write_file', input: { path: 'src/envelope.ts' } },
        ],
      },
    }
    expect(collectVisited(value)).toEqual([])
  })

  test('ignores non-file-changing and primitive values', () => {
    for (const value of [
      { toolName: 'read_files', input: { paths: ['src/nope.ts'] } },
      null,
      undefined,
      '',
      'bare-string',
      42,
      { config: 'x' },
    ]) {
      expect(collectVisited(value)).toEqual([])
    }
  })
})
